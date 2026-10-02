"""Read-only rules-unit coverage, calibrated against original and stage-0 sprite art.

Only NumPy and Pillow are needed at runtime. Scores are structural evidence, not
image-model provenance: unchanged frames in a redrawn type remain uncompleted.
"""
from __future__ import annotations

import argparse
from collections import Counter, defaultdict
from contextlib import ExitStack
from functools import lru_cache
import hashlib
import json
import math
from pathlib import Path
import sys
import time

import numpy as np
from PIL import Image

THEATERS = ('urban', 'temperate', 'desert', 'lunar', 'newurban', 'snow')
THEATER_NAMES = dict(zip(THEATERS, ('城市', '温带', '沙漠', '月球', '新城市', '雪地')))
KINDS = ('infantry', 'vehicle', 'aircraft', 'building-turret')
KIND_NAMES = dict(zip(KINDS, ('步兵', '车辆', '飞机', '建筑炮塔')))
REDRAWN = ('infantry:GI', 'infantry:CONS', 'infantry:INIT', 'infantry:FLAKT',
           'infantry:SEAL', 'infantry:BRUTE', 'vehicle:DLPH', 'vehicle:SQD')
NOT_REDRAWN = ('infantry:CIVA', 'infantry:EINS', 'infantry:MUMY', 'infantry:PRES',
               'infantry:CAML', 'infantry:DNOA')


def read_json(path):
    return json.loads(Path(path).read_text(encoding='utf-8'))


def status_for(total, redrawn, incomplete=False):
    return ('已完成' if total > 0 and total == redrawn and not incomplete
            else '部分' if redrawn else '未完成')


def combine_status(statuses):
    return ('已完成' if statuses and all(s == '已完成' for s in statuses)
            else '部分' if any(s != '未完成' for s in statuses) else '未完成')


def lab(rgb):
    """sRGB to CIE Lab (D65), without an optional colour-science dependency."""
    rgb = np.asarray(rgb, dtype=np.float64) / 255
    linear = np.where(rgb <= .04045, rgb / 12.92, ((rgb + .055) / 1.055) ** 2.4)
    xyz = linear @ np.array([[.4124564, .3575761, .1804375],
                             [.2126729, .7151522, .0721750],
                             [.0193339, .1191920, .9503041]]).T
    xyz /= np.array([.95047, 1, 1.08883])
    f = np.where(xyz > (6 / 29) ** 3, np.cbrt(xyz), xyz / (3 * (6 / 29) ** 2) + 4 / 29)
    return np.stack((116 * f[..., 1] - 16, 500 * (f[..., 0] - f[..., 1]),
                     200 * (f[..., 1] - f[..., 2])), axis=-1)


