/* eslint-disable */
/*
 * WFM STEP viewer — vendor IIFE 入口。
 *
 * 由 scripts/build-step-viewer.mjs 用 esbuild 打包（format=iife），输出到
 * src/vs/workbench/contrib/wfm/stepViewer/browser/media/step-viewer.iife.js，
 * 在 webview 内通过 <script src="..."> 加载。
 *
 * 暴露 Three.js + GLTFLoader + OrbitControls + 边线渲染所需模块。
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';

/* @ts-ignore */
window.WfmStepBootstrap = {
	THREE,
	GLTFLoader,
	STLLoader,
	OrbitControls,
	LineMaterial,
	LineSegments2,
	LineSegmentsGeometry,
};
