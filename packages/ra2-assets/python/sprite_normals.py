#!/usr/bin/env python3
"""Per-pixel normals, glass and occlusion for a map cache's HD building and tree sprites.

The renderer draws original SHP art as camera-facing cards whose shading is baked by the artists' fixed light. To relight
those cards with the HD scene's sun (an opt-in look, see packages/hd-renderer src/ra2/spriteLook.ts) it needs to know
which way each pixel faces. RA2 buildings are axis-aligned boxes seen by one fixed isometric camera, so almost every
visible pixel is a roof (facing up), a wall facing +z (the left-hand walls on screen) or a wall facing +x (right-hand
walls). This tool classifies every pixel of the selected frames into those three faces and writes a material atlas with
exactly the layout of the HD sprite atlas (sprites@2x.png):

* R, G: world normal x and z, as n * 0.5 + 0.5 (y = sqrt(1 - x^2 - z^2): every visible surface faces up or sideways);
* B: specular class: 1 glass (dark window panes), about 0.25 smooth roofs, about 0.08 matte facades, 0.04 foliage;
* A: ambient occlusion (0.3 .. 1, baked contact and crevice darkening), and 0 = no data (the renderer then keeps the
  original shading exactly). Every texel of a processed frame rectangle carries data, so filtering at the art's edge
  never mixes with "no data".

Classification (buildings). Walls carry vertical lines (window columns, corners) plus horizontal lines that run along
their own axis: on screen, +z walls show lines along world x (image direction (2, 1)) and +x walls lines along world z
(image direction (-2, 1)). Roofs show both diagonals and no verticals. Oriented gradient energies give per-pixel
evidence; a geometric prior (walls left of the foundation's front corner face +z, right of it +x) and a guided filter
over the art's luminance (face boundaries are shading steps in the baked light) turn it into clean faces. Trees get a
dome normal from their silhouette plus a little leaf relief.

Image-model assist (``--assist``, the hybrid route): a directory of camera-space normal renders, one per frame, named
``<sprite id with ':' as '_'>#<frame>.png`` at the frame's 2x size on black (standard normal-map colours: roof
(128, 238, 191), left walls (38, 83, 206), right walls (218, 83, 206)). A render is aligned to the art by the best
whole-pixel shift of its silhouette and then checked against the original: silhouette IoU, the art's own shading (the
baked light comes from +z, so the art must be brighter on the render's +z walls than on its +x walls), agreement with
the classification above and the geometric side prior. A render that passes supplies the normals (curved parts
included); one that fails is flagged in the sidecar and the classification is used instead.

Everything read or written is derived game art: keep it in gameres/ (or another untracked directory).
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import sys
import time
from pathlib import Path

import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))
from rematerialize import atomic_image, atomic_json, gaussian_blur  # noqa: E402

VERSION = 1
SCALE = 2

# Camera basis in world space (world x = cell x, z = cell y, y up; see hd-renderer src/world.ts IsoCamera): the view
# looks down 30 degrees from the +x+z side.
_C30 = math.cos(math.pi / 6)
CAM_RIGHT = np.array([math.sqrt(0.5), 0.0, -math.sqrt(0.5)])
CAM_UP = np.array([-0.5 * math.sqrt(0.5), _C30, -0.5 * math.sqrt(0.5)])
CAM_TOWARDS = np.array([_C30 * math.sqrt(0.5), 0.5, _C30 * math.sqrt(0.5)])

FACE_NORMALS = np.array([[0.0, 1.0, 0.0], [0.0, 0.0, 1.0], [1.0, 0.0, 0.0]], np.float32)  # roof, +z wall, +x wall
ROOF, WALL_Z, WALL_X = 0, 1, 2

# Image-space unit vectors (x right, y down) normal to each family of lines: verticals, world-x lines (2, 1) and
# world-z lines (-2, 1).
LINE_NORMALS = {
    "v": (1.0, 0.0),
    "a": (-1 / math.sqrt(5), 2 / math.sqrt(5)),
    "b": (1 / math.sqrt(5), 2 / math.sqrt(5)),
}

SPEC_GLASS = 1.0
# Window panes at 2x: a dark (or blue) component of a wall is a pane when it survives at most this many erosions
# (thinner than about 17 px), or twice that when the night-window extractor lit most of it.
PANE_MAX_THICKNESS = 8
# Holes of up to this many pixels inside a pane (curtains, a lighter reflection painted into the art) count as glass.
PANE_MAX_HOLE = 160
# Dark components grow into neighbouring wall pixels at most this much brighter (luminance 0..1) per pixel.
PANE_GROWTH_STEP = 0.035
SPEC_ROOF = 0.25
SPEC_FACADE = 0.08
SPEC_FOLIAGE = 0.04
AO_FLOOR = 0.3


# ------------------------------------------------------------------------------------------------ small image helpers
def luminance(rgb: np.ndarray) -> np.ndarray:
    return rgb[..., 0] * 0.299 + rgb[..., 1] * 0.587 + rgb[..., 2] * 0.114


def masked_blur(values: np.ndarray, weight: np.ndarray, sigma: float) -> np.ndarray:
    """Gaussian average over `weight` only (normalised convolution)."""
    w = gaussian_blur(weight.astype(np.float32), sigma)
    if values.ndim == 3:
        v = gaussian_blur(values * weight[..., None], sigma)
        return v / np.maximum(w, 1e-6)[..., None]
    return gaussian_blur(values * weight, sigma) / np.maximum(w, 1e-6)


def box(values: np.ndarray, r: int) -> np.ndarray:
    """Mean over a (2r+1)^2 window with clamped edges, via an integral image."""
    p = np.pad(values, ((r + 1, r), (r + 1, r)), mode="edge").astype(np.float64)
    s = p.cumsum(0).cumsum(1)
    k = 2 * r + 1
    out = s[k:, k:] - s[:-k, k:] - s[k:, :-k] + s[:-k, :-k]
    return (out / (k * k)).astype(np.float32)


def guided_filter(guide: np.ndarray, source: np.ndarray, r: int, eps: float) -> np.ndarray:
    """He et al.'s guided filter (grey guide): smooths `source` while keeping the guide's edges."""
    mean_i = box(guide, r)
    mean_p = box(source, r)
    cov = box(guide * source, r) - mean_i * mean_p
    var = box(guide * guide, r) - mean_i * mean_i
    a = cov / (var + eps)
    b = mean_p - a * mean_i
    return box(a, r) * guide + box(b, r)


def dilate_fill(values: np.ndarray, known: np.ndarray, steps: int) -> np.ndarray:
    """Spread known values into unknown pixels ring by ring (4-neighbour average)."""
    out = values.copy()
    filled = known.copy()
    for _ in range(steps):
        if filled.all():
            break
        acc = np.zeros_like(out)
        n = np.zeros(filled.shape, np.float32)
        for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            src = np.roll(np.roll(out, dy, 0), dx, 1)
            ok = np.roll(np.roll(filled, dy, 0), dx, 1).astype(np.float32)
            if dy == 1:
                ok[0] = 0
            elif dy == -1:
                ok[-1] = 0
            if dx == 1:
                ok[:, 0] = 0
            elif dx == -1:
                ok[:, -1] = 0
            acc += src * (ok[..., None] if out.ndim == 3 else ok)
            n += ok
        grow = (~filled) & (n > 0)
        if out.ndim == 3:
            out[grow] = acc[grow] / n[grow][:, None]
        else:
            out[grow] = acc[grow] / n[grow]
        filled |= grow
    return out


def label_components(mask: np.ndarray) -> tuple[np.ndarray, int]:
    """4-connected component labels of a boolean mask (0 = outside, 1..n), numpy only: every pixel starts with its own
    index, takes the smallest index among its masked neighbours and then the label of the pixel that index names
    (pointer jumping), until nothing changes."""
    h, w = mask.shape
    big = h * w
    lab = np.where(mask, np.arange(big, dtype=np.int64).reshape(h, w), big)
    while True:
        m = lab.copy()
        np.minimum(m[1:], lab[:-1], out=m[1:])
        np.minimum(m[:-1], lab[1:], out=m[:-1])
        np.minimum(m[:, 1:], lab[:, :-1], out=m[:, 1:])
        np.minimum(m[:, :-1], lab[:, 1:], out=m[:, :-1])
        m = np.where(mask, m, big)
        flat = m.ravel()
        inside = flat < big
        for _ in range(4):
            flat[inside] = flat[flat[inside]]
        if np.array_equal(m, lab):
            break
        lab = m
    labels = np.zeros((h, w), np.int32)
    if mask.any():
        _, inverse = np.unique(lab[mask], return_inverse=True)
        labels[mask] = inverse.astype(np.int32) + 1
        return labels, int(inverse.max()) + 1
    return labels, 0


def max_filter(values: np.ndarray, r: int) -> np.ndarray:
    """Maximum over a (2r+1)^2 window (separable; edges clamped)."""
    out = values.copy()
    for axis in (0, 1):
        acc = out.copy()
        for d in range(1, r + 1):
            fwd = np.roll(out, d, axis)
            bwd = np.roll(out, -d, axis)
            if axis == 0:
                fwd[:d] = out[:1]
                bwd[-d:] = out[-1:]
            else:
                fwd[:, :d] = out[:, :1]
                bwd[:, -d:] = out[:, -1:]
            np.maximum(acc, fwd, out=acc)
            np.maximum(acc, bwd, out=acc)
        out = acc
    return out


def erosion_depth(mask: np.ndarray, cap: int) -> np.ndarray:
    """Per pixel, how many 4-neighbour erosions of `mask` it survives (0 on the edge), up to `cap`."""
    depth = np.zeros(mask.shape, np.int32)
    cur = mask.copy()
    for _ in range(cap):
        nxt = cur.copy()
        nxt[1:] &= cur[:-1]
        nxt[:-1] &= cur[1:]
        nxt[:, 1:] &= cur[:, :-1]
        nxt[:, :-1] &= cur[:, 1:]
        nxt[0] = nxt[-1] = False
        nxt[:, 0] = nxt[:, -1] = False
        if not nxt.any():
            break
        depth += nxt
        cur = nxt
    return depth


def fill_small_holes(mask: np.ndarray, max_area: int) -> np.ndarray:
    """`mask` with every enclosed hole (a component of its complement not touching the image edge) of at most
    `max_area` pixels filled."""
    holes, n = label_components(~mask)
    if n == 0:
        return mask.copy()
    area = np.bincount(holes.ravel(), minlength=n + 1)
    edge = np.zeros(n + 1, bool)
    for line in (holes[0], holes[-1], holes[:, 0], holes[:, -1]):
        edge[line] = True
    fill = (area <= max_area) & ~edge
    fill[0] = False
    return mask | fill[holes]


def oriented_energy(y: np.ndarray, weight: np.ndarray, sigma: float, sharpness: int = 6) -> dict[str, np.ndarray]:
    """Gradient energy of each line family, tuned with cos^(2 * sharpness) of the angle to its normal."""
    yb = gaussian_blur(y, 0.9)
    gx = np.zeros_like(yb)
    gy = np.zeros_like(yb)
    gx[:, 1:-1] = (yb[:, 2:] - yb[:, :-2]) * 0.5
    gy[1:-1, :] = (yb[2:, :] - yb[:-2, :]) * 0.5
    m2 = gx * gx + gy * gy
    inv = 1.0 / np.sqrt(np.maximum(m2, 1e-12))
    ux, uy = gx * inv, gy * inv
    out = {}
    for key, (nx, ny) in LINE_NORMALS.items():
        c = (ux * nx + uy * ny) ** 2
        out[key] = masked_blur(m2 * c**sharpness, weight, sigma)
    return out


def to_world(n_cam: np.ndarray) -> np.ndarray:
    """Camera-space normals (x right, y up, z towards the camera) to world normals."""
    return n_cam[..., 0:1] * CAM_RIGHT + n_cam[..., 1:2] * CAM_UP + n_cam[..., 2:3] * CAM_TOWARDS


def to_camera(n_world: np.ndarray) -> np.ndarray:
    return np.stack([n_world @ CAM_RIGHT, n_world @ CAM_UP, n_world @ CAM_TOWARDS], axis=-1)


def normalise(v: np.ndarray) -> np.ndarray:
    return v / np.maximum(np.linalg.norm(v, axis=-1, keepdims=True), 1e-6)


def relief(y: np.ndarray, weight: np.ndarray, strength: float, sigma: float = 1.6) -> np.ndarray:
    """Camera-space tilt (dx, dy) from the art's fine luminance relief: brighter reads as raised."""
    detail = y - masked_blur(y, weight, sigma)
    detail = np.clip(detail, -0.25, 0.25) * weight
    gx = np.zeros_like(detail)
    gy = np.zeros_like(detail)
    gx[:, 1:-1] = (detail[:, 2:] - detail[:, :-2]) * 0.5
    gy[1:-1, :] = (detail[2:, :] - detail[:-2, :]) * 0.5
    # Image y points down; camera-space y up.
    return np.stack([-gx * strength, gy * strength], axis=-1)


