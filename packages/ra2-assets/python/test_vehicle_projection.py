"""Asset-free projection builder contracts; run with unittest discovery."""
import json
from pathlib import Path
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
