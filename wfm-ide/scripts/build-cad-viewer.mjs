#!/usr/bin/env node
/* eslint-disable no-console */
/*
 * WFM CAD viewer — vendor 打包脚本。
 *
 * 把 build/cad-viewer-entry.mjs 经 esbuild 打成 IIFE，
 * 与 libredwg.wasm 一并落到 contrib/wfm/cadReview/browser/media/。
 *
 * 用法：
 *     cd wfm-ide
 *     npm install --save-dev @mlightcad/cad-simple-viewer @mlightcad/data-model \
 *                            @mlightcad/three-renderer @mlightcad/libredwg-web three
 *     npm run vendor-cad-viewer
 *
 * 不建议把这一步串到 watch / compile 里：vendor 包升级才需要重跑，平时不动。
 */

import { existsSync, mkdirSync, copyFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, '..');
const entry = resolve(repoRoot, 'build/cad-viewer-entry.mjs');
const mediaDir = resolve(
	repoRoot,
	'src/vs/workbench/contrib/wfm/cadReview/browser/media',
);
const outFile = join(mediaDir, 'cad-viewer.iife.js');

async function main() {
	if (!existsSync(entry)) {
		throw new Error(`找不到 entry: ${entry}`);
	}

	// 兜底：esbuild 是 vscode 自带的常见依赖；用户也可以独立安装。
	let esbuild;
	try {
		esbuild = await import('esbuild');
	} catch (err) {
		console.error('未找到 esbuild。请先 `npm install --save-dev esbuild`。');
		process.exitCode = 1;
		return;
	}

	mkdirSync(mediaDir, { recursive: true });

	console.log(`[vendor-cad-viewer] esbuild ${entry}`);
	const t0 = Date.now();

	// cad-simple-viewer 编译产物里有几条 esbuild 不太好直接 resolve 的路径：
	//   - `three/examples/jsm/...`（缺 .js 后缀；package.json exports 是 exact match）
	//   - `require("fs")`（仅在 node-only 代码路径触发，浏览器里不会跑）
	// 用一个 in-place 插件兜住这两类。
	const resolveFixupsPlugin = {
		name: 'wfm-cad-resolve-fixups',
		setup(build) {
			// 三方库里写的 `import 'three/examples/jsm/foo'` —— 自动补 `.js`
			build.onResolve({ filter: /^three\/examples\/jsm\// }, async args => {
				if (args.path.endsWith('.js') || args.path.endsWith('.mjs')) {
					return undefined;
				}
				const fixed = `${args.path}.js`;
				const resolved = await build.resolve(fixed, {
					kind: args.kind,
					resolveDir: args.resolveDir,
					importer: args.importer,
				});
				if (resolved.errors.length === 0) {
					return resolved;
				}
				return undefined;
			});
			// node 内置模块（fs / path / os 等）—— 浏览器构建里直接当 external，
			// IIFE 里看到也不会真的去 require，运行时 stub 成空对象。
			build.onResolve({ filter: /^(fs|path|os|crypto|stream|util|url)$/ }, () => ({
				path: 'wfm-cad-empty',
				namespace: 'wfm-cad-stub',
			}));
			build.onLoad({ filter: /.*/, namespace: 'wfm-cad-stub' }, () => ({
				contents: 'export default {}; export const exists = () => false;',
				loader: 'js',
			}));
		},
	};

	const result = await esbuild.build({
		entryPoints: [entry],
		bundle: true,
		format: 'iife',
		platform: 'browser',
		target: ['chrome120'], // VS Code 当前 Electron 内核
		outfile: outFile,
		minify: false,
		sourcemap: false,
		legalComments: 'none',
		logLevel: 'info',
		// libredwg-web 需要 fetch wasm；我们用 file:/data: 走 webview localResourceRoots
		// 即可，不需要 esbuild 把 wasm 内联。
		loader: {
			'.wasm': 'file',
		},
		conditions: ['browser', 'import', 'default'],
		mainFields: ['browser', 'module', 'main'],
		plugins: [resolveFixupsPlugin],
	});
	const sizeKb = (statSync(outFile).size / 1024).toFixed(1);
	console.log(`[vendor-cad-viewer] wrote ${outFile} (${sizeKb} KB, ${Date.now() - t0} ms)`);

	// cad-simple-viewer 把 DXF/DWG 解析放在 web worker 里，把 wasm base64 嵌进了
	// 对应的 worker 文件里。我们需要把这三个 worker 文件 + 一份 libredwg.wasm
	// （兜底，部分 worker fallback 会用磁盘 wasm）拷到 media/，然后 entry 里
	// 通过 webworkerFileUrls 把这些路径传给 createInstance。
	const vendorFiles = [
		{
			label: 'libredwg-parser-worker.js',
			candidates: ['@mlightcad/cad-simple-viewer/dist/libredwg-parser-worker.js'],
			required: true,
		},
		{
			label: 'mtext-renderer-worker.js',
			candidates: ['@mlightcad/cad-simple-viewer/dist/mtext-renderer-worker.js'],
			required: true,
		},
		{
			label: 'dxf-parser-worker.js',
			candidates: [
				'@mlightcad/data-model/dist/dxf-parser-worker.js',
				'@mlightcad/cad-simple-viewer/dist/dxf-parser-worker.js',
			],
			required: true,
		},
		{
			label: 'libredwg-web.wasm',
			candidates: [
				'@mlightcad/libredwg-web/wasm/libredwg-web.wasm',
				'@mlightcad/libredwg-web/dist/libredwg-web.wasm',
			],
			required: false, // worker 内已有 base64 wasm，磁盘版只是兜底
		},
	];
	for (const file of vendorFiles) {
		let copied = false;
		for (const candidate of file.candidates) {
			const abs = resolve(repoRoot, 'node_modules', candidate);
			if (existsSync(abs)) {
				const dst = join(mediaDir, file.label);
				copyFileSync(abs, dst);
				const sizeKb = (statSync(dst).size / 1024).toFixed(1);
				console.log(`[vendor-cad-viewer] copied ${file.label} (${sizeKb} KB) <- ${candidate}`);
				copied = true;
				break;
			}
		}
		if (!copied) {
			const msg = `[vendor-cad-viewer] 找不到 ${file.label}（候选: ${file.candidates.join(', ')}）`;
			if (file.required) {
				throw new Error(msg);
			}
			console.warn(msg);
		}
	}

	if (result.warnings.length) {
		console.warn(`[vendor-cad-viewer] ${result.warnings.length} esbuild warnings`);
	}
}

main().catch(err => {
	console.error('[vendor-cad-viewer] failed:', err);
	process.exit(1);
});
