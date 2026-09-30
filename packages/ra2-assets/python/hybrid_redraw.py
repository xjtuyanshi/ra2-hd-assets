#!/usr/bin/env python3
"""Hybrid per-object redraw of HD sprite frames: an external image model redraws each frame, automatic checks decide.

The faithful tool (redetail_sprites.py) keeps the original's structure by construction but cannot add crisp new
surface design (window frames, glass, masonry). This tool lets an image-editing model redraw one object frame at a
time from its 4x Real-ESRGAN upscale, then forces the result back onto the original frame and measures how faithful
it stayed:

* registration: the redraw is fitted to the model input with an axis-aligned scale + translation (Gauss-Newton on
  blurred luminance with a gain/offset term, coarse to fine) and resampled from the model's full-size image in
  linear light, so the model's framing drift never reaches the atlas;
* the 2x frame is a linear-light box downsample; its alpha is the HD atlas's alpha, copied bit for bit;
* colour: low frequencies (sigma_l / sigma_ab at 2x) come from the original art in CIE Lab, higher frequencies from
  the redraw, so the colour mood is the original's while edges and materials are the redraw's;
* house paint is re-encoded on the renderer's grey ramp exactly as redetail_sprites.compose does;
* checks against the original art: coarse edge structure (global and per tile), facade grid (projection profiles
  along the two isometric facade directions and the vertical), internal structural edges (recall/precision),
  low-frequency colour difference, and model content outside the silhouette. A failing frame is redrawn with a
  prompt that names what failed; after the retry budget it falls back to the faithful atlas and is flagged.

Style reference (``--style-ref``, optional): an image aligned to ``--region-box`` at 1x (for example an approved
concept painting of that map region). Each frame gets the crop of the placement where the reference shows it most
cleanly (lowest colour difference to the original art), enlarged like the model input, as a second input image: the
model is asked to render the object in that style (modelling, material, light) while every structure rule stays.
``--style-lock-l`` then takes that share of the low-frequency lightness target of the colour lock from the reference
(where it shows the object cleanly) instead of the original art; hue and saturation stay the original's.

The image model runs through a command-line agent (``--codex``); every call gets its own directory holding the
input, the prompt, the output and the agent log. Everything read or written is derived game art and must stay in
gameres/ or another untracked directory.
"""

from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
import json
import math
import os
from pathlib import Path
import shutil
import subprocess
import sys
import threading
import time

import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))
import redetail_sprites as rd  # noqa: E402
from rematerialize import MAIN_REPO, gaussian_blur, resolve_paths  # noqa: E402

GREY = np.asarray(rd.GREY_BG, np.float32)
MARGIN = 8  # 1x margin around the frame in the model input
MIN_LONG_SIDE = 1024  # small model inputs are enlarged (integer factor) to about this long side
ENLARGE_BELOW = 640  # ... when their 4x long side is below this (buildings stay at plain 4x)
LUMA = np.array([0.2126, 0.7152, 0.0722], np.float32)


# ---------------------------------------------------------------------------------------------------- small helpers
def to_u8(rgb: np.ndarray) -> np.ndarray:
    return np.clip(np.rint(rgb), 0, 255).astype(np.uint8)


def load_rgb(path: Path) -> np.ndarray:
    with Image.open(path) as im:
        return np.asarray(im.convert("RGB")).astype(np.float32)


def luminance(rgb: np.ndarray) -> np.ndarray:
    return rd.srgb_to_lab(rgb)[..., 0]


def resize_linear(rgb: np.ndarray, size: tuple[int, int], box: tuple[float, float, float, float] | None = None
                  ) -> np.ndarray:
    """Lanczos resize in linear light (per channel, float); ``box`` selects a source rectangle (may be fractional)."""
    lin = rd.srgb_to_linear(rgb)
    out = np.empty((size[1], size[0], 3), np.float32)
    for c in range(3):
        im = Image.fromarray(lin[..., c].astype(np.float32), mode="F")
        out[..., c] = np.asarray(im.resize(size, Image.LANCZOS, box=box), np.float32)
    return rd.linear_to_srgb(np.clip(out, 0, 1))


def bilinear_axis(img: np.ndarray, coords: np.ndarray, axis: int) -> np.ndarray:
    """Sample img at fractional pixel-centre coordinates along one axis (clamped at the borders)."""
    n = img.shape[axis]
    c = np.clip(coords, 0, n - 1)
    i0 = np.floor(c).astype(np.int64)
    i1 = np.minimum(i0 + 1, n - 1)
    w = (c - i0).astype(np.float32)
    a, b = np.take(img, i0, axis=axis), np.take(img, i1, axis=axis)
    shape = [1] * img.ndim
    shape[axis] = len(coords)
    w = w.reshape(shape)
    return a * (1 - w) + b * w


def warp_st(img: np.ndarray, params: tuple[float, float, float, float], out_shape: tuple[int, int]) -> np.ndarray:
    """Output pixel (x, y) samples img at (sx * x + tx, sy * y + ty) (pixel centres, separable bilinear)."""
    sx, tx, sy, ty = params
    xs = sx * np.arange(out_shape[1], dtype=np.float64) + tx
    ys = sy * np.arange(out_shape[0], dtype=np.float64) + ty
    return bilinear_axis(bilinear_axis(img, xs, 1), ys, 0)


def box_down(img: np.ndarray, f: int) -> np.ndarray:
    h, w = img.shape[0] // f, img.shape[1] // f
    return img[:h * f, :w * f].reshape(h, f, w, f, *img.shape[2:]).mean(axis=(1, 3))


def dilate(mask: np.ndarray, r: int) -> np.ndarray:
    out = mask.copy()
    for _ in range(r):
        p = np.pad(out, 1)
        out = p[1:-1, 1:-1] | p[:-2, 1:-1] | p[2:, 1:-1] | p[1:-1, :-2] | p[1:-1, 2:] | p[:-2, :-2] | p[2:, 2:] \
            | p[:-2, 2:] | p[2:, :-2]
    return out


def erode(mask: np.ndarray, r: int) -> np.ndarray:
    return ~dilate(~mask, r)


def pearson(a: np.ndarray, b: np.ndarray) -> float:
    a = a - a.mean()
    b = b - b.mean()
    d = math.sqrt(float((a * a).sum() * (b * b).sum()))
    return float((a * b).sum() / d) if d > 1e-12 else 0.0


# ---------------------------------------------------------------------------------------------------- frame data
@dataclass
class FrameData:
    ref: rd.FrameRef
    art1: np.ndarray  # 1x displayed colours (house colours on 16..31 when remappable)
    alpha1: np.ndarray  # 1x coverage (bool)
    base: np.ndarray  # 2x RGBA of the base HD atlas
    base_paint: np.ndarray  # 2x remap mask (0..255)
    house: np.ndarray | None
    faithful: np.ndarray | None = None  # 2x RGBA of the faithful atlas
    style1: np.ndarray | None = None  # 1x style reference crop (frame rect + MARGIN on every side), sRGB
    style_valid1: np.ndarray | None = None  # 1x (frame rect) weight 0..1: where the reference shows the object cleanly
    style_lock_l: float = 0.0  # share of the low-frequency lightness target taken from the reference

    @property
    def key(self) -> str:
        return self.ref.key

    @property
    def alpha2(self) -> np.ndarray:
        return self.base[..., 3]

    def orig2x(self) -> np.ndarray:
        """Original art, edge-bled then bicubic 2x (the truth the checks compare against)."""
        h, w = self.alpha1.shape
        return np.asarray(Image.fromarray(to_u8(rd.bleed(self.art1, self.alpha1, 8))).resize((w * 2, h * 2),
                                                                                            Image.BICUBIC), np.float32)

    def displayed(self, rgba2: np.ndarray) -> np.ndarray:
        """Decode house paint of an atlas frame back to displayed house colours (for comparisons and review)."""
        rgb = rgba2[..., :3].astype(np.float32).copy()
        paint = self.base_paint.astype(np.float32) / 255
        if self.ref.remap and self.house is not None and paint.any():
            k = np.clip((255 - rgb[..., 1]) / 15, 0, 15)
            k0 = np.floor(k).astype(int)
            k1 = np.minimum(k0 + 1, 15)
            col = self.house[k0] + (self.house[k1] - self.house[k0]) * (k - k0)[..., None]
            rgb = rgb * (1 - paint[..., None]) + col * paint[..., None]
        return rgb


def frame_data(cache: rd.MapCache, ref: rd.FrameRef, owner: str | None, faithful: np.ndarray | None) -> FrameData:
    house = cache.house_ramp(owner)
    art1, a1, _ = cache.frame_1x(ref, house)
    base, paint = cache.frame_hd(ref)
    fd = FrameData(ref, art1, a1, base.copy(), paint.copy(), house)
    if faithful is not None:
        x, y, w, h = ref.rect
        fd.faithful = faithful[2 * y:2 * (y + h), 2 * x:2 * (x + w)].copy()
    return fd


