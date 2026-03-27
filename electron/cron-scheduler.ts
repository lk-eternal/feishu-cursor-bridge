import cron, { type ScheduledTask as CronJob } from "node-cron"
import * as http from "node:http"
import { getConfig, type ScheduledTask } from "./config-store"

const runningJobs = new Map<string, CronJob>()
let logFn: ((msg: string) => void) | null = null
let portGetter: (() => number | null) | null = null

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
  const config = getConfig()
  const tasks = config.scheduledTasks ?? []
  if (tasks.length === 0) return

  log(`加载 ${tasks.length} 个定时任务`)
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

export function startScheduler(): void {
  reloadScheduledTasks()
}

export function stopScheduler(): void {
  stopAllJobs()
  log("调度器已停止")
}

export function validateCron(expression: string): boolean {
  return cron.validate(expression)
}
