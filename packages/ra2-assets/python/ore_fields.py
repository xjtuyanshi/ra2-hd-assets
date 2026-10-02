#!/usr/bin/env python3
"""Extract, compose, install and compare the L5 ore/gem field redraw without calling an image model.

This ports the scratch pipeline's numerical method. Dependencies: NumPy, Pillow and OpenCV; install uses POSIX
flock. All locations are explicit arguments, with no environment inputs. Game art and all derived images stay
outside Git. The original 60x60 SHP canvas centre is the cell's top corner. Every growth frame is a 68x46 (1x)
decal at offset (-34,-12) from that corner, with a 1 texel gutter on each side in the atlas.

Stages (run this file with the named subcommand; each also accepts --help):
* extract --sheet IMAGE --kind gold|gem --out LIB.npz [--rows 6 --cols 8 --min-area 300]
  cuts isolated objects from a grey-118 model sheet, unmattes edges and estimates height/metal/colour class.
  Writes numeric arrays in a compressed NPZ (read with allow_pickle=False) and a companion LIB.json index.
* build --library-root LIBRARY_ROOT --theatre THEATRE --gold LIB --gem LIB --soil IMAGE --out BUILD
  reads LIBRARY_ROOT/_library/THEATRE/library.json, indexed sprite pages and the theater palette. LIB is NPZ +
  its JSON index, or an existing trusted scratch .pkl (pickle is loaded only for that exact suffix).
  Packs the original full-stage gold silhouette into medial balls and gems into colour-class components.
  Each stage reuses those objects, scaled by the surviving share of its Voronoi cell. Soil, contact shadows,
  objects and materials are composed at 4x and area-reduced to 2x. Writes sprites-ore-l5.png (1x indexed mask),
  sprites-ore-l5@2x.png (straight RGBA), sprites-ore-l5@2x-remap.png (zeros), sprites-ore-l5@2x-normals.png
  (material RGBA), and frames.json (rectangles, offset, size, dimensions, soilIndex).
  Colour defaults are the approved L5 set (v8): soil-target=.46 .325 .19, gold-scale=1.16, gold-gain=.95,
  gold-knee=.84, gold-gamma=1.2, clarity=.2, gem-scale=1.25, gem-gamma=.78; soil-contrast=.7, gold-sat=.85.
  Bed defaults are L5F (--bed contact, BED_L5F: alpha .25 halo only under each nugget/gem plus its contact shadow;
  gem-sat .72, gem-pastel .1); --bed carpet --gem-sat 1 --gem-pastel 0 reproduces v8 exactly. The installed L5F
  page used --gold-scale 1.35 --gold-gain 1.0 --gem-sat .64 --gem-pastel .16 --gem-scale 1.4 --gem-bed-alpha .25
  --gem-bed-shadow .6 (gold coverage at or above the original's; gem saturation near the target's ~.45).
  Every parameter has its own CLI flag (the first scratch build, v5, used soil .37 .262 .16, gold scale 1.08, gain .9,
  knee .8, gold gamma 1.45, clarity .55 and the fixed gem scale 1.45).
  All 20 TIB and 12 GEM families / 12 stages are built by default; --families selects a subset.
  The scratch mask thresholds faint tails; --strict-mask-coverage extends it under every nonzero delivered
  HD alpha texel. This explicit opt-in changes only the indexed PNG, so default builds remain exact reproductions of the approved scratch build.
* install --build-dir BUILD --cache-root CACHE --theatre THEATRE
  copies this page and patches only its entries and ore/gem frames 0..11 in CACHE/_library/THEATRE.
  TIB2_nn and TIB3_nn reuse TIBnn art. The existing page index is reused on repeated installs. Copies and JSON
  updates run under .compose.lock and replace destination entries atomically, including symlinks, preserving
  all other sprites, atlas pages and normals pages from the current cache.
* sheet --build-dir BUILD --library-root LIBRARY_ROOT --theatre THEATRE --cache-root CACHE --map MAP
        --font FONT --out SHEETS
  compares original | map-cache L4 | L5 at the same cell anchor. Writes stages_TIB01_GEM01.png,
  variants_stage11.png, variants_stage5.png and smaller _s.jpg copies with Chinese labels.

Material encoding: R/G store world normal x/z mapped from [-1,1] to [0,1]. B below 0.5 is dielectric gloss 2B;
B above 0.5 is metal gloss 2(B-0.5). A stores AO (0 = no data). Renderer/visual acceptance is separate from these
numerical and synthetic tests; no game resources or external model are needed by the tests.
"""

from __future__ import annotations

import argparse
import fcntl
import hashlib
import json
import math
import os
from pathlib import Path
import pickle
import sys
import tempfile
import time

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont

import cache_farm

BG = 118.0
S = 4  # Internal supersampling relative to the 1x original.
OUT = 2  # HD atlas scale.
CANVAS = 60
PAD = 4
N1 = CANVAS + 2 * PAD
EXT_OFF = (-34, -12)  # Headroom above the cell's top corner keeps tall nuggets from being cut flat.
EXT_W, EXT_H = 68, 46
SOIL_TARGET = np.array([0.46, 0.325, 0.19], np.float32)
# L5F contact bed (art review 2026-10-01): the L5 soil carpet (alpha ~0.95 over the whole cell diamond) read as a brown
# patch with saw-tooth cell edges and hid the grass; the original reads gold on green. The bed is now a faint halo
# (alpha <= 0.25) directly under each nugget or gem, plus the contact shadow, so terrain shows between objects.
BED_L5F = {'alpha': 0.25, 'gem_alpha': 0.22, 'spread': 0.42, 'margin': 1.0, 'gain': 1.7, 'floor': 0.2,
           'shadow': 0.55, 'gem_shadow': 0.45}
GEM_SAT_L5F, GEM_PASTEL_L5F = 0.72, 0.1
ORE = tuple(f'TIB{i:02d}' for i in range(1, 21))
GEMS = tuple(f'GEM{i:02d}' for i in range(1, 13))
FAMILIES = ORE + GEMS
ALIASES = {f'TIB{group}_{i:02d}': f'TIB{i:02d}' for group in (2, 3) for i in range(1, 21)}
FRAMES = 12
PAGE_W = 2048
CELL_W, CELL_H = EXT_W + 2, EXT_H + 2  # One texel gutter on each side.
PAGE = 'sprites-ore-l5.png'
HD = 'sprites-ore-l5@2x.png'
REMAP = 'sprites-ore-l5@2x-remap.png'
MAT = 'sprites-ore-l5@2x-normals.png'
PAGE_FILES = (PAGE, HD, REMAP, MAT)
ARRAY_FIELDS = ('rgba', 'height', 'metal')

# Camera basis: world x right-down, z left-down, y up; see sprite_normals.py.
SCREEN_RIGHT = np.array([math.sqrt(0.5), 0.0, -math.sqrt(0.5)], np.float32)
SCREEN_DOWN_GROUND = np.array([math.sqrt(0.5), 0.0, math.sqrt(0.5)], np.float32)
UP = np.array([0.0, 1.0, 0.0], np.float32)


def read_json(path: Path) -> dict:
    with path.open() as stream:
        return json.load(stream)


def read_image(path: Path, mode: str | None = None) -> np.ndarray:
    with Image.open(path) as image:
        return np.array(image.convert(mode) if mode else image)


def write_atomic(path: Path, data: bytes) -> None:
    """Replace a destination entry itself, never write through a cache symlink."""
    with tempfile.NamedTemporaryFile(dir=path.parent, suffix='.tmp-ore', delete=False) as stream:
        tmp = Path(stream.name)
        try:
            stream.write(data)
        except BaseException:
            tmp.unlink()
            raise
    try:
        os.replace(tmp, path)
    finally:
        tmp.unlink(missing_ok=True)


def validate_sprites(sprites: list[dict]) -> None:
    if not sprites:
        raise ValueError('sprite library is empty')
    for sprite in sprites:
        rgba = sprite['rgba']
        if rgba.ndim != 3 or rgba.shape[-1] != 4 or not (rgba[..., 3] > 0.3).any():
            raise ValueError('sprite rgba must be HxWx4 with visible foreground')
        for key in ARRAY_FIELDS:
            array = sprite[key]
            if not np.issubdtype(array.dtype, np.floating) or not np.isfinite(array).all():
                raise ValueError(f'sprite {key} must contain finite floating-point numbers')
            if key != 'rgba' and array.shape != rgba.shape[:2]:
                raise ValueError(f'sprite {key} dimensions differ from rgba')


