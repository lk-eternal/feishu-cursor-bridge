# Feishu Cursor Bridge

飞书 × Cursor 远程协作桌面应用 —— 将 Cursor 变成 7×24 小时在线的数字雇员，通过飞书随时随地与 AI 协作。

## 为什么需要它？

Cursor Agent 的交互被锁死在本地 IDE 中，一旦离开电脑，所有 AI 协作都会停滞。

**Feishu Cursor Bridge** 打破了这种限制：

- AI 的提问会通过飞书机器人发到你手机上，你在飞书回复后 AI 自动继续工作
- 即使 Cursor 会话断开，守护进程也能自动重连拉起新会话
- 支持定时任务，让 AI 按计划自动执行工作
- 配合 Loop 协议，Cursor 计次版一次请求可持续交互一整天，500 次/月绰绰有余

## 功能特性

| 功能 | 说明 |
|------|------|
| 可视化配置 | 首次使用向导 + 设置页面，无需手写配置文件 |
| 一键启停 | 控制台一键管理守护进程生命周期 |
| 消息桥接 | AI 通过飞书发消息、发图片、发文件，你在飞书回复 |
| 自动重连 | Agent 断开后自动拉起新会话，最大程度保证连续性 |
| 指令系统 | 飞书发送 `/stop` `/status` `/restart` 等指令直接控制 |
| 定时任务 | Cron 表达式调度，定时给 AI 下达指令（如每天生成日报） |
| MCP 管理 | 可视化管理 MCP 服务器配置（JSON 编辑），支持 OAuth 认证 |
| Rule & Skill | 管理 Cursor Rules 和 Agent Skills 文件 |
| 系统托盘 | 关闭窗口自动最小化到托盘，后台持续运行 |
| 工作区注入 | 自动写入 `.cursor/mcp.json` 和 Loop 协议规则 |

## 轻量版 vs 应用版

| 维度 | 轻量版 | 应用版 |
|------|--------|--------|
| 形态 | MCP 服务（无 GUI） | Electron 桌面应用 |
| 自动重连 | 单次会话内无限循环 | Agent 断开后自动拉起新会话 |
| 定时任务 | 不支持 | Cron 表达式调度 |
| 配置管理 | 手动配置环境变量 + 规则文件 | 可视化设置界面 |
| 适用场景 | 快速上手 / 简单使用 / 节省次数 | 长期稳定运行 |

## 架构

```
┌────────────────────────────────────────────────────────────┐
│  Electron 桌面应用                                          │
│  · 配置向导 / 控制台 / 设置（React + Tailwind）              │
│  · 管理 Daemon 生命周期、Cron 调度                           │
│  · 自动注入 .cursor/mcp.json 和 Rules                       │
└──────────────┬──────────────────────────────┬──────────────┘
               │ spawn                        │ 写入工作区
               ▼                              ▼
┌──────────────────────────┐    ┌─────────────────────────────┐
│  Daemon 守护进程          │    │  .cursor/                    │
│  · 飞书 WebSocket 长连接  │    │  ├── mcp.json → lite MCP     │
│  · 本机 HTTP API          │    │  └── rules/                  │
│  · 消息队列               │    │      └── feishu-cursor-...   │
│  · 会话保活（自动重连）   │    └──────────────┬──────────────┘
└──────────────┬───────────┘                   │ stdio
               │ HTTP 127.0.0.1                ▼
               │                  ┌─────────────────────────────┐
               └─────────────────►│  Lite MCP Server             │
                                  │  · sync_message（收发消息）   │
                                  │  · send_image（发送图片）     │
                                  │  · send_file（发送文件）      │
                                  │  Cursor 子进程，stdio 通信    │
                                  └─────────────────────────────┘
```

## 安装

### 应用版（推荐）

从 [Releases](../../releases) 页面下载对应平台的安装包：

