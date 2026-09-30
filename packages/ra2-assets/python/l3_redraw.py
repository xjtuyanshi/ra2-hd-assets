#!/usr/bin/env python3
"""Plan-driven building redraw sheets for map caches and paged type libraries.

Stages: prepare, run, compose, delta. All derived art belongs in gameres/ or outside the checkout. A plan is a JSON
list of jobs; each job supplies its complete prompt and ordered panels/parts. No model call is made by prepare,
compose, delta or run --no-model. FLAGGED results remain available for review and are included by compose.
Delta --body accepts any sprite:frame, including anim:NAPOWR_A:0 as a redrawn reference for frames 1-18
of that animation. --unrelated keep preserves unrelated overlays; the default add retains additive transfer.
"""
from __future__ import annotations

import argparse
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait
from dataclasses import dataclass
import json
import math
import os
from pathlib import Path
import re
import shlex
import shutil
import sys
import tempfile
import threading

import numpy as np
from PIL import Image

import hybrid_redraw as hr
import redetail_sprites as rd

# Library pages can exceed Pillow's decompression-bomb limit even though they are trusted local assets.
Image.MAX_IMAGE_PIXELS = None
GAP = 48
BORDER = 32
DEFAULT_LOCK = {"wL": 0.35, "sL": 12.0, "wab": 0.7, "sab": 4.0, "edge_hf": 0.75}
DEFAULT_THRESHOLDS = {**hr.DEFAULT_THRESHOLDS, "lf_dE_mean": 12.0, "lf_dE_p95": 28.0, "decoration_ratio": 0.9}
REPO = Path(__file__).resolve().parents[3]


class Source:
    """Lazy, bounded page cache. Frame methods return small copies, never views retaining an entire atlas."""

    def __init__(self, directory: Path, kind: str):
        self.dir = Path(directory).resolve()
        self.kind = kind
        self.manifest = json.loads((self.dir / ("library.json" if kind == "library" else "manifest.json")).read_text())
        self._loaded: dict[tuple[int, str], np.ndarray] = {}
        self._palettes: dict[str, np.ndarray] = {}
        self._mutex = threading.RLock()
        self.cache_bytes = 384 * 1024 * 1024  # One 8192 RGBA page plus its index/mask; evict least recently used pages.
        m = self.manifest
        self._index = m["spriteAtlases"] if kind == "library" else [m["spriteAtlas"]]
        self._hd = m["spriteAtlasesHd"] if kind == "library" else [m["spriteAtlasHd"]]

    @classmethod
    def map(cls, cache_dir: Path) -> Source:
        return cls(cache_dir, "map")

    @classmethod
    def library(cls, library_dir: Path) -> Source:
        return cls(library_dir, "library")

    @property
    def cache_root(self) -> Path:
        return self.dir.parent.parent if self.kind == "library" else self.dir.parent

    def sprite(self, sid: str) -> dict:
        return self.manifest["sprites"][sid]

    def frame(self, sid: str, fi: int) -> dict:
        frames = self.sprite(sid)["frames"]
        if not 0 <= fi < len(frames):
            raise ValueError(f"{sid}: frame {fi} outside 0..{len(frames) - 1}")
        return frames[fi]

    def ref(self, sid: str, fi: int) -> rd.FrameRef:
        s = self.sprite(sid)
        return rd.FrameRef(sid, fi, tuple(self.frame(sid, fi)["rect"]), s["palette"], bool(s.get("remap")))

    def offset(self, sid: str, fi: int) -> tuple[int, int]:
        return tuple(self.frame(sid, fi)["offset"])

    def page_number(self, sid: str, fi: int) -> int:
        return int(self.frame(sid, fi).get("page", 0))

    def page_files(self, page: int) -> dict:
        hd = self._hd[page]
        if not hd or hd.get("scale", 2) != 2:
            raise ValueError(f"page {page}: a 2x HD atlas is required")
        return {"page": page, "file": self._index[page]["file"], "hd": hd["file"], "remap": hd["remap"]}

    def pages(self) -> list[dict]:
        return [self.page_files(i) for i, hd in enumerate(self._hd) if hd]

    def _page(self, page: int, kind: str) -> np.ndarray:
        key = (page, kind)
        with self._mutex:
            if key in self._loaded:
                value = self._loaded.pop(key)
                self._loaded[key] = value
                return value
            name = self.page_files(page)[kind]
            with Image.open(self.dir / name) as im:
                # Indexed PNGs may be P, L, or replicated RGB; do not convert P to luminance.
                value = np.asarray(im if kind == "file" else im.convert("RGBA" if kind == "hd" else "L"))
                if kind == "file" and value.ndim == 3:
                    value = value[..., 0].copy()
            while self._loaded and sum(a.nbytes for a in self._loaded.values()) + value.nbytes > self.cache_bytes:
                self._loaded.pop(next(iter(self._loaded)))
            self._loaded[key] = value
            return value

    def _crop(self, sid: str, fi: int, kind: str, scale: int) -> np.ndarray:
        x, y, w, h = self.frame(sid, fi)["rect"]
        page = self._page(self.page_number(sid, fi), kind)
        if min(x, y) < 0 or min(w, h) <= 0 or scale * (x + w) > page.shape[1] or scale * (y + h) > page.shape[0]:
            raise ValueError(f"{sid}#{fi}: frame outside {kind} page")
        return page[scale * y:scale * (y + h), scale * x:scale * (x + w)].copy()

    def house_ramp(self, name_or_index: str | int | None = None) -> np.ndarray | None:
        m = self.manifest
        if self.kind == "library":
            schemes = m.get("colorSchemes", [])
            if not schemes and name_or_index is None:
                return None
            names = m.get("colorSchemesByName", {})
            i = 0 if name_or_index is None else names.get(str(name_or_index), name_or_index)
            if not str(i).isdigit() or not 0 <= int(i) < len(schemes):
                raise ValueError(f"unknown house colour scheme {name_or_index!r}")
            ramp = schemes[int(i)]["remap"]
        else:
            houses = m.get("houses", {})
            if not houses and name_or_index is None:
                return None
            name = next(iter(houses), None) if name_or_index is None else name_or_index
            if name not in houses and str(name).isdigit() and int(name) < len(houses):
                name = list(houses)[int(name)]
            if name not in houses:
                raise ValueError(f"unknown map house {name_or_index!r}")
            ramp = houses[name]["remap"]
        result = np.asarray(ramp, np.float32)
        if result.shape != (16, 3):
            raise ValueError("house ramp must contain 16 RGB colours")
        return result

    def frame_1x(self, sid: str, fi: int, house: str | int | np.ndarray | None = None
                 ) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        ref = self.ref(sid, fi)
        with self._mutex:
            if ref.palette not in self._palettes:
                with Image.open(self.dir / self.manifest["palettes"][ref.palette]) as im:
                    self._palettes[ref.palette] = np.asarray(im.convert("RGB"), np.float32).reshape(-1, 3)
            pal = self._palettes[ref.palette].copy()
        ramp = house if isinstance(house, np.ndarray) else self.house_ramp(house)
        if ref.remap and ramp is not None:
            pal[16:32] = ramp
        idx = self._crop(sid, fi, "file", 1).astype(np.int32)
        return pal[idx], idx > 0, (idx >= 16) & (idx <= 31) & ref.remap

    def frame_hd(self, sid: str, fi: int) -> tuple[np.ndarray, np.ndarray]:
        return self._crop(sid, fi, "hd", 2), self._crop(sid, fi, "remap", 2)

    def data(self, sid: str, fi: int, house: np.ndarray | None) -> hr.FrameData:
        art, alpha, _ = self.frame_1x(sid, fi, house)
        rgba, paint = self.frame_hd(sid, fi)
        return hr.FrameData(self.ref(sid, fi), art, alpha, rgba, paint, house)


