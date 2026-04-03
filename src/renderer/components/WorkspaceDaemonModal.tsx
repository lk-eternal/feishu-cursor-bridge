import { useState } from "react"
import { ModalShell, modalBtnGhost, modalBtnPrimary } from "./ModalShell"

interface Props {
  open: boolean
  oldPath: string
  newPath: string
  onKeep: () => void
  onRestarted: (ok: boolean, error?: string) => void
}

export default function WorkspaceDaemonModal({
  open,
  oldPath,
  newPath,
  onKeep,
  onRestarted,
}: Props) {
  const [busy, setBusy] = useState(false)

  if (!open) return null

  const handleRestart = async () => {
    setBusy(true)
    try {
      const r = await window.electronAPI.applyWorkspaceDaemonRestart(newPath.trim())
      onRestarted(r.ok, r.error)
    } catch (e: unknown) {
      onRestarted(false, e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <ModalShell
      title="工作目录已更改"
      footer={
        <div className="flex w-full flex-wrap justify-end gap-2">
          <button
            type="button"
            className={`${modalBtnGhost} whitespace-nowrap`}
            disabled={busy}
            onClick={() => {
              onKeep()
            }}
          >
            保持当前 Daemon
          </button>
          <button
            type="button"
            className={`${modalBtnPrimary} whitespace-nowrap`}
            disabled={busy}
            onClick={() => void handleRestart()}
          >
            {busy ? "正在重启…" : "立即重启 Daemon"}
          </button>
        </div>
      }
    >
      <p className="mb-3 text-gray-200">
        当前 Daemon 正在运行，且绑定在原有工作目录。请选择：
      </p>
      <ul className="mb-3 list-outside list-disc space-y-2 pl-5 text-xs leading-snug text-gray-400 marker:text-gray-600">
        <li>
          <span className="font-medium text-gray-300">立即重启 Daemon</span>
          <span className="text-gray-400">：停止当前 Daemon 与 Agent，并在新目录下重新启动。</span>
        </li>
        <li>
          <span className="font-medium text-gray-300">保持当前 Daemon</span>
          <span className="text-gray-400">：不停止进程；设置中的工作目录将维持为原路径。</span>
        </li>
      </ul>
      <div className="space-y-2 rounded-lg border border-gray-800 bg-gray-900/50 p-2 text-[11px] text-gray-500">
        <div className="min-w-0">
          <div className="mb-0.5 text-gray-600">当前生效（Daemon）</div>
          <div className="break-all font-mono text-gray-400">{oldPath || "（空）"}</div>
        </div>
        <div className="min-w-0">
          <div className="mb-0.5 text-gray-600">你选中的目录</div>
          <div className="break-all font-mono text-gray-400">{newPath || "（空）"}</div>
        </div>
      </div>
    </ModalShell>
  )
}
