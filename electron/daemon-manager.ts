import { spawn, type ChildProcess } from "node:child_process"
import { randomUUID } from "node:crypto"
import * as http from "node:http"
import * as path from "node:path"
import * as fs from "node:fs"
import * as os from "node:os"
import { app, BrowserWindow, ipcMain, powerSaveBlocker } from "electron"
import { getConfig, saveConfig, type AppConfig, type ScheduledTask } from "./config-store"
import { validateCron, readTasksFromFile, writeTasksToFile, previewCronNextRuns, getNextCronFireLabel } from "./cron-scheduler"
import { pushLog, pushUiLog, broadcastLog as _broadcastLog, getLogBuffer as _getLogBuffer, clearLogBuffer, logCursorAgentInvocation, escapeLogContentSingleLine } from "./ui-logger"
import {
  resolveAgentBinary as _resolveAgentBinary, applyProxyEnv as _applyProxyEnv,
  quoteArg, getAgentPaths, checkCliInstalled as _checkCliInstalled,
  installCli as _installCli, execAgentSync as _execAgentSync, execAgentAsync as _execAgentAsync,
  type ExecAgentOptions,
} from "./agent-cli"
import {
  stopAgent as _stopAgent,
  launchSessionAgent as _launchSessionAgent, stopSessionAgent as _stopSessionAgent,
  stopAllSessionAgents as _stopAllSessionAgents, getSessionAgentList as _getSessionAgentList,
  launchIndependentAgent as _launchIndependentAgent, isAgentRunning as _isAgentRunning,
  isSessionAgentRunning as _isSessionAgentRunning,
  getRunningSessionCount as _getRunningSessionCount,
  checkAgentLoggedIn as _checkAgentLoggedIn, loginCli as _loginCli,
  reapIdleGroupAgents as _reapIdleGroupAgents,
  getAgentChildPid, getSessionAgentCount, getIndependentTaskStatuses, getIndependentAgentList,
  P2P_SESSION_KEY, makeMainP2pSessionKey, setMainChatId, getMainChatId as _getMainChatId,
  setChatNameResolver as _setChatNameResolver,
} from "./agent-launcher"

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
  model?: string
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

function getMcpServerPath(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "daemon", "mcp-server.mjs")
  }
  const bundled = path.join(app.getAppPath(), "dist-bundle", "mcp-server.mjs")
  if (fs.existsSync(bundled)) return bundled
  return path.join(app.getAppPath(), "dist", "index.js")
}

function getAdminMcpPath(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "daemon", "mcp-admin.mjs")
  }
  const bundled = path.join(app.getAppPath(), "dist-bundle", "mcp-admin.mjs")
  if (fs.existsSync(bundled)) return bundled
  return path.join(app.getAppPath(), "dist", "server-admin-entry.js")
}

function getRuleTemplatePath(): string {
  if (app.isPackaged) return path.join(process.resourcesPath, "feishu-cursor-bridge.mdc")
  return path.join(app.getAppPath(), "resources", "feishu-cursor-bridge.mdc")
}

