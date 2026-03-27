import { spawn, execSync, type ChildProcess } from "node:child_process"
import * as http from "node:http"
import * as path from "node:path"
import * as fs from "node:fs"
import * as os from "node:os"
import { app, BrowserWindow, ipcMain } from "electron"
import { getConfig, saveConfig } from "./config-store"
import { startScheduler, stopScheduler, reloadScheduledTasks, setSchedulerLogger, setPortGetter, validateCron } from "./cron-scheduler"

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

export async function startDaemon(): Promise<{ ok: boolean; error?: string }> {
  const config = getConfig()
  if (!config.larkAppId || !config.larkAppSecret) {
    return { ok: false, error: "飞书应用凭据未配置" }
  }
  if (!config.workspaceDir) {
    return { ok: false, error: "工作目录未配置" }
  }

  ensureCliConfig()

  stopScheduler()

  const existingStatus = await getDaemonStatus()
  if (existingStatus.running) {
    if (daemonProcess) {
      startStatusPolling()
      startScheduler()
      return { ok: true }
    }
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

function startStatusPolling(): void {
  stopStatusPolling()
  statusInterval = setInterval(async () => {
    const status = await getDaemonStatus()
    broadcastStatus(status)
    if (status.running && status.queueLength && status.queueLength > 0 && !isAgentRunning()) {
      const message = await pullMessageFromQueue()
      if (message) {
        broadcastLog(`检测到排队消息，自动拉起 Agent`)
        launchAgent(message)
      }
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
  }
}

export function checkCliInstalled(): boolean {
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
        const installed = checkCliInstalled()
        resolve({
          ok: installed,
          output: installed
            ? "CLI 安装成功！"
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

export function getLogBuffer(): string[] {
  return [...logBuffer]
}

// ── MCP 配置 + 规则注入 ────────────────────────────────────

function getLiteMcpEntryPath(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "lite", "dist", "index.js")
  }
  return path.join(app.getAppPath(), "lite", "dist", "index.js")
}

export function injectWorkspaceMcpAndRules(): { mcpOk: boolean; ruleOk: boolean } {
  const config = getConfig()
  const wsDir = config.workspaceDir
  if (!wsDir) return { mcpOk: false, ruleOk: false }

  const cursorDir = path.join(wsDir, ".cursor")
  if (!fs.existsSync(cursorDir)) fs.mkdirSync(cursorDir, { recursive: true })

  let mcpOk = false
  try {
    const mcpJsonPath = path.join(cursorDir, "mcp.json")
    let mcpConfig: Record<string, unknown> = {}
    if (fs.existsSync(mcpJsonPath)) {
      try { mcpConfig = JSON.parse(fs.readFileSync(mcpJsonPath, "utf-8")) } catch { mcpConfig = {} }
    }
    const servers = (mcpConfig.mcpServers ?? {}) as Record<string, unknown>
    const entryPath = getLiteMcpEntryPath()

    const env: Record<string, string> = {
      LARK_APP_ID: config.larkAppId || "",
      LARK_APP_SECRET: config.larkAppSecret || "",
      LARK_RECEIVE_ID: config.larkReceiveId || "",
      LARK_RECEIVE_ID_TYPE: config.larkReceiveIdType || "",
      LARK_WORKSPACE_DIR: wsDir,
    }
    if (cachedPort) env.LARK_DAEMON_PORT = String(cachedPort)

    servers["feishu-cursor-bridge"] = {
      command: "node",
      args: [entryPath],
      env,
    }
    mcpConfig.mcpServers = servers
    fs.writeFileSync(mcpJsonPath, JSON.stringify(mcpConfig, null, 2), "utf-8")
    mcpOk = true
    broadcastLog(`MCP 配置已注入: ${mcpJsonPath}`)
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
  if (config.httpProxy) {
    spawnEnv.HTTP_PROXY = config.httpProxy
    spawnEnv.http_proxy = config.httpProxy
  }
  if (config.httpsProxy) {
    spawnEnv.HTTPS_PROXY = config.httpsProxy
    spawnEnv.https_proxy = config.httpsProxy
    spawnEnv.ALL_PROXY = config.httpsProxy
    spawnEnv.all_proxy = config.httpsProxy
  }
  if (config.noProxy) {
    spawnEnv.NO_PROXY = config.noProxy
    spawnEnv.no_proxy = config.noProxy
  }

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
        shell: true,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: spawnEnv,
      })
    }

    agentChild.stdout?.on("data", (d: Buffer) => {
      const s = d.toString().trim()
      if (s) pushLog(`[Agent] ${s.slice(0, 300)}`)
    })
    agentChild.stderr?.on("data", (d: Buffer) => {
      const s = d.toString().trim()
      if (s) pushLog(`[Agent:err] ${s.slice(0, 300)}`)
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

// ── 初始化 ───────────────────────────────────────────────

export function initDaemonManager(): void {
  ipcMain.handle("daemon:get-log-buffer", () => getLogBuffer())
  ipcMain.handle("agent:launch", () => launchAgent())
  ipcMain.handle("agent:stop", () => { stopAgent(); return { ok: true } })
  ipcMain.handle("workspace:inject", () => injectWorkspaceMcpAndRules())

  ipcMain.handle("scheduled-tasks:get", () => {
    return getConfig().scheduledTasks ?? []
  })
  ipcMain.handle("scheduled-tasks:save", (_, tasks) => {
    saveConfig({ scheduledTasks: tasks })
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
