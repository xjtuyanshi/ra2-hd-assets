#!/usr/bin/env python3
"""Prepare and post-process tree redraw sheets without calling an image model.

This ports the tree scratch pipeline without changing its numerical method. Dependencies: NumPy, Pillow and
OpenCV. All input/output locations are explicit; keep game art and every derived image outside the repository.
The JSON spec contains sheet rows of [tree, cell_width], descriptions, and selection (tree -> processed-source
subdirectory); additional top-level notes are ignored. See tree_redraw_spec.example.json. A sheet uses one reference map; build colour-locks its chosen
redraws separately to each destination map's original art. Only frame/shadow 0 is processed.

The image model draws fine, evenly lit leaves; after downscaling to the 2x atlas they average into flat mid-tones.
The volume pass adds crown-scale light penetration (Beer-Lambert along the ray towards the sun), a dome Lambert
term from the silhouette, and crown-bottom occlusion before the colour lock. It multiplies linear-light RGB and
normalises the shading to preserve mean luminance; the subsequent colour lock restores the original's value
distribution with this new spatial order. The sun is at screen left and slightly above, matching the original art.

Stages (run this file with the named subcommand; each also accepts --help):
* extract --cache-root CACHE --map MAP --orig-dir ORIG
  writes MAP_TREE_f0_1x.png (palette-decoded RGBA), _f0_2x.png and _s0_1x.png (greyscale shadow).
* sheet --spec SPEC --map MAP --orig-dir ORIG --sheet A --work-dir GEN [--scale 5.0] [--refine-from IMAGE]
  prepares input.png, layout.json and prompt.txt: a 1536x1024 grey-118 sheet, premultiplied Lanczos enlargement.
  --refine-from copies a previous model sheet as RGB input.png and uses the refinement prompt; IMAGE must be
  1536x1024 with the same layout. Layout metadata still comes from the spec, original frames and scale.
* process --map MAP --orig-dir ORIG --gen-dir GEN --image output.png --work-dir PROC/SOURCE
  fits a polynomial background, mattes/unmixes foreground, removes stray components, registers anisotropic
  scale/translation by blurred-mask correlation, and area-resamples to straight RGBA. Writes TREE_2x.png,
  TREE_5x.png (the historical name even at another sheet scale), TREE_matte.png and reg.json. MAP is the sheet's
  reference map, not necessarily the destination map. Layout fixes the tree names and frame sizes.
* fit-shadows --spec SPEC --cache-root CACHE --map MAP --orig-dir ORIG --work-dir WORK
  writes WORK/shadow_fit.json. Fits billboard projection to original shadows, coarse/fine maximum-IoU search.
* build --spec SPEC --cache-root CACHE --map MAP --orig-dir ORIG --proc-dir PROC --patch-dir PATCH
  writes PATCH/MAP/TREE_2x.png and TREE_1x.png plus build.json. Densifies internal crown holes, adds volume, then locks
  Lab lightness quantiles, a/b means and chroma spread. Colour is bled under transparent HD texels; the dilated
  1x coverage uses nearest original-tree palette colours excluding transparent and house-colour indices 16..31.
  Defaults: --kL 1.0, ref=2x, kab=1.0, kc=0.8, lift=0.0; densify edge=2, rscale=.035, shade=.42, sat=.8.
  --cfg is a JSON object with any of ref, kL, kab, kc, lift, densify, volume; kL overrides --kL and densify replaces
  the whole options object (null or {} disables it), as in the scratch script. An absent volume key uses
  {"strength":1.3,"density":0.1}; null disables volume; a dict supplies exactly those volume() kwargs ({} uses
  function defaults). build.json records the volume kwargs per tree. Example: --cfg '{"volume":null}'.
* shadows --cache-root CACHE --map MAP --patch-dir PATCH --fit WORK/shadow_fit.json
  writes TREE_s1x.png and shadows.json. With height h=yb-y, a billboard point lands at
  (x+a*h+cx, yb-b*h+cy). Four subsamples per axis yield projection P; the shadow is
  clip(S_original + P(new_alpha) - P(original_alpha), 0, 1), then atlas-aligned 4x4 Bayer dithering.
  Delta transfer preserves original 3D crown depth where the redraw matches; it is not a new 3D shadow model.
* apply --map MAP --patch-dir PATCH --base BASE_MAP --variant-dir VARIANT [--normals]
  creates a symlink farm of BASE_MAP, copies/pastes only build.json's frame rects plus available shadow patches,
  and atomically replaces the variant atlases and l3_frames_trees.json. Existing regular atlases preserve other
  tracks' edits. Optional materials use the sibling sprite_normals.tree_material if normals.json exists.
  Instead of --base, --cache-root CACHE selects CACHE/MAP. Base and variant must be different directories.

The operator runs one image-model call per prepared sheet directory, following run_img.sh (no call is made here).
Set CODEX to the CLI executable and D to the absolute sheet directory, then in a shell:
    cd "$D"
    date +%s > start
    "$CODEX" exec -s workspace-write --skip-git-repo-check -C "$D" -o "$D/last.txt" \
        "$(cat "$D/prompt.txt")" < /dev/null > "$D/run.log" 2>&1
    echo $? > exit
    date +%s > end
Inspect the exit/log and output.png (also output_raw.png); use a fresh directory for retries to avoid stale output.
Model quality, species fidelity and real renderer acceptance require separate visual review; this tool only prepares
and post-processes art. Synthetic tests need no game files or model access.
"""

from __future__ import annotations

import argparse
import json
import math
import os
from pathlib import Path
import tempfile

import cv2
import numpy as np
from PIL import Image

BG = 118
SHEET_SIZE = (1536, 1024)
ROW_HEIGHT = 512
REF = '2x'
KAB, KC, LIFT = 1.0, 0.8, 0.0
DENSIFY = {'edge': 2, 'rscale': 0.035, 'shade': 0.42, 'sat': 0.8}
VOLUME = {'strength': 1.3, 'density': 0.1}
SUB = 4
BAYER = (np.array([[0, 8, 2, 10], [12, 4, 14, 6], [3, 11, 1, 9], [15, 7, 13, 5]], np.float32) + 0.5) / 16


def read_json(path: Path) -> dict:
    with path.open() as stream:
        return json.load(stream)


def write_json(value: dict, path: Path) -> None:
    """Replace the destination itself, including a symlink in a variant, without writing through it."""
    with tempfile.NamedTemporaryFile(mode='w', dir=path.parent, suffix='.tmp-trees.json', delete=False) as stream:
        tmp = Path(stream.name)
        try:
            json.dump(value, stream, indent=1)
        except BaseException:
            tmp.unlink()
            raise
    try:
        os.replace(tmp, path)
    finally:
        tmp.unlink(missing_ok=True)


def read_image(path: Path, mode: str | None = None) -> np.ndarray:
    with Image.open(path) as im:
        return np.array(im.convert(mode) if mode else im)


def load_spec(path: Path) -> dict:
    """Load descriptive sheet/selection data; source names are relative to --proc-dir."""
    spec = read_json(path)
    for key in ('sheets', 'descriptions', 'selection'):
        if not isinstance(spec.get(key), dict):
            raise ValueError(f'spec.{key} must be an object')
    for tree, src in spec['selection'].items():
        if not isinstance(tree, str) or not tree or Path(tree).name != tree:
            raise ValueError(f'invalid tree name: {tree!r}')
        if not isinstance(src, str) or not src or Path(src).is_absolute() or '..' in Path(src).parts:
            raise ValueError(f'selection[{tree!r}] must be a relative processed-source path')
    for name, rows in spec['sheets'].items():
        if not rows or len(rows) > SHEET_SIZE[1] // ROW_HEIGHT:
            raise ValueError(f'sheet {name!r} must have one or two rows')
        seen = set()
        for row in rows:
            total = 0
            if not row:
                raise ValueError(f'sheet {name!r} has an empty row')
            for tree, width in row:
                if tree not in spec['descriptions'] or tree in seen or Path(tree).name != tree:
                    raise ValueError(f'sheet {name!r}: duplicate, unsafe or undescribed tree {tree!r}')
                if not isinstance(width, int) or width <= 0:
                    raise ValueError(f'sheet {name!r}: cell width must be a positive integer')
                seen.add(tree)
                total += width
            if total > SHEET_SIZE[0]:
                raise ValueError(f'sheet {name!r} exceeds {SHEET_SIZE[0]} pixels')
    return spec


