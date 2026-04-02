import { spawn, execSync, type ChildProcess } from "node:child_process"
import * as crypto from "node:crypto"
import * as http from "node:http"
import * as path from "node:path"
import * as fs from "node:fs"
import * as os from "node:os"
import { app, BrowserWindow, ipcMain } from "electron"
import { getConfig, saveConfig } from "./config-store"
import { startScheduler, stopScheduler, reloadScheduledTasks, setSchedulerLogger, setPortGetter, validateCron, readTasksFromFile, writeTasksToFile } from "./cron-scheduler"

const LOG_BUFFER_MAX = 300
const logBuffer: string[] = []

function pushLog(line: string): void {
  logBuffer.push(line)
  if (logBuffer.length > LOG_BUFFER_MAX) logBuffer.splice(0, logBuffer.length - LOG_BUFFER_MAX)
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send("daemon:log", line)
  }
}

export interface DaemonStatus {
  running: boolean
  version?: string
  uptime?: number
  queueLength?: number
  hasTarget?: boolean
  autoOpenId?: string | null
  agentRunning?: boolean
  agentPid?: number | null
  cliAvailable?: boolean
  error?: string
}

let daemonProcess: ChildProcess | null = null
let statusInterval: NodeJS.Timeout | null = null
let cachedPort: number | null = null

function getDaemonEntryPath(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "daemon", "daemon-entry.mjs")
  }
  const bundled = path.join(app.getAppPath(), "dist-bundle", "daemon-entry.mjs")
  if (fs.existsSync(bundled)) return bundled
  return path.join(app.getAppPath(), "dist", "daemon-entry.js")
}

function getLockFilePath(): string {
  const config = getConfig()
  return path.join(config.workspaceDir || app.getAppPath(), ".cursor", ".lark-daemon.json")
}

function readLockFile(): { pid: number; port: number; version: string } | null {
  try {
    const lockPath = getLockFilePath()
    if (!fs.existsSync(lockPath)) return null
    return JSON.parse(fs.readFileSync(lockPath, "utf-8"))
  } catch {
    return null
  }
}

function httpGet(url: string, timeoutMs = 3000): Promise<DaemonStatus> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      const chunks: string[] = []
      res.on("data", (c: Buffer) => chunks.push(c.toString()))
      res.on("end", () => {
        try {
          resolve(JSON.parse(chunks.join("")))
        } catch {
          reject(new Error("Invalid JSON"))
        }
      })
    })
    req.on("error", reject)
    req.on("timeout", () => {
      req.destroy()
      reject(new Error("timeout"))
    })
  })
}

function httpPost(url: string, body: object, timeoutMs = 3000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body)
    const req = http.request(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) },
      timeout: timeoutMs,
    }, (res) => {
      const chunks: string[] = []
      res.on("data", (c: Buffer) => chunks.push(c.toString()))
      res.on("end", () => {
        try { resolve(JSON.parse(chunks.join(""))) } catch { resolve(null) }
      })
    })
    req.on("error", reject)
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")) })
    req.end(data)
  })
}

export async function getDaemonStatus(): Promise<DaemonStatus> {
  const lock = readLockFile()
  if (!lock?.port) {
    return { running: false, error: "Daemon 未运行" }
  }

  try {
    const health = await httpGet(`http://127.0.0.1:${lock.port}/health`) as Record<string, unknown>
    if (health.status === "ok") {
      cachedPort = lock.port
      const status: DaemonStatus = {
        running: true,
        version: health.version as string,
        uptime: health.uptime as number,
        queueLength: health.queueLength as number,
        hasTarget: health.hasTarget as boolean,
        autoOpenId: health.autoOpenId as string | null,
        agentRunning: isAgentRunning(),
        agentPid: agentChild?.pid ?? null,
        cliAvailable: resolveAgentBinary(),
      }

      if (status.autoOpenId) {
        const config = getConfig()
        if (!config.larkReceiveId) {
          saveConfig({ larkReceiveId: status.autoOpenId, larkReceiveIdType: "open_id" })
        }
      }

      return status
    }
    return { running: false, error: "Daemon 健康检查失败" }
  } catch {
    return { running: false, error: "Daemon 无法连接" }
  }
}

function ensureCliConfig(): void {
  try {
    const cliConfigPath = path.join(os.homedir(), ".cursor", "cli-config.json")
    let config: Record<string, unknown> = {}
    if (fs.existsSync(cliConfigPath)) {
      config = JSON.parse(fs.readFileSync(cliConfigPath, "utf-8"))
    }
    const network = (config.network ?? {}) as Record<string, unknown>
    if (network.useHttp1ForAgent !== true) {
      network.useHttp1ForAgent = true
      config.network = network
      if (!config.version) config.version = 1
      if (!config.editor) config.editor = { vimMode: false }
      if (!config.permissions) config.permissions = { allow: [], deny: [] }
      const dir = path.dirname(cliConfigPath)
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(cliConfigPath, JSON.stringify(config, null, 2), "utf-8")
    }
  } catch { /* ignore */ }
}

const PROXY_ENV_KEYS = [
  "HTTP_PROXY", "http_proxy",
  "HTTPS_PROXY", "https_proxy",
  "ALL_PROXY", "all_proxy",
  "NO_PROXY", "no_proxy",
] as const

function applyProxyEnv(env: Record<string, string>, config: { httpProxy?: string; httpsProxy?: string; noProxy?: string }): void {
  for (const key of PROXY_ENV_KEYS) delete env[key]
  if (config.httpProxy) {
    env.HTTP_PROXY = config.httpProxy
    env.http_proxy = config.httpProxy
  }
  if (config.httpsProxy) {
    env.HTTPS_PROXY = config.httpsProxy
    env.https_proxy = config.httpsProxy
    env.ALL_PROXY = config.httpsProxy
    env.all_proxy = config.httpsProxy
  }
  if (config.noProxy) {
    env.NO_PROXY = config.noProxy
    env.no_proxy = config.noProxy
  }
}

