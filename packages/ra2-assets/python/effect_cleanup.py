#!/usr/bin/env python3
"""Clean redrawn effect pages (premultiplied sRGB RGBA atlases of effects-hd.json) in a copy-on-write cache farm.

Two image-model artefacts survive the matte of volumetric explosion redraws (volumetric_explosions.py):
- a light outline along the silhouette of the smoke: neutral (smoke-grey) pixels within a few texels of the transparent
  background, brighter than the smoke just inside them, read as a white cartoon outline in the scene. They are darkened
  to the interior level (flame colours and the interior are untouched);
- in the smoke phase (frames past ``late`` of an anim), small isolated dark fragments hang in the air as dots seconds
  after the blast. Components of at most ``max_area`` texels take the colour and coverage of what surrounds them.

Pages are rewritten whole and installed with cache_farm.install_file (a farm symlink is replaced, never written
through); effects-hd.json is unchanged because no rect moves.
"""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import tempfile

import cv2
import numpy as np
from PIL import Image

import cache_farm

LUMA = np.array([0.25, 0.5, 0.25], np.float32)


def _straight(rgba: np.ndarray):
    f = rgba.astype(np.float32) / 255
    a = f[..., 3]
    s = np.clip(f[..., :3] / np.maximum(a[..., None], 0.02), 0, 1)
    return f, a, s


def derim(rgba: np.ndarray, rim=3.0, fade=5.0) -> tuple[np.ndarray, int]:
    """Darken neutral silhouette rims to the smoke level just inside them. Returns the frame and changed pixels."""
    _, a, s = _straight(rgba)
    mx, mn = s.max(-1), s.min(-1)
    neutral = (mx - mn) / np.maximum(mx, 1e-3) < 0.22
    lum = s @ LUMA
    trans = (a < 0.06).astype(np.uint8)
    dist = cv2.distanceTransform(1 - trans, cv2.DIST_L2, 3)
    interior = ((dist > fade + 1) & (a > 0.5) & neutral).astype(np.float32)
    num = cv2.GaussianBlur(lum * interior, (0, 0), 6)
    den = cv2.GaussianBlur(interior, (0, 0), 6)
    fallback = float(np.median(lum[interior > 0])) if interior.any() else 0.3
    ref = np.where(den > 0.05, num / np.maximum(den, 1e-3), fallback)
    w = np.clip((fade - dist) / (fade - rim), 0, 1) * (a >= 0.06) * neutral
    target = ref + 0.03
    factor = np.where(lum > target, target / np.maximum(lum, 1e-3), 1.0)
    k = 1 - w + w * np.clip(factor, 0.45, 1)
    changed = int(((w > 0) & (factor < 0.97)).sum())
    out = np.concatenate([s * k[..., None] * a[..., None], a[..., None]], axis=-1)
    return (np.clip(out, 0, 1) * 255).round().astype(np.uint8), changed


def despeckle(rgba: np.ndarray, max_area=40) -> tuple[np.ndarray, int]:
    """Fill small isolated dark fragments from their surroundings (colour and coverage). Returns frame, filled pixels."""
    f, a, s = _straight(rgba)
    dark = (((s @ LUMA) < 0.16) & (a > 0.35)).astype(np.uint8)
    n, labels, stats, _ = cv2.connectedComponentsWithStats(dark, connectivity=8)
    small = np.isin(labels, [k for k in range(1, n) if stats[k, cv2.CC_STAT_AREA] <= max_area])
    if not small.any():
        return rgba, 0
    mask = cv2.dilate(small.astype(np.uint8), np.ones((3, 3), np.uint8)) > 0
    keep = (~mask).astype(np.float32)
    num = cv2.GaussianBlur(f * keep[..., None], (0, 0), 3)
    den = cv2.GaussianBlur(keep, (0, 0), 3)[..., None]
    out = np.where(mask[..., None], num / np.maximum(den, 1e-3), f)
    return (np.clip(out, 0, 1) * 255).round().astype(np.uint8), int(mask.sum())


def clean_page(page: np.ndarray, meta: dict, index: int, late=0.55) -> dict:
    """Clean every frame of every anim on page `index` in place; despeckle only frames past `late` of their anim."""
    counts = {"rim": 0, "speck": 0}
    for entry in meta["anims"].values():
        frames = entry["frames"]
        for i, fr in enumerate(frames):
            if fr is None or fr["page"] != index:
                continue
            x, y, w, h = fr["rect"]
            page[y : y + h, x : x + w], n = derim(page[y : y + h, x : x + w])
            counts["rim"] += n
            if i >= late * len(frames):
                page[y : y + h, x : x + w], n = despeckle(page[y : y + h, x : x + w])
                counts["speck"] += n
    return counts


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    p.add_argument("--farm", type=Path, required=True, help="cache root (a copy-on-write farm)")
    p.add_argument("--rel", default="_library/common/effects-hd", help="effects-hd directory inside the farm")
    p.add_argument("--late", type=float, default=0.55)
    p.add_argument("pages", nargs="+", help="page file names listed in effects-hd.json")
    a = p.parse_args(argv)
    directory = a.farm / a.rel
    meta = json.loads((directory / "effects-hd.json").read_text(encoding="utf-8"))
    for name in a.pages:
        index = next(i for i, page in enumerate(meta["pages"]) if page["file"] == name)
        with Image.open(directory / name) as im:
            page = np.array(im.convert("RGBA"))
        counts = clean_page(page, meta, index, a.late)
        fd, tmp = tempfile.mkstemp(suffix=".png", dir=directory)
        os.close(fd)
        try:
            Image.fromarray(page, "RGBA").save(tmp, compress_level=6)
            os.chmod(tmp, 0o644)
            cache_farm.install_file(a.farm, f"{a.rel}/{name}", Path(tmp))
        finally:
            Path(tmp).unlink(missing_ok=True)
        print(name, counts)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