# ----------------------------------------------------------------------------- colour and crown density


def lab_of(rgba: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    rgb = rgba[..., :3].astype(np.float32) / 255.0
    return cv2.cvtColor(rgb, cv2.COLOR_RGB2LAB), rgba[..., 3].astype(np.float32) / 255.0


def wquantiles(x: np.ndarray, w: np.ndarray, qs: np.ndarray) -> np.ndarray:
    o = np.argsort(x)
    x = x[o]
    w = w[o]
    c = np.cumsum(w)
    c = c / c[-1]
    return np.interp(qs, c, x)


def lock(new_rgba: np.ndarray, ref_rgba: np.ndarray, kL: float = 0.85, kab: float = 0.8,
         kc: float = 0.7, lift: float = 0.0) -> np.ndarray:
    """Alpha-weighted Lab quantile/mean/spread lock; build supplies its own stronger defaults."""
    labN, aN = lab_of(new_rgba)
    labO, aO = lab_of(ref_rgba)
    mN = aN > 0.5
    mO = aO > 0.5
    qs = np.linspace(0.01, 0.99, 50)
    qN = wquantiles(labN[..., 0][mN], aN[mN], qs)
    qO = wquantiles(labO[..., 0][mO], aO[mO], qs) + lift
    L = labN[..., 0]
    Lm = np.interp(L, qN, qO, left=None, right=None)
    # extrapolate linearly outside the quantile range
    lo = L < qN[0]
    hi = L > qN[-1]
    Lm[lo] = qO[0] + (L[lo] - qN[0])
    Lm[hi] = qO[-1] + (L[hi] - qN[-1])
    out = labN.copy()
    out[..., 0] = np.clip(L + kL * (Lm - L), 0, 100)
    for c in (1, 2):
        muN = np.average(labN[..., c][mN], weights=aN[mN])
        muO = np.average(labO[..., c][mO], weights=aO[mO])
        out[..., c] = labN[..., c] + kab * (muO - muN)
    # chroma spread around the (shifted) mean
    abN = out[..., 1:3]
    mu = np.array([np.average(abN[..., c][mN], weights=aN[mN]) for c in (0, 1)])
    dN = abN[mN] - mu
    muO2 = np.array([np.average(labO[..., c][mO], weights=aO[mO]) for c in (1, 2)])
    dO = labO[..., 1:3][mO] - muO2
    sN = np.sqrt(np.average((dN ** 2).sum(-1), weights=aN[mN]))
    sO = np.sqrt(np.average((dO ** 2).sum(-1), weights=aO[mO]))
    f = 1 + kc * (sO / max(sN, 1e-3) - 1)
    out[..., 1:3] = mu + (abN - mu) * f
    rgb = cv2.cvtColor(out.astype(np.float32), cv2.COLOR_LAB2RGB)
    res = new_rgba.copy()
    res[..., :3] = np.clip(rgb * 255 + 0.5, 0, 255).astype(np.uint8)
    return res


def grade(rgba: np.ndarray, a: float, b: float, k: float = 0.35, chroma: float = 1.0, lift: float = 0.0,
          hue: tuple[float, float] = (75.0, 165.0)) -> np.ndarray:
    """Foliage grade applied after the colour lock: pulls green leaves towards a target Lab colour (a, b).

    The lock keeps each map's original (often olive) mood; this moves only green foliage texels (Lab hue inside `hue`
    degrees, feathered by 15 degrees, and some chroma) a share `k` towards the target's a/b, scales their chroma
    around neutral by `chroma` and lifts lightness by `lift`, so trees can be graded together with a repainted lawn.
    Bark, autumn foliage (rust hues) and near-neutral texels are untouched. Alpha is unchanged.
    """
    lab = to_lab(rgba[..., :3])
    av, bv = lab[..., 1], lab[..., 2]
    h = np.degrees(np.arctan2(bv, av)) % 360
    lo, hi = hue
    w = np.clip((h - (lo - 15)) / 15, 0, 1) * np.clip(((hi + 15) - h) / 15, 0, 1)
    w *= np.clip((np.hypot(av, bv) - 4) / 8, 0, 1)
    out = lab.copy()
    na = av + k * (a - av)
    nb = bv + k * (b - bv)
    out[..., 1] = av + w * (na * chroma - av)
    out[..., 2] = bv + w * (nb * chroma - bv)
    out[..., 0] = np.clip(lab[..., 0] + w * lift, 0, 100)
    rgb = cv2.cvtColor(out.astype(np.float32), cv2.COLOR_LAB2RGB)
    res = rgba.copy()
    res[..., :3] = np.clip(rgb * 255 + 0.5, 0, 255).astype(np.uint8)
    return res


def to_lab(rgb: np.ndarray) -> np.ndarray:
    return cv2.cvtColor(rgb.astype(np.float32) / 255.0, cv2.COLOR_RGB2LAB)


def lab_to_rgb(lab: np.ndarray) -> np.ndarray:
    return np.clip(cv2.cvtColor(lab.astype(np.float32), cv2.COLOR_LAB2RGB) * 255, 0, 255)


def masked_blur(img: np.ndarray, w: np.ndarray, sigma: float) -> tuple[np.ndarray, np.ndarray]:
    num = cv2.GaussianBlur(img * w[..., None], (0, 0), sigma)
    den = cv2.GaussianBlur(w, (0, 0), sigma)
    return num / np.maximum(den, 1e-4)[..., None], den


def densify(rgba: np.ndarray, edge: int = 2, rscale: float = 0.035, shade: float = 0.42, sat: float = 0.8,
            strength: float = 1.0, hole_area: float = 10.0,
            offsets: tuple = ((3, 4), (-4, 3), (5, -3), (-3, -5), (6, 6), (-6, 5))) -> tuple[np.ndarray, dict]:
    """Fill small internal crown gaps with shaded offset foliage; preserve the lacy outer edge."""
    a = rgba[..., 3].astype(np.float32) / 255.0
    C = rgba[..., :3].astype(np.float32)
    solid = (a > 0.3).astype(np.uint8)
    r = max(2, int(round(rscale * math.sqrt(solid.sum()))))
    H, W = a.shape
    pad = r + 2
    s = cv2.copyMakeBorder(solid, pad, pad, pad, pad, cv2.BORDER_CONSTANT, 0)
    closed = cv2.morphologyEx(s, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * r + 1, 2 * r + 1)))
    # enclosed holes are filled only when small (a large hole is a real gap between branches)
    n, lab_, stats, _ = cv2.connectedComponentsWithStats((closed == 0).astype(np.uint8), connectivity=4)
    hull = closed > 0
    for i in range(1, n):
        x, y, w, h, area = stats[i]
        touches = x == 0 or y == 0 or x + w >= closed.shape[1] or y + h >= closed.shape[0]
        if not touches and area <= hole_area * r * r:
            hull |= lab_ == i
    hull = hull[pad:-pad, pad:-pad]
    interior = cv2.erode(hull.astype(np.uint8), cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * edge + 1, 2 * edge + 1))) > 0
    wf = cv2.GaussianBlur(interior.astype(np.float32), (0, 0), 0.8) * interior
    fill = np.clip(wf * (1 - a) * strength, 0, 1)
    # the deeper layer: the crown's own leaves seen through the gap, i.e. offset copies of the art (first one that has
    # foliage at the pixel), then the blurred local colour where none does
    local, _ = masked_blur(C, a, 3.0)
    deep = local.copy()
    got = np.zeros_like(a, bool)
    for dx, dy in offsets:
        M = np.float32([[1, 0, dx], [0, 1, dy]])
        sa = cv2.warpAffine(a, M, (W, H), flags=cv2.INTER_NEAREST, borderValue=0)
        sc = cv2.warpAffine(C, M, (W, H), flags=cv2.INTER_NEAREST, borderValue=0)
        take = (sa > 0.6) & ~got
        deep[take] = sc[take]
        got |= take
    lab = to_lab(deep)
    lab[..., 0] *= shade
    lab[..., 1:] *= sat
    dark = lab_to_rgb(lab)
    ao = a + fill
    prem = C * a[..., None] + dark * fill[..., None]
    out = np.where(ao[..., None] > 1e-4, prem / np.maximum(ao, 1e-4)[..., None], C)
    res = np.dstack([np.clip(out, 0, 255), np.clip(ao, 0, 1) * 255]).round().astype(np.uint8)
    return res, {'r': r, 'filled_px': float(fill.sum()), 'alpha_before': float(a.mean()), 'alpha_after': float(ao.mean())}


