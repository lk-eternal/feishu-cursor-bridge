import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as Lark from "@larksuiteoapi/node-sdk";
import { createRequire } from "node:module";
import {
  startDaemonScheduledTasks,
  stopDaemonScheduledTasks,
  setDaemonSchedulerLogger,
} from "./daemon-scheduled-tasks.js";

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

// 删除代理环境变量，防止飞书 WebSocket 长连接走代理导致投递失败
const PROXY_KEYS = [
  "HTTP_PROXY", "http_proxy",
  "HTTPS_PROXY", "https_proxy",
  "ALL_PROXY", "all_proxy",
  "NODE_USE_ENV_PROXY",
];
const savedProxyKeys: string[] = [];
for (const key of PROXY_KEYS) {
  if (process.env[key]) {
    savedProxyKeys.push(key);
    delete process.env[key];
  }
}

// ── 日志 ─────────────────────────────────────────────────

const LOG_FILE_PATH = path.join(WORKSPACE_DIR, ".cursor", "lark-daemon.log");
const MAX_LOG_SIZE = 2 * 1024 * 1024;

function localTimestamp(): string {
  const d = new Date();
  const pad2 = (n: number) => String(n).padStart(2, "0");
  const pad3 = (n: number) => String(n).padStart(3, "0");
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}.${pad3(d.getMilliseconds())}`;
}

function escapeLogContentSingleLine(s: string): string {
  return s.replace(/\r?\n/g, "\\n");
}

function ensureLogDir(): void {
  const dir = path.dirname(LOG_FILE_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function rotateLogIfNeeded(): void {
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

// ── Lark Client ──────────────────────────────────────────

const larkClient = new Lark.Client({
  appId: APP_ID,
  appSecret: APP_SECRET,
  appType: Lark.AppType.SelfBuild,
  domain: Lark.Domain.Feishu,
  loggerLevel: Lark.LoggerLevel.error,
});

// ── 发送目标解析 ─────────────────────────────────────────

interface SendTarget { receiveIdType: string; receiveId: string; }

let resolvedTarget: SendTarget | null = null;
let autoOpenId = "";

async function resolveEmailToOpenId(email: string): Promise<string | null> {
  try {
    const res = await larkClient.contact.user.batchGetId({
      params: { user_id_type: "open_id" }, data: { emails: [email] },
    });
    const users = res.data?.user_list;
    if (users && users.length > 0 && users[0].user_id) {
      log("INFO", `邮箱 ${email} → open_id: ${users[0].user_id}`);
      return users[0].user_id;
    }
    return null;
  } catch (e) { log("ERROR", "邮箱解析失败:", e); return null; }
}

async function resolveMobileToOpenId(mobile: string): Promise<string | null> {
  try {
    const res = await larkClient.contact.user.batchGetId({
      params: { user_id_type: "open_id" }, data: { mobiles: [mobile] },
    });
    const users = res.data?.user_list;
    if (users && users.length > 0 && users[0].user_id) {
      log("INFO", `手机号 ${mobile} → open_id: ${users[0].user_id}`);
      return users[0].user_id;
    }
    return null;
  } catch (e) { log("ERROR", "手机号解析失败:", e); return null; }
}

async function initSendTarget(): Promise<void> {
  if (!RECEIVE_ID) { log("INFO", "未配置 LARK_RECEIVE_ID，将从首条消息自动获取"); return; }
  const idType = RECEIVE_ID_TYPE || "auto";
  if (["open_id", "user_id", "union_id", "chat_id"].includes(idType)) {
    resolvedTarget = { receiveIdType: idType, receiveId: RECEIVE_ID };
    log("INFO", `发送目标: ${idType}=${RECEIVE_ID}`); return;
  }
  if (idType === "email" || (idType === "auto" && RECEIVE_ID.includes("@"))) {
    const openId = await resolveEmailToOpenId(RECEIVE_ID);
    if (openId) { resolvedTarget = { receiveIdType: "open_id", receiveId: openId }; return; }
    log("WARN", "邮箱解析失败，等待自动识别"); return;
  }
  if (idType === "mobile" || (idType === "auto" && /^\+?\d{7,}$/.test(RECEIVE_ID))) {
    const openId = await resolveMobileToOpenId(RECEIVE_ID);
    if (openId) { resolvedTarget = { receiveIdType: "open_id", receiveId: openId }; return; }
    log("WARN", "手机号解析失败，等待自动识别"); return;
  }
  resolvedTarget = { receiveIdType: "open_id", receiveId: RECEIVE_ID };
}

function getSendTarget(): SendTarget | null {
  if (resolvedTarget) return resolvedTarget;
  if (autoOpenId) return { receiveIdType: "open_id", receiveId: autoOpenId };
  return null;
}

// ── 消息发送 ─────────────────────────────────────────────

async function sendLarkMessage(text: string): Promise<void> {
  const target = getSendTarget();
  if (!target) { log("WARN", "无发送目标"); return; }
  try {
    const res = await larkClient.im.message.create({
      params: { receive_id_type: target.receiveIdType as any },
      data: { receive_id: target.receiveId, content: JSON.stringify({ text: `${MESSAGE_PREFIX}${text}` }), msg_type: "text" },
    });
    if (res.code === 0) log("INFO", `飞书消息已发送(${text.length}字)`);
    else log("ERROR", `飞书发送失败: code=${res.code}, msg=${res.msg}`);
  } catch (e: any) { log("ERROR", `飞书发送异常: ${e?.message ?? e}`); }
}

async function sendLarkImage(imagePath: string): Promise<void> {
  const target = getSendTarget();
  if (!target) { log("WARN", "无发送目标"); return; }
  const absPath = path.resolve(imagePath);
  if (!fs.existsSync(absPath)) { log("ERROR", `图片不存在: ${absPath}`); return; }
  try {
    const uploadRes: any = await larkClient.im.image.create({ data: { image_type: "message", image: fs.createReadStream(absPath) } });
    const imageKey = uploadRes?.data?.image_key ?? uploadRes?.image_key;
    if (!imageKey) { log("ERROR", `图片上传失败`); return; }
    const sendRes = await larkClient.im.message.create({
      params: { receive_id_type: target.receiveIdType as any },
      data: { receive_id: target.receiveId, content: JSON.stringify({ image_key: imageKey }), msg_type: "image" },
    });
    if (sendRes.code === 0) log("INFO", "图片已发送");
    else log("ERROR", `图片发送失败: code=${sendRes.code}`);
  } catch (e: any) { log("ERROR", `发送图片异常: ${e?.message ?? e}`); }
}

async function sendLarkFile(filePath: string): Promise<void> {
  const target = getSendTarget();
  if (!target) { log("WARN", "无发送目标"); return; }
  const absPath = path.resolve(filePath);
  if (!fs.existsSync(absPath)) { log("ERROR", `文件不存在: ${absPath}`); return; }
  try {
    const fileName = path.basename(absPath);
    const uploadRes: any = await larkClient.im.file.create({ data: { file_type: "stream", file_name: fileName, file: fs.createReadStream(absPath) } });
    const fileKey = uploadRes?.data?.file_key ?? uploadRes?.file_key;
    if (!fileKey) { log("ERROR", `文件上传失败`); return; }
    const sendRes = await larkClient.im.message.create({
      params: { receive_id_type: target.receiveIdType as any },
      data: { receive_id: target.receiveId, content: JSON.stringify({ file_key: fileKey, file_name: fileName }), msg_type: "file" },
    });
    if (sendRes.code === 0) log("INFO", `文件已发送: ${fileName}`);
    else log("ERROR", `文件发送失败: code=${sendRes.code}`);
  } catch (e: any) { log("ERROR", `发送文件异常: ${e?.message ?? e}`); }
}

// ── 图片下载 ─────────────────────────────────────────────

const IMAGE_DOWNLOAD_DIR = path.join(os.tmpdir(), "lark-bridge-images");

async function downloadLarkImage(messageId: string, imageKey: string): Promise<string | null> {
  try {
    if (!fs.existsSync(IMAGE_DOWNLOAD_DIR)) fs.mkdirSync(IMAGE_DOWNLOAD_DIR, { recursive: true });
    const resp = await larkClient.im.messageResource.get({
      path: { message_id: messageId, file_key: imageKey }, params: { type: "image" },
    });
    const data = resp as any;
    const filePath = path.join(IMAGE_DOWNLOAD_DIR, `${imageKey}.png`);
    if (data && typeof data.pipe === "function") {
      const ws = fs.createWriteStream(filePath);
      await new Promise<void>((resolve, reject) => { data.pipe(ws); ws.on("finish", resolve); ws.on("error", reject); });
      return filePath;
    }
    if (data?.writeFile) { await data.writeFile(filePath); return filePath; }
    return null;
  } catch (e: any) { log("ERROR", `下载图片异常: ${e?.message ?? e}`); return null; }
}

// ── 消息解析 ─────────────────────────────────────────────

interface ParsedMessage { text: string; imageKeys: { messageId: string; imageKey: string }[]; }

function parseMessageContent(messageId: string, messageType: string, content: string): ParsedMessage {
  const result: ParsedMessage = { text: "", imageKeys: [] };
  try {
    const parsed = JSON.parse(content);
    switch (messageType) {
      case "text": result.text = parsed.text ?? content; break;
      case "image":
        if (parsed.image_key) { result.imageKeys.push({ messageId, imageKey: parsed.image_key }); result.text = "[图片]"; }
        break;
      case "post": {
        const parts: string[] = [];
        if (parsed.title) parts.push(parsed.title);
        for (const line of (parsed.content ?? []) as any[][]) {
          for (const el of line) {
            if (el.tag === "text" && el.text) parts.push(el.text);
            else if (el.tag === "img" && el.image_key) { result.imageKeys.push({ messageId, imageKey: el.image_key }); parts.push("[图片]"); }
            else if (el.tag === "a" && el.text) parts.push(el.text);
          }
        }
        result.text = parts.join(""); break;
      }
      default: result.text = parsed.text ?? content;
    }
  } catch { result.text = content; }
  return result;
}

async function processIncomingMessage(messageId: string, messageType: string, content: string): Promise<string> {
  const parsed = parseMessageContent(messageId, messageType, content);
  const parts: string[] = [];
  if (parsed.text) parts.push(parsed.text);
  for (const img of parsed.imageKeys) {
    const localPath = await downloadLarkImage(img.messageId, img.imageKey);
    parts.push(localPath ? `[图片已保存: ${localPath}]` : `[图片下载失败: ${img.imageKey}]`);
  }
  return parts.join("\n");
}

// ── 共享文件队列 ─────────────────────────────────────────

const FILE_QUEUE_POLL_MS = 400;
let fileQueueDir = "";

function initFileQueue(): void {
  const suffix = APP_ID ? APP_ID.slice(-8) : "default";
  fileQueueDir = path.join(os.homedir(), ".lark-bridge-mcp", `queue-${suffix}`);
  if (!fs.existsSync(fileQueueDir)) fs.mkdirSync(fileQueueDir, { recursive: true });
  log("INFO", `共享文件队列: ${fileQueueDir}`);

  try {
    const now = Date.now();
    for (const f of fs.readdirSync(fileQueueDir)) {
      if (!f.endsWith(".claimed") && !f.endsWith(".tmp")) continue;
      try {
        const stat = fs.statSync(path.join(fileQueueDir, f));
        if (now - stat.mtimeMs > 5 * 60 * 1000) fs.unlinkSync(path.join(fileQueueDir, f));
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
}

function pushToFileQueue(text: string, messageId?: string): boolean {
  if (!fileQueueDir || !text?.trim()) return false;
  const ts = Date.now();
  const id = messageId || `${ts}-${Math.random().toString(36).slice(2, 8)}`;
  const safeId = id.replace(/[^a-zA-Z0-9_-]/g, "_");

  if (messageId) {
    try {
      const existing = fs.readdirSync(fileQueueDir);
      if (existing.some((f) => f.endsWith(`_${safeId}.qmsg`) || f.endsWith(`_${safeId}.claimed`))) return false;
    } catch { /* ignore */ }
  }

  try {
    const data = JSON.stringify({ text, messageId: id, timestamp: ts, source: `daemon-${process.pid}` });
    const filename = `${ts}_${safeId}.qmsg`;
    const tmpPath = path.join(fileQueueDir, filename + ".tmp");
    const finalPath = path.join(fileQueueDir, filename);
    fs.writeFileSync(tmpPath, data, "utf-8");
    fs.renameSync(tmpPath, finalPath);
    return true;
  } catch { return false; }
}

function claimNextMessage(): string | null {
  if (!fileQueueDir) return null;
  let files: string[];
  try { files = fs.readdirSync(fileQueueDir).filter((f) => f.endsWith(".qmsg")).sort(); } catch { return null; }
  for (const file of files) {
    const srcPath = path.join(fileQueueDir, file);
    const claimedPath = srcPath.replace(/\.qmsg$/, ".claimed");
    try { fs.renameSync(srcPath, claimedPath); } catch { continue; }
    try {
      const raw = fs.readFileSync(claimedPath, "utf-8");
      fs.unlinkSync(claimedPath);
      const parsed = JSON.parse(raw);
      return typeof parsed.text === "string" ? parsed.text : raw;
    } catch {
      try { fs.unlinkSync(claimedPath); } catch { /* ignore */ }
      continue;
    }
  }
  return null;
}

function getFileQueueLength(): number {
  if (!fileQueueDir) return 0;
  try { return fs.readdirSync(fileQueueDir).filter((f) => f.endsWith(".qmsg")).length; } catch { return 0; }
}

function getFileQueueMessages(): { index: number; preview: string }[] {
  if (!fileQueueDir) return [];
  try {
    const files = fs.readdirSync(fileQueueDir).filter((f) => f.endsWith(".qmsg")).sort();
    return files.map((f, i) => {
      try {
        const raw = fs.readFileSync(path.join(fileQueueDir, f), "utf-8");
        const parsed = JSON.parse(raw);
        return { index: i, preview: parsed.text ?? "" };
      } catch { return { index: i, preview: "(unreadable)" }; }
    });
  } catch { return []; }
}

function clearFileQueue(): number {
  if (!fileQueueDir) return 0;
  try {
    const files = fs.readdirSync(fileQueueDir).filter((f) => f.endsWith(".qmsg"));
    for (const f of files) {
      try { fs.unlinkSync(path.join(fileQueueDir, f)); } catch { /* ignore */ }
    }
    log("INFO", `队列已清空: ${files.length} 条消息`);
    return files.length;
  } catch { return 0; }
}

function pollFileQueue(timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    const immediate = claimNextMessage();
    if (immediate !== null) { resolve(immediate); return; }
    const deadline = Date.now() + timeoutMs;
    const timer = setInterval(() => {
      const msg = claimNextMessage();
      if (msg !== null) { clearInterval(timer); resolve(msg); return; }
      if (Date.now() >= deadline) { clearInterval(timer); resolve(null); }
    }, FILE_QUEUE_POLL_MS);
    timer.unref();
  });
}

async function pollFileQueueBatch(timeoutMs: number): Promise<string | null> {
  const first = await pollFileQueue(timeoutMs);
  if (first === null) return null;
  const messages = [first];
  let extra = claimNextMessage();
  while (extra !== null) { messages.push(extra); extra = claimNextMessage(); }
  return messages.join("\n");
}

function pushMessage(content: string, messageId?: string): void {
  if (!content?.trim()) {
    log("WARN", `丢弃空消息 (messageId=${messageId})`);
    return;
  }
  const written = pushToFileQueue(content, messageId);
  if (written) {
    log("INFO", `消息已写入共享队列: ${JSON.stringify(content)} (id=${messageId ?? "none"})`);
  } else {
    log("INFO", `消息已跳过（重复或写入失败）: id=${messageId ?? "none"}`);
  }
}

let daemonPort = 0;

// ── 飞书 WebSocket 长连接 ────────────────────────────────

function startLarkConnection(): void {
  if (!APP_ID || !APP_SECRET) { log("ERROR", "LARK_APP_ID / LARK_APP_SECRET 未配置"); return; }

  const eventDispatcher = new Lark.EventDispatcher(
    ENCRYPT_KEY ? { encryptKey: ENCRYPT_KEY } : {},
  ).register({
    "im.message.receive_v1": (data) => {
      let messageId = "";
      try {
        const msg = (data as any)?.message;
        const sender = (data as any)?.sender;
        messageId = msg?.message_id ?? "";
        const rawContent: string = msg?.content ?? "";
        const messageType: string = msg?.message_type ?? "text";

        let text = rawContent;
        try { text = JSON.parse(rawContent)?.text ?? rawContent; } catch { /* use raw */ }

        log("INFO", `收到[${messageType}]: ${JSON.stringify(text ?? "")} (id=${messageId})`);

        const senderOpenId = sender?.sender_id?.open_id;
        if (senderOpenId && !resolvedTarget) {
          autoOpenId = senderOpenId;
        }

        if (messageType === "text" && isCommand(text)) {
          handleCommand(text, messageId).catch((e: any) =>
            log("ERROR", `指令处理失败: ${e?.message ?? e}`),
          );
          return;
        }

        if (messageType === "image" || messageType === "post") {
          processIncomingMessage(messageId, messageType, rawContent)
            .then((result) => pushMessage(result, messageId))
            .catch(() => pushMessage(text, messageId));
        } else {
          pushMessage(text, messageId);
        }
      } catch (e: any) {
        log("ERROR", `事件处理异常[${messageId}]: ${e?.message ?? e}`);
      }
    },
  });

  const wsClient = new Lark.WSClient({
    appId: APP_ID, appSecret: APP_SECRET, loggerLevel: Lark.LoggerLevel.warn,
  });

  wsClient.start({ eventDispatcher }).then(() => {
    log("INFO", "飞书 WebSocket 连接建立成功");
  }).catch((e: any) => {
    log("ERROR", `飞书 WebSocket 连接失败: ${e?.message ?? e}`);
  });
  log("INFO", "飞书 WebSocket 长连接启动中...");
}

// ── 指令系统 ─────────────────────────────────────────────

const COMMANDS: Record<string, string> = {
  "/stop": "停止当前运行中的 Agent",
  "/status": "查看 Agent / Daemon 状态",
  "/list": "查看消息队列列表（不消费）",
  "/task": "定时任务（/task 查看子命令说明；如 /task ls）",
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
    await sendLarkMessage(text);
  }
}

// ── 共享指令文件队列（.fcmd 文件，MCP 和 Daemon 平权写入）──

function pushCommandToQueue(command: string, messageId: string, source: string): boolean {
  if (!fileQueueDir) return false;
  const ts = Date.now();
  const safeId = messageId.replace(/[^a-zA-Z0-9_-]/g, "_");

  try {
    const existing = fs.readdirSync(fileQueueDir);
    if (existing.some((f) => f.includes(`_${safeId}.fcmd`))) return false;
  } catch { /* ignore */ }

  try {
    const data = JSON.stringify({ command, messageId, timestamp: ts, source });
    const filename = `${ts}_${safeId}.fcmd`;
    const tmpPath = path.join(fileQueueDir, filename + ".tmp");
    const finalPath = path.join(fileQueueDir, filename);
    fs.writeFileSync(tmpPath, data, "utf-8");
    fs.renameSync(tmpPath, finalPath);
    log("INFO", `指令已入队: ${command} (msgId=${messageId}, source=${source})`);
    return true;
  } catch { return false; }
}

function getPendingCommands(): { id: string; command: string; messageId: string }[] {
  if (!fileQueueDir) return [];
  try {
    const files = fs.readdirSync(fileQueueDir).filter((f) => f.endsWith(".fcmd")).sort();
    return files.map((f) => {
      try {
        const raw = fs.readFileSync(path.join(fileQueueDir, f), "utf-8");
        const parsed = JSON.parse(raw);
        return { id: f, command: parsed.command, messageId: parsed.messageId };
      } catch { return null; }
    }).filter(Boolean) as { id: string; command: string; messageId: string }[];
  } catch { return []; }
}

function claimCommand(fileId: string): { command: string; messageId: string } | null {
  if (!fileQueueDir) return null;
  const srcPath = path.join(fileQueueDir, fileId);
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
  if (!fileQueueDir) return;
  const now = Date.now();
  try {
    const files = fs.readdirSync(fileQueueDir).filter((f) => f.endsWith(".fcmd"));
    for (const f of files) {
      try {
        const raw = fs.readFileSync(path.join(fileQueueDir, f), "utf-8");
        const parsed = JSON.parse(raw);
        if (now - (parsed.timestamp ?? 0) > 60_000) {
          fs.unlinkSync(path.join(fileQueueDir, f));
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
  if (!fileQueueDir) return;
  try {
    const files = fs.readdirSync(fileQueueDir).filter((f) => f.endsWith(".qmsg"));
    for (const f of files) {
      try {
        const raw = fs.readFileSync(path.join(fileQueueDir, f), "utf-8");
        const parsed = JSON.parse(raw);
        if (typeof parsed.text === "string" && isCommand(parsed.text)) {
          fs.unlinkSync(path.join(fileQueueDir, f));
          log("INFO", `从消息队列中清除指令消息: ${JSON.stringify(parsed.text)}`);
        }
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
}

async function handleCommand(text: string, messageId: string): Promise<void> {
  const trimmed = text.trim();
  log("INFO", `处理指令: ${trimmed} (msgId=${messageId})`);
  pushCommandToQueue(trimmed, messageId, `daemon-${process.pid}`);
  setTimeout(() => cleanCommandMessagesFromQueue(), 2000);
}

// ── HTTP Server ──────────────────────────────────────────

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
        // ── 健康检查
        if (method === "GET" && pathname === "/health") {
          cleanExpiredCommands();
          json(res, {
            status: "ok",
            version: PKG_VERSION,
            uptime: Math.floor(process.uptime()),
            queueLength: getFileQueueLength(),
            hasTarget: !!getSendTarget(),
            autoOpenId: autoOpenId || null,
            feishuConnected: true,
          });
          return;
        }

        // ── 消息队列预览
        if (method === "GET" && pathname === "/queue") {
          const messages = getFileQueueMessages();
          json(res, { length: messages.length, messages });
          return;
        }

        // ── 详细状态（供 Electron UI 使用）
        if (method === "GET" && pathname === "/status") {
          json(res, {
            status: "ok",
            version: PKG_VERSION,
            uptime: Math.floor(process.uptime()),
            queueLength: getFileQueueLength(),
            hasTarget: !!getSendTarget(),
            autoOpenId: autoOpenId || null,
          });
          return;
        }

        // ── 优雅关闭
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

        // ── 发送消息（供 agent curl 调用）
        if (method === "POST" && pathname === "/send") {
          const body = JSON.parse(await readBody(req));
          await sendLarkMessage(body.text);
          json(res, { ok: true });
          return;
        }

        if (method === "POST" && pathname === "/send-image") {
          const body = JSON.parse(await readBody(req));
          await sendLarkImage(body.image_path);
          json(res, { ok: true });
          return;
        }

        if (method === "POST" && pathname === "/send-file") {
          const body = JSON.parse(await readBody(req));
          await sendLarkFile(body.file_path);
          json(res, { ok: true });
          return;
        }

        // ── 入队消息（供定时任务等外部推送）
        if (method === "POST" && pathname === "/enqueue") {
          const body = JSON.parse(await readBody(req));
          const content = typeof body.content === "string" ? body.content : "";
          if (!content) {
            json(res, { error: "content is required" }, 400);
            return;
          }
          pushMessage(content);
          json(res, { ok: true, queueLength: getFileQueueLength() });
          return;
        }

        // ── 清空队列
        if (method === "POST" && pathname === "/clear-queue") {
          const cleared = clearFileQueue();
          json(res, { ok: true, cleared });
          return;
        }

        // ── 立即出队（供 Electron 主进程内部调用，无收集窗口）
        if (method === "GET" && pathname === "/dequeue") {
          const msg = claimNextMessage();
          json(res, { message: msg, queueLength: getFileQueueLength() });
          return;
        }

        // ── 一次出队全部消息（供 Electron 合并后交给 Agent）
        if (method === "POST" && pathname === "/dequeue-all") {
          const messages: string[] = [];
          let m: string | null;
          while ((m = claimNextMessage()) !== null) {
            messages.push(m);
          }
          json(res, { ok: true, messages, queueLength: getFileQueueLength() });
          return;
        }

        // ── 指令队列：获取待处理指令
        if (method === "GET" && pathname === "/commands") {
          const commands = getPendingCommands();
          json(res, { commands });
          return;
        }

        // ── 指令队列：认领指令
        if (method === "POST" && pathname === "/commands/claim") {
          const body = JSON.parse(await readBody(req));
          const result = claimCommand(body.id);
          json(res, result ? { ok: true, ...result } : { ok: false, error: "not found" });
          return;
        }

        // ── 指令结果回报（Electron → Daemon → Lark 回复）
        if (method === "POST" && pathname === "/cmd/result") {
          const body = JSON.parse(await readBody(req)) as { messageId: string; ok: boolean; message: string };
          log("INFO", `指令执行完成: ok=${body.ok}, msgId=${body.messageId}`);
          if (body.messageId) {
            await replyToMessage(body.messageId, `${body.message}`);
          }
          json(res, { ok: true });
          return;
        }

        // ── 轮询消息（供 agent curl 调用）
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
  log("INFO", `Lock 文件已写入: ${lockPath}`);
}

function removeLockFile(): void {
  try {
    const lockPath = getLockFilePath();
    if (fs.existsSync(lockPath)) { fs.unlinkSync(lockPath); log("INFO", "Lock 文件已清理"); }
  } catch { /* ignore */ }
}

// ── 主函数 ───────────────────────────────────────────────

export async function daemonMain(): Promise<void> {
  if (!APP_ID || !APP_SECRET) {
    log("ERROR", "LARK_APP_ID / LARK_APP_SECRET 未配置");
    process.exit(1);
  }

  if (savedProxyKeys.length > 0) {
    log("INFO", `已剥离代理环境变量 (${savedProxyKeys.join(", ")})，飞书连接将直连`);
  }

  log("INFO", "════════════════════════════════════════════════");
  log("INFO", `lark-bridge-daemon v${PKG_VERSION} 启动`);
  log("INFO", `workspace: ${WORKSPACE_DIR}`);
  log("INFO", `日志文件: ${LOG_FILE_PATH}`);
  log("INFO", "════════════════════════════════════════════════");

  const cleanup = () => {
    stopDaemonScheduledTasks();
    removeLockFile();
    process.exit(0);
  };
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
  process.on("exit", removeLockFile);

  initFileQueue();
  await initSendTarget();
  startLarkConnection();

  daemonPort = await startHttpServer();
  writeLockFile(daemonPort);

  setDaemonSchedulerLogger((msg) => { log("INFO", msg); });
  startDaemonScheduledTasks((content) => { pushMessage(content); });

  log("INFO", `守护进程就绪 ✓ port=${daemonPort}`);
}
