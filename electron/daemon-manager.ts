import { spawn, spawnSync, execSync, exec, type ChildProcess } from "node:child_process"
import { randomUUID } from "node:crypto"
import * as http from "node:http"
import * as path from "node:path"
import * as fs from "node:fs"
import * as os from "node:os"
import { promisify } from "node:util"
import { app, BrowserWindow, ipcMain, powerSaveBlocker } from "electron"
import { getConfig, saveConfig, type AppConfig, type ScheduledTask } from "./config-store"
import { validateCron, readTasksFromFile, writeTasksToFile, previewCronNextRuns, getNextCronFireLabel } from "./cron-scheduler"

const execAsync = promisify(exec)

const LOG_BUFFER_MAX = 300
const logBuffer: string[] = []

function uiTimestamp(): string {
  const d = new Date()
  const p2 = (n: number) => String(n).padStart(2, "0")
  const p3 = (n: number) => String(n).padStart(3, "0")
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}.${p3(d.getMilliseconds())}`
}

/** 单行日志：换行写成字面量 \n，避免打断一行一条记录 */
function escapeLogContentSingleLine(s: string): string {
  return s.replace(/\r?\n/g, "\\n")
}

/** 统一 UI 日志：时间戳 [进程] 等级 内容（空格分隔） */
function formatUnifiedUiLog(processName: string, level: string, content: string): string {
  return `${uiTimestamp()} [${processName}] ${level} ${escapeLogContentSingleLine(content)}`
}

function pushLog(line: string): void {
  logBuffer.push(line)
  if (logBuffer.length > LOG_BUFFER_MAX) logBuffer.splice(0, logBuffer.length - LOG_BUFFER_MAX)
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send("daemon:log", line)
  }
}

function pushUiLog(processName: string, level: string, content: string): void {
  pushLog(formatUnifiedUiLog(processName, level, content))
}

/** 与 daemon stderr 当前格式一致：`时间戳 [LarkDaemon] 等级 内容` */
const UNIFIED_LARK_DAEMON_PREFIX = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}\.\d{3} \[LarkDaemon\] /

/** 旧版逗号分隔：`时间戳,LarkDaemon,等级,内容` */
const LEGACY_COMMA_DAEMON = /^(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}\.\d{3}),LarkDaemon,(INFO|WARN|ERROR|DEBUG),(.+)$/

function normalizeUnifiedDaemonLine(s: string): string {
  return s.replace(/^(\d{4}-\d{2}-\d{2})T(\d{2}:)/, "$1 $2")
}

function pushDaemonStderrLine(rawLine: string): void {
  const t = rawLine.trim()
  if (!t) return
  if (UNIFIED_LARK_DAEMON_PREFIX.test(t)) {
    pushLog(normalizeUnifiedDaemonLine(t))
    return
  }
  const legacyComma = t.match(LEGACY_COMMA_DAEMON)
  if (legacyComma) {
    const ts = legacyComma[1].replace("T", " ")
    pushLog(`${ts} [LarkDaemon] ${legacyComma[2]} ${legacyComma[3]}`)
    return
  }
  const legacy = t.match(/^\[LarkDaemon\]\[([^\]]+)\]\[([^\]]+)\]\s*(.*)$/)
  if (legacy) {
    const ts = legacy[1].replace("T", " ")
    pushLog(`${ts} [LarkDaemon] ${legacy[2]} ${escapeLogContentSingleLine(legacy[3])}`)
    return
  }
  pushUiLog("LarkDaemon", "WARN", t)
}

function flushAgentStreamChunk(
  bufRef: { current: string },
  chunk: string,
  stream: "stdout" | "stderr",
): void {
  bufRef.current += chunk
  const parts = bufRef.current.split(/\r?\n/)
  bufRef.current = parts.pop() ?? ""
  const level = stream === "stderr" ? "WARN" : "INFO"
  for (const raw of parts) {
    const line = raw.trim()
    if (line) pushUiLog("Agent", level, line)
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
  /** 配置中的工作目录与当前仍在运行的 Daemon 实例不一致 */
  workspaceMismatch?: boolean
  /** 当前 Daemon 实际使用的工作目录（与设置不一致时有值） */
  daemonWorkspaceDir?: string
}

let daemonProcess: ChildProcess | null = null
let statusInterval: NodeJS.Timeout | null = null
let cachedPort: number | null = null
/** 本次由本应用启动成功时 Daemon 所绑定的工作目录（用于目录切换后的状态判断） */
let activeDaemonWorkspaceDir: string | null = null

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
  const config = getConfig()
  const cfgWs = (config.workspaceDir || "").trim()

  const statusFromHealth = (port: number, health: Record<string, unknown>): DaemonStatus => {
    cachedPort = port
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
    if (status.autoOpenId && !config.larkReceiveId) {
      saveConfig({ larkReceiveId: status.autoOpenId, larkReceiveIdType: "open_id" })
    }
    return status
  }

  const tryHealth = async (port: number): Promise<DaemonStatus | null> => {
    try {
      const health = await httpGet(`http://127.0.0.1:${port}/health`) as Record<string, unknown>
      if (health.status !== "ok") {
        return null
      }
      return statusFromHealth(port, health)
    } catch {
      return null
    }
  }

  const lock = readLockFile()
  if (lock?.port) {
    const st = await tryHealth(lock.port)
    if (st) {
      const mismatch =
        activeDaemonWorkspaceDir !== null && activeDaemonWorkspaceDir !== cfgWs
      if (mismatch) {
        st.workspaceMismatch = true
        st.daemonWorkspaceDir = activeDaemonWorkspaceDir ?? undefined
      }
      return st
    }
  }

  if (cachedPort) {
    const st = await tryHealth(cachedPort)
    if (st) {
      const mismatch =
        !lock?.port ||
        lock.port !== cachedPort ||
        (activeDaemonWorkspaceDir !== null && activeDaemonWorkspaceDir !== cfgWs)
      if (mismatch) {
        st.workspaceMismatch = true
        st.daemonWorkspaceDir = activeDaemonWorkspaceDir ?? undefined
      }
      return st
    }
  }

  return { running: false, error: "Daemon 未运行" }
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
      return { ok: true }
    }
    try {
      const lock = readLockFile()
      const portToShutdown = lock?.port ?? cachedPort
      if (portToShutdown) {
        await httpPost(`http://127.0.0.1:${portToShutdown}/shutdown`, {})
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
    let daemonStdoutBuf = ""
    let daemonStderrBuf = ""

    daemonProcess = spawn(process.execPath, [entryPath], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      env: { ...env, ELECTRON_RUN_AS_NODE: "1" },
    })

    daemonProcess.stdout?.on("data", (d: Buffer) => {
      const chunk = d.toString()
      earlyOutput += chunk
      daemonStdoutBuf += chunk
      const parts = daemonStdoutBuf.split(/\r?\n/)
      daemonStdoutBuf = parts.pop() ?? ""
      for (const raw of parts) {
        const line = raw.trim()
        if (!line || line.startsWith("[info]:")) continue
        pushUiLog("LarkDaemon", "INFO", line)
      }
    })

    daemonProcess.stderr?.on("data", (d: Buffer) => {
      const chunk = d.toString()
      earlyOutput += chunk
      daemonStderrBuf += chunk
      const parts = daemonStderrBuf.split(/\r?\n/)
      daemonStderrBuf = parts.pop() ?? ""
      for (const raw of parts) {
        pushDaemonStderrLine(raw)
      }
    })

    daemonProcess.on("exit", (code) => {
      earlyExit = code
      daemonProcess = null
      cachedPort = null
      activeDaemonWorkspaceDir = null
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
    activeDaemonWorkspaceDir = config.workspaceDir.trim() || null
    startStatusPolling()
    injectWorkspaceMcpAndRules()
    return { ok: true }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    return { ok: false, error: `启动失败: ${msg}` }
  }
}

export async function stopDaemon(): Promise<void> {
  stopStatusPolling()
  stopAgent()
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
  activeDaemonWorkspaceDir = null
  broadcastStatus({
    running: false,
    error: "Daemon 未运行",
    agentRunning: false,
    agentPid: null,
    queueLength: 0,
  })
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

function broadcastLog(message: string, level: string = "INFO"): void {
  pushUiLog("Electron", level, message)
}

const AGENT_STALE_TIMEOUT_MS = 10 * 60 * 1000
let queueStaleStartTime: number | null = null

let powerSaveBlockerId: number | null = null

function startDaemonPowerSaveBlock(): void {
  stopDaemonPowerSaveBlock()
  try {
    powerSaveBlockerId = powerSaveBlocker.start("prevent-app-suspension")
  } catch { /* ignore */ }
}

function stopDaemonPowerSaveBlock(): void {
  if (powerSaveBlockerId !== null) {
    try {
      powerSaveBlocker.stop(powerSaveBlockerId)
    } catch { /* ignore */ }
    powerSaveBlockerId = null
  }
}

function startStatusPolling(): void {
  stopStatusPolling()
  queueStaleStartTime = null
  startDaemonPowerSaveBlock()
  statusInterval = setInterval(async () => {
    const status = await getDaemonStatus()
    broadcastStatus(status)

    if (status.running && status.queueLength && status.queueLength > 0 && isAgentRunning()) {
      if (queueStaleStartTime === null) {
        queueStaleStartTime = Date.now()
      } else if (Date.now() - queueStaleStartTime > AGENT_STALE_TIMEOUT_MS) {
        broadcastLog(`[防卡死] Agent 运行中但队列消息已 ${Math.round((Date.now() - queueStaleStartTime) / 60_000)} 分钟未消费，自动终止`, "WARN")
        stopAgent()
        queueStaleStartTime = null
      }
    } else {
      queueStaleStartTime = null
    }

    if (status.running && status.queueLength && status.queueLength > 0 && !isAgentRunning()) {
      await new Promise((r) => setTimeout(r, 1000))
      const bundled = await pullMergedMessagesFromQueue()
      if (bundled) {
        broadcastLog(`检测到排队消息 ${bundled.count} 条，合并后自动拉起 Agent`)
        launchAgent(bundled.text)
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
  stopDaemonPowerSaveBlock()
}

/**
 * 一次性取出当前队列中全部消息并合并为一段文本（多条的格式便于 Agent 分批处理）。
 */
async function pullMergedMessagesFromQueue(): Promise<{ text: string; count: number } | null> {
  const lock = readLockFile()
  if (!lock?.port) return null
  try {
    const res = (await httpPost(`http://127.0.0.1:${lock.port}/dequeue-all`, {}, 10_000)) as {
      messages?: string[]
    } | null
    const msgs = res?.messages ?? []
    if (msgs.length === 0) {
      return null
    }
    const trimmed = msgs.map((t) => (typeof t === "string" ? t.trim() : "")).filter((t) => t.length > 0)
    if (trimmed.length === 0) {
      return null
    }
    const text =
      trimmed.length === 1
        ? trimmed[0]
        : trimmed.map((t, i) => `【消息 ${i + 1}】\n${t}`).join("\n\n")
    return { text, count: trimmed.length }
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

async function refreshPathAsync(): Promise<void> {
  if (os.platform() === "win32") {
    try {
      const { stdout } = await execAsync(
        'powershell -NoProfile -Command "[System.Environment]::GetEnvironmentVariable(\'Path\',\'Machine\') + \';\' + [System.Environment]::GetEnvironmentVariable(\'Path\',\'User\')"',
        { timeout: 5000, maxBuffer: 2_000_000 },
      )
      const freshPath = String(stdout ?? "").trim()
      if (freshPath) process.env.PATH = freshPath
    } catch { /* ignore */ }
  } else {
    try {
      const shell = process.env.SHELL || "/bin/zsh"
      const { stdout } = await execAsync(`${shell} -ilc 'echo $PATH'`, {
        timeout: 5000,
        maxBuffer: 2_000_000,
      })
      const freshPath = String(stdout ?? "").trim()
      if (freshPath) process.env.PATH = freshPath
    } catch { /* ignore */ }
  }
}

/**
 * 异步检测 CLI，避免主进程 execSync/spawnSync 阻塞窗口与 IPC。
 */
export async function checkCliInstalled(): Promise<boolean> {
  if (resolveAgentBinary()) return true
  await refreshPathAsync()
  if (resolveAgentBinary()) return true
  return new Promise((resolve) => {
    let settled = false
    pushUiLog("Agent", "INFO", `[CLI check-installed] agent ${JSON.stringify(["--version"])}`)
    const child = spawn("agent", ["--version"], {
      stdio: "ignore",
      shell: process.platform === "win32",
      windowsHide: true,
    })
    const t = setTimeout(() => {
      if (settled) return
      settled = true
      try { child.kill() } catch { /* ignore */ }
      resolve(false)
    }, 5000)
    child.on("error", () => {
      if (settled) return
      settled = true
      clearTimeout(t)
      resolve(false)
    })
    child.on("close", (code) => {
      if (settled) return
      settled = true
      clearTimeout(t)
      resolve(code === 0)
    })
  })
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
        void (async () => {
          await refreshPathAsync()
          const installed = resolveAgentBinary() || (await checkCliInstalled())
          resolve({
            ok: installed,
            output: installed
              ? "CLI 安装成功！请点击「登录授权」完成 Cursor 账号认证。"
              : output || "安装脚本执行完毕，但 agent 命令仍不可用。请重新打开终端后重试。",
          })
        })()
      } else {
        resolve({ ok: false, output: output || `安装失败 (exit code: ${code})` })
      }
    })

    child.on("error", (e) => {
      resolve({ ok: false, output: `安装进程错误: ${e.message}` })
    })
  })
}

export async function loginCli(): Promise<{ ok: boolean; output: string }> {
  if (!resolveAgentBinary()) {
    await refreshPathAsync()
    if (!(await checkCliInstalled())) {
      return { ok: false, output: "Cursor CLI 未安装，请先安装" }
    }
  }

  return new Promise((resolve) => {
    const config = getConfig()
    const args = ["login"]

    const spawnEnv: Record<string, string> = { ...process.env as Record<string, string> }
    applyProxyEnv(spawnEnv, config)

    let output = ""
    let child: ChildProcess
    let settled = false

    broadcastLog("[CLI Login] 正在打开浏览器进行 Cursor 账号授权...")
    logCursorAgentInvocation("cli-login", args, undefined)

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
        if (s) broadcastLog(`[CLI Login] ${s}`, "INFO")
      })

      child.stderr?.on("data", (d: Buffer) => {
        const s = d.toString().trim()
        output += s + "\n"
        if (s) broadcastLog(`[CLI Login:err] ${s}`, "ERROR")
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
    broadcastLog(`MCP 注入失败: ${e instanceof Error ? e.message : e}`, "ERROR")
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
    broadcastLog(`规则注入失败: ${e instanceof Error ? e.message : e}`, "ERROR")
  }

  return { mcpOk, ruleOk }
}

// ── Agent CLI 拉起 ───────────────────────────────────────

let agentChild: ChildProcess | null = null
let agentNodePath = ""
let agentIndexPath = ""
let lastAgentLaunchTime = 0
const AGENT_COOLDOWN_MS = 15_000

/**
 * 将 Cursor CLI（agent）一次调用的可执行文件、完整参数数组与工作目录写入 UI 日志。
 *
 * @param logLabel 调用场景标识
 * @param agentArgs 传给 agent 的参数（不含 Windows 下的 index.js）
 * @param cwd 子进程工作目录（若有）
 */
function logCursorAgentInvocation(logLabel: string, agentArgs: string[], cwd?: string): void {
  const cwdSuffix = cwd != null && cwd !== "" ? ` cwd=${cwd}` : ""
  if (agentNodePath && agentIndexPath) {
    const argv = [agentIndexPath, ...agentArgs]
    pushUiLog("Agent", "INFO", `[CLI ${logLabel}] ${agentNodePath} ${JSON.stringify(argv)}${cwdSuffix}`)
  } else {
    pushUiLog("Agent", "INFO", `[CLI ${logLabel}] agent ${JSON.stringify(agentArgs)}${cwdSuffix}`)
  }
}

/** 工作区从未对话过时，`agent --continue` 会输出并退出 */
const AGENT_NO_PREVIOUS_CHATS = /no previous chats found/i

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

export type ExecAgentSyncOptions = { timeoutMs?: number; cwd?: string; logLabel?: string }

/**
 * 与 launchAgent 相同方式解析 Cursor CLI；主进程环境常无 agent 在 PATH（尤其 Windows），需走 node.exe + index.js。
 */
export function execAgentSync(
  agentArgs: string[],
  env: Record<string, string>,
  timeoutOrOpts: number | ExecAgentSyncOptions = 30_000,
): { ok: boolean; stdout: string; stderr: string; error?: string } {
  const opts: ExecAgentSyncOptions =
    typeof timeoutOrOpts === "number" ? { timeoutMs: timeoutOrOpts } : timeoutOrOpts
  const timeoutMs = opts.timeoutMs ?? 30_000
  const cwd = opts.cwd
  if (!resolveAgentBinary()) {
    refreshPath()
    if (!resolveAgentBinary()) {
      return { ok: false, stdout: "", stderr: "", error: "未找到 Cursor CLI（agent），请先安装并完成登录" }
    }
  }
  logCursorAgentInvocation(opts.logLabel ?? "invoke-sync", agentArgs, cwd)
  const mergedEnv = { ...process.env as Record<string, string>, ...env }
  if (agentNodePath && agentIndexPath) {
    const r = spawnSync(agentNodePath, [agentIndexPath, ...agentArgs], {
      encoding: "utf-8",
      timeout: timeoutMs,
      env: mergedEnv,
      windowsHide: true,
      cwd,
    })
    const stdout = r.stdout == null ? "" : String(r.stdout)
    const stderr = r.stderr == null ? "" : String(r.stderr)
    if (r.error) {
      return { ok: false, stdout, stderr, error: r.error.message }
    }
    if (r.status !== 0) {
      const hint = (stderr || stdout).trim().slice(0, 500) || `进程退出码 ${r.status}`
      return { ok: false, stdout, stderr, error: hint }
    }
    return { ok: true, stdout, stderr }
  }
  const r = spawnSync("agent", agentArgs, {
    encoding: "utf-8",
    timeout: timeoutMs,
    env: mergedEnv,
    shell: process.platform === "win32",
    windowsHide: true,
    cwd,
  })
  const stdout = r.stdout == null ? "" : String(r.stdout)
  const stderr = r.stderr == null ? "" : String(r.stderr)
  if (r.error) {
    return { ok: false, stdout, stderr, error: r.error.message }
  }
  if (r.status !== 0) {
    const hint = (stderr || stdout).trim().slice(0, 500) || `进程退出码 ${r.status}`
    return { ok: false, stdout, stderr, error: hint }
  }
  return { ok: true, stdout, stderr }
}

/**
 * 与 execAgentSync 相同逻辑，异步 spawn，不阻塞主进程事件循环。
 */
export async function execAgentAsync(
  agentArgs: string[],
  env: Record<string, string>,
  timeoutOrOpts: number | ExecAgentSyncOptions = 30_000,
): Promise<{ ok: boolean; stdout: string; stderr: string; error?: string }> {
  const opts: ExecAgentSyncOptions =
    typeof timeoutOrOpts === "number" ? { timeoutMs: timeoutOrOpts } : timeoutOrOpts
  const timeoutMs = opts.timeoutMs ?? 30_000
  const cwd = opts.cwd

  if (!resolveAgentBinary()) {
    await refreshPathAsync()
    if (!resolveAgentBinary()) {
      return { ok: false, stdout: "", stderr: "", error: "未找到 Cursor CLI（agent），请先安装并完成登录" }
    }
  }

  logCursorAgentInvocation(opts.logLabel ?? "invoke-async", agentArgs, cwd)
  const mergedEnv = { ...process.env as Record<string, string>, ...env }

  return new Promise((resolve) => {
    let settled = false
    let timer: NodeJS.Timeout | undefined
    const finish = (r: { ok: boolean; stdout: string; stderr: string; error?: string }) => {
      if (settled) return
      settled = true
      if (timer !== undefined) {
        clearTimeout(timer)
      }
      resolve(r)
    }

    let child: ChildProcess
    if (agentNodePath && agentIndexPath) {
      child = spawn(agentNodePath, [agentIndexPath, ...agentArgs], {
        env: mergedEnv,
        windowsHide: true,
        cwd,
      })
    } else {
      child = spawn("agent", agentArgs, {
        env: mergedEnv,
        shell: process.platform === "win32",
        windowsHide: true,
        cwd,
      })
    }

    let stdout = ""
    let stderr = ""
    timer = setTimeout(() => {
      try { child.kill("SIGTERM") } catch { /* ignore */ }
      finish({ ok: false, stdout, stderr, error: "命令超时" })
    }, timeoutMs)

    child.stdout?.on("data", (d: Buffer) => {
      stdout += d.toString()
    })
    child.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString()
    })
    child.on("error", (e) => {
      finish({ ok: false, stdout, stderr, error: e.message })
    })
    child.on("close", (code) => {
      if (code === 0) {
        finish({ ok: true, stdout, stderr })
        return
      }
      const hint = (stderr || stdout).trim().slice(0, 500) || `进程退出码 ${code}`
      finish({ ok: false, stdout, stderr, error: hint })
    })
  })
}

export type AgentLoginStatus = {
  cliFound: boolean
  loggedIn: boolean
  identityLine?: string
  error?: string
}

/**
 * 通过 `agent whoami` 判断是否已登录（成功时 stdout 通常含 Logged in as ...）。
 * 若本应用已拉起 Agent 子进程，则不再 spawn whoami，避免与 Dashboard 的 requestIdleCallback 检测叠在启动后、造成「Agent 已跑仍打 whoami」的错觉与多余进程。
 */
export async function checkAgentLoggedIn(): Promise<AgentLoginStatus> {
  if (isAgentRunning()) {
    return {
      cliFound: true,
      loggedIn: true,
      identityLine: "Agent 运行中（已跳过 whoami）",
    }
  }
  if (!resolveAgentBinary()) {
    await refreshPathAsync()
    if (!resolveAgentBinary()) {
      return { cliFound: false, loggedIn: false, error: "未找到 Cursor CLI（agent）" }
    }
  }
  const config = getConfig()
  const env: Record<string, string> = { ...process.env as Record<string, string>, NODE_USE_ENV_PROXY: "1" }
  applyProxyEnv(env, config)
  const workspaceCwd = config.workspaceDir?.trim() || undefined
  const r = await execAgentAsync(["whoami"], env, { timeoutMs: 15_000, cwd: workspaceCwd, logLabel: "whoami" })
  const out = r.stdout.trim()
  const err = r.stderr.trim()
  if (r.ok) {
    const loggedIn = /logged\s+in/i.test(out) || /✓\s*Logged/i.test(out)
    const firstLine = out
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0)
    return {
      cliFound: true,
      loggedIn,
      identityLine: firstLine,
      error: loggedIn ? undefined : (out || err || "未识别登录状态").slice(0, 400),
    }
  }
  const combined = (out || err || r.error || "").trim().slice(0, 500)
  return { cliFound: true, loggedIn: false, error: combined }
}

function isAgentRunning(): boolean {
  return agentChild !== null && !agentChild.killed && agentChild.exitCode === null
}

function buildAgentLaunchArgs(config: AppConfig, prompt: string, includeContinue: boolean): string[] {
  const args = [
    "--print",
    "--force",
    ...(includeContinue ? ["--continue"] : []),
    "--approve-mcps",
    "--workspace",
    config.workspaceDir,
    "--trust",
  ]
  if (config.model && config.model !== "auto") {
    args.push("--model", config.model)
  }
  args.push(prompt)
  return args
}

/**
 * 启动 agent 子进程；若因无历史会话导致 --continue 失败，自动去掉 --continue 再启动一次。
 */
function startAgentChildProcess(
  args: string[],
  spawnEnv: Record<string, string>,
  canRetryWithoutContinue: boolean,
): { ok: boolean; error?: string } {
  let stdoutAcc = ""
  let stderrAcc = ""
  const agentOutBuf = { current: "" }
  const agentErrBuf = { current: "" }

  try {
    let child: ChildProcess
    const ws = getConfig().workspaceDir?.trim() || undefined
    logCursorAgentInvocation("launch", args, ws)
    if (agentNodePath && agentIndexPath) {
      child = spawn(agentNodePath, [agentIndexPath, ...args], {
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: spawnEnv,
      })
    } else {
      child = spawn("agent", args, {
        shell: process.platform === "win32",
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: spawnEnv,
      })
    }

    agentChild = child

    child.stdout?.on("data", (d: Buffer) => {
      const chunk = d.toString()
      stdoutAcc += chunk
      flushAgentStreamChunk(agentOutBuf, chunk, "stdout")
    })
    child.stderr?.on("data", (d: Buffer) => {
      const chunk = d.toString()
      stderrAcc += chunk
      flushAgentStreamChunk(agentErrBuf, chunk, "stderr")
    })
    child.on("close", (code, signal) => {
      const combined = stdoutAcc + stderrAcc
      if (agentOutBuf.current.trim()) {
        pushUiLog("Agent", "INFO", agentOutBuf.current.trim())
        agentOutBuf.current = ""
      }
      if (agentErrBuf.current.trim()) {
        pushUiLog("Agent", "WARN", agentErrBuf.current.trim())
        agentErrBuf.current = ""
      }
      const hadContinue = args.includes("--continue")
      if (canRetryWithoutContinue && hadContinue && AGENT_NO_PREVIOUS_CHATS.test(combined)) {
        broadcastLog("[Agent] 检测到无历史会话，已去掉 --continue 并重新启动", "INFO")
        agentChild = null
        const argsWithoutContinue = args.filter((a) => a !== "--continue")
        startAgentChildProcess(argsWithoutContinue, spawnEnv, false)
        return
      }
      const sig = signal ? ` signal=${signal}` : ""
      pushUiLog("Agent", "INFO", `退出 code=${code}${sig}`)
      agentChild = null
    })
    child.on("error", (e) => {
      pushUiLog("Agent", "ERROR", `进程错误: ${e.message}`)
      agentChild = null
    })

    broadcastLog(`Agent 已启动, pid=${child.pid}`)
    return { ok: true }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    broadcastLog(`[Agent] 启动失败: ${msg}`, "ERROR")
    return { ok: false, error: msg }
  }
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
    ? `请遵守飞书工作流规则feishu-cursor-bridge开始工作,以下是用户通过飞书发来的消息，请直接处理，不要发送问候语：\n\n${initialMessage}`
    : "请遵守飞书工作流规则feishu-cursor-bridge开始工作,先获取待处理的飞书消息，然后根据消息内容开始工作。不要发送问候消息。"
  const skipContinueOnce = config.agentSkipContinueNextLaunch === true
  const includeContinue = !config.agentNewSession && !skipContinueOnce
  const args = buildAgentLaunchArgs(config, prompt, includeContinue)

  const spawnEnv: Record<string, string> = { ...process.env as Record<string, string>, CURSOR_INVOKED_AS: "agent" }
  delete spawnEnv.NODE_USE_ENV_PROXY
  applyProxyEnv(spawnEnv, config)

  const started = startAgentChildProcess(args, spawnEnv, includeContinue)
  if (started.ok && skipContinueOnce) {
    saveConfig({ agentSkipContinueNextLaunch: false })
    broadcastLog("[Agent] 已消费 /reset 标记：本次未使用 --continue，后续恢复设置中的「新会话」偏好", "INFO")
  }
  return started
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
    broadcastLog(`指令结果回报失败: ${e instanceof Error ? e.message : e}`, "WARN")
  }
}

