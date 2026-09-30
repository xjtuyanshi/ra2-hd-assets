"""Synthetic-only regression tests: python3 -m pytest packages/ra2-assets/python/test_tree_redraw.py -q.

No original art, cache, external model or network is needed. Numerical tests check the scratch method's boundaries;
the tiny cache exercises CLI paths, indexed coverage, atomic symlink replacement and coexistence with other edits.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

import cv2
import numpy as np
import pytest
from PIL import Image

import tree_redraw as tr


def save(path: Path, pixels: np.ndarray) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray(pixels).save(path)


def test_colour_lock_maps_lightness_quantiles_and_keeps_alpha():
    ramp = np.linspace(0, 1, 192).reshape(12, 16)
    source = np.zeros((12, 16, 4), np.uint8)
    reference = source.copy()
    source[..., :3] = (45 + 80 * ramp[..., None] ** 1.4).round()
    reference[..., :3] = (90 + 100 * ramp[::-1, ::-1, None] ** 0.8).round()
    source[..., 3] = reference[..., 3] = 255
    result = tr.lock(source, reference, kL=1, kab=0, kc=0)
    lab, _ = tr.lab_of(result)
    ref_lab, _ = tr.lab_of(reference)
    quantiles = [0.1, 0.25, 0.5, 0.75, 0.9]
    np.testing.assert_allclose(np.quantile(lab[..., 0], quantiles),
                               np.quantile(ref_lab[..., 0], quantiles), atol=0.6)
    np.testing.assert_array_equal(result[..., 3], source[..., 3])
    unchanged = tr.lock(source, reference, kL=0, kab=0, kc=0)
    np.testing.assert_allclose(unchanged[..., :3], source[..., :3], atol=1)


def test_densify_changes_only_the_closed_hull_and_never_lowers_alpha():
    rgba = np.zeros((32, 36, 4), np.uint8)
    rgba[..., :3] = (65, 128, 47)
    # A rectangle with tiny enclosed holes has a known closed hull: this same rectangle.
    hull = np.zeros(rgba.shape[:2], bool)
    hull[5:27, 6:30] = True
    rgba[hull, 3] = 255
    rgba[12, 16, 3] = 0
    rgba[19, 22, 3] = 100
    rgba[2, 3, 3] = 40  # an outside translucent speck must also survive unchanged
    before = rgba.copy()
    result, stats = tr.densify(rgba)
    np.testing.assert_array_equal(result[~hull], rgba[~hull])
    assert np.all(result[..., 3] >= rgba[..., 3])
    assert result[12, 16, 3] > 0
    assert stats['filled_px'] > 0
    np.testing.assert_array_equal(rgba, before)


def test_volume_keeps_alpha_and_does_not_mutate_input():
    rgba = np.random.default_rng(42).integers(0, 256, (48, 64, 4), dtype=np.uint8)
    before = rgba.copy()
    result = tr.volume(rgba, **tr.VOLUME)
    np.testing.assert_array_equal(result[..., 3], before[..., 3])
    np.testing.assert_array_equal(rgba, before)
    assert np.any(result[..., :3] != before[..., :3])


def test_volume_zero_strength_is_exactly_unchanged():
    ramp = np.arange(256, dtype=np.uint8).reshape(16, 16)
    rgba = np.dstack([ramp, ramp.T, ramp[::-1], ramp[:, ::-1]])
    np.testing.assert_array_equal(tr.volume(rgba, strength=0), rgba)


@pytest.mark.parametrize('kwargs', [{}, {'strength': 1.3, 'density': 0.1}], ids=['function-defaults', 'build-defaults'])
def test_volume_lights_left_of_disc_and_preserves_mean_luminance(kwargs):
    yy, xx = np.mgrid[:80, :80]
    alpha = np.clip(30 - np.hypot(xx - 39.5, yy - 39.5), 0, 1)
    rgba = np.full((80, 80, 4), [65, 128, 47, 0], np.uint8)
    rgba[..., 3] = np.round(alpha * 255).astype(np.uint8)
    result = tr.volume(rgba, **kwargs)
    weights = rgba[..., 3].astype(np.float32) / 255.0
    # Luminance is measured in linear light, including the partially covered edge.
    rec709 = np.array([0.2126, 0.7152, 0.0722], np.float32)
    original = tr.srgb_to_lin(rgba[..., :3].astype(np.float32)) @ rec709
    shaded = tr.srgb_to_lin(result[..., :3].astype(np.float32)) @ rec709
    assert np.average(shaded[:, :40], weights=weights[:, :40]) > np.average(shaded[:, 40:], weights=weights[:, 40:])
    assert abs(np.average(shaded, weights=weights) / np.average(original, weights=weights) - 1) < 0.03


@pytest.mark.parametrize('solid_pixels', [0, 1, 29])
def test_volume_leaves_tiny_crowns_unchanged(solid_pixels):
    rgba = np.full((10, 10, 4), [65, 128, 47, 127], np.uint8)
    rgba.reshape(-1, 4)[:solid_pixels, 3] = 255
    before = rgba.copy()
    np.testing.assert_array_equal(tr.volume(rgba, **tr.VOLUME), before)
    np.testing.assert_array_equal(rgba, before)


def test_matte_recovers_a_disc_on_known_flat_grey():
    yy, xx = np.mgrid[:48, :48]
    radius = np.hypot(xx - 23.5, yy - 23.5)
    alpha = (np.clip((16 - radius) / 2, 0, 1) * 4).round().astype(np.float32) / 4
    colour = np.array([100, 128, 100], np.float32)
    bg = np.full((48, 48, 3), 118, np.float32)
    image = np.round(colour * alpha[..., None] + bg * (1 - alpha[..., None])).astype(np.uint8)
    recovered, foreground, _ = tr.matte(image, bg, np.ones(alpha.shape, bool))
    np.testing.assert_allclose(recovered, alpha, atol=0.05)
    assert np.max(np.abs(foreground[alpha == 1] / 255 - colour / 255)) < 3 / 255
    assert recovered[0, 0] == 0


def test_background_fit_recovers_surface_despite_coloured_foreground():
    yy, xx = np.mgrid[:40, :48].astype(np.float32)
    grey = 118 + 3 * (xx / 48 - 0.5) + 5 * (yy / 40 - 0.5) ** 3
    background = np.repeat(grey[..., None], 3, -1)
    image = background.copy()
    image[16:24, 20:28] = (50, 130, 50)
    fitted, mask = tr.fit_background(image)
    assert mask[0, 0] and not mask[20, 24]
    np.testing.assert_allclose(fitted, background, atol=0.002)


@pytest.mark.parametrize('truth', [(0.82, 0.90, 8, 3), (0.82, 0.86, 8, 5)])
def test_register_recovers_anisotropic_scale_and_translation(truth):
    source = np.zeros((52, 60), np.float32)
    source[8:36, 10:35] = 1
    source[16:28, 35:45] = 0.7
    source[31:45, 20:25] = 1
    sx, sy, ox, oy = truth
    moved = cv2.resize(source, None, fx=sx, fy=sy, interpolation=cv2.INTER_AREA)
    target = np.zeros_like(source)
    target[oy:oy + moved.shape[0], ox:ox + moved.shape[1]] = moved
    score, params = tr.register(source, target)
    np.testing.assert_allclose(params, truth, atol=1e-6)
    assert score > 0.999


def test_component_cleanup_removes_only_disconnected_specks():
    alpha = np.zeros((12, 15), np.float32)
    alpha[3:8, 4:9] = 1
    alpha[3, 9] = 0.6  # connected to the crown
    alpha[10, 13] = 0.8  # isolated
    alpha[0, 0] = 0.05  # sub-threshold coverage is deliberately retained
    seed = np.zeros_like(alpha, bool)
    seed[5, 6] = True
    result = tr.keep_main(alpha, seed)
    assert result[10, 13] == 0
    np.testing.assert_array_equal(result[3:8, 4:10], alpha[3:8, 4:10])
    assert result[0, 0] == alpha[0, 0]


def test_shadow_projection_of_vertical_line_follows_billboard_formula():
    alpha = np.zeros((6, 4), np.float32)
    alpha[:4, 1] = 1
    # fo=(1,-2), so=(-1,1), a=b=1, yb=2, cx=1, cy=3 give local
    # X=8-row+dx-dy, Y=row+dy. Of the 16 subpixels, 6 have dx<dy and 10 have dx>=dy.
    result = tr.project(alpha, (1, -2), (-1, 1), (12, 6), 1, 1, 2, 1, 3)
    expected = np.zeros((6, 12), np.float32)
    for row in range(4):
        expected[row, 7 - row:9 - row] = (6 / 16, 10 / 16)
    np.testing.assert_array_equal(result, expected)
    np.testing.assert_array_equal(tr.project(np.zeros_like(alpha), (0, 0), (0, 0), (12, 6), 1, 1, 0, 0, 0),
                                  np.zeros_like(expected))


def test_delta_transfer_returns_original_shadow_when_alpha_is_unchanged():
    alpha = np.zeros((12, 10), np.float32)
    alpha[2:10, 3:7] = 1
    alpha[2, 4] = 0.6
    original = np.zeros((12, 16), np.float32)
    original[3:8, 4:13] = 1  # intentionally not equal to a billboard projection
    result, pn, po = tr.delta_shadow(original, alpha.copy(), alpha, [0, -10], [-1, -4], [1.1, 0.5, 1, 0, 0])
    np.testing.assert_allclose(result, original, atol=1e-7)
    np.testing.assert_array_equal(pn, po)
    indexed = tr.dither_shadow(result, 7, 13)
    np.testing.assert_array_equal(indexed[..., 0], original.astype(np.uint8))
    np.testing.assert_array_equal(indexed[..., 3], original.astype(np.uint8) * 255)


def test_bayer_phase_is_anchored_to_atlas_coordinates():
    full = tr.dither_shadow(np.full((8, 8), 0.5, np.float32), 0, 0)
    crop = tr.dither_shadow(np.full((4, 4), 0.5, np.float32), 3, 2)
    np.testing.assert_array_equal(crop, full[2:6, 3:7])
    assert np.count_nonzero(crop[..., 0]) == 8


@pytest.fixture
def cache(tmp_path):
    root = tmp_path / 'cache'
    base = root / 'TinyMap'
    base.mkdir(parents=True)
    rect = [2, 3, 6, 6]
    shadow_rect = [11, 9, 5, 4]
    sprite = {'palette': 'iso', 'frames': [{'rect': rect, 'offset': [-3, -6]}],
              'shadows': [{'rect': shadow_rect, 'offset': [0, -2]}]}
    untouched = {'palette': 'iso', 'frames': [{'rect': [13, 2, 4, 4], 'offset': [0, 0]}], 'shadows': []}
    manifest = {'palettes': {'iso': 'palette.png'},
                'sprites': {'tree:TREE_TEST': sprite, 'tree:TREE_UNTOUCHED': untouched}}
    (base / 'manifest.json').write_text(json.dumps(manifest))
    one = np.zeros((16, 20, 4), np.uint8)
    one[3:9, 2:8, 0] = 42
    one[3, 2, 0] = 17  # house paint cannot become an encoded tree colour
    one[3, 3, 0] = 0
    one[2:6, 13:17, 0] = 75
    one[9:13, 11:16, 0] = 1
    one[..., 3] = (one[..., 0] > 0) * 255
    palette = np.zeros((1, 256, 3), np.uint8)
    palette[0, 42] = (60, 120, 55)
    palette[0, 75] = (90, 155, 70)
    palette[0, 17] = (255, 0, 0)
    hd = np.repeat(np.repeat(np.dstack([palette[0, one[..., 0]], one[..., 3]]), 2, 0), 2, 1)
    save(base / 'palette.png', palette)
    save(base / 'sprites.png', one)
    save(base / 'sprites@2x.png', hd)
    save(base / 'sprites@2x-normals.png', np.full_like(hd, 127))
    (base / 'normals.json').write_text('{}')
    (base / 'l3_frames_trees.json').write_text('{"existing":true}')
    spec = {'sheets': {'tiny': [[['TREE_TEST', 512]]]},
            'descriptions': {'TREE_TEST': 'a synthetic green disc with a short stem'},
            'selection': {'TREE_TEST': 'chosen'}}
    spec_path = tmp_path / 'spec.json'
    spec_path.write_text(json.dumps(spec))
    return {'root': root, 'base': base, 'one': one, 'hd': hd, 'rect': rect, 'shadow_rect': shadow_rect,
            'spec': spec, 'spec_path': spec_path}


def test_extract_sheet_and_build_cli_use_explicit_paths_and_config(cache, tmp_path):
    orig, proc, patch = (tmp_path / n for n in ('orig', 'proc', 'patch'))
    common = ['--cache-root', str(cache['root']), '--map', 'TinyMap']
    assert tr.main(['extract', *common, '--orig-dir', str(orig)]) == 0
    extracted = tr.read_image(orig / 'TinyMap_TREE_TEST_f0_1x.png')
    np.testing.assert_array_equal(extracted[..., 3], cache['one'][3:9, 2:8, 3])
    np.testing.assert_array_equal(extracted[1, 1], [60, 120, 55, 255])
    np.testing.assert_array_equal(tr.read_image(orig / 'TinyMap_TREE_TEST_f0_2x.png'), cache['hd'][6:18, 4:16])
    np.testing.assert_array_equal(tr.read_image(orig / 'TinyMap_TREE_TEST_s0_1x.png'), np.full((4, 5), 255))

    work = tmp_path / 'sheet'
    assert tr.main(['sheet', '--map', 'TinyMap', '--spec', str(cache['spec_path']), '--orig-dir', str(orig),
                    '--sheet', 'tiny', '--work-dir', str(work)]) == 0
    layout = tr.read_json(work / 'layout.json')
    assert layout == {'scale': 5.0, 'size': [1536, 1024],
                      'trees': {'TREE_TEST': {'box': [241, 241, 30, 30], 'frame1x': [6, 6]}}}
    sheet = tr.read_image(work / 'input.png')
    np.testing.assert_array_equal(sheet[0, 0], [118, 118, 118])
    assert np.any(sheet[241:271, 241:271] != 118)
    assert cache['spec']['descriptions']['TREE_TEST'] in (work / 'prompt.txt').read_text()

    new = np.full((12, 12, 4), [80, 145, 66, 255], np.uint8)
    save(proc / 'chosen/TREE_TEST_2x.png', new)
    assert tr.main(['build', *common, '--spec', str(cache['spec_path']), '--orig-dir', str(orig),
                    '--proc-dir', str(proc), '--patch-dir', str(patch), '--kL', '1',
                    '--cfg', '{"kL":0,"kab":0,"kc":0,"densify":null,"volume":null,"ref":"1x"}']) == 0
    built = tr.read_image(patch / 'TinyMap/TREE_TEST_2x.png')
    np.testing.assert_allclose(built.astype(int), new.astype(int), atol=1)
    indices = tr.read_image(patch / 'TinyMap/TREE_TEST_1x.png')[..., 0]
    assert set(np.unique(indices)) <= {42, 75}
    info = tr.read_json(patch / 'TinyMap/build.json')
    assert list(info) == ['TREE_TEST']
    assert info['TREE_TEST']['densify'] is None
    assert info['TREE_TEST']['volume'] is None
    assert info['TREE_TEST']['rect'] == cache['rect']


@pytest.fixture
def build_inputs(cache, tmp_path):
    orig, proc = (tmp_path / name for name in ('orig', 'proc'))
    tr.extract(cache['root'], 'TinyMap', orig)
    yy, xx = np.mgrid[:12, :12]
    new = np.zeros((12, 12, 4), np.uint8)
    new[..., :3] = np.dstack([55 + xx * 4, 95 + yy * 5, 40 + xx + yy])
    new[1:11, 1:11, 3] = 255
    new[5:7, 5:7, 3] = 0
    new[2:10, 1, 3] = 150
    new[0, 0, 3] = 5
    save(proc / 'chosen/TREE_TEST_2x.png', new)
    return orig, proc


def test_build_volume_disabled_reproduces_previous_output(cache, build_inputs, tmp_path, monkeypatch):
    orig, proc = build_inputs
    patch = tmp_path / 'patch'

    def disabled(*args, **kwargs):
        pytest.fail('volume must not run when cfg.volume is null')

    monkeypatch.setattr(tr, 'volume', disabled)
    tr.build(cache['root'], 'TinyMap', orig, proc, patch, cache['spec'], cfg={'volume': None})
    # Raw-array hashes captured from the pre-volume build with this synthetic fixture.
    expected = {'2x': 'fe8993e4c64a23e2a6782590af133157d7cf62f3ea62455a1021ceb1fc7c1d80',
                '1x': '03d650a95a0cf90772086315c6b615d697c521214ed96b87e755f7976f352e5c'}
    for scale, digest in expected.items():
        pixels = tr.read_image(patch / f'TinyMap/TREE_TEST_{scale}.png')
        assert hashlib.sha256(pixels.tobytes()).hexdigest() == digest
    info = tr.read_json(patch / 'TinyMap/build.json')['TREE_TEST']
    assert info['volume'] is None and info['densify']['filled_px'] > 0


@pytest.mark.parametrize(('cfg', 'expected'), [
    ({}, {'strength': 1.3, 'density': 0.1}),
    ({'volume': {}}, {}),
    ({'volume': {'strength': 0.7, 'rim': 0}}, {'strength': 0.7, 'rim': 0}),
], ids=['absent', 'function-defaults', 'custom'])
def test_build_volume_kwargs_order_and_report(cache, build_inputs, tmp_path, monkeypatch, cfg, expected):
    calls = []

    def observe(name, function):
        def wrapped(*args, **kwargs):
            calls.append((name, kwargs))
            return function(*args, **kwargs)
        return wrapped

    for name in ('densify', 'volume', 'lock'):
        monkeypatch.setattr(tr, name, observe(name, getattr(tr, name)))
    orig, proc = build_inputs
    tr.build(cache['root'], 'TinyMap', orig, proc, tmp_path / 'patch', cache['spec'], cfg=cfg)
    assert [name for name, _ in calls] == ['densify', 'volume', 'lock']
    assert calls[1][1] == expected
    info = tr.read_json(tmp_path / 'patch/TinyMap/build.json')['TREE_TEST']
    assert info['volume'] == expected


@pytest.mark.parametrize('invalid', [False, 1, [], 'default'])
def test_build_rejects_non_object_volume(cache, tmp_path, invalid):
    with pytest.raises(ValueError, match='cfg.volume must be an object or null'):
        tr.build(cache['root'], 'TinyMap', tmp_path / 'orig', tmp_path / 'proc', tmp_path / 'patch',
                 cache['spec'], cfg={'volume': invalid})
    assert not (tmp_path / 'patch').exists()


@pytest.mark.parametrize('mode', ['RGB', 'RGBA', 'L'])
def test_refine_sheet_copies_rgb_and_preserves_layout(cache, tmp_path, mode):
    orig, first, refined = (tmp_path / name for name in ('orig', 'first', 'refined'))
    tr.extract(cache['root'], 'TinyMap', orig)
    common = ['--map', 'TinyMap', '--spec', str(cache['spec_path']), '--orig-dir', str(orig), '--sheet', 'tiny']
    assert tr.main(['sheet', *common, '--work-dir', str(first)]) == 0
    previous = tmp_path / 'previous.png'
    pixels = np.full((1024, 1536, 4), [48, 135, 67, 80], np.uint8)
    pixels[200:400, 300:600] = [140, 65, 30, 255]
    Image.fromarray(pixels).convert(mode).save(previous)
    source_bytes = previous.read_bytes()
    assert tr.main(['sheet', *common, '--work-dir', str(refined), '--refine-from', str(previous)]) == 0
    assert tr.read_json(refined / 'layout.json') == tr.read_json(first / 'layout.json')
    with Image.open(refined / 'input.png') as im:
        assert im.mode == 'RGB' and im.size == (1536, 1024)
        np.testing.assert_array_equal(np.asarray(im), tr.read_image(previous, 'RGB'))
    assert previous.read_bytes() == source_bytes
    prompt = (refined / 'prompt.txt').read_text()
    assert 'sheet of 1 separate trees/bushes, already redrawn once' in prompt
    assert 'Rows (left to right): 1.\n1. ' + cache['spec']['descriptions']['TREE_TEST'] in prompt
    assert 'SAME 1 plants' in prompt and 'exactly the same 1 plants' in prompt
    assert prompt != (first / 'prompt.txt').read_text()
    assert not any(token in prompt for token in ('{n}', '{rowtxt}', '{lines}'))


@pytest.mark.parametrize('size', [(1535, 1024), (1536, 1023), (1024, 1536)])
def test_refine_sheet_rejects_wrong_size(cache, tmp_path, size, capsys):
    previous = tmp_path / 'previous.png'
    Image.new('RGB', size).save(previous)
    out = tmp_path / 'refined'
    with pytest.raises(SystemExit) as exc:
        tr.main(['sheet', '--map', 'TinyMap', '--spec', str(cache['spec_path']), '--orig-dir', str(tmp_path / 'orig'),
                 '--sheet', 'tiny', '--work-dir', str(out), '--refine-from', str(previous)])
    assert exc.value.code == 1
    assert 'exactly 1536x1024' in capsys.readouterr().err
    assert not out.exists()


def test_fit_and_shadows_cli_round_trip_unchanged_alpha(cache, tmp_path):
    orig, work, patches = (tmp_path / n for n in ('orig', 'work', 'patch'))
    tr.extract(cache['root'], 'TinyMap', orig)
    common = ['--cache-root', str(cache['root']), '--map', 'TinyMap']
    assert tr.main(['fit-shadows', *common, '--spec', str(cache['spec_path']), '--orig-dir', str(orig),
                    '--work-dir', str(work)]) == 0
    fitted = tr.read_json(work / 'shadow_fit.json')
    assert list(fitted) == ['TREE_TEST']
    assert len(fitted['TREE_TEST']['params']) == 5
    assert 0 <= fitted['TREE_TEST']['iou'] <= 1
    save(patches / 'TinyMap/TREE_TEST_2x.png', cache['hd'][6:18, 4:16])
    assert tr.main(['shadows', *common, '--patch-dir', str(patches), '--fit', str(work / 'shadow_fit.json')]) == 0
    np.testing.assert_array_equal(tr.read_image(patches / 'TinyMap/TREE_TEST_s1x.png'),
                                  cache['one'][9:13, 11:16])


@pytest.mark.parametrize('regular', [False, True], ids=['symlink-atlas', 'regular-atlas'])
@pytest.mark.parametrize('normals', [False, True], ids=['colour-only', 'with-materials'])
def test_apply_only_pastes_listed_rects_and_never_writes_through_symlinks(cache, tmp_path, monkeypatch,
                                                                      regular, normals):
    base, variant = cache['base'], tmp_path / 'variant'
    originals = {p.name: p.read_bytes() for p in base.iterdir()}
    patches = tmp_path / 'patch'
    patch = patches / 'TinyMap'
    patch.mkdir(parents=True)
    (patch / 'build.json').write_text(json.dumps({'TREE_TEST': {'rect': cache['rect'], 'src': 'chosen'}}))
    n2 = np.full((12, 12, 4), [80, 135, 60, 255], np.uint8)
    n1 = np.full((6, 6, 4), [42, 0, 0, 255], np.uint8)
    s1 = np.zeros((4, 5, 4), np.uint8)
    s1[1:3, 1:4] = [1, 0, 0, 255]
    save(patch / 'TREE_TEST_2x.png', n2)
    save(patch / 'TREE_TEST_1x.png', n1)
    save(patch / 'TREE_TEST_s1x.png', s1)
    # A stray patch must not be applied merely because its name resembles a sprite.
    save(patch / 'TREE_UNTOUCHED_2x.png', np.zeros((8, 8, 4), np.uint8))
    expected_hd, expected_one = cache['hd'].copy(), cache['one'].copy()
    if regular:
        expected_hd[0, 0] = [1, 2, 3, 4]
        expected_one[0, 0] = [9, 8, 7, 6]
        save(variant / 'sprites@2x.png', expected_hd)
        save(variant / 'sprites.png', expected_one)
    expected_hd[6:18, 4:16] = n2
    expected_one[3:9, 2:8] = n1
    expected_one[9:13, 11:16] = s1
    monkeypatch.chdir(tmp_path)
    args = ['apply', '--map', 'TinyMap', '--patch-dir', 'patch', '--base', 'cache/TinyMap',
            '--variant-dir', 'variant']
    assert tr.main(args + (['--normals'] if normals else [])) == 0
    np.testing.assert_array_equal(tr.read_image(variant / 'sprites@2x.png'), expected_hd)
    np.testing.assert_array_equal(tr.read_image(variant / 'sprites.png'), expected_one)
    for name in ('sprites@2x.png', 'sprites.png', 'l3_frames_trees.json'):
        assert (variant / name).is_file() and not (variant / name).is_symlink()
    assert (variant / 'manifest.json').is_symlink() and (variant / 'manifest.json').exists()
    assert {p.name: p.read_bytes() for p in base.iterdir()} == originals
    log = tr.read_json(variant / 'l3_frames_trees.json')
    assert len(log['frames']) == 1
    frame = log['frames'][0]
    assert frame['rect1x'] == cache['rect'] and frame['rect2x'] == [4, 6, 12, 12]
    assert frame['shadow_rect1x'] == cache['shadow_rect']
    assert frame['source'] == 'chosen'
    material_path = variant / 'sprites@2x-normals.png'
    if normals:
        assert not material_path.is_symlink()
        materials = tr.read_image(material_path)
        outside = np.ones(materials.shape[:2], bool)
        outside[6:18, 4:16] = False
        assert np.all(materials[outside] == 127)
        assert np.any(materials[6:18, 4:16] != 127)
        assert 'sprites@2x-normals.png' in frame['files']
    else:
        assert material_path.is_symlink()


def test_apply_rejects_base_as_variant(cache, tmp_path):
    with pytest.raises(ValueError, match='different'):
        tr.apply('TinyMap', cache['base'], cache['base'], tmp_path / 'patch')


def test_cli_defaults_and_required_subcommands():
    parser = tr.build_parser()
    args = parser.parse_args(['build', '--cache-root', 'cache', '--map', 'map', '--spec', 'spec.json',
                              '--orig-dir', 'orig', '--proc-dir', 'proc', '--patch-dir', 'patch'])
    assert args.kL == 1.0 and args.cfg is None
    assert (tr.REF, tr.KAB, tr.KC, tr.LIFT) == ('2x', 1.0, 0.8, 0.0)
    assert tr.DENSIFY == {'edge': 2, 'rscale': 0.035, 'shade': 0.42, 'sat': 0.8}
    assert tr.VOLUME == {'strength': 1.3, 'density': 0.1}
    with pytest.raises(SystemExit) as exc:
        parser.parse_args([])
    assert exc.value.code == 2
    with pytest.raises(SystemExit):
        parser.parse_args(['build', '--cfg', '[]'])


def test_spec_rejects_processed_source_escaping_its_root(cache):
    spec = cache['spec']
    spec['selection']['TREE_TEST'] = '../outside'
    cache['spec_path'].write_text(json.dumps(spec))
    with pytest.raises(ValueError, match='relative'):
        tr.load_spec(cache['spec_path'])


def test_spec_tolerates_round_notes_and_unknown_top_level_keys(cache):
    spec = cache['spec']
    spec.update(rounds='Refine the first model output in round 2.', future_metadata={'round': 2})
    cache['spec_path'].write_text(json.dumps(spec))
    assert tr.load_spec(cache['spec_path']) == spec
