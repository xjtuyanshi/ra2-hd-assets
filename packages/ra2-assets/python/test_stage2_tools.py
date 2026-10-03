"""Synthetic acceptance of the stage-two ports; no game assets, browser, or image jobs."""

import contextlib
import io
import json
from pathlib import Path
import struct
import tempfile
import threading
import unittest
from unittest import mock

import cv2
import numpy as np
from PIL import Image

import atlas_install as atlas
import building_qa as qa
import civilian_chroma as chroma
import driver_command as command
import image_region_metrics as region
import hybrid_redraw as hr
import live_replay
import native_compare_video as video
import native_frame
import raster_buffers as raster
import redraw_metrics
import yr_zbuffer as depth
import yr_zcheck as zcheck


def write_json(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data))


class Stage2Tests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def test_rgb565_primary_colours_and_endianness(self):
        values = np.frombuffer(bytes.fromhex('00f8e0071f00ffff0000'), dtype='<u2')
        np.testing.assert_array_equal(raster.rgb565(values),
                                      [[255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 255], [0, 0, 0]])

    def test_frozen_replay_carried_arrays_sidebar_and_effects(self):
        state = {'frame': 50, 'sidebar': {'remove': 1}, 'shroud': {'1': 4, '0': 3},
                 'cells': {'values': {'0': 9}}, 'effects': {'bullets': [{'uid': 7}]}}
        source = json.dumps(state)
        snapshots = live_replay.frozen_snapshots(state)
        self.assertEqual([snap['frame'] for snap in snapshots], [48, 49, 50])
        self.assertEqual(snapshots[0]['shroud'], [3, 4])
        self.assertEqual(snapshots[0]['cells'], {'values': [9]})
        self.assertNotIn('cells', snapshots[1])
        self.assertNotIn('sidebar', snapshots[0])
        self.assertEqual(snapshots[2]['effects']['bullets'], [{'uid': 7}])
        self.assertEqual(json.dumps(state), source)
        with self.assertRaises(ValueError):
            live_replay.frozen_snapshots(dict(state, shroud={'2': 3}))
        path = self.root / 'state.json'
        write_json(path, {'state': state})
        out = self.root / 'replays/frozen.json'
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(live_replay.main(['--states', str(path), '--frozen', '--out', str(out)]), 0)
        self.assertEqual(json.loads(out.read_text())['snapshots'], snapshots)

    def test_circular_pitch_offset_and_surface_wrap(self):
        data = np.arange(12, dtype='<u2').tobytes()
        np.testing.assert_array_equal(raster.circular_u16(data, 2, pitch=6, offset=20, surface_delta=2),
                                      [[11, 0], [2, 3], [5, 6], [8, 9]])
        for options in ({'width': 0}, {'width': 2, 'pitch': 2}, {'width': 1, 'offset': 1}):
            with self.assertRaises(ValueError):
                raster.circular_u16(data, **options)
        with self.assertRaises(ValueError):
            raster.circular_u16(b'x', 1)

    def make_depth(self, array, offset=0):
        height, width = array.shape
        ints = [0, 0, width, height, offset, 0, 0, 0, 0, 32768, 0, 0, 0, 0, 0, 0]
        native = self.root / 'pairs' / 'native-01.json'
        write_json(native, {'zbuf': {'zp': 0x1000, 'start': 0x2000,
                                    'hdr': struct.pack('<16i', *ints).hex(), 'shdr': None}})
        buffer = native.with_name('zbuf-01.bin')
        buffer.write_bytes(np.asarray(array, dtype='<u2').tobytes())
        return native, buffer

    def test_yr_depth_unsigned_header_and_null_surface(self):
        native, buffer = self.make_depth(np.array([[0xffff, 1], [2, 3]]), offset=-2)
        decoded, info = depth.decode(native, buffer)
        np.testing.assert_array_equal(decoded, [[3, 0xffff], [1, 2]])
        self.assertEqual(info['off'], 0xfffffffe)
        self.assertIsNone(info['sints'])
        out = self.root / 'decoded.npy'
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(depth.main([str(native), '--buffer', str(buffer), '--out', str(out)]), 0)
        np.testing.assert_array_equal(np.load(out), decoded)

    def test_native_frame_does_not_modify_capture(self):
        pairs = self.root / 'pairs'
        info = pairs / 'native-01.json'
        write_json(info, {'raw': {'w': 2, 'h': 1}, 'state': {'frame': 9}})
        raw = pairs / 'raw-01.rgb565'
        raw.write_bytes(np.array([0xf800, 0x07e0], dtype='<u2').tobytes())
        before = raw.read_bytes(), info.read_bytes()
        out = self.root / 'out.png'
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(native_frame.main([str(pairs), '01', '--out', str(out)]), 0)
        np.testing.assert_array_equal(np.asarray(Image.open(out)), [[[255, 0, 0], [0, 255, 0]]])
        self.assertEqual(before, (raw.read_bytes(), info.read_bytes()))
        raw.write_bytes(b'\0')
        with self.assertRaises(ValueError):
            native_frame.decode(pairs, '01')

    def depth_model(self, gradient=False):
        # A 2x2 building body at screen (0,0), no occluder. All values are synthetic.
        array = np.full((20, 40), 65535, dtype=np.uint16)
        array[:2, :2] = [[32764, 32764], [32764, 32764]] if not gradient else [[32763]*2, [32762]*2]
        native, _ = self.make_depth(array)
        write_json(native.with_name('state-01.json'), {'state': {'view': {'x': 0, 'y': 30},
                   'objects': [{'type': 'TEST', 'x': 256, 'y': 256, 'z': 0}]}})
        library = self.root / 'library.json'
        write_json(library, {'types': {'TEST': {'foundation': [1, 1]}}})
        data = self.root / 'data'
        (data / 'shp').mkdir(parents=True)
        # raw 66 decodes to signed depth 1: K-bottom(1)-2-1 = 32764.
        np.save(data / 'buildngz.npy', np.full((477, 396), 66, dtype=np.uint8))
        write_json(data / 'shp' / 'fake.json', {'cw': 2, 'ch': 2,
                   'frames': [{'x': 1, 'y': 1, 'w': 2, 'h': 2}]})
        (data / 'shp' / 'fake_f0.bin').write_bytes(bytes([1, 1, 1, 1]))
        return native.parent.parent, library, data

    def test_buildngz_exact_and_occluder_counts(self):
        run, library, data = self.depth_model()
        result = zcheck.compare(run, '01', 'TEST', 'fake', 0, library=library, data=data)[0]
        self.assertEqual(result['counts'], {'exact': 4, 'nearer': 0, 'farther': 0})
        path = run / 'pairs' / 'zbuf-01.bin'
        values = np.frombuffer(path.read_bytes(), dtype='<u2').copy()
        values[0] -= 2
        values[1] += 3
        path.write_bytes(values.tobytes())
        result = zcheck.compare(run, '01', 'TEST', 'fake', 0, library=library, data=data)[0]
        self.assertEqual(result['counts'], {'exact': 2, 'nearer': 1, 'farther': 1})
        self.assertEqual(result['farther_median'], 3)

    def test_buildngz_gradient_mode(self):
        run, library, data = self.depth_model(gradient=True)
        result = zcheck.compare(run, '01', 'TEST', 'fake', 0, library=library, data=data, mode='g0:5')[0]
        self.assertEqual(result['counts']['exact'], 4)
        with self.assertRaises(ValueError):
            zcheck.compare(run, '01', 'TEST', 'fake', 0, library=library, data=data, mode='anything')

    def source_atlas(self, mode='map'):
        src = self.root / 'source'
        directory = src / ('TEST' if mode == 'map' else '_library/urban')
        ref = {'file': 'sprites@2x.png', 'remap': 'sprites@2x-remap.png', 'scale': 2}
        write_json(directory / ('manifest.json' if mode == 'map' else 'library.json'),
                   {'spriteAtlasHd': ref} if mode == 'map' else {'spriteAtlasesHd': [None, ref]})
        (directory / ref['file']).write_bytes(b'colour synthetic')
        (directory / ref['remap']).write_bytes(b'remap synthetic')
        return src, directory, ref

    def test_map_install_keeps_base_and_unrelated_fields(self):
        src, directory, ref = self.source_atlas()
        base = self.root / 'base'
        write_json(base / 'TEST/manifest.json', {'version': 7, 'other': {'keep': 1}})
        original = (base / 'TEST/manifest.json').read_bytes()
        farm = self.root / 'farm'
        farm.mkdir()
        (farm / 'TEST').symlink_to(base / 'TEST', target_is_directory=True)
        atlas.install_map(farm, src, 'TEST')
        published = json.loads((farm / 'TEST/manifest.json').read_text())
        self.assertEqual(published['spriteAtlasHd'], ref)
        self.assertEqual(published['other'], {'keep': 1})
        self.assertEqual((base / 'TEST/manifest.json').read_bytes(), original)
        self.assertEqual((farm / 'TEST' / ref['file']).read_bytes(), b'colour synthetic')
        with self.assertRaisesRegex(ValueError, 'already has'):
            atlas.install_map(farm, src, 'TEST')

    def test_missing_remap_never_publishes_map(self):
        src, directory, ref = self.source_atlas()
        (directory / ref['remap']).unlink()
        farm = self.root / 'farm'
        target = farm / 'TEST/manifest.json'
        write_json(target, {'version': 1})
        before = target.read_bytes()
        with self.assertRaises(FileNotFoundError):
            atlas.install_map(farm, src, 'TEST')
        self.assertEqual(target.read_bytes(), before)

    def test_overlay_empty_slot_and_compose_lock_cow(self):
        src, directory, ref = self.source_atlas('overlay')
        base = self.root / 'base'
        write_json(base / '_library/urban/library.json', {'spriteAtlasesHd': [None], 'keep': 5})
        original = (base / '_library/urban/library.json').read_bytes()
        farm = self.root / 'farm'
        farm.mkdir()
        (farm / '_library').symlink_to(base / '_library', target_is_directory=True)
        atlas.install_overlay(farm, src, 'urban', 1)
        current = json.loads((farm / '_library/urban/library.json').read_text())
        self.assertEqual(current['spriteAtlasesHd'][1]['file'], 'sprites@2x-s2b.png')
        self.assertEqual(current['keep'], 5)
        self.assertEqual((base / '_library/urban/library.json').read_bytes(), original)
        self.assertFalse((base / '_library/urban/.compose.lock').exists())
        atlas.install_overlay(farm, src, 'urban', 1, suffix='different')
        self.assertEqual(json.loads((farm / '_library/urban/library.json').read_text()), current)
        self.assertFalse((farm / '_library/urban/sprites@2x-different.png').exists())

    def test_atlas_refuses_traversal(self):
        for name in ('..', '/abs', 'x/y'):
            with self.assertRaises(ValueError):
                atlas.component(name)
        with self.assertRaises(ValueError):
            atlas.install_overlay(self.root, self.root, 'urban', -1)

    def test_civilian_lock_preserves_alpha_and_source(self):
        src = self.root / 'sheet'
        src.mkdir()
        design = np.full((32, 32, 3), 118, np.uint8)
        design[4:28, 4:28] = [160, 120, 30]
        redraw = np.dstack((design.copy(), np.full((32, 32), 203, np.uint8)))
        redraw[4:28, 4:28, :3] = [60, 100, 180]
        Image.fromarray(design).save(src / 'input.png')
        Image.fromarray(redraw).save(src / 'output.png')
        (src / 'layout.json').write_text('{}')
        before = (src / 'output.png').read_bytes()
        out = self.root / 'locked'
        chroma.stage(src, out)
        result = np.asarray(Image.open(out / 'output.png'))
        np.testing.assert_array_equal(result[..., 3], redraw[..., 3])
        self.assertEqual((src / 'output.png').read_bytes(), before)
        self.assertTrue((out / 'layout.json').is_symlink())
        self.assertEqual((out / 'layout.json').resolve(), (src / 'layout.json').resolve())
        lab_o = cv2.cvtColor(design.astype(np.float32)/255, cv2.COLOR_RGB2LAB)
        lab_f = cv2.cvtColor(result[..., :3].astype(np.float32)/255, cv2.COLOR_RGB2LAB)
        lab_r = cv2.cvtColor(redraw[..., :3].astype(np.float32)/255, cv2.COLOR_RGB2LAB)
        self.assertLess(np.linalg.norm(lab_f[16, 16, 1:]-lab_o[16, 16, 1:]),
                        np.linalg.norm(lab_r[16, 16, 1:]-lab_o[16, 16, 1:]))
        with self.assertRaises(ValueError):
            chroma.stage(src, src)

    def test_chroma_gain_retains_background_and_alpha(self):
        design = np.full((32, 32, 3), 118, np.uint8)
        design[6:26, 6:26] = [160, 140, 40]
        redraw = np.dstack((design, np.full((32, 32), 255, np.uint8)))
        plain = chroma.lock_pixels(design, redraw)
        gained = chroma.lock_pixels(design, redraw, gain=1.6)
        np.testing.assert_array_equal(plain[0], gained[0])
        np.testing.assert_array_equal(plain[..., 3], gained[..., 3])
        self.assertFalse(np.array_equal(plain[16, 16], gained[16, 16]))

    def test_region_metrics_crop_and_classes(self):
        image = np.full((8, 8, 3), 128, np.uint8)
        image[2:6, 4:6] = [0, 0, 255]
        result = region.measure(image, (1, 1, 3, 3), scale=2)
        self.assertEqual(result['highlight_V_median'], 1)
        self.assertEqual(result['highlight_V_p95'], 1)
        self.assertEqual(result['ground_sd'], 0)
        self.assertEqual(result['ground_a'], 0)
        self.assertEqual(result['ground_b'], 0)
        with self.assertRaises(ValueError):
            region.measure(image, (0, 0, 1, 1))
        with self.assertRaises(ValueError):
            region.measure(image, (0, 0, 9, 9))

    def test_qa_thresholds_remain_calibrated(self):
        good = dict(sil_iou=.85, solidity=.45, outside_frac=.04, edge_corr_s2=.55,
                    grid_applies=True, grid_min=.30, dab_final=[7, 16], hue_shift=12,
                    mean_ab_shift=6, texture_gain=1.2, reg_params=[1, 0, 1])
        self.assertEqual(qa.verdict(good), [])
        changes = [('sil_iou', .84, 'silhouette'), ('outside_frac', .041, 'outside'),
                   ('edge_corr_s2', .54, 'structure'), ('grid_min', .29, 'grid'),
                   ('dab_final', [7.1, 16], 'colour'), ('hue_shift', 12.1, 'colour'),
                   ('mean_ab_shift', 6.1, 'colour'), ('texture_gain', 1.19, 'no-detail'),
                   ('reg_params', [1.13, 0, 1], 'framing')]
        for key, value, warning in changes:
            with self.subTest(key=key):
                self.assertEqual(qa.verdict(dict(good, **{key: value})), [warning])
        self.assertEqual(qa.verdict(dict(good, sil_iou=.2, solidity=.44)), [])
        self.assertEqual(qa.verdict(dict(good, grid_min=0, grid_applies=False)), [])

    def test_registered_metrics_measure_identity_and_texture_gain(self):
        post = self.root / 'job/post'
        post.mkdir(parents=True)
        y, x = np.mgrid[:48, :48]
        pixels = np.full((48, 48, 3), 118, np.uint8)
        pixels[4:44, 4:44] = (65 + (x[4:44, 4:44]//4 % 2)*35 + (y[4:44, 4:44]//4 % 2)*25)[..., None]
        alpha = np.zeros((48, 48), np.uint8)
        alpha[4:44, 4:44] = 255
        Image.fromarray(pixels).save(post / 'orig2x.png')
        Image.fromarray(pixels).save(post / 'shown2x.png')
        Image.fromarray(np.dstack((pixels, alpha))).save(post / 'box_rgba.png')
        margin = qa.br.M
        padded = np.pad(pixels, ((2*margin, 2*margin), (2*margin, 2*margin), (0, 0)), constant_values=118)
        Image.fromarray(np.repeat(np.repeat(padded, 2, axis=0), 2, axis=1)).save(post / 'reg4x.png')
        options = dict(margin=margin, directions=hr.DIRECTIONS, min_grid_area=hr.GRID_MIN_AREA)
        result = redraw_metrics.metrics(post.parent, **options)
        self.assertEqual(result['dab_final'], [0, 0])
        self.assertEqual(result['mean_ab_shift'], 0)
        self.assertEqual(result['edge_corr_s2'], 1)
        self.assertEqual(result['texture_gain'], 1)
        self.assertEqual(result['outside_frac'], 0)
        self.assertIn('no-detail', qa.verdict(result))
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(qa.main([str(post.parent)]), 0)
        self.assertEqual(json.loads((post / 'qa.json').read_text())['texture_gain'], 1)
        detailed = pixels.copy()
        detailed[8:40, 8:40] = np.clip(detailed[8:40, 8:40].astype(int) +
                                      (((x[8:40, 8:40]+y[8:40, 8:40]) % 2)*2-1)[..., None]*12, 0, 255)
        Image.fromarray(detailed).save(post / 'shown2x.png')
        self.assertGreater(redraw_metrics.metrics(post.parent, **options)['texture_gain'], 1.2)

    def test_command_atomic_publication_result_and_resume(self):
        run = self.root / 'run'
        (run / 'cmd').mkdir(parents=True)
        (run / 'done').mkdir()
        name = command.submit(run, [{'op': 'state', 'name': 'test'}])
        self.assertEqual(json.loads((run / 'cmd' / name).read_text())[0]['op'], 'state')
        self.assertFalse(list((run / 'cmd').glob('*.tmp')))
        with self.assertRaises(TimeoutError):
            command.wait_result(run, name, timeout=0)
        result = run / 'done' / f'{name}.result'
        result.write_text('["ok"]')
        self.assertEqual(command.wait_result(run, name, timeout=0), result)
        output = io.StringIO()
        with contextlib.redirect_stdout(output), contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(command.main(['--run', str(run), '--wait', name, '--result-file']), 0)
        self.assertEqual(output.getvalue().strip(), str(result))

    def test_command_wait_with_fake_driver(self):
        run = self.root
        (run / 'cmd').mkdir()
        (run / 'done').mkdir()
        name = command.submit(run, {'op': 'now'})
        timer = threading.Timer(.02, lambda: (run / 'done' / f'{name}.result').write_text('[123]'))
        timer.start()
        try:
            self.assertEqual(command.wait_result(run, name, timeout=1, interval=.01).read_text(), '[123]')
        finally:
            timer.join()
        with self.assertRaises(ValueError):
            command.wait_result(run, '../x.json', timeout=0)

    def make_recordings(self):
        nrec = self.root / 'nrec'
        nrec.mkdir()
        write_json(nrec / 'meta.json', {'w': 16, 'h': 12, 'times': [1000, 1100, 1200]})
        for index, value in enumerate((0xf800, 0x07e0, 0x001f)):
            (nrec / f'chunk-{index:05}.bin').write_bytes(np.full((12, 16), value, dtype='<u2').tobytes())
        hd = self.root / 'hd.mp4'
        writer = cv2.VideoWriter(str(hd), cv2.VideoWriter_fourcc(*'mp4v'), 10, (32, 24))
        self.assertTrue(writer.isOpened(), 'synthetic mp4v encoder unavailable')
        try:
            for index in range(3):
                frame = np.full((24, 32, 3), [255, 0, 0], np.uint8)
                frame[:, :16] = [0, 255, 255]
                writer.write(frame)
        finally:
            writer.release()
        return nrec, hd

    def test_timestamp_comparison_encodes_cropped_sides_and_reads_back(self):
        nrec, hd = self.make_recordings()
        out = self.root / 'comparison.mp4'
        result = video.render(out, nrec, hd, 1000, (8, 0, 8, 12), hd_width=16,
                              font=None, labels=('Original', 'HD'), scale=2, fps=10, fourcc='mp4v')
        self.assertTrue(result['ok'])
        self.assertEqual(result['written'], 3)
        capture = cv2.VideoCapture(str(out))
        try:
            ok, frame = capture.read()
            self.assertTrue(ok)
            self.assertEqual(frame.shape[:2], (58, 40))
            self.assertGreater(int(frame[45, 4, 2]), 220)  # native red
            self.assertGreater(int(frame[45, 28, 0]), 220)  # HD right-half blue
            self.assertLess(int(frame[45, 28, 2]), 30)
        finally:
            capture.release()

    def test_recording_errors_are_failures(self):
        nrec, hd = self.make_recordings()
        meta = nrec / 'meta.json'
        write_json(meta, {'w': 16, 'h': 12, 'times': [1000]})
        with self.assertRaisesRegex(ValueError, 'timestamps'):
            video.native_frames(nrec)
        write_json(meta, {'w': 16, 'h': 12, 'times': [1000, 1100, 1200]})
        with self.assertRaisesRegex(ValueError, 'overlap'):
            video.render(self.root / 'out.mp4', nrec, hd, 2000, (0, 0, 16, 12), hd_width=16, font=None)
        with self.assertRaisesRegex(ValueError, 'overwrite'):
            video.render(hd, nrec, hd, 1000, (0, 0, 16, 12), hd_width=16, font=None)

    def test_video_readback_mismatch_is_reported(self):
        nrec, hd = self.make_recordings()
        with mock.patch.object(video, 'count_frames', return_value=0):
            result = video.render(self.root / 'mismatch.mp4', nrec, hd, 1000, (0, 0, 16, 12),
                                  hd_width=16, font=None, labels=('A', 'B'), fourcc='mp4v')
        self.assertFalse(result['ok'])


if __name__ == '__main__':
    unittest.main()
