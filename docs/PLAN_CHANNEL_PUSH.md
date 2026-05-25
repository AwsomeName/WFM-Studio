# Channel Push 方案 — 场景 1 & 2 详细设计

> 日期：2026-05-24
> 状态：方案设计
> 关联文档：[PLAN_CHANNEL_INTEGRATION.md](./PLAN_CHANNEL_INTEGRATION.md)

## 一、两个场景定义

### 场景 1：文件投递 + 审核请求

```
工程师在 IDE Chat 中:
  "把 cad_review_report.docx 发给张工，请他审核钢板图纸"

Claude Code 执行:
  1. workspace_read 找到文件
  2. 查联系人配置，解析"张工" → 钉钉 userId / 飞书 open_id
  3. 上传文件到钉钉/飞书平台
  4. 发送消息: "[WFM Studio] 工程师请求审核 cad_review_report.docx ..."
  5. 张工在钉钉/飞书收到文件 + 审核请求

Claude 回复:
  "已发送给张工(钉钉)。文件: cad_review_report.docx，附审核请求。"
```

### 场景 2：异步任务完成通知

```
工程师在 IDE Chat 中:
  "批量审核这 50 张图纸"
  ... 工程师去开会了 ...
  AI 完成后主动推送:

钉钉/飞书收到:
  "[WFM Studio] 批量审核完成
   ✅ 通过: 45 张
   ❌ 有问题: 5 张
   📁 报告已生成: batch_review_report.docx"
```

---

## 二、架构决策：纯 MCP Tool，无需 Gateway

### 为什么不需要 Gateway？

两个场景都是 **单向推送（IDE → IM）**：
- 不需要接收 IM 消息（不需要 WebSocket 长连接）
- 不需要 IM 端发起对话（不需要 Stream 模式）
- 只需要 Claude Code 能调 API 发消息出去

因此：
- **不需要** 长驻 Node.js Gateway 进程
- **不需要** `dingtalk-stream-sdk-nodejs` / `@larksuiteoapi/node-sdk`
- **不需要** WebSocket / Stream 模式
- **只需要** 在现有 `wfm_mcp_server.py` 中增加几个 MCP Tool

### 架构对比

```
之前设想的完整方案（双向通道）：
  IM ←WebSocket→ Node.js Gateway ←spawn→ Claude CLI ←stdio→ MCP Server
  需要: 长驻进程 + SDK + 会话管理 + 10-15天

现在的轻量方案（单向推送）：
  Claude CLI ←stdio→ MCP Server (Python) ──HTTP──→ 钉钉/飞书 API
  需要: 3个 MCP Tool + HTTP 请求 + 3-5天
```

---

## 三、新增 MCP Tool 设计

### Tool 1: `channel_send_file`

**用途：** 场景 1 核心工具。发送文件到钉钉/飞书用户或群聊。

```
参数:
  - platform: "dingtalk" | "feishu"    (必填，目标平台)
  - file_path: str                     (必填，workspace 内文件路径)
  - target: str                        (必填，联系人名称/ID 或群名)
  - message: str                       (可选，附带消息，如审核请求说明)

流程:
  1. _resolve_path(file_path) → 验证文件存在
  2. resolve_contact(platform, target) → 获取 userId/open_id/chat_id
  3. get_access_token(platform) → 获取/刷新 token
  4. upload_file(platform, file_path) → 获取 media_id/file_key
  5. send_file_message(platform, user_id, media_id, message)

返回: "已通过{platform}发送文件 {filename} 给 {target_name}"
```

### Tool 2: `channel_send_message`

**用途：** 场景 2 核心工具。发送文本/Markdown 消息（通知、报告摘要等）。

```
参数:
  - platform: "dingtalk" | "feishu"
  - target: str                         (联系人名称/ID 或群名)
  - content: str                        (消息内容，支持 Markdown)
  - msg_type: "text" | "markdown"       (默认 "markdown")

流程:
  1. resolve_contact(platform, target) → userId/open_id/chat_id
  2. get_access_token(platform) → token
  3. send_message(platform, user_id, content, msg_type)

返回: "已通过{platform}发送消息给 {target_name}"
```

### Tool 3: `channel_notify_me`

**用途：** 场景 2 的快捷方式——通知"我自己"。不需要指定 target，自动发给配置的默认用户。

```
参数:
  - content: str           (消息内容)
  - platform: str          (可选，默认用首选平台)

流程:
  1. 读取配置中的 default_notify_target
  2. 等同于 channel_send_message(platform, default_target, content, "markdown")

返回: "已发送通知"
```

