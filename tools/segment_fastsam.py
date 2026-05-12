#!/usr/bin/env python3
"""Generate clickable masks with Ultralytics FastSAM.

FastSAM is a smaller, practical middle ground for this local demo: it is much
lighter than the full SAM checkpoint and produces object-like masks that are
good enough for click-to-edit workflows.
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
    parser.add_argument("--model", required=True)
    parser.add_argument("--device", default="cpu")
    parser.add_argument("--max-dim", type=int, default=768)
    parser.add_argument("--max-masks", type=int, default=8)
    args = parser.parse_args()

    try:
        from ultralytics import FastSAM
    except Exception as exc:  # pragma: no cover - setup dependent
        raise SystemExit("FastSAM dependencies are missing. Run tools/setup_fastsam.sh first.") from exc

    source = Path(args.image)
    outdir = Path(args.outdir)
    model_path = Path(args.model)
    if not model_path.exists():
        raise SystemExit(f"FastSAM model not found: {model_path}")
    outdir.mkdir(parents=True, exist_ok=True)

    original = Image.open(source).convert("RGB")
    ow, oh = original.size
    model = FastSAM(str(model_path))
    result = model(
        str(source),
        device=args.device,
        imgsz=args.max_dim,
        retina_masks=True,
        verbose=False,
    )[0]

    if result.masks is None:
        print(json.dumps({"backend": "fastsam-s", "width": ow, "height": oh, "segments": []}, ensure_ascii=False))
        return

    masks = result.masks.data.cpu().numpy() > 0.5
    boxes = result.boxes.data.cpu().numpy() if result.boxes is not None else np.zeros((len(masks), 6))
    candidates = select_masks(masks, boxes, ow, oh, max_masks=max(1, args.max_masks - 1))
    segments = build_results(candidates, ow, oh, outdir, max_masks=args.max_masks)

    print(json.dumps({
        "backend": "fastsam-s",
        "width": ow,
        "height": oh,
        "segments": segments,
    }, ensure_ascii=False))


def select_masks(masks: np.ndarray, boxes: np.ndarray, width: int, height: int, max_masks: int) -> list[dict]:
    candidates: list[dict] = []
    for idx, raw_mask in enumerate(masks):
        mask = ensure_size(raw_mask, width, height)
        area_ratio = float(mask.mean())
        if area_ratio < 0.004 or area_ratio > 0.76:
            continue
        bbox = bbox_of(mask)
        if not bbox:
            continue
        x0, y0, x1, y1 = bbox
        bw = x1 - x0 + 1
        bh = y1 - y0 + 1
        bbox_ratio = (bw * bh) / max(1, width * height)
        compactness = area_ratio / max(bbox_ratio, 1e-6)
        confidence = float(boxes[idx][4]) if boxes.shape[1] > 4 else 0.5
        score = rank_score(area_ratio, compactness, confidence, bbox, width, height)
        candidates.append({
            "mask": mask,
            "bbox": bbox,
            "area_ratio": area_ratio,
            "compactness": compactness,
            "confidence": confidence,
            "score": score,
        })

    candidates.sort(key=lambda item: item["score"], reverse=True)
    selected: list[dict] = []
    for item in candidates:
        if any(is_duplicate(item["mask"], prev["mask"]) for prev in selected):
            continue
        selected.append(item)
        if len(selected) >= max_masks:
            break
    return selected


def ensure_size(mask: np.ndarray, width: int, height: int) -> np.ndarray:
    if mask.shape == (height, width):
        return mask.astype(bool)
    image = Image.fromarray(mask.astype(np.uint8) * 255, mode="L").resize((width, height), Image.Resampling.NEAREST)
    return np.asarray(image) > 128


def rank_score(
    area_ratio: float,
    compactness: float,
    confidence: float,
    bbox: tuple[int, int, int, int],
    width: int,
    height: int,
) -> float:
    x0, y0, x1, y1 = bbox
    cx = ((x0 + x1) / 2) / max(1, width)
    cy = ((y0 + y1) / 2) / max(1, height)
    center = math.exp(-(((cx - 0.5) / 0.48) ** 2 + ((cy - 0.52) / 0.48) ** 2))
    medium_object = math.exp(-abs(math.log(max(area_ratio, 1e-6) / 0.08)) * 0.5)
    score = confidence * 0.45 + medium_object * 0.25 + center * 0.20 + min(compactness, 1.0) * 0.15
    if area_ratio > 0.35:
        score -= 0.20
    return score


def build_results(candidates: list[dict], width: int, height: int, outdir: Path, max_masks: int) -> list[dict]:
    entries: list[tuple[str, float, np.ndarray, tuple[int, int, int, int], float]] = []
    used_union = np.zeros((height, width), dtype=bool)
    for idx, item in enumerate(candidates, start=1):
        mask = item["mask"]
        used_union |= mask
        entries.append((label_for(item, idx), item["score"], mask, item["bbox"], item["area_ratio"]))

    if entries and len(entries) < max_masks:
        background = ~used_union
        if background.mean() > 0.08:
            entries.insert(1, ("背景/未选区域", 0.70, background, bbox_of(background) or (0, 0, width - 1, height - 1), float(background.mean())))

    results: list[dict] = []
    label_counts: dict[str, int] = {}
    for idx, (label, score, mask, bbox, area_ratio) in enumerate(entries[:max_masks], start=1):
        results.append(write_result(idx, label, score, mask, bbox, area_ratio, width, height, outdir, label_counts))
    return results


def label_for(item: dict, idx: int) -> str:
    if idx == 1:
        return "主体"
    x0, y0, x1, y1 = item["bbox"]
    width = x1 - x0 + 1
    height = y1 - y0 + 1
    ratio = width / max(1, height)
    area = float(item["area_ratio"])
    if ratio > 2.0:
        return "横向区域"
    if ratio < 0.50:
        return "纵向区域"
    if area > 0.18:
        return "大区域"
    return "清晰物体"


def write_result(
    idx: int,
    label: str,
    score: float,
    mask: np.ndarray,
    bbox: tuple[int, int, int, int],
    area_ratio: float,
    width: int,
    height: int,
    outdir: Path,
    label_counts: dict[str, int],
) -> dict:
    mask_img = Image.fromarray((mask.astype(np.uint8) * 255), mode="L")
    preview_img = mask_img.filter(ImageFilter.GaussianBlur(radius=max(1.0, min(width, height) / 900)))
    mask_name = f"mask-{idx:02d}.png"
    preview_name = f"mask-{idx:02d}-preview.png"
    mask_img.save(outdir / mask_name)
    preview_img.save(outdir / preview_name)

    label_counts[label] = label_counts.get(label, 0) + 1
    display_label = label if label_counts[label] == 1 else f"{label} {label_counts[label]}"
    x0, y0, x1, y1 = bbox
    return {
        "id": f"seg-{idx:02d}",
        "label": display_label,
        "score": round(float(score), 3),
        "areaRatio": round(float(area_ratio), 4),
        "bbox": [
            round(x0 / width, 4),
            round(y0 / height, 4),
            round((x1 + 1) / width, 4),
            round((y1 + 1) / height, 4),
        ],
        "maskFile": mask_name,
        "previewFile": preview_name,
    }


def is_duplicate(mask: np.ndarray, other: np.ndarray) -> bool:
    inter = int(np.logical_and(mask, other).sum())
    if inter == 0:
        return False
    area = int(mask.sum())
    other_area = int(other.sum())
    union = area + other_area - inter
    iou = inter / max(1, union)
    containment = inter / max(1, min(area, other_area))
    return iou > 0.65 or containment > 0.88


def bbox_of(mask: np.ndarray) -> tuple[int, int, int, int] | None:
    ys, xs = np.where(mask)
    if len(xs) == 0:
        return None
    return int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max())


if __name__ == "__main__":
    main()
