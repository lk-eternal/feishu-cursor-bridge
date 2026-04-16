import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";
import {
  startDaemonScheduledTasks,
  stopDaemonScheduledTasks,
  setDaemonSchedulerLogger,
} from "./daemon-scheduled-tasks.js";
import { stripProxyEnv, localTimestamp, createLarkClient, LarkSender } from "./shared/lark-core.js";
import {
  initFileQueue as _initFileQueue,
  getQueueDir,
  pushToFileQueue,
  claimNextMessage,
  pollFileQueueBatch,
  getQueueLength as getFileQueueLength,
  getQueueMessages as getFileQueueMessages,
  cleanupStaleMessages,
} from "./file-queue.js";

const _require = createRequire(import.meta.url);
const PKG_VERSION: string = (_require("../package.json") as { version: string }).version;

// ── 环境变量 ──────────────────────────────────────────────

const APP_ID = process.env.LARK_APP_ID ?? "";
const APP_SECRET = process.env.LARK_APP_SECRET ?? "";
const ENCRYPT_KEY = process.env.LARK_ENCRYPT_KEY ?? "";
const RECEIVE_ID = process.env.LARK_RECEIVE_ID ?? "";
const RECEIVE_ID_TYPE = process.env.LARK_RECEIVE_ID_TYPE ?? "";
const CONFIGURED_PORT = process.env.LARK_DAEMON_PORT ? Number(process.env.LARK_DAEMON_PORT) : 0;
const WORKSPACE_DIR = process.env.LARK_WORKSPACE_DIR ?? process.cwd();
const MESSAGE_PREFIX = process.env.LARK_MESSAGE_PREFIX ?? "";

const savedProxyKeys = stripProxyEnv();

// ── 日志 ─────────────────────────────────────────────────

const LOG_FILE_PATH = path.join(WORKSPACE_DIR, ".cursor", "lark-daemon.log");
const MAX_LOG_SIZE = 2 * 1024 * 1024;
const LOG_ROTATE_CHECK_INTERVAL = 100;
let logWriteCount = 0;
let logDirEnsured = false;

function escapeLogContentSingleLine(s: string): string {
  return s.replace(/\r?\n/g, "\\n");
}

