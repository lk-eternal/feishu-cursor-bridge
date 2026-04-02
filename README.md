# Feishu Cursor Bridge

飞书 × Cursor 远程协作桌面应用 —— 让 AI 编程助手通过飞书与你实时沟通，人不在电脑旁也能远程协作。

## 为什么需要它？

当你使用 Cursor 编程时，AI Agent 经常需要你确认方案或回答问题。如果你不在电脑旁，Agent 只能干等。

**Feishu Cursor Bridge** 解决了这个问题：

- AI 的提问会通过飞书机器人发到你手机上
- 你在飞书回复后，AI 自动继续工作
- 即使 Cursor 会话断开，守护进程也能自动重连
- 支持定时任务，让 AI 按计划执行工作

## 功能特性

| 功能 | 说明 |
|------|------|
| 可视化配置 | 首次使用向导 + 设置页面，无需手写配置文件 |
| 一键启停 | 控制台一键管理守护进程生命周期 |
| 消息桥接 | AI 通过飞书发消息、发图片、发文件，你在飞书回复 |
| 自动重连 | Agent 断开后，收到飞书消息自动拉起新会话 |
| 指令系统 | 飞书发送 `/stop` `/status` `/restart` 等指令直接控制 |
| 定时任务 | Cron 表达式调度，定时给 AI 下达指令 |
| MCP 管理 | 可视化管理 MCP 服务器配置（JSON 编辑），支持 OAuth 认证 |
| Rule & Skill | 管理 Cursor Rules 和 Agent Skills 文件 |
| 系统托盘 | 关闭窗口自动最小化到托盘，后台持续运行 |

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
│  · 看门狗（自动拉起Agent）│    └──────────────┬──────────────┘
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

### 桌面版（推荐）

从 [Releases](../../releases) 页面下载对应平台的安装包：

| 平台 | 格式 | 备注 |
|------|------|------|
| Windows | `.exe` | 直接运行安装 |
| macOS (Intel) | `.dmg` | 首次打开需解除 Gatekeeper（见下方） |
| macOS (Apple Silicon) | `.dmg` | 首次打开需解除 Gatekeeper（见下方） |
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

由于应用尚未经过 Apple 签名，macOS Gatekeeper 会拦截首次启动。选择以下任一方式解决：

**方式一：命令行解除（推荐）**

```bash
xattr -cr /Applications/Feishu\ Cursor\ Bridge.app
```

**方式二：系统设置**

打开 **系统设置 → 隐私与安全性**，找到被阻止的应用，点击"仍然打开"。

### Lite 版（纯 MCP，无 GUI）

如果不需要桌面界面，可以直接在 Cursor 中配置 MCP Server：

```json
{
  "mcpServers": {
    "lark-bridge": {
      "command": "npx",
      "args": ["-y", "lark-bridge-mcp"],
      "env": {
        "LARK_APP_ID": "你的 App ID",
        "LARK_APP_SECRET": "你的 App Secret"
      }
    }
  }
}
```

> Lite 版首次使用需要在飞书私聊机器人发一条消息以自动识别身份。

## 快速开始

### 桌面版

1. 下载安装并启动应用
2. 按照向导填入飞书 App ID / App Secret
3. 配置消息接收者（支持自动识别、open_id、邮箱、手机号）
4. 选择 Cursor 工作目录，应用会自动注入 MCP 配置和 Rules
5. 在 Dashboard 启动 Daemon，开始使用

### Lite 版

#### 方式一：零配置（推荐新手）

只需 App ID 和 App Secret，首次在飞书私聊机器人发一条消息即可自动识别身份：

```json
{
  "mcpServers": {
    "lark-bridge": {
      "command": "npx",
      "args": ["-y", "lark-bridge-mcp"],
      "env": {
        "LARK_APP_ID": "你的 App ID",
        "LARK_APP_SECRET": "你的 App Secret"
      }
    }
  }
}
```

#### 方式二：固定用户（推荐日常使用）

```json
{
  "mcpServers": {
    "lark-bridge": {
      "command": "npx",
      "args": ["-y", "lark-bridge-mcp"],
      "env": {
        "LARK_APP_ID": "你的 App ID",
        "LARK_APP_SECRET": "你的 App Secret",
        "LARK_RECEIVE_ID": "ou_xxxxxxxxxxxxxx",
        "LARK_RECEIVE_ID_TYPE": "open_id"
      }
    }
  }
}
```

#### 方式三：邮箱 / 手机号

**邮箱**（需要 `contact:user.email:readonly` 权限）：

```json
"env": {
  "LARK_APP_ID": "你的 App ID",
  "LARK_APP_SECRET": "你的 App Secret",
  "LARK_RECEIVE_ID": "your@company.com",
  "LARK_RECEIVE_ID_TYPE": "email"
}
```

**手机号**（需要 `contact:user.phone:readonly` 权限）：

```json
"env": {
  "LARK_APP_ID": "你的 App ID",
  "LARK_APP_SECRET": "你的 App Secret",
  "LARK_RECEIVE_ID": "13800138000",
  "LARK_RECEIVE_ID_TYPE": "mobile"
}
```

## 环境变量（Lite 版）

| 变量 | 必填 | 说明 |
|------|------|------|
| `LARK_APP_ID` | 是 | 飞书应用 App ID |
| `LARK_APP_SECRET` | 是 | 飞书应用 App Secret |
| `LARK_RECEIVE_ID` | 否 | 消息接收者标识（不填则自动从首条消息获取） |
| `LARK_RECEIVE_ID_TYPE` | 否 | ID 类型：`open_id` / `user_id` / `union_id` / `chat_id` / `email` / `mobile` |
| `LARK_ENCRYPT_KEY` | 否 | 事件加密密钥（长连接模式通常不需要） |
| `LARK_MESSAGE_PREFIX` | 否 | 发送消息前缀 |

## MCP 工具

桌面版和 Lite 版提供相同的 MCP 工具集：

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

> 指令消息会从普通消息中隔离，不会触发 Agent 启动，也不会进入消息队列。

## 看门狗：自动重连

当 Cursor Agent 因网络中断或其他原因断开时，看门狗会自动检测并重新拉起会话。

**工作原理：**

1. **Daemon** 维持飞书 WebSocket 长连接，不依赖 Cursor 进程
2. **MCP Server** 每 15 秒向 Daemon 发送心跳
3. 心跳超时（默认 120 秒）时，Daemon 判定 Agent 已断开
4. 收到用户飞书消息且 Agent 已断开时，通过 Cursor CLI 自动拉起新会话

> 自动拉起需要安装 Cursor CLI（`agent` 命令）。桌面版可在 Dashboard 一键安装。

## 飞书应用配置

1. 前往 [飞书开放平台](https://open.feishu.cn/app/) 创建自建应用
2. 获取 App ID 和 App Secret
3. 添加「机器人」能力
4. 在「权限管理」中开通权限：
   - **必须**：`im:message`（获取与发送单聊、群组消息）
   - **必须**：`im:message.p2p_msg:readonly`（获取用户发给机器人的单聊消息）
   - **必须**：`im:resource`（获取与上传图片或文件资源）
   - *可选*：`contact:user.id:readonly`（通过邮箱/手机号查找用户）
5. 在「事件与回调」中选择「使用长连接」，添加 `im.message.receive_v1` 事件
6. 在「版本管理与发布」中发布应用

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