def save_sprite_library(sprites: list[dict], path: Path) -> None:
    """Store variable-sized arrays losslessly without object arrays or executable pickle payloads."""
    if path.suffix != '.npz':
        raise ValueError('extract output must end in .npz (with a companion .json index)')
    validate_sprites(sprites)
    arrays, records = {}, []
    for i, sprite in enumerate(sprites):
        record = {key: value for key, value in sprite.items() if key not in ARRAY_FIELDS}
        record['arrays'] = {}
        for key in ARRAY_FIELDS:
            name = f's{i}_{key}'
            arrays[name] = sprite[key]
            record['arrays'][key] = name
        records.append(record)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open('wb') as stream:
        np.savez_compressed(stream, allow_pickle=False, **arrays)
    write_atomic(path.with_suffix('.json'), json.dumps({'version': 1, 'sprites': records}, indent=2).encode())


def load_sprite_library(path: Path) -> list[dict]:
    path = Path(path)
    if path.suffix == '.pkl':
        # Compatibility with operator-supplied scratch libraries only; new extraction always writes safe NPZ.
        with path.open('rb') as stream:
            sprites = pickle.load(stream)
    elif path.suffix == '.npz':
        index = read_json(path.with_suffix('.json'))
        if index['version'] != 1:
            raise ValueError('unsupported sprite library index version')
        sprites = []
        with np.load(path, allow_pickle=False) as archive:
            for record in index['sprites']:
                sprite = {key: value for key, value in record.items() if key != 'arrays'}
                sprite.update({key: archive[record['arrays'][key]].copy() for key in ARRAY_FIELDS})
                sprites.append(sprite)
    else:
        raise ValueError('sprite library must end in .npz or .pkl')
    validate_sprites(sprites)
    return sprites


# ----------------------------------------------------------------------------- model-sheet extraction

def cut(sheet_path, rows, cols, min_area=300):
    im = read_image(Path(sheet_path), 'RGB').astype(np.float32)
    H, W = im.shape[:2]
    d = np.abs(im - BG).max(-1)
    # grey background texture of the model is slightly noisy: blur before threshold
    db = cv2.GaussianBlur(d, (0, 0), 1.2)
    fg = (db > 16).astype(np.uint8)
    fg = cv2.morphologyEx(fg, cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8))
    n, lab, stats, cent = cv2.connectedComponentsWithStats(fg)
    out = []
    for i in range(1, n):
        x, y, w, h, area = stats[i]
        if area < min_area:
            continue
        m = (lab == i).astype(np.uint8)
        # fill holes (clear gems show the grey through): flood the outside
        pad = cv2.copyMakeBorder(m, 1, 1, 1, 1, cv2.BORDER_CONSTANT, value=0)
        flood = pad.copy()
        mask = np.zeros((pad.shape[0] + 2, pad.shape[1] + 2), np.uint8)
        cv2.floodFill(flood, mask, (0, 0), 2)
        filled = (flood[1:-1, 1:-1] != 2).astype(np.uint8)
        M = 3
        x0, y0, x1, y1 = max(x - M, 0), max(y - M, 0), min(x + w + M, W), min(y + h + M, H)
        fm = filled[y0:y1, x0:x1].astype(np.float32)
        rgb = im[y0:y1, x0:x1]
        dd = d[y0:y1, x0:x1]
        # soft alpha: eroded core is opaque, the rim fades with the colour distance from grey
        core = cv2.erode(fm, np.ones((3, 3), np.uint8))
        rim = np.clip((dd - 6) / 22, 0, 1)
        a = np.maximum(core, fm * rim)
        a = cv2.GaussianBlur(a, (0, 0), 0.6) * fm
        a = np.clip(a, 0, 1)
        # decontaminate edge colours from the grey background
        aa = np.maximum(a, 1e-3)[..., None]
        col = np.clip((rgb - (1 - aa) * BG) / aa, 0, 255)
        col = np.where(a[..., None] > 0.97, rgb, col)
        cx, cy = cent[i]
        r = int(cy / (H / rows))
        c = int(cx / (W / cols))
        out.append(dict(rgba=np.dstack([col / 255.0, a]).astype(np.float32), row=r, col=c, area=int(area)))
    out.sort(key=lambda s: (s['row'], s['col']))
    return out


def height_and_classes(s, kind):
    rgba = s['rgba']
    a = rgba[..., 3]
    rgb = rgba[..., :3]
    m = (a > 0.5).astype(np.uint8)
    dt = cv2.distanceTransform(m, cv2.DIST_L2, 5).astype(np.float32)
    dmax = max(dt.max(), 1.0)
    dome = 1 - (1 - np.clip(dt / dmax, 0, 1)) ** 2
    L = rgb @ np.array([0.2126, 0.7152, 0.0722], np.float32)
    detail = L - cv2.GaussianBlur(L, (0, 0), max(1.5, dmax * 0.15))
    h = dome * 0.85 + detail * 0.6
    h = cv2.GaussianBlur(h, (0, 0), 0.7) * (a > 0.05)
    mx = rgb.max(-1)
    mn = rgb.min(-1)
    sat = (mx - mn) / np.maximum(mx, 1e-3)
    if kind == 'gold':
        # saturated yellow/orange = gold metal; grey-brown low saturation = host rock / quartz
        hue_ok = (rgb[..., 0] >= rgb[..., 2])
        metal = np.clip((sat - 0.25) / 0.25, 0, 1) * hue_ok
    else:
        metal = np.zeros_like(a)
    return h.astype(np.float32), metal.astype(np.float32)


def gem_class(s):
    rgba = s['rgba']
    a = rgba[..., 3] > 0.6
    c = rgba[..., :3][a].mean(0)
    if max(c) - min(c) < 0.12:
        return 'white'
    return ['red', 'green', 'blue'][int(np.argmax(c))]

def extract(sheet_path: Path, kind: str, out: Path, rows: int = 6, cols: int = 8, min_area: int = 300) -> None:
    if kind not in ('gold', 'gem') or min(rows, cols, min_area) <= 0:
        raise ValueError('extract needs gold/gem and positive rows, cols and min-area')
    sprites = cut(sheet_path, rows, cols, min_area)
    for sprite in sprites:
        sprite['height'], sprite['metal'] = height_and_classes(sprite, kind)
        sprite['cls'] = gem_class(sprite) if kind == 'gem' else 'gold'
    save_sprite_library(sprites, out)
    print(kind, len(sprites), 'sprites:', out)


# ----------------------------------------------------------------------------- original indexed theatre library

class OverlayLibrary:
    """Cache original pages/palettes for this explicit root and theatre, without process-global cache state."""

    def __init__(self, root: Path, theatre: str):
        self.directory = Path(root) / '_library' / theatre
        self.library = read_json(self.directory / 'library.json')
        self.pages = {}
        self.palettes = {}

    def page_img(self, page: int) -> np.ndarray:
        if page not in self.pages:
            self.pages[page] = read_image(self.directory / self.library['spriteAtlases'][page]['file'])
        return self.pages[page]

    def palette(self, name: str = 'theater') -> np.ndarray:
        if name not in self.palettes:
            self.palettes[name] = read_image(self.directory / self.library['palettes'][name], 'RGB')[0]
        return self.palettes[name]

    def frame_info(self, otype: str, frame: int) -> tuple[dict, dict, dict]:
        overlay = self.library['overlays'][otype]
        sprite = self.library['sprites'][overlay['sprite']]
        return sprite['frames'][frame], sprite, overlay

    def frame_indexed(self, otype: str, frame: int) -> tuple[np.ndarray, dict]:
        info, _, _ = self.frame_info(otype, frame)
        x, y, w, h = info['rect']
        page = self.page_img(info.get('page', 0))
        array = page[y:y + h, x:x + w]
        if array.ndim == 3:
            array = array[..., 0]
        return array, info

    def frame_rgba(self, otype: str, frame: int, canvas: bool = True) -> np.ndarray:
        array, info = self.frame_indexed(otype, frame)
        rgba = np.dstack([self.palette()[array], (array > 0).astype(np.uint8) * 255]).astype(np.uint8)
        if not canvas:
            return rgba
        _, sprite, _ = self.frame_info(otype, frame)
        cw, ch = sprite['canvas']
        out = np.zeros((ch, cw, 4), np.uint8)
        ox, oy = info['offset'][0] + cw // 2, info['offset'][1] + ch // 2
        h, w = array.shape
        out[oy:oy + h, ox:ox + w] = rgba
        return out

    def frame_mask(self, otype: str, frame: int) -> tuple[np.ndarray, np.ndarray]:
        rgba = self.frame_rgba(otype, frame)
        return rgba[..., 3] > 0, rgba[..., :3].astype(np.float32) / 255


