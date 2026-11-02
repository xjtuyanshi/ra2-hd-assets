"""Asset-free tests: python3 -B -m unittest discover -s packages/ra2-assets/python -p 'test_terrain_cells.py'."""

from __future__ import annotations

import unittest

import numpy as np

import terrain_cells as tc


def grass(size: int, seed: int) -> np.ndarray:
    """Fine, mostly bright, short strokes over a soft tone field: a stand-in for grass blades or sand grain."""
    rng = np.random.default_rng(seed)
    yy, xx = np.mgrid[0:size, 0:size]
    lum = 120 + 15 * np.sin(xx / 53.0) * np.cos(yy / 41.0) + rng.normal(0, 4, (size, size))
    for _ in range(size * size // 40):
        y, x = rng.integers(0, size - 4, 2)
        lum[y:y + 3, x] += 12  # vertical bright blade, 1 px wide
    return np.repeat(lum[..., None], 3, -1).clip(0, 255).astype(np.float32)


class CellMetricTests(unittest.TestCase):
    size = 512

    def setUp(self):
        self.ref = grass(self.size, 1)
        self.land = np.ones((self.size, self.size), bool)

    def test_independent_grass_texture_is_not_cell_texture(self):
        s = tc.cell_scores(grass(self.size, 2), self.ref, self.land)
        self.assertEqual(s["cell_blocks"], 0)
        self.assertLess(s["valley_ratio"], tc.VALLEY_LIMIT)

    def test_pebble_field_is_flagged_in_every_block(self):
        s = tc.cell_scores(tc.plant_cells(self.ref, 3), self.ref, self.land)
        self.assertEqual(s["blocks"], 4)
        self.assertEqual(s["cell_fraction"], 1.0)
        self.assertGreater(s["valley_ratio"], 1.5)

    def test_cells_are_located_by_block(self):
        out = self.ref.copy()
        out[:256, 256:] = tc.plant_cells(self.ref, 4)[:256, 256:]
        s = tc.cell_scores(out, self.ref, self.land, blocks=True)
        flagged = [(x, y) for x, y, v, m in s["block_list"] if v > tc.VALLEY_LIMIT and m > tc.MID_LIMIT]
        self.assertEqual(flagged, [(256, 0)])

    def test_water_and_transparent_blocks_are_not_scored(self):
        land = self.land.copy()
        land[:, :400] = False  # the right block keeps 112 of 256 columns: below MIN_LAND
        s = tc.cell_scores(tc.plant_cells(self.ref, 5), self.ref, land)
        self.assertEqual(s["blocks"], 0)
        self.assertEqual(s["cell_fraction"], 0.0)

    def test_block_count_follows_the_chunk_size(self):
        out = tc.plant_cells(self.ref, 6)
        a = tc.cell_scores(out, self.ref, self.land, chunk=128, blocks=True)["block_list"]
        b = tc.cell_scores(out, self.ref, self.land, chunk=256, blocks=True)
        self.assertEqual(len(a), 16)
        self.assertEqual(b["blocks"], 4)


if __name__ == "__main__":
    unittest.main()
