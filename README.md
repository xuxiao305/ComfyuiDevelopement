# ComfyUI-MultiModel3D

ComfyUI custom nodes for merging multiple GLB files and interactively controlling sub-models within a single GLB.

## Nodes

### MergeGLB
Merges multiple GLB files into one, preserving each sub-model's identity with prefixed node names.

**Inputs:**
- `glb_1` ~ `glb_8`: GLB files (from Load3D or other 3D nodes)
- `prefix_mode`: Naming strategy — `index` (0_, 1_, ...) or `filename` (body_, arm_, ...)
- `offset`: X-axis spacing between sub-models (0 = keep original positions)

**Output:**
- `merged_glb`: Merged GLB file (FILE_3D / FILE_3D_GLB type)

### MultiModelViewer
Preview a GLB file with per-sub-model control: visibility toggle, focus, and explode view.

**Inputs:**
- `model_file`: GLB file (from MergeGLB, Load3D, or path string)

**Outputs:**
- `image`: Preview screenshot
- `mask`: Preview mask
- `camera_info`: Camera state for downstream nodes
- `model_info`: Sub-model metadata (JSON)

**UI Controls:**
- 👁 Toggle visibility per sub-model
- 🎯 Focus camera on a sub-model (preserves current viewing angle)
- 💥 Explode view slider (scatter sub-models away from center)

## Installation

1. Clone this repo into `ComfyUI/custom_nodes/`
   ```bash
   cd ComfyUI/custom_nodes
   git clone https://github.com/xuxiao305/ComfyuiDevelopement.git ComfyUI-MultiModel3D
   ```
2. Install dependencies: `pip install -r requirements.txt`
3. Restart ComfyUI — Three.js files will be auto-downloaded on first launch

## Offline Support

Three.js library files are downloaded automatically on first startup into `web/lib/three/`. Once downloaded, the viewer works fully offline. If download fails, it falls back to CDN (requires internet).

## Technical Notes

- Three.js is loaded from local files (offline) with CDN fallback
- Mouse events on the 3D canvas are isolated from ComfyUI canvas via `stopPropagation()`
- trimesh `Scene.add_geometry()` preserves PBR materials during merge
- Sub-models are identified by MergeGLB's numeric prefix (0_, 1_, ...) and grouped automatically
- Explode view uses uniform scale-aware offset calculation for smooth linear control
