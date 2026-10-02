"""Asset-free regressions for effect page rims, late debris and interior fire chunks."""

import contextlib
import io
import json
from pathlib import Path
import tempfile
import unittest

import numpy as np
from PIL import Image

import effect_cleanup as ec


def frame_with(rim_level, size=48):
    """A grey smoke disc (straight level 0.3) on transparency, with a ring of `rim_level` along its silhouette."""
    yy, xx = np.mgrid[:size, :size]
    r = np.hypot(yy - size / 2, xx - size / 2)
    alpha = (r < 18).astype(np.float32)
    level = np.where(r > 16, rim_level, 0.3)
    rgb = np.repeat(level[..., None], 3, axis=-1)
    out = np.zeros((size, size, 4), np.uint8)
    out[..., :3] = (rgb * alpha[..., None] * 255).round()
    out[..., 3] = (alpha * 255).round()
    return out, r


def fire_frame(alpha=1.0):
    """A premultiplied orange disc on transparency, with an opaque dark 5x5 chunk at its centre."""
    yy, xx = np.mgrid[:64, :64]
    disc = np.hypot(yy - 32, xx - 32) < 18
    out = np.zeros((64, 64, 4), np.uint8)
    out[disc] = np.round(np.array([255, 166, 38, 255]) * alpha).astype(np.uint8)
    out[30:35, 30:35] = (15, 15, 15, 255)
    return out


class CleanupTest(unittest.TestCase):
    def test_bright_neutral_rim_is_darkened_to_the_interior(self):
        rgba, r = frame_with(0.7)
        out, changed = ec.derim(rgba)
        self.assertGreater(changed, 0)
        rim = (r > 16) & (r < 18)
        self.assertLess(out[rim][:, 0].mean(), rgba[rim][:, 0].mean() * 0.75)
        inside = r < 10
        np.testing.assert_array_equal(out[inside], rgba[inside])
        np.testing.assert_array_equal(out[..., 3], rgba[..., 3])

    def test_flame_rims_and_dark_rims_are_kept(self):
        rgba, r = frame_with(0.3)
        rgba[(r > 16) & (r < 18), 0] = 250  # orange-red flame along the edge: saturated, untouched
        rgba[(r > 16) & (r < 18), 1] = 120
        rgba[(r > 16) & (r < 18), 2] = 20
        out, changed = ec.derim(rgba)
        self.assertEqual(changed, 0)
        np.testing.assert_array_equal(out, rgba)

    def test_small_dark_specks_are_filled_from_their_surroundings(self):
        rgba = np.zeros((40, 40, 4), np.uint8)
        rgba[5:8, 5:8] = (10, 10, 10, 255)  # a lone fragment in the air
        rgba[20:40, 0:40] = (90, 85, 80, 255)  # smoke body
        rgba[30:32, 30:32] = (8, 8, 8, 255)  # a fragment inside the smoke
        out, filled = ec.despeckle(rgba)
        self.assertGreater(filled, 0)
        self.assertLess(out[6, 6, 3], 60)  # the airborne dot becomes (nearly) transparent
        self.assertGreater(out[31, 31, :3].mean(), 60)  # the dot in the smoke takes the smoke's colour
        big = np.zeros((40, 40, 4), np.uint8)
        big[5:25, 5:25] = (10, 10, 10, 255)  # a large dark mass is not a speck
        self.assertEqual(ec.despeckle(big)[1], 0)

    def test_clean_page_despeckles_only_late_frames(self):
        page = np.zeros((20, 40, 4), np.uint8)
        page[2:4, 2:4] = (10, 10, 10, 255)
        page[2:4, 22:24] = (10, 10, 10, 255)
        meta = {"anims": {"A": {"frames": [{"page": 0, "rect": [0, 0, 20, 20]}, {"page": 0, "rect": [20, 0, 20, 20]}]}}}
        counts = ec.clean_page(page, meta, 0, late=0.5)
        self.assertGreater(counts["speck"], 0)
        self.assertEqual(page[2, 2, 3], 255)  # the early frame keeps its fragment
        self.assertLess(page[2, 22, 3], 128)


