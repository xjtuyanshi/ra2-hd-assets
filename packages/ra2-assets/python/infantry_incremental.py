#!/usr/bin/env python3
"""Reviewable, foreground-only infantry batches over the existing sheet composer.

Snapshot completed workers, compose immutable frame crops, inspect review.png, then
publish accepted crops onto the current farm pages. No generation or scheduling.
"""

from __future__ import annotations

import argparse
import copy
from datetime import datetime, timezone
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil

import numpy as np
from PIL import Image, ImageDraw

import cache_farm
import infantry_sheets as inf


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def write_json(path, data):
    with inf.atomic_output(path) as temporary:
        temporary.write_text(json.dumps(data, indent=2), encoding="utf-8")


def save_image(path, pixels):
    with inf.atomic_output(path) as temporary:
        Image.fromarray(pixels).save(temporary, format="PNG", compress_level=1)


def ready(directory):
    """An output alone is insufficient: the worker may still be replacing it."""
    marker = directory / "done.txt"
    required = [directory / name for name in ("job.json", "input.png", "output.png")]
    if not marker.is_file() or not all(path.is_file() for path in required):
        return False
    if marker.read_text().splitlines()[0:1] != ["exit 0"]:
        return False
    observed = required + [directory / name for name in ("full.png", "started.txt")
                           if (directory / name).exists()]
    return marker.stat().st_mtime_ns >= max(path.stat().st_mtime_ns for path in observed)


def snapshot(work, out, names):
    if out.resolve().is_relative_to(work.resolve()):
        raise ValueError("snapshot must be outside the worker directory")
    if not names or len(names) != len(set(names)):
        raise ValueError("provide distinct sheet names")
    for name in names:
        if Path(name).name != name or name in (".", "..") or not ready(work / "sheets" / name):
            raise ValueError(f"sheet is not a completed successful worker: {name}")
    out.mkdir(parents=True, exist_ok=False)
    record = {"at": datetime.now(timezone.utc).isoformat(), "source": str(work.resolve()), "sheets": {}}
    for name in names:
        source = work / "sheets" / name
        target = out / "sheets" / name
        target.mkdir(parents=True)
        files = [n for n in ("job.json", "input.png", "output.png", "full.png", "done.txt", "started.txt")
                 if (source / n).is_file()]
        before = {n: digest(source / n) for n in files}
        for filename in files:
            (target / filename).write_bytes((source / filename).read_bytes())
        if not ready(source) or any(digest(source / n) != before[n] or digest(target / n) != before[n]
                                    for n in files):
            raise ValueError(f"worker changed during snapshot: {name}; discard this incomplete snapshot")
        record["sheets"][name] = before
    write_json(out / "snapshot.json", record)
    return record


def body_iou(rgba, indices):
    native = np.kron((indices > 0) & (indices != 12), np.ones((2, 2), bool))
    body = (rgba[..., 3] > 127) & ((rgba[..., :3].max(-1) > 24) | native)
    return float(inf.iou(body, native))


def silhouette_passes(metrics, reference, threshold):
    if reference == "legacy":
        return metrics["sil_iou"] >= threshold
    if reference != "indexed":
        raise ValueError("silhouette reference must be legacy or indexed")
    # A missing or incomplete measurement cannot silently fall back to the legacy gate.
    return (metrics.get("indexed_sil_method") == inf.INDEXED_SIL_METHOD
            and metrics.get("indexed_context_edge") is False
            and np.isfinite(metrics.get("indexed_sil_iou", float("nan")))
            and metrics["indexed_sil_iou"] >= threshold)


