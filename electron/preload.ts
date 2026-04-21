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
  agentNewSession: boolean
  closeWindowAction: "ask" | "minimize" | "quit"
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
  workspaceMismatch?: boolean
  daemonWorkspaceDir?: string
}

export interface ConfigSaveResult {
  ok: boolean
  needWorkspaceDaemonChoice?: boolean
  oldWorkspaceDir?: string
  newWorkspaceDir?: string
  deferredSetupComplete?: boolean
  restartFailed?: string
  workspaceDirChanged?: boolean
}

export interface ScheduledTask {
  id: string
  name: string
  cron: string
  content: string
  enabled: boolean
  independent?: boolean
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

export interface CliLoginStatus {
  cliFound: boolean
  loggedIn: boolean
  identityLine?: string
  error?: string
}

export type UpdaterCheckResult =
  | { status: "dev"; currentVersion: string; message: string }
  | { status: "error"; currentVersion: string; message: string }
  | { status: "latest"; currentVersion: string; latestVersion: string }
  | {
      status: "available"
      currentVersion: string
      latestVersion: string
      htmlUrl: string
      applyHint: string
    }

export interface UpdaterApplyResult {
  ok: boolean
  error?: string
  message?: string
}

export type UpdaterStatusPayload =
  | { kind: "available" }
  | { kind: "downloaded" }
  | { kind: "downloading" }

export interface AppModalRequestPayload {
  requestId: string
  title: string
  message: string
  detail?: string
  buttons: string[]
  defaultId?: number
  cancelId?: number
  variant?: "info" | "error" | "warning"
}

export interface SkillTreeNode {
  name: string
  type: "file" | "directory"
  children?: SkillTreeNode[]
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
  getAppVersion: (): Promise<string> => ipcRenderer.invoke("updater:current-version"),
  checkAppUpdate: (): Promise<UpdaterCheckResult> => ipcRenderer.invoke("updater:check"),
  applyAppUpdate: (): Promise<UpdaterApplyResult> => ipcRenderer.invoke("updater:apply"),
  onUpdaterProgress: (cb: (percent: number) => void): (() => void) => {
    const handler = (_: unknown, percent: number) => cb(percent)
    ipcRenderer.on("updater:progress", handler)
    return () => ipcRenderer.removeListener("updater:progress", handler)
  },
  onUpdaterError: (cb: (message: string) => void): (() => void) => {
    const handler = (_: unknown, message: string) => cb(message)
    ipcRenderer.on("updater:error", handler)
    return () => ipcRenderer.removeListener("updater:error", handler)
  },
  onUpdaterStatus: (cb: (payload: UpdaterStatusPayload) => void): (() => void) => {
    const handler = (_: unknown, payload: UpdaterStatusPayload) => cb(payload)
    ipcRenderer.on("updater:status", handler)
    return () => ipcRenderer.removeListener("updater:status", handler)
  },
  getConfig: (): Promise<AppConfig> => ipcRenderer.invoke("config:get"),
  saveConfig: (config: Partial<AppConfig>): Promise<ConfigSaveResult> => ipcRenderer.invoke("config:save", config),
  applyWorkspaceDaemonRestart: (workspaceDir: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke("config:apply-workspace-restart", workspaceDir),
  respondWindowClose: (payload: { action: "minimize" | "quit" | "cancel"; remember: boolean }): Promise<void> =>
    ipcRenderer.invoke("window:close-confirm-result", payload),
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
  clearQueueMessages: (): Promise<number> => ipcRenderer.invoke("daemon:queue-clear"),
  checkCli: (): Promise<boolean> => ipcRenderer.invoke("cli:check"),
  checkCliLogin: (): Promise<CliLoginStatus> => ipcRenderer.invoke("cli:login-status"),
  installCli: (): Promise<{ ok: boolean; output: string }> => ipcRenderer.invoke("cli:install"),
  loginCli: (): Promise<{ ok: boolean; output: string }> => ipcRenderer.invoke("cli:login"),
  listModels: (): Promise<{ ok: boolean; models: { id: string; label: string; current: boolean }[]; error?: string }> => ipcRenderer.invoke("models:list"),
  getScheduledTasks: (): Promise<ScheduledTask[]> => ipcRenderer.invoke("scheduled-tasks:get"),
  saveScheduledTasks: (tasks: ScheduledTask[]): Promise<{ ok: boolean }> => ipcRenderer.invoke("scheduled-tasks:save", tasks),
  validateCron: (expression: string): Promise<boolean> => ipcRenderer.invoke("scheduled-tasks:validate-cron", expression),
  previewCronNextRuns: (expression: string): Promise<{ ok: true; runs: string[] } | { ok: false; error: string }> =>
    ipcRenderer.invoke("scheduled-tasks:preview-cron", expression),
  triggerScheduledTask: (taskId: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke("scheduled-tasks:trigger", taskId),
  getScheduledTaskStatus: (): Promise<Record<string, { running: boolean; pid?: number; startedAt?: number }>> =>
    ipcRenderer.invoke("scheduled-tasks:get-status"),
  onScheduledTaskStatus: (cb: (statuses: Record<string, { running: boolean; pid?: number; startedAt?: number }>) => void) => {
    const handler = (_: unknown, statuses: Record<string, { running: boolean; pid?: number; startedAt?: number }>) => cb(statuses)
    ipcRenderer.on("scheduled-tasks:status", handler)
    return () => ipcRenderer.removeListener("scheduled-tasks:status", handler)
  },
  getOAuthMcps: (): Promise<McpAuthInfo[]> => ipcRenderer.invoke("mcp:list-oauth"),
  getMcpServers: (): Promise<McpServerEntry[]> => ipcRenderer.invoke("mcp:list-all"),
  saveMcpServer: (name: string, entry: Record<string, unknown>, source: "global" | "project"): Promise<{ ok: boolean }> => ipcRenderer.invoke("mcp:save", name, entry, source),
  deleteMcpServer: (name: string): Promise<{ ok: boolean }> => ipcRenderer.invoke("mcp:delete", name),
  loginMcp: (name: string): Promise<{ ok: boolean; output: string }> => ipcRenderer.invoke("mcp:login", name),
  toggleMcp: (name: string, enabled: boolean): Promise<{ ok: boolean; output: string }> => ipcRenderer.invoke("mcp:toggle", name, enabled),
  getMcpEnabledMap: (force?: boolean): Promise<Record<string, boolean>> => ipcRenderer.invoke("mcp:enabled-map", force),
  getMcpStatusMap: (force?: boolean): Promise<Record<string, string>> => ipcRenderer.invoke("mcp:status-map", force),
  getMcpTools: (name: string): Promise<{ ok: boolean; tools: { name: string; description?: string; params?: { name: string; type?: string; description?: string; required?: boolean }[] }[]; error?: string }> => ipcRenderer.invoke("mcp:tools", name),
  getRules: (): Promise<{ name: string; content: string }[]> => ipcRenderer.invoke("rules:list"),
  saveRule: (name: string, content: string): Promise<{ ok: boolean }> => ipcRenderer.invoke("rules:save", name, content),
  deleteRule: (name: string): Promise<{ ok: boolean }> => ipcRenderer.invoke("rules:delete", name),
  getSkills: (): Promise<{ name: string; content: string }[]> => ipcRenderer.invoke("skills:list"),
  getSkillTree: (): Promise<SkillTreeNode[]> => ipcRenderer.invoke("skills:tree"),
  readSkillFile: (skillName: string, relativePath: string): Promise<{ ok: boolean; content?: string; error?: string }> => ipcRenderer.invoke("skills:read-file", skillName, relativePath),
  saveSkillFile: (skillName: string, relativePath: string, content: string): Promise<{ ok: boolean }> => ipcRenderer.invoke("skills:save-file", skillName, relativePath, content),
  deleteSkillFile: (skillName: string, relativePath: string): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke("skills:delete-file", skillName, relativePath),
  createSkillDir: (skillName: string, relativePath: string): Promise<{ ok: boolean }> => ipcRenderer.invoke("skills:create-dir", skillName, relativePath),
  saveSkill: (name: string, content: string): Promise<{ ok: boolean }> => ipcRenderer.invoke("skills:save", name, content),
    renameSkill: (oldName: string, newName: string): Promise<{ ok: boolean }> => ipcRenderer.invoke("skills:rename", oldName, newName),
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
  onWindowCloseConfirm: (cb: () => void) => {
    const handler = () => cb()
    ipcRenderer.on("window:close-confirm", handler)
    return () => ipcRenderer.removeListener("window:close-confirm", handler)
  },
  onAppModalRequest: (cb: (payload: AppModalRequestPayload) => void) => {
    const handler = (_: unknown, payload: AppModalRequestPayload) => cb(payload)
    ipcRenderer.on("app:modal-request", handler)
    return () => ipcRenderer.removeListener("app:modal-request", handler)
  },
  respondAppModal: (requestId: string, response: number): Promise<void> =>
    ipcRenderer.invoke("app:modal-result", { requestId, response }),

  windowMinimize: (): Promise<void> => ipcRenderer.invoke("window:minimize"),
  windowMaximize: (): Promise<void> => ipcRenderer.invoke("window:maximize"),
  windowClose: (): Promise<void> => ipcRenderer.invoke("window:close"),
  windowIsMaximized: (): Promise<boolean> => ipcRenderer.invoke("window:is-maximized"),
  onWindowMaximizedChange: (cb: (maximized: boolean) => void) => {
    const handler = (_: unknown, maximized: boolean) => cb(maximized)
    ipcRenderer.on("window:maximized-change", handler)
    return () => ipcRenderer.removeListener("window:maximized-change", handler)
  },
}

contextBridge.exposeInMainWorld("electronAPI", api)

export type ElectronAPI = typeof api
