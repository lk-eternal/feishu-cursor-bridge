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

interface DaemonStatus {
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

interface ElectronAPI {
  getConfig(): Promise<AppConfig>
  saveConfig(config: Partial<AppConfig>): Promise<void>
  selectDirectory(): Promise<string | null>
  injectWorkspace(): Promise<{ mcpOk: boolean; ruleOk: boolean }>
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
  listModels(): Promise<{ ok: boolean; models: { id: string; label: string; current: boolean }[]; error?: string }>
  getScheduledTasks(): Promise<ScheduledTask[]>
  saveScheduledTasks(tasks: ScheduledTask[]): Promise<{ ok: boolean }>
  validateCron(expression: string): Promise<boolean>
  onDaemonStatus(cb: (status: DaemonStatus) => void): () => void
  onDaemonLog(cb: (line: string) => void): () => void
}

declare global {
  interface Window {
    electronAPI: ElectronAPI
  }
}

export {}
