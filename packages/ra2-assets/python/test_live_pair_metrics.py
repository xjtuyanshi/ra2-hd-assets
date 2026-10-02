"""Asset-free live-pair crops and house-hue counts from synthetic whole-guest frames."""

import contextlib
import io
import json
from pathlib import Path
import tempfile
import unittest

import cv2
import numpy as np
from PIL import Image, ImageFont

import live_pair_metrics as metrics
from live_pair_metrics import engine_box_to_pixels, house_pixels, side_by_side


class LivePairMetricsTests(unittest.TestCase):
    def test_engine_box_maps_1x_2x_and_independent_axis_scales(self):
        box = (100, 200, 140, 230)
        self.assertEqual(engine_box_to_pixels(box, (1152, 744)), box)
        self.assertEqual(engine_box_to_pixels(box, (2304, 1488)), (200, 400, 280, 460))
        self.assertEqual(engine_box_to_pixels(box, (2304, 744)), (200, 200, 280, 230))
        self.assertEqual(engine_box_to_pixels((1, 1, 3, 3), (1728, 1116)), (1, 1, 5, 5))
        self.assertEqual(engine_box_to_pixels((0, 0, 1152, 744), (1728, 1116)), (0, 0, 1728, 1116))
        self.assertEqual(engine_box_to_pixels((0, 0, 1152, 744), (1277, 823)), (0, 0, 1277, 823))

    def test_invalid_engine_boxes_are_refused(self):
        for box in ((-1, 0, 10, 10), (0, 0, 1153, 10), (0, 0, 10, 745),
                    (10, 0, 10, 10), (0, 10, 10, 0), (0, 0, float('nan'), 10)):
            with self.subTest(box=box), self.assertRaises(ValueError):
                engine_box_to_pixels(box, (1152, 744))

    def test_hue_wrap_inclusive_bounds_and_saturation_value_filters(self):
        hsv = np.array([[[0, 255, 255], [179, 255, 255], [170, 255, 255], [10, 255, 255],
                         [90, 255, 255], [0, 90, 255], [0, 255, 50]]], dtype=np.uint8)
        rgb = cv2.cvtColor(hsv, cv2.COLOR_HSV2RGB)
        self.assertEqual(house_pixels(rgb, (170, 10)), 4)
        self.assertEqual(house_pixels(rgb, (0, 10)), 2)
        self.assertEqual(house_pixels(rgb, (90, 90)), 1)
        self.assertEqual(house_pixels(rgb, (170, 10), smin=80, vmin=40), 6)
        self.assertEqual(house_pixels(rgb, (0, 180), smin=0, vmin=0), 7)

    def test_invalid_hue_and_thresholds_are_refused(self):
        image = np.zeros((1, 1, 3), dtype=np.uint8)
        for hue, smin, vmin in (((-1, 10), 100, 60), ((0, 181), 100, 60),
                                ((0, 10), 256, 60), ((0, 10), 100, -1)):
            with self.subTest(hue=hue, smin=smin, vmin=vmin), self.assertRaises(ValueError):
                house_pixels(image, hue, smin, vmin)

    def test_side_by_side_has_native_size_white_gap_and_no_labels_without_font(self):
        orig = Image.new('RGB', (40, 30), 'red')
        hd = Image.new('RGB', (80, 60), 'blue')
        result = side_by_side(orig, hd, labels=('原版', 'HD'))
        self.assertEqual(result.size, (128, 60))
        pixels = np.asarray(result)
        np.testing.assert_array_equal(pixels[:30, :40], np.asarray(orig))
        np.testing.assert_array_equal(pixels[:, 48:], np.asarray(hd))
        self.assertTrue((pixels[:, 40:48] == 255).all())
        self.assertTrue((pixels[30:, :40] == 255).all())

    def test_supplied_font_adds_a_label_strip_above_unchanged_crops(self):
        orig = Image.new('RGB', (100, 30), 'red')
        hd = Image.new('RGB', (100, 30), 'blue')
        result = side_by_side(orig, hd, labels=('Original', 'HD'), font=ImageFont.load_default())
        strip = result.height - orig.height
        self.assertGreater(strip, 8)
        self.assertEqual(result.width, 208)
        pixels = np.asarray(result)
        self.assertTrue((pixels[:strip] < 255).any())
        self.assertTrue((pixels[:, 100:108] == 255).all())
        np.testing.assert_array_equal(pixels[strip:, :100], np.asarray(orig))
        np.testing.assert_array_equal(pixels[strip:, 108:], np.asarray(hd))

    def test_long_labels_do_not_paint_into_the_white_gap_of_narrow_crops(self):
        image = Image.new('RGB', (8, 8), 'red')
        result = side_by_side(image, image, labels=('Original', 'HD'), font=ImageFont.load_default())
        self.assertEqual(result.width, 24)
        self.assertTrue((np.asarray(result)[:, 8:16] == 255).all())

    def fake_pairs(self, root):
        orig = np.zeros((744, 1152, 3), dtype=np.uint8)
        hd = np.zeros((1488, 2304, 3), dtype=np.uint8)
        orig[202:207, 102:110] = (255, 0, 0)  # 40 pixels in the engine box.
        hd[404:414, 204:220] = (255, 0, 0)  # Same rectangle at 2x: 160 pixels.
        # Matching hue outside the box must not contribute.
        orig[0:20, 0:20] = (255, 0, 0)
        hd[0:40, 0:40] = (255, 0, 0)
        Image.fromarray(orig).save(root / 'orig-02.png')
        Image.fromarray(hd).save(root / 'hd-02.png')
        return ['--pairs', str(root), '--id', '02', '--box', '100', '200', '140', '230']

    def test_house_cli_counts_same_engine_box_and_ratio_at_different_scales(self):
        with tempfile.TemporaryDirectory() as directory:
            args = self.fake_pairs(Path(directory))
            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                metrics.main(['house', *args, '--hue', '170', '10'])
            self.assertEqual(json.loads(output.getvalue()), {'orig': 40, 'hd': 160, 'ratio': 4.0})
            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                metrics.main(['house', *args, '--hue', '50', '70'])
            self.assertEqual(json.loads(output.getvalue()), {'orig': 0, 'hd': 0, 'ratio': 0.0})

    def test_house_cli_zero_original_count_uses_one_as_denominator(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            args = self.fake_pairs(root)
            Image.new('RGB', (1152, 744), 'black').save(root / 'orig-02.png')
            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                metrics.main(['house', *args, '--hue', '170', '10'])
            self.assertEqual(json.loads(output.getvalue()), {'orig': 0, 'hd': 160, 'ratio': 160.0})

    def test_crop_cli_writes_both_crops_and_gap_without_a_font(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            args = self.fake_pairs(root)
            out = root / 'crops/pair.png'
            metrics.main(['crop', *args, '--out', str(out), '--labels', '原版', 'HD'])
            with Image.open(out) as result:
                self.assertEqual(result.size, (128, 60))
                self.assertEqual(result.getpixel((2, 2)), (255, 0, 0))
                self.assertEqual(result.getpixel((52, 4)), (255, 0, 0))
                self.assertEqual(result.getpixel((40, 0)), (255, 255, 255))


if __name__ == '__main__':
    unittest.main()