const TASK_SUBCMD_HELP =
  "💡 可用指令\n" +
  "🔹 /task 显示本说明\n" +
  "🔹 /task ls 列出所有任务\n" +
  "🔹 /task info <序号> 查看详情\n" +
  "🔹 /task stop <序号> 停止任务\n" +
  "🔹 /task start <序号> 启动任务\n" +
  "🔹 /task delete <序号> 删除任务\n" +
  "🔹 /task create <名称> <cron> <内容> 创建任务\n" +
  "🔹 /task update <序号> [-name 值] [-cron 值] [-content 值] 更新任务"

function parseTaskOneBasedIndex(s: string | undefined): number | null {
  if (s === undefined || s === "") {
    return null
  }
  const n = parseInt(s, 10)
  if (!Number.isInteger(n) || n < 1) {
    return null
  }
  return n
}

function parseTaskCreateArgs(parts: string[]):
  | { ok: true; name: string; cron: string; content: string }
  | { ok: false; error: string } {
  const afterCreate = parts.slice(2)
  if (afterCreate.length < 1 + 5 + 1) {
    return { ok: false, error: "❌ 参数不足：/task create <名称> <cron五或六段> <内容>" }
  }
  for (const cronLen of [6, 5] as const) {
    if (afterCreate.length < cronLen + 2) {
      continue
    }
    for (let nameLen = 1; nameLen <= afterCreate.length - cronLen - 1; nameLen++) {
      const name = afterCreate.slice(0, nameLen).join(" ").trim()
      if (!name) {
        continue
      }
      const cronToks = afterCreate.slice(nameLen, nameLen + cronLen)
      const cronExpr = cronToks.join(" ").trim()
      if (!validateCron(cronExpr)) {
        continue
      }
      const content = afterCreate.slice(nameLen + cronLen).join(" ").trim()
      if (!content) {
        return { ok: false, error: "任务内容不能为空" }
      }
      return { ok: true, name, cron: cronExpr, content }
    }
  }
  return { ok: false, error: "无法解析：请保证「名称」「cron（连续 5 或 6 段）」「内容」三部分，且 cron 能通过校验" }
}

