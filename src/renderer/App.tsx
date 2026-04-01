import { useState, useEffect } from "react"
import Setup from "./pages/Setup"
import Dashboard from "./pages/Dashboard"
import Settings from "./pages/Settings"

type Page = "setup" | "dashboard" | "settings"

export default function App() {
  const [page, setPage] = useState<Page>("setup")
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")

  useEffect(() => {
    if (!window.electronAPI) {
      setError("electronAPI 未加载（preload 脚本可能未正确注入）")
      setLoading(false)
      return
    }
    window.electronAPI
      .getConfig()
      .then((config) => {
        if (config.setupComplete) setPage("dashboard")
        setLoading(false)
      })
      .catch((e: unknown) => {
        setError(String(e))
        setLoading(false)
      })
  }, [])

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-blue-500 border-t-transparent" />
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex h-screen items-center justify-center p-8">
        <div className="max-w-md rounded-lg border border-red-800 bg-red-950/50 p-6 text-center">
          <h2 className="mb-2 text-lg font-semibold text-red-400">启动错误</h2>
          <p className="text-sm text-red-300">{error}</p>
        </div>
      </div>
    )
  }

  if (page === "setup") {
    return <Setup onComplete={() => setPage("dashboard")} />
  }

  return (
    <>
      <div className={page === "dashboard" ? "" : "hidden"}>
        <Dashboard onSettings={() => setPage("settings")} />
      </div>
      {page === "settings" && <Settings onBack={() => setPage("dashboard")} />}
    </>
  )
}
