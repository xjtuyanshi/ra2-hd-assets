#!/usr/bin/env python3
"""Reuse shared theatre HD pages, redirect wall overlays and merge sprite materials.

All inputs are local library directories or sprite lists. NumPy and Pillow are
required; this module neither extracts game files nor downloads assets.
"""
from __future__ import annotations

import argparse
from contextlib import contextmanager
import fcntl
import json
import os
from pathlib import Path
import shutil
import tempfile
from uuid import uuid4

import numpy as np
from PIL import Image

Image.MAX_IMAGE_PIXELS = None
WALL_TYPES = ('GAWALL', 'NAWALL', 'GASAND', 'GAFWLL')


def read_json(path, default=None):
    path = Path(path)
    if not path.exists() and default is not None:
        return default
    return json.loads(path.read_text(encoding='utf-8'))


def read_image(path, mode=None):
    with Image.open(path) as image:
        return np.array(image.convert(mode) if mode else image)


def atomic_write(path, writer):
    """Replace the entry itself so variant symlinks never write into shared sources."""
    path = Path(path)
    fd, temporary = tempfile.mkstemp(prefix='.tmp-', suffix=path.suffix, dir=path.parent)
    os.close(fd)
    temporary = Path(temporary)
    try:
        writer(temporary)
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def atomic_image(path, pixels):
    atomic_write(path, lambda tmp: Image.fromarray(pixels).save(tmp, compress_level=3))


def patch_json(path, update, default=None):
    # Read immediately before merging: only this tool's entries belong to it.
    current = read_json(path, default)
    update(current)
    atomic_write(path, lambda tmp: tmp.write_text(json.dumps(current, indent=2), encoding='utf-8'))


def atomic_symlink(source, destination):
    def link(tmp):
        tmp.unlink()
        tmp.symlink_to(os.path.relpath(Path(source).absolute(), Path(destination).parent.absolute()))
    atomic_write(destination, link)


@contextmanager
def library_lock(directory):
    # Share building_redraw.compose's lock; protect page reads as well as publication.
    with (Path(directory) / '.compose.lock').open('a') as lock:
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
        yield


def page_entry(entries, page):
    return entries[page] if 0 <= page < len(entries) else None


def idx_page(directory, library, page):
    pixels = read_image(directory / library['spriteAtlases'][page]['file'])
    return pixels[..., 0] if pixels.ndim == 3 else pixels


def material_scale(entry):
    """Material pages can be 1x or 2x even though their colour atlas is 2x."""
    sx = entry['materialWidth'] * 2 / entry['width']
    sy = entry['materialHeight'] * 2 / entry['height']
    if sx != sy or sx not in (1, 2):
        raise ValueError('material page must use a uniform 1x or 2x layout')
    return int(sx)


def same_frames(urban, theatre, udir, tdir, page, cache, palettes_same, palettes=None):
    """Return matching destination/source rects and the number of unshared frames."""
    pairs, different = [], 0
    target = idx_page(tdir, theatre, page)
    for sid, sprite in theatre['sprites'].items():
        source = urban['sprites'].get(sid)
        for k, frame in enumerate(sprite['frames']):
            x, y, w, h = frame['rect']
            if frame.get('page', 0) != page or not w or not h:
                continue
            matches = False
            if source and k < len(source['frames']) and source.get('palette') == sprite.get('palette'):
                other = source['frames'][k]
                ox, oy, ow, oh = other['rect']
                up = other.get('page', 0)
                if (ow, oh) == (w, h) and other['offset'] == frame['offset'] and page_entry(
                        urban.get('spriteAtlasesHd') or [], up):
                    if up not in cache:
                        cache[up] = idx_page(udir, urban, up)
                    block = target[y:y + h, x:x + w]
                    matches = np.array_equal(block, cache[up][oy:oy + oh, ox:ox + ow])
                    key = sprite.get('palette')
                    if matches and not palettes_same.get(key, False):
                        # Palettes differ (snow): the frame still matches when every index it uses has the same
                        # colour in both palettes; house-colour indices 16..31 of remapped sprites are replaced.
                        used = np.unique(block)
                        used = used[used > 0]
                        if sprite.get('remap'):
                            used = used[(used < 16) | (used > 31)]
                        matches = (palettes is not None and key in palettes[0] and key in palettes[1]
                                   and np.array_equal(palettes[0][key][used], palettes[1][key][used]))
                    if matches:
                        pairs.append(((x, y, w, h), (ox, oy, ow, oh, up)))
            if not matches:
                different += 1
    return pairs, different


