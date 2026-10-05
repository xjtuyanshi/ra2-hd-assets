#!/usr/bin/env python3
"""Make HD delivery images agree with the HD building body wherever the indexed art agrees.

A factory's delivery picture (DeployingAnim body replacement over its UnderDoorAnim interior, and the roof
variants) repeats most of the ordinary body's indexed pixels: only the door, the ramp and a few details really
differ. Independently redrawn HD pages lose that identity, so the whole building visibly changes texture when
a unit is delivered. This tool copies the HD body pixels (colour, house-paint mask and normals) into every
delivery frame pixel whose indexed source equals the body's indexed source at the same draw-point position,
and keeps the delivery art only where the indexed art is structurally different.

Frame i of a delivery sprite pairs with body frame i (healthy 0, damaged 1), matching the renderer's frame
selection. Only NumPy and Pillow are required. Dry runs write review artifacts but never install them.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import sys
import tempfile

import numpy as np
from PIL import Image, ImageDraw, PngImagePlugin

import cache_farm

MARKER = "delivery_body_sync"
VERSION = 1
DEFAULT_KEYS = "DeployingAnim,RoofDeployingAnim,UnderDoorAnim,UnderRoofDoorAnim"
# A difference is structural when a whole 3x3 indexed neighbourhood differs and the region is not a speck;
# independent dithering of otherwise identical renders never reaches that density.
MIN_STRUCTURE_PIXELS = 12
KEEP_DILATION = 2
# A frame whose shared pixels mostly differ from the body is another picture (an opened door's interior),
# not a copy with dither noise; it keeps its own art entirely.
MIN_EQUAL_SHARE = 0.5
FEATHER_SIGMA = 0.6


def relative_path(name: str) -> Path:
    rel = Path(name)
    if rel.is_absolute() or ".." in rel.parts or not rel.parts:
        raise ValueError(f"unsafe relative path: {name!r}")
    return rel


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def box_count(mask: np.ndarray, radius: int) -> np.ndarray:
    """Number of set pixels in the (2r+1)^2 window; pixels outside the image count as unset."""
    padded = np.pad(mask.astype(np.int32), radius)
    total = np.zeros(mask.shape, np.int32)
    for dy in range(2 * radius + 1):
        for dx in range(2 * radius + 1):
            total += padded[dy:dy + mask.shape[0], dx:dx + mask.shape[1]]
    return total


def components(mask: np.ndarray) -> list[np.ndarray]:
    """8-connected components as boolean masks (small frames only; no SciPy dependency)."""
    seen = np.zeros(mask.shape, bool)
    result = []
    height, width = mask.shape
    for sy, sx in zip(*np.nonzero(mask)):
        if seen[sy, sx]:
            continue
        stack = [(sy, sx)]
        seen[sy, sx] = True
        pixels = []
        while stack:
            y, x = stack.pop()
            pixels.append((y, x))
            for ny in range(max(0, y - 1), min(height, y + 2)):
                for nx in range(max(0, x - 1), min(width, x + 2)):
                    if mask[ny, nx] and not seen[ny, nx]:
                        seen[ny, nx] = True
                        stack.append((ny, nx))
        component = np.zeros(mask.shape, bool)
        ys, xs = zip(*pixels)
        component[list(ys), list(xs)] = True
        result.append(component)
    return result


def copy_mask(part: np.ndarray, body: np.ndarray) -> np.ndarray:
    """Indexed part pixels that are the body's own picture: True = take the HD body pixel.

    `body` is already aligned to the part frame (0 where the body has no pixel). Dense structural
    differences and their rim keep the part's art; scattered dither differences are the same surface.
    """
    opaque = part > 0
    shared = opaque & (body > 0)
    differ = opaque & (part != body)
    dense = differ & (box_count(differ, 1) == 9)
    structure = np.zeros(part.shape, bool)
    for component in components(dense):
        if component.sum() >= MIN_STRUCTURE_PIXELS:
            structure |= component
    # The dense core misses the one-pixel border of a differing block; grow back over it and one rim pixel.
    keep = box_count(structure, KEEP_DILATION) > 0
    # Pixels the body does not have are always the part's own; keep their immediate rim coherent too.
    keep |= box_count(opaque & ~shared, 1) > 0
    return shared & ~keep


def gaussian(values: np.ndarray, sigma: float) -> np.ndarray:
    radius = max(1, int(np.ceil(3 * sigma)))
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


def take_mask(part: np.ndarray, body: np.ndarray, mask: np.ndarray) -> np.ndarray:
    """Copied pixels plus the transparent silhouette rim both pictures share (its HD antialiasing)."""
    kept = (part > 0) & ~mask
    rim = (part == 0) & (body == 0) & (box_count(mask, 1) > 0) & (box_count(kept, 1) == 0)
    return mask | rim


def blend_weight(part: np.ndarray, body: np.ndarray, mask: np.ndarray, scale: int) -> np.ndarray:
    """Per-HD-pixel weight of the body picture: one in the copied region, feathered only towards kept art."""
    grow = lambda values: np.repeat(np.repeat(values, scale, 0), scale, 1)
    kept = grow(((part > 0) & ~mask).astype(np.float32))
    if scale > 1:
        kept = gaussian(kept, FEATHER_SIGMA * scale / 2)
    return np.where(grow(take_mask(part, body, mask)), 1 - kept, 0).astype(np.float32)


def blend(part: np.ndarray, body: np.ndarray, weight: np.ndarray, alpha: bool) -> np.ndarray:
    """Mix `body` over `part`; RGBA colour pages mix premultiplied so transparent texels add no fringe."""
    p = part.astype(np.float32)
    b = body.astype(np.float32)
    w = weight if p.ndim == 2 else weight[..., None]
    if alpha:
        pa, ba = p[..., 3:4] / 255, b[..., 3:4] / 255
        out_alpha = pa * (1 - w) + ba * w
        colour = p[..., :3] * pa * (1 - w) + b[..., :3] * ba * w
        colour = np.where(out_alpha > 0, colour / np.maximum(out_alpha, 1e-6), b[..., :3])
        out = np.concatenate([colour, out_alpha * 255], axis=-1)
    else:
        out = p * (1 - w) + b * w
    out = np.clip(np.rint(out), 0, 255).astype(np.uint8)
    # Exact body texels wherever the weight is one: the idle and delivery pictures must be bit-identical there.
    exact = weight >= 0.999
    out[exact] = body[exact]
    return out


def aligned_body(body: np.ndarray, body_offset, part_shape, part_offset, fill=0) -> np.ndarray:
    """Body pixels resampled onto the part frame's grid using the shared draw-point offsets."""
    out = np.full(part_shape + body.shape[2:], fill, body.dtype)
    dx, dy = part_offset[0] - body_offset[0], part_offset[1] - body_offset[1]
    x0, y0 = max(0, -dx), max(0, -dy)
    x1, y1 = min(part_shape[1], body.shape[1] - dx), min(part_shape[0], body.shape[0] - dy)
    if x1 > x0 and y1 > y0:
        out[y0:y1, x0:x1] = body[y0 + dy:y1 + dy, x0 + dx:x1 + dx]
    return out


