"""Asset-free native-equality, layout-transfer and copy-on-write contracts."""

import copy
import hashlib
import json
from pathlib import Path

import numpy as np
from PIL import Image
import pytest

import atlas_relayout as ar


def hashes(directory):
    return {str(path.relative_to(directory)): hashlib.sha256(path.read_bytes()).hexdigest()
            for path in directory.rglob('*') if path.is_file()}


def fixture(tmp_path):
    source, target, farm = (tmp_path / name for name in ('source', 'target', 'farm'))
    source.mkdir()
    target.mkdir()
    sprite = {'canvas': [10, 10], 'file': 'synthetic.shp', 'palette': 'unit',
              'remap': True, 'frameCount': 16, 'sourceFrames': [0, 7], 'loop': [0, 7],
              'frames': [{'rect': [1, 6, 2, 2], 'offset': [-3, -4]},
                         {'rect': [6, 1, 3, 2], 'offset': [-1, -3]}],
              'shadows': [{'rect': [2, 2, 2, 1], 'offset': [1, 2]},
                          {'rect': [0, 0, 0, 0], 'offset': [-5, -5]}]}
    target_manifest = {'version': 1, 'theater': 'synthetic', 'sprites': {'synthetic:A': sprite},
                       'spriteAtlas': {'file': 'native.png', 'width': 10, 'height': 10},
                       'palettes': {'unit': 'palette.png'}, 'lighting': {'custom': [1, 2, 3]}}
    source_manifest = copy.deepcopy(target_manifest)
    source_manifest['sprites']['synthetic:A']['frames'][0]['rect'] = [1, 1, 2, 2]
    source_manifest['sprites']['synthetic:A']['frames'][1]['rect'] = [7, 5, 3, 2]
    source_manifest['sprites']['synthetic:A']['shadows'][0]['rect'] = [9, 1, 2, 1]
    source_manifest['spriteAtlas'].update(width=14, height=8)
    source_manifest['spriteAtlasHd'] = {'file': 'hd.png', 'remap': 'remap.png', 'scale': 2,
                                      'width': 28, 'height': 16}
    hd, remap = Image.new('RGBA', (28, 16)), Image.new('L', (28, 16))
    for directory, manifest in ((source, source_manifest), (target, target_manifest)):
        image = Image.new('RGBA', (manifest['spriteAtlas']['width'], manifest['spriteAtlas']['height']))
        for field, values in (('frames', [72, 89]), ('shadows', [1, 0])):
            for frame, value in zip(manifest['sprites']['synthetic:A'][field], values):
                rect = frame['rect']
                if rect[2]:
                    image.paste((value, 0, 0, 255), ar.box(rect))
                    if directory == source:
                        hd.paste((value, value + 1, value + 2, 200), ar.box(rect, 2))
                        remap.paste(value + 3, ar.box(rect, 2))
        image.save(directory / 'native.png')
        Image.new('RGBA', (256, 1), (40, 50, 60, 255)).save(directory / 'palette.png')
        (directory / 'manifest.json').write_text(json.dumps(manifest))
    hd.save(source / 'hd.png')
    remap.save(source / 'remap.png')
    farm.mkdir()
    (farm / 'MAP').symlink_to(target, target_is_directory=True)
    return source, target, farm


def edit(directory, fn):
    path = directory / 'manifest.json'
    manifest = json.loads(path.read_text())
    fn(manifest)
    path.write_text(json.dumps(manifest))


def test_relayout_copies_body_shadow_and_remap_exactly_with_native_source_invariants(tmp_path):
    source, target, farm = fixture(tmp_path)
    before_source, before_target = hashes(source), hashes(target)
    report = ar.install(farm, source, target, 'MAP')
    actual = json.loads((farm / 'MAP/manifest.json').read_text())
    original = json.loads((target / 'manifest.json').read_text())
    ref = actual.pop('spriteAtlasHd')
    assert actual == original
    assert hashes(source) == before_source
    assert hashes(target) == before_target
    assert not (farm / 'MAP').is_symlink()
    assert not (farm / 'MAP/manifest.json').is_symlink()
    assert (farm / 'MAP/native.png').is_symlink()
    assert (farm / 'MAP/native.png').read_bytes() == (target / 'native.png').read_bytes()
    assert report['counts'] == {'frames': 2, 'shadows': 1, 'empty_shadows': 1}
    assert report['discarded_unused_source_shadow'] == []
    assert ref['width'] == ref['height'] == 20
    assert report['output_sha256']['file'] in ref['file']
    src = json.loads((source / 'manifest.json').read_text())
    with Image.open(farm / 'MAP' / ref['file']) as hd, Image.open(source / 'hd.png') as prepared, \
            Image.open(farm / 'MAP' / ref['remap']) as remap, Image.open(source / 'remap.png') as masks:
        for field in ('frames', 'shadows'):
            for frame, native in zip(original['sprites']['synthetic:A'][field], src['sprites']['synthetic:A'][field]):
                if frame['rect'][2]:
                    assert hd.crop(ar.box(frame['rect'], 2)).tobytes() == prepared.crop(ar.box(native['rect'], 2)).tobytes()
                    assert remap.crop(ar.box(frame['rect'], 2)).tobytes() == masks.crop(ar.box(native['rect'], 2)).tobytes()
        assert hd.getpixel((0, 0)) == (0, 0, 0, 0)
        assert remap.getpixel((0, 0)) == 0


