import { useState, useEffect, useCallback, useRef } from "react"
import {
  ChevronRight,
  ChevronLeft,
  KeyRound,
  Shield,
  UserCheck,
  Cpu,
  Rocket,
  CheckCircle2,
  Loader2,
  XCircle,
  Eye,
  EyeOff,
  RefreshCw,
  ExternalLink,
  Copy,
  FolderOpen,
  LogOut,
  SkipForward,
} from "lucide-react"
import SearchableSelect from "../components/SearchableSelect"
import WorkspaceDaemonModal from "../components/WorkspaceDaemonModal"
import TitleBar from "../components/TitleBar"
import useInlineModal from "../components/useInlineModal"

interface Props {
  onComplete: () => void
  onExit?: () => void
}

interface StepStatus {
  label: string
  status: "pending" | "running" | "done" | "error"
  message?: string
}

const REQUIRED_SCOPES = [
  { scope: "im:message", desc: "发送消息（create / reply）" },
  { scope: "im:message.p2p_msg:readonly", desc: "接收私聊消息" },
  { scope: "im:message.group_at_msg:readonly", desc: "接收群聊 @消息" },
  { scope: "im:resource", desc: "上传/下载图片与文件" },
  { scope: "im:chat:read", desc: "获取群聊名称" },
  { scope: "contact:user.base:readonly", desc: "获取用户名（私聊会话显示）" },
]

const SCOPES_JSON = JSON.stringify(
  { scopes: { tenant: REQUIRED_SCOPES.map((p) => p.scope), user: [] } },
  null,
  2,
)

