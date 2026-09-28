#!/usr/bin/env python3
"""Offline, tiled SDXL material detail for an existing RA2 terrain-map cache.

NumPy and Pillow suffice for --dry-run. Diffusion imports are deliberately lazy.
Coordinates, alpha, and the terrainMap contract remain in input-image pixels.
"""

from __future__ import annotations

import argparse
from dataclasses import dataclass
import hashlib
import importlib.metadata
import json
import math
import os
from pathlib import Path
import sys
import tempfile
import time
import warnings

import numpy as np
from PIL import Image


MAIN_REPO = Path("/Users/lukegogogo/claude code projects/红警2高清重制")
DEFAULT_PROMPT = (
    "top-down isometric real-time strategy game terrain, highly detailed realistic "
    "ground materials, grass blades, soil, pebbles, sandstone rock strata, asphalt "
    "with cracks, concrete tiles, crisp, sharp, natural lighting, 2026 remaster"
)
NEGATIVE_PROMPT = (
    "blurry, painting, cartoon, text, watermark, people, buildings, vehicles, trees, "
    "perspective, lens distortion, oversaturated"
)
CACHE_VERSION = 1


@dataclass(frozen=True)
class Tile:
    index: int
    x: int
    y: int
    width: int
    height: int
    left: int = 0
    right: int = 0
    top: int = 0
    bottom: int = 0


def tile_layout(width: int, height: int, tile_size: int, overlap: int) -> list[Tile]:
    """Anchor the final row/column to the edge; retain actual overlap lengths."""
    if min(width, height, tile_size) < 1 or not 0 <= overlap < tile_size:
        raise ValueError("positive dimensions and 0 <= overlap < tile are required")

    def starts(length: int) -> list[int]:
        if length <= tile_size:
            return [0]
        positions = list(range(0, length - tile_size + 1, tile_size - overlap))
        if positions[-1] != length - tile_size:
            positions.append(length - tile_size)
        return positions

    xs, ys = starts(width), starts(height)
    result = []
    for row, y in enumerate(ys):
        h = min(tile_size, height - y)
        for col, x in enumerate(xs):
            w = min(tile_size, width - x)
            result.append(Tile(
                len(result), x, y, w, h,
                max(0, xs[col - 1] + tile_size - x) if col else 0,
                max(0, x + w - xs[col + 1]) if col + 1 < len(xs) else 0,
                max(0, ys[row - 1] + tile_size - y) if row else 0,
                max(0, y + h - ys[row + 1]) if row + 1 < len(ys) else 0,
            ))
    return result


def tile_weights(tile: Tile) -> np.ndarray:
    """Positive, pixel-centred raised cosines; image boundaries never fade out.

    Two adjacent ramps complement each other. Large/triple overlaps are handled
    by normalizing the accumulated weights, rather than assuming their sum is 1.
    """
    def axis(length: int, before: int, after: int) -> np.ndarray:
        weights = np.ones(length, dtype=np.float32)
        for size, reverse in ((before, False), (after, True)):
            if size:
                phase = (np.arange(size, dtype=np.float32) + 0.5) / size
                ramp = 0.5 - 0.5 * np.cos(np.pi * phase)
                if reverse:
                    weights[-size:] *= ramp[::-1]
                else:
                    weights[:size] *= ramp
        return weights

    return axis(tile.height, tile.top, tile.bottom)[:, None] * axis(
        tile.width, tile.left, tile.right
    )[None, :]


