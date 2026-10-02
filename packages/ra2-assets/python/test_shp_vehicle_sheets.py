"""Asset-free SHP redraw regression: numpy/Pillow and the imported CPU image helpers only."""

from collections import Counter
import contextlib
import copy
import io
import json
from pathlib import Path
import shutil
import tempfile
import unittest
from unittest import mock

import numpy as np
from PIL import Image

import infantry_sheets as inf
import shp_vehicle_sheets as veh

SPRITE = "vehicle:DRON"
THEATER = "urban"


def image(path, mode=None):
    with Image.open(path) as im:
        return np.array(im.convert(mode) if mode else im)


def synthetic_library(cache):
    """88 bodies on two pages, separate shadow cards and unrelated art on both shared pages."""
    root = cache / "_library" / THEATER
    root.mkdir(parents=True)
    (cache / "_library" / "snow").mkdir()
    (cache / "_library" / "common").mkdir()
    (cache / "XMP29U2").mkdir()
    (cache / "XMP29U2" / "manifest.json").write_text('{"synthetic": true}')
    indices = [np.zeros((312, 192), np.uint8) for _ in range(2)]
    palette = np.full((256, 3), 118, np.uint8)
    palette[40], palette[41], palette[12] = (72, 83, 89), (172, 184, 187), (0, 0, 0)
    ramp = np.array([[245 - i * 14, 24 - i, 24 - i] for i in range(16)], np.uint8)
    palette[16:32] = ramp
    frames, shadows = [], []
    for i in range(88):
        p, slot = divmod(i, 48)
        x, y = slot % 8 * 24 + 3, slot // 8 * 26 + 2
        idx = indices[p][y:y + 22, x:x + 18]
        idx[5:15, 5:13] = 40
        idx[6:12, 6:12] = 20 + i % 6
        idx[8:10, 2:16] = 41
        idx[3:18, 3:5] = 40
        idx[3:18, 13:15] = 40
        idx[16:19, 1:6] = 41
        idx[16:19, 12:17] = 41
        f = {"rect": [x, y, 18, 22], "offset": [-8 + i % 3, -17 + i % 2], "page": p}
        frames.append(f)
        shadow_y = y + 156
        indices[p][shadow_y + 10:shadow_y + 13, x + 3:x + 15] = 12
        shadows.append(dict(f, rect=[x, shadow_y, 18, 22]))
    data = {
        "version": 1, "theater": THEATER, "palettes": {"unit": "palette.png"},
        "colorSchemes": [{"remap": ramp.tolist()}], "colorSchemesByName": {"DarkRed": 0},
        "spriteAtlases": [], "spriteAtlasesHd": [],
        "sprites": {SPRITE: {"palette": "unit", "frames": frames, "shadows": shadows, "frameCount": 176}},
        "types": {"DRON": {"sprite": SPRITE, "shpUnit": {"facings": 8, "frames": {"WalkFrames": 6, "FiringFrames": 4}}}},
        "unrelated": {"keep": [0, "test", False]},
    }
    for p, idx in enumerate(indices):
        idx[0:2, 0:2] = 41
        colour = np.zeros((624, 384, 4), np.uint8)
        colour[..., :3] = np.repeat(np.repeat(palette[idx], 2, 0), 2, 1)
        colour[..., 3] = np.repeat(np.repeat((idx > 0).astype(np.uint8) * 255, 2, 0), 2, 1)
        paint = np.repeat(np.repeat(((idx >= 16) & (idx <= 31)).astype(np.uint8) * 255, 2, 0), 2, 1)
        grey = np.repeat(np.repeat(255 - 15 * (idx.astype(np.int32) - 16), 2, 0), 2, 1)
        colour[..., :3][paint > 0] = grey[paint > 0, None]
        for f in (f for f in frames if f["page"] == p):
            x, y, _, _ = f["rect"]
            colour[2 * y + 5, 2 * x + 6] = (72, 83, 89, 73)  # HD antialiased rim, outside indexed coverage
        for filename, pixels in ((f"index-{p}.png", idx), (f"colour-{p}.png", colour), (f"paint-{p}.png", paint)):
            Image.fromarray(pixels).save(root / filename)
        data["spriteAtlases"].append({"file": f"index-{p}.png", "width": 192, "height": 312})
        data["spriteAtlasesHd"].append({"file": f"colour-{p}.png", "remap": f"paint-{p}.png", "scale": 2,
                                        "width": 384, "height": 624, "keep": "metadata"})
    Image.fromarray(palette[None]).save(root / "palette.png")
    (root / "library.json").write_text(json.dumps(data))
    return data


