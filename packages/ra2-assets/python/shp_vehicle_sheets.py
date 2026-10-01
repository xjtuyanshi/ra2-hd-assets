#!/usr/bin/env python3
"""Prepare and compose SHP vehicle redraw sheets without invoking an image model.

Reuse the unchanged infantry sheet image pipeline; only frame policy, prompts, stage orchestration and cache-farm
installation differ. All derived art belongs outside Git. --library is the cache root, not its theater directory.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import re
import tempfile

import numpy as np
from PIL import Image

import infantry_sheets as inf

# Per-unit prompt profiles. DRON keeps the exact L4 wording; sea creatures get organic materials instead of steel.
PROFILES = {
    "DRON": {
        "house": "DarkRed",
        "desc": "Soviet terror drone: a small four-legged spider robot with a round armoured body/eye, "
                "thin articulated metal legs, house-coloured (red) panels and dark steel",
        "subject": "robot",
        "sequences": {"Stand": "standing ready", "Walk": "a six-step walking cycle", "Fire": "a leaping attack cycle"},
        "material": "physically based dark steel, subtle metal highlights, armoured plates, mechanical joints and "
                    "restrained wear",
        "forbid": "Do not turn the robot into a living spider.",
        "parts": "Preserve all four legs, their lengths, angles, thin articulated joints, the round armoured body and eye.",
        "colour": "House-painted panels stay red (DarkRed); dark steel stays dark.",
    },
    "DLPH": {
        "house": "DarkBlue",
        "desc": "Allied trained dolphin: a sleek grey bottlenose dolphin leaping and swimming at the sea surface, "
                "wearing a house-coloured (blue) sonic emitter pack strapped to its back with a dark harness band",
        "subject": "dolphin",
        "sequences": {"Stand": "idling at the surface", "Walk": "a swimming cycle along the surface",
                      "Fire": "a sonic attack cycle (body raised, beak open)"},
        "material": "realistic wet dolphin skin with a smooth specular sheen, subtle countershading (darker grey back, "
                    "pale belly), fine natural skin texture, believable anatomy and clean white water splashes",
        "forbid": "Do not turn the dolphin into a robot, a fish or a toy.",
        "parts": "Preserve the body length, curve, dorsal fin, flippers, tail flukes, beak, the back-mounted emitter "
                 "pack with its harness band, and any splashes.",
        "colour": "Keep the cool grey dolphin colours; the emitter pack stays house blue (DarkBlue) with small "
                  "metal details; splashes stay white.",
    },
    "SQD": {
        "house": "DarkRed",
        "desc": "Soviet giant squid: a huge squid at the sea surface with a pale pinkish-tan mantle, a house-coloured "
                "(red) armoured collar band around its head and long olive-brown tentacles trailing behind",
        "subject": "squid",
        "sequences": {"Stand": "idling at the surface", "Walk": "a swimming cycle along the surface",
                      "Fire": "an attack cycle (tentacles rise, grab and slam)"},
        "material": "realistic wet cephalopod skin with glossy specular highlights, mottled chromatophore spots, "
                    "fine skin folds, visible suckers on the tentacles and a riveted metal collar band",
        "forbid": "Do not turn the squid into a robot, an octopus cartoon or a toy.",
        "parts": "Preserve the mantle and its fins, the collar band, every tentacle with its length, curl and position, "
                 "and any splashes.",
        "colour": "Keep the pale pinkish-tan mantle and olive-brown tentacles; the collar band stays house red "
                  "(DarkRed); splashes stay white.",
    },
}
UNITS = {unit: f"vehicle:{unit}" for unit in PROFILES}
HOUSE = {unit: p["house"] for unit, p in PROFILES.items()}
UNIT_DESC = {unit: p["desc"] for unit, p in PROFILES.items()}
SEQUENCES = PROFILES["DRON"]["sequences"]
FACINGS = ("up (away from the camera)", "up-right", "right", "down-right", "down (towards the camera)",
           "down-left", "left", "up-left")
MIN_SCALE = 4


def shp_unit_blocks(unit):
    """Mirror src/live/shpUnits.ts shpUnitBlocks, including zero, nullish defaults and independent start keys."""
    f = max(1, unit.get("facings") or 8)
    keys = unit["frames"]

    def value(key, default):
        v = keys.get(key)
        return default if v is None else v

    walk = max(0, value("WalkFrames", 0))
    stand = max(0, value("StandingFrames", 1))
    fire = max(0, value("FiringFrames", 0))
    return {"facings": f,
            "walk": {"start": value("StartWalkFrame", 0), "count": walk},
            "stand": {"start": value("StartStandFrame", walk * f), "count": stand},
            "fire": {"start": value("StartFiringFrame", (walk + stand) * f), "count": fire}}


def blocks(lib, unit):
    """Only explicit SHP body sequences; never infer extra jobs from the shadow half of a file."""
    t = lib.data["types"][unit]
    if t.get("sprite") != UNITS[unit] or not t.get("shpUnit"):
        raise ValueError(f"{unit} is not the expected SHP vehicle")
    b = shp_unit_blocks(t["shpUnit"])
    n = len(lib.frames(t["sprite"]))
    seen, result = set(), []
    for seq in SEQUENCES:
        start, count = b[seq.lower()]["start"], b[seq.lower()]["count"]
        rows = []
        for facing in range(b["facings"]):
            row = []
            for step in range(count):
                i = start + facing * count + step
                if not 0 <= i < n:
                    raise ValueError(f"{unit} {seq} frame {i} is outside the body atlas")
                if i not in seen:
                    row.append(i)
                    seen.add(i)
            rows.append(row)
        if any(rows):
            result.append((seq, rows))
    if not result:
        raise ValueError(f"{unit} has no body sequences")
    return result


def sheet_specs(lib, unit, min_scale=MIN_SCALE):
    """Prefer every facing on one sheet; split consecutive step ranges before splitting facing blocks.

    min_scale trades redraw resolution for sheet count: large sprites (the giant squid) at 4x would need ~70 sheets.
    Anything >= 2.5x still oversamples the 2x HD atlas.
    """
    specs = []
    sprite = lib.data["types"][unit]["sprite"]

    def fits(rows):
        if not any(rows):
            return False
        lay = inf.layout(lib, sprite, rows)
        try:
            return inf.choose_scale(lay["W"], lay["H"]) >= min_scale
        except ValueError:
            return False

    def add(seq, rows, first, start, end, whole=False):
        suffix = "" if whole else f"_s{start:02d}-{end - 1:02d}_f{first}-{first + len(rows) - 1}"
        specs.append({"name": f"{unit}_{seq}{suffix}", "seq": seq, "rows": rows,
                      "facings": list(range(first, first + len(rows))), "steps": [start, end]})

    for seq, rows in blocks(lib, unit):
        count = max(map(len, rows))
        if fits(rows):
            add(seq, rows, 0, 0, count, whole=True)
            continue
        start = 0
        while start < count:
            end = next((e for e in range(count, start, -1) if fits([r[start:e] for r in rows])), None)
            if end is not None:
                add(seq, [r[start:end] for r in rows], 0, start, end)
            else:
                end = start + 1
                first = 0
                while first < len(rows):
                    if not rows[first][start:end]:
                        first += 1
                        continue
                    last = next((f for f in range(len(rows), first, -1)
                                 if fits([r[start:end] for r in rows[first:f]])), None)
                    if last is None:
                        raise ValueError(f"{unit} {seq} facing {first} cannot fit at {min_scale}x")
                    add(seq, [r[start:end] for r in rows[first:last]], first, start, end)
                    first = last
            start = end
    return specs


def prompt_for(unit, spec, size, facing_count):
    p = PROFILES[unit]
    rows = "\n".join(f"- row {r + 1}: facing {FACINGS[f] if facing_count == 8 else str(f) + ' clockwise from screen-up'}"
                     for r, f in enumerate(spec["facings"]))
    return f"""Edit input.png only, then save output.png at exactly {size[0]}x{size[1]} pixels.

