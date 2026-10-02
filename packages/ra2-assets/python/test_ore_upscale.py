"""Asset-free original-grain, live-layout and copy-on-write install regressions."""

import copy
import json
from pathlib import Path
import shlex
import sys
import tempfile
import unittest

import cv2
import numpy as np
from PIL import Image

import ore_fields as ore
import ore_upscale as upscale


def save(path, pixels):
    path.parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray(pixels).save(path)


def inputs(root):
    extracted, layout = root / 'extracted', root / 'layout'
    extracted.mkdir(); layout.mkdir()
    palette = np.zeros((1, 256, 3), np.uint8)
    palette[0, 20] = (190, 166, 112)
    palette[0, 43] = (40, 85, 220)
    indexed = np.zeros((16, 12 * 10), np.uint8)
    native = np.zeros((24 * 20, 24), np.uint8)
    sprites, overlays, frames = {}, {}, {}
    offset, size = [-10, -2], [20, 16]
    for family, yy, colour in (('TIB01', 0, 20), ('GEM01', 8, 43)):
        source_frames, rects = [], []
        for stage in range(12):
            x = stage * 10
            # Growth stages differ and contain an internal hole; frame offsets
            # vary too, detecting accidental full-stage reuse or recentring.
            patch = indexed[yy:yy + 8, x:x + 10]
            width = 2 + stage // 2
            patch[2:6, 1:1 + width] = colour
            patch[3, 2] = 0
            info = {'rect': [x, yy, 10, 8], 'offset': [-7 + stage % 2, 1], 'page': 0}
            source_frames.append(info)
            n = len(frames) * 12 + stage
            rect = [2, 2 + n * 20, *size]
            rects.append(rect)
            native[rect[1]:rect[1] + size[1], rect[0]:rect[0] + size[0]] = colour
        sprites['overlay:' + family] = {'palette': 'theater', 'canvas': [60, 60], 'frames': source_frames}
        overlays[family] = {'sprite': 'overlay:' + family, 'palette': 'theater', 'remap': False}
        frames[family] = rects
    library = {'spriteAtlases': [{'file': 'original.png', 'width': 120, 'height': 16}],
               'palettes': {'theater': 'palette.png'}, 'overlays': overlays, 'sprites': sprites}
    (extracted / 'library.json').write_text(json.dumps(library))
    save(extracted / 'original.png', indexed); save(extracted / 'palette.png', palette)
    meta = {'width': 24, 'height': 480, 'size': size, 'offset': offset, 'frames': frames}
    (layout / 'frames.json').write_text(json.dumps(meta))
    save(layout / ore.PAGE, native)
    save(layout / ore.REMAP, np.zeros((960, 48), np.uint8))
    save(layout / ore.HD, np.zeros((960, 48, 4), np.uint8))
    fake = root / 'fake esrgan.py'
    fake.write_text("""import argparse
from PIL import Image
p=argparse.ArgumentParser();p.add_argument('-i');p.add_argument('-o');a=p.parse_args()
with Image.open(a.i) as image:
 image.resize((image.width*4,image.height*4),Image.Resampling.BICUBIC).save(a.o)
""")
    command = shlex.join([sys.executable, '-B', str(fake)])
    return extracted, layout, meta, command


def build(root):
    extracted, layout, meta, command = inputs(root)
    out = root / 'build'
    metrics = upscale.build(extracted, 'desert', layout, None, out, esrgan_cmd=command)
    return extracted, layout, meta, out, metrics


def farm(root, extracted, layout, meta):
    base = root / 'base'
    directory = base / '_library/desert'; directory.mkdir(parents=True)
    lib = json.loads((extracted / 'library.json').read_text())
    # Page 1 rather than the real farm's 24: installation must find it by filename.
    lib['spriteAtlases'].append({'file': ore.PAGE, 'width': meta['width'], 'height': meta['height']})
    lib['spriteAtlasesHd'] = [{'file': 'other.png', 'scale': 2},
                             {'file': ore.HD, 'remap': ore.REMAP, 'width': 48, 'height': 960,
                              'scale': 2, 'custom': 'preserved'}]
    for family in meta['frames']:
        for stage, frame in enumerate(lib['sprites']['overlay:' + family]['frames']):
            frame.update(page=1, offset=meta['offset'], rect=meta['frames'][family][stage], custom=stage)
    lib['sprites']['overlay:TIB2_01'] = copy.deepcopy(lib['sprites']['overlay:TIB01'])
    lib['unrelated'] = {'terrain': 'preserved'}
    normals = {'version': 1, 'pages': {'0': {'file': 'other-normal.png', 'atlas': 'other.png'},
                                     '1': {'file': ore.MAT, 'atlas': ore.HD, 'custom': 7}}}
    (directory / 'library.json').write_text(json.dumps(lib))
    (directory / 'normals.json').write_text(json.dumps(normals))
    (directory / '.compose.lock').touch()
    (directory / '.library.json.lock').touch(); (directory / '.normals.json.lock').touch()
    (directory / ore.PAGE).write_bytes((layout / ore.PAGE).read_bytes())
    (directory / ore.REMAP).write_bytes((layout / ore.REMAP).read_bytes())
    # Existing destination-name symlinks must be replaced, never written through.
    for name in upscale.FILES:
        (directory / name).write_bytes(b'base sentinel')
    target = root / 'farm'; target.mkdir()
    (target / '_library').symlink_to(base / '_library', target_is_directory=True)
    return base, target, lib, normals


