#!/usr/bin/env python3
"""Prepare layout-locked volumetric explosion redraw sheets and pack a variant.

``jobs`` writes input.png, layout.json, style_reference.png and prompt.txt for
each inclusive frame range. An approved sibling can guide the first chunk;
when editing later chunks, supply the preceding output as reference_previous.png.
Save each finished redraw as output.png in its job directory. ``pack`` cuts and
mattes those sheets, applies optional unsharp masking, fills missing frames from
the base HD library, and packs the variant under an exclusive file lock.
Only selected animations are replaced; other animations keep their atlas pixels.
The variant metadata is replaced atomically, including when it is a symlink.

Dependencies: numpy, Pillow and opencv-python. No game assets or models are
downloaded. Keep all job images and atlases in untracked artifact directories.
"""

from __future__ import annotations

import argparse
import fcntl
import json
import os
from pathlib import Path
import re
import shutil
import tempfile

import cv2
import numpy as np
from PIL import Image

import effect_flipbooks as ef

KIND = {
    "shell": "a shell / vehicle explosion (a fireball that bursts out, then turns into rolling smoke with flying debris)",
    "mushroom": "a big vehicle explosion with a rising mushroom-shaped fireball and smoke cloud (a fireball that bursts and rises, then turns into rolling smoke)",
    "ground": "a barrel / ground explosion (a wide, low burst that throws dirt, rubble and fragments outward along the ground, then leaves dust and smoke)",
}


def prompt(kind, n, cols, rows, first, last, total, size, previous=False, sibling=False) -> str:
    prevtxt = (
        "\n- reference_previous.png: the already redrawn PREVIOUS frames of this same animation (approved). Continue them "
        "seamlessly: same colours, lighting, fire, smoke and debris style, same level of detail; the same lobes and smoke masses "
        "keep evolving. Its layout does not apply; the layout comes from input.png."
    ) if previous else ""
    siblingtxt = (
        "Additional file:\n"
        "- sibling_reference.png: an APPROVED redraw of a sibling explosion of this same remaster (another animation, already accepted). "
        "Match its rendering style, palette, contrast and level of detail exactly, so all explosions of the game look like one family. "
        "Its layout and frames do not apply; the layout comes from input.png.\n\n"
    ) if sibling else ""
    W, H = size
    return f"""Task: image editing only. Do not write code other than what is needed to save/resize the image. Do not browse the web.

Files in this directory:
- input.png ({W}x{H} pixels): the DESIGN reference. A flipbook sheet of {n} consecutive frames (frames {first}..{last} of {total}) of {KIND[kind]} from the classic 2000 isometric real-time-strategy game Command & Conquer: Red Alert 2 (original low-resolution pixel art, smoothly upscaled). The frames are laid out in a {cols}x{rows} grid in reading order, each in its own cell on a flat grey (118,118,118) background. It defines for every cell WHERE the explosion is, HOW BIG it is and WHICH PHASE it is in (flash, fireball, smoke). It does NOT define the look.
- style_reference.png: the STYLE reference. Two explosions cropped from the approved concept painting of this private fan remaster, at about the same scale. Match their look: chaotic bright flame streaks and tongues mixed with black and brown smoke, chunky dark debris, real depth. Ignore the ground and units in it; copy only the explosion look, never its layout.{prevtxt}

{siblingtxt}Use your image generation / image editing tool with input.png (layout) and style_reference.png (look) to redraw EVERY cell as the same moment of a VOLUMETRIC 3D EXPLOSION, as a film-quality fluid / pyro simulation would render it, seen from the same high isometric camera (looking down at about 30 degrees). This is a private, personal, non-commercial fan remaster.

MUST NOT happen (this is why we redraw): an even orange ball; a round disc with a spiky rim; a symmetric blob; uniform colour; a flat cartoon / sticker / 2D look.

REQUIRED LOOK in every cell:
- shape: an irregular, asymmetric cluster of several billowing lobes, with flame tongues and fiery streaks shooting outward and upward; turbulent, ragged, broken edges; real depth: near lobes overlap far ones and smoke in front partly hides fire behind it;
- colour layering INSIDE the fireball: blinding white-hot core patches, bright yellow, orange, deep red / crimson, brown, then charcoal and black smoke; black and dark-brown soot pockets and streaks are INTERLEAVED inside the fire (not only around it), so the fire is broken up by dark smoke;
- lighting: daylight from the upper left lights the tops of the smoke; the undersides and lower right of the smoke are in shadow; the fire lights the surrounding smoke from inside with an orange-red glow;
- debris: chunky dark fragments of varied size (rock, metal, dirt clods) flying outward, the fast ones with short motion streaks, a few glowing orange-hot fragments and thin spark streaks;
- phases (follow input.png cell by cell): the first cells are a blinding white-yellow flash bursting outward into a rapidly expanding, IRREGULAR fireball with streaks and tongues (not a ball); then the full fireball with interleaved smoke; later the fire cools and shrinks into glowing red-orange embers inside rising, rolling dark smoke that takes over, while fragments fall;
- size and position: keep each cell's explosion about the same overall size and position as in input.png, with its bottom (the ground point) where it is; irregular edges, tongues and debris may reach up to about 15 % beyond the original outline;
- consistency: consecutive cells are consecutive frames of ONE continuous animation: the same lobes and smoke masses grow and evolve from cell to cell, with the same lighting and palette; do not merge, move, reorder or rescale cells;
- background: keep the flat grey (118,118,118) everywhere outside the explosion: no ground, no shadow, no scene, no vignette, no grid lines, no borders, no text, no numbers.

Save the result as output.png in this directory with exactly {W}x{H} pixels (if the tool returns another size, resize the whole generated image to exactly {W}x{H}; keep the whole sheet visible, never crop). Then reply with one line saying the tool used and the generated size before resizing.
"""