def select_pairs(library: dict, keys: set[str], types: set[str] | None) -> list[dict]:
    """(type, layer key, delivery sprite, frame) records paired with the same body frame index."""
    sprites = library["sprites"]
    pairs = []
    seen = set()
    for type_name, entry in sorted(library.get("types", {}).items()):
        if types is not None and type_name not in types:
            continue
        building = entry.get("building") if entry.get("kind") == "building" else None
        body_name = entry.get("sprite")
        if not building or body_name not in sprites:
            continue
        body = sprites[body_name]
        for layer in building.get("layers", []):
            if layer.get("key") not in keys:
                continue
            for part_name in (layer.get("sprite"), layer.get("damagedSprite")):
                part = sprites.get(part_name) if part_name else None
                if not part or part.get("palette") != body.get("palette"):
                    continue
                for index in range(min(len(part["frames"]), len(body["frames"]))):
                    part_frame, body_frame = part["frames"][index], body["frames"][index]
                    if part_frame["rect"][2] <= 0 or body_frame["rect"][2] <= 0:
                        continue
                    identity = (part_frame.get("page", 0), tuple(part_frame["rect"]))
                    if identity in seen:
                        continue
                    seen.add(identity)
                    pairs.append({"type": type_name, "key": layer["key"], "sprite": part_name, "frame": index,
                                  "body": body_name, "part": part_frame, "bodyFrame": body_frame})
    return pairs


class Pages:
    """Lazily loaded, in-place edited atlas pages of one library directory."""

    def __init__(self, directory: Path):
        self.directory = directory
        self.images: dict[str, np.ndarray] = {}
        self.info: dict[str, dict] = {}
        self.dirty: set[str] = set()

    def get(self, name: str) -> np.ndarray:
        if name not in self.images:
            with Image.open(self.directory / relative_path(name)) as image:
                self.info[name] = {"text": dict(getattr(image, "text", {})), "mode": image.mode,
                                   "options": {k: image.info[k] for k in ("icc_profile", "dpi") if k in image.info}}
                self.images[name] = np.array(image)
        return self.images[name]


