# Channel 集成方案 — 方案 B：直接 SDK 集成

> 调研日期：2026-05-24
> 状态：调研完成，待确认

## 一、方案概述

不引入 OpenClaw/Hermes 中间层，直接使用钉钉/飞书官方 SDK 在 WFM Studio 中实现 Channel 能力。

## 二、现有架构

```
用户 (IDE Chat UI)
  → Electron IPC (ProxyChannel)
    → wfmClaudeMainService (Main Process)
      → spawn claude CLI (child_process, stdio NDJSON)
        → wfm_mcp_server.py (MCP tools, 25个工具)
  ← events 流回渲染
```

关键约束：
- 无 HTTP/WebSocket 层，所有通信是 stdio + Electron IPC
- Claude CLI 按 turn spawn，非长驻进程
- MCP server 是 Python，运行在 Claude CLI 子进程中
- 会话连续性靠 `--resume <sessionId>` 实现

## 三、SDK 可行性

| 维度 | 钉钉 `dingtalk-stream-sdk-nodejs` | 飞书 `@larksuiteoapi/node-sdk` |
|------|----------------------------------|-------------------------------|
| 协议 | WebSocket Stream（无需公网 IP） | WSClient WebSocket 长连接（无需公网 IP） |
| 消息接收 | 注册 bot 回调，收到即触发 | EventDispatcher 注册 `im.message.receive_v1` |
| 消息发送 | 钉钉 API 发送文本/Markdown/卡片 | `client.im.message.create()` |
| 流式回复 | 支持 AI 流式卡片 | 支持 Interactive Card 流式更新 |
| 文件收发 | 支持 | 支持 |
| 技术栈 | TypeScript/Node.js | TypeScript/Node.js |
| 成熟度 | 官方 MIT，v2.1.6 | 官方 MIT，高频更新 |
| 接入代码量 | ~200 行 adapter | ~200 行 adapter |

## 四、推荐架构（4 层）

```
┌─────────────────────────────────────────────────┐
│  Layer 4: IM Channels                           │
│  ┌──────────────┐  ┌──────────────┐            │
│  │   钉钉 Bot    │  │   飞书 Bot    │            │
│  └──────┬───────┘  └──────┬───────┘            │
│         │                  │                    │
│  Layer 3: Channel Gateway (Node.js 长驻进程)     │
│  ┌─────────────────────────────────────────┐    │
│  │  - 统一消息格式 (ChannelMessage)          │    │
│  │  - 会话管理 (per-user session)           │    │
│  │  - 并发控制 (per-user queue)             │    │
│  └────────────────┬────────────────────────┘    │
│                   │                              │
│  Layer 2: Claude Bridge                         │
│  ┌─────────────────────────────────────────┐    │
│  │  spawn claude CLI per message/turn       │    │
│  │  --output-format stream-json             │    │
│  │  --resume <sessionId> (会话连续性)        │    │
│  │  --mcp-config (指向 wfm_mcp_server.py)   │    │
│  │  解析 NDJSON → 流式文本/工具事件          │    │
│  └────────────────┬────────────────────────┘    │
│                   │                              │
│  Layer 1: MCP Tools (Python)                    │
│  ┌─────────────────────────────────────────┐    │
│  │  wfm_mcp_server.py (25 existing tools)   │    │
│  │  + 新增 channel 通知类工具 (可选)         │    │
│  └─────────────────────────────────────────┘    │
└─────────────────────────────────────────────────┘
```

## 五、实施计划

### Phase 1: Channel Gateway 基础框架（3-4 天）

新增模块：
```
wfm-agents/
  channel/
    package.json
    src/
      gateway.ts          ← 入口
      types.ts            ← 统一消息类型
      claudeBridge.ts     ← Claude CLI 桥接
      sessionManager.ts   ← 用户会话管理
      channels/
        channelAdapter.ts ← 抽象接口
        dingtalk/
          adapter.ts
        feishu/
          adapter.ts
```