def srgb_to_lin(c):
    c = c / 255.0
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def lin_to_srgb(c):
    c = np.clip(c, 0, 1)
    return np.where(c <= 0.0031308, c * 12.92, 1.055 * np.power(c, 1 / 2.4) - 0.055) * 255.0


def penetration(alpha, direction, steps):
    """Sum of alpha along the ray from each pixel towards the light (direction = unit step towards the light)."""
    h, w = alpha.shape
    acc = np.zeros_like(alpha)
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    for k in range(1, steps + 1):
        mx = (xx + direction[0] * k).astype(np.float32)
        my = (yy + direction[1] * k).astype(np.float32)
        acc += cv2.remap(alpha, mx, my, cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT, borderValue=0)
    return acc


def volume(rgba, density=0.09, ambient=0.42, lambert=0.35, bottom_ao=0.25, strength=1.0, sun=(-0.85, -0.45),
           rim=0.10):
    rgb = rgba[..., :3].astype(np.float32)
    a = rgba[..., 3].astype(np.float32) / 255.0
    solid = (a > 0.5).astype(np.float32)
    area = solid.sum()
    if area < 30:
        return rgba
    R = max(4.0, 0.22 * np.sqrt(area / np.pi))
    # smooth crown density (fills leaf gaps: light is blocked by the crown as a volume, not per leaf)
    dens = cv2.GaussianBlur(a, (0, 0), max(1.0, R * 0.25))
    d = np.array(sun, np.float32)
    d /= np.linalg.norm(d)
    steps = int(np.ceil(2.2 * R))
    pen = penetration(dens, d, steps)
    trans = np.exp(-density * pen)
    # dome lambert from the silhouette height field
    H = cv2.GaussianBlur(solid, (0, 0), R)
    gx = cv2.Sobel(H, cv2.CV_32F, 1, 0, ksize=3) / 8.0
    gy = cv2.Sobel(H, cv2.CV_32F, 0, 1, ksize=3) / 8.0
    k = 2.2 * R
    n = np.dstack([-gx * k, -gy * k, np.ones_like(gx)])  # screen: x right, y down, z to viewer
    n /= np.linalg.norm(n, axis=-1, keepdims=True)
    l = np.array([d[0], d[1], 0.9], np.float32)
    l /= np.linalg.norm(l)
    lam = np.clip((n * l).sum(-1), 0, 1)
    # crown-bottom occlusion: lower rows of the crown, deeper inside, are darker
    ys = np.nonzero(solid.any(1))[0]
    y0, y1 = (ys.min(), ys.max()) if len(ys) else (0, a.shape[0] - 1)
    yrel = np.clip((np.arange(a.shape[0], dtype=np.float32) - y0) / max(y1 - y0, 1), 0, 1)[:, None]
    inner = np.clip(H * 2.0, 0, 1)
    ao = 1 - bottom_ao * yrel * inner
    f = (ambient + (1 - ambient) * trans * ((1 - lambert) + lambert * lam)) * ao
    wsum = (a * solid).sum()
    f = f / max((f * a * solid).sum() / max(wsum, 1e-6), 1e-6)
    f = 1 + strength * (f - 1)
    lin = srgb_to_lin(rgb) * f[..., None]
    # sun through thin leaves at the lit edge: a little warm yellow-green gain where transmittance is high
    edge = np.clip(trans * lam, 0, 1) ** 2 * rim * strength
    lin = lin * (1 + edge[..., None] * np.array([0.9, 1.0, 0.2], np.float32))
    out = rgba.copy()
    out[..., :3] = np.clip(lin_to_srgb(lin) + 0.5, 0, 255).astype(np.uint8)
    return out


def nearest_fill(rgb: np.ndarray, known: np.ndarray) -> np.ndarray:
    """Every unknown pixel takes the colour of its nearest known pixel."""
    if known.all() or not known.any():
        return rgb
    src = (~known).astype(np.uint8)
    _, labels = cv2.distanceTransformWithLabels(src, cv2.DIST_L2, 5, labelType=cv2.DIST_LABEL_PIXEL)
    ys, xs = np.nonzero(known)
    # labels of zero pixels are numbered in scan order starting at 1
    lab_of_zero = labels[ys, xs]
    lut = np.zeros((labels.max() + 1, rgb.shape[-1]), rgb.dtype)
    lut[lab_of_zero] = rgb[ys, xs]
    out = lut[labels]
    out[known] = rgb[known]
    return out


def palette_lab(rgb8: np.ndarray) -> np.ndarray:
    """Lab conversion retaining the palette table's or frame's original shape."""
    shp = rgb8.shape
    flat = (rgb8.reshape(1, -1, 3).astype(np.float32) / 255.0)
    return cv2.cvtColor(flat, cv2.COLOR_RGB2LAB).reshape(shp)


# ----------------------------------------------------------------------------- matte and registration


