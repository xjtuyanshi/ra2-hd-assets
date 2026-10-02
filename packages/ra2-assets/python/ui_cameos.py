#!/usr/bin/env python3
"""Prepare, redraw, pack and compare HD sidebar cameos.

Input is the extractor directory containing cameos.json (a list of entries with
id, cameo, file and optional kind/name/uiName) and orig/*.png, including alternate
art. prep removes bright baked caption glyphs from the bottom 12 native pixels;
sheets removes the rounded frame and builds 3x2, 1536x1024 design references with
480x384 panels. Subject selection/descriptions and the prompt are caller-owned
JSON/text files; no unit registry or faction policy lives in this module. An
optional ESR directory preserves the scratch workflow's 75% smooth bicubic / 25%
ESR edge blend. Without it, references use smooth bicubic enlargement.

run makes one Codex call per job with bounded concurrency. A live log mentioning
a usage/rate limit, 429 or quota writes work/LIMIT, stops new calls and drains
active calls. Removing LIMIT explicitly permits a later run. Successful jobs
with an exit=0 marker and a readable output.png are reused; failures stop the
queue and can be retried by invoking run again. Interrupted processes are reaped.

pack detects dark, low-variance gutters because image models sometimes rescale
the grid within the canvas. If detection fails, layout rectangles are scaled to
the actual output dimensions and the fallback is recorded in pack_report.json.
Panels are inset, centre-cropped to 5:4 (never stretched), and saved as 480x384
WebP. Originals are copied byte-for-byte into the output cache; index.json uses
{version:1, images:{name:{orig?,hd?}}, byId:{ID:name}}. compare produces Chinese
original/HD comparison sheets with real text captions, optionally from a CSF.

Dependencies: Pillow, NumPy, OpenCV. Keep all work/cache art outside Git.
Example (run from any directory, with paths supplied by the caller):
  python3 ui_cameos.py prep --source <extractor> --work <work>
  python3 ui_cameos.py sheets --source <extractor> --work <work> \
      --subjects ui_cameos_subjects.example.json \
      --prompt ui_cameos_prompt.example.txt --style-reference <approved.png>
  python3 ui_cameos.py run --work <work> --concurrency 3 --codex codex
  python3 ui_cameos.py pack --source <extractor> --work <work> --output <cache>
  python3 ui_cameos.py compare --source <extractor> --work <work> \
      --output <cache> --csf <strings.csf> --font <Chinese-font.ttf>
"""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import re
import shutil
import signal
import struct
import subprocess
import time

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont


SHEET_SIZE = (1536, 1024)
PANEL_SIZE = (480, 384)
POSITIONS = ("top-left", "top-middle", "top-right", "bottom-left", "bottom-middle", "bottom-right")
LIMIT_PATTERN = re.compile(r"usage[\s_-]+limit|rate[\s_-]+limit|\b429\b|quota", re.I)


def write_json(path: Path, data) -> None:
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def safe_name(value: str) -> str:
    if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9_-]+", value):
        raise ValueError(f"Invalid output name: {value!r}")
    return value


def load_entries(source: Path) -> list[dict]:
    entries = json.loads((source / "cameos.json").read_text(encoding="utf-8"))
    if not isinstance(entries, list):
        raise ValueError("cameos.json must contain a list")
    for entry in entries:
        safe_name(entry["cameo"])
        if not isinstance(entry["id"], str):
            raise ValueError("Cameo IDs must be strings")
        if entry.get("file"):
            path = (source / entry["file"]).resolve()
            if not path.is_relative_to((source / "orig").resolve()) or not path.is_file():
                raise ValueError(f"Missing or invalid original: {entry['file']}")
    return entries


def load_image(path: Path, mode: str = "RGB") -> Image.Image:
    with Image.open(path) as image:
        return image.convert(mode)


