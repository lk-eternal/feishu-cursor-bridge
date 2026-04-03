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
  Download,
  LogIn,
  AlertTriangle,
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
  const [cliStatus, setCliStatus] = useState<"checking" | "installed" | "missing" | "need-login">("checking")
  const [cliInstalling, setCliInstalling] = useState(false)
  const [cliLoggingIn, setCliLoggingIn] = useState(false)
  const [cliMessage, setCliMessage] = useState("")
  const [stoppingAgent, setStoppingAgent] = useState(false)
  const logRef = useRef<HTMLPreElement>(null)

  useEffect(() => {
    const refresh = async () => {
      const s = await window.electronAPI.getDaemonStatus()
      setStatus(s)
      if (s.running && s.cliAvailable !== undefined) {
        setCliStatus((prev) => {
          if (!s.cliAvailable && (prev === "installed" || prev === "need-login")) {
            return "missing"
          }
          return prev
        })
      }
      if (s.queueLength && s.queueLength > 0) {
        const msgs = await window.electronAPI.getQueueMessages()
        setQueueMessages(msgs)
      } else {
        setQueueMessages([])
      }
    }
    refresh()
    const timer = setInterval(refresh, 5_000)

    window.electronAPI.getLogBuffer().then((buf) => {
      if (buf.length > 0) setLogs(buf.join("\n"))
    })

    const unsub = window.electronAPI.onDaemonStatus((s) => {
      setStatus(s)
      if (s.running && s.cliAvailable !== undefined) {
        setCliStatus((prev) => {
          if (!s.cliAvailable && (prev === "installed" || prev === "need-login")) {
            return "missing"
          }
          return prev
        })
      }
    })
    const unsubLog = window.electronAPI.onDaemonLog((line) => {
      setLogs((prev) => {
        const next = prev ? prev + "\n" + line : line
        const lines = next.split("\n")
        return lines.length > 300 ? lines.slice(-300).join("\n") : next
      })
    })

    const runCliChecks = () => {
      void (async () => {
        const installed = await window.electronAPI.checkCli()
        if (!installed) {
          setCliStatus("missing")
          return
        }
        const st = await window.electronAPI.checkCliLogin()
        if (st.loggedIn) {
          setCliStatus("installed")
        } else {
          setCliStatus("need-login")
        }
      })()
    }

    let cancelCliSchedule: (() => void) | undefined
    if (typeof requestIdleCallback === "function") {
      const id = requestIdleCallback(runCliChecks, { timeout: 2500 })
      cancelCliSchedule = () => cancelIdleCallback(id)
    } else {
      const cliTimer = window.setTimeout(runCliChecks, 0)
      cancelCliSchedule = () => clearTimeout(cliTimer)
    }

    return () => {
      clearInterval(timer)
      cancelCliSchedule?.()
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
      if (result.ok) {
        setCliStatus("need-login")
        setCliMessage("CLI 安装成功，正在打开浏览器进行授权...")
        try {
          const loginResult = await window.electronAPI.loginCli()
          if (loginResult.ok) {
            const st = await window.electronAPI.checkCliLogin()
            if (st.loggedIn) {
              setCliStatus("installed")
              setCliMessage("")
            } else {
              setCliStatus("need-login")
              setCliMessage(st.error ?? loginResult.output ?? "请重试登录")
            }
          } else {
            setCliMessage(loginResult.output)
          }
        } catch (e: unknown) {
          setCliMessage(`授权失败: ${e instanceof Error ? e.message : String(e)}`)
        }
      } else {
        setCliMessage(result.output)
      }
    } catch (e: unknown) {
      setCliMessage(e instanceof Error ? e.message : String(e))
    }
    setCliInstalling(false)
  }

  const handleLoginOnly = async () => {
    setCliLoggingIn(true)
    setCliMessage("")
    try {
      const loginResult = await window.electronAPI.loginCli()
      if (!loginResult.ok) {
        setCliMessage(loginResult.output)
        setCliLoggingIn(false)
        return
      }
      const st = await window.electronAPI.checkCliLogin()
      if (st.loggedIn) {
        setCliStatus("installed")
        setCliMessage("")
      } else {
        setCliMessage(st.error ?? loginResult.output ?? "登录后仍未检测到账号，请重试")
      }
    } catch (e: unknown) {
      setCliMessage(e instanceof Error ? e.message : String(e))
    }
    setCliLoggingIn(false)
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
          sub={
            status.running
              ? [
                  `uptime ${formatUptime(status.uptime)}`,
                  status.workspaceMismatch
                    ? (status.daemonWorkspaceDir
                      ? `目录与设置不一致（Daemon: ${status.daemonWorkspaceDir}）`
                      : "工作目录与设置不一致")
                    : "",
                ].filter(Boolean).join(" · ")
              : status.error
          }
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
      {cliStatus === "need-login" && (
        <div className="mx-6 flex items-center justify-between rounded-lg border border-yellow-800/50 bg-yellow-950/20 px-4 py-2.5">
          <div className="flex items-center gap-2">
            <AlertTriangle size={14} className="text-yellow-400" />
            <span className="text-xs text-yellow-300">
              Cursor CLI 未登录 — 请完成授权后再使用自动会话等功能
            </span>
          </div>
          <button
            onClick={handleLoginOnly}
            disabled={cliLoggingIn}
            className="flex items-center gap-1.5 rounded-md bg-blue-600/20 px-3 py-1 text-xs font-medium text-blue-400 transition hover:bg-blue-600/30 disabled:opacity-50"
          >
            {cliLoggingIn ? (
              <Loader2 size={12} className="animate-spin" />
            ) : (
              <LogIn size={12} />
            )}
            {cliLoggingIn ? "登录中..." : "登录 Cursor"}
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
