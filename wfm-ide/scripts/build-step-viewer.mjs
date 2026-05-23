#!/usr/bin/env node
/* eslint-disable no-console */
/*
 * WFM STEP viewer — vendor 打包脚本。
 *
 * 把 build/step-viewer-entry.mjs 经 esbuild 打成 IIFE，
 * 落到 contrib/wfm/stepViewer/browser/media/。
 *
 * 用法：
 *     cd wfm-ide
 *     npm run vendor-step-viewer
 */

import { existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, '..');
const entry = resolve(repoRoot, 'build/step-viewer-entry.mjs');
const mediaDir = resolve(
	repoRoot,
	'src/vs/workbench/contrib/wfm/stepViewer/browser/media',
);
const outFile = join(mediaDir, 'step-viewer.iife.js');

async function main() {
	if (!existsSync(entry)) {
		throw new Error(`找不到 entry: ${entry}`);
	}

	let esbuild;
	try {
		esbuild = await import('esbuild');
	} catch (err) {
		console.error('未找到 esbuild。请先 `npm install --save-dev esbuild`。');
		process.exitCode = 1;
		return;
	}

	mkdirSync(mediaDir, { recursive: true });

	console.log(`[vendor-step-viewer] esbuild ${entry}`);
	const t0 = Date.now();

	// Three.js 的 examples/jsm 导入路径缺 .js 后缀，用插件补全。
	// node 内置模块在浏览器 IIFE 里不需要，stub 成空对象。
	const resolveFixupsPlugin = {
		name: 'wfm-step-resolve-fixups',
		setup(build) {
			build.onResolve({ filter: /^three\/examples\/jsm\// }, async (args) => {
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
			build.onResolve({ filter: /^(fs|path|os|crypto|stream|util|url)$/ }, () => ({
				path: 'wfm-step-empty',
				namespace: 'wfm-step-stub',
			}));
			build.onLoad({ filter: /.*/, namespace: 'wfm-step-stub' }, () => ({
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
		target: ['chrome120'],
		outfile: outFile,
		minify: false,
		sourcemap: false,
		legalComments: 'none',
		logLevel: 'info',
		conditions: ['browser', 'import', 'default'],
		mainFields: ['browser', 'module', 'main'],
		plugins: [resolveFixupsPlugin],
	});
	const sizeKb = (statSync(outFile).size / 1024).toFixed(1);
	console.log(`[vendor-step-viewer] wrote ${outFile} (${sizeKb} KB, ${Date.now() - t0} ms)`);

	if (result.warnings.length) {
		console.warn(`[vendor-step-viewer] ${result.warnings.length} esbuild warnings`);
	}
}

main().catch((err) => {
	console.error('[vendor-step-viewer] failed:', err);
	process.exit(1);
});
