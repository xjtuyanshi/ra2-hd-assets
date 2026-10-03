"""Transfer prepared HD map sprites only after exact native-frame validation.

Target frame geometry, indexed pixels and empty shadows remain authoritative.
Only spriteAtlasHd is published, through the copy-on-write farm's JSON lock.
"""

from __future__ import annotations

import argparse
from collections import Counter
import hashlib
import json
from pathlib import Path
import tempfile

import numpy as np
from PIL import Image

import atlas_install
import cache_farm


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def relative(root: Path, name: str) -> Path:
    if not isinstance(name, str):
        raise ValueError('file reference must be a string')
    path = Path(name)
    if path.is_absolute() or '..' in path.parts or not path.name:
        raise ValueError('file references must be nonempty relative paths without traversal')
    return root / path


def integers(value, length, label, minimum=None):
    if (not isinstance(value, list) or len(value) != length or
            any(not isinstance(n, int) or isinstance(n, bool) for n in value) or
            (minimum is not None and any(n < minimum for n in value))):
        raise ValueError(f'{label}: invalid integer coordinates')
    return value


def rectangle(frame, size, label):
    x, y, w, h = integers(frame.get('rect'), 4, label, 0)
    integers(frame.get('offset'), 2, label)
    if frame.get('page', 0) != 0:
        raise ValueError(f'{label}: map atlases must have only page zero')
    if (w == 0) != (h == 0) or x + w > size[0] or y + h > size[1]:
        raise ValueError(f'{label}: invalid or out-of-bounds rectangle')
    return x, y, w, h


def box(rect, scale=1):
    x, y, w, h = rect
    return x * scale, y * scale, (x + w) * scale, (y + h) * scale


def prepare(source: Path, target: Path):
    """Validate every native target frame and build its HD page without any writes."""
    source, target = Path(source), Path(target)
    snapshots = {}

    def read(path):
        data = path.read_bytes()
        snapshots[path] = digest(data)
        return data

    def image(path, mode=None):
        # Snapshot the exact bytes that Pillow decodes, rather than opening the path again.
        import io
        with Image.open(io.BytesIO(read(path))) as opened:
            if mode is not None and opened.mode != mode:
                raise ValueError(f'{path.name}: expected {mode}, got {opened.mode}')
            return opened.copy()

    src = json.loads(read(source / 'manifest.json'))
    dst = json.loads(read(target / 'manifest.json'))
    if dst.get('spriteAtlasHd'):
        raise ValueError('target already has spriteAtlasHd')
    src_ref, dst_ref = src['spriteAtlas'], dst['spriteAtlas']
    native_source = image(relative(source, src_ref['file']))
    native_target = image(relative(target, dst_ref['file']))
    if native_source.mode not in {'L', 'RGBA'} or native_source.mode != native_target.mode:
        raise ValueError('native atlas modes differ or are unsupported')
    for ref, atlas in ((src_ref, native_source), (dst_ref, native_target)):
        if atlas.size != (ref['width'], ref['height']):
            raise ValueError('native atlas dimensions do not match metadata')
    hd_ref = src['spriteAtlasHd']
    if hd_ref.get('scale') != 2:
        raise ValueError('prepared HD atlas must be exactly 2x')
    hd = image(relative(source, hd_ref['file']), 'RGBA')
    remap = image(relative(source, hd_ref['remap']), 'L')
    if (hd.size != remap.size or hd.size != (native_source.width * 2, native_source.height * 2) or
            hd.size != (hd_ref['width'], hd_ref['height'])):
        raise ValueError('prepared HD/remap dimensions do not match native geometry')
    if src['palettes'].keys() != dst['palettes'].keys():
        raise ValueError('palette keys differ')
    for key, name in dst['palettes'].items():
        if read(relative(target, name)) != read(relative(source, src['palettes'][key])):
            raise ValueError(f'{key}: palette bytes differ')
    if src['sprites'].keys() != dst['sprites'].keys():
        raise ValueError('sprite IDs differ')
    for field in ('theater', 'version'):
        if src.get(field) != dst.get(field):
            raise ValueError(f'{field}: map sprite contract differs')

    counts = Counter()
    copies, discarded, transfers = [], [], []
    for key, sprite in dst['sprites'].items():
        prepared = src['sprites'][key]
        # Includes canvas, palette, file, frameCount, sourceFrames, remap and timing metadata.
        metadata = lambda value: {k: v for k, v in value.items() if k not in {'frames', 'shadows'}}
        if metadata(sprite) != metadata(prepared):
            raise ValueError(f'{key}: sprite metadata differs')
        for field in ('frames', 'shadows'):
            targets, sources = sprite.get(field, []), prepared.get(field, [])
            if len(targets) != len(sources) or (field in sprite) != (field in prepared):
                raise ValueError(f'{key}: {field} count differs')
            for index, (frame, original) in enumerate(zip(targets, sources)):
                label = f'{key}/{field}/{index}'
                tr = rectangle(frame, native_target.size, label)
                sr = rectangle(original, native_source.size, label)
                if field == 'shadows' and tr[2] == 0 and sr[2] > 0:
                    # New preparation can discover extra original-source shadows. They are
                    # deliberately unused: target emptiness and offsets must never change.
                    discarded.append({'sprite': key, 'frame': index, 'target': frame, 'source': original})
                    counts['empty_shadows'] += 1
                    continue
                if tr[2:] != sr[2:]:
                    raise ValueError(f'{label}: frame dimensions or empty state differ')
                if {k: v for k, v in frame.items() if k != 'rect'} != {
                        k: v for k, v in original.items() if k != 'rect'}:
                    raise ValueError(f'{label}: frame metadata differs')
                if tr[2] == 0:
                    counts['empty_' + field] += 1
                    continue
                native = native_target.crop(box(tr)).tobytes()
                if native != native_source.crop(box(sr)).tobytes():
                    raise ValueError(f'{label}: native indexed crop bytes differ')
                copies.append((label, tr, sr))
                transfers.append({'frame': label, 'target_rect': list(tr), 'source_rect': list(sr),
                                  'native_crop_sha256': digest(native),
                                  'hd_crop_sha256': digest(hd.crop(box(sr, 2)).tobytes()),
                                  'remap_crop_sha256': digest(remap.crop(box(sr, 2)).tobytes())})
                counts[field] += 1

    # Paste exactly, without resizing, filtering, alpha compositing or palette conversion.
    size = (native_target.width * 2, native_target.height * 2)
    pixels = np.zeros((size[1], size[0], 4), np.uint8)
    masks = np.zeros((size[1], size[0]), np.uint8)
    occupied = np.zeros((size[1], size[0]), bool)
    for label, tr, sr in copies:
        x0, y0, x1, y1 = box(tr, 2)
        colour = np.asarray(hd.crop(box(sr, 2)))
        mask = np.asarray(remap.crop(box(sr, 2)))
        prior = occupied[y0:y1, x0:x1]
        if (np.any(pixels[y0:y1, x0:x1][prior] != colour[prior]) or
                np.any(masks[y0:y1, x0:x1][prior] != mask[prior])):
            raise ValueError(f'{label}: conflicting overlapping target rectangles')
        pixels[y0:y1, x0:x1] = colour
        masks[y0:y1, x0:x1] = mask
        occupied[y0:y1, x0:x1] = True

    report = {'sprites': len(dst['sprites']), 'counts': dict(counts),
              'discarded_unused_source_shadow': discarded,
              'inputs': {str(path): sha for path, sha in snapshots.items()},
              'target_native_sha256': digest(native_target.tobytes()),
              'transfers': transfers,
              'direct_install_compatible': (src['sprites'] == dst['sprites'] and
                                            native_source.size == native_target.size and
                                            native_source.tobytes() == native_target.tobytes()),
              'output_native_geometry': dst_ref,
              'output_hd_size': list(size), 'scale': 2}
    return dst, Image.fromarray(pixels), Image.fromarray(masks), report, snapshots


