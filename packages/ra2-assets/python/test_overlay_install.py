"""Synthetic accepted-overlay/source evidence, crop material updates and guarded rollback."""
import copy
import json
from pathlib import Path

import numpy as np
from PIL import Image
import pytest

import overlay_install as oi


def write(path, value):
    path.write_text(json.dumps(value))


def fixture(tmp, normal_scale=1, remap=False, normals=True):
    base, farm, art, evidence, out = [tmp / name for name in ('base', 'farm', 'art', 'evidence', 'receipt')]
    directory = base / '_library' / 'test'
    directory.mkdir(parents=True);farm.mkdir();art.mkdir();evidence.mkdir()
    (farm / '_library').symlink_to(base / '_library', target_is_directory=True)
    idx = np.zeros((8, 12), np.uint8)
    idx[1:4, 2:6] = 17 if remap else 40
    idx[2, 3] = 0
    Image.fromarray(idx).save(directory / 'indexed.png')
    palette = np.zeros((1, 256, 3), np.uint8);palette[0, 40] = [180, 170, 140];palette[0, 17] = [230, 90, 50]
    Image.fromarray(palette).save(directory / 'palette.png')
    rgba = np.zeros((16, 24, 4), np.uint8);rgba[:] = [70, 90, 110, 255]
    alpha = np.repeat(np.repeat(idx[1:4, 2:6] > 0, 2, 0), 2, 1).astype(np.uint8)*255
    rgba[2:8, 4:12, 3] = alpha
    Image.fromarray(rgba).save(directory / 'current.png')
    paint = np.repeat(np.repeat((idx == 17)*17, 2, 0), 2, 1).astype(np.uint8)
    Image.fromarray(paint).save(directory / 'remap.png')
    frame = {'rect': [2, 1, 4, 3], 'offset': [-2, -1], 'page': 0}
    sprite = {'file': 'owned.shp', 'palette': 'unit', 'remap': remap, 'canvas': [10, 9], 'frameCount': 6,
              'frames': [dict(frame, rect=[0,0,0,0]), frame],
              'shadows': [{'rect': [8, 5, 3, 2], 'offset': [1,2], 'page': 0}, {'rect': [0,0,0,0], 'offset': [0,0], 'page': 0}]}
    lib = {'version': 1, 'sprites': {'overlay:A': sprite}, 'paletteSources': {'unit': 'own.pal'},
           'palettes': {'unit': 'palette.png'}, 'spriteAtlases': [{'file': 'indexed.png', 'width': 12, 'height': 8}],
           'spriteAtlasesHd': [{'file': 'current.png', 'remap': 'remap.png', 'width': 24, 'height': 16, 'scale': 2}],
           'unknown_extension': {'retained': True}}
    write(directory / 'library.json', lib);write(evidence / 'library-test.json', lib)
    if normals:
        material = np.full((8*normal_scale,12*normal_scale,4), [121,136,8,240], np.uint8)
        Image.fromarray(material).save(directory / 'material.png')
        write(directory / 'normals.json', {'version': 1, 'pages': {'0': {'file': 'material.png', 'atlas': 'current.png',
            'width': 24, 'height': 16, 'scale': 2, 'materialWidth': 12*normal_scale, 'materialHeight': 8*normal_scale, 'frames': 3}}})
    native = np.dstack((palette.reshape(-1,3)[idx[1:4,2:6]], (idx[1:4,2:6]>0).astype(np.uint8)*255))
    Image.fromarray(native).save(art / 'native.png')
    new = np.full((6,8,4), [85,140,150,255], np.uint8);new[...,3] = alpha
    Image.fromarray(new).save(art / 'accepted.png')
    Image.new('RGB',(10,10),(20,40,60)).save(art / 'generated.png')
    t = {'theatre': 'test', 'sprite': 'overlay:A', 'frame': 1, 'type': 'A', **frame,
         'palette': 'unit', 'source_file': 'owned.shp', 'source': str(art / 'native.png'),
         'source_hash': oi.source_hash(native, frame, sprite),
         'index_hash': oi.source_hash(idx[1:4,2:6], frame, sprite, True)}
    write(evidence / 'frame-audit.json', [t])
    asset = {'file': str(art / 'accepted.png'), 'sha256': oi.digest(art / 'accepted.png'), 'targets': [t],
             'native': str(art / 'native.png'), 'index_hash': t['index_hash'], 'status': 'accepted_headless',
             'source_png': str(art / 'generated.png'), 'source_png_sha256': oi.digest(art / 'generated.png'),
             'review': {'verdict': 'accepted'}}
    whitelist = art / 'whitelist.json';write(whitelist, {'version': 1, 'assets': [asset]})
    return base, farm, whitelist, evidence, out, directory


@pytest.mark.parametrize('normal_scale', [1,2])
def test_current_page_crop_only_preserves_inputs_and_other_edits_and_undo(tmp_path, normal_scale):
    base,farm,whitelist,evidence,out,directory = fixture(tmp_path,normal_scale)
    before = {p.name:p.read_bytes() for p in directory.iterdir()}
    original_hd = np.array(Image.open(directory / 'current.png'))
    original_material = np.array(Image.open(directory / 'material.png'))
    report = oi.apply(base,farm,whitelist,evidence,out)
    assert report['status'] == 'installed' and len(report['frames']) == 1
    assert {p.name:p.read_bytes() for p in directory.iterdir()} == before
    assert not (farm / '_library').is_symlink()
    destination = farm / '_library/test'
    hd = np.array(Image.open(destination / 'current.png'))
    mask = np.zeros(hd.shape[:2],bool);mask[2:8,4:12]=True
    np.testing.assert_array_equal(hd[~mask], original_hd[~mask])
    np.testing.assert_array_equal(hd[mask], np.array(Image.open(whitelist.parent / 'accepted.png')).reshape(-1,4))
    material = np.array(Image.open(destination / 'material.png'))
    mm = np.zeros(material.shape[:2],bool);mm[normal_scale:4*normal_scale,2*normal_scale:6*normal_scale]=True
    np.testing.assert_array_equal(material[~mm],original_material[~mm])
    assert np.any(material[mm]!=original_material[mm])
    for name in ['library.json','normals.json','remap.png','indexed.png']:
        assert (destination/name).read_bytes() == before[name]
    assert oi.undo(out/'install.json')['status'] == 'restored'
    for name,data in before.items():assert (destination/name).read_bytes()==data


