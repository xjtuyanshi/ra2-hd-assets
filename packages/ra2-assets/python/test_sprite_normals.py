"""Asset-free tests: python -B -m unittest discover -s packages/ra2-assets/python -p 'test_sprite_normals.py'."""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

import numpy as np
from PIL import Image

import sprite_normals as sn


def box_building(width: int = 96, height: int = 120, wall: int = 70) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """A synthetic isometric box at 2x: roof diamond on top, a lit +z wall left and a darker +x wall right.

    Returns rgb, alpha and the true face index per pixel (0 roof, 1 +z wall, 2 +x wall, -1 empty)."""
    rgb = np.zeros((height, width, 3), np.float32)
    faces = np.full((height, width), -1, np.int32)
    cx = width // 2
    half = width // 2
    top = 4
    for y in range(height):
        for x in range(width):
            dx = x - cx
            # Roof: a diamond of half-width `half` and half-height half/2 starting at `top`.
            ry = y - top
            if abs(dx) / half + abs(ry - half / 2) / (half / 2) <= 1:
                faces[y, x] = 0
                continue
            base_left = top + half / 2 + (dx + half) / 2  # roof edge from the left corner down to the front corner
            base_right = top + half - dx / 2
            if -half <= dx < 0 and base_left <= y <= base_left + wall:
                faces[y, x] = 1
            elif 0 <= dx <= half and base_right <= y <= base_right + wall:
                faces[y, x] = 2
    shade = {0: 0.8, 1: 0.6, 2: 0.38}
    for f, v in shade.items():
        rgb[faces == f] = v
    # Window grid: vertical columns every 8 px, rows along each wall's own axis.
    for y in range(height):
        for x in range(width):
            f = faces[y, x]
            dx = x - cx
            if f == 1 and x % 8 < 3 and int(y - dx / 2) % 10 < 5:
                rgb[y, x] *= 0.35
            if f == 2 and x % 8 < 3 and int(y + dx / 2) % 10 < 5:
                rgb[y, x] *= 0.35
    alpha = (faces >= 0).astype(np.float32)
    return rgb, alpha, faces


class GeometryTests(unittest.TestCase):
    def test_camera_basis_round_trip(self):
        n = sn.normalise(np.array([[0.3, 0.8, 0.5], [1.0, 0.0, 0.0], [0.0, 0.0, 1.0]]))
        back = sn.to_world(sn.to_camera(n))
        self.assertLess(np.abs(back - n).max(), 1e-9)

    def test_face_colours_of_the_assist_convention(self):
        # The documented render colours decode to the three world face normals.
        colours = np.array([[128, 238, 191], [38, 83, 206], [218, 83, 206]], np.float32) / 255
        world = sn.to_world(sn.normalise(colours * 2 - 1))
        self.assertGreater(world[0, 1], 0.98)
        self.assertGreater(world[1, 2], 0.98)
        self.assertGreater(world[2, 0], 0.98)

    def test_shift_moves_content(self):
        a = np.zeros((5, 5), bool)
        a[1, 1] = True
        self.assertTrue(sn.shift(a, 2, 1, False)[2, 3])
        self.assertFalse(sn.shift(a, 2, 1, False)[1, 1])


class ClassifierTests(unittest.TestCase):
    def test_box_walls_and_roof(self):
        rgb, alpha, faces = box_building()
        prob, stats = sn.classify_building(rgb, alpha, corner_x=48.0, corner_width=12.0)
        label = prob.argmax(-1)
        for f in (1, 2):
            inner = faces == f
            self.assertGreater((label[inner] == f).mean(), 0.7, f"face {f}")
        self.assertGreater(stats["wallZ"] + stats["wallX"], 0.4)

    def test_material_occlusion_and_normals(self):
        rgb, alpha, faces = box_building()
        prob = np.zeros(faces.shape + (3,), np.float32)
        for f in range(3):
            prob[..., f] = (faces == f) * 0.98 + 0.01
        normal, spec, ao = sn.building_material(rgb, alpha, prob, None)
        wall_z = faces == 1
        self.assertGreater(normal[wall_z][:, 2].mean(), 0.9)
        self.assertGreater(normal[faces == 2][:, 0].mean(), 0.9)
        # Walls darken towards their foot; the middle of a wall is left alone.
        ys, xs = np.nonzero(wall_z)
        foot = ao[ys.max() - 1, xs[ys.argmax()]]
        self.assertLess(foot, 0.8)
        self.assertGreaterEqual(spec.min(), 0.0)
        self.assertLessEqual(spec.max(), 1.0)