@dataclass
class Part:
    fd: hr.FrameData
    rect: tuple[int, int, int, int]  # 1x rectangle relative to the composite origin, excluding the margin
    offset: tuple[int, int]
    page: int
    paste: bool
    paint1: np.ndarray | None = None


@dataclass
class Panel:
    label: str
    fd: hr.FrameData
    parts: list[Part]
    origin: tuple[int, int]
    paint1: np.ndarray | None = None  # Visible original palette paint index (16..31), or zero for non-paint.


def over(rgb: np.ndarray, alpha: np.ndarray, top: np.ndarray, coverage: np.ndarray,
         rect: tuple[int, int, int, int]) -> None:
    """Straight-alpha source-over in display space; inputs/outputs use floating coverage in [0,1]."""
    x, y, w, h = rect
    dst, da = rgb[y:y + h, x:x + w], alpha[y:y + h, x:x + w]
    a = coverage.astype(np.float32)
    union = a + da * (1 - a)
    dst[:] = (top * a[..., None] + dst * (da * (1 - a))[..., None]) / np.maximum(union[..., None], 1e-8)
    da[:] = union


def composite_hd(parts: list[Part], size: tuple[int, int], frames: list[np.ndarray] | None = None
                 ) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Composite encoded colour, paint coverage and decoded colour separately (decoding is nonlinear)."""
    w, h = size
    rgb, shown = np.zeros((2 * h, 2 * w, 3), np.float32), np.zeros((2 * h, 2 * w, 3), np.float32)
    paint = np.zeros((2 * h, 2 * w, 1), np.float32)
    alpha = np.zeros((2 * h, 2 * w), np.float32)
    for i, part in enumerate(parts):
        rgba = part.fd.base if frames is None else frames[i]
        a = rgba[..., 3].astype(np.float32) / 255
        rect = tuple(2 * v for v in part.rect)
        over(shown, alpha.copy(), part.fd.displayed(rgba), a, rect)
        over(paint, alpha.copy(), part.fd.base_paint[..., None].astype(np.float32), a, rect)
        over(rgb, alpha, rgba[..., :3].astype(np.float32), a, rect)
    return np.dstack((hr.to_u8(rgb), hr.to_u8(alpha * 255))), hr.to_u8(paint[..., 0]), shown


def build_panels(source: Source, job: dict) -> list[Panel]:
    grid = grid_settings(job)
    house = source.house_ramp(job.get("house"))
    result = []
    for spec in job["panels"]:
        items = []
        for p in spec["parts"]:
            sid, fi = p["sprite"], int(p.get("frame", 0))
            fd = source.data(sid, fi, house)
            items.append((p, fd, source.offset(sid, fi), source.page_number(sid, fi)))
        if not items:
            raise ValueError(f"{job['id']}: panel has no parts")
        left, top = min(i[2][0] for i in items), min(i[2][1] for i in items)
        right = max(x + fd.alpha1.shape[1] for _, fd, (x, _), _ in items)
        bottom = max(y + fd.alpha1.shape[0] for _, fd, (_, y), _ in items)
        w, h = right - left, bottom - top
        art, alpha = np.zeros((h, w, 3), np.float32), np.zeros((h, w), np.float32)
        parts = []
        for p, fd, (x, y), page in items:
            rect = (x - left, y - top, fd.alpha1.shape[1], fd.alpha1.shape[0])
            over(art, alpha, fd.art1, fd.alpha1, rect)
            parts.append(Part(fd, rect, (x, y), page, p.get("paste", True)))
        base, paint, _ = composite_hd(parts, (w, h))
        ref = rd.FrameRef(f"building:{job['id']}/{len(result)}", 0, (0, 0, w, h), "composite",
                          any(p.fd.ref.remap for p in parts))
        result.append(Panel(spec.get("label", str(len(result))),
                            hr.FrameData(ref, art, alpha > 0, base, paint, house), parts, (left, top)))
    if not result:
        raise ValueError(f"{job['id']}: no panels")
    if grid is not None:
        align_panels(source, result)
    return result


def grid_settings(job: dict) -> dict | None:
    if "layout" not in job:
        return None
    settings = job["layout"]
    if not isinstance(settings, dict) or settings.get("align") != "anchor":
        raise ValueError("layout requires align: anchor")
    cols, gap = settings.get("cols"), settings.get("gap", GAP)
    if type(cols) is not int or cols < 1 or type(gap) is not int or gap < 0:
        raise ValueError("layout cols must be a positive integer and gap a non-negative integer")
    if any(type(settings.get(key, False)) is not bool for key in ("sequence", "stabilize")):
        raise ValueError("layout sequence and stabilize must be booleans")
    return {"cols": cols, "align": "anchor", "gap": gap,
            "sequence": settings.get("sequence", False), "stabilize": settings.get("stabilize", False)}


def align_panels(source: Source, panels: list[Panel]) -> None:
    """Rebase every composite onto the same anchor-relative union, retaining each part's own frame data."""
    left, top = min(p.origin[0] for p in panels), min(p.origin[1] for p in panels)
    right = max(p.origin[0] + p.fd.alpha1.shape[1] for p in panels)
    bottom = max(p.origin[1] + p.fd.alpha1.shape[0] for p in panels)
    w, h = right - left, bottom - top
    for panel in panels:
        art, alpha = np.zeros((h, w, 3), np.float32), np.zeros((h, w), np.float32)
        paint1 = np.zeros((h, w), np.uint8)
        for part in panel.parts:
            pw, ph = part.rect[2:]
            x, y = part.offset[0] - left, part.offset[1] - top
            part.rect = (x, y, pw, ph)
            over(art, alpha, part.fd.art1, part.fd.alpha1, part.rect)
            idx = source._crop(part.fd.ref.sprite, part.fd.ref.frame, "file", 1)
            paint = np.where(part.fd.ref.remap & (idx >= 16) & (idx <= 31), idx, 0)
            part.paint1 = paint
            target = paint1[y:y + ph, x:x + pw]
            target[part.fd.alpha1] = paint[part.fd.alpha1]
        base, paint, _ = composite_hd(panel.parts, (w, h))
        ref = rd.FrameRef(panel.fd.ref.sprite, 0, (0, 0, w, h), "composite", panel.fd.ref.remap)
        panel.fd = hr.FrameData(ref, art, alpha > 0, base, paint, panel.fd.house)
        panel.origin, panel.paint1 = (left, top), paint1


