# Feishu Cursor Bridge

飞书 × Cursor 远程协作应用 —— 将 Cursor 变成 7×24 小时在线的数字雇员，通过飞书随时随地与 AI 协作。

## 为什么需要它？

Cursor Agent 的交互被锁死在本地 IDE 中，一旦离开电脑，所有 AI 协作都会停滞。

**Feishu Cursor Bridge** 打破了这种限制：

- AI 的提问会通过飞书机器人发到你手机上，你在飞书回复后 AI 自动继续工作
- 即使 Cursor 会话断开，守护进程也能自动重连拉起新会话
- 支持私聊 + 群聊多会话并行，每个会话独立工作区
- 支持定时任务和临时独立 Agent，让 AI 按计划自动执行
- 通过飞书指令系统远程管理 Agent、MCP、Rules、Skills、定时任务

## 功能特性

| 功能 | 说明 |
|------|------|
| 可视化配置 | 5 步初始化向导 + 完整设置页面，零手写配置 |
| 多会话管理 | 私聊 / 群聊 / 定时任务 / 临时 Agent 并行运行，Dashboard 实时展示活跃会话 |
| 消息桥接 | 发文本、发图片、发文件，支持消息回复和群聊 @消息路由 |
| 自动重连 | Agent 断开后自动拉起新会话，支持 `--continue` 延续上下文 |
| 指令系统 | 飞书发送 `/stop` `/status` `/model` `/run` 等 12+ 指令远程控制 |
| 定时任务 | Cron 表达式调度，支持独立 Agent 模式，可视化编辑 + 运行预览 |
| 临时 Agent | 通过 `/run` 指令或 MCP 工具启动一次性独立会话 |
| MCP 管理 | 可视化管理 MCP 服务器（JSON 编辑 / 启停 / OAuth 认证 / 工具列表） |
| Rule & Skill | 管理 Cursor Rules 和 Agent Skills，支持文件树浏览和编辑 |
| 自管理能力 | Agent 可通过 MCP 工具管理自身（MCP/Rules/Skills/Tasks/Workspace） |
| 数字身份 | 为群聊和非主用户会话注入自定义角色定义 |
| 工作区注入 | 自动写入 `.cursor/mcp.json`、Loop 协议规则和自管理 Skill |
| 应用隔离 | 多飞书应用数据隔离，消息队列/锁文件/工作目录按 appId 分离 |
| 应用内更新 | 支持检查更新 / 一键更新，Homebrew 用户可通过 brew 升级 |
| 系统托盘 | 关闭窗口可最小化到托盘，后台持续运行 |

## 架构

```
┌────────────────────────────────────────────────────────────┐
│  Electron 应用                                          │
│  · 配置向导 / Dashboard / 设置（React + Tailwind）          │
│  · 管理 Daemon 生命周期、Cron 调度、多会话管理               │
│  · 自动注入 .cursor/mcp.json、Rules 和 Skills               │
└──────────────┬──────────────────────────────┬──────────────┘
               │ spawn                        │ 写入工作区
               ▼                              ▼
┌──────────────────────────┐    ┌─────────────────────────────┐
│  Daemon 守护进程          │    │  .cursor/                    │
│  · 飞书 WebSocket 长连接  │    │  ├── mcp.json                │
│  · 本机 HTTP API          │    │  ├── rules/                  │
│  · 文件消息队列           │    │  │   └── feishu-cursor-...   │
│  · 飞书指令路由           │    │  └── skills/                 │
│  · 会话保活（自动重连）   │    │      └── feishu-bridge-admin │
└──────────────┬───────────┘    └──────────────┬──────────────┘
               │ HTTP 127.0.0.1                │ stdio
               │                               ▼
               │                  ┌─────────────────────────────┐
               └─────────────────►│  MCP Server                  │
                                  │  · sync_message（收发消息）   │
                                  │  · send_image / send_file    │
                                  │  · manage_agent / mcp / ...  │
                                  │  Cursor 子进程，stdio 通信    │
                                  └─────────────────────────────┘
```