def style_reference(big: Path, small: Path) -> Image.Image:
    """Double both approved crops and join them with the original 24-pixel gap."""
    with Image.open(big) as image:
        a = image.convert("RGB")
    with Image.open(small) as image:
        b = image.convert("RGB")
    a = a.resize((a.width * 2, a.height * 2), Image.Resampling.LANCZOS)
    b = b.resize((b.width * 2, b.height * 2), Image.Resampling.LANCZOS)
    sheet = Image.new("RGB", (a.width + b.width + 24, max(a.height, b.height)), (118, 118, 118))
    sheet.paste(a, (0, 0))
    sheet.paste(b, (a.width + 24, 0))
    return sheet


def write_jobs(
    library: ef.EffectLibrary, anim: str, chunks: list[tuple[int, int]], jobs_dir: Path,
    big_ref: Path, small_ref: Path, kind="shell", cols=3, scale=3, sibling: Path | None = None,
) -> None:
    """Write portable ANIM_k jobs; later chunks request the previous approved sheet."""
    if kind not in KIND or not re.fullmatch(r"[A-Za-z0-9_-]+", anim):
        raise ValueError("unknown kind or invalid animation name")
    indices = library.frame_indices(anim)
    entry, _ = library.sprite(anim)
    if not chunks or cols < 1 or scale < 1:
        raise ValueError("jobs require chunks and positive cols/scale")
    last_end = -1
    for first, last in chunks:
        if not last_end < first <= last < len(indices):
            raise ValueError(f"{anim}: chunks must be ordered, nonoverlapping native frame ranges")
        last_end = last
    sref = style_reference(big_ref, small_ref)
    for k, (first, last) in enumerate(chunks):
        frames = list(range(first, last + 1))
        sheet, layout = ef.make_sheet(anim, indices, library.palette, frames, scale, cols)
        layout["footprint_grow"] = 12
        cells = layout["cells"]
        directory = Path(jobs_dir) / f"{anim}_{k}"
        directory.mkdir(parents=True, exist_ok=True)
        sheet.save(directory / "input.png")
        sref.save(directory / "style_reference.png")
        (directory / "layout.json").write_text(json.dumps(layout, indent=1), encoding="utf-8")
        (directory / "prompt.txt").write_text(prompt(
            kind, len(frames), len({c["x"] for c in cells}), len({c["y"] for c in cells}),
            first, last, entry["frameCount"], layout["size"],
            previous=k > 0, sibling=k == 0 and sibling is not None,
        ), encoding="utf-8")
        if k == 0 and sibling is not None:
            shutil.copyfile(sibling, directory / "sibling_reference.png")
        print(directory, sheet.size)