def erase_label(image: Image.Image, band_height: int = 12) -> Image.Image:
    """Inpaint bright caption glyphs, excluding transparent corners as source data."""
    if band_height < 1:
        raise ValueError("label height must be positive")
    rgba = np.array(image.convert("RGBA"))
    rgb, alpha = rgba[..., :3].copy(), rgba[..., 3]
    luminance = rgb.astype(np.float32) @ np.float32([0.299, 0.587, 0.114])
    mask = np.zeros(alpha.shape, np.uint8)
    mask[-band_height:] = ((luminance[-band_height:] > 140) & (alpha[-band_height:] > 0)) * np.uint8(255)
    mask = cv2.dilate(mask, np.ones((3, 3), np.uint8))
    rgb[alpha == 0] = 0
    result = cv2.inpaint(rgb, mask, 3, cv2.INPAINT_TELEA)
    return Image.fromarray(np.dstack([result, np.where(alpha > 0, 255, 0).astype(np.uint8)]))


def prep(source: Path, work: Path, band_height: int = 12) -> int:
    load_entries(source)
    originals = sorted((source / "orig").glob("*.png"))
    if not originals:
        raise ValueError("No orig/*.png files")
    destination = work / "prep"
    destination.mkdir(parents=True, exist_ok=True)
    for path in originals:
        safe_name(path.stem)
        cleaned = erase_label(load_image(path, "RGBA"), band_height)
        cleaned.save(destination / path.name)
        cleaned.convert("RGB").save(destination / f"{path.stem}_rgb.png")
    return len(originals)


def panel_reference(work: Path, name: str, esr_dir: Path | None = None) -> Image.Image:
    image = load_image(work / "prep" / f"{name}_rgb.png")
    size = (image.width * 4, image.height * 4)
    bicubic = np.array(image.resize(size, Image.Resampling.BICUBIC), np.float32)
    rgb = cv2.GaussianBlur(bicubic, (0, 0), 1.2)
    if esr_dir is not None:
        edges = np.array(load_image(esr_dir / f"{name}_rgb.png").resize(size), np.float32)
        rgb = 0.75 * rgb + 0.25 * edges
    rgb = np.clip(rgb, 0, 255).astype(np.uint8)
    alpha = np.array(load_image(work / "prep" / f"{name}.png", "RGBA"))[..., 3]
    alpha = cv2.resize(alpha, size, interpolation=cv2.INTER_NEAREST)
    mask = cv2.dilate((alpha == 0).astype(np.uint8) * 255, np.ones((5, 5), np.uint8))
    mask[:6] = mask[-6:] = 255
    mask[:, :6] = mask[:, -6:] = 255
    rgb = cv2.inpaint(rgb, mask, 5, cv2.INPAINT_TELEA)
    return Image.fromarray(rgb).resize(PANEL_SIZE, Image.Resampling.BICUBIC)


