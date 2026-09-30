"""Asset-free regression tests; run with pytest or python3 test_effect_flipbooks.py.

Synthetic indexed sprites, grey sheets and a local fake Codex process exercise
the complete CLI without game files, network access or image-model calls.
"""

from __future__ import annotations

import contextlib
import io
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

import numpy as np
from PIL import Image

import effect_flipbooks as fx


def synthetic_library(directory: Path, names: tuple[str, ...] = ("TINY",)) -> fx.EffectLibrary:
    directory.mkdir(parents=True)
    (directory / "palettes").mkdir()
    palette = np.zeros((1, 256, 3), np.uint8)
    palette[0, 0] = (255, 0, 255)  # Palette index zero must still be transparent.
    palette[0, 1] = (255, 165, 40)
    palette[0, 2] = (45, 40, 35)
    Image.fromarray(palette).save(directory / "palettes/anim.png")
    page0, page1 = np.zeros((8, 8), np.uint8), np.zeros((8, 8), np.uint8)
    page0[2:4, 1:4] = [[1, 0, 2], [2, 1, 1]]
    page1[1:4, 3:5] = 2
    Image.fromarray(page0).save(directory / "native-0.png")
    Image.fromarray(page1).save(directory / "native-1.png")
    data = {
        "spriteAtlases": [{"file": "native-0.png"}, {"file": "native-1.png"}],
        "anims": {name: {"sprite": f"anim:{name}", "frameCount": 3} for name in names},
        "sprites": {
            f"anim:{name}": {
                "canvas": [31, 29],
                "frames": [
                    {"rect": [1, 2, 3, 2], "offset": [-5, -4]},
                    {"page": 1, "rect": [3, 1, 2, 3], "offset": [3, 2]},
                    {"rect": [0, 0, 0, 0], "offset": [0, 0]},
                ],
            }
            for name in names
        },
    }
    (directory / "effects.json").write_text(json.dumps(data))
    return fx.EffectLibrary(directory)


def job(anim: str = "TINY", chunks: list | None = None, sibling: str | None = None) -> dict:
    value = {"anim": anim, "kind": "fire", "chunks": chunks or [[0, 1], [2, 2]], "scale": 3, "cols": 2}
    if sibling:
        value["sibling"] = sibling
    return value


class TemporaryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="effect-flipbooks-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)


class SheetTests(TemporaryTests):
    def test_indexed_sidecar_restores_canvas_offsets_pages_and_transparency(self):
        library = synthetic_library(self.root / "effects")
        frames = library.frame_indices("TINY")
        self.assertEqual(len(frames), 3)
        expected0, expected1 = np.zeros((29, 31), np.uint8), np.zeros((29, 31), np.uint8)
        expected0[10:12, 10:13] = [[1, 0, 2], [2, 1, 1]]
        expected1[16:19, 18:20] = 2
        np.testing.assert_array_equal(frames[0], expected0)
        np.testing.assert_array_equal(frames[1], expected1)
        self.assertFalse(frames[2].any())
        rgba = fx.frame_rgba(frames[0], library.palette)
        self.assertEqual(rgba[10, 11, 3], 0)
        np.testing.assert_array_equal(rgba[10, 10], [255, 165, 40, 255])

    def test_union_layout_uses_all_frames_and_leaves_grey_gaps_and_unused_cells(self):
        library = synthetic_library(self.root / "effects")
        indices = library.frame_indices("TINY")
        self.assertEqual(fx.union_bbox(indices), (6, 6, 24, 23))
        sheet, layout = fx.make_sheet("TINY", indices, library.palette, [0, 2, 1], scale=2, cols=2, gap=5)
        self.assertEqual(layout["bbox"], [6, 6, 24, 23])
        self.assertEqual(sheet.size, (87, 83))
        self.assertEqual(layout["size"], [87, 83])
        self.assertEqual(
            layout["cells"],
            [
                {"frame": 0, "x": 5, "y": 5, "w": 36, "h": 34},
                {"frame": 2, "x": 46, "y": 5, "w": 36, "h": 34},
                {"frame": 1, "x": 5, "y": 44, "w": 36, "h": 34},
            ],
        )
        pixels = np.array(sheet)
        self.assertTrue(np.all(pixels[:5] == 118))
        self.assertTrue(np.all(pixels[39:44] == 118))
        self.assertTrue(np.all(pixels[5:39, 46:82] == 118))  # Empty native frame.
        self.assertTrue(np.all(pixels[44:78, 46:82] == 118))  # Unused grid cell.
        _, subset = fx.make_sheet("TINY", indices, library.palette, [0], scale=2)
        self.assertEqual(subset["bbox"], layout["bbox"])

    def test_all_empty_animation_still_has_a_valid_sheet(self):
        sheet, layout = fx.make_sheet(
            "EMPTY", [np.zeros((3, 4), np.uint8)], np.zeros((256, 3), np.uint8), [0], scale=3, cols=1, gap=2
        )
        self.assertEqual(layout["bbox"], [0, 0, 4, 3])
        self.assertEqual(sheet.size, (16, 13))
        self.assertTrue(np.all(np.array(sheet) == 118))


