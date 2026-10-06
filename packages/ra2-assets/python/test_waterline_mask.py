"""Asset-free tests: python3 -B -m unittest discover -s packages/ra2-assets/python -p 'test_waterline_mask.py'."""

from __future__ import annotations

import base64
import json
from pathlib import Path
import tempfile
import unittest

import cv2
import numpy as np
from PIL import Image

import waterline_mask as wm

WATER = [(24, 64, 105), (12, 56, 97), (20, 72, 113)]
ROCK = [(150, 120, 90), (230, 240, 250), (90, 80, 70)]
SAND = (214, 192, 146)
FOAM = (120, 150, 180)  # The pale band the art paints between water and rock: not a water colour.


def scene(width=240, height=160, base=60):
    """A paletted composite: sea below a wavy painted waterline, rock above it. Returns (rgba, waterline y per x)."""
    rng = np.random.default_rng(7)
    line = (base + 12 * np.sin(np.arange(width) / 17.0) + 5 * np.sin(np.arange(width) / 5.0)).round().astype(int)
    rgb = np.zeros((height, width, 3), np.uint8)
    water = np.arange(height)[:, None] >= line[None, :]
    palette = np.array(WATER, np.uint8)
    rgb[water] = palette[rng.integers(0, len(palette), int(water.sum()))]
    rock = np.array(ROCK, np.uint8)
    rgb[~water] = rock[rng.integers(0, len(rock), int((~water).sum()))]
    foam = (np.arange(height)[:, None] >= line[None, :] - 2) & ~water
    rgb[foam] = FOAM
    rgba = np.dstack([rgb, np.full((height, width), 255, np.uint8)])
    return rgba, line