export async function startDaemon(): Promise<{ ok: boolean; error?: string }> {
  const config = getConfig()
  if (!config.larkAppId || !config.larkAppSecret) {
    return { ok: false, error: "飞书应用凭据未配置" }
  }
  if (!config.workspaceDir) {
    return { ok: false, error: "工作目录未配置" }
  }

  ensureCliConfig()

  const existingStatus = await getDaemonStatus()
  if (existingStatus.running) {
    if (daemonProcess) {
      startStatusPolling()
      startScheduler()
      return { ok: true }
    }
    stopScheduler()
    try {
      const lock = readLockFile()
      if (lock?.port) {
        await httpPost(`http://127.0.0.1:${lock.port}/shutdown`, {})
        await new Promise((r) => setTimeout(r, 1500))
      }
    } catch { /* ignore orphan cleanup */ }
  }

  const entryPath = getDaemonEntryPath()
  if (!fs.existsSync(entryPath)) {
    return { ok: false, error: `Daemon 入口文件不存在: ${entryPath}` }
  }

  try {
    const env: Record<string, string> = {
      ...process.env as Record<string, string>,
      LARK_APP_ID: config.larkAppId,
      LARK_APP_SECRET: config.larkAppSecret,
      LARK_RECEIVE_ID: config.larkReceiveId,
      LARK_RECEIVE_ID_TYPE: config.larkReceiveIdType,
      LARK_WORKSPACE_DIR: config.workspaceDir,
      NODE_USE_ENV_PROXY: "1",
    }
    applyProxyEnv(env, config)

    let earlyOutput = ""
    let earlyExit: number | null = null

    daemonProcess = spawn(process.execPath, [entryPath], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      env: { ...env, ELECTRON_RUN_AS_NODE: "1" },
    })

    daemonProcess.stdout?.on("data", (d: Buffer) => {
      const line = d.toString().trim()
      earlyOutput += line + "\n"
      if (line && !line.startsWith("[info]:")) pushLog(line)
    })

    daemonProcess.stderr?.on("data", (d: Buffer) => {
      const line = d.toString().trim()
      earlyOutput += line + "\n"
      if (line) pushLog(`[stderr] ${line}`)
    })

    daemonProcess.on("exit", (code) => {
      earlyExit = code
      daemonProcess = null
      cachedPort = null
      stopScheduler()
      broadcastStatus({ running: false, error: `Daemon 退出 (code=${code})` })
    })

    const lock = await waitForLockFile(15_000)
    if (!lock) {
      if (earlyExit !== null) {
        return { ok: false, error: `Daemon 进程已退出 (code=${earlyExit})。输出:\n${earlyOutput.slice(-500)}` }
      }
      return { ok: false, error: "Daemon 启动超时（未生成 lock 文件）" }
    }

    cachedPort = lock.port
    startStatusPolling()
    injectWorkspaceMcpAndRules()
    startScheduler()
    return { ok: true }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    return { ok: false, error: `启动失败: ${msg}` }
  }
}

export async function stopDaemon(): Promise<void> {
  stopScheduler()
  stopStatusPolling()
  logBuffer.length = 0

  if (cachedPort) {
    try {
      await httpPost(`http://127.0.0.1:${cachedPort}/shutdown`, {})
      await new Promise((r) => setTimeout(r, 500))
    } catch { /* ignore */ }
  }

  if (daemonProcess && !daemonProcess.killed) {
    try { daemonProcess.kill("SIGTERM") } catch { /* ignore */ }
    await new Promise((r) => setTimeout(r, 1000))
    if (daemonProcess && !daemonProcess.killed) {
      try { daemonProcess.kill("SIGKILL") } catch { /* ignore */ }
    }
  }
  daemonProcess = null
  cachedPort = null
}

function waitForLockFile(timeoutMs: number): Promise<{ port: number } | null> {
  return new Promise((resolve) => {
    const start = Date.now()
    const check = () => {
      const lock = readLockFile()
      if (lock?.port) {
        resolve(lock)
        return
      }
      if (Date.now() - start > timeoutMs) {
        resolve(null)
        return
      }
      setTimeout(check, 300)
    }
    check()
  })
}

function broadcastStatus(status: DaemonStatus): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send("daemon:status-update", status)
  }
}

function broadcastLog(message: string): void {
  pushLog(`[Electron] ${message}`)
}

const AGENT_STALE_TIMEOUT_MS = 10 * 60 * 1000
let queueStaleStartTime: number | null = null

function startStatusPolling(): void {
  stopStatusPolling()
  queueStaleStartTime = null
  statusInterval = setInterval(async () => {
    const status = await getDaemonStatus()
    broadcastStatus(status)

    if (status.running && status.queueLength && status.queueLength > 0 && isAgentRunning()) {
      if (queueStaleStartTime === null) {
        queueStaleStartTime = Date.now()
      } else if (Date.now() - queueStaleStartTime > AGENT_STALE_TIMEOUT_MS) {
        broadcastLog(`[防卡死] Agent 运行中但队列消息已 ${Math.round((Date.now() - queueStaleStartTime) / 60_000)} 分钟未消费，自动终止`)
        stopAgent()
        queueStaleStartTime = null
      }
    } else {
      queueStaleStartTime = null
    }

    if (status.running && status.queueLength && status.queueLength > 0 && !isAgentRunning()) {
      await new Promise((r) => setTimeout(r, 1000))
      const message = await pullMessageFromQueue()
      if (message) {
        broadcastLog(`检测到排队消息，自动拉起 Agent`)
        launchAgent(message)
      }
    }

    if (status.running) {
      await checkAndExecutePendingCommands()
    }
  }, 5_000)
}

