import * as fs from "node:fs"
import * as path from "node:path"
import { getConfig } from "./config-store"

export interface InjectResult {
  file: string
  action: "created" | "updated" | "skipped"
  message: string
}

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
`

function ensureDir(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true })
  }
}

function injectFile(filePath: string, content: string): InjectResult {
  const relPath = path.basename(filePath)

  if (fs.existsSync(filePath)) {
    return { file: relPath, action: "skipped", message: "文件已存在" }
  }

  ensureDir(path.dirname(filePath))
  fs.writeFileSync(filePath, content, "utf-8")
  return { file: relPath, action: "created", message: "文件已创建" }
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
    ),
  )

  return { results }
}