class MatteTests(unittest.TestCase):
    def setUp(self):
        self.cell = np.full((40, 40, 3), 118, np.uint8)
        self.zeros, self.ones = np.zeros((40, 40)), np.ones((40, 40))

    def test_grey_and_background_noise_have_no_colour_or_alpha(self):
        self.cell[15:20, 15:20] = 120
        self.cell[20:25, 15:20] = 116
        p, alpha, bg = fx.matte(self.cell, self.ones, self.ones, "explosion")
        np.testing.assert_array_equal(bg, [118, 118, 118])
        self.assertFalse(p.any())
        self.assertFalse(alpha.any())

    def test_saturated_fire_keeps_emission_even_at_zero_coverage(self):
        self.cell[15:25, 15:25] = (255, 180, 118)
        p, alpha, _ = fx.matte(self.cell, self.zeros, self.ones, "fire")
        self.assertEqual(alpha[20, 20], 0)
        self.assertGreater(p[20, 20, 0], 0.8)
        self.assertGreater(p[20, 20, 1], 0.25)
        self.assertEqual(p[20, 20, 2], 0)
        # Emission is stored as premultiplied light, not divided by a zero alpha.
        np.testing.assert_allclose(p[20, 20] + fx.s2l(np.array([118.0] * 3)), fx.s2l(self.cell[20, 20].astype(float)))
        covered, coverage, _ = fx.matte(self.cell, self.ones, self.ones, "fire")
        self.assertEqual(coverage[20, 20], 1)
        np.testing.assert_allclose(covered[20, 20], fx.s2l(self.cell[20, 20].astype(float)))

    def test_dark_smoke_covers_background_and_neutral_highlights_do_not_emit(self):
        self.cell[14:26, 14:26] = 40
        p, alpha, _ = fx.matte(self.cell, self.zeros, self.ones, "explosion")
        self.assertGreater(alpha[20, 20], 0.88)
        self.assertLess(alpha[20, 20], 1)
        np.testing.assert_allclose(p[20, 20], 0, atol=1e-16)
        np.testing.assert_allclose(
            p[20, 20] + (1 - alpha[20, 20]) * fx.s2l(np.array([118.0] * 3)), fx.s2l(np.array([40.0] * 3))
        )
        self.cell[14:26, 14:26] = 200
        light, coverage, _ = fx.matte(self.cell, self.zeros, self.ones, "explosion")
        self.assertFalse(light.any())
        self.assertFalse(coverage.any())

    def test_footprint_excludes_stray_art_and_fire_rejects_green_haze(self):
        self.cell[15:25, 15:25] = (180, 255, 118)
        p, _, _ = fx.matte(self.cell, self.zeros, self.ones, "fire")
        self.assertEqual(p[20, 20, 0], p[20, 20, 1])
        p, alpha, _ = fx.matte(self.cell, self.ones, self.zeros, "fire")
        self.assertFalse(p.any())
        self.assertFalse(alpha.any())


