# WFM CAD viewer vendor bundles

WFM Studio 在中央编辑区的 `.dwg` / `.dxf` 渲染依赖两个 npm 包：

| 包 | 体积 | License | 作用 |
|---|---|---|---|
| `@mlightcad/cad-simple-viewer` (+ `@mlightcad/data-model` + `@mlightcad/three-renderer` + `three`) | ~1.5 MB | MIT | DXF/DWG 渲染、文档管理、图层 |
| `@mlightcad/libredwg-web` | ~5.7 MB（其中 wasm） | **GPL-3.0** | DWG 二进制 → DXF 文本 |

它们都是 ESM，必须先打包成 IIFE 后由 webview 通过 `<script src="...">` 加载。

## 一键打包

为了对 vscode 上游 `package.json` 改动保持最小（见
`.cursor/rules/wfm-ide-fork-policy.mdc`），vendor 脚本不挂在 npm scripts 里，
直接以 node 命令调用：

```bash
cd wfm-ide
npm install --save-dev @mlightcad/cad-simple-viewer @mlightcad/data-model \
                       @mlightcad/three-renderer @mlightcad/libredwg-web three esbuild
node scripts/build-cad-viewer.mjs
```

脚本会：

1. 用 esbuild 把 `wfm-ide/build/cad-viewer-entry.mjs` 打包成 `media/cad-viewer.iife.js`
2. 拷贝 `node_modules/@mlightcad/libredwg-web/.../libredwg.wasm` 到 `media/libredwg.wasm`

打包产物默认 git tracking。每次升级 cad-viewer / libredwg 后重新跑该脚本即可。

## 没装 vendor 时会发生什么

`viewer.js` 在没找到 `window.WfmCadBootstrap` 时会渲染醒目的红色错误条，
并提示用户去执行 `node scripts/build-cad-viewer.mjs`。IDE 双击 .dwg/.dxf
仍能打开 viewer pane，只是中央渲染区不可用——后端 `/v1/chat` 走 viewer_inline
分支也无法触发，但用户仍可在右侧任务对话用 `审一下 xxx.dxf` 旧链路
（基于工作区磁盘文件）。

## License 说明

`libredwg-web` 是 GPL-3.0 viral，按本仓库 `.cursor/rules/project-license.mdc`
约定：项目整体公开开源，引入 GPL-3 不构成障碍，整体可作 GPL-3 兼容协议
发布。详见 `docs/ARCH_CAD_REVIEW.md` §5.3。