def fit_background(img: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Polynomial surface through cubic terms, fitted to flat-grey-ish pixels of the whole sheet."""
    H, W, _ = img.shape
    lab = to_lab(img)
    chroma = np.hypot(lab[..., 1], lab[..., 2])
    medL = np.median(lab[..., 0])
    mask = (chroma < 5) & (np.abs(lab[..., 0] - medL) < 12)
    yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
    xn, yn = xx / W - 0.5, yy / H - 0.5
    basis = np.stack([np.ones_like(xn), xn, yn, xn * xn, xn * yn, yn * yn, xn ** 3, yn ** 3, xn * xn * yn, xn * yn * yn], -1)
    bg = np.zeros_like(img, np.float32)
    for it in range(4):
        B = basis[mask]
        coef = np.linalg.lstsq(B[::7], img[mask][::7].astype(np.float32), rcond=None)[0]
        bg = basis @ coef
        resid = np.abs(img.astype(np.float32) - bg).max(-1)
        mask = mask & (resid < 8)
    return bg, mask


def matte(img: np.ndarray, bg: np.ndarray, roi_mask: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Soft alpha and unmixed foreground colour against the known background."""
    C = img.astype(np.float32)
    B = bg
    labC = to_lab(np.clip(C, 0, 255))
    labB = to_lab(np.clip(B, 0, 255))
    D = np.linalg.norm(labC - labB, axis=-1)
    sure_fg = (D > 18) & roi_mask
    sure_bg = (D < 3.5) | ~roi_mask
    # foreground colour estimate for the unknown band: normalised blur of the sure-foreground colours
    w = sure_fg.astype(np.float32)
    F = np.zeros_like(C)
    num = np.zeros_like(C)
    den = np.zeros(C.shape[:2], np.float32)
    for s in (1.5, 3, 6, 12):
        n = cv2.GaussianBlur(C * w[..., None], (0, 0), s)
        d = cv2.GaussianBlur(w, (0, 0), s)
        take = (den < 1e-3) & (d > 1e-3)
        num[take] = n[take]
        den[take] = d[take]
    F = num / np.maximum(den, 1e-6)[..., None]
    F[sure_fg] = C[sure_fg]
    diff = F - B
    alpha = ((C - B) * diff).sum(-1) / np.maximum((diff * diff).sum(-1), 25.0)
    alpha = np.clip(alpha, 0, 1)
    alpha[sure_fg] = 1.0
    alpha[sure_bg] = 0.0
    # unmix: C = a F + (1 - a) B
    Fu = B + (C - B) / np.maximum(alpha, 1e-3)[..., None]
    Fu = np.where((alpha > 0.25)[..., None], Fu, F)
    Fu = np.clip(Fu, 0, 255)
    return alpha, Fu, D


def keep_main(alpha: np.ndarray, seed_mask: np.ndarray) -> np.ndarray:
    """Drop matte components that do not touch the dilated original silhouette (specks, stray marks)."""
    lab_n, labels = cv2.connectedComponents((alpha > 0.1).astype(np.uint8), connectivity=8)
    keep = np.zeros(lab_n, bool)
    touched = np.unique(labels[seed_mask & (alpha > 0.1)])
    keep[touched] = True
    keep[0] = False
    return np.where(keep[labels] | (alpha <= 0.1), alpha, 0) * (keep[labels] | (alpha <= 0.1))


def register(src_a: np.ndarray, tgt_a: np.ndarray) -> tuple[float, tuple | None]:
    """Anisotropic scale + translation of src (ROI alpha) onto tgt (placed original alpha, same ROI frame).
    Maximises the cosine similarity of blurred masks. Returns sx, sy, ox, oy (tgt = s * src + o)."""
    tb = cv2.GaussianBlur(tgt_a, (0, 0), 2.0)
    best = (-1, None)
    for sx in np.arange(0.72, 1.121, 0.02):
        for sy in np.arange(0.72, 1.121, 0.02):
            s = cv2.resize(src_a, None, fx=sx, fy=sy, interpolation=cv2.INTER_AREA)
            s = cv2.GaussianBlur(s, (0, 0), 2.0)
            if s.shape[0] >= tb.shape[0] or s.shape[1] >= tb.shape[1]:
                continue
            r = cv2.matchTemplate(tb, s, cv2.TM_CCORR_NORMED)
            _, v, _, loc = cv2.minMaxLoc(r)
            if v > best[0]:
                best = (v, (sx, sy, loc[0], loc[1]))
    return best


def trunk_base(a: np.ndarray, thr: float = 0.5) -> tuple[float, float] | None:
    """Bottom-most opaque row and the x-centre of its opaque run (the trunk's foot)."""
    rows = np.nonzero((a > thr).any(1))[0]
    if len(rows) == 0:
        return None
    y = rows[-1]
    xs = np.nonzero(a[y] > thr)[0]
    return float(xs.mean()), float(y)


# ----------------------------------------------------------------------------- shadow projection


def project(alpha: np.ndarray, fo: tuple | list, so: tuple | list, size: tuple[int, int],
            a: float, b: float, yb: float, cx: float, cy: float) -> np.ndarray:
    """alpha: HxW float (1x, sprite frame); fo: frame offset; so/size: shadow rect offset and (w, h). Returns coverage."""
    H, W = alpha.shape
    sw, sh = size
    cov = np.zeros((sh * SUB, sw * SUB), np.float32)
    ys, xs = np.nonzero(alpha > 0.02)
    if len(xs) == 0:
        return np.zeros((sh, sw), np.float32)
    val = alpha[ys, xs]
    # subsample each pixel
    o = (np.arange(SUB) + 0.5) / SUB
    for dy in o:
        for dx in o:
            x = xs + dx + fo[0]
            y = ys + dy + fo[1]
            h = yb - y
            X = x + a * h + cx - so[0]
            Y = yb - b * h + cy - so[1]
            # the compressed rows: spread each subsample over 1/b rows in its column is unnecessary at SUB=4 when b~0.45
            xi = np.floor(X * SUB).astype(int)
            yi = np.floor(Y * SUB).astype(int)
            ok = (xi >= 0) & (yi >= 0) & (xi < sw * SUB) & (yi < sh * SUB)
            np.maximum.at(cov, (yi[ok], xi[ok]), val[ok])
    # fill vertical sub-row gaps left by the b-compression (b<1 maps several rows onto one, never leaves gaps; but b>1 could)
    return cov.reshape(sh, SUB, sw, SUB).mean(axis=(1, 3))


def iou(p: np.ndarray, s: np.ndarray) -> float:
    inter = (p & s).sum()
    uni = (p | s).sum()
    return inter / max(uni, 1)


def fit(alpha: np.ndarray, fo: tuple | list, S: np.ndarray, so: tuple | list) -> tuple[float, tuple]:
    size = (S.shape[1], S.shape[0])
    best = (-1, None)
    for yb in (-1.0, 0.0, 1.0, 2.0):
        for a in np.arange(0.6, 1.5, 0.05):
            for b in np.arange(0.25, 0.7, 0.03):
                p = project(alpha, fo, so, size, a, b, yb, 0, 0) > 0.3
                v = iou(p, S)
                if v > best[0]:
                    best = (v, (a, b, yb))
    a, b, yb = best[1]
    best2 = best
    for a2 in np.arange(a - 0.05, a + 0.051, 0.01):
        for b2 in np.arange(b - 0.03, b + 0.031, 0.006):
            for cx in (-1, 0, 1):
                for cy in (-1, 0, 1):
                    p = project(alpha, fo, so, size, a2, b2, yb, cx, cy) > 0.3
                    v = iou(p, S)
                    if v > best2[0]:
                        best2 = (v, (a2, b2, yb, cx, cy))
    if len(best2[1]) == 3:
        best2 = (best2[0], best2[1] + (0, 0))
    return best2


def delta_shadow(original: np.ndarray, new_alpha: np.ndarray, original_alpha: np.ndarray,
                 frame_offset: list[int], shadow_offset: list[int], params: list[float]
                 ) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Return soft delta-transferred coverage and the new/original projections (before Bayer dithering)."""
    size = (original.shape[1], original.shape[0])
    pn = project(new_alpha, frame_offset, shadow_offset, size, *params)
    po = project(original_alpha, frame_offset, shadow_offset, size, *params)
    return np.clip(original + pn - po, 0, 1), pn, po


def dither_shadow(coverage: np.ndarray, x: int, y: int) -> np.ndarray:
    """Binary indexed RGBA shadow, with the Bayer phase anchored to the atlas rectangle."""
    h, w = coverage.shape
    yy, xx = np.mgrid[0:h, 0:w]
    thr = BAYER[(yy + y) % 4, (xx + x) % 4]
    mask = coverage > thr
    one = np.zeros((h, w, 4), np.uint8)
    one[..., 0] = np.where(mask, 1, 0)
    one[..., 3] = np.where(mask, 255, 0)
    return one


# ----------------------------------------------------------------------------- extract and prepare


def extract(cache_root: Path, map_name: str, orig_dir: Path) -> None:
    """Extract each tree's first colour frame and first shadow, leaving the map cache read-only."""
    directory = cache_root / map_name
    man = read_json(directory / 'manifest.json')
    idx = read_image(directory / 'sprites.png')[..., 0]
    hd = read_image(directory / 'sprites@2x.png')
    pals = {k: read_image(directory / v)[0] for k, v in man['palettes'].items()}
    orig_dir.mkdir(parents=True, exist_ok=True)
    for key, sprite in man['sprites'].items():
        if not key.startswith('tree:'):
            continue
        tree = key.split(':')[1]
        pal = pals[sprite['palette']]
        for fi, frame in enumerate(sprite['frames'][:1]):
            x, y, w, h = frame['rect']
            ix = idx[y:y + h, x:x + w]
            rgb = pal[ix]
            a = (ix > 0).astype(np.uint8) * 255
            Image.fromarray(np.dstack([rgb, a])).save(orig_dir / f'{map_name}_{tree}_f{fi}_1x.png')
            Image.fromarray(hd[2 * y:2 * y + 2 * h, 2 * x:2 * x + 2 * w]).save(
                orig_dir / f'{map_name}_{tree}_f{fi}_2x.png')
        for fi, frame in enumerate(sprite.get('shadows', [])[:1]):
            x, y, w, h = frame['rect']
            ix = idx[y:y + h, x:x + w]
            Image.fromarray(((ix > 0) * 255).astype(np.uint8)).save(orig_dir / f'{map_name}_{tree}_s{fi}_1x.png')
        print(map_name, tree, 'extracted', flush=True)


PROMPT_TEMPLATE = """Task: image editing only. Do not write code other than what is needed to save/resize/copy the image. Do not browse the web.

In this directory there is input.png (1536x1024 pixels): a sprite sheet of {n} separate trees/bushes from the classic isometric real-time-strategy game Red Alert 2 (2000), enlarged from low-resolution pixel art. Each stands alone on a flat grey RGB(118,118,118) background. Rows (left to right): {rowtxt}.
{lines}

Use your image generation / image editing tool with input.png as the reference image to redraw ALL {n} of them together in ONE image, as the vegetation assets of a realistic modern remaster of this game (the look of a current high-end engine: photoreal foliage, physically based materials, crisp high-resolution detail). Realistic and grounded, NOT cartoon, NOT painterly, NOT toy-like, NOT stylised.

LAYOUT LOCK (most important):
- exactly the same {n} plants, each at exactly the same position and the same size on the sheet; the bottom of every trunk (where it meets the ground) stays on the same pixel;
- the same silhouette, proportions and lean for each plant (small local variations along the leafy edge are fine), the same species, the same trunk and main-branch structure;
- the same viewpoint: seen from about 30 degrees above, orthographic, like the input.

LOOK:
- foliage built from many small, individually readable leaves grouped into clusters with real depth: sunlit clusters on the upper left, darker shaded interior and undersides, soft ambient occlusion deep inside the crown, a little translucent yellow-green light where sunlight passes through the leaves at the sunlit edge, and small gaps through the crown where the background shows through;
- realistic bark on trunks and visible branches, darker near the ground;
- sharp, clean detail at pixel level, like a high-resolution game texture: no blur, no brush strokes, no outline, no halo;
- sun from the upper left, neutral afternoon daylight; keep each plant's own colour family (olive/yellow-green, dark green, autumn rust as described), just richer and more natural.

BACKGROUND:
- keep the background perfectly flat uniform grey RGB(118,118,118) everywhere around the plants AND inside every gap of the foliage: no ground, no grass, no soil, no cast shadow, no drop shadow, no glow, no vignette, no texture, no frame, no text, no labels, no numbers.

Save the result as output.png in this directory with exactly 1536x1024 pixels (if the tool returns another size, resize the whole image to 1536x1024; keep everything visible, never crop). Also copy the raw generated image, unchanged, to output_raw.png in this directory. Then reply with one line saying the tool used and the generated size.
"""


REFINE_TEMPLATE = """Task: image editing only. Do not write code other than what is needed to save/resize/copy the image. Do not browse the web.

In this directory there is input.png (1536x1024 pixels): a sprite sheet of {n} separate trees/bushes, already redrawn once as realistic vegetation assets for a modern remaster of the classic isometric real-time-strategy game Red Alert 2. Each stands alone on a flat grey RGB(118,118,118) background. Rows (left to right): {rowtxt}.
{lines}

Use your image generation / image editing tool with input.png as the reference image and produce an IMPROVED version of the SAME {n} plants in ONE image. In the game they are shown at about ONE THIRD of this size, so right now they read as flat, uniformly lit leaf noise. Make them read as solid three-dimensional trees, like foliage rendered by a high-end modern 3D game engine (raytraced lighting, subsurface light through leaves), realistic and grounded, NOT cartoon, NOT painterly, NOT stylised:
- group the foliage into distinct, rounded leaf clumps (each clump several leaves deep) with STRONG light and shade per clump: the sunlit top and upper-left faces of each clump bright and warm, their undersides and the lower-right side of the crown clearly darker and cooler green, deep dark ambient occlusion inside the crown and under the clumps;
- a few spots of translucent light (brighter yellow-green) where sun passes through thin leaves at the sunlit edge;
- visible realistic bark on the trunk and main branches, lit on the left, dark on the right, darker near the ground;
- natural, slightly deeper and less yellow greens than the input (keep each plant's own colour family: willows and poplars stay yellow-green/olive, the dark-green trees and bushes stay dark green, autumn trees keep their rust/khaki colours, red fruits and red young leaves stay);
- crisp high-resolution detail: no blur, no brush strokes, no outline, no halo.

LAYOUT LOCK (most important): exactly the same {n} plants at exactly the same position and size on the sheet, the bottom of every trunk on the same pixel; the same silhouette, proportions, lean, species, trunk and main-branch structure (small local variations along the leafy edge are fine); the same viewpoint (seen from about 30 degrees above, orthographic).

BACKGROUND: keep the background perfectly flat uniform grey RGB(118,118,118) everywhere around the plants AND inside every gap of the foliage: no ground, no grass, no cast shadow, no drop shadow, no glow, no vignette, no texture, no frame, no text, no labels, no numbers.

Save the result as output.png in this directory with exactly 1536x1024 pixels (if the tool returns another size, resize the whole image to 1536x1024; keep everything visible, never crop). Also copy the raw generated image, unchanged, to output_raw.png in this directory. Then reply with one line saying the tool used and the generated size.
"""


def sheet(spec: dict, map_name: str, orig_dir: Path, name: str, out: Path, scale: float = 5.0,
          refine_from: Path | None = None) -> None:
    if not math.isfinite(scale) or scale <= 0:
        raise ValueError('scale must be positive and finite')
    refined = read_image(refine_from, 'RGB') if refine_from is not None else None
    if refined is not None and refined.shape[:2] != SHEET_SIZE[::-1]:
        raise ValueError('--refine-from image must be exactly 1536x1024 pixels with the same layout')
    out.mkdir(parents=True, exist_ok=True)
    sheet = np.full((*SHEET_SIZE[::-1], 3), BG, np.float32)
    layout = {'scale': scale, 'size': list(SHEET_SIZE), 'trees': {}}
    rows = spec['sheets'][name]
    y0 = 0
    order = []
    for row in rows:
        x0 = 0
        for tree, cw in row:
            im = read_image(orig_dir / f'{map_name}_{tree}_f0_2x.png', 'RGBA')
            w1, h1 = im.shape[1] // 2, im.shape[0] // 2
            W, H = round(w1 * scale), round(h1 * scale)
            if W > cw or H > ROW_HEIGHT or W < 1 or H < 1:
                raise ValueError(f'{tree}: scaled frame does not fit its sheet cell')
            px = x0 + (cw - W) // 2
            py = y0 + (ROW_HEIGHT - H) // 2
            if refined is None:
                # premultiplied resize so the grey composite has no dark/pale fringes
                a = np.asarray(im, np.float32) / 255.0
                pm = np.dstack([a[..., :3] * a[..., 3:], a[..., 3:]])
                big = np.dstack([np.asarray(Image.fromarray((pm[..., c] * 255).astype(np.float32), 'F').resize(
                    (W, H), Image.LANCZOS)) for c in range(4)]) / 255.0
                big = np.clip(big, 0, 1)
                region = sheet[py:py + H, px:px + W]
                region[:] = big[..., :3] * 255 + region * (1 - big[..., 3:])
            layout['trees'][tree] = {'box': [px, py, W, H], 'frame1x': [w1, h1]}
            order.append(tree)
            x0 += cw
        y0 += ROW_HEIGHT
    pixels = refined if refined is not None else np.clip(sheet + 0.5, 0, 255).astype(np.uint8)
    Image.fromarray(pixels).save(out / 'input.png')
    write_json(layout, out / 'layout.json')
    n = len(order)
    lines = '\n'.join(f"{i + 1}. {spec['descriptions'][t]}" for i, t in enumerate(order))
    rowtxt = ' / '.join(', '.join(str(1 + order.index(t)) for t, _ in row) for row in rows)
    template = REFINE_TEMPLATE if refined is not None else PROMPT_TEMPLATE
    prompt = template.format(n=n, rowtxt=rowtxt, lines=lines)

    (out / 'prompt.txt').write_text(prompt)
    print(out, order)


def placed_alpha(orig_dir: Path, map_name: str, tree: str, box: list[int]) -> np.ndarray:
    im = read_image(orig_dir / f'{map_name}_{tree}_f0_2x.png', 'RGBA')
    a = np.asarray(im, np.float32)[..., 3] / 255.0
    return cv2.resize(a, (box[2], box[3]), interpolation=cv2.INTER_LINEAR)


def process(gdir: Path, src_name: str, out: Path, orig_dir: Path, map_name: str) -> None:
    out.mkdir(parents=True, exist_ok=True)
    layout = read_json(gdir / 'layout.json')
    img = read_image(gdir / src_name, 'RGB')
    if img.shape[:2] != SHEET_SIZE[::-1]:
        img = np.asarray(Image.fromarray(img).resize(SHEET_SIZE, Image.LANCZOS))
    bg, bgmask = fit_background(img)
    report = {'source': str(gdir / src_name), 'bg_resid': float(np.abs(img[bgmask] - bg[bgmask]).mean()), 'trees': {}}
    for tree, info in layout['trees'].items():
        px, py, W, H = info['box']
        w1, h1 = info['frame1x']
        # ROI: the placed box grown by 45 % on each side (the model tends to enlarge and drift)
        mx, my = int(W * 0.45) + 20, int(H * 0.45) + 20
        x0, y0 = max(0, px - mx), max(0, py - my)
        x1, y1 = min(SHEET_SIZE[0], px + W + mx), min(SHEET_SIZE[1], py + H + my)
        roi = img[y0:y1, x0:x1]
        broi = bg[y0:y1, x0:x1]
        tgt = np.zeros((y1 - y0, x1 - x0), np.float32)
        tgt[py - y0:py - y0 + H, px - x0:px - x0 + W] = placed_alpha(orig_dir, map_name, tree, info['box'])
        # the plant may only live near the original: the target grown by 35 % of its size
        k = int(max(W, H) * 0.35) | 1
        roi_mask = cv2.dilate((tgt > 0.05).astype(np.uint8), cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k, k))) > 0
        # bigger allowance because the model enlarges: scale the dilated mask about the box centre by 1.25
        cx, cy = px - x0 + W / 2, py - y0 + H / 2
        Mz = np.float32([[1.25, 0, cx * (1 - 1.25)], [0, 1.25, cy * (1 - 1.25)]])
        roi_mask = roi_mask | (cv2.warpAffine(roi_mask.astype(np.uint8), Mz, roi_mask.shape[::-1]) > 0)
        alpha, F, D = matte(roi, broi, roi_mask)
        alpha = keep_main(alpha, roi_mask)
        v, (sx, sy, ox, oy) = register(alpha, tgt)
        # resample: premultiplied RGBA scaled by (sx, sy), placed at (ox, oy) in ROI coords, cropped to the box
        pm = np.dstack([F * alpha[..., None], alpha * 255.0]).astype(np.float32)
        scaled = cv2.resize(pm, None, fx=sx, fy=sy, interpolation=cv2.INTER_AREA)
        canvas = np.zeros((y1 - y0, x1 - x0, 4), np.float32)
        hh = min(scaled.shape[0], canvas.shape[0] - oy)
        ww = min(scaled.shape[1], canvas.shape[1] - ox)
        canvas[oy:oy + hh, ox:ox + ww] = scaled[:hh, :ww]
        full_alpha = canvas[..., 3].sum()
        box5 = canvas[py - y0:py - y0 + H, px - x0:px - x0 + W]
        clipped = 1 - box5[..., 3].sum() / max(full_alpha, 1)
        # exact 5x frame -> 2x frame (area)
        f2 = cv2.resize(box5, (2 * w1, 2 * h1), interpolation=cv2.INTER_AREA)
        a2 = np.clip(f2[..., 3] / 255.0, 0, 1)
        rgb2 = np.where(a2[..., None] > 1e-4, f2[..., :3] / np.maximum(a2, 1e-4)[..., None], 0)
        rgba2 = np.dstack([np.clip(rgb2, 0, 255), a2 * 255]).astype(np.uint8)
        Image.fromarray(rgba2).save(out / f'{tree}_2x.png')
        a5 = box5[..., 3] / 255.0
        rgb5 = np.where(a5[..., None] > 1e-4, box5[..., :3] / np.maximum(a5, 1e-4)[..., None], 0)
        Image.fromarray(np.dstack([np.clip(rgb5, 0, 255), a5 * 255]).astype(np.uint8)).save(out / f'{tree}_5x.png')
        # debug: matte
        Image.fromarray((alpha * 255).astype(np.uint8)).save(out / f'{tree}_matte.png')
        tb = trunk_base(tgt[py - y0:py - y0 + H, px - x0:px - x0 + W])
        nb = trunk_base(a5)
        orig_a = cv2.resize(tgt[py - y0:py - y0 + H, px - x0:px - x0 + W], (2 * w1, 2 * h1), interpolation=cv2.INTER_AREA)
        iou = ((a2 > 0.5) & (orig_a > 0.5)).sum() / max(((a2 > 0.5) | (orig_a > 0.5)).sum(), 1)
        report['trees'][tree] = {
            'ncc': round(float(v), 4), 'sx': round(float(sx), 3), 'sy': round(float(sy), 3), 'clipped': round(float(clipped), 4),
            'iou2x': round(float(iou), 3), 'coverage_new': round(float(a2.mean()), 3), 'coverage_orig': round(float(orig_a.mean()), 3),
            'trunk_base_orig_5x': tb, 'trunk_base_new_5x': nb,
        }
        print(tree, report['trees'][tree], flush=True)
    write_json(report, out / 'reg.json')


