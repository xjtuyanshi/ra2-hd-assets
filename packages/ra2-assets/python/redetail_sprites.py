#!/usr/bin/env python3
"""Offline re-detailing of a map cache's HD sprite atlas with local SDXL + tile ControlNet.

The existing HD atlas (sprites@2x.png, Real-ESRGAN of the indexed art, see src/node/spriteHd.ts) only removes
aliasing. This tool repaints selected body frames at 4x so they gain real surface detail (window frames, facade
materials, leaf clusters), then brings them back to the atlas's 2x layout under strict faithfulness constraints:

* the silhouette is the base HD atlas's own alpha, copied bit for bit (the renderer additionally clips HD art to the
  1x indexed coverage, so shapes cannot change);
* low frequencies (colour, shading, layout at the scale of an original texel) are replaced by the original palette
  art in CIE Lab with a mask-normalised Gaussian, so only sub-texel detail comes from the model;
* house-paint pixels (remappable palette indices 16..31) are re-encoded on the grey ramp the renderer inverts
  (grey = 255 - 15 * (index - 16)), so the unchanged remap mask stays valid;
* shadow frames are never touched (they are drawn from the indexed atlas).

Stages: ``generate`` (GPU; run it under the caller's GPU lock) packs frames into sheets, upscales each sheet with
Real-ESRGAN and repaints it, caching every sheet; ``compose`` (CPU) cuts frames back, restores colour and alpha, writes
a copy of the HD atlas with only the processed frames replaced, and records per-frame metrics. ``all`` runs both.
Everything it reads or writes is derived game art and must stay in gameres/ or another untracked directory.
"""

from __future__ import annotations

import argparse
from dataclasses import dataclass, field
import hashlib
import json
import math
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time

import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))
from rematerialize import MAIN_REPO, gaussian_blur, resolve_paths  # noqa: E402


# Prompts per sprite category (the id prefix before ':'). {desc} is the optional per-sprite description.
PROMPTS = {
    "building": (
        "{desc}, isometric RTS game building, detailed 3D render, crisp facade, sharp window frames, glass panes, "
        "stone and concrete texture, clean edges, ambient occlusion, sunlight from upper left"
    ),
    "tree": (
        "{desc}, isometric RTS game tree, detailed foliage, individual leaves, leaf clusters, branches, bark, "
        "crisp, sharp, sunlight from upper left"
    ),
    "overlay": "{desc}, isometric RTS game asset, crisp, sharp, highly detailed, sunlight from upper left",
    "default": "{desc}, isometric RTS game asset, crisp, sharp, highly detailed, sunlight from upper left",
}
DEFAULT_DESC = {
    "building": "a city building",
    "tree": "trees",
    "overlay": "small objects on the ground",
    "default": "small street objects",
}
NEGATIVE_PROMPT = (
    "blurry, soft, smooth, low detail, painting, cartoon, sketch, text, watermark, logo, people, extra objects, "
    "extra floors, deformed, warped, perspective distortion, noise, jpeg artifacts, oversaturated, neon"
)
JOB_VERSION = 1
SOLO_CATEGORIES = {"overlay"}
_RUNNER = None  # one pipeline per process, shared by every generate() call (variant drivers reuse it)
SHEET_MULTIPLE = 64
MIN_SHEET = 768
GREY_BG = (118, 118, 118)


# ---------------------------------------------------------------------------------------------------- colour maths
def srgb_to_linear(c: np.ndarray) -> np.ndarray:
    c = np.asarray(c, dtype=np.float32) / 255.0
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4).astype(np.float32)


def linear_to_srgb(c: np.ndarray) -> np.ndarray:
    c = np.clip(c, 0, 1)
    return (np.where(c <= 0.0031308, c * 12.92, 1.055 * np.power(c, 1 / 2.4) - 0.055) * 255.0).astype(np.float32)


_M = np.array([[0.4124564, 0.3575761, 0.1804375], [0.2126729, 0.7151522, 0.0721750],
               [0.0193339, 0.1191920, 0.9503041]], dtype=np.float32)
_WHITE = np.array([0.95047, 1.0, 1.08883], dtype=np.float32)


def srgb_to_lab(rgb: np.ndarray) -> np.ndarray:
    xyz = srgb_to_linear(rgb) @ _M.T / _WHITE
    f = np.where(xyz > 216 / 24389, np.cbrt(xyz), (24389 / 27 * xyz + 16) / 116)
    return np.stack((116 * f[..., 1] - 16, 500 * (f[..., 0] - f[..., 1]), 200 * (f[..., 1] - f[..., 2])),
                    axis=-1).astype(np.float32)


def lab_to_srgb(lab: np.ndarray) -> np.ndarray:
    fy = (lab[..., 0] + 16) / 116
    f = np.stack((fy + lab[..., 1] / 500, fy, fy - lab[..., 2] / 200), axis=-1)
    xyz = np.where(f ** 3 > 216 / 24389, f ** 3, (116 * f - 16) / (24389 / 27)) * _WHITE
    return linear_to_srgb(xyz @ np.linalg.inv(_M).T.astype(np.float32))


def masked_blur(values: np.ndarray, weight: np.ndarray, sigma: float) -> np.ndarray:
    """Normalised convolution: a Gaussian mean over weighted pixels only (transparent pixels never leak in)."""
    w = weight.astype(np.float32)
    num = gaussian_blur(values * (w[..., None] if values.ndim == 3 else w), sigma)
    den = gaussian_blur(w, sigma)
    den = np.maximum(den, 1e-6)
    return num / (den[..., None] if values.ndim == 3 else den)


