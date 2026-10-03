"""Asset-free projection builder contracts; run with unittest discovery."""
import contextlib
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

import cv2
import numpy as np
from PIL import Image

import vehicle_projection as projection
from vehicle_projection import (BAKE_JACOBIAN, Frame, Registration, affine_point, build, build_index, camo_lock, chroma_lock, compose_sheet,
                                linear_rgb, pack_frames, paint_channels, ramp_position, redraw_alpha, register,
                                sheet_matrix, similarity, steel_grade, warp)


# Frozen reviewed prototype formula; keep arithmetic independent of camo_lock.
def _prototype_camo_lock(design, redraw, sigma_ab=2.5, l_lo=1.5, l_hi=8.0, l_strength=0.6, l_base=0.0, l_base_sigma=6.0, paint_chroma=42.0, chroma_gain=1.0):
    design = np.asarray(design, np.uint8)[..., :3]
    bg = tuple(int(v) for v in design[0, 0])
    locked = chroma_lock(design, redraw, bg, sigma_ab, 1.0, paint_chroma)
    rgb = locked[..., :3]
    bga = np.asarray(bg, np.int32)
    fg_d = (np.abs(design.astype(np.int32) - bga).max(-1) > 6).astype(np.float32)
    fg_r = (np.abs(rgb.astype(np.int32) - bga).max(-1) > 6).astype(np.float32)
    lab_d = cv2.cvtColor(design.astype(np.float32) / 255, cv2.COLOR_RGB2LAB)
    lab_r = cv2.cvtColor(rgb.astype(np.float32) / 255, cv2.COLOR_RGB2LAB)
    src = fg_d * (np.hypot(lab_d[..., 1], lab_d[..., 2]) < paint_chroma)
    tgt = fg_r * np.clip((paint_chroma + 8 - np.hypot(lab_r[..., 1], lab_r[..., 2])) / 8, 0, 1)
    def lp(x, w, s):
        return cv2.GaussianBlur(x * w, (0, 0), s) / np.maximum(cv2.GaussianBlur(w, (0, 0), s), 1e-4)
    band = lp(lab_d[..., 0], src, l_lo) - lp(lab_d[..., 0], src, l_hi)
    cover = np.clip(cv2.GaussianBlur(src, (0, 0), l_lo) * 1.5, 0, 1)
    out = lab_r.copy()
    base = lp(lab_d[..., 0], src, l_base_sigma) - lp(lab_r[..., 0], (tgt > 0.99).astype(np.float32), l_base_sigma)
    out[..., 0] = np.clip(out[..., 0] + (l_strength * band * cover + l_base * base) * tgt, 0, 100)
    out[..., 1:] *= (1 + (chroma_gain - 1) * tgt)[..., None]
    res = np.clip(cv2.cvtColor(out, cv2.COLOR_LAB2RGB) * 255 + 0.5, 0, 255).astype(np.uint8)
    result = np.asarray(redraw, np.uint8).copy()
    result[..., :3] = np.where(fg_r[..., None] > 0, res, np.asarray(redraw)[..., :3])
    return result


