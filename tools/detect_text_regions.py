#!/usr/bin/env python3
"""Detect likely text/title regions and emit clickable masks.

SAM/FastSAM often treats text as background texture. This helper adds coarse
text-block masks before optional LLM semantic cleanup. It intentionally detects
blocks/lines rather than OCR text content; for image editing, a slightly padded
text mask is more useful than character-perfect OCR.
"""
from __future__ import annotations

import argparse
import json
from collections import deque
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("image")
    parser.add_argument("outdir")
    parser.add_argument("--max-dim", type=int, default=960)
    parser.add_argument("--max-regions", type=int, default=4)
    args = parser.parse_args()

    source = Path(args.image)
    outdir = Path(args.outdir)
    outdir.mkdir(parents=True, exist_ok=True)

    original = Image.open(source).convert("RGB")
    ow, oh = original.size
    scale = min(args.max_dim / max(ow, oh), 1.0)
    sw, sh = max(1, int(round(ow * scale))), max(1, int(round(oh * scale)))
    working = original.resize((sw, sh), Image.Resampling.LANCZOS)

    candidates = detect_text_blocks(working, max_regions=args.max_regions)
    results = []
    for idx, item in enumerate(candidates, start=1):
        mask = item["mask"]
        mask_img = Image.fromarray(mask.astype(np.uint8) * 255, mode="L").resize((ow, oh), Image.Resampling.NEAREST)
        preview_img = mask_img.filter(ImageFilter.GaussianBlur(radius=max(1.0, min(ow, oh) / 900)))
        mask_name = f"text-mask-{idx:02d}.png"
        preview_name = f"text-mask-{idx:02d}-preview.png"
        mask_img.save(outdir / mask_name)
        preview_img.save(outdir / preview_name)
        x0, y0, x1, y1 = item["bbox"]
        results.append({
            "id": f"text-{idx:02d}",
            "label": item["label"],
            "score": round(max(0.0, min(0.98, float(item["score"]))), 3),
            "areaRatio": round(float(mask.mean()), 4),
            "bbox": [
                round(x0 / sw, 4),
                round(y0 / sh, 4),
                round((x1 + 1) / sw, 4),
                round((y1 + 1) / sh, 4),
            ],
            "maskFile": mask_name,
            "previewFile": preview_name,
            "source": "text-detection",
        })

    print(json.dumps({"segments": results}, ensure_ascii=False))


def detect_text_blocks(image: Image.Image, max_regions: int) -> list[dict]:
    rgb = np.asarray(image).astype(np.float32) / 255.0
    gray_img = image.convert("L")
    gray = np.asarray(gray_img).astype(np.float32) / 255.0
    blur = np.asarray(gray_img.filter(ImageFilter.GaussianBlur(radius=1.4))).astype(np.float32) / 255.0

    local_detail = np.abs(gray - blur)
    gx = np.zeros_like(gray)
    gy = np.zeros_like(gray)
    gx[:, 1:] = np.abs(gray[:, 1:] - gray[:, :-1])
    gy[1:, :] = np.abs(gray[1:, :] - gray[:-1, :])
    edge_strength = np.maximum(local_detail * 1.45, np.maximum(gx, gy))

    threshold = max(float(np.percentile(edge_strength, 90)), 0.055)
    edge = edge_strength >= threshold

    # Text is often made of many nearby strokes. Connect strokes into lines,
    # then filter out large photo edges and noisy texture.
    line_mask = close_rect(edge, rx=9, ry=1)
    line_mask = dilate_rect(line_mask, rx=3, ry=1)

    h, w = gray.shape
    image_area = h * w
    proposals: list[dict] = []
    for comp in connected_components(line_mask):
        area = int(comp.sum())
        if area < max(24, int(image_area * 0.00018)):
            continue
        bbox = bbox_of(comp)
        if not bbox:
            continue
        x0, y0, x1, y1 = bbox
        bw, bh = x1 - x0 + 1, y1 - y0 + 1
        bbox_area = bw * bh
        bbox_ratio = bbox_area / image_area
        if bbox_ratio < 0.0008 or bbox_ratio > 0.22:
            continue
        if bw < max(18, int(w * 0.025)) or bh < max(7, int(h * 0.010)):
            continue
        if bh > h * 0.22:
            continue
        aspect = bw / max(1, bh)
        if aspect < 1.15:
            continue

        raw_edge = edge[y0:y1 + 1, x0:x1 + 1]
        density = float(raw_edge.mean())
        if density < 0.035 or density > 0.55:
            continue

        contrast = float(edge_strength[y0:y1 + 1, x0:x1 + 1][raw_edge].mean()) if raw_edge.any() else 0.0
        if contrast < 0.07:
            continue

        # Text usually contains alternating foreground/background strokes. A
        # very low luminance spread is more likely a soft texture region.
        lum_spread = float(np.percentile(gray[y0:y1 + 1, x0:x1 + 1], 92) - np.percentile(gray[y0:y1 + 1, x0:x1 + 1], 8))
        if lum_spread < 0.18:
            continue

        # Reject strongly colorful natural texture if it does not look stroke-like.
        color_spread = float(np.mean(np.std(rgb[y0:y1 + 1, x0:x1 + 1], axis=(0, 1))))
        score = 0.55 + min(0.22, contrast * 0.85) + min(0.16, density * 0.55) + min(0.08, aspect / 24)
        if color_spread > 0.24 and density < 0.08:
            score -= 0.12

        pad_x = max(4, int(round(bw * 0.06)))
        pad_y = max(3, int(round(bh * 0.22)))
        px0, py0 = max(0, x0 - pad_x), max(0, y0 - pad_y)
        px1, py1 = min(w - 1, x1 + pad_x), min(h - 1, y1 + pad_y)
        mask = np.zeros((h, w), dtype=bool)
        mask[py0:py1 + 1, px0:px1 + 1] = True
        proposals.append({
            "mask": mask,
            "bbox": (px0, py0, px1, py1),
            "score": score,
            "area": float(mask.mean()),
            "aspect": aspect,
            "y": py0,
        })

    merged = merge_nearby_text_lines(proposals, w, h)
    merged.sort(key=lambda p: (p["score"], -p["area"]), reverse=True)

    kept: list[dict] = []
    for prop in merged:
        if any(overlap_ratio(prop["mask"], other["mask"]) > 0.45 for other in kept):
            continue
        prop = classify_and_adjust_text_region(prop, w, h)
        kept.append(prop)
        if len(kept) >= max_regions:
            break
    return kept


