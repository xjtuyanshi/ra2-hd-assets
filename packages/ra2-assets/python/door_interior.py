#!/usr/bin/env python3
"""Restore dark indexed-art door interiors in HD atlases, without changing coverage or house paint.

Only NumPy and Pillow are required. Dry runs write review artifacts but never install them.
PNG JSON markers retain source provenance even if a page is copied away from its metrics file.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import sys
import tempfile

import numpy as np
from PIL import Image, ImageDraw, ImageFont, PngImagePlugin

import cache_farm

LUMA = np.array([0.2126, 0.7152, 0.0722], dtype=np.float32)
MARKER = "door_interior"
VERSION = 1
DEFAULT_KEYS = "UnderDoorAnim,UnderRoofDoorAnim"


def srgb_to_linear(rgb: np.ndarray) -> np.ndarray:
    c = rgb.astype(np.float32) / 255.0
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def linear_to_srgb(c: np.ndarray) -> np.ndarray:
    c = np.clip(c, 0, 1)
    return np.where(c <= 0.0031308, c * 12.92, 1.055 * c ** (1 / 2.4) - 0.055)


def gaussian_blur(values: np.ndarray, sigma: float) -> np.ndarray:
    """Separable float Gaussian with replicated edges; no SciPy/OpenCV dependency."""
    radius = math.ceil(3 * sigma)
    positions = np.arange(-radius, radius + 1, dtype=np.float32)
    kernel = np.exp(-0.5 * (positions / sigma) ** 2)
    kernel /= kernel.sum()
    result = values.astype(np.float32)
    for axis in (0, 1):
        padding = [(0, 0)] * result.ndim
        padding[axis] = (radius, radius)
        padded = np.pad(result, padding, mode="edge")
        blurred = np.zeros_like(result)
        for i, weight in enumerate(kernel):
            slices = [slice(None)] * result.ndim
            slices[axis] = slice(i, i + result.shape[axis])
            blurred += weight * padded[tuple(slices)]
        result = blurred
    return result


def masked_blur(values: np.ndarray, coverage: np.ndarray, sigma: float) -> np.ndarray:
    numerator = gaussian_blur(values * coverage, sigma)
    denominator = gaussian_blur(coverage, sigma)
    return numerator / np.maximum(denominator, 1e-8)


def darken_frame(indices: np.ndarray, palette: np.ndarray, hd: np.ndarray,
                 scale: int) -> tuple[np.ndarray, np.ndarray, np.ndarray, dict]:
    """Return RGBA, mask, nearest-upscaled original and sRGB Rec.709 metrics."""
    indices = indices.repeat(scale, axis=0).repeat(scale, axis=1)
    if hd.shape != (*indices.shape, 4):
        raise ValueError("HD frame dimensions do not match indexed rect * scale")
    original = palette[indices].copy()
    coverage = (indices != 0).astype(np.float32)
    original[..., 3] = (coverage * 255).astype(np.uint8)
    lo = srgb_to_linear(original[..., :3]) @ LUMA
    lh = srgb_to_linear(hd[..., :3]) @ LUMA
    sigma = 1.5 * scale
    lo_blur = masked_blur(lo, coverage, sigma)
    # Alpha weighting excludes hidden HD colours from the luminance reference.
    lh_blur = masked_blur(lh, coverage * (hd[..., 3] / 255.0), sigma)
    original_luma = original[..., :3].astype(np.float32) / 255.0 @ LUMA
    dark_luma = masked_blur(original_luma, coverage, sigma)
    t = np.clip((0.24 - dark_luma) / (0.24 - 0.14), 0, 1)
    eligible = (indices != 0) & ~((indices >= 16) & (indices <= 31)) & (hd[..., 3] != 0)
    mask = t * t * (3 - 2 * t) * eligible
    # Feather inward: zero-mask surfaces, transparent texels and paint stay byte-identical.
    mask = np.minimum(mask, gaussian_blur(mask, 1.0)) * eligible
    gain = np.clip((lo_blur + 0.002) / (lh_blur + 0.002), 0, 1)
    linear = srgb_to_linear(hd[..., :3]) * (1 - mask + mask * gain)[..., None]
    neutral = linear @ LUMA
    saturation = 0.5 * mask[..., None]
    linear = linear * (1 - saturation) + neutral[..., None] * saturation
    result = hd.copy()
    active = mask > 0
    result[active, :3] = np.rint(linear_to_srgb(linear[active]) * 255).astype(np.uint8)
    interior = mask > 0.5
    count = int(interior.sum())

    def mean_luma(rgb):
        return float((rgb[interior].astype(np.float32) / 255.0 @ LUMA).mean()) if count else None

    outside = mask == 0
    delta = np.abs(result.astype(np.int16) - hd.astype(np.int16))
    metrics = {
        "interior_pixels": count,
        "original_mean_srgb_luma": mean_luma(original[..., :3]),
        "hd_before_mean_srgb_luma": mean_luma(hd[..., :3]),
        "hd_after_mean_srgb_luma": mean_luma(result[..., :3]),
        "max_abs_change_outside_mask": int(delta[outside].max()) if outside.any() else 0,
    }
    return result, mask, original, metrics


def relative_path(name: str) -> Path:
    path = Path(name)
    if not name or path.is_absolute() or ".." in path.parts or not path.name:
        raise ValueError(f"expected a relative asset path: {name!r}")
    return path


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def select_frames(library: dict, keys: set[str], sprites: set[str] | None) -> dict[int, list[dict]]:
    selected = set()
    for entry in library["types"].values():
        for layer in entry.get("building", {}).get("layers", []):
            if layer.get("key") in keys:
                selected.update(layer[field] for field in ("sprite", "damagedSprite") if layer.get(field))
    if sprites is not None:
        unknown = sprites - selected
        if unknown:
            raise ValueError(f"sprites not referenced by selected door layers: {', '.join(sorted(unknown))}")
        selected &= sprites
    pages = {}
    for name in sorted(selected):
        sprite = library["sprites"][name]
        for index, frame in enumerate(sprite["frames"]):
            if frame is None:
                continue
            page = frame.get("page", 0)
            rect = frame["rect"]
            if len(rect) != 4 or any(type(n) is not int for n in rect) or min(rect[:2]) < 0 or min(rect[2:]) <= 0:
                raise ValueError(f"invalid frame rectangle: {name}[{index}]")
            pages.setdefault(page, []).append({"sprite": name, "frame": index, "rect": rect,
                                               "palette": sprite["palette"]})
    # Identical rect aliases are processed once; partial overlaps cannot safely be patched twice.
    for frames in pages.values():
        for i, left in enumerate(frames):
            x, y, w, h = left["rect"]
            for right in frames[:i]:
                rx, ry, rw, rh = right["rect"]
                if x < rx + rw and rx < x + w and y < ry + rh and ry < y + h:
                    if left["rect"] != right["rect"] or left["palette"] != right["palette"]:
                        raise ValueError("selected frames overlap with different rects or palettes")
    return pages


def check_marker(image: Image.Image, path: Path, force: bool) -> None:
    if MARKER in image.info and not force:
        raise ValueError(f"already produced by door_interior: {path}; use --force to allow reprocessing")


def output_path(directory: Path, rel: Path) -> Path:
    target = directory / rel
    # Refuse output symlinks rather than writing into someone else's cache or review artifacts.
    current = target
    while current != directory:
        if current.is_symlink():
            raise ValueError(f"output path must not contain a symlink: {current}")
        current = current.parent
    target.parent.mkdir(parents=True, exist_ok=True)
    return target


def save_png(image: Image.Image, target: Path, pnginfo: PngImagePlugin.PngInfo) -> None:
    # cache_farm may hard-link the output: replacing it also protects a previous installation.
    fd, name = tempfile.mkstemp(prefix=".door-", suffix=".png", dir=target.parent)
    os.close(fd)
    temporary = Path(name)
    try:
        options = {key: image.info[key] for key in ("icc_profile", "dpi") if key in image.info}
        image.save(temporary, format="PNG", compress_level=6, pnginfo=pnginfo, **options)
        os.replace(temporary, target)
    finally:
        temporary.unlink(missing_ok=True)


def comparison_sheet(rows: list[tuple[str, list[Image.Image]]], target: Path) -> None:
    font_path = Path("/System/Library/Fonts/STHeiti Medium.ttc")
    chinese = font_path.exists()
    font = ImageFont.truetype(str(font_path), 18) if chinese else ImageFont.load_default()
    labels = ["原图 ×2", "HD 修改前", "HD 修改后"] if chinese else ["Original x2", "HD before", "HD after"]
    cell_width = min(650, max(180, max(im.width for _, images in rows for im in images)))
    prepared = []
    for title, images in rows:
        thumbs = []
        for im in images:
            thumb = im.copy()
            thumb.thumbnail((cell_width, 1200), Image.Resampling.NEAREST)
            thumbs.append(thumb)
        prepared.append((title, thumbs, max(im.height for im in thumbs) + 58))
    sheet = Image.new("RGB", (3 * cell_width + 40, sum(row[2] for row in prepared) + 10), (70, 70, 70))
    draw = ImageDraw.Draw(sheet)
    y = 5
    for title, images, height in prepared:
        draw.text((10, y), title, fill="white", font=font)
        for i, (label, im) in enumerate(zip(labels, images)):
            x = 10 + i * (cell_width + 10)
            draw.text((x, y + 25), label, fill="white", font=font)
            sheet.paste(im, (x, y + 50), im)
        y += height
    sheet.save(target, quality=92)


def process_library(directory: Path, out: Path, keys: set[str], sprites: set[str] | None,
                    install: Path | None, dry_run: bool, force: bool) -> tuple[dict, list[tuple[str, Path]]]:
    directory = directory.absolute()  # Keep the lexical farm path for relative installation.
    library = json.loads((directory / "library.json").read_text(encoding="utf-8"))
    theater = library.get("theater", directory.name)
    if relative_path(theater).parts != (theater,):
        raise ValueError("theater must be a single directory name")
    pages = select_frames(library, keys, sprites)
    if not pages:
        raise ValueError(f"no frames referenced by selected door layers in {directory}")
    destination = output_path(out, Path(theater) / "metrics.json").parent
    metrics = {"tool": MARKER, "version": VERSION, "theater": theater, "dry_run": dry_run,
               "installed": False, "luma": "Rec.709 weighted sRGB, range 0..1", "pages": [], "frames": []}
    palettes = {}
    rows = []
    installs = []
    for page_index, frames in sorted(pages.items()):
        indexed_meta = library["spriteAtlases"][page_index]
        hd_meta = library["spriteAtlasesHd"][page_index]
        if not hd_meta:
            raise ValueError(f"missing HD page {page_index}")
        scale = hd_meta["scale"]
        if type(scale) is not int or scale < 1:
            raise ValueError(f"HD page scale must be a positive integer: {scale!r}")
        page_rel = relative_path(hd_meta["file"])
        source = directory / page_rel
        install_rel = None
        if install is not None:
            try:
                install_rel = source.relative_to(install.absolute()).as_posix()
            except ValueError as error:
                raise ValueError("--library must be lexically inside --install farm root") from error
            target = install / install_rel
            if target != source and target.exists():
                with Image.open(target) as existing:
                    check_marker(existing, target, force)
        source_hash = sha256(source)
        with Image.open(directory / relative_path(indexed_meta["file"])) as indexed, Image.open(source) as hd:
            if indexed.mode != "L" or hd.mode != "RGBA":
                raise ValueError("expected mode L indexed page and mode RGBA HD page")
            if hd.size != (indexed.width * scale, indexed.height * scale):
                raise ValueError("HD page dimensions do not match indexed page * scale")
            check_marker(hd, source, force)
            indexed.load()
            hd.load()
            handled = {}
            for frame in frames:
                rect = frame["rect"]
                x, y, w, h = rect
                if x + w > indexed.width or y + h > indexed.height:
                    raise ValueError(f"frame outside indexed page: {frame['sprite']}[{frame['frame']}]")
                identity = (tuple(rect), frame["palette"])
                if identity not in handled:
                    palette_name = frame["palette"]
                    if palette_name not in palettes:
                        with Image.open(directory / relative_path(library["palettes"][palette_name])) as pal:
                            if pal.mode not in ("RGB", "RGBA") or pal.width * pal.height != 256:
                                raise ValueError("palette must contain exactly 256 RGB or RGBA colours")
                            # Existing libraries also encode opaque palettes as RGB; index 0 owns coverage.
                            palettes[palette_name] = np.array(pal.convert("RGBA")).reshape(256, 4)
                    box = (x * scale, y * scale, (x + w) * scale, (y + h) * scale)
                    before = hd.crop(box)
                    indices = np.array(indexed.crop((x, y, x + w, y + h)))
                    after, _, original, measured = darken_frame(indices, palettes[palette_name], np.array(before), scale)
                    after_image = Image.fromarray(after)
                    hd.paste(after_image, box)
                    handled[identity] = (measured, [Image.fromarray(original), before, after_image])
                measured, images = handled[identity]
                record = {**frame, "page": page_index, **measured}
                metrics["frames"].append(record)
                print(json.dumps(record, ensure_ascii=False))
                rows.append((f"{frame['sprite']} [{frame['frame']}] / page {page_index}", images))
            pnginfo = PngImagePlugin.PngInfo()
            for key, value in hd.text.items():
                if key != MARKER:
                    pnginfo.add_text(key, value)
            pnginfo.add_text(MARKER, json.dumps({"tool": MARKER, "version": VERSION, "source_sha256": source_hash}))
            output = output_path(destination, page_rel)
            save_png(hd, output, pnginfo)
        metrics["pages"].append({"page": page_index, "file": page_rel.as_posix(), "scale": scale,
                                  "source_sha256": source_hash, "output_sha256": sha256(output)})
        if install_rel is not None and not dry_run:
            installs.append((install_rel, output))
    comparison_sheet(rows, output_path(destination, Path("door_interior.jpg")))
    return metrics, installs


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--library", type=Path, action="append", required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--keys", default=DEFAULT_KEYS)
    parser.add_argument("--sprites", help="comma-separated subset of sprites referenced by selected keys")
    parser.add_argument("--install", type=Path, help="copy-on-write farm root containing --library")
    parser.add_argument("--dry-run", action="store_true", help="write review outputs only; never install")
    parser.add_argument("--force", action="store_true", help="allow pages with this tool's provenance marker")
    args = parser.parse_args(argv)

    def names(value):
        result = {name.strip() for name in value.split(",")}
        if "" in result:
            raise ValueError("--keys/--sprites require non-empty comma-separated names")
        return result

    try:
        keys = names(args.keys)
        sprites = names(args.sprites) if args.sprites is not None else None
        out = args.out.resolve()
        if args.out.is_symlink():
            raise ValueError("--out must not be a symlink")
        for library in args.library:
            resolved = library.resolve()
            if out == resolved or resolved in out.parents:
                raise ValueError("--out must be outside every source library")
        results = []
        theaters = set()
        for library in args.library:
            # Check output collisions before processing the next theater.
            metadata = json.loads((library / "library.json").read_text(encoding="utf-8"))
            theater = metadata.get("theater", library.name)
            if theater in theaters:
                raise ValueError(f"duplicate output theater: {theater}")
            theaters.add(theater)
            results.append(process_library(library, out, keys, sprites, args.install, args.dry_run, args.force))
        # Generate every page before mutating the farm; marker refusals cannot leave partial installs.
        for metrics, installs in results:
            for rel, path in installs:
                cache_farm.install_file(args.install, rel, path)
            metrics["installed"] = bool(installs)
            target = output_path(out, Path(metrics["theater"]) / "metrics.json")
            target.write_text(json.dumps(metrics, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        return 0
    except (OSError, ValueError, KeyError, IndexError) as error:
        print(f"door_interior: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