class GlassTests(unittest.TestCase):
    @staticmethod
    def wall(height: int = 90, width: int = 120) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        """A flat light facade (all +z wall) with no panes yet: rgb, weight and face probabilities."""
        rgb = np.full((height, width, 3), 0.7, np.float32)
        weight = np.ones((height, width), np.float32)
        sharp = np.zeros((height, width, 3), np.float32)
        sharp[..., sn.WALL_Z] = 1.0
        return rgb, weight, sharp

    def test_components_holes_and_depth(self):
        mask = np.zeros((9, 12), bool)
        mask[1:4, 1:4] = True
        mask[5:8, 6:11] = True
        mask[6, 8] = False  # an enclosed one-pixel hole
        labels, n = sn.label_components(mask)
        self.assertEqual(n, 2)
        self.assertEqual(len(set(labels[mask].tolist())), 2)
        filled = sn.fill_small_holes(mask, 4)
        self.assertTrue(filled[6, 8])
        self.assertFalse(filled[0, 0])
        self.assertEqual(sn.erosion_depth(mask, 5)[2, 2], 1)
        self.assertEqual(sn.erosion_depth(mask, 5)[1, 1], 0)

    def test_a_pane_with_a_dark_centre_is_glass_all_over(self):
        rgb, weight, sharp = self.wall()
        # Panes 10 x 14 px: dark grey-blue rim, near-black centre (the case that used to leave a hollow ring).
        for top in (10, 40):
            for left in range(10, 110, 20):
                rgb[top:top + 14, left:left + 10] = (0.2, 0.22, 0.28)
                rgb[top + 3:top + 11, left + 2:left + 8] = (0.03, 0.03, 0.04)
        glass = sn.glass_panes(rgb, weight, sharp, None)
        pane = np.zeros(weight.shape, bool)
        for top in (10, 40):
            for left in range(10, 110, 20):
                pane[top:top + 14, left:left + 10] = True
        self.assertGreater(glass[pane].min(), 0.85)
        self.assertEqual(float(glass[~pane].max()), 0.0)

    def test_wide_dark_openings_and_rooftop_units_are_not_glass(self):
        rgb, weight, sharp = self.wall()
        # A shop front 40 px wide with a soft gradient (black under the lintel, dark grey lower down).
        for row in range(30):
            rgb[55 + row, 20:60] = 0.02 + 0.006 * row
        # A dark unit standing among roof pixels.
        sharp[0:20, 70:120] = (1, 0, 0)
        sharp[5:15, 90:100] = (0, 1, 0)
        rgb[5:15, 90:100] = 0.15
        glass = sn.glass_panes(rgb, weight, sharp, None)
        self.assertEqual(float(glass[55:85, 20:60].max()), 0.0)
        self.assertEqual(float(glass[5:15, 90:100].max()), 0.0)

    def test_warm_dark_patches_are_not_glass(self):
        rgb, weight, sharp = self.wall()
        rgb[30:44, 30:40] = (0.3, 0.16, 0.08)  # dark brick or wood
        self.assertEqual(float(sn.glass_panes(rgb, weight, sharp, None).max()), 0.0)


class AssistTests(unittest.TestCase):
    def render(self, faces: np.ndarray, swap: bool = False) -> np.ndarray:
        colours = np.array([[128, 238, 191], [38, 83, 206], [218, 83, 206]], np.uint8)
        if swap:
            colours = colours[[0, 2, 1]]
        out = np.zeros(faces.shape + (3,), np.uint8)
        for f in range(3):
            out[faces == f] = colours[f]
        return out

    def test_aligns_and_accepts_a_consistent_render(self):
        rgb, alpha, faces = box_building()
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "r.png"
            Image.fromarray(np.roll(self.render(faces), (2, -3), (0, 1))).save(path)
            assist = sn.load_assist(path, alpha)
        self.assertEqual(assist["shift"], [3, -2])
        self.assertGreater(assist["iou"], 0.97)
        prob, _ = sn.classify_building(rgb, alpha, 48.0, 12.0)
        check = sn.check_assist(assist, rgb, alpha, prob, 48.0)
        ok, reasons = sn.assist_passes(check, 0.88)
        self.assertTrue(ok, reasons)
        self.assertGreater(check["shadingRatioZX"], 1.0)

    def test_rejects_swapped_walls(self):
        rgb, alpha, faces = box_building()
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "r.png"
            Image.fromarray(self.render(faces, swap=True)).save(path)
            assist = sn.load_assist(path, alpha)
        prob, _ = sn.classify_building(rgb, alpha, 48.0, 12.0)
        ok, reasons = sn.assist_passes(sn.check_assist(assist, rgb, alpha, prob, 48.0), 0.88)
        self.assertFalse(ok)
        self.assertTrue(any("brighter" in r or "corner" in r for r in reasons))

    def test_rejects_a_mismatched_silhouette(self):
        rgb, alpha, faces = box_building()
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "r.png"
            render = self.render(faces)
            render[:, :40] = 0
            Image.fromarray(render).save(path)
            assist = sn.load_assist(path, alpha)
        prob, _ = sn.classify_building(rgb, alpha, 48.0, 12.0)
        ok, reasons = sn.assist_passes(sn.check_assist(assist, rgb, alpha, prob, 48.0), 0.88)
        self.assertFalse(ok)
        self.assertTrue(any("IoU" in r for r in reasons))


if __name__ == "__main__":
    unittest.main()