# ----------------------------------------------------------------------------- layout and sprite packing

def h32(*parts) -> int:
    return int(hashlib.md5('|'.join(map(str, parts)).encode()).hexdigest()[:8], 16)


def grade_gold(rgb):
    """Pull orange-gold toward the original ore's brighter lemon gold (hue +4.5 degrees, value +8 %)."""
    hsv = cv2.cvtColor(np.clip(rgb, 0, 1).astype(np.float32), cv2.COLOR_RGB2HSV)
    sat = hsv[..., 1]
    golden = np.clip((sat - 0.2) / 0.3, 0, 1)
    hsv[..., 0] = hsv[..., 0] + 4.5 * golden
    hsv[..., 2] = np.clip(hsv[..., 2] * (1 + 0.08 * golden), 0, 1)
    return cv2.cvtColor(hsv, cv2.COLOR_HSV2RGB)


class Library:
    def __init__(self, gold_file: Path, gem_file: Path, soil_png: Path):
        self.gold = load_sprite_library(Path(gold_file))
        for spr in self.gold:
            spr['rgba'] = spr['rgba'].copy()
            spr['rgba'][..., :3] = grade_gold(spr['rgba'][..., :3])
        self.gem = load_sprite_library(Path(gem_file))
        soil = read_image(Path(soil_png), 'RGB').astype(np.float32) / 255
        self.soil = soil

    def gold_for(self, radius_1x, key):
        # size class: big blobs -> large clusters (rows 0-1), medium (rows 1-3), small (rows 3-5)
        # simple nuggets read best at game scale; the big multi-crystal clusters (row 0) only for the largest lumps
        if radius_1x >= 3.4:
            rows = (1, 2)
        elif radius_1x >= 2.2:
            rows = (2, 3, 4)
        else:
            rows = (4, 5)
        cands = [s for s in self.gold if s['row'] in rows]
        if not cands:
            raise ValueError(f'gold library has no sprites in rows {rows}')
        return cands[h32('gold', key) % len(cands)]

    def gem_for(self, cls, radius_1x, key):
        cands = [s for s in self.gem if s['cls'] == cls and (s['row'] < 4 if radius_1x >= 2.0 else True)]
        if not cands:
            cands = [s for s in self.gem if s['cls'] == cls]
        if not cands:
            raise ValueError(f'gem library has no {cls} sprites')
        return cands[h32('gem', key) % len(cands)]


def gem_classes(rgb, mask):
    """Per-pixel gem colour class of the original art: 0 none, 1 red, 2 green, 3 blue, 4 white."""
    mx = rgb.max(-1)
    mn = rgb.min(-1)
    sat = (mx - mn) / np.maximum(mx, 1e-3)
    am = rgb.argmax(-1)
    cls = np.where(sat < 0.22, 4, am + 1)
    return np.where(mask, cls, 0)


def pack_gold(mask1, key):
    """Greedy medial balls in the 4x silhouette: list of (x4, y4, r4)."""
    m = cv2.resize(mask1.astype(np.float32), None, fx=S, fy=S, interpolation=cv2.INTER_LINEAR)
    m = (cv2.GaussianBlur(m, (0, 0), 1.2) > 0.5).astype(np.uint8)
    full_area = m.sum()
    remaining = m.copy()
    balls = []
    rmin = 1.15 * S
    rmax = 3.6 * S
    for _ in range(64):
        dt = cv2.distanceTransform(remaining, cv2.DIST_L2, 5)
        y, x = np.unravel_index(np.argmax(dt), dt.shape)
        r = float(dt[y, x])
        if r < rmin:
            # small leftovers become grains if they are big enough
            break
        r = min(r, rmax)
        balls.append((float(x), float(y), r))
        cv2.circle(remaining, (int(x), int(y)), int(round(r * 0.92)), 0, -1)
        if remaining.sum() < 0.05 * full_area:
            break
    # leftover crumbs as tiny grains
    n, lab, st, cen = cv2.connectedComponentsWithStats(remaining)
    for i in range(1, n):
        if st[i, 4] >= 0.8 * S * S:
            balls.append((float(cen[i][0]), float(cen[i][1]), max(0.8 * S, math.sqrt(st[i, 4] / math.pi))))
    return balls, m


def pack_gems(mask1, rgb1):
    cls = gem_classes(rgb1, mask1)
    objs = []
    for c, name in ((1, 'red'), (2, 'green'), (3, 'blue'), (4, 'white')):
        m = (cls == c).astype(np.uint8)
        n, lab, st, cen = cv2.connectedComponentsWithStats(m, connectivity=8)
        for i in range(1, n):
            area = st[i, 4]
            if area < 2:
                continue
            w, h = st[i, 2], st[i, 3]
            r = max(1.0, 0.5 * max(w, h * 1.4)) * S * 0.62 + 0.25 * S
            objs.append((float(cen[i][0] + 0.5) * S, float(cen[i][1] + 0.5) * S, r, name))
    return objs, cls


def voronoi_share(objs, mask_full1, mask_k1):
    """Share of each object's Voronoi cell (within the full-stage silhouette) still covered at stage k, and the
    centroid of that covered part (4x coordinates)."""
    ys, xs = np.nonzero(mask_full1)
    if not len(objs):
        return [], []
    P = np.array([[o['x'] / S - 0.5, o['y'] / S - 0.5] for o in objs], np.float32)
    pts = np.stack([xs, ys], 1).astype(np.float32)
    d = ((pts[:, None, :] - P[None, :, :]) ** 2).sum(-1)
    owner = d.argmin(1)
    shares, cents = [], []
    for i in range(len(objs)):
        sel = owner == i
        tot = sel.sum()
        keep = sel & mask_k1[ys, xs]
        k = keep.sum()
        shares.append(k / tot if tot else 0.0)
        if k:
            cents.append(((xs[keep].mean() + 0.5) * S, (ys[keep].mean() + 0.5) * S))
        else:
            cents.append((objs[i]['x'], objs[i]['y']))
    return shares, cents


def scaled_sprite(sprite, width4):
    """Resize a library sprite (premultiplied area filter) to `width4` pixels wide; returns rgba, height, metal."""
    rgba = sprite['rgba']
    h0, w0 = rgba.shape[:2]
    ys, xs = np.nonzero(rgba[..., 3] > 0.3)
    bw = xs.max() - xs.min() + 1
    f = width4 / bw
    nw, nh = max(2, int(round(w0 * f))), max(2, int(round(h0 * f)))
    pm = rgba.copy()
    pm[..., :3] *= pm[..., 3:4]
    interp = cv2.INTER_AREA if f < 1 else cv2.INTER_LINEAR
    pm = cv2.resize(pm, (nw, nh), interpolation=interp)
    a = np.clip(pm[..., 3], 0, 1)
    rgb = pm[..., :3] / np.maximum(a[..., None], 1e-4)
    hgt = cv2.resize(sprite['height'], (nw, nh), interpolation=interp)
    met = cv2.resize(sprite['metal'], (nw, nh), interpolation=interp)
    return np.dstack([np.clip(rgb, 0, 1), a]), hgt, met


def paste(dst_prem, dst_a, src_rgba, x, y):
    """Over-composite src (straight alpha) onto premultiplied dst at integer top-left (x, y); returns the slices."""
    H, W = dst_a.shape
    h, w = src_rgba.shape[:2]
    x0, y0 = max(x, 0), max(y, 0)
    x1, y1 = min(x + w, W), min(y + h, H)
    if x1 <= x0 or y1 <= y0:
        return None
    s = src_rgba[y0 - y:y1 - y, x0 - x:x1 - x]
    a = s[..., 3:4]
    dst_prem[y0:y1, x0:x1] = s[..., :3] * a + dst_prem[y0:y1, x0:x1] * (1 - a)
    dst_a[y0:y1, x0:x1] = a[..., 0] + dst_a[y0:y1, x0:x1] * (1 - a[..., 0])
    return (slice(y0, y1), slice(x0, x1), slice(y0 - y, y1 - y), slice(x0 - x, x1 - x))


