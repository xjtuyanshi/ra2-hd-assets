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
import threading
import unittest
from unittest import mock

from PIL import Image

import theatre_overlays as overlays
import ore_fields as ore
import theatre_pages as tp


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

    def prepare_one_shot(self):
        build = self.root / 'ore-build'
        build.mkdir()
        meta = dict(width=4, height=3, offset=[-3, 1], frames={
            family: [[0, 0, 2, 2] for _ in range(ore.FRAMES)] for family in ('TIB01', 'GEM01')})
        write_json(build / 'frames.json', meta)
        indexed_page(build / ore.PAGE, 51)
        Image.new('RGBA', (8, 6), (90, 80, 70, 255)).save(build / ore.HD)
        Image.new('L', (8, 6), 0).save(build / ore.REMAP)
        Image.new('RGBA', (8, 6), (40, 50, 60, 255)).save(build / ore.MAT)
        for name in ore.PAGE_FILES:
            Image.new('L', (2, 2), 7).save(self.base / name)
            (self.dest / name).symlink_to(self.base / name)
        for name in ('TIB01', 'TIB2_01', 'TIB3_01', 'GEM01'):
            self.extracted['sprites'][f'overlay:{name}'] = dict(palette='theater', custom='extracted ore', frames=[
                dict(page=2, rect=[0, 0, 2, 2], offset=[-1, -2], stage=k) for k in range(ore.FRAMES)])
            self.extracted['overlays'][name] = dict(sprite=f'overlay:{name}')
        for name in tp.WALL_TYPES:
            building = copy.deepcopy(self.library['sprites']['building:X'])
            self.library['sprites'][f'building:{name}'] = building
            old = copy.deepcopy(building)
            old['custom'] = 'previous redirect'
            self.library['sprites'][f'overlay:{name}'] = old
            wall = copy.deepcopy(building)
            wall['custom'] = 'extracted wall'
            for frame in wall['frames'] + wall['shadows']:
                frame['page'] = 2
            self.extracted['sprites'][f'overlay:{name}'] = wall
            self.extracted['overlays'][name] = dict(sprite=f'overlay:{name}')
        self.extracted['sprites']['overlay:NEW'] = dict(
            palette='theater', frames=[dict(page=2, rect=[0, 0, 1, 1])], custom='extracted new sprite')
        self.extracted['overlays']['NEW'] = dict(sprite='overlay:NEW')
        write_json(self.base / 'library.json', self.library)
        normals = dict(version=7, custom='keep', pages={'1': dict(file='older-material.png')})
        write_json(self.base / 'normals.json', normals)
        (self.dest / 'normals.json').symlink_to(self.base / 'normals.json')
        for name in ('.compose.lock', '.library.json.lock', '.normals.json.lock'):
            (self.base / name).write_bytes(b'')
            (self.dest / name).symlink_to(self.base / name)
        self.save_source()
        self.base_before = snapshot(self.base)
        return build, meta, normals

    def install_one_shot(self, build, **kwargs):
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            summary = overlays.install(self.source, self.cache, 'snow', ore_build=build, walls=True, **kwargs)
        self.assertEqual(output.getvalue(), summary + '\n')
        self.assertEqual(snapshot(self.base), self.base_before)
        return summary

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

    def test_one_shot_cli_replaces_symlinked_pages_and_json_without_changing_older_farm(self):
        build, meta, normals = self.prepare_one_shot()
        before = {str(path.relative_to(self.base)): path.read_bytes()
                  for path in self.base.rglob('*') if path.is_file()}
        result = subprocess.run([sys.executable, '-B', overlays.__file__, 'install',
                                 '--extracted', str(self.source), '--cache-root', str(self.cache),
                                 '--theatre', 'snow', '--ore-build', str(build), '--walls'],
                                capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(len(result.stdout.splitlines()), 1)
        self.assertIn('ore page 3, sprites changed 4; walls patched 4', result.stdout)
        after = self.read_dest()
        page = next(i for i, atlas in enumerate(after['spriteAtlases']) if atlas['file'] == ore.PAGE)
        self.assertEqual(page, 3)
        for name in ('TIB01', 'TIB2_01', 'TIB3_01', 'GEM01'):
            sprite = after['sprites'][f'overlay:{name}']
            self.assertEqual(sprite['custom'], 'extracted ore')
            family = 'GEM01' if name == 'GEM01' else 'TIB01'
            self.assertEqual(len(sprite['frames']), ore.FRAMES)
            for k, frame in enumerate(sprite['frames']):
                self.assertEqual(frame, dict(page=page, rect=meta['frames'][family][k],
                                             offset=meta['offset'], stage=k))
        for name in tp.WALL_TYPES:
            wall = after['sprites'][f'overlay:{name}']
            building = after['sprites'][f'building:{name}']
            self.assertEqual(wall['frames'], building['frames'])
            self.assertEqual(wall['shadows'], building['shadows'])
            self.assertEqual(wall['custom'], 'extracted wall')
        self.assertEqual(after['sprites']['overlay:NEW'], self.extracted['sprites']['overlay:NEW'])
        self.assertNotIn('overlay:OLD', after['sprites'])
        self.assertEqual(after['overlays'], self.extracted['overlays'])
        self.assertEqual(after['overlayExtractor'], self.extracted['overlayExtractor'])
        self.assertEqual(after['custom'], self.library['custom'])
        installed_normals = json.loads((self.dest / 'normals.json').read_text())
        self.assertEqual(installed_normals['version'], normals['version'])
        self.assertEqual(installed_normals['custom'], normals['custom'])
        self.assertEqual(installed_normals['pages']['1'], normals['pages']['1'])
        self.assertEqual(installed_normals['pages'][str(page)], dict(
            file=ore.MAT, atlas=after['spriteAtlasesHd'][page]['file'], width=8, height=6, scale=ore.OUT,
            materialWidth=8, materialHeight=6, frames=24))
        for name in (*ore.PAGE_FILES, 'library.json', 'normals.json'):
            self.assertFalse((self.dest / name).is_symlink())
            if name in ore.PAGE_FILES:
                self.assertEqual((self.dest / name).read_bytes(), (build / name).read_bytes())
        for name in ('.compose.lock', '.library.json.lock', '.normals.json.lock'):
            self.assertTrue((self.dest / name).is_symlink())
        self.assertEqual(before, {str(path.relative_to(self.base)): path.read_bytes()
                                  for path in self.base.rglob('*') if path.is_file()})

    def test_one_shot_publishes_library_once_after_all_files_under_compose_lock(self):
        build, _, _ = self.prepare_one_shot()
        patch_json = overlays.cache_farm.patch_json
        published = []

        def checked_patch(root, relative, update, **kwargs):
            with (self.dest / '.compose.lock').open('a') as lock:
                with self.assertRaises(BlockingIOError):
                    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            for name in (*ore.PAGE_FILES, 'sprites-overlays-0.png', 'palettes/iso.png', 'palettes/theater.png'):
                self.assertTrue((self.dest / name).is_file())
                self.assertFalse((self.dest / name).is_symlink())
            published.append(relative)
            patch_json(root, relative, update, **kwargs)

        with mock.patch.object(overlays.cache_farm, 'patch_json', side_effect=checked_patch):
            self.install_one_shot(build)
        self.assertEqual(published, ['library.json', 'normals.json'])
        before = self.read_dest()
        self.assertIn('ore page 3, sprites changed 4; walls patched 4', self.install_one_shot(build))
        self.assertEqual(self.read_dest(), before)

    def test_one_shot_preserves_concurrent_library_and_normals_patches_during_file_installation(self):
        build, _, _ = self.prepare_one_shot()
        # Reusing the overlay page lets an independent append proceed; the ore index must use the locked JSON.
        self.append_dest_page('preexisting-overlays.png', value=42)
        ready, done = threading.Event(), threading.Event()
        errors = []

        def writer():
            try:
                if not ready.wait(10):
                    raise RuntimeError('installer did not reach the interleaving point')
                indexed_page(self.dest / 'concurrent.png', 78)

                def update(lib):
                    lib['spriteAtlases'].append(dict(file='concurrent.png', width=4, height=3))
                    lib['concurrent'] = True

                overlays.cache_farm.patch_json(self.dest, 'library.json', update)
                overlays.cache_farm.patch_json(self.dest, 'normals.json', lambda data: data['pages'].update(
                    {'99': {'file': 'concurrent-material.png'}}))
            except BaseException as error:
                errors.append(error)
            finally:
                done.set()

        install_file = overlays.cache_farm.install_file

        def interleaved_install(root, relative, source):
            install_file(root, relative, source)
            if relative == ore.MAT:
                ready.set()
                self.assertTrue(done.wait(10), 'concurrent JSON writer was blocked by the compose lock')

        thread = threading.Thread(target=writer, daemon=True)
        thread.start()
        try:
            with mock.patch.object(overlays.cache_farm, 'install_file', side_effect=interleaved_install):
                self.install_one_shot(build)
        finally:
            ready.set()
            thread.join(10)
        self.assertFalse(thread.is_alive())
        self.assertEqual(errors, [])
        after = self.read_dest()
        self.assertTrue(after['concurrent'])
        self.assertEqual(after['sprites']['overlay:TIB01']['frames'][0]['page'], 4)
        normals = json.loads((self.dest / 'normals.json').read_text())
        self.assertEqual(normals['pages']['99'], {'file': 'concurrent-material.png'})
        self.assertEqual(normals['pages']['4']['atlas'], after['spriteAtlasesHd'][4]['file'])

    def test_one_shot_creates_missing_normals_and_honours_custom_wall_types(self):
        build, _, _ = self.prepare_one_shot()
        (self.dest / 'normals.json').unlink()
        result = subprocess.run([sys.executable, '-B', overlays.__file__, 'install',
                                 '--extracted', str(self.source), '--cache-root', str(self.cache),
                                 '--theatre', 'snow', '--ore-build', str(build), '--walls',
                                 '--wall-types', 'GAWALL,GAWALL,MISSING'],
                                capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('ore page 3, sprites changed 4; walls patched 1', result.stdout)
        after = self.read_dest()
        self.assertEqual(after['sprites']['overlay:GAWALL']['frames'], after['sprites']['building:GAWALL']['frames'])
        self.assertEqual(after['sprites']['overlay:NAWALL'], self.extracted['sprites']['overlay:NAWALL'])
        normals = json.loads((self.dest / 'normals.json').read_text())
        self.assertEqual(normals['version'], 1)
        self.assertEqual(set(normals['pages']), {'3'})
        self.assertEqual(snapshot(self.base), self.base_before)

    def test_invalid_ore_build_is_rejected_before_installing_files(self):
        build, meta, _ = self.prepare_one_shot()
        meta['frames']['TIB01'].pop()
        write_json(build / 'frames.json', meta)
        before = snapshot(self.dest)
        with self.assertRaisesRegex(ValueError, 'exactly 12'):
            self.install_one_shot(build)
        self.assertEqual(snapshot(self.dest), before)

    def test_failed_ore_redirection_does_not_publish_a_partial_overlay_merge(self):
        build, _, _ = self.prepare_one_shot()
        self.extracted['sprites']['overlay:TIB01']['frames'].pop()
        self.save_source()
        before = {name: (self.dest / name).read_bytes() for name in ('library.json', 'normals.json')}
        with self.assertRaisesRegex(ValueError, 'fewer than 12'):
            self.install_one_shot(build)
        for name, content in before.items():
            self.assertTrue((self.dest / name).is_symlink())
            self.assertEqual((self.dest / name).read_bytes(), content)
        self.assertEqual(snapshot(self.base), self.base_before)

    def test_optional_ore_and_wall_redirections_can_run_independently(self):
        build, _, _ = self.prepare_one_shot()
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            summary = overlays.install(self.source, self.cache, 'snow', ore_build=build)
        self.assertEqual(output.getvalue(), summary + '\n')
        self.assertIn('ore page 3, sprites changed 4; walls patched 0', summary)
        after = self.read_dest()
        self.assertEqual(after['sprites']['overlay:TIB01']['frames'][0]['page'], 3)
        self.assertEqual(after['sprites']['overlay:GAWALL'], self.extracted['sprites']['overlay:GAWALL'])
        normals_before = (self.dest / 'normals.json').read_bytes()
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            summary = overlays.install(self.source, self.cache, 'snow', walls=True)
        self.assertEqual(output.getvalue(), summary + '\n')
        self.assertIn('ore page None, sprites changed 0; walls patched 4', summary)
        after = self.read_dest()
        self.assertEqual(after['sprites']['overlay:TIB01'], self.extracted['sprites']['overlay:TIB01'])
        self.assertEqual(after['sprites']['overlay:GAWALL']['frames'], after['sprites']['building:GAWALL']['frames'])
        self.assertEqual((self.dest / 'normals.json').read_bytes(), normals_before)
        self.install()
        self.assertEqual(self.read_dest()['sprites']['overlay:GAWALL'], self.extracted['sprites']['overlay:GAWALL'])


if __name__ == '__main__':
    unittest.main()
