#!/usr/bin/env python3
"""Pack per-frame higher-resolution sprite pages (e.g. 4x redraws) onto new library atlas pages.

The renderer samples an HD page with the UVs of its indexed page (hd-renderer README, `HdAtlasRef.scale`), so a page
at any integer scale works when it covers exactly `scale` times its indexed page. This tool therefore never changes the
existing pages: it builds new pages holding only the redrawn frames, at one scale per run,

- an indexed page with a byte-exact copy of each accepted frame's indexed pixels (coverage, house indices, shadows of
  the original stay authoritative),
- the HD colour page (house paint written as the grey ramp grey = 255 - (index - 16) * 15, as `hd:sprites` writes it)
  and the house-paint mask at `scale` times the indexed page,
- a material page copied from the source frames' material pages (normals.json) when they have one, so the enhanced
  look's relighting stays what it was,

then points the accepted frames of each listed sprite at the new page (rect and page only; offsets, frame order and
every other field stay) and adds the new pages to the `atlasPages` of the types drawing those sprites. Frames without
a page, or whose page fails the registration check, keep their current page: the existing 2x art is the fallback per
type and per frame.

Frame index (`--frames`), paths relative to it:

    {"scale": 4, "sprites": {"infantry:GI": {"frames": {"0": {"colour": "c/000.png", "paint": "p/000.png",
                                                             "origin": [-20, -30]}}}}}

`colour` is RGBA at `scale` HD px per game px, `paint` a grey house-paint weight of the same size (optional: absent
means no house paint). `origin` is the game-pixel position of the page's top-left corner in the coordinates of the
frame's `offset` (relative to the sprite origin), so a page may be larger than the frame; content outside the frame
rectangle feeds the gutter only (the renderer clips the art to the original's coverage).

Writes into `--out` (must be new): the pages under content names, library.json (and normals.json when a material page
was built), receipt.json. `--farm ROOT --rel _library/<theater>` instead installs into a copy-on-write farm through
cache_farm (pages hard-linked, JSON patched under its lock, never writing through a symlink into the base cache); the
patch refuses when a frame changed since validation. `--farm ROOT --rel ... --uninstall RECEIPT...` undoes such
installs surgically (see `uninstall`): later edits of the library (other installs, map preparation) stay.
"""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import math
from pathlib import Path
import sys

import numpy as np
from PIL import Image

HOUSE_FIRST, HOUSE_LAST = 16, 31


def _relative(root: Path, name: str) -> Path:
    rel = Path(name)
    if rel.is_absolute() or '..' in rel.parts or not rel.parts:
        raise ValueError(f'unsafe relative path: {name!r}')
    return root / rel


def _rgba(path: Path) -> np.ndarray:
    return np.asarray(Image.open(path).convert('RGBA'), dtype=np.uint8)


def _grey(path: Path) -> np.ndarray:
    return np.asarray(Image.open(path).convert('L'), dtype=np.uint8)


def _window(image: np.ndarray, x: int, y: int, w: int, h: int) -> np.ndarray:
    """image[y:y+h, x:x+w] with zeros outside the image."""
    out = np.zeros((h, w) + image.shape[2:], image.dtype)
    x0, y0, x1, y1 = max(x, 0), max(y, 0), min(x + w, image.shape[1]), min(y + h, image.shape[0])
    if x1 > x0 and y1 > y0:
        out[y0 - y:y1 - y, x0 - x:x1 - x] = image[y0:y1, x0:x1]
    return out


def area_down(alpha: np.ndarray, scale: int) -> np.ndarray:
    h, w = alpha.shape[0] // scale, alpha.shape[1] // scale
    return alpha[:h * scale, :w * scale].reshape(h, scale, w, scale).mean(axis=(1, 3))


