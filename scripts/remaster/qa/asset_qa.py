#!/usr/bin/env python3
"""Read-only HD sprite triage against extracted indexed source frames.

All writes are confined to --out, which must be outside --cache. Native pixels
and engine offsets define the comparison grid; faction paint is reconstructed
from the neutral grey ramp rather than compared with the source palette hue.
"""
from __future__ import annotations

import argparse
import collections
import csv
import hashlib
import json
import os
import re
import time
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

VERSION = 1
CODE_DIGEST = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
METRICS = ("silhouette_iou", "centroid_shift_px", "bbox_shift_px", "lab_mean_delta",
           "lab_centroid_delta", "remap_hue_drift_deg", "remap_mask_iou",
           "texture_gain", "halo_fraction", "fringe_fraction")
FIELDS = ("scope", "manifest", "page", "active", "asset", "kind", "frame_start",
          "frame_end", "source_frame_start", "source_frame_end", "frames", "status",
          "failures", *METRICS, "source", "hd", "remap", "detail")
THRESHOLDS = {"silhouette_iou_min": .85, "registration_max_px": 1.5,
              "lab_mean_delta_max": 8, "remap_hue_max_deg": 8,
              "remap_mask_iou_min": .85, "texture_gain_min": 1,
              "halo_fraction_max": .01, "fringe_fraction_max": .02}


def stamp(path: Path):
    try:
        s = path.stat()
        return [s.st_size, s.st_mtime_ns]
    except OSError:
        return None


def lexical(path):
    # Cache files are often symlinks to older extracted caches. Renderer references
    # remain relative to the visible cache path, not to the symlink target's parent.
    return Path(os.path.abspath(path))


def digest(data):
    return hashlib.sha256(data).hexdigest()


def read_image(path: Path):
    with Image.open(path) as im:
        im.load()
        return im.copy()


def lab(rgb):
    """sRGB D65 CIELAB; input in 0..1, output in conventional Lab units."""
    linear = np.where(rgb <= .04045, rgb / 12.92, ((rgb + .055) / 1.055) ** 2.4)
    xyz = linear @ np.array([[.4124564, .2126729, .0193339],
                             [.3575761, .7151522, .1191920],
                             [.1804375, .0721750, .9503041]], dtype=np.float32)
    xyz /= np.array([.95047, 1, 1.08883], dtype=np.float32)
    delta = 6 / 29
    f = np.where(xyz > delta ** 3, np.cbrt(xyz), xyz / (3 * delta ** 2) + 4 / 29)
    return np.stack((116 * f[..., 1] - 16, 500 * (f[..., 0] - f[..., 1]),
                     200 * (f[..., 1] - f[..., 2])), axis=-1)


def dilate(mask):
    p = np.pad(mask, 1)
    return np.logical_or.reduce([p[y:y + mask.shape[0], x:x + mask.shape[1]]
                                 for y in range(3) for x in range(3)])


def geometry(mask):
    y, x = np.nonzero(mask)
    if not len(x):
        return None, None
    return np.array([x.mean(), y.mean()]), np.array([x.min(), y.min(), x.max(), y.max()])


def iou(a, b):
    n = int((a | b).sum())
    return float((a & b).sum() / n) if n else 1.0