function ensureLogDir(): void {
  if (logDirEnsured) return;
  const dir = path.dirname(LOG_FILE_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  logDirEnsured = true;
}

function rotateLogIfNeeded(): void {
  if (++logWriteCount % LOG_ROTATE_CHECK_INTERVAL !== 0) return;
  try {
    if (fs.existsSync(LOG_FILE_PATH) && fs.statSync(LOG_FILE_PATH).size > MAX_LOG_SIZE) {
      const backup = LOG_FILE_PATH + ".old";
      if (fs.existsSync(backup)) fs.unlinkSync(backup);
      fs.renameSync(LOG_FILE_PATH, backup);
    }
  } catch { /* ignore */ }
}

function log(level: string, ...args: unknown[]): void {
  const ts = localTimestamp();
  const msg = args.map(a => typeof a === "string" ? a : JSON.stringify(a)).join(" ");
  const line = `${ts} [LarkDaemon] ${level} ${escapeLogContentSingleLine(msg)}\n`;
  process.stderr.write(line);
  try {
    ensureLogDir();
    rotateLogIfNeeded();
    fs.appendFileSync(LOG_FILE_PATH, line);
  } catch { /* ignore */ }
}

// ── Lark ─────────────────────────────────────────────────

const larkClient = createLarkClient(APP_ID, APP_SECRET);
const sender = new LarkSender({ client: larkClient, receiveId: RECEIVE_ID, receiveIdType: RECEIVE_ID_TYPE, messagePrefix: MESSAGE_PREFIX, log });

// ── 文件队列 ─────────────────────────────────────────────

function initFileQueue(): void {
  const dir = _initFileQueue(APP_ID);
  log("INFO", `共享文件队列: ${dir}`);
  cleanupStaleMessages();
}

function pushMessage(content: string, messageId?: string): void {
  if (!content?.trim()) {
    log("WARN", `丢弃空消息 (messageId=${messageId})`);
    return;
  }
  const written = pushToFileQueue(content, messageId, `daemon-${process.pid}`);
  if (written) {
    log("INFO", `消息已写入共享队列: ${JSON.stringify(content)} (id=${messageId ?? "none"})`);
  } else {
    log("INFO", `消息已跳过（重复或写入失败）: id=${messageId ?? "none"}`);
  }
}

function clearFileQueue(): number {
  const queueDir = getQueueDir();
  if (!queueDir) return 0;
  try {
    const files = fs.readdirSync(queueDir).filter((f) => f.endsWith(".qmsg"));
    for (const f of files) {
      try { fs.unlinkSync(path.join(queueDir, f)); } catch { /* ignore */ }
    }
    log("INFO", `队列已清空: ${files.length} 条消息`);
    return files.length;
  } catch { return 0; }
}

// ── 飞书 WebSocket 长连接 ────────────────────────────────

function startLarkConnection(): void {
  if (!APP_ID || !APP_SECRET) { log("ERROR", "LARK_APP_ID / LARK_APP_SECRET 未配置"); return; }

  sender.startConnection(APP_ID, APP_SECRET, ENCRYPT_KEY, (text, messageId, messageType, rawContent, senderOpenId) => {
    if (senderOpenId && !sender.resolvedTarget) {
      sender.autoOpenId = senderOpenId;
    }

    if (messageType === "text" && isCommand(text)) {
      handleCommand(text, messageId).catch((e: any) =>
        log("ERROR", `指令处理失败: ${e?.message ?? e}`),
      );
      return;
    }

    if (messageType === "image" || messageType === "post") {
      sender.processIncomingMessage(messageId, messageType, rawContent)
        .then((result) => pushMessage(result, messageId))
        .catch(() => pushMessage(text, messageId));
    } else {
      pushMessage(text, messageId);
    }
  });
}

// ── 指令系统 ─────────────────────────────────────────────

const COMMANDS: Record<string, string> = {
  "/stop": "停止当前运行中的 Agent",
  "/status": "查看 Agent / Daemon 状态",
  "/list": "查看消息队列列表（不消费）",
  "/task": "定时任务（/task 查看子命令说明；如 /task ls）",
  "/model": "Cursor CLI 模型（/model ls | info | set <序号>）",
  "/mcp": "MCP 服务器管理（/mcp ls | info | enable | disable | delete | add）",
  "/clean": "清空消息队列",
  "/reset": "下次拉起 Agent 时不使用 --continue（新 CLI 会话），不删除本地文件",
  "/restart": "停止 Agent + 清空队列 + 重启 Daemon",
  "/help": "显示可用指令列表",
};

function isCommand(text: string): boolean {
  const trimmed = text.trim().toLowerCase();
  return Object.keys(COMMANDS).some((cmd) => trimmed === cmd || trimmed.startsWith(cmd + " "));
}

async function replyToMessage(messageId: string, text: string): Promise<void> {
  try {
    await larkClient.im.message.reply({
      path: { message_id: messageId },
      data: { content: JSON.stringify({ text }), msg_type: "text" },
    });
  } catch (e: any) {
    log("WARN", `回复消息失败 (id=${messageId}), fallback 到发送: ${e?.message}`);
    await sender.sendMessage(text);
  }
}

// ── 共享指令文件队列（.fcmd）──────────────────────────────

function pushCommandToQueue(command: string, messageId: string, source: string): boolean {
  const queueDir = getQueueDir();
  if (!queueDir) return false;
  const ts = Date.now();
  const safeId = messageId.replace(/[^a-zA-Z0-9_-]/g, "_");

  try {
    const existing = fs.readdirSync(queueDir);
    if (existing.some((f) => f.includes(`_${safeId}.fcmd`))) return false;
  } catch { /* ignore */ }

  try {
    const data = JSON.stringify({ command, messageId, timestamp: ts, source });
    const filename = `${ts}_${safeId}.fcmd`;
    const tmpPath = path.join(queueDir, filename + ".tmp");
    const finalPath = path.join(queueDir, filename);
    fs.writeFileSync(tmpPath, data, "utf-8");
    fs.renameSync(tmpPath, finalPath);
    log("INFO", `指令已入队: ${command} (msgId=${messageId}, source=${source})`);
    return true;
  } catch { return false; }
}

function getPendingCommands(): { id: string; command: string; messageId: string }[] {
  const queueDir = getQueueDir();
  if (!queueDir) return [];
  try {
    const files = fs.readdirSync(queueDir).filter((f) => f.endsWith(".fcmd")).sort();
    return files.map((f) => {
      try {
        const raw = fs.readFileSync(path.join(queueDir, f), "utf-8");
        const parsed = JSON.parse(raw);
        return { id: f, command: parsed.command, messageId: parsed.messageId };
      } catch { return null; }
    }).filter(Boolean) as { id: string; command: string; messageId: string }[];
  } catch { return []; }
}

function claimCommand(fileId: string): { command: string; messageId: string } | null {
  const queueDir = getQueueDir();
  if (!queueDir) return null;
  const srcPath = path.join(queueDir, fileId);
  const claimedPath = srcPath + ".claimed";
  try {
    fs.renameSync(srcPath, claimedPath);
    const raw = fs.readFileSync(claimedPath, "utf-8");
    fs.unlinkSync(claimedPath);
    const parsed = JSON.parse(raw);
    return { command: parsed.command, messageId: parsed.messageId };
  } catch { return null; }
}

function cleanExpiredCommands(): void {
  const queueDir = getQueueDir();
  if (!queueDir) return;
  const now = Date.now();
  try {
    const files = fs.readdirSync(queueDir).filter((f) => f.endsWith(".fcmd"));
    for (const f of files) {
      try {
        const raw = fs.readFileSync(path.join(queueDir, f), "utf-8");
        const parsed = JSON.parse(raw);
        if (now - (parsed.timestamp ?? 0) > 60_000) {
          fs.unlinkSync(path.join(queueDir, f));
          log("WARN", `指令超时已清除: ${parsed.command} (msgId=${parsed.messageId})`);
          if (parsed.messageId) {
            replyToMessage(parsed.messageId, `⚠️ 指令 ${parsed.command} 执行超时`).catch(() => {});
          }
        }
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
}

function cleanCommandMessagesFromQueue(): void {
  const queueDir = getQueueDir();
  if (!queueDir) return;
  try {
    const files = fs.readdirSync(queueDir).filter((f) => f.endsWith(".qmsg"));
    for (const f of files) {
      try {
        const raw = fs.readFileSync(path.join(queueDir, f), "utf-8");
        const parsed = JSON.parse(raw);
        if (typeof parsed.text === "string" && isCommand(parsed.text)) {
          fs.unlinkSync(path.join(queueDir, f));
          log("INFO", `从消息队列中清除指令消息: ${JSON.stringify(parsed.text)}`);
        }
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
}

async function handleCommand(text: string, messageId: string): Promise<void> {
  const trimmed = text.trim();
  pushCommandToQueue(trimmed, messageId, `daemon-${process.pid}`);
  setTimeout(() => cleanCommandMessagesFromQueue(), 2000);
}

// ── HTTP Server ──────────────────────────────────────────

let daemonPort = 0;

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: string[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk.toString()));
    req.on("end", () => resolve(chunks.join("")));
    req.on("error", reject);
  });
}

function json(res: http.ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
  res.end(JSON.stringify(data));
}

function startHttpServer(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      const reqUrl = new URL(req.url ?? "", `http://${req.headers.host ?? "localhost"}`);
      const pathname = reqUrl.pathname;
      const method = req.method;

      try {
        if (method === "GET" && (pathname === "/health" || pathname === "/status")) {
          cleanExpiredCommands();
          json(res, {
            status: "ok",
            version: PKG_VERSION,
            uptime: Math.floor(process.uptime()),
            queueLength: getFileQueueLength(),
            hasTarget: !!sender.getTarget(),
            autoOpenId: sender.autoOpenId || null,
            feishuConnected: true,
          });
          return;
        }

        if (method === "GET" && pathname === "/queue") {
          json(res, { length: getFileQueueLength(), messages: getFileQueueMessages() });
          return;
        }

        if (method === "POST" && pathname === "/shutdown") {
          log("INFO", ">>> 收到 shutdown 请求，准备退出");
          json(res, { ok: true });
          setTimeout(() => {
            stopDaemonScheduledTasks();
            removeLockFile();
            process.exit(0);
          }, 200);
          return;
        }

        if (method === "POST" && pathname === "/send") {
          const body = JSON.parse(await readBody(req));
          await sender.sendMessage(body.text);
          json(res, { ok: true });
          return;
        }

        if (method === "POST" && pathname === "/send-image") {
          const body = JSON.parse(await readBody(req));
          await sender.sendImage(body.image_path);
          json(res, { ok: true });
          return;
        }

        if (method === "POST" && pathname === "/send-file") {
          const body = JSON.parse(await readBody(req));
          await sender.sendFile(body.file_path);
          json(res, { ok: true });
          return;
        }

        if (method === "POST" && pathname === "/enqueue") {
          const body = JSON.parse(await readBody(req));
          const content = typeof body.content === "string" ? body.content : "";
          if (!content) { json(res, { error: "content is required" }, 400); return; }
          pushMessage(content);
          json(res, { ok: true, queueLength: getFileQueueLength() });
          return;
        }

        if (method === "POST" && pathname === "/clear-queue") {
          json(res, { ok: true, cleared: clearFileQueue() });
          return;
        }

        if (method === "GET" && pathname === "/dequeue") {
          json(res, { message: claimNextMessage(), queueLength: getFileQueueLength() });
          return;
        }

        if (method === "POST" && pathname === "/dequeue-all") {
          const messages: string[] = [];
          let m: string | null;
          while ((m = claimNextMessage()) !== null) messages.push(m);
          json(res, { ok: true, messages, queueLength: getFileQueueLength() });
          return;
        }

        if (method === "GET" && pathname === "/commands") {
          json(res, { commands: getPendingCommands() });
          return;
        }

        if (method === "POST" && pathname === "/commands/claim") {
          const body = JSON.parse(await readBody(req));
          const result = claimCommand(body.id);
          json(res, result ? { ok: true, ...result } : { ok: false, error: "not found" });
          return;
        }

        if (method === "POST" && pathname === "/cmd/result") {
          const body = JSON.parse(await readBody(req)) as { messageId: string; ok: boolean; message: string };
          log("INFO", `指令执行完成: ok=${body.ok}, msgId=${body.messageId}`);
          if (body.messageId) await replyToMessage(body.messageId, body.message);
          json(res, { ok: true });
          return;
        }

        if (method === "GET" && pathname === "/poll") {
          const timeout = Number(reqUrl.searchParams.get("timeout") ?? "20000");
          let disconnected = false;
          req.on("close", () => { disconnected = true; });
          const reply = await pollFileQueueBatch(timeout);
          if (disconnected && reply !== null) {
            pushToFileQueue(reply);
            log("WARN", `/poll 连接断开，消息放回队列`);
            return;
          }
          json(res, { message: reply, hasMore: getFileQueueLength() > 0 });
          return;
        }

        json(res, { error: "not found" }, 404);
      } catch (e: any) {
        log("ERROR", `HTTP 错误: ${pathname} ${e?.message ?? e}`);
        json(res, { error: e?.message ?? "internal error" }, 500);
      }
    });

    server.requestTimeout = 300_000;
    server.on("error", (err) => { log("ERROR", `HTTP Server 错误: ${err.message}`); reject(err); });
    server.listen(CONFIGURED_PORT, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      log("INFO", `HTTP Server 监听: http://127.0.0.1:${addr.port}`);
      resolve(addr.port);
    });
  });
}

