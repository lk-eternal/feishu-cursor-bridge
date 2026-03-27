import { Tray, Menu, nativeImage, app, BrowserWindow } from "electron"
import * as path from "node:path"

let tray: Tray | null = null

function getIconPath(): string {
  const ext = process.platform === "win32" ? "ico" : "png"
  if (app.isPackaged) {
    return path.join(process.resourcesPath, `icon.${ext}`)
  }
  return path.join(app.getAppPath(), "resources", `icon.${ext}`)
}

function createDefaultIcon(): Electron.NativeImage {
  return nativeImage.createFromBuffer(Buffer.alloc(0))
}

function getIcon(): Electron.NativeImage {
  try {
    const iconPath = getIconPath()
    const icon = nativeImage.createFromPath(iconPath)
    if (icon.isEmpty()) return createDefaultIcon()
    return icon.resize({ width: 16, height: 16 })
  } catch {
    return createDefaultIcon()
  }
}

function showMainWindow(): void {
  const windows = BrowserWindow.getAllWindows()
  if (windows.length > 0) {
    const win = windows[0]
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
  }
}

export function initTray(): void {
  tray = new Tray(getIcon())
  tray.setToolTip("Feishu Cursor Bridge")

  const contextMenu = Menu.buildFromTemplate([
    { label: "显示窗口", click: showMainWindow },
    { type: "separator" },
    {
      label: "退出",
      click: () => {
        app.quit()
      },
    },
  ])

  tray.setContextMenu(contextMenu)
  tray.on("double-click", showMainWindow)
}

export function destroyTray(): void {
  if (tray) {
    tray.destroy()
    tray = null
  }
}

export function updateTrayTooltip(text: string): void {
  if (tray) {
    tray.setToolTip(text)
  }
}
