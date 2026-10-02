#!/usr/bin/env python3
"""Upscale original desert ore/gems into an existing L5 growth-frame layout.

Real-ESRGAN sees one RGB sheet with individually edge-extended, padded frames.
Coverage comes only from the original indexed mask, not model-generated pixels.
All art stays outside Git; installation replaces farm entries under composition
and JSON locks. No native frame geometry or indexed atlas is published by install.
"""

from __future__ import annotations

import argparse
import copy
import fcntl
import hashlib
import io
import json
import math
import os
from pathlib import Path
import shlex
import subprocess

import cv2
import numpy as np
from PIL import Image, ImageDraw

import cache_farm
import ore_fields as ore

HD = 'sprites-ore-l5@2x-l5hdes.png'
REMAP = 'sprites-ore-l5@2x-l5hdes-remap.png'
NORMALS = 'sprites-ore-l5@2x-l5hdes-normals.png'
FILES = (HD, REMAP, NORMALS)
MARGIN = 24


class OriginalLibrary(ore.OverlayLibrary):
    """Use the extractor's theatre directory directly, with its indexed palettes."""

    def __init__(self, directory: Path):
        self.directory = Path(directory)
        self.library = ore.read_json(self.directory / 'library.json')
        self.pages, self.palettes = {}, {}


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def validate_layout(meta: dict) -> None:
    if not meta['frames'] or set(meta['frames']) - set(ore.FAMILIES):
        raise ValueError('layout must contain only ore/gem families')
    if any(type(v) is not int for v in [*meta['size'], *meta['offset'], meta['width'], meta['height']]):
        raise ValueError('layout geometry must contain integers')
    if len(meta['size']) != 2 or len(meta['offset']) != 2 or min(*meta['size'], meta['width'], meta['height']) <= 0:
        raise ValueError('invalid layout dimensions')
    occupied = np.zeros((meta['height'], meta['width']), bool)
    for rects in meta['frames'].values():
        if len(rects) != ore.FRAMES:
            raise ValueError('each family needs all 12 growth frames')
        for rect in rects:
            if len(rect) != 4 or any(type(v) is not int for v in rect):
                raise ValueError('invalid frame rectangle')
            x, y, w, h = rect
            if [w, h] != meta['size'] or min(x, y) < 0 or x + w > meta['width'] or y + h > meta['height']:
                raise ValueError('frame rectangle is outside the layout or has a different size')
            region = occupied[y:y + h, x:x + w]
            if region.any():
                raise ValueError('layout frame rectangles overlap')
            region[:] = True


def original_frame(lib: OriginalLibrary, family: str, stage: int) -> tuple[np.ndarray, dict]:
    indexed, info = lib.frame_indexed(family, stage)
    _, sprite, overlay = lib.frame_info(family, stage)
    # Non-remappable overlays can legitimately use palette entries 16..31;
    # the extractor's policy, not the numeric index, decides house paint.
    if overlay.get('remap'):
        raise ValueError(f'{family}: house-colour ore is unsupported')
    palette = lib.palette(overlay.get('palette', sprite.get('palette', 'theater')))
    return np.dstack([palette[indexed], (indexed != 0).astype(np.uint8) * 255]), info


def extend_rgb(rgb: np.ndarray, mask: np.ndarray) -> np.ndarray:
    """Nearest foreground colour everywhere, including holes and frame margins."""
    if not mask.any():
        return np.zeros_like(rgb)
    _, labels = cv2.distanceTransformWithLabels((~mask).astype(np.uint8), cv2.DIST_L2, 5,
                                               labelType=cv2.DIST_LABEL_PIXEL)
    colours = np.zeros((int(labels.max()) + 1, 3), rgb.dtype)
    colours[labels[mask]] = rgb[mask]
    return colours[labels]


