/**
 * SAM3 Multi-Prompt Collector Widget (v2 Row Layout)
 *
 * UI Layout:
 *   Canvas (drawing area) at top
 *   Region list at bottom, each row = one region:
 *     [color dot] [R1] [text prompt input____] [2p1b] [x]
 *   Last row: [+ Add Region]
 *
 * Version: 2025-04-15-v2-ROWLAYOUT
 */

import { app } from "../../scripts/app.js";

console.log("[SAM3] ===== MULTI-PROMPT COLLECTOR V2 (Row Layout) =====");

const PROMPT_COLORS = [
    { name: "cyan",    primary: "#00FFFF", dim: "#006666" },
    { name: "yellow",  primary: "#FFFF00", dim: "#666600" },
    { name: "magenta", primary: "#FF00FF", dim: "#660066" },
    { name: "lime",    primary: "#00FF00", dim: "#006600" },
    { name: "orange",  primary: "#FF8000", dim: "#663300" },
    { name: "pink",    primary: "#FF69B4", dim: "#662944" },
    { name: "blue",    primary: "#4169E1", dim: "#1a2a5c" },
    { name: "teal",    primary: "#20B2AA", dim: "#0d4744" },
];

const MAX_PROMPTS = PROMPT_COLORS.length;

function hideWidgetForGood(node, widget, suffix = '') {
    if (!widget) return;
    widget.origType = widget.type;
    widget.origComputeSize = widget.computeSize;
    widget.computeSize = () => [0, -4];
    widget.type = "converted-widget" + suffix;
    widget.hidden = true;
    if (widget.element) {
        widget.element.style.display = "none";
        widget.element.style.visibility = "hidden";
    }
}