def restrict_source_remap(source, sprite, index, rgba, paint, house):
    """Remove model paint outside original support without discarding its material luminance."""
    rgb1, _, remap1, indices = source.frame1(sprite, index, house)
    support = np.kron(remap1, np.ones((2, 2), bool))
    removed = (paint > 0) & ~support
    if not removed.any():
        return rgba, paint
    valid = (indices > 0) & (indices != 12) & ~remap1
    valid_positions = np.argwhere(valid)
    if not len(valid_positions):
        raise ValueError("source has no non-remap body colour for model-paint correction")
    positions = np.argwhere(removed)
    native_positions = positions // 2
    reference = rgb1[native_positions[:, 0], native_positions[:, 1]].copy()
    missing = np.flatnonzero(~valid[native_positions[:, 0], native_positions[:, 1]])
    # Edge/transparent texels inherit real body chroma, never transparent palette colour.
    for start in range(0, len(missing), 256):
        chunk = missing[start:start + 256]
        distance = ((native_positions[chunk, None] - valid_positions[None]) ** 2).sum(-1)
        nearest = valid_positions[distance.argmin(-1)]
        reference[chunk] = rgb1[nearest[:, 0], nearest[:, 1]]
    decoded = source.decode_hd(rgba, paint, house)
    lab = inf.rd.srgb_to_lab(reference)
    lab[..., 0] = inf.rd.srgb_to_lab(decoded[removed])[..., 0]
    restored = np.clip(np.rint(inf.rd.lab_to_srgb(lab)), 0, 255).astype(np.uint8)
    output, output_paint = rgba.copy(), paint.copy()
    output[removed, :3] = restored
    output_paint[removed] = 0
    return output, output_paint


def finish_frame(source, indices, rgba, paint, edge, value):
    rgba, paint = inf.repaint_frame(rgba, paint, indices, source.scheme("Red")[:16], edge=edge)
    rgba = inf.reshadow_frame(rgba, indices)
    if value is not None:
        rgba = inf.paint_value_frame(rgba, paint, indices, value[0], outside_floor=value[1])
    return rgba, paint


