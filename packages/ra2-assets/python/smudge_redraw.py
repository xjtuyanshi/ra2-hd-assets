#!/usr/bin/env python3
"""Assemble reference-aligned AI decals and merge only their library records.

No generation, model launch, resource downloads or live-cache defaults. Art stays
in caller-supplied directories. Original indexed geometry remains authoritative.
"""
from __future__ import annotations

import argparse
from collections import deque
import copy
import hashlib
import json
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

import cache_farm
import theatre_pages


def read_json(path):
    return json.loads(Path(path).read_text(encoding='utf-8'))


def write_json(path, value):
    theatre_pages.atomic_write(Path(path), lambda p: p.write_text(
        json.dumps(value, indent=2) + '\n', encoding='utf-8'))


def relative_file(directory, name):
    p = Path(name)
    if p.is_absolute() or '..' in p.parts or not p.name:
        raise ValueError(f'unsafe relative filename: {name}')
    return Path(directory) / p


def pixels(path, mode):
    with Image.open(path) as image:
        return np.array(image.convert(mode))


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def validate(directory, *, require_hd):
    directory = Path(directory)
    lib = read_json(directory / 'library.fragment.json')
    if lib.get('version') != 1 or not lib.get('smudges'):
        raise ValueError('expected a version 1 smudge fragment with resolved types')
    owned = {kind['sprite'] for kind in lib['smudges'].values()}
    if set(lib['sprites']) != owned or any(not name.startswith('smudge:') for name in owned):
        raise ValueError('fragment may own only its referenced smudge sprites')
    entries = lib['spriteAtlases']
    for page, entry in enumerate(entries):
        native = pixels(relative_file(directory, entry['file']), 'L')
        if native.shape != (entry['height'], entry['width']):
            raise ValueError('indexed atlas dimensions differ from metadata')
        if not require_hd:
            continue
        hd = (lib.get('spriteAtlasesHd') or [])[page]
        if not hd or hd.get('scale') != 2:
            raise ValueError('every staged smudge page needs an actual 2x HD entry')
        colour = pixels(relative_file(directory, hd['file']), 'RGBA')
        remap = pixels(relative_file(directory, hd['remap']), 'L')
        expected = (entry['height'] * 2, entry['width'] * 2)
        if colour.shape != (*expected, 4) or remap.shape != expected:
            raise ValueError('HD colour/remap dimensions differ from indexed layout')
        if (hd['height'], hd['width']) != expected or remap.any():
            raise ValueError('smudge HD metadata or nonzero house-remap mask')
    for name, kind in lib['smudges'].items():
        if kind['palette'] != 'iso' or kind['lighting'] != 'full' or not kind['flat'] or kind['remap']:
            raise ValueError(f'invalid smudge rendering contract: {name}')
        if any(type(kind[k]) is not int or kind[k] < 1 for k in ('width', 'height')):
            raise ValueError('invalid footprint dimensions')
        sprite = lib['sprites'][kind['sprite']]
        if sprite.get('sourceFrames') not in (None, [0]):
            raise ValueError('smudge body frame must represent native frame zero')
        if kind['frames'] != 1 or len(sprite['frames']) != 1:
            raise ValueError('native smudges draw body frame zero')
        for frame in sprite['frames'] + sprite.get('shadows', []):
            page = frame.get('page', 0)
            if type(page) is not int or not 0 <= page < len(entries):
                raise ValueError('frame page outside staged library')
            x, y, w, h = frame['rect']
            if min(x, y, w, h) < 0 or x+w > entries[page]['width'] or y+h > entries[page]['height']:
                raise ValueError('frame rectangle outside indexed page')
            if require_hd and w and h:
                hd = lib['spriteAtlasesHd'][page]
                alpha = pixels(relative_file(directory, hd['file']), 'RGBA')[2*y:2*(y+h), 2*x:2*(x+w), 3]
                if not alpha.any() or not ((alpha > 0) & (alpha < 255)).any():
                    raise ValueError('empty decal or no soft-alpha fringe')
    return lib


def original_frame(directory, lib, name):
    sprite = lib['sprites'][lib['smudges'][name]['sprite']]
    frame = sprite['frames'][0]
    page = lib['spriteAtlases'][frame.get('page', 0)]
    x, y, w, h = frame['rect']
    idx = pixels(relative_file(directory, page['file']), 'L')[y:y+h, x:x+w]
    pal = pixels(relative_file(directory, lib['palettes']['iso']), 'RGB').reshape(-1, 3)
    rgba = np.dstack((pal[idx], np.where(idx > 0, 255, 0).astype(np.uint8)))
    rgba[idx == 0, :3] = 0
    return Image.fromarray(rgba)