function parseTaskUpdateArgs(parts: string[]):
  | { ok: true; oneBasedIndex: number; updates: { name?: string; cron?: string; content?: string } }
  | { ok: false; error: string } {
  if (parts.length < 4) {
    return { ok: false, error: "💡 用法：/task update <序号> [-name 值] [-cron 值] [-content 值]" }
  }
  const idx = parseTaskOneBasedIndex(parts[2])
  if (idx === null) {
    return { ok: false, error: "❌ 序号须为正整数" }
  }
  const known = new Set(["-name", "-cron", "-content"])
  let i = 3
  const updates: { name?: string; cron?: string; content?: string } = {}
  while (i < parts.length) {
    const flag = parts[i].toLowerCase()
    if (!known.has(flag)) {
      return { ok: false, error: `❌ 未知选项: ${parts[i]}（仅支持 -name -cron -content）` }
    }
    i++
    const valBuf: string[] = []
    while (i < parts.length) {
      const t = parts[i]
      if (t.startsWith("-") && known.has(t.toLowerCase())) {
        break
      }
      valBuf.push(t)
      i++
    }
    if (valBuf.length === 0) {
      return { ok: false, error: `❌ ${flag} 缺少取值` }
    }
    const val = valBuf.join(" ").trim()
    if (flag === "-name") {
      updates.name = val
    } else if (flag === "-cron") {
      updates.cron = val
    } else {
      updates.content = val
    }
  }
  if (Object.keys(updates).length === 0) {
    return { ok: false, error: "❌ 至少指定一项：-name / -cron / -content" }
  }
  return { ok: true, oneBasedIndex: idx, updates }
}

