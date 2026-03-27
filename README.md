# lark-bridge-mcp

飞书/Lark MCP Server —— 让 AI 编程工具（Cursor、Claude Desktop 等）通过飞书机器人与你实时沟通。

你不在电脑旁时，AI 可以通过飞书给你发消息、等你回复后继续工作。

## 功能

| 工具 | 说明 |
|------|------|
| `ask_user` | 通过飞书向用户提问并等待回复。支持轮询模式：prompt 为空时仅检查新回复，不发送消息 |
| `send_message` | 通过飞书机器人发送通知（不等待回复） |

## 安装

```bash
npm install -g lark-bridge-mcp
```

或直接通过 npx 使用（推荐）：

```bash
npx lark-bridge-mcp
```

## 快速开始

### 方式一：零配置（推荐新手）

只需要 APP_ID 和 APP_SECRET，首次使用时在飞书私聊机器人发一条消息即可自动识别身份：

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

启动后在飞书找到你的机器人，私聊发一条消息。程序会自动记录你的 `open_id`，日志中会打印出来，可以保存下来用于方式二。

### 方式二：固定用户（推荐日常使用）

用从方式一获取到的 `open_id` 固定配置，重启后无需再发消息激活：

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

### 方式三：邮箱/手机号查找用户

如果飞书应用开通了通讯录权限，可以直接用企业邮箱或手机号：

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

## 环境变量

| 变量 | 必填 | 说明 |
|------|------|------|
| `LARK_APP_ID` | ✅ | 飞书应用的 App ID |
| `LARK_APP_SECRET` | ✅ | 飞书应用的 App Secret |
| `LARK_RECEIVE_ID` | 可选 | 消息接收者标识（不填则自动从首条消息获取） |
| `LARK_RECEIVE_ID_TYPE` | 可选 | ID 类型：`open_id` / `user_id` / `union_id` / `chat_id` / `email` / `mobile`，不填则自动推断 |
| `LARK_ENCRYPT_KEY` | 可选 | 事件加密密钥（长连接模式通常不需要） |
| `LARK_WAIT_TIMEOUT_SECONDS` | 可选 | `ask_user` 单次等待超时（秒），默认 `60` |
| `LARK_MESSAGE_PREFIX` | 可选 | 发送消息前缀，默认空 |
| `LARK_DAEMON_PORT` | 可选 | 守护进程 HTTP 端口，默认自动分配 |
| `LARK_HEARTBEAT_TIMEOUT_MS` | 可选 | 心跳超时（毫秒），超过此时间认为 Agent 已断开，默认 `120000` |
| `LARK_RELAUNCH_COOLDOWN_MS` | 可选 | 重新拉起 Agent 的冷却时间（毫秒），默认 `30000` |

## 看门狗：自动重连 Cursor 会话

当 Cursor Agent 因网络中断或工具调用过多等原因断开时，看门狗会自动检测并重新拉起会话。

### 工作原理

MCP Server 启动时会自动 fork 一个独立的**守护进程 (daemon)**：

- **守护进程**：维持飞书 WebSocket 长连接，不依赖 Cursor 进程。即使 Cursor 断开，飞书消息仍然能收到
- **心跳机制**：MCP Server 每 15 秒向 daemon 发送心跳。如果心跳超时（默认 120 秒），daemon 判定 Agent 已断开
- **自动拉起**：当收到用户飞书消息且 Agent 已断开时，通过 Cursor CLI (`agent`) 自动拉起新会话，优先恢复上一个 session

```
┌──────────────────────────────────────────────────────────┐
│            lark-bridge-daemon (独立守护进程)                │
│                                                           │
│  ┌──────────────────┐  ┌───────────────────────────────┐ │
│  │ Lark WebSocket   │  │ HTTP Server (localhost)       │ │
│  │ (飞书长连接)      │  │  /send  /ask  /heartbeat     │ │
│  │ 永不中断          │  │  供 MCP Server 调用           │ │
│  └────────┬─────────┘  └──────────┬────────────────────┘ │
│           │     消息队列           │                      │
│           └───────────────────────┘                      │
│                                                           │
│  ┌──────────────────────────────────────────────────────┐ │
│  │ 看门狗: 心跳超时 + 收到飞书消息 → CLI 拉起 Agent     │ │
│  └──────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────┘
         ↕ HTTP (localhost)
┌──────────────────────┐
│ lark-bridge-mcp      │  ← Cursor 子进程
│ (MCP Server, stdio)  │
│ 定时心跳 → daemon    │
└──────────────────────┘
```

### 前提条件

需要安装 Cursor CLI Agent（`agent` 命令）。安装方法参考 [Cursor CLI 文档](https://cursor.com/docs/cli/overview)。

### 手动启动守护进程（可选）

通常无需手动启动，MCP Server 会自动管理。如果需要手动启动：

```bash
npx lark-bridge-daemon
```

## ask_user 工作模式

`ask_user` 支持两种调用方式，配合使用可以实现「发一次问题、持续轮询回复」的交互模式：

| 调用方式 | 行为 |
|---------|------|
| `ask_user(prompt="你的问题")` | 发送消息并等待回复，超时返回 `[waiting]` |
| `ask_user(prompt="")` | 仅检查新回复，不发送任何消息 |

**推荐流程：**

```
1. ask_user(prompt="请确认是否继续？")    → 发送问题
2. 如果返回 [waiting]                   → 用户还没回复
3. ask_user(prompt="")                  → 轮询检查（不打扰用户）
4. 重复步骤 3 直到收到回复
```

## 飞书应用配置

1. 前往 [飞书开放平台](https://open.feishu.cn/app/) 创建自建应用
2. 获取 App ID 和 App Secret
3. 添加「机器人」能力
4. 在「权限管理」中开通权限：
   - **必须**：`im:message`（获取与发送单聊、群组消息）
   - **必须**：`im:message.p2p_msg:readonly`（获取用户发给机器人的单聊消息）
   - *可选*：`contact:user.email:readonly`（通过邮箱查找用户，方式三需要）
   - *可选*：`contact:user.phone:readonly`（通过手机号查找用户，方式三需要）
5. 在「事件与回调」中选择「使用长连接」，添加 `im.message.receive_v1` 事件
6. 在「版本管理与发布」中发布应用

## 架构

详见上方「看门狗：自动重连 Cursor 会话」章节的架构图。

## License

MIT
