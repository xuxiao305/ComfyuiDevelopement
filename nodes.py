"""
ComfyUI-MultiModel3D: MergeGLB + MultiModelViewer nodes

MergeGLB: Merge multiple GLB files into one with prefixed node names
MultiModelViewer: Preview GLB with per-sub-model control (visibility, focus, explode view)
"""

import os
import json
import uuid
import tempfile
import numpy as np

import folder_paths


# ---------------------------------------------------------------------------
# Utility: resolve GLB path from various input types
# ---------------------------------------------------------------------------
def resolve_glb_path(mesh, temp_prefix="multimodel3d"):
    """Resolve a GLB file path from various input types.

    Handles: str path, File3D objects, trimesh objects, dict with 'mesh' key.
    Returns an absolute file path to a .glb file.
    """
    if isinstance(mesh, list) and len(mesh) > 0:
        mesh = mesh[0]

    if isinstance(mesh, dict):
        mesh = mesh.get("mesh") or mesh.get("glb_path") or mesh

    if isinstance(mesh, str):
        return _resolve_relative_path(mesh)

    # File3D from comfy_api
    if type(mesh).__name__ == "File3D":
        if hasattr(mesh, "get_source"):
            source = mesh.get_source()
            if isinstance(source, str):
                return _resolve_relative_path(source)
        if hasattr(mesh, "save_to"):
            temp_dir = folder_paths.get_temp_directory()
            glb_path = os.path.join(temp_dir, f"{temp_prefix}_{os.urandom(4).hex()}.glb")
            return mesh.save_to(glb_path)
        if hasattr(mesh, "_source") and isinstance(mesh._source, str):
            return _resolve_relative_path(mesh._source)

    # trimesh object with export method
    if hasattr(mesh, "export"):
        temp_dir = folder_paths.get_temp_directory()
        glb_path = os.path.join(temp_dir, f"{temp_prefix}_{os.urandom(4).hex()}.glb")
        mesh.export(glb_path, file_type="glb")
        return glb_path

    raise ValueError(f"Unsupported mesh type: {type(mesh)}. Attributes: {dir(mesh)}")


def _resolve_relative_path(path):
    """Try to resolve a relative path against ComfyUI's known directories."""
    if not path or not isinstance(path, str):
        return path
    if os.path.isabs(path):
        return path

    for folder_fn in [folder_paths.get_output_directory,
                      folder_paths.get_input_directory,
                      folder_paths.get_temp_directory]:
        folder = folder_fn()
        if folder is None:
            continue
        full = os.path.abspath(os.path.join(folder, path))
        if os.path.exists(full):
            return full

    # If file exists as-is, return it
    if os.path.exists(path):
        return os.path.abspath(path)

    return path


