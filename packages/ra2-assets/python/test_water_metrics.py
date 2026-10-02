"""Synthetic water metrics tests, compatible with pytest and unittest discovery."""

from contextlib import redirect_stdout
import io
import json
from pathlib import Path
import tempfile
import unittest

import numpy as np
from PIL import Image

import water_metrics as wm


def water_scene() -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """Build a sandy rectangle shore with cool shallows and offshore specks."""
    rgb = np.full((1050, 1680, 3), (200, 170, 120), np.uint8)
    water = np.zeros(rgb.shape[:2], bool)
    water[150:900, 180:1500] = True
    rgb[water] = (20, 60, 80)
    # The 12-pixel band is brighter than open water but remains blue-green.
    interior = np.zeros_like(water)
    interior[162:888, 192:1488] = True
    rgb[water & ~interior] = (65, 115, 145)
    warm = np.zeros_like(water)
    blue = np.zeros_like(water)
    # Distances from the left shore are ~1.6, ~2.5, and >3 cells.
    # Several tiny distant specks keep the >3-cell share above 0.05%, which
    # remains visible at the scratch script's one-decimal percentage precision.
    for x in (264, 310, 500, 600, 700, 800, 900):
        warm[475:489, x - 3:x + 3] = True
    for x in (265, 310, 550, 650, 750, 850, 950):
        blue[575:589, x - 3:x + 3] = True
    rgb[warm] = (240, 230, 190)
    rgb[blue] = (150, 210, 250)
    return rgb, water, warm, blue


class WaterMetricsTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.rgb, cls.expected_water, cls.warm, cls.blue = water_scene()
        cls.water, cls.L, cls.lab = wm.segment(cls.rgb)
        cls.distance = wm.shore_distance(cls.water)

    def test_segment_finds_rectangle_and_preserves_input(self):
        before = self.rgb.copy()
        water, L, lab = wm.segment(self.rgb)
        iou = (water & self.expected_water).sum() / (water | self.expected_water).sum()
        self.assertGreater(iou, 0.9)
        self.assertEqual(water.dtype, np.dtype(bool))
        self.assertEqual(L.shape, water.shape)
        self.assertEqual(lab.shape, self.rgb.shape)
        self.assertTrue(np.issubdtype(L.dtype, np.floating))
        self.assertTrue(np.issubdtype(lab.dtype, np.floating))
        np.testing.assert_array_equal(self.rgb, before)

    def test_distance_grows_inward_and_stretches_y(self):
        d = self.distance
        self.assertEqual(d.shape, self.water.shape)
        self.assertEqual(float(d[0, 0]), 0)
        self.assertLess(d[525, 185], d[525, 205])
        self.assertLess(d[525, 205], d[525, 260])
        self.assertLess(d[525, 260], d[525, 700])
        self.assertAlmostEqual(float(d[170, 840] / d[525, 200]), 2, delta=0.1)
        doubled_cell = wm.shore_distance(self.water, cell=104)
        np.testing.assert_allclose(doubled_cell, d / 2)

    def test_profile_lightness_falls_from_shallow_band(self):
        result = wm.shore_profile(self.rgb)
        profile = result["profile"]
        self.assertEqual(len(profile), len(wm.BINS) - 1)
        self.assertGreater(profile[0]["L"], profile[5]["L"] + 10)
        self.assertGreater(result["shallowPeakL"], result["openMeanL"] + 10)
        self.assertGreater(result["shallowWidth"], 0)
        self.assertLessEqual(result["shallowWidth"], 0.6)
        self.assertEqual(len(result["openLpct[5,25,50,75,95,99]"]), 6)
        self.assertGreater(result["openCyanSheenPct"], 0)
        self.assertEqual(result["surfWhitePct"], 0)
        json.dumps(result, allow_nan=False)

    def test_highlights_stay_in_the_specks_distance_bins(self):
        rows = wm.highlight_distribution(self.rgb)
        self.assertEqual(len(rows), len(wm.HIGHLIGHT_BINS) - 1)
        expected_warm_bins = set()
        expected_blue_bins = set()
        for i, (lo, hi) in enumerate(zip(wm.HIGHLIGHT_BINS[:-1], wm.HIGHLIGHT_BINS[1:])):
            in_bin = self.water & (self.distance > lo) & (self.distance <= hi)
            n = max(in_bin.sum(), 1)
            if (in_bin & self.warm).any():
                expected_warm_bins.add(i)
            if (in_bin & self.blue).any():
                expected_blue_bins.add(i)
            self.assertEqual(rows[i]["warm"], round(float(100 * (in_bin & self.warm).sum() / n), 1))
            self.assertGreaterEqual(rows[i]["hi"], max(rows[i]["warm"], rows[i]["blue"]))
        self.assertEqual({i for i, row in enumerate(rows) if row["warm"] > 0}, expected_warm_bins)
        self.assertEqual({i for i, row in enumerate(rows[3:], 3) if row["blue"] > 0}, expected_blue_bins)
        self.assertEqual(expected_warm_bins, {3, 4, 5})

    def test_bands_are_finite_and_detect_stripe_orientation(self):
        for axis, horizontal in ((0, True), (1, False)):
            rgb = self.rgb.copy()
            # Replace specks before adding stripes so uint8 highlights cannot wrap.
            rgb[self.warm | self.blue] = (20, 60, 80)
            coordinate = np.arange(rgb.shape[axis])
            stripe = np.where((coordinate // 6) % 2, 20, 0).astype(np.uint8)
            if horizontal:
                rgb[..., 1] += stripe[:, None]
                rgb[..., 2] += stripe[:, None]
            else:
                rgb[..., 1] += stripe[None, :]
                rgb[..., 2] += stripe[None, :]
            result = wm.band_structure(rgb)
            self.assertEqual(set(result["bands"]), {"fine", "wave", "mid", "broad"})
            values = [*result["bands"].values(), result["vert/horiz grad"],
                      *result["meanRGB"], result["p95-p50"]]
            self.assertTrue(np.isfinite(values).all())
            self.assertGreater(result["bands"]["wave"], 0)
            if horizontal:
                self.assertGreater(result["vert/horiz grad"], 1)
            else:
                self.assertLess(result["vert/horiz grad"], 1)

    def test_box_uses_channel_mean_percentiles(self):
        rgb = self.rgb.copy()
        ramp = np.arange(100, dtype=np.uint8)
        rgb[300:400, 600:700] = np.stack((ramp + 10, ramp + 40, ramp + 60), axis=1)[None, :, :]
        result = wm.box_crest_trough(rgb, (600, 300, 700, 400))
        np.testing.assert_allclose(result["mean"], (59.5, 89.5, 109.5))
        np.testing.assert_allclose(result["trough"], (24.5, 54.5, 74.5))
        np.testing.assert_allclose(result["crest"], (100.5, 130.5, 150.5))
        self.assertTrue((np.array(result["crest"]) > result["trough"]).all())

    def test_flat_selections_are_json_null(self):
        flat = self.rgb.copy()
        flat[self.expected_water] = (20, 60, 80)
        profile = wm.shore_profile(flat)
        self.assertIsNone(profile["openTop5rgb"])
        result = wm.box_crest_trough(flat, (400, 400, 500, 500))
        self.assertIsNone(result["trough"])
        self.assertEqual(result["crest"], [20.0, 60.0, 80.0])
        json.dumps(profile, allow_nan=False)

    def test_cli_all_commands_resize_and_print_one_line_per_image(self):
        with tempfile.TemporaryDirectory() as temporary:
            paths = [Path(temporary) / "small.png", Path(temporary) / "other.png"]
            small = Image.fromarray(self.rgb).resize((840, 525), Image.Resampling.LANCZOS)
            for path in paths:
                small.save(path)
            before = [path.read_bytes() for path in paths]
            resized = np.asarray(small.resize(wm.SIZE, Image.Resampling.LANCZOS))
            cases = [("profile", [], wm.shore_profile(resized)),
                     ("bands", [], wm.band_structure(resized)),
                     ("highlights", [], wm.highlight_distribution(resized)),
                     ("box", ["400,300,900,700"], wm.box_crest_trough(resized, (400, 300, 900, 700)))]
            for command, extra, expected in cases:
                output = io.StringIO()
                with redirect_stdout(output):
                    status = wm.main([command, *extra, *map(str, paths)])
                self.assertEqual(status, 0)
                rows = [json.loads(line) for line in output.getvalue().splitlines()]
                self.assertEqual(len(rows), len(paths))
                for path, row in zip(paths, rows):
                    self.assertEqual(row, {"image": str(path), "metrics": expected})
            for path, content in zip(paths, before):
                self.assertEqual(path.read_bytes(), content)

    def test_invalid_inputs_and_missing_open_water_fail_explicitly(self):
        with self.assertRaisesRegex(ValueError, "uint8"):
            wm.segment(self.rgb.astype(np.float32))
        with self.assertRaisesRegex(ValueError, "positive"):
            wm.shore_distance(self.water, cell=0)
        with self.assertRaisesRegex(ValueError, "nonempty"):
            wm.box_crest_trough(self.rgb, (100, 100, 100, 200))
        land = np.full_like(self.rgb, (200, 170, 120))
        for measure in (wm.shore_profile, wm.band_structure):
            with self.assertRaisesRegex(ValueError, "open water"):
                measure(land)
        for row in wm.highlight_distribution(land):
            self.assertEqual((row["hi"], row["warm"], row["blue"]), (0, 0, 0))


if __name__ == "__main__":
    unittest.main()
