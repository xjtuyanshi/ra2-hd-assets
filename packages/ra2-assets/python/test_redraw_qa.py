"""Asset-free posted redraw QA: python3 -B -m unittest test_redraw_qa -v."""

import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

import numpy as np
from PIL import Image

import building_redraw as br
import hybrid_redraw as hr
import redetail_sprites as rd
import redraw_qa as qa


class RedrawQATests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix='.tmp-redraw-qa-', dir=Path(__file__).parent)
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        yy, xx = np.mgrid[:96, :112]
        self.alpha = np.zeros((96, 112), np.uint8)
        self.alpha[6:-6, 6:-6] = 255
        self.lab = np.empty((96, 112, 3), np.float32)
        self.lab[..., 0] = (57 + 7 * np.sin(xx / 7) + 5 * np.cos(yy / 9)
                           + 4 * np.sin((xx + 2 * yy) / 6) + 3 * ((xx + yy) % 2))
        self.lab[..., 1:] = (22, 28)
        self.orig = self.rgb(self.lab)

    def rgb(self, lab):
        image = hr.to_u8(rd.lab_to_srgb(lab))
        image[self.alpha == 0] = int(br.GREY)
        return image

    def job(self, name='job', *, orig=None, shown=None, raw=None, params=None):
        directory = self.root / name
        post = directory / 'post'
        post.mkdir(parents=True)
        orig = self.orig if orig is None else orig
        shown = orig if shown is None else shown
        Image.fromarray(orig).save(post / 'orig2x.png')
        Image.fromarray(shown).save(post / 'shown2x.png')
        Image.fromarray(np.dstack([shown, self.alpha])).save(post / 'box_rgba.png')
        if raw is None:
            raw = np.pad(orig, ((2 * br.M, 2 * br.M), (2 * br.M, 2 * br.M), (0, 0)),
                         constant_values=int(br.GREY))
        Image.fromarray(np.repeat(np.repeat(raw, 2, axis=0), 2, axis=1)).save(post / 'reg4x.png')
        (post / 'post.json').write_text(json.dumps({'params': params or [1, 0, 1, 0]}), encoding='utf-8')
        return directory

    def test_identical_images_have_no_faithfulness_failures(self):
        measured = qa.metrics(self.job())
        self.assertEqual(measured['texture_gain'], 1.0)
        self.assertGreaterEqual(measured['sil_iou'], qa.TH['sil_iou'])
        self.assertEqual(measured['outside_frac'], 0.0)
        self.assertEqual(measured['edge_corr_s2'], 1.0)
        self.assertEqual(measured['grid_min'], 1.0)
        self.assertTrue(measured['grid_applies'])
        self.assertEqual(set(measured['grid']), set(hr.DIRECTIONS))
        for field in ('dE_final', 'dE_raw', 'dab_final', 'dab_raw'):
            self.assertEqual(measured[field], [0.0, 0.0])
        self.assertEqual(measured['hue_shift'], 0.0)
        self.assertEqual(measured['mean_ab_shift'], 0.0)
        self.assertEqual(qa.verdict(measured, {'texture_gain': 1.0}), [])
        # The calibrated redraw gate requires added detail; identity has no gain.
        self.assertEqual(qa.verdict(measured), ['no-detail'])
        self.assertEqual(qa.TH['texture_gain'], 1.2)

    def test_chromatic_hue_rotation_is_colour_failure(self):
        rotated = self.lab.copy()
        angle = np.radians(40)
        a, b = self.lab[..., 1], self.lab[..., 2]
        rotated[..., 1] = a * np.cos(angle) - b * np.sin(angle)
        rotated[..., 2] = a * np.sin(angle) + b * np.cos(angle)
        measured = qa.metrics(self.job(shown=self.rgb(rotated)))
        self.assertAlmostEqual(measured['hue_shift'], 40, delta=1)
        self.assertIn('colour', qa.verdict(measured))

    def test_hue_ignores_original_low_chroma_even_when_final_is_chromatic(self):
        neutral = self.lab.copy()
        neutral[..., 1:] = (3, 0)
        saturated = neutral.copy()
        saturated[..., 1:] = (0, 30)
        measured = qa.metrics(self.job(orig=self.rgb(neutral), shown=self.rgb(saturated)))
        self.assertEqual(measured['hue_shift'], 0.0)
        self.assertIn('colour', qa.verdict(measured))

    def test_hue_preserves_track_selection_for_original_chroma_between_6_and_12(self):
        original = self.lab.copy()
        original[..., 1:] = (9, 0)
        rotated = original.copy()
        rotated[..., 1:] = (0, 9)
        measured = qa.metrics(self.job(orig=self.rgb(original), shown=self.rgb(rotated)))
        self.assertAlmostEqual(measured['hue_shift'], 90, delta=3)
        self.assertIn('colour', qa.verdict(measured))

    def test_hue_uses_original_chroma_when_final_is_near_neutral(self):
        faded = self.lab.copy()
        hue = np.arctan2(28, 22) + np.radians(40)
        faded[..., 1:] = (8 * np.cos(hue), 8 * np.sin(hue))
        measured = qa.metrics(self.job(shown=self.rgb(faded)))
        self.assertAlmostEqual(measured['hue_shift'], 40, delta=2)
        self.assertIn('colour', qa.verdict(measured))

    def test_empty_interior_is_reported_as_an_error(self):
        self.alpha[:] = 0
        neutral = np.full_like(self.orig, int(br.GREY))
        job = self.job(orig=neutral)
        with self.assertRaisesRegex(ValueError, 'no opaque interior'):
            qa.metrics(job)
        process = subprocess.run([sys.executable, '-B', str(Path(qa.__file__)), str(job)],
                                 text=True, capture_output=True)
        self.assertEqual(process.returncode, 1)
        self.assertEqual(len(process.stdout.splitlines()), 1)
        output = json.loads(process.stdout)
        self.assertEqual(output['job'], str(job))
        self.assertIn('no opaque interior', output['error'])
        self.assertFalse((job / 'post' / 'qa.json').exists())

    def test_heavy_blur_has_no_detail(self):
        blurred = hr.to_u8(hr.gaussian_blur(self.orig.astype(np.float32), 6.0))
        measured = qa.metrics(self.job(shown=blurred))
        self.assertLess(measured['texture_gain'], 0.3)
        self.assertIn('no-detail', qa.verdict(measured))

    def test_shifted_registered_raw_fails_silhouette_and_outside(self):
        margin = 2 * br.M
        raw = np.pad(self.orig, ((margin, margin), (margin, margin), (0, 0)),
                     constant_values=int(br.GREY))
        shifted = np.full_like(raw, int(br.GREY))
        shifted[:, 35:] = raw[:, :-35]
        measured = qa.metrics(self.job(raw=shifted))
        self.assertIn('silhouette', qa.verdict(measured))
        self.assertIn('outside', qa.verdict(measured))

    def test_registration_scale_is_framing_failure(self):
        measured = qa.metrics(self.job(params=[1.2, 0, 1, 0]))
        self.assertEqual(measured['reg_params'], [1.2, 0, 1, 0])
        self.assertIn('framing', qa.verdict(measured))

    def test_cli_json_lines_and_saved_report_with_threshold_overrides(self):
        jobs = [self.job('first'), self.job('second')]
        thresholds = self.root / 'thresholds.json'
        thresholds.write_text(json.dumps({'texture_gain': 1.0}), encoding='utf-8')
        for option in ('{"texture_gain": 1.0}', str(thresholds)):
            with self.subTest(option=option):
                process = subprocess.run([sys.executable, '-B', str(Path(qa.__file__)),
                                          *(str(job) for job in jobs), '--thresholds', option],
                                         text=True, capture_output=True, check=True)
                output = [json.loads(line) for line in process.stdout.splitlines()]
                self.assertEqual(len(output), 2)
                for job, line in zip(jobs, output):
                    self.assertEqual(line.pop('job'), str(job))
                    self.assertEqual(line['fails'], [])
                    self.assertEqual(line, json.loads((job / 'post' / 'qa.json').read_text(encoding='utf-8')))
        self.assertEqual(qa.TH['texture_gain'], 1.2)


if __name__ == '__main__':
    unittest.main()