def frame_metrics(indexed: np.ndarray, alpha: np.ndarray, paint: np.ndarray, rgb: np.ndarray, scale: int,
                  exclude: tuple[int, ...] = ()) -> dict:
    """Registration of a page frame against the original frame (both cropped to the frame rectangle).

    iou/cover use the HD alpha area-averaged to game px (> 0.5) against the original's opaque pixels; cover is the
    share of the original's pixels the page covers (holes there would show the ground through the soldier).
    `exclude`: indices whose pixels the page deliberately draws translucent (e.g. a contact-shadow footprint painted
    with one palette index); their game px count for neither side of iou/cover.
    house_agree: share of the original's house pixels that carry paint weight > 0.5 in the page.
    paint_grey: mean |r-g|+|g-b| of the page's painted texels (0 = the grey encoding the renderer decodes)."""
    excluded = np.isin(indexed, exclude) if exclude else np.zeros(indexed.shape, bool)
    orig = (indexed > 0) & ~excluded
    hd = (area_down(alpha.astype(np.float32) / 255, scale) > 0.5) & ~excluded
    inter, union = (orig & hd).sum(), (orig | hd).sum()
    house = (indexed >= HOUSE_FIRST) & (indexed <= HOUSE_LAST)
    painted_game = area_down(paint.astype(np.float32) / 255, scale) > 0.5
    painted = paint > 127
    grey = (np.abs(rgb[..., 0].astype(int) - rgb[..., 1]) + np.abs(rgb[..., 1].astype(int) - rgb[..., 2]))[painted]
    return {
        'iou': round(float(inter / union) if union else 1.0, 4),
        'cover': round(float(inter / orig.sum()) if orig.sum() else 1.0, 4),
        'house_agree': round(float((house & painted_game).sum() / house.sum()) if house.sum() else 1.0, 4),
        'paint_grey': round(float(grey.mean()) if grey.size else 0.0, 2),
    }


def dilate_colour(rgba: np.ndarray, steps: int) -> np.ndarray:
    """Bleed opaque colour into fully transparent texels (alpha stays 0), so filtering and mips never pull in black."""
    out = rgba.copy()
    known = out[..., 3] > 0
    rgb = out[..., :3].astype(np.float32)
    for _ in range(steps):
        if known.all():
            break
        acc = np.zeros_like(rgb)
        cnt = np.zeros(known.shape, np.float32)
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                if not dx and not dy:
                    continue
                k = np.roll(np.roll(known, dy, 0), dx, 1)
                acc += np.roll(np.roll(rgb, dy, 0), dx, 1) * k[..., None]
                cnt += k
        fill = (~known) & (cnt > 0)
        rgb[fill] = acc[fill] / cnt[fill, None]
        known = known | fill
    out[..., :3] = np.clip(np.rint(rgb), 0, 255).astype(np.uint8)
    return out


def shelf_pack(sizes: list[tuple[int, int]], gutter: int, max_side: int) -> tuple[list[tuple[int, int, int]], list[tuple[int, int]]]:
    """Place (w, h) boxes with `gutter` px between and around them. Returns per box (page, x, y) and page sizes."""
    order = sorted(range(len(sizes)), key=lambda i: (-sizes[i][1], -sizes[i][0], i))
    area = sum((w + gutter) * (h + gutter) for w, h in sizes)
    widest = max((w for w, _ in sizes), default=0) + 2 * gutter
    width = min(max_side, max(widest, int(math.ceil(math.sqrt(area * 1.15) / 16.0)) * 16))
    if widest > max_side:
        raise ValueError(f'a frame of {widest - 2 * gutter} px does not fit a page of {max_side} px')
    places: list[tuple[int, int, int] | None] = [None] * len(sizes)
    pages: list[tuple[int, int]] = []
    page, x, y, row = 0, gutter, gutter, 0
    for i in order:
        w, h = sizes[i]
        if h + 2 * gutter > max_side:
            raise ValueError(f'a frame of height {h} does not fit a page of {max_side} px')
        if x + w + gutter > width:
            x, y, row = gutter, y + row + gutter, 0
        if y + h + gutter > max_side:
            pages.append((width, y + row + gutter if x > gutter else y))
            page, x, y, row = page + 1, gutter, gutter, 0
        places[i] = (page, x, y)
        x += w + gutter
        row = max(row, h)
    pages.append((width, y + row + gutter))
    # Even dimensions keep every mip level's texel grid aligned with the frame grid for one more level.
    pages = [(w + (w & 1), h + (h & 1)) for w, h in pages]
    return [p for p in places if p is not None], pages