| 平台 | 格式 | 备注 |
|------|------|------|
| Windows | `.exe` | 直接运行安装 |
| macOS (Intel) | `.dmg` | 首次打开需解除 Gatekeeper |
| macOS (Apple Silicon) | `.dmg` | 首次打开需解除 Gatekeeper |
| macOS (Homebrew) | `brew install --cask` | 推荐，便于升级管理 |
| Linux | `.deb` / `.AppImage` | 直接运行 |

#### macOS 通过 Homebrew 安装

```bash
brew tap lk-eternal/tap
brew install --cask feishu-cursor-bridge
```

升级到最新版：

```bash
brew update && brew upgrade --cask feishu-cursor-bridge
```

#### macOS 首次打开提示"无法验证开发者"

由于应用尚未经过 Apple 签名，macOS Gatekeeper 会拦截首次启动。解决方法：

```bash
xattr -cr /Applications/Feishu\ Cursor\ Bridge.app
```

或到 **系统设置 → 隐私与安全性** 中点击"仍然打开"。

### 轻量版（纯 MCP，无 GUI）

#### 一键安装

[点击一键安装到 Cursor](https://cursor.com/en-US/install-mcp?name=feishu-cursor-bridge&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsImxhcmstYnJpZGdlLW1jcEBsYXRlc3QiXSwiZW52Ijp7IkxBUktfQVBQX0lEIjoiIiwiTEFSS19BUFBfU0VDUkVUIjoiIiwiTEFSS19SRUNFSVZFX0lEX1RZUEUiOiJvcGVuX2lkIiwiTEFSS19SRUNFSVZFX0lEIjoiIn19)，填入 App ID 和 App Secret 即可。

#### 手动安装

在 `.cursor/mcp.json` 中添加：

```json
{
  "mcpServers": {
    "feishu-cursor-bridge": {
      "command": "npx",
      "args": ["-y", "lark-bridge-mcp@latest"],
      "env": {
        "LARK_APP_ID": "你的 App ID",
        "LARK_APP_SECRET": "你的 App Secret"
      }
    }
  }
}
```

启动后在飞书找到你的机器人，私聊发一条消息。程序会自动记录你的 `open_id`。之后可以将 `open_id` 固定到配置中：

```json
"env": {
  "LARK_APP_ID": "你的 App ID",
  "LARK_APP_SECRET": "你的 App Secret",
  "LARK_RECEIVE_ID": "ou_xxxxxxxxxxxxxx",
  "LARK_RECEIVE_ID_TYPE": "open_id"
}
```

## 快速开始

### 应用版

1. 下载安装并启动应用
2. 按照向导填入飞书 App ID / App Secret
3. 配置消息接收者（支持自动识别、open_id、邮箱、手机号）
4. 选择 Cursor 工作目录，应用会自动注入 MCP 配置和 Loop 协议规则
5. 在 Dashboard 启动 Daemon，开始使用

> 如果选择"自动识别"方式，启动 Daemon 后需要在飞书私聊机器人发一条消息，系统会自动记住你的身份。

### 轻量版

1. 按照上方安装说明配置 MCP
2. 在 `.cursor/rules/` 目录下添加 Loop 协议规则文件（见下方 Loop 协议章节）
3. 在飞书私聊机器人发一条消息完成身份绑定
4. 在 Cursor 中开始使用

## Loop 协议：无限循环不计次

Loop 协议是实现「Agent 持续在线」的核心机制。它通过 Cursor Rules 强制 Agent 在任务完成后持续轮询飞书消息，而不是主动结束会话。

**Cursor 计次版用户的核心优势：** 一次 Agent 请求启动后，后续所有工具调用（包括 `sync_message` 的循环轮询）不消耗额外次数。配合 Loop 协议，一次请求可持续交互一整天。

> 应用版会自动注入 Loop 协议规则，无需手动配置。轻量版需要手动创建规则文件。

<details>
<summary>查看 Loop 协议规则文件（轻量版用户需手动添加）</summary>

在 `.cursor/rules/feishu-cursor-bridge.mdc` 中添加：

```yaml
---
description: 飞书实时通信保活协议
alwaysApply: true
---

# 飞书异步长连接执行协议 (Persistent Loop Protocol)

你当前处于"非对称异步通信模式"。在这种模式下，飞书是唯一的真理来源。
你必须通过 feishu-cursor-bridge MCP 工具主动维护会话状态，严禁本地空转或擅自结束。

## 状态机工作流

统一使用 `sync_message` 工具完成所有消息交互：
- 传 `message` → 发送消息
- 传 `timeout_seconds` → 等待用户回复
- 两者同时传 → 先发送再等待

1. **响应阶段 (Ack):** 收到用户指令后，立即发送确认消息。
2. **同步阶段 (Sync):** 每完成一个子步骤必须调用一次 sync_message 汇报进度。
3. **锚点阶段 (Anchor):** 任务完成时，发送结果并等待下一步指示。
4. **保活循环 (Keep-Alive):** 若返回超时或空值，持续调用 sync_message(timeout_seconds=60)。

## 核心禁令

* 严禁输出"再见"等导致会话终结的文本。
* 等待用户回复时，严禁重复发送相同消息。
```

</details>

## MCP 工具

| 工具 | 参数 | 说明 |
|------|------|------|
| `sync_message` | `message?`, `timeout_seconds?` | 发送消息到飞书 / 等待用户回复，或两者组合 |
| `send_image` | `path` | 发送本地图片到飞书 |
| `send_file` | `path` | 发送本地文件到飞书 |

**`sync_message` 用法示例：**

```
sync_message(message="方案A还是B？", timeout_seconds=60)  → 发消息并等待回复
sync_message(timeout_seconds=60)                          → 仅轮询等待回复
sync_message(message="任务完成！")                          → 仅发送通知
```

## 指令系统

在飞书对话中直接发送指令（不区分大小写），无需 Agent 运行：

| 指令 | 说明 |
|------|------|
| `/stop` | 停止运行中的 Agent |
| `/status` | 查看 Agent / Daemon 状态 |
| `/list` | 查看消息队列中的待处理消息 |
| `/task` | 查看当前定时任务列表 |
| `/restart` | 停止 Agent → 清空队列 → 重启 Daemon |
| `/help` | 列出所有可用指令 |

## 会话保活与自动重连

Daemon 进程独立于 Cursor 运行，即使 Agent 会话中断，系统也能自动恢复：

1. **Daemon** 通过飞书 WebSocket 长连接持续监听消息，不依赖 Cursor 进程
2. **MCP Server** 每 15 秒向 Daemon 发送心跳，超时即判定 Agent 已断开
3. 当收到新的飞书消息且 Agent 已断开时，自动通过 Cursor CLI 拉起新会话

> 自动拉起需要安装 Cursor CLI（`agent` 命令）。应用版可在 Dashboard 一键安装。

## 环境变量（轻量版）

| 变量 | 必填 | 说明 |
|------|------|------|
| `LARK_APP_ID` | 是 | 飞书应用 App ID |
| `LARK_APP_SECRET` | 是 | 飞书应用 App Secret |
| `LARK_RECEIVE_ID` | 否 | 消息接收者标识（不填则自动从首条消息获取） |
| `LARK_RECEIVE_ID_TYPE` | 否 | ID 类型：`open_id` / `user_id` / `chat_id` / `email` / `mobile` |
| `LARK_ENCRYPT_KEY` | 否 | 事件加密密钥（长连接模式通常不需要） |
| `LARK_MESSAGE_PREFIX` | 否 | 发送消息前缀 |

## 飞书应用配置

1. 前往 [飞书开放平台](https://open.feishu.cn/app/) 创建自建应用
2. 获取 App ID 和 App Secret
3. 添加「机器人」能力
4. 在「权限管理」中开通权限（可通过批量导入快速添加）：
   - `im:message` — 获取与发送单聊、群组消息
   - `im:message.p2p_msg:readonly` — 读取用户发给机器人的单聊消息
   - `im:resource` — 获取与上传图片或文件资源
   - `contact:user.id:readonly` — 通过邮箱/手机号查找用户（可选）

<details>
<summary>批量导入权限 JSON</summary>

```json
{
  "scopes": {
    "tenant": [
      "contact:user.id:readonly",
      "im:message",
      "im:message.p2p_msg:readonly",
      "im:resource"
    ],
    "user": []
  }
}
```

</details>

5. 在「事件与回调」中选择 **「长连接」** 模式，添加 `im.message.receive_v1` 事件

   > **注意：** 配置事件订阅前需先启动服务（MCP 或应用版），否则飞书无法验证 WebSocket 连接。

6. 在「版本管理与发布」中发布应用
7. 在飞书私聊机器人发一条消息完成身份绑定

## 飞书全链路研发自动化

配合以下 MCP 服务，可实现从需求分析到代码交付的全链路自动化：

- **飞书文档 MCP**：读取 PRD、自动撰写技术方案、同步变更说明
  - 配置入口：[https://open.feishu.cn/page/mcp](https://open.feishu.cn/page/mcp)
- **飞书项目 MCP**：获取待办任务、更新工作项状态、生成进度报告
  - 配置：`"feishu-project-mcp": { "url": "https://project.feishu.cn/mcp_server/v1" }`

## 常见问题

<details>
<summary>Agent 会话为什么会断开？</summary>

常见原因：
- **上下文窗口超限**：超长会话会被自动截断，建议复杂任务拆分或使用 `.cursor/memory.md` 持久化关键信息
- **工具调用过多**：单次会话中工具调用次数过多可能触发 Cursor 安全机制
- **网络波动**：本地网络不稳定可能导致 MCP stdio 通信中断
- **Cursor 更新/重启**：IDE 自动更新会中断当前会话

> 应用版可在 Agent 断开后自动重新拉起会话。

</details>

<details>
<summary>为什么飞书收不到消息？</summary>

请按顺序排查：
1. 确认添加了 `im.message.receive_v1` 事件订阅，且选择「长连接」模式
2. 确认应用已发布（未发布的应用无法接收消息）
3. 确认 `im:message` 和 `im:message.p2p_msg:readonly` 权限已添加
4. 确认服务已启动且飞书 WebSocket 连接成功
5. 确认是在机器人私聊窗口发送消息

</details>

<details>
<summary>无限循环真的不计次吗？</summary>

是的。在 Cursor 计次版（Fast Request 模式）下，一次 Agent 请求启动后，后续所有工具调用不消耗额外次数。配合 Loop 协议，Agent 会在完成任务后持续等待新指令，整个生命周期只算一次请求。

</details>

<details>
<summary>定时任务需要电脑一直开着吗？</summary>

是的。定时任务由应用版调度，需要桌面应用保持运行。关闭窗口后应用会最小化到系统托盘继续运行，但完全退出或关机后定时任务将不会触发。

</details>

## 注意事项

- **会话重连是新上下文**：重新拉起的 Agent 会话没有之前的对话记忆，重要状态应通过 `.cursor/memory.md` 持久化
- **凭据安全**：App Secret 是敏感信息，请勿提交到 Git 仓库
- **网络要求**：Daemon 需保持与飞书服务器的网络连接，企业网络如有代理限制，可在设置中配置代理
- **Cursor CLI 依赖**：自动拉起 Agent 功能依赖 Cursor CLI，需在 Dashboard 中安装

## 开发

```bash
# 安装依赖
npm install
cd lite && npm install && cd ..

# 开发模式
npm run dev

# 构建
npm run build

# 打包
npm run dist:win   # Windows
npm run dist:mac   # macOS
```

## License

MIT


## Star History

<a href="https://www.star-history.com/?repos=lk-eternal%2Ffeishu-cursor-bridge&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/image?repos=lk-eternal/feishu-cursor-bridge&type=date&theme=dark&legend=top-left" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/image?repos=lk-eternal/feishu-cursor-bridge&type=date&legend=top-left" />
   <img alt="Star History Chart" src="https://api.star-history.com/image?repos=lk-eternal/feishu-cursor-bridge&type=date&legend=top-left" />
 </picture>
</a>
