"""Asset-free theatre page acceptance using tiny synthetic libraries only."""

import contextlib
import copy
import fcntl
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

import cv2
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

    def test_mixed_material_scales_resample_shared_blocks_to_each_target_scale(self):
        scaled = materials(self.urban, self.source, pages=(0,), factor=2)
        self.source_materials['pages']['0'] = scaled['pages']['0']
        write_json(self.urban / 'normals.json', self.source_materials)
        pixels = {}
        for page, shape in ((0, (8, 16, 4)), (1, (4, 8, 4))):
            pixels[page] = (np.arange(np.prod(shape)).reshape(shape) % 251).astype(np.uint8)
            Image.fromarray(pixels[page]).save(self.urban / f'material-{page}.png')
        for sid, source_page in ((SELECTED, 0), (OTHER, 1)):
            frame = self.source['sprites'][sid]['frames'][source_page]
            self.source['sprites'][sid]['frames'] = [copy.deepcopy(frame), copy.deepcopy(frame)]
            self.target['sprites'][sid]['frames'] = [dict(frame, page=page) for page in (0, 1)]
        for page in (0, 1):
            index = tp.read_image(self.theatre / f'index-{page}.png')
            index[:, :4], index[:, 4:] = 40, 41
            Image.fromarray(index).save(self.theatre / f'index-{page}.png')
        write_json(self.urban / 'library.json', self.source)
        write_json(self.theatre / 'library.json', self.target)
        self.assertEqual(tp.xfer(self.theatre, self.urban, self.baseline, [0, 1]), [0, 1])
        entries = tp.read_json(self.theatre / 'normals.json')['pages']
        for page, factor in ((0, 2), (1, 1)):
            with self.subTest(page=page):
                self.assertEqual(tp.material_scale(entries[str(page)]), factor)
                expected = np.zeros((4 * factor, 8 * factor, 4), np.uint8)
                expected[:, :4 * factor] = pixels[0][:, :8] if factor == 2 else pixels[0][1::2, 1:8:2]
                expected[:, 4 * factor:] = (pixels[1][:, 4:].repeat(2, axis=0).repeat(2, axis=1)
                                             if factor == 2 else pixels[1][:, 4:])
                np.testing.assert_array_equal(tp.read_image(self.theatre / entries[str(page)]['file']), expected)

    def test_refresh_owned_regenerates_shared_colour_and_matching_material_without_mutating_old_files(self):
        # Repack one shared frame so the output is a snapshot, rather than a symlink.
        self.target['sprites'] = {SELECTED: dict(palette='unit', frames=[
            dict(rect=[4, 0, 4, 4], offset=[-2, -3], page=0)])}
        index = tp.read_image(self.theatre / 'index-0.png')
        index[:, :4] = 95
        Image.fromarray(index).save(self.theatre / 'index-0.png')
        write_json(self.theatre / 'library.json', self.target)
        self.assertEqual(tp.xfer(self.theatre, self.urban, self.baseline, [0]), [0])
        old = tp.read_json(self.theatre / 'library.json')['spriteAtlasesHd'][0]
        old_material = tp.read_json(self.theatre / 'normals.json')['pages']['0']
        before = {name: (self.theatre / name).read_bytes()
                  for name in ('library.json', 'normals.json', old['file'], old['remap'], old_material['file'])}
        colour = tp.read_image(self.urban / 'hd-0.png')
        colour[:, :8] = [210, 25, 35, 255]
        Image.fromarray(colour).save(self.urban / 'hd-0.png')
        material = tp.read_image(self.urban / 'material-0.png')
        material[:, :4] = [15, 220, 45, 255]
        Image.fromarray(material).save(self.urban / 'material-0.png')
        result = self.cli('xfer', self.theatre, self.urban, self.baseline, '--pages', '0')
        self.assertIn('theatre already has HD entry, skipped', result.stdout)
        for name, content in before.items():
            self.assertEqual((self.theatre / name).read_bytes(), content)
        self.assertEqual(tp.xfer(self.theatre, self.urban, self.baseline, [0], refresh_owned=True), [0])
        after = tp.read_json(self.theatre / 'library.json')
        new = after['spriteAtlasesHd'][0]
        new_material = tp.read_json(self.theatre / 'normals.json')['pages']['0']
        self.assertNotEqual(new['file'], old['file'])
        self.assertNotEqual(new_material['file'], old_material['file'])
        self.assertEqual(new_material['atlas'], new['file'])
        expected_colour = np.zeros_like(colour)
        expected_colour[:, 8:] = colour[:, :8]
        expected_material = np.zeros_like(material)
        expected_material[:, 4:] = material[:, :4]
        np.testing.assert_array_equal(tp.read_image(self.theatre / new['file']), expected_colour)
        np.testing.assert_array_equal(tp.read_image(self.theatre / new_material['file']), expected_material)
        np.testing.assert_array_equal(tp.read_image(self.theatre / new['remap']), tp.read_image(self.theatre / old['remap']))
        for name in (old['file'], old['remap'], old_material['file']):
            self.assertEqual((self.theatre / name).read_bytes(), before[name])
        self.assert_unowned_library_data(self.target, after)

    def test_refresh_owned_fills_missing_material_and_preserves_foreign_entries(self):
        self.assertEqual(tp.xfer(self.theatre, self.urban, self.baseline, [0]), [0])
        normals = tp.read_json(self.theatre / 'normals.json')
        del normals['pages']['0']
        write_json(self.theatre / 'normals.json', normals)
        self.assertEqual(tp.xfer(self.theatre, self.urban, self.baseline, [0], refresh_owned=True), [0])
        latest = tp.read_json(self.theatre / 'library.json')
        normals = tp.read_json(self.theatre / 'normals.json')
        self.assertEqual(normals['pages']['0']['atlas'], latest['spriteAtlasesHd'][0]['file'])
        foreign = dict(file='other.png', remap='other-remap.png')
        latest['spriteAtlasesHd'][1] = foreign
        write_json(self.theatre / 'library.json', latest)
        normals['pages']['0'] = dict(file='other-material.png', atlas='other.png', custom='keep')
        normals['pages']['1'] = dict(normals['pages']['0'])
        write_json(self.theatre / 'normals.json', normals)
        before = (self.theatre / 'normals.json').read_bytes()
        self.assertEqual(tp.xfer(self.theatre, self.urban, self.baseline, [0, 1], refresh_owned=True), [0])
        after = tp.read_json(self.theatre / 'library.json')
        self.assertNotEqual(after['spriteAtlasesHd'][0]['file'], latest['spriteAtlasesHd'][0]['file'])
        self.assertEqual(after['spriteAtlasesHd'][1], foreign)
        self.assertEqual((self.theatre / 'normals.json').read_bytes(), before)

    def test_refresh_owned_rereads_hd_entry_and_does_not_replace_a_changed_claim(self):
        self.assertEqual(tp.xfer(self.theatre, self.urban, self.baseline, [0]), [0])
        start = tp.read_json(self.theatre / 'library.json')
        old = start['spriteAtlasesHd'][0]
        original = tp.atomic_symlink
        for claim in (dict(old, file='other.png'), dict(old, file='sprites-0@2x-xfer-other.png'),
                      dict(old, owner='another writer'), None):
            with self.subTest(claim=claim):
                write_json(self.theatre / 'library.json', start)
                claimed_materials = dict(version=1, pages={'0': dict(file='other-material.png', atlas='other.png')})
                def link_and_claim(source, destination):
                    original(source, destination)
                    latest = tp.read_json(self.theatre / 'library.json')
                    latest['spriteAtlasesHd'][0] = claim
                    latest['marker'] = 'new metadata'
                    write_json(self.theatre / 'library.json', latest)
                    write_json(self.theatre / 'normals.json', claimed_materials)
                with mock.patch.object(tp, 'atomic_symlink', side_effect=link_and_claim):
                    self.assertEqual(tp.xfer(self.theatre, self.urban, self.baseline, [0], refresh_owned=True), [])
                after = tp.read_json(self.theatre / 'library.json')
                self.assertEqual(after['spriteAtlasesHd'][0], claim)
                self.assertEqual(after['marker'], 'new metadata')
                self.assertEqual(tp.read_json(self.theatre / 'normals.json'), claimed_materials)

    def test_refresh_owned_preserves_material_claimed_during_page_work(self):
        self.assertEqual(tp.xfer(self.theatre, self.urban, self.baseline, [0]), [0])
        old = tp.read_json(self.theatre / 'library.json')['spriteAtlasesHd'][0]
        claimed = dict(version=1, custom='keep', pages={'0': dict(file='other-material.png', atlas='other.png')})
        original = tp.atomic_symlink
        def link_and_claim(source, destination):
            original(source, destination)
            write_json(self.theatre / 'normals.json', claimed)
        with mock.patch.object(tp, 'atomic_symlink', side_effect=link_and_claim):
            self.assertEqual(tp.xfer(self.theatre, self.urban, self.baseline, [0], refresh_owned=True), [0])
        new = tp.read_json(self.theatre / 'library.json')['spriteAtlasesHd'][0]
        self.assertNotEqual(new['file'], old['file'])
        self.assertEqual(tp.read_json(self.theatre / 'normals.json'), claimed)

    def test_xfer_preserves_concurrent_material_change_with_the_same_atlas(self):
        self.assertEqual(tp.xfer(self.theatre, self.urban, self.baseline, [0]), [0])
        claimed = tp.read_json(self.theatre / 'normals.json')
        claimed['pages']['0']['custom'] = 'claimed while retaining the atlas'
        original = tp.atomic_symlink

        def link_and_claim(source, destination):
            original(source, destination)
            write_json(self.theatre / 'normals.json', claimed)

        with mock.patch.object(tp, 'atomic_symlink', side_effect=link_and_claim):
            self.assertEqual(tp.xfer(self.theatre, self.urban, self.baseline, [0], refresh_owned=True), [0])
        self.assertEqual(tp.read_json(self.theatre / 'normals.json'), claimed)

    def test_cli_refresh_owned_without_page_selection_replaces_only_owned_entries(self):
        self.cli('xfer', self.theatre, self.urban, self.baseline)
        before = tp.read_json(self.theatre / 'library.json')
        before['spriteAtlasesHd'][2] = dict(file='other.png', remap='other-remap.png')
        write_json(self.theatre / 'library.json', before)
        result = self.cli('xfer', self.theatre, self.urban, self.baseline, '--refresh-owned')
        self.assertIn('THEATRE_XFER_DONE [0, 1]', result.stdout)
        after = tp.read_json(self.theatre / 'library.json')
        normals = tp.read_json(self.theatre / 'normals.json')['pages']
        for page in (0, 1):
            self.assertNotEqual(after['spriteAtlasesHd'][page]['file'], before['spriteAtlasesHd'][page]['file'])
            self.assertEqual(normals[str(page)]['atlas'], after['spriteAtlasesHd'][page]['file'])
        self.assertEqual(after['spriteAtlasesHd'][2], before['spriteAtlasesHd'][2])

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

    def test_overlay_walls_uses_shared_json_lock_and_preserves_symlink_farm_sources(self):
        base = self.root / 'older'
        data = synthetic_library(base)
        building = dict(palette='unit', frames=[dict(page=0, rect=[0, 0, 4, 4], offset=[-2, -3])],
                        shadows=[dict(page=0, rect=[4, 0, 4, 4], offset=[-2, 0])])
        overlay = copy.deepcopy(building)
        for frame in overlay['frames'] + overlay['shadows']:
            frame['page'] = 2
        overlay['custom'] = 'keep overlay metadata'
        data['sprites'].update({'building:GAWALL': building, 'overlay:GAWALL': overlay})
        write_json(base / 'library.json', data)
        for name in ('.compose.lock', '.library.json.lock'):
            (base / name).touch()
        before = {path.name: path.read_bytes() for path in base.iterdir()}
        farm = self.root / 'farm' / '_library' / 'snow'
        farm.mkdir(parents=True)
        for path in base.iterdir():
            (farm / path.name).symlink_to(path)
        patch_json = tp.cache_farm.patch_json

        def checked_patch(root, relative, update):
            self.assertEqual(Path(root), farm)
            self.assertEqual(relative, 'library.json')
            with (base / '.compose.lock').open('a') as lock:
                with self.assertRaises(BlockingIOError):
                    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            patch_json(root, relative, lambda lib: lib.update(concurrent=True))

            def checked_update(lib):
                with (base / '.library.json.lock').open('a') as lock:
                    with self.assertRaises(BlockingIOError):
                        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                update(lib)

            patch_json(root, relative, checked_update)

        output = io.StringIO()
        with mock.patch.object(tp.cache_farm, 'patch_json', side_effect=checked_patch) as patched, \
                contextlib.redirect_stdout(output):
            self.assertEqual(tp.overlay_walls(farm, ('GAWALL', 'MISSING', 'GAWALL')), ['GAWALL'])
        self.assertEqual(patched.call_count, 1)
        self.assertEqual(output.getvalue(), 'GAWALL overlay -> building frames on pages [0]\n'
                         'MISSING skip (missing or frame count differs)\n')
        after = tp.read_json(farm / 'library.json')
        self.assertTrue(after['concurrent'])
        wall = after['sprites']['overlay:GAWALL']
        self.assertEqual(wall['frames'], building['frames'])
        self.assertEqual(wall['shadows'], building['shadows'])
        self.assertEqual(wall['custom'], overlay['custom'])
        self.assertFalse((farm / 'library.json').is_symlink())
        for name in ('.compose.lock', '.library.json.lock'):
            self.assertTrue((farm / name).is_symlink())
        self.assertEqual(before, {path.name: path.read_bytes() for path in base.iterdir()})

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

    def test_xfer_and_normals_merge_hold_compose_and_cache_farm_json_locks(self):
        patch_json = tp.cache_farm.patch_json
        seen = []

        def checked_patch(root, relative, update, **kwargs):
            root = Path(root)
            with (root / '.compose.lock').open('a') as lock:
                with self.assertRaises(BlockingIOError):
                    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)

            def checked_update(current):
                seen.append((root, relative))
                with (root / f'.{relative}.lock').open('a') as lock:
                    with self.assertRaises(BlockingIOError):
                        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                update(current)

            patch_json(root, relative, checked_update, **kwargs)

        with mock.patch.object(tp.cache_farm, 'patch_json', side_effect=checked_patch):
            self.assertEqual(tp.xfer(self.theatre, self.urban, self.baseline, [0]), [0])
            library, source, sprites, _, _, _ = self.normals_setup()
            self.assertEqual(tp.normals_merge(source, library, sprites), ['0', '1'])
        self.assertIn((self.theatre, 'library.json'), seen)
        self.assertIn((self.theatre, 'normals.json'), seen)
        self.assertIn((library, 'normals.json'), seen)

    def test_cli_help_and_invalid_pages_do_not_require_assets(self):
        self.assertIn('normals-merge', self.cli('--help').stdout)
        result = subprocess.run([sys.executable, '-B', tp.__file__, 'xfer', 'absent', 'absent', 'absent',
                                 '--pages', '-1'], capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('nonnegative', result.stderr)


if __name__ == '__main__':
    unittest.main()


class MapCopyPatchTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='.tmp-map-copy-', dir=Path(__file__).parent)
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.map_dir, self.library, self.src, self.dst = (self.root / n for n in ('map', 'library', 'src', 'dst'))
        for directory in (self.map_dir, self.library, self.src):
            directory.mkdir()
        palette = np.full((1, 256, 3), [90, 100, 110], np.uint8)
        Image.fromarray(palette).save(self.map_dir / 'palette.png')
        palette[0, 250] = [1, 2, 3]  # Unused palette colours do not block a copy.
        Image.fromarray(palette).save(self.library / 'palette.png')
        Image.fromarray(np.array([[0, 16, 40, 40, 41, 41]], np.uint8)).save(self.map_dir / 'index.png')
        target = np.array([[40, 42, 41, 0, 16, 40]], np.uint8)
        Image.fromarray(np.repeat(target[..., None], 3, axis=2)).save(self.library / 'sprites-1.png')
        manifest = dict(spriteAtlas=dict(file='index.png'), palettes={'map': 'palette.png'}, sprites={
            'building:GA_TEST': dict(palette='map', frames=[
                dict(rect=[x, 0, 3, 1], offset=[-2, -3]) for x in (0, 3)])})
        self.data = dict(spriteAtlases=[dict(file='unused.png'), dict(file='sprites-1.png')],
                         palettes={'unit': 'palette.png'}, sprites={
                             'building:GA_TEST': dict(palette='unit', frames=[
                                 dict(rect=[x, 0, 3, 1], offset=[-2, -3], page=1) for x in (3, 0)])})
        write_json(self.map_dir / 'manifest.json', manifest)
        write_json(self.library / 'library.json', self.data)
        for stem in ('building_GA_TEST#0', 'building_GA_TEST#1', 'building_MISSING#0'):
            Image.new('RGBA', (6, 2), (200, 10, 30, 255)).save(self.src / f'{stem}.png')
            Image.new('L', (6, 2), 127).save(self.src / f'{stem}-remap.png')

    def test_matching_map_frame_copies_colour_remap_and_default_provenance(self):
        self.assertEqual(tp.map_copy_patches(self.map_dir, self.library, self.src, self.dst), (1, 2))
        for suffix in ('.png', '-remap.png'):
            name = 'building_GA_TEST#0' + suffix
            self.assertEqual((self.dst / name).read_bytes(), (self.src / name).read_bytes())
        self.assertEqual((self.dst / 'building_GA_TEST#0.src').read_text(), 'map-copy map')
        self.assertEqual(len(list(self.dst.iterdir())), 3)

    def test_cli_prints_counts_and_uses_custom_tag(self):
        result = subprocess.run([sys.executable, '-B', tp.__file__, 'map-copy-patches', str(self.map_dir),
                                 str(self.library), str(self.src), str(self.dst), '--tag', 'l4civ synthetic'],
                                capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, 'copied 1 skipped 2\n')
        self.assertEqual((self.dst / 'building_GA_TEST#0.src').read_text(), 'l4civ synthetic')

    def test_shape_offset_and_every_used_palette_colour_must_match(self):
        original = copy.deepcopy(self.data)
        palette = tp.read_image(self.library / 'palette.png')
        for mismatch in ('shape', 'offset', 0, 16, 40):
            with self.subTest(mismatch=mismatch):
                self.data = copy.deepcopy(original)
                changed = palette.copy()
                frame = self.data['sprites']['building:GA_TEST']['frames'][0]
                if mismatch == 'shape':
                    frame['rect'][2] = 2
                elif mismatch == 'offset':
                    frame['offset'][0] += 1
                else:
                    changed[0, mismatch] = [1, 2, 3]
                write_json(self.library / 'library.json', self.data)
                Image.fromarray(changed).save(self.library / 'palette.png')
                self.assertEqual(tp.map_copy_patches(self.map_dir, self.library, self.src, self.dst), (0, 3))
                self.assertEqual(list(self.dst.iterdir()), [])


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


