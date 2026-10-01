"""Asset-free tests: python3 -B -m unittest discover -s packages/ra2-assets/python -p 'test_ore_fields.py'.

Only synthetic sprites, palettes, atlas pages and temporary caches are used; no game art, model or network.
"""

from __future__ import annotations

import copy
import fcntl
import json
from pathlib import Path
import pickle
import tempfile
import unittest
from unittest import mock

import cv2
import numpy as np
from PIL import Image, ImageFont

import ore_fields as ore


def save(path: Path, pixels: np.ndarray) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray(pixels).save(path)


def sprite(row: int, cls: str, colour: tuple) -> dict:
    rgba = np.zeros((8, 10, 4), np.float32)
    rgba[..., :3] = colour
    rgba[1:7, 1:9, 3] = 1
    height = cv2.distanceTransform((rgba[..., 3] > 0).astype(np.uint8), cv2.DIST_L2, 5) / 3
    metal = np.full(height.shape, 1 if cls == 'gold' else 0, np.float32)
    return dict(rgba=rgba, height=height, metal=metal, row=row, col=0, area=48, cls=cls)


def tiny_inputs(root: Path) -> dict:
    directory = root / 'cache/_library/test'
    palette = np.zeros((1, 256, 3), np.uint8)
    palette[0, 42:48] = [(205, 175, 42), (210, 30, 40), (30, 190, 40),
                          (25, 40, 220), (220, 220, 220), (94, 67, 41)]
    page = np.zeros((24, 16 * ore.FRAMES), np.uint8)
    sprites, overlays = {}, {}
    for family, y in (('TIB01', 0), ('GEM01', 12)):
        frames = []
        for stage in range(ore.FRAMES):
            x = stage * 16
            patch = page[y:y + 12, x:x + 16]
            if family == 'TIB01':
                cv2.ellipse(patch, (8, 6), (5, 3), 0, 0, 360, 42, -1)
            else:
                for colour, (cx, cy) in zip(range(43, 47), ((4, 3), (10, 3), (4, 8), (10, 8))):
                    patch[cy:cy + 2, cx:cx + 2] = colour
            # Identical stage silhouettes isolate the soil grow factor from changing nugget layouts.
            frames.append({'rect': [x, y, 16, 12], 'offset': [-8, 8], 'page': 0, 'custom': stage})
        key = 'overlay:' + family
        sprites[key] = {'canvas': [60, 60], 'palette': 'theater', 'frames': frames, 'shadows': [], 'custom': True}
        overlays[family] = {'sprite': key, 'custom': {'policy': 'preserved'}}
    library = {'version': 1, 'spriteAtlases': [{'file': 'original.png', 'width': 192, 'height': 24}],
               'spriteAtlasesHd': [{'file': 'original@2x.png', 'scale': 2}],
               'palettes': {'theater': 'palette.png'}, 'sprites': sprites, 'overlays': overlays,
               'unrelated': {'terrain': [1, 2, 3]}}
    save(directory / 'original.png', page)
    save(directory / 'palette.png', palette)
    rgba = np.dstack([palette[0, page], (page > 0).astype(np.uint8) * 255])
    save(directory / 'original@2x.png', np.repeat(np.repeat(rgba, 2, 0), 2, 1))
    (directory / 'library.json').write_text(json.dumps(library))
    gold = [sprite(row, 'gold', (0.8, 0.6, 0.12)) for row in range(6)]
    gems = [sprite(2, cls, colour) for cls, colour in
            (('red', (0.9, 0.1, 0.15)), ('green', (0.1, 0.8, 0.1)),
             ('blue', (0.1, 0.2, 0.9)), ('white', (0.85, 0.85, 0.85)))]
    for name, records in (('gold', gold), ('gem', gems)):
        ore.save_sprite_library(records, root / f'{name}.npz')
    save(root / 'soil.png', np.full((12, 14, 3), (100, 75, 50), np.uint8))
    return {'root': root / 'cache', 'directory': directory, 'library': library,
            'gold': root / 'gold.npz', 'gem': root / 'gem.npz', 'soil': root / 'soil.png'}


