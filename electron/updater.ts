import { app, BrowserWindow, dialog, ipcMain, shell } from "electron"
import electronUpdater from "electron-updater"
import type { AppUpdater } from "electron-updater"
import { randomUUID } from "node:crypto"
import * as https from "node:https"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import * as fs from "node:fs"
import * as path from "node:path"
import semver from "semver"

const execFileAsync = promisify(execFile)

const autoUpdater: AppUpdater = (electronUpdater as { autoUpdater: AppUpdater }).autoUpdater

const GITHUB_OWNER = "lk-eternal"
const GITHUB_REPO = "feishu-cursor-bridge"
const HOMEBREW_TAP = "lk-eternal/tap"
const HOMEBREW_CASK = "feishu-cursor-bridge"

const STARTUP_CHECK_DELAY_MS = 4_000

const DEV_FAKE_LATEST_VERSION = "99.99.99"

function isDevSimulateUpdate(): boolean {
  if (app.isPackaged) {
    return false
  }
  const v = (process.env.FEISHU_DEV_SIMULATE_UPDATE ?? "").trim().toLowerCase()
  return v === "1" || v === "true" || v === "yes"
}

function fakeLatestReleaseForDev(): LatestRelease {
  return {
    version: DEV_FAKE_LATEST_VERSION,
    htmlUrl: `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`,
  }
}

function devSimulateDetailSuffix(): string {
  return "\n（开发测试：不会真的安装）"
}

export interface LatestRelease {
  version: string
  htmlUrl: string
}

interface ChangelogEntry {
  version: string
  date: string
  changes: string[]
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
      releaseNotes: string
    }

export interface UpdaterApplyResult {
  ok: boolean
  error?: string
  message?: string
}

let mainWindowGetter: (() => BrowserWindow | null) | null = null
let winDownloadRequested = false
let lastKnownRemote: LatestRelease | null = null
let autoUpdaterWired = false
let updaterIpcRegistered = false

interface AppModalOptions {
  variant?: "info" | "error" | "warning"
  title: string
  message: string
  detail?: string
  buttons: string[]
  defaultId?: number
  cancelId?: number
}

interface ModalQueueItem {
  options: AppModalOptions
  resolve: (index: number) => void
}

const pendingModalResolvers = new Map<string, (index: number) => void>()
const modalWaitQueue: ModalQueueItem[] = []
let modalProcessor: Promise<void> | null = null

function getMainWindow(): BrowserWindow | null {
  return mainWindowGetter?.() ?? null
}

async function showAppModalOnce(options: AppModalOptions): Promise<number> {
  const w = getMainWindow()
  if (!w || w.isDestroyed()) {
    const type =
      options.variant === "error" ? "error" : options.variant === "warning" ? "warning" : "info"
    const detailPart = options.detail ? `\n\n${options.detail}` : ""
    const r = await dialog.showMessageBox({
      type,
      title: options.title,
      message: options.message + detailPart,
      buttons: options.buttons,
      defaultId: options.defaultId ?? 0,
      cancelId: options.cancelId ?? 0,
    })
    return r.response
  }
  const requestId = randomUUID()
  return new Promise((resolve) => {
    pendingModalResolvers.set(requestId, resolve)
    w.webContents.send("app:modal-request", {
      requestId,
      title: options.title,
      message: options.message,
      detail: options.detail,
      buttons: options.buttons,
      defaultId: options.defaultId,
      cancelId: options.cancelId,
      variant: options.variant,
    })
  })
}

function ensureModalProcessor(): void {
  if (modalProcessor) {
    return
  }
  modalProcessor = (async () => {
    while (modalWaitQueue.length > 0) {
      const item = modalWaitQueue.shift()
      if (!item) {
        break
      }
      const idx = await showAppModalOnce(item.options)
      item.resolve(idx)
    }
  })().finally(() => {
    modalProcessor = null
    if (modalWaitQueue.length > 0) {
      ensureModalProcessor()
    }
  })
}

