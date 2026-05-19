# Render Pipeline — third_party/text-to-cad

> **日期**：2026-05-19
> **状态**：已实施并验证
> **关联**：[ARCH_AGENT_SDK_NATIVE.md](ARCH_AGENT_SDK_NATIVE.md) §12、[DEV_SETUP.md](DEV_SETUP.md) §9

---

## 技术选型

| 方案 | 质量 | 额外下载 | 维护 | 结论 |
|------|------|----------|------|------|
| third_party/text-to-cad（Playwright + Three.js WebGL） | 高（PBR + 阴影 + 抗锯齿） | ~175MB | 社区维护 | **已采用** |
| 自定义 VTK 渲染器 | 基础（无阴影/抗锯齿/AO） | 0 | 自行维护 | 已放弃 |

---

## 管线流程

```
cad_generate_step 调用 scripts/step
  → build123d 源码编译 → STEP 文件
  → 同时生成 GLB artifact（含拓扑数据，.<name>.step.glb）

cad_render 调用 scripts/render view
  → 定位 GLB artifact（通过 STEP 文件路径推导）
  → Playwright 启动 headless Chromium
  → Three.js WebGL 渲染 GLB（PBR 材质、光照、抗锯齿）
  → 输出 PNG
```

关键点：
- `cad_generate_step` **不能**传 `--skip-explorer`，否则不会生成 GLB artifact，渲染会失败
- GLB artifact 路径规则：`<step_dir>/.<step_name>.step.glb`（隐藏文件，与 STEP 同目录）

---

## 依赖清单

| 依赖 | 版本 | 大小 | 安装方式 |
|------|------|------|----------|
| build123d（含 OCP/OpenCascade） | ≥0.10 | ~100MB | `uv add build123d` |
| Playwright Python 包 | ≥1.59 | ~1MB | `uv add playwright` |
| Chromium 浏览器 | 随 Playwright | ~170MB | `python -m playwright install chromium` |
| Three.js | 0.170.0 | ~5MB | `npm install three@0.170.0`（在 explorer 目录） |
| trimesh | ≥4.12 | ~5MB | `uv add trimesh` |

Three.js 安装路径：`third_party/text-to-cad/skills/cad/explorer/node_modules/three/`

---

## 代码位置

| 组件 | 文件 |
|------|------|
| `cad_generate_step` 工具 | `wfm-agents/wfm_agents/agent_v2/tools.py` |
| `cad_render` 工具 | `wfm-agents/wfm_agents/agent_v2/tools.py` |
| STEP 编译脚本 | `third_party/text-to-cad/skills/cad/scripts/step/` |
| 渲染脚本 | `third_party/text-to-cad/skills/cad/scripts/render/` |
| 浏览器渲染 HTML | `third_party/text-to-cad/skills/cad/scripts/render/browser/render.html` |
| 浏览器渲染 JS | `third_party/text-to-cad/skills/cad/scripts/render/browser/render_entry.js` |
| GLB 导出 | `third_party/text-to-cad/skills/cad/scripts/common/glb.py` |

---

## 已知限制

1. **Chromium 冷启动**：首次渲染约 2-3 秒（后续渲染复用进程会更快）
2. **GLB 生成开销**：STEP 编译时额外增加 1-3 秒（网格化 + GLB 导出）
3. **模型质量依赖 LLM**：build123d 代码由 GLM-5.1 生成，复杂零件可能需要多轮修正
4. **磁盘占用**：Chromium ~170MB + build123d ~100MB + Three.js ~5MB