class Plan:
    """Validated input: accepted frames with their pixels, rejected frames with reasons."""

    def __init__(self, library_dir: Path, frames_index: Path, *, min_iou: float, min_cover: float,
                 exclude: tuple[int, ...] = ()):
        self.library_dir = library_dir
        self.library = json.loads((library_dir / 'library.json').read_text(encoding='utf-8'))
        normals_path = library_dir / 'normals.json'
        self.normals = json.loads(normals_path.read_text(encoding='utf-8')) if normals_path.exists() else None
        index = json.loads(frames_index.read_text(encoding='utf-8'))
        root = frames_index.parent
        self.scale = int(index['scale'])
        if self.scale < 2 or self.scale != index['scale']:
            raise ValueError('scale must be an integer of at least 2')
        atlases = self.library['spriteAtlases']
        hd_refs = self.library.get('spriteAtlasesHd')
        if not isinstance(hd_refs, list) or len(hd_refs) != len(atlases):
            raise ValueError('library.json must hold spriteAtlasesHd inline, one entry per indexed page')
        self.accepted: list[dict] = []
        self.rejected: list[dict] = []
        indexed_pages: dict[int, np.ndarray] = {}
        for sprite_key, sprite_spec in index['sprites'].items():
            sprite = self.library['sprites'].get(sprite_key)
            if sprite is None:
                raise ValueError(f'unknown sprite {sprite_key}')
            for key, spec in sprite_spec['frames'].items():
                i = int(key)
                if not 0 <= i < len(sprite['frames']):
                    raise ValueError(f'{sprite_key} has no frame {i}')
                frame = sprite['frames'][i]
                x, y, w, h = frame['rect']
                record = {'sprite': sprite_key, 'frame': i, 'page': frame.get('page', 0), 'rect': [x, y, w, h]}
                if w <= 0 or h <= 0:
                    self.rejected.append({**record, 'reason': 'empty frame'})
                    continue
                page = record['page']
                if page not in indexed_pages:
                    indexed_pages[page] = _grey(_relative(library_dir, atlases[page]['file']))
                indexed = indexed_pages[page][y:y + h, x:x + w]
                colour = _rgba(_relative(root, spec['colour']))
                paint = _grey(_relative(root, spec['paint'])) if spec.get('paint') else np.zeros(colour.shape[:2], np.uint8)
                if paint.shape != colour.shape[:2]:
                    raise ValueError(f'{sprite_key} frame {i}: paint and colour sizes differ')
                ox, oy = spec['origin']
                s = self.scale
                fx, fy = (frame['offset'][0] - ox) * s, (frame['offset'][1] - oy) * s
                crop = _window(colour, fx, fy, w * s, h * s)
                metrics = frame_metrics(indexed, crop[..., 3], _window(paint, fx, fy, w * s, h * s), crop, s,
                                        exclude)
                record.update(metrics=metrics)
                reasons = []
                if metrics['iou'] < min_iou:
                    reasons.append(f"iou {metrics['iou']} < {min_iou}")
                if metrics['cover'] < min_cover:
                    reasons.append(f"cover {metrics['cover']} < {min_cover}")
                if reasons:
                    self.rejected.append({**record, 'reason': '; '.join(reasons)})
                    continue
                self.accepted.append({**record, 'indexed': indexed.copy(), 'colour': colour, 'paint': paint,
                                      'at': (fx, fy)})


