import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as Lark from "@larksuiteoapi/node-sdk";

// ── stdout 保护：MCP 用 stdio 通信，任何非协议输出都会破坏 JSON-RPC 帧 ──
const _origStdoutWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = ((chunk: any, encodingOrCb?: any, cb?: any): boolean => {
  const str = typeof chunk === "string" ? chunk : chunk instanceof Buffer ? chunk.toString() : String(chunk);
  if (str.includes('"jsonrpc"') || str.includes("Content-Length")) {
    return _origStdoutWrite(chunk, encodingOrCb, cb);
  }
  if (typeof encodingOrCb === "function") {
    process.stderr.write(chunk, encodingOrCb);
  } else {
    process.stderr.write(chunk, encodingOrCb, cb);
  }
  return true;
}) as typeof process.stdout.write;

// ── 环境变量 ──────────────────────────────────────────────

const APP_ID = process.env.LARK_APP_ID ?? "";
const APP_SECRET = process.env.LARK_APP_SECRET ?? "";
const ENCRYPT_KEY = process.env.LARK_ENCRYPT_KEY ?? "";
const RECEIVE_ID = process.env.LARK_RECEIVE_ID ?? "";
const RECEIVE_ID_TYPE = process.env.LARK_RECEIVE_ID_TYPE ?? "";
const MESSAGE_PREFIX = process.env.LARK_MESSAGE_PREFIX ?? "";

const PROXY_KEYS = [
  "HTTP_PROXY", "http_proxy",
  "HTTPS_PROXY", "https_proxy",
  "ALL_PROXY", "all_proxy",
  "NODE_USE_ENV_PROXY",
];
for (const key of PROXY_KEYS) { delete process.env[key]; }

// ── 日志 ─────────────────────────────────────────────────

