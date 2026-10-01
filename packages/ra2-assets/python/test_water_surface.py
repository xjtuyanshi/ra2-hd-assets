"""Synthetic water-surface tests, compatible with pytest and unittest discovery."""

from pathlib import Path
import tempfile
import unittest

import numpy as np
from PIL import Image

import water_surface as ws


class WaterSurfaceTests(unittest.TestCase):
    def test_seamless_wrap_differences_match_interior_without_losing_contrast(self):
        rng = np.random.default_rng(12)
        image = rng.normal(0.4, 0.08, (256, 256, 3)).astype(np.float32)
        y, x = np.indices(image.shape[:2])
        image += (0.3 * (x + y) / 255)[..., None]
        original = image.copy()
        result = ws.seamless(image)
        np.testing.assert_array_equal(image, original)
        for axis in (0, 1):
            seam = np.abs(np.take(result, -1, axis) - np.take(result, 0, axis)).mean()
            interior = np.abs(np.diff(result, axis=axis)).mean()
            self.assertGreater(seam / interior, 0.7)
            self.assertLess(seam / interior, 1.3)
        noise = rng.normal(0.5, 0.08, image.shape).astype(np.float32)
        compensated = ws.seamless(noise)
        # The middle of the blend would lose sqrt(2) in contrast without variance compensation.
        self.assertAlmostEqual(compensated[25:33, 80:180].std() / noise.std(), 1, delta=0.12)

    def test_speckled_glint_coverage_tracks_low_percentile(self):
        rng = np.random.default_rng(13)
        chop = rng.uniform(0.15, 0.35, (256, 256, 3)).astype(np.float32)
        bright = rng.random(chop.shape[:2]) < 0.1
        chop[bright] += 0.5
        foam = rng.random(chop.shape, dtype=np.float32)
        for low in (85, 93.5, 97):
            result = ws.prepare(chop, foam, (low, 99.6))
            self.assertAlmostEqual((result.glint > 0).mean() * 100, 100 - low, delta=0.1)

    def test_channel_encoding_and_gain(self):
        chop = np.full((48, 64, 3), 0.5, np.float32)
        foam = np.full_like(chop, 0.08 + 0.8 * 0.25)
        result = ws.prepare(chop, foam, glint_gain=0)
        self.assertEqual(result.rgba.shape, (48, 64, 4))
        self.assertEqual(result.rgba.dtype, np.uint8)
        np.testing.assert_allclose(result.rgba[..., 0], 128, atol=1)
        np.testing.assert_array_equal(result.rgba[..., 1], 0)
        np.testing.assert_allclose(result.rgba[..., 2], 64, atol=1)
        np.testing.assert_array_equal(result.rgba[..., 3], 255)

    def test_cli_resizes_writes_diagnostic_and_keeps_inputs(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            image = np.random.default_rng(2).integers(0, 256, (45, 71, 3), np.uint8)
            for name in ("chop", "foam"):
                Image.fromarray(image).save(root / f"{name}.png")
            before = {p: p.read_bytes() for p in root.iterdir()}
            out = root / "result/surface.png"
            self.assertEqual(ws.main(["--chop", str(root / "chop.png"), "--foam", str(root / "foam.png"),
                                      "--out", str(out), "--size", "64", "--glint-percentiles", "90", "99",
                                      "--glint-gain", "0.5"]), 0)
            with Image.open(out) as result:
                self.assertEqual((result.size, result.mode), ((64, 64), "RGBA"))
            self.assertTrue(out.with_name("surface_chop_seamless.png").is_file())
            for path, content in before.items():
                self.assertEqual(path.read_bytes(), content)

    def test_invalid_percentiles_and_gain_are_rejected(self):
        image = np.ones((16, 16, 3), np.float32)
        for percentiles in ((99, 90), (-1, 99), (93, 101), (99, 99)):
            with self.assertRaisesRegex(ValueError, "percentiles"):
                ws.prepare(image, image, percentiles)
        with self.assertRaisesRegex(ValueError, "gain"):
            ws.prepare(image, image, glint_gain=float("nan"))


if __name__ == "__main__":
    unittest.main()
