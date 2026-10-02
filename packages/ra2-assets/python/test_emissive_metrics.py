"""Asset-free tests: python3 -B -m unittest discover -s packages/ra2-assets/python -p 'test_emissive_metrics.py'."""

from __future__ import annotations

import contextlib
import io
import json
import tempfile
import unittest
from pathlib import Path

import numpy as np
from PIL import Image

import emissive_metrics as em


def scene() -> np.ndarray:
    """Brown ground with a pale glass disc (radius 30 at 80,70), its lower third hidden by a brick block."""
    img = np.zeros((160, 200, 3), np.float32)
    img[...] = (110 / 255, 80 / 255, 60 / 255)
    yy, xx = np.mgrid[0:160, 0:200]
    disc = np.hypot(xx - 80, yy - 70) <= 30
    img[disc] = (200 / 255, 215 / 255, 250 / 255)
    img[90:, 40:120] = (150 / 255, 70 / 255, 50 / 255)
    return img


class EmissiveMetricsTests(unittest.TestCase):
    def test_review_pixel_classes(self):
        px = np.array(
            [[[60, 115, 255], [225, 252, 255], [200, 205, 250], [130, 220, 255], [235, 230, 245], [40, 40, 120]]],
            np.float32,
        ) / 255
        satblue, lavender = em.classes(px)
        # Saturated body blue counts; the cyan-white core (hue < 200) and cyan mid ramp count as neither class.
        self.assertEqual(satblue[0].tolist(), [True, False, False, False, False, False])
        # Pale blue-violet glass is the lavender veil class; a dark saturated blue is too dark for either.
        self.assertEqual(lavender[0].tolist(), [False, False, True, False, True, False])

    def test_counts_in_box(self):
        img = np.zeros((10, 10, 3), np.float32)
        img[2:5, 2:6] = (40 / 255, 100 / 255, 1.0)
        self.assertEqual(em.counts(img, (0, 0, 10, 10)), {'satblue': 12, 'lavender': 0})
        self.assertEqual(em.counts(img, (0, 0, 4, 10))['satblue'], 6)

    def test_fit_sphere_ignores_the_hidden_foot(self):
        fit = em.fit_sphere(scene(), (30, 20, 140, 130), ymax=88)
        self.assertAlmostEqual(fit['cx'], 80, delta=1)
        self.assertAlmostEqual(fit['cy'], 70, delta=1)
        self.assertAlmostEqual(fit['radius'], 30, delta=1)

    def test_fit_requires_glass(self):
        with self.assertRaises(ValueError):
            em.fit_sphere(np.zeros((40, 40, 3), np.float32), (0, 0, 40, 40))

    def test_reach_in_engine_pixels(self):
        base = scene()
        img = base.copy()
        img[70, 80:150] = 1.0  # a bolt 70 device px long to the right of the centre
        r = em.reach(base, img, (80, 70), (0, 0, 200, 160), scale=2)
        self.assertEqual(r['changed'], 70)
        self.assertAlmostEqual(r['max'], 34.5, delta=0.01)
        self.assertEqual(em.reach(base, base, (80, 70), (0, 0, 200, 160))['changed'], 0)