function showAppModal(options: AppModalOptions): Promise<number> {
  return new Promise((resolve) => {
    modalWaitQueue.push({ options, resolve })
    ensureModalProcessor()
  })
}

function normalizeReleaseVersion(tagName: string): string {
  return tagName.replace(/^v/i, "").trim()
}

export function fetchLatestRelease(): Promise<LatestRelease | null> {
  const path = `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`
  return new Promise((resolve) => {
    const req = https.request(
      {
        hostname: "api.github.com",
        path,
        method: "GET",
        headers: {
          Accept: "application/vnd.github+json",
          "User-Agent": "feishu-cursor-bridge-desktop-updater",
        },
      },
      (res) => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          res.resume()
          resolve(null)
          return
        }
        const chunks: Buffer[] = []
        res.on("data", (c: Buffer) => chunks.push(c))
        res.on("end", () => {
          try {
            if (res.statusCode !== 200) {
              resolve(null)
              return
            }
            const json = JSON.parse(Buffer.concat(chunks).toString("utf-8")) as {
              tag_name?: string
              html_url?: string
            }
            const tag = json.tag_name
            const htmlUrl = json.html_url
            if (typeof tag !== "string" || typeof htmlUrl !== "string") {
              resolve(null)
              return
            }
            const version = normalizeReleaseVersion(tag)
            if (!semver.valid(version)) {
              resolve(null)
              return
            }
            resolve({ version, htmlUrl })
          } catch {
            resolve(null)
          }
        })
      },
    )
    req.on("error", () => resolve(null))
    req.setTimeout(20_000, () => {
      req.destroy()
      resolve(null)
    })
    req.end()
  })
}

function fetchRemoteChangelog(): Promise<ChangelogEntry[]> {
  const rawUrl = `/${GITHUB_OWNER}/${GITHUB_REPO}/main/changelog.json`
  return new Promise((resolve) => {
    const req = https.request(
      {
        hostname: "raw.githubusercontent.com",
        path: rawUrl,
        method: "GET",
        headers: { "User-Agent": "feishu-cursor-bridge-desktop-updater" },
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on("data", (c: Buffer) => chunks.push(c))
        res.on("end", () => {
          try {
            if (res.statusCode !== 200) {
              resolve([])
              return
            }
            resolve(JSON.parse(Buffer.concat(chunks).toString("utf-8")) as ChangelogEntry[])
          } catch {
            resolve([])
          }
        })
      },
    )
    req.on("error", () => resolve([]))
    req.setTimeout(15_000, () => {
      req.destroy()
      resolve([])
    })
    req.end()
  })
}

function buildReleaseNotes(entries: ChangelogEntry[], currentVersion: string): string {
  const newer = entries.filter((e) => semver.valid(e.version) && semver.gt(e.version, currentVersion))
  if (newer.length === 0) {
    return ""
  }
  newer.sort((a, b) => semver.rcompare(a.version, b.version))
  return newer
    .map((e) => {
      const header = newer.length > 1 ? `v${e.version}：\n` : ""
      return header + e.changes.map((c) => `- ${c}`).join("\n")
    })
    .join("\n\n")
}

function getBrewExecutable(): string | null {
  const arm = "/opt/homebrew/bin/brew"
  const intel = "/usr/local/bin/brew"
  if (fs.existsSync(arm)) {
    return arm
  }
  if (fs.existsSync(intel)) {
    return intel
  }
  return null
}

const BREW_MANUAL_GUIDE = [
  "手动更新方法（在终端中执行）：",
  `  brew untap ${HOMEBREW_TAP}`,
  `  brew tap ${HOMEBREW_TAP}`,
  `  brew upgrade --cask ${HOMEBREW_CASK}`,
  "  xattr -cr /Applications/Feishu\\ Cursor\\ Bridge.app",
  "",
  `FAQ: https://github.com/${HOMEBREW_TAP}`,
].join("\n")