def gaussian_blur(array: np.ndarray, sigma: float) -> np.ndarray:
    """Separable float32 Gaussian, truncated at 3 sigma, with clamped edges.

    Avoid Pillow's 8-bit intermediate rounding and a SciPy dependency. Process
    one channel at a time to bound scratch memory on whole-map images.
    """
    if not math.isfinite(sigma) or sigma < 0:
        raise ValueError("sigma must be finite and non-negative")
    source = np.asarray(array, dtype=np.float32)
    # At this scale all off-centre kernel values round to zero in float32.
    # Handle it explicitly so a positive sigma cannot underflow in division.
    if sigma <= 1e-3:
        return source.copy()
    radius = math.ceil(3 * sigma)
    offsets = np.arange(-radius, radius + 1, dtype=np.float32)
    kernel = np.exp(-0.5 * (offsets / sigma) ** 2)
    kernel /= kernel.sum()
    planes = source[..., None] if source.ndim == 2 else source
    result = np.empty_like(planes)
    h, w = source.shape[:2]
    for channel in range(planes.shape[2]):
        padded = np.pad(planes[..., channel], ((0, 0), (radius, radius)), mode="edge")
        horizontal = np.zeros((h, w), dtype=np.float32)
        for offset, weight in enumerate(kernel):
            horizontal += padded[:, offset:offset + w] * weight
        padded = np.pad(horizontal, ((radius, radius), (0, 0)), mode="edge")
        vertical = result[..., channel]
        vertical.fill(0)
        for offset, weight in enumerate(kernel):
            vertical += padded[offset:offset + h, :] * weight
    return result[..., 0] if source.ndim == 2 else result


def restore_colors(generated: np.ndarray, original: np.ndarray, sigma: float) -> np.ndarray:
    """Replace generated low frequencies with the original palette and shading."""
    out = np.asarray(generated, dtype=np.float32) - gaussian_blur(generated, sigma)
    out += gaussian_blur(original, sigma)
    return np.clip(out, 0, 255)


def preserve_water(
    generated: np.ndarray, original: np.ndarray, mask: np.ndarray, feather: float = 3.0
) -> np.ndarray:
    """Keep every mask > 0.5 pixel exact; feather only onto the land side."""
    water = np.asarray(mask) > 0.5
    mix = np.minimum(1, 2 * gaussian_blur(water.astype(np.float32), feather))
    mix[water] = 1
    out = generated * (1 - mix[..., None]) + original * mix[..., None]
    out[water] = original[water]
    return out.astype(np.float32)


def fill_transparent_rgb(rgba: np.ndarray) -> np.ndarray:
    """Bleed neighbouring colours into model-only borders, without changing alpha."""
    rgb = rgba[..., :3].astype(np.float32).copy()
    known = rgba[..., 3] > 0
    mean = rgb[known].mean(axis=0) if known.any() else np.zeros(3, dtype=np.float32)
    for _ in range(16):
        if known.all():
            break
        total = np.zeros_like(rgb)
        count = np.zeros(known.shape, dtype=np.float32)
        for target, neighbour in (
            ((slice(1, None), slice(None)), (slice(None, -1), slice(None))),
            ((slice(None, -1), slice(None)), (slice(1, None), slice(None))),
            ((slice(None), slice(1, None)), (slice(None), slice(None, -1))),
            ((slice(None), slice(None, -1)), (slice(None), slice(1, None))),
        ):
            valid = known[neighbour]
            total[target] += rgb[neighbour] * valid[..., None]
            count[target] += valid
        added = ~known & (count > 0)
        if not added.any():
            break
        rgb[added] = total[added] / count[added, None]
        known[added] = True
    rgb[~known] = mean
    return np.rint(rgb).astype(np.uint8)


def resolve_paths(cache: Path | None, models: Path | None) -> tuple[Path, Path]:
    """Infer a checkout only from explicit gameres paths, never this worktree."""
    root = MAIN_REPO
    for candidate in (cache, models):
        if candidate is not None:
            candidate = Path(candidate).expanduser().resolve()
            resource_root = next((p for p in (candidate, *candidate.parents) if p.name == "gameres"), None)
            if resource_root is not None:
                root = resource_root.parent
                break
    return (
        Path(cache).expanduser().resolve() if cache else root / "gameres/hd-cache",
        Path(models).expanduser().resolve() if models else root / "gameres/tools/diffusion/models",
    )


