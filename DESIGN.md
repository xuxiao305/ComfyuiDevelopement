# ComfyUI-MultiModel3D 方案文档

## 1. 项目概述

**自定义节点包名称**: `ComfyUI-MultiModel3D`

**核心功能**: 在 ComfyUI 中支持合并多个 GLB 文件，并在 3D 预览中逐个控制子模型（可见性、聚焦、爆炸视图）。

**两个独立节点**:

| 节点 | 类型 | 功能 |
|------|------|------|
| `MergeGLB` | Python 后端 | 将多个 GLB 文件合并为一个，保留各子模型独立身份 |
| `MultiModelViewer` | Python + JS | 预览 GLB 并逐个控制子模型 |

---

## 2. MergeGLB 节点设计

### 2.1 输入输出

```
输入:
  - glb_paths: LIST[STRING]  — 多个 GLB 文件路径（由上游节点如 Load3D 传入）
  - prefix_mode: COMBO["index", "filename"]  — 子模型命名方式
  - offset: FLOAT = 0.0  — 各子模型之间的间距偏移（沿 X 轴）

输出:
  - merged_glb: FILE_3D_GLB  — 合并后的 GLB 文件
```

### 2.2 核心逻辑

```python
def merge(self, glb_paths, prefix_mode, offset):
    scene = trimesh.Scene()
    for i, path in enumerate(glb_paths):
        sub_scene = trimesh.load(path, force="scene", process=False)
        prefix = f"{i}_" if prefix_mode == "index" else f"{Path(path).stem}_"
        
        # 可选：沿 X 轴偏移，防止重叠
        transform = np.eye(4)
        transform[0, 3] = i * offset
        
        # 将子场景所有几何体添加到主场景
        for node_name in sub_scene.graph.nodes_geometry:
            geom_name, geom = sub_scene.graph.get_item_frame(node_name)
            scene.add_geometry(
                geometry=geom,
                node_name=f"{prefix}{node_name}",
                geom_name=f"{prefix}{geom_name}",
                transform=transform @ sub_scene.graph.get(node_name)[0] if offset > 0 else None
            )
    
    # 导出为 GLB
    output_path = tempfile.mktemp(suffix=".glb")
    scene.export(output_path, file_type="glb")
    return (output_path,)
```

### 2.3 技术要点

- 使用 `trimesh.Scene.add_geometry()` 保留子模型身份（node_name 前缀）
- `process=False` 防止 trimesh 合并相同材质的网格
- 可选 X 轴偏移量，让合并结果在预览时不重叠
- PBR 材质完整保留（baseColor, metallicRoughness, normal, emissive, occlusion）

---

## 3. MultiModelViewer 节点设计

### 3.1 输入输出

```
输入:
  - model_file: FILE_3D_GLB  — GLB 文件（可来自 MergeGLB 或直接加载）
  - camera_info: LOAD3D_CAMERA (optional)  — 相机信息
  - bg_image: IMAGE (optional)  — 背景图

输出:
  - image: IMAGE  — 预览截图
  - mask: MASK  — 预览遮罩
  - camera_info: LOAD3D_CAMERA  — 相机状态（供下游使用）
  - model_info: STRING  — JSON 字符串，包含子模型列表
```

### 3.2 前端架构

```
┌─────────────────────────────────────────────────┐
│              MultiModelViewer Widget             │
│                                                  │
│  ┌──────────────────────┐  ┌──────────────────┐ │
│  │                      │  │  子模型列表面板    │ │
│  │   Three.js 3D 视口   │  │                  │ │
│  │                      │  │ ☑ 0_body  👁 🎯  │ │
│  │   - OrbitControls    │  │ ☑ 1_arm_L 👁 🎯  │ │
│  │   - GLTFLoader       │  │ ☑ 1_arm_R 👁 🎯  │ │
│  │   - 环境光+方向光     │  │ ☑ 2_head  👁 🎯  │ │
│  │                      │  │                  │ │
│  │                      │  │ ──────────────── │ │
│  │                      │  │ 爆炸视图 ─────○─ │ │
│  └──────────────────────┘  └──────────────────┘ │
└─────────────────────────────────────────────────┘
```

### 3.3 子模型枚举逻辑

```javascript
// 加载 GLB 后遍历场景图
gltf.scene.traverse((child) => {
    if (child.isMesh || (child.isGroup && child.children.some(c => c.isMesh))) {
        // 存储原始世界空间位置（用于爆炸视图还原）
        child.userData.originalWorldCenter = new THREE.Vector3();
        child.getWorldPosition(child.userData.originalWorldCenter);
        
        // 计算包围盒
        const box = new THREE.Box3().setFromObject(child);
        child.userData.boundingBox = box;
        
        // 添加到子模型列表
        subModels.push({
            object: child,
            name: child.name || `Part_${subModels.length}`,
            visible: true,
            originalCenter: child.userData.originalWorldCenter.clone()
        });
    }
});
```

