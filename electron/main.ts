import { app, BrowserWindow, ipcMain, dialog, shell } from "electron"
import * as path from "node:path"
import * as fs from "node:fs"
import * as os from "node:os"
import { getConfig, saveConfig } from "./config-store"
import {
  startDaemon,
  stopDaemon,
  getDaemonStatus,
  readLogs,
  clearLogs,
  getQueueMessages,
  checkCliInstalled,
  checkAgentLoggedIn,
  installCli,
  loginCli,
  getOAuthMcpList,
  getMcpServerList,
  saveMcpServer,
  deleteMcpServer,
  loginMcpServer,
  toggleMcpServer,
  getMcpEnabledMap,
  clearMessageQueue,
  execAgentAsync,
  applyProxyEnv,
  parseListModelsStdout,
  initDaemonManager,
  cleanupDaemonManager,
  saveAppConfigFromRenderer,
  getMcpServerTools,
  getMcpStatusMap,
} from "./daemon-manager"
import { injectWorkspace } from "./workspace-injector"
import { initTray, destroyTray } from "./tray"
import { initAppUpdater } from "./updater"

let mainWindow: BrowserWindow | null = null
let closeConfirmDialogOpen = false

function installWindowCloseHandler(win: BrowserWindow): void {
  win.on("close", (e) => {
    if (isQuitting) {
      return
    }

    const pref = getConfig().closeWindowAction

    if (pref === "minimize") {
      e.preventDefault()
      win.hide()
      return
    }

    if (pref === "quit") {
      isQuitting = true
      return
    }

    e.preventDefault()
    if (closeConfirmDialogOpen) {
      return
    }
    closeConfirmDialogOpen = true
    win.webContents.send("window:close-confirm")
  })
}

function resolveIcon(): string {
  const dir = app.isPackaged ? process.resourcesPath : path.join(app.getAppPath(), "resources")
  if (process.platform === "win32") {
    const ico = path.join(dir, "icon.ico")
    if (fs.existsSync(ico)) return ico
  }
  return path.join(dir, "icon.png")
}

