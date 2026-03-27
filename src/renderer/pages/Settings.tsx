import { useState, useEffect, useRef, useCallback } from "react"
import {
  ArrowLeft,
  FolderOpen,
  CheckCircle2,
  Loader2,
  Eye,
  EyeOff,
  RefreshCw,
} from "lucide-react"
import SearchableSelect from "../components/SearchableSelect"

interface Props {
  onBack: () => void
}

type IdType = "open_id" | "user_id" | "chat_id"
type Model = string

export default function Settings({ onBack }: Props) {
  const [appId, setAppId] = useState("")
  const [appSecret, setAppSecret] = useState("")
  const [receiveId, setReceiveId] = useState("")
  const [idType, setIdType] = useState<IdType>("open_id")
  const [workspaceDir, setWorkspaceDir] = useState("")
  const [model, setModel] = useState<Model>("auto")
  const [showSecret, setShowSecret] = useState(false)
  const [httpProxy, setHttpProxy] = useState("")
  const [httpsProxy, setHttpsProxy] = useState("")
  const [noProxy, setNoProxy] = useState("localhost,127.0.0.1")

  const [saved, setSaved] = useState(false)
  const [modelOptions, setModelOptions] = useState<{ id: string; label: string }[]>([])
  const [loadingModels, setLoadingModels] = useState(false)
  const loaded = useRef(false)
  const saveTimer = useRef<ReturnType<typeof setTimeout>>()

  useEffect(() => {
    window.electronAPI.getConfig().then((config) => {
      setAppId(config.larkAppId)
      setAppSecret(config.larkAppSecret)
      setReceiveId(config.larkReceiveId)
      setIdType(config.larkReceiveIdType)
      setWorkspaceDir(config.workspaceDir)
      setModel(config.model)
      setHttpProxy(config.httpProxy || "")
      setHttpsProxy(config.httpsProxy || "")
      setNoProxy(config.noProxy || "localhost,127.0.0.1")
      loaded.current = true
    })
  }, [])

  const autoSave = useCallback(() => {
    if (!loaded.current) return
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(async () => {
      await window.electronAPI.saveConfig({
        larkAppId: appId.trim(),
        larkAppSecret: appSecret.trim(),
        larkReceiveId: receiveId.trim(),
        larkReceiveIdType: idType,
        workspaceDir: workspaceDir.trim(),
        model,
        httpProxy: httpProxy.trim(),
        httpsProxy: httpsProxy.trim(),
        noProxy: noProxy.trim(),
      })
      setSaved(true)
      setTimeout(() => setSaved(false), 1500)
    }, 500)
  }, [appId, appSecret, receiveId, idType, workspaceDir, model, httpProxy, httpsProxy, noProxy])

  useEffect(() => { autoSave() }, [autoSave])

  const fetchModels = async () => {
    setLoadingModels(true)
    const result = await window.electronAPI.listModels()
    if (result.ok) {
      setModelOptions(result.models)
    }
    setLoadingModels(false)
  }

  const selectDir = async () => {
    const dir = await window.electronAPI.selectDirectory()
    if (dir) setWorkspaceDir(dir)
  }

  return (
    <div className="flex h-screen flex-col">
      <div className="flex items-center gap-3 border-b border-gray-800 px-6 py-4">
        <button
          onClick={onBack}
          className="rounded-lg p-1.5 text-gray-400 transition hover:bg-gray-800 hover:text-white"
        >
          <ArrowLeft size={18} />
        </button>
        <h1 className="text-lg font-semibold">设置</h1>
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-6">
        <div className="mx-auto max-w-xl space-y-6">
          {/* Credentials */}
          <section className="space-y-4">
            <h3 className="text-sm font-medium text-gray-300">飞书凭据</h3>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="mb-1 block text-xs text-gray-500">App ID</label>
                <input
                  type="text"
                  value={appId}
                  onChange={(e) => setAppId(e.target.value)}
                  className="w-full rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-sm outline-none transition focus:border-blue-500"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs text-gray-500">App Secret</label>
                <div className="relative">
                  <input
                    type={showSecret ? "text" : "password"}
                    value={appSecret}
                    onChange={(e) => setAppSecret(e.target.value)}
                    className="w-full rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 pr-10 text-sm outline-none transition focus:border-blue-500"
                  />
                  <button
                    type="button"
                    onClick={() => setShowSecret(!showSecret)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300"
                  >
                    {showSecret ? <EyeOff size={14} /> : <Eye size={14} />}
                  </button>
                </div>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="mb-1 block text-xs text-gray-500">Receive ID</label>
                <input
                  type="text"
                  value={receiveId}
                  onChange={(e) => setReceiveId(e.target.value)}
                  className="w-full rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-sm outline-none transition focus:border-blue-500"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs text-gray-500">ID 类型</label>
                <select
                  value={idType}
                  onChange={(e) => setIdType(e.target.value as IdType)}
                  className="w-full rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-sm outline-none transition focus:border-blue-500"
                >
                  <option value="open_id">Open ID</option>
                  <option value="user_id">User ID</option>
                  <option value="chat_id">Chat ID</option>
                </select>
              </div>
            </div>
          </section>

          {/* Workspace */}
          <section className="space-y-3">
            <h3 className="text-sm font-medium text-gray-300">工作目录</h3>
            <div
              onClick={selectDir}
              className="flex cursor-pointer items-center gap-3 rounded-lg border border-gray-700 px-4 py-3 transition hover:border-blue-500"
            >
              <FolderOpen size={18} className="text-blue-400" />
              <span className="truncate text-sm">
                {workspaceDir || "点击选择..."}
              </span>
            </div>
          </section>

          {/* Proxy */}
          <section className="space-y-4">
            <h3 className="text-sm font-medium text-gray-300">代理设置</h3>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="mb-1 block text-xs text-gray-500">HTTP_PROXY</label>
                <input
                  type="text"
                  value={httpProxy}
                  onChange={(e) => setHttpProxy(e.target.value)}
                  placeholder="http://127.0.0.1:7897"
                  className="w-full rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-sm outline-none transition focus:border-blue-500"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs text-gray-500">HTTPS_PROXY</label>
                <input
                  type="text"
                  value={httpsProxy}
                  onChange={(e) => setHttpsProxy(e.target.value)}
                  placeholder="http://127.0.0.1:7897"
                  className="w-full rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-sm outline-none transition focus:border-blue-500"
                />
              </div>
            </div>
            <div>
              <label className="mb-1 block text-xs text-gray-500">NO_PROXY</label>
              <input
                type="text"
                value={noProxy}
                onChange={(e) => setNoProxy(e.target.value)}
                placeholder="localhost,127.0.0.1"
                className="w-full rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-sm outline-none transition focus:border-blue-500"
              />
            </div>
          </section>

          {/* Model */}
          <section className="space-y-3">
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-medium text-gray-300">模型</h3>
              <button
                onClick={fetchModels}
                disabled={loadingModels}
                className="flex items-center gap-1 rounded px-2 py-0.5 text-xs text-gray-400 transition hover:bg-gray-800 hover:text-white disabled:opacity-50"
              >
                {loadingModels ? (
                  <Loader2 size={12} className="animate-spin" />
                ) : (
                  <RefreshCw size={12} />
                )}
                获取可用模型
              </button>
            </div>
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
            <p className="text-xs text-gray-500">点击"获取可用模型"从 CLI 动态加载，或直接输入模型名称</p>
          </section>

          {/* Actions */}
          <section className="flex items-center gap-3 border-t border-gray-800 pt-5">
            {saved && (
              <span className="flex items-center gap-1 text-xs text-green-400">
                <CheckCircle2 size={14} />
                已自动保存
              </span>
            )}
            <div className="flex-1" />
          </section>
        </div>
      </div>
    </div>
  )
}