def value_noise(shape, scale, seed):
    rng = np.random.default_rng(seed)
    h, w = shape
    gh, gw = int(h / scale) + 3, int(w / scale) + 3
    g = rng.random((gh, gw)).astype(np.float32)
    return cv2.resize(g, (int(gw * scale), int(gh * scale)), interpolation=cv2.INTER_CUBIC)[:h, :w]


class Composer:
    def __init__(self, lib: Library, overlays: OverlayLibrary):
        self.lib = lib
        self.overlays = overlays
        self.layouts = {}

    def layout(self, otype):
        if otype in self.layouts:
            return self.layouts[otype]
        m11, rgb11 = self.overlays.frame_mask(otype, 11)
        if otype.startswith('GEM'):
            objs, _ = pack_gems(m11, rgb11)
            items = []
            for i, (x, y, r, cls) in enumerate(objs):
                spr = self.lib.gem_for(cls, r / S, (otype, i))
                items.append(dict(x=x, y=y, r=r, sprite=spr, kind='gem', cls=cls))
        else:
            balls, _ = pack_gold(m11, otype)
            items = []
            for i, (x, y, r) in enumerate(balls):
                spr = self.lib.gold_for(r / S, (otype, i))
                items.append(dict(x=x, y=y, r=r, sprite=spr, kind='gold'))
        self.layouts[otype] = (items, m11)
        return self.layouts[otype]

def gold_curve(luminance: np.ndarray, gain: float = 0.9, knee: float = 0.8) -> np.ndarray:
    """Monotonic gain and soft highlight roll-off; glints supply sparkle without white baked highlights."""
    value = luminance * gain
    if knee < 1:
        value = np.where(value > knee, knee + (1 - knee) * np.tanh((value - knee) / (1 - knee)), value)
    return value


def padded_diamond():
    n = N1 * S
    yy, xx = np.mgrid[0:n, 0:n].astype(np.float32)
    dx = (xx + 0.5) / S - PAD - CANVAS / 2
    dy = (yy + 0.5) / S - PAD - CANVAS / 2
    return np.abs(dx) / 30 + np.abs(dy - 15) / 15


DIAMOND = padded_diamond()


