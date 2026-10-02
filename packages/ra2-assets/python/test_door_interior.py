"""Fast asset-free tests for door grading, atlas boundaries and copy-on-write installation."""

import contextlib
import hashlib
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock

import numpy as np
from PIL import Image

import door_interior as door


class DoorInteriorTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.base = self.root / "base"
        self.base.mkdir()
        self.farm = self.root / "farm"
        (self.farm / "_library").mkdir(parents=True)
        self.library = self.farm / "_library/urban"
        # Exercise directory realisation as well as replacement of the page symlink.
        self.library.symlink_to(self.base, target_is_directory=True)
        self.out = self.root / "out"
        self.rect = (8, 10, 96, 96)
        x, y, w, h = self.rect
        self.indices = np.zeros((120, 120), np.uint8)
        self.indices[y:y+h, x:x+w] = 15
        self.indices[y+8:y+h-8, x+8:x+w-8] = 4
        self.indices[y+40:y+44, x+40:x+44] = np.arange(16, 32, dtype=np.uint8).reshape(4, 4)
        self.indices[y+60:y+64, x+60:x+64] = 0
        self.palette = np.zeros((256, 4), np.uint8)
        self.palette[:, 3] = 255
        self.palette[15, :3] = 210
        self.palette[4, :3] = 10
        self.palette[16:32, :3] = 3
        Image.fromarray(self.indices).save(self.base / "indexed.png")
        Image.fromarray(self.palette[None, ...]).save(self.base / "palette.png")
        self.hd = np.full((240, 240, 4), (90, 120, 150, 255), np.uint8)
        self.hd[2*y:2*(y+h), 2*x:2*(x+w)] = (210, 210, 210, 255)
        self.hd[2*(y+8):2*(y+h-8), 2*(x+8):2*(x+w-8), :3] = (240, 170, 100)
        # Alpha includes transparent and partially covered pixels and must be copied exactly.
        self.hd[2*(y+24):2*(y+26), 2*(x+24):2*(x+26), 3] = 192
        self.hd[2*(y+60):2*(y+64), 2*(x+60):2*(x+64), 3] = 0
        Image.fromarray(self.hd).save(self.base / "hd.png")
        Image.new("L", (240, 240), 77).save(self.base / "remap.png")
        self.meta = {
            "theater": "urban",
            "types": {"NAWEAP": {"building": {"layers": [{"key": "UnderDoorAnim", "sprite": "anim:NAWEAP_1"}]}}},
            "sprites": {"anim:NAWEAP_1": {"palette": "unit", "remap": True,
                "frames": [{"rect": list(self.rect), "offset": [0, 0]}],
                "shadows": [{"rect": [0, 0, 5, 5], "offset": [0, 0]}]}},
            "spriteAtlases": [{"file": "indexed.png"}],
            "spriteAtlasesHd": [{"file": "hd.png", "remap": "remap.png", "scale": 2}],
            "palettes": {"unit": "palette.png"},
        }
        self.write_library()
        self.original_bytes = {path.name: path.read_bytes() for path in self.base.iterdir()}

    def write_library(self):
        (self.base / "library.json").write_text(json.dumps(self.meta), encoding="utf-8")

    def run_cli(self, *extra):
        stdout, stderr = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            status = door.main(["--library", str(self.library), "--out", str(self.out), *extra])
        return status, stdout.getvalue(), stderr.getvalue()

    def assert_base_unchanged(self):
        for name, original in self.original_bytes.items():
            self.assertEqual((self.base / name).read_bytes(), original, name)

    def test_darkens_interior_and_preserves_border_paint_alpha_transparency_and_other_rects(self):
        status, stdout, stderr = self.run_cli("--dry-run")
        self.assertEqual(status, 0, stderr)
        printed = json.loads(stdout)
        metrics = json.loads((self.out / "urban/metrics.json").read_text())
        self.assertEqual(printed, metrics["frames"][0])
        measured = metrics["frames"][0]
        self.assertGreater(measured["interior_pixels"], 0)
        self.assertLess(abs(measured["hd_after_mean_srgb_luma"] - measured["original_mean_srgb_luma"]), 0.05)
        self.assertGreater(measured["hd_before_mean_srgb_luma"] - measured["hd_after_mean_srgb_luma"], 0.5)
        self.assertEqual(measured["max_abs_change_outside_mask"], 0)
        with Image.open(self.out / "urban/hd.png") as image:
            after = np.array(image)
            marker = json.loads(image.info[door.MARKER])
        up = self.indices.repeat(2, 0).repeat(2, 1)
        protected = (up == 15) | (up == 0) | ((up >= 16) & (up <= 31))
        np.testing.assert_array_equal(after[protected], self.hd[protected])
        np.testing.assert_array_equal(after[..., 3], self.hd[..., 3])
        outside = np.ones(up.shape, bool)
        x, y, w, h = self.rect
        outside[2*y:2*(y+h), 2*x:2*(x+w)] = False
        np.testing.assert_array_equal(after[outside], self.hd[outside])
        source_hash = hashlib.sha256(self.original_bytes["hd.png"]).hexdigest()
        self.assertEqual(metrics["pages"][0]["source_sha256"], source_hash)
        self.assertEqual(marker["source_sha256"], source_hash)
        with Image.open(self.out / "urban/door_interior.jpg") as sheet:
            self.assertLessEqual(sheet.width, 2000)
        self.assert_base_unchanged()

    def test_install_replaces_symlink_and_refuses_second_install_unless_forced(self):
        self.assertTrue((self.library / "hd.png").is_symlink() or self.library.is_symlink())
        status, _, stderr = self.run_cli("--install", str(self.farm))
        self.assertEqual(status, 0, stderr)
        self.assertFalse(self.library.is_symlink())
        self.assertFalse((self.library / "hd.png").is_symlink())
        self.assertEqual((self.library / "hd.png").read_bytes(), (self.out / "urban/hd.png").read_bytes())
        self.assertTrue((self.library / "remap.png").is_symlink())
        self.assert_base_unchanged()
        installed = (self.library / "hd.png").read_bytes()
        status, _, stderr = self.run_cli("--install", str(self.farm))
        self.assertEqual(status, 1)
        self.assertIn("already produced by door_interior", stderr)
        self.assertIn("--force", stderr)
        self.assertEqual((self.library / "hd.png").read_bytes(), installed)
        status, _, stderr = self.run_cli("--install", str(self.farm), "--force")
        self.assertEqual(status, 0, stderr)
        self.assert_base_unchanged()

    def test_dry_run_never_installs_even_with_install_option(self):
        with mock.patch.object(door.cache_farm, "install_file") as install:
            status, _, stderr = self.run_cli("--install", str(self.farm), "--dry-run")
        self.assertEqual(status, 0, stderr)
        install.assert_not_called()
        self.assertTrue(self.library.is_symlink())
        self.assert_base_unchanged()

    def test_selects_damaged_roof_frames_page_defaults_and_aliases_but_never_shadows(self):
        self.meta["types"]["NAWEAP"]["building"]["layers"].append({
            "key": "UnderRoofDoorAnim", "sprite": "anim:roof", "damagedSprite": "anim:damaged"})
        for name in ("anim:roof", "anim:damaged"):
            self.meta["sprites"][name] = {"palette": "unit", "frames": [
                {"rect": list(self.rect), "page": 0, "offset": [0, 0]}], "shadows": []}
        self.meta["types"]["NAWEAP"]["building"]["layers"].append({"key": "IdleAnim", "sprite": "anim:ignored"})
        selected = door.select_frames(self.meta, set(door.DEFAULT_KEYS.split(",")), None)
        self.assertEqual({frame["sprite"] for frame in selected[0]}, {"anim:NAWEAP_1", "anim:roof", "anim:damaged"})
        self.write_library()
        with mock.patch.object(door, "darken_frame", wraps=door.darken_frame) as grade:
            status, _, stderr = self.run_cli()
        self.assertEqual(status, 0, stderr)
        self.assertEqual(grade.call_count, 1, "aliased rects must not be darkened twice")
        selected = door.select_frames(self.meta, {"UnderRoofDoorAnim"}, {"anim:damaged"})
        self.assertEqual([frame["sprite"] for frame in selected[0]], ["anim:damaged"])
        with self.assertRaisesRegex(ValueError, "not referenced"):
            door.select_frames(self.meta, {"UnderDoorAnim"}, {"anim:roof"})

    def test_mask_normalised_blur_excludes_transparent_colours(self):
        values = np.full((9, 9), 99, np.float32)
        coverage = np.zeros((9, 9), np.float32)
        coverage[3:6, 3:6] = 1
        values[3:6, 3:6] = 0.04
        blurred = door.masked_blur(values, coverage, 3)
        np.testing.assert_allclose(blurred, 0.04, atol=1e-6)

    def test_accepts_existing_rgb_palette_pngs(self):
        Image.fromarray(self.palette[None, ..., :3]).save(self.base / "palette.png")
        status, _, stderr = self.run_cli("--dry-run")
        self.assertEqual(status, 0, stderr)
        measured = json.loads((self.out / "urban/metrics.json").read_text())["frames"][0]
        self.assertLess(abs(measured["hd_after_mean_srgb_luma"] - measured["original_mean_srgb_luma"]), 0.05)

    def test_darker_hd_has_no_luminance_increase_and_empty_masks_are_valid(self):
        indices = np.full((12, 12), 4, np.uint8)
        palette = self.palette.copy()
        palette[4, :3] = 30
        hd = np.full((24, 24, 4), (5, 5, 5, 255), np.uint8)
        after, _, _, measured = door.darken_frame(indices, palette, hd, 2)
        np.testing.assert_array_equal(after, hd)
        self.assertEqual(measured["hd_before_mean_srgb_luma"], measured["hd_after_mean_srgb_luma"])
        indices.fill(15)
        after, mask, _, measured = door.darken_frame(indices, palette, hd, 2)
        np.testing.assert_array_equal(after, hd)
        self.assertFalse(mask.any())
        self.assertIsNone(measured["hd_after_mean_srgb_luma"])

    def test_refuses_output_symlinks_and_writing_inside_source_library(self):
        self.out.mkdir()
        (self.out / "urban").symlink_to(self.base)
        status, _, stderr = self.run_cli()
        self.assertEqual(status, 1)
        self.assertIn("symlink", stderr)
        self.assert_base_unchanged()
        self.out = self.base / "review"
        status, _, stderr = self.run_cli()
        self.assertEqual(status, 1)
        self.assertIn("outside every source library", stderr)
        self.assert_base_unchanged()


if __name__ == "__main__":
    unittest.main()