def cli(command, cache, work, *extra):
    with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
        return veh.main([command, "--library", str(cache), "--theater", THEATER, "--work", str(work), *extra])


class LayoutTests(unittest.TestCase):
    def test_layout_matches_the_same_fixtures_executed_by_typescript(self):
        path = Path(__file__).parents[2] / "hd-renderer/tests/fixtures/shpUnitLayouts.json"
        for fixture in json.loads(path.read_text()):
            with self.subTest(fixture=fixture["name"]):
                self.assertEqual(veh.shp_unit_blocks(fixture["unit"]), fixture["blocks"])
        self.assertEqual(veh.shp_unit_blocks({"frames": {"WalkFrames": None, "StandingFrames": None}}),
                         {"facings": 8, "walk": {"start": 0, "count": 0},
                          "stand": {"start": 0, "count": 1}, "fire": {"start": 8, "count": 0}})

    def test_body_mapping_excludes_shadows_and_splits_steps_before_facings(self):
        with tempfile.TemporaryDirectory() as temp:
            cache = Path(temp) / "cache"
            synthetic_library(cache)
            lib = inf.Library(cache / "_library" / THEATER)
            blocks = dict(veh.blocks(lib, "DRON"))
            self.assertEqual(blocks["Walk"], [list(range(f * 6, f * 6 + 6)) for f in range(8)])
            self.assertEqual(blocks["Stand"], [[48 + f] for f in range(8)])
            self.assertEqual(blocks["Fire"], [list(range(56 + f * 4, 60 + f * 4)) for f in range(8)])
            specs = veh.sheet_specs(lib, "DRON")
            self.assertEqual(len(specs), 3)
            # Wide cells force step-range splitting while eight facing rows still fit at 4x.
            for frame in lib.frames(SPRITE):
                frame["rect"][2] = 80
            specs = veh.sheet_specs(lib, "DRON")
            walk = [s for s in specs if s["seq"] == "Walk"]
            self.assertGreater(len(walk), 1)
            self.assertTrue(all(s["facings"] == list(range(8)) for s in walk))
            self.assertEqual(Counter(i for s in specs for r in s["rows"] for i in r), Counter(range(88)))
            for s in specs:
                lay = inf.layout(lib, SPRITE, s["rows"])
                self.assertGreaterEqual(inf.choose_scale(lay["W"], lay["H"]), 4)
            for frame in lib.frames(SPRITE):
                frame["rect"][3] = 100
            specs = veh.sheet_specs(lib, "DRON")
            self.assertTrue(any(len(s["facings"]) < 8 for s in specs))
            self.assertEqual(Counter(i for s in specs for r in s["rows"] for i in r), Counter(range(88)))


class PromptProfileTests(unittest.TestCase):
    def test_sea_creatures_use_organic_profiles_and_every_sequence_is_described(self):
        spec = {"seq": "Fire", "rows": [[0, 1]], "facings": [0], "steps": [0, 2]}
        for unit, terms in {"DLPH": ("dolphin", "wet dolphin skin", "flukes"),
                            "SQD": ("squid", "suckers", "tentacle")}.items():
            with self.subTest(unit=unit):
                prompt = veh.prompt_for(unit, spec, (1024, 1536), 8)
                for term in terms + ("(118,118,118)", "CLOCKWISE"):
                    self.assertIn(term, prompt)
                self.assertNotIn("dark steel", prompt)
                self.assertNotIn("spider", prompt)
                self.assertEqual(set(veh.PROFILES[unit]["sequences"]), set(veh.SEQUENCES))
        self.assertEqual(set(veh.UNITS), set(veh.HOUSE))


class PipelineTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory(prefix="shp-vehicle-test-")
        cls.addClassCleanup(cls.temp.cleanup)
        cls.root = Path(cls.temp.name)
        cls.cache, cls.work = cls.root / "cache", cls.root / "work"
        cls.data = synthetic_library(cls.cache)
        cls.lib = inf.Library(cls.cache / "_library" / THEATER)
        cls.source = {str(p.relative_to(cls.cache)): p.read_bytes() for p in cls.cache.rglob('*') if p.is_file()}
        cli("prepare", cls.cache, cls.work, "--units", "DRON")
        for d in (cls.work / "sheets").iterdir():
            shutil.copyfile(d / "input.png", d / "output.png")
            # A stale full.png must never override the required output.png contract.
            Image.new("RGB", (1536, 1024), (118, 118, 118)).save(d / "full.png")
        cls.composed = []
        original = veh.compose_job

        def capture(*args, **kwargs):
            result = original(*args, **kwargs)
            cls.composed.append(result)
            return result

        with mock.patch.object(veh, "compose_job", side_effect=capture):
            cli("compose", cls.cache, cls.work)
        cli("build", cls.cache, cls.work)

    def test_native_sheets_prompt_coverage_and_compose_roundtrip(self):
        frames = []
        for result in self.composed:
            job = result["job"]
            d = self.work / "sheets" / job["name"]
            self.assertEqual(result["raw"], "output.png")
            self.assertGreaterEqual(job["S"], 4)
            self.assertIn(job["size"], ([1536, 1024], [1024, 1536]))
            self.assertEqual(job["facings"], list(range(8)))
            prompt = (d / "prompt.txt").read_text()
            for term in ("four-legged", "round armoured body", "DarkRed", "(118,118,118)", "CLOCKWISE", "realistic modern"):
                self.assertIn(term, prompt)
            np.testing.assert_array_equal(image(d / "input.png")[0, 0], [118, 118, 118])
            self.assertTrue((d / "review.png").is_file())
            self.assertEqual(len(json.loads((d / "metrics.json").read_text())), len(result["frames"]))
            for i, r in result["frames"].items():
                frames.append(i)
                old, alpha, mask = self.lib.frame2(SPRITE, i, "DarkRed")
                self.assertEqual(r["rgba"].shape, (*alpha.shape, 4))
                self.assertTrue(np.all(r["rgba"][..., 3] <= alpha))
                self.assertGreater(r["metrics"]["sil_iou"], 0.9)
                self.assertGreater(r["paint"].max(), 200)
                decoded = self.lib.decode_hd(r["rgba"], r["paint"], "DarkRed")
                inner = (mask > 0) & (r["paint"] > 200)
                self.assertGreater(decoded[inner, 0].mean(), decoded[inner, 1].mean() * 2)
                self.assertLess(np.abs(decoded[alpha == 255] - old[alpha == 255]).mean(), 30)
        self.assertEqual(Counter(frames), Counter(range(88)))

    def assert_source_unchanged(self):
        self.assertEqual({str(p.relative_to(self.cache)): p.read_bytes()
                          for p in self.cache.rglob('*') if p.is_file()}, self.source)

    def test_build_preserves_every_pixel_outside_body_rectangles(self):
        report = json.loads((self.work / "pages/build.json").read_text())
        self.assertEqual(set(report["pages"]), {"0", "1"})
        self.assertEqual((report["accepted"], report["rejected"]), (88, 0))
        for page, files in report["pages"].items():
            p = int(page)
            selected = np.zeros(self.lib.remap2(p).shape, bool)
            for frame in (f for f in self.data["sprites"][SPRITE]["frames"] if f["page"] == p):
                x, y, w, h = frame["rect"]
                selected[2*y:2*(y+h), 2*x:2*(x+w)] = True
            np.testing.assert_array_equal(image(self.work / "pages" / files["file"])[~selected], self.lib.page2(p)[~selected])
            np.testing.assert_array_equal(image(self.work / "pages" / files["remap"])[~selected], self.lib.remap2(p)[~selected])
        self.assert_source_unchanged()

    def test_install_detaches_only_needed_components_and_is_repeatable(self):
        for kind in ("library-link", "root-link", "new-root"):
            with self.subTest(kind=kind):
                variant = self.root / kind
                if kind == "root-link":
                    variant.symlink_to(self.cache)
                elif kind == "library-link":
                    variant.mkdir()
                    (variant / "_library").symlink_to(self.cache / "_library")
                for _ in range(2):
                    self.assertEqual(cli("install", self.cache, self.work, "--variant-root", str(variant)), 0)
                libdir = variant / "_library" / THEATER
                for path in (variant, variant / "_library", libdir, libdir / "library.json"):
                    self.assertFalse(path.is_symlink())
                for path in (variant / "XMP29U2", variant / "_library/snow", variant / "_library/common", libdir / "palette.png"):
                    self.assertTrue(path.is_symlink())
                merged = json.loads((libdir / "library.json").read_text())
                expected = copy.deepcopy(self.data)
                for p in range(2):
                    expected["spriteAtlasesHd"][p].update(file=f"sprites-{p}@2x-l3veh.png", remap=f"sprites-{p}@2x-remap-l3veh.png")
                self.assertEqual(merged, expected)
                self.assert_source_unchanged()

    def test_install_keeps_existing_manifest_and_other_art_on_shared_page(self):
        variant = self.root / "existing"
        libdir = variant / "_library" / THEATER
        libdir.mkdir(parents=True)
        for f in self.lib.root.iterdir():
            (libdir / f.name).symlink_to(f)
        merged = copy.deepcopy(self.data)
        merged["unrelated"]["variant"] = True
        colour = self.lib.page2(0).copy()
        colour[0:4, 0:4] = (1, 2, 3, 4)
        Image.fromarray(colour).save(libdir / "other-track.png")
        paint = self.lib.remap2(0).copy()
        paint[0:4, 0:4] = 127
        Image.fromarray(paint).save(libdir / "other-paint.png")
        merged["spriteAtlasesHd"][0].update(file="other-track.png", remap="other-paint.png")
        (libdir / "library.json").unlink()
        (libdir / "library.json").write_text(json.dumps(merged))
        # Existing output filenames may themselves point into the source; atomic replace must break these links.
        (libdir / "sprites-0@2x-l3veh.png").symlink_to(self.lib.root / "colour-0.png")
        cli("install", self.cache, self.work, "--variant-root", str(variant))
        installed = json.loads((libdir / "library.json").read_text())
        self.assertTrue(installed["unrelated"]["variant"])
        np.testing.assert_array_equal(image(libdir / installed["spriteAtlasesHd"][0]["file"])[0:4, 0:4], colour[0:4, 0:4])
        np.testing.assert_array_equal(image(libdir / installed["spriteAtlasesHd"][0]["remap"])[0:4, 0:4], paint[0:4, 0:4])
        self.assert_source_unchanged()

    def test_missing_wrong_sized_and_stale_outputs_are_errors(self):
        with tempfile.TemporaryDirectory() as temp:
            work = Path(temp) / "work"
            shutil.copytree(self.work, work)
            d = work / "sheets/DRON_Stand"
            (d / "output.png").unlink()
            with self.assertRaises(SystemExit):
                cli("compose", self.cache, work)
            Image.new("RGB", (1, 1)).save(d / "output.png")
            with self.assertRaises(SystemExit):
                cli("build", self.cache, work)
            with self.assertRaises(SystemExit):
                cli("install", self.cache, work, "--variant-root", str(Path(temp) / "variant"))
            self.assertFalse((Path(temp) / "variant").exists())
        with self.assertRaises(SystemExit):
            cli("prepare", self.cache, self.work, "--units", "DRON")
        with self.assertRaises(SystemExit):
            cli("compose", self.cache, self.work, "--names", "typo")

    def test_blank_redraw_rejected_and_cannot_install_previous_build(self):
        with tempfile.TemporaryDirectory() as temp:
            work = Path(temp) / "work"
            shutil.copytree(self.work, work)
            d = work / "sheets/DRON_Stand"
            job = json.loads((d / "job.json").read_text())
            Image.new("RGB", job["size"], (118, 118, 118)).save(d / "output.png")
            with self.assertRaises(SystemExit):
                cli("build", self.cache, work, "--names", "DRON_Stand")
            self.assertFalse((work / "pages/build.json").exists())
            report = json.loads((work / "pages/report.json").read_text())
            self.assertEqual(report["rejected"], 8)
            self.assertEqual(report["accepted"], 0)

    def test_source_destinations_refused(self):
        for destination in (self.cache, self.lib.root, self.cache / "variant"):
            with self.subTest(destination=destination), self.assertRaises(SystemExit):
                cli("install", self.cache, self.work, "--variant-root", str(destination))
        with self.assertRaises(SystemExit):
            cli("prepare", self.cache, self.cache / "work")
        self.assert_source_unchanged()


if __name__ == "__main__":
    unittest.main()