def box_down_linear(rgb: np.ndarray, factor: int) -> np.ndarray:
    """Exact factor x factor box average in linear light (the downsample spriteHd.ts uses)."""
    h, w = rgb.shape[0] // factor, rgb.shape[1] // factor
    lin = srgb_to_linear(rgb[:h * factor, :w * factor])
    lin = lin.reshape(h, factor, w, factor, 3).mean(axis=(1, 3))
    return linear_to_srgb(lin)


def bleed(rgb: np.ndarray, known: np.ndarray, steps: int = 64) -> np.ndarray:
    """Extend known colours outward (4-neighbour mean per ring); unreached pixels take the known mean."""
    rgb = rgb.astype(np.float32).copy()
    known = known.copy()
    mean = rgb[known].mean(axis=0) if known.any() else np.zeros(3, np.float32)
    for _ in range(steps):
        if known.all():
            break
        total = np.zeros_like(rgb)
        count = np.zeros(known.shape, np.float32)
        for dst, src in (((slice(1, None), slice(None)), (slice(None, -1), slice(None))),
                         ((slice(None, -1), slice(None)), (slice(1, None), slice(None))),
                         ((slice(None), slice(1, None)), (slice(None), slice(None, -1))),
                         ((slice(None), slice(None, -1)), (slice(None), slice(1, None)))):
            valid = known[src]
            total[dst] += rgb[src] * valid[..., None]
            count[dst] += valid
        added = ~known & (count > 0)
        if not added.any():
            break
        rgb[added] = total[added] / count[added, None]
        known[added] = True
    rgb[~known] = mean
    return rgb


def erode_distance(mask: np.ndarray, rings: int) -> np.ndarray:
    """Chessboard distance (1..rings, capped) of each mask pixel from the nearest non-mask pixel; 0 outside."""
    dist = np.zeros(mask.shape, np.int32)
    cur = mask.copy()
    for ring in range(1, rings + 1):
        pad = np.pad(cur, 1, constant_values=False)
        inner = cur.copy()
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                inner &= pad[1 + dy:1 + dy + cur.shape[0], 1 + dx:1 + dx + cur.shape[1]]
        dist[cur & ~inner] = ring
        cur = inner
    dist[cur] = rings + 1
    return dist


# ---------------------------------------------------------------------------------------------------- cache access
@dataclass
class FrameRef:
    sprite: str
    frame: int
    rect: tuple[int, int, int, int]
    palette: str
    remap: bool
    aliases: list[str] = field(default_factory=list)

    @property
    def key(self) -> str:
        return f"{self.sprite}#{self.frame}"

    @property
    def category(self) -> str:
        return self.sprite.split(":", 1)[0]


class MapCache:
    def __init__(self, directory: Path, base_atlas: str | None, base_remap: str | None):
        self.dir = directory
        self.manifest = json.loads((directory / "manifest.json").read_text())
        m = self.manifest
        hd = m.get("spriteAtlasHd")
        if not hd:
            raise ValueError("manifest.spriteAtlasHd is missing; run the sprite upscaler first")
        if hd.get("scale") != 2:
            raise ValueError("only 2x HD sprite atlases are supported")
        with Image.open(directory / m["spriteAtlas"]["file"]) as im:
            a = np.asarray(im)
        self.index = a[..., 0] if a.ndim == 3 else a
        if self.index.shape != (m["spriteAtlas"]["height"], m["spriteAtlas"]["width"]):
            raise ValueError("indexed sprite atlas dimensions disagree with the manifest")
        self.palettes = {}
        for key, file in m["palettes"].items():
            with Image.open(directory / file) as im:
                self.palettes[key] = np.asarray(im.convert("RGB"))[0].astype(np.float32)
        self.base_atlas_path = directory / (base_atlas or hd["file"])
        self.base_remap_path = directory / (base_remap or hd["remap"])
        with Image.open(self.base_atlas_path) as im:
            self.hd = np.asarray(im.convert("RGBA")).copy()
        with Image.open(self.base_remap_path) as im:
            self.hd_remap = np.asarray(im.convert("L")).copy()
        if self.hd.shape[:2] != (self.index.shape[0] * 2, self.index.shape[1] * 2):
            raise ValueError("HD atlas must be exactly twice the indexed atlas")
        self.houses = m.get("houses") or {}

    def house_ramp(self, owner: str | None) -> np.ndarray | None:
        house = self.houses.get(owner) if owner else None
        return np.asarray(house["remap"], np.float32) if house else None

    def frame_1x(self, ref: FrameRef, house: np.ndarray | None) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        """Original art as displayed: palette colours (house colours on 16..31 when remappable), alpha, paint mask."""
        x, y, w, h = ref.rect
        idx = self.index[y:y + h, x:x + w].astype(np.int32)
        pal = self.palettes[ref.palette].copy()
        if ref.remap and house is not None:
            pal[16:32] = house[:16]
        rgb = pal[idx]
        alpha = idx > 0
        paint = alpha & ref.remap & (idx >= 16) & (idx <= 31)
        return rgb, alpha, paint

    def frame_hd(self, ref: FrameRef) -> tuple[np.ndarray, np.ndarray]:
        x, y, w, h = ref.rect
        return self.hd[2 * y:2 * (y + h), 2 * x:2 * (x + w)], self.hd_remap[2 * y:2 * (y + h), 2 * x:2 * (x + w)]


