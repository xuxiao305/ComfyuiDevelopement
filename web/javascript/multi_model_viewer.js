/**
 * ComfyUI-MultiModel3D: MultiModelViewer Frontend
 *
 * Three.js-based GLB viewer with per-sub-model control:
 * - Sub-model list with visibility toggle (👁) and focus (🎯)
 * - Explode view slider
 * - Camera orbit controls
 * - Screenshot capture for ComfyUI pipeline
 */

import { app } from "../../../scripts/app.js";
import { api } from "../../../scripts/api.js";

// ---------------------------------------------------------------------------
// Three.js Loader (local files served by ComfyUI, no internet required)
// ---------------------------------------------------------------------------
// Three.js files are stored in web/lib/three/ and served via ComfyUI's
// /extensions/ endpoint. This avoids requiring internet access.

let THREE = null;
let OrbitControls = null;
let GLTFLoader = null;

async function loadThreeJS() {
    if (THREE) return;

    // Local path: ComfyUI serves custom node web/ files at /extensions/<node_name>/
    const THREE_BASE = "extensions/ComfyUI-MultiModel3D/lib/three";

    try {
        // Load Three.js core
        const threeModule = await import(`/${THREE_BASE}/three.module.js`);
        THREE = threeModule.default || threeModule;

        // Load OrbitControls
        const orbitModule = await import(`/${THREE_BASE}/OrbitControls.js`);
        OrbitControls = orbitModule.OrbitControls;

        // Load GLTFLoader
        const gltfModule = await import(`/${THREE_BASE}/GLTFLoader.js`);
        GLTFLoader = gltfModule.GLTFLoader;

        console.log("[MultiModelViewer] Three.js loaded from local files");
    } catch (e) {
        console.error("[MultiModelViewer] Failed to load Three.js from local:", e);

        // Fallback: try CDN (requires internet)
        try {
            const THREE_VERSION = "0.170.0";
            const CDN = `https://unpkg.com/three@${THREE_VERSION}`;
            const threeModule = await import(`${CDN}/build/three.module.js`);
            THREE = threeModule.default || threeModule;

            const orbitModule = await import(`${CDN}/examples/jsm/controls/OrbitControls.js`);
            OrbitControls = orbitModule.OrbitControls;

            const gltfModule = await import(`${CDN}/examples/jsm/loaders/GLTFLoader.js`);
            GLTFLoader = gltfModule.GLTFLoader;

            console.log("[MultiModelViewer] Three.js loaded from CDN fallback");
        } catch (e2) {
            console.error("[MultiModelViewer] CDN fallback also failed:", e2);
            throw new Error("Could not load Three.js. Check that the local files exist in web/lib/three/ or internet is available.");
        }
    }
}


// ---------------------------------------------------------------------------
// MultiModelViewer Widget
// ---------------------------------------------------------------------------
class MultiModelViewerWidget {
    constructor(node, container) {
        this.node = node;
        this.container = container;

        // State
        this.subModels = [];
        this.sceneCenter = null;  // Initialized after Three.js loads
        this.explodeFactor = 0;
        this.isDragging = false;

        // Three.js objects (initialized in initThree)
        this.renderer = null;
        this.scene = null;
        this.camera = null;
        this.controls = null;
        this.gltfScene = null;
        this.animationId = null;

        // Build UI
        this.buildUI();
    }