def build_args(inputs: dict, out: Path) -> list[str]:
    return ['build', '--library-root', str(inputs['root']), '--theatre', 'test', '--gold', str(inputs['gold']),
            '--gem', str(inputs['gem']), '--soil', str(inputs['soil']), '--out', str(out),
            '--families', 'TIB01', 'GEM01', '--page-width', '256']


class OreFieldsTests(unittest.TestCase):
    def test_numeric_library_round_trip_and_legacy_suffix_boundary(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            records = [sprite(0, 'gold', (0.7, 0.4, 0.1)), sprite(3, 'blue', (0.1, 0.3, 0.8))]
            records[1]['rgba'] = records[1]['rgba'][:, :7].astype(np.float64)
            records[1]['height'] = records[1]['height'][:, :7]
            records[1]['metal'] = records[1]['metal'][:, :7]
            archive = root / 'sprites.npz'
            ore.save_sprite_library(records, archive)
            with np.load(archive, allow_pickle=False) as arrays:
                self.assertTrue(all(arrays[name].dtype.kind == 'f' for name in arrays.files))
            with mock.patch.object(ore.pickle, 'load', side_effect=AssertionError('unexpected pickle load')):
                loaded = ore.load_sprite_library(archive)
                renamed = root / 'sprites.bin'
                renamed.write_bytes(pickle.dumps(records))
                with self.assertRaisesRegex(ValueError, 'must end'):
                    ore.load_sprite_library(renamed)
            legacy = root / 'sprites.pkl'
            legacy.write_bytes(pickle.dumps(records))
            for recovered in (loaded, ore.load_sprite_library(legacy)):
                for original, result in zip(records, recovered):
                    self.assertEqual(original.keys(), result.keys())
                    for key in ore.ARRAY_FIELDS:
                        self.assertEqual(original[key].dtype, result[key].dtype)
                        np.testing.assert_array_equal(original[key], result[key])
                    self.assertEqual(result['cls'], original['cls'])
            # A crafted object array must never make the safe loader execute pickle.
            with archive.open('wb') as stream:
                np.savez_compressed(stream, s0_rgba=np.array([{'unsafe': True}], dtype=object))
            with self.assertRaisesRegex(ValueError, 'Object arrays'):
                ore.load_sprite_library(archive)

    def test_extract_cli_uses_grey_sheet_and_writes_numeric_arrays(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            image = np.full((64, 96, 3), 118, np.uint8)
            cv2.circle(image, (24, 32), 12, (220, 160, 25), -1)
            cv2.circle(image, (72, 32), 12, (25, 55, 210), -1)
            save(root / 'sheet.png', image)
            before = (root / 'sheet.png').read_bytes()
            for kind in ('gold', 'gem'):
                out = root / f'{kind}.npz'
                self.assertEqual(ore.main(['extract', '--sheet', str(root / 'sheet.png'), '--kind', kind,
                                           '--out', str(out), '--rows', '1', '--cols', '2', '--min-area', '100']), 0)
                records = ore.load_sprite_library(out)
                self.assertEqual([(s['row'], s['col']) for s in records], [(0, 0), (0, 1)])
                self.assertTrue(all(s['height'].max() > 0.5 for s in records))
                if kind == 'gem':
                    self.assertEqual(records[1]['cls'], 'blue')
                    self.assertTrue(all(not s['metal'].any() for s in records))
                else:
                    self.assertGreater(records[0]['metal'].max(), 0.9)
                self.assertTrue(((records[0]['rgba'][..., 3] > 0) & (records[0]['rgba'][..., 3] < 1)).any())
            self.assertEqual((root / 'sheet.png').read_bytes(), before)

    def test_gold_gain_knee_is_monotonic_with_subwhite_highlights(self):
        luminance = np.linspace(0, 1, 1001, dtype=np.float32)
        result = ore.gold_curve(luminance)
        self.assertTrue((np.diff(result) > 0).all())
        self.assertEqual(result[0], 0)
        self.assertLess(result[-1], 1)
        self.assertLess(result[-1], 0.9)
        np.testing.assert_allclose(result[luminance <= 0.8], luminance[luminance <= 0.8] * 0.9)
        np.testing.assert_array_equal(ore.gold_curve(luminance, 1, 1), luminance)

    def test_keep_inside_contains_the_lower_nugget_points(self):
        dcx, dcy = (ore.PAD + 30) * ore.S, (ore.PAD + 45) * ore.S
        for dx, dy, width in ((22, 5, 9), (-22, 5, 9), (10, 12, 12), (0, 0, 60)):
            with self.subTest(dx=dx, dy=dy, width=width):
                cx, cy, w = ore.ExtComposer.keep_inside(dcx + dx * ore.S, dcy + dy * ore.S, width * ore.S)
                points = ((cx, cy + 0.36 * w), (cx - 0.48 * w, cy + 0.08 * w),
                          (cx + 0.48 * w, cy + 0.08 * w))
                for x, y in points:
                    self.assertLessEqual(abs(x - dcx) / (30 * ore.S) + abs(y - dcy) / (15 * ore.S), 0.9)

    def test_soil_stage_zero_is_smaller_and_fainter_than_stage_eleven(self):
        with tempfile.TemporaryDirectory() as temporary:
            inputs = tiny_inputs(Path(temporary))
            overlays = ore.OverlayLibrary(inputs['root'], 'test')
            comp = ore.ExtComposer(ore.Library(inputs['gold'], inputs['gem'], inputs['soil']), overlays)
            young = comp.compose_ext('TIB01', 0)
            mature = comp.compose_ext('TIB01', 11)
            a0, a11 = young['rgba2'][..., 3], mature['rgba2'][..., 3]
            self.assertLess(np.count_nonzero(a0 > 0.02), np.count_nonzero(a11 > 0.02))
            self.assertLess(a0.sum(), a11.sum())
            # Dielectric soil texels exclude the metallic nugget and compare identical ground positions.
            soil = (mature['mat2'][..., 2] < 0.1) & (a11 > 0.2)
            self.assertGreater(soil.sum(), 100)
            self.assertLess(a0[soil].mean(), a11[soil].mean())

    def test_build_rects_gutters_and_indexed_mask_cover_all_visible_hd_texels(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            inputs, out = tiny_inputs(root), root / 'build'
            originals = {p: p.read_bytes() for p in inputs['directory'].iterdir()}
            # An obsolete environment variable must not act as an undocumented configuration input.
            with mock.patch.dict('os.environ', {'ORE_PARAMS': 'invalid JSON'}):
                self.assertEqual(ore.main(build_args(inputs, out)), 0)
            legacy_mask = ore.read_image(out / ore.PAGE)
            legacy_pngs = {name: (out / name).read_bytes() for name in (ore.HD, ore.REMAP, ore.MAT)}
            legacy_meta = ore.read_json(out / 'frames.json')
            legacy_alpha = ore.read_image(out / ore.HD)[..., 3]
            legacy_covered = np.repeat(np.repeat(legacy_mask > 0, 2, 0), 2, 1)
            self.assertTrue(((legacy_alpha > 0) & ~legacy_covered).any())
            # Strict coverage is explicit because the scratch reference itself has uncovered faint tails.
            self.assertEqual(ore.main(build_args(inputs, out) + ['--strict-mask-coverage']), 0)
            self.assertEqual(ore.read_json(out / 'frames.json'), legacy_meta)
            for name, content in legacy_pngs.items():
                self.assertEqual((out / name).read_bytes(), content)
            meta = ore.read_json(out / 'frames.json')
            self.assertEqual(meta['offset'], [-34, -12])
            self.assertEqual(meta['size'], [68, 46])
            self.assertEqual(list(meta['frames']), ['TIB01', 'GEM01'])
            rects = [rect for frames in meta['frames'].values() for rect in frames]
            self.assertEqual(len(rects), 24)
            indexed, colour = ore.read_image(out / ore.PAGE), ore.read_image(out / ore.HD)
            np.testing.assert_array_equal(indexed[legacy_mask > 0], legacy_mask[legacy_mask > 0])
            self.assertTrue((indexed[(legacy_mask == 0) & (indexed > 0)] == meta['soilIndex']).all())
            covered = np.repeat(np.repeat(indexed > 0, 2, 0), 2, 1)
            self.assertGreater(np.count_nonzero(colour[..., 3]), 0)
            self.assertTrue(covered[colour[..., 3] > 0].all())
            self.assertFalse(ore.read_image(out / ore.REMAP).any())
            materials = ore.read_image(out / ore.MAT)
            self.assertTrue((materials[colour[..., 3] > 1, 3] > 0).all())
            for i, (x, y, w, h) in enumerate(rects):
                self.assertEqual((w, h), (68, 46))
                self.assertTrue(0 < x < x + w < meta['width'] and 0 < y < y + h < meta['height'])
                self.assertFalse(indexed[y - 1:y + h + 1, x - 1].any())
                self.assertFalse(indexed[y - 1, x - 1:x + w + 1].any())
                for bx, by, bw, bh in rects[i + 1:]:
                    self.assertTrue(x + w < bx or bx + bw < x or y + h < by or by + bh < y)
            for path, data in originals.items():
                self.assertEqual(path.read_bytes(), data)

    def test_install_preserves_other_keys_reuses_page_and_never_writes_through_symlinks(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            inputs, out = tiny_inputs(root), root / 'build'
            self.assertEqual(ore.main(build_args(inputs, out)), 0)
            base = inputs['directory']
            lib = copy.deepcopy(inputs['library'])
            for name in ('TIB2_01', 'TIB3_01'):
                lib['sprites']['overlay:' + name] = copy.deepcopy(lib['sprites']['overlay:TIB01'])
            lib['sprites']['overlay:TIB01']['frames'].append({'extra-stage': True})
            untouched = {'frames': [{'rect': [1, 2, 3, 4], 'offset': [0, 0]}], 'custom': {'keep': True}}
            for key in ('tree:TREE01', 'overlay:WALL01', 'overlay:TIB21', 'overlay:GEM13'):
                lib['sprites'][key] = copy.deepcopy(untouched)
            lib['spriteAtlases'].append({'file': 'other.png', 'width': 1, 'height': 1, 'custom': True})
            lib['spriteAtlasesHd'].append({'file': 'other@2x.png', 'custom': {'keep': True}})
            normals = {'version': 7, 'custom': {'keep': True}, 'pages': {'0': {'file': 'original-normal.png'},
                       '1': {'file': 'other-normal.png'}, '9': {'unrelated': True}}}
            (base / 'library.json').write_text(json.dumps(lib))
            (base / 'normals.json').write_text(json.dumps(normals))
            for name in ore.PAGE_FILES:
                save(base / name, np.full((2, 2), 12, np.uint8))
            before = {path.name: path.read_bytes() for path in base.iterdir()}
            variant = root / 'variant/_library/test'
            variant.mkdir(parents=True)
            for path in base.iterdir():
                (variant / path.name).symlink_to(path)
            real_copy = ore.copy_atomic
            copies = []

            def locked_copy(src, dst):
                # A separate descriptor must be denied an exclusive lock during every page mutation.
                with (variant / '.compose.lock').open('a+') as competing:
                    with self.assertRaises(BlockingIOError):
                        fcntl.flock(competing, fcntl.LOCK_EX | fcntl.LOCK_NB)
                copies.append(dst.name)
                real_copy(src, dst)

            args = ['install', '--build-dir', str(out), '--cache-root', str(root / 'variant'), '--theatre', 'test']
            with mock.patch.object(ore, 'copy_atomic', side_effect=locked_copy):
                self.assertEqual(ore.main(args), 0)
            self.assertEqual(copies, list(ore.PAGE_FILES))
            installed = ore.read_json(variant / 'library.json')
            page = next(i for i, atlas in enumerate(installed['spriteAtlases']) if atlas['file'] == ore.PAGE)
            self.assertEqual(page, 2)
            expected = copy.deepcopy(lib)
            expected['spriteAtlases'].append(installed['spriteAtlases'][page])
            expected['spriteAtlasesHd'].append(installed['spriteAtlasesHd'][page])
            meta = ore.read_json(out / 'frames.json')
            for key in ('overlay:TIB01', 'overlay:TIB2_01', 'overlay:TIB3_01', 'overlay:GEM01'):
                family = 'GEM01' if key.endswith('GEM01') else 'TIB01'
                for k, rect in enumerate(meta['frames'][family]):
                    expected['sprites'][key]['frames'][k].update(rect=rect, offset=meta['offset'], page=page)
            self.assertEqual(installed, expected)
            installed_normals = ore.read_json(variant / 'normals.json')
            expected_normals = copy.deepcopy(normals)
            expected_normals['pages'][str(page)] = installed_normals['pages'][str(page)]
            self.assertEqual(installed_normals, expected_normals)
            self.assertEqual(ore.install(out, root / 'variant', 'test'), page)
            self.assertEqual(ore.read_json(variant / 'library.json'), installed)
            self.assertEqual(ore.read_json(variant / 'normals.json'), installed_normals)
            for name in (*ore.PAGE_FILES, 'library.json', 'normals.json'):
                self.assertFalse((variant / name).is_symlink())
            for name, data in before.items():
                self.assertEqual((base / name).read_bytes(), data)
            self.assertTrue((variant / 'original.png').is_symlink())

    def test_contact_bed_is_faint_and_only_near_objects(self):
        # L5F: the soil may only form a faint halo under nuggets/gems (alpha <= bed alpha), so terrain shows between
        # them and no cell-shaped carpet edge exists; the L5 carpet stays reproducible with bed=None.
        with tempfile.TemporaryDirectory() as temporary:
            inputs = tiny_inputs(Path(temporary))
            overlays = ore.OverlayLibrary(inputs['root'], 'test')
            lib = lambda: ore.Library(inputs['gold'], inputs['gem'], inputs['soil'])
            contact = ore.ExtComposer(lib(), overlays, bed=ore.BED_L5F).compose_ext('TIB01', 11)
            carpet = ore.ExtComposer(lib(), overlays).compose_ext('TIB01', 11)
            for result in (contact, carpet):
                self.assertEqual(result['rgba2'].shape[:2], (ore.EXT_H * ore.OUT, ore.EXT_W * ore.OUT))
            ground_c = contact['mat2'][..., 2] < 0.1  # dielectric ground texels (soil or shadow), not the metal nugget
            ground_v = carpet['mat2'][..., 2] < 0.1
            a_c, a_v = contact['rgba2'][..., 3], carpet['rgba2'][..., 3]
            # Bed + contact shadow: never the near-opaque carpet, and far less ground coverage.
            self.assertLess(np.count_nonzero(ground_c & (a_c > 0.05)), 0.5 * np.count_nonzero(ground_v & (a_v > 0.05)))
            self.assertLess(np.percentile(a_c[ground_c & (a_c > 0.02)], 50), np.percentile(a_v[ground_v & (a_v > 0.02)], 50))
            gem = ore.ExtComposer(lib(), overlays, bed=ore.BED_L5F).compose_ext('GEM01', 11)
            self.assertGreater(np.count_nonzero(gem['rgba2'][..., 3] > 0.02), 0)

    def test_gem_saturation_and_pastel_lift(self):
        with tempfile.TemporaryDirectory() as temporary:
            inputs = tiny_inputs(Path(temporary))
            overlays = ore.OverlayLibrary(inputs['root'], 'test')
            base = ore.Library(inputs['gold'], inputs['gem'], inputs['soil'])
            soft = ore.Library(inputs['gold'], inputs['gem'], inputs['soil'])
            ore.ExtComposer(base, overlays, gem_sat=1.0, gem_pastel=0.0)
            ore.ExtComposer(soft, overlays, gem_sat=0.6, gem_pastel=0.2)

            def chroma(sprites):
                rgb = np.concatenate([s['rgba'][..., :3][s['rgba'][..., 3] > 0.5] for s in sprites])
                return float((rgb.max(1) - rgb.min(1)).mean()), float(rgb.mean())
            (c0, v0), (c1, v1) = chroma(base.gem), chroma(soft.gem)
            self.assertLess(c1, 0.75 * c0)
            self.assertGreater(v1, v0)

    def test_cli_approved_defaults_and_individual_overrides(self):
        args = ['build', '--library-root', 'cache', '--theatre', 'test', '--gold', 'gold.pkl',
                '--gem', 'gem.npz', '--soil', 'soil.png', '--out', 'build']
        parser = ore.build_parser()
        defaults = parser.parse_args(args)
        self.assertEqual(defaults.soil_target, [0.46, 0.325, 0.19])
        np.testing.assert_array_equal(np.array(defaults.soil_target, np.float32), ore.SOIL_TARGET)
        expected = {'soil_contrast': 0.7, 'gold_sat': 0.85, 'gold_gamma': 1.2,
                    'gold_scale': 1.16, 'clarity': 0.2, 'gold_gain': 0.95, 'gold_knee': 0.84,
                    'gem_scale': 1.25, 'gem_gamma': 0.78}
        for key, value in expected.items():
            self.assertEqual(getattr(defaults, key), value)
            changed = parser.parse_args(args + ['--' + key.replace('_', '-'), '0.6'])
            self.assertEqual(getattr(changed, key), 0.6)
        changed = parser.parse_args(args + ['--soil-target', '0.4', '0.3', '0.2'])
        self.assertEqual(changed.soil_target, [0.4, 0.3, 0.2])
        self.assertEqual(tuple(defaults.families), ore.FAMILIES)
        self.assertFalse(defaults.strict_mask_coverage)
        self.assertEqual(defaults.bed, 'contact')
        self.assertEqual(defaults.bed_alpha, ore.BED_L5F['alpha'])
        self.assertLessEqual(defaults.bed_alpha, 0.25)
        self.assertEqual((defaults.gem_sat, defaults.gem_pastel), (ore.GEM_SAT_L5F, ore.GEM_PASTEL_L5F))
        self.assertEqual(parser.parse_args(args + ['--bed', 'carpet']).bed, 'carpet')
        self.assertTrue(parser.parse_args(args + ['--strict-mask-coverage']).strict_mask_coverage)

    def test_sheet_cli_writes_comparisons_with_explicit_map_and_font(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            inputs, build = tiny_inputs(root), root / 'build'
            self.assertEqual(ore.main(build_args(inputs, build)), 0)
            map_dir = inputs['root'] / 'TinyMap'
            map_dir.mkdir()
            (map_dir / 'manifest.json').write_text(json.dumps({'sprites': inputs['library']['sprites']}))
            save(map_dir / 'sprites@2x.png', ore.read_image(inputs['directory'] / 'original@2x.png'))
            out = root / 'sheets'
            # Font rasterization is platform-specific; all atlas/tile composition still executes normally.
            font = ImageFont.load_default()
            with mock.patch.object(ore.ImageFont, 'truetype', return_value=font):
                self.assertEqual(ore.main(['sheet', '--build-dir', str(build), '--library-root', str(inputs['root']),
                                          '--theatre', 'test', '--cache-root', str(inputs['root']), '--map', 'TinyMap',
                                          '--font', 'synthetic-font.ttf', '--out', str(out)]), 0)
            for name in ('stages_TIB01_GEM01', 'variants_stage11', 'variants_stage5'):
                with Image.open(out / f'{name}.png') as image:
                    self.assertEqual(image.mode, 'RGB')
                    self.assertGreater(image.width, 1000)
                self.assertTrue((out / f'{name}_s.jpg').is_file())


if __name__ == '__main__':
    unittest.main()
