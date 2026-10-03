#!/usr/bin/env python3
"""Export, rebuild and install dedicated ISO-palette building rubble atlas pages.

All paths are explicit. Upscaling and image-model redraws are supplied by the caller;
this tool never extracts, downloads or generates game resources.
"""
from __future__ import annotations

import argparse
import copy
import hashlib
import json
import math
from pathlib import Path
import shutil
import tempfile

import cv2
import numpy as np
from PIL import Image

import cache_farm
import hybrid_redraw


PAGE = "sprites-rubble-l5f.png"
HD_PAGE = "sprites-rubble-l5f@2x.png"
REMAP = "sprites-rubble-l5f@2x-remap.png"
PAGE_WIDTH = 2048
GREY = np.full(3, 118, np.float32)


def read_json(path: Path) -> dict:
    return json.loads(Path(path).read_text(encoding="utf-8"))


def read_image(path: Path, mode: str | None = None) -> np.ndarray:
    with Image.open(path) as image:
        return np.array(image.convert(mode) if mode else image)


def save_image(root: Path, name: str, pixels: np.ndarray) -> None:
    # Staging plus install_file also makes repeated builds safe after a hard-link install.
    with tempfile.TemporaryDirectory(prefix="rubble-image-") as directory:
        source = Path(directory) / "image.png"
        Image.fromarray(pixels).save(source)
        cache_farm.install_file(Path(root), name, source)


def save_json(root: Path, name: str, data: dict) -> None:
    with tempfile.TemporaryDirectory(prefix="rubble-json-") as directory:
        source = Path(directory) / "data.json"
        source.write_text(json.dumps(data, indent=2, allow_nan=False) + "\n", encoding="utf-8")
        cache_farm.install_file(Path(root), name, source)


def component(value: str) -> str:
    if not value or value in (".", "..") or "/" in value or "\\" in value:
        raise ValueError(f"invalid path component: {value!r}")
    return value


def frame_name(key: str) -> str:
    return component(key.replace(":", "_")) + ".png"


def rect_box(rect: list, shape: tuple[int, ...]) -> tuple[int, int, int, int]:
    if len(rect) != 4 or any(type(value) is not int for value in rect):
        raise ValueError(f"invalid rectangle: {rect!r}")
    x, y, w, h = rect
    if min(x, y) < 0 or min(w, h) <= 0 or x + w > shape[1] or y + h > shape[0]:
        raise ValueError(f"rectangle outside page: {rect!r}")
    return x, y, w, h


def crop(pixels: np.ndarray, rect: list, scale: int = 1) -> np.ndarray:
    x, y, w, h = rect
    return pixels[scale * y:scale * (y + h), scale * x:scale * (x + w)]


