"""Asset-free theatre page acceptance using tiny synthetic libraries only."""

import copy
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

import numpy as np
from PIL import Image

import theatre_pages as tp


SELECTED, OTHER = 'building:SELECTED', 'anim:OTHER'


def write_json(path, value):
    Path(path).write_text(json.dumps(value), encoding='utf-8')


def synthetic_library(directory, hd=True):
    directory.mkdir()
    Image.new('RGB', (256, 1), (90, 100, 110)).save(directory / 'palette.png')
    library = dict(palettes={'unit': 'palette.png'}, spriteAtlases=[], spriteAtlasesHd=[], sprites={},
                   types={'untouched': {'value': 17}}, marker='keep')
    for page in range(3):
        index = np.full((4, 8), 40 + page, np.uint8)
        Image.fromarray(index).save(directory / f'index-{page}.png')
        library['spriteAtlases'].append(dict(file=f'index-{page}.png', width=8, height=4))
        Image.new('RGBA', (16, 8), (110 + page, 120 + page, 130 + page, 255)).save(directory / f'hd-{page}.png')
        Image.new('L', (16, 8), 150 + page).save(directory / f'remap-{page}.png')
        library['spriteAtlasesHd'].append(dict(file=f'hd-{page}.png', remap=f'remap-{page}.png',
                                             width=16, height=8, scale=2, owner='urban') if hd else None)
        for sid, x in ((SELECTED, 0), (OTHER, 4)):
            library['sprites'].setdefault(sid, dict(palette='unit', frames=[], custom='keep'))['frames'].append(
                dict(rect=[x, 0, 4, 4], offset=[-2, -3], page=page))
    write_json(directory / 'library.json', library)
    return library


def materials(directory, library, pages=(0, 1, 2), value=70, factor=1):
    entries = {}
    for page in pages:
        name = f'material-{page}.png'
        Image.new('RGBA', (8 * factor, 4 * factor), (value + page, 80, 90, 255)).save(directory / name)
        entries[str(page)] = dict(file=name, atlas=library['spriteAtlasesHd'][page]['file'], width=16, height=8,
                                 materialWidth=8 * factor, materialHeight=4 * factor, scale=2, frames=2)
    data = dict(version=1, encoding='keep encoding', pages=entries, custom='keep material metadata')
    write_json(directory / 'normals.json', data)
    return data


class TheatreTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='.tmp-theatre-', dir=Path(__file__).parent)
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.urban, self.theatre, self.baseline = (self.root / n for n in ('urban', 'snow', 'baseline'))
        self.source = synthetic_library(self.urban)
        self.target = synthetic_library(self.theatre, hd=False)
        self.baseline.mkdir()
        self.source_materials = materials(self.urban, self.source)
        self.addCleanup(mock.patch.stopall)

    def cli(self, *arguments):
        result = subprocess.run([sys.executable, '-B', tp.__file__, *map(str, arguments)],
                                capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        return result

    def assert_unowned_library_data(self, before, after):
        for key in before:
            if key != 'spriteAtlasesHd':
                self.assertEqual(after[key], before[key])

    def test_identical_page_symlinks_colour_remap_material_and_json_copy_on_write(self):
        original_json = self.theatre / 'shared-library.json'
        (self.theatre / 'library.json').rename(original_json)
        (self.theatre / 'library.json').symlink_to(original_json.name)
        before = original_json.read_bytes()
        source_files = {p.name: p.read_bytes() for p in self.urban.iterdir()}
        self.cli('xfer', self.theatre, self.urban, self.baseline, '--pages', '0')
        after = tp.read_json(self.theatre / 'library.json')
        entry = after['spriteAtlasesHd'][0]
        for key in ('file', 'remap'):
            path = self.theatre / entry[key]
            self.assertTrue(path.is_symlink())
            self.assertEqual(path.resolve(), (self.urban / self.source['spriteAtlasesHd'][0][key]).resolve())
        normals = tp.read_json(self.theatre / 'normals.json')['pages']['0']
        self.assertTrue((self.theatre / normals['file']).is_symlink())
        self.assertEqual((self.theatre / normals['file']).resolve(), self.urban / 'material-0.png')
        self.assertEqual(normals['atlas'], entry['file'])
        self.assertEqual(after['spriteAtlasesHd'][1:], [None, None])
        self.assert_unowned_library_data(self.target, after)
        self.assertFalse((self.theatre / 'library.json').is_symlink())
        self.assertEqual(original_json.read_bytes(), before)
        for name, content in source_files.items():
            self.assertEqual((self.urban / name).read_bytes(), content)

    def test_differing_page_keeps_baseline_and_copies_only_identical_frame_blocks(self):
        index = tp.read_image(self.theatre / 'index-1.png')
        index[:, 4:] = 95
        Image.fromarray(index).save(self.theatre / 'index-1.png')
        colour = np.full((8, 16, 4), [9, 19, 29, 77], np.uint8)
        remap = np.full((8, 16), 7, np.uint8)
        Image.fromarray(colour).save(self.baseline / 'sprites-1@2x.png')
        Image.fromarray(remap).save(self.baseline / 'sprites-1@2x-remap.png')
        self.cli('xfer', self.theatre, self.urban, self.baseline, '--pages', '1')
        after = tp.read_json(self.theatre / 'library.json')
        entry = after['spriteAtlasesHd'][1]
        self.assertFalse((self.theatre / entry['file']).is_symlink())
        colour[:, :8] = tp.read_image(self.urban / 'hd-1.png')[:, :8]
        remap[:, :8] = tp.read_image(self.urban / 'remap-1.png')[:, :8]
        np.testing.assert_array_equal(tp.read_image(self.theatre / entry['file']), colour)
        np.testing.assert_array_equal(tp.read_image(self.theatre / entry['remap']), remap)
        material = tp.read_json(self.theatre / 'normals.json')['pages']['1']
        expected = np.zeros((4, 8, 4), np.uint8)
        expected[:, :4] = tp.read_image(self.urban / 'material-1.png')[:, :4]
        np.testing.assert_array_equal(tp.read_image(self.theatre / material['file']), expected)
        self.assert_unowned_library_data(self.target, after)

    def test_existing_hd_and_material_entries_left_alone(self):
        self.target['spriteAtlasesHd'][0] = dict(self.source['spriteAtlasesHd'][0], owner='another track')
        write_json(self.theatre / 'library.json', self.target)
        owned = dict(version=1, custom='keep', pages={'0': dict(file='owned-material.png', atlas='owned.png'),
                                                   '1': dict(file='owned-material.png', atlas='owned.png')})
        Image.new('RGBA', (8, 4), (11, 22, 33, 255)).save(self.theatre / 'owned-material.png')
        write_json(self.theatre / 'normals.json', owned)
        before = {p.name: p.read_bytes() for p in self.theatre.iterdir()}
        self.cli('xfer', self.theatre, self.urban, self.baseline, '--pages', '0')
        for name, content in before.items():
            self.assertEqual((self.theatre / name).read_bytes(), content)
        # Giving page 1 colour HD does not replace another track's material entry.
        self.cli('xfer', self.theatre, self.urban, self.baseline, '--pages', '1')
        self.assertEqual(tp.read_json(self.theatre / 'normals.json'), owned)
        self.assertEqual((self.theatre / 'owned-material.png').read_bytes(), before['owned-material.png'])

    def test_repacked_shared_frames_without_baseline_and_palette_mismatch(self):
        # Same SHP frame on a different urban page must use that page's HD block.
        self.source['sprites'][SELECTED]['frames'][0]['offset'] = [-10, -10]
        index = tp.read_image(self.theatre / 'index-1.png')
        index[:, :4] = 40
        Image.fromarray(index).save(self.theatre / 'index-1.png')
        # Keep only one destination frame so all art is shared but page packing differs.
        self.target['sprites'] = {SELECTED: dict(palette='unit', frames=[
            dict(rect=[0, 0, 4, 4], offset=[-10, -10], page=1)])}
        write_json(self.urban / 'library.json', self.source)
        write_json(self.theatre / 'library.json', self.target)
        self.cli('xfer', self.theatre, self.urban, self.baseline, '--pages', '1')
        entry = tp.read_json(self.theatre / 'library.json')['spriteAtlasesHd'][1]
        output = tp.read_image(self.theatre / entry['file'])
        np.testing.assert_array_equal(output[:, :8], tp.read_image(self.urban / 'hd-0.png')[:, :8])
        np.testing.assert_array_equal(output[:, 8:], 0)
        # Equal indices with a different palette are not reusable shared art.
        Image.new('RGB', (256, 1), (1, 2, 3)).save(self.theatre / 'palette.png')
        self.target['sprites'][SELECTED]['frames'][0]['page'] = 0
        write_json(self.theatre / 'library.json', self.target)
        self.cli('xfer', self.theatre, self.urban, self.baseline, '--pages', '0')
        self.assertIsNone(tp.read_json(self.theatre / 'library.json')['spriteAtlasesHd'][0])

    def test_json_reread_preserves_entries_added_during_page_work(self):
        original = tp.atomic_symlink
        def link_and_update(source, destination):
            original(source, destination)
            latest = tp.read_json(self.theatre / 'library.json')
            latest['marker'] = 'new metadata'
            latest['spriteAtlasesHd'][2] = {'file': 'other-track.png'}
            write_json(self.theatre / 'library.json', latest)
            write_json(self.theatre / 'normals.json', dict(version=1, pages={'99': {'file': 'keep.png'}}))
        with mock.patch.object(tp, 'atomic_symlink', side_effect=link_and_update):
            self.assertEqual(tp.xfer(self.theatre, self.urban, self.baseline, [0]), [0])
        after = tp.read_json(self.theatre / 'library.json')
        self.assertEqual(after['marker'], 'new metadata')
        self.assertEqual(after['spriteAtlasesHd'][2], {'file': 'other-track.png'})
        self.assertEqual(tp.read_json(self.theatre / 'normals.json')['pages']['99'], {'file': 'keep.png'})

    def test_overlay_walls_repoints_only_selected_overlay_frames_and_shadows(self):
        data = synthetic_library(self.root / 'overlays')
        directory = self.root / 'overlays'
        data['spriteAtlasesHd'][2] = None
        for name in ('GAWALL', 'NAWALL', 'GASAND', 'GAFWLL'):
            building = copy.deepcopy(data['sprites'][SELECTED])
            building['frames'] = [dict(rect=[0, 0, 4, 4], offset=[-2, -3], page=0)]
            building['shadows'] = [dict(rect=[4, 0, 4, 4], offset=[-2, 0], page=0)]
            overlay = copy.deepcopy(building)
            overlay['frames'][0]['page'] = 2
            overlay['shadows'][0]['page'] = 2
            overlay['custom'] = 'overlay metadata'
            data['sprites'][f'building:{name}'] = building
            data['sprites'][f'overlay:{name}'] = overlay
        data['sprites']['building:NAWALL']['frames'][0]['page'] = 2  # No HD.
        data['sprites']['overlay:GASAND']['frames'][0]['offset'][0] = -9  # Different geometry.
        data['sprites']['overlay:GAFWLL']['frames'].append(copy.deepcopy(data['sprites']['overlay:GAFWLL']['frames'][0]))
        write_json(directory / 'library.json', data)
        before = {sid: json.dumps(sprite).encode() for sid, sprite in data['sprites'].items()}
        files = {p.name: p.read_bytes() for p in directory.iterdir() if p.suffix == '.png'}
        self.cli('overlay-walls', directory, 'GAWALL', 'NAWALL', 'GASAND', 'GAFWLL', 'MISSING')
        after = tp.read_json(directory / 'library.json')
        wall = after['sprites']['overlay:GAWALL']
        self.assertEqual(wall['frames'], data['sprites']['building:GAWALL']['frames'])
        self.assertEqual(wall['shadows'], data['sprites']['building:GAWALL']['shadows'])
        self.assertEqual(wall['custom'], 'overlay metadata')
        for sid, content in before.items():
            if sid != 'overlay:GAWALL':
                self.assertEqual(json.dumps(after['sprites'][sid]).encode(), content)
        for key in data:
            if key != 'sprites':
                self.assertEqual(after[key], data[key])
        for name, content in files.items():
            self.assertEqual((directory / name).read_bytes(), content)

    def test_page_claimed_before_json_publish_keeps_its_hd_and_material_entry(self):
        owned_hd = dict(file='owned.png', remap='owned-remap.png')
        owned_materials = dict(version=1, pages={'0': {'file': 'owned-material.png', 'atlas': 'owned.png'}})
        original = tp.atomic_symlink
        def link_and_claim(source, destination):
            original(source, destination)
            latest = tp.read_json(self.theatre / 'library.json')
            latest['spriteAtlasesHd'][0] = owned_hd
            write_json(self.theatre / 'library.json', latest)
            write_json(self.theatre / 'normals.json', owned_materials)
        with mock.patch.object(tp, 'atomic_symlink', side_effect=link_and_claim):
            self.assertEqual(tp.xfer(self.theatre, self.urban, self.baseline, [0]), [])
        self.assertEqual(tp.read_json(self.theatre / 'library.json')['spriteAtlasesHd'][0], owned_hd)
        self.assertEqual(tp.read_json(self.theatre / 'normals.json'), owned_materials)

    def normals_setup(self, factor=1):
        library = self.root / 'library'
        data = synthetic_library(library)
        # Selected sprites use only pages 0/1; page 2 belongs to somebody else.
        data['sprites'][SELECTED]['frames'] = data['sprites'][SELECTED]['frames'][:2]
        write_json(library / 'library.json', data)
        existing = materials(library, data, pages=(0, 2), value=10, factor=factor)
        existing['pages']['0']['frames'] = 7
        existing['pages']['99'] = {'file': 'untouched.png', 'custom': 'keep'}
        # Both entries reference a shared physical file; COW must preserve page 2.
        existing['pages']['2']['file'] = existing['pages']['0']['file']
        write_json(library / 'shared-normals.json', existing)
        (library / 'normals.json').unlink()
        (library / 'normals.json').symlink_to('shared-normals.json')
        source = self.root / 'materials'
        source.mkdir()
        generated = materials(source, data, value=200, factor=factor)
        sprites = self.root / 'sprites.txt'
        sprites.write_text(SELECTED + '\nmissing:sprite\n', encoding='utf-8')
        return library, source, sprites, data, existing, generated

    def test_normals_merge_changes_only_selected_rects_adds_page_and_preserves_other_entries(self):
        library, source, sprites, data, existing, generated = self.normals_setup()
        before = {p.name: p.read_bytes() for p in library.iterdir()}
        source_before = {p.name: p.read_bytes() for p in source.iterdir()}
        self.cli('normals-merge', source, library, sprites)
        after = tp.read_json(library / 'normals.json')
        self.assertFalse((library / 'normals.json').is_symlink())
        for key in existing:
            if key != 'pages':
                self.assertEqual(after[key], existing[key])
        for page in ('2', '99'):
            self.assertEqual(after['pages'][page], existing['pages'][page])
        for page in ('0', '1'):
            entry = after['pages'][page]
            output = tp.read_image(library / entry['file'])
            np.testing.assert_array_equal(output[:, :4], tp.read_image(source / generated['pages'][page]['file'])[:, :4])
            baseline = tp.read_image(library / existing['pages']['0']['file']) if page == '0' else np.zeros_like(output)
            np.testing.assert_array_equal(output[:, 4:], baseline[:, 4:])
        self.assertEqual(after['pages']['0']['frames'], 7)
        self.assertEqual(after['pages']['1']['frames'], 1)
        for name, content in before.items():
            if name != 'normals.json':
                self.assertEqual((library / name).read_bytes(), content)
        self.assertEqual(tp.read_json(library / 'library.json'), data)
        for name, content in source_before.items():
            self.assertEqual((source / name).read_bytes(), content)

    def test_normals_merge_supports_2x_material_rects_and_rereads_json(self):
        library, source, sprites, _, existing, _ = self.normals_setup(factor=2)
        original = tp.atomic_image
        def save_and_update(path, pixels):
            original(path, pixels)
            latest = tp.read_json(library / 'normals.json')
            latest['custom'] = 'new metadata'
            latest['pages']['98'] = {'file': 'another.png'}
            write_json(library / 'normals.json', latest)
        with mock.patch.object(tp, 'atomic_image', side_effect=save_and_update):
            self.assertEqual(tp.normals_merge(source, library, sprites), ['0', '1'])
        after = tp.read_json(library / 'normals.json')
        output = tp.read_image(library / after['pages']['0']['file'])
        np.testing.assert_array_equal(output[:, :8], tp.read_image(source / 'material-0.png')[:, :8])
        np.testing.assert_array_equal(output[:, 8:], tp.read_image(library / existing['pages']['0']['file'])[:, 8:])
        self.assertEqual(after['custom'], 'new metadata')
        self.assertEqual(after['pages']['98'], {'file': 'another.png'})

    def test_normals_merge_skips_atlas_mismatch_incompatible_layout_and_empty_material(self):
        library, source, sprites, _, existing, generated = self.normals_setup()
        generated['pages']['0']['atlas'] = 'wrong.png'
        generated['pages']['1']['materialWidth'] = 16
        generated['pages']['1']['materialHeight'] = 8
        existing['pages']['1'] = dict(generated['pages']['1'], materialWidth=8, materialHeight=4, file='material-0.png')
        write_json(library / 'normals.json', existing)
        Image.new('RGBA', (16, 8), (1, 2, 3, 255)).save(source / 'material-1.png')
        write_json(source / 'normals.json', generated)
        before = (library / 'normals.json').read_bytes()
        self.assertEqual(tp.normals_merge(source, library, sprites), [])
        self.assertEqual((library / 'normals.json').read_bytes(), before)
        generated['pages']['0']['atlas'] = 'hd-0.png'
        Image.new('RGBA', (8, 4), (1, 2, 3, 0)).save(source / 'material-0.png')
        write_json(source / 'normals.json', generated)
        self.assertEqual(tp.normals_merge(source, library, sprites), [])
        self.assertEqual((library / 'normals.json').read_bytes(), before)

    def test_cli_help_and_invalid_pages_do_not_require_assets(self):
        self.assertIn('normals-merge', self.cli('--help').stdout)
        result = subprocess.run([sys.executable, '-B', tp.__file__, 'xfer', 'absent', 'absent', 'absent',
                                 '--pages', '-1'], capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('nonnegative', result.stderr)


if __name__ == '__main__':
    unittest.main()


class PatchToolTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='.tmp-theatre-patch-', dir=Path(__file__).parent)
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)

    def cli(self, *arguments):
        result = subprocess.run([sys.executable, '-B', tp.__file__, *map(str, arguments)],
                                capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        return result.stdout

    def test_copy_patches_only_where_indices_offsets_and_palette_colours_match(self):
        a, b = synthetic_library(self.root / 'temperate'), synthetic_library(self.root / 'desert')
        index = np.asarray(Image.open(self.root / 'desert' / 'index-1.png')).copy()
        index[0, 0] = 7  # page 1 differs in the destination theatre
        Image.fromarray(index).save(self.root / 'desert' / 'index-1.png')
        src, dst = self.root / 'patches_t', self.root / 'patches_d'
        src.mkdir()
        for k in range(3):
            Image.new('RGBA', (8, 8), (200, 10 + k, 30, 255)).save(src / f'building_SELECTED#{k}.png')
            Image.new('L', (8, 8), 255).save(src / f'building_SELECTED#{k}-remap.png')
        Image.new('RGBA', (8, 8), (1, 2, 3, 255)).save(src / 'building_MISSING#0.png')
        Image.new('L', (8, 8), 0).save(src / 'building_MISSING#0-remap.png')
        self.assertIn('copied 2 skipped 2', self.cli('copy-patches', self.root / 'temperate', self.root / 'desert', src, dst))
        self.assertTrue((dst / 'building_SELECTED#0.png').exists() and (dst / 'building_SELECTED#2-remap.png').exists())
        self.assertFalse((dst / 'building_SELECTED#1.png').exists())
        self.assertEqual((dst / 'building_SELECTED#0.src').read_text(), 'xfer:theatre temperate')
        # A palette difference on a used index blocks the copy as well.
        Image.new('RGB', (256, 1), (90, 100, 111)).save(self.root / 'desert' / 'palette.png')
        self.assertIn('copied 0 skipped 4', self.cli('copy-patches', self.root / 'temperate', self.root / 'desert', src, self.root / 'none'))

    def test_map_paste_materialises_symlinked_atlas_and_changes_only_frame_rects(self):
        shared, m = self.root / 'shared', self.root / 'map'
        shared.mkdir(); m.mkdir()
        Image.new('RGBA', (40, 20), (9, 9, 9, 255)).save(shared / 'sprites@2x.png')
        Image.new('L', (40, 20), 0).save(shared / 'sprites@2x-remap.png')
        for name in ('sprites@2x.png', 'sprites@2x-remap.png'):
            (m / name).symlink_to(shared / name)
        write_json(m / 'manifest.json', dict(spriteAtlasHd=dict(file='sprites@2x.png', remap='sprites@2x-remap.png', scale=2),
                                             sprites={'building:CAOILD': dict(frames=[dict(rect=[2, 1, 3, 2], offset=[0, 0])],
                                                                              sourceFrames=[1])}))
        patches = self.root / 'patches'; patches.mkdir()
        Image.new('RGBA', (6, 4), (200, 100, 50, 255)).save(patches / 'building_CAOILD#1.png')
        Image.new('L', (6, 4), 255).save(patches / 'building_CAOILD#1-remap.png')
        self.assertIn('pasted 1', self.cli('map-paste', m, patches, 'building:CAOILD', 'building:ABSENT'))
        self.assertFalse((m / 'sprites@2x.png').is_symlink())
        colour = np.asarray(Image.open(m / 'sprites@2x.png'))
        remap = np.asarray(Image.open(m / 'sprites@2x-remap.png'))
        np.testing.assert_array_equal(colour[2:6, 4:10, :3], np.full((4, 6, 3), [200, 100, 50]))
        self.assertEqual(int(colour[0, 0, 0]), 9)
        self.assertTrue((remap[2:6, 4:10] == 255).all() and remap[0, 0] == 0)
        np.testing.assert_array_equal(np.asarray(Image.open(shared / 'sprites@2x.png'))[2:6, 4:10, 0], np.full((4, 6), 9))