    buildUI() {
        // Container styling
        this.container.style.position = "relative";
        this.container.style.width = "100%";
        this.container.style.height = "520px";
        this.container.style.background = "#1a1a2e";
        this.container.style.borderRadius = "8px";
        this.container.style.overflow = "hidden";
        this.container.style.display = "flex";
        this.container.style.flexDirection = "row";

        // Left: 3D viewport
        this.viewportDiv = document.createElement("div");
        this.viewportDiv.style.flex = "1";
        this.viewportDiv.style.position = "relative";
        this.viewportDiv.style.minWidth = "0";
        this.container.appendChild(this.viewportDiv);

        // Right: control panel
        this.panelDiv = document.createElement("div");
        this.panelDiv.style.width = "200px";
        this.panelDiv.style.minWidth = "200px";
        this.panelDiv.style.background = "#16213e";
        this.panelDiv.style.borderLeft = "1px solid #0f3460";
        this.panelDiv.style.display = "flex";
        this.panelDiv.style.flexDirection = "column";
        this.panelDiv.style.overflow = "hidden";
        this.container.appendChild(this.panelDiv);

        // Panel header
        const panelHeader = document.createElement("div");
        panelHeader.style.padding = "8px 10px";
        panelHeader.style.background = "#0f3460";
        panelHeader.style.color = "#e0e0e0";
        panelHeader.style.fontSize = "12px";
        panelHeader.style.fontWeight = "bold";
        panelHeader.style.borderBottom = "1px solid #1a1a5e";
        panelHeader.textContent = "📦 Sub-Models";
        this.panelDiv.appendChild(panelHeader);

        // Sub-model list
        this.modelListDiv = document.createElement("div");
        this.modelListDiv.style.flex = "1";
        this.modelListDiv.style.overflowY = "auto";
        this.modelListDiv.style.padding = "4px 0";
        this.modelListDiv.id = "multimodel-list";
        this.panelDiv.appendChild(this.modelListDiv);

        // Explode view section
        const explodeSection = document.createElement("div");
        explodeSection.style.borderTop = "1px solid #0f3460";
        explodeSection.style.padding = "10px";
        explodeSection.style.background = "#16213e";
        this.panelDiv.appendChild(explodeSection);

        const explodeLabel = document.createElement("div");
        explodeLabel.style.color = "#a0a0c0";
        explodeLabel.style.fontSize = "11px";
        explodeLabel.style.marginBottom = "6px";
        explodeLabel.textContent = "💥 Explode View";
        explodeSection.appendChild(explodeLabel);

        this.explodeSlider = document.createElement("input");
        this.explodeSlider.type = "range";
        this.explodeSlider.min = "0";
        this.explodeSlider.max = "200";
        this.explodeSlider.value = "0";
        this.explodeSlider.style.width = "100%";
        this.explodeSlider.style.cursor = "pointer";
        this.explodeSlider.addEventListener("input", (e) => {
            const rawVal = parseFloat(e.target.value);
            this.explodeFactor = rawVal / 100;
            console.log(`[MultiModelViewer] Explode: raw=${rawVal}, factor=${this.explodeFactor.toFixed(3)}, subModels=${this.subModels.length}`);
            this.applyExplode();
        });
        explodeSection.appendChild(this.explodeSlider);

        // Loading overlay
        this.loadingDiv = document.createElement("div");
        this.loadingDiv.style.position = "absolute";
        this.loadingDiv.style.top = "0";
        this.loadingDiv.style.left = "0";
        this.loadingDiv.style.right = "200px";
        this.loadingDiv.style.bottom = "0";
        this.loadingDiv.style.display = "flex";
        this.loadingDiv.style.alignItems = "center";
        this.loadingDiv.style.justifyContent = "center";
        this.loadingDiv.style.background = "rgba(26, 26, 46, 0.8)";
        this.loadingDiv.style.color = "#e0e0e0";
        this.loadingDiv.style.fontSize = "14px";
        this.loadingDiv.style.zIndex = "10";
        this.loadingDiv.textContent = "Loading 3D model...";
        this.loadingDiv.style.display = "none";
        this.container.appendChild(this.loadingDiv);

        // Error overlay
        this.errorDiv = document.createElement("div");
        this.errorDiv.style.position = "absolute";
        this.errorDiv.style.top = "0";
        this.errorDiv.style.left = "0";
        this.errorDiv.style.right = "200px";
        this.errorDiv.style.bottom = "0";
        this.errorDiv.style.display = "none";
        this.errorDiv.style.alignItems = "center";
        this.errorDiv.style.justifyContent = "center";
        this.errorDiv.style.background = "rgba(46, 26, 26, 0.9)";
        this.errorDiv.style.color = "#ff6b6b";
        this.errorDiv.style.fontSize = "13px";
        this.errorDiv.style.padding = "20px";
        this.errorDiv.style.zIndex = "11";
        this.container.appendChild(this.errorDiv);
    }