class CutTests(TemporaryTests):
    def test_sheet_cut_returns_to_native_coordinates_at_both_target_scales(self):
        indices = [np.zeros((29, 31), np.uint8) for _ in range(3)]
        indices[0][10:13, 12:15] = 1
        indices[1][15:17, 18:20] = 1
        palette = np.zeros((256, 3), np.uint8)
        for scale, target in ((3, 2), (5, 3)):
            with self.subTest(scale=scale):
                sheet, layout = fx.make_sheet(
                    "TINY", indices, palette, [1, 0, 2], scale=scale, cols=2, bbox=(5, 4, 25, 24)
                )
                # Put exact synthetic redraws in off-centre cells, in a different order from frame indices.
                sheet.paste((118, 118, 118), (0, 0, *sheet.size))
                for cell in layout["cells"]:
                    if cell["frame"] == 2:
                        continue
                    x, y, w, h = (12, 10, 3, 3) if cell["frame"] == 0 else (18, 15, 2, 2)
                    left = cell["x"] + (x - 5) * scale
                    top = cell["y"] + (y - 4) * scale
                    sheet.paste((255, 160, 40), (left, top, left + w * scale, top + h * scale))
                frames = fx.cut_sheet(sheet, layout, indices, "fire")
                self.assertIsNone(frames[2])
                for index, (x, y, w, h) in enumerate(((12, 10, 3, 3), (18, 15, 2, 2))):
                    frame = frames[index]
                    self.assertEqual(frame["scale"], target)
                    self.assertEqual(frame["rgba"].shape, (h * target + 4, w * target + 4, 4))
                    np.testing.assert_allclose(frame["offset"], [x - 15 - 2 / target, y - 14 - 2 / target])
                    ys, xs = np.nonzero(frame["rgba"][..., 3])
                    # Crop placement + texel position must land on the original native pixel boundary.
                    self.assertAlmostEqual(frame["offset"][0] + xs.min() / target, x - 15)
                    self.assertAlmostEqual(frame["offset"][1] + ys.min() / target, y - 14)

    def test_cut_anim_preserves_native_list_length_and_accepts_resized_output(self):
        library = synthetic_library(self.root / "effects")
        jobs_dir = self.root / "jobs"
        with contextlib.redirect_stdout(io.StringIO()):
            fx.write_sheets(library, [job(chunks=[[1, 1]])], jobs_dir)
        directory = jobs_dir / "TINY_0"
        with Image.open(directory / "input.png") as image:
            image.resize((image.width * 2, image.height * 2)).save(directory / "output.png")
        frames = fx.cut_anim(library, "TINY", "fire", [directory])
        self.assertEqual(len(frames), 3)
        self.assertIsNone(frames[0])
        self.assertIsNotNone(frames[1])
        self.assertIsNone(frames[2])


