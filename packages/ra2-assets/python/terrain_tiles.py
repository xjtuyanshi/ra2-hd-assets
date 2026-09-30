#!/usr/bin/env python3
"""Prepare, repaint, assemble and check overlapping terrain-composite tiles.

All distances are composite pixels. Tiles are 1536 x 1024 with strides 1280 x 768;
the last tile on each axis is anchored to the image edge. Water coverage counts
mask values > 127, and coverage > 0.85 is skipped by default. Region priority is
intersection area, followed by row/column order.

Assembly locks CIELAB low frequencies (sigma L=20, ab=10 px; strengths 0.75/1.0),
then quilts overlaps with minimum-error cuts (cost blur 1.5 px, 4 px protected
borders, 3 px feather). ECC fits at half resolution with gradient blurs 3/2 px,
200 iterations, epsilon 1e-6 and a 5 px filter; fits moving a corner > 16 px are
rejected. QA reports the original, unaligned low-frequency Lab difference at
sigma 20 px, plus correlation and affine displacement; it does not gate output.

The optional runner accepts a user-supplied command, never a bundled model CLI.
Its defaults remain 3 processes, 25 minutes per attempt, 2 attempts per tile and
10 seconds between polls. Images and tile work directories are derived game art
and must remain outside version control. No manifest or material sidecar is edited.
"""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import re
import shlex
import subprocess
import sys
import time

import cv2
import numpy as np
from PIL import Image

Image.MAX_IMAGE_PIXELS = None

TW, TH, SX, SY = 1536, 1024, 1280, 768
LIMIT = re.compile(r"usage limit|rate limit|\b429\b|quota", re.I)


def load_image(path: Path, mode: str) -> np.ndarray:
    with Image.open(path) as image:
        return np.array(image.convert(mode))


def box_arg(value: str) -> tuple[int, int, int, int] | None:
    if value == "-":
        return None
    try:
        box = tuple(map(int, value.split(",")))
        if len(box) != 4 or box[2] <= box[0] or box[3] <= box[1]:
            raise ValueError
    except ValueError as error:
        raise argparse.ArgumentTypeError("expected x0,y0,x1,y1 with positive area, or -") from error
    return box


def starts(total: int, size: int, step: int) -> list[int]:
    positions = list(range(0, max(1, total - size) + 1, step))
    if positions[-1] + size < total:
        positions.append(total - size)
    return positions


def prep(args: argparse.Namespace) -> int:
    img = load_image(args.source, "RGB")
    wm = load_image(args.water_mask, "L")
    h, w = img.shape[:2]
    if wm.shape != (h, w):
        raise ValueError("source and water mask must have the same dimensions")
    prompt = args.prompt.read_text(encoding="utf-8")
    tiles = []
    for ty, y in enumerate(starts(h, TH, SY)):
        for tx, x in enumerate(starts(w, TW, SX)):
            water = float((wm[y:y + TH, x:x + TW] > 127).mean())
            overlap = 0
            if args.region:
                x0, y0, x1, y1 = args.region
                overlap = max(0, min(x + TW, x1) - max(x, x0)) * max(0, min(y + TH, y1) - max(y, y0))
            tiles.append(dict(tx=tx, ty=ty, x=x, y=y, water=water, overlap=overlap))
    tiles.sort(key=lambda t: (-t["overlap"], t["ty"], t["tx"]))
    queue = []
    for tile in tiles:
        directory = args.tiles.resolve() / f"{tile['tx']}_{tile['ty']}"
        directory.mkdir(parents=True, exist_ok=True)
        (directory / "tile.json").write_text(json.dumps(tile), encoding="utf-8")
        if tile["water"] > args.skip_water:
            print("skip (water)", directory.name, round(tile["water"], 2))
            continue
        Image.fromarray(img[tile["y"]:tile["y"] + TH, tile["x"]:tile["x"] + TW]).save(directory / "input.png")
        (directory / "prompt.txt").write_text(prompt, encoding="utf-8")
        queue.append(str(directory))
    queue_path = args.queue if args.queue is not None else args.tiles / "queue.txt"
    queue_path.parent.mkdir(parents=True, exist_ok=True)
    queue_path.write_text("\n".join(queue) + "\n", encoding="utf-8")
    print(w, h, "tiles", len(tiles), "queued", len(queue), "region-first",
          sum(t["overlap"] > 0 for t in tiles))
    return 0


