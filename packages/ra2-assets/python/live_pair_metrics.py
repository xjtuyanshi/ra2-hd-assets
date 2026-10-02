"""Review frozen whole-guest live pairs with crops, spatial boards and pixel metrics.

Inputs are orig-NN.png / hd-NN.png captures of the full 1152x744 engine frame.
House-hue counts use screenshot pixels; dark counts are normalised to engine pixels.
"""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont

ENGINE_SIZE = (1152, 744)
GAP = 8
BOARD_FONT = Path('/System/Library/Fonts/STHeiti Medium.ttc')


def engine_box_to_pixels(box, size: tuple[int, int]) -> tuple[int, int, int, int]:
    """Map engine edges to screenshot pixels, rounding outward on each axis."""
    x0, y0, x1, y1 = box
    width, height = size
    if width <= 0 or height <= 0:
        raise ValueError('Screenshot dimensions must be positive')
    if not all(math.isfinite(edge) for edge in box) or not (
        0 <= x0 < x1 <= ENGINE_SIZE[0] and 0 <= y0 < y1 <= ENGINE_SIZE[1]
    ):
        raise ValueError('Engine box must be non-empty and inside the 1152x744 guest frame')
    # Divide after multiplying so a full-frame edge maps exactly to its integer image dimension.
    return (math.floor(x0 * width / ENGINE_SIZE[0]), math.floor(y0 * height / ENGINE_SIZE[1]),
            math.ceil(x1 * width / ENGINE_SIZE[0]), math.ceil(y1 * height / ENGINE_SIZE[1]))


def house_pixels(image: np.ndarray, hue: tuple[int, int], smin: int = 100, vmin: int = 60) -> int:
    """Count RGB uint8 pixels in an inclusive OpenCV HSV band; LO > HI wraps at zero."""
    lo, hi = hue
    if not (0 <= lo <= 180 and 0 <= hi <= 180 and 0 <= smin <= 255 and 0 <= vmin <= 255):
        raise ValueError('Hue bounds must be 0..180; saturation/value thresholds must be 0..255')
    if image.dtype != np.uint8 or image.ndim != 3 or image.shape[2] != 3 or not image.size:
        raise ValueError('House pixels require a non-empty RGB uint8 image')
    hsv = cv2.cvtColor(image, cv2.COLOR_RGB2HSV)
    h, s, v = hsv[..., 0], hsv[..., 1], hsv[..., 2]
    band = (h >= lo) & (h <= hi) if lo <= hi else (h >= lo) | (h <= hi)
    return int(np.count_nonzero(band & (s >= smin) & (v >= vmin)))


def side_by_side(orig: Image.Image, hd: Image.Image, labels=('原版', 'HD'),
                 font: ImageFont.ImageFont | None = None) -> Image.Image:
    """Paste native-size crops on white; only a supplied font enables the label strip."""
    strip = 0
    bounds = []
    if font is not None:
        bounds = [font.getbbox(label) for label in labels]
        strip = max(bottom - top for _, top, _, bottom in bounds) + 8
    result = Image.new('RGB', (orig.width + GAP + hd.width, max(orig.height, hd.height) + strip), 'white')
    result.paste(orig.convert('RGB'), (0, strip))
    right = orig.width + GAP
    result.paste(hd.convert('RGB'), (right, strip))
    if font is not None:
        # Clip labels to their own columns so a narrow crop still has a white gap.
        for x, image, label, (left, top, _, _) in zip((0, right), (orig, hd), labels, bounds):
            label_strip = Image.new('RGB', (image.width, strip), 'white')
            ImageDraw.Draw(label_strip).text((4 - left, 4 - top), label, font=font, fill='black')
            result.paste(label_strip, (x, 0))
    return result


def _load_crops(pairs: Path, pair_id: str, box) -> tuple[Image.Image, Image.Image]:
    if not pair_id.isascii() or not pair_id.isdecimal():
        raise ValueError('Pair id must be digits matching the orig-NN.png / hd-NN.png filenames')
    crops = []
    for prefix in ('orig', 'hd'):
        with Image.open(pairs / f'{prefix}-{pair_id}.png') as image:
            crops.append(image.convert('RGB').crop(engine_box_to_pixels(box, image.size)))
    return tuple(crops)