    async initThree() {
        if (this.renderer) return;

        await loadThreeJS();

        const width = this.viewportDiv.clientWidth || 320;
        const height = this.viewportDiv.clientHeight || 520;

        // Scene
        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color(0x1a1a2e);

        // Camera
        this.camera = new THREE.PerspectiveCamera(50, width / height, 0.01, 1000);
        this.camera.position.set(0, 1.5, 3);

        // Renderer
        this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
        this.renderer.setSize(width, height);
        this.renderer.setPixelRatio(window.devicePixelRatio);
        this.renderer.outputColorSpace = THREE.SRGBColorSpace;
        this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
        this.renderer.toneMappingExposure = 1.0;
        this.viewportDiv.appendChild(this.renderer.domElement);

        // Stop event propagation to prevent ComfyUI canvas conflicts
        const canvas = this.renderer.domElement;
        canvas.addEventListener("pointerdown", (e) => e.stopPropagation());
        canvas.addEventListener("wheel", (e) => e.stopPropagation());
        canvas.addEventListener("pointermove", (e) => { if (this.isDragging) e.stopPropagation(); });
        canvas.addEventListener("mousedown", () => { this.isDragging = true; });
        canvas.addEventListener("mouseup", () => { this.isDragging = false; });

        // Controls
        this.controls = new OrbitControls(this.camera, canvas);
        this.controls.enableDamping = true;
        this.controls.dampingFactor = 0.08;
        this.controls.target.set(0, 0, 0);

        // Lighting
        const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
        this.scene.add(ambientLight);

        const dirLight1 = new THREE.DirectionalLight(0xffffff, 0.8);
        dirLight1.position.set(5, 5, 5);
        this.scene.add(dirLight1);

        const dirLight2 = new THREE.DirectionalLight(0xffffff, 0.3);
        dirLight2.position.set(-5, 3, -5);
        this.scene.add(dirLight2);

        // Grid helper
        const grid = new THREE.GridHelper(10, 20, 0x444466, 0x222244);
        this.scene.add(grid);

        // Resize observer
        const resizeObserver = new ResizeObserver(() => this.onResize());
        resizeObserver.observe(this.viewportDiv);

        // Start render loop
        this.animate();
    }

    animate() {
        this.animationId = requestAnimationFrame(() => this.animate());
        if (this.controls) {
            this.controls.update();
        }
        if (this.renderer && this.scene && this.camera) {
            this.renderer.render(this.scene, this.camera);
        }
    }

    onResize() {
        if (!this.renderer || !this.camera) return;
        const width = this.viewportDiv.clientWidth;
        const height = this.viewportDiv.clientHeight;
        if (width <= 0 || height <= 0) return;
        this.camera.aspect = width / height;
        this.camera.updateProjectionMatrix();
        this.renderer.setSize(width, height);
    }

    async loadModel(filename) {
        this.loadingDiv.style.display = "flex";
        this.errorDiv.style.display = "none";

        try {
            await this.initThree();

            // Remove previous model
            if (this.gltfScene) {
                this.scene.remove(this.gltfScene);
                this.gltfScene = null;
            }

            // Build URL for the GLB file
            const url = this.getViewUrl(filename);

            // Load GLB
            const loader = new GLTFLoader();
            const gltf = await new Promise((resolve, reject) => {
                loader.load(url, resolve, undefined, reject);
            });

            this.gltfScene = gltf.scene;

            // Center and scale the model
            const box = new THREE.Box3().setFromObject(this.gltfScene);
            const center = box.getCenter(new THREE.Vector3());
            const size = box.getSize(new THREE.Vector3());
            const maxDim = Math.max(size.x, size.y, size.z);
            const scale = maxDim > 0 ? 2.0 / maxDim : 1.0;

            this.gltfScene.scale.setScalar(scale);
            this.gltfScene.position.sub(center.multiplyScalar(scale));

            this.scene.add(this.gltfScene);

            // Enumerate sub-models
            this.enumerateSubModels();

            // Position camera to see the whole model
            const scaledBox = new THREE.Box3().setFromObject(this.gltfScene);
            const scaledSize = scaledBox.getSize(new THREE.Vector3());
            const scaledCenter = scaledBox.getCenter(new THREE.Vector3());
            const dist = Math.max(scaledSize.x, scaledSize.y, scaledSize.z) * 1.5;

            this.camera.position.set(scaledCenter.x + dist * 0.5, scaledCenter.y + dist * 0.5, scaledCenter.z + dist);
            this.controls.target.copy(scaledCenter);
            this.controls.update();

            this.loadingDiv.style.display = "none";

        } catch (e) {
            console.error("[MultiModelViewer] Failed to load model:", e);
            this.loadingDiv.style.display = "none";
            this.errorDiv.textContent = `Error: ${e.message || "Failed to load 3D model"}`;
            this.errorDiv.style.display = "flex";
        }
    }

