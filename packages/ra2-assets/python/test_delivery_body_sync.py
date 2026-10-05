"""Asset-free tests for syncing HD delivery images with the HD building body."""

import contextlib
import io
import json
from pathlib import Path
import tempfile
import unittest

import numpy as np
from PIL import Image

import delivery_body_sync as sync


class CopyMaskTests(unittest.TestCase):
    def setUp(self):
        rng = np.random.default_rng(7)
        self.body = rng.integers(16, 200, (40, 48), dtype=np.uint8)
        self.part = self.body.copy()

    def test_dither_noise_is_the_same_surface_and_a_dense_block_is_kept(self):
        rng = np.random.default_rng(3)
        noise = rng.random(self.part.shape) < 0.3
        self.part[noise] = 255  # never equals a body index
        self.part[10:22, 30:44] = 254  # an opened door: every pixel differs
        mask = sync.copy_mask(self.part, self.body)
        self.assertFalse(mask[10:22, 30:44].any())
        # The kept rim is bounded: two indexed pixels around the block and nothing else.
        kept = ~mask
        self.assertFalse(kept[:7].any())
        self.assertFalse(kept[:, :27].any())
        self.assertTrue(mask[noise & ~kept].all())

    def test_small_specks_and_thin_lines_do_not_split_the_picture(self):
        self.part[5:8, 5:8] = 255  # nine pixels: below the structure size
        self.part[20, 2:40] = 255  # a one-pixel line has no dense 3x3 core
        self.assertTrue(sync.copy_mask(self.part, self.body).all())

    def test_pixels_the_body_lacks_keep_the_delivery_art_with_a_rim(self):
        body = self.body.copy()
        body[:, 40:] = 0
        mask = sync.copy_mask(self.part, body)
        self.assertFalse(mask[:, 39:].any())
        self.assertTrue(mask[:, :39].all())

    def test_transparent_part_pixels_are_never_copied(self):
        self.part[0:5] = 0
        self.assertFalse(sync.copy_mask(self.part, self.body)[0:5].any())

    def test_shared_silhouette_rim_is_taken_but_not_next_to_kept_art(self):
        part = np.zeros((12, 12), np.uint8)
        body = np.zeros((12, 12), np.uint8)
        part[3:9, 3:9] = body[3:9, 3:9] = 9
        mask = sync.copy_mask(part, body)
        take = sync.take_mask(part, body, mask)
        self.assertTrue(take[2:10, 2:10].all())
        self.assertFalse(take[0].any())
        body[3:9, 8] = 0  # the body ends one column earlier: that column and its rim stay the part's own
        mask = sync.copy_mask(part, body)
        take = sync.take_mask(part, body, mask)
        self.assertFalse(take[3:9, 7:11].any())


class AlignmentTests(unittest.TestCase):
    def test_draw_point_offsets_align_frames_of_different_rects(self):
        body = np.arange(30, dtype=np.uint8).reshape(5, 6) + 1
        # The part's top-left is two right and one down from the body's.
        aligned = sync.aligned_body(body, (-10, -4), (3, 8), (-8, -3))
        self.assertTrue(np.array_equal(aligned[:, :4], body[1:4, 2:6]))
        self.assertFalse(aligned[:, 4:].any())
        outside = sync.aligned_body(body, (0, 0), (2, 2), (40, 40))
        self.assertFalse(outside.any())


class LibrarySyncTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.base = self.root / "base"
        self.base.mkdir()
        self.farm = self.root / "farm"
        (self.farm / "_library").mkdir(parents=True)
        self.library = self.farm / "_library/urban"
        self.library.symlink_to(self.base, target_is_directory=True)
        self.out = self.root / "out"

        rng = np.random.default_rng(11)
        indexed = np.zeros((80, 160), np.uint8)
        body = rng.integers(16, 200, (40, 48), dtype=np.uint8)
        self.body_rect = (4, 6, 48, 40)
        self.part_rect = (70, 10, 40, 30)
        self.other_rect = (120, 10, 20, 20)
        indexed[6:46, 4:52] = body
        # The delivery frame repeats a body region (draw-point offsets differ by 6,2) with an opened door block.
        part = body[2:32, 6:46].copy()
        part[12:24, 22:36] = 250
        indexed[10:40, 70:110] = part
        indexed[10:30, 120:140] = 251  # unrelated interior: shares almost nothing with the body
        Image.fromarray(indexed).save(self.base / "indexed.png")

        hd = np.zeros((160, 320, 4), np.uint8)
        hd[12:92, 8:104] = (200, 40, 40, 255)  # body picture
        hd[20:80, 140:220] = (40, 40, 200, 255)  # delivery picture, redrawn independently
        hd[20:60, 240:280] = (10, 200, 10, 255)
        Image.fromarray(hd).save(self.base / "hd.png")
        remap = np.zeros((160, 320), np.uint8)
        remap[12:92, 8:104] = 180
        remap[20:80, 140:220] = 20
        Image.fromarray(remap).save(self.base / "remap.png")
        normals = np.zeros((80, 160, 4), np.uint8)
        normals[6:46, 4:52] = (128, 128, 255, 255)
        normals[10:40, 70:110] = (255, 128, 128, 255)
        Image.fromarray(normals).save(self.base / "normals.png")
        self.hd, self.remap, self.normals = hd, remap, normals

        frame = lambda rect, offset: {"rect": list(rect), "offset": list(offset)}
        library = {
            "theater": "urban",
            "spriteAtlases": [{"file": "indexed.png", "width": 160, "height": 80}],
            "spriteAtlasesHd": [{"file": "hd.png", "remap": "remap.png", "scale": 2, "width": 320, "height": 160}],
            "sprites": {
                "building:FACT": {"palette": "unit", "frames": [frame(self.body_rect, (-20, -10))]},
                "anim:FACT_2": {"palette": "unit", "frames": [frame(self.part_rect, (-14, -8))]},
                "anim:FACT_1": {"palette": "unit", "frames": [frame(self.other_rect, (-10, -6))]},
                "anim:FACT_A": {"palette": "unit", "frames": [frame(self.other_rect, (-10, -6))]},
            },
            "types": {
                "FACT": {"kind": "building", "sprite": "building:FACT", "building": {"layers": [
                    {"key": "ActiveAnim", "sprite": "anim:FACT_A"},
                    {"key": "DeployingAnim", "sprite": "anim:FACT_2"},
                    {"key": "UnderDoorAnim", "sprite": "anim:FACT_1"},
                ]}},
                "TANK": {"kind": "vehicle", "sprite": "building:FACT"},
            },
        }
        (self.base / "library.json").write_text(json.dumps(library), encoding="utf-8")
        (self.base / "normals.json").write_text(json.dumps({"version": 1, "pages": {"0": {
            "file": "normals.png", "atlas": "hd.png", "width": 320, "height": 160, "scale": 2,
            "materialWidth": 160, "materialHeight": 80}}}), encoding="utf-8")
        self.base_bytes = {name: (self.base / name).read_bytes() for name in ("hd.png", "remap.png", "normals.png")}

    def run_tool(self, *extra):
        stdout, stderr = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            code = sync.main(["--library", str(self.library), "--out", str(self.out), *extra])
        return code, stdout.getvalue(), stderr.getvalue()

    def test_install_copies_body_pixels_and_keeps_the_door_without_touching_the_base(self):
        code, stdout, stderr = self.run_tool("--install", str(self.farm))
        self.assertEqual(code, 0, stderr)
        self.assertIn("1/2 frames synced, 3 pages written, 3 installed", stdout)
        for name, data in self.base_bytes.items():
            self.assertEqual((self.base / name).read_bytes(), data)
            self.assertFalse((self.library / name).is_symlink())
        self.assertTrue((self.library / "library.json").is_symlink())

        hd = np.array(Image.open(self.library / "hd.png"))
        px, py = self.part_rect[0] * 2, self.part_rect[1] * 2
        part = hd[py:py + 60, px:px + 80]
        self.assertTrue((part[:16] == (200, 40, 40, 255)).all())  # copied region is the body picture exactly
        self.assertTrue((part[28:44, 48:68] == (40, 40, 200, 255)).all())  # door core keeps its art
        # Between them every texel is one of the two pictures or their feathered mix; nothing else appears.
        seam = part[16:28, :, :3].astype(int)
        self.assertTrue((seam[..., 1] == 40).all())
        self.assertTrue((seam[..., 0] + seam[..., 2] == 240).all())
        # Body, unrelated interior and attached animation frames are untouched.
        self.assertTrue(np.array_equal(hd[12:92, 8:104], self.hd[12:92, 8:104]))
        self.assertTrue(np.array_equal(hd[20:60, 240:280], self.hd[20:60, 240:280]))

        remap = np.array(Image.open(self.library / "remap.png"))
        self.assertTrue((remap[py:py + 16, px:px + 80] == 180).all())
        self.assertTrue((remap[py + 28:py + 44, px + 48:px + 68] == 20).all())
        normals = np.array(Image.open(self.library / "normals.png"))
        nx, ny = self.part_rect[0], self.part_rect[1]
        self.assertTrue((normals[ny:ny + 8, nx:nx + 40] == (128, 128, 255, 255)).all())
        self.assertTrue((normals[ny + 14:ny + 22, nx + 24:nx + 34] == (255, 128, 128, 255)).all())

        metrics = json.loads((self.out / "urban/metrics.json").read_text())
        applied = {(f["sprite"], f["applied"]) for f in metrics["frames"]}
        self.assertEqual(applied, {("anim:FACT_2", True), ("anim:FACT_1", False)})
        self.assertEqual(len(metrics["installed"]), 3)
        with Image.open(self.library / "hd.png") as image:
            self.assertIn(sync.MARKER, image.text)
        self.assertTrue((self.out / "urban/delivery_body_sync.jpg").exists())

    def test_second_run_changes_nothing_in_the_copied_region(self):
        self.assertEqual(self.run_tool("--install", str(self.farm))[0], 0)
        first = np.array(Image.open(self.library / "hd.png"))
        self.assertEqual(self.run_tool("--install", str(self.farm))[0], 0)
        second = np.array(Image.open(self.library / "hd.png"))
        px, py = self.part_rect[0] * 2, self.part_rect[1] * 2
        self.assertTrue(np.array_equal(first[py:py + 16, px:px + 80], second[py:py + 16, px:px + 80]))

    def test_dry_run_and_type_filter_do_not_install(self):
        code, stdout, _ = self.run_tool("--install", str(self.farm), "--dry-run")
        self.assertEqual(code, 0)
        self.assertIn("0 installed", stdout)
        self.assertTrue(self.library.is_symlink())
        code, stdout, _ = self.run_tool("--install", str(self.farm), "--types", "NOPE")
        self.assertEqual(code, 0)
        self.assertIn("0/0 frames synced, 0 pages written", stdout)
        self.assertTrue(self.library.is_symlink())

    def test_refuses_output_inside_a_library_and_libraries_outside_the_farm(self):
        stdout, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(err):
            inside = sync.main(["--library", str(self.base), "--out", str(self.base / "review")])
            outside = sync.main(["--library", str(self.base), "--out", str(self.out), "--install", str(self.farm)])
        self.assertEqual((inside, outside), (1, 1))
        self.assertIn("outside every source library", err.getvalue())
        self.assertIn("lexically inside --install", err.getvalue())

    def test_mismatched_palettes_are_not_paired(self):
        library = json.loads((self.base / "library.json").read_text())
        library["sprites"]["anim:FACT_2"]["palette"] = "iso"
        (self.base / "library.json").write_text(json.dumps(library), encoding="utf-8")
        code, stdout, _ = self.run_tool("--install", str(self.farm))
        self.assertEqual(code, 0)
        self.assertIn("0/1 frames synced, 0 pages written", stdout)


if __name__ == "__main__":
    unittest.main()