def make_layout(source: Source, job: dict, panels: list[Panel]) -> dict:
    grid = grid_settings(job)
    if grid is not None:
        w, h = panels[0].fd.alpha1.shape[1], panels[0].fd.alpha1.shape[0]
        if any(p.origin != panels[0].origin or p.fd.alpha1.shape != (h, w) for p in panels):
            raise ValueError("grid panels must share an anchor-aligned box")
        cw, ch = (w + 2 * hr.MARGIN) * 4, (h + 2 * hr.MARGIN) * 4
        cols, gap = grid["cols"], grid["gap"]
        rows = math.ceil(len(panels) / cols)
        return {"version": 1, "source": source.kind, "source_dir": str(source.dir), "house": job.get("house"),
                "margin": hr.MARGIN, "gap": gap, "enlarge": 1,
                "canvas": [cols * cw + (cols - 1) * gap, rows * ch + (rows - 1) * gap],
                "grid": {**grid, "rows": rows, "cell": [cw, ch], "common_box": [*panels[0].origin, w, h]},
                "panels": [{"label": p.label, "box": [(k % cols) * (cw + gap), (k // cols) * (ch + gap), cw, ch],
                            "scale4": [cw, ch], "origin": list(p.origin),
                            "parts": [{"sprite": part.fd.ref.sprite, "frame": part.fd.ref.frame, "page": part.page,
                                       "rect": list(part.rect), "offset": list(part.offset), "paste": part.paste}
                                      for part in p.parts]} for k, p in enumerate(panels)]}
    sizes = [((p.fd.alpha1.shape[1] + 16) * 4, (p.fd.alpha1.shape[0] + 16) * 4) for p in panels]
    width, height = sum(w for w, _ in sizes) + GAP * (len(sizes) - 1), max(h for _, h in sizes)
    factor = 1 if max(width, height) >= hr.ENLARGE_BELOW else math.ceil(hr.MIN_LONG_SIDE / max(width, height))
    layout = {"version": 1, "source": source.kind, "source_dir": str(source.dir), "house": job.get("house"),
              "margin": hr.MARGIN, "gap": GAP, "enlarge": factor, "canvas": [width * factor, height * factor],
              "panels": []}
    x = 0
    for panel, (w, h) in zip(panels, sizes):
        layout["panels"].append({"label": panel.label, "box": [x * factor, ((height - h) // 2) * factor,
                                                            w * factor, h * factor],
                                 "scale4": [w, h], "origin": list(panel.origin),
                                 "parts": [{"sprite": p.fd.ref.sprite, "frame": p.fd.ref.frame, "page": p.page,
                                            "rect": list(p.rect), "offset": list(p.offset), "paste": p.paste}
                                           for p in panel.parts]})
        x += w + GAP
    return layout


def art_directory(path: Path) -> Path:
    """Reject derived-art output in source-controlled portions of this checkout, including symlink escapes."""
    path = Path(path).absolute()
    resolved = path.resolve()
    if resolved.is_relative_to(REPO) and not resolved.is_relative_to((REPO / "gameres").resolve()):
        raise ValueError(f"derived art must stay in gameres/ or outside the checkout: {path}")
    return path


class ConcurrentWriteError(ValueError):
    """The destination changed while a replacement was being prepared."""


def file_stamp(path: Path) -> tuple | None:
    try:
        stat = path.lstat()
        return stat.st_mtime_ns, stat.st_size, stat.st_ino, stat.st_mode
    except FileNotFoundError:
        return None


def atomic_json(path: Path, value: object, *, expected=Ellipsis) -> None:
    atomic_write(path, lambda tmp: tmp.write_text(json.dumps(value, indent=2, allow_nan=False) + "\n"), expected=expected)


def atomic_write(path: Path, write, *, expected=Ellipsis) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=path.suffix, dir=path.parent)
    os.close(fd)
    tmp = Path(name)
    try:
        write(tmp)
        if expected is not Ellipsis and file_stamp(path) != expected:
            raise ConcurrentWriteError(f"{path}: changed during update")
        os.replace(tmp, path)  # Replace a symlink itself, never its source file.
    finally:
        tmp.unlink(missing_ok=True)


def save_image(path: Path, array: np.ndarray) -> None:
    atomic_write(path, lambda tmp: Image.fromarray(hr.to_u8(array)).save(tmp))


def copy_inputs(job: dict, directory: Path, force: bool = False) -> None:
    images = dict(job.get("extra_images", {}))
    if job.get("style_reference"):
        images["style_reference.png"] = job["style_reference"]
    for name, filename in images.items():
        if Path(name).name != name or name in {"input.png", "output.png", "raw.png", "layout.json", "metrics.json",
                                              "prompt.txt", "run.log", "last.txt", "pid"} or not name.endswith(".png"):
            raise ValueError(f"invalid extra image filename: {name}")
        dst = directory / name
        if force or not dst.exists():
            # Preserve supplied PNGs verbatim; a JPEG style reference still needs a genuine .png in the call directory.
            with Image.open(filename) as im:
                if im.format == "PNG":
                    atomic_write(dst, lambda tmp: shutil.copyfile(filename, tmp))
                else:
                    atomic_write(dst, lambda tmp: im.save(tmp, format="PNG"))


def prepare_job(source: Source, job: dict, work: Path, esrgan: Path | None = None,
                gpu_lock: list[str] | None = None, force: bool = False) -> dict:
    panels = build_panels(source, job)
    layout = make_layout(source, job, panels)
    directory = art_directory(work / job["id"])
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / "input.png"
    if path.exists() and not force:
        with Image.open(path) as im:
            if list(im.size) != layout["canvas"]:
                raise ValueError(f"{job['id']}: existing input has another size; use --force to prepare again")
        if (directory / "layout.json").exists() and json.loads((directory / "layout.json").read_text()) != layout:
            raise ValueError(f"{job['id']}: existing layout differs; use --force to prepare again")
    else:
        f = layout["enlarge"]
        canvas = np.full((layout["canvas"][1] // f, layout["canvas"][0] // f, 3), 118, np.uint8)
        for panel, meta in zip(panels, layout["panels"]):
            image = hr.model_input_4x(panel.fd, esrgan, gpu_lock)
            x, y, w, h = (v // f for v in meta["box"])
            canvas[y:y + h, x:x + w] = hr.to_u8(image)
        im = Image.fromarray(canvas)
        if f != 1:
            im = im.resize(tuple(layout["canvas"]), Image.Resampling.LANCZOS)
        atomic_write(path, lambda tmp: im.save(tmp))
    atomic_json(directory / "layout.json", layout)
    copy_inputs(job, directory, force)
    for panel in panels:
        print(f"{job['id']}/{panel.label}: PREPARED failures=none", flush=True)
    return layout


def relaxed_lock(fd: hr.FrameData, rep2: np.ndarray, *, wL: float = 0.35, sL: float = 12,
                 wab: float = 0.7, sab: float = 4, edge_hf: float = 0.75) -> np.ndarray:
    """Independent Lab low-frequency correction weights; reuse the hybrid lock's outer-ring damping."""
    return hr.lock_colour(fd, rep2, sL, sab, wL, edge_hf, lock_ab=wab)


def register_panel(panel: Panel, meta: dict, layout: dict, inp: np.ndarray, raw: np.ndarray,
                   out_canvas: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray, dict]:
    cw, ch = layout["canvas"]
    x, y, w, h = meta["box"]
    x0, y0, x1, y1 = max(0, x - BORDER), max(0, y - BORDER), min(cw, x + w + BORDER), min(ch, y + h + BORDER)
    target = inp[y0:y1, x0:x1]
    # Weight only this panel's foreground; the border gives registration room to recover a framing shift.
    weight = np.zeros(target.shape[:2], bool)
    weight[y - y0:y - y0 + h, x - x0:x - x0 + w] = hr.foreground(inp[y:y + h, x:x + w], 6.0)
    params, diag = hr.register(target, out_canvas[y0:y1, x0:x1], hr.dilate(weight, 8))
    sx, tx, sy, ty = params
    if not all(math.isfinite(v) for v in params) or not (0.25 < sx < 4 and 0.25 < sy < 4) or abs(tx) > cw or abs(ty) > ch:
        raise ValueError(f"{panel.label}: registration diverged: {params}")
    global_params = (sx, x0 + tx - sx * x0, sy, y0 + ty - sy * y0)
    reg4 = hr.registered_4x(raw, (cw, ch), tuple(meta["scale4"]), layout["enlarge"], global_params, (x, y))
    raw2m = rd.box_down_linear(reg4, 2)
    h1, w1 = panel.fd.alpha1.shape
    m = 2 * hr.MARGIN
    raw2 = raw2m[m:m + 2 * h1, m:m + 2 * w1]
    a2 = panel.fd.alpha1.repeat(2, 0).repeat(2, 1).astype(np.float32)
    residual = rd.phase_shift(rd.masked_blur(hr.luminance(panel.fd.orig2x()), a2, 1),
                              rd.masked_blur(hr.luminance(raw2), a2, 1), a2) if a2.any() else (0.0, 0.0)
    diag.update({"scale": [sx, sy], "shift_canvas_px": [tx, ty], "params_canvas": list(global_params),
                 "crop": [x0, y0, x1 - x0, y1 - y0], "model_size": [raw.shape[1], raw.shape[0]],
                 "residual_shift_2x": list(residual)})
    return raw2, raw2m, reg4, diag


def colour_metrics(fd: hr.FrameData, displayed: np.ndarray) -> dict:
    original = np.repeat(np.repeat(fd.art1, 2, 0), 2, 1)
    labs = [rd.srgb_to_lab(a) for a in (original, displayed)]
    mask = fd.alpha1.repeat(2, 0).repeat(2, 1)
    out = {}
    for tag, lab in zip(("orig", "final"), labs):
        light = lab[..., 0][mask]
        out[tag] = {"L_mean": float(light.mean()) if light.size else None,
                    "L_p5": float(np.percentile(light, 5)) if light.size else None,
                    "L_p95": float(np.percentile(light, 95)) if light.size else None,
                    "chroma_mean": float(np.linalg.norm(lab[..., 1:], axis=-1)[mask].mean()) if mask.any() else None}
    chroma = [np.linalg.norm(lab[..., 1:], axis=-1) for lab in labs]
    hue_mask = mask & (fd.base_paint == 0) & (chroma[0] > 8) & (chroma[1] > 8)
    hues = [math.degrees(math.atan2(*lab[..., 1:][hue_mask].mean(0)[::-1])) for lab in labs] if hue_mask.any() else []
    out["hue_pixels"] = int(hue_mask.sum())
    out["hue_shift_degrees"] = (hues[1] - hues[0] + 180) % 360 - 180 if hues else None
    return out


def job_settings(job: dict, cli_lock: dict | None, cli_thresholds: dict | None) -> tuple[dict, dict]:
    # Specific job settings win over CLI defaults; the complete resolved settings are recorded with every attempt.
    lock = {**DEFAULT_LOCK, **(cli_lock or {}), **job.get("lock", {})}
    thresholds = {**DEFAULT_THRESHOLDS, **(cli_thresholds or {}), **job.get("thresholds", {})}
    if lock.keys() != DEFAULT_LOCK.keys() or any(not math.isfinite(float(v)) or v < 0 for v in lock.values()):
        raise ValueError("lock requires non-negative finite wL,sL,wab,sab,edge_hf")
    if lock["wL"] > 1 or lock["wab"] > 1 or lock["edge_hf"] > 1:
        raise ValueError("lock weights must lie in [0,1]")
    if thresholds.keys() != DEFAULT_THRESHOLDS.keys():
        raise ValueError(f"unknown thresholds: {thresholds.keys() - DEFAULT_THRESHOLDS.keys()}")
    for key, value in thresholds.items():
        values = value if isinstance(value, (tuple, list)) else [value]
        if any(not math.isfinite(float(v)) for v in values):
            raise ValueError(f"{key}: thresholds must be finite")
    return lock, thresholds


def sequence_masks(previous: Panel, current: Panel, *, paint: bool = False) -> tuple[np.ndarray, np.ndarray]:
    """Compare original visible pixels in the common 1x anchor box, then expand masks by nearest neighbour."""
    overlap = previous.fd.alpha1 & current.fd.alpha1
    static = overlap & np.all(previous.fd.art1 == current.fd.art1, axis=-1)
    if paint:
        static &= previous.paint1 == current.paint1
    return overlap.repeat(2, 0).repeat(2, 1), static.repeat(2, 0).repeat(2, 1)


def stabilization_weights(previous: Panel, current: Panel) -> np.ndarray:
    _, static = sequence_masks(previous, current, paint=True)
    # A single inward pixel at 2x blends halfway; no changing pixel outside the static region is borrowed.
    interior = hr.erode(np.pad(static, 1), 1)[1:-1, 1:-1]
    return np.where(interior, 1.0, np.where(static, 0.5, 0.0)).astype(np.float32)


def temporal_pair(previous: Panel, current: Panel, before: np.ndarray, after: np.ndarray, k: int) -> dict:
    overlap, static = sequence_masks(previous, current)
    distance = np.linalg.norm(rd.srgb_to_lab(after) - rd.srgb_to_lab(before), axis=-1)
    denominator = int(current.fd.alpha1.sum()) * 4
    def stats(mask: np.ndarray) -> dict:
        values = distance[mask]
        return {"mean": float(values.mean()) if values.size else None,
                "p95": float(np.percentile(values, 95)) if values.size else None,
                "pixels": int(values.size), "fraction": float(values.size / denominator) if denominator else 0.0}
    return {"previous": k - 1, "panel": k, "opaque_pixels": denominator,
            "static_flicker_dE": stats(static), "all_dE": stats(overlap)}


def evaluate_attempt(source: Source, job: dict, panels: list[Panel], layout: dict, directory: Path,
                     inp: np.ndarray, lock: dict, thresholds: dict) -> dict:
    raw_path = directory / "raw.png"
    raw = hr.load_rgb(raw_path if raw_path.is_file() else directory / "output.png")
    cw, ch = layout["canvas"]
    out_canvas = raw if raw.shape[:2] == (ch, cw) else hr.resize_linear(raw, (cw, ch))
    results, failures, artifacts = [], [], []
    grid = grid_settings(job) or {}
    sequence, stabilize = grid.get("sequence", False), grid.get("stabilize", False)
    temporal, stabilized = [], []
    previous_displayed, previous_locked = None, None
    for k, (panel, meta) in enumerate(zip(panels, layout["panels"])):
        raw2, raw2m, reg4, diag = register_panel(panel, meta, layout, inp, raw, out_canvas)
        frames = []
        if stabilize:
            weights = stabilization_weights(panels[k - 1], panel) if k else np.zeros(raw2.shape[:2], np.float32)
            final_locked, locked_alpha = np.zeros_like(raw2), np.zeros(raw2.shape[:2], np.float32)
            used = np.zeros(raw2.shape[:2], bool)
        for j, part in enumerate(panel.parts):
            x, y, w, h = (2 * v for v in part.rect)
            colour = relaxed_lock(part.fd, raw2[y:y + h, x:x + w], **lock)
            if stabilize:
                region = (slice(y, y + h), slice(x, x + w))
                if k:
                    px, py, pw, ph = part.rect
                    # Do not stamp a visible overlay's colour into a different, hidden underlying part.
                    visible = part.fd.alpha1 & np.all(part.fd.art1 == panel.fd.art1[py:py + ph, px:px + pw], -1)
                    visible &= part.paint1 == panel.paint1[py:py + ph, px:px + pw]
                    share = weights[region] * visible.repeat(2, 0).repeat(2, 1)
                    colour = colour * (1 - share[..., None]) + previous_locked[region] * share[..., None]
                    used[region] |= share > 0
                over(final_locked, locked_alpha, colour, part.fd.alpha2.astype(np.float32) / 255, (x, y, w, h))
            rgba = hr.encode_frame(part.fd, colour)
            frames.append(rgba)
            filename = f"part_{k}_{j}.png"
            save_image(directory / filename, rgba)
            artifacts.append({**meta["parts"][j], "file": filename, "panel": k})
        rgba, _, displayed = composite_hd(panel.parts, (panel.fd.alpha1.shape[1], panel.fd.alpha1.shape[0]), frames)
        redraw = hr.Redraw(rgba, displayed, raw2, raw2m, reg4, diag)
        metrics = hr.checks(panel.fd, redraw, "building", thresholds)
        metrics["colour"] = colour_metrics(panel.fd, displayed)
        metrics["label"] = panel.label
        if stabilize:
            fraction = float(used.sum() / (4 * panel.fd.alpha1.sum())) if panel.fd.alpha1.any() else 0.0
            metrics["stabilized_fraction"] = fraction
            stabilized.append(fraction)
            previous_locked = final_locked
        if sequence:
            if k:
                temporal.append(temporal_pair(panels[k - 1], panel, previous_displayed, displayed, k))
            previous_displayed = displayed
        results.append(metrics)
        failures.extend({**f, "panel": k, "label": panel.label} for f in metrics["failures"])
        alpha = rgba[..., 3:4].astype(np.float32) / 255
        save_image(directory / f"panel_{k}_2x.png", displayed * alpha + hr.GREY * (1 - alpha))
        checks = ",".join(f["check"] for f in metrics["failures"]) or "none"
        print(f"{job['id']}/{panel.label} {directory.name}: {'ACCEPTED' if metrics['passed'] else 'FLAGGED'} "
              f"failures={checks}", flush=True)
    result = {"passed": not failures, "failures": failures, "panels": results, "parts": artifacts,
              "lock": lock, "thresholds": thresholds, "source_dir": str(source.dir), "layout": layout}
    if sequence or stabilize:
        result["temporal"] = {}
        if sequence:
            result["temporal"]["pairs"] = temporal
        if stabilize:
            result["temporal"]["stabilized_fraction"] = stabilized
    atomic_json(directory / "metrics.json", result)
    return result


def retry_note(metrics: dict | None) -> str:
    if not metrics or not metrics.get("failures"):
        return ""
    lines = []
    hints = set()
    for f in metrics["failures"]:
        where = f.get("label", "sheet")
        lines.append(f"{where}: {f['check']} ({f.get('detail', '')}).")
        hint = f.get("hint", "")
        if (where, hint) in hints:
            continue
        hints.add((where, hint))
        if hint.startswith("local:"):
            place = hint.split(":", 1)[1]
            lines.append(hr.local_emphasis("every" if place == "whole" else place, f"building in panel {where}"))
        elif hint in hr.EMPHASIS:
            lines.append(hr.EMPHASIS[hint].format(noun=f"building in panel {where}"))
    return "\n\nRetry notes (previous attempt):\n" + "\n".join(lines) + "\n"


class LimitStop:
    """Shared stop signal: running calls finish, but neither another job nor a retry starts after a quota report."""

    def __init__(self, path: Path):
        self.path = path
        self.event = threading.Event()
        self.mutex = threading.Lock()
        self.logs: list[Path] = []
        self.running: set[Path] = set()
        self.calls: dict[Path, dict] = {}

    def start(self, log: Path) -> None:
        with self.mutex:
            self.running.add(log)

    def finish(self, log: Path, call: dict) -> None:
        # Persist the exit status even if an image exists; resume must distinguish failed and successful calls.
        atomic_json(log.parent / "call.json", call)
        with self.mutex:
            self.running.discard(log)
        self.inspect(log)

    def scan(self) -> None:
        for log in self.logs:
            if self.event.is_set():
                break
            self.inspect(log)

    def inspect(self, log: Path) -> None:
        with self.mutex:
            if log in self.running:
                return
        if not log.is_file():
            return
        call_path = log.parent / "call.json"
        call = json.loads(call_path.read_text()) if call_path.is_file() else self.calls.get(log, {})
        failed = call.get("exit") is not None and call["exit"] != 0
        if not failed and any((log.parent / name).is_file() for name in ("raw.png", "output.png")):
            return
        for line in log.read_text(errors="replace").splitlines():
            if re.search(r"usage limit|rate limit|quota|\b(?:status|http|error)\D{0,12}429\b|"
                         r"\b429\s+Too Many Requests\b", line, re.IGNORECASE):
                with self.mutex:
                    if not self.event.is_set():
                        self.event.set()
                        atomic_write(self.path, lambda tmp: tmp.write_text(f"{log}: {line}\n"))
                break


def run_job(source: Source, job: dict, args: argparse.Namespace, limit: LimitStop) -> dict:
    directory = args.work / job["id"]
    decision = {"id": job["id"], "source": source.kind, "source_dir": str(source.dir), "status": "FLAGGED",
                "chosen": None, "attempts": []}
    try:
        panels = build_panels(source, job)
        layout = json.loads((directory / "layout.json").read_text())
        if layout != make_layout(source, job, panels):
            raise ValueError("plan/source differs from prepared layout; prepare --force first")
        inp = hr.load_rgb(directory / "input.png")
        if list(inp.shape[1::-1]) != layout["canvas"]:
            raise ValueError("input.png size differs from layout.json")
        lock, thresholds = job_settings(job, args.lock, args.thresholds)
        previous = None
        for k in range(1, args.max_attempts + 1):
            attempt = directory / f"attempt{k}"
            limit.inspect(attempt / "run.log")
            exists = (attempt / "raw.png").is_file() or (attempt / "output.png").is_file()
            call = None
            if not exists:
                if args.no_model or limit.event.is_set():
                    continue
                attempt.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(directory / "input.png", attempt / "input.png")
                copy_inputs(job, attempt, force=True)
                prompt = Path(job["prompt_file"]).read_text() + retry_note(previous)
                # Only completed calls can establish a limit; intermediate logs may describe recovered errors.
                limit.scan()
                if limit.event.is_set():
                    continue
                limit.start(attempt / "run.log")
                try:
                    call = hr.run_codex(args.codex, attempt, prompt, args.timeout)
                except Exception:
                    limit.finish(attempt / "run.log", {"exit": 1})
                    raise
                limit.finish(attempt / "run.log", call)
            try:
                metrics = evaluate_attempt(source, job, panels, layout, attempt, inp, lock, thresholds)
            except Exception as exc:
                metrics = {"passed": False, "failures": [{"check": "evaluation", "detail": str(exc)}],
                           "panels": [], "parts": []}
                atomic_json(attempt / "metrics.json", metrics)
            metrics["attempt"] = k
            if call is not None:
                metrics["call"] = call
            decision["attempts"].append(metrics)
            previous = metrics
            eligible = bool(metrics["parts"])
            chosen = next((a for a in decision["attempts"] if a["attempt"] == decision["chosen"]), None)
            if eligible and (chosen is None or len(metrics["failures"]) < len(chosen["failures"])):
                decision["chosen"] = k
            if metrics["passed"]:
                decision["status"] = "ACCEPTED"
                break
        chosen = next((a for a in decision["attempts"] if a["attempt"] == decision["chosen"]), None)
        decision["failures"] = chosen["failures"] if chosen else [{"check": "no_evaluated_output"}]
    except Exception as exc:
        decision["failures"] = [{"check": "job", "detail": str(exc)}]
    names = ",".join(f.get("label", "sheet") + ":" + f["check"] for f in decision["failures"]) or "none"
    print(f"{job['id']}: {decision['status']} attempt={decision['chosen']} failures={names}", flush=True)
    return decision


def run_jobs(jobs: list[dict], sources: dict[str, Source], args: argparse.Namespace) -> int:
    limit = LimitStop(args.limit_file or args.work / "limit.txt")
    # A resumed run must notice a limit in any saved call before starting another model invocation.
    limit.logs = [args.work / job["id"] / f"attempt{k}" / "run.log"
                  for job in jobs for k in range(1, args.max_attempts + 1)]
    saved = args.work / "decisions.json"
    if saved.is_file():
        for decision in json.loads(saved.read_text()):
            for attempt in decision.get("attempts", []):
                if "call" in attempt:
                    log = args.work / decision["id"] / f"attempt{attempt['attempt']}" / "run.log"
                    limit.calls[log] = attempt["call"]
    limit.scan()
    decisions = {j["id"]: {"id": j["id"], "status": "FLAGGED", "chosen": None, "attempts": [],
                            "failures": [{"check": "not_started"}]} for j in jobs}
    hr._CODEX_SLOTS = threading.Semaphore(args.parallel)
    # Keep only parallel jobs in flight. After a limit, workers may still evaluate saved images; run_job gates calls.
    pending = iter(jobs)
    with ThreadPoolExecutor(max_workers=args.parallel) as pool:
        running = {}
        def fill() -> None:
            while len(running) < args.parallel:
                job = next(pending, None)
                if job is None:
                    break
                running[pool.submit(run_job, sources[job["source"]], job, args, limit)] = job["id"]
        fill()
        while running:
            done, _ = wait(running, return_when=FIRST_COMPLETED)
            for future in done:
                ident = running.pop(future)
                decisions[ident] = future.result()
            atomic_json(args.work / "decisions.json", list(decisions.values()))
            fill()
    atomic_json(args.work / "decisions.json", list(decisions.values()))
    return int(limit.event.is_set() or any(d["chosen"] is None for d in decisions.values()))


def symlink_missing(source: Path, target: Path) -> None:
    target.mkdir(parents=True, exist_ok=True)
    for entry in source.iterdir():
        dst = target / entry.name
        if not os.path.lexists(dst):
            dst.symlink_to(entry, target_is_directory=entry.is_dir())


def materialize_directory(path: Path) -> None:
    """Detach directory links before writing inside a variant; never follow them into the original cache."""
    if path.is_symlink():
        original = path.resolve(strict=True)
        path.unlink()
        path.mkdir()
        symlink_missing(original, path)
    else:
        path.mkdir(parents=True, exist_ok=True)


def variant_directory(source: Source, root: Path, out_map: str | None = None) -> Path:
    root = art_directory(root)
    if root.resolve().is_relative_to(source.cache_root.resolve()) or root.is_symlink():
        raise ValueError("out-root must be a separate, real variant directory")
    root.mkdir(parents=True, exist_ok=True)
    if source.kind == "library":
        parent = root / "_library"
        materialize_directory(parent)
        directory = parent / source.dir.name
    else:
        name = out_map or source.dir.name
        if Path(name).name != name or name in (".", "..", "_library"):
            raise ValueError("out-map must be a map directory name")
        directory = root / name
    materialize_directory(directory)
    symlink_missing(source.dir, directory)
    # The theater library is only part of _library: keep common effects/voxels and other theaters reachable too.
    if source.kind == "library":
        symlink_missing(source.dir.parent, root / "_library")
    symlink_missing(source.cache_root, root)
    return directory


@dataclass
class Patch:
    source: Source
    sprite: str
    frame: int
    image: Path | np.ndarray
    job: str
    status: str
    failures: tuple[str, ...] = ()


def paste_patches(patches: list[Patch], root: Path, out_map: str | None = None,
                  base_atlas: Path | None = None) -> int:
    """Process one output page at a time. Patch order is plan order, including overlaps between later jobs."""
    groups: dict[tuple[Path, str], list[Patch]] = {}
    for patch in patches:
        src = patch.source
        directory = variant_directory(src, root, out_map)
        name = src.page_files(src.page_number(patch.sprite, patch.frame))["hd"]
        groups.setdefault((directory, name), []).append(patch)
    records: dict[Path, list[dict]] = {}
    reset_reports: set[Path] = set()
    for (directory, name), parts in groups.items():
        src = parts[0].source
        dst = directory / name
        original = base_atlas if src.kind == "map" and base_atlas else src.dir / name
        reset = src.kind == "map" and base_atlas is not None
        if reset:
            reset_reports.add(directory)
        prepared = []
        # Load and validate small patches before reading the mutable target page.
        for patch in parts:
            ref = patch.source.ref(patch.sprite, patch.frame)
            x, y, w, h = (2 * v for v in ref.rect)
            if isinstance(patch.image, Path):
                with Image.open(patch.image) as im:
                    rgba = np.asarray(im.convert("RGBA"))
            else:
                rgba = patch.image
            base, _ = patch.source.frame_hd(patch.sprite, patch.frame)
            if rgba.shape != base.shape:
                raise ValueError(f"{ref.key}: patch/base/target size differs")
            if not np.array_equal(rgba[..., 3], base[..., 3]):
                raise ValueError(f"{ref.key}: alpha differs from the base HD atlas")
            prepared.append((ref.key, (x, y, w, h), rgba))
            records.setdefault(directory, []).append({"page": name, "page_index": patch.source.page_number(
                patch.sprite, patch.frame), "sprite": patch.sprite, "frame": patch.frame,
                "rect": [x, y, w, h], "job": patch.job, "status": patch.status})
        for attempt in range(3):
            stamp = file_stamp(dst)
            start = dst if dst.is_file() and not dst.is_symlink() and not reset else original
            with Image.open(start) as im:
                atlas = np.array(im.convert("RGBA"))
            for key, (x, y, w, h), rgba in prepared:
                target = atlas[y:y + h, x:x + w]
                if target.shape != rgba.shape:
                    raise ValueError(f"{key}: patch/base/target size differs")
                if not np.array_equal(target[..., 3], rgba[..., 3]):
                    raise ValueError(f"{key}: alpha differs from the base HD atlas")
                target[:] = rgba
            try:
                atomic_write(dst, lambda tmp: Image.fromarray(atlas).save(tmp), expected=stamp)
                break
            except ConcurrentWriteError:
                if attempt == 2:
                    raise
        for patch in parts:
            ref = patch.source.ref(patch.sprite, patch.frame)
            print(f"{patch.job}/{ref.key}: {patch.status} COMPOSED failures={','.join(patch.failures) or 'none'}",
                  flush=True)
    for directory, entries in records.items():
        report = directory / "l3_frames.json"
        replaced = {(e["page"], e["sprite"], e["frame"]) for e in entries}
        for attempt in range(3):
            stamp = file_stamp(report)
            old = json.loads(report.read_text()) if (directory not in reset_reports and report.is_file()
                                                     and not report.is_symlink()) else []
            # Reset only with an explicit base; keep the final record when this track repeats a frame.
            merged = {(e["page"], e["sprite"], e["frame"]): e for e in old
                      if (e["page"], e["sprite"], e["frame"]) not in replaced}
            merged.update({(e["page"], e["sprite"], e["frame"]): e for e in entries})
            try:
                atomic_json(report, list(merged.values()), expected=stamp)
                break
            except ConcurrentWriteError:
                if attempt == 2:
                    raise
    return sum(len(v) for v in groups.values())


def compose_jobs(jobs: list[dict], sources: dict[str, Source], args: argparse.Namespace) -> int:
    decisions = {d["id"]: d for d in json.loads((args.work / "decisions.json").read_text())}
    patches = []
    for job in jobs:
        decision = decisions[job["id"]]
        if decision["status"] not in ("ACCEPTED", "FLAGGED") or decision["chosen"] is None:
            raise ValueError(f"{job['id']}: no evaluated result to compose")
        source = sources[job["source"]]
        chosen = next(a for a in decision["attempts"] if a["attempt"] == decision["chosen"])
        if chosen["layout"] != make_layout(source, job, build_panels(source, job)):
            raise ValueError(f"{job['id']}: plan/source changed since evaluation")
        directory = args.work / job["id"] / f"attempt{decision['chosen']}"
        for part in chosen["parts"]:
            if part["paste"]:
                patches.append(Patch(source, part["sprite"], part["frame"], directory / part["file"],
                                     job["id"], decision["status"], tuple(f["check"] for f in chosen["failures"])))
    # A context-only plan still creates a usable cache farm, without converting any atlas symlink to a regular file.
    directories = [variant_directory(s, args.out_root, args.out_map) for s in sources.values()]
    paste_patches(patches, args.out_root, args.out_map, args.base_atlas)
    for directory in directories:
        if not os.path.lexists(directory / "l3_frames.json"):
            atomic_json(directory / "l3_frames.json", [])
    return 0


def load_plan(path: Path) -> list[dict]:
    jobs = json.loads(path.read_text())
    if not isinstance(jobs, list) or not jobs:
        raise ValueError("plan must be a nonempty JSON list of jobs")
    seen = set()
    for job in jobs:
        ident = job["id"]
        if not isinstance(ident, str) or not ident or Path(ident).name != ident or ident in (".", "..") or ident in seen:
            raise ValueError(f"invalid or duplicate job id {ident!r}")
        if job["source"] not in ("map", "library"):
            raise ValueError(f"{ident}: source must be map or library")
        seen.add(ident)
    return jobs


def parse_lock(text: str) -> dict:
    values = [float(v) for v in text.split(",")]
    if len(values) != 4:
        raise argparse.ArgumentTypeError("--lock requires wL,sL,wab,sab (GPU wrapper: --gpu-lock)")
    return dict(zip(("wL", "sL", "wab", "sab"), values))


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("stage", choices=("prepare", "run", "compose", "delta"))
    parser.add_argument("--plan", type=Path, help="JSON job list (required except for delta)")
    parser.add_argument("--work", type=Path, help="untracked job directories (required except for delta)")
    parser.add_argument("--library", type=Path, help="source theater directory containing library.json")
    parser.add_argument("--cache", type=Path, default=REPO / "gameres/hd-cache", help="map cache root")
    parser.add_argument("--map", help="source map name under --cache")
    parser.add_argument("--upscaler", choices=("esrgan", "lanczos"), default="esrgan")
    parser.add_argument("--realesrgan", type=Path, default=hr.MAIN_REPO / "gameres/tools/realesrgan/realesrgan-ncnn-vulkan")
    parser.add_argument("--gpu-lock", help="quoted command prefix for Real-ESRGAN, e.g. '/path/to/gpu-lock'")
    parser.add_argument("--force", action="store_true", help="prepare: replace existing input/images/layout")
    parser.add_argument("--lock", type=parse_lock, help="Lab defaults wL,sL,wab,sab; per-job values win")
    parser.add_argument("--edge-hf", type=float, help="outer-ring detail damping (default .75)")
    parser.add_argument("--thresholds", type=json.loads, help="JSON object overriding default checks; per-job values win")
    parser.add_argument("--no-model", action="store_true", help="run: evaluate existing outputs only")
    parser.add_argument("--codex", type=Path, default=Path(shutil.which("codex") or "codex"))
    parser.add_argument("--parallel", type=int, default=2)
    parser.add_argument("--max-attempts", type=int, default=2)
    parser.add_argument("--timeout", type=float, default=1200)
    parser.add_argument("--limit-file", type=Path, help="quota/rate-limit message (default WORK/limit.txt)")
    parser.add_argument("--out-root", type=Path, help="compose/delta: separate variant cache root")
    parser.add_argument("--out-map", help="compose/delta: map name in variant (default source map name)")
    parser.add_argument("--base-atlas", type=Path, help="compose: map HD base atlas")
    parser.add_argument("--source", choices=("library", "map"), default="library", help="delta source kind")
    parser.add_argument("--body", help="delta reference sprite:frame, e.g. building:NAPOWR:0 or anim:NAPOWR_A:0")
    parser.add_argument("--anim", help="delta anim sprite, e.g. anim:NAPOWR_A")
    parser.add_argument("--frames", default="all", help="delta inclusive ranges/list, e.g. 0-17 or 0,2-4 (default all)")
    parser.add_argument("--body-dmg", help="optional damaged body sprite:frame")
    parser.add_argument("--anim-dmg", help="optional damaged anim sprite")
    parser.add_argument("--house", help="delta display/re-encode house name or index")
    parser.add_argument("--new-atlas-root", type=Path, help="delta: variant holding the redrawn body")
    parser.add_argument("--unrelated", choices=("add", "keep"), default="add",
                        help="delta: transfer unrelated differences additively or retain original anim pixels")
    return parser


def get_sources(kinds: set[str], args: argparse.Namespace) -> dict[str, Source]:
    sources = {}
    if "library" in kinds:
        if args.library is None:
            raise ValueError("library jobs require --library DIR")
        sources["library"] = Source.library(args.library)
    if "map" in kinds:
        if not args.map or Path(args.map).name != args.map or args.map in (".", ".."):
            raise ValueError("map jobs require --cache ROOT --map NAME")
        sources["map"] = Source.map(args.cache / args.map)
    return sources


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        if args.stage in ("compose", "delta") and args.out_root is None:
            raise ValueError(f"{args.stage} requires --out-root")
        if args.stage == "delta":
            return delta_command(get_sources({args.source}, args)[args.source], args)
        if args.plan is None or args.work is None:
            raise ValueError("prepare/run/compose require --plan PLAN.json --work WORKDIR")
        args.work = art_directory(args.work)
        args.work.mkdir(parents=True, exist_ok=True)
        if args.limit_file:
            args.limit_file = art_directory(args.limit_file)
        if args.parallel < 1 or args.max_attempts < 1 or not math.isfinite(args.timeout) or args.timeout <= 0:
            raise ValueError("parallel, max-attempts and timeout must be positive")
        if args.edge_hf is not None:
            args.lock = {**(args.lock or {}), "edge_hf": args.edge_hf}
        jobs = load_plan(args.plan)
        sources = get_sources({j["source"] for j in jobs}, args)
        if args.stage == "prepare":
            for job in jobs:
                prepare_job(sources[job["source"]], job, args.work,
                            None if args.upscaler == "lanczos" else args.realesrgan,
                            shlex.split(args.gpu_lock) if args.gpu_lock else None, args.force)
            return 0
        if args.stage == "run":
            return run_jobs(jobs, sources, args)
        return compose_jobs(jobs, sources, args)
    except (ValueError, KeyError, OSError) as exc:
        print(f"l3_redraw: {exc}", file=sys.stderr)
        return 1


def delta_transfer(body: hr.FrameData, anim: hr.FrameData, new_body: np.ndarray,
                   body_offset: tuple[int, int], anim_offset: tuple[int, int], unrelated: str = "add") -> np.ndarray:
    """Transfer relative to any reference frame (body or animation), aligned by the original object anchors.

    With unrelated='keep', differences that are neither close nor added light retain the original encoded anim.
    """
    if unrelated not in ("add", "keep"):
        raise ValueError("unrelated must be add or keep")
    if new_body.shape != body.base.shape or not np.array_equal(new_body[..., 3], body.alpha2):
        raise ValueError("new body must retain the original HD dimensions and alpha")
    h, w = anim.alpha2.shape
    dx, dy = (2 * (body_offset[i] - anim_offset[i]) for i in (0, 1))
    x0, y0, x1, y1 = max(0, dx), max(0, dy), min(w, dx + new_body.shape[1]), min(h, dy + new_body.shape[0])
    if x1 <= x0 or y1 <= y0:
        return anim.base.copy()
    a = (slice(y0, y1), slice(x0, x1))
    b = (slice(y0 - dy, y1 - dy), slice(x0 - dx, x1 - dx))
    old = rd.srgb_to_linear(body.displayed(body.base)[b])
    new = rd.srgb_to_linear(body.displayed(new_body)[b])
    effect = rd.srgb_to_linear(anim.displayed(anim.base)[a])
    overlap = (body.alpha2[b] > 0) & (anim.alpha2[a] > 0)
    delta = effect - old
    close = overlap & (np.abs(delta).max(-1) < 0.06)
    ratio = np.clip((effect + 1e-4) / (old + 1e-4), 0, 4)
    gain = rd.masked_blur(ratio, close.astype(np.float32), 1.5)
    # Large/light-adding differences are an additive glow, not a multiplicative repaint of the new facade.
    glow = (delta @ hr.LUMA) > 0.015
    gain = np.where((close & ~glow)[..., None], gain, 1.0)
    transferred = new * gain + (effect - old * gain)
    identical = np.abs(delta).max(-1) < 1e-7
    transferred[identical] = new[identical]  # A neighbour's glow must not tint unchanged body pixels.
    shown = anim.displayed(anim.base)
    transfer = overlap if unrelated == "add" else overlap & (close | glow)
    shown[a] = np.where(transfer[..., None], rd.linear_to_srgb(np.clip(transferred, 0, 1)), shown[a])
    result = hr.encode_frame(anim, shown)
    keep = np.zeros((h, w), bool)
    keep[a] = transfer
    result[~keep] = anim.base[~keep]
    # Preserve the encoded new body exactly where the old body/anim and their masks were identical. This also avoids
    # round-trip error on fractional paint masks, which blend an encoded grey and a decoded house colour.
    same_encoding = transfer & np.all(anim.base[a] == body.base[b], axis=-1) & (anim.base_paint[a] == body.base_paint[b])
    result[a][same_encoding] = new_body[b][same_encoding]
    return result


def frame_range(text: str, count: int) -> list[int]:
    if text == "all":
        return list(range(count))
    result = []
    for entry in text.split(","):
        ends = entry.split("-")
        if len(ends) == 1:
            result.append(int(ends[0]))
        elif len(ends) == 2:
            first, last = map(int, ends)
            if first > last:
                raise ValueError("frame ranges must be ascending")
            result.extend(range(first, last + 1))
        else:
            raise ValueError("frames must be an inclusive range/list, e.g. 0-17")
    if not result or any(i < 0 or i >= count for i in result):
        raise ValueError(f"frames outside 0..{count - 1}")
    return list(dict.fromkeys(result))


def delta_command(source: Source, args: argparse.Namespace) -> int:
    if not args.body or not args.anim or args.new_atlas_root is None:
        raise ValueError("delta requires --body SPRITE:FRAME --anim SPRITE --new-atlas-root DIR")
    if bool(args.body_dmg) != bool(args.anim_dmg):
        raise ValueError("--body-dmg and --anim-dmg must be supplied together")
    pairs = [(args.body, args.anim)]
    if args.body_dmg:
        pairs.append((args.body_dmg, args.anim_dmg))
    house = source.house_ramp(args.house)
    directory = args.new_atlas_root / (Path("_library") / source.dir.name if source.kind == "library" else
                                       Path(args.out_map or source.dir.name))
    patches = []
    for body_spec, anim_sid in pairs:
        body_sid, frame = body_spec.rsplit(":", 1)
        fi = int(frame)
        body = source.data(body_sid, fi, house)
        name = source.page_files(source.page_number(body_sid, fi))["hd"]
        x, y, w, h = (2 * v for v in body.ref.rect)
        with Image.open(directory / name) as im:
            # Crop before conversion to avoid a second full RGBA page in memory.
            new_body = np.asarray(im.crop((x, y, x + w, y + h)).convert("RGBA"))
        for ai in frame_range(args.frames, len(source.sprite(anim_sid)["frames"])):
            anim = source.data(anim_sid, ai, house)
            rgba = delta_transfer(body, anim, new_body, source.offset(body_sid, fi), source.offset(anim_sid, ai),
                                  args.unrelated)
            patches.append(Patch(source, anim_sid, ai, rgba, f"delta:{body_sid}#{fi}", "DELTA"))
    paste_patches(patches, args.out_root, args.out_map)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