function createWindow(): void {
  const iconPath = resolveIcon()

  mainWindow = new BrowserWindow({
    width: 900,
    height: 680,
    minWidth: 780,
    minHeight: 560,
    title: "Feishu Cursor Bridge",
    icon: iconPath,
    autoHideMenuBar: true,
    frame: false,
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

  installWindowCloseHandler(mainWindow)

  mainWindow.on("maximize", () => mainWindow?.webContents.send("window:maximized-change", true))
  mainWindow.on("unmaximize", () => mainWindow?.webContents.send("window:maximized-change", false))

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
  ipcMain.handle("window:minimize", () => mainWindow?.minimize())
  ipcMain.handle("window:maximize", () => {
    if (mainWindow?.isMaximized()) mainWindow.unmaximize()
    else mainWindow?.maximize()
  })
  ipcMain.handle("window:close", () => mainWindow?.close())
  ipcMain.handle("window:is-maximized", () => mainWindow?.isMaximized() ?? false)

  ipcMain.handle("config:get", () => getConfig())
  ipcMain.handle("config:save", (_, config) => saveAppConfigFromRenderer(config))

  ipcMain.handle(
    "window:close-confirm-result",
    (_, payload: { action: "minimize" | "quit" | "cancel"; remember: boolean }) => {
      const win = mainWindow
      closeConfirmDialogOpen = false
      if (!win || win.isDestroyed()) {
        return
      }
      if (payload.action === "cancel") {
        return
      }
      if (payload.remember) {
        saveConfig({
          closeWindowAction: payload.action === "minimize" ? "minimize" : "quit",
        })
      }
      if (payload.action === "minimize") {
        win.hide()
        return
      }
      isQuitting = true
      win.close()
    },
  )

  ipcMain.handle("dialog:selectDirectory", async () => {
    if (!mainWindow) return null
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ["openDirectory"],
      title: "选择工作目录",
    })
    return result.canceled ? null : result.filePaths[0]
  })

  ipcMain.handle("workspace:inject", () => injectWorkspace())
  ipcMain.handle("daemon:start", () => startDaemon())
  ipcMain.handle("daemon:stop", () => stopDaemon())
  ipcMain.handle("daemon:status", () => getDaemonStatus())
  ipcMain.handle("logs:read", (_, lines) => readLogs(lines))
  ipcMain.handle("logs:clear", () => clearLogs())
  ipcMain.handle("daemon:queue", () => getQueueMessages())
  ipcMain.handle("daemon:queue-clear", () => clearMessageQueue())
  ipcMain.handle("cli:check", () => checkCliInstalled())
  ipcMain.handle("cli:login-status", () => checkAgentLoggedIn())
  ipcMain.handle("cli:install", () => installCli())
  ipcMain.handle("cli:login", () => loginCli())
  ipcMain.handle("mcp:list-oauth", () => getOAuthMcpList())
  ipcMain.handle("mcp:list-all", () => getMcpServerList())
  ipcMain.handle("mcp:save", (_, name: string, entry: Record<string, unknown>, source: "global" | "project") => {
    saveMcpServer(name, entry, source)
    return { ok: true }
  })
  ipcMain.handle("mcp:delete", (_, name: string) => {
    deleteMcpServer(name)
    return { ok: true }
  })
  ipcMain.handle("mcp:login", (_, name: string) => loginMcpServer(name))
  ipcMain.handle("mcp:toggle", (_, name: string, enabled: boolean) => toggleMcpServer(name, enabled))
  ipcMain.handle("mcp:enabled-map", (_, force?: boolean) => getMcpEnabledMap(force ?? false))
  ipcMain.handle("mcp:status-map", (_, force?: boolean) => getMcpStatusMap(force ?? false))
  ipcMain.handle("mcp:tools", (_, name: string) => getMcpServerTools(name))

  ipcMain.handle("rules:list", () => {
    const config = getConfig()
    if (!config.workspaceDir) return []
    const rulesDir = path.join(config.workspaceDir, ".cursor", "rules")
    if (!fs.existsSync(rulesDir)) return []
    return fs.readdirSync(rulesDir)
      .filter((f) => f.endsWith(".mdc") || f.endsWith(".md"))
      .map((f) => ({
        name: f,
        content: fs.readFileSync(path.join(rulesDir, f), "utf-8"),
      }))
  })

  ipcMain.handle("rules:save", (_, name: string, content: string) => {
    const config = getConfig()
    if (!config.workspaceDir) return { ok: false }
    const rulesDir = path.join(config.workspaceDir, ".cursor", "rules")
    if (!fs.existsSync(rulesDir)) fs.mkdirSync(rulesDir, { recursive: true })
    fs.writeFileSync(path.join(rulesDir, name), content, "utf-8")
    return { ok: true }
  })

  ipcMain.handle("rules:delete", (_, name: string) => {
    const config = getConfig()
    if (!config.workspaceDir) return { ok: false }
    const filePath = path.join(config.workspaceDir, ".cursor", "rules", name)
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath)
    return { ok: true }
  })

  ipcMain.handle("skills:list", () => {
    const skillsDir = path.join(os.homedir(), ".cursor", "skills")
    if (!fs.existsSync(skillsDir)) return []
    return fs.readdirSync(skillsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => {
        const skillFile = path.join(skillsDir, d.name, "SKILL.md")
        return {
          name: d.name,
          content: fs.existsSync(skillFile) ? fs.readFileSync(skillFile, "utf-8") : "",
        }
      })
  })

  interface SkillTreeNode {
    name: string
    type: "file" | "directory"
    children?: SkillTreeNode[]
  }

  function buildTree(dir: string): SkillTreeNode[] {
    if (!fs.existsSync(dir)) return []
    return fs.readdirSync(dir, { withFileTypes: true })
      .sort((a, b) => {
        if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1
        return a.name.localeCompare(b.name)
      })
      .map((entry): SkillTreeNode => {
        if (entry.isDirectory()) {
          return { name: entry.name, type: "directory", children: buildTree(path.join(dir, entry.name)) }
        }
        return { name: entry.name, type: "file" }
      })
  }

  ipcMain.handle("skills:tree", () => {
    const skillsDir = path.join(os.homedir(), ".cursor", "skills")
    if (!fs.existsSync(skillsDir)) return []
    return fs.readdirSync(skillsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((d) => ({
        name: d.name,
        type: "directory" as const,
        children: buildTree(path.join(skillsDir, d.name)),
      }))
  })

  ipcMain.handle("skills:read-file", (_, skillName: string, relativePath: string) => {
    const filePath = path.join(os.homedir(), ".cursor", "skills", skillName, relativePath)
    if (!fs.existsSync(filePath)) return { ok: false, error: "文件不存在" }
    return { ok: true, content: fs.readFileSync(filePath, "utf-8") }
  })

  ipcMain.handle("skills:save-file", (_, skillName: string, relativePath: string, content: string) => {
    const filePath = path.join(os.homedir(), ".cursor", "skills", skillName, relativePath)
    const dir = path.dirname(filePath)
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(filePath, content, "utf-8")
    return { ok: true }
  })

  ipcMain.handle("skills:create-dir", (_, skillName: string, relativePath: string) => {
    const dirPath = path.join(os.homedir(), ".cursor", "skills", skillName, relativePath)
    if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true })
    return { ok: true }
  })

  ipcMain.handle("skills:delete-file", (_, skillName: string, relativePath: string) => {
    const filePath = path.join(os.homedir(), ".cursor", "skills", skillName, relativePath)
    if (!fs.existsSync(filePath)) return { ok: false, error: "文件不存在" }
    const stat = fs.statSync(filePath)
    if (stat.isDirectory()) {
      fs.rmSync(filePath, { recursive: true, force: true })
    } else {
      fs.unlinkSync(filePath)
    }
    return { ok: true }
  })

  ipcMain.handle("skills:save", (_, name: string, content: string) => {
    const dir = path.join(os.homedir(), ".cursor", "skills", name)
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, "SKILL.md"), content, "utf-8")
    return { ok: true }
  })

  ipcMain.handle("skills:rename", (_, oldName: string, newName: string) => {
    const base = path.join(os.homedir(), ".cursor", "skills")
    const oldDir = path.join(base, oldName)
    const newDir = path.join(base, newName)
    if (!fs.existsSync(oldDir)) return { ok: false, error: "原目录不存在" }
    if (fs.existsSync(newDir)) return { ok: false, error: "目标目录已存在" }
    fs.renameSync(oldDir, newDir)
    return { ok: true }
  })

  ipcMain.handle("skills:delete", (_, name: string) => {
    const dir = path.join(os.homedir(), ".cursor", "skills", name)
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true })
    return { ok: true }
  })

  ipcMain.handle("models:list", async () => {
    const config = getConfig()
    const env: Record<string, string> = { ...process.env as Record<string, string>, NODE_USE_ENV_PROXY: "1" }
    applyProxyEnv(env, config)
    const ws = config.workspaceDir?.trim() || undefined
    const run = await execAgentAsync(["--list-models"], env, { timeoutMs: 30_000, logLabel: "list-models", cwd: ws })
    if (!run.ok) {
      return { ok: false, models: [], error: run.error || run.stderr.trim() || "获取模型列表失败" }
    }
    return { ok: true, models: parseListModelsStdout(run.stdout) }
  })
}

let isQuitting = false

app.on("before-quit", () => {
  isQuitting = true
})

app.whenReady().then(() => {
  registerIpcHandlers()
  createWindow()
  initAppUpdater(() => mainWindow)
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
