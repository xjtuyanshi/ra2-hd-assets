#!/usr/bin/env python3
"""Redraw native effect flipbooks, then recover premultiplied HD atlas frames.

``sheets`` reads effects.json, indexed atlas pages and palettes/anim.png from an
effect sidecar directory. Each animation uses one union bounding box, integer
upscaling and a grid on flat grey (118, 118, 118). Layout-locked prompts preserve
the native motion and optionally match an approved sibling animation's style.
``run`` invokes the Codex image-editing agent in each sheet directory, with at
most --concurrency calls alive. Sheets of an animation run in order; each uses
the previous output (or its first sheet's sibling) as reference_previous.png.
``pack`` cuts the redraw using layout.json, estimates grey from the cell border,
and uses the native footprint to separate coverage from emitted light. It
resamples premultiplied linear RGB and coverage to 2 or 3 HD texels per native
pixel, stores the colour sRGB-encoded, and shelf-packs effects-hd.json and PNGs
for EffectHdLibrary. Do not unpremultiply: light may have colour at zero alpha.

Job JSON is a list of {anim, kind, chunks: [[first, last], ...], scale, cols,
sibling?}. Frame ranges are inclusive; sibling names a sheet directory, e.g.
S_BANG34_0. The bundled list records the final scratch batches: EXPLOLB is blue
energy with no orange sibling, and FIREPOWR (the Firepower crate icon) is omitted.
Unlisted native frames remain null. Earlier approved pilot sheets can be passed
to pack with --extra-sheets; their layout.json supplies the animation and indices.

Completed calls (exit 0 and a readable output.png) are reused. Failed calls stop
new launches and can be retried by running again. Usage/rate limits create
LIMIT_HIT.txt in the jobs directory (or --limit-file); active calls finish, but
no new calls start. Remove that file explicitly before resuming. Exit codes are
0 for success, 1 for failure, and 2 for a limit stop or invalid arguments.

Everything read or written is derived game art and must stay in gameres/ or
another untracked directory; never commit images, sidecars, job runs or atlases.
The checked-in job definitions and this source contain no game art. Dependencies:
numpy, Pillow and opencv-python. No game files or models are downloaded.

Example (all artifact paths are untracked):
  python3 effect_flipbooks.py sheets --effects gameres/hd-cache/_library/common/effects --jobs-dir gameres/fx-jobs
  python3 effect_flipbooks.py run --jobs-dir gameres/fx-jobs --concurrency 2
  python3 effect_flipbooks.py pack --effects gameres/hd-cache/_library/common/effects --jobs-dir gameres/fx-jobs --out gameres/effects-hd
Use --jobs to supply a different job JSON to each subcommand; --codex defaults
to codex on PATH. Extra approved sheets are read before the configured sheets,
so a configured redraw wins if both contain the same frame.
"""

from __future__ import annotations

import argparse
from dataclasses import dataclass
import json
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import time

import cv2
import numpy as np
from PIL import Image

GREY = 118
DEFAULT_JOBS = Path(__file__).with_name("effect_flipbooks_jobs.json")

KIND = {
    "blueexp": (
        "a blue energy explosion animation (a burst of blue-white energy with flying dark debris; this effect is BLUE in the original and must stay blue: it is NOT a fire)",
        "- energy: a blinding white-hot core, electric blue and cyan energy with a faint violet fringe, fine crackling filaments and a soft blue glow haze; NO orange, NO yellow, NO red fire anywhere;\n"
        "- debris: the small dark specks are small dark tumbling fragments, a few with tiny blue-white glowing sparks; faint grey-blue smoke where the original has grey;",
    ),
    "explosion": (
        "an explosion animation (a shell or vehicle explosion: a fireball that grows, then turns into rolling smoke with flying debris)",
        "- fire: a blinding white-hot core in the first frames, then bright yellow, orange, and DEEP RED / crimson flame edges and tongues, with real turbulent, billowing fluid-simulation detail (curling flame licks, bright filaments, darker cooler pockets);\n"
        "- smoke: dark charcoal and black rolling smoke with soft volumetric shading, lit on its upper-left side by daylight and glowing orange-red from the fire underneath where it touches the flames; as the frames progress the fire shrinks and the smoke takes over;\n"
        "- debris: where the original has small dark specks, draw small dark tumbling fragments and a few bright glowing embers and sparks;",
    ),
    "fire": (
        "a looping burning-fire animation (flames rising from a burning object)",
        "- flames: realistic turbulent flames, white-yellow at the hot base, bright yellow, orange, and deep red / crimson flame tips, curling tongues with fine filaments, a few glowing embers above; faint dark smoke wisps at the tips;",
    ),
    "tesla": (
        "an electric discharge animation (a Tesla coil bolt striking the ground: a burst of electric arcs, then crackling arcs that fade)",
        "- electricity: blinding white-hot arc cores surrounded by electric blue and cyan glow with a faint violet fringe, sharp branching lightning filaments, small bright sparks, a soft blue glow haze;",
    ),
    "muzzle": (
        "a gun muzzle-flash animation",
        "- muzzle flash: a white-hot centre, yellow and orange flame petals with sharp star-like streaks, a little grey smoke as it fades;",
    ),
    "impact": (
        "a small bullet-impact animation (machine-gun rounds hitting the ground: tiny bright sparks and a little puff of dirt)",
        "- impact: tiny white-hot and yellow sparks and short spark streaks flying out, a few small glowing orange flecks, a tiny puff of brownish-grey dust and dirt; small and crisp, no big fireball;",
    ),
    "plasma": (
        "an electric explosion animation (a Tesla weapon destroying something: a blue-white plasma fireball with blue and violet electric flames, then white electric arcs crackling over the ground as it fades)",
        "- plasma: a blinding white-hot core, electric blue and cyan plasma flames with violet tips and fine turbulent filaments, a soft blue glow haze; the white zig-zag marks are crackling white-hot electric arcs with a thin blue glow; a few small bright blue-white sparks;",
    ),
}


