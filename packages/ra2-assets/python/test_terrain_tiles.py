"""Asset-free tests: python3 -B -m unittest discover -s packages/ra2-assets/python -p 'test_terrain_tiles.py'."""

from __future__ import annotations

import json
import os
from pathlib import Path
import shlex
import shutil
import sys
import tempfile
import unittest
from unittest.mock import patch

import cv2
import numpy as np
from PIL import Image

import terrain_tiles as tt


def source(width: int = 96, height: int = 80) -> np.ndarray:
    rgb = np.random.default_rng(9).integers(70, 180, (height, width, 3), dtype=np.uint8)
    rgb[12:25, 15:40] = (170, 110, 90)
    rgb[height // 2:height // 2 + 9, :] = (90, 155, 110)
    alpha = np.full((height, width, 1), 255, np.uint8)
    alpha[:4] = np.arange(width, dtype=np.uint8)[None, :, None]
    return np.concatenate([rgb, alpha], axis=-1)


class TileTests(unittest.TestCase):
    def test_prep_identity_assemble_and_qa_round_trip(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            rgba = source()
            Image.fromarray(rgba).save(root / "source.png")
            Image.fromarray(np.zeros(rgba.shape[:2], np.uint8)).save(root / "water.png")
            (root / "prompt.txt").write_text("Preserve every boundary.", encoding="utf-8")
            tiles = root / "tiles"
            self.assertEqual(tt.main(["prep", "--source", str(root / "source.png"), "--water-mask",
                                      str(root / "water.png"), "--prompt", str(root / "prompt.txt"),
                                      "--tiles", str(tiles)]), 0)
            queued = (tiles / "queue.txt").read_text().splitlines()
            self.assertEqual(queued, [str((tiles / "0_0").resolve())])
            self.assertEqual(json.loads((tiles / "prep.json").read_text()),
                             dict(width=96, height=80, skipped={"0_0": False}))
            directory = Path(queued[0])
            np.testing.assert_array_equal(tt.load_image(directory / "input.png", "RGB"), rgba[..., :3])
            shutil.copyfile(directory / "input.png", directory / "output.png")
            self.assertEqual(tt.main(["assemble", "--source", str(root / "source.png"), "--tiles", str(tiles),
                                      "--output", str(root / "assembled.png"), "--debug-box", "0,0,20,20"]), 0)
            result = tt.load_image(root / "assembled.png", "RGBA")
            np.testing.assert_array_equal(result[..., 3], rgba[..., 3])
            # OpenCV's float Lab round trip can round one byte away from the identity.
            self.assertLessEqual(np.abs(result[..., :3].astype(int) - rgba[..., :3].astype(int)).max(), 1)
            self.assertEqual(tt.load_image(root / "assembled_dbg.png", "RGB").shape, (20, 40, 3))
            self.assertEqual(tt.main(["check", "--tiles", str(tiles)]), 0)
            report = json.loads((directory / "check.json").read_text())
            self.assertEqual(report["outsize"], [80, 96])
            self.assertEqual(report["corr0"], 1.0)
            self.assertAlmostEqual(report["ecc"], 1.0, places=3)
            self.assertLessEqual(report["disp_max"], 0.1)
            self.assertEqual(report["lowfreq_dE"], 0)
            (directory / "output.png").unlink()
            self.assertEqual(tt.main(["assemble", "--source", str(root / "source.png"), "--tiles", str(tiles),
                                      "--output", str(root / "missing.png")]), 0)
            np.testing.assert_array_equal(tt.load_image(root / "missing.png", "RGBA"), rgba)

    def test_default_tile_grid_region_priority_and_water_skip(self):
        self.assertEqual(tt.starts(1536, tt.TW, tt.SX), [0])
        self.assertEqual(tt.starts(3000, tt.TW, tt.SX), [0, 1280, 1464])
        self.assertEqual(tt.starts(1900, tt.TH, tt.SY), [0, 768, 876])
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            rgba = source(4096, 32)
            water = np.zeros(rgba.shape[:2], np.uint8)
            water[:, 2560:] = 128  # The original threshold is > 127, not > 128.
            Image.fromarray(rgba).save(root / "source.png")
            Image.fromarray(water).save(root / "water.png")
            (root / "prompt.txt").write_text("test", encoding="utf-8")
            tiles = root / "tiles"
            queue = root / "priority.txt"
            self.assertEqual(tt.main(["prep", "--source", str(root / "source.png"), "--water-mask",
                                      str(root / "water.png"), "--prompt", str(root / "prompt.txt"),
                                      "--tiles", str(tiles), "--queue", str(queue),
                                      "--region", "2000,0,2400,32"]), 0)
            self.assertEqual([Path(line).name for line in queue.read_text().splitlines()], ["1_0", "0_0"])
            skipped = json.loads((tiles / "2_0/tile.json").read_text())
            self.assertEqual(skipped["water"], 1)
            self.assertFalse((tiles / "2_0/input.png").exists())
            with Image.open(tiles / "1_0/input.png") as tile:
                self.assertEqual(tile.size, (1536, 32))
            for name in ("0_0", "1_0"):
                shutil.copyfile(tiles / name / "input.png", tiles / name / "output.png")
            self.assertEqual(tt.main(["assemble", "--source", str(root / "source.png"), "--tiles", str(tiles),
                                      "--output", str(root / "assembled.png"), "--no-align"]), 0)
            result = tt.load_image(root / "assembled.png", "RGBA")
            self.assertLessEqual(np.abs(result.astype(int) - rgba.astype(int)).max(), 1)
            np.testing.assert_array_equal(result[..., 3], rgba[..., 3])
            np.testing.assert_array_equal(result[:, 2816:], rgba[:, 2816:])  # The skipped water tile stays source.

    def test_assemble_colour_source_relocks_low_frequencies(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            rgba = source()
            Image.fromarray(rgba).save(root / "source.png")
            Image.fromarray(np.zeros(rgba.shape[:2], np.uint8)).save(root / "water.png")
            (root / "prompt.txt").write_text("Preserve every boundary.", encoding="utf-8")
            tiles = root / "tiles"
            self.assertEqual(tt.main(["prep", "--source", str(root / "source.png"), "--water-mask",
                                      str(root / "water.png"), "--prompt", str(root / "prompt.txt"),
                                      "--tiles", str(tiles)]), 0)
            shutil.copyfile(tiles / "0_0" / "input.png", tiles / "0_0" / "output.png")
            # A uniformly warmer reference of the same layout: the result follows its low frequencies.
            warm = rgba[..., :3].astype(int)
            warm[..., 0] += 20
            warm[..., 2] -= 20
            Image.fromarray(np.clip(warm, 0, 255).astype(np.uint8)).save(root / "colour.png")
            self.assertEqual(tt.main(["assemble", "--source", str(root / "source.png"), "--tiles", str(tiles),
                                      "--output", str(root / "assembled.png"), "--no-align",
                                      "--colour-source", str(root / "colour.png")]), 0)
            result = tt.load_image(root / "assembled.png", "RGBA").astype(int)
            np.testing.assert_array_equal(result[..., 3], rgba[..., 3])
            centre = (slice(20, 60), slice(20, 76))
            self.assertGreater(result[centre][..., 0].mean() - rgba[centre][..., 0].mean(), 12)
            self.assertLess(result[centre][..., 2].mean() - rgba[centre][..., 2].mean(), -12)
            Image.fromarray(np.zeros((8, 8, 3), np.uint8)).save(root / "small.png")
            self.assertEqual(tt.main(["assemble", "--source", str(root / "source.png"), "--tiles", str(tiles),
                                      "--output", str(root / "x.png"),
                                      "--colour-source", str(root / "small.png")]), 1)
            self.assertFalse((root / "x.png").exists())

    def test_colour_source_relocks_uncovered_pixels_without_strip_seams(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            rgba = source(80, 600)
            warm = rgba[..., :3].copy()
            warm[..., 0] += 20
            warm[..., 2] -= 20
            Image.fromarray(rgba).save(root / "source.png")
            Image.fromarray(warm).save(root / "colour.png")
            directory = root / "tiles/0_0"
            directory.mkdir(parents=True)
            (directory / "tile.json").write_text(json.dumps(dict(x=0, y=0)), encoding="utf-8")
            Image.fromarray(rgba[:200, :, :3]).save(directory / "input.png")
            shutil.copyfile(directory / "input.png", directory / "output.png")
            # A non-PNG temporary suffix is used by atomic cache-farm publication.
            self.assertEqual(tt.main(["assemble", "--source", str(root / "source.png"),
                                      "--colour-source", str(root / "colour.png"), "--tiles", str(root / "tiles"),
                                      "--output", str(root / "assembled.tmp"), "--no-align"]), 0)
            result = tt.load_image(root / "assembled.tmp", "RGBA")
            expected = np.round(tt.colour_lock(warm, rgba[..., :3]) * 255).astype(np.uint8)
            np.testing.assert_array_equal(result[..., 3], rgba[..., 3])
            # Includes both fallback strip boundaries (256/512) and the painted/fallback join (200).
            self.assertLessEqual(np.abs(result[..., :3].astype(int) - expected.astype(int)).max(), 1)

    def test_colour_source_spatial_changes_cross_painted_and_strip_boundaries(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            rgba = source(80, 600)
            rgba[..., :3] = 128
            reference = rgba[..., :3].copy()
            reference[205:] = 220  # The reference changes just outside the painted tile's bottom edge.
            reference[261:, 45:] = (150, 180, 210)
            reference[507:, :35] = (210, 150, 190)
            Image.fromarray(rgba).save(root / "source.png")
            Image.fromarray(reference).save(root / "colour.png")
            tile = root / "tiles/0_0"
            tile.mkdir(parents=True)
            (tile / "tile.json").write_text(json.dumps(dict(x=0, y=0)), encoding="utf-8")
            Image.fromarray(rgba[:200, :, :3]).save(tile / "input.png")
            shutil.copyfile(tile / "input.png", tile / "output.png")
            self.assertEqual(tt.main(["assemble", "--source", str(root / "source.png"),
                                      "--colour-source", str(root / "colour.png"), "--tiles", str(root / "tiles"),
                                      "--output", str(root / "assembled.png"), "--no-align"]), 0)
            result = tt.load_image(root / "assembled.png", "RGBA")
            expected = np.round(tt.colour_lock(reference, rgba[..., :3]) * 255).astype(np.uint8)
            np.testing.assert_array_equal(result[..., 3], rgba[..., 3])
            self.assertLessEqual(np.abs(result[..., :3].astype(int) - expected.astype(int)).max(), 1)
            self.assertGreater(result[199, 20, 0], 150)
            self.assertLessEqual(abs(int(result[199, 20, 0]) - int(result[200, 20, 0])), 2)

    def test_require_complete_rejects_missing_outputs_but_allows_water_skips(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            rgba = source(4096, 32)
            Image.fromarray(rgba).save(root / "source.png")
            water = np.zeros(rgba.shape[:2], np.uint8)
            water[:, 2560:] = 255
            Image.fromarray(water).save(root / "water.png")
            (root / "prompt.txt").write_text("test", encoding="utf-8")
            tiles = root / "tiles"
            self.assertEqual(tt.main(["prep", "--source", str(root / "source.png"), "--water-mask",
                                      str(root / "water.png"), "--prompt", str(root / "prompt.txt"),
                                      "--tiles", str(tiles)]), 0)
            output = root / "assembled.png"
            output.write_bytes(b"previous installed result")
            argv = ["assemble", "--source", str(root / "source.png"), "--tiles", str(tiles),
                    "--output", str(output), "--require-complete", "--no-align"]
            self.assertEqual(tt.main(argv), 1)
            self.assertEqual(output.read_bytes(), b"previous installed result")
            for name in ("0_0", "1_0"):
                shutil.copyfile(tiles / name / "input.png", tiles / name / "output.png")
            self.assertEqual(tt.main(argv), 0)
            self.assertLessEqual(np.abs(tt.load_image(output, "RGBA").astype(int) - rgba.astype(int)).max(), 1)
            # A missing whole tile directory must fail, with the prep index and in the legacy format.
            (tiles / "1_0").rename(root / "saved-tile")
            self.assertEqual(tt.main(argv), 1)
            (tiles / "prep.json").unlink()
            self.assertEqual(tt.main(argv), 1)
            (root / "saved-tile").rename(tiles / "1_0")
            self.assertEqual(tt.main(argv), 0)
            # Interrupted land preparation (metadata, but no input or output) is not a water skip.
            (tiles / "0_0/input.png").unlink()
            (tiles / "0_0/output.png").unlink()
            self.assertEqual(tt.main(argv), 1)
            self.assertEqual(tt.main(["assemble", "--source", str(root / "source.png"),
                                      "--tiles", str(root / "empty"), "--output", str(root / "empty.png"),
                                      "--require-complete"]), 1)
            self.assertFalse((root / "empty.png").exists())

    def test_require_complete_prep_index_records_custom_water_skip(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            rgba = source()
            Image.fromarray(rgba).save(root / "source.png")
            water = np.zeros(rgba.shape[:2], np.uint8)
            water[:40] = 255
            Image.fromarray(water).save(root / "water.png")
            (root / "prompt.txt").write_text("test", encoding="utf-8")
            tiles = root / "tiles"
            self.assertEqual(tt.main(["prep", "--source", str(root / "source.png"), "--water-mask",
                                      str(root / "water.png"), "--prompt", str(root / "prompt.txt"),
                                      "--tiles", str(tiles), "--skip-water", "0.4"]), 0)
            self.assertEqual(json.loads((tiles / "prep.json").read_text())["skipped"], {"0_0": True})
            argv = ["assemble", "--source", str(root / "source.png"), "--tiles", str(tiles),
                    "--output", str(root / "assembled.png"), "--require-complete", "--no-align"]
            self.assertEqual(tt.main(argv), 0)
            np.testing.assert_array_equal(tt.load_image(root / "assembled.png", "RGBA"), rgba)
            (tiles / "prep.json").unlink()
            self.assertEqual(tt.main(argv), 1)  # Legacy metadata cannot prove a noncanonical skip.

    def test_overlap_quilting_and_minimum_error_seams(self):
        rgb = source(80, 64)[..., :3].astype(np.float32) / 255
        canvas = np.zeros_like(rgb)
        filled = np.zeros(rgb.shape[:2], bool)
        for x, y in ((0, 0), (32, 0), (0, 24), (32, 24)):
            tt.stitch(canvas, filled, rgb[y:y + 40, x:x + 48], x, y)
        self.assertTrue(filled.all())
        np.testing.assert_allclose(canvas, rgb, atol=1e-7)
        cost = np.ones((6, 8), np.float32)
        seam = np.array([2, 3, 3, 4, 3, 2])
        cost[np.arange(6), seam] = 0
        np.testing.assert_array_equal(tt.min_cut(cost, 0), seam)
        np.testing.assert_array_equal(tt.min_cut(cost.T, 1), seam)

    def test_large_feather_has_exact_overlap_boundary_weights(self):
        for feather in (0, 3, 64, 96):
            with self.subTest(feather=feather):
                canvas = np.zeros((40, 96, 3), np.float32)
                filled = np.zeros(canvas.shape[:2], bool)
                filled[:, :64] = True
                path = np.full(40, 32)
                with patch.object(tt, "min_cut", return_value=path):
                    tt.stitch(canvas, filled, np.ones_like(canvas), 0, 0, feather)
                weights = canvas[20, :, 0]
                self.assertEqual(weights[0], 0)
                np.testing.assert_array_equal(weights[63:], 1)
                self.assertTrue((np.diff(weights) >= 0).all())
                if feather == 0:
                    np.testing.assert_array_equal(weights[:32], 0)
                    np.testing.assert_array_equal(weights[32:], 1)
                elif feather == 3:
                    hard = (np.arange(96) >= 32).astype(np.float32)[None, :]
                    previous = cv2.GaussianBlur(hard, (0, 0), 3)[0]
                    self.assertLess(np.abs(weights - previous).max(), 0.03)
                else:
                    self.assertAlmostEqual(float(weights[31] + weights[32]), 1, places=6)
                    self.assertLess(np.abs(np.diff(weights)).max(), 0.03)

    def test_edge_anchored_overlap_over_half_tile_keeps_both_join_edges_continuous(self):
        canvas = np.zeros((40, 48, 3), np.float32)
        filled = np.zeros(canvas.shape[:2], bool)
        filled[:24, :] = True
        filled[:, :32] = True
        with patch.object(tt, "min_cut", wraps=tt.min_cut) as cut:
            tt.stitch(canvas, filled, np.ones_like(canvas), 0, 0, feather=96)
        self.assertEqual([call.args[0].shape for call in cut.call_args_list], [(40, 32), (24, 48)])
        np.testing.assert_array_equal(canvas[0], 0)
        np.testing.assert_array_equal(canvas[:, 0], 0)
        np.testing.assert_array_equal(canvas[-1, 31:], 1)
        np.testing.assert_array_equal(canvas[23:, -1], 1)
        np.testing.assert_array_equal(canvas[24:, 32:], 1)
        self.assertTrue(filled.all())

    def test_colour_lock_keeps_repaint_detail_and_restores_chroma(self):
        inp = np.full((80, 96, 3), (115, 140, 95), np.uint8)
        pattern = ((np.indices(inp.shape[:2]).sum(0) % 2) * 12 - 6)[..., None]
        repainted = (inp.astype(int) + np.array([30, -10, 10]) + pattern).astype(np.uint8)
        result = np.round(tt.colour_lock(inp, repainted) * 255).astype(np.uint8)
        before = tt.to_lab(repainted)[..., 1:].mean((0, 1))
        after = tt.to_lab(result)[..., 1:].mean((0, 1))
        target = tt.to_lab(inp)[..., 1:].mean((0, 1))
        self.assertLess(np.linalg.norm(after - target), 0.15 * np.linalg.norm(before - target))
        self.assertGreater(result[..., 1].std(), 3)

    def test_colour_lock_ignores_black_outside_valid_terrain(self):
        inp = np.full((128, 160, 3), 128, np.uint8)
        validity = np.zeros(inp.shape[:2], np.float32)
        validity[24:-24, 24:-24] = 1
        inp[validity == 0] = 0
        continued_texture = np.full_like(inp, 128)
        unmasked = np.round(tt.colour_lock(inp, continued_texture) * 255).astype(int)
        masked = np.round(tt.colour_lock(inp, continued_texture, validity=validity) * 255).astype(int)
        self.assertLess(unmasked[24, 80, 0], 110)  # Reproduce the black perimeter leaking into opaque terrain.
        self.assertLessEqual(np.abs(masked[validity > 0] - 128).max(), 1)
        empty = tt.colour_lock(inp, continued_texture, validity=np.zeros_like(validity))
        self.assertTrue(np.isfinite(empty).all())
        self.assertLessEqual(np.abs(np.round(empty * 255) - 128).max(), 1)

    def test_assemble_masks_tile_and_global_corrections_with_source_alpha(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            rgba = np.zeros((600, 160, 4), np.uint8)
            rgba[24:-24, 24:-24, :3] = 128
            rgba[24:-24, 24:-24, 3] = 255
            rgba[24, 24:-24, 3] = 128
            valid = rgba[..., 3] > 0
            Image.fromarray(rgba).save(root / "source.png")
            tile = root / "tiles/0_0"
            tile.mkdir(parents=True)
            (tile / "tile.json").write_text(json.dumps(dict(x=0, y=0)), encoding="utf-8")
            Image.fromarray(rgba[..., :3]).save(tile / "input.png")
            continued_texture = np.full_like(rgba[..., :3], 128)
            Image.fromarray(continued_texture).save(tile / "output.png")
            argv = ["assemble", "--source", str(root / "source.png"), "--tiles", str(root / "tiles"),
                    "--output", str(root / "assembled.png"), "--no-align"]
            self.assertEqual(tt.main(argv), 0)
            result = tt.load_image(root / "assembled.png", "RGBA")
            np.testing.assert_array_equal(result[..., 3], rgba[..., 3])
            self.assertLessEqual(np.abs(result[..., :3][valid].astype(int) - 128).max(), 1)
            # The global reference has unrelated RGB outside alpha, which must not tint/lift the map edge.
            reference = np.full_like(continued_texture, (255, 0, 200))
            reference[valid] = 180
            Image.fromarray(reference).save(root / "colour.png")
            self.assertEqual(tt.main([*argv, "--colour-source", str(root / "colour.png")]), 0)
            result = tt.load_image(root / "assembled.png", "RGBA")
            expected = np.round(tt.colour_lock(np.full_like(continued_texture, 180), continued_texture) * 255)
            np.testing.assert_array_equal(result[..., 3], rgba[..., 3])
            self.assertLessEqual(np.abs(result[..., :3][valid].astype(int) - expected[valid]).max(), 1)

    def test_registration_corrects_small_translation_and_rejects_large_fit(self):
        inp = source(256, 192)[..., :3]
        moved = cv2.warpAffine(inp, np.array([[1, 0, 4], [0, 1, -3]], np.float32), (256, 192),
                               borderMode=cv2.BORDER_REFLECT)
        fixed = tt.align(inp, moved)
        inner = np.s_[12:-12, 12:-12]
        self.assertLess(np.abs(fixed[inner].astype(float) - inp[inner]).mean(),
                        np.abs(moved[inner].astype(float) - inp[inner]).mean() * 0.4)
        too_far = np.array([[1, 0, 17], [0, 1, 0]], np.float32)
        with patch.object(tt, "fit_affine", return_value=(0.2, 0.9, too_far)):
            np.testing.assert_array_equal(tt.align(inp, moved), moved)
        flat = np.full_like(inp, 100)
        np.testing.assert_array_equal(tt.align(flat, flat), flat)


FAKE_CLI = '''import json
from pathlib import Path
import shutil
import sys
import time
mode, inp, out, prompt = sys.argv[1:]
counter = Path("attempts.txt")
attempt = int(counter.read_text()) + 1 if counter.exists() else 1
counter.write_text(str(attempt))
Path("arguments.json").write_text(json.dumps({"cwd": str(Path.cwd()), "prompt": prompt}))
if mode == "limit":
    print("rate limit 429: quota exhausted", flush=True)
    raise SystemExit(1)
if mode == "fail" or (mode == "retry" and attempt == 1):
    raise SystemExit(1)
if mode == "sleep":
    time.sleep(5)
shutil.copyfile(inp, out)
'''


class RunnerTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.cli = self.root / "external cli.py"
        self.cli.write_text(FAKE_CLI, encoding="utf-8")
        self.prompt = 'Literal "quotes", {braces}, $HOME and `no shell`.\nSecond line.'

    def queue(self, name: str, count: int) -> Path:
        entries = []
        for i in range(count):
            directory = self.root / f"{name} tile {i}"
            directory.mkdir()
            Image.fromarray(source(32, 32)).save(directory / "input.png")
            (directory / "prompt.txt").write_text(self.prompt, encoding="utf-8")
            entries.append(directory.name)
        path = self.root / f"{name}.txt"
        path.write_text("\n".join(entries) + "\n", encoding="utf-8")
        return path

    def command(self, mode: str) -> str:
        return shlex.join([sys.executable, "-B", str(self.cli), mode, "{input}", "{output}", "{prompt}"])

    def run_queue(self, queues: list[Path], mode: str, *extra: str) -> int:
        return tt.main(["run", *map(str, queues), "--work", str(self.root / "work"), "--command", self.command(mode),
                        "--jobs", "2", "--poll-interval", "0.01", *extra])

    def test_external_argv_interleaves_queues_retries_and_skips_finished(self):
        a, b = self.queue("a", 2), self.queue("b", 2)
        order = tt.queue_order([a, b])
        self.assertEqual([d.name for d in order], ["a tile 0", "b tile 0", "a tile 1", "b tile 1"])
        shutil.copyfile(order[0] / "input.png", order[0] / "output.png")
        self.assertEqual(self.run_queue([a, b], "retry"), 0)
        self.assertFalse((order[0] / "attempts.txt").exists())
        for directory in order[1:]:
            self.assertEqual((directory / "attempts.txt").read_text(), "2")
            arguments = json.loads((directory / "arguments.json").read_text())
            self.assertEqual(arguments, {"cwd": str(directory), "prompt": self.prompt})
            self.assertEqual((directory / "input.png").read_bytes(), (directory / "output.png").read_bytes())
        active = peak = 0
        for line in (self.root / "work/sched.log").read_text().splitlines():
            if " launch " in line:
                active += 1
            elif " done " in line:
                active -= 1
            peak = max(peak, active)
            self.assertLessEqual(active, 2)
        self.assertEqual(active, 0)
        self.assertEqual(peak, 2)

    def test_pause_and_rate_limit_leave_pending_jobs_unlaunched(self):
        queue = self.queue("limit", 2)
        work = self.root / "work"
        work.mkdir()
        pause = work / "PAUSE"
        pause.touch()
        self.assertEqual(self.run_queue([queue], "limit"), 1)
        self.assertFalse((self.root / "limit tile 0/run.log").exists())
        pause.unlink()
        self.assertEqual(self.run_queue([queue], "limit", "--jobs", "1"), 1)
        self.assertIn("429", (work / "LIMIT_HIT.txt").read_text())
        self.assertEqual((self.root / "limit tile 0/attempts.txt").read_text(), "1")
        self.assertFalse((self.root / "limit tile 1/run.log").exists())

    def test_timeout_and_exhausted_retries_report_failure(self):
        queue = self.queue("timeout", 1)
        self.assertEqual(self.run_queue([queue], "sleep", "--timeout", "0.15"), 1)
        log = (self.root / "work/sched.log").read_text()
        self.assertEqual(log.count("rc timeout"), 2)
        self.assertFalse((self.root / "timeout tile 0/output.png").exists())
        failed = self.queue("failed", 1)
        self.assertEqual(self.run_queue([failed], "fail"), 1)
        self.assertEqual((self.root / "failed tile 0/attempts.txt").read_text(), "2")

    def test_command_can_come_from_environment_and_is_required(self):
        queue = self.queue("env", 1)
        argv = ["run", str(queue), "--work", str(self.root / "work"), "--poll-interval", "0.01"]
        with patch.dict(os.environ, {"TERRAIN_TILES_COMMAND": ""}):
            self.assertEqual(tt.main(argv), 1)
        with patch.dict(os.environ, {"TERRAIN_TILES_COMMAND": self.command("copy")}):
            self.assertEqual(tt.main(argv), 0)


if __name__ == "__main__":
    unittest.main()
