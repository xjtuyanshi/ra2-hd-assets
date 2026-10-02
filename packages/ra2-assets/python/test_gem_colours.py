"""Asset-free gem colour tests; all palettes, frames and symlink farms are synthetic."""

from __future__ import annotations

import contextlib
import copy
import fcntl
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock

import cv2
import numpy as np
from PIL import Image

import gem_colours as gems
from ore_fields import OverlayLibrary, read_image

PASTELS = ((230, 150, 160), (150, 220, 170), (150, 170, 235))
DEEP = (((170, 20, 20), (255, 120, 120)),
        ((20, 140, 30), (140, 255, 140)),
        ((20, 30, 170), (120, 140, 255)))
GLINT = (11, 12)


def reference_samples():
    return {family: np.rint(np.linspace(lo, hi, 64)).astype(np.uint8)
            for family, (lo, hi) in enumerate(DEEP)}


def pastel_frame(family):
    rgba = np.full((24, 24, 4), (17, 27, 37, 0), np.uint8)
    gradient = np.linspace(0.63, 1.07, 18 * 18).reshape(18, 18, 1)
    rgba[3:21, 3:21, :3] = np.rint(np.array(PASTELS[family]) * gradient).astype(np.uint8)
    rgba[3:21, 3:21, 3] = 255
    rgba[GLINT] = (255, 255, 255, 255)
    rgba[14, 14] = (60, 60, 60, 255)  # A dark neutral facet must not become a highlight.
    rgba[22:, :, :] = (60, 60, 60, 120)
    rgba[0, 0] = (255, 255, 255, 255)  # Isolated white pixels have no family vote.
    return rgba


def ranks(values):
    _, inverse, counts = np.unique(values, return_inverse=True, return_counts=True)
    return (np.cumsum(counts) - (counts + 1) / 2)[inverse]


def spearman(before, after):
    return float(np.corrcoef(ranks(before), ranks(after))[0, 1])


def mean_hue(rgb):
    hue = gems._hsv(rgb)[..., 0]
    angle = np.deg2rad(hue)
    return float(np.rad2deg(np.arctan2(np.sin(angle).mean(), np.cos(angle).mean())) % 360)


def fake_farm(root):
    source = root / 'src/_library/urban'
    source.mkdir(parents=True)
    palette = np.zeros((1, 256, 3), np.uint8)
    indexed = np.zeros((12, 48), np.uint8)
    hd = np.empty((24, 96, 4), np.uint8)
    sprites = {}
    for family, samples in reference_samples().items():
        palette[0, 1 + 64 * family:1 + 64 * (family + 1)] = samples
        indexed[1:11, 12 * family + 1:12 * family + 11] = (
            1 + 64 * family + np.arange(100).reshape(10, 10) % 64)
        hd[:, 24 * family:24 * (family + 1)] = pastel_frame(family)
    # Several sprites and frames reuse each rect, as atlas deduplication does.
    for i, name in enumerate(gems.GEMS):
        frame = {'page': 0, 'rect': [12 * (i % 3), 0, 12, 12], 'offset': [-6, 0]}
        sprites[name] = {'frames': [frame, copy.deepcopy(frame)], 'palette': 'theater'}
    sprites['overlay:TIB01'] = {'frames': [{'page': 0, 'rect': [36, 0, 12, 12]}]}
    palette[0, 193] = (225, 185, 45)
    indexed[:, 36:] = 193
    rng = np.random.default_rng(42)
    hd[:, 72:] = rng.integers(0, 256, (24, 24, 4), dtype=np.uint8)
    library = {'palettes': {'theater': 'palette.png'}, 'sprites': sprites,
               'spriteAtlases': [{'file': 'original.png', 'width': 48, 'height': 12}],
               'spriteAtlasesHd': [{'file': 'redraw@2x.png', 'remap': 'remap.png', 'scale': 2,
                                    'width': 96, 'height': 24, 'custom': {'keep': True}}],
               'other': {'unchanged': [1, 2, 3]}}
    Image.fromarray(palette).save(source / 'palette.png')
    indexed_image = Image.fromarray(indexed).convert('P')
    indexed_image.putpalette(palette.reshape(-1).tolist())
    indexed_image.save(source / 'original.png')
    Image.fromarray(hd).save(source / 'redraw@2x.png')
    Image.fromarray(np.zeros_like(hd)).save(source / 'remap.png')
    (source / 'library.json').write_text(json.dumps(library), encoding='utf-8')
    normals = {'version': 1, 'pages': {'0': {'file': 'materials@2x.png', 'atlas': 'redraw@2x.png', 'width': 96,
                                             'height': 24, 'scale': 2, 'materialWidth': 96, 'materialHeight': 24,
                                             'frames': 4}}}
    (source / 'normals.json').write_text(json.dumps(normals), encoding='utf-8')
    farm = root / 'farm'
    directory = farm / '_library/urban'
    directory.mkdir(parents=True)
    for path in source.iterdir():
        (directory / path.name).symlink_to(path)
    return source, farm, directory, library, hd