class VariantTransferTests(unittest.TestCase):
    """Exercise visible transfer results and farm publication without game assets."""

    sprite_id = 'building:VARIANT'

    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='.tmp-variant-', dir=Path(__file__).parent)
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.urban, self.theatre, self.baseline = (self.root / n for n in ('urban', 'variant', 'baseline'))
        for directory in (self.urban, self.theatre, self.baseline):
            directory.mkdir()
        self.indices = np.full((24, 24), 40, np.uint8)
        self.palette = np.full((1, 256, 3), [90, 100, 110], np.uint8)
        self.palette[0, 41] = [170, 180, 190]
        # Fine, asymmetric structure makes incorrect detail and offset copies visible.
        y, x = np.indices((48, 48))
        self.colour = np.empty((48, 48, 4), np.uint8)
        self.colour[..., 0] = 70 + x * 2 + (y % 2) * 30
        self.colour[..., 1] = 80 + y * 2
        self.colour[..., 2] = 120 + ((x + y) % 2) * 50
        self.colour[..., 3] = 255
        self.remap = ((x * 3 + y * 5) % 251).astype(np.uint8)
        self.material = np.full((24, 24, 4), [70, 90, 120, 240], np.uint8)
        self.source = self.write_library(self.urban, self.indices, hd=True)
        self.target = self.write_library(self.theatre, self.indices)
        Image.fromarray(self.colour).save(self.urban / 'hd.png')
        Image.fromarray(self.remap).save(self.urban / 'remap.png')
        Image.fromarray(self.material).save(self.urban / 'material.png')
        write_json(self.urban / 'normals.json', dict(version=1, encoding='oct-normal-rg-gloss-b-mask-a', pages={
            '0': dict(file='material.png', atlas='hd.png', width=48, height=48,
                      materialWidth=24, materialHeight=24, scale=2)}))
        self.write_baseline(self.indices)

    def write_library(self, directory, indices, hd=False, offset=(0, 0)):
        height, width = indices.shape
        Image.fromarray(indices).save(directory / 'index.png')
        Image.fromarray(self.palette).save(directory / 'palette.png')
        library = dict(palettes={'unit': 'palette.png'},
                       spriteAtlases=[dict(file='index.png', width=width, height=height)],
                       spriteAtlasesHd=[dict(file='hd.png', remap='remap.png', scale=2,
                                             width=2 * width, height=2 * height) if hd else None],
                       sprites={self.sprite_id: dict(palette='unit', frames=[
                           dict(page=0, rect=[0, 0, width, height], offset=list(offset))])}, marker='keep')
        write_json(directory / 'library.json', library)
        return library

    def write_baseline(self, indices, page=0):
        height, width = indices.shape
        self.base_colour = np.full((2 * height, 2 * width, 4), [180, 190, 210, 255], np.uint8)
        self.base_colour[..., 3] = (indices > 0).repeat(2, axis=0).repeat(2, axis=1) * 255
        self.base_remap = np.full((2 * height, 2 * width), 13, np.uint8)
        Image.fromarray(self.base_colour).save(self.baseline / f'sprites-{page}@2x.png')
        Image.fromarray(self.base_remap).save(self.baseline / f'sprites-{page}@2x-remap.png')

    def change_patch(self):
        changed = self.indices.copy()
        changed[10:13, 10:13] = 41
        Image.fromarray(changed).save(self.theatre / 'index.png')
        return changed

    def outputs(self, page=0):
        library = tp.read_json(self.theatre / 'library.json')
        entry = library['spriteAtlasesHd'][page]
        colour = tp.read_image(self.theatre / entry['file'], 'RGBA')
        remap = tp.read_image(self.theatre / entry['remap'], 'L')
        material_entry = tp.read_json(self.theatre / 'normals.json')['pages'][str(page)]
        material = tp.read_image(self.theatre / material_entry['file'], 'RGBA')
        self.assertEqual(material_entry['atlas'], entry['file'])
        self.assertEqual(tp.material_scale(material_entry), 2)
        return entry, colour, remap, material

    def assert_counts(self, exact=0, variant=0, baseline=0, qa=0, page=0):
        report = tp.read_json(self.theatre / 'variant-xfer-report.json')
        expected = dict(urban_exact=exact, variant=variant, baseline=baseline, qa_silhouette_failures=qa)
        self.assertEqual(report['sprites'][self.sprite_id], expected)
        for key, value in expected.items():
            self.assertEqual(report['pages'][str(page)][key], value)
        self.assertTrue(report['pages'][str(page)]['published'])
        return report

    def assert_silhouette(self, colour, indices):
        alpha = colour[..., 3].astype(np.float32).reshape(indices.shape[0], 2, indices.shape[1], 2).mean((1, 3))
        self.assertGreaterEqual(np.mean((alpha > 127.5) == (indices > 0)), 0.995)

    def test_identical_frame_copies_urban_colour_remap_and_material_exactly(self):
        self.assertEqual(tp.variant_xfer(self.theatre, self.urban, self.baseline), [0])
        entry, colour, remap, material = self.outputs()
        self.assertRegex(entry['file'], r'^sprites-0@2x-vxfer-[0-9a-f]+\.png$')
        np.testing.assert_array_equal(colour, self.colour)
        np.testing.assert_array_equal(remap, self.remap)
        np.testing.assert_array_equal(material, self.material.repeat(2, axis=0).repeat(2, axis=1))
        self.assert_silhouette(colour, self.indices)
        self.assert_counts(exact=1)

    def test_dither_only_index_differences_below_tolerance_copy_urban_exactly(self):
        palette = self.palette.copy()
        palette[0, 42] = [92, 103, 111]
        Image.fromarray(palette).save(self.theatre / 'palette.png')
        changed = self.indices.copy()
        changed[::2] = 42
        changed[:, ::2] = 42
        Image.fromarray(changed).save(self.theatre / 'index.png')
        self.assertEqual(tp.variant_xfer(self.theatre, self.urban, self.baseline), [0])
        _, colour, remap, material = self.outputs()
        np.testing.assert_array_equal(colour, self.colour)
        np.testing.assert_array_equal(remap, self.remap)
        np.testing.assert_array_equal(material, self.material.repeat(2, 0).repeat(2, 1))
        self.assert_counts(exact=1)

    def test_white_blob_closes_holes_and_removes_one_and_two_pixel_speckles(self):
        palette = self.palette.copy()
        palette[0, 41] = [245, 245, 245]
        Image.fromarray(palette).save(self.theatre / 'palette.png')
        changed = self.indices.copy()
        changed[8:15, 8:15] = 41
        changed[11, 11] = 40
        changed[2, 2] = 41
        changed[20, 2:4] = 41
        Image.fromarray(changed).save(self.theatre / 'index.png')
        expected = np.zeros_like(changed, dtype=bool)
        expected[8:15, 8:15] = True
        mask = tp.variant_mask(changed, self.indices, palette[0], self.palette[0])
        np.testing.assert_array_equal(mask, expected)
        self.assertEqual(tp.variant_xfer(self.theatre, self.urban, self.baseline, detail=0), [0])
        _, colour, _, _ = self.outputs()
        np.testing.assert_array_equal(colour[16:30, 16:30], self.base_colour[16:30, 16:30])
        for region in ((slice(4, 6), slice(4, 6)), (slice(40, 42), slice(4, 8))):
            np.testing.assert_array_equal(colour[region], self.colour[region])
        self.assert_counts(variant=1)

    def test_colour_components_use_eight_connectivity_and_minimum_area(self):
        changed = self.indices.copy()
        changed[6, 6] = changed[7, 7] = changed[8, 8] = 41
        changed[17, 17] = changed[18, 18] = 41
        mask = tp.variant_mask(changed, self.indices, self.palette[0], self.palette[0])
        self.assertTrue(mask[6, 6] and mask[7, 7] and mask[8, 8])
        self.assertFalse(mask[17, 17] or mask[18, 18])
        self.assertFalse(tp.variant_mask(changed, self.indices, self.palette[0], self.palette[0],
                                         min_area=4).any())

    def test_delta_e_uses_lab_units_and_a_strict_tolerance(self):
        palette = self.palette[0].copy()
        palette[40], palette[41] = [0, 0, 0], [255, 255, 255]
        changed = np.full_like(self.indices, 41)
        # Black and white differ by exactly 100 in CIE76, not the uint8 Lab scale.
        self.assertFalse(tp.variant_mask(changed, self.indices, palette, palette, tolerance=100).any())
        self.assertTrue(tp.variant_mask(changed, self.indices, palette, palette, tolerance=99).all())

    def test_exactly_one_house_paint_index_changes_even_with_identical_colours(self):
        changed = self.indices.copy()
        changed[10:13, 10:13] = 16
        Image.fromarray(changed).save(self.theatre / 'index.png')
        for directory, library in ((self.urban, self.source), (self.theatre, self.target)):
            library['sprites'][self.sprite_id]['remap'] = True
            write_json(directory / 'library.json', library)
        for target, source in ((changed, self.indices), (self.indices, changed)):
            mask = tp.variant_mask(target, source, self.palette[0], self.palette[0], remap=True)
            np.testing.assert_array_equal(mask, changed == 16)
        self.assertEqual(tp.variant_xfer(self.theatre, self.urban, self.baseline, detail=0), [0])
        _, colour, remap, _ = self.outputs()
        np.testing.assert_array_equal(colour[20:26, 20:26], self.base_colour[20:26, 20:26])
        np.testing.assert_array_equal(remap[20:26, 20:26], self.base_remap[20:26, 20:26])
        self.assert_counts(variant=1)

    def test_tiny_alpha_addition_and_removal_survive_colour_cleanup(self):
        changed, source = self.indices.copy(), self.indices.copy()
        changed[4, 4] = 0
        source[19, 19] = 0
        Image.fromarray(changed).save(self.theatre / 'index.png')
        Image.fromarray(source).save(self.urban / 'index.png')
        self.colour[38:40, 38:40, 3] = 0
        Image.fromarray(self.colour).save(self.urban / 'hd.png')
        self.write_baseline(changed)
        mask = tp.variant_mask(changed, source, self.palette[0], self.palette[0], min_area=1000)
        np.testing.assert_array_equal(mask, (changed > 0) ^ (source > 0))
        self.assertEqual(tp.variant_xfer(self.theatre, self.urban, self.baseline, detail=0, min_area=1000), [0])
        _, colour, _, _ = self.outputs()
        for region in ((slice(8, 10), slice(8, 10)), (slice(38, 40), slice(38, 40))):
            np.testing.assert_array_equal(colour[region], self.base_colour[region])
        self.assert_silhouette(colour, changed)
        self.assert_counts(variant=1)

    def test_three_by_three_patch_keeps_distant_redraw_and_adds_lab_detail(self):
        changed = self.change_patch()
        self.assertEqual(tp.variant_xfer(self.theatre, self.urban, self.baseline, detail=0.35), [0])
        _, colour, _, _ = self.outputs()
        np.testing.assert_array_equal(colour[:8, :8], self.colour[:8, :8])
        urban_lab = cv2.cvtColor(self.colour[..., :3].astype(np.float32) / 255, cv2.COLOR_RGB2Lab)
        baseline_lab = cv2.cvtColor(self.base_colour[..., :3].astype(np.float32) / 255, cv2.COLOR_RGB2Lab)
        detail = urban_lab[..., 0] - cv2.GaussianBlur(urban_lab[..., 0], (0, 0), 1.5)
        baseline_lab[..., 0] = np.clip(baseline_lab[..., 0] + 0.35 * detail, 0, 100)
        expected = np.rint(np.clip(cv2.cvtColor(baseline_lab, cv2.COLOR_Lab2RGB), 0, 1) * 255).astype(np.uint8)
        np.testing.assert_allclose(colour[20:26, 20:26, :3], expected[20:26, 20:26], atol=2)
        self.assertGreater(np.max(np.abs(colour[20:26, 20:26, :3].astype(int)
                                        - self.base_colour[20:26, 20:26, :3].astype(int))), 1)
        self.assert_silhouette(colour, changed)
        report = self.assert_counts(variant=1)
        self.assertEqual(report['parameters'], dict(detail=0.35, max_changed=0.6, tolerance=14, min_area=3))

    def test_material_and_remap_use_urban_outside_changed_region_and_baseline_inside(self):
        self.change_patch()
        self.assertEqual(tp.variant_xfer(self.theatre, self.urban, self.baseline, detail=0), [0])
        _, colour, remap, material = self.outputs()
        np.testing.assert_array_equal(colour[20:26, 20:26], self.base_colour[20:26, 20:26])
        np.testing.assert_array_equal(remap[20:26, 20:26], self.base_remap[20:26, 20:26])
        np.testing.assert_array_equal(remap[:8, :8], self.remap[:8, :8])
        np.testing.assert_array_equal(material[20:26, 20:26],
                                      np.full((6, 6, 4), [128, 128, 0, 255], np.uint8))
        np.testing.assert_array_equal(material[:8, :8], self.material[:4, :4].repeat(2, 0).repeat(2, 1))

    def test_aliased_variant_frames_do_not_accumulate_detail_or_feathering(self):
        self.change_patch()
        self.assertEqual(tp.variant_xfer(self.theatre, self.urban, self.baseline), [0])
        _, expected_colour, expected_remap, _ = self.outputs()
        for library in (self.source, self.target):
            frames = library['sprites'][self.sprite_id]['frames']
            frames.append(copy.deepcopy(frames[0]))
        write_json(self.urban / 'library.json', self.source)
        write_json(self.theatre / 'library.json', self.target)
        self.assertEqual(tp.variant_xfer(self.theatre, self.urban, self.baseline), [0])
        entry = tp.read_json(self.theatre / 'library.json')['spriteAtlasesHd'][0]
        np.testing.assert_array_equal(tp.read_image(self.theatre / entry['file']), expected_colour)
        np.testing.assert_array_equal(tp.read_image(self.theatre / entry['remap']), expected_remap)
        self.assert_counts(variant=2)

    def test_2x_materials_rgba_red_indices_and_square_palettes_preserve_transfer(self):
        changed = self.change_patch()
        y, x = np.indices((48, 48))
        material = np.stack((30 + x * 2, 60 + y * 2, (x + y) % 3 * 80, np.full_like(x, 240)), axis=-1)
        material = material.astype(np.uint8)
        Image.fromarray(material).save(self.urban / 'material.png')
        normals = tp.read_json(self.urban / 'normals.json')
        normals['pages']['0'].update(materialWidth=48, materialHeight=48)
        write_json(self.urban / 'normals.json', normals)
        self.assertEqual(tp.variant_xfer(self.theatre, self.urban, self.baseline), [0])
        _, expected_colour, expected_remap, expected_material = self.outputs()
        np.testing.assert_array_equal(expected_material[:8, :8], material[:8, :8])
        np.testing.assert_array_equal(expected_material[20:26, 20:26],
                                      np.full((6, 6, 4), [128, 128, 0, 255], np.uint8))
        # Only red carries indices; different unused channels must not change the result.
        for directory, indices, channels in ((self.urban, self.indices, (42, 200, 0)),
                                             (self.theatre, changed, (255, 0, 137))):
            rgba = np.empty((*indices.shape, 4), np.uint8)
            rgba[..., 0], rgba[..., 1:] = indices, channels
            Image.fromarray(rgba).save(directory / 'index.png')
            Image.fromarray(self.palette.reshape(16, 16, 3)).save(directory / 'palette.png')
        self.assertEqual(tp.variant_xfer(self.theatre, self.urban, self.baseline, refresh_owned=True), [0])
        _, colour, remap, transferred_material = self.outputs()
        np.testing.assert_array_equal(colour, expected_colour)
        np.testing.assert_array_equal(remap, expected_remap)
        np.testing.assert_array_equal(transferred_material, expected_material)
        self.assert_counts(variant=1)

    def test_grown_bbox_aligns_by_draw_origin_offset_and_preserves_new_silhouette(self):
        grown = np.full((26, 28), 40, np.uint8)
        grown[:2, :2] = 0
        self.target = self.write_library(self.theatre, grown, offset=(-2, -1))
        self.write_baseline(grown)
        self.assertEqual(tp.variant_xfer(self.theatre, self.urban, self.baseline, detail=0), [0])
        _, colour, remap, _ = self.outputs()
        # The source's top-left is 2 right and 1 down inside the larger target crop.
        np.testing.assert_array_equal(colour[18:30, 20:32], self.colour[16:28, 16:28])
        np.testing.assert_array_equal(remap[18:30, 20:32], self.remap[16:28, 16:28])
        np.testing.assert_array_equal(colour[:2, -4:], self.base_colour[:2, -4:])
        self.assert_silhouette(colour, grown)
        self.assert_counts(variant=1)

    def test_changed_fraction_over_threshold_uses_baseline_byte_for_byte(self):
        changed = self.indices.copy()
        changed[:18] = 41
        Image.fromarray(changed).save(self.theatre / 'index.png')
        self.assertEqual(tp.variant_xfer(self.theatre, self.urban, self.baseline, max_changed=0.6), [0])
        entry = tp.read_json(self.theatre / 'library.json')['spriteAtlasesHd'][0]
        np.testing.assert_array_equal(tp.read_image(self.theatre / entry['file']), self.base_colour)
        np.testing.assert_array_equal(tp.read_image(self.theatre / entry['remap']), self.base_remap)
        self.assert_counts(baseline=1)

    def test_used_palette_colour_difference_is_a_variant(self):
        changed = self.change_patch()
        Image.fromarray(changed).save(self.urban / 'index.png')
        palette = self.palette.copy()
        palette[0, 41] = [230, 235, 245]
        Image.fromarray(palette).save(self.theatre / 'palette.png')
        self.assertEqual(tp.variant_xfer(self.theatre, self.urban, self.baseline, detail=0), [0])
        _, colour, _, _ = self.outputs()
        np.testing.assert_array_equal(colour[20:26, 20:26], self.base_colour[20:26, 20:26])
        np.testing.assert_array_equal(colour[:8, :8], self.colour[:8, :8])
        self.assert_counts(variant=1)

    def test_transparent_and_house_palette_colours_do_not_make_variants(self):
        indices = self.indices.copy()
        indices[:2] = 0
        indices[10:13, 10:13] = 16
        for directory, library in ((self.urban, self.source), (self.theatre, self.target)):
            Image.fromarray(indices).save(directory / 'index.png')
            library['sprites'][self.sprite_id]['remap'] = True
            write_json(directory / 'library.json', library)
        indices[10:13, 10:13] = 17
        Image.fromarray(indices).save(self.theatre / 'index.png')
        self.colour[:4, :, 3] = 0
        Image.fromarray(self.colour).save(self.urban / 'hd.png')
        palette = self.palette.copy()
        palette[0, [0, 16, 17, 250]] = [1, 2, 3]
        Image.fromarray(palette).save(self.theatre / 'palette.png')
        self.assertEqual(tp.variant_xfer(self.theatre, self.urban, self.baseline), [0])
        _, colour, _, _ = self.outputs()
        np.testing.assert_array_equal(colour, self.colour)
        self.assert_counts(exact=1)

    def test_no_counterpart_palette_key_mismatch_missing_hd_and_empty_source_use_baseline(self):
        for reason in ('no counterpart', 'palette key', 'missing HD', 'empty source'):
            with self.subTest(reason=reason):
                source = copy.deepcopy(self.source)
                if reason == 'no counterpart':
                    source['sprites'] = {}
                elif reason == 'palette key':
                    source['palettes']['other'] = source['palettes']['unit']
                    source['sprites'][self.sprite_id]['palette'] = 'other'
                elif reason == 'missing HD':
                    source['spriteAtlasesHd'] = [None]
                else:
                    Image.fromarray(np.zeros_like(self.indices)).save(self.urban / 'index.png')
                write_json(self.urban / 'library.json', source)
                write_json(self.theatre / 'library.json', self.target)
                self.assertEqual(tp.variant_xfer(self.theatre, self.urban, self.baseline), [0])
                entry = tp.read_json(self.theatre / 'library.json')['spriteAtlasesHd'][0]
                np.testing.assert_array_equal(tp.read_image(self.theatre / entry['file']), self.base_colour)
                np.testing.assert_array_equal(tp.read_image(self.theatre / entry['remap']), self.base_remap)
                self.assert_counts(baseline=1)

    def test_source_counterpart_can_live_on_different_page_without_matching_page_hd(self):
        # The destination page number is unrelated to the counterpart's source page.
        self.target['spriteAtlases'].append(copy.deepcopy(self.target['spriteAtlases'][0]))
        self.target['spriteAtlasesHd'].append(None)
        self.target['sprites'][self.sprite_id]['frames'][0]['page'] = 1
        write_json(self.theatre / 'library.json', self.target)
        self.assertEqual(tp.variant_xfer(self.theatre, self.urban, self.baseline, [1]), [1])
        _, colour, remap, _ = self.outputs(1)
        np.testing.assert_array_equal(colour, self.colour)
        np.testing.assert_array_equal(remap, self.remap)
        self.assert_counts(exact=1, page=1)

    def test_variant_repairs_alpha_blocks_that_disagree_with_target_silhouette(self):
        changed = self.change_patch()
        changed[10, 10] = 0
        Image.fromarray(changed).save(self.theatre / 'index.png')
        # Deliberately contaminated baseline edges still must fit the 1x silhouette.
        self.base_colour[20:22, 20:22, 3] = 255
        self.base_colour[22:24, 22:24, 3] = 0
        Image.fromarray(self.base_colour).save(self.baseline / 'sprites-0@2x.png')
        self.assertEqual(tp.variant_xfer(self.theatre, self.urban, self.baseline), [0])
        _, colour, _, _ = self.outputs()
        self.assert_silhouette(colour, changed)
        self.assert_counts(variant=1)

    def test_exact_silhouette_failure_is_reported_without_mutating_urban_art(self):
        self.colour[:8, :8, 3] = 0
        Image.fromarray(self.colour).save(self.urban / 'hd.png')
        self.assertEqual(tp.variant_xfer(self.theatre, self.urban, self.baseline), [0])
        _, colour, _, _ = self.outputs()
        np.testing.assert_array_equal(colour, self.colour)
        self.assert_counts(exact=1, qa=1)

    def test_symlinked_json_and_report_are_replaced_and_refresh_is_limited_to_vxfer(self):
        shared = self.root / 'shared'
        shared.mkdir()
        for name, value in (('library.json', self.target),
                            ('normals.json', dict(version=1, pages={}, marker='shared materials')),
                            ('variant-xfer-report.json', {'marker': 'shared report'})):
            write_json(shared / name, value)
            (self.theatre / name).unlink(missing_ok=True)
            (self.theatre / name).symlink_to(shared / name)
        before = {path.name: path.read_bytes() for path in shared.iterdir()}
        self.assertEqual(tp.variant_xfer(self.theatre, self.urban, self.baseline), [0])
        for name, contents in before.items():
            self.assertFalse((self.theatre / name).is_symlink())
            self.assertEqual((shared / name).read_bytes(), contents)
        old, _, _, _ = self.outputs()
        old_bytes = (self.theatre / old['file']).read_bytes()
        self.assertEqual(tp.variant_xfer(self.theatre, self.urban, self.baseline), [])
        self.assertEqual(tp.variant_xfer(self.theatre, self.urban, self.baseline, refresh_owned=True), [0])
        new, _, _, _ = self.outputs()
        self.assertNotEqual(old['file'], new['file'])
        self.assertEqual((self.theatre / old['file']).read_bytes(), old_bytes)
        for foreign_name in ('sprites-0@2x-xfer-other.png', 'sprites-0@2x-owned.png'):
            with self.subTest(foreign_name=foreign_name):
                library = tp.read_json(self.theatre / 'library.json')
                foreign = dict(new, file=foreign_name)
                library['spriteAtlasesHd'][0] = foreign
                write_json(self.theatre / 'library.json', library)
                self.assertEqual(tp.variant_xfer(self.theatre, self.urban, self.baseline, refresh_owned=True), [])
                self.assertEqual(tp.read_json(self.theatre / 'library.json')['spriteAtlasesHd'][0], foreign)

    def test_publication_holds_compose_and_cache_farm_locks_and_rereads_metadata(self):
        patch_json = tp.cache_farm.patch_json
        seen = []

        def checked_patch(root, relative, update, **kwargs):
            root = Path(root)
            self.assertEqual(root, self.theatre)
            with (root / '.compose.lock').open('a') as lock:
                with self.assertRaises(BlockingIOError):
                    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            if relative == 'library.json':
                patch_json(root, relative, lambda current: current.update(concurrent='preserved'))

            def checked_update(current):
                seen.append(relative)
                with (root / f'.{relative}.lock').open('a') as lock:
                    with self.assertRaises(BlockingIOError):
                        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                update(current)

            patch_json(root, relative, checked_update, **kwargs)

        with mock.patch.object(tp.cache_farm, 'patch_json', side_effect=checked_patch):
            self.assertEqual(tp.variant_xfer(self.theatre, self.urban, self.baseline), [0])
        self.assertIn('library.json', seen)
        self.assertIn('normals.json', seen)
        self.assertTrue((self.theatre / '.library.json.lock').exists())
        self.assertTrue((self.theatre / '.normals.json.lock').exists())
        self.assertEqual(tp.read_json(self.theatre / 'library.json')['concurrent'], 'preserved')

    def test_refresh_preserves_concurrent_material_change_with_the_same_atlas(self):
        self.assertEqual(tp.variant_xfer(self.theatre, self.urban, self.baseline), [0])
        claimed = tp.read_json(self.theatre / 'normals.json')
        claimed['pages']['0']['custom'] = 'claimed while retaining the atlas'
        original = tp.atomic_image

        def save_and_claim(path, pixels):
            original(path, pixels)
            write_json(self.theatre / 'normals.json', claimed)

        with mock.patch.object(tp, 'atomic_image', side_effect=save_and_claim):
            self.assertEqual(tp.variant_xfer(self.theatre, self.urban, self.baseline, refresh_owned=True), [0])
        self.assertEqual(tp.read_json(self.theatre / 'normals.json'), claimed)

    def test_cli_variant_transfer_accepts_selection_threshold_and_refresh_options(self):
        self.change_patch()
        command = [sys.executable, '-B', tp.__file__, 'variant-xfer', str(self.theatre), str(self.urban),
                   str(self.baseline), '--pages', '0', '--detail', '0', '--max-changed', '0.7']
        first = subprocess.run(command + ['--tolerance', '12', '--min-area', '2'], capture_output=True, text=True)
        self.assertEqual(first.returncode, 0, first.stderr)
        self.assertIn('page 0:', first.stdout)
        self.assertIn('variant', first.stdout)
        self.assertIn('baseline', first.stdout)
        report = self.assert_counts(variant=1)
        self.assertEqual(report['parameters'], dict(detail=0.0, max_changed=0.7, tolerance=12.0, min_area=2))
        old = tp.read_json(self.theatre / 'library.json')['spriteAtlasesHd'][0]
        second = subprocess.run(command + ['--refresh-owned', '--tolerance', '100', '--min-area', '10'],
                                capture_output=True, text=True)
        self.assertEqual(second.returncode, 0, second.stderr)
        new, colour, _, _ = self.outputs()
        self.assertNotEqual(old['file'], new['file'])
        np.testing.assert_array_equal(colour, self.colour)
        report = self.assert_counts(exact=1)
        self.assertEqual(report['parameters'], dict(detail=0.0, max_changed=0.7, tolerance=100.0, min_area=10))