**多会话模型：**

```
Daemon ──┬── 主用户私聊 Agent（使用配置的工作目录）
         ├── 群聊 Agent A（自动创建隔离工作目录）
         ├── 群聊 Agent B（自动创建隔离工作目录）
         ├── 定时任务 Agent（独立会话）
         └── 临时 Agent（/run 指令触发）
```

## 安装

从 [Releases](../../releases) 页面下载对应平台的安装包：

| 平台 | 格式 | 备注 |
|------|------|------|
| Windows | `.exe` | 直接运行安装 |
| macOS (Intel) | `.dmg` | 首次打开需解除 Gatekeeper |
| macOS (Apple Silicon) | `.dmg` | 首次打开需解除 Gatekeeper |
| macOS (Homebrew) | `brew install --cask` | 推荐，便于升级管理 |
| Linux | `.deb` / `.AppImage` | 直接运行 |

#### macOS 通过 Homebrew 安装
##### 初次安装

```bash
# 1. 添加 tap
brew tap lk-eternal/tap

# 2. 安装
brew install --cask feishu-cursor-bridge
```

安装完成后在「应用程序」中打开 **Feishu Cursor Bridge** 即可。

##### 更新到最新版本

```bash
# 常规升级（推荐）
brew update && brew upgrade --cask feishu-cursor-bridge
```

如果提示 `the latest version is already installed` 但实际版本较旧，请参考下方 FAQ。

##### 卸载

```bash
brew uninstall --cask feishu-cursor-bridge
brew untap lk-eternal/tap   # 可选，移除 tap 源
```

##### FAQ

###### Q: `brew upgrade` 提示已是最新，但实际还是旧版本？

这是 Homebrew Cask 的常见问题，通常是本地 tap 缓存没有刷新。按以下步骤操作：

```bash
# 方法 1：强制刷新 tap 后重装
brew untap lk-eternal/tap
brew tap lk-eternal/tap
brew upgrade --cask feishu-cursor-bridge

# 方法 2：直接强制重装
brew reinstall --cask feishu-cursor-bridge
```

###### Q: `brew update` 时出现 `Warning: No remote 'origin'` 导致 tap 无法更新？

这是 Homebrew 本地 git 仓库的问题，需要手动修复：

```bash
# 删除损坏的 tap 并重新添加
brew untap lk-eternal/tap
brew tap lk-eternal/tap
```

如果 `untap` 报错 `Refusing to untap because it contains installed casks`，加上 `--force`：

```bash
brew untap --force lk-eternal/tap
brew tap lk-eternal/tap
brew upgrade --cask feishu-cursor-bridge
```

###### Q: 如何确认当前安装的版本？

```bash
brew info --cask feishu-cursor-bridge
```

输出中 `feishu-cursor-bridge: x.x.x` 即为 tap 中的最新版本，`Installed` 下方的路径显示本地已安装的版本。

###### Q: Apple Silicon (M1/M2/M3/M4) 和 Intel Mac 都支持吗？

是的，Cask 会自动根据芯片架构下载对应的 dmg：
- **Apple Silicon** → `*-arm64.dmg`
- **Intel** → `*.dmg`

###### Q: macOS 提示"无法打开，因为无法验证开发者"？

由于应用未经过 Apple 公证，首次打开时可能会被 Gatekeeper 拦截：

```bash
# 移除隔离属性
xattr -cr /Applications/Feishu\ Cursor\ Bridge.app
```

或者在「系统设置 → 隐私与安全性」中点击「仍要打开」。


## 快速开始

1. 下载安装并启动应用
2. 按照 5 步向导完成配置：
   - **飞书凭据**：填入 App ID / App Secret
   - **配置权限**：按引导在飞书后台开通权限和事件订阅
   - **绑定用户**：选择工作目录，在飞书私聊机器人完成绑定
   - **Cursor CLI**：检测 / 安装 CLI，选择模型
   - **检查启动**：一键保存、注入工作区并启动 Daemon
3. 在 Dashboard 查看运行状态，通过飞书开始协作

## MCP 工具

