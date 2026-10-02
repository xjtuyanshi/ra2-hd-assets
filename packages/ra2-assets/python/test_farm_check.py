"""Asset-free regressions for farm_check.py (synthetic farm over a synthetic base cache)."""

import json
import os
from pathlib import Path
import tempfile
import time
import unittest

import farm_check


def write(path: Path, data) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data) if not isinstance(data, str) else data, encoding='utf-8')


class FarmCheckTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.base, self.farm = root / 'base', root / 'farm'
        theatre = self.base / '_library' / 'urban'
        write(theatre / 'sprites-9@2x.png', 'png')
        write(theatre / 'sprites-9@2x-normals.png', 'png')
        write(theatre / 'library.json', {'spriteAtlasesHd': [None] * 9 + [{'file': 'sprites-9@2x.png'}]})
        write(theatre / 'normals.json', {'pages': {'9': {'file': 'sprites-9@2x-normals.png', 'atlas': 'sprites-9@2x.png'}}})
        old = time.time() - 3600
        for p in theatre.iterdir():
            os.utime(p, (old, old))
        farm_theatre = self.farm / '_library' / 'urban'
        farm_theatre.mkdir(parents=True)
        for p in theatre.iterdir():
            (farm_theatre / p.name).symlink_to(p)
        self.since = time.time() - 60

    def tearDown(self):
        self.tmp.cleanup()

    def test_clean_farm_passes(self):
        res = farm_check.check(self.farm, [self.base], self.since)
        self.assertEqual(res['problems'], 0, res)
        self.assertEqual(res['links'], 4)

    def test_renamed_page_without_normals_update_is_reported(self):
        lib = self.farm / '_library' / 'urban' / 'library.json'
        lib.unlink()
        write(lib, {'spriteAtlasesHd': [None] * 9 + [{'file': 'sprites-9@2x-fix.png'}]})
        write(self.farm / '_library' / 'urban' / 'sprites-9@2x-fix.png', 'png')
        res = farm_check.check(self.farm, [self.base], self.since)
        self.assertEqual(len(res['ignored_normals']), 1)
        self.assertIn('made for sprites-9@2x.png', res['ignored_normals'][0])

    def test_write_through_broken_link_and_hard_link_are_reported(self):
        # Writing through the symlink modifies the base cache.
        (self.farm / '_library' / 'urban' / 'sprites-9@2x.png').write_text('changed', encoding='utf-8')
        (self.base / '_library' / 'urban' / 'sprites-9@2x-normals.png').unlink()
        os.link(self.base / '_library' / 'urban' / 'library.json', self.farm / 'shared.json')
        res = farm_check.check(self.farm, [self.base], self.since)
        self.assertTrue(any('sprites-9@2x.png' in w for w in res['write_through']))
        self.assertEqual(res['broken'], ['_library/urban/sprites-9@2x-normals.png'])
        self.assertEqual(len(res['shared_inodes']), 1)
        self.assertGreater(res['problems'], 0)


if __name__ == '__main__':
    unittest.main()