function localTimestamp(): string {
  const d = new Date();
  const pad2 = (n: number) => String(n).padStart(2, "0");
  const pad3 = (n: number) => String(n).padStart(3, "0");
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}.${pad3(d.getMilliseconds())}`;
}

function log(level: string, ...args: unknown[]): void {
  const msg = args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
  process.stderr.write(`[${localTimestamp()}][${level}] ${msg}\n`);
}

// ── 单实例保护（PID 锁）────────────────────────────────

const workspaceDirs = [
  process.env.LARK_WORKSPACE_DIR,
  process.cwd(),
].filter(Boolean) as string[];

function resolvePidFilePath(): string {
  for (const ws of workspaceDirs) {
    const cursorDir = path.join(ws, ".cursor");
    if (fs.existsSync(cursorDir)) return path.join(cursorDir, ".lark-mcp.pid");
  }
  return path.join(os.tmpdir(), ".lark-mcp.pid");
}

const MCP_PID_FILE = resolvePidFilePath();

function killPreviousInstance(): void {
  try {
    if (!fs.existsSync(MCP_PID_FILE)) return;
    const oldPid = parseInt(fs.readFileSync(MCP_PID_FILE, "utf-8").trim(), 10);
    if (isNaN(oldPid) || oldPid === process.pid) return;
    try {
      process.kill(oldPid, 0);
      log("WARN", `发现旧 MCP 进程 (PID=${oldPid})，正在终止...`);
      process.kill(oldPid);
    } catch { /* already dead */ }
  } catch (e: any) {
    log("WARN", `清理旧进程失败: ${e?.message ?? e}`);
  }
}

function writePidFile(): void {
  try {
    const dir = path.dirname(MCP_PID_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(MCP_PID_FILE, String(process.pid), "utf-8");

    const cleanup = () => {
      try { fs.unlinkSync(MCP_PID_FILE); } catch { /* best-effort */ }
    };
    process.on("exit", cleanup);
    process.on("SIGTERM", () => { cleanup(); process.exit(0); });
    process.on("SIGINT", () => { cleanup(); process.exit(0); });
  } catch (e: any) {
    log("WARN", `写入 PID 文件失败: ${e?.message ?? e}`);
  }
}

// ── Daemon HTTP 客户端 ──────────────────────────────────

let daemonBaseUrl = "";

function findDaemonPort(): number | null {
  const envPort = process.env.LARK_DAEMON_PORT;
  if (envPort) {
    const p = Number(envPort);
    if (p > 0) { log("INFO", `从 LARK_DAEMON_PORT 环境变量获取端口: ${p}`); return p; }
  }
  for (const ws of workspaceDirs) {
    const lockPath = path.join(ws, ".cursor", ".lark-daemon.json");
    try {
      const raw = fs.readFileSync(lockPath, "utf-8");
      const data = JSON.parse(raw);
      if (data.port) return Number(data.port);
    } catch { /* lock not found */ }
  }
  return null;
}

function httpRequest(method: string, urlPath: string, body?: unknown, timeoutMs = 30_000): Promise<any> {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, daemonBaseUrl);
    const payload = body ? JSON.stringify(body) : undefined;
    const req = http.request(url, {
      method,
      headers: payload
        ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) }
        : undefined,
      timeout: timeoutMs,
    }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve(data); }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
    if (payload) req.write(payload);
    req.end();
  });
}

async function pingDaemon(port: number): Promise<boolean> {
  try {
    const resp = await httpRequest("GET", `/health`);
    return resp?.status === "ok";
  } catch { return false; }
}

// ── 内嵌模式（无 Daemon 时降级使用）─────────────────────

type ReceiveIdType = "open_id" | "union_id" | "user_id" | "chat_id" | "email";
interface SendTarget { receiveIdType: ReceiveIdType; receiveId: string }
let resolvedTarget: SendTarget | null = null;
let autoOpenId = "";
let embeddedMode = false;

const larkClient = new Lark.Client({
  appId: APP_ID, appSecret: APP_SECRET,
  appType: Lark.AppType.SelfBuild,
  domain: Lark.Domain.Feishu,
  loggerLevel: Lark.LoggerLevel.error,
});

async function resolveEmailToOpenId(email: string): Promise<string | null> {
  try {
    const res = await larkClient.contact.user.batchGetId({
      params: { user_id_type: "open_id" }, data: { emails: [email] },
    });
    const users = res.data?.user_list;
    if (users && users.length > 0 && users[0].user_id) return users[0].user_id;
    return null;
  } catch { return null; }
}

async function resolveMobileToOpenId(mobile: string): Promise<string | null> {
  try {
    const res = await larkClient.contact.user.batchGetId({
      params: { user_id_type: "open_id" }, data: { mobiles: [mobile] },
    });
    const users = res.data?.user_list;
    if (users && users.length > 0 && users[0].user_id) return users[0].user_id;
    return null;
  } catch { return null; }
}

async function initSendTarget(): Promise<void> {
  if (!RECEIVE_ID) { log("INFO", "未配置 LARK_RECEIVE_ID，将从首条消息自动获取"); return; }
  const idType = RECEIVE_ID_TYPE || "auto";
  if (["open_id", "user_id", "union_id", "chat_id"].includes(idType)) {
    resolvedTarget = { receiveIdType: idType as ReceiveIdType, receiveId: RECEIVE_ID };
    return;
  }
  if (idType === "email" || (idType === "auto" && RECEIVE_ID.includes("@"))) {
    const openId = await resolveEmailToOpenId(RECEIVE_ID);
    if (openId) { resolvedTarget = { receiveIdType: "open_id", receiveId: openId }; return; }
  }
  if (idType === "mobile" || (idType === "auto" && /^\+?\d{7,}$/.test(RECEIVE_ID))) {
    const openId = await resolveMobileToOpenId(RECEIVE_ID);
    if (openId) { resolvedTarget = { receiveIdType: "open_id", receiveId: openId }; return; }
  }
  resolvedTarget = { receiveIdType: "open_id", receiveId: RECEIVE_ID };
}

function getSendTarget(): SendTarget | null {
  if (resolvedTarget) return resolvedTarget;
  if (autoOpenId) return { receiveIdType: "open_id", receiveId: autoOpenId };
  return null;
}

async function embeddedSendMessage(text: string): Promise<void> {
  const target = getSendTarget();
  if (!target) { log("WARN", "无发送目标"); return; }
  try {
    await larkClient.im.message.create({
      params: { receive_id_type: target.receiveIdType },
      data: { receive_id: target.receiveId, content: JSON.stringify({ text: `${MESSAGE_PREFIX}${text}` }), msg_type: "text" },
    });
    log("INFO", `飞书消息已发送(${text.length}字)`);
  } catch (e: any) { log("ERROR", `飞书发送异常: ${e?.message ?? e}`); }
}

async function embeddedSendImage(imagePath: string): Promise<void> {
  const target = getSendTarget();
  if (!target) { log("WARN", "无发送目标"); return; }
  const absPath = path.resolve(imagePath);
  if (!fs.existsSync(absPath)) { log("ERROR", `图片不存在: ${absPath}`); return; }
  try {
    const uploadRes = await larkClient.im.image.create({ data: { image_type: "message", image: fs.createReadStream(absPath) } });
    const imageKey = (uploadRes as any)?.data?.image_key ?? (uploadRes as any)?.image_key;
    if (!imageKey) { log("ERROR", `图片上传失败`); return; }
    await larkClient.im.message.create({
      params: { receive_id_type: target.receiveIdType },
      data: { receive_id: target.receiveId, content: JSON.stringify({ image_key: imageKey }), msg_type: "image" },
    });
    log("INFO", "图片已发送");
  } catch (e: any) { log("ERROR", `发送图片异常: ${e?.message ?? e}`); }
}

async function embeddedSendFile(filePath: string): Promise<void> {
  const target = getSendTarget();
  if (!target) { log("WARN", "无发送目标"); return; }
  const absPath = path.resolve(filePath);
  if (!fs.existsSync(absPath)) { log("ERROR", `文件不存在: ${absPath}`); return; }
  try {
    const fileName = path.basename(absPath);
    const uploadRes = await larkClient.im.file.create({ data: { file_type: "stream", file_name: fileName, file: fs.createReadStream(absPath) } });
    const fileKey = (uploadRes as any)?.data?.file_key ?? (uploadRes as any)?.file_key;
    if (!fileKey) { log("ERROR", `文件上传失败`); return; }
    await larkClient.im.message.create({
      params: { receive_id_type: target.receiveIdType },
      data: { receive_id: target.receiveId, content: JSON.stringify({ file_key: fileKey, file_name: fileName }), msg_type: "file" },
    });
    log("INFO", `文件已发送: ${fileName}`);
  } catch (e: any) { log("ERROR", `发送文件异常: ${e?.message ?? e}`); }
}

const IMAGE_DOWNLOAD_DIR = path.join(os.tmpdir(), "lark-bridge-images");

async function downloadLarkImage(messageId: string, imageKey: string): Promise<string | null> {
  try {
    if (!fs.existsSync(IMAGE_DOWNLOAD_DIR)) fs.mkdirSync(IMAGE_DOWNLOAD_DIR, { recursive: true });
    const resp: any = await larkClient.im.messageResource.get({
      path: { message_id: messageId, file_key: imageKey },
      params: { type: "image" },
    });
    const filePath = path.join(IMAGE_DOWNLOAD_DIR, `${imageKey}.png`);
    if (resp && typeof resp.pipe === "function") {
      const ws = fs.createWriteStream(filePath);
      await new Promise<void>((resolve, reject) => { resp.pipe(ws); ws.on("finish", resolve); ws.on("error", reject); });
      return filePath;
    }
    if (resp?.writeFile) { await resp.writeFile(filePath); return filePath; }
    return null;
  } catch (e: any) { log("ERROR", `下载图片异常: ${e?.message ?? e}`); return null; }
}

function parseMessageContent(messageId: string, messageType: string, content: string): { text: string; imageKeys: { messageId: string; imageKey: string }[] } {
  const result: { text: string; imageKeys: { messageId: string; imageKey: string }[] } = { text: "", imageKeys: [] };
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
        for (const line of (parsed.content ?? [])) {
          for (const el of line) {
            if (el.tag === "text" && el.text) parts.push(el.text);
            else if (el.tag === "img" && el.image_key) { result.imageKeys.push({ messageId, imageKey: el.image_key }); parts.push("[图片]"); }
            else if (el.tag === "a" && el.text) parts.push(el.text);
          }
        }
        result.text = parts.join("");
        break;
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

const messageQueue: string[] = [];
const pollWaiters: { resolve: (v: string | null) => void; timer: ReturnType<typeof setTimeout> }[] = [];
const processedMessageIds = new Set<string>();

function pushMessage(content: string, messageId?: string): void {
  if (!content || !content.trim()) {
    log("WARN", `丢弃空消息 (messageId=${messageId})`);
    return;
  }
  if (messageId) {
    if (processedMessageIds.has(messageId)) return;
    processedMessageIds.add(messageId);
    if (processedMessageIds.size > 200) { const first = processedMessageIds.values().next().value; if (first !== undefined) processedMessageIds.delete(first); }
  }
  log("INFO", `pushMessage: "${content.slice(0, 60)}", waiters=${pollWaiters.length}, queue=${messageQueue.length}`);
  while (pollWaiters.length > 0) {
    const waiter = pollWaiters.shift()!;
    clearTimeout(waiter.timer);
    waiter.resolve(content);
    return;
  }
  messageQueue.push(content);
}

function drainEmptyMessages(): void {
  while (messageQueue.length > 0 && !messageQueue[0]?.trim()) {
    messageQueue.shift();
  }
}

function pullMessage(timeoutMs: number): Promise<string | null> {
  drainEmptyMessages();
  if (messageQueue.length > 0) {
    const msg = messageQueue.shift()!;
    log("INFO", `pullMessage: 从队列取出 "${msg.slice(0, 40)}", 剩余=${messageQueue.length}`);
    return Promise.resolve(msg);
  }
  log("INFO", `pullMessage: 队列为空, 创建 waiter (timeout=${timeoutMs}ms)`);
  return new Promise((resolve) => {
    const entry = {
      resolve,
      timer: setTimeout(() => {
        const idx = pollWaiters.indexOf(entry);
        if (idx >= 0) pollWaiters.splice(idx, 1);
        log("INFO", `pullMessage: waiter 超时 (${timeoutMs}ms), queue=${messageQueue.length}`);
        resolve(null);
      }, timeoutMs),
    };
    pollWaiters.push(entry);
  });
}

async function waitForReply(timeoutMs: number): Promise<string | null> {
  const first = await pullMessage(timeoutMs);
  if (first === null) return null;
  const messages = [first];
  while (messageQueue.length > 0) {
    const next = messageQueue[0];
    if (!next?.trim()) { messageQueue.shift(); continue; }
    messages.push(messageQueue.shift()!);
  }
  log("INFO", `waitForReply: 返回 ${messages.length} 条消息, 剩余队列=${messageQueue.length}`);
  return messages.join("\n");
}

function startLarkConnection(): void {
  const eventDispatcher = new Lark.EventDispatcher(ENCRYPT_KEY ? { encryptKey: ENCRYPT_KEY } : {}).register({
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

        log("INFO", `收到[${messageType}]: "${text?.slice(0, 80)}" (id=${messageId})`);

        const senderOpenId = sender?.sender_id?.open_id;
        if (senderOpenId && !resolvedTarget) { autoOpenId = senderOpenId; }

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
  const wsClient = new Lark.WSClient({ appId: APP_ID, appSecret: APP_SECRET, loggerLevel: Lark.LoggerLevel.error });
  wsClient.start({ eventDispatcher }).then(() => log("INFO", "飞书 WebSocket 连接建立成功")).catch((e: any) => log("ERROR", `飞书 WebSocket 连接失败: ${e?.message ?? e}`));
}

// ── 统一 API（daemon 代理 / 内嵌）─────────────────────────

async function sendMessage(text: string): Promise<void> {
  if (!embeddedMode) {
    await httpRequest("POST", "/send", { text });
  } else {
    await embeddedSendMessage(text);
  }
}

async function sendImage(imagePath: string): Promise<void> {
  if (!embeddedMode) {
    await httpRequest("POST", "/send-image", { image_path: imagePath });
  } else {
    await embeddedSendImage(imagePath);
  }
}

async function sendFile(filePath: string): Promise<void> {
  if (!embeddedMode) {
    await httpRequest("POST", "/send-file", { file_path: filePath });
  } else {
    await embeddedSendFile(filePath);
  }
}

async function pollReply(timeoutMs: number): Promise<string | null> {
  if (!embeddedMode) {
    const httpTimeout = timeoutMs + 10_000;
    const resp = await httpRequest("GET", `/poll?timeout=${timeoutMs}`, undefined, httpTimeout);
    return resp?.message ?? null;
  }
  return await waitForReply(timeoutMs);
}

// ── MCP Server ──────────────────────────────────────────

const mcpServer = new McpServer({ name: "feishu-cursor-bridge", version: "2.2.5", description: "飞书消息桥接 – 通过飞书与用户沟通" });

mcpServer.tool(
  "sync_message",
  "飞书消息同步工具。传 message 则发送消息；传 timeout_seconds 则等待用户回复；两者同时传则先发送再等待。均不传时仅检查待处理消息。",
  {
    message: z.string().optional().describe("要发送给用户的消息内容。不传则不发送"),
    timeout_seconds: z.number().optional().describe("等待用户回复的超时秒数。不传则不等待，立即返回"),
  },
  async ({ message, timeout_seconds }) => {
    try {
      if (message) await sendMessage(message);
      const timeoutMs = (timeout_seconds && timeout_seconds > 0) ? timeout_seconds * 1000 : 0;
      if (timeoutMs > 0) {
        const reply = await pollReply(timeoutMs);
        if (reply === null) return { content: [{ type: "text", text: "[waiting]" }] };
        return { content: [{ type: "text", text: reply }] };
      }
      return { content: [{ type: "text", text: message ? "消息已发送" : "ok" }] };
    } catch (e: any) {
      log("ERROR", `sync_message 异常: ${e?.message ?? e}`);
      return { content: [{ type: "text", text: `[error] ${e?.message ?? "unknown error"}` }] };
    }
  },
);

mcpServer.tool(
  "send_image",
  "发送本地图片到飞书。image_path 为本地文件绝对路径。",
  { image_path: z.string().describe("图片绝对路径") },
  async ({ image_path }) => { await sendImage(image_path); return { content: [{ type: "text", text: "图片已发送" }] }; },
);

mcpServer.tool(
  "send_file",
  "发送本地文件到飞书。file_path 为本地文件绝对路径。",
  { file_path: z.string().describe("文件绝对路径") },
  async ({ file_path }) => { await sendFile(file_path); return { content: [{ type: "text", text: "文件已发送" }] }; },
);

// ── 主函数 ───────────────────────────────────────────────

async function tryConnectDaemon(maxRetries = 3, retryDelayMs = 2000): Promise<boolean> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const port = findDaemonPort();
    if (port) {
      daemonBaseUrl = `http://127.0.0.1:${port}`;
      const alive = await pingDaemon(port);
      if (alive) {
        embeddedMode = false;
        log("INFO", `已连接 daemon (port=${port})，代理模式${attempt > 1 ? ` (第${attempt}次尝试)` : ""}`);
        return true;
      }
      log("WARN", `daemon lock 存在但无响应 (port=${port})${attempt < maxRetries ? "，稍后重试..." : ""}`);
    } else {
      log("INFO", `未检测到 daemon${attempt < maxRetries ? "，稍后重试..." : ""}`);
    }
    if (attempt < maxRetries) await new Promise((r) => setTimeout(r, retryDelayMs));
  }
  return false;
}