def placements(cache: rd.MapCache, ref: rd.FrameRef, box: tuple[int, int, int, int]) -> list[tuple[int, int]]:
    """Preview-pixel top-left corners of every map placement of this frame lying wholly inside ``box``."""
    m = cache.manifest
    vr = m.get("visibleRect") or {"x": 0, "y": 0}
    names = {f"{ref.sprite}#{ref.frame}", *ref.aliases}
    out = []
    for o in m["objects"]:
        sid = o.get("sprite")
        if not sid or sid not in m["sprites"]:
            continue
        fi = min(o.get("frame", 0), len(m["sprites"][sid]["frames"]) - 1)
        if f"{sid}#{fi}" not in names:
            continue
        f = m["sprites"][sid]["frames"][fi]
        d = o.get("drawOffset") or [0, 15]
        x0 = (o["x"] - o["y"]) * 30 + d[0] - math.floor(vr["x"]) + f["offset"][0]
        y0 = (o["x"] + o["y"]) * 15 - o["z"] * 15 + d[1] - math.floor(vr["y"]) + f["offset"][1]
        w, h = f["rect"][2], f["rect"][3]
        if x0 - MARGIN >= box[0] and y0 - MARGIN >= box[1] and x0 + w + MARGIN <= box[2] and y0 + h + MARGIN <= box[3]:
            out.append((int(x0), int(y0)))
    return out


def attach_style(fd: FrameData, cache: rd.MapCache, box: tuple[int, int, int, int], style: np.ndarray,
                 lock_l: float) -> dict:
    """Crop the style reference at the cleanest placement of this frame (see the module docstring)."""
    h, w = fd.alpha1.shape
    best = None
    lab_o = rd.srgb_to_lab(rd.masked_blur(fd.art1, fd.alpha1.astype(np.float32), 1.5))
    for x0, y0 in placements(cache, fd.ref, box):
        cx, cy = x0 - box[0], y0 - box[1]
        crop = style[cy - MARGIN:cy + h + MARGIN, cx - MARGIN:cx + w + MARGIN]
        inner = crop[MARGIN:MARGIN + h, MARGIN:MARGIN + w]
        lab_s = rd.srgb_to_lab(rd.masked_blur(inner, fd.alpha1.astype(np.float32), 1.5))
        de = np.sqrt(((lab_s - lab_o) ** 2).sum(-1))
        score = float(de[fd.alpha1].mean()) if fd.alpha1.any() else 1e9
        if best is None or score < best[0]:
            best = (score, crop, de, (x0, y0))
    if best is None:
        return {"style": None}
    score, crop, de, at = best
    # Clean where the reference is within a plausible repaint of the original (no smoke, fire or a unit over it).
    fire = (crop[MARGIN:MARGIN + h, MARGIN:MARGIN + w, 0] > 200) & (crop[MARGIN:MARGIN + h, MARGIN:MARGIN + w, 2] < 120)
    valid = np.clip((32.0 - de) / 12.0, 0, 1) * ~fire * fd.alpha1
    fd.style1 = crop.astype(np.float32)
    fd.style_valid1 = gaussian_blur(valid.astype(np.float32), 1.0) * fd.alpha1
    fd.style_lock_l = lock_l
    return {"style": {"placement": list(at), "dE_mean": round(score, 2),
                      "clean_frac": round(float(valid[fd.alpha1].mean()), 3) if fd.alpha1.any() else 0.0}}


# ---------------------------------------------------------------------------------------------------- model input
def model_input(fd: FrameData, esrgan: Path | None, lock: list[str] | None = None) -> tuple[np.ndarray, dict]:
    """4x Real-ESRGAN of the frame (margin MARGIN, edge-bled) composited on flat grey, enlarged for small frames."""
    h, w = fd.alpha1.shape
    box = np.zeros((h + 2 * MARGIN, w + 2 * MARGIN, 3), np.float32)
    known = np.zeros(box.shape[:2], bool)
    box[MARGIN:MARGIN + h, MARGIN:MARGIN + w] = fd.art1
    known[MARGIN:MARGIN + h, MARGIN:MARGIN + w] = fd.alpha1
    box = rd.bleed(box, known)
    if esrgan is None:
        up = np.asarray(Image.fromarray(to_u8(box)).resize((box.shape[1] * 4, box.shape[0] * 4), Image.LANCZOS),
                        np.float32)
    elif lock:
        up = realesrgan_locked(esrgan, box, lock)
    else:
        up = rd.realesrgan(esrgan, box, 4)
    a4 = rd.smooth_alpha(known.astype(np.float32), 4)
    comp = up * a4[..., None] + GREY * (1 - a4[..., None])
    long_side = max(comp.shape[:2])
    f = 1 if long_side >= ENLARGE_BELOW else math.ceil(MIN_LONG_SIDE / long_side)
    canvas = comp if f == 1 else np.asarray(Image.fromarray(to_u8(comp)).resize(
        (comp.shape[1] * f, comp.shape[0] * f), Image.LANCZOS), np.float32)
    meta = {"key": fd.key, "rect": list(fd.ref.rect), "margin": MARGIN, "scale4": [comp.shape[1], comp.shape[0]],
            "enlarge": f, "canvas": [canvas.shape[1], canvas.shape[0]]}
    return canvas, meta