### 基础通信工具

| 工具 | 参数 | 说明 |
|------|------|------|
| `sync_message` | `message?`, `timeout_seconds?`, `message_id?`, `chat_id?` | 发送消息 / 等待回复，支持消息路由 |
| `send_image` | `image_path`, `message_id?`, `chat_id?` | 发送本地图片到飞书 |
| `send_file` | `file_path`, `message_id?`, `chat_id?` | 发送本地文件到飞书 |

### 自管理工具（应用版）

应用版额外提供一组管理工具，Agent 可通过这些工具管理自身运行环境：

| 工具 | 说明 |
|------|------|
| `manage_agent` | 查询状态、停止 Agent、重启应用、重置会话、清空队列 |
| `manage_mcp` | 管理 MCP 服务器配置（列出 / 添加 / 删除） |
| `manage_rules` | 管理 Cursor Rules 文件（列出 / 读取 / 保存 / 删除） |
| `manage_skills` | 管理 Agent Skills（列出 / 读取 / 保存 / 删除） |
| `manage_tasks` | 管理定时任务（列出 / 添加 / 更新 / 删除 / 切换启用） |
| `manage_workspace` | 查看或切换工作目录（切换后自动重启 Daemon） |
| `launch_temp_agent` | 启动独立临时 Agent 会话 |

## 指令系统

在飞书对话中直接发送指令（不区分大小写），由 Daemon 处理无需 Agent 运行：

| 指令 | 说明 |
|------|------|
| `/stop` | 停止运行中的 Agent |
| `/status` | 查看 Agent / Daemon 状态 |
| `/list` | 查看消息队列中的待处理消息 |
| `/task` | 定时任务管理（`/task ls` 列表、`/task trigger <id>` 手动触发） |
| `/run` | 启动一个独立临时 Agent 执行指定任务 |
| `/model` | Cursor CLI 模型（`/model ls` / `info` / `set <序号>`） |
| `/mcp` | MCP 服务器管理（`/mcp ls` / `info` / `enable` / `disable` / `add` / `delete`） |
| `/workspace` | 查看 / 切换工作目录 |
| `/clean` | 清空消息队列 |
| `/reset` | 重置会话（下次拉起不使用 --continue） |
| `/restart` | 停止 Agent → 清空队列 → 重启 Daemon |
| `/help` | 列出所有可用指令 |

## 多会话与自动重连

### 多会话模型

- **主用户私聊**：使用配置的工作目录，支持 `--resume` 延续会话上下文
- **群聊**：开启后响应 @消息，每个群自动创建隔离工作目录，空闲 30 分钟自动回收
- **定时任务**：按 Cron 表达式触发，支持独立 Agent 模式
- **临时 Agent**：通过 `/run` 指令启动，执行完毕自动退出

### 自动重连

Daemon 进程独立于 Cursor 运行，即使 Agent 会话中断，系统也能自动恢复：

1. **Daemon** 通过飞书 WebSocket 长连接持续监听消息
2. 当收到新的飞书消息且 Agent 已断开时，自动通过 Cursor CLI 拉起新会话
3. 支持 `--resume` 模式延续上一次会话上下文

## 设置页面

应用提供完整的可视化设置，包含以下模块：

| Tab | 功能 |
|-----|------|
| 通用 | 飞书凭据、主用户绑定、工作目录、数字身份、群聊开关、关闭行为、应用更新 |
| 网络 | HTTP/HTTPS 代理、NO_PROXY 配置 |
| Agent | 模型选择、会话模式（新建 / 延续） |
| MCP | MCP 服务器可视化管理（启停 / 编辑 / 认证 / 工具列表） |
| Rules | Cursor Rules 文件管理 |
| Skills | Agent Skills 文件树管理 |
| 定时任务 | Cron 任务编辑、运行预览、手动触发、状态监控 |
| 帮助引导 | 飞书权限/事件订阅配置参考、重新进入引导 |

## 飞书应用配置

