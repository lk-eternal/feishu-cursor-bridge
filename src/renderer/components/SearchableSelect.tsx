import { useState, useRef, useEffect } from "react"
import { ChevronDown, Search } from "lucide-react"

interface Option {
  id: string
  label: string
}

interface Props {
  value: string
  onChange: (value: string) => void
  options: Option[]
  placeholder?: string
}

export default function SearchableSelect({ value, onChange, options, placeholder }: Props) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  const ref = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener("mousedown", handler)
    return () => document.removeEventListener("mousedown", handler)
  }, [])

  useEffect(() => {
    if (open && inputRef.current) inputRef.current.focus()
  }, [open])

  const filtered = query
    ? options.filter(
        (o) =>
          o.id.toLowerCase().includes(query.toLowerCase()) ||
          o.label.toLowerCase().includes(query.toLowerCase()),
      )
    : options

  const selected = options.find((o) => o.id === value)

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => { setOpen(!open); setQuery("") }}
        className="flex w-full items-center justify-between rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-left text-sm outline-none transition hover:border-gray-600 focus:border-blue-500"
      >
        <span className={selected ? "text-gray-100" : "text-gray-500"}>
          {selected ? `${selected.id} — ${selected.label}` : placeholder || "选择..."}
        </span>
        <ChevronDown size={14} className={`text-gray-500 transition ${open ? "rotate-180" : ""}`} />
      </button>

      {open && (
        <div className="absolute z-50 mt-1 w-full rounded-lg border border-gray-700 bg-gray-900 shadow-xl">
          <div className="flex items-center gap-2 border-b border-gray-800 px-3 py-2">
            <Search size={14} className="text-gray-500" />
            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜索模型..."
              className="flex-1 bg-transparent text-sm outline-none placeholder:text-gray-600"
            />
          </div>
          <div className="max-h-56 overflow-y-auto py-1">
            {filtered.length === 0 ? (
              <div className="px-3 py-2 text-xs text-gray-500">无匹配结果</div>
            ) : (
              filtered.map((o) => (
                <button
                  key={o.id}
                  type="button"
                  onClick={() => { onChange(o.id); setOpen(false) }}
                  className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm transition hover:bg-gray-800 ${
                    o.id === value ? "bg-blue-600/20 text-blue-400" : "text-gray-300"
                  }`}
                >
                  <span className="font-mono text-xs">{o.id}</span>
                  <span className="text-gray-500">—</span>
                  <span className="truncate">{o.label}</span>
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  )
}
