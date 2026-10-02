"""Asset-free depth-metadata installation acceptance with synthetic symlink farms."""

import contextlib
import copy
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock

import cache_farm
import zshape_install as zshape


def write_json(path, value):
    path.write_text(json.dumps(value), encoding="utf-8")


def snapshot(directory):
    return {str(path.relative_to(directory)): (path.read_bytes(), path.stat().st_mtime_ns,
                                              path.is_symlink())
            for path in directory.rglob("*") if path.is_file() and not path.name.endswith(".lock")}


class ZShapeInstallTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.base = self.root / "base"
        self.farm = self.root / "farm"
        self.staging = self.root / "staging"
        self.staging.mkdir()
        (self.staging / zshape.TEMPLATE_FILE).write_bytes(bytes((0, 1, 127, 128, 190, 255)))
        self.patches = {}
        for theater in ("temperate", "snow"):
            directory = self.base / "_library" / theater
            directory.mkdir(parents=True)
            library = dict(version=1, theater=theater, custom={"keep": True}, types={
                "NAREFN": dict(kind="building", image="NAREFN", custom="type", building=dict(
                    bodyFrames=2, height=3, zShape={"custom": "shape"},
                    layers=[dict(key="ActiveAnim", sprite="anim:REF", offset=[2, 4], custom="layer"),
                            dict(key="IdleAnim", sprite="anim:IDLE", yDrawOffset=8)])),
                "HARV": dict(kind="vehicle", voxel="HARV"),
                "INF": dict(kind="infantry"),
                "UNRESOLVED": dict(kind="building"),
            })
            write_json(directory / "library.json", library)
            (directory / zshape.TEMPLATE_FILE).write_bytes(b"older template")
            (directory / "unrelated.png").write_bytes(b"other assets")
            destination = self.farm / "_library" / theater
            destination.mkdir(parents=True)
            for source in directory.iterdir():
                (destination / source.name).symlink_to(source)
            self.patches[theater] = dict(
                depthTemplate=dict(file="buildngz.bin", width=3, height=2),
                types={"NAREFN": dict(zShape=dict(pointMove=[30, 15], normalZAdjust=-7), refinery=True),
                       "HARV": dict(harvester=True), "MISSING": dict(refinery=True),
                       "INF": dict(harvester=True), "UNRESOLVED": dict(zShape=dict(pointMove=[1, 2]))},
                layers={"NAREFN": {"ActiveAnim": dict(yDrawOffset=-4), "MissingAnim": dict(yDrawOffset=3)},
                        "MISSING": {"ActiveAnim": dict(yDrawOffset=5)}})
        self.save_patch()
        self.base_before = snapshot(self.base)

    def save_patch(self):
        write_json(self.staging / zshape.PATCH_FILE, self.patches)

    def library_path(self, theater="snow"):
        return self.farm / "_library" / theater / "library.json"

    def read_library(self, theater="snow"):
        return json.loads(self.library_path(theater).read_text(encoding="utf-8"))

    def assert_unchanged_base(self):
        self.assertEqual(snapshot(self.base), self.base_before)

    def assert_preflight_failure(self, message):
        before = snapshot(self.farm)
        with self.assertRaisesRegex(ValueError, message):
            zshape.install(self.staging, self.farm)
        self.assertEqual(snapshot(self.farm), before)
        self.assert_unchanged_base()

    def test_installs_all_theaters_and_preserves_old_cache_and_unrelated_fields(self):
        results = zshape.install(self.staging, self.farm)["theaters"]
        self.assertEqual(set(results), {"snow", "temperate"})
        for theater, result in results.items():
            self.assertEqual({key: result[key] for key in ("zShape", "harvester", "refinery", "yDrawOffset")},
                             dict(zShape=1, harvester=1, refinery=1, yDrawOffset=1))
            self.assertEqual(result["changedFields"], 6)
            self.assertEqual(result["skippedTypes"], ["MISSING", "INF", "UNRESOLVED"])
            self.assertEqual(result["skippedLayers"], ["NAREFN:MissingAnim", "MISSING:ActiveAnim"])
            library = self.read_library(theater)
            self.assertEqual(library["depthTemplate"], dict(file="buildngz.bin", width=3, height=2))
            self.assertEqual(library["custom"], {"keep": True})
            building_type = library["types"]["NAREFN"]
            self.assertTrue(building_type["refinery"])
            self.assertEqual(building_type["custom"], "type")
            building = building_type["building"]
            self.assertEqual(building["zShape"], dict(custom="shape", pointMove=[30, 15], normalZAdjust=-7))
            self.assertEqual(building["height"], 3)
            self.assertEqual(building["layers"], [
                dict(key="ActiveAnim", sprite="anim:REF", offset=[2, 4], custom="layer", yDrawOffset=-4),
                dict(key="IdleAnim", sprite="anim:IDLE", yDrawOffset=8)])
            self.assertTrue(library["types"]["HARV"]["harvester"])
            self.assertNotIn("MISSING", library["types"])
            self.assertNotIn("harvester", library["types"]["INF"])
            self.assertNotIn("building", library["types"]["UNRESOLVED"])
            directory = self.library_path(theater).parent
            self.assertFalse(self.library_path(theater).is_symlink())
            self.assertFalse((directory / zshape.TEMPLATE_FILE).is_symlink())
            self.assertEqual((directory / zshape.TEMPLATE_FILE).read_bytes(),
                             (self.staging / zshape.TEMPLATE_FILE).read_bytes())
            self.assertTrue((directory / "unrelated.png").is_symlink())
        self.assert_unchanged_base()

    def test_repeat_is_content_idempotent_and_reports_no_changed_fields(self):
        first = zshape.install(self.staging, self.farm)
        before = {name: self.library_path(name).read_bytes() for name in first["theaters"]}
        second = zshape.install(self.staging, self.farm)
        for theater, result in second["theaters"].items():
            self.assertEqual(result["changedFields"], 0)
            self.assertEqual(result["zShape"], first["theaters"][theater]["zShape"])
            self.assertEqual(self.library_path(theater).read_bytes(), before[theater])
        self.assertFalse(any(path.name.endswith(".tmp") for path in self.farm.rglob("*")))
        self.assert_unchanged_base()

    def test_merge_reads_updates_made_after_preflight_under_patch_json_lock(self):
        original_patch_json = cache_farm.patch_json

        def after_preflight(root, relative, callback):
            def concurrent_edit(data):
                data["concurrent"] = {"published": True}
                data["types"]["NAREFN"]["building"]["layers"][0]["sprite"] = "anim:NEW"
                data["types"]["NAREFN"]["building"]["zShape"]["custom"] = "concurrent"
            original_patch_json(root, relative, concurrent_edit)
            original_patch_json(root, relative, callback)

        with mock.patch.object(zshape.cache_farm, "patch_json", side_effect=after_preflight):
            zshape.install(self.staging, self.farm)
        for theater in self.patches:
            library = self.read_library(theater)
            self.assertEqual(library["concurrent"], {"published": True})
            building = library["types"]["NAREFN"]["building"]
            self.assertEqual(building["layers"][0]["sprite"], "anim:NEW")
            self.assertEqual(building["layers"][0]["yDrawOffset"], -4)
            self.assertEqual(building["zShape"]["custom"], "concurrent")
        self.assert_unchanged_base()

    def test_realises_symlinked_farm_directories_without_mutating_the_base(self):
        linked_farm = self.root / "directory-farm"
        linked_farm.symlink_to(self.base)
        zshape.install(self.staging, linked_farm)
        self.assertFalse(linked_farm.is_symlink())
        self.assertTrue((linked_farm / "_library/snow/unrelated.png").is_symlink())
        self.assertFalse((linked_farm / "_library/snow/library.json").is_symlink())
        self.assert_unchanged_base()

    def test_missing_theater_patch_is_rejected_before_any_install(self):
        del self.patches["temperate"]
        self.save_patch()
        self.assert_preflight_failure("no patch for farm theater temperate")

    def test_template_size_mismatch_is_rejected_before_any_install(self):
        (self.staging / zshape.TEMPLATE_FILE).write_bytes(b"short")
        self.assert_preflight_failure("expected 6 bytes, found 5")

    def test_inconsistent_shared_template_dimensions_are_rejected(self):
        self.patches["temperate"]["depthTemplate"].update(width=2, height=3)
        self.save_patch()
        self.assert_preflight_failure("metadata differs")

    def test_path_traversal_is_rejected_before_any_install(self):
        for filename in ("../buildngz.bin", "/tmp/buildngz.bin", "sub/buildngz.bin"):
            with self.subTest(filename=filename):
                patches = copy.deepcopy(self.patches)
                patches["snow"]["depthTemplate"]["file"] = filename
                write_json(self.staging / zshape.PATCH_FILE, patches)
                self.assert_preflight_failure("file must be buildngz.bin")
        patches = copy.deepcopy(self.patches)
        patches["../escape"] = patches.pop("temperate")
        write_json(self.staging / zshape.PATCH_FILE, patches)
        self.assert_preflight_failure("invalid theater path")

    def test_malformed_and_default_patch_fields_are_rejected(self):
        malformed = (
            dict(zShape=dict(pointMove=[1])), dict(zShape=dict(pointMove=[True, 2])),
            dict(zShape=dict(pointMove=[0, 0])), dict(zShape=dict(normalZAdjust=0)),
            dict(zShape=dict(normalZAdjust=2.5)), dict(zShape={}), dict(zShape=dict(zAdjust=7)),
            dict(harvester=False), dict(refinery=1), dict(harvester=True, refinery=True), {},
        )
        for fields in malformed:
            with self.subTest(fields=fields):
                patches = copy.deepcopy(self.patches)
                patches["temperate"]["types"]["BAD"] = fields
                write_json(self.staging / zshape.PATCH_FILE, patches)
                self.assert_preflight_failure("temperate.types.BAD")
        for value in (0, True, 1.5, None):
            with self.subTest(yDrawOffset=value):
                patches = copy.deepcopy(self.patches)
                patches["temperate"]["layers"]["NAREFN"]["ActiveAnim"]["yDrawOffset"] = value
                write_json(self.staging / zshape.PATCH_FILE, patches)
                self.assert_preflight_failure("yDrawOffset must be")

    def test_malformed_later_manifest_fails_before_earlier_theater_is_changed(self):
        path = self.library_path("temperate")
        path.unlink()
        path.write_text("invalid json", encoding="utf-8")
        self.assert_preflight_failure("Expecting value")

    def test_failed_file_install_never_publishes_template_reference(self):
        before = snapshot(self.farm)
        with mock.patch.object(cache_farm, "install_file", side_effect=OSError("install failed")):
            with self.assertRaisesRegex(OSError, "install failed"):
                zshape.install(self.staging, self.farm)
        self.assertEqual(snapshot(self.farm), before)
        self.assert_unchanged_base()

    def test_failed_json_publication_is_reported_and_can_be_retried(self):
        with mock.patch.object(cache_farm, "patch_json", side_effect=OSError("JSON failed")):
            with self.assertRaisesRegex(OSError, "JSON failed"):
                zshape.install(self.staging, self.farm)
        self.assertTrue(self.library_path().is_symlink())
        self.assertNotIn("depthTemplate", self.read_library())
        zshape.install(self.staging, self.farm)
        self.assertEqual(self.read_library()["depthTemplate"]["file"], zshape.TEMPLATE_FILE)
        self.assert_unchanged_base()

    def test_cli_prints_json_report_and_returns_failure_for_invalid_staging(self):
        stdout = io.StringIO()
        with contextlib.redirect_stdout(stdout):
            self.assertEqual(zshape.main(["--staging", str(self.staging), "--farm", str(self.farm)]), 0)
        self.assertEqual(set(json.loads(stdout.getvalue())["theaters"]), {"snow", "temperate"})
        (self.staging / zshape.TEMPLATE_FILE).unlink()
        stderr = io.StringIO()
        with contextlib.redirect_stderr(stderr):
            self.assertEqual(zshape.main(["--staging", str(self.staging), "--farm", str(self.farm)]), 1)
        self.assertIn("zshape_install:", stderr.getvalue())
        self.assert_unchanged_base()


if __name__ == "__main__":
    unittest.main()