def _numbers(values, length: int, name: str) -> tuple:
    if not isinstance(values, (list, tuple)) or len(values) != length or not all(
        isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)
        for value in values
    ):
        raise ValueError(f'{name} must contain {length} finite numbers')
    return tuple(values)


def _positive_scale(scale) -> float:
    value, = _numbers([scale], 1, 'Scale')
    if value <= 0:
        raise ValueError('Scale must be positive')
    return float(value)


def clamp_engine_box(box) -> tuple:
    """Intersect a non-empty engine box with the guest frame, refusing empty results."""
    x0, y0, x1, y1 = _numbers(box, 4, 'Engine box')
    if x0 >= x1 or y0 >= y1:
        raise ValueError('Engine box must be non-empty')
    result = (max(0, x0), max(0, y0), min(ENGINE_SIZE[0], x1), min(ENGINE_SIZE[1], y1))
    if result[0] >= result[2] or result[1] >= result[3]:
        raise ValueError('Engine box does not intersect the 1152x744 guest frame')
    return result


def spatial_row_box(row: dict, base_dir: Path = Path('.')) -> tuple:
    """Locate a type in this pair's snapshot using the driver's lepton projection."""
    if 'box' in row:
        return clamp_engine_box(row['box'])
    pair_id = str(row['idx'])
    if not pair_id.isascii() or not pair_id.isdecimal():
        raise ValueError('Pair idx must be digits matching the native-NN.json filename')
    pairs = base_dir / row['pairs']
    with (pairs / f'native-{pair_id}.json').open(encoding='utf-8') as source:
        snapshot = json.load(source)
    snapshot = snapshot.get('state', snapshot)
    view = snapshot['view']
    vx, vy = _numbers([view['x'], view['y']], 2, 'Snapshot view')
    find = row['find']
    near = _numbers(find['near'], 2, 'Find near') if 'near' in find else None
    candidates = []
    for obj in snapshot['objects']:
        if obj.get('type') != find['type'] or ('owner' in find and obj.get('owner') != find['owner']):
            continue
        x, y, z = _numbers([obj['x'], obj['y'], obj['z']], 3, 'Object coordinates')
        sx = (x - y) * 30 / 256 - vx
        sy = (x + y) * 15 / 256 - z * 15 / 104 - vy
        # Without a hint, prefer the first on-screen match in snapshot order.
        distance = math.hypot(sx - near[0], sy - near[1]) if near else (
            0 if 0 <= sx < ENGINE_SIZE[0] and 0 <= sy < ENGINE_SIZE[1] else math.inf
        )
        candidates.append((distance, sx, sy))
    if not candidates:
        raise ValueError(f"Object type {find['type']} not found in pair {pair_id} ({pairs})")
    _, sx, sy = min(candidates, key=lambda candidate: candidate[0])
    width, height = _numbers(row.get('size', [220, 160]), 2, 'Crop size')
    dx, dy = _numbers(row.get('off', [0, 0]), 2, 'Crop offset')
    cx, cy = sx + dx, sy + dy
    return clamp_engine_box((cx - width / 2, cy - height / 2, cx + width / 2, cy + height / 2))


def _scaled_crop(path: Path, box, scale=None) -> tuple[Image.Image, float]:
    """Use one width-derived scale for pair frames, or an explicit replay scale."""
    x0, y0, x1, y1 = clamp_engine_box(box)
    with Image.open(path) as source:
        factor = _positive_scale(source.width / ENGINE_SIZE[0] if scale is None else scale)
        if x1 * factor > source.width + 1 or y1 * factor > source.height + 1:
            raise ValueError(f'Image {path} does not cover the engine box at scale {factor}')
        pixels = (max(0, math.floor(x0 * factor)), max(0, math.floor(y0 * factor)),
                  min(source.width, math.ceil(x1 * factor)), min(source.height, math.ceil(y1 * factor)))
        # Never let Pillow fabricate black padding outside the image for dark metrics.
        if pixels[0] >= pixels[2] or pixels[1] >= pixels[3]:
            raise ValueError(f'Engine box does not intersect image {path} at scale {factor}')
        return source.convert('RGB').crop(pixels), factor


def _board_font(size: int) -> ImageFont.ImageFont:
    try:
        return ImageFont.truetype(str(BOARD_FONT), size)
    except OSError:
        return ImageFont.load_default()


