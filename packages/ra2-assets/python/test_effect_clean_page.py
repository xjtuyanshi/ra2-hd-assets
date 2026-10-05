"""Asset-free tests of the clean HD page builder; run with pytest or python3 test_effect_clean_page.py."""

from __future__ import annotations

import json
from pathlib import Path
import tempfile
import unittest

import numpy as np
from PIL import Image

import effect_clean_page as clean
import effect_flipbooks as fx
from test_effect_flipbooks import synthetic_library


class CleanPageTest(unittest.TestCase):
    def test_frame_keeps_native_geometry_and_colour(self):
        palette = np.zeros((256, 3), np.uint8)
        palette[1] = (255, 165, 40)
        idx = np.zeros((10, 12), np.uint8)
        idx[4:7, 5:9] = 1  # 4 x 3 native pixels at (5, 4)
        frame = clean.clean_frame(idx, palette, scale=2, pad=2)
        rgba = frame["rgba"]
        # A straight edge magnifies to coverage 0.75 inside and 0.25 outside, which the sharpening turns into 1 and
        # 0: the crop is the 8 x 6 texel block plus 2 texels (one native pixel) of padding on each side.
        self.assertEqual(frame["scale"], 2)
        self.assertEqual(rgba.shape[:2], (6 + 4, 8 + 4))
        # Top-left of the crop relative to the canvas centre (6, 5) in native pixels.
        self.assertEqual(frame["offset"], [5 - 1 - 6, 4 - 1 - 5])
        # The interior is fully covered and has the palette colour (premultiplied by 1).
        self.assertEqual(rgba[5, 6].tolist(), [255, 165, 40, 255])
        # The four convex corners keep coverage 0.75 * 0.75, which the sharpening rounds off (alpha 203).
        self.assertEqual(int((rgba[..., 3] == 255).sum()), 8 * 6 - 4)
        self.assertEqual([int(rgba[r, c, 3]) for r, c in ((2, 2), (2, 9), (7, 2), (7, 9))], [203] * 4)
        # Outside the sharpened edge nothing is stored, and no colour leaks from palette index 0.
        self.assertEqual(rgba[0, 0].tolist(), [0, 0, 0, 0])
        self.assertTrue((rgba[..., 3] > 0).sum() >= 8 * 6)
        self.assertIsNone(clean.clean_frame(np.zeros((4, 4), np.uint8), palette))

    def test_install_appends_to_a_farm_without_writing_its_base(self):
        with tempfile.TemporaryDirectory() as scratch:
            root = Path(scratch)
            library = synthetic_library(root / "native")
            base = root / "base/_library/common/effects-hd"
            base.mkdir(parents=True)
            Image.fromarray(np.zeros((4, 4, 4), np.uint8), "RGBA").save(base / "effects-hd-0.png")
            original = {
                "version": 1,
                "pages": [{"file": "effects-hd-0.png", "width": 4, "height": 4}],
                "anims": {"OLD": {"scale": 2, "frames": [{"page": 0, "rect": [0, 0, 2, 2], "offset": [0, 0]}]}},
            }
            (base / "effects-hd.json").write_text(json.dumps(original))
            farm = root / "farm"
            farm.mkdir()
            (farm / "_library").symlink_to(root / "base/_library")

            frames = clean.clean_frames(library, "TINY", 2)
            self.assertEqual([frame is None for frame in frames], [False, False, True])
            entry = clean.install(farm, "TINY", frames, page_size=256)
            data = json.loads((farm / clean.HD_DIR / "effects-hd.json").read_text())
            self.assertEqual(json.loads((base / "effects-hd.json").read_text()), original)
            self.assertFalse((farm / "_library").is_symlink())
            self.assertEqual(data["anims"]["OLD"], original["anims"]["OLD"])
            self.assertEqual([page["file"] for page in data["pages"]], ["effects-hd-0.png", "effects-hd-clean-tiny-0.png"])
            self.assertEqual(data["anims"]["TINY"], entry)
            self.assertEqual(entry["scale"], 2)
            self.assertEqual([None if f is None else f["page"] for f in entry["frames"]], [1, 1, None])
            # Frame 0: native rect 3 x 2 at offset (-5, -4) from the canvas centre; the crop starts one pixel earlier.
            self.assertEqual(entry["frames"][0]["offset"], [-6, -5])
            self.assertEqual(entry["frames"][0]["rect"][2:], [3 * 2 + 4, 2 * 2 + 4])
            page = np.array(Image.open(farm / clean.HD_DIR / "effects-hd-clean-tiny-0.png"))
            x, y, w, h = entry["frames"][0]["rect"]
            # Its top-left texel is a rounded corner: premultiplied in linear light, the palette colour once divided.
            corner = page[y + 2, x + 2].astype(float)
            self.assertEqual(int(corner[3]), 203)
            straight = fx.l2s(fx.s2l(corner[:3]) / (corner[3] / 255))
            np.testing.assert_allclose(straight, [255, 165, 40], atol=2)
            self.assertFalse((base / "effects-hd-clean-tiny-0.png").exists())

            # Installing again replaces the same page and entry instead of adding another.
            clean.install(farm, "TINY", frames, page_size=256)
            again = json.loads((farm / clean.HD_DIR / "effects-hd.json").read_text())
            self.assertEqual(again, data)

    def test_cli_reports_unknown_anim(self):
        with tempfile.TemporaryDirectory() as scratch:
            root = Path(scratch)
            synthetic_library(root / "native")
            with self.assertRaises(SystemExit):
                clean.main(["--effects", str(root / "native"), "--farm", str(root / "farm"), "--anim", "NOPE"])
            self.assertEqual(clean.main(["--effects", str(root / "native"), "--farm", str(root / "farm"), "--anim", "TINY"]), 0)
            self.assertTrue((root / "farm" / clean.HD_DIR / "effects-hd.json").exists())


if __name__ == "__main__":
    unittest.main()