class VehicleProjectionTests(unittest.TestCase):
    def silhouette(self):
        a = np.zeros((128, 192), np.float32)
        cv2.rectangle(a, (36, 48), (140, 94), 1, -1)
        cv2.rectangle(a, (67, 30), (111, 60), 1, -1)
        cv2.rectangle(a, (106, 35), (166, 42), 1, -1)
        return a

    def test_known_sheet_similarity_is_recovered_within_one_pixel(self):
        target = self.silhouette()
        forward = similarity((192, 128), 1.043, 9, -6)
        shifted = warp(target, forward, (192, 128))
        sheet = np.full((128, 192, 3), 118, np.float32)
        sheet += shifted[..., None] * np.array([80, -45, -55])
        result = register(redraw_alpha(sheet, target), target)
        self.assertGreater(result.iou, 0.97)
        for point in [(36, 48), (140, 94), (166, 42)]:
            recovered = affine_point(result.matrix, affine_point(forward, point))
            np.testing.assert_allclose(recovered, point, atol=1)
        self.assertAlmostEqual(result.scale, 1 / 1.043, delta=0.008)

    def test_grey_interior_filled_and_unrelated_component_removed(self):
        a = self.silhouette()
        c = np.full((*a.shape, 3), 118, np.float32)
        c[a > 0] = [170, 50, 45]
        c[56:81, 60:110] = 118
        c[8:14, 8:20] = 20
        alpha = redraw_alpha(c, a)
        self.assertEqual(alpha[65, 80], 1)
        self.assertEqual(alpha[10, 10], 0)
        self.assertEqual(alpha[0, 0], 0)

    def test_packed_pivot_projection_round_trip_and_gutters(self):
        alpha = self.silhouette()
        colour = np.zeros((*alpha.shape, 3), np.float32)
        colour[alpha > 0] = [180, 50, 30]
        cell = {'dst_origin': [180, 160], 'src_centre': [400, 400], 'cell': [96, 96, 192, 128]}
        mapping = sheet_matrix(cell, 1.4)
        registration = Registration(similarity((192, 128), 0.975, 3, -2), 0.99, 0.975, 3, -2)
        pivot = affine_point(registration.matrix, affine_point(mapping, [400, 400]))
        frame = Frame(0, 0, colour, alpha, np.zeros_like(colour), pivot, alpha, registration)
        atlas, paint, entries = pack_frames([frame, frame], max_width=240)
        self.assertLessEqual(atlas.shape[1], 240)
        self.assertEqual(paint.shape[:2], atlas.shape[:2])
        # Recover the pre-pack projected point from either shelf, then its original bake pivot.
        offset = (BAKE_JACOBIAN * 1.4) @ np.array([0.1, 0.03, -0.1])
        for entry in entries:
            x, y, w, h = entry['rect']
            origin = np.array([x - 36, y - 30])
            np.testing.assert_allclose(np.array(entry['pivot']) + offset - origin, pivot + offset)
            restored = affine_point(cv2.invertAffineTransform(mapping),
                                    affine_point(cv2.invertAffineTransform(registration.matrix), np.array(entry['pivot']) - origin))
            np.testing.assert_allclose(restored, [400, 400])
            self.assertEqual(atlas[y - 1, x, 3], 0)
            np.testing.assert_array_equal(atlas[y - 1, x, :3], [180, 50, 30])

    def test_house_ramp_t_monotonic_and_shading_preserved(self):
        ramp = np.stack([np.linspace(240, 30, 16), np.linspace(60, 8, 16), np.linspace(50, 6, 16)], -1)
        t, ratio = ramp_position(ramp, ramp)
        np.testing.assert_allclose(t, np.linspace(0, 1, 16), atol=1e-8)
        np.testing.assert_allclose(ratio, 1, atol=1e-8)
        t, ratio = ramp_position(np.array([[255, 100, 100], [10, 1, 1]]), ramp)
        np.testing.assert_allclose(t, [0, 1])
        self.assertGreater(ratio[0], 1)
        self.assertLess(ratio[1], 1)
        self.assertTrue(np.all(ratio <= 2))

    def test_paint_requires_source_difference_and_redraw_house_hue(self):
        colour = np.full((20, 30, 3), [180, 30, 20], np.float32)
        source = colour.copy()
        colour[:, 15:] = [20, 30, 180]
        mask = np.zeros((20, 30), np.float32)
        mask[4:16, 8:22] = 1
        ramp = np.stack([np.linspace(240, 30, 16), np.linspace(40, 5, 16), np.linspace(20, 2, 16)], -1)
        paint = paint_channels(colour, np.ones_like(mask), source, mask, ramp)
        self.assertEqual(paint[10, 10, 0], 1)
        self.assertEqual(paint[10, 20, 0], 0)
        self.assertEqual(paint[10, 1, 0], 0)
        self.assertFalse(paint_channels(colour, mask, source, mask * 0, ramp).any())

    def test_building_turret_builds_a_turret_only_type(self):
        # A building's voxel turret (library id 'GUN:turret') has no body: its sheet set is the turret part alone, and
        # file names replace the ':' so the index maps the id to an ordinary file.
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            bake, sheet, out = root / 'bake', root / 'sheet', root / 'out'
            (bake / 'engine').mkdir(parents=True)
            sheet.mkdir()
            frames, cells = [], []
            a = np.zeros((32, 32), np.uint8)
            a[12:24, 10:26] = 1
            colour = np.full((32, 32, 3), [90, 100, 110], np.uint8)
            output = np.tile(np.where(a[..., None], colour, 118).astype(np.uint8), (4, 4, 1))
            for i in range(16):
                for suffix, background in [('k', 0), ('w', 255), ('p', 0)]:
                    Image.fromarray(np.where(a[..., None], colour, background).astype(np.uint8)).save(
                        bake / 'engine' / f'turret_{i:03d}_{suffix}.png')
                frames.append({'k': i, 'facing': i * 16, 'part': 'turret', 'pivot': [16, 24]})
                x, y = (i % 4) * 32, (i // 4) * 32
                cells.append({'k': i, 'facing': i * 16, 'src_centre': [16, 16], 'dst_origin': [x + 16, y + 16], 'cell': [x, y, 32, 32]})
            (bake / 'meta.json').write_text(json.dumps({'looks': {'engine': {'frames': frames, 'turreted': True}}}))
            (sheet / 'input.json').write_text(json.dumps({'part': 'turret', 'scale': 1, 'cells': cells}))
            Image.fromarray(output).save(sheet / 'input.png')
            Image.fromarray(output).save(sheet / 'output.png')
            palettes = root / 'palettes.json'
            palettes.write_text(json.dumps({'unit@BakeA': [100] * 768}))
            manifest = build('GUN:turret', bake, [sheet], palettes, 'unit@BakeA', out)
            self.assertEqual(manifest['type'], 'GUN:turret')
            self.assertEqual(set(manifest['parts']), {'turret'})
            self.assertEqual(manifest['parts']['turret']['colour'], 'GUN_turret_turret.png')
            self.assertTrue((out / 'GUN_turret_turret_paint.png').is_file())
            self.assertEqual(build_index(out)['types'], {'GUN:turret': 'GUN_turret.json'})
            # An ordinary vehicle id still needs its body.
            with self.assertRaisesRegex(ValueError, 'Incomplete part set'):
                build('GUN', bake, [sheet], palettes, 'unit@BakeA', root / 'out2')

    def test_full_civilian_build_and_incomplete_facings_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            bake, sheet, out = root / 'bake', root / 'sheet', root / 'out'
            (bake / 'engine').mkdir(parents=True)
            sheet.mkdir()
            frames, cells = [], []
            a = np.zeros((32, 32), np.uint8)
            a[12:24, 10:26] = 1
            colour = np.full((32, 32, 3), [90, 100, 110], np.uint8)
            cell_image = np.where(a[..., None], colour, 118).astype(np.uint8)
            output = np.tile(cell_image, (4, 4, 1))
            for i in range(16):
                k = i * 2
                for suffix, background in [('k', 0), ('w', 255), ('p', 0)]:
                    Image.fromarray(np.where(a[..., None], colour, background).astype(np.uint8)).save(bake / 'engine' / f'all_{k:03d}_{suffix}.png')
                frames.append({'k': k, 'facing': k * 8, 'part': 'all', 'pivot': [16, 24]})
                x, y = (i % 4) * 32, (i // 4) * 32
                cells.append({'k': k, 'facing': k * 8, 'src_centre': [16, 16], 'dst_origin': [x + 16, y + 16], 'cell': [x, y, 32, 32]})
            (bake / 'meta.json').write_text(json.dumps({'looks': {'engine': {'frames': frames, 'turreted': False}}}))
            spec = {'part': 'all', 'scale': 1, 'cells': cells}
            (sheet / 'input.json').write_text(json.dumps(spec))
            Image.fromarray(output).save(sheet / 'input.png')
            Image.fromarray(output).resize((256, 256), Image.Resampling.NEAREST).save(sheet / 'output.png')
            palettes = root / 'palettes.json'
            palettes.write_text(json.dumps({'unit@BakeA': [100] * 768}))
            manifest = build('CAR', bake, [sheet], palettes, 'unit@BakeA', out, root / 'review')
            self.assertEqual(manifest['frames'], 16)
            self.assertEqual(manifest['facingStep'], 16)
            self.assertIsNone(manifest['house'])
            self.assertEqual(set(manifest['parts']), {'body'})
            self.assertEqual(build_index(out)['types'], {'CAR': 'CAR.json'})
            self.assertTrue((root / 'review/CAR_body.png').is_file())
            spec['cells'].pop()
            (sheet / 'input.json').write_text(json.dumps(spec))
            with self.assertRaisesRegex(ValueError, 'uniformly spaced'):
                build('BAD', bake, [sheet], palettes, 'unit@BakeA', out)
            self.assertFalse((out / 'BAD.json').exists())


    def test_composed_sheet_round_trips_through_build(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            bake, sheet, out = root / 'bake', root / 'sheet', root / 'out'
            (bake / 'engine').mkdir(parents=True)
            frames = []
            for i in range(16):
                k = i * 2
                a = np.zeros((96, 96), np.uint8)
                a[30 + i % 3:60, 20:70 - i] = 1
                colour = np.full((96, 96, 3), [90, 100, 110], np.uint8)
                for suffix, background in [('k', 0), ('w', 255), ('p', 0)]:
                    Image.fromarray(np.where(a[..., None], colour, background).astype(np.uint8)).save(
                        bake / 'engine' / f'all_{k:03d}_{suffix}.png')
                frames.append({'k': k, 'facing': k * 8, 'part': 'all', 'pivot': [48, 50]})
            (bake / 'meta.json').write_text(json.dumps({'looks': {'engine': {'frames': frames, 'turreted': False}}}))
            spec = compose_sheet(bake, 'all', sheet, list(range(0, 32, 2)))
            self.assertEqual(len(spec['cells']), 16)
            self.assertLessEqual(spec['scale'], 2.0)
            image = np.asarray(Image.open(sheet / 'input.png'))
            self.assertEqual(image.shape, (1024, 1536, 3))
            # Every cell's bake centre lands on its cell centre, and the sheet colour is the un-matted bake colour.
            for cell in spec['cells']:
                x, y, w, h = cell['cell']
                self.assertAlmostEqual(cell['dst_origin'][0], x + w / 2, delta=1)
                self.assertAlmostEqual(cell['dst_origin'][1], y + h / 2, delta=1)
                self.assertTrue(np.allclose(image[y + h // 2, x + w // 2], [90, 100, 110], atol=3))
            self.assertTrue((image[:4, :4] == 118).all())
            Image.fromarray(image).save(sheet / 'output.png')
            palettes = root / 'palettes.json'
            palettes.write_text(json.dumps({'unit@BakeA': [100] * 768}))
            manifest = build('BOX', bake, [sheet], palettes, 'unit@BakeA', out)
            self.assertEqual(manifest['frames'], 16)
            self.assertGreater(min(r['iou'] for r in manifest['registration']), 0.9)

    def test_steel_grade_neutralises_tan_only(self):
        rgba = np.array([[[196, 170, 120, 255], [200, 30, 30, 255], [40, 90, 200, 255], [196, 170, 120, 128]]],
                        np.uint8)
        paint = np.array([[0, 0, 0, 255]], np.uint8)
        tan, red, blue, painted = steel_grade(rgba, paint, 0.3)[0]
        weights = [0.2126, 0.7152, 0.0722]
        self.assertLess(int(tan[:3].max()) - int(tan[:3].min()), 30)  # 76 apart before
        self.assertAlmostEqual(float(linear_rgb(tan[:3]) @ weights), float(linear_rgb(rgba[0, 0, :3]) @ weights),
                               delta=0.01)
        np.testing.assert_array_equal(red, rgba[0, 1])  # hue 0 and 220 lie outside the band
        np.testing.assert_array_equal(blue, rgba[0, 2])
        np.testing.assert_array_equal(painted, rgba[0, 3])  # house paint and alpha untouched

    def test_steel_grade_red_band_wraps_around_zero(self):
        # A stray red the image model painted on an Allied hull (hue 350) is greyed with centre=0; tan and blue stay.
        rgba = np.array([[[200, 30, 60, 255], [196, 170, 120, 255], [40, 90, 200, 255]]], np.uint8)
        paint = np.zeros((1, 3), np.uint8)
        red, tan, blue = steel_grade(rgba, paint, 0.1, centre=0, half=25)[0]
        self.assertLess(int(red[:3].max()) - int(red[:3].min()), 30)
        np.testing.assert_array_equal(tan, rgba[0, 1])
        np.testing.assert_array_equal(blue, rgba[0, 2])

    def test_chroma_lock_restores_design_hue_keeps_lightness_detail_and_paint(self):
        bg = np.full((64, 64, 3), 118, np.uint8)
        design, redraw = bg.copy(), bg.copy()
        design[16:48, 16:48] = (190, 180, 120)  # olive khaki hull
        design[28:36, 28:36] = (220, 20, 20)  # saturated house paint
        grey = np.linspace(90, 210, 32).astype(np.uint8)
        redraw[16:48, 16:48] = grey[None, :, None]  # neutral steel with a lightness ramp (the detail to keep)
        redraw[28:36, 28:36] = (200, 30, 30)
        out = chroma_lock(design, redraw)
        lab = lambda a: cv2.cvtColor(a.astype(np.float32) / 255, cv2.COLOR_RGB2LAB)
        lo, ld, lr = lab(out), lab(design), lab(redraw)
        hull = np.s_[18:26, 18:46]
        self.assertGreater(lo[hull][..., 2].mean(), 0.7 * ld[hull][..., 2].mean())  # yellow (b*) restored
        self.assertLess(np.abs(lo[hull][..., 0] - lr[hull][..., 0]).max(), 4.0)  # lightness ramp kept
        np.testing.assert_array_equal(out[30:34, 30:34], redraw[30:34, 30:34])  # paint untouched
        np.testing.assert_array_equal(out[:8, :8], redraw[:8, :8])  # background untouched

class LiftLightnessTests(unittest.TestCase):
    def lab(self, rgba):
        return cv2.cvtColor(rgba[..., :3].astype(np.float32) / 255, cv2.COLOR_RGB2LAB)

    def test_darks_rise_highlights_change_less_and_ramp_stays_monotonic(self):
        ramp = np.zeros((1, 256, 4), np.uint8)
        ramp[..., :3] = np.arange(256, dtype=np.uint8)[None, :, None]
        ramp[..., 3] = 255
        # At gamma 0.8, L*=30 rises by about 8 and L*=90 by about 2.
        before = self.lab(ramp)[..., 0]
        self.assertAlmostEqual(float(before[0, 71]), 30, delta=1)
        self.assertAlmostEqual(float(before[0, 226]), 90, delta=1)
        after = self.lab(projection.lift_lightness(ramp, np.zeros((1, 256), np.uint8), 0.8))[..., 0]
        self.assertGreater(float(after[0, 71] - before[0, 71]), 5)
        self.assertGreater(float(after[0, 226] - before[0, 226]), 0)
        self.assertLess(float(after[0, 226] - before[0, 226]), 2.5)
        self.assertTrue(np.all(np.diff(after[0]) >= 0))
        self.assertEqual(float(after[0, 0]), 0)
        self.assertEqual(float(after[0, -1]), 100)

    def test_gamma_point_six_matches_lightness_curve_and_partial_paint_weight(self):
        rgba = np.full((1, 3, 4), [71, 71, 71, 255], np.uint8)
        paint = np.array([[0, 128, 255]], np.uint8)
        before = self.lab(rgba)[..., 0]
        after = self.lab(projection.lift_lightness(rgba, paint, 0.6))[..., 0]
        weight = 1 - np.clip((paint.astype(float) / 255 - 0.3) / 0.4, 0, 1)
        expected = before + (100 * (before / 100) ** 0.6 - before) * weight
        np.testing.assert_allclose(after, expected, atol=0.4)
        self.assertGreater(float(after[0, 1]), float(before[0, 1]))
        self.assertLess(float(after[0, 1]), float(after[0, 0]))

    def test_chroma_and_coloured_hue_are_preserved(self):
        rgba = np.array([[[71, 71, 71, 255], [65, 79, 92, 255], [150, 165, 180, 255],
                          [120, 85, 65, 255]]], np.uint8)
        before = self.lab(rgba)
        after = self.lab(projection.lift_lightness(rgba, np.zeros((1, 4), np.uint8), 0.6))
        np.testing.assert_allclose(after[..., 1:], before[..., 1:], atol=1.5)
        before_hue = np.rad2deg(np.arctan2(before[0, 3, 2], before[0, 3, 1]))
        after_hue = np.rad2deg(np.arctan2(after[0, 3, 2], after[0, 3, 1]))
        self.assertLessEqual(abs(float((after_hue - before_hue + 180) % 360 - 180)), 3)

    def test_paint_and_transparency_preserve_original_bytes_and_inputs(self):
        rgba = np.array([[[71, 71, 71, 255], [91, 37, 143, 128], [19, 137, 53, 0],
                          [65, 79, 92, 64]]], np.uint8)
        paint = np.array([[0, 255, 0, 179]], np.uint8)
        original, original_paint = rgba.copy(), paint.copy()
        result = projection.lift_lightness(rgba, paint, 0.6)
        self.assertFalse(np.array_equal(result[0, 0], original[0, 0]))
        np.testing.assert_array_equal(result[0, 1:], original[0, 1:])
        np.testing.assert_array_equal(result[..., 3], original[..., 3])
        np.testing.assert_array_equal(rgba, original)
        np.testing.assert_array_equal(paint, original_paint)

    def test_near_zero_weight_keeps_rgb_bytes_without_round_trip(self):
        rgba = np.array([[[19, 137, 53, 255], [91, 37, 143, 64]]], np.uint8)
        paint = np.full((1, 2), 178, np.uint8)
        # Choose a protection boundary where this uint8 mask gives 0 < w <= 1e-3.
        result = projection.lift_lightness(rgba, paint, 0.6, protect_hi=178 / 255 + 0.0001)
        np.testing.assert_array_equal(result, rgba)

    def test_gamma_above_one_darkens_mid_tones_and_keeps_paint(self):
        rgba = np.zeros((1, 2, 4), np.uint8)
        rgba[..., :3] = (150, 150, 150)
        rgba[..., 3] = 255
        paint = np.array([[0, 255]], np.uint8)
        out = projection.lift_lightness(rgba, paint, 1.3)
        self.assertLess(int(out[0, 0, 0]), 150)
        np.testing.assert_array_equal(out[0, 1], rgba[0, 1])

    def test_gamma_one_returns_an_identical_independent_copy(self):
        rng = np.random.default_rng(2026)
        rgba = rng.integers(0, 256, (8, 8, 4), dtype=np.uint8)
        paint = rng.integers(0, 256, (8, 8), dtype=np.uint8)
        result = projection.lift_lightness(rgba, paint, 1)
        self.assertEqual(result.dtype, np.uint8)
        np.testing.assert_array_equal(result, rgba)
        self.assertFalse(np.shares_memory(result, rgba))

    def test_invalid_gamma_masks_and_protection_bounds_are_rejected(self):
        rgba, paint = np.zeros((1, 1, 4), np.uint8), np.zeros((1, 1), np.uint8)
        for gamma in (0, -0.1, 3.1, float('nan'), float('inf')):
            with self.subTest(gamma=gamma), self.assertRaisesRegex(ValueError, 'gamma'):
                projection.lift_lightness(rgba, paint, gamma)
        with self.assertRaisesRegex(ValueError, 'matching paint red channel'):
            projection.lift_lightness(rgba, np.zeros((1, 2), np.uint8), 0.6)
        for lo, hi in ((0.7, 0.3), (0.3, 0.3), (-0.1, 0.7), (0.3, 1.1)):
            with self.subTest(lo=lo, hi=hi), self.assertRaisesRegex(ValueError, 'paint protection'):
                projection.lift_lightness(rgba, paint, 0.6, lo, hi)


class ProjectionLiftTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.src, self.out = self.root / 'source', self.root / 'lifted'
        self.src.mkdir()
        self.rgba = np.array([[[71, 71, 71, 255], [65, 79, 92, 64]],
                              [[91, 37, 143, 128], [19, 137, 53, 0]]], np.uint8)
        paint = np.zeros((2, 2, 3), np.uint8)
        paint[1, 0] = [255, 77, 199]
        paint[0, 1] = [128, 255, 255]
        self.spec = {'version': 1, 'type': 'HTNK', 'frames': 16, 'facingStep': 16, 'scale': 1,
                     'jacobian': BAKE_JACOBIAN.tolist(), 'house': {'first': 16, 'count': 16},
                     'registration': [], 'parts': {}}
        for part in ('body', 'turret'):
            # Atlas names are manifest references, not names inferred from the part.
            colour_name, paint_name = f'custom_{part}.png', f'mask_{part}.png'
            Image.fromarray(self.rgba).save(self.src / colour_name)
            Image.fromarray(paint).save(self.src / paint_name)
            self.spec['parts'][part] = {'colour': colour_name, 'paint': paint_name, 'size': [2, 2],
                                       'frames': [{'k': k, 'facing': k * 16, 'pivot': [0, 0],
                                                   'rect': [0, 0, 2, 2]} for k in range(16)]}
        (self.src / 'HTNK.json').write_text(json.dumps(self.spec, indent=2) + '\n')
        self.snapshot = {p.name: p.read_bytes() for p in self.src.iterdir()}

    def assert_source_untouched(self):
        self.assertEqual({p.name: p.read_bytes() for p in self.src.iterdir()}, self.snapshot)

    def assert_complete_output(self, changed):
        self.assertEqual(changed, {'body': 2, 'turret': 2})
        self.assertEqual({p.name for p in self.out.iterdir()}, set(self.snapshot))
        self.assertEqual((self.out / 'HTNK.json').read_bytes(), self.snapshot['HTNK.json'])
        for part, entry in self.spec['parts'].items():
            self.assertEqual((self.out / entry['paint']).read_bytes(), self.snapshot[entry['paint']])
            self.assertNotEqual((self.out / entry['colour']).read_bytes(), self.snapshot[entry['colour']])
            with Image.open(self.out / entry['colour']) as image:
                self.assertEqual(image.mode, 'RGBA')
                result = np.array(image)
            self.assertEqual(int(np.count_nonzero(np.any(result != self.rgba, axis=-1))), changed[part])
            np.testing.assert_array_equal(result[..., 3], self.rgba[..., 3])
            np.testing.assert_array_equal(result[1], self.rgba[1])
        self.assert_source_untouched()

    def test_lift_writes_a_complete_separate_build_with_exact_counts(self):
        self.assert_complete_output(projection.lift(self.src, self.out, 'HTNK', 0.6))

    def test_output_is_compatible_with_existing_farm_install(self):
        projection.lift(self.src, self.out, 'HTNK', 0.6)
        farm = self.root / 'farm'
        (farm / 'vehicles-hd').mkdir(parents=True)
        (farm / 'vehicles-hd/index.json').write_text(json.dumps({'version': 1, 'types': {}}))
        installed = projection.install(farm, self.out, 'HTNK')
        self.assertEqual(set(installed), set(self.snapshot))
        for name in installed:
            self.assertEqual((farm / 'vehicles-hd' / name).read_bytes(), (self.out / name).read_bytes())
        self.assertEqual(json.loads((farm / 'vehicles-hd/index.json').read_text())['types'], {'HTNK': 'HTNK.json'})
        self.assert_source_untouched()

    def test_same_nested_and_symlinked_source_outputs_are_refused(self):
        alias = self.root / 'alias'
        alias.symlink_to(self.src, target_is_directory=True)
        for out in (self.src, self.src / 'nested', self.src / '..' / 'source', alias, alias / 'nested'):
            with self.subTest(out=out), self.assertRaisesRegex(ValueError, 'source directory'):
                projection.lift(self.src, out, 'HTNK', 0.6)
        self.assertFalse((self.src / 'nested').exists())
        self.assert_source_untouched()

    def test_existing_output_symlinks_are_replaced_without_writing_through(self):
        self.out.mkdir()
        for name in self.snapshot:
            (self.out / name).symlink_to(self.src / name)
        changed = projection.lift(self.src, self.out, 'HTNK', 0.6)
        self.assertTrue(all(not p.is_symlink() for p in self.out.iterdir()))
        self.assert_complete_output(changed)

    def test_invalid_gamma_type_manifest_and_missing_atlas_fail_before_output(self):
        for gamma in (0, -1, 3.1, float('nan'), float('inf')):
            with self.subTest(gamma=gamma), self.assertRaisesRegex(ValueError, 'gamma'):
                projection.lift(self.src, self.out, 'HTNK', gamma)
        for type_name in ('../HTNK', 'HTNK/other', 'HTNK:turret', 'HTNK-1', 'HTNK\n', ''):
            with self.subTest(type_name=type_name), self.assertRaisesRegex(ValueError, 'Invalid projection type'):
                projection.lift(self.src, self.out, type_name, 0.6)
        with self.assertRaisesRegex(ValueError, 'Missing build manifest'):
            projection.lift(self.src, self.out, 'MISSING', 0.6)
        manifest = self.src / 'HTNK.json'
        manifest.write_text(json.dumps({**self.spec, 'type': 'OTHER'}))
        with self.assertRaisesRegex(ValueError, 'version 1 manifest for HTNK'):
            projection.lift(self.src, self.out, 'HTNK', 0.6)
        manifest.write_bytes(self.snapshot[manifest.name])
        atlas = self.src / self.spec['parts']['turret']['paint']
        atlas.unlink()
        with self.assertRaisesRegex(ValueError, 'missing atlas'):
            projection.lift(self.src, self.out, 'HTNK', 0.6)
        atlas.write_bytes(self.snapshot[atlas.name])
        self.assertFalse(self.out.exists())
        self.assert_source_untouched()

    def test_failed_image_write_leaves_no_partial_destination_or_temporary_file(self):
        self.out.mkdir()
        destination = self.out / self.spec['parts']['body']['colour']
        destination.write_bytes(b'previous build')
        with mock.patch.object(Image.Image, 'save', side_effect=OSError('synthetic write failure')):
            with self.assertRaisesRegex(OSError, 'synthetic write failure'):
                projection.lift(self.src, self.out, 'HTNK', 0.6)
        self.assertEqual(destination.read_bytes(), b'previous build')
        self.assertEqual(list(self.out.iterdir()), [destination])
        self.assert_source_untouched()

    def test_gamma_one_build_preserves_colour_pixels_and_reports_zero(self):
        self.assertEqual(projection.lift(self.src, self.out, 'HTNK', 1), {'body': 0, 'turret': 0})
        for entry in self.spec['parts'].values():
            with Image.open(self.out / entry['colour']) as image:
                np.testing.assert_array_equal(np.array(image), self.rgba)
        self.assert_source_untouched()

    def test_cli_returns_zero_and_prints_json(self):
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            status = projection.main(['lift', '--src', str(self.src), '--out', str(self.out),
                                      '--type', 'HTNK', '--gamma', '0.6'])
        self.assertEqual(status, 0)
        self.assert_complete_output(json.loads(output.getvalue()))
        command = [sys.executable, '-B', str(Path(projection.__file__).resolve()), 'lift',
                   '--src', str(self.src), '--out', str(self.out), '--type', 'HTNK', '--gamma', '0.6']
        result = subprocess.run(command, capture_output=True, text=True, timeout=20)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assert_complete_output(json.loads(result.stdout))

    def test_cli_validation_reports_errors_without_creating_output(self):
        base = ['lift', '--src', str(self.src), '--out', str(self.out)]
        for type_name, gamma, message in (('HTNK', '0', 'gamma'), ('../HTNK', '0.6', 'Invalid projection type'),
                                          ('MISSING', '0.6', 'Missing build manifest')):
            errors = io.StringIO()
            with self.subTest(type_name=type_name, gamma=gamma), contextlib.redirect_stderr(errors):
                with self.assertRaises(SystemExit) as raised:
                    projection.main([*base, '--type', type_name, '--gamma', gamma])
            self.assertEqual(raised.exception.code, 2)
            self.assertIn(message, errors.getvalue())
        self.assertFalse(self.out.exists())
        self.assert_source_untouched()


class ProjectionInstallTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def fake_build_and_farm(self, type_name='CAR', directory_symlink=False):
        stem = projection.file_stem(type_name)
        root = self.root / stem
        base, farm, build_dir = root / 'base', root / 'farm', root / 'build'
        (base / 'vehicles-hd').mkdir(parents=True)
        farm.mkdir()
        build_dir.mkdir()
        part = 'turret' if type_name.endswith(':turret') else 'body'
        colour, paint = f'{stem}_{part}.png', f'{stem}_{part}_paint.png'
        spec = {'version': 1, 'type': type_name, 'frames': 16, 'facingStep': 16, 'scale': 1,
                'jacobian': BAKE_JACOBIAN.tolist(), 'house': None, 'registration': [],
                'parts': {part: {'colour': colour, 'paint': paint, 'size': [1, 1], 'frames': [
                    {'k': k, 'facing': k * 16, 'pivot': [0, 0], 'rect': [0, 0, 1, 1]} for k in range(16)]}}}
        (build_dir / f'{stem}.json').write_text(json.dumps(spec))
        Image.new('RGBA', (1, 1), (90, 100, 110, 255)).save(build_dir / colour)
        Image.new('RGB', (1, 1), (0, 0, 0)).save(build_dir / paint)
        base_files = base / 'vehicles-hd'
        (base_files / 'index.json').write_text(json.dumps({'version': 1, 'types': {'ZZZ': 'ZZZ.json'}, 'keep': True}))
        (base_files / 'ZZZ.json').write_text(json.dumps({'type': 'ZZZ'}))
        # Replace existing symlinks as well as adding a new index entry.
        for path in build_dir.iterdir():
            (base_files / path.name).write_bytes(b'old ' + path.name.encode())
        if directory_symlink:
            (farm / 'vehicles-hd').symlink_to(base_files)
        else:
            (farm / 'vehicles-hd').mkdir()
            for path in base_files.iterdir():
                (farm / 'vehicles-hd' / path.name).symlink_to(path)
        return base_files, farm, build_dir

    def test_install_cli_preserves_base_bytes_inodes_and_existing_index_entries(self):
        for type_name, directory_symlink in (('CAR', False), ('GUN:turret', True)):
            with self.subTest(type_name=type_name):
                base, farm, build_dir = self.fake_build_and_farm(type_name, directory_symlink)
                snapshot = {p.name: (p.read_bytes(), p.stat().st_ino) for p in base.iterdir()}
                output = io.StringIO()
                with contextlib.redirect_stdout(output):
                    projection.main(['install', '--farm', str(farm), '--build-dir', str(build_dir), '--type', type_name])
                for path in build_dir.iterdir():
                    installed = farm / 'vehicles-hd' / path.name
                    self.assertFalse(installed.is_symlink())
                    self.assertTrue(installed.is_file())
                    self.assertEqual(installed.read_bytes(), path.read_bytes())
                index_path = farm / 'vehicles-hd/index.json'
                self.assertFalse(index_path.is_symlink())
                index = json.loads(index_path.read_text())
                self.assertEqual(index['types'], {'ZZZ': 'ZZZ.json', type_name: f'{projection.file_stem(type_name)}.json'})
                self.assertEqual(list(index['types']), sorted(index['types']))
                self.assertTrue(index['keep'])
                self.assertTrue((farm / 'vehicles-hd/ZZZ.json').is_symlink())
                for name, before in snapshot.items():
                    path = base / name
                    self.assertEqual((path.read_bytes(), path.stat().st_ino), before)
                lines = output.getvalue().splitlines()
                self.assertEqual(set(lines[:-1]), {f'installed vehicles-hd/{p.name}' for p in build_dir.iterdir()})
                self.assertEqual(len(lines), 4)
                self.assertEqual(lines[-1], f'index {type_name} -> {projection.file_stem(type_name)}.json')

    def test_missing_atlas_is_refused_before_any_farm_write_or_index_build(self):
        _, farm, build_dir = self.fake_build_and_farm()
        (build_dir / 'CAR_body_paint.png').unlink()
        for operation in (lambda: projection.install(farm, build_dir, 'CAR'), lambda: build_index(build_dir)):
            with self.assertRaisesRegex(ValueError, 'missing atlas CAR_body_paint.png'):
                operation()
        self.assertTrue(all(p.is_symlink() for p in (farm / 'vehicles-hd').iterdir()))
        self.assertFalse((build_dir / 'index.json').exists())

    def test_missing_manifest_is_refused_before_any_farm_write(self):
        _, farm, build_dir = self.fake_build_and_farm()
        (build_dir / 'CAR.json').unlink()
        with self.assertRaisesRegex(ValueError, 'Missing build manifest'):
            projection.install(farm, build_dir, 'CAR')
        self.assertTrue(all(p.is_symlink() for p in (farm / 'vehicles-hd').iterdir()))

    def test_missing_index_is_not_created_and_cli_error_is_clear(self):
        _, farm, build_dir = self.fake_build_and_farm()
        index = farm / 'vehicles-hd/index.json'
        index.unlink()
        error = io.StringIO()
        with contextlib.redirect_stderr(error), self.assertRaises(SystemExit) as stopped:
            projection.main(['install', '--farm', str(farm), '--build-dir', str(build_dir), '--type', 'CAR'])
        self.assertEqual(stopped.exception.code, 2)
        self.assertIn('Missing farm index', error.getvalue())
        self.assertFalse(index.exists())
        self.assertTrue(all(p.is_symlink() for p in index.parent.iterdir()))

    def test_wrong_manifest_type_or_invalid_index_is_refused_before_installing(self):
        _, farm, build_dir = self.fake_build_and_farm()
        manifest = build_dir / 'CAR.json'
        spec = json.loads(manifest.read_text())
        manifest.write_text(json.dumps({**spec, 'type': 'OTHER'}))
        with self.assertRaisesRegex(ValueError, 'manifest for CAR'):
            projection.install(farm, build_dir, 'CAR')
        manifest.write_text(json.dumps(spec))
        (farm / 'vehicles-hd/index.json').unlink()
        (farm / 'vehicles-hd/index.json').write_text(json.dumps({'version': 1, 'types': []}))
        with self.assertRaisesRegex(ValueError, 'index with types'):
            projection.install(farm, build_dir, 'CAR')
        self.assertTrue((farm / 'vehicles-hd/CAR.json').is_symlink())


class CamoLockTests(unittest.TestCase):
    def hull(self):
        design = np.full((48, 64, 3), 118, np.uint8)
        redraw = np.full((48, 64, 4), [118, 118, 118, 255], np.uint8)
        design[8:40, 8:56] = [170, 160, 130]
        redraw[8:40, 8:56, :3] = [140, 145, 150]
        redraw[..., 3] = np.arange(64, dtype=np.uint8)[None] * 4
        return design, redraw

    def test_zero_transfer_equals_chroma_lock_on_uniform_hull(self):
        design, redraw = self.hull()
        expected = chroma_lock(design, redraw, (118, 118, 118), 2.5)
        actual = camo_lock(design, redraw, l_strength=0, l_base=0, chroma_gain=1)
        np.testing.assert_array_equal(actual, expected)
        np.testing.assert_array_equal(actual[..., 3], redraw[..., 3])

    def test_chroma_gain_increases_hull_chroma_and_preserves_alpha_background(self):
        design, redraw = self.hull()
        base = camo_lock(design, redraw, l_strength=0)
        boosted = camo_lock(design, redraw, l_strength=0, chroma_gain=1.5)
        def chroma(rgb):
            lab = cv2.cvtColor(rgb[..., :3].astype(np.float32) / 255, cv2.COLOR_RGB2LAB)
            return np.hypot(lab[..., 1], lab[..., 2])
        self.assertGreater(chroma(boosted)[12:36, 12:52].mean(), chroma(base)[12:36, 12:52].mean() * 1.4)
        np.testing.assert_array_equal(boosted[..., 3], redraw[..., 3])
        np.testing.assert_array_equal(boosted[:8], redraw[:8])

    def test_design_camouflage_lightness_returns_without_repainting_house_colour(self):
        design, redraw = self.hull()
        design[12:24, 12:28] = [120, 112, 90]
        design[28:36, 32:48] = [200, 190, 155]
        design[20:28, 28:36] = [220, 20, 20]
        redraw[20:28, 28:36, :3] = [200, 30, 30]
        base = camo_lock(design, redraw, l_strength=0)
        locked = camo_lock(design, redraw)
        lab = lambda rgb: cv2.cvtColor(rgb[..., :3].astype(np.float32) / 255, cv2.COLOR_RGB2LAB)
        self.assertLess(lab(locked)[16:20, 16:24, 0].mean(), lab(base)[16:20, 16:24, 0].mean() - 2)
        np.testing.assert_array_equal(locked[22:26, 30:34], redraw[22:26, 30:34])

    def test_random_inputs_are_bit_identical_to_prototype_including_zero_transfer_rounding(self):
        rng = np.random.default_rng(2026)
        for channels in (3, 4):
            design = rng.integers(0, 256, (32, 32, 3), dtype=np.uint8)
            redraw = rng.integers(0, 256, (32, 32, channels), dtype=np.uint8)
            original_design, original_redraw = design.copy(), redraw.copy()
            for kwargs in ({}, {"l_strength": 0, "l_base": 0, "chroma_gain": 1},
                           {"sigma_ab": 1.2, "l_lo": 0.8, "l_hi": 4.0, "l_strength": 0.9,
                            "l_base": 0.3, "l_base_sigma": 2.0, "paint_chroma": 35.0, "chroma_gain": 1.4}):
                with self.subTest(channels=channels, kwargs=kwargs):
                    np.testing.assert_array_equal(camo_lock(design, redraw, **kwargs),
                                                  _prototype_camo_lock(design, redraw, **kwargs))
            np.testing.assert_array_equal(design, original_design)
            np.testing.assert_array_equal(redraw, original_redraw)
            # The reviewed formula makes one extra Lab round-trip even with transfer disabled.
            expected = chroma_lock(design, redraw, tuple(int(v) for v in design[0, 0]), 2.5)
            actual = camo_lock(design, redraw, l_strength=0, l_base=0, chroma_gain=1)
            self.assertLessEqual(np.abs(actual.astype(int) - expected).max(), 1)

    def test_lock_cli_keeps_legacy_defaults_and_routes_each_new_option_to_camo(self):
        design, redraw = self.hull()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            Image.fromarray(design).save(root / 'design.png')
            Image.fromarray(redraw).save(root / 'redraw.png')
            args = ['lock', '--design', str(root / 'design.png'), '--redraw', str(root / 'redraw.png'),
                    '--out', str(root / 'locked.png'), '--sigma', '2.5']
            projection.main([*args, '--strength', '0.3'])
            with Image.open(root / 'locked.png') as image:
                self.assertEqual(image.mode, 'RGBA')
                np.testing.assert_array_equal(np.array(image), chroma_lock(design, redraw, sigma=2.5, strength=0.3))
            for flag, value in (('--l-strength', 0.6), ('--l-lo', 2.0), ('--l-hi', 5.0),
                                ('--l-base', 0.4), ('--chroma-gain', 1.5)):
                with self.subTest(flag=flag), mock.patch.object(projection, 'camo_lock', wraps=camo_lock) as camo:
                    projection.main([*args, flag, str(value)])
                    kwargs = {'sigma_ab': 2.5, 'l_strength': 0.0, 'l_lo': 1.5, 'l_hi': 8.0,
                              'l_base': 0.0, 'chroma_gain': 1.0}
                    kwargs[flag[2:].replace('-', '_')] = value
                    camo.assert_called_once()
                    self.assertEqual(camo.call_args.kwargs, kwargs)
                    with Image.open(root / 'locked.png') as image:
                        np.testing.assert_array_equal(np.array(image), camo_lock(design, redraw, **kwargs))


if __name__ == '__main__':
    unittest.main()
