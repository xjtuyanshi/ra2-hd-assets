"""Asset-free live-pair crops, spatial boards and metrics from synthetic guest frames."""

import contextlib
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock

import cv2
import numpy as np
from PIL import Image, ImageFont

import live_pair_metrics as metrics
from live_pair_metrics import engine_box_to_pixels, house_pixels, side_by_side


class LivePairMetricsTests(unittest.TestCase):
    def test_engine_box_maps_1x_2x_and_independent_axis_scales(self):
        box = (100, 200, 140, 230)
        self.assertEqual(engine_box_to_pixels(box, (1152, 744)), box)
        self.assertEqual(engine_box_to_pixels(box, (2304, 1488)), (200, 400, 280, 460))
        self.assertEqual(engine_box_to_pixels(box, (2304, 744)), (200, 200, 280, 230))
        self.assertEqual(engine_box_to_pixels((1, 1, 3, 3), (1728, 1116)), (1, 1, 5, 5))
        self.assertEqual(engine_box_to_pixels((0, 0, 1152, 744), (1728, 1116)), (0, 0, 1728, 1116))
        self.assertEqual(engine_box_to_pixels((0, 0, 1152, 744), (1277, 823)), (0, 0, 1277, 823))

    def test_invalid_engine_boxes_are_refused(self):
        for box in ((-1, 0, 10, 10), (0, 0, 1153, 10), (0, 0, 10, 745),
                    (10, 0, 10, 10), (0, 10, 10, 0), (0, 0, float('nan'), 10)):
            with self.subTest(box=box), self.assertRaises(ValueError):
                engine_box_to_pixels(box, (1152, 744))

    def test_hue_wrap_inclusive_bounds_and_saturation_value_filters(self):
        hsv = np.array([[[0, 255, 255], [179, 255, 255], [170, 255, 255], [10, 255, 255],
                         [90, 255, 255], [0, 90, 255], [0, 255, 50]]], dtype=np.uint8)
        rgb = cv2.cvtColor(hsv, cv2.COLOR_HSV2RGB)
        self.assertEqual(house_pixels(rgb, (170, 10)), 4)
        self.assertEqual(house_pixels(rgb, (0, 10)), 2)
        self.assertEqual(house_pixels(rgb, (90, 90)), 1)
        self.assertEqual(house_pixels(rgb, (170, 10), smin=80, vmin=40), 6)
        self.assertEqual(house_pixels(rgb, (0, 180), smin=0, vmin=0), 7)

    def test_invalid_hue_and_thresholds_are_refused(self):
        image = np.zeros((1, 1, 3), dtype=np.uint8)
        for hue, smin, vmin in (((-1, 10), 100, 60), ((0, 181), 100, 60),
                                ((0, 10), 256, 60), ((0, 10), 100, -1)):
            with self.subTest(hue=hue, smin=smin, vmin=vmin), self.assertRaises(ValueError):
                house_pixels(image, hue, smin, vmin)

    def test_side_by_side_has_native_size_white_gap_and_no_labels_without_font(self):
        orig = Image.new('RGB', (40, 30), 'red')
        hd = Image.new('RGB', (80, 60), 'blue')
        result = side_by_side(orig, hd, labels=('原版', 'HD'))
        self.assertEqual(result.size, (128, 60))
        pixels = np.asarray(result)
        np.testing.assert_array_equal(pixels[:30, :40], np.asarray(orig))
        np.testing.assert_array_equal(pixels[:, 48:], np.asarray(hd))
        self.assertTrue((pixels[:, 40:48] == 255).all())
        self.assertTrue((pixels[30:, :40] == 255).all())

    def test_supplied_font_adds_a_label_strip_above_unchanged_crops(self):
        orig = Image.new('RGB', (100, 30), 'red')
        hd = Image.new('RGB', (100, 30), 'blue')
        result = side_by_side(orig, hd, labels=('Original', 'HD'), font=ImageFont.load_default())
        strip = result.height - orig.height
        self.assertGreater(strip, 8)
        self.assertEqual(result.width, 208)
        pixels = np.asarray(result)
        self.assertTrue((pixels[:strip] < 255).any())
        self.assertTrue((pixels[:, 100:108] == 255).all())
        np.testing.assert_array_equal(pixels[strip:, :100], np.asarray(orig))
        np.testing.assert_array_equal(pixels[strip:, 108:], np.asarray(hd))

    def test_long_labels_do_not_paint_into_the_white_gap_of_narrow_crops(self):
        image = Image.new('RGB', (8, 8), 'red')
        result = side_by_side(image, image, labels=('Original', 'HD'), font=ImageFont.load_default())
        self.assertEqual(result.width, 24)
        self.assertTrue((np.asarray(result)[:, 8:16] == 255).all())

    def fake_pairs(self, root):
        orig = np.zeros((744, 1152, 3), dtype=np.uint8)
        hd = np.zeros((1488, 2304, 3), dtype=np.uint8)
        orig[202:207, 102:110] = (255, 0, 0)  # 40 pixels in the engine box.
        hd[404:414, 204:220] = (255, 0, 0)  # Same rectangle at 2x: 160 pixels.
        # Matching hue outside the box must not contribute.
        orig[0:20, 0:20] = (255, 0, 0)
        hd[0:40, 0:40] = (255, 0, 0)
        Image.fromarray(orig).save(root / 'orig-02.png')
        Image.fromarray(hd).save(root / 'hd-02.png')
        return ['--pairs', str(root), '--id', '02', '--box', '100', '200', '140', '230']

    def test_house_cli_counts_same_engine_box_and_ratio_at_different_scales(self):
        with tempfile.TemporaryDirectory() as directory:
            args = self.fake_pairs(Path(directory))
            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                metrics.main(['house', *args, '--hue', '170', '10'])
            self.assertEqual(json.loads(output.getvalue()), {'orig': 40, 'hd': 160, 'ratio': 4.0})
            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                metrics.main(['house', *args, '--hue', '50', '70'])
            self.assertEqual(json.loads(output.getvalue()), {'orig': 0, 'hd': 0, 'ratio': 0.0})

    def test_house_cli_zero_original_count_uses_one_as_denominator(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            args = self.fake_pairs(root)
            Image.new('RGB', (1152, 744), 'black').save(root / 'orig-02.png')
            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                metrics.main(['house', *args, '--hue', '170', '10'])
            self.assertEqual(json.loads(output.getvalue()), {'orig': 0, 'hd': 160, 'ratio': 160.0})

    def test_crop_cli_writes_both_crops_and_gap_without_a_font(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            args = self.fake_pairs(root)
            out = root / 'crops/pair.png'
            metrics.main(['crop', *args, '--out', str(out), '--labels', '原版', 'HD'])
            with Image.open(out) as result:
                self.assertEqual(result.size, (128, 60))
                self.assertEqual(result.getpixel((2, 2)), (255, 0, 0))
                self.assertEqual(result.getpixel((52, 4)), (255, 0, 0))
                self.assertEqual(result.getpixel((40, 0)), (255, 255, 255))


class SpatialMetricsTests(unittest.TestCase):
    def fake_snapshot(self, root, wrapped=True):
        snapshot = {'view': {'x': 60, 'y': 85}, 'objects': [
            {'type': 'NAWEAP', 'owner': 1, 'x': 4096, 'y': 1024, 'z': 104},
            {'type': 'OTHER', 'owner': 0, 'x': 4096, 'y': 1024, 'z': 104},
            {'type': 'NAWEAP', 'owner': 0, 'x': 4352, 'y': 1280, 'z': 104},
            {'type': 'NAWEAP', 'owner': 0, 'x': 4096, 'y': 1024, 'z': 104},
        ]}
        (root / 'native-07.json').write_text(json.dumps({'state': snapshot} if wrapped else snapshot),
                                            encoding='utf-8')
        return {'label': '苏军工厂', 'pairs': str(root), 'idx': '07',
                'find': {'type': 'NAWEAP', 'owner': 0, 'near': [300, 200]},
                'size': [40, 30], 'off': [10, -5]}

    def fake_frames(self, root):
        for prefix, factor in (('orig', 1), ('hd', 2)):
            frame = np.full((744 * factor, 1152 * factor, 3), 255, dtype=np.uint8)
            # The rectangle's centre is the found object's projected position plus the row offset.
            frame[190 * factor:200 * factor, 304 * factor:316 * factor] = (255, 0, 0)
            Image.fromarray(frame).save(root / f'{prefix}-07.png')

    def test_projection_owner_nearest_hint_offset_and_both_snapshot_formats(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for wrapped in (True, False):
                with self.subTest(wrapped=wrapped):
                    row = self.fake_snapshot(root, wrapped)
                    box = metrics.spatial_row_box(row)
                    self.assertEqual(box, (290, 180, 330, 210))
                    self.assertEqual(((box[0] + box[2]) / 2, (box[1] + box[3]) / 2), (310, 195))
                    row['find'].pop('owner')
                    row['off'] = [0, 0]
                    self.assertEqual(metrics.spatial_row_box(row), (280, 185, 320, 215))

    def test_no_hint_prefers_first_on_screen_object_in_full_guest_frame(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            snapshot = {'view': {'x': 0, 'y': 0}, 'objects': [
                {'type': 'UNIT', 'x': -256, 'y': 256, 'z': 0},
                {'type': 'UNIT', 'x': 9216, 'y': 0, 'z': 0},
                {'type': 'UNIT', 'x': 512, 'y': 0, 'z': 0},
            ]}
            (root / 'native-07.json').write_text(json.dumps(snapshot), encoding='utf-8')
            row = {'pairs': str(root), 'idx': '07', 'find': {'type': 'UNIT'}}
            self.assertEqual(metrics.spatial_row_box(row), (970, 460, 1152, 620))

    def test_explicit_and_found_boxes_are_clamped_and_empty_boxes_fail(self):
        self.assertEqual(metrics.spatial_row_box({'box': [-10, -20, 30, 40]}), (0, 0, 30, 40))
        self.assertEqual(metrics.spatial_row_box({'box': [1130, 730, 1170, 770]}), (1130, 730, 1152, 744))
        with tempfile.TemporaryDirectory() as directory:
            row = self.fake_snapshot(Path(directory))
            row['off'] = [-300, -200]
            self.assertEqual(metrics.spatial_row_box(row), (0, 0, 20, 15))
        for box in ([1200, 0, 1300, 20], [0, 0, 0, 20], [0, 0, float('nan'), 20]):
            with self.subTest(box=box), self.assertRaises(ValueError):
                metrics.clamp_engine_box(box)

    def test_pair_and_explicit_replay_scales_crop_same_engine_rectangle(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            row = self.fake_snapshot(root)
            self.fake_frames(root)
            box = metrics.spatial_row_box(row)
            original, original_scale = metrics._scaled_crop(root / 'orig-07.png', box)
            hd, hd_scale = metrics._scaled_crop(root / 'hd-07.png', box)
            self.assertEqual((original.size, original_scale), ((40, 30), 1.0))
            self.assertEqual((hd.size, hd_scale), ((80, 60), 2.0))
            np.testing.assert_array_equal(np.asarray(hd)[::2, ::2], np.asarray(original))
            self.assertEqual(original.getpixel((20, 15)), (255, 0, 0))
            # A replay may have a narrower canvas; its explicit scale still uses the guest origin.
            with Image.open(root / 'hd-07.png') as image:
                image.crop((0, 0, 800, 500)).save(root / 'replay.png')
            replay, replay_scale = metrics._scaled_crop(root / 'replay.png', box, 2)
            self.assertEqual(replay_scale, 2)
            np.testing.assert_array_equal(np.asarray(replay), np.asarray(hd))
            row['tiles'] = [['orig'], ['hd'], ['replay.png', 2]]
            spec = {'title': '空间对照', 'cols': ['原版', 'HD', '回放'], 'rows': [row]}
            # Force the portable font path even on macOS, retaining Unicode input labels.
            with mock.patch.object(metrics, 'BOARD_FONT', root / 'missing-font.ttc'):
                board = metrics.spatial_board(spec, root)
            self.assertEqual(board.width, 280)  # Three 80 px columns plus four 10 px gaps.
            pixels = np.asarray(board)
            red = np.all(pixels == (255, 0, 0), axis=2)
            centres = []
            for x in (10, 100, 190):
                ys, xs = np.nonzero(red[:, x:x + 80])
                self.assertGreater(len(xs), 0)
                self.assertEqual(xs.mean(), 39.5)
                centres.append(ys.mean())
            self.assertEqual(centres, [centres[0]] * 3)

    def test_spatial_cli_resolves_relative_paths_and_writes_bounded_phone_copy(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            pairs = root / 'pairs'
            pairs.mkdir()
            self.fake_frames(pairs)
            row = {'label': '完整战场', 'note': '保留中文标题和说明', 'pairs': 'pairs', 'idx': '07',
                   'box': [-10, -10, 1160, 750]}
            spec = root / 'board.json'
            spec.write_text(json.dumps({'title': '空间对照', 'subtitle': '同一冻结时刻', 'rows': [row]},
                                       ensure_ascii=False), encoding='utf-8')
            out = root / 'output' / 'board.png'
            metrics.main(['spatial', '--spec', str(spec), '--out', str(out)])
            with Image.open(out) as board, Image.open(out.with_name('board_s.jpg')) as phone:
                self.assertEqual(board.format, 'PNG')
                self.assertEqual(board.width, 4638)  # Default 2x, two clamped full-frame tiles.
                self.assertEqual(phone.format, 'JPEG')
                self.assertEqual(max(phone.size), 2000)
                self.assertLessEqual(abs(phone.width / phone.height - board.width / board.height), 0.01)

    def test_missing_object_cli_error_names_type_pair_and_does_not_write_board(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            row = self.fake_snapshot(root)
            row['find']['type'] = 'MISSING'
            spec = root / 'board.json'
            spec.write_text(json.dumps({'title': 'Missing', 'rows': [row]}), encoding='utf-8')
            out = root / 'board.png'
            error = io.StringIO()
            with contextlib.redirect_stderr(error), self.assertRaises(SystemExit) as raised:
                metrics.main(['spatial', '--spec', str(spec), '--out', str(out)])
            self.assertEqual(raised.exception.code, 2)
            self.assertIn('Object type MISSING not found in pair 07', error.getvalue())
            self.assertIn(str(root), error.getvalue())
            self.assertFalse(out.exists())
            self.assertFalse(out.with_name('board_s.jpg').exists())

    def test_single_column_and_unequal_row_tile_counts(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.fake_frames(root)
            row = {'label': 'Small', 'pairs': str(root), 'idx': '07', 'box': [290, 180, 330, 210],
                   'tiles': [['orig']]}
            self.assertEqual(metrics.spatial_board({'title': 'Board', 'scale': 1, 'rows': [row]}).width, 60)
            second = {**row, 'tiles': [['orig'], ['hd']]}
            self.assertEqual(metrics.spatial_board({'title': 'Board', 'rows': [row, second]}).width, 190)


class DarkMetricsTests(unittest.TestCase):
    def fake_dark_frames(self, root):
        paths = []
        for prefix, factor in (('orig', 1), ('hd', 2)):
            frame = np.full((744 * factor, 1152 * factor, 3), 255, dtype=np.uint8)
            # Inside [100,200,110,210]: V 0 = 6 px, V 39 = 4, V 40 = 8, V 59 = 3, V 60 = 5.
            for x0, y0, x1, y1, colour in (
                (100, 200, 103, 202, (0, 0, 0)), (103, 200, 105, 202, (39, 10, 0)),
                (105, 200, 109, 202, (0, 40, 20)), (100, 202, 103, 203, (0, 0, 59)),
                (103, 202, 108, 203, (60, 0, 0)), (0, 0, 20, 20, (0, 0, 0)),
            ):
                frame[y0 * factor:y1 * factor, x0 * factor:x1 * factor] = colour
            path = root / f'{prefix}-07.png'
            Image.fromarray(frame).save(path)
            paths.append(path)
        return paths

    def test_dark_cli_strict_thresholds_exact_counts_and_per_image_scale(self):
        with tempfile.TemporaryDirectory() as directory:
            paths = self.fake_dark_frames(Path(directory))
            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                metrics.main(['dark', *(str(path) for path in paths), '--box', '100', '200', '110', '210'])
            result = json.loads(output.getvalue())
            self.assertEqual(result['threshold'], 40)
            self.assertEqual(result['units'], 'engine_pixels')
            self.assertEqual(result['box'], [100, 200, 110, 210])
            self.assertEqual([image['scale'] for image in result['images']], [1.0, 2.0])
            for image in result['images']:
                self.assertEqual(image['below_threshold'], 10.0)
                self.assertEqual(image['below_60'], 21.0)

    def test_dark_cli_replay_scale_and_custom_threshold(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            _, hd = self.fake_dark_frames(root)
            replay = root / 'replay.png'
            with Image.open(hd) as image:
                image.crop((0, 0, 800, 500)).save(replay)
            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                metrics.main(['dark', str(replay), '--box', '100', '200', '110', '210',
                              '--scale', '2', '--threshold', '50'])
            result = json.loads(output.getvalue())
            self.assertEqual(result['threshold'], 50)
            self.assertEqual(result['images'][0]['scale'], 2)
            self.assertEqual(result['images'][0]['below_threshold'], 18.0)
            self.assertEqual(result['images'][0]['below_60'], 21.0)

    def test_dark_clamping_does_not_count_padding_or_outside_pixels(self):
        with tempfile.TemporaryDirectory() as directory:
            paths = self.fake_dark_frames(Path(directory))
            result = metrics.dark_metrics(paths, [-20, -10, 10, 10])
            self.assertEqual(result['box'], (0, 0, 10, 10))
            for image in result['images']:
                self.assertEqual(image['below_threshold'], 100)
                self.assertEqual(image['below_60'], 100)

    def test_dark_fractional_scale_counts_area_without_resampling(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'fractional.png'
            Image.new('RGB', (1728, 1116), 'black').save(path)
            result = metrics.dark_metrics([path], [2, 2, 6, 6])
            self.assertEqual(result['images'][0]['scale'], 1.5)
            self.assertEqual(result['images'][0]['below_threshold'], 16)
            self.assertEqual(result['images'][0]['below_60'], 16)

    def test_invalid_dark_threshold_scale_and_incomplete_replay_are_refused(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            paths = self.fake_dark_frames(root)
            for threshold in (-1, 256):
                with self.subTest(threshold=threshold), self.assertRaises(ValueError):
                    metrics.dark_metrics(paths, [100, 200, 110, 210], threshold=threshold)
            for scale in (0, -1, float('nan'), float('inf')):
                with self.subTest(scale=scale), self.assertRaises(ValueError):
                    metrics.dark_metrics(paths, [100, 200, 110, 210], scale=scale)
            with self.assertRaisesRegex(ValueError, 'does not cover the engine box'):
                metrics.dark_metrics(paths[:1], [100, 200, 110, 400], scale=2)


if __name__ == '__main__':
    unittest.main()