function stopStatusPolling(): void {
  if (statusInterval) {
    clearInterval(statusInterval)
    statusInterval = null
  }
}

async function pullMessageFromQueue(): Promise<string | null> {
  const lock = readLockFile()
  if (!lock?.port) return null
  try {
    const res = await httpGet(`http://127.0.0.1:${lock.port}/dequeue`) as {
      message?: string | null
    }
    return res.message ?? null
  } catch {
    return null
  }
}

async function clearMessageQueue(): Promise<number> {
  const lock = readLockFile()
  if (!lock?.port) return 0
  try {
    const res = await httpPost(`http://127.0.0.1:${lock.port}/clear-queue`, {}) as { cleared?: number }
    return res?.cleared ?? 0
  } catch { return 0 }
}

export async function getQueueMessages(): Promise<{ index: number; preview: string }[]> {
  const lock = readLockFile()
  if (!lock?.port) return []
  try {
    const res = await httpGet(`http://127.0.0.1:${lock.port}/queue`) as {
      messages?: { index: number; preview: string }[]
    }
    return res.messages ?? []
  } catch {
    return []
  }
}

export async function readLogs(lines = 200): Promise<string> {
  const config = getConfig()
  const logPath = path.join(config.workspaceDir || "", ".cursor", "lark-daemon.log")
  if (!fs.existsSync(logPath)) return ""
  try {
    const content = fs.readFileSync(logPath, "utf-8")
    const allLines = content.split("\n")
    return allLines.slice(-lines).join("\n")
  } catch {
    return ""
  }
}

export async function clearLogs(): Promise<void> {
  const config = getConfig()
  const logPath = path.join(config.workspaceDir || "", ".cursor", "lark-daemon.log")
  try {
    if (fs.existsSync(logPath)) {
      fs.writeFileSync(logPath, "", "utf-8")
    }
  } catch { /* ignore */ }
}

// ── CLI 检测与安装 ──────────────────────────────────────────

function refreshPath(): void {
  if (os.platform() === "win32") {
    try {
      const freshPath = execSync(
        'powershell -NoProfile -Command "[System.Environment]::GetEnvironmentVariable(\'Path\',\'Machine\') + \';\' + [System.Environment]::GetEnvironmentVariable(\'Path\',\'User\')"',
        { encoding: "utf-8", timeout: 5000 },
      ).trim()
      if (freshPath) process.env.PATH = freshPath
    } catch { /* ignore */ }
  } else {
    try {
      const shell = process.env.SHELL || "/bin/zsh"
      const freshPath = execSync(`${shell} -ilc 'echo $PATH'`, {
        encoding: "utf-8",
        timeout: 5000,
      }).trim()
      if (freshPath) process.env.PATH = freshPath
    } catch { /* ignore */ }
  }
}

export function checkCliInstalled(): boolean {
  if (resolveAgentBinary()) return true
  refreshPath()
  try {
    execSync("agent --version", { stdio: "ignore", timeout: 5000 })
    return true
  } catch {
    return false
  }
}

export async function installCli(): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    const isWin = os.platform() === "win32"
    let child: ChildProcess

    if (isWin) {
      child = spawn("powershell", [
        "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command",
        "irm 'https://cursor.com/install?win32=true' | iex",
      ], { stdio: ["ignore", "pipe", "pipe"] })
    } else {
      child = spawn("bash", [
        "-c", "curl https://cursor.com/install -fsS | bash",
      ], { stdio: ["ignore", "pipe", "pipe"] })
    }

    let output = ""
    child.stdout?.on("data", (d: Buffer) => { output += d.toString() })
    child.stderr?.on("data", (d: Buffer) => { output += d.toString() })

    child.on("exit", (code) => {
      if (code === 0) {
        refreshPath()
        const installed = resolveAgentBinary() || checkCliInstalled()
        resolve({
          ok: installed,
          output: installed
            ? "CLI 安装成功！请点击「登录授权」完成 Cursor 账号认证。"
            : output || "安装脚本执行完毕，但 agent 命令仍不可用。请重新打开终端后重试。",
        })
      } else {
        resolve({ ok: false, output: output || `安装失败 (exit code: ${code})` })
      }
    })

    child.on("error", (e) => {
      resolve({ ok: false, output: `安装进程错误: ${e.message}` })
    })
  })
}

