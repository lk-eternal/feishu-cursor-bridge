import { useState, useEffect, useRef } from "react"
import {
  Play,
  Square,
  Settings,
  RefreshCw,
  Wifi,
  WifiOff,
  Bot,
  MessageSquare,
  Clock,
  Loader2,
  Activity,
  Terminal,
  Download,
  CheckCircle2,
  AlertTriangle,
  Plus,
  Trash2,
  Pencil,
  Timer,
  X,
  Check,
} from "lucide-react"

interface Props {
  onSettings: () => void
}

export default function Dashboard({ onSettings }: Props) {
  const [status, setStatus] = useState<DaemonStatus>({ running: false })
  const [logs, setLogs] = useState("")
  const [starting, setStarting] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [actionError, setActionError] = useState("")
  const [queueMessages, setQueueMessages] = useState<{ index: number; preview: string }[]>([])
  const [showQueue, setShowQueue] = useState(false)
  const [cliStatus, setCliStatus] = useState<"checking" | "installed" | "missing">("checking")
  const [cliInstalling, setCliInstalling] = useState(false)
  const [cliMessage, setCliMessage] = useState("")
  const [stoppingAgent, setStoppingAgent] = useState(false)
  const [tasks, setTasks] = useState<ScheduledTask[]>([])
  const [showTasks, setShowTasks] = useState(false)
  const [editingTask, setEditingTask] = useState<ScheduledTask | null>(null)
  const [cronValid, setCronValid] = useState(true)
  const logRef = useRef<HTMLPreElement>(null)

  useEffect(() => {
    const refresh = async () => {
      const s = await window.electronAPI.getDaemonStatus()
      setStatus(s)
      if (s.queueLength && s.queueLength > 0) {
        const msgs = await window.electronAPI.getQueueMessages()
        setQueueMessages(msgs)
      } else {
        setQueueMessages([])
      }
    }
    refresh()
    const timer = setInterval(refresh, 5_000)

    window.electronAPI.checkCli().then((ok) => setCliStatus(ok ? "installed" : "missing"))
    window.electronAPI.getScheduledTasks().then(setTasks)
    window.electronAPI.getLogBuffer().then((buf) => {
      if (buf.length > 0) setLogs(buf.join("\n"))
    })

    const unsub = window.electronAPI.onDaemonStatus((s) => setStatus(s))
    const unsubLog = window.electronAPI.onDaemonLog((line) => {
      setLogs((prev) => {
        const next = prev ? prev + "\n" + line : line
        const lines = next.split("\n")
        return lines.length > 300 ? lines.slice(-300).join("\n") : next
      })
    })
    return () => {
      clearInterval(timer)
      unsub()
      unsubLog()
    }
  }, [])

  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight
    }
  }, [logs])

  const handleStart = async () => {
    setStarting(true)
    setActionError("")
    try {
      const result = await window.electronAPI.startDaemon()
      if (result.ok) {
        const s = await window.electronAPI.getDaemonStatus()
        setStatus(s)
      } else {
        setActionError(result.error ?? "启动失败")
      }
    } catch (e: unknown) {
      setActionError(e instanceof Error ? e.message : String(e))
    }
    setStarting(false)
  }

  const handleStop = async () => {
    setStopping(true)
    await window.electronAPI.stopDaemon()
    setStatus({ running: false })
    setStopping(false)
  }

  const handleRefresh = async () => {
    const s = await window.electronAPI.getDaemonStatus()
    setStatus(s)
    if (s.queueLength && s.queueLength > 0) {
      const msgs = await window.electronAPI.getQueueMessages()
      setQueueMessages(msgs)
    } else {
      setQueueMessages([])
    }
  }

  const handleInstallCli = async () => {
    setCliInstalling(true)
    setCliMessage("")
    try {
      const result = await window.electronAPI.installCli()
      setCliMessage(result.output)
      if (result.ok) {
        setCliStatus("installed")
      }
    } catch (e: unknown) {
      setCliMessage(e instanceof Error ? e.message : String(e))
    }
    setCliInstalling(false)
  }

  const handleStopAgent = async () => {
    setStoppingAgent(true)
    try {
      await window.electronAPI.stopAgent()
      const s = await window.electronAPI.getDaemonStatus()
      setStatus(s)
    } catch { /* ignore */ }
    setStoppingAgent(false)
  }

  const toggleQueue = async () => {
    if (!showQueue) {
      const msgs = await window.electronAPI.getQueueMessages()
      setQueueMessages(msgs)
    }
    setShowQueue(!showQueue)
  }

  const saveTasks = async (updated: ScheduledTask[]) => {
    setTasks(updated)
    await window.electronAPI.saveScheduledTasks(updated)
  }

  const handleAddTask = () => {
    setEditingTask({
      id: crypto.randomUUID(),
      name: "",
      cron: "",
      content: "",
      enabled: true,
    })
    setCronValid(true)
    setShowTasks(true)
  }

  const handleSaveTask = async () => {
    if (!editingTask || !editingTask.name.trim() || !editingTask.cron.trim() || !editingTask.content.trim()) return
    const valid = await window.electronAPI.validateCron(editingTask.cron)
    if (!valid) {
      setCronValid(false)
      return
    }
    const exists = tasks.find((t) => t.id === editingTask.id)
    const updated = exists
      ? tasks.map((t) => (t.id === editingTask.id ? editingTask : t))
      : [...tasks, editingTask]
    await saveTasks(updated)
    setEditingTask(null)
  }

  const handleDeleteTask = async (id: string) => {
    await saveTasks(tasks.filter((t) => t.id !== id))
    if (editingTask?.id === id) setEditingTask(null)
  }

  const handleToggleTask = async (id: string) => {
    const updated = tasks.map((t) => (t.id === id ? { ...t, enabled: !t.enabled } : t))
    await saveTasks(updated)
  }

  const formatUptime = (seconds?: number): string => {
    if (!seconds) return "-"
    const h = Math.floor(seconds / 3600)
    const m = Math.floor((seconds % 3600) / 60)
    const s = seconds % 60
    return h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m ${s}s` : `${s}s`
  }

  return (
    <div className="flex h-screen flex-col">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-gray-800 px-6 py-4">
        <div className="flex items-center gap-3">
          <Activity size={22} className="text-blue-400" />
          <h1 className="text-lg font-semibold">Feishu Cursor Bridge</h1>
          {status.version && (
            <span className="rounded bg-gray-800 px-2 py-0.5 text-xs text-gray-400">
              v{status.version}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={handleRefresh}
            className="rounded-lg p-2 text-gray-400 transition hover:bg-gray-800 hover:text-white"
            title="刷新状态"
          >
            <RefreshCw size={16} />
          </button>
          <button
            onClick={onSettings}
            className="rounded-lg p-2 text-gray-400 transition hover:bg-gray-800 hover:text-white"
            title="设置"
          >
            <Settings size={16} />
          </button>
        </div>
      </div>

      {/* Status cards */}
      <div className="grid grid-cols-4 gap-3 px-6 py-4">
        <StatusCard
          icon={status.running ? Wifi : WifiOff}
          label="Daemon"
          value={status.running ? "运行中" : "已停止"}
          color={status.running ? "green" : "red"}
          sub={status.running ? `uptime ${formatUptime(status.uptime)}` : status.error}
          action={status.running ? (
            <button
              onClick={handleStop}
              disabled={stopping}
              className="flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-red-400 transition hover:bg-red-600/20 disabled:opacity-50"
              title="停止 Daemon"
            >
              {stopping ? <Loader2 size={10} className="animate-spin" /> : <Square size={10} />}
              停止
            </button>
          ) : (
            <button
              onClick={handleStart}
              disabled={starting}
              className="flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-green-400 transition hover:bg-green-600/20 disabled:opacity-50"
              title="启动 Daemon"
            >
              {starting ? <Loader2 size={10} className="animate-spin" /> : <Play size={10} />}
              启动
            </button>
          )}
        />
        <StatusCard
          icon={Wifi}
          label="飞书连接"
          value={status.hasTarget ? "已连接" : "等待连接"}
          color={status.hasTarget ? "green" : "gray"}
          sub={status.hasTarget ? "发送目标已就绪" : "等待目标"}
        />
        <StatusCard
          icon={Bot}
          label="Agent"
          value={status.agentRunning ? "会话中" : "空闲"}
          color={status.agentRunning ? "blue" : "gray"}
          sub={status.agentPid ? `PID: ${status.agentPid}` : undefined}
          action={status.agentRunning ? (
            <button
              onClick={handleStopAgent}
              disabled={stoppingAgent}
              className="flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-red-400 transition hover:bg-red-600/20 disabled:opacity-50"
              title="停止 Agent"
            >
              {stoppingAgent ? <Loader2 size={10} className="animate-spin" /> : <Square size={10} />}
              停止
            </button>
          ) : undefined}
        />
        <div onClick={toggleQueue} className="cursor-pointer">
          <StatusCard
            icon={MessageSquare}
            label="消息队列"
            value={String(status.queueLength ?? 0)}
            color={status.queueLength ? "yellow" : "gray"}
            sub={status.queueLength ? "点击查看详情" : "待处理消息"}
          />
        </div>
      </div>

      {/* Queue messages */}
      {showQueue && queueMessages.length > 0 && (
        <div className="mx-6 space-y-1 rounded-lg border border-yellow-800/50 bg-yellow-950/20 p-3">
          <div className="mb-2 text-xs font-medium text-yellow-400">
            待处理消息 ({queueMessages.length})
          </div>
          {queueMessages.map((msg) => (
            <div
              key={msg.index}
              className="rounded border border-gray-800 bg-gray-900/50 px-3 py-2 text-xs text-gray-300"
            >
              {msg.preview}
            </div>
          ))}
        </div>
      )}

      {/* CLI Status - only show when missing */}
      {cliStatus === "missing" && (
        <div className="mx-6 flex items-center justify-between rounded-lg border border-yellow-800/50 bg-yellow-950/20 px-4 py-2.5">
          <div className="flex items-center gap-2">
            <AlertTriangle size={14} className="text-yellow-400" />
            <span className="text-xs text-yellow-300">
              Cursor CLI 未安装 — 无法自动拉起会话
            </span>
          </div>
          <button
            onClick={handleInstallCli}
            disabled={cliInstalling}
            className="flex items-center gap-1.5 rounded-md bg-blue-600/20 px-3 py-1 text-xs font-medium text-blue-400 transition hover:bg-blue-600/30 disabled:opacity-50"
          >
            {cliInstalling ? (
              <Loader2 size={12} className="animate-spin" />
            ) : (
              <Download size={12} />
            )}
            {cliInstalling ? "安装中..." : "一键安装"}
          </button>
        </div>
      )}
      {cliMessage && (
        <div className="mx-6 mt-1 rounded-lg border border-gray-800 bg-gray-900/50 px-4 py-2">
          <pre className="whitespace-pre-wrap font-mono text-xs text-gray-400">{cliMessage}</pre>
        </div>
      )}

      {/* Error message */}
      {actionError && (
        <div className="mx-6 mt-3 rounded-lg border border-red-800 bg-red-950/50 px-4 py-2 text-sm text-red-300">
          {actionError}
        </div>
      )}

      {/* Scheduled Tasks */}
      <div className="mx-6 mt-3">
        <div className="flex items-center justify-between">
          <button
            onClick={() => setShowTasks(!showTasks)}
            className="flex items-center gap-2 text-sm text-gray-400 transition hover:text-gray-200"
          >
            <Timer size={14} />
            <span>定时任务</span>
            {tasks.length > 0 && (
              <span className="rounded bg-gray-800 px-1.5 py-0.5 text-xs text-gray-500">
                {tasks.filter((t) => t.enabled).length}/{tasks.length}
              </span>
            )}
          </button>
          <button
            onClick={handleAddTask}
            className="flex items-center gap-1 rounded px-2 py-1 text-xs text-blue-400 transition hover:bg-blue-600/20"
          >
            <Plus size={12} />
            添加
          </button>
        </div>

        {showTasks && (
          <div className="mt-2 space-y-2">
            {tasks.map((task) => (
              <div
                key={task.id}
                className="flex items-center justify-between rounded-lg border border-gray-800 bg-gray-900/50 px-3 py-2"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className={`text-xs font-medium ${task.enabled ? "text-gray-200" : "text-gray-600"}`}>
                      {task.name}
                    </span>
                    <code className={`rounded bg-gray-800 px-1.5 py-0.5 text-xs ${task.enabled ? "text-blue-400" : "text-gray-600"}`}>
                      {task.cron}
                    </code>
                  </div>
                  <div className="mt-0.5 truncate text-xs text-gray-600">{task.content}</div>
                </div>
                <div className="ml-3 flex items-center gap-1">
                  <button
                    onClick={() => handleToggleTask(task.id)}
                    className={`rounded px-1.5 py-0.5 text-xs transition ${
                      task.enabled
                        ? "text-green-400 hover:bg-green-600/20"
                        : "text-gray-600 hover:bg-gray-700/50"
                    }`}
                    title={task.enabled ? "禁用" : "启用"}
                  >
                    {task.enabled ? "ON" : "OFF"}
                  </button>
                  <button
                    onClick={() => { setEditingTask({ ...task }); setCronValid(true) }}
                    className="rounded p-1 text-gray-500 transition hover:bg-gray-800 hover:text-gray-300"
                    title="编辑"
                  >
                    <Pencil size={12} />
                  </button>
                  <button
                    onClick={() => handleDeleteTask(task.id)}
                    className="rounded p-1 text-gray-500 transition hover:bg-red-600/20 hover:text-red-400"
                    title="删除"
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              </div>
            ))}

            {editingTask && (
              <div className="rounded-lg border border-blue-800/50 bg-blue-950/10 p-3 space-y-2">
                <div className="flex gap-2">
                  <input
                    value={editingTask.name}
                    onChange={(e) => setEditingTask({ ...editingTask, name: e.target.value })}
                    placeholder="任务名称"
                    className="flex-1 rounded border border-gray-700 bg-gray-900 px-2 py-1 text-xs text-gray-200 outline-none focus:border-blue-600"
                  />
                  <div className="flex flex-col">
                    <input
                      value={editingTask.cron}
                      onChange={(e) => { setEditingTask({ ...editingTask, cron: e.target.value }); setCronValid(true) }}
                      placeholder="cron 表达式，如 0 9 * * *"
                      className={`w-48 rounded border bg-gray-900 px-2 py-1 text-xs text-gray-200 outline-none focus:border-blue-600 ${
                        cronValid ? "border-gray-700" : "border-red-600"
                      }`}
                    />
                    {!cronValid && <span className="mt-0.5 text-xs text-red-400">无效的 cron 表达式</span>}
                  </div>
                </div>
                <textarea
                  value={editingTask.content}
                  onChange={(e) => setEditingTask({ ...editingTask, content: e.target.value })}
                  placeholder="任务内容（将作为消息发送给 Agent）"
                  rows={3}
                  className="w-full rounded border border-gray-700 bg-gray-900 px-2 py-1.5 text-xs text-gray-200 outline-none focus:border-blue-600"
                />
                <div className="flex items-center justify-between">
                  <div className="text-xs text-gray-600">
                    示例: <code className="text-gray-500">*/5 * * * *</code> 每5分钟 · <code className="text-gray-500">0 9 * * 1-5</code> 工作日9点 · <code className="text-gray-500">0 */2 * * *</code> 每2小时
                  </div>
                  <div className="flex gap-2">
                    <button
                      onClick={() => setEditingTask(null)}
                      className="flex items-center gap-1 rounded px-2 py-1 text-xs text-gray-400 transition hover:bg-gray-800"
                    >
                      <X size={12} />
                      取消
                    </button>
                    <button
                      onClick={handleSaveTask}
                      disabled={!editingTask.name.trim() || !editingTask.cron.trim() || !editingTask.content.trim()}
                      className="flex items-center gap-1 rounded bg-blue-600/20 px-2 py-1 text-xs text-blue-400 transition hover:bg-blue-600/30 disabled:opacity-40"
                    >
                      <Check size={12} />
                      保存
                    </button>
                  </div>
                </div>
              </div>
            )}

            {tasks.length === 0 && !editingTask && (
              <div className="py-3 text-center text-xs text-gray-600">
                暂无定时任务，点击「添加」创建
              </div>
            )}
          </div>
        )}
      </div>

      {/* Logs */}
      <div className="flex min-h-0 flex-1 flex-col px-6 py-4">
        <div className="mb-2 flex items-center justify-between text-sm text-gray-400">
          <div className="flex items-center gap-2">
            <Clock size={14} />
            <span>日志</span>
          </div>
          <div className="flex gap-2">
            {logs && (
              <button
                onClick={() => { navigator.clipboard.writeText(logs) }}
                className="rounded px-2 py-0.5 text-xs text-gray-500 transition hover:bg-gray-800 hover:text-gray-300"
              >
                复制
              </button>
            )}
            {logs && (
              <button
                onClick={() => setLogs("")}
                className="rounded px-2 py-0.5 text-xs text-gray-500 transition hover:bg-gray-800 hover:text-gray-300"
              >
                清空
              </button>
            )}
          </div>
        </div>
        <pre
          ref={logRef}
          className="flex-1 overflow-auto rounded-lg border border-gray-800 bg-gray-900/50 p-3 font-mono text-xs leading-5 text-gray-400"
        >
          {logs || "暂无日志"}
        </pre>
      </div>
    </div>
  )
}

function StatusCard({
  icon: Icon,
  label,
  value,
  color,
  sub,
  action,
}: {
  icon: typeof Wifi
  label: string
  value: string
  color: "green" | "red" | "blue" | "yellow" | "gray"
  sub?: string
  action?: React.ReactNode
}) {
  const colors: Record<string, string> = {
    green: "text-green-400",
    red: "text-red-400",
    blue: "text-blue-400",
    yellow: "text-yellow-400",
    gray: "text-gray-500",
  }

  const dotColors: Record<string, string> = {
    green: "bg-green-400",
    red: "bg-red-400",
    blue: "bg-blue-400",
    yellow: "bg-yellow-400",
    gray: "bg-gray-600",
  }

  return (
    <div className="rounded-lg border border-gray-800 p-3">
      <div className="mb-2 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Icon size={14} className={colors[color]} />
          <span className="text-xs text-gray-500">{label}</span>
        </div>
        {action}
      </div>
      <div className="flex items-center gap-2">
        <div className={`h-2 w-2 rounded-full ${dotColors[color]}`} />
        <span className={`text-sm font-medium ${colors[color]}`}>{value}</span>
      </div>
      {sub && <div className="mt-1 truncate text-xs text-gray-600">{sub}</div>}
    </div>
  )
}
