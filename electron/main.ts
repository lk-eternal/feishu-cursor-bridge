import { app, BrowserWindow, ipcMain, dialog, shell } from "electron"
import * as path from "node:path"
import { execSync } from "node:child_process"
import { getConfig, saveConfig } from "./config-store"
import {
  startDaemon,
  stopDaemon,
  getDaemonStatus,
  readLogs,
  clearLogs,
  getQueueMessages,
  checkCliInstalled,
  installCli,
  initDaemonManager,
  cleanupDaemonManager,
} from "./daemon-manager"
import { initTray, destroyTray } from "./tray"

let mainWindow: BrowserWindow | null = null

function createWindow(): void {
  const iconPath = app.isPackaged
    ? path.join(process.resourcesPath, "icon.ico")
    : path.join(app.getAppPath(), "resources", "icon.ico")

  mainWindow = new BrowserWindow({
    width: 900,
    height: 680,
    minWidth: 780,
    minHeight: 560,
    title: "Feishu Cursor Bridge",
    icon: iconPath,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
    show: false,
  })

  mainWindow.on("ready-to-show", () => {
    mainWindow?.show()
  })

  mainWindow.on("close", (e) => {
    if (!isQuitting) {
      e.preventDefault()
      mainWindow?.hide()
    }
  })

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: "deny" }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    mainWindow.loadFile(path.join(__dirname, "../renderer/index.html"))
  }

  mainWindow.webContents.on("did-fail-load", (_e, code, desc) => {
    console.error("[main] did-fail-load:", code, desc)
  })
}

function registerIpcHandlers(): void {
  ipcMain.handle("config:get", () => getConfig())
  ipcMain.handle("config:save", (_, config) => saveConfig(config))

  ipcMain.handle("dialog:selectDirectory", async () => {
    if (!mainWindow) return null
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ["openDirectory"],
      title: "选择工作目录",
    })
    return result.canceled ? null : result.filePaths[0]
  })

  ipcMain.handle("daemon:start", () => startDaemon())
  ipcMain.handle("daemon:stop", () => stopDaemon())
  ipcMain.handle("daemon:status", () => getDaemonStatus())
  ipcMain.handle("logs:read", (_, lines) => readLogs(lines))
  ipcMain.handle("logs:clear", () => clearLogs())
  ipcMain.handle("daemon:queue", () => getQueueMessages())
  ipcMain.handle("cli:check", () => checkCliInstalled())
  ipcMain.handle("cli:install", () => installCli())

  ipcMain.handle("models:list", () => {
    try {
      const config = getConfig()
      const env: Record<string, string> = { ...process.env as Record<string, string>, NODE_USE_ENV_PROXY: "1" }
      if (config.httpProxy) {
        env.HTTP_PROXY = config.httpProxy
        env.http_proxy = config.httpProxy
      }
      if (config.httpsProxy) {
        env.HTTPS_PROXY = config.httpsProxy
        env.https_proxy = config.httpsProxy
        env.ALL_PROXY = config.httpsProxy
        env.all_proxy = config.httpsProxy
      }
      if (config.noProxy) {
        env.NO_PROXY = config.noProxy
        env.no_proxy = config.noProxy
      }
      const out = execSync("agent --list-models", {
        encoding: "utf-8",
        timeout: 30000,
        env,
        shell: true,
        windowsHide: true,
      })
      const models: { id: string; label: string; current: boolean }[] = []
      for (const line of out.split("\n")) {
        const trimmed = line.trim()
        if (!trimmed || trimmed.startsWith("Available")) continue
        const match = trimmed.match(/^(\S+)\s+[–—-]\s+(.+?)(\s+\((?:default|current)\))?$/)
        if (match) {
          models.push({ id: match[1], label: match[2].trim(), current: !!match[3] })
        }
      }
      return { ok: true, models }
    } catch (e: any) {
      return { ok: false, models: [], error: e?.message ?? String(e) }
    }
  })
}

let isQuitting = false

app.on("before-quit", () => {
  isQuitting = true
})

app.whenReady().then(() => {
  registerIpcHandlers()
  createWindow()
  initTray()
  initDaemonManager()
})

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit()
  }
})

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow()
  } else {
    mainWindow?.show()
  }
})

app.on("will-quit", () => {
  cleanupDaemonManager()
  destroyTray()
})
