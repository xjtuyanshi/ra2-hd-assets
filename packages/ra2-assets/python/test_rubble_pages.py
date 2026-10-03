"""Asset-free rubble atlas, registration and copy-on-write installation regressions."""
from __future__ import annotations

import contextlib
import copy
import io
import json
import math
from pathlib import Path
import shutil
import tempfile
import unittest
from unittest import mock

import cv2
import numpy as np
from PIL import Image

import cache_farm
import rubble_pages as rp


class RubblePagesTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="rubble-test-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.cache = self.root / "base"
        self.directory = self.cache / "_library" / "temperate"
        self.export = self.root / "export"
        self.build = self.root / "build"
        self.upscaled = self.root / "upscaled.png"
        self.types = self.root / "types.json"
        self.key = "building:TEST"
        self.palette = np.zeros((1, 256, 3), np.uint8)
        for index in range(256):
            self.palette[0, index] = ((index * 41 + 31) % 256, (index * 67 + 47) % 256,
                                      (index * 89 + 83) % 256)
        self.indices = np.zeros((12, 16), np.uint8)
        self.indices[2:10, 2:14] = 1
        self.indices[3:9, 4:8] = 2
        self.indices[4:8, 9:13] = 17
        self.indices[6, 6] = 0
        self.indices[8, 11] = 3
        self.library = self.fixture(self.indices)
        self.write_fixture()

    def fixture(self, indices):
        frames = [{"rect": [1 + index * 5, 1, 4, 4], "offset": [-2, -3], "page": 0}
                  for index in range(3)]
        frames.append({"rect": [7, 9, indices.shape[1], indices.shape[0]],
                       "offset": [-8, -5], "page": 1})
        return {"version": 1, "theater": "temperate", "palettes": {"iso": "palettes/iso.png"},
                "paletteSources": {"iso": "synthetic.pal"},
                "spriteAtlases": [{"file": f"sprites-{index}.png", "width": 64, "height": 64}
                                  for index in range(2)],
                "spriteAtlasesHd": [{"file": f"sprites-{index}@2x.png", "remap": f"paint-{index}.png",
                                     "scale": 2, "width": 128, "height": 128} for index in range(2)],
                "types": {"A1": {"kind": "building", "image": "TEST", "sprite": self.key,
                                  "atlasPages": [0, 1]},
                          "A2": {"kind": "building", "image": "TEST", "sprite": self.key},
                          "SHORT": {"kind": "building", "image": "SHORT", "sprite": "building:SHORT"},
                          "UNIT": {"kind": "infantry", "sprite": self.key}},
                "sprites": {self.key: {"palette": "unit", "remap": True, "frames": frames,
                                       "shadows": copy.deepcopy(frames)},
                            "building:SHORT": {"palette": "unit", "remap": False,
                                               "frames": copy.deepcopy(frames[:3]), "shadows": []}},
                "unrelated": {"keep": [False, 0, "unchanged"]}}

    def write_fixture(self):
        rp.save_image(self.directory, "palettes/iso.png", self.palette)
        for index in range(2):
            page = np.full((64, 64), 9 if index == 0 else 0, np.uint8)
            if index == 1:
                rp.crop(page, self.library["sprites"][self.key]["frames"][3]["rect"])[:] = self.indices
            rp.save_image(self.directory, f"sprites-{index}.png", page)
            # Existing HD art deliberately has the wrong colour; export must ignore it.
            wrong = np.full((128, 128, 4), [255, 0, 255, 255], np.uint8)
            rp.save_image(self.directory, f"sprites-{index}@2x.png", wrong)
            rp.save_image(self.directory, f"paint-{index}.png", np.full((128, 128), 255, np.uint8))
        rp.save_json(self.directory, "library.json", self.library)
        self.types.write_text(json.dumps(["MISSING", "SHORT", "UNIT", "A1", "A2", "A1"]), encoding="utf-8")

    def prepare_export(self):
        result = rp.export_pages(self.cache, "temperate", self.types, self.export)
        with Image.open(self.export / "rubble_grey_1x.png") as image:
            image.resize((image.width * 4, image.height * 4), Image.Resampling.NEAREST).save(self.upscaled)
        return result

    def prepare_build(self):
        self.prepare_export()
        return rp.build_pages(self.export, self.upscaled, self.build)

    def test_export_decodes_iso_indices_groups_types_and_preserves_offset(self):
        result = self.prepare_export()
        self.assertEqual(set(result["sprites"]), {self.key})
        frame = result["sprites"][self.key]
        self.assertEqual(frame["types"], ["A1", "A2"])
        self.assertEqual(frame["offset"], [-8, -5])
        self.assertEqual(frame["source"], {"page": 1, "rect": [7, 9, 16, 12]})
        self.assertEqual(result["page"], {"width": 2048, "height": 16})
        with Image.open(self.export / rp.PAGE) as image:
            self.assertEqual(image.mode, "L")
            indexed = np.array(image)
        np.testing.assert_array_equal(rp.crop(indexed, frame["rect"]), self.indices)
        self.assertFalse(indexed[0].any())
        self.assertFalse(indexed[:, 0].any())
        rgba = rp.read_image(self.export / "rubble_rgba_1x.png")
        grey = rp.read_image(self.export / "rubble_grey_1x.png")
        mask = indexed != 0
        np.testing.assert_array_equal(rgba[..., 3], mask.astype(np.uint8) * 255)
        np.testing.assert_array_equal(rgba[..., :3][mask], self.palette[0][indexed[mask]])
        np.testing.assert_array_equal(grey[mask], rgba[..., :3][mask])
        self.assertTrue(np.all(grey[~mask] == 118))
        self.assertEqual(rp.read_json(self.export / "rubble.json"), result)

    def test_export_shelf_wrap_has_transparent_gutters_and_skips_empty_frames(self):
        wide = np.full((7, 1200), 2, np.uint8)
        rp.save_image(self.directory, "wide.png", wide)
        self.library["spriteAtlases"].append({"file": "wide.png", "width": 1200, "height": 7})
        for name in ("WIDE1", "WIDE2", "EMPTY"):
            key = f"building:{name}"
            frames = copy.deepcopy(self.library["sprites"][self.key]["frames"])
            frames[3] = {"rect": [0, 0, 1200, 7] if name != "EMPTY" else [0, 0, 1, 1],
                         "page": 2 if name != "EMPTY" else 1, "offset": [3, -7]}
            self.library["sprites"][key] = {"frames": frames}
            self.library["types"][name] = {"kind": "building", "sprite": key}
        rp.save_json(self.directory, "library.json", self.library)
        self.types.write_text(json.dumps(["A1", "WIDE1", "WIDE2", "EMPTY"]), encoding="utf-8")
        result = self.prepare_export()
        self.assertNotIn("building:EMPTY", result["sprites"])
        r1, r2 = (result["sprites"][f"building:WIDE{i}"]["rect"] for i in (1, 2))
        self.assertGreater(r2[1], r1[1] + r1[3])
        self.assertEqual(result["page"]["height"] % 4, 0)
        page = rp.read_image(self.export / rp.PAGE)
        for key, frame in result["sprites"].items():
            x, y, w, h = frame["rect"]
            self.assertFalse(page[y - 1, x:x + w].any())
            self.assertFalse(page[y + h, x:x + w].any())
            self.assertFalse(page[y:y + h, x - 1].any())
            self.assertFalse(page[y:y + h, x + w].any())

    def test_build_keeps_palette_colours_and_limits_the_soft_alpha(self):
        result = self.prepare_build()
        frame = result["sprites"][self.key]
        indexed = rp.read_image(self.export / rp.PAGE)
        rgba = rp.read_image(self.build / rp.HD_PAGE)
        cell = rp.crop(rgba, frame["rect"], 2)
        known = (self.indices != 0).repeat(2, 0).repeat(2, 1)
        allowed = cv2.dilate((self.indices != 0).astype(np.uint8), np.ones((3, 3), np.uint8))
        allowed = allowed.repeat(2, 0).repeat(2, 1).astype(bool)
        self.assertTrue(np.all(cell[..., 3][~allowed] == 0))
        self.assertTrue(np.any((cell[..., 3] > 0) & (cell[..., 3] < 255)))
        expected = self.palette[0][self.indices].repeat(2, 0).repeat(2, 1)
        np.testing.assert_array_equal(cell[..., :3][known], expected[known])
        self.assertTrue(np.any(cell[..., 3][~known] > 0))
        fringe = (~known) & (cell[..., 3] > 0)
        self.assertFalse(np.any(np.all(cell[..., :3][fringe] == 118, axis=-1)))
        self.assertEqual((self.build / rp.PAGE).read_bytes(), (self.export / rp.PAGE).read_bytes())
        np.testing.assert_array_equal(rp.read_image(self.build / rp.REMAP), np.zeros(rgba.shape[:2], np.uint8))
        occupied = np.zeros(indexed.shape, bool)
        rp.crop(occupied, frame["rect"])[:] = True
        self.assertTrue(np.all(rgba[..., 3][~occupied.repeat(2, 0).repeat(2, 1)] == 0))
        self.assertFalse(frame["fallback"])
        self.assertEqual(frame["method"], "esrgan")

    def test_build_rejects_non_4x_upscale_without_outputs(self):
        self.prepare_export()
        rp.save_image(self.root, "bad.png", np.zeros((16, 2048, 3), np.uint8))
        with self.assertRaisesRegex(ValueError, "exactly 4x"):
            rp.build_pages(self.export, self.root / "bad.png", self.build)
        self.assertFalse(self.build.exists())

    def test_unmatte_recovers_grey_contaminated_edges(self):
        mask = np.zeros((9, 9), bool)
        mask[2:7, 2:7] = True
        original = np.full((9, 9, 3), [210, 65, 35], np.float32)
        known = mask.repeat(2, 0).repeat(2, 1)
        alpha = rp.alpha_2x(mask)
        rgb = np.where(known[..., None], original.repeat(2, 0).repeat(2, 1), rp.GREY)
        edge = known & (alpha < 1)
        # Linear-light matte mixtures are not collinear in sRGB; bleeding must handle both.
        rgb[edge] = rp.srgb(rp.linear(rgb[edge]) * 0.4 + rp.linear(rp.GREY) * 0.6)
        recovered = rp.unmatte(rgb, original, mask, alpha)
        np.testing.assert_allclose(recovered[alpha > 0],
                                   np.broadcast_to([210, 65, 35], recovered[alpha > 0].shape), atol=0.001)

    def test_downsample_averages_in_linear_light(self):
        rgb = np.zeros((4, 4, 3), np.float32)
        rgb[:, ::2] = 255
        expected = 255 * (1.055 * 0.5 ** (1 / 2.4) - 0.055)
        np.testing.assert_allclose(rp.downsample(rgb), expected, atol=0.001)

    def registration_fixture(self):
        # An asymmetric textured facade gives registration independent edges and luminance detail.
        indices = np.zeros((40, 48), np.uint8)
        indices[6:33, 7:38] = 1
        indices[8:12, 9:35] = 3
        for y in range(14, 31, 6):
            for x in range(10, 35, 7):
                indices[y:y + 3, x:x + 3] = 2
        indices[29:33, 32:38] = 17
        self.indices = indices
        self.palette[0, 1] = [207, 189, 158]
        self.palette[0, 2] = [36, 43, 63]
        self.palette[0, 3] = [150, 109, 80]
        self.palette[0, 17] = [180, 150, 98]
        self.library = self.fixture(indices)
        self.write_fixture()
        manifest = self.prepare_export()
        base4 = rp.crop(rp.load_upscaled(self.upscaled, rp.read_image(self.export / rp.PAGE)),
                        manifest["sprites"][self.key]["rect"], 4)
        return manifest, base4

    def test_redraw_registers_scale_1_1_and_shift_plus_6_minus_4_within_one_pixel(self):
        manifest, base4 = self.registration_fixture()
        h, w = base4.shape[:2]
        transform = np.array([[1.1, 0, 6], [0, 1.1, -4]], np.float32)
        moved = cv2.warpAffine(base4, transform, (w, h), flags=cv2.INTER_LINEAR,
                               borderMode=cv2.BORDER_CONSTANT, borderValue=(118, 118, 118))
        redraws = self.root / "redraws"
        # Exercise arbitrary model resolution as well as registration at native 4x size.
        moved = cv2.resize(moved, (w * 2, h * 2), interpolation=cv2.INTER_LINEAR)
        rp.save_image(redraws, rp.frame_name(self.key), rp.to_u8(moved))
        result = rp.build_pages(self.export, self.upscaled, self.build, redraws)
        frame = result["sprites"][self.key]
        self.assertFalse(frame["fallback"], frame)
        self.assertEqual(frame["method"], "redraw")
        self.assertGreater(frame["fit_score"], 0.95)
        sx, tx, sy, ty = frame["registration"]["params"]
        xs = np.array([0, w / 2, w - 1])
        ys = np.array([0, h / 2, h - 1])
        self.assertLess(np.max(np.abs(sx * xs + tx - (1.1 * xs + 6))), 1)
        self.assertLess(np.max(np.abs(sy * ys + ty - (1.1 * ys - 4))), 1)
        base_build = self.root / "faithful"
        rp.build_pages(self.export, self.upscaled, base_build)
        registered = rp.read_image(self.build / rp.HD_PAGE)
        faithful = rp.read_image(base_build / rp.HD_PAGE)
        np.testing.assert_array_equal(registered[..., 3], faithful[..., 3])
        self.assertEqual(rp.read_json(self.build / "frames.json"), result)

    def test_redraw_refuses_low_fit_and_out_of_range_scale_and_flags_fallback(self):
        _, base4 = self.registration_fixture()
        baseline = self.prepare_build()
        faithful = (self.build / rp.HD_PAGE).read_bytes()
        redraws = self.root / "redraws"
        rp.save_image(redraws, rp.frame_name(self.key), np.full_like(base4, 118, dtype=np.uint8))
        bad_fit = rp.build_pages(self.export, self.upscaled, self.build, redraws)
        frame = bad_fit["sprites"][self.key]
        self.assertTrue(frame["fallback"])
        self.assertEqual(frame["method"], "esrgan")
        self.assertIn("fit_score_below_0.5", frame["flags"])
        self.assertEqual((self.build / rp.HD_PAGE).read_bytes(), faithful)
        h, w = base4.shape[:2]
        scaled = cv2.warpAffine(base4, np.array([[1.3, 0, -16], [0, 1.3, -16]], np.float32), (w, h),
                                borderMode=cv2.BORDER_CONSTANT, borderValue=(118, 118, 118))
        rp.save_image(redraws, rp.frame_name(self.key), rp.to_u8(scaled))
        with mock.patch.object(rp.hybrid_redraw, "register", return_value=((1.3, -16, 1.3, -16), {})):
            bad_scale = rp.build_pages(self.export, self.upscaled, self.build, redraws)
        frame = bad_scale["sprites"][self.key]
        self.assertGreater(frame["fit_score"], 0.95)
        self.assertNotIn("fit_score_below_0.5", frame["flags"])
        self.assertIn("scale_out_of_range", frame["flags"])
        self.assertTrue(frame["fallback"])
        self.assertEqual((self.build / rp.HD_PAGE).read_bytes(), faithful)
        self.assertFalse(baseline["sprites"][self.key]["fallback"])

    def test_colour_lock_keeps_base_low_frequencies_and_redraw_detail(self):
        base = np.full((80, 96, 3), [171, 122, 81], np.float32)
        redraw = np.full_like(base, [80, 170, 195])
        redraw[::2] += 15
        redraw[1::2] -= 15
        locked = rp.colour_lock(base, redraw, 6)
        lab_base = cv2.cvtColor(base / 255, cv2.COLOR_RGB2LAB)
        lab_locked = cv2.cvtColor(locked / 255, cv2.COLOR_RGB2LAB)
        np.testing.assert_allclose(lab_locked[15:-15, 15:-15].mean(axis=(0, 1)),
                                   lab_base[15:-15, 15:-15].mean(axis=(0, 1)), atol=0.4)
        self.assertGreater(float(lab_locked[..., 0].std()), 2)

    def shared_palette_fixture(self):
        manifest, source4 = self.registration_fixture()
        source_export = self.root / 'source-export'
        source_upscaled = self.root / 'source-up4.png'
        shutil.copytree(self.export, source_export)
        shutil.copyfile(self.upscaled, source_upscaled)
        # Same indices/anchors, but the target palette reverses material brightness.
        self.palette[0, 1:] = 255 - self.palette[0, 1:]
        self.write_fixture()
        self.prepare_export()
        redraws = self.root / 'shared-redraws'
        rp.save_image(redraws, rp.frame_name(self.key), rp.to_u8(source4))
        references = self.root / 'references.json'
        rp.save_json(self.root, references.name, {self.key: {
            'export': source_export.name, 'upscaled': source_upscaled.name, 'key': self.key}})
        return manifest, redraws, references, source_export, source4

    def test_shared_indices_register_in_source_palette_then_lock_to_target(self):
        manifest, redraws, references, _, _ = self.shared_palette_fixture()
        wrong_palette = rp.build_pages(self.export, self.upscaled, self.build, redraws)
        self.assertIn('fit_score_below_0.5', wrong_palette['sprites'][self.key]['flags'])
        self.assertLess(wrong_palette['sprites'][self.key]['fit_score'], 0.5)
        target_indices = rp.read_image(self.export / rp.PAGE)
        target4 = rp.crop(rp.load_upscaled(self.upscaled, target_indices), manifest['sprites'][self.key]['rect'], 4)
        target_art = rp.crop(rp.read_image(self.export / 'rubble_rgba_1x.png'), manifest['sprites'][self.key]['rect'])[..., :3]
        target2 = rp.unmatte(rp.downsample(target4), target_art, self.indices != 0, rp.alpha_2x(self.indices != 0))
        with mock.patch.object(rp, 'colour_lock', wraps=rp.colour_lock) as colour_lock:
            result = rp.build_pages(self.export, self.upscaled, self.build, redraws, redraw_references=references)
        frame = result['sprites'][self.key]
        self.assertFalse(frame['fallback'], frame)
        self.assertGreater(frame['fit_score'], 0.95)
        self.assertEqual(frame['method'], 'redraw')
        self.assertEqual(frame['registration']['reference']['mode'], 'identical_indices_source')
        self.assertLess(frame['registration']['target_fit_before_colour_lock'], 0.5)
        np.testing.assert_array_equal(colour_lock.call_args.args[0], target2)
        output = rp.crop(rp.read_image(self.build / rp.HD_PAGE), manifest['sprites'][self.key]['rect'], 2)
        np.testing.assert_array_equal(output[..., 3], rp.to_u8(rp.alpha_2x(self.indices != 0) * 255))
        self.assertEqual(rp.read_json(self.build / 'frames.json'), result)

    def test_shared_reference_refuses_changed_indices_offsets_and_size(self):
        _, redraws, references, source_export, _ = self.shared_palette_fixture()
        source_manifest = rp.read_json(source_export / 'rubble.json')
        source_page = rp.read_image(source_export / rp.PAGE)
        for change in ('indices', 'offset', 'size'):
            with self.subTest(change=change):
                changed_manifest = copy.deepcopy(source_manifest)
                changed_page = source_page.copy()
                if change == 'indices':
                    frame = changed_manifest['sprites'][self.key]
                    rp.crop(changed_page, frame['rect'])[8, 9] = 99
                elif change == 'offset':
                    changed_manifest['sprites'][self.key]['offset'][0] += 1
                else:
                    changed_manifest['sprites'][self.key]['rect'][2] -= 1
                rp.save_image(source_export, rp.PAGE, changed_page)
                rp.save_json(source_export, 'rubble.json', changed_manifest)
                result = rp.build_pages(self.export, self.upscaled, self.build, redraws, redraw_references=references)
                frame = result['sprites'][self.key]
                self.assertEqual(frame['method'], 'esrgan')
                self.assertTrue(frame['fallback'])
                self.assertEqual(frame['flags'], ['registration_failed'])
                self.assertIn('geometry differs', frame['error'])

    def test_shared_reference_keeps_fit_and_scale_rejection_gates(self):
        _, redraws, references, _, source4 = self.shared_palette_fixture()
        rp.save_image(redraws, rp.frame_name(self.key), np.full_like(source4, 118, dtype=np.uint8))
        result = rp.build_pages(self.export, self.upscaled, self.build, redraws, redraw_references=references)
        self.assertIn('fit_score_below_0.5', result['sprites'][self.key]['flags'])
        self.assertTrue(result['sprites'][self.key]['fallback'])
        h, w = source4.shape[:2]
        scaled = cv2.warpAffine(source4, np.array([[1.3, 0, -16], [0, 1.3, -16]], np.float32), (w, h),
                                borderMode=cv2.BORDER_CONSTANT, borderValue=(118, 118, 118))
        rp.save_image(redraws, rp.frame_name(self.key), rp.to_u8(scaled))
        with mock.patch.object(rp.hybrid_redraw, 'register', return_value=((1.3, -16, 1.3, -16), {})):
            result = rp.build_pages(self.export, self.upscaled, self.build, redraws, redraw_references=references)
        frame = result['sprites'][self.key]
        self.assertGreater(frame['fit_score'], 0.95)
        self.assertIn('scale_out_of_range', frame['flags'])
        self.assertTrue(frame['fallback'])

    def test_shared_reference_wrong_upscale_size_falls_back(self):
        _, redraws, references, _, _ = self.shared_palette_fixture()
        rp.save_image(self.root, 'source-up4.png', np.full((8, 8, 3), 118, np.uint8))
        result = rp.build_pages(self.export, self.upscaled, self.build, redraws, redraw_references=references)
        frame = result['sprites'][self.key]
        self.assertTrue(frame['fallback'])
        self.assertEqual(frame['flags'], ['registration_failed'])
        self.assertIn('must be exactly 4x', frame['error'])

    def test_build_cli_accepts_relative_source_reference_mapping(self):
        _, redraws, references, _, _ = self.shared_palette_fixture()
        with contextlib.redirect_stdout(io.StringIO()):
            rp.main(['build', '--export', str(self.export), '--upscaled', str(self.upscaled),
                     '--out', str(self.build), '--redraw-dir', str(redraws),
                     '--redraw-references', str(references)])
        frame = rp.read_json(self.build / 'frames.json')['sprites'][self.key]
        self.assertFalse(frame['fallback'])
        self.assertEqual(frame['registration']['reference']['key'], self.key)

    def readonly_base(self):
        files = [path for path in self.cache.rglob("*") if path.is_file()]
        directories = [self.cache, *(path for path in self.cache.rglob("*") if path.is_dir())]
        snapshot = {path.relative_to(self.cache): path.read_bytes() for path in files}
        for path in files:
            path.chmod(0o444)
        for path in directories:
            path.chmod(0o555)

        def restore():
            for path in directories:
                path.chmod(0o755)
            for path in files:
                path.chmod(0o644)

        self.addCleanup(restore)
        return snapshot

    def assert_library_patch(self, before, after, manifest, page):
        expected = copy.deepcopy(before)
        width, height = manifest["page"]["width"], manifest["page"]["height"]
        expected["spriteAtlases"].append({"file": rp.PAGE, "width": width, "height": height})
        hd = expected.setdefault("spriteAtlasesHd", [])
        while len(hd) < page:
            hd.append(None)
        hd.append({"file": rp.HD_PAGE, "remap": rp.REMAP, "scale": 2, "width": width * 2, "height": height * 2})
        frame = manifest["sprites"][self.key]
        expected["sprites"][self.key]["frames"][3] = {"rect": frame["rect"], "offset": frame["offset"], "page": page}
        self.assertEqual(after, expected)

    def test_install_replaces_readonly_base_symlinks_and_is_idempotent(self):
        manifest = self.prepare_build()
        # Include existing rubble-named files to catch any write-through of page symlinks.
        for name in (rp.PAGE, rp.HD_PAGE, rp.REMAP):
            cache_farm.install_file(self.directory, name, self.build / name)
        snapshot = self.readonly_base()
        farm = self.root / "farm"
        destination = farm / "_library" / "temperate"
        destination.mkdir(parents=True)
        for source in self.directory.iterdir():
            (destination / source.name).symlink_to(source)
        with mock.patch.object(cache_farm, "install_file", wraps=cache_farm.install_file) as installing, \
                mock.patch.object(cache_farm, "patch_json", wraps=cache_farm.patch_json) as patching:
            page = rp.install_pages(self.build, farm, "temperate")
            self.assertEqual(installing.call_count, 3)
            self.assertEqual(patching.call_count, 1)
        self.assertEqual(page, 2)
        self.assertFalse((destination / "library.json").is_symlink())
        first_bytes = (destination / "library.json").read_bytes()
        self.assert_library_patch(self.library, rp.read_json(destination / "library.json"), manifest, page)
        for name in (rp.PAGE, rp.HD_PAGE, rp.REMAP):
            self.assertFalse((destination / name).is_symlink())
            self.assertEqual((destination / name).read_bytes(), (self.build / name).read_bytes())
        self.assertEqual(rp.install_pages(self.build, farm, "temperate"), page)
        self.assertEqual((destination / "library.json").read_bytes(), first_bytes)
        self.assertTrue((destination / "sprites-0.png").is_symlink())
        self.assertEqual({path: (self.cache / path).read_bytes() for path in snapshot}, snapshot)

    def test_install_realises_theatre_directory_and_pads_missing_hd_slots(self):
        manifest = self.prepare_build()
        self.library.pop("spriteAtlasesHd")
        rp.save_json(self.directory, "library.json", self.library)
        snapshot = self.readonly_base()
        farm = self.root / "directory-farm"
        (farm / "_library").mkdir(parents=True)
        destination = farm / "_library" / "temperate"
        destination.symlink_to(self.directory)
        page = rp.install_pages(self.build, farm, "temperate")
        self.assertFalse(destination.is_symlink())
        after = rp.read_json(destination / "library.json")
        self.assertEqual(after["spriteAtlasesHd"][:page], [None, None])
        self.assert_library_patch(self.library, after, manifest, page)
        self.assertEqual({path: (self.cache / path).read_bytes() for path in snapshot}, snapshot)

    def test_rebuilding_installed_hardlinks_does_not_modify_the_cache(self):
        self.prepare_build()
        farm = self.root / "farm"
        destination = farm / "_library" / "temperate"
        rp.save_json(destination, "library.json", self.library)
        rp.install_pages(self.build, farm, "temperate")
        before = (destination / rp.HD_PAGE).read_bytes()
        upscale = rp.read_image(self.upscaled, "RGB")
        upscale[upscale[..., 0] != 118] = [20, 200, 50]
        rp.save_image(self.root, "upscaled.png", upscale)
        rp.build_pages(self.export, self.upscaled, self.build)
        self.assertNotEqual((self.build / rp.HD_PAGE).read_bytes(), before)
        self.assertEqual((destination / rp.HD_PAGE).read_bytes(), before)

    def test_sheet_slice_roundtrip_uses_placed_boxes_padding_and_actual_output_size(self):
        self.prepare_export()
        manifest = rp.read_json(self.export / "rubble.json")
        # A second synthetic key reuses the same art; ordering is deliberately reversed.
        other = "building:SECOND"
        manifest["sprites"][other] = copy.deepcopy(manifest["sprites"][self.key])
        rp.save_json(self.export, "rubble.json", manifest)
        sheet = self.root / "sheet"
        layout = rp.make_sheet(self.export, self.upscaled, [other, self.key], 2, (120, 100), sheet)
        self.assertEqual(layout["size"], [240, 100])
        self.assertEqual([entry["key"] for entry in layout["sprites"]], [other, self.key])
        pixels = rp.read_image(sheet / "input.png")
        for entry in layout["sprites"]:
            x, y, w, h = entry["placed"]
            cx, cy, cw, ch = entry["cell"]
            self.assertGreaterEqual(x - cx, cw * 0.08 - 1)
            self.assertGreaterEqual(y - cy, ch * 0.08 - 1)
            self.assertLess(abs(w / h - 16 / 12), 0.03)
            self.assertTrue(np.all(pixels[cy, cx:cx + cw] == 118))
        # The model may return another resolution and aspect ratio.
        output = cv2.resize(pixels, (720, 200), interpolation=cv2.INTER_NEAREST)
        rp.save_image(sheet, "output.png", output)
        redraws = self.root / "sliced"
        results = rp.slice_sheet(sheet / "output.png", sheet / "layout.json", redraws)
        self.assertEqual([path.name for path in results], ["building_SECOND.png", "building_TEST.png"])
        for entry, path in zip(layout["sprites"], results):
            x, y, w, h = entry["placed"]
            left, top = math.floor((x - w * 0.04) * 3), math.floor((y - h * 0.04) * 2)
            right, bottom = math.ceil((x + w * 1.04) * 3), math.ceil((y + h * 1.04) * 2)
            np.testing.assert_array_equal(rp.read_image(path), output[top:bottom, left:right])

    def test_all_five_cli_commands_have_explicit_paths_and_print_one_line(self):
        commands = [
            ["export", "--cache-root", str(self.cache), "--theatre", "temperate", "--types", str(self.types),
             "--out", str(self.export)],
            ["build", "--export", str(self.export), "--upscaled", str(self.upscaled), "--out", str(self.build)],
            ["install", "--build", str(self.build), "--cache-root", str(self.cache), "--theatre", "temperate"],
            ["sheet", "--export", str(self.export), "--upscaled", str(self.upscaled), "--keys", self.key,
             "--cols", "1", "--cell", "120x100", "--out", str(self.root / "sheet")],
            ["slice", "--sheet", str(self.root / "sheet/input.png"), "--layout", str(self.root / "sheet/layout.json"),
             "--out", str(self.root / "redraws")],
        ]
        for index, command in enumerate(commands):
            with self.subTest(command=command[0]), contextlib.redirect_stdout(io.StringIO()) as output:
                rp.main(command)
                self.assertEqual(len(output.getvalue().splitlines()), 1)
            if index == 0:
                with Image.open(self.export / "rubble_grey_1x.png") as image:
                    image.resize((image.width * 4, image.height * 4), Image.Resampling.NEAREST).save(self.upscaled)
        self.assertTrue((self.root / "redraws/building_TEST.png").is_file())


class RubbleGroupingTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="rubble-groups-test-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.indices = np.array([[0, 2, 3], [4, 0, 5]], np.uint8)
        self.offset = [-3, 2]

    def export(self, theatre, entries, nested=False):
        root = self.root / theatre
        directory = root / "export" if nested else root
        width = max(pixels.shape[1] for _, pixels, _ in entries) + 2
        height = sum(pixels.shape[0] + 1 for _, pixels, _ in entries) + 1
        indexed = np.zeros((height, width), np.uint8)
        manifest = {"theatre": theatre, "page": {"width": width, "height": height}, "sprites": {}}
        y = 1
        for key, pixels, offset in entries:
            h, w = pixels.shape
            indexed[y:y + h, 1:1 + w] = pixels
            manifest["sprites"][key] = {"rect": [1, y, w, h], "offset": offset}
            y += h + 1
        rp.save_image(directory, rp.PAGE, indexed)
        rp.save_json(directory, "rubble.json", manifest)
        return root

    def groups_fixture(self):
        temperate = self.export("temperate", [("building:TEST", self.indices, self.offset)], nested=True)
        changed = self.indices.copy()
        changed[0, 1] = 9
        urban = self.export("urban", [
            ("building:TEST", changed, self.offset),
            ("building:MATCH", self.indices, self.offset),
            ("building:RESHAPED", self.indices.reshape(3, 2), self.offset),
            ("building:SHIFTED", self.indices, [-2, 2]),
        ])
        result = rp.group_exports({"temperate": temperate, "urban": urban})
        path = self.root / "groups.json"
        rp.save_json(path.parent, path.name, result)
        return result, path, temperate, urban

    def test_groups_match_indices_size_and_offset_across_direct_and_nested_exports(self):
        result, _, _, _ = self.groups_fixture()
        groups = list(result["groups"].values())
        self.assertEqual(len(groups), 4)
        matched = next(group for group in groups if len(group["members"]) == 2)
        self.assertEqual(matched, {"members": [["temperate", "building:TEST"], ["urban", "building:MATCH"]],
                                   "area": 4, "size": [3, 2]})
        members = [tuple(member) for group in groups for member in group["members"]]
        self.assertEqual(len(members), 5)
        self.assertEqual(len(set(members)), 5)
        self.assertTrue(all(len(group_id) == 16 for group_id in result["groups"]))

    def test_distribute_selects_theatre_and_key_and_makes_independent_byte_copies(self):
        _, groups, _, _ = self.groups_fixture()
        redraw = self.root / "redraw.png"
        Image.fromarray(np.full((6, 7, 3), [22, 111, 209], np.uint8)).save(redraw)
        original = redraw.read_bytes()
        output = self.root / "redraws"
        paths = rp.distribute_redraw(groups, redraw, "building:TEST", "temperate", output)
        self.assertEqual(paths, [output / "temperate/building_TEST.png", output / "urban/building_MATCH.png"])
        self.assertTrue(all(path.read_bytes() == original for path in paths))
        self.assertFalse((output / "urban/building_TEST.png").exists())
        redraw.write_bytes(b"source changed")
        self.assertTrue(all(path.read_bytes() == original for path in paths))
        paths[0].write_bytes(b"one member changed")
        self.assertEqual(paths[1].read_bytes(), original)

    def test_distribute_rejects_missing_or_ambiguous_selection_before_writing(self):
        result, groups, _, _ = self.groups_fixture()
        output = self.root / "redraws"
        for theatre, key in (("snow", "building:TEST"), ("urban", "building:UNKNOWN")):
            with self.subTest(theatre=theatre, key=key), self.assertRaisesRegex(ValueError, "expected one group"):
                rp.distribute_redraw(groups, self.root / "unused.png", key, theatre, output)
        result["groups"]["duplicate"] = {"members": [["temperate", "building:TEST"]]}
        rp.save_json(groups.parent, groups.name, result)
        with self.assertRaisesRegex(ValueError, "found 2"):
            rp.distribute_redraw(groups, self.root / "unused.png", "building:TEST", "temperate", output)
        self.assertFalse(output.exists())

    def test_distribute_validates_all_destination_components_before_writing(self):
        result, groups, _, _ = self.groups_fixture()
        group = next(group for group in result["groups"].values() if len(group["members"]) == 2)
        group["members"].append(["../escape", "building:TEST"])
        rp.save_json(groups.parent, groups.name, result)
        output = self.root / "redraws"
        with self.assertRaisesRegex(ValueError, "invalid path component"):
            rp.distribute_redraw(groups, self.root / "unused.png", "building:TEST", "temperate", output)
        self.assertFalse(output.exists())

    def test_group_and_distribute_cli_accept_multiple_and_repeated_export_options(self):
        expected, _, temperate, urban = self.groups_fixture()
        output = self.root / "cli/groups.json"
        for exports in (["--export", f"temperate={temperate}", f"urban={urban}"],
                        ["--export", f"temperate={temperate}", "--export", f"urban={urban}"]):
            with self.subTest(exports=exports), contextlib.redirect_stdout(io.StringIO()) as stdout:
                rp.main(["groups", *exports, "--out", str(output)])
                self.assertEqual(len(stdout.getvalue().splitlines()), 1)
                self.assertEqual(rp.read_json(output), expected)
        redraw = self.root / "redraw.png"
        Image.fromarray(np.full((3, 4, 3), 92, np.uint8)).save(redraw)
        with contextlib.redirect_stdout(io.StringIO()) as stdout:
            rp.main(["distribute", "--groups", str(output), "--redraw", str(redraw),
                     "--key", "building:TEST", "--theatre", "urban", "--out-root", str(self.root / "cli")])
            self.assertEqual(len(stdout.getvalue().splitlines()), 1)
        self.assertEqual((self.root / "cli/urban/building_TEST.png").read_bytes(), redraw.read_bytes())
        self.assertFalse((self.root / "cli/temperate").exists())


if __name__ == "__main__":
    unittest.main()
