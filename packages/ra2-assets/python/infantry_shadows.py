#!/usr/bin/env python3
"""Recover SHP infantry shadows on a dedicated page without rewriting any body art.

The TS exporter uses the same game mount order, decoder and frame indices as the
extractor. Stock infantry has empty shadow halves: palette index 12 in each body
contains the original black footprint (including black detail hidden by the body).
Baked index-1 shadow halves take precedence when supplied by the player.
"""

from __future__ import annotations

import argparse
import base64
import copy
import fcntl
import json
import os
from pathlib import Path
import subprocess
import tempfile

import numpy as np
from PIL import Image, ImageDraw

import cache_farm

THEATRES = ('urban', 'temperate', 'snow', 'desert', 'newurban', 'lunar')
PAGE = 'sprites-infantry-shadows.png'
HD_PAGE = 'sprites-infantry-shadows@2x.png'
REMAP = 'sprites-infantry-shadows@2x-remap.png'


def _json(path):
    return json.loads(Path(path).read_text(encoding='utf-8'))


def _save(image, path):
    """Replace staging inodes: previous installs may still hard-link them."""
    fd, name = tempfile.mkstemp(prefix='.' + path.name, suffix='.tmp', dir=path.parent)
    os.close(fd)
    try:
        image.save(name, format='PNG', compress_level=6)
        os.replace(name, path)
    finally:
        Path(name).unlink(missing_ok=True)


def pack(source, stage: Path, width=4096):
    """Pack one R8 indexed page and aligned 2x black RGBA coverage, deduplicating masks."""
    stage = Path(stage)
    stage.mkdir(parents=True, exist_ok=True)
    if stage.is_symlink():
        raise ValueError('stage must be a real directory')
    unique, frames = {}, {}
    for sid, sprite in sorted(source['sprites'].items()):
        if not sid.startswith('infantry:'):
            raise ValueError('source must contain infantry only')
        if len(sprite['shadows']) != len(sprite['frames']):
            raise ValueError(f'{sid}: shadow/body length differs')
        frames[sid] = []
        for f in sprite['shadows']:
            w, h = f['w'], f['h']
            raw = base64.b64decode(f['pixels'], validate=True)
            if w < 0 or h < 0 or len(raw) != w * h or any(v not in (0, 1) for v in raw):
                raise ValueError(f'{sid}: malformed shadow mask')
            offset = list(f['offset'])
            mask = np.frombuffer(raw, dtype=np.uint8).reshape(h, w)
            yy, xx = np.nonzero(mask)
            if not len(xx):
                frames[sid].append({'rect': [0, 0, 0, 0], 'offset': offset})
                continue
            x0, y0, x1, y1 = int(xx.min()), int(yy.min()), int(xx.max()) + 1, int(yy.max()) + 1
            # Transparent border belongs to the frame: bilinear edges remain inside its quad and retain their mass.
            cropped = np.pad(mask[y0:y1, x0:x1], 1)
            ch, cw = cropped.shape
            key = (cw, ch, cropped.tobytes())
            unique.setdefault(key, cropped)
            frames[sid].append({'key': key, 'offset': [offset[0] + x0 - 1, offset[1] + y0 - 1]})
    rects, x, y, shelf = {}, 1, 1, 0
    for key in sorted(unique, key=lambda k: (-k[1], -k[0], k[2])):
        w, h, _ = key
        if w + 2 > width:
            raise ValueError('shadow exceeds page width')
        if x + w + 1 > width:
            x, y, shelf = 1, y + shelf + 1, 0
        rects[key] = [x, y, w, h]
        x, shelf = x + w + 1, max(shelf, h)
    height = y + shelf + 1
    if height > width:
        raise ValueError(f'one shadow page exceeds {width} square: {height}')
    indexed = np.zeros((height, width), np.uint8)
    rgba = np.zeros((height * 2, width * 2, 4), np.uint8)
    for key, mask in unique.items():
        x, y, w, h = rects[key]
        indexed[y:y + h, x:x + w] = mask
        # Linear reconstruction, no Gaussian blur, threshold, inset or border fade: solid cores stay fully covered.
        alpha = np.asarray(Image.fromarray(mask * 255).resize((w * 2, h * 2), Image.Resampling.BILINEAR))
        core = np.repeat(np.repeat(mask * 255, 2, axis=0), 2, axis=1)
        rgba[2 * y:2 * (y + h), 2 * x:2 * (x + w), 3] = np.maximum(alpha, core)
    for values in frames.values():
        for f in values:
            if 'key' in f:
                f['rect'] = rects[f.pop('key')].copy()
    _save(Image.fromarray(indexed), stage / PAGE)
    _save(Image.fromarray(rgba), stage / HD_PAGE)
    _save(Image.new('L', (width * 2, height * 2)), stage / REMAP)
    return frames, {'file': PAGE, 'width': width, 'height': height}, {
        'file': HD_PAGE, 'remap': REMAP, 'scale': 2, 'width': width * 2, 'height': height * 2}