def build(plan: Plan, *, gutter: int, max_side: int) -> dict:
    """Pages and the library edit for the accepted frames (nothing written)."""
    s = plan.scale
    # One placement per distinct source rectangle: frames that share art keep sharing it.
    unique: dict[tuple, int] = {}
    for item in plan.accepted:
        source = (item['page'], *item['rect'])
        if source not in unique:
            unique[source] = len(unique)
        item['slot'] = unique[source]
    firsts = {item['slot']: item for item in reversed(plan.accepted)}
    sizes = [(firsts[k]['rect'][2], firsts[k]['rect'][3]) for k in range(len(unique))]
    if not sizes:
        return {'pages': [], 'frames': []}
    places, page_sizes = shelf_pack(sizes, gutter, max_side // s)
    margin = gutter // 2
    pages = []
    for (pw, ph) in page_sizes:
        pages.append({'indexed': np.zeros((ph, pw), np.uint8), 'colour': np.zeros((ph * s, pw * s, 4), np.uint8),
                      'paint': np.zeros((ph * s, pw * s), np.uint8), 'frames': 0})
    for slot, (p, x, y) in enumerate(places):
        item = firsts[slot]
        w, h = item['rect'][2], item['rect'][3]
        page = pages[p]
        page['indexed'][y:y + h, x:x + w] = item['indexed']
        fx, fy = item['at']
        m = margin * s
        page['colour'][(y - margin) * s:(y + h + margin) * s, (x - margin) * s:(x + w + margin) * s] = _window(
            item['colour'], fx - m, fy - m, (w + 2 * margin) * s, (h + 2 * margin) * s)
        page['paint'][(y - margin) * s:(y + h + margin) * s, (x - margin) * s:(x + w + margin) * s] = _window(
            item['paint'], fx - m, fy - m, (w + 2 * margin) * s, (h + 2 * margin) * s)
        page['frames'] += 1
        item['new'] = (p, [x, y, w, h])
    for item in plan.accepted:
        item['new'] = firsts[item['slot']]['new']
    for page in pages:
        page['colour'] = dilate_colour(page['colour'], 2 * s)
    _materials(plan, pages, places, firsts)
    return {'pages': pages, 'frames': plan.accepted}


def _materials(plan: Plan, pages: list[dict], places, firsts) -> None:
    """Copy material texels of the moved frames (normals.json pages) at the source pages' common material scale."""
    entries = (plan.normals or {}).get('pages') or {}
    atlases = plan.library['spriteAtlases']
    scales = set()
    for item in firsts.values():
        entry = entries.get(str(item['page']))
        if entry:
            ratio = entry['materialWidth'] / atlases[item['page']]['width']
            scales.add(ratio if ratio == int(ratio) and ratio >= 1 else None)
    if not scales:
        return
    if len(scales) != 1 or None in scales:
        print(f'material pages: mixed or non-integer scales {sorted(map(str, scales))}; no material page',
              file=sys.stderr)
        return
    ms = int(scales.pop())
    sources: dict[int, np.ndarray] = {}
    for page in pages:
        h, w = page['indexed'].shape
        page['materials'] = np.zeros((h * ms, w * ms, 4), np.uint8)
        page['material_frames'] = 0
    for slot, (p, x, y) in enumerate(places):
        item = firsts[slot]
        entry = entries.get(str(item['page']))
        if not entry:
            continue
        if item['page'] not in sources:
            sources[item['page']] = _rgba(_relative(plan.library_dir, entry['file']))
        sx, sy, w, h = item['rect']
        block = sources[item['page']][sy * ms:(sy + h) * ms, sx * ms:(sx + w) * ms]
        if not block[..., 3].any():
            continue  # this art has no material data (e.g. infantry are not relit): nothing to carry over
        pages[p]['materials'][y * ms:(y + h) * ms, x * ms:(x + w) * ms] = block
        pages[p]['material_frames'] += 1
    for page in pages:
        if not page['material_frames']:
            del page['materials']
    plan.material_scale = ms


def _png(array: np.ndarray, mode: str) -> tuple[bytes, str]:
    import io
    buffer = io.BytesIO()
    Image.fromarray(array, mode).save(buffer, format='PNG', optimize=False)
    data = buffer.getvalue()
    return data, hashlib.sha256(data).hexdigest()


def encode(plan: Plan, built: dict) -> tuple[dict[str, bytes], list[dict]]:
    """Content-named files and the page records (their library/normals entries)."""
    s = plan.scale
    files: dict[str, bytes] = {}
    records = []
    hd_refs = plan.library['spriteAtlasesHd']
    for page in built['pages']:
        data, digest = _png(page['indexed'], 'L')
        stem = f'sprites-hd{s}x-{digest[:16]}'
        names = {'indexed': f'{stem}.png', 'colour': f'{stem}@{s}x.png', 'paint': f'{stem}@{s}x-remap.png'}
        files[names['indexed']] = data
        files[names['colour']] = _png(page['colour'], 'RGBA')[0]
        files[names['paint']] = _png(page['paint'], 'L')[0]
        h, w = page['indexed'].shape
        hd_ref = {'file': names['colour'], 'remap': names['paint'], 'scale': s, 'width': w * s, 'height': h * s}
        saturations = {hd_refs[f['page']].get('paintSaturation', 1) for f in built['frames'] if hd_refs[f['page']]}
        if len(saturations) == 1 and saturations != {1}:
            hd_ref['paintSaturation'] = saturations.pop()
        record = {'atlas': {'file': names['indexed'], 'width': w, 'height': h}, 'hd': hd_ref, 'frames': page['frames']}
        if 'materials' in page:
            name = f'{stem}@{s}x-normals.png'
            files[name] = _png(page['materials'], 'RGBA')[0]
            mh, mw = page['materials'].shape[:2]
            record['materials'] = {'file': name, 'atlas': hd_ref['file'], 'width': hd_ref['width'],
                                   'height': hd_ref['height'], 'scale': s, 'materialWidth': mw,
                                   'materialHeight': mh, 'frames': page['material_frames']}
        records.append(record)
    return files, records


def edit_library(library: dict, plan_frames: list[dict], records: list[dict]) -> list[int]:
    """Append the pages and point the accepted frames at them; refuses when a frame changed since validation."""
    atlases, hd_refs = library['spriteAtlases'], library['spriteAtlasesHd']
    if len(hd_refs) != len(atlases):
        raise ValueError('spriteAtlasesHd no longer matches spriteAtlases')
    first = len(atlases)
    for record in records:
        atlases.append(record['atlas'])
        hd_refs.append(record['hd'])
    sprites = set()
    for item in plan_frames:
        frame = library['sprites'][item['sprite']]['frames'][item['frame']]
        if frame.get('page', 0) != item['page'] or list(frame['rect']) != item['rect']:
            raise ValueError(f"{item['sprite']} frame {item['frame']} changed since validation")
        page, rect = item['new']
        frame['page'] = first + page
        frame['rect'] = rect
        sprites.add(item['sprite'])
    new_pages = list(range(first, first + len(records)))
    for t in library.get('types', {}).values():
        if t.get('sprite') in sprites:
            t['atlasPages'] = sorted(set(t.get('atlasPages', [])) | set(new_pages))
    return new_pages


def edit_normals(normals: dict, first: int, records: list[dict]) -> None:
    pages = normals.setdefault('pages', {})
    for k, record in enumerate(records):
        if 'materials' in record:
            pages[str(first + k)] = record['materials']


def receipt(plan: Plan, records: list[dict], new_pages: list[int], files: dict[str, bytes]) -> dict:
    return {
        'scale': plan.scale,
        'pages': [{'index': i, **{k: v for k, v in r.items()}} for i, r in zip(new_pages, records)],
        'files': {name: hashlib.sha256(data).hexdigest() for name, data in files.items()},
        'accepted': [{k: item[k] for k in ('sprite', 'frame', 'page', 'rect', 'metrics')} |
                     {'newPage': new_pages[item['new'][0]], 'newRect': item['new'][1]} for item in plan.accepted],
        'fallback': plan.rejected,
    }


class UninstallError(ValueError):
    """The library no longer holds an install's pages as written, or removing them would break another edit."""


def _digest(entry) -> str:
    return hashlib.sha256(json.dumps(entry, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def _receipt_files(receipts: list[dict]) -> dict[str, str]:
    return {name: digest for r in receipts for name, digest in r['files'].items()}


def uninstall(library: dict, receipts: list[dict], *, library_dir: Path | None = None,
              normals: dict | None = None) -> dict:
    """Remove the pages of farm installs (their receipts) from `library` (and `normals`) in place.

    Surgical: only what the receipts added is undone; every later edit of the library stays. Pages are found by
    their content-named atlas file (indices may have moved since the install) and must still equal the receipt's
    records (canonical-JSON sha256). A frame still pointing at its receipt rectangle gets its original page and rect
    back; with `library_dir` the original rectangle's indexed pixels must equal the installed page's byte-exact copy
    (proving the original page index still names the same art). Frames edited since the install are left alone, but
    nothing may still draw from a removed page. Later pages move down; that is refused for a page the map
    preparation upscales itself (scale 2 or no HD page: its prepare state is keyed by page index)."""
    atlases, hd_refs = library['spriteAtlases'], library['spriteAtlasesHd']
    if len(hd_refs) != len(atlases):
        raise UninstallError('spriteAtlasesHd no longer matches spriteAtlases')
    by_file = {a.get('file'): i for i, a in enumerate(atlases)}
    remove: dict[int, dict] = {}
    index_maps = []
    for r in receipts:
        index_map = {}
        for page in r['pages']:
            i = by_file.get(page['atlas']['file'])
            if i is None:
                raise UninstallError(f"page {page['atlas']['file']} is not in the library (already removed?)")
            if _digest(atlases[i]) != _digest(page['atlas']) or _digest(hd_refs[i]) != _digest(page['hd']):
                raise UninstallError(f"page {i} ({page['atlas']['file']}) changed since the install")
            remove[i] = page
            index_map[page['index']] = i
        index_maps.append(index_map)
    indexed: dict[str, np.ndarray] = {}

    def pixels(page: int) -> np.ndarray:
        name = atlases[page]['file']
        if name not in indexed:
            indexed[name] = _grey(_relative(library_dir, name))
        return indexed[name]

    restored, kept = 0, []
    for r, index_map in zip(receipts, index_maps):
        for item in r['accepted']:
            frames = library['sprites'].get(item['sprite'], {}).get('frames', [])
            frame = frames[item['frame']] if item['frame'] < len(frames) else None
            current = index_map[item['newPage']]
            if frame is None or frame.get('page', 0) != current or list(frame['rect']) != item['newRect']:
                kept.append({'sprite': item['sprite'], 'frame': item['frame']})
                continue
            page, rect = item['page'], list(item['rect'])
            if page in remove or not 0 <= page < len(atlases):
                raise UninstallError(f"{item['sprite']} frame {item['frame']}: original page {page} is gone")
            if library_dir is not None:
                (x, y, w, h), (nx, ny, _, _) = rect, item['newRect']
                if not np.array_equal(pixels(page)[y:y + h, x:x + w], pixels(current)[ny:ny + h, nx:nx + w]):
                    raise UninstallError(f"{item['sprite']} frame {item['frame']}: page {page} no longer holds "
                                         'the original art at its receipt rectangle')
            frame['page'], frame['rect'] = page, rect
            restored += 1
    removed = sorted(remove)
    users = sorted({f"{key} {kind} {n}" for key, sprite in library['sprites'].items()
                    for kind in ('frames', 'shadows') for n, frame in enumerate(sprite.get(kind) or [])
                    if frame.get('page', 0) in remove})
    if users:
        raise UninstallError(f"{len(users)} frames still draw from the removed pages, e.g. {users[:3]}")
    shifted = [i for i in range(removed[0] + 1, len(atlases)) if i not in remove] if removed else []
    unsafe = [i for i in shifted if not hd_refs[i] or hd_refs[i].get('scale', 2) == 2]
    if unsafe:
        raise UninstallError(f'pages {unsafe} would move down but are upscaled by map preparation (keyed by index)')

    def renumber(i: int) -> int:
        return i - sum(1 for r in removed if r < i)

    for i in reversed(removed):
        del atlases[i], hd_refs[i]
    for sprite in library['sprites'].values():
        for kind in ('frames', 'shadows'):
            for frame in sprite.get(kind) or []:
                if 'page' in frame:
                    frame['page'] = renumber(frame['page'])
    for t in library.get('types', {}).values():
        if 'atlasPages' in t:
            t['atlasPages'] = sorted({renumber(p) for p in t['atlasPages'] if p not in remove})
    if normals is not None:
        uninstall_normals(normals, removed)
    return {'removedPages': removed, 'restoredFrames': restored, 'keptFrames': kept,
            'movedPages': {i: renumber(i) for i in shifted}}


def referenced_files(library: dict, normals: dict | None) -> set[str]:
    names = {a.get('file') for a in library['spriteAtlases']}
    for ref in library['spriteAtlasesHd']:
        if ref:
            names |= {ref.get('file'), ref.get('remap')}
    for entry in ((normals or {}).get('pages') or {}).values():
        names.add(entry.get('file'))
    return {n for n in names if n}


def _uninstall_farm(args) -> int:
    import cache_farm
    receipts = [json.loads(p.read_text(encoding='utf-8')) for p in args.uninstall]
    directory = args.farm / args.rel
    normals_path = directory / 'normals.json'
    state = {}

    def patch_library(library):
        state['report'] = uninstall(library, receipts, library_dir=directory)
        state['library'] = library

    try:
        cache_farm.patch_json(args.farm, f'{args.rel}/library.json', patch_library)
    except UninstallError as error:
        print(f'refused: {error}', file=sys.stderr)
        return 5
    report = state['report']
    removed = report['removedPages']
    normals = json.loads(normals_path.read_text(encoding='utf-8')) if normals_path.exists() else None
    # Same lock order as the install (library, then normals); untouched unless it holds a removed or moved page.
    if removed and any(int(k) >= removed[0] for k in ((normals or {}).get('pages') or {})):
        cache_farm.patch_json(args.farm, f'{args.rel}/normals.json', lambda n: uninstall_normals(n, removed))
        normals = json.loads(normals_path.read_text(encoding='utf-8'))
    live = referenced_files(state['library'], normals)
    deleted, left = 0, []
    for name, digest in _receipt_files(receipts).items():
        path = _relative(directory, name)
        # Never a symlink into a base cache, never a file something still references or that changed since.
        if name in live or path.is_symlink() or not path.is_file() or \
                hashlib.sha256(path.read_bytes()).hexdigest() != digest:
            left.append(name)
            continue
        path.unlink()
        deleted += 1
    report.update(deletedFiles=deleted, leftFiles=left)
    print(json.dumps(report))
    return 0


def uninstall_normals(normals: dict, removed: list[int]) -> None:
    gone = set(removed)
    normals['pages'] = {str(int(k) - sum(1 for r in removed if r < int(k))): v
                        for k, v in (normals.get('pages') or {}).items() if int(k) not in gone}


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    parser.add_argument('--library', type=Path, help='theater library directory (read only)')
    parser.add_argument('--frames', type=Path, help='frame index JSON (see module docstring)')
    parser.add_argument('--out', type=Path, help='new staging directory for pages, library.json, receipt.json')
    parser.add_argument('--farm', type=Path, help='copy-on-write farm root to install into (with --rel)')
    parser.add_argument('--rel', help='library directory inside the farm, e.g. _library/urban')
    parser.add_argument('--receipt', type=Path, help='receipt path for --farm installs (must be new)')
    parser.add_argument('--min-iou', type=float, default=0.8)
    parser.add_argument('--min-cover', type=float, default=0.9)
    parser.add_argument('--exclude-index', type=int, action='append', default=[], metavar='INDEX',
                        help='indexed colour left out of the iou/cover registration (repeatable), e.g. a footprint '
                             'the pages draw translucent on purpose')
    parser.add_argument('--gutter', type=int, default=4, help='indexed px between frames (half of it is bled art)')
    parser.add_argument('--max-side', type=int, default=8192, help='largest HD page side in texels')
    parser.add_argument('--validate-only', action='store_true')
    parser.add_argument('--uninstall', type=Path, action='append', metavar='RECEIPT',
                        help='with --farm/--rel: remove the pages these install receipts added, keeping every later '
                             'library edit (repeatable; see uninstall())')
    args = parser.parse_args(argv)
    if args.uninstall:
        if args.farm is None or not args.rel:
            parser.error('--uninstall needs --farm and --rel')
        return _uninstall_farm(args)
    if args.library is None or args.frames is None:
        parser.error('--library and --frames are required')
    if (args.out is None) == (args.farm is None) and not args.validate_only:
        parser.error('give exactly one of --out and --farm')
    if args.farm is not None and not (args.rel and args.receipt):
        parser.error('--farm needs --rel and --receipt')
    plan = Plan(args.library, args.frames, min_iou=args.min_iou, min_cover=args.min_cover,
                exclude=tuple(args.exclude_index))
    if args.validate_only:
        json.dump({'accepted': [{k: i[k] for k in ('sprite', 'frame', 'metrics')} for i in plan.accepted],
                   'fallback': plan.rejected}, sys.stdout, indent=1)
        print()
        return 0
    built = build(plan, gutter=args.gutter, max_side=args.max_side)
    files, records = encode(plan, built)
    if args.out is not None:
        args.out.mkdir(parents=True, exist_ok=False)
        for name, data in files.items():
            (args.out / name).write_bytes(data)
        library = copy.deepcopy(plan.library)
        new_pages = edit_library(library, built['frames'], records)
        (args.out / 'library.json').write_text(json.dumps(library, separators=(',', ':')), encoding='utf-8')
        if plan.normals is not None and any('materials' in r for r in records):
            normals = copy.deepcopy(plan.normals)
            edit_normals(normals, new_pages[0], records)
            (args.out / 'normals.json').write_text(json.dumps(normals, separators=(',', ':')), encoding='utf-8')
        result = receipt(plan, records, new_pages, files)
        (args.out / 'receipt.json').write_text(json.dumps(result, indent=1), encoding='utf-8')
    else:
        import tempfile
        import cache_farm
        if args.receipt.exists():
            raise SystemExit(f'{args.receipt} exists')
        with tempfile.TemporaryDirectory(dir=args.receipt.parent) as temp:
            for name, data in files.items():
                (Path(temp) / name).write_bytes(data)
                cache_farm.install_file(args.farm, f'{args.rel}/{name}', Path(temp) / name)
        state = {}

        def patch_library(library):
            state['pages'] = edit_library(library, built['frames'], records)

        cache_farm.patch_json(args.farm, f'{args.rel}/library.json', patch_library)
        if any('materials' in r for r in records):
            cache_farm.patch_json(args.farm, f'{args.rel}/normals.json',
                                  lambda normals: edit_normals(normals, state['pages'][0], records),
                                  default={'version': 1, 'pages': {}})
        result = receipt(plan, records, state['pages'], files)
        args.receipt.write_text(json.dumps(result, indent=1), encoding='utf-8')
    print(json.dumps({'pages': len(records), 'accepted': len(plan.accepted), 'fallback': len(plan.rejected)}))
    return 0


if __name__ == '__main__':
    sys.exit(main())