# ------------------------------------------------------------------------------------------------ classification
def column_runs(mask: np.ndarray) -> np.ndarray:
    """Per pixel, the distance (px) down its column to the first pixel outside `mask`."""
    h, w = mask.shape
    out = np.zeros((h, w), np.float32)
    run = np.zeros(w, np.float32)
    for y in range(h - 1, -1, -1):
        run = np.where(mask[y], run + 1, 0)
        out[y] = run
    return out


def classify_building(
    rgb: np.ndarray,
    alpha: np.ndarray,
    corner_x: float | None,
    corner_width: float,
) -> tuple[np.ndarray, dict]:
    """Soft face probabilities (h, w, 3: roof, +z wall, +x wall) for one building frame at 2x."""
    h, w = alpha.shape
    weight = (alpha > 0.5).astype(np.float32)
    y = luminance(rgb)
    energy = oriented_energy(y, weight, sigma=5.0)
    ev, ea, eb = energy["v"], energy["a"], energy["b"]
    total = ev + ea + eb + 1e-5
    fv, fa, fb = ev / total, ea / total, eb / total
    # Texture strength: how much the evidence counts against the priors.
    strength = np.clip(np.sqrt(total) / 0.05, 0, 1)
    score = np.stack(
        [
            fa + fb - 2.0 * fv,  # roof
            fv + fa - 2.0 * fb,  # +z wall
            fv + fb - 2.0 * fa,  # +x wall
        ],
        axis=-1,
    ) * (4.0 * strength)[..., None]
    # Geometric prior: left of the front corner the visible wall faces +z, right of it +x.
    if corner_x is not None:
        xs = (np.arange(w, dtype=np.float32) + 0.5)[None, :]
        side = np.tanh((xs - corner_x) / max(corner_width, 1.0))  # -1 left .. +1 right
        score[..., WALL_Z] += -1.2 * side
        score[..., WALL_X] += 1.2 * side
    # Walls stand on the ground: pixels near the bottom of their column are wall, the upper part of a column's run
    # leans roof only when its texture says so (no prior).
    below = column_runs(alpha > 0.5)
    near_ground = np.exp(-below / 24.0)
    score[..., ROOF] -= 1.5 * near_ground
    prob = np.exp(score - score.max(-1, keepdims=True))
    prob /= prob.sum(-1, keepdims=True)
    # Edge-aware smoothing guided by the baked shading (face boundaries are shading steps).
    guide = gaussian_blur(y, 0.7)
    for k in range(3):
        p = masked_blur(prob[..., k], weight, 2.0)
        prob[..., k] = guided_filter(guide, p, 10, 0.004)
    prob = np.clip(prob, 1e-4, None)
    prob /= prob.sum(-1, keepdims=True)
    stats = {
        "roof": float((prob.argmax(-1) == ROOF)[alpha > 0.5].mean()) if weight.any() else 0.0,
        "wallZ": float((prob.argmax(-1) == WALL_Z)[alpha > 0.5].mean()) if weight.any() else 0.0,
        "wallX": float((prob.argmax(-1) == WALL_X)[alpha > 0.5].mean()) if weight.any() else 0.0,
    }
    return prob, stats


