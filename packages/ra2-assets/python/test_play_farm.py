"""Asset-free regressions for play_farm.py (synthetic base cache, prepared batch and farm)."""

import base64
import json
import os
from pathlib import Path
import struct
import tempfile
import unittest
import zlib

import play_farm


def png(width: int, height: int) -> bytes:
    """A valid grey PNG of the given size (header and IEND are what the check reads)."""

    def chunk(kind: bytes, data: bytes) -> bytes:
        return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data))

    rows = b''.join(b'\x00' + b'\x80' * width for _ in range(height))
    return (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, 0, 0, 0, 0))
            + chunk(b'IDAT', zlib.compress(rows)) + chunk(b'IEND', b''))


def write_json(path: Path, data) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data), encoding='utf-8')


def write_map(directory: Path, *, theatre='temperate', scale=2, hd_sprites=True, grid=(4, 3)) -> dict:
    """A minimal complete map cache in the manifest layout the renderer loads."""
    directory.mkdir(parents=True)
    cells = grid[0] * grid[1]
    (directory / 'palettes').mkdir()
    (directory / 'voxels').mkdir()
    (directory / 'terrain.png').write_bytes(png(64, 32))
    (directory / 'sprites.png').write_bytes(png(32, 16))
    (directory / 'palettes' / 'iso.png').write_bytes(png(256, 1))
    write_json(directory / 'voxels' / 'htnk.json', {'id': 'htnk', 'parts': []})
    (directory / 'terrain-map.png').write_bytes(png(120, 60))
    (directory / 'terrain-water.png').write_bytes(png(120, 60))
    manifest = {
        'version': 1,
        'name': directory.name,
        'theater': theatre,
        'grid': {'width': grid[0], 'height': grid[1]},
        'cells': {
            'exists': base64.b64encode(b'\x01' * cells).decode(),
            'height': base64.b64encode(b'\x00' * cells).decode(),
            'tile': base64.b64encode(struct.pack(f'<{cells}H', *([0] * cells))).decode(),
        },
        'terrainAtlas': {'file': 'terrain.png', 'width': 64, 'height': 32},
        'tiles': [{'file': 'clear01.tem', 'rect': [0, 0, 60, 30]}],
        'spriteAtlas': {'file': 'sprites.png', 'width': 32, 'height': 16},
        'palettes': {'iso': 'palettes/iso.png'},
        'voxels': {'htnk': 'voxels/htnk.json'},
        'sprites': {'tree01': {'palette': 'iso', 'frames': [{'rect': [0, 0, 16, 16]}], 'shadows': [{'rect': [16, 0, 16, 16]}]}},
        'objects': [
            {'kind': 'terrain', 'type': 'TREE01', 'x': 1, 'y': 1, 'sprite': 'tree01', 'frame': 0},
            {'kind': 'vehicle', 'type': 'HTNK', 'x': 2, 'y': 1, 'voxel': 'htnk'},
        ],
        'terrainMap': {'file': 'terrain-map.png', 'waterMask': 'terrain-water.png', 'scale': 1, 'originX': -60,
                       'originY': 0, 'width': 120, 'height': 60},
    }
    if scale == 2:
        (directory / 'terrain-map@2x.png').write_bytes(png(240, 120))
        (directory / 'terrain-water@2x.png').write_bytes(png(240, 120))
        manifest['terrainMap'] = {'file': 'terrain-map@2x.png', 'waterMask': 'terrain-water@2x.png', 'scale': 2,
                                  'originX': -60, 'originY': 0, 'width': 240, 'height': 120}
    if hd_sprites:
        (directory / 'sprites@2x.png').write_bytes(png(64, 32))
        (directory / 'sprites@2x-remap.png').write_bytes(png(64, 32))
        manifest['spriteAtlasHd'] = {'file': 'sprites@2x.png', 'remap': 'sprites@2x-remap.png', 'scale': 2,
                                     'width': 64, 'height': 32}
    write_json(directory / 'manifest.json', manifest)
    return manifest


def write_library(root: Path, theatre='temperate') -> None:
    directory = root / '_library' / theatre
    directory.mkdir(parents=True)
    (directory / 'sprites-0.png').write_bytes(png(16, 16))
    (directory / 'sprites-0@2x.png').write_bytes(png(32, 32))
    (directory / 'sprites-0@2x-remap.png').write_bytes(png(32, 32))
    (directory / 'unit.png').write_bytes(png(256, 1))
    write_json(directory / 'library.json', {
        'types': {'HTNK': {}},
        'spriteAtlases': [{'file': 'sprites-0.png'}],
        'spriteAtlasesHd': [{'file': 'sprites-0@2x.png', 'remap': 'sprites-0@2x-remap.png'}],
        'palettes': {'unit': 'unit.png'},
        'overlays': {}, 'smudges': {},
    })
    # Non-empty sections: the check warns about a library that draws overlays and smudges from map-start art only.
    library = json.loads((directory / 'library.json').read_text())
    library['overlays'], library['smudges'] = {'GEM01': {}}, {'CRATER01': {}}
    write_json(directory / 'library.json', library)