    getViewUrl(filename) {
        // Construct /view endpoint URL
        if (filename.startsWith("http")) return filename;

        // Determine folder type
        let folderType = "output";
        if (filename.includes("input") || filename.startsWith("input/")) {
            folderType = "input";
        } else if (filename.includes("temp") || filename.startsWith("temp/")) {
            folderType = "temp";
        }

        const cleanName = filename.replace(/^(input|output|temp)\//, "");
        return api.apiURL(`/view?filename=${encodeURIComponent(cleanName)}&type=${folderType}&t=${Date.now()}`);
    }

    enumerateSubModels() {
        this.subModels = [];

        if (!this.gltfScene) return;

        // -------------------------------------------------------------------
        // Strategy: traverse the scene graph and collect all Mesh nodes.
        // Then group them by MergeGLB prefix (e.g. "0_", "1_") so each
        // original GLB file becomes one sub-model entry.
        //
        // GLB structure from trimesh merge:
        //   Scene
        //     └─ root (Group, name="")
        //          ├─ "0_nodeName" (Mesh)
        //          ├─ "0_anotherNode" (Mesh)
        //          ├─ "1_nodeName" (Mesh)
        //          └─ ...
        //
        // If a mesh has no prefix, it becomes its own sub-model.
        // -------------------------------------------------------------------

        // Step 1: Collect all Mesh nodes with their world positions
        const meshInfos = [];
        this.gltfScene.traverse((obj) => {
            if (!obj.isMesh) return;
            // Skip non-visual or helper objects
            if (obj.isLight || obj.isGridHelper || obj.isCamera) return;

            const worldCenter = new THREE.Vector3();
            obj.getWorldPosition(worldCenter);

            const box = new THREE.Box3().setFromObject(obj);

            meshInfos.push({
                object: obj,
                name: obj.name || "unnamed",
                worldCenter,
                boundingBox: box,
            });
        });

        // Step 2: Group meshes by prefix
        // Prefix = first segment before "_" if it's a number (e.g. "0_body" → group "0")
        const groupMap = new Map(); // groupKey → { meshes: [], displayName: string }
        let autoGroup = 0;

        for (const info of meshInfos) {
            let groupKey = null;
            let displayName = info.name;

            if (info.name.includes("_")) {
                const prefix = info.name.split("_")[0];
                if (!isNaN(prefix) && prefix !== "") {
                    groupKey = prefix;
                    // Strip prefix for display: "0_body" → "body"
                    displayName = info.name.substring(prefix.length + 1);
                }
            }

            if (groupKey === null) {
                // No numeric prefix — each mesh is its own group
                groupKey = `_auto_${autoGroup++}`;
            }

            if (!groupMap.has(groupKey)) {
                groupMap.set(groupKey, {
                    meshes: [],
                    displayName: displayName,
                    groupKey,
                });
            }
            groupMap.get(groupKey).meshes.push({
                ...info,
                displayName,
            });
        }

        // Step 3: Create sub-model entries from groups
        for (const [groupKey, group] of groupMap) {
            // Compute combined bounding box and world center
            const combinedBox = new THREE.Box3();
            const combinedCenter = new THREE.Vector3(0, 0, 0);
            for (const m of group.meshes) {
                combinedBox.union(m.boundingBox);
                combinedCenter.add(m.worldCenter);
            }
            combinedCenter.divideScalar(group.meshes.length);

            // Use the first mesh's parent group as the "object" for visibility toggle,
            // or the individual mesh if it's a single-mesh group.
            // For multi-mesh groups, we need a wrapper approach: toggle all meshes.
            const isNumericGroup = !groupKey.startsWith("_auto_");

            this.subModels.push({
                // For single-mesh groups, reference the mesh directly.
                // For multi-mesh groups, store the array for bulk operations.
                object: group.meshes.length === 1 ? group.meshes[0].object : null,
                meshes: group.meshes.map(m => m.object),
                name: groupKey,
                displayName: isNumericGroup
                    ? `Model ${parseInt(groupKey) + 1}` + (group.meshes.length > 1 ? ` (${group.meshes.length} parts)` : ` — ${group.displayName}`)
                    : group.displayName,
                group: groupKey,
                visible: true,
                originalWorldCenter: combinedCenter.clone(),
                originalPositions: group.meshes.map(m => m.object.position.clone()),
                boundingBox: combinedBox,
            });
        }

        // Sort by group key (numeric groups first, in order)
        this.subModels.sort((a, b) => {
            const aNum = parseInt(a.group);
            const bNum = parseInt(b.group);
            if (!isNaN(aNum) && !isNaN(bNum)) return aNum - bNum;
            if (!isNaN(aNum)) return -1;
            if (!isNaN(bNum)) return 1;
            return a.name.localeCompare(b.name);
        });

        // Calculate scene center for explode view
        this.sceneCenter = new THREE.Vector3(0, 0, 0);
        if (this.subModels.length > 0) {
            for (const m of this.subModels) {
                this.sceneCenter.add(m.originalWorldCenter);
            }
            this.sceneCenter.divideScalar(this.subModels.length);
        }

        console.log(`[MultiModelViewer] Found ${this.subModels.length} sub-models from ${meshInfos.length} meshes`);
        for (const m of this.subModels) {
            console.log(`  - ${m.displayName} (${m.meshes.length} meshes)`);
        }

        // Build model list UI
        this.buildModelListUI();
    }

    buildModelListUI() {
        this.modelListDiv.innerHTML = "";

        if (this.subModels.length === 0) {
            const emptyMsg = document.createElement("div");
            emptyMsg.style.padding = "8px 10px";
            emptyMsg.style.color = "#666688";
            emptyMsg.style.fontSize = "11px";
            emptyMsg.textContent = "No sub-models found";
            this.modelListDiv.appendChild(emptyMsg);
            return;
        }

        // Group sub-models by prefix
        const groups = {};
        for (let i = 0; i < this.subModels.length; i++) {
            const m = this.subModels[i];
            if (!groups[m.group]) {
                groups[m.group] = [];
            }
            groups[m.group].push({ ...m, index: i });
        }

        // If only one group or no meaningful grouping, show flat list
        const groupKeys = Object.keys(groups);
        const showGroups = groupKeys.length > 1;

        for (const groupKey of groupKeys) {
            if (showGroups) {
                // Group header
                const groupHeader = document.createElement("div");
                groupHeader.style.padding = "6px 10px 3px";
                groupHeader.style.color = "#8888aa";
                groupHeader.style.fontSize = "10px";
                groupHeader.style.fontWeight = "bold";
                groupHeader.style.textTransform = "uppercase";
                groupHeader.style.letterSpacing = "0.5px";
                groupHeader.textContent = `Group ${groupKey}`;
                this.modelListDiv.appendChild(groupHeader);
            }

            for (const model of groups[groupKey]) {
                const row = this.createModelRow(model, showGroups);
                this.modelListDiv.appendChild(row);
            }
        }
    }

    createModelRow(model, indented) {
        const row = document.createElement("div");
        row.style.display = "flex";
        row.style.alignItems = "center";
        row.style.padding = "4px 8px";
        row.style.paddingLeft = indented ? "16px" : "8px";
        row.style.gap = "4px";
        row.style.cursor = "default";
        row.style.transition = "background 0.15s";
        row.dataset.index = model.index;

        row.addEventListener("mouseenter", () => {
            row.style.background = "rgba(15, 52, 96, 0.5)";
        });
        row.addEventListener("mouseleave", () => {
            row.style.background = "transparent";
        });

        // Name
        const nameSpan = document.createElement("span");
        nameSpan.style.flex = "1";
        nameSpan.style.color = "#c0c0d0";
        nameSpan.style.fontSize = "11px";
        nameSpan.style.overflow = "hidden";
        nameSpan.style.textOverflow = "ellipsis";
        nameSpan.style.whiteSpace = "nowrap";
        nameSpan.textContent = model.displayName;
        row.appendChild(nameSpan);

        // Visibility toggle 👁
        const visBtn = document.createElement("button");
        visBtn.style.background = "none";
        visBtn.style.border = "none";
        visBtn.style.cursor = "pointer";
        visBtn.style.fontSize = "14px";
        visBtn.style.padding = "2px 4px";
        visBtn.style.opacity = model.visible ? "1" : "0.4";
        visBtn.textContent = "👁";
        visBtn.title = "Toggle visibility";
        visBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            const idx = parseInt(row.dataset.index);
            this.toggleVisibility(idx);
            visBtn.style.opacity = this.subModels[idx].visible ? "1" : "0.4";
            nameSpan.style.opacity = this.subModels[idx].visible ? "1" : "0.4";
        });
        row.appendChild(visBtn);

