"""Asset-free source correction guards; an explicit overlay never relaxes geometry or calibration."""
import copy
import hashlib
import json
from pathlib import Path

import numpy as np
from PIL import Image
import pytest

import unit_coverage as coverage
from test_unit_coverage import caches, snapshot, write_json


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


@pytest.fixture
def corrected(caches, tmp_path):
    farm, base = caches
    reference = tmp_path / 'calibration.json'
    write_json(reference, coverage.scan(farm, base, theaters=['urban']))
    archive = base / '_library/urban/library.json'
    old = coverage.read_json(archive)
    old['sprites']['infantry:CAML'] = {'file': 'josh.shp', 'canvas': [8, 8], 'frameCount': 2,
        'frames': [{'rect': [0, 0, 8, 8], 'offset': [0, 0]}]}
    old['types']['CAML'] = {'kind': 'infantry', 'image': 'CAML', 'sprite': 'infantry:CAML', 'remap': False}
    write_json(archive, old)
    target_dir = farm / '_library/urban'
    target_path = target_dir / 'library.json'
    target_path.unlink()
    current = copy.deepcopy(old)
    root = tmp_path / 'source-overlay'
    directory = root / 'urban'
    directory.mkdir(parents=True)
    indices = np.zeros((10, 8), np.uint8)
    indices[1:5, 1:4] = 40
    indices[4, 1:4] = 12
    indices[6:8, 1:3] = 1
    palette = np.zeros((256, 3), np.uint8)
    palette[40] = (190, 60, 45)
    Image.fromarray(indices).save(directory / 'source.png')
    Image.fromarray(palette[None]).save(directory / 'palette.png')
    rgba = np.concatenate((palette[indices], ((indices != 0) * 255)[..., None]), -1).astype(np.uint8)
    rgba[indices == 12, :3] = 0
    hd = np.repeat(np.repeat(rgba, 2, 0), 2, 1)
    Image.fromarray(hd).save(directory / 'baseline.png')
    Image.new('L', (16, 20), 0).save(directory / 'paint.png')
    body = {'rect': [1, 1, 3, 4], 'offset': [-4, -8]}
    shadow = {'rect': [1, 6, 2, 2], 'offset': [-3, -3]}
    identity = {'file': 'caml.shp', 'canvas': [10, 20], 'frameCount': 2, 'palette': 'unit', 'remap': False}
    sprite = {**identity, 'frames': [body], 'shadows': [shadow]}
    type_identity = current['types']['CAML']
    baseline = {'version': 1, 'theater': 'urban', 'palettes': {'unit': 'palette.png'},
        'sprites': {'infantry:CAML': sprite}, 'types': {'CAML': type_identity},
        'spriteAtlases': [{'file': 'source.png', 'width': 8, 'height': 10}],
        'spriteAtlasesHd': [{'file': 'baseline.png', 'remap': 'paint.png', 'scale': 2, 'width': 16, 'height': 20}]}
    write_json(directory / 'library.json', baseline)
    Image.fromarray(indices).save(target_dir / 'corrected-source.png')
    Image.fromarray(palette[None]).save(target_dir / 'palette.png')
    changed = hd.copy()
    changed[2:8, 2:8, :3] = (25, 240, 230)
    Image.fromarray(changed).save(target_dir / 'corrected-hd.png')
    Image.new('L', (16, 20), 0).save(target_dir / 'corrected-paint.png')
    current['spriteAtlases'].append({'file': 'corrected-source.png', 'width': 8, 'height': 10})
    current['spriteAtlasesHd'].append({'file': 'corrected-hd.png', 'remap': 'corrected-paint.png', 'scale': 2,
                                     'width': 16, 'height': 20})
    current['palettes'] = {'unit': 'palette.png'}
    current['colorSchemes'] = [{'remap': [[0, 0, 0]] * 16}]
    current['sprites']['infantry:CAML'] = {**identity, 'frames': [{**body, 'page': 1}], 'shadows': [{**shadow, 'page': 1}]}
    write_json(target_path, current)
    (root / 'synthetic-source-evidence.txt').write_text('Synthetic fixture only; no game assets or native-engine claim.')
    frames = lambda rows: [{'size': f['rect'][2:], 'offset': f['offset'],
        'indexed_sha256': hashlib.sha256(indices[f['rect'][1]:f['rect'][1]+f['rect'][3],
                                                  f['rect'][0]:f['rect'][0]+f['rect'][2]].tobytes()).hexdigest()} for f in rows]
    descriptor = {'version': 1, 'recipe': 'indexed-nearest-2x', 'base': str(base),
        'calibration_report_sha256': digest(reference),
        'provenance': [{'path': 'synthetic-source-evidence.txt', 'sha256': digest(root / 'synthetic-source-evidence.txt')}],
        'theaters': {'urban': {'base_library_sha256': digest(archive),
            'library': {'path': 'urban/library.json', 'sha256': digest(directory / 'library.json')},
            'files': {name: digest(directory / name) for name in ('source.png', 'palette.png', 'baseline.png', 'paint.png')},
            'sprites': {'infantry:CAML': {'type': 'CAML', 'type_identity': type_identity, 'identity': identity,
                'superseded_identity': {'file': 'josh.shp', 'canvas': [8, 8], 'frameCount': 2},
                'frames': frames([body]), 'shadows': frames([shadow])}}}}}
    path = root / 'overlay.json'
    write_json(path, descriptor)
    return farm, base, reference, path


