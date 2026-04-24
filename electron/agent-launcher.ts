import { spawn, type ChildProcess } from "node:child_process"
import * as path from "node:path"
import * as fs from "node:fs"
import { app, BrowserWindow } from "electron"
import { getConfig, saveConfig, type AppConfig } from "./config-store"
import {
  resolveAgentBinary, getAgentPaths, applyProxyEnv, createAgentEnv,
  spawnAgentChild, execAgentSync, execAgentAsync, ensureAgentBinary, quoteArg,
  checkCliInstalled,
} from "./agent-cli"
import {
  broadcastLog, pushUiLog, flushAgentStreamChunk, logCursorAgentInvocation,
  broadcastSessionStatus as broadcastSessionStatusToUi,
  broadcastIndependentTaskStatus as broadcastIndependentStatusToUi,
} from "./ui-logger"

export const P2P_SESSION_KEY = "__p2p__"
const GROUP_IDLE_TIMEOUT_MS = 30 * 60 * 1000
const AGENT_COOLDOWN_MS = 15_000
const AGENT_NO_PREVIOUS_CHATS = /no previous chats found/i

let agentChild: ChildProcess | null = null
let lastAgentLaunchTime = 0

export function resetAgentCooldown(): void {
  lastAgentLaunchTime = 0
}

// ── 多会话管理 ─────────────────────────────────────────

interface SessionAgent {
  sessionKey: string
  child: ChildProcess
  pid: number
  startedAt: number
  lastActivityAt: number
  chatType: "p2p" | "group"
}

const sessionAgents = new Map<string, SessionAgent>()

function broadcastSessionStatus(): void {
  const list = [...sessionAgents.values()].map((s) => ({
    sessionKey: s.sessionKey, pid: s.pid, startedAt: s.startedAt,
    lastActivityAt: s.lastActivityAt, chatType: s.chatType,
  }))
  broadcastSessionStatusToUi(list)
}

// ── 独立任务 Agent ─────────────────────────────────────

interface IndependentAgent {
  taskId: string
  taskName: string
  pid: number
  child: ChildProcess
  startedAt: number
}

const independentAgents = new Map<string, IndependentAgent>()

function broadcastIndependentTaskStatus(): void {
  const statuses: Record<string, { running: boolean; pid?: number; startedAt?: number }> = {}
  for (const [taskId, agent] of independentAgents) {
    statuses[taskId] = { running: true, pid: agent.pid, startedAt: agent.startedAt }
  }
  broadcastIndependentStatusToUi(statuses)
}

// ── 状态查询 ──────────────────────────────────────────

export function isAgentRunning(): boolean {
  return agentChild !== null && !agentChild.killed && agentChild.exitCode === null
}

export function isSessionAgentRunning(sessionKey: string): boolean {
  const sa = sessionAgents.get(sessionKey)
  return sa !== null && sa !== undefined && !sa.child.killed && sa.child.exitCode === null
}

export function getRunningSessionCount(): number {
  let count = 0
  for (const sa of sessionAgents.values()) {
    if (!sa.child.killed && sa.child.exitCode === null) count++
  }
  if (isAgentRunning()) count++
  return count
}

export function getSessionAgentList() {
  return [...sessionAgents.values()].map((s) => ({
    sessionKey: s.sessionKey, pid: s.pid, startedAt: s.startedAt,
    chatType: s.chatType, lastActivityAt: s.lastActivityAt,
  }))
}

export function getAgentChildPid(): number | null {
  return agentChild?.pid ?? null
}

export function getSessionAgentCount(): number {
  return sessionAgents.size
}

export function getIndependentTaskStatuses(): Record<string, { running: boolean; pid?: number; startedAt?: number }> {
  const statuses: Record<string, { running: boolean; pid?: number; startedAt?: number }> = {}
  for (const [taskId, agent] of independentAgents) {
    statuses[taskId] = { running: true, pid: agent.pid, startedAt: agent.startedAt }
  }
  return statuses
}

// ── 内部工具 ──────────────────────────────────────────

function buildMetaBlock(meta?: LaunchMeta): string {
  if (!meta) return ""
  const parts: string[] = []
  if (meta.messageIds?.length) parts.push(`[message_ids=${meta.messageIds.join(",")}]`)
  if (meta.chatId) parts.push(`[chat_id=${meta.chatId}]`)
  if (meta.chatType) parts.push(`[chat_type=${meta.chatType}]`)
  return parts.length ? `\n\n---\n消息元数据(用于回复时传入 message_id 参数):\n${parts.join("\n")}` : ""
}