def sharpen(rgba: np.ndarray, amount: float, sigma=1.1) -> np.ndarray:
    # Unsharp mask on premultiplied sRGB colour; alpha receives only 30% of the colour adjustment.
    f = rgba.astype(np.float32)
    b = cv2.GaussianBlur(f, (0, 0), sigma)
    out = f.copy()
    out[..., :3] = f[..., :3] + amount * (f[..., :3] - b[..., :3])
    out[..., 3] = f[..., 3] + 0.3 * amount * (f[..., 3] - b[..., 3])
    return np.clip(out, 0, 255).round().astype(np.uint8)


def pack_variant(
    library: ef.EffectLibrary, anims: list[str], jobs_dir: Path, hd_dir: Path, base_dir: Path,
    tag="fx5", kind="explosion", sharpen_amount=0.8, lock: Path | None = None,
) -> dict:
    """Pack finished sheets with per-frame base fallback, preserving unrelated animations.

    The default lock is hd_dir/.json-patch.lock; callers sharing a wider cache
    mutation lock can inject that same lock path. Returned pages are filenames.
    """
    if not anims or len(set(anims)) != len(anims):
        raise ValueError("anims must be a nonempty list of unique names")
    if not re.fullmatch(r"[A-Za-z0-9_-]+", tag) or kind not in ef.KIND:
        raise ValueError("invalid tag or unknown matte kind")
    if any(not re.fullmatch(r"[A-Za-z0-9_-]+", name) for name in anims):
        raise ValueError("invalid animation name")
    hd_dir, base_dir, jobs_dir = Path(hd_dir), Path(base_dir), Path(jobs_dir)
    lock = Path(lock) if lock is not None else hd_dir / ".json-patch.lock"
    with lock.open("a") as handle:
        fcntl.flock(handle, fcntl.LOCK_EX)
        cur = json.loads((hd_dir / "effects-hd.json").read_text(encoding="utf-8"))
        base_meta = json.loads((base_dir / "effects-hd.json").read_text(encoding="utf-8"))
        base_pages = {}

        def base_frame(name, index):
            entry = base_meta["anims"].get(name)
            if not entry or index >= len(entry["frames"]) or entry["frames"][index] is None:
                return None
            frame = entry["frames"][index]
            page = frame["page"]
            if page not in base_pages:
                with Image.open(base_dir / base_meta["pages"][page]["file"]) as image:
                    base_pages[page] = np.array(image.convert("RGBA"))
            x, y, w, h = frame["rect"]
            return {"rgba": base_pages[page][y:y + h, x:x + w].copy(),
                    "offset": frame["offset"], "scale": entry["scale"]}

        packed, summary = {}, {}
        for name in anims:
            directories = sorted(d for d in jobs_dir.glob(f"{name}_*") if (d / "output.png").exists())
            new = ef.cut_anim(library, name, kind, directories)
            if sharpen_amount > 0:
                for frame in new:
                    if frame is not None:
                        frame["rgba"] = sharpen(frame["rgba"], sharpen_amount)
            frames = [frame if frame is not None else base_frame(name, i) for i, frame in enumerate(new)]
            summary[name] = {"new": sum(f is not None for f in new),
                             "base": sum(n is None and f is not None for n, f in zip(new, frames)),
                             "frames": len(frames)}
            packed[name] = (kind, frames)

        keep, remap = [], {}
        for index, page in enumerate(cur["pages"]):
            if not page["file"].startswith(f"effects-hd-{tag}-"):
                remap[index] = len(keep)
                keep.append(page)
        for name, entry in cur["anims"].items():
            if name in anims:
                continue
            for frame in entry["frames"]:
                if frame is not None:
                    if frame["page"] not in remap:
                        raise ValueError(f"{name} uses a dropped page")
                    frame["page"] = remap[frame["page"]]

        # Stage on the destination filesystem so page and metadata replacement use atomic renames.
        with tempfile.TemporaryDirectory(prefix=f".pack-{tag}-", dir=hd_dir) as temporary:
            staging = Path(temporary)
            meta = ef.pack(packed, staging)
            page_base = len(keep)
            for index, page in enumerate(meta["pages"]):
                filename = f"effects-hd-{tag}-{index}.png"
                os.replace(staging / page["file"], hd_dir / filename)
                keep.append({**page, "file": filename})
            for name in anims:
                entry = meta["anims"][name]
                for frame in entry["frames"]:
                    if frame is not None:
                        frame["page"] += page_base
                cur["anims"][name] = entry
            cur["pages"] = keep
            temporary_json = staging / "effects-hd.json"
            temporary_json.write_text(json.dumps(cur), encoding="utf-8")
            # Replaces the symlink itself without unlinking it or writing through to its target.
            os.replace(temporary_json, hd_dir / "effects-hd.json")
        summary["pages"] = [page["file"] for page in cur["pages"]]
        return summary


