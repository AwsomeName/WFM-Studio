# Agent 与 Model 选择器改造方案

> 日期: 2026-05-19
> 状态: UI 已完成, Agent/Model 列表硬编码待后端打通

---

## 1. 现状分析

### 前端 (wfm-ide)

对话框底部已按 Cursor 风格改造完成:

```
┌─ .wfm-chat-input-container (圆角 12px) ─────────────────┐
│  textarea                                                │
│  ┌─ .wfm-chat-toolbar ─────────────────────────────────┐ │
│  │ [∞ Agent ▾]  [⚙ Model ▾]         [🎤]  [↑]        │ │
│  └─────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────┘
```

**已完成:**
- 圆角输入容器 + 底部工具栏
- Agent / Model 下拉按钮 (pill 样式, 点击弹出 context menu)
- 麦克风按钮 + 圆形箭头发送按钮
- SSE 流式消息 + Activity Log (工具调用步骤可视化) — `chatStream()` 实时消费 `POST /v1/chat/stream`，展示 Agent 切换、工具调用状态、流式文本；完成后活动日志折叠为摘要

**未打通 (当前阶段):**
- Agent / Model 列表为**前端硬编码** (已按实际 Agent ID 和模型名称配置, 占位项标注"即将推出")
- 选择结果**未传递给后端** (chat/chatStream 请求中不含 agent/model 参数)
- 麦克风按钮无功能
- 选择状态未持久化

**硬编码列表:**

Agent:
| ID | 显示名 |
|---|---|
| `wfm.router` | WFM Router |
| `text_to_cad` | Text-to-CAD |
| `cad_review` | CAD 审图 |
| `docx_review` | DOCX 审阅 |
| `openclaw` | OpenClaw (即将推出) |

Model (对齐 `wfm-agents/.env` 实际配置: 阿里云 DashScope 兼容端点 `https://dashscope.aliyuncs.com/compatible-mode/v1`):

| ID | 显示名 |
|---|---|
| `glm-5.1` | GLM-5.1 (阿里云) — 默认, 与 `WFM_AGENT_MODEL` 一致 |
| `qwen-max` | Qwen Max (即将推出) |
| `qwen-plus` | Qwen Plus (即将推出) |
| `deepseek-v3` | DeepSeek V3 (即将推出) |
| `deepseek-r1` | DeepSeek R1 (即将推出) |

### 后端 (wfm-agents)

**Agent 注册 (4 个):**

| Agent ID | 名称 | 用途 | 入口方式 |
|---|---|---|---|
| `wfm.router` | WFM 路由 | 通用对话 + 自动分发 | 默认入口 |
| `text_to_cad` | 3D 模型生成 | 文本 → STEP 模型 | router handoff |
| `cad_review` | CAD 审图 | DXF/DWG 审查 | router handoff |
| `docx_review` | 文档审阅 | DOCX 审核 | router handoff |

**Model 配置:**
- 默认模型: `glm-5.1` (经阿里云 DashScope `compatible-mode/v1`)
- 配置方式: 仅环境变量 (`WFM_AGENT_MODEL`, `WFM_OPENAI_BASE_URL`, `WFM_OPENAI_API_KEY`)
- 所有 Agent 共享同一个全局模型, 无 per-agent / per-request 选择
- API 兼容: 任何 OpenAI-compatible 端点 (阿里云 DashScope / 智谱 / DeepSeek / OpenAI 等)

**请求格式 (`POST /v1/chat/stream`):**
```json
{
  "workspace_root": "/path/to/ws",
  "message": "...",
  "session_id": "...",
  "dxf_text": "...",
  "attachments": [{"uri": "...", "name": "...", "rel_path": "..."}]
}
```

**关键限制:**
- `ChatRequest` 无 `agent` / `model` 字段
- `RunConfig` 中 `load_config()` 不接受运行时 override
- Agent 分发完全靠 LLM 判断 (router agent 读取 prompt 后决定 handoff)

---

## 2. 目标状态