def building_material(
    rgb: np.ndarray,
    alpha: np.ndarray,
    prob: np.ndarray,
    lit_windows: np.ndarray | None,
    normal_in: np.ndarray | None = None,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """World normals, specular class and occlusion of a classified building frame (normal_in: accepted render)."""
    weight = (alpha > 0.5).astype(np.float32)
    y = luminance(rgb)
    # Faces stay flat with narrow bevels: sharpen the soft classes before blending their normals.
    sharp = prob**3
    sharp /= sharp.sum(-1, keepdims=True)
    face = normalise(sharp @ FACE_NORMALS) if normal_in is None else normal_in
    cam = to_camera(face)
    tilt = relief(y, weight, strength=2.2)
    cam[..., 0] += tilt[..., 0]
    cam[..., 1] += tilt[..., 1]
    normal = normalise(to_world(normalise(cam)))
    wall = sharp[..., WALL_Z] + sharp[..., WALL_X]
    glass = glass_panes(rgb, weight, sharp, lit_windows)
    grey = 1 - np.clip((rgb.max(-1) - rgb.min(-1) - 0.06) / 0.1, 0, 1)
    roof_spec = SPEC_FACADE + (SPEC_ROOF - SPEC_FACADE) * grey * np.clip(y / 0.5, 0, 1)
    spec = sharp[..., ROOF] * roof_spec + wall * SPEC_FACADE
    spec = spec * (1 - glass) + SPEC_GLASS * glass
    # Occlusion: walls darken towards whatever they stand on (the ground or a lower roof), roofs next to a wall that
    # rises above them.
    is_wall = wall > 0.5
    height_above = column_runs(is_wall & (weight > 0))
    ao_wall = 1 - 0.32 * np.exp(-height_above / 10.0)
    is_roof = (sharp[..., ROOF] > 0.5) & (weight > 0)
    # Distance up the column from a roof pixel to a wall pixel directly above it (the foot of a higher tier).
    hgt, wid = is_roof.shape
    up = np.full((hgt, wid), 1e3, np.float32)
    run = np.full(wid, 1e3, np.float32)
    for yy in range(hgt):
        run = np.where(is_wall[yy] & (weight[yy] > 0), 0, np.where(is_roof[yy], run + 1, 1e3))
        up[yy] = run
    ao_roof = 1 - 0.28 * np.exp(-up / 8.0)
    ao = np.where(is_wall, ao_wall, np.where(is_roof, ao_roof, 1.0))
    ao = masked_blur(ao, weight, 1.2)
    return normal, spec.astype(np.float32), ao.astype(np.float32)


def glass_panes(
    rgb: np.ndarray,
    weight: np.ndarray,
    sharp: np.ndarray,
    lit_windows: np.ndarray | None,
) -> np.ndarray:
    """Window glass of a building frame at 2x (0..1), found pane by pane.

    Candidates are wall pixels darker than the facade around them (or blue glass) that are not warm-coloured (brick,
    wood), plus every pane the night-window extractor lit. Each 4-connected candidate component is one pane (or a run
    of panes) when it is thin (PANE_MAX_THICKNESS erosions; doubled when mostly lit at night), does not sit among roof
    pixels (rooftop units, parapets) and covers at least a few pixels; wide dark areas (arcades, recesses, ground
    floors) are not glass. Small enclosed holes (curtains, a lighter centre, the art's texture) are filled before the
    thickness is measured, so a pane is glass all over, never a ring around its dark centre.
    """
    y = luminance(rgb)
    art = weight > 0
    wall = sharp[..., WALL_Z] + sharp[..., WALL_X]
    roof = sharp[..., ROOF]
    local = masked_blur(y, weight, 5.0)
    dark = (0.78 * local - y) > 0.125 * np.maximum(local, 0.08)
    # Warm relative to its own brightness: dark brick, wood, stained stone and a ruin's openings are brown, panes are
    # grey or blue.
    warm = (rgb[..., 0] - rgb[..., 2]) > 0.3 * (y + 0.05)
    blue = (rgb[..., 2] - np.maximum(rgb[..., 0], rgb[..., 1]) > 0.06) & (y < 0.75 * np.maximum(local, 0.1))
    lit = lit_windows > 0.5 if lit_windows is not None else np.zeros_like(art)
    candidates = art & (wall > 0.5) & (((dark | blue) & ~warm) | lit)
    # Close the pores of the art's texture, then let every dark component take in the connected wall pixels about as
    # dark as itself: a pane stops at its lighter frame, while the dark core of a wide opening (whose lower part is
    # only "dark" against the bright cornice above it) grows to the whole opening and is measured as the wide area it
    # is, instead of leaving an arch-shaped patch of glass.
    candidates = fill_small_holes(candidates, PANE_MAX_HOLE) & art
    labels, n = label_components(candidates)
    if n == 0:
        return np.zeros(y.shape, np.float32)
    # Growth follows smooth shading only (at most PANE_GROWTH_STEP brighter than the neighbour it grows from): the
    # sharp step to a pane's frame stops it, the soft light gradient inside a recess does not.
    allowed = art & (wall > 0.5) & ~warm
    for _ in range(24):
        changed = False
        for axis, d in ((0, 1), (0, -1), (1, 1), (1, -1)):
            q = np.roll(labels, d, axis)
            yq = np.roll(y, d, axis)
            edge = [slice(None)] * 2
            edge[axis] = slice(0, 1) if d == 1 else slice(-1, None)
            q[tuple(edge)] = 0
            take = (labels == 0) & (q > 0) & allowed & (y <= yq + PANE_GROWTH_STEP)
            if take.any():
                labels = np.where(take, q, labels)
                changed = True
        if not changed:
            break
    candidates = labels > 0
    count = lambda values: np.bincount(labels.ravel(), weights=values.ravel(), minlength=n + 1)  # noqa: E731
    area = np.bincount(labels.ravel(), minlength=n + 1).astype(np.float32)
    depth = erosion_depth(candidates, 2 * PANE_MAX_THICKNESS + 2)
    thick = np.zeros(n + 1, np.int32)
    np.maximum.at(thick, labels.ravel(), depth.ravel())
    lit_share = count(lit.astype(np.float32)) / np.maximum(area, 1)
    # Rooftop units and parapets stand among roof pixels; panes have wall around them.
    roofish = count(box(roof * weight, 6)) / np.maximum(area, 1)
    # A pane is clearly darker than the frame around it (a ring two pixels wide); a stain or a shaded patch is not.
    ring_labels = max_filter(labels, 2) * (~candidates & art)
    ring_y = np.bincount(ring_labels.ravel(), weights=y.ravel(), minlength=n + 1)
    ring_n = np.bincount(ring_labels.ravel(), minlength=n + 1)
    inner_y = count(y) / np.maximum(area, 1)
    contrast = ring_y / np.maximum(ring_n, 1) - inner_y
    ok = (area >= 4) & (roofish < 0.4) & ((contrast > 0.06) | (lit_share > 0.4))
    ok &= (thick <= PANE_MAX_THICKNESS) | ((lit_share > 0.4) & (thick <= 2 * PANE_MAX_THICKNESS))
    ok[0] = False
    panes = ok[labels]
    panes = panes & (roof < 0.6)
    # Full glass inside, a slightly softer one-pixel rim.
    return np.where(panes, np.where(erosion_depth(panes, 1) > 0, 1.0, 0.9), 0.0).astype(np.float32)


def tree_material(rgb: np.ndarray, alpha: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Dome normals from the canopy silhouette plus leaf relief; foliage occlusion darkens the lower canopy."""
    weight = (alpha > 0.5).astype(np.float32)
    h, w = alpha.shape
    radius = max(4.0, 0.22 * math.sqrt(weight.sum() / math.pi))
    height = gaussian_blur(weight, radius)
    gx = np.zeros_like(height)
    gy = np.zeros_like(height)
    gx[:, 1:-1] = (height[:, 2:] - height[:, :-2]) * 0.5
    gy[1:-1, :] = (height[2:, :] - height[:-2, :]) * 0.5
    k = 2.2 * radius
    cam = np.stack([-gx * k, gy * k, np.ones_like(gx)], axis=-1)
    y = luminance(rgb)
    tilt = relief(y, weight, strength=3.0, sigma=1.2)
    cam[..., 0] += tilt[..., 0]
    cam[..., 1] += tilt[..., 1]
    normal = normalise(to_world(normalise(cam)))
    ys = np.arange(h, dtype=np.float32)[:, None] / max(h - 1, 1)
    inner = np.clip(height * 2.0, 0, 1)
    ao = 1 - 0.25 * ys * inner - 0.1 * (1 - inner)
    spec = np.full((h, w), SPEC_FOLIAGE, np.float32)
    return normal, spec, ao.astype(np.float32)


# ------------------------------------------------------------------------------------------------ image-model assist
def shift(image: np.ndarray, dx: int, dy: int, fill: float = 0.0) -> np.ndarray:
    out = np.full_like(image, fill)
    h, w = image.shape[:2]
    ys, yd = (slice(0, h - dy), slice(dy, h)) if dy >= 0 else (slice(-dy, h), slice(0, h + dy))
    xs, xd = (slice(0, w - dx), slice(dx, w)) if dx >= 0 else (slice(-dx, w), slice(0, w + dx))
    out[yd, xd] = image[ys, xs]
    return out


def load_assist(path: Path, alpha: np.ndarray, reach: int = 8) -> dict | None:
    """An image-model normal render aligned to the art: world normals, its mask, the shift and the silhouette IoU."""
    if not path.exists():
        return None
    h, w = alpha.shape
    with Image.open(path) as im:
        rgb = np.asarray(im.convert("RGB"), np.float32) / 255.0
    if rgb.shape[:2] != (h, w):
        rgb = np.asarray(Image.fromarray((rgb * 255).astype(np.uint8)).resize((w, h), Image.LANCZOS), np.float32) / 255.0
    mask = rgb.max(-1) > 0.15
    art = alpha > 0.5
    best = (-1.0, 0, 0)
    for dy in range(-reach, reach + 1):
        for dx in range(-reach, reach + 1):
            m = shift(mask, dx, dy, False)
            iou = float((m & art).sum() / max(1, (m | art).sum()))
            if iou > best[0]:
                best = (iou, dx, dy)
    iou, dx, dy = best
    rgb = shift(rgb, dx, dy)
    mask = shift(mask, dx, dy, False)
    cam = normalise(rgb * 2 - 1)
    return {"normal": normalise(to_world(cam)), "mask": mask, "iou": iou, "shift": [dx, dy]}


def check_assist(
    assist: dict,
    rgb: np.ndarray,
    alpha: np.ndarray,
    prob: np.ndarray,
    corner_x: float | None,
) -> dict:
    """Checks of an aligned render against the original art (see the module docstring)."""
    art = (alpha > 0.5) & assist["mask"]
    n = assist["normal"]
    y = luminance(rgb)
    wall_z = art & (n[..., 2] > 0.8)
    wall_x = art & (n[..., 0] > 0.8)
    roof = art & (n[..., 1] > 0.8)
    lum_z = float(y[wall_z].mean()) if wall_z.sum() > 50 else None
    lum_x = float(y[wall_x].mean()) if wall_x.sum() > 50 else None
    faces = np.stack([n[..., 1], n[..., 2], n[..., 0]], -1).argmax(-1)
    agreement = float((faces == prob.argmax(-1))[art].mean()) if art.any() else 0.0
    side = None
    if corner_x is not None:
        xs = np.arange(alpha.shape[1])[None, :]
        left = (wall_z | wall_x) & (xs < corner_x - 12)
        right = (wall_z | wall_x) & (xs > corner_x + 12)
        if left.sum() > 50 and right.sum() > 50:
            side = float((wall_z & left).sum() / left.sum() * 0.5 + (wall_x & right).sum() / right.sum() * 0.5)
    return {
        "iou": round(assist["iou"], 4),
        "shift": assist["shift"],
        "coverage": {
            "roof": round(float(roof.sum() / max(1, art.sum())), 3),
            "wallZ": round(float(wall_z.sum() / max(1, art.sum())), 3),
            "wallX": round(float(wall_x.sum() / max(1, art.sum())), 3),
        },
        "shadingRatioZX": round(lum_z / lum_x, 3) if lum_z is not None and lum_x else None,
        "agreementWithClassifier": round(agreement, 3),
        "sidePrior": round(side, 3) if side is not None else None,
    }


def assist_passes(check: dict, min_iou: float) -> tuple[bool, list[str]]:
    reasons = []
    if check["iou"] < min_iou:
        reasons.append(f"silhouette IoU {check['iou']} < {min_iou}")
    ratio = check["shadingRatioZX"]
    if ratio is not None and ratio < 0.95:
        reasons.append(f"art is not brighter on +z walls than on +x walls (ratio {ratio})")
    side = check["sidePrior"]
    if side is not None and side < 0.55:
        reasons.append(f"wall sides contradict the foundation corner (score {side})")
    return (not reasons, reasons)


# ------------------------------------------------------------------------------------------------ cache and driver
class Cache:
    def __init__(self, directory: Path, atlas: str | None):
        self.dir = directory
        self.manifest = json.loads((directory / "manifest.json").read_text())
        hd = self.manifest.get("spriteAtlasHd")
        if not hd or hd.get("scale") != SCALE:
            raise ValueError("the cache needs a 2x HD sprite atlas (manifest.spriteAtlasHd)")
        self.hd_path = directory / (atlas or hd["file"])
        with Image.open(self.hd_path) as im:
            self.hd = np.asarray(im.convert("RGBA"), np.float32) / 255.0
        with Image.open(directory / self.manifest["spriteAtlas"]["file"]) as im:
            a = np.asarray(im)
        self.index = a[..., 0] if a.ndim == 3 else a
        if self.hd.shape[:2] != (self.index.shape[0] * SCALE, self.index.shape[1] * SCALE):
            raise ValueError("HD atlas must be exactly twice the indexed atlas")
        self.windows = None
        path = directory / "windows.png"
        if path.exists():
            with Image.open(path) as im:
                w = np.asarray(im.convert("RGBA"))
            if w.shape[:2] == self.index.shape:
                self.windows = (w[..., 0] > 0).astype(np.float32)


def frames_to_process(manifest: dict, prefixes: list[str]) -> list[tuple[str, int, dict, dict]]:
    out = []
    seen = set()
    for sid, entry in manifest["sprites"].items():
        if not any(sid.startswith(p) for p in prefixes):
            continue
        for fi, frame in enumerate(entry.get("frames") or []):
            rect = tuple(frame["rect"])
            if frame.get("page", 0) != 0 or rect[2] < 2 or rect[3] < 2 or rect in seen:
                continue
            seen.add(rect)
            out.append((sid, fi, frame, entry))
    return out


def process(args: argparse.Namespace) -> Path:
    cache = Cache(Path(args.cache).resolve(), args.atlas)
    manifest = cache.manifest
    H2, W2 = cache.hd.shape[:2]
    out = np.zeros((H2, W2, 4), np.float32)
    frames = frames_to_process(manifest, args.sprites)
    if args.only:
        frames = [f for f in frames if any(f[0] == o or f"{f[0]}#{f[1]}" == o for o in args.only)]
    assist_dir = Path(args.assist).resolve() if args.assist else None
    debug = Path(args.debug_dir).resolve() if args.debug_dir else None
    if debug:
        debug.mkdir(parents=True, exist_ok=True)
    report: dict[str, dict] = {}
    t0 = time.time()
    for sid, fi, frame, entry in frames:
        x, y, w, h = frame["rect"]
        sl = (slice(SCALE * y, SCALE * (y + h)), slice(SCALE * x, SCALE * (x + w)))
        rgba = cache.hd[sl]
        index = cache.index[y:y + h, x:x + w]
        coverage = np.repeat(np.repeat(index > 0, SCALE, 0), SCALE, 1)
        alpha = np.where(coverage, rgba[..., 3], 0.0)
        rgb = rgba[..., :3]
        category = sid.split(":", 1)[0]
        info: dict = {"category": category}
        if category == "tree":
            normal, spec, ao = tree_material(rgb, alpha)
        else:
            foundation = entry.get("foundation") or [1, 1]
            fw, fh = foundation
            # Screen x of the foundation's front (bottom) corner relative to the frame's left edge, at 2x (the draw
            # point is the foundation's top corner, see sprites.ts objectAnchor with drawOffset (0, 0)).
            corner_x = SCALE * (30 * (fw - fh) - frame["offset"][0])
            corner_x = corner_x if 0 < corner_x < SCALE * w else None
            prob, stats = classify_building(rgb, alpha, corner_x, SCALE * 6.0)
            info.update(stats)
            key = f"{sid}#{fi}"
            normal_in = None
            info["source"] = "classifier"
            if assist_dir:
                assist = load_assist(assist_dir / f"{key.replace(':', '_')}.png", alpha)
                if assist is not None:
                    check = check_assist(assist, rgb, alpha, prob, corner_x)
                    ok, reasons = assist_passes(check, args.assist_iou)
                    check["accepted"] = ok
                    if reasons:
                        check["reasons"] = reasons
                    info["assist"] = check
                    if ok:
                        # The render supplies the normals inside its own silhouette; art pixels it missed take the
                        # nearest rendered normal.
                        art = alpha > 0.5
                        known = assist["mask"] & art
                        filled = dilate_fill(assist["normal"], known, steps=24)
                        reach = dilate_mask(known, 24)
                        fallback = normalise(prob @ FACE_NORMALS)
                        normal_in = normalise(np.where(reach[..., None], filled, fallback))
                        n = normal_in
                        prob = np.clip(np.stack([n[..., 1], n[..., 2], n[..., 0]], -1), 1e-3, None)
                        prob /= prob.sum(-1, keepdims=True)
                        info["source"] = "assist"
            lit = None
            if cache.windows is not None:
                lit = np.repeat(np.repeat(cache.windows[y:y + h, x:x + w], SCALE, 0), SCALE, 1)
            normal, spec, ao = building_material(rgb, alpha, prob, lit, normal_in)
            if debug:
                save_debug(debug, sid, fi, rgb, alpha, prob, normal, spec, ao)
        known = alpha > 0.5
        if not known.any():
            continue
        # Fill the whole frame rectangle so filtering at the art's edge never meets "no data".
        packed = np.concatenate([normal[..., [0, 2]], spec[..., None], np.clip(ao, AO_FLOOR, 1)[..., None]], -1)
        packed = dilate_fill(packed, known, steps=12)
        packed[~known & ~(dilate_mask(known, 12))] = packed[known].mean(0)
        out[sl][..., 0] = packed[..., 0] * 0.5 + 0.5
        out[sl][..., 1] = packed[..., 1] * 0.5 + 0.5
        out[sl][..., 2] = np.clip(packed[..., 2], 0, 1)
        out[sl][..., 3] = np.clip(packed[..., 3], AO_FLOOR, 1)
        report[f"{sid}#{fi}"] = info
    elapsed = time.time() - t0
    target = cache.dir / args.out
    atomic_image(target, np.round(out * 255).astype(np.uint8))
    digest = hashlib.sha256(cache.hd_path.read_bytes()).hexdigest()
    sidecar = {
        "version": VERSION,
        "file": args.out,
        "atlas": cache.hd_path.name,
        "atlasSha256": digest,
        "width": W2,
        "height": H2,
        "scale": SCALE,
        "encoding": {
            "r": "world normal x * 0.5 + 0.5",
            "g": "world normal z * 0.5 + 0.5 (y = sqrt(1 - x^2 - z^2))",
            "b": f"specular class: glass {SPEC_GLASS}, smooth roof {SPEC_ROOF}, facade {SPEC_FACADE}, foliage {SPEC_FOLIAGE}",
            "a": f"ambient occlusion {AO_FLOOR}..1; 0 = no data (original shading kept)",
        },
        "frames": report,
        "seconds": round(elapsed, 1),
    }
    atomic_json(cache.dir / args.sidecar, sidecar)
    print(f"wrote {target} ({len(report)} frames, {elapsed:.1f} s)")
    return target


def dilate_mask(mask: np.ndarray, steps: int) -> np.ndarray:
    out = mask.copy()
    for _ in range(steps):
        grown = out.copy()
        grown[1:] |= out[:-1]
        grown[:-1] |= out[1:]
        grown[:, 1:] |= out[:, :-1]
        grown[:, :-1] |= out[:, 1:]
        out = grown
    return out


def save_debug(directory: Path, sid: str, fi: int, rgb, alpha, prob, normal, spec, ao) -> None:
    """Art | faces (roof green, +z blue, +x red) | camera-space normals | glass | occlusion, side by side."""
    art = alpha > 0.5
    faces = prob @ np.array([[0.35, 0.8, 0.35], [0.3, 0.45, 0.95], [0.95, 0.35, 0.35]], np.float32)
    cam = to_camera(np.stack([normal[..., 0], np.sqrt(np.clip(1 - normal[..., 0] ** 2 - normal[..., 2] ** 2, 0, 1)),
                              normal[..., 2]], -1))
    panels = [rgb, faces, cam * 0.5 + 0.5, np.repeat(spec[..., None], 3, -1), np.repeat(ao[..., None], 3, -1)]
    tiles = []
    for p in panels:
        t = np.where(art[..., None], p, 0.1)
        tiles.append(np.clip(t, 0, 1))
    gap = np.full((rgb.shape[0], 6, 3), 0.0, np.float32)
    sheet = np.concatenate(sum(([t, gap] for t in tiles), [])[:-1], 1)
    Image.fromarray((sheet * 255).astype(np.uint8)).save(directory / f"{sid.replace(':', '_')}_{fi}.png")


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    p.add_argument("--cache", required=True, help="map cache directory (gameres/hd-cache/<map>)")
    p.add_argument("--atlas", help="HD atlas file in the cache (default: manifest.spriteAtlasHd.file)")
    p.add_argument("--out", default="sprites@2x-normals.png", help="output atlas file name (written into the cache)")
    p.add_argument("--sidecar", default="normals.json", help="sidecar file name (written into the cache)")
    p.add_argument("--sprites", nargs="+", default=["building:", "tree:"], help="sprite id prefixes to process")
    p.add_argument("--only", nargs="*", help="restrict to these sprite ids or sprite#frame keys (debugging)")
    p.add_argument("--assist", help="directory of image-model normal renders named <sprite>_<id>#<frame>.png")
    p.add_argument("--assist-iou", type=float, default=0.88, help="minimum silhouette IoU to accept a render")
    p.add_argument("--debug-dir", help="write per-frame debug sheets here")
    return p


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    process(args)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