class ContainmentMetricsTests(unittest.TestCase):
    def test_silhouette_keeps_largest_nearby_components_and_fills_hole(self):
        absent = np.zeros((48, 64, 3), np.float32)
        present = absent.copy()
        present[10:30, 10:30] = 0.5
        present[15:20, 15:20] = 0  # an enclosed hole, filled after component selection
        present[12:15, 31:33] = 0.5  # two pixels from the largest component, retained at default dilation
        present[35:40, 40:45] = 0.5  # a separate smaller square
        present[1, 60] = 1  # a distant one-pixel speck
        expected = np.zeros(present.shape[:2], bool)
        expected[10:30, 10:30] = True
        np.testing.assert_array_equal(em.silhouette_mask(present, absent, dilate=0), expected)
        expected[12:15, 31:33] = True
        mask = em.silhouette_mask(present, absent)
        np.testing.assert_array_equal(mask, expected)
        self.assertEqual(int(mask.sum()), 406)
        self.assertEqual(em.mask_bbox(mask), [10, 10, 33, 30])
        self.assertEqual(float(present[16, 16, 0]), 0)  # helpers do not mutate inputs

    def test_mask_threshold_is_inclusive_and_uses_max_channel(self):
        absent = np.zeros((6, 6, 3), np.float32)
        present = absent.copy()
        present[1:3, 1:3, 2] = 0.125
        present[4, 4] = 0.1  # summed RGB would pass, but max channel does not
        mask = em.silhouette_mask(present, absent, threshold=0.125)
        self.assertEqual(int(mask.sum()), 4)
        self.assertEqual(em.mask_bbox(mask), [1, 1, 3, 3])
        # Removing a bright building is still a difference, not just a positive change.
        np.testing.assert_array_equal(em.silhouette_mask(absent, present, threshold=0.125), mask)
        empty = em.silhouette_mask(absent, absent)
        self.assertFalse(empty.any())
        self.assertIsNone(em.mask_bbox(empty))

    def test_components_join_diagonals_and_bridge_multiple_runs(self):
        mask = np.array([[1, 0, 1, 0, 0], [0, 1, 0, 0, 0], [1, 1, 1, 0, 1]], bool)
        labels, areas = em.connected_components(mask)
        self.assertEqual(sorted(areas[1:][areas[1:] > 0].tolist()), [1, 6])
        self.assertEqual(labels[0, 0], labels[0, 2])
        self.assertNotEqual(labels[0, 0], labels[2, 4])
        diagonal = np.eye(2, dtype=bool)
        _, areas4 = em.connected_components(diagonal, connectivity=4)
        self.assertEqual(areas4[1:].tolist(), [1, 1])

    def test_dilation_clips_edges_without_wrapping(self):
        mask = np.zeros((5, 6), bool)
        mask[0, 0] = True
        expected = np.zeros_like(mask)
        expected[:3, :3] = True
        np.testing.assert_array_equal(em.dilate_square(mask, 2), expected)
        self.assertEqual(int(mask.sum()), 1)

    def test_outside_blue_disc_spills_five_pixels_and_inside_disc_does_not(self):
        base = np.zeros((60, 60, 3), np.float32)
        polygon = np.array([[20, 20], [40, 20], [40, 40], [20, 40]])
        mask = em.polygon_mask(base.shape[:2], polygon)
        yy, xx = np.mgrid[:60, :60]
        disc = np.hypot(xx + 0.5 - 30, yy + 0.5 - 30) <= 15
        img = base.copy()
        img[disc] = (0.1, 0.2, 1)
        result = em.outside(base, img, mask)
        self.assertEqual(result['inside'], 400)
        self.assertEqual(result['outside'], 316)
        self.assertEqual(result['max_v_increase_outside'], 1)
        self.assertEqual(result['outside_clusters'], [[15, 15, 45, 45]])
        inside = base.copy()
        inside[np.hypot(xx + 0.5 - 30, yy + 0.5 - 30) <= 8] = (0.1, 0.2, 1)
        result = em.outside(base, inside, mask)
        self.assertEqual(result['inside'], 208)
        self.assertEqual(result['outside'], 0)
        self.assertEqual(result['max_v_increase_outside'], 0)
        self.assertEqual(result['outside_clusters'], [])

    def test_outside_detects_brightness_only_and_blueness_only(self):
        base = np.full((8, 10, 3), 0.5, np.float32)
        img = base.copy()
        img[1, 1] = 0.625  # V +0.125, unchanged blueness
        img[1, 2] = (0.375, 0.375, 0.5)  # unchanged V, blueness +0.125
        img[1, 3] = (0.5, 0.5, 0.625)  # both criteria, counted once
        img[1, 4] = 0.55  # below the threshold; still included in maximum V increase
        img[1, 5] = 0.25  # a darker neutral pixel is not an addition
        mask = np.zeros(base.shape[:2], bool)
        mask[1, 2] = True
        result = em.outside(base, img, mask, dv=0.125)
        self.assertEqual(result['outside'], 2)
        self.assertEqual(result['inside'], 1)
        self.assertEqual(result['max_v_increase_outside'], 0.125)
        self.assertEqual(result['outside_clusters'], [])  # a two-pixel cluster is below the area cutoff
        result = em.outside(base, img, mask, box=(4, 1, 6, 2), dv=0.125)
        self.assertEqual(result['outside'], 0)
        self.assertAlmostEqual(result['max_v_increase_outside'], 0.05, places=6)

    def test_outside_clusters_are_eight_connected_sorted_limited_and_box_relative(self):
        base = np.zeros((40, 60, 3), np.float32)
        img = base.copy()
        for x in (5, 12, 19, 26, 33, 40):
            img[8:10, x:x + 2, 2] = 1  # six four-pixel clusters; only five boxes are reported
        img[16:18, 5:7, 2] = 1
        img[18:20, 7:9, 2] = 1  # diagonal contact makes one eight-pixel cluster
        img[3, 3, 2] = 1  # outside the requested box
        result = em.outside(base, img, np.zeros(base.shape[:2], bool), box=(4, 6, 50, 25))
        self.assertEqual(result['outside'], 32)
        self.assertEqual(result['outside_clusters'], [
            [5, 16, 9, 20], [5, 8, 7, 10], [12, 8, 14, 10], [19, 8, 21, 10], [26, 8, 28, 10],
        ])
        empty = em.outside(base, img, np.zeros(base.shape[:2], bool), box=(70, 50, 80, 60))
        self.assertEqual(empty, {'outside': 0, 'inside': 0, 'max_v_increase_outside': 0.0, 'outside_clusters': []})

    def test_even_odd_polygon_fill_handles_concavity_winding_and_clipping(self):
        polygon = np.array([[2, 2], [8, 2], [8, 4], [4, 4], [4, 8], [2, 8]])
        expected = np.zeros((10, 10), bool)
        expected[2:4, 2:8] = True
        expected[4:8, 2:4] = True
        np.testing.assert_array_equal(em.polygon_mask(expected.shape, polygon), expected)
        np.testing.assert_array_equal(em.polygon_mask(expected.shape, polygon[::-1]), expected)
        clipped = em.polygon_mask((4, 4), np.array([[-2, -2], [2, -2], [2, 2], [-2, 2]]))
        self.assertEqual(int(clipped.sum()), 4)

    def test_footprint_corners_scale_custom_cell_and_height_hull(self):
        diamond = np.array([[100, 50], [280, 140], [160, 200], [-20, 110]])
        np.testing.assert_array_equal(em.footprint(100, 50, 3, 2, scale=2), diamond)
        np.testing.assert_array_equal(em.footprint(100, 50, 3, 2, cell=(120, 60)), diamond)
        np.testing.assert_array_equal(em.footprint(100, 50, 3, 2, height=40, scale=2),
                                      [[100, -30], [280, 60], [280, 140], [160, 200], [-20, 110], [-20, 30]])
        np.testing.assert_array_equal(em.footprint(100, 50, 3, 2),
                                      [[100, 50], [190, 95], [130, 125], [40, 80]])

    def test_pairgate_counts_ratio_outside_and_independent_flags(self):
        orig = np.zeros((20, 20, 3), np.float32)
        blue = (40 / 255, 100 / 255, 1)
        lavender = (200 / 255, 205 / 255, 250 / 255)
        polygon = np.array([[4, 4], [12, 4], [12, 12], [4, 12]])
        orig[5:7, 5:9] = blue  # eight blue inside
        orig[2, 5:7] = blue  # two blue outside
        orig[8, 5:7] = lavender  # two lavender inside
        orig[2, 8] = lavender  # one lavender outside
        orig[18, :] = blue  # excluded by the box
        hd = orig.copy()
        hd[7, 5] = blue  # ratio exactly 1.1
        hd[2, 9] = lavender  # a spill increase independent of saturated blue
        result = em.pairgate(orig, hd, (0, 0, 15, 15), polygon)
        self.assertEqual(result['orig'], {'satblue': 10, 'lavender': 3})
        self.assertEqual(result['hd'], {'satblue': 11, 'lavender': 4})
        self.assertEqual(result['satblue_ratio'], 1.1)
        self.assertEqual((result['outside_orig'], result['outside_hd']), (3, 4))
        self.assertTrue(result['pass_ratio'])
        self.assertFalse(result['pass_outside'])
        self.assertFalse(result['pass'])
        self.assertTrue(em.pairgate(orig, hd, (0, 0, 15, 15), polygon, tol=1)['pass'])
        result = em.pairgate(orig, hd, (0, 0, 15, 15), polygon, max_ratio=1.0, tol=1)
        self.assertFalse(result['pass_ratio'])
        self.assertTrue(result['pass_outside'])
        self.assertFalse(result['pass'])

    def test_pairgate_zero_original_blue_produces_finite_json(self):
        orig = np.zeros((8, 8, 3), np.float32)
        polygon = np.array([[1, 1], [7, 1], [7, 7], [1, 7]])
        result = em.pairgate(orig, orig, (0, 0, 8, 8), polygon)
        self.assertIsNone(result['satblue_ratio'])
        self.assertTrue(result['pass'])
        hd = orig.copy()
        hd[2, 2] = (0, 0, 1)
        result = em.pairgate(orig, hd, (0, 0, 8, 8), polygon)
        self.assertFalse(result['pass_ratio'])
        json.dumps(result, allow_nan=False)

    def test_new_command_file_outputs_and_pairgate_exit_status(self):
        with tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parent) as directory:
            root = Path(directory)
            absent, present, mask_path = (str(root / name) for name in ('absent.png', 'present.png', 'mask.png'))
            img = np.zeros((16, 16, 3), np.uint8)
            Image.fromarray(img).save(absent)
            img[4:12, 4:12, 2] = 255
            Image.fromarray(img).save(present)

            def run(args):
                output = io.StringIO()
                with contextlib.redirect_stdout(output):
                    status = em.main(args)
                self.assertEqual(status, 0)
                return output.getvalue().strip()

            self.assertEqual(json.loads(run(['mask', present, absent, mask_path])),
                             {'area': 64, 'bbox': [4, 4, 12, 12]})
            with Image.open(mask_path) as mask:
                self.assertEqual(mask.mode, 'L')
                self.assertEqual(set(np.asarray(mask).ravel().tolist()), {0, 255})
            poly = run(['footprint', '8', '4', '1', '1', '--cell', '8x8'])
            self.assertEqual(poly, '8.0,4.0;12.0,8.0;8.0,12.0;4.0,8.0')
            mask_result = json.loads(run(['outside', absent, present, '--mask', mask_path]))
            self.assertEqual((mask_result['inside'], mask_result['outside']), (64, 0))
            poly_result = json.loads(run(['outside', absent, present, '--poly', poly, '--box', '4,4,12,12']))
            self.assertEqual((poly_result['inside'], poly_result['outside']), (32, 32))
            gate = json.loads(run(['pairgate', absent, present, '0,0,16,16', '--poly', poly]))
            self.assertFalse(gate['pass_ratio'])
            self.assertFalse(gate['pass_outside'])
            self.assertEqual(gate['outside_hd'], 32)

    def test_outside_command_requires_exactly_one_boundary_source(self):
        for options in ([], ['--mask', 'unused.png', '--poly', '0,0;1,0;0,1']):
            with self.subTest(options=options), contextlib.redirect_stderr(io.StringIO()):
                self.assertEqual(em.main(['outside', 'unused.png', 'unused.png', *options]), 2)


if __name__ == '__main__':
    unittest.main()