def parse_chunks(value: str) -> list[tuple[int, int]]:
    try:
        chunks = [tuple(map(int, chunk.split("-"))) for chunk in value.split(",")]
        if any(len(chunk) != 2 for chunk in chunks):
            raise ValueError
        return chunks
    except ValueError:
        raise argparse.ArgumentTypeError("expected first-last[,first-last]") from None


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    commands = parser.add_subparsers(dest="command", required=True)
    jobs = commands.add_parser("jobs", help="prepare layout-locked redraw jobs")
    jobs.add_argument("anim")
    jobs.add_argument("chunks", type=parse_chunks)
    jobs.add_argument("--big", type=Path, required=True)
    jobs.add_argument("--small", type=Path, required=True)
    jobs.add_argument("--kind", choices=KIND, default="shell")
    jobs.add_argument("--cols", type=ef.positive_int, default=3)
    jobs.add_argument("--scale", type=ef.positive_int, default=3)
    jobs.add_argument("--sibling", type=Path)
    pack = commands.add_parser("pack", help="pack finished jobs into a variant HD library")
    pack.add_argument("anims", help="comma-separated animation names")
    pack.add_argument("--hd", type=Path, required=True)
    pack.add_argument("--base", type=Path, required=True)
    pack.add_argument("--tag", default="fx5")
    pack.add_argument("--sharpen", type=float, default=0.8)
    for sub in (jobs, pack):
        sub.add_argument("--library", type=Path, required=True)
        sub.add_argument("--jobs", type=Path, required=True)
    args = parser.parse_args(argv)
    try:
        library = ef.EffectLibrary(args.library)
        if args.command == "jobs":
            write_jobs(library, args.anim, args.chunks, args.jobs, args.big, args.small,
                       args.kind, args.cols, args.scale, args.sibling)
        else:
            print(json.dumps(pack_variant(library, args.anims.split(","), args.jobs, args.hd,
                                          args.base, tag=args.tag, sharpen_amount=args.sharpen)))
        return 0
    except (OSError, ValueError, KeyError, IndexError) as error:
        parser.exit(1, f"{args.command}: {error}\n")
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