def prompt(kind, n, cols, rows, first, last, total, size, prev=False, sibling=False):
    desc, style = KIND[kind]
    ref = (
        (
            "\nThere is also reference_previous.png: the already redrawn PREVIOUS frames of this same animation (approved). "
            "Treat it as the style reference: match its look exactly (same colours, same lighting, same fire, smoke, spark and debris style, same level of detail), "
            "so that these frames continue that animation seamlessly. Do not copy its layout; the layout comes from input.png.\n"
        )
        if prev
        else ""
    )
    if sibling:
        ref = (
            "\nThere is also reference_previous.png: the already redrawn frames of a SIBLING animation from the same game (the same kind of effect at another size; approved). "
            "Treat it only as the style reference: match its look (same colours, same lighting, same fire, smoke, spark and debris style, same level of realism), "
            "so that both animations look like one consistent game. Do not copy its layout or shapes; the layout and every shape come from input.png.\n"
        )
    return f"""Task: image editing only. Do not write code other than what is needed to save/resize the image. Do not browse the web.

In this directory there is input.png ({size[0]}x{size[1]} pixels): a flipbook sheet of {n} consecutive frames (frames {first}..{last} of {total}) of {desc} from the classic 2000 isometric real-time-strategy game Command & Conquer: Red Alert 2 (original low-resolution pixel art, smoothly upscaled). The frames are laid out in a {cols}x{rows} grid, in reading order (left to right, then top to bottom), each frame in its own cell on a flat grey (118,118,118) background.

{ref}
Use your image generation / image editing tool with input.png as the reference image to redraw EVERY cell as the same frame of a REALISTIC modern-game visual effect, like a high-end volumetric fluid-simulation render used in a modern 3D remaster. This is a private, personal fan remaster; the effect must stay recognisably the same Red Alert 2 animation.

LAYOUT LOCK (most important):
- keep the grid: every cell's effect stays exactly where it is, with the same size, the same overall silhouette and footprint, the same proportions of fire / smoke / empty space, and the same progression from cell to cell; do not merge, move, rescale or reorder cells; empty areas stay empty;
- consecutive cells are consecutive frames of ONE continuous animation: keep the look consistent from cell to cell (same lighting, same palette, same level of detail), so that playing the cells in order looks like smooth, coherent motion;
- keep the flat grey (118,118,118) background everywhere outside the effect (no ground, no shadow, no scene, no vignette, no grid lines, no borders, no text, no numbers, no watermark).

STYLE:
{style}
- keep small details small: debris fragments and sparks stay about as small as the specks in the reference;
- realistic, crisp, high-resolution, physically plausible light and colour; rich colour range; NOT cartoon, NOT cel-shaded, NOT pixel art, NOT flat blobs.

Save the result as output.png in this directory with exactly {size[0]}x{size[1]} pixels (if the tool returns another size, resize the whole generated image to exactly {size[0]}x{size[1]}; keep the whole sheet visible, never crop). Then reply with one line saying the tool used and the generated size before resizing.
"""


