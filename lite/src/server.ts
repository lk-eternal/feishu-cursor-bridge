import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as Lark from "@larksuiteoapi/node-sdk";
import { initFileQueue, getQueueDir, pushToFileQueue, pollFileQueueBatch, cleanupStaleMessages } from "./file-queue.js";

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

// ── 优雅退出（stdio 断开检测，防止僵尸进程）────────────

let isShuttingDown = false;

function gracefulShutdown(reason: string): void {
  if (isShuttingDown) return;
  isShuttingDown = true;
  log("INFO", `进程退出中 (reason=${reason}, PID=${process.pid})`);
  setTimeout(() => process.exit(0), 300);
}

// ── Lark Client ─────────────────────────────────────────

type ReceiveIdType = "open_id" | "union_id" | "user_id" | "chat_id" | "email";
interface SendTarget { receiveIdType: ReceiveIdType; receiveId: string }
let resolvedTarget: SendTarget | null = null;
let autoOpenId = "";

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

// ── 发送（始终直接调用 Lark API）──────────────────────────

async function sendMessage(text: string): Promise<void> {
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

async function sendImage(imagePath: string): Promise<void> {
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

async function sendFile(filePath: string): Promise<void> {
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

// ── 接收（WebSocket → 共享文件队列 → poll 读取）──────────

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

const COMMANDS = ["/stop", "/status", "/list", "/task", "/clean", "/reset", "/restart", "/help"];

function isCommand(text: string): boolean {
  const trimmed = text.trim().toLowerCase();
  return COMMANDS.some((cmd) => trimmed === cmd || trimmed.startsWith(cmd + " "));
}

function pushCommandToQueue(command: string, messageId: string): void {
  const queueDir = getQueueDir();
  if (!queueDir) return;
  const ts = Date.now();
  const safeId = messageId.replace(/[^a-zA-Z0-9_-]/g, "_");

  try {
    const existing = fs.readdirSync(queueDir);
    if (existing.some((f) => f.includes(`_${safeId}.fcmd`))) return;
  } catch { /* ignore */ }

  try {
    const data = JSON.stringify({ command, messageId, timestamp: ts, source: `mcp-${process.pid}` });
    const filename = `${ts}_${safeId}.fcmd`;
    const tmpPath = path.join(queueDir, filename + ".tmp");
    const finalPath = path.join(queueDir, filename);
    fs.writeFileSync(tmpPath, data, "utf-8");
    fs.renameSync(tmpPath, finalPath);
    log("INFO", `指令已入队: ${command} (msgId=${messageId}, source=mcp)`);
  } catch { /* ignore */ }
}

function pushMessage(content: string, messageId?: string): void {
  if (!content?.trim()) {
    log("WARN", `丢弃空消息 (messageId=${messageId})`);
    return;
  }
  const written = pushToFileQueue(content, messageId, `mcp-${process.pid}`);
  if (written) {
    log("INFO", `消息已写入共享队列: ${JSON.stringify(content)} (id=${messageId ?? "none"})`);
  } else {
    log("INFO", `消息已跳过（重复或写入失败）: id=${messageId ?? "none"}`);
  }
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

        log("INFO", `收到[${messageType}]: ${JSON.stringify(text ?? "")} (id=${messageId})`);

        const senderOpenId = sender?.sender_id?.open_id;
        if (senderOpenId && !resolvedTarget) {
          autoOpenId = senderOpenId;
          log("INFO", `自动识别用户 open_id: ${senderOpenId}（可保存到 LARK_RECEIVE_ID 配置中）`);
        }

        if (messageType === "text" && isCommand(text)) {
          pushCommandToQueue(text.trim(), messageId);
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
  const wsClient = new Lark.WSClient({ appId: APP_ID, appSecret: APP_SECRET, loggerLevel: Lark.LoggerLevel.error });
  wsClient.start({ eventDispatcher }).then(() => log("INFO", "飞书 WebSocket 连接建立成功")).catch((e: any) => log("ERROR", `飞书 WebSocket 连接失败: ${e?.message ?? e}`));
}

// ── MCP Server ──────────────────────────────────────────

const mcpServer = new McpServer({ name: "feishu-cursor-bridge", version: "2.4.7", description: "飞书消息桥接 – 通过飞书与用户沟通" });

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
        const reply = await pollFileQueueBatch(timeoutMs);
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

export async function main(): Promise<void> {
  if (!APP_ID || !APP_SECRET) {
    log("ERROR", "LARK_APP_ID / LARK_APP_SECRET 未配置");
    process.exit(1);
  }

  log("INFO", "════════════════════════════════════════════════");
  log("INFO", `feishu-cursor-bridge MCP v2.4.7 启动 (PID=${process.pid})`);
  log("INFO", "════════════════════════════════════════════════");

  const queueDir = initFileQueue(APP_ID);
  log("INFO", `共享文件队列: ${queueDir}`);
  cleanupStaleMessages();

  await initSendTarget();
  startLarkConnection();

  const transport = new StdioServerTransport();
  await mcpServer.connect(transport);
  log("INFO", "MCP Server 已连接 stdio ✓");

  transport.onclose = () => {
    gracefulShutdown("transport-closed");
  };
  process.stdin.on("end", () => {
    gracefulShutdown("stdin-end");
  });
  process.stdin.on("close", () => {
    gracefulShutdown("stdin-close");
  });
  if (process.platform === "win32") {
    const stdinWatchdog = setInterval(() => {
      if (process.stdin.destroyed || !process.stdin.readable) {
        clearInterval(stdinWatchdog);
        gracefulShutdown("stdin-destroyed");
      }
    }, 5000);
    stdinWatchdog.unref();
  }
}

main().catch((e) => { log("ERROR", `MCP main 异常: ${e?.message ?? e}`); });