def feather(original):
    # Never expand into a neighbouring atlas rectangle or fill negative gaps.
    hard = original.getchannel('A').resize((original.width*2, original.height*2), Image.Resampling.NEAREST)
    blurred = hard.filter(ImageFilter.GaussianBlur(0.6))
    return np.minimum(np.array(hard), np.array(blurred))


def registered_patch(sheet, slot, size):
    """Fit one isolated decal to its original bounds; discard coloured matte artifacts."""
    left, top, width, height = slot['slot']
    raw = np.array(sheet.crop((left, top, left+width, top+height)))
    rgb = raw[..., :3].astype(np.float32)
    chroma = rgb.max(axis=2)-rgb.min(axis=2)
    saturation = chroma / np.maximum(rgb.max(axis=2), 1)
    matte = (chroma > 40) & (saturation > 0.45)
    raw[matte] = 0
    active = raw[..., 3] > 32
    visited = np.zeros(active.shape, bool)
    components = []
    for y, x in zip(*np.where(active)):
        if visited[y, x]: continue
        pending = deque([(int(y), int(x))]); visited[y, x] = True; points = []
        while pending:
            cy, cx = pending.popleft(); points.append((cy, cx))
            for dy, dx in ((-1, 0), (1, 0), (0, -1), (0, 1)):
                ny, nx = cy+dy, cx+dx
                if 0 <= ny < height and 0 <= nx < width and active[ny, nx] and not visited[ny, nx]:
                    visited[ny, nx] = True; pending.append((ny, nx))
        components.append(np.array(points))
    if not components:
        raise ValueError('generated slot has no neutral material')
    biggest = max(components, key=len)
    kept = np.zeros(active.shape, bool)
    for points in components:
        cy, cx = points.mean(axis=0)
        # Large neighbouring sprites can spill over a slot edge. Keep the main
        # decal and its nearby satellites, never a separated neighbour fragment.
        if points is biggest or (len(points) >= max(5, len(biggest)*0.015) and
                                  abs(cx-width/2) < width*0.35 and abs(cy-height/2) < height*0.35):
            kept[points[:, 0], points[:, 1]] = True
    raw[active & ~kept] = 0
    yy, xx = np.where(kept)
    if not len(xx):
        raise ValueError('generated slot has no neutral material')
    bbox = (int(xx.min()), int(yy.min()), int(xx.max()+1), int(yy.max()+1))
    crop = Image.fromarray(raw).crop(bbox).resize(size, Image.Resampling.LANCZOS)
    ai = np.array(crop)
    colour = ai[..., :3].astype(np.float32)
    known = ai[..., 3] > 32
    # Extend edge colours into transparent resampling texels. This only samples
    # AI material; alpha is independently clipped to the original negative gaps.
    for _ in range(max(size)):
        if known.all(): break
        sums = np.zeros_like(colour); counts = np.zeros(known.shape, np.float32)
        for dy, dx in ((-1, 0), (1, 0), (0, -1), (0, 1)):
            shifted = np.roll(known, (dy, dx), (0, 1))
            sample = np.roll(colour, (dy, dx), (0, 1))
            if dy == -1: shifted[-1] = False
            if dy == 1: shifted[0] = False
            if dx == -1: shifted[:, -1] = False
            if dx == 1: shifted[:, 0] = False
            counts += shifted; sums += sample * shifted[..., None]
        added = (~known) & (counts > 0)
        if not added.any(): break
        colour[added] = sums[added]/counts[added, None]
        known |= added
    return colour, ai[..., 3], {'generated_slot_bbox': list(bbox), 'matte_pixels_removed': int(matte.sum()),
                              'separate_spill_pixels_removed': int((active & ~kept).sum())}