def cell_rect(index: int) -> tuple[int, int, int, int]:
    width, height = PANEL_SIZE
    top = (SHEET_SIZE[1] - (2 * height + 24)) // 2
    return 24 + (index % 3) * (width + 24), top + (index // 3) * (height + 24), width, height


def sheets(source: Path, work: Path, subjects_file: Path, prompt_file: Path,
           style_reference: Path, esr_dir: Path | None = None) -> list[str]:
    """Select described IDs, deduplicate shared art, balance six-panel jobs by metadata kind."""
    subjects = json.loads(subjects_file.read_text(encoding="utf-8"))
    if not isinstance(subjects, dict) or any(not isinstance(v, str) or not v.strip() for v in subjects.values()):
        raise ValueError("subjects must be a JSON object mapping IDs to nonempty descriptions")
    template = prompt_file.read_text(encoding="utf-8")
    if "{PANELS}" not in template:
        raise ValueError("prompt template must contain {PANELS}")
    # Read the style reference before creating any jobs, so a missing file cannot leave a partial queue.
    load_image(style_reference)
    groups, seen = {}, set()
    for entry in load_entries(source):
        if not entry.get("file") or entry["id"] not in subjects or entry["cameo"] in seen:
            continue
        seen.add(entry["cameo"])
        groups.setdefault(entry.get("kind", ""), []).append(entry)
    if not seen:
        raise ValueError("No described IDs have original art")
    jobs = []
    for entries in groups.values():
        count = (len(entries) + 5) // 6
        offset = 0
        for group_index in range(count):
            amount = len(entries) // count + (group_index < len(entries) % count)
            rows = entries[offset:offset + amount]
            offset += amount
            tag = f"sheet{len(jobs) + 1:03d}"
            directory = work / "jobs" / tag
            # Rebuilding an existing job must not silently reuse an obsolete redraw.
            if directory.exists() and any((directory / name).exists() for name in ("start", "output.png")):
                raise ValueError(f"Job already ran; use a new work directory: {directory}")
            directory.mkdir(parents=True, exist_ok=True)
            image = Image.new("RGB", SHEET_SIZE, (28, 28, 30))
            layout, lines = [], []
            for index in range(6):
                x, y, width, height = cell_rect(index)
                if index < amount:
                    entry = rows[index]
                    image.paste(panel_reference(work, entry["cameo"], esr_dir), (x, y))
                    layout.append({"cameo": entry["cameo"], "id": entry["id"], "rect": [x, y, width, height]})
                    lines.append(f"- Panel {index + 1} ({POSITIONS[index]}): {subjects[entry['id']]}.")
                else:
                    image.paste((118, 118, 118), (x, y, x + width, y + height))
                    lines.append(f"- Panel {index + 1} ({POSITIONS[index]}): EMPTY - keep it a flat grey (118,118,118) rectangle.")
            image.save(directory / "input.png")
            shutil.copyfile(style_reference, directory / "style_reference.png")
            write_json(directory / "layout.json", layout)
            (directory / "prompt.txt").write_text(template.replace("{PANELS}", "\n".join(lines)).replace("{N}", str(amount)), encoding="utf-8")
            jobs.append(tag)
    (work / "queue.txt").write_text("\n".join(jobs) + "\n", encoding="utf-8")
    return jobs


def job_dirs(work: Path) -> list[Path]:
    queue = work / "queue.txt"
    if queue.exists():
        names = [safe_name(line.strip()) for line in queue.read_text(encoding="utf-8").splitlines() if line.strip()]
        if len(set(names)) != len(names):
            raise ValueError("Duplicate jobs in queue.txt")
        return [work / "jobs" / name for name in names]
    return sorted(path for path in (work / "jobs").iterdir() if path.is_dir())


def readable_output(directory: Path) -> bool:
    try:
        with Image.open(directory / "output.png") as image:
            image.load()
        return True
    except (OSError, ValueError):
        return False


def record_exit(directory: Path, code: int) -> None:
    (directory / "exit").write_text(f"{code}\n", encoding="utf-8")
    (directory / "end").write_text(f"{int(time.time())}\n", encoding="utf-8")


def run_jobs(work: Path, codex: str = "codex", concurrency: int = 3, poll_interval: float = 0.2) -> int:
    """Stop launching on limits/failures, drain active calls, and retain logs and resume markers."""
    if concurrency < 1 or poll_interval <= 0:
        raise ValueError("concurrency and poll interval must be positive")
    work = work.resolve()
    limit = work / "LIMIT"
    if limit.exists():
        return 2
    pending = job_dirs(work)
    if not pending:
        raise ValueError("No jobs to run")
    for directory in pending:
        (directory / "prompt.txt").read_text(encoding="utf-8")
        load_image(directory / "input.png")
    if os.path.dirname(codex):
        codex = str(Path(codex).resolve())
    running, status = {}, 0
    try:
        while pending or running:
            for directory, process in list(running.items()):
                code = process.poll()
                log = (directory / "run.log").read_text(encoding="utf-8", errors="replace")
                match = LIMIT_PATTERN.search(log)
                if match:
                    if not limit.exists():
                        limit.write_text(f"{directory.name}: {match.group()}\n", encoding="utf-8")
                    status = 2
                if code is not None:
                    record_exit(directory, code)
                    if (code != 0 or not readable_output(directory)) and status == 0:
                        status = 1
                    del running[directory]
            if limit.exists():
                status = 2
            if status:
                pending.clear()
            while pending and len(running) < concurrency:
                if limit.exists():
                    status = 2
                    pending.clear()
                    break
                directory = pending.pop(0)
                marker = directory / "exit"
                if marker.exists() and marker.read_text().strip() == "0" and readable_output(directory):
                    continue
                for name in ("output.png", "last.txt", "exit", "end"):
                    (directory / name).unlink(missing_ok=True)
                (directory / "start").write_text(f"{int(time.time())}\n", encoding="utf-8")
                command = [codex, "exec", "-s", "workspace-write", "-m", "gpt-6.1-sol", "-c",
                           'model_reasoning_effort="xhigh"', "--skip-git-repo-check", "-C", str(directory),
                           "-o", str(directory / "last.txt"), (directory / "prompt.txt").read_text(encoding="utf-8")]
                with (directory / "run.log").open("wb") as log:
                    running[directory] = subprocess.Popen(command, cwd=directory, stdin=subprocess.DEVNULL,
                                                          stdout=log, stderr=subprocess.STDOUT,
                                                          start_new_session=os.name == "posix")
            if running:
                time.sleep(poll_interval)
        return status
    finally:
        for process in running.values():
            if os.name == "posix":
                try:
                    os.killpg(process.pid, signal.SIGTERM)
                except ProcessLookupError:
                    pass
            else:
                process.terminate()
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


def gutter_spans(mean: np.ndarray, std: np.ndarray, count: int) -> list[tuple[int, int]] | None:
    """Find half-open panel spans between wide, dark, low-variance separator runs."""
    length = len(mean)
    indices = np.flatnonzero((mean < 50) & (std < 15))
    runs = np.split(indices, np.flatnonzero(np.diff(indices) > 1) + 1)
    minimum = max(2, round(length * 6 / 1536))
    gaps = [(int(run[0]), int(run[-1]) + 1) for run in runs if len(run) and
            (len(run) >= minimum or run[0] == 0 or run[-1] == length - 1)]
    cells = [(left[1], right[0]) for left, right in zip(gaps, gaps[1:])
             if right[0] - left[1] > length / (count + 1) * 0.4]
    return cells if len(cells) == count else None


def detect_grid(image: Image.Image) -> tuple[list, list] | None:
    grey = np.array(image.convert("L"), np.float32)
    columns = gutter_spans(grey.mean(0), grey.std(0), 3)
    rows = gutter_spans(grey.mean(1), grey.std(1), 2)
    return (columns, rows) if columns and rows else None


def aspect_crop(box: tuple[int, int, int, int], inset: int = 3) -> tuple[int, int, int, int]:
    """Largest centred exact 5:4 integer crop, after discarding the model's panel borders."""
    if inset < 0:
        raise ValueError("inset must be nonnegative")
    x0, y0, x1, y1 = box
    x0, y0, x1, y1 = x0 + inset, y0 + inset, x1 - inset, y1 - inset
    unit = min((x1 - x0) // 5, (y1 - y0) // 4)
    if unit < 1:
        raise ValueError("Panel too small after inset")
    width, height = unit * 5, unit * 4
    x0 += (x1 - x0 - width) // 2
    y0 += (y1 - y0 - height) // 2
    return x0, y0, x0 + width, y0 + height


def pack(source: Path, work: Path, output: Path, inset: int = 3) -> dict:
    entries = load_entries(source)
    output.mkdir(parents=True, exist_ok=True)
    (output / "orig").mkdir(exist_ok=True)
    (output / "hd").mkdir(exist_ok=True)
    for path in sorted((source / "orig").glob("*.png")):
        safe_name(path.stem)
        destination = output / "orig" / path.name
        if path.resolve() != destination.resolve():
            shutil.copyfile(path, destination)
    report = []
    for directory in job_dirs(work):
        if not (directory / "output.png").exists():
            report.append({"job": directory.name, "mode": "missing"})
            continue
        image = load_image(directory / "output.png")
        layout = json.loads((directory / "layout.json").read_text(encoding="utf-8"))
        if not isinstance(layout, list) or not 1 <= len(layout) <= 6:
            raise ValueError(f"Invalid cameo layout: {directory}")
        grid = detect_grid(image)
        native = load_image(directory / "input.png")
        for index, panel in enumerate(layout):
            name = safe_name(panel["cameo"])
            if grid:
                columns, rows = grid
                (x0, x1), (y0, y1) = columns[index % 3], rows[index // 3]
                mode = "gutter"
            else:
                x, y, width, height = panel["rect"]
                x0, x1 = round(x * image.width / native.width), round((x + width) * image.width / native.width)
                y0, y1 = round(y * image.height / native.height), round((y + height) * image.height / native.height)
                mode = "layout"
            if not (0 <= x0 < x1 <= image.width and 0 <= y0 < y1 <= image.height):
                raise ValueError(f"Panel out of bounds: {directory}/{name}")
            crop = aspect_crop((x0, y0, x1, y1), inset)
            image.crop(crop).resize(PANEL_SIZE, Image.Resampling.LANCZOS).save(output / "hd" / f"{name}.webp", quality=90, method=6)
            report.append({"job": directory.name, "cameo": name, "mode": mode, "crop": list(crop)})
    images = {path.stem: {"orig": f"orig/{path.name}"} for path in sorted((output / "orig").glob("*.png"))}
    for path in sorted((output / "hd").glob("*.webp")):
        images.setdefault(path.stem, {})["hd"] = f"hd/{path.name}"
    manifest = {"version": 1, "images": images, "byId": {entry["id"]: entry["cameo"] for entry in entries if entry.get("file")}}
    write_json(output / "index.json", manifest)
    write_json(work / "pack_report.json", report)
    return manifest


def read_csf(path: Path) -> dict[str, str]:
    """Read the first inverted UTF-16LE string per label, including WRTS extra data."""
    data, offset = path.read_bytes(), 0

    def take(length: int) -> bytes:
        nonlocal offset
        if offset + length > len(data):
            raise ValueError("Truncated CSF")
        value = data[offset:offset + length]
        offset += length
        return value

    def integer() -> int:
        return struct.unpack("<I", take(4))[0]

    if take(4) != b" FSC":
        raise ValueError("Invalid CSF signature")
    _, labels, _, _, _ = struct.unpack("<5I", take(20))
    result = {}
    for _ in range(labels):
        if take(4) != b" LBL":
            raise ValueError("Invalid CSF label tag")
        pairs, length = integer(), integer()
        name = take(length).decode("latin1").lower()
        values = []
        for _ in range(pairs):
            tag = take(4)
            if tag not in (b" RTS", b"WRTS"):
                raise ValueError("Invalid CSF string tag")
            raw = take(integer() * 2)
            values.append(bytes(value ^ 255 for value in raw).decode("utf-16-le"))
            if tag == b"WRTS":
                take(integer())
        result[name] = values[0] if values else ""
    return result


def caption(image: Image.Image, text: str, font: Path) -> Image.Image:
    image = image.convert("RGBA")
    overlay = Image.new("RGBA", image.size)
    draw = ImageDraw.Draw(overlay)
    for index in range(48):
        draw.line((0, image.height - 48 + index, image.width, image.height - 48 + index), fill=(0, 0, 0, int(205 * index / 48)))
    image = Image.alpha_composite(image, overlay)
    draw = ImageDraw.Draw(image)
    size = 30
    face = ImageFont.truetype(str(font), size)
    while draw.textlength(text, font=face) > image.width - 14 and size > 18:
        size -= 1
        face = ImageFont.truetype(str(font), size)
    draw.text(((image.width - draw.textlength(text, font=face)) / 2, image.height - size - 9), text,
              font=face, fill=(246, 242, 232), stroke_width=3, stroke_fill=(0, 0, 0))
    return image.convert("RGB")


def compare(source: Path, work: Path, output: Path, font: Path, csf: Path | None = None,
            labels_file: Path | None = None, group_field: str = "kind") -> list[Path]:
    strings = read_csf(csf) if csf else {}
    labels = json.loads(labels_file.read_text(encoding="utf-8")) if labels_file else {}
    face = ImageFont.truetype(str(font), 21)
    groups = {}
    for entry in load_entries(source):
        if not entry.get("file") or not (output / "hd" / f"{entry['cameo']}.webp").exists():
            continue
        label = labels.get(entry["id"], strings.get(entry.get("uiName", "").lower(), entry.get("name", entry["id"])))
        value = entry.get(group_field, "")
        group = ", ".join(map(str, value)) if isinstance(value, list) else str(value)
        groups.setdefault(group, []).append((entry, label))
    if not groups:
        raise ValueError("No original/HD pairs to compare")
    destination = work / "compare"
    destination.mkdir(parents=True, exist_ok=True)
    paths = []
    for index, (group, rows) in enumerate(groups.items(), 1):
        width, height = 2014, 110 + ((len(rows) + 3) // 4) * 240
        image = Image.new("RGB", (width, height), (20, 21, 24))
        draw = ImageDraw.Draw(image)
        draw.text((14, 18), f"侧栏图标 原版 | HD — {group}", font=ImageFont.truetype(str(font), 40), fill=(240, 240, 240))
        draw.text((14, 70), "每对左：原版 60x48（4 倍最近邻放大，烘焙名称）  右：HD 重绘 480x384（缩到 240x192，界面层真文字）", font=face, fill=(170, 175, 185))
        for item_index, (entry, label) in enumerate(rows):
            x, y = 14 + (item_index % 4) * 500, 110 + (item_index // 4) * 240
            original = load_image(source / entry["file"], "RGBA")
            original = Image.alpha_composite(Image.new("RGBA", original.size, (20, 21, 24, 255)), original).convert("RGB")
            image.paste(original.resize((240, 192), Image.Resampling.NEAREST), (x, y))
            hd = load_image(output / "hd" / f"{entry['cameo']}.webp").resize((240, 192), Image.Resampling.LANCZOS)
            image.paste(caption(hd, label, font), (x + 246, y))
            draw.text((x, y + 197), f"{label}  {entry['id']}", font=face, fill=(205, 208, 215))
        path = destination / f"cameos_{index:02d}.jpg"
        image.save(path, quality=90)
        image.resize((2000, round(height * 2000 / width)), Image.Resampling.LANCZOS).save(path.with_stem(path.stem + "_s"), quality=82)
        paths.append(path)
    return paths


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    commands = parser.add_subparsers(dest="command", required=True)
    for command in ("prep", "sheets", "run", "pack", "compare"):
        sub = commands.add_parser(command)
        sub.add_argument("--work", type=Path, required=True)
        if command != "run":
            sub.add_argument("--source", type=Path, required=True, help="extractor directory: cameos.json + orig/")
        if command in ("pack", "compare"):
            sub.add_argument("--output", type=Path, required=True, help="HD cameo cache directory")
        if command == "prep":
            sub.add_argument("--label-height", type=int, default=12)
        elif command == "sheets":
            sub.add_argument("--subjects", type=Path, required=True, help="JSON mapping IDs to English subject descriptions; selects the IDs to redraw")
            sub.add_argument("--prompt", type=Path, required=True, help="text template containing {PANELS} and optionally {N}")
            sub.add_argument("--style-reference", type=Path, required=True)
            sub.add_argument("--esr-dir", type=Path, help="optional pre-upscaled <cameo>_rgb.png edge references")
        elif command == "run":
            sub.add_argument("--codex", default="codex")
            sub.add_argument("--concurrency", type=int, default=3)
        elif command == "pack":
            sub.add_argument("--inset", type=int, default=3)
        else:
            sub.add_argument("--font", type=Path, default=Path("/System/Library/Fonts/STHeiti Medium.ttc"), help="Chinese font; pass a font path on other platforms")
            sub.add_argument("--csf", type=Path)
            sub.add_argument("--labels", type=Path, help="optional JSON mapping IDs to display labels (overrides CSF)")
            sub.add_argument("--group-field", default="kind", help="extractor metadata field, e.g. kind or owner")
    args = parser.parse_args(argv)
    try:
        if args.command == "prep":
            print(f"Prepared {prep(args.source, args.work, args.label_height)} originals")
        elif args.command == "sheets":
            print("Jobs:", ", ".join(sheets(args.source, args.work, args.subjects, args.prompt, args.style_reference, args.esr_dir)))
        elif args.command == "run":
            return run_jobs(args.work, args.codex, args.concurrency)
        elif args.command == "pack":
            manifest = pack(args.source, args.work, args.output, args.inset)
            print(f"Indexed {len(manifest['images'])} images; inspect {args.work / 'pack_report.json'} for missing jobs/layout fallbacks")
        else:
            print("Comparison sheets:", *compare(args.source, args.work, args.output, args.font, args.csf, args.labels, args.group_field))
        return 0
    except (OSError, ValueError, KeyError, cv2.error) as error:
        parser.exit(1, f"error: {error}\n")


if __name__ == "__main__":
    raise SystemExit(main())