def _text_lines(text: str, font: ImageFont.ImageFont, width: int) -> list[str]:
    # Older Pillow bitmap defaults only encode Latin-1; missing CJK fonts must not abort a board.
    try:
        font.getbbox(text)
    except UnicodeEncodeError:
        text = text.encode('latin-1', errors='replace').decode('latin-1')
    lines = []
    for paragraph in text.split('\n'):
        line = ''
        for char in paragraph:
            if line and font.getlength(line + char) > width:
                lines.append(line)
                line = ''
            line += char
        lines.append(line)
    return lines


def spatial_board(spec: dict, base_dir: Path = Path('.')) -> Image.Image:
    """Build equal-engine-scale rows; relative source paths are anchored to the spec."""
    scale = _positive_scale(spec.get('scale', 2))
    if not isinstance(spec.get('rows'), list) or not spec['rows']:
        raise ValueError('Spatial spec rows must be a non-empty list')
    rows = []
    for row in spec['rows']:
        box = spatial_row_box(row, base_dir)
        tiles = row.get('tiles', [['orig'], ['hd']])
        if not isinstance(tiles, list) or not tiles:
            raise ValueError('Row tiles must be a non-empty list')
        images = []
        for tile in tiles:
            if not isinstance(tile, list) or len(tile) not in (1, 2) or not isinstance(tile[0], str):
                raise ValueError('Each tile must be [source] or [source, scale]')
            src, kind = tile[0], tile[1] if len(tile) == 2 else 'pair'
            if src in ('orig', 'hd'):
                pair_id = str(row['idx'])
                if not pair_id.isascii() or not pair_id.isdecimal():
                    raise ValueError('Pair idx must be digits matching the orig-NN.png / hd-NN.png filenames')
                path = base_dir / row['pairs'] / f'{src}-{pair_id}.png'
            else:
                path = base_dir / src
            image, _ = _scaled_crop(path, box, None if kind == 'pair' else kind)
            images.append(image.resize((max(1, round((box[2] - box[0]) * scale)),
                                        max(1, round((box[3] - box[1]) * scale))), Image.Resampling.LANCZOS))
        rows.append((row, images))
    columns = max(len(images) for _, images in rows)
    names = spec.get('cols', (['原版', 'HD'] + [f'Column {i + 1}' for i in range(2, columns)])[:columns])
    if not isinstance(names, list) or len(names) != columns or not all(isinstance(name, str) for name in names):
        raise ValueError(f'Spatial cols must contain {columns} column names')
    fonts = [_board_font(size) for size in (30, 19, 22, 21, 16)]
    widths = [max(images[i].width for _, images in rows if i < len(images)) for i in range(columns)]
    gap = 10
    width = sum(widths) + gap * (columns + 1)
    # Lay out text before allocating the canvas so narrow boards retain every label and note.
    text_blocks = []
    y = 10

    def text_block(text, font_index, x, available, colour):
        nonlocal y
        font = fonts[font_index]
        line_height = max(font.getbbox('Ag')[3] - font.getbbox('Ag')[1] + 8, (38, 27, 30, 30, 22)[font_index])
        lines = _text_lines(text, font, available)
        text_blocks.append((x, y, lines, font, line_height, colour))
        y += line_height * len(lines)

    text_block(spec['title'], 0, gap, width - 2 * gap, (240, 240, 240))
    if spec.get('subtitle'):
        text_block(spec['subtitle'], 1, gap, width - 2 * gap, (190, 190, 190))
    header_y = y
    x = gap
    for name, column_width in zip(names, widths):
        y = header_y
        text_block(name, 2, x, column_width, (235, 235, 160))
        x += column_width + gap
    y = max(block[1] + len(block[2]) * block[4] for block in text_blocks)
    placements = []
    for row, images in rows:
        text_block(row['label'], 3, gap, width - 2 * gap, (220, 220, 220))
        x = gap
        for i, image in enumerate(images):
            placements.append((image, x, y))
            x += widths[i] + gap
        y += max(image.height for image in images)
        if row.get('note'):
            text_block(row['note'], 4, gap, width - 2 * gap, (180, 200, 180))
        y += gap
    board = Image.new('RGB', (width, y), (18, 18, 20))
    draw = ImageDraw.Draw(board)
    for x, top, lines, font, line_height, colour in text_blocks:
        for i, line in enumerate(lines):
            draw.text((x, top + i * line_height), line, font=font, fill=colour)
    for image, x, top in placements:
        board.paste(image, (x, top))
    return board


