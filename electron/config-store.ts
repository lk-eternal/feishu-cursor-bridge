import Store from "electron-store"

export interface ScheduledTask {
  id: string
  name: string
  cron: string
  content: string
  enabled: boolean
}

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
  /**
   * 由 /reset 设置：下一次成功拉起 Agent 时不带 --continue（新开 CLI 会话），启动成功后自动清除。
   * 不出现在设置 UI，仅本地 store。
   */
  agentSkipContinueNextLaunch: boolean
  /** 点关闭主窗口时：ask=弹窗选择；minimize=隐藏到托盘；quit=直接退出应用 */
  closeWindowAction: "ask" | "minimize" | "quit"
  scheduledTasks: ScheduledTask[]
  verifiedMcpServers: string[]
}

const defaults: AppConfig = {
  larkAppId: "",
  larkAppSecret: "",
  larkReceiveId: "",
  larkReceiveIdType: "open_id",
  workspaceDir: "",
  model: "auto",
  autoStart: false,
  setupComplete: false,
  httpProxy: "",
  httpsProxy: "",
  noProxy: "localhost,127.0.0.1",
  agentNewSession: false,
  agentSkipContinueNextLaunch: false,
  closeWindowAction: "ask",
  scheduledTasks: [],
  verifiedMcpServers: [],
}

const store = new Store<AppConfig>({
  name: "lark-bridge-config",
  encryptionKey: "lark-bridge-desktop-v1",
  defaults,
})

export function getConfig(): AppConfig {
  return { ...defaults, ...store.store }
}

export function saveConfig(partial: Partial<AppConfig>): void {
  for (const [key, value] of Object.entries(partial)) {
    if (value !== undefined) {
      store.set(key as keyof AppConfig, value as never)
    }
  }
}

export function resetConfig(): void {
  store.clear()
}