def _guard(data, source):
    if data['theater'] != source['theater']:
        raise ValueError('theatre differs')
    ids = {sid for sid in data['sprites'] if sid.startswith('infantry:')}
    if ids != set(source['sprites']):
        raise ValueError('infantry sprite set changed')
    for sid, original in source['sprites'].items():
        for key in ('file', 'frameCount', 'sourceFrames', 'frames'):
            if data['sprites'][sid].get(key) != original.get(key):
                raise ValueError(f'{sid}: body/source metadata changed ({key})')


def install(directory: Path, source, stage: Path, *, width=4096):
    """Publish PNGs before a locked JSON patch, preserving every non-shadow field."""
    directory, stage = Path(directory), Path(stage)
    if directory.is_symlink() or not directory.is_dir():
        raise ValueError('destination theatre must be a real directory')
    if directory.parent.name == '_library' and (directory.parent.is_symlink() or directory.parent.parent.is_symlink()):
        raise ValueError('farm and _library must be real directories')
    frames, indexed, hd = pack(source, stage, width)
    with (directory / '.compose.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        current = _json(directory / 'library.json')
        _guard(current, source)
        atlases = current['spriteAtlases']
        matches = [i for i, a in enumerate(atlases) if a['file'] == PAGE]
        if len(matches) > 1:
            raise ValueError('duplicate infantry shadow pages')
        page = matches[0] if matches else len(atlases)
        refs = current.get('spriteAtlasesHd', [])
        if len(refs) > len(atlases):
            raise ValueError('HD atlas slots exceed indexed slots')
        if matches and (page >= len(refs) or not refs[page] or refs[page]['file'] != HD_PAGE):
            raise ValueError('existing shadow page has a conflicting HD slot')
        for values in frames.values():
            for f in values:
                f['page'] = page
        for name in (PAGE, HD_PAGE, REMAP):
            cache_farm.install_file(directory, name, stage / name)

        def update(data):
            _guard(data, source)
            # JSON-only writers may edit unrelated metadata while files are installed; preserve those edits.
            if data['spriteAtlases'] != atlases or data.get('spriteAtlasesHd', []) != refs:
                raise ValueError('atlas slots changed during installation')
            if matches:
                data['spriteAtlases'][page] = indexed
            else:
                data['spriteAtlases'].append(indexed)
            hd_refs = data.setdefault('spriteAtlasesHd', [])
            hd_refs.extend([None] * (page + 1 - len(hd_refs)))
            hd_refs[page] = hd
            for sid, shadows in frames.items():
                data['sprites'][sid]['shadows'] = shadows

        cache_farm.patch_json(directory, 'library.json', update)
        fcntl.flock(lock, fcntl.LOCK_UN)
    # Resolve every recovered frame through BOTH page arrays and check the installed masks.
    data = _json(directory / 'library.json')
    _guard(data, source)
    one = np.asarray(Image.open(directory / data['spriteAtlases'][page]['file']))
    two = np.asarray(Image.open(directory / data['spriteAtlasesHd'][page]['file']))
    recovered = sprites = 0
    total = sum(len(s['frames']) for s in source['sprites'].values())
    for sid, expected in frames.items():
        actual = data['sprites'][sid]['shadows']
        if actual != expected:
            raise ValueError(f'{sid}: installed shadow mapping differs')
        count = 0
        for f in actual:
            x, y, w, h = f['rect']
            if w and h:
                if f['page'] != page or not one[y:y + h, x:x + w].any() or not two[2*y:2*(y+h), 2*x:2*(x+w), 3].any():
                    raise ValueError(f'{sid}: shadow missing from installed pages')
                count += 1
        recovered += count
        sprites += bool(count)
    result = {'theater': source['theater'], 'sprites': sprites, 'totalSprites': len(frames),
              'shadows': recovered, 'totalFrames': total, 'page': page,
              'size': [indexed['width'], indexed['height']]}
    print(json.dumps(result))
    return result


def preview(directory, output):
    """Farm HD bodies plus aligned shadow coverage at 4x on light grey ground."""
    directory, output = Path(directory), Path(output)
    data = _json(directory / 'library.json')
    image = Image.new('RGBA', (1000, 420), (220, 220, 220, 255))
    draw = ImageDraw.Draw(image)
    for col, name in enumerate(('GI', 'INIT', 'SLAV', 'BRUTE', 'DOG')):
        sprite = data['sprites']['infantry:' + name]
        i = next(i for i, f in enumerate(sprite['shadows']) if f['rect'][2] and sprite['frames'][i]['rect'][2])
        # The canvas centre is the draw point, so body and shadow use the same base.
        anchor = (col * 200 + 100, 245)
        for shadow, f in ((True, sprite['shadows'][i]), (False, sprite['frames'][i])):
            ref = data['spriteAtlasesHd'][f.get('page', 0)]
            if not ref or ref['scale'] != 2:
                raise ValueError('preview requires farm HD pages')
            x, y, w, h = f['rect']
            with Image.open(directory / ref['file']) as page:
                crop = page.convert('RGBA').crop((2*x, 2*y, 2*(x+w), 2*(y+h)))
            if shadow:
                crop.putalpha(crop.getchannel('A').point(lambda v: round(v * .78)))
            crop = crop.resize((w*4, h*4), Image.Resampling.BILINEAR)
            image.alpha_composite(crop, (anchor[0] + f['offset'][0]*4, anchor[1] + f['offset'][1]*4))
        draw.text((col*200 + 12, 20), f'{name} frame {i} / 4x', fill=(30, 30, 30))
        # Standalone mask helps inspect the footprint even where the unchanged body already contains black pixels.
        f = sprite['shadows'][i]
        x, y, w, h = f['rect']
        ref = data['spriteAtlasesHd'][f['page']]
        with Image.open(directory / ref['file']) as page:
            crop = page.convert('RGBA').crop((2*x, 2*y, 2*(x+w), 2*(y+h)))
        crop.putalpha(crop.getchannel('A').point(lambda v: round(v*.78)))
        crop = crop.resize((w*4, h*4), Image.Resampling.BILINEAR)
        image.alpha_composite(crop, (anchor[0]-w*2, 280))
    _save(image.convert('RGB'), output)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--game', type=Path, required=True)
    parser.add_argument('--farm', type=Path, required=True)
    parser.add_argument('--stage', type=Path, required=True)
    parser.add_argument('--theatres', nargs='+', choices=THEATRES, default=THEATRES)
    parser.add_argument('--preview', type=Path)
    args = parser.parse_args()
    repo = Path(__file__).resolve().parents[3]
    results = []
    for theatre in args.theatres:
        directory = args.farm / '_library' / theatre
        stage = args.stage / theatre
        subprocess.run(['pnpm', '--config.verify-deps-before-run=false', 'exec', 'tsx',
                        'packages/ra2-assets/src/cli/infantryShadows.mts', '--game', str(args.game),
                        '--library', str(directory), '--out', str(stage)], cwd=repo, check=True)
        results.append(install(directory, _json(stage / 'frames.json'), stage))
    args.stage.mkdir(parents=True, exist_ok=True)
    (args.stage / 'counts.json').write_text(json.dumps(results, indent=2), encoding='utf-8')
    if args.preview:
        args.preview.parent.mkdir(parents=True, exist_ok=True)
        preview(args.farm / '_library' / args.theatres[0], args.preview)


if __name__ == '__main__':
    main()
