#!/usr/bin/env python3
"""Reuse shared theatre HD pages, redirect wall overlays and merge sprite materials.

All inputs are local library directories or sprite lists. NumPy, Pillow and OpenCV
are required; this module neither extracts game files nor downloads assets.
"""
from __future__ import annotations

import argparse
from contextlib import contextmanager
from functools import lru_cache
import json
from pathlib import Path
import shutil
import tempfile
from uuid import uuid4

import numpy as np
import cv2
from PIL import Image

import cache_farm

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
    """Stage output outside the farm and publish through the farm installer."""
    path = Path(path)
    with tempfile.TemporaryDirectory(prefix='theatre-page-') as directory:
        temporary = Path(directory) / ('output' + path.suffix)
        writer(temporary)
        cache_farm.install_file(path.parent, path.name, temporary)


def atomic_image(path, pixels):
    atomic_write(path, lambda tmp: Image.fromarray(pixels).save(tmp, compress_level=3))


def patch_json(path, update, default=None):
    # Callers hold .compose.lock; also serialize with cache_farm-only writers.
    path = Path(path)
    options = {} if default is None else {'default': default}
    cache_farm.patch_json(path.parent, path.name, update, **options)


def atomic_symlink(source, destination):
    destination = Path(destination)
    cache_farm.install_symlink(destination.parent, destination.name, source)


@contextmanager
def library_lock(directory):
    # Share building_redraw.compose's lock; protect page reads as well as publication.
    directory = Path(directory)
    farm = directory.parent.parent if directory.parent.name == '_library' else directory
    cache_farm.ensure_directory(farm, str(directory.relative_to(farm)))
    with cache_farm.lock_file(directory, '.compose.lock'):
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


def xfer(theatre, urban, baseline, pages=None, refresh_owned=False):
    """Populate missing HD entries, optionally refreshing pages from earlier transfers."""
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
        cache, hd_entries, material_entries, owned_entries = {}, {}, {}, {}
        for page in dict.fromkeys(pages):
            if page < 0 or page >= len(target['spriteAtlases']):
                raise ValueError(f'theatre has no indexed page {page}')
            old_hd = page_entry(target.get('spriteAtlasesHd') or [], page)
            if old_hd:
                if not refresh_owned or '@2x-xfer-' not in old_hd.get('file', ''):
                    print(f'page {page}: theatre already has HD entry, skipped')
                    continue
                owned_entries[page] = old_hd
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
            material = source_materials.get(str(page))
            if str(page) in materials:
                old_material = materials[str(page)]
                if not old_hd or (old_material and old_material.get('atlas') != old_hd['file']):
                    material = None
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
                        source_factor = material_scale(source_materials[str(up)])
                        block = um[source_factor*oy:source_factor*(oy+oh),
                                   source_factor*ox:source_factor*(ox+ow)]
                        if source_factor != factor:
                            block = np.array(Image.fromarray(block).resize(
                                (factor*w, factor*h), Image.Resampling.NEAREST))
                        mat[factor*y:factor*(y+h), factor*x:factor*(x+w)] = block
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
                    old_hd = owned_entries.get(page)
                    if (old_hd is None and not entries[page]) or (old_hd is not None and entries[page] == old_hd):
                        entries[page] = entry
                        published.add(page)
                current['spriteAtlasesHd'] = entries
            patch_json(tdir / 'library.json', put_hd)
        # A non-cooperating writer may have claimed an HD entry during page work.
        # Its material entry must remain outside this transfer's ownership too.
        material_entries = {page: entry for page, entry in material_entries.items() if page in published}
        if material_entries:
            def put_materials(current):
                entries = current.setdefault('pages', {})
                for page, entry in material_entries.items():
                    key = str(page)
                    if (key in entries) == (key in materials) and entries.get(key) == materials.get(key):
                        entries[key] = entry
            patch_json(tdir / 'normals.json', put_materials, {'version': 1, 'pages': {}})
        return sorted(published)


# sprite_normals.py encodes world normal X/Z in RG, specular class in B, AO in A.
# Y is reconstructed positive: (128, 128) points up; class 0 is matte, AO 255 is unoccluded.
FLAT_MATERIAL = np.array([128, 128, 0, 255], dtype=np.uint8)