def fit_shadows(cache_root: Path, map_name: str, orig_dir: Path, work_dir: Path, spec: dict) -> None:
    """Fit selected trees present in the reference map; reuse the fit for other maps of the same art."""
    man = read_json(cache_root / map_name / 'manifest.json')
    result = {}
    for tree in sorted(spec['selection']):
        sprite = man['sprites'].get(f'tree:{tree}')
        if sprite is None:
            continue
        if not all(sprite['shadows'][0]['rect'][2:]):
            result[tree] = {'state': 'empty_original_shadow_preserved', 'iou': None, 'params': None}
            continue
        alpha = read_image(orig_dir / f'{map_name}_{tree}_f0_1x.png')[..., 3] / 255.0
        shadow = read_image(orig_dir / f'{map_name}_{tree}_s0_1x.png') > 0
        score, params = fit(alpha, sprite['frames'][0]['offset'], shadow, sprite['shadows'][0]['offset'])
        result[tree] = {'iou': round(float(score), 3), 'params': [round(float(x), 3) for x in params]}
        print(tree, result[tree], flush=True)
    work_dir.mkdir(parents=True, exist_ok=True)
    write_json(result, work_dir / 'shadow_fit.json')


# ----------------------------------------------------------------------------- build and shadow patches


def build(cache_root: Path, map_name: str, orig_dir: Path, proc_dir: Path, patch_dir: Path,
          spec: dict, kL: float = 1.0, cfg: dict | None = None) -> None:
    cfg = cfg or {}
    unknown = cfg.keys() - {'ref', 'kab', 'kc', 'lift', 'densify', 'volume', 'kL', 'grade'}
    if unknown:
        raise ValueError(f'unknown --cfg keys: {sorted(unknown)}')
    ref_kind = cfg.get('ref', REF)
    if ref_kind not in ('1x', '2x'):
        raise ValueError('cfg.ref must be 1x or 2x')
    kab, kc, lift = cfg.get('kab', KAB), cfg.get('kc', KC), cfg.get('lift', LIFT)
    density = cfg.get('densify', DENSIFY)
    volume_kwargs = cfg.get('volume', VOLUME)
    if volume_kwargs is not None and not isinstance(volume_kwargs, dict):
        raise ValueError('cfg.volume must be an object or null')
    kL = cfg.get('kL', kL)
    grade_kwargs = cfg.get('grade')
    if grade_kwargs is not None and not isinstance(grade_kwargs, dict):
        raise ValueError('cfg.grade must be an object or null')
    man = read_json(cache_root / map_name / 'manifest.json')
    idx = read_image(cache_root / map_name / 'sprites.png')[..., 0]
    pal = read_image(cache_root / map_name / man['palettes']['iso'])[0].astype(np.uint8)
    used = set()
    for key, s in man['sprites'].items():
        if key.startswith('tree:TREE'):
            x, y, w, h = s['frames'][0]['rect']
            used |= set(np.unique(idx[y:y + h, x:x + w]).tolist())
    cand = np.array(sorted(i for i in used if i != 0 and not 16 <= i <= 31))
    cand_lab = palette_lab(pal[cand])
    out = patch_dir / map_name
    out.mkdir(parents=True, exist_ok=True)
    sel = spec['selection']
    report = {}
    for tree, src in sel.items():
        key = f'tree:{tree}'
        if key not in man['sprites']:
            continue
        x, y, w, h = man['sprites'][key]['frames'][0]['rect']
        new = read_image(proc_dir / src / f'{tree}_2x.png', 'RGBA')
        if new.shape[:2] != (2 * h, 2 * w):
            raise ValueError(f'{tree}: processed shape {new.shape[:2]} differs from {(2 * h, 2 * w)}')
        ref = read_image(orig_dir / f'{map_name}_{tree}_f0_{ref_kind}.png', 'RGBA')
        dens = None
        if density:
            new, dens = densify(new, **density)
        if volume_kwargs is not None:
            new = volume(new, **volume_kwargs)
        new = lock(new, ref, kL=kL, kab=kab, kc=kc, lift=lift)
        if grade_kwargs:
            new = grade(new, **grade_kwargs)
        a2 = new[..., 3].astype(np.float32) / 255.0
        a2[a2 < 8 / 255] = 0
        rgb = new[..., :3].copy()
        rgb = nearest_fill(rgb, a2 > 0.35)
        hd = np.dstack([rgb, np.round(a2 * 255).astype(np.uint8)])
        Image.fromarray(hd).save(out / f'{tree}_2x.png')
        # 1x mask and colours
        a1 = a2.reshape(h, 2, w, 2).mean(axis=(1, 3))
        core = a1 > 0.08
        mask = cv2.dilate(core.astype(np.uint8), np.ones((3, 3), np.uint8)) > 0
        pm = (rgb.astype(np.float32) * a2[..., None]).reshape(h, 2, w, 2, 3).sum(axis=(1, 3))
        wsum = a2.reshape(h, 2, w, 2).sum(axis=(1, 3))
        mean = pm / np.maximum(wsum, 1e-4)[..., None]
        mean = nearest_fill(mean, wsum > 0.3)
        lab = palette_lab(np.clip(mean, 0, 255).astype(np.uint8))
        d = ((lab[:, :, None, :] - cand_lab[None, None]) ** 2).sum(-1)
        ind = cand[d.argmin(-1)].astype(np.uint8)
        ind[~mask] = 0
        one = np.zeros((h, w, 4), np.uint8)
        one[..., 0] = ind
        one[..., 3] = np.where(ind > 0, 255, 0)
        Image.fromarray(one).save(out / f'{tree}_1x.png')
        orig_mask = idx[y:y + h, x:x + w] > 0
        report[tree] = {
            'src': src, 'rect': [x, y, w, h],
            'mask1x_px': int(mask.sum()), 'orig1x_px': int(orig_mask.sum()),
            'iou_mask_vs_orig': round(float((mask & orig_mask).sum() / max((mask | orig_mask).sum(), 1)), 3),
            'hd_alpha_mean': round(float(a2.mean()), 3), 'densify': dens, 'volume': volume_kwargs,
            'grade': grade_kwargs,
        }
        print(map_name, tree, report[tree], flush=True)
    write_json(report, out / 'build.json')