def match_macro(original, rgb, support):
    """Keep reference light/dark placement while retaining AI high-frequency material."""
    weights = support.astype(np.float32)/255
    core = support > 200
    def low(values):
        numerator = np.array(Image.fromarray(np.clip(values*weights, 0, 255).astype(np.uint8))
                             .filter(ImageFilter.GaussianBlur(2)), np.float32)
        denominator = np.array(Image.fromarray(support).filter(ImageFilter.GaussianBlur(2)), np.float32)/255
        return numerator/np.maximum(denominator, 1/255)
    generated_luma = rgb @ np.array([0.2126, 0.7152, 0.0722], np.float32)
    original_luma = np.array(original.resize((support.shape[1], support.shape[0]), Image.Resampling.NEAREST)
                            .convert('L'), np.float32)
    ai_low, source_low = low(generated_luma), low(original_luma)
    source_std, generated_std = float(source_low[core].std()), float(ai_low[core].std())
    gain = np.clip(generated_std/max(source_std, 1), 0.5, 2)
    target = generated_luma[core].mean() + (source_low-source_low[core].mean())*gain
    # Macro illumination is constrained by the source, never its bitmap texture.
    # All new crack/stone/ash variation remains the generated residual.
    luma = target + generated_luma-ai_low
    return np.clip(rgb + (luma-generated_luma)[..., None], 0, 255), {
        'reference_macro_gain': float(gain), 'ai_detail_rms': float((generated_luma-ai_low)[core].std())}


def assemble(job, sources, output):
    job, sources, output = Path(job), Path(sources), Path(output)
    slots = read_json(job / 'slots.json')
    if not slots:
        raise ValueError('no generated slot assignment')
    with Image.open(job / 'reference.png') as reference:
        reference_size = reference.size
    with Image.open(job / 'generated.png') as image:
        if 'A' not in image.getbands() or image.getchannel('A').getextrema()[0] == 255:
            raise ValueError('generated sheet has no actual transparent background')
        generated_size = image.size
        generated = image.convert('RGBA').resize(reference_size, Image.Resampling.LANCZOS)
    reports = []
    for theater in dict.fromkeys(slot['theater'] for slot in slots):
        source, dest = sources / theater, output / theater
        lib = validate(source, require_hd=False)
        selected = [slot for slot in slots if slot['theater'] == theater]
        if len(selected) != len(lib['smudges']) or {s['id'] for s in selected} != set(lib['smudges']):
            raise ValueError('each resolved smudge must have exactly one generated slot')
        dest.mkdir(parents=True, exist_ok=True)
        atlases = [np.zeros((p['height']*2, p['width']*2, 4), np.uint8) for p in lib['spriteAtlases']]
        metrics = []
        for slot in selected:
            name = slot['id']
            original = original_frame(source, lib, name)
            frame = lib['sprites'][lib['smudges'][name]['sprite']]['frames'][0]
            if slot['frame']['rect'] != frame['rect'] or slot['frame']['offset'] != frame['offset']:
                raise ValueError('reference slot differs from original geometry')
            if slot['footprint'] != [lib['smudges'][name]['width'], lib['smudges'][name]['height']]:
                raise ValueError('reference footprint differs from original')
            x, y, w, h = frame['rect']
            rgb, generated_alpha, registration = registered_patch(generated, slot, (2*w, 2*h))
            support = feather(original)
            core = support > 200
            coverage = float((generated_alpha[core] > 64).mean()) if core.any() else 0
            if coverage < 0.7:
                raise ValueError(f'generated content misaligned or missing for {theater}/{name}: {coverage:.3f}')
            # Neutral grading does not supply texture: every colour texel comes from imagegen.
            luminance = rgb @ np.array([0.2126, 0.7152, 0.0722], np.float32)
            neutral = luminance[..., None] + (rgb-luminance[..., None]) * 0.25
            neutral, macro = match_macro(original, neutral, support)
            patch = np.dstack((np.clip(neutral, 0, 255).astype(np.uint8), support))
            patch[patch[..., 3] == 0, :3] = 0
            atlases[frame.get('page', 0)][2*y:2*(y+h), 2*x:2*(x+w)] = patch
            colour_active = patch[..., 3] > 64
            warm = ((patch[..., 0].astype(int)-patch[..., 2] > 18) & colour_active)
            metrics.append({'id': name, 'generated_core_coverage': coverage,
                            'soft_alpha_pixels': int(((patch[..., 3]>0)&(patch[..., 3]<255)).sum()),
                            'outside_original_support': int(((support==0)&(patch[..., 3]>0)).sum()),
                            'warm_pixels': int(warm.sum()), 'original_rect': frame['rect'],
                            'original_offset': frame['offset'], 'footprint': slot['footprint'], **registration, **macro})
        for key, name in lib['palettes'].items():
            cache_farm.install_file(dest, name, relative_file(source, name))
        lib['spriteAtlasesHd'] = []
        for page, (entry, colour) in enumerate(zip(lib['spriteAtlases'], atlases)):
            cache_farm.install_file(dest, entry['file'], relative_file(source, entry['file']))
            stem = f'sprites-smudges-s2x-{page}@2x'
            theatre_pages.atomic_image(dest / (stem+'.png'), colour)
            theatre_pages.atomic_image(dest / (stem+'-remap.png'), np.zeros(colour.shape[:2], np.uint8))
            lib['spriteAtlasesHd'].append(dict(file=stem+'.png', remap=stem+'-remap.png', scale=2,
                                             width=colour.shape[1], height=colour.shape[0]))
        write_json(dest / 'library.fragment.json', lib)
        write_json(dest / 'assembly.json', {'job': str(job.resolve()), 'generated_sha256': sha(job/'generated.png'),
                                          'generated_size': generated_size, 'reference_size': reference_size,
                                          'colour_source': 'imagegen material; reference macro light/dark; chroma scale 0.25',
                                          'decals': metrics})
        validate(dest, require_hd=True)
        reports.append({'theater': theater, 'decals': len(metrics), 'directory': str(dest)})
    return reports


