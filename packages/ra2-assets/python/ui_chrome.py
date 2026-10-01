#!/usr/bin/env python3
"""Build and register HD sidebar/command-bar chrome redraw sheets.

sheet takes a native frame PNG, a side name and a job directory. It inpaints
bright credits digits in a caller-configurable native rectangle, then enlarges
sidebar pieces and two command-bar halves 3x onto a dark 1536x1024 sheet. The job
contains input.png, native.png, credits_mask.png, layout.json and prompt.txt.
Geometry is supplied by CLI flags or a JSON object with sidebar_x, piece_height,
command_bar_rect and optional credits_rect. Rectangles use [x,y,width,height].
Defaults describe the original 1152x744 layout (sidebar x=984, thirds of 248,
command bar [0,712,984,32]); the frame size is always read from the image, never
assumed. A different frame needs its own geometry. Materials/colours and the
prompt are caller-owned, with ui_chrome_prompt.example.txt as the default.

pack extracts each redrawn part with a search margin and uses ECC affine
registration on blurred luminance. Models can slightly translate/scale the
structure even when prompted to preserve geometry; ECC restores native slot
and button alignment while retaining the redrawn detail. Whole-sheet size
changes are normalized before registration. Failed or implausible fits fail
explicitly rather than silently publishing unregistered chrome.

Output is <output>/<piece-name>.png at the sheet scale, registration.json with
the measured warps/residuals, and chrome.json:
{frame:{width,height}, scale, pieces:[{file,rect,anchor}]}. rect uses native
pixels relative to sidebar or commandBar, independent of PNG scale. Pass the
desired side's cache directory as --output. Images/work/cache stay outside Git.
Dependencies: Pillow, NumPy, OpenCV; no model call is made by this module.

  python3 ui_chrome.py sheet --frame <frame.png> --side <side> --job-dir <job> \
      --geometry <layout.json> --materials <description> --colours <description>
  python3 ui_chrome.py pack --job-dir <job> --output <chrome-side-cache>

To use ui_cameos.py run, place jobs beneath <work>/jobs/; without queue.txt that
runner discovers the job directories. Each job has its own model prompt.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import cv2
import numpy as np
from PIL import Image

from ui_cameos import load_image, safe_name, write_json


DEFAULT_GEOMETRY = {"sidebar_x": 984, "piece_height": 248, "command_bar_rect": [0, 712, 984, 32]}


def checked_rect(rect, size: tuple[int, int]) -> tuple[int, int, int, int]:
    if not isinstance(rect, (list, tuple)) or len(rect) != 4 or any(type(v) is not int for v in rect):
        raise ValueError("Rectangles must be integer [x,y,width,height] arrays")
    x, y, width, height = rect
    if x < 0 or y < 0 or width < 1 or height < 1 or x + width > size[0] or y + height > size[1]:
        raise ValueError(f"Rectangle outside frame: {rect}")
    return x, y, width, height


def clean_credits(image: Image.Image, rect, threshold: float = 140) -> tuple[Image.Image, np.ndarray]:
    """Select bright glyphs only inside the money band; dilation cannot cross the band."""
    x, y, width, height = checked_rect(rect, image.size)
    rgb = np.array(image.convert("RGB"))
    luminance = rgb.astype(np.float32) @ np.float32([0.299, 0.587, 0.114])
    mask = np.zeros(rgb.shape[:2], np.uint8)
    mask[y:y + height, x:x + width] = (luminance[y:y + height, x:x + width] > threshold).astype(np.uint8) * 255
    mask = cv2.dilate(mask, np.ones((3, 3), np.uint8))
    mask[:y] = mask[y + height:] = 0
    mask[:, :x] = mask[:, x + width:] = 0
    return Image.fromarray(cv2.inpaint(rgb, mask, 3, cv2.INPAINT_TELEA)), mask


def sheet(frame: Path, side: str, job_dir: Path, geometry: dict,
          prompt_file: Path | None = None, materials: str = "the materials in the design reference",
          colours: str = "the original reference colours", scale: int = 3,
          sheet_size: tuple[int, int] = (1536, 1024), threshold: float = 140) -> dict:
    if type(scale) is not int or scale < 1 or min(sheet_size) < 1:
        raise ValueError("scale and sheet dimensions must be positive integers")
    image = load_image(frame)
    sidebar_x, piece_height = geometry["sidebar_x"], geometry["piece_height"]
    if type(sidebar_x) is not int or not 0 <= sidebar_x < image.width or type(piece_height) is not int or piece_height < 1:
        raise ValueError("Invalid sidebar x or piece height")
    bx, by, bw, bh = checked_rect(geometry["command_bar_rect"], image.size)
    if bw < 2:
        raise ValueError("Command bar must be at least two pixels wide")
    sidebar_width = image.width - sidebar_x
    # The default band stays away from the chrome edges; pass credits_rect for a different layout.
    inset = min(30, sidebar_width // 5)
    credits_rect = geometry.get("credits_rect", [sidebar_x + inset, 5, sidebar_width - 2 * inset, min(20, image.height - 5)])
    image, mask = clean_credits(image, credits_rect, threshold)
    gap, parts = 6, []
    canvas = Image.new("RGB", sheet_size, (24, 24, 26))

    def place(name: str, source: tuple, x: int, y: int, anchor: str) -> None:
        sx, sy, width, height = checked_rect(source, image.size)
        dst = [x, y, width * scale, height * scale]
        checked_rect(dst, sheet_size)
        box = (sx, sy, sx + width, sy + height)
        canvas.paste(image.crop(box).resize((dst[2], dst[3]), Image.Resampling.LANCZOS), (x, y))
        parts.append({"name": name, "src": list(box), "dst": dst, "anchor": anchor})

    count = (image.height + piece_height - 1) // piece_height
    for index in range(count):
        y = index * piece_height
        place(f"sidebar{index}", (sidebar_x, y, sidebar_width, min(piece_height, image.height - y)),
              gap + index * (sidebar_width * scale + gap), gap, "sidebar")
    top_bottom = gap + min(piece_height, image.height) * scale
    command_widths = (bw // 2, bw - bw // 2)
    for index, width in enumerate(command_widths):
        x = bx if index == 0 else bx + command_widths[0]
        place(f"command{index}", (x, by, width, bh), max(gap, (sheet_size[0] - width * scale) // 2),
              top_bottom + gap + 20 + index * (bh * scale + 30), "commandBar")
    layout = {"side": side, "frame": {"width": image.width, "height": image.height}, "scale": scale,
              "anchors": {"sidebar": [sidebar_x, 0], "commandBar": [bx, by]}, "parts": parts}
    prompt_file = prompt_file or Path(__file__).with_name("ui_chrome_prompt.example.txt")
    prompt = prompt_file.read_text(encoding="utf-8")
    replacements = {"SIDE": side, "MATERIALS": materials, "COLOURS": colours, "SCALE": str(scale),
                    "WIDTH": str(sheet_size[0]), "HEIGHT": str(sheet_size[1]), "SIDEBAR_COUNT": str(count)}
    for key, value in replacements.items():
        prompt = prompt.replace("{" + key + "}", value)
    if job_dir.exists() and any((job_dir / name).exists() for name in ("start", "output.png")):
        raise ValueError(f"Job already ran; use a new job directory: {job_dir}")
    job_dir.mkdir(parents=True, exist_ok=True)
    canvas.save(job_dir / "input.png")
    image.save(job_dir / "native.png")
    Image.fromarray(mask).save(job_dir / "credits_mask.png")
    write_json(job_dir / "layout.json", layout)
    (job_dir / "prompt.txt").write_text(prompt, encoding="utf-8")
    return layout


def luminance(rgb: np.ndarray) -> np.ndarray:
    return cv2.GaussianBlur(np.asarray(rgb, np.float32) @ np.float32([0.299, 0.587, 0.114]), (0, 0), 1.5)


def register_piece(reference: np.ndarray, redraw: np.ndarray,
                   offset: tuple[int, int] = (0, 0), max_displacement: float = 48) -> tuple[np.ndarray, dict]:
    """Fit a reference-to-redraw affine warp, then inverse-sample to the exact reference canvas."""
    ref = luminance(reference)
    height, width = ref.shape
    # The cropped reference reflects its edge during blur, whereas the search image has
    # dark gutters there. Exclude that artificial contrast from fitting: on thin command
    # strips it otherwise drives ECC toward a false vertical scale/shear.
    inset = min(8, min(height, width) // 8)
    fitting = ref[inset:height - inset, inset:width - inset] if inset else ref
    warp = np.float32([[1, 0, offset[0] + inset], [0, 1, offset[1] + inset]])
    try:
        correlation, warp = cv2.findTransformECC(fitting, luminance(redraw), warp, cv2.MOTION_AFFINE,
                                                (cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 200, 1e-5), None, 5)
    except cv2.error as error:
        raise ValueError(f"ECC registration failed: {error}") from error
    warp[:, 2] -= warp[:, :2] @ np.float32([inset, inset])
    corners = np.float32([[0, 0, 1], [width - 1, 0, 1], [0, height - 1, 1], [width - 1, height - 1, 1]])
    displacement = np.linalg.norm(corners @ warp.T - corners[:, :2] - np.asarray(offset), axis=1).max()
    if not np.isfinite(warp).all() or np.linalg.det(warp[:, :2]) <= 0 or displacement > max_displacement:
        raise ValueError(f"Implausible ECC transform (corner displacement {displacement:.1f})")
    piece = cv2.warpAffine(np.asarray(redraw, np.float32), warp, (width, height),
                           flags=cv2.INTER_LANCZOS4 | cv2.WARP_INVERSE_MAP, borderMode=cv2.BORDER_REPLICATE)
    residual = float(np.abs(cv2.GaussianBlur(luminance(piece), (0, 0), 4) - cv2.GaussianBlur(ref, (0, 0), 4)).mean())
    report = {"correlation": float(correlation), "warp": warp.tolist(), "residual": residual,
              "maxDisplacement": float(displacement)}
    return np.clip(piece, 0, 255).astype(np.uint8), report


def pack(job_dir: Path, output: Path, margin: int = 24) -> dict:
    if margin < 1:
        raise ValueError("registration margin must be positive")
    layout = json.loads((job_dir / "layout.json").read_text(encoding="utf-8"))
    reference = load_image(job_dir / "input.png")
    redraw = load_image(job_dir / "output.png")
    output_size = list(redraw.size)
    redraw = redraw.resize(reference.size, Image.Resampling.LANCZOS)
    inp, out = np.array(reference, np.float32), np.array(redraw, np.float32)
    scale = layout["scale"]
    if type(scale) is not int or scale < 1 or not layout["parts"]:
        raise ValueError("Invalid chrome scale or empty layout")
    # Infer frame/anchors for the original scratch layout, which stored only src/dst rectangles.
    frame = layout.get("frame", {"width": max(p["src"][2] for p in layout["parts"]),
                                 "height": max(p["src"][3] for p in layout["parts"])})
    anchors = layout.get("anchors")
    if anchors is None:
        anchors = {}
        for part in layout["parts"]:
            anchor = part.get("anchor", "sidebar" if part["name"].startswith("sidebar") else "commandBar")
            point = part["src"][:2]
            old = anchors.get(anchor, point)
            anchors[anchor] = [min(old[0], point[0]), min(old[1], point[1])]
    results, reports, pieces = [], [], []
    names = set()
    for part in layout["parts"]:
        name = safe_name(part["name"])
        if name in names:
            raise ValueError(f"Duplicate chrome piece: {name}")
        names.add(name)
        x, y, width, height = checked_rect(part["dst"], reference.size)
        sx, sy, sx1, sy1 = part["src"]
        checked_rect([sx, sy, sx1 - sx, sy1 - sy], (frame["width"], frame["height"]))
        if (width, height) != ((sx1 - sx) * scale, (sy1 - sy) * scale):
            raise ValueError("Chrome part dimensions do not match scale")
        x0, y0 = max(0, x - margin), max(0, y - margin)
        big = out[y0:min(out.shape[0], y + height + margin), x0:min(out.shape[1], x + width + margin)]
        piece, report = register_piece(inp[y:y + height, x:x + width], big, (x - x0, y - y0), margin * 2)
        report["name"] = name
        reports.append(report)
        results.append((name, piece))
        anchor = part.get("anchor", "sidebar" if name.startswith("sidebar") else "commandBar")
        if anchor not in ("sidebar", "commandBar"):
            raise ValueError(f"Unknown chrome anchor: {anchor}")
        ax, ay = anchors[anchor]
        pieces.append({"file": f"{name}.png", "rect": {"x": sx - ax, "y": sy - ay, "width": sx1 - sx, "height": sy1 - sy}, "anchor": anchor})
    # Finish all fits before replacing the cache manifest; a failed fit cannot report a successful pack.
    output.mkdir(parents=True, exist_ok=True)
    for name, piece in results:
        Image.fromarray(piece).save(output / f"{name}.png", optimize=True)
    manifest = {"frame": frame, "scale": scale, "pieces": pieces}
    write_json(output / "registration.json", {"inputSize": list(reference.size), "outputSize": output_size, "pieces": reports})
    write_json(output / "chrome.json", manifest)
    return manifest


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    commands = parser.add_subparsers(dest="command", required=True)
    prepare = commands.add_parser("sheet")
    prepare.add_argument("--frame", type=Path, required=True)
    prepare.add_argument("--side", required=True)
    prepare.add_argument("--job-dir", type=Path, required=True)
    prepare.add_argument("--geometry", type=Path, help="JSON geometry; explicit CLI values override it")
    prepare.add_argument("--sidebar-x", type=int)
    prepare.add_argument("--piece-height", type=int)
    prepare.add_argument("--command-bar-rect", type=int, nargs=4, metavar=("X", "Y", "W", "H"))
    prepare.add_argument("--credits-rect", type=int, nargs=4, metavar=("X", "Y", "W", "H"))
    prepare.add_argument("--digit-threshold", type=float, default=140)
    prepare.add_argument("--scale", type=int, default=3)
    prepare.add_argument("--sheet-size", type=int, nargs=2, default=(1536, 1024), metavar=("W", "H"))
    prepare.add_argument("--prompt", type=Path)
    prepare.add_argument("--materials", default="the materials in the design reference")
    prepare.add_argument("--colours", default="the original reference colours")
    assemble = commands.add_parser("pack")
    assemble.add_argument("--job-dir", type=Path, required=True)
    assemble.add_argument("--output", type=Path, required=True)
    assemble.add_argument("--margin", type=int, default=24)
    args = parser.parse_args(argv)
    try:
        if args.command == "sheet":
            geometry = DEFAULT_GEOMETRY | (json.loads(args.geometry.read_text(encoding="utf-8")) if args.geometry else {})
            for key in ("sidebar_x", "piece_height", "command_bar_rect", "credits_rect"):
                value = getattr(args, key)
                if value is not None:
                    geometry[key] = value
            layout = sheet(args.frame, args.side, args.job_dir, geometry, args.prompt, args.materials,
                           args.colours, args.scale, tuple(args.sheet_size), args.digit_threshold)
            print(f"Prepared {len(layout['parts'])} chrome parts in {args.job_dir}")
        else:
            manifest = pack(args.job_dir, args.output, args.margin)
            print(f"Registered {len(manifest['pieces'])} chrome parts in {args.output}")
        return 0
    except (OSError, ValueError, KeyError, cv2.error) as error:
        parser.exit(1, f"error: {error}\n")


if __name__ == "__main__":
    raise SystemExit(main())
