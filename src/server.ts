import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";
import { stripProxyEnv, createLarkClient, LarkSender } from "./shared/lark-core.js";
import { initFileQueue, getQueueDir, pushToFileQueue, pollFileQueueBatch, cleanupStaleMessages } from "./file-queue.js";

const _require = createRequire(import.meta.url);
const PKG_VERSION: string = (_require("../package.json") as { version: string }).version;

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
const HAS_DAEMON = !!process.env.LARK_DAEMON_PORT;

stripProxyEnv();

// ── 日志 ─────────────────────────────────────────────────

import { localTimestamp } from "./shared/lark-core.js";

function log(level: string, ...args: unknown[]): void {
  const msg = args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
  process.stderr.write(`[${localTimestamp()}][${level}] ${msg}\n`);
}

// ── 优雅退出 ─────────────────────────────────────────────

let isShuttingDown = false;

function gracefulShutdown(reason: string): void {
  if (isShuttingDown) return;
  isShuttingDown = true;
  log("INFO", `进程退出中 (reason=${reason}, PID=${process.pid})`);
  setTimeout(() => process.exit(0), 300);
}

// ── Lark ─────────────────────────────────────────────────

const larkClient = createLarkClient(APP_ID, APP_SECRET);
const sender = new LarkSender({ client: larkClient, receiveId: RECEIVE_ID, receiveIdType: RECEIVE_ID_TYPE, messagePrefix: MESSAGE_PREFIX, log });

// ── 消息队列 ─────────────────────────────────────────────

const COMMANDS = ["/stop", "/status", "/list", "/task", "/model", "/mcp", "/clean", "/reset", "/restart", "/help"];

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
  sender.startConnection(APP_ID, APP_SECRET, ENCRYPT_KEY, (text, messageId, messageType, rawContent, senderOpenId) => {
    if (senderOpenId && !sender.resolvedTarget) {
      sender.autoOpenId = senderOpenId;
      log("INFO", `自动识别用户 open_id: ${senderOpenId}（可保存到 LARK_RECEIVE_ID 配置中）`);
    }

    if (messageType === "text" && isCommand(text)) {
      pushCommandToQueue(text.trim(), messageId);
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

// ── MCP Server ──────────────────────────────────────────

const mcpServer = new McpServer({ name: "feishu-cursor-bridge", version: PKG_VERSION, description: "飞书消息桥接 – 通过飞书与用户沟通" });

mcpServer.tool(
  "sync_message",
  "飞书消息同步工具。传 message 则发送消息；传 timeout_seconds 则等待用户回复；两者同时传则先发送再等待。均不传时仅检查待处理消息。",
  {
    message: z.string().optional().describe("要发送给用户的消息内容。不传则不发送"),
    timeout_seconds: z.number().optional().describe("等待用户回复的超时秒数。不传则不等待，立即返回"),
  },
  async ({ message, timeout_seconds }) => {
    try {
      if (message) await sender.sendMessage(message);
      const timeoutMs = (timeout_seconds && timeout_seconds > 0) ? timeout_seconds * 1000 : 0;
      if (timeoutMs > 0) {
        const reply = await pollFileQueueBatch(timeoutMs);
        if (reply === null) return { content: [{ type: "text" as const, text: "[waiting]" }] };
        return { content: [{ type: "text" as const, text: reply }] };
      }
      return { content: [{ type: "text" as const, text: message ? "消息已发送" : "ok" }] };
    } catch (e: any) {
      log("ERROR", `sync_message 异常: ${e?.message ?? e}`);
      return { content: [{ type: "text" as const, text: `[error] ${e?.message ?? "unknown error"}` }] };
    }
  },
);

mcpServer.tool(
  "send_image",
  "发送本地图片到飞书。image_path 为本地文件绝对路径。",
  { image_path: z.string().describe("图片绝对路径") },
  async ({ image_path }) => { await sender.sendImage(image_path); return { content: [{ type: "text" as const, text: "图片已发送" }] }; },
);

mcpServer.tool(
  "send_file",
  "发送本地文件到飞书。file_path 为本地文件绝对路径。",
  { file_path: z.string().describe("文件绝对路径") },
  async ({ file_path }) => { await sender.sendFile(file_path); return { content: [{ type: "text" as const, text: "文件已发送" }] }; },
);

// ── 应用管理工具（仅在 Daemon 模式下注册）─────────────────

import { registerAdminTools } from "./server-admin.js";

if (HAS_DAEMON) {
  registerAdminTools(mcpServer);
}

// ── 主函数 ───────────────────────────────────────────────

export async function main(): Promise<void> {
  if (!APP_ID || !APP_SECRET) {
    log("ERROR", "LARK_APP_ID / LARK_APP_SECRET 未配置");
    process.exit(1);
  }

  log("INFO", "════════════════════════════════════════════════");
  log("INFO", `feishu-cursor-bridge MCP v${PKG_VERSION} 启动 (PID=${process.pid})`);
  log("INFO", "════════════════════════════════════════════════");

  const queueDir = initFileQueue(APP_ID);
  log("INFO", `共享文件队列: ${queueDir}`);
  cleanupStaleMessages();

  await sender.resolveTarget(RECEIVE_ID, RECEIVE_ID_TYPE);
  if (HAS_DAEMON) {
    log("INFO", "检测到 Daemon 运行中，MCP 不建立飞书 WebSocket 连接");
  } else {
    startLarkConnection();
  }

  const transport = new StdioServerTransport();
  await mcpServer.connect(transport);
  log("INFO", "MCP Server 已连接 stdio ✓");

  transport.onclose = () => { gracefulShutdown("transport-closed"); };
  process.stdin.on("end", () => { gracefulShutdown("stdin-end"); });
  process.stdin.on("close", () => { gracefulShutdown("stdin-close"); });
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
