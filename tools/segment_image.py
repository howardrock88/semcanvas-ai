#!/usr/bin/env python3
"""Generate rough clickable masks without heavyweight ML dependencies.

This is a deterministic fallback backend for the local demo. It is not SAM/SAM2,
but it exposes the same kind of output the frontend needs: aligned masks,
bounding boxes, and confidence scores. A SAM2 backend can replace this script
behind /api/segment later.
"""
from __future__ import annotations

import argparse
import json
import math
from collections import deque
from pathlib import Path
from typing import Iterable

import numpy as np
from PIL import Image, ImageFilter


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("image")
    parser.add_argument("outdir")
    parser.add_argument("--max-dim", type=int, default=448)
    args = parser.parse_args()

    source = Path(args.image)
    outdir = Path(args.outdir)
    outdir.mkdir(parents=True, exist_ok=True)

    original = Image.open(source).convert("RGB")
    ow, oh = original.size
    scale = min(args.max_dim / max(ow, oh), 1.0)
    sw, sh = max(1, int(round(ow * scale))), max(1, int(round(oh * scale)))
    small = original.resize((sw, sh), Image.Resampling.LANCZOS)
    rgb = np.asarray(small).astype(np.float32) / 255.0
    h, w = rgb.shape[:2]
    yy, xx = np.mgrid[0:h, 0:w]
    x = xx / max(w - 1, 1)
    y = yy / max(h - 1, 1)

    foreground = estimate_foreground(rgb, x, y)
    candidates: list[dict] = []

    add_candidate(candidates, foreground, "主体", 0.96)
    add_candidate(candidates, ~foreground, "背景", 0.88)

    # Coarse semantic regions from the largest subject bbox. These are useful
    # when color components are too fragmented: face/head/body/center object.
    bbox = bbox_of(foreground)
    if bbox:
        x0, y0, x1, y1 = bbox
        bw, bh = max(1, x1 - x0 + 1), max(1, y1 - y0 + 1)
        head = largest_component(foreground & (yy >= y0) & (yy <= y0 + int(bh * 0.42)))
        body = largest_component(foreground & (yy >= y0 + int(bh * 0.28)))
        add_candidate(candidates, head, "头部/上半身", 0.72)
        add_candidate(candidates, body, "身体/下半身", 0.70)

    add_clear_regions(candidates, rgb, x, y, limit=4)

    candidates = dedupe_and_rank(
        candidates,
        w,
        h,
        keep_subset_labels={"头部/上半身", "身体/下半身", "清晰物体", "清晰区域", "横向区域", "纵向区域"},
    )[:8]
    result = []
    label_counts: dict[str, int] = {}
    for idx, cand in enumerate(candidates, start=1):
        mask_small = cand["mask"]
        mask_img = Image.fromarray((mask_small.astype(np.uint8) * 255), mode="L")
        mask_img = mask_img.resize((ow, oh), Image.Resampling.NEAREST)
        # Slight blur gives the frontend a less jagged preview, while the mask
        # remains effectively binary after thresholding on canvas.
        preview_img = mask_img.filter(ImageFilter.GaussianBlur(radius=max(1.0, min(ow, oh) / 900)))
        mask_name = f"mask-{idx:02d}.png"
        preview_name = f"mask-{idx:02d}-preview.png"
        mask_img.save(outdir / mask_name)
        preview_img.save(outdir / preview_name)
        x0, y0, x1, y1 = bbox_of(mask_small) or (0, 0, w - 1, h - 1)
        label = cand["label"]
        label_counts[label] = label_counts.get(label, 0) + 1
        display_label = label if label_counts[label] == 1 else f"{label} {label_counts[label]}"
        result.append({
            "id": f"seg-{idx:02d}",
            "label": display_label,
            "score": round(float(cand["score"]), 3),
            "areaRatio": round(float(mask_small.mean()), 4),
            "bbox": [
                round(x0 / w, 4),
                round(y0 / h, 4),
                round((x1 + 1) / w, 4),
                round((y1 + 1) / h, 4),
            ],
            "maskFile": mask_name,
            "previewFile": preview_name,
        })

    print(json.dumps({
        "backend": "fallback-numpy",
        "width": ow,
        "height": oh,
        "segments": result,
    }, ensure_ascii=False))