def classify_and_adjust_text_region(prop: dict, w: int, h: int) -> dict:
    x0, y0, x1, y1 = prop["bbox"]
    bw, bh = x1 - x0 + 1, y1 - y0 + 1
    near_horizontal_edge = x0 < w * 0.18 or x1 > w * 0.82
    near_vertical_edge = y0 < h * 0.20 or y1 > h * 0.82
    compact = prop["area"] < 0.040 and bw < w * 0.42 and bh < h * 0.17
    logo_like = near_horizontal_edge and near_vertical_edge and compact

    if logo_like:
        expanded = expand_logo_bbox(prop["bbox"], w, h)
        mask = np.zeros((h, w), dtype=bool)
        ex0, ey0, ex1, ey1 = expanded
        mask[ey0:ey1 + 1, ex0:ex1 + 1] = True
        return {
            **prop,
            "mask": mask,
            "bbox": expanded,
            "area": float(mask.mean()),
            "label": "品牌标识",
            "score": min(0.98, float(prop["score"]) + 0.03),
        }

    label = "标题文字" if prop["y"] < h * 0.34 or prop["area"] > 0.025 else "文字区域"
    return {**prop, "label": label}


def expand_logo_bbox(bbox: tuple[int, int, int, int], w: int, h: int) -> tuple[int, int, int, int]:
    x0, y0, x1, y1 = bbox
    bw, bh = x1 - x0 + 1, y1 - y0 + 1
    # Logos often combine a wordmark with a nearby icon. Use a conservative
    # rectangular target so editing/removal treats the mark as one object.
    pad_x = max(8, int(round(max(bh * 1.8, bw * 0.18))))
    pad_y = max(5, int(round(bh * 0.45)))
    return (
        max(0, x0 - pad_x),
        max(0, y0 - pad_y),
        min(w - 1, x1 + pad_x),
        min(h - 1, y1 + pad_y),
    )