def native_rgba(rgba, scale):
    """Area-average premultiplied colours, then unpremultiply at native resolution."""
    h, w = rgba.shape[:2]
    a = rgba[..., 3:4]
    p = np.concatenate((rgba[..., :3] * a, a), axis=-1)
    p = p.reshape(h // scale, scale, w // scale, scale, 4).mean(axis=(1, 3))
    rgb = np.divide(p[..., :3], p[..., 3:4], out=np.zeros_like(p[..., :3]), where=p[..., 3:4] > 1e-6)
    return np.concatenate((rgb, p[..., 3:4]), axis=-1)


def align(original, hd, source_offset, hd_offset, scale, remap=None, hd_remap=None):
    """Align at the HD lattice, including half-pixel offsets in effect flipbooks."""
    if scale not in (1, 2, 3, 4, 8):
        raise ValueError(f"unsupported scale {scale}")
    lo = np.floor(np.minimum(source_offset, hd_offset)).astype(int)
    hi = np.ceil(np.maximum(np.array(source_offset) + original.shape[1::-1],
                             np.array(hd_offset) + np.array(hd.shape[1::-1]) / scale)).astype(int)
    width, height = (hi - lo).tolist()
    if width <= 0 or height <= 0 or width * height > 4_000_000:
        raise ValueError("empty or excessive aligned frame bounds")
    a = np.zeros((height * scale, width * scale, 4), dtype=np.float32)
    b = np.zeros_like(a)
    am = np.zeros(a.shape[:2], dtype=np.float32)
    bm = np.zeros_like(am)
    for source, offset, target, mask, target_mask, zoom in (
        (original, source_offset, a, remap, am, scale),
        (hd, hd_offset, b, hd_remap, bm, 1),
    ):
        xy = (np.array(offset) - lo) * scale
        if not np.isfinite(xy).all():
            raise ValueError("non-finite frame offset")
        x, y = np.floor(xy).astype(int)
        fx, fy = xy - [x, y]
        pixels = np.repeat(np.repeat(source, zoom, axis=0), zoom, axis=1)
        h, w = pixels.shape[:2]
        mask_pixels = np.repeat(np.repeat(mask, zoom, axis=0), zoom, axis=1) if mask is not None else None
        if fx < 1e-6 and fy < 1e-6:
            target[y:y + h, x:x + w] = pixels
            if mask_pixels is not None:
                target_mask[y:y + h, x:x + w] = mask_pixels
        else:
            # Fractional engine offsets occur in redrawn effects. Translate on the
            # HD lattice with bilinear coverage; never round or recenter the art.
            pixels[..., :3] *= pixels[..., 3:4]
            for dx, dy, weight in ((0, 0, (1 - fx) * (1 - fy)), (1, 0, fx * (1 - fy)),
                                   (0, 1, (1 - fx) * fy), (1, 1, fx * fy)):
                if weight < 1e-6:
                    continue
                target[y + dy:y + dy + h, x + dx:x + dx + w] += pixels * weight
                if mask_pixels is not None:
                    target_mask[y + dy:y + dy + h, x + dx:x + dx + w] += mask_pixels * weight
            target[..., :3] = np.divide(target[..., :3], target[..., 3:4], out=np.zeros_like(target[..., :3]), where=target[..., 3:4] > 1e-6)
    return native_rgba(a, scale), native_rgba(b, scale), am.reshape(height, scale, width, scale).mean((1, 3)), bm.reshape(height, scale, width, scale).mean((1, 3))


def texture_energy(rgb, support):
    """Interior native-pixel luminance total variation, excluding alpha edges."""
    l = rgb @ np.array([.2126, .7152, .0722], dtype=np.float32)
    mx = support[:, :-1] & support[:, 1:]
    my = support[:-1] & support[1:]
    n = int(mx.sum() + my.sum())
    return float((np.abs(np.diff(l, axis=1))[mx].sum() + np.abs(np.diff(l, axis=0))[my].sum()) / n) if n else None


def paint(rgb, mask, ramp, saturation=1):
    # The renderer inverts green's neutral ramp and interpolates the house palette.
    index = np.clip((1 - rgb[..., 1]) * 255 / 15, 0, 15)
    low = np.floor(index).astype(int)
    frac = index - low
    house = ramp[low] * (1 - frac[..., None]) + ramp[np.minimum(low + 1, 15)] * frac[..., None]
    if saturation < 1:
        linear = np.where(house <= .04045, house / 12.92, ((house + .055) / 1.055) ** 2.4)
        grey = linear @ np.array([.2126, .7152, .0722])
        linear = grey[..., None] * (1 - saturation) + linear * saturation
        house = np.where(linear <= .0031308, linear * 12.92, 1.055 * linear ** (1 / 2.4) - .055)
    return rgb * (1 - mask[..., None]) + house * mask[..., None]


def hue(rgb):
    mx, mn = rgb.max(-1), rgb.min(-1)
    diff = mx - mn
    h = np.zeros_like(mx)
    valid = diff > 1e-5
    for c, base in ((0, 0), (1, 2), (2, 4)):
        selected = valid & (rgb.argmax(-1) == c)
        value = ((rgb[..., (c + 1) % 3] - rgb[..., (c + 2) % 3]) / np.maximum(diff, 1e-5) + base) * 60
        h[selected] = value[selected] % 360
    return h, np.divide(diff, mx, out=np.zeros_like(diff), where=mx > 1e-5)


def measure(a, b, am, bm, ramps=(), saturation=1, shadow=False, additive=False, emission_present=False):
    result = {k: None for k in METRICS}
    failures = []
    aa, ba = a[..., 3] >= .5, b[..., 3] >= .5
    result["silhouette_iou"] = iou(aa, ba)
    ac, ab = geometry(aa)
    bc, bb = geometry(ba)
    if ac is not None and bc is not None:
        result["centroid_shift_px"] = float(np.linalg.norm(ac - bc))
        result["bbox_shift_px"] = float(np.max(np.abs(ab - bb)))
    elif ac is not None:
        # The silhouette gate measures substantial coverage, while frame presence
        # also includes faint tails and valid zero-coverage premultiplied emission.
        if not (b[..., 3] > 1e-6).any() and not emission_present:
            failures.append("missing_frame")
    elif bc is not None:
        failures.append("unexpected_frame")
    if result["silhouette_iou"] < .85:
        failures.append("silhouette_iou")
    if any((result[k] or 0) > 1.5 for k in ("centroid_shift_px", "bbox_shift_px")):
        failures.append("misregistration")
    common = aa & ba
    nonpaint = common & (am < .05) & (bm < .05)
    if nonpaint.any() and not shadow:
        al, bl = lab(a[..., :3][nonpaint]), lab(b[..., :3][nonpaint])
        result["lab_mean_delta"] = float(np.linalg.norm(al - bl, axis=-1).mean())
        result["lab_centroid_delta"] = float(np.linalg.norm(al.mean(0) - bl.mean(0)))
        if result["lab_mean_delta"] > 8:
            failures.append("colour_drift")
        ea, eb = texture_energy(a[..., :3], nonpaint), texture_energy(b[..., :3], nonpaint)
        if ea is not None and ea > 1e-6:
            result["texture_gain"] = eb / ea
            if result["texture_gain"] < 1 - 1e-6:
                failures.append("texture_loss")
    if am.any() and not shadow:
        result["remap_mask_iou"] = iou(am >= .5, bm >= .5)
        if result["remap_mask_iou"] < .85:
            failures.append("remap_mask_drift")
        differences = []
        region = common & (am >= .5)
        ar, br, arm, brm = a[..., :3][region], b[..., :3][region], am[region], bm[region]
        for ramp in ramps:
            # Only native faction pixels enter this mean. Evaluating their RGB
            # vectors gives the same result without repainting entire backgrounds.
            ap, bp = paint(ar, arm, ramp), paint(br, brm, ramp, saturation)
            ah, sa = hue(ap)
            bh, sb = hue(bp)
            valid = (sa > .1) & (sb > .1)
            if valid.any():
                delta = np.abs(ah[valid] - bh[valid])
                differences.append(float(np.minimum(delta, 360 - delta).mean()))
        if differences:
            result["remap_hue_drift_deg"] = max(differences)
            if result["remap_hue_drift_deg"] > 8:
                failures.append("faction_hue_drift")
        elif ramps:
            failures.append("faction_hue_unverified")
    area = max(1, int(aa.sum()))
    result["halo_fraction"] = float(((b[..., 3] > .02) & ~dilate(aa)).sum() / area)
    edge = dilate(~aa) & (a[..., 3] > .02) & (b[..., 3] > .02)
    if edge.any() and not additive and not shadow:
        # Pale/black contamination is visible when composited on either white or dark.
        bright = (b[..., :3] - a[..., :3]) @ np.array([.2126, .7152, .0722])
        result["fringe_fraction"] = float((edge & (np.abs(bright) > .12)).sum() / area)
    if result["halo_fraction"] > .01:
        failures.append("alpha_halo")
    if (result["fringe_fraction"] or 0) > .02:
        failures.append("alpha_fringe")
    return result, failures


def rect_valid(rect, size):
    return (isinstance(rect, list) and len(rect) == 4 and
            all(isinstance(n, int) and not isinstance(n, bool) for n in rect) and
            min(rect) >= 0 and rect[0] + rect[2] <= size[0] and rect[1] + rect[3] <= size[1])


def crop(im, rect):
    if not rect_valid(rect, im.size):
        raise ValueError(f"invalid/out-of-bounds rect {rect} for {im.size}")
    x, y, w, h = rect
    return np.array(im.crop((x, y, x + w, y + h)))


def original_frame(im, frame, palette, remappable, shadow=False):
    indexes = crop(im, frame["rect"])
    if indexes.ndim == 3:
        indexes = indexes[..., 0]
    remap = (indexes >= 16) & (indexes <= 31) if remappable and not shadow else np.zeros(indexes.shape, bool)
    rgb = palette[indexes].copy()
    if shadow:
        rgb[:] = 0
    rgb[remap] = (255 - (indexes[remap].astype(int) - 16) * 15)[:, None]
    rgba = np.concatenate((rgb / 255, (indexes != 0)[..., None]), axis=-1).astype(np.float32)
    return rgba, remap.astype(np.float32)


def neutral_ramps(document):
    candidates = [x.get("remap") for x in document.get("colorSchemes", [])]
    candidates += [x.get("remap") for x in document.get("houses", {}).values()]
    ramps = []
    seen = set()
    for ramp in candidates:
        if isinstance(ramp, list) and np.asarray(ramp).shape == (16, 3):
            array = np.asarray(ramp, dtype=np.float32) / 255
            key = array.tobytes()
            if key not in seen:
                ramps.append(array)
                seen.add(key)
    return ramps


def row(**values):
    return {**dict.fromkeys(FIELDS, ""), **values}


def issue(manifest, asset, failure, detail, **values):
    return row(scope="reference", manifest=manifest, asset=asset, status="FAIL",
               failures=failure, detail=detail, **values)


def frame_count_errors(entry):
    frames, shadows = entry.get("frames", []), entry.get("shadows", [])
    errors = []
    if "sourceFrames" in entry:
        ids = entry["sourceFrames"]
        if len(ids) != len(frames) or len(set(ids)) != len(ids):
            errors.append("sourceFrames length/uniqueness mismatch")
        count = entry.get("frameCount")
        body = count // 2 if shadows and isinstance(count, int) else count
        if body is not None and any(not isinstance(i, int) or i < 0 or i >= body for i in ids):
            errors.append("sourceFrames index beyond source body count")
    elif "frameCount" in entry and entry["frameCount"] != len(frames) + len(shadows):
        errors.append("frameCount differs from body + shadow lists")
    if shadows and len(shadows) != len(frames):
        errors.append("shadow/body count mismatch")
    return errors


def audit_json(path, doc, cache):
    """Audit local PNG/JSON references, excluding game-install provenance fields."""
    path, cache = lexical(path), lexical(cache)
    rows = []
    name = str(path.relative_to(cache))

    def visit(value, trail=""):
        if isinstance(value, dict):
            for k, v in value.items():
                visit(v, f"{trail}/{k}")
        elif isinstance(value, list):
            for i, v in enumerate(value):
                visit(v, f"{trail}/{i}")
        elif isinstance(value, str) and re.search(r"\.(png|json)$", value, re.I):
            if "://" in value or trail.endswith(("/source", "/tool")):
                return
            target = lexical(path.parent / value)
            if not target.is_relative_to(cache):
                rows.append(issue(name, trail, "reference_outside_cache", value))
            elif not target.is_file():
                rows.append(issue(name, trail, "missing_reference", value))
    visit(doc)
    sprites = doc.get("sprites", {}) if ("spriteAtlas" in doc or "spriteAtlases" in doc) else {}
    if not isinstance(sprites, dict):
        sprites = {}
    for ident, entry in sprites.items():
        if not isinstance(entry, dict):
            rows.append(issue(name, ident, "invalid_sprite_contract", "sprite entry is not an object"))
            continue
        for problem in frame_count_errors(entry):
            rows.append(issue(name, ident, "frame_count_mismatch", problem))
        for field in ("layers", "underlays"):
            for reference in entry.get(field, []):
                if reference not in sprites:
                    rows.append(issue(name, ident, "missing_sprite_reference", f"{field}: {reference}"))
    def sprite_refs(value, trail=""):
        if isinstance(value, dict):
            for k, v in value.items():
                if k == "sprite" and isinstance(v, str) and v not in sprites:
                    rows.append(issue(name, trail, "missing_sprite_reference", v))
                else:
                    sprite_refs(v, f"{trail}/{k}")
        elif isinstance(value, list):
            for i, v in enumerate(value):
                sprite_refs(v, f"{trail}/{i}")
    if sprites:
        sprite_refs(doc)
    return rows


def standard_jobs(path, doc, cache, files):
    refs = doc.get("spriteAtlases") or ([doc["spriteAtlas"]] if "spriteAtlas" in doc else [])
    hdrefs = doc.get("spriteAtlasesHd") or ([doc.get("spriteAtlasHd")] if "spriteAtlas" in doc else [])
    name = str(path.relative_to(cache))
    errors, jobs = [], []
    page_frames = collections.defaultdict(list)
    for asset, entry in doc.get("sprites", {}).items():
        for kind in ("frames", "shadows"):
            for i, frame in enumerate(entry.get(kind, [])):
                if not isinstance(frame, dict):
                    errors.append(issue(name, asset, "missing_frame", f"{kind}[{i}]"))
                    continue
                page = frame.get("page", 0)
                if not isinstance(page, int) or page < 0 or page >= len(refs):
                    errors.append(issue(name, asset, "missing_page", f"{kind}[{i}] page={page}"))
                    continue
                if not rect_valid(frame.get("rect"), (refs[page].get("width", 0), refs[page].get("height", 0))):
                    errors.append(issue(name, asset, "invalid_frame", f"{kind}[{i}] source rect={frame.get('rect')}"))
                    continue
                if kind == "shadows":
                    # Sprite shaders always use the indexed source for shadows;
                    # empty HD shadow regions do not replace/miss native frames.
                    continue
                page_frames[page].append((asset, entry, kind, i, frame, frame))
    if len(hdrefs) > len(refs):
        errors.append(issue(name, "atlas", "page_count_mismatch", "HD list exceeds source page list"))
    for page, source in enumerate(refs):
        ref = hdrefs[page] if page < len(hdrefs) else None
        source_path = lexical(path.parent / source["file"])
        source_stem = source_path.stem.split("-source-")[0]
        candidates = [p for p in files if p.parent == path.parent and
                      re.fullmatch(re.escape(source_stem) + r"@\d+x(?:[-\w]*)", p.stem) and
                      "remap" not in p.stem and "normal" not in p.stem]
        if ref:
            target = lexical(path.parent / ref["file"])
            if target not in candidates:
                candidates.append(target)
        for target in sorted(set(candidates)):
            active = bool(ref and target == lexical(path.parent / ref["file"]))
            inferred = re.search(r"@(\d+)x", target.name)
            scale = ref.get("scale", 2) if active else int(inferred.group(1)) if inferred else 2
            mask = lexical(path.parent / ref["remap"]) if active and ref.get("remap") else None
            if not mask:
                choices = [target.with_name(re.sub(r"(@\d+x)", r"\1-remap", target.name)),
                           target.with_stem(target.stem + "-remap")]
                mask = next((p for p in choices if p in files), None)
            jobs.append(dict(manifest=name, page=page, source=str(source_path), hd=str(target),
                             remap=str(mask) if mask else "", active=active, scale=scale,
                             saturation=ref.get("paintSaturation", 1) if active else 1,
                             source_ref=source, hd_ref=ref if active else None,
                             frames=page_frames[page], doc=doc, base=path.parent, additive=False))
    return jobs, errors


def effect_jobs(path, doc, native_path, native, cache):
    name = str(path.relative_to(cache))
    jobs, errors = [], []
    groups = collections.defaultdict(list)
    for asset, entry in doc.get("anims", {}).items():
        sprite_id = native.get("anims", {}).get(asset, {}).get("sprite", f"anim:{asset}")
        source_entry = native.get("sprites", {}).get(sprite_id)
        if source_entry is None:
            errors.append(issue(name, asset, "missing_original", sprite_id))
            continue
        expected = source_entry.get("frames", [])
        if len(expected) != len(entry.get("frames", [])):
            errors.append(issue(name, asset, "frame_count_mismatch", f"HD={len(entry.get('frames', []))}, source={len(expected)}"))
        for i, source_frame in enumerate(expected):
            frame = entry.get("frames", [])[i] if i < len(entry.get("frames", [])) else None
            if frame is None:
                if source_frame["rect"][2] * source_frame["rect"][3]:
                    errors.append(issue(name, asset, "missing_frame", f"HD frame {i} null/absent"))
                continue
            page, sp = frame.get("page", 0), source_frame.get("page", 0)
            if not (isinstance(page, int) and 0 <= page < len(doc.get("pages", [])) and 0 <= sp < len(native.get("spriteAtlases", []))):
                errors.append(issue(name, asset, "missing_page", f"frame {i}: HD={page}, source={sp}"))
                continue
            groups[(page, sp, entry.get("scale", 2))].append((asset, source_entry, "frames", i, source_frame, frame))
    for (page, sp, scale), frames in sorted(groups.items()):
        target, source = doc["pages"][page], native["spriteAtlases"][sp]
        jobs.append(dict(manifest=name, page=page, source=str(lexical(native_path.parent / source["file"])),
                         hd=str(lexical(path.parent / target["file"])), remap="", active=True,
                         scale=scale, saturation=1, source_ref=source, hd_ref=target,
                         frames=frames, doc=native, base=native_path.parent, additive=True))
    return jobs, errors


def coalesce(rows):
    """Only adjacent frames with identical failures coalesce; preserve worst metrics."""
    result = []
    for r in rows:
        prev = result[-1] if result else None
        if prev and all(prev[k] == r[k] for k in ("asset", "kind", "failures", "hd", "source", "detail")) and prev["frame_end"] + 1 == r["frame_start"] and prev["source_frame_end"] + 1 == r["source_frame_start"]:
            prev["frame_end"], prev["source_frame_end"] = r["frame_end"], r["source_frame_end"]
            prev["frames"] += 1
            for k in METRICS:
                vals = [v for v in (prev[k], r[k]) if isinstance(v, (int, float))]
                prev[k] = (min if k in ("silhouette_iou", "texture_gain", "remap_mask_iou") else max)(vals) if vals else None
        else:
            result.append(r.copy())
    return result


def score(r):
    structural = {"missing_frame", "missing_page", "missing_reference", "frame_count_mismatch", "missing_original", "input_changed", "invalid_frame"}
    flags = set(r["failures"].split(";"))
    return (100 if structural & flags else 0) + len(flags) + (1 - (r.get("silhouette_iou") or 0)) * 10 + min(20, (r.get("lab_mean_delta") or 0) / 8) + min(20, (r.get("centroid_shift_px") or 0))


def evaluate_job(job, cache, out, memo):
    files = [Path(job[k]) for k in ("source", "hd", "remap") if job[k]]
    palette_names = {e[1]["palette"] for e in job["frames"]}
    palette_paths = {k: job["base"] / job["doc"].get("palettes", {}).get(k, "__missing_palette__") for k in palette_names}
    files += list(palette_paths.values())
    before = {str(p): stamp(p) for p in files}
    contract = {k: v for k, v in job.items() if k not in ("base", "doc")}
    contract["ramps"] = [a.tolist() for a in neutral_ramps(job["doc"])]
    salt = digest(json.dumps([job["scale"], job["saturation"], job["additive"], contract["ramps"]]).encode()).encode()
    key = digest(json.dumps([VERSION, CODE_DIGEST, contract, before], sort_keys=True).encode())
    receipt = out / "page-results" / f"{key}.json"
    if receipt.exists():
        return json.loads(receipt.read_text()), True
    base = dict(scope="sprite", manifest=job["manifest"], page=job["page"], active=job["active"],
                source=str(Path(job["source"]).relative_to(cache)) if Path(job["source"]).is_relative_to(cache) else job["source"],
                hd=str(Path(job["hd"]).relative_to(cache)) if Path(job["hd"]).is_relative_to(cache) else job["hd"],
                remap=str(Path(job["remap"]).relative_to(cache)) if job["remap"] and Path(job["remap"]).is_relative_to(cache) else job["remap"])
    errors, rows, worst = [], [], []
    for p in files:
        if not lexical(p).is_relative_to(cache):
            errors.append(row(**base, asset="atlas", status="FAIL", failures="reference_outside_cache", detail=str(p)))
        elif not p.is_file():
            errors.append(row(**base, asset="atlas", status="FAIL", failures="missing_reference", detail=str(p)))
    if errors:
        result = {"rows": errors, "frames": 0, "worst": [], "before": before}
        receipt.write_text(json.dumps(result))
        return result, False
    try:
        src, hd = read_image(Path(job["source"])), read_image(Path(job["hd"])).convert("RGBA")
        mask = read_image(Path(job["remap"])).convert("L") if job["remap"] else None
        palettes = {k: np.asarray(read_image(p).convert("RGB")).reshape(-1, 3) for k, p in palette_paths.items()}
        if any(len(p) != 256 for p in palettes.values()):
            raise ValueError("palette is not 256 RGB entries")
        expected = tuple(round(v * job["scale"]) for v in src.size)
        if not job["additive"] and hd.size != expected:
            errors.append(row(**base, asset="atlas", status="FAIL", failures="page_dimensions", detail=f"HD {hd.size}, expected {expected}"))
        if mask and mask.size != hd.size:
            errors.append(row(**base, asset="atlas", status="FAIL", failures="remap_dimensions", detail=f"mask {mask.size}, HD {hd.size}"))
            mask = None
        for im, ref, tag in ((src, job["source_ref"], "source"), (hd, job["hd_ref"], "HD")):
            if ref and im.size != (ref.get("width"), ref.get("height")):
                errors.append(row(**base, asset="atlas", status="FAIL", failures="json_dimensions", detail=f"{tag}: {im.size} != JSON {(ref.get('width'), ref.get('height'))}"))
        ramps = neutral_ramps(job["doc"])
        if not job["frames"]:
            rows.append(row(**base, asset="atlas", status="REFERENCE_ONLY", detail="no body replacements; indexed shadow/source data remains authoritative"))
        for asset, entry, kind, i, sf, hf in job["frames"]:
            source_id = entry.get("sourceFrames", list(range(len(entry.get(kind, [])))))[i]
            r = row(**base, asset=asset, kind="shadow" if kind == "shadows" else "body", frame_start=i,
                    frame_end=i, source_frame_start=source_id, source_frame_end=source_id, frames=1)
            try:
                a, am = original_frame(src, sf, palettes[entry["palette"]], entry.get("remap", False), kind == "shadows")
                if not a.size:
                    r.update(status="EMPTY", failures="", detail="empty native frame; no raster replacement expected")
                    rows.append(r)
                    continue
                hrect = hf["rect"] if job["additive"] else [int(v * job["scale"]) for v in sf["rect"]]
                raw = crop(hd, hrect)
                b = raw.astype(np.float32) / 255
                if job["additive"]:
                    # Premultiplied effect RGB with alpha=0 is valid emission, never a sprite fringe.
                    b[..., :3] = np.divide(b[..., :3], b[..., 3:4], out=np.zeros_like(b[..., :3]), where=b[..., 3:4] > 1e-6)
                    b[..., :3] = np.minimum(b[..., :3], 1)
                bm = crop(mask, hrect).astype(np.float32) / 255 if mask else np.zeros(b.shape[:2], dtype=np.float32)
                offsets = (sf.get("offset", [0, 0]), hf.get("offset", [0, 0]))
                signature = digest(raw.tobytes() + a.tobytes() + am.tobytes() + bm.tobytes() + json.dumps([offsets, kind]).encode() + salt)
                if signature in memo:
                    metrics, flags = memo[signature]
                else:
                    aa, bb, aam, bbm = align(a, b, *offsets, job["scale"], am, bm)
                    metrics, flags = measure(aa, bb, aam, bbm, ramps, job["saturation"], kind == "shadows", job["additive"],
                                             bool(job["additive"] and raw[..., :3].any()))
                    if len(memo) > 100_000:
                        memo.clear()
                    memo[signature] = (metrics, flags)
                flags = list(flags)
                if am.any() and not mask and not job["additive"]:
                    flags.append("missing_remap")
                if am.any() and not ramps:
                    flags.append("faction_hue_unverified")
                r.update(metrics, failures=";".join(flags), status="FAIL" if flags else "PASS")
                if r["failures"]:
                    candidate = {"row": r, "source_rect": sf["rect"], "hd_rect": hrect,
                                 "source_offset": offsets[0], "hd_offset": offsets[1], "scale": job["scale"],
                                 "palette": str(palette_paths[entry["palette"]]), "remappable": entry.get("remap", False),
                                 "additive": job["additive"]}
                    worst.append(candidate)
                    worst.sort(key=lambda x: score(x["row"]), reverse=True)
                    del worst[50:]
            except (ValueError, IndexError, KeyError, TypeError) as e:
                r.update(status="FAIL", failures="invalid_frame", detail=str(e))
            rows.append(r)
        src.close()
        hd.close()
        if mask:
            mask.close()
    except (OSError, ValueError) as e:
        errors.append(row(**base, asset="atlas", status="FAIL", failures="unreadable_page", detail=str(e)))
    after = {str(p): stamp(p) for p in files}
    if after != before:
        errors.append(row(**base, asset="atlas", status="FAIL", failures="input_changed", detail="source changed during this page scan; rerun required"))
    result = {"rows": errors + coalesce(rows), "frames": len(rows), "worst": worst, "before": before}
    if after == before:
        receipt.write_text(json.dumps(result, allow_nan=False))
    return result, False


def comparison(candidate, cache, out, rank):
    r = candidate["row"]
    source, target = read_image(cache / r["source"]), read_image(cache / r["hd"])
    palette = np.asarray(read_image(Path(candidate["palette"])).convert("RGB")).reshape(-1, 3)
    a, am = original_frame(source, {"rect": candidate["source_rect"]}, palette,
                           candidate["remappable"], r["kind"] == "shadow")
    b = crop(target.convert("RGBA"), candidate["hd_rect"]).astype(np.float32) / 255
    if candidate["additive"]:
        b[..., :3] = np.minimum(1, np.divide(b[..., :3], b[..., 3:4], out=np.zeros_like(b[..., :3]), where=b[..., 3:4] > 1e-6))
    a, b, _, _ = align(a, b, candidate["source_offset"], candidate["hd_offset"], candidate["scale"], am)
    h, w = a.shape[:2]
    panel = Image.new("RGB", (w * 2 + 12, h + 28), "#171b22")
    draw = ImageDraw.Draw(panel)
    draw.text((2, 5), "Original 1x", fill="white")
    draw.text((w + 14, 5), "HD -> 1x", fill="white")
    y, x = np.indices((h, w))
    checker = np.where(((x // 8 + y // 8) % 2)[..., None], .3, .2)
    for im, left in ((a, 0), (b, w + 12)):
        rgb = im[..., :3] * im[..., 3:4] + checker * (1 - im[..., 3:4])
        panel.paste(Image.fromarray(np.rint(np.clip(rgb, 0, 1) * 255).astype(np.uint8)), (left, 28))
    name = f"crops/{rank:02d}.png"
    panel.save(out / name)
    source.close()
    target.close()
    return name, panel.size


def write_report(out, rows, stats, candidates, cache):
    with (out / "qa.csv").open("w", newline="") as f:
        writer = csv.DictWriter(f, FIELDS, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(rows)
    counts = collections.Counter(flag for r in rows for flag in r["failures"].split(";") if flag)
    text = ["# HD sprite QA sweep", "", f"Snapshot: {stats['started_at']} (Unix {stats['started_unix']}).", "",
            f"Compared **{stats['frames']:,} frames** across **{stats['jobs']} page/source pairs**, "
            f"covering **{stats['compared_hd_pages']} unique HD colour pages**. "
            f"Inventoried {stats['sprite_pngs']} sprite PNGs, {stats['json_files']} JSON files. "
            f"CSV: {len(rows):,} asset/frame-range or structural rows; {sum(r['status'] == 'FAIL' for r in rows):,} flagged rows.", "",
            "## Thresholds and interpretation", "",
            "Native (1x) engine offsets are preserved. HD is area-downsampled in premultiplied alpha, then unpremultiplied. "
            "Silhouette alpha >= 0.5: IoU < 0.85. Binary centroid Euclidean shift or maximum bbox-side shift > 1.5 native pixels. "
            "Colour: mean corresponding-pixel CIELAB D65 deltaE76 > 8 on opaque non-remap pixels; centroid Lab delta also recorded. "
            "Faction hue: worst mean circular hue drift > 8 degrees across available house ramps, applying the renderer's grey-to-remap lookup and paintSaturation. "
            "Missing schemes/masks remain UNVERIFIED. Indexed shadows remain authoritative in the renderer; "
            "their source rectangles and counts are audited, and empty HD shadow regions are not missing replacements.", "",
            "Texture gain is HD/native interior luminance total variation on the identical non-remap support, excluding alpha-edge contrast. "
            "Gain < 1 indicates smoothing. Flat native frames have no measurable denominator (blank metric, not a texture pass). "
            "This metric cannot certify new realistic material detail: noise and sharpening may score well. "
            "Halos: alpha > .02 farther than one native pixel outside the native silhouette, > 1% of native area. "
            "Fringes: boundary luminance change > .12 over > 2% of native area. Intentional effect emission is excluded from fringe scoring.", "",
            "A frame is missing only when no coverage or valid premultiplied effect emission remains. "
            "Faint effect tails may fail the alpha-0.5 silhouette gate without being missing. Effect crops show coverage colour; "
            "zero-coverage emission and the final additive blend require runtime review. Sprite crops retain the neutral faction ramp; "
            "faction hue is evaluated separately across available house palettes.", "",
            "`active=true` identifies current JSON references. Historical sprite pages are matched to their indexed filename prefix "
            "and current frame layout; that historical layout is inferred and requires manual review. Unmapped pages are explicitly flagged. "
            "Effect pages use only their explicit HD frame/offset JSON; unused historical effect pages cannot be guessed. "
            "Remap/normal maps receive inventory/reference and PNG chunk-integrity checks, not colour replacement scores. "
            "Source evidence is extracted indexed pages plus their supplied palettes, not an independent re-extraction from original SHP files.", "",
            "## Flags (asset/frame ranges)", "", "| Flag | Rows |", "| --- | ---: |"]
    text += [f"| {k} | {v:,} |" for k, v in counts.most_common()]
    text += ["", "## Input stability", "", f"Changed/new/deleted inputs after snapshot: **{len(stats['changed_inputs'])}**. "
             "See scan-summary.json and input-inventory.json. A changing cache requires a fresh sweep; it is never counted as stable acceptance.", "",
             "## Worst 50 comparable frames", "", "Saved PNGs are at native pixel size: Original | HD -> 1x, on the same checkerboard. "
             "Open each PNG at 100%; Markdown viewers may rescale large panels. Structural failures without comparable pixels are listed separately below.", ""]
    worst_rows = []
    for rank, c in enumerate(sorted(candidates, key=lambda c: score(c["row"]), reverse=True)[:50], 1):
        r = c["row"]
        try:
            image, dimensions = comparison(c, cache, out, rank)
            text += [f"### {rank}. {r['asset']} — {r['kind']} frame {r['frame_start']}", "",
                     f"`{r['hd']}`; active={r['active']}; flags: {r['failures']}.", "",
                     "; ".join(f"{k}={r[k]:.4f}" for k in METRICS if isinstance(r[k], (float, int))), "",
                     f"![Original | HD 1x, {dimensions[0]}x{dimensions[1]}]({image})", ""]
            worst_rows.append({**r, "crop": image, "dimensions": dimensions})
        except (OSError, ValueError) as e:
            text += [f"{rank}. UNVERIFIED crop: {r['asset']}: {e}", ""]
    text += ["## Worst structural/reference failures", ""]
    for r in sorted((r for r in rows if r["scope"] != "sprite" or r["asset"] == "atlas"), key=score, reverse=True)[:50]:
        text.append(f"- `{r['manifest']}` / `{r['asset']}`: {r['failures']} — {r['detail']}")
    text += ["", "## NEEDS LIVE CHECK", "", "UNVERIFIED: runtime animation, faction repaint under scene lighting, occlusion, contact shadows, "
             "art director material-detail judgement and renderer fringe suppression. This headless report is triage, not release or visual acceptance.", ""]
    (out / "QA.md").write_text("\n".join(text))
    (out / "worst-50.json").write_text(json.dumps(worst_rows, indent=2))
    stats["flag_counts"] = counts
    stats["csv_rows"] = len(rows)
    stats["flagged_rows"] = sum(r["status"] == "FAIL" for r in rows)
    (out / "scan-summary.json").write_text(json.dumps(stats, indent=2))


def scan(cache: Path, out: Path):
    cache, out = cache.resolve(), out.resolve()
    if out == cache or out.is_relative_to(cache) or cache.is_relative_to(out):
        raise ValueError("--out and --cache must be disjoint; no writes within input cache")
    if not cache.is_dir():
        raise ValueError("--cache is not a directory")
    out.mkdir(parents=True, exist_ok=True)
    for name in ("page-results", "crops"):
        (out / name).mkdir(exist_ok=True)
    started = time.time()
    files = sorted(lexical(p) for p in cache.rglob("*") if p.is_file() or p.is_symlink())
    if any(p.resolve().is_relative_to(out) for p in files):
        raise ValueError("--out overlaps a symlinked input target")
    for name in ("page-results", "crops", "qa.csv", "QA.md", "worst-50.json", "scan-summary.json", "progress.json", "input-inventory.json"):
        if not (out / name).resolve().is_relative_to(out):
            raise ValueError(f"output path escapes --out: {name}")
    images = set(p for p in files if p.suffix.lower() == ".png")
    inventory = {str(p.relative_to(cache)): stamp(p) for p in files}
    rows, documents, jobs = [], {}, []
    for path in files:
        if path.suffix.lower() == ".json":
            try:
                doc = json.loads(path.read_text())
                documents[path] = doc
                if isinstance(doc, dict):
                    rows += audit_json(path, doc, cache)
            except (OSError, ValueError, TypeError) as e:
                rows.append(issue(str(path.relative_to(cache)), "json", "unreadable_json", str(e)))
    for path, doc in documents.items():
        if isinstance(doc, dict) and isinstance(doc.get("sprites"), dict) and ("spriteAtlases" in doc or "spriteAtlas" in doc):
            found, errors = standard_jobs(path, doc, cache, images)
            jobs += found
            rows += errors
        if path.name == "effects-hd.json" and isinstance(doc, dict):
            native_path = path.parent.parent / "effects/effects.json"
            if native_path in documents:
                found, errors = effect_jobs(path, doc, native_path, documents[native_path], cache)
                jobs += found
                rows += errors
            else:
                rows.append(issue(str(path.relative_to(cache)), "effects", "missing_original", str(native_path)))
    covered = {Path(job["hd"]) for job in jobs}
    sprite_images = {p for p in images if p.name.startswith(("sprites", "effects-hd"))}
    source_images = {lexical(path.parent / ref["file"]) for path, doc in documents.items() if isinstance(doc, dict)
                     for ref in (doc.get("spriteAtlases", []) + ([doc["spriteAtlas"]] if "spriteAtlas" in doc else []))}
    auxiliary = {p for p in sprite_images if "remap" in p.name or "normal" in p.name}
    for p in sorted(sprite_images - covered - auxiliary - source_images):
        rows.append(issue("inventory", p.name, "unmapped_hd_page", str(p.relative_to(cache)), hd=str(p.relative_to(cache))))
    # Check PNG chunk integrity even for unreferenced auxiliary masks/normals.
    for p in sorted(auxiliary):
        try:
            with Image.open(p) as im:
                im.verify()
        except (OSError, ValueError) as e:
            rows.append(issue("inventory", p.name, "unreadable_auxiliary", str(e)))
    stats = dict(started_unix=started, started_at=time.strftime("%Y-%m-%d %H:%M:%S %z", time.localtime(started)),
                 jobs=len(jobs), compared_hd_pages=len(covered), sprite_pngs=len(sprite_images),
                 auxiliary_pages=len(auxiliary), source_pages=len(source_images), unmapped_pages=len(sprite_images - covered - auxiliary - source_images),
                 json_files=len(documents), frames=0, resumed_jobs=0, thresholds=THRESHOLDS)
    print(f"inventory: {stats}; starting page scan", flush=True)
    memo, candidates = {}, []
    # Source grouping improves crop metric reuse across historical page variants.
    jobs.sort(key=lambda j: (j["source"], not j["active"], j["hd"]))
    for index, job in enumerate(jobs, 1):
        result, resumed = evaluate_job(job, cache, out, memo)
        rows += result["rows"]
        candidates += result["worst"]
        candidates.sort(key=lambda c: score(c["row"]), reverse=True)
        del candidates[100:]
        stats["frames"] += result["frames"]
        stats["resumed_jobs"] += int(resumed)
        progress = {**stats, "completed_jobs": index, "last_page": str(Path(job["hd"]).relative_to(cache))}
        (out / "progress.json").write_text(json.dumps(progress, indent=2))
        print(f"[{index}/{len(jobs)}] {progress['last_page']} frames={result['frames']} total={stats['frames']} {'RESUMED' if resumed else ''}", flush=True)
    current = {str(p.relative_to(cache)): stamp(p) for p in cache.rglob("*") if p.is_file() or p.is_symlink()}
    changed = [p for p in sorted(inventory.keys() | current.keys()) if inventory.get(p) != current.get(p)]
    stats["changed_inputs"] = changed
    stats["elapsed_seconds"] = time.time() - started
    (out / "input-inventory.json").write_text(json.dumps({"before": inventory, "after": current}, indent=2))
    for p in changed:
        rows.append(issue("inventory", p, "input_changed", "new, deleted or changed after scan snapshot"))
    write_report(out, rows, stats, candidates, cache)
    print(f"finished: {stats['frames']} frames; {stats['flagged_rows']} flagged ranges; {len(changed)} changed inputs", flush=True)
    return stats


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cache", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    scan(args.cache, args.out)


if __name__ == "__main__":
    main()
