"""Asset-free infantry pipeline regressions: python3 -B -m unittest test_infantry_sheets -v."""

from collections import Counter
import contextlib
import copy
import io
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest import mock

import numpy as np
from PIL import Image

import infantry_sheets as inf


SPRITE = "infantry:GI"
PAGE = 21


def synthetic_library(root, shadows=False, tint=0):
    """A small indexed atlas with varied anchors, house paint, an HD rim and an unrelated sprite."""
    root.mkdir(parents=True)
    width, height = 18, 22
    indices = np.zeros((8 * 26, 8 * 22), np.uint8)
    palette = np.full((256, 3), 118, np.uint8)
    palette[40], palette[41], palette[42] = (176 + tint, 146, 91), (63, 69, 48), (170, 122, 89)
    palette[12] = 0
    ramp = np.array([[45 - i * 2, 100 - i * 5, 220 - i * 12] for i in range(16)], np.uint8)
    palette[16:32] = ramp
    frames = []
    for i in range(64):
        x, y = i % 8 * 22 + 2, i // 8 * 26 + 2
        idx = indices[y:y + height, x:x + width]
        idx[3:7, 6:12] = 42
        idx[7:15, 5:13] = 40
        idx[8:11, 3:15] = 41
        idx[9:13, 6:12] = 20 + i % 5
        idx[15:19, 5:8] = 41
        idx[15:19, 10:13] = 41
        if shadows:
            idx[19:21, 4:15] = 12
        frames.append({"rect": [x, y, width, height], "offset": [-8 + i % 3, -18 + i % 2], "page": PAGE})
    rgba = np.zeros((*[n * 2 for n in indices.shape], 4), np.uint8)
    rgba[..., :3] = np.repeat(np.repeat(palette[indices], 2, axis=0), 2, axis=1)
    rgba[..., 3] = np.repeat(np.repeat((indices > 0).astype(np.uint8) * 255, 2, axis=0), 2, axis=1)
    paint1 = (indices >= 16) & (indices <= 31)
    paint = np.repeat(np.repeat(paint1.astype(np.uint8) * 255, 2, axis=0), 2, axis=1)
    grey = np.repeat(np.repeat(255 - 15 * (indices.astype(np.int32) - 16), 2, axis=0), 2, axis=1)
    rgba[..., :3][paint > 0] = grey[paint > 0, None]
    for frame in frames:
        x, y, _, _ = frame["rect"]
        # This HD antialiased rim lies outside indexed body coverage and must keep its alpha.
        rgba[2 * y + 5, 2 * x + 13] = (170, 122, 89, 73)
        rgba[2 * y + 6, 2 * x + 13, 3] = 187
    Image.fromarray(indices).save(root / "indexed-custom.png")
    Image.fromarray(rgba).save(root / "colour-custom.png")
    Image.fromarray(paint).save(root / "paint-custom.png")
    Image.fromarray(palette[None]).save(root / "palette-custom.png")
    # Nonstandard filenames catch hardcoded sprites-{page} lookups. Other page metadata must survive installation.
    data = {
        "version": 1, "theater": "SYNTHETIC", "palettes": {"unit": "palette-custom.png"},
        "spriteAtlases": [{"file": "indexed-custom.png", "width": indices.shape[1], "height": indices.shape[0]}
                          for _ in range(PAGE + 1)],
        "spriteAtlasesHd": [{"file": "colour-custom.png", "remap": "paint-custom.png", "scale": 2,
                             "width": rgba.shape[1], "height": rgba.shape[0], "provenance": "synthetic"}
                            for _ in range(PAGE + 1)],
        "sprites": {SPRITE: {"palette": "unit", "frames": frames},
                    "infantry:UNTOUCHED": {"palette": "unit", "frames": [
                        {"rect": [0, 0, 2, 2], "offset": [0, 0], "page": PAGE}]}},
        "types": {"E1": {"sprite": SPRITE, "infantry": {"sequences": {
            "Ready": {"start": 0, "count": 1, "facingMultiplier": 1},
            "Walk": {"start": 8, "count": 3, "facingMultiplier": 3},
            "FireUp": {"start": 32, "count": 2, "facingMultiplier": 2},
            "Die1": {"start": 48, "count": 2, "facingMultiplier": 2}}}}},
        "colorSchemes": [{"remap": ramp.tolist()}], "colorSchemesByName": {"DarkBlue": 0},
        "unrelated": {"keep": [0, "test", False]},
    }
    (root / "library.json").write_text(json.dumps(data), encoding="utf-8")
    (root / "metadata.txt").write_text("unchanged", encoding="utf-8")
    return data


def options(**updates):
    return SimpleNamespace(**(inf.COMPOSE_DEFAULTS | updates))


def read_image(path, mode=None):
    with Image.open(path) as im:
        return np.array(im.convert(mode) if mode else im)


class LibraryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix=".tmp-infantry-", dir=Path(__file__).parent)
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.data = synthetic_library(self.root / "library")
        self.lib = inf.library(self.root / "library")

    def test_cache_and_manifest_paths_are_per_library(self):
        other = self.root / "second"
        synthetic_library(other, tint=30)
        second = inf.library(other)
        self.assertIs(self.lib, inf.library(self.root / "library" / "."))
        self.assertIs(self.lib.page2(PAGE), self.lib.page2(PAGE))
        self.assertIsNot(self.lib.page2(PAGE), second.page2(PAGE))
        self.assertFalse(np.array_equal(self.lib.page2(PAGE), second.page2(PAGE)))
        _, _, painted, idx = self.lib.frame1(SPRITE, 0, "DarkBlue")
        decoded, _, mask = self.lib.frame2(SPRITE, 0, "DarkBlue")
        expected = np.repeat(np.repeat(self.lib.scheme("DarkBlue")[np.clip(idx - 16, 0, 15)], 2, 0), 2, 1)
        np.testing.assert_array_equal(decoded[mask == 255], expected[mask == 255])
        self.assertTrue(painted.any())

    def assert_coverage(self):
        expected = Counter(range(len(self.lib.frames(SPRITE))))
        self.assertEqual(Counter(i for _, rows in inf.blocks(self.lib, "E1") for row in rows for i in row), expected)
        specs = inf.sheet_specs(self.lib, "E1")
        self.assertEqual(Counter(i for _, _, rows in specs for row in rows for i in row), expected)
        self.assertEqual(len({name for name, _, _ in specs}), len(specs))
        return specs

    def test_blocks_and_sheet_specs_cover_each_frame_once(self):
        specs = self.assert_coverage()
        walk_a = next(rows for name, _, rows in specs if name == "E1_Walk_a")
        self.assertEqual(walk_a[0], [0, 8, 9, 10])
        seqs = self.lib.data["types"]["E1"]["infantry"]["sequences"]
        seqs["WalkAlias"] = dict(seqs["Walk"])
        # A partial overlap, a negative index and out-of-range frames must not duplicate/wrap atlas reads.
        seqs["Overlap"] = {"start": 25, "count": 10, "facingMultiplier": 0}
        seqs["InvalidEdges"] = {"start": -2, "count": 4, "facingMultiplier": 9}
        self.assert_coverage()
        del seqs["Die1"]
        self.assert_coverage()  # uncovered body frames become Extra runs

    def test_layout_and_native_canvas_contain_every_frame(self):
        orientations = set()
        specs = inf.sheet_specs(self.lib, "E1")
        for _, _, rows in specs + [("wide", "Misc", [list(range(8))])]:
            lay = inf.layout(self.lib, SPRITE, rows)
            scale = inf.choose_scale(lay["W"], lay["H"])
            cw, ch, ox, oy = inf.canvas_for(lay, scale)
            orientations.add((cw, ch))
            self.assertIn((cw, ch), ((1536, 1024), (1024, 1536)))
            anchors = {}
            for p in lay["place"]:
                x, y = ox + round(p["x"] * scale), oy + round(p["y"] * scale)
                self.assertGreaterEqual(min(x, y), 0)
                self.assertLessEqual(x + round(p["w"] * scale), cw)
                self.assertLessEqual(y + round(p["h"] * scale), ch)
                fx, fy = self.lib.frames(SPRITE)[p["frame"]]["offset"]
                cx, cy, _, _ = p["cell"]
                anchor = p["x"] - cx - fx, p["y"] - cy - fy
                self.assertEqual(anchor, anchors.setdefault(p["row"], anchor))
        self.assertEqual(orientations, {(1536, 1024), (1024, 1536)})
        with self.assertRaises(ValueError):
            inf.choose_scale(2000, 2000)
        with self.assertRaises(ValueError):
            inf.canvas_for({"W": 1000, "H": 1000}, 2)

    def test_long_death_animation_wraps_and_keeps_reading_order(self):
        self.lib.data["types"]["E1"]["infantry"]["sequences"]["Die1"] = {
            "start": 48, "count": 16, "facingMultiplier": 0}
        rows = next(rows for name, _, rows in self.assert_coverage() if name == "E1_Die1")
        self.assertEqual(list(map(len, rows)), [5, 5, 5, 1])
        self.assertEqual([i for row in rows for i in row], list(range(48, 64)))

    def test_default_shadow_softening_preserves_the_hd_body_rim(self):
        root = self.root / "shadows"
        synthetic_library(root, shadows=True)
        lib = inf.library(root)
        inf.make_job(lib, "E1", "shadow", "Walk", [[0]], self.root / "sheets")
        d = self.root / "sheets/shadow"
        shutil.copyfile(d / "input.png", d / "full.png")
        result = inf.compose_job(lib, d, options())["frames"][0]
        _, _, _, idx = lib.frame1(SPRITE, 0, "DarkBlue")
        _, alpha, _ = lib.frame2(SPRITE, 0, "DarkBlue")
        shadow = np.repeat(np.repeat(idx == 12, 2, 0), 2, 1)
        body = np.repeat(np.repeat((idx > 0) & (idx != 12), 2, 0), 2, 1) & (alpha > 0)
        rim = ~body & ~shadow & (alpha > 0)
        self.assertTrue(rim.any())
        np.testing.assert_array_equal(result["rgba"][..., 3][rim], alpha[rim])
        self.assertLess(result["rgba"][..., 3][shadow].max(), alpha[shadow].max())
        self.assertTrue(np.any(result["rgba"][..., 3][~body & ~shadow & (alpha == 0)] > 0))


    def test_value_paint_keeps_shading_above_the_ramp_luminance(self):
        # A red ramp like DarkRed: its brightest entry is darker (luminance) than a lit red the model draws.
        ramp = np.array([[255 - 14 * i, 25 - i, 25 - i] for i in range(16)], np.float32)
        reds = np.array([[[250, 90, 80], [230, 40, 35], [160, 20, 20], [70, 8, 8]]], np.float32)
        lum_k = (255 - inf.rd.neutral_to_grey(reds, ramp)[0, :, 0]) / 15
        val_k = (255 - inf.value_to_grey(reds, ramp)[0, :, 0]) / 15
        self.assertEqual(lum_k[0], lum_k[1])  # luminance clamps the highlight and the lit red together
        self.assertTrue(np.all(np.diff(val_k) > 0))  # value keeps them apart, darker texels higher up the ramp
        self.assertLess(val_k[0], 1.0)
        self.assertGreater(val_k[3], 12.0)

    def test_shaded_paint_leaves_skin_next_to_red_paint_unpainted(self):
        ramp = np.array([[255 - 14 * i, 25 - i, 25 - i] for i in range(16)], np.float32)
        final = np.full((8, 8, 3), 118, np.float32)
        final[2:6, 1:4] = (220, 35, 30)  # house red
        final[2:6, 4:7] = (105, 65, 58)  # shaded skin / leather: the median texel the old window painted
        body = np.zeros((8, 8), bool)
        body[1:7, 1:7] = True
        pw0 = np.zeros((8, 8), np.float32)
        pw0[2:6, 1:5] = 1  # the blocky original mask reaches into the face
        old, _ = inf.model_paint(final, pw0, body, ramp)
        new, enc = inf.model_paint_shaded(final, pw0, body, ramp)
        self.assertGreater(old[3:5, 5].min(), 0.8)
        self.assertLess(new[3:5, 5].max(), 0.2)
        self.assertGreater(new[3:5, 2].min(), 0.9)
        np.testing.assert_allclose(enc[3, 2], enc[3, 2, 0], atol=1.0)  # painted texels are encoded grey

    def test_sharpen_keeps_the_silhouette_rim(self):
        rng = np.random.default_rng(3)
        final = rng.uniform(40, 200, (12, 12, 3)).astype(np.float32)
        body = np.zeros((12, 12), bool)
        body[2:10, 2:10] = True
        out = inf.sharpen_interior(final, body, 0.6, 0.8)
        rim = inf.rd.erode_distance(body, 1) == 1
        np.testing.assert_array_equal(out[rim], final[rim])
        np.testing.assert_array_equal(out[~body], final[~body])
        self.assertGreater(np.abs(out - final)[3:9, 3:9].mean(), 1.0)
        np.testing.assert_array_equal(inf.sharpen_interior(final, body, 0.0, 0.8), final)
    def test_build_routes_a_multi_page_sprite_to_the_requested_page(self):
        self.lib.frames(SPRITE)[0]["page"] = 0
        inf.make_job(self.lib, "E1", "mixed", "Walk", [[0, 1]], self.root / "sheets")
        d = self.root / "sheets/mixed"
        shutil.copyfile(d / "input.png", d / "full.png")
        with contextlib.redirect_stdout(io.StringIO()):
            color, _, report = inf.build(self.lib, self.root, PAGE, options())
        self.assertEqual(set(report["frames"]), {f"{SPRITE}#0", f"{SPRITE}#1"})
        self.assertEqual(report["frames"][f"{SPRITE}#0"]["skipped"], "other-page")
        self.assertFalse(report["frames"][f"{SPRITE}#0"]["accepted"])
        self.assertTrue(report["frames"][f"{SPRITE}#1"]["accepted"])
        x, y, w, h = self.lib.frames(SPRITE)[0]["rect"]
        crop = np.s_[2 * y:2 * (y + h), 2 * x:2 * (x + w)]
        np.testing.assert_array_equal(color[crop], self.lib.page2(PAGE)[crop])


class PipelineTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory(prefix=".tmp-infantry-pipeline-", dir=Path(__file__).parent)
        cls.addClassCleanup(cls.temp.cleanup)
        cls.root = Path(cls.temp.name)
        cls.library_dir = cls.root / "library"
        cls.data = synthetic_library(cls.library_dir)
        cls.lib = inf.library(cls.library_dir)
        cls.work = cls.root / "work"
        with contextlib.redirect_stdout(io.StringIO()):
            inf.main(["prepare", "--library", str(cls.library_dir), "--work", str(cls.work), "--units", "E1"])
        cls.name = "E1_Walk_a"
        cls.d = cls.work / "sheets" / cls.name
        shutil.copyfile(cls.d / "input.png", cls.d / "full.png")

    def test_prepare_prompts_and_identity_compose(self):
        for d in (self.work / "sheets").iterdir():
            self.assertTrue((d / "input.png").is_file())
            self.assertTrue((d / "job.json").is_file())
            prompt = (d / "prompt.txt").read_text()
            self.assertIn("flat uniform grey (118,118,118)", prompt)
            self.assertIn("full.png", prompt)
        self.assertIn(inf.FACING_TEXT[0], (self.d / "prompt.txt").read_text())
        self.assertIn(inf.FACING_TEXT[4], (self.work / "sheets/E1_Walk_b/prompt.txt").read_text())
        # Exercise the public compose command and inspect its actual frame results without stubbing image maths.
        results = []
        compose_job = inf.compose_job

        def capture(*args, **kwargs):
            result = compose_job(*args, **kwargs)
            results.append(result)
            return result

        with mock.patch.object(inf, "compose_job", side_effect=capture), contextlib.redirect_stdout(io.StringIO()):
            code = inf.main(["compose", "--library", str(self.library_dir), "--work", str(self.work),
                             "--names", self.name])
        self.assertEqual(code, 0)
        result = results[0]
        metrics = json.loads((self.d / "metrics.json").read_text())
        self.assertEqual(len(metrics), 16)
        self.assertGreater(read_image(self.d / "review.png").size, 0)
        for i, frame in result["frames"].items():
            with self.subTest(frame=i):
                _, _, _, idx = self.lib.frame1(SPRITE, i, "DarkBlue")
                _, alpha, _ = self.lib.frame2(SPRITE, i, "DarkBlue")
                body = np.repeat(np.repeat((idx > 0) & (idx != 12), 2, 0), 2, 1) & (alpha > 0)
                np.testing.assert_array_equal(frame["rgba"][..., 3][~body], alpha[~body])
                self.assertTrue(np.all(frame["rgba"][..., 3][body] <= alpha[body]))
                inner = inf.rd.erode_distance(body, 3) > 3
                np.testing.assert_array_equal(frame["rgba"][..., 3][inner], alpha[inner])
                self.assertGreater(frame["metrics"]["sil_iou"], 0.9)
                self.assertGreater(inf.iou(frame["rgba"][..., 3] > 127, alpha > 127), 0.9)
                self.assertTrue(np.any(frame["paint"] > 0))

    def test_build_changes_only_processed_rects_and_merges_existing_variant(self):
        variant = self.root / "variant"
        variant.mkdir()
        merge_base = copy.deepcopy(self.data)
        merge_base["spriteAtlasesHd"][0]["file"] = "earlier-track.png"
        merge_base["spriteAtlasesHd"][PAGE]["extra"] = "preserve page metadata"
        merge_base["anotherTrack"] = {"preserve": True}
        (variant / "library.json").write_text(json.dumps(merge_base))
        source_manifest = (self.library_dir / "library.json").read_bytes()
        with contextlib.redirect_stdout(io.StringIO()):
            code = inf.main(["build", "--library", str(self.library_dir), "--work", str(self.work),
                             "--page", str(PAGE), "--variant-dir", str(variant),
                             "--rim-soften", "0.5", "--paint-saturation", "0.82"])
        self.assertEqual(code, 0)
        report = json.loads((self.work / "pages/report.json").read_text())
        self.assertEqual(report["sheets"]["E1_Walk_b"], "missing")
        self.assertEqual(len(report["frames"]), 16)
        self.assertTrue(all(m["accepted"] for m in report["frames"].values()))
        touched = np.zeros(self.lib.page2(PAGE).shape[:2], bool)
        for key in report["frames"]:
            i = int(key.rsplit("#", 1)[1])
            x, y, w, h = self.lib.frames(SPRITE)[i]["rect"]
            touched[2 * y:2 * (y + h), 2 * x:2 * (x + w)] = True
        for filename, base in ((f"sprites-{PAGE}@2x-l3inf.png", self.lib.page2(PAGE)),
                               (f"sprites-{PAGE}@2x-remap-l3inf.png", self.lib.remap2(PAGE))):
            actual = read_image(variant / filename)
            np.testing.assert_array_equal(actual[~touched], base[~touched])
            self.assertTrue(np.any(actual[touched] != base[touched]))
            np.testing.assert_array_equal(actual, read_image(self.work / "pages" / filename))
            self.assertFalse((variant / filename).is_symlink())
        expected = copy.deepcopy(merge_base)
        expected["spriteAtlasesHd"][PAGE].update(file=f"sprites-{PAGE}@2x-l3inf.png",
                                                 remap=f"sprites-{PAGE}@2x-remap-l3inf.png", paintSaturation=0.82)
        self.assertEqual(json.loads((variant / "library.json").read_text()), expected)
        self.assertEqual((self.library_dir / "library.json").read_bytes(), source_manifest)
        for source in self.library_dir.iterdir():
            if source.name != "library.json":
                self.assertTrue((variant / source.name).is_symlink())
                self.assertEqual((variant / source.name).resolve(), source.resolve())
        note = json.loads((variant / "library.l3-infantry.json").read_text())
        self.assertEqual(note["sprites"], [SPRITE])
        self.assertEqual(note["page"], PAGE)
        self.assertEqual(note["spriteAtlasesHd"][str(PAGE)]["paintSaturation"], 0.82)
        self.assertEqual(report["options"]["paint_saturation"], 0.82)
        self.assertEqual(report["options"]["rim_soften"], 0.5)

    def test_install_replaces_manifest_and_page_symlinks_without_writing_source(self):
        variant = self.root / "linked-variant"
        variant.mkdir()
        (variant / "library.json").symlink_to(self.library_dir / "library.json")
        (variant / "new.png").symlink_to(self.library_dir / "colour-custom.png")
        (variant / "new-remap.png").symlink_to(self.library_dir / "paint-custom.png")
        pages = self.root / "install-input"
        pages.mkdir()
        Image.fromarray(np.zeros_like(self.lib.page2(PAGE))).save(pages / "new.png")
        Image.fromarray(np.zeros_like(self.lib.remap2(PAGE))).save(pages / "new-remap.png")
        original = {p.name: p.read_bytes() for p in self.library_dir.iterdir()}
        inf.install(self.lib, variant, PAGE, pages / "new.png", pages / "new-remap.png", [SPRITE])
        self.assertFalse((variant / "library.json").is_symlink())
        for name, contents in original.items():
            self.assertEqual((self.library_dir / name).read_bytes(), contents)
        expected = copy.deepcopy(self.data)
        expected["spriteAtlasesHd"][PAGE].update(file="new.png", remap="new-remap.png")
        self.assertEqual(json.loads((variant / "library.json").read_text()), expected)

    def test_build_ignores_other_pages_and_rejects_low_silhouette(self):
        # Real composition above covers image maths; isolate page routing and the acceptance gate here.
        job = json.loads((self.d / "job.json").read_text())
        frames = {0: {"rgba": np.full((44, 36, 4), 7, np.uint8), "paint": np.zeros((44, 36), np.uint8),
                      "metrics": {"sil_iou": 0.5}}}
        with mock.patch.object(inf, "compose_job", return_value={"job": job, "frames": frames, "raw": "full.png"}), \
                contextlib.redirect_stdout(io.StringIO()):
            color, paint, report = inf.build(self.lib, self.work, PAGE, options(), names=[self.name])
        np.testing.assert_array_equal(color, self.lib.page2(PAGE))
        np.testing.assert_array_equal(paint, self.lib.remap2(PAGE))
        self.assertFalse(report["frames"][f"{SPRITE}#0"]["accepted"])
        result = inf.compose_job(self.lib, self.d, options(), page=0)
        self.assertEqual(result["frames"], {})
        self.assertEqual(set(result["skipped"].values()), {"other-page"})

    def test_build_softens_only_accepted_rects_and_rechecks_page_before_pasting(self):
        rgba = np.zeros((44, 36, 4), np.uint8)
        rgba[..., 3] = 255
        rgba[2:-2, 2:-2, :3] = 128
        paint = np.zeros(rgba.shape[:2], np.uint8)
        frames = {i: {"rgba": rgba, "paint": paint, "metrics": {"sil_iou": i * 0.4 + 0.5}}
                  for i in range(3)}
        job = {"sprite": SPRITE}
        other_frame = self.lib.frames(SPRITE)[2]
        original_page = other_frame["page"]
        other_frame["page"] = PAGE - 1
        try:
            with mock.patch.object(inf, "compose_job", return_value={"job": job, "frames": frames, "raw": "full.png"}), \
                    contextlib.redirect_stdout(io.StringIO()):
                color, remap, report = inf.build(self.lib, self.work, PAGE, options(rim_soften=0.5), names=[self.name])
        finally:
            other_frame["page"] = original_page
        x, y, w, h = self.lib.frames(SPRITE)[1]["rect"]
        touched = np.zeros(color.shape[:2], bool)
        touched[2 * y:2 * (y + h), 2 * x:2 * (x + w)] = True
        np.testing.assert_array_equal(color[~touched], self.lib.page2(PAGE)[~touched])
        np.testing.assert_array_equal(remap[~touched], self.lib.remap2(PAGE)[~touched])
        np.testing.assert_array_equal(color[2 * y, 2 * x + 10], [92, 92, 92, 255])
        np.testing.assert_array_equal(color[..., 3][touched], rgba[..., 3].ravel())
        np.testing.assert_array_equal(remap[touched], paint.ravel())
        self.assertFalse(report["frames"][f"{SPRITE}#0"]["accepted"])
        self.assertTrue(report["frames"][f"{SPRITE}#1"]["accepted"])
        self.assertEqual(report["frames"][f"{SPRITE}#2"]["skipped"], "other-page")
        self.assertFalse(report["frames"][f"{SPRITE}#2"]["accepted"])


