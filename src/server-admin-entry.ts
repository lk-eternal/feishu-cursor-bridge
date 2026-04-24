import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createRequire } from "node:module";
import { registerAdminTools } from "./server-admin.js";

const _require = createRequire(import.meta.url);
const PKG_VERSION: string = (_require("../package.json") as { version: string }).version;

// ── stdout 保护 ──────────────────────────────────────────
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

function log(level: string, ...args: unknown[]): void {
  const ts = new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" });
  const msg = args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
  process.stderr.write(`[${ts}][${level}] ${msg}\n`);
}

let isShuttingDown = false;
function gracefulShutdown(reason: string): void {
  if (isShuttingDown) return;
  isShuttingDown = true;
  log("INFO", `admin-mcp 退出 (reason=${reason})`);
  setTimeout(() => process.exit(0), 300);
}

const mcpServer = new McpServer({
  name: "feishu-cursor-bridge-admin",
  version: PKG_VERSION,
  description: "飞书桥接应用管理工具",
});

registerAdminTools(mcpServer);

async function main(): Promise<void> {
  if (!process.env.LARK_DAEMON_PORT) {
    log("ERROR", "LARK_DAEMON_PORT 未配置");
    process.exit(1);
  }

  log("INFO", `feishu-cursor-bridge-admin MCP v${PKG_VERSION} 启动 (PID=${process.pid})`);

  const transport = new StdioServerTransport();
  await mcpServer.connect(transport);
  log("INFO", "Admin MCP Server 已连接 stdio ✓");

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

main().catch((e) => { log("ERROR", `admin-mcp main 异常: ${e?.message ?? e}`); });
