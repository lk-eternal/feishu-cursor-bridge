import { useState, useEffect, useRef, useCallback } from "react"
import {
  ArrowLeft,
  FolderOpen,
  CheckCircle2,
  Loader2,
  Eye,
  EyeOff,
  RefreshCw,
  ShieldCheck,
  ShieldAlert,
  LogIn,
  Plus,
  Pencil,
  Trash2,
  Terminal,
  X,
  Settings as SettingsIcon,
  Network,
  Blocks,
  FileCode2,
  Timer,
  Sparkles,
  Bot,
} from "lucide-react"
import SearchableSelect from "../components/SearchableSelect"
import WorkspaceDaemonModal from "../components/WorkspaceDaemonModal"

interface Props { onBack: () => void }

type IdType = "open_id" | "user_id" | "chat_id"
type Tab = "general" | "proxy" | "agent" | "mcp" | "rules" | "tasks" | "skills"
type CloseWindowAction = "ask" | "minimize" | "quit"

interface McpEditForm {
  json: string; source: "global" | "project"; jsonError?: string
}
interface RuleFile { name: string; content: string }
interface SkillFile { name: string; content: string }
interface TaskItem { id: string; name: string; cron: string; content: string; enabled: boolean }

const MCP_TEMPLATE = JSON.stringify({
  "my-mcp-server": { command: "npx", args: ["-y", "@some/mcp-server"] },
}, null, 2)
const emptyMcpForm: McpEditForm = { json: MCP_TEMPLATE, source: "global" }

const TABS: { id: Tab; label: string; icon: typeof SettingsIcon }[] = [
  { id: "general", label: "通用", icon: SettingsIcon },
  { id: "proxy", label: "网络", icon: Network },
  { id: "agent", label: "Agent", icon: Bot },
  { id: "mcp", label: "MCP", icon: Blocks },
  { id: "rules", label: "Rules", icon: FileCode2 },
  { id: "skills", label: "Skills", icon: Sparkles },
  { id: "tasks", label: "定时任务", icon: Timer },
]

