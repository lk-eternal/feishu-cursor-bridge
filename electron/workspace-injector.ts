import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"
import { getConfig } from "./config-store"

export interface InjectResult {
  file: string
  action: "created" | "updated" | "skipped"
  message: string
}

const TASKS_FILE_PATH = path.join(os.homedir(), ".lark-bridge-mcp", "scheduled-tasks.json").replace(/\\/g, "/")

const RULES_CONTENT = `---
description: 
alwaysApply: true
---

# 飞书远程协作规则

你正在通过飞书与用户远程协作。用户不在电脑旁，飞书是唯一通信渠道。
永远不要主动结束会话。

## 工作方式
先读后行：启动前，先读取长期记忆: .cursor/memory.md。
沙盒操作：所有临时代码、执行脚本、中间产物必须存放于 ./tmp_exec/ 目录, 执行完成后需要清除目录文件。
实时存档：任务状态变更或结束前，必须更新 .cursor/memory.md。

## 定时任务管理

你可以直接编辑定时任务配置文件来管理 cron 定时任务。文件路径：
\`${TASKS_FILE_PATH}\`

文件格式为 JSON 数组，每个任务包含以下字段：
\`\`\`json
[
  {
    "id": "unique-task-id",
    "name": "任务名称",
    "cron": "*/30 * * * *",
    "content": "发送给AI的消息内容，触发时会自动入队",
    "enabled": true
  }
]
\`\`\`

字段说明：
- id: 唯一标识符，建议使用 kebab-case
- name: 任务显示名称
- cron: 标准 cron 表达式（5段: 分 时 日 月 周）
- content: 触发时发送的消息内容
- enabled: 是否启用（true/false）

常用 cron 表达式：
- \`*/30 * * * *\` — 每30分钟
- \`0 9 * * *\` — 每天早上9点
- \`0 9 * * 1-5\` — 工作日早上9点
- \`0 */2 * * *\` — 每2小时

修改后系统会自动检测文件变化并重新加载任务，无需重启。
`

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
      path.join(wsDir, ".cursor", "rules", "lark-bridge.mdc"),
      RULES_CONTENT,
      true,
    ),
  )

  results.push(
    injectFile(
      path.join(os.homedir(), ".cursor", "skills", "feishu-bridge-admin", "SKILL.md"),
      ADMIN_SKILL_CONTENT,
      true,
    ),
  )

  return { results }
}
