/* eslint-disable */
/**
 * WFM STEP Viewer — webview 端 Three.js 交互查看器。
 *
 * 在 webview 中运行，通过 window.WfmStepBootstrap 获取 Three.js 等依赖。
 * 接收 main 端 postMessage 传来的 GLB ArrayBuffer，用 GLTFLoader 加载并交互渲染。
 *
 * 代码风格参照 cadReview/browser/media/viewer.js (IIFE 模式)。
 * 渲染逻辑移植自 third_party/text-to-cad/render/browser/render_entry.js。
 */
(function () {
	'use strict';

	// ── 常量（from render_entry.js） ──────────────────────────────────────

	const DEFAULT_MODEL_COLOR = [0.8, 0.84, 0.9];
	const INSPECTION_SURFACE_COLOR = [0.74, 0.77, 0.80];
	const TECHNICAL_LINE_COLOR = [0x25 / 255, 0x2b / 255, 0x31 / 255];
	const WORLD_UP = Object.freeze([0, 0, 1]);
	const TOP_VIEW_UP = Object.freeze([0, 1, 0]);
	const COMPONENT_COLORS = [
		[0.82, 0.84, 0.88],
		[0.68, 0.77, 0.91],
		[0.7, 0.86, 0.79],
		[0.93, 0.79, 0.62],
		[0.88, 0.72, 0.78],
		[0.76, 0.72, 0.9],
		[0.85, 0.83, 0.62],
		[0.68, 0.86, 0.87],
	];

	const VIEW_PRESETS = {
		front:  { name: 'front',  direction: [0, -1, 0],     up: WORLD_UP },
		back:   { name: 'back',   direction: [0, 1, 0],      up: WORLD_UP },
		right:  { name: 'right',  direction: [1, 0, 0],      up: WORLD_UP },
		left:   { name: 'left',   direction: [-1, 0, 0],     up: WORLD_UP },
		top:    { name: 'top',    direction: [0, 0, 1],      up: TOP_VIEW_UP },
		bottom: { name: 'bottom', direction: [0, 0, -1],     up: TOP_VIEW_UP },
		iso:    { name: 'iso',    direction: [1, -1, 0.8],   up: WORLD_UP },
	};

	// ── VS Code API + Three.js bootstrap ──────────────────────────────────

	const vscode = acquireVsCodeApi();

	/** @type {{ THREE: any, GLTFLoader: any, STLLoader: any, OrbitControls: any, LineMaterial: any, LineSegments2: any, LineSegmentsGeometry: any }} */
	var bootstrap = window.WfmStepBootstrap;
	var THREE = bootstrap.THREE;
	var GLTFLoader = bootstrap.GLTFLoader;
	var STLLoader = bootstrap.STLLoader;
	var OrbitControls = bootstrap.OrbitControls;
	var LineMaterial = bootstrap.LineMaterial;
	var LineSegments2 = bootstrap.LineSegments2;
	var LineSegmentsGeometry = bootstrap.LineSegmentsGeometry;

	// ── State ──────────────────────────────────────────────────────────────

	var renderer, scene, camera, controls;
	var currentPreset = 'solid';
	var edgesEnabled = true;
	var edgeStyle = 'thin';
	var isDark = true;
	var records = [];
	var edgeObjects = [];
	var loadedRoots = [];
	var animating = false;
	var modelCenter = new THREE.Vector3();
	var modelDiagonal = 1;
	var toolbarBound = false;
	var resizeObserver = null;

	// ── DOM refs ───────────────────────────────────────────────────────────

	var canvasHost = document.getElementById('step-canvas-host');
	var loadingEl = document.getElementById('step-loading');
	var loadingText = document.getElementById('step-loading-text');
	var statusEl = document.getElementById('step-status');
	var filenameEl = document.getElementById('step-filename');

	// ── Initialization ─────────────────────────────────────────────────────

	function initScene() {
		renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
		renderer.outputColorSpace = THREE.SRGBColorSpace;
		renderer.setPixelRatio(window.devicePixelRatio);
		renderer.setSize(canvasHost.clientWidth, canvasHost.clientHeight);
		renderer.setClearColor(new THREE.Color(isDark ? 0x1e1e1e : 0xffffff), 1);
		canvasHost.appendChild(renderer.domElement);

		scene = new THREE.Scene();

		// Lighting (from render_entry.js)
		scene.add(new THREE.HemisphereLight(0xffffff, 0xd8dee7, 0.95));
		var keyLight = new THREE.DirectionalLight(0xffffff, 1.35);
		keyLight.position.set(2.2, -2.0, 3.2);
		scene.add(keyLight);
		var fillLight = new THREE.DirectionalLight(0xf5f8ff, 0.12);
		fillLight.position.set(-3, 1.2, 1.4);
		scene.add(fillLight);

		camera = new THREE.PerspectiveCamera(
			45,
			canvasHost.clientWidth / canvasHost.clientHeight,
			0.001, 100
		);

		controls = new OrbitControls(camera, renderer.domElement);
		controls.enableDamping = true;
		controls.dampingFactor = 0.08;
		controls.rotateSpeed = 0.8;
		controls.zoomSpeed = 1.2;
		controls.up = new THREE.Vector3(0, 0, 1); // CAD Z-up

		window.addEventListener('resize', onResize);

		// Editor pane 的尺寸变化不会自动触发 webview window 的 resize 事件——
		// 如果首次 initScene 时 canvasHost 还是 0×0（webview 没布局完），
		// 模型就会"看上去没渲染"。用 ResizeObserver 兜底持续校准。
		if (typeof ResizeObserver !== 'undefined') {
			resizeObserver = new ResizeObserver(function () { onResize(); });
			resizeObserver.observe(canvasHost);
		}
	}

	/** 清空场景上的旧模型 + 边线，准备装新模型；防重复 load 时累积。 */
	function clearScene() {
		removeEdgeObjects();
		for (var i = 0; i < loadedRoots.length; i++) {
			var root = loadedRoots[i];
			if (root.parent) root.parent.remove(root);
			root.traverse(function (obj) {
				if (obj.geometry) obj.geometry.dispose();
				if (obj.material) {
					if (Array.isArray(obj.material)) obj.material.forEach(function (m) { m.dispose(); });
					else obj.material.dispose();
				}
			});
		}
		loadedRoots = [];
		records = [];
	}

	// ── GLB Loading ────────────────────────────────────────────────────────

	function loadGlb(arrayBuffer) {
		loadingText.textContent = 'Loading GLB...';
		clearScene();

		var loader = new GLTFLoader();
		try {
			loader.parse(arrayBuffer, '', function (gltf) {
				try {
					var root = gltf.scene;
					scene.add(root);
					loadedRoots.push(root);
					scene.updateMatrixWorld(true);
					finalizeLoad(collectMeshRecords(root));
				} catch (err) {
					showError('GLB scene setup failed: ' + (err && err.message ? err.message : err));
				}
			}, function (error) {
				showError('Failed to parse GLB: ' + (error && error.message ? error.message : error));
			});
		} catch (err) {
			showError('Failed to parse GLB: ' + (err && err.message ? err.message : err));
		}
	}

	// ── STL Loading ────────────────────────────────────────────────────────

	function loadStl(arrayBuffer) {
		loadingText.textContent = 'Loading STL...';
		clearScene();
		try {
			var loader = new STLLoader();
			var geometry = loader.parse(arrayBuffer);
			geometry.computeBoundingBox();
			if (!geometry.attributes || !geometry.attributes.position) {
				throw new Error('Empty STL geometry');
			}
			if (!geometry.attributes.normal) {
				geometry.computeVertexNormals();
			}
			var material = new THREE.MeshLambertMaterial({
				color: new THREE.Color(DEFAULT_MODEL_COLOR[0], DEFAULT_MODEL_COLOR[1], DEFAULT_MODEL_COLOR[2]),
				side: THREE.DoubleSide,
				polygonOffset: true,
				polygonOffsetFactor: 1,
				polygonOffsetUnits: 1,
			});
			var mesh = new THREE.Mesh(geometry, material);
			// Tag with an occurrence id so collect/apply pipeline picks it up.
			mesh.userData.cadOccurrenceId = 'stl-root';
			var root = new THREE.Group();
			root.add(mesh);
			scene.add(root);
			loadedRoots.push(root);
			scene.updateMatrixWorld(true);
			finalizeLoad([{ mesh: mesh, occurrenceId: 'stl-root', edgeMaterials: [] }]);
		} catch (err) {
			showError('Failed to parse STL: ' + (err && err.message ? err.message : err));
		}
	}

	function finalizeLoad(recs) {
		records = recs;
		computeBounds(records);
		applyMaterials(records, {
			preset: currentPreset,
			colorBy: 'step',
			modelColor: DEFAULT_MODEL_COLOR,
			componentOrder: new Map(),
			renderMode: 'solid',
			hiddenLines: 'off',
		});
		if (edgesEnabled) {
			addEdgeObjects(records, { renderMode: 'solid', edgeStyle: edgeStyle, hiddenLines: 'off' });
		}
		fitCameraToIso();
		startAnimation();
		loadingEl.classList.add('hidden');

		var triCount = 0;
		records.forEach(function (r) {
			var idx = r.mesh.geometry.index;
			triCount += idx ? idx.count / 3 : r.mesh.geometry.attributes.position.count / 3;
		});
		statusEl.textContent = records.length + ' meshes · ' + Math.round(triCount).toLocaleString() + ' triangles';
		vscode.postMessage({ kind: 'renderStats', meshCount: records.length, triangleCount: triCount, loadMs: 0 });
	}

	function showError(message) {
		loadingEl.classList.remove('hidden');
		loadingEl.classList.add('error');
		var spinner = loadingEl.querySelector('.step-spinner');
		if (spinner) { spinner.style.display = 'none'; }
		loadingText.textContent = message;
		loadingText.style.color = 'var(--vscode-errorForeground, #f48771)';
		loadingText.style.maxWidth = '80%';
		loadingText.style.textAlign = 'center';
		loadingText.style.whiteSpace = 'pre-wrap';
		loadingText.style.wordBreak = 'break-word';
		vscode.postMessage({ kind: 'error', message: message });
	}

	// ── Mesh Collection (from render_entry.js) ────────────────────────────

	function collectMeshRecords(root) {
		var recs = [];
		root.traverse(function (object) {
			if (!object.isMesh || !object.geometry) return;
			var occurrenceId = occurrenceIdForObject(object);
			if (!occurrenceId) return;
			recs.push({ mesh: object, occurrenceId: occurrenceId, edgeMaterials: [] });
		});
		return recs;
	}

	function occurrenceIdForObject(object) {
		var cursor = object;
		while (cursor) {
			var userData = cursor.userData || {};
			var id = userData.cadOccurrenceId || userData.occurrenceId || userData.cadId;
			if (id) return String(id);
			cursor = cursor.parent;
		}
		return '';
	}

	// ── Bounds ─────────────────────────────────────────────────────────────

	function computeBounds(recs) {
		var bounds = new THREE.Box3();
		var meshBox = new THREE.Box3();
		recs.forEach(function (record) {
			record.mesh.updateWorldMatrix(true, false);
			if (!record.mesh.geometry.boundingBox) record.mesh.geometry.computeBoundingBox();
			meshBox.copy(record.mesh.geometry.boundingBox).applyMatrix4(record.mesh.matrixWorld);
			bounds.union(meshBox);
		});
		if (bounds.isEmpty()) {
			bounds.set(new THREE.Vector3(-1, -1, -1), new THREE.Vector3(1, 1, 1));
		}
		var size = new THREE.Vector3();
		bounds.getCenter(modelCenter);
		bounds.getSize(size);
		modelDiagonal = Math.max(size.length(), 1e-6);
	}

	// ── Camera Fitting ─────────────────────────────────────────────────────

	function fitCameraToIso() {
		var view = VIEW_PRESETS.iso;
		setCameraFromView(view);
	}

	function setCameraFromView(view) {
		var direction = new THREE.Vector3(view.direction[0], view.direction[1], view.direction[2]).normalize();
		var up = projectedUp(direction, new THREE.Vector3(view.up[0], view.up[1], view.up[2]));
		camera.up.copy(up);
		camera.position.copy(modelCenter).addScaledVector(direction, modelDiagonal * 2.2);
		camera.lookAt(modelCenter);

		camera.near = modelDiagonal * 0.001;
		camera.far = modelDiagonal * 20;
		camera.updateProjectionMatrix();

		controls.target.copy(modelCenter);
		controls.update();
	}

	function projectedUp(direction, up) {
		var projected = up.clone().sub(direction.clone().multiplyScalar(up.dot(direction)));
		if (projected.lengthSq() > 1e-9) return projected.normalize();
		var fallback = Math.abs(direction.z) < 0.9
			? new THREE.Vector3(WORLD_UP[0], WORLD_UP[1], WORLD_UP[2])
			: new THREE.Vector3(TOP_VIEW_UP[0], TOP_VIEW_UP[1], TOP_VIEW_UP[2]);
		return fallback.sub(direction.clone().multiplyScalar(fallback.dot(direction))).normalize();
	}

	// ── Materials (from render_entry.js) ───────────────────────────────────

	function applyMaterials(recs, options) {
		for (var i = 0; i < recs.length; i++) {
			var record = recs[i];
			if (options.renderMode === 'wireframe') {
				record.mesh.material = depthOnlyMaterial(options.hiddenLines !== 'all');
				continue;
			}
			var material = materialForRecord(record, options);
			record.mesh.material = material;
		}
	}

	function materialForRecord(record, options) {
		if (options.preset === 'normals') {
			return new THREE.MeshNormalMaterial({ side: THREE.DoubleSide });
		}
		var color = colorForRecord(record, options);
		var opacity = options.preset === 'xray' ? 0.42 : 1;
		if (options.preset === 'solid' || options.preset === 'technical' || options.preset === 'component' || options.preset === 'clay') {
			return new THREE.MeshLambertMaterial({
				color: new THREE.Color(color[0], color[1], color[2]),
				side: THREE.DoubleSide,
				polygonOffset: true,
				polygonOffsetFactor: 1,
				polygonOffsetUnits: 1,
			});
		}
		return new THREE.MeshStandardMaterial({
			color: new THREE.Color(color[0], color[1], color[2]),
			emissive: new THREE.Color(color[0], color[1], color[2]),
			emissiveIntensity: 0.24,
			metalness: 0,
			roughness: 0.82,
			transparent: opacity < 1,
			opacity: opacity,
			depthWrite: opacity >= 1,
			side: THREE.DoubleSide,
		});
	}

	function depthOnlyMaterial(depthWrite) {
		var material = new THREE.MeshBasicMaterial({
			color: 0xffffff,
			depthWrite: depthWrite,
			depthTest: depthWrite,
			side: THREE.DoubleSide,
		});
		material.colorWrite = false;
		return material;
	}

	function colorForRecord(record, options) {
		if (options.preset === 'solid') {
			var mc = baseColorFromMaterial(record.mesh.material);
			return readableSurfaceColor(mc || INSPECTION_SURFACE_COLOR, options.preset);
		}
		if (options.preset === 'clay') return [0.74, 0.72, 0.68];
		if (options.preset === 'technical') return [0.86, 0.88, 0.9];
		if (options.preset === 'xray') return [0.62, 0.76, 0.92];
		if (options.preset === 'component') {
			var idx = (options.componentOrder.get(record.occurrenceId) || 0);
			return readableSurfaceColor(COMPONENT_COLORS[idx % COMPONENT_COLORS.length], options.preset);
		}
		var mc2 = baseColorFromMaterial(record.mesh.material);
		return readableSurfaceColor(mc2 || options.modelColor, options.preset);
	}

	function readableSurfaceColor(color, preset) {
		if (preset === 'normals' || preset === 'xray') return color;
		var rgb = color.map(function (c) { return Math.max(0, Math.min(1, Number(c))); });
		var luminance = 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
		var target = preset === 'solid'
			? Math.max(0.58, Math.min(0.76, 0.68 + (luminance - 0.68) * 0.12))
			: Math.max(0.44, Math.min(0.58, 0.51 + (luminance - 0.51) * 0.18));
		var scale = luminance > 1e-6 ? target / luminance : 1;
		return rgb.map(function (c) { return Math.max(0.30, Math.min(0.78, c * scale)); });
	}

	function baseColorFromMaterial(material) {
		var first = Array.isArray(material) ? material[0] : material;
		if (!first) return null;
		if (first.color) return [first.color.r, first.color.g, first.color.b];
		return null;
	}

	// ── Edge Rendering (from render_entry.js) ──────────────────────────────

	function addEdgeObjects(recs, options) {
		removeEdgeObjects();
		var lineColor = new THREE.Color(TECHNICAL_LINE_COLOR[0], TECHNICAL_LINE_COLOR[1], TECHNICAL_LINE_COLOR[2]).getHex();
		var lineWidth = options.edgeStyle === 'bold' ? 2.4 : 1.65;

		for (var i = 0; i < recs.length; i++) {
			var record = recs[i];
			var edgeGeometry = new THREE.EdgesGeometry(
				record.mesh.geometry,
				options.renderMode === 'wireframe' ? 1 : 18
			);
			var geometry = lineSegmentsGeometryFromEdges(edgeGeometry);
			edgeGeometry.dispose();

			var depthTest = options.renderMode !== 'wireframe' || options.hiddenLines !== 'all';
			var material = new LineMaterial({
				color: lineColor,
				linewidth: lineWidth,
				transparent: false,
				opacity: 1,
				depthTest: depthTest,
				depthWrite: false,
			});
			var edges = new LineSegments2(geometry, material);
			record.mesh.add(edges);
			record.edgeMaterials = record.edgeMaterials || [];
			record.edgeMaterials.push(material);
			edgeObjects.push(edges);
		}
		syncLineResolutions();
	}

	function removeEdgeObjects() {
		for (var i = 0; i < edgeObjects.length; i++) {
			var obj = edgeObjects[i];
			if (obj.parent) obj.parent.remove(obj);
			if (obj.geometry) obj.geometry.dispose();
			if (obj.material) obj.material.dispose();
		}
		edgeObjects = [];
		records.forEach(function (r) { r.edgeMaterials = []; });
	}

	function lineSegmentsGeometryFromEdges(edgeGeometry) {
		var source = edgeGeometry.getAttribute('position');
		var positions = new Float32Array(source.count * 3);
		for (var i = 0; i < source.count; i++) {
			positions[i * 3] = source.getX(i);
			positions[i * 3 + 1] = source.getY(i);
			positions[i * 3 + 2] = source.getZ(i);
		}
		var geometry = new LineSegmentsGeometry();
		geometry.setPositions(positions);
		return geometry;
	}

	function syncLineResolutions() {
		var w = renderer.domElement.width;
		var h = renderer.domElement.height;
		records.forEach(function (r) {
			(r.edgeMaterials || []).forEach(function (m) {
				m.resolution.set(w, h);
			});
		});
	}

	// ── Render Modes ───────────────────────────────────────────────────────

	function setPreset(preset) {
		currentPreset = preset;
		var isWire = preset === 'wire';
		applyMaterials(records, {
			preset: isWire ? 'solid' : preset,
			colorBy: 'step',
			modelColor: DEFAULT_MODEL_COLOR,
			componentOrder: new Map(),
			renderMode: isWire ? 'wireframe' : 'solid',
			hiddenLines: 'off',
		});
		if (edgesEnabled || isWire) {
			addEdgeObjects(records, {
				renderMode: isWire ? 'wireframe' : 'solid',
				edgeStyle: isWire ? 'bold' : edgeStyle,
				hiddenLines: 'off',
			});
		}
	}

	function toggleEdges() {
		edgesEnabled = !edgesEnabled;
		if (edgesEnabled) {
			addEdgeObjects(records, { renderMode: 'solid', edgeStyle: edgeStyle, hiddenLines: 'off' });
		} else {
			removeEdgeObjects();
		}
	}

	// ── Animation ──────────────────────────────────────────────────────────

	function startAnimation() {
		if (animating) return;
		animating = true;
		animate();
	}

	function animate() {
		if (!animating) return;
		requestAnimationFrame(animate);
		controls.update();
		renderer.render(scene, camera);
	}

	// ── Resize ─────────────────────────────────────────────────────────────

	function onResize() {
		var w = canvasHost.clientWidth;
		var h = canvasHost.clientHeight;
		if (w === 0 || h === 0) return;
		camera.aspect = w / h;
		camera.updateProjectionMatrix();
		renderer.setSize(w, h);
		syncLineResolutions();
	}

	// ── Theme ──────────────────────────────────────────────────────────────

	function setTheme(dark) {
		isDark = dark;
		document.body.classList.toggle('light', !dark);
		if (renderer) {
			renderer.setClearColor(new THREE.Color(dark ? 0x1e1e1e : 0xffffff), 1);
		}
	}

	// ── Toolbar Events ─────────────────────────────────────────────────────

	function setupToolbar() {
		if (toolbarBound) return; // 幂等：只绑一次，避免 load 多次重复
		toolbarBound = true;

		// Preset buttons
		document.querySelectorAll('[data-preset]').forEach(function (btn) {
			btn.addEventListener('click', function () {
				document.querySelectorAll('[data-preset]').forEach(function (b) { b.classList.remove('active'); });
				btn.classList.add('active');
				setPreset(btn.getAttribute('data-preset'));
			});
		});

		// View preset buttons
		document.querySelectorAll('[data-view]').forEach(function (btn) {
			btn.addEventListener('click', function () {
				var viewName = btn.getAttribute('data-view');
				var view = VIEW_PRESETS[viewName];
				if (view) setCameraFromView(view);
			});
		});

		// Edge toggle
		var edgeBtn = document.getElementById('step-edges');
		if (edgeBtn) {
			edgeBtn.addEventListener('click', function () {
				edgeBtn.classList.toggle('active');
				toggleEdges();
			});
		}

		// Fit button
		var fitBtn = document.getElementById('step-fit');
		if (fitBtn) {
			fitBtn.addEventListener('click', fitCameraToIso);
		}

		// Refresh button —— 通知 main 端销毁并重建 webview，比 Reload Window 快。
		var refreshBtn = document.getElementById('step-refresh');
		if (refreshBtn) {
			refreshBtn.addEventListener('click', function () {
				vscode.postMessage({ kind: 'reloadRequest' });
			});
		}
	}

	// ── Message Handler ────────────────────────────────────────────────────

	window.addEventListener('message', function (event) {
		var msg = event.data;
		if (!msg || !msg.kind) return;

		if (msg.kind === 'load') {
			if (msg.bytes) {
				if (!renderer) initScene();
				if (msg.fileName) filenameEl.textContent = msg.fileName;
				setTheme(msg.isDark !== false);
				if (msg.format === 'stl') {
					loadStl(msg.bytes);
				} else {
					loadGlb(msg.bytes);
				}
			}
		} else if (msg.kind === 'theme') {
			setTheme(msg.isDark);
		} else if (msg.kind === 'progress') {
			if (msg.isError || msg.stage === 'error') {
				showError(msg.message || 'Unknown error');
			} else {
				loadingText.textContent = msg.message || 'Loading...';
			}
		}
	});

	// 立刻绑定工具栏，让「重载视图」按钮在 load 到来之前也可用——
	// 否则如果初次 load 卡死，用户连营救按钮都点不到。
	setupToolbar();

	// Signal ready
	vscode.postMessage({ kind: 'ready' });
})();
