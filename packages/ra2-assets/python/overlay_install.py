#!/usr/bin/env python3
"""Install an accepted per-frame overlay whitelist into a separate copy-on-write cache farm.

The whitelist and original-source evidence are caller-supplied. Only current referenced colour crops and
already referenced material crops change. Metadata, indexed pages, remap planes, shadows and other pixels
are preserved. A durable journal backs up each replaced file and refuses rollback after intervening edits.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import tempfile

import numpy as np
from PIL import Image

import cache_farm
import sprite_frame_patch as sfp
import sprite_normals as sn

Image.MAX_IMAGE_PIXELS = None  # Caller-supplied local cache pages are dimension-checked below.


def digest(path: Path) -> str:
    h = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()


def write_json(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(mode='w', dir=path.parent, delete=False) as stream:
        tmp = Path(stream.name)
        json.dump(data, stream, indent=2)
    try:
        os.replace(tmp, path)
    finally:
        tmp.unlink(missing_ok=True)


def pixels(path: Path, mode=None) -> np.ndarray:
    with Image.open(path) as image:
        return np.array(image.convert(mode) if mode else image)


def red_plane(path: Path) -> np.ndarray:
    value = pixels(path)
    return value[..., 0] if value.ndim == 3 else value


def key(target: dict) -> tuple:
    return target['theatre'], target['sprite'], target['frame']


def source_hash(value, frame, sprite, indexed=False) -> str:
    w, h = frame['rect'][2:]
    metadata = (w, h, frame['offset'], sprite.get('remap', False))
    if indexed:
        metadata += (sprite['palette'],)
    return hashlib.sha256(str(metadata).encode() + value.tobytes()).hexdigest()


def separate(base: Path, farm: Path, out: Path) -> None:
    a, b, c = base.resolve(), farm.resolve(), out.resolve()
    if any(x == y or x in y.parents or y in x.parents for x, y in ((a, b), (b, c), (a, c))):
        raise ValueError('base, farm and receipt directory must be separate, non-nested directories')
    if not farm.is_dir() or farm.is_symlink():
        raise ValueError('farm root must already be a real directory')
    # cache_farm can realise directories below this root; ancestors are outside its write ownership.
    if any(p.is_symlink() for p in farm.absolute().parents):
        raise ValueError('farm ancestors must not be symlinks')


def plan(farm: Path, whitelist: Path, evidence: Path, theatres=None) -> tuple[list, dict]:
    manifest = sfp.read(whitelist)
    assets = manifest.get('assets')
    if manifest.get('version') != 1 or not isinstance(assets, list) or not assets:
        raise ValueError('whitelist must be version 1 with nonempty assets')
    audit = {key(t): t for t in json.loads((evidence / 'frame-audit.json').read_text())}
    sources = {}

    def guard(path: Path, expected=None):
        path = path.absolute()
        if str(path) not in sources:
            sources[str(path)] = digest(path)
        actual = sources[str(path)]
        if expected is not None and actual != expected:
            raise ValueError(f'source hash changed: {path}')

    guard(whitelist)
    guard(evidence / 'frame-audit.json')
    libraries, snapshots, grouped, seen = {}, {}, {}, set()
    for asset in assets:
        if not str(asset.get('status', '')).startswith('accepted'):
            raise ValueError('whitelist contains an unaccepted asset')
        guard(Path(asset['file']), asset['sha256'])
        for name, sha in (('source_png', 'source_png_sha256'), ('source_generated_asset', 'source_generated_sha256')):
            if asset.get(name):
                guard(Path(asset[name]), asset[sha])
        if asset.get('remap'):
            guard(Path(asset['remap']))
        for target in asset['targets']:
            th, sid, fi = key(target)
            if theatres and th not in theatres:
                continue
            if key(target) in seen:
                raise ValueError(f'duplicate target: {key(target)}')
            seen.add(key(target))
            original = audit.get(key(target))
            fields = ('rect', 'offset', 'page', 'palette', 'source_file', 'source_hash', 'index_hash')
            if original is None or any(original.get(f) != target.get(f) for f in fields):
                raise ValueError(f'target differs from frame evidence: {key(target)}')
            if asset['index_hash'] != target['index_hash']:
                raise ValueError(f'asset indexed identity differs: {key(target)}')
            if th not in libraries:
                directory = sfp.local_path(farm, f'_library/{th}')
                snap = evidence / f'library-{th}.json'
                guard(snap)
                guard(directory / 'library.json')
                libraries[th] = sfp.read(directory / 'library.json')
                snapshots[th] = sfp.read(snap)
            lib, snapshot = libraries[th], snapshots[th]
            sprite = lib.get('sprites', {}).get(sid)
            if sprite != snapshot.get('sprites', {}).get(sid):
                raise ValueError(f'current sprite metadata changed: {key(target)}')
            if not isinstance(fi, int) or isinstance(fi, bool) or not 0 <= fi < len(sprite['frames']):
                raise ValueError(f'invalid frame index: {key(target)}')
            frame = sprite['frames'][fi]
            if (frame['rect'] != target['rect'] or frame['offset'] != target['offset']
                    or frame.get('page', 0) != target['page'] or sprite['palette'] != target['palette']
                    or sprite['file'] != target['source_file']):
                raise ValueError(f'current frame geometry/file/palette changed: {key(target)}')
            page = frame.get('page', 0)
            hd = lib.get('spriteAtlasesHd', [])
            if page >= len(hd) or not hd[page] or hd[page].get('scale') != 2:
                raise ValueError(f'current target has no 2x HD page: {key(target)}')
            if lib['paletteSources'].get(sprite['palette']) != snapshot['paletteSources'].get(sprite['palette']):
                raise ValueError(f'palette source changed: {key(target)}')
            grouped.setdefault((th, page), []).append((asset, target))
    if not grouped:
        raise ValueError('no selected accepted targets')
    planned = []
    for (th, page), entries in sorted(grouped.items()):
        directory = sfp.local_path(farm, f'_library/{th}')
        lib = libraries[th]
        hd, indexed = lib['spriteAtlasesHd'][page], lib['spriteAtlases'][page]
        paths = {kind: sfp.local_path(directory, ref) for kind, ref in
                 (('hd', hd['file']), ('remap', hd['remap']), ('indexed', indexed['file']))}
        for path in paths.values():
            guard(path)
        idx, paint = red_plane(paths['indexed']), red_plane(paths['remap'])
        if idx.shape != (indexed['height'], indexed['width']) or paint.shape != (hd['height'], hd['width']):
            raise ValueError(f'current index/remap page dimensions changed: {th}/{page}')
        if (indexed['width'] * 2, indexed['height'] * 2) != (hd['width'], hd['height']):
            raise ValueError(f'current HD scale/dimensions changed: {th}/{page}')
        palettes, patches = {}, []
        with Image.open(paths['hd']) as current:
            if current.mode != 'RGBA' or current.size != (hd['width'], hd['height']):
                raise ValueError(f'current HD page dimensions/mode changed: {th}/{page}')
            for asset, target in entries:
                sid, fi = target['sprite'], target['frame']
                sprite, frame = lib['sprites'][sid], lib['sprites'][sid]['frames'][fi]
                x, y, w, h = frame['rect']
                if min(x, y) < 0 or min(w, h) < 1 or x + w > idx.shape[1] or y + h > idx.shape[0]:
                    raise ValueError(f'target outside indexed page: {key(target)}')
                crop = idx[y:y+h, x:x+w]
                if source_hash(crop, frame, sprite, True) != target['index_hash']:
                    raise ValueError(f'current indexed pixels changed: {key(target)}')
                pal = sprite['palette']
                if pal not in palettes:
                    pp = sfp.local_path(directory, lib['palettes'][pal]);guard(pp)
                    palettes[pal] = pixels(pp, 'RGB').reshape(-1, 3)
                native = np.dstack((palettes[pal][crop], (crop > 0).astype(np.uint8) * 255))
                if source_hash(native, frame, sprite) != target['source_hash']:
                    raise ValueError(f'current decoded original/palette changed: {key(target)}')
                for native_path in {Path(asset['native']), Path(target['source'])}:
                    guard(native_path)
                    if not np.array_equal(pixels(native_path, 'RGBA'), native):
                        raise ValueError(f'staged native original differs: {key(target)}')
                patch = pixels(Path(asset['file']), 'RGBA')
                if patch.shape != (2*h, 2*w, 4) or not np.array_equal(
                        patch[..., 3], np.repeat(np.repeat(native[..., 3], 2, 0), 2, 1)):
                    raise ValueError(f'accepted crop size/original alpha changed: {key(target)}')
                remap = paint[2*y:2*(y+h), 2*x:2*(x+w)]
                ramp = np.repeat(np.repeat(((crop >= 16) & (crop <= 31) & bool(sprite.get('remap'))), 2, 0), 2, 1)
                if np.any((remap > 0) & ~ramp) or (ramp.any() and not np.array_equal(remap > 0, ramp)):
                    raise ValueError(f'current remap plane differs from original indexed support: {key(target)}')
                if asset.get('remap') and not np.array_equal(red_plane(Path(asset['remap'])), remap):
                    raise ValueError(f'inherited remap differs from current plane: {key(target)}')
                # Keep current house-paint RGBA while leaving the complete current remap plane untouched.
                if ramp.any():
                    old = np.array(current.crop((2*x, 2*y, 2*(x+w), 2*(y+h))))
                    if not np.array_equal(old[..., 3][ramp], patch[..., 3][ramp]):
                        raise ValueError(f'house-remap alpha changed: {key(target)}')
                    patch[ramp] = old[ramp]
                patches.append({'target': target, 'rgba': patch, 'indices': crop.copy()})
        normal_path = directory / 'normals.json'
        normal = None
        if normal_path.exists():
            guard(normal_path)
            normal = sfp.read(normal_path).get('pages', {}).get(str(page))
            if normal:
                if any(normal.get(a) != hd.get(b) for a, b in
                       (('atlas', 'file'), ('width', 'width'), ('height', 'height'), ('scale', 'scale'))):
                    raise ValueError(f'stale normal binding: {th}/{page}')
                guard(sfp.local_path(directory, normal['file']))
        window = directory / 'windows.json'
        if window.exists():
            guard(window)
            window_file = sfp.read(window).get('pages', {}).get(str(page))
            if window_file:
                guard(sfp.local_path(directory, window_file))
        planned.append({'theatre': th, 'page': page, 'library': lib, 'hd': hd, 'normal': normal, 'patches': patches})
    return planned, sources


def validate_sources(sources):
    for filename, expected in sources.items():
        if digest(Path(filename)) != expected:
            raise ValueError(f'source changed during preparation: {filename}')


def prepare(planned: list, farm: Path, out: Path) -> list[dict]:
    files = []
    for item in planned:
        th, page, lib = item['theatre'], item['page'], item['library']
        directory = sfp.local_path(farm, f'_library/{th}')
        staged = out / 'prepared' / th / str(page)
        staged.mkdir(parents=True)
        specs = []
        for i, patch in enumerate(item['patches']):
            filename = f'{i}.png'
            Image.fromarray(patch['rgba']).save(staged / filename)
            specs.append({'sprite': patch['target']['sprite'], 'frame': patch['target']['frame'], 'hd': filename})
        write_json(staged / 'patch-spec.json', {'frames': specs})
        pages, _ = sfp.prepare(lib, lambda name: sfp.local_path(directory, name), staged / 'patch-spec.json')
        for name, image in pages.items():
            path = staged / 'color.png';image.save(path)
            files.append({'rel': f'_library/{th}/{name}', 'prepared': str(path.absolute())})
            image.close()
        if item['normal']:
            normal = item['normal']
            path = sfp.local_path(directory, normal['file'])
            material = pixels(path, 'RGBA')
            ih, iw = item['hd']['height'] // 2, item['hd']['width'] // 2
            if (material.shape[1], material.shape[0]) != (normal['materialWidth'], normal['materialHeight']):
                raise ValueError(f'normal PNG dimensions differ: {th}/{page}')
            if material.shape[:2] == (ih, iw):
                scale = 1
            elif material.shape[:2] == (2*ih, 2*iw):
                scale = 2
            else:
                raise ValueError(f'unsupported normal resolution: {th}/{page}')
            windows = {}
            if (directory / 'windows.json').exists():
                windows = sfp.read(directory / 'windows.json').get('pages', {})
            window = None
            if str(page) in windows:
                window = red_plane(sfp.local_path(directory, windows[str(page)]))
                if window.shape != (ih, iw):
                    raise ValueError(f'window plane size differs: {th}/{page}')
            for patch in item['patches']:
                t = patch['target'];sid, fi = t['sprite'], t['frame']
                frame = lib['sprites'][sid]['frames'][fi]
                # This supplies the existing foundation policy for building layers; no new material class is added.
                entries = sn.library_frames(lib, [sid.split(':')[0] + ':'], [f'{sid}#{fi}'])
                entry = entries[page][0][3]
                x, y, w, h = frame['rect']
                lit = None if window is None else np.repeat(np.repeat(window[y:y+h, x:x+w] > 0, 2, 0), 2, 1)
                encoded, _ = sn.frame_material(sid, fi, frame, entry, patch['rgba'].astype(np.float32) / 255,
                                                patch['indices'], lit)
                if encoded is None:
                    raise ValueError(f'accepted nonempty crop has no material: {key(t)}')
                if scale == 1:
                    encoded = sn.downsample_material(encoded)
                material[scale*y:scale*(y+h), scale*x:scale*(x+w)] = np.round(encoded * 255).astype(np.uint8)
            target = staged / 'normal.png';Image.fromarray(material).save(target)
            files.append({'rel': f'_library/{th}/{normal["file"]}', 'prepared': str(target.absolute())})
    if len({f['rel'] for f in files}) != len(files):
        raise ValueError('several page references share a destination; do not overwrite aliases')
    return files


def apply(base: Path, farm: Path, whitelist: Path, evidence: Path, out: Path, theatres=None,
          reserve_bytes=25*1024**3, validate_only=False) -> dict:
    separate(base, farm, out)
    if reserve_bytes < 25*1024**3:
        raise ValueError('disk reserve must be at least 25 GiB')
    planned, sources = plan(farm, whitelist, evidence, theatres)
    report = {'version': 1, 'base': str(base.resolve()), 'farm': str(farm.absolute()),
              'whitelist': str(whitelist.absolute()), 'sources': sources,
              'frames': [p['target'] for item in planned for p in item['patches']], 'files': [],
              'status': 'validated', 'live': 'UNVERIFIED'}
    if validate_only:
        return report
    estimated = 3 * sum((farm / f).stat().st_size
                        for f in {str(Path(name).relative_to(farm.absolute())) for name in sources
                                  if Path(name).is_relative_to(farm.absolute()) and name.endswith('.png')})
    if min(shutil.disk_usage(farm).free, shutil.disk_usage(out.parent).free) < reserve_bytes + estimated:
        raise ValueError(f'insufficient disk space; require reserve plus {estimated} estimated bytes')
    out.mkdir(parents=True, exist_ok=False)
    write_json(out / 'install.json', report)
    files = prepare(planned, farm, out)
    validate_sources(sources)
    for i, record in enumerate(files):
        destination = sfp.local_path(farm, record['rel'])
        backup = out / 'backup' / f'{i}.bin';backup.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(destination, backup)
        record.update(before_sha256=digest(backup), after_sha256=digest(Path(record['prepared'])),
                      backup=str(backup.absolute()), state='prepared')
    report.update(files=files, status='prepared')
    write_json(out / 'install.json', report)
    # The journal precedes every replace. A interrupted 'prepared' record can be rolled back by its exact hash.
    with cache_farm._locked(out / '.install.lock'):
        validate_sources(sources)
        for record in files:
            destination = sfp.local_path(farm, record['rel'])
            if digest(destination) != record['before_sha256']:
                raise ValueError(f'concurrent destination change: {record["rel"]}')
            cache_farm.install_file(farm, record['rel'], Path(record['prepared']))
            if digest(destination) != record['after_sha256']:
                raise ValueError(f'installed bytes differ: {record["rel"]}')
            record['state'] = 'installed';write_json(out / 'install.json', report)
        report['status'] = 'installed';write_json(out / 'install.json', report)
    return report


def undo(receipt: Path) -> dict:
    report = sfp.read(receipt)
    farm, base = Path(report['farm']), Path(report['base'])
    separate(base, farm, receipt.parent)
    if report.get('version') != 1 or report.get('status') not in ('prepared', 'installed', 'undoing'):
        raise ValueError('receipt has no recoverable installation')
    with cache_farm._locked(receipt.parent / '.install.lock'):
        # Guard metadata and unchanged cache inputs as well as destination bytes: a later rebinding may depend
        # on the installed art even if its PNG bytes did not change. Staged provenance does not affect undo.
        replaced = {str(sfp.local_path(farm, r['rel']).absolute()) for r in report['files']}
        for filename, expected in report['sources'].items():
            path = Path(filename)
            if path.is_relative_to(farm.absolute()) and filename not in replaced and digest(path) != expected:
                raise ValueError(f'intervening metadata/input edit prevents rollback: {filename}')
        # Guard all destinations and backups before restoring any file. Unrelated later edits are never lost.
        for record in report['files']:
            path = sfp.local_path(farm, record['rel'])
            if digest(Path(record['backup'])) != record['before_sha256']:
                raise ValueError(f'backup changed: {record["rel"]}')
            if digest(path) not in (record['before_sha256'], record['after_sha256']):
                raise ValueError(f'intervening edit prevents rollback: {record["rel"]}')
        report['status'] = 'undoing';write_json(receipt, report)
        for record in report['files']:
            cache_farm.install_file(farm, record['rel'], Path(record['backup']))
            if digest(sfp.local_path(farm, record['rel'])) != record['before_sha256']:
                raise ValueError(f'rollback bytes differ: {record["rel"]}')
            record['state'] = 'restored';write_json(receipt, report)
        report['status'] = 'restored';write_json(receipt, report)
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--undo', type=Path)
    parser.add_argument('--base', type=Path)
    parser.add_argument('--farm', type=Path)
    parser.add_argument('--whitelist', type=Path)
    parser.add_argument('--evidence', type=Path)
    parser.add_argument('--out', type=Path)
    parser.add_argument('--theatre', action='append')
    parser.add_argument('--validate-only', action='store_true')
    args = parser.parse_args()
    if args.undo:
        result = undo(args.undo)
    else:
        for required in ('base', 'farm', 'whitelist', 'evidence', 'out'):
            if getattr(args, required) is None:
                parser.error(f'--{required} is required unless --undo is used')
        result = apply(args.base, args.farm, args.whitelist, args.evidence, args.out,
                       args.theatre, validate_only=args.validate_only)
    print(json.dumps({'status': result['status'], 'frames': len(result['frames']), 'files': len(result['files'])}))


if __name__ == '__main__':
    main()