async function runBrewUpgrade(): Promise<UpdaterApplyResult> {
  const brew = getBrewExecutable()
  if (!brew) {
    return { ok: false, error: `未找到 Homebrew（/opt/homebrew 或 /usr/local）\n\n${BREW_MANUAL_GUIDE}` }
  }
  const brewEnv = {
    ...process.env,
    PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH ?? ""}`,
  }
  try {
    await execFileAsync(brew, ["tap", HOMEBREW_TAP], { timeout: 120_000, env: brewEnv })
    await execFileAsync(brew, ["update"], { timeout: 300_000, env: brewEnv })
    await execFileAsync(brew, ["upgrade", "--cask", HOMEBREW_CASK], { timeout: 600_000, env: brewEnv })
    return {
      ok: true,
      message: "更新已完成，请重启应用。",
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return { ok: false, error: `brew 执行失败：${msg}\n\n${BREW_MANUAL_GUIDE}` }
  }
}

function manualUpdateUrl(version: string): string {
  return `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases/download/v${version}/feishu-cursor-bridge-setup-${version}.exe`
}

async function showWinDownloadFallback(reason: unknown): Promise<void> {
  const ver = lastKnownRemote?.version ?? ""
  const errMsg =
    reason instanceof Error ? reason.message : typeof reason === "string" ? reason : String(reason)
  const downloadUrl = ver ? manualUpdateUrl(ver) : (lastKnownRemote?.htmlUrl ?? "")
  const detail = [
    `错误: ${errMsg}`,
    "",
    "可能原因: 安装包托管在 GitHub，直接访问可能被墙。",
    "",
    downloadUrl ? "点击「手动下载」可在浏览器中打开安装包下载链接。" : "",
  ].filter(Boolean).join("\n")

  const buttons = downloadUrl ? ["关闭", "手动下载"] : ["关闭"]
  const r = await showAppModal({
    variant: "warning",
    title: "自动更新失败",
    message: "无法自动下载更新，请尝试手动更新。",
    detail,
    buttons,
    defaultId: downloadUrl ? 1 : 0,
    cancelId: 0,
  })
  if (r === 1 && downloadUrl) {
    await shell.openExternal(downloadUrl)
  }
}

function clearUpdaterCache(): void {
  try {
    const cacheDir = path.join(app.getPath("userData"), "..", `${app.getName()}-updater`)
    if (!fs.existsSync(cacheDir)) return
    for (const entry of fs.readdirSync(cacheDir)) {
      fs.rmSync(path.join(cacheDir, entry), { recursive: true, force: true })
    }
  } catch { /* best-effort */ }
}

function wireAutoUpdater(): void {
  if (autoUpdaterWired || !app.isPackaged) {
    return
  }
  autoUpdaterWired = true
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = false

  autoUpdater.on("update-available", () => {
    getMainWindow()?.webContents.send("updater:status", { kind: "available" as const })
    if (winDownloadRequested && process.platform === "win32") {
      winDownloadRequested = false
      getMainWindow()?.webContents.send("updater:status", { kind: "downloading" as const })
      void autoUpdater.downloadUpdate().catch((err: unknown) => {
        void showWinDownloadFallback(err)
      })
    }
  })

  autoUpdater.on("update-not-available", () => {
    if (winDownloadRequested && process.platform === "win32") {
      winDownloadRequested = false
      void showWinDownloadFallback(new Error("未找到可用更新"))
    }
  })

  autoUpdater.on("download-progress", (p) => {
    getMainWindow()?.webContents.send("updater:progress", p.percent)
  })

  autoUpdater.on("update-downloaded", () => {
    getMainWindow()?.webContents.send("updater:status", { kind: "downloaded" as const })
    void showAppModal({
      variant: "info",
      title: "更新已就绪",
      message: "新版本已下载，是否立即安装并重启？",
      buttons: ["稍后", "立即安装"],
      defaultId: 1,
      cancelId: 0,
    }).then((resp) => {
      if (resp === 1) {
        setImmediate(() => {
          autoUpdater.quitAndInstall(false, true)
        })
      }
    })
  })

  autoUpdater.on("error", (err) => {
    if (winDownloadRequested && process.platform === "win32") {
      winDownloadRequested = false
      void showWinDownloadFallback(err)
    }
    getMainWindow()?.webContents.send("updater:error", err.message)
  })
}

function applyHintForPlatform(): string {
  if (process.platform === "darwin") {
    return "可在下一步确认后开始更新。"
  }
  if (process.platform === "win32") {
    return "将下载并安装，完成后按提示重启。"
  }
  return "将打开下载页面。"
}

async function runStartupUpdateCheck(): Promise<void> {
  if (!app.isPackaged && !isDevSimulateUpdate()) {
    return
  }

  const simulate = isDevSimulateUpdate()
  let rel: LatestRelease | null

  if (simulate) {
    rel = fakeLatestReleaseForDev()
    lastKnownRemote = rel
  } else {
    rel = await fetchLatestRelease()
    lastKnownRemote = rel
    if (!rel) {
      return
    }
    const cur0 = app.getVersion()
    if (!semver.gt(rel.version, cur0)) {
      return
    }
  }

  const cur = app.getVersion()
  const simSuffix = simulate ? devSimulateDetailSuffix() : ""

  const changelog = simulate
    ? [{ version: DEV_FAKE_LATEST_VERSION, date: "", changes: ["模拟更新内容", "用于开发测试"] }]
    : await fetchRemoteChangelog()
  const notes = buildReleaseNotes(changelog, cur)
  const notesDetail = notes ? `\n\n更新内容：\n${notes}` : ""

  if (process.platform === "darwin") {
    const r = await showAppModal({
      variant: "info",
      title: "发现新版本",
      message: `新版本 v${rel.version}，当前 v${cur}。`,
      detail: "是否现在更新？" + notesDetail + simSuffix,
      buttons: ["稍后", "立即更新"],
      defaultId: 1,
      cancelId: 0,
    })
    if (r !== 1) {
      return
    }
    if (simulate) {
      await showAppModal({
        variant: "info",
        title: "提示",
        message: "开发测试：未执行真实更新。",
        buttons: ["确定"],
        defaultId: 0,
      })
      return
    }
    const result = await runBrewUpgrade()
    await showAppModal({
      variant: result.ok ? "info" : "error",
      title: result.ok ? "完成" : "更新失败",
      message: result.ok ? (result.message ?? "请重启应用。") : (result.error ?? "未知错误"),
      buttons: ["确定"],
      defaultId: 0,
    })
    return
  }

  if (process.platform === "win32") {
    const r = await showAppModal({
      variant: "info",
      title: "发现新版本",
      message: `新版本 v${rel.version}，当前 v${cur}。`,
      detail: "是否下载并安装？" + notesDetail + simSuffix,
      buttons: ["稍后", "下载并安装"],
      defaultId: 1,
      cancelId: 0,
    })
    if (r !== 1) {
      return
    }
    if (simulate) {
      await showAppModal({
        variant: "info",
        title: "提示",
        message: "开发测试：未执行真实更新。",
        buttons: ["确定"],
        defaultId: 0,
      })
      return
    }
    winDownloadRequested = true
    clearUpdaterCache()
    try {
      await autoUpdater.checkForUpdates()
    } catch (e) {
      winDownloadRequested = false
      await showWinDownloadFallback(e)
    }
    return
  }

  const r = await showAppModal({
    variant: "info",
    title: "发现新版本",
    message: `新版本 v${rel.version}，当前 v${cur}。`,
    detail: "是否在浏览器中打开下载页？" + notesDetail + simSuffix,
    buttons: ["稍后", "打开下载页"],
    defaultId: 1,
    cancelId: 0,
  })
  if (r === 1) {
    await shell.openExternal(rel.htmlUrl)
  }
}

export function registerUpdaterIpc(): void {
  if (updaterIpcRegistered) {
    return
  }
  updaterIpcRegistered = true

  ipcMain.handle("app:modal-result", (_, payload: { requestId: string; response: number }) => {
    const fn = pendingModalResolvers.get(payload.requestId)
    if (fn) {
      pendingModalResolvers.delete(payload.requestId)
      fn(payload.response)
    }
  })

  ipcMain.handle("updater:current-version", () => app.getVersion())

  ipcMain.handle("updater:check", async (): Promise<UpdaterCheckResult> => {
    const currentVersion = app.getVersion()
    if (!app.isPackaged) {
      if (isDevSimulateUpdate()) {
        lastKnownRemote = fakeLatestReleaseForDev()
        const fakeNotes = buildReleaseNotes(
          [{ version: DEV_FAKE_LATEST_VERSION, date: "", changes: ["模拟更新内容", "用于开发测试"] }],
          currentVersion,
        )
        return {
          status: "available",
          currentVersion,
          latestVersion: DEV_FAKE_LATEST_VERSION,
          htmlUrl: lastKnownRemote.htmlUrl,
          applyHint: applyHintForPlatform(),
          releaseNotes: fakeNotes,
        }
      }
      return {
        status: "dev",
        currentVersion,
        message: "开发版本不检查更新。",
      }
    }
    const rel = await fetchLatestRelease()
    if (!rel) {
      return {
        status: "error",
        currentVersion,
        message: "检查失败（可能原因: GitHub 访问受限），请检查网络后重试。",
      }
    }
    lastKnownRemote = rel
    if (semver.gt(rel.version, currentVersion)) {
      const changelog = await fetchRemoteChangelog()
      const notes = buildReleaseNotes(changelog, currentVersion)
      return {
        status: "available",
        currentVersion,
        latestVersion: rel.version,
        htmlUrl: rel.htmlUrl,
        applyHint: applyHintForPlatform(),
        releaseNotes: notes,
      }
    }
    return {
      status: "latest",
      currentVersion,
      latestVersion: rel.version,
    }
  })

  ipcMain.handle("updater:apply", async (): Promise<UpdaterApplyResult> => {
    if (!app.isPackaged) {
      if (isDevSimulateUpdate()) {
        return {
          ok: true,
          message: "开发测试：未执行真实更新。",
        }
      }
      return { ok: false, error: "开发版本无法更新。" }
    }
    const currentVersion = app.getVersion()
    const rel = lastKnownRemote ?? (await fetchLatestRelease())
    if (rel) {
      lastKnownRemote = rel
    }
    if (!rel) {
      return {
        ok: false,
        error: "无法获取远程版本信息（可能原因: GitHub 访问受限）。\n请检查网络后重试。",
      }
    }
    if (!semver.gt(rel.version, currentVersion)) {
      return { ok: false, error: "当前已是最新版本" }
    }

    if (process.platform === "darwin") {
      return runBrewUpgrade()
    }

    if (process.platform === "win32") {
      winDownloadRequested = true
      clearUpdaterCache()
      try {
        await autoUpdater.checkForUpdates()
        return { ok: true, message: "正在下载…" }
      } catch (e) {
        winDownloadRequested = false
        const msg = e instanceof Error ? e.message : String(e)
        const ver = rel.version
        const dlUrl = manualUpdateUrl(ver)
        return {
          ok: false,
          error: [
            msg,
            "",
            "可能原因: 安装包托管在 GitHub，直接访问可能被墙。",
            `手动下载: ${dlUrl}`,
          ].join("\n"),
        }
      }
    }

    await shell.openExternal(rel.htmlUrl)
    return { ok: true, message: "已打开下载页。" }
  })
}

export function initAppUpdater(getMainWindow: () => BrowserWindow | null): void {
  mainWindowGetter = getMainWindow
  registerUpdaterIpc()
  wireAutoUpdater()
  if (app.isPackaged || isDevSimulateUpdate()) {
    setTimeout(() => {
      void runStartupUpdateCheck()
    }, STARTUP_CHECK_DELAY_MS)
  }
}