        // Focus button 🎯
        const focusBtn = document.createElement("button");
        focusBtn.style.background = "none";
        focusBtn.style.border = "none";
        focusBtn.style.cursor = "pointer";
        focusBtn.style.fontSize = "13px";
        focusBtn.style.padding = "2px 4px";
        focusBtn.textContent = "🎯";
        focusBtn.title = "Focus on this model";
        focusBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            const idx = parseInt(row.dataset.index);
            this.focusOnModel(idx);
        });
        row.appendChild(focusBtn);

        return row;
    }

    toggleVisibility(index) {
        if (index < 0 || index >= this.subModels.length) return;
        const model = this.subModels[index];
        model.visible = !model.visible;
        // Toggle all meshes in this sub-model
        for (const mesh of model.meshes) {
            mesh.visible = model.visible;
        }
    }

    focusOnModel(index) {
        if (index < 0 || index >= this.subModels.length) return;
        const model = this.subModels[index];

        // Get current world center of the sub-model (live, not cached)
        // This handles cases where explode view has moved meshes
        const liveCenter = new THREE.Vector3(0, 0, 0);
        let meshCount = 0;
        for (const mesh of model.meshes) {
            const wp = new THREE.Vector3();
            mesh.getWorldPosition(wp);
            liveCenter.add(wp);
            meshCount++;
        }
        liveCenter.divideScalar(meshCount);

        // Current live bounding box
        const liveBox = new THREE.Box3();
        for (const mesh of model.meshes) {
            liveBox.expandByObject(mesh);
        }
        const size = liveBox.getSize(new THREE.Vector3());
        const maxDim = Math.max(size.x, size.y, size.z);
        const idealDist = maxDim * 2.5 || 2.0;

        console.log(`[MultiModelViewer] Focus on: ${model.displayName}, center=(${liveCenter.x.toFixed(2)},${liveCenter.y.toFixed(2)},${liveCenter.z.toFixed(2)}), size=${maxDim.toFixed(3)}, idealDist=${idealDist.toFixed(3)}`);

        // Keep current viewing angle: shift both target and camera by the same delta
        const startTarget = this.controls.target.clone();
        const endTarget = liveCenter.clone();
        const targetDelta = endTarget.clone().sub(startTarget);
        const endPos = this.camera.position.clone().add(targetDelta);

        // If current distance to new target is too close or too far, adjust along view direction
        const currentDist = endPos.clone().sub(endTarget).length();
        if (currentDist < idealDist * 0.3 || currentDist > idealDist * 3.0) {
            const viewDir = endPos.clone().sub(endTarget).normalize();
            endPos.copy(endTarget.clone().add(viewDir.multiplyScalar(idealDist)));
        }

        const startPos = this.camera.position.clone();
        const duration = 500;
        const startTime = performance.now();

        const animateCamera = () => {
            const elapsed = performance.now() - startTime;
            const t = Math.min(elapsed / duration, 1);
            // Ease out cubic
            const ease = 1 - Math.pow(1 - t, 3);

            this.controls.target.lerpVectors(startTarget, endTarget, ease);
            this.camera.position.lerpVectors(startPos, endPos, ease);
            this.controls.update();

            if (t < 1) {
                requestAnimationFrame(animateCamera);
            }
        };

        animateCamera();
    }

    applyExplode() {
        if (!this.gltfScene || this.subModels.length === 0 || !this.sceneCenter) return;

        // Calculate max explosion radius based on model size
        const sceneBox = new THREE.Box3().setFromObject(this.gltfScene);
        const sceneSize = sceneBox.getSize(new THREE.Vector3());
        const explodeRadius = Math.max(sceneSize.x, sceneSize.y, sceneSize.z) * 0.5;

        // Get gltfScene's world scale (we apply uniform scale in loadModel)
        this.gltfScene.updateWorldMatrix(true, false);
        const worldScale = new THREE.Vector3();
        this.gltfScene.matrixWorld.decompose(new THREE.Vector3(), new THREE.Quaternion(), worldScale);
        const uniformScale = worldScale.x; // uniform scale factor

        for (const model of this.subModels) {
            // Direction from scene center to model's original world position
            const direction = model.originalWorldCenter.clone().sub(this.sceneCenter);

            if (direction.length() < 0.001) {
                // Model is at center — use bounding box max axis direction
                const size = model.boundingBox.getSize(new THREE.Vector3());
                direction.set(size.x, size.y, size.z).normalize();
                if (direction.length() < 0.001) {
                    direction.set(1, 0, 0); // fallback
                }
            } else {
                direction.normalize();
            }

            // Calculate world-space offset magnitude
            const offsetMagnitude = this.explodeFactor * explodeRadius;

            // Convert world-space direction to local-space direction.
            // Since gltfScene has uniform scale, local direction = world direction,
            // but local magnitude = world magnitude / scale.
            const localOffset = direction.multiplyScalar(offsetMagnitude / uniformScale);

            // Apply offset to all meshes in this sub-model
            for (let mi = 0; mi < model.meshes.length; mi++) {
                const mesh = model.meshes[mi];
                const origPos = model.originalPositions[mi];
                mesh.position.copy(origPos.clone().add(localOffset));
            }
        }
    }

    captureScreenshot() {
        if (!this.renderer) return null;

        // Render one frame to ensure buffer is current
        this.renderer.render(this.scene, this.camera);

        // Get data URL
        const dataUrl = this.renderer.domElement.toDataURL("image/png");
        return dataUrl;
    }

    dispose() {
        if (this.animationId) {
            cancelAnimationFrame(this.animationId);
        }
        if (this.renderer) {
            this.renderer.dispose();
        }
        if (this.gltfScene) {
            this.gltfScene.traverse((child) => {
                if (child.isMesh) {
                    child.geometry?.dispose();
                    if (child.material) {
                        if (Array.isArray(child.material)) {
                            child.material.forEach(m => m.dispose());
                        } else {
                            child.material.dispose();
                        }
                    }
                }
            });
        }
    }
}