def frame_block(pixels, frame, scale=1):
    x, y, w, h = frame['rect']
    if min(x, y, w, h) < 0 or scale * (x + w) > pixels.shape[1] or scale * (y + h) > pixels.shape[0]:
        raise ValueError('frame rectangle lies outside its page')
    return pixels[scale*y:scale*(y+h), scale*x:scale*(x+w)]


def frame_union(frame, other):
    """Align crop origins in the shared SHP draw coordinate system (not atlas space).

    src/node/artSource.ts produces offset = SHP crop origin - floor(canvas / 2);
    src/manifest.ts SpriteFrame and node/libraryPreview.ts draw at offset + local pixel.
    Offsets may be negative, and differing crop sizes must not be stretched to match.
    """
    origins = np.asarray([frame['offset'], other['offset']])
    if not np.isfinite(origins).all() or not np.equal(origins, np.round(origins)).all():
        raise ValueError('frame offsets must use integer pixels')
    origins = origins.astype(int)
    lower = origins.min(axis=0)
    upper = (origins + np.asarray([frame['rect'][2:], other['rect'][2:]])).max(axis=0)
    return tuple((upper - lower)[::-1]), origins - lower


def aligned_block(block, shape, origin, scale=1):
    out = np.zeros((shape[0]*scale, shape[1]*scale, *block.shape[2:]), block.dtype)
    x, y = origin * scale
    out[y:y+block.shape[0], x:x+block.shape[1]] = block
    return out


def variant_mask(target, source, target_palette, source_palette, remap=False, tolerance=14, min_area=3):
    """Keep perceptual colour regions and every native silhouette difference."""
    opaque_t, opaque_s = target > 0, source > 0
    both = opaque_t & opaque_s
    # Float RGB conversion gives CIE Lab L in 0..100, not OpenCV's encoded uint8 Lab.
    lab_t = cv2.cvtColor(target_palette[None].astype(np.float32) / 255, cv2.COLOR_RGB2LAB)[0]
    lab_s = cv2.cvtColor(source_palette[None].astype(np.float32) / 255, cv2.COLOR_RGB2LAB)[0]
    delta_e = np.linalg.norm(lab_t[target] - lab_s[source], axis=-1)
    colour = both & (delta_e > tolerance)
    if remap:
        paint_t, paint_s = (target >= 16) & (target <= 31), (source >= 16) & (source <= 31)
        colour = (colour & ~(paint_t & paint_s)) | (both & (paint_t ^ paint_s))
    # Remove dither speckles before filling small gaps inside surviving snow regions.
    _, labels, stats, _ = cv2.connectedComponentsWithStats(colour.astype(np.uint8), connectivity=8)
    keep = stats[:, cv2.CC_STAT_AREA] >= min_area
    keep[0] = False
    colour = cv2.morphologyEx(keep[labels].astype(np.uint8), cv2.MORPH_CLOSE, np.ones((3, 3), np.uint8))
    # Silhouette changes are never filtered, even when only one native pixel differs.
    return (opaque_t ^ opaque_s) | colour.astype(bool)


def feather_mask(changed):
    core = changed.repeat(2, axis=0).repeat(2, axis=1).astype(np.float32)
    grown = cv2.dilate(core, np.ones((3, 3), np.uint8))
    feather = cv2.GaussianBlur(grown, (11, 11), 1.5, borderType=cv2.BORDER_CONSTANT)
    # Keep changed pixels wholly in the variant; feather only the boundary outside C.
    return np.maximum(core, feather)


def masked_variant(baseline, source, weight, detail):
    """Transfer only source luminance high frequencies; retain baseline Lab chroma."""
    lab_b = cv2.cvtColor(baseline[..., :3].astype(np.float32) / 255, cv2.COLOR_RGB2LAB)
    lab_s = cv2.cvtColor(source[..., :3].astype(np.float32) / 255, cv2.COLOR_RGB2LAB)
    luminance = lab_s[..., 0]
    high = luminance - cv2.GaussianBlur(luminance, (0, 0), 1.5)
    lab_b[..., 0] = np.clip(lab_b[..., 0] + detail * high * (source[..., 3] > 0), 0, 100)
    coloured = np.clip(np.rint(cv2.cvtColor(lab_b, cv2.COLOR_LAB2RGB) * 255), 0, 255).astype(np.uint8)
    variant = baseline.copy()
    if detail:
        variant[..., :3] = coloured
        # No source coverage means no detail; retain baseline bytes exactly there.
        variant[source[..., 3] == 0, :3] = baseline[source[..., 3] == 0, :3]
    return blend_pixels(source, variant, weight)