def object_frames(cache: MapCache, box: tuple[int, int, int, int] | None) -> dict[str, dict]:
    """Sprites (and the frame indices and owners) of map objects whose drawn frame overlaps a preview.png box.

    Preview pixels are engine screen pixels minus visibleRect's origin (see src/node/preview.ts)."""
    m = cache.manifest
    vr = m.get("visibleRect") or {"x": 0, "y": 0}
    used: dict[str, dict] = {}
    for o in m["objects"]:
        sid = o.get("sprite")
        if not sid or sid not in m["sprites"]:
            continue
        e = m["sprites"][sid]
        fi = min(o.get("frame", 0), len(e["frames"]) - 1)
        f = e["frames"][fi]
        sx = (o["x"] - o["y"]) * 30 + (o.get("drawOffset") or [0, 15])[0] - vr["x"]
        sy = (o["x"] + o["y"]) * 15 - o["z"] * 15 + (o.get("drawOffset") or [0, 15])[1] - vr["y"]
        x0, y0 = sx + f["offset"][0], sy + f["offset"][1]
        if box and not (x0 + f["rect"][2] > box[0] and x0 < box[2] and y0 + f["rect"][3] > box[1] and y0 < box[3]):
            continue
        entry = used.setdefault(sid, {"frames": set(), "owners": set(), "count": 0})
        entry["frames"].add(fi)
        entry["owners"].add(o.get("owner"))
        entry["count"] += 1
        for layer in (e.get("layers") or []) + (e.get("underlays") or []):
            if layer in m["sprites"]:
                sub = used.setdefault(layer, {"frames": set(), "owners": set(), "count": 0})
                sub["frames"].add(0)
                sub["owners"].add(o.get("owner"))
                sub["count"] += 1
    return used


def select_frames(cache: MapCache, args: argparse.Namespace) -> tuple[list[FrameRef], dict[str, str | None]]:
    m = cache.manifest
    wanted: dict[str, set[int] | None] = {}
    owners: dict[str, str | None] = {}
    if args.region_box:
        for sid, info in object_frames(cache, args.region_box).items():
            wanted[sid] = set(info["frames"])
            named = sorted(o for o in info["owners"] if o)
            owners[sid] = named[0] if named else None
            if len(named) > 1:
                print(f"note: {sid} has several owners {named}; repainting with {named[0]}'s colours", flush=True)
    for spec in args.sprites or []:
        parts = spec.split(":")
        sid = ":".join(parts[:2])
        if sid not in m["sprites"]:
            raise ValueError(f"unknown sprite {sid}")
        frames = {int(v) for v in parts[2].split(",")} if len(parts) > 2 and parts[2] else None
        wanted[sid] = frames if frames is not None else (wanted.get(sid) or {0})
        owners.setdefault(sid, None)
    # Remappable art without a known owner is repainted in the first house's colours (never raw palette 16..31).
    default_owner = next(iter(cache.houses), None)
    for sid in wanted:
        if owners.get(sid) is None:
            owners[sid] = default_owner
    if args.include:
        wanted = {k: v for k, v in wanted.items() if any(k.startswith(p) for p in args.include)}
    if args.exclude:
        wanted = {k: v for k, v in wanted.items() if not any(k.startswith(p) for p in args.exclude)}
    refs: dict[tuple, FrameRef] = {}
    for sid in sorted(wanted):
        e = m["sprites"][sid]
        frames = wanted[sid]
        if args.frames == "all":
            frames = set(range(len(e["frames"])))
        elif args.frames != "used":
            frames = frames | {int(v) for v in args.frames.split(",") if int(v) < len(e["frames"])}
        for fi in sorted(frames):
            f = e["frames"][fi]
            if f.get("page", 0) != 0 or f["rect"][2] < 1 or f["rect"][3] < 1:
                continue
            rect = tuple(f["rect"])
            if rect in refs:
                refs[rect].aliases.append(f"{sid}#{fi}")
                continue
            refs[rect] = FrameRef(sid, fi, rect, e["palette"], bool(e["remap"]))
    return list(refs.values()), owners


# ---------------------------------------------------------------------------------------------------- packing
@dataclass
class Placement:
    key: str
    x: int  # 1x sheet position of the frame's top-left (margin excluded)
    y: int
    w: int
    h: int


@dataclass
class Sheet:
    category: str
    width: int  # 1x sheet size (the diffusion canvas is scale times larger, padded to SHEET_MULTIPLE)
    height: int
    placements: list[Placement]
    prompt: str = ""


def pack(refs: list[FrameRef], max_side: int, margin: int) -> list[Sheet]:
    """Shelf-pack frames per category into sheets of at most max_side (1x pixels), each frame with its own margin."""
    sheets: list[Sheet] = []
    by_cat: dict[str, list[FrameRef]] = {}
    for r in refs:
        # Overlay types are different materials (ore, gems, fences, walls): each gets its own sheets and prompt.
        by_cat.setdefault(r.sprite if r.category in SOLO_CATEGORIES else r.category, []).append(r)
    for group, items in by_cat.items():
        cat = group.split(":", 1)[0]
        items = sorted(items, key=lambda r: (-r.rect[3], -r.rect[2], r.key))
        open_sheets: list[tuple[Sheet, list[list[int]]]] = []  # shelves: [y, height, x]
        for r in items:
            w, h = r.rect[2] + 2 * margin, r.rect[3] + 2 * margin
            if w > max_side or h > max_side:
                sheets.append(Sheet(cat, w, h, [Placement(r.key, margin, margin, r.rect[2], r.rect[3])]))
                continue
            placed = False
            for sheet, shelves in open_sheets:
                for shelf in shelves:
                    if shelf[2] + w <= max_side and h <= shelf[1]:
                        sheet.placements.append(Placement(r.key, shelf[2] + margin, shelf[0] + margin, *r.rect[2:]))
                        shelf[2] += w
                        sheet.width = max(sheet.width, shelf[2])
                        placed = True
                        break
                if not placed:
                    top = shelves[-1][0] + shelves[-1][1]
                    if top + h <= max_side:
                        shelves.append([top, h, w])
                        sheet.placements.append(Placement(r.key, margin, top + margin, *r.rect[2:]))
                        sheet.width = max(sheet.width, w)
                        sheet.height = top + h
                        placed = True
                if placed:
                    break
            if not placed:
                sheet = Sheet(cat, w, h, [Placement(r.key, margin, margin, *r.rect[2:])])
                open_sheets.append((sheet, [[0, h, w]]))
                sheets.append(sheet)
    return sheets