def install(source, destination):
    """Append dedicated pages; preserve shared pages, sidecars and other sections."""
    source, destination = Path(source), Path(destination)
    if destination.is_symlink() or not destination.is_dir():
        raise ValueError('destination must be an explicit real theatre directory')
    lib = validate(source, require_hd=True)
    with theatre_pages.library_lock(destination):
        current = read_json(destination / 'library.json')
        if current['version'] != lib['version'] or current['theater'] != lib['theater']:
            raise ValueError('destination version/theater differs')
        def check_palette(data):
            for key, filename in lib['palettes'].items():
                target = data.get('palettes', {}).get(key)
                if not target or data.get('paletteSources', {}).get(key) != lib.get('paletteSources', {}).get(key):
                    raise ValueError('missing or conflicting destination palette')
                if not np.array_equal(pixels(relative_file(source, filename), 'RGB'),
                                      pixels(relative_file(destination, target), 'RGB')):
                    raise ValueError('destination palette colours differ')
        check_palette(current)
        old_pages = copy.deepcopy(current['spriteAtlases'])
        if len(current.get('spriteAtlasesHd') or []) > len(old_pages):
            raise ValueError('destination HD page list exceeds indexed layout')
        mapping, indexed, high, files = {}, [], [], {}
        for page, entry in enumerate(lib['spriteAtlases']):
            hd = lib['spriteAtlasesHd'][page]
            digest = hashlib.sha256(''.join(sha(relative_file(source, e)) for e in
                                           (entry['file'], hd['file'], hd['remap'])).encode()).hexdigest()[:24]
            stem = 'sprites-smudges-s2x-'+digest
            idx = dict(entry, file=stem+'.png')
            colour = dict(hd, file=stem+'@2x.png', remap=stem+'@2x-remap.png')
            for target, origin in [(idx['file'], entry['file']), (colour['file'], hd['file']), (colour['remap'], hd['remap'])]:
                path = destination / target
                if path.exists() and sha(path) != sha(relative_file(source, origin)):
                    raise ValueError('content-addressed filename conflict')
                files[target] = relative_file(source, origin)
            reuse = next((i for i, old in enumerate(old_pages) if old == idx), None)
            if reuse is not None:
                hd_pages = current.get('spriteAtlasesHd') or []
                if reuse >= len(hd_pages) or hd_pages[reuse] != colour:
                    raise ValueError('existing dedicated HD entry changed')
                mapping[page] = reuse
            else:
                mapping[page] = len(old_pages)+len(indexed)
                indexed.append(idx); high.append(colour)
        sprites = copy.deepcopy(lib['sprites'])
        for sprite in sprites.values():
            for frame in sprite['frames'] + sprite.get('shadows', []):
                frame['page'] = mapping[frame.get('page', 0)]
        for target, origin in files.items():
            cache_farm.install_file(destination, target, origin)
        def update(data):
            check_palette(data)
            if data['spriteAtlases'] != old_pages:
                raise ValueError('destination page layout changed during publication')
            for target, origin in files.items():
                if sha(destination/target) != sha(origin):
                    raise ValueError('installed file changed before publication')
            data['spriteAtlases'].extend(indexed)
            hd_pages = list(data.get('spriteAtlasesHd') or [])
            while len(hd_pages) < len(old_pages): hd_pages.append(None)
            hd_pages.extend(high)
            data['spriteAtlasesHd'] = hd_pages
            data.setdefault('sprites', {}).update(sprites)
            data.setdefault('smudges', {}).update(copy.deepcopy(lib['smudges']))
            data['smudgeExtractor'] = copy.deepcopy(lib['smudgeExtractor'])
        cache_farm.patch_json(destination, 'library.json', update)
    return {'theater': lib['theater'], 'decals': len(lib['smudges']), 'pages_added': len(indexed)}