def blend_pixels(source, target, weight):
    if source.ndim == 3:
        weight = weight[..., None]
    return np.clip(np.rint(source.astype(np.float32) * (1 - weight) + target * weight), 0, 255).astype(np.uint8)


def silhouette_matches(colour, indices):
    h, w = indices.shape
    opaque = colour[..., 3].reshape(h, 2, w, 2).mean(axis=(1, 3)) > 127.5
    return opaque == (indices > 0)


def preserve_silhouette(colour, indices):
    # Feathering must not add/remove native pixels. Correct only contradicting 2x
    # cells, leaving all already-valid alpha (including subpixel edges) untouched.
    wrong = ~silhouette_matches(colour, indices)
    mask = wrong.repeat(2, axis=0).repeat(2, axis=1)
    alpha = (indices > 0).astype(np.uint8).repeat(2, axis=0).repeat(2, axis=1) * 255
    colour[..., 3][mask] = alpha[mask]


def transfer_counts():
    return dict(urban_exact=0, variant=0, baseline=0, qa_silhouette_failures=0)


class SilhouetteQaRejection(ValueError):
    """Carry this invocation's rejection result after its report is saved."""

    def __init__(self, rejected, published):
        self.rejected, self.published = rejected, published
        super().__init__(f'silhouette QA failed on pages {rejected}; published {published}')


