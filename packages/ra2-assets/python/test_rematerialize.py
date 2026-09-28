"""Asset-free tests: python -B -m unittest discover -s packages/ra2-assets/python."""

from __future__ import annotations

import builtins
import contextlib
import copy
import io
import json
import os
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest import mock
import warnings

import numpy as np
from PIL import Image

import rematerialize as remat


def synthetic_rgba(width: int, height: int) -> np.ndarray:
    """Keep distinct hidden RGB and partial alpha to expose destructive conversion."""
    y, x = np.indices((height, width))
    return np.stack(
        ((x * 17 + y * 3) % 256, (x * 7 + y * 29) % 256,
         (x * 41 + y * 11) % 256, np.where((x + y) % 5 == 0, 0, 127 + x % 129)),
        axis=-1,
    ).astype(np.uint8)


class TileTests(unittest.TestCase):
    def test_layout_covers_small_regular_uneven_and_high_overlap_images(self):
        for width, height, size, overlap in (
            (1, 1, 16, 5), (9, 7, 16, 5), (32, 24, 16, 0),
            (39, 31, 16, 5), (17, 19, 16, 15), (41, 22, 16, 12),
        ):
            with self.subTest(width=width, height=height, overlap=overlap):
                tiles = remat.tile_layout(width, height, size, overlap)
                count = np.zeros((height, width), dtype=np.int32)
                positions = set()
                for index, tile in enumerate(tiles):
                    self.assertEqual(tile.index, index)
                    self.assertGreater(tile.width, 0)
                    self.assertGreater(tile.height, 0)
                    self.assertLessEqual(tile.width, size)
                    self.assertLessEqual(tile.height, size)
                    self.assertGreaterEqual(tile.x, 0)
                    self.assertGreaterEqual(tile.y, 0)
                    self.assertLessEqual(tile.x + tile.width, width)
                    self.assertLessEqual(tile.y + tile.height, height)
                    self.assertNotIn((tile.x, tile.y), positions)
                    positions.add((tile.x, tile.y))
                    count[tile.y:tile.y + tile.height, tile.x:tile.x + tile.width] += 1
                self.assertTrue(np.all(count > 0))
                self.assertEqual(max(t.x + t.width for t in tiles), width)
                self.assertEqual(max(t.y + t.height for t in tiles), height)

    def test_weights_normalize_and_reconstruct_input_at_uneven_seams(self):
        width, height = 43, 31
        source = synthetic_rgba(width, height)[..., :3].astype(np.float32)
        for overlap in (0, 5, 12, 15):
            with self.subTest(overlap=overlap):
                tiles = remat.tile_layout(width, height, 16, overlap)
                total = np.zeros((height, width), dtype=np.float32)
                accum = np.zeros_like(source)
                weights = []
                for tile in tiles:
                    weight = remat.tile_weights(tile)
                    self.assertEqual(weight.dtype, np.float32)
                    self.assertEqual(weight.shape, (tile.height, tile.width))
                    self.assertTrue(np.all(np.isfinite(weight)))
                    self.assertTrue(np.all(weight >= 0))
                    self.assertTrue(np.all(weight <= 1))
                    ys = slice(tile.y, tile.y + tile.height)
                    xs = slice(tile.x, tile.x + tile.width)
                    total[ys, xs] += weight
                    accum[ys, xs] += source[ys, xs] * weight[..., None]
                    weights.append((ys, xs, weight))
                self.assertTrue(np.all(total > 0))
                partition = np.zeros_like(total)
                for ys, xs, weight in weights:
                    partition[ys, xs] += weight / total[ys, xs]
                np.testing.assert_allclose(partition, 1, atol=1e-6)
                restored = np.rint(accum / total[..., None]).astype(np.uint8)
                np.testing.assert_array_equal(restored, source.astype(np.uint8))

    def test_single_tile_has_no_dark_outer_border(self):
        tile, = remat.tile_layout(9, 7, 16, 5)
        np.testing.assert_array_equal(remat.tile_weights(tile), np.ones((7, 9)))


