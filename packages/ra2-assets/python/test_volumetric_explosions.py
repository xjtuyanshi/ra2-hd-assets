"""Asset-free regressions; run with python3 test_volumetric_explosions.py.

All references, redraws and atlas pages are synthetic; no image-model calls or
game resources are needed. The CLI uses the same local fixtures as the API.
"""

from __future__ import annotations

import contextlib
import fcntl
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

import effect_flipbooks as ef
from test_effect_flipbooks import synthetic_library
import volumetric_explosions as vx

PREVIOUS = (
    "- reference_previous.png: the already redrawn PREVIOUS frames of this same animation (approved). Continue them "
    "seamlessly: same colours, lighting, fire, smoke and debris style, same level of detail; the same lobes and smoke masses "
    "keep evolving. Its layout does not apply; the layout comes from input.png."
)
SIBLING = (
    "Additional file:\n"
    "- sibling_reference.png: an APPROVED redraw of a sibling explosion of this same remaster (another animation, already accepted). "
    "Match its rendering style, palette, contrast and level of detail exactly, so all explosions of the game look like one family. "
    "Its layout and frames do not apply; the layout comes from input.png."
)


def atlas_frame(directory: Path, meta: dict, anim: str, index: int) -> np.ndarray | None:
    frame = meta["anims"][anim]["frames"][index]
    if frame is None:
        return None
    with Image.open(directory / meta["pages"][frame["page"]]["file"]) as image:
        pixels = np.array(image.convert("RGBA"))
    x, y, w, h = frame["rect"]
    return pixels[y:y + h, x:x + w].copy()


class PromptTests(unittest.TestCase):
    def test_layout_prohibitions_size_and_exact_optional_paragraphs(self):
        for kind in vx.KIND:
            for previous, sibling in ((False, False), (True, False), (False, True), (True, True)):
                with self.subTest(kind=kind, previous=previous, sibling=sibling):
                    text = vx.prompt(kind, 3, 2, 2, 4, 6, 10, (400, 300), previous, sibling)
                    self.assertIn(
                        "It defines for every cell WHERE the explosion is, HOW BIG it is and WHICH PHASE it is in "
                        "(flash, fireball, smoke). It does NOT define the look.", text,
                    )
                    self.assertIn("do not merge, move, reorder or rescale cells", text)
                    self.assertIn(
                        "MUST NOT happen (this is why we redraw): an even orange ball; a round disc with a spiky rim; "
                        "a symmetric blob; uniform colour; a flat cartoon / sticker / 2D look.", text,
                    )
                    self.assertIn(vx.KIND[kind], text)
                    self.assertIn("frames 4..6 of 10", text)
                    self.assertIn("a 2x2 grid", text)
                    self.assertEqual(text.count("exactly 400x300"), 2)
                    self.assertIn("input.png (400x300 pixels)", text)
                    if previous:
                        self.assertIn(PREVIOUS, text)
                    else:
                        self.assertNotIn("reference_previous.png", text)
                    if sibling:
                        self.assertIn("\n\n" + SIBLING + "\n\nUse your image generation", text)
                    else:
                        self.assertNotIn("sibling_reference.png", text)
                        self.assertNotIn("Additional file:", text)
                    self.assertTrue(text.endswith("before resizing.\n"))


class SharpenTests(unittest.TestCase):
    def test_flat_image_dtype_shape_and_input_are_preserved(self):
        image = np.full((20, 24, 4), [80, 100, 120, 140], np.uint8)
        original = image.copy()
        sharpened = vx.sharpen(image, 0.8)
        self.assertEqual(sharpened.dtype, image.dtype)
        self.assertEqual(sharpened.shape, image.shape)
        np.testing.assert_array_equal(sharpened, image)
        np.testing.assert_array_equal(image, original)
        np.testing.assert_array_equal(vx.sharpen(image, 0), image)

    def test_edge_contrast_increases_and_alpha_changes_less_than_colour(self):
        image = np.full((24, 24, 4), 80, np.uint8)
        image[:, 12:] = 160
        sharpened = vx.sharpen(image, 0.8)
        self.assertLess(sharpened[12, 11, 0], 80)
        self.assertGreater(sharpened[12, 12, 0], 160)
        self.assertGreater(int(sharpened[12, 12, 0]) - int(sharpened[12, 11, 0]), 80)
        difference = np.abs(sharpened.astype(int) - image.astype(int))
        self.assertGreater(difference[..., 3].max(), 0)
        self.assertLess(difference[..., 3].max(), difference[..., :3].max())

    def test_large_amount_clips_instead_of_wrapping(self):
        image = np.zeros((20, 20, 4), np.uint8)
        image[:, 10:] = 255
        sharpened = vx.sharpen(image, 10)
        np.testing.assert_array_equal(sharpened[:, 9], 0)
        np.testing.assert_array_equal(sharpened[:, 10], 255)