def variant_xfer(theatre, urban, baseline, pages=None, refresh_owned=False, detail=0.35, max_changed=0.6,
                 tolerance=14, min_area=3, *, fail_on_rejection=False):
    """Reuse accepted redraws, replacing only aligned native-art differences.

    Return published page indices; strict callers raise on QA rejection after
    writing the report and publishing any independent valid pages.
    """
    if not np.isfinite(detail) or detail < 0:
        raise ValueError('detail must be finite and nonnegative')
    if not np.isfinite(max_changed) or not 0 <= max_changed <= 1:
        raise ValueError('max-changed must be between 0 and 1')
    if not np.isfinite(tolerance) or tolerance < 0:
        raise ValueError('tolerance must be finite and nonnegative')
    if not isinstance(min_area, int) or min_area < 1:
        raise ValueError('min-area must be a positive integer')
    tdir, udir, base = Path(theatre), Path(urban), Path(baseline)
    if tdir.resolve() == udir.resolve():
        raise ValueError('theatre and urban directories must differ')
    with library_lock(tdir):
        source, target = read_json(udir / 'library.json'), read_json(tdir / 'library.json')
        source_normals = read_json(udir / 'normals.json', {'pages': {}})
        source_materials = source_normals['pages']
        materials = read_json(tdir / 'normals.json', {'pages': {}})['pages']
        sp = {k: read_image(udir / v, 'RGB').reshape(-1, 3) for k, v in source['palettes'].items()}
        tp = {k: read_image(tdir / v, 'RGB').reshape(-1, 3) for k, v in target['palettes'].items()}

        @lru_cache(maxsize=2)
        def source_indices(page):
            return idx_page(udir, source, page)

        @lru_cache(maxsize=2)
        def source_hd(page):
            entry = source['spriteAtlasesHd'][page]
            colour = read_image(udir / entry['file'], 'RGBA')
            remap = read_image(udir / entry['remap'], 'L')
            shape = source_indices(page).shape
            if entry.get('scale') != 2 or colour.shape != (shape[0]*2, shape[1]*2, 4) or remap.shape != colour.shape[:2]:
                raise ValueError(f'source HD dimensions/scale differ on page {page}')
            me = source_materials.get(str(page))
            material, factor = None, 2
            if me and me.get('atlas') == entry['file']:
                factor = material_scale(me)
                material = read_image(udir / me['file'], 'RGBA')
                if material.shape != (shape[0]*factor, shape[1]*factor, 4):
                    raise ValueError(f'source material dimensions differ on page {page}')
            return colour, remap, material, factor

        report = dict(version=1, parameters=dict(detail=detail, max_changed=max_changed,
                                                tolerance=tolerance, min_area=min_area), pages={}, sprites={})
        hd_entries, material_entries, owned_entries = {}, {}, {}
        pages = range(len(target['spriteAtlases'])) if pages is None else pages
        for page in dict.fromkeys(pages):
            if page < 0 or page >= len(target['spriteAtlases']):
                raise ValueError(f'theatre has no indexed page {page}')
            old_hd = page_entry(target.get('spriteAtlasesHd') or [], page)
            counts, sprite_counts = transfer_counts(), {}
            report['pages'][str(page)] = counts
            counts['published'] = False
            if old_hd and (not refresh_owned or '-vxfer-' not in old_hd.get('file', '')):
                counts['skipped'] = 'existing HD entry'
                print(f'page {page}: theatre already has HD entry, skipped')
                continue
            if old_hd:
                owned_entries[page] = old_hd
            indices = idx_page(tdir, target, page)
            bp, br = base / f'sprites-{page}@2x.png', base / f'sprites-{page}@2x-remap.png'
            has_baseline = bp.exists() and br.exists()
            shape = (indices.shape[0]*2, indices.shape[1]*2)
            baseline_colour = read_image(bp, 'RGBA') if has_baseline else np.zeros((*shape, 4), np.uint8)
            baseline_remap = read_image(br, 'L') if has_baseline else np.zeros(shape, np.uint8)
            # Aliased frame rectangles must always sample the original baseline.
            colour, remap = baseline_colour.copy(), baseline_remap.copy()
            if colour.shape != (*shape, 4) or remap.shape != shape:
                raise ValueError(f'baseline dimensions differ from theatre page {page}')
            # All output materials use the HD layout. Missing source data stays no-data.
            mat = np.zeros((*shape, 4), np.uint8)
            missing_baseline = False
            for sid, sprite in target['sprites'].items():
                other_sprite = source['sprites'].get(sid)
                for k, frame in enumerate(sprite['frames']):
                    x, y, w, h = frame['rect']
                    if frame.get('page', 0) != page or not w or not h:
                        continue
                    own = frame_block(indices, frame)
                    dest = (slice(2*y, 2*(y+h)), slice(2*x, 2*(x+w)))
                    kind = 'baseline'
                    candidate = (other_sprite and k < len(other_sprite['frames'])
                                 and sprite.get('palette') == other_sprite.get('palette'))
                    if candidate:
                        other = other_sprite['frames'][k]
                        up = other.get('page', 0)
                        candidate = bool(page_entry(source.get('spriteAtlasesHd') or [], up))
                    if candidate and other['rect'][2] and other['rect'][3]:
                        native = frame_block(source_indices(up), other)
                        union, origins = frame_union(frame, other)
                        ti, ui = aligned_block(own, union, origins[0]), aligned_block(native, union, origins[1])
                        key = sprite.get('palette')
                        changed = variant_mask(ti, ui, tp[key], sp[key], bool(sprite.get('remap')), tolerance, min_area)
                        # Removed source pixels count too; they must not survive as ghost edges.
                        fraction = np.count_nonzero(changed) / max(1, np.count_nonzero(own))
                        if native.any() and fraction <= max_changed:
                            kind = 'variant' if changed.any() else 'urban_exact'
                            uc, ur, um, factor = source_hd(up)
                            ac = aligned_block(frame_block(uc, other, 2), union, origins[1], 2)
                            ar = aligned_block(frame_block(ur, other, 2), union, origins[1], 2)
                            am = np.zeros_like(ac)
                            if um is not None:
                                block = frame_block(um, other, factor)
                                if factor == 1:
                                    block = block.repeat(2, axis=0).repeat(2, axis=1)
                                am = aligned_block(block, union, origins[1], 2)
                            dx, dy = origins[0] * 2
                            crop = (slice(dy, dy+2*h), slice(dx, dx+2*w))
                            if kind == 'variant' and has_baseline:
                                bc = aligned_block(baseline_colour[dest], union, origins[0], 2)
                                bm = aligned_block(baseline_remap[dest], union, origins[0], 2)
                                weight = feather_mask(changed)
                                ac = masked_variant(bc, ac, weight, detail)
                                ar = blend_pixels(ar, bm, weight)
                                am = blend_pixels(am, np.broadcast_to(FLAT_MATERIAL, am.shape), weight)
                            if kind == 'urban_exact' or has_baseline:
                                colour[dest], remap[dest], mat[dest] = ac[crop], ar[crop], am[crop]
                                if kind == 'variant':
                                    preserve_silhouette(colour[dest], own)
                    if kind != 'urban_exact' and not has_baseline:
                        missing_baseline = True
                    per_sprite = sprite_counts.setdefault(sid, transfer_counts())
                    counts[kind] += 1
                    per_sprite[kind] += 1
                    if (kind == 'urban_exact' or has_baseline) and silhouette_matches(colour[dest], own).mean() < 0.995:
                        counts['qa_silhouette_failures'] += 1
                        per_sprite['qa_silhouette_failures'] += 1
            for sid, values in sprite_counts.items():
                total = report['sprites'].setdefault(sid, transfer_counts())
                for key, value in values.items():
                    total[key] += value
            print(f"page {page}: {counts['urban_exact']} urban-exact frames, {counts['variant']} variant frames, "
                  f"{counts['baseline']} baseline frames, {counts['qa_silhouette_failures']} QA silhouette failures")
            if counts['qa_silhouette_failures']:
                # Reject the whole page before staging any sidecars or replacing an
                # owned binding; retain the input bytes and QA evidence for review.
                counts['rejected'] = 'silhouette QA failed'
                print(f'page {page}: silhouette QA failed, rejected')
                continue
            if missing_baseline:
                counts['skipped'] = 'missing baseline colour/remap'
                print(f'page {page}: missing baseline colour/remap, skipped')
                continue
            stem = f'sprites-{page}@2x-vxfer-{uuid4().hex}'
            cn, rn, mn = f'{stem}.png', f'{stem}-remap.png', f'{stem}-normals.png'
            atomic_image(tdir / cn, colour)
            atomic_image(tdir / rn, remap)
            hd_entries[page] = dict(file=cn, remap=rn, scale=2, width=shape[1], height=shape[0])
            old_material = materials.get(str(page))
            if str(page) not in materials or (old_hd and (not old_material or old_material.get('atlas') == old_hd['file'])):
                atomic_image(tdir / mn, mat)
                material_entries[page] = dict(file=mn, atlas=cn, width=shape[1], height=shape[0], scale=2,
                                              materialWidth=shape[1], materialHeight=shape[0],
                                              frames=counts['urban_exact'] + counts['variant'])

        published = set()
        if hd_entries:
            def put_hd(current):
                entries = current.get('spriteAtlasesHd') or []
                for page, entry in hd_entries.items():
                    while len(entries) <= page:
                        entries.append(None)
                    old = owned_entries.get(page)
                    if (old is None and not entries[page]) or (old is not None and entries[page] == old):
                        entries[page] = entry
                        published.add(page)
                current['spriteAtlasesHd'] = entries
            patch_json(tdir / 'library.json', put_hd)
        if published & material_entries.keys():
            def put_materials(current):
                entries = current.setdefault('pages', {})
                for page in published & material_entries.keys():
                    key = str(page)
                    if (key in entries) == (key in materials) and entries.get(key) == materials.get(key):
                        entries[key] = material_entries[page]
            default = dict(version=1, pages={})
            if 'encoding' in source_normals:
                default['encoding'] = source_normals['encoding']
            patch_json(tdir / 'normals.json', put_materials, default)
        for page in published:
            report['pages'][str(page)]['published'] = True
        atomic_write(tdir / 'variant-xfer-report.json',
                     lambda tmp: tmp.write_text(json.dumps(report, indent=2), encoding='utf-8'))
        rejected = sorted(int(page) for page, counts in report['pages'].items() if counts.get('rejected'))
        if fail_on_rejection and rejected:
            raise SilhouetteQaRejection(rejected, sorted(published))
        return sorted(published)


