#!/usr/bin/env python3
"""Rasterize levels, suppress false shores and paint wet cliff feet for lake-bed water.

The cache manifest supplies cell existence, uint8 levels, little-endian uint16
tile indices, ramp types, and terrainMap scale/origin in engine pixels. Cell
projection is ((x-y)*30, (x+y-level)*15) engine px, multiplied by composite scale
(an integer, or a fractional scale for a composite fitted under the texture limit).
Ramps rise at most one level at shared corners; cell tops are painted in x+y,
height, x, y order, with quarter-composite-pixel triangle coordinates. A plateau
>= nearest water level + 2 and uncovered walls inside the map enter shoreIgnore.

Water within 24 composite px below a wall triggers its wet foot and optional
flooded rubble strip (3 x 3 px dilation). Each level spans 15*scale composite px;
wall painting reaches 1.2 levels, with a noisy wet-band top at 0.7 levels and a
0.35-relative fade. Wet rock keeps 0.3 of linear light and 1.15 of chroma; algae
reach 0.12 levels. Foam is 1.5..3 px wide, spray reaches 0.2 levels, and the first
3 ground rows below the foot inherit its colour. Gamma 2.2, noise seed 11 and
all noise scales/amplitudes below are the visually tuned values. Alpha is kept.

Outputs feed materials.json terrainMap, shoreIgnore and (optionally) waterMask
with waterBed: true. The manifest and materials.json are never modified.
"""

from __future__ import annotations

import argparse
import base64
from dataclasses import dataclass
import json
from pathlib import Path
import sys

import cv2
import numpy as np
from PIL import Image

Image.MAX_IMAGE_PIXELS = None


@dataclass
class FootResult:
    terrain: np.ndarray
    ignore: np.ndarray
    water_mask: np.ndarray
    level: np.ndarray
    wall: np.ndarray
    foot: np.ndarray


def rasterize_levels(m: dict, shape: tuple[int, int]) -> np.ndarray:
    """Rasterize cell tops into composite pixels; -1 means no cell top covers the pixel."""
    GW, GH = m['grid']['width'], m['grid']['height']
    exists = np.frombuffer(base64.b64decode(m['cells']['exists']), np.uint8)[:GW * GH].reshape(GH, GW)
    height = np.frombuffer(base64.b64decode(m['cells']['height']), np.uint8)[:GW * GH].reshape(GH, GW).astype(int)
    tile = np.frombuffer(base64.b64decode(m['cells']['tile']), "<u2")[:GW * GH].reshape(GH, GW)
    tiles = m['tiles']
    tm = m['terrainMap']
    S, OX, OY = tm['scale'], tm['originX'], tm['originY']
    H, W = shape

    def ok(x, y):
        return 0 <= x < GW and 0 <= y < GH and exists[y, x] and tile[y, x] != 0xFFFF

    def corner(x, y, cx, cy):
        h = height[y, x]
        t = tiles[tile[y, x]]
        if t['rampType'] == 0:
            return h
        hi = h
        for nx, ny in ((cx - 1, cy - 1), (cx, cy - 1), (cx - 1, cy), (cx, cy)):
            if ok(nx, ny):
                hi = max(hi, min(h + 1, height[ny, nx]))
        return hi

    def px(x, y, lvl):
        sx, sy = (x - y) * 30, (x + y) * 15 - lvl * 15
        return [(sx - OX) * S, (sy - OY) * S]

    level = np.full((H, W), -1, np.int16)
    cells = [(x + y, height[y, x], x, y) for y in range(GH) for x in range(GW) if ok(x, y)]
    cells.sort()
    for _, h, x, y in cells:
        c00, c10, c01, c11 = corner(x, y, x, y), corner(x, y, x + 1, y), corner(x, y, x, y + 1), corner(x, y, x + 1, y + 1)
        lv = int(round((c00 + c10 + c01 + c11) / 4))
        a, b, d, e = px(x, y, c00), px(x + 1, y, c10), px(x, y + 1, c01), px(x + 1, y + 1, c11)
        for tri in ((a, d, b), (b, d, e)):
            cv2.fillConvexPoly(level, np.round(np.array(tri) * 4).astype(np.int32), int(lv), lineType=cv2.LINE_8, shift=2)

    return level