function getLockFilePath(): string {
  const config = getConfig()
  const appId = config.larkAppId || "default"
  return path.join(app.getPath("userData"), "apps", appId, "daemon.lock.json")
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
    const cfgModel = config.model?.trim() || "auto"
    const status: DaemonStatus = {
      running: true,
      version: health.version as string,
      uptime: health.uptime as number,
      queueLength: health.queueLength as number,
      hasTarget: health.hasTarget as boolean,
      autoOpenId: health.autoOpenId as string | null,
      agentRunning: _isAgentRunning() || getSessionAgentCount() > 0,
      agentPid: getAgentChildPid(),
      sessionAgentCount: _getRunningSessionCount(),
      model: cfgModel,
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

export const applyProxyEnv = _applyProxyEnv

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
      LARK_APP_DATA_DIR: path.join(app.getPath("userData"), "apps", config.larkAppId),
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
        if (line.startsWith("__IND_LAUNCH__:")) {
          try {
            const payload = JSON.parse(line.slice("__IND_LAUNCH__:".length))
            launchIndependentAgent(payload.taskId, payload.taskName, payload.content)
          } catch { /* ignore malformed */ }
          continue
        }
        if (line.startsWith("__BIND_RESULT__:")) {
          try {
            const payload = JSON.parse(line.slice("__BIND_RESULT__:".length))
            const chatId = payload.chatId
            if (chatId) {
              saveConfig({ larkReceiveId: chatId, larkReceiveIdType: "chat_id" })
              broadcastLog(`[Bind] 主用户绑定成功: chat_id=${chatId}`)
              BrowserWindow.getAllWindows().forEach((w) => w.webContents.send("bind:result", { ok: true, value: chatId }))
            }
          } catch { /* ignore */ }
          continue
        }
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
  stopAllSessionAgents()
  clearLogBuffer()

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

const broadcastLog = _broadcastLog

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
    try {
      const status = await getDaemonStatus()
      broadcastStatus(status)

      if (status.running && status.queueLength && status.queueLength > 0 && _isAgentRunning()) {
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

      if (status.running && status.queueLength && status.queueLength > 0) {
        await dispatchSessionAgents()
      }

      _reapIdleGroupAgents()

      const sessions = _getSessionAgentList()
      const uncachedGroups = sessions
        .filter((s) => s.chatType === "group" && !chatNameCache.has(s.sessionKey))
        .map((s) => s.sessionKey)
      if (uncachedGroups.length > 0) await fetchChatNames(uncachedGroups)

      const uncachedP2pOpenIds = sessions
        .filter((s) => s.chatType === "p2p" && s.senderOpenId && !chatNameCache.has(s.senderOpenId))
        .map((s) => s.senderOpenId!)
      if (uncachedP2pOpenIds.length > 0) await fetchUserNames(uncachedP2pOpenIds)

      if (status.running) {
        await checkAndExecutePendingCommands()
      }
    } catch (e: unknown) {
      broadcastLog(`[StatusPoll] 异常: ${e instanceof Error ? e.message : e}`, "ERROR")
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

// ── Chat 名称缓存 ──────────────────────────────────────────

const chatNameCache = new Map<string, string>()

async function fetchChatNames(chatIds: string[]): Promise<void> {
  const missing = chatIds.filter((id) => id && !chatNameCache.has(id))
  if (missing.length === 0) return
  const lock = readLockFile()
  if (!lock?.port) return
  try {
    const res = (await httpPost(`http://127.0.0.1:${lock.port}/api/chat-names`, { chatIds: missing }, 15_000)) as { names?: Record<string, string> }
    if (res?.names) {
      for (const [id, name] of Object.entries(res.names)) chatNameCache.set(id, name)
    }
  } catch { /* ignore */ }
}

async function fetchUserNames(openIds: string[]): Promise<void> {
  const missing = openIds.filter((id) => id && !chatNameCache.has(id))
  if (missing.length === 0) return
  const lock = readLockFile()
  if (!lock?.port) return
  try {
    const res = (await httpPost(`http://127.0.0.1:${lock.port}/api/user-names`, { openIds: missing }, 15_000)) as { names?: Record<string, string> }
    if (res?.names) {
      for (const [id, name] of Object.entries(res.names)) chatNameCache.set(id, name)
    }
  } catch { /* ignore */ }
}

export function getChatName(chatId: string): string | undefined {
  return chatNameCache.get(chatId)
}

interface DequeuedMessage { text: string; messageId: string; chatId: string; chatType: string; senderOpenId?: string }

interface MergedMessages { text: string; count: number; chatType?: string; messageIds: string[]; chatId?: string; senderOpenId?: string }

async function pullMergedMessagesFromQueue(chatId?: string): Promise<MergedMessages | null> {
  const lock = readLockFile()
  if (!lock?.port) return null
  try {
    const body = chatId ? { chatId } : {}
    const res = (await httpPost(`http://127.0.0.1:${lock.port}/dequeue-all`, body, 10_000)) as {
      messages?: (DequeuedMessage | string)[]
    } | null
    const msgs = res?.messages ?? []
    if (msgs.length === 0) return null

    const parsed: DequeuedMessage[] = msgs
      .map((m) => (typeof m === "string" ? { text: m, messageId: "", chatId: "", chatType: "" } : m))
      .filter((m) => m.text?.trim())

    if (parsed.length === 0) return null

    const chatType = parsed[0].chatType || undefined
    const messageIds = parsed.map((m) => m.messageId).filter(Boolean)

    const text = parsed.length === 1
      ? parsed[0].text.trim()
      : parsed.map((m, i) => `【消息 ${i + 1}】\n${m.text.trim()}`).join("\n\n")

    return { text, count: parsed.length, chatType, messageIds, chatId: parsed[0].chatId || chatId, senderOpenId: parsed[0].senderOpenId || undefined }
  } catch {
    return null
  }
}

async function getQueueChats(): Promise<{ chatId: string; chatType: string }[]> {
  const lock = readLockFile()
  if (!lock?.port) return []
  try {
    const res = (await httpGet(`http://127.0.0.1:${lock.port}/queue-chat-ids`)) as { chats?: { chatId: string; chatType: string }[] } | null
    return res?.chats ?? []
  } catch {
    return []
  }
}

function bundledToMeta(b: MergedMessages): import("./agent-launcher").LaunchMeta {
  return { messageIds: b.messageIds, chatId: b.chatId, chatType: b.chatType }
}

function isMainUser(_senderOpenId?: string, chatId?: string, chatType?: string): boolean {
  if (chatType !== "p2p") return false
  const rid = getConfig().larkReceiveId?.trim()
  return !!rid && chatId === rid
}

async function dispatchSessionAgents(): Promise<void> {
  const config = getConfig()
  if (config.workspaceDir) injectMcpToDir(config.workspaceDir, true)
  const chats = await getQueueChats()

  const groupChatIds = chats.filter((c) => c.chatType === "group").map((c) => c.chatId)
  if (groupChatIds.length > 0) await fetchChatNames(groupChatIds)

  for (const { chatId, chatType } of chats) {
    const bundled = await pullMergedMessagesFromQueue(chatId)
    if (!bundled) continue

    const meta = bundledToMeta(bundled)
    const mainUser = isMainUser(bundled.senderOpenId, chatId, chatType)
    const useMainWorkspace = mainUser && chatType === "p2p"

    if (chatType === "p2p" && bundled.senderOpenId && !chatNameCache.has(bundled.senderOpenId)) {
      await fetchUserNames([bundled.senderOpenId])
    }

    const sessionKey = useMainWorkspace
      ? makeMainP2pSessionKey(chatId, config.workspaceDir)
      : chatId

    if (_isSessionAgentRunning(sessionKey)) {
      continue
    }
    await new Promise((r) => setTimeout(r, 500))

    const userName = bundled.senderOpenId ? chatNameCache.get(bundled.senderOpenId) : undefined
    const chatName = chatNameCache.get(chatId) || userName
    const label = chatType === "group"
      ? `群聊 ${chatName ? `「${chatName}」` : chatId}`
      : (mainUser ? `主用户私聊${userName ? ` (${userName})` : ""}` : `私聊 ${userName || chatId}`)
    broadcastLog(`[Agent] ${label} 有 ${bundled.count} 条消息，自动拉起${useMainWorkspace ? "(主工作目录)" : ""}`)

    const result = launchSessionAgent(sessionKey, chatType as "p2p" | "group", bundled.text, meta, useMainWorkspace, bundled.senderOpenId)
    if (!result.ok) broadcastLog(`[Agent] ${sessionKey} 启动跳过: ${result.error}`)
  }
}

export async function clearMessageQueue(): Promise<number> {
  const lock = readLockFile()
  if (!lock?.port) return 0
  try {
    const res = await httpPost(`http://127.0.0.1:${lock.port}/clear-queue`, {}) as { cleared?: number }
    return res?.cleared ?? 0
  } catch { return 0 }
}

export async function getQueueMessages(): Promise<{ index: number; preview: string; chatId?: string; chatType?: string }[]> {
  const lock = readLockFile()
  if (!lock?.port) return []
  try {
    const res = await httpGet(`http://127.0.0.1:${lock.port}/queue`) as {
      messages?: { index: number; preview: string; chatId?: string; chatType?: string }[]
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

export const checkCliInstalled = _checkCliInstalled
export const installCli = _installCli

export const loginCli = _loginCli

export const getLogBuffer = _getLogBuffer

// ── MCP 配置 + 规则注入 ────────────────────────────────────

/**
 * 按优先级检查全局和项目 mcp.json 中是否已存在指定 serverKey。
 * 存在则返回该文件路径（原地更新），都不存在返回 null（将注入项目目录）。
 */
const injectedMcpHashes = new Map<string, string>()

function buildMcpServers(includeAdmin: boolean): Record<string, unknown> {
  if (!cachedPort) return {}
  const env: Record<string, string> = { LARK_DAEMON_PORT: String(cachedPort) }

  const servers: Record<string, unknown> = {
    "feishu-cursor-bridge": { command: "node", args: [getMcpServerPath()], env },
  }
  if (includeAdmin) {
    servers["feishu-cursor-bridge-admin"] = {
      command: "node",
      args: [getAdminMcpPath()],
      env,
    }
  }
  return servers
}

function injectMcpToDir(wsDir: string, includeAdmin = false): boolean {
  try {
    const newServers = buildMcpServers(includeAdmin)
    const hash = JSON.stringify(newServers)
    if (injectedMcpHashes.get(wsDir) === hash) return true

    const mcpPath = path.join(wsDir, ".cursor", "mcp.json")
    let mcpConfig: Record<string, unknown> = {}
    if (fs.existsSync(mcpPath)) {
      try { mcpConfig = JSON.parse(fs.readFileSync(mcpPath, "utf-8")) } catch { mcpConfig = {} }
    }
    const existing = (mcpConfig.mcpServers ?? {}) as Record<string, unknown>
    Object.assign(existing, newServers)
    mcpConfig.mcpServers = existing

    const dir = path.dirname(mcpPath)
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(mcpPath, JSON.stringify(mcpConfig, null, 2), "utf-8")
    injectedMcpHashes.set(wsDir, hash)
    broadcastLog(`MCP 已注入: ${mcpPath}`)

    enableMcpServersAsync(wsDir, Object.keys(newServers))
    return true
  } catch (e: unknown) {
    broadcastLog(`MCP 注入失败: ${e instanceof Error ? e.message : e}`, "ERROR")
    return false
  }
}

function enableMcpServersAsync(wsDir: string, serverNames: string[]): void {
  const config = getConfig()
  const env: Record<string, string> = { ...process.env as Record<string, string> }
  applyProxyEnv(env, config)
  ;(async () => {
    let needEnable: string[]
    try {
      const r = await spawnAsync(["mcp", "list"], wsDir, env)
      const clean = r.stdout.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").replace(/\r/g, "")
      const enabledSet = new Set<string>()
      for (const line of clean.split("\n")) {
        const m = line.match(/^(.+?):\s+(.+)$/)
        if (m && isEnabledStatus(m[2].trim())) enabledSet.add(m[1].trim())
      }
      needEnable = serverNames.filter((n) => !enabledSet.has(n))
      if (needEnable.length === 0) return
    } catch {
      needEnable = serverNames
    }
    for (const name of needEnable) {
      try {
        const r = await spawnAsync(["mcp", "enable", name], wsDir, env)
        const out = (r.stdout + r.stderr).replace(/\x1b\[[0-9;]*m/g, "").trim()
        broadcastLog(`[MCP Auto-Enable] "${name}": ${out || "已启用"}`, r.code === 0 ? "INFO" : "WARN")
      } catch (e: unknown) {
        broadcastLog(`[MCP Auto-Enable] "${name}" 失败: ${e instanceof Error ? e.message : e}`, "WARN")
      }
    }
  })()
}

function injectRulesToDir(wsDir: string): boolean {
  try {
    const rulesDir = path.join(wsDir, ".cursor", "rules")
    if (!fs.existsSync(rulesDir)) fs.mkdirSync(rulesDir, { recursive: true })
    const rulePath = path.join(rulesDir, "feishu-cursor-bridge.mdc")
    const tplPath = getRuleTemplatePath()
    const ruleContent = fs.existsSync(tplPath)
      ? fs.readFileSync(tplPath, "utf-8")
      : ""
    if (!ruleContent) {
      broadcastLog(`规则模板文件不存在: ${tplPath}`, "WARN")
      return false
    }
    fs.writeFileSync(rulePath, ruleContent, "utf-8")
    broadcastLog(`规则已注入: ${rulePath}`)

    const identity = getConfig().digitalIdentity?.trim()
    const identityPath = path.join(rulesDir, "digital-identity.mdc")
    if (identity) {
      const identityMdc = [
        "---",
        "description: 数字身份规则 - 定义 Agent 的角色、职责和行为边界",
        "alwaysApply: true",
        "---",
        "",
        identity,
      ].join("\r\n")
      fs.writeFileSync(identityPath, identityMdc, "utf-8")
    } else if (fs.existsSync(identityPath)) {
      fs.unlinkSync(identityPath)
    }

    return true
  } catch (e: unknown) {
    broadcastLog(`规则注入失败: ${e instanceof Error ? e.message : e}`, "ERROR")
    return false
  }
}

export function injectWorkspaceMcpAndRules(): { mcpOk: boolean; ruleOk: boolean } {
  const config = getConfig()
  if (!config.workspaceDir) return { mcpOk: false, ruleOk: false }
  const mcpOk = injectMcpToDir(config.workspaceDir, true)
  const ruleOk = injectRulesToDir(config.workspaceDir)
  return { mcpOk, ruleOk }
}

function injectWorkspaceToDir(dir: string): boolean {
  injectMcpToDir(dir)
  return injectRulesToDir(dir)
}

// ── Agent 状态与会话管理（委托 agent-launcher） ─────────────

export const launchIndependentAgent = _launchIndependentAgent

export type { ExecAgentOptions as ExecAgentSyncOptions } from "./agent-cli"
export const execAgentSync = _execAgentSync
export const execAgentAsync = _execAgentAsync

export type AgentLoginStatus = {
  cliFound: boolean
  loggedIn: boolean
  identityLine?: string
  error?: string
}

export const checkAgentLoggedIn = _checkAgentLoggedIn
export const stopAgent = _stopAgent
export const launchAgent = (initialMessage?: string) =>
  launchSessionAgent(P2P_SESSION_KEY, "p2p", initialMessage, undefined, true)
export const launchSessionAgent: (sessionKey: string, chatType: "p2p" | "group", initialMessage?: string, meta?: import("./agent-launcher").LaunchMeta, useMainWorkspace?: boolean, senderOpenId?: string) => { ok: boolean; error?: string } =
  (sessionKey, chatType, initialMessage, meta, useMainWorkspace, senderOpenId) => _launchSessionAgent(sessionKey, chatType, initialMessage, injectWorkspaceToDir, meta, useMainWorkspace, senderOpenId)
export const stopSessionAgent = _stopSessionAgent
export const stopAllSessionAgents = _stopAllSessionAgents
export function getSessionAgentList() {
  const sessions = _getSessionAgentList().map((s) => {
    const chatId = s.sessionKey.includes("::") ? s.sessionKey.split("::")[0] : s.sessionKey
    const chatName = chatNameCache.get(chatId) || (s.senderOpenId ? chatNameCache.get(s.senderOpenId) : undefined)
    return { ...s, chatName }
  })
  return [...sessions, ...getIndependentAgentList()]
}

// ── 指令执行（从共享文件队列消费）──────────────────────────

interface FileCommand { id: string; command: string; messageId: string; chatId?: string; chatType?: string }

async function reportCommandResult(port: number, messageId: string, ok: boolean, message: string): Promise<void> {
  try {
    await httpPost(`http://127.0.0.1:${port}/cmd/result`, { messageId, ok, message })
  } catch (e: unknown) {
    broadcastLog(`指令结果回报失败: ${e instanceof Error ? e.message : e}`, "WARN")
  }
}

const MODEL_SUBCMD_HELP =
  "💡 /model 子命令\n" +
  "🔹 /model ls — 列出可用模型与序号\n" +
  "🔹 /model info — 查看当前应用配置的模型\n" +
  "🔹 /model set <序号> — 按 /model ls 的 # 设置模型（写入配置，下次启动 Agent 生效）"

type ListedModel = { id: string; label: string; current: boolean }

export function parseListModelsStdout(out: string): ListedModel[] {
  const cleaned = out.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").replace(/\r/g, "")
  const models: ListedModel[] = []
  for (const line of cleaned.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed || /^available models/i.test(trimmed)) {
      continue
    }
    const match = trimmed.match(/^(\S+)\s+[–—-]\s+(.+?)(\s+\((?:default|current)\))?\s*$/)
    if (match) {
      models.push({ id: match[1], label: match[2].trim(), current: !!match[3] })
    }
  }
  return models
}

function listCursorModelsForCommands(): { ok: true; models: ListedModel[] } | { ok: false; error: string } {
  const config = getConfig()
  const env: Record<string, string> = { ...process.env as Record<string, string>, NODE_USE_ENV_PROXY: "1" }
  applyProxyEnv(env, config)
  const ws = config.workspaceDir?.trim() || undefined
  const run = execAgentSync(["--list-models"], env, { timeoutMs: 30_000, logLabel: "list-models-cmd", cwd: ws })
  if (!run.ok) {
    return { ok: false, error: run.error || run.stderr.trim() || "获取模型列表失败" }
  }
  const models = parseListModelsStdout(run.stdout)
  if (models.length === 0) {
    return { ok: false, error: "未解析到任何模型，请检查 agent --list-models 输出格式是否变化" }
  }
  return { ok: true, models }
}

async function handleFeishuModelCommand(port: number, messageId: string, raw: string): Promise<void> {
  const parts = raw.trim().split(/\s+/).filter((p) => p.length > 0)
  const low = (s: string) => s.toLowerCase()

  if (parts.length <= 1) {
    await reportCommandResult(port, messageId, true, MODEL_SUBCMD_HELP)
    return
  }

  const sub = low(parts[1])
  if (sub === "help" || sub === "-h" || sub === "--help") {
    await reportCommandResult(port, messageId, true, MODEL_SUBCMD_HELP)
    return
  }

  if (sub === "info") {
    const cfgModel = getConfig().model?.trim() || "auto"
    const lines: string[] = [`📝 应用配置 model: ${cfgModel}`]
    if (cfgModel === "auto") {
      lines.push("（auto：启动 Agent 时不传 --model，由 CLI 默认策略选择）")
    }
    const lr = listCursorModelsForCommands()
    if (lr.ok) {
      const hit = lr.models.findIndex((m) => m.id === cfgModel)
      if (hit >= 0) {
        lines.push(`对应列表序号: #${hit + 1}`)
        lines.push(`   ${lr.models[hit].id} — ${lr.models[hit].label}`)
      } else if (cfgModel !== "auto") {
        lines.push("（当前配置 id 不在本次 CLI 列表中，若刚换模型列表可再执行 /model ls）")
      }
      const cliCur = lr.models.filter((m) => m.current)
      if (cliCur.length > 0) {
        lines.push(`CLI --list-models 标注 (current): ${cliCur.map((m) => m.id).join(", ")}`)
      }
    } else {
      lines.push(`⚠️ 无法拉取 CLI 模型列表: ${lr.error}`)
    }
    await reportCommandResult(port, messageId, true, lines.join("\n"))
    return
  }

  if (sub === "ls") {
    const lr = listCursorModelsForCommands()
    if (!lr.ok) {
      await reportCommandResult(port, messageId, false, `❌ ${lr.error}`)
      return
    }
    const blocks = lr.models.map((m, i) => {
      const n = i + 1
      const tag = m.current ? "  ⭐CLI current" : ""
      return [`#${n}`, `\t id · ${m.id}`, `\t说明 · ${m.label}${tag}`].join("\n")
    })
    const body = [`🧠 模型列表（共 ${lr.models.length} 个）`, "", ...blocks, "", "💡 设置：/model set <序号>"].join("\n")
    await reportCommandResult(port, messageId, true, body)
    return
  }

  if (sub === "set") {
    const lr = listCursorModelsForCommands()
    if (!lr.ok) {
      await reportCommandResult(port, messageId, false, `❌ ${lr.error}`)
      return
    }
    if (parts.length < 3) {
      await reportCommandResult(port, messageId, false, "💡 用法：/model set <序号>（数字见 /model ls 的 #）")
      return
    }
    const idx = parseInt(parts[2], 10)
    if (!Number.isInteger(idx) || idx < 1 || idx > lr.models.length) {
      await reportCommandResult(
        port,
        messageId,
        false,
        `😅 序号须为 1～${lr.models.length} 之间的整数（先 /model ls）`,
      )
      return
    }
    const picked = lr.models[idx - 1]
    saveConfig({ model: picked.id })
    await reportCommandResult(
      port,
      messageId,
      true,
      [
        `✅ 已保存模型（下次启动 Agent 生效）`,
        ` # · ${idx}`,
        ` id · ${picked.id}`,
        `说明 · ${picked.label}`,
        "",
        "若 Agent 正在运行，可 /stop 后由新消息再拉起以使用新模型。",
      ].join("\n"),
    )
    return
  }

  await reportCommandResult(port, messageId, false, `😅 未知子命令: ${parts[1]}\n\n${MODEL_SUBCMD_HELP}`)
}

const TASK_SUBCMD_HELP =
  "💡 可用指令\n" +
  "🔹 /task 显示本说明\n" +
  "🔹 /task ls 列出所有任务\n" +
  "🔹 /task info <序号> 查看详情\n" +
  "🔹 /task run <序号> 立即触发一次\n" +
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

  if (sub === "run") {
    const idx = parseTaskOneBasedIndex(parts[2])
    if (idx === null) {
      await reportCommandResult(port, messageId, false, "💡 用法：/task run <序号>（数字见 /task ls 的 #）")
      return
    }
    if (idx > tasks.length) {
      await reportCommandResult(port, messageId, false, `😅 序号 ${idx} 对应的任务不存在哦（共 ${tasks.length} 条）`)
      return
    }
    const t = tasks[idx - 1]
    const nowStr = new Date().toLocaleString("zh-CN")
    const content = `[定时任务: ${t.name}] (手动触发: ${nowStr})\n\n${t.content}`
    if (t.independent !== false) {
      const result = launchIndependentAgent(t.id, t.name, content)
      if (result.ok) {
        await reportCommandResult(port, messageId, true, `🚀 已独立启动任务 #${idx} ${t.name}`)
      } else {
        await reportCommandResult(port, messageId, false, `❌ 独立启动失败: ${result.error}`)
      }
    } else {
      try {
        await httpPost(`http://127.0.0.1:${port}/enqueue`, { content })
        await reportCommandResult(port, messageId, true, `🚀 已手动触发任务 #${idx} ${t.name}`)
      } catch (e: unknown) {
        await reportCommandResult(port, messageId, false, `❌ 触发失败: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
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

    const statusLine = formatTaskStatusLine(updated.enabled)
    let scheduleSection: string
    const prev = previewCronNextRuns(updated.cron)
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
      `📝 名称 · ${updated.name}`,
      `💠 状态 · ${statusLine}`,
      `🔄 Cron · ${updated.cron}`,
      scheduleSection,
      "",
      "✉️ 任务内容",
      "────────────",
      updated.content,
    ].join("\n")
    await reportCommandResult(port, messageId, true, body)
    return
  }

  await reportCommandResult(port, messageId, false, `😅 未知子命令: ${parts[1]}\n\n${TASK_SUBCMD_HELP}`)
}

const MCP_SUBCMD_HELP = [
  "📦 MCP 服务器管理",
  "",
  "  /mcp ls              列出所有 MCP 服务器",
  "  /mcp info <序号|名称>  查看详情",
  "  /mcp enable <序号|名称> 启用",
  "  /mcp disable <序号|名称> 禁用",
  "  /mcp delete <序号|名称> 删除",
  '  /mcp add <json>       添加（如 /mcp add {"name":"test","command":"npx","args":["-y","xxx"]}）',
].join("\n")

function resolveMcpTarget(list: McpServerEntry[], token: string): McpServerEntry | null {
  const idx = parseInt(token, 10)
  if (!isNaN(idx) && idx >= 1 && idx <= list.length) return list[idx - 1]
  return list.find((s) => s.name.toLowerCase() === token.toLowerCase()) ?? null
}

async function handleFeishuMcpCommand(port: number, messageId: string, raw: string): Promise<void> {
  const parts = raw.trim().split(/\s+/).filter((p) => p.length > 0)

  if (parts.length <= 1) {
    await reportCommandResult(port, messageId, true, MCP_SUBCMD_HELP)
    return
  }

  const sub = parts[1].toLowerCase()

  if (sub === "help" || sub === "-h") {
    await reportCommandResult(port, messageId, true, MCP_SUBCMD_HELP)
    return
  }

  if (sub === "ls" || sub === "list") {
    const list = getMcpServerList()
    const enabledMap = await getMcpEnabledMap()
    if (list.length === 0) {
      await reportCommandResult(port, messageId, true, "📭 暂无 MCP 服务器")
      return
    }
    const lines = list.map((s, i) => {
      const flag = enabledMap[s.name] === false ? "🔴" : "🟢"
      const src = s.source === "global" ? "[G]" : "[P]"
      const detail = s.type === "url" ? s.url : s.command
      return `  ${i + 1}. ${flag} ${src} ${s.name}  (${detail})`
    })
    await reportCommandResult(port, messageId, true, `📦 MCP 服务器列表：\n${lines.join("\n")}`)
    return
  }

  if (sub === "info") {
    const list = getMcpServerList()
    const token = parts[2]
    if (!token) { await reportCommandResult(port, messageId, false, "用法: /mcp info <序号|名称>"); return }
    const target = resolveMcpTarget(list, token)
    if (!target) { await reportCommandResult(port, messageId, false, `❌ 找不到: ${token}`); return }
    const enabledMap = await getMcpEnabledMap()
    const lines = [
      `📦 ${target.name}`,
      `  类型: ${target.type}`,
      `  来源: ${target.source}`,
      `  状态: ${enabledMap[target.name] === false ? "🔴 已禁用" : "🟢 已启用"}`,
    ]
    if (target.type === "url") lines.push(`  URL: ${target.url}`)
    else lines.push(`  命令: ${target.command} ${(target.args ?? []).join(" ")}`)
    if (target.env && Object.keys(target.env).length > 0) {
      lines.push(`  环境变量: ${Object.keys(target.env).join(", ")}`)
    }
    await reportCommandResult(port, messageId, true, lines.join("\n"))
    return
  }

  if (sub === "enable" || sub === "disable") {
    const list = getMcpServerList()
    const token = parts[2]
    if (!token) { await reportCommandResult(port, messageId, false, `用法: /mcp ${sub} <序号|名称>`); return }
    const target = resolveMcpTarget(list, token)
    if (!target) { await reportCommandResult(port, messageId, false, `❌ 找不到: ${token}`); return }
    const enabled = sub === "enable"
    const result = await toggleMcpServer(target.name, enabled)
    await reportCommandResult(port, messageId, result.ok,
      result.ok ? `✅ ${target.name} 已${enabled ? "启用" : "禁用"}` : `❌ 操作失败: ${result.output}`)
    return
  }

  if (sub === "delete" || sub === "rm") {
    const list = getMcpServerList()
    const token = parts[2]
    if (!token) { await reportCommandResult(port, messageId, false, "用法: /mcp delete <序号|名称>"); return }
    const target = resolveMcpTarget(list, token)
    if (!target) { await reportCommandResult(port, messageId, false, `❌ 找不到: ${token}`); return }
    deleteMcpServer(target.name)
    await reportCommandResult(port, messageId, true, `🗑️ ${target.name} 已删除`)
    return
  }

  if (sub === "add") {
    const jsonStr = raw.replace(/^\/mcp\s+add\s*/i, "").trim()
    if (!jsonStr) {
      await reportCommandResult(port, messageId, false, '用法: /mcp add {"name":"xxx","command":"npx","args":[...]}')
      return
    }
    try {
      const parsed = JSON.parse(jsonStr)
      const name = parsed.name as string
      if (!name) { await reportCommandResult(port, messageId, false, "❌ 缺少 name 字段"); return }
      const { name: _, ...entry } = parsed
      saveMcpServer(name, entry, "project")
      await reportCommandResult(port, messageId, true, `✅ ${name} 已添加`)
    } catch (e: unknown) {
      await reportCommandResult(port, messageId, false, `❌ JSON 解析失败: ${e instanceof Error ? e.message : e}`)
    }
    return
  }

  await reportCommandResult(port, messageId, false, `😅 未知子命令: ${sub}\n\n${MCP_SUBCMD_HELP}`)
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
    let claimed: { command: string; messageId: string; chatId?: string; chatType?: string } | null
    try {
      const claimRes = await httpPost(`http://127.0.0.1:${lock.port}/commands/claim`, { id: cmd.id }) as
        { ok: boolean; command?: string; messageId?: string; chatId?: string; chatType?: string }
      if (!claimRes.ok) continue
      claimed = { command: claimRes.command!, messageId: claimRes.messageId!, chatId: claimRes.chatId, chatType: claimRes.chatType }
    } catch { continue }

    const rawCmd = claimed.command.trim()
    const cmdTokens = rawCmd.split(/\s+/).filter((t) => t.length > 0)
    const head = (cmdTokens[0] ?? "").toLowerCase()
    const isAdmin = isMainUser(undefined, claimed.chatId, claimed.chatType)
    const reply = (ok: boolean, msg: string) => reportCommandResult(lock.port, claimed!.messageId, ok, msg)
    const denyNonAdmin = () => reply(false, "🔒 该指令仅管理员可用")

    broadcastLog(`[指令] 执行 ${rawCmd} (msgId=${claimed.messageId} admin=${isAdmin})`)
    try {
      switch (head) {
        case "/stop": {
          if (isAdmin) {
            const wasRunning = _isAgentRunning()
            stopAgent()
            await reply(true, wasRunning ? "✅ Agent 已停止" : "❌ Agent 当前未运行")
          } else if (claimed.chatId && _isSessionAgentRunning(claimed.chatId)) {
            _stopSessionAgent(claimed.chatId)
            await reply(true, "✅ 当前会话 Agent 已停止")
          } else {
            await reply(false, "❌ 当前会话无运行中的 Agent")
          }
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
            `🤖 Agent: ${_isAgentRunning() ? `✅ 运行中 (PID: ${getAgentChildPid()})` : "❌ 未运行"}`,
            `📭 队列消息: ${status.queueLength ?? 0} 条`,
            `⏰ 定时任务: 开启 ${schedEnabled} / 共 ${schedTotal} 条`,
          ].filter(Boolean)
          await reply(true, lines.join("\n"))
          break
        }

        case "/list": {
          const msgs = await getQueueMessages()
          const filtered = isAdmin ? msgs : msgs.filter((m) => m.chatId === claimed!.chatId)
          if (filtered.length === 0) {
            await reply(true, "📭 消息队列为空")
          } else {
            const lines = filtered.map((m) => `  [${m.index}] ${m.preview}`)
            await reply(true, `📬 队列中有 ${filtered.length} 条消息：\n${lines.join("\n")}`)
          }
          break
        }

        case "/task": {
          if (!isAdmin) { await denyNonAdmin(); break }
          await handleFeishuTaskCommand(lock.port, claimed.messageId, rawCmd)
          break
        }

        case "/run": {
          if (!isAdmin) { await denyNonAdmin(); break }
          const runMsg = cmdTokens.slice(1).join(" ").trim()
          if (!runMsg) {
            await reply(false, "💡 用法：/run <任务描述>\n例如：/run 帮我检查一下服务器状态")
            break
          }
          const taskId = `temp-${Date.now()}`
          const result = _launchIndependentAgent(taskId, "临时会话", runMsg)
          await reply(result.ok, result.ok
            ? `🚀 临时 Agent 已启动 (id=${taskId})`
            : `❌ 启动失败: ${result.error ?? "未知错误"}`)
          break
        }

        case "/model": {
          if (!isAdmin) { await denyNonAdmin(); break }
          await handleFeishuModelCommand(lock.port, claimed.messageId, rawCmd)
          break
        }

        case "/mcp": {
          if (!isAdmin) { await denyNonAdmin(); break }
          await handleFeishuMcpCommand(lock.port, claimed.messageId, rawCmd)
          break
        }

        case "/restart": {
          if (!isAdmin) { await denyNonAdmin(); break }
          stopAgent()
          const cleared = await clearMessageQueue()
          await reply(true, `✅ Agent 已停止，已清空 ${cleared} 条队列消息，正在重启 Daemon...`)
          await stopDaemon()
          await new Promise((r) => setTimeout(r, 1500))
          const result = await startDaemon()
          if (!result.ok) broadcastLog(`[指令] Daemon 重启失败: ${result.error}`, "ERROR")
          break
        }

        case "/clean": {
          if (!isAdmin) { await denyNonAdmin(); break }
          const cleared = await clearMessageQueue()
          broadcastLog(`[指令 /clean] 已清空队列 ${cleared} 条`, "INFO")
          await reply(true, `✅ 已清空消息队列，共移除 ${cleared} 条`)
          break
        }

        case "/reset": {
          if (isAdmin) {
            stopAgent()
            setMainChatId(getConfig().workspaceDir, "")
            broadcastLog("[指令 /reset] 已清除主会话并停止 Agent，下次启动将创建新会话", "INFO")
            await reply(true, "✅ 已停止并重置当前会话, 请重新发消息开启新会话")
          } else if (claimed.chatId && _isSessionAgentRunning(claimed.chatId)) {
            _stopSessionAgent(claimed.chatId)
            await reply(true, "✅ 当前会话已重置, 请重新发消息开启新会话")
          } else {
            await reply(true, "✅ 当前会话已重置, 请重新发消息开启新会话")
          }
          break
        }

        case "/workspace": {
          if (!isAdmin) { await denyNonAdmin(); break }
          const wsArgs = cmdTokens.slice(1)
          if (wsArgs.length === 0 || wsArgs[0] === "info") {
            const cfg = getConfig()
            await reply(true, `📂 当前工作目录: ${cfg.workspaceDir || "(未配置)"}`)
          } else if (wsArgs[0] === "set" && wsArgs.length >= 2) {
            const newDir = wsArgs.slice(1).join(" ").trim()
            const cfg = getConfig()
            if (newDir === cfg.workspaceDir) {
              await reply(true, `📂 工作目录未变化: ${newDir}`)
            } else {
              await reply(true, `📂 正在切换工作目录到: ${newDir}\n⏳ 切换中...`)
              const wsResult = await applyWorkspaceDirChange(newDir)
              if (wsResult.ok) {
                broadcastLog(`[指令 /workspace] 已切换到 ${newDir}`, "INFO")
              } else {
                broadcastLog(`[指令 /workspace] 切换失败: ${wsResult.error}`, "ERROR")
              }
            }
          } else {
            await reply(false, "用法：/workspace 查看当前 | /workspace set <路径>")
          }
          break
        }

        case "/help": {
          const common = [
            "🔹 /status 运行状态",
            "🔹 /stop 停止Agent",
            "🔹 /reset 重置会话",
            "🔹 /help 指令列表",
          ]
          const adminOnly = [
            "🔹 /restart 重启应用",
            "🔹 /list 消息队列",
            "🔹 /clean 清空队列",
            "🔹 /task 定时任务",
            "🔹 /run 临时独立会话",
            "🔹 /model 模型设置",
            "🔹 /mcp MCP服务器管理",
            "🔹 /workspace 切换工作目录",
          ]
          const lines = isAdmin
            ? ["💡 可用指令（管理员）：", ...common, ...adminOnly]
            : ["💡 可用指令：", ...common]
          await reply(true, lines.join("\n"))
          break
        }

        default:
          await reply(false, `😅 未知指令: ${head}`)
      }
    } catch (e: unknown) {
      broadcastLog(`[指令] ${rawCmd} 执行异常: ${e instanceof Error ? e.message : e}`, "ERROR")
      try { await reply(false, `❌ 执行异常: ${e instanceof Error ? e.message : e}`) } catch { /* ignore */ }
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

function spawnAsync(args: string[], cwd: string, env: Record<string, string>): Promise<{ code: number; stdout: string; stderr: string; timedOut?: boolean }> {
  return new Promise((resolve) => {
    const mcpLabel = args.length >= 2 && args[0] === "mcp" ? `mcp-${args[1]}` : `mcp-${args[0] ?? "spawn"}`
    logCursorAgentInvocation(mcpLabel, args, cwd)
    let stdout = "", stderr = "", settled = false, didTimeout = false
    const done = (code: number) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code, stdout, stderr, timedOut: didTimeout || undefined })
    }
    const { agentNodePath: np, agentIndexPath: ip } = getAgentPaths()
    const child = np && ip
      ? spawn(np, [ip, ...args], {
          windowsHide: true, stdio: ["ignore", "pipe", "pipe"], cwd, env,
        })
      : spawn("agent", args.map(quoteArg), {
          shell: true, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], cwd, env,
        })
    child.stdout?.on("data", (d: Buffer) => { stdout += d.toString() })
    child.stderr?.on("data", (d: Buffer) => { stderr += d.toString() })
    child.on("error", () => done(1))
    child.on("exit", (code) => done(code ?? 1))
    const timer = setTimeout(() => { didTimeout = true; try { child.kill() } catch { /* */ }; done(1) }, 30_000)
  })
}

const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]/g

function isEnabledStatus(status: string): boolean {
  const s = status.toLowerCase()
  return s !== "disabled" && !s.includes("not loaded")
}

interface McpListCache { enabled: Record<string, boolean>; status: Record<string, string>; ts: number; ws: string }
const MCP_ENABLED_CACHE_TTL_MS = 30_000
let mcpListCache: McpListCache | null = null
let mcpListInflight: Promise<McpListCache> | null = null

async function fetchMcpList(force = false): Promise<McpListCache> {
  const config = getConfig()
  const ws = (config.workspaceDir || "").trim()
  const empty: McpListCache = { enabled: {}, status: {}, ts: 0, ws }
  if (!ws || !_resolveAgentBinary()) return empty
  if (!force && mcpListCache && mcpListCache.ws === ws && Date.now() - mcpListCache.ts < MCP_ENABLED_CACHE_TTL_MS) return mcpListCache
  if (mcpListInflight) return mcpListInflight

  const p = (async (): Promise<McpListCache> => {
    const env: Record<string, string> = { ...process.env as Record<string, string> }
    applyProxyEnv(env, config)
    try {
      const r = await spawnAsync(["mcp", "list"], ws, env)
      const clean = r.stdout.replace(ANSI_RE, "").replace(/\r/g, "")
      const enabled: Record<string, boolean> = {}
      const status: Record<string, string> = {}
      for (const line of clean.split("\n")) {
        const m = line.match(/^(.+?):\s+(.+)$/)
        if (m) {
          const name = m[1].trim(), raw = m[2].trim()
          enabled[name] = isEnabledStatus(raw)
          status[name] = raw.toLowerCase()
        }
      }
      const result: McpListCache = { enabled, status, ts: Date.now(), ws }
      mcpListCache = result
      return result
    } catch {
      return empty
    } finally {
      mcpListInflight = null
    }
  })()
  mcpListInflight = p
  return p
}

export async function getMcpEnabledMap(force = false): Promise<Record<string, boolean>> {
  return (await fetchMcpList(force)).enabled
}

export async function getMcpStatusMap(force = false): Promise<Record<string, string>> {
  return (await fetchMcpList(force)).status
}

export function invalidateMcpEnabledCache(): void {
  mcpListCache = null
}

export async function toggleMcpServer(serverName: string, enabled: boolean): Promise<{ ok: boolean; output: string }> {
  const config = getConfig()
  if (!config.workspaceDir) return { ok: false, output: "工作目录未配置" }
  if (!_resolveAgentBinary()) return { ok: false, output: "Cursor CLI 未安装" }

  const env: Record<string, string> = { ...process.env as Record<string, string> }
  applyProxyEnv(env, config)

  const sub = enabled ? "enable" : "disable"
  try {
    const r = await spawnAsync(["mcp", sub, serverName], config.workspaceDir, env)
    const out = (r.stdout + r.stderr).replace(ANSI_RE, "").replace(/\r/g, "").trim()
    broadcastLog(`[MCP ${sub}] ${serverName}: ${out}`, r.code === 0 ? "INFO" : "WARN")
    invalidateMcpEnabledCache()
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

    if (!_resolveAgentBinary()) {
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
      const { agentNodePath: np, agentIndexPath: ip } = getAgentPaths()
      if (np && ip) {
        mcpLoginChild = spawn(np, [ip, ...args], {
          windowsHide: false,
          stdio: ["ignore", "pipe", "pipe"],
          cwd: config.workspaceDir,
          env: spawnEnv,
        })
      } else {
        mcpLoginChild = spawn("agent", args.map(quoteArg), {
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
 * 切换工作目录：不终止任何 session，旧会话保留供用户切回。
 * 新消息会通过复合 sessionKey (chatId::workspaceDir) 路由到当前活跃目录。
 */
export async function applyWorkspaceDirChange(workspaceDir: string): Promise<{ ok: boolean; error?: string }> {
  const w = workspaceDir.trim()
  if (!w) return { ok: false, error: "工作目录为空" }

  saveConfig({ workspaceDir: w })
  invalidateMcpEnabledCache()
  injectWorkspaceMcpAndRules()
  broadcastStatus(await getDaemonStatus())
  return { ok: true }
}

/**
 * 在新工作目录下保存并重启 Daemon（由渲染进程在确认后调用）。
 */
export async function applyWorkspaceDirRestart(workspaceDir: string): Promise<{ ok: boolean; error?: string }> {
  const w = workspaceDir.trim()
  if (!w) return { ok: false, error: "工作目录为空" }
  saveConfig({ workspaceDir: w })
  await stopDaemon()
  const started = await startDaemon()
  broadcastStatus(await getDaemonStatus())
  if (!started.ok) return { ok: false, error: started.error ?? "Daemon 启动失败" }
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

  if (workspaceDirChanged) {
    invalidateMcpEnabledCache()
  }

  saveConfig(partial)
  return {
    ok: true,
    ...(workspaceDirChanged ? { workspaceDirChanged: true } : {}),
  }
}

// ── 初始化 ───────────────────────────────────────────────

export function initDaemonManager(): void {
  _setChatNameResolver((chatId) => chatNameCache.get(chatId))
  ipcMain.handle("config:apply-workspace-restart", (_, workspaceDir: string) => applyWorkspaceDirRestart(workspaceDir))
  ipcMain.handle("daemon:get-log-buffer", () => getLogBuffer())
  ipcMain.handle("agent:launch", () => launchAgent())
  ipcMain.handle("agent:stop", () => { stopAgent(); return { ok: true } })
  ipcMain.handle("agent:sessions", () => getSessionAgentList())
  ipcMain.handle("bind:start", async () => {
    const lock = readLockFile()
    if (!lock) return { ok: false, error: "Daemon 未运行" }
    try {
      await httpPost(`http://127.0.0.1:${lock.port}/start-bind`, {})
      return { ok: true }
    } catch {
      return { ok: false, error: "无法通知 Daemon" }
    }
  })
  ipcMain.handle("bind:test", async () => {
    const chatId = getConfig().larkReceiveId?.trim()
    if (!chatId) return { ok: false, error: "未绑定主用户" }
    const lock = readLockFile()
    if (!lock) return { ok: false, error: "Daemon 未运行" }
    try {
      await httpPost(`http://127.0.0.1:${lock.port}/test-bind`, { chatId })
      return { ok: true }
    } catch (e: any) {
      return { ok: false, error: e?.message ?? "发送失败" }
    }
  })
  ipcMain.handle("agent:stop-session", (_e, sessionKey: string) => { stopSessionAgent(sessionKey); return { ok: true } })
  ipcMain.handle("agent:stop-all-sessions", () => { stopAllSessionAgents(); return { ok: true } })

  ipcMain.handle("scheduled-tasks:get", () => {
    const tasks = readTasksFromFile()
    console.log("[IPC] scheduled-tasks:get returned", tasks.length, "tasks")
    return tasks
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

  ipcMain.handle("scheduled-tasks:trigger", async (_, taskId: string) => {
    const tasks = readTasksFromFile()
    const task = tasks.find((t) => t.id === taskId)
    if (!task) return { ok: false, error: "任务不存在" }
    const nowStr = new Date().toLocaleString("zh-CN")
    const content = `[定时任务: ${task.name}] (手动触发: ${nowStr})\n\n${task.content}`
    if (task.independent !== false) {
      return launchIndependentAgent(task.id, task.name, content)
    }
    const lock = readLockFile()
    if (!lock?.port) return { ok: false, error: "守护进程未运行" }
    try {
      await httpPost(`http://127.0.0.1:${lock.port}/enqueue`, { content })
      return { ok: true }
    } catch (e: unknown) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle("scheduled-tasks:get-status", () => getIndependentTaskStatuses())

  getDaemonStatus().then((status) => {
    if (status.running) {
      startStatusPolling()
    }
  })
}

export function cleanupDaemonManager(): void {
  stopStatusPolling()
  stopAgent()
  stopAllSessionAgents()
  if (daemonProcess) {
    try { daemonProcess.kill() } catch { /* ignore */ }
    daemonProcess = null
  }
  cachedPort = null
  activeDaemonWorkspaceDir = null
}

// ── MCP Server 工具列表查询（via Cursor CLI） ──────────────

export interface McpToolInfo {
  name: string
  description?: string
  params?: { name: string; type?: string; description?: string; required?: boolean }[]
}

function extractParams(schema: any): McpToolInfo["params"] {
  if (!schema?.properties) return undefined
  const required = new Set<string>(schema.required ?? [])
  return Object.entries(schema.properties).map(([k, v]: [string, any]) => ({
    name: k,
    type: v.type,
    description: v.description,
    required: required.has(k),
  }))
}

function queryToolsViaProtocol(cmd: string, args: string[], envOverride?: Record<string, string>): Promise<{ ok: boolean; tools: McpToolInfo[]; error?: string }> {
  return new Promise((resolve) => {
    const env: Record<string, string> = { ...process.env as Record<string, string>, ...(envOverride ?? {}) }
    if (!env.PATH && env.Path) env.PATH = env.Path

    let child: ReturnType<typeof spawn>
    try {
      child = spawn(quoteArg(cmd), args.map(quoteArg), { env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true, shell: true })
    } catch (e: any) {
      resolve({ ok: false, tools: [], error: `启动失败: ${e.message}` })
      return
    }

    let stdout = ""
    let phase: "init" | "list" | "done" = "init"
    const timeout = setTimeout(() => {
      try { child.kill() } catch { /* */ }
      resolve({ ok: false, tools: [], error: "查询超时" })
    }, 15_000)

    const finish = (result: { ok: boolean; tools: McpToolInfo[]; error?: string }) => {
      if (phase === "done") return
      phase = "done"
      clearTimeout(timeout)
      try { child.kill() } catch { /* */ }
      resolve(result)
    }

    child.stdout?.on("data", (data: Buffer) => {
      stdout += data.toString()
      for (const raw of stdout.split("\n")) {
        const line = raw.trim()
        if (!line) continue
        try {
          const msg = JSON.parse(line)
          if (msg.id === 1 && msg.result && phase === "init") {
            phase = "list"
            child.stdin?.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }) + "\n")
          }
          if (msg.id === 2 && msg.result?.tools) {
            const tools: McpToolInfo[] = (msg.result.tools as any[]).map((t: any) => ({ name: t.name, description: t.description, params: extractParams(t.inputSchema) }))
            finish({ ok: true, tools })
          }
        } catch { /* not json */ }
      }
    })

    child.on("error", (err) => finish({ ok: false, tools: [], error: `启动失败: ${err.message}` }))
    child.on("close", () => finish(phase === "init" ? { ok: false, tools: [], error: "进程退出，未获取到工具" } : { ok: true, tools: [] }))

    child.stdin?.write(JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "feishu-bridge", version: "1.0.0" } },
    }) + "\n")
  })
}

async function queryToolsViaHttp(url: string, headers?: Record<string, string>): Promise<{ ok: boolean; tools: McpToolInfo[]; error?: string }> {
  const rpc = (id: number, method: string, params: object = {}) => JSON.stringify({ jsonrpc: "2.0", id, method, params })
  const post = (body: string): Promise<any> => new Promise((resolve, reject) => {
    const u = new URL(url)
    const isHttps = u.protocol === "https:"
    const mod = isHttps ? require("node:https") : require("node:http")
    const req = mod.request(u, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...(headers ?? {}) },
      timeout: 10_000,
    }, (res: any) => {
      let data = ""
      res.on("data", (chunk: Buffer) => { data += chunk.toString() })
      res.on("end", () => {
        try {
          if (res.headers["content-type"]?.includes("text/event-stream")) {
            for (const line of data.split("\n")) {
              if (line.startsWith("data:")) {
                const parsed = JSON.parse(line.slice(5).trim())
                if (parsed.id !== undefined) { resolve(parsed); return }
              }
            }
          }
          resolve(JSON.parse(data))
        } catch { resolve(null) }
      })
    })
    req.on("error", reject)
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")) })
    req.write(body)
    req.end()
  })

  try {
    const initRes = await post(rpc(1, "initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "feishu-bridge", version: "1.0.0" } }))
    if (!initRes?.result) return { ok: false, tools: [], error: "initialize 失败" }
    const listRes = await post(rpc(2, "tools/list"))
    if (!listRes?.result?.tools) return { ok: false, tools: [], error: "tools/list 无结果" }
    const tools: McpToolInfo[] = (listRes.result.tools as any[]).map((t: any) => ({ name: t.name, description: t.description, params: extractParams(t.inputSchema) }))
    return { ok: true, tools }
  } catch (e: any) {
    return { ok: false, tools: [], error: e?.message ?? "HTTP 请求失败" }
  }
}

function queryToolsViaCli(serverName: string): Promise<{ ok: boolean; tools: McpToolInfo[]; error?: string }> {
  const config = getConfig()
  if (!config.workspaceDir || !_resolveAgentBinary()) return Promise.resolve({ ok: false, tools: [], error: "CLI 不可用" })
  const env: Record<string, string> = { ...process.env as Record<string, string> }
  applyProxyEnv(env, config)
  return spawnAsync(["mcp", "list-tools", serverName], config.workspaceDir, env).then((r) => {
    const clean = (r.stdout + r.stderr).replace(ANSI_RE, "").replace(/\r/g, "")
    if (r.code !== 0) return { ok: false, tools: [] as McpToolInfo[], error: clean.trim().split("\n").pop()?.trim() || `exit ${r.code}` }
    const tools: McpToolInfo[] = []
    for (const line of clean.split("\n")) {
      const m = line.match(/^[-–]\s+(\S+)/)
      if (m) tools.push({ name: m[1] })
    }
    return { ok: true, tools }
  })
}

export async function getMcpServerTools(serverName: string): Promise<{ ok: boolean; tools: McpToolInfo[]; error?: string }> {
  const servers = getMcpServerList()
  const server = servers.find((s) => s.name === serverName)
  if (!server) return { ok: false, tools: [], error: "MCP 服务器未找到" }

  if (server.type === "url" && server.url) {
    const headers = server.rawConfig?.headers as Record<string, string> | undefined
    const result = await queryToolsViaHttp(server.url, headers)
    if (result.ok && result.tools.length > 0) return result
  }

  if (server.type === "command" && server.command) {
    const result = await queryToolsViaProtocol(server.command, server.args ?? [], server.env)
    if (result.ok && result.tools.length > 0) return result
  }

  return queryToolsViaCli(serverName)
}