def map_path(directory: Path, name: str) -> Path:
    path = (directory / name).resolve()
    if not path.is_relative_to(directory):
        raise ValueError(f"cache file must stay inside {directory}: {name}")
    return path


def atomic_image(path: Path, pixels: np.ndarray) -> None:
    """A cancelled tile or final image must never appear complete to --resume."""
    with tempfile.NamedTemporaryFile(dir=path.parent, prefix=".remat-", suffix=".tmp", delete=False) as handle:
        temporary = Path(handle.name)
    try:
        Image.fromarray(pixels).save(temporary, format="PNG")
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def atomic_json(path: Path, value: dict) -> None:
    with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent,
                                     prefix=".remat-", suffix=".tmp", delete=False) as handle:
        temporary = Path(handle.name)
        try:
            json.dump(value, handle, indent=2, ensure_ascii=False)
            handle.write("\n")
        except BaseException:
            temporary.unlink(missing_ok=True)
            raise
    try:
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def model_identity(models: Path) -> dict:
    """Detect local model replacements without hashing multi-GB weight files."""
    files = []
    for name in ("sdxl-base", "sdxl-vae-fp16-fix", "controlnet-tile-sdxl"):
        for path in sorted((models / name).rglob("*")):
            if path.is_file():
                stat = path.stat()
                files.append((str(path.relative_to(models)), stat.st_size, stat.st_mtime_ns))
    versions = {}
    for package in ("torch", "diffusers", "transformers", "numpy", "Pillow"):
        try:
            versions[package] = importlib.metadata.version(package)
        except importlib.metadata.PackageNotFoundError:
            versions[package] = "missing"
    return {"path": str(models), "files": files, "versions": versions}


class DiffusionRunner:
    def __init__(self, models: Path, args: argparse.Namespace):
        # Missing local files must fail before any loader can attempt a download.
        for name, component in (("sdxl-base", "unet"), ("sdxl-vae-fp16-fix", ""),
                                ("controlnet-tile-sdxl", "")):
            folder = models / name / component
            if not folder.is_dir() or not any(folder.glob("*.safetensors")):
                raise ValueError(f"missing local safetensors weights in {folder}; finish the local model setup")
        os.environ["HF_HUB_OFFLINE"] = "1"
        os.environ["TRANSFORMERS_OFFLINE"] = "1"
        # Also avoid bytecode writes into the separately managed model venv.
        sys.dont_write_bytecode = True
        import torch
        from diffusers import AutoencoderKL, ControlNetModel, StableDiffusionXLControlNetImg2ImgPipeline

        self.torch = torch
        self.args = args
        device = "mps" if torch.backends.mps.is_available() else "cpu"
        dtype = torch.float16 if device == "mps" else torch.float32
        if device == "cpu":
            warnings.warn("MPS unavailable: falling back to CPU float32; diffusion will be very slow", stacklevel=2)
        common = {"torch_dtype": dtype, "local_files_only": True, "use_safetensors": True}

        def variant(folder: Path) -> dict:
            return {"variant": "fp16"} if any(folder.glob("*.fp16.safetensors")) else {}

        vae_dir, control_dir = models / "sdxl-vae-fp16-fix", models / "controlnet-tile-sdxl"
        vae = AutoencoderKL.from_pretrained(vae_dir, force_upcast=False, **common, **variant(vae_dir))
        controlnet = ControlNetModel.from_pretrained(control_dir, **common, **variant(control_dir))
        pipe = StableDiffusionXLControlNetImg2ImgPipeline.from_pretrained(
            models / "sdxl-base", variant="fp16", vae=vae, controlnet=controlnet,
            add_watermarker=False, **common,
        )
        self.pipe = pipe.to(device)
        self.pipe.enable_attention_slicing()
        # Newer diffusers moved tiling/slicing onto the VAE itself; keep both spellings working.
        for owner in (self.pipe, self.pipe.vae):
            if hasattr(owner, "enable_tiling") or hasattr(owner, "enable_vae_tiling"):
                getattr(owner, "enable_vae_tiling", getattr(owner, "enable_tiling", None))()
                break
        for owner in (self.pipe, self.pipe.vae):
            if hasattr(owner, "enable_vae_slicing") or hasattr(owner, "enable_slicing"):
                getattr(owner, "enable_vae_slicing", getattr(owner, "enable_slicing", None))()
                break
        self.pipe.set_progress_bar_config(disable=True)
        print(f"Loaded local SDXL + tile ControlNet on {device} ({dtype})", flush=True)

    def __call__(self, rgba: np.ndarray, seed: int) -> np.ndarray:
        h, w = rgba.shape[:2]
        # Diffusers rounds dimensions to VAE multiples. Pad instead of rescaling
        # geometry, and give small region trials a useful SDXL canvas.
        ph, pw = max(512, math.ceil(h / 8) * 8), max(512, math.ceil(w / 8) * 8)
        rgb = np.pad(fill_transparent_rgb(rgba), ((0, ph - h), (0, pw - w), (0, 0)), mode="edge")
        image = Image.fromarray(rgb)
        generator = self.torch.Generator(device="cpu").manual_seed(seed)
        with self.torch.inference_mode():
            result = self.pipe(
                prompt=self.args.prompt, negative_prompt=self.args.negative_prompt,
                image=image, control_image=image, width=pw, height=ph,
                strength=self.args.strength, num_inference_steps=self.args.steps,
                guidance_scale=self.args.guidance, controlnet_conditioning_scale=self.args.control,
                generator=generator, output_type="pil",
            ).images[0]
        if result.size != (pw, ph):
            raise ValueError(f"diffusion returned {result.size}; expected {(pw, ph)}")
        return np.asarray(result.convert("RGB"))[:h, :w].copy()