def canvas_size(sheet: Sheet, scale: int) -> tuple[int, int]:
    w = max(MIN_SHEET, math.ceil(sheet.width * scale / SHEET_MULTIPLE) * SHEET_MULTIPLE)
    h = max(MIN_SHEET, math.ceil(sheet.height * scale / SHEET_MULTIPLE) * SHEET_MULTIPLE)
    return w, h


# ---------------------------------------------------------------------------------------------------- generate
def realesrgan(binary: Path, rgb: np.ndarray, scale: int) -> np.ndarray:
    if scale != 4:
        raise ValueError("the Real-ESRGAN x4plus model is native 4x")
    with tempfile.TemporaryDirectory(prefix="redetail-esr-") as tmp:
        src, dst = Path(tmp) / "in.png", Path(tmp) / "out.png"
        Image.fromarray(np.clip(np.rint(rgb), 0, 255).astype(np.uint8)).save(src)
        subprocess.run([str(binary), "-i", str(src), "-o", str(dst), "-n", "realesrgan-x4plus", "-s", "4",
                        "-m", str(binary.parent / "models"), "-t", "256"], check=True,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        with Image.open(dst) as im:
            out = np.asarray(im.convert("RGB")).astype(np.float32)
    if out.shape[:2] != (rgb.shape[0] * 4, rgb.shape[1] * 4):
        raise ValueError(f"Real-ESRGAN returned {out.shape}")
    return out


def sheet_inputs(cache: MapCache, sheet: Sheet, frames: dict[str, FrameRef], owners: dict[str, str | None],
                 margin: int) -> tuple[np.ndarray, np.ndarray]:
    """1x sheet RGB (each frame bled into its own margin only) and 1x alpha."""
    rgb = np.zeros((sheet.height, sheet.width, 3), np.float32)
    rgb[:] = GREY_BG
    alpha = np.zeros((sheet.height, sheet.width), np.float32)
    for p in sheet.placements:
        ref = frames[p.key]
        art, a, _ = cache.frame_1x(ref, cache.house_ramp(owners.get(ref.sprite)))
        box = np.zeros((p.h + 2 * margin, p.w + 2 * margin, 3), np.float32)
        known = np.zeros(box.shape[:2], bool)
        box[margin:margin + p.h, margin:margin + p.w] = art
        known[margin:margin + p.h, margin:margin + p.w] = a
        rgb[p.y - margin:p.y + p.h + margin, p.x - margin:p.x + p.w + margin] = bleed(box, known)
        alpha[p.y:p.y + p.h, p.x:p.x + p.w] = a
    return rgb, alpha


def smooth_alpha(alpha_1x: np.ndarray, scale: int) -> np.ndarray:
    """The HD atlas's edge: bilinear coverage through a smoothstep (as in spriteHd.ts cutBack)."""
    h, w = alpha_1x.shape
    big = np.asarray(Image.fromarray((alpha_1x * 255).astype(np.uint8)).resize((w * scale, h * scale),
                                                                                  Image.BILINEAR),
                     np.float32) / 255
    t = np.clip((big - 0.35) / 0.3, 0, 1)
    return t * t * (3 - 2 * t)


class Diffusion:
    def __init__(self, models: Path):
        os.environ["HF_HUB_OFFLINE"] = "1"
        os.environ["TRANSFORMERS_OFFLINE"] = "1"
        sys.dont_write_bytecode = True
        import torch
        from diffusers import AutoencoderKL, ControlNetModel, StableDiffusionXLControlNetImg2ImgPipeline
        for name, component in (("sdxl-base", "unet"), ("sdxl-vae-fp16-fix", ""), ("controlnet-tile-sdxl", "")):
            folder = models / name / component
            if not folder.is_dir() or not any(folder.glob("*.safetensors")):
                raise ValueError(f"missing local safetensors weights in {folder}")
        self.torch = torch
        device = "mps" if torch.backends.mps.is_available() else "cpu"
        dtype = torch.float16 if device == "mps" else torch.float32
        common = {"torch_dtype": dtype, "local_files_only": True, "use_safetensors": True}

        def variant(folder: Path) -> dict:
            return {"variant": "fp16"} if any(folder.glob("*.fp16.safetensors")) else {}

        vae_dir, control_dir = models / "sdxl-vae-fp16-fix", models / "controlnet-tile-sdxl"
        vae = AutoencoderKL.from_pretrained(vae_dir, force_upcast=False, **common, **variant(vae_dir))
        controlnet = ControlNetModel.from_pretrained(control_dir, **common, **variant(control_dir))
        pipe = StableDiffusionXLControlNetImg2ImgPipeline.from_pretrained(
            models / "sdxl-base", variant="fp16", vae=vae, controlnet=controlnet, add_watermarker=False, **common)
        self.pipe = pipe.to(device)
        self.pipe.enable_attention_slicing()
        for owner in (self.pipe, self.pipe.vae):
            fn = getattr(owner, "enable_vae_tiling", None) or getattr(owner, "enable_tiling", None)
            if fn:
                fn()
                break
        self.pipe.set_progress_bar_config(disable=True)
        print(f"Loaded local SDXL + tile ControlNet on {device}", flush=True)

    def __call__(self, rgb: np.ndarray, prompt: str, negative: str, strength: float, steps: int, guidance: float,
                 control: float, seed: int) -> np.ndarray:
        h, w = rgb.shape[:2]
        image = Image.fromarray(np.clip(np.rint(rgb), 0, 255).astype(np.uint8))
        generator = self.torch.Generator(device="cpu").manual_seed(seed)
        with self.torch.inference_mode():
            out = self.pipe(prompt=prompt, negative_prompt=negative, image=image, control_image=image, width=w,
                            height=h, strength=strength, num_inference_steps=steps, guidance_scale=guidance,
                            controlnet_conditioning_scale=control, generator=generator,
                            output_type="pil").images[0]
        if out.size != (w, h):
            raise ValueError(f"diffusion returned {out.size}, expected {(w, h)}")
        return np.asarray(out.convert("RGB")).astype(np.float32)


def sheet_prompt(sheet: Sheet, frames: dict[str, FrameRef], descriptions: dict[str, str]) -> str:
    cat = sheet.category
    sprites = sorted({frames[p.key].sprite for p in sheet.placements})
    descs = [descriptions[s] for s in sprites if s in descriptions]
    if len(set(descs)) == 1 and len(descs) == len(sprites):
        desc = descs[0]
    else:
        # Mixed sheets get the category's generic description (joined descriptions overflow CLIP's 77 tokens).
        desc = descriptions.get(f"{cat}:*", DEFAULT_DESC.get(cat, DEFAULT_DESC["default"]))
    return PROMPTS.get(cat, PROMPTS["default"]).format(desc=desc)


def generate(args: argparse.Namespace, cache: MapCache, refs: list[FrameRef], owners: dict[str, str | None],
             work: Path) -> dict:
    frames = {r.key: r for r in refs}
    descriptions = json.loads(Path(args.describe).read_text()) if args.describe else {}
    sheets = pack(refs, args.sheet // args.scale, args.margin)
    esr = Path(args.realesrgan)
    global _RUNNER
    job = {"version": JOB_VERSION, "scale": args.scale, "margin": args.margin, "background": args.background,
           "options": {k: getattr(args, k) for k in ("strength", "steps", "guidance", "control", "seed")},
           "negative": args.negative_prompt, "owners": owners, "sheets": []}
    (work / "sheets").mkdir(parents=True, exist_ok=True)
    started = time.perf_counter()
    for n, sheet in enumerate(sheets):
        sheet.prompt = args.prompt or sheet_prompt(sheet, frames, descriptions)
        rgb1, alpha1 = sheet_inputs(cache, sheet, frames, owners, args.margin)
        cw, ch = canvas_size(sheet, args.scale)
        ident = hashlib.sha256(rgb1.tobytes() + alpha1.tobytes() + json.dumps(
            [sheet.prompt, job["options"], job["negative"], args.background, args.upscaler, args.init_noise, cw, ch, n]).encode()).hexdigest()[:20]
        stem = work / "sheets" / f"{n:03d}-{sheet.category}-{ident}"
        entry = {"index": n, "category": sheet.category, "prompt": sheet.prompt, "width": sheet.width,
                 "height": sheet.height, "canvas": [cw, ch], "input": f"{stem.name}-in.png",
                 "output": f"{stem.name}-out.png", "esrgan": f"{stem.name}-esr.png",
                 "placements": [p.__dict__ for p in sheet.placements]}
        job["sheets"].append(entry)
        out_path = Path(f"{stem}-out.png")
        if out_path.exists() and not args.force:
            print(f"sheet {n + 1}/{len(sheets)} {sheet.category} ({len(sheet.placements)} frames): cached", flush=True)
            continue
        t0 = time.perf_counter()
        if args.upscaler == "esrgan":
            up = realesrgan(esr, rgb1, args.scale)
        else:  # CPU fallback for dry runs and tests
            up = np.asarray(Image.fromarray(np.clip(np.rint(rgb1), 0, 255).astype(np.uint8)).resize(
                (rgb1.shape[1] * args.scale, rgb1.shape[0] * args.scale), Image.LANCZOS), np.float32)
        Image.fromarray(np.clip(np.rint(up), 0, 255).astype(np.uint8)).save(f"{stem}-esr.png")
        a4 = smooth_alpha(alpha1, args.scale)
        canvas = np.empty((ch, cw, 3), np.float32)
        canvas[:] = GREY_BG
        if args.background == "grey":
            comp = up * a4[..., None] + np.asarray(GREY_BG, np.float32) * (1 - a4[..., None])
        else:  # "bleed": the upscaled, edge-bled sheet itself
            comp = up
        canvas[:comp.shape[0], :comp.shape[1]] = comp
        if args.init_noise > 0:
            # Fine grain inside the art only: gives img2img texture to resolve instead of flat upscaled surfaces.
            rng = np.random.default_rng(args.seed + n)
            grain = rng.normal(0, args.init_noise, (comp.shape[0], comp.shape[1], 1)).astype(np.float32)
            canvas[:comp.shape[0], :comp.shape[1]] += grain * a4[..., None]
        Image.fromarray(np.clip(np.rint(canvas), 0, 255).astype(np.uint8)).save(f"{stem}-in.png")
        t1 = time.perf_counter()
        if args.strength <= 0:
            result = canvas
        else:
            if _RUNNER is None:
                _RUNNER = Diffusion(Path(args.models))
            result = _RUNNER(canvas, sheet.prompt, args.negative_prompt, args.strength, args.steps, args.guidance,
                            args.control, args.seed + n)
        tmp = Path(f"{stem}-out.tmp.png")
        Image.fromarray(np.clip(np.rint(result), 0, 255).astype(np.uint8)).save(tmp)
        os.replace(tmp, out_path)
        entry["seconds"] = {"esrgan": round(t1 - t0, 2), "diffusion": round(time.perf_counter() - t1, 2)}
        print(f"sheet {n + 1}/{len(sheets)} {sheet.category} ({len(sheet.placements)} frames, {cw}x{ch}): "
              f"esrgan {t1 - t0:.1f}s, diffusion {time.perf_counter() - t1:.1f}s", flush=True)
    job["seconds"] = round(time.perf_counter() - started, 1)
    (work / "job.json").write_text(json.dumps(job, indent=2))
    return job


# ---------------------------------------------------------------------------------------------------- compose
def neutral_to_grey(colour: np.ndarray, ramp: np.ndarray) -> np.ndarray:
    """Encode displayed house colour on the renderer's grey ramp: fractional remap index k (0..15) whose house colour
    has this luminance, then grey = 255 - 15 k (inverted in sprites.ts)."""
    lum = colour @ np.array([0.2126, 0.7152, 0.0722], np.float32)
    ramp_lum = ramp @ np.array([0.2126, 0.7152, 0.0722], np.float32)  # brightest first, decreasing
    k = np.interp(-lum, -ramp_lum, np.arange(len(ramp_lum), dtype=np.float32))
    return np.repeat((255 - 15 * k)[..., None], 3, axis=-1).astype(np.float32)


def phase_shift(a: np.ndarray, b: np.ndarray, weight: np.ndarray) -> tuple[float, float]:
    """Sub-pixel translation of b relative to a (phase correlation, Hann-windowed, parabolic peak)."""
    h, w = a.shape
    win = np.outer(np.hanning(h), np.hanning(w)) * (weight > 0)
    fa = np.fft.fft2((a - a[weight > 0].mean()) * win)
    fb = np.fft.fft2((b - b[weight > 0].mean()) * win)
    r = fa * np.conj(fb)
    r /= np.maximum(np.abs(r), 1e-9)
    c = np.real(np.fft.ifft2(r))
    py, px = np.unravel_index(np.argmax(c), c.shape)

    def sub(cm, c0, cp):
        d = cm - 2 * c0 + cp
        return 0.0 if abs(d) < 1e-12 else 0.5 * (cm - cp) / d

    dy = py + sub(c[(py - 1) % h, px], c[py, px], c[(py + 1) % h, px])
    dx = px + sub(c[py, (px - 1) % w], c[py, px], c[py, (px + 1) % w])
    dy = dy - h if dy > h / 2 else dy
    dx = dx - w if dx > w / 2 else dx
    return float(dx), float(dy)


def sobel(y: np.ndarray) -> np.ndarray:
    p = np.pad(y, 1, mode="edge")
    gx = (p[:-2, 2:] + 2 * p[1:-1, 2:] + p[2:, 2:]) - (p[:-2, :-2] + 2 * p[1:-1, :-2] + p[2:, :-2])
    gy = (p[2:, :-2] + 2 * p[2:, 1:-1] + p[2:, 2:]) - (p[:-2, :-2] + 2 * p[:-2, 1:-1] + p[:-2, 2:])
    return np.hypot(gx, gy)


def frame_metrics(orig2x: np.ndarray, base: np.ndarray, final: np.ndarray, alpha_orig2x: np.ndarray,
                  alpha_base: np.ndarray, alpha_final: np.ndarray) -> dict:
    """orig2x: original art bicubic-upscaled to 2x (sRGB float); base: current HD colours; final: re-detailed."""
    inside = erode_distance(alpha_orig2x, 3) > 2
    ob, fb = alpha_orig2x, alpha_final > 127
    iou = float((ob & fb).sum() / max(1, (ob | fb).sum()))
    iou_base = float(((alpha_base > 127) & fb).sum() / max(1, ((alpha_base > 127) | fb).sum()))
    lum = lambda c: srgb_to_lab(c)[..., 0]  # noqa: E731
    lo, lb, lf = lum(orig2x), lum(base), lum(final)
    wgt = alpha_orig2x.astype(np.float32)

    def edge_corr(x, sigma=1.0):
        # Compare edges at the original's scale (blur 1 px at 2x) so added sub-texel detail does not count against it;
        # sigma 2 (one original texel) is the coarse check for foliage, whose single leaf texels may move.
        ex, eo = sobel(masked_blur(x, wgt, sigma)), sobel(masked_blur(lo, wgt, sigma))
        return float(np.corrcoef(ex[inside], eo[inside])[0, 1])

    def lf_de(x, sigma=3.0):
        lx, lr = masked_blur(srgb_to_lab(x), wgt, sigma), masked_blur(srgb_to_lab(orig2x), wgt, sigma)
        d = np.sqrt(((lx - lr) ** 2).sum(-1))[inside]
        return float(d.mean()), float(np.percentile(d, 95))

    def hf(x, sigma=1.0):
        d = (x - masked_blur(x, wgt, sigma))[inside]
        return float(np.sqrt((d ** 2).mean()))

    # Surface texture: fine detail away from the original's strong edges (edges are what an upscaler already
    # sharpens; new material detail shows up inside flat surfaces).
    edges = sobel(masked_blur(lo, wgt, 1.0))
    flat = inside & (edges < np.percentile(edges[inside], 70)) if inside.any() else inside

    def texture(x, sigma=1.0):
        d = np.abs(x - masked_blur(x, wgt, sigma))[flat]
        return float(d.mean()) if d.size else 0.0

    shift = phase_shift(masked_blur(lo, wgt, 1.0), masked_blur(lf, wgt, 1.0), wgt) if inside.sum() > 64 else (0, 0)
    de_b, de_f = lf_de(base), lf_de(final)
    return {
        "iou_vs_original": round(iou, 4), "iou_vs_base_hd": round(iou_base, 4),
        "edge_corr_base": round(edge_corr(lb), 4), "edge_corr_final": round(edge_corr(lf), 4),
        "edge_corr_coarse_base": round(edge_corr(lb, 2.0), 4), "edge_corr_coarse_final": round(edge_corr(lf, 2.0), 4),
        "shift_px_2x": [round(shift[0], 3), round(shift[1], 3)],
        "lf_deltaE_base": [round(de_b[0], 2), round(de_b[1], 2)],
        "lf_deltaE_final": [round(de_f[0], 2), round(de_f[1], 2)],
        "hf_rms_orig_bicubic": round(hf(lo), 3), "hf_rms_base": round(hf(lb), 3), "hf_rms_final": round(hf(lf), 3),
        "detail_gain_vs_base": round(hf(lf) / max(hf(lb), 1e-6), 3),
        "texture_orig_bicubic": round(texture(lo), 3), "texture_base": round(texture(lb), 3),
        "texture_final": round(texture(lf), 3),
        "texture_gain_vs_base": round(texture(lf) / max(texture(lb), 1e-6), 3),
    }


def compose(args: argparse.Namespace, cache: MapCache, refs: list[FrameRef], work: Path) -> dict:
    job = json.loads((work / "job.json").read_text())
    scale, margin = job["scale"], job["margin"]
    frames = {r.key: r for r in refs}
    owners = job.get("owners") or {}
    atlas = cache.hd.copy()
    overrides = parse_overrides(args.override or [])
    report: dict = {"frames": {}, "options": {"sigma_l": args.sigma_l, "sigma_ab": args.sigma_ab,
                                              "edge_hf": args.edge_hf, "detail": args.detail,
                                              "override": {k: list(v) for k, v in overrides.items()}}}
    for entry in job["sheets"]:
        out_path = work / "sheets" / entry["output"]
        if not out_path.exists():
            print(f"missing {out_path.name}; skipped", flush=True)
            continue
        with Image.open(out_path) as im:
            sheet = np.asarray(im.convert("RGB")).astype(np.float32)
        for p in entry["placements"]:
            ref = frames.get(p["key"])
            if ref is None:
                continue
            x4, y4, w4, h4 = p["x"] * scale, p["y"] * scale, p["w"] * scale, p["h"] * scale
            rep4 = sheet[y4:y4 + h4, x4:x4 + w4]
            rep2 = box_down_linear(rep4, scale // 2)
            house = cache.house_ramp(owners.get(ref.sprite))
            art1, a1, paint1 = cache.frame_1x(ref, house)
            base, base_paint = cache.frame_hd(ref)
            alpha2 = base[..., 3]
            a2n = np.kron(a1, np.ones((2, 2), bool))
            ref2 = np.kron(art1, np.ones((2, 2, 1), np.float32))  # nearest; only its blur is used
            # Weight for the low-frequency statistics: the original's opaque texels (never the background).
            wgt = a2n.astype(np.float32)
            lab_rep, lab_ref = srgb_to_lab(rep2), srgb_to_lab(ref2)
            out = np.empty_like(lab_rep)
            sigma_l, sigma_ab, detail = next(
                (v for k, v in overrides.items() if ref.sprite.startswith(k)), (args.sigma_l, args.sigma_ab, args.detail))
            for c, sigma in ((0, sigma_l), (1, sigma_ab), (2, sigma_ab)):
                hf = lab_rep[..., c] - masked_blur(lab_rep[..., c], wgt, sigma)
                out[..., c] = masked_blur(lab_ref[..., c], wgt, sigma) + detail * hf
            # Outermost ring of the silhouette: the model saw the flat background there, so damp its detail.
            ring = erode_distance(alpha2 > 0, 2)
            if args.edge_hf < 1:
                low = masked_blur(lab_ref, wgt, sigma_l)
                edge = (ring == 1)[..., None]
                out = np.where(edge, low + (out - low) * args.edge_hf, out)
            final = np.clip(lab_to_srgb(out), 0, 255)
            paint = base_paint.astype(np.float32) / 255
            if ref.remap and house is not None and paint.any():
                grey = neutral_to_grey(final, house)
                final = final * (1 - paint[..., None]) + grey * paint[..., None]
            opaque = alpha2 > 0
            filled = bleed(final, opaque, steps=8)
            region = filled.copy()
            # Transparent texels keep bled colour (bilinear sampling at the edge), alpha stays the base atlas's.
            x, y, w, h = ref.rect
            dst = atlas[2 * y:2 * (y + h), 2 * x:2 * (x + w)]
            dst[..., :3] = np.clip(np.rint(region), 0, 255).astype(np.uint8)
            dst[..., 3] = alpha2
            orig_bicubic = np.asarray(Image.fromarray(np.clip(bleed(art1, a1, 8), 0, 255).astype(np.uint8)).resize(
                (w * 2, h * 2), Image.BICUBIC), np.float32)
            base_rgb = base[..., :3].astype(np.float32)
            final_rgb = dst[..., :3].astype(np.float32)
            if ref.remap and house is not None and paint.any():
                # Compare what is displayed: decode house paint of both atlases back to the house colours.
                for arr in (base_rgb, final_rgb):
                    k = np.clip((255 - arr[..., 1]) / 15, 0, 15)
                    k0 = np.floor(k).astype(int)
                    k1 = np.minimum(k0 + 1, 15)
                    col = house[k0] + (house[k1] - house[k0]) * (k - k0)[..., None]
                    arr[:] = arr * (1 - paint[..., None]) + col * paint[..., None]
            metrics = frame_metrics(orig_bicubic, base_rgb, final_rgb, a2n, alpha2, dst[..., 3])
            metrics["sheet"] = entry["index"]
            metrics["aliases"] = ref.aliases
            report["frames"][ref.key] = metrics
            if args.debug_frames:
                dbg = work / "frames"
                dbg.mkdir(exist_ok=True)
                Image.fromarray(dst.copy()).save(dbg / f"{ref.key.replace(':', '_').replace('#', '_')}.png")
    return {"atlas": atlas, "report": report}


# ---------------------------------------------------------------------------------------------------- CLI
def parse_overrides(values: list[str]) -> dict[str, tuple[float, float, float]]:
    """'tree:=2,2,1.2' -> {'tree:': (sigma_l, sigma_ab, detail)} for sprite ids starting with the prefix."""
    out = {}
    for value in values:
        prefix, _, numbers = value.partition("=")
        parts = tuple(float(v) for v in numbers.split(","))
        if not prefix or len(parts) != 3 or min(parts) < 0:
            raise ValueError(f"bad --override {value!r}; use prefix=sigma_l,sigma_ab,detail")
        out[prefix] = parts
    return out


def parse_box(value: str) -> tuple[int, int, int, int]:
    parts = tuple(int(v) for v in value.split(","))
    if len(parts) != 4 or parts[2] <= parts[0] or parts[3] <= parts[1]:
        raise argparse.ArgumentTypeError("box is x0,y0,x1,y1 in preview.png pixels")
    return parts


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("stage", choices=("generate", "compose", "all", "list"))
    p.add_argument("--map", required=True)
    p.add_argument("--cache", type=Path)
    p.add_argument("--models", type=Path)
    p.add_argument("--realesrgan", type=Path)
    p.add_argument("--work", type=Path, required=True, help="work directory (sheets, job.json); untracked location")
    p.add_argument("--sprites", nargs="*", help="sprite ids, optionally with frames: building:CATEXS03:0,1")
    p.add_argument("--region-box", type=parse_box, help="select objects drawn in this preview.png box x0,y0,x1,y1")
    p.add_argument("--frames", default="used", help="'used' (frames the selected objects draw), 'all', or extra list")
    p.add_argument("--include", nargs="*", help="keep only sprite ids with these prefixes")
    p.add_argument("--exclude", nargs="*", help="drop sprite ids with these prefixes")
    p.add_argument("--describe", help="JSON {sprite id: short description} used in the prompt")
    p.add_argument("--prompt", help="override the per-category prompt")
    p.add_argument("--negative-prompt", default=NEGATIVE_PROMPT)
    p.add_argument("--scale", type=int, default=4)
    p.add_argument("--upscaler", choices=("esrgan", "lanczos"), default="esrgan",
                   help="4x base before diffusion; lanczos is a CPU-only fallback for dry runs")
    p.add_argument("--sheet", type=int, default=1152, help="max diffusion sheet side in scaled pixels")
    p.add_argument("--margin", type=int, default=8, help="1x margin around each frame inside a sheet")
    p.add_argument("--background", choices=("grey", "bleed"), default="grey")
    p.add_argument("--init-noise", type=float, default=0.0, help="std-dev of grain added inside the art (0..255)")
    p.add_argument("--strength", type=float, default=0.55)
    p.add_argument("--steps", type=int, default=28)
    p.add_argument("--guidance", type=float, default=6.0)
    p.add_argument("--control", type=float, default=0.7)
    p.add_argument("--seed", type=int, default=11)
    p.add_argument("--force", action="store_true", help="regenerate cached sheets")
    p.add_argument("--sigma-l", type=float, default=2.0, help="2x pixels: luminance restore scale")
    p.add_argument("--sigma-ab", type=float, default=2.0, help="2x pixels: chroma restore scale")
    p.add_argument("--detail", type=float, default=1.0, help="gain on the repainted high frequencies")
    p.add_argument("--override", nargs="*", help="per sprite-id prefix: prefix=sigma_l,sigma_ab,detail")
    p.add_argument("--edge-hf", type=float, default=0.5, help="detail kept on the outermost silhouette ring")
    p.add_argument("--base-atlas", help="HD atlas to start from (default manifest.spriteAtlasHd.file)")
    p.add_argument("--base-remap", help="HD remap mask (default manifest.spriteAtlasHd.remap)")
    p.add_argument("--out", type=Path, help="output HD atlas PNG (a copy; the cache and manifest are never modified)")
    p.add_argument("--report", type=Path, help="metrics JSON (default <work>/metrics.json)")
    p.add_argument("--debug-frames", action="store_true")
    return p


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    cache_root, models = resolve_paths(args.cache, args.models)
    args.models = args.models or models
    args.realesrgan = args.realesrgan or (MAIN_REPO / "gameres/tools/realesrgan/realesrgan-ncnn-vulkan")
    directory = (cache_root / args.map).resolve()
    if directory.parent != cache_root.resolve():
        raise SystemExit("--map must be a single cache directory name")
    cache = MapCache(directory, args.base_atlas, args.base_remap)
    refs, owners = select_frames(cache, args)
    if not refs:
        raise SystemExit("no frames selected")
    work = args.work.resolve()
    work.mkdir(parents=True, exist_ok=True)
    if args.stage == "list":
        for r in refs:
            print(r.key, r.rect, "remap" if r.remap else "", owners.get(r.sprite) or "", " ".join(r.aliases))
        print(f"{len(refs)} frames, {len(pack(refs, args.sheet // args.scale, args.margin))} sheets")
        return 0
    if args.stage in ("generate", "all"):
        generate(args, cache, refs, owners, work)
    if args.stage in ("compose", "all"):
        result = compose(args, cache, refs, work)
        if args.out:
            if args.out.resolve() in (cache.base_atlas_path.resolve(), cache.base_remap_path.resolve()):
                raise SystemExit("--out must not overwrite the base atlas")
            Image.fromarray(result["atlas"]).save(args.out)
            print(f"wrote {args.out}", flush=True)
        report_path = args.report or work / "metrics.json"
        report_path.write_text(json.dumps(result["report"], indent=2))
        print(f"wrote {report_path}", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