def crop(page: np.ndarray, rect, scale: int) -> np.ndarray:
    x, y, w, h = rect
    if (y + h) * scale > page.shape[0] or (x + w) * scale > page.shape[1]:
        raise ValueError(f"frame rect {rect} outside page {page.shape[1]}x{page.shape[0]} at scale {scale}")
    return page[y * scale:(y + h) * scale, x * scale:(x + w) * scale]


def process_library(directory: Path, out: Path, keys: set[str], types: set[str] | None) -> tuple[dict, list[str]]:
    directory = directory.absolute()
    library = json.loads((directory / "library.json").read_text(encoding="utf-8"))
    theater = library.get("theater", directory.name)
    if relative_path(theater).parts != (theater,):
        raise ValueError("theater must be a single directory name")
    normals_path = directory / "normals.json"
    normals = json.loads(normals_path.read_text(encoding="utf-8")).get("pages", {}) if normals_path.exists() else {}
    indexed_meta, hd_meta = library["spriteAtlases"], library.get("spriteAtlasesHd") or []
    pages = Pages(directory)
    metrics = {"tool": MARKER, "version": VERSION, "theater": theater, "frames": [], "pages": []}
    review = []

    def layers(page_index: int) -> list[tuple[str, str, int]]:
        """(kind, file, scale relative to the indexed page) of every HD companion of one atlas page."""
        hd = hd_meta[page_index] if page_index < len(hd_meta) else None
        if not hd:
            return []
        indexed_width = indexed_meta[page_index]["width"]
        found = [("colour", hd["file"], int(hd["scale"]))]
        if hd.get("remap"):
            found.append(("remap", hd["remap"], int(hd["scale"])))
        normal = normals.get(str(page_index))
        if normal and normal.get("atlas") == hd["file"]:
            width = normal.get("materialWidth", normal["width"])
            if width % indexed_width:
                raise ValueError(f"normals page {normal['file']} is not an integer multiple of the indexed page")
            found.append(("normals", normal["file"], width // indexed_width))
        return found

    for pair in select_pairs(library, keys, types):
        part_frame, body_frame = pair["part"], pair["bodyFrame"]
        part_page, body_page = part_frame.get("page", 0), body_frame.get("page", 0)
        part_index = crop(pages.get(indexed_meta[part_page]["file"]), part_frame["rect"], 1)
        body_index = crop(pages.get(indexed_meta[body_page]["file"]), body_frame["rect"], 1)
        if part_index.ndim != 2 or body_index.ndim != 2:
            raise ValueError("indexed atlas pages must be single-channel")
        aligned = aligned_body(body_index, body_frame["offset"], part_index.shape, part_frame["offset"])
        mask = copy_mask(part_index, aligned)
        opaque = int((part_index > 0).sum())
        record = {k: pair[k] for k in ("type", "key", "sprite", "frame", "body")}
        shared = int(((part_index > 0) & (aligned > 0)).sum())
        equal = int(((part_index > 0) & (part_index == aligned)).sum())
        record.update(opaquePixels=opaque, sharedPixels=shared, equalPixels=equal, copiedPixels=int(mask.sum()))
        part_layers, body_layers = layers(part_page), dict((k, (f, s)) for k, f, s in layers(body_page))
        if not shared or equal < MIN_EQUAL_SHARE * shared or not mask.any() or not part_layers:
            record["applied"] = False
            metrics["frames"].append(record)
            continue
        record["applied"] = True
        for kind, name, scale in part_layers:
            if kind not in body_layers or body_layers[kind][1] != scale:
                raise ValueError(f"{pair['sprite']}[{pair['frame']}]: body page lacks a matching {kind} page")
            body_name = body_layers[kind][0]
            page = pages.get(name)
            target = crop(page, part_frame["rect"], scale)
            source = crop(pages.get(body_name), body_frame["rect"], scale)
            if target.ndim != source.ndim:
                raise ValueError(f"{kind} pages of {pair['sprite']} and {pair['body']} differ in channels")
            scaled = lambda v: (v[0] * scale, v[1] * scale)
            body_hd = aligned_body(source, scaled(body_frame["offset"]), target.shape[:2], scaled(part_frame["offset"]))
            weight = blend_weight(part_index, aligned, mask, scale)
            before = target.copy()
            target[...] = blend(target, body_hd, weight, kind == "colour" and target.ndim == 3 and target.shape[2] == 4)
            if not np.array_equal(before, target):
                pages.dirty.add(name)
            if kind == "colour":
                review.append((f"{pair['type']} {pair['key']} {pair['sprite']}[{pair['frame']}]", before, body_hd,
                               target.copy(), np.repeat(np.repeat(mask, scale, 0), scale, 1)))
        metrics["frames"].append(record)

    destination = out / theater
    destination.mkdir(parents=True, exist_ok=True)
    written = []
    for name in sorted(pages.dirty):
        info = pages.info[name]
        pnginfo = PngImagePlugin.PngInfo()
        for key, value in info["text"].items():
            if key != MARKER:
                pnginfo.add_text(key, value)
        source_hash = sha256(directory / relative_path(name))
        pnginfo.add_text(MARKER, json.dumps({"tool": MARKER, "version": VERSION, "source_sha256": source_hash}))
        target = destination / relative_path(name)
        target.parent.mkdir(parents=True, exist_ok=True)
        fd, temporary = tempfile.mkstemp(prefix=".sync-", suffix=".png", dir=target.parent)
        os.close(fd)
        try:
            Image.fromarray(pages.images[name], info["mode"]).save(
                temporary, format="PNG", compress_level=4, pnginfo=pnginfo, **info["options"])
            os.replace(temporary, target)
        finally:
            Path(temporary).unlink(missing_ok=True)
        metrics["pages"].append({"file": name, "source_sha256": source_hash, "output_sha256": sha256(target)})
        written.append(name)
    if review:
        review_sheet(review, destination / "delivery_body_sync.jpg")
    return metrics, written


def review_sheet(rows: list, target: Path) -> None:
    """Per frame: delivery before | body | delivery after | copied region (green) on a neutral ground."""
    def cell(image: np.ndarray) -> Image.Image:
        ground = Image.new("RGBA", (image.shape[1], image.shape[0]), (70, 90, 60, 255))
        ground.alpha_composite(Image.fromarray(image, "RGBA"))
        return ground.convert("RGB")

    cells = []
    for title, before, body, after, mask in rows:
        shade = np.zeros(mask.shape + (4,), np.uint8)
        shade[mask] = (40, 220, 60, 255)
        shade[~mask & (before[..., 3] > 0)] = (220, 60, 40, 255)
        images = [cell(before), cell(body), cell(after), cell(shade)]
        row = Image.new("RGB", (sum(im.width for im in images) + 30, images[0].height + 22), (30, 30, 30))
        x = 0
        for image in images:
            row.paste(image, (x, 22))
            x += image.width + 10
        ImageDraw.Draw(row).text((4, 4), title + "  before | body | after | green=copied red=kept", fill=(255, 235, 150))
        cells.append(row)
    sheet = Image.new("RGB", (max(c.width for c in cells), sum(c.height + 6 for c in cells)), (0, 0, 0))
    y = 0
    for row in cells:
        sheet.paste(row, (0, y))
        y += row.height + 6
    sheet.save(target, quality=90)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--library", type=Path, action="append", required=True)
    parser.add_argument("--out", type=Path, required=True, help="review and staged pages; outside every library")
    parser.add_argument("--keys", default=DEFAULT_KEYS)
    parser.add_argument("--types", help="comma-separated building types; default every building with these layers")
    parser.add_argument("--install", type=Path, help="copy-on-write farm root containing --library")
    parser.add_argument("--dry-run", action="store_true", help="write review outputs only; never install")
    args = parser.parse_args(argv)

    def names(value: str) -> set[str]:
        result = {name.strip() for name in value.split(",")}
        if "" in result:
            raise ValueError("--keys/--types require non-empty comma-separated names")
        return result

    try:
        keys = names(args.keys)
        types = names(args.types) if args.types is not None else None
        out = args.out.resolve()
        if args.out.is_symlink():
            raise ValueError("--out must not be a symlink")
        seen = set()
        for library in args.library:
            resolved = library.resolve()
            if out == resolved or resolved in out.parents:
                raise ValueError("--out must be outside every source library")
            install_rel = None
            if args.install is not None:
                try:
                    install_rel = library.absolute().relative_to(args.install.absolute())
                except ValueError as error:
                    raise ValueError("--library must be lexically inside --install farm root") from error
            metrics, written = process_library(library, out, keys, types)
            if metrics["theater"] in seen:
                raise ValueError(f"duplicate output theater: {metrics['theater']}")
            seen.add(metrics["theater"])
            installed = []
            if install_rel is not None and not args.dry_run:
                for name in written:
                    rel = (install_rel / relative_path(name)).as_posix()
                    cache_farm.install_file(args.install, rel, out / metrics["theater"] / relative_path(name))
                    installed.append(rel)
            metrics["installed"] = installed
            (out / metrics["theater"] / "metrics.json").write_text(
                json.dumps(metrics, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
            applied = [f for f in metrics["frames"] if f["applied"]]
            print(f"{metrics['theater']}: {len(applied)}/{len(metrics['frames'])} frames synced, "
                  f"{len(written)} pages written, {len(installed)} installed")
        return 0
    except (OSError, ValueError, KeyError, IndexError) as error:
        print(f"{MARKER}: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
