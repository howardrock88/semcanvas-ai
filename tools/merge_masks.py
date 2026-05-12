#!/usr/bin/env python3
"""Merge one or more binary masks and return geometry metadata."""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("outdir")
    parser.add_argument("mask_file")
    parser.add_argument("preview_file")
    parser.add_argument("sources", nargs="+")
    args = parser.parse_args()

    outdir = Path(args.outdir)
    merged = None
    for source in args.sources:
        mask = np.asarray(Image.open(outdir / source).convert("L")) > 128
        merged = mask if merged is None else (merged | mask)

    if merged is None:
        raise SystemExit("No source masks provided")

    mask_img = Image.fromarray(merged.astype(np.uint8) * 255, mode="L")
    preview_img = mask_img.filter(ImageFilter.GaussianBlur(radius=max(1.0, min(mask_img.size) / 900)))
    mask_img.save(outdir / args.mask_file)
    preview_img.save(outdir / args.preview_file)

    height, width = merged.shape
    bbox = bbox_of(merged) or (0, 0, width - 1, height - 1)
    x0, y0, x1, y1 = bbox
    print(json.dumps({
        "areaRatio": round(float(merged.mean()), 4),
        "bbox": [
            round(x0 / width, 4),
            round(y0 / height, 4),
            round((x1 + 1) / width, 4),
            round((y1 + 1) / height, 4),
        ],
    }))


def bbox_of(mask: np.ndarray) -> tuple[int, int, int, int] | None:
    ys, xs = np.where(mask)
    if len(xs) == 0:
        return None
    return int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max())


if __name__ == "__main__":
    main()