# ===========================================================================
# MergeGLB Node
# ===========================================================================
class MergeGLB:
    """Merge multiple GLB files into one, preserving each sub-model's identity.

    Uses trimesh Scene.add_geometry() with node_name prefixing to keep
    sub-models distinguishable. PBR materials are preserved.
    """

    def __init__(self):
        self._trimesh = None

    def _get_trimesh(self):
        if self._trimesh is None:
            import trimesh
            self._trimesh = trimesh
        return self._trimesh

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "prefix_mode": (["index", "filename"], {"default": "index"}),
                "offset": ("FLOAT", {"default": 0.0, "min": 0.0, "max": 100.0, "step": 0.1,
                                      "tooltip": "X-axis spacing between sub-models. 0 = keep original positions."}),
            },
            "optional": {
                "glb_1": ("FILE_3D,FILE_3D_GLB",),
                "glb_2": ("FILE_3D,FILE_3D_GLB",),
                "glb_3": ("FILE_3D,FILE_3D_GLB",),
                "glb_4": ("FILE_3D,FILE_3D_GLB",),
                "glb_5": ("FILE_3D,FILE_3D_GLB",),
                "glb_6": ("FILE_3D,FILE_3D_GLB",),
                "glb_7": ("FILE_3D,FILE_3D_GLB",),
                "glb_8": ("FILE_3D,FILE_3D_GLB",),
            },
        }

    RETURN_TYPES = ("FILE_3D,FILE_3D_GLB",)
    RETURN_NAMES = ("merged_glb",)
    FUNCTION = "merge"
    CATEGORY = "3d/MultiModel3D"
    DESCRIPTION = "Merge multiple GLB files into one. Each sub-model gets a prefixed node name for later identification."

    def merge(self, prefix_mode="index", offset=0.0, **kwargs):
        trimesh = self._get_trimesh()

        # Collect all non-None GLB inputs
        glb_inputs = []
        for i in range(1, 9):
            key = f"glb_{i}"
            val = kwargs.get(key)
            if val is not None:
                glb_inputs.append(val)

        if not glb_inputs:
            raise ValueError("At least one GLB input is required")

        merged_scene = trimesh.Scene()

        for i, glb_input in enumerate(glb_inputs):
            glb_path = resolve_glb_path(glb_input, temp_prefix=f"merge_src_{i}")
            if not os.path.exists(glb_path):
                print(f"[MergeGLB] Warning: file not found: {glb_path}, skipping")
                continue

            # Load sub-scene without processing (preserve materials and geometry)
            try:
                sub_scene = trimesh.load(glb_path, force="scene", process=False)
            except Exception as e:
                print(f"[MergeGLB] Warning: failed to load {glb_path}: {e}, skipping")
                continue

            # Determine prefix
            if prefix_mode == "filename":
                prefix = os.path.splitext(os.path.basename(glb_path))[0] + "_"
            else:
                prefix = f"{i}_"

            # Optional X-axis offset transform
            transform = None
            if offset > 0:
                transform = np.eye(4)
                transform[0, 3] = i * offset

            # Add all geometry nodes from sub-scene
            added_count = 0
            for node_name in sub_scene.graph.nodes_geometry:
                T, geom_name = sub_scene.graph.get(node_name)
                # T is the transform matrix, geom_name is the geometry key
                geom = sub_scene.geometry.get(geom_name)
                if geom is None:
                    continue

                # Compute final transform: offset * original
                final_transform = None
                if T is not None:
                    final_transform = T.copy()
                    if transform is not None:
                        final_transform = transform @ final_transform
                elif transform is not None:
                    final_transform = transform.copy()

                try:
                    merged_scene.add_geometry(
                        geometry=geom,
                        node_name=f"{prefix}{node_name}",
                        geom_name=f"{prefix}{geom_name}",
                        transform=final_transform,
                    )
                    added_count += 1
                except Exception as e:
                    print(f"[MergeGLB] Warning: failed to add geometry {node_name}: {e}")

            print(f"[MergeGLB] Added {added_count} geometries from {os.path.basename(glb_path)} (prefix: {prefix})")

        # Export merged scene
        output_dir = folder_paths.get_output_directory()
        output_filename = f"merged_{uuid.uuid4().hex[:8]}.glb"
        output_path = os.path.join(output_dir, output_filename)

        merged_scene.export(output_path, file_type="glb")

        # Count total geometries
        total = len(merged_scene.geometry)
        print(f"[MergeGLB] Merged {total} geometries → {output_filename}")

        # Return as File3D GLB type
        try:
            from comfy_api.latest._util import File3D
            return (File3D(output_path, file_format="glb"),)
        except ImportError:
            return (output_path,)