Claude Bridge 核心逻辑：
1. sessionManager.getOrCreate(userId) → { sessionId? }
2. 构建 claude CLI 参数: `claude -p "<text>" --output-format stream-json --verbose --mcp-config <JSON> --model sonnet [--resume <sessionId>]`
3. spawn child_process，逐行解析 NDJSON
4. AsyncIterable<StreamEvent> → 推送到 Channel Adapter 回复

### Phase 2: 钉钉 Channel 对接（2-3 天）

1. 钉钉开放平台创建企业内部应用 → AppKey/AppSecret
2. 开通机器人 → Stream 模式
3. dingtalk-stream-sdk-nodejs 建立 WebSocket 连接
4. 收到消息 → ChannelMessage → claudeBridge.runTurn()
5. 流式回复 → 钉钉 AI Stream Card

会话管理：per-user session, Idle 30 分钟自动重置, 消息排队处理

### Phase 3: 飞书 Channel 对接（2-3 天）

1. 飞书开放平台创建自建应用 → App ID/App Secret
2. 添加机器人 → WebSocket 事件订阅
3. @larksuiteoapi/node-sdk WSClient 建立长连接
4. EventDispatcher 注册 im.message.receive_v1
5. 流式回复 → Interactive Card streaming

### Phase 4: MCP 工具增强 + IDE 联动（3-5 天，可选）

- MCP Tool: `channel_send_message`（Claude 主动推送到 IM）
- IDE 设置面板 Channel 配置 UI
- IM 对话同步到 IDE Chat 历史
- 权限安全（用户白名单、DM Pairing、@bot 响应）

## 六、可行性评估

| 维度 | 评估 | 说明 |
|------|------|------|
| 技术可行性 | 高 | SDK 官方维护、TypeScript 原生、无需公网 IP |
| 架构契合度 | 中高 | Claude CLI 的 --resume 和 stream-json 天然支持 |
| 工作量 | 10-15 天 | Phase 1-3 核心，Phase 4 可选 |
| 维护成本 | 低 | 独立进程，不影响现有 IDE 架构 |
| 扩展性 | 好 | Adapter 接口统一，后续加企微/Telegram 只需新增 adapter |
| 风险点 | 会话管理 | sessionId 持久化；多用户并发队列控制 |

## 七、与其他方案对比

| 维度 | 方案 A (双引擎转发) | 方案 B (直接集成) | 方案 C (Gateway 管道) |
|------|-------------------|------------------|----------------------|
| 新依赖 | OpenClaw/Hermes 全套 | 2 个轻量 SDK (~5MB) | OpenClaw/Hermes Gateway |
| LLM 成本 | 双引擎双倍 | 单引擎 | 单引擎但需魔改 |
| 延迟 | 多一跳 | 最低 | 中等 |
| 实现复杂度 | 高 | 中 | 高 |
| 可控性 | 低 | 高 | 中 |

## 八、前置条件

1. 钉钉开放平台 — 创建企业内部应用，获取 AppKey + AppSecret，开通机器人 Stream 模式
2. 飞书开放平台 — 创建自建应用，获取 App ID + App Secret，添加机器人 + WebSocket 事件订阅
3. Claude CLI 环境可用（已满足）
4. wfm-agents Python 环境可见（已满足）

## 参考资料

- [OpenClaw Gateway Architecture](https://docs.openclaw.ai/concepts/architecture)
- [OpenClaw Feishu Channel](https://docs.openclaw.ai/channels/feishu)
- [Hermes Messaging Gateway](https://hermes-agent.nousresearch.com/docs/user-guide/messaging/)
- [dingtalk-stream-sdk-nodejs](https://github.com/open-dingtalk/dingtalk-stream-sdk-nodejs)
- [@larksuiteoapi/node-sdk](https://github.com/larksuite/node-sdk)
- [钉钉 Stream 模式教程](https://open-dingtalk.github.io/developerpedia/docs/explore/tutorials/stream/bot/nodejs/build-bot)
- [飞书 WebSocket 事件订阅](https://open.feishu.cn/document/server-docs/event-subscription-guide/event-subscription-configure-/request-url-configuration-case)
- [Hermes 接入飞书/企业微信/钉钉教程](https://cloud.tencent.com/developer/article/2654156)
