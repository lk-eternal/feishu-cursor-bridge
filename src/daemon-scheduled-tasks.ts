import cron, { type ScheduledTask as CronJob } from "node-cron";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const TASKS_DIR = path.join(os.homedir(), ".lark-bridge-mcp");
const TASKS_FILE = path.join(TASKS_DIR, "scheduled-tasks.json");

interface ScheduledTask {
  id: string;
  name: string;
  cron: string;
  content: string;
  enabled?: boolean;
}

const runningJobs = new Map<string, CronJob>();
let fileWatcher: fs.FSWatcher | null = null;
let logFn: ((msg: string) => void) | null = null;

export function setDaemonSchedulerLogger(fn: (msg: string) => void): void {
  logFn = fn;
}

function log(msg: string): void {
  if (logFn) {
    logFn(`[定时任务] ${msg}`);
  }
}

function readTasksFromFile(): ScheduledTask[] {
  try {
    if (!fs.existsSync(TASKS_FILE)) {
      return [];
    }
    const raw = fs.readFileSync(TASKS_FILE, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter(
      (t: unknown): t is ScheduledTask =>
        typeof t === "object" && t !== null &&
        typeof (t as ScheduledTask).id === "string" &&
        typeof (t as ScheduledTask).name === "string" &&
        typeof (t as ScheduledTask).cron === "string" &&
        typeof (t as ScheduledTask).content === "string",
    ).map((t) => ({ ...t, enabled: t.enabled !== false }));
  } catch (e) {
    log(`读取任务文件失败: ${e instanceof Error ? e.message : String(e)}`);
    return [];
  }
}

function stopAllJobs(): void {
  for (const [, job] of runningJobs) {
    job.stop();
  }
  runningJobs.clear();
}

function scheduleTask(task: ScheduledTask, enqueue: (content: string) => void): void {
  if (!task.enabled) {
    return;
  }
  if (!cron.validate(task.cron)) {
    log(`无效的 cron 表达式: "${task.cron}" (任务: ${task.name})`);
    return;
  }
  const job = cron.schedule(task.cron, () => {
    const now = new Date().toLocaleString("zh-CN");
    const message = `[定时任务: ${task.name}] (触发时间: ${now})\n\n${task.content}`;
    log(`触发: ${task.name}`);
    enqueue(message);
  });
  runningJobs.set(task.id, job);
  log(`已注册: ${task.name} (${task.cron})`);
}

function reloadTasks(enqueue: (content: string) => void): void {
  stopAllJobs();
  const tasks = readTasksFromFile();
  const enabled = tasks.filter((t) => t.enabled);
  if (enabled.length === 0) {
    log(`无活跃定时任务 (共 ${tasks.length} 个)`);
    return;
  }
  log(`加载 ${enabled.length} 个定时任务`);
  for (const task of tasks) {
    scheduleTask(task, enqueue);
  }
}

function stopFileWatcher(): void {
  if (fileWatcher) {
    fileWatcher.close();
    fileWatcher = null;
  }
}

function startFileWatcher(enqueue: (content: string) => void): void {
  stopFileWatcher();
  if (!fs.existsSync(TASKS_DIR)) {
    try {
      fs.mkdirSync(TASKS_DIR, { recursive: true });
    } catch { /* ignore */ }
  }
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  try {
    fileWatcher = fs.watch(TASKS_DIR, (_eventType, filename) => {
      if (filename !== "scheduled-tasks.json") {
        return;
      }
      if (debounceTimer) {
        clearTimeout(debounceTimer);
      }
      debounceTimer = setTimeout(() => {
        log("检测到定时任务配置文件变化，重新加载...");
        reloadTasks(enqueue);
      }, 500);
    });
    fileWatcher.on("error", () => { /* ignore */ });
  } catch (e) {
    log(`文件监听启动失败: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export function startDaemonScheduledTasks(enqueue: (content: string) => void): void {
  reloadTasks(enqueue);
  startFileWatcher(enqueue);
  log(`调度器已启动 (${runningJobs.size} 个活跃任务)`);
}

export function stopDaemonScheduledTasks(): void {
  const count = runningJobs.size;
  stopAllJobs();
  stopFileWatcher();
  if (count > 0) {
    log(`调度器已停止 (${count} 个任务已取消)`);
  }
}
