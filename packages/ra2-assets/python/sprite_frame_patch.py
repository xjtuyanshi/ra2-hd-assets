#!/usr/bin/env python3
"""Apply approved per-frame PNG patches to an isolated map or paged sprite cache.

The spec is {"frames": [{"sprite": "tree:TREE20", "frame": 0, "hd": "TREE20_f00_2x.png",
"indexed": "TREE20_f00_1x.png"}]}. Paths are relative to the spec. Optional "shadow" is an indexed
shadow patch. Original names, frame rectangles, offsets, pages and palettes never change. The source cache
must already have HD metadata; missing HD is an error, not an instruction to invent/upscale other art.
Unchanged variant files remain symlinks, while edited PNGs replace entries atomically without writing through
symlinks. A pre-existing variant preserves edits from other tracks. All validation precedes variant writes.
"""

from __future__ import annotations

import argparse
import copy
import json
from pathlib import Path
import tempfile
import os

import numpy as np
from PIL import Image


def read(path: Path) -> dict:
    return json.loads(path.read_text())


def local_path(root: Path, name: str) -> Path:
    rel = Path(name)
    if rel.is_absolute() or '..' in rel.parts or not rel.parts:
        raise ValueError(f'unsafe relative path: {name!r}')
    return root / rel


def atomic_image(image: Image.Image, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=path.parent, suffix='.png', delete=False) as stream:
        tmp = Path(stream.name)
    try:
        image.save(tmp)
        os.replace(tmp, path)
    finally:
        tmp.unlink(missing_ok=True)


def apply(base: Path, variant: Path, spec_path: Path) -> dict:
    base, variant = base.resolve(), variant.resolve()
    if base == variant or base in variant.parents or variant in base.parents:
        raise ValueError('base and variant must be separate, non-nested directories')
    manifest_name = 'library.json' if (base / 'library.json').exists() else 'manifest.json'
    manifest_path = variant / manifest_name
    manifest = read(manifest_path if manifest_path.exists() else base / manifest_name)
    hd_refs = manifest.get('spriteAtlasesHd') or [manifest.get('spriteAtlasHd')]
    indexed_refs = manifest.get('spriteAtlases') or [manifest.get('spriteAtlas')]
    if not hd_refs or any(ref is None for ref in hd_refs):
        raise ValueError('cache has no HD atlas metadata; prepare HD separately before applying patches')
    spec = read(spec_path)
    frames = spec.get('frames')
    if not isinstance(frames, list) or not frames:
        raise ValueError('spec.frames must be a nonempty list')
    pages: dict[str, Image.Image] = {}
    seen: set[tuple[str, int]] = set()
    written_rects: dict[str, list[tuple[int, int, int, int]]] = {}
    report = {'frames': [], 'atlases': []}

    def paste(file: str, rect: list[int], patch_name: str, scale: int, indexed: bool) -> None:
        path = local_path(variant, file)
        if any(parent.is_symlink() for parent in path.parents if parent != variant and variant in parent.parents):
            raise ValueError(f'{file}: variant atlas parent must not be a symlink')
        if file not in pages:
            existing = path if path.exists() else local_path(base, file)
            with Image.open(existing) as image:
                pages[file] = image.copy()
        atlas = pages[file]
        x, y, w, h = [n * scale for n in rect]
        if w <= 0 or h <= 0 or x < 0 or y < 0 or x + w > atlas.width or y + h > atlas.height:
            raise ValueError(f'{file}: frame rectangle is outside the atlas')
        for px, py, pw, ph in written_rects.get(file, []):
            if x < px + pw and px < x + w and y < py + ph and py < y + h:
                raise ValueError(f'{file}: overlapping patch rectangles')
        with Image.open(local_path(spec_path.parent, patch_name)) as image:
            if image.size != (w, h):
                raise ValueError(f'{patch_name}: dimensions differ from the destination frame')
            if indexed:
                # tree_redraw emits R=index/A=coverage; library pages use one byte per texel.
                values = np.asarray(image.convert('RGBA'))[..., 0]
                if atlas.mode == 'L':
                    patch = Image.fromarray(values)
                elif atlas.mode == 'RGBA':
                    patch_array = np.zeros((h, w, 4), np.uint8)
                    patch_array[..., 0] = values
                    patch_array[..., 3] = np.where(values > 0, 255, 0)
                    patch = Image.fromarray(patch_array)
                else:
                    raise ValueError(f'{file}: unsupported indexed atlas mode {atlas.mode}')
            else:
                if atlas.mode != 'RGBA':
                    raise ValueError(f'{file}: HD atlas must be RGBA')
                patch = image.convert('RGBA')
        atlas.paste(patch, (x, y))
        written_rects.setdefault(file, []).append((x, y, w, h))

    for entry in frames:
        sprite, frame = entry['sprite'], entry['frame']
        if not isinstance(frame, int) or isinstance(frame, bool) or frame < 0:
            raise ValueError('frame index must be a nonnegative integer')
        if (sprite, frame) in seen:
            raise ValueError(f'duplicate frame patch: {sprite}/{frame}')
        seen.add((sprite, frame))
        source = manifest['sprites'][sprite]
        body = source['frames'][frame]
        page = body.get('page', 0)
        if hd_refs[page].get('scale', 2) != 2:
            raise ValueError('only 2x HD atlases are supported')
        paste(hd_refs[page]['file'], body['rect'], entry['hd'], 2, False)
        if entry.get('indexed'):
            paste(indexed_refs[page]['file'], body['rect'], entry['indexed'], 1, True)
        if entry.get('shadow'):
            shadow = source['shadows'][frame]
            paste(indexed_refs[shadow.get('page', 0)]['file'], shadow['rect'], entry['shadow'], 1, True)
        report['frames'].append({'sprite': sprite, 'frame': frame, 'rect': body['rect'], 'page': page,
                                 'shadow_updated': bool(entry.get('shadow'))})

    # Validation above reads all patches/pages before any output is created or modified.
    variant.mkdir(parents=True, exist_ok=True)
    for source in base.rglob('*'):
        destination = variant / source.relative_to(base)
        if source.is_dir():
            destination.mkdir(parents=True, exist_ok=True)
        elif not destination.exists() and not destination.is_symlink():
            destination.symlink_to(source.resolve())
    for file, image in pages.items():
        atomic_image(image, local_path(variant, file))
    report['atlases'] = sorted(pages)
    with tempfile.NamedTemporaryFile(mode='w', dir=variant, suffix='.json', delete=False) as stream:
        tmp = Path(stream.name)
        json.dump(report, stream, indent=2)
    os.replace(tmp, variant / 'sprite-frame-patches.json')
    return copy.deepcopy(report)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base', type=Path, required=True)
    parser.add_argument('--variant', type=Path, required=True)
    parser.add_argument('--spec', type=Path, required=True)
    args = parser.parse_args()
    result = apply(args.base, args.variant, args.spec)
    print(f'Applied {len(result["frames"])} frame patches to {args.variant}')


if __name__ == '__main__':
    main()