// ── Lock 文件 ────────────────────────────────────────────

function getLockFilePath(): string {
  return path.join(WORKSPACE_DIR, ".cursor", ".lark-daemon.json");
}

function writeLockFile(port: number): void {
  const lockPath = getLockFilePath();
  const lockDir = path.dirname(lockPath);
  if (!fs.existsSync(lockDir)) fs.mkdirSync(lockDir, { recursive: true });
  fs.writeFileSync(lockPath, JSON.stringify({
    pid: process.pid, port, version: PKG_VERSION,
    startedAt: localTimestamp(), workspaceDir: WORKSPACE_DIR,
  }));
}

function removeLockFile(): void {
  try {
    const lockPath = getLockFilePath();
    if (fs.existsSync(lockPath)) { fs.unlinkSync(lockPath); }
  } catch { /* ignore */ }
}

// ── 主函数 ───────────────────────────────────────────────

export async function daemonMain(): Promise<void> {
  if (!APP_ID || !APP_SECRET) {
    log("ERROR", "LARK_APP_ID / LARK_APP_SECRET 未配置");
    process.exit(1);
  }

  log("INFO", `Daemon v${PKG_VERSION} 启动`);
  log("INFO", `workspace: ${WORKSPACE_DIR}`);
  log("INFO", `日志文件: ${LOG_FILE_PATH}`);

  const cleanup = () => {
    stopDaemonScheduledTasks();
    removeLockFile();
    process.exit(0);
  };
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
  process.on("exit", removeLockFile);

  initFileQueue();
  await sender.resolveTarget(RECEIVE_ID, RECEIVE_ID_TYPE);
  startLarkConnection();

  daemonPort = await startHttpServer();
  writeLockFile(daemonPort);

  setDaemonSchedulerLogger((msg) => { log("INFO", msg); });
  startDaemonScheduledTasks(
    (content) => { pushMessage(content); },
    (taskId, taskName, content) => {
      const payload = JSON.stringify({ taskId, taskName, content });
      process.stdout.write(`__IND_LAUNCH__:${payload}\n`);
    },
  );

  log("INFO", `Daemon 就绪 ✓ port=${daemonPort}`);
}