def cell_mask(line: np.ndarray, height: int, step=30) -> np.ndarray:
    """The extractor's kind of mask: water only from the next whole 'cell' row below the waterline (a staircase)."""
    mask = np.zeros((height, len(line)), np.uint8)
    for x0 in range(0, len(line), step):
        lowest = int(line[x0:x0 + step].max())
        top = -(-(lowest + 4) // 15) * 15
        mask[top:, x0:x0 + step] = 255
    return mask


class PaintedWaterTests(unittest.TestCase):
    def test_follows_the_painted_waterline_within_a_pixel(self):
        rgba, line = scene()
        mask = cell_mask(line, rgba.shape[0])
        added, colours = wm.painted_water(rgba[..., :3], rgba[..., 3] >= 128, mask)
        self.assertEqual(sorted(colours.tolist()), sorted((r << 16) | (g << 8) | b for r, g, b in WATER))
        own, shared = wm.water_colours(rgba[..., :3], mask, rgba[..., 3] >= 128)
        self.assertEqual((len(own), len(shared)), (3, 0))
        grown = (mask >= 128) | added
        # Top of the water in each column against the painted line: the staircase was up to 19 px short of it.
        before = np.array([np.argmax(mask[:, x] >= 128) for x in range(mask.shape[1])]) - line
        after = np.array([np.argmax(grown[:, x]) for x in range(mask.shape[1])]) - line
        self.assertGreater(before.max(), 15)
        self.assertLessEqual(np.abs(after[2:-2]).max(), 1)
        self.assertLessEqual(float(np.abs(after[2:-2]).mean()), 0.5)
        # Nothing above the line (rock, the pale band) became water.
        above = np.arange(mask.shape[0])[:, None] < line[None, :] - 1
        self.assertFalse((added & above).any())

    def test_leaves_a_beach_whose_mask_is_within_the_gap(self):
        rgba, line = scene()
        mask = np.zeros(rgba.shape[:2], np.uint8)
        mask[np.arange(mask.shape[0])[:, None] >= line[None, :] + 2] = 255  # The colour-classified shore: 2 px short.
        added, _ = wm.painted_water(rgba[..., :3], rgba[..., 3] >= 128, mask)
        self.assertFalse(added.any())
        np.testing.assert_array_equal(wm.compose(mask, mask, added, 1), mask)

    def test_ignores_water_colours_that_do_not_touch_the_water_and_other_blues(self):
        rgba, line = scene()
        mask = cell_mask(line, rgba.shape[0])
        rgba[10:20, 30:44, :3] = WATER[0]          # A pond-coloured patch inland, not connected to the sea.
        rgba[30:36, 100:140, :3] = (40, 60, 120)   # Blue rock shadow: no open-water colour.
        added, _ = wm.painted_water(rgba[..., :3], rgba[..., 3] >= 128, mask)
        self.assertFalse(added[:40].any())
        self.assertTrue(added.any())

    def test_does_not_flood_land_that_shares_a_water_colour(self):
        # Urban asphalt reuses a water colour: a road ending at a quay must stay dry, the water under the quay must not.
        rgba, line = scene(width=420, height=420, base=260)
        height, width = rgba.shape[:2]
        rng = np.random.default_rng(3)
        asphalt = np.array([WATER[0], (70, 70, 76)], np.uint8)       # Half of its pixels have a water colour.
        road = np.zeros((height, width), bool)
        road[:, 190:230] = np.arange(height)[:, None] < line[None, 190:230] - 2   # Down to the pale band at the water.
        road[:60, :] |= True                                                      # ... and far inland (beyond FAR).
        mask = cell_mask(line, height)
        # The far band lies beyond FAR of any water: there the colour is known to be land's too.
        self.assertGreater(int(line.min()), wm.FAR + 60)
        rgba[road, :3] = asphalt[rng.integers(0, 2, int(road.sum()))]
        own, shared = wm.water_colours(rgba[..., :3], mask, rgba[..., 3] >= 128)
        self.assertEqual(shared.tolist(), [(WATER[0][0] << 16) | (WATER[0][1] << 8) | WATER[0][2]])
        self.assertEqual(len(own), 2)
        added, _ = wm.painted_water(rgba[..., :3], rgba[..., 3] >= 128, mask)
        self.assertFalse((added & road).any())
        grown = (mask >= 128) | added
        after = np.array([np.argmax(grown[:, x]) for x in range(width)]) - line
        beside = np.ones(width, bool)
        beside[185:235] = False
        self.assertLessEqual(np.abs(after[beside][2:-2]).max(), 1)
        # Where the road meets the water the two-pixel pale band between them may join the water, nothing more.
        self.assertLessEqual(np.abs(after[185:235]).max(), 2)

    def test_does_not_climb_thin_water_coloured_lines_or_keep_specks(self):
        rgba, line = scene()
        mask = cell_mask(line, rgba.shape[0])
        x = 120
        rgba[10:line[x], x, :3] = WATER[1]                 # A one-pixel crack up the rock in a water colour.
        rgba[line[x] + 9, x + 20, :3] = (255, 255, 255)    # A sparkle pixel inside the added water.
        added, _ = wm.painted_water(rgba[..., :3], rgba[..., 3] >= 128, mask)
        self.assertFalse(added[: line[x] - 2, x].any())
        self.assertTrue(((mask >= 128) | added)[line[x] + 9, x + 20])

    def test_stops_at_the_reach_and_needs_a_body_of_water(self):
        # A long narrow channel of water colours leaves the masked sea: it is followed for REACH pixels, no further.
        rng = np.random.default_rng(1)
        height, width = 600, 420   # Enough land that the channel's far end is a sliver of it (see DISTINCT).
        rgb = np.array(ROCK, np.uint8)[rng.integers(0, 3, (height, width))]
        sea = np.zeros((height, width), bool)
        sea[:, :40] = True
        channel = np.zeros((height, width), bool)
        channel[296:304, 40:400] = True
        water = np.array(WATER, np.uint8)
        rgb[sea | channel] = water[rng.integers(0, 3, int((sea | channel).sum()))]
        opaque = np.ones((height, width), bool)
        mask = np.where(sea, 255, 0).astype(np.uint8)
        added, _ = wm.painted_water(rgb, opaque, mask)
        # (The 3 x 3 majority rounds the two inner corners where the channel leaves the sea by one pixel.)
        self.assertFalse((added & ~(cv2.dilate(channel.astype(np.uint8), np.ones((3, 3), np.uint8)) > 0)).any())
        self.assertLessEqual(int((added & ~channel).sum()), 2)
        columns = np.flatnonzero(added.any(axis=0))
        self.assertEqual(columns.min(), 40)
        self.assertLessEqual(columns.max(), 40 + wm.REACH)
        self.assertGreater(columns.max(), 40 + wm.REACH - 3)
        # A puddle is not a body of water to learn colours from.
        tiny = np.zeros_like(mask)
        tiny[:8, :8] = 255
        added, colours = wm.painted_water(rgb, opaque, tiny)
        self.assertEqual(len(colours), 0)
        self.assertFalse(added.any())
        # Water colours that cover the land far from the water as well are no evidence of water: nothing is added.
        everywhere = water[rng.integers(0, 3, (height, width))]
        added, _ = wm.painted_water(everywhere, opaque, mask)
        self.assertFalse(added.any())

    def test_composed_mask_is_soft_at_the_new_edge_and_identical_away_from_it(self):
        rgba, line = scene()
        mask1 = cell_mask(line, rgba.shape[0])
        mask1[150:, :] = 200                      # Any byte far from the change must survive as it is.
        base = cv2.resize(mask1, None, fx=2, fy=2, interpolation=cv2.INTER_LINEAR)
        base1 = cv2.resize(base, (mask1.shape[1], mask1.shape[0]), interpolation=cv2.INTER_AREA)
        added, _ = wm.painted_water(rgba[..., :3], rgba[..., 3] >= 128, base1)
        out = wm.compose(base, base1, added, 2)
        self.assertEqual(out.shape, base.shape)
        self.assertTrue((out >= base).all())
        far = cv2.dilate(added.astype(np.uint8), np.ones((2 * wm.TOUCH + 3,) * 2, np.uint8)) == 0
        far2 = cv2.resize(far.astype(np.uint8), None, fx=2, fy=2, interpolation=cv2.INTER_NEAREST) > 0
        np.testing.assert_array_equal(out[far2], base[far2])
        # Added water is water at the renderer's threshold (0.3 .. 0.55 of 255), with a soft edge above the line.
        added2 = cv2.resize(added.astype(np.uint8), None, fx=2, fy=2, interpolation=cv2.INTER_NEAREST) > 0
        inner = cv2.erode(added2.astype(np.uint8), np.ones((7, 7), np.uint8)) > 0
        self.assertTrue((out[inner] >= 250).all())
        self.assertTrue(((out > 20) & (out < 235)).any())
        # The waterline of the published mask (threshold 0.42) against the painted one, in original pixels.
        top = np.array([np.argmax(out[:, 2 * x] >= 107) for x in range(4, len(line) - 4)]) / 2
        self.assertLessEqual(float(np.abs(top - line[4:-4]).max()), 1.5)
        self.assertLessEqual(float(np.abs(top - line[4:-4]).mean()), 0.75)
        report = wm.waterline_error(added, base1)
        self.assertGreater(report["max"], 15)
        with self.assertRaises(ValueError):
            wm.compose(base, base1, added, 1)


def write_map(directory: Path, *, materials: dict | None = None, water=True) -> None:
    rgba, line = scene()
    height, width = rgba.shape[:2]
    mask1 = cell_mask(line, height) if water else np.zeros((height, width), np.uint8)
    directory.mkdir(parents=True)
    Image.fromarray(rgba, "RGBA").save(directory / "terrain-map.png")
    Image.fromarray(cv2.resize(rgba, None, fx=2, fy=2, interpolation=cv2.INTER_NEAREST), "RGBA").save(
        directory / "terrain-map@2x.png")
    Image.fromarray(mask1, "L").save(directory / "terrain-water.png")
    Image.fromarray(cv2.resize(mask1, None, fx=2, fy=2, interpolation=cv2.INTER_LINEAR), "L").save(
        directory / "terrain-water@2x.png")
    cells = 4
    manifest = {
        "version": 1,
        "theater": "snow",
        "grid": {"width": cells, "height": cells},
        "cells": {
            "exists": base64.b64encode(bytes([1] * cells * cells)).decode(),
            "height": base64.b64encode(bytes(cells * cells)).decode(),
            "tile": base64.b64encode(np.array([0, 1] * (cells * cells // 2), np.uint16).tobytes()).decode(),
        },
        "tiles": [{"file": "water01.sno", "terrainType": 9}, {"file": "wcliff07.sno", "terrainType": 15}],
        "terrainMap": {"file": "terrain-map@2x.png", "waterMask": "terrain-water@2x.png", "scale": 2,
                       "originX": -120, "originY": 0, "width": width * 2, "height": height * 2},
    }
    (directory / "manifest.json").write_text(json.dumps(manifest))
    if materials is not None:
        (directory / "materials.json").write_text(json.dumps(materials))


class FarmTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.base = self.root / "base"
        write_map(self.base / "Coast")
        write_map(self.base / "Lake", materials={"version": 1, "waterBed": True, "waterMask": "terrain-water@2x.png"})
        write_map(self.base / "Dry", water=False)
        write_map(self.base / "Tinted", materials={"version": 1, "terrainMap": "terrain-map@2x.png", "notes": "keep"})
        (self.base / "_library").mkdir()
        self.farm = self.root / "farm"
        self.assertEqual(wm.derive(self.base, self.farm), 5)

    def tearDown(self):
        self.tmp.cleanup()

    def snapshot(self):
        return {str(p.relative_to(self.base)): p.read_bytes() for p in sorted(self.base.rglob("*")) if p.is_file()}

    def test_install_publishes_into_the_farm_and_never_into_its_base(self):
        before = self.snapshot()
        self.assertEqual(wm.map_directories(self.farm), ["Coast", "Dry", "Lake", "Tinted"])
        results = {name: wm.install_map(self.farm, name) for name in wm.map_directories(self.farm)}
        self.assertEqual(before, self.snapshot())
        self.assertEqual({name: r["status"] for name, r in results.items()},
                         {"Coast": "installed", "Dry": "skipped", "Lake": "skipped", "Tinted": "installed"})
        self.assertIn("no water", results["Dry"]["reason"])
        self.assertIn("lake-bed", results["Lake"]["reason"])
        coast = self.farm / "Coast"
        self.assertFalse(coast.is_symlink())                       # Realised copy-on-write ...
        self.assertTrue((coast / "terrain-map.png").is_symlink())  # ... with links to everything it did not change.
        self.assertTrue((self.farm / "Lake").is_symlink())
        mask = coast / "terrain-water@2x-wl.png"
        self.assertTrue(mask.is_file() and not mask.is_symlink())
        with Image.open(mask) as published, Image.open(coast / "terrain-water@2x.png") as original:
            self.assertEqual(published.size, original.size)
            self.assertEqual(published.mode, "L")
        self.assertEqual(json.loads((coast / "materials.json").read_text()),
                         {"version": 1, "waterMask": "terrain-water@2x-wl.png", "waterline": "painted"})
        # An existing sidecar keeps its other entries.
        self.assertEqual(json.loads((self.farm / "Tinted" / "materials.json").read_text()),
                         {"version": 1, "terrainMap": "terrain-map@2x.png", "notes": "keep",
                          "waterMask": "terrain-water@2x-wl.png", "waterline": "painted"})
        self.assertFalse((self.base / "Coast" / "materials.json").exists())
        report = results["Coast"]
        self.assertIn("wcliff", report["families"])
        self.assertEqual(sum(report["families"].values()), report["added"])
        self.assertGreater(report["edge"]["max"], 15)

    def test_a_second_run_starts_from_the_original_mask_again(self):
        first = wm.install_map(self.farm, "Coast")
        mask = (self.farm / "Coast" / "terrain-water@2x-wl.png").read_bytes()
        second = wm.install_map(self.farm, "Coast")
        self.assertEqual(second["status"], "installed")
        self.assertEqual(second["base"], "terrain-water@2x.png")
        self.assertEqual(second["name"], first["name"])
        self.assertEqual(second["added"], first["added"])
        self.assertEqual((self.farm / "Coast" / "terrain-water@2x-wl.png").read_bytes(), mask)

    def test_cli_reports_one_line_per_map(self):
        log = self.root / "log.jsonl"
        self.assertEqual(wm.main(["install", "--farm", str(self.farm), "--all", "--log", str(log)]), 0)
        rows = [json.loads(line) for line in log.read_text().splitlines()]
        self.assertEqual([row["map"] for row in rows], ["Coast", "Dry", "Lake", "Tinted"])
        out = self.root / "review.png"
        self.assertEqual(wm.main(["build", str(self.base / "Coast"), "--out", str(out)]), 0)
        self.assertTrue(out.is_file())
        self.assertEqual(wm.main(["build", str(self.base / "Dry"), "--out", str(self.root / "none.png")]), 1)


if __name__ == "__main__":
    unittest.main()