def xfer(theatre, urban, baseline, pages=None):
    """Populate missing HD entries from shared SHP data without claiming existing pages."""
    tdir, udir, base = Path(theatre), Path(urban), Path(baseline)
    if tdir.resolve() == udir.resolve():
        raise ValueError('theatre and urban directories must differ')
    with library_lock(tdir):
        source = read_json(udir / 'library.json')
        target = read_json(tdir / 'library.json')
        source_materials = read_json(udir / 'normals.json', {'pages': {}})['pages']
        materials = read_json(tdir / 'normals.json', {'pages': {}})['pages']
        source_palettes = {k: read_image(udir / v, 'RGB').reshape(-1, 3) for k, v in source['palettes'].items()}
        target_palettes = {k: read_image(tdir / v, 'RGB').reshape(-1, 3) for k, v in target['palettes'].items()}
        palettes_same = {k: np.array_equal(v, target_palettes.get(k)) for k, v in source_palettes.items()}
        pages = range(len(target['spriteAtlases'])) if pages is None else pages
        cache, hd_entries, material_entries = {}, {}, {}
        for page in dict.fromkeys(pages):
            if page < 0 or page >= len(target['spriteAtlases']):
                raise ValueError(f'theatre has no indexed page {page}')
            if page_entry(target.get('spriteAtlasesHd') or [], page):
                print(f'page {page}: theatre already has HD entry, skipped')
                continue
            hd = page_entry(source.get('spriteAtlasesHd') or [], page)
            if not hd:
                print(f'page {page}: urban has no HD page, skipped')
                continue
            indices = idx_page(tdir, target, page)
            used = {s.get('palette') for s in target['sprites'].values()
                    if any(f.get('page', 0) == page for f in s['frames'])}
            identical = all(palettes_same.get(k, False) for k in used) and np.array_equal(
                indices, idx_page(udir, source, page))
            # Unique output names keep pages and other sidecars that share a file untouched.
            stem = f'sprites-{page}@2x-xfer-{uuid4().hex}'
            colour_name, remap_name, material_name = f'{stem}.png', f'{stem}-remap.png', f'{stem}-normals.png'
            material = source_materials.get(str(page)) if str(page) not in materials else None
            if identical:
                # Shared SHP pixels and palettes are identical across these theatres.
                atomic_symlink(udir / hd['file'], tdir / colour_name)
                atomic_symlink(udir / hd['remap'], tdir / remap_name)
                entry = dict(hd, file=colour_name, remap=remap_name)
                if material:
                    atomic_symlink(udir / material['file'], tdir / material_name)
                    material_entries[page] = dict(material, file=material_name, atlas=colour_name)
                print(f'page {page}: identical -> symlinked')
            else:
                pairs, different = same_frames(source, target, udir, tdir, page, cache, palettes_same,
                                               (source_palettes, target_palettes))
                bp, br = base / f'sprites-{page}@2x.png', base / f'sprites-{page}@2x-remap.png'
                if bp.exists():
                    colour, remap = read_image(bp, 'RGBA'), read_image(br, 'L')
                elif different == 0:
                    colour = np.zeros((2 * indices.shape[0], 2 * indices.shape[1], 4), np.uint8)
                    remap = np.zeros(colour.shape[:2], np.uint8)
                else:
                    print(f'page {page}: {different} theatre-specific frames and no baseline, skipped')
                    continue
                if colour.shape != (*np.multiply(indices.shape, 2), 4) or remap.shape != colour.shape[:2]:
                    raise ValueError(f'baseline dimensions differ from theatre page {page}')
                factor = material_scale(material) if material else 1
                mat = np.zeros((*np.multiply(indices.shape, factor), 4), np.uint8) if material else None
                blocks = {}
                for (x, y, w, h), (ox, oy, ow, oh, up) in pairs:
                    if up not in blocks:
                        ue = source['spriteAtlasesHd'][up]
                        me = source_materials.get(str(up))
                        blocks[up] = (read_image(udir / ue['file'], 'RGBA'), read_image(udir / ue['remap'], 'L'),
                                      read_image(udir / me['file'], 'RGBA') if me else None)
                    uc, ur, um = blocks[up]
                    dest = (slice(2 * y, 2 * (y + h)), slice(2 * x, 2 * (x + w)))
                    src = (slice(2 * oy, 2 * (oy + oh)), slice(2 * ox, 2 * (ox + ow)))
                    colour[dest], remap[dest] = uc[src], ur[src]
                    if mat is not None and um is not None:
                        if material_scale(source_materials[str(up)]) != factor:
                            raise ValueError('shared material pages use different output scales')
                        mat[factor*y:factor*(y+h), factor*x:factor*(x+w)] = um[
                            factor*oy:factor*(oy+oh), factor*ox:factor*(ox+ow)]
                atomic_image(tdir / colour_name, colour)
                atomic_image(tdir / remap_name, remap)
                entry = dict(hd, file=colour_name, remap=remap_name, width=colour.shape[1], height=colour.shape[0])
                if mat is not None:
                    atomic_image(tdir / material_name, mat)
                    material_entries[page] = dict(material, file=material_name, atlas=colour_name,
                                                  width=colour.shape[1], height=colour.shape[0],
                                                  materialWidth=mat.shape[1], materialHeight=mat.shape[0])
                print(f'page {page}: {len(pairs)} urban frames, {different} theatre-specific frames on baseline')
            hd_entries[page] = entry

        published = set()
        if hd_entries:
            def put_hd(current):
                entries = current.get('spriteAtlasesHd') or []
                for page, entry in hd_entries.items():
                    while len(entries) <= page:
                        entries.append(None)
                    if not entries[page]:
                        entries[page] = entry
                        published.add(page)
                current['spriteAtlasesHd'] = entries
            patch_json(tdir / 'library.json', put_hd)
        # A non-cooperating writer may have claimed an HD entry during page work.
        # Its material entry must remain outside this transfer's ownership too.
        material_entries = {page: entry for page, entry in material_entries.items() if page in published}
        if material_entries:
            def put_materials(current):
                for page, entry in material_entries.items():
                    current.setdefault('pages', {}).setdefault(str(page), entry)
            patch_json(tdir / 'normals.json', put_materials, {'version': 1, 'pages': {}})
        return sorted(published)


