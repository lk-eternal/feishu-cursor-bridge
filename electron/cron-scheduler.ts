import cron, { type ScheduledTask as CronJob } from "node-cron"
import * as http from "node:http"
import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"
import type { ScheduledTask } from "./config-store"

const runningJobs = new Map<string, CronJob>()
let logFn: ((msg: string) => void) | null = null
let portGetter: (() => number | null) | null = null
let fileWatcher: fs.FSWatcher | null = null

const TASKS_DIR = path.join(os.homedir(), ".lark-bridge-mcp")
const TASKS_FILE = path.join(TASKS_DIR, "scheduled-tasks.json")

export function getTasksFilePath(): string {
  return TASKS_FILE
}

export function setSchedulerLogger(fn: (msg: string) => void): void {
  logFn = fn
}

export function setPortGetter(fn: () => number | null): void {
  portGetter = fn
}

function log(msg: string): void {
  if (logFn) logFn(`[定时任务] ${msg}`)
}

function httpPost(url: string, body: object, timeoutMs = 5000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body)
    const req = http.request(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) },
      timeout: timeoutMs,
    }, (res) => {
      const chunks: string[] = []
      res.on("data", (c: Buffer) => chunks.push(c.toString()))
      res.on("end", () => {
        try { resolve(JSON.parse(chunks.join(""))) } catch { resolve(null) }
      })
    })
    req.on("error", reject)
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")) })
    req.end(data)
  })
}

function enqueueMessage(content: string): void {
  const port = portGetter?.()
  if (!port) {
    log("Daemon 未运行，跳过入队")
    return
  }
  httpPost(`http://127.0.0.1:${port}/enqueue`, { content }).then((res) => {
    const result = res as { ok?: boolean; error?: string } | null
    if (result?.ok) {
      log(`消息已入队: "${content.slice(0, 80)}"`)
    } else {
      log(`入队失败: ${result?.error ?? "未知错误"}`)
    }
  }).catch((e: unknown) => {
    log(`入队失败: ${e instanceof Error ? e.message : String(e)}`)
  })
}

export function readTasksFromFile(): ScheduledTask[] {
  try {
    if (!fs.existsSync(TASKS_FILE)) return []
    const raw = fs.readFileSync(TASKS_FILE, "utf-8")
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (t: unknown): t is ScheduledTask =>
        typeof t === "object" && t !== null &&
        typeof (t as ScheduledTask).id === "string" &&
        typeof (t as ScheduledTask).name === "string" &&
        typeof (t as ScheduledTask).cron === "string" &&
        typeof (t as ScheduledTask).content === "string"
    ).map((t) => ({ ...t, enabled: t.enabled !== false }))
  } catch (e) {
    log(`读取任务文件失败: ${e instanceof Error ? e.message : String(e)}`)
    return []
  }
}

export function writeTasksToFile(tasks: ScheduledTask[]): void {
  try {
    if (!fs.existsSync(TASKS_DIR)) fs.mkdirSync(TASKS_DIR, { recursive: true })
    fs.writeFileSync(TASKS_FILE, JSON.stringify(tasks, null, 2), "utf-8")
  } catch (e) {
    log(`写入任务文件失败: ${e instanceof Error ? e.message : String(e)}`)
  }
}

function scheduleTask(task: ScheduledTask): void {
  if (runningJobs.has(task.id)) {
    runningJobs.get(task.id)!.stop()
    runningJobs.delete(task.id)
  }

  if (!task.enabled) return

  if (!cron.validate(task.cron)) {
    log(`无效的 cron 表达式: "${task.cron}" (任务: ${task.name})`)
    return
  }

  const job = cron.schedule(task.cron, () => {
    const now = new Date().toLocaleString("zh-CN")
    const message = `[定时任务: ${task.name}] (触发时间: ${now})\n\n${task.content}`
    log(`触发: ${task.name}`)
    enqueueMessage(message)
  })

  runningJobs.set(task.id, job)
  log(`已注册: ${task.name} (${task.cron})`)
}

export function reloadScheduledTasks(): void {
  stopAllJobs()
  const tasks = readTasksFromFile()
  const enabled = tasks.filter((t) => t.enabled)
  if (enabled.length === 0) {
    log(`无活跃定时任务 (共 ${tasks.length} 个, ${tasks.length - enabled.length} 个已禁用)`)
    return
  }

  log(`加载 ${enabled.length} 个定时任务`)
  for (const task of tasks) {
    scheduleTask(task)
  }
}

function stopAllJobs(): void {
  for (const [, job] of runningJobs) {
    job.stop()
  }
  runningJobs.clear()
}

function startFileWatcher(): void {
  stopFileWatcher()
  if (!fs.existsSync(TASKS_DIR)) {
    try { fs.mkdirSync(TASKS_DIR, { recursive: true }) } catch { /* ignore */ }
  }

  let debounceTimer: ReturnType<typeof setTimeout> | null = null
  try {
    fileWatcher = fs.watch(TASKS_DIR, (eventType, filename) => {
      if (filename !== "scheduled-tasks.json") return
      if (debounceTimer) clearTimeout(debounceTimer)
      debounceTimer = setTimeout(() => {
        log("检测到定时任务配置文件变化，重新加载...")
        reloadScheduledTasks()
      }, 500)
    })
    fileWatcher.on("error", () => { /* ignore */ })
  } catch (e) {
    log(`文件监听启动失败: ${e instanceof Error ? e.message : String(e)}`)
  }
}

function stopFileWatcher(): void {
  if (fileWatcher) {
    fileWatcher.close()
    fileWatcher = null
  }
}

export function startScheduler(): void {
  reloadScheduledTasks()
  startFileWatcher()
  log(`调度器已启动 (${runningJobs.size} 个活跃任务)`)
}

export function stopScheduler(): void {
  const count = runningJobs.size
  stopAllJobs()
  stopFileWatcher()
  if (count > 0) log(`调度器已停止 (${count} 个任务已取消)`)
}

export function validateCron(expression: string): boolean {
  return cron.validate(expression)
}