def validate(source: Path, target: Path):
    return prepare(source, target)[3]


def install(farm: Path, source: Path, target: Path, name: str):
    """Publish HD pages while preserving current farm siblings and all native files."""
    atlas_install.component(name)
    farm, source, target = Path(farm), Path(source), Path(target)
    resolved = farm.resolve()
    for input_dir in (source.resolve(), target.resolve()):
        if resolved == input_dir or resolved in input_dir.parents or input_dir in resolved.parents:
            raise ValueError('farm root and input map directories must be separate, non-nested')
    expected, hd, remap, report, snapshots = prepare(source, target)
    with tempfile.TemporaryDirectory(prefix='atlas-relayout-') as tmp:
        work = Path(tmp)
        hd.save(work / 'hd.png')
        remap.save(work / 'remap.png')
        hd_hash, remap_hash = digest((work / 'hd.png').read_bytes()), digest((work / 'remap.png').read_bytes())
        reference = {'file': f'sprites-relayout-{hd_hash}.png',
                     'remap': f'sprites-relayout-remap-{remap_hash}.png', 'scale': 2,
                     'width': hd.width, 'height': hd.height}

        def publish(current):
            if current.get('spriteAtlasHd'):
                raise ValueError('farm manifest already has spriteAtlasHd')
            for field in ('sprites', 'spriteAtlas', 'palettes', 'theater', 'version'):
                if current.get(field) != expected.get(field):
                    raise ValueError(f'farm {field} changed after target validation')
            for path, sha in snapshots.items():
                if digest(path.read_bytes()) != sha:
                    raise ValueError(f'input changed after validation: {path}')
            # Pages are published first; failure cannot make a manifest reference incomplete art.
            cache_farm.install_file(farm, f'{name}/{reference["file"]}', work / 'hd.png')
            cache_farm.install_file(farm, f'{name}/{reference["remap"]}', work / 'remap.png')
            current['spriteAtlasHd'] = reference

        cache_farm.patch_json(farm, f'{name}/manifest.json', publish)
    report['spriteAtlasHd'] = reference
    report['output_sha256'] = {'file': hd_hash, 'remap': remap_hash}
    return report


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', required=True, type=Path, help='prepared map directory')
    parser.add_argument('--target', required=True, type=Path, help='authoritative native map directory')
    parser.add_argument('--farm', type=Path, help='separate copy-on-write farm; omit for read-only validation')
    parser.add_argument('--name', help='map directory name inside the farm')
    args = parser.parse_args(argv)
    if bool(args.farm) != bool(args.name):
        parser.error('--farm and --name must be supplied together')
    result = install(args.farm, args.source, args.target, args.name) if args.farm else validate(args.source, args.target)
    print(json.dumps(result, indent=2))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