app.registerExtension({
    name: "Comfy.SAM3.TextClickCollector",

    async beforeRegisterNodeDef(nodeType, nodeData, app) {
        if (nodeData.name !== "SAM3TextClickCollector") return;

        console.log("[SAM3] Registering SAM3TextClickCollector (v2 row layout)");
        const onNodeCreated = nodeType.prototype.onNodeCreated;

        nodeType.prototype.onNodeCreated = function () {
            const result = onNodeCreated?.apply(this, arguments);

            // -- Main container --
            const container = document.createElement("div");
            container.style.cssText = "position: relative; width: 100%; background: #222; overflow: hidden; box-sizing: border-box; display: flex; flex-direction: column;";

            // -- Info bar (overlay on canvas) --
            const infoBar = document.createElement("div");
            infoBar.style.cssText = "position: absolute; top: 5px; left: 5px; right: 5px; z-index: 10; display: flex; justify-content: space-between; align-items: center;";
            container.appendChild(infoBar);

            const counter = document.createElement("div");
            counter.style.cssText = "padding: 5px 10px; background: rgba(0,0,0,0.7); color: #fff; border-radius: 3px; font-size: 12px; font-family: monospace;";
            counter.textContent = "Region 1: 0 pts, 0 boxes";
            infoBar.appendChild(counter);

            const buttonContainer = document.createElement("div");
            buttonContainer.style.cssText = "display: flex; gap: 5px;";
            infoBar.appendChild(buttonContainer);

            const clearPromptBtn = document.createElement("button");
            clearPromptBtn.textContent = "Clear Region";
            clearPromptBtn.style.cssText = "padding: 5px 10px; background: #a50; color: #fff; border: 1px solid #830; border-radius: 3px; cursor: pointer; font-size: 11px;";
            clearPromptBtn.onmouseover = () => clearPromptBtn.style.background = "#c60";
            clearPromptBtn.onmouseout = () => clearPromptBtn.style.background = "#a50";
            buttonContainer.appendChild(clearPromptBtn);

            const clearAllBtn = document.createElement("button");
            clearAllBtn.textContent = "Clear All";
            clearAllBtn.style.cssText = "padding: 5px 10px; background: #d44; color: #fff; border: 1px solid #a22; border-radius: 3px; cursor: pointer; font-size: 11px;";
            clearAllBtn.onmouseover = () => clearAllBtn.style.background = "#e55";
            clearAllBtn.onmouseout = () => clearAllBtn.style.background = "#d44";
            buttonContainer.appendChild(clearAllBtn);

            // -- Canvas wrapper --
            const canvasWrapper = document.createElement("div");
            canvasWrapper.style.cssText = "flex: 1; display: flex; align-items: center; justify-content: center; min-height: 200px;";
            container.appendChild(canvasWrapper);

            const canvas = document.createElement("canvas");
            canvas.width = 512;
            canvas.height = 512;
            canvas.style.cssText = "display: block; max-width: 100%; max-height: 100%; object-fit: contain; cursor: crosshair;";
            canvasWrapper.appendChild(canvas);

            const ctx = canvas.getContext("2d");

            // -- Region list panel (below canvas) --
            const regionPanel = document.createElement("div");
            regionPanel.style.cssText = "display: flex; flex-direction: column; gap: 3px; padding: 6px 8px; background: #1a1a1a; border-top: 1px solid #333; max-height: 260px; overflow-y: auto;";
            container.appendChild(regionPanel);

            // -- Store state --
            this.canvasWidget = {
                canvas, ctx, container, canvasWrapper,
                image: null,
                prompts: [{
                    positive_points: [],
                    negative_points: [],
                    positive_boxes: [],
                    negative_boxes: [],
                    text_prompt: ""
                }],
                activePromptIndex: 0,
                currentBox: null,
                isDrawingBox: false,
                hoveredItem: null,
                regionPanel, counter,
                textInputs: [],
            };

            const widget = this.addDOMWidget("canvas", "customCanvas", container);
            this.canvasWidget.domWidget = widget;

            widget.computeSize = (width) => {
                const nodeHeight = this.size ? this.size[1] : 560;
                return [width, Math.max(290, nodeHeight - 80)];
            };

            this.rebuildRegionList();

            // -- Button handlers --
            clearPromptBtn.addEventListener("click", (e) => {
                e.preventDefault(); e.stopPropagation();
                this.clearActivePrompt();
            });
            clearAllBtn.addEventListener("click", (e) => {
                e.preventDefault(); e.stopPropagation();
                this.clearAllPrompts();
            });

            // -- Hide storage widget --
            const storeWidget = this.widgets.find(w => w.name === "multi_prompts_store");
            if (storeWidget) {
                storeWidget.value = storeWidget.value || "[]";
                this._hiddenWidgets = { multi_prompts_store: storeWidget };
                hideWidgetForGood(this, storeWidget);
            }

            // -- Override onDrawForeground --
            const originalDrawForeground = this.onDrawForeground;
            this.onDrawForeground = function(ctx) {
                const hiddenWidgets = this.widgets.filter(w => w.type?.includes("converted-widget"));
                const origTypes = hiddenWidgets.map(w => w.type);
                hiddenWidgets.forEach(w => w.type = null);
                if (originalDrawForeground) originalDrawForeground.apply(this, arguments);
                hiddenWidgets.forEach((w, i) => w.type = origTypes[i]);
                const ch = Math.max(290, this.size[1] - 80);
                if (container.style.height !== ch + "px") container.style.height = ch + "px";
            };

            // -- Canvas mouse events --
            canvas.addEventListener("mousedown", (e) => {
                if (document.activeElement?.tagName === "INPUT") return;
                const rect = canvas.getBoundingClientRect();
                const x = ((e.clientX - rect.left) / rect.width) * canvas.width;
                const y = ((e.clientY - rect.top) / rect.height) * canvas.height;
                const activePrompt = this.canvasWidget.prompts[this.canvasWidget.activePromptIndex];
                const isNegative = e.button === 2;

                if (e.shiftKey) {
                    this.canvasWidget.currentBox = { x1: x, y1: y, x2: x, y2: y, isNegative };
                    this.canvasWidget.isDrawingBox = true;
                    return;
                }
                const pointList = isNegative ? activePrompt.negative_points : activePrompt.positive_points;
                pointList.push({ x, y });
                this.updateStorage();
                this.redrawCanvas();
            });

            canvas.addEventListener("mousemove", (e) => {
                const rect = canvas.getBoundingClientRect();
                const x = ((e.clientX - rect.left) / rect.width) * canvas.width;
                const y = ((e.clientY - rect.top) / rect.height) * canvas.height;

                if (this.canvasWidget.isDrawingBox && this.canvasWidget.currentBox) {
                    this.canvasWidget.currentBox.x2 = x;
                    this.canvasWidget.currentBox.y2 = y;
                    this.redrawCanvas();
                } else {
                    const hovered = this.findItemAt(x, y);
                    if (hovered !== this.canvasWidget.hoveredItem) {
                        this.canvasWidget.hoveredItem = hovered;
                        this.redrawCanvas();
                    }
                }
            });

            canvas.addEventListener("mouseup", (e) => {
                if (this.canvasWidget.isDrawingBox && this.canvasWidget.currentBox) {
                    const box = this.canvasWidget.currentBox;
                    const w = Math.abs(box.x2 - box.x1);
                    const h = Math.abs(box.y2 - box.y1);
                    if (w > 5 && h > 5) {
                        const normalizedBox = {
                            x1: Math.min(box.x1, box.x2), y1: Math.min(box.y1, box.y2),
                            x2: Math.max(box.x1, box.x2), y2: Math.max(box.y1, box.y2)
                        };
                        const activePrompt = this.canvasWidget.prompts[this.canvasWidget.activePromptIndex];
                        const boxList = box.isNegative ? activePrompt.negative_boxes : activePrompt.positive_boxes;
                        boxList.push(normalizedBox);
                        this.updateStorage();
                    }
                    this.canvasWidget.currentBox = null;
                    this.canvasWidget.isDrawingBox = false;
                    this.redrawCanvas();
                }
            });

            canvas.addEventListener("contextmenu", (e) => {
                e.preventDefault();
                canvas.dispatchEvent(new MouseEvent('mousedown', {
                    button: 2, clientX: e.clientX, clientY: e.clientY, shiftKey: e.shiftKey
                }));
            });

            // -- Handle image loading --
            this.onExecuted = (message) => {
                if (message.bg_image && message.bg_image[0]) {
                    const img = new Image();
                    img.onload = () => {
                        this.canvasWidget.image = img;
                        canvas.width = img.width;
                        canvas.height = img.height;
                        this.redrawCanvas();
                    };
                    img.src = "data:image/jpeg;base64," + message.bg_image[0];
                }
            };

            // -- Handle node resize --
            const originalOnResize = this.onResize;
            this.onResize = function(size) {
                if (originalOnResize) originalOnResize.apply(this, arguments);
                container.style.height = Math.max(290, size[1] - 80) + "px";
            };

            this.redrawCanvas();
            this.setSize([420, 580]);
            container.style.height = "500px";

            return result;
        };

        // -- Restore state when workflow is loaded --
        const onConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function(info) {
            onConfigure?.apply(this, arguments);
            const storeWidget = this._hiddenWidgets?.multi_prompts_store;
            if (storeWidget && storeWidget.value) {
                try {
                    const stored = JSON.parse(storeWidget.value);
                    if (Array.isArray(stored) && stored.length > 0) {
                        this.canvasWidget.prompts = stored;
                        this.canvasWidget.activePromptIndex = 0;
                        this.rebuildRegionList();
                        this.redrawCanvas();
                        console.log("[SAM3] Restored", stored.length, "multi-prompt regions");
                    }
                } catch (e) {
                    console.log("[SAM3] Failed to restore multi-prompts:", e);
                }
            }
        };

        // ==================================================================
        // Region list builder -- each region is one row
        // ==================================================================

        nodeType.prototype.rebuildRegionList = function() {
            const panel = this.canvasWidget.regionPanel;
            panel.innerHTML = "";
            this.canvasWidget.textInputs = [];

            this.canvasWidget.prompts.forEach((prompt, idx) => {
                const color = PROMPT_COLORS[idx % PROMPT_COLORS.length];
                const isActive = idx === this.canvasWidget.activePromptIndex;

                // -- Row container --
                const row = document.createElement("div");
                row.style.cssText = `
                    display: flex; align-items: center; gap: 6px;
                    padding: 4px 6px; border-radius: 4px; cursor: pointer;
                    background: ${isActive ? '#333' : 'transparent'};
                    border: 1px solid ${isActive ? color.primary : '#333'};
                    transition: background 0.15s, border-color 0.15s;
                `;
                row.dataset.promptIndex = idx;

                // -- Color dot --
                const colorDot = document.createElement("span");
                colorDot.style.cssText = `
                    width: 12px; height: 12px; border-radius: 3px;
                    background: ${color.primary}; flex-shrink: 0;
                `;
                row.appendChild(colorDot);

                // -- Region label --
                const label = document.createElement("span");
                label.textContent = `R${idx + 1}`;
                label.style.cssText = `
                    font-size: 11px; font-weight: bold;
                    color: ${isActive ? color.primary : '#999'};
                    min-width: 22px; flex-shrink: 0;
                `;
                row.appendChild(label);

                // -- Text input --
                const textInput = document.createElement("input");
                textInput.type = "text";
                textInput.value = prompt.text_prompt || "";
                textInput.placeholder = "text prompt\u2026";
                textInput.style.cssText = `
                    flex: 1; padding: 3px 6px; background: #2a2a2a;
                    border: 1px solid ${isActive ? color.dim : '#444'};
                    border-radius: 3px; color: #eee; font-size: 11px;
                    outline: none; min-width: 0;
                `;
                textInput.addEventListener("focus", () => {
                    textInput.style.borderColor = color.primary;
                });
                textInput.addEventListener("blur", () => {
                    textInput.style.borderColor = isActive ? color.dim : '#444';
                });
                textInput.addEventListener("input", () => {
                    prompt.text_prompt = textInput.value;
                    this.updateStorage();
                    this.updateCounter();
                    this.redrawCanvas();
                });
                textInput.addEventListener("mousedown", (e) => e.stopPropagation());
                textInput.addEventListener("keydown", (e) => e.stopPropagation());

                this.canvasWidget.textInputs.push(textInput);
                row.appendChild(textInput);

                // -- Geometry stats badge --
                const stats = document.createElement("span");
                const pts = prompt.positive_points.length + prompt.negative_points.length;
                const bxs = prompt.positive_boxes.length + prompt.negative_boxes.length;
                stats.textContent = pts + "p" + bxs + "b";
                stats.title = pts + " points, " + bxs + " boxes";
                stats.style.cssText = `
                    font-size: 10px; color: ${pts + bxs > 0 ? '#8f8' : '#555'};
                    font-family: monospace; flex-shrink: 0; min-width: 28px;
                    text-align: center;
                `;
                row.appendChild(stats);

                // -- Delete button --
                if (this.canvasWidget.prompts.length > 1) {
                    const deleteBtn = document.createElement("span");
                    deleteBtn.textContent = "\u00d7";
                    deleteBtn.style.cssText = `
                        color: #888; cursor: pointer; font-size: 14px;
                        padding: 0 4px; flex-shrink: 0; line-height: 1;
                    `;
                    deleteBtn.onmouseover = () => deleteBtn.style.color = "#f00";
                    deleteBtn.onmouseout = () => deleteBtn.style.color = "#888";
                    deleteBtn.onclick = (e) => {
                        e.stopPropagation();
                        this.deletePrompt(idx);
                    };
                    row.appendChild(deleteBtn);
                }

                // -- Row click -> select region --
                row.onclick = (e) => {
                    if (e.target.tagName === "INPUT") return;
                    this.setActivePrompt(idx);
                };

                panel.appendChild(row);
            });

            // -- Add button row --
            if (this.canvasWidget.prompts.length < MAX_PROMPTS) {
                const addRow = document.createElement("div");
                addRow.style.cssText = "display: flex; justify-content: center; padding: 3px 0;";

                const addBtn = document.createElement("button");
                addBtn.textContent = "+ Add Region";
                addBtn.style.cssText = `
                    padding: 4px 16px; background: #2a5a2a; border: 1px solid #3a7a3a;
                    border-radius: 4px; color: #8f8; cursor: pointer; font-size: 11px; width: 100%;
                `;
                addBtn.onmouseover = () => addBtn.style.background = "#3a6a3a";
                addBtn.onmouseout = () => addBtn.style.background = "#2a5a2a";
                addBtn.onclick = () => this.addNewPrompt();
                addRow.appendChild(addBtn);
                panel.appendChild(addRow);
            }

            this.updateCounter();
        };

        // -- Set active prompt --
        nodeType.prototype.setActivePrompt = function(index) {
            this.canvasWidget.activePromptIndex = index;
            this.rebuildRegionList();
            this.redrawCanvas();
        };

        // -- Add new prompt --
        nodeType.prototype.addNewPrompt = function() {
            if (this.canvasWidget.prompts.length >= MAX_PROMPTS) return;
            this.canvasWidget.prompts.push({
                positive_points: [], negative_points: [],
                positive_boxes: [], negative_boxes: [],
                text_prompt: ""
            });
            this.canvasWidget.activePromptIndex = this.canvasWidget.prompts.length - 1;
            this.rebuildRegionList();
            this.updateStorage();
            this.redrawCanvas();
        };

        // -- Delete prompt --
        nodeType.prototype.deletePrompt = function(index) {
            if (this.canvasWidget.prompts.length <= 1) { this.clearActivePrompt(); return; }
            this.canvasWidget.prompts.splice(index, 1);
            if (this.canvasWidget.activePromptIndex >= this.canvasWidget.prompts.length) {
                this.canvasWidget.activePromptIndex = this.canvasWidget.prompts.length - 1;
            }
            this.rebuildRegionList();
            this.updateStorage();
            this.redrawCanvas();
        };

        // -- Clear active prompt --
        nodeType.prototype.clearActivePrompt = function() {
            const prompt = this.canvasWidget.prompts[this.canvasWidget.activePromptIndex];
            prompt.positive_points = []; prompt.negative_points = [];
            prompt.positive_boxes = []; prompt.negative_boxes = [];
            prompt.text_prompt = "";
            this.rebuildRegionList();
            this.updateStorage();
            this.redrawCanvas();
        };

        // -- Clear all prompts --
        nodeType.prototype.clearAllPrompts = function() {
            this.canvasWidget.prompts = [{
                positive_points: [], negative_points: [],
                positive_boxes: [], negative_boxes: [],
                text_prompt: ""
            }];
            this.canvasWidget.activePromptIndex = 0;
            this.rebuildRegionList();
            this.updateStorage();
            this.redrawCanvas();
        };

        // -- Find item at coordinates --
        nodeType.prototype.findItemAt = function(x, y) {
            const threshold = 10;
            const pIdx = this.canvasWidget.activePromptIndex;
            const prompt = this.canvasWidget.prompts[pIdx];

            for (let i = 0; i < prompt.positive_points.length; i++) {
                const pt = prompt.positive_points[i];
                if (Math.abs(pt.x - x) < threshold && Math.abs(pt.y - y) < threshold)
                    return { type: "point", index: i, promptIndex: pIdx, isNegative: false };
            }
            for (let i = 0; i < prompt.negative_points.length; i++) {
                const pt = prompt.negative_points[i];
                if (Math.abs(pt.x - x) < threshold && Math.abs(pt.y - y) < threshold)
                    return { type: "point", index: i, promptIndex: pIdx, isNegative: true };
            }
            for (let i = 0; i < prompt.positive_boxes.length; i++) {
                const box = prompt.positive_boxes[i];
                if (x >= box.x1 && x <= box.x2 && y >= box.y1 && y <= box.y2)
                    return { type: "box", index: i, promptIndex: pIdx, isNegative: false };
            }
            for (let i = 0; i < prompt.negative_boxes.length; i++) {
                const box = prompt.negative_boxes[i];
                if (x >= box.x1 && x <= box.x2 && y >= box.y1 && y <= box.y2)
                    return { type: "box", index: i, promptIndex: pIdx, isNegative: true };
            }
            return null;
        };

        // -- Update storage widget --
        nodeType.prototype.updateStorage = function() {
            const widget = this._hiddenWidgets?.multi_prompts_store;
            if (widget) widget.value = JSON.stringify(this.canvasWidget.prompts);
            this.updateCounter();
        };

        // -- Update counter display --
        nodeType.prototype.updateCounter = function() {
            const prompt = this.canvasWidget.prompts[this.canvasWidget.activePromptIndex];
            const pts = prompt.positive_points.length + prompt.negative_points.length;
            const boxes = prompt.positive_boxes.length + prompt.negative_boxes.length;
            const textTag = prompt.text_prompt ? " \ud83d\udcdd" + prompt.text_prompt.substring(0, 15) : "";
            this.canvasWidget.counter.textContent =
                "Region " + (this.canvasWidget.activePromptIndex + 1) + ": " + pts + " pts, " + boxes + " boxes" + textTag;
        };

        // ==================================================================
        // Canvas drawing
        // ==================================================================

        nodeType.prototype.redrawCanvas = function() {
            const { canvas, ctx, image, prompts, activePromptIndex, currentBox, hoveredItem } = this.canvasWidget;
            ctx.clearRect(0, 0, canvas.width, canvas.height);

            if (image) {
                ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
            } else {
                ctx.fillStyle = "#333";
                ctx.fillRect(0, 0, canvas.width, canvas.height);
                ctx.fillStyle = "#666";
                ctx.font = "14px sans-serif";
                ctx.textAlign = "center";
                ctx.fillText("Click: Positive point | Right-click: Negative point", canvas.width / 2, canvas.height / 2 - 20);
                ctx.fillText("Shift+Drag: Box | Shift+Right-drag: Negative box", canvas.width / 2, canvas.height / 2 + 5);
                ctx.fillText("Add text prompts in the region list below", canvas.width / 2, canvas.height / 2 + 30);
            }

            const prompt = prompts[activePromptIndex];
            const color = PROMPT_COLORS[activePromptIndex % PROMPT_COLORS.length];

            this.drawBoxes(ctx, prompt.positive_boxes, color.primary, 1.0, false, activePromptIndex, hoveredItem);
            this.drawBoxes(ctx, prompt.negative_boxes, color.primary, 1.0, true, activePromptIndex, hoveredItem);
            this.drawPoints(ctx, prompt.positive_points, color.primary, 1.0, false, activePromptIndex, hoveredItem);
            this.drawPoints(ctx, prompt.negative_points, color.primary, 1.0, true, activePromptIndex, hoveredItem);

            if (currentBox) {
                ctx.setLineDash([5, 5]);
                ctx.strokeStyle = currentBox.isNegative ? "#f80" : color.primary;
                ctx.lineWidth = 2;
                ctx.strokeRect(currentBox.x1, currentBox.y1, currentBox.x2 - currentBox.x1, currentBox.y2 - currentBox.y1);
                ctx.setLineDash([]);
                ctx.fillStyle = currentBox.isNegative ? "rgba(255,128,0,0.1)" : this.colorWithAlpha(color.primary, 0.1);
                ctx.fillRect(currentBox.x1, currentBox.y1, currentBox.x2 - currentBox.x1, currentBox.y2 - currentBox.y1);
            }

            if (prompt.text_prompt) {
                const labelText = "\ud83d\udcdd \"" + prompt.text_prompt + "\"";
                ctx.font = "bold 13px sans-serif";
                const metrics = ctx.measureText(labelText);
                ctx.fillStyle = "rgba(0,0,0,0.75)";
                ctx.fillRect(5, canvas.height - 55, metrics.width + 16, 22);
                ctx.fillStyle = color.primary;
                ctx.textAlign = "left";
                ctx.fillText(labelText, 13, canvas.height - 39);
            }

            if (image) {
                ctx.fillStyle = "rgba(0,0,0,0.7)";
                ctx.fillRect(5, canvas.height - 25, 150, 20);
                ctx.fillStyle = "#0f0";
                ctx.font = "12px monospace";
                ctx.textAlign = "left";
                ctx.fillText("Image: " + canvas.width + "x" + canvas.height, 10, canvas.height - 10);
            }
        };

        // -- Draw points --
        nodeType.prototype.drawPoints = function(ctx, points, color, alpha, isNegative, promptIndex, hoveredItem) {
            const canvas = this.canvasWidget.canvas;
            const sf = Math.max(0.5, canvas.height / 1080);
            const baseR = 6 * sf, hoverR = 8 * sf;

            for (let i = 0; i < points.length; i++) {
                const pt = points[i];
                const isH = hoveredItem?.type === "point" && hoveredItem?.promptIndex === promptIndex &&
                            hoveredItem?.index === i && hoveredItem?.isNegative === isNegative;
                const r = isH ? hoverR : baseR;
                ctx.beginPath(); ctx.arc(pt.x, pt.y, r, 0, 2 * Math.PI);
                ctx.fillStyle = isNegative ? "rgba(255,0,0," + (alpha * 0.8) + ")" : this.colorWithAlpha(color, alpha * 0.8);
                ctx.fill();
                ctx.strokeStyle = isH ? "#fff" : this.colorWithAlpha(color, alpha);
                ctx.lineWidth = (isH ? 3 : 2) * sf;
                ctx.stroke();
                if (isNegative) {
                    const xs = 3 * sf;
                    ctx.strokeStyle = "#fff"; ctx.lineWidth = 2 * sf;
                    ctx.beginPath();
                    ctx.moveTo(pt.x - xs, pt.y - xs); ctx.lineTo(pt.x + xs, pt.y + xs);
                    ctx.moveTo(pt.x + xs, pt.y - xs); ctx.lineTo(pt.x - xs, pt.y + xs);
                    ctx.stroke();
                }
            }
        };

        // -- Draw boxes --
        nodeType.prototype.drawBoxes = function(ctx, boxes, color, alpha, isNegative, promptIndex, hoveredItem) {
            for (let i = 0; i < boxes.length; i++) {
                const box = boxes[i];
                const w = box.x2 - box.x1, h = box.y2 - box.y1;
                const isH = hoveredItem?.type === "box" && hoveredItem?.promptIndex === promptIndex &&
                            hoveredItem?.index === i && hoveredItem?.isNegative === isNegative;
                ctx.fillStyle = isNegative ? "rgba(255,0,0," + (alpha * 0.15) + ")" : this.colorWithAlpha(color, alpha * 0.15);
                ctx.fillRect(box.x1, box.y1, w, h);
                ctx.strokeStyle = isH ? "#fff" : (isNegative ? "rgba(255,0,0," + alpha + ")" : this.colorWithAlpha(color, alpha));
                ctx.lineWidth = isH ? 3 : 2;
                if (isNegative) ctx.setLineDash([4, 4]);
                ctx.strokeRect(box.x1, box.y1, w, h);
                ctx.setLineDash([]);
            }
        };

        // -- Color helper --
        nodeType.prototype.colorWithAlpha = function(hex, alpha) {
            const r = parseInt(hex.slice(1, 3), 16);
            const g = parseInt(hex.slice(3, 5), 16);
            const b = parseInt(hex.slice(5, 7), 16);
            return "rgba(" + r + "," + g + "," + b + "," + alpha + ")";
        };
    }
});