class RimTests(unittest.TestCase):
    def test_black_rim_moves_halfway_in_linear_light_and_preserves_paint_and_alpha(self):
        rgba = np.zeros((16, 16, 4), np.uint8)
        rgba[2:14, 2:14, 3] = 255
        rgba[4:12, 4:12, :3] = 128
        rgba[3, 8, 3] = 128
        rgba[1, 8] = [33, 44, 55, 127]
        rgba[3, 3, :3] = 195
        paint = np.zeros((16, 16), np.uint8)
        paint[3, 3] = 128
        paint[3, 8] = 127
        original = rgba.copy()
        out = inf.soften_rim(rgba, paint, 0.5)
        np.testing.assert_array_equal(out[3, 8], [92, 92, 92, 128])
        ratio = inf.rd.srgb_to_linear(out[3, 8, :3]) / inf.rd.srgb_to_linear(np.array([128] * 3))
        np.testing.assert_allclose(ratio, 0.5, atol=0.006)
        np.testing.assert_array_equal(out[paint >= 128], rgba[paint >= 128])
        np.testing.assert_array_equal(out[..., 3], rgba[..., 3])
        np.testing.assert_array_equal(out[rgba[..., 3] < 128], rgba[rgba[..., 3] < 128])
        np.testing.assert_array_equal(out[4:12, 4:12], rgba[4:12, 4:12])
        np.testing.assert_array_equal(rgba, original)
        self.assertEqual(paint[3, 3], 128)
        np.testing.assert_array_equal(inf.soften_rim(rgba, paint, 0), rgba)

    def test_frame_border_and_luminance_ratio_leave_bright_rims_unchanged(self):
        rgba = np.zeros((16, 16, 4), np.uint8)
        rgba[..., 3] = 255
        rgba[2:-2, 2:-2, :3] = 128
        rgba[1, 6, :3] = 64
        rgba[1, 11, :3] = 220
        out = inf.soften_rim(rgba, np.zeros((16, 16), np.uint8), 0.5)
        np.testing.assert_array_equal(out[0, 6, :3], [92] * 3)
        # 64 and 128 sRGB are approximately 0.0513 and 0.2159 in linear light.
        expected = inf.rd.linear_to_srgb(np.array([0.05126946 + (0.2158605 - 0.05126946)
                                                   * 0.5 * (1 - 0.05126946 / 0.2158605)] * 3))
        np.testing.assert_allclose(out[1, 6, :3], expected, atol=0.5)
        np.testing.assert_array_equal(out[1, 11], rgba[1, 11])

    def test_local_mean_uses_linear_light_and_diagonal_neighbours(self):
        rgba = np.zeros((12, 12, 4), np.uint8)
        rgba[..., 3] = 255
        rgba[2:4, 2:4, :3] = np.array([[0, 255], [255, 0]])[..., None]
        rgba[6:10, 6:10, :3] = 255  # beyond the corner's radius of three
        out = inf.soften_rim(rgba, np.zeros((12, 12), np.uint8), 0.5)
        # Four interior samples at the corner average to 0.5 linear, then black moves halfway: 0.25 -> 137 sRGB.
        np.testing.assert_array_equal(out[0, 0], [137, 137, 137, 255])

    def test_no_local_interior_and_zero_luminance_are_noops(self):
        rgba = np.zeros((20, 20, 4), np.uint8)
        rgba[1:4, 1:4, 3] = 255  # a thin island has no interior reference within three texels
        rgba[10:20, 10:20, 3] = 255  # interior exists here, but is black
        paint = np.zeros((20, 20), np.uint8)
        np.testing.assert_array_equal(inf.soften_rim(rgba, paint, 1), rgba)
        np.testing.assert_array_equal(inf.soften_rim(rgba[:4, :4], paint[:4, :4], 1), rgba[:4, :4])


class PolishTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix=".tmp-infantry-polish-", dir=Path(__file__).parent)
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = self.root / "source"
        self.data = synthetic_library(self.source)
        self.data["sprites"][SPRITE]["frames"] = [
            {"rect": [0, 0, 8, 8], "offset": [0, 0], "page": PAGE},
            {"rect": [8, 0, 8, 8], "offset": [0, 0], "page": PAGE - 1},
            {"rect": [0, 8, 8, 8], "offset": [0, 0], "page": PAGE},
        ]
        self.data["sprites"]["infantry:UNTOUCHED"]["frames"][0]["rect"] = [8, 8, 8, 8]
        (self.source / "library.json").write_text(json.dumps(self.data))
        self.variant = self.root / "variant"
        self.variant.mkdir()
        self.color = np.zeros((32, 32, 4), np.uint8)
        self.color[..., 3] = 255
        for y, x in ((0, 0), (0, 16), (16, 0), (16, 16)):
            self.color[y + 2:y + 14, x + 2:x + 14, :3] = 128
        self.paint = np.zeros((32, 32), np.uint8)
        self.color[1, 1, :3] = 195
        self.paint[1, 1] = 255
        Image.fromarray(self.color).save(self.variant / "variant-colour.png")
        Image.fromarray(self.paint).save(self.variant / "variant-paint.png")
        self.merged = copy.deepcopy(self.data)
        self.merged["spriteAtlasesHd"][PAGE].update(file="variant-colour.png", remap="variant-paint.png",
                                                   width=32, height=32, paintSaturation=0.9)
        self.merged["variantOnly"] = {"keep": [False, 0, "elsewhere"]}
        self.manifest = self.variant / "library.json"
        self.manifest.write_text(json.dumps(self.merged))

    def run_polish(self, *extra):
        with contextlib.redirect_stdout(io.StringIO()):
            code = inf.main(["polish", "--library", str(self.source), "--page", str(PAGE),
                             "--variant-dir", str(self.variant), "--sprites", SPRITE,
                             "--rim-soften", "0.5", "--paint-saturation", "0.82", *extra])
        self.assertEqual(code, 0)

    def assert_polished(self, suffix="l4inf"):
        expected = copy.deepcopy(self.merged)
        entry = expected["spriteAtlasesHd"][PAGE]
        entry.update(file=f"sprites-{PAGE}@2x-{suffix}.png", remap=f"sprites-{PAGE}@2x-remap-{suffix}.png",
                     paintSaturation=0.82)
        actual = json.loads(self.manifest.read_text())
        self.assertEqual(json.dumps(actual), json.dumps(expected))
        color = read_image(self.variant / entry["file"])
        paint = read_image(self.variant / entry["remap"])
        np.testing.assert_array_equal(color[:, 16:], self.color[:, 16:])  # other page's rect and unlisted sprite
        np.testing.assert_array_equal(color[0, 8], [92, 92, 92, 255])
        np.testing.assert_array_equal(color[16, 8], [92, 92, 92, 255])  # every selected page-P frame
        np.testing.assert_array_equal(color[..., 3], self.color[..., 3])
        np.testing.assert_array_equal(color[self.paint >= 128], self.color[self.paint >= 128])
        np.testing.assert_array_equal(paint, self.paint)
        return color

    def test_polish_reads_current_variant_and_only_changes_the_selected_page(self):
        original = {p: p.read_bytes() for p in self.source.iterdir()}
        self.run_polish("--suffix", "custom")
        self.assert_polished("custom")
        for path, contents in original.items():
            self.assertEqual(path.read_bytes(), contents)
        np.testing.assert_array_equal(read_image(self.variant / "variant-colour.png"), self.color)

    def test_polish_replaces_symlinked_manifest_and_output_pages_atomically(self):
        linked = self.root / "linked-manifest.json"
        self.manifest.rename(linked)
        self.manifest.symlink_to(linked)
        for name, target in ((f"sprites-{PAGE}@2x-l4inf.png", "variant-colour.png"),
                             (f"sprites-{PAGE}@2x-remap-l4inf.png", "variant-paint.png")):
            (self.variant / name).symlink_to(self.variant / target)
        original = linked.read_bytes()
        with mock.patch.object(inf.os, "replace", wraps=inf.os.replace) as replace:
            self.run_polish()
        self.assertFalse(self.manifest.is_symlink())
        self.assertEqual(linked.read_bytes(), original)
        self.assertEqual(replace.call_args_list[-1].args[1], self.manifest)
        self.assertEqual(len(replace.call_args_list), 3)
        for call in replace.call_args_list:
            self.assertEqual(call.args[0].parent, self.variant)
            self.assertFalse(call.args[1].is_symlink())
        color = self.assert_polished()
        np.testing.assert_array_equal(read_image(self.variant / "variant-colour.png"), self.color)
        np.testing.assert_array_equal(read_image(self.variant / "variant-paint.png"), self.paint)
        # A second invocation must read the newly installed page, even with the same source library and suffix.
        self.run_polish("--rim-soften", "0", "--paint-saturation", "1")
        np.testing.assert_array_equal(read_image(self.variant / f"sprites-{PAGE}@2x-l4inf.png"), color)
        self.assertEqual(json.loads(self.manifest.read_text())["spriteAtlasesHd"][PAGE]["paintSaturation"], 1)
        self.assertEqual(list(self.variant.glob(".*.tmp")), [])

    def test_polish_and_build_validate_weights_and_keep_noop_defaults(self):
        for command in ("build", "polish"):
            args = [command, "--library", str(self.source), "--page", str(PAGE), "--variant-dir", str(self.variant)]
            args += ["--work", str(self.root)] if command == "build" else ["--sprites", SPRITE]
            defaults = inf.parser().parse_args(args)
            self.assertEqual(defaults.rim_soften, 0)
            self.assertEqual(defaults.paint_saturation, 1)
            for option in ("--rim-soften", "--paint-saturation"):
                for value in ("-0.01", "1.01", "nan", "inf"):
                    with self.subTest(command=command, option=option, value=value), \
                            contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit) as error:
                        inf.parser().parse_args([*args, option, value])
                    self.assertEqual(error.exception.code, 2)


