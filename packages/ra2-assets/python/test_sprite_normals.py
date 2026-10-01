"""Asset-free tests: python3 -m pytest packages/ra2-assets/python/test_sprite_normals.py -q."""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import numpy as np
import pytest
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


@pytest.fixture
def library(tmp_path):
    source = tmp_path / "library"
    source.mkdir()
    rect = [3, 4, 16, 18]
    frame = {"rect": rect, "offset": [22, -18], "page": 0}
    other = {"rect": [22, 3, 8, 10], "offset": [0, -10], "page": 1}
    manifest = {
        "spriteAtlases": [], "spriteAtlasesHd": [],
        "sprites": {
            "building:TEST": {"frames": [frame, other]},
            "anim:TEST_A": {"frames": [{**frame, "page": 1}, {**other, "page": 0}]},
            "tree:TEST": {"frames": [{"rect": [2, 26, 8, 8], "offset": [-4, -8], "page": 0}]},
        },
        "types": {"TEST": {"sprite": "building:TEST", "foundation": [2, 1],
                             "building": {"layers": [{"sprite": "anim:TEST_A", "damagedSprite": "anim:TEST_AD"}]}}},
    }
    rgb, alpha, _ = box_building(32, 36, 18)
    for page in range(2):
        indexed = np.zeros((40, 32), np.uint8)
        rgba = np.zeros((80, 64, 4), np.uint8)
        indexed[4:22, 3:19] = alpha.reshape(18, 2, 16, 2).max(axis=(1, 3)).astype(np.uint8) * 100
        rgba[8:44, 6:38, :3] = np.round(rgb * 255).astype(np.uint8)
        rgba[8:44, 6:38, 3] = alpha.astype(np.uint8) * 255
        # Only page 1 has art at this rectangle. Page 0's HD colour alone must not count as indexed coverage.
        indexed[3:13, 22:30] = 100 if page == 1 else 0
        rgba[6:26, 44:60] = [100, 120, 140, 255]
        indexed[26:34, 2:10] = 100
        rgba[52:68, 4:20] = [50, 150, 50, 255]
        Image.fromarray(indexed).save(source / f"sprites-{page}.png")
        Image.fromarray(rgba).save(source / f"sprites-{page}@2x.png")
        manifest["spriteAtlases"].append({"file": f"sprites-{page}.png", "width": 32, "height": 40})
        manifest["spriteAtlasesHd"].append({"file": f"sprites-{page}@2x.png", "remap": f"remap-{page}.png",
                                           "width": 64, "height": 80, "scale": 2})
    (source / "library.json").write_text(json.dumps(manifest))
    return source, manifest


def run_library(source, output, *options):
    assert sn.main(["--library", str(source), "--out-dir", str(output), *options]) == 0
    return json.loads((output / "normals.json").read_text())


def pixels(path):
    with Image.open(path) as im:
        return np.array(im)


def test_library_layout_foundations_and_empty_frames(library, tmp_path):
    source, manifest = library
    before = {p.name: p.read_bytes() for p in source.iterdir()}
    output = tmp_path / "materials"
    with patch.object(sn, "classify_building", wraps=sn.classify_building) as classify:
        sidecar = run_library(source, output)
    assert sidecar["version"] == 1
    assert sidecar["encoding"] == sn.ENCODING
    assert set(sidecar["pages"]) == {"0", "1"}
    assert sidecar["pages"]["0"] == {
        "file": "sprites-0@2x-normals.png", "atlas": "sprites-0@2x.png", "width": 64, "height": 80,
        "scale": 2, "materialWidth": 32, "materialHeight": 40, "frames": 1,
    }
    assert sidecar["pages"]["1"]["frames"] == 2
    for page in (0, 1):
        data = pixels(output / sidecar["pages"][str(page)]["file"])
        valid = np.zeros((40, 32), bool)
        valid[4:22, 3:19] = True
        if page == 1:
            valid[3:13, 22:30] = True
        assert np.all(data[valid, 3] > 0)
        assert np.all(data[~valid] == 0)
    # Both the body and the anim get the non-square foundation from the building type (corner x = 16 at 2x).
    assert sum(call.args[2] == 16 for call in classify.call_args_list) == 2
    assert {p.name: p.read_bytes() for p in source.iterdir()} == before
    frames = sn.library_frames(manifest, ["anim:"], None)
    assert frames[1][0][3]["foundation"] == [2, 1]
    manifest["types"] = {}
    manifest["sprites"]["anim:TEST_A"]["foundation"] = [9, 9]
    assert sn.library_frames(manifest, ["anim:"], None)[1][0][3]["foundation"] == [1, 1]