def prepare(manifest: dict, terr: np.ndarray, mask_u8: np.ndarray, flood_mask: bool = False) -> FootResult:
    """Paint the terrain and masks from the manifest without changing the caller's arrays."""
    H, W = terr.shape[:2]
    if mask_u8.shape != (H, W):
        raise ValueError("terrain and water mask must have the same dimensions")
    S = manifest["terrainMap"]["scale"]
    level = rasterize_levels(manifest, (H, W))
    mask = mask_u8.astype(np.float32) / 255
    covered = level >= 0
    water = mask >= 0.5
    # The map is terraced (lakes on several levels): compare land with the level of its nearest water.
    _, lab = cv2.distanceTransformWithLabels((~(water & covered)).astype(np.uint8), cv2.DIST_L2, 5,
                                             labelType=cv2.DIST_LABEL_PIXEL)
    ys, xs = np.nonzero(water & covered)
    lut = np.zeros(lab.max() + 1, np.int16)
    # labels are assigned in scan order of the zero pixels
    lut[1:len(ys) + 1] = level[ys, xs]
    near_wl = lut[lab]
    print('water levels', np.unique(level[water & covered]))
    # Walls: uncovered pixels with covered ground both somewhere above and below in the same column (inside the map).
    cov_above = np.maximum.accumulate(covered, axis=0)
    cov_below = np.maximum.accumulate(covered[::-1], axis=0)[::-1]
    wall = ~covered & cov_above & cov_below
    high = covered & (level >= near_wl + 2)
    ignore = (wall | high) & ~water
    print('ignore px', int(ignore.sum()), 'wall px', int(wall.sum()))

    # ---------------------------------------------------------------------------------------------- wet cliff foot
    # A foot is a wall pixel directly above covered ground, with painted water within 24 composite px below it.
    below_low = np.zeros_like(wall)
    below_low[:-1] = covered[1:]
    wet_below = np.zeros_like(wall)
    for k in range(1, 25):  # painted water within ~0.3 cells below the foot (the renderer's cliffWater floods that)
        wet_below[:-k] |= (mask[k:] >= 0.5)
    foot = wall & below_low & wet_below
    fy, fx = np.nonzero(foot)
    print('foot px', len(fy))
    # Distance above the foot along the column (wall pixels only), in composite px.
    dist = np.full((H, W), 1e9, np.float32)
    LVL = 15 * S  # composite px per level
    BAND = int(1.2 * LVL)
    # Sub-pixel waterline: the foot pixels form a 2:1 staircase; the local mean of their y over +-3 columns is the straight
    # geometric edge, so distances (and the foam drawn from them) are antialiased instead of following the stairs.
    F = foot.astype(np.float32)
    Y = np.arange(H, dtype=np.float32)[:, None] * F
    box = (7, 5)
    ymean = cv2.boxFilter(Y, -1, box, normalize=False) / np.maximum(cv2.boxFilter(F, -1, box, normalize=False), 1e-6)
    fline = ymean[fy, fx] + 0.5  # edge position (px, bottom of the foot pixel row) in this column
    for k in range(BAND + 1):
        yy = fy - k
        okk = yy >= 0
        yy, xx, fl = yy[okk], fx[okk], fline[okk]
        sel = wall[yy, xx]
        yy, xx, fl = yy[sel], xx[sel], fl[sel]
        dist[yy, xx] = np.minimum(dist[yy, xx], np.maximum(fl - (yy + 0.5), 0))

    # Flood the thin strip of low land between a wall foot and the painted water (rubble the original paints at cliff feet):
    # as land it shows as saw teeth under the waterline; as water it is deep (cliffWater / shoreIgnore) and the wall stands
    # cleanly in the lake.
    m8 = mask_u8.copy()
    if flood_mask:
        reach = np.zeros(len(fy), bool)
        for k in range(1, 25):
            yy = fy + k
            okk = yy < H
            reach[okk] |= mask[yy[okk], fx[okk]] >= 0.5
        flood = np.zeros((H, W), bool)
        for k in range(1, 25):
            yy = np.minimum(fy + k, H - 1)
            still = reach & (mask[yy, fx] < 0.5)
            flood[yy[still], fx[still]] = True
            reach &= mask[yy, fx] < 0.5
        flood = cv2.dilate(flood.astype(np.uint8), np.ones((3, 3), np.uint8)).astype(bool) & ~wall
        m8[flood] = 255
        print('flooded foot strip px', int(flood.sum()))

    rng = np.random.default_rng(11)

    def noise(sigma, amp=1.0):
        n = cv2.GaussianBlur(rng.standard_normal((H, W)).astype(np.float32), (0, 0), sigma)
        return n / (n.std() + 1e-6) * amp

    # The top averages 0.7 level; the upper 35% fades to dry rock, with 0.12/0.04-level noise amplitudes.
    top = 0.7 * LVL + noise(7, 0.12 * LVL) + noise(2.5, 0.04 * LVL)
    t = np.clip((top - dist) / (0.35 * top), 0, 1)
    wet = (t * t * (3 - 2 * t)) * (dist < 1e8)
    rgb = terr[..., :3].astype(np.float32) / 255
    # The original cliff art often ends a little above the geometric wall foot, leaving lake-bed paint on the lowest part of
    # the 3D wall: continue the rock downwards there (copy from the nearest rock pixel above in the same column).
    bedpaint = (mask >= 0.35) & wall & (dist < 1e8)
    need = bedpaint.copy()
    src = wall & (mask < 0.35)
    for k in range(1, 70):
        if not need.any():
            break
        cand = np.zeros_like(need)
        cand[k:] = need[k:] & src[:-k]
        yy, xx = np.nonzero(cand)
        # Mirror the rock about the art's lower edge (y0 + i <- y0 - 1 - i) so no single row is smeared into streaks.
        ym = yy - 2 * k + 1
        good = (ym >= 0) & src[np.maximum(ym, 0), xx]
        rgb[yy, xx] = np.where(good[:, None], rgb[np.maximum(ym, 0), xx], rgb[yy - k, xx])
        need[yy, xx] = False
    print('bed-paint px on walls refilled', int(bedpaint.sum() - need.sum()), 'left', int(need.sum()))
    lin = rgb ** 2.2
    luma = (lin @ np.array([0.2126, 0.7152, 0.0722], np.float32))[..., None]
    wetc = luma + (lin - luma) * 1.15
    wetc = wetc * 0.3
    out = lin * (1 - wet[..., None]) + wetc * wet[..., None]
    # Darker, slightly greenish algae/silt line just above the waterline (0..0.12 level).
    algae = np.clip(1 - dist / (0.12 * LVL), 0, 1) * (dist < 1e8) * np.clip(0.6 + noise(3, 0.3), 0, 1)
    out = out * (1 - 0.35 * algae[..., None]) + np.array([0.035, 0.04, 0.03], np.float32) * 0.35 * algae[..., None]
    # Broken splash / foam line hugging the waterline (0..~2.5 px), broken by noise.
    fw = 1.5 + 1.5 * np.clip(noise(10, 0.5) + 0.5, 0, 1)  # foam width 1.5-3 px
    patches = np.clip(noise(14, 1.0) * 0.8 + 0.55, 0, 1)  # larger calm gaps along the wall
    fo = patches * np.clip(0.6 + noise(4, 0.2), 0.3, 0.8)
    foam = np.clip((fw - dist) / 1.0, 0, 1) * (dist < 1e8) * fo
    # sparse spray droplets up to ~0.2 level above the waterline
    spray = (noise(0.9, 1.0) > 2.6) & (dist < 0.2 * LVL) & (dist > 2)
    spray = cv2.GaussianBlur(spray.astype(np.float32), (0, 0), 0.7) * 1.4 * patches
    foam = np.maximum(foam, spray * 0.6)
    # Soften the 2:1 pixel stairs of the diagonal wall foot (magnified 2-3x on screen they read as a zipper).
    foam = np.clip(cv2.GaussianBlur(foam, (0, 0), 0.5) * 1.05, 0, 0.85) * (dist < 1e8)
    foamc = np.array([0.8, 0.86, 0.86], np.float32)
    out = out * (1 - foam[..., None]) + foamc * foam[..., None]
    res = terr.copy()
    res[..., :3] = np.round(np.clip(out, 0, 1) ** (1 / 2.2) * 255).astype(np.uint8)
    # The straight 3D wall edge also samples the first ground texels under the pixel stairs of its foot: give them the foot's
    # own (foam / wet) colour so no saw teeth of rubble art show along the waterline.
    for k in (1, 2, 3):
        yy = np.minimum(fy + k, H - 1)
        okk = ~wall[yy, fx]
        res[yy[okk], fx[okk], :3] = res[fy[okk], fx[okk], :3]
    return FootResult(res, (ignore * 255).astype(np.uint8), m8, level, wall, foot)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--cache", required=True, type=Path, help="map cache containing manifest.json")
    parser.add_argument("--terrain", required=True, type=Path, help="RGBA terrain containing the lake bed")
    parser.add_argument("--water-mask", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path, help="terrain with wet rock and foam")
    parser.add_argument("--output-ignore", required=True, type=Path, help="grayscale shore-ignore mask")
    parser.add_argument("--output-mask", type=Path, help="optional water mask with flooded foot strips")
    parser.add_argument("--debug-prefix", type=Path, help="write <prefix>_levels.png and <prefix>_ignore.png at 1/4 size")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        manifest = json.loads((args.cache / "manifest.json").read_text(encoding="utf-8"))
        with Image.open(args.terrain) as image:
            terrain = np.array(image.convert("RGBA"))
        with Image.open(args.water_mask) as image:
            mask = np.array(image.convert("L"))
        result = prepare(manifest, terrain, mask, args.output_mask is not None)
        for path, pixels in ((args.output, result.terrain), (args.output_ignore, result.ignore)):
            path.parent.mkdir(parents=True, exist_ok=True)
            Image.fromarray(pixels).save(path)
        if args.output_mask is not None:
            args.output_mask.parent.mkdir(parents=True, exist_ok=True)
            Image.fromarray(result.water_mask).save(args.output_mask)
        if args.debug_prefix is not None:
            H, W = mask.shape
            level, wall, foot = result.level, result.wall, result.foot
            covered, water = level >= 0, mask >= 128
            vis = np.zeros((H, W, 3), np.uint8)
            vis[covered] = np.stack([level[covered] * 30 % 256, 80 + level[covered] * 20,
                                     60 * np.ones(covered.sum())], -1).astype(np.uint8)
            vis[wall] = (255, 0, 255)
            vis[water] = vis[water] // 2 + np.array([0, 0, 120], np.uint8)
            vis[foot] = (255, 255, 0)
            size = (max(1, W // 4), max(1, H // 4))
            args.debug_prefix.parent.mkdir(parents=True, exist_ok=True)
            Image.fromarray(cv2.resize(vis, size, interpolation=cv2.INTER_NEAREST)).save(
                str(args.debug_prefix) + "_levels.png")
            Image.fromarray(cv2.resize(result.ignore, size)).save(str(args.debug_prefix) + "_ignore.png")
        print("wrote", args.output, args.output_ignore)
    except (OSError, ValueError, KeyError, cv2.error) as error:
        print(f"cliff_foot: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