class InstallPagesTests(unittest.TestCase):
    def test_argument_parsing_and_defaults(self):
        required = ["install-pages", "--library", "base", "--work", "work", "--out", "staging",
                    "--farm", "farm", "--rel-dir", "_library/theatre"]
        defaults = inf.parser().parse_args(required)
        self.assertEqual(defaults.command, "install-pages")
        self.assertEqual((defaults.library, defaults.work, defaults.out, defaults.farm),
                         tuple(map(Path, ("base", "work", "staging", "farm"))))
        self.assertEqual(defaults.rel_dir, "_library/theatre")
        self.assertEqual((defaults.min_sil, defaults.rim_soften, defaults.paint_saturation, defaults.suffix),
                         (0.6, 0.5, 0.7, "l5inf"))
        self.assertIsNone(defaults.fill_dir)
        self.assertIsNone(defaults.units)
        self.assertIsNone(defaults.pages)
        parsed = inf.parser().parse_args([*required, "--fill-dir", "fill", "--units", "E1,E2",
                                         "--pages", "21,22", "--min-sil", "0.8", "--rim-soften", "0.2",
                                         "--paint-saturation", "0.9", "--suffix", "custom"])
        self.assertEqual(parsed.fill_dir, Path("fill"))
        self.assertEqual(parsed.units, ["E1", "E2"])
        self.assertEqual(parsed.pages, [21, 22])
        self.assertEqual((parsed.min_sil, parsed.rim_soften, parsed.paint_saturation, parsed.suffix),
                         (0.8, 0.2, 0.9, "custom"))
        for flag, value in (("--pages", "1,no"), ("--pages", "-1"), ("--rim-soften", "nan"),
                            ("--paint-saturation", "1.1"), ("--min-sil", "-0.1")):
            with self.subTest(flag=flag, value=value), contextlib.redirect_stderr(io.StringIO()), \
                    self.assertRaises(SystemExit):
                inf.parser().parse_args([*required, flag, value])

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = self.root / "source"
        self.source.mkdir()
        self.color = np.full((4, 4, 4), [30, 40, 50, 255], np.uint8)
        self.paint = np.full((4, 4), 7, np.uint8)
        Image.fromarray(self.color).save(self.source / "colour.png")
        Image.fromarray(self.paint).save(self.source / "paint.png")
        entry = {"file": "colour.png", "remap": "paint.png", "scale": 2, "width": 4, "height": 4}
        self.data = {"theater": "TEST", "spriteAtlases": [{"width": 2, "height": 2}] * 3,
                     "spriteAtlasesHd": [copy.deepcopy(entry) for _ in range(3)],
                     "sprites": {SPRITE: {"frames": [
                         {"page": 1, "rect": [0, 0, 1, 1]}, {"page": 1, "rect": [1, 0, 1, 1]},
                         {"page": 2, "rect": [0, 0, 1, 1]}]}}, "keep": [False, 0]}
        self.manifest = self.source / "library.json"
        self.manifest.write_text(json.dumps(self.data))
        self.current = self.root / "current"
        self.current.mkdir()
        self.merged = copy.deepcopy(self.data)
        self.merged["spriteAtlasesHd"][1]["otherTrack"] = "keep page metadata"
        self.merged["spriteAtlasesHd"][0]["file"] = "other-page.png"
        self.merged["farmOnly"] = True
        self.current_manifest = self.current / "library.json"
        self.current_manifest.write_text(json.dumps(self.merged))
        self.farm = self.root / "farm"
        self.farm.mkdir()
        (self.farm / "theatre").symlink_to(self.current)
        self.out = self.root / "staging"
        self.out.mkdir()
        self.work = self.root / "work"
        for name, unit, sprite, output in (("finished", "E1", SPRITE, "output.png"),
                                            ("excluded", "E2", SPRITE, "output.png"),
                                            ("pending", "E1", SPRITE, None),
                                            ("full-only", "E1", SPRITE, "full.png"),
                                            ("foreign", "E1", "unknown", "output.png")):
            directory = self.work / "sheets" / name
            directory.mkdir(parents=True)
            (directory / "job.json").write_text(json.dumps({"unit": unit, "sprite": sprite}))
            if output:
                Image.new("RGB", (1, 1)).save(directory / output)

    def composer(self, lib, directory, opts, page):
        self.assertEqual(directory.name, "finished")
        rgba = np.full((2, 2, 4), [200, 100, 20, 255], np.uint8)
        paint = np.full((2, 2), 19, np.uint8)
        frames = {i: {"rgba": rgba, "paint": paint, "metrics": {"sil_iou": 0.2 if i == 1 else 0.9}}
                  for i, frame in enumerate(lib.frames(SPRITE)) if frame["page"] == page}
        skipped = {i: "other-page" for i, frame in enumerate(lib.frames(SPRITE)) if frame["page"] != page}
        return {"job": {"sprite": SPRITE}, "frames": frames, "skipped": skipped, "raw": "output.png"}

    def run_install(self, page, *extra):
        with mock.patch.object(inf, "compose_job", side_effect=self.composer), \
                contextlib.redirect_stdout(io.StringIO()):
            code = inf.main(["install-pages", "--library", str(self.source), "--work", str(self.work),
                             "--out", str(self.out), "--farm", str(self.farm), "--rel-dir", "theatre",
                             "--units", "E1", "--pages", str(page), *extra])
        self.assertEqual(code, 0)

    def test_install_filters_jobs_and_pages_and_preserves_current_farm_manifest(self):
        page_path = self.out / "sprites-1@2x-l5inf.png"
        Image.fromarray(self.color).save(page_path)
        old_link = self.root / "served-before.png"
        old_link.hardlink_to(page_path)
        original_manifest = self.current_manifest.read_bytes()
        source_manifest = self.manifest.read_bytes()
        self.run_install(1)
        expected = copy.deepcopy(self.merged)
        expected["spriteAtlasesHd"][1].update(file=page_path.name, remap="sprites-1@2x-remap-l5inf.png",
                                             paintSaturation=0.7)
        manifest = self.farm / "theatre/library.json"
        self.assertFalse(manifest.is_symlink())
        self.assertEqual(json.loads(manifest.read_text()), expected)
        self.assertEqual(self.current_manifest.read_bytes(), original_manifest)
        self.assertEqual(self.manifest.read_bytes(), source_manifest)
        self.assertFalse((self.farm / "theatre").is_symlink())
        self.assertEqual((self.farm / "theatre" / page_path.name).stat().st_ino, page_path.stat().st_ino)
        np.testing.assert_array_equal(read_image(old_link), self.color)
        expected_color = self.color.copy()
        expected_color[:2, :2] = [200, 100, 20, 255]
        np.testing.assert_array_equal(read_image(page_path), expected_color)
        expected_paint = self.paint.copy()
        expected_paint[:2, :2] = 19
        np.testing.assert_array_equal(read_image(self.out / "sprites-1@2x-remap-l5inf.png"), expected_paint)
        report = json.loads((self.out / "report-1.json").read_text())
        self.assertFalse(report["frames"][f"{SPRITE}#1"]["accepted"])
        self.assertEqual(report["frames"][f"{SPRITE}#2"]["skipped"], "other-page")
        self.assertFalse((self.out / "sprites-2@2x-l5inf.png").exists())
        self.assertEqual(list(self.out.glob(".*")), [])

    def test_donor_fill_initialises_only_missing_selected_hd_entry(self):
        self.data["spriteAtlasesHd"][2] = None
        self.manifest.write_text(json.dumps(self.data))
        cached = inf.library(self.source)
        self.merged["spriteAtlasesHd"][2] = None
        self.current_manifest.write_text(json.dumps(self.merged))
        fill = self.root / "fill"
        fill.mkdir()
        Image.fromarray(self.color).save(fill / "sprites-2@2x-fill.png")
        Image.fromarray(self.paint).save(fill / "sprites-2@2x-remap-fill.png")
        self.run_install(2, "--fill-dir", str(fill), "--suffix", "custom", "--paint-saturation", "0.8")
        expected = copy.deepcopy(self.merged)
        expected["spriteAtlasesHd"][2] = {"file": "sprites-2@2x-custom.png",
                                           "remap": "sprites-2@2x-remap-custom.png", "scale": 2,
                                           "width": 4, "height": 4, "paintSaturation": 0.8}
        self.assertEqual(json.loads((self.farm / "theatre/library.json").read_text()), expected)
        self.assertIsNone(cached.data["spriteAtlasesHd"][2])
        self.assertIsNone(json.loads(self.manifest.read_text())["spriteAtlasesHd"][2])
        color = read_image(self.out / "sprites-2@2x-custom.png")
        np.testing.assert_array_equal(color[2:], self.color[2:])


class SchedulerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix=".tmp-infantry-run-", dir=Path(__file__).parent)
        self.addCleanup(self.temp.cleanup)
        self.work = Path(self.temp.name).resolve()

    def job(self, name):
        d = self.work / "sheets" / name
        d.mkdir(parents=True)
        (d / "job.json").write_text(json.dumps({"unit": "E1", "seq": "Walk"}))
        (d / "prompt.txt").write_text('synthetic prompt with "quotes", $variables and\nnewlines')
        Image.new("RGB", (2, 2), (118, 118, 118)).save(d / "input.png")
        return d

    def fake_codex(self, body):
        path = self.work / "fake-codex"
        path.write_text(f"#!{sys.executable}\n" +
                        "import json, os, pathlib, shutil, sys, time\n" + body)
        path.chmod(0o755)
        return str(path)

    def test_exact_agent_command_retries_and_redo(self):
        d = self.job("a")
        binary = self.fake_codex('''
d = pathlib.Path.cwd()
(d / "argv.json").write_text(json.dumps(sys.argv[1:]))
assert sys.stdin.read() == ""
count = d / "attempt-count"
n = int(count.read_text()) + 1 if count.exists() else 1
count.write_text(str(n))
print("attempt", n)
if n == 1:
    sys.exit(1)
shutil.copyfile(d / "input.png", d / "output.png")
pathlib.Path(sys.argv[sys.argv.index("-o") + 1]).write_text("fake image tool")
''')
        self.assertEqual(inf.run(self.work, binary, parallel=1, poll_interval=0.01), 0)
        prompt = (d / "prompt.txt").read_text()
        self.assertEqual(json.loads((d / "argv.json").read_text()), [
            "exec", "-s", "workspace-write", "--skip-git-repo-check", "-C", str(d),
            "-o", str(d / "last.txt"), prompt])
        self.assertEqual((d / "attempt-count").read_text(), "2")
        self.assertEqual((d / "exit").read_text().strip(), "0")
        self.assertTrue((d / "end").exists())
        self.assertEqual(inf.run(self.work, binary, poll_interval=0.01), 0)
        self.assertEqual((d / "attempt-count").read_text(), "2")
        self.assertEqual(inf.run(self.work, binary, redo=["a"], poll_interval=0.01), 0)
        self.assertTrue((d / "try0/output.png").is_file())
        self.assertEqual((d / "try0/prompt.txt").read_text(), prompt)
        self.assertEqual((d / "prompt.txt").read_text(), prompt)

    def test_all_limit_patterns_stop_even_when_an_output_exists(self):
        for text in ("Usage limit", "RATE LIMIT", "HTTP 429", "quota exhausted"):
            with self.subTest(log=text):
                if (self.work / "sheets").exists():
                    shutil.rmtree(self.work / "sheets")
                a, b = self.job("a"), self.job("b")
                limit = self.work / "shared/limit.txt"
                limit.unlink(missing_ok=True)
                binary = self.fake_codex(
                    f'print({text!r}, flush=True)\nprint("x" * 5000, flush=True)\n'
                    'shutil.copyfile("input.png", "output.png")\ntime.sleep(0.03)\n')
                self.assertEqual(inf.run(self.work, binary, parallel=1, limit_file=limit, poll_interval=0.01), 2)
                self.assertIn(text, limit.read_text())
                self.assertFalse((b / "start").exists())
                self.assertTrue((a / "output.png").exists())
                self.assertEqual(inf.run(self.work, binary, limit_file=limit, redo=["a"]), 2)
                self.assertFalse((a / "try0").exists())

    def test_retry_budget_and_names_filter(self):
        a, b = self.job("a"), self.job("b")
        binary = self.fake_codex('sys.exit(1)\n')
        self.assertEqual(inf.run(self.work, binary, names=["a"], poll_interval=0.01), 1)
        self.assertEqual((self.work / "sched.log").read_text().count("launched a"), 3)
        self.assertFalse((b / "start").exists())
        self.assertEqual((a / "exit").read_text().strip(), "1")
        with self.assertRaises(ValueError):
            inf.run(self.work, binary, names=["typo"])

    def test_parallel_limit_and_actual_overlapping_children(self):
        for i in range(5):
            self.job(str(i))
        binary = self.fake_codex('''
d = pathlib.Path.cwd()
(d / "lifetime.json").write_text(json.dumps([time.time()]))
time.sleep(0.2)
start = json.loads((d / "lifetime.json").read_text())[0]
(d / "lifetime.json").write_text(json.dumps([start, time.time()]))
shutil.copyfile(d / "input.png", d / "output.png")
''')
        self.assertEqual(inf.run(self.work, binary, parallel=3, poll_interval=0.01), 0)
        intervals = [json.loads((d / "lifetime.json").read_text()) for d in (self.work / "sheets").iterdir()]
        overlap = max(sum(start <= t < end for start, end in intervals) for t, _ in intervals)
        self.assertEqual(overlap, 3)
        with self.assertRaises(ValueError):
            inf.run(self.work, binary, parallel=4)

    def test_cli_help_needs_no_library(self):
        result = subprocess.run([sys.executable, "-B", str(Path(inf.__file__)), "--help"],
                                capture_output=True, text=True, check=True)
        self.assertIn("{prepare,run,compose,build,polish,install-pages}", result.stdout)


if __name__ == "__main__":
    unittest.main()
