# WFM Studio

面向**船厂内容生产 + CAD 审图**场景的本地 AI 工作台。基于 vscode fork（`wfm-ide/`）+ 自研 Agent 后端（`wfm-agents/`）。

## 完全开源

本项目（含对 vscode 的全部 fork 改动）以 **OSS 形式发布在 GitHub**，接受任何主流开源 license 的依赖（MIT / Apache-2.0 / GPL-3 / LGPL / MPL 等均可），不规避 viral copyleft。详细的依赖选型与 license 策略见 [`.cursor/rules/project-license.mdc`](.cursor/rules/project-license.mdc)。

## 仓库结构

```
WFM-Studio/
├── wfm-ide/         vscode fork（git subtree，定制全部在 contrib/wfm/）
├── wfm-agents/      FastAPI + Agent 后端（uv + Python 3.11+）
├── third_party/     vendor 的开源组件（agenticx / maf / crewai / anthropic-sdk-python）
├── scripts/         一键开发启动器（dev.sh / dev-minimal.sh / dev-stop.sh / wfm-up.sh）
├── docs/            产品 / 架构 / 升级文档
└── .wfm-dev/        运行期工件（log、pid，已 gitignore）
```

## 关键文档

| 文档 | 说明 |
|---|---|
| [`docs/PRD.md`](docs/PRD.md) | 产品需求文档 |
| [`docs/PLAN.md`](docs/PLAN.md) | 实施计划与里程碑 |
| [`docs/TASK_SCENARIOS.md`](docs/TASK_SCENARIOS.md) | 用户故事 |
| [`docs/ARCH_AGENT_GATEWAY.md`](docs/ARCH_AGENT_GATEWAY.md) | [已废弃] 旧 Agent 网关架构 |
| [`docs/ARCH_CAD_REVIEW.md`](docs/ARCH_CAD_REVIEW.md) | CAD 审图架构 |
| [`docs/UPSTREAM_PATCHES.md`](docs/UPSTREAM_PATCHES.md) | vscode fork 改动登记 |
| [`docs/VSCODE_UPSTREAM.md`](docs/VSCODE_UPSTREAM.md) | vscode 升级流程 |
| [`.cursor/rules/wfm-ide-fork-policy.mdc`](.cursor/rules/wfm-ide-fork-policy.mdc) | wfm-ide 定制守则（agent 必读） |
| [`.cursor/rules/project-license.mdc`](.cursor/rules/project-license.mdc) | 开源与依赖选型策略（agent 必读） |

## 快速启动

```bash
# 1) 配置后端 LLM secret（首次必做）
cp wfm-agents/.env.example wfm-agents/.env
# 然后编辑 wfm-agents/.env 填入 WFM_OPENAI_API_KEY 等。
# 默认走 DashScope (阿里云百炼) + glm-5.1；要切 DeepSeek / 官方 OpenAI / 其它兼容上游，
# 改 WFM_OPENAI_BASE_URL 与 WFM_OPENAI_MODEL 即可，无需改代码。

# 2) 一键最小闭环：后端 + IDE watch + 工作台
./scripts/dev-minimal.sh

# 完整：含 AgenticX / MAF DevUI
./scripts/dev.sh

# 停所有
./scripts/dev-stop.sh
```

**Agent 后端**：基于 OpenAI Agents SDK（`agent_v2/`），默认走 DashScope + GLM-5.1（OpenAI Chat Completions 兼容）。
`engine` / `mode` 字段已废弃（接受但忽略），历史原因保留。详见 [`docs/WHY_AGENTS_SDK.md`](docs/WHY_AGENTS_SDK.md)。

详细开发流程见各子目录 README 与 `docs/PLAN.md` §8.3。