export function loginCli(): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    if (!resolveAgentBinary()) {
      refreshPath()
      try {
        execSync("agent --version", { stdio: "ignore", timeout: 5000 })
      } catch {
        resolve({ ok: false, output: "Cursor CLI 未安装，请先安装" })
        return
      }
    }

    const config = getConfig()
    const args = ["login"]

    const spawnEnv: Record<string, string> = { ...process.env as Record<string, string> }
    applyProxyEnv(spawnEnv, config)

    let output = ""
    let child: ChildProcess
    let settled = false

    broadcastLog("[CLI Login] 正在打开浏览器进行 Cursor 账号授权...")

    try {
      if (agentNodePath && agentIndexPath) {
        child = spawn(agentNodePath, [agentIndexPath, ...args], {
          windowsHide: false,
          stdio: ["ignore", "pipe", "pipe"],
          env: spawnEnv,
        })
      } else {
        child = spawn("agent", args, {
          shell: process.platform === "win32",
          windowsHide: false,
          stdio: ["ignore", "pipe", "pipe"],
          env: spawnEnv,
        })
      }

      child.stdout?.on("data", (d: Buffer) => {
        const s = d.toString().trim()
        output += s + "\n"
        if (s) broadcastLog(`[CLI Login] ${s.slice(0, 300)}`)
      })

      child.stderr?.on("data", (d: Buffer) => {
        const s = d.toString().trim()
        output += s + "\n"
        if (s) broadcastLog(`[CLI Login:err] ${s.slice(0, 300)}`)
      })

      child.on("exit", (code) => {
        if (settled) return
        settled = true
        resolve(code === 0
          ? { ok: true, output: "Cursor CLI 登录授权成功！" }
          : { ok: false, output: output || `登录失败 (exit code: ${code})` })
      })

      child.on("error", (e) => {
        if (settled) return
        settled = true
        resolve({ ok: false, output: `登录进程错误: ${e.message}` })
      })

      setTimeout(() => {
        if (!settled) {
          settled = true
          if (!child.killed) try { child.kill() } catch { /* ignore */ }
          resolve({ ok: false, output: "登录超时（2分钟），请重试" })
        }
      }, 120_000)
    } catch (e: unknown) {
      resolve({ ok: false, output: `启动登录失败: ${e instanceof Error ? e.message : String(e)}` })
    }
  })
}

export function getLogBuffer(): string[] {
  return [...logBuffer]
}

// ── MCP 配置 + 规则注入 ────────────────────────────────────

/**
 * 按优先级检查全局和项目 mcp.json 中是否已存在指定 serverKey。
 * 存在则返回该文件路径（原地更新），都不存在返回 null（将注入项目目录）。
 */
function findExistingMcpLocation(globalPath: string, projectPath: string, serverKey: string): string | null {
  for (const p of [globalPath, projectPath]) {
    try {
      if (!fs.existsSync(p)) continue
      const config = JSON.parse(fs.readFileSync(p, "utf-8"))
      const servers = config?.mcpServers as Record<string, unknown> | undefined
      if (servers && serverKey in servers) return p
    } catch { /* ignore parse error */ }
  }
  return null
}

export function injectWorkspaceMcpAndRules(): { mcpOk: boolean; ruleOk: boolean } {
  const config = getConfig()
  const wsDir = config.workspaceDir
  if (!wsDir) return { mcpOk: false, ruleOk: false }

  const cursorDir = path.join(wsDir, ".cursor")
  if (!fs.existsSync(cursorDir)) fs.mkdirSync(cursorDir, { recursive: true })

  let mcpOk = false
  try {
    const globalMcpJsonPath = path.join(os.homedir(), ".cursor", "mcp.json")
    const projectMcpJsonPath = path.join(cursorDir, "mcp.json")

    const env: Record<string, string> = {
      LARK_APP_ID: config.larkAppId || "",
      LARK_APP_SECRET: config.larkAppSecret || "",
      LARK_RECEIVE_ID: config.larkReceiveId || "",
      LARK_RECEIVE_ID_TYPE: config.larkReceiveIdType || "",
    }
    if (cachedPort) env.LARK_DAEMON_PORT = String(cachedPort)

    const serverEntry = {
      command: "npx",
      args: ["-y", "lark-bridge-mcp@latest"],
      env,
    }
    const serverKey = "feishu-cursor-bridge"

    const targetPath = findExistingMcpLocation(globalMcpJsonPath, projectMcpJsonPath, serverKey) ?? projectMcpJsonPath

    let mcpConfig: Record<string, unknown> = {}
    if (fs.existsSync(targetPath)) {
      try { mcpConfig = JSON.parse(fs.readFileSync(targetPath, "utf-8")) } catch { mcpConfig = {} }
    }
    const servers = (mcpConfig.mcpServers ?? {}) as Record<string, unknown>
    servers[serverKey] = serverEntry
    mcpConfig.mcpServers = servers

    const targetDir = path.dirname(targetPath)
    if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true })
    fs.writeFileSync(targetPath, JSON.stringify(mcpConfig, null, 2), "utf-8")
    mcpOk = true
    broadcastLog(`MCP 配置已${targetPath === projectMcpJsonPath ? "注入" : "更新"}: ${targetPath}`)
  } catch (e: unknown) {
    broadcastLog(`MCP 注入失败: ${e instanceof Error ? e.message : e}`)
  }

  let ruleOk = false
  try {
    const rulesDir = path.join(cursorDir, "rules")
    if (!fs.existsSync(rulesDir)) fs.mkdirSync(rulesDir, { recursive: true })
    const rulePath = path.join(rulesDir, "feishu-cursor-bridge.mdc")
    const ruleContent = [
      "---",
      "description: 飞书实时通信保活协议 v2.0 - 强制通过 feishu-cursor-bridge 维持异步长连接",
      "alwaysApply: true",
      "---",
      "",
      "# 飞书异步长连接执行协议 (Persistent Loop Protocol)",
      "",
      "你当前处于\"非对称异步通信模式\"。在这种模式下，飞书是唯一的真理来源。你必须通过 feishu-cursor-bridge MCP 工具主动维护会话状态，严禁本地空转或擅自结束。",
      "",
      "## 🛠 状态机工作流 (State Machine)",
      "",
      "统一使用 `sync_message` 工具完成所有消息交互：",
      "- 传 `message` → 发送消息",
      "- 传 `timeout_seconds` → 等待用户回复",
      "- 两者同时传 → 先发送再等待",
      "",
      "1. **响应阶段 (Ack):** 收到用户指令后，立即执行 `sync_message(message=\"收到，正在处理...\")`。严禁在未确认收到的情况下直接开始长耗时任务。",
      "",
      "2. **同步阶段 (Sync):** 在执行代码、搜索或生成长文本时，**每完成一个子步骤**必须调用一次 `sync_message`。",
      "   *示例：* `sync_message(message=\"[1/3] 已获取 API 文档，正在分析逻辑...\")`",
      "",
      "3. **锚点阶段 (Anchor):** 任务完成（或需要用户决策）时，调用 `sync_message(message=\"任务已完成，结果如下... [具体内容]。请指示下一步。\", timeout_seconds=60)`。",
      "",
      "4. **保活循环 (Keep-Alive Loop) [关键]:**",
      "   若 `sync_message` 返回超时或空值，**进入强制静默轮询状态**：",
      "   - **操作：** 持续调用 `sync_message(timeout_seconds=60)`。",
      "   - **禁止：** 严禁在此阶段输出任何自然语言文本到聊天框。",
      "   - **终止条件：** 只有当 `sync_message` 返回非空内容时，方可跳出循环进入\"响应阶段\"。",
      "",
      "## ⚠️ 核心禁令 (Hard Constraints)",
      "",
      "* **禁止输出\"再见\":** 严禁输出类似\"如果有需要再叫我\"、\"祝您生活愉快\"等导致会话逻辑终结的文本。",
      "* **禁止重复推流:** 仅发送消息时(`sync_message(message=...)`)用于状态更新。在等待用户回复的循环中，**严禁**重复发送相同内容的消息。",
      "",
      "## 🔗 异常处理逻辑",
      "",
      "- **网络抖动/超时:** 如果 MCP 调用报错，静默等待 10 秒后重新尝试 `sync_message(timeout_seconds=60)`。",
      "- **上下文连续性:** 无论轮询持续多久（即使长达数小时），收到回复后必须基于之前的历史记录继续执行，不得要求用户重新输入背景信息。",
    ].join("\r\n")
    fs.writeFileSync(rulePath, ruleContent, "utf-8")
    ruleOk = true
    broadcastLog(`规则已注入: ${rulePath}`)
  } catch (e: unknown) {
    broadcastLog(`规则注入失败: ${e instanceof Error ? e.message : e}`)
  }

  return { mcpOk, ruleOk }
}