class EffectLibrary:
    """Native palette-indexed effect sidecar, with instance-local page caches."""

    def __init__(self, directory: Path):
        self.directory = Path(directory)
        self.data = json.loads((self.directory / "effects.json").read_text(encoding="utf-8"))
        self.pages: dict[int, np.ndarray] = {}
        with Image.open(self.directory / "palettes/anim.png") as im:
            self.palette = np.array(im.convert("RGB"))[0]

    def page(self, index: int) -> np.ndarray:
        if index not in self.pages:
            with Image.open(self.directory / self.data["spriteAtlases"][index]["file"]) as im:
                self.pages[index] = np.array(im)
        return self.pages[index]

    def sprite(self, anim: str) -> tuple[dict, dict]:
        entry = self.data["anims"][anim]
        return entry, self.data["sprites"][entry["sprite"]]

    def frame_indices(self, anim: str) -> list[np.ndarray]:
        """Canvas-sized index images; index 0 is transparent, offsets are native pixels."""
        _, spr = self.sprite(anim)
        cw, ch = spr["canvas"]
        frames = []
        for frame in spr["frames"]:
            img = np.zeros((ch, cw), np.uint8)
            x, y, w, h = frame["rect"]
            if w > 0:
                ox, oy = frame["offset"]
                # Offset is relative to the canvas centre, rounded down for odd canvas sizes.
                px, py = cw // 2 + ox, ch // 2 + oy
                src = self.page(frame.get("page", 0))[y : y + h, x : x + w]
                img[py : py + h, px : px + w] = np.where(src > 0, src, img[py : py + h, px : px + w])
            frames.append(img)
        return frames


def load_jobs(path: Path) -> list[dict]:
    """Validate portable directory names, inclusive ranges and one ordered sequence per anim."""
    jobs = json.loads(Path(path).read_text(encoding="utf-8"))
    if not isinstance(jobs, list) or not jobs:
        raise ValueError("jobs must be a nonempty JSON list")
    names = set()
    for job in jobs:
        if not isinstance(job, dict) or not {"anim", "kind", "chunks", "scale", "cols"} <= job.keys():
            raise ValueError("each job requires anim, kind, chunks, scale and cols")
        name = job["anim"]
        if not isinstance(name, str) or not re.fullmatch(r"[A-Za-z0-9_-]+", name) or name in names:
            raise ValueError(f"invalid or duplicate animation name: {name!r}")
        names.add(name)
        if not isinstance(job["kind"], str) or job["kind"] not in KIND:
            raise ValueError(f"{name}: unknown effect kind {job['kind']!r}")
        for key in ("scale", "cols"):
            if type(job[key]) is not int or job[key] < 1:
                raise ValueError(f"{name}: {key} must be a positive integer")
        if not isinstance(job["chunks"], list) or not job["chunks"]:
            raise ValueError(f"{name}: chunks must be a nonempty list")
        previous = -1
        for chunk in job["chunks"]:
            if (
                not isinstance(chunk, list)
                or len(chunk) != 2
                or any(type(v) is not int for v in chunk)
                or not previous < chunk[0] <= chunk[1]
            ):
                raise ValueError(f"{name}: chunks must be ordered, nonoverlapping inclusive ranges")
            previous = chunk[1]
        sibling = job.get("sibling")
        if sibling is not None and (
            not isinstance(sibling, str) or not re.fullmatch(r"[A-Za-z0-9_-]+_[0-9]+", sibling)
        ):
            raise ValueError(f"{name}: sibling must name a sheet directory, e.g. S_BANG34_0")
    return jobs


def frame_rgba(idx: np.ndarray, palette: np.ndarray) -> np.ndarray:
    return np.dstack([palette[idx], (idx > 0).astype(np.uint8) * 255])


def union_bbox(indices: list[np.ndarray], pad: int = 4) -> tuple[int, int, int, int]:
    mask = np.zeros_like(indices[0], bool)
    for idx in indices:
        mask |= idx > 0
    ys, xs = np.nonzero(mask)
    h, w = mask.shape
    if len(xs) == 0:
        return 0, 0, w, h
    return (
        max(0, int(xs.min()) - pad),
        max(0, int(ys.min()) - pad),
        min(w, int(xs.max()) + 1 + pad),
        min(h, int(ys.max()) + 1 + pad),
    )


