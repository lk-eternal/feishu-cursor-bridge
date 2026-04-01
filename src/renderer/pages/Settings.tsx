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
} from "lucide-react"
import SearchableSelect from "../components/SearchableSelect"

interface Props { onBack: () => void }

type IdType = "open_id" | "user_id" | "chat_id"
type Tab = "general" | "proxy" | "mcp" | "rules" | "tasks" | "skills"

interface McpEditForm {
  name: string; type: "command" | "url"; command: string; args: string
  url: string; env: string; source: "global" | "project"
}
interface RuleFile { name: string; content: string }
interface SkillFile { name: string; content: string }
interface TaskItem { id: string; name: string; cron: string; content: string; enabled: boolean }

const emptyMcpForm: McpEditForm = { name: "", type: "command", command: "", args: "", url: "", env: "", source: "global" }

const TABS: { id: Tab; label: string; icon: typeof SettingsIcon }[] = [
  { id: "general", label: "通用", icon: SettingsIcon },
  { id: "proxy", label: "网络", icon: Network },
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

  const [saved, setSaved] = useState(false)
  const [modelOptions, setModelOptions] = useState<{ id: string; label: string }[]>([])
  const [loadingModels, setLoadingModels] = useState(false)

  const [mcpServers, setMcpServers] = useState<McpServerEntry[]>([])
  const [mcpLoading, setMcpLoading] = useState<Record<string, boolean>>({})
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

  const loaded = useRef(false)
  const saveTimer = useRef<ReturnType<typeof setTimeout>>()

  const refreshMcpServers = useCallback(() => { window.electronAPI.getMcpServers().then(setMcpServers) }, [])
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
      loaded.current = true
    })
    refreshMcpServers(); refreshRules(); refreshSkills(); refreshTasks()
    return window.electronAPI.onMcpLoginComplete(() => refreshMcpServers())
  }, [refreshMcpServers, refreshRules, refreshSkills, refreshTasks])

  const autoSave = useCallback(() => {
    if (!loaded.current) return
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(async () => {
      await window.electronAPI.saveConfig({
        larkAppId: appId.trim(), larkAppSecret: appSecret.trim(),
        larkReceiveId: receiveId.trim(), larkReceiveIdType: idType,
        workspaceDir: workspaceDir.trim(), model,
        httpProxy: proxy.trim(), httpsProxy: proxy.trim(), noProxy: noProxy.trim(),
      })
      setSaved(true); setTimeout(() => setSaved(false), 1500)
    }, 500)
  }, [appId, appSecret, receiveId, idType, workspaceDir, model, proxy, noProxy])

  useEffect(() => { autoSave() }, [autoSave])

  const fetchModels = async () => {
    setLoadingModels(true)
    const r = await window.electronAPI.listModels()
    if (r.ok) setModelOptions(r.models)
    setLoadingModels(false)
  }

  const selectDir = async () => { const d = await window.electronAPI.selectDirectory(); if (d) setWorkspaceDir(d) }

  // ── MCP ──
  const handleMcpLogin = async (name: string) => {
    setMcpLoading((p) => ({ ...p, [name]: true }))
    await window.electronAPI.loginMcp(name)
    setMcpLoading((p) => ({ ...p, [name]: false }))
    refreshMcpServers()
  }
  const openMcpAdd = () => { setMcpEditOriginalName(null); setMcpEditing({ ...emptyMcpForm }) }
  const openMcpEdit = (s: McpServerEntry) => {
    setMcpEditOriginalName(s.name)
    const envStr = s.env ? Object.entries(s.env).map(([k, v]) => `${k}=${v}`).join("\n") : ""
    setMcpEditing({ name: s.name, type: s.type, command: s.command ?? "", args: s.args?.join("\n") ?? "", url: s.url ?? "", env: envStr, source: s.source })
  }
  const handleMcpDelete = async (name: string) => { await window.electronAPI.deleteMcpServer(name); refreshMcpServers() }
  const handleMcpSave = async () => {
    if (!mcpEditing || !mcpEditing.name.trim()) return
    if (mcpEditOriginalName && mcpEditOriginalName !== mcpEditing.name) await window.electronAPI.deleteMcpServer(mcpEditOriginalName)
    const entry: Record<string, unknown> = {}
    if (mcpEditing.type === "url") { entry.url = mcpEditing.url.trim() }
    else {
      entry.command = mcpEditing.command.trim()
      const args = mcpEditing.args.split("\n").map((a) => a.trim()).filter(Boolean)
      if (args.length > 0) entry.args = args
    }
    const envLines = mcpEditing.env.split("\n").filter((l) => l.includes("="))
    if (envLines.length > 0) {
      const envObj: Record<string, string> = {}
      for (const line of envLines) { const i = line.indexOf("="); envObj[line.slice(0, i).trim()] = line.slice(i + 1).trim() }
      entry.env = envObj
    }
    await window.electronAPI.saveMcpServer(mcpEditing.name.trim(), entry, mcpEditing.source)
    setMcpEditing(null); refreshMcpServers()
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
              <p className="text-xs text-gray-500">设置修改后自动保存，下次重启 Daemon 后生效</p>
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

            {/* ═══ MCP ═══ */}
            {tab === "mcp" && (<>
              <section className="space-y-3">
                <div className="flex items-center gap-2">
                  <h3 className="text-sm font-medium text-gray-300">MCP 服务器</h3>
                  <button onClick={refreshMcpServers} className="flex items-center gap-1 rounded px-2 py-0.5 text-xs text-gray-400 transition hover:bg-gray-800 hover:text-white"><RefreshCw size={12} />刷新</button>
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
                        {s.type === "url" && (s.authenticated ? <span className="text-xs text-green-400">已认证</span> : mcpLoading[s.name] ? <Loader2 size={12} className="animate-spin text-blue-400" /> : <button onClick={() => handleMcpLogin(s.name)} className="flex items-center gap-1 rounded-md bg-blue-600 px-2 py-1 text-xs font-medium text-white transition hover:bg-blue-500"><LogIn size={12} />登录</button>)}
                        <button onClick={() => openMcpEdit(s)} className="rounded p-1 text-gray-500 transition hover:bg-gray-800 hover:text-white"><Pencil size={13} /></button>
                        <button onClick={() => handleMcpDelete(s.name)} className="rounded p-1 text-gray-500 transition hover:bg-gray-800 hover:text-red-400"><Trash2 size={13} /></button>
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
                <p className="text-xs text-gray-600">Daemon 启动后按 cron 表达式自动触发，向飞书发送消息驱动 Agent</p>
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
          <div className="w-full max-w-md rounded-xl border border-gray-700 bg-gray-900 p-6 shadow-2xl">
            <div className="mb-4 flex items-center justify-between">
              <h3 className="text-sm font-semibold text-gray-200">{mcpEditOriginalName ? "编辑 MCP" : "新增 MCP"}</h3>
              <button onClick={() => setMcpEditing(null)} className="text-gray-500 hover:text-white"><X size={16} /></button>
            </div>
            <div className="space-y-3">
              <div><label className="mb-1 block text-xs text-gray-500">名称</label><input type="text" value={mcpEditing.name} onChange={(e) => setMcpEditing({ ...mcpEditing, name: e.target.value })} className={inputCls} placeholder="my-mcp-server" /></div>
              <div className="grid grid-cols-2 gap-3">
                <div><label className="mb-1 block text-xs text-gray-500">类型</label><select value={mcpEditing.type} onChange={(e) => setMcpEditing({ ...mcpEditing, type: e.target.value as "command" | "url" })} className={inputCls}><option value="command">命令 (stdio)</option><option value="url">URL (SSE/HTTP)</option></select></div>
                <div><label className="mb-1 block text-xs text-gray-500">作用域</label><select value={mcpEditing.source} onChange={(e) => setMcpEditing({ ...mcpEditing, source: e.target.value as "global" | "project" })} className={inputCls}><option value="global">全局</option><option value="project">项目</option></select></div>
              </div>
              {mcpEditing.type === "url"
                ? <div><label className="mb-1 block text-xs text-gray-500">URL</label><input type="text" value={mcpEditing.url} onChange={(e) => setMcpEditing({ ...mcpEditing, url: e.target.value })} className={inputCls} placeholder="https://mcp.example.com/sse" /></div>
                : <>
                    <div><label className="mb-1 block text-xs text-gray-500">命令</label><input type="text" value={mcpEditing.command} onChange={(e) => setMcpEditing({ ...mcpEditing, command: e.target.value })} className={inputCls} placeholder="npx" /></div>
                    <div><label className="mb-1 block text-xs text-gray-500">参数（每行一个）</label><textarea value={mcpEditing.args} onChange={(e) => setMcpEditing({ ...mcpEditing, args: e.target.value })} rows={3} className={inputCls + " font-mono text-xs"} placeholder={"-y\n@some/mcp-server"} /></div>
                  </>}
              <div><label className="mb-1 block text-xs text-gray-500">环境变量（每行 KEY=VALUE）</label><textarea value={mcpEditing.env} onChange={(e) => setMcpEditing({ ...mcpEditing, env: e.target.value })} rows={2} className={inputCls + " font-mono text-xs"} placeholder="API_KEY=xxx" /></div>
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <button onClick={() => setMcpEditing(null)} className="rounded-md px-4 py-1.5 text-xs text-gray-400 transition hover:bg-gray-800 hover:text-white">取消</button>
              <button onClick={handleMcpSave} disabled={!mcpEditing.name.trim()} className="rounded-md bg-blue-600 px-4 py-1.5 text-xs font-medium text-white transition hover:bg-blue-500 disabled:opacity-40">保存</button>
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
                <p className="mt-1 text-xs text-gray-600">格式: 分 时 日 月 周 （如 0 9 * * 1-5 = 工作日 9:00）</p>
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
    </div>
  )
}