class GemColoursTests(unittest.TestCase):
    def test_families_known_colours_and_visibility(self):
        rgb = np.array([[(255, 0, 0), (0, 255, 0), (0, 0, 255), *PASTELS,
                         (120, 120, 120), (255, 0, 0), (255, 255, 0), (0, 0, 255)]], np.uint8)
        alpha = np.array([[255] * 7 + [0, 255, 127]], np.uint8)
        expected = [[0, 1, 2, 0, 1, 2, -1, -1, -1, -1]]
        np.testing.assert_array_equal(gems.families(rgb, alpha), expected)
        np.testing.assert_array_equal(gems.families(rgb.astype(np.float32) / 255,
                                                  alpha.astype(np.float32) / 255), expected)
        hsv = np.array([[[20, 0.11, 1], [60, 1, 1], [185, 1, 1], [300, 1, 1],
                         [325, 1, 1], [175, 1, 1], [285, 1, 1]]], np.float32)
        rgb = cv2.cvtColor(hsv, cv2.COLOR_HSV2RGB)
        np.testing.assert_array_equal(gems.families(rgb, np.ones((1, 7))), [[-1, -1, -1, -1, 0, 1, 2]])
        self.assertEqual(gems.families(rgb, np.full((1, 7), 0.5)).max(), -1)

    def test_deepen_chroma_hue_facets_alpha_and_glints(self):
        samples = reference_samples()
        ramps = gems._ramps(samples)
        frames = [pastel_frame(family) for family in range(3)]
        cdfs = gems.luminance_cdfs(frames)
        for family, before in enumerate(frames):
            with self.subTest(family=family):
                untouched = before.copy()
                labels = gems.gem_families(before)
                self.assertEqual(labels[GLINT], family)
                self.assertEqual(labels[14, 14], -1)
                self.assertEqual(labels[0, 0], -1)
                mask = labels == family
                after = gems.deepen(before, ramps, hd_cdfs=cdfs)
                before_stats = gems._stats(before[..., :3][mask])
                after_stats = gems._stats(after[..., :3][mask])
                self.assertGreaterEqual(after_stats['mean_C_star'], before_stats['mean_C_star'] * 1.3)
                difference = abs((mean_hue(after[..., :3][mask]) - mean_hue(samples[family]) + 180) % 360 - 180)
                self.assertLessEqual(difference, 20)
                self.assertGreaterEqual(spearman(before[..., :3][mask] @ gems.LUMA,
                                                 after[..., :3][mask] @ gems.LUMA), 0.95)
                np.testing.assert_array_equal(before, untouched)
                np.testing.assert_array_equal(after[..., 3], before[..., 3])
                np.testing.assert_array_equal(after[labels == -1], before[labels == -1])
                np.testing.assert_array_equal(after[before[..., 3] <= 127], before[before[..., 3] <= 127])
                self.assertEqual(gems.families(after[..., :3], after[..., 3])[GLINT], family)
                np.testing.assert_array_equal(gems.deepen(before, ramps, strength=0), before)
                half = gems.deepen(before, ramps, strength=0.5, hd_cdfs=cdfs)
                np.testing.assert_allclose(half[..., :3][mask],
                                           (before[..., :3][mask].astype(float) + after[..., :3][mask]) / 2,
                                           atol=1)

    def test_page_cdf_keeps_different_frames_on_one_luminance_scale(self):
        ramps = gems._ramps(reference_samples())
        rgba = np.zeros((10, 60, 4), np.uint8)
        rgba[..., :3] = np.rint(np.array(PASTELS[0]) * np.linspace(0.5, 1.05, 60)[None, :, None])
        rgba[..., 3] = 255
        dark, bright = rgba[:, :30], rgba[:, 30:]
        cdfs = gems.luminance_cdfs([dark, bright])
        together = gems.deepen(rgba, ramps, hd_cdfs=cdfs)
        separate = np.concatenate([gems.deepen(crop, ramps, hd_cdfs=cdfs) for crop in (dark, bright)], axis=1)
        np.testing.assert_array_equal(together, separate)
        self.assertLess((separate[:, 29, :3] @ gems.LUMA).mean(),
                        (separate[:, 30, :3] @ gems.LUMA).mean())
        self.assertFalse(np.array_equal(gems.deepen(dark, ramps), separate[:, :30]))

    def test_reference_ramps_use_palette_nonzero_indices_and_stricter_saturation(self):
        with tempfile.TemporaryDirectory() as temporary:
            source, farm, _, _, _ = fake_farm(Path(temporary))
            palette = read_image(source / 'palette.png', 'RGB')
            palette[0, 0] = (255, 0, 0)  # Transparent index zero must never enter the reference.
            palette[0, 250] = (230, 200, 205)  # Family red, but below reference saturation.
            Image.fromarray(palette).save(source / 'palette.png')
            indexed = read_image(source / 'original.png')
            indexed[0, 0] = 250
            Image.fromarray(indexed).save(source / 'original.png')
            lib = OverlayLibrary(farm, 'urban')
            actual = gems.reference_ramps(lib, 0)
            collected = gems._original_colours(lib, 0, gems.GEMS)
            for family, (colours, light) in actual.items():
                self.assertEqual(colours.shape, (64, 3))
                self.assertEqual(light.shape, (64,))
                self.assertEqual(len(collected[family]), 800)
                self.assertTrue((np.diff(light) >= 0).all())
                self.assertTrue((np.diff(colours @ gems.LUMA) >= 0).all())
                ordered = collected[family][np.argsort(collected[family] @ gems.LUMA, kind='stable')]
                edges = np.floor(np.arange(65) * len(ordered) / 64).astype(int)
                np.testing.assert_allclose(colours, [ordered[lo:hi].mean(axis=0)
                                                     for lo, hi in zip(edges[:-1], edges[1:])])
                np.testing.assert_allclose(light, np.quantile(ordered @ gems.LUMA, gems.QUANTILES))

    def test_apply_copy_on_write_non_gems_lock_and_idempotence(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source, farm, directory, library, before = fake_farm(root)
            stage = root / 'stage'
            source_bytes = {path.name: path.read_bytes() for path in source.iterdir()}
            install_file, patch_json = gems.cache_farm.install_file, gems.cache_farm.patch_json

            def locked_call(fn, *args):
                with (directory / '.compose.lock').open('r') as lock:
                    with self.assertRaises(BlockingIOError):
                        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                return fn(*args)

            with mock.patch.object(gems.cache_farm, 'install_file', side_effect=lambda *a: locked_call(install_file, *a)), \
                    mock.patch.object(gems.cache_farm, 'patch_json', side_effect=lambda *a: locked_call(patch_json, *a)), \
                    contextlib.redirect_stdout(io.StringIO()) as stdout:
                metrics = gems.apply_page(farm, 'urban', stage_dir=stage)
            self.assertEqual(json.loads(stdout.getvalue()), metrics)
            installed_library = json.loads((directory / 'library.json').read_text())
            expected_library = copy.deepcopy(library)
            expected_library['spriteAtlasesHd'][0]['file'] = 'redraw@2x-l5hgem.png'
            self.assertEqual(installed_library, expected_library)
            self.assertFalse((directory / 'library.json').is_symlink())
            # The material page follows the renamed HD atlas (the renderer drops a page bound to another file).
            installed_normals = json.loads((directory / 'normals.json').read_text())
            self.assertEqual(installed_normals['pages']['0']['atlas'], 'redraw@2x-l5hgem.png')
            self.assertEqual(installed_normals['pages']['0']['file'], 'materials@2x.png')
            installed = directory / 'redraw@2x-l5hgem.png'
            self.assertFalse(installed.is_symlink())
            after = read_image(installed, 'RGBA')
            np.testing.assert_array_equal(after[:, 72:], before[:, 72:])
            np.testing.assert_array_equal(after[..., 3], before[..., 3])
            for family, name in enumerate(gems.FAMILY_NAMES):
                crop = np.s_[:, 24 * family:24 * (family + 1)]
                labels = gems.gem_families(before[crop])
                self.assertFalse(np.array_equal(after[crop], before[crop]))
                np.testing.assert_array_equal(after[crop][labels == -1], before[crop][labels == -1])
                self.assertEqual(metrics['families'][name]['original_1x']['texel_count'], 800)
                self.assertEqual(metrics['families'][name]['hd_before']['texel_count'], 323)
                self.assertEqual(metrics['families'][name]['hd_after']['texel_count'], 323)
            self.assertEqual(json.loads((stage / 'l5hgem-source.json').read_text())['file'], 'redraw@2x.png')
            first_bytes = installed.read_bytes()
            with contextlib.redirect_stdout(io.StringIO()):
                repeated = gems.apply_page(farm, 'urban', stage_dir=stage)
            self.assertEqual(installed.read_bytes(), first_bytes)
            self.assertEqual(repeated, metrics)
            self.assertFalse((stage / 'redraw@2x-l5hgem-l5hgem.png').exists())
            self.assertEqual({path.name: path.read_bytes() for path in source.iterdir()}, source_bytes)
            self.assertTrue((directory / 'remap.png').is_symlink())

    def test_directory_symlink_farm_and_inherited_lock_leave_source_unchanged(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source, farm, directory, _, _ = fake_farm(root)
            (source / '.compose.lock').write_bytes(b'original lock inode')
            before = {path.name: path.read_bytes() for path in source.iterdir()}
            for path in directory.iterdir():
                path.unlink()
            directory.rmdir()
            directory.symlink_to(source, target_is_directory=True)
            with contextlib.redirect_stdout(io.StringIO()):
                gems.apply_page(farm, 'urban', stage_dir=root / 'stage')
            self.assertFalse(directory.is_symlink())
            self.assertFalse((directory / 'library.json').is_symlink())
            self.assertTrue((directory / '.compose.lock').is_symlink())
            self.assertEqual({path.name: path.read_bytes() for path in source.iterdir()}, before)

    def test_metrics_cli_has_no_writes_and_apply_cli_outputs_only_json(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source, farm, directory, _, _ = fake_farm(root)
            stage = root / 'uncreated-stage'
            args = ['--cache-root', str(farm), '--theatre', 'urban', '--stage', str(stage),
                    '--strength', '0.8', '--suffix', 'testgem', '--sprites', ','.join(gems.GEMS[:3])]
            before = {path.name: path.read_bytes() for path in source.iterdir()}
            with contextlib.redirect_stdout(io.StringIO()) as stdout:
                self.assertEqual(gems.main(['metrics', *args]), 0)
            proposed = json.loads(stdout.getvalue())
            self.assertFalse(stage.exists())
            self.assertTrue(all(path.is_symlink() for path in directory.iterdir()))
            with contextlib.redirect_stdout(io.StringIO()) as stdout:
                self.assertEqual(gems.main(['apply', *args]), 0)
            self.assertEqual(json.loads(stdout.getvalue()), proposed)
            farm_bytes = {path.name: path.read_bytes() for path in directory.iterdir()}
            stage_bytes = {path.name: path.read_bytes() for path in stage.iterdir()}
            with contextlib.redirect_stdout(io.StringIO()) as stdout:
                self.assertEqual(gems.main(['metrics', *args]), 0)
            self.assertEqual(json.loads(stdout.getvalue()), proposed)
            self.assertEqual({path.name: path.read_bytes() for path in source.iterdir()}, before)
            self.assertEqual({path.name: path.read_bytes() for path in directory.iterdir()}, farm_bytes)
            self.assertEqual({path.name: path.read_bytes() for path in stage.iterdir()}, stage_bytes)

    def test_invalid_inputs_and_missing_source_record_fail_before_install(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            _, farm, directory, library, _ = fake_farm(root)
            stage = root / 'stage'
            for options in ({'theatre': '../urban'}, {'theatre': 'urban', 'strength': -0.1},
                            {'theatre': 'urban', 'strength': 1.1}, {'theatre': 'urban', 'strength': float('nan')},
                            {'theatre': 'urban', 'suffix': '../gem'}):
                with self.subTest(options=options), self.assertRaises(ValueError):
                    gems.apply_page(farm, stage_dir=stage, **options)
            self.assertFalse(stage.exists())
            library['spriteAtlases'].append(copy.deepcopy(library['spriteAtlases'][0]))
            library['sprites']['overlay:GEM02']['frames'][0]['page'] = 1
            (directory / 'library.json').unlink()
            (directory / 'library.json').write_text(json.dumps(library))
            with self.assertRaisesRegex(ValueError, 'share one page'):
                gems.apply_page(farm, 'urban', stage_dir=stage)
            library['sprites']['overlay:GEM02']['frames'][0]['page'] = 0
            library['spriteAtlasesHd'][0]['file'] = 'redraw@2x-l5hgem.png'
            (directory / 'library.json').write_text(json.dumps(library))
            with self.assertRaisesRegex(ValueError, 'missing original source record'):
                gems.apply_page(farm, 'urban', stage_dir=stage)
            self.assertFalse(stage.exists())


if __name__ == '__main__':
    unittest.main()
