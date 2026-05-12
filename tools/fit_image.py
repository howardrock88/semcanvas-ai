#!/usr/bin/env python3
"""Resize an image to exact pixel dimensions without distortion.

Mode cover uses center-crop after proportional scaling, similar to object-fit: cover.
This is used to keep generated/edited outputs at predictable dimensions.
"""
from __future__ import annotations

import argparse
from pathlib import Path
from PIL import Image, ImageOps


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("source")
    parser.add_argument("dest")
    parser.add_argument("width", type=int)
    parser.add_argument("height", type=int)
    parser.add_argument("--mode", choices=["cover", "contain"], default="cover")
    args = parser.parse_args()

    source = Path(args.source)
    dest = Path(args.dest)
    dest.parent.mkdir(parents=True, exist_ok=True)

    with Image.open(source) as image:
        image = image.convert("RGBA") if image.mode in {"RGBA", "LA"} else image.convert("RGB")
        if args.mode == "cover":
            fitted = ImageOps.fit(image, (args.width, args.height), method=Image.Resampling.LANCZOS, centering=(0.5, 0.5))
        else:
            fitted = ImageOps.contain(image, (args.width, args.height), method=Image.Resampling.LANCZOS)
            canvas = Image.new(image.mode, (args.width, args.height), (0, 0, 0, 0) if image.mode == "RGBA" else (0, 0, 0))
            x = (args.width - fitted.width) // 2
            y = (args.height - fitted.height) // 2
            canvas.paste(fitted, (x, y))
            fitted = canvas
        fitted.save(dest)


if __name__ == "__main__":
    main()