def scan_corrected(case, overlay=True):
    farm, base, reference, path = case
    return coverage.scan(farm, base, theaters=['urban'], calibration_report=reference,
                         source_overlay=path if overlay else None)


def test_explicit_corrected_source_keeps_defaults_calibration_and_inputs_unchanged(corrected):
    farm, base, reference, path = corrected
    before = snapshot(farm), snapshot(base), snapshot(path.parent)
    default = scan_corrected(corrected, overlay=False)
    assert 'source_overlay' not in default
    row = next(r for r in default['rows'] if r['code'] == 'CAML')
    assert 'stage-0 frame geometry mismatch' in row['theaters']['urban']['issues']
    explicit = scan_corrected(corrected)
    frame = next(r for r in explicit['rows'] if r['code'] == 'CAML')['theaters']['urban']['frames'][0]
    assert frame['score'] > explicit['calibration']['threshold']
    assert frame['baseline_kind'] == 'source-verified-nearest-2x'
    assert frame['baseline_fallback'] is False
    assert explicit['source_overlay']['sha256'] == digest(path)
    assert explicit['calibration'] == default['calibration']
    assert explicit['calibration']['cohorts'] == coverage.read_json(reference)['calibration']['cohorts']
    rendered = coverage.markdown(explicit)
    assert '显式 source overlay' in rendered
    assert digest(path) in rendered
    assert 'urban：infantry:CAML' in rendered
    assert 'source-verified-nearest-2x' in rendered
    assert '也不代表实机验收' in rendered
    assert '显式 source overlay' not in coverage.markdown(default)
    assert (snapshot(farm), snapshot(base), snapshot(path.parent)) == before


def test_source_overlay_requires_frozen_hash_bound_calibration(corrected):
    farm, base, reference, path = corrected
    with pytest.raises(ValueError, match='requires a frozen calibration'):
        coverage.scan(farm, base, theaters=['urban'], source_overlay=path)
    value = coverage.read_json(path)
    value['calibration_report_sha256'] = '0' * 64
    write_json(path, value)
    with pytest.raises(ValueError, match='calibration report hash mismatch'):
        scan_corrected(corrected)


def test_source_overlay_requires_the_superseded_identity(corrected):
    path = corrected[-1]
    data = coverage.read_json(path)
    data['theaters']['urban']['sprites']['infantry:CAML']['superseded_identity'] = {}
    write_json(path, data)
    with pytest.raises(ValueError, match='incomplete superseded identity'):
        scan_corrected(corrected)


def test_nonremappable_index16_retains_native_colour_and_zero_baseline_paint(corrected):
    farm, base, reference, path = corrected
    descriptor = coverage.read_json(path)
    entry = descriptor['theaters']['urban']
    directory = path.parent / 'urban'
    with Image.open(directory / 'source.png') as im:
        indices = np.asarray(im).copy()
    indices[1, 1] = 16
    Image.fromarray(indices).save(directory / 'source.png')
    Image.fromarray(indices).save(farm / '_library/urban/corrected-source.png')
    with Image.open(directory / 'palette.png') as im:
        palette = np.asarray(im).copy()
    palette[0, 16] = (90, 110, 130)
    Image.fromarray(palette).save(directory / 'palette.png')
    Image.fromarray(palette).save(farm / '_library/urban/palette.png')
    with Image.open(directory / 'baseline.png') as im:
        rgba = np.asarray(im).copy()
    rgba[2:4, 2:4, :3] = (90, 110, 130)
    Image.fromarray(rgba).save(directory / 'baseline.png')
    for name in ('source.png', 'palette.png', 'baseline.png'):
        entry['files'][name] = digest(directory / name)
    entry['sprites']['infantry:CAML']['frames'][0]['indexed_sha256'] = hashlib.sha256(indices[1:5, 1:4].tobytes()).hexdigest()
    write_json(path, descriptor)
    report = scan_corrected(corrected)
    assert report['source_overlay']['recipe'] == 'indexed-nearest-2x'
    frame = next(r for r in report['rows'] if r['code'] == 'CAML')['theaters']['urban']['frames'][0]
    assert frame['body_pixels'] == 9
    assert frame['baseline_original_lab'] == 0