def overlay_walls(library, types=WALL_TYPES):
    directory = Path(library)
    patched = []
    with library_lock(directory):
        def update(current):
            hd = current.get('spriteAtlasesHd') or []
            for name in dict.fromkeys(types):
                overlay = current['sprites'].get(f'overlay:{name}')
                building = current['sprites'].get(f'building:{name}')
                if not overlay or not building or len(overlay['frames']) != len(building['frames']):
                    print(name, 'skip (missing or frame count differs)')
                    continue
                pages = {f.get('page', 0) for f in building['frames'] if f['rect'][2]}
                if not all(page_entry(hd, p) for p in pages):
                    print(name, 'skip (building pages without HD)')
                    continue
                if any(f['offset'] != g['offset'] or f['rect'][2:] != g['rect'][2:]
                       for f, g in zip(overlay['frames'], building['frames'])):
                    print(name, 'skip (frames differ)')
                    continue
                # Map walls use an overlay page without HD. The building SHP has
                # identical geometry on an HD page, so share its frames and shadows.
                overlay['frames'] = building['frames']
                if 'shadows' in building and len(building['shadows']) == len(overlay.get('shadows', [])):
                    overlay['shadows'] = building['shadows']
                patched.append(name)
                print(name, 'overlay -> building frames on pages', sorted(pages))
        patch_json(directory / 'library.json', update)
    return patched