class PackTests(TemporaryTests):
    def test_schema_pages_rects_offsets_and_pixels_are_consistent(self):
        def frame(width, height, colour, offset):
            return {"rgba": np.full((height, width, 4), colour, np.uint8), "scale": 3, "offset": offset}

        a = frame(8, 8, [220, 60, 0, 0], [1 / 3, -2 / 3])  # Zero-alpha emission survives packing.
        b = frame(8, 8, [10, 20, 30, 220], [-1, 2])
        c = frame(4, 4, [40, 50, 60, 255], [0, 0])
        anims = {"A": ("fire", [a, None, c]), "B": ("tesla", [b]), "EMPTY": ("impact", [None])}
        meta = fx.pack(anims, self.root / "out", page_size=12)
        self.assertEqual(set(meta), {"version", "pages", "anims"})
        self.assertEqual(meta["version"], 1)
        self.assertEqual(len(meta["pages"]), 3)
        self.assertEqual(meta["anims"]["A"]["scale"], 3)
        self.assertIsNone(meta["anims"]["A"]["frames"][1])
        self.assertEqual(meta["anims"]["EMPTY"], {"scale": 2, "frames": [None]})
        self.assertEqual(meta["anims"]["A"]["frames"][0]["offset"], [0.3333, -0.6667])
        self.assertEqual(json.loads((self.root / "out/effects-hd.json").read_text()), meta)
        for name, (_, frames) in anims.items():
            for source, stored in zip(frames, meta["anims"][name]["frames"]):
                if source is None:
                    self.assertIsNone(stored)
                    continue
                self.assertEqual(set(stored), {"page", "rect", "offset"})
                page = meta["pages"][stored["page"]]
                self.assertEqual(set(page), {"file", "width", "height"})
                with Image.open(self.root / "out" / page["file"]) as image:
                    self.assertEqual(image.size, (page["width"], page["height"]))
                    pixels = np.array(image)
                x, y, w, h = stored["rect"]
                self.assertGreaterEqual(x, 0)
                self.assertGreaterEqual(y, 0)
                self.assertLessEqual(x + w, page["width"])
                self.assertLessEqual(y + h, page["height"])
                np.testing.assert_array_equal(pixels[y : y + h, x : x + w], source["rgba"])
                self.assertFalse(pixels[y : y + h, x + w : x + w + 2].any())

    def test_oversized_or_mixed_scale_frames_fail_before_writing_pages(self):
        frame = {"rgba": np.zeros((11, 11, 4), np.uint8), "scale": 2, "offset": [0, 0]}
        with self.assertRaisesRegex(ValueError, "exceeds"):
            fx.pack({"A": ("fire", [frame])}, self.root / "oversize", page_size=10)
        other = {**frame, "scale": 3}
        with self.assertRaisesRegex(ValueError, "same HD scale"):
            fx.pack({"A": ("fire", [frame, other])}, self.root / "mixed")
        self.assertFalse((self.root / "oversize").exists())
        self.assertFalse((self.root / "mixed").exists())

    def test_height_sort_shelves_and_power_of_two_page_crop(self):
        frames = [
            {"rgba": np.full((h, w, 4), 200, np.uint8), "scale": 2, "offset": [0, 0]}
            for w, h in ((210, 100), (300, 129), (70, 100))
        ]
        meta = fx.pack({"A": ("fire", frames)}, self.root / "shelves", page_size=512)
        self.assertEqual(meta["pages"], [{"file": "effects-hd-0.png", "width": 512, "height": 256}])
        stored = meta["anims"]["A"]["frames"]
        self.assertEqual([f["rect"] for f in stored], [[0, 131, 210, 100], [0, 0, 300, 129], [212, 131, 70, 100]])
        empty = fx.pack({"EMPTY": ("fire", [None])}, self.root / "empty", page_size=512)
        self.assertEqual(empty["pages"], meta["pages"])
        with Image.open(self.root / "empty/effects-hd-0.png") as image:
            self.assertFalse(np.array(image).any())


