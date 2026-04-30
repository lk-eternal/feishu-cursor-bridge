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
} from "./ui-logger"

export const P2P_SESSION_KEY = "__p2p__"
export function makeMainP2pSessionKey(chatId: string, workspaceDir: string): string {
  return `${chatId}::${workspaceDir}`
}
const GROUP_IDLE_TIMEOUT_MS = 30 * 60 * 1000
const AGENT_NO_PREVIOUS_CHATS = /no previous chats found/i

// ── 会话 Agent ──────────────────────────────────────────

export type ChatType = "p2p" | "group" | "task" | "temp_chat"

interface SessionAgent {
  sessionKey: string
  child: ChildProcess
  pid: number
  startedAt: number
  lastActivityAt: number
  chatType: ChatType
  workspaceDir?: string
  senderOpenId?: string
  chatName?: string
}

const sessionAgents = new Map<string, SessionAgent>()

let chatNameResolver: ((chatId: string) => string | undefined) | null = null

export function setChatNameResolver(fn: (chatId: string) => string | undefined): void {
  chatNameResolver = fn
}

function broadcastSessionStatus(): void {
  const list = [...sessionAgents.values()].map((s) => {
    const chatId = s.sessionKey.includes("::") ? s.sessionKey.split("::")[0] : s.sessionKey
    return {
      sessionKey: s.sessionKey, pid: s.pid, startedAt: s.startedAt,
      lastActivityAt: s.lastActivityAt, chatType: s.chatType as string,
      chatName: s.chatName || chatNameResolver?.(chatId) || (s.senderOpenId && chatNameResolver?.(s.senderOpenId)),
      workspaceDir: s.workspaceDir,
    }
  })
  broadcastSessionStatusToUi(list)
}

// ── 状态查询 ──────────────────────────────────────────

export function isAgentRunning(): boolean {
  return getRunningSessionCount() > 0
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
  return count
}

export function getSessionAgentList() {
  return [...sessionAgents.values()].map((s) => ({
    sessionKey: s.sessionKey, pid: s.pid, startedAt: s.startedAt,
    chatType: s.chatType, lastActivityAt: s.lastActivityAt,
    workspaceDir: s.workspaceDir, senderOpenId: s.senderOpenId,
    chatName: s.chatName,
  }))
}

export function getAgentChildPid(): number | null {
  const first = sessionAgents.values().next()
  return first.done ? null : first.value.pid
}

export function getSessionAgentCount(): number {
  return sessionAgents.size
}

export function getIndependentTaskStatuses(): Record<string, { running: boolean; pid?: number; startedAt?: number }> {
  const statuses: Record<string, { running: boolean; pid?: number; startedAt?: number }> = {}
  for (const [key, agent] of sessionAgents) {
    if (agent.chatType === "task") {
      statuses[key] = { running: true, pid: agent.pid, startedAt: agent.startedAt }
    }
  }
  return statuses
}

// ── Prompt 构建 ──────────────────────────────────────────

export interface LaunchMeta { messageIds?: string[]; chatId?: string; chatType?: string }

function buildPrompt(meta?: LaunchMeta, taskMessage?: string): string {
  const prompts: string[] = []
  prompts.push("请按照digital-identity数字身份定义并遵守飞书工作流规则feishu-cursor-bridge开始工作")

  if(meta?.chatType === "p2p" || meta?.chatType === "group"){
    prompts.push("如果你当前正在执行任务（上下文中已有进行中的工作），请直接继续，不要重复处理已完成的内容。")
    prompts.push("否则，请立即通过 sync_message 工具获取待处理的飞书消息并开始工作。")
  }
  if(meta?.chatType === "temp_chat"){
    prompts.push("请立即通过 sync_message 工具获取待处理的飞书消息并开始工作。")
  }
  if(meta?.chatType === "task" && taskMessage){
    prompts.push("[定时任务]")
    prompts.push(taskMessage)
  }

  prompts.push("\n\n---\n会话元数据:\n")
  prompts.push(`[chat_id=${meta?.chatId}]`)
  prompts.push(`[chat_type=${meta?.chatType}]`)

  return prompts.join("\n")
}

// ── 进程管理工具 ─────────────────────────────────────────