def parse_region(value: str) -> tuple[int, int, int, int]:
    try:
        parts = tuple(int(part) for part in value.split(","))
    except ValueError as error:
        raise argparse.ArgumentTypeError("region must be x,y,width,height integers") from error
    if len(parts) != 4 or min(parts[:2]) < 0 or min(parts[2:]) < 1:
        raise argparse.ArgumentTypeError("region needs non-negative x,y and positive width,height")
    return parts


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--map", required=True, help="map directory name within the cache (e.g. RiverRam)")
    parser.add_argument("--cache", type=Path, help="cache root; default: main checkout gameres/hd-cache")
    parser.add_argument("--models", type=Path, help="local model root; default: main checkout gameres/tools/diffusion/models")
    parser.add_argument("--input", help="image path relative to the map directory; default: terrainMap.file")
    parser.add_argument("--strength", type=float, default=0.4)
    parser.add_argument("--steps", type=int, default=24)
    parser.add_argument("--guidance", type=float, default=5.0)
    parser.add_argument("--control", type=float, default=0.8)
    parser.add_argument("--tile", type=int, default=1024)
    parser.add_argument("--overlap", type=int, default=192)
    parser.add_argument("--seed", type=int, default=7)
    parser.add_argument("--negative-prompt", default=NEGATIVE_PROMPT)
    parser.add_argument("--prompt", default=DEFAULT_PROMPT)
    parser.add_argument("--color-sigma", type=float, default=6.0, help="colour restoration Gaussian sigma in input pixels")
    parser.add_argument("--water-feather", type=float, default=3.0, help="land-side water transition sigma in input pixels")
    parser.add_argument("--region", type=parse_region, help="x,y,width,height in current input pixels; write comparison only")
    parser.add_argument("--dry-run", action="store_true", help="identity inference, with normal output and manifest writes")
    parser.add_argument("--resume", action="store_true", help="save/reuse fingerprinted tiles under <cache>/<map>/.remat-tiles")
    return parser