def estimate_foreground(rgb: np.ndarray, x: np.ndarray, y: np.ndarray) -> np.ndarray:
    h, w = rgb.shape[:2]
    border = max(4, int(round(min(h, w) * 0.08)))
    border_mask = np.zeros((h, w), dtype=bool)
    border_mask[:border, :] = True
    border_mask[-border:, :] = True
    border_mask[:, :border] = True
    border_mask[:, -border:] = True
    samples = rgb[border_mask]
    mean = samples.mean(axis=0)
    std = samples.std(axis=0) + 0.055
    dist = np.sqrt((((rgb - mean) / std) ** 2).sum(axis=2))
    dist = normalize(dist)
    center = np.exp(-(((x - 0.5) / 0.42) ** 2 + ((y - 0.5) / 0.48) ** 2))
    center = normalize(center)
    score = 0.76 * dist + 0.24 * center
    threshold = otsu_threshold(score)
    threshold = min(max(threshold, 0.40), 0.62)
    mask = score >= threshold
    mask = close(mask, iterations=2)
    mask = open_mask(mask, iterations=1)
    comps = connected_components(mask)
    if not comps:
        return mask
    ranked = sorted(comps, key=lambda c: component_score(c, h, w), reverse=True)
    keep = np.zeros_like(mask)
    for comp in ranked[:3]:
        if comp.sum() >= max(80, int(h * w * 0.01)):
            keep |= comp
    keep = fill_small_holes(keep)
    return keep


