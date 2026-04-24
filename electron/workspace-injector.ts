import * as fs from "node:fs"
import * as path from "node:path"
import { getConfig } from "./config-store"

export interface InjectResult {
  file: string
  action: "created" | "updated" | "skipped"
  message: string
}

const ADMIN_SKILL_CONTENT = `# 飞书 Cursor Bridge — 自管理 Skill

你可以通过以下 MCP 工具管理飞书 Cursor Bridge 应用自身的运行状态、配置和环境。

## 可用 MCP 工具

### manage_agent
管理 Agent 生命周期。
| action | 说明 |
|--------|------|
| status | 查询运行状态 |
| stop | 停止 Agent |
| restart | 重启应用 |
| reset | 重置会话 |
| clean | 清空消息队列 |

### manage_mcp
管理 MCP 服务器配置（list / add / delete）。

### manage_rules
管理 Cursor Rules 文件（list / read / save / delete）。

### manage_skills
管理 Agent Skills（list / read / save / delete）。

### manage_tasks
管理定时任务（list / add / update / delete / toggle）。

### manage_workspace
管理工作目录（get / set）。set 后自动重启 Daemon。

## 飞书指令
/status /stop /restart /reset /list /clean /task /model /mcp /workspace /help
`

function ensureDir(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true })
  }
}

function injectFile(filePath: string, content: string, forceUpdate = false): InjectResult {
  const relPath = path.basename(filePath)

  if (fs.existsSync(filePath) && !forceUpdate) {
    return { file: relPath, action: "skipped", message: "文件已存在" }
  }

  const action = fs.existsSync(filePath) ? "updated" as const : "created" as const
  ensureDir(path.dirname(filePath))
  fs.writeFileSync(filePath, content, "utf-8")
  return { file: relPath, action, message: action === "updated" ? "文件已更新" : "文件已创建" }
}

export async function injectWorkspace(): Promise<{ results: InjectResult[] }> {
  const config = getConfig()
  if (!config.workspaceDir) {
    return { results: [{ file: "", action: "skipped", message: "工作目录未配置" }] }
  }

  const wsDir = config.workspaceDir
  const results: InjectResult[] = []

  results.push(
    injectFile(
      path.join(wsDir, ".cursor", "skills", "feishu-bridge-admin", "SKILL.md"),
      ADMIN_SKILL_CONTENT,
      true,
    ),
  )

  return { results }
}