def lab_stats(rgb: np.ndarray, alpha: np.ndarray) -> dict:
    lab = cv2.cvtColor(np.clip(rgb, 0, 1).astype(np.float32), cv2.COLOR_RGB2LAB)
    weight = alpha.astype(np.float64)
    total = float(weight.sum())
    if not total:
        return {'L': None, 'C': None, 'hue': None}
    mean = (lab * weight[..., None]).sum(axis=(0, 1)) / total
    chroma = np.hypot(lab[..., 1], lab[..., 2])
    # Hue is the chroma-weighted circular mean; neutral glints do not set its direction.
    hue = math.degrees(math.atan2(float(mean[2]), float(mean[1]))) % 360
    return {'L': float(mean[0]), 'C': float((chroma * weight).sum() / total), 'hue': hue}


def match_tone(rgb: np.ndarray, alpha: np.ndarray, source: np.ndarray) -> np.ndarray:
    """Undo model mean-colour drift in Lab; no target gold ramp or saturation grade."""
    if not source[..., 3].any():
        return rgb
    before = cv2.cvtColor(source[..., :3].astype(np.float32) / 255, cv2.COLOR_RGB2LAB)
    lab = cv2.cvtColor(np.clip(rgb, 0, 1).astype(np.float32), cv2.COLOR_RGB2LAB)
    mask = source[..., 3] > 0
    goal = before[mask].mean(axis=0)
    for _ in range(2):
        mean = (lab * alpha[..., None]).sum(axis=(0, 1)) / alpha.sum()
        lab += goal - mean
        rgb = cv2.cvtColor(lab, cv2.COLOR_LAB2RGB).clip(0, 1)
        lab = cv2.cvtColor(rgb, cv2.COLOR_RGB2LAB)
    return rgb


def round_alpha(alpha4: np.ndarray) -> np.ndarray:
    """Round a linearly upscaled 1-bit mask into smooth pebble outlines (4x pixels).

    A blur of about half a 1x pixel removes the staircase, and the smoothstep restores a firm, anti-aliased edge near
    the original outline, so single-pixel grains stay (slightly smaller) round dots instead of vanishing or blurring.
    """
    soft = cv2.GaussianBlur(alpha4, (0, 0), 1.6)
    t = np.clip((soft - 0.22) / (0.62 - 0.22), 0, 1)
    return t * t * (3 - 2 * t)


def unify_grain_hue(rgb: np.ndarray, sigma: float = 1.2) -> np.ndarray:
    """Ore only: blur the Lab chroma (not lightness) of a 1x frame, so each pebble keeps its shading but loses the SHP's
    pink/green dither speckles and reads as one warm mineral tone. Gems are excluded (neighbouring stones differ)."""
    lab = cv2.cvtColor(rgb.astype(np.float32) / 255, cv2.COLOR_RGB2LAB)
    lab[..., 1:] = cv2.GaussianBlur(lab[..., 1:], (0, 0), sigma)
    out = cv2.cvtColor(lab, cv2.COLOR_LAB2RGB)
    return (np.clip(out, 0, 1) * 255 + 0.5).astype(np.uint8)


def smooth_upscale(sheet: np.ndarray) -> np.ndarray:
    """4x RGB upscale without a model: the earlier static (L4) look of the original art drawn with smooth filtering.

    A light 1x blur merges the SHP's single-pixel dither speckles (the pink/green fringes a model sharpens into noise)
    into each pebble's own tone before a bicubic 4x resize.
    """
    h, w = sheet.shape[:2]
    rgb = cv2.GaussianBlur(sheet.astype(np.float32) / 255, (0, 0), 0.55)
    up = cv2.resize(rgb, (w * 4, h * 4), interpolation=cv2.INTER_CUBIC)
    return (np.clip(up, 0, 1) * 255 + 0.5).astype(np.uint8)


