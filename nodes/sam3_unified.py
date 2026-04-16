"""
SAM3 Unified Segmentation Node

Combines point/box + text prompts for multi-region segmentation.
Each prompt region can have its own text prompt, enabling:
  - Region 1: point click "dog" → find the dog I clicked
  - Region 2: text "cat" + box → find the cat in this area
  - Region 3: text "car" → find all cars

This is the improved version that supports per-region text prompts,
unlike the original SAM3MultipromptSegmentation (points only)
and SAM3Grounding (single global text prompt).
"""

import gc
import hashlib
import json
import logging
import base64
import io as stdio

import numpy as np
import torch
from PIL import Image

import comfy.utils

log = logging.getLogger("sam3")

from comfy_api.latest import io

from .utils import (
    comfy_image_to_pil,
    pil_to_comfy_image,
    masks_to_comfy_mask,
    visualize_masks_on_image,
    tensor_to_list,
)


# ═══════════════════════════════════════════════════════════════════════════
# SAM3TextClickCollector — Interactive collector with per-region text
# ═══════════════════════════════════════════════════════════════════════════

class SAM3TextClickCollector(io.ComfyNode):
    """
    Interactive Multi-Prompt Collector for SAM3

    Like SAM3MultiRegionCollector but each prompt region also has
    a text_prompt field, enabling per-region grounding.

    The frontend widget (sam3_multi_prompt_widget.js) provides:
      - Tab bar for switching between regions
      - Canvas for point/box drawing (same as MultiRegion)
      - Text input per region for grounding prompts
      - Prompt label on canvas showing the active text prompt

    Output: SAM3_MULTI_PROMPTS list where each dict also has "text_prompt".
    """
    _cache = {}

    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="SAM3TextClickCollector",
            display_name="SAM3 Text+Click Collector",
            category="SAM3",
            is_output_node=True,
            inputs=[
                io.Image.Input("image",
                               tooltip="Image to display in interactive canvas. "
                                       "Each region can have points, boxes, AND a text prompt."),
                io.String.Input("multi_prompts_store", multiline=False, default="[]"),
            ],
            outputs=[
                io.Custom("SAM3_MULTI_PROMPTS").Output(display_name="multi_prompts"),
            ],
        )

    @classmethod
    def fingerprint_inputs(cls, **kwargs):
        image = kwargs.get("image")
        multi_prompts_store = kwargs.get("multi_prompts_store")
        h = hashlib.md5()
        h.update(str(image.shape).encode())
        h.update(multi_prompts_store.encode())
        return h.hexdigest()

    @classmethod
    def execute(cls, image, multi_prompts_store):
        """
        Collect multiple prompt regions with per-region text prompts.

        Each region dict in the output has:
          id, positive_points, negative_points, positive_boxes, negative_boxes,
          text_prompt (NEW)

        Coordinates are normalized to [0, 1].
        Boxes are in center format [cx, cy, w, h].
        """
        h = hashlib.md5()
        h.update(str(image.shape).encode())
        h.update(multi_prompts_store.encode())
        cache_key = h.hexdigest()

        if cache_key in SAM3TextClickCollector._cache:
            cached = SAM3TextClickCollector._cache[cache_key]
            log.info(f"CACHE HIT - returning cached result for key={cache_key[:8]}")
            img_base64 = cls._tensor_to_base64(image)
            return io.NodeOutput(cached[0], ui={"bg_image": [img_base64]})

        log.info(f"CACHE MISS - computing new result for key={cache_key[:8]}")

        try:
            raw_prompts = json.loads(multi_prompts_store) if multi_prompts_store.strip() else []
        except json.JSONDecodeError:
            raw_prompts = []

        img_height, img_width = image.shape[1], image.shape[2]
        log.info(f"Image dimensions: {img_width}x{img_height}")
        log.info(f"Processing {len(raw_prompts)} prompt regions")

        multi_prompts = []
        for idx, raw_prompt in enumerate(raw_prompts):
            prompt = {
                "id": idx,
                "positive_points": {"points": [], "labels": []},
                "negative_points": {"points": [], "labels": []},
                "positive_boxes": {"boxes": [], "labels": []},
                "negative_boxes": {"boxes": [], "labels": []},
                "text_prompt": raw_prompt.get("text_prompt", "").strip(),
            }

            # Normalize positive points
            for pt in raw_prompt.get("positive_points", []):
                norm_x = pt["x"] / img_width
                norm_y = pt["y"] / img_height
                prompt["positive_points"]["points"].append([norm_x, norm_y])
                prompt["positive_points"]["labels"].append(1)

            # Normalize negative points
            for pt in raw_prompt.get("negative_points", []):
                norm_x = pt["x"] / img_width
                norm_y = pt["y"] / img_height
                prompt["negative_points"]["points"].append([norm_x, norm_y])
                prompt["negative_points"]["labels"].append(0)

            # Normalize positive boxes → center format
            for box in raw_prompt.get("positive_boxes", []):
                x1_norm = box["x1"] / img_width
                y1_norm = box["y1"] / img_height
                x2_norm = box["x2"] / img_width
                y2_norm = box["y2"] / img_height
                cx = (x1_norm + x2_norm) / 2
                cy = (y1_norm + y2_norm) / 2
                w = x2_norm - x1_norm
                h = y2_norm - y1_norm
                prompt["positive_boxes"]["boxes"].append([cx, cy, w, h])
                prompt["positive_boxes"]["labels"].append(True)

            # Normalize negative boxes → center format
            for box in raw_prompt.get("negative_boxes", []):
                x1_norm = box["x1"] / img_width
                y1_norm = box["y1"] / img_height
                x2_norm = box["x2"] / img_width
                y2_norm = box["y2"] / img_height
                cx = (x1_norm + x2_norm) / 2
                cy = (y1_norm + y2_norm) / 2
                w = x2_norm - x1_norm
                h = y2_norm - y1_norm
                prompt["negative_boxes"]["boxes"].append([cx, cy, w, h])
                prompt["negative_boxes"]["labels"].append(False)

            # Count for logging
            pos_pts = len(prompt["positive_points"]["points"])
            neg_pts = len(prompt["negative_points"]["points"])
            pos_boxes = len(prompt["positive_boxes"]["boxes"])
            neg_boxes = len(prompt["negative_boxes"]["boxes"])
            text = prompt["text_prompt"]
            text_suffix = f', text="{text}"' if text else ''
            log.info(f"  Region {idx}: {pos_pts}+{neg_pts} pts, {pos_boxes}+{neg_boxes} boxes"
                     f"{text_suffix}")

            # Include region if it has any content (geometry or text)
            has_geometry = (pos_pts or neg_pts or pos_boxes or neg_boxes)
            has_text = bool(text)
            if has_geometry or has_text:
                multi_prompts.append(prompt)

        log.info(f"Output: {len(multi_prompts)} non-empty regions")

        SAM3TextClickCollector._cache[cache_key] = (multi_prompts,)
        img_base64 = cls._tensor_to_base64(image)

        return io.NodeOutput(multi_prompts, ui={"bg_image": [img_base64]})

    @staticmethod
    def _tensor_to_base64(tensor):
        """Convert ComfyUI image tensor to base64 string for JavaScript widget."""
        img_array = tensor[0].cpu().numpy()
        img_array = (img_array * 255).astype(np.uint8)
        pil_img = Image.fromarray(img_array)
        buffered = stdio.BytesIO()
        pil_img.save(buffered, format="JPEG", quality=75)
        img_bytes = buffered.getvalue()
        return base64.b64encode(img_bytes).decode('utf-8')