class PromptAndJobTests(TemporaryTests):
    def test_layout_lock_and_reference_paragraphs(self):
        for kind in fx.KIND:
            plain = fx.prompt(kind, 3, 2, 2, 0, 2, 3, [400, 300])
            self.assertIn("LAYOUT LOCK", plain)
            self.assertIn("do not merge, move, rescale or reorder cells", plain)
            self.assertIn("empty areas stay empty", plain)
            self.assertIn("flat grey (118,118,118)", plain)
            self.assertIn("exactly 400x300 pixels", plain)
            self.assertNotIn("reference_previous.png", plain)
            previous = fx.prompt(kind, 3, 2, 2, 0, 2, 3, [400, 300], prev=True)
            self.assertIn("PREVIOUS frames of this same animation", previous)
            self.assertNotIn("SIBLING", previous)
            sibling = fx.prompt(kind, 3, 2, 2, 0, 2, 3, [400, 300], sibling=True)
            self.assertIn("SIBLING animation", sibling)
            self.assertIn("Do not copy its layout or shapes", sibling)
            self.assertNotIn("PREVIOUS frames", sibling)
        self.assertIn("NO orange, NO yellow, NO red fire", fx.prompt("blueexp", 1, 1, 1, 0, 0, 1, [100, 100]))

    def test_combined_final_job_list_and_invalid_ranges(self):
        jobs = fx.load_jobs(fx.DEFAULT_JOBS)
        self.assertEqual(len(jobs), 46)
        self.assertEqual(sum(len(entry["chunks"]) for entry in jobs), 69)
        by_name = {entry["anim"]: entry for entry in jobs}
        self.assertNotIn("FIREPOWR", by_name)
        self.assertEqual(by_name["EXPLOLB"]["kind"], "blueexp")
        self.assertNotIn("sibling", by_name["EXPLOLB"])
        self.assertEqual(by_name["S_BANG16"]["sibling"], "S_BANG34_0")
        for bad in (
            job(chunks=[[1, 0]]),
            job(chunks=[[0, 1], [1, 2]]),
            job(anim="../escape"),
            {**job(), "scale": 0},
            {**job(), "cols": True},
        ):
            path = self.root / "bad.json"
            path.write_text(json.dumps([bad]))
            with self.assertRaises(ValueError):
                fx.load_jobs(path)


# This executable validates the real subprocess argument/cwd contract and logs
# process lifetime events atomically, so concurrency tests observe live calls.
FAKE_CODEX = """#!/usr/bin/env python3
import json, os, pathlib, shutil, sys, time
d = pathlib.Path.cwd()
assert sys.argv[1:6] == ['exec', '-s', 'workspace-write', '--skip-git-repo-check', '-C']
assert sys.argv[6:9] == [str(d), '-o', str(d / 'last.txt')]
assert len(sys.argv) == 10 and sys.argv[9] == (d / 'prompt.txt').read_text()
assert sys.stdin.read() == ''
def event(kind):
    fd = os.open(d.parent / 'events.jsonl', os.O_CREAT | os.O_WRONLY | os.O_APPEND, 0o600)
    os.write(fd, (json.dumps([kind, d.name]) + '\\n').encode())
    os.close(fd)
event('start')
behavior = json.loads((d / 'behavior.json').read_text()) if (d / 'behavior.json').exists() else {}
if behavior.get('limit'):
    print(behavior['limit'], flush=True)
time.sleep(behavior.get('sleep', 0.12))
if not behavior.get('no_output'):
    shutil.copyfile(d / 'input.png', d / 'output.png')
(d / 'last.txt').write_text('synthetic result')
event('end')
sys.exit(behavior.get('exit', 0))
"""