1. 前往 [飞书开放平台](https://open.feishu.cn/app/) 创建自建应用
2. 获取 App ID 和 App Secret
3. 添加「机器人」能力
4. 在「权限管理」中开通以下权限：

| 权限标识 | 用途 |
|----------|------|
| `im:message` | 发送消息（create / reply） |
| `im:message.p2p_msg:readonly` | 接收私聊消息 |
| `im:message.group_at_msg:readonly` | 接收群聊 @消息 |
| `im:resource` | 上传/下载图片与文件 |
| `im:chat:read` | 获取群聊名称 |
| `contact:contact.base:readonly` | 获取用户名（私聊会话显示） |

<details>
<summary>批量导入权限 JSON</summary>

```json
{
  "scopes": {
    "tenant": [
      "im:message",
      "im:message.p2p_msg:readonly",
      "im:message.group_at_msg:readonly",
      "im:resource",
      "im:chat:read",
      "contact:contact.base:readonly"
    ],
    "user": []
  }
}
```

</details>

5. 在「事件订阅」中：
   - 选择 **「长连接」** 模式（无需配置回调 URL）
   - 添加 `im.message.receive_v1`（接收消息 v2.0）事件
   - 开通「读取用户发给机器人的单聊消息」
   - 开通「获取群组中用户@机器人消息」

   > **注意：** 配置事件订阅前需先启动 Daemon，否则飞书无法验证 WebSocket 连接。

6. 在「版本管理与发布」中发布应用

## 飞书全链路研发自动化

配合以下 MCP 服务，可实现从需求分析到代码交付的全链路自动化：

- **飞书文档 MCP**：读取 PRD、撰写技术方案、同步变更说明
  - 配置入口：[https://open.feishu.cn/page/mcp](https://open.feishu.cn/page/mcp)
- **飞书项目 MCP**：获取待办任务、更新工作项状态、生成进度报告
  - 配置入口：[https://project.feishu.cn/b/mcp](https://project.feishu.cn/b/mcp)

## 常见问题

<details>
<summary>Agent 会话为什么会断开？</summary>

常见原因：
- **上下文窗口超限**：超长会话会被自动截断，建议复杂任务拆分或使用 `.cursor/memory.md` 持久化关键信息
- **工具调用过多**：单次会话中工具调用次数过多可能触发 Cursor 安全机制
- **网络波动**：本地网络不稳定可能导致 MCP stdio 通信中断
- **Cursor 更新/重启**：IDE 自动更新会中断当前会话

> 应用可在 Agent 断开后自动拉起新会话。

</details>

<details>
<summary>为什么飞书收不到消息？</summary>

请按顺序排查：
1. 确认添加了 `im.message.receive_v1` 事件订阅，且选择「长连接」模式
2. 确认已开通「读取用户发给机器人的单聊消息」和「获取群组中用户@机器人消息」
3. 确认应用已发布（未发布的应用无法接收消息）
4. 确认所有 6 个权限已添加并发布
5. 确认 Daemon 已启动且飞书 WebSocket 连接成功
6. 确认是在机器人私聊窗口或群聊 @机器人 发送消息

</details>

<details>
<summary>定时任务需要电脑一直开着吗？</summary>

是的，但可以锁屏或关闭显示器。定时任务由应用调度，需要应用保持运行。关闭窗口后应用会最小化到系统托盘继续运行，但完全退出或关机后定时任务不会触发。

</details>

<details>
<summary>群聊消息如何路由？</summary>

每个群聊会创建独立的 Agent 会话和工作目录。消息通过 `chat_id` 路由到对应会话，Agent 回复时需携带 `message_id` 或 `chat_id` 以确保消息发送到正确的群。群聊会话空闲 30 分钟后自动回收。

</details>

## 注意事项

- **凭据安全**：App Secret 是敏感信息，应用会加密存储
- **网络要求**：Daemon 需保持与飞书服务器的网络连接，企业网络如有代理限制，可在设置中配置代理
- **Cursor CLI 依赖**：自动拉起 Agent 功能依赖 Cursor CLI，可在向导中一键安装

## 开发

```bash
# 安装依赖
npm install

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