def _wall_skip_reason(lib, name):
    overlay = lib['sprites'].get(f'overlay:{name}')
    building = lib['sprites'].get(f'building:{name}')
    if not overlay or not building or len(overlay['frames']) != len(building['frames']):
        return 'skip (missing or frame count differs)'
    pages = {f.get('page', 0) for f in building['frames'] if f['rect'][2]}
    if not all(page_entry(lib.get('spriteAtlasesHd') or [], p) for p in pages):
        return 'skip (building pages without HD)'
    if any(f['offset'] != g['offset'] or f['rect'][2:] != g['rect'][2:]
           for f, g in zip(overlay['frames'], building['frames'])):
        return 'skip (frames differ)'
    return None


def redirect_walls(lib: dict, types=WALL_TYPES) -> list[str]:
    patched = []
    for name in dict.fromkeys(types):
        if _wall_skip_reason(lib, name):
            continue
        overlay = lib['sprites'][f'overlay:{name}']
        building = lib['sprites'][f'building:{name}']
        # Map walls use an overlay page without HD. The building SHP has
        # identical geometry on an HD page, so share its frames and shadows.
        overlay['frames'] = building['frames']
        if 'shadows' in building and len(building['shadows']) == len(overlay.get('shadows', [])):
            overlay['shadows'] = building['shadows']
        patched.append(name)
    return patched