---

## 四、联系人解析策略

这是场景 1 的核心难题：用户说"发给张工"，系统怎么知道张工是谁？

### 方案：Workspace 联系人配置文件

在 workspace 根目录放置 `.wfm/contacts.json`：

```json
{
  "contacts": [
    {
      "name": "张工",
      "aliases": ["张明", "老张", "zhangming"],
      "dingtalk": { "user_id": "xxx", "name": "张明" },
      "feishu": { "open_id": "ou_xxx", "name": "张明" }
    },
    {
      "name": "项目群",
      "aliases": ["项目组", "造船项目"],
      "dingtalk": { "chat_id": "cid_xxx", "name": "XX造船项目群" },
      "feishu": { "chat_id": "oc_xxx", "name": "XX造船项目群" }
    }
  ],
  "default_notify_target": {
    "platform": "dingtalk",
    "name": "我自己",
    "dingtalk": { "user_id": "yyy" }
  }
}
```

**解析规则（优先级从高到低）：**
1. 精确匹配 `name` 字段
2. 模糊匹配 `aliases` 数组
3. 如果 target 看起来像 ID（`ou_xxx` / `cid_xxx` / 纯数字），直接用作 ID
4. 匹配不到 → 返回错误 + 提示用户补充联系人

**不需要实时查询钉钉/飞书通讯录 API。** 联系人配置文件由用户或管理员手动维护，避免权限申请复杂度。

---

## 五、API 调用细节

### 5.1 Token 管理

两个平台都需要 access_token，有效期 2 小时，需要缓存和自动刷新。

```
wfm_agents/channel/token_manager.py:

class TokenManager:
    _tokens: dict[str, TokenEntry]  # {platform: {token, expires_at}}

    def get_token(platform: str) -> str:
        if cached and not expired:
            return cached.token
        return refresh(platform)

    def refresh(platform: str) -> str:
        if platform == "dingtalk":
            POST https://api.dingtalk.com/v1.0/oauth2/accessToken
            body: { appKey, appSecret }
            → access_token (有效期 7200s)

        if platform == "feishu":
            POST https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal
            body: { app_id, app_secret }
            → tenant_access_token (有效期 7200s)
```

**凭据存储位置：** workspace 根目录 `.wfm/channel_credentials.json`

```json
{
  "dingtalk": {
    "app_key": "dingxxx",
    "app_secret": "xxx"
  },
  "feishu": {
    "app_id": "cli_xxx",
    "app_secret": "xxx"
  }
}
```

> 注意：app_secret 是敏感信息，应加入 `.gitignore`

### 5.2 钉钉 API 调用链

#### 发送文本/Markdown 消息（场景 2）

```
API: POST https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend
Headers: x-acs-dingtalk-access-token: {token}
Body:
{
  "robot_code": "{app_key}",
  "user_ids": ["{user_id}"],
  "msg_key": "sampleMarkdown",         ← Markdown 类型
  "msg_param": {
    "title": "WFM Studio 通知",
    "text": "## 批量审核完成\n✅ 通过: 45 张\n❌ 有问题: 5 张"
  }
}
```

文本类型: `msg_key: "sampleText"`, `msg_param: {"content": "..."}`

#### 上传文件 + 发送文件消息（场景 1）

**Step 1: 上传媒体文件**

```
API: POST https://oapi.dingtalk.com/media/upload?access_token={token}
Content-Type: multipart/form-data
Body: type=file, media=@/path/to/file.docx
→ { media_id: "xxx" }
```

支持格式：xlsx, pdf, zip, rar, doc, docx

**Step 2: 发送文件消息**

```
API: POST https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend
Headers: x-acs-dingtalk-access-token: {token}
Body:
{
  "robot_code": "{app_key}",
  "user_ids": ["{user_id}"],
  "msg_key": "sampleFile",
  "msg_param": {
    "mediaId": "{media_id}",
    "fileName": "cad_review_report.docx",
    "fileType": "docx"
  }
}
```

#### 发送群聊消息

```
API: POST https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend
（单聊和群聊使用同一个接口，user_ids 改为群 chat_id 对应的 userId 列表即可）

或群机器人 Webhook:
POST {webhook_url}
Body: { msgtype: "markdown", markdown: { title: "...", text: "..." } }
```

### 5.3 飞书 API 调用链

#### 发送文本/Markdown 消息（场景 2）