def merge_nearby_text_lines(proposals: list[dict], w: int, h: int) -> list[dict]:
    if not proposals:
        return []
    props = sorted(proposals, key=lambda p: (p["bbox"][1], p["bbox"][0]))
    used = [False] * len(props)
    groups: list[list[dict]] = []
    for i, prop in enumerate(props):
        if used[i]:
            continue
        group = [prop]
        used[i] = True
        changed = True
        while changed:
            changed = False
            gx0, gy0, gx1, gy1 = union_bbox([g["bbox"] for g in group])
            gh = max(1, gy1 - gy0 + 1)
            for j, other in enumerate(props):
                if used[j]:
                    continue
                ox0, oy0, ox1, oy1 = other["bbox"]
                horizontal_overlap = max(0, min(gx1, ox1) - max(gx0, ox0) + 1) / max(1, min(gx1 - gx0 + 1, ox1 - ox0 + 1))
                vertical_gap = max(0, max(oy0 - gy1, gy0 - oy1))
                close_vertically = vertical_gap <= max(8, int(gh * 0.85))
                similar_width = min(gx1 - gx0 + 1, ox1 - ox0 + 1) / max(gx1 - gx0 + 1, ox1 - ox0 + 1) > 0.28
                if close_vertically and horizontal_overlap > 0.18 and similar_width:
                    group.append(other)
                    used[j] = True
                    changed = True
        groups.append(group)

    merged: list[dict] = []
    for group in groups:
        mask = np.zeros((h, w), dtype=bool)
        for item in group:
            mask |= item["mask"]
        bbox = bbox_of(mask)
        if not bbox:
            continue
        x0, y0, x1, y1 = bbox
        bw, bh = x1 - x0 + 1, y1 - y0 + 1
        if bw * bh / max(1, w * h) > 0.24:
            continue
        score = max(item["score"] for item in group) + min(0.08, 0.018 * (len(group) - 1))
        merged.append({
            "mask": mask,
            "bbox": bbox,
            "score": score,
            "area": float(mask.mean()),
            "aspect": bw / max(1, bh),
            "y": y0,
        })
    return merged


def shift(mask: np.ndarray, dy: int, dx: int) -> np.ndarray:
    out = np.zeros_like(mask)
    y_src = slice(max(0, -dy), mask.shape[0] - max(0, dy))
    x_src = slice(max(0, -dx), mask.shape[1] - max(0, dx))
    y_dst = slice(max(0, dy), mask.shape[0] - max(0, -dy))
    x_dst = slice(max(0, dx), mask.shape[1] - max(0, -dx))
    out[y_dst, x_dst] = mask[y_src, x_src]
    return out


def dilate_rect(mask: np.ndarray, rx: int, ry: int) -> np.ndarray:
    out = mask.copy()
    for dy in range(-ry, ry + 1):
        for dx in range(-rx, rx + 1):
            if dx or dy:
                out |= shift(mask, dy, dx)
    return out


def erode_rect(mask: np.ndarray, rx: int, ry: int) -> np.ndarray:
    out = mask.copy()
    for dy in range(-ry, ry + 1):
        for dx in range(-rx, rx + 1):
            if dx or dy:
                out &= shift(mask, dy, dx)
    return out


def close_rect(mask: np.ndarray, rx: int, ry: int) -> np.ndarray:
    return erode_rect(dilate_rect(mask, rx, ry), rx, ry)


def connected_components(mask: np.ndarray) -> list[np.ndarray]:
    h, w = mask.shape
    seen = np.zeros_like(mask)
    comps = []
    ys, xs = np.where(mask)
    for sy, sx in zip(ys.tolist(), xs.tolist()):
        if seen[sy, sx]:
            continue
        comp = np.zeros_like(mask)
        q: deque[tuple[int, int]] = deque([(sy, sx)])
        seen[sy, sx] = True
        comp[sy, sx] = True
        while q:
            cy, cx = q.popleft()
            for ny in (cy - 1, cy, cy + 1):
                for nx in (cx - 1, cx, cx + 1):
                    if ny == cy and nx == cx:
                        continue
                    if 0 <= ny < h and 0 <= nx < w and mask[ny, nx] and not seen[ny, nx]:
                        seen[ny, nx] = True
                        comp[ny, nx] = True
                        q.append((ny, nx))
        comps.append(comp)
    return comps


def bbox_of(mask: np.ndarray) -> tuple[int, int, int, int] | None:
    ys, xs = np.where(mask)
    if len(xs) == 0:
        return None
    return int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max())


def union_bbox(boxes: list[tuple[int, int, int, int]]) -> tuple[int, int, int, int]:
    return min(b[0] for b in boxes), min(b[1] for b in boxes), max(b[2] for b in boxes), max(b[3] for b in boxes)


def overlap_ratio(mask: np.ndarray, other: np.ndarray) -> float:
    inter = int(np.logical_and(mask, other).sum())
    if inter == 0:
        return 0.0
    return inter / max(1, min(int(mask.sum()), int(other.sum())))


if __name__ == "__main__":
    main()