// ── Agent CLI 拉起 ───────────────────────────────────────

let agentChild: ChildProcess | null = null
let agentNodePath = ""
let agentIndexPath = ""
let lastAgentLaunchTime = 0
const AGENT_COOLDOWN_MS = 15_000

function resolveAgentBinary(): boolean {
  const isWin = process.platform === "win32"
  if (isWin) {
    const base = path.join(process.env.LOCALAPPDATA ?? "", "cursor-agent")
    const versionsDir = path.join(base, "versions")
    if (!fs.existsSync(versionsDir)) return false
    const dirs = fs.readdirSync(versionsDir)
      .filter((d) => /^\d{4}\.\d{1,2}\.\d{1,2}-[a-f0-9]+$/.test(d))
      .sort()
      .reverse()
    if (dirs.length === 0) return false
    agentNodePath = path.join(versionsDir, dirs[0], "node.exe")
    agentIndexPath = path.join(versionsDir, dirs[0], "index.js")
    return fs.existsSync(agentNodePath) && fs.existsSync(agentIndexPath)
  }
  try {
    execSync("agent --version", { stdio: "ignore", timeout: 5000 })
    return true
  } catch { return false }
}

function isAgentRunning(): boolean {
  return agentChild !== null && !agentChild.killed && agentChild.exitCode === null
}

