#!/usr/bin/env python3
"""Generate clickable masks with Meta Segment Anything (SAM).

This backend keeps the same JSON contract as segment_image.py, but uses a real
segmentation model. It is optional: server.mjs falls back to the lightweight
Numpy backend when the SAM venv/checkpoint is not present.
"""
from __future__ import annotations

import argparse
import json
import math
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("image")
    parser.add_argument("outdir")
    parser.add_argument("--checkpoint", required=True)
    parser.add_argument("--model-type", default="vit_b")
    parser.add_argument("--device", default="cpu")
    parser.add_argument("--max-dim", type=int, default=768)
    parser.add_argument("--max-masks", type=int, default=8)
    parser.add_argument("--points-per-side", type=int, default=24)
    args = parser.parse_args()

    try:
        import torch
        from segment_anything import SamAutomaticMaskGenerator, sam_model_registry
    except Exception as exc:  # pragma: no cover - setup dependent
        raise SystemExit(
            "SAM dependencies are missing. Run tools/setup_sam.sh first, "
            "or use SEGMENT_BACKEND=fallback."
        ) from exc

    source = Path(args.image)
    outdir = Path(args.outdir)
    checkpoint = Path(args.checkpoint)
    if not checkpoint.exists():
        raise SystemExit(f"SAM checkpoint not found: {checkpoint}")
    outdir.mkdir(parents=True, exist_ok=True)

    original = Image.open(source).convert("RGB")
    ow, oh = original.size
    scale = min(args.max_dim / max(ow, oh), 1.0)
    sw, sh = max(1, int(round(ow * scale))), max(1, int(round(oh * scale)))
    working = original.resize((sw, sh), Image.Resampling.LANCZOS)
    image_np = np.asarray(working)

    device = choose_device(torch, args.device)
    sam = sam_model_registry[args.model_type](checkpoint=str(checkpoint))
    sam.to(device=device)
    mask_generator = SamAutomaticMaskGenerator(
        model=sam,
        points_per_side=args.points_per_side,
        pred_iou_thresh=0.86,
        stability_score_thresh=0.88,
        crop_n_layers=1,
        crop_n_points_downscale_factor=2,
        min_mask_region_area=max(64, int(sw * sh * 0.001)),
    )

    raw_masks = mask_generator.generate(image_np)
    selected = select_masks(raw_masks, sw, sh, max_masks=max(1, args.max_masks - 1))
    results = build_results(selected, sw, sh, ow, oh, outdir, max_masks=args.max_masks)

    print(json.dumps({
        "backend": f"sam-{args.model_type}",
        "width": ow,
        "height": oh,
        "segments": results,
    }, ensure_ascii=False))


def choose_device(torch, requested: str) -> str:
    if requested == "auto":
        if torch.cuda.is_available():
            return "cuda"
        if getattr(torch.backends, "mps", None) and torch.backends.mps.is_available():
            return "mps"
        return "cpu"
    return requested


def select_masks(raw_masks: list[dict], width: int, height: int, max_masks: int) -> list[dict]:
    total = max(1, width * height)
    candidates: list[dict] = []
    for item in raw_masks:
        mask = np.asarray(item["segmentation"], dtype=bool)
        area = int(mask.sum())
        area_ratio = area / total
        if area_ratio < 0.004 or area_ratio > 0.82:
            continue
        x, y, bw, bh = [int(v) for v in item["bbox"]]
        bbox_ratio = (bw * bh) / total
        if bbox_ratio > 0.92:
            continue
        compactness = area / max(1, bw * bh)
        center_score = bbox_center_score(x, y, bw, bh, width, height)
        quality = float(item.get("predicted_iou", 0.0)) * 0.58 + float(item.get("stability_score", 0.0)) * 0.32
        shape_bonus = min(0.12, compactness * 0.12)
        area_penalty = abs(math.log(max(area_ratio, 1e-6) / 0.10)) * 0.018
        item["_mask"] = mask
        item["_score"] = quality + center_score * 0.12 + shape_bonus - area_penalty
        item["_area_ratio"] = area_ratio
        candidates.append(item)

    candidates.sort(key=lambda item: item["_score"], reverse=True)
    selected: list[dict] = []
    for item in candidates:
        if any(is_duplicate(item["_mask"], prev["_mask"]) for prev in selected):
            continue
        selected.append(item)
        if len(selected) >= max_masks:
            break

    selected.sort(key=lambda item: label_rank(item, width, height))
    return selected