@pytest.mark.parametrize('problem', ['body_pixels', 'shadow_pixels', 'palette', 'canvas', 'file',
                                   'frame_count', 'source_frames', 'offset', 'empty_body',
                                   'missing_shadow', 'shadow_offset', 'frame_oob', 'atlas_size',
                                   'mode', 'ids', 'unsafe_path', 'hd_size'])
def test_native_mismatch_fails_before_any_farm_write(tmp_path, problem):
    source, target, farm = fixture(tmp_path)
    if problem in {'body_pixels', 'shadow_pixels'}:
        with Image.open(source / 'native.png') as image:
            image.putpixel((1, 1) if problem == 'body_pixels' else (9, 1), (99, 0, 0, 255))
            image.save(source / 'native.png')
    elif problem == 'palette':
        Image.new('RGBA', (256, 1), (1, 2, 3, 255)).save(source / 'palette.png')
    elif problem == 'mode':
        Image.new('L', (14, 8)).save(source / 'native.png')
    elif problem == 'hd_size':
        Image.new('RGBA', (26, 16)).save(source / 'hd.png')
    else:
        def change(data):
            sprite = data['sprites']['synthetic:A']
            if problem == 'canvas': sprite['canvas'] = [11, 10]
            elif problem == 'file': sprite['file'] = 'unrelated.shp'
            elif problem == 'frame_count': sprite['frameCount'] = 18
            elif problem == 'source_frames': sprite['sourceFrames'] = [0, 8]
            elif problem == 'offset': sprite['frames'][0]['offset'] = [-2, -4]
            elif problem == 'empty_body': sprite['frames'][0]['rect'] = [0, 0, 0, 0]
            elif problem == 'missing_shadow': sprite['shadows'][0]['rect'] = [0, 0, 0, 0]
            elif problem == 'shadow_offset': sprite['shadows'][0]['offset'] = [1, 3]
            elif problem == 'frame_oob': sprite['frames'][0]['rect'] = [100, 1, 2, 2]
            elif problem == 'atlas_size': data['spriteAtlas']['width'] = 15
            elif problem == 'ids': data['sprites'] = {'synthetic:B': sprite}
            elif problem == 'unsafe_path': data['spriteAtlas']['file'] = '../target/native.png'
        edit(source, change)
    before_source, before_target = hashes(source), hashes(target)
    with pytest.raises(ValueError):
        ar.install(farm, source, target, 'MAP')
    assert hashes(source) == before_source
    assert hashes(target) == before_target
    assert list(farm.iterdir()) == [farm / 'MAP']
    assert (farm / 'MAP').is_symlink()


def test_source_only_shadow_is_explicitly_dropped_and_target_empty_metadata_stays_empty(tmp_path):
    source, target, farm = fixture(tmp_path)
    edit(source, lambda data: data['sprites']['synthetic:A']['shadows'][1].update(
        rect=[1, 4, 2, 1], offset=[5, 6]))
    with Image.open(source / 'hd.png') as image:
        image.paste((200, 100, 50, 255), ar.box([1, 4, 2, 1], 2))
        image.save(source / 'hd.png')
    target_before, source_before = hashes(target), hashes(source)
    report = ar.install(farm, source, target, 'MAP')
    entry = report['discarded_unused_source_shadow'][0]
    assert entry['target'] == {'rect': [0, 0, 0, 0], 'offset': [-5, -5]}
    actual = json.loads((farm / 'MAP/manifest.json').read_text())
    assert actual['sprites']['synthetic:A']['shadows'][1] == entry['target']
    with Image.open(farm / 'MAP' / actual['spriteAtlasHd']['file']) as image:
        assert not np.any(np.all(np.asarray(image) == [200, 100, 50, 255], axis=2))
    assert hashes(target) == target_before
    assert hashes(source) == source_before


def test_validate_is_read_only_and_install_preserves_unrelated_current_farm_fields(tmp_path):
    source, target, farm = fixture(tmp_path)
    before = hashes(tmp_path)
    ar.validate(source, target)
    assert hashes(tmp_path) == before
    import cache_farm
    cache_farm.patch_json(farm, 'MAP/manifest.json', lambda data: data.update(custom={'other_track': True}))
    ar.install(farm, source, target, 'MAP')
    assert json.loads((farm / 'MAP/manifest.json').read_text())['custom'] == {'other_track': True}


def test_changing_inputs_during_validation_prevents_page_publication(tmp_path, monkeypatch):
    source, target, farm = fixture(tmp_path)
    original_patch = ar.cache_farm.patch_json

    def change_then_patch(*args, **kwargs):
        edit(source, lambda data: data.update(changed_after_validation=True))
        original_patch(*args, **kwargs)

    monkeypatch.setattr(ar.cache_farm, 'patch_json', change_then_patch)
    with pytest.raises(ValueError, match='input changed'):
        ar.install(farm, source, target, 'MAP')
    assert (farm / 'MAP/manifest.json').is_symlink()
    assert not list((farm / 'MAP').glob('sprites-relayout*'))


def test_existing_hd_or_input_farm_destination_is_rejected(tmp_path):
    source, target, farm = fixture(tmp_path)
    with pytest.raises(ValueError, match='separate'):
        ar.install(target, source, target, 'MAP')
    edit(target, lambda data: data.update(spriteAtlasHd={'file': 'keep.png'}))
    with pytest.raises(ValueError, match='already'):
        ar.install(farm, source, target, 'MAP')
