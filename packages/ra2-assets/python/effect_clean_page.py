#!/usr/bin/env python3
"""Clean HD flipbook of one native effect anim, without a redraw, appended to an effects-hd sidecar.

For art that has no redrawn flipbook yet (for example OREGATH, the sparks the engine draws under a harvesting
miner): every native frame is resampled from its own indexed pixels to SCALE texels per native pixel and stored in
the EffectHdLibrary format, so the renderer's HD effect path can draw it and an accepted redraw can later replace
the same entry. Nothing is invented: coverage is the bilinear magnification of the opaque mask sharpened with
smoothstep(0.35, 0.65), and colour is the coverage-weighted mean of the opaque texels in linear light, the same
filter the live indexed-card shader applies at run time (hd-renderer live/effectSprites.ts). Frame count, order and
the offset of every frame from the SHP canvas centre are the native ones; empty native frames stay null.

The page is written into a copy-on-write cache farm (cache_farm.py): the new PNG is installed as a file of the farm
and effects-hd.json is replaced under its lock, so the base cache a farm links to is never written. Running it again
for the same anim replaces that anim's page and entry in place.

Everything read or written is derived game art and must stay in gameres/ or another untracked directory.
Dependencies: numpy, Pillow and opencv-python. No game files or models are downloaded.

Example (all paths untracked):
  python3 effect_clean_page.py --effects gameres/hd-cache-x/_library/common/effects \\
      --farm gameres/hd-cache-x --anim OREGATH
"""

from __future__ import annotations

import argparse
from pathlib import Path
import tempfile

import cv2
import numpy as np

import cache_farm
import effect_flipbooks as fx

HD_DIR = "_library/common/effects-hd"


def clean_frame(idx: np.ndarray, palette: np.ndarray, scale: int = 2, pad: int = 2) -> dict | None:
    """One canvas-sized index image -> a premultiplied, sRGB-encoded HD crop with its canvas-centre offset."""
    opaque = idx > 0
    if not opaque.any():
        return None
    ch, cw = idx.shape
    # A transparent border keeps the magnified edge inside the image.
    border = 1
    alpha = np.pad(opaque.astype(np.float32), border)
    linear = np.pad(fx.s2l(palette[idx].astype(np.float32)) * opaque[..., None], ((border,) * 2, (border,) * 2, (0, 0)))
    size = ((cw + 2 * border) * scale, (ch + 2 * border) * scale)
    coverage = cv2.resize(alpha, size, interpolation=cv2.INTER_LINEAR)
    premultiplied = cv2.resize(linear.astype(np.float32), size, interpolation=cv2.INTER_LINEAR)
    colour = premultiplied / np.maximum(coverage, 1e-4)[..., None]
    mask = fx.smoothstep(0.35, 0.65, coverage)
    ys, xs = np.nonzero(mask > 1 / 255)
    if len(xs) == 0:
        return None
    h, w = mask.shape
    x0, y0 = max(0, int(xs.min()) - pad), max(0, int(ys.min()) - pad)
    x1, y1 = min(w, int(xs.max()) + 1 + pad), min(h, int(ys.max()) + 1 + pad)
    crop = mask[y0:y1, x0:x1]
    rgb = fx.l2s(colour[y0:y1, x0:x1] * crop[..., None])
    rgba = np.dstack([rgb, crop * 255]).round().clip(0, 255).astype(np.uint8)
    # Offset of the crop's top-left from the canvas centre in native pixels, like SpriteFrame.offset.
    offset = [(x0 / scale - border) - cw // 2, (y0 / scale - border) - ch // 2]
    return {"rgba": rgba, "offset": offset, "scale": scale}


def clean_frames(library: fx.EffectLibrary, anim: str, scale: int = 2) -> list[dict | None]:
    return [clean_frame(idx, library.palette, scale) for idx in library.frame_indices(anim)]


def install(farm: Path, anim: str, frames: list[dict | None], page_size: int = 4096) -> dict:
    """Append (or replace) the anim's pages and entry in the farm's effects-hd sidecar; returns the anim entry."""
    stem = f"effects-hd-clean-{anim.lower()}"
    with tempfile.TemporaryDirectory() as scratch:
        packed = fx.pack({anim: ("clean", frames)}, Path(scratch), page_size)
        files = []
        for k, page in enumerate(packed["pages"]):
            name = f"{stem}-{k}.png"
            cache_farm.install_file(farm, f"{HD_DIR}/{name}", Path(scratch) / page["file"])
            files.append({**page, "file": name})
        entry = packed["anims"][anim]

        def patch(data):
            if data.get("version") != 1:
                raise ValueError(f"unsupported effects-hd version {data.get('version')}")
            pages = data.setdefault("pages", [])
            index = {}
            for k, page in enumerate(files):
                known = next((i for i, p in enumerate(pages) if p["file"] == page["file"]), None)
                if known is None:
                    pages.append(page)
                    known = len(pages) - 1
                else:
                    pages[known] = page
                index[k] = known
            for frame in entry["frames"]:
                if frame is not None:
                    frame["page"] = index[frame["page"]]
            data.setdefault("anims", {})[anim] = entry

        cache_farm.patch_json(farm, f"{HD_DIR}/effects-hd.json", patch, default={"version": 1, "pages": [], "anims": {}})
    return entry


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--effects", type=Path, required=True, help="native effect sidecar directory (effects.json)")
    parser.add_argument("--farm", type=Path, required=True, help="cache farm root that receives the HD page")
    parser.add_argument("--anim", required=True, help="anim id in effects.json, e.g. OREGATH")
    parser.add_argument("--scale", type=int, default=2, choices=(2, 3, 4), help="HD texels per native pixel")
    args = parser.parse_args(argv)
    library = fx.EffectLibrary(args.effects)
    if args.anim not in library.data["anims"]:
        parser.error(f"{args.anim} is not in {args.effects / 'effects.json'}")
    frames = clean_frames(library, args.anim, args.scale)
    entry = install(args.farm, args.anim, frames)
    drawn = sum(frame is not None for frame in entry["frames"])
    print(f"{args.anim}: {drawn}/{len(entry['frames'])} frames at {args.scale}x -> {args.farm / HD_DIR}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
