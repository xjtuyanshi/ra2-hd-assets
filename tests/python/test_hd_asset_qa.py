"""Synthetic contract/metric regressions; never require or create game artwork."""
import csv
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

import numpy as np
from PIL import Image

SCRIPT = Path(__file__).resolve().parents[2] / "scripts/remaster/qa/asset_qa.py"
spec = importlib.util.spec_from_file_location("asset_qa", SCRIPT)
qa = importlib.util.module_from_spec(spec)
spec.loader.exec_module(qa)


def square(size=16, start=4, end=12, colour=.4):
    a = np.zeros((size, size, 4), np.float32)
    a[start:end, start:end, :3] = colour
    a[start:end, start:end, 3] = 1
    return a


def metrics(a, b, am=None, bm=None, **kwargs):
    z = np.zeros(a.shape[:2], np.float32)
    return qa.measure(a, b, z if am is None else am, z if bm is None else bm, **kwargs)


class MetricTests(unittest.TestCase):
    def test_identical_is_not_a_failure(self):
        a = square()
        m, flags = metrics(a, a)
        self.assertEqual(flags, [])
        self.assertEqual(m["silhouette_iou"], 1)
        self.assertIsNone(m["texture_gain"])

    def test_silhouette_loss(self):
        a, b = square(), square(end=9)
        m, flags = metrics(a, b)
        self.assertLess(m["silhouette_iou"], .85)
        self.assertIn("silhouette_iou", flags)

    def test_centroid_registration_is_not_auto_corrected(self):
        a, b = square(), square(start=6, end=14)
        m, flags = metrics(a, b)
        self.assertGreater(m["centroid_shift_px"], 1.5)
        self.assertIn("misregistration", flags)

    def test_bbox_only_registration(self):
        a, b = square(size=24, start=4, end=20), square(size=24, start=4, end=20)
        b[11, 1, :3] = .4
        b[11, 1, 3] = 1
        m, flags = metrics(a, b)
        self.assertLess(m["centroid_shift_px"], 1.5)
        self.assertEqual(m["bbox_shift_px"], 3)
        self.assertIn("misregistration", flags)

    def test_colour_delta(self):
        m, flags = metrics(square(colour=.4), square(colour=.8))
        self.assertGreater(m["lab_mean_delta"], 8)
        self.assertIn("colour_drift", flags)

    def test_lab_reference_white_and_red(self):
        values = qa.lab(np.array([[1, 1, 1], [1, 0, 0]], np.float32))
        np.testing.assert_allclose(values[0], [100, 0, 0], atol=.02)
        np.testing.assert_allclose(values[1], [53.24, 80.09, 67.20], atol=.05)

    def test_texture_smoothing(self):
        a = square()
        a[4:12, 4:12, :3] = (np.indices((8, 8)).sum(0) % 2)[..., None] * .4 + .2
        m, flags = metrics(a, square())
        self.assertEqual(m["texture_gain"], 0)
        self.assertIn("texture_loss", flags)

    def test_alpha_edges_do_not_create_texture_gain(self):
        m, _ = metrics(square(), square())
        self.assertIsNone(m["texture_gain"])

    def test_missing_and_unexpected_frames(self):
        self.assertIn("missing_frame", metrics(square(), np.zeros((16, 16, 4)))[1])
        self.assertIn("unexpected_frame", metrics(np.zeros((16, 16, 4)), square())[1])

    def test_faint_effect_tail_is_not_a_missing_frame(self):
        a, b = square(), square()
        b[..., 3] *= .2
        _, flags = metrics(a, b)
        self.assertNotIn("missing_frame", flags)
        self.assertIn("silhouette_iou", flags)

    def test_zero_coverage_effect_emission_is_not_missing(self):
        _, flags = metrics(square(), np.zeros((16, 16, 4)), additive=True, emission_present=True)
        self.assertNotIn("missing_frame", flags)

    def test_halo_outside_native_tolerance(self):
        a, b = square(), square()
        b[1, 7] = [.7, .7, .7, .1]
        m, flags = metrics(a, b)
        self.assertGreater(m["halo_fraction"], .01)
        self.assertIn("alpha_halo", flags)

    def test_pale_alpha_fringe(self):
        a, b = square(), square()
        b[4, 4:12, :3] = 1
        _, flags = metrics(a, b)
        self.assertIn("alpha_fringe", flags)

    def test_effect_emission_is_not_a_fringe(self):
        a, b = square(), square()
        b[4, 4:12, :3] = 1
        _, flags = metrics(a, b, additive=True)
        self.assertNotIn("alpha_fringe", flags)

    def test_shadow_is_geometry_only(self):
        m, flags = metrics(square(colour=.1), square(colour=.9), shadow=True)
        self.assertIsNone(m["lab_mean_delta"])
        self.assertIsNone(m["texture_gain"])
        self.assertNotIn("colour_drift", flags)

    def test_neutral_remap_does_not_compare_source_faction_hue(self):
        a = square(colour=.7)
        mask = a[..., 3]
        ramp = np.array([[.8 - i * .04, .03, .05] for i in range(16)], np.float32)
        m, flags = metrics(a, a, mask, mask, ramps=[ramp])
        self.assertEqual(m["remap_hue_drift_deg"], 0)
        self.assertNotIn("faction_hue_drift", flags)

    def test_remap_leak_changes_repainted_hue(self):
        a, b = square(colour=.7), square(colour=.7)
        b[4:12, 4:12, :3] = [.03, .8, .03]
        am, bm = a[..., 3], np.zeros(a.shape[:2], np.float32)
        ramp = np.array([[.8 - i * .04, .03, .05] for i in range(16)], np.float32)
        m, flags = metrics(a, b, am, bm, ramps=[ramp])
        self.assertGreater(m["remap_hue_drift_deg"], 8)
        self.assertIn("faction_hue_drift", flags)
        self.assertIn("remap_mask_drift", flags)

    def test_selected_faction_pixels_match_full_grid_repaint(self):
        a, b = square(colour=.7), square(colour=.7)
        am = a[..., 3].copy()
        bm = am * .7
        b[4:12, 4:12, :3] = [.1, .8, .2]
        ramp = np.array([[.8 - i * .04, .03, .05] for i in range(16)], np.float32)
        ah, sa = qa.hue(qa.paint(a[..., :3], am, ramp))
        bh, sb = qa.hue(qa.paint(b[..., :3], bm, ramp, .8))
        region = (a[..., 3] >= .5) & (b[..., 3] >= .5) & (am >= .5) & (sa > .1) & (sb > .1)
        delta = np.abs(ah[region] - bh[region])
        expected = np.minimum(delta, 360 - delta).mean()
        result, _ = metrics(a, b, am, bm, ramps=[ramp], saturation=.8)
        self.assertAlmostEqual(result["remap_hue_drift_deg"], float(expected), places=6)

    def test_downsample_premultiplied(self):
        a = np.array([[[1, 0, 0, 1], [0, 1, 0, 0]], [[0, 0, 1, 0], [1, 1, 1, 0]]], np.float32)
        np.testing.assert_allclose(qa.native_rgba(a, 2), [[[1, 0, 0, .25]]])

    def test_fractional_effect_offset(self):
        a = np.ones((2, 2, 4), np.float32)
        b = np.ones((4, 4, 4), np.float32)
        aa, bb, _, _ = qa.align(a, b, [0, 0], [.5, 0], 2)
        self.assertEqual(aa.shape, (2, 3, 4))
        self.assertEqual(bb[0, 0, 3], .5)

    def test_fractional_offset_does_not_round_registration(self):
        a = np.ones((2, 2, 4), np.float32)
        b = np.ones((4, 4, 4), np.float32)
        _, bb, _, _ = qa.align(a, b, [0, 0], [.3, 0], 2)
        self.assertAlmostEqual(float(bb[0, 0, 3]), .7, places=6)

    def test_invalid_scale_and_rect_rejected(self):
        with self.assertRaises(ValueError):
            qa.align(np.ones((2, 2, 4)), np.ones((4, 4, 4)), [0, 0], [0, 0], 0)
        self.assertFalse(qa.rect_valid([-1, 0, 1, 1], (4, 4)))
        self.assertFalse(qa.rect_valid([0, 0, 5, 1], (4, 4)))


