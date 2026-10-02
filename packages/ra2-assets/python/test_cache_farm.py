"""Fast, asset-free cache-farm installation and locking regressions."""

import errno
import json
import multiprocessing
import os
from pathlib import Path
import tempfile
import unittest
from unittest import mock

import cache_farm as farm

PROCESS_TIMEOUT = 30


def patch_worker(root, key, started, entered, release):
    started.set()

    def patch(data):
        entered.set()
        if release is not None and not release.wait(2 * PROCESS_TIMEOUT):
            raise RuntimeError("timed out waiting to release the JSON patch")
        data[key] = True

    farm.patch_json(Path(root), "library.json", patch)


class CacheFarmTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.cache = self.root / "farm"
        self.cache.mkdir()
        self.source = self.root / "source.bin"
        self.source.write_bytes(b"new page")

    def assert_no_temporary_names(self):
        self.assertEqual([path for path in self.root.rglob("*") if path.name.endswith(".tmp")], [])

    def test_install_replaces_symlink_without_writing_its_target(self):
        original = self.root / "original.bin"
        original.write_bytes(b"base page")
        dst = self.cache / "page.bin"
        dst.symlink_to(original)
        farm.install_file(self.cache, "page.bin", self.source)
        self.assertFalse(dst.is_symlink())
        self.assertEqual(dst.read_bytes(), b"new page")
        self.assertEqual(original.read_bytes(), b"base page")
        self.assertTrue(os.path.samefile(dst, self.source))
        self.assert_no_temporary_names()

    def test_reinstall_identical_hard_link_cleans_up_rename_noop(self):
        dst = self.cache / "page.bin"
        os.link(self.source, dst)
        farm.install_file(self.cache, "page.bin", self.source)
        self.assertTrue(os.path.samefile(dst, self.source))
        self.assertEqual(self.source.stat().st_nlink, 2)
        self.assert_no_temporary_names()

    def test_install_creates_parents_and_copies_when_link_crosses_devices(self):
        with mock.patch.object(farm.os, "link", side_effect=OSError(errno.EXDEV, "cross-device link")):
            farm.install_file(self.cache, "nested/new/page.bin", self.source)
        dst = self.cache / "nested/new/page.bin"
        self.assertEqual(dst.read_bytes(), self.source.read_bytes())
        self.assertFalse(os.path.samefile(dst, self.source))
        self.assert_no_temporary_names()

    def test_realises_nested_directories_by_atomic_swap_and_preserves_other_children(self):
        base = self.root / "base"
        (base / "nested/deep").mkdir(parents=True)
        (base / "nested/deep/page.bin").write_bytes(b"base page")
        (base / "keep.txt").write_text("keep")
        (base / "missing").symlink_to(base / "absent")
        (self.cache / "library").symlink_to(base)
        exchange = farm._exchange

        def swap(left, right):
            self.assertTrue(left.is_dir())
            self.assertFalse(left.is_symlink())
            self.assertTrue(right.is_symlink())
            exchange(left, right)
            self.assertTrue(right.is_dir())
            self.assertFalse(right.is_symlink())
            self.assertTrue(left.is_symlink())

        with mock.patch.object(farm, "_exchange", side_effect=swap) as swapped:
            farm.install_file(self.cache, "library/nested/deep/page.bin", self.source)
        self.assertEqual(swapped.call_count, 3)
        for name in ("library", "library/nested", "library/nested/deep"):
            self.assertFalse((self.cache / name).is_symlink())
        self.assertEqual((self.cache / "library/nested/deep/page.bin").read_bytes(), b"new page")
        self.assertEqual((base / "nested/deep/page.bin").read_bytes(), b"base page")
        self.assertTrue((self.cache / "library/keep.txt").is_symlink())
        self.assertEqual((self.cache / "library/keep.txt").read_text(), "keep")
        self.assertTrue((self.cache / "library/missing").is_symlink())
        self.assert_no_temporary_names()

    def test_realises_a_symlinked_farm_root(self):
        linked = self.root / "linked"
        linked.symlink_to(self.cache)
        farm.install_file(linked, "page.bin", self.source)
        self.assertFalse(linked.is_symlink())
        self.assertTrue((linked / "page.bin").is_file())
        self.assertFalse((self.cache / "page.bin").exists())
        self.assert_no_temporary_names()

    def test_install_failure_leaves_destination_intact_and_no_temporary_names(self):
        dst = self.cache / "page.bin"
        dst.write_bytes(b"old page")
        with mock.patch.object(farm.os, "replace", side_effect=OSError("replace failed")), \
                self.assertRaises(OSError):
            farm.install_file(self.cache, "page.bin", self.source)
        self.assertEqual(dst.read_bytes(), b"old page")
        self.assert_no_temporary_names()

    def manifest(self):
        original = self.root / "base.json"
        original.write_text(json.dumps({"keep": [0, False]}))
        (self.cache / "library.json").symlink_to(original)
        return original

    def test_sequential_json_patches_preserve_both_keys_and_replace_symlink(self):
        original = self.manifest()
        farm.patch_json(self.cache, "library.json", lambda data: data.update(first=1))
        farm.patch_json(self.cache, "library.json", lambda data: data.update(second=2))
        dst = self.cache / "library.json"
        self.assertFalse(dst.is_symlink())
        self.assertEqual(json.loads(dst.read_text()), {"keep": [0, False], "first": 1, "second": 2})
        self.assertEqual(json.loads(original.read_text()), {"keep": [0, False]})
        self.assertTrue((self.cache / ".library.json.lock").is_file())
        self.assert_no_temporary_names()

    def test_missing_json_uses_a_fresh_default_and_existing_json_takes_precedence(self):
        default = {'version': 1, 'pages': {}}
        farm.patch_json(self.cache, 'normals.json', lambda data: data['pages'].update({'3': {'file': 'ore.png'}}),
                        default=default)
        self.assertEqual(default, {'version': 1, 'pages': {}})
        farm.patch_json(self.cache, 'normals.json', lambda data: data.update(custom=True),
                        default={'version': 9, 'pages': {}})
        self.assertEqual(json.loads((self.cache / 'normals.json').read_text()),
                         {'version': 1, 'pages': {'3': {'file': 'ore.png'}}, 'custom': True})
        self.assert_no_temporary_names()

    def test_default_replaces_dangling_symlink_without_creating_its_target(self):
        missing = self.root / 'missing.json'
        dst = self.cache / 'normals.json'
        dst.symlink_to(missing)
        farm.patch_json(self.cache, 'normals.json', lambda data: data.update(created=True), default={})
        self.assertFalse(dst.is_symlink())
        self.assertEqual(json.loads(dst.read_text()), {'created': True})
        self.assertFalse(missing.exists())
        self.assert_no_temporary_names()

    def test_missing_json_without_default_and_invalid_existing_json_still_fail(self):
        with self.assertRaises(FileNotFoundError):
            farm.patch_json(self.cache, 'missing.json', lambda data: None)
        dst = self.cache / 'invalid.json'
        dst.write_text('invalid JSON')
        with self.assertRaises(json.JSONDecodeError):
            farm.patch_json(self.cache, 'invalid.json', lambda data: None, default={})
        self.assertEqual(dst.read_text(), 'invalid JSON')
        self.assert_no_temporary_names()

    def test_concurrent_json_patchers_lock_before_reading_and_preserve_updates(self):
        self.manifest()
        ctx = multiprocessing.get_context("spawn")
        first_started, first_entered, release = ctx.Event(), ctx.Event(), ctx.Event()
        second_started, second_entered = ctx.Event(), ctx.Event()
        first = ctx.Process(target=patch_worker,
                            args=(str(self.cache), "first", first_started, first_entered, release))
        second = ctx.Process(target=patch_worker,
                             args=(str(self.cache), "second", second_started, second_entered, None))
        processes = []
        try:
            first.start()
            processes.append(first)
            # Interpreter startup can exceed the callback budget on a loaded host.
            # Wait for readiness separately; keep the lock-entry and exclusion assertions intact.
            self.assertTrue(first_started.wait(PROCESS_TIMEOUT), "first patch process did not start")
            self.assertTrue(first_entered.wait(3))
            second.start()
            processes.append(second)
            self.assertTrue(second_started.wait(PROCESS_TIMEOUT), "second patch process did not start")
            self.assertFalse(second_entered.wait(0.1), "second callback ran while the first held the lock")
            release.set()
            for process in processes:
                process.join(PROCESS_TIMEOUT)
                self.assertEqual(process.exitcode, 0)
        finally:
            release.set()
            for process in processes:
                if process.is_alive():
                    process.terminate()
                    process.join(PROCESS_TIMEOUT)
        dst = self.cache / "library.json"
        self.assertFalse(dst.is_symlink())
        self.assertEqual(json.loads(dst.read_text()), {"keep": [0, False], "first": True, "second": True})
        self.assert_no_temporary_names()

    def test_failed_json_callback_preserves_symlink_and_releases_lock(self):
        self.manifest()

        def fail(data):
            data["discard"] = True
            raise ValueError("patch failed")

        with self.assertRaises(ValueError):
            farm.patch_json(self.cache, "library.json", fail)
        self.assertTrue((self.cache / "library.json").is_symlink())
        farm.patch_json(self.cache, "library.json", lambda data: data.update(keep=1))
        self.assertEqual(json.loads((self.cache / "library.json").read_text()), {"keep": 1})
        self.assert_no_temporary_names()


if __name__ == "__main__":
    unittest.main()
