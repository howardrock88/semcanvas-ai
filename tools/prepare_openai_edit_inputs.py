#!/usr/bin/env python3
"""Prepare OpenAI Images API edit inputs.

The app stores selection masks as opaque black/white PNGs where white means
"edit this region". The OpenAI image edit endpoint expects an alpha mask, so
this script writes:

- a PNG copy of the original image
- an RGBA mask where selected pixels are transparent and unselected pixels are
  opaque
"""

import sys
from pathlib import Path

from PIL import Image


def main() -> int:
    if len(sys.argv) != 5:
        print(
            "Usage: prepare_openai_edit_inputs.py <original> <bw-mask> <out-image> <out-alpha-mask>",
            file=sys.stderr,
        )
        return 2

    original_path, mask_path, out_image_path, out_mask_path = map(Path, sys.argv[1:])

    with Image.open(original_path) as original:
        original_rgba = original.convert("RGBA")
        original_rgba.save(out_image_path, "PNG")

    with Image.open(mask_path) as mask:
        gray = mask.convert("L").resize(original_rgba.size)

    # OpenAI edits transparent mask areas. Our UI stores white as selected.
    alpha = gray.point(lambda p: 0 if p > 16 else 255)
    out_mask = Image.new("RGBA", original_rgba.size, (255, 255, 255, 255))
    out_mask.putalpha(alpha)
    out_mask.save(out_mask_path, "PNG")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