def write_spatial_board(spec_path: Path, out: Path) -> None:
    with spec_path.open(encoding='utf-8') as source:
        board = spatial_board(json.load(source), spec_path.parent)
    out.parent.mkdir(parents=True, exist_ok=True)
    board.save(out, format='PNG')
    phone = board.copy()
    phone.thumbnail((2000, 2000), Image.Resampling.LANCZOS)
    phone.save(out.with_name(out.stem + '_s.jpg'), format='JPEG', quality=88)


def dark_metrics(paths: list[Path], box, threshold: int = 40, scale=None) -> dict:
    """Count strict HSV V thresholds before resampling and divide by scale squared."""
    if not isinstance(threshold, int) or not 0 <= threshold <= 255:
        raise ValueError('Dark threshold must be an integer in 0..255')
    box = clamp_engine_box(box)
    results = []
    for path in paths:
        image, factor = _scaled_crop(path, box, scale)
        value = cv2.cvtColor(np.asarray(image), cv2.COLOR_RGB2HSV)[..., 2]
        results.append({'path': str(path), 'scale': factor,
                        'below_threshold': int(np.count_nonzero(value < threshold)) / factor ** 2,
                        'below_60': int(np.count_nonzero(value < 60)) / factor ** 2})
    return {'box': box, 'threshold': threshold, 'units': 'engine_pixels', 'images': results}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument('--pairs', type=Path, required=True)
    common.add_argument('--id', required=True)
    common.add_argument('--box', type=float, nargs=4, required=True, metavar=('EX0', 'EY0', 'EX1', 'EY1'))
    crop = commands.add_parser('crop', parents=[common], help='write a side-by-side crop at native screenshot scale')
    crop.add_argument('--out', type=Path, required=True)
    crop.add_argument('--labels', nargs=2, default=('原版', 'HD'))
    crop.add_argument('--font', type=Path, help='TTF/TTC font for labels (20 px); no font means no label strip')
    house = commands.add_parser('house', parents=[common], help='count saturated house-hue pixels in the crops')
    house.add_argument('--hue', type=int, nargs=2, required=True, metavar=('LO', 'HI'))
    house.add_argument('--smin', type=int, default=100)
    house.add_argument('--vmin', type=int, default=60)
    spatial = commands.add_parser('spatial', help='write an object-centred PNG board and a phone JPEG')
    spatial.add_argument('--spec', type=Path, required=True)
    spatial.add_argument('--out', type=Path, required=True)
    dark = commands.add_parser('dark', help='count dark pixels in engine-pixel units as JSON')
    dark.add_argument('images', type=Path, nargs='+', help='pair frames or guest-origin replay images')
    dark.add_argument('--box', type=float, nargs=4, required=True, metavar=('EX0', 'EY0', 'EX1', 'EY1'))
    dark.add_argument('--threshold', type=int, default=40, help='strict HSV V upper bound (default: 40)')
    dark.add_argument('--scale', type=float, help='pixels per engine pixel; default is each image width / 1152')
    args = parser.parse_args(argv)
    try:
        if args.command == 'spatial':
            write_spatial_board(args.spec, args.out)
            return
        if args.command == 'dark':
            print(json.dumps(dark_metrics(args.images, args.box, args.threshold, args.scale)))
            return
        orig, hd = _load_crops(args.pairs, args.id, args.box)
        if args.command == 'crop':
            font = ImageFont.truetype(str(args.font), 20) if args.font else None
            result = side_by_side(orig, hd, args.labels, font)
            args.out.parent.mkdir(parents=True, exist_ok=True)
            result.save(args.out, format='PNG')
        else:
            n = house_pixels(np.asarray(orig), args.hue, args.smin, args.vmin)
            m = house_pixels(np.asarray(hd), args.hue, args.smin, args.vmin)
            print(json.dumps({'orig': n, 'hd': m, 'ratio': m / max(1, n)}))
    except (OSError, ValueError, KeyError, TypeError) as error:
        parser.error(str(error))


if __name__ == '__main__':
    main()
