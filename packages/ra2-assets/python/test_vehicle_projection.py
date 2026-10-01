"""Asset-free projection builder contracts; run with unittest discovery."""
import json
from pathlib import Path
import tempfile
import unittest

import cv2
import numpy as np
from PIL import Image

from vehicle_projection import (BAKE_JACOBIAN, Frame, Registration, affine_point, build, build_index,
                                linear_rgb, pack_frames, paint_channels, ramp_position, redraw_alpha, register,
                                sheet_matrix, similarity, steel_grade, warp)


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

if __name__ == '__main__':
    unittest.main()