export async function main(): Promise<void> {
  killPreviousInstance();
  writePidFile();

  log("INFO", "════════════════════════════════════════════════");
  log("INFO", `feishu-cursor-bridge MCP v2.2.6 启动 (PID=${process.pid})`);
  log("INFO", `workspaceDirs: ${JSON.stringify(workspaceDirs)}`);
  log("INFO", "════════════════════════════════════════════════");

  const hasDaemonPortHint = !!process.env.LARK_DAEMON_PORT;
  const connected = await tryConnectDaemon(hasDaemonPortHint ? 5 : 3, 2000);

  if (!connected) {
    if (hasDaemonPortHint) {
      log("ERROR", "应用版模式下 daemon 不可达，MCP 将以纯代理模式运行（无内嵌 WebSocket，避免连接冲突）");
      embeddedMode = false;
      daemonBaseUrl = `http://127.0.0.1:${process.env.LARK_DAEMON_PORT}`;
    } else {
      log("INFO", "降级为内嵌模式");
      embeddedMode = true;
    }
  }

  if (embeddedMode) {
    if (!APP_ID || !APP_SECRET) {
      log("ERROR", "LARK_APP_ID / LARK_APP_SECRET 未配置");
      process.exit(1);
    }
    await initSendTarget();
    startLarkConnection();
  }

  const transport = new StdioServerTransport();
  await mcpServer.connect(transport);
  log("INFO", `MCP Server 已连接 stdio ✓ (${embeddedMode ? "内嵌" : "代理"}模式)`);
}

main().catch((e) => { log("ERROR", `MCP main 异常: ${e?.message ?? e}`); });
