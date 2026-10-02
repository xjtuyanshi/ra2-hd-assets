"""Asset-free tests: python3 -B -m unittest discover -s packages/ra2-assets/python -p 'test_cliff_foot.py'."""

from __future__ import annotations

import base64
import json
from pathlib import Path
import tempfile
import unittest

import numpy as np
from PIL import Image

import cliff_foot as cf


def encoded(array: np.ndarray) -> str:
    return base64.b64encode(array.tobytes()).decode("ascii")


def cliff() -> tuple[dict, np.ndarray, np.ndarray]:
    heights = np.zeros((3, 3), np.uint8)
    heights[0, 0] = 3
    manifest = {
        "grid": {"width": 3, "height": 3},
        "cells": {"exists": encoded(np.ones((3, 3), np.uint8)), "height": encoded(heights),
                  "tile": encoded(np.zeros((3, 3), "<u2"))},
        "tiles": [{"rampType": 0}, {"rampType": 1}],
        "terrainMap": {"scale": 2, "originX": -100, "originY": -60},
    }
    terrain = np.full((320, 400, 4), (175, 105, 70, 255), np.uint8)
    terrain[:8, :, 3] = 29
    mask = np.zeros(terrain.shape[:2], np.uint8)
    mask[175:] = 255  # Leaves up to 24 px of dry rubble between the lake and some cliff feet.
    terrain[175:, :, :3] = (110, 105, 80)
    return manifest, terrain, mask


class CliffFootTests(unittest.TestCase):
    def test_three_cell_grid_levels_ignore_wet_foot_and_flood(self):
        manifest, terrain, mask = cliff()
        original = terrain.copy()
        result = cf.prepare(manifest, terrain, mask, flood_mask=True)
        self.assertEqual(result.level[50, 200], 3)
        self.assertEqual(result.level[120, 200], -1)
        self.assertEqual(result.level[220, 200], 0)
        self.assertEqual(result.level[0, 0], -1)
        self.assertEqual(result.ignore[50, 200], 255)  # High plateau.
        self.assertEqual(result.ignore[120, 200], 255)  # Wall inside the map.
        self.assertEqual(result.ignore[220, 200], 0)  # Open water.
        self.assertEqual(result.ignore[0, 0], 0)  # Exterior transparency is not a cliff.
        self.assertTrue(result.foot[179, 200])
        self.assertGreater(result.foot.sum(), 0)
        self.assertLess(result.terrain[166, 200, 0], terrain[166, 200, 0])
        np.testing.assert_array_equal(result.terrain[50, 200], terrain[50, 200])
        np.testing.assert_array_equal(result.terrain[220, 200], terrain[220, 200])
        np.testing.assert_array_equal(result.terrain[..., 3], terrain[..., 3])
        np.testing.assert_array_equal(terrain, original)
        self.assertEqual(mask[172, 180], 0)
        self.assertEqual(result.water_mask[172, 180], 255)
        np.testing.assert_array_equal(result.water_mask[result.wall], mask[result.wall])
        self.assertTrue((result.water_mask[mask == 255] == 255).all())
        self.assertEqual(result.water_mask[0, 0], 0)
        repeated = cf.prepare(manifest, terrain, mask, flood_mask=True)
        np.testing.assert_array_equal(repeated.terrain, result.terrain)
        without_flood = cf.prepare(manifest, terrain, mask)
        np.testing.assert_array_equal(without_flood.water_mask, mask)
        np.testing.assert_array_equal(without_flood.terrain, result.terrain)

    def test_water_level_comparison_is_relative_on_terraced_maps(self):
        manifest, terrain, mask = cliff()
        base = cf.prepare(manifest, terrain, mask)
        heights = np.ones((3, 3), np.uint8)
        heights[0, 0] = 4
        manifest["cells"]["height"] = encoded(heights)
        manifest["terrainMap"]["originY"] -= 15
        shifted = cf.prepare(manifest, terrain, mask)
        np.testing.assert_array_equal(shifted.ignore, base.ignore)
        np.testing.assert_array_equal(shifted.terrain, base.terrain)
        covered = base.level >= 0
        np.testing.assert_array_equal(shifted.level[covered], base.level[covered] + 1)

    def test_ramps_and_missing_cells_use_manifest_geometry(self):
        manifest, terrain, _ = cliff()
        heights = np.zeros((3, 3), np.uint8)
        heights[1, 2] = heights[2, 1] = heights[2, 2] = 1
        manifest["cells"]["height"] = encoded(heights)
        flat = cf.rasterize_levels(manifest, terrain.shape[:2])
        tiles = np.zeros((3, 3), "<u2")
        tiles[1, 1] = 1
        manifest["cells"]["tile"] = encoded(tiles)
        ramp = cf.rasterize_levels(manifest, terrain.shape[:2])
        self.assertEqual(flat[195, 200], 0)
        self.assertEqual(ramp[195, 200], 1)
        exists = np.zeros((3, 3), np.uint8)
        exists[0, 0] = 1
        manifest["cells"]["exists"] = encoded(exists)
        tiles[0, 0] = 0xFFFF
        manifest["cells"]["tile"] = encoded(tiles)
        self.assertTrue((cf.rasterize_levels(manifest, terrain.shape[:2]) == -1).all())

    def test_cli_writes_all_outputs_without_changing_cache_or_sources(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            manifest, terrain, mask = cliff()
            (root / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
            (root / "materials.json").write_text('{"waterBed": true}', encoding="utf-8")
            Image.fromarray(terrain).save(root / "terrain.png")
            Image.fromarray(mask).save(root / "water.png")
            before = {p: p.read_bytes() for p in root.iterdir()}
            out = root / "out"
            self.assertEqual(cf.main(["--cache", str(root), "--terrain", str(root / "terrain.png"), "--water-mask",
                                      str(root / "water.png"), "--output", str(out / "terrain.png"), "--output-ignore",
                                      str(out / "ignore.png"), "--output-mask", str(out / "water.png"),
                                      "--debug-prefix", str(out / "debug")]), 0)
            for name, mode in (("terrain.png", "RGBA"), ("ignore.png", "L"), ("water.png", "L")):
                with Image.open(out / name) as image:
                    self.assertEqual((image.size, image.mode), ((400, 320), mode))
            for name in ("debug_levels.png", "debug_ignore.png"):
                with Image.open(out / name) as image:
                    self.assertEqual(image.size, (100, 80))
            for path, content in before.items():
                self.assertEqual(path.read_bytes(), content)

    def test_mismatched_mask_is_rejected(self):
        manifest, terrain, mask = cliff()
        with self.assertRaisesRegex(ValueError, "same dimensions"):
            cf.prepare(manifest, terrain, mask[:-1])


if __name__ == "__main__":
    unittest.main()
