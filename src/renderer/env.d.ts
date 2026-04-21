declare module "*.png" {
  const src: string
  export default src
}

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
  agentNewSession: boolean
  closeWindowAction: "ask" | "minimize" | "quit"
}

interface ScheduledTask {
  id: string
  name: string
  cron: string
  content: string
  enabled: boolean
  independent?: boolean
}

interface CliLoginStatus {
  cliFound: boolean
  loggedIn: boolean
  identityLine?: string
  error?: string
}

interface SkillTreeNode {
  name: string
  type: "file" | "directory"
  children?: SkillTreeNode[]
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
  model?: string
  workspaceMismatch?: boolean
  daemonWorkspaceDir?: string
}

interface AppModalRequestPayload {
  requestId: string
  title: string
  message: string
  detail?: string
  buttons: string[]
  defaultId?: number
  cancelId?: number
  variant?: "info" | "error" | "warning"
}

interface ConfigSaveResult {
  ok: boolean
  needWorkspaceDaemonChoice?: boolean
  oldWorkspaceDir?: string
  newWorkspaceDir?: string
  deferredSetupComplete?: boolean
  restartFailed?: string
  workspaceDirChanged?: boolean
}

interface ElectronAPI {
  getAppVersion(): Promise<string>
  checkAppUpdate(): Promise<
    | { status: "dev"; currentVersion: string; message: string }
    | { status: "error"; currentVersion: string; message: string }
    | { status: "latest"; currentVersion: string; latestVersion: string }
    | {
        status: "available"
        currentVersion: string
        latestVersion: string
        htmlUrl: string
        applyHint: string
        releaseNotes: string
      }
  >
  applyAppUpdate(): Promise<{ ok: boolean; error?: string; message?: string }>
  onUpdaterProgress(cb: (percent: number) => void): () => void
  onUpdaterError(cb: (message: string) => void): () => void
  onUpdaterStatus(cb: (payload: { kind: "available" } | { kind: "downloaded" } | { kind: "downloading" }) => void): () => void
  getConfig(): Promise<AppConfig>
  saveConfig(config: Partial<AppConfig>): Promise<ConfigSaveResult>
  applyWorkspaceDaemonRestart(workspaceDir: string): Promise<{ ok: boolean; error?: string }>
  respondWindowClose(payload: { action: "minimize" | "quit" | "cancel"; remember: boolean }): Promise<void>
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
  clearQueueMessages(): Promise<number>
  checkCli(): Promise<boolean>
  checkCliLogin(): Promise<CliLoginStatus>
  installCli(): Promise<{ ok: boolean; output: string }>
  loginCli(): Promise<{ ok: boolean; output: string }>
  listModels(): Promise<{ ok: boolean; models: { id: string; label: string; current: boolean }[]; error?: string }>
  getScheduledTasks(): Promise<ScheduledTask[]>
  saveScheduledTasks(tasks: ScheduledTask[]): Promise<{ ok: boolean }>
  validateCron(expression: string): Promise<boolean>
  previewCronNextRuns(expression: string): Promise<{ ok: true; runs: string[] } | { ok: false; error: string }>
  triggerScheduledTask(taskId: string): Promise<{ ok: boolean; error?: string }>
  getScheduledTaskStatus(): Promise<Record<string, { running: boolean; pid?: number; startedAt?: number }>>
  onScheduledTaskStatus(cb: (statuses: Record<string, { running: boolean; pid?: number; startedAt?: number }>) => void): () => void
  getOAuthMcps(): Promise<{ name: string; url: string; authenticated: boolean }[]>
  getMcpServers(): Promise<McpServerEntry[]>
  saveMcpServer(name: string, entry: Record<string, unknown>, source: "global" | "project"): Promise<{ ok: boolean }>
  deleteMcpServer(name: string): Promise<{ ok: boolean }>
  loginMcp(name: string): Promise<{ ok: boolean; output: string }>
  toggleMcp(name: string, enabled: boolean): Promise<{ ok: boolean; output: string }>
  getMcpEnabledMap(force?: boolean): Promise<Record<string, boolean>>
  getMcpStatusMap(force?: boolean): Promise<Record<string, string>>
  getMcpTools(name: string): Promise<{ ok: boolean; tools: { name: string; description?: string; params?: { name: string; type?: string; description?: string; required?: boolean }[] }[]; error?: string }>
  getRules(): Promise<{ name: string; content: string }[]>
  saveRule(name: string, content: string): Promise<{ ok: boolean }>
  deleteRule(name: string): Promise<{ ok: boolean }>
  getSkills(): Promise<{ name: string; content: string }[]>
  getSkillTree(): Promise<SkillTreeNode[]>
  readSkillFile(skillName: string, relativePath: string): Promise<{ ok: boolean; content?: string; error?: string }>
  saveSkillFile(skillName: string, relativePath: string, content: string): Promise<{ ok: boolean }>
  deleteSkillFile(skillName: string, relativePath: string): Promise<{ ok: boolean; error?: string }>
  createSkillDir(skillName: string, relativePath: string): Promise<{ ok: boolean }>
  saveSkill(name: string, content: string): Promise<{ ok: boolean }>
    renameSkill(oldName: string, newName: string): Promise<{ ok: boolean }>
    deleteSkill(name: string): Promise<{ ok: boolean }>
  onMcpLoginComplete(cb: (data: { serverName: string; ok: boolean }) => void): () => void
  onDaemonStatus(cb: (status: DaemonStatus) => void): () => void
  onDaemonLog(cb: (line: string) => void): () => void
  onWindowCloseConfirm(cb: () => void): () => void
  onAppModalRequest(cb: (payload: AppModalRequestPayload) => void): () => void
  respondAppModal(requestId: string, response: number): Promise<void>
}

declare global {
  interface Window {
    electronAPI: ElectronAPI
  }
}

export {}