def reduce_frame(rgb4: np.ndarray, source: np.ndarray, tone: str, *, rounded: bool = False) -> tuple[np.ndarray, np.ndarray]:
    """Smooth the original 1-bit alpha, then area-reduce premultiplied colour."""
    h, w = source.shape[:2]
    alpha4 = cv2.resize(source[..., 3].astype(np.float32) / 255, (w * 4, h * 4),
                        interpolation=cv2.INTER_LINEAR)
    if rounded:
        alpha4 = round_alpha(alpha4)
    prem = cv2.resize(np.dstack([rgb4 * alpha4[..., None], alpha4]), (w * 2, h * 2),
                      interpolation=cv2.INTER_AREA)
    alpha = prem[..., 3]
    rgb = prem[..., :3] / np.maximum(alpha[..., None], 1e-6)
    if tone == 'original':
        rgb = match_tone(rgb, alpha, source)
    rgb = extend_rgb(rgb, alpha > 0)
    rgba = np.dstack([rgb, alpha])
    return rgba, material(rgb4, alpha4)


def material(rgb4: np.ndarray, alpha4: np.ndarray) -> np.ndarray:
    """Original-grain relief using ore_fields' world basis and material encoding."""
    source = {'rgba': np.dstack([rgb4, alpha4])}
    height, _ = ore.height_and_classes(source, 'gem')
    # Relief is measured in 1x pixels; changing density must not enlarge the pebbles.
    height *= 2.0
    gy, gx = np.gradient(cv2.GaussianBlur(height, (0, 0), 0.8))
    core = cv2.erode(alpha4, np.ones((5, 5), np.uint8))
    tilt = 1.1 * np.clip(cv2.GaussianBlur(core, (0, 0), 1.5) * 1.4, 0, 1)
    normal = ore.UP - tilt[..., None] * (gx[..., None] * ore.SCREEN_RIGHT + gy[..., None] * ore.SCREEN_DOWN_GROUND)
    normal /= np.linalg.norm(normal, axis=-1, keepdims=True)
    size = (rgb4.shape[1] // 2, rgb4.shape[0] // 2)
    alpha = cv2.resize(alpha4, size, interpolation=cv2.INTER_AREA)
    normal = cv2.resize(normal * alpha4[..., None], size, interpolation=cv2.INTER_AREA)
    normal /= np.maximum(np.linalg.norm(normal, axis=-1, keepdims=True), 1e-6)
    normal = np.where(alpha[..., None] > 0, normal, ore.UP)
    cavity = np.clip((cv2.GaussianBlur(height, (0, 0), 2) - height) / (0.6 * 4), 0, 1)
    ao = cv2.resize((1 - 0.45 * cavity) * alpha4, size, interpolation=cv2.INTER_AREA)
    ao /= np.maximum(alpha, 1e-6)
    # Original desert grains and gems are non-metal minerals; preserve their baked
    # colour and use the same dielectric crystal gloss (.47) as L5 gems.
    return np.dstack([normal[..., 0] * 0.5 + 0.5, normal[..., 2] * 0.5 + 0.5,
                      np.full(alpha.shape, 0.47), np.where(alpha > 0, 0.3 + 0.7 * ao, 0)])


def write_png(path: Path, pixels: np.ndarray) -> None:
    buffer = io.BytesIO()
    Image.fromarray(pixels).save(buffer, format='PNG')
    ore.write_atomic(path, buffer.getvalue())


def prepare_output(out: Path, inputs: tuple[Path, ...]) -> None:
    absolute = out.absolute()
    if any(p.is_symlink() for p in (absolute, *absolute.parents)):
        raise ValueError('output directory must not pass through a symlink')
    if any(absolute.is_relative_to(p.resolve()) for p in inputs):
        raise ValueError('output must be outside the read-only inputs')
    if 'hd-cache-l5g' in absolute.parts:
        raise ValueError('the L5G cache is read-only')
    out.mkdir(parents=True, exist_ok=True)


def build(extracted: Path, theatre: str, layout: Path, esrgan: Path | None, out: Path, *,
          tone: str = 'original', esrgan_cmd: str | None = None, upscaler: str = 'esrgan') -> dict:
    if theatre != 'desert' or tone not in ('original', 'model'):
        raise ValueError('only desert and original/model tone are supported')
    meta = ore.read_json(layout / 'frames.json')
    validate_layout(meta)
    native_mask = ore.read_image(layout / ore.PAGE, 'L') > 0
    for name, mode, scale in ((ore.PAGE, 'L', 1), (ore.REMAP, 'L', 2)):
        pixels = ore.read_image(layout / name, mode)
        if pixels.shape != (meta['height'] * scale, meta['width'] * scale):
            raise ValueError(f'{name}: layout page size differs')
        if name == ore.REMAP and pixels.any():
            raise ValueError('layout ore remap must be empty')
    prepare_output(out, (extracted, layout))
    lib = OriginalLibrary(extracted)
    records = []
    for family, rects in meta['frames'].items():
        for stage, rect in enumerate(rects):
            rgba, info = original_frame(lib, family, stage)
            dx, dy = np.subtract(info['offset'], meta['offset']).tolist()
            # Include transparent pixels outside the extractor's tight crop, so
            # its outer boundary receives the same antialiasing as interior holes.
            rgba = np.pad(rgba, ((1, 1), (1, 1), (0, 0)))
            dx, dy = dx - 1, dy - 1
            h, w = rgba.shape[:2]
            if min(dx, dy) < 0 or dx + w > rect[2] or dy + h > rect[3]:
                raise ValueError(f'{family}#{stage}: original frame does not fit layout')
            records.append((family, stage, rect, rgba, dx, dy))
    cw = max(r[3].shape[1] for r in records) + 2 * MARGIN
    ch = max(r[3].shape[0] for r in records) + 2 * MARGIN
    cols = min(16, math.ceil(math.sqrt(len(records))))
    rows = math.ceil(len(records) / cols)
    sheet = np.zeros((rows * ch, cols * cw, 3), np.uint8)
    for i, (family, _, _, rgba, _, _) in enumerate(records):
        rgb = extend_rgb(rgba[..., :3], rgba[..., 3] > 0)
        if upscaler == 'smooth' and family.startswith('TIB'):
            rgb = unify_grain_hue(rgb)
        padded = np.pad(rgb, ((MARGIN, ch - rgb.shape[0] - MARGIN),
                              (MARGIN, cw - rgb.shape[1] - MARGIN), (0, 0)), mode='edge')
        x, y = (i % cols) * cw, (i // cols) * ch
        sheet[y:y + ch, x:x + cw] = padded
    input_png, output_png = out / 'esrgan-input.png', out / 'esrgan-output@4x.png'
    write_png(input_png, sheet)
    if upscaler == 'smooth':
        command = ['smooth']
    elif esrgan_cmd:
        command = shlex.split(esrgan_cmd)
    elif esrgan:
        command = [str(esrgan / 'realesrgan-ncnn-vulkan'), '-n', 'realesrgan-x4plus', '-s', '4',
                   '-m', str(esrgan / 'models'), '-t', '128']
    else:
        raise ValueError('--esrgan or --esrgan-cmd is required')
    # The override is an argv prefix, never a shell; tests provide an asset-free fake.
    output_png.unlink(missing_ok=True)
    print(f'Upscaling {len(records)} frames in one {sheet.shape[1]}x{sheet.shape[0]} padded sheet ({upscaler})', flush=True)
    if upscaler == 'smooth':
        write_png(output_png, smooth_upscale(sheet))
    else:
        with (out / 'esrgan.log').open('w') as log:
            subprocess.run(command + ['-i', str(input_png), '-o', str(output_png)], stdout=log, stderr=log, check=True)
    upscaled = ore.read_image(output_png, 'RGB')
    if upscaled.shape != (sheet.shape[0] * 4, sheet.shape[1] * 4, 3):
        raise ValueError('upscaler did not return an exact 4x RGB sheet')
    page = np.zeros((meta['height'] * 2, meta['width'] * 2, 4), np.uint8)
    normals = np.zeros_like(page)
    families, original_samples, new_samples = {}, {}, {}
    for i, (family, stage, rect, rgba, dx, dy) in enumerate(records):
        x4, y4 = ((i % cols) * cw + MARGIN) * 4, ((i // cols) * ch + MARGIN) * 4
        h, w = rgba.shape[:2]
        rgb4 = upscaled[y4:y4 + h * 4, x4:x4 + w * 4].astype(np.float32) / 255
        colour, mat = reduce_frame(rgb4, rgba, tone, rounded=upscaler == 'smooth')
        x, y = (rect[0] + dx) * 2, (rect[1] + dy) * 2
        colour8 = (np.clip(colour, 0, 1) * 255 + 0.5).astype(np.uint8)
        mat8 = (np.clip(mat, 0, 1) * 255 + 0.5).astype(np.uint8)
        page[y:y + h * 2, x:x + w * 2] = colour8
        normals[y:y + h * 2, x:x + w * 2] = mat8
        # Bleed colour throughout the layout rect, while leaving its alpha intact.
        rx, ry, rw, rh = [v * 2 for v in rect]
        crop = page[ry:ry + rh, rx:rx + rw]
        crop[..., :3] = extend_rgb(crop[..., :3], crop[..., 3] > 0)
        nx, ny, nw, nh = rect
        gate = np.repeat(np.repeat(native_mask[ny:ny + nh, nx:nx + nw], 2, 0), 2, 1)
        clipped = crop[..., 3][~gate]
        original_samples.setdefault(family, []).append(rgba.reshape(-1, 4))
        new_samples.setdefault(family, []).append(colour8.reshape(-1, 4))
        families.setdefault(family, {'coverage': []})['coverage'].append({
            'stage': stage, 'original_pixels': int((rgba[..., 3] > 0).sum()),
            'new_area_1x': float(colour8[..., 3].sum() / (255 * 4)),
            'new_fraction': float(colour8[..., 3].sum() / (255 * 4 * rect[2] * rect[3])),
            'original_fraction': float((rgba[..., 3] > 0).sum() / (rect[2] * rect[3])),
            'native_gate_clipped_hd_pixels': int((clipped > 0).sum()),
            'native_gate_clipped_area_1x': float(clipped.sum() / (255 * 4)),
            'soft_edge_pixels': int(((colour8[..., 3] > 0) & (colour8[..., 3] < 255)).sum()),
        })
    for family, metric in families.items():
        for name, samples in (('original', original_samples), ('new', new_samples)):
            pixels = np.concatenate(samples[family])[None]
            metric[name] = lab_stats(pixels[..., :3].astype(np.float32) / 255, pixels[..., 3] / 255)
    write_png(out / HD, page)
    write_png(out / NORMALS, normals)
    # Preserve the exact mask and rectangles as review artifacts, never publish them.
    for source, target in ((layout / ore.REMAP, out / REMAP), (layout / ore.PAGE, out / ore.PAGE),
                           (layout / 'frames.json', out / 'frames.json')):
        ore.write_atomic(target, source.read_bytes())
    metrics = {'version': 1, 'theatre': theatre, 'tone': tone, 'upscaler_mode': upscaler, 'frames': len(records),
               'margin_1x': MARGIN,
               'upscaler': {'argv': command, 'override': bool(esrgan_cmd)},
               'files': list(FILES), 'indexed_sha256': digest(out / ore.PAGE),
               'layout_sha256': digest(out / 'frames.json'), 'families': families}
    coverage = [frame for family in families.values() for frame in family['coverage']]
    clipped_area = sum(frame['native_gate_clipped_area_1x'] for frame in coverage)
    metrics['native_gate'] = {
        'clipped_hd_pixels': sum(frame['native_gate_clipped_hd_pixels'] for frame in coverage),
        'clipped_area_1x': clipped_area,
        'clipped_fraction': clipped_area / max(sum(frame['new_area_1x'] for frame in coverage), 1e-6),
    }
    ore.write_atomic(out / 'metrics.json', json.dumps(metrics, indent=2).encode())
    print(f'Built {HD}: {page.shape[1]}x{page.shape[0]}, {len(records)} live stages', flush=True)
    return metrics


def find_page(library: dict, meta: dict) -> int:
    matches = [i for i, entry in enumerate(library.get('spriteAtlasesHd', []))
               if entry and entry.get('file') in (ore.HD, HD)]
    if len(matches) != 1:
        raise ValueError('expected exactly one existing L5 ore HD page')
    page = matches[0]
    native = library['spriteAtlases'][page]
    hd = library['spriteAtlasesHd'][page]
    if (native.get('file') != ore.PAGE or native.get('width') != meta['width'] or
            native.get('height') != meta['height'] or hd.get('scale') != 2 or
            hd.get('width') != meta['width'] * 2 or hd.get('height') != meta['height'] * 2):
        raise ValueError('destination is not a matching ore page')
    seen = set()
    for key, sprite in library['sprites'].items():
        for stage, frame in enumerate(sprite['frames']):
            if frame.get('page', 0) != page:
                continue
            name = key.removeprefix('overlay:')
            family = ore.ALIASES.get(name, name)
            if not key.startswith('overlay:') or family not in meta['frames']:
                raise ValueError('destination page is used by a non-ore sprite')
            if (stage >= ore.FRAMES or frame['rect'] != meta['frames'][family][stage] or
                    frame['offset'] != meta['offset']):
                raise ValueError('destination ore frame geometry differs from build')
            seen.add((family, stage))
    if seen != {(family, stage) for family in meta['frames'] for stage in range(ore.FRAMES)}:
        raise ValueError('destination does not contain all built ore growth stages')
    return page


def install(cache_root: Path, theatre: str, build_dir: Path) -> int:
    if theatre != 'desert' or 'hd-cache-l5g' in cache_root.absolute().parts:
        raise ValueError('install only targets desert outside the read-only L5G cache')
    meta = ore.read_json(build_dir / 'frames.json')
    validate_layout(meta)
    metrics = ore.read_json(build_dir / 'metrics.json')
    if (metrics.get('theatre') != theatre or metrics.get('files') != list(FILES) or
            metrics.get('layout_sha256') != digest(build_dir / 'frames.json')):
        raise ValueError('build metadata does not match the desert upscale output')
    size = (meta['width'] * 2, meta['height'] * 2)
    for name in FILES:
        with Image.open(build_dir / name) as image:
            if image.size != size or image.mode != ('L' if name == REMAP else 'RGBA'):
                raise ValueError(f'{name}: invalid page size or encoding')
    if ore.read_image(build_dir / REMAP).any():
        raise ValueError('ore remap must be empty')
    relative = Path('_library') / theatre
    lock_path = cache_farm._destination(cache_root, str(relative / '.compose.lock'))
    directory = cache_root / relative
    # Opening an inherited lock read-only retains its shared inode without writing
    # through its symlink. cache_farm realises directory symlinks before this point.
    with os.fdopen(os.open(lock_path, os.O_RDONLY | os.O_CREAT, 0o600), 'r') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        try:
            current = ore.read_json(directory / 'library.json')
            page = find_page(current, meta)
            if digest(directory / ore.PAGE) != metrics['indexed_sha256']:
                raise ValueError('destination native ore mask differs from layout')
            entry = copy.deepcopy(current['spriteAtlasesHd'][page])
            for name in FILES:
                cache_farm.install_file(cache_root, str(relative / name), build_dir / name)

            def patch(library):
                if find_page(library, meta) != page or library['spriteAtlasesHd'][page] != entry:
                    raise ValueError('ore page changed during installation')
                library['spriteAtlasesHd'][page].update(file=HD, remap=REMAP)

            cache_farm.patch_json(cache_root, str(relative / 'library.json'), patch)

            def patch_normals(normals):
                material_page = normals.setdefault('pages', {}).setdefault(str(page), {})
                material_page.update(file=NORMALS, atlas=HD, width=size[0], height=size[1], scale=2,
                                     materialWidth=size[0], materialHeight=size[1], frames=metrics['frames'])

            cache_farm.patch_json(cache_root, str(relative / 'normals.json'), patch_normals,
                                  default={'version': 1, 'pages': {}})
        finally:
            fcntl.flock(lock, fcntl.LOCK_UN)
    print(f'Installed desert ore page {page}: {HD}; normals atlas matches', flush=True)
    return page


def preview(extracted: Path, layout: Path, build_dir: Path, out: Path) -> None:
    lib = OriginalLibrary(extracted)
    meta = ore.read_json(layout / 'frames.json')
    old, new = ore.read_image(layout / ore.HD, 'RGBA'), ore.read_image(build_dir / HD, 'RGBA')
    w, h = meta['size']
    cellw, cellh = w * 4, h * 4
    margin, header, label = 16, 36, 65
    sheet = Image.new('RGB', (label + margin + cellw * 3, header + 5 * (cellh + margin)), '#b49a6e')
    draw = ImageDraw.Draw(sheet)
    for col, title in enumerate(('Original 1x / nearest 4x', 'L5 2x / nearest 2x', 'Original-grain 2x / nearest 2x')):
        draw.text((label + margin + col * cellw, 12), title, fill='#30271a')
    for row, family in enumerate(('TIB01', 'TIB05', 'TIB12', 'TIB20', 'GEM01')):
        stage = 11
        source, info = original_frame(lib, family, stage)
        dx, dy = np.subtract(info['offset'], meta['offset']).tolist()
        orig = Image.new('RGBA', (w, h))
        orig.paste(Image.fromarray(source), (dx, dy))
        x, y, rw, rh = [v * 2 for v in meta['frames'][family][stage]]
        views = (orig, Image.fromarray(old[y:y + rh, x:x + rw]), Image.fromarray(new[y:y + rh, x:x + rw]))
        yy = header + row * (cellh + margin)
        draw.text((8, yy + cellh // 2), f'{family}\nStage 11', fill='#30271a')
        for col, image in enumerate(views):
            image = image.resize((cellw, cellh), Image.Resampling.NEAREST)
            sheet.paste(image, (label + margin + col * cellw, yy), image)
    prepare_output(out.parent, (extracted, layout, build_dir))
    write_png(out, np.array(sheet))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    p = commands.add_parser('build')
    for flag in ('extracted', 'layout', 'out'):
        p.add_argument('--' + flag, type=Path, required=True)
    p.add_argument('--theatre', required=True, choices=['desert'])
    engine = p.add_mutually_exclusive_group(required=True)
    engine.add_argument('--esrgan', type=Path, help='directory containing the binary and models/')
    engine.add_argument('--esrgan-cmd', help='compatible upscaler argv prefix (tests use a fake); receives -i INPUT -o OUTPUT')
    engine.add_argument('--smooth', action='store_true',
                        help='no model: smooth bicubic upscale with rounded pebble outlines (the static L4 look)')
    p.add_argument('--tone', choices=['original', 'model'], default='original')
    p = commands.add_parser('install')
    p.add_argument('--cache-root', type=Path, required=True)
    p.add_argument('--theatre', required=True, choices=['desert'])
    p.add_argument('--build', type=Path, required=True)
    p = commands.add_parser('preview')
    for flag in ('extracted', 'layout', 'build', 'out'):
        p.add_argument('--' + flag, type=Path, required=True)
    args = parser.parse_args(argv)
    if args.command == 'build':
        build(args.extracted, args.theatre, args.layout, args.esrgan, args.out,
              tone=args.tone, esrgan_cmd=args.esrgan_cmd, upscaler='smooth' if args.smooth else 'esrgan')
    elif args.command == 'install':
        install(args.cache_root, args.theatre, args.build)
    else:
        preview(args.extracted, args.layout, args.build, args.out)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
