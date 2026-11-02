"""Asset-free regressions of the per-frame higher-resolution page packer (sprite_hd_pages.py)."""

import json
import os
from pathlib import Path

import numpy as np
from PIL import Image
import pytest

import sprite_hd_pages as packer

S = 4


def write(path: Path, array: np.ndarray, mode: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray(array, mode).save(path)


@pytest.fixture
def setup(tmp_path):
    lib = tmp_path / 'lib'
    indexed = np.zeros((8, 16), np.uint8)
    indexed[1:4, 1:3] = 40          # frame 0 (2x3), body
    indexed[3, 1] = 20               # one house pixel
    indexed[1:3, 6:9] = 50          # frame 2 (3x2), other art
    write(lib / 'sprites-0.png', indexed, 'L')
    write(lib / 'sprites-0@2x.png', np.zeros((16, 32, 4), np.uint8), 'RGBA')
    write(lib / 'sprites-0@2x-remap.png', np.zeros((16, 32), np.uint8), 'L')
    normals = np.zeros((8, 16, 4), np.uint8)
    normals[1:4, 1:3] = (10, 20, 30, 255)
    write(lib / 'n0.png', normals, 'RGBA')
    library = {
        'version': 1,
        'spriteAtlases': [{'file': 'sprites-0.png', 'width': 16, 'height': 8}],
        'spriteAtlasesHd': [{'file': 'sprites-0@2x.png', 'remap': 'sprites-0@2x-remap.png', 'scale': 2,
                             'width': 32, 'height': 16}],
        'sprites': {'infantry:T': {'frames': [
            {'rect': [1, 1, 2, 3], 'offset': [-1, -3], 'page': 0},
            {'rect': [1, 1, 2, 3], 'offset': [-1, -3], 'page': 0},   # shares frame 0's art
            {'rect': [6, 1, 3, 2], 'offset': [-1, -2], 'page': 0},
            {'rect': [0, 0, 0, 0], 'offset': [0, 0], 'page': 0},
        ], 'shadows': [{'rect': [10, 5, 2, 1], 'offset': [0, 0], 'page': 0}]}},
        'types': {'T': {'sprite': 'infantry:T', 'atlasPages': [0]}, 'U': {'sprite': 'infantry:U', 'atlasPages': [0]}},
        'unknown': {'kept': True},
    }
    (lib / 'library.json').write_text(json.dumps(library))
    (lib / 'normals.json').write_text(json.dumps({'version': 1, 'encoding': {'x': 1}, 'pages': {'0': {
        'file': 'n0.png', 'atlas': 'sprites-0@2x.png', 'width': 32, 'height': 16, 'scale': 2,
        'materialWidth': 16, 'materialHeight': 8, 'frames': 2}}}))
    pages = tmp_path / 'pages'
    # Frame 0: a 4x page with a 1 game px border around the frame (origin one px up-left of the frame offset).
    colour = np.zeros(((3 + 2) * S, (2 + 2) * S, 4), np.uint8)
    colour[S:4 * S, S:3 * S] = (200, 100, 50, 255)
    colour[3 * S:4 * S, S:2 * S] = (90, 90, 90, 255)   # house pixel, grey encoded
    colour[0, 0] = (1, 2, 3, 255)                      # gutter content outside the frame
    paint = np.zeros(colour.shape[:2], np.uint8)
    paint[3 * S:4 * S, S:2 * S] = 255
    write(pages / 'c0.png', colour, 'RGBA')
    write(pages / 'p0.png', paint, 'L')
    # Frame 2: misregistered by two game px (fails the check, keeps its page).
    bad = np.zeros((2 * S, 3 * S, 4), np.uint8)
    bad[:, :S] = (255, 255, 255, 255)
    write(pages / 'c2.png', bad, 'RGBA')
    index = {'scale': S, 'sprites': {'infantry:T': {'frames': {
        '0': {'colour': 'c0.png', 'paint': 'p0.png', 'origin': [-2, -4]},
        '1': {'colour': 'c0.png', 'paint': 'p0.png', 'origin': [-2, -4]},
        '2': {'colour': 'c2.png', 'origin': [1, -2]},
    }}}}
    (pages / 'index.json').write_text(json.dumps(index))
    return tmp_path, lib, pages, library


def test_packs_accepted_frames_onto_a_new_page_and_keeps_the_rest(setup):
    tmp, lib, pages, original = setup
    out = tmp / 'out'
    before = {p.name: p.read_bytes() for p in lib.iterdir()}
    assert packer.main(['--library', str(lib), '--frames', str(pages / 'index.json'), '--out', str(out)]) == 0
    assert {p.name: p.read_bytes() for p in lib.iterdir()} == before  # the source library is read only
    library = json.loads((out / 'library.json').read_text())
    receipt = json.loads((out / 'receipt.json').read_text())
    assert library['unknown'] == {'kept': True}
    assert len(library['spriteAtlases']) == 2 and len(library['spriteAtlasesHd']) == 2
    atlas, hd = library['spriteAtlases'][1], library['spriteAtlasesHd'][1]
    assert hd['scale'] == S and (hd['width'], hd['height']) == (atlas['width'] * S, atlas['height'] * S)
    frames = library['sprites']['infantry:T']['frames']
    # Frames 0 and 1 share one placement on page 1; frame 2 failed registration and frame 3 is empty: unchanged.
    assert frames[0]['page'] == frames[1]['page'] == 1 and frames[0]['rect'] == frames[1]['rect']
    assert frames[0]['offset'] == [-1, -3] and frames[0]['rect'][2:] == [2, 3]
    assert frames[2] == original['sprites']['infantry:T']['frames'][2]
    assert frames[3] == original['sprites']['infantry:T']['frames'][3]
    assert library['sprites']['infantry:T']['shadows'] == original['sprites']['infantry:T']['shadows']
    assert library['types']['T']['atlasPages'] == [0, 1] and library['types']['U']['atlasPages'] == [0]
    assert [r['frame'] for r in receipt['fallback']] == [2]  # frame 3 had no page: not listed
    x, y, w, h = frames[0]['rect']
    indexed = np.asarray(Image.open(out / atlas['file']))
    assert (indexed[y:y + h, x:x + w] == np.asarray(Image.open(lib / 'sprites-0.png'))[1:4, 1:3]).all()
    assert indexed.sum() == np.asarray(Image.open(lib / 'sprites-0.png'))[1:4, 1:3].astype(int).sum()
    colour = np.asarray(Image.open(out / hd['file']))
    paint = np.asarray(Image.open(out / hd['remap']))
    block = colour[y * S:(y + h) * S, x * S:(x + w) * S]
    assert (block[:2 * S, :, :3] == (200, 100, 50)).all() and (block[..., 3] == 255).all()
    assert (block[2 * S:, :S, :3] == 90).all() and (paint[(y + 2) * S:(y + 3) * S, x * S:(x + 1) * S] == 255).all()
    # Gutter: half of it carries the page's own art beyond the frame; transparent texels are bled, not black.
    assert tuple(colour[(y - 1) * S, (x - 1) * S]) == (1, 2, 3, 255)
    assert colour[(y - 1) * S + 1, (x - 1) * S + 1, 3] == 0 and colour[(y - 1) * S + 1, (x - 1) * S + 1, :3].any()
    normals = json.loads((out / 'normals.json').read_text())
    assert normals['encoding'] == {'x': 1} and normals['pages']['0']['file'] == 'n0.png'
    entry = normals['pages']['1']
    assert (entry['atlas'], entry['width'], entry['scale'], entry['materialWidth']) == (hd['file'], hd['width'], S,
                                                                                         atlas['width'])
    material = np.asarray(Image.open(out / entry['file']))
    assert (material[y:y + h, x:x + w] == (10, 20, 30, 255)).all() and material[..., 3].sum() == 255 * w * h


def test_farm_install_never_writes_through_the_base(setup, tmp_path):
    _, lib, pages, _ = setup
    farm = tmp_path / 'farm'
    (farm / '_library').mkdir(parents=True)
    os.symlink(lib, farm / '_library' / 'urban')
    before = {p.name: p.read_bytes() for p in lib.iterdir()}
    receipt = tmp_path / 'receipt.json'
    assert packer.main(['--library', str(farm / '_library' / 'urban'), '--frames', str(pages / 'index.json'),
                        '--farm', str(farm), '--rel', '_library/urban', '--receipt', str(receipt)]) == 0
    assert {p.name: p.read_bytes() for p in lib.iterdir()} == before
    installed = farm / '_library' / 'urban'
    assert not installed.is_symlink() and (installed / 'library.json').is_file()
    assert not (installed / 'library.json').is_symlink()
    library = json.loads((installed / 'library.json').read_text())
    assert library['sprites']['infantry:T']['frames'][0]['page'] == 1
    assert (installed / library['spriteAtlasesHd'][1]['file']).is_file()
    assert json.loads(receipt.read_text())['pages'][0]['index'] == 1


def test_refuses_a_frame_changed_after_validation(setup):
    _, lib, pages, _ = setup
    plan = packer.Plan(lib, pages / 'index.json', min_iou=0.8, min_cover=0.9)
    built = packer.build(plan, gutter=4, max_side=8192)
    _, records = packer.encode(plan, built)
    library = json.loads((lib / 'library.json').read_text())
    library['sprites']['infantry:T']['frames'][0]['rect'] = [2, 1, 2, 3]
    with pytest.raises(ValueError, match='changed since validation'):
        packer.edit_library(library, built['frames'], records)


def test_shelf_pack_spills_to_more_pages_without_overlap():
    sizes = [(10, 12)] * 30 + [(5, 7)] * 9
    places, pages = packer.shelf_pack(sizes, 4, 64)
    assert len(pages) > 1 and all(w <= 64 and h <= 64 for w, h in pages)
    boxes = {}
    for (p, x, y), (w, h) in zip(places, sizes):
        assert x >= 4 and y >= 4 and x + w + 4 <= pages[p][0] and y + h + 4 <= pages[p][1]
        for (q, a, b, c, d) in boxes.values():
            if q == p:
                assert x + w + 4 <= a or a + c + 4 <= x or y + h + 4 <= b or b + d + 4 <= y
        boxes[len(boxes)] = (p, x, y, w, h)


def test_excluded_index_leaves_registration_but_still_counts_elsewhere():
    """A footprint painted with one index (drawn translucent on purpose) must not fail the coverage gate."""
    indexed = np.zeros((4, 4), np.uint8)
    indexed[:2] = 40                    # body
    indexed[2:] = 12                    # footprint
    alpha = np.zeros((4 * S, 4 * S), np.uint8)
    alpha[:2 * S] = 255                 # body covered
    alpha[2 * S:] = 90                  # footprint at ~0.35, as the 2x pages carry it
    paint = np.zeros_like(alpha)
    rgb = np.zeros((4 * S, 4 * S, 4), np.uint8)
    plain = packer.frame_metrics(indexed, alpha, paint, rgb, S)
    assert plain['cover'] == 0.5
    kept = packer.frame_metrics(indexed, alpha, paint, rgb, S, (12,))
    assert kept['cover'] == 1.0 and kept['iou'] == 1.0
    alpha[0, :] = 0
    alpha[:S, :] = 0                    # a body hole still fails
    assert packer.frame_metrics(indexed, alpha, paint, rgb, S, (12,))['cover'] == 0.5