def overlay_walls(library, types=WALL_TYPES):
    directory = Path(library)
    types = tuple(dict.fromkeys(types))
    patched = []
    with library_lock(directory):
        def update(current):
            patched.extend(redirect_walls(current, types))
            for name in types:
                if name not in patched:
                    print(name, _wall_skip_reason(current, name))
                else:
                    pages = {f.get('page', 0) for f in current['sprites'][f'building:{name}']['frames'] if f['rect'][2]}
                    print(name, 'overlay -> building frames on pages', sorted(pages))
        cache_farm.patch_json(directory, 'library.json', update)
    return patched


def normals_merge(src, library, sprites_file):
    """Replace selected frame rectangles, keeping all other material data and entries."""
    src, directory = Path(src), Path(library)
    sprites = set(Path(sprites_file).read_text(encoding='utf-8').split())
    source = read_json(src / 'normals.json')['pages']
    additions = {}
    class NoMaterialChanges(Exception):
        pass
    with library_lock(directory):
        manifest = read_json(directory / 'library.json')
        def merge(document):
            current = document.setdefault('pages', {})
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
            if not additions:
                # Do not materialise a symlink or rewrite formatting for a skipped merge.
                raise NoMaterialChanges
            # Keep unrelated metadata even from legacy writers that ignore the lock.
            latest = read_json(directory / 'normals.json', dict(document))
            document.clear()
            document.update(latest)
            document.setdefault('pages', {}).update(additions)
        try:
            patch_json(directory / 'normals.json', merge, {'version': 1, 'pages': {}})
        except NoMaterialChanges:
            pass
    return sorted(additions, key=int)


def patch_frame_reader(directory, library):
    """Read indexed frame blocks through a paged library contract, caching only pages."""
    directory = Path(directory)
    pages = {}
    def frame(sprite, k):
        entry = library['sprites'][sprite]
        f = entry['frames'][k]
        x, y, w, h = f['rect']
        page = f.get('page', 0)
        if page not in pages:
            pages[page] = idx_page(directory, library, page)
        palette = read_image(directory / library['palettes'][entry['palette']], 'RGB')[0]
        return pages[page][y:y + h, x:x + w], tuple(f['offset']), palette
    return frame


def matching_patches(source_frame, target_frame, src_patches, dst_patches, tag):
    """Copy only patches whose indexed frames, anchors and used palette colours match."""
    src_patches, dst_patches = Path(src_patches), Path(dst_patches)
    dst_patches.mkdir(parents=True, exist_ok=True)
    copied = skipped = 0
    for png in sorted(src_patches.glob('*#*.png')):
        if png.name.endswith('-remap.png'):
            continue
        kind, _, rest = png.stem.partition('_')
        name, _, k = rest.rpartition('#')
        sprite = f'{kind}:{name}'
        try:
            a, oa, pa = source_frame(sprite, int(k))
            b, ob, pb = target_frame(sprite, int(k))
        except (KeyError, IndexError, ValueError):
            skipped += 1
            continue
        used = np.unique(a)
        if a.shape != b.shape or oa != ob or not np.array_equal(a, b) or not np.array_equal(pa[used], pb[used]):
            skipped += 1
            continue
        for suffix in ('.png', '-remap.png'):
            atomic_write(dst_patches / (png.stem + suffix), lambda t, f=src_patches / (png.stem + suffix): shutil.copyfile(f, t))
        (dst_patches / f'{png.stem}.src').write_text(tag, encoding='utf-8')
        copied += 1
    return copied, skipped