### 3.4 UI 交互

| 操作 | 行为 |
|------|------|
| 👁 切换可见性 | `child.visible = !child.visible`，触发重新渲染 |
| 🎯 聚焦 | 计算该子模型包围盒中心，平滑移动相机 target 到该点 |
| 爆炸视图滑块 | 沿 `originalWorldCenter - sceneCenter` 方向，按滑块比例偏移各子模型 |
| ☑ 复选框 | 标记该子模型为"选中"，供后续节点使用 |

### 3.5 爆炸视图算法

```javascript
function applyExplode(factor) {  // factor: 0.0 ~ 2.0
    const sceneCenter = new THREE.Vector3();  // 整体场景中心
    subModels.forEach(m => sceneCenter.add(m.originalCenter));
    sceneCenter.divideScalar(subModels.length);
    
    subModels.forEach(m => {
        const direction = m.originalCenter.clone().sub(sceneCenter);
        if (direction.length() < 0.001) {
            // 子模型恰在中心，用包围盒最大轴方向
            const size = m.boundingBox.getSize(new THREE.Vector3());
            direction.set(size.x, size.y, size.z).normalize();
        } else {
            direction.normalize();
        }
        m.object.position.copy(
            m.originalCenter.clone().add(direction.multiplyScalar(factor * explodeRadius))
        );
    });
}
```

### 3.6 截图上传流程

```
用户操作相机 → canvas.toDataURL() → fetch("/upload/image") → 返回图片名
→ 节点输出 IMAGE 类型 → 下游节点可使用
```

---

## 4. Three.js 加载策略

**方案**: CDN 加载 + 本地 fallback

```javascript
// 优先从 CDN 加载
const THREE_CDN = "https://cdn.jsdelivr.net/npm/three@0.170.0/build/three.module.js";
const ORBIT_CDN = "https://cdn.jsdelivr.net/npm/three@0.170.0/examples/jsm/controls/OrbitControls.js";
const GLTF_CDN = "https://cdn.jsdelivr.net/npm/three@0.170.0/examples/jsm/loaders/GLTFLoader.js";

// 使用 importmap 或动态 import
```

**原因**: ComfyUI 内置 Three.js 已打包为 rolldown 模块，无法直接引用。CDN 方式简洁可靠，与 `comfy_3d_viewers` 插件方案一致。

---

## 5. 鼠标事件冲突处理

```javascript
// Three.js canvas 上的鼠标事件阻止冒泡到 ComfyUI 画布
canvas.addEventListener('pointerdown', (e) => e.stopPropagation());
canvas.addEventListener('wheel', (e) => e.stopPropagation());
canvas.addEventListener('pointermove', (e) => e.stopPropagation());
```

---

## 6. 文件结构

```
ComfyUI-MultiModel3D/
├── __init__.py              # 节点注册入口
├── nodes.py                 # MergeGLB + MultiModelViewer Python 后端
├── requirements.txt         # trimesh, numpy
├── README.md                # 使用说明
└── web/
    └── javascript/
        └── multi_model_viewer.js  # Three.js 前端
```

---

## 7. 风险与缓解

| 风险 | 等级 | 缓解措施 |
|------|------|----------|
| Three.js CDN 不可用 | 高 | 本地备用 three.min.js |
| 鼠标事件冲突 | 高 | stopPropagation() |
| trimesh 合并时材质重复 | 中 | process=False + 前缀隔离 |
| DOM overlay 尺寸同步 | 中 | ResizeObserver 监听 |
| 爆炸视图位置还原 | 中 | userData.originalWorldCenter 缓存 |
| IO.ComfyNode API 变更 | 低 | 使用 latest 版本，与官方节点一致 |
| /view 端点限制 | 低 | 无大小限制，FileResponse 流式传输 |
| PBR 导出质量 | 低 | trimesh 已验证支持完整 PBR |
| node.properties 大小 | 低 | 仅存轻量状态（可见性、滑块值） |

---

## 8. 实施顺序

1. ✅ 创建项目目录结构
2. ✅ 实现 MergeGLB Python 节点（~100 行）
3. ✅ 实现 MultiModelViewer Python 后端（~200 行）
4. ✅ 实现 MultiModelViewer JS 前端（~600 行）
5. ✅ 测试验证