function buildPrompt(chatLabel: string, initialMessage?: string, meta?: LaunchMeta): string {
  const metaBlock = buildMetaBlock(meta)
  if (!initialMessage) {
    return chatLabel
      ? `请遵守飞书工作流规则feishu-cursor-bridge开始工作,${chatLabel} 先获取待处理的飞书消息，然后根据消息内容开始工作。`
      : "请遵守飞书工作流规则feishu-cursor-bridge开始工作,先获取待处理的飞书消息，然后根据消息内容开始工作。"
  }
  return `请遵守飞书工作流规则feishu-cursor-bridge开始工作,以下是待处理的消息或定时任务：\n\n${chatLabel ? chatLabel + "\n" : ""}${initialMessage}${metaBlock}`
}

function buildAgentLaunchArgs(config: AppConfig, prompt: string, resumeChatId: string | false): string[] {
  const args = [
    "--print", "--force",
    ...(resumeChatId ? ["--resume", resumeChatId] : []),
    "--approve-mcps", "--workspace", config.workspaceDir, "--trust",
  ]
  if (config.model && config.model !== "auto") args.push("--model", config.model)
  args.push(prompt)
  return args
}

function getMainChatId(config: AppConfig): string {
  return (config.mainChatIds ?? {})[config.workspaceDir]?.trim() || ""
}

export function setMainChatId(workspaceDir: string, chatId: string): void {
  const config = getConfig()
  const ids = { ...(config.mainChatIds ?? {}), [workspaceDir]: chatId }
  if (!chatId) delete ids[workspaceDir]
  saveConfig({ mainChatIds: ids })
}

function createChatId(config: AppConfig, spawnEnv: Record<string, string>): string | null {
  const ws = config.workspaceDir?.trim() || undefined
  const r = execAgentSync(
    ["create-chat", "--workspace", config.workspaceDir],
    spawnEnv,
    { timeoutMs: 15_000, cwd: ws, logLabel: "create-chat" },
  )
  if (!r.ok) {
    broadcastLog(`[Agent] create-chat 失败: ${r.error}`, "ERROR")
    return null
  }
  const chatId = r.stdout.trim().split(/\s+/).pop()?.trim()
  if (!chatId) {
    broadcastLog(`[Agent] create-chat 返回为空`, "ERROR")
    return null
  }
  setMainChatId(config.workspaceDir, chatId)
  broadcastLog(`[Agent] 创建主会话: ${chatId}`)
  return chatId
}

function ensureMainChatId(config: AppConfig, spawnEnv: Record<string, string>): string | null {
  return getMainChatId(config) || createChatId(config, spawnEnv)
}

// ── Agent 进程管理 ───────────────────────────────────

function makeSpawnEnv(config: AppConfig, extras?: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = { ...process.env as Record<string, string>, CURSOR_INVOKED_AS: "agent", ...extras }
  delete env.NODE_USE_ENV_PROXY
  applyProxyEnv(env, config)
  return env
}

function spawnAgentWithLogs(args: string[], env: Record<string, string>, label: string, cwd?: string): ChildProcess {
  logCursorAgentInvocation(label, args, cwd)
  const { agentNodePath, agentIndexPath } = getAgentPaths()
  if (agentNodePath && agentIndexPath) {
    return spawn(agentNodePath, [agentIndexPath, ...args], {
      windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env,
    })
  }
  return spawn("agent", args.map(quoteArg), {
    shell: process.platform === "win32", windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"], env,
  })
}

function attachStreamLoggers(child: ChildProcess): void {
  const outBuf = { current: "" }
  const errBuf = { current: "" }
  child.stdout?.on("data", (d: Buffer) => flushAgentStreamChunk(outBuf, d.toString(), "stdout"))
  child.stderr?.on("data", (d: Buffer) => flushAgentStreamChunk(errBuf, d.toString(), "stderr"))
  child.on("close", () => {
    if (outBuf.current.trim()) { pushUiLog("Agent", "INFO", outBuf.current.trim()); outBuf.current = "" }
    if (errBuf.current.trim()) { pushUiLog("Agent", "WARN", errBuf.current.trim()); errBuf.current = "" }
  })
}