```
API: POST https://open.feishu.cn/open-apis/im/v1/messages
    ?receive_id_type=open_id
Headers: Authorization: Bearer {tenant_access_token}
Body:
{
  "receive_id": "{open_id}",
  "msg_type": "text",
  "content": "{\"text\": \"批量审核完成: 45/50 通过\"}"
}
```

飞书消息卡片（更美观的 Markdown）:

```
msg_type: "interactive"
content: {
  "config": { "wide_screen_mode": true },
  "header": { "title": { "content": "WFM Studio 通知", "tag": "plain_text" } },
  "elements": [
    { "tag": "markdown", "content": "## 批量审核完成\n✅ 通过: 45 张\n❌ 有问题: 5 张" }
  ]
}
```

#### 上传文件 + 发送文件消息（场景 1）

**Step 1: 上传文件**

```
API: POST https://open.feishu.cn/open-apis/im/v1/files
Headers: Authorization: Bearer {tenant_access_token}
Content-Type: multipart/form-data
Body: file_type=file, file_name=cad_review_report.docx, file=@/path/to/file.docx
→ { file_key: "file_v2_xxx" }
```

支持格式：所有常见文件类型

**Step 2: 发送文件消息**

```
API: POST https://open.feishu.cn/open-apis/im/v1/messages
    ?receive_id_type=open_id
Body:
{
  "receive_id": "{open_id}",
  "msg_type": "file",
  "content": "{\"file_key\": \"file_v2_xxx\"}"
}
```

---

## 六、代码结构

```
wfm-agents/wfm_agents/
  channel/                              ← 新增模块
    __init__.py
    config.py                           ← 凭据加载、联系人配置解析
    token_manager.py                    ← access_token 获取/缓存/刷新
    contacts.py                         ← 联系人解析（从 contacts.json 查找）
    dingtalk_client.py                  ← 钉钉 API 封装（发送消息、上传文件）
    feishu_client.py                    ← 飞书 API 封装（发送消息、上传文件）
    dispatcher.py                       ← 统一调度：按 platform 路由到对应 client

  agent_v2/
    wfm_mcp_server.py                   ← 在此文件新增 3 个 @mcp.tool()
```

**新增依赖（pyproject.toml）：**
```
dependencies = [
    ...existing...,
    "httpx>=0.27",        ← HTTP 客户端（用于调钉钉/飞书 API）
]
```

不需要钉钉/飞书的 Python SDK。直接用 httpx 调 REST API 即可，因为：
- 只需要 4-5 个 API 端点
- SDK 会拉入大量不需要的依赖
- 直接调 API 更透明、更容易调试

---

## 七、MCP Tool 注册方式

在 `wfm_mcp_server.py` 中新增：

```python
# ── Channel push tools ──────────────────────────────────────────────

@mcp.tool()
def channel_send_file(
    platform: str,       # "dingtalk" | "feishu"
    file_path: str,      # workspace 内文件路径
    target: str,         # 联系人名称或 ID
    message: str = "",   # 附带消息
) -> str:
    """Send a file to a DingTalk/Feishu user or group via IM bot.
    ..."""

@mcp.tool()
def channel_send_message(
    platform: str,
    target: str,
    content: str,
    msg_type: str = "markdown",
) -> str:
    """Send a text/markdown message to a DingTalk/Feishu user or group.
    ..."""

@mcp.tool()
def channel_notify_me(
    content: str,
    platform: str = "",
) -> str:
    """Send a notification to the configured default user.
    ..."""
```

Claude Code 在对话中会自动识别这些工具。用户说"把XX发给张工"时，Claude 会自动：
1. 调 `workspace_read` 或直接构造路径
2. 调 `channel_send_file(platform="dingtalk", file_path="...", target="张工", message="请审核")`

---

## 八、配置管理

### Workspace 配置结构

```
{workspace_root}/
  .wfm/
    contacts.json              ← 联系人映射表
    channel_credentials.json   ← API 凭据（需 .gitignore）
```

### contacts.json Schema

```json
{
  "contacts": [
    {
      "name": "显示名",
      "aliases": ["别名1", "别名2"],
      "dingtalk": { "user_id": "xxx" },
      "feishu": { "open_id": "ou_xxx" }
    }
  ],
  "default_notify_target": {
    "platform": "dingtalk",
    "name": "我自己",
    "dingtalk": { "user_id": "yyy" }
  }
}
```

### channel_credentials.json Schema

