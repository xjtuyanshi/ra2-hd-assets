"""Synthetic-only regressions: python3 -B -m unittest test_ui_cameos test_ui_chrome -v."""

import json
from pathlib import Path
import shutil
import struct
import tempfile
import unittest
from unittest import mock

import numpy as np
from PIL import Image, ImageDraw, ImageFont

import ui_cameos as ui


def synthetic_extractor(root: Path) -> list[dict]:
    (root / "orig").mkdir(parents=True)
    image = Image.new("RGBA", (60, 48), (68, 88, 105, 255))
    draw = ImageDraw.Draw(image)
    draw.rectangle((0, 0, 2, 2), fill=(0, 0, 0, 0))
    draw.rectangle((20, 38, 21, 43), fill=(245, 245, 245, 255))
    image.save(root / "orig" / "icon.png")
    image.save(root / "orig" / "alternate.png")
    rows = [{"id": "UNIT", "cameo": "icon", "file": "orig/icon.png", "alt": "alternate", "kind": "TestKind",
             "name": "Synthetic unit", "uiName": "NAME:UNIT"},
            {"id": "ALIAS", "cameo": "icon", "file": "orig/icon.png", "kind": "TestKind"},
            {"id": "MISSING", "cameo": "missing", "file": "", "kind": "TestKind"}]
    ui.write_json(root / "cameos.json", rows)
    return rows


def synthetic_grid() -> tuple[Image.Image, list, list]:
    # Deliberately different from the requested cell_rect: a model changed the grid inside its canvas.
    columns, rows = [(28, 183), (220, 375), (414, 569)], [(27, 147), (228, 348)]
    image = Image.new("RGB", (640, 420), (25, 25, 27))
    for row, (y0, y1) in enumerate(rows):
        for column, (x0, x1) in enumerate(columns):
            colour = (90 + column * 40, 110 + row * 50, 170)
            image.paste(colour, (x0, y0, x1, y1))
    return image, columns, rows


class CameoTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix=".tmp-ui-cameos-", dir=Path(__file__).parent)
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.source, self.work, self.output = (self.root / name for name in ("extractor", "work", "cache"))
        self.entries = synthetic_extractor(self.source)

    def make_sheets(self):
        ui.prep(self.source, self.work)
        ui.write_json(self.root / "subjects.json", {"UNIT": "A synthetic test subject", "ALIAS": "Shared art", "MISSING": "No file"})
        (self.root / "prompt.txt").write_text("{N} panels\n{PANELS}", encoding="utf-8")
        Image.new("RGB", (30, 20), "red").save(self.root / "style.png")
        return ui.sheets(self.source, self.work, self.root / "subjects.json", self.root / "prompt.txt", self.root / "style.png")

    def test_prep_erases_baked_glyph_preserves_alpha_and_original(self):
        original = (self.source / "orig/icon.png").read_bytes()
        self.assertEqual(ui.prep(self.source, self.work), 2)
        before = np.array(ui.load_image(self.source / "orig/icon.png", "RGBA"))
        cleaned = np.array(ui.load_image(self.work / "prep/icon.png", "RGBA"))
        np.testing.assert_array_equal(before[..., 3], cleaned[..., 3])
        np.testing.assert_array_equal(before[10:30], cleaned[10:30])
        self.assertLess(cleaned[40, 20, :3].mean(), 130)
        self.assertEqual(original, (self.source / "orig/icon.png").read_bytes())

    def test_sheets_description_selection_dedup_and_empty_panels(self):
        jobs = self.make_sheets()
        self.assertEqual(jobs, ["sheet001"])
        directory = self.work / "jobs" / jobs[0]
        self.assertEqual(ui.load_image(directory / "input.png").size, (1536, 1024))
        layout = json.loads((directory / "layout.json").read_text())
        self.assertEqual(layout, [{"cameo": "icon", "id": "UNIT", "rect": list(ui.cell_rect(0))}])
        text = (directory / "prompt.txt").read_text()
        self.assertIn("A synthetic test subject", text)
        self.assertEqual(text.count("EMPTY"), 5)
        self.assertNotIn("Shared art", text)
        self.assertEqual((directory / "style_reference.png").read_bytes(), (self.root / "style.png").read_bytes())
        x, y, _, _ = ui.cell_rect(5)
        self.assertEqual(ui.load_image(directory / "input.png").getpixel((x + 10, y + 10)), (118, 118, 118))

    def test_gutter_detection_handles_changed_grid_and_rescaled_output(self):
        image, columns, rows = synthetic_grid()
        self.assertEqual(ui.detect_grid(image), (columns, rows))
        larger = image.resize((1280, 840), Image.Resampling.NEAREST)
        self.assertEqual(ui.detect_grid(larger), ([(a * 2, b * 2) for a, b in columns], [(a * 2, b * 2) for a, b in rows]))
        self.assertIsNone(ui.detect_grid(Image.new("RGB", (640, 420), (150, 150, 150))))

    def test_exact_aspect_crop_is_centred_and_never_stretched(self):
        for box in ((0, 0, 180, 100), (10, 20, 110, 220), (3, 8, 166, 129)):
            x0, y0, x1, y1 = ui.aspect_crop(box)
            self.assertEqual((x1 - x0) * 4, (y1 - y0) * 5)
            self.assertLessEqual(abs((x0 + x1) - (box[0] + box[2])), 1)
            self.assertLessEqual(abs((y0 + y1) - (box[1] + box[3])), 1)
            self.assertGreaterEqual(x0, box[0] + 3)
            self.assertLessEqual(y1, box[3] - 3)
        with self.assertRaises(ValueError):
            ui.aspect_crop((0, 0, 7, 7))

    def test_pack_index_keeps_originals_alternates_aliases_and_hd_only_entries(self):
        self.make_sheets()
        image, columns, rows = synthetic_grid()
        image.resize((1280, 840), Image.Resampling.NEAREST).save(self.work / "jobs/sheet001/output.png")
        (self.output / "hd").mkdir(parents=True)
        Image.new("RGB", (10, 8), "red").save(self.output / "hd/standalone.webp")
        manifest = ui.pack(self.source, self.work, self.output)
        self.assertEqual(manifest, json.loads((self.output / "index.json").read_text()))
        self.assertEqual(manifest, {"version": 1, "images": {
            "alternate": {"orig": "orig/alternate.png"}, "icon": {"orig": "orig/icon.png", "hd": "hd/icon.webp"},
            "standalone": {"hd": "hd/standalone.webp"}}, "byId": {"UNIT": "icon", "ALIAS": "icon"}})
        self.assertEqual(ui.load_image(self.output / "hd/icon.webp").size, (480, 384))
        self.assertEqual((self.output / "orig/icon.png").read_bytes(), (self.source / "orig/icon.png").read_bytes())
        report = json.loads((self.work / "pack_report.json").read_text())
        self.assertEqual(report[0]["mode"], "gutter")
        self.assertEqual(report[0]["crop"], list(ui.aspect_crop((columns[0][0] * 2, rows[0][0] * 2, columns[0][1] * 2, rows[0][1] * 2))))

    def test_pack_layout_fallback_scales_coordinates_and_reports_missing_jobs(self):
        self.make_sheets()
        Image.new("RGB", (768, 512), (180, 140, 100)).save(self.work / "jobs/sheet001/output.png")
        ui.pack(self.source, self.work, self.output)
        report = json.loads((self.work / "pack_report.json").read_text())
        x, y, width, height = ui.cell_rect(0)
        self.assertEqual(report[0]["crop"], list(ui.aspect_crop((x // 2, y // 2, (x + width) // 2, (y + height) // 2))))
        self.assertEqual(report[0]["mode"], "layout")
        (self.work / "jobs/sheet001/output.png").unlink()
        ui.pack(self.source, self.work, self.output)
        self.assertEqual(json.loads((self.work / "pack_report.json").read_text()), [{"job": "sheet001", "mode": "missing"}])

    def test_csf_first_string_wide_extra_empty_and_truncation(self):
        data = bytearray(b" FSC" + struct.pack("<5I", 3, 2, 2, 0, 0))
        name = b"NAME:UNIT"
        data += b" LBL" + struct.pack("<2I", 2, len(name)) + name
        for tag, text in ((b"WRTS", "测试单位"), (b" RTS", "second ignored")):
            raw = text.encode("utf-16-le")
            data += tag + struct.pack("<I", len(raw) // 2) + bytes(x ^ 255 for x in raw)
            if tag == b"WRTS":
                data += struct.pack("<I", 5) + b"extra"
        data += b" LBL" + struct.pack("<2I", 0, 5) + b"EMPTY"
        path = self.root / "strings.csf"
        path.write_bytes(data)
        self.assertEqual(ui.read_csf(path), {"name:unit": "测试单位", "empty": ""})
        path.write_bytes(data[:-1])
        with self.assertRaisesRegex(ValueError, "Truncated"):
            ui.read_csf(path)
        path.write_bytes(b"oops" + data[4:])
        with self.assertRaisesRegex(ValueError, "signature"):
            ui.read_csf(path)

    def test_compare_writes_original_hd_pairs_with_caller_chinese_label(self):
        self.make_sheets()
        shutil.copyfile(self.work / "jobs/sheet001/input.png", self.work / "jobs/sheet001/output.png")
        ui.pack(self.source, self.work, self.output)
        ui.write_json(self.root / "labels.json", {"UNIT": "合成单位"})
        default_font = ImageFont.load_default()
        with mock.patch.object(ui.ImageFont, "truetype", return_value=default_font), mock.patch.object(ui, "caption", wraps=ui.caption) as caption:
            paths = ui.compare(self.source, self.work, self.output, Path("font.ttf"), labels_file=self.root / "labels.json")
        self.assertEqual(len(paths), 1)
        self.assertEqual(caption.call_args_list[0].args[1], "合成单位")
        self.assertEqual(ui.load_image(paths[0]).size, (2014, 350))
        self.assertTrue(paths[0].with_stem(paths[0].stem + "_s").exists())


class RunnerTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix=".tmp-ui-run-", dir=Path(__file__).parent)
        self.addCleanup(self.temporary.cleanup)
        self.work = Path(self.temporary.name)
        for index in range(4):
            directory = self.work / "jobs" / f"job{index}"
            directory.mkdir(parents=True)
            (directory / "prompt.txt").write_text('A multiline prompt\nwith "quotes" and $literal', encoding="utf-8")
            Image.new("RGB", (10, 8), "red").save(directory / "input.png")

    def factory(self, log_message=b"", code=0):
        state = {"active": 0, "maximum": 0, "commands": []}

        def launch(command, **kwargs):
            state["active"] += 1
            state["maximum"] = max(state["maximum"], state["active"])
            state["commands"].append(command)
            kwargs["stdout"].write(log_message)
            kwargs["stdout"].flush()

            class FakeProcess:
                ticks = 0

                def poll(self):
                    self.ticks += 1
                    if self.ticks == 1:
                        return None
                    if self.ticks == 2:
                        state["active"] -= 1
                        if code == 0:
                            shutil.copyfile(kwargs["cwd"] / "input.png", kwargs["cwd"] / "output.png")
                    return code

            return FakeProcess()

        return state, launch

    def test_bounded_concurrency_exact_command_and_successful_resume(self):
        state, launch = self.factory()
        with mock.patch.object(ui.subprocess, "Popen", side_effect=launch), mock.patch.object(ui.time, "sleep"):
            self.assertEqual(ui.run_jobs(self.work, concurrency=2), 0)
        self.assertEqual(state["maximum"], 2)
        self.assertEqual(len(state["commands"]), 4)
        directory = (self.work / "jobs/job0").resolve()
        self.assertEqual(state["commands"][0], ["codex", "exec", "-s", "workspace-write", "-m", "gpt-6.1-sol", "-c",
                                               'model_reasoning_effort="xhigh"', "--skip-git-repo-check", "-C", str(directory),
                                               "-o", str(directory / "last.txt"), (directory / "prompt.txt").read_text()])
        with mock.patch.object(ui.subprocess, "Popen") as popen:
            self.assertEqual(ui.run_jobs(self.work), 0)
            popen.assert_not_called()

    def test_live_limit_stops_queue_drains_call_and_persists_limit(self):
        for message in (b"Usage limit exceeded", b"rate_limit_exceeded", b"HTTP 429", b"quota exhausted"):
            with self.subTest(message=message):
                (self.work / "LIMIT").unlink(missing_ok=True)
                state, launch = self.factory(message, 1)
                with mock.patch.object(ui.subprocess, "Popen", side_effect=launch), mock.patch.object(ui.time, "sleep"):
                    self.assertEqual(ui.run_jobs(self.work, concurrency=1), 2)
                self.assertEqual(len(state["commands"]), 1)
                self.assertEqual(state["active"], 0)
                self.assertTrue((self.work / "LIMIT").exists())
                self.assertFalse((self.work / "jobs/job1/start").exists())
                self.assertEqual((self.work / "jobs/job0/exit").read_text().strip(), "1")
                with mock.patch.object(ui.subprocess, "Popen") as popen:
                    self.assertEqual(ui.run_jobs(self.work), 2)
                    popen.assert_not_called()

    def test_failure_stops_queue_and_relative_binary_is_resolved(self):
        state, launch = self.factory(code=1)
        with mock.patch.object(ui.subprocess, "Popen", side_effect=launch), mock.patch.object(ui.time, "sleep"):
            self.assertEqual(ui.run_jobs(self.work, codex="./bin/codex", concurrency=1), 1)
        self.assertEqual(state["commands"][0][0], str(Path("bin/codex").resolve()))
        self.assertEqual(len(state["commands"]), 1)
        self.assertFalse((self.work / "LIMIT").exists())


if __name__ == "__main__":
    unittest.main()