def boards(source, originals, current, output):
    source, originals, current, output = map(Path, (source, originals, current, output))
    lib = validate(source, require_hd=True)
    original_lib = validate(originals, require_hd=False)
    now = read_json(current / 'library.json')
    output.mkdir(parents=True, exist_ok=True)
    results = []
    families = dict.fromkeys(name.rstrip('0123456789') for name in lib['smudges'])
    for family in families:
        names = [name for name in lib['smudges'] if name.rstrip('0123456789') == family]
        board = Image.new('RGB', (910, 84+len(names)*128), (28, 31, 34))
        draw = ImageDraw.Draw(board)
        draw.text((14, 12), f'{lib["theater"].upper()} {family} | 1:1 HD pixels; original nearest 2x', fill='white')
        for x, label in ((165, 'ORIGINAL'), (430, 'CURRENT CACHE'), (704, 'NEW AI DETAIL')):
            draw.text((x, 42), label, fill=(225, 230, 235))
        for row, name in enumerate(names):
            y = 84+row*128
            draw.text((8, y+22), name, fill='white')
            footprint = lib['smudges'][name]
            draw.text((8, y+42), f'{footprint["width"]}x{footprint["height"]} cells', fill=(148, 160, 169))
            for left in (122, 390, 658):
                for yy in range(y+4, y+116, 8):
                    for xx in range(left, left+236, 8):
                        c = (65, 68, 70) if ((xx-left)//8+(yy-y-4)//8)%2 else (75, 78, 80)
                        draw.rectangle((xx, yy, xx+7, yy+7), fill=c)
            def paste(image, left):
                board.paste(image, (left+(236-image.width)//2, y+4+(112-image.height)//2), image)
            original = original_frame(originals, original_lib, name)
            paste(original.resize((original.width*2, original.height*2), Image.Resampling.NEAREST), 122)
            old = now.get('smudges', {}).get(name)
            if old:
                sprite = now['sprites'][old['sprite']]; frame = sprite['frames'][0]
                page = frame.get('page', 0); x, sy, w, h = frame['rect']
                hd = (now.get('spriteAtlasesHd') or [])
                hd = hd[page] if page < len(hd) else None
                if hd:
                    art = pixels(relative_file(current, hd['file']), 'RGBA')[2*sy:2*(sy+h), 2*x:2*(x+w)]
                    paste(Image.fromarray(art), 390)
                else:
                    native = original_frame(current, now, name)
                    paste(native.resize((native.width*2, native.height*2), Image.Resampling.NEAREST), 390)
                    draw.text((394, y+100), 'native indexed fallback; no HD page', fill=(188, 204, 215))
            else:
                draw.text((415, y+42), 'NO LIVE LIBRARY ART', fill=(237, 166, 143))
                draw.text((407, y+64), 'static fallback only if map contains type', fill=(188, 204, 215))
            frame = lib['sprites'][footprint['sprite']]['frames'][0]
            x, sy, w, h = frame['rect']; hd = lib['spriteAtlasesHd'][frame.get('page', 0)]
            art = pixels(relative_file(source, hd['file']), 'RGBA')[2*sy:2*(sy+h), 2*x:2*(x+w)]
            paste(Image.fromarray(art), 658)
        path = output / f'{lib["theater"]}-{family.lower()}-1to1.png'
        board.save(path); results.append(str(path))
    return results


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command', required=True)
    a = sub.add_parser('assemble'); a.add_argument('--job', required=True)
    a.add_argument('--sources', required=True); a.add_argument('--out', required=True)
    i = sub.add_parser('install'); i.add_argument('--source', required=True); i.add_argument('--destination', required=True)
    v = sub.add_parser('validate'); v.add_argument('--source', required=True)
    b = sub.add_parser('boards'); b.add_argument('--source', required=True); b.add_argument('--originals', required=True)
    b.add_argument('--current', required=True); b.add_argument('--out', required=True)
    args = parser.parse_args()
    if args.command == 'assemble': result = assemble(args.job, args.sources, args.out)
    elif args.command == 'install': result = install(args.source, args.destination)
    elif args.command == 'boards': result = boards(args.source, args.originals, args.current, args.out)
    else:
        lib = validate(args.source, require_hd=True)
        result = {'theater': lib['theater'], 'decals': len(lib['smudges'])}
    print(json.dumps(result))


if __name__ == '__main__':
    main()