def validate_options(args: argparse.Namespace) -> None:
    if not args.map or Path(args.map).name != args.map or args.map in (".", ".."):
        raise ValueError("--map must be a single map directory name")
    for name in ("strength", "guidance", "control", "color_sigma", "water_feather"):
        value = getattr(args, name)
        if not math.isfinite(value) or value < 0:
            raise ValueError(f"--{name.replace('_', '-')} must be finite and non-negative")
    if args.strength > 1 or args.steps < 1:
        raise ValueError("--strength must be 0..1 and --steps must be positive")
    if args.strength > 0 and int(args.steps * args.strength) < 1:
        raise ValueError("--strength * --steps must be at least 1 (or use --strength 0 for identity)")
    if args.tile < 1 or not 0 <= args.overlap < args.tile:
        raise ValueError("require --tile > 0 and 0 <= --overlap < --tile")
    if not 0 <= args.seed < 2**63:
        raise ValueError("--seed must be a non-negative signed 64-bit integer")


def run(args: argparse.Namespace) -> Path:
    validate_options(args)
    cache, models = resolve_paths(args.cache, args.models)
    directory = map_path(cache, args.map)
    manifest_path = map_path(directory, "manifest.json")
    manifest_bytes = manifest_path.read_bytes()
    manifest = json.loads(manifest_bytes)
    reference = manifest.get("terrainMap")
    if not isinstance(reference, dict) or not reference.get("file"):
        raise ValueError("manifest.terrainMap.file is missing; run terrain-map/upscale first")
    if not reference.get("waterMask"):
        raise ValueError("manifest.terrainMap.waterMask is required to preserve water; run terrain-map/upscale first")
    input_path = map_path(directory, args.input or reference["file"])
    water_path = map_path(directory, reference["waterMask"])
    with Image.open(input_path) as image:
        if image.mode != "RGBA":
            raise ValueError("terrain input must be RGBA to preserve its alpha")
        if image.size != (reference.get("width"), reference.get("height")):
            raise ValueError("input dimensions must match manifest.terrainMap width/height")
        rgba = np.asarray(image).copy()
    with Image.open(water_path) as image:
        if image.mode != "L" or image.size != (rgba.shape[1], rgba.shape[0]):
            raise ValueError("water mask must be grayscale (L) and match the input dimensions")
        water = np.asarray(image).astype(np.float32) / 255
    if args.region:
        x, y, w, h = args.region
        if x + w > rgba.shape[1] or y + h > rgba.shape[0]:
            raise ValueError("--region must fit inside the current input image")
        rgba = rgba[y:y + h, x:x + w].copy()
        water = water[y:y + h, x:x + w].copy()
    h, w = rgba.shape[:2]
    tiles = tile_layout(w, h, args.tile, args.overlap)
    if args.seed + len(tiles) - 1 >= 2**63:
        raise ValueError("--seed plus tile index exceeds the signed 64-bit range")
    identity = args.dry_run or args.strength == 0
    tile_dir = None
    if args.resume:
        signature = {
            "version": CACHE_VERSION, "input": str(input_path),
            "shape": list(rgba.shape),
            "rgba": hashlib.sha256(rgba.tobytes()).hexdigest(),
            "water": hashlib.sha256(water.tobytes()).hexdigest(),
            "options": {key: value for key, value in vars(args).items()
                        if key not in ("cache", "models", "input", "resume")},
            "negative_prompt": NEGATIVE_PROMPT,
            "models": None if identity else model_identity(models),
        }
        fingerprint = hashlib.sha256(json.dumps(signature, sort_keys=True).encode()).hexdigest()
        tile_dir = map_path(directory, f".remat-tiles/{fingerprint}")
        tile_dir.mkdir(parents=True, exist_ok=True)
        atomic_json(tile_dir / "job.json", signature)

    accum = np.zeros((h, w, 3), dtype=np.float32)
    weights = np.zeros((h, w), dtype=np.float32)
    runner = None
    started = time.perf_counter()
    print(f"Input: {input_path}\nProcessing {w}x{h}, {len(tiles)} tiles; "
          f"{'identity' if identity else 'local diffusion'}", flush=True)
    for tile in tiles:
        before = time.perf_counter()
        ys, xs = slice(tile.y, tile.y + tile.height), slice(tile.x, tile.x + tile.width)
        source = rgba[ys, xs]
        prefix = f"Tile {tile.index + 1}/{len(tiles)} ({tile.x},{tile.y},{tile.width},{tile.height})"
        if not source[..., 3].any():
            status = "transparent, skipped"
        else:
            cached = map_path(tile_dir, f"{tile.index:06d}.png") if tile_dir else None
            generated = None
            if cached and cached.exists():
                try:
                    with Image.open(cached) as image:
                        if image.mode != "RGB" or image.size != (tile.width, tile.height):
                            raise ValueError("incorrect cached tile mode or dimensions")
                        generated = np.asarray(image).copy()
                except (OSError, ValueError) as error:
                    warnings.warn(f"regenerating invalid tile {cached}: {error}", stacklevel=2)
            if generated is not None:
                status = "resumed"
            else:
                print(f"{prefix}: starting, seed={args.seed + tile.index}", flush=True)
                if identity:
                    generated = source[..., :3].copy()
                else:
                    if runner is None:
                        runner = DiffusionRunner(models, args)
                    generated = runner(source, args.seed + tile.index)
                if cached:
                    atomic_image(cached, generated)
                status = "done"
            weight = tile_weights(tile)
            accum[ys, xs] += generated.astype(np.float32) * weight[..., None]
            weights[ys, xs] += weight
        elapsed = time.perf_counter() - started
        eta = elapsed / (tile.index + 1) * (len(tiles) - tile.index - 1)
        print(f"{prefix}: {status}, {time.perf_counter() - before:.2f}s, ETA {eta:.1f}s", flush=True)

    original = rgba[..., :3].astype(np.float32)
    blended = original.copy()
    np.divide(accum, weights[..., None], out=blended, where=weights[..., None] > 0)
    # Never feed generated outside-map RGB into the colour-restoration filter.
    blended[rgba[..., 3] == 0] = original[rgba[..., 3] == 0]
    del accum, weights, runner
    restored = restore_colors(blended, original, args.color_sigma)
    restored = preserve_water(restored, original, water, args.water_feather)
    result = rgba.copy()
    result[..., :3] = np.rint(restored).clip(0, 255).astype(np.uint8)
    result[rgba[..., 3] == 0] = rgba[rgba[..., 3] == 0]
    if args.region:
        output = map_path(directory, "remat-compare.png")
        if output in (input_path, water_path):
            raise ValueError("comparison output would overwrite an input")
        atomic_image(output, np.concatenate((rgba, result), axis=1))
    else:
        # Preserve prior outputs too. Explicit --input makes reruns/resume use
        # the same source after a previous successful manifest update.
        output = input_path.with_name(f"{input_path.stem}-remat.png")
        suffix = 2
        while output.exists():
            output = input_path.with_name(f"{input_path.stem}-remat-{suffix}.png")
            suffix += 1
        output = map_path(directory, str(output))
        if manifest_path.read_bytes() != manifest_bytes:
            raise ValueError("manifest changed during processing; refusing to overwrite concurrent edits")
        atomic_image(output, result)
        reference["file"] = output.relative_to(directory).as_posix()
        atomic_json(manifest_path, manifest)
    print(f"Wrote {output} ({time.perf_counter() - started:.1f}s total)", flush=True)
    return output


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        run(args)
    except (OSError, ValueError, ImportError, RuntimeError) as error:
        print(f"rematerialize: {error}", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        print("\nInterrupted; --resume can reuse completed tiles with the same input and options.", file=sys.stderr)
        return 130
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