def normals_merge(src, library, sprites_file):
    """Replace selected frame rectangles, keeping all other material data and entries."""
    src, directory = Path(src), Path(library)
    sprites = set(Path(sprites_file).read_text(encoding='utf-8').split())
    source = read_json(src / 'normals.json')['pages']
    additions = {}
    with library_lock(directory):
        manifest = read_json(directory / 'library.json')
        current = read_json(directory / 'normals.json', {'pages': {}})['pages']
        for page, entry in source.items():
            hd = page_entry(manifest.get('spriteAtlasesHd') or [], int(page))
            if not hd or hd['file'] != entry['atlas']:
                print(f'page {page}: atlas mismatch, skipped')
                continue
            rects = {tuple(f['rect']) for sid in sprites for f in manifest['sprites'].get(sid, {}).get('frames', [])
                     if f.get('page', 0) == int(page) and f['rect'][2] and f['rect'][3]}
            if not rects:
                continue
            new = read_image(src / entry['file'], 'RGBA')
            if new.shape != (entry['materialHeight'], entry['materialWidth'], 4):
                raise ValueError(f'material dimensions differ from metadata on page {page}')
            old = current.get(page)
            if old:
                if (old['atlas'] != entry['atlas'] or (old['materialWidth'], old['materialHeight']) !=
                        (entry['materialWidth'], entry['materialHeight'])):
                    # Incompatible data belongs to another layout; do not discard it.
                    print(f'page {page}: existing material layout differs, skipped')
                    continue
                base = read_image(directory / old['file'], 'RGBA')
                if base.shape != new.shape:
                    raise ValueError(f'existing material dimensions differ on page {page}')
            else:
                base = np.zeros_like(new)
            factor = material_scale(entry)
            count = 0
            for x, y, w, h in sorted(rects):
                block = (slice(factor*y, factor*(y+h)), slice(factor*x, factor*(x+w)))
                if min(x, y) < 0 or factor*(x+w) > new.shape[1] or factor*(y+h) > new.shape[0]:
                    raise ValueError(f'frame lies outside material page {page}')
                if new[block][..., 3].any():
                    base[block] = new[block]
                    count += 1
            if not count:
                continue
            # A fresh filename prevents mutation of a file referenced by another page/sidecar.
            name = f'sprites-{page}@2x-normals-merge-{uuid4().hex}.png'
            atomic_image(directory / name, base)
            additions[page] = dict(old or entry, file=name)
            if not old:
                additions[page]['frames'] = count
            print(f'page {page}: merged {count} frames')
        if additions:
            patch_json(directory / 'normals.json', lambda d: d.setdefault('pages', {}).update(additions),
                       {'version': 1, 'pages': {}})
    return sorted(additions, key=int)


def copy_patches(src_dir, dst_dir, src_patches, dst_patches):
    """Copy building-redraw patches (``<kind>_<name>#<frame>.png`` + ``-remap.png``) from one theatre to another when the
    destination frame uses the same 1x indices, offset and palette colours (the same SHP art drawn for both theatres,
    e.g. tech buildings). Differing or missing frames are left alone. Returns (copied, skipped)."""
    src_dir, dst_dir, src_patches, dst_patches = map(Path, (src_dir, dst_dir, src_patches, dst_patches))
    a_lib, b_lib = read_json(src_dir / 'library.json'), read_json(dst_dir / 'library.json')
    pal = lambda d, lib, key: read_image(d / lib['palettes'][key], 'RGB')[0]
    pages = {}
    def frame(d, lib, tag, sprite, k):
        entry = lib['sprites'][sprite]
        f = entry['frames'][k]
        x, y, w, h = f['rect']
        key = (tag, f.get('page', 0))
        if key not in pages:
            pages[key] = idx_page(d, lib, f.get('page', 0))
        return pages[key][y:y + h, x:x + w], tuple(f['offset']), pal(d, lib, entry['palette'])
    dst_patches.mkdir(parents=True, exist_ok=True)
    copied = skipped = 0
    for png in sorted(src_patches.glob('*#*.png')):
        if png.name.endswith('-remap.png'):
            continue
        kind, _, rest = png.stem.partition('_')
        name, _, k = rest.rpartition('#')
        sprite = f'{kind}:{name}'
        try:
            a, oa, pa = frame(src_dir, a_lib, 'a', sprite, int(k))
            b, ob, pb = frame(dst_dir, b_lib, 'b', sprite, int(k))
        except (KeyError, IndexError, ValueError):
            skipped += 1
            continue
        used = np.unique(a)
        if a.shape != b.shape or oa != ob or not np.array_equal(a, b) or not np.array_equal(pa[used], pb[used]):
            skipped += 1
            continue
        for suffix in ('.png', '-remap.png'):
            atomic_write(dst_patches / (png.stem + suffix), lambda t, f=src_patches / (png.stem + suffix): shutil.copyfile(f, t))
        (dst_patches / f'{png.stem}.src').write_text(f'xfer:theatre {src_dir.name}', encoding='utf-8')
        copied += 1
    return copied, skipped