function makeSpawnEnv(config: AppConfig, extras?: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = { ...process.env as Record<string, string>, CURSOR_INVOKED_AS: "agent", ...extras }
  delete env.NODE_USE_ENV_PROXY
  applyProxyEnv(env, config)
  return env
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

export function getMainChatId(config: AppConfig): string {
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

// ── 公开 API ────────────────────────────────────────

export interface LaunchAgentOptions {
  sessionKey: string
  chatType: ChatType
  injectWorkspaceFn?: (dir: string) => boolean | Promise<boolean>
  meta?: LaunchMeta
  useMainWorkspace?: boolean
  senderOpenId?: string
  chatName?: string
  taskMessage?: string
}

export async function launchSessionAgent(
  sessionKey: string,
  chatType: "p2p" | "group",
  injectWorkspaceFn?: (dir: string) => boolean | Promise<boolean>,
  meta?: LaunchMeta,
  useMainWorkspace?: boolean,
  senderOpenId?: string,
): Promise<{ ok: boolean; error?: string }> {
  return launchAgent({ sessionKey, chatType, injectWorkspaceFn, meta, useMainWorkspace, senderOpenId })
}

export async function launchAgent(opts: LaunchAgentOptions): Promise<{ ok: boolean; error?: string }> {
  const { sessionKey, chatType, injectWorkspaceFn, meta, senderOpenId, chatName, taskMessage } = opts
  const needResume = chatType === "p2p" || chatType === "group"
  const useMainWorkspace = opts.useMainWorkspace ?? (chatType === "task" || chatType === "temp_chat")

  if (isSessionAgentRunning(sessionKey)) {
    sessionAgents.get(sessionKey)!.lastActivityAt = Date.now()
    return { ok: true }
  }

  const config = getConfig()
  let workDir = config.workspaceDir

  if (!useMainWorkspace) {
    if (chatType === "group" && !config.enableGroupChat) return { ok: false, error: "群聊未启用" }
    const safeChatId = sessionKey.replace(/[^a-zA-Z0-9_-]/g, "_")
    const appId = config.larkAppId || "default"
    workDir = path.join(app.getPath("userData"), "apps", appId, "workspaces", safeChatId)
    if (!fs.existsSync(workDir)) {
      fs.mkdirSync(workDir, { recursive: true })
      broadcastLog(`[Agent] 创建临时工作目录: ${workDir}`)
    }
    if (injectWorkspaceFn) await injectWorkspaceFn(workDir)
  }

  if (!workDir) return { ok: false, error: "工作目录未配置" }
  if (!resolveAgentBinary()) return { ok: false, error: "Cursor CLI 未安装" }

  const prompt = buildPrompt(meta, taskMessage)
  const spawnEnv = makeSpawnEnv(config, { LARK_WORKSPACE_DIR: workDir })
  const overrideConfig = { ...config, workspaceDir: workDir }

  let resumeChatId: string | false = false
  if (needResume) {
    if (config.agentNewSession) {
      if (getMainChatId(overrideConfig)) setMainChatId(workDir, "")
    } else {
      const cid = ensureMainChatId(overrideConfig, spawnEnv)
      if (cid) resumeChatId = cid
    }
  }

  const args = buildAgentLaunchArgs(overrideConfig, prompt, resumeChatId)

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

    sessionAgents.set(sessionKey, {
      sessionKey, child, pid: child.pid!, startedAt: Date.now(), lastActivityAt: Date.now(),
      chatType, workspaceDir: workDir, senderOpenId, chatName,
    })
    broadcastLog(`[Agent] 会话 ${sessionKey} (${chatType}) 已启动, pid=${child.pid}`)
    broadcastSessionStatus()
    return { ok: true }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    broadcastLog(`[Agent] 启动失败 ${sessionKey}: ${msg}`, "ERROR")
    return { ok: false, error: msg }
  }
}

export function stopAgent(): void {
  stopAllSessionAgents()
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

export async function launchIndependentAgent(taskId: string, taskName: string, message: string): Promise<{ ok: boolean; error?: string }> {
  return launchAgent({
    sessionKey: taskId,
    chatType: "task",
    chatName: taskName,
    taskMessage: message,
    meta: { chatId: taskName, chatType: "task" },
  })
}

// ── CLI 登录 ────────────────────────────────────────

export async function checkAgentLoggedIn(): Promise<{ cliFound: boolean; loggedIn: boolean; identityLine?: string; error?: string }> {
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
