"""Asset-free tests: python3 -B -m unittest discover -s packages/ra2-assets/python -p 'test_emissive_metrics.py'."""

from __future__ import annotations

import unittest

import numpy as np

import emissive_metrics as em


def scene() -> np.ndarray:
    """Brown ground with a pale glass disc (radius 30 at 80,70), its lower third hidden by a brick block."""
    img = np.zeros((160, 200, 3), np.float32)
    img[...] = (110 / 255, 80 / 255, 60 / 255)
    yy, xx = np.mgrid[0:160, 0:200]
    disc = np.hypot(xx - 80, yy - 70) <= 30
    img[disc] = (200 / 255, 215 / 255, 250 / 255)
    img[90:, 40:120] = (150 / 255, 70 / 255, 50 / 255)
    return img


class EmissiveMetricsTests(unittest.TestCase):
    def test_review_pixel_classes(self):
        px = np.array(
            [[[60, 115, 255], [225, 252, 255], [200, 205, 250], [130, 220, 255], [235, 230, 245], [40, 40, 120]]],
            np.float32,
        ) / 255
        satblue, lavender = em.classes(px)
        # Saturated body blue counts; the cyan-white core (hue < 200) and cyan mid ramp count as neither class.
        self.assertEqual(satblue[0].tolist(), [True, False, False, False, False, False])
        # Pale blue-violet glass is the lavender veil class; a dark saturated blue is too dark for either.
        self.assertEqual(lavender[0].tolist(), [False, False, True, False, True, False])

    def test_counts_in_box(self):
        img = np.zeros((10, 10, 3), np.float32)
        img[2:5, 2:6] = (40 / 255, 100 / 255, 1.0)
        self.assertEqual(em.counts(img, (0, 0, 10, 10)), {'satblue': 12, 'lavender': 0})
        self.assertEqual(em.counts(img, (0, 0, 4, 10))['satblue'], 6)

    def test_fit_sphere_ignores_the_hidden_foot(self):
        fit = em.fit_sphere(scene(), (30, 20, 140, 130), ymax=88)
        self.assertAlmostEqual(fit['cx'], 80, delta=1)
        self.assertAlmostEqual(fit['cy'], 70, delta=1)
        self.assertAlmostEqual(fit['radius'], 30, delta=1)

    def test_fit_requires_glass(self):
        with self.assertRaises(ValueError):
            em.fit_sphere(np.zeros((40, 40, 3), np.float32), (0, 0, 40, 40))

    def test_reach_in_engine_pixels(self):
        base = scene()
        img = base.copy()
        img[70, 80:150] = 1.0  # a bolt 70 device px long to the right of the centre
        r = em.reach(base, img, (80, 70), (0, 0, 200, 160), scale=2)
        self.assertEqual(r['changed'], 70)
        self.assertAlmostEqual(r['max'], 34.5, delta=0.01)
        self.assertEqual(em.reach(base, base, (80, 70), (0, 0, 200, 160))['changed'], 0)


if __name__ == '__main__':
    unittest.main()
