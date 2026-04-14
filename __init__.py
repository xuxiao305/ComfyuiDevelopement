import os

# Run install script to ensure Three.js dependencies are available
_install_marker = os.path.join(os.path.dirname(__file__), "web", "lib", "three", "three.module.js")
if not os.path.exists(_install_marker):
    try:
        from .install import install
        install()
    except Exception as e:
        print(f"[ComfyUI-MultiModel3D] Install script failed: {e}")
        print("[ComfyUI-MultiModel3D] Viewer will fall back to CDN (requires internet).")

from .nodes import NODE_CLASS_MAPPINGS, NODE_DISPLAY_NAME_MAPPINGS, WEB_DIRECTORY

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
