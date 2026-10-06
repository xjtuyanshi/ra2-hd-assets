#!/usr/bin/env python3
"""Open-water mask that follows the waterline the map paints, for any prepared map directory.

Why: the extractor's mask (src/waterMask.ts) marks whole cells of open-water tiles and, by colour, the water of the
shore families. Water painted inside any other tile (the feet of water cliffs, plain cliffs standing in the sea,
rocks, piers) is not in it, so under a cliff the mask ends in a staircase of cell diamonds one to thirty original
pixels short of the rock, and the renderer draws its own shoreline along that staircase.

How: the original 1x composite (terrain-map.png) is paletted art, so the open water is a small set of exact colours.
Those colours are taken from the interior of the existing mask (every colour holding at least COLOUR_SHARE of it);
pixels of those colours that are 4-connected to the existing water and within REACH original pixels of it are painted
water too. Some theatres reuse a few water colours on land (urban asphalt shares a fifth of the water's pixels'
colours): a colour that is also common on land far from any water only counts where the colours water does NOT
share with land are dense around it (DISTINCT, TEXTURE), so a road that ends at a quay is not flooded.
Single-pixel dither is settled with a 3 x 3 majority, enclosed specks of at most SPECK pixels are filled, and the
result is unioned with the existing mask, blurred by EDGE_SIGMA original pixels and resampled to the resolution of
the map's HD terrain. Only real gaps are filled (water farther than GAP from the existing mask, and the added water
within GAP_REACH of it): a beach whose mask is within GAP of the painted water keeps it exactly, and where the
extractor's colour test left holes or stopped short of the painted water the beach follows it too. Mask bytes
farther than TOUCH original pixels from added water are the existing mask's.

The new mask is published next to the old one as `<old stem>-wl.png` and selected through materials.json
(`waterMask`, plus `waterline: "painted"`, which tells the renderer that the mask needs no cliff-foot extension).
Nothing is written through a symlink: files are installed with cache_farm into a copy-on-write farm.

Lake-bed maps (materials.json `waterBed: true`) are left alone: lake_shore.py already built their mask along the
painted bed. Maps without water, without the 1x composite, or whose mask already reaches every painted water pixel
are reported and skipped.

    waterline_mask.py derive  --base <farm> --farm <new farm>          # one link per entry of the base farm
    waterline_mask.py install --farm <farm> --all [--jobs N]           # every map directory of the farm
    waterline_mask.py install --farm <farm> --maps IsleLand XMP26S6
    waterline_mask.py build <map directory> --out mask.png             # no farm: write the mask for review

Needs NumPy, OpenCV and Pillow. Asset-free tests: test_waterline_mask.py.
"""

from __future__ import annotations

import argparse
import base64
from concurrent.futures import ProcessPoolExecutor
import json
import os
from pathlib import Path
import re
import sys
import tempfile
import time

import cv2
import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))
import cache_farm  # noqa: E402

Image.MAX_IMAGE_PIXELS = None

#: A palette colour is an open-water colour when it holds at least this share of the existing mask's interior.
COLOUR_SHARE = 0.002
#: A water colour is the water's own when its share of the land farther than FAR from any water is at most this
#: fraction of its share of the water's interior; other water colours are shared with land art.
DISTINCT = 0.02
#: A pixel in a shared colour is water only where at least this share of the TEXTURE_WINDOW x TEXTURE_WINDOW pixels
#: around it have colours of the water's own (inside the water's dither, not on asphalt or rock of the same colour).
#: Asphalt has none of them; the water under a quay wall, where the art dithers towards the shared dark tones, still
#: has this many (at 0.3 over 5 x 5 px a rim of 2 to 6 px of painted water stayed out along urban quay walls).
TEXTURE = 0.15
TEXTURE_WINDOW = 9
#: The interior is the fully marked mask eroded by this many original pixels (keeps soft and bled edges out).
CORE_ERODE = 4
#: Fewer interior pixels than this is not a body of water to learn colours from.
MIN_CORE = 400
#: Painted water is followed at most this far (original pixels) from the existing mask: about six cells. On the stock
#: maps the farthest painted water is 96 px from the mask (a quay pocket of Manhatta); a limit below that left the
#: pocket's end out, with an arc for a waterline.
REACH = 192
#: Land farther than this (original pixels) from the existing mask is certainly not water: its colours tell the
#: water's own colours from those shared with land (DISTINCT).
FAR = 96
#: Enclosed non-water specks of at most this many original pixels inside added water become water (sparkle pixels).
SPECK = 6
#: Added water must lie farther than this (original pixels) from the existing mask somewhere nearby: the rim of one or
#: two pixels that the colour test finds along every beach is not a missing piece of water, and beaches keep their mask.
GAP = 2.5
#: ...and "nearby" is this many original pixels along the shore from such a place.
GAP_REACH = 8
#: Gaussian sigma (original pixels) of the new mask's edge; the renderer thresholds the mask at 0.3 .. 0.55.
EDGE_SIGMA = 0.9
#: Mask bytes may change only within this many original pixels of added water.
TOUCH = 4
#: Suffix of the published mask and the value of materials.json `waterline`.
SUFFIX = "-wl"
WATERLINE = "painted"
RECEIPT = ".waterline.json"