class ContractTests(unittest.TestCase):
    def test_full_frame_count(self):
        self.assertTrue(qa.frame_count_errors({"frames": [{}, {}], "frameCount": 3}))

    def test_selected_source_frames_are_not_count_mismatch(self):
        self.assertEqual(qa.frame_count_errors({"frames": [{}], "shadows": [{}], "sourceFrames": [4], "frameCount": 20}), [])

    def test_bad_selected_source_frames(self):
        self.assertTrue(qa.frame_count_errors({"frames": [{}], "sourceFrames": [4, 5], "frameCount": 3}))

    def test_shadow_count(self):
        self.assertTrue(qa.frame_count_errors({"frames": [{}, {}], "shadows": [{}]}))

    def test_local_refs_and_sprite_refs(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            doc = {"spriteAtlas": {"file": "missing.png"}, "voxels": {"X": "voxels/X.json"},
                   "sprites": {"a": {"frames": [], "layers": ["unknown"], "file": "original.shp"}},
                   "types": {"x": {"sprite": "nowhere"}}}
            rows = qa.audit_json(root / "manifest.json", doc, root)
            self.assertEqual(sum(r["failures"] == "missing_reference" for r in rows), 2)
            self.assertEqual(sum(r["failures"] == "missing_sprite_reference" for r in rows), 2)
            self.assertFalse(any("shp" in r["detail"] for r in rows))

    def test_research_sprite_lists_are_not_runtime_contracts(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            self.assertEqual(qa.audit_json(root / "research.json", {"sprites": ["x", "y"]}, root), [])

    def test_reference_outside_cache(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            r = qa.audit_json(root / "manifest.json", {"file": "../bad.png"}, root)
            self.assertEqual(r[0]["failures"], "reference_outside_cache")

    def test_symlink_manifest_keeps_visible_relative_paths(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            cache, legacy = root / "cache", root / "legacy"
            cache.mkdir()
            legacy.mkdir()
            doc = {"file": "sprites.png"}
            (legacy / "manifest.json").write_text(json.dumps(doc))
            (cache / "manifest.json").symlink_to(legacy / "manifest.json")
            Image.fromarray(np.zeros((2, 2), np.uint8)).save(legacy / "sprites.png")
            (cache / "sprites.png").symlink_to(legacy / "sprites.png")
            self.assertEqual(qa.audit_json(cache / "manifest.json", doc, cache), [])
            result = qa.scan(cache, root / "out")
            self.assertEqual(result["changed_inputs"], [])

    def test_output_symlink_escape_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            cache, out = root / "cache", root / "out"
            cache.mkdir()
            out.mkdir()
            (out / "crops").symlink_to(cache, target_is_directory=True)
            with self.assertRaises(ValueError):
                qa.scan(cache, out)

    def test_bad_page_number(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            d = {"spriteAtlas": {"file": "sprites.png"}, "sprites": {"a": {"frames": [{"page": -1}]}}}
            _, rows = qa.standard_jobs(root / "manifest.json", d, root, set())
            self.assertEqual(rows[0]["failures"], "missing_page")

    def test_historical_variants_and_source_suffix(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            d = {"spriteAtlases": [{"file": "sprites-0-source-test.png"}], "sprites": {}}
            files = {root / "sprites-0@2x-old.png", root / "sprites-0@2x-remap-old.png", root / "sprites-0@2x-normals.png"}
            jobs, _ = qa.standard_jobs(root / "library.json", d, root, files)
            self.assertEqual(len(jobs), 1)
            self.assertEqual(jobs[0]["remap"], str(root / "sprites-0@2x-remap-old.png"))

    def test_indexed_shadows_are_not_hd_replacements(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            frame = {"rect": [0, 0, 2, 2]}
            d = {"spriteAtlas": {"file": "sprites.png", "width": 8, "height": 8},
                 "sprites": {"a": {"frames": [frame], "shadows": [frame]}}}
            jobs, rows = qa.standard_jobs(root / "manifest.json", d, root, {root / "sprites@2x.png"})
            self.assertEqual(len(jobs[0]["frames"]), 1)
            self.assertEqual(rows, [])

    def test_effect_count_and_null_frames(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            native = {"sprites": {"anim:X": {"frames": [{"rect": [0, 0, 2, 2]}]}}}
            _, rows = qa.effect_jobs(root / "effects-hd.json", {"anims": {"X": {"frames": []}}}, root / "effects.json", native, root)
            self.assertEqual({r["failures"] for r in rows}, {"frame_count_mismatch", "missing_frame"})

    def test_coalesce_only_contiguous_equivalent_failures(self):
        rs = [qa.row(asset="x", kind="body", failures="texture_loss", hd="h", source="s", frame_start=i,
                     frame_end=i, source_frame_start=i, source_frame_end=i, frames=1, texture_gain=g) for i, g in [(0, .8), (1, .7), (3, .6)]]
        result = qa.coalesce(rs)
        self.assertEqual(len(result), 2)
        self.assertEqual(result[0]["texture_gain"], .7)
        self.assertEqual(result[0]["frames"], 2)

    def test_out_cannot_overlap_cache(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            with self.assertRaises(ValueError):
                qa.scan(root, root / "out")
            with self.assertRaises(ValueError):
                qa.scan(root / "cache", root)

    def test_complete_scan_resume_and_input_bytes_unchanged(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            cache, out = root / "cache", root / "out"
            cache.mkdir()
            indexes = np.zeros((16, 16), np.uint8)
            indexes[4:12, 4:12] = 32
            Image.fromarray(indexes).save(cache / "sprites.png")
            Image.fromarray(np.full((1, 256, 3), 102, np.uint8)).save(cache / "palette.png")
            hd = (square() * 255).astype(np.uint8)
            Image.fromarray(np.repeat(np.repeat(hd, 2, 0), 2, 1)).save(cache / "sprites@2x.png")
            Image.fromarray(np.zeros((32, 32), np.uint8)).save(cache / "sprites@2x-remap.png")
            doc = {"spriteAtlas": {"file": "sprites.png", "width": 16, "height": 16},
                   "spriteAtlasHd": {"file": "sprites@2x.png", "remap": "sprites@2x-remap.png", "scale": 2, "width": 32, "height": 32},
                   "palettes": {"unit": "palette.png"}, "sprites": {"synthetic": {"palette": "unit", "frameCount": 1,
                       "frames": [{"rect": [0, 0, 16, 16], "offset": [-8, -8]}]}}}
            (cache / "manifest.json").write_text(json.dumps(doc))
            original = {p.name: p.read_bytes() for p in cache.iterdir()}
            first, second = qa.scan(cache, out), qa.scan(cache, out)
            self.assertEqual(first["frames"], 1)
            self.assertEqual(second["resumed_jobs"], 1)
            self.assertEqual(second["changed_inputs"], [])
            self.assertEqual(original, {p.name: p.read_bytes() for p in cache.iterdir()})
            with (out / "qa.csv").open() as f:
                rows = list(csv.DictReader(f))
            self.assertEqual(rows[0]["status"], "PASS")
            self.assertTrue((out / "QA.md").is_file())
            # A changed page must invalidate its old receipt and emit a missing-frame failure.
            Image.fromarray(np.zeros((32, 32, 4), np.uint8)).save(cache / "sprites@2x.png")
            third = qa.scan(cache, out)
            self.assertEqual(third["resumed_jobs"], 0)
            self.assertGreater(third["flag_counts"]["missing_frame"], 0)
            self.assertTrue((out / "crops/01.png").is_file())


if __name__ == "__main__":
    unittest.main()
