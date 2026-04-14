"""
ComfyUI-MultiModel3D: Install script
Downloads Three.js library files for offline use.
"""

import os
import urllib.request

THREE_VERSION = "0.170.0"
BASE_URL = f"https://unpkg.com/three@{THREE_VERSION}"

FILES = {
    "web/lib/three/three.module.js": f"{BASE_URL}/build/three.module.js",
    "web/lib/three/OrbitControls.js": f"{BASE_URL}/examples/jsm/controls/OrbitControls.js",
    "web/lib/three/GLTFLoader.js": f"{BASE_URL}/examples/jsm/loaders/GLTFLoader.js",
    "web/lib/three/utils/BufferGeometryUtils.js": f"{BASE_URL}/examples/jsm/utils/BufferGeometryUtils.js",
}


def install():
    print("[ComfyUI-MultiModel3D] Installing Three.js dependencies...")

    for local_path, url in FILES.items():
        dir_name = os.path.dirname(local_path)
        if dir_name:
            os.makedirs(dir_name, exist_ok=True)

        if os.path.exists(local_path):
            print(f"  ✓ Already exists: {local_path}")
            continue

        print(f"  ↓ Downloading: {local_path} ...")
        try:
            urllib.request.urlretrieve(url, local_path)
            size = os.path.getsize(local_path)
            print(f"  ✓ Downloaded: {local_path} ({size:,} bytes)")
        except Exception as e:
            print(f"  ✗ Failed to download {url}: {e}")
            print(f"    The viewer will fall back to CDN (requires internet).")
            continue

    # Fix bare 'three' imports in downloaded files
    _fix_imports()

    print("[ComfyUI-MultiModel3D] Installation complete!")


def _fix_imports():
    """Replace bare 'three' module specifiers with relative paths for browser ES modules."""

    fixes = {
        "web/lib/three/OrbitControls.js": [
            ("from 'three'", "from './three.module.js'"),
        ],
        "web/lib/three/GLTFLoader.js": [
            ("from 'three'", "from './three.module.js'"),
            ("from '../utils/BufferGeometryUtils.js'", "from './utils/BufferGeometryUtils.js'"),
        ],
        "web/lib/three/utils/BufferGeometryUtils.js": [
            ("from 'three'", "from '../three.module.js'"),
        ],
    }

    for filepath, replacements in fixes.items():
        if not os.path.exists(filepath):
            continue

        with open(filepath, "r", encoding="utf-8") as f:
            content = f.read()

        modified = False
        for old, new in replacements:
            if old in content:
                content = content.replace(old, new)
                modified = True

        if modified:
            with open(filepath, "w", encoding="utf-8") as f:
                f.write(content)
            print(f"  ✓ Fixed imports: {filepath}")


if __name__ == "__main__":
    install()