class OreUpscaleTests(unittest.TestCase):
    def test_build_places_every_stage_and_preserves_mask_layout_and_tone(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve()
            extracted, layout, meta, out, metrics = build(root)
            lib = upscale.OriginalLibrary(extracted)
            page = ore.read_image(out / upscale.HD)
            materials = ore.read_image(out / upscale.NORMALS)
            self.assertEqual(page.shape, (960, 48, 4))
            np.testing.assert_array_equal(materials[..., 3] > 0, page[..., 3] > 0)
            self.assertEqual((layout / 'frames.json').read_bytes(), (out / 'frames.json').read_bytes())
            self.assertEqual((layout / ore.PAGE).read_bytes(), (out / ore.PAGE).read_bytes())
            self.assertEqual((layout / ore.REMAP).read_bytes(), (out / upscale.REMAP).read_bytes())
            self.assertEqual(metrics['frames'], 24)
            self.assertEqual(metrics['native_gate']['clipped_hd_pixels'], 0)
            for family, rects in meta['frames'].items():
                for stage, rect in enumerate(rects):
                    original, info = upscale.original_frame(lib, family, stage)
                    dx, dy = np.subtract(info['offset'], meta['offset'])
                    x, y, w, h = [v * 2 for v in rect]
                    crop = page[y:y + h, x:x + w]
                    expected = np.zeros((h // 2, w // 2), np.float32)
                    expected[dy:dy + original.shape[0], dx:dx + original.shape[1]] = original[..., 3] / 255
                    expected = cv2.resize(cv2.resize(expected, (w * 2, h * 2), interpolation=cv2.INTER_LINEAR),
                                          (w, h), interpolation=cv2.INTER_AREA)
                    np.testing.assert_allclose(crop[..., 3], expected * 255, atol=0.51)
                    record = metrics['families'][family]['coverage'][stage]
                    self.assertAlmostEqual(record['new_area_1x'], record['original_pixels'], delta=0.05)
                    self.assertGreater(record['soft_edge_pixels'], 0)
                metric = metrics['families'][family]
                self.assertAlmostEqual(metric['original']['L'], metric['new']['L'], delta=0.3)
                self.assertAlmostEqual(metric['original']['C'], metric['new']['C'], delta=0.5)
            self.assertLess(metrics['families']['TIB01']['coverage'][0]['new_area_1x'],
                            metrics['families']['TIB01']['coverage'][11]['new_area_1x'])

    def test_smooth_mode_needs_no_model_and_rounds_pebbles_keeping_area_and_tone(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve()
            extracted, layout, meta, _ = inputs(root)
            out = root / 'smooth'
            metrics = upscale.build(extracted, 'desert', layout, None, out, upscaler='smooth')
            self.assertEqual(metrics['upscaler_mode'], 'smooth')
            self.assertEqual(metrics['native_gate']['clipped_hd_pixels'], 0)
            page = ore.read_image(out / upscale.HD)
            for family, metric in metrics['families'].items():
                for record in metric['coverage']:
                    if record['original_pixels']:
                        # Rounded outlines keep each frame's covered area close to the original's.
                        self.assertGreater(record['new_area_1x'], 0.6 * record['original_pixels'])
                        self.assertLess(record['new_area_1x'], 1.3 * record['original_pixels'])
                self.assertAlmostEqual(metric['original']['L'], metric['new']['L'], delta=1.0)
            # Rounding: a square 1x pixel block has softer corners than its linear upscale.
            sq = np.zeros((6, 6), np.float32); sq[1:5, 1:5] = 1
            lin = cv2.resize(sq, (24, 24), interpolation=cv2.INTER_LINEAR)
            rounded = upscale.round_alpha(lin)
            # Corners are trimmed relative to straight edges at the same depth (round outline), the interior is solid.
            self.assertLess(rounded[4, 4] / rounded[4, 12], lin[4, 4] / lin[4, 12])
            self.assertEqual(rounded[3, 3], 0)
            self.assertGreater(rounded[12, 12], 0.99)
            self.assertTrue(((page[..., 3] > 0) & (page[..., 3] < 255)).any())

    def test_alpha_edges_have_no_dark_fringe_or_cross_family_colour(self):
        with tempfile.TemporaryDirectory() as tmp:
            extracted, _, meta, out, _ = build(Path(tmp).resolve())
            palette = ore.read_image(extracted / 'palette.png')[0]
            page = ore.read_image(out / upscale.HD)
            for family, index in (('TIB01', 20), ('GEM01', 43)):
                for rect in meta['frames'][family]:
                    x, y, w, h = [v * 2 for v in rect]
                    rgba = page[y:y + h, x:x + w]
                    edge = (rgba[..., 3] > 0) & (rgba[..., 3] < 255)
                    self.assertTrue(edge.any())
                    np.testing.assert_allclose(rgba[..., :3][edge], np.broadcast_to(palette[index], (edge.sum(), 3)), atol=2)
                    # Test actual bilinear sampling across the transparent boundary,
                    # where straight RGB black would create a dark outline.
                    rgb = cv2.resize(rgba[..., :3].astype(np.float32), None, fx=1.5, fy=1.5)
                    alpha = cv2.resize(rgba[..., 3].astype(np.float32) / 255, None, fx=1.5, fy=1.5)
                    edge2 = (alpha > 0) & (alpha < 1)
                    for background in ((180, 154, 110), (255, 255, 255)):
                        actual = rgb * alpha[..., None] + np.array(background) * (1 - alpha[..., None])
                        expected = palette[index] * alpha[..., None] + np.array(background) * (1 - alpha[..., None])
                        np.testing.assert_allclose(actual[edge2], expected[edge2], atol=2)

    def test_install_realises_symlink_directories_preserves_base_and_is_idempotent(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve()
            extracted, layout, meta, out, _ = build(root)
            base, target, library, normals = farm(root, extracted, layout, meta)
            before = {str(p.relative_to(base)): p.read_bytes() for p in base.rglob('*') if p.is_file()}
            self.assertEqual(upscale.install(target, 'desert', out), 1)
            directory = target / '_library/desert'
            first = [(directory / name).read_bytes() for name in ('library.json', 'normals.json', *upscale.FILES)]
            self.assertEqual(upscale.install(target, 'desert', out), 1)
            self.assertEqual(first, [(directory / name).read_bytes() for name in ('library.json', 'normals.json', *upscale.FILES)])
            after = {str(p.relative_to(base)): p.read_bytes() for p in base.rglob('*') if p.is_file()}
            self.assertEqual(before, after)
            expected = copy.deepcopy(library)
            expected['spriteAtlasesHd'][1].update(file=upscale.HD, remap=upscale.REMAP)
            self.assertEqual(ore.read_json(directory / 'library.json'), expected)
            material = ore.read_json(directory / 'normals.json')
            self.assertEqual(material['pages']['0'], normals['pages']['0'])
            self.assertEqual(material['pages']['1']['atlas'], upscale.HD)
            self.assertEqual(material['pages']['1']['file'], upscale.NORMALS)
            self.assertEqual(material['pages']['1']['custom'], 7)
            for name in ('library.json', 'normals.json', *upscale.FILES):
                self.assertFalse((directory / name).is_symlink())

    def test_refuses_non_ore_page_and_changed_native_mask_without_publication(self):
        for failure in ('non-ore', 'mask'):
            with self.subTest(failure=failure), tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp).resolve()
                extracted, layout, meta, out, _ = build(root)
                _, target, library, _ = farm(root, extracted, layout, meta)
                directory = target / '_library/desert'
                # Break the base fixture before making the installation snapshot.
                if failure == 'non-ore':
                    library['sprites']['overlay:WALL'] = copy.deepcopy(library['sprites']['overlay:TIB01'])
                    (directory / 'library.json').write_text(json.dumps(library))
                else:
                    save(directory / ore.PAGE, np.zeros((480, 24), np.uint8))
                before = (directory / 'library.json').read_bytes()
                with self.assertRaisesRegex(ValueError, 'non-ore|native ore mask'):
                    upscale.install(target, 'desert', out)
                self.assertEqual((directory / 'library.json').read_bytes(), before)
                self.assertEqual((directory / upscale.HD).read_bytes(), b'base sentinel')

    def test_rejects_unsafe_output_and_overlapping_layout(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve()
            extracted, layout, meta, cmd = inputs(root)
            (root / 'linked').symlink_to(layout, target_is_directory=True)
            for out in (layout, extracted / 'new', root / 'linked/new'):
                with self.assertRaisesRegex(ValueError, 'read-only inputs|symlink'):
                    upscale.build(extracted, 'desert', layout, None, out, esrgan_cmd=cmd)
            meta['frames']['TIB01'][1] = meta['frames']['TIB01'][0]
            with self.assertRaisesRegex(ValueError, 'overlap'):
                upscale.validate_layout(meta)

    def test_reports_native_mask_gating_without_changing_the_native_page(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve()
            extracted, layout, _, cmd = inputs(root)
            mask = ore.read_image(layout / ore.PAGE)
            mask[6:9, :] = 0
            save(layout / ore.PAGE, mask)
            original = (layout / ore.PAGE).read_bytes()
            metrics = upscale.build(extracted, 'desert', layout, None, root / 'build', esrgan_cmd=cmd)
            self.assertGreater(metrics['native_gate']['clipped_hd_pixels'], 0)
            self.assertGreater(metrics['native_gate']['clipped_fraction'], 0)
            self.assertEqual((root / 'build' / ore.PAGE).read_bytes(), original)
            self.assertEqual((layout / ore.PAGE).read_bytes(), original)


if __name__ == '__main__':
    unittest.main()