### 用户体验 (对标 Cursor)

```
[∞ WFM 路由 ▾]  [⚙ gpt-4.1-mini ▾]    [🎤]  [↑]
```

- 点击 Agent 按钮 → 下拉菜单显示所有可用 Agent, 当前选中项带 checkmark
- 点击 Model 按钮 → 下拉菜单显示所有可用 Model, 当前选中项带 checkmark
- 切换 Agent → 下一条消息直接发送给指定 Agent (可选: 是否绕过 router)
- 切换 Model → 下一条消息使用指定 Model
- 选择在 workspace 内持久化, 重开不丢失

### 架构目标

- 后端提供 `GET /v1/agents` 和 `GET /v1/models` API
- 前端启动时 + 定期刷新 Agent / Model 列表
- `POST /v1/chat/stream` 请求增加 `agent` 和 `model` 可选字段
- 后端根据字段决定: 直接调用指定 Agent / 覆盖默认 Model

---

## 3. 分步实施计划

### Phase 1: 后端 API 扩展 (P0)

#### 3.1 新增 `GET /v1/agents`

**文件:** `wfm-agents/wfm_agents/routes/agents.py` (新建)

```python
# 响应格式
{
  "agents": [
    {
      "id": "wfm.router",
      "name": "WFM 路由",
      "description": "通用对话, 自动分发到专业 Agent",
      "icon": "commentDiscussion",
      "is_default": true
    },
    {
      "id": "text_to_cad",
      "name": "3D 模型生成",
      "description": "根据文字描述生成 STEP 模型",
      "icon": "cube",
      "is_default": false
    },
    ...
  ]
}
```

**实现方式:** 从 `agents.py` 已注册的 Agent 列表中提取元信息, 添加到 Agent 构造参数中:

```python
# agents.py 中的改动: 添加 meta 信息
router_agent = Agent(
    name="wfm.router",
    instructions=_SYSTEM_ZH_ROUTER,
    tools=[...],
    handoffs=[...],
    # 新增 meta, 供 API 暴露
    meta={"display_name": "WFM 路由", "description": "通用对话, 自动分发到专业 Agent"},
)
```

#### 3.2 新增 `GET /v1/models`

**文件:** `wfm-agents/wfm_agents/routes/models.py` (新建)

```python
# 响应格式
{
  "models": [
    {"id": "gpt-4.1",      "name": "GPT-4.1",      "provider": "openai"},
    {"id": "gpt-4.1-mini", "name": "GPT-4.1 Mini",  "provider": "openai"},
    {"id": "gpt-4.1-nano", "name": "GPT-4.1 Nano",  "provider": "openai"},
    {"id": "o3",           "name": "o3",            "provider": "openai"},
    {"id": "o4-mini",      "name": "o4 Mini",       "provider": "openai"},
  ],
  "default": "gpt-4.1-mini"
}
```

**实现方式:**
- 方案 A (推荐): 配置文件驱动. 在 `config.py` 中新增 `AVAILABLE_MODELS` 列表, 环境变量可覆盖
- 方案 B: 动态查询. 通过 `client.models.list()` 调用 OpenAI API 获取 (需 provider 支持)

```python
# config.py 新增
AVAILABLE_MODELS: list[dict] = [
    {"id": "gpt-4.1",      "name": "GPT-4.1",      "provider": "openai"},
    {"id": "gpt-4.1-mini", "name": "GPT-4.1 Mini",  "provider": "openai"},
    {"id": "gpt-4.1-nano", "name": "GPT-4.1 Nano",  "provider": "openai"},
    {"id": "o3",           "name": "o3",            "provider": "openai"},
    {"id": "o4-mini",      "name": "o4 Mini",       "provider": "openai"},
]
# 可通过 WFM_AVAILABLE_MODELS 环境变量覆盖 (JSON 格式)
```

#### 3.3 请求体扩展

**文件:** `wfm-agents/wfm_agents/routes/chat.py` (修改)