def water_colours(rgb: np.ndarray, mask: np.ndarray, opaque: np.ndarray | None = None) -> tuple[np.ndarray, np.ndarray]:
    """Packed 0xRRGGBB colours of open water: (the water's own, those shared with land far from water).

    Both hold COLOUR_SHARE of the mask's interior; either may be empty. Without `opaque` (or without any land beyond
    FAR) every colour is the water's own.
    """
    none = np.zeros(0, np.int32)
    core = cv2.erode((mask == 255).astype(np.uint8), np.ones((2 * CORE_ERODE + 1,) * 2, np.uint8)) > 0
    total = int(core.sum())
    if total < MIN_CORE:
        return none, none
    keys = pack(rgb)
    values, counts = np.unique(keys[core], return_counts=True)
    keep = counts >= COLOUR_SHARE * total
    values, shares = values[keep], counts[keep] / total
    if opaque is None:
        return values, none
    far = opaque & (cv2.distanceTransform((mask < 128).astype(np.uint8), cv2.DIST_L2, 5) > FAR)
    land = int(far.sum())
    if not land:
        return values, none
    far_values, far_counts = np.unique(keys[far], return_counts=True)
    on_land = dict(zip(far_values.tolist(), (far_counts / land).tolist()))
    own = np.array([on_land.get(int(v), 0.0) <= DISTINCT * share for v, share in zip(values, shares)], bool)
    return values[own], values[~own]


def pack(rgb: np.ndarray) -> np.ndarray:
    return (rgb[..., 0].astype(np.int32) << 16) | (rgb[..., 1].astype(np.int32) << 8) | rgb[..., 2].astype(np.int32)


