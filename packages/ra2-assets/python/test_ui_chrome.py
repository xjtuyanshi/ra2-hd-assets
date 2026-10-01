"""Synthetic-only chrome geometry, credits cleaning and ECC registration regressions."""

import json
from pathlib import Path
import tempfile
import unittest

import cv2
import numpy as np
from PIL import Image

import ui_chrome as chrome
import ui_cameos as cameos


def texture(width: int, height: int) -> np.ndarray:
    rng = np.random.default_rng(42)
    noise = rng.uniform(40, 210, (height, width, 3)).astype(np.float32)
    rgb = cv2.GaussianBlur(noise, (0, 0), 2)
    cv2.rectangle(rgb, (12, 10), (width - 18, height - 12), (180, 100, 65), 3)
    cv2.circle(rgb, (width // 3, height // 3), max(3, height // 8), (80, 190, 140), -1)
    cv2.line(rgb, (width // 2, 8), (width // 2 + 16, height - 8), (60, 100, 210), 4)
    return np.clip(rgb, 0, 255).astype(np.uint8)


class ChromeTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix=".tmp-ui-chrome-", dir=Path(__file__).parent)
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.job = self.root / "job"

    def make_sheet(self):
        Image.fromarray(texture(360, 192)).save(self.root / "frame.png")
        # A nondefault frame and nonzero command origin catch accidentally retained 1152x744 constants.
        geometry = {"sidebar_x": 300, "piece_height": 64, "command_bar_rect": [20, 178, 280, 14],
                    "credits_rect": [313, 5, 30, 12]}
        return chrome.sheet(self.root / "frame.png", "Synthetic side", self.job, geometry)

    def test_clean_credits_only_changes_selected_native_band(self):
        array = np.full((80, 120, 3), 65, np.uint8)
        array[12:19, 81:83] = 250
        array[12:19, 88:90] = 250
        array[30, 20] = 250  # bright detail outside the credits band
        result, mask = chrome.clean_credits(Image.fromarray(array), [76, 9, 30, 14])
        cleaned = np.array(result)
        self.assertLess(cleaned[15, 81].mean(), 90)
        self.assertGreater(mask.sum(), 0)
        np.testing.assert_array_equal(cleaned[mask == 0], array[mask == 0])
        self.assertEqual(mask[30, 20], 0)

    def test_sheet_uses_configurable_geometry_scale_prompts_and_cleaned_reference(self):
        layout = self.make_sheet()
        self.assertEqual(layout["frame"], {"width": 360, "height": 192})
        self.assertEqual(layout["scale"], 3)
        self.assertEqual(len(layout["parts"]), 5)
        self.assertEqual(layout["parts"][0]["src"], [300, 0, 360, 64])
        self.assertEqual(layout["parts"][3]["src"], [20, 178, 160, 192])
        self.assertEqual(layout["parts"][4]["src"], [160, 178, 300, 192])
        self.assertEqual(cameos.load_image(self.job / "input.png").size, (1536, 1024))
        prompt = (self.job / "prompt.txt").read_text()
        self.assertIn("Synthetic side", prompt)
        self.assertNotIn("{SIDE}", prompt)
        self.assertNotIn("{WIDTH}", prompt)
        self.assertTrue((self.job / "credits_mask.png").exists())
        for part in layout["parts"]:
            x, y, width, height = part["dst"]
            self.assertGreaterEqual(min(x, y), 0)
            self.assertLessEqual(x + width, 1536)
            self.assertLessEqual(y + height, 1024)

    def test_ecc_recovers_known_small_shift_and_scale(self):
        reference = texture(180, 144)
        expected = np.float32([[1.018, 0.006, 4.5], [-0.004, 0.984, 3.2]])
        redraw = cv2.warpAffine(reference, expected, (200, 164), flags=cv2.INTER_CUBIC, borderMode=cv2.BORDER_REPLICATE)
        aligned, report = chrome.register_piece(reference, redraw)
        warp = np.array(report["warp"])
        np.testing.assert_allclose(warp[:, :2], expected[:, :2], atol=0.004)
        np.testing.assert_allclose(warp[:, 2], expected[:, 2], atol=0.4)
        self.assertGreater(report["correlation"], 0.98)
        self.assertLess(report["residual"], 1.2)
        before = np.abs(redraw[:144, :180].astype(float) - reference).mean()
        after = np.abs(aligned.astype(float) - reference).mean()
        self.assertLess(after, before / 3)

    def test_pack_registered_pieces_native_anchor_rectangles_and_manifest(self):
        layout = self.make_sheet()
        reference = cameos.load_image(self.job / "input.png")
        # Shift the entire model sheet; each part's expanded ECC search must undo it.
        warp = np.float32([[1, 0, 3], [0, 1, 2]])
        redraw = cv2.warpAffine(np.array(reference), warp, reference.size, flags=cv2.INTER_CUBIC, borderMode=cv2.BORDER_REPLICATE)
        Image.fromarray(redraw).save(self.job / "output.png")
        output = self.root / "cache"
        manifest = chrome.pack(self.job, output)
        self.assertEqual(manifest, json.loads((output / "chrome.json").read_text()))
        self.assertEqual(manifest["frame"], {"width": 360, "height": 192})
        self.assertEqual(manifest["pieces"][0], {"file": "sidebar0.png", "rect": {"x": 0, "y": 0, "width": 60, "height": 64}, "anchor": "sidebar"})
        self.assertEqual(manifest["pieces"][2]["rect"]["y"], 128)
        self.assertEqual(manifest["pieces"][3], {"file": "command0.png", "rect": {"x": 0, "y": 0, "width": 140, "height": 14}, "anchor": "commandBar"})
        self.assertEqual(manifest["pieces"][4]["rect"]["x"], 140)
        for part in layout["parts"]:
            self.assertEqual(cameos.load_image(output / f"{part['name']}.png").size, tuple(part["dst"][2:]))
        reports = json.loads((output / "registration.json").read_text())["pieces"]
        self.assertEqual(len(reports), 5)
        self.assertLess(max(report["residual"] for report in reports), 2)

    def test_cli_json_geometry_overrides_and_default_layout_dimensions(self):
        Image.fromarray(texture(360, 192)).save(self.root / "frame.png")
        cameos.write_json(self.root / "geometry.json", {"sidebar_x": 300, "piece_height": 60,
                                                        "command_bar_rect": [20, 178, 280, 14], "credits_rect": [313, 5, 30, 12]})
        self.assertEqual(chrome.main(["sheet", "--frame", str(self.root / "frame.png"), "--side", "Test",
                                      "--job-dir", str(self.job), "--geometry", str(self.root / "geometry.json"),
                                      "--piece-height", "64", "--materials", "steel", "--colours", "blue"]), 0)
        self.assertEqual(len(json.loads((self.job / "layout.json").read_text())["parts"]), 5)
        self.assertIn("steel", (self.job / "prompt.txt").read_text())
        Image.fromarray(texture(1152, 744)).save(self.root / "default.png")
        layout = chrome.sheet(self.root / "default.png", "Test", self.root / "default-job", chrome.DEFAULT_GEOMETRY)
        self.assertEqual(layout["parts"][0]["dst"], [6, 6, 504, 744])
        self.assertEqual(layout["parts"][3]["dst"], [30, 776, 1476, 96])
        self.assertEqual(layout["parts"][4]["dst"], [30, 902, 1476, 96])

    def test_failed_ecc_never_writes_success_manifest_and_invalid_geometry_fails(self):
        with self.assertRaisesRegex(ValueError, "ECC registration failed"):
            chrome.register_piece(np.zeros((80, 100, 3), np.uint8), np.zeros((80, 100, 3), np.uint8))
        self.make_sheet()
        Image.new("RGB", (1536, 1024), "black").save(self.job / "output.png")
        with self.assertRaises(ValueError):
            chrome.pack(self.job, self.root / "failed-cache")
        self.assertFalse((self.root / "failed-cache/chrome.json").exists())
        with self.assertRaises(ValueError):
            chrome.sheet(self.root / "frame.png", "Test", self.root / "bad-job", chrome.DEFAULT_GEOMETRY)


if __name__ == "__main__":
    unittest.main()