class ColorAndWaterTests(unittest.TestCase):
    def test_gaussian_matches_sampled_kernel_and_edge_padding(self):
        source = np.zeros((3, 7, 3), dtype=np.float32)
        source[:, 0, :] = (90, 180, 240)
        sigma = 1.0
        offsets = np.arange(-3, 4)
        kernel = np.exp(-(offsets * offsets) / (2 * sigma * sigma))
        kernel /= kernel.sum()
        padded = np.pad(source, ((0, 0), (3, 3), (0, 0)), mode="edge")
        expected = sum(kernel[k] * padded[:, k:k + 7] for k in range(7))
        result = remat.gaussian_blur(source, sigma)
        self.assertEqual(result.dtype, np.float32)
        np.testing.assert_allclose(result, expected, atol=3e-5)

    def test_gaussian_preserves_constant_and_handles_one_pixel(self):
        for shape in ((1, 1, 3), (5, 9, 3)):
            for sigma in (0, 1e-100, 6):
                with self.subTest(shape=shape, sigma=sigma):
                    source = np.full(shape, 93.5, dtype=np.float32)
                    np.testing.assert_allclose(remat.gaussian_blur(source, sigma), source, atol=3e-5)

    def test_color_restore_matches_formula_and_clamps(self):
        original = synthetic_rgba(9, 7)[..., :3].astype(np.float32)
        generated = np.full_like(original, 190)
        generated[::2, ::2] = 0
        expected = np.clip(
            generated - remat.gaussian_blur(generated, 1.25)
            + remat.gaussian_blur(original, 1.25), 0, 255,
        )
        actual = remat.restore_colors(generated, original, 1.25)
        self.assertEqual(actual.dtype, np.float32)
        np.testing.assert_allclose(actual, expected, atol=3e-5)
        self.assertTrue(np.all((actual >= 0) & (actual <= 255)))

    def test_color_restore_removes_constant_color_cast_and_keeps_detail(self):
        original = np.full((17, 19, 3), (80, 100, 120), dtype=np.float32)
        constant_cast = original + (15, 20, 25)
        np.testing.assert_allclose(
            remat.restore_colors(constant_cast, original, 2), original, atol=1e-4,
        )
        generated = constant_cast.copy()
        generated[8, 9] += 30
        result = remat.restore_colors(generated, original, 2)
        self.assertTrue(np.all(result[8, 9] > original[8, 9] + 20))

    def test_water_threshold_is_strict_and_water_pixels_are_exact(self):
        original = np.full((1, 4, 3), 20, dtype=np.float32)
        generated = np.full_like(original, 200)
        mask = np.array([[0.0, 0.5, 0.5001, 1.0]], dtype=np.float32)
        result = remat.preserve_water(generated, original, mask, feather=0)
        np.testing.assert_array_equal(result[:, :2], generated[:, :2])
        np.testing.assert_array_equal(result[:, 2:], original[:, 2:])

    def test_water_feather_only_softens_the_land_side(self):
        original = np.full((7, 25, 3), 20, dtype=np.float32)
        generated = np.full_like(original, 200)
        mask = np.zeros((7, 25), dtype=np.float32)
        mask[:, 12:] = 1
        result = remat.preserve_water(generated, original, mask, feather=2)
        np.testing.assert_array_equal(result[:, 12:], original[:, 12:])
        np.testing.assert_allclose(result[:, 0], generated[:, 0], atol=1e-4)
        self.assertTrue(np.all(result[:, 11] > original[:, 11]))
        self.assertTrue(np.all(result[:, 11] < generated[:, 11]))
        self.assertTrue(np.all((result >= 20) & (result <= 200)))

    def test_empty_and_full_water_masks(self):
        original = synthetic_rgba(11, 9)[..., :3].astype(np.float32)
        generated = 255 - original
        for filled, expected in ((0, generated), (1, original)):
            with self.subTest(filled=filled):
                mask = np.full((9, 11), filled, dtype=np.float32)
                np.testing.assert_array_equal(remat.preserve_water(generated, original, mask), expected)


class CacheTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="remat-synthetic-")
        self.addCleanup(self.temp.cleanup)
        self.cache = Path(self.temp.name).resolve() / "cache"
        self.map_dir = self.cache / "Synthetic"
        self.map_dir.mkdir(parents=True)
        self.source = synthetic_rgba(37, 29)
        self.source_path = self.map_dir / "terrain-map@2x.png"
        Image.fromarray(self.source).save(self.source_path)
        self.mask = np.zeros((29, 37), dtype=np.uint8)
        self.mask[:, 20:] = 255
        Image.fromarray(self.mask).save(self.map_dir / "water.png")
        self.manifest = {
            "version": 1, "name": "Synthetic", "theater": "temperate",
            "terrainMap": {
                "file": self.source_path.name, "waterMask": "water.png", "scale": 2,
                "originX": -123, "originY": 67, "width": 37, "height": 29,
                "futureMetadata": {"preserve": True},
            },
            "objects": [{"type": "TEST", "x": 3}], "unrelated": [1, "keep", None],
        }
        self.manifest_path = self.map_dir / "manifest.json"
        self.write_manifest()

    def write_manifest(self):
        self.manifest_path.write_text(json.dumps(self.manifest, indent=2) + "\n", encoding="utf-8")

    def invoke(self, *extra, dry_run=True):
        argv = [
            "--map", "Synthetic", "--cache", str(self.cache), "--models",
            str(Path(self.temp.name) / "no-models-needed"),
            "--tile", "16", "--overlap", "5", *extra,
        ]
        if dry_run:
            argv.append("--dry-run")
        stdout = io.StringIO()
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(io.StringIO()):
            args = remat.build_parser().parse_args(argv)
            output = remat.run(args)
        return output, stdout.getvalue()

    def read_rgba(self, path):
        with Image.open(path) as image:
            self.assertEqual(image.mode, "RGBA")
            return np.asarray(image).copy()

    def test_dry_run_is_byte_exact_and_only_updates_manifest_file(self):
        source_bytes = self.source_path.read_bytes()
        output, progress = self.invoke()
        self.assertEqual(output, self.map_dir / "terrain-map@2x-remat.png")
        np.testing.assert_array_equal(self.read_rgba(output), self.source)
        self.assertEqual(self.source_path.read_bytes(), source_bytes)
        expected = copy.deepcopy(self.manifest)
        expected["terrainMap"]["file"] = output.name
        self.assertEqual(json.loads(self.manifest_path.read_text()), expected)
        self.assertIn("ETA", progress)

    def test_explicit_input_uses_that_image_and_retains_previous_outputs(self):
        alternative = self.source.copy()
        alternative[..., 0] ^= 85
        Image.fromarray(alternative).save(self.map_dir / "trial.png")
        first, _ = self.invoke("--input", "trial.png")
        first_bytes = first.read_bytes()
        second, _ = self.invoke("--input", "trial.png")
        self.assertEqual(first.name, "trial-remat.png")
        self.assertNotEqual(second, first)
        self.assertEqual(first.read_bytes(), first_bytes)
        np.testing.assert_array_equal(self.read_rgba(second), alternative)

    def test_region_writes_side_by_side_and_leaves_manifest_and_source_untouched(self):
        before_manifest = self.manifest_path.read_bytes()
        before_source = self.source_path.read_bytes()
        output, _ = self.invoke("--region", "4,3,17,13")
        self.assertEqual(output, self.map_dir / "remat-compare.png")
        result = self.read_rgba(output)
        self.assertEqual(result.shape, (13, 34, 4))
        expected = self.source[3:16, 4:21]
        np.testing.assert_array_equal(result[:, :17], expected)
        np.testing.assert_array_equal(result[:, 17:], expected)
        self.assertEqual(self.manifest_path.read_bytes(), before_manifest)
        self.assertEqual(self.source_path.read_bytes(), before_source)
        self.assertFalse((self.map_dir / "terrain-map@2x-remat.png").exists())

    def test_all_transparent_input_retains_hidden_rgb(self):
        self.source[..., 3] = 0
        Image.fromarray(self.source).save(self.source_path)
        output, progress = self.invoke("--resume")
        np.testing.assert_array_equal(self.read_rgba(output), self.source)
        self.assertEqual(list((self.map_dir / ".remat-tiles").rglob("*.png")), [])
        self.assertIn("skip", progress.lower())

    def test_dry_run_never_loads_diffusion_dependencies(self):
        original_import = builtins.__import__

        def offline_import(name, *args, **kwargs):
            if name.split(".", 1)[0] in {"torch", "diffusers", "transformers"}:
                self.fail(f"Dry-run imported diffusion dependency: {name}")
            return original_import(name, *args, **kwargs)

        with mock.patch("builtins.__import__", side_effect=offline_import):
            output, _ = self.invoke()
        np.testing.assert_array_equal(self.read_rgba(output), self.source)

    def test_resume_reuses_tiles_and_invalidates_changed_inputs_and_seed(self):
        first, _ = self.invoke("--input", self.source_path.name, "--resume")
        tile_root = self.map_dir / ".remat-tiles"
        first_tiles = sorted(tile_root.rglob("*.png"))
        self.assertGreater(len(first_tiles), 1)
        old_tiles = {path: (path.stat().st_mtime_ns, path.read_bytes()) for path in first_tiles}
        second, progress = self.invoke("--input", self.source_path.name, "--resume")
        np.testing.assert_array_equal(self.read_rgba(first), self.read_rgba(second))
        self.assertEqual(sorted(tile_root.rglob("*.png")), first_tiles)
        for path, (mtime, contents) in old_tiles.items():
            self.assertEqual(path.stat().st_mtime_ns, mtime)
            self.assertEqual(path.read_bytes(), contents)
        self.assertTrue("cached" in progress.lower() or "resume" in progress.lower())
        self.invoke("--input", self.source_path.name, "--resume", "--seed", "8")
        self.assertEqual(len(list(tile_root.rglob("*.png"))), len(first_tiles) * 2)
        self.source[0, 0, :3] ^= 15
        Image.fromarray(self.source).save(self.source_path)
        third, _ = self.invoke("--input", self.source_path.name, "--resume")
        self.assertEqual(len(list(tile_root.rglob("*.png"))), len(first_tiles) * 3)
        np.testing.assert_array_equal(self.read_rgba(third), self.source)

    def test_resume_invalidates_same_bytes_reshaped_into_a_different_image(self):
        self.source = synthetic_rgba(24, 16)
        self.source[..., 3] = 255
        source_bytes = self.source.tobytes()
        for index, (height, width) in enumerate(((16, 24), (24, 16))):
            self.source = np.frombuffer(source_bytes, dtype=np.uint8).reshape(height, width, 4)
            Image.fromarray(self.source).save(self.source_path)
            Image.fromarray(np.zeros((height, width), dtype=np.uint8)).save(self.map_dir / "water.png")
            self.manifest["terrainMap"].update(width=width, height=height)
            self.write_manifest()
            output, _ = self.invoke(
                "--input", self.source_path.name, "--resume", "--tile", "8", "--overlap", "0",
            )
            cached = list((self.map_dir / ".remat-tiles").rglob("*.png"))
            self.assertEqual(len(cached), 6 * (index + 1))
            np.testing.assert_array_equal(self.read_rgba(output), self.source)

    def test_interrupted_inference_resumes_only_remaining_seeds_and_preserves_water_alpha(self):
        before_manifest = self.manifest_path.read_bytes()
        visited = []

        def interrupted(source, seed):
            visited.append(seed)
            if len(visited) == 3:
                raise RuntimeError("synthetic interruption")
            return 255 - source[..., :3]

        extra = ("--input", self.source_path.name, "--resume")
        with mock.patch.object(remat, "DiffusionRunner", return_value=interrupted):
            with self.assertRaisesRegex(RuntimeError, "synthetic interruption"):
                self.invoke(*extra, dry_run=False)
        self.assertEqual(visited, [7, 8, 9])
        self.assertEqual(self.manifest_path.read_bytes(), before_manifest)
        self.assertEqual(len(list((self.map_dir / ".remat-tiles").rglob("*.png"))), 2)
        resumed = []

        def remaining(source, seed):
            resumed.append(seed)
            return 255 - source[..., :3]

        with mock.patch.object(remat, "DiffusionRunner", return_value=remaining):
            output, _ = self.invoke(*extra, dry_run=False)
        count = len(remat.tile_layout(37, 29, 16, 5))
        self.assertEqual(resumed, list(range(9, 7 + count)))
        self.assertEqual(len(list((self.map_dir / ".remat-tiles").rglob("*.png"))), count)
        result = self.read_rgba(output)
        np.testing.assert_array_equal(result[..., 3], self.source[..., 3])
        np.testing.assert_array_equal(result[self.source[..., 3] == 0], self.source[self.source[..., 3] == 0])
        np.testing.assert_array_equal(result[self.mask > 127], self.source[self.mask > 127])
        land = (self.mask == 0) & (self.source[..., 3] > 0)
        self.assertTrue(np.any(result[land, :3] != self.source[land, :3]))

    def test_mismatched_water_mask_fails_before_output_or_manifest_change(self):
        Image.fromarray(np.zeros((5, 7), dtype=np.uint8)).save(self.map_dir / "water.png")
        before = self.manifest_path.read_bytes()
        with self.assertRaises((ValueError, SystemExit)):
            self.invoke()
        self.assertEqual(self.manifest_path.read_bytes(), before)
        self.assertFalse((self.map_dir / "terrain-map@2x-remat.png").exists())

    def test_mismatched_manifest_size_fails_before_output(self):
        self.manifest["terrainMap"]["width"] = 38
        self.write_manifest()
        with self.assertRaises((ValueError, SystemExit)):
            self.invoke()
        self.assertFalse((self.map_dir / "terrain-map@2x-remat.png").exists())

    def test_invalid_parameters_fail_without_modifying_manifest(self):
        before = self.manifest_path.read_bytes()
        for extra in (
            ("--tile", "0"), ("--overlap", "-1"), ("--overlap", "16"),
            ("--strength", "-0.1"), ("--strength", "1.1"), ("--steps", "0"),
            ("--guidance", "nan"), ("--control", "-1"), ("--color-sigma", "-1"),
            ("--region", "0,0,0,3"), ("--region", "-1,0,3,3"),
            ("--region", "36,0,3,3"),
        ):
            with self.subTest(extra=extra), self.assertRaises((ValueError, SystemExit)):
                self.invoke(*extra)
        self.assertEqual(self.manifest_path.read_bytes(), before)
        self.assertFalse((self.map_dir / "terrain-map@2x-remat.png").exists())