```python
class ChatRequest(BaseModel):
    # ... 现有字段 ...
    agent: str | None = None      # 新增: 指定 Agent ID
    model: str | None = None      # 新增: 指定 Model ID
```

**文件:** `wfm-agents/wfm_agents/routes/chat_stream.py` (修改)

同上, `StreamRequest` 增加 `agent` 和 `model` 字段.

#### 3.4 Runner 改造

**文件:** `wfm-agents/wfm_agents/agent_v2/runner.py` (修改)

```python
async def run_stream(
    message: str,
    *,
    session_id: str | None = None,
    agent_override: str | None = None,   # 新增
    model_override: str | None = None,   # 新增
    ...
):
    config = load_config(model_override=model_override)

    # agent 选择逻辑
    if agent_override and agent_override != "wfm.router":
        agent = _AGENT_MAP.get(agent_override, router_agent)
    else:
        agent = router_agent

    # ... 现有 run 逻辑 ...
```

---

### Phase 2: 前端打通 (P0)

#### 3.5 Client Service 接口扩展

**文件:** `wfm-ide/src/vs/workbench/contrib/wfm/common/wfmAgentClient.ts` (修改)

```typescript
export interface IWfmAgentInfo {
    id: string;
    name: string;
    description?: string;
    icon?: string;
    isDefault?: boolean;
}

export interface IWfmModelInfo {
    id: string;
    name: string;
    provider?: string;
}

export interface IWfmAgentClientService {
    // ... 现有方法 ...
    fetchAgents(): Promise<IWfmAgentInfo[]>;
    fetchModels(): Promise<IWfmModelInfo[]>;
}
```

**文件:** `wfm-ide/src/vs/workbench/contrib/wfm/browser/wfmAgentClientService.ts` (修改)

实现 `fetchAgents()` 和 `fetchModels()`, 请求 `GET /v1/agents` 和 `GET /v1/models`.

#### 3.6 ViewPane 改造

**文件:** `wfm-ide/src/vs/workbench/contrib/wfm/browser/wfmChatViewPane.ts` (修改)

改动点:

1. **初始化时获取列表:** `renderBody()` 中调用 `fetchAgents()` / `fetchModels()` 替换硬编码
2. **动态选择器:** `showAgentPicker()` / `showModelPicker()` 使用从后端获取的列表
3. **请求传参:** `runChat()` 中将 `selectedAgent` / `selectedModel` 传给 `chatStream()`
4. **持久化:** 选择状态保存到 `Memento` (跟 session 一起)

```typescript
// renderBody 中:
const [agents, models] = await Promise.all([
    this.agentClient.fetchAgents(),
    this.agentClient.fetchModels(),
]);
this.agents = agents;
this.models = models;
this.selectedAgent = agents.find(a => a.isDefault)?.id ?? agents[0]?.id ?? 'default';
this.selectedModel = models[0]?.id ?? 'auto';
this.updateAgentLabel();
this.updateModelLabel();
```

#### 3.7 chatStream 传递参数

**文件:** `wfmAgentClientService.ts` (修改)

```typescript
async chatStream(
    message: string,
    extras: IWfmChatExtras | undefined,
    token: CancellationToken,
    sessionId: string | undefined,
    callbacks: IWfmStreamCallbacks,
    agent?: string,     // 新增
    model?: string,     // 新增
): Promise<void> {
    const body = {
        message,
        session_id: sessionId,
        agent,           // 新增
        model,           // 新增
        ...extras,
    };
    // ... 现有 fetch 逻辑 ...
}
```

---

### Phase 3: 语音输入 (P2)

#### 3.8 Web Speech API 集成

**方案:** 使用 `webkitSpeechRecognition` (Chromium 原生支持, Electron 环境直接可用)

