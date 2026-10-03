#!/usr/bin/env python3
"""Pack complete adjacent overlap strips for manual 1:1 review, without resizing."""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
from PIL import Image, ImageDraw

Image.MAX_IMAGE_PIXELS = None


def overlap_box(pair, image_size, margin):
    x0, y0, x1, y1 = pair['overlap_box_2x']
    width, height = image_size
    if not (0 <= x0 < x1 <= width and 0 <= y0 < y1 <= height):
        raise ValueError('Overlap must be a nonempty rectangle inside the image')
    if pair['axis'] == 'vertical':
        return max(0, x0-margin), y0, min(width, x1+margin), y1
    if pair['axis'] == 'horizontal':
        return x0, max(0, y0-margin), x1, min(height, y1+margin)
    raise ValueError('Unknown overlap axis')


def generate(image_path, plan_path, output, margin=64):
    """Every overlap appears once, at its full width/height, including wide end tiles."""
    if margin < 0:
        raise ValueError('Margin cannot be negative')
    pairs = json.loads(plan_path.read_text())['pairs']
    with Image.open(image_path) as original:
        original = original.convert('RGBA')
        boxes = [overlap_box(pair, original.size, margin) for pair in pairs]
        # Refuse to overwrite potentially reviewed evidence, even if the source changed.
        output.mkdir(parents=True, exist_ok=False)
        records = []
        for axis in ['vertical', 'horizontal']:
            panels = []
            for index, (pair, box) in enumerate(zip(pairs, boxes)):
                if pair['axis'] != axis:
                    continue
                part = original.crop(box)
                board = Image.new('RGB', (part.width, part.height+24), (24,26,28))
                ImageDraw.Draw(board).text((4,6), f'{pair["tiles"]}: {box};1:1', fill='white')
                board.paste(part, (0,24), part)
                panels.append((index, board, box))
            batch = []; width = height = group = 0

            def save_batch():
                nonlocal group
                if not batch:
                    return
                group += 1
                name = f'{axis}-{group:02}.png'
                canvas = Image.new('RGB', (width,height), (24,26,28)); offset = 0
                for index, board, box in batch:
                    position = (offset,0) if axis == 'vertical' else (0,offset)
                    canvas.paste(board, position)
                    records.append({'pair_index':index, 'tiles':pairs[index]['tiles'], 'file':name,
                                    'box_2x':list(box), 'board_position':list(position),
                                    'review':'PENDING manual1:1 review'})
                    offset += board.width if axis == 'vertical' else board.height
                canvas.save(output/name)

            for item in panels:
                index, board, box = item
                if batch and ((width+board.width > 1920) if axis == 'vertical' else (height+board.height > 1536)):
                    save_batch(); batch = []; width = height = 0
                batch.append(item)
                width = width+board.width if axis == 'vertical' else max(width,board.width)
                height = max(height,board.height) if axis == 'vertical' else height+board.height
            save_batch()
    result = {'image_sha256':hashlib.sha256(image_path.read_bytes()).hexdigest(), 'pair_count':len(records),
              'display':'one image pixel per board pixel; no resizing', 'records':records}
    (output/'index.json').write_text(json.dumps(result,indent=2)+'\n')
    return result


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--image', type=Path, required=True)
    p.add_argument('--plan', type=Path, required=True)
    p.add_argument('--output', type=Path, required=True)
    p.add_argument('--margin', type=int, default=64)
    args = p.parse_args()
    result = generate(args.image, args.plan, args.output, args.margin)
    print(json.dumps({'pairs':result['pair_count'], 'output':str(args.output), 'review':'PENDING'}))


if __name__ == '__main__':
    main()