def copy_patches(src_dir, dst_dir, src_patches, dst_patches):
    """Copy building-redraw patches (``<kind>_<name>#<frame>.png`` + ``-remap.png``) from one theatre to another when the
    destination frame uses the same 1x indices, offset and palette colours (the same SHP art drawn for both theatres,
    e.g. tech buildings). Differing or missing frames are left alone. Returns (copied, skipped)."""
    src_dir, dst_dir = Path(src_dir), Path(dst_dir)
    a_lib, b_lib = read_json(src_dir / 'library.json'), read_json(dst_dir / 'library.json')
    return matching_patches(patch_frame_reader(src_dir, a_lib), patch_frame_reader(dst_dir, b_lib),
                            src_patches, dst_patches, f'xfer:theatre {src_dir.name}')


def map_copy_patches(map_dir, library_dir, src_patches, dst_patches, tag=None):
    """Copy map-cache redraw patches into a theatre library patch set where the library frame is the same art (same 1x
    indices, offset and used palette colours). The live view draws every building that has a library type from the
    type library, so redraws composed only into a map atlas (e.g. civil buildings) never show in a match otherwise."""
    map_dir, library_dir = Path(map_dir), Path(library_dir)
    manifest = read_json(map_dir / 'manifest.json')
    source = dict(sprites=manifest['sprites'], palettes=manifest['palettes'],
                  spriteAtlases=[manifest['spriteAtlas']])
    target = read_json(library_dir / 'library.json')
    return matching_patches(patch_frame_reader(map_dir, source), patch_frame_reader(library_dir, target),
                            src_patches, dst_patches, tag if tag is not None else f'map-copy {map_dir.name}')


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
    p.add_argument('--refresh-owned', action='store_true', help='regenerate HD pages written by an earlier xfer')
    p = commands.add_parser('variant-xfer', help='reuse redraws outside aligned native-art differences')
    p.add_argument('theatre', type=Path)
    p.add_argument('urban', type=Path)
    p.add_argument('baseline', type=Path)
    p.add_argument('--pages', type=page_indices, help='comma-separated indices (default: all theatre pages)')
    p.add_argument('--refresh-owned', action='store_true', help='regenerate only earlier -vxfer- HD entries')
    p.add_argument('--detail', type=float, default=0.35, help='source Lab luminance detail strength (default: 0.35)')
    p.add_argument('--max-changed', type=float, default=0.6, help='maximum changed/target-opaque ratio (default: 0.6)')
    p.add_argument('--tolerance', type=float, default=14, help='CIE76 Delta E colour threshold (default: 14)')
    p.add_argument('--min-area', type=int, default=3, help='minimum 8-connected colour region in 1x pixels (default: 3)')
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
    p = commands.add_parser('map-copy-patches', help='copy matching map-cache patches to a theatre library patch set')
    for name in ('map_dir', 'library_dir', 'src_patches', 'dst_patches'):
        p.add_argument(name, type=Path)
    p.add_argument('--tag', help='patch provenance (default: map-copy <map directory name>)')
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
            print('THEATRE_XFER_DONE', xfer(args.theatre, args.urban, args.baseline, args.pages, args.refresh_owned))
        elif args.command == 'variant-xfer':
            try:
                published = variant_xfer(args.theatre, args.urban, args.baseline, args.pages, args.refresh_owned,
                                         args.detail, args.max_changed, args.tolerance, args.min_area,
                                         fail_on_rejection=True)
            except SilhouetteQaRejection as rejected:
                print('THEATRE_VARIANT_XFER_REJECTED', rejected.rejected, 'published', rejected.published)
                return 1
            print('THEATRE_VARIANT_XFER_DONE', published)
        elif args.command == 'overlay-walls':
            print('patched', len(overlay_walls(args.library, args.types)))
        elif args.command == 'copy-patches':
            print('copied %d skipped %d' % copy_patches(args.src_dir, args.dst_dir, args.src_patches, args.dst_patches))
        elif args.command == 'map-copy-patches':
            print('copied %d skipped %d' % map_copy_patches(args.map_dir, args.library_dir, args.src_patches,
                                                          args.dst_patches, args.tag))
        elif args.command == 'map-paste':
            print('pasted', map_paste(args.map_dir, args.patches, args.sprites))
        else:
            print('NORMALS_MERGED', normals_merge(args.src, args.library, args.sprites_file))
    except (ValueError, KeyError, OSError) as error:
        ap.error(str(error))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
