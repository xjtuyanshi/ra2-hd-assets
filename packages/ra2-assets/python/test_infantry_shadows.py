"""Asset-free shadow packing and copy-on-write farm publication regressions."""

import base64
import copy
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock

import numpy as np
from PIL import Image

import infantry_shadows as shadows


class InfantryShadowsTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        root = Path(self.tmp.name)
        self.base, self.farm, self.stage = root / 'base', root / 'farm', root / 'stage'
        self.base.mkdir()
        self.farm.mkdir()
        Image.new('L', (8, 8), 40).save(self.base / 'body.png')
        self.body = {'file': 'test.shp', 'frameCount': 4, 'sourceFrames': [1, 0],
                     'palette': 'unit', 'remap': True, 'canvas': [12, 10],
                     'frames': [{'rect': [1, 1, 2, 2], 'offset': [-3, 0]},
                                {'rect': [4, 4, 2, 2], 'offset': [-1, 1]}],
                     'shadows': [{'rect': [0, 0, 0, 0], 'offset': [0, 0]}] * 2}
        self.library = {'theater': 'urban', 'version': 1,
                        'sprites': {'infantry:TEST': self.body, 'building:TEST': {'keep': [1, 2, 3]}},
                        'spriteAtlases': [{'file': 'body.png', 'width': 8, 'height': 8}],
                        'spriteAtlasesHd': [None], 'types': {'keep': 'same'}, 'other': 'untouched'}
        (self.base / 'library.json').write_text(json.dumps(self.library))
        for name in ('body.png', 'library.json'):
            (self.farm / name).symlink_to(self.base / name)
        self.source = {'theater': 'urban', 'sprites': {'infantry:TEST': {
            **{key: copy.deepcopy(self.body[key]) for key in ('file', 'frameCount', 'sourceFrames', 'frames')},
            'shadows': [{'w': 2, 'h': 2, 'offset': [-3, 0], 'pixels': base64.b64encode(bytes([0, 1, 1, 1])).decode()},
                        {'w': 0, 'h': 0, 'offset': [-1, 1], 'pixels': ''}]}}}

    def test_format_offsets_solid_core_soft_edge_and_symlink_isolation(self):
        before = {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in self.base.iterdir()}
        result = shadows.install(self.farm, self.source, self.stage, width=32)
        data = json.loads((self.farm / 'library.json').read_text())
        self.assertEqual((result['sprites'], result['shadows'], result['page']), (1, 1, 1))
        expected = copy.deepcopy(self.library)
        expected['sprites']['infantry:TEST']['shadows'] = data['sprites']['infantry:TEST']['shadows']
        expected['spriteAtlases'] = data['spriteAtlases']
        expected['spriteAtlasesHd'] = data['spriteAtlasesHd']
        self.assertEqual(data, expected)
        f = data['sprites']['infantry:TEST']['shadows'][0]
        self.assertEqual(f['offset'], [-4, -1])
        self.assertFalse((self.farm / 'library.json').is_symlink())
        self.assertTrue((self.farm / 'body.png').is_symlink())
        self.assertEqual(before, {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in self.base.iterdir()})
        with Image.open(self.farm / shadows.PAGE) as image:
            self.assertEqual(image.mode, 'L')
            one = np.asarray(image)
        with Image.open(self.farm / shadows.HD_PAGE) as image:
            self.assertEqual(image.mode, 'RGBA')
            hd = np.asarray(image)
        x, y, w, h = f['rect']
        mask = one[y:y+h, x:x+w]
        alpha = hd[2*y:2*(y+h), 2*x:2*(x+w), 3]
        core = np.repeat(np.repeat(mask > 0, 2, 0), 2, 1)
        self.assertTrue(np.all(alpha[core] == 255))
        self.assertTrue(np.any((alpha > 0) & (alpha < 255)))
        self.assertFalse(hd[..., :3].any())
        self.assertEqual(hd.shape[:2], (one.shape[0]*2, one.shape[1]*2))

    def test_rerun_reuses_page_and_does_not_mutate_installed_hardlinks_during_staging(self):
        shadows.install(self.farm, self.source, self.stage, width=32)
        before = (self.farm / 'library.json').read_bytes()
        png = (self.farm / shadows.HD_PAGE).read_bytes()
        changed = copy.deepcopy(self.source)
        changed['sprites']['infantry:TEST']['shadows'][0]['pixels'] = base64.b64encode(bytes([1, 1, 1, 1])).decode()
        shadows.pack(changed, self.stage, width=32)
        self.assertEqual((self.farm / shadows.HD_PAGE).read_bytes(), png)
        shadows.install(self.farm, self.source, self.stage, width=32)
        self.assertEqual((self.farm / 'library.json').read_bytes(), before)
        self.assertEqual((self.farm / shadows.HD_PAGE).read_bytes(), png)

    def test_single_pixel_retains_opaque_core(self):
        self.source['sprites']['infantry:TEST']['shadows'][0].update(w=1, h=1, pixels='AQ==')
        frames, _, _ = shadows.pack(self.source, self.stage, width=32)
        x, y, w, h = frames['infantry:TEST'][0]['rect']
        alpha = np.asarray(Image.open(self.stage / shadows.HD_PAGE))[2*y:2*(y+h), 2*x:2*(x+w), 3]
        self.assertEqual(int((alpha == 255).sum()), 4)

    def test_guards_stale_body_metadata_before_file_installation(self):
        self.source['sprites']['infantry:TEST']['sourceFrames'] = [0, 1]
        with mock.patch.object(shadows.cache_farm, 'install_file') as installer:
            with self.assertRaisesRegex(ValueError, 'sourceFrames'):
                shadows.install(self.farm, self.source, self.stage, width=32)
            installer.assert_not_called()
        self.assertTrue((self.farm / 'library.json').is_symlink())

    def test_rejects_invalid_masks_and_symlinked_theatre(self):
        self.source['sprites']['infantry:TEST']['shadows'][0]['pixels'] = 'AgICAg=='
        with self.assertRaisesRegex(ValueError, 'malformed shadow'):
            shadows.pack(self.source, self.stage, width=32)
        link = self.farm / 'linked'
        link.symlink_to(self.base)
        with self.assertRaisesRegex(ValueError, 'real directory'):
            shadows.install(link, self.source, self.stage, width=32)

    def test_rejects_symlinked_library_ancestor_before_staging_or_publication(self):
        (self.base / 'urban').mkdir()
        (self.farm / '_library').symlink_to(self.base)
        with mock.patch.object(shadows, 'pack') as packer:
            with self.assertRaisesRegex(ValueError, 'farm and _library'):
                shadows.install(self.farm / '_library/urban', self.source, self.stage, width=32)
            packer.assert_not_called()


if __name__ == '__main__':
    unittest.main()
