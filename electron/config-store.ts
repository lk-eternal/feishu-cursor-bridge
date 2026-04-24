import Store from "electron-store"

export interface ScheduledTask {
  id: string
  name: string
  cron: string
  content: string
  enabled: boolean
  independent?: boolean
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
  /** 点关闭主窗口时：ask=弹窗选择；minimize=隐藏到托盘；quit=直接退出应用 */
  closeWindowAction: "ask" | "minimize" | "quit"
  scheduledTasks: ScheduledTask[]
  verifiedMcpServers: string[]
  /** 主会话 chatId 映射（workspaceDir → chatId），用于 --resume 恢复上下文 */
  mainChatIds: Record<string, string>
  enableGroupChat: boolean
  digitalIdentity: string
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
  noProxy: "localhost,127.0.0.1,feishu.cn",
  agentNewSession: false,
  closeWindowAction: "ask",
  scheduledTasks: [],
  verifiedMcpServers: [],
  mainChatIds: {},
  enableGroupChat: false,
  digitalIdentity: "",
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
  const cleaned = Object.fromEntries(
    Object.entries(partial).filter(([, v]) => v !== undefined),
  )
  if (Object.keys(cleaned).length > 0) {
    store.set(cleaned as Partial<AppConfig>)
  }
}

export function resetConfig(): void {
  store.clear()
}
