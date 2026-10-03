"""Synthetic regressions for completed-worker snapshots and shared-page publication."""

import argparse
import copy
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest import mock

import numpy as np
from PIL import Image

import cache_farm
import infantry_incremental as batch
import infantry_sheets as inf


SPRITE = "infantry:TEST"


def library(path, shifted=False):
    path.mkdir(parents=True)
    indices = np.zeros((8, 8), np.uint8)
    a = np.array([[16, 17], [10, 12]], np.uint8)
    b = np.array([[8, 8], [8, 0]], np.uint8)
    indices[:2, :2], indices[:2, 4:6] = (b, a) if shifted else (a, b)
    Image.fromarray(indices).save(path / "indices.png")
    color = np.full((16, 16, 4), [80, 90, 100, 0], np.uint8)
    color[..., 3] = np.kron(indices > 0, np.ones((2, 2), np.uint8)) * 255
    paint = np.kron((indices >= 16) & (indices <= 31), np.ones((2, 2), np.uint8)) * 255
    Image.fromarray(color).save(path / "color.png")
    Image.fromarray(paint).save(path / "paint.png")
    palette = np.repeat(np.arange(256, dtype=np.uint8)[:, None], 3, axis=1)[None]
    if shifted:
        palette[0, 0] = [20, 50, 100]  # Transparent palette differences must not block a transfer.
    Image.fromarray(palette).save(path / "palette.png")
    page = 1 if shifted else 0
    frames = [{"page": page, "rect": [4 if shifted else 0, 0, 2, 2], "offset": [0, 0]},
              {"page": page, "rect": [0 if shifted else 4, 0, 2, 2], "offset": [0, 0]}]
    hd = {"file": "color.png", "remap": "paint.png", "scale": 2, "width": 16, "height": 16,
          "paintSaturation": 1.0, "sibling": "retain"}
    data = {"spriteAtlases": [{"file": "indices.png", "width": 8, "height": 8}] * (page + 1),
            "spriteAtlasesHd": [copy.deepcopy(hd) for _ in range(page + 1)],
            "sprites": {SPRITE: {"frames": frames, "palette": "unit"}},
            "palettes": {"unit": "palette.png"}, "colorSchemesByName": {"Red": 0, "DarkBlue": 1},
            "colorSchemes": [{"remap": [[250 - i * 10, 0, 0] for i in range(16)]},
                             {"remap": [[0, 0, 250 - i * 10] for i in range(16)]}],
            "unrelated": [False, 0, "preserve"]}
    (path / "library.json").write_text(json.dumps(data))
    return inf.Library(path)


class IncrementalTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = library(self.root / "source")
        self.current = library(self.root / "current", shifted=True)
        self.farm = self.root / "farm"
        (self.farm / "_library").mkdir(parents=True)
        (self.farm / "_library/test").symlink_to(self.current.root)
        self.work = self.root / "work"
        self.job = self.work / "sheets/finished"
        self.job.mkdir(parents=True)
        (self.job / "job.json").write_text(json.dumps({"sprite": SPRITE, "house": "DarkBlue"}))
        for name in ("input.png", "output.png", "full.png"):
            Image.new("RGB", (8, 8), "gray").save(self.job / name)
        (self.job / "started.txt").write_text("1\n")
        (self.job / "done.txt").write_text("exit 0\n2\n")
        for path in self.job.iterdir():
            os.utime(path, ns=(100, 100))
        os.utime(self.job / "done.txt", ns=(200, 200))
        self.frozen = self.root / "frozen"
        self.staged = self.root / "staged"
        self.out = self.root / "published"

    def stage(self, measurements=None, **finishes):
        batch.snapshot(self.work, self.frozen, ["finished"])
        frames = {}
        for i in (0, 1):
            f = self.source.frames(SPRITE)[i]
            x, y, w, h = f["rect"]
            crop = np.s_[2 * y:2 * (y + h), 2 * x:2 * (x + w)]
            frames[i] = {"rgba": self.source.page2(0)[crop].copy(),
                         "paint": self.source.remap2(0)[crop].copy(),
                         "metrics": measurements[i] if measurements else {"sil_iou": 0.9 if i == 0 else 0.2}}
        result = {"job": {"sprite": SPRITE, "house": "DarkBlue"}, "frames": frames, "skipped": {}}
        with mock.patch.object(inf, "compose_job", return_value=result):
            return batch.compose(self.source, self.frozen, self.staged,
                                 argparse.Namespace(**inf.COMPOSE_DEFAULTS), **finishes)

    def test_indexed_gate_requires_version_and_unclipped_context(self):
        good = {"sil_iou": 0.4, "indexed_sil_iou": 0.75, "indexed_sil_method": inf.INDEXED_SIL_METHOD,
                "indexed_context_edge": False}
        self.assertFalse(batch.silhouette_passes(good, "legacy", 0.6))
        self.assertTrue(batch.silhouette_passes(good, "indexed", 0.6))
        for override in ({"indexed_sil_iou": 0.59}, {"indexed_sil_iou": float("nan")},
                         {"indexed_context_edge": True}, {"indexed_sil_method": "old"}):
            with self.subTest(override=override):
                self.assertFalse(batch.silhouette_passes(dict(good, **override), "indexed", 0.6))
        for field in ("indexed_sil_iou", "indexed_sil_method", "indexed_context_edge"):
            incomplete = dict(good)
            del incomplete[field]
            with self.subTest(missing=field):
                self.assertFalse(batch.silhouette_passes(incomplete, "indexed", 0.6))

    def test_indexed_choice_is_recorded_and_rechecked_at_publish(self):
        measures = [{"sil_iou": 0.4, "indexed_sil_iou": 0.75,
                     "indexed_sil_method": inf.INDEXED_SIL_METHOD, "indexed_context_edge": False},
                    {"sil_iou": 0.9, "indexed_sil_iou": 0.5,
                     "indexed_sil_method": inf.INDEXED_SIL_METHOD, "indexed_context_edge": False}]
        report = self.stage(measurements=measures, silhouette_reference="indexed", min_body=0.7)
        self.assertEqual(report["silhouette_reference"], "indexed")
        self.assertTrue(report["frames"][f"{SPRITE}#0"]["accepted"])
        self.assertFalse(report["frames"][f"{SPRITE}#1"]["accepted"])
        batch.publish(self.source, self.staged, self.farm, "test", self.out, "indexed")
        report["min_body"] = 0.99
        batch.write_json(self.staged / "candidates.json", report)
        with self.assertRaisesRegex(ValueError, "quality thresholds"):
            batch.publish(self.source, self.staged, self.farm, "test", self.root / "body-refused", "body")
        report["min_body"] = 0.7
        report["frames"][f"{SPRITE}#0"]["metrics"]["indexed_context_edge"] = True
        batch.write_json(self.staged / "candidates.json", report)
        with self.assertRaisesRegex(ValueError, "quality thresholds"):
            batch.publish(self.source, self.staged, self.farm, "test", self.root / "refused", "unsafe")
        self.assertFalse((self.farm / "_library/test/sprites-1@2x-unsafe.png").exists())

    def test_source_remap_restores_body_chroma_using_decoded_house_luminance(self):
        idx = np.array([[16, 10, 0], [10, 12, 0]], np.uint8)
        original = np.full((2, 3, 3), [230, 10, 230], np.float32)
        original[idx == 10] = [45, 115, 60]
        paint = np.full((4, 6), 255, np.uint8)
        paint[2:, :2] = 0  # Unpainted source body remains byte-identical.
        rgba = np.full((4, 6, 4), [150, 150, 150, 255], np.uint8)
        rgba[1::2, :, :3] = 180
        rgba[:, 4:, 3] = 90  # Soft edge alpha is preserved, not filled from palette zero.
        with mock.patch.object(self.source, "frame1", return_value=(original, idx > 0,
                                                                   (idx >= 16) & (idx <= 31), idx)):
            result, result_paint = batch.restrict_source_remap(self.source, SPRITE, 0, rgba, paint, "DarkBlue")
        removed = (paint > 0) & ~np.kron(idx == 16, np.ones((2, 2), bool))
        np.testing.assert_array_equal(result[~removed], rgba[~removed])
        np.testing.assert_array_equal(result[..., 3], rgba[..., 3])
        np.testing.assert_array_equal(result_paint[~removed], paint[~removed])
        self.assertTrue(np.all(result_paint[removed] == 0))
        expected_lum = inf.rd.srgb_to_lab(self.source.decode_hd(rgba, paint, "DarkBlue"))[..., 0]
        final_lab = inf.rd.srgb_to_lab(result[..., :3])
        self.assertLess(float(np.abs(final_lab[..., 0][removed] - expected_lum[removed]).max()), 0.8)
        self.assertTrue(np.all(final_lab[..., 1][removed] < -10))  # Green cloth, no grey/magenta fringe.
        self.assertGreater(float(np.ptp(final_lab[..., 0][removed])), 1)
        for house in ("Red", "DarkBlue"):
            decoded = self.source.decode_hd(result, result_paint, house)
            np.testing.assert_array_equal(decoded[removed], result[..., :3][removed])

    def test_source_remap_requires_real_nonremap_body_reference(self):
        idx = np.array([[16, 0]], np.uint8)
        rgba = np.full((2, 4, 4), 200, np.uint8)
        paint = np.full((2, 4), 255, np.uint8)
        with mock.patch.object(self.source, "frame1", return_value=(np.zeros((1, 2, 3)), idx > 0,
                                                                   idx == 16, idx)), \
                self.assertRaisesRegex(ValueError, "no non-remap body"):
            batch.restrict_source_remap(self.source, SPRITE, 0, rgba, paint, "DarkBlue")

    def test_source_remap_bounds_finish_convolution_and_shadow_side_effects(self):
        real_finish = batch.finish_frame
        original_paint = self.source.remap2(0).copy()
        for spurious in (False, True):
            with self.subTest(spurious=spurious):
                self.frozen, self.staged = self.root / f"frozen-{spurious}", self.root / f"staged-{spurious}"
                calls = []

                def coupled_finish(*args):
                    rgba, paint = real_finish(*args)
                    rgba, paint = rgba.copy(), paint.copy()
                    calls.append((rgba.copy(), paint.copy()))
                    if len(calls) == 2:
                        # Deliberately spread a local adjustment into normal paint and shadow alpha.
                        rgba[..., :3] = 201
                        rgba[..., 3] = 1
                        paint[:] = 7
                    return rgba, paint

                model_paint = original_paint.copy()
                if spurious:
                    model_paint[2, 0] = 255  # Original index10: real non-remap body, not normal paint.
                with mock.patch.object(batch, "finish_frame", side_effect=coupled_finish), \
                        mock.patch.object(self.source, "remap2", return_value=model_paint):
                    report = self.stage(source_remap=[f"{SPRITE}#0"])
                expected_rgba, expected_paint = calls[0]
                if spurious:
                    expected_rgba[2, 0, :3], expected_paint[2, 0] = 201, 7
                entry = report["frames"][f"{SPRITE}#0"]
                np.testing.assert_array_equal(np.array(Image.open(self.staged / entry["files"]["color"])),
                                              expected_rgba)
                np.testing.assert_array_equal(np.array(Image.open(self.staged / entry["files"]["remap"])),
                                              expected_paint)
                other = report["frames"][f"{SPRITE}#1"]
                for kind, expected in zip(("color", "remap"), calls[2]):
                    np.testing.assert_array_equal(np.array(Image.open(self.staged / other["files"][kind])), expected)

    def test_frame_finish_overrides_preserve_other_frames_alpha_and_paint_extent(self):
        with mock.patch.object(inf, "repaint_frame", wraps=inf.repaint_frame) as repaint, \
                mock.patch.object(inf, "paint_value_frame", wraps=inf.paint_value_frame) as paint_value:
            report = self.stage(edges={SPRITE: (0.1, 0.5), f"{SPRITE}#0": (0.4, 0.8)},
                                paint_values={SPRITE: (1, 0), f"{SPRITE}#0": (0.35, 15)})
        self.assertEqual(repaint.call_args_list[0].kwargs["edge"], (0.4, 0.8))
        self.assertEqual(repaint.call_args_list[1].kwargs["edge"], (0.1, 0.5))
        first, second = paint_value.call_args_list
        self.assertEqual((first.args[3], first.kwargs["outside_floor"]), (0.35, 15))
        self.assertEqual((second.args[3], second.kwargs["outside_floor"]), (1, 0))
        entry = report["frames"][f"{SPRITE}#0"]
        rgba = np.array(Image.open(self.staged / entry["files"]["color"]))
        paint = np.array(Image.open(self.staged / entry["files"]["remap"]))
        np.testing.assert_array_equal(rgba[..., 3], first.args[0][..., 3])
        np.testing.assert_array_equal(paint, first.args[1])
        unpainted = (paint <= 0.02 * 255) | (rgba[..., 3] == 0)
        np.testing.assert_array_equal(rgba[unpainted], first.args[0][unpainted])
        self.assertTrue(np.any(rgba[~unpainted] != first.args[0][~unpainted]))
        other = report["frames"][f"{SPRITE}#1"]
        np.testing.assert_array_equal(np.array(Image.open(self.staged / other["files"]["color"])), second.args[0])
        self.assertEqual(report["paint_values"][f"{SPRITE}#0"], (0.35, 15))
        self.assertEqual(batch.digest(self.staged / entry["files"]["color"]), entry["sha256"]["color"])

    def test_invalid_paint_value_finish_fails_before_staging(self):
        batch.snapshot(self.work, self.frozen, ["finished"])
        for pair in ((0, 0), (1.1, 0), (0.35, 16), (float("nan"), 0)):
            with self.subTest(pair=pair), self.assertRaises(ValueError):
                batch.compose(self.source, self.frozen, self.staged, argparse.Namespace(**inf.COMPOSE_DEFAULTS),
                              paint_values={SPRITE: pair})
            self.assertFalse(self.staged.exists())

    def add_normals(self, overlap=False, stale=False):
        material = np.full((8, 8, 4), [128, 128, 255, 0], np.uint8)
        material[0, 4 if overlap else 0, 3] = 255
        Image.fromarray(material).save(self.current.root / "normal.png")
        entry = {"file": "normal.png", "atlas": "stale.png" if stale else "color.png",
                 "width": 16, "height": 16, "scale": 2, "materialWidth": 8, "materialHeight": 8}
        (self.current.root / "normals.json").write_text(json.dumps({"version": 1, "pages": {"1": entry}}))

    def test_snapshot_waits_for_completed_worker_and_never_reuses_directory(self):
        self.assertTrue(batch.ready(self.job))
        os.utime(self.job / "output.png", ns=(300, 300))
        self.assertFalse(batch.ready(self.job))
        with self.assertRaisesRegex(ValueError, "completed successful"):
            batch.snapshot(self.work, self.frozen, ["finished"])
        self.assertFalse(self.frozen.exists())
        os.utime(self.job / "done.txt", ns=(400, 400))
        batch.snapshot(self.work, self.frozen, ["finished"])
        self.assertEqual((self.frozen / "sheets/finished/output.png").read_bytes(),
                         (self.job / "output.png").read_bytes())
        self.assertFalse((self.frozen / "sheets/finished/output.png").is_symlink())
        with self.assertRaises(FileExistsError):
            batch.snapshot(self.work, self.frozen, ["finished"])
        os.utime(self.job / "started.txt", ns=(500, 500))
        self.assertFalse(batch.ready(self.job))

    def test_failed_worker_and_changed_snapshot_are_not_accepted(self):
        (self.job / "done.txt").write_text("exit 1\n")
        self.assertFalse(batch.ready(self.job))
        (self.job / "done.txt").write_text("exit 0\n")
        batch.snapshot(self.work, self.frozen, ["finished"])
        (self.frozen / "sheets/finished/output.png").write_bytes(b"changed")
        with self.assertRaisesRegex(ValueError, "immutable snapshot changed"):
            batch.compose(self.source, self.frozen, self.staged, argparse.Namespace(**inf.COMPOSE_DEFAULTS))
        self.assertFalse(self.staged.exists())

    def test_publish_matches_frames_across_pages_and_preserves_current_siblings(self):
        report = self.stage()
        self.assertTrue(report["frames"][f"{SPRITE}#0"]["accepted"])
        self.assertFalse(report["frames"][f"{SPRITE}#1"]["accepted"])
        source_bytes = (self.source.root / "library.json").read_bytes()
        current_bytes = (self.current.root / "library.json").read_bytes()
        before = self.current.page2(1).copy()
        evidence = batch.publish(self.source, self.staged, self.farm, "test", self.out, "batch1")
        target = inf.Library(self.farm / "_library/test")
        self.assertFalse(target.root.is_symlink())
        self.assertEqual(target.data["spriteAtlasesHd"][0], self.current.data["spriteAtlasesHd"][0])
        self.assertEqual(target.data["unrelated"], [False, 0, "preserve"])
        self.assertEqual(target.data["spriteAtlasesHd"][1]["sibling"], "retain")
        self.assertEqual(evidence["pages"]["1"]["frames"], [f"{SPRITE}#0"])
        touched = np.zeros(before.shape[:2], bool)
        touched[:4, 8:12] = True
        np.testing.assert_array_equal(target.page2(1)[~touched], before[~touched])
        self.assertEqual((self.source.root / "library.json").read_bytes(), source_bytes)
        self.assertEqual((self.current.root / "library.json").read_bytes(), current_bytes)
        with self.assertRaisesRegex(ValueError, "filename already exists"):
            batch.publish(self.source, self.staged, self.farm, "test", self.root / "retry", "batch1")

    def test_palette_or_candidate_tampering_fails_before_publication(self):
        self.stage()
        palette_path = self.current.root / "palette.png"
        pixels = np.array(Image.open(palette_path))
        pixels[0, 16] = [0, 255, 0]
        Image.fromarray(pixels).save(palette_path)
        with self.assertRaisesRegex(ValueError, "used opaque palette differ"):
            batch.publish(self.source, self.staged, self.farm, "test", self.out, "batch1")
        self.assertFalse(self.out.exists())
        pixels[0, 16] = [16, 16, 16]
        Image.fromarray(pixels).save(palette_path)
        (self.staged / "000000-color.png").write_bytes(b"tampered")
        with self.assertRaisesRegex(ValueError, "staged candidate changed"):
            batch.publish(self.source, self.staged, self.farm, "test", self.out, "batch1")

    def test_cas_detects_a_writer_entering_after_image_preparation(self):
        self.stage()
        original_patch = cache_farm.patch_json

        def competing_write(farm, relative, callback):
            def change(data):
                data["spriteAtlasesHd"][1]["sibling"] = "new sibling publication"
            original_patch(farm, relative, change)
            original_patch(farm, relative, callback)

        with mock.patch.object(cache_farm, "patch_json", side_effect=competing_write), \
                self.assertRaisesRegex(ValueError, "concurrent page change"):
            batch.publish(self.source, self.staged, self.farm, "test", self.out, "batch1")
        target = inf.Library(self.farm / "_library/test")
        self.assertEqual(target.data["spriteAtlasesHd"][1]["file"], "color.png")
        self.assertEqual(target.data["spriteAtlasesHd"][1]["sibling"], "new sibling publication")
        np.testing.assert_array_equal(target.page2(1), self.current.page2(1))
        self.assertFalse((target.root / "sprites-1@2x-batch1.png").exists())
        self.assertEqual(json.loads((self.out / "installed.json").read_text())["pages"]["1"]["status"],
                         "publication-failed")

    def test_same_filename_contender_cannot_replace_a_file_created_after_preflight(self):
        self.stage()
        original_patch = cache_farm.patch_json
        contender = self.root / "contender.png"
        Image.new("RGBA", (16, 16), (211, 43, 94, 255)).save(contender)

        def competing_write(farm, relative, callback):
            def reserve(data):
                cache_farm.install_file(farm, "_library/test/sprites-1@2x-batch1.png", contender)
            original_patch(farm, relative, reserve)
            original_patch(farm, relative, callback)

        with mock.patch.object(cache_farm, "patch_json", side_effect=competing_write), \
                self.assertRaisesRegex(ValueError, "filename already exists"):
            batch.publish(self.source, self.staged, self.farm, "test", self.out, "batch1")
        self.assertEqual((self.farm / "_library/test/sprites-1@2x-batch1.png").read_bytes(), contender.read_bytes())
        self.assertEqual(inf.Library(self.farm / "_library/test").data["spriteAtlasesHd"][1]["file"], "color.png")

    def test_source_and_farm_cannot_be_used_as_staging(self):
        with self.assertRaisesRegex(ValueError, "outside the worker"):
            batch.snapshot(self.work, self.work / "snapshot", ["finished"])
        self.stage()
        for farm in (self.source.root, self.root, self.staged):
            with self.subTest(farm=farm), self.assertRaisesRegex(ValueError, "farm must be separate"):
                batch.publish(self.source, self.staged, farm, "test", self.out, "batch1")
        for output in (self.source.root / "new", self.farm / "new", self.staged / "new"):
            with self.subTest(output=output), self.assertRaisesRegex(ValueError, "staging must be outside"):
                batch.publish(self.source, self.staged, self.farm, "test", output, "batch1")

    def test_normal_zero_alpha_allows_crop_change_and_rebind_preserves_png(self):
        self.stage()
        self.add_normals()
        before = (self.current.root / "normal.png").read_bytes()
        evidence = batch.publish(self.source, self.staged, self.farm, "test", self.out, "batch1")
        directory = self.farm / "_library/test"
        self.assertEqual((directory / "normal.png").read_bytes(), before)
        self.assertEqual(batch.normal_entry(directory, 1)["atlas"], "sprites-1@2x-batch1.png")
        self.assertEqual(evidence["pages"]["1"]["normal_reuse"]["support_pixels"], 4)
        self.assertEqual(evidence["pages"]["1"]["status"], "verified")

    def test_normal_nonzero_support_change_is_rejected_without_publishing(self):
        self.stage()
        self.add_normals(overlap=True)
        with self.assertRaisesRegex(ValueError, "intersects normal support"):
            batch.publish(self.source, self.staged, self.farm, "test", self.out, "batch1")
        target = inf.Library(self.farm / "_library/test")
        self.assertEqual(target.data["spriteAtlasesHd"][1]["file"], "color.png")
        self.assertFalse((target.root / "sprites-1@2x-batch1.png").exists())

    def test_stale_normal_binding_is_not_blindly_relabelled(self):
        self.stage()
        self.add_normals(stale=True)
        with self.assertRaisesRegex(ValueError, "normal atlas binding is stale"):
            batch.publish(self.source, self.staged, self.farm, "test", self.out, "batch1")
        self.assertEqual(batch.normal_entry(self.farm / "_library/test", 1)["atlas"], "stale.png")

    def test_normal_cas_failure_keeps_publication_journal(self):
        self.stage()
        self.add_normals()
        original_patch = cache_farm.patch_json

        def competing_write(farm, relative, callback):
            if relative.endswith("normals.json"):
                original_patch(farm, relative, lambda data: data["pages"]["1"].update(other_writer=True))
            original_patch(farm, relative, callback)

        with mock.patch.object(cache_farm, "patch_json", side_effect=competing_write), \
                self.assertRaisesRegex(ValueError, "concurrent normal change"):
            batch.publish(self.source, self.staged, self.farm, "test", self.out, "batch1")
        journal = json.loads((self.out / "installed.json").read_text())["pages"]["1"]
        self.assertEqual(journal["status"], "published-normal-bind-failed")
        self.assertEqual(inf.Library(self.farm / "_library/test").data["spriteAtlasesHd"][1]["file"],
                         "sprites-1@2x-batch1.png")
        self.assertEqual(batch.normal_entry(self.farm / "_library/test", 1)["atlas"], "color.png")

    def test_colour_change_before_normal_rebind_is_detected(self):
        self.stage()
        self.add_normals()
        original_patch = cache_farm.patch_json

        def competing_write(farm, relative, callback):
            if relative.endswith("normals.json"):
                original_patch(farm, "_library/test/library.json",
                               lambda data: data["spriteAtlasesHd"][1].update(file="color.png"))
            original_patch(farm, relative, callback)

        with mock.patch.object(cache_farm, "patch_json", side_effect=competing_write), \
                self.assertRaisesRegex(ValueError, "colour page changed before normal rebind"):
            batch.publish(self.source, self.staged, self.farm, "test", self.out, "batch1")
        self.assertEqual(batch.normal_entry(self.farm / "_library/test", 1)["atlas"], "color.png")

    def test_readback_failure_still_records_the_published_page(self):
        self.stage()
        real_library = inf.Library
        calls = []

        def fail_on_readback(root):
            calls.append(root)
            if len(calls) == 2:
                raise OSError("readback unavailable")
            return real_library(root)

        with mock.patch.object(inf, "Library", side_effect=fail_on_readback), \
                self.assertRaisesRegex(OSError, "readback unavailable"):
            batch.publish(self.source, self.staged, self.farm, "test", self.out, "batch1")
        journal = json.loads((self.out / "installed.json").read_text())["pages"]["1"]
        self.assertEqual(journal["status"], "published")
        self.assertEqual(journal["installed"][0], "sprites-1@2x-batch1.png")

    def test_disk_reserve_fails_before_served_image_write(self):
        self.stage()
        with mock.patch.object(batch.shutil, "disk_usage", return_value=argparse.Namespace(free=100)), \
                self.assertRaisesRegex(ValueError, "insufficient disk space"):
            batch.publish(self.source, self.staged, self.farm, "test", self.out, "batch1")
        self.assertFalse(self.out.exists())
        self.assertFalse((self.farm / "_library/test/sprites-1@2x-batch1.png").exists())


if __name__ == "__main__":
    unittest.main()