@pytest.mark.parametrize('change,reason', [
    ('archive', 'archive library hash mismatch'),
    ('source-evidence', 'file hash mismatch'),
    ('identity', 'identity mismatch'),
    ('binding', 'type binding mismatch'),
    ('offset', 'frame geometry mismatch'),
    ('indices', 'original crop hash mismatch'),
    ('shadow', 'original crop hash mismatch'),
    ('palette', 'current palette mismatch'),
])
def test_source_overlay_rejects_archive_identity_crop_and_provenance_drift(corrected, change, reason):
    farm, base, reference, path = corrected
    directory = farm / '_library/urban'
    target = directory / 'library.json'
    data = coverage.read_json(target)
    if change == 'archive':
        with (base / '_library/urban/library.json').open('a') as out:
            out.write(' ')
    elif change == 'source-evidence':
        (path.parent / 'synthetic-source-evidence.txt').write_text('altered')
    elif change == 'identity':
        data['sprites']['infantry:CAML']['file'] = 'josh.shp'
        write_json(target, data)
    elif change == 'binding':
        data['types']['CAML']['sprite'] = 'infantry:GI'
        write_json(target, data)
    elif change == 'offset':
        data['sprites']['infantry:CAML']['frames'][0]['offset'][1] += 1
        write_json(target, data)
    elif change in ('indices', 'shadow'):
        source = directory / 'corrected-source.png'
        with Image.open(source) as im:
            pixels = np.asarray(im).copy()
        pixels[1 if change == 'indices' else 6, 1] = 41
        Image.fromarray(pixels).save(source)
    else:
        palette = directory / 'palette.png'
        with Image.open(palette) as im:
            pixels = np.asarray(im).copy()
        pixels[0, 40, 0] += 1
        Image.fromarray(pixels).save(palette)
    with pytest.raises(ValueError, match=reason):
        scan_corrected(corrected)


@pytest.mark.parametrize('channel', ['baseline.png', 'paint.png'])
def test_hash_bound_baseline_still_requires_independent_nearest_recipe(corrected, channel):
    farm, base, reference, path = corrected
    descriptor = coverage.read_json(path)
    page = path.parent / 'urban' / channel
    with Image.open(page) as im:
        pixels = np.asarray(im).copy()
    pixels[2, 2] = 123
    Image.fromarray(pixels).save(page)
    # Even a recomputed descriptor hash cannot bless arbitrary HD baseline pixels or paint.
    descriptor['theaters']['urban']['files'][channel] = digest(page)
    write_json(path, descriptor)
    with pytest.raises(ValueError, match='nearest baseline recipe mismatch'):
        scan_corrected(corrected)


def test_overlay_references_are_scoped_and_reports_cannot_overwrite_evidence(corrected, tmp_path):
    farm, base, reference, path = corrected
    baseline_path = path.parent / 'urban/library.json'
    baseline = coverage.read_json(baseline_path)
    baseline['spriteAtlases'][0]['file'] = '../source.png'
    write_json(baseline_path, baseline)
    descriptor = coverage.read_json(path)
    descriptor['theaters']['urban']['library']['sha256'] = digest(baseline_path)
    write_json(path, descriptor)
    with pytest.raises(ValueError, match='unlisted or unsafe reference'):
        scan_corrected(corrected)
    with pytest.raises(SystemExit):
        coverage.main(['scan', '--farm', str(farm), '--base', str(base), '--theaters', 'urban',
                      '--calibration-report', str(reference), '--source-overlay', str(path),
                      '--json', str(path.parent / 'report.json'), '--md', str(tmp_path / 'report.md')])