def realesrgan_locked(binary: Path, rgb: np.ndarray, lock: list[str]) -> np.ndarray:
    """rd.realesrgan through a lock wrapper command (shared local GPU)."""
    import tempfile
    with tempfile.TemporaryDirectory(prefix="hybrid-esr-") as tmp:
        src, dst = Path(tmp) / "in.png", Path(tmp) / "out.png"
        Image.fromarray(to_u8(rgb)).save(src)
        subprocess.run([*lock, str(binary), "-i", str(src), "-o", str(dst), "-n", "realesrgan-x4plus", "-s", "4",
                        "-m", str(binary.parent / "models"), "-t", "256"], check=True,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        out = load_rgb(dst)
    if out.shape[:2] != (rgb.shape[0] * 4, rgb.shape[1] * 4):
        raise ValueError(f"Real-ESRGAN returned {out.shape}")
    return out


# ---------------------------------------------------------------------------------------------------- registration
def foreground(rgb: np.ndarray, thr: float = 14.0) -> np.ndarray:
    d = np.abs(gaussian_blur(rgb, 1.5) - GREY).max(axis=-1)
    return d > thr


def bbox(mask: np.ndarray) -> tuple[int, int, int, int]:
    ys, xs = np.nonzero(mask)
    return int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1


def register(inp: np.ndarray, out: np.ndarray, weight: np.ndarray, levels: int = 3, iters: int = 30
             ) -> tuple[tuple[float, float, float, float], dict]:
    """Fit out(sx x + tx, sy y + ty) ~ gain * inp(x, y) + offset on blurred luminance (Gauss-Newton, coarse to fine).

    Both images have the same canvas size; weight marks where the object is (silhouette dilated). Returns the
    sampling parameters (sx, tx, sy, ty) that bring ``out`` onto ``inp``'s pixel grid, plus diagnostics."""
    li, lo = luminance(inp), luminance(out)
    # Initial guess from the foreground boxes (tolerates a model that re-framed the object).
    fi, fo = foreground(inp), foreground(out)
    diag: dict = {}
    try:
        bi, bo = bbox(fi), bbox(fo)
        sx0 = (bo[2] - bo[0]) / max(1, bi[2] - bi[0])
        sy0 = (bo[3] - bo[1]) / max(1, bi[3] - bi[1])
        if not (0.8 < sx0 < 1.25 and 0.8 < sy0 < 1.25):
            sx0 = sy0 = 1.0
        p = np.array([sx0, bo[0] - sx0 * bi[0], sy0, bo[1] - sy0 * bi[1]], np.float64)
    except ValueError:
        p = np.array([1.0, 0.0, 1.0, 0.0])
    diag["init"] = [round(float(v), 4) for v in p]
    for level in range(levels - 1, -1, -1):
        f = 2 ** level
        sigma = 1.0 * f
        a = gaussian_blur(li, sigma)
        b = gaussian_blur(lo, sigma)
        wgt = gaussian_blur(weight.astype(np.float32), sigma) > 0.05
        if f > 1:
            a, b, wgt = box_down(a, f), box_down(b, f), box_down(wgt.astype(np.float32), f) > 0.5
        # Parameters in this level's pixels: x_full = f * x + (f - 1) / 2.
        q = p.copy()
        q[1] = (p[1] + p[0] * (f - 1) / 2 - (f - 1) / 2) / f
        q[3] = (p[3] + p[2] * (f - 1) / 2 - (f - 1) / 2) / f
        gy, gx = np.gradient(b)
        ys, xs = np.nonzero(wgt)
        av = a[ys, xs].astype(np.float64)
        for _ in range(iters):
            X = q[0] * xs + q[1]
            Y = q[2] * ys + q[3]
            bv = sample2(b, X, Y)
            gxv, gyv = sample2(gx, X, Y), sample2(gy, X, Y)
            # Photometric gain/offset so a tone change of the redraw does not bias the geometry.
            A = np.stack([av, np.ones_like(av)], 1)
            gain, off = np.linalg.lstsq(A, bv, rcond=None)[0]
            r = bv - (gain * av + off)
            J = np.stack([gxv * xs, gxv, gyv * ys, gyv], 1)
            H = J.T @ J + 1e-6 * np.eye(4)
            dq = np.linalg.solve(H, -J.T @ r)
            q += dq
            if abs(dq[0]) < 1e-5 and abs(dq[2]) < 1e-5 and abs(dq[1]) < 1e-3 and abs(dq[3]) < 1e-3:
                break
        p = q.copy()
        p[1] = q[1] * f + (f - 1) / 2 - q[0] * (f - 1) / 2
        p[3] = q[3] * f + (f - 1) / 2 - q[2] * (f - 1) / 2
    diag["params"] = [round(float(v), 4) for v in p]
    return (float(p[0]), float(p[1]), float(p[2]), float(p[3])), diag


def sample2(img: np.ndarray, X: np.ndarray, Y: np.ndarray) -> np.ndarray:
    h, w = img.shape
    X = np.clip(X, 0, w - 1.001)
    Y = np.clip(Y, 0, h - 1.001)
    x0, y0 = np.floor(X).astype(np.int64), np.floor(Y).astype(np.int64)
    wx, wy = X - x0, Y - y0
    v00, v01 = img[y0, x0], img[y0, x0 + 1]
    v10, v11 = img[y0 + 1, x0], img[y0 + 1, x0 + 1]
    return (v00 * (1 - wx) + v01 * wx) * (1 - wy) + (v10 * (1 - wx) + v11 * wx) * wy


# ---------------------------------------------------------------------------------------------------- post-process
@dataclass
class Redraw:
    rgba: np.ndarray  # final 2x atlas frame (RGBA, paint re-encoded)
    displayed: np.ndarray  # final 2x displayed colours (house colours decoded)
    raw2: np.ndarray  # registered redraw at 2x before the colour lock (frame rect, sRGB)
    raw2m: np.ndarray  # same with the 2x margin (for the outside-silhouette check)
    reg4: np.ndarray  # registered redraw at 4x (frame rect + margin) for references and review
    registration: dict = field(default_factory=dict)


def postprocess(fd: FrameData, meta: dict, inp_canvas: np.ndarray, raw: np.ndarray, sigma_l: float,
                sigma_ab: float, lock: float = 1.0, edge_hf: float = 0.75) -> Redraw:
    """Register a model output onto the frame, downsample, lock colour, restore alpha and paint."""
    cw, ch = meta["canvas"]
    f = meta["enlarge"]
    w4, h4 = meta["scale4"]
    # Registration at canvas size (the model output resized to the canvas first).
    out_c = raw if raw.shape[:2] == (ch, cw) else resize_linear(raw, (cw, ch))
    weight = dilate(foreground(inp_canvas, 6.0), 8)
    params, diag = register(inp_canvas, out_c, weight)
    sx, tx, sy, ty = params
    # Resample the 4x frame (with margin) straight from the full-size model image: canvas pixel u = f * x4 + (f-1)/2,
    # model canvas coordinate s * u + t, raw coordinate scaled by raw/canvas. Pixel-centre -> edge convention for box.
    rx, ry = raw.shape[1] / cw, raw.shape[0] / ch

    def to_raw_x(x_edge_4x: float) -> float:
        u = f * x_edge_4x  # edge coordinate at canvas scale
        return (sx * (u - 0.5) + tx + 0.5) * rx

    def to_raw_y(y_edge_4x: float) -> float:
        v = f * y_edge_4x
        return (sy * (v - 0.5) + ty + 0.5) * ry

    pad = 64
    rawp = np.pad(raw, ((pad, pad), (pad, pad), (0, 0)), mode="edge")
    boxr = (to_raw_x(0) + pad, to_raw_y(0) + pad, to_raw_x(w4) + pad, to_raw_y(h4) + pad)
    reg4 = resize_linear(rawp, (w4, h4), box=boxr)
    m2 = 2 * meta["margin"]
    raw2m = rd.box_down_linear(reg4, 2)
    x, y, w, h = fd.ref.rect
    raw2 = raw2m[m2:m2 + 2 * h, m2:m2 + 2 * w]
    final = lock_colour(fd, raw2, sigma_l, sigma_ab, lock, edge_hf)
    rgba = encode_frame(fd, final)
    diag.update({"scale": [round(sx, 4), round(sy, 4)], "shift_canvas_px": [round(tx, 2), round(ty, 2)],
                 "model_size": [raw.shape[1], raw.shape[0]]})
    # Residual shift after registration (should be ~0): phase correlation at 2x on the luminance.
    a2 = fd.alpha1.repeat(2, 0).repeat(2, 1)
    wgt = a2.astype(np.float32)
    try:
        res = rd.phase_shift(rd.masked_blur(luminance(fd.orig2x()), wgt, 1.0), rd.masked_blur(luminance(raw2), wgt,
                                                                                               1.0), wgt)
        diag["residual_shift_2x"] = [round(res[0], 3), round(res[1], 3)]
    except Exception:  # noqa: BLE001 (diagnostic only)
        diag["residual_shift_2x"] = None
    return Redraw(rgba, fd.displayed(rgba), raw2, raw2m, reg4, diag)


def lock_colour(fd: FrameData, rep2: np.ndarray, sigma_l: float, sigma_ab: float, lock: float, edge_hf: float
                ) -> np.ndarray:
    """Low frequencies of Lab from the original art (weight ``lock``), higher frequencies from the redraw."""
    a2n = fd.alpha1.repeat(2, 0).repeat(2, 1)
    wgt = a2n.astype(np.float32)
    ref2 = np.kron(fd.art1, np.ones((2, 2, 1), np.float32))
    lab_rep, lab_ref = rd.srgb_to_lab(rep2), rd.srgb_to_lab(ref2)
    out = np.empty_like(lab_rep)
    style_l = None
    if fd.style1 is not None and fd.style_lock_l > 0:
        h, w = fd.alpha1.shape
        inner = fd.style1[MARGIN:MARGIN + h, MARGIN:MARGIN + w]
        s2 = np.asarray(Image.fromarray(to_u8(inner)).resize((w * 2, h * 2), Image.BICUBIC), np.float32)
        valid2 = np.kron(fd.style_valid1, np.ones((2, 2), np.float32))
        style_l = (rd.srgb_to_lab(s2)[..., 0], valid2 * fd.style_lock_l)
    for c, sigma in ((0, sigma_l), (1, sigma_ab), (2, sigma_ab)):
        low_rep = rd.masked_blur(lab_rep[..., c], wgt, sigma)
        low_ref = rd.masked_blur(lab_ref[..., c], wgt, sigma)
        if c == 0 and style_l is not None:
            # Lightness target partly from the style reference where it shows the object cleanly.
            low_style = rd.masked_blur(style_l[0], wgt * (style_l[1] > 0), sigma)
            share = rd.masked_blur(style_l[1], wgt, sigma)
            low_ref = low_ref + share * (low_style - low_ref)
        out[..., c] = lab_rep[..., c] + lock * (low_ref - low_rep)
    # Outermost silhouette ring: the model saw flat background next to it; damp its detail there.
    ring = rd.erode_distance(fd.alpha2 > 0, 2) == 1
    if edge_hf < 1:
        low = np.stack([rd.masked_blur(lab_ref[..., c], wgt, s) for c, s in ((0, sigma_l), (1, sigma_ab),
                                                                             (2, sigma_ab))], -1)
        out = np.where(ring[..., None], low + (out - low) * edge_hf, out)
    return np.clip(rd.lab_to_srgb(out), 0, 255)


def encode_frame(fd: FrameData, final: np.ndarray) -> np.ndarray:
    """Atlas RGBA: house paint on the grey ramp, bled colour under transparent texels, alpha from the base atlas."""
    paint = fd.base_paint.astype(np.float32) / 255
    if fd.ref.remap and fd.house is not None and paint.any():
        grey = rd.neutral_to_grey(final, fd.house)
        final = final * (1 - paint[..., None]) + grey * paint[..., None]
    alpha2 = fd.alpha2
    filled = rd.bleed(final, alpha2 > 0, steps=8)
    out = np.empty(fd.base.shape, np.uint8)
    out[..., :3] = to_u8(filled)
    out[..., 3] = alpha2
    return out


# ---------------------------------------------------------------------------------------------------- checks
# Directions of the two isometric facade line families (2:1 dimetric: slope +-1/2) and the vertical.
DIRECTIONS = {"facade_l": (2.0, 1.0), "facade_r": (2.0, -1.0), "vertical": (0.0, 1.0)}


def projection_profile(lum: np.ndarray, mask: np.ndarray, direction: tuple[float, float]) -> np.ndarray:
    """Signed derivative across the line family, summed along the lines (a Radon projection of that derivative).

    Floors show up as peaks of the facade profiles, window columns as peaks of the vertical profile; features of
    other orientations mostly cancel because the derivative is signed."""
    dx, dy = direction
    n = np.array([-dy, dx], np.float64)
    n /= np.linalg.norm(n)
    gy, gx = np.gradient(lum)
    d = (gx * n[0] + gy * n[1]) * mask
    h, w = lum.shape
    yy, xx = np.mgrid[0:h, 0:w]
    u = xx * n[0] + yy * n[1]
    u = np.rint(u - u.min()).astype(np.int64)
    prof = np.bincount(u.ravel(), weights=d.ravel(), minlength=int(u.max()) + 1)
    cnt = np.bincount(u.ravel(), weights=mask.ravel().astype(np.float64), minlength=int(u.max()) + 1)
    return prof / np.sqrt(np.maximum(cnt, 1.0))


def count_peaks(p: np.ndarray, rel: float = 0.25) -> int:
    """Local maxima of |p| above rel * max, at least 3 samples apart (a structural line counts once)."""
    a = np.abs(gaussian_blur(p[None, :], 1.0)[0])
    if a.max() <= 0:
        return 0
    thr = rel * a.max()
    idx = [i for i in range(1, len(a) - 1) if a[i] >= a[i - 1] and a[i] > a[i + 1] and a[i] > thr]
    kept: list[int] = []
    for i in sorted(idx, key=lambda i: -a[i]):
        if all(abs(i - j) >= 3 for j in kept):
            kept.append(i)
    return len(kept)


GRID_MIN_AREA = 1500  # 1x opaque texels; smaller objects (street furniture) have no facade grid to test


def luminance_profile(lum: np.ndarray, mask: np.ndarray, direction: tuple[float, float]
                      ) -> tuple[np.ndarray, np.ndarray]:
    """Mean luminance along the lines of a family, high-passed (sigma 6) and lightly smoothed; valid where >5 px."""
    dx, dy = direction
    n = np.array([-dy, dx], np.float64)
    n /= np.linalg.norm(n)
    h, w = lum.shape
    yy, xx = np.mgrid[0:h, 0:w]
    u = xx * n[0] + yy * n[1]
    u = np.rint(u - u.min()).astype(np.int64)
    s = np.bincount(u.ravel(), weights=(lum * mask).ravel())
    c = np.bincount(u.ravel(), weights=mask.ravel().astype(np.float64))
    valid = c > 5
    if valid.sum() < 2:
        return np.zeros(len(c)), valid
    p = np.where(valid, s / np.maximum(c, 1), 0.0)
    p = np.interp(np.arange(len(p)), np.flatnonzero(valid), p[valid])
    p = p - gaussian_blur(p[None, :], 6.0)[0]
    return gaussian_blur(p[None, :], 1.0)[0], valid


def count_minima(p: np.ndarray, valid: np.ndarray, rel: float = 0.35) -> int:
    """Dark rows/columns: local minima below -rel * std, at least 4 samples apart."""
    if valid.sum() < 3:
        return 0
    sd = float(p[valid].std())
    idx = [i for i in range(1, len(p) - 1) if valid[i] and p[i] < p[i - 1] and p[i] <= p[i + 1] and p[i] < -rel * sd]
    kept: list[int] = []
    for i in sorted(idx, key=lambda i: p[i]):
        if all(abs(i - j) >= 4 for j in kept):
            kept.append(i)
    return len(kept)


def decoration_ratio(fd: "FrameData", lo: np.ndarray, lf: np.ndarray, wgt: np.ndarray, inside: np.ndarray) -> float:
    def band(l):
        return rd.masked_blur(l, wgt, 0.7) - rd.masked_blur(l, wgt, 2.0)

    def energy(b):
        return np.sqrt(np.maximum(rd.masked_blur(b * b, wgt, 3.0), 0))

    if inside.sum() < 64:
        return 1.0
    eo = energy(band(lo))
    co = rd.sobel(rd.masked_blur(lo, wgt, 2.0))
    zone = inside & (eo > np.percentile(eo[inside], 60)) & (co < np.percentile(co[inside], 60))
    if zone.sum() < 32:
        return 1.0
    lb = luminance(fd.displayed(fd.base))
    rf = energy(band(lf))[zone] / np.maximum(eo[zone], 1e-3)
    rb = energy(band(lb))[zone] / np.maximum(eo[zone], 1e-3)
    return float(np.median(rf) / max(np.median(rb), 1e-6))


def tile_grid(shape: tuple[int, int], size: int, step: int):
    h, w = shape
    for y in range(0, max(1, h - size + 1), step):
        for x in range(0, max(1, w - size + 1), step):
            yield y, x


def region_name(cx: float, cy: float, w: int, h: int) -> str:
    vert = "upper" if cy < h / 3 else ("lower" if cy > 2 * h / 3 else "middle")
    horiz = "left" if cx < w / 3 else ("right" if cx > 2 * w / 3 else "centre")
    return f"{vert} {horiz}"


def checks(fd: FrameData, rd2: Redraw, category: str, thresholds: dict) -> dict:
    """Faithfulness metrics of a redraw vs the original art, with pass/fail per check."""
    orig = fd.orig2x()
    a2 = fd.alpha1.repeat(2, 0).repeat(2, 1)
    wgt = a2.astype(np.float32)
    inside = rd.erode_distance(a2, 3) > 2
    final = rd2.displayed
    lo, lf, lr = luminance(orig), luminance(final), luminance(rd2.raw2)
    m: dict = {}

    def edges(l, sigma):
        return rd.sobel(rd.masked_blur(l, wgt, sigma))

    # (a) coarse structure: edge-map correlation after blur (sigma 2 = one original texel; sigma 1 finer).
    eo2, ef2 = edges(lo, 2.0), edges(lf, 2.0)
    eo1, ef1 = edges(lo, 1.0), edges(lf, 1.0)
    m["edge_corr_s2"] = round(pearson(eo2[inside], ef2[inside]), 4) if inside.sum() > 16 else 1.0
    m["edge_corr_s1"] = round(pearson(eo1[inside], ef1[inside]), 4) if inside.sum() > 16 else 1.0
    # Local version: tiles of 24 original texels; the worst tiles locate lost features (ornament, a roof step).
    size = 48 if min(a2.shape) >= 96 else max(16, min(a2.shape) // 2)
    tiles = []
    for ty, tx in tile_grid(a2.shape, size, size // 2):
        sl = (slice(ty, ty + size), slice(tx, tx + size))
        ins = inside[sl]
        if ins.mean() < 0.5:
            continue
        o, fvals = eo1[sl][ins], ef1[sl][ins]
        if o.std() < 1e-3:
            continue
        tiles.append((pearson(o, fvals), tx + size / 2, ty + size / 2, float(o.std())))
    if tiles:
        vals = np.array([t[0] for t in tiles])
        m["tile_corr_min"] = round(float(vals.min()), 4)
        m["tile_corr_p10"] = round(float(np.percentile(vals, 10)), 4)
        worst = sorted(tiles)[:3]
        m["worst_tiles"] = [{"corr": round(t[0], 3), "x": int(t[1]), "y": int(t[2]),
                             "region": region_name(t[1], t[2], a2.shape[1], a2.shape[0])} for t in worst]
        m["tiles_low"] = int((vals < thresholds["tile_corr"]).sum())
        m["tiles"] = len(tiles)
    # (b) facade grid: projection profiles along the facade directions and the vertical. After registration a changed
    # floor or column count puts the profiles out of phase, so their correlation is the test; minima counts of the
    # luminance profile (dark window rows/columns) are reported for information only (crisper window frames and new
    # mullions change them even when the grid is kept).
    grid = {}
    sm = inside.astype(np.float64)
    hp = lambda p: p - gaussian_blur(p[None, :], 6.0)[0]  # noqa: E731
    for name, d in DIRECTIONS.items():
        po = projection_profile(gaussian_blur(lo, 1.0), sm, d)
        pf = projection_profile(gaussian_blur(lf, 1.0), sm, d)
        qo, valid = luminance_profile(lo, sm, d)
        qf, _ = luminance_profile(lf, sm, d)
        grid[name] = {"corr": round(pearson(hp(po), hp(pf)), 4),
                      "lum_corr": round(pearson(qo[valid], qf[valid]), 4) if valid.sum() > 8 else 1.0,
                      "rows_orig": count_minima(qo, valid), "rows_redraw": count_minima(qf, valid)}
    m["grid"] = grid
    m["grid_applies"] = bool(fd.alpha1.sum() >= GRID_MIN_AREA)
    # (a) decoration retained: fine-band energy of the redraw relative to the base HD, where the original has textured
    # wall (strong fine detail away from strong coarse edges). Calibrated on the prototype that flattened carved
    # spandrel ornament into plain stone (0.92) while faithful redraws scored 1.00-1.28.
    m["decoration_ratio"] = round(decoration_ratio(fd, lo, lf, wgt, inside), 4)
    # (c) internal structural edges (roof blocks, steps, ledges): strong coarse edges away from the silhouette.
    core = rd.erode_distance(a2, 4) > 3
    if core.sum() > 64:
        so, sf = eo2[core], ef2[core]
        strong_o = np.zeros_like(a2)
        strong_f = np.zeros_like(a2)
        strong_o[core] = so > np.percentile(so, 85)
        strong_f[core] = sf > np.percentile(sf, 85)
        near_f, near_o = dilate(strong_f, 2), dilate(strong_o, 2)
        m["struct_recall"] = round(float((strong_o & near_f).sum() / max(1, strong_o.sum())), 4)
        m["struct_precision"] = round(float((strong_f & near_o).sum() / max(1, strong_f.sum())), 4)
    else:
        m["struct_recall"] = m["struct_precision"] = 1.0
    # (d) low-frequency colour: CIE76 after a sigma-3 (2x) masked blur; raw = before the colour lock.
    lab_o = rd.masked_blur(rd.srgb_to_lab(orig), wgt, 3.0)
    for tag, img in (("final", final), ("raw", rd2.raw2)):
        d = np.sqrt(((rd.masked_blur(rd.srgb_to_lab(img), wgt, 3.0) - lab_o) ** 2).sum(-1))[inside]
        m[f"lf_dE_{tag}"] = [round(float(d.mean()), 2), round(float(np.percentile(d, 95)), 2)] if d.size else [0, 0]
    # (e) content outside the silhouette in the registered raw redraw (model grew the object) and background showing
    # through inside it (model shrank or holed it); both relative to the silhouette area.
    m2 = (rd2.raw2m.shape[0] - a2.shape[0]) // 2
    a2m = np.pad(a2, m2)
    diff = np.abs(gaussian_blur(rd2.raw2m, 1.0) - GREY).max(-1)
    outside = ~dilate(a2m, 3)
    m["outside_frac"] = round(float((outside & (diff > 24)).sum() / max(1, a2.sum())), 4)
    core_m = np.pad(inside, m2)
    flat = np.abs(rd2.raw2m - gaussian_blur(rd2.raw2m, 2.0)).max(-1) < 3
    m["hole_frac"] = round(float((core_m & (diff < 5) & flat).sum() / max(1, a2.sum())), 4)
    # Detail: fine texture of the redraw vs the faithful atlas (flat areas, sigma-1 residual).
    edges_o = rd.sobel(rd.masked_blur(lo, wgt, 1.0))
    flat_in = inside & (edges_o < np.percentile(edges_o[inside], 70)) if inside.sum() > 16 else inside

    def texture(l):
        d = np.abs(l - rd.masked_blur(l, wgt, 1.0))[flat_in]
        return float(d.mean()) if d.size else 0.0

    m["texture_hybrid"] = round(texture(lf), 3)
    if fd.faithful is not None:
        m["texture_faithful"] = round(texture(luminance(fd.displayed(fd.faithful))), 3)
    m["texture_orig"] = round(texture(lo), 3)
    m["registration"] = rd2.registration
    m["failures"] = evaluate(m, category, thresholds)
    m["passed"] = not m["failures"]
    return m


# Calibrated on the XMP29U2 city buildings: 14 first redraws judged faithful by eye (edge corr sigma-2 0.84-0.98,
# profile corr >= 0.81, luminance profile corr >= 0.89, recall/precision >= 0.89/0.85, dE <= 2.9/6.4) and the owner-
# rejected prototype (flattened ornament: decoration ratio 0.92). Structure thresholds sit below the faithful range
# so that they catch gross changes (lost blocks, re-framed floors) rather than cleaner surfaces.
DEFAULT_THRESHOLDS = {
    "edge_corr_s2": 0.82, "tile_corr": 0.55, "tiles_low_frac": 0.10, "decoration_ratio": 0.96, "grid_corr": 0.78,
    "grid_lum_corr": 0.85, "struct_recall": 0.80, "struct_precision": 0.75, "lf_dE_mean": 4.0, "lf_dE_p95": 10.0,
    "outside_frac": 0.03, "hole_frac": 0.02, "scale_dev": 0.06, "consistency_dE": 6.0,
    "consistency_texture": (0.67, 1.5),
}


def evaluate(m: dict, category: str, t: dict) -> list[dict]:
    """Failed checks as {check, detail, hint}; the hint phrases the retry emphasis."""
    fails = []
    building = category == "building"
    if m["edge_corr_s2"] < t["edge_corr_s2"]:
        fails.append({"check": "a_structure", "detail": f"edge corr {m['edge_corr_s2']:.3f} < {t['edge_corr_s2']}",
                      "hint": "structure"})
    if "tiles" in m and m["tiles"] >= 4 and m["tiles_low"] / m["tiles"] > t["tiles_low_frac"]:
        where = ", ".join(sorted({w["region"] for w in m["worst_tiles"]}))
        fails.append({"check": "a_local", "detail": f"{m['tiles_low']}/{m['tiles']} tiles below "
                      f"{t['tile_corr']} (worst: {where})", "hint": f"local:{where}"})
    if m.get("decoration_ratio", 1.0) < t["decoration_ratio"]:
        fails.append({"check": "a_decoration", "detail": f"surface decoration energy {m['decoration_ratio']:.2f} of the "
                      f"base HD (< {t['decoration_ratio']})", "hint": "local:whole"})
    if building and m.get("grid_applies", True):
        for name, g in m["grid"].items():
            if g["corr"] < t["grid_corr"] or g["lum_corr"] < t["grid_lum_corr"]:
                fails.append({"check": f"b_grid_{name}", "detail": f"profile corr {g['corr']:.3f} / luminance "
                              f"{g['lum_corr']:.3f}, dark rows {g['rows_orig']}->{g['rows_redraw']}", "hint": "grid"})
    if building:
        if m["struct_recall"] < t["struct_recall"] or m["struct_precision"] < t["struct_precision"]:
            fails.append({"check": "c_roof_blocks", "detail": f"recall {m['struct_recall']:.2f}, precision "
                          f"{m['struct_precision']:.2f}", "hint": "blocks"})
    de = m["lf_dE_final"]
    if de[0] > t["lf_dE_mean"] or de[1] > t["lf_dE_p95"]:
        fails.append({"check": "d_colour", "detail": f"LF dE {de[0]:.2f}/{de[1]:.2f}", "hint": "colour"})
    if m["outside_frac"] > t["outside_frac"] or m["hole_frac"] > t["hole_frac"]:
        fails.append({"check": "e_silhouette", "detail": f"outside {m['outside_frac']:.3f}, holes "
                      f"{m['hole_frac']:.3f}", "hint": "silhouette"})
    sx, sy = m["registration"].get("scale", [1, 1])
    if abs(sx - 1) > t["scale_dev"] or abs(sy - 1) > t["scale_dev"]:
        fails.append({"check": "e_framing", "detail": f"model rescaled the object by {sx:.3f} x {sy:.3f}",
                      "hint": "framing"})
    return fails


# ---------------------------------------------------------------------------------------------------- prompts
BASE_PROMPT = """Task: image editing only. Do not write code other than what is needed to save/resize the image.

In this directory there is input.png: {subject}, upscaled 4x from pixel art, on a flat grey (118,118,118) \
background.{extra_inputs}

Use your image generation / image editing tool with input.png as the reference image to produce a re-detailed HD \
version of EXACTLY the same {noun}:
- identical camera angle, framing, position and size in the frame; identical silhouette and outline;
{structure_rules}
- identical colours and colour mood ({colours}), identical lighting direction (light from the upper left; right-hand \
faces darker);
- ONLY increase material fidelity: {materials}
- keep the flat grey (118,118,118) background; no ground, no shadow, no people, no vehicles, no text.
{emphasis}
Save the result as output.png in this directory with exactly the same pixel size as input.png (resize the generated \
image to that size if the tool returns another size; keep the whole {noun} visible, do not crop). Also copy the \
generated image before resizing to raw.png in this directory. Then reply with one line saying the tool used and the \
generated size before resizing.
"""

STRUCTURE = {
    "building": "- identical architecture: same number of floors, same window rows and columns in the same places, "
                "same roof blocks, steps, rooftop structures, cornices, ledges and decorations in the same places;",
    "tree": "- identical tree: same species, same trunk and branch positions, same crown shape and outline, same leaf "
            "clusters in the same places;",
    "overlay": "- identical object: same posts, panels, wires and parts in the same places;",
}
MATERIALS = {
    "building": "crisp straight window frames and mullions, glass panes, fine stone/brick/concrete facade texture, "
                "crisp cornices and ledges, clean sharp edges, subtle ambient occlusion in corners;",
    "tree": "crisp individual leaf clusters with natural leaf texture, visible bark and branches, clean sharp "
            "edges, subtle depth shading inside the crown;",
    "overlay": "crisp metal posts, fine wire mesh and razor wire detail, clean sharp edges;",
}
EMPHASIS = {
    "structure": "IMPORTANT: a previous attempt changed the {noun}'s structure. Trace input.png closely: every edge, "
                 "block and ledge must stay exactly where it is.",
    "grid": "IMPORTANT: a previous attempt changed the facade grid. Keep EXACTLY the same number of floors and the "
            "same window columns as input.png, at the same positions; do not add, merge or remove any floor, window "
            "or column.",
    "blocks": "IMPORTANT: a previous attempt changed the roof. Keep every roof block, stepped level, rooftop structure "
              "and ledge exactly as in input.png, same count, size and position.",
    "colour": "IMPORTANT: a previous attempt changed the colours. Match the colours and brightness of input.png area "
              "by area; do not recolour walls, windows or roofs.",
    "silhouette": "IMPORTANT: a previous attempt drew outside the {noun}'s outline or left parts out. Nothing may be "
                  "added outside the outline of input.png and no part of the {noun} may be removed.",
    "consistency": "IMPORTANT: a previous attempt did not match reference_intact.png. Intact parts must use exactly "
                   "the same materials, colours, window style and sharpness as reference_intact.png.",
    "framing": "IMPORTANT: a previous attempt changed the size or position of the {noun} in the frame. Keep it at "
               "exactly the same pixel position and size as in input.png.",
}


def local_emphasis(where: str, noun: str) -> str:
    place = f"across the whole {noun}" if where == "every" else f"in the {where} part of the {noun}"
    return (f"IMPORTANT: a previous attempt lost surface detail {place}. Keep all surface "
            f"decoration there (carved ornament and patterns between windows, bands, panels, trim, small features) "
            f"exactly as in input.png; redraw it crisper but do not replace it with plain wall or a different "
            f"pattern.")


@dataclass
class ObjectSpec:
    subject: str
    colours: str
    noun: str = "building"


STYLE_INPUT = (
    "\n\nThere is also style_reference.png: the owner-approved concept painting of this same {noun} at the same framing "
    "(anything else in it - trees, cars, smoke, fire, ground - is not part of the {noun}; ignore it). It is the target "
    "LOOK: render the {noun} of input.png the way style_reference.png paints it - clean rendered materials instead of "
    "pixel noise, clear separation between the lit left faces, the shaded right faces and the roofs, window glass that "
    "reads as glass (clearer, with a hint of sky reflection) inside crisp frames and recessed openings with a thin "
    "inner shadow, cornices and ledges with a bright top edge and a soft shadow line under them, and soft contact "
    "shading where walls meet roofs and the ground. Where style_reference.png and input.png disagree about structure "
    "(floors, windows, blocks, outline), input.png wins."
)
STYLE_MATERIALS = {
    "building": "the concept's rendered look (see style_reference.png): crisp straight window frames and mullions, "
                "glass that reads as glass, recessed window openings, bevelled cornices with bright top edges, clean "
                "facade materials without pixel noise, clear light and shade between faces, soft contact shading;",
}


def build_prompt(category: str, spec: ObjectSpec, hints: list[str], damaged: bool = False, style: bool = False
                 ) -> str:
    extra = STYLE_INPUT.format(noun=spec.noun) if style else ""
    structure = STRUCTURE.get(category, STRUCTURE["overlay"])
    if damaged:
        extra += ("\n\nThere is also reference_intact.png: the APPROVED HD redraw of the same building undamaged, on the "
                 "same grey background (it is a reference for materials only; its framing may differ). input.png shows "
                 "the DAMAGED state of that building. Redraw input.png: keep all damage exactly as in input.png "
                 "(holes, collapsed parts, rubble, cracks, exposed floors, scorch marks, same shapes and positions), and "
                 "use the materials, colours, window style and facade texture of reference_intact.png for every intact "
                 "part so the two images look like the same building.")
        structure += "\n- all damage (holes, collapsed parts, rubble, cracks) exactly as in input.png;"
    emphasis_lines = []
    for h in dict.fromkeys(hints):
        if h.startswith("local:"):
            where = h.split(":", 1)[1]
            emphasis_lines.append(local_emphasis("every" if where == "whole" else where, spec.noun))
        elif h in EMPHASIS:
            emphasis_lines.append(EMPHASIS[h].format(noun=spec.noun))
    emphasis = ("\n" + "\n".join(emphasis_lines) + "\n") if emphasis_lines else ""
    materials = (STYLE_MATERIALS if style else MATERIALS).get(category, MATERIALS.get(category, MATERIALS["overlay"]))
    prompt = BASE_PROMPT.format(subject=spec.subject, extra_inputs=extra, noun=spec.noun, structure_rules=structure,
                                colours=spec.colours, materials=materials, emphasis=emphasis)
    if style:
        # The style may change lightness and material; the colour mood stays the original's.
        prompt = prompt.replace("- ONLY increase material fidelity:", "- change the rendering style as described, keep "
                                "the hues:")
        prompt = prompt.replace("with input.png as the reference image", "with input.png as the reference image (and "
                                "style_reference.png as the style reference)")
    return prompt


# ---------------------------------------------------------------------------------------------------- image model
_CODEX_SLOTS: threading.Semaphore | None = None


def run_codex(codex: Path, directory: Path, prompt: str, timeout: float) -> dict:
    """One image-model call through the codex CLI in its own directory; returns timing and status."""
    (directory / "prompt.txt").write_text(prompt)
    t0 = time.time()
    assert _CODEX_SLOTS is not None
    with _CODEX_SLOTS:
        with open(directory / "run.log", "w") as log, open(os.devnull) as devnull:
            proc = subprocess.Popen([str(codex), "exec", "-s", "workspace-write", "--skip-git-repo-check", "-C",
                                     str(directory), "-o", str(directory / "last.txt"), prompt],
                                    stdin=devnull, stdout=log, stderr=subprocess.STDOUT)
            (directory / "pid").write_text(str(proc.pid))
            try:
                code = proc.wait(timeout=timeout)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait()
                code = "timeout"
    out = directory / "output.png"
    return {"seconds": round(time.time() - t0, 1), "exit": code, "output": out.exists()}


# ---------------------------------------------------------------------------------------------------- orchestration
@dataclass
class Job:
    fd: FrameData
    category: str
    spec: ObjectSpec
    directory: Path
    damaged: bool = False  # frame 1 of a building: redrawn with the accepted frame 0 as a material reference
    intact: "Job | None" = None
    status: str = "pending"  # ACCEPTED / FALLBACK / FLAGGED / SKIPPED
    chosen: int | None = None  # accepted attempt number
    attempts: list[dict] = field(default_factory=list)
    redraw: Redraw | None = None
    notes: list[str] = field(default_factory=list)


def canvas_offset(cache: rd.MapCache, ref: rd.FrameRef) -> tuple[int, int]:
    f = cache.manifest["sprites"][ref.sprite]["frames"][ref.frame]
    return int(f["offset"][0]), int(f["offset"][1])


def reference_4x(job: Job) -> np.ndarray:
    """The accepted redraw at 4x (registered model image with the 2x colour correction applied) on flat grey."""
    r = job.redraw
    assert r is not None and r.reg4 is not None
    m4 = 4 * MARGIN
    h, w = job.fd.alpha1.shape
    lab4 = rd.srgb_to_lab(r.reg4)
    corr2 = rd.srgb_to_lab(r.displayed) - rd.srgb_to_lab(r.raw2)
    corr4 = np.stack([np.asarray(Image.fromarray(corr2[..., c].astype(np.float32), mode="F").resize(
        (w * 4, h * 4), Image.BILINEAR)) for c in range(3)], -1)
    lab4[m4:m4 + 4 * h, m4:m4 + 4 * w] += corr4
    rgb = np.clip(rd.lab_to_srgb(lab4), 0, 255)
    known = np.zeros((h + 2 * MARGIN, w + 2 * MARGIN), np.float32)
    known[MARGIN:MARGIN + h, MARGIN:MARGIN + w] = job.fd.alpha1
    a4 = rd.smooth_alpha(known, 4)
    return rgb * a4[..., None] + GREY * (1 - a4[..., None])


def consistency(cache: rd.MapCache, job0: Job, job1: Job) -> dict:
    """Frame 1 vs frame 0 where the two ORIGINAL frames look alike at the same canvas position.

    Damaged art is re-rendered, so identical palette indices are rare; "alike" is a per-texel CIE76 difference below
    8 after a light blur, eroded by one texel so that edges of the damage are excluded."""
    x0, y0 = canvas_offset(cache, job0.fd.ref)
    x1, y1 = canvas_offset(cache, job1.fd.ref)
    r0, r1 = job0.fd.ref.rect, job1.fd.ref.rect
    ox0, oy0 = max(x0, x1), max(y0, y1)
    ox1, oy1 = min(x0 + r0[2], x1 + r1[2]), min(y0 + r0[3], y1 + r1[3])
    if ox1 <= ox0 or oy1 <= oy0:
        return {"same_frac": 0.0}
    s0 = (slice(oy0 - y0, oy1 - y0), slice(ox0 - x0, ox1 - x0))
    s1 = (slice(oy0 - y1, oy1 - y1), slice(ox0 - x1, ox1 - x1))
    a0, a1 = job0.fd.alpha1[s0], job1.fd.alpha1[s1]
    both = a0 & a1
    lab0 = rd.srgb_to_lab(rd.masked_blur(job0.fd.art1[s0], both.astype(np.float32), 0.7))
    lab1 = rd.srgb_to_lab(rd.masked_blur(job1.fd.art1[s1], both.astype(np.float32), 0.7))
    same = erode(both & (np.sqrt(((lab0 - lab1) ** 2).sum(-1)) < 8.0), 1)
    out = {"same_frac": round(float(same.sum() / max(1, job1.fd.alpha1.sum())), 4)}
    if same.sum() < 64 or job0.redraw is None or job1.redraw is None:
        return out
    d0 = job0.redraw.displayed[2 * (oy0 - y0):2 * (oy1 - y0), 2 * (ox0 - x0):2 * (ox1 - x0)]
    d1 = job1.redraw.displayed[2 * (oy0 - y1):2 * (oy1 - y1), 2 * (ox0 - x1):2 * (ox1 - x1)]
    s2 = same.repeat(2, 0).repeat(2, 1)
    wgt = s2.astype(np.float32)
    l0 = rd.masked_blur(rd.srgb_to_lab(d0), wgt, 2.0)
    l1 = rd.masked_blur(rd.srgb_to_lab(d1), wgt, 2.0)
    de = np.sqrt(((l0 - l1) ** 2).sum(-1))[s2]
    e0 = rd.sobel(rd.masked_blur(luminance(d0), wgt, 1.0))[s2]
    e1 = rd.sobel(rd.masked_blur(luminance(d1), wgt, 1.0))[s2]
    t0 = np.abs(luminance(d0) - rd.masked_blur(luminance(d0), wgt, 1.0))[s2].mean()
    t1 = np.abs(luminance(d1) - rd.masked_blur(luminance(d1), wgt, 1.0))[s2].mean()
    out.update({"dE_mean": round(float(de.mean()), 2), "dE_p95": round(float(np.percentile(de, 95)), 2),
                "edge_corr": round(pearson(e0, e1), 4), "texture_ratio": round(float(t1 / max(t0, 1e-6)), 3)})
    return out


def attempt_score(m: dict) -> tuple:
    return (len(m["failures"]), -m["edge_corr_s2"])


class Runner:
    def __init__(self, args: argparse.Namespace, cache: rd.MapCache):
        self.args = args
        self.cache = cache
        self.lock = threading.Lock()
        self.thresholds = dict(DEFAULT_THRESHOLDS)
        if args.thresholds:
            self.thresholds.update(json.loads(Path(args.thresholds).read_text()))
        self.calls = 0
        self.call_seconds = 0.0

    def log(self, msg: str) -> None:
        with self.lock:
            print(time.strftime("%H:%M:%S"), msg, flush=True)

    def prepare(self, job: Job) -> tuple[np.ndarray, dict]:
        job.directory.mkdir(parents=True, exist_ok=True)
        inp_path, meta_path = job.directory / "input.png", job.directory / "meta.json"
        if inp_path.exists() and meta_path.exists():
            return load_rgb(inp_path), json.loads(meta_path.read_text())
        canvas, meta = model_input(job.fd, None if self.args.upscaler == "lanczos" else Path(self.args.realesrgan),
                                   self.args.lock)
        Image.fromarray(to_u8(canvas)).save(inp_path)
        meta_path.write_text(json.dumps(meta, indent=1))
        return canvas, meta

    def prepare_style(self, job: Job, meta: dict) -> None:
        """The style reference crop at the model input's size (style_reference.png), when the job has one."""
        if job.fd.style1 is None:
            return
        path = job.directory / "style_reference.png"
        if not path.exists():
            cw, ch = meta["canvas"]
            Image.fromarray(to_u8(job.fd.style1)).resize((cw, ch), Image.LANCZOS).save(path)

    def max_attempts(self, job: Job) -> int:
        return int(self.args.attempts.get(job.category, self.args.max_attempts))

    def params(self, job: Job) -> tuple[float, float, float]:
        s = self.args.sigma.get(job.category, self.args.sigma["default"])
        return s[0], s[1], s[2]

    def evaluate_attempt(self, job: Job, adir: Path, canvas: np.ndarray, meta: dict) -> dict | None:
        out = adir / "raw.png" if (adir / "raw.png").exists() else adir / "output.png"
        if not out.exists():
            return None
        raw = load_rgb(out)
        # A raw image with a different aspect than the canvas is unusable only if wildly off (model re-framed).
        sl, sab, lock = self.params(job)
        redraw = postprocess(job.fd, meta, canvas, raw, sl, sab, lock)
        m = checks(job.fd, redraw, job.category, self.thresholds)
        Image.fromarray(redraw.rgba).save(adir / "hybrid_2x.png")
        Image.fromarray(to_u8(redraw.reg4)).save(adir / "registered_4x.png")
        m["source"] = out.name
        return {"metrics": m, "redraw": redraw}

    def run_job(self, job: Job) -> None:
        canvas, meta = self.prepare(job)
        self.prepare_style(job, meta)
        if job.category in self.args.faithful_categories:
            # Category decision (e.g. trees stay faithful): existing attempts are only evaluated for the review.
            best = None
            for k in range(1, 100):
                adir = job.directory / f"attempt{k}"
                if not (adir / "prompt.txt").exists():
                    break
                result = self.evaluate_attempt(job, adir, canvas, meta)
                if result is None:
                    job.attempts.append({"attempt": k, "error": "no output"})
                    continue
                job.attempts.append({"attempt": k, "metrics": result["metrics"]})
                if best is None or attempt_score(result["metrics"]) < attempt_score(best[1]["metrics"]):
                    best = (k, result)
            job.status = "FALLBACK"
            job.chosen, job.redraw = (best[0], best[1]["redraw"]) if best else (None, None)
            job.notes.append(f"category decision: {job.category} keeps the faithful version")
            return
        if job.damaged:
            if job.intact is None or job.intact.status != "ACCEPTED":
                job.status = "FALLBACK"
                job.notes.append("frame 0 was not accepted; the damaged frame keeps the faithful version for "
                                 "consistency")
                return
            ref4 = reference_4x(job.intact)
        hints: list[str] = []
        best = None
        limit = self.max_attempts(job)
        for k in range(1, limit + 1):
            adir = job.directory / f"attempt{k}"
            result = None
            if adir.exists() and (adir / "prompt.txt").exists():
                result = self.evaluate_attempt(job, adir, canvas, meta)
            elif self.args.dry_run:
                break
            else:
                adir.mkdir(parents=True, exist_ok=True)
                shutil.copy(job.directory / "input.png", adir / "input.png")
                if job.damaged:
                    Image.fromarray(to_u8(ref4)).save(adir / "reference_intact.png")
                style = (job.directory / "style_reference.png").exists()
                if style:
                    shutil.copy(job.directory / "style_reference.png", adir / "style_reference.png")
                prompt = build_prompt(job.category, job.spec, hints, job.damaged, style)
                self.log(f"{job.fd.key} attempt {k}: calling the image model (hints {hints})")
                info = run_codex(Path(self.args.codex), adir, prompt, self.args.timeout)
                with self.lock:
                    self.calls += 1
                    self.call_seconds += info["seconds"]
                (adir / "call.json").write_text(json.dumps(info))
                self.log(f"{job.fd.key} attempt {k}: {info}")
                result = self.evaluate_attempt(job, adir, canvas, meta)
            if result is None:
                job.attempts.append({"attempt": k, "error": "no output"})
                continue
            m = result["metrics"]
            if job.damaged and job.intact is not None:
                job.redraw = result["redraw"]
                m["consistency"] = consistency(self.cache, job.intact, job)
                c = m["consistency"]
                lo_t, hi_t = self.thresholds["consistency_texture"]
                if "dE_mean" in c and (c["dE_mean"] > self.thresholds["consistency_dE"]
                                       or not lo_t <= c["texture_ratio"] <= hi_t):
                    m["failures"].append({"check": "f_consistency", "detail": f"frame 0/1 dE {c['dE_mean']}, texture "
                                          f"ratio {c['texture_ratio']}", "hint": "consistency"})
                    m["passed"] = False
            (adir / "metrics.json").write_text(json.dumps(m, indent=1))
            job.attempts.append({"attempt": k, "metrics": m})
            self.log(f"{job.fd.key} attempt {k}: {'PASS' if m['passed'] else 'FAIL'} "
                     f"{[f['check'] + ' ' + f['detail'] for f in m['failures']]}")
            if best is None or attempt_score(m) < attempt_score(best[1]["metrics"]):
                best = (k, result)
            if m["passed"]:
                job.status, job.chosen, job.redraw = "ACCEPTED", k, result["redraw"]
                return
            hints += [f["hint"] for f in m["failures"]]
        job.redraw = best[1]["redraw"] if best else None
        job.chosen = best[0] if best else None
        done = len(job.attempts) >= limit
        job.status = "FLAGGED" if done else "PENDING"
        if done:
            job.notes.append(f"no attempt passed in {limit}; faithful version used, best attempt "
                             f"{job.chosen} kept for review")


def build_jobs(args: argparse.Namespace, cache: rd.MapCache, faithful: np.ndarray | None) -> list[tuple[Job, ...]]:
    descriptions = json.loads(Path(args.describe).read_text())
    ns = argparse.Namespace(region_box=args.region_box, sprites=args.sprites, include=args.include,
                            exclude=args.exclude, frames="used")
    refs, owners = rd.select_frames(cache, ns)
    groups: list[tuple[Job, ...]] = []
    work = Path(args.work)
    style = None
    if args.style_ref:
        style = load_rgb(Path(args.style_ref))
        box = args.region_box
        if box is None or style.shape[:2] != (box[3] - box[1], box[2] - box[0]):
            raise SystemExit("--style-ref must cover --region-box exactly at 1x")
    for ref in refs:
        cat = ref.category
        d = descriptions.get(ref.sprite)
        if d is None:
            continue
        spec = ObjectSpec(d["subject"], d["colours"], d.get("noun", "building" if cat == "building" else
                                                             ("tree" if cat == "tree" else "object")))
        fd = frame_data(cache, ref, owners.get(ref.sprite), faithful)
        job = Job(fd, cat, spec, work / ref.key.replace(":", "_").replace("#", "_"))
        if style is not None and args.region_box:
            job.notes.append(json.dumps(attach_style(fd, cache, args.region_box, style, args.style_lock_l)))
        if cat == "building" and args.damaged and ref.frame == 0:
            e = cache.manifest["sprites"][ref.sprite]
            if len(e["frames"]) > 1:
                f1 = e["frames"][1]
                r1 = rd.FrameRef(ref.sprite, 1, tuple(f1["rect"]), e["palette"], bool(e["remap"]))
                spec1 = ObjectSpec(d.get("subject_damaged", d["subject"] + ", heavily damaged"), d["colours"],
                                   spec.noun)
                j1 = Job(frame_data(cache, r1, owners.get(ref.sprite), faithful), cat, spec1,
                         work / r1.key.replace(":", "_").replace("#", "_"), damaged=True, intact=job)
                groups.append((job, j1))
                continue
        groups.append((job,))
    return groups


def compose_atlas(base_rgba: np.ndarray, jobs: list[Job]) -> tuple[np.ndarray, int]:
    """Copy of the base (faithful) atlas with accepted redraws written in; everything else untouched."""
    atlas = base_rgba.copy()
    n = 0
    for job in jobs:
        if job.status == "ACCEPTED" and job.redraw is not None:
            x, y, w, h = job.fd.ref.rect
            dst = atlas[2 * y:2 * (y + h), 2 * x:2 * (x + w)]
            if not np.array_equal(dst[..., 3], job.redraw.rgba[..., 3]):
                raise ValueError(f"{job.fd.key}: alpha differs from the base atlas")
            dst[...] = job.redraw.rgba
            n += 1
    return atlas, n


def parse_sigma(values: list[str]) -> dict[str, tuple[float, float, float]]:
    out = {"default": (6.0, 4.0, 1.0), "tree": (4.0, 3.0, 1.0), "overlay": (4.0, 3.0, 1.0)}
    for v in values or []:
        k, _, nums = v.partition("=")
        parts = tuple(float(x) for x in nums.split(","))
        if len(parts) != 3:
            raise ValueError("--sigma category=sigma_l,sigma_ab,lock")
        out[k] = parts
    return out


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("stage", choices=("prepare", "run", "compose"))
    p.add_argument("--map", required=True)
    p.add_argument("--cache", type=Path)
    p.add_argument("--work", type=Path, required=True, help="work directory (one folder per frame); untracked")
    p.add_argument("--region-box", type=rd.parse_box)
    p.add_argument("--sprites", nargs="*")
    p.add_argument("--include", nargs="*")
    p.add_argument("--exclude", nargs="*")
    p.add_argument("--describe", required=True,
                   help="JSON {sprite id: {subject, colours[, noun, subject_damaged]}}; sprites without an entry are "
                        "skipped")
    p.add_argument("--damaged", action="store_true", help="also redraw frame 1 of buildings (after frame 0)")
    p.add_argument("--faithful", type=Path, help="faithful atlas: fallback frames and the compose base")
    p.add_argument("--realesrgan", type=Path)
    p.add_argument("--upscaler", choices=("esrgan", "lanczos"), default="esrgan")
    p.add_argument("--lock", nargs="*", help="command prefix that serialises local GPU jobs (Real-ESRGAN)")
    p.add_argument("--codex", type=Path, help="codex CLI binary (image model agent)")
    p.add_argument("--parallel", type=int, default=4, help="concurrent image-model calls")
    p.add_argument("--timeout", type=float, default=1200)
    p.add_argument("--max-attempts", type=int, default=4, help="first try plus retries")
    p.add_argument("--faithful-categories", nargs="*", default=[],
                   help="categories that keep the faithful frames (attempts are evaluated for review only)")
    p.add_argument("--attempts", nargs="*", default=[], help="per-category attempt limit, e.g. tree=1")
    p.add_argument("--dry-run", action="store_true", help="evaluate existing attempts only, no new calls")
    p.add_argument("--thresholds", help="JSON overriding DEFAULT_THRESHOLDS")
    p.add_argument("--sigma", nargs="*", help="category=sigma_l,sigma_ab,lock (2x pixels) for the colour lock")
    p.add_argument("--out", type=Path, help="compose: output atlas PNG (never the cache's own files)")
    p.add_argument("--report", type=Path, help="decisions and metrics JSON (default <work>/decisions.json)")
    p.add_argument("--style-ref", type=Path, help="style reference image aligned to --region-box at 1x (see above)")
    p.add_argument("--style-lock-l", type=float, default=0.0,
                   help="share (0..1) of the low-frequency lightness target taken from the style reference")
    return p


def main(argv: list[str] | None = None) -> int:
    global _CODEX_SLOTS
    args = build_parser().parse_args(argv)
    args.sigma = parse_sigma(args.sigma)
    args.attempts = {k: int(v) for k, _, v in (a.partition("=") for a in args.attempts)}
    cache_root, _ = resolve_paths(args.cache, None)
    args.realesrgan = args.realesrgan or (MAIN_REPO / "gameres/tools/realesrgan/realesrgan-ncnn-vulkan")
    directory = (cache_root / args.map).resolve()
    cache = rd.MapCache(directory, None, None)
    faithful = None
    if args.faithful:
        with Image.open(args.faithful) as im:
            faithful = np.asarray(im.convert("RGBA")).copy()
        if faithful.shape != cache.hd.shape:
            raise SystemExit("faithful atlas size differs from the HD atlas")
    groups = build_jobs(args, cache, faithful)
    if not groups:
        raise SystemExit("no frames selected (check --describe)")
    runner = Runner(args, cache)
    _CODEX_SLOTS = threading.Semaphore(max(1, args.parallel))
    started = time.time()
    if args.stage == "prepare":
        for g in groups:
            for job in g:
                _, meta = runner.prepare(job)
                runner.prepare_style(job, meta)
                runner.log(f"prepared {job.fd.key} {' '.join(job.notes)}")
        return 0
    if args.stage == "run" and not args.dry_run and not args.codex:
        raise SystemExit("--codex is required for run")

    def run_group(g: tuple[Job, ...]) -> None:
        for job in g:
            try:
                runner.run_job(job)
            except Exception as exc:  # noqa: BLE001 (one broken frame must not stop the batch)
                job.status = "FLAGGED"
                job.notes.append(f"error: {exc!r}")
                runner.log(f"{job.fd.key}: error {exc!r}")

    if args.stage in ("run", "compose"):
        if args.stage == "compose":
            args.dry_run = True
        with ThreadPoolExecutor(max_workers=max(1, args.parallel)) as pool:
            list(pool.map(run_group, groups))
    jobs = [j for g in groups for j in g]
    report = {"map": args.map, "thresholds": runner.thresholds, "sigma": args.sigma,
              "calls_this_run": runner.calls, "call_seconds_this_run": round(runner.call_seconds, 1),
              "seconds_this_run": round(time.time() - started, 1), "frames": {}}
    for job in jobs:
        report["frames"][job.fd.key] = {
            "status": job.status, "chosen_attempt": job.chosen, "notes": job.notes, "category": job.category,
            "rect": list(job.fd.ref.rect), "attempts": job.attempts}
    report_path = args.report or Path(args.work) / "decisions.json"
    report_path.write_text(json.dumps(report, indent=1))
    runner.log(f"wrote {report_path}")
    if args.stage == "compose" and args.out:
        if args.out.resolve() in (cache.base_atlas_path.resolve(), cache.base_remap_path.resolve()):
            raise SystemExit("--out must not overwrite the cache's atlas")
        base = faithful if faithful is not None else cache.hd
        atlas, n = compose_atlas(base, jobs)
        Image.fromarray(atlas).save(args.out)
        runner.log(f"wrote {args.out} ({n} redrawn frames)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
