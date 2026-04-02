interface AppConfig {
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

interface ScheduledTask {
  id: string
  name: string
  cron: string
  content: string
  enabled: boolean
}

interface McpServerEntry {
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

interface DaemonStatus {
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

interface ElectronAPI {
  getConfig(): Promise<AppConfig>
  saveConfig(config: Partial<AppConfig>): Promise<void>
  selectDirectory(): Promise<string | null>
  injectWorkspace(): Promise<{ results: { file: string; action: string; message: string }[] }>
  startDaemon(): Promise<{ ok: boolean; error?: string }>
  stopDaemon(): Promise<void>
  launchAgent(): Promise<{ ok: boolean; error?: string }>
  stopAgent(): Promise<{ ok: boolean }>
  getDaemonStatus(): Promise<DaemonStatus>
  readLogs(lines?: number): Promise<string>
  getLogBuffer(): Promise<string[]>
  clearLogs(): Promise<void>
  getQueueMessages(): Promise<{ index: number; preview: string }[]>
  checkCli(): Promise<boolean>
  installCli(): Promise<{ ok: boolean; output: string }>
  loginCli(): Promise<{ ok: boolean; output: string }>
  listModels(): Promise<{ ok: boolean; models: { id: string; label: string; current: boolean }[]; error?: string }>
  getScheduledTasks(): Promise<ScheduledTask[]>
  saveScheduledTasks(tasks: ScheduledTask[]): Promise<{ ok: boolean }>
  validateCron(expression: string): Promise<boolean>
  getOAuthMcps(): Promise<{ name: string; url: string; authenticated: boolean }[]>
  getMcpServers(): Promise<McpServerEntry[]>
  saveMcpServer(name: string, entry: Record<string, unknown>, source: "global" | "project"): Promise<{ ok: boolean }>
  deleteMcpServer(name: string): Promise<{ ok: boolean }>
  loginMcp(name: string): Promise<{ ok: boolean; output: string }>
  toggleMcp(name: string, enabled: boolean): Promise<{ ok: boolean; output: string }>
  getMcpEnabledMap(): Promise<Record<string, boolean>>
  getRules(): Promise<{ name: string; content: string }[]>
  saveRule(name: string, content: string): Promise<{ ok: boolean }>
  deleteRule(name: string): Promise<{ ok: boolean }>
  getSkills(): Promise<{ name: string; content: string }[]>
  saveSkill(name: string, content: string): Promise<{ ok: boolean }>
  deleteSkill(name: string): Promise<{ ok: boolean }>
  onMcpLoginComplete(cb: (data: { serverName: string; ok: boolean }) => void): () => void
  onDaemonStatus(cb: (status: DaemonStatus) => void): () => void
  onDaemonLog(cb: (line: string) => void): () => void
}

declare global {
  interface Window {
    electronAPI: ElectronAPI
  }
}

export {}