export default function Setup({ onComplete, onExit }: Props) {
  const [step, setStep] = useState(0)
  const totalSteps = 5

  const [appId, setAppId] = useState("")
  const [appSecret, setAppSecret] = useState("")
  const [showSecret, setShowSecret] = useState(false)
  const [httpProxy, setHttpProxy] = useState("")
  const [httpsProxy, setHttpsProxy] = useState("")
  const [noProxy, setNoProxy] = useState("localhost,127.0.0.1,feishu.cn")

  const [scopesCopied, setScopesCopied] = useState(false)
  const [daemonOnline, setDaemonOnline] = useState<boolean | null>(null)
  const [daemonStarting, setDaemonStarting] = useState(false)
  const [daemonError, setDaemonError] = useState("")

  const [workspaceDir, setWorkspaceDir] = useState("")
  const [bindingStatus, setBindingStatus] = useState<"idle" | "waiting" | "bound" | "error">("idle")
  const [bindMsg, setBindMsg] = useState("")
  const bindPollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const [model, setModel] = useState("auto")
  const [modelOptions, setModelOptions] = useState<{ id: string; label: string }[]>([])
  const [loadingModels, setLoadingModels] = useState(false)
  const [cliReady, setCliReady] = useState<boolean | null>(null)
  const [cliLoggedIn, setCliLoggedIn] = useState<boolean | null>(null)
  const [cliInstalling, setCliInstalling] = useState(false)
  const [cliMsg, setCliMsg] = useState("")

  const [launchSteps, setLaunchSteps] = useState<StepStatus[]>([])
  const [launching, setLaunching] = useState(false)
  const [workspaceDaemonChoice, setWorkspaceDaemonChoice] = useState<{
    old: string; new: string; deferred: boolean
  } | null>(null)

  const { showAlert, ModalPortal } = useInlineModal()

  useEffect(() => {
    window.electronAPI.getConfig().then((cfg) => {
      if (cfg.larkAppId) setAppId(cfg.larkAppId)
      if (cfg.larkAppSecret) setAppSecret(cfg.larkAppSecret)
      if (cfg.workspaceDir) setWorkspaceDir(cfg.workspaceDir)
      if (cfg.model) setModel(cfg.model)
      if (cfg.httpProxy) setHttpProxy(cfg.httpProxy)
      if (cfg.httpsProxy) setHttpsProxy(cfg.httpsProxy)
      if (cfg.noProxy) setNoProxy(cfg.noProxy)
    })
  }, [])

  useEffect(() => {
    return () => { if (bindPollRef.current) clearInterval(bindPollRef.current) }
  }, [])

  const ensureDaemonRunning = useCallback(async () => {
    if (daemonStarting) return
    setDaemonStarting(true)
    setDaemonError("")
    try {
      await window.electronAPI.saveConfig({
        larkAppId: appId.trim(),
        larkAppSecret: appSecret.trim(),
        httpProxy: httpProxy.trim(),
        httpsProxy: httpsProxy.trim(),
        noProxy: noProxy.trim(),
      })
      const status = await window.electronAPI.getDaemonStatus()
      if (status.running) {
        setDaemonOnline(true)
        setDaemonStarting(false)
        return
      }
      const r = await window.electronAPI.startDaemon()
      if (r.ok) {
        setDaemonOnline(true)
      } else {
        setDaemonOnline(false)
        setDaemonError(r.error ?? "启动失败")
      }
    } catch (e: unknown) {
      setDaemonOnline(false)
      setDaemonError(e instanceof Error ? e.message : String(e))
    }
    setDaemonStarting(false)
  }, [appId, appSecret, httpProxy, httpsProxy, noProxy, daemonStarting])

  useEffect(() => {
    if (step === 1 && daemonOnline === null && !daemonStarting) void ensureDaemonRunning()
  }, [step, daemonOnline, daemonStarting, ensureDaemonRunning])

  const canNext = (): boolean => {
    if (step === 0) return !!(appId.trim() && appSecret.trim())
    if (step === 2) return !!workspaceDir.trim()
    return true
  }

  const next = () => setStep((s) => Math.min(s + 1, totalSteps - 1))
  const prev = () => setStep((s) => Math.max(s - 1, 0))
  const skip = () => next()

  const selectDir = async () => {
    const dir = await window.electronAPI.selectDirectory()
    if (dir) setWorkspaceDir(dir)
  }

  const startBindPoll = useCallback(async () => {
    if (!daemonOnline) {
      await ensureDaemonRunning()
    }
    await window.electronAPI.saveConfig({ workspaceDir: workspaceDir.trim() })

    setBindingStatus("waiting")
    setBindMsg("长连接已启动，请在飞书中向机器人发送任意消息完成绑定...")

    if (bindPollRef.current) clearInterval(bindPollRef.current)
    bindPollRef.current = setInterval(async () => {
      try {
        const status = await window.electronAPI.getDaemonStatus()
        if (status.hasTarget) {
          if (bindPollRef.current) clearInterval(bindPollRef.current)
          setBindingStatus("bound")
          setBindMsg("绑定成功！")
          if (status.autoOpenId) {
            await window.electronAPI.saveConfig({
              larkReceiveId: status.autoOpenId,
              larkReceiveIdType: "chat_id",
            })
          }
        }
      } catch { /* ignore */ }
    }, 2000)
  }, [daemonOnline, ensureDaemonRunning, workspaceDir])

  const checkAndLoadCli = useCallback(async () => {
    const ok = await window.electronAPI.checkCli()
    setCliReady(ok)
    if (ok) {
      const loginStatus = await window.electronAPI.checkCliLogin()
      setCliLoggedIn(loginStatus.loggedIn)
      if (loginStatus.loggedIn) await fetchModels()
    }
  }, [])

  const fetchModels = async () => {
    setLoadingModels(true)
    const result = await window.electronAPI.listModels()
    if (result.ok && result.models.length > 0) {
      setModelOptions(result.models)
    } else if (result.ok) {
      void showAlert("提示", "未解析到任何模型。请确认已登录 Cursor CLI。")
    } else {
      void showAlert("错误", result.error || "获取模型列表失败")
    }
    setLoadingModels(false)
  }

  const updateLaunchStep = (index: number, update: Partial<StepStatus>) => {
    setLaunchSteps((prev) => prev.map((s, i) => (i === index ? { ...s, ...update } : s)))
  }

  const runInjectAndFinish = async () => {
    updateLaunchStep(1, { status: "running" })
    const wsResult = await window.electronAPI.injectWorkspace()
    const summary = wsResult.results.map((r) => `${r.file}: ${r.action}`).join(", ")
    updateLaunchStep(1, { status: "done", message: summary })

    updateLaunchStep(2, { status: "running" })
    const daemonResult = await window.electronAPI.getDaemonStatus()
    if (daemonResult.running) {
      updateLaunchStep(2, { status: "done", message: "Daemon 运行中" })
    } else {
      const startResult = await window.electronAPI.startDaemon()
      if (startResult.ok) {
        updateLaunchStep(2, { status: "done", message: "Daemon 已启动" })
      } else {
        updateLaunchStep(2, { status: "error", message: startResult.error ?? "启动失败" })
        return
      }
    }
    setTimeout(onComplete, 1500)
  }

  const launch = async () => {
    setLaunching(true)
    const initialSteps: StepStatus[] = [
      { label: "保存配置", status: "pending" },
      { label: "注入工作区规则", status: "pending" },
      { label: "检查 Daemon", status: "pending" },
    ]
    setLaunchSteps(initialSteps)

    try {
      updateLaunchStep(0, { status: "running" })
      const saveR = await window.electronAPI.saveConfig({
        larkAppId: appId.trim(),
        larkAppSecret: appSecret.trim(),
        workspaceDir: workspaceDir.trim(),
        model,
        httpProxy: httpProxy.trim(),
        httpsProxy: httpsProxy.trim(),
        noProxy: noProxy.trim(),
        setupComplete: true,
      })

      if (saveR.needWorkspaceDaemonChoice && saveR.oldWorkspaceDir !== undefined && saveR.newWorkspaceDir !== undefined) {
        updateLaunchStep(0, { status: "pending", message: "请确认是否在新目录下重启 Daemon" })
        setWorkspaceDaemonChoice({ old: saveR.oldWorkspaceDir, new: saveR.newWorkspaceDir, deferred: !!saveR.deferredSetupComplete })
        setWorkspaceDir(saveR.oldWorkspaceDir)
        setLaunching(false)
        return
      }

      updateLaunchStep(0, { status: "done", message: "配置已加密保存" })
      await runInjectAndFinish()
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      setLaunchSteps((prev) => {
        const idx = prev.findIndex((s) => s.status === "running")
        if (idx >= 0) return prev.map((s, i) => (i === idx ? { ...s, status: "error" as const, message: msg } : s))
        return prev
      })
      setLaunching(false)
    }
  }

  const stepLabels = ["飞书凭据", "配置权限", "绑定用户", "Cursor CLI", "检查启动"]
  const stepIcons = [KeyRound, Shield, UserCheck, Cpu, Rocket]

  return (
    <div className="flex h-screen flex-col">
      <TitleBar>
        <h1 className="text-lg font-semibold">初始设置</h1>
      </TitleBar>

      {/* Progress bar */}
      <div className="flex items-center gap-0 border-b border-gray-800 px-6 py-5">
        {stepLabels.map((label, i) => {
          const Icon = stepIcons[i]
          const active = i === step
          const done = i < step
          return (
            <div key={i} className="flex flex-1 items-center">
              <div className="flex items-center gap-1.5">
                <div className={`flex h-7 w-7 items-center justify-center rounded-full text-xs font-medium transition-colors ${active ? "bg-blue-600 text-white" : done ? "bg-green-600 text-white" : "bg-gray-800 text-gray-500"}`}>
                  {done ? <CheckCircle2 size={14} /> : <Icon size={14} />}
                </div>
                <span className={`text-xs ${active ? "font-medium text-white" : "text-gray-500"}`}>{label}</span>
              </div>
              {i < totalSteps - 1 && <div className={`mx-2 h-px flex-1 ${i < step ? "bg-green-600" : "bg-gray-800"}`} />}
            </div>
          )
        })}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto px-8 py-6">

        {/* Step 0: 飞书应用凭据 */}
        {step === 0 && (
          <div className="mx-auto max-w-lg space-y-5">
            <div className="flex items-center justify-between">
              <h2 className="text-xl font-semibold">飞书应用凭据</h2>
              <a
                href="https://open.feishu.cn/app?lang=zh-CN"
                target="_blank"
                rel="noreferrer"
                className="flex items-center gap-1 rounded-md border border-gray-700 px-3 py-1.5 text-xs text-gray-400 transition hover:bg-gray-800 hover:text-blue-400"
              >
                <ExternalLink size={12} />前往创建飞书应用
              </a>
            </div>
            <p className="text-sm text-gray-400">
              请填写飞书开放平台创建的应用凭据，凭据将加密存储在本地。
            </p>

            <div className="space-y-4">
              <div>
                <label className="mb-1 block text-sm text-gray-300">App ID</label>
                <input type="text" value={appId} onChange={(e) => setAppId(e.target.value)} placeholder="cli_xxxxxxxxx" className="w-full rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-sm outline-none transition focus:border-blue-500" />
              </div>
              <div>
                <label className="mb-1 block text-sm text-gray-300">App Secret</label>
                <div className="relative">
                  <input type={showSecret ? "text" : "password"} value={appSecret} onChange={(e) => setAppSecret(e.target.value)} placeholder="xxxxxxxxxxxxxxxx" className="w-full rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 pr-10 text-sm outline-none transition focus:border-blue-500" />
                  <button type="button" onClick={() => setShowSecret(!showSecret)} className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300">
                    {showSecret ? <EyeOff size={16} /> : <Eye size={16} />}
                  </button>
                </div>
              </div>
            </div>

            <div className="mt-4 border-t border-gray-800 pt-4">
              <h3 className="mb-3 text-sm font-medium text-gray-400">代理设置（可选）</h3>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="mb-1 block text-xs text-gray-500">HTTP_PROXY</label>
                  <input type="text" value={httpProxy} onChange={(e) => setHttpProxy(e.target.value)} placeholder="http://127.0.0.1:1080" className="w-full rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-sm outline-none transition focus:border-blue-500" />
                </div>
                <div>
                  <label className="mb-1 block text-xs text-gray-500">HTTPS_PROXY</label>
                  <input type="text" value={httpsProxy} onChange={(e) => setHttpsProxy(e.target.value)} placeholder="http://127.0.0.1:1080" className="w-full rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-sm outline-none transition focus:border-blue-500" />
                </div>
              </div>
              <div className="mt-3">
                <label className="mb-1 block text-xs text-gray-500">NO_PROXY</label>
                <input type="text" value={noProxy} onChange={(e) => setNoProxy(e.target.value)} placeholder="localhost,127.0.0.1,feishu.cn" className="w-full rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-sm outline-none transition focus:border-blue-500" />
              </div>
            </div>
          </div>
        )}

        {/* Step 1: 配置飞书权限 */}
        {step === 1 && (
          <div className="mx-auto max-w-lg space-y-5">
            <h2 className="text-xl font-semibold">配置飞书权限</h2>
            <p className="text-sm text-gray-400">
              请在飞书开放平台的应用后台配置以下权限和事件订阅。
            </p>

            {/* 权限表 */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-medium text-gray-300">应用权限</h3>
                <button
                  onClick={() => { navigator.clipboard.writeText(SCOPES_JSON); setScopesCopied(true); setTimeout(() => setScopesCopied(false), 2000) }}
                  className="flex items-center gap-1.5 rounded-md border border-gray-700 px-2.5 py-1 text-xs text-gray-400 transition hover:bg-gray-800 hover:text-white"
                >
                  <Copy size={12} />{scopesCopied ? "已复制" : "复制权限 JSON"}
                </button>
              </div>
              <div className="rounded-lg border border-gray-800 divide-y divide-gray-800">
                {REQUIRED_SCOPES.map((p) => (
                  <div key={p.scope} className="flex items-center justify-between px-3 py-2">
                    <code className="text-xs text-blue-400">{p.scope}</code>
                    <span className="text-xs text-gray-500">{p.desc}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* 事件订阅 */}
            <div className="space-y-2">
              <h3 className="text-sm font-medium text-gray-300">事件订阅</h3>
              <div className="rounded-lg border border-gray-800 p-3 space-y-2">
                <div className="flex items-center justify-between">
                  <code className="text-xs text-blue-400">im.message.receive_v1</code>
                  <span className="text-xs text-gray-500">接收消息 v2.0</span>
                </div>
                <div className="text-xs text-gray-500 space-y-1">
                  <div>订阅方式：<span className="text-gray-300">应用身份</span></div>
                  <div>回调类型：<span className="text-gray-300">长连接（WebSocket）</span></div>
                </div>
              </div>
            </div>

            {/* 连接状态 */}
            <div className="rounded-lg border border-gray-800 p-3">
              <div className="flex items-center justify-between">
                <span className="text-sm text-gray-300">长连接状态</span>
                {daemonStarting && <span className="flex items-center gap-1.5 text-xs text-blue-400"><Loader2 size={12} className="animate-spin" />启动中...</span>}
                {daemonOnline === true && !daemonStarting && <span className="flex items-center gap-1.5 text-xs text-green-400"><CheckCircle2 size={12} />已连接</span>}
                {daemonOnline === false && !daemonStarting && <span className="flex items-center gap-1.5 text-xs text-red-400"><XCircle size={12} />未连接</span>}
                {daemonOnline === null && !daemonStarting && <span className="text-xs text-gray-500">等待启动</span>}
              </div>
              {daemonError && <p className="mt-1 text-xs text-red-400">{daemonError}</p>}
              <p className="mt-2 text-xs text-gray-500">
                飞书后台保存事件订阅配置前需要应用长连接在线。{!daemonOnline && !daemonStarting && (
                  <button onClick={ensureDaemonRunning} className="ml-1 text-blue-400 hover:underline">手动启动</button>
                )}
              </p>
            </div>
          </div>
        )}

        {/* Step 2: 绑定主用户 */}
        {step === 2 && (
          <div className="mx-auto max-w-lg space-y-5">
            <h2 className="text-xl font-semibold">绑定主用户</h2>
            <p className="text-sm text-gray-400">
              选择工作目录并启动飞书长连接，然后在飞书中向机器人发送任意消息完成绑定。
            </p>

            <div>
              <label className="mb-1 block text-sm text-gray-300">工作目录</label>
              <div
                onClick={selectDir}
                className="flex cursor-pointer items-center gap-3 rounded-lg border border-dashed border-gray-600 p-4 transition hover:border-blue-500 hover:bg-gray-900/50"
              >
                <FolderOpen size={24} className="text-blue-400" />
                {workspaceDir ? (
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium">{workspaceDir.split(/[/\\]/).pop()}</div>
                    <div className="truncate text-xs text-gray-500">{workspaceDir}</div>
                  </div>
                ) : (
                  <span className="text-sm text-gray-400">点击选择目录...</span>
                )}
              </div>
            </div>

            {workspaceDir && bindingStatus === "idle" && (
              <button
                onClick={startBindPoll}
                className="flex w-full items-center justify-center gap-2 rounded-lg bg-blue-600 px-4 py-3 text-sm font-medium text-white transition hover:bg-blue-500"
              >
                <Rocket size={16} />开始等待绑定
              </button>
            )}

            {bindingStatus === "waiting" && (
              <div className="rounded-lg border border-yellow-800/50 bg-yellow-950/20 p-4 space-y-2">
                <div className="flex items-center gap-2">
                  <Loader2 size={18} className="animate-spin text-yellow-400" />
                  <span className="text-sm font-medium text-yellow-300">等待绑定</span>
                </div>
                <p className="text-xs text-yellow-200/70">{bindMsg}</p>
              </div>
            )}

            {bindingStatus === "bound" && (
              <div className="flex items-center gap-2 rounded-lg border border-green-800/50 bg-green-950/20 px-4 py-3">
                <CheckCircle2 size={18} className="text-green-400" />
                <span className="text-sm font-medium text-green-300">{bindMsg}</span>
              </div>
            )}

            {bindingStatus === "error" && (
              <div className="space-y-2 rounded-lg border border-red-800/50 bg-red-950/20 p-4">
                <div className="flex items-center gap-2">
                  <XCircle size={18} className="text-red-400" />
                  <span className="text-sm font-medium text-red-300">连接失败</span>
                </div>
                <p className="text-xs text-red-200/70">{bindMsg}</p>
                <button
                  onClick={() => { setBindingStatus("idle"); setBindMsg("") }}
                  className="text-xs text-blue-400 hover:underline"
                >
                  重试
                </button>
              </div>
            )}
          </div>
        )}

        {/* Step 3: Cursor CLI */}
        {step === 3 && (
          <div className="mx-auto max-w-lg space-y-5">
            <h2 className="text-xl font-semibold">Cursor CLI</h2>
            <p className="text-sm text-gray-400">
              检测 Cursor CLI 安装状态，登录授权后加载可用模型。
            </p>

            {cliReady === null && (
              <button onClick={checkAndLoadCli} className="flex items-center gap-2 rounded-lg border border-gray-700 px-4 py-2 text-sm text-gray-300 transition hover:bg-gray-800">
                <RefreshCw size={14} />检测 Cursor CLI
              </button>
            )}

            {cliReady === false && (
              <div className="rounded-lg border border-yellow-800/50 bg-yellow-950/20 p-4 space-y-3">
                <p className="text-sm text-yellow-300">Cursor CLI 未安装。</p>
                <button
                  onClick={async () => {
                    setCliInstalling(true); setCliMsg("")
                    const r = await window.electronAPI.installCli()
                    setCliMsg(r.output)
                    if (r.ok) { setCliReady(true); await checkAndLoadCli() }
                    setCliInstalling(false)
                  }}
                  disabled={cliInstalling}
                  className="flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-blue-500 disabled:opacity-50"
                >
                  {cliInstalling ? <Loader2 size={14} className="animate-spin" /> : null}
                  {cliInstalling ? "安装中..." : "一键安装 CLI"}
                </button>
                {cliMsg && <pre className="text-xs text-gray-400 whitespace-pre-wrap">{cliMsg}</pre>}
              </div>
            )}

            {cliReady && cliLoggedIn === false && (
              <div className="rounded-lg border border-yellow-800/50 bg-yellow-950/20 p-4 space-y-3">
                <p className="text-sm text-yellow-300">CLI 已安装但尚未登录。请在终端执行 <code className="text-blue-400">cursor login</code> 后刷新。</p>
                <button onClick={checkAndLoadCli} className="flex items-center gap-2 rounded-lg border border-gray-700 px-4 py-2 text-sm text-gray-300 transition hover:bg-gray-800">
                  <RefreshCw size={14} />重新检测
                </button>
              </div>
            )}

            {cliReady && cliLoggedIn !== false && (
              <div className="space-y-3">
                <div className="flex items-center gap-2 text-sm text-green-400">
                  <CheckCircle2 size={16} />CLI 已就绪{cliLoggedIn ? "（已登录）" : ""}
                </div>
                <button
                  onClick={fetchModels}
                  disabled={loadingModels}
                  className="flex items-center gap-2 rounded-lg border border-gray-700 px-4 py-2 text-sm text-gray-300 transition hover:bg-gray-800 disabled:opacity-50"
                >
                  {loadingModels ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
                  刷新模型列表
                </button>

                {modelOptions.length > 0 ? (
                  <SearchableSelect value={model} onChange={setModel} options={modelOptions} placeholder="选择模型..." />
                ) : (
                  <input type="text" value={model} onChange={(e) => setModel(e.target.value)} placeholder="auto" className="w-full rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-sm outline-none transition focus:border-blue-500" />
                )}
                <p className="text-xs text-gray-500">也可以直接输入模型名称。</p>
              </div>
            )}
          </div>
        )}

        {/* Step 4: 检查启动 */}
        {step === 4 && (
          <div className="mx-auto max-w-lg space-y-5">
            <h2 className="text-xl font-semibold">配置完成</h2>
            <p className="text-sm text-gray-400">
              点击下方按钮保存配置、注入工作区规则并完成启动。
            </p>

            {launchSteps.length > 0 ? (
              <div className="space-y-3">
                {launchSteps.map((s, i) => (
                  <div key={i} className="flex items-center gap-3 rounded-lg border border-gray-800 px-4 py-3">
                    {s.status === "pending" && <div className="h-5 w-5 rounded-full border-2 border-gray-700" />}
                    {s.status === "running" && <Loader2 size={20} className="animate-spin text-blue-400" />}
                    {s.status === "done" && <CheckCircle2 size={20} className="text-green-400" />}
                    {s.status === "error" && <XCircle size={20} className="text-red-400" />}
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium">{s.label}</div>
                      {s.message && <div className="truncate text-xs text-gray-500">{s.message}</div>}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <button
                onClick={launch}
                disabled={launching}
                className="flex w-full items-center justify-center gap-2 rounded-lg bg-blue-600 px-4 py-3 text-sm font-medium text-white transition hover:bg-blue-500 disabled:opacity-50"
              >
                <Rocket size={18} />一键注入并启动
              </button>
            )}
          </div>
        )}
      </div>

      <WorkspaceDaemonModal
        open={workspaceDaemonChoice !== null}
        oldPath={workspaceDaemonChoice?.old ?? ""}
        newPath={workspaceDaemonChoice?.new ?? ""}
        onKeep={() => setWorkspaceDaemonChoice(null)}
        onRestarted={(ok, err) => {
          const ctx = workspaceDaemonChoice
          setWorkspaceDaemonChoice(null)
          if (!ok) {
            if (err) void showAlert("错误", `重启 Daemon 失败：\n${err}`)
            return
          }
          if (!ctx) return
          void (async () => {
            try {
              if (ctx.deferred) await window.electronAPI.saveConfig({ setupComplete: true })
              setWorkspaceDir(ctx.new)
              updateLaunchStep(0, { status: "done", message: "配置已加密保存" })
              setLaunching(true)
              await runInjectAndFinish()
            } catch (e: unknown) {
              const msg = e instanceof Error ? e.message : String(e)
              setLaunchSteps((prev) => {
                const idx = prev.findIndex((s) => s.status === "running")
                if (idx >= 0) return prev.map((s, i) => (i === idx ? { ...s, status: "error" as const, message: msg } : s))
                return prev
              })
              setLaunching(false)
            }
          })()
        }}
      />

      {/* Navigation */}
      <div className="flex items-center justify-between border-t border-gray-800 px-8 py-4">
        <div className="flex items-center gap-2">
          {onExit && (
            <button
              onClick={onExit}
              className="flex items-center gap-1 rounded-lg px-3 py-2 text-sm text-gray-500 transition hover:text-gray-300"
            >
              <LogOut size={14} />退出引导
            </button>
          )}
          {step > 0 && (
            <button onClick={prev} className="flex items-center gap-1 rounded-lg px-3 py-2 text-sm text-gray-400 transition hover:text-white">
              <ChevronLeft size={16} />上一步
            </button>
          )}
        </div>

        {step < totalSteps - 1 && (
          <div className="flex items-center gap-2">
            {step > 0 && step < totalSteps - 1 && (
              <button onClick={skip} className="flex items-center gap-1 rounded-lg px-3 py-2 text-sm text-gray-500 transition hover:text-gray-300">
                <SkipForward size={14} />跳过
              </button>
            )}
            <button
              onClick={next}
              disabled={!canNext()}
              className="flex items-center gap-1 rounded-lg bg-blue-600 px-5 py-2 text-sm font-medium text-white transition hover:bg-blue-500 disabled:opacity-40"
            >
              下一步<ChevronRight size={16} />
            </button>
          </div>
        )}
      </div>
      {ModalPortal}
    </div>
  )
}