export default function Settings({ onBack }: Props) {
  const [tab, setTab] = useState<Tab>("general")

  const [appId, setAppId] = useState("")
  const [appSecret, setAppSecret] = useState("")
  const [receiveId, setReceiveId] = useState("")
  const [idType, setIdType] = useState<IdType>("open_id")
  const [workspaceDir, setWorkspaceDir] = useState("")
  const [model, setModel] = useState("auto")
  const [showSecret, setShowSecret] = useState(false)
  const [proxy, setProxy] = useState("")
  const [noProxy, setNoProxy] = useState("localhost,127.0.0.1")
  const [agentNewSession, setAgentNewSession] = useState(false)
  const [closeWindowAction, setCloseWindowAction] = useState<CloseWindowAction>("ask")
  const [workspaceDaemonChoice, setWorkspaceDaemonChoice] = useState<{ old: string; new: string } | null>(null)

  const [saved, setSaved] = useState(false)
  const [modelOptions, setModelOptions] = useState<{ id: string; label: string }[]>([])
  const [loadingModels, setLoadingModels] = useState(false)

  const [mcpServers, setMcpServers] = useState<McpServerEntry[]>([])
  const [mcpLoading, setMcpLoading] = useState<Record<string, boolean>>({})
  const [mcpStatusLoading, setMcpStatusLoading] = useState(true)
  const [mcpEditing, setMcpEditing] = useState<McpEditForm | null>(null)
  const [mcpEditOriginalName, setMcpEditOriginalName] = useState<string | null>(null)

  const [rules, setRules] = useState<RuleFile[]>([])
  const [ruleEditing, setRuleEditing] = useState<RuleFile | null>(null)
  const [ruleEditOriginalName, setRuleEditOriginalName] = useState<string | null>(null)

  const [skills, setSkills] = useState<SkillFile[]>([])
  const [skillEditing, setSkillEditing] = useState<SkillFile | null>(null)
  const [skillEditOriginalName, setSkillEditOriginalName] = useState<string | null>(null)

  const [tasks, setTasks] = useState<TaskItem[]>([])
  const [taskEditing, setTaskEditing] = useState<TaskItem | null>(null)
  const [taskCronValid, setTaskCronValid] = useState(true)
  const [cronPreviewRuns, setCronPreviewRuns] = useState<string[] | null>(null)
  const [cronPreviewErr, setCronPreviewErr] = useState<string | null>(null)
  const [cronPreviewLoading, setCronPreviewLoading] = useState(false)
  const cronPreviewReq = useRef(0)
  /** 用于区分「同一条任务里只改 cron」与「切换到另一条任务」，切换任务时立即清空预览避免串台 */
  const cronPreviewTaskIdRef = useRef("")

  const loaded = useRef(false)
  const mcpLoaded = useRef(false)
  const saveTimer = useRef<ReturnType<typeof setTimeout>>()

  const refreshMcpServers = useCallback(async (force = false) => {
    if (mcpLoaded.current && !force) return
    const servers = await window.electronAPI.getMcpServers()
    setMcpServers(servers)
    setMcpStatusLoading(true)
    const enabled = await window.electronAPI.getMcpEnabledMap()
    setMcpServers((prev) => prev.map((s) => ({ ...s, enabled: enabled[s.name] ?? false })))
    setMcpStatusLoading(false)
    mcpLoaded.current = true
  }, [])
  const refreshRules = useCallback(() => { window.electronAPI.getRules().then(setRules) }, [])
  const refreshSkills = useCallback(() => { window.electronAPI.getSkills().then(setSkills) }, [])
  const refreshTasks = useCallback(() => { window.electronAPI.getScheduledTasks().then(setTasks) }, [])

  useEffect(() => {
    window.electronAPI.getConfig().then((config) => {
      setAppId(config.larkAppId); setAppSecret(config.larkAppSecret)
      setReceiveId(config.larkReceiveId); setIdType(config.larkReceiveIdType)
      setWorkspaceDir(config.workspaceDir); setModel(config.model)
      setProxy(config.httpProxy || config.httpsProxy || "")
      setNoProxy(config.noProxy || "localhost,127.0.0.1")
      setAgentNewSession(config.agentNewSession ?? false)
      setCloseWindowAction(config.closeWindowAction ?? "ask")
      loaded.current = true
    })
    refreshMcpServers(); refreshRules(); refreshSkills(); refreshTasks()
    return window.electronAPI.onMcpLoginComplete(({ serverName, ok }) => {
      if (ok) setMcpServers((prev) => prev.map((s) => s.name === serverName ? { ...s, authenticated: true } : s))
    })
  }, [refreshMcpServers, refreshRules, refreshSkills, refreshTasks])

  const autoSave = useCallback(() => {
    if (!loaded.current) return
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(async () => {
      const r = await window.electronAPI.saveConfig({
        larkAppId: appId.trim(), larkAppSecret: appSecret.trim(),
        larkReceiveId: receiveId.trim(), larkReceiveIdType: idType,
        workspaceDir: workspaceDir.trim(), model,
        httpProxy: proxy.trim(), httpsProxy: proxy.trim(), noProxy: noProxy.trim(),
        agentNewSession,
        closeWindowAction,
      })
      if (r.needWorkspaceDaemonChoice && r.oldWorkspaceDir !== undefined && r.newWorkspaceDir !== undefined) {
        setWorkspaceDaemonChoice({ old: r.oldWorkspaceDir, new: r.newWorkspaceDir })
        setWorkspaceDir(r.oldWorkspaceDir)
      }
      if (r.workspaceDirChanged) {
        void refreshMcpServers(true)
      }
      if (r.restartFailed) {
        alert(`工作目录已保存，但 Daemon 未能自动启动：\n${r.restartFailed}`)
      }
      setSaved(true); setTimeout(() => setSaved(false), 1500)
    }, 500)
  }, [appId, appSecret, receiveId, idType, workspaceDir, model, proxy, noProxy, agentNewSession, closeWindowAction, refreshMcpServers])

  useEffect(() => { autoSave() }, [autoSave])

  const taskModalOpen = taskEditing !== null
  const taskIdForCronPreview = taskEditing?.id ?? ""
  const taskCronForPreview = taskEditing?.cron ?? ""

  useEffect(() => {
    if (!taskModalOpen) {
      cronPreviewTaskIdRef.current = ""
      setCronPreviewRuns(null)
      setCronPreviewErr(null)
      setCronPreviewLoading(false)
      return
    }
    const cron = taskCronForPreview.trim()
    if (!cron) {
      setCronPreviewRuns(null)
      setCronPreviewErr(null)
      setCronPreviewLoading(false)
      return
    }
    if (cronPreviewTaskIdRef.current !== taskIdForCronPreview) {
      cronPreviewTaskIdRef.current = taskIdForCronPreview
      setCronPreviewRuns(null)
      setCronPreviewErr(null)
    }
    const req = ++cronPreviewReq.current
    const t = setTimeout(async () => {
      if (req !== cronPreviewReq.current) return
      setCronPreviewLoading(true)
      setCronPreviewErr(null)
      try {
        const r = await window.electronAPI.previewCronNextRuns(cron)
        if (req !== cronPreviewReq.current) return
        if (r.ok) {
          setCronPreviewRuns(r.runs)
        } else {
          setCronPreviewRuns(null)
          setCronPreviewErr(r.error)
        }
      } finally {
        if (req === cronPreviewReq.current) setCronPreviewLoading(false)
      }
    }, 320)
    return () => clearTimeout(t)
  }, [taskModalOpen, taskIdForCronPreview, taskCronForPreview])

  const fetchModels = async () => {
    setLoadingModels(true)
    try {
      const r = await window.electronAPI.listModels()
      if (r.ok && r.models.length > 0) {
        setModelOptions(r.models)
      } else if (r.ok) {
        alert("未解析到任何模型。请确认已在设置中完成 Cursor CLI 登录，或在终端执行 agent --list-models 查看输出格式是否变化。")
      } else {
        alert(r.error || "获取模型列表失败")
      }
    } finally {
      setLoadingModels(false)
    }
  }

  const selectDir = async () => { const d = await window.electronAPI.selectDirectory(); if (d) setWorkspaceDir(d) }

  // ── MCP ──
  const handleMcpToggle = async (name: string, enabled: boolean) => {
    setMcpServers((prev) => prev.map((s) => s.name === name ? { ...s, enabled } : s))
    setMcpLoading((p) => ({ ...p, [name]: true }))
    const res = await window.electronAPI.toggleMcp(name, enabled)
    setMcpLoading((p) => ({ ...p, [name]: false }))
    if (!res.ok) {
      setMcpServers((prev) => prev.map((s) => s.name === name ? { ...s, enabled: !enabled } : s))
      alert(res.output || `MCP ${enabled ? "启用" : "禁用"}失败`)
    }
  }
  const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").replace(/\r/g, "").trim()
  const [mcpLoginPending, setMcpLoginPending] = useState<Record<string, boolean>>({})
  const handleMcpLogin = (name: string) => {
    setMcpLoginPending((p) => ({ ...p, [name]: true }))
    setTimeout(() => setMcpLoginPending((p) => ({ ...p, [name]: false })), 5000)
    window.electronAPI.loginMcp(name).then((res) => {
      setMcpLoginPending((p) => ({ ...p, [name]: false }))
      if (res.ok) {
        setMcpServers((prev) => prev.map((s) => s.name === name ? { ...s, authenticated: true } : s))
      }
    })
  }
  const openMcpAdd = () => { setMcpEditOriginalName(null); setMcpEditing({ ...emptyMcpForm }) }
  const openMcpEdit = (s: McpServerEntry) => {
    setMcpEditOriginalName(s.name)
    const inner = s.rawConfig ?? {}
    setMcpEditing({ json: JSON.stringify({ [s.name]: inner }, null, 2), source: s.source })
  }
  const handleMcpDelete = async (name: string) => {
    await window.electronAPI.deleteMcpServer(name)
    setMcpServers((prev) => prev.filter((s) => s.name !== name))
  }
  const handleMcpSave = async () => {
    if (!mcpEditing) return
    const setErr = (msg: string) => setMcpEditing({ ...mcpEditing, jsonError: msg })
    let raw = mcpEditing.json.trim()

    // 兼容粘贴片段 `"name": { ... }` —— 补成 `{ "name": { ... } }`
    if (raw.startsWith('"') && !raw.startsWith('{')) raw = `{${raw}}`

    let parsed: Record<string, unknown>
    try { parsed = JSON.parse(raw) }
    catch { setErr("JSON 格式无效"); return }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      setErr("JSON 必须是一个对象"); return
    }

    // 兼容完整 mcp.json 格式 `{ "mcpServers": { ... } }`
    if ("mcpServers" in parsed && typeof parsed.mcpServers === "object" && parsed.mcpServers !== null) {
      parsed = parsed.mcpServers as Record<string, unknown>
    }

    const keys = Object.keys(parsed)
    if (keys.length === 0) { setErr("JSON 中没有 MCP 服务器配置"); return }
    if (keys.length !== 1) { setErr("一次只能保存一个 MCP 服务器"); return }

    const name = keys[0]
    const entry = parsed[name]
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      setErr(`"${name}" 的值必须是一个对象`); return
    }
    if (mcpEditOriginalName && mcpEditOriginalName !== name) await window.electronAPI.deleteMcpServer(mcpEditOriginalName)
    await window.electronAPI.saveMcpServer(name, entry as Record<string, unknown>, mcpEditing.source)
    const isNew = !mcpEditOriginalName
    if (isNew) window.electronAPI.toggleMcp(name, true)
    const isUrl = "url" in (entry as Record<string, unknown>) && !("command" in (entry as Record<string, unknown>))
    const saved: McpServerEntry = {
      name, type: isUrl ? "url" : "command", source: mcpEditing.source,
      ...(isUrl ? { url: (entry as Record<string, string>).url } : { command: (entry as Record<string, string>).command, args: (entry as Record<string, string[]>).args }),
      rawConfig: entry as Record<string, unknown>,
      enabled: isNew ? true : undefined,
    }
    setMcpServers((prev) => {
      const old = prev.find((s) => s.name === mcpEditOriginalName || s.name === name)
      if (!isNew && old) saved.enabled = old.enabled
      const filtered = prev.filter((s) => s.name !== name && s.name !== mcpEditOriginalName)
      return [...filtered, saved]
    })
    setMcpEditing(null)
  }

  // ── Rules ──
  const openRuleAdd = () => { setRuleEditOriginalName(null); setRuleEditing({ name: "", content: "" }) }
  const openRuleEdit = (r: RuleFile) => { setRuleEditOriginalName(r.name); setRuleEditing({ ...r }) }
  const handleRuleDelete = async (name: string) => { await window.electronAPI.deleteRule(name); refreshRules() }
  const handleRuleSave = async () => {
    if (!ruleEditing || !ruleEditing.name.trim()) return
    if (ruleEditOriginalName && ruleEditOriginalName !== ruleEditing.name) await window.electronAPI.deleteRule(ruleEditOriginalName)
    let name = ruleEditing.name.trim()
    if (!name.endsWith(".mdc") && !name.endsWith(".md")) name += ".mdc"
    await window.electronAPI.saveRule(name, ruleEditing.content)
    setRuleEditing(null); refreshRules()
  }

  // ── Skills ──
  const openSkillAdd = () => { setSkillEditOriginalName(null); setSkillEditing({ name: "", content: "" }) }
  const openSkillEdit = (s: SkillFile) => { setSkillEditOriginalName(s.name); setSkillEditing({ ...s }) }
  const handleSkillDelete = async (name: string) => { await window.electronAPI.deleteSkill(name); refreshSkills() }
  const handleSkillSave = async () => {
    if (!skillEditing || !skillEditing.name.trim()) return
    if (skillEditOriginalName && skillEditOriginalName !== skillEditing.name) await window.electronAPI.deleteSkill(skillEditOriginalName)
    await window.electronAPI.saveSkill(skillEditing.name.trim(), skillEditing.content)
    setSkillEditing(null); refreshSkills()
  }

  // ── Tasks ──
  const openTaskAdd = () => {
    setTaskEditing({ id: crypto.randomUUID(), name: "", cron: "", content: "", enabled: true })
    setTaskCronValid(true)
  }
  const openTaskEdit = (t: TaskItem) => { setTaskEditing({ ...t }); setTaskCronValid(true) }
  const handleTaskDelete = async (id: string) => {
    const updated = tasks.filter((t) => t.id !== id)
    await window.electronAPI.saveScheduledTasks(updated); refreshTasks()
  }
  const handleTaskToggle = async (id: string) => {
    const updated = tasks.map((t) => t.id === id ? { ...t, enabled: !t.enabled } : t)
    await window.electronAPI.saveScheduledTasks(updated); refreshTasks()
  }
  const handleTaskSave = async () => {
    if (!taskEditing || !taskEditing.name.trim() || !taskEditing.cron.trim()) return
    const valid = await window.electronAPI.validateCron(taskEditing.cron.trim())
    setTaskCronValid(valid)
    if (!valid) return
    const exists = tasks.find((t) => t.id === taskEditing.id)
    const updated = exists ? tasks.map((t) => t.id === taskEditing.id ? taskEditing : t) : [...tasks, taskEditing]
    await window.electronAPI.saveScheduledTasks(updated)
    setTaskEditing(null); refreshTasks()
  }

  const inputCls = "w-full rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-sm outline-none transition focus:border-blue-500"

  return (
    <div className="flex h-screen flex-col">
      <div className="flex items-center gap-3 border-b border-gray-800 px-6 py-3">
        <button onClick={onBack} className="rounded-lg p-1.5 text-gray-400 transition hover:bg-gray-800 hover:text-white"><ArrowLeft size={18} /></button>
        <h1 className="text-lg font-semibold">设置</h1>
        <div className="flex-1" />
        {saved && <span className="flex items-center gap-1 text-xs text-green-400"><CheckCircle2 size={14} />已保存</span>}
      </div>

      <div className="flex flex-1 overflow-hidden">
        <nav className="w-36 shrink-0 border-r border-gray-800 py-3">
          {TABS.map((t) => (
            <button key={t.id} onClick={() => setTab(t.id)} className={`flex w-full items-center gap-2.5 px-4 py-2 text-left text-sm transition ${tab === t.id ? "bg-gray-800/70 font-medium text-white" : "text-gray-400 hover:bg-gray-800/40 hover:text-gray-200"}`}>
              <t.icon size={15} />{t.label}
            </button>
          ))}
        </nav>

        <div className="flex-1 overflow-y-auto px-8 py-6">
          <div className="mx-auto max-w-xl space-y-6">

            {/* ═══ General ═══ */}
            {tab === "general" && (<>
              <section className="space-y-4">
                <h3 className="text-sm font-medium text-gray-300">飞书凭据</h3>
                <div className="grid grid-cols-2 gap-4">
                  <div><label className="mb-1 block text-xs text-gray-500">App ID</label><input type="text" value={appId} onChange={(e) => setAppId(e.target.value)} className={inputCls} /></div>
                  <div><label className="mb-1 block text-xs text-gray-500">App Secret</label>
                    <div className="relative">
                      <input type={showSecret ? "text" : "password"} value={appSecret} onChange={(e) => setAppSecret(e.target.value)} className={inputCls + " pr-10"} />
                      <button type="button" onClick={() => setShowSecret(!showSecret)} className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300">{showSecret ? <EyeOff size={14} /> : <Eye size={14} />}</button>
                    </div>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div><label className="mb-1 block text-xs text-gray-500">Receive ID</label><input type="text" value={receiveId} onChange={(e) => setReceiveId(e.target.value)} className={inputCls} /></div>
                  <div><label className="mb-1 block text-xs text-gray-500">ID 类型</label>
                    <select value={idType} onChange={(e) => setIdType(e.target.value as IdType)} className={inputCls}><option value="open_id">Open ID</option><option value="user_id">User ID</option><option value="chat_id">Chat ID</option></select>
                  </div>
                </div>
              </section>
              <section className="space-y-3">
                <h3 className="text-sm font-medium text-gray-300">工作目录</h3>
                <div onClick={selectDir} className="flex cursor-pointer items-center gap-3 rounded-lg border border-gray-700 px-4 py-3 transition hover:border-blue-500">
                  <FolderOpen size={18} className="text-blue-400" /><span className="truncate text-sm">{workspaceDir || "点击选择..."}</span>
                </div>
              </section>
              <section className="space-y-3">
                <h3 className="text-sm font-medium text-gray-300">关闭主窗口</h3>
                <p className="text-xs text-gray-600">点击窗口右上角关闭时的行为（可从系统托盘再次打开窗口）。</p>
                <div className="space-y-2">
                  {([
                    { v: "ask" as const, t: "每次询问", d: "弹窗选择最小化到托盘或退出应用" },
                    { v: "minimize" as const, t: "总是最小化到托盘", d: "直接隐藏窗口，不弹窗" },
                    { v: "quit" as const, t: "总是退出应用", d: "关闭窗口并退出（含 Daemon、托盘）" },
                  ]).map((opt) => (
                    <label
                      key={opt.v}
                      className={`flex cursor-pointer items-start gap-3 rounded-lg border px-4 py-3 transition ${closeWindowAction === opt.v ? "border-blue-500 bg-blue-500/10" : "border-gray-700 hover:border-gray-600"}`}
                    >
                      <input
                        type="radio"
                        name="closeWindowAction"
                        checked={closeWindowAction === opt.v}
                        onChange={() => setCloseWindowAction(opt.v)}
                        className="mt-1 rounded-full border-gray-600"
                      />
                      <div>
                        <p className="text-sm font-medium">{opt.t}</p>
                        <p className="text-xs text-gray-500">{opt.d}</p>
                      </div>
                    </label>
                  ))}
                </div>
              </section>
              <p className="text-xs text-gray-500">关闭窗口相关选项保存后立即生效。其余设置自动保存，部分项需重启 Daemon 后生效。</p>
            </>)}

            {/* ═══ Proxy ═══ */}
            {tab === "proxy" && (<>
              <section className="space-y-4">
                <h3 className="text-sm font-medium text-gray-300">代理设置</h3>
                <div>
                  <label className="mb-1 block text-xs text-gray-500">HTTP / HTTPS 代理</label>
                  <input type="text" value={proxy} onChange={(e) => setProxy(e.target.value)} placeholder="http://127.0.0.1:7897" className={inputCls} />
                  <p className="mt-1 text-xs text-gray-600">同时设置 HTTP_PROXY 和 HTTPS_PROXY</p>
                </div>
                <div>
                  <label className="mb-1 block text-xs text-gray-500">NO_PROXY</label>
                  <input type="text" value={noProxy} onChange={(e) => setNoProxy(e.target.value)} placeholder="localhost,127.0.0.1" className={inputCls} />
                </div>
              </section>
            </>)}

            {/* ═══ Agent ═══ */}
            {tab === "agent" && (<>
              <section className="space-y-3">
                <div className="flex items-center gap-2">
                  <h3 className="text-sm font-medium text-gray-300">模型</h3>
                  <button onClick={fetchModels} disabled={loadingModels} className="flex items-center gap-1 rounded px-2 py-0.5 text-xs text-gray-400 transition hover:bg-gray-800 hover:text-white disabled:opacity-50">
                    {loadingModels ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}获取可用模型
                  </button>
                </div>
                {modelOptions.length > 0
                  ? <SearchableSelect value={model} onChange={setModel} options={modelOptions} placeholder="选择模型..." />
                  : <input type="text" value={model} onChange={(e) => setModel(e.target.value)} placeholder="auto" className={inputCls} />}
              </section>
              <section className="space-y-3">
                <h3 className="text-sm font-medium text-gray-300">Agent 会话</h3>
                <div className="flex items-center justify-between rounded-lg border border-gray-700 px-4 py-3">
                  <div>
                    <p className="text-sm font-medium">每次开启新会话</p>
                    <p className="text-xs text-gray-500">开启后 Agent 每次启动都会创建新会话，关闭则延续上一次会话</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setAgentNewSession(!agentNewSession)}
                    className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full transition-colors duration-200 ${agentNewSession ? "bg-green-500" : "bg-gray-600"}`}
                  >
                    <span className={`inline-block h-3.5 w-3.5 rounded-full bg-white shadow transition-transform duration-200 ${agentNewSession ? "translate-x-[18px]" : "translate-x-[3px]"}`} />
                  </button>
                </div>
              </section>
              <p className="text-xs text-gray-500">以上选项自动保存；模型与会话相关项在下次启动 Agent 时生效。</p>
            </>)}

            {/* ═══ MCP ═══ */}
            {tab === "mcp" && (<>
              <section className="space-y-3">
                <div className="flex items-center gap-2">
                  <h3 className="text-sm font-medium text-gray-300">MCP 服务器</h3>
                  <button onClick={() => refreshMcpServers(true)} className="flex items-center gap-1 rounded px-2 py-0.5 text-xs text-gray-400 transition hover:bg-gray-800 hover:text-white"><RefreshCw size={12} />刷新</button>
                  <div className="flex-1" />
                  <button onClick={openMcpAdd} className="flex items-center gap-1 rounded-md bg-blue-600 px-2.5 py-1 text-xs font-medium text-white transition hover:bg-blue-500"><Plus size={12} />新增</button>
                </div>
                <div className="space-y-2">
                  {mcpServers.map((s) => (
                    <div key={s.name} className="flex items-center justify-between rounded-lg border border-gray-700 px-4 py-3">
                      <div className="flex items-center gap-3 min-w-0">
                        {s.type === "url" ? (s.authenticated ? <ShieldCheck size={16} className="shrink-0 text-green-400" /> : <ShieldAlert size={16} className="shrink-0 text-amber-400" />) : <Terminal size={16} className="shrink-0 text-gray-400" />}
                        <div className="min-w-0">
                          <div className="flex items-center gap-2"><p className="truncate text-sm font-medium">{s.name}</p><span className="shrink-0 rounded bg-gray-800 px-1.5 py-0.5 text-[10px] text-gray-500">{s.source === "global" ? "全局" : "项目"}</span></div>
                          <p className="truncate text-xs text-gray-500">{s.type === "url" ? s.url : `${s.command} ${(s.args ?? []).join(" ")}`}</p>
                        </div>
                      </div>
                      <div className="ml-3 flex shrink-0 items-center gap-2">
                        {s.type === "url" && (s.authenticated ? <span className="text-xs text-green-400">已认证</span> : mcpLoginPending[s.name] ? <button onClick={() => handleMcpLogin(s.name)} className="flex items-center gap-1 rounded-md bg-blue-600/70 px-2 py-1 text-xs font-medium text-white transition hover:bg-blue-500"><Loader2 size={12} className="animate-spin" />认证中</button> : <button onClick={() => handleMcpLogin(s.name)} className="flex items-center gap-1 rounded-md bg-blue-600 px-2 py-1 text-xs font-medium text-white transition hover:bg-blue-500"><LogIn size={12} />授权</button>)}
                        <button onClick={() => openMcpEdit(s)} className="rounded p-1 text-gray-500 transition hover:bg-gray-800 hover:text-white"><Pencil size={13} /></button>
                        <button onClick={() => handleMcpDelete(s.name)} className="rounded p-1 text-gray-500 transition hover:bg-gray-800 hover:text-red-400"><Trash2 size={13} /></button>
                        {(mcpStatusLoading && s.enabled === undefined) || mcpLoading[s.name] ? (
                          <div className="inline-flex h-5 w-9 shrink-0 items-center justify-center rounded-full bg-gray-700">
                            <Loader2 size={12} className="animate-spin text-gray-400" />
                          </div>
                        ) : (
                          <button
                            onClick={() => handleMcpToggle(s.name, !s.enabled)}
                            className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full transition-colors duration-200 ${s.enabled ? "bg-green-500" : "bg-gray-600"}`}
                          >
                            <span className={`inline-block h-3.5 w-3.5 rounded-full bg-white shadow transition-transform duration-200 ${s.enabled ? "translate-x-[18px]" : "translate-x-[3px]"}`} />
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                  {mcpServers.length === 0 && <p className="py-4 text-center text-xs text-gray-600">暂无 MCP 服务器配置</p>}
                </div>
              </section>
            </>)}

            {/* ═══ Rules ═══ */}
            {tab === "rules" && (<>
              <section className="space-y-3">
                <div className="flex items-center gap-2">
                  <h3 className="text-sm font-medium text-gray-300">Cursor Rules</h3>
                  <button onClick={refreshRules} className="flex items-center gap-1 rounded px-2 py-0.5 text-xs text-gray-400 transition hover:bg-gray-800 hover:text-white"><RefreshCw size={12} />刷新</button>
                  <div className="flex-1" />
                  <button onClick={openRuleAdd} className="flex items-center gap-1 rounded-md bg-blue-600 px-2.5 py-1 text-xs font-medium text-white transition hover:bg-blue-500"><Plus size={12} />新增</button>
                </div>
                <p className="text-xs text-gray-600">管理 .cursor/rules/ 下的规则文件</p>
                <div className="space-y-2">
                  {rules.map((r) => (
                    <div key={r.name} className="flex items-center justify-between rounded-lg border border-gray-700 px-4 py-3">
                      <div className="min-w-0"><p className="truncate text-sm font-medium">{r.name}</p><p className="truncate text-xs text-gray-500">{r.content.slice(0, 80)}{r.content.length > 80 ? "..." : ""}</p></div>
                      <div className="ml-3 flex shrink-0 items-center gap-2">
                        <button onClick={() => openRuleEdit(r)} className="rounded p-1 text-gray-500 transition hover:bg-gray-800 hover:text-white"><Pencil size={13} /></button>
                        <button onClick={() => handleRuleDelete(r.name)} className="rounded p-1 text-gray-500 transition hover:bg-gray-800 hover:text-red-400"><Trash2 size={13} /></button>
                      </div>
                    </div>
                  ))}
                  {rules.length === 0 && <p className="py-4 text-center text-xs text-gray-600">暂无 Rule 文件</p>}
                </div>
              </section>
            </>)}

            {/* ═══ Tasks ═══ */}
            {tab === "tasks" && (<>
              <section className="space-y-3">
                <div className="flex items-center gap-2">
                  <h3 className="text-sm font-medium text-gray-300">定时任务</h3>
                  <button onClick={refreshTasks} className="flex items-center gap-1 rounded px-2 py-0.5 text-xs text-gray-400 transition hover:bg-gray-800 hover:text-white"><RefreshCw size={12} />刷新</button>
                  <div className="flex-1" />
                  <button onClick={openTaskAdd} className="flex items-center gap-1 rounded-md bg-blue-600 px-2.5 py-1 text-xs font-medium text-white transition hover:bg-blue-500"><Plus size={12} />新增</button>
                </div>
                <div className="space-y-2">
                  {tasks.map((t) => (
                    <div key={t.id} className="flex items-center justify-between rounded-lg border border-gray-700 px-4 py-3">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <p className={`truncate text-sm font-medium ${t.enabled ? "" : "text-gray-600 line-through"}`}>{t.name}</p>
                          <span className="shrink-0 rounded bg-gray-800 px-1.5 py-0.5 font-mono text-[10px] text-gray-500">{t.cron}</span>
                        </div>
                        <p className="truncate text-xs text-gray-500">{t.content.slice(0, 80)}{t.content.length > 80 ? "..." : ""}</p>
                      </div>
                      <div className="ml-3 flex shrink-0 items-center gap-2">
                        <button onClick={() => handleTaskToggle(t.id)} className={`rounded px-2 py-0.5 text-xs transition ${t.enabled ? "text-green-400 hover:bg-green-600/20" : "text-gray-500 hover:bg-gray-800"}`}>
                          {t.enabled ? "启用" : "禁用"}
                        </button>
                        <button onClick={() => openTaskEdit(t)} className="rounded p-1 text-gray-500 transition hover:bg-gray-800 hover:text-white"><Pencil size={13} /></button>
                        <button onClick={() => handleTaskDelete(t.id)} className="rounded p-1 text-gray-500 transition hover:bg-gray-800 hover:text-red-400"><Trash2 size={13} /></button>
                      </div>
                    </div>
                  ))}
                  {tasks.length === 0 && <p className="py-4 text-center text-xs text-gray-600">暂无定时任务</p>}
                </div>
              </section>
            </>)}

            {/* ═══ Skills ═══ */}
            {tab === "skills" && (<>
              <section className="space-y-3">
                <div className="flex items-center gap-2">
                  <h3 className="text-sm font-medium text-gray-300">Agent Skills</h3>
                  <button onClick={refreshSkills} className="flex items-center gap-1 rounded px-2 py-0.5 text-xs text-gray-400 transition hover:bg-gray-800 hover:text-white"><RefreshCw size={12} />刷新</button>
                  <div className="flex-1" />
                  <button onClick={openSkillAdd} className="flex items-center gap-1 rounded-md bg-blue-600 px-2.5 py-1 text-xs font-medium text-white transition hover:bg-blue-500"><Plus size={12} />新增</button>
                </div>
                <p className="text-xs text-gray-600">管理 ~/.cursor/skills/ 下的技能（每个技能为一个文件夹 + SKILL.md）</p>
                <div className="space-y-2">
                  {skills.map((s) => (
                    <div key={s.name} className="flex items-center justify-between rounded-lg border border-gray-700 px-4 py-3">
                      <div className="min-w-0"><p className="truncate text-sm font-medium">{s.name}</p><p className="truncate text-xs text-gray-500">{s.content.slice(0, 80)}{s.content.length > 80 ? "..." : ""}</p></div>
                      <div className="ml-3 flex shrink-0 items-center gap-2">
                        <button onClick={() => openSkillEdit(s)} className="rounded p-1 text-gray-500 transition hover:bg-gray-800 hover:text-white"><Pencil size={13} /></button>
                        <button onClick={() => handleSkillDelete(s.name)} className="rounded p-1 text-gray-500 transition hover:bg-gray-800 hover:text-red-400"><Trash2 size={13} /></button>
                      </div>
                    </div>
                  ))}
                  {skills.length === 0 && <p className="py-4 text-center text-xs text-gray-600">暂无 Skill</p>}
                </div>
              </section>
            </>)}

          </div>
        </div>
      </div>

      {/* ═══ MCP Edit Modal ═══ */}
      {mcpEditing && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
          <div className="flex w-full max-w-lg flex-col rounded-xl border border-gray-700 bg-gray-900 shadow-2xl" style={{ maxHeight: "80vh" }}>
            <div className="flex items-center justify-between border-b border-gray-800 px-6 py-4">
              <h3 className="text-sm font-semibold text-gray-200">{mcpEditOriginalName ? "编辑 MCP" : "新增 MCP"}</h3>
              <button onClick={() => setMcpEditing(null)} className="text-gray-500 hover:text-white"><X size={16} /></button>
            </div>
            <div className="flex-1 space-y-3 overflow-y-auto px-6 py-4">
              <div>
                <div className="mb-1 flex items-center justify-between">
                  <label className="text-xs text-gray-500">配置 JSON</label>
                  <select value={mcpEditing.source} onChange={(e) => setMcpEditing({ ...mcpEditing, source: e.target.value as "global" | "project" })} className="rounded border border-gray-700 bg-gray-900 px-2 py-0.5 text-xs text-gray-400 outline-none focus:border-blue-500">
                    <option value="global">全局</option><option value="project">项目</option>
                  </select>
                </div>
                <textarea
                  value={mcpEditing.json}
                  onChange={(e) => setMcpEditing({ ...mcpEditing, json: e.target.value, jsonError: undefined })}
                  rows={14}
                  spellCheck={false}
                  className={inputCls + " font-mono text-xs leading-relaxed" + (mcpEditing.jsonError ? " border-red-500" : "")}
                  placeholder={MCP_TEMPLATE}
                />
                {mcpEditing.jsonError && <p className="mt-1 text-xs text-red-400">{mcpEditing.jsonError}</p>}
                <p className="mt-1 text-xs text-gray-600">格式: {"{"} "名称": {"{"} "command"|"url": ... {"}"} {"}"}</p>
              </div>
            </div>
            <div className="flex justify-end gap-2 border-t border-gray-800 px-6 py-4">
              <button onClick={() => setMcpEditing(null)} className="rounded-md px-4 py-1.5 text-xs text-gray-400 transition hover:bg-gray-800 hover:text-white">取消</button>
              <button onClick={handleMcpSave} className="rounded-md bg-blue-600 px-4 py-1.5 text-xs font-medium text-white transition hover:bg-blue-500 disabled:opacity-40">保存</button>
            </div>
          </div>
        </div>
      )}

      {/* ═══ Rule Edit Modal ═══ */}
      {ruleEditing && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
          <div className="flex w-full max-w-lg flex-col rounded-xl border border-gray-700 bg-gray-900 shadow-2xl" style={{ maxHeight: "80vh" }}>
            <div className="flex items-center justify-between border-b border-gray-800 px-6 py-4">
              <h3 className="text-sm font-semibold text-gray-200">{ruleEditOriginalName ? "编辑 Rule" : "新增 Rule"}</h3>
              <button onClick={() => setRuleEditing(null)} className="text-gray-500 hover:text-white"><X size={16} /></button>
            </div>
            <div className="flex-1 space-y-3 overflow-y-auto px-6 py-4">
              <div><label className="mb-1 block text-xs text-gray-500">文件名</label><input type="text" value={ruleEditing.name} onChange={(e) => setRuleEditing({ ...ruleEditing, name: e.target.value })} className={inputCls} placeholder="my-rule.mdc" /></div>
              <div><label className="mb-1 block text-xs text-gray-500">内容</label><textarea value={ruleEditing.content} onChange={(e) => setRuleEditing({ ...ruleEditing, content: e.target.value })} rows={16} className={inputCls + " font-mono text-xs leading-relaxed"} placeholder={"---\ndescription: My rule\nglobs: **/*.ts\nalwaysApply: false\n---\n\n# Rule content"} /></div>
            </div>
            <div className="flex justify-end gap-2 border-t border-gray-800 px-6 py-4">
              <button onClick={() => setRuleEditing(null)} className="rounded-md px-4 py-1.5 text-xs text-gray-400 transition hover:bg-gray-800 hover:text-white">取消</button>
              <button onClick={handleRuleSave} disabled={!ruleEditing.name.trim()} className="rounded-md bg-blue-600 px-4 py-1.5 text-xs font-medium text-white transition hover:bg-blue-500 disabled:opacity-40">保存</button>
            </div>
          </div>
        </div>
      )}

      {/* ═══ Skill Edit Modal ═══ */}
      {skillEditing && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
          <div className="flex w-full max-w-lg flex-col rounded-xl border border-gray-700 bg-gray-900 shadow-2xl" style={{ maxHeight: "80vh" }}>
            <div className="flex items-center justify-between border-b border-gray-800 px-6 py-4">
              <h3 className="text-sm font-semibold text-gray-200">{skillEditOriginalName ? "编辑 Skill" : "新增 Skill"}</h3>
              <button onClick={() => setSkillEditing(null)} className="text-gray-500 hover:text-white"><X size={16} /></button>
            </div>
            <div className="flex-1 space-y-3 overflow-y-auto px-6 py-4">
              <div><label className="mb-1 block text-xs text-gray-500">名称（文件夹名）</label><input type="text" value={skillEditing.name} onChange={(e) => setSkillEditing({ ...skillEditing, name: e.target.value })} className={inputCls} placeholder="my-skill" /></div>
              <div><label className="mb-1 block text-xs text-gray-500">SKILL.md 内容</label><textarea value={skillEditing.content} onChange={(e) => setSkillEditing({ ...skillEditing, content: e.target.value })} rows={16} className={inputCls + " font-mono text-xs leading-relaxed"} placeholder="# My Skill\n\nDescription of what this skill does..." /></div>
            </div>
            <div className="flex justify-end gap-2 border-t border-gray-800 px-6 py-4">
              <button onClick={() => setSkillEditing(null)} className="rounded-md px-4 py-1.5 text-xs text-gray-400 transition hover:bg-gray-800 hover:text-white">取消</button>
              <button onClick={handleSkillSave} disabled={!skillEditing.name.trim()} className="rounded-md bg-blue-600 px-4 py-1.5 text-xs font-medium text-white transition hover:bg-blue-500 disabled:opacity-40">保存</button>
            </div>
          </div>
        </div>
      )}

      {/* ═══ Task Edit Modal ═══ */}
      {taskEditing && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
          <div className="flex w-full max-w-lg flex-col rounded-xl border border-gray-700 bg-gray-900 shadow-2xl" style={{ maxHeight: "80vh" }}>
            <div className="flex items-center justify-between border-b border-gray-800 px-6 py-4">
              <h3 className="text-sm font-semibold text-gray-200">{tasks.find((t) => t.id === taskEditing.id) ? "编辑定时任务" : "新增定时任务"}</h3>
              <button onClick={() => setTaskEditing(null)} className="text-gray-500 hover:text-white"><X size={16} /></button>
            </div>
            <div className="flex-1 space-y-3 overflow-y-auto px-6 py-4">
              <div><label className="mb-1 block text-xs text-gray-500">任务名称</label><input type="text" value={taskEditing.name} onChange={(e) => setTaskEditing({ ...taskEditing, name: e.target.value })} className={inputCls} placeholder="日报推送" /></div>
              <div>
                <label className="mb-1 block text-xs text-gray-500">Cron 表达式</label>
                <input type="text" value={taskEditing.cron} onChange={(e) => { setTaskEditing({ ...taskEditing, cron: e.target.value }); setTaskCronValid(true) }} className={inputCls + (!taskCronValid ? " border-red-500" : "")} placeholder="0 9 * * 1-5" />
                {!taskCronValid && <p className="mt-1 text-xs text-red-400">Cron 表达式无效</p>}
                <p className="mt-1 text-xs text-gray-600">
                  五段：分 时 日 月 周（如 0 9 * * 1-5 = 工作日 9:00）。六段时在前面加「秒」：秒 分 时 日 月 周。
                  每 5 秒请用 <code className="rounded bg-gray-800 px-1">*/5 * * * * *</code>，勿用 <code className="rounded bg-gray-800 px-1">0/5</code>（在 node-cron 里会变成每分钟一次）。
                </p>
                <div className="mt-2 rounded-lg border border-gray-800 bg-gray-900/80 px-3 py-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-xs font-medium text-gray-500">最近 5 次触发（本地时间）</p>
                    {cronPreviewLoading && cronPreviewRuns && cronPreviewRuns.length > 0 && (
                      <span className="flex items-center gap-1 text-[11px] text-gray-500">
                        <Loader2 size={11} className="animate-spin shrink-0" />
                        更新中…
                      </span>
                    )}
                  </div>
                  {cronPreviewLoading && (!cronPreviewRuns || cronPreviewRuns.length === 0) && (
                    <p className="mt-1 flex items-center gap-1.5 text-xs text-gray-500">
                      <Loader2 size={12} className="animate-spin" />计算中…
                    </p>
                  )}
                  {!cronPreviewLoading && cronPreviewErr && (
                    <p className="mt-1 text-xs text-amber-400/90">{cronPreviewErr}</p>
                  )}
                  {cronPreviewRuns && cronPreviewRuns.length > 0 && (
                    <ol className={`mt-1.5 list-decimal space-y-0.5 pl-4 font-mono text-[11px] leading-relaxed text-gray-400 ${cronPreviewLoading ? "opacity-70" : ""}`}>
                      {cronPreviewRuns.map((line, i) => (
                        <li key={`${line}-${i}`}>{line}</li>
                      ))}
                    </ol>
                  )}
                  <p className="mt-1.5 text-[10px] text-gray-600">由解析库推算，与 node-cron 在少数写法上可能略有差异，以实际日志为准。</p>
                </div>
              </div>
              <div><label className="mb-1 block text-xs text-gray-500">消息内容</label><textarea value={taskEditing.content} onChange={(e) => setTaskEditing({ ...taskEditing, content: e.target.value })} rows={6} className={inputCls + " font-mono text-xs leading-relaxed"} placeholder="要发送给 Agent 的消息..." /></div>
              <div className="flex items-center gap-2">
                <input type="checkbox" checked={taskEditing.enabled} onChange={(e) => setTaskEditing({ ...taskEditing, enabled: e.target.checked })} className="rounded border-gray-600" />
                <label className="text-xs text-gray-400">启用</label>
              </div>
            </div>
            <div className="flex justify-end gap-2 border-t border-gray-800 px-6 py-4">
              <button onClick={() => setTaskEditing(null)} className="rounded-md px-4 py-1.5 text-xs text-gray-400 transition hover:bg-gray-800 hover:text-white">取消</button>
              <button onClick={handleTaskSave} disabled={!taskEditing.name.trim() || !taskEditing.cron.trim()} className="rounded-md bg-blue-600 px-4 py-1.5 text-xs font-medium text-white transition hover:bg-blue-500 disabled:opacity-40">保存</button>
            </div>
          </div>
        </div>
      )}

      <WorkspaceDaemonModal
        open={workspaceDaemonChoice !== null}
        oldPath={workspaceDaemonChoice?.old ?? ""}
        newPath={workspaceDaemonChoice?.new ?? ""}
        onKeep={() => setWorkspaceDaemonChoice(null)}
        onRestarted={(ok, err) => {
          const chosenNew = workspaceDaemonChoice?.new ?? ""
          setWorkspaceDaemonChoice(null)
          if (!ok) {
            alert(err ? `重启 Daemon 失败：\n${err}` : "重启 Daemon 失败")
            return
          }
          setWorkspaceDir(chosenNew)
          void refreshMcpServers(true)
        }}
      />
    </div>
  )
}