```typescript
// wfmChatViewPane.ts
private setupVoiceInput(): void {
    const SpeechRecognition = (window as any).SpeechRecognition
        ?? (window as any).webkitSpeechRecognition;
    if (!SpeechRecognition) {
        this.micButton?.remove();  // 不支持则隐藏
        return;
    }
    const recognition = new SpeechRecognition();
    recognition.lang = 'zh-CN';
    recognition.interimResults = true;
    recognition.continuous = false;

    this._register(dom.addDisposableListener(this.micButton!, 'click', () => {
        if (this.isListening) {
            recognition.stop();
        } else {
            recognition.start();
            this.micButton!.classList.add('listening');
        }
        this.isListening = !this.isListening;
    }));

    recognition.onresult = (event: SpeechRecognitionEvent) => {
        const transcript = event.results[0][0].transcript;
        if (this.inputEl) {
            this.inputEl.value = transcript;
        }
    };
    recognition.onend = () => {
        this.isListening = false;
        this.micButton?.classList.remove('listening');
    };
}
```

CSS 增加 listening 状态:

```css
.wfm-chat-mic.listening {
    opacity: 1;
    color: var(--vscode-errorForeground, #f48771);
    animation: wfm-pulse 1.5s ease-in-out infinite;
}
```

---

### Phase 4: 状态持久化 (P3)

#### 3.9 Per-Session 记忆

在 `IWfmChatSession` 中增加选择记录:

```typescript
interface IWfmChatSession {
    // ... 现有字段 ...
    agentId?: string;   // 记住该 session 上次使用的 Agent
    modelId?: string;   // 记住该 session 上次使用的 Model
}
```

切换 session 时恢复 Agent / Model 选择到工具栏.

---

## 4. 文件变更清单

| 文件 | 操作 | Phase |
|---|---|---|
| `wfm-agents/wfm_agents/routes/agents.py` | **新建** | 1 |
| `wfm-agents/wfm_agents/routes/models.py` | **新建** | 1 |
| `wfm-agents/wfm_agents/agent_v2/agents.py` | 修改 (加 meta) | 1 |
| `wfm-agents/wfm_agents/agent/config.py` | 修改 (加 AVAILABLE_MODELS) | 1 |
| `wfm-agents/wfm_agents/agent_v2/runner.py` | 修改 (加 agent/model override) | 1 |
| `wfm-agents/wfm_agents/routes/chat.py` | 修改 (请求体加字段) | 1 |
| `wfm-agents/wfm_agents/routes/chat_stream.py` | 修改 (请求体加字段) | 1 |
| `wfm-agents/wfm_agents/routes/__init__.py` | 修改 (注册新路由) | 1 |
| `wfm-ide/.../common/wfmAgentClient.ts` | 修改 (加接口) | 2 |
| `wfm-ide/.../browser/wfmAgentClientService.ts` | 修改 (加 fetchAgents/Models) | 2 |
| `wfm-ide/.../browser/wfmChatViewPane.ts` | 修改 (动态列表 + 传参) | 2 |
| `wfm-ide/.../browser/media/wfmChat.css` | 修改 (listening 动画) | 3 |

---

## 5. 风险与权衡

| 风险 | 影响 | 缓解措施 |
|---|---|---|
| 绕过 router 直接指定 Agent 可能跳过 prompt enrichment | 审图等场景缺少文件上下文 | 直调 Agent 时仍走 chat.py 的 `_build_prompt()` |
| Model 不在 provider 的可用列表中 | API 调用失败 | 前端 Model 列表从后端获取, 而非前端硬编码 |
| Web Speech API 兼容性 | 旧版 Electron 可能不支持 | 检测 API 存在性, 不支持则隐藏麦克风按钮 |
| Agent 列表变更时用户已选的 Agent 失效 | 选择无效 | 加载列表时校验, 失效则回退到 default |

---

## 6. 建议实施顺序

```
Phase 1 (后端 API) ─── 1-2 天
    ↓
Phase 2 (前端打通) ─── 1 天
    ↓
Phase 3 (语音输入) ─── 0.5 天 (可选)
    ↓
Phase 4 (持久化)   ─── 0.5 天
```

**总计: 3-4 天**