# ===========================================================================
# MultiModelViewer Node
# ===========================================================================
class MultiModelViewer:
    """Preview a GLB file with per-sub-model interactive control.

    Supports: visibility toggle, camera focus, and explode view slider.
    Uses Three.js GLTFLoader on the frontend for full scene graph traversal.
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "model_file": ("FILE_3D,FILE_3D_GLB",),
            },
            "optional": {
                "camera_info": ("LOAD3D_CAMERA",),
                "bg_image": ("IMAGE",),
            },
            "hidden": {
                "unique_id": "UNIQUE_ID",
                "extra_pnginfo": "EXTRA_PNGINFO",
            },
        }

    RETURN_TYPES = ("IMAGE", "MASK", "LOAD3D_CAMERA", "STRING")
    RETURN_NAMES = ("image", "mask", "camera_info", "model_info")
    FUNCTION = "preview"
    CATEGORY = "3d/MultiModel3D"
    OUTPUT_NODE = True
    DESCRIPTION = "Preview GLB with sub-model control: visibility, focus, and explode view."

    def preview(self, model_file, camera_info=None, bg_image=None, unique_id=None, extra_pnginfo=None):
        import torch

        # Resolve GLB path
        glb_path = resolve_glb_path(model_file, temp_prefix="mmv_preview")

        # Determine filename for the frontend viewer
        if isinstance(model_file, str):
            filename = model_file
        elif type(model_file).__name__ == "File3D" and hasattr(model_file, "_source") and isinstance(model_file._source, str):
            filename = os.path.basename(model_file._source)
        else:
            # Save to output dir and use that path
            filename = f"mmv_{uuid.uuid4().hex[:8]}.glb"
            if isinstance(model_file, type(model_file)) and hasattr(model_file, "save_to"):
                output_dir = folder_paths.get_output_directory()
                output_path = os.path.join(output_dir, filename)
                model_file.save_to(output_path)
            elif os.path.exists(glb_path):
                # Copy to output dir for /view endpoint access
                import shutil
                output_dir = folder_paths.get_output_directory()
                output_path = os.path.join(output_dir, filename)
                if glb_path != output_path:
                    shutil.copy2(glb_path, output_path)

        # Get sub-model info via trimesh
        model_info = self._get_model_info(glb_path)

        # Create placeholder image/mask (1x1 white/black)
        placeholder_image = torch.ones((1, 64, 64, 3), dtype=torch.float32)
        placeholder_mask = torch.zeros((1, 64, 64), dtype=torch.float32)

        # If camera_info is not provided, use defaults
        if camera_info is None:
            camera_info = {
                "position": {"x": 0, "y": 1, "z": 3},
                "target": {"x": 0, "y": 0, "z": 0},
                "zoom": 1,
                "cameraType": "perspective",
            }

        return {
            "ui": {
                "result": [filename, camera_info, None],
                "sub_models": model_info,
            },
            "result": (placeholder_image, placeholder_mask, camera_info, json.dumps(model_info)),
        }

    def _get_model_info(self, glb_path):
        """Extract sub-model info from GLB using trimesh for display in the UI list."""
        try:
            import trimesh
            scene = trimesh.load(glb_path, force="scene", process=False)

            sub_models = []
            for i, node_name in enumerate(scene.graph.nodes_geometry):
                T, geom_name = scene.graph.get(node_name)
                geom = scene.geometry.get(geom_name)
                if geom is None:
                    continue

                # Calculate bounding box center
                if hasattr(geom, "bounds") and geom.bounds is not None:
                    bounds = geom.bounds
                    center = ((bounds[0] + bounds[1]) / 2).tolist()
                    size = ((bounds[1] - bounds[0])).tolist()
                else:
                    center = [0, 0, 0]
                    size = [1, 1, 1]

                # Apply transform to get world-space center
                if T is not None:
                    center_h = np.array(center + [1.0])
                    world_center = (T @ center_h)[:3].tolist()
                else:
                    world_center = center

                # Extract group prefix for sub-model grouping
                # Node names like "0_body_0" → group "0", display "body_0"
                parts = node_name.split("_", 1)
                if len(parts) > 1 and parts[0].isdigit():
                    group = parts[0]
                    display_name = parts[1]
                else:
                    group = "0"
                    display_name = node_name

                sub_models.append({
                    "index": i,
                    "node_name": node_name,
                    "group": group,
                    "display_name": display_name,
                    "center": world_center,
                    "size": size,
                    "visible": True,
                })

            return sub_models

        except Exception as e:
            print(f"[MultiModelViewer] Warning: failed to extract model info: {e}")
            return []


# ===========================================================================
# Node Registration
# ===========================================================================
NODE_CLASS_MAPPINGS = {
    "MergeGLB": MergeGLB,
    "MultiModelViewer": MultiModelViewer,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "MergeGLB": "🔀 Merge GLB",
    "MultiModelViewer": "👁 Multi-Model Viewer 3D",
}

WEB_DIRECTORY = "./web"

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]
