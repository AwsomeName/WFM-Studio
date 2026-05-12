/* eslint-disable */
/*
 * WFM CAD viewer — vendor IIFE 入口。
 *
 * 由 scripts/build-cad-viewer.mjs 用 esbuild 打包（format=iife），输出到
 * src/vs/workbench/contrib/wfm/cadReview/browser/media/cad-viewer.iife.js，
 * 在 webview 内通过 <script src="..."> 加载。
 *
 * 我们只把 viewer 实际需要用到的极少 API 暴露成 window.WfmCadBootstrap：
 *   - AcApDocManager         createInstance / openDocument / curView / curDocument
 *   - serializeAsDxf(docMgr) 返回当前文档的 DXF 文本（用于「AI 审图」）
 *
 * 这样 viewer.js 不再需要 import / dynamic-import，CSP 也只需放开 wasm-unsafe-eval。
 */

import { AcApDocManager, AcEdViewMode, eventBus } from '@mlightcad/cad-simple-viewer';
import { AcDbDatabaseConverterManager, AcDbFileType, AcDbDxfConverter } from '@mlightcad/data-model';
import { AcDbLibreDwgConverter } from '@mlightcad/libredwg-converter';
import * as THREE from 'three';

/**
 * 把 cad-simple-viewer 的当前文档 db 序列化成 DXF 文本。
 * 不同 cad-simple-viewer 小版本 API 名稱略有出入（exportToDxf / serializeToDxf /
 * writeDxf 等），这里做一次防御性 lookup，找到任何一个能用就 return。
 *
 * @param {{ curDocument?: any }} docManager
 * @returns {string | undefined}
 */
function serializeAsDxf(docManager) {
	if (!docManager) {
		return undefined;
	}
	const doc = docManager.curDocument;
	if (!doc) {
		return undefined;
	}
	const db = doc.database || doc.db;
	if (!db) {
		return undefined;
	}
	const candidates = [
		'exportAsDxfText',
		'serializeAsDxfText',
		'serializeAsDxf',
		'exportToDxf',
		'writeDxf',
		'toDxfString',
	];
	for (const name of candidates) {
		const fn = db[name] || doc[name];
		if (typeof fn === 'function') {
			try {
				const result = fn.call(db[name] ? db : doc);
				if (typeof result === 'string' && result.length > 0) {
					return result;
				}
			} catch (err) {
				// fall through to next candidate
				console.warn('[wfm-cad-viewer] serializeAsDxf candidate failed:', name, err);
			}
		}
	}
	return undefined;
}

/* @ts-ignore */
window.WfmCadBootstrap = {
	AcApDocManager,
	serializeAsDxf,
	// 把 data-model + libredwg-converter 单独暴露出来，viewer.js 会在 createInstance
	// 之后用它们手动 register 一次 DWG / DXF converter。
	// 必须手动注册的原因：cad-simple-viewer 的 dist/index.js 把
	// `@mlightcad/libredwg-converter` 视为 external（package.json 没声明它是 dependency），
	// 它内部的 registerConverters 在 try/catch 里 new AcDbLibreDwgConverter() 时会因
	// 类不存在而静默失败，导致 'DWG' 文件类型在 ConverterManager 里查不到。
	AcDbDatabaseConverterManager,
	AcDbFileType,
	AcDbDxfConverter,
	AcDbLibreDwgConverter,
	// 让 viewer.js 能在 SELECTION ↔ PAN 间切换模式（左键行为切换）。
	AcEdViewMode,
	// THREE 暴露出来给 viewer.js 直接配 OrbitControls.mouseButtons 用 THREE.MOUSE 枚举。
	// 不暴露的话 fallback 到数字常量也行（PAN=2），但保险起见同步导出，避免上游某天调整数值。
	THREE,
	// cad-simple-viewer 内部的事件总线。我们用它的 'fonts-not-found' /
	// 'fonts-not-loaded' 事件实时收集"渲染时真正加载失败的字体"，比扫
	// textStyleTable 更准（后者会把已 alias 的字体也算成缺失）。
	eventBus,
};