def compose(source, frozen, out, opts, min_sil=0.6, min_body=0.0, edges=None, paint_values=None,
            silhouette_reference="legacy", source_remap=()):
    """Stage every candidate; rejection retains its evidence but never reaches publish."""
    if out.resolve().is_relative_to(source.root.resolve()) or out.resolve().is_relative_to(frozen.resolve()):
        raise ValueError("candidate directory must be outside immutable sources")
    if not 0 <= min_sil <= 1 or not 0 <= min_body <= 1:
        raise ValueError("silhouette thresholds must be in 0..1")
    if silhouette_reference not in ("legacy", "indexed"):
        raise ValueError("silhouette reference must be legacy or indexed")
    for value in (edges or {}).values():
        inf.edge_pair(",".join(map(str, value)))
    for gamma, floor in (paint_values or {}).values():
        inf._validate_paint_value(gamma, floor)
    snapshot_record = json.loads((frozen / "snapshot.json").read_text())
    for name, files in snapshot_record["sheets"].items():
        if any(digest(frozen / "sheets" / name / filename) != sha for filename, sha in files.items()):
            raise ValueError(f"immutable snapshot changed: {name}")
    out.mkdir(parents=True, exist_ok=False)
    record = {"source": str(source.root.resolve()), "source_manifest_sha256": digest(source.root / "library.json"),
              "snapshot": str(frozen.resolve()), "options": vars(opts), "min_sil": min_sil, "min_body": min_body,
              "edges": edges or {}, "paint_values": paint_values or {},
              "silhouette_reference": silhouette_reference, "source_remap": list(source_remap),
              "frames": {}, "sheets": {}}
    examples = []
    for name in snapshot_record["sheets"]:
        result = inf.compose_job(source, frozen / "sheets" / name, opts)
        if result is None:
            raise ValueError(f"snapshot has no readable result: {name}")
        sprite = result["job"]["sprite"]
        sheet_keys = []
        for index, frame in result["frames"].items():
            key = f"{sprite}#{index}"
            if key in record["frames"]:
                raise ValueError(f"duplicate candidate frame in batch: {key}")
            indices = source.frame1(sprite, index)[3]
            edge = (edges or {}).get(key, (edges or {}).get(sprite, (0.05, 0.42)))
            value = (paint_values or {}).get(key, (paint_values or {}).get(sprite))
            rgba, paint = finish_frame(source, indices, frame["rgba"], frame["paint"], edge, value)
            if key in source_remap or sprite in source_remap:
                rgba, paint = rgba.copy(), paint.copy()
                corrected, corrected_paint = restrict_source_remap(
                    source, sprite, index, frame["rgba"], frame["paint"], result["job"]["house"])
                corrected, corrected_paint = finish_frame(source, indices, corrected, corrected_paint, edge, value)
                support = np.kron((indices >= 16) & (indices <= 31), np.ones((2, 2), bool))
                removed = (frame["paint"] > 0) & ~support
                # Repaint's convolution and contact-shadow calculations can propagate a local colour change.
                # Bound this optional correction after all finishing: geometry and every unrelated byte stay exact.
                rgba[removed, :3] = corrected[removed, :3]
                paint[removed] = corrected_paint[removed]
            metrics = dict(frame["metrics"], body_iou=body_iou(rgba, indices))
            native_body = np.kron((indices > 0) & (indices != 12), np.ones((2, 2), bool))
            reference_alpha = source.frame2(sprite, index)[1]
            metrics["body_alpha_max_difference"] = int(np.abs(
                rgba[..., 3].astype(np.int16) - reference_alpha.astype(np.int16))[native_body].max(initial=0))
            original_paint = int(((indices >= 16) & (indices <= 31)).sum()) * 4
            current_paint = int((paint > 127).sum())
            metrics.update(original_remap_pixels=original_paint, remap_pixels=current_paint,
                           remap_ratio=current_paint / original_paint if original_paint else None)
            accepted = silhouette_passes(metrics, silhouette_reference, min_sil) and metrics["body_iou"] >= min_body
            accepted = accepted and (original_paint > 0 or current_paint == 0)
            stem = f"{len(record['frames']):06d}"
            files = {"color": f"{stem}-color.png", "remap": f"{stem}-remap.png"}
            save_image(out / files["color"], rgba)
            save_image(out / files["remap"], paint)
            record["frames"][key] = {"sheet": name, "sprite": sprite, "index": index,
                                      "source_frame": source.frames(sprite)[index], "accepted": bool(accepted),
                                      "metrics": metrics, "files": files,
                                      "sha256": {kind: digest(out / filename) for kind, filename in files.items()}}
            sheet_keys.append(key)
        record["sheets"][name] = {"frames": sheet_keys, "skipped": result.get("skipped", {})}
        if sheet_keys:
            metric = "indexed_sil_iou" if silhouette_reference == "indexed" else "sil_iou"
            worst = min(sheet_keys, key=lambda key: record["frames"][key]["metrics"].get(metric, 0))
            selected = list(dict.fromkeys((sheet_keys[0], worst, sheet_keys[len(sheet_keys) // 2], sheet_keys[-1])))
            examples.append((name, selected, result["job"]["house"]))
    write_json(out / "candidates.json", record)
    board = Image.new("RGB", (1040, max(1, len(examples)) * 170), (54, 59, 58))
    draw = ImageDraw.Draw(board)
    for row, (name, keys, house) in enumerate(examples):
        draw.text((8, row * 170 + 4), name, fill="white")
        for column, key in enumerate(keys):
            entry = record["frames"][key]
            rgb, alpha, _, _ = source.frame1(entry["sprite"], entry["index"], house)
            rgba = np.array(Image.open(out / entry["files"]["color"]).convert("RGBA"))
            paint = np.array(Image.open(out / entry["files"]["remap"]).convert("L"))
            original = Image.fromarray(np.dstack((rgb.astype(np.uint8), alpha.astype(np.uint8) * 255)))
            original = original.resize((original.width * 2, original.height * 2), Image.Resampling.NEAREST)
            decoded = Image.fromarray(np.dstack((source.decode_hd(rgba, paint, house).clip(0, 255).astype(np.uint8),
                                                 rgba[..., 3])))
            for side, tile in enumerate((original, decoded)):
                factor = min(110 / tile.width, 118 / tile.height, 3)
                tile = tile.resize((max(1, round(tile.width * factor)), max(1, round(tile.height * factor))),
                                   Image.Resampling.NEAREST)
                board.paste(tile, (column * 260 + side * 120 + 8, row * 170 + 28), tile)
            extra = (f" idx {entry['metrics'].get('indexed_sil_iou', float('nan')):.3f}"
                     if silhouette_reference == "indexed" else "")
            draw.text((column * 260 + 8, row * 170 + 150),
                      f"{entry['index']} {'ACCEPT' if entry['accepted'] else 'RETAIN'} "
                      f"IoU {entry['metrics']['sil_iou']:.3f}{extra}", fill="white")
    board.save(out / "review.png")
    return record


def publish(source, staged, farm, theater, out, suffix, reserve_bytes=4 * 1024 ** 3, exclude=()):
    """Compare-and-swap under the manifest lock; immutable filenames prevent pre-CAS clobbering."""
    if any(not re.fullmatch(r"[A-Za-z0-9_-]+", text) for text in (theater, suffix)):
        raise ValueError("theater and suffix must be simple filename components")
    # Resolve ancestors, but retain the farm's own namespace: its final directory or descendants may be COW
    # links which cache_farm deliberately detaches. Resolving those links would incorrectly equate farm and base.
    farm_path = Path(os.path.abspath(farm))
    farm_path = farm_path.parent.resolve() / farm_path.name
    protected = (source.root.resolve(), staged.resolve())
    if any(root.is_relative_to(farm_path) or farm_path.is_relative_to(root) for root in protected):
        raise ValueError("farm must be separate from immutable source and candidate directories")
    if any(out.resolve().is_relative_to(root.resolve()) for root in (source.root, staged, farm)):
        raise ValueError("publication staging must be outside source, candidates and farm")
    lock_path = cache_farm._destination(farm, f"_library/{theater}/.compose.lock")
    if lock_path.is_symlink() and not lock_path.exists():
        raise ValueError("composition lock is a dangling symlink")
    # A shared read-only lock inode coordinates library.json and normals.json without writing through an
    # inherited lock symlink. Read the current pages only after acquiring the same lock as sibling composers.
    with os.fdopen(os.open(lock_path, os.O_CREAT | os.O_RDONLY, 0o600), "r") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        try:
            return _publish_locked(source, staged, farm, theater, out, suffix, reserve_bytes, exclude)
        finally:
            fcntl.flock(lock, fcntl.LOCK_UN)


def normal_entry(directory, page):
    path = directory / "normals.json"
    return json.loads(path.read_text()).get("pages", {}).get(str(page)) if path.exists() else None


def normal_reuse(directory, page, prior, before, after):
    """Rebinding is allowed only when every texel with material support retains its original RGBA."""
    entry = normal_entry(directory, page)
    if entry is None:
        return None
    if any(entry.get(key) != prior.get(field) for key, field in
           (("atlas", "file"), ("width", "width"), ("height", "height"), ("scale", "scale"))):
        raise ValueError(f"normal atlas binding is stale on page {page}; repair its source before publication")
    with Image.open(directory / entry["file"]) as image:
        material = np.array(image.convert("RGBA"))
    mh, mw = material.shape[:2]
    h, w = before.shape[:2]
    if (mw, mh) != (entry.get("materialWidth"), entry.get("materialHeight")) or w % mw or h % mh:
        raise ValueError(f"normal atlas dimensions cannot map exactly to page {page}")
    support = np.repeat(np.repeat(material[..., 3] > 0, h // mh, axis=0), w // mw, axis=1)
    if not np.array_equal(before[support], after[support]):
        raise ValueError(f"changed RGBA intersects normal support on page {page}; material rebuild required")
    return {"entry": entry, "support_pixels": int(support.sum()),
            "supported_rgba_sha256": hashlib.sha256(before[support].tobytes()).hexdigest(),
            "file_sha256": digest(directory / entry["file"])}


def _publish_locked(source, staged, farm, theater, out, suffix, reserve_bytes, exclude):
    record = json.loads((staged / "candidates.json").read_text())
    if set(exclude) - record["frames"].keys():
        raise ValueError("excluded frames must exist in the staged candidate record")
    if digest(source.root / "library.json") != record["source_manifest_sha256"]:
        raise ValueError("source manifest changed since compose")
    target = inf.Library(farm / "_library" / theater)
    by_page = {}
    for key, entry in record["frames"].items():
        if not entry["accepted"] or key in exclude:
            continue
        metrics = entry["metrics"]
        if (not silhouette_passes(metrics, record.get("silhouette_reference", "legacy"), record["min_sil"])
                or metrics["body_iou"] < record["min_body"]
                or (metrics["original_remap_pixels"] == 0 and metrics["remap_pixels"] != 0)):
            raise ValueError(f"candidate violates recorded quality thresholds: {key}")
        sprite, index = entry["sprite"], entry["index"]
        a, b = source.frames(sprite)[index], target.frames(sprite)[index]
        if a != entry["source_frame"] or a["rect"][2:] != b["rect"][2:] or a.get("offset") != b.get("offset"):
            raise ValueError(f"frame layout differs: {key}")
        src_idx, dst_idx = source.frame1(sprite, index)[3], target.frame1(sprite, index)[3]
        used = np.unique(src_idx[src_idx > 0])
        if not np.array_equal(src_idx, dst_idx) or not np.array_equal(
                source.palette(source.data["sprites"][sprite]["palette"])[used],
                target.palette(target.data["sprites"][sprite]["palette"])[used]):
            raise ValueError(f"indexed pixels or used opaque palette differ: {key}")
        if not np.array_equal(source.scheme("Red"), target.scheme("Red")):
            raise ValueError("source and target remap ramps differ")
        for kind, filename in entry["files"].items():
            if Path(filename).name != filename or digest(staged / filename) != entry["sha256"][kind]:
                raise ValueError(f"staged candidate changed: {key}")
        by_page.setdefault(b["page"], []).append((key, entry, b))
    if not by_page:
        raise ValueError("no accepted frames to publish")
    for page in by_page:
        for filename in (f"sprites-{page}@2x-{suffix}.png", f"sprites-{page}@2x-remap-{suffix}.png"):
            path = target.root / filename
            if path.exists() or path.is_symlink():
                raise ValueError(f"publication filename already exists; use a fresh suffix: {filename}")
    if reserve_bytes < 0:
        raise ValueError("disk reserve cannot be negative")
    estimated = 2 * sum((target.root / target.data["spriteAtlasesHd"][page][kind]).stat().st_size
                        for page in by_page for kind in ("file", "remap"))
    stage_parent = out.parent
    while not stage_parent.exists():
        stage_parent = stage_parent.parent
    free = min(shutil.disk_usage(stage_parent).free, shutil.disk_usage(farm).free)
    if free < reserve_bytes + estimated:
        raise ValueError(f"insufficient disk space: {free} bytes free; estimate {estimated} plus reserve {reserve_bytes}")
    out.mkdir(parents=True, exist_ok=False)
    evidence = {"staged": str(staged.resolve()), "theater": theater, "pages": {}, "excluded_frames": sorted(exclude),
                "disk": {"free_before": free, "estimated_bytes": estimated, "reserve_bytes": reserve_bytes}}
    for page, entries in sorted(by_page.items()):
        prior = copy.deepcopy(target.data["spriteAtlasesHd"][page])
        before, before_paint = target.page2(page), target.remap2(page)
        if before.shape != (prior["height"], prior["width"], 4) or before_paint.shape != before.shape[:2]:
            raise ValueError(f"current page image dimensions differ from metadata: {page}")
        color, paint = before.copy(), before_paint.copy()
        touched = np.zeros(paint.shape, bool)
        for key, entry, frame in entries:
            x, y, w, h = frame["rect"]
            crop = np.s_[2 * y:2 * (y + h), 2 * x:2 * (x + w)]
            rgba = np.array(Image.open(staged / entry["files"]["color"]).convert("RGBA"))
            remap = np.array(Image.open(staged / entry["files"]["remap"]).convert("L"))
            if rgba.shape != (2 * h, 2 * w, 4) or remap.shape != (2 * h, 2 * w):
                raise ValueError(f"candidate dimensions differ: {key}")
            indices = target.frame1(entry["sprite"], entry["index"])[3]
            if abs(body_iou(rgba, indices) - entry["metrics"]["body_iou"]) > 1e-6:
                raise ValueError(f"candidate body metric differs: {key}")
            color[crop], paint[crop], touched[crop] = rgba, remap, True
        assert np.array_equal(before[~touched], color[~touched])
        assert np.array_equal(before_paint[~touched], paint[~touched])
        normal = normal_reuse(target.root, page, prior, before, color)
        names = [f"sprites-{page}@2x-{suffix}.png", f"sprites-{page}@2x-remap-{suffix}.png"]
        page_evidence = {"prior": prior, "installed": names, "status": "prepared",
            "frames": [key for key, _, _ in entries], "all_other_pixels_preserved": True,
            "normal_reuse": normal,
            "other_color_sha256": hashlib.sha256(before[~touched].tobytes()).hexdigest(),
            "other_remap_sha256": hashlib.sha256(before_paint[~touched].tobytes()).hexdigest()}
        evidence["pages"][str(page)] = page_evidence
        # A prepared journal also permits recovery if the process exits between CAS and the next journal write:
        # compare the current manifest with these exact old/new filenames before retrying with a fresh suffix.
        write_json(out / "installed.json", evidence)
        for filename, pixels in zip(names, (color, paint)):
            save_image(out / filename, pixels)

        def patch(data):
            current = data["spriteAtlasesHd"][page]
            if current != prior or any(data["sprites"][entry["sprite"]]["frames"][entry["index"]] != frame
                                       for _, entry, frame in entries):
                raise ValueError(f"concurrent page change: {theater} page {page}; rebase with a fresh suffix")
            if normal_entry(target.root, page) != (normal["entry"] if normal else None):
                raise ValueError(f"concurrent normal entry change: {theater} page {page}")
            if normal and digest(target.root / normal["entry"]["file"]) != normal["file_sha256"]:
                raise ValueError(f"normal PNG changed during publication: {theater} page {page}")
            # Reserve and install filenames while holding the same manifest lock as CAS. An earlier unlocked
            # existence check alone cannot prevent a same-suffix contender from replacing an already served PNG.
            for filename in names:
                path = target.root / filename
                if path.exists() or path.is_symlink():
                    raise ValueError(f"publication filename already exists; use a fresh suffix: {filename}")
            for filename in names:
                cache_farm.install_file(farm, f"_library/{theater}/{filename}", out / filename)
            current.update(file=names[0], remap=names[1])

        try:
            cache_farm.patch_json(farm, f"_library/{theater}/library.json", patch)
        except Exception:
            page_evidence["status"] = "publication-failed"
            write_json(out / "installed.json", evidence)
            raise
        page_evidence["status"] = "published"
        write_json(out / "installed.json", evidence)
        if normal:
            def rebind(normals):
                entry = normals.get("pages", {}).get(str(page))
                current_library = json.loads((target.root / "library.json").read_text())
                expected = dict(prior, file=names[0], remap=names[1])
                if current_library["spriteAtlasesHd"][page] != expected:
                    raise ValueError(f"colour page changed before normal rebind: {theater} page {page}")
                if entry != normal["entry"] or digest(target.root / entry["file"]) != normal["file_sha256"]:
                    raise ValueError(f"concurrent normal change after colour publication: {theater} page {page}")
                entry["atlas"] = names[0]

            try:
                cache_farm.patch_json(farm, f"_library/{theater}/normals.json", rebind)
            except Exception:
                page_evidence["status"] = "published-normal-bind-failed"
                write_json(out / "installed.json", evidence)
                raise
            page_evidence["status"] = "normals-bound"
            write_json(out / "installed.json", evidence)
        installed = inf.Library(target.root)
        for _, entry, frame in entries:
            x, y, w, h = frame["rect"]
            crop = np.s_[2 * y:2 * (y + h), 2 * x:2 * (x + w)]
            if (not np.array_equal(installed.page2(page)[crop], color[crop])
                    or not np.array_equal(installed.remap2(page)[crop], paint[crop])):
                raise ValueError("published crop differs on readback")
        page_evidence["status"] = "verified"
        page_evidence["installed_bytes"] = sum((out / name).stat().st_size for name in names)
        write_json(out / "installed.json", evidence)
    evidence["disk"].update(actual_bytes=sum(page["installed_bytes"] for page in evidence["pages"].values()),
                            free_after=min(shutil.disk_usage(out).free, shutil.disk_usage(farm).free))
    write_json(out / "installed.json", evidence)
    return evidence


def parser():
    ap = argparse.ArgumentParser(description=__doc__)
    commands = ap.add_subparsers(dest="command", required=True)
    sub = commands.add_parser("snapshot")
    sub.add_argument("--work", type=Path, required=True)
    sub.add_argument("--out", type=Path, required=True)
    sub.add_argument("--names", type=inf.csv_names, required=True)
    sub = commands.add_parser("compose")
    for name in ("source", "snapshot", "out"):
        sub.add_argument("--" + name, type=Path, required=True)
    sub.add_argument("--min-sil", type=inf.unit_interval, default=0.6)
    sub.add_argument("--min-body", type=inf.unit_interval, default=0.0)
    sub.add_argument("--silhouette-reference", choices=("legacy", "indexed"), default="legacy")
    sub.add_argument("--source-remap", type=inf.csv_names, default=(),
                     help="optional sprite or sprite#frame names whose model paint is limited to source support")
    sub.add_argument("--edges", type=Path, help="JSON mapping sprite or sprite#frame names to remap edge lo/hi pairs")
    sub.add_argument("--paint-values", type=Path,
                     help="optional JSON mapping sprite or sprite#frame names to paint gamma/outside-floor pairs")
    inf.add_compose_options(sub)
    sub = commands.add_parser("publish")
    for name in ("source", "staged", "farm", "out"):
        sub.add_argument("--" + name, type=Path, required=True)
    sub.add_argument("--theater", required=True)
    sub.add_argument("--suffix", required=True)
    sub.add_argument("--reserve-gib", type=float, default=4, help="free disk space to retain beyond the batch estimate")
    sub.add_argument("--exclude-frames", type=inf.csv_names, default=(), help="review quarantine; never overrides a gate")
    return ap


def main(argv=None):
    ap = parser()
    args = ap.parse_args(argv)
    try:
        if args.command == "snapshot":
            result = snapshot(args.work, args.out, args.names)
        elif args.command == "compose":
            opts = argparse.Namespace(**{key: getattr(args, key) for key in inf.COMPOSE_DEFAULTS})
            edges = json.loads(args.edges.read_text()) if args.edges else {}
            paint_values = json.loads(args.paint_values.read_text()) if args.paint_values else {}
            for value in edges.values():
                inf.edge_pair(",".join(map(str, value)))
            result = compose(inf.Library(args.source), args.snapshot, args.out, opts,
                             args.min_sil, args.min_body, edges, paint_values,
                             args.silhouette_reference, args.source_remap)
        else:
            result = publish(inf.Library(args.source), args.staged, args.farm, args.theater, args.out, args.suffix,
                             int(args.reserve_gib * 1024 ** 3), args.exclude_frames)
        print(json.dumps({"command": args.command, "frames": len(result.get("frames", {})),
                          "sheets": len(result.get("sheets", {})), "pages": len(result.get("pages", {}))}))
        return 0
    except (ValueError, OSError, KeyError) as error:
        ap.error(str(error))


if __name__ == "__main__":
    raise SystemExit(main())
