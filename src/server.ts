import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createRequire } from "node:module";
import http from "node:http";

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

const DAEMON_PORT = process.env.LARK_DAEMON_PORT ?? "";

// ── 日志 ─────────────────────────────────────────────────

function localTimestamp(): string {
  return new Date().toLocaleString("zh-CN", { hour12: false });
}

function log(level: string, ...args: unknown[]): void {
  const msg = args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
  process.stderr.write(`[${localTimestamp()}][${level}] ${msg}\n`);
}

// ── Daemon HTTP Client ───────────────────────────────────

function daemonUrl(path: string): string {
  return `http://127.0.0.1:${DAEMON_PORT}${path}`;
}

function httpJson<T = any>(url: string, body?: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    const isPost = body !== undefined;
    const payload = isPost ? JSON.stringify(body) : undefined;
    const parsed = new URL(url);

    const req = http.request({
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname + parsed.search,
      method: isPost ? "POST" : "GET",
      headers: isPost ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload!) } : undefined,
      timeout: 180_000,
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString()));
        } catch (e) {
          reject(new Error(`daemon JSON parse error: ${Buffer.concat(chunks).toString().slice(0, 200)}`));
        }
      });
    });

    req.on("error", (e) => reject(new Error(`daemon request failed: ${e.message}`)));
    req.on("timeout", () => { req.destroy(); reject(new Error("daemon request timeout")); });
    if (payload) req.write(payload);
    req.end();
  });
}

async function pollDaemon(timeoutMs: number, chatId?: string): Promise<{ text: string; messageId: string; chatId: string; chatType: string; senderOpenId: string } | null> {
  const params = new URLSearchParams({ timeout: String(timeoutMs) });
  if (chatId) params.set("chatId", chatId);
  const res = await httpJson<{ message: any }>(daemonUrl(`/api/poll-message?${params}`));
  return res.message ?? null;
}

// ── 优雅退出 ─────────────────────────────────────────────

let isShuttingDown = false;

function gracefulShutdown(reason: string): void {
  if (isShuttingDown) return;
  isShuttingDown = true;
  log("INFO", `进程退出中 (reason=${reason}, PID=${process.pid})`);
  setTimeout(() => process.exit(0), 300);
}

// ── MCP Server ──────────────────────────────────────────

const mcpServer = new McpServer({ name: "feishu-cursor-bridge", version: PKG_VERSION, description: "飞书消息桥接 – 通过飞书与用户沟通" });

mcpServer.tool(
  "sync_message",
  "飞书消息同步工具。传 message 则发送消息；传 timeout_seconds 则等待用户回复；两者同时传则先发送再等待。均不传时仅检查待处理消息。",
  {
    message: z.string().optional().describe("要发送给用户的消息内容。不传则不发送"),
    timeout_seconds: z.number().optional().describe("等待用户回复的超时秒数。不传则不等待，立即返回"),
    message_id: z.string().optional().describe("要回复的消息ID，传入后以回复模式发送"),
    chat_id: z.string().optional().describe("目标会话ID，用于精确投递到对应的群或私聊"),
  },
  async ({ message, timeout_seconds, message_id, chat_id }) => {
    try {
      if (message) {
        await httpJson(daemonUrl("/api/send-text"), { text: message, message_id, chat_id });
      }
      const timeoutMs = (timeout_seconds && timeout_seconds > 0) ? timeout_seconds * 1000 : 0;
      if (timeoutMs > 0) {
        const reply = await pollDaemon(timeoutMs, chat_id);
        if (reply === null) return { content: [{ type: "text" as const, text: "[waiting]" }] };
        const meta = [reply.text];
        if (reply.messageId) meta.push(`[message_id=${reply.messageId}]`);
        if (reply.chatId) meta.push(`[chat_id=${reply.chatId}]`);
        if (reply.chatType) meta.push(`[chat_type=${reply.chatType}]`);
        return { content: [{ type: "text" as const, text: meta.join("\n") }] };
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
  {
    image_path: z.string().describe("图片绝对路径"),
    message_id: z.string().optional().describe("要回复的消息ID，传入后以回复模式发送"),
    chat_id: z.string().optional().describe("目标会话ID，用于精确投递到对应的群或私聊"),
  },
  async ({ image_path, message_id, chat_id }) => {
    await httpJson(daemonUrl("/api/send-image"), { image_path, message_id, chat_id });
    return { content: [{ type: "text" as const, text: "图片已发送" }] };
  },
);

mcpServer.tool(
  "send_file",
  "发送本地文件到飞书。file_path 为本地文件绝对路径。",
  {
    file_path: z.string().describe("文件绝对路径"),
    message_id: z.string().optional().describe("要回复的消息ID，传入后以回复模式发送"),
    chat_id: z.string().optional().describe("目标会话ID，用于精确投递到对应的群或私聊"),
  },
  async ({ file_path, message_id, chat_id }) => {
    await httpJson(daemonUrl("/api/send-file"), { file_path, message_id, chat_id });
    return { content: [{ type: "text" as const, text: "文件已发送" }] };
  },
);

// ── 主函数 ───────────────────────────────────────────────

export async function main(): Promise<void> {
  if (!DAEMON_PORT) {
    log("ERROR", "LARK_DAEMON_PORT 未配置");
    process.exit(1);
  }

  log("INFO", "════════════════════════════════════════════════");
  log("INFO", `feishu-cursor-bridge MCP v${PKG_VERSION} 启动 (PID=${process.pid})`);
  log("INFO", `Daemon endpoint: http://127.0.0.1:${DAEMON_PORT}`);
  log("INFO", "════════════════════════════════════════════════");

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