class ExtComposer(Composer):
    def __init__(self, lib, overlays, soil_target=SOIL_TARGET, soil_contrast=0.7, gold_sat=0.85,
                 gold_gamma=1.2, gold_scale=1.16, clarity=0.2, gold_gain=0.95, gold_knee=0.84,
                 gem_scale=1.25, gem_gamma=0.78, bed=None, gem_sat=1.0, gem_pastel=0.0):
        super().__init__(lib, overlays)
        # bed=None keeps the L5 (v8) soil carpet; a dict selects the contact bed (see BED_L5F).
        self.bed = dict(bed) if bed is not None else None
        self.soil_target = np.array(soil_target, np.float32)
        self.soil_contrast = soil_contrast
        self.gold_scale = gold_scale
        self.gem_scale = gem_scale
        self.clarity = clarity
        if gold_gamma != 1:
            # metallic read: deeper mid-tones and crevices, highlights kept (the sheen comes from the contrast)
            for spr in lib.gold:
                if spr.get('_gamma') == gold_gamma:
                    continue
                rgb = spr['rgba'][..., :3]
                lum = np.maximum(rgb @ np.array([0.2126, 0.7152, 0.0722], np.float32), 1e-4)
                spr['rgba'][..., :3] = np.clip(rgb * (np.power(lum, gold_gamma) * 1.06 / lum)[..., None], 0, 1)
                spr['_gamma'] = gold_gamma
        if gold_sat != 1:
            # the target's gold is paler than the image model's (HSV saturation ~0.6 vs ~0.82)
            for spr in lib.gold:
                if spr.get('_sat') == gold_sat:
                    continue
                rgb = spr['rgba'][..., :3]
                lum = rgb @ np.array([0.2126, 0.7152, 0.0722], np.float32)
                spr['rgba'][..., :3] = np.clip(lum[..., None] + (rgb - lum[..., None]) * gold_sat, 0, 1)
                spr['_sat'] = gold_sat
        if gold_gain != 1 or gold_knee < 1:
            # v4: the target's gold sits ~10 % darker with its highlights well below white (p90 ~0.85 vs ~0.97):
            # scale luminance, then roll highlights off above the knee so the shader's glints carry the sparkle.
            for spr in lib.gold:
                if spr.get('_gain') == (gold_gain, gold_knee):
                    continue
                rgb = spr['rgba'][..., :3]
                lum = np.maximum(rgb @ np.array([0.2126, 0.7152, 0.0722], np.float32), 1e-4)
                v = gold_curve(lum, gold_gain, gold_knee)
                spr['rgba'][..., :3] = np.clip(rgb * (v / lum)[..., None], 0, 1)
                spr['_gain'] = (gold_gain, gold_knee)
        if gem_gamma != 1:
            # at game scale the image model's deep ruby/emerald/sapphire bodies average into dark blobs; lifting
            # their mid-tones (luminance gamma < 1, hue kept) restores the original gems' bright, glassy read
            for spr in lib.gem:
                if spr.get('_ggamma') == gem_gamma:
                    continue
                rgb = spr['rgba'][..., :3]
                lum = np.maximum(rgb @ np.array([0.2126, 0.7152, 0.0722], np.float32), 1e-4)
                spr['rgba'][..., :3] = np.clip(rgb * (np.power(lum, gem_gamma) / lum)[..., None], 0, 1)
                spr['_ggamma'] = gem_gamma
        if gem_sat != 1 or gem_pastel:
            # L5F: the target's gems are pale glassy beads (HSV saturation ~0.45) rather than deep faceted crystals
            # (~0.63): pull chroma toward luminance, then lift toward white so they read translucent, not confetti.
            for spr in lib.gem:
                if spr.get('_gsat') == (gem_sat, gem_pastel):
                    continue
                rgb = spr['rgba'][..., :3]
                lum = rgb @ np.array([0.2126, 0.7152, 0.0722], np.float32)
                rgb = lum[..., None] + (rgb - lum[..., None]) * gem_sat
                spr['rgba'][..., :3] = np.clip(rgb + (1 - rgb) * gem_pastel, 0, 1)
                spr['_gsat'] = (gem_sat, gem_pastel)

    def soil_patch(self, otype, n):
        soil = self.lib.soil
        f = 0.36
        th, tw = soil.shape[:2]
        sw = int(n / f) + 2
        x0 = h32('sx', otype) % max(1, tw - sw)
        y0 = h32('sy', otype) % max(1, th - sw)
        crop = soil[y0:y0 + sw, x0:x0 + sw]
        patch = cv2.resize(crop, (n, n), interpolation=cv2.INTER_AREA)
        mean = patch.reshape(-1, 3).mean(0)
        # softer grain than the AI texture: at game scale its pebbles otherwise read as salt-and-pepper noise
        patch = mean + (patch - mean) * self.soil_contrast
        patch = patch * (self.soil_target / np.maximum(mean, 1e-3))
        return np.clip(patch, 0, 1)

    @staticmethod
    def keep_inside(cx, cy, width, lim=0.9):
        """Pull a nugget toward the cell centre (then shrink it) until its lower half stays inside the cell diamond.

        Cells drawn later (the two front neighbours) lay their soil over the diamond edge they share with this cell, so
        any part of a nugget that crosses a lower edge would be cut along a straight diagonal. Upper edges are safe: the
        back neighbours are drawn first."""
        dcx, dcy = (PAD + CANVAS / 2) * S, (PAD + CANVAS / 2 + 15) * S

        def worst(x, y, w):
            pts = ((x, y + 0.36 * w), (x - 0.48 * w, y + 0.08 * w), (x + 0.48 * w, y + 0.08 * w))
            return max(abs(px - dcx) / (30 * S) + abs(py - dcy) / (15 * S) for px, py in pts)

        for _ in range(24):
            if worst(cx, cy, width) <= lim:
                break
            if math.hypot(cx - dcx, cy - dcy) > 2 * S:
                cx, cy = dcx + (cx - dcx) * 0.94, dcy + (cy - dcy) * 0.94
            else:
                width *= 0.9
        return cx, cy, width

    def compose_ext(self, otype, frame):
        items, m11 = self.layout(otype)
        mk = self.overlays.frame_rgba(otype, frame)[..., 3] > 0
        n = N1 * S
        P4 = PAD * S
        shares, cents = voronoi_share(items, m11, mk)
        gem = otype.startswith('GEM')
        alpha = np.zeros((n, n), np.float32)
        height = np.zeros((n, n), np.float32)
        metal = np.zeros((n, n), np.float32)
        gloss = np.zeros((n, n), np.float32)
        objmask = np.zeros((n, n), np.float32)
        placed = []
        for i, it in enumerate(items):
            sh = shares[i]
            if sh < 0.05:
                continue
            s = max(math.sqrt(sh), 0.42)
            cx = it['x'] * 0.45 + cents[i][0] * 0.55 + P4
            cy = it['y'] * 0.45 + cents[i][1] * 0.55 + P4
            width = 2 * it['r'] * (self.gold_scale if not gem else self.gem_scale) * s
            cx, cy, width = self.keep_inside(cx, cy, width)
            placed.append((i, it, cx, cy, width, s))
        # --- soil field: union of soft blobs around the nuggets (ore); a faint stain (gems)
        field = np.zeros((n, n), np.float32)
        # Young/depleted stages carry a smaller, fainter soil stain, so removing a cell's last frame never pops a
        # full-size dirt patch (and a freshly spread cell does not appear as bare dirt first)
        grow = min(1.0, (frame + 1) / 6)
        bed = self.bed
        for i, it, cx, cy, width, s in placed:
            if bed is None:
                sig = width * 0.6 + ((2.5 + 2.5 * grow) if not gem else 0.6) * S
            else:
                # L5F contact bed: a tight halo directly under each nugget/gem, so grass shows between them and the
                # field never forms a carpet with cell-shaped (staircase) edges.
                sig = width * bed['spread'] + bed['margin'] * (0.5 + 0.5 * grow) * S
            yy0, yy1 = int(max(cy - 3 * sig, 0)), int(min(cy + 3 * sig, n))
            xx0, xx1 = int(max(cx - 3 * sig, 0)), int(min(cx + 3 * sig, n))
            yy, xx = np.mgrid[yy0:yy1, xx0:xx1].astype(np.float32)
            g = np.exp(-(((xx - cx) / sig) ** 2 + ((yy - cy) / (sig * 0.62)) ** 2))
            field[yy0:yy1, xx0:xx1] = np.maximum(field[yy0:yy1, xx0:xx1], g)
        noise = (value_noise((n, n), 7.0 * S / 4, h32('soil', otype)) * 0.6
                 + value_noise((n, n), 2.5 * S / 4, h32('soil2', otype)) * 0.4)
        # adjacent cells: both fade over the diamond edge and overlap a little, so a dense field reads continuous
        cellfade = np.clip((1.07 - DIAMOND) / 0.13, 0, 1)
        if bed is not None:
            cap = bed['gem_alpha'] if gem else bed['alpha']
            bed_a = np.clip(field * bed['gain'] - bed['floor'] + (noise - 0.5) * 0.35, 0, 1)
            bed_a = cv2.GaussianBlur(bed_a, (0, 0), 0.8) * cap * cellfade * (0.6 + 0.4 * grow)
            soil = self.soil_patch(otype, n)
            prem = soil * bed_a[..., None]
            alpha = bed_a.copy()
            gloss[:] = 0.12
        elif not gem:
            soil_a = np.clip(field * 2.3 - 0.15 + (noise - 0.5) * 0.6, 0, 1)
            soil_a = cv2.GaussianBlur(soil_a, (0, 0), 1.0) * 0.95 * cellfade * (0.5 + 0.5 * grow)
            soil = self.soil_patch(otype, n)
            prem = soil * soil_a[..., None]
            alpha = soil_a.copy()
            gloss[:] = 0.12
        else:
            stain = np.clip(field * 0.9 - 0.25 + (noise - 0.5) * 0.3, 0, 1) * 0.16 * cellfade
            prem = np.zeros((n, n, 3), np.float32)
            alpha = stain
        # --- contact shadows (sun from the upper left: they fall right and a little down on screen)
        shadow = np.zeros((n, n), np.float32)
        for i, it, cx, cy, width, s in placed:
            ax, ay = width * 0.55, width * 0.26
            sx, sy = cx + width * 0.16, cy + width * 0.06
            yy0, yy1 = int(max(sy - 3 * ay, 0)), int(min(sy + 3 * ay, n))
            xx0, xx1 = int(max(sx - 3 * ax, 0)), int(min(sx + 3 * ax, n))
            if yy1 <= yy0 or xx1 <= xx0:
                continue
            yy, xx = np.mgrid[yy0:yy1, xx0:xx1].astype(np.float32)
            g = np.exp(-(((xx - sx) / ax) ** 2 + ((yy - sy) / ay) ** 2) * 1.6)
            shadow[yy0:yy1, xx0:xx1] = np.maximum(shadow[yy0:yy1, xx0:xx1], g)
        if bed is None:
            sh_a = shadow * (0.62 if not gem else 0.5)
        else:
            sh_a = shadow * (bed['shadow'] if not gem else bed['gem_shadow'])
        prem = prem * (1 - sh_a[..., None])
        alpha = sh_a + alpha * (1 - sh_a)
        # --- objects back to front
        placed.sort(key=lambda p: p[3] + p[4] * 0.2)
        for i, it, cx, cy, width, s in placed:
            src, hgt, met = scaled_sprite(it['sprite'], width)
            h, w = src.shape[:2]
            x = int(round(cx - w / 2))
            y = int(round(cy - h * 0.62))
            region = paste(prem, alpha, src, x, y)
            if region is None:
                continue
            dy, dx, sy_, sx_ = region
            a = src[sy_, sx_, 3]
            height[dy, dx] = hgt[sy_, sx_] * (width / S) * a + height[dy, dx] * (1 - a)
            metal[dy, dx] = met[sy_, sx_] * a + metal[dy, dx] * (1 - a)
            g = 0.95 if gem else 0.82
            gloss[dy, dx] = g * a + gloss[dy, dx] * (1 - a)
            objmask[dy, dx] = np.maximum(objmask[dy, dx], a)
        # --- crop to the ext rect
        X0 = (EXT_OFF[0] + CANVAS // 2 + PAD) * S
        Y0 = (EXT_OFF[1] + CANVAS // 2 + PAD) * S
        W4, H4 = EXT_W * S, EXT_H * S
        sl = (slice(Y0, Y0 + H4), slice(X0, X0 + W4))
        a4 = alpha[sl].copy()
        rgb4 = prem[sl] / np.maximum(alpha[sl][..., None], 1e-4)
        hgt4 = cv2.GaussianBlur(height[sl], (0, 0), 0.8)
        gy, gx = np.gradient(hgt4)
        k = 1.1
        core = cv2.erode(objmask[sl], np.ones((5, 5), np.uint8))
        tilt = k * np.clip(cv2.GaussianBlur(core, (0, 0), 1.5) * 1.4, 0, 1)
        nrm = UP[None, None, :] - tilt[..., None] * (gx[..., None] * SCREEN_RIGHT + gy[..., None] * SCREEN_DOWN_GROUND)
        nrm /= np.linalg.norm(nrm, axis=-1, keepdims=True)
        om = objmask[sl]
        nrm = nrm * om[..., None] + UP * (1 - om[..., None])
        nrm /= np.linalg.norm(nrm, axis=-1, keepdims=True)
        met4 = metal[sl] * om
        gl4 = gloss[sl]
        # B decodes to dielectric gloss 2B below .5, metal gloss 2(B-.5) above .5.
        B = np.where(met4 > 0.5, 0.5 + gl4 * 0.5, gl4 * 0.5 * (1 - om) + om * (0.47 if gem else gl4 * 0.15))
        cav = np.clip((cv2.GaussianBlur(hgt4, (0, 0), 2.0) - hgt4) / (0.6 * S), 0, 1)
        ao = np.clip(1 - 0.45 * cav - 0.35 * shadow[sl] * (1 - om), 0.35, 1)
        size2 = (EXT_W * OUT, EXT_H * OUT)
        pm2 = cv2.resize(np.dstack([rgb4 * a4[..., None], a4]), size2, interpolation=cv2.INTER_AREA)
        a2 = np.clip(pm2[..., 3], 0, 1)
        rgb2 = pm2[..., :3] / np.maximum(a2[..., None], 1e-4)
        n2 = cv2.resize(nrm * a4[..., None], size2, interpolation=cv2.INTER_AREA)
        n2 /= np.maximum(np.linalg.norm(n2, axis=-1, keepdims=True), 1e-4)
        n2 = np.where(a2[..., None] > 1e-3, n2, UP)
        B2 = cv2.resize(B * a4, size2, interpolation=cv2.INTER_AREA) / np.maximum(a2, 1e-4)
        ao2 = cv2.resize(ao * a4, size2, interpolation=cv2.INTER_AREA) / np.maximum(a2, 1e-4)
        B2 = np.where(a2 > 1e-3, B2, 0)
        ao2 = np.where(a2 > 1e-3, ao2, 1)
        if self.clarity:
            # local contrast at the delivered scale: the area filter averages nugget/gem facets toward flat blobs
            obj2 = cv2.resize(om * a4, size2, interpolation=cv2.INTER_AREA) / np.maximum(a2, 1e-4)
            blur = cv2.GaussianBlur(rgb2, (0, 0), 1.2)
            rgb2 = rgb2 + (rgb2 - blur) * (self.clarity * np.clip(obj2, 0, 1))[..., None]
        rgba2 = np.dstack([np.clip(rgb2, 0, 1), a2]).astype(np.float32)
        mat2 = np.dstack([n2[..., 0] * 0.5 + 0.5, n2[..., 2] * 0.5 + 0.5, np.clip(B2, 0, 1),
                          0.3 + 0.7 * np.clip(ao2, 0, 1)]).astype(np.float32)
        # Extend the 1x indexed mask under HD coverage: the renderer gates HD texels by the native mask,
        # so soil/shadows/nuggets outside the original silhouette would otherwise disappear.
        # Preserve original indices; the builder supplies a non-remap soil index for newly covered texels.
        idx, fr = self.overlays.frame_indexed(otype, frame)
        orig = np.zeros((N1, N1), np.uint8)
        ox, oy = fr['offset']
        hh, ww = idx.shape
        orig[oy + CANVAS // 2 + PAD:oy + CANVAS // 2 + PAD + hh, ox + CANVAS // 2 + PAD:ox + CANVAS // 2 + PAD + ww] = idx
        x1 = EXT_OFF[0] + CANVAS // 2 + PAD
        y1 = EXT_OFF[1] + CANVAS // 2 + PAD
        orig = orig[y1:y1 + EXT_H, x1:x1 + EXT_W]
        cover1 = cv2.resize(a2, (EXT_W, EXT_H), interpolation=cv2.INTER_AREA)
        amax = cv2.dilate(a2, np.ones((2, 2), np.uint8))[::2, ::2][:EXT_H, :EXT_W]
        need = (np.maximum(cover1, amax) > 0.02).astype(np.uint8)
        need = cv2.dilate(need, np.ones((3, 3), np.uint8))
        return dict(rgba2=rgba2, mat2=mat2, orig1=orig, need1=need.astype(bool))


# ----------------------------------------------------------------------------- atlas building

def soil_index(overlays: OverlayLibrary, target: np.ndarray) -> int:
    pal = overlays.palette().astype(np.float32)
    ok = np.ones(256, bool)
    ok[0] = False
    ok[16:32] = False  # house-remap range
    d = ((pal - target[None]) ** 2).sum(-1)
    d[~ok] = 1e9
    return int(d.argmin())


def bleed(rgb, a, iters=6):
    """Spread colour into fully transparent texels so linear filtering at the silhouette never pulls in black."""
    rgb = rgb.copy()
    known = a > 1e-3
    for _ in range(iters):
        if known.all():
            break
        k = known.astype(np.float32)
        s = cv2.blur(rgb * k[..., None], (3, 3))
        w = cv2.blur(k, (3, 3))
        grow = (~known) & (w > 0)
        rgb[grow] = s[grow] / w[grow][..., None]
        known = known | grow
    return rgb


def build(library_root: Path, theatre: str, gold: Path, gem: Path, soil: Path, out: Path, *,
          families: tuple[str, ...] = FAMILIES, page_width: int = PAGE_W, soil_target=SOIL_TARGET,
          soil_contrast: float = 0.7, gold_sat: float = 0.85, gold_gamma: float = 1.2,
          gold_scale: float = 1.16, clarity: float = 0.2, gold_gain: float = 0.95, gold_knee: float = 0.84,
          gem_scale: float = 1.25, gem_gamma: float = 0.78, strict_mask_coverage: bool = False,
          bed: dict | None = BED_L5F, gem_sat: float = GEM_SAT_L5F, gem_pastel: float = GEM_PASTEL_L5F) -> dict:
    if not families or len(set(families)) != len(families) or set(families) - set(FAMILIES):
        raise ValueError('families must be a nonempty, unique selection of TIB01..TIB20 / GEM01..GEM12')
    if page_width < CELL_W:
        raise ValueError(f'page-width must be at least {CELL_W}')
    target = np.asarray(soil_target, np.float32)
    values = (soil_contrast, gold_sat, gold_gamma, gold_scale, clarity, gold_gain, gold_knee, gem_scale, gem_gamma)
    if target.shape != (3,) or not np.isfinite(target).all() or ((target < 0) | (target > 1)).any():
        raise ValueError('soil-target must contain three finite sRGB values in 0..1')
    if not np.isfinite(values).all() or min(values) < 0 or min(gold_gamma, gold_scale, gem_scale, gem_gamma) <= 0 or gold_knee > 1:
        raise ValueError('parameters must be finite and nonnegative; gamma/scale positive; knee in 0..1')
    if not (np.isfinite([gem_sat, gem_pastel]).all() and gem_sat >= 0 and 0 <= gem_pastel <= 1):
        raise ValueError('gem-sat must be nonnegative and gem-pastel in 0..1')
    if bed is not None:
        bed = {**BED_L5F, **bed}
        if not np.isfinite(list(bed.values())).all() or min(bed.values()) < 0 or max(bed['alpha'], bed['gem_alpha']) > 1:
            raise ValueError('bed parameters must be finite and nonnegative, alphas at most 1')
    t0 = time.time()
    overlays = OverlayLibrary(library_root, theatre)
    lib = Library(gold, gem, soil)
    comp = ExtComposer(lib, overlays, target, soil_contrast, gold_sat, gold_gamma, gold_scale, clarity,
                       gold_gain, gold_knee, gem_scale, gem_gamma, bed=bed, gem_sat=gem_sat, gem_pastel=gem_pastel)
    out = Path(out)
    out.mkdir(parents=True, exist_ok=True)
    soil_idx = soil_index(overlays, comp.soil_target * 255)
    per_row = page_width // CELL_W
    total = len(families) * FRAMES
    rows = (total + per_row - 1) // per_row
    H1 = rows * CELL_H
    idx1 = np.zeros((H1, page_width), np.uint8)
    col2 = np.zeros((H1 * 2, page_width * 2, 4), np.float32)
    mat2 = np.zeros((H1 * 2, page_width * 2, 4), np.float32)
    frames = {}
    k = 0
    for fam in families:
        rects = []
        for f in range(FRAMES):
            r = comp.compose_ext(fam, f)
            x = (k % per_row) * CELL_W + 1
            y = (k // per_row) * CELL_H + 1
            k += 1
            rgba = r['rgba2']
            need = r['need1']
            if strict_mask_coverage:
                # Scratch v5's .02 cutoff plus dilation misses some alpha 1..5 shadow/soil tails. Quantize
                # exactly as the delivered HD PNG, then cover each 2x2 block with any nonzero alpha.
                # Keep the legacy mask too; only add coverage, preserving all original palette indices.
                alpha8 = (np.clip(rgba[..., 3], 0, 1) * 255 + 0.5).astype(np.uint8)
                need = need | alpha8.reshape(EXT_H, OUT, EXT_W, OUT).any(axis=(1, 3))
            m = np.where(r['orig1'] > 0, r['orig1'], np.where(need, soil_idx, 0)).astype(np.uint8)
            idx1[y:y + EXT_H, x:x + EXT_W] = m
            col2[y * 2:(y + EXT_H) * 2, x * 2:(x + EXT_W) * 2] = np.dstack([bleed(rgba[..., :3], rgba[..., 3]), rgba[..., 3]])
            mt = r['mat2'].copy()
            mt[..., 3] = np.where(rgba[..., 3] > 1e-3, mt[..., 3], 0)  # A 0 = no material data
            mat2[y * 2:(y + EXT_H) * 2, x * 2:(x + EXT_W) * 2] = mt
            rects.append([x, y, EXT_W, EXT_H])
        frames[fam] = rects
        print(fam, f'{time.time() - t0:.1f}s', flush=True)
    Image.fromarray(idx1, 'L').save(out / PAGE, optimize=True)
    Image.fromarray((np.clip(col2, 0, 1) * 255 + 0.5).astype(np.uint8), 'RGBA').save(out / HD)
    Image.fromarray(np.zeros((H1 * 2, page_width * 2), np.uint8), 'L').save(out / REMAP, optimize=True)
    Image.fromarray((np.clip(mat2, 0, 1) * 255 + 0.5).astype(np.uint8), 'RGBA').save(out / MAT)
    meta = dict(offset=list(EXT_OFF), size=[EXT_W, EXT_H], width=page_width, height=H1, soilIndex=soil_idx, frames=frames)
    write_atomic(out / 'frames.json', json.dumps(meta).encode())
    print('done', page_width, H1, f'{time.time() - t0:.1f}s')
    return meta


# ----------------------------------------------------------------------------- locked copy-on-write installation


def validate_ore_build(build_dir: Path) -> dict:
    build_dir = Path(build_dir)
    meta = read_json(build_dir / 'frames.json')
    if not meta['frames'] or set(meta['frames']) - set(FAMILIES):
        raise ValueError('build metadata contains no ore/gem frames or an unknown family')
    if any(len(rects) != FRAMES for rects in meta['frames'].values()):
        raise ValueError('each built family must contain exactly 12 growth frames')
    for name in PAGE_FILES:
        if not (build_dir / name).is_file():
            raise ValueError(f'build page is missing: {name}')
    return meta


def apply_ore_page(lib: dict, normals: dict, meta: dict) -> tuple[int, int]:
    """Redirect ore/gem growth frames and record their shared HD and material page."""
    atlases = lib['spriteAtlases']
    page = next((i for i, atlas in enumerate(atlases) if atlas['file'] == PAGE), None)
    if page is None:
        page = len(atlases)
        atlases.append({})
    atlases[page] = {'file': PAGE, 'width': meta['width'], 'height': meta['height']}
    hd = lib.setdefault('spriteAtlasesHd', [])
    while len(hd) <= page:
        hd.append(None)
    hd[page] = {'file': HD, 'remap': REMAP, 'scale': OUT,
                'width': meta['width'] * OUT, 'height': meta['height'] * OUT}
    changed = 0
    for key, sprite in lib['sprites'].items():
        if not key.startswith('overlay:'):
            continue
        name = key.split(':', 1)[1]
        family = ALIASES.get(name, name)
        if family not in meta['frames']:
            continue
        if len(sprite['frames']) < FRAMES:
            raise ValueError(f'{key}: destination has fewer than 12 growth frames')
        for k, rect in enumerate(meta['frames'][family]):
            # Keep frame-specific metadata too; only geometry and the page belong to this track.
            sprite['frames'][k].update(rect=rect, offset=meta['offset'], page=page)
        changed += 1
    normals.setdefault('pages', {})[str(page)] = {
        'file': MAT, 'atlas': HD, 'width': meta['width'] * OUT, 'height': meta['height'] * OUT, 'scale': OUT,
        'materialWidth': meta['width'] * OUT, 'materialHeight': meta['height'] * OUT,
        'frames': sum(len(value) for value in meta['frames'].values()),
    }
    return page, changed


def patch_ore_normals(directory: Path, normals: dict) -> None:
    def update(current):
        current.setdefault('pages', {}).update(normals['pages'])
    # Only publish the entry computed under the library lock; other material writers keep their entries.
    cache_farm.patch_json(directory, 'normals.json', update, default={'version': 1, 'pages': {}})


def install(build_dir: Path, cache_root: Path, theatre: str) -> int:
    build_dir = Path(build_dir)
    directory = Path(cache_root) / '_library' / theatre
    meta = validate_ore_build(build_dir)
    # The compose lock covers files and both JSON publications; per-file locks exclude independent patchers.
    with (directory / '.compose.lock').open('a+') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        try:
            for name in PAGE_FILES:
                cache_farm.install_file(directory, name, build_dir / name)
            page, changed = None, 0
            normals = {}

            def update(lib):
                nonlocal page, changed
                page, changed = apply_ore_page(lib, normals, meta)

            cache_farm.patch_json(directory, 'library.json', update)
            patch_ore_normals(directory, normals)
        finally:
            fcntl.flock(lock, fcntl.LOCK_UN)
    print(theatre, 'page', page, 'sprites patched', changed)
    return page


# ----------------------------------------------------------------------------- stage comparison sheets

TW, TH = 150, 104          # tile size (2x scale)
AX, AY = 75, 30            # anchor (the cell's top corner) inside a tile, 2x pixels
GRASS = (74, 88, 46)


def ground():
    rng = np.random.default_rng(7)
    g = np.array(GRASS, np.float32)[None, None] * (1 + 0.06 * rng.standard_normal((TH, TW, 1)))
    # the cell diamond outline (faint) for position reference
    img = Image.fromarray(np.clip(g, 0, 255).astype(np.uint8), 'RGB')
    d = ImageDraw.Draw(img)
    d.polygon([(AX, AY), (AX + 60, AY + 30), (AX, AY + 60), (AX - 60, AY + 30)], outline=(100, 112, 70))
    return img


def over(base, rgba, x, y):
    im = Image.fromarray(rgba, 'RGBA')
    layer = Image.new('RGBA', base.size, (0, 0, 0, 0))
    layer.paste(im, (int(x), int(y)))
    return Image.alpha_composite(base.convert('RGBA'), layer).convert('RGB')


def tile_original(overlays, otype, frame):
    a, fr = overlays.frame_indexed(otype, frame)
    pal = overlays.palette()
    rgba = np.dstack([pal[a], (a > 0).astype(np.uint8) * 255]).astype(np.uint8)
    rgba = np.repeat(np.repeat(rgba, 2, 0), 2, 1)
    ox, oy = fr['offset']
    return over(ground(), rgba, AX + 2 * ox, AY + 2 * oy)


class MapL4:
    def __init__(self, cache_root: Path, map_name: str):
        directory = Path(cache_root) / map_name
        self.man = read_json(directory / 'manifest.json')
        self.hd = read_image(directory / 'sprites@2x.png', 'RGBA')

    def tile(self, otype, frame):
        spr = self.man['sprites'].get('overlay:' + otype)
        if not spr or frame >= len(spr['frames']):
            return None
        fr = spr['frames'][frame]
        x, y, w, h = fr['rect']
        if w == 0 or h == 0:
            return ground()
        rgba = self.hd[2 * y:2 * (y + h), 2 * x:2 * (x + w)]
        ox, oy = fr['offset']
        return over(ground(), rgba, AX + 2 * ox, AY + 2 * oy)


class PageL5:
    def __init__(self, build):
        self.meta = read_json(Path(build) / 'frames.json')
        self.hd = read_image(Path(build) / HD, 'RGBA')

    def tile(self, otype, frame):
        x, y, w, h = self.meta['frames'][otype][frame]
        rgba = self.hd[2 * y:2 * (y + h), 2 * x:2 * (x + w)]
        ox, oy = self.meta['offset']
        return over(ground(), rgba, AX + 2 * ox, AY + 2 * oy)


def label(img, xy, text, font_path, size=22, fill=(20, 20, 20)):
    ImageDraw.Draw(img).text(xy, text, font=ImageFont.truetype(str(font_path), size), fill=fill)


def stages_sheet(overlays, l4, l5, out, font_path):
    fams = [('TIB01', '金矿 TIB01'), ('GEM01', '宝石 GEM01')]
    rows = [('原版', lambda family, frame: tile_original(overlays, family, frame)), ('L4', l4.tile), ('L5', l5.tile)]
    LW, HH, GAP = 120, 40, 18
    W = LW + 12 * (TW + 4)
    H = 70 + len(fams) * (HH + len(rows) * (TH + 4) + GAP)
    sheet = Image.new('RGB', (W, H), (236, 234, 228))
    label(sheet, (12, 14), 'L5 矿石/宝石：12 个生长阶段（原版 | L4 | L5，2 倍像素，同一锚点；菱形线 = 格子）', font_path, 26)
    y = 70
    for fam, title in fams:
        label(sheet, (12, y + 6), title, font_path, 24, (90, 40, 10))
        for k in range(12):
            label(sheet, (LW + k * (TW + 4) + 50, y + 10), f'阶段 {k}', font_path, 18, (60, 60, 60))
        y += HH
        for name, fn in rows:
            label(sheet, (14, y + TH // 2 - 14), name, font_path, 26)
            for k in range(12):
                t = fn(fam, k)
                if t is not None:
                    sheet.paste(t, (LW + k * (TW + 4), y))
            y += TH + 4
        y += GAP
    sheet.save(out)
    return sheet


def variants_sheet(overlays, l5, out, font_path, stage=11):
    fams = list(l5.meta['frames'])
    per = 11
    LW, GAP = 90, 16
    blocks = (len(fams) + per - 1) // per
    W = LW + per * (TW + 4)
    H = 70 + blocks * (34 + 2 * (TH + 4) + GAP)
    sheet = Image.new('RGB', (W, H), (236, 234, 228))
    label(sheet, (12, 14), f'全部 {len(fams)} 种矿石/宝石变体（阶段 {stage}）：上 = 原版，下 = L5', font_path, 26)
    y = 70
    for b in range(blocks):
        chunk = fams[b * per:(b + 1) * per]
        for i, fam in enumerate(chunk):
            label(sheet, (LW + i * (TW + 4) + 46, y + 4), fam, font_path, 18, (90, 40, 10))
        y += 34
        for name, fn in (('原版', lambda family, frame: tile_original(overlays, family, frame)), ('L5', l5.tile)):
            label(sheet, (12, y + TH // 2 - 14), name, font_path, 24)
            for i, fam in enumerate(chunk):
                sheet.paste(fn(fam, stage), (LW + i * (TW + 4), y))
            y += TH + 4
        y += GAP
    sheet.save(out)
    return sheet


def phone_copy(path: Path, max_w: int = 2000) -> None:
    with Image.open(path) as image:
        im = image.convert('RGB')
    if im.width > max_w:
        im = im.resize((max_w, round(im.height * max_w / im.width)), Image.Resampling.LANCZOS)
    im.save(path.with_name(path.stem + '_s.jpg'), quality=88)


def sheet(build_dir: Path, library_root: Path, theatre: str, cache_root: Path, map_name: str,
          font_path: Path, out: Path) -> None:
    overlays = OverlayLibrary(library_root, theatre)
    l4, l5 = MapL4(cache_root, map_name), PageL5(build_dir)
    out.mkdir(parents=True, exist_ok=True)
    stages_sheet(overlays, l4, l5, out / 'stages_TIB01_GEM01.png', font_path)
    variants_sheet(overlays, l5, out / 'variants_stage11.png', font_path)
    variants_sheet(overlays, l5, out / 'variants_stage5.png', font_path, stage=5)
    for name in ('stages_TIB01_GEM01', 'variants_stage11', 'variants_stage5'):
        phone_copy(out / f'{name}.png')
    print('sheets:', out)


# ----------------------------------------------------------------------------- command line

def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    commands = parser.add_subparsers(dest='command', required=True)

    def path_arg(command, flag, help_text):
        command.add_argument(flag, type=Path, required=True, help=help_text)

    def library_args(command):
        path_arg(command, '--library-root', 'read-only cache root containing _library/THEATRE')
        command.add_argument('--theatre', required=True, help='original indexed theatre library name')

    p = commands.add_parser('extract', help='cut a grey-118 image-model sheet into a safe sprite library')
    path_arg(p, '--sheet', 'input image-model sheet')
    p.add_argument('--kind', choices=('gold', 'gem'), required=True)
    path_arg(p, '--out', 'output .npz; also writes a companion .json index')
    p.add_argument('--rows', type=int, default=6)
    p.add_argument('--cols', type=int, default=8)
    p.add_argument('--min-area', type=int, default=300)

    p = commands.add_parser('build', help='compose the four atlas PNGs and frames.json')
    library_args(p)
    for flag, help_text in (('--gold', 'gold .npz (+ .json) or trusted scratch .pkl'),
                            ('--gem', 'gem .npz (+ .json) or trusted scratch .pkl'),
                            ('--soil', 'soil texture image'), ('--out', 'output build directory')):
        path_arg(p, flag, help_text)
    p.add_argument('--soil-target', type=float, nargs=3, default=[0.46, 0.325, 0.19], metavar=('R', 'G', 'B'),
                   help='mean sRGB soil colour in 0..1 (default: .46 .325 .19)')
    for name, default in (('soil-contrast', 0.7), ('gold-sat', 0.85), ('gold-gamma', 1.2),
                          ('gold-scale', 1.16), ('clarity', 0.2), ('gold-gain', 0.95), ('gold-knee', 0.84),
                          ('gem-scale', 1.25), ('gem-gamma', 0.78)):
        p.add_argument('--' + name, type=float, default=default, help=f'default: {default}')
    p.add_argument('--bed', choices=('contact', 'carpet'), default='contact',
                   help='contact: L5F faint halo under each object (default); carpet: the L5 v8 soil field')
    for name, key in (('bed-alpha', 'alpha'), ('gem-bed-alpha', 'gem_alpha'), ('bed-spread', 'spread'),
                      ('bed-margin', 'margin'), ('bed-shadow', 'shadow'), ('gem-bed-shadow', 'gem_shadow')):
        p.add_argument('--' + name, type=float, default=BED_L5F[key], help=f'contact bed (default: {BED_L5F[key]})')
    p.add_argument('--gem-sat', type=float, default=GEM_SAT_L5F,
                   help=f'gem chroma factor, 1 = L5 v8 (default: {GEM_SAT_L5F})')
    p.add_argument('--gem-pastel', type=float, default=GEM_PASTEL_L5F,
                   help=f'gem lift toward white, 0 = L5 v8 (default: {GEM_PASTEL_L5F})')
    p.add_argument('--families', choices=FAMILIES, nargs='+', default=FAMILIES,
                   help='families to build (default: all 32)')
    p.add_argument('--page-width', type=int, default=PAGE_W, help='1x page width (default: 2048)')
    p.add_argument('--strict-mask-coverage', action='store_true',
                   help='extend 1x coverage under every nonzero HD alpha texel; default retains the scratch mask')

    p = commands.add_parser('install', help='patch the destination theatre under its compose lock')
    path_arg(p, '--build-dir', 'directory containing the four PNGs and frames.json')
    path_arg(p, '--cache-root', 'destination cache root containing _library/THEATRE')
    p.add_argument('--theatre', required=True)

    p = commands.add_parser('sheet', help='write original / L4 / L5 comparison sheets with Chinese labels')
    library_args(p)
    path_arg(p, '--build-dir', 'built L5 atlas directory')
    path_arg(p, '--cache-root', 'read-only L4 root containing map caches')
    p.add_argument('--map', dest='map_name', required=True, help='L4 map cache name')
    path_arg(p, '--font', 'font file supporting the Chinese comparison labels')
    path_arg(p, '--out', 'output sheet directory')
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        if args.command == 'extract':
            extract(args.sheet, args.kind, args.out, args.rows, args.cols, args.min_area)
        elif args.command == 'build':
            build(args.library_root, args.theatre, args.gold, args.gem, args.soil, args.out,
                  families=tuple(args.families), page_width=args.page_width, soil_target=args.soil_target,
                  soil_contrast=args.soil_contrast, gold_sat=args.gold_sat, gold_gamma=args.gold_gamma,
                  gold_scale=args.gold_scale, clarity=args.clarity, gold_gain=args.gold_gain, gold_knee=args.gold_knee,
                  gem_scale=args.gem_scale, gem_gamma=args.gem_gamma, strict_mask_coverage=args.strict_mask_coverage,
                  bed=None if args.bed == 'carpet' else {
                      'alpha': args.bed_alpha, 'gem_alpha': args.gem_bed_alpha, 'spread': args.bed_spread,
                      'margin': args.bed_margin, 'shadow': args.bed_shadow, 'gem_shadow': args.gem_bed_shadow},
                  gem_sat=args.gem_sat, gem_pastel=args.gem_pastel)
        elif args.command == 'install':
            install(args.build_dir, args.cache_root, args.theatre)
        elif args.command == 'sheet':
            sheet(args.build_dir, args.library_root, args.theatre, args.cache_root, args.map_name, args.font, args.out)
    except (OSError, ValueError, KeyError, IndexError, pickle.UnpicklingError, cv2.error) as error:
        print(f'ore_fields {args.command}: {error}', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