def downsample(rgba, paint=None, ramp=None, scale=2):
    """Compose remap before alpha-weighted BOX reduction; transparent bleed is not body colour."""
    rgb = rgba[..., :3].astype(np.float64)
    if paint is not None:
        if ramp is None:
            raise ValueError('HD remap page requires a 16-colour reference ramp')
        k = np.clip((255 - rgb[..., 1]) / 15, 0, 15)
        low = k.astype(int)
        colour = ramp[low] + (ramp[np.minimum(low + 1, 15)] - ramp[low]) * (k - low)[..., None]
        weight = (paint / 255)[..., None]
        rgb = rgb * (1 - weight) + colour * weight
    height, width = rgba.shape[:2]
    alpha = rgba[..., 3:4].astype(np.float64) / 255
    shape = (height // scale, scale, width // scale, scale)
    reduced_alpha = alpha.reshape(*shape, 1).mean((1, 3))
    reduced_rgb = (rgb * alpha).reshape(*shape, 3).mean((1, 3)) / np.maximum(reduced_alpha, 1e-9)
    return np.concatenate((reduced_rgb, reduced_alpha * 255), axis=-1)


def frame_metrics(original, current, baseline, comparison_mask=None):
    """Compare common non-shadow body pixels; retain raw-original deltas for audit."""
    nonempty = bool(np.any(original[..., 3] > 0))
    body = ((original[..., 3] > 0) & (current[..., 3] > 0)
            & (original[..., :3].max(-1) > 24) & (current[..., :3].max(-1) > 24)
            & (baseline[..., 3] > 0) & (baseline[..., :3].max(-1) > 24))
    if comparison_mask is not None:
        body &= comparison_mask
    excluded = int(((original[..., 3] > 0) & ~comparison_mask).sum()) if comparison_mask is not None else 0
    result = {'baseline_palette_pixels_excluded': excluded,
              'non_empty': nonempty, 'body_pixels': int(body.sum()), 'score': None,
              'original_lab': None, 'baseline_original_lab': None}
    if not body.any():
        if nonempty:
            result['issue'] = '无共同非阴影身体像素'
        return result
    a, b, c = lab(original[..., :3]), lab(current[..., :3]), lab(baseline[..., :3])
    result.update(score=float(np.linalg.norm(b - c, axis=-1)[body].mean()),
                  original_lab=float(np.linalg.norm(b - a, axis=-1)[body].mean()),
                  baseline_original_lab=float(np.linalg.norm(c - a, axis=-1)[body].mean()))
    return result


def _ref(data, directory, key, page, channel='file'):
    refs = data.get(key) or []
    entry = refs[page] if 0 <= page < len(refs) else None
    name = entry.get(channel) if isinstance(entry, dict) else entry if channel == 'file' else None
    return str(directory / name) if name else None


@lru_cache(maxsize=None)
def _content_identity(resolved, size, mtime):
    # Identical PNGs in different theater directories also share numeric crops.
    with open(resolved, 'rb') as stream:
        return (size, hashlib.file_digest(stream, 'sha256').hexdigest())


@lru_cache(maxsize=None)
def _identity(path):
    if path is None:
        return None
    p = Path(path)
    try:
        st = p.stat()
        return _content_identity(str(p.resolve()), st.st_size, st.st_mtime_ns)
    except OSError:
        return (str(p.absolute()), 'missing')


def _crop(image, rect, scale=1):
    x, y, w, h = rect
    if x < 0 or y < 0 or w <= 0 or h <= 0 or (x + w) * scale > image.width or (y + h) * scale > image.height:
        raise ValueError('frame rectangle outside atlas')
    return image.crop((x * scale, y * scale, (x + w) * scale, (y + h) * scale))


class SpriteScanner:
    """Decode each page once; reuse baseline crops and scores by verified pixel content."""
    def __init__(self):
        self.metrics_cache = {}
        self.palette_cache = {}
        self.reference_frames = {}
        self.reference_cache = {}
        self.pixel_metrics = {}
        self.page_loads = 0

    def palette(self, path):
        if path not in self.palette_cache:
            with Image.open(path) as image:
                self.palette_cache[path] = np.asarray(image.convert('RGB')).reshape(-1, 3)[:256].copy()
        return self.palette_cache[path]

    def original(self, crop, palette_path, ramp):
        if crop.mode in ('L', 'P') and palette_path:
            indices = np.asarray(crop)
            palette = self.palette(palette_path).copy()
            if ramp is not None:
                palette[16:32] = ramp
            rgba = np.concatenate((palette[indices], ((indices != 0) * 255)[..., None]), -1).astype(np.uint8)
            rgba[indices == 12, :3] = 0
            rgba[rgba[..., 3] == 0, :3] = 0
            return rgba
        if crop.mode == 'L':
            raise ValueError('indexed original requires sprite palette')
        rgba = np.asarray(crop.convert('RGBA')).copy()
        rgba[rgba[..., 3] == 0, :3] = 0
        return rgba

    def scan(self, directory, data, base_dir, base, keys, fallback=None):
        results, groups = {}, defaultdict(list)
        schemes = data.get('colorSchemes', [])
        red = data.get('colorSchemesByName', {}).get('Red', 0)
        ramp = np.asarray(schemes[red]['remap'][:16], dtype=float) if schemes else None
        ramp_key = None if ramp is None else ramp.tobytes()
        for key in sorted(keys):
            sprite = data.get('sprites', {}).get(key)
            if not sprite:
                results[key] = [{'non_empty': None, 'score': None, 'issue': f'缺 sprite {key}'}]
                continue
            records = results[key] = []
            for index, frame in enumerate(sprite.get('frames', [])):
                record = {'index': index, 'non_empty': False, 'score': None}
                records.append(record)
                rect = frame.get('rect', [0, 0, 0, 0])
                if rect[2] <= 0 or rect[3] <= 0:
                    continue
                record['non_empty'] = None
                try:
                    source_dir, source = base_dir, base
                    baseline = source['sprites'][key]['frames'][index]
                    page, bp = frame.get('page', 0), baseline.get('page', 0)
                    borrowed = not _ref(source, source_dir, 'spriteAtlasesHd', bp) and fallback is not None
                    if borrowed:
                        source_dir, source = fallback
                        baseline = source['sprites'][key]['frames'][index]
                        bp = baseline.get('page', 0)
                    record.update(baseline_theater=source_dir.name, baseline_fallback=False)
                    if rect[2:] != baseline['rect'][2:] or frame.get('offset') != baseline.get('offset'):
                        raise ValueError('stage-0 frame geometry mismatch')
                    reference_key = (str(source_dir), key, index, ramp_key)
                    if borrowed and reference_key not in self.reference_frames:
                        raise ValueError('verified urban stage-0 frame unavailable')
                    paths = (_ref(data, directory, 'spriteAtlases', page),
                             _ref(data, directory, 'spriteAtlasesHd', page),
                             _ref(data, directory, 'spriteAtlasesHd', page, 'remap'),
                             None if borrowed else _ref(source, source_dir, 'spriteAtlasesHd', bp),
                             None if borrowed else _ref(source, source_dir, 'spriteAtlasesHd', bp, 'remap'),
                             None if borrowed else _ref(source, source_dir, 'spriteAtlases', bp))
                    if not paths[0] or not borrowed and (not paths[3] or not paths[5]):
                        raise ValueError('original/current/stage-0 atlas reference missing')
                    if (paths[1] and data['spriteAtlasesHd'][page].get('scale', 2) != 2) or source['spriteAtlasesHd'][bp].get('scale', 2) != 2:
                        raise ValueError('coverage requires 2x HD pages')
                    pal_name = data.get('palettes', {}).get(sprite.get('palette'))
                    pal_path = str(directory / pal_name) if pal_name else None
                    base_pal = source.get('palettes', {}).get(source['sprites'][key].get('palette'))
                    base_pal_path = str(source_dir / base_pal) if base_pal else None
                    group_key = tuple(_identity(path) for path in paths)
                    cache_key = (group_key, tuple(rect), tuple(baseline['rect']), _identity(pal_path),
                                 _identity(base_pal_path), reference_key)
                    if cache_key in self.metrics_cache:
                        record.update(self.metrics_cache[cache_key])
                        record['baseline_fallback'] = borrowed
                        if cache_key in self.reference_cache:
                            self.reference_frames[reference_key] = self.reference_cache[cache_key]
                    else:
                        groups[group_key].append((paths, record, rect, baseline['rect'], pal_path, base_pal_path,
                                                   cache_key, reference_key, borrowed))
                except (KeyError, IndexError, TypeError, ValueError) as error:
                    record['issue'] = str(error)
        for group_index, jobs in enumerate(groups.values()):
            print(f'{directory.name}: atlas group {group_index + 1}/{len(groups)} '
                  f'({Path(jobs[0][0][1] or jobs[0][0][0]).name})', flush=True)
            with ExitStack() as stack:
                images, error = {}, None
                for path in jobs[0][0]:
                    identity = _identity(path)
                    if path is None or identity in images:
                        continue
                    try:
                        image = stack.enter_context(Image.open(path))
                        image.load()
                        images[identity] = image
                        self.page_loads += 1
                    except (OSError, ValueError) as exc:
                        error = f'图集不可读 {path}: {exc}'
                        break
                for paths, record, rect, base_rect, pal_path, base_pal_path, cache_key, reference_key, borrowed in jobs:
                    if error:
                        original_page = images.get(_identity(paths[0]))
                        if original_page is not None:
                            try:
                                original = self.original(_crop(original_page, rect), pal_path, ramp)
                                record['non_empty'] = bool(np.any(original[..., 3] > 0))
                            except (OSError, ValueError, IndexError):
                                pass
                        record['issue'] = error
                        continue
                    try:
                        originals, hd, paint, base_hd, base_paint, base_original = [images.get(_identity(p)) for p in paths]
                        original_crop = _crop(originals, rect)
                        original = self.original(original_crop, pal_path, ramp)
                        comparison_mask = None
                        record['non_empty'] = bool(np.any(original[..., 3] > 0))
                        if hd is None:
                            raise ValueError('current HD atlas reference missing')
                        if borrowed:
                            reference_original, bas, reference_indices = self.reference_frames[reference_key]
                            if not np.array_equal(original, reference_original):
                                if (original_crop.mode not in ('L', 'P') or not pal_path or reference_indices is None
                                        or not np.array_equal(np.asarray(original_crop), reference_indices)):
                                    raise ValueError('urban baseline original pixels differ; cannot borrow stage-0')
                                # Equal indices prove shared art, but theater palettes may
                                # substitute colours. Exclude those pixels, not their frames.
                                comparison_mask = np.all(original == reference_original, axis=-1)
                            record['baseline_fallback'] = True
                        else:
                            base_original_crop = _crop(base_original, base_rect)
                            reference_original = self.original(base_original_crop, base_pal_path, ramp)
                            reference_indices = (np.asarray(base_original_crop).copy()
                                                 if base_original_crop.mode in ('L', 'P') and base_pal_path else None)
                            bas = downsample(np.asarray(_crop(base_hd, base_rect, 2).convert('RGBA')),
                                             np.asarray(_crop(base_paint, base_rect, 2).convert('L')) if base_paint else None, ramp)
                            # Retain reference crops, not whole decoded HD pages. Float32
                            # bounds memory while preserving sub-palette colour precision.
                            reference = (reference_original, bas.astype(np.float32), reference_indices)
                            self.reference_frames[reference_key] = reference
                            self.reference_cache[cache_key] = reference
                        rgba = np.asarray(_crop(hd, rect, 2).convert('RGBA'))
                        paint_crop = np.asarray(_crop(paint, rect, 2).convert('L')) if paint else None
                        # Atlas packing differs by theater. Crop fingerprints reuse equal art,
                        # after verifying the original, without assuming equal page coordinates.
                        digest = hashlib.sha256(original.tobytes() + rgba.tobytes()
                                                + (paint_crop.tobytes() if paint_crop is not None else b'')).digest()
                        pixel_key = (reference_key, digest)
                        if pixel_key not in self.pixel_metrics:
                            cur = downsample(rgba, paint_crop, ramp)
                            self.pixel_metrics[pixel_key] = frame_metrics(original, cur, bas, comparison_mask)
                        metrics = self.pixel_metrics[pixel_key]
                        self.metrics_cache[cache_key] = metrics
                        record.update(metrics)
                    except (OSError, ValueError, IndexError) as exc:
                        record['issue'] = str(exc)
        return results

def distribution(values):
    values = list(values)
    if not values:
        return {'count': 0}
    quantiles = np.quantile(values, [0, .05, .5, .95, 1])
    return {'count': len(values), **dict(zip(('min', 'p05', 'median', 'p95', 'max'), map(float, quantiles)))}


def calibrate(sprites):
    """Find the first separated redraw cluster below the positive-cohort median.

    Positive labels describe types, not all their frames. A low residual cluster
    can contain retained animations and global polish; do not force those positive.
    """
    cohorts = {}
    for name, keys in (('redrawn_types', REDRAWN), ('not_redrawn', NOT_REDRAWN)):
        cohorts[name] = {key: [f['score'] for f in sprites.get(key, []) if f.get('score') is not None]
                         for key in keys}
    positives = sorted(v for values in cohorts['redrawn_types'].values() for v in values)
    negatives = sorted(v for values in cohorts['not_redrawn'].values() for v in values)
    if not positives or not negatives:
        raise ValueError('Calibration requires a scored redrawn and not-redrawn cohort in urban')
    floor, median = max(negatives), float(np.median(positives))
    candidates = sorted(set([floor] + [v for v in positives if v > floor]))
    gaps = [(math.log1p(b) - math.log1p(a), a, b)
            for a, b in zip(candidates, candidates[1:]) if a < median]
    if not gaps or median <= floor:
        raise ValueError('Calibration cohorts overlap without a usable redraw margin')
    _, low, high = max(gaps)
    gap = high - low
    threshold = (low + high) / 2
    if gap < max(.25, threshold * .10):
        raise ValueError('Calibration has no clear structural-score margin')
    out = {'theater': 'urban', 'metric': 'mean CIE76 Lab(current BOX 1x, stage-0 BOX 1x) on common original/current/stage-0 body',
           'threshold': threshold, 'retained_cluster_max': low, 'redrawn_cluster_min': high,
           'gap': gap, 'margin': gap / 2, 'negative_max': floor,
           'method': 'largest log1p-score gap above negative maximum and below redrawn-type median',
           'warning': 'Type-level positive controls contain retained frames; pixel scores are not model provenance.',
           'cohorts': {}}
    for name, keyed in cohorts.items():
        out['cohorts'][name] = {key: {**distribution(values),
                                    'frames_redrawn': sum(v > threshold for v in values),
                                    'original_lab': distribution(f['original_lab'] for f in sprites.get(key, [])
                                                                 if f.get('original_lab') is not None)}
                                for key, values in keyed.items()}
    return out


def sprite_coverage(frames, threshold, sequences=None):
    rows = [{**frame, 'redrawn': frame.get('score') is not None and frame['score'] > threshold} for frame in frames]
    total = sum(frame.get('non_empty') is True for frame in rows)
    redrawn = sum(frame['redrawn'] for frame in rows)
    issues = sorted({frame['issue'] for frame in rows if frame.get('issue')})
    seqs = {}
    for name, spec in (sequences or {}).items():
        start, count, stride = spec['start'], max(1, spec['count']), spec.get('facingMultiplier', 0)
        indices = sorted({start + direction * max(0, stride) + step
                          for direction in range(8 if stride > 0 else 1) for step in range(count)})
        missing = [i for i in indices if i < 0 or i >= len(rows)]
        members = [rows[i] for i in indices if 0 <= i < len(rows)]
        n, r = sum(f.get('non_empty') is True for f in members), sum(f['redrawn'] for f in members)
        seqs[name] = {'frames_total': n, 'frames_redrawn': r, 'indices': indices, 'missing_indices': missing,
                      'status': status_for(n, r, bool(missing) or any(f.get('issue') for f in members))}
    incomplete = bool(issues) or any(s['missing_indices'] for s in seqs.values())
    return {'status': status_for(total, redrawn, incomplete), 'frames_total': total, 'frames_redrawn': redrawn,
            'frames_unknown': sum(frame.get('non_empty') is None or
                                  frame.get('non_empty') is True and frame.get('score') is None and bool(frame.get('issue'))
                                  for frame in rows),
            'sequences': seqs, 'frames': rows, 'issues': issues,
            'baseline_theaters': sorted({f['baseline_theater'] for f in rows if f.get('baseline_theater')}),
            'baseline_fallback_frames': sum(bool(f.get('baseline_fallback')) for f in rows),
            'baseline_palette_pixels_excluded': sum(f.get('baseline_palette_pixels_excluded', 0) for f in rows)}


def _voxel_status(total: int, redrawn: int) -> str:
    return '已完成' if total > 0 and redrawn == total else '部分' if redrawn else '未完成'


def _voxel_required_parts(theater_dir: Path, library: dict, voxel: str, turret: bool) -> list[str]:
    if voxel.endswith(':turret'):
        return ['turret']
    source = library.get('voxels', {}).get(voxel)
    if isinstance(source, str):
        try:
            model = json.loads((theater_dir / source).read_text())
            roles = {part['role'] for part in model['parts']}
            if roles and roles <= {'body', 'turret', 'barrel'}:
                return [role for role in ('body', 'turret')
                        if role in roles or role == 'turret' and 'barrel' in roles]
        except (OSError, ValueError, KeyError, TypeError):
            pass
    # Rules may declare a turret while a particular form has only a body (SCHP).
    # Original model roles are authoritative; the flag is a fallback for tiny libraries.
    return ['body', 'turret'] if turret else ['body']


def _voxel_part(directory: Path, part: object, count: int, step: int) -> dict:
    result = {'status': '未完成', 'frames_total': count, 'frames_redrawn': 0, 'issues': []}
    issues = result['issues']
    if not isinstance(part, dict):
        issues.append('缺部件')
        return result
    size = part.get('size')
    if not isinstance(size, list) or len(size) != 2 or any(type(n) is not int or n <= 0 for n in size):
        issues.append('图集尺寸无效')
        return result
    for channel in ('colour', 'paint'):
        name = part.get(channel)
        if not isinstance(name, str) or not name or Path(name).is_absolute() or '..' in Path(name).parts:
            issues.append(f'{channel} 图集路径无效')
            continue
        path = directory / name
        try:
            with Image.open(path) as image:
                if list(image.size) != size:
                    issues.append(f'{channel} 图集尺寸不符')
        except FileNotFoundError:
            issues.append(f'缺 {channel} 图集 {name}')
        except (OSError, ValueError):
            issues.append(f'{channel} 图集不可读 {name}')
    if issues:
        return result
    frames = part.get('frames')
    if not isinstance(frames, list):
        issues.append('缺帧列表')
        return result
    seen, bake_frames = set(), set()
    invalid = 0
    for frame in frames:
        if not isinstance(frame, dict):
            invalid += 1
            continue
        facing, key, rect, pivot = (frame.get(k) for k in ('facing', 'k', 'rect', 'pivot'))
        valid = (type(facing) is int and 0 <= facing < 256 and facing % step == 0
                 and facing not in seen and type(key) is int and key >= 0 and key not in bake_frames
                 and isinstance(rect, list) and len(rect) == 4 and all(type(n) is int for n in rect)
                 and isinstance(pivot, list) and len(pivot) == 2
                 and all(isinstance(n, (int, float)) and math.isfinite(n) for n in pivot))
        if valid:
            x, y, width, height = rect
            valid = x >= 0 and y >= 0 and width > 0 and height > 0 and x + width <= size[0] and y + height <= size[1]
        if not valid:
            invalid += 1
            continue
        seen.add(facing)
        bake_frames.add(key)
    result['frames_redrawn'] = len(seen)
    result['status'] = _voxel_status(count, len(seen))
    if len(seen) < count:
        issues.append(f'有效朝向 {len(seen)}/{count}')
    if invalid:
        issues.append(f'无效或重复帧 {invalid}')
        # Complete facings plus corrupt extra entries are still a malformed manifest.
        if result['status'] == '已完成':
            result['status'] = '部分'
    return result


def voxel_coverage(farm: Path, theater_dir: Path, library: dict, voxel: str, turret: bool = False) -> dict:
    """Count actual model parts; a readable partial manifest preserves its valid facing counts."""
    required = _voxel_required_parts(theater_dir, library, voxel, turret)
    manifest = farm / 'vehicles-hd' / f'{voxel.replace(":", "_")}.json'
    result = {'status': '未完成', 'present': manifest.is_file(), 'parts': {}, 'issues': [],
              'frames_total': 0, 'frames_redrawn': 0, 'manifest': str(manifest)}
    count, step, parts = 0, 0, {}
    try:
        text = manifest.read_text()
        result['present'] = True
        data = json.loads(text)
        if not isinstance(data, dict) or data.get('version') != 1 or data.get('type') != voxel:
            raise ValueError('manifest version/type mismatch')
        count, step = data.get('frames'), data.get('facingStep')
        if type(count) is not int or count not in (16, 32) or step != 256 // count:
            raise ValueError('manifest frame count/step invalid')
        parts = data.get('parts')
        if not isinstance(parts, dict):
            raise ValueError('manifest parts invalid')
    except FileNotFoundError:
        result['issues'].append(f'缺清单 {voxel}')
    except (OSError, UnicodeError, ValueError) as error:
        result['issues'].append(f'清单损坏或不可读 {voxel}: {error}')
        count, step, parts = 0, 0, {}
    for role in required:
        part = (_voxel_part(manifest.parent, parts.get(role), count, step) if count
                else {'status': '未完成', 'frames_total': 0, 'frames_redrawn': 0, 'issues': ['缺可用清单']})
        result['parts'][role] = part
        result['frames_total'] += part['frames_total']
        result['frames_redrawn'] += part['frames_redrawn']
        result['issues'].extend(f'{role}: {issue}' for issue in part['issues'])
    statuses = [part['status'] for part in result['parts'].values()]
    result['status'] = ('已完成' if statuses and all(status == '已完成' for status in statuses)
                        else '部分' if any(status != '未完成' for status in statuses) else '未完成')
    return result


def _sprite_keys(data):
    keys = set(REDRAWN + NOT_REDRAWN)
    for spec in data['types'].values():
        if spec.get('kind') in KINDS:
            keys.update(spec[k] for k in ('sprite', 'deployingAnim') if spec.get(k))
    return keys & data.get('sprites', {}).keys()


def _type_coverage(farm, directory, library, code, spec, sprites, threshold):
    if spec.get('voxel'):
        result = voxel_coverage(farm, directory, library, spec['voxel'], spec.get('turret', False))
        result['sequences'] = {}
    elif spec.get('sprite'):
        result = sprite_coverage(sprites.get(spec['sprite'], [
            {'non_empty': None, 'score': None, 'issue': f"缺 sprite {spec['sprite']}"}]),
            threshold, spec.get('infantry', {}).get('sequences'))
    else:
        result = {'status': '未完成', 'frames_total': 0, 'frames_redrawn': 0, 'issues': ['无 sprite/voxel 引用']}
    components = {}
    if spec.get('unloadingVoxel'):
        voxel = spec['unloadingVoxel']
        components['unloadingVoxel'] = voxel_coverage(farm, directory, library, voxel, spec.get('turret', False))
        components['unloadingVoxel']['voxel'] = voxel
        if components['unloadingVoxel']['status'] != '已完成':
            result['issues'].append(f'缺部署形态 {voxel}' if spec.get('deployingAnim') else f'缺卸载形态 {voxel}')
    if spec.get('deployingAnim'):
        key = spec['deployingAnim']
        components['deployingAnim'] = sprite_coverage(sprites.get(key, [
            {'non_empty': None, 'score': None, 'issue': f'缺 sprite {key}'}]), threshold)
        components['deployingAnim']['sprite'] = key
        if components['deployingAnim']['status'] != '已完成':
            result['issues'].append(f'部署动画 {key} 重绘帧 {components["deployingAnim"]["frames_redrawn"]}/'
                                    f'{components["deployingAnim"]["frames_total"]}')
    # An absent primary shape must remain absent even when its reciprocal form exists.
    if result['status'] != '未完成' and components:
        result['status'] = combine_status([result['status']] + [c['status'] for c in components.values()])
    if components:
        result['components'] = components
    return result


def _notes(row):
    groups = defaultdict(list)
    for theater, info in row['theaters'].items():
        if row.get('sprite'):
            detail = f"重绘帧 {info['frames_redrawn']}/{info['frames_total']}"
            if info.get('frames_unknown'):
                detail += f"；未知帧 {info['frames_unknown']}"
        else:
            parts = info.get('parts', {})
            detail = '部件 ' + '、'.join(f'{p} {v["frames_redrawn"]}/{v["frames_total"]}' for p, v in parts.items())
        problems = info.get('issues', [])
        if problems:
            detail += '；' + '；'.join(problems)
        # A sequence gap is not an asset read failure and deserves a separate diagnosis.
        gaps = [name for name, seq in info.get('sequences', {}).items() if seq['missing_indices']]
        if gaps:
            detail += '；序列引用越界 ' + '/'.join(gaps)
        groups[detail].append(THEATER_NAMES.get(theater, theater))
    notes = '；'.join(f'{detail}；{"/".join(names)}' + (' 一致' if len(names) > 1 else '')
                     for detail, names in groups.items())
    if any(info.get('baseline_fallback_frames') for info in row['theaters'].values()):
        notes += '；非城市地形验证原图后借用城市基线'
    excluded = sum(info.get('baseline_palette_pixels_excluded', 0) for info in row['theaters'].values())
    if excluded:
        notes += f'；排除调色板差异像素 {excluded}'
    return notes + ('；' + row['note'] if row.get('note') else '')


def scan(farm: Path, base: Path, theaters=None, meta=None):
    """Return numeric coverage; neither source tree is written or modified."""
    started = time.monotonic()
    _identity.cache_clear()
    _content_identity.cache_clear()
    farm, base = Path(farm), Path(base)
    theaters = list(dict.fromkeys(theaters or THEATERS))
    if any(theater not in THEATER_NAMES for theater in theaters):
        raise ValueError('Unknown theater')
    meta = meta or {}
    loaded = {}
    # Urban is always the calibration reference, including for a selected other theater.
    for theater in dict.fromkeys(['urban'] + theaters):
        directory, base_dir = farm / '_library' / theater, base / '_library' / theater
        loaded[theater] = (directory, read_json(directory / 'library.json'),
                           base_dir, read_json(base_dir / 'library.json'))
    scanner = SpriteScanner()
    d, lib, b, blib = loaded['urban']
    urban = scanner.scan(d, lib, b, blib, _sprite_keys(lib))
    calibration = calibrate(urban)
    threshold = calibration['threshold']
    scored, rows_by_code = {}, {}
    for theater in theaters:
        directory, library, base_dir, baseline = loaded[theater]
        scored[theater] = urban if theater == 'urban' else scanner.scan(
            directory, library, base_dir, baseline, _sprite_keys(library), fallback=(b, blib))
        for code, spec in library['types'].items():
            if spec.get('kind') not in KINDS:
                continue
            rows_by_code.setdefault(code, {'code': code, 'kind': spec['kind'], 'image': spec.get('image', ''),
                                            **{k: spec[k] for k in ('sprite', 'voxel') if k in spec},
                                            'theaters': {}})
            rows_by_code[code]['theaters'][theater] = _type_coverage(
                farm, directory, library, code, spec, scored[theater], threshold)
        # Include an alternate form even if a custom rules library has no independent type for it.
        for owner, spec in library['types'].items():
            voxel = spec.get('unloadingVoxel')
            if not voxel or any(t.get('voxel') == voxel for t in library['types'].values()):
                continue
            row = rows_by_code.setdefault(voxel, {'code': voxel, 'kind': spec['kind'], 'image': voxel,
                                                  'voxel': voxel, 'parent_type': owner, 'theaters': {}})
            row['theaters'][theater] = voxel_coverage(farm, directory, library, voxel, spec.get('turret', False))
        turrets = [v for v in library.get('voxels', {}) if v.endswith(':turret')]
        order = {code: i for i, code in enumerate(library['types'])}
        turrets.sort(key=lambda key: order.get(key.removesuffix(':turret'), len(order)))
        for voxel in turrets:
            row = rows_by_code.setdefault(voxel, {'code': voxel, 'kind': 'building-turret', 'image': voxel,
                                                  'voxel': voxel, 'theaters': {}})
            row['theaters'][theater] = voxel_coverage(farm, directory, library, voxel)
        print(f'{theater}: scanned {len(scored[theater])} sprites', flush=True)
    rows = sorted(rows_by_code.values(), key=lambda row: KINDS.index(row['kind']))
    for row in rows:
        for theater in theaters:
            row['theaters'].setdefault(theater, {'status': '未完成', 'frames_total': 0, 'frames_redrawn': 0,
                                                'issues': ['此地形缺规则类型']})
        row['status'] = combine_status([info['status'] for info in row['theaters'].values()])
        annotation = meta.get(row['code'], {})
        for field in ('side', 'name', 'note'):
            row[field] = str(annotation.get(field, ''))
        row['description'] = _notes(row)
    summary = {status: sum(row['status'] == status for row in rows) for status in ('已完成', '部分', '未完成')}
    return {'version': 1, 'farm': str(farm), 'base': str(base), 'theaters': theaters,
            'scope': 'infantry, vehicles, aircraft, building turret voxels; ordinary building bodies excluded',
            'excluded_buildings': {t: [code for code, spec in loaded[t][1]['types'].items()
                                       if spec.get('kind') == 'building'] for t in theaters},
            'catalog_counts': {t: dict(Counter(spec['kind'] for spec in loaded[t][1]['types'].values())) for t in theaters},
            'calibration': calibration, 'summary': summary, 'rows': rows,
            'by_kind': {kind: dict(Counter(row['status'] for row in rows if row['kind'] == kind)) for kind in KINDS},
            'elapsed_seconds': time.monotonic() - started, 'page_loads': scanner.page_loads}


def _escape(value):
    return str(value).replace('\\', '\\\\').replace('|', '\\|').replace('\r', '').replace('\n', '<br>')


def markdown(report):
    calibration = report['calibration']
    lines = ['# 单位 HD 重绘覆盖率', '', '范围：步兵、车辆、飞机、建筑炮塔；普通建筑本体代码另记于 JSON 的 excluded_buildings。', '',
             f"校准：stage-0 基线结构色差阈值 **{calibration['threshold']:.6f}**；"
             f"保留/抛光簇上限 {calibration['retained_cluster_max']:.6f}，重绘簇下限 {calibration['redrawn_cluster_min']:.6f}，"
             f"间隔 {calibration['gap']:.6f}。", '',
             '分数为身体像素上的 CIE-Lab 平均色差：原图及 HD 排除透明/近黑阴影，HD 解码阵营色后用 BOX 缩回 1x。'
             '同时记录原图色差；以当前 HD 与 stage-0 的差值排除基础放大误差。结构分数是启发式证据，不能证明生成来源。', '',
             '已知重绘的是类型，不代表其中每个动画帧都重绘；缺文件和无法评分的帧不会被算作完成。', '',
             '校准样本 | 帧数 | 最小 | P05 | 中位 | P95 | 最大 | 判为重绘',
             '--- | ---: | ---: | ---: | ---: | ---: | ---: | ---:']
    for cohort, sets in calibration['cohorts'].items():
        for key, stats in sets.items():
            if not stats['count']:
                lines.append(f'{key} ({cohort}) | 0 | — | — | — | — | — | 0')
            else:
                values = ' | '.join(f'{stats[n]:.4f}' for n in ('min', 'p05', 'median', 'p95', 'max'))
                lines.append(f'{key} ({cohort}) | {stats["count"]} | {values} | {stats["frames_redrawn"]}')
    lines += ['', '；'.join(f'{key} {value}' for key, value in report['summary'].items()), '',
              '| 类别 | 阵营 | 代码 | 图像 | 名称 | 状态 | 说明 |', '| --- | --- | --- | --- | --- | --- | --- |']
    for row in report['rows']:
        values = [KIND_NAMES[row['kind']], row['side'] or '—', row['code'], row['image'],
                  row['name'] or '—', row['status'], row['description']]
        lines.append('| ' + ' | '.join(_escape(value) for value in values) + ' |')
    lines += ['', '每地形逐帧分数、逐序列计数、缺失帧索引和 voxel 部件诊断见配套 JSON。', '']
    return '\n'.join(lines)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    command = commands.add_parser('scan', help='Scan read-only art caches and write JSON/Chinese Markdown reports')
    command.add_argument('--farm', required=True, type=Path)
    command.add_argument('--base', required=True, type=Path)
    command.add_argument('--theaters', nargs='+', choices=THEATERS)
    command.add_argument('--meta', type=Path)
    command.add_argument('--json', required=True, type=Path)
    command.add_argument('--md', required=True, type=Path)
    options = parser.parse_args(argv)
    for path in (options.json, options.md):
        if any(path.absolute().is_relative_to(root.absolute()) or path.resolve().is_relative_to(root.resolve())
               for root in (options.farm, options.base)):
            parser.error('Reports must be outside the read-only farm/base directories')
    if options.json.resolve() == options.md.resolve():
        parser.error('JSON and Markdown outputs must be different files')
    report = scan(options.farm, options.base, options.theaters, read_json(options.meta) if options.meta else None)
    for path, content in ((options.json, json.dumps(report, ensure_ascii=False, indent=2, allow_nan=False) + '\n'),
                          (options.md, markdown(report))):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding='utf-8')
    calibration = report['calibration']
    print(f"Calibration threshold={calibration['threshold']:.6f}, retained max={calibration['retained_cluster_max']:.6f}, "
          f"redrawn min={calibration['redrawn_cluster_min']:.6f}, margin={calibration['margin']:.6f}")
    for cohort, sets in calibration['cohorts'].items():
        for key, stats in sets.items():
            print(f'{cohort} {key}: {json.dumps(stats, ensure_ascii=False)}')
    print('Summary: ' + ', '.join(f'{key} {count}' for key, count in report['summary'].items()))
    print(f"Elapsed {report['elapsed_seconds']:.1f}s; page loads {report['page_loads']}; {options.json}; {options.md}")
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