def to_lab(rgb_u8: np.ndarray) -> np.ndarray:
    return cv2.cvtColor(rgb_u8.astype(np.float32) / 255, cv2.COLOR_RGB2LAB)


def from_lab(lab: np.ndarray) -> np.ndarray:
    return np.clip(cv2.cvtColor(lab.astype(np.float32), cv2.COLOR_LAB2RGB), 0, 1)


def colour_lock(inp: np.ndarray, out: np.ndarray, sigma_l: float = 20, sigma_ab: float = 10,
                lock_l: float = 0.75, lock_ab: float = 1.0) -> np.ndarray:
    li, lo = to_lab(inp), to_lab(out)
    result = lo.copy()
    result[..., 0] = lo[..., 0] + lock_l * (
        cv2.GaussianBlur(li[..., 0], (0, 0), sigma_l) - cv2.GaussianBlur(lo[..., 0], (0, 0), sigma_l))
    for channel in (1, 2):
        result[..., channel] = lo[..., channel] + lock_ab * (
            cv2.GaussianBlur(li[..., channel], (0, 0), sigma_ab)
            - cv2.GaussianBlur(lo[..., channel], (0, 0), sigma_ab))
    return from_lab(result)


def feat(rgb: np.ndarray) -> np.ndarray:
    grey = cv2.GaussianBlur(cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY).astype(np.float32) / 255, (0, 0), 3)
    magnitude = np.sqrt(cv2.Sobel(grey, cv2.CV_32F, 1, 0) ** 2 + cv2.Sobel(grey, cv2.CV_32F, 0, 1) ** 2)
    return cv2.GaussianBlur(magnitude, (0, 0), 2)


def corr(a: np.ndarray, b: np.ndarray) -> float:
    a, b = a - a.mean(), b - b.mean()
    return float((a * b).sum() / np.sqrt((a * a).sum() * (b * b).sum() + 1e-9))


def fit_affine(inp: np.ndarray, out: np.ndarray) -> tuple[float, float, np.ndarray]:
    """Return pre-fit correlation, ECC score and output-sampling affine in composite pixels.

    A failed fit retains OpenCV's warp and a NaN score for the QA report, as in
    the original checker. Assembly keeps the unaligned output on failure.
    """
    scale = 0.5
    fi = cv2.resize(feat(inp), None, fx=scale, fy=scale)
    fo = cv2.resize(feat(out), None, fx=scale, fy=scale)
    c0 = corr(fi, fo)
    warp = np.eye(2, 3, dtype=np.float32)
    try:
        cc, warp = cv2.findTransformECC(fi, fo, warp, cv2.MOTION_AFFINE,
                                      (cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 200, 1e-6), None, 5)
    except cv2.error:
        cc = float("nan")
    warp[:, 2] /= scale
    return c0, float(cc), warp


def displacement(warp: np.ndarray, shape: tuple[int, int]) -> np.ndarray:
    h, w = shape
    points = np.array([[0, 0], [w, 0], [0, h], [w, h], [w / 2, h / 2]], np.float32)
    return np.linalg.norm(points @ warp[:, :2].T + warp[:, 2] - points, axis=1)


def align(inp: np.ndarray, out: np.ndarray, name: str = "") -> np.ndarray:
    _, cc, warp = fit_affine(inp, out)
    if not np.isfinite(cc):
        print("  align: no convergence", name)
        return out
    disp = float(displacement(warp, inp.shape[:2])[:4].max())
    if disp > 16:
        print(f"  align: rejected (displacement {disp:.1f} px)", name)
        return out
    h, w = inp.shape[:2]
    result = cv2.warpAffine(out, warp, (w, h), flags=cv2.INTER_CUBIC + cv2.WARP_INVERSE_MAP,
                            borderMode=cv2.BORDER_REFLECT)
    print(f"  align {name}: ecc {cc:.3f} max displacement {disp:.1f} px")
    return result