class MatteTests(unittest.TestCase):
    def test_faint_neutral_explosion_haze_has_less_coverage_than_fire(self):
        cell = np.full((40, 40, 3), 118, np.uint8)
        cell[14:26, 14:26] = 118 + 18
        footprint = np.ones((40, 40))
        _, explosion, bg = ef.matte(cell, footprint, footprint, "explosion")
        _, fire, _ = ef.matte(cell, footprint, footprint, "fire")
        np.testing.assert_array_equal(bg, [118, 118, 118])
        self.assertGreater(explosion[20, 20], 0)
        self.assertLess(explosion[20, 20], 0.1)
        self.assertGreater(fire[20, 20], 0.7)
        self.assertLess(explosion[20, 20], fire[20, 20] / 5)
        self.assertEqual(explosion[0, 0], 0)


class WorkflowTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="volumetric-explosions-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.library = synthetic_library(self.root / "native", ("TINY", "KEPT"))
        self.jobs = self.root / "jobs with spaces"
        self.big, self.small, self.sibling = (self.root / name for name in ("big.png", "small.png", "sibling.png"))
        Image.new("RGBA", (5, 4), (255, 80, 10, 255)).save(self.big)
        Image.new("RGB", (3, 2), (20, 30, 40)).save(self.small)
        Image.new("RGB", (7, 6), (240, 100, 20)).save(self.sibling)
        self.base, self.hd = self.root / "base", self.root / "variant"
        self.base.mkdir()
        self.hd.mkdir()
        pages = []
        y, x = np.indices((16, 20))
        for index in range(2):
            pixels = np.dstack((x * 7, y * 9, x + y + index * 60, np.full_like(x, 220))).astype(np.uint8)
            filename = f"base-{index}.png"
            Image.fromarray(pixels).save(self.base / filename)
            (self.hd / filename).symlink_to(self.base / filename)
            pages.append({"file": filename, "width": 20, "height": 16})
        self.base_meta = {
            "version": 1, "pages": pages,
            "anims": {
                "TINY": {"scale": 2, "frames": [
                    {"page": 0, "rect": [1, 2, 5, 4], "offset": [-5.5, -4]},
                    {"page": 0, "rect": [8, 1, 4, 6], "offset": [2.5, 1.5]}, None,
                ]},
                "KEPT": {"scale": 2, "frames": [
                    {"page": 1, "rect": [2, 3, 6, 5], "offset": [-2, 1]},
                    {"page": 0, "rect": [9, 7, 3, 4], "offset": [3, -1]}, None,
                ]},
            },
        }
        (self.base / "effects-hd.json").write_text(json.dumps(self.base_meta))
        current = json.loads(json.dumps(self.base_meta))
        current["variant_note"] = "preserve this metadata"
        # A prior tag page before the two base pages forces unrelated frames to remap.
        current["pages"].insert(0, {"file": "effects-hd-fx5-0.png", "width": 20, "height": 16})
        for entry in current["anims"].values():
            for frame in entry["frames"]:
                if frame is not None:
                    frame["page"] += 1
        for frame in current["anims"]["TINY"]["frames"]:
            if frame is not None:
                frame["page"] = 0
        Image.new("RGBA", (20, 16), (1, 2, 3, 4)).save(self.hd / "effects-hd-fx5-0.png")
        self.target = self.root / "shared-metadata.json"
        self.target.write_text(json.dumps(current))
        (self.hd / "effects-hd.json").symlink_to(self.target)
        self.original_json = self.target.read_bytes()

    def write_jobs(self, **kwargs):
        with contextlib.redirect_stdout(io.StringIO()):
            vx.write_jobs(self.library, "TINY", [(0, 0), (1, 1)], self.jobs, self.big, self.small, **kwargs)

    def pack(self, **kwargs):
        return vx.pack_variant(self.library, ["TINY"], self.jobs, self.hd, self.base, **kwargs)

    def metadata(self):
        return json.loads((self.hd / "effects-hd.json").read_text())

    def test_style_reference_doubles_crops_and_preserves_grey_gap(self):
        reference = vx.style_reference(self.big, self.small)
        self.assertEqual(reference.mode, "RGB")
        self.assertEqual(reference.size, (40, 8))
        pixels = np.array(reference)
        np.testing.assert_array_equal(pixels[:, :10], np.full((8, 10, 3), [255, 80, 10], np.uint8))
        self.assertTrue(np.all(pixels[:, 10:34] == 118))
        np.testing.assert_array_equal(pixels[:4, 34:], np.full((4, 6, 3), [20, 30, 40], np.uint8))
        self.assertTrue(np.all(pixels[4:, 34:] == 118))

    def test_job_sheets_layout_and_first_chunk_sibling_match_contract(self):
        self.write_jobs(kind="mushroom", cols=3, scale=3, sibling=self.sibling)
        indices = self.library.frame_indices("TINY")
        for index in range(2):
            directory = self.jobs / f"TINY_{index}"
            sheet, expected = ef.make_sheet("TINY", indices, self.library.palette, [index], 3, 3)
            expected["footprint_grow"] = 12
            self.assertEqual(json.loads((directory / "layout.json").read_text()), expected)
            with Image.open(directory / "input.png") as image:
                np.testing.assert_array_equal(np.array(image), np.array(sheet))
            with Image.open(directory / "style_reference.png") as image:
                np.testing.assert_array_equal(np.array(image), np.array(vx.style_reference(self.big, self.small)))
            self.assertEqual((directory / "prompt.txt").read_text(), vx.prompt(
                "mushroom", 1, 1, 1, index, index, 3, sheet.size, previous=index > 0, sibling=index == 0,
            ))
        self.assertEqual((self.jobs / "TINY_0/sibling_reference.png").read_bytes(), self.sibling.read_bytes())
        self.assertFalse((self.jobs / "TINY_1/sibling_reference.png").exists())

    def test_pack_twice_remaps_unrelated_frames_falls_back_and_replaces_symlink_atomically(self):
        self.write_jobs()
        first_job = self.jobs / "TINY_0"
        shutil.copyfile(first_job / "input.png", first_job / "output.png")
        expected = ef.cut_anim(self.library, "TINY", "explosion", [first_job])[0]
        base_json = (self.base / "effects-hd.json").read_bytes()
        kept_pages = {p["file"]: (self.base / p["file"]).read_bytes() for p in self.base_meta["pages"]}
        real_replace = vx.os.replace

        def replace(source, destination):
            if Path(destination) == self.hd / "effects-hd.json":
                self.assertTrue(Path(destination).is_symlink())
            real_replace(source, destination)

        with patch.object(vx.os, "replace", side_effect=replace):
            summary = self.pack()
        self.assertEqual(summary["TINY"], {"new": 1, "base": 1, "frames": 3})
        self.assertEqual(summary["pages"], ["base-0.png", "base-1.png", "effects-hd-fx5-0.png"])
        self.assertFalse((self.hd / "effects-hd.json").is_symlink())
        meta = self.metadata()
        self.assertEqual(meta["variant_note"], "preserve this metadata")
        self.assertEqual(meta["anims"]["KEPT"], self.base_meta["anims"]["KEPT"])
        self.assertEqual(meta["anims"]["TINY"]["frames"][0]["page"], 2)
        np.testing.assert_array_equal(atlas_frame(self.hd, meta, "TINY", 0), vx.sharpen(expected["rgba"], 0.8))
        np.testing.assert_array_equal(atlas_frame(self.hd, meta, "TINY", 1), atlas_frame(self.base, self.base_meta, "TINY", 1))
        self.assertEqual(meta["anims"]["TINY"]["frames"][1]["offset"], [2.5, 1.5])
        self.assertEqual(meta["anims"]["TINY"]["scale"], 2)
        self.assertIsNone(meta["anims"]["TINY"]["frames"][2])
        for index in (0, 1):
            np.testing.assert_array_equal(atlas_frame(self.hd, meta, "KEPT", index), atlas_frame(self.base, self.base_meta, "KEPT", index))
        self.assertEqual(self.pack(), summary)
        self.assertEqual(self.metadata(), meta)
        self.assertEqual(self.target.read_bytes(), self.original_json)
        self.assertEqual((self.base / "effects-hd.json").read_bytes(), base_json)
        for filename, contents in kept_pages.items():
            self.assertEqual((self.hd / filename).read_bytes(), contents)
        self.assertFalse(list(self.hd.glob(".pack-*")))

    def test_empty_finished_frame_also_falls_back_and_missing_base_frames_stay_null(self):
        self.write_jobs()
        with Image.open(self.jobs / "TINY_0/input.png") as image:
            Image.new("RGB", image.size, (118, 118, 118)).save(self.jobs / "TINY_0/output.png")
        summary = self.pack(sharpen_amount=0)
        self.assertEqual(summary["TINY"], {"new": 0, "base": 2, "frames": 3})
        for index in (0, 1):
            np.testing.assert_array_equal(atlas_frame(self.hd, self.metadata(), "TINY", index), atlas_frame(self.base, self.base_meta, "TINY", index))
        self.assertIsNone(atlas_frame(self.hd, self.metadata(), "TINY", 2))

    def test_custom_lock_is_held_during_pack_and_released_afterward(self):
        lock = self.root / "shared.lock"
        real_pack = ef.pack

        def locked_pack(*args, **kwargs):
            with lock.open("a") as handle:
                with self.assertRaises(BlockingIOError):
                    fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
            return real_pack(*args, **kwargs)

        with patch.object(ef, "pack", side_effect=locked_pack):
            self.assertEqual(self.pack(lock=lock)["TINY"], {"new": 0, "base": 2, "frames": 3})
        with lock.open("a") as handle:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)

    def test_unpacked_animation_on_dropped_page_fails_without_mutating_cache(self):
        current = json.loads(self.original_json)
        current["anims"]["KEPT"]["frames"][0]["page"] = 0
        self.target.write_text(json.dumps(current))
        before = self.target.read_bytes()
        page = (self.hd / "effects-hd-fx5-0.png").read_bytes()
        with self.assertRaisesRegex(ValueError, "KEPT uses a dropped page"):
            self.pack()
        self.assertTrue((self.hd / "effects-hd.json").is_symlink())
        self.assertEqual(self.target.read_bytes(), before)
        self.assertEqual((self.hd / "effects-hd-fx5-0.png").read_bytes(), page)
        self.assertFalse(list(self.hd.glob(".pack-*")))

    def test_invalid_ranges_are_rejected_before_job_artifacts(self):
        for chunks in ([], [(-1, 0)], [(1, 0)], [(0, 3)], [(0, 1), (1, 2)]):
            with self.subTest(chunks=chunks):
                with self.assertRaises(ValueError):
                    vx.write_jobs(self.library, "TINY", chunks, self.jobs, self.big, self.small)
        self.assertFalse(self.jobs.exists())

    def test_cli_jobs_and_comma_separated_pack_without_sharpening(self):
        def cli(*arguments):
            return subprocess.run([sys.executable, str(Path(vx.__file__).resolve()), *arguments],
                                  capture_output=True, text=True, timeout=15)

        result = cli("jobs", "TINY", "0-0,1-1", "--library", str(self.library.directory),
                     "--jobs", str(self.jobs), "--big", str(self.big), "--small", str(self.small),
                     "--kind", "ground", "--cols", "2", "--scale", "3", "--sibling", str(self.sibling))
        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
        directory = self.jobs / "TINY_0"
        shutil.copyfile(directory / "input.png", directory / "output.png")
        expected = ef.cut_anim(self.library, "TINY", "explosion", [directory])[0]
        result = cli("pack", "TINY,KEPT", "--library", str(self.library.directory), "--jobs", str(self.jobs),
                     "--hd", str(self.hd), "--base", str(self.base), "--tag", "cli", "--sharpen", "0")
        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
        summary = json.loads(result.stdout)
        self.assertEqual(summary["TINY"], {"new": 1, "base": 1, "frames": 3})
        self.assertEqual(summary["KEPT"], {"new": 0, "base": 2, "frames": 3})
        self.assertEqual(summary["pages"][-1], "effects-hd-cli-0.png")
        np.testing.assert_array_equal(atlas_frame(self.hd, self.metadata(), "TINY", 0), expected["rgba"])
        result = cli("jobs", "TINY", "invalid", "--library", str(self.library.directory), "--jobs", str(self.jobs),
                     "--big", str(self.big), "--small", str(self.small))
        self.assertEqual(result.returncode, 2)
        self.assertIn("expected first-last", result.stderr)


if __name__ == "__main__":
    unittest.main()
