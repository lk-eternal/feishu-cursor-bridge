import { useState } from "react"
import {
  ChevronRight,
  ChevronLeft,
  KeyRound,
  FolderOpen,
  Cpu,
  Rocket,
  CheckCircle2,
  Loader2,
  XCircle,
  Eye,
  EyeOff,
  RefreshCw,
} from "lucide-react"
import SearchableSelect from "../components/SearchableSelect"
import WorkspaceDaemonModal from "../components/WorkspaceDaemonModal"
import TitleBar from "../components/TitleBar"

interface Props {
  onComplete: () => void
}

type IdType = "open_id" | "user_id" | "chat_id"

interface StepStatus {
  label: string
  status: "pending" | "running" | "done" | "error"
  message?: string
}

export default function Setup({ onComplete }: Props) {
  const [step, setStep] = useState(0)

  const [appId, setAppId] = useState("")
  const [appSecret, setAppSecret] = useState("")
  const [receiveId, setReceiveId] = useState("")
  const [idType, setIdType] = useState<IdType>("open_id")
  const [showSecret, setShowSecret] = useState(false)

  const [workspaceDir, setWorkspaceDir] = useState("")

  const [model, setModel] = useState("auto")
  const [httpProxy, setHttpProxy] = useState("")
  const [httpsProxy, setHttpsProxy] = useState("")
  const [noProxy, setNoProxy] = useState("localhost,127.0.0.1,feishu.cn")
  const [modelOptions, setModelOptions] = useState<{ id: string; label: string }[]>([])
  const [loadingModels, setLoadingModels] = useState(false)
  const [cliReady, setCliReady] = useState<boolean | null>(null)
  const [cliInstalling, setCliInstalling] = useState(false)
  const [cliMsg, setCliMsg] = useState("")

  const [steps, setSteps] = useState<StepStatus[]>([])
  const [launching, setLaunching] = useState(false)
  const [workspaceDaemonChoice, setWorkspaceDaemonChoice] = useState<{
    old: string
    new: string
    deferred: boolean
  } | null>(null)

  const canNext = (): boolean => {
    if (step === 0) return !!(appId.trim() && appSecret.trim())
    if (step === 1) return !!workspaceDir.trim()
    return true
  }

  const next = () => setStep((s) => Math.min(s + 1, 3))
  const prev = () => setStep((s) => Math.max(s - 1, 0))

  const selectDir = async () => {
    const dir = await window.electronAPI.selectDirectory()
    if (dir) setWorkspaceDir(dir)
  }

  const fetchModels = async () => {
    setLoadingModels(true)
    await window.electronAPI.saveConfig({
      httpProxy: httpProxy.trim(),
      httpsProxy: httpsProxy.trim(),
      noProxy: noProxy.trim(),
    })
    const result = await window.electronAPI.listModels()
    if (result.ok && result.models.length > 0) {
      setModelOptions(result.models)
    } else if (result.ok) {
      alert("未解析到任何模型。请确认已登录 Cursor CLI，或在终端执行 agent --list-models 查看输出。")
    } else {
      alert(result.error || "获取模型列表失败")
    }
    setLoadingModels(false)
  }

  const updateStep = (index: number, update: Partial<StepStatus>) => {
    setSteps((prev) => prev.map((s, i) => (i === index ? { ...s, ...update } : s)))
  }

  const runInjectAndDaemon = async () => {
    updateStep(1, { status: "running" })
    const wsResult = await window.electronAPI.injectWorkspace()
    const summary = wsResult.results.map((r) => `${r.file}: ${r.action}`).join(", ")
    updateStep(1, { status: "done", message: summary })

    updateStep(2, { status: "running" })
    const daemonResult = await window.electronAPI.startDaemon()
    if (daemonResult.ok) {
      updateStep(2, { status: "done", message: "Daemon 运行中" })
    } else {
      updateStep(2, { status: "error", message: daemonResult.error ?? "启动失败" })
    }

    setTimeout(onComplete, 1500)
  }

  const launch = async () => {
    setLaunching(true)
    const initialSteps: StepStatus[] = [
      { label: "保存配置", status: "pending" },
      { label: "注入工作区规则", status: "pending" },
      { label: "启动 Daemon", status: "pending" },
    ]
    setSteps(initialSteps)

    try {
      updateStep(0, { status: "running" })
      const saveR = await window.electronAPI.saveConfig({
        larkAppId: appId.trim(),
        larkAppSecret: appSecret.trim(),
        larkReceiveId: receiveId.trim(),
        larkReceiveIdType: idType,
        workspaceDir: workspaceDir.trim(),
        model,
        httpProxy: httpProxy.trim(),
        httpsProxy: httpsProxy.trim(),
        noProxy: noProxy.trim(),
        setupComplete: true,
      })

      if (
        saveR.needWorkspaceDaemonChoice
        && saveR.oldWorkspaceDir !== undefined
        && saveR.newWorkspaceDir !== undefined
      ) {
        updateStep(0, { status: "pending", message: "请确认是否在新目录下重启 Daemon" })
        setWorkspaceDaemonChoice({
          old: saveR.oldWorkspaceDir,
          new: saveR.newWorkspaceDir,
          deferred: !!saveR.deferredSetupComplete,
        })
        setWorkspaceDir(saveR.oldWorkspaceDir)
        setLaunching(false)
        return
      }

      updateStep(0, { status: "done", message: "配置已加密保存" })
      await runInjectAndDaemon()
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      setSteps((prev) => {
        const running = prev.findIndex((s) => s.status === "running")
        if (running >= 0) {
          return prev.map((s, i) =>
            i === running ? { ...s, status: "error" as const, message: msg } : s,
          )
        }
        return prev
      })
      setLaunching(false)
    }
  }

  const stepLabels = ["飞书凭据", "工作目录", "模型选择", "检查启动"]
  const stepIcons = [KeyRound, FolderOpen, Cpu, Rocket]

  return (
    <div className="flex h-screen flex-col">
      <TitleBar>
        <h1 className="text-lg font-semibold">初始设置</h1>
      </TitleBar>
      {/* Progress bar */}
      <div className="flex items-center gap-0 border-b border-gray-800 px-8 py-5">
        {stepLabels.map((label, i) => {
          const Icon = stepIcons[i]
          const active = i === step
          const done = i < step
          return (
            <div key={i} className="flex flex-1 items-center">
              <div className="flex items-center gap-2">
                <div
                  className={`flex h-8 w-8 items-center justify-center rounded-full text-sm font-medium transition-colors ${
                    active
                      ? "bg-blue-600 text-white"
                      : done
                        ? "bg-green-600 text-white"
                        : "bg-gray-800 text-gray-500"
                  }`}
                >
                  {done ? <CheckCircle2 size={16} /> : <Icon size={16} />}
                </div>
                <span
                  className={`text-sm ${active ? "font-medium text-white" : "text-gray-500"}`}
                >
                  {label}
                </span>
              </div>
              {i < 3 && (
                <div
                  className={`mx-3 h-px flex-1 ${
                    i < step ? "bg-green-600" : "bg-gray-800"
                  }`}
                />
              )}
            </div>
          )
        })}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto px-8 py-6">
        {step === 0 && (
          <div className="mx-auto max-w-lg space-y-5">
            <h2 className="text-xl font-semibold">飞书应用凭据</h2>
            <p className="text-sm text-gray-400">
              请填写飞书开放平台创建的应用凭据，凭据将加密存储在本地。
            </p>

            <div className="space-y-4">
              <div>
                <label className="mb-1 block text-sm text-gray-300">App ID</label>
                <input
                  type="text"
                  value={appId}
                  onChange={(e) => setAppId(e.target.value)}
                  placeholder="cli_xxxxxxxxx"
                  className="w-full rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-sm outline-none transition focus:border-blue-500"
                />
              </div>
              <div>
                <label className="mb-1 block text-sm text-gray-300">App Secret</label>
                <div className="relative">
                  <input
                    type={showSecret ? "text" : "password"}
                    value={appSecret}
                    onChange={(e) => setAppSecret(e.target.value)}
                    placeholder="xxxxxxxxxxxxxxxx"
                    className="w-full rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 pr-10 text-sm outline-none transition focus:border-blue-500"
                  />
                  <button
                    type="button"
                    onClick={() => setShowSecret(!showSecret)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300"
                  >
                    {showSecret ? <EyeOff size={16} /> : <Eye size={16} />}
                  </button>
                </div>
              </div>
              <div>
                <label className="mb-1 block text-sm text-gray-300">
                  Receive ID <span className="text-gray-600">(收到首条消息后自动填写，无需手动配置)</span>
                </label>
                <input
                  type="text"
                  value={receiveId}
                  readOnly
                  tabIndex={-1}
                  placeholder="将在收到飞书消息后自动检测"
                  className="w-full cursor-default rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-sm opacity-70 outline-none"
                />
              </div>
              <div>
                <label className="mb-1 block text-sm text-gray-300">ID 类型</label>
                <select
                  value={idType}
                  onChange={(e) => setIdType(e.target.value as IdType)}
                  className="w-full rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-sm outline-none transition focus:border-blue-500"
                >
                  <option value="open_id">Open ID</option>
                  <option value="user_id">User ID</option>
                  <option value="chat_id">Chat ID (群组)</option>
                </select>
              </div>
            </div>

            <div className="mt-4 border-t border-gray-800 pt-4">
              <h3 className="mb-3 text-sm font-medium text-gray-400">代理设置（可选）</h3>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="mb-1 block text-xs text-gray-500">HTTP_PROXY</label>
                  <input
                    type="text"
                    value={httpProxy}
                    onChange={(e) => setHttpProxy(e.target.value)}
                    placeholder="http://127.0.0.1:1080"
                    className="w-full rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-sm outline-none transition focus:border-blue-500"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs text-gray-500">HTTPS_PROXY</label>
                  <input
                    type="text"
                    value={httpsProxy}
                    onChange={(e) => setHttpsProxy(e.target.value)}
                    placeholder="http://127.0.0.1:1080"
                    className="w-full rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-sm outline-none transition focus:border-blue-500"
                  />
                </div>
              </div>
              <div className="mt-3">
                <label className="mb-1 block text-xs text-gray-500">NO_PROXY</label>
                <input
                  type="text"
                  value={noProxy}
                  onChange={(e) => setNoProxy(e.target.value)}
                  placeholder="localhost,127.0.0.1,feishu.cn"
                  className="w-full rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-sm outline-none transition focus:border-blue-500"
                />
              </div>
            </div>
          </div>
        )}

        {step === 1 && (
          <div className="mx-auto max-w-lg space-y-5">
            <h2 className="text-xl font-semibold">工作目录</h2>
            <p className="text-sm text-gray-400">
              选择 Cursor 打开的项目目录。应用将在此目录注入规则和 Hook。
            </p>

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
        )}

        {step === 2 && (
          <div className="mx-auto max-w-lg space-y-5">
            <h2 className="text-xl font-semibold">模型选择</h2>
            <p className="text-sm text-gray-400">
              选择 Cursor CLI 自动拉起时使用的模型。
            </p>

            {cliReady === null && (
              <button
                onClick={async () => {
                  const ok = await window.electronAPI.checkCli()
                  setCliReady(ok)
                  if (ok) fetchModels()
                }}
                className="flex items-center gap-2 rounded-lg border border-gray-700 px-4 py-2 text-sm text-gray-300 transition hover:bg-gray-800"
              >
                <RefreshCw size={14} />
                检测 Cursor CLI 并加载模型
              </button>
            )}

            {cliReady === false && (
              <div className="rounded-lg border border-yellow-800/50 bg-yellow-950/20 p-4 space-y-3">
                <p className="text-sm text-yellow-300">Cursor CLI 未安装，需要先安装才能获取模型列表。</p>
                <button
                  onClick={async () => {
                    setCliInstalling(true)
                    setCliMsg("")
                    const r = await window.electronAPI.installCli()
                    setCliMsg(r.output)
                    if (r.ok) {
                      setCliReady(true)
                      fetchModels()
                    }
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

            <div className="space-y-3">
              {cliReady && (
                <button
                  onClick={fetchModels}
                  disabled={loadingModels}
                  className="flex items-center gap-2 rounded-lg border border-gray-700 px-4 py-2 text-sm text-gray-300 transition hover:bg-gray-800 disabled:opacity-50"
                >
                  {loadingModels ? (
                    <Loader2 size={14} className="animate-spin" />
                  ) : (
                    <RefreshCw size={14} />
                  )}
                  刷新模型列表
                </button>
              )}

              {modelOptions.length > 0 ? (
                <SearchableSelect
                  value={model}
                  onChange={setModel}
                  options={modelOptions}
                  placeholder="选择模型..."
                />
              ) : (
                <input
                  type="text"
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  placeholder="auto"
                  className="w-full rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-sm outline-none transition focus:border-blue-500"
                />
              )}
              <p className="text-xs text-gray-500">
                如果模型列表不完整，请在第一步配置代理后重新获取。也可以直接输入模型名称。
              </p>
            </div>
          </div>
        )}

        {step === 3 && (
          <div className="mx-auto max-w-lg space-y-5">
            <h2 className="text-xl font-semibold">环境检查与启动</h2>
            <p className="text-sm text-gray-400">
              点击下方按钮，将自动注入配置并启动 Daemon。
            </p>

            {steps.length > 0 ? (
              <div className="space-y-3">
                {steps.map((s, i) => (
                  <div
                    key={i}
                    className="flex items-center gap-3 rounded-lg border border-gray-800 px-4 py-3"
                  >
                    {s.status === "pending" && (
                      <div className="h-5 w-5 rounded-full border-2 border-gray-700" />
                    )}
                    {s.status === "running" && (
                      <Loader2 size={20} className="animate-spin text-blue-400" />
                    )}
                    {s.status === "done" && (
                      <CheckCircle2 size={20} className="text-green-400" />
                    )}
                    {s.status === "error" && (
                      <XCircle size={20} className="text-red-400" />
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium">{s.label}</div>
                      {s.message && (
                        <div className="truncate text-xs text-gray-500">{s.message}</div>
                      )}
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
                <Rocket size={18} />
                一键注入并启动
              </button>
            )}
          </div>
        )}
      </div>

      <WorkspaceDaemonModal
        open={workspaceDaemonChoice !== null}
        oldPath={workspaceDaemonChoice?.old ?? ""}
        newPath={workspaceDaemonChoice?.new ?? ""}
        onKeep={() => {
          setWorkspaceDaemonChoice(null)
        }}
        onRestarted={(ok, err) => {
          const ctx = workspaceDaemonChoice
          setWorkspaceDaemonChoice(null)
          if (!ok) {
            if (err) {
              alert(`重启 Daemon 失败：\n${err}`)
            }
            return
          }
          if (!ctx) {
            return
          }
          void (async () => {
            try {
              if (ctx.deferred) {
                await window.electronAPI.saveConfig({ setupComplete: true })
              }
              setWorkspaceDir(ctx.new)
              updateStep(0, { status: "done", message: "配置已加密保存" })
              setLaunching(true)
              await runInjectAndDaemon()
            } catch (e: unknown) {
              const msg = e instanceof Error ? e.message : String(e)
              setSteps((prev) => {
                const running = prev.findIndex((s) => s.status === "running")
                if (running >= 0) {
                  return prev.map((s, i) =>
                    i === running ? { ...s, status: "error" as const, message: msg } : s,
                  )
                }
                return prev
              })
              setLaunching(false)
            }
          })()
        }}
      />

      {/* Navigation */}
      <div className="flex items-center justify-between border-t border-gray-800 px-8 py-4">
        <button
          onClick={prev}
          disabled={step === 0}
          className="flex items-center gap-1 rounded-lg px-4 py-2 text-sm text-gray-400 transition hover:text-white disabled:invisible"
        >
          <ChevronLeft size={16} />
          上一步
        </button>

        {step < 3 && (
          <button
            onClick={next}
            disabled={!canNext()}
            className="flex items-center gap-1 rounded-lg bg-blue-600 px-5 py-2 text-sm font-medium text-white transition hover:bg-blue-500 disabled:opacity-40"
          >
            下一步
            <ChevronRight size={16} />
          </button>
        )}
      </div>
    </div>
  )
}