const TASK_PREVIEW_BULLETS = ["①", "②", "③", "④", "⑤"] as const

function taskPreviewBullet(i: number): string {
  return TASK_PREVIEW_BULLETS[i] ?? `${i + 1}.`
}

function formatTaskStatusLine(enabled: boolean): string {
  return enabled ? "✅ 运行中" : "⏸️ 已停止"
}

async function handleFeishuTaskCommand(port: number, messageId: string, raw: string): Promise<void> {
  const parts = raw.trim().split(/\s+/).filter((p) => p.length > 0)
  const low = (s: string) => s.toLowerCase()

  if (parts.length <= 1) {
    await reportCommandResult(port, messageId, true, TASK_SUBCMD_HELP)
    return
  }

  const sub = low(parts[1])
  if (sub === "help" || sub === "-h" || sub === "--help") {
    await reportCommandResult(port, messageId, true, TASK_SUBCMD_HELP)
    return
  }

  let tasks = readTasksFromFile()

  if (sub === "ls") {
    if (tasks.length === 0) {
      await reportCommandResult(
        port,
        messageId,
        true,
        "📭 当前还没有定时任务～\n\n💡 需要的话可以用：\n   /task create <名称> <cron> <内容>",
      )
      return
    }
    const blocks = tasks.map((t, i) => {
      const n = i + 1
      return [
        "┈┈┈┈┈┈┈┈┈┈",
        `#${n}\t📋 名称 · ${t.name}`,
        `\t💠 状态 · ${formatTaskStatusLine(t.enabled)}`,
        `\t🔄 Cron · ${t.cron}`,
        `\t⏱️ 下次 · ${t.enabled ? getNextCronFireLabel(t.cron) : "-"}`
      ].join("\n")
    })
    const header = `⏰ 定时任务一览（共 ${tasks.length} 条）`
    await reportCommandResult(port, messageId, true, `${header}\n\n${blocks.join("\n\n")}\n\n✨ 看某条详情：/task info <序号>`)
    return
  }

  if (sub === "info") {
    const idx = parseTaskOneBasedIndex(parts[2])
    if (idx === null) {
      await reportCommandResult(port, messageId, false, "💡 用法：/task info <序号>（数字见 /task ls 的 #）")
      return
    }
    if (tasks.length === 0) {
      await reportCommandResult(port, messageId, false, "📭 还没有任何任务，先用 /task ls 确认一下吧～")
      return
    }
    if (idx > tasks.length) {
      await reportCommandResult(port, messageId, false, `😅 序号 ${idx} 对应的任务不存在哦（当前共 ${tasks.length} 条）`)
      return
    }
    const t = tasks[idx - 1]
    const statusLine = formatTaskStatusLine(t.enabled)
    let scheduleSection: string
    const prev = previewCronNextRuns(t.cron)
    if (prev.ok) {
      const lines = prev.runs.map((r, i) => `   ${taskPreviewBullet(i)} ${r}`)
      scheduleSection = `⏱️ 最近计划触发（${prev.runs.length} 次预览）\n${lines.join("\n")}`
    } else {
      scheduleSection = ``
    }
    const body = [
      `📋 任务详情  #${idx}`,
      "",
      `📝 名称 · ${t.name}`,
      `💠 状态 · ${statusLine}`,
      `🔄 Cron · ${t.cron}`,
      scheduleSection,
      "",
      "✉️ 任务内容",
      "────────────",
      t.content,
    ].join("\n")
    await reportCommandResult(port, messageId, true, body)
    return
  }

  if (sub === "stop") {
    const idx = parseTaskOneBasedIndex(parts[2])
    if (idx === null) {
      await reportCommandResult(port, messageId, false, "💡 用法：/task stop <序号>（数字见 /task ls 的 #）")
      return
    }
    if (idx > tasks.length) {
      await reportCommandResult(port, messageId, false, `😅 序号 ${idx} 对应的任务不存在哦（共 ${tasks.length} 条）`)
      return
    }
    const name = tasks[idx - 1].name
    tasks = tasks.map((t, j) => (j === idx - 1 ? { ...t, enabled: false } : t))
    writeTasksToFile(tasks)
    await reportCommandResult(port, messageId, true, `⏸️ 已停止任务 #${idx} ${name}`)
    return
  }

  if (sub === "start") {
    const idx = parseTaskOneBasedIndex(parts[2])
    if (idx === null) {
      await reportCommandResult(port, messageId, false, "💡 用法：/task start <序号>（数字见 /task ls 的 #）")
      return
    }
    if (idx > tasks.length) {
      await reportCommandResult(port, messageId, false, `😅 序号 ${idx} 对应的任务不存在哦（共 ${tasks.length} 条）`)
      return
    }
    const name = tasks[idx - 1].name
    const cron = tasks[idx - 1].cron
    tasks = tasks.map((t, j) => (j === idx - 1 ? { ...t, enabled: true } : t))
    writeTasksToFile(tasks)
    const next = getNextCronFireLabel(cron)
    await reportCommandResult(port, messageId, true, `✅ 已启动任务 #${idx} ${name}\n下次执行: ${next}`)
    return
  }

  if (sub === "delete") {
    const idx = parseTaskOneBasedIndex(parts[2])
    if (idx === null) {
      await reportCommandResult(port, messageId, false, "💡 用法：/task delete <序号>（数字见 /task ls 的 #）")
      return
    }
    if (idx > tasks.length) {
      await reportCommandResult(port, messageId, false, `😅 序号 ${idx} 对应的任务不存在哦（共 ${tasks.length} 条）`)
      return
    }
    const name = tasks[idx - 1].name
    tasks = tasks.filter((_, j) => j !== idx - 1)
    writeTasksToFile(tasks)
    await reportCommandResult(port, messageId, true, `🗑️ 已删除任务 #${idx} ${name}`)
    return
  }

  if (sub === "create") {
    const parsed = parseTaskCreateArgs(parts)
    if (!parsed.ok) {
      await reportCommandResult(port, messageId, false, parsed.error)
      return
    }
    const newTask: ScheduledTask = {
      id: randomUUID(),
      name: parsed.name,
      cron: parsed.cron,
      content: parsed.content,
      enabled: true,
    }
    tasks = [...tasks, newTask]
    writeTasksToFile(tasks)
    const next = getNextCronFireLabel(parsed.cron)
    await reportCommandResult(port, messageId, true, `✅ 已创建并启动：${parsed.name}\n下次执行: ${next}`)
    return
  }

  if (sub === "update") {
    const pu = parseTaskUpdateArgs(parts)
    if (!pu.ok) {
      await reportCommandResult(port, messageId, false, pu.error)
      return
    }
    if (pu.oneBasedIndex > tasks.length) {
      await reportCommandResult(port, messageId, false, `😅 序号 ${pu.oneBasedIndex} 对应的任务不存在哦（共 ${tasks.length} 条）`)
      return
    }
    const t = tasks[pu.oneBasedIndex - 1]
    let nextName = t.name
    let nextCron = t.cron
    let nextContent = t.content
    if (pu.updates.name !== undefined) {
      nextName = pu.updates.name
    }
    if (pu.updates.cron !== undefined) {
      nextCron = pu.updates.cron
    }
    if (pu.updates.content !== undefined) {
      nextContent = pu.updates.content
    }
    if (pu.updates.cron !== undefined && !validateCron(nextCron)) {
      await reportCommandResult(port, messageId, false, "😅 新 Cron 表达式无效")
      return
    }
    const updated: ScheduledTask = { ...t, name: nextName, cron: nextCron, content: nextContent }
    tasks = tasks.map((x, j) => (j === pu.oneBasedIndex - 1 ? updated : x))
    writeTasksToFile(tasks)

    const statusLine = formatTaskStatusLine(t.enabled)
    let scheduleSection: string
    const prev = previewCronNextRuns(t.cron)
    if (prev.ok) {
      const lines = prev.runs.map((r, i) => `   ${taskPreviewBullet(i)} ${r}`)
      scheduleSection = `⏱️ 最近计划触发（${prev.runs.length} 次预览）\n${lines.join("\n")}`
    } else {
      scheduleSection = ``
    }
    const body = [
      `✅ 已更新任务`,
      `📋 任务详情  #${pu.oneBasedIndex}`,
      "",
      `📝 名称 · ${t.name}`,
      `💠 状态 · ${statusLine}`,
      `🔄 Cron · ${t.cron}`,
      scheduleSection,
      "",
      "✉️ 任务内容",
      "────────────",
      t.content,
    ].join("\n")
    await reportCommandResult(port, messageId, true, body)
    return
  }

  await reportCommandResult(port, messageId, false, `😅 未知子命令: ${parts[1]}\n\n${TASK_SUBCMD_HELP}`)
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

    const rawCmd = claimed.command.trim()
    const cmdTokens = rawCmd.split(/\s+/).filter((t) => t.length > 0)
    const head = (cmdTokens[0] ?? "").toLowerCase()

    broadcastLog(`[指令] 执行 ${rawCmd} (msgId=${claimed.messageId})`)
    try {
      switch (head) {
        case "/stop": {
          const wasRunning = isAgentRunning()
          stopAgent()
          await reportCommandResult(lock.port, claimed.messageId, true,
            wasRunning ? "✅ Agent 已停止" : "❌ Agent 当前未运行")
          break
        }

        case "/status": {
          const status = await getDaemonStatus()
          const schedTasks = readTasksFromFile()
          const schedTotal = schedTasks.length
          const schedEnabled = schedTasks.filter((t) => t.enabled).length
          const lines = [
            `🛡️ Daemon: ${status.running ? "✅ 运行中" : "❌ 未运行"}`,
            status.version ? `🔄 版本: ${status.version}` : "",
            status.uptime !== undefined ? `⌛️ 运行时间: ${Math.floor(status.uptime / 60)}分钟` : "",
            `🤖 Agent: ${isAgentRunning() ? `✅ 运行中 (PID: ${agentChild?.pid})` : "❌ 未运行"}`,
            `📭 队列消息: ${status.queueLength ?? 0} 条`,
            `⏰ 定时任务: 开启 ${schedEnabled} / 共 ${schedTotal} 条`,
          ].filter(Boolean)
          await reportCommandResult(lock.port, claimed.messageId, true, lines.join("\n"))
          break
        }

        case "/list": {
          const msgs = await getQueueMessages()
          if (msgs.length === 0) {
            await reportCommandResult(lock.port, claimed.messageId, true, "📭 消息队列为空")
          } else {
            const lines = msgs.map((m) => `  [${m.index}] ${m.preview}`)
            await reportCommandResult(lock.port, claimed.messageId, true,
              `📬 队列中有 ${msgs.length} 条消息：\n${lines.join("\n")}`)
          }
          break
        }

        case "/task": {
          await handleFeishuTaskCommand(lock.port, claimed.messageId, rawCmd)
          break
        }

        case "/restart": {
          stopAgent()
          const cleared = await clearMessageQueue()
          await reportCommandResult(lock.port, claimed.messageId, true,
            `✅ Agent 已停止，已清空 ${cleared} 条队列消息，正在重启 Daemon...`)
          await stopDaemon()
          await new Promise((r) => setTimeout(r, 1500))
          const result = await startDaemon()
          if (!result.ok) broadcastLog(`[指令] Daemon 重启失败: ${result.error}`, "ERROR")
          break
        }

        case "/clean": {
          const cleared = await clearMessageQueue()
          broadcastLog(`[指令 /clean] 已清空队列 ${cleared} 条`, "INFO")
          await reportCommandResult(lock.port, claimed.messageId, true,
            `✅ 已清空消息队列，共移除 ${cleared} 条`)
          break
        }

        case "/reset": {
          stopAgent()
          lastAgentLaunchTime = 0
          saveConfig({ agentSkipContinueNextLaunch: true })
          broadcastLog("[指令 /reset] 已记录：下次拉起 Agent 不带 --continue；已停止当前 Agent（若曾运行）", "INFO")
          await reportCommandResult(
            lock.port,
            claimed.messageId,
            true,
            "✅ 已停止并重置当前会话, 请重新发消息开启新会话",
          )
          break
        }

        case "/help": {
          const helpLines = [
            "💡 可用指令：",
            "🔹 /status 运行状态",
            "🔹 /restart 重启应用",
            "🔹 /stop 停止Agent",
            "🔹 /reset 重置会话",
            "🔹 /list 消息队列",
            "🔹 /clean 清空队列",
            "🔹 /task 定时任务",
            "🔹 /help 指令列表",
          ]
          await reportCommandResult(lock.port, claimed.messageId, true, helpLines.join("\n"))
          break
        }

        default:
          await reportCommandResult(lock.port, claimed.messageId, false, `😅 未知指令: ${head}`)
      }
    } catch (e: unknown) {
      broadcastLog(`[指令] ${rawCmd} 执行异常: ${e instanceof Error ? e.message : e}`, "ERROR")
      try { await reportCommandResult(lock.port, claimed.messageId, false, `❌ 执行异常: ${e instanceof Error ? e.message : e}`) } catch { /* ignore */ }
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
  rawConfig?: Record<string, unknown>
  enabled?: boolean
}

function spawnAsync(args: string[], cwd: string, env: Record<string, string>): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const mcpLabel = args.length >= 2 && args[0] === "mcp" ? `mcp-${args[1]}` : `mcp-${args[0] ?? "spawn"}`
    logCursorAgentInvocation(mcpLabel, args, cwd)
    let stdout = "", stderr = ""
    const child = agentNodePath && agentIndexPath
      ? spawn(agentNodePath, [agentIndexPath, ...args], {
          windowsHide: true, stdio: ["ignore", "pipe", "pipe"], cwd, env,
        })
      : spawn("agent", args, {
          shell: true, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], cwd, env,
        })
    child.stdout?.on("data", (d: Buffer) => { stdout += d.toString() })
    child.stderr?.on("data", (d: Buffer) => { stderr += d.toString() })
    child.on("error", () => resolve({ code: 1, stdout, stderr }))
    child.on("exit", (code) => resolve({ code: code ?? 1, stdout, stderr }))
    setTimeout(() => { try { child.kill() } catch { /* */ }; resolve({ code: 1, stdout, stderr }) }, 10_000)
  })
}