This Red Alert 2 sprite sheet shows {sum(map(len, spec['rows']))} frames of the same {p['desc']}.
The high isometric camera, about 30 degrees from above, must stay fixed. The sequence is {spec['seq']}:
{p['sequences'][spec['seq']]}, zero-based steps {spec['steps'][0]} through {spec['steps'][1] - 1}.
Each row is one facing; columns are consecutive animation steps. SHP vehicles run CLOCKWISE from screen-up:
{rows}

Redraw the entire sheet as a realistic modern high-end RTS remaster: {p['material']}, with consistent soft daylight
from upper left. Keep the original {p['subject']} design immediately recognisable. Keep materials and lighting coherent
between all frames. No cartoon, chibi, toy-like plastic, painting or pixel-art treatment. {p['forbid']}

Strict geometry and colour requirements:
- Keep EVERY frame at exactly its original position and size, with the same pose, facing, silhouette and anchor.
- {p['parts']}
- Do not mirror, rotate, shift, re-space, re-arrange, add or remove frames or parts. Detail stays inside silhouettes.
- Keep the same colours and overall brightness. {p['colour']}
- Preserve any attack effects already present; do not invent weapons, effects, scenery or extra equipment.
- Keep the background flat uniform RGB (118,118,118) everywhere else. No ground, cast shadows, gradients, texture,
  grid, borders, text or labels. Preserve the empty margins and gaps between frames.