```json
{
  "dingtalk": {
    "app_key": "dingxxx",
    "app_secret": "xxx",
    "robot_code": "dingxxx"
  },
  "feishu": {
    "app_id": "cli_xxx",
    "app_secret": "xxx"
  }
}
```

---

## 九、安全考虑

1. **凭据隔离：** `channel_credentials.json` 加入 workspace 的 `.gitignore`
2. **文件沙箱：** 只能发送 `workspace_read` 可访问的文件（复用 `_resolve_path` 沙箱检查）
3. **发送限流：** 钉钉机器人单聊 50条/分钟，飞书默认 50条/分钟。MCP Tool 层面无需限流，由平台侧控制
4. **联系人白名单：** 只能发给 `contacts.json` 中已配置的联系人，防止误发
5. **敏感文件：** Claude Code 的 `--permission-mode` 和 MCP 的沙箱机制已提供文件访问控制

---

## 十、前置条件（钉钉/飞书平台侧）

### 钉钉

| 步骤 | 操作 | 产出 |
|------|------|------|
| 1 | 钉钉开放平台创建企业内部应用 | AppKey + AppSecret |
| 2 | 应用能力 → 添加"机器人"能力 | robot_code = AppKey |
| 3 | 机器人消息接收模式 → 选 HTTP 或 Stream 均可（我们只发不收） | - |
| 4 | 权限管理 → 申请 `Robot_oToMessages_batachesSend` 等权限 | API 调用权限 |
| 5 | 发布应用 | 机器人上线 |

> **注意：** 场景 1/2 只需要机器人 **发消息** 能力，不需要接收消息。所以消息接收模式无所谓。

### 飞书

| 步骤 | 操作 | 产出 |
|------|------|------|
| 1 | 飞书开放平台创建自建应用 | App ID + App Secret |
| 2 | 添加"机器人"能力 | - |
| 3 | 权限管理 → 申请 `im:message:send_as_bot` | 发消息权限 |
| 4 | 权限管理 → 申请 `im:resource` | 上传文件权限 |
| 5 | 发布应用 → 版本管理与发布 | 机器人上线 |

---

## 十一、实施计划

### Phase 1: 基础设施（1-2 天）

1. 创建 `wfm_agents/channel/` 模块
2. 实现 `token_manager.py`（token 获取、缓存、刷新）
3. 实现 `config.py`（凭据加载、联系人配置解析）
4. 实现 `contacts.py`（名称模糊匹配）
5. `pyproject.toml` 添加 `httpx` 依赖

### Phase 2: 钉钉 Client（1 天）

1. 实现 `dingtalk_client.py`
   - `send_message(user_id, content, msg_type)`
   - `upload_file(file_path) → media_id`
   - `send_file_message(user_id, media_id, filename, message)`

### Phase 3: 飞书 Client（1 天）

1. 实现 `feishu_client.py`
   - `send_message(open_id, content, msg_type)`
   - `upload_file(file_path) → file_key`
   - `send_file_message(open_id, file_key)`

### Phase 4: MCP Tool 注册 + 联调（1 天）

1. 在 `wfm_mcp_server.py` 注册 3 个 tool
2. 实现 `dispatcher.py` 统一路由
3. 准备测试用联系人配置
4. 端到端测试

**总工作量：4-5 天**

---

## 十二、后续扩展（本次不做）

| 扩展 | 依赖 | 复杂度 |
|------|------|--------|
| 双向通道（IM → AI 查询） | 需完整 Channel Gateway | 10-15 天 |
| 审核闭环（IM 回复 → 回写 workspace） | 双向通道 | 额外 3-5 天 |
| 钉钉通讯录实时查询 | 需申请通讯录 API 权限 | 1 天 |
| 飞书消息卡片交互（按钮回调） | 需要 CardActionHandler | 2 天 |
| 群聊 @bot 触发 | 需 Stream/WebSocket 接收 | 包含在双向通道中 |

---

## 参考资料

- [钉钉机器人消息类型](https://open.dingtalk.com/document/development/robot-message-type)
- [钉钉企业机器人发送单聊消息](https://open.dingtalk.com/document/development/the-application-robot-in-the-enterprise-sends-a-single-chat)
- [飞书发送消息 API](https://open.feishu.cn/document/server-docs/im-v1/message/create)
- [飞书上传文件 API](https://open.feishu.cn/document/server-docs/im-v1/file/create)
- [钉钉云盘 API 调研](./RESEARCH_DINGTALK_DRIVE_API.md)
- [Channel 集成总体方案](./PLAN_CHANNEL_INTEGRATION.md)