def min_cut(cost: np.ndarray, axis: int) -> np.ndarray:
    """Minimum-cost monotone seam: one column per row; axis=1 transposes the cost."""
    c = cost if axis == 0 else cost.T
    h, w = c.shape
    acc = c.copy()
    back = np.zeros((h, w), np.int8)
    for i in range(1, h):
        prev = acc[i - 1]
        left = np.concatenate([[np.inf], prev[:-1]])
        right = np.concatenate([prev[1:], [np.inf]])
        stack = np.stack([left, prev, right])
        k = np.argmin(stack, 0)
        acc[i] += stack[k, np.arange(w)]
        back[i] = k - 1
    path = np.zeros(h, np.int32)
    path[-1] = int(np.argmin(acc[-1]))
    for i in range(h - 1, 0, -1):
        path[i - 1] = path[i] + back[i, path[i]]
    return path


def stitch(canvas: np.ndarray, filled: np.ndarray, tile: np.ndarray, x: int, y: int, feather: float = 3) -> None:
    """Quilt one tile in place, using its actual size for composites smaller than a full tile."""
    h, w = tile.shape[:2]
    current = canvas[y:y + h, x:x + w]
    overlap = filled[y:y + h, x:x + w]
    mask = np.ones((h, w), np.float32)
    if overlap.any():
        cost = cv2.GaussianBlur(((current - tile) ** 2).sum(-1), (0, 0), 1.5)
        ovx = int(overlap[h // 2].sum()) if overlap[h // 2, 0] else 0
        ovy = int(overlap[:, w // 2].sum()) if overlap[0, w // 2] else 0
        if ovx > 8:
            band = cost[:, :ovx].copy()
            band[:, :4] += 1e3
            band[:, -4:] += 1e3
            path = min_cut(band, 0)
            mask *= (np.arange(w)[None, :] >= path[:, None]).astype(np.float32)
        if ovy > 8:
            band = cost[:ovy, :].copy()
            band[:4] += 1e3
            band[-4:] += 1e3
            path = min_cut(band, 1)
            mask *= (np.arange(h)[:, None] >= path[None, :]).astype(np.float32)
        mask = np.where(overlap, mask, 1.0)
        mask = np.where(overlap, cv2.GaussianBlur(mask, (0, 0), feather), 1.0)
    canvas[y:y + h, x:x + w] = current * (1 - mask[..., None]) + tile * mask[..., None]
    filled[y:y + h, x:x + w] = True


def assemble(args: argparse.Namespace) -> int:
    source = load_image(args.source, "RGBA")
    h, w = source.shape[:2]
    tiles = []
    for path in sorted(args.tiles.glob("*/tile.json")):
        tile = json.loads(path.read_text(encoding="utf-8"))
        tile["dir"] = path.parent
        tiles.append(tile)
    canvas = source[..., :3].astype(np.float32) / 255
    filled = np.zeros((h, w), bool)
    used = 0
    for tile in sorted(tiles, key=lambda t: (t["y"], t["x"])):
        x, y, directory = tile["x"], tile["y"], tile["dir"]
        output_path = directory / "output.png"
        if not output_path.exists():
            continue
        inp = load_image(directory / "input.png", "RGB")
        th, tw = inp.shape[:2]
        if x < 0 or y < 0 or x + tw > w or y + th > h:
            raise ValueError(f"tile {directory} is outside the source image")
        out = load_image(output_path, "RGB")
        if out.shape[:2] != (th, tw):
            out = cv2.resize(out, (tw, th), interpolation=cv2.INTER_AREA)
        if not args.no_align:
            out = align(inp, out, directory.name)
        painted = colour_lock(inp, out, args.sigma_l, args.sigma_ab, args.lock_l, args.lock_ab)
        stitch(canvas, filled, painted, x, y, args.feather)
        used += 1
    result = source.copy()
    result[..., :3] = np.round(np.clip(canvas, 0, 1) * 255).astype(np.uint8)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray(result).save(args.output)
    print("assembled tiles", len(tiles), "with output", used, "->", args.output)
    if args.debug_box:
        x0, y0, x1, y1 = args.debug_box
        debug = args.output.with_name(args.output.stem + "_dbg.png")
        Image.fromarray(np.concatenate([source[y0:y1, x0:x1, :3], result[y0:y1, x0:x1, :3]], 1)).save(debug)
    return 0


def check_tiles(args: argparse.Namespace) -> int:
    for directory in sorted(args.tiles.iterdir()):
        output_path = directory / "output.png"
        if not output_path.exists():
            continue
        inp = load_image(directory / "input.png", "RGB")
        out = load_image(output_path, "RGB")
        original_size = out.shape[:2]
        if out.shape[:2] != inp.shape[:2]:
            out = cv2.resize(out, (inp.shape[1], inp.shape[0]), interpolation=cv2.INTER_AREA)
        c0, cc, warp = fit_affine(inp, out)
        disp = displacement(warp, inp.shape[:2])
        li = cv2.cvtColor(cv2.GaussianBlur(inp, (0, 0), 20), cv2.COLOR_RGB2LAB).astype(np.float32)
        lo = cv2.cvtColor(cv2.GaussianBlur(out, (0, 0), 20), cv2.COLOR_RGB2LAB).astype(np.float32)
        de = float(np.sqrt(((li - lo) ** 2).sum(-1)).mean())
        report = dict(tile=directory.name, outsize=list(original_size), corr0=round(c0, 3), ecc=round(cc, 3),
                      disp_max=round(float(disp.max()), 1), disp_centre=round(float(disp[4]), 1),
                      lowfreq_dE=round(de, 1), warp=warp.round(4).tolist())
        (directory / "check.json").write_text(json.dumps(report), encoding="utf-8")
        print(report["tile"], report["outsize"], "corr", report["corr0"], "ecc", report["ecc"],
              "disp max/centre", report["disp_max"], report["disp_centre"], "dE", report["lowfreq_dE"])
    return 0


def queue_order(paths: list[Path]) -> list[Path]:
    """Interleave queues; relative entries resolve beside their queue file."""
    queues = []
    for path in paths:
        queue = []
        for line in path.read_text(encoding="utf-8").splitlines():
            if line.strip():
                directory = Path(line.strip())
                queue.append((path.parent / directory).resolve())
        queues.append(queue)
    order = [queue[i] for i in range(max(map(len, queues), default=0)) for queue in queues if i < len(queue)]
    # A repeated directory must not replace a live process's cleanup owner.
    return list(dict.fromkeys(order))


def command_args(template: str, directory: Path) -> list[str]:
    """Split before substitution so paths and multiline prompts each stay one argument; no shell is invoked."""
    fields = {"tile": str(directory), "input": str(directory / "input.png"),
              "output": str(directory / "output.png"), "prompt_file": str(directory / "prompt.txt"),
              "prompt": (directory / "prompt.txt").read_text(encoding="utf-8"),
              "last": str(directory / "last.txt")}
    try:
        command = [word.format(**fields) for word in shlex.split(template)]
    except (KeyError, ValueError, IndexError) as error:
        raise ValueError(f"invalid command template: {error}") from error
    if not command:
        raise ValueError("--command or TERRAIN_TILES_COMMAND must supply an external CLI command")
    return command


def run(args: argparse.Namespace) -> int:
    if not args.command:
        raise ValueError("--command or TERRAIN_TILES_COMMAND is required")
    if args.jobs < 1 or args.timeout <= 0 or args.poll_interval <= 0:
        raise ValueError("jobs, timeout and poll interval must be positive")
    order = queue_order(args.queues)
    pending = [d for d in order if not (d / "output.png").exists()]
    args.work.mkdir(parents=True, exist_ok=True)
    pause_path = args.work / "PAUSE"
    limit_path = args.work / "LIMIT_HIT.txt"
    running = {}
    attempts = {}
    limit_hit = False
    with (args.work / "sched.log").open("a", encoding="utf-8") as log:
        def say(*parts):
            log.write(time.strftime("%H:%M:%S ") + " ".join(map(str, parts)) + "\n")
            log.flush()

        say("start", len(pending), "jobs")
        try:
            while pending or running:
                for directory, (process, t0, handle) in list(running.items()):
                    rc = process.poll()
                    if rc is None and time.monotonic() - t0 < args.timeout:
                        continue
                    if rc is None:
                        process.kill()
                        process.wait()
                        rc = "timeout"
                    handle.close()
                    running.pop(directory)
                    tail = (directory / "run.log").read_text(encoding="utf-8", errors="ignore")[-20000:]
                    ok = (directory / "output.png").exists()
                    say("done", directory, "rc", rc, "ok", ok, "secs", int(time.monotonic() - t0))
                    match = LIMIT.search(tail)
                    if not ok and match:
                        limit_hit = True
                        with limit_path.open("a", encoding="utf-8") as marker:
                            marker.write(f"{time.strftime('%Y-%m-%d %H:%M:%S')} terrain track: "
                                         f"{tail[max(0, match.start() - 200):match.end() + 200]}\n")
                        say("LIMIT HIT", directory)
                    if not ok and not limit_hit and attempts.get(directory, 0) < 2:
                        pending.insert(0, directory)
                while pending and len(running) < args.jobs and not limit_hit and not pause_path.exists():
                    directory = pending.pop(0)
                    command = command_args(args.command, directory)
                    attempts[directory] = attempts.get(directory, 0) + 1
                    handle = (directory / "run.log").open("w", encoding="utf-8")
                    try:
                        process = subprocess.Popen(command, cwd=directory, stdin=subprocess.DEVNULL,
                                                   stdout=handle, stderr=subprocess.STDOUT)
                    except BaseException:
                        handle.close()
                        raise
                    running[directory] = (process, time.monotonic(), handle)
                    say("launch", directory, "pid", process.pid, "attempt", attempts[directory])
                if (limit_hit or pause_path.exists()) and not running:
                    break
                if pending or running:
                    time.sleep(args.poll_interval)
        finally:
            for process, _, handle in running.values():
                if process.poll() is None:
                    process.kill()
                process.wait()
                handle.close()
        missing = sum(not (d / "output.png").exists() for d in order)
        say("exit", "pending", len(pending), "limit", limit_hit, "missing", missing)
    print("tile queue finished; missing outputs", missing, "limit", limit_hit)
    return int(missing > 0 or limit_hit)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command_name", required=True)
    prepare = sub.add_parser("prep", help="cut the composite, write per-tile inputs/prompts and a priority queue")
    prepare.add_argument("--source", required=True, type=Path)
    prepare.add_argument("--water-mask", required=True, type=Path)
    prepare.add_argument("--prompt", required=True, type=Path)
    prepare.add_argument("--tiles", required=True, type=Path)
    prepare.add_argument("--queue", type=Path, help="default: <tiles>/queue.txt (absolute tile-directory entries)")
    prepare.add_argument("--region", type=box_arg, help="priority box x0,y0,x1,y1 in composite pixels; - for none")
    prepare.add_argument("--skip-water", type=float, default=0.85)
    prepare.set_defaults(func=prep)

    runner = sub.add_parser("run", help="run a user-provided CLI over interleaved queues")
    runner.add_argument("queues", nargs="+", type=Path)
    runner.add_argument("--work", required=True, type=Path, help="directory for sched.log, PAUSE and LIMIT_HIT.txt")
    runner.add_argument("--command", default=os.environ.get("TERRAIN_TILES_COMMAND"),
                        help="quoted argv template (or TERRAIN_TILES_COMMAND); placeholders: "
                             "{tile}, {input}, {output}, {prompt_file}, {prompt}, {last}; cwd is the tile directory")
    runner.add_argument("--jobs", type=int, default=3)
    runner.add_argument("--timeout", type=float, default=25 * 60, help="seconds per attempt (default: 1500)")
    runner.add_argument("--poll-interval", type=float, default=10, help="seconds between polls (default: 10)")
    runner.set_defaults(func=run)

    assembly = sub.add_parser("assemble", help="align, colour-lock and quilt outputs onto the original composite")
    assembly.add_argument("--source", required=True, type=Path, help="same composite passed to prep; alpha is kept")
    assembly.add_argument("--tiles", required=True, type=Path)
    assembly.add_argument("--output", required=True, type=Path)
    assembly.add_argument("--sigma-l", type=float, default=20)
    assembly.add_argument("--sigma-ab", type=float, default=10)
    assembly.add_argument("--lock-l", type=float, default=0.75)
    assembly.add_argument("--lock-ab", type=float, default=1.0)
    assembly.add_argument("--feather", type=float, default=3.0)
    assembly.add_argument("--no-align", action="store_true", help="disable ECC affine registration")
    assembly.add_argument("--debug-box", "--dbg", type=box_arg, help="write <output-stem>_dbg.png for x0,y0,x1,y1")
    assembly.set_defaults(func=assemble)

    checker = sub.add_parser("check", help="write per-tile check.json registration and colour diagnostics")
    checker.add_argument("--tiles", required=True, type=Path)
    checker.set_defaults(func=check_tiles)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        return args.func(args)
    except (OSError, ValueError, cv2.error) as error:
        print(f"terrain_tiles: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