Use input.png as the image-editing reference. Return output.png with the exact input dimensions; never crop or pad.
"""


def digest(path):
    with Path(path).open("rb") as src:
        return hashlib.file_digest(src, "sha256").hexdigest()


def write_json(path, data):
    """Replace a directory entry, never write through an existing file symlink or hard link."""
    with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent, delete=False) as out:
        tmp = Path(out.name)
        try:
            json.dump(data, out, indent=2, allow_nan=False)
            out.write("\n")
            out.close()
            os.replace(tmp, path)
        finally:
            tmp.unlink(missing_ok=True)


def write_image(path, array):
    with tempfile.NamedTemporaryFile(dir=path.parent, suffix=".png", delete=False) as out:
        tmp = Path(out.name)
        try:
            out.close()
            Image.fromarray(array).save(tmp)
            os.replace(tmp, path)
        finally:
            tmp.unlink(missing_ok=True)


def outside_source(path, *sources):
    if any(path.resolve().is_relative_to(source.resolve()) for source in sources):
        raise ValueError(f"refusing to write inside source cache: {path}")


def prepare(lib, work, theater, units=None, min_scale=MIN_SCALE):
    units = list(UNITS) if units is None else list(units)
    if not units or set(units) - UNITS.keys():
        raise ValueError(f"supported SHP vehicles: {', '.join(UNITS)}")
    if (work / "prepare.json").exists() or (work / "sheets").exists():
        raise ValueError("work already contains prepared sheets; use a new work directory to preserve existing outputs")
    if not 2 <= min_scale <= 8:
        raise ValueError("min-scale must be between 2 and 8")
    planned = [(unit, spec) for unit in units for spec in sheet_specs(lib, unit, min_scale)]
    jobs = []
    source_hash = digest(lib.root / "library.json")
    for unit, spec in planned:
        sprite = lib.data["types"][unit]["sprite"]
        lay = inf.layout(lib, sprite, spec["rows"])
        scale = inf.choose_scale(lay["W"], lay["H"])
        img = inf.render_input(lib, sprite, lay, HOUSE[unit], scale)
        _, _, ox, oy = inf.canvas_for(lay, scale)
        d = work / "sheets" / spec["name"]
        d.mkdir(parents=True, exist_ok=False)
        write_image(d / "input.png", img)
        job = dict(spec, unit=unit, sprite=sprite, S=scale, house=HOUSE[unit], origin=[ox, oy], layout=lay,
                   size=[img.shape[1], img.shape[0]], theater=theater, source_manifest_sha256=source_hash,
                   input_sha256=digest(d / "input.png"))
        write_json(d / "job.json", job)
        (d / "prompt.txt").write_text(prompt_for(unit, spec, job["size"],
                                               lib.data["types"][unit]["shpUnit"].get("facings") or 8), encoding="utf-8")
        jobs.append(job)
        print(f"{spec['name']}: {sum(map(len, spec['rows']))} frames, {scale:g}x, {job['size'][0]}x{job['size'][1]}",
              flush=True)
    write_json(work / "prepare.json", {"version": 1, "theater": theater, "source_manifest_sha256": source_hash,
                                       "units": units, "sheets": [j["name"] for j in jobs]})
    return jobs


def sheet_dirs(lib, work, theater, names=None, require_output=True):
    prepared = json.loads((work / "prepare.json").read_text(encoding="utf-8"))
    if (prepared["theater"] != theater or prepared["source_manifest_sha256"] != digest(lib.root / "library.json")):
        raise ValueError("prepared jobs belong to a different theater or source manifest")
    dirs = inf.sheet_dirs(work, names)
    if not dirs or {d.name for d in inf.sheet_dirs(work)} != set(prepared["sheets"]):
        raise ValueError("prepared sheet list changed; use the original work directory")
    for d in dirs:
        job = json.loads((d / "job.json").read_text(encoding="utf-8"))
        if job["source_manifest_sha256"] != prepared["source_manifest_sha256"]:
            raise ValueError(f"{d.name}: source manifest changed")
        if job["input_sha256"] != digest(d / "input.png"):
            raise ValueError(f"{d.name}: input.png changed since prepare")
        if require_output:
            with Image.open(d / "output.png") as im:
                if list(im.size) != job["size"]:
                    raise ValueError(f"{d.name}: output.png must be {job['size']}, got {im.size}")
    return dirs


def compose_job(lib, directory, opts, page=None):
    """Reuse registration/colour/alpha/remap unchanged, with output.png as the sole authoritative model result.

    Infantry prefers optional full.png. A temporary read-only link view hides that file, so an old full.png cannot
    silently override a user's newer output.png. No model or subprocess is invoked.
    """
    with tempfile.TemporaryDirectory(prefix="shp-vehicle-compose-") as temp:
        d = Path(temp)
        for name in ("job.json", "input.png", "output.png"):
            (d / name).symlink_to((directory / name).resolve(strict=True))
        return inf.compose_job(lib, d, opts, page=page)


def compose(lib, work, theater, opts, names=None):
    for d in sheet_dirs(lib, work, theater, names):
        result = compose_job(lib, d, opts)
        with tempfile.TemporaryDirectory(prefix=".review-", dir=d) as temp:
            review = Path(temp) / "review.png"
            inf.review(lib, result, review)
            os.replace(review, d / "review.png")
        metrics = {i: r["metrics"] for i, r in result["frames"].items()}
        write_json(d / "metrics.json", metrics)
        print(f"{d.name}: {len(metrics)} frames, min silhouette IoU {min(m['sil_iou'] for m in metrics.values()):.3f}",
              flush=True)


def build(lib, work, theater, opts, names=None, min_sil=0.6):
    dirs = sheet_dirs(lib, work, theater, names)
    jobs = [json.loads((d / "job.json").read_text(encoding="utf-8")) for d in dirs]
    pages = sorted({lib.frames(j["sprite"])[p["frame"]]["page"] for j in jobs for p in j["layout"]["place"]})
    out = work / "pages"
    out.mkdir(exist_ok=True)
    # A failed rebuild must not leave a previous successful build available for installation.
    (out / "build.json").unlink(missing_ok=True)
    report = {"version": 1, "theater": theater, "source_manifest_sha256": digest(lib.root / "library.json"),
              "options": {k: getattr(opts, k) for k in inf.COMPOSE_DEFAULTS}, "min_sil": min_sil,
              "pages": {}, "accepted": 0, "rejected": 0,
              "inputs": {d.name: {name: digest(d / name) for name in ("job.json", "input.png", "output.png")}
                         for d in dirs}}
    for page in pages:
        colour, paint = lib.page2(page).copy(), lib.remap2(page).copy()
        frames = []
        seen = set()
        for d, job in zip(dirs, jobs):
            if not any(lib.frames(job["sprite"])[p["frame"]]["page"] == page for p in job["layout"]["place"]):
                continue
            result = compose_job(lib, d, opts, page=page)
            for i, r in result["frames"].items():
                key = (job["sprite"], i)
                if key in seen:
                    raise ValueError(f"duplicate prepared frame: {key}")
                seen.add(key)
                frame = lib.frames(job["sprite"])[i]
                accepted = r["metrics"]["sil_iou"] >= min_sil
                report["accepted" if accepted else "rejected"] += 1
                frames.append({"sprite": key[0], "frame": i, "rect": frame["rect"], "accepted": accepted,
                               "sheet": d.name, "metrics": r["metrics"]})
                if accepted:
                    x, y, w, h = frame["rect"]
                    crop = np.s_[2 * y:2 * (y + h), 2 * x:2 * (x + w)]
                    colour[crop], paint[crop] = r["rgba"], r["paint"]
        files = {"file": f"sprites-{page}@2x-l3veh.png", "remap": f"sprites-{page}@2x-remap-l3veh.png"}
        write_image(out / files["file"], colour)
        write_image(out / files["remap"], paint)
        report["pages"][str(page)] = dict(files, frames=frames,
                                         sha256={k: digest(out / v) for k, v in files.items()})
    write_json(out / "report.json", report)
    if report["rejected"] or not report["accepted"]:
        raise ValueError(f"build rejected {report['rejected']} frames; review pages/report.json and redraw failed sheets")
    write_json(out / "build.json", report)
    print(f"Built {len(pages)} HD pages, {report['accepted']} accepted body frames", flush=True)
    return report


def materialize_directory(path, seed, *protected):
    """Detach only this symlinked directory, keeping its children as links to their previous entries."""
    outside_source(path.parent, *protected)
    if path.is_symlink():
        old_link = os.readlink(path)
        previous = path.resolve(strict=True)
        if not previous.is_dir():
            raise ValueError(f"not a directory: {path}")
        with tempfile.TemporaryDirectory(prefix=".shp-farm-", dir=path.parent) as temp:
            replacement = Path(temp) / "directory"
            replacement.mkdir()
            for child in previous.iterdir():
                (replacement / child.name).symlink_to(child)
            path.unlink()
            try:
                os.replace(replacement, path)
            except BaseException:
                path.symlink_to(old_link)
                raise
    else:
        path.mkdir(parents=True, exist_ok=True)
    outside_source(path, *protected)
    for child in seed.iterdir():
        target = path / child.name
        if not target.exists() and not target.is_symlink():
            target.symlink_to(child)


def install(lib, source_root, work, theater, variant_root):
    """Merge accepted body rectangles into current variant pages, preserving other tracks on shared pages."""
    report = json.loads((work / "pages/build.json").read_text(encoding="utf-8"))
    if (report["theater"] != theater or report["source_manifest_sha256"] != digest(lib.root / "library.json")
            or report["rejected"] or not report["accepted"]):
        raise ValueError("build is incomplete or belongs to a different source library")
    for name, files in report["inputs"].items():
        for filename, sha in files.items():
            if digest(work / "sheets" / name / filename) != sha:
                raise ValueError("a sheet changed since build; rebuild before installing")
    for page in report["pages"].values():
        for key in ("file", "remap"):
            if Path(page[key]).name != page[key] or digest(work / "pages" / page[key]) != page["sha256"][key]:
                raise ValueError("built page changed; rebuild before installing")
    # Resolve ancestors but keep the final entry lexical: it may itself be a cache-root symlink to detach.
    root = variant_root.absolute().parent.resolve() / variant_root.name
    protected = (source_root, lib.root)
    outside_source(root.parent, *protected)
    if any(root == p or p.is_relative_to(root) for p in protected):
        raise ValueError("variant root must be separate from the source cache")
    current_dir = root / "_library" / theater
    manifest = current_dir / "library.json"
    merged = json.loads((manifest if manifest.is_file() else lib.root / "library.json").read_text(encoding="utf-8"))
    for page_id, page in report["pages"].items():
        for f in page["frames"]:
            if merged["sprites"][f["sprite"]]["frames"][f["frame"]] != lib.frames(f["sprite"])[f["frame"]]:
                raise ValueError("variant uses a different atlas layout")
        original, current = lib.data["spriteAtlasesHd"][int(page_id)], merged["spriteAtlasesHd"][int(page_id)]
        if any(original.get(k) != current.get(k) for k in ("scale", "width", "height")):
            raise ValueError("variant uses different HD page dimensions")
    root.parent.mkdir(parents=True, exist_ok=True)
    materialize_directory(root, source_root, *protected)
    materialize_directory(root / "_library", source_root / "_library", *protected)
    materialize_directory(current_dir, lib.root, *protected)
    for page_id, page in report["pages"].items():
        current = merged["spriteAtlasesHd"][int(page_id)]
        for key, mode in (("file", "RGBA"), ("remap", "L")):
            with Image.open(current_dir / current[key]) as im:
                target = np.array(im.convert(mode))
            with Image.open(work / "pages" / page[key]) as im:
                patch = np.array(im.convert(mode))
            if target.shape != patch.shape:
                raise ValueError("variant HD image dimensions differ from built page")
            for f in page["frames"]:
                if f["accepted"]:
                    x, y, w, h = f["rect"]
                    crop = np.s_[2 * y:2 * (y + h), 2 * x:2 * (x + w)]
                    target[crop] = patch[crop]
            write_image(current_dir / page[key], target)
            current[key] = page[key]
    write_json(current_dir / "library.json", merged)
    print(f"Installed {report['accepted']} body frames into {current_dir}", flush=True)


def parser():
    ap = argparse.ArgumentParser(description=__doc__)
    commands = ap.add_subparsers(dest="command", required=True)
    for command in ("prepare", "compose", "build", "install"):
        sub = commands.add_parser(command)
        sub.add_argument("--library", type=Path, required=True, help="source cache root (read-only)")
        sub.add_argument("--theater", required=True, help="theater directory below _library, e.g. urban")
        sub.add_argument("--work", type=Path, required=True)
        if command == "prepare":
            sub.add_argument("--units", type=inf.csv_names, default=list(UNITS))
            sub.add_argument("--min-scale", type=float, default=MIN_SCALE)
        if command in ("compose", "build"):
            sub.add_argument("--names", type=inf.csv_names)
            inf.add_compose_options(sub)
        if command == "build":
            sub.add_argument("--min-sil", type=float, default=0.6)
        if command == "install":
            sub.add_argument("--variant-root", type=Path, required=True)
    return ap


def main(argv=None):
    ap = parser()
    opts = ap.parse_args(argv)
    try:
        if not re.fullmatch(r"[A-Za-z0-9_-]+", opts.theater):
            raise ValueError("theater must be one directory name")
        source = opts.library.resolve(strict=True)
        outside_source(opts.work, source)
        lib = inf.Library((source / "_library" / opts.theater).resolve(strict=True))
        # The theater directory can itself be linked outside the cache root.
        destinations = [opts.work, opts.work / "sheets", opts.work / "pages"]
        if (opts.work / "sheets").is_dir():
            destinations.extend(p for p in (opts.work / "sheets").iterdir() if p.is_dir())
        for path in destinations:
            outside_source(path, source, lib.root)
        if opts.command in ("compose", "build"):
            for key in inf.COMPOSE_DEFAULTS:
                v = getattr(opts, key)
                if key != "paint" and (not math.isfinite(v) or v < 0):
                    raise ValueError(f"{key} must be finite and non-negative")
            if any(getattr(opts, k) > 1 for k in ("lock_l", "lock_ab", "edge_mix", "shadow_alpha")):
                raise ValueError("colour/edge/shadow weights must be between 0 and 1")
        if opts.command == "prepare":
            prepare(lib, opts.work, opts.theater, opts.units, opts.min_scale)
        elif opts.command == "compose":
            compose(lib, opts.work, opts.theater, opts, opts.names)
        elif opts.command == "build":
            if not 0 <= opts.min_sil <= 1:
                raise ValueError("min-sil must be between 0 and 1")
            build(lib, opts.work, opts.theater, opts, opts.names, opts.min_sil)
        else:
            install(lib, source, opts.work, opts.theater, opts.variant_root)
        return 0
    except (OSError, ValueError, KeyError, IndexError) as error:
        ap.error(str(error))


if __name__ == "__main__":
    raise SystemExit(main())
