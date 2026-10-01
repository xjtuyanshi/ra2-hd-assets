"""Synthetic cliff-foot stripe tests, compatible with pytest and unittest discovery."""

from pathlib import Path
import tempfile
import unittest

import numpy as np
from PIL import Image

import cliff_foot_stripe as cfs


def scene():
    terrain = np.full((100, 160, 4), (42, 64, 68, 255), np.uint8)
    terrain[15:48, 20:80, :3] = (35, 46, 48)  # Dark wall above the waterline.
    terrain[48:51, 20:80, :3] = 185
    terrain[46:53, 125:140, :3] = 185  # At the waterline, but far from any cliff.
    terrain[..., 3] = np.arange(160, dtype=np.uint8)[None, :]
    water = np.zeros(terrain.shape[:2], np.uint8)
    water[51:] = 255
    ignore = np.zeros_like(water)
    ignore[15:48, 20:80] = 255
    return terrain, water, ignore


class CliffFootStripeTests(unittest.TestCase):
    def test_stripe_removed_but_distant_grey_and_alpha_untouched(self):
        terrain, water, ignore = scene()
        original = terrain.copy()
        result, selected = cfs.prepare(terrain, water, ignore)
        self.assertTrue((selected[48:51, 22:78] == 255).all())
        stripe = result[48:51, 25:75, :3].astype(float)
        neighbours = (terrain[45, 25:75, :3].astype(float) + terrain[54, 25:75, :3]) / 2
        self.assertLess(np.abs(stripe - neighbours).mean(), 15)
        np.testing.assert_array_equal(result[46:53, 125:140], terrain[46:53, 125:140])
        np.testing.assert_array_equal(result[..., 3], terrain[..., 3])
        np.testing.assert_array_equal(result[selected == 0], terrain[selected == 0])
        np.testing.assert_array_equal(terrain, original)

    def test_no_cliff_or_high_value_threshold_leaves_terrain_unchanged(self):
        terrain, water, ignore = scene()
        for selected_ignore, options in ((np.zeros_like(ignore), {}), (ignore, {"value": 200})):
            result, selected = cfs.prepare(terrain, water, selected_ignore, **options)
            np.testing.assert_array_equal(result, terrain)
            self.assertFalse(selected.any())

    def test_cli_writes_optional_selection_with_explicit_paths(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            for name, array in zip(("terrain", "water", "ignore"), scene()):
                Image.fromarray(array).save(root / f"{name}.png")
            before = {p: p.read_bytes() for p in root.iterdir()}
            out = root / "out/terrain.png"
            selection = root / "mask/stripe.png"
            self.assertEqual(cfs.main(["--terrain", str(root / "terrain.png"), "--water-mask", str(root / "water.png"),
                                       "--shore-ignore", str(root / "ignore.png"), "--out", str(out),
                                       "--mask-out", str(selection), "--saturation", "0.25", "--value", "120",
                                       "--vertical-reach", "6", "--cliff-reach", "10", "--inpaint-radius", "4"]), 0)
            for path, mode in ((out, "RGBA"), (selection, "L")):
                with Image.open(path) as result:
                    self.assertEqual((result.size, result.mode), ((160, 100), mode))
            for path, content in before.items():
                self.assertEqual(path.read_bytes(), content)

    def test_mismatched_masks_and_invalid_parameters_fail(self):
        terrain, water, ignore = scene()
        with self.assertRaisesRegex(ValueError, "same dimensions"):
            cfs.prepare(terrain, water[:-1], ignore)
        with self.assertRaisesRegex(ValueError, "radius"):
            cfs.prepare(terrain, water, ignore, inpaint_radius=0)


if __name__ == "__main__":
    unittest.main()
