#!/usr/bin/env python3
"""Build a numbered mask contact sheet for LLM review."""
from __future__ import annotations

import argparse
import json
import math
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("image")
    parser.add_argument("segments_json")
    parser.add_argument("outdir")
    parser.add_argument("output")
    parser.add_argument("--max-segments", type=int, default=18)
    args = parser.parse_args()

    source = Image.open(args.image).convert("RGBA")
    payload = json.loads(Path(args.segments_json).read_text(encoding="utf-8"))
    outdir = Path(args.outdir)
    segments = payload.get("segments", [])[: args.max_segments]

    panel_w = 360
    panel_h = 270
    label_h = 42
    cols = 3 if len(segments) > 8 else 2
    rows = max(1, math.ceil(len(segments) / cols))
    sheet = Image.new("RGBA", (cols * panel_w, rows * (panel_h + label_h)), (12, 12, 14, 255))

    for index, segment in enumerate(segments):
        panel = render_panel(source, outdir / segment["maskFile"], segment, panel_w, panel_h, label_h)
        sheet.paste(panel, ((index % cols) * panel_w, (index // cols) * (panel_h + label_h)))

    sheet.convert("RGB").save(args.output, quality=92)


def render_panel(source: Image.Image, mask_path: Path, segment: dict, width: int, height: int, label_h: int) -> Image.Image:
    mask = Image.open(mask_path).convert("L")
    overlay = Image.new("RGBA", source.size, (255, 178, 54, 0))
    overlay.putalpha(mask.point(lambda value: 132 if value > 128 else 0))
    composite = Image.alpha_composite(source, overlay)
    composite.thumbnail((width, height), Image.Resampling.LANCZOS)

    panel = Image.new("RGBA", (width, height + label_h), (17, 17, 20, 255))
    panel.paste(composite, ((width - composite.width) // 2, 0))
    draw = ImageDraw.Draw(panel)
    title = f"{segment.get('id')}  {segment.get('label')}  area {segment.get('areaRatio')}"
    draw.rectangle((0, height, width, height + label_h), fill=(17, 17, 20, 255))
    draw.text((10, height + 9), title, fill=(246, 244, 236, 255), font=ImageFont.load_default())
    return panel


if __name__ == "__main__":
    main()