def export_pages(cache_root: Path, theatre: str, types_path: Path, out: Path) -> dict:
    directory = Path(cache_root) / "_library" / component(theatre)
    library = read_json(directory / "library.json")
    ids = read_json(types_path)
    if not isinstance(ids, list) or any(not isinstance(type_id, str) for type_id in ids):
        raise ValueError("types must be a JSON array of rules type ids")
    palette = read_image(directory / library["palettes"]["iso"], "RGB")
    if palette.shape != (1, 256, 3):
        raise ValueError("ISO palette must be a 256x1 RGB PNG")
    pages, frames = {}, {}
    for type_id in dict.fromkeys(ids):
        entry = library["types"].get(type_id)
        if not entry or entry.get("kind") != "building":
            continue
        key = entry.get("sprite")
        sprite = library["sprites"].get(key)
        if not sprite or len(sprite.get("frames", [])) < 4:
            continue
        if key in frames:
            frames[key]["types"].append(type_id)
            continue
        frame = sprite["frames"][3]
        if frame["rect"][2] <= 0 or frame["rect"][3] <= 0:
            continue
        page = frame.get("page", 0)
        if type(page) is not int or not 0 <= page < len(library["spriteAtlases"]):
            raise ValueError(f"invalid source page for {key}: {page!r}")
        if page not in pages:
            pages[page] = read_image(directory / library["spriteAtlases"][page]["file"])
            if pages[page].ndim != 2 or pages[page].dtype != np.uint8:
                raise ValueError("source atlases must contain 8-bit palette indices")
        rect_box(frame["rect"], pages[page].shape)
        indices = crop(pages[page], frame["rect"]).copy()
        if not np.any(indices):
            continue
        if indices.shape[1] > PAGE_WIDTH - 2:
            raise ValueError(f"frame {key} is too wide for a {PAGE_WIDTH}px page with gutters")
        frames[key] = {"indices": indices, "offset": frame["offset"], "types": [type_id],
                       "source": {"page": page, "rect": frame["rect"]}}

    x, y, row_height = 1, 1, 0
    sprites = {}
    for key, frame in frames.items():
        h, w = frame["indices"].shape
        if x + w + 1 > PAGE_WIDTH:
            x, y, row_height = 1, y + row_height + 1, 0
        sprites[key] = {"rect": [x, y, w, h], "offset": list(frame["offset"]),
                        "types": frame["types"], "source": frame["source"]}
        x, row_height = x + w + 1, max(row_height, h)
    height = max(4, ((y + row_height + 1 + 3) // 4) * 4)
    indexed = np.zeros((height, PAGE_WIDTH), np.uint8)
    for key, frame in frames.items():
        crop(indexed, sprites[key]["rect"])[:] = frame["indices"]
    rgba = np.zeros((*indexed.shape, 4), np.uint8)
    rgba[..., :3] = palette[0][indexed]
    rgba[..., 3] = (indexed != 0).astype(np.uint8) * 255
    rgba[indexed == 0, :3] = 0
    grey = np.where((indexed != 0)[..., None], rgba[..., :3], 118).astype(np.uint8)
    manifest = {"theatre": theatre, "page": {"width": PAGE_WIDTH, "height": height}, "sprites": sprites}
    save_image(out, PAGE, indexed)
    save_image(out, "rubble_rgba_1x.png", rgba)
    save_image(out, "rubble_grey_1x.png", grey)
    save_json(out, "rubble.json", manifest)
    return manifest


def load_export(directory: Path) -> tuple[dict, np.ndarray]:
    manifest = read_json(Path(directory) / "rubble.json")
    indexed = read_image(Path(directory) / PAGE)
    if indexed.ndim != 2 or indexed.dtype != np.uint8:
        raise ValueError("export page must contain 8-bit palette indices")
    if manifest["page"] != {"width": indexed.shape[1], "height": indexed.shape[0]}:
        raise ValueError("export page dimensions do not match rubble.json")
    for key, frame in manifest["sprites"].items():
        frame_name(key)
        rect_box(frame["rect"], indexed.shape)
        if not np.any(crop(indexed, frame["rect"])):
            raise ValueError(f"exported frame {key} is empty")
    names = [frame_name(key) for key in manifest["sprites"]]
    if len(names) != len(set(names)):
        raise ValueError("sprite keys collide after replacing ':' with '_'")
    return manifest, indexed


def group_exports(exports: dict[str, Path]) -> dict:
    """Group identical indexed frames, dimensions and offsets across explicit exports.

    Each directory may contain rubble.json directly or in an export/ child. Group
    ids hash the index bytes, dimensions and offsets with SHA-1; palette colours,
    atlas position and rules type aliases do not affect identity.
    """
    groups = {}
    for theatre, directory in exports.items():
        component(theatre)
        directory = Path(directory)
        if not (directory / "rubble.json").is_file():
            directory /= "export"
        manifest, indexed = load_export(directory)
        for key, frame in manifest["sprites"].items():
            _, _, w, h = frame["rect"]
            offset = frame["offset"]
            if len(offset) != 2 or any(type(value) is not int for value in offset):
                raise ValueError(f"invalid offset for {key}: {offset!r}")
            indices = crop(indexed, frame["rect"])
            signature = indices.tobytes() + str((w, h, offset)).encode()
            group_id = hashlib.sha1(signature).hexdigest()[:16]
            group = groups.setdefault(group_id, {"members": [], "area": int((indices > 0).sum()),
                                                 "size": [w, h]})
            group["members"].append([theatre, key])
    return {"groups": groups}


def distribute_redraw(groups_path: Path, redraw: Path, key: str, theatre: str, out_root: Path) -> list[Path]:
    """Copy a redraw byte-for-byte to every member of the selected theatre/key group."""
    groups = read_json(groups_path)["groups"]
    matches = [group for group in groups.values() if [theatre, key] in group["members"]]
    if len(matches) != 1:
        raise ValueError(f"expected one group for {theatre}/{key}, found {len(matches)}")
    destinations = []
    for member_theatre, member_key in matches[0]["members"]:
        if not member_key.startswith("building:") or not member_key.split(":", 1)[1]:
            raise ValueError(f"expected building:NAME rubble key: {member_key!r}")
        relative = f"{component(member_theatre)}/{frame_name(member_key)}"
        if relative in destinations:
            raise ValueError(f"duplicate rubble group member: {relative}")
        destinations.append(relative)
    # Stage a separate copy for each destination: edits to one redraw must not alter
    # either the supplied source or another theatre through a shared hard link.
    with tempfile.TemporaryDirectory(prefix="rubble-distribute-") as directory:
        for index, relative in enumerate(destinations):
            source = Path(directory) / f"{index}.png"
            shutil.copyfile(redraw, source)
            cache_farm.install_file(Path(out_root), relative, source)
    return [Path(out_root) / relative for relative in destinations]


def load_upscaled(path: Path, indexed: np.ndarray) -> np.ndarray:
    with Image.open(path) as image:
        expected = (indexed.shape[1] * 4, indexed.shape[0] * 4)
        if image.size != expected:
            raise ValueError(f"upscaled image must be exactly 4x ({expected[0]}x{expected[1]}), got {image.size}")
        return np.asarray(image.convert("RGB"), np.float32)


def to_u8(values: np.ndarray) -> np.ndarray:
    return np.clip(np.rint(values), 0, 255).astype(np.uint8)


def linear(rgb: np.ndarray) -> np.ndarray:
    c = np.asarray(rgb, np.float32) / 255
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def srgb(values: np.ndarray) -> np.ndarray:
    c = np.clip(values, 0, 1)
    return 255 * np.where(c <= 0.0031308, c * 12.92, 1.055 * c ** (1 / 2.4) - 0.055)


def downsample(rgb4: np.ndarray) -> np.ndarray:
    h, w = rgb4.shape[:2]
    return srgb(linear(rgb4).reshape(h // 2, 2, w // 2, 2, 3).mean(axis=(1, 3)))


def dilated(mask: np.ndarray) -> np.ndarray:
    return cv2.dilate(mask.astype(np.uint8), np.ones((3, 3), np.uint8),
                      borderType=cv2.BORDER_CONSTANT, borderValue=0).astype(bool)


def alpha_2x(mask: np.ndarray) -> np.ndarray:
    nearest = mask.repeat(2, 0).repeat(2, 1).astype(np.float32)
    # A three-tap tent modifies just one 2x texel on either side of an edge.
    kernel = np.array([0.25, 0.5, 0.25], np.float32)
    alpha = cv2.sepFilter2D(nearest, -1, kernel, kernel, borderType=cv2.BORDER_CONSTANT)
    alpha *= dilated(mask).repeat(2, 0).repeat(2, 1)
    return alpha


def bleed(rgb: np.ndarray, known: np.ndarray) -> np.ndarray:
    """Fill unknown texels from the nearest known colour, including enclosed holes."""
    if not np.any(known):
        raise ValueError("cannot bleed an empty silhouette")
    _, labels = cv2.distanceTransformWithLabels((~known).astype(np.uint8), cv2.DIST_L2, 5,
                                               labelType=cv2.DIST_LABEL_PIXEL)
    return rgb[known][labels - 1]


def unmatte(rgb: np.ndarray, original: np.ndarray, mask: np.ndarray, alpha: np.ndarray) -> np.ndarray:
    """Replace matted edge colours with interior colour and bleed into the soft fringe.

    Keep exact palette samples, including narrow details with no opaque 2x core. For
    other edge samples use interior colours: the model's matte coverage is unknown,
    so dividing by our independently constructed alpha could leave a grey halo.
    """
    known = mask.repeat(2, 0).repeat(2, 1)
    reference = original.repeat(2, 0).repeat(2, 1).astype(np.float32)
    interior = known & (alpha == 1)
    extended_interior = bleed(rgb, interior) if np.any(interior) else reference
    exact_palette = np.max(np.abs(rgb - reference), axis=-1) < 0.01
    edge = known & (alpha < 1) & ~exact_palette
    clean = np.where(edge[..., None], extended_interior, rgb)
    # A zero-alpha source pixel may contain model background detail. It never seeds the bleed.
    extended = bleed(clean, known)
    return np.where(known[..., None], clean, extended)


def blurred_luminance(rgb: np.ndarray) -> np.ndarray:
    lum = hybrid_redraw.luminance(rgb)
    return cv2.GaussianBlur(lum, (0, 0), 2, borderType=cv2.BORDER_REFLECT)


def colour_lock(base: np.ndarray, redraw: np.ndarray, sigma: float) -> np.ndarray:
    base_lab = cv2.cvtColor(np.clip(base / 255, 0, 1), cv2.COLOR_RGB2LAB)
    redraw_lab = cv2.cvtColor(np.clip(redraw / 255, 0, 1), cv2.COLOR_RGB2LAB)
    result = redraw_lab.copy()
    for channel, radius in enumerate((sigma, sigma * 2, sigma * 2)):
        low_base = cv2.GaussianBlur(base_lab[..., channel], (0, 0), radius)
        low_redraw = cv2.GaussianBlur(redraw_lab[..., channel], (0, 0), radius)
        result[..., channel] += low_base - low_redraw
    return np.clip(cv2.cvtColor(result, cv2.COLOR_LAB2RGB) * 255, 0, 255)


def registered_redraw(reference: np.ndarray, raw: np.ndarray, weight: np.ndarray) -> tuple[np.ndarray, dict]:
    h, w = reference.shape[:2]
    resized = srgb(cv2.resize(linear(raw), (w, h), interpolation=cv2.INTER_AREA))
    levels = max(1, min(3, int(math.log2(min(h, w))) - 1))
    params, diagnostics = hybrid_redraw.register(reference, resized, weight, levels=levels)
    sx, tx, sy, ty = params
    registration = {"params": list(params), "model_size": [raw.shape[1], raw.shape[0]],
                    "canvas": [w, h], "diagnostics": diagnostics}
    if not all(math.isfinite(value) for value in params) or sx <= 0 or sy <= 0:
        raise ValueError("registration returned invalid scale/translation")
    # Map pixel centres directly to the full model resolution, retaining its detail.
    xs = ((sx * np.arange(w, dtype=np.float32) + tx + 0.5) * raw.shape[1] / w - 0.5)
    ys = ((sy * np.arange(h, dtype=np.float32) + ty + 0.5) * raw.shape[0] / h - 0.5)
    mx, my = np.meshgrid(xs, ys)
    fitted = srgb(cv2.remap(linear(raw), mx, my, cv2.INTER_LINEAR,
                           borderMode=cv2.BORDER_CONSTANT, borderValue=tuple(float(v) for v in linear(GREY))))
    score = hybrid_redraw.pearson(blurred_luminance(reference)[weight], blurred_luminance(fitted)[weight])
    registration["fit_score"] = float(score) if math.isfinite(score) else 0.0
    return fitted, registration


class RegistrationReferences:
    """Resolve redraw source references only after proving identical indexed geometry."""

    def __init__(self, path: Path | None):
        self.path = Path(path) if path is not None else None
        self.entries = read_json(self.path) if self.path is not None else {}
        if not isinstance(self.entries, dict):
            raise ValueError("redraw references must map destination sprite keys to source references")
        self.exports, self.upscales = {}, {}

    def get(self, key: str, frame: dict, indices: np.ndarray) -> tuple[np.ndarray, dict] | None:
        if key not in self.entries:
            return None
        source = self.entries[key]
        if (not isinstance(source, dict) or any(not isinstance(source.get(field), str) or not source[field]
                                               for field in ("export", "upscaled", "key"))):
            raise ValueError(f"invalid redraw reference for {key}: expected export, upscaled and key strings")
        export = (self.path.parent / source["export"]).resolve()
        upscaled = (self.path.parent / source["upscaled"]).resolve()
        if export not in self.exports:
            self.exports[export] = load_export(export)
        manifest, page = self.exports[export]
        source_frame = manifest["sprites"].get(source["key"])
        if source_frame is None:
            raise ValueError(f"redraw reference has no sprite {source['key']}")
        reference_indices = crop(page, source_frame["rect"])
        if (source_frame["offset"] != frame["offset"] or not np.array_equal(reference_indices, indices)):
            raise ValueError(f"redraw reference geometry differs for {key}: indices, size or offset mismatch")
        if upscaled not in self.upscales:
            # Keep shared source pages as uint8; convert only the selected frame.
            self.upscales[upscaled] = read_image(upscaled, "RGB")
        image = self.upscales[upscaled]
        if image.shape[:2] != (page.shape[0] * 4, page.shape[1] * 4):
            raise ValueError("redraw reference upscaled image must be exactly 4x its indexed export")
        reference = crop(image, source_frame["rect"], 4).astype(np.float32)
        provenance = {"mode": "identical_indices_source", "theatre": manifest.get("theatre"),
                      "key": source["key"], "indices_sha256": hashlib.sha256(indices.tobytes()).hexdigest(),
                      "reference_sha256": hashlib.sha256(reference.astype(np.uint8).tobytes()).hexdigest()}
        return reference, provenance


def build_pages(export: Path, upscaled: Path, out: Path, redraw_dir: Path | None = None,
                lock_sigma: float = 6, *, redraw_references: Path | None = None) -> dict:
    if not math.isfinite(lock_sigma) or lock_sigma <= 0:
        raise ValueError("lock sigma must be positive and finite")
    manifest, indexed = load_export(export)
    upscale = load_upscaled(upscaled, indexed)
    original = read_image(Path(export) / "rubble_rgba_1x.png", "RGBA")
    if original.shape[:2] != indexed.shape:
        raise ValueError("palette-reference page does not match indexed export")
    references = RegistrationReferences(redraw_references)
    rgba = np.zeros((indexed.shape[0] * 2, indexed.shape[1] * 2, 4), np.uint8)
    result = copy.deepcopy(manifest)
    for key, frame in result["sprites"].items():
        rect = frame["rect"]
        mask = crop(indexed, rect) != 0
        alpha = alpha_2x(mask)
        art = crop(original, rect)[..., :3]
        base4 = crop(upscale, rect, 4)
        base2 = unmatte(downsample(base4), art, mask, alpha)
        final = base2
        frame.update({"registration": None, "fit_score": None, "fallback": False,
                      "flags": [], "method": "esrgan"})
        redraw_path = Path(redraw_dir) / frame_name(key) if redraw_dir is not None else None
        if redraw_path is not None and redraw_path.is_file():
            try:
                raw = read_image(redraw_path, "RGB").astype(np.float32)
                source = references.get(key, frame, crop(indexed, rect))
                # Equal indices may have different theatre palettes, even opposite
                # luminance. Register against the reference that generated the raw
                # art; the same geometry/fit gates apply, then colour-lock to target.
                reference = source[0] if source is not None else base4
                weight = dilated(mask).repeat(4, 0).repeat(4, 1)
                fitted, registration = registered_redraw(reference, raw, weight)
                if source is not None:
                    registration["reference"] = source[1]
                    target_fit = hybrid_redraw.pearson(blurred_luminance(base4)[weight],
                                                       blurred_luminance(fitted)[weight])
                    registration["target_fit_before_colour_lock"] = float(target_fit) if math.isfinite(target_fit) else 0.0
                frame["registration"] = registration
                frame["fit_score"] = registration["fit_score"]
                sx, _, sy, _ = registration["params"]
                if not (0.8 <= sx <= 1.25 and 0.8 <= sy <= 1.25):
                    frame["flags"].append("scale_out_of_range")
                if frame["fit_score"] < 0.5:
                    frame["flags"].append("fit_score_below_0.5")
                if not frame["flags"]:
                    # Bleeding before the Lab blur keeps the background out of its low frequencies.
                    raw2 = unmatte(downsample(fitted), art, mask, alpha)
                    final = colour_lock(base2, raw2, lock_sigma)
                    final = bleed(final, mask.repeat(2, 0).repeat(2, 1))
                    frame["method"] = "redraw"
            except (ValueError, np.linalg.LinAlgError, cv2.error, OSError) as error:
                frame["flags"].append("registration_failed")
                frame["error"] = str(error)
            frame["fallback"] = bool(frame["flags"])
        cell = crop(rgba, rect, 2)
        cell[..., :3] = to_u8(final)
        cell[..., 3] = to_u8(alpha * 255)
        cell[cell[..., 3] == 0, :3] = 0
    cache_farm.install_file(Path(out), PAGE, Path(export) / PAGE)
    save_image(out, HD_PAGE, rgba)
    save_image(out, REMAP, np.zeros(rgba.shape[:2], np.uint8))
    save_json(out, "frames.json", result)
    return result


def patch_library(library: dict, frames: dict) -> int:
    """Mutate only the rubble atlas entries and body frame 3; HD indices stay aligned."""
    width, height = frames["page"]["width"], frames["page"]["height"]
    atlases = library["spriteAtlases"]
    found = [index for index, entry in enumerate(atlases) if entry["file"] == PAGE]
    if len(found) > 1:
        raise ValueError("library contains duplicate rubble atlas entries")
    page = found[0] if found else len(atlases)
    hd = library.get("spriteAtlasesHd") or []
    hd_found = [index for index, entry in enumerate(hd) if entry and entry["file"] == HD_PAGE]
    if hd_found and hd_found != [page]:
        raise ValueError("rubble HD page index does not match its indexed page")
    if page < len(hd) and hd[page] is not None and hd[page]["file"] != HD_PAGE:
        raise ValueError("rubble page index is occupied by another HD atlas")
    for key, frame in frames["sprites"].items():
        sprite = library["sprites"].get(key)
        if not sprite or len(sprite.get("frames", [])) < 4:
            raise ValueError(f"target library has no body frame 3 for {key}")
        rect_box(frame["rect"], (height, width))
    entry = {"file": PAGE, "width": width, "height": height}
    if found:
        atlases[page].update(entry)
    else:
        atlases.append(entry)
    while len(hd) < len(atlases):
        hd.append(None)
    hd_entry = {"file": HD_PAGE, "remap": REMAP, "scale": 2, "width": width * 2, "height": height * 2}
    if hd[page] is None:
        hd[page] = hd_entry
    else:
        hd[page].update(hd_entry)
    library["spriteAtlasesHd"] = hd
    for key, frame in frames["sprites"].items():
        library["sprites"][key]["frames"][3] = {
            "rect": list(frame["rect"]), "offset": list(frame["offset"]), "page": page}
    return page


def install_pages(build: Path, cache_root: Path, theatre: str) -> int:
    frames = read_json(Path(build) / "frames.json")
    if frames["theatre"] != theatre:
        raise ValueError("build theatre does not match install theatre")
    width, height = frames["page"]["width"], frames["page"]["height"]
    for name, mode, size in ((PAGE, "L", (width, height)),
                             (HD_PAGE, "RGBA", (width * 2, height * 2)),
                             (REMAP, "L", (width * 2, height * 2))):
        with Image.open(Path(build) / name) as image:
            if image.mode != mode or image.size != size:
                raise ValueError(f"invalid built page: {name}")
    rel = f"_library/{component(theatre)}"
    path = Path(cache_root) / rel / "library.json"
    # Reject incompatible libraries before publishing files; the locked patch checks again.
    patch_library(read_json(path), frames)
    for name in (PAGE, HD_PAGE, REMAP):
        cache_farm.install_file(Path(cache_root), f"{rel}/{name}", Path(build) / name)
    installed = []

    def update(library):
        installed.append(patch_library(library, frames))

    cache_farm.patch_json(Path(cache_root), f"{rel}/library.json", update)
    return installed[0]


def make_sheet(export: Path, upscaled: Path, keys: list[str], cols: int,
               cell: tuple[int, int], out: Path) -> dict:
    if cols <= 0 or min(cell) < 4 or not keys or len(keys) != len(set(keys)):
        raise ValueError("sheet needs unique keys, positive columns and cells at least 4x4")
    manifest, indexed = load_export(export)
    missing = [key for key in keys if key not in manifest["sprites"]]
    if missing:
        raise ValueError(f"unknown sheet keys: {missing}")
    upscale = load_upscaled(upscaled, indexed)
    cw, ch = cell
    width, height = cols * cw, math.ceil(len(keys) / cols) * ch
    pixels = np.full((height, width, 3), 118, np.uint8)
    layout = {"size": [width, height], "cols": cols, "cell": [cw, ch], "sprites": []}
    for index, key in enumerate(keys):
        rect = manifest["sprites"][key]["rect"]
        mask = (crop(indexed, rect) != 0).repeat(4, 0).repeat(4, 1)
        rgb = np.where(mask[..., None], crop(upscale, rect, 4), GREY)
        factor = min(cw * 0.84 / rgb.shape[1], ch * 0.84 / rgb.shape[0])
        w, h = max(1, round(rgb.shape[1] * factor)), max(1, round(rgb.shape[0] * factor))
        x, y = (index % cols) * cw, (index // cols) * ch
        px, py = x + (cw - w) // 2, y + (ch - h) // 2
        resized = srgb(cv2.resize(linear(rgb), (w, h), interpolation=cv2.INTER_AREA))
        pixels[py:py + h, px:px + w] = to_u8(resized)
        layout["sprites"].append({"key": key, "cell": [x, y, cw, ch], "placed": [px, py, w, h]})
    save_image(out, "input.png", pixels)
    save_json(out, "layout.json", layout)
    return layout


def slice_sheet(sheet: Path, layout_path: Path, out: Path) -> list[Path]:
    layout = read_json(layout_path)
    pixels = read_image(sheet)
    width, height = layout["size"]
    if min(width, height) <= 0:
        raise ValueError("layout dimensions must be positive")
    rx, ry = pixels.shape[1] / width, pixels.shape[0] / height
    results, names = [], set()
    for frame in layout["sprites"]:
        name = frame_name(frame["key"])
        if name in names:
            raise ValueError("duplicate slice filename")
        names.add(name)
        x, y, w, h = rect_box(frame["placed"], (height, width))
        cx, cy, cw, ch = rect_box(frame["cell"], (height, width))
        left, top = math.floor(max(cx, x - w * 0.04) * rx), math.floor(max(cy, y - h * 0.04) * ry)
        right = math.ceil(min(cx + cw, x + w * 1.04) * rx)
        bottom = math.ceil(min(cy + ch, y + h * 1.04) * ry)
        save_image(out, name, pixels[top:bottom, left:right])
        results.append(Path(out) / name)
    return results


def cell_size(value: str) -> tuple[int, int]:
    try:
        width, height = (int(part) for part in value.lower().split("x"))
        if min(width, height) < 4:
            raise ValueError
        return width, height
    except ValueError as error:
        raise argparse.ArgumentTypeError("cell must be WxH with both dimensions at least 4") from error


def theatre_export(value: str) -> tuple[str, Path]:
    theatre, separator, directory = value.partition("=")
    try:
        component(theatre)
        if not separator or not directory:
            raise ValueError
    except ValueError as error:
        raise argparse.ArgumentTypeError("export must be THEATRE=DIR") from error
    return theatre, Path(directory)


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    export = commands.add_parser("export")
    export.add_argument("--cache-root", type=Path, required=True)
    export.add_argument("--theatre", required=True)
    export.add_argument("--types", type=Path, required=True)
    export.add_argument("--out", type=Path, required=True)
    build = commands.add_parser("build")
    build.add_argument("--export", type=Path, required=True)
    build.add_argument("--upscaled", type=Path, required=True)
    build.add_argument("--out", type=Path, required=True)
    build.add_argument("--redraw-dir", type=Path)
    build.add_argument("--redraw-references", type=Path,
                       help="JSON destination key -> {export, upscaled, key} source registration references")
    build.add_argument("--lock-sigma", type=float, default=6)
    install = commands.add_parser("install")
    install.add_argument("--build", type=Path, required=True)
    install.add_argument("--cache-root", type=Path, required=True)
    install.add_argument("--theatre", required=True)
    sheet = commands.add_parser("sheet")
    sheet.add_argument("--export", type=Path, required=True)
    sheet.add_argument("--upscaled", type=Path, required=True)
    sheet.add_argument("--keys", nargs="+", required=True)
    sheet.add_argument("--cols", type=int, required=True)
    sheet.add_argument("--cell", type=cell_size, required=True)
    sheet.add_argument("--out", type=Path, required=True)
    slicing = commands.add_parser("slice")
    slicing.add_argument("--sheet", type=Path, required=True)
    slicing.add_argument("--layout", type=Path, required=True)
    slicing.add_argument("--out", type=Path, required=True)
    groups = commands.add_parser("groups")
    groups.add_argument("--export", type=theatre_export, nargs="+", action="append", required=True)
    groups.add_argument("--out", type=Path, required=True)
    distribute = commands.add_parser("distribute")
    distribute.add_argument("--groups", type=Path, required=True)
    distribute.add_argument("--redraw", type=Path, required=True)
    distribute.add_argument("--key", required=True)
    distribute.add_argument("--theatre", required=True)
    distribute.add_argument("--out-root", type=Path, required=True)
    args = parser.parse_args(argv)
    try:
        if args.command == "export":
            result = export_pages(args.cache_root, args.theatre, args.types, args.out)
            print(f"Exported {len(result['sprites'])} rubble sprites for {args.theatre} to {args.out}")
        elif args.command == "build":
            result = build_pages(args.export, args.upscaled, args.out, args.redraw_dir, args.lock_sigma,
                                 redraw_references=args.redraw_references)
            fallbacks = sum(frame["fallback"] for frame in result["sprites"].values())
            print(f"Built {len(result['sprites'])} rubble sprites ({fallbacks} redraw fallbacks) in {args.out}")
        elif args.command == "install":
            page = install_pages(args.build, args.cache_root, args.theatre)
            print(f"Installed rubble page {page} for {args.theatre} in {args.cache_root}")
        elif args.command == "sheet":
            result = make_sheet(args.export, args.upscaled, args.keys, args.cols, args.cell, args.out)
            print(f"Packed {len(result['sprites'])} rubble cells in {args.out}")
        elif args.command == "slice":
            results = slice_sheet(args.sheet, args.layout, args.out)
            print(f"Sliced {len(results)} redraws into {args.out}")
        elif args.command == "groups":
            exports = [entry for entries in args.export for entry in entries]
            if len(dict(exports)) != len(exports):
                raise ValueError("each export theatre must be specified only once")
            result = group_exports(dict(exports))
            save_json(args.out.parent, args.out.name, result)
            print(f"Grouped rubble into {len(result['groups'])} groups in {args.out}")
        else:
            results = distribute_redraw(args.groups, args.redraw, args.key, args.theatre, args.out_root)
            print(f"Distributed redraw to {len(results)} rubble members in {args.out_root}")
    except (ValueError, OSError, KeyError, cv2.error) as error:
        parser.error(str(error))


if __name__ == "__main__":
    main()