def test_library_keeps_one_pixel_wide_nonempty_frames(library, tmp_path):
    source, manifest = library
    manifest["sprites"]["building:TEST"]["frames"].append({"rect": [0, 0, 1, 2], "offset": [0, 0], "page": 0})
    (source / "library.json").write_text(json.dumps(manifest))
    indexed = pixels(source / "sprites-0.png")
    indexed[:2, :1] = 100
    Image.fromarray(indexed).save(source / "sprites-0.png")
    rgba = pixels(source / "sprites-0@2x.png")
    rgba[:4, :2] = [120, 120, 120, 255]
    Image.fromarray(rgba).save(source / "sprites-0@2x.png")
    output = tmp_path / "materials"
    sidecar = run_library(source, output, "--pages", "0")
    assert sidecar["pages"]["0"]["frames"] == 2
    assert np.all(pixels(output / sidecar["pages"]["0"]["file"])[:2, :1, 3] > 0)


def test_library_downsample_matches_2x_area_filter(library, tmp_path):
    source, _ = library
    full, small = tmp_path / "2x", tmp_path / "1x"
    run_library(source, full, "--out-scale", "2")
    run_library(source, small)
    for page in (0, 1):
        filename = f"sprites-{page}@2x-normals.png"
        encoded = pixels(full / filename).astype(np.float32)
        expected = np.round(sn.downsample_material(encoded))
        actual = pixels(small / filename)
        assert actual.shape == (40, 32, 4)
        np.testing.assert_allclose(actual, expected, atol=1)
        assert np.array_equal(actual[..., 3] == 0, expected[..., 3] == 0)


def test_area_filter_ignores_no_data_in_every_channel():
    data = np.zeros((4, 6, 4), np.float32)
    data[0, 0] = [0.2, 0.8, 1.0, 0.6]
    data[1, 1] = [0.6, 0.4, 0.2, 1.0]
    data[0, 4] = [0.1, 0.9, 0.4, 0.3]
    data[2:, :, :3] = 1  # Even nonzero RGB is no-data when alpha is zero.
    down = sn.downsample_material(data)
    np.testing.assert_allclose(down[0, 0], [0.4, 0.6, 0.6, 0.8])
    np.testing.assert_allclose(down[0, 2], data[0, 4])
    assert np.all(down[1] == 0)
    assert np.all(down[0, 1] == 0)


def test_library_page_selection_only_and_merge(library, tmp_path):
    source, _ = library
    output = tmp_path / "materials"
    first = run_library(source, output, "--pages", "0")
    original = (output / first["pages"]["0"]["file"]).read_bytes()
    merged = run_library(source, output, "--pages", "1", "--only", "anim:TEST_A#0", "--out-scale", "2")
    assert merged["pages"]["0"] == first["pages"]["0"]
    assert (output / first["pages"]["0"]["file"]).read_bytes() == original
    assert merged["pages"]["1"]["frames"] == 1
    assert merged["pages"]["1"]["materialWidth"] == 64
    assert not pixels(output / merged["pages"]["1"]["file"])[6:26, 44:60].any()
    replaced = run_library(source, output, "--pages", "1", "--only", "building:TEST")
    assert replaced["pages"]["0"] == first["pages"]["0"]
    assert replaced["pages"]["1"]["materialWidth"] == 32
    assert not list(output.glob("*.tmp"))


def test_library_default_pages_require_hd_and_selected_data(library, tmp_path):
    source, manifest = library
    manifest["spriteAtlasesHd"][0] = None
    (source / "library.json").write_text(json.dumps(manifest))
    sidecar = run_library(source, tmp_path / "materials", "--only", "anim:TEST_A")
    assert set(sidecar["pages"]) == {"1"}
    with pytest.raises(ValueError, match="no HD atlas"):
        run_library(source, tmp_path / "missing", "--pages", "0")


def test_library_higher_resolution_colour_uses_2x_classifier(library, tmp_path):
    source, manifest = library
    ref = manifest["spriteAtlasesHd"][0]
    with Image.open(source / ref["file"]) as im:
        im.resize((128, 160), Image.Resampling.NEAREST).save(source / "sprite-4x.png")
    ref.update(file="sprite-4x.png", width=128, height=160, scale=4)
    (source / "library.json").write_text(json.dumps(manifest))
    sidecar = run_library(source, tmp_path / "materials", "--pages", "0")
    assert sidecar["pages"]["0"]["scale"] == 4
    assert sidecar["pages"]["0"]["width"] == 128
    assert sidecar["pages"]["0"]["materialWidth"] == 32


def test_library_cli_excludes_cache_and_rejects_invalid_pages():
    with pytest.raises(SystemExit):
        sn.build_parser().parse_args(["--library", "a", "--cache", "b"])
    for value in ("-1", "0,no", ""):
        with pytest.raises(SystemExit):
            sn.build_parser().parse_args(["--library", "a", "--pages", value])


if __name__ == "__main__":
    unittest.main()