def shadows(cache_root: Path, map_name: str, patch_dir: Path, fit_path: Path) -> None:
    man = read_json(cache_root / map_name / 'manifest.json')
    idx = read_image(cache_root / map_name / 'sprites.png')[..., 0]
    fitted = read_json(fit_path)
    patch = patch_dir / map_name
    report = {}
    for p in sorted(patch.glob('TREE*_2x.png')):
        tree = p.stem.removesuffix('_2x')
        s = man['sprites'][f'tree:{tree}']
        f = s['frames'][0]
        sh = s['shadows'][0]
        if not all(sh['rect'][2:]):
            report[tree] = {'state': 'empty_original_shadow_preserved', 'rect': sh['rect']}
            continue
        x, y, w, h = f['rect']
        a_orig = (idx[y:y + h, x:x + w] > 0).astype(np.float32)
        new2 = read_image(p, 'RGBA')[..., 3].astype(np.float32) / 255.0
        a_new = new2.reshape(h, 2, w, 2).mean(axis=(1, 3))
        sx, sy, sw, shh = sh['rect']
        S = (idx[sy:sy + shh, sx:sx + sw] > 0).astype(np.float32)
        Snew, Pn, Po = delta_shadow(S, a_new, a_orig, f['offset'], sh['offset'], fitted[tree]['params'])
        one = dither_shadow(Snew, sx, sy)
        mask = one[..., 0] > 0
        Image.fromarray(one).save(patch / f'{tree}_s1x.png')
        report[tree] = {'rect': [sx, sy, sw, shh], 'orig_px': int(S.sum()), 'new_soft': round(float(Snew.sum()), 1),
                        'new_px': int(mask.sum()), 'added': round(float(np.clip(Pn - Po, 0, 1).sum()), 1),
                        'removed': round(float(np.clip(Po - Pn, 0, 1).sum()), 1)}
        print(map_name, tree, report[tree], flush=True)
    write_json(report, patch / 'shadows.json')


