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
  scheduledTasks: ScheduledTask[]
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
  scheduledTasks: [],
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