function startAgentChildProcess(
  args: string[],
  spawnEnv: Record<string, string>,
  canRetryWithoutResume: boolean,
): { ok: boolean; error?: string } {
  let stdoutAcc = ""
  let stderrAcc = ""
  const agentOutBuf = { current: "" }
  const agentErrBuf = { current: "" }

  try {
    const ws = getConfig().workspaceDir?.trim() || undefined
    const child = spawnAgentWithLogs(args, spawnEnv, "launch", ws)
    agentChild = child

    child.stdout?.on("data", (d: Buffer) => {
      const chunk = d.toString(); stdoutAcc += chunk
      flushAgentStreamChunk(agentOutBuf, chunk, "stdout")
    })
    child.stderr?.on("data", (d: Buffer) => {
      const chunk = d.toString(); stderrAcc += chunk
      flushAgentStreamChunk(agentErrBuf, chunk, "stderr")
    })
    child.on("close", (code, signal) => {
      const combined = stdoutAcc + stderrAcc
      if (agentOutBuf.current.trim()) { pushUiLog("Agent", "INFO", agentOutBuf.current.trim()); agentOutBuf.current = "" }
      if (agentErrBuf.current.trim()) { pushUiLog("Agent", "WARN", agentErrBuf.current.trim()); agentErrBuf.current = "" }

      const resumeIdx = args.indexOf("--resume")
      if (canRetryWithoutResume && resumeIdx !== -1 && AGENT_NO_PREVIOUS_CHATS.test(combined)) {
        agentChild = null
        const config = getConfig()
        const newChatId = createChatId(config, spawnEnv)
        if (newChatId) {
          broadcastLog("[Agent] --resume 会话无效，已 create-chat 获取新会话并重试", "INFO")
          const retryArgs = [...args]; retryArgs[resumeIdx + 1] = newChatId
          startAgentChildProcess(retryArgs, spawnEnv, false)
        } else {
          broadcastLog("[Agent] --resume 会话无效且 create-chat 失败，去掉 --resume 启动", "WARN")
          const cleaned = [...args]; cleaned.splice(resumeIdx, 2)
          startAgentChildProcess(cleaned, spawnEnv, false)
        }
        return
      }
      pushUiLog("Agent", "INFO", `退出 code=${code}${signal ? ` signal=${signal}` : ""}`)
      agentChild = null
    })
    child.on("error", (e) => { pushUiLog("Agent", "ERROR", `进程错误: ${e.message}`); agentChild = null })
    broadcastLog(`Agent 已启动, pid=${child.pid}`)
    return { ok: true }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    broadcastLog(`[Agent] 启动失败: ${msg}`, "ERROR")
    return { ok: false, error: msg }
  }
}

// ── 公开 API ────────────────────────────────────────

export interface LaunchMeta { messageIds?: string[]; chatId?: string; chatType?: string }

export function launchAgent(initialMessage?: string, chatType?: string, meta?: LaunchMeta): { ok: boolean; error?: string } {
  if (isAgentRunning()) return { ok: true }
  const now = Date.now()
  if (now - lastAgentLaunchTime < AGENT_COOLDOWN_MS) return { ok: false, error: "冷却中" }
  lastAgentLaunchTime = now

  const config = getConfig()
  if (!config.workspaceDir) return { ok: false, error: "工作目录未配置" }
  if (!resolveAgentBinary()) return { ok: false, error: "Cursor CLI 未安装" }

  const chatLabel = chatType === "group" ? "[群聊消息]" : chatType === "p2p" ? "[私聊消息]" : ""
  const prompt = buildPrompt(chatLabel, initialMessage, meta)

  const spawnEnv = makeSpawnEnv(config)
  let resumeChatId: string | false = false

  if (config.agentNewSession) {
    if (getMainChatId(config)) setMainChatId(config.workspaceDir, "")
  } else {
    const chatId = ensureMainChatId(config, spawnEnv)
    if (chatId) resumeChatId = chatId
  }

  const args = buildAgentLaunchArgs(config, prompt, resumeChatId)
  return startAgentChildProcess(args, spawnEnv, !!resumeChatId)
}

export function stopAgent(): void {
  if (agentChild && !agentChild.killed) {
    try { agentChild.kill("SIGTERM") } catch { /* ignore */ }
  }
  agentChild = null
}

