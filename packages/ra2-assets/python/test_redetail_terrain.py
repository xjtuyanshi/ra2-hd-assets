"""Asset-free tests: python3 -B -m unittest discover -s packages/ra2-assets/python -p 'test_redetail_terrain.py'."""

from __future__ import annotations

import json
import os
from pathlib import Path
import stat
import sys
import tempfile
import unittest

import numpy as np
from PIL import Image

import redetail_terrain as rt


def textured_source(width: int, height: int, seed: int = 1) -> np.ndarray:
    """Flat colour blocks with pixel noise and one bright 1 px 'lane marking' row."""
    rng = np.random.default_rng(seed)
    rgb = np.zeros((height, width, 3), np.float32)
    rgb[:, : width // 2] = (80, 120, 50)
    rgb[:, width // 2:] = (60, 62, 66)
    rgb += rng.normal(0, 8, rgb.shape)
    rgb[height // 2, width // 2 + 2:] = (200, 200, 190)
    alpha = np.full((height, width, 1), 255, np.float32)
    return np.clip(np.concatenate([rgb, alpha], -1), 0, 255).astype(np.uint8)


class ColourTests(unittest.TestCase):
    def test_lab_round_trip(self):
        rgb = np.random.default_rng(3).integers(0, 256, (64, 3)).astype(np.float32)
        back = rt.lab_to_srgb(rt.srgb_to_lab(rgb))
        self.assertLess(np.abs(back - rgb).max(), 0.6)

    def test_area_down_keeps_constant_and_averages_linear_light(self):
        flat = np.full((8, 8, 3), 77, np.uint8)
        self.assertTrue((rt.area_down(flat, 4) == 77).all())
        checker = np.zeros((2, 2, 3), np.uint8)
        checker[0, 0] = checker[1, 1] = 255
        # Linear-light mean of 0 and 1 is 0.5, i.e. sRGB 188, not 128.
        self.assertEqual(int(rt.area_down(checker, 2)[0, 0, 0]), 188)

    def test_colour_match_restores_low_frequency_and_keeps_detail(self):
        source = textured_source(32, 24)
        hd = np.asarray(Image.fromarray(source[..., :3]).resize((64, 48), Image.NEAREST), np.float32)
        detail = np.random.default_rng(5).normal(0, 6, hd.shape)
        shifted = np.clip(hd * 0.8 + 30 + detail, 0, 255).astype(np.uint8)
        out = rt.colour_match(shifted, source, 2.0).astype(np.float32)
        low = lambda a: rt.remat.gaussian_blur(np.asarray(a, np.float32), 4.0)
        expected = low(hd)
        self.assertLess(np.abs(low(out) - expected)[8:-8, 8:-8].mean(), 2.0)
        self.assertGreater(np.abs(low(shifted) - expected)[8:-8, 8:-8].mean(), 5.0)
        # High frequencies (the generated detail) survive.
        hp = lambda a: np.asarray(a, np.float32) - low(a)
        corr = np.corrcoef(hp(out)[..., 1].ravel(), hp(shifted)[..., 1].ravel())[0, 1]
        self.assertGreater(corr, 0.9)


class InputTests(unittest.TestCase):
    def test_flat_mask_excludes_marking_and_keeps_noisy_ground(self):
        source = textured_source(40, 30)
        mask = rt.flat_ground_mask(source[..., :3])
        self.assertFalse(mask[15, 30])
        self.assertGreater(mask[:, :15].mean(), 0.9)

    def test_hybrid_with_zero_alpha_is_the_esrgan_input(self):
        source = textured_source(16, 12)
        esr = np.random.default_rng(2).integers(0, 256, (48, 64, 3)).astype(np.uint8)
        self.assertTrue((rt.hybrid_input(esr, source[..., :3], 4, 0.0, 4.0) == esr).all())
        mixed = rt.hybrid_input(esr, source[..., :3], 4, 1.0, 4.0)
        self.assertEqual(mixed.shape, esr.shape)
        self.assertFalse((mixed == esr).all())


FAKE_ESRGAN = """#!{python}
import sys
from PIL import Image
args = dict(zip(sys.argv[1::2], sys.argv[2::2]))
image = Image.open(args["-i"]).convert("RGB")
image.resize((image.width * 4, image.height * 4), Image.NEAREST).save(args["-o"])
"""


class PipelineTests(unittest.TestCase):
    def test_dry_run_region_pastes_with_feather_and_keeps_alpha_and_outside(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            directory = root / "gameres/hd-cache/TEST"
            directory.mkdir(parents=True)
            source = textured_source(64, 48)
            source[0:4, 0:6, 3] = 0
            Image.fromarray(source).save(directory / "terrain-map.png")
            base = np.asarray(Image.fromarray(source).resize((128, 96), Image.NEAREST)).copy()
            base[..., :3] = 90
            base[..., 3] = np.asarray(Image.fromarray(source[..., 3]).resize((128, 96), Image.NEAREST))
            Image.fromarray(base).save(directory / "base@2x.png")
            Image.fromarray(np.zeros((96, 128), np.uint8)).save(directory / "water@2x.png")
            (directory / "manifest.json").write_text(json.dumps({"terrainMap": {
                "file": "base@2x.png", "waterMask": "water@2x.png", "scale": 2, "width": 128, "height": 96}}))
            fake = root / "fake-esrgan"
            fake.write_text(FAKE_ESRGAN.format(python=sys.executable))
            fake.chmod(fake.stat().st_mode | stat.S_IXUSR)
            output = root / "out.png"
            code = rt.main(["--map", "TEST", "--cache", str(root / "gameres/hd-cache"), "--esrgan", str(fake),
                            "--base", "base@2x.png", "--output", str(output), "--work", str(root / "work"),
                            "--region", "40,30,40,30", "--margin", "8", "--tile", "128", "--overlap", "32",
                            "--dry-run"])
            self.assertEqual(code, 0)
            out = np.asarray(Image.open(output))
            self.assertEqual(out.shape, base.shape)
            self.assertTrue((out[..., 3] == base[..., 3]).all())
            outside = np.ones(out.shape[:2], bool)
            outside[22:68, 32:88] = False
            self.assertTrue((out[outside] == base[outside]).all())
            # Inside the region the (identity-diffused) original colours replace the flat grey base.
            inner = out[34:56, 44:76, :3].astype(np.float32)
            self.assertGreater(np.abs(inner - 90).mean(), 10)
            # Feather: the margin blends monotonically from base towards the result.
            ramp = np.abs(out[40, 32:40, :3].astype(np.float32) - 90).mean(-1)
            self.assertLess(ramp[0], ramp[-1])


if __name__ == "__main__":
    unittest.main()
