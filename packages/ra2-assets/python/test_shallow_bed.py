"""Asset-free tests: python3 -B -m unittest test_shallow_bed -q."""

from __future__ import annotations

import contextlib
import io
from pathlib import Path
import tempfile
import unittest

import cv2
import numpy as np
from PIL import Image

import shallow_bed as sb


def lake() -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Make textured dark water, light beach sand, an outline and a cliff side."""
    height, width = 410, 610
    terrain = np.full((height, width, 4), (210, 186, 142, 255), np.uint8)
    water = np.zeros((height, width), np.uint8)
    water[110:310, 120:480] = 255
    yy, xx = np.indices((height, width))
    grain = np.round(4 * np.sin(xx * 0.7) + 2 * np.cos(yy * 0.9)).astype(np.int16)
    bed = np.clip(np.array([72, 94, 83]) + grain[..., None], 0, 255).astype(np.uint8)
    terrain[water > 127, :3] = bed[water > 127]
    stroke = (191, 144, 75)
    terrain[110:113, 120:480, :3] = stroke
    terrain[307:310, 120:480, :3] = stroke
    terrain[110:310, 120:123, :3] = stroke
    terrain[110:310, 477:480, :3] = (130, 80, 38)
    terrain[..., 3] = ((xx * 17 + yy * 11) % 256).astype(np.uint8)
    ignore = np.zeros_like(water)
    ignore[70:350, 480:520] = 255
    return terrain, water, ignore


def lightness(rgb: np.ndarray) -> np.ndarray:
    return sb.lab(rgb.reshape(-1, 1, 3))[:, 0, 0]


def coast() -> tuple[np.ndarray, np.ndarray]:
    """A straight shore with already-light bed sand and a land-side stroke."""
    terrain = np.full((128, 300, 4), (180, 151, 96, 255), np.uint8)
    water = np.zeros(terrain.shape[:2], np.uint8)
    water[:, 160:] = 255
    terrain[:, 160:, :3] = (165, 145, 96)
    terrain[:, 146:156, :3] = (157, 138, 83)
    return terrain, water


class ShallowBedTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.terrain, cls.water, cls.ignore = lake()
        cls.original = cls.terrain.copy()
        cls.result, cls.stats = sb.prepare(cls.terrain, cls.water, cls.ignore)
        cls.bed_result, cls.bed_stats = sb.prepare(cls.terrain, cls.water, cls.ignore, bed_weight=1)

    def test_shallows_lighten_towards_sand_and_keep_grain(self):
        beach = np.s_[170:250, 129:145, :3]
        before = self.terrain[beach]
        after = self.bed_result[beach]
        sand = np.array([210, 186, 142], np.float32)
        self.assertGreater(lightness(after).mean(), lightness(before).mean() + 20)
        self.assertLess(np.linalg.norm(after.astype(np.float32) - sand, axis=2).mean(),
                        np.linalg.norm(before.astype(np.float32) - sand, axis=2).mean() / 3)
        self.assertGreater(after[..., 0].std(), 1)
        self.assertGreater(self.bed_stats["bed_band_mean_l_after"], self.bed_stats["bed_band_mean_l_before"] + 20)

    def test_default_only_repairs_stroke_and_keeps_light_bed(self):
        terrain, water = coast()
        result, stats = sb.prepare(terrain, water)
        d = sb._signed_distance(sb.beach_edge(water > 127, np.zeros_like(water, bool)), water > 127,
                                (0, 0, water.shape[1], water.shape[0]))
        outside = (d <= -0.18) | (d >= 0.04)
        np.testing.assert_array_equal(result[outside], terrain[outside])
        np.testing.assert_array_equal(result[:, 164:], terrain[:, 164:])
        self.assertGreater(lightness(result[30:90, 148:155, :3]).mean(),
                           lightness(terrain[30:90, 148:155, :3]).mean() + 1)
        self.assertGreater(stats["stroke_pixels_replaced"], 0)

    def test_bed_weight_blends_in_linear_light(self):
        partial, _ = sb.prepare(self.terrain, self.water, self.ignore, bed_weight=0.5)
        beach = np.s_[170:250, 130:145, :3]
        before = (self.terrain[beach].astype(np.float32) / 255) ** sb.GAMMA
        full = (self.bed_result[beach].astype(np.float32) / 255) ** sb.GAMMA
        expected = np.round(((before + full) / 2) ** (1 / sb.GAMMA) * 255)
        np.testing.assert_allclose(partial[beach], expected, atol=1)

    def test_stroke_is_replaced_with_light_sand(self):
        sand_l = lightness(np.array([[210, 186, 142]], np.uint8))[0]
        stroke = self.result[170:250, 120:123, :3]
        self.assertTrue((lightness(stroke) >= sand_l - 6).all())
        self.assertGreater(lightness(stroke).mean(), lightness(self.terrain[170:250, 120:123, :3]).mean())
        self.assertGreater(self.stats["stroke_pixels_replaced"], 0)

    def test_far_pixels_cliff_feet_alpha_and_inputs_are_exact(self):
        edge = sb.beach_edge(self.water > 127, self.ignore > 127)
        far = sb.ground_distance(edge) > sb.CELL
        np.testing.assert_array_equal(self.result[far], self.terrain[far])
        np.testing.assert_array_equal(self.result[170:250, 459:480], self.terrain[170:250, 459:480])
        protected = sb.ground_distance(self.ignore > 127) <= 0.25 * sb.CELL
        np.testing.assert_array_equal(self.result[protected], self.terrain[protected])
        np.testing.assert_array_equal(self.result[..., 3], self.terrain[..., 3])
        np.testing.assert_array_equal(self.terrain, self.original)
        self.assertEqual(self.stats["pixels_changed"], int(np.any(self.result != self.terrain, axis=2).sum()))

    def test_ground_distance_stretches_y_and_exact_mask_threshold(self):
        seeds = np.zeros((7, 9), bool)
        seeds[2, 3] = True
        distance = sb.ground_distance(seeds)
        self.assertEqual(distance[2, 4], 1)
        self.assertEqual(distance[3, 3], 2)
        self.assertAlmostEqual(float(distance[3, 4]), np.sqrt(5), places=5)
        terrain = np.full((60, 60, 4), (210, 186, 142, 255), np.uint8)
        mask = np.full((60, 60), 127, np.uint8)
        result, stats = sb.prepare(terrain, mask)
        np.testing.assert_array_equal(result, terrain)
        self.assertEqual(stats["pixels_changed"], 0)

    def test_green_and_dark_ring_samples_do_not_tint_sand(self):
        terrain, water, ignore = lake()
        terrain[160:260, 85:103, :3] = (45, 145, 40)
        terrain[180:230, 90:97, :3] = (20, 18, 16)
        terrain[170:250, 113:120, :3] = (157, 138, 83)
        result, _ = sb.prepare(terrain, water, ignore, tile_size=128)
        sand = np.array([210, 186, 142], np.float32)
        beach = result[185:225, 115:120, :3].astype(np.float32)
        # Texture can darken the target, but its channel ratios must remain sand.
        ratios = beach[..., 1:] / beach[..., :1]
        np.testing.assert_allclose(ratios.mean(axis=(0, 1)), sand[1:] / sand[0], atol=0.01)
        self.assertGreater(lightness(beach.astype(np.uint8)).mean(), 65)

    def test_detection_thresholds_and_rocks_survive_adjacent_feathering(self):
        terrain, water = coast()
        terrain[:, :160, :3] = (180, 151, 96)
        reference = sb.lab(np.array([[[180, 151, 96]]], np.uint8))[0, 0]
        cases = [(3.0, 0, False), (4.8, 0, True), (0, 5.0, False),
                 (0, 7.2, True), (26.0, 0, False), (24.0, 0, True)]
        for i, (darkness, excess_chroma, _) in enumerate(cases):
            colour = reference.copy()
            colour[0] -= darkness
            colour[1:] *= 1 + excess_chroma / np.hypot(*reference[1:])
            rgb = cv2.cvtColor(colour.reshape(1, 1, 3), cv2.COLOR_LAB2RGB)[0, 0]
            terrain[8 + i * 18:16 + i * 18, 150:154, :3] = np.round(rgb * 255).astype(np.uint8)
        # This dark rock touches detected stroke on either side.
        terrain[105:115, 147:155, :3] = (157, 138, 83)
        terrain[108:112, 151, :3] = (35, 29, 18)
        result, _ = sb.prepare(terrain, water)
        for i, (_, _, detected) in enumerate(cases[:-1]):
            region = np.s_[10 + i * 18:14 + i * 18, 151:153, :3]
            self.assertEqual(bool(np.any(result[region] != terrain[region])), detected)
        self.assertTrue(np.any(result[100:104, 151:153, :3] != terrain[100:104, 151:153, :3]))
        np.testing.assert_array_equal(result[108:112, 151], terrain[108:112, 151])

    def test_wet_ramp_texture_clamp_and_smooth_band_ends(self):
        terrain, water = coast()
        terrain[:, 140:165, :3] = (145, 122, 78)
        result, _ = sb.prepare(terrain, water)
        lin = (terrain[..., :3].astype(np.float32) / 255) ** sb.GAMMA
        luminance = lin @ np.array([0.2126, 0.7152, 0.0722], np.float32)
        texture = np.clip(luminance / sb._blur(luminance), 0.85, 1.15)
        sand = (np.array([180, 151, 96], np.float32) / 255) ** sb.GAMMA
        for x in (147, 150, 154, 160):
            d = (x - 160) / sb.CELL
            wet = 0.9 + 0.1 * np.clip(d / -0.18, 0, 1)
            expected = np.round((sand * wet * texture[64, x]) ** (1 / sb.GAMMA) * 255)
            np.testing.assert_allclose(result[64, x, :3], expected, atol=1)
        # End pixels receive a partial fade, never a hard replacement.
        self.assertTrue(np.any(result[64, 146, :3] != terrain[64, 146, :3]))
        self.assertLess(np.linalg.norm(result[64, 146, :3].astype(float) - terrain[64, 146, :3]),
                        np.linalg.norm(result[64, 147, :3].astype(float) - terrain[64, 147, :3]))
        self.assertTrue(np.any(result[64, 163, :3] != terrain[64, 163, :3]))
        np.testing.assert_array_equal(result[:, 164:], terrain[:, 164:])

    def test_custom_ring_stroke_band_and_large_distance_halo(self):
        terrain, water = coast()
        terrain[:, 130:144, :3] = (157, 138, 83)
        # A farther ring has a distinct colour; selecting it must affect the stroke.
        terrain[:, 30:59, :3] = (205, 180, 130)
        default, _ = sb.prepare(terrain, water)
        custom, _ = sb.prepare(terrain, water, stroke_inner=-0.4, stroke_outer=0.1,
                               ring_inner=-1.6, ring_outer=-1.2, tile_size=32)
        untiled, _ = sb.prepare(terrain, water, stroke_inner=-0.4, stroke_outer=0.1,
                                ring_inner=-1.6, ring_outer=-1.2)
        np.testing.assert_array_equal(custom, untiled)
        np.testing.assert_array_equal(default[:, 130:144], terrain[:, 130:144])
        self.assertGreater(lightness(custom[30:90, 134:142, :3]).mean(),
                           lightness(terrain[30:90, 134:142, :3]).mean() + 5)

    def test_deterministic_tiles_and_ignored_coast_only(self):
        repeated, stats = sb.prepare(self.terrain, self.water, self.ignore)
        np.testing.assert_array_equal(repeated, self.result)
        self.assertEqual(stats, self.stats)
        tiled, _ = sb.prepare(self.terrain, self.water, self.ignore, tile_size=128)
        np.testing.assert_array_equal(tiled, self.result)
        ignored = np.where(self.water > 127, 0, 255).astype(np.uint8)
        unchanged, stats = sb.prepare(self.terrain, self.water, ignored)
        np.testing.assert_array_equal(unchanged, self.terrain)
        self.assertEqual(stats["pixels_changed"], 0)

    def test_cli_outputs_real_png_debug_and_preserves_symlink_target(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            for name, array in zip(("terrain", "water", "ignore"), lake()):
                Image.fromarray(array).save(root / f"{name}.png")
            before = {p: p.read_bytes() for p in root.glob("*.png")}
            out = root / "farm/bed.png"
            out.parent.mkdir()
            out.symlink_to(root / "terrain.png")
            debug = root / "debug.jpg"
            with contextlib.redirect_stdout(io.StringIO()) as printed:
                code = sb.main(["--terrain", str(root / "terrain.png"), "--water", str(root / "water.png"),
                                "--ignore", str(root / "ignore.png"), "--out", str(out),
                                "--debug", str(debug), "--debug-box", "100,150,200,250"])
            self.assertEqual(code, 0)
            self.assertFalse(out.is_symlink())
            with Image.open(out) as image:
                self.assertEqual((image.mode, image.size), ("RGBA", (610, 410)))
                np.testing.assert_array_equal(np.array(image), self.result)
            with Image.open(debug) as image:
                self.assertEqual((image.format, image.size), ("JPEG", (400, 200)))
            self.assertIn("stroke pixels replaced:", printed.getvalue())
            for path, content in before.items():
                self.assertEqual(path.read_bytes(), content)
            options = ["--bed-weight", "0.5", "--stroke-inner", "-0.25", "--stroke-outer", "0.08",
                       "--ring-inner", "-0.55", "--ring-outer", "-0.3"]
            with contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(sb.main(["--terrain", str(root / "terrain.png"),
                                          "--water", str(root / "water.png"),
                                          "--ignore", str(root / "ignore.png"), "--out", str(out), *options]), 0)
            expected, _ = sb.prepare(self.terrain, self.water, self.ignore, bed_weight=0.5,
                                      stroke_inner=-0.25, stroke_outer=0.08, ring_inner=-0.55, ring_outer=-0.3)
            with Image.open(out) as image:
                np.testing.assert_array_equal(np.array(image), expected)
            with contextlib.redirect_stderr(io.StringIO()):
                self.assertEqual(sb.main(["--terrain", str(root / "terrain.png"), "--water", str(root / "water.png"),
                                          "--out", str(root / "terrain.png")]), 1)
            self.assertEqual((root / "terrain.png").read_bytes(), before[root / "terrain.png"])

    def test_invalid_dimensions_and_missing_samples_fail_explicitly(self):
        with self.assertRaisesRegex(ValueError, "same dimensions"):
            sb.prepare(self.terrain, self.water[:-1])
        with self.assertRaisesRegex(ValueError, "same dimensions"):
            sb.prepare(self.terrain, self.water, self.ignore[:-1])
        green = self.terrain.copy()
        green[self.water <= 127, :3] = (30, 150, 40)
        with self.assertRaisesRegex(ValueError, "beach sand samples"):
            sb.prepare(green, self.water)

    def test_cli_defaults_and_invalid_band_options(self):
        args = sb.build_parser().parse_args(["--terrain", "terrain.png", "--water", "water.png", "--out", "out.png"])
        self.assertEqual((args.bed_weight, args.stroke_inner, args.stroke_outer, args.ring_inner, args.ring_outer),
                         (0.0, -0.18, 0.04, -0.45, -0.2))
        for options in ({"bed_weight": -0.1}, {"bed_weight": 1.1}, {"bed_weight": float("nan")},
                        {"stroke_inner": 0}, {"stroke_outer": -0.2}, {"ring_inner": -0.1},
                        {"ring_outer": 0.1}, {"ring_inner": -float("inf")}):
            with self.subTest(options=options), self.assertRaises(ValueError):
                sb.prepare(self.terrain, self.water, **options)


if __name__ == "__main__":
    unittest.main()