class PathTests(unittest.TestCase):
    def test_defaults_refer_to_main_checkout(self):
        cache, models = remat.resolve_paths(None, None)
        self.assertEqual(cache, remat.MAIN_REPO / "gameres/hd-cache")
        self.assertEqual(models, remat.MAIN_REPO / "gameres/tools/diffusion/models")
        self.assertNotIn(".worktrees", str(cache))
        self.assertNotIn(".worktrees", str(models))

    def test_explicit_resource_paths_infer_the_other_path(self):
        root = Path(tempfile.gettempdir()).resolve() / "synthetic-checkout"
        cache = root / "gameres/hd-cache"
        models = root / "gameres/tools/diffusion/models"
        self.assertEqual(remat.resolve_paths(cache, None), (cache, models))
        self.assertEqual(remat.resolve_paths(None, models), (cache, models))

    def test_arbitrary_cache_preserves_explicit_models_or_main_default(self):
        root = Path(tempfile.gettempdir()).resolve()
        cache, models = root / "scratch-cache", root / "local-models"
        self.assertEqual(remat.resolve_paths(cache, models), (cache, models))
        self.assertEqual(
            remat.resolve_paths(cache, None),
            (cache, remat.MAIN_REPO / "gameres/tools/diffusion/models"),
        )


class DiffusionContractTests(unittest.TestCase):
    def test_local_fp16_loading_padding_control_and_cpu_generator(self):
        """Exercise the adapter with in-memory stand-ins, without importing torch."""
        for mps in (True, False):
            with self.subTest(mps=mps):
                generator = mock.Mock()
                generator.manual_seed.return_value = generator
                torch = SimpleNamespace(
                    backends=SimpleNamespace(mps=SimpleNamespace(is_available=lambda: mps)),
                    float16="synthetic-float16", float32="synthetic-float32",
                    Generator=mock.Mock(return_value=generator),
                    inference_mode=mock.Mock(side_effect=contextlib.nullcontext),
                )
                pipe = mock.Mock(side_effect=lambda **kw: SimpleNamespace(images=[kw["image"]]))
                pipe.to.return_value = pipe
                vae, control = object(), object()
                diffusers = SimpleNamespace(
                    AutoencoderKL=SimpleNamespace(from_pretrained=mock.Mock(return_value=vae)),
                    ControlNetModel=SimpleNamespace(from_pretrained=mock.Mock(return_value=control)),
                    StableDiffusionXLControlNetImg2ImgPipeline=SimpleNamespace(
                        from_pretrained=mock.Mock(return_value=pipe),
                    ),
                )
                args = remat.build_parser().parse_args([
                    "--map", "Synthetic", "--prompt", "synthetic ground",
                    "--strength", "0.35", "--steps", "20", "--guidance", "4.2", "--control", "0.75",
                ])
                models = Path("/synthetic-models")

                def local_weights(path, pattern):
                    # Model preflight sees local filenames, never real weights.
                    if pattern == "*.fp16.safetensors" and path.name == "controlnet-tile-sdxl":
                        return iter(())
                    return iter((path / "diffusion_pytorch_model.fp16.safetensors",))

                source = synthetic_rgba(19, 13)
                source[..., 3] = 255
                with (
                    mock.patch.dict(sys.modules, {"torch": torch, "diffusers": diffusers}),
                    mock.patch.object(Path, "is_dir", return_value=True),
                    mock.patch.object(Path, "glob", autospec=True, side_effect=local_weights),
                    mock.patch.dict(os.environ),
                    mock.patch.object(sys, "dont_write_bytecode", sys.dont_write_bytecode),
                    warnings.catch_warnings(record=True) as recorded,
                    contextlib.redirect_stdout(io.StringIO()),
                ):
                    warnings.simplefilter("always")
                    runner = remat.DiffusionRunner(models, args)
                    result = runner(source, 123)
                    self.assertEqual(os.environ["HF_HUB_OFFLINE"], "1")
                    self.assertEqual(os.environ["TRANSFORMERS_OFFLINE"], "1")
                np.testing.assert_array_equal(result, source[..., :3])
                dtype = torch.float16 if mps else torch.float32
                for loader in (
                    diffusers.AutoencoderKL.from_pretrained,
                    diffusers.ControlNetModel.from_pretrained,
                    diffusers.StableDiffusionXLControlNetImg2ImgPipeline.from_pretrained,
                ):
                    self.assertEqual(loader.call_args.kwargs["torch_dtype"], dtype)
                    self.assertTrue(loader.call_args.kwargs["local_files_only"])
                    self.assertTrue(loader.call_args.kwargs["use_safetensors"])
                base = diffusers.StableDiffusionXLControlNetImg2ImgPipeline.from_pretrained.call_args
                self.assertEqual(base.args, (models / "sdxl-base",))
                self.assertEqual(base.kwargs["variant"], "fp16")
                self.assertIs(base.kwargs["vae"], vae)
                self.assertIs(base.kwargs["controlnet"], control)
                self.assertFalse(base.kwargs["add_watermarker"])
                self.assertFalse(diffusers.AutoencoderKL.from_pretrained.call_args.kwargs["force_upcast"])
                self.assertEqual(diffusers.AutoencoderKL.from_pretrained.call_args.kwargs["variant"], "fp16")
                self.assertNotIn("variant", diffusers.ControlNetModel.from_pretrained.call_args.kwargs)
                pipe.to.assert_called_once_with("mps" if mps else "cpu")
                pipe.enable_attention_slicing.assert_called_once_with()
                pipe.enable_vae_tiling.assert_called_once_with()
                pipe.enable_vae_slicing.assert_called_once_with()
                torch.Generator.assert_called_once_with(device="cpu")
                generator.manual_seed.assert_called_once_with(123)
                call = pipe.call_args.kwargs
                self.assertIs(call["image"], call["control_image"])
                self.assertIs(call["generator"], generator)
                self.assertEqual(call["prompt"], "synthetic ground")
                self.assertEqual(call["negative_prompt"], remat.NEGATIVE_PROMPT)
                self.assertEqual(call["strength"], 0.35)
                self.assertEqual(call["num_inference_steps"], 20)
                self.assertEqual(call["guidance_scale"], 4.2)
                self.assertEqual(call["controlnet_conditioning_scale"], 0.75)
                self.assertGreaterEqual(call["width"], 19)
                self.assertGreaterEqual(call["height"], 13)
                self.assertEqual(call["width"] % 8, 0)
                self.assertEqual(call["height"] % 8, 0)
                padded = np.asarray(call["image"])
                np.testing.assert_array_equal(padded[:13, :19], source[..., :3])
                np.testing.assert_array_equal(padded[-1, -1], source[-1, -1, :3])
                if mps:
                    self.assertEqual(recorded, [])
                else:
                    self.assertTrue(any("CPU float32" in str(w.message) for w in recorded))


if __name__ == "__main__":
    unittest.main()