# ----------------------------------------------------------------------------- variant cache application


def atomic_save(arr: np.ndarray, path: Path) -> None:
    """Write a regular PNG and atomically replace the target entry (never follow its symlink)."""
    with tempfile.NamedTemporaryFile(dir=path.parent, suffix='.tmp-trees.png', delete=False) as stream:
        tmp = Path(stream.name)
    try:
        Image.fromarray(arr).save(tmp)
        os.replace(tmp, path)
    finally:
        tmp.unlink(missing_ok=True)


def ensure_farm(variant: Path, base: Path) -> None:
    base = base.resolve()
    if variant.resolve() == base:
        raise ValueError('variant must be different from the read-only base cache')
    variant.mkdir(parents=True, exist_ok=True)
    for entry in base.iterdir():
        target = variant / entry.name
        if not target.exists() and not target.is_symlink():
            target.symlink_to(entry.resolve() if entry.is_symlink() else entry)


def load_target(variant: Path, name: str) -> tuple[Path, np.ndarray]:
    path = variant / name
    return path, read_image(path)


def apply(map_name: str, variant: Path, base: Path, patch_dir: Path, with_normals: bool = False) -> None:
    ensure_farm(variant, base)
    man = read_json(variant / 'manifest.json')
    patch = patch_dir / map_name
    build_info = read_json(patch / 'build.json')
    p2, hd = load_target(variant, 'sprites@2x.png')
    p1, one = load_target(variant, 'sprites.png')
    normals = None
    if with_normals and (variant / 'normals.json').exists():
        import sprite_normals as sn
        pn, normals = load_target(variant, 'sprites@2x-normals.png')
        normals = normals.copy()
    frames = []
    for tree, info in build_info.items():
        x, y, w, h = man['sprites'][f'tree:{tree}']['frames'][0]['rect']
        if [x, y, w, h] != info['rect']:
            raise ValueError(f'{tree}: patch rectangle differs from the variant manifest')
        n2 = read_image(patch / f'{tree}_2x.png', 'RGBA')
        n1 = read_image(patch / f'{tree}_1x.png', 'RGBA')
        if n2.shape[:2] != (2 * h, 2 * w) or n1.shape[:2] != (h, w):
            raise ValueError(f'{tree}: patch dimensions differ from the variant manifest')
        hd[2 * y:2 * y + 2 * h, 2 * x:2 * x + 2 * w] = n2
        one[y:y + h, x:x + w] = n1
        shadow_rect = None
        if (patch / f'{tree}_s1x.png').exists():
            sx_, sy_, sw_, sh_ = man['sprites'][f'tree:{tree}']['shadows'][0]['rect']
            s1 = read_image(patch / f'{tree}_s1x.png', 'RGBA')
            if s1.shape[:2] != (sh_, sw_):
                raise ValueError(f'{tree}: shadow dimensions differ from the variant manifest')
            one[sy_:sy_ + sh_, sx_:sx_ + sw_] = s1
            shadow_rect = [sx_, sy_, sw_, sh_]
        if normals is not None:
            rgb = n2[..., :3].astype(np.float32) / 255.0
            cov = np.repeat(np.repeat(n1[..., 0] > 0, 2, 0), 2, 1)
            alpha = np.where(cov, n2[..., 3].astype(np.float32) / 255.0, 0.0)
            normal, spec, ao = sn.tree_material(rgb, alpha)
            known = alpha > 0.5
            packed = np.concatenate([normal[..., [0, 2]], spec[..., None], np.clip(ao, sn.AO_FLOOR, 1)[..., None]], -1)
            packed = sn.dilate_fill(packed, known, steps=12)
            packed[~known & ~(sn.dilate_mask(known, 12))] = packed[known].mean(0)
            enc = np.stack([packed[..., 0] * 0.5 + 0.5, packed[..., 1] * 0.5 + 0.5, np.clip(packed[..., 2], 0, 1),
                            np.clip(packed[..., 3], sn.AO_FLOOR, 1)], -1)
            normals[2 * y:2 * y + 2 * h, 2 * x:2 * x + 2 * w] = np.round(enc * 255).astype(np.uint8)
        frames.append({'sprite': f'tree:{tree}', 'frame': 0, 'rect1x': [x, y, w, h], 'rect2x': [2 * x, 2 * y, 2 * w, 2 * h],
                       'files': ['sprites@2x.png', 'sprites.png'] + (['sprites@2x-normals.png'] if normals is not None else []),
                       'source': info['src'], 'shadow_rect1x': shadow_rect})
    for p, arr in ((p2, hd), (p1, one)):
        atomic_save(arr, p)
    if normals is not None:
        atomic_save(normals, pn)
    write_json({'track': 'trees', 'patch_dir': str(patch), 'frames': frames}, variant / 'l3_frames_trees.json')
    print('applied', len(frames), 'trees to', variant)