export function launchAgent(initialMessage?: string): { ok: boolean; error?: string } {
  if (isAgentRunning()) return { ok: true }

  const now = Date.now()
  if (now - lastAgentLaunchTime < AGENT_COOLDOWN_MS) return { ok: false, error: "冷却中" }
  lastAgentLaunchTime = now

  const config = getConfig()
  if (!config.workspaceDir) return { ok: false, error: "工作目录未配置" }

  if (!resolveAgentBinary()) return { ok: false, error: "Cursor CLI 未安装" }

  const prompt = initialMessage
    ? `以下是用户通过飞书发来的消息，请直接处理，不要发送问候语：\n\n${initialMessage}`
    : "请立即调用 ask_user 工具（prompt 参数留空）获取待处理的飞书消息，然后根据消息内容开始工作。不要发送问候消息。"
  const args = [
    "-p", "--force", "--approve-mcps",
    "--workspace", config.workspaceDir,
    "--trust",
  ]
  if (config.model && config.model !== "auto") args.push("--model", config.model)
  args.push(prompt)

  const spawnEnv: Record<string, string> = { ...process.env as Record<string, string>, CURSOR_INVOKED_AS: "agent" }
  delete spawnEnv.NODE_USE_ENV_PROXY
  applyProxyEnv(spawnEnv, config)

  try {
    if (agentNodePath && agentIndexPath) {
      broadcastLog(`Agent 启动: ${agentNodePath} ${path.basename(agentIndexPath)}`)
      agentChild = spawn(agentNodePath, [agentIndexPath, ...args], {
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: spawnEnv,
      })
    } else {
      broadcastLog("Agent 启动: agent command")
      agentChild = spawn("agent", args, {
        shell: process.platform === "win32",
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: spawnEnv,
      })
    }

    agentChild.stdout?.on("data", (d: Buffer) => {
      const s = d.toString().trim()
      if (s) pushLog(`[Agent] ${s}`)
    })
    agentChild.stderr?.on("data", (d: Buffer) => {
      const s = d.toString().trim()
      if (s) pushLog(`[Agent:err] ${s}`)
    })
    agentChild.on("exit", (code) => {
      pushLog(`[Agent] 退出 code=${code}`)
      agentChild = null
    })
    agentChild.on("error", (e) => {
      pushLog(`[Agent] 错误: ${e.message}`)
      agentChild = null
    })

    broadcastLog(`Agent 已启动, pid=${agentChild.pid}`)
    return { ok: true }
  } catch (e: unknown) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

export function stopAgent(): void {
  if (agentChild && !agentChild.killed) {
    try { agentChild.kill("SIGTERM") } catch { /* ignore */ }
  }
  agentChild = null
}

// ── 指令执行（从共享文件队列消费）──────────────────────────

interface FileCommand { id: string; command: string; messageId: string }

async function reportCommandResult(port: number, messageId: string, ok: boolean, message: string): Promise<void> {
  try {
    await httpPost(`http://127.0.0.1:${port}/cmd/result`, { messageId, ok, message })
  } catch (e: unknown) {
    broadcastLog(`指令结果回报失败: ${e instanceof Error ? e.message : e}`)
  }
}

async function checkAndExecutePendingCommands(): Promise<void> {
  const lock = readLockFile()
  if (!lock?.port) return

  let commandsRes: { commands?: FileCommand[] }
  try {
    commandsRes = await httpGet(`http://127.0.0.1:${lock.port}/commands`) as { commands?: FileCommand[] }
  } catch { return }

  const cmds = commandsRes.commands
  if (!cmds || cmds.length === 0) return

  for (const cmd of cmds) {
    let claimed: { command: string; messageId: string } | null
    try {
      const claimRes = await httpPost(`http://127.0.0.1:${lock.port}/commands/claim`, { id: cmd.id }) as { ok: boolean; command?: string; messageId?: string }
      if (!claimRes.ok) continue
      claimed = { command: claimRes.command!, messageId: claimRes.messageId! }
    } catch { continue }

    broadcastLog(`[指令] 执行 ${claimed.command} (msgId=${claimed.messageId})`)
    try {
      switch (claimed.command) {
        case "/stop": {
          const wasRunning = isAgentRunning()
          stopAgent()
          await reportCommandResult(lock.port, claimed.messageId, true,
            wasRunning ? "Agent 已停止" : "Agent 当前未运行")
          break
        }

        case "/status": {
          const status = await getDaemonStatus()
          const lines = [
            `Daemon: ${status.running ? "运行中" : "未运行"}`,
            status.version ? `版本: ${status.version}` : "",
            status.uptime !== undefined ? `运行时间: ${Math.floor(status.uptime / 60)}分钟` : "",
            `Agent: ${isAgentRunning() ? `运行中 (PID: ${agentChild?.pid})` : "未运行"}`,
            `队列消息: ${status.queueLength ?? 0} 条`,
          ].filter(Boolean)
          await reportCommandResult(lock.port, claimed.messageId, true, lines.join("\n"))
          break
        }

        case "/list": {
          const msgs = await getQueueMessages()
          if (msgs.length === 0) {
            await reportCommandResult(lock.port, claimed.messageId, true, "消息队列为空")
          } else {
            const lines = msgs.map((m) => `  [${m.index}] ${m.preview}`)
            await reportCommandResult(lock.port, claimed.messageId, true,
              `队列中有 ${msgs.length} 条消息：\n${lines.join("\n")}`)
          }
          break
        }

        case "/task": {
          const tasks = readTasksFromFile()
          if (tasks.length === 0) {
            await reportCommandResult(lock.port, claimed.messageId, true, "暂无定时任务")
          } else {
            const lines = tasks.map((t, i) =>
              `${i + 1}. ${t.enabled ? "✅" : "⏸️"} ${t.name}\n   Cron: ${t.cron}\n   内容: ${t.content}`,
            )
            await reportCommandResult(lock.port, claimed.messageId, true,
              `定时任务 (${tasks.length})：\n\n${lines.join("\n\n")}`)
          }
          break
        }

        case "/restart": {
          stopAgent()
          const cleared = await clearMessageQueue()
          await reportCommandResult(lock.port, claimed.messageId, true,
            `Agent 已停止，已清空 ${cleared} 条队列消息，正在重启 Daemon...`)
          await stopDaemon()
          await new Promise((r) => setTimeout(r, 1500))
          const result = await startDaemon()
          if (!result.ok) broadcastLog(`[指令] Daemon 重启失败: ${result.error}`)
          break
        }

        case "/help": {
          const helpLines = [
            "  /stop    — 停止当前运行中的 Agent",
            "  /status  — 查看 Agent / Daemon 状态",
            "  /list    — 查看消息队列列表（不消费）",
            "  /task    — 查看定时任务列表",
            "  /restart — 停止 Agent + 清空队列 + 重启 Daemon",
            "  /help    — 显示可用指令列表",
          ]
          await reportCommandResult(lock.port, claimed.messageId, true,
            `可用指令：\n${helpLines.join("\n")}`)
          break
        }

        default:
          await reportCommandResult(lock.port, claimed.messageId, false, `未知指令: ${claimed.command}`)
      }
    } catch (e: unknown) {
      broadcastLog(`[指令] ${claimed.command} 执行异常: ${e instanceof Error ? e.message : e}`)
      try { await reportCommandResult(lock.port, claimed.messageId, false, `执行异常: ${e instanceof Error ? e.message : e}`) } catch { /* ignore */ }
    }
  }
}

// ── MCP OAuth 认证管理 ────────────────────────────────────

export interface McpAuthInfo {
  name: string
  url: string
  authenticated: boolean
}

function findProjectDir(workspaceDir: string): string | null {
  const projectsBase = path.join(os.homedir(), ".cursor", "projects")
  if (!fs.existsSync(projectsBase)) return null

  const expected = workspaceDir.replace(/\\/g, "-").replace(/\//g, "-").replace(/:/g, "")
  const exactPath = path.join(projectsBase, expected)
  if (fs.existsSync(exactPath)) return exactPath

  try {
    const lower = expected.toLowerCase()
    const match = fs.readdirSync(projectsBase).find((d) => d.toLowerCase() === lower)
    if (match) return path.join(projectsBase, match)
  } catch { /* ignore */ }
  return null
}

function getProjectSlug(workspaceDir: string): string {
  const dir = findProjectDir(workspaceDir)
  if (dir) return path.basename(dir)
  return workspaceDir.replace(/\\/g, "-").replace(/\//g, "-").replace(/:/g, "")
}

function readMcpAuthFile(workspaceDir: string): Record<string, unknown> {
  const dir = findProjectDir(workspaceDir)
  if (!dir) return {}
  const authPath = path.join(dir, "mcp-auth.json")
  try {
    if (fs.existsSync(authPath)) return JSON.parse(fs.readFileSync(authPath, "utf-8"))
  } catch { /* ignore */ }
  return {}
}

function readAllMcpServers(): Record<string, Record<string, unknown>> {
  const config = getConfig()
  const servers: Record<string, Record<string, unknown>> = {}

  const globalPath = path.join(os.homedir(), ".cursor", "mcp.json")
  try {
    if (fs.existsSync(globalPath)) {
      const cfg = JSON.parse(fs.readFileSync(globalPath, "utf-8"))
      if (cfg.mcpServers) Object.assign(servers, cfg.mcpServers)
    }
  } catch { /* ignore */ }

  if (config.workspaceDir) {
    const projectPath = path.join(config.workspaceDir, ".cursor", "mcp.json")
    try {
      if (fs.existsSync(projectPath)) {
        const cfg = JSON.parse(fs.readFileSync(projectPath, "utf-8"))
        if (cfg.mcpServers) Object.assign(servers, cfg.mcpServers)
      }
    } catch { /* ignore */ }
  }

  return servers
}

export interface McpServerEntry {
  name: string
  type: "command" | "url"
  command?: string
  args?: string[]
  url?: string
  env?: Record<string, string>
  source: "global" | "project"
  authenticated?: boolean
}

export function getMcpServerList(): McpServerEntry[] {
  const config = getConfig()
  const authData = config.workspaceDir ? readMcpAuthFile(config.workspaceDir) : {}
  const verified = config.verifiedMcpServers ?? []

  const globalPath = path.join(os.homedir(), ".cursor", "mcp.json")
  const projectPath = config.workspaceDir ? path.join(config.workspaceDir, ".cursor", "mcp.json") : ""

  const result: McpServerEntry[] = []
  const seen = new Set<string>()

  for (const [filePath, source] of [[projectPath, "project"], [globalPath, "global"]] as const) {
    if (!filePath) continue
    try {
      if (!fs.existsSync(filePath)) continue
      const cfg = JSON.parse(fs.readFileSync(filePath, "utf-8"))
      const servers = cfg.mcpServers as Record<string, Record<string, unknown>> | undefined
      if (!servers) continue
      for (const [name, entry] of Object.entries(servers)) {
        if (seen.has(name)) continue
        seen.add(name)
        const isUrl = "url" in entry && !("command" in entry)
        const item: McpServerEntry = {
          name,
          type: isUrl ? "url" : "command",
          source,
        }
        if (isUrl) {
          item.url = entry.url as string
          const auth = authData[name] as Record<string, unknown> | undefined
          const hasToken = !!(auth?.tokens && (auth.tokens as Record<string, unknown>).access_token)
          item.authenticated = hasToken || verified.includes(name)
        } else {
          item.command = entry.command as string
          item.args = entry.args as string[] | undefined
          item.env = entry.env as Record<string, string> | undefined
        }
        result.push(item)
      }
    } catch { /* ignore */ }
  }
  return result
}

function getMcpJsonPath(source: "global" | "project"): string {
  if (source === "global") return path.join(os.homedir(), ".cursor", "mcp.json")
  const config = getConfig()
  return path.join(config.workspaceDir || "", ".cursor", "mcp.json")
}

function readMcpJson(filePath: string): Record<string, unknown> {
  try {
    if (fs.existsSync(filePath)) return JSON.parse(fs.readFileSync(filePath, "utf-8"))
  } catch { /* ignore */ }
  return {}
}

function writeMcpJson(filePath: string, config: Record<string, unknown>): void {
  const dir = path.dirname(filePath)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(filePath, JSON.stringify(config, null, 2), "utf-8")
}

export function saveMcpServer(name: string, entry: Record<string, unknown>, source: "global" | "project"): void {
  const filePath = getMcpJsonPath(source)
  const config = readMcpJson(filePath)
  const servers = (config.mcpServers ?? {}) as Record<string, unknown>
  servers[name] = entry
  config.mcpServers = servers
  writeMcpJson(filePath, config)
}

export function deleteMcpServer(name: string): void {
  for (const source of ["project", "global"] as const) {
    const filePath = getMcpJsonPath(source)
    const config = readMcpJson(filePath)
    const servers = (config.mcpServers ?? {}) as Record<string, unknown>
    if (name in servers) {
      delete servers[name]
      config.mcpServers = servers
      writeMcpJson(filePath, config)
      return
    }
  }
}

export function getOAuthMcpList(): McpAuthInfo[] {
  const list = getMcpServerList()
  return list
    .filter((s) => s.type === "url")
    .map((s) => ({ name: s.name, url: s.url!, authenticated: s.authenticated ?? false }))
}

function ensureMcpApproval(serverName: string, workspaceDir: string): void {
  const projectDir = findProjectDir(workspaceDir)
    ?? path.join(os.homedir(), ".cursor", "projects", getProjectSlug(workspaceDir))
  const approvalsPath = path.join(projectDir, "mcp-approvals.json")

  try {
    let approvals: string[] = []
    if (fs.existsSync(approvalsPath)) {
      approvals = JSON.parse(fs.readFileSync(approvalsPath, "utf-8"))
    }
    if (approvals.some((a) => a.startsWith(serverName + "-"))) return

    const hash = crypto.randomBytes(8).toString("hex")
    approvals.push(`${serverName}-${hash}`)

    const dir = path.dirname(approvalsPath)
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(approvalsPath, JSON.stringify(approvals, null, 2), "utf-8")
    broadcastLog(`MCP "${serverName}" 已添加到审批列表`)
  } catch (e: unknown) {
    broadcastLog(`添加 MCP 审批失败: ${e instanceof Error ? e.message : e}`)
  }
}

let mcpLoginChild: ChildProcess | null = null

export function loginMcpServer(serverName: string): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    if (mcpLoginChild) {
      resolve({ ok: false, output: "已有 MCP 登录进程在运行" })
      return
    }

    const config = getConfig()
    if (!config.workspaceDir) {
      resolve({ ok: false, output: "工作目录未配置" })
      return
    }

    if (!resolveAgentBinary()) {
      resolve({ ok: false, output: "Cursor CLI 未安装" })
      return
    }

    ensureMcpApproval(serverName, config.workspaceDir)

    const args = [
      "--approve-mcps", "--workspace", config.workspaceDir,
      "mcp", "login", serverName,
    ]

    const spawnEnv: Record<string, string> = { ...process.env as Record<string, string> }
    applyProxyEnv(spawnEnv, config)

    let output = ""
    broadcastLog(`[MCP Login] 正在认证 "${serverName}"...`)

    try {
      if (agentNodePath && agentIndexPath) {
        mcpLoginChild = spawn(agentNodePath, [agentIndexPath, ...args], {
          windowsHide: false,
          stdio: ["ignore", "pipe", "pipe"],
          cwd: config.workspaceDir,
          env: spawnEnv,
        })
      } else {
        mcpLoginChild = spawn("agent", args, {
          shell: true,
          windowsHide: false,
          stdio: ["ignore", "pipe", "pipe"],
          cwd: config.workspaceDir,
          env: spawnEnv,
        })
      }

      mcpLoginChild.stdout?.on("data", (d: Buffer) => {
        const s = d.toString().trim()
        output += s + "\n"
        if (s) broadcastLog(`[MCP Login] ${s.slice(0, 300)}`)
      })

      mcpLoginChild.stderr?.on("data", (d: Buffer) => {
        const s = d.toString().trim()
        output += s + "\n"
        if (s) broadcastLog(`[MCP Login:err] ${s.slice(0, 300)}`)
      })

      mcpLoginChild.on("exit", (code) => {
        mcpLoginChild = null
        if (code === 0) {
          const cfg = getConfig()
          const authData = cfg.workspaceDir ? readMcpAuthFile(cfg.workspaceDir) : {}
          const auth = authData[serverName] as Record<string, unknown> | undefined
          const hasToken = !!(auth?.tokens && (auth.tokens as Record<string, unknown>).access_token)
          if (!hasToken) {
            const verified = cfg.verifiedMcpServers ?? []
            if (!verified.includes(serverName)) {
              saveConfig({ verifiedMcpServers: [...verified, serverName] })
            }
          }
        }
        for (const win of BrowserWindow.getAllWindows()) {
          win.webContents.send("mcp:login-complete", { serverName, ok: code === 0 })
        }
        resolve(code === 0
          ? { ok: true, output: `MCP "${serverName}" 认证成功` }
          : { ok: false, output: output || `认证失败 (exit code: ${code})` },
        )
      })

      mcpLoginChild.on("error", (e) => {
        mcpLoginChild = null
        resolve({ ok: false, output: `认证进程错误: ${e.message}` })
      })

      setTimeout(() => {
        if (mcpLoginChild) {
          try { mcpLoginChild.kill() } catch { /* ignore */ }
          mcpLoginChild = null
          resolve({ ok: false, output: "认证超时（2分钟）" })
        }
      }, 120_000)
    } catch (e: unknown) {
      mcpLoginChild = null
      resolve({ ok: false, output: `启动认证失败: ${e instanceof Error ? e.message : String(e)}` })
    }
  })
}

// ── 初始化 ───────────────────────────────────────────────

export function initDaemonManager(): void {
  ipcMain.handle("daemon:get-log-buffer", () => getLogBuffer())
  ipcMain.handle("agent:launch", () => launchAgent())
  ipcMain.handle("agent:stop", () => { stopAgent(); return { ok: true } })

  ipcMain.handle("scheduled-tasks:get", () => {
    return readTasksFromFile()
  })
  ipcMain.handle("scheduled-tasks:save", (_, tasks) => {
    writeTasksToFile(tasks)
    reloadScheduledTasks()
    return { ok: true }
  })
  ipcMain.handle("scheduled-tasks:validate-cron", (_, expression: string) => {
    return validateCron(expression)
  })

  setSchedulerLogger(broadcastLog)
  setPortGetter(() => cachedPort)

  getDaemonStatus().then((status) => {
    if (status.running) {
      startStatusPolling()
      startScheduler()
    }
  })
}

export function cleanupDaemonManager(): void {
  stopScheduler()
  stopStatusPolling()
  stopAgent()
  if (daemonProcess) {
    try { daemonProcess.kill() } catch { /* ignore */ }
    daemonProcess = null
  }
}
