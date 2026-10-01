"""Asset-free rubble atlas, registration and copy-on-write installation regressions."""
from __future__ import annotations

import contextlib
import copy
import io
import json
import math
from pathlib import Path
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


if __name__ == "__main__":
    unittest.main()