class InteriorCleanupTest(unittest.TestCase):
    def test_chunk_inside_bright_orange_disc_is_filled(self):
        rgba = fire_frame()
        out, filled = ec.interior_despeckle(rgba)
        self.assertEqual(filled, 49)
        _, _, straight = ec._straight(out)
        self.assertTrue(np.all((straight[30:35, 30:35] @ ec.LUMA) >= 0.4))
        unchanged = np.ones(rgba.shape[:2], bool)
        unchanged[29:36, 29:36] = False
        np.testing.assert_array_equal(out[unchanged], rgba[unchanged])
        np.testing.assert_array_equal(rgba[30:35, 30:35], np.tile([15, 15, 15, 255], (5, 5, 1)))

    def test_chunk_outside_disc_on_transparency_is_untouched(self):
        rgba = fire_frame()
        rgba[30:35, 30:35] = (255, 166, 38, 255)
        rgba[4:9, 4:9] = (15, 15, 15, 255)
        out, filled = ec.interior_despeckle(rgba)
        self.assertEqual(filled, 0)
        np.testing.assert_array_equal(out, rgba)

    def test_chunk_on_neutral_smoke_is_untouched(self):
        rgba, _ = frame_with(0.3, size=64)
        rgba[30:35, 30:35] = (15, 15, 15, 255)
        out, filled = ec.interior_despeckle(rgba)
        self.assertEqual(filled, 0)
        np.testing.assert_array_equal(out, rgba)

    def test_bright_non_fire_or_low_coverage_ring_is_untouched(self):
        for colour in ((179, 179, 179, 255), (38, 166, 255, 255),
                       (200, 180, 160, 255), (153, 100, 23, 153)):
            with self.subTest(colour=colour):
                rgba = np.empty((64, 64, 4), np.uint8)
                rgba[:] = colour
                rgba[30:35, 30:35] = (15, 15, 15, 255)
                out, filled = ec.interior_despeckle(rgba)
                self.assertEqual(filled, 0)
                np.testing.assert_array_equal(out, rgba)

    def test_interior_dark_threshold_and_minimum_coverage(self):
        rgba = fire_frame()
        rgba[30:35, 30:35] = (50, 50, 50, 255)  # dark for the interior pass, above the late-debris threshold
        self.assertEqual(ec.interior_despeckle(rgba)[1], 49)
        rgba[30:35, 30:35] = (15, 15, 15, 89)  # dark straight colour, but alpha below 0.35
        out, filled = ec.interior_despeckle(rgba)
        self.assertEqual(filled, 0)
        np.testing.assert_array_equal(out, rgba)

    def test_long_crack_over_max_area_inside_fire_is_untouched(self):
        rgba = fire_frame()
        rgba[30:35, 30:35] = (255, 166, 38, 255)
        rgba[29:35, 18:46] = (15, 15, 15, 255)  # 168 texels, all inside the disc
        out, filled = ec.interior_despeckle(rgba)
        self.assertEqual(filled, 0)
        np.testing.assert_array_equal(out, rgba)

    def test_diagonally_connected_chunks_share_the_area_limit(self):
        rgba = fire_frame()
        rgba[35:40, 35:40] = (15, 15, 15, 255)
        out, filled = ec.interior_despeckle(rgba, max_area=25)
        self.assertEqual(filled, 0)
        np.testing.assert_array_equal(out, rgba)

    def test_premultiplied_colour_and_coverage_are_filled_together(self):
        rgba = fire_frame(alpha=0.8)
        out, filled = ec.interior_despeckle(rgba)
        self.assertEqual(filled, 49)
        np.testing.assert_array_equal(out[30:35, 30:35], np.tile([204, 133, 30, 204], (5, 5, 1)))

    def test_ring_ignores_the_one_texel_border_and_respects_thresholds(self):
        rgba = fire_frame()
        rgba[29:36, 29:36] = (77, 77, 77, 255)
        rgba[30:35, 30:35] = (15, 15, 15, 255)
        self.assertEqual(ec.interior_despeckle(rgba)[1], 49)
        for options in ({"max_area": 24}, {"ring_luma": 0.7}):
            with self.subTest(options=options):
                out, filled = ec.interior_despeckle(rgba, **options)
                self.assertEqual(filled, 0)
                np.testing.assert_array_equal(out, rgba)
        rgba[27, 27:38] = (77, 77, 77, 255)  # some of the outer ring is neutral smoke
        self.assertEqual(ec.interior_despeckle(rgba, fire_share=0.7)[1], 49)
        out, filled = ec.interior_despeckle(rgba, fire_share=1.0)
        self.assertEqual(filled, 0)
        np.testing.assert_array_equal(out, rgba)
        self.assertEqual(ec.interior_despeckle(rgba, ring=2, fire_share=1.0)[1], 49)

    def test_cli_interior_only_changes_selected_anim_rects(self):
        for selection, linked in (("A", False), ("A,B", False), (None, False), ("A", True)):
            with self.subTest(selection=selection, linked=linked), tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                farm = root / "farm"
                directory = farm / "_library/common/effects-hd"
                directory.mkdir(parents=True)
                page = np.zeros((68, 208, 4), np.uint8)
                rects = [[4, 2, 64, 64], [72, 2, 64, 64], [140, 2, 64, 64]]
                frame = fire_frame()
                frame[4:9, 4:9] = (15, 15, 15, 255)  # exterior debris must survive even in late frames
                smoke, _ = frame_with(0.7)
                frame[:12, 48:] = smoke[12:24, 12:28]  # bright neutral rim must also survive
                for x, y, w, h in rects:
                    page[y:y + h, x:x + w] = frame
                name = "synthetic.png"
                destination = directory / name
                source = root / "base.png" if linked else destination
                Image.fromarray(page, "RGBA").save(source)
                original_bytes = source.read_bytes()
                if linked:
                    destination.symlink_to(source)
                frames = [{"page": 0, "rect": rect} for rect in rects]
                manifest = directory / "effects-hd.json"
                manifest.write_text(json.dumps({"pages": [{"file": name}], "anims": {
                    "A": {"frames": frames[:2]}, "B": {"frames": frames[2:]},
                }}), encoding="utf-8")
                original_manifest = manifest.read_bytes()
                argv = ["--farm", str(farm), "--interior", "--late", "0.5"]
                if selection is not None:
                    argv += ["--anims", selection]
                output = io.StringIO()
                with contextlib.redirect_stdout(output):
                    self.assertEqual(ec.main(argv + [name]), 0)
                with Image.open(destination) as im:
                    out = np.array(im)
                selected = {0, 1} if selection == "A" else {0, 1, 2}
                allowed = np.zeros(page.shape[:2], bool)
                for i in selected:
                    x, y, _, _ = rects[i]
                    allowed[y + 29:y + 36, x + 29:x + 36] = True
                    _, _, straight = ec._straight(out[y + 30:y + 35, x + 30:x + 35])
                    self.assertTrue(np.all((straight @ ec.LUMA) >= 0.4))
                np.testing.assert_array_equal(out[~allowed], page[~allowed])
                self.assertEqual(output.getvalue().strip(), f"{name} {{'interior': {49 * len(selected)}}}")
                self.assertEqual(manifest.read_bytes(), original_manifest)
                self.assertFalse(destination.is_symlink())
                if linked:
                    self.assertEqual(source.read_bytes(), original_bytes)


if __name__ == "__main__":
    unittest.main()