def bbox_center_score(x: int, y: int, w: int, h: int, image_w: int, image_h: int) -> float:
    cx = (x + w / 2) / max(1, image_w)
    cy = (y + h / 2) / max(1, image_h)
    return math.exp(-(((cx - 0.5) / 0.38) ** 2 + ((cy - 0.5) / 0.42) ** 2))


def is_duplicate(mask: np.ndarray, other: np.ndarray) -> bool:
    inter = int(np.logical_and(mask, other).sum())
    if inter == 0:
        return False
    area = int(mask.sum())
    other_area = int(other.sum())
    union = area + other_area - inter
    iou = inter / max(1, union)
    containment = inter / max(1, min(area, other_area))
    return iou > 0.72 or containment > 0.90


def label_rank(item: dict, width: int, height: int) -> tuple[float, float]:
    x, y, w, h = [int(v) for v in item["bbox"]]
    center = bbox_center_score(x, y, w, h, width, height)
    area = max(float(item["_area_ratio"]), 1e-6)
    large_region_penalty = 0.8 if area > 0.35 else 0.0
    area_preference = abs(math.log(area / 0.10)) * 0.10
    return (large_region_penalty + area_preference - center * 0.45 - float(item["_score"]) * 0.12, -float(item["_score"]))


def build_results(
    selected: list[dict],
    sw: int,
    sh: int,
    ow: int,
    oh: int,
    outdir: Path,
    max_masks: int,
) -> list[dict]:
    entries: list[tuple[str, float, np.ndarray]] = []
    used_union = np.zeros((sh, sw), dtype=bool)

    for idx, item in enumerate(selected[:max_masks], start=1):
        mask = item["_mask"]
        used_union |= mask
        label = label_for(item, idx)
        entries.append((label, float(item["_score"]), mask))

    if selected and len(entries) < max_masks:
        background = ~used_union
        if background.mean() > 0.05:
            entries.insert(1, ("背景/未选区域", 0.72, background))

    results: list[dict] = []
    label_counts: dict[str, int] = {}
    for idx, (label, score, mask) in enumerate(entries[:max_masks], start=1):
        results.append(write_result(idx, label, score, mask, sw, sh, ow, oh, outdir, label_counts))
    return results[:max_masks]


def label_for(item: dict, idx: int) -> str:
    if idx == 1:
        return "主体"
    x, y, w, h = [int(v) for v in item["bbox"]]
    ratio = w / max(1, h)
    area = float(item["_area_ratio"])
    if area > 0.28:
        return "大区域"
    if ratio > 2.2:
        return "横向区域"
    if ratio < 0.45:
        return "纵向区域"
    return "清晰物体"


def write_result(
    idx: int,
    label: str,
    score: float,
    mask: np.ndarray,
    sw: int,
    sh: int,
    ow: int,
    oh: int,
    outdir: Path,
    label_counts: dict[str, int],
) -> dict:
    mask_img = Image.fromarray((mask.astype(np.uint8) * 255), mode="L").resize((ow, oh), Image.Resampling.NEAREST)
    preview_img = mask_img.filter(ImageFilter.GaussianBlur(radius=max(1.0, min(ow, oh) / 900)))
    mask_name = f"mask-{idx:02d}.png"
    preview_name = f"mask-{idx:02d}-preview.png"
    mask_img.save(outdir / mask_name)
    preview_img.save(outdir / preview_name)

    x0, y0, x1, y1 = bbox_of(mask) or (0, 0, sw - 1, sh - 1)
    label_counts[label] = label_counts.get(label, 0) + 1
    display_label = label if label_counts[label] == 1 else f"{label} {label_counts[label]}"
    return {
        "id": f"seg-{idx:02d}",
        "label": display_label,
        "score": round(score, 3),
        "areaRatio": round(float(mask.mean()), 4),
        "bbox": [
            round(x0 / sw, 4),
            round(y0 / sh, 4),
            round((x1 + 1) / sw, 4),
            round((y1 + 1) / sh, 4),
        ],
        "maskFile": mask_name,
        "previewFile": preview_name,
    }


def bbox_of(mask: np.ndarray) -> tuple[int, int, int, int] | None:
    ys, xs = np.where(mask)
    if len(xs) == 0:
        return None
    return int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max())


if __name__ == "__main__":
    main()