def make_sheet(
    anim: str,
    indices: list[np.ndarray],
    palette: np.ndarray,
    frames: list[int],
    scale: int = 3,
    cols: int = 3,
    gap: int = 24,
    bbox: tuple[int, int, int, int] | None = None,
) -> tuple[Image.Image, dict]:
    """Pure sheet/layout construction; the union covers ALL native frames, including other chunks."""
    if not frames or scale < 1 or cols < 1 or gap < 0:
        raise ValueError("sheets require frames, positive scale/cols and a nonnegative gap")
    bbox = tuple(int(v) for v in (bbox or union_bbox(indices)))
    x0, y0, x1, y1 = bbox
    cw, ch = (x1 - x0) * scale, (y1 - y0) * scale
    rows = (len(frames) + cols - 1) // cols
    width, height = cols * cw + (cols + 1) * gap, rows * ch + (rows + 1) * gap
    sheet = Image.new("RGB", (width, height), (GREY, GREY, GREY))
    cells = []
    for k, frame in enumerate(frames):
        rgba = frame_rgba(indices[frame], palette)[y0:y1, x0:x1]
        alpha = rgba[..., 3:4] / 255.0
        comp = (rgba[..., :3] * alpha + GREY * (1 - alpha)).astype(np.uint8)
        im = Image.fromarray(comp).resize((cw, ch), Image.Resampling.LANCZOS)
        cx, cy = gap + (k % cols) * (cw + gap), gap + (k // cols) * (ch + gap)
        sheet.paste(im, (cx, cy))
        cells.append({"frame": frame, "x": cx, "y": cy, "w": cw, "h": ch})
    layout = {"anim": anim, "bbox": list(bbox), "scale": scale, "size": [width, height], "cells": cells}
    return sheet, layout


def write_sheets(library: EffectLibrary, jobs: list[dict], jobs_dir: Path) -> None:
    for job in jobs:
        anim = job["anim"]
        entry, _ = library.sprite(anim)
        indices = library.frame_indices(anim)
        for k, (first, last) in enumerate(job["chunks"]):
            if last >= len(indices):
                raise ValueError(f"{anim}: frame {last} is outside the native frame list ({len(indices)})")
            directory = jobs_dir / f"{anim}_{k}"
            frames = list(range(first, last + 1))
            sheet, layout = make_sheet(anim, indices, library.palette, frames, job["scale"], job["cols"])
            cells = layout["cells"]
            text = prompt(
                job["kind"],
                len(frames),
                len({c["x"] for c in cells}),
                len({c["y"] for c in cells}),
                first,
                last,
                entry["frameCount"],
                layout["size"],
                prev=k > 0,
                sibling=k == 0 and bool(job.get("sibling")),
            )
            directory.mkdir(parents=True, exist_ok=True)
            sheet.save(directory / "input.png")
            (directory / "layout.json").write_text(json.dumps(layout, indent=1), encoding="utf-8")
            (directory / "prompt.txt").write_text(text, encoding="utf-8")
            print(directory.name, sheet.size)


@dataclass(frozen=True)
class SheetJob:
    directory: Path
    reference: Path | None


def sheet_jobs(jobs: list[dict], jobs_dir: Path) -> list[SheetJob]:
    """Build dependencies before launching anything; external siblings are approved existing outputs."""
    tasks = []
    for job in jobs:
        previous = jobs_dir / job["sibling"] if job.get("sibling") else None
        for k, (first, last) in enumerate(job["chunks"]):
            directory = jobs_dir / f"{job['anim']}_{k}"
            layout = json.loads((directory / "layout.json").read_text(encoding="utf-8"))
            if (
                layout["anim"] != job["anim"]
                or layout["scale"] != job["scale"]
                or [c["frame"] for c in layout["cells"]] != list(range(first, last + 1))
            ):
                raise ValueError(f"{directory}: layout differs from jobs JSON; run sheets first")
            for filename in ("input.png", "prompt.txt"):
                if not (directory / filename).is_file():
                    raise ValueError(f"{directory}: missing {filename}; run sheets first")
            tasks.append(SheetJob(directory, previous))
            previous = directory
    dependencies = {task.directory: task.reference for task in tasks}
    checked = set()
    for directory in dependencies:
        chain = set()
        current = directory
        while current in dependencies and current not in checked:
            if current in chain:
                raise ValueError(f"cyclic sheet reference: {current}")
            chain.add(current)
            current = dependencies[current]
        if current is not None and current not in dependencies and not readable_output(current):
            raise ValueError(f"missing approved sibling output: {current / 'output.png'}")
        checked.update(chain)
    return tasks


def readable_output(directory: Path) -> bool:
    try:
        with Image.open(directory / "output.png") as im:
            im.verify()
        return True
    except (OSError, ValueError, SyntaxError):
        return False


def done(directory: Path) -> bool:
    try:
        return (directory / "exit").read_text().strip() == "0" and readable_output(directory)
    except FileNotFoundError:
        return False


def limit_hit(directory: Path) -> str | None:
    try:
        text = (directory / "run.log").read_text(errors="ignore").lower()
    except FileNotFoundError:
        return None
    return next((word for word in ("usage limit", "rate limit", " 429", "quota") if word in text), None)


def record_exit(directory: Path, returncode: int) -> None:
    (directory / "exit").write_text(f"{returncode}\n")
    (directory / "end").write_text(f"{int(time.time())}\n")


def stop_processes(running: dict[Path, subprocess.Popen]) -> None:
    """Reap every active call on errors/interruption, including its subprocess group on POSIX."""
    for process in running.values():
        try:
            if os.name == "posix":
                os.killpg(process.pid, signal.SIGTERM)
            else:
                process.terminate()
        except ProcessLookupError:
            pass
    for directory, process in running.items():
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            if os.name == "posix":
                os.killpg(process.pid, signal.SIGKILL)
            else:
                process.kill()
            process.wait()
        record_exit(directory, process.returncode)


def run_jobs(
    jobs: list[dict],
    jobs_dir: Path,
    codex: str = "codex",
    concurrency: int = 2,
    limit_file: Path | None = None,
    poll_interval: float = 1.0,
) -> int:
    """Bounded subprocess scheduler. Stop launching on failure/limits; drain already running calls."""
    if concurrency < 1:
        raise ValueError("concurrency must be positive")
    jobs_dir = jobs_dir.resolve()
    limit_file = limit_file.resolve() if limit_file is not None else jobs_dir / "LIMIT_HIT.txt"
    if limit_file.exists():
        print(f"limit file present: {limit_file}", flush=True)
        return 2
    pending = sheet_jobs(jobs, jobs_dir)
    managed = {task.directory for task in pending}
    completed = set()
    running: dict[Path, subprocess.Popen] = {}
    reported = set()
    status = 0
    # Resolve relative executable paths before changing each child's working directory.
    if os.path.dirname(codex):
        codex = str(Path(codex).resolve())
    try:
        while pending or running:
            for directory, process in list(running.items()):
                returncode = process.poll()
                hit = limit_hit(directory)
                if hit and directory not in reported:
                    limit_file.parent.mkdir(parents=True, exist_ok=True)
                    with limit_file.open("a", encoding="utf-8") as handle:
                        handle.write(f"{time.ctime()} {directory}: {hit}\n")
                    reported.add(directory)
                    status = 2
                if returncode is not None:
                    record_exit(directory, returncode)
                    success = returncode == 0 and readable_output(directory)
                    print(
                        "finished",
                        directory.name,
                        "exit",
                        returncode,
                        "output" if success else "FAILED",
                        hit or "",
                        flush=True,
                    )
                    if success:
                        completed.add(directory)
                    elif status == 0:
                        status = 1
                    del running[directory]
            if limit_file.exists():
                status = 2
            if status:
                if not running:
                    return status
                time.sleep(poll_interval)
                continue
            for task in list(pending):
                directory, reference = task.directory, task.reference
                if reference in managed and reference not in completed:
                    continue
                if done(directory):
                    completed.add(directory)
                    pending.remove(task)
                    continue
                if len(running) >= concurrency:
                    break
                # Check an externally supplied stop file again before each launch.
                if limit_file.exists():
                    status = 2
                    break
                ref_path = directory / "reference_previous.png"
                if reference is not None:
                    shutil.copyfile(reference / "output.png", ref_path)
                else:
                    ref_path.unlink(missing_ok=True)
                for name in ("exit", "end", "output.png", "last.txt"):
                    (directory / name).unlink(missing_ok=True)
                (directory / "start").write_text(f"{int(time.time())}\n")
                text = (directory / "prompt.txt").read_text(encoding="utf-8")
                # Keep run_img.sh's exact argument contract; avoid shell quoting or a wrapper process.
                command = [
                    codex,
                    "exec",
                    "-s",
                    "workspace-write",
                    "--skip-git-repo-check",
                    "-C",
                    str(directory),
                    "-o",
                    str(directory / "last.txt"),
                    text,
                ]
                with (directory / "run.log").open("wb") as log:
                    process = subprocess.Popen(
                        command,
                        cwd=directory,
                        stdin=subprocess.DEVNULL,
                        stdout=log,
                        stderr=subprocess.STDOUT,
                        start_new_session=os.name == "posix",
                    )
                running[directory] = process
                pending.remove(task)
                print("launched", directory.name, "reference", reference.name if reference else "none", flush=True)
            if not running and pending and not status:
                # A dependent may precede its already-completed reference in the job list.
                if any(
                    task.reference is None or task.reference not in managed or task.reference in completed
                    for task in pending
                ):
                    continue
                raise ValueError("no runnable sheets; unresolved reference dependencies")
            if running:
                time.sleep(poll_interval)
        return status
    finally:
        stop_processes(running)


# Per kind: how opaque the redrawn body is inside the native footprint (tesla arcs are light: mostly additive).
OPAQUE = {"explosion": 1.0, "fire": 1.0, "muzzle": 0.7, "tesla": 0.25, "impact": 0.6, "plasma": 0.55, "blueexp": 0.7}


# HD texels per native pixel stored, per anim (larger for small anims whose sheets were drawn at a higher scale).
def target_scale(sheet_scale):
    return 2 if sheet_scale <= 3 else 3


def s2l(x):
    x = x / 255.0
    return np.where(x <= 0.04045, x / 12.92, ((x + 0.055) / 1.055) ** 2.4)


def l2s(x):
    x = np.clip(x, 0, 1)
    return np.where(x <= 0.0031308, x * 12.92, 1.055 * np.power(x, 1 / 2.4) - 0.055) * 255.0


def smoothstep(e0, e1, x):
    t = np.clip((x - e0) / (e1 - e0), 0, 1)
    return t * t * (3 - 2 * t)


def matte(cell, region, wide, kind):
    """cell: HxWx3 uint8 over grey; region/wide: HxW soft masks. Returns premultiplied linear RGB and alpha.

    Coloured light the redraw adds over the grey (fire glow, electric arcs) is kept as light (colour with little
    coverage); dark pixels (smoke, debris) cover what is behind in proportion to how much darker they are; inside the
    native frame's footprint the redraw is opaque; neutral pixels lighter than the grey (lit smoke, the thin light rims
    image models draw around dark fragments) only count where they are covered, so they never glow.
    """
    pixels = cell.astype(np.float64)
    ring = np.concatenate(
        [
            pixels[:6].reshape(-1, 3),
            pixels[-6:].reshape(-1, 3),
            pixels[:, :6].reshape(-1, 3),
            pixels[:, -6:].reshape(-1, 3),
        ]
    )
    bg = np.median(ring, axis=0)
    dist = np.abs(pixels - bg).max(axis=2)
    Il, bgl = s2l(pixels), s2l(bg)
    mx, mn = pixels.max(axis=2), pixels.min(axis=2)
    sat = (mx - mn) / np.maximum(mx, 1)
    neutral = smoothstep(0.22, 0.12, sat)
    lighter = smoothstep(0, 6, pixels.mean(axis=2) - bg.mean())
    a_min = np.clip(((bgl - Il) / np.maximum(bgl, 1e-6)).max(axis=2), 0, 1)
    a_body = region * smoothstep(6, 24, dist) * OPAQUE[kind]
    # Light rims around isolated dark fragments: neutral, lighter than the grey, next to a dark pixel, in a sparse
    # neighbourhood (inside dense smoke, light and dark lumps next to each other are real shading).
    dark = ((bg.mean() - pixels.mean(axis=2)) > 25).astype(np.uint8)
    near_dark = cv2.dilate(dark, np.ones((5, 5), np.uint8)) > 0
    content = (dist > 8).astype(np.float64)
    density = cv2.blur(content, (15, 15))
    rim = near_dark & (dark == 0) & (neutral > 0.5) & (pixels.mean(axis=2) > bg.mean() - 12) & (density < 0.55)
    a_body = np.where(rim, 0, a_body)
    a = np.maximum(a_min, a_body)
    floor = smoothstep(3, 7, dist)  # background noise is +-2
    a = a * floor * wide
    exact = np.clip(Il - (1 - a[..., None]) * bgl, 0, None)
    covered = a[..., None] * Il
    w = (neutral * lighter)[..., None]
    P = (exact * (1 - w) + covered * w) * (floor * wide)[..., None]
    P = np.where(rim[..., None], 0, P)
    if kind in ("explosion", "fire", "muzzle", "impact"):
        # Fire, smoke and debris are never green (the model's occasional haze): keep green at most at red.
        P[..., 1] = np.minimum(P[..., 1], P[..., 0])
    return P, a, bg


def footprint(idx, bbox, S, shape, grow, blur):
    x0, y0, x1, y1 = bbox
    m = (idx[y0:y1, x0:x1] > 0).astype(np.float64)
    if grow:
        m = cv2.dilate(m.astype(np.uint8), np.ones((3, 3), np.uint8), iterations=grow).astype(np.float64)
    m = np.kron(m, np.ones((S, S)))
    sig = blur * S
    m = cv2.GaussianBlur(m, (0, 0), sig)
    out = np.zeros(shape)
    h, w = min(shape[0], m.shape[0]), min(shape[1], m.shape[1])
    out[:h, :w] = m[:h, :w]
    return np.clip(out * 1.6, 0, 1)


def cut_sheet(output: Image.Image, layout: dict, indices: list[np.ndarray], kind: str) -> dict:
    """Pure cut/matte/resample step, preserving native offsets even after the HD crop."""
    ch, cw = indices[0].shape
    out = output.convert("RGB")
    if out.size != tuple(layout["size"]):
        out = out.resize(tuple(layout["size"]), Image.Resampling.LANCZOS)
    pixels = np.array(out)
    scale = layout["scale"]
    target = target_scale(scale)
    bx0, by0, _, _ = layout["bbox"]
    frames = {}
    for cell_info in layout["cells"]:
        f = cell_info["frame"]
        x, y, w, h = (cell_info[key] for key in ("x", "y", "w", "h"))
        cell = pixels[y : y + h, x : x + w]
        region = footprint(indices[f], layout["bbox"], scale, cell.shape[:2], 1, 1.0)
        wide = footprint(indices[f], layout["bbox"], scale, cell.shape[:2], 5, 2.0)
        premultiplied, alpha, _ = matte(cell, region, wide, kind)
        # Resample to target texels per native pixel, before encoding linear colour as sRGB.
        k = target / scale
        nh, nw = max(1, round(cell.shape[0] * k)), max(1, round(cell.shape[1] * k))
        pr = cv2.resize(premultiplied.astype(np.float32), (nw, nh), interpolation=cv2.INTER_AREA)
        ar = cv2.resize(alpha.astype(np.float32), (nw, nh), interpolation=cv2.INTER_AREA)
        ar = np.clip(ar, 0, 1)
        pr = np.clip(pr, 0, None)
        ys, xs = np.nonzero((ar > 1 / 255) | (pr.max(axis=2) > 1 / 255))
        if len(xs) == 0:
            frames[f] = None
            continue
        pad = 2
        x0, y0 = max(0, xs.min() - pad), max(0, ys.min() - pad)
        x1, y1 = min(nw, xs.max() + 1 + pad), min(nh, ys.max() + 1 + pad)
        rgb = l2s(pr[y0:y1, x0:x1])
        a = ar[y0:y1, x0:x1] * 255
        rgba = np.dstack([rgb, a]).round().clip(0, 255).astype(np.uint8)
        # Native offset of the cell's top-left = bbox origin relative to the canvas centre.
        ox, oy = bx0 - cw // 2 + x0 / target, by0 - ch // 2 + y0 / target
        frames[f] = {"rgba": rgba, "offset": [ox, oy], "scale": target}
    return frames


def cut_anim(library: EffectLibrary, anim: str, kind: str, directories: list[Path]) -> list:
    indices = library.frame_indices(anim)
    frames = {}
    for directory in directories:
        layout = json.loads((directory / "layout.json").read_text(encoding="utf-8"))
        if layout["anim"] != anim:
            raise ValueError(f"{directory}: expected {anim}, got {layout['anim']}")
        with Image.open(directory / "output.png") as output:
            frames.update(cut_sheet(output, layout, indices, kind))
    return [frames.get(i) for i in range(len(indices))]


def pack(anims, out_dir, page_size=4096, gutter=2):
    # Reject impossible frames before creating artifacts; valid inputs retain the scratch packing exactly.
    if page_size < 1 or gutter < 0 or gutter >= page_size:
        raise ValueError("page_size must exceed gutter, and gutter must be nonnegative")
    for name, (_, frames) in anims.items():
        scales = {f["scale"] for f in frames if f is not None}
        if len(scales) > 1:
            raise ValueError(f"{name}: all frames must use the same HD scale")
        for frame in frames:
            if frame is not None and max(frame["rgba"].shape[:2]) > page_size:
                raise ValueError(f"{name}: frame exceeds page_size {page_size}")
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    pages = []  # list of (image array, shelves state)

    def new_page():
        pages.append({"img": np.zeros((page_size, page_size, 4), np.uint8), "x": 0, "y": 0, "h": 0, "used_h": 0})
        return len(pages) - 1

    items = []
    for name, (kind, frames) in anims.items():
        for i, f in enumerate(frames):
            if f is not None:
                items.append((f["rgba"].shape[0], name, i, f))
    items.sort(key=lambda t: -t[0])
    placed = {}
    cur = new_page()
    for h, name, i, f in items:
        H, W = f["rgba"].shape[:2]
        p = pages[cur]
        if p["x"] + W + gutter > page_size:
            p["x"] = 0
            p["y"] += p["h"] + gutter
            p["h"] = 0
        if p["y"] + H + gutter > page_size:
            cur = new_page()
            p = pages[cur]
        x, y = p["x"], p["y"]
        p["img"][y : y + H, x : x + W] = f["rgba"]
        p["x"] += W + gutter
        p["h"] = max(p["h"], H)
        p["used_h"] = max(p["used_h"], y + H)
        placed[(name, i)] = (cur, [x, y, W, H])
    meta = {"version": 1, "pages": [], "anims": {}}
    for k, p in enumerate(pages):
        hgt = int(p["used_h"] + gutter)
        hgt = 1 << (hgt - 1).bit_length() if hgt > 1 else 1
        hgt = min(page_size, max(256, hgt))
        fn = f"effects-hd-{k}.png"
        Image.fromarray(p["img"][:hgt], "RGBA").save(out_dir / fn, optimize=False, compress_level=6)
        meta["pages"].append({"file": fn, "width": page_size, "height": hgt})
    for name, (kind, frames) in anims.items():
        scale = next((f["scale"] for f in frames if f), 2)
        entry = {"scale": scale, "frames": []}
        for i, f in enumerate(frames):
            if f is None:
                entry["frames"].append(None)
            else:
                page, rect = placed[(name, i)]
                entry["frames"].append(
                    {"page": page, "rect": rect, "offset": [round(f["offset"][0], 4), round(f["offset"][1], 4)]}
                )
        meta["anims"][name] = entry
    (out_dir / "effects-hd.json").write_text(json.dumps(meta), encoding="utf-8")
    return meta


def pack_jobs(
    library: EffectLibrary,
    jobs: list[dict],
    jobs_dir: Path,
    out_dir: Path,
    page_size: int = 4096,
    extra_sheets: list[Path] | None = None,
) -> dict:
    extras: dict[str, list[Path]] = {}
    names = {job["anim"] for job in jobs}
    for directory in extra_sheets or []:
        layout = json.loads((directory / "layout.json").read_text(encoding="utf-8"))
        if layout["anim"] not in names:
            raise ValueError(f"{directory}: animation is not in the jobs JSON")
        extras.setdefault(layout["anim"], []).append(directory)
    anims = {}
    for job in jobs:
        anim = job["anim"]
        directories = extras.get(anim, []) + [jobs_dir / f"{anim}_{k}" for k in range(len(job["chunks"]))]
        for directory in directories:
            if not readable_output(directory):
                raise ValueError(f"incomplete {anim}: missing/unreadable {directory / 'output.png'}")
        frames = cut_anim(library, anim, job["kind"], directories)
        anims[anim] = (job["kind"], frames)
        print(anim, job["kind"], sum(f is not None for f in frames), "/", len(frames))
    return pack(anims, out_dir, page_size)


def positive_int(value: str) -> int:
    number = int(value)
    if number < 1:
        raise argparse.ArgumentTypeError("must be a positive integer")
    return number


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    commands = parser.add_subparsers(dest="command", required=True)
    for name, help_text in (
        ("sheets", "prepare input sheets, layouts and prompts"),
        ("run", "run bounded, reference-chained Codex image calls"),
        ("pack", "cut, matte and pack redrawn sheets into HD atlases"),
    ):
        sub = commands.add_parser(name, help=help_text)
        sub.add_argument("--jobs", type=Path, default=DEFAULT_JOBS, help="job JSON (default: bundled final batches)")
        sub.add_argument("--jobs-dir", type=Path, required=True, help="untracked directory of ANIM_<chunk> sheet jobs")
        if name in ("sheets", "pack"):
            sub.add_argument(
                "--effects", type=Path, required=True, help="native sidecar directory containing effects.json"
            )
        if name == "run":
            sub.add_argument("--codex", default="codex", help="Codex binary (default: codex on PATH)")
            sub.add_argument(
                "--concurrency", type=positive_int, default=2, help="maximum simultaneous calls (default: 2)"
            )
            sub.add_argument("--limit-file", type=Path, help="persistent stop file (default: <jobs-dir>/LIMIT_HIT.txt)")
        if name == "pack":
            sub.add_argument(
                "--out", type=Path, required=True, help="untracked destination for effects-hd.json and PNGs"
            )
            sub.add_argument(
                "--page-size", type=positive_int, default=4096, help="atlas width/maximum height (default: 4096)"
            )
            sub.add_argument(
                "--extra-sheets", type=Path, nargs="*", default=[], help="earlier approved sheet directories"
            )
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        jobs = load_jobs(args.jobs)
        if args.command == "run":
            return run_jobs(jobs, args.jobs_dir, args.codex, args.concurrency, args.limit_file)
        library = EffectLibrary(args.effects)
        if args.command == "sheets":
            write_sheets(library, jobs, args.jobs_dir)
        else:
            meta = pack_jobs(library, jobs, args.jobs_dir, args.out, args.page_size, args.extra_sheets)
            print("pages", [(page["file"], page["height"]) for page in meta["pages"]])
        return 0
    except (OSError, ValueError, KeyError, IndexError) as error:
        parser.exit(1, f"{args.command}: {error}\n")
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