def map_paste(map_dir, patches, sprites):
    """Paste library frame patches into a variant MAP cache atlas: map-placed objects draw from the map's own atlas.
    A symlinked HD or remap atlas is materialised (copy-on-write); only the patched frame rects change. Map frames
    are matched to library frames through ``sourceFrames`` when present. Returns the number of pasted frames."""
    map_dir, patches = Path(map_dir), Path(patches)
    manifest = read_json(map_dir / 'manifest.json')
    hd = manifest['spriteAtlasHd']
    scale = hd.get('scale', 2)
    with library_lock(map_dir):
        colour = read_image(map_dir / hd['file'], 'RGBA').copy()
        remap = read_image(map_dir / hd['remap'], 'L').copy()
        count = 0
        for sprite in sprites:
            entry = manifest['sprites'].get(sprite)
            if not entry:
                continue
            for i, f in enumerate(entry['frames']):
                k = (entry.get('sourceFrames') or list(range(len(entry['frames']))))[i]
                path = patches / f"{sprite.replace(':', '_')}#{k}.png"
                if not path.exists():
                    continue
                x, y, w, h = f['rect']
                rgba = read_image(path, 'RGBA')
                paint = read_image(path.with_name(path.stem + '-remap.png'), 'L')
                if rgba.shape[:2] != (h * scale, w * scale) or paint.shape != rgba.shape[:2]:
                    raise ValueError(f'patch size differs from the map frame: {path}')
                colour[y * scale:(y + h) * scale, x * scale:(x + w) * scale] = rgba
                remap[y * scale:(y + h) * scale, x * scale:(x + w) * scale] = paint
                count += 1
        for name, pixels in ((hd['file'], colour), (hd['remap'], remap)):
            atomic_image(map_dir / name, pixels)  # replaces a symlink entry, never its shared target
    return count


def page_indices(text):
    try:
        pages = [int(p) for p in text.split(',')]
        if any(p < 0 for p in pages):
            raise ValueError
        return pages
    except ValueError:
        raise argparse.ArgumentTypeError('pages must be comma-separated nonnegative integers') from None


def parser():
    ap = argparse.ArgumentParser(description=__doc__)
    commands = ap.add_subparsers(dest='command', required=True)
    p = commands.add_parser('xfer', help='reuse urban HD pages for missing theatre pages')
    p.add_argument('theatre', type=Path)
    p.add_argument('urban', type=Path)
    p.add_argument('baseline', type=Path)
    p.add_argument('--pages', type=page_indices, help='comma-separated indices (default: all theatre pages)')
    p = commands.add_parser('overlay-walls', help='redirect wall overlays to HD building frames')
    p.add_argument('library', type=Path)
    p.add_argument('types', nargs='*', default=WALL_TYPES)
    p = commands.add_parser('normals-merge', help='merge materials for a whitespace-separated sprite list')
    p.add_argument('src', type=Path)
    p.add_argument('library', type=Path)
    p.add_argument('sprites_file', type=Path)
    p = commands.add_parser('copy-patches', help='copy redraw patches to another theatre where the art is identical')
    for name in ('src_dir', 'dst_dir', 'src_patches', 'dst_patches'):
        p.add_argument(name, type=Path)
    p = commands.add_parser('map-paste', help='paste library frame patches into a variant map atlas')
    p.add_argument('map_dir', type=Path)
    p.add_argument('patches', type=Path)
    p.add_argument('sprites', nargs='+')
    return ap


def main(argv=None):
    ap = parser()
    args = ap.parse_args(argv)
    try:
        if args.command == 'xfer':
            print('THEATRE_XFER_DONE', xfer(args.theatre, args.urban, args.baseline, args.pages))
        elif args.command == 'overlay-walls':
            print('patched', len(overlay_walls(args.library, args.types)))
        elif args.command == 'copy-patches':
            print('copied %d skipped %d' % copy_patches(args.src_dir, args.dst_dir, args.src_patches, args.dst_patches))
        elif args.command == 'map-paste':
            print('pasted', map_paste(args.map_dir, args.patches, args.sprites))
        else:
            print('NORMALS_MERGED', normals_merge(args.src, args.library, args.sprites_file))
    except (ValueError, KeyError, OSError) as error:
        ap.error(str(error))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
