"""Asset-free overlay installation acceptance using tiny copy-on-write farms."""

import contextlib
import copy
import fcntl
import io
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

from PIL import Image

import theatre_overlays as overlays


def write_json(path, data):
    path.write_text(json.dumps(data), encoding='utf-8')


def indexed_page(path, value):
    image = Image.new('P', (4, 3), value)
    image.putpalette([channel for index in range(256) for channel in (index, index, index)])
    image.save(path)


def snapshot(directory):
    # Persistent lock files are synchronization metadata, not cache content.
    return {str(path.relative_to(directory)): (path.read_bytes(), path.stat().st_mtime_ns,
                                              path.is_symlink())
            for path in directory.rglob('*') if path.is_file() and not path.name.endswith('.lock')}


class TheatreOverlaysTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='.tmp-overlays-', dir=Path(__file__).parent)
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.base = self.root / 'base' / 'snow'
        self.cache = self.root / 'farm'
        self.dest = self.cache / '_library' / 'snow'
        self.source = self.root / 'scratch' / 'snow'
        for directory in (self.base, self.dest, self.source):
            (directory / 'palettes').mkdir(parents=True)
        for page in range(2):
            indexed_page(self.base / f'sprites-{page}.png', 20 + page)
        Image.new('RGBA', (8, 6), (10, 20, 30, 255)).save(self.base / 'sprites-1@2x.png')
        Image.new('L', (8, 6), 8).save(self.base / 'sprites-1@2x-remap.png')
        for key in ('lib', 'unit'):
            Image.new('RGB', (256, 1), (40, 50, 60)).save(self.base / 'palettes' / f'{key}.png')
        self.library = dict(
            version=1, theater='snow',
            spriteAtlases=[dict(file=f'sprites-{page}.png', width=4, height=3) for page in range(2)],
            spriteAtlasesHd=[None, dict(file='sprites-1@2x.png', remap='sprites-1@2x-remap.png',
                                       scale=2, width=8, height=6, paintSaturation=0.8)],
            sprites={
                'building:X': dict(palette='unit', frames=[dict(page=1, rect=[0, 0, 2, 2], offset=[-1, -2])],
                                   shadows=[dict(page=1, rect=[2, 0, 2, 2], offset=[-1, -2])], custom=True),
                'overlay:OLD': dict(palette='lib', frames=[dict(page=0, rect=[0, 0, 1, 1])]),
            },
            palettes={key: f'palettes/{key}.png' for key in ('lib', 'unit')},
            paletteSources=dict(lib='library.pal', unit='unit.pal'),
            types={'X': dict(sprite='building:X', kind='building')},
            overlays={'OLD': dict(sprite='overlay:OLD')}, overlayExtractor={'old': True},
            smudges={'CRATER': {'sprite': 'smudge:CRATER'}}, smudgeExtractor={'keep': 1},
            extractor={'warnings': ['keep']}, voxels={'X': '../common/voxels/X.json'},
            colourSchemes=[{'keep': True}], custom={'owner': 'another track'},
        )
        write_json(self.base / 'library.json', self.library)
        for path in self.base.rglob('*'):
            if path.is_file():
                relative = path.relative_to(self.base)
                (self.dest / relative).symlink_to(path)
                shutil.copyfile(path, self.source / relative)
        self.extracted = copy.deepcopy(self.library)
        self.extracted['spriteAtlases'].append(dict(file='sprites-overlays-0.png', width=4, height=3))
        self.extracted['spriteAtlasesHd'].append(None)
        self.extracted['sprites'].pop('overlay:OLD')
        self.extracted['sprites']['overlay:TIB01'] = dict(
            palette='theater', frames=[dict(page=2, rect=[0, 0, 2, 2], offset=[-1, -2])],
            shadows=[dict(page=2, rect=[2, 0, 2, 2], offset=[-1, -2])], custom='source metadata')
        self.extracted['overlays'] = {'TIB01': dict(sprite='overlay:TIB01', tiberium=True),
                                      'RUBBLE_OVERLAY': dict(rubble=True)}
        self.extracted['overlayExtractor'] = {'types': 2, 'sprites': 1, 'warnings': []}
        for key, value in (('iso', 80), ('theater', 100)):
            Image.new('RGB', (256, 1), (value, 50, 60)).save(self.source / 'palettes' / f'{key}.png')
            self.extracted['palettes'][key] = f'palettes/{key}.png'
            self.extracted['paletteSources'][key] = f'{key}.pal'
        indexed_page(self.source / 'sprites-overlays-0.png', 42)
        self.save_source()
        self.base_before = snapshot(self.base)

    def save_source(self):
        write_json(self.source / 'library.json', self.extracted)

    def install(self):
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            summary = overlays.install(self.source, self.cache, 'snow')
        self.assertEqual(output.getvalue(), summary + '\n')
        self.assertEqual(snapshot(self.base), self.base_before)
        return summary

    def read_dest(self):
        return json.loads((self.dest / 'library.json').read_text(encoding='utf-8'))

    def append_dest_page(self, name='another-page.png', value=93):
        indexed_page(self.dest / name, value)
        overlays.cache_farm.patch_json(self.dest, 'library.json', lambda data: data['spriteAtlases'].append(
            dict(file=name, width=4, height=3)))

    def assert_overlay_page(self, library, page):
        sprite = library['sprites']['overlay:TIB01']
        for frame in sprite['frames'] + sprite['shadows']:
            self.assertEqual(frame['page'], page)
        expected = copy.deepcopy(self.extracted['sprites']['overlay:TIB01'])
        for frame in expected['frames'] + expected['shadows']:
            frame['page'] = page
        self.assertEqual(sprite, expected)

    def test_install_preserves_base_and_unrelated_data_and_extends_palettes(self):
        self.assertEqual(self.install(), 'snow: overlay types 2; pages added 1, reused 0; palettes added 2')
        after = self.read_dest()
        self.assertFalse((self.dest / 'library.json').is_symlink())
        self.assert_overlay_page(after, 2)
        self.assertNotIn('overlay:OLD', after['sprites'])
        self.assertEqual(after['sprites']['building:X'], self.library['sprites']['building:X'])
        owned = {'sprites', 'spriteAtlases', 'spriteAtlasesHd', 'palettes', 'paletteSources',
                 'overlays', 'overlayExtractor'}
        for key in self.library.keys() - owned:
            self.assertEqual(after[key], self.library[key])
        self.assertEqual(after['overlays'], self.extracted['overlays'])
        self.assertEqual(after['overlayExtractor'], self.extracted['overlayExtractor'])
        self.assertEqual(after['spriteAtlases'][:2], self.library['spriteAtlases'])
        self.assertEqual(after['spriteAtlases'][2], dict(file='sprites-overlays-0.png', width=4, height=3))
        self.assertEqual(after['spriteAtlasesHd'], self.library['spriteAtlasesHd'] + [None])
        self.assertEqual(after['palettes'], self.extracted['palettes'])
        self.assertEqual(after['paletteSources'], self.extracted['paletteSources'])
        for name in ('sprites-overlays-0.png', 'palettes/iso.png', 'palettes/theater.png'):
            self.assertFalse((self.dest / name).is_symlink())
            self.assertEqual((self.dest / name).read_bytes(), (self.source / name).read_bytes())
        for name in ('sprites-0.png', 'sprites-1.png', 'palettes/lib.png', 'palettes/unit.png'):
            self.assertTrue((self.dest / name).is_symlink())

    def test_page_appended_before_install_rebases_overlay_indices_and_pads_hd(self):
        self.append_dest_page()
        self.install()
        after = self.read_dest()
        self.assert_overlay_page(after, 3)
        self.assertEqual(after['spriteAtlases'][2]['file'], 'another-page.png')
        self.assertEqual(after['spriteAtlasesHd'], self.library['spriteAtlasesHd'] + [None, None])

    def test_reinstall_is_idempotent(self):
        self.install()
        before = self.read_dest()
        before_json = (self.dest / 'library.json').read_bytes()
        self.assertEqual(self.install(), 'snow: overlay types 2; pages added 0, reused 1; palettes added 0')
        self.assertEqual(self.read_dest(), before)
        self.assertEqual((self.dest / 'library.json').read_bytes(), before_json)
        self.assertEqual(len(self.read_dest()['spriteAtlases']), 3)

    def test_filename_clash_chooses_first_free_name(self):
        clash = self.dest / 'sprites-overlays-0.png'
        indexed_page(clash, 55)
        before = clash.read_bytes()
        self.install()
        after = self.read_dest()
        self.assertEqual(after['spriteAtlases'][2]['file'], 'sprites-overlays-1.png')
        self.assertEqual(clash.read_bytes(), before)
        self.assertEqual((self.dest / 'sprites-overlays-1.png').read_bytes(),
                         (self.source / 'sprites-overlays-0.png').read_bytes())

    def test_listed_filename_and_dangling_symlink_are_not_free(self):
        self.append_dest_page('sprites-overlays-0.png')
        (self.dest / 'sprites-overlays-0.png').unlink()
        (self.dest / 'sprites-overlays-1.png').symlink_to(self.root / 'absent')
        self.install()
        self.assertEqual(self.read_dest()['spriteAtlases'][3]['file'], 'sprites-overlays-2.png')
        self.assertTrue((self.dest / 'sprites-overlays-1.png').is_symlink())

    def test_hd_files_use_selected_stem_and_keep_metadata_and_reinstall(self):
        indexed_page(self.dest / 'sprites-overlays-0.png', 55)
        Image.new('RGBA', (8, 6), (70, 80, 90, 255)).save(self.source / 'scratch-hd.png')
        Image.new('L', (8, 6), 31).save(self.source / 'scratch-remap.png')
        self.extracted['spriteAtlasesHd'][2] = dict(file='scratch-hd.png', remap='scratch-remap.png',
                                                   scale=2, width=8, height=6, paintSaturation=0.6)
        self.save_source()
        self.install()
        after = self.read_dest()
        expected = dict(self.extracted['spriteAtlasesHd'][2], file='sprites-overlays-1@2x.png',
                        remap='sprites-overlays-1@2x-remap.png')
        self.assertEqual(after['spriteAtlasesHd'][2], expected)
        for key in ('file', 'remap'):
            self.assertFalse((self.dest / expected[key]).is_symlink())
            self.assertEqual((self.dest / expected[key]).read_bytes(),
                             (self.source / self.extracted['spriteAtlasesHd'][2][key]).read_bytes())
        self.install()
        self.assertEqual(self.read_dest(), after)

    def test_mismatched_theater_or_version_leaves_farm_unchanged(self):
        before = snapshot(self.dest)
        for key, value in (('theater', 'urban'), ('version', 2)):
            with self.subTest(key=key):
                changed = copy.deepcopy(self.extracted)
                changed[key] = value
                write_json(self.source / 'library.json', changed)
                with self.assertRaisesRegex(ValueError, 'theater|version'):
                    self.install()
                self.assertEqual(snapshot(self.dest), before)
                self.assertEqual(snapshot(self.base), self.base_before)

    def test_conflicting_palette_sources_leaves_farm_unchanged(self):
        self.extracted['paletteSources']['unit'] = 'different.pal'
        self.save_source()
        before = snapshot(self.dest)
        with self.assertRaisesRegex(ValueError, 'conflicting paletteSources for unit'):
            self.install()
        self.assertEqual(snapshot(self.dest), before)
        self.assertEqual(snapshot(self.base), self.base_before)

    def test_old_source_pages_and_their_hd_files_are_ignored(self):
        for name in ('sprites-0.png', 'sprites-1.png', 'sprites-1@2x.png', 'sprites-1@2x-remap.png'):
            (self.source / name).unlink()
        self.install()
        self.assert_overlay_page(self.read_dest(), 2)

    def test_implicit_page_zero_and_shadow_only_pages_are_remapped_in_ascending_order(self):
        # Page 0 is deliberately new content, despite the missing page property.
        indexed_page(self.source / 'sprites-0.png', 60)
        self.extracted['sprites']['overlay:TIB01']['frames'][0].pop('page')
        self.save_source()
        self.assertIn('pages added 2, reused 0', self.install())
        after = self.read_dest()
        sprite = after['sprites']['overlay:TIB01']
        self.assertEqual(sprite['frames'][0]['page'], 2)
        self.assertEqual(sprite['shadows'][0]['page'], 3)
        self.assertEqual(after['spriteAtlases'][2]['file'], 'sprites-overlays-0.png')
        self.assertEqual(after['spriteAtlases'][3]['file'], 'sprites-overlays-1.png')

    def test_identical_page_reuses_existing_atlas_with_a_different_name(self):
        self.append_dest_page(value=42)
        self.assertIn('pages added 0, reused 1', self.install())
        self.assert_overlay_page(self.read_dest(), 2)
        self.assertFalse((self.dest / 'sprites-overlays-0.png').exists())

    def test_unrelated_json_patch_between_planning_and_publication_survives(self):
        patch_json = overlays.cache_farm.patch_json

        def concurrent_patch(root, relative, update):
            patch_json(root, relative, lambda data: data.update(custom={'owner': 'updated elsewhere'}, added=True))
            patch_json(root, relative, update)

        with mock.patch.object(overlays.cache_farm, 'patch_json', side_effect=concurrent_patch):
            self.install()
        after = self.read_dest()
        self.assertEqual(after['custom'], {'owner': 'updated elsewhere'})
        self.assertTrue(after['added'])
        self.assert_overlay_page(after, 2)

    def test_changed_page_slots_abort_publication_without_losing_concurrent_patch(self):
        patch_json = overlays.cache_farm.patch_json
        concurrent = None

        def concurrent_patch(root, relative, update):
            nonlocal concurrent
            indexed_page(self.dest / 'concurrent.png', 78)
            patch_json(root, relative, lambda data: data['spriteAtlases'].append(
                dict(file='concurrent.png', width=4, height=3)))
            concurrent = (self.dest / 'library.json').read_bytes()
            patch_json(root, relative, update)

        with mock.patch.object(overlays.cache_farm, 'patch_json', side_effect=concurrent_patch), \
                self.assertRaisesRegex(ValueError, 'atlas indices changed'):
            self.install()
        self.assertEqual((self.dest / 'library.json').read_bytes(), concurrent)
        self.assertIn('overlay:OLD', self.read_dest()['sprites'])
        self.assertEqual(snapshot(self.base), self.base_before)

    def test_compose_lock_covers_file_installation_without_prelocking_json(self):
        install_file = overlays.cache_farm.install_file

        def checked_install(root, relative, source):
            with (self.dest / '.compose.lock').open('a') as lock:
                with self.assertRaises(BlockingIOError):
                    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with (self.dest / '.library.json.lock').open('a') as lock:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            install_file(root, relative, source)

        with mock.patch.object(overlays.cache_farm, 'install_file', side_effect=checked_install) as installed:
            self.install()
        self.assertEqual(installed.call_count, 3)

    def test_symlinked_farm_locks_are_used_without_writing_through(self):
        # Real farms carry the base cache's lock files as symlinks; they must lock the shared inode, never block the
        # install, and leave the base lock files empty.
        for name in ('.compose.lock', '.library.json.lock'):
            (self.base / name).touch()
            (self.dest / name).symlink_to(self.base / name)
        self.install()
        for name in ('.compose.lock', '.library.json.lock'):
            self.assertTrue((self.dest / name).is_symlink())
            self.assertEqual((self.base / name).stat().st_size, 0)
        self.assert_overlay_page(self.read_dest(), 2)

    def test_cli_prints_one_line_summary(self):
        result = subprocess.run([sys.executable, '-B', overlays.__file__, 'install',
                                 '--extracted', str(self.source), '--cache-root', str(self.cache),
                                 '--theatre', 'snow'], capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, 'snow: overlay types 2; pages added 1, reused 0; palettes added 2\n')
        self.assertEqual(snapshot(self.base), self.base_before)


if __name__ == '__main__':
    unittest.main()
