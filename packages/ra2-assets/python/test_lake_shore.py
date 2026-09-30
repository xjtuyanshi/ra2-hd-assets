"""Asset-free tests: python3 -B -m unittest discover -s packages/ra2-assets/python -p 'test_lake_shore.py'."""

from __future__ import annotations

from pathlib import Path
import tempfile
import unittest

import cv2
import numpy as np
from PIL import Image

import lake_shore as ls


def lake() -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    classification = np.full((180, 220, 3), (200, 170, 112), np.uint8)
    cv2.circle(classification, (140, 90), 52, (110, 135, 132), -1)
    cv2.circle(classification, (140, 90), 38, (45, 80, 110), -1)
    classification[25:40, 55:70] = (110, 135, 132)  # Disconnected shallow-coloured patch.
    water = np.zeros(classification.shape[:2], np.uint8)
    cv2.circle(water, (140, 90), 38, 255, -1)
    alpha = np.full((*water.shape, 1), 255, np.uint8)
    alpha[:4] = 37
    terrain = np.concatenate([classification, alpha], axis=-1)
    return classification, terrain, water


class LakeShoreTests(unittest.TestCase):
    def test_connected_shallows_soft_edge_dry_bed_and_alpha(self):
        classification, terrain, mask = lake()
        original = terrain.copy()
        result, extended, water = ls.prepare(classification, terrain, mask)
        np.testing.assert_array_equal(result[..., 3], terrain[..., 3])
        np.testing.assert_array_equal(terrain, original)
        self.assertEqual(mask[90, 185], 0)
        self.assertEqual(extended[90, 185], 255)
        self.assertEqual(extended[32, 62], 0)
        self.assertTrue((extended[75:105, 125:155] == 255).all())
        self.assertTrue(((extended > 0) & (extended < 255)).any())
        self.assertGreater(water.sum(), (mask > 127).sum())
        np.testing.assert_array_equal(result[160, 10], terrain[160, 10])
        bed = result[75:105, 125:155, :3]
        self.assertGreater(bed[..., 0].mean(), bed[..., 2].mean())
        self.assertGreater(bed[..., 0].std(), 2)
        self.assertFalse(np.array_equal(bed, terrain[75:105, 125:155, :3]))
        repeated, repeated_mask, _ = ls.prepare(classification, terrain, mask)
        np.testing.assert_array_equal(repeated, result)
        np.testing.assert_array_equal(repeated_mask, extended)

    def test_small_holes_fill_and_isolated_water_specks_disappear(self):
        classification, terrain, mask = lake()
        mask[86:94, 136:144] = 0
        mask[145:151, 25:31] = 255
        _, extended, _ = ls.prepare(classification, terrain, mask)
        self.assertEqual(extended[90, 140], 255)
        self.assertEqual(extended[148, 28], 0)

    def test_cli_writes_pngs_and_debug_without_changing_inputs(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            for name, array in zip(("classification", "terrain", "water"), lake()):
                Image.fromarray(array).save(root / f"{name}.png")
            before = {p: p.read_bytes() for p in root.glob("*.png")}
            output = root / "results/bed.png"
            water = root / "results/water.png"
            self.assertEqual(ls.main(["--classification", str(root / "classification.png"), "--terrain",
                                      str(root / "terrain.png"), "--water-mask", str(root / "water.png"),
                                      "--output", str(output), "--output-mask", str(water),
                                      "--debug-box", "80,60,200,130"]), 0)
            with Image.open(output) as image:
                self.assertEqual((image.mode, image.size), ("RGBA", (220, 180)))
            with Image.open(water) as image:
                self.assertEqual((image.mode, image.size), ("L", (220, 180)))
            with Image.open(output.with_name("bed_dbg.png")) as image:
                self.assertEqual(image.size, (240, 70))
            for path, content in before.items():
                self.assertEqual(path.read_bytes(), content)

    def test_invalid_dimensions_and_missing_land_samples_fail_explicitly(self):
        classification, terrain, mask = lake()
        with self.assertRaisesRegex(ValueError, "same dimensions"):
            ls.prepare(classification, terrain, mask[:-1])
        with self.assertRaisesRegex(ValueError, "surrounding land samples"):
            ls.prepare(classification, terrain, np.full_like(mask, 255))


if __name__ == "__main__":
    unittest.main()