def test_current_house_remap_rgba_and_plane_preserved(tmp_path):
    base,farm,whitelist,evidence,out,directory=fixture(tmp_path,remap=True,normals=False)
    before = np.array(Image.open(directory/'current.png'))
    oi.apply(base,farm,whitelist,evidence,out)
    after = np.array(Image.open(farm/'_library/test/current.png'))
    paint = np.array(Image.open(directory/'remap.png')) > 0
    np.testing.assert_array_equal(after[paint], before[paint])
    assert (farm/'_library/test/remap.png').read_bytes()==(directory/'remap.png').read_bytes()


@pytest.mark.parametrize('problem', ['hash','generated','indexed','palette','alpha','geometry','order','duplicate','unsafe','remap','normal'])
def test_reject_before_farm_writes(tmp_path,problem):
    base,farm,whitelist,evidence,out,directory=fixture(tmp_path)
    data=json.loads(whitelist.read_text());asset=data['assets'][0]
    if problem=='hash':asset['sha256']='0'*64
    elif problem=='generated':(whitelist.parent/'generated.png').write_bytes(b'changed')
    elif problem=='indexed':Image.new('L',(12,8),50).save(directory/'indexed.png')
    elif problem=='palette':Image.new('RGB',(256,1),(1,2,3)).save(directory/'palette.png')
    elif problem=='alpha':
        im=Image.open(whitelist.parent/'accepted.png');im.putalpha(255);im.save(whitelist.parent/'accepted.png')
        asset['sha256']=oi.digest(whitelist.parent/'accepted.png')
    elif problem in ('geometry','order','unsafe'):
        lib=json.loads((directory/'library.json').read_text())
        if problem=='geometry':lib['sprites']['overlay:A']['frames'][1]['offset']=[4,5]
        elif problem=='order':lib['sprites']['overlay:A']['frames'].reverse()
        else:lib['spriteAtlasesHd'][0]['file']='../escape.png'
        write(directory/'library.json',lib)
    elif problem=='duplicate':data['assets'].append(copy.deepcopy(asset))
    elif problem=='remap':Image.new('L',(24,16),20).save(directory/'remap.png')
    else:
        normal=json.loads((directory/'normals.json').read_text());normal['pages']['0']['atlas']='stale.png'
        write(directory/'normals.json',normal)
    write(whitelist,data)
    before={p.name:p.read_bytes() for p in directory.iterdir()}
    with pytest.raises((ValueError,FileNotFoundError)):
        oi.apply(base,farm,whitelist,evidence,out)
    assert (farm/'_library').is_symlink()
    assert {p.name:p.read_bytes() for p in directory.iterdir()}==before
    assert not out.exists()


@pytest.mark.parametrize('problem',['atlas','metadata','backup'])
def test_rollback_blocks_intervening_changes_before_any_restore(tmp_path,problem):
    base,farm,whitelist,evidence,out,directory=fixture(tmp_path)
    oi.apply(base,farm,whitelist,evidence,out)
    destination=farm/'_library/test'
    if problem=='atlas':(destination/'current.png').write_bytes(b'later edit')
    elif problem=='metadata':
        # Replace the farm link atomically; never modify a symlinked source fixture.
        replacement=out/'changed.json';replacement.write_text('{}')
        oi.cache_farm.install_file(farm,'_library/test/library.json',replacement)
    else:(out/'backup/0.bin').write_bytes(b'bad backup')
    before={p.name:p.read_bytes() for p in destination.iterdir() if p.is_file()}
    with pytest.raises(ValueError):oi.undo(out/'install.json')
    assert {p.name:p.read_bytes() for p in destination.iterdir() if p.is_file()}==before


def test_validate_only_no_farm_or_receipt_writes(tmp_path):
    base,farm,whitelist,evidence,out,_=fixture(tmp_path)
    result=oi.apply(base,farm,whitelist,evidence,out,validate_only=True)
    assert result['status']=='validated' and len(result['frames'])==1
    assert not out.exists() and (farm/'_library').is_symlink()


def test_partial_install_journal_can_rollback_after_interrupt(tmp_path,monkeypatch):
    base,farm,whitelist,evidence,out,directory=fixture(tmp_path)
    before={p.name:p.read_bytes() for p in directory.iterdir()}
    original=oi.cache_farm.install_file
    calls=0
    def interrupted(*args):
        nonlocal calls
        calls+=1
        if calls==2:raise RuntimeError('synthetic interruption')
        original(*args)
    monkeypatch.setattr(oi.cache_farm,'install_file',interrupted)
    with pytest.raises(RuntimeError):oi.apply(base,farm,whitelist,evidence,out)
    monkeypatch.setattr(oi.cache_farm,'install_file',original)
    assert oi.undo(out/'install.json')['status']=='restored'
    for name,content in before.items():assert (farm/'_library/test'/name).read_bytes()==content
