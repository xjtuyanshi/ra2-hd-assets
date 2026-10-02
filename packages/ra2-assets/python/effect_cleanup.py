#!/usr/bin/env python3
"""Clean redrawn effect pages (premultiplied sRGB RGBA atlases of effects-hd.json) in a copy-on-write cache farm.

Image-model artefacts survive the matte of volumetric explosion redraws (volumetric_explosions.py):
- a light outline along the silhouette of the smoke: neutral (smoke-grey) pixels within a few texels of the transparent
  background, brighter than the smoke just inside them, read as a white cartoon outline in the scene. They are darkened
  to the interior level (flame colours and the interior are untouched);
- in the smoke phase (frames past ``late`` of an anim), small isolated dark fragments hang in the air as dots seconds
  after the blast. Components of at most ``max_area`` texels take the colour and coverage of what surrounds them.
- the optional interior-only pass fills small dark chunks enclosed by bright warm fire in every frame, preserving
  debris over transparency or neutral smoke and leaving previously cleaned rims and late debris alone.

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


def _fill_fragments(f: np.ndarray, small: np.ndarray) -> tuple[np.ndarray, int]:
    """Fill a one-texel dilation of the fragments with normalized Gaussian colour and coverage."""
    mask = cv2.dilate(small.astype(np.uint8), np.ones((3, 3), np.uint8)) > 0
    keep = (~mask).astype(np.float32)
    num = cv2.GaussianBlur(f * keep[..., None], (0, 0), 3)
    den = cv2.GaussianBlur(keep, (0, 0), 3)[..., None]
    out = np.where(mask[..., None], num / np.maximum(den, 1e-3), f)
    return (np.clip(out, 0, 1) * 255).round().astype(np.uint8), int(mask.sum())


def despeckle(rgba: np.ndarray, max_area=40) -> tuple[np.ndarray, int]:
    """Fill small isolated dark fragments from their surroundings (colour and coverage). Returns frame, filled pixels."""
    f, a, s = _straight(rgba)
    dark = (((s @ LUMA) < 0.16) & (a > 0.35)).astype(np.uint8)
    n, labels, stats, _ = cv2.connectedComponentsWithStats(dark, connectivity=8)
    small = np.isin(labels, [k for k in range(1, n) if stats[k, cv2.CC_STAT_AREA] <= max_area])
    if not small.any():
        return rgba, 0
    return _fill_fragments(f, small)


def interior_despeckle(rgba: np.ndarray, max_area=160, ring=3, fire_share=0.6,
                      ring_luma=0.25) -> tuple[np.ndarray, int]:
    """Fill small dark chunks enclosed by warm fire. Returns the frame and filled pixels.

    The thresholds were checked on EXPLOLRG frame 10 (L5F reheat): a ring luma of 0.42 kept most chunks sitting in the
    orange-red flame between the bright tongues (413 texels filled), 0.25 clears the fire body (2570) while chunks in
    the brown smoke cap and the spray around the fireball stay.
    """
    f, a, s = _straight(rgba)
    lum = s @ LUMA
    dark = ((lum < 0.22) & (a > 0.35)).astype(np.uint8)
    _, labels, stats, _ = cv2.connectedComponentsWithStats(dark, connectivity=8)
    candidates = np.flatnonzero(stats[1:, cv2.CC_STAT_AREA] <= max_area) + 1
    if not candidates.size:
        return rgba, 0
    mx, mn = s.max(-1), s.min(-1)
    warm = (s[..., 0] >= s[..., 1]) & (s[..., 1] >= s[..., 2]) & ((mx - mn) / np.maximum(mx, 1e-3) >= 0.25)
    fire = (a > 0.6) & (lum >= ring_luma) & warm
    small = np.zeros(dark.shape, np.uint8)
    inner_kernel = np.ones((3, 3), np.uint8)
    outer_kernel = np.ones((2 * ring + 1, 2 * ring + 1), np.uint8)
    height, width = dark.shape
    for k in candidates:
        x, y, w, h = stats[k, :4]
        # Only inspect the component's local ring; no frame-sized work per component.
        ys = slice(max(0, y - ring), min(height, y + h + ring))
        xs = slice(max(0, x - ring), min(width, x + w + ring))
        component = (labels[ys, xs] == k).astype(np.uint8)
        inner = cv2.dilate(component, inner_kernel)
        surrounding = (cv2.dilate(component, outer_kernel) > 0) & (inner == 0)
        area = int(surrounding.sum())
        if area and np.count_nonzero(fire[ys, xs] & surrounding) >= fire_share * area:
            small[ys, xs] |= component
    if not small.any():
        return rgba, 0
    return _fill_fragments(f, small)


def clean_page(page: np.ndarray, meta: dict, index: int, late=0.55, *,
               interior=False, anims: set[str] | None = None) -> dict:
    """Clean selected anims in place: either interior-only on all frames, or rims and late debris."""
    counts = {"interior": 0} if interior else {"rim": 0, "speck": 0}
    for name, entry in meta["anims"].items():
        if anims is not None and name not in anims:
            continue
        frames = entry["frames"]
        for i, fr in enumerate(frames):
            if fr is None or fr["page"] != index:
                continue
            x, y, w, h = fr["rect"]
            if interior:
                page[y : y + h, x : x + w], n = interior_despeckle(page[y : y + h, x : x + w])
                counts["interior"] += n
                continue
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
    p.add_argument("--interior", action="store_true", help="only fill dark chunks enclosed by fire, on every frame")
    p.add_argument("--anims", help="comma-separated anim names to clean (default: all anims on the page)")
    p.add_argument("pages", nargs="+", help="page file names listed in effects-hd.json")
    a = p.parse_args(argv)
    directory = a.farm / a.rel
    meta = json.loads((directory / "effects-hd.json").read_text(encoding="utf-8"))
    anims = None if a.anims is None else {name.strip() for name in a.anims.split(",")}
    if anims is not None:
        if "" in anims:
            p.error("--anims requires non-empty anim names")
        unknown = anims - meta["anims"].keys()
        if unknown:
            p.error(f"unknown anim names: {', '.join(sorted(unknown))}")
    for name in a.pages:
        index = next(i for i, page in enumerate(meta["pages"]) if page["file"] == name)
        with Image.open(directory / name) as im:
            page = np.array(im.convert("RGBA"))
        counts = clean_page(page, meta, index, a.late, interior=a.interior, anims=anims)
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