// ---------------------------------------------------------------------------
// ComfyUI Node Registration
// ---------------------------------------------------------------------------
function get_position_style(ctx) {
    /** Returns CSS transform string for widget positioning over the LiteGraph canvas. */
    return `transform: translate(${ctx.node.pos[0]}px, ${ctx.node.pos[1]}px)`;
}

app.registerExtension({
    name: "ComfyUI.MultiModel3D.MultiModelViewer",

    async beforeRegisterNodeDef(nodeType, nodeData, app) {
        if (nodeData.name !== "MultiModelViewer") return;

        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const result = onNodeCreated?.apply(this, arguments);

            // Create container div
            const container = document.createElement("div");
            container.classList.add("multimodel-viewer-container");

            // Create the viewer widget
            this.multimodelViewer = new MultiModelViewerWidget(this, container);

            // Add DOM widget
            const widget = this.addDOMWidget("multimodel3d", "custom", container, {
                serialize: false,
                getValue: () => "",
                setValue: () => {},
            });

            // Style the container for LiteGraph canvas overlay
            widget.parentWidget = this;

            // Resize handling
            const onResize = this.onResize;
            this.onResize = function () {
                onResize?.apply(this, arguments);
                // Trigger ResizeObserver
            };

            return result;
        };

        // Handle execution: load model when data arrives
        const onExecuted = nodeType.prototype.onExecuted;
        nodeType.prototype.onExecuted = function (message) {
            const result = onExecuted?.apply(this, arguments);

            if (message?.result) {
                const [filename, cameraInfo, bgImagePath] = message.result;
                if (filename && this.multimodelViewer) {
                    this.multimodelViewer.loadModel(filename);
                }
            }

            return result;
        };

        // Cleanup on remove
        const onRemoved = nodeType.prototype.onRemoved;
        nodeType.prototype.onRemoved = function () {
            if (this.multimodelViewer) {
                this.multimodelViewer.dispose();
            }
            return onRemoved?.apply(this, arguments);
        };
    },
});
