"""Synthetic map/library installation contracts; no game art or image model required."""

import json
from pathlib import Path

import numpy as np
from PIL import Image
import pytest

import sprite_frame_patch as sfp


def fixture(tmp: Path, paged: bool = False):
    base, variant, patches = tmp / 'base', tmp / 'variant', tmp / 'patches'
    base.mkdir()
    patches.mkdir()
    index = np.zeros((8, 10), np.uint8)
    index[1:3, 1:4] = 72
    index[4:6, 5:8] = 1
    if paged:
        Image.fromarray(index).save(base / 'indices.png')
    else:
        indexed = np.zeros((8, 10, 4), np.uint8)
        indexed[..., 0] = index
        indexed[..., 3] = (index > 0) * 255
        Image.fromarray(indexed).save(base / 'indices.png')
    Image.new('RGBA', (20, 16), (80, 95, 110, 255)).save(base / 'hd.png')
    frame = {'rect': [1, 1, 3, 2], 'offset': [-3, -8]}
    shadow = {'rect': [5, 4, 3, 2], 'offset': [2, 1]}
    manifest = {'sprites': {'terrain:A': {'palette': 'iso', 'frames': [
        {'rect': [5, 1, 3, 2], 'offset': [-3, -8]}, frame], 'shadows': [shadow, shadow]}}}
    if paged:
        manifest.update(spriteAtlases=[{'file': 'indices.png'}], spriteAtlasesHd=[{'file': 'hd.png', 'scale': 2}])
        name = 'library.json'
    else:
        manifest.update(spriteAtlas={'file': 'indices.png'}, spriteAtlasHd={'file': 'hd.png', 'scale': 2})
        name = 'manifest.json'
    (base / name).write_text(json.dumps(manifest))
    Image.new('RGBA', (6, 4), (18, 125, 160, 255)).save(patches / 'hd.png')
    Image.new('RGBA', (3, 2), (43, 0, 0, 255)).save(patches / 'index.png')
    Image.new('RGBA', (3, 2), (1, 0, 0, 255)).save(patches / 'shadow.png')
    spec = {'frames': [{'sprite': 'terrain:A', 'frame': 1, 'hd': 'hd.png',
                        'indexed': 'index.png', 'shadow': 'shadow.png'}]}
    path = patches / 'spec.json'
    path.write_text(json.dumps(spec))
    return base, variant, path, name, spec


@pytest.mark.parametrize('paged', [False, True])
def test_selected_nonzero_frame_preserves_source_metadata_and_other_edits(tmp_path, paged):
    base, variant, spec, name, _ = fixture(tmp_path, paged)
    before = {p.name: p.read_bytes() for p in base.iterdir()}
    variant.mkdir()
    (variant / 'hd.png').symlink_to(base / 'hd.png')
    result = sfp.apply(base, variant, spec)
    assert {p.name: p.read_bytes() for p in base.iterdir()} == before
    assert (variant / name).read_bytes() == before[name]
    assert not (variant / 'hd.png').is_symlink()
    hd = np.array(Image.open(variant / 'hd.png'))
    assert np.all(hd[2:6, 2:8] == [18, 125, 160, 255])
    assert np.all(hd[2:6, 10:16] == [80, 95, 110, 255])
    index = np.array(Image.open(variant / 'indices.png'))
    assert np.all((index if paged else index[..., 0])[1:3, 1:4] == 43)
    # A second approved patch must preserve another track's regular atlas edit.
    hd[13, 18] = [240, 7, 20, 255]
    Image.fromarray(hd).save(variant / 'hd.png')
    sfp.apply(base, variant, spec)
    np.testing.assert_array_equal(np.array(Image.open(variant / 'hd.png'))[13, 18], [240, 7, 20, 255])
    assert result['frames'][0]['frame'] == 1
    assert result['frames'][0]['shadow_updated']


@pytest.mark.parametrize('problem', ['size', 'duplicate', 'escape', 'missing_hd', 'bad_frame'])
def test_all_validation_finishes_before_any_variant_write(tmp_path, problem):
    base, variant, path, name, spec = fixture(tmp_path)
    variant.mkdir()
    (variant / 'keep.txt').write_text('another track')
    if problem == 'size':
        Image.new('RGBA', (5, 4)).save(path.parent / 'hd.png')
    elif problem == 'duplicate':
        spec['frames'].append(spec['frames'][0].copy())
    elif problem == 'escape':
        spec['frames'][0]['hd'] = '../outside.png'
    elif problem == 'missing_hd':
        data = json.loads((base / name).read_text())
        del data['spriteAtlasHd']
        (base / name).write_text(json.dumps(data))
    else:
        spec['frames'][0]['frame'] = -1
    path.write_text(json.dumps(spec))
    with pytest.raises(ValueError):
        sfp.apply(base, variant, path)
    assert [p.name for p in variant.iterdir()] == ['keep.txt']


def test_source_directory_cannot_be_destination(tmp_path):
    base, _, spec, _, _ = fixture(tmp_path)
    with pytest.raises(ValueError, match='separate'):
        sfp.apply(base, base, spec)


def test_symlinked_atlas_directory_cannot_write_into_source(tmp_path):
    base, variant, spec, name, _ = fixture(tmp_path)
    assets = base / 'assets'
    assets.mkdir()
    (base / 'hd.png').rename(assets / 'hd.png')
    manifest = json.loads((base / name).read_text())
    manifest['spriteAtlasHd']['file'] = 'assets/hd.png'
    (base / name).write_text(json.dumps(manifest))
    variant.mkdir()
    (variant / 'assets').symlink_to(assets, target_is_directory=True)
    before = (assets / 'hd.png').read_bytes()
    with pytest.raises(ValueError, match='parent must not be a symlink'):
        sfp.apply(base, variant, spec)
    assert (assets / 'hd.png').read_bytes() == before


@pytest.mark.parametrize('selected_missing', [False, True])
def test_sparse_hd_library_validates_selected_page_only(tmp_path, selected_missing):
    base, variant, spec, name, _ = fixture(tmp_path, paged=True)
    manifest = json.loads((base / name).read_text())
    manifest['spriteAtlases'].append({'file': 'unused.png'})
    manifest['spriteAtlasesHd'].append(None)
    if selected_missing:
        manifest['sprites']['terrain:A']['frames'][1]['page'] = 1
    (base / name).write_text(json.dumps(manifest))
    original = (base / name).read_bytes()
    if selected_missing:
        with pytest.raises(ValueError, match='selected frame has no HD'):
            sfp.apply(base, variant, spec)
        assert not variant.exists()
    else:
        sfp.apply(base, variant, spec)
        assert json.loads((variant / name).read_text())['spriteAtlasesHd'][1] is None
    assert (base / name).read_bytes() == original