class SchedulerTests(TemporaryTests):
    def prepare(self, jobs):
        library = synthetic_library(self.root / "effects", tuple(entry["anim"] for entry in jobs))
        self.jobs_dir = self.root / "jobs with spaces"
        with contextlib.redirect_stdout(io.StringIO()):
            fx.write_sheets(library, jobs, self.jobs_dir)
        self.codex = self.root / "fake codex"
        self.codex.write_text(FAKE_CODEX)
        self.codex.chmod(0o755)
        return library

    def run_jobs(self, jobs, concurrency=2, **kwargs):
        with contextlib.redirect_stdout(io.StringIO()):
            return fx.run_jobs(jobs, self.jobs_dir, str(self.codex), concurrency, poll_interval=0.01, **kwargs)

    def events(self):
        return [json.loads(line) for line in (self.jobs_dir / "events.jsonl").read_text().splitlines()]

    def test_concurrency_previous_and_sibling_dependencies_and_resume(self):
        jobs = [job("SIBLING", [[0, 0], [1, 1]], "BASE_0"), job("BASE"), job("OTHER"), job("FOURTH")]
        self.prepare(jobs)
        self.assertEqual(self.run_jobs(jobs), 0)
        active, maximum = 0, 0
        events = self.events()
        for action, _ in events:
            active += 1 if action == "start" else -1
            maximum = max(maximum, active)
            self.assertGreaterEqual(active, 0)
            self.assertLessEqual(active, 2)
        self.assertEqual(active, 0)
        self.assertEqual(maximum, 2)
        self.assertEqual(len(events), 16)
        for entry in jobs:
            name = entry["anim"]
            self.assertLess(events.index(["end", f"{name}_0"]), events.index(["start", f"{name}_1"]))
            self.assertEqual(
                (self.jobs_dir / f"{name}_1/reference_previous.png").read_bytes(),
                (self.jobs_dir / f"{name}_0/output.png").read_bytes(),
            )
            self.assertTrue((self.jobs_dir / f"{name}_0/start").is_file())
            self.assertTrue((self.jobs_dir / f"{name}_0/end").is_file())
        self.assertLess(events.index(["end", "BASE_0"]), events.index(["start", "SIBLING_0"]))
        self.assertEqual(
            (self.jobs_dir / "SIBLING_0/reference_previous.png").read_bytes(),
            (self.jobs_dir / "BASE_0/output.png").read_bytes(),
        )
        self.assertIn("SIBLING animation", (self.jobs_dir / "SIBLING_0/prompt.txt").read_text())
        self.assertIn("PREVIOUS frames", (self.jobs_dir / "SIBLING_1/prompt.txt").read_text())
        self.assertFalse((self.jobs_dir / "BASE_0/reference_previous.png").exists())
        self.assertEqual(self.run_jobs(jobs), 0)
        self.assertEqual(self.events(), events)

    def test_limits_stop_new_launches_persist_and_allow_explicit_resume(self):
        jobs = [job("LIMITED"), job("WAITING")]
        self.prepare(jobs)
        (self.jobs_dir / "LIMITED_0/behavior.json").write_text(json.dumps({"limit": "HTTP 429 rate limit", "exit": 1}))
        limit_file = self.root / "state/stop.txt"
        self.assertEqual(self.run_jobs(jobs, concurrency=1, limit_file=limit_file), 2)
        self.assertIn("LIMITED_0", limit_file.read_text())
        self.assertEqual(self.events(), [["start", "LIMITED_0"], ["end", "LIMITED_0"]])
        self.assertEqual(self.run_jobs(jobs, concurrency=1, limit_file=limit_file), 2)
        self.assertEqual(len(self.events()), 2)
        limit_file.unlink()
        (self.jobs_dir / "LIMITED_0/behavior.json").unlink()
        self.assertEqual(self.run_jobs(jobs, concurrency=1, limit_file=limit_file), 0)
        self.assertEqual(len(self.events()), 10)

    def test_failure_and_stale_output_cannot_unblock_successors(self):
        jobs = [job()]
        self.prepare(jobs)
        directory = self.jobs_dir / "TINY_0"
        shutil.copyfile(directory / "input.png", directory / "output.png")
        (directory / "exit").write_text("1")
        (directory / "behavior.json").write_text(json.dumps({"no_output": True}))
        self.assertEqual(self.run_jobs(jobs), 1)
        self.assertFalse(fx.done(directory))
        self.assertEqual(self.events(), [["start", "TINY_0"], ["end", "TINY_0"]])
        self.assertFalse((self.jobs_dir / "TINY_1/start").exists())

    def test_limit_detected_while_running_drains_peers_without_replacements(self):
        jobs = [job("LIMITED"), job("ACTIVE"), job("WAITING")]
        self.prepare(jobs)
        (self.jobs_dir / "LIMITED_0/behavior.json").write_text(
            json.dumps({"limit": "usage limit quota exceeded", "sleep": 0.35, "exit": 1})
        )
        self.assertEqual(self.run_jobs(jobs), 2)
        self.assertTrue((self.jobs_dir / "LIMIT_HIT.txt").is_file())
        self.assertEqual({name for action, name in self.events() if action == "start"}, {"LIMITED_0", "ACTIVE_0"})
        self.assertTrue(fx.done(self.jobs_dir / "ACTIVE_0"))
        self.assertFalse((self.jobs_dir / "WAITING_0/start").exists())

    def test_approved_external_sibling_needs_no_run_exit_file(self):
        jobs = [job(sibling="APPROVED_0")]
        self.prepare(jobs)
        approved = self.jobs_dir / "APPROVED_0"
        approved.mkdir()
        shutil.copyfile(self.jobs_dir / "TINY_0/input.png", approved / "output.png")
        self.assertEqual(self.run_jobs(jobs), 0)
        self.assertEqual(
            (self.jobs_dir / "TINY_0/reference_previous.png").read_bytes(), (approved / "output.png").read_bytes()
        )

    def test_missing_and_cyclic_siblings_fail_without_processes(self):
        jobs = [job("A", sibling="B_0"), job("B", sibling="A_0")]
        self.prepare(jobs)
        with self.assertRaisesRegex(ValueError, "cyclic"):
            self.run_jobs(jobs)
        jobs[0]["sibling"] = "MISSING_0"
        with self.assertRaisesRegex(ValueError, "missing approved sibling"):
            self.run_jobs(jobs)
        self.assertFalse((self.jobs_dir / "events.jsonl").exists())

    def test_spawn_error_reaps_calls_already_running(self):
        jobs = [job("A"), job("B")]
        self.prepare(jobs)
        real_popen = subprocess.Popen
        started = []

        def spawn(*args, **kwargs):
            if started:
                raise OSError("synthetic spawn failure")
            process = real_popen(*args, **kwargs)
            started.append(process)
            return process

        with patch.object(fx.subprocess, "Popen", side_effect=spawn):
            with self.assertRaisesRegex(OSError, "synthetic spawn failure"):
                self.run_jobs(jobs)
        self.assertIsNotNone(started[0].poll())
        self.assertTrue((self.jobs_dir / "A_0/exit").is_file())

    def test_cli_sheets_run_pack_and_extra_approved_sheet(self):
        jobs = [job(chunks=[[1, 1], [2, 2]])]
        library = self.prepare(jobs)
        jobs_json = self.root / "jobs.json"
        jobs_json.write_text(json.dumps(jobs))
        script = Path(fx.__file__).resolve()
        common = ["--jobs", str(jobs_json), "--jobs-dir", str(self.jobs_dir)]

        def cli(*arguments):
            return subprocess.run([sys.executable, str(script), *arguments], capture_output=True, text=True, timeout=15)

        for arguments in (
            ("--help",),
            ("sheets", *common, "--effects", str(library.directory)),
            ("run", *common, "--codex", str(self.codex), "--concurrency", "1"),
        ):
            result = cli(*arguments)
            self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
        pilot = self.root / "approved pilot"
        pilot.mkdir()
        sheet, layout = fx.make_sheet("TINY", library.frame_indices("TINY"), library.palette, [0], scale=3)
        sheet.save(pilot / "output.png")
        (pilot / "layout.json").write_text(json.dumps(layout))
        result = cli(
            "pack",
            *common,
            "--effects",
            str(library.directory),
            "--out",
            str(self.root / "packed"),
            "--page-size",
            "128",
            "--extra-sheets",
            str(pilot),
        )
        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
        frames = json.loads((self.root / "packed/effects-hd.json").read_text())["anims"]["TINY"]["frames"]
        self.assertEqual(len(frames), 3)
        self.assertIsNotNone(frames[0])
        self.assertIsNotNone(frames[1])
        self.assertIsNone(frames[2])


if __name__ == "__main__":
    unittest.main()
