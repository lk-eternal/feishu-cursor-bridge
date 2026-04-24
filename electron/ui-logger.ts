import { BrowserWindow } from "electron"

const LOG_BUFFER_MAX = 300
const logBuffer: string[] = []

function uiTimestamp(): string {
  const d = new Date()
  const p2 = (n: number) => String(n).padStart(2, "0")
  const p3 = (n: number) => String(n).padStart(3, "0")
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}.${p3(d.getMilliseconds())}`
}

export function escapeLogContentSingleLine(s: string): string {
  return s.replace(/\r?\n/g, "\\n")
}

function formatUnifiedUiLog(processName: string, level: string, content: string): string {
  return `${uiTimestamp()} [${processName}] ${level} ${escapeLogContentSingleLine(content)}`
}

export function pushLog(line: string): void {
  logBuffer.push(line)
  if (logBuffer.length > LOG_BUFFER_MAX) logBuffer.splice(0, logBuffer.length - LOG_BUFFER_MAX)
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send("daemon:log", line)
  }
}

export function pushUiLog(processName: string, level: string, content: string): void {
  pushLog(formatUnifiedUiLog(processName, level, content))
}

export function broadcastLog(message: string, level: string = "INFO"): void {
  pushUiLog("Electron", level, message)
}

export function getLogBuffer(): string[] {
  return [...logBuffer]
}

export function clearLogBuffer(): void {
  logBuffer.length = 0
}

export function flushAgentStreamChunk(
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

export function broadcastSessionStatus(sessionData: { sessionKey: string; pid: number; startedAt: number; lastActivityAt: number; chatType: string }[]): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send("agent:sessions", sessionData)
  }
}

export function broadcastIndependentTaskStatus(statuses: Record<string, { running: boolean; pid?: number; startedAt?: number }>): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send("scheduled-tasks:status", statuses)
  }
}

export function logCursorAgentInvocation(logLabel: string, agentArgs: string[], cwd?: string): void {
  const cwdSuffix = cwd != null && cwd !== "" ? `${cwd} ` : ""
  pushUiLog("Agent", "INFO", `[CLI ${logLabel}] ${cwdSuffix}agent ${agentArgs.join(" ")}`)
}
