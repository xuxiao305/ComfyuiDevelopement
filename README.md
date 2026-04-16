# ComfyUI-SAM3-Text-Markpoint

ComfyUI custom nodes for SAM3 (Segment Anything Model 3) with **text prompting** and **click/mark point** interaction.

## Features

- 🔤 **Text-Grounded Segmentation** — Segment objects by natural language descriptions
- 🖱️ **Interactive Click Segmentation** — Click to add positive/negative points for precise mask refinement
- 🎯 **Text + Click Combined** — Use text to locate objects, then refine with clicks
- 📦 **Box + Fill Visualization** — Choose box-only, fill-only, or box+fill display modes
- 🎬 **Video Segmentation** — Track and segment objects across video frames
- 🖼️ **Multi-Region Support** — Segment and label multiple regions in a single image

## Nodes

| Node | Description |
|------|-------------|
| **SAM3 Load Model** | Load SAM3 model (sam3.1_hf_l) |
| **SAM3 Segment** | Automatic segmentation (grid/point prompts) |
| **SAM3 Text+Click Collector** | Collect text prompts and click points interactively |
| **SAM3 Text+Click Segmentation** | Segment using text + click inputs |
| **SAM3 Interactive Segment** | Real-time interactive click segmentation |
| **SAM3 Model Patcher** | Patch model for memory optimization |
| **SAM3 Video Segment** | Video object tracking and segmentation |

## Installation

### Via ComfyUI Manager (Recommended)
Search for "SAM3-Text-Markpoint" in the ComfyUI Manager.

### Manual Installation
```bash
cd ComfyUI/custom_nodes
git clone https://github.com/xuxiao305/ComfyUI-SAM3-Text-Markpoint.git
cd ComfyUI-SAM3-Text-Markpoint
pip install -r requirements.txt
```

## Requirements

- Python >= 3.10
- PyTorch >= 2.0
- See `pyproject.toml` for full dependencies

## Usage

### Text + Click Segmentation
1. Add **SAM3 Load Model** node and select model
2. Add **SAM3 Text+Click Collector** — enter text description and click on the image
3. Add **SAM3 Text+Click Segmentation** — connect model, image, and collector output
4. Choose visualization mode: `box+fill`, `box_only`, or `fill_only`

### Interactive Segmentation
1. Add **SAM3 Load Model** node
2. Add **SAM3 Interactive Segment** — click on the image to segment
3. Left click = positive point, Right click = negative point

## License

See [LICENSE](LICENSE) for details.
