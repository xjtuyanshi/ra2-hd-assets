"""Asset-free acceptance for decal isolation, geometry and copy-on-write installation."""
import copy
import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock

import numpy as np
from PIL import Image

import cache_farm
import smudge_redraw as redraw


class SmudgeRedrawTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(dir=Path(__file__).parent, prefix='.tmp-smudge-')
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.source = self.root/'source'/'snow'
        self.source.mkdir(parents=True)
        (self.source/'palettes').mkdir()
        palette = np.zeros((1, 256, 3), np.uint8); palette[0, 1] = (180, 160, 140)
        Image.fromarray(palette).save(self.source/'palettes/iso.png')
        indices = np.zeros((10, 10), np.uint8); indices[2:8, 2:8] = 1; indices[4:6, 4:6] = 0
        Image.fromarray(indices).save(self.source/'native.png')
        self.fragment = dict(version=1, theater='snow', palettes={'iso': 'palettes/iso.png'},
            paletteSources={'iso': 'isosno.pal'}, spriteAtlases=[dict(file='native.png', width=10, height=10)],
            spriteAtlasesHd=[None], sprites={'smudge:MARK': dict(palette='iso', remap=False,
                canvas=[10, 10], frames=[dict(page=0, rect=[1, 1, 8, 8], offset=[-4, 3])],
                shadows=[dict(page=0, rect=[0, 0, 0, 0], offset=[-5, -5])])},
            smudges={'MARK': dict(sprite='smudge:MARK', frames=1, width=2, height=1, palette='iso',
                                 flat=True, remap=False, drawOffset=[0, 0], lighting='full')},
            smudgeExtractor={'tool': 'local extraction', 'counts': {'listed:smudge': 2, 'types:smudge': 1},
                             'warnings': ['smudge:LEGACY: no art file']})
        self.write(self.source/'library.fragment.json', self.fragment)
        self.job = self.root/'job'; self.job.mkdir()
        Image.new('RGBA', (64, 64)).save(self.job/'reference.png')
        generated = np.zeros((64, 64, 4), np.uint8)
        generated[12:52, 12:52] = (70, 72, 74, 255)
        generated[16:48:4, 16:48:4] = (115, 116, 118, 255)
        Image.fromarray(generated).save(self.job/'generated.png')
        self.slots = [dict(theater='snow', id='MARK', slot=[0, 0, 64, 64], content=[8, 8, 48, 48],
                           frame=self.fragment['sprites']['smudge:MARK']['frames'][0], footprint=[2, 1])]
        self.write(self.job/'slots.json', self.slots)
        self.ready = self.root/'ready'
        self.dest = self.root/'destination'; self.dest.mkdir()
        (self.dest/'palettes').mkdir()
        Image.open(self.source/'palettes/iso.png').save(self.dest/'palettes/iso.png')
        Image.new('L', (4, 4), 30).save(self.dest/'siblings.png')
        self.current = dict(version=1, theater='snow', palettes={'iso': 'palettes/iso.png'},
            paletteSources={'iso': 'isosno.pal'}, spriteAtlases=[dict(file='siblings.png', width=4, height=4)],
            spriteAtlasesHd=[None], sprites={'overlay:ORE': {'unchanged': True}},
            overlays={'ORE': {'sprite': 'overlay:ORE'}}, types={'BUILDING': {'unchanged': True}},
            custom={'settings': ['retain']})
        self.write(self.dest/'library.json', self.current)

    @staticmethod
    def write(path, value):
        path.write_text(json.dumps(value), encoding='utf-8')

    def assemble(self):
        redraw.assemble(self.job, self.root/'source', self.ready)
        return self.ready/'snow'

    def snapshot(self):
        return {str(p.relative_to(self.dest)): p.read_bytes() for p in self.dest.rglob('*')
                if p.is_file() and not p.name.endswith('.lock')}

    def test_assembly_uses_ai_material_and_preserves_geometry_gaps_and_soft_edge(self):
        staged = self.assemble(); lib = redraw.validate(staged, require_hd=True)
        self.assertEqual(lib['sprites'], self.fragment['sprites'])
        self.assertEqual(lib['smudges'], self.fragment['smudges'])
        colour = redraw.pixels(staged/lib['spriteAtlasesHd'][0]['file'], 'RGBA')
        original = redraw.original_frame(self.source, self.fragment, 'MARK')
        mask = redraw.feather(original)
        patch = colour[2:18, 2:18]
        self.assertTrue(np.array_equal(patch[..., 3], mask))
        self.assertTrue((patch[..., :3][mask > 200] < 140).all())
        self.assertGreater(np.unique(patch[..., 0][mask > 200]).size, 2)
        self.assertFalse(patch[6:10, 6:10, 3].any())

    def test_opaque_sheet_and_incomplete_slots_are_rejected(self):
        Image.new('RGBA', (64, 64), (70, 70, 70, 255)).save(self.job/'generated.png')
        with self.assertRaisesRegex(ValueError, 'transparent'):
            self.assemble()
        Image.new('RGBA', (64, 64)).save(self.job/'generated.png')
        self.write(self.job/'slots.json', [])
        # No theatre can be fabricated from an empty assignment.
        with self.assertRaisesRegex(ValueError, 'no generated slot assignment'):
            self.assemble()

    def test_slot_registration_discards_separated_neighbour_spill(self):
        image = Image.new('RGBA', (64, 64))
        array = np.array(image); array[20:45, 20:45] = (70, 70, 70, 255)
        array[20:45, :2] = (100, 100, 100, 255)
        _, _, receipt = redraw.registered_patch(Image.fromarray(array), self.slots[0], (16, 16))
        self.assertEqual(receipt['generated_slot_bbox'], [20, 20, 45, 45])
        self.assertEqual(receipt['separate_spill_pixels_removed'], 50)

    def test_reference_macro_reverses_wrong_ai_lighting_but_keeps_material_detail(self):
        array = np.full((24, 24, 4), 255, np.uint8)
        array[:12, :, :3] = 55; array[12:, :, :3] = 145
        original = Image.fromarray(array)
        yy, xx = np.indices((48, 48))
        ai_luma = np.where(yy < 24, 130, 70).astype(np.float32) + np.where((xx+yy)%2, 9, -9)
        rgb = np.repeat(ai_luma[..., None], 3, axis=2)
        support = np.full((48, 48), 255, np.uint8)
        result, receipt = redraw.match_macro(original, rgb, support)
        self.assertLess(result[8:16, :, 0].mean(), result[32:40, :, 0].mean())
        self.assertGreater(receipt['ai_detail_rms'], 8)
        self.assertGreater(result[10, :, 0].std(), 7)

    def test_install_keeps_siblings_sidecars_and_is_idempotent(self):
        staged = self.assemble(); before = self.snapshot()
        (self.dest/'normals.json').write_text('{"pages":{"0":{"retain":true}}}')
        normals = (self.dest/'normals.json').read_bytes()
        result = redraw.install(staged, self.dest)
        self.assertEqual(result['pages_added'], 1)
        lib = redraw.read_json(self.dest/'library.json')
        for key in ('overlays', 'types', 'custom', 'palettes', 'paletteSources'):
            self.assertEqual(lib[key], self.current[key])
        self.assertEqual(lib['sprites']['overlay:ORE'], self.current['sprites']['overlay:ORE'])
        self.assertEqual(lib['sprites']['smudge:MARK']['frames'][0]['page'], 1)
        self.assertEqual(lib['smudgeExtractor']['warnings'], ['smudge:LEGACY: no art file'])
        self.assertEqual((self.dest/'siblings.png').read_bytes(), before['siblings.png'])
        self.assertEqual((self.dest/'normals.json').read_bytes(), normals)
        installed = self.snapshot()
        self.assertEqual(redraw.install(staged, self.dest)['pages_added'], 0)
        self.assertEqual(self.snapshot(), installed)

    def test_symlinked_json_is_replaced_without_mutating_base(self):
        staged = self.assemble(); base = self.root/'base.json'
        base.write_bytes((self.dest/'library.json').read_bytes())
        (self.dest/'library.json').unlink(); (self.dest/'library.json').symlink_to(base)
        before = base.read_bytes(); redraw.install(staged, self.dest)
        self.assertEqual(base.read_bytes(), before)
        self.assertFalse((self.dest/'library.json').is_symlink())

    def test_missing_hd_and_palette_mismatch_fail_before_file_installation(self):
        before = self.snapshot()
        with self.assertRaisesRegex(ValueError, 'actual 2x'):
            redraw.install(self.source, self.dest)
        self.assertEqual(self.snapshot(), before)
        staged = self.assemble(); Image.new('RGB', (256, 1), (0, 0, 0)).save(self.dest/'palettes/iso.png')
        before = self.snapshot()
        with self.assertRaisesRegex(ValueError, 'colours differ'):
            redraw.install(staged, self.dest)
        self.assertEqual(self.snapshot(), before)

    def test_fragment_cannot_claim_unrelated_sprite_ownership(self):
        staged = self.assemble()
        lib = redraw.read_json(staged/'library.fragment.json')
        lib['sprites']['overlay:ORE'] = {'overwrite': True}
        self.write(staged/'library.fragment.json', lib)
        before = self.snapshot()
        with self.assertRaisesRegex(ValueError, 'only its referenced smudge'):
            redraw.install(staged, self.dest)
        self.assertEqual(self.snapshot(), before)

    def test_staged_file_changed_during_installation_aborts_json_publication(self):
        staged = self.assemble(); before = (self.dest/'library.json').read_bytes()
        put = cache_farm.install_file
        def changed(directory, name, origin):
            if '@2x.png' in name:
                Image.new('RGBA', (20, 20), (90, 90, 90, 255)).save(origin)
            return put(directory, name, origin)
        with mock.patch.object(cache_farm, 'install_file', side_effect=changed):
            with self.assertRaisesRegex(ValueError, 'staged source changed'):
                redraw.install(staged, self.dest)
        self.assertEqual((self.dest/'library.json').read_bytes(), before)

    def test_concurrent_json_sibling_edit_survives_and_page_change_aborts(self):
        staged = self.assemble(); patch = cache_farm.patch_json
        def sibling(directory, name, update, **kwargs):
            patch(directory, name, lambda d: d.update(custom={'concurrent': 'retain'}))
            return patch(directory, name, update, **kwargs)
        with mock.patch.object(cache_farm, 'patch_json', side_effect=sibling):
            redraw.install(staged, self.dest)
        self.assertEqual(redraw.read_json(self.dest/'library.json')['custom'], {'concurrent': 'retain'})
        # A layout race must never publish frames against the wrong page slot.
        def shifted(directory, name, update, **kwargs):
            patch(directory, name, lambda d: d['spriteAtlases'].append(dict(file='other.png', width=1, height=1)))
            return patch(directory, name, update, **kwargs)
        with mock.patch.object(cache_farm, 'patch_json', side_effect=shifted):
            with self.assertRaisesRegex(ValueError, 'page layout changed'):
                redraw.install(staged, self.dest)


if __name__ == '__main__':
    unittest.main()