const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]/g

function isEnabledStatus(status: string): boolean {
  const s = status.toLowerCase()
  return s !== "disabled" && !s.includes("not loaded")
}

/** 合并并发 `mcp list`，避免启动时 StrictMode 双 effect 等导致同一时刻两次 CLI */
let getMcpEnabledMapInFlight: Promise<Record<string, boolean>> | null = null

export async function getMcpEnabledMap(): Promise<Record<string, boolean>> {
  const config = getConfig()
  if (!config.workspaceDir || !resolveAgentBinary()) {
    return {}
  }
  if (getMcpEnabledMapInFlight) {
    return getMcpEnabledMapInFlight
  }
  const p = (async (): Promise<Record<string, boolean>> => {
    const env: Record<string, string> = { ...process.env as Record<string, string> }
    applyProxyEnv(env, config)
    try {
      const r = await spawnAsync(["mcp", "list"], config.workspaceDir, env)
      const clean = r.stdout.replace(ANSI_RE, "").replace(/\r/g, "")
      const result: Record<string, boolean> = {}
      for (const line of clean.split("\n")) {
        const m = line.match(/^(.+?):\s+(.+)$/)
        if (m) {
          result[m[1].trim()] = isEnabledStatus(m[2].trim())
        }
      }
      return result
    } catch {
      return {}
    } finally {
      getMcpEnabledMapInFlight = null
    }
  })()
  getMcpEnabledMapInFlight = p
  return p
}