# -------------------------------------------------------------------------------- command line
def json_object(value: str) -> dict:
    try:
        result = json.loads(value)
    except json.JSONDecodeError as exc:
        raise argparse.ArgumentTypeError(f'invalid JSON: {exc}') from exc
    if not isinstance(result, dict):
        raise argparse.ArgumentTypeError('--cfg must be a JSON object')
    return result


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    commands = parser.add_subparsers(dest='command', required=True)

    def map_arg(p: argparse.ArgumentParser, cache: bool = False) -> None:
        p.add_argument('--map', required=True, dest='map_name', help='map cache name (or sheet reference map)')
        if cache:
            p.add_argument('--cache-root', type=Path, required=True, help='read-only root containing map caches')

    def path_arg(p: argparse.ArgumentParser, flag: str, help_text: str) -> None:
        p.add_argument(flag, type=Path, required=True, help=help_text)

    def spec_arg(p: argparse.ArgumentParser) -> None:
        path_arg(p, '--spec', 'JSON with sheets, descriptions and processed-source selection')

    p = commands.add_parser('extract', help='extract frame 0 and shadow 0 from one map cache')
    map_arg(p, cache=True)
    path_arg(p, '--orig-dir', 'output directory for MAP_TREE_f0_* and MAP_TREE_s0_1x.png')

    p = commands.add_parser('sheet', help='prepare an input sheet, layout.json and prompt.txt')
    map_arg(p)
    spec_arg(p)
    path_arg(p, '--orig-dir', 'directory of extracted original frames')
    path_arg(p, '--work-dir', 'output directory for this sheet/model attempt')
    p.add_argument('--sheet', required=True, help='sheet name in spec.sheets')
    p.add_argument('--scale', type=float, default=5.0, help='enlargement relative to 1x frames (default: 5.0)')
    p.add_argument('--refine-from', type=Path, metavar='IMAGE',
                   help='previous model sheet with the same layout; must be 1536x1024; copied as RGB with a refinement prompt')

    p = commands.add_parser('process', help='matte/register a generated sheet and resample to 2x frames')
    map_arg(p)
    path_arg(p, '--orig-dir', 'directory of extracted original frames for the sheet reference map')
    path_arg(p, '--gen-dir', 'input directory containing layout.json and the generated image')
    p.add_argument('--image', required=True, help='generated image path, relative to --gen-dir or absolute')
    path_arg(p, '--work-dir', 'output processed-source directory (PROC/SOURCE)')

    p = commands.add_parser('fit-shadows', help='fit billboard parameters against original shadow frames')
    map_arg(p, cache=True)
    spec_arg(p)
    path_arg(p, '--orig-dir', 'directory of extracted original frames and shadow masks')
    path_arg(p, '--work-dir', 'output directory for shadow_fit.json')

    p = commands.add_parser('build', help='densify, volume-shade and colour-lock selected art into 2x/1x patches',
                            description='Build in order: densify -> volume -> colour lock; record volume kwargs per tree in build.json.')
    map_arg(p, cache=True)
    spec_arg(p)
    path_arg(p, '--orig-dir', 'directory of extracted original frames for this destination map')
    path_arg(p, '--proc-dir', 'root containing processed-source directories from spec.selection')
    path_arg(p, '--patch-dir', 'patch root; writes into PATCH/MAP')
    p.add_argument('--kL', type=float, default=1.0, help='lightness quantile lock strength (default: 1.0)')
    p.add_argument('--cfg', type=json_object,
                   help='JSON overrides: ref, kL, kab, kc, lift, densify, volume. Absent volume uses '
                        '{"strength":1.3,"density":0.1}; null disables it; a dict supplies volume() kwargs '
                        '({} uses function defaults).')

    p = commands.add_parser('shadows', help='delta-transfer fitted shadows and Bayer-dither to 1x masks')
    map_arg(p, cache=True)
    path_arg(p, '--patch-dir', 'patch root; reads/writes PATCH/MAP')
    path_arg(p, '--fit', 'input shadow_fit.json (may be shared across maps of the same art)')

    p = commands.add_parser('apply', help='paste patches into a variant cache without writing through symlinks')
    map_arg(p)
    path_arg(p, '--patch-dir', 'patch root containing MAP/build.json and its patches')
    path_arg(p, '--variant-dir', 'destination map cache directory (not a root containing maps)')
    base = p.add_mutually_exclusive_group(required=True)
    base.add_argument('--base', type=Path, help='read-only base map directory')
    base.add_argument('--cache-root', type=Path, help='select CACHE/MAP as the read-only base')
    p.add_argument('--normals', action='store_true', help='also patch materials when normals.json exists')
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        spec = load_spec(args.spec) if hasattr(args, 'spec') else None
        if args.command == 'extract':
            extract(args.cache_root, args.map_name, args.orig_dir)
        elif args.command == 'sheet':
            if args.sheet not in spec['sheets']:
                raise ValueError(f'unknown sheet: {args.sheet!r}')
            sheet(spec, args.map_name, args.orig_dir, args.sheet, args.work_dir, args.scale, args.refine_from)
        elif args.command == 'process':
            process(args.gen_dir, args.image, args.work_dir, args.orig_dir, args.map_name)
        elif args.command == 'fit-shadows':
            fit_shadows(args.cache_root, args.map_name, args.orig_dir, args.work_dir, spec)
        elif args.command == 'build':
            build(args.cache_root, args.map_name, args.orig_dir, args.proc_dir, args.patch_dir, spec, args.kL, args.cfg)
        elif args.command == 'shadows':
            shadows(args.cache_root, args.map_name, args.patch_dir, args.fit)
        elif args.command == 'apply':
            base = args.base if args.base is not None else args.cache_root / args.map_name
            apply(args.map_name, args.variant_dir, base, args.patch_dir, args.normals)
    except (ValueError, OSError) as exc:
        parser.exit(1, f'{args.command}: {exc}\n')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