def painted_water(rgb: np.ndarray, opaque: np.ndarray, mask: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Water painted outside the mask, at the composite's own (1x) resolution.

    `rgb` is the paletted composite, `opaque` where it has art, `mask` the existing water mask (uint8, 255 = water).
    Returns (added, colours): the boolean pixels to add and the packed water colours used.
    """
    # (Pixels are compared as exact palette colours: the composite is paletted art, not a photograph.)
    if rgb.shape[:2] != mask.shape or opaque.shape != mask.shape:
        raise ValueError("composite, alpha and water mask must have the same size")
    seeds = mask >= 128
    own, shared = water_colours(rgb, mask, opaque)
    colours = np.concatenate([own, shared])
    if not len(own):
        return np.zeros(mask.shape, bool), colours
    distance = cv2.distanceTransform((~seeds).astype(np.uint8), cv2.DIST_L2, 5)
    near = distance <= REACH
    keys = pack(rgb)
    is_own = np.isin(keys, own) & opaque
    candidate = is_own
    if len(shared):
        # Shared colours count inside the water's own texture only (the existing water vouches for its pixels).
        window = (TEXTURE_WINDOW, TEXTURE_WINDOW)
        texture = cv2.blur((is_own | seeds).astype(np.float32), window, borderType=cv2.BORDER_REPLICATE) >= TEXTURE
        candidate = is_own | (np.isin(keys, shared) & opaque & texture)
    candidate = candidate & near & ~seeds
    # Settle single-pixel dither first: a pixel joins (or leaves) when most of its 3 x 3 neighbourhood is water.
    water = (candidate | seeds).astype(np.uint8)
    votes = cv2.boxFilter(water, cv2.CV_16S, (3, 3), normalize=False, borderType=cv2.BORDER_REPLICATE)
    settled = ((votes >= 5) & (candidate | (opaque & near))) & ~seeds
    labels = cv2.connectedComponents((settled | seeds).astype(np.uint8), connectivity=4)[1]
    keep = np.unique(labels[seeds])
    grown = np.isin(labels, keep[keep > 0])
    added = grown & ~seeds
    # Only real gaps: water farther than GAP from the mask, and the added water within GAP_REACH of it.
    gap = (added & (distance > GAP)).astype(np.uint8)
    size = 2 * GAP_REACH + 1
    added &= cv2.dilate(gap, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (size, size))) > 0
    if added.any():
        # Enclosed specks (sparkle pixels, lone foam dots) that touch added water.
        holes, hole_labels, stats, _ = cv2.connectedComponentsWithStats((~grown).astype(np.uint8), connectivity=4)
        small = np.flatnonzero(stats[:, cv2.CC_STAT_AREA] <= SPECK)
        small = small[small > 0]
        if len(small):
            speck = np.isin(hole_labels, small) & opaque
            touching = cv2.dilate(added.astype(np.uint8), np.ones((3, 3), np.uint8)) > 0
            ids = np.unique(hole_labels[speck & touching])
            added |= np.isin(hole_labels, ids[ids > 0]) & speck
    return added, colours


def compose(base: np.ndarray, base1: np.ndarray, added: np.ndarray, scale: int) -> np.ndarray:
    """The published mask at the HD terrain's resolution: `base` (uint8, scale x) with the added water joined in.

    `base1` is `base` at 1x. The union's edge is soft (EDGE_SIGMA); bytes farther than TOUCH original pixels from added
    water are exactly `base`'s.
    """
    height, width = added.shape
    if base.shape != (height * scale, width * scale) or base1.shape != added.shape:
        raise ValueError("mask sizes do not match the composite and scale")
    if not added.any():
        return base.copy()
    union = ((base1 >= 128) | added).astype(np.float32)
    soft = cv2.GaussianBlur(union, (0, 0), EDGE_SIGMA)
    if scale != 1:
        soft = cv2.resize(soft, (width * scale, height * scale), interpolation=cv2.INTER_CUBIC)
    soft8 = np.clip(np.rint(soft * 255), 0, 255).astype(np.uint8)
    reach = 2 * TOUCH + 1
    touched = cv2.dilate(added.astype(np.uint8), cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (reach, reach)))
    if scale != 1:
        touched = cv2.resize(touched, (width * scale, height * scale), interpolation=cv2.INTER_NEAREST)
    return np.where(touched > 0, np.maximum(base, soft8), base)


def waterline_error(added: np.ndarray, mask1: np.ndarray) -> dict:
    """How far the existing mask's edge is from the painted waterline (original pixels), over the added water's outer edge."""
    grown = (mask1 >= 128) | added
    inner = cv2.erode(grown.astype(np.uint8), np.ones((3, 3), np.uint8)) > 0
    line = added & ~inner
    if not line.any():
        return {"pixels": 0}
    distance = cv2.distanceTransform((mask1 < 128).astype(np.uint8), cv2.DIST_L2, 5)[line]
    return {
        "pixels": int(line.sum()),
        "median": round(float(np.median(distance)), 1),
        "p90": round(float(np.percentile(distance, 90)), 1),
        "max": round(float(distance.max()), 1),
    }


def tile_family(file: str) -> str:
    return re.sub(r"\d+[a-z]?\..*$", "", file.lower())


def families(manifest: dict, added: np.ndarray) -> dict:
    """Added pixels per tile family, by the ground diamond of each cell (cliff faces above a diamond count for the
    cell drawn last there, like the composite)."""
    grid = manifest["grid"]
    width, height = grid["width"], grid["height"]
    ref = manifest["terrainMap"]
    exists = np.frombuffer(base64.b64decode(manifest["cells"]["exists"]), np.uint8)
    levels = np.frombuffer(base64.b64decode(manifest["cells"]["height"]), np.uint8)
    tiles = np.frombuffer(base64.b64decode(manifest["cells"]["tile"]), np.uint16)
    names = sorted({tile_family(t["file"]) for t in manifest["tiles"]})
    ids = {name: i + 1 for i, name in enumerate(names)}
    image = np.zeros(added.shape, np.uint8)
    order = sorted(
        (i for i in range(width * height) if exists[i] and tiles[i] != 0xFFFF),
        key=lambda i: (i % width + i // width, levels[i]),
    )
    for i in order:
        x, y, z = i % width, i // width, int(levels[i])
        sx = (x - y) * 30 - ref["originX"]
        sy = (x + y) * 15 - z * 15 - ref["originY"]
        points = np.array([[sx, sy], [sx + 30, sy + 15], [sx, sy + 30], [sx - 30, sy + 15]], np.int32)
        cv2.fillConvexPoly(image, points, ids[tile_family(manifest["tiles"][tiles[i]]["file"])])
    counts = np.bincount(image[added], minlength=len(names) + 1)
    out = {names[i - 1]: int(n) for i, n in enumerate(counts) if i and n}
    if counts[0]:
        out["(no cell)"] = int(counts[0])
    return dict(sorted(out.items(), key=lambda item: -item[1]))


def load_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def analyse(directory: Path) -> dict:
    """Build the mask of one map directory. Returns {'status': ..., ...}; with status 'built' also 'mask' and 'name'."""
    manifest_path = directory / "manifest.json"
    if not manifest_path.is_file():
        return {"status": "skipped", "reason": "no manifest.json"}
    manifest = load_json(manifest_path)
    ref = manifest.get("terrainMap")
    if not ref:
        return {"status": "skipped", "reason": "no whole-map terrain"}
    materials_path = directory / "materials.json"
    materials = load_json(materials_path) if materials_path.is_file() else {}
    if materials.get("waterBed") is True:
        return {"status": "skipped", "reason": "lake-bed map: its mask already follows the painted bed (lake_shore.py)"}
    receipt_path = directory / RECEIPT
    receipt = load_json(receipt_path) if receipt_path.is_file() else {}
    base_name = receipt.get("base") or materials.get("waterMask") or ref.get("waterMask")
    if not base_name:
        return {"status": "skipped", "reason": "no water mask"}
    composite_path = directory / "terrain-map.png"
    if not composite_path.is_file() or not (directory / base_name).is_file():
        return {"status": "skipped", "reason": "terrain-map.png or the water mask is missing"}
    rgba = np.asarray(Image.open(composite_path).convert("RGBA"))
    base = np.asarray(Image.open(directory / base_name).convert("L"))
    height, width = rgba.shape[:2]
    scale = base.shape[1] // width
    if scale < 1 or base.shape != (height * scale, width * scale):
        return {"status": "skipped", "reason": f"mask {base.shape[1]}x{base.shape[0]} is not a multiple of terrain-map.png"}
    if (base.shape[1], base.shape[0]) != (ref["width"], ref["height"]):
        return {"status": "skipped", "reason": "mask size differs from manifest.terrainMap"}
    base1 = base if scale == 1 else cv2.resize(base, (width, height), interpolation=cv2.INTER_AREA)
    if not (base1 >= 128).any():
        return {"status": "skipped", "reason": "no water"}
    added, colours = painted_water(rgba[..., :3], rgba[..., 3] >= 128, base1)
    if not added.any():
        return {"status": "skipped", "reason": "the mask already reaches every painted water pixel", "colours": len(colours)}
    stem = base_name[:-4] if base_name.lower().endswith(".png") else base_name
    return {
        "status": "built",
        "name": f"{stem}{SUFFIX}.png",
        "base": base_name,
        "scale": scale,
        "mask": compose(base, base1, added, scale),
        "colours": len(colours),
        "water": int((base1 >= 128).sum()),
        "added": int(added.sum()),
        "edge": waterline_error(added, base1),
        "families": families(manifest, added),
        "theatre": manifest.get("theater"),
    }


def map_directories(farm: Path) -> list[str]:
    return sorted(
        entry.name
        for entry in farm.iterdir()
        if not entry.name.startswith((".", "_")) and (entry / "manifest.json").is_file()
    )


def install_map(farm: Path, name: str) -> dict:
    started = time.time()
    result = analyse(farm / name)
    mask = result.pop("mask", None)
    result["map"] = name
    if mask is not None:
        with tempfile.TemporaryDirectory(prefix="waterline-") as tmp:
            png = Path(tmp) / result["name"]
            Image.fromarray(mask, "L").save(png, optimize=False, compress_level=6)
            cache_farm.install_file(farm, f"{name}/{result['name']}", png)
            receipt = {key: result[key] for key in ("name", "base", "scale", "colours", "water", "added", "edge", "families")}
            note = Path(tmp) / RECEIPT
            note.write_text(json.dumps(receipt, separators=(",", ":")), encoding="utf-8")
            cache_farm.install_file(farm, f"{name}/{RECEIPT}", note)

        def patch(data):
            data.setdefault("version", 1)
            data["waterMask"] = result["name"]
            data["waterline"] = WATERLINE

        cache_farm.patch_json(farm, f"{name}/materials.json", patch, default={"version": 1})
        result["status"] = "installed"
    result["seconds"] = round(time.time() - started, 1)
    return result


def _install(args: tuple[str, str]) -> dict:
    try:
        return install_map(Path(args[0]), args[1])
    except Exception as error:  # noqa: BLE001 - one unreadable map must not stop a whole farm
        return {"map": args[1], "status": "failed", "reason": f"{type(error).__name__}: {error}"}


def derive(base: Path, farm: Path) -> int:
    """One link per top-level entry of `base` (existing entries of `farm` are kept)."""
    base = base.absolute()
    if not base.is_dir():
        raise SystemExit(f"{base}: not a directory")
    farm.mkdir(parents=True, exist_ok=True)
    made = 0
    for entry in sorted(base.iterdir()):
        target = farm / entry.name
        if target.is_symlink() or target.exists():
            continue
        target.symlink_to(entry)
        made += 1
    return made


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    sub = parser.add_subparsers(dest="command", required=True)
    one = sub.add_parser("build", help="write one map's mask to a file, without a farm")
    one.add_argument("directory", type=Path)
    one.add_argument("--out", type=Path, required=True)
    link = sub.add_parser("derive", help="create a farm of links to another farm's entries")
    link.add_argument("--base", type=Path, required=True)
    link.add_argument("--farm", type=Path, required=True)
    inst = sub.add_parser("install", help="build and publish masks inside a copy-on-write farm")
    inst.add_argument("--farm", type=Path, required=True)
    inst.add_argument("--maps", nargs="*", default=[])
    inst.add_argument("--all", action="store_true")
    inst.add_argument("--jobs", type=int, default=1)
    inst.add_argument("--log", type=Path, help="append one JSON line per map")
    args = parser.parse_args(argv)

    if args.command == "build":
        result = analyse(args.directory)
        mask = result.pop("mask", None)
        if mask is not None:
            Image.fromarray(mask, "L").save(args.out)
        print(json.dumps(result, ensure_ascii=False))
        return 0 if mask is not None else 1
    if args.command == "derive":
        print(f"{args.farm}: {derive(args.base, args.farm)} links created")
        return 0

    farm = args.farm.absolute()
    names = map_directories(farm) if args.all else args.maps
    if not names:
        parser.error("name maps with --maps or pass --all")
    jobs = [(str(farm), name) for name in names]
    if args.jobs > 1:
        with ProcessPoolExecutor(max_workers=args.jobs) as pool:
            results = pool.map(_install, jobs)
            return _report(results, args.log)
    return _report(map(_install, jobs), args.log)


def _report(results, log: Path | None) -> int:
    failed = 0
    for result in results:
        line = json.dumps(result, ensure_ascii=False)
        print(line, flush=True)
        if log:
            with open(log, "a", encoding="utf-8") as handle:
                handle.write(line + os.linesep)
        failed += result["status"] == "failed"
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