export async function toggleMcpServer(serverName: string, enabled: boolean): Promise<{ ok: boolean; output: string }> {
  const config = getConfig()
  if (!config.workspaceDir) return { ok: false, output: "工作目录未配置" }
  if (!resolveAgentBinary()) return { ok: false, output: "Cursor CLI 未安装" }

  const env: Record<string, string> = { ...process.env as Record<string, string> }
  applyProxyEnv(env, config)

  const sub = enabled ? "enable" : "disable"
  try {
    const r = await spawnAsync(["mcp", sub, serverName], config.workspaceDir, env)
    const out = (r.stdout + r.stderr).replace(ANSI_RE, "").replace(/\r/g, "").trim()
    broadcastLog(`[MCP ${sub}] ${serverName}: ${out}`, r.code === 0 ? "INFO" : "WARN")
    return { ok: r.code === 0, output: out }
  } catch (e: unknown) {
    return { ok: false, output: e instanceof Error ? e.message : String(e) }
  }
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
          rawConfig: entry,
        }
        if (isUrl) {
          item.url = entry.url as string
          const hasHeaders = !!(entry.headers && typeof entry.headers === "object" && Object.keys(entry.headers as object).length > 0)
          if (hasHeaders) {
            item.authenticated = true
          } else {
            const auth = authData[name] as Record<string, unknown> | undefined
            const hasToken = !!(auth?.tokens && (auth.tokens as Record<string, unknown>).access_token)
            item.authenticated = hasToken || verified.includes(name)
          }
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

let mcpLoginChild: ChildProcess | null = null
let mcpLoginGeneration = 0

export function loginMcpServer(serverName: string): Promise<{ ok: boolean; output: string }> {
  const gen = ++mcpLoginGeneration

  return new Promise<{ ok: boolean; output: string }>(async (resolve) => {
    if (mcpLoginChild) {
      try { mcpLoginChild.kill() } catch { /* ignore */ }
      mcpLoginChild = null
      broadcastLog(`[MCP Login] 终止上一次未完成的登录进程`)
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

    const spawnEnv: Record<string, string> = { ...process.env as Record<string, string> }
    applyProxyEnv(spawnEnv, config)

    // 先 enable 再 login（异步）
    try {
      const er = await spawnAsync(["mcp", "enable", serverName], config.workspaceDir, spawnEnv)
      const enOut = (er.stdout + er.stderr).trim()
      broadcastLog(`[MCP Enable] "${serverName}": ${enOut || "已启用"}`, er.code === 0 ? "INFO" : "WARN")
    } catch (e: unknown) {
      broadcastLog(`[MCP Enable] 启用失败: ${e instanceof Error ? e.message : e}`, "ERROR")
    }

    const args = [
      "--workspace", config.workspaceDir,
      "mcp", "login", serverName,
    ]

    let output = ""
    broadcastLog(`[MCP Login] 正在认证 "${serverName}"...`)
    logCursorAgentInvocation("mcp-login", args, config.workspaceDir)

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
        if (s) broadcastLog(`[MCP Login] ${s}`, "INFO")
      })

      mcpLoginChild.stderr?.on("data", (d: Buffer) => {
        const s = d.toString().trim()
        output += s + "\n"
        if (s) broadcastLog(`[MCP Login:err] ${s}`, "ERROR")
      })

      mcpLoginChild.on("exit", (code) => {
        mcpLoginChild = null
        if (gen !== mcpLoginGeneration) {
          resolve({ ok: true, output: "" })
          return
        }
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
        if (gen !== mcpLoginGeneration) { resolve({ ok: true, output: "" }); return }
        resolve({ ok: false, output: `认证进程错误: ${e.message}` })
      })

      setTimeout(() => {
        if (mcpLoginChild && gen === mcpLoginGeneration) {
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

export interface ConfigSaveResult {
  ok: boolean
  /** 需在渲染进程展示自定义弹窗后，由用户选择「重启」或「保持」 */
  needWorkspaceDaemonChoice?: boolean
  oldWorkspaceDir?: string
  newWorkspaceDir?: string
  /** 因目录冲突未写入 store，完成向导需在重启成功后补写 */
  deferredSetupComplete?: boolean
  restartFailed?: string
  /** 本次已将工作目录写入配置（非「待确认重启」分支）；渲染进程应刷新依赖工作区的数据（如 MCP 列表与启用状态） */
  workspaceDirChanged?: boolean
}

/**
 * 在新工作目录下保存并重启 Daemon（由渲染进程在确认后调用）。
 */
export async function applyWorkspaceDirRestart(workspaceDir: string): Promise<{ ok: boolean; error?: string }> {
  const w = workspaceDir.trim()
  if (!w) {
    return { ok: false, error: "工作目录为空" }
  }
  saveConfig({ workspaceDir: w })
  await stopDaemon()
  const started = await startDaemon()
  broadcastStatus(await getDaemonStatus())
  if (!started.ok) {
    return { ok: false, error: started.error ?? "Daemon 启动失败" }
  }
  return { ok: true }
}

/**
 * 保存配置；若正在修改工作目录且 Daemon 在运行，交由渲染进程展示与主页风格一致的确认弹窗。
 */
export async function saveAppConfigFromRenderer(partial: Partial<AppConfig>): Promise<ConfigSaveResult> {
  const current = getConfig()
  const oldW = (current.workspaceDir || "").trim()
  const nextW = partial.workspaceDir !== undefined ? partial.workspaceDir.trim() : oldW
  const workspaceChanging = partial.workspaceDir !== undefined && nextW !== oldW && oldW !== ""

  if (workspaceChanging) {
    const st = await getDaemonStatus()
    if (st.running) {
      const deferredSc = partial.setupComplete === true
      const rest: Partial<AppConfig> = { ...partial }
      delete (rest as Record<string, unknown>).workspaceDir
      if (deferredSc) {
        delete (rest as Record<string, unknown>).setupComplete
      }
      saveConfig({ ...rest, workspaceDir: oldW })
      broadcastStatus(await getDaemonStatus())
      return {
        ok: true,
        needWorkspaceDaemonChoice: true,
        oldWorkspaceDir: oldW,
        newWorkspaceDir: nextW,
        deferredSetupComplete: deferredSc,
      }
    }
  }

  const workspaceDirChanged =
    partial.workspaceDir !== undefined && nextW !== oldW

  saveConfig(partial)
  return {
    ok: true,
    ...(workspaceDirChanged ? { workspaceDirChanged: true } : {}),
  }
}

// ── 初始化 ───────────────────────────────────────────────

export function initDaemonManager(): void {
  ipcMain.handle("config:apply-workspace-restart", (_, workspaceDir: string) => applyWorkspaceDirRestart(workspaceDir))
  ipcMain.handle("daemon:get-log-buffer", () => getLogBuffer())
  ipcMain.handle("agent:launch", () => launchAgent())
  ipcMain.handle("agent:stop", () => { stopAgent(); return { ok: true } })

  ipcMain.handle("scheduled-tasks:get", () => {
    return readTasksFromFile()
  })
  ipcMain.handle("scheduled-tasks:save", (_, tasks) => {
    writeTasksToFile(tasks)
    return { ok: true }
  })
  ipcMain.handle("scheduled-tasks:validate-cron", (_, expression: string) => {
    return validateCron(expression)
  })
  ipcMain.handle("scheduled-tasks:preview-cron", (_, expression: string) => {
    return previewCronNextRuns(expression)
  })

  getDaemonStatus().then((status) => {
    if (status.running) {
      startStatusPolling()
    }
  })
}

export function cleanupDaemonManager(): void {
  stopStatusPolling()
  stopAgent()
  if (daemonProcess) {
    try { daemonProcess.kill() } catch { /* ignore */ }
    daemonProcess = null
  }
  cachedPort = null
  activeDaemonWorkspaceDir = null
}
