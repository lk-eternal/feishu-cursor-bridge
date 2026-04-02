import { contextBridge, ipcRenderer } from "electron"

export interface AppConfig {
  larkAppId: string
  larkAppSecret: string
  larkReceiveId: string
  larkReceiveIdType: "open_id" | "user_id" | "chat_id"
  workspaceDir: string
  model: string
  autoStart: boolean
  setupComplete: boolean
  httpProxy: string
  httpsProxy: string
  noProxy: string
}

export interface DaemonStatus {
  running: boolean
  version?: string
  uptime?: number
  agentRunning?: boolean
  agentPid?: number | null
  queueLength?: number
  hasTarget?: boolean
  autoOpenId?: string | null
  model?: string
  cliAvailable?: boolean
  error?: string
}

export interface ScheduledTask {
  id: string
  name: string
  cron: string
  content: string
  enabled: boolean
}

export interface InjectResult {
  file: string
  action: "created" | "updated" | "skipped"
  message: string
}

export interface McpAuthInfo {
  name: string
  url: string
  authenticated: boolean
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
  enabled?: boolean
}

const api = {
  getConfig: (): Promise<AppConfig> => ipcRenderer.invoke("config:get"),
  saveConfig: (config: Partial<AppConfig>): Promise<void> => ipcRenderer.invoke("config:save", config),
  selectDirectory: (): Promise<string | null> => ipcRenderer.invoke("dialog:selectDirectory"),
  injectWorkspace: (): Promise<{ results: InjectResult[] }> => ipcRenderer.invoke("workspace:inject"),
  startDaemon: (): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke("daemon:start"),
  launchAgent: (): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke("agent:launch"),
  stopAgent: (): Promise<{ ok: boolean }> => ipcRenderer.invoke("agent:stop"),
  stopDaemon: (): Promise<void> => ipcRenderer.invoke("daemon:stop"),
  getDaemonStatus: (): Promise<DaemonStatus> => ipcRenderer.invoke("daemon:status"),
  readLogs: (lines?: number): Promise<string> => ipcRenderer.invoke("logs:read", lines),
  getLogBuffer: (): Promise<string[]> => ipcRenderer.invoke("daemon:get-log-buffer"),
  clearLogs: (): Promise<void> => ipcRenderer.invoke("logs:clear"),
  getQueueMessages: (): Promise<{ index: number; preview: string }[]> => ipcRenderer.invoke("daemon:queue"),
  checkCli: (): Promise<boolean> => ipcRenderer.invoke("cli:check"),
  installCli: (): Promise<{ ok: boolean; output: string }> => ipcRenderer.invoke("cli:install"),
  loginCli: (): Promise<{ ok: boolean; output: string }> => ipcRenderer.invoke("cli:login"),
  listModels: (): Promise<{ ok: boolean; models: { id: string; label: string; current: boolean }[]; error?: string }> => ipcRenderer.invoke("models:list"),
  getScheduledTasks: (): Promise<ScheduledTask[]> => ipcRenderer.invoke("scheduled-tasks:get"),
  saveScheduledTasks: (tasks: ScheduledTask[]): Promise<{ ok: boolean }> => ipcRenderer.invoke("scheduled-tasks:save", tasks),
  validateCron: (expression: string): Promise<boolean> => ipcRenderer.invoke("scheduled-tasks:validate-cron", expression),
  getOAuthMcps: (): Promise<McpAuthInfo[]> => ipcRenderer.invoke("mcp:list-oauth"),
  getMcpServers: (): Promise<McpServerEntry[]> => ipcRenderer.invoke("mcp:list-all"),
  saveMcpServer: (name: string, entry: Record<string, unknown>, source: "global" | "project"): Promise<{ ok: boolean }> => ipcRenderer.invoke("mcp:save", name, entry, source),
  deleteMcpServer: (name: string): Promise<{ ok: boolean }> => ipcRenderer.invoke("mcp:delete", name),
  loginMcp: (name: string): Promise<{ ok: boolean; output: string }> => ipcRenderer.invoke("mcp:login", name),
  toggleMcp: (name: string, enabled: boolean): Promise<{ ok: boolean; output: string }> => ipcRenderer.invoke("mcp:toggle", name, enabled),
  getMcpEnabledMap: (): Promise<Record<string, boolean>> => ipcRenderer.invoke("mcp:enabled-map"),
  getRules: (): Promise<{ name: string; content: string }[]> => ipcRenderer.invoke("rules:list"),
  saveRule: (name: string, content: string): Promise<{ ok: boolean }> => ipcRenderer.invoke("rules:save", name, content),
  deleteRule: (name: string): Promise<{ ok: boolean }> => ipcRenderer.invoke("rules:delete", name),
  getSkills: (): Promise<{ name: string; content: string }[]> => ipcRenderer.invoke("skills:list"),
  saveSkill: (name: string, content: string): Promise<{ ok: boolean }> => ipcRenderer.invoke("skills:save", name, content),
  deleteSkill: (name: string): Promise<{ ok: boolean }> => ipcRenderer.invoke("skills:delete", name),
  onMcpLoginComplete: (cb: (data: { serverName: string; ok: boolean }) => void) => {
    const handler = (_: unknown, data: { serverName: string; ok: boolean }) => cb(data)
    ipcRenderer.on("mcp:login-complete", handler)
    return () => ipcRenderer.removeListener("mcp:login-complete", handler)
  },
  onDaemonStatus: (cb: (status: DaemonStatus) => void) => {
    const handler = (_: unknown, status: DaemonStatus) => cb(status)
    ipcRenderer.on("daemon:status-update", handler)
    return () => ipcRenderer.removeListener("daemon:status-update", handler)
  },
  onDaemonLog: (cb: (line: string) => void) => {
    const handler = (_: unknown, line: string) => cb(line)
    ipcRenderer.on("daemon:log", handler)
    return () => ipcRenderer.removeListener("daemon:log", handler)
  },
}

contextBridge.exposeInMainWorld("electronAPI", api)

export type ElectronAPI = typeof api