def snapshot(root: Path) -> dict:
    """Every path under root with its link target or content: what must not change in a cache the build only reads."""
    out = {}
    for current, dirs, files in os.walk(root):
        for name in dirs + files:
            path = Path(current) / name
            out[str(path.relative_to(root))] = os.readlink(path) if path.is_symlink() else (
                path.read_bytes() if path.is_file() else None)
    return out


class BuildTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.base, self.maps, self.farm = root / 'base', root / 'batch' / 'maps', root / 'farm'
        write_library(self.base)
        (self.base / '_ui').mkdir()
        (self.base / '.lock').write_text('')
        # A curated map (HD terrain and a light sidecar), a plain one (extract only) and a review map without a batch twin.
        write_map(self.base / 'Curated')
        write_json(self.base / 'Curated' / 'lights.json', {'lights': []})
        write_map(self.base / 'Plain', scale=1, hd_sprites=False)
        write_map(self.base / 'REVIEW1')
        write_map(self.maps / 'curated')
        write_map(self.maps / 'Plain')
        write_map(self.maps / 'NewMap')
        write_map(self.maps / 'Unfinished')
        write_map(self.maps / 'NewMap__variant')
        (self.maps / 'Broken').mkdir()
        (self.maps / '_sources').mkdir()
        write_json(self.maps / 'INVENTORY.json', {'maps': [
            {'id': 'curated', 'status': 'done'}, {'id': 'Plain', 'status': 'done'},
            {'id': 'NewMap', 'status': 'done', 'active': True}, {'id': 'Unfinished', 'status': 'partial-gpu-blocked'},
            {'id': 'NewMap__variant', 'status': 'done', 'active': False}, {'id': 'Broken', 'status': 'done'},
        ]})

    def tearDown(self):
        self.tmp.cleanup()

    def test_build_links_base_and_prepared_maps_without_writing_either(self):
        before = snapshot(self.base), snapshot(self.maps)
        report = play_farm.build(self.base, self.maps, self.farm)
        self.assertEqual((snapshot(self.base), snapshot(self.maps)), before)
        self.assertEqual(report['failed'], [])
        self.assertEqual(report['installed'], ['NewMap'])
        self.assertEqual([row['map'] for row in report['superseded']], ['Plain'])
        self.assertEqual(report['kept'], [{'map': 'Curated', 'reason': 'curated base map'}])
        self.assertEqual({row['map'] for row in report['skipped']}, {'Unfinished', 'NewMap__variant', 'Broken'})
        # Everything at the top of the farm is a link: nothing was copied, lock files of the base are not taken over.
        entries = {path.name: path for path in self.farm.iterdir()}
        self.assertEqual(set(entries), {'_library', '_ui', 'Curated', 'Plain', 'REVIEW1', 'NewMap'})
        self.assertTrue(all(path.is_symlink() for path in entries.values()))
        self.assertEqual(entries['NewMap'].resolve(), (self.maps / 'NewMap').resolve())
        self.assertEqual(entries['Plain'].resolve(), (self.maps / 'Plain').resolve())
        self.assertEqual(entries['Curated'].resolve(), (self.base / 'Curated').resolve())
        self.assertFalse(os.path.isabs(os.readlink(entries['NewMap'])))
        # The game asks for maps in its own casing: no second directory differing only by case.
        self.assertFalse((self.farm / 'curated').is_symlink() and os.readlink(self.farm / 'curated').endswith('batch/maps/curated'))

        result = play_farm.verify(self.farm)
        self.assertEqual(result['failed'], [])
        self.assertEqual(result['maps'], 4)
        self.assertEqual(result['brokenTopLevelLinks'], [])

    def test_build_again_and_with_a_second_batch_keeps_what_is_installed(self):
        play_farm.build(self.base, self.maps, self.farm)
        links = snapshot(self.farm)
        again = play_farm.build(self.base, self.maps, self.farm)
        self.assertEqual(snapshot(self.farm), links)
        self.assertEqual(again['installed'], ['NewMap', 'Plain'])
        self.assertEqual(again['superseded'], [])

        second = Path(self.tmp.name) / 'campaign' / 'yr'
        write_map(second / 'ALL01UMD', theatre='temperate')
        write_map(second / 'NewMap')
        write_map(second / 'ALL02UMD__variant')
        inventory = second.parent / 'INVENTORY.json'
        write_json(inventory, {'maps': [{'id': 'ALL01UMD', 'status': 'done', 'active': True},
                                        {'id': 'NewMap', 'status': 'done'},
                                        {'id': 'ALL02UMD__variant', 'status': 'done', 'active': False}]})
        report = play_farm.build(self.base, second, self.farm, inventory)
        self.assertEqual(report['installed'], ['ALL01UMD'])
        self.assertEqual([row['map'] for row in report['kept']], ['NewMap'])
        self.assertIn('already installed from', report['kept'][0]['reason'])
        self.assertEqual((self.farm / 'NewMap').resolve(), (self.maps / 'NewMap').resolve())
        self.assertEqual([row['map'] for row in report['skipped']], ['ALL02UMD__variant'])

    def test_curated_map_with_scale_1_terrain_takes_only_the_prepared_2x_terrain(self):
        base_map = self.base / 'Lit'
        manifest = write_map(base_map, scale=1)
        write_json(base_map / 'lights.json', {'lights': []})
        write_map(self.maps / 'Lit')
        inventory = json.loads((self.maps / 'INVENTORY.json').read_text())
        inventory['maps'].append({'id': 'Lit', 'status': 'done'})
        write_json(self.maps / 'INVENTORY.json', inventory)
        before = snapshot(self.base)

        report = play_farm.build(self.base, self.maps, self.farm)
        self.assertEqual(report['terrain_upgraded'],
                         [{'map': 'Lit', 'files': ['terrain-map@2x.png', 'terrain-water@2x.png']}])
        self.assertEqual(snapshot(self.base), before)
        farm_map = self.farm / 'Lit'
        self.assertFalse(farm_map.is_symlink())
        self.assertEqual(json.loads((base_map / 'manifest.json').read_text())['terrainMap'], manifest['terrainMap'])
        patched = json.loads((farm_map / 'manifest.json').read_text())
        self.assertEqual(patched['terrainMap']['scale'], 2)
        self.assertFalse((farm_map / 'manifest.json').is_symlink())
        self.assertEqual((farm_map / 'terrain-map@2x.png').resolve(), (self.maps / 'Lit' / 'terrain-map@2x.png').resolve())
        # The curated sidecar and HD sprites stay the base's own.
        self.assertEqual((farm_map / 'lights.json').resolve(), (base_map / 'lights.json').resolve())
        self.assertEqual((farm_map / 'sprites@2x.png').resolve(), (base_map / 'sprites@2x.png').resolve())
        self.assertEqual(play_farm.verify(self.farm, only=['Lit'])['failed'], [])
        # A later build leaves the realised directory alone.
        self.assertEqual(play_farm.build(self.base, self.maps, self.farm)['kept'][-1]['map'], 'Lit')

    def test_farm_must_be_separate_from_base_and_batch(self):
        for farm in (self.base, self.base / 'farm', self.maps.parent, self.maps / 'farm'):
            with self.assertRaises(ValueError):
                play_farm.build(self.base, self.maps, farm)


class VerifyTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.farm = Path(self.tmp.name) / 'farm'
        write_library(self.farm)
        self.map = self.farm / 'TestMap'
        self.manifest = write_map(self.map)

    def tearDown(self):
        self.tmp.cleanup()

    def result(self, limit=16384):
        report = play_farm.verify(self.farm, limit)
        self.assertEqual(report['maps'], 1)
        return report['results'][0]

    def rewrite(self, change) -> None:
        change(self.manifest)
        write_json(self.map / 'manifest.json', self.manifest)

    def test_complete_map_passes_and_reports_its_size(self):
        row = self.result()
        self.assertEqual((row['errors'], row['warnings']), ([], []))
        self.assertEqual((row['theatre'], row['terrainScale'], row['maxDimension']), ('temperate', 2, 256))
        self.assertEqual(play_farm.main(['verify', '--farm', str(self.farm)]), 0)

    def test_missing_truncated_and_mis_sized_files_are_errors(self):
        (self.map / 'terrain-water@2x.png').unlink()
        data = (self.map / 'terrain-map@2x.png').read_bytes()
        (self.map / 'terrain-map@2x.png').write_bytes(data[:-12])
        (self.map / 'sprites@2x.png').write_bytes(png(60, 32))
        (self.map / 'voxels' / 'htnk.json').write_text('{', encoding='utf-8')
        errors = '\n'.join(self.result()['errors'])
        self.assertIn('terrain-water@2x.png is missing', errors)
        self.assertIn('terrain-map@2x.png is truncated', errors)
        self.assertIn('sprites@2x.png is 60x32, recorded 64x32', errors)
        self.assertIn('voxels/htnk.json does not parse', errors)
        self.assertEqual(play_farm.main(['verify', '--farm', str(self.farm)]), 1)

    def test_broken_links_count_as_missing(self):
        (self.map / 'sprites.png').unlink()
        (self.map / 'sprites.png').symlink_to(self.map / 'gone.png')
        (self.farm / 'Dangling').symlink_to(self.farm / 'nowhere')
        report = play_farm.verify(self.farm)
        self.assertIn('sprite atlas: sprites.png is missing (broken link)', report['results'][0]['errors'])
        self.assertEqual(report['brokenTopLevelLinks'], ['Dangling'])
        self.assertEqual(play_farm.main(['verify', '--farm', str(self.farm)]), 1)

    def test_texture_limit(self):
        self.assertEqual(self.result(limit=240)['errors'],
                         ['palette iso: palettes/iso.png is 256x1, above the texture limit 240'])
        self.assertEqual(self.result(limit=256)['errors'], [])

    def test_inconsistent_references_are_errors(self):
        def change(manifest):
            manifest['objects'][0]['sprite'] = 'tree99'
            manifest['sprites']['tree01']['frames'][0]['rect'] = [24, 0, 16, 16]
            manifest['tiles'][0]['rect'] = [10, 10, 60, 30]
            manifest['cells']['exists'] = base64.b64encode(b'\x01').decode()

        self.rewrite(change)
        errors = '\n'.join(self.result()['errors'])
        self.assertIn('cell arrays do not match the 4x3 grid', errors)
        self.assertIn('tile 0 (clear01.tem): rect outside the terrain atlas', errors)
        self.assertIn('sprite tree01 frame 0', errors)
        self.assertIn('sprite tree99 not in the manifest', errors)

    def test_named_terrain_depth_atlas_must_exist_at_the_atlas_size(self):
        self.rewrite(lambda manifest: manifest['terrainAtlas'].update(depth='terrain-depth.png'))
        self.assertIn('terrain depth atlas: terrain-depth.png is missing', self.result()['errors'])
        (self.map / 'terrain-depth.png').write_bytes(png(60, 30))
        self.assertIn('terrain depth atlas: terrain-depth.png is 60x30, recorded 64x32', self.result()['errors'])
        (self.map / 'terrain-depth.png').write_bytes(png(64, 32))
        self.assertEqual(self.result()['errors'], [])

    def test_paths_may_not_leave_the_farm(self):
        outside = Path(self.tmp.name) / 'outside.png'
        outside.write_bytes(png(64, 32))
        self.rewrite(lambda manifest: manifest['terrainAtlas'].update(file='../../outside.png'))
        self.assertIn("terrain atlas: path '../../outside.png' leaves the farm", self.result()['errors'])

    def test_documented_fallbacks_are_warnings(self):
        def change(manifest):
            manifest['terrainMap'] = {'file': 'terrain-map.png', 'waterMask': 'terrain-water.png', 'scale': 1,
                                      'originX': -60, 'originY': 0, 'width': 120, 'height': 60}
            del manifest['spriteAtlasHd']
            manifest['objects'].append({'kind': 'building', 'type': 'GTGCANA', 'x': 0, 'y': 0})

        self.rewrite(change)
        library = self.farm / '_library' / 'temperate' / 'library.json'
        data = json.loads(library.read_text())
        data['spriteAtlasesHd'] = [None]
        write_json(library, data)
        row = self.result()
        self.assertEqual(row['errors'], [])
        warnings = '\n'.join(row['warnings'])
        self.assertIn('no HD sprite atlas', warnings)
        self.assertIn('terrain composite is scale 1', warnings)
        self.assertIn('page 0 has no HD page', warnings)
        self.assertIn('GTGCANA x1', warnings)
        self.assertEqual(play_farm.verify(self.farm)['scale1Terrain'], ['TestMap'])

    def test_missing_library_is_an_error(self):
        (self.farm / '_library' / 'temperate' / 'sprites-0@2x-remap.png').unlink()
        self.assertIn('theatre library temperate: HD page 0 sprites-0@2x-remap.png is missing', self.result()['errors'])
        self.rewrite(lambda manifest: manifest.update(theater='snow'))
        self.assertTrue(any('theatre library snow: library.json unusable' in e for e in self.result()['errors']))
        self.rewrite(lambda manifest: manifest.update(theater='mars'))
        self.assertEqual(self.result()['errors'], ["unknown theatre 'mars'"])


if __name__ == '__main__':
    unittest.main()
