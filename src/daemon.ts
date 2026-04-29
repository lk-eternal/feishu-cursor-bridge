import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createRequire } from "node:module";
import {
  startDaemonScheduledTasks,
  stopDaemonScheduledTasks,
  setDaemonSchedulerLogger,
} from "./daemon-scheduled-tasks.js";
import { stripProxyEnv, localTimestamp, createLarkClient, LarkSender, LarkMessageEvent } from "./shared/lark-core.js";
import {
  initFileQueue,
  getQueueDir,
  pushToFileQueue,
  claimNextMessage,
  claimNextMessageText,
  pollFileQueueBatch,
  getQueueLength as getFileQueueLength,
  getQueueMessages as getFileQueueMessages,
  getDistinctChatIds,
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
let botOpenId: string | undefined;

// ── SSE 客户端管理 ───────────────────────────────────────

const sseClients = new Set<http.ServerResponse>();

function broadcastQueueEvent(chatId?: string): void {
  const data = JSON.stringify({ type: "queue-update", chatId: chatId ?? null, ts: Date.now() });
  for (const res of sseClients) {
    try { res.write(`data: ${data}\n\n`); } catch { sseClients.delete(res); }
  }
}

// ── 文件队列 ─────────────────────────────────────────────

function initQueue(): void {
  const dir = initFileQueue();
  log("INFO", `共享文件队列: ${dir}`);
  cleanupStaleMessages();
}

function pushMessage(content: string, messageId?: string, chatId?: string, chatType?: string, senderOpenId?: string): void {
  if (!content?.trim()) {
    log("WARN", `丢弃空消息 (messageId=${messageId})`);
    return;
  }
  const written = pushToFileQueue(content, messageId, `daemon-${process.pid}`, chatId, chatType, senderOpenId);
  if (written) {
    log("INFO", `消息已写入共享队列: ${JSON.stringify(content)} (id=${messageId ?? "none"}, chat=${chatId ?? "none"})`);
    broadcastQueueEvent(chatId);
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

// ── 主用户绑定 ─────────────────────────────────────────────

let bindWaiting = false;

function startBind(): void {
  bindWaiting = true;
  log("INFO", "进入主用户绑定等待状态");
}

function tryCaptureBind(chatType: string, chatId: string, senderOpenId?: string): boolean {
  if (!bindWaiting || chatType !== "p2p") return false;
  bindWaiting = false;
  const payload = JSON.stringify({ openId: senderOpenId ?? "", chatId });
  process.stdout.write(`__BIND_RESULT__:${payload}\n`);
  log("INFO", `主用户绑定完成: openId=${senderOpenId}, chatId=${chatId}`);
  return true;
}

// ── 飞书 WebSocket 长连接 ────────────────────────────────

function isBotMentioned(ev: LarkMessageEvent): boolean {
  if (!botOpenId) return ev.mentions.length > 0;
  return ev.mentions.some((m) => m.id === botOpenId || m.key === "@_all");
}

function stripMentionTags(text: string): string {
  return text.replace(/@_user_\d+/g, "").replace(/\s{2,}/g, " ").trim();
}

function startLarkConnection(): void {
  if (!APP_ID || !APP_SECRET) { log("ERROR", "LARK_APP_ID / LARK_APP_SECRET 未配置"); return; }

  sender.startConnection(APP_ID, APP_SECRET, ENCRYPT_KEY, (ev) => {
    const { text, messageId, chatId, chatType, messageType, rawContent, senderOpenId, mentions } = ev;

    if (chatType === "p2p" && senderOpenId && !sender.resolvedTarget) {
      sender.autoOpenId = senderOpenId;
      log("INFO", `自动识别用户 open_id: ${senderOpenId}`);
    }

    if (chatType === "group" && !isBotMentioned(ev)) {
      return;
    }

    if (tryCaptureBind(chatType, chatId, senderOpenId)) return;

    const cleanText = chatType === "group" ? stripMentionTags(text) : text;
    log("INFO", `收到消息 [${chatType}] chat=${chatId} sender=${senderOpenId ?? "?"}: ${cleanText.slice(0, 100)}`);

    if (messageType === "text" && isCommand(cleanText)) {
      handleCommand(cleanText, messageId, chatId, chatType).catch((e: any) =>
        log("ERROR", `指令处理失败: ${e?.message ?? e}`),
      );
      return;
    }

    if (messageType === "image" || messageType === "post") {
      sender.processIncomingMessage(messageId, messageType, rawContent)
        .then((result) => pushMessage(result, messageId, chatId, chatType, senderOpenId))
        .catch(() => pushMessage(cleanText, messageId, chatId, chatType, senderOpenId));
    } else {
      pushMessage(cleanText, messageId, chatId, chatType, senderOpenId);
    }
  });
}

// ── 指令系统 ─────────────────────────────────────────────

const COMMANDS: Record<string, string> = {
  "/stop": "停止当前运行中的 Agent",
  "/status": "查看 Agent / Daemon 状态",
  "/list": "查看消息队列列表（不消费）",
  "/task": "定时任务（/task 查看子命令说明；如 /task ls）",
  "/run": "启动临时独立 Agent（/run <任务描述>）",
  "/model": "Cursor CLI 模型（/model ls | info | set <序号>）",
  "/mcp": "MCP 服务器管理（/mcp ls | info | enable | disable | delete | add）",
  "/workspace": "切换工作目录（/workspace 查看当前 | /workspace set <路径>）",
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

function pushCommandToQueue(command: string, messageId: string, source: string, chatId?: string, chatType?: string): boolean {
  const queueDir = getQueueDir();
  if (!queueDir) return false;
  const ts = Date.now();
  const safeId = messageId.replace(/[^a-zA-Z0-9_-]/g, "_");

  try {
    const existing = fs.readdirSync(queueDir);
    if (existing.some((f) => f.includes(`_${safeId}.fcmd`))) return false;
  } catch { /* ignore */ }

  try {
    const data = JSON.stringify({ command, messageId, timestamp: ts, source, chatId, chatType });
    const filename = `${ts}_${safeId}.fcmd`;
    const tmpPath = path.join(queueDir, filename + ".tmp");
    const finalPath = path.join(queueDir, filename);
    fs.writeFileSync(tmpPath, data, "utf-8");
    fs.renameSync(tmpPath, finalPath);
    log("INFO", `指令已入队: ${command} (msgId=${messageId}, source=${source})`);
    return true;
  } catch { return false; }
}

interface CmdEntry { id: string; command: string; messageId: string; chatId?: string; chatType?: string }

function getPendingCommands(): CmdEntry[] {
  const queueDir = getQueueDir();
  if (!queueDir) return [];
  try {
    const files = fs.readdirSync(queueDir).filter((f) => f.endsWith(".fcmd")).sort();
    return files.map((f) => {
      try {
        const raw = fs.readFileSync(path.join(queueDir, f), "utf-8");
        const p = JSON.parse(raw);
        return { id: f, command: p.command, messageId: p.messageId, chatId: p.chatId, chatType: p.chatType };
      } catch { return null; }
    }).filter(Boolean) as CmdEntry[];
  } catch { return []; }
}

function claimCommand(fileId: string): Omit<CmdEntry, "id"> | null {
  const queueDir = getQueueDir();
  if (!queueDir) return null;
  const srcPath = path.join(queueDir, fileId);
  const claimedPath = srcPath + ".claimed";
  try {
    fs.renameSync(srcPath, claimedPath);
    const raw = fs.readFileSync(claimedPath, "utf-8");
    fs.unlinkSync(claimedPath);
    const p = JSON.parse(raw);
    return { command: p.command, messageId: p.messageId, chatId: p.chatId, chatType: p.chatType };
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

async function handleCommand(text: string, messageId: string, chatId?: string, chatType?: string): Promise<void> {
  const trimmed = text.trim();
  pushCommandToQueue(trimmed, messageId, `daemon-${process.pid}`, chatId, chatType);
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
        if (await handleAdminApi(pathname, method!, req, res)) return;

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

        if (method === "POST" && pathname === "/start-bind") {
          startBind();
          json(res, { ok: true });
          return;
        }

        if (method === "POST" && pathname === "/test-bind") {
          const body = JSON.parse(await readBody(req));
          const chatId = typeof body.chatId === "string" ? body.chatId : "";
          if (!chatId) { json(res, { error: "chatId is required" }, 400); return; }
          try {
            await sender.sendMessageToChat(chatId, "🔗 绑定测试成功！连接正常。");
            json(res, { ok: true });
          } catch (e: any) {
            json(res, { ok: false, error: e?.message ?? "发送失败" }, 500);
          }
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
          const chatIdFilter = reqUrl.searchParams.get("chatId") || undefined;
          json(res, { message: claimNextMessageText(chatIdFilter), queueLength: getFileQueueLength() });
          return;
        }

        if (method === "POST" && pathname === "/dequeue-all") {
          const body = await readBody(req).catch(() => "{}");
          const { chatId: filterChat } = JSON.parse(body || "{}") as { chatId?: string };
          const messages: { text: string; messageId: string; chatId: string; chatType: string; senderOpenId: string }[] = [];
          let m: ReturnType<typeof claimNextMessage>;
          while ((m = claimNextMessage(filterChat)) !== null) messages.push(m);
          json(res, { ok: true, messages, queueLength: getFileQueueLength() });
          return;
        }

        if (method === "GET" && pathname === "/queue-chat-ids") {
          json(res, { chats: getDistinctChatIds() });
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
          const chatIdFilter = reqUrl.searchParams.get("chatId") || undefined;
          let disconnected = false;
          req.on("close", () => { disconnected = true; });
          const msg = await pollFileQueueBatch(timeout, undefined, chatIdFilter);
          if (disconnected && msg !== null) {
            pushToFileQueue(msg.text, msg.messageId, `requeue-poll`, msg.chatId, msg.chatType, msg.senderOpenId);
            log("WARN", `/poll 连接断开，消息放回队列`);
            return;
          }
          json(res, { message: msg?.text ?? null, hasMore: getFileQueueLength() > 0 });
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

// ── 管理 API 辅助函数 ────────────────────────────────────

const HOME_DIR = os.homedir();
const APP_DATA_DIR = process.env.LARK_APP_DATA_DIR || "";
const GLOBAL_MCP_PATH = path.join(HOME_DIR, ".cursor", "mcp.json");
const PROJECT_MCP_PATH = path.join(WORKSPACE_DIR, ".cursor", "mcp.json");
const RULES_DIR = path.join(WORKSPACE_DIR, ".cursor", "rules");
const SKILLS_DIR = path.join(HOME_DIR, ".cursor", "skills");
const TASKS_FILE = path.join(APP_DATA_DIR, "scheduled-tasks.json");

function readJsonSafe(filePath: string): any {
  try {
    if (fs.existsSync(filePath)) return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch { /* ignore */ }
  return null;
}

function writeJsonSafe(filePath: string, data: unknown): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
}

interface TaskEntry { id: string; name: string; cron: string; content: string; enabled: boolean; independent?: boolean }

function readTasks(): TaskEntry[] {
  const data = readJsonSafe(TASKS_FILE);
  return Array.isArray(data) ? data : [];
}

function writeTasks(tasks: TaskEntry[]): void {
  writeJsonSafe(TASKS_FILE, tasks);
}

// ── 管理 API 路由处理 ────────────────────────────────────

async function handleAdminApi(pathname: string, method: string, req: http.IncomingMessage, res: http.ServerResponse): Promise<boolean> {
  if (!pathname.startsWith("/api/")) return false;

  if (method === "GET" && pathname === "/api/status") {
    const tasks = readTasks();
    json(res, {
      daemon: { running: true, version: PKG_VERSION, uptime: Math.floor(process.uptime()), port: daemonPort },
      queue: { length: getFileQueueLength() },
      tasks: { total: tasks.length, enabled: tasks.filter((t) => t.enabled).length },
      feishu: { connected: true, hasTarget: !!sender.getTarget() },
    });
    return true;
  }

  // ── MCP 管理 ──
  if (pathname === "/api/mcp") {
    if (method === "GET") {
      const globalCfg = readJsonSafe(GLOBAL_MCP_PATH);
      const projectCfg = readJsonSafe(PROJECT_MCP_PATH);
      const servers: Record<string, { config: unknown; scope: string }> = {};
      if (globalCfg?.mcpServers) {
        for (const [k, v] of Object.entries(globalCfg.mcpServers)) servers[k] = { config: v, scope: "global" };
      }
      if (projectCfg?.mcpServers) {
        for (const [k, v] of Object.entries(projectCfg.mcpServers)) servers[k] = { config: v, scope: "project" };
      }
      json(res, { ok: true, servers });
      return true;
    }
    if (method === "POST") {
      const body = JSON.parse(await readBody(req));
      const { action, name, config, scope } = body as { action: string; name?: string; config?: string; scope?: string };
      const targetPath = (scope ?? "global") === "project" ? PROJECT_MCP_PATH : GLOBAL_MCP_PATH;

      if (action === "add") {
        if (!name || !config) { json(res, { ok: false, error: "name and config required" }, 400); return true; }
        let parsed: unknown;
        try { parsed = JSON.parse(config); } catch { json(res, { ok: false, error: "invalid config JSON" }, 400); return true; }
        const mcpJson = readJsonSafe(targetPath) ?? {};
        if (!mcpJson.mcpServers) mcpJson.mcpServers = {};
        mcpJson.mcpServers[name] = parsed;
        writeJsonSafe(targetPath, mcpJson);
        json(res, { ok: true, message: `${name} saved` });
        return true;
      }
      if (action === "delete") {
        if (!name) { json(res, { ok: false, error: "name required" }, 400); return true; }
        for (const p of [GLOBAL_MCP_PATH, PROJECT_MCP_PATH]) {
          const mcpJson = readJsonSafe(p);
          if (mcpJson?.mcpServers?.[name]) {
            delete mcpJson.mcpServers[name];
            writeJsonSafe(p, mcpJson);
            json(res, { ok: true, message: `${name} deleted` });
            return true;
          }
        }
        json(res, { ok: false, error: "not found" }, 404);
        return true;
      }
      json(res, { ok: false, error: "unknown action" }, 400);
      return true;
    }
  }

  // ── Rules 管理 ──
  if (pathname === "/api/rules") {
    if (method === "GET") {
      if (!fs.existsSync(RULES_DIR)) { json(res, { ok: true, rules: [] }); return true; }
      const files = fs.readdirSync(RULES_DIR).filter((f) => f.endsWith(".mdc") || f.endsWith(".md"));
      json(res, { ok: true, rules: files });
      return true;
    }
    if (method === "POST") {
      const body = JSON.parse(await readBody(req));
      const { action, name, content } = body as { action: string; name?: string; content?: string };

      if (action === "read") {
        if (!name) { json(res, { ok: false, error: "name required" }, 400); return true; }
        const fp = path.join(RULES_DIR, name);
        if (!fs.existsSync(fp)) { json(res, { ok: false, error: "not found" }, 404); return true; }
        json(res, { ok: true, content: fs.readFileSync(fp, "utf-8") });
        return true;
      }
      if (action === "save") {
        if (!name || content === undefined) { json(res, { ok: false, error: "name and content required" }, 400); return true; }
        let fileName = name.trim();
        if (!fileName.endsWith(".mdc") && !fileName.endsWith(".md")) fileName += ".mdc";
        if (!fs.existsSync(RULES_DIR)) fs.mkdirSync(RULES_DIR, { recursive: true });
        fs.writeFileSync(path.join(RULES_DIR, fileName), content, "utf-8");
        json(res, { ok: true, message: `${fileName} saved` });
        return true;
      }
      if (action === "delete") {
        if (!name) { json(res, { ok: false, error: "name required" }, 400); return true; }
        const fp = path.join(RULES_DIR, name);
        if (!fs.existsSync(fp)) { json(res, { ok: false, error: "not found" }, 404); return true; }
        fs.unlinkSync(fp);
        json(res, { ok: true, message: `${name} deleted` });
        return true;
      }
      json(res, { ok: false, error: "unknown action" }, 400);
      return true;
    }
  }

  // ── Skills 管理 ──
  if (pathname === "/api/skills") {
    if (method === "GET") {
      if (!fs.existsSync(SKILLS_DIR)) { json(res, { ok: true, skills: [] }); return true; }
      const dirs = fs.readdirSync(SKILLS_DIR, { withFileTypes: true }).filter((d) => d.isDirectory());
      const skills = dirs.map((d) => {
        const skillFile = path.join(SKILLS_DIR, d.name, "SKILL.md");
        const preview = fs.existsSync(skillFile) ? fs.readFileSync(skillFile, "utf-8").split("\n")[0].slice(0, 80) : "";
        return { name: d.name, preview };
      });
      json(res, { ok: true, skills });
      return true;
    }
    if (method === "POST") {
      const body = JSON.parse(await readBody(req));
      const { action, name, content } = body as { action: string; name?: string; content?: string };

      if (action === "read") {
        if (!name) { json(res, { ok: false, error: "name required" }, 400); return true; }
        const fp = path.join(SKILLS_DIR, name, "SKILL.md");
        if (!fs.existsSync(fp)) { json(res, { ok: false, error: "not found" }, 404); return true; }
        json(res, { ok: true, content: fs.readFileSync(fp, "utf-8") });
        return true;
      }
      if (action === "save") {
        if (!name || content === undefined) { json(res, { ok: false, error: "name and content required" }, 400); return true; }
        const dir = path.join(SKILLS_DIR, name.trim());
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, "SKILL.md"), content, "utf-8");
        json(res, { ok: true, message: `${name} saved` });
        return true;
      }
      if (action === "delete") {
        if (!name) { json(res, { ok: false, error: "name required" }, 400); return true; }
        const dir = path.join(SKILLS_DIR, name);
        if (!fs.existsSync(dir)) { json(res, { ok: false, error: "not found" }, 404); return true; }
        fs.rmSync(dir, { recursive: true, force: true });
        json(res, { ok: true, message: `${name} deleted` });
        return true;
      }
      json(res, { ok: false, error: "unknown action" }, 400);
      return true;
    }
  }

  // ── Tasks 管理 ──
  if (pathname === "/api/tasks") {
    if (method === "GET") {
      json(res, { ok: true, tasks: readTasks() });
      return true;
    }
    if (method === "POST") {
      const body = JSON.parse(await readBody(req));
      const { action, id, name, cron, content, enabled, independent } = body as {
        action: string; id?: string; name?: string; cron?: string; content?: string; enabled?: boolean; independent?: boolean
      };
      const tasks = readTasks();

      if (action === "add") {
        if (!name || !cron || !content) { json(res, { ok: false, error: "name, cron, content required" }, 400); return true; }
        const newTask: TaskEntry = { id: crypto.randomUUID(), name: name.trim(), cron: cron.trim(), content, enabled: enabled ?? true, independent: independent ?? true };
        tasks.push(newTask);
        writeTasks(tasks);
        json(res, { ok: true, task: newTask });
        return true;
      }
      if (!id) { json(res, { ok: false, error: "id required" }, 400); return true; }
      const idx = tasks.findIndex((t) => t.id === id);
      if (idx === -1) { json(res, { ok: false, error: "task not found" }, 404); return true; }

      if (action === "update") {
        if (name !== undefined) tasks[idx].name = name.trim();
        if (cron !== undefined) tasks[idx].cron = cron.trim();
        if (content !== undefined) tasks[idx].content = content;
        if (enabled !== undefined) tasks[idx].enabled = enabled;
        if (independent !== undefined) tasks[idx].independent = independent;
        writeTasks(tasks);
        json(res, { ok: true, task: tasks[idx] });
        return true;
      }
      if (action === "delete") {
        const removed = tasks.splice(idx, 1)[0];
        writeTasks(tasks);
        json(res, { ok: true, removed });
        return true;
      }
      if (action === "toggle") {
        tasks[idx].enabled = !tasks[idx].enabled;
        writeTasks(tasks);
        json(res, { ok: true, task: tasks[idx] });
        return true;
      }
      json(res, { ok: false, error: "unknown action" }, 400);
      return true;
    }
  }

  // ── MCP Server 代理 API ──
  if (method === "POST" && pathname === "/api/send-text") {
    const body = JSON.parse(await readBody(req));
    const { text, message_id, chat_id } = body as { text: string; message_id?: string; chat_id?: string };
    if (!text) { json(res, { ok: false, error: "text is required" }, 400); return true; }
    if (message_id) await sender.sendMessage(text, message_id);
    else if (chat_id) await sender.sendMessageToChat(chat_id, text);
    else await sender.sendMessage(text);
    json(res, { ok: true });
    return true;
  }

  if (method === "POST" && pathname === "/api/send-image") {
    const body = JSON.parse(await readBody(req));
    const { image_path, message_id, chat_id } = body as { image_path: string; message_id?: string; chat_id?: string };
    if (!image_path) { json(res, { ok: false, error: "image_path is required" }, 400); return true; }
    await sender.sendImage(image_path, message_id, chat_id);
    json(res, { ok: true });
    return true;
  }

  if (method === "POST" && pathname === "/api/send-file") {
    const body = JSON.parse(await readBody(req));
    const { file_path, message_id, chat_id } = body as { file_path: string; message_id?: string; chat_id?: string };
    if (!file_path) { json(res, { ok: false, error: "file_path is required" }, 400); return true; }
    await sender.sendFile(file_path, message_id, chat_id);
    json(res, { ok: true });
    return true;
  }

  if (method === "GET" && pathname === "/api/poll-message") {
    const qs = new URL(req.url ?? "", "http://localhost").searchParams;
    const timeout = Number(qs.get("timeout") ?? "30000");
    const chatIdFilter = qs.get("chatId") || undefined;
    let disconnected = false;
    req.on("close", () => { disconnected = true; });
    const msg = await pollFileQueueBatch(timeout, undefined, chatIdFilter);
    if (disconnected && msg !== null) {
      pushToFileQueue(msg.text, msg.messageId, `requeue-poll-message`, msg.chatId, msg.chatType, msg.senderOpenId);
      json(res, { message: null });
      return true;
    }
    json(res, { message: msg });
    return true;
  }

  // ── SSE 队列事件流 ──
  if (pathname === "/api/queue-events" && method === "GET") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": "*",
    });
    res.write(`data: ${JSON.stringify({ type: "connected", ts: Date.now() })}\n\n`);
    sseClients.add(res);
    req.on("close", () => { sseClients.delete(res); });
    return true;
  }

  // ── Chat 名称查询 ──
  if (pathname === "/api/chat-names" && method === "POST") {
    const body = JSON.parse(await readBody(req));
    const chatIds = Array.isArray(body.chatIds) ? body.chatIds as string[] : [];
    const names: Record<string, string> = {};
    for (const cid of chatIds) {
      try {
        const r: any = await larkClient.im.chat.get({ path: { chat_id: cid } });
        const name = r?.data?.name || r?.data?.chat?.name;
        if (name) names[cid] = name;
      } catch { /* ignore */ }
    }
    json(res, { ok: true, names });
    return true;
  }

  // ── 用户名查询（通过 open_id 获取用户名）──
  if (pathname === "/api/user-names" && method === "POST") {
    const body = JSON.parse(await readBody(req));
    const openIds = Array.isArray(body.openIds) ? body.openIds as string[] : [];
    const names: Record<string, string> = {};
    for (const oid of openIds) {
      try {
        const r: any = await larkClient.contact.user.get({
          path: { user_id: oid },
          params: { user_id_type: "open_id" },
        });
        const name = r?.data?.user?.name;
        if (name) names[oid] = name;
      } catch { /* ignore */ }
    }
    json(res, { ok: true, names });
    return true;
  }

  // ── Workspace 管理 ──
  if (pathname === "/api/workspace") {
    if (method === "GET") {
      json(res, { ok: true, workspaceDir: WORKSPACE_DIR });
      return true;
    }
    if (method === "POST") {
      const body = JSON.parse(await readBody(req));
      const { dir } = body as { dir?: string };
      if (!dir?.trim()) { json(res, { ok: false, error: "dir is required" }, 400); return true; }
      const msgId = `api-ws-${Date.now()}`;
      pushCommandToQueue(`/workspace set ${dir.trim()}`, msgId, "mcp-api");
      json(res, { ok: true, message: "workspace change accepted, restarting...", dir: dir.trim() });
      return true;
    }
  }

  // ── Agent 控制 ──
  if (pathname === "/api/agent" && method === "POST") {
    const body = JSON.parse(await readBody(req));
    const { action } = body as { action: string };
    const supportedActions = ["stop", "restart", "reset", "clean"];

    if (action === "launch-temp") {
      const { message } = body as { message?: string };
      if (!message?.trim()) { json(res, { ok: false, error: "message is required" }, 400); return true; }
      const taskId = `temp-${Date.now()}`;
      const payload = JSON.stringify({ taskId, taskName: "临时会话", content: message.trim() });
      process.stdout.write(`__IND_LAUNCH__:${payload}\n`);
      json(res, { ok: true, taskId, message: "临时 Agent 已启动" });
      return true;
    }
    if (action === "clean") {
      const cleared = clearFileQueue();
      json(res, { ok: true, cleared });
      return true;
    }
    if (supportedActions.includes(action)) {
      const msgId = `api-${Date.now()}`;
      pushCommandToQueue(`/${action}`, msgId, `mcp-api`);
      json(res, { ok: true, message: `/${action} command queued` });
      return true;
    }
    json(res, { ok: false, error: `unknown action, supported: ${[...supportedActions, "launch-temp"].join(", ")}` }, 400);
    return true;
  }

  return false;
}

// ── Lock 文件 ────────────────────────────────────────────

function getLockFilePath(): string {
  return path.join(APP_DATA_DIR, "daemon.lock.json");
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

  initQueue();

  try {
    const botInfo = await larkClient.request({ method: "GET", url: "/open-apis/bot/v3/info" }) as any;
    botOpenId = botInfo?.bot?.open_id;
    if (botOpenId) log("INFO", `机器人 open_id: ${botOpenId}`);
    else log("WARN", "未能获取机器人 open_id，群消息过滤将使用宽松模式");
  } catch (e: any) {
    log("WARN", `获取机器人信息失败: ${e?.message ?? e}`);
  }

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