export function launchSessionAgent(sessionKey: string, chatType: "p2p" | "group", initialMessage?: string, injectRulesToDirFn?: (dir: string) => boolean, meta?: LaunchMeta, useMainWorkspace?: boolean): { ok: boolean; error?: string } {
  if (isSessionAgentRunning(sessionKey)) {
    const sa = sessionAgents.get(sessionKey)!
    sa.lastActivityAt = Date.now()
    return { ok: true }
  }

  const config = getConfig()
  let workDir = config.workspaceDir

  if (!useMainWorkspace) {
    if (chatType === "group" && !config.enableGroupChat) return { ok: false, error: "群聊未启用" }
    const safeChatId = sessionKey.replace(/[^a-zA-Z0-9_-]/g, "_")
    workDir = path.join(app.getPath("userData"), "group-workspaces", safeChatId)
    if (!fs.existsSync(workDir)) {
      fs.mkdirSync(workDir, { recursive: true })
      broadcastLog(`[Agent] 创建临时工作目录: ${workDir}`)
    }
    const staleProjectMcp = path.join(workDir, ".cursor", "mcp.json")
    if (fs.existsSync(staleProjectMcp)) {
      try { fs.unlinkSync(staleProjectMcp) } catch { /* ignore */ }
    }
    if (injectRulesToDirFn) injectRulesToDirFn(workDir)
  }

  if (!workDir) return { ok: false, error: "工作目录未配置" }
  if (!resolveAgentBinary()) return { ok: false, error: "Cursor CLI 未安装" }

  const chatLabel = chatType === "group" ? `[群聊会话 chat_id=${sessionKey}]` : "[私聊会话]"
  const prompt = buildPrompt(chatLabel, initialMessage, meta)

  const spawnEnv = makeSpawnEnv(config, { LARK_WORKSPACE_DIR: workDir })
  const overrideConfig = { ...config, workspaceDir: workDir }
  const chatId = ensureMainChatId(overrideConfig, spawnEnv)
  const args = buildAgentLaunchArgs(overrideConfig, prompt, chatId || false)

  try {
    const ws = workDir.trim() || undefined
    const child = spawnAgentWithLogs(args, spawnEnv, `session-${sessionKey}`, ws)
    attachStreamLoggers(child)

    child.on("close", (code, signal) => {
      pushUiLog("Agent", "INFO", `[${sessionKey}] 退出 code=${code}${signal ? ` signal=${signal}` : ""}`)
      sessionAgents.delete(sessionKey)
      broadcastSessionStatus()
    })
    child.on("error", (e) => {
      pushUiLog("Agent", "ERROR", `[${sessionKey}] 进程错误: ${e.message}`)
      sessionAgents.delete(sessionKey)
      broadcastSessionStatus()
    })

    sessionAgents.set(sessionKey, { sessionKey, child, pid: child.pid!, startedAt: Date.now(), lastActivityAt: Date.now(), chatType })
    broadcastLog(`[Agent] 会话 ${sessionKey} (${chatType}) 已启动, pid=${child.pid}`)
    broadcastSessionStatus()
    return { ok: true }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    broadcastLog(`[Agent] 启动失败 ${sessionKey}: ${msg}`, "ERROR")
    return { ok: false, error: msg }
  }
}

export function stopSessionAgent(sessionKey: string): void {
  const sa = sessionAgents.get(sessionKey)
  if (sa && !sa.child.killed) {
    try { sa.child.kill("SIGTERM") } catch { /* ignore */ }
  }
  sessionAgents.delete(sessionKey)
  broadcastSessionStatus()
}

export function stopAllSessionAgents(): void {
  for (const [key] of sessionAgents) stopSessionAgent(key)
}

export function reapIdleGroupAgents(): void {
  const now = Date.now()
  for (const [key, sa] of sessionAgents) {
    if (sa.chatType === "group" && (now - sa.lastActivityAt > GROUP_IDLE_TIMEOUT_MS)) {
      broadcastLog(`[Agent] 群聊会话 ${key} 空闲 ${Math.round((now - sa.lastActivityAt) / 60_000)} 分钟，自动回收`)
      stopSessionAgent(key)
    }
  }
}