def kmeans_masks(rgb: np.ndarray, x: np.ndarray, y: np.ndarray, k: int) -> Iterable[np.ndarray]:
    h, w = rgb.shape[:2]
    features = np.dstack([rgb * 1.35, x[..., None] * 0.18, y[..., None] * 0.18]).reshape(-1, 5)
    if features.shape[0] > 12000:
        step = max(1, features.shape[0] // 12000)
        train = features[::step]
    else:
        train = features
    # Deterministic percentile initialization across brightness.
    brightness = train[:, :3].mean(axis=1)
    qs = np.linspace(4, 96, k)
    centers = np.array([train[np.argmin(np.abs(brightness - np.percentile(brightness, q)))] for q in qs], dtype=np.float32)
    for _ in range(10):
        dist = ((train[:, None, :] - centers[None, :, :]) ** 2).sum(axis=2)
        labels = dist.argmin(axis=1)
        for i in range(k):
            pts = train[labels == i]
            if len(pts):
                centers[i] = pts.mean(axis=0)
    full_dist = ((features[:, None, :] - centers[None, :, :]) ** 2).sum(axis=2)
    labels = full_dist.argmin(axis=1).reshape(h, w)
    for i in range(k):
        yield close(labels == i, iterations=1)


def normalize(values: np.ndarray) -> np.ndarray:
    lo = np.percentile(values, 2)
    hi = np.percentile(values, 98)
    return np.clip((values - lo) / max(float(hi - lo), 1e-6), 0, 1)


def otsu_threshold(values: np.ndarray) -> float:
    hist, bin_edges = np.histogram(values.ravel(), bins=96, range=(0, 1))
    hist = hist.astype(np.float64)
    prob = hist / max(hist.sum(), 1)
    omega = np.cumsum(prob)
    centers = (bin_edges[:-1] + bin_edges[1:]) / 2
    mu = np.cumsum(prob * centers)
    mu_t = mu[-1]
    sigma = (mu_t * omega - mu) ** 2 / np.maximum(omega * (1 - omega), 1e-9)
    return float(centers[int(np.nanargmax(sigma))])


def shift(mask: np.ndarray, dy: int, dx: int) -> np.ndarray:
    out = np.zeros_like(mask)
    y_src = slice(max(0, -dy), mask.shape[0] - max(0, dy))
    x_src = slice(max(0, -dx), mask.shape[1] - max(0, dx))
    y_dst = slice(max(0, dy), mask.shape[0] - max(0, -dy))
    x_dst = slice(max(0, dx), mask.shape[1] - max(0, -dx))
    out[y_dst, x_dst] = mask[y_src, x_src]
    return out


def dilate(mask: np.ndarray) -> np.ndarray:
    out = mask.copy()
    for dy in (-1, 0, 1):
        for dx in (-1, 0, 1):
            if dy or dx:
                out |= shift(mask, dy, dx)
    return out


def erode(mask: np.ndarray) -> np.ndarray:
    out = mask.copy()
    for dy in (-1, 0, 1):
        for dx in (-1, 0, 1):
            if dy or dx:
                out &= shift(mask, dy, dx)
    return out


def close(mask: np.ndarray, iterations: int = 1) -> np.ndarray:
    out = mask
    for _ in range(iterations):
        out = dilate(out)
    for _ in range(iterations):
        out = erode(out)
    return out


def open_mask(mask: np.ndarray, iterations: int = 1) -> np.ndarray:
    out = mask
    for _ in range(iterations):
        out = erode(out)
    for _ in range(iterations):
        out = dilate(out)
    return out


def fill_small_holes(mask: np.ndarray) -> np.ndarray:
    inv = ~mask
    h, w = mask.shape
    border = np.zeros_like(mask)
    border[0, :] = inv[0, :]
    border[-1, :] = inv[-1, :]
    border[:, 0] = inv[:, 0]
    border[:, -1] = inv[:, -1]
    outside = flood_from_seed(inv, border)
    holes = inv & ~outside
    return mask | holes


def flood_from_seed(valid: np.ndarray, seed: np.ndarray) -> np.ndarray:
    h, w = valid.shape
    seen = np.zeros_like(valid)
    q: deque[tuple[int, int]] = deque()
    ys, xs = np.where(seed & valid)
    for yy, xx in zip(ys.tolist(), xs.tolist()):
        seen[yy, xx] = True
        q.append((yy, xx))
    while q:
        cy, cx = q.popleft()
        for ny, nx in ((cy - 1, cx), (cy + 1, cx), (cy, cx - 1), (cy, cx + 1)):
            if 0 <= ny < h and 0 <= nx < w and valid[ny, nx] and not seen[ny, nx]:
                seen[ny, nx] = True
                q.append((ny, nx))
    return seen


def connected_components(mask: np.ndarray) -> list[np.ndarray]:
    h, w = mask.shape
    seen = np.zeros_like(mask)
    comps = []
    ys, xs = np.where(mask)
    for sy, sx in zip(ys.tolist(), xs.tolist()):
        if seen[sy, sx]:
            continue
        comp = np.zeros_like(mask)
        q = deque([(sy, sx)])
        seen[sy, sx] = True
        comp[sy, sx] = True
        while q:
            cy, cx = q.popleft()
            for ny, nx in ((cy - 1, cx), (cy + 1, cx), (cy, cx - 1), (cy, cx + 1)):
                if 0 <= ny < h and 0 <= nx < w and mask[ny, nx] and not seen[ny, nx]:
                    seen[ny, nx] = True
                    comp[ny, nx] = True
                    q.append((ny, nx))
        comps.append(comp)
    return comps


def component_score(comp: np.ndarray, h: int, w: int) -> float:
    area = comp.mean()
    ys, xs = np.where(comp)
    if len(xs) == 0:
        return 0
    cx = xs.mean() / max(w - 1, 1)
    cy = ys.mean() / max(h - 1, 1)
    centrality = 1.0 - min(1.0, math.sqrt((cx - 0.5) ** 2 + (cy - 0.5) ** 2) / 0.7)
    return float(area * 2.2 + centrality * 0.55)


def add_components(candidates: list[dict], mask: np.ndarray, label: str, score: float, min_area: int, limit: int) -> None:
    comps = [c for c in connected_components(close(mask, iterations=1)) if c.sum() >= min_area]
    comps.sort(key=lambda c: component_score(c, *mask.shape), reverse=True)
    for comp in comps[:limit]:
        add_candidate(candidates, comp, label, score)


def add_large_components(candidates: list[dict], mask: np.ndarray, label: str, score: float, subject_mask: np.ndarray, limit: int) -> None:
    subject_area = max(int(subject_mask.sum()), 1)
    min_area = max(120, int(subject_area * 0.09))
    max_area = int(subject_area * 0.72)
    comps = []
    for comp in connected_components(close(mask, iterations=2)):
        area = int(comp.sum())
        if area < min_area or area > max_area:
            continue
        bbox = bbox_of(comp)
        if not bbox:
            continue
        x0, y0, x1, y1 = bbox
        box_area = max(1, (x1 - x0 + 1) * (y1 - y0 + 1))
        fill_ratio = area / box_area
        # Discard thin speckles and lace-like texture fragments. We prefer a
        # smaller set of coherent object parts over many noisy regions.
        if fill_ratio < 0.28:
            continue
        comps.append(comp)
    comps.sort(key=lambda c: c.sum(), reverse=True)
    for comp in comps[:limit]:
        add_candidate(candidates, comp, label, score)


def add_clear_regions(candidates: list[dict], rgb: np.ndarray, x: np.ndarray, y: np.ndarray, limit: int) -> None:
    h, w = rgb.shape[:2]
    image_area = h * w
    proposals: list[dict] = []

    # Color/position clusters are a cheap fallback for objects with clear
    # boundaries: cats, walls, tables, sky bands, etc. Filtering is intentionally
    # strict so we get a few large regions, not texture fragments.
    for cluster_mask in kmeans_masks(rgb, x, y, k=9):
        for comp in connected_components(close(cluster_mask, iterations=1)):
            area = int(comp.sum())
            area_ratio = area / image_area
            if area_ratio < 0.025 or area_ratio > 0.58:
                continue

            bbox = bbox_of(comp)
            if not bbox:
                continue
            x0, y0, x1, y1 = bbox
            bw, bh = x1 - x0 + 1, y1 - y0 + 1
            box_area = max(1, bw * bh)
            fill_ratio = area / box_area
            if fill_ratio < 0.32:
                continue

            # Reject almost full-frame regions; those are usually background.
            if bw / w > 0.94 and bh / h > 0.82:
                continue

            contrast = boundary_contrast(rgb, comp)
            # Large, compact regions such as walls may have moderate contrast;
            # small regions need stronger contrast to avoid noise.
            min_contrast = 0.055 if area_ratio >= 0.08 and fill_ratio >= 0.45 else 0.085
            if contrast < min_contrast:
                continue

            aspect = bw / max(bh, 1)
            if aspect > 2.35 and area_ratio >= 0.045:
                label = "横向区域"
            elif aspect < 0.43 and area_ratio >= 0.045:
                label = "纵向区域"
            elif area_ratio >= 0.06:
                label = "清晰区域"
            else:
                label = "清晰物体"

            proposals.append({
                "mask": fill_small_holes(comp),
                "label": label,
                "score": 0.58 + min(0.18, contrast * 1.4) + min(0.08, area_ratio),
                "contrast": contrast,
                "area": area_ratio,
            })

    proposals.sort(key=lambda p: (p["score"], p["area"]), reverse=True)
    kept: list[dict] = []
    for prop in proposals:
        duplicate = False
        for other in kept:
            inter = np.logical_and(prop["mask"], other["mask"]).sum()
            union = np.logical_or(prop["mask"], other["mask"]).sum()
            if inter / max(union, 1) > 0.55:
                duplicate = True
                break
        if not duplicate:
            kept.append(prop)
        if len(kept) >= limit:
            break

    for prop in kept:
        add_candidate(candidates, prop["mask"], prop["label"], prop["score"])


def boundary_contrast(rgb: np.ndarray, mask: np.ndarray) -> float:
    ring = mask.copy()
    for _ in range(3):
        ring = dilate(ring)
    ring = ring & ~mask
    if mask.sum() == 0 or ring.sum() < 8:
        return 0.0
    inside = rgb[mask].mean(axis=0)
    outside = rgb[ring].mean(axis=0)
    return float(np.sqrt(((inside - outside) ** 2).sum()))


def largest_component(mask: np.ndarray) -> np.ndarray:
    comps = connected_components(mask)
    if not comps:
        return mask
    return max(comps, key=lambda c: c.sum())


def add_candidate(candidates: list[dict], mask: np.ndarray, label: str, score: float) -> None:
    if mask.sum() < max(24, int(mask.size * 0.002)):
        return
    candidates.append({"mask": mask.astype(bool), "label": label, "score": score})


def dedupe_and_rank(candidates: list[dict], w: int, h: int, keep_subset_labels: set[str] | None = None) -> list[dict]:
    keep_subset_labels = keep_subset_labels or set()
    kept: list[dict] = []
    for cand in sorted(candidates, key=lambda c: c["score"] + min(0.2, float(c["mask"].mean())), reverse=True):
        area = float(cand["mask"].mean())
        if area < 0.004 or area > 0.92:
            continue
        duplicate = False
        for other in kept:
            inter = np.logical_and(cand["mask"], other["mask"]).sum()
            union = np.logical_or(cand["mask"], other["mask"]).sum()
            iou = inter / max(union, 1)
            containment = inter / max(cand["mask"].sum(), 1)
            size_ratio = min(cand["mask"].sum(), other["mask"].sum()) / max(cand["mask"].sum(), other["mask"].sum(), 1)
            allow_semantic_subset = cand["label"] in keep_subset_labels and other["label"] in {"主体", "背景"}
            if iou > 0.78 or ((containment > 0.92 and size_ratio > 0.70) and not allow_semantic_subset):
                duplicate = True
                break
        if not duplicate:
            kept.append(cand)
    return kept


def bbox_of(mask: np.ndarray):
    ys, xs = np.where(mask)
    if len(xs) == 0:
        return None
    return int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max())


if __name__ == "__main__":
    main()