# ═══════════════════════════════════════════════════════════════════════════
# SAM3TextClickSegmentation — Backend segmentation node
# ═══════════════════════════════════════════════════════════════════════════


class SAM3TextClickSegmentation(io.ComfyNode):
    """
    Unified multi-region segmentation combining text and point/box prompts.

    Each prompt region (from SAM3TextClickCollector) can optionally include
    a text_prompt string. The segmentation strategy per region is:

      - text_prompt + points/boxes: Grounding mode with geometric refinement.
        The text finds the object, points/boxes narrow down which instance.
      - text_prompt only: Pure grounding mode (find all matching objects).
      - points/boxes only: Interactive click-segmentation (same as Multiprompt).

    Output: batched masks (one per region) + visualization.
    """

    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="SAM3TextClickSegmentation",
            display_name="SAM3 Text+Click Segmentation",
            category="SAM3",
            inputs=[
                io.Custom("SAM3_MODEL_CONFIG").Input(
                    "sam3_model_config",
                    tooltip="SAM3 model config from LoadSAM3Model node"),
                io.Image.Input("image",
                               tooltip="Input image to segment"),
                io.Custom("SAM3_MULTI_PROMPTS").Input(
                    "multi_prompts",
                    tooltip="Multi-region prompts from SAM3TextClickCollector. "
                            "Each region can have points, boxes, AND a text_prompt."),
                io.Float.Input("confidence_threshold", default=0.2, min=0.0, max=1.0, step=0.01,
                               tooltip="Minimum confidence for grounding (text) detections"),
                io.Int.Input("refinement_iterations", default=0, min=0, max=10, optional=True,
                             tooltip="Refinement passes per region (feeds mask back for cleaner edges)"),
                io.Boolean.Input("use_multimask", default=False, optional=True,
                                 tooltip="Generate 3 mask candidates per interactive region"),
                io.Combo.Input("vis_mode", default="box+fill",
                               options=["box+fill", "box_only", "fill_only"], optional=True,
                               tooltip="Visualization mode: box+fill = boxes and colored overlay, "
                                       "box_only = bounding boxes only, fill_only = colored overlay only"),
            ],
            outputs=[
                io.Mask.Output(display_name="masks"),
                io.Image.Output(display_name="visualization"),
            ],
        )

    @classmethod
    def execute(cls, sam3_model_config, image, multi_prompts,
                confidence_threshold=0.2, refinement_iterations=0,
                use_multimask=False, vis_mode="box+fill"):
        """
        Perform unified multi-region segmentation.
        """
        import json
        from ._model_cache import get_or_build_model
        import comfy.model_management

        sam3_model = get_or_build_model(sam3_model_config)
        comfy.model_management.load_models_gpu([sam3_model])

        processor = sam3_model.processor
        model = processor.model

        if hasattr(processor, 'sync_device_with_model'):
            processor.sync_device_with_model()

        # Convert image
        pil_image = comfy_image_to_pil(image)
        img_w, img_h = pil_image.size
        log.info(f"[UnifiedSeg] Image size: {pil_image.size}")
        log.info(f"[UnifiedSeg] Processing {len(multi_prompts)} prompt regions, vis_mode={vis_mode}")

        if len(multi_prompts) == 0:
            empty_mask = torch.zeros(1, img_h, img_w)
            return io.NodeOutput(empty_mask, pil_to_comfy_image(pil_image))

        # Flush GPU memory before heavy work
        gc.collect()
        comfy.model_management.soft_empty_cache(force=True)

        all_masks = []
        all_scores = []

        pbar = comfy.utils.ProgressBar(len(multi_prompts))

        for prompt_idx, prompt in enumerate(multi_prompts):
            comfy.model_management.throw_exception_if_processing_interrupted()

            text_prompt = prompt.get("text_prompt", "").strip()
            has_text = bool(text_prompt)

            # Collect geometric prompts
            all_points, all_point_labels = cls._collect_points(prompt, img_w, img_h)
            box_array = cls._collect_box(prompt, img_w, img_h)

            has_geometry = all_points is not None or box_array is not None

            log.info(f"[UnifiedSeg] Region {prompt_idx + 1}/{len(multi_prompts)}: "
                      f"text={'yes' if has_text else 'no'}, "
                      f"points={len(all_points) if all_points is not None else 0}, "
                      f"box={'yes' if box_array is not None else 'no'}")

            if not has_text and not has_geometry:
                log.info(f"[UnifiedSeg]   Skipping empty region {prompt_idx}")
                pbar.update(1)
                continue

            if has_text:
                # ── Grounding path ──
                # CRITICAL: Create a FRESH state for each grounding region.
                # reset_all_prompts corrupts backbone_out, causing set_text_prompt to fail.
                # SAM3Grounding (the working reference) always creates fresh state per call.
                state = processor.set_image(pil_image)

                best_mask, best_score = cls._segment_grounding_region(
                    processor, state, text_prompt, confidence_threshold,
                    all_points, all_point_labels, box_array,
                    img_w, img_h, refinement_iterations, use_multimask,
                    prompt=prompt  # pass raw prompt for normalized box access
                )
            else:
                # ── Interactive (click) path ──
                # For interactive path, we also need fresh state if this is the first call,
                # or we can reuse if the previous region was interactive too.
                # For simplicity and correctness, always create fresh state.
                state = processor.set_image(pil_image)

                best_mask, best_score = cls._segment_interactive_region(
                    model, state, all_points, all_point_labels, box_array,
                    refinement_iterations, use_multimask
                )

            if best_mask is not None:
                all_masks.append(torch.from_numpy(best_mask).float())
                all_scores.append(best_score)
                log.info(f"[UnifiedSeg]   Score: {best_score:.4f}")
            else:
                log.info(f"[UnifiedSeg]   No mask produced for region {prompt_idx}")

            pbar.update(1)

        if len(all_masks) == 0:
            log.info("[UnifiedSeg] No valid masks generated")
            empty_mask = torch.zeros(1, img_h, img_w)
            return io.NodeOutput(empty_mask, pil_to_comfy_image(pil_image))

        # Stack all masks and ensure 3D [N, H, W]
        masks = torch.stack(all_masks, dim=0)  # may be [N, 1, H, W] or [N, H, W]
        while masks.ndim > 3:
            masks = masks.squeeze(1)  # remove channel dim → [N, H, W]
        scores = torch.tensor(all_scores)
        log.info(f"[UnifiedSeg] Generated {masks.shape[0]} masks, mask shape: {masks.shape}")

        # Compute bounding boxes for visualization
        boxes_list = []
        for i in range(masks.shape[0]):
            mask_coords = torch.where(masks[i] > 0)
            if len(mask_coords[0]) > 0:
                y1 = mask_coords[0].min().item()
                y2 = mask_coords[0].max().item()
                x1 = mask_coords[1].min().item()
                x2 = mask_coords[1].max().item()
                boxes_list.append([x1, y1, x2, y2])
            else:
                boxes_list.append([0, 0, 0, 0])
        boxes = torch.tensor(boxes_list).float()

        comfy_masks = masks_to_comfy_mask(masks)
        vis_image = visualize_masks_on_image(pil_image, masks, boxes, scores, alpha=0.5, vis_mode=vis_mode)
        vis_tensor = pil_to_comfy_image(vis_image)

        # Cleanup
        del state
        gc.collect()
        comfy.model_management.soft_empty_cache()

        return io.NodeOutput(comfy_masks, vis_tensor)

    # ── Helper: collect points from a prompt region ──

    @staticmethod
    def _collect_points(prompt, img_w, img_h):
        """Extract and denormalize points from a prompt region."""
        all_points = []
        all_point_labels = []

        pos_points = prompt.get("positive_points", {}).get("points", [])
        for pt in pos_points:
            all_points.append([pt[0] * img_w, pt[1] * img_h])
            all_point_labels.append(1)

        neg_points = prompt.get("negative_points", {}).get("points", [])
        for pt in neg_points:
            all_points.append([pt[0] * img_w, pt[1] * img_h])
            all_point_labels.append(0)

        point_coords = np.array(all_points) if all_points else None
        point_labels = np.array(all_point_labels) if all_point_labels else None
        return point_coords, point_labels

    # ── Helper: collect box from a prompt region ──

    @staticmethod
    def _collect_box(prompt, img_w, img_h):
        """Extract and denormalize the first positive box from a prompt region."""
        pos_boxes = prompt.get("positive_boxes", {}).get("boxes", [])
        if len(pos_boxes) > 0:
            cx, cy, w, h = pos_boxes[0]
            x1 = (cx - w / 2) * img_w
            y1 = (cy - h / 2) * img_h
            x2 = (cx + w / 2) * img_w
            y2 = (cy + h / 2) * img_h
            return np.array([x1, y1, x2, y2])
        return None

    # ── Grounding path: text + optional geometry ──

    @staticmethod
    def _segment_grounding_region(processor, state, text_prompt, confidence_threshold,
                                   point_coords, point_labels, box_array,
                                   img_w, img_h, refinement_iterations, use_multimask,
                                   prompt=None):
        """
        Segment using grounding (text) mode, with optional geometric refinement.

        This follows the EXACT same pattern as SAM3Grounding._segment_grounding(),
        which is known to work correctly.

        Strategy:
          1. set_confidence_threshold
          2. set_text_prompt → runs _forward_grounding internally
          3. add_multiple_box_prompts (if boxes available) → runs _forward_grounding
          4. add_point_prompt (if points available) → runs _forward_grounding
          5. Extract results from state
          6. Pick best mask
        """
        import comfy.model_management
        model = processor.model

        log.info(f"[UnifiedSeg]   === GROUNDING PATH ===")
        log.info(f"[UnifiedSeg]   Text prompt: '{text_prompt}'")
        log.info(f"[UnifiedSeg]   Confidence threshold: {confidence_threshold}")
        log.info(f"[UnifiedSeg]   Has points: {point_coords is not None and len(point_coords) > 0}")
        log.info(f"[UnifiedSeg]   Has box: {box_array is not None}")

        # Step 1: Set confidence threshold (same as SAM3Grounding)
        processor.set_confidence_threshold(confidence_threshold)

        # Step 2: Set text prompt (same as SAM3Grounding)
        # This encodes the text and runs _forward_grounding internally
        log.info(f"[UnifiedSeg]   Calling set_text_prompt('{text_prompt.strip()}')...")
        state = processor.set_text_prompt(text_prompt.strip(), state)

        # Check state after set_text_prompt
        masks_after_text = state.get("masks", None)
        scores_after_text = state.get("scores", None)
        if masks_after_text is not None:
            log.info(f"[UnifiedSeg]   After set_text_prompt: {len(masks_after_text)} detections")
            if scores_after_text is not None and len(scores_after_text) > 0:
                log.info(f"[UnifiedSeg]   Scores: {scores_after_text.tolist()[:5]}")
        else:
            log.info(f"[UnifiedSeg]   After set_text_prompt: NO detections")

        # Step 3: Add geometric prompts (boxes first, then points)
        # Same pattern as SAM3Grounding with add_multiple_box_prompts
        if prompt is not None:
            all_boxes = []
            all_box_labels = []

            pos_boxes = prompt.get("positive_boxes", {}).get("boxes", [])
            pos_labels = prompt.get("positive_boxes", {}).get("labels", [])
            neg_boxes = prompt.get("negative_boxes", {}).get("boxes", [])
            neg_labels = prompt.get("negative_boxes", {}).get("labels", [])

            for bx, bl in zip(pos_boxes, pos_labels):
                all_boxes.append(bx)  # already [cx, cy, w, h] normalized
                all_box_labels.append(bool(bl))
            for bx, bl in zip(neg_boxes, neg_labels):
                all_boxes.append(bx)
                all_box_labels.append(bool(bl))

            if len(all_boxes) > 0:
                log.info(f"[UnifiedSeg]   Adding {len(all_boxes)} box prompts via add_multiple_box_prompts...")
                state = processor.add_multiple_box_prompts(all_boxes, all_box_labels, state)

        # Add points as geometric prompt
        has_points = point_coords is not None and len(point_coords) > 0
        if has_points:
            # Convert pixel coords to normalized [0,1] for add_point_prompt
            norm_points = (point_coords / np.array([img_w, img_h])).tolist()
            int_labels = point_labels.astype(int).tolist()
            log.info(f"[UnifiedSeg]   Adding {len(norm_points)} point prompts via add_point_prompt...")
            log.info(f"[UnifiedSeg]   Normalized points: {norm_points}")
            log.info(f"[UnifiedSeg]   Point labels: {int_labels}")
            state = processor.add_point_prompt(norm_points, int_labels, state)

        # Step 4: Extract final results
        masks = state.get("masks", None)
        scores = state.get("scores", None)
        boxes = state.get("boxes", None)

        log.info(f"[UnifiedSeg]   Final state keys: {list(state.keys())}")
        log.info(f"[UnifiedSeg]   Final masks: {type(masks)} {masks.shape if masks is not None else 'None'}")
        log.info(f"[UnifiedSeg]   Final scores: {type(scores)} {scores.shape if scores is not None else 'None'}")

        if masks is None or len(masks) == 0:
            log.info(f"[UnifiedSeg]   No grounding detections for '{text_prompt}' "
                     f"at threshold {confidence_threshold}")
            # Fallback: try with very low threshold
            if confidence_threshold > 0.05:
                log.info(f"[UnifiedSeg]   Retrying with threshold 0.05...")
                processor.set_confidence_threshold(0.05)
                state = processor._forward_grounding(state)
                masks = state.get("masks", None)
                scores = state.get("scores", None)
                if masks is None or len(masks) == 0:
                    log.info(f"[UnifiedSeg]   Still no detections after lowering threshold")
                    return None, 0.0
                log.info(f"[UnifiedSeg]   Found {len(masks)} detections with lower threshold")
            else:
                return None, 0.0

        # Step 5: Pick the best mask
        if has_points:
            best_idx = SAM3TextClickSegmentation._pick_detection_near_points(
                masks, scores, point_coords, point_labels)
        else:
            if scores is not None and len(scores) > 0:
                sorted_indices = torch.argsort(scores, descending=True)
                best_idx = sorted_indices[0].item()
            else:
                best_idx = 0

        best_mask = masks[best_idx].cpu().numpy().astype(np.float32)
        best_mask = (best_mask > 0.5).astype(np.float32)
        best_score = scores[best_idx].item() if scores is not None else 0.0

        log.info(f"[UnifiedSeg]   Selected mask idx={best_idx}, score={best_score:.4f}, "
                 f"pixels={int(best_mask.sum())}")

        # Step 6: Optional refinement using predict_inst
        if refinement_iterations > 0 and model.inst_interactive_predictor is not None:
            # Use masks_logits as approximate low-res mask input for refinement
            masks_logits = state.get("masks_logits", None)
            if masks_logits is not None:
                mask_input = masks_logits[best_idx:best_idx + 1]
                for i in range(refinement_iterations):
                    comfy.model_management.throw_exception_if_processing_interrupted()
                    try:
                        masks_np, scores_np, low_res_masks_new = model.predict_inst(
                            state,
                            point_coords=point_coords if has_points else None,
                            point_labels=point_labels if has_points else None,
                            box=box_array if box_array is not None else None,
                            mask_input=mask_input,
                            multimask_output=use_multimask,
                            normalize_coords=True,
                        )
                        refine_idx = np.argmax(scores_np)
                        best_mask = masks_np[refine_idx].astype(np.float32)
                        best_score = float(scores_np[refine_idx])
                        mask_input = low_res_masks_new[refine_idx:refine_idx + 1]
                        log.info(f"[UnifiedSeg]   Refinement {i+1}: score={best_score:.4f}")
                    except Exception as e:
                        log.warning(f"[UnifiedSeg]   Refinement {i+1} failed: {e}")
                        break

        return best_mask, best_score

    # ── Interactive path: points/boxes only ──

    @staticmethod
    def _segment_interactive_region(model, state, point_coords, point_labels, box_array,
                                     refinement_iterations, use_multimask):
        """Segment using interactive (click) mode — same as SAM3MultipromptSegmentation."""
        masks_np, scores_np, low_res_masks = model.predict_inst(
            state,
            point_coords=point_coords,
            point_labels=point_labels,
            box=box_array,
            mask_input=None,
            multimask_output=use_multimask,
            normalize_coords=True,
        )

        # Refinement
        for i in range(refinement_iterations):
            import comfy.model_management
            comfy.model_management.throw_exception_if_processing_interrupted()
            best_idx = np.argmax(scores_np)
            masks_np, scores_np, low_res_masks = model.predict_inst(
                state,
                point_coords=point_coords,
                point_labels=point_labels,
                box=box_array,
                mask_input=low_res_masks[best_idx:best_idx + 1],
                multimask_output=use_multimask,
                normalize_coords=True,
            )

        best_idx = np.argmax(scores_np)
        return masks_np[best_idx], scores_np[best_idx]

    # ── Pick detection closest to positive points ──

    @staticmethod
    def _pick_detection_near_points(masks, scores, point_coords, point_labels):
        """
        Pick the detection whose mask center is closest to positive points.
        Falls back to highest score if no positive points or no overlap.
        """
        # Only use positive points for proximity
        pos_mask = (point_labels == 1)
        if not np.any(pos_mask):
            # No positive points — pick by score
            if scores is not None and len(scores) > 0:
                return torch.argsort(scores, descending=True)[0].item()
            return 0

        pos_points = point_coords[pos_mask]  # [N, 2] in pixel coords
        click_center = pos_points.mean(axis=0)  # [2]

        best_idx = 0
        best_dist = float('inf')

        for i in range(len(masks)):
            mask_np = masks[i].cpu().numpy()
            # Ensure 2D mask: squeeze out channel/batch dims
            mask_np = mask_np.squeeze()
            mask_coords = np.argwhere(mask_np > 0)  # (N, 2) as (row=y, col=x)
            if len(mask_coords) == 0:
                continue

            # Mask center (y, x) → (x, y) to match point_coords format
            mask_center = mask_coords.mean(axis=0)[::-1]

            dist = np.sqrt(((mask_center - click_center) ** 2).sum())
            if dist < best_dist:
                best_dist = dist
                best_idx = i

        return best_idx


NODE_CLASS_MAPPINGS = {
    "SAM3TextClickCollector": SAM3TextClickCollector,
    "SAM3TextClickSegmentation": SAM3TextClickSegmentation,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "SAM3TextClickCollector": "SAM3 Text+Click Collector",
    "SAM3TextClickSegmentation": "SAM3 Text+Click Segmentation",
}