export function launchIndependentAgent(taskId: string, taskName: string, message: string): { ok: boolean; error?: string } {
  const existing = independentAgents.get(taskId)
  if (existing && !existing.child.killed && existing.child.exitCode === null) {
    broadcastLog(`[独立任务] ${taskName} 上次运行仍在进行中, pid=${existing.pid}，跳过`)
    return { ok: false, error: "上次运行仍在进行中" }
  }

  const config = getConfig()
  if (!config.workspaceDir) return { ok: false, error: "工作目录未配置" }
  if (!resolveAgentBinary()) return { ok: false, error: "Cursor CLI 未安装" }

  const prompt = `请执行该定时任务,并通过飞书告知用户结果,执行完成后结束会话：\n\n${message}`
  const args = buildAgentLaunchArgs(config, prompt, false)
  const spawnEnv = makeSpawnEnv(config)

  try {
    const ws = config.workspaceDir?.trim() || undefined
    const child = spawnAgentWithLogs(args, spawnEnv, "launch-independent", ws)
    attachStreamLoggers(child)

    child.on("close", (code, signal) => {
      pushUiLog("IndAgent", "INFO", `[${taskName}] 退出 code=${code}${signal ? ` signal=${signal}` : ""}`)
      independentAgents.delete(taskId)
      broadcastIndependentTaskStatus()
    })
    child.on("error", (e) => {
      pushUiLog("IndAgent", "ERROR", `[${taskName}] 进程错误: ${e.message}`)
      independentAgents.delete(taskId)
      broadcastIndependentTaskStatus()
    })

    independentAgents.set(taskId, { taskId, taskName, pid: child.pid!, child, startedAt: Date.now() })
    broadcastLog(`[独立任务] ${taskName} 已启动, pid=${child.pid}`)
    broadcastIndependentTaskStatus()
    return { ok: true }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    broadcastLog(`[独立任务] ${taskName} 启动失败: ${msg}`, "ERROR")
    return { ok: false, error: msg }
  }
}

export async function checkAgentLoggedIn(): Promise<{ cliFound: boolean; loggedIn: boolean; identityLine?: string; error?: string }> {
  if (isAgentRunning()) {
    return { cliFound: true, loggedIn: true, identityLine: "Agent 运行中（已跳过 whoami）" }
  }
  if (!(await ensureAgentBinary())) {
    return { cliFound: false, loggedIn: false, error: "未找到 Cursor CLI（agent）" }
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
    const firstLine = out.split("\n").map((l) => l.trim()).find((l) => l.length > 0)
    return {
      cliFound: true, loggedIn, identityLine: firstLine,
      error: loggedIn ? undefined : (out || err || "未识别登录状态").slice(0, 400),
    }
  }
  return { cliFound: true, loggedIn: false, error: (out || err || r.error || "").trim().slice(0, 500) }
}

export function loginCli(): Promise<{ ok: boolean; output: string }> {
  return new Promise(async (resolve) => {
    if (!(await ensureAgentBinary())) {
      if (!(await checkCliInstalled())) {
        resolve({ ok: false, output: "Cursor CLI 未安装，请先安装" })
        return
      }
    }

    const config = getConfig()
    const spawnEnv = makeSpawnEnv(config)
    let output = ""
    let settled = false

    broadcastLog("[CLI Login] 正在打开浏览器进行 Cursor 账号授权...")
    logCursorAgentInvocation("cli-login", ["login"], undefined)

    try {
      const { agentNodePath, agentIndexPath } = getAgentPaths()
      let child: ChildProcess
      if (agentNodePath && agentIndexPath) {
        child = spawn(agentNodePath, [agentIndexPath, "login"], {
          windowsHide: false, stdio: ["ignore", "pipe", "pipe"], env: spawnEnv,
        })
      } else {
        child = spawn("agent", ["login"], {
          shell: process.platform === "win32", windowsHide: false,
          stdio: ["ignore", "pipe", "pipe"], env: spawnEnv,
        })
      }

      child.stdout?.on("data", (d: Buffer) => {
        const s = d.toString().trim(); output += s + "\n"
        if (s) broadcastLog(`[CLI Login] ${s}`, "INFO")
      })
      child.stderr?.on("data", (d: Buffer) => {
        const s = d.toString().trim(); output += s + "\n"
        if (s) broadcastLog(`[CLI Login:err] ${s}`, "ERROR")
      })
      child.on("exit", async (code) => {
        if (settled) return; settled = true
        if (code !== 0) { resolve({ ok: false, output: output || `登录失败 (exit code: ${code})` }); return }
        for (let i = 0; i < 5; i++) {
          await new Promise((r) => setTimeout(r, 1000))
          const st = await checkAgentLoggedIn()
          if (st.loggedIn) { resolve({ ok: true, output: "Cursor CLI 登录授权成功！" }); return }
        }
        resolve({ ok: true, output: "登录流程已完成，但 whoami 未确认登录态，请刷新重试" })
      })
      child.on("error", (e) => { if (settled) return; settled = true; resolve({ ok: false, output: `登录进程错误: ${e.message}` }) })
      setTimeout(() => {
        if (!settled) { settled = true; if (!child.killed) try { child.kill() } catch { /* ignore */ }; resolve({ ok: false, output: "登录超时（2分钟），请重试" }) }
      }, 120_000)
    } catch (e: unknown) {
      resolve({ ok: false, output: `启动登录失败: ${e instanceof Error ? e.message : String(e)}` })
    }
  })
}
