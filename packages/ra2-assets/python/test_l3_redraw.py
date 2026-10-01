"""Synthetic-only L3 contracts; no models, game files, browsers or GPU dependencies."""
from __future__ import annotations

import json
import os
from pathlib import Path
import shutil
import threading

import numpy as np
from PIL import Image
import pytest

import hybrid_redraw as hr
import l3_redraw as l3
import redetail_sprites as rd


def write_png(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray(np.asarray(data, np.uint8)).save(path)


def read_png(path):
    with Image.open(path) as im:
        return np.asarray(im).copy()


@pytest.fixture
def library(tmp_path):
    root = tmp_path / "original"
    directory = root / "_library" / "temperate"
    directory.mkdir(parents=True)
    (directory.parent / "common").mkdir()
    (directory.parent / "common" / "effect.json").write_text("{}")
    (root / "OTHER_MAP").mkdir()
    (root / "OTHER_MAP" / "manifest.json").write_text("{}")
    pal = np.stack([np.arange(256), np.arange(256) * .8, np.arange(256) * .6], -1).astype(np.uint8)
    ramp = np.array([[230 - i * 12, 180 - i * 9, 100 - i * 5] for i in range(16)], np.uint8)
    write_png(directory / "palette.png", pal[None])
    body = np.full((40, 48), 180, np.uint8)
    body[::7, :] = 80
    body[:, ::9] = 60
    body[:2, :] = body[-2:, :] = body[:, :2] = body[:, -2:] = 0
    body[5:10, 8:13] = 20
    overlay = np.full((12, 16), 230, np.uint8)
    overlay[0] = overlay[-1] = overlay[:, 0] = overlay[:, -1] = 0
    damaged = body[:35, :30].copy()
    damaged[:8, :14] = 0
    index = [np.zeros((80, 96), np.uint8) for _ in range(2)]
    index[0][3:43, 2:50] = body
    index[1][3:15, 3:19] = overlay
    index[1][5:40, 52:82] = damaged
    index[1][18:58, 2:50] = body
    sprites = {
        "building:TEST": {"palette": "unit", "remap": True, "frames": [
            {"page": 0, "rect": [2, 3, 48, 40], "offset": [-20, -34]},
            {"page": 1, "rect": [52, 5, 30, 35], "offset": [-12, -28]}]},
        "anim:OVER": {"palette": "unit", "remap": False, "frames": [
            {"page": 1, "rect": [3, 3, 16, 12], "offset": [-12, -21]}]},
        "anim:GLOW": {"palette": "unit", "remap": True, "frames": [
            {"page": 1, "rect": [2, 18, 48, 40], "offset": [-20, -34]}]},
    }
    for i, idx in enumerate(index):
        a2 = (idx > 0).repeat(2, 0).repeat(2, 1).astype(np.uint8) * 255
        p2 = ((idx >= 16) & (idx <= 31)).repeat(2, 0).repeat(2, 1).astype(np.uint8) * 255
        rgb = pal[idx].repeat(2, 0).repeat(2, 1)
        grey = np.clip(255 - 15 * (idx.astype(int) - 16), 0, 255).repeat(2, 0).repeat(2, 1)
        rgb[p2 > 0] = grey[p2 > 0, None]
        write_png(directory / f"index{i}.png", idx)
        write_png(directory / f"hd{i}.png", np.dstack((rgb, a2)))
        write_png(directory / f"paint{i}.png", p2)
    manifest = {"theater": "temperate", "sprites": sprites, "palettes": {"unit": "palette.png"},
                "spriteAtlases": [{"file": f"index{i}.png", "width": 96, "height": 80} for i in range(2)],
                "spriteAtlasesHd": [{"file": f"hd{i}.png", "remap": f"paint{i}.png", "scale": 2} for i in range(2)],
                "colorSchemes": [{"remap": ramp.tolist()}, {"remap": ramp[:, ::-1].tolist()}],
                "colorSchemesByName": {"Gold": 0, "Blue": 1}, "types": {}}
    (directory / "library.json").write_text(json.dumps(manifest))
    return l3.Source.library(directory)


def job(ident="TEST", context=False):
    return {"id": ident, "source": "library", "house": "Gold", "panels": [
        {"label": "intact", "parts": [{"sprite": "building:TEST", "frame": 0},
                                        {"sprite": "anim:OVER", "frame": 0, "paste": not context}]},
        {"label": "damaged", "parts": [{"sprite": "building:TEST", "frame": 1}]}]}


@pytest.fixture
def sequence_library(library):
    """Three cropped make frames: a fixed painted core and growing details, with different anchor offsets."""
    yy, xx = np.mgrid[:48, :64]
    core = np.zeros((48, 64), np.uint8)
    core[12:35, 16:45] = (100 + (xx[12:35, 16:45] * 9 + yy[12:35, 16:45] * 7) % 100)
    core[22:28, 26:36] = 20
    pal = read_png(library.dir / "palette.png")[0]
    manifest = library.manifest
    frames = []
    for k, (left, top, w, h) in enumerate(((8, 9, 40, 32), (4, 3, 52, 42), (0, 0, 64, 48))):
        image = core.copy()
        if k >= 1:
            image[37:40, 10:14] = 160
        if k >= 2:
            image[5:10, 55:59] = 210
        idx = np.pad(image[top:top + h, left:left + w], 2)
        alpha = (idx > 0).repeat(2, 0).repeat(2, 1).astype(np.uint8) * 255
        paint = ((idx >= 16) & (idx <= 31)).repeat(2, 0).repeat(2, 1).astype(np.uint8) * 127
        rgb = pal[idx].repeat(2, 0).repeat(2, 1)
        rgb[paint > 0] = 195
        # Fractional alpha is identical at this anchor-relative position across all frames.
        alpha[2 * (14 - top + 2), 2 * (18 - left + 2)] = 127
        page = k + 2
        write_png(library.dir / f"index{page}.png", idx)
        write_png(library.dir / f"hd{page}.png", np.dstack((rgb, alpha)))
        write_png(library.dir / f"paint{page}.png", paint)
        manifest["spriteAtlases"].append({"file": f"index{page}.png", "width": w + 4, "height": h + 4})
        manifest["spriteAtlasesHd"].append({"file": f"hd{page}.png", "remap": f"paint{page}.png", "scale": 2})
        frames.append({"page": page, "rect": [2, 2, w, h], "offset": [left - 30, top - 40]})
    manifest["sprites"]["anim:MAKE"] = {"palette": "unit", "remap": True, "frames": frames}
    (library.dir / "library.json").write_text(json.dumps(manifest))
    return l3.Source.library(library.dir)


def sequence_job():
    return {"id": "MAKE", "source": "library", "house": "Gold",
            "layout": {"cols": 2, "align": "anchor", "sequence": True, "stabilize": True},
            "panels": [{"label": str(k), "parts": [{"sprite": "anim:MAKE", "frame": k}]} for k in range(3)]}


@pytest.mark.parametrize("cols,gap", [(2, None), (5, 7), (1, 0)])
def test_anchor_grid_geometry_and_input(sequence_library, tmp_path, cols, gap):
    spec = sequence_job()
    spec["layout"]["cols"] = cols
    if gap is not None:
        spec["layout"]["gap"] = gap
    spacing = 48 if gap is None else gap
    panels = l3.build_panels(sequence_library, spec)
    layout = l3.prepare_job(sequence_library, spec, tmp_path / "work")
    cw, ch, rows = 320, 256, (3 + cols - 1) // cols
    assert layout["grid"]["common_box"] == [-30, -40, 64, 48]
    assert layout["grid"]["cell"] == [cw, ch] and layout["grid"]["rows"] == rows
    assert layout["canvas"] == [cols * cw + (cols - 1) * spacing, rows * ch + (rows - 1) * spacing]
    assert layout["enlarge"] == 1
    canvas = read_png(tmp_path / "work/MAKE/input.png")
    outside = np.ones(canvas.shape[:2], bool)
    for k, (panel, meta) in enumerate(zip(panels, layout["panels"])):
        assert panel.origin == (-30, -40) and panel.fd.alpha1.shape == (48, 64)
        x, y, w, h = meta["box"]
        assert [x, y, w, h] == [(k % cols) * (cw + spacing), (k // cols) * (ch + spacing), cw, ch]
        np.testing.assert_array_equal(canvas[y:y + h, x:x + w], hr.to_u8(hr.model_input_4x(panel.fd, None)))
        outside[y:y + h, x:x + w] = False
        part = panel.parts[0]
        assert tuple(meta["parts"][0]["rect"]) == part.rect
        assert part.rect[:2] == (part.offset[0] + 30, part.offset[1] + 40)
        px, py, pw, ph = part.rect
        np.testing.assert_array_equal(panel.fd.art1[py:py + ph, px:px + pw][part.fd.alpha1],
                                      part.fd.art1[part.fd.alpha1])
    assert np.all(canvas[outside] == 118)
    spec["panels"] = spec["panels"][:1]
    spec["layout"]["cols"] = 1
    small = l3.make_layout(sequence_library, spec, l3.build_panels(sequence_library, spec))
    assert max(small["canvas"]) < hr.ENLARGE_BELOW and small["enlarge"] == 1


def test_grid_identity_sequence_register_encode_and_compose(sequence_library, tmp_path, monkeypatch):
    spec = sequence_job()
    # Exact colour lock makes the identity oracle independent of interpolation around newly appearing details.
    spec["lock"] = {"wL": 1, "sL": 0, "wab": 1, "sab": 0, "edge_hf": 1}
    plan, work, variant = tmp_path / "plan.json", tmp_path / "work", tmp_path / "variant"
    plan.write_text(json.dumps([spec]))
    args = ["--plan", str(plan), "--work", str(work), "--library", str(sequence_library.dir)]
    assert l3.main(["prepare", *args, "--upscaler", "lanczos"]) == 0
    attempt = work / "MAKE/attempt1"
    attempt.mkdir()
    shutil.copyfile(attempt.parent / "input.png", attempt / "raw.png")
    monkeypatch.setattr(hr, "run_codex", lambda *a: pytest.fail("identity evaluation must not call a model"))
    assert l3.main(["run", *args, "--no-model"]) == 0
    metrics = json.loads((attempt / "metrics.json").read_text())
    for pair in metrics["temporal"]["pairs"]:
        assert pair["static_flicker_dE"]["mean"] == pair["static_flicker_dE"]["p95"] == 0
        assert pair["all_dE"]["mean"] == 0
        assert 0 < pair["static_flicker_dE"]["fraction"] <= 1
    panels = l3.build_panels(sequence_library, spec)
    inp = hr.load_rgb(attempt / "raw.png")
    for panel, meta in zip(panels, metrics["layout"]["panels"]):
        raw2, _, _, diag = l3.register_panel(panel, meta, metrics["layout"], inp, inp, inp)
        assert raw2.shape == (96, 128, 3)
        assert max(abs(v) for v in diag["residual_shift_2x"]) < .5
        sx, tx, sy, ty = diag["params_canvas"]
        x, y, w, h = meta["box"]
        assert max(abs((sx - 1) * u + tx) for u in (x, x + w)) < .5
        assert max(abs((sy - 1) * v + ty) for v in (y, y + h)) < .5
    assert l3.main(["compose", *args, "--out-root", str(variant)]) == 0
    composed = l3.Source.library(variant / "_library/temperate")
    for k, panel in enumerate(panels):
        rgba = read_png(attempt / f"part_{k}_0.png")
        assert rgba.shape == panel.parts[0].fd.base.shape
        np.testing.assert_array_equal(rgba[..., 3], panel.parts[0].fd.alpha2)
        np.testing.assert_array_equal(composed.frame_hd("anim:MAKE", k)[0], rgba)
        np.testing.assert_array_equal(composed.frame_hd("anim:MAKE", k)[1], panel.parts[0].fd.base_paint)


def test_stabilize_propagates_locked_colour_and_feathers_only_static_pixels(sequence_library, tmp_path):
    spec = sequence_job()
    panels = l3.build_panels(sequence_library, spec)
    layout = l3.prepare_job(sequence_library, spec, tmp_path / "work")
    inp = hr.load_rgb(tmp_path / "work/MAKE/input.png")
    raw = inp.copy()
    for k, meta in enumerate(layout["panels"]):
        x, y, w, h = meta["box"]
        cell = raw[y:y + h, x:x + w]
        foreground = hr.foreground(cell, 6)
        cell[foreground] = np.clip(cell[foreground] + (0, 35, -30)[k], 0, 255)
    lock = {"wL": 0, "sL": 0, "wab": 0, "sab": 0, "edge_hf": 1}
    versions = []
    for stabilize in (False, True):
        spec["layout"]["stabilize"] = stabilize
        attempt = tmp_path / str(stabilize)
        attempt.mkdir()
        write_png(attempt / "raw.png", raw)
        metrics = l3.evaluate_attempt(sequence_library, spec, panels, layout, attempt, inp, lock, l3.DEFAULT_THRESHOLDS)
        shown = [l3.composite_hd(p.parts, (64, 48), [read_png(attempt / f"part_{k}_0.png")])[2]
                 for k, p in enumerate(panels)]
        versions.append(shown)
        if stabilize:
            assert metrics["temporal"]["stabilized_fraction"][0] == 0
            assert all(0 < f <= 1 for f in metrics["temporal"]["stabilized_fraction"][1:])
            for k in (1, 2):
                weights = l3.stabilization_weights(panels[k - 1], panels[k])
                assert np.any(weights == .5) and np.any(weights == 1)
                np.testing.assert_array_equal(shown[k][weights == 1], shown[k - 1][weights == 1])
                np.testing.assert_array_equal(shown[k][weights == 0], versions[0][k][weights == 0])
                assert np.mean(np.abs(versions[0][k][weights == 1] - versions[0][k - 1][weights == 1])) > 5
    # Temporal colour statistics ignore paint identity, while stabilization requires the actual palette index.
    panels[1].paint1[24, 30] = 21
    _, static_colour = l3.sequence_masks(panels[0], panels[1])
    _, static_paint = l3.sequence_masks(panels[0], panels[1], paint=True)
    assert static_colour[48, 60] and not static_paint[48, 60]


def test_temporal_reports_changed_overlap_and_empty_overlap(sequence_library):
    panels = l3.build_panels(sequence_library, sequence_job())
    before = panels[0].fd.art1.repeat(2, 0).repeat(2, 1)
    after = before.copy()
    after[24:28, 32:36] += 20
    panels[1].fd.art1[12:14, 16:18] += 1
    pair = l3.temporal_pair(panels[0], panels[1], before, after, 1)
    assert pair["static_flicker_dE"]["mean"] == 0 < pair["all_dE"]["mean"]
    panels[1].fd.alpha1[:] = False
    pair = l3.temporal_pair(panels[0], panels[1], before, after, 1)
    assert pair["static_flicker_dE"] == {"mean": None, "p95": None, "pixels": 0, "fraction": 0}


def test_grid_multiple_parts_keep_local_rects_and_context_only_exclusion(library, tmp_path):
    spec = job(context=True)
    spec["layout"] = {"cols": 2, "align": "anchor", "stabilize": True}
    work = tmp_path / "work"
    layout = l3.prepare_job(library, spec, work)
    panels = l3.build_panels(library, spec)
    assert layout["grid"]["common_box"] == [-20, -34, 48, 41]
    assert layout["panels"][0]["parts"][1]["rect"] == [8, 13, 16, 12]
    assert layout["panels"][1]["parts"][0]["rect"] == [8, 6, 30, 35]
    attempt = work / "TEST/attempt1"
    attempt.mkdir()
    shutil.copyfile(attempt.parent / "input.png", attempt / "raw.png")
    metrics = l3.evaluate_attempt(library, spec, panels, layout, attempt, hr.load_rgb(attempt / "raw.png"),
                                  l3.DEFAULT_LOCK, l3.DEFAULT_THRESHOLDS)
    assert "pairs" not in metrics["temporal"]
    for artifact in metrics["parts"]:
        rgba = read_png(attempt / artifact["file"])
        original, _ = library.frame_hd(artifact["sprite"], artifact["frame"])
        assert rgba.shape == original.shape
        np.testing.assert_array_equal(rgba[..., 3], original[..., 3])
    (work / "decisions.json").write_text(json.dumps([{"id": "TEST", "status": "FLAGGED", "chosen": 1,
                                                      "attempts": [{**metrics, "attempt": 1}]}]))
    root = tmp_path / "variant"
    args = l3.build_parser().parse_args(["compose", "--work", str(work), "--out-root", str(root)])
    assert l3.compose_jobs([spec], {"library": library}, args) == 0
    composed = l3.Source.library(root / "_library/temperate")
    np.testing.assert_array_equal(composed.frame_hd("anim:OVER", 0)[0], library.frame_hd("anim:OVER", 0)[0])
    for k in (0, 1):
        np.testing.assert_array_equal(composed.frame_hd("building:TEST", k)[0], read_png(attempt / f"part_{k}_0.png"))


@pytest.mark.parametrize("layout", [{}, {"cols": 0, "align": "anchor"}, {"cols": 2, "align": "center"},
                                    {"cols": 2, "align": "anchor", "gap": -1},
                                    {"cols": 2, "align": "anchor", "sequence": "true"}])
def test_invalid_grid_settings(library, layout):
    with pytest.raises(ValueError, match="layout"):
        l3.build_panels(library, {**job(), "layout": layout})


def test_library_pages_lazy_house_colours_and_eviction(library):
    assert not library._loaded
    assert [p["hd"] for p in library.pages()] == ["hd0.png", "hd1.png"]
    assert not library._loaded
    np.testing.assert_array_equal(library.house_ramp("Blue"), library.house_ramp(1))
    rgb, alpha, paint = library.frame_1x("building:TEST", 0, "Gold")
    assert rgb.dtype == np.float32 and alpha.dtype == paint.dtype == bool
    np.testing.assert_array_equal(rgb[6, 9], library.house_ramp("Gold")[4])
    assert paint[6, 9] and not alpha[0, 0]
    assert set(library._loaded) == {(0, "file")}
    library.cache_bytes = 1  # Eviction must not invalidate returned frame copies.
    rgba, remap = library.frame_hd("building:TEST", 1)
    assert rgba.shape == (70, 60, 4) and remap.shape == (70, 60)
    assert len(library._loaded) == 1
    np.testing.assert_array_equal(rgb[6, 9], library.house_ramp(0)[4])
    assert library.offset("building:TEST", 1) == (-12, -28)
    with pytest.raises(ValueError, match="unknown house"):
        library.house_ramp("Missing")
    with pytest.raises(ValueError, match="outside"):
        library.frame_hd("building:TEST", -1)


def test_panel_order_offsets_and_soft_alpha(library):
    spec = job(context=True)
    first = l3.build_panels(library, spec)[0]
    assert first.origin == (-20, -34)
    assert first.parts[1].rect == (8, 13, 16, 12)
    assert not first.parts[1].paste
    np.testing.assert_array_equal(first.fd.art1[15, 10], library.frame_1x("anim:OVER", 0, "Gold")[0][2, 2])
    spec["panels"][0]["parts"].reverse()
    reversed_panel = l3.build_panels(library, spec)[0]
    np.testing.assert_array_equal(reversed_panel.fd.art1[15, 10], library.frame_1x("building:TEST", 0, "Gold")[0][15, 10])
    np.testing.assert_array_equal(first.fd.alpha1, reversed_panel.fd.alpha1)
    first.parts[1].fd.base[..., 3] //= 2
    _, _, composite = l3.composite_hd(first.parts, (48, 40))
    bottom = first.parts[0].fd.displayed(first.parts[0].fd.base)[30, 20]
    top = first.parts[1].fd.displayed(first.parts[1].fd.base)[4, 4]
    np.testing.assert_allclose(composite[30, 20], top * (127 / 255) + bottom * (128 / 255), atol=1e-4)


def synthetic_panel(h, w):
    yy, xx = np.mgrid[:h, :w]
    lum = (130 + 50 * np.sin(xx / 7) + 30 * np.cos(yy / 5)).astype(np.float32)
    art = np.stack((lum, lum * .85, lum * .65), -1)
    alpha = (xx > 4) & (xx < w - 7) & (yy > 3 + xx // 9) & (yy < h - 4)
    base = np.dstack((hr.to_u8(art.repeat(2, 0).repeat(2, 1)), alpha.repeat(2, 0).repeat(2, 1) * 255)).astype(np.uint8)
    fd = hr.FrameData(rd.FrameRef("building:X", 0, (0, 0, w, h), "unit", False), art, alpha, base,
                      np.zeros((h * 2, w * 2), np.uint8), None)
    return l3.Panel("synthetic", fd, [l3.Part(fd, (0, 0, w, h), (0, 0), 0, True)], (0, 0))


@pytest.mark.parametrize("sizes", [((64, 90), (50, 70)), ((22, 25), (26, 30))])
def test_sheet_layout_register_round_trip(library, sizes):
    panels = [synthetic_panel(*s) for s in sizes]
    layout = l3.make_layout(library, job(), panels)
    assert set(layout) == {"version", "source", "source_dir", "house", "margin", "gap", "enlarge", "canvas", "panels"}
    factor = layout["enlarge"]
    width, height = layout["canvas"]
    canvas = np.full((height // factor, width // factor, 3), 118, np.float32)
    previous_end = None
    for panel, meta in zip(panels, layout["panels"]):
        x, y, w, h = (v // factor for v in meta["box"])
        assert (h, w) == tuple((v + 16) * 4 for v in panel.fd.alpha1.shape)
        assert y == (height // factor - h) // 2
        if previous_end is not None:
            assert x - previous_end == 48
        previous_end = x + w
        canvas[y:y + h, x:x + w] = hr.model_input_4x(panel.fd, None)
    inp = hr.resize_linear(canvas, (width, height)) if factor > 1 else canvas
    truth = (1.02, 3.2, 1.02, -2.6)
    inverse = (1 / truth[0], -truth[1] / truth[0], 1 / truth[2], -truth[3] / truth[2])
    moved = hr.warp_st(inp, inverse, inp.shape[:2])
    # raw.png may have a different size from output.png; sample it directly after fitting at canvas resolution.
    raw = hr.resize_linear(moved, (width * 2, height * 2))
    out_canvas = hr.resize_linear(raw, (width, height))
    for panel, meta in zip(panels, layout["panels"]):
        raw2, raw2m, _, diag = l3.register_panel(panel, meta, layout, inp, raw, out_canvas)
        assert raw2.shape[:2] == tuple(v * 2 for v in panel.fd.alpha1.shape)
        assert raw2m.shape[0] == raw2.shape[0] + 32
        assert max(abs(v) for v in diag["residual_shift_2x"]) < .5
        p = diag["params_canvas"]
        x, y, w, h = meta["box"]
        for u, v in ((x, y), (x + w, y + h)):
            assert abs(p[0] * u + p[1] - (truth[0] * u + truth[1])) < .5
            assert abs(p[2] * v + p[3] - (truth[2] * v + truth[3])) < .5


def test_relaxed_lightness_endpoints_and_alpha():
    fd = synthetic_panel(24, 30).fd
    fd.art1[:] = 120
    rep = np.full(fd.base.shape[:2] + (3,), 170, np.float32)
    for weight, target in ((0, rep), (1, fd.art1.repeat(2, 0).repeat(2, 1))):
        result = l3.relaxed_lock(fd, rep, wL=weight, sL=0, wab=0, edge_hf=1)
        mask = fd.alpha1.repeat(2, 0).repeat(2, 1)
        np.testing.assert_allclose(rd.srgb_to_lab(result)[..., 0][mask], rd.srgb_to_lab(target)[..., 0][mask], atol=3e-5)
    fd.base[..., 3] = np.random.default_rng(6).integers(0, 256, fd.base.shape[:2], dtype=np.uint8)
    np.testing.assert_array_equal(hr.encode_frame(fd, rep)[..., 3], fd.base[..., 3])


def test_prepare_preserves_input_and_copies_references(library, tmp_path):
    spec = job()
    reference = tmp_path / "style.jpg"
    Image.new("RGB", (8, 8), "red").save(reference)
    spec.update(style_reference=str(reference), extra_images={"reference_intact.png": str(reference)})
    work = tmp_path / "work"
    layout = l3.prepare_job(library, spec, work)
    path = work / spec["id"] / "input.png"
    before = path.read_bytes()
    stamp = path.stat().st_mtime_ns
    l3.prepare_job(library, spec, work)
    assert path.read_bytes() == before and path.stat().st_mtime_ns == stamp
    assert json.loads((path.parent / "layout.json").read_text()) == layout
    assert Image.open(path.parent / "style_reference.png").format == "PNG"
    assert (path.parent / "reference_intact.png").is_file()
    spec["panels"].reverse()
    with pytest.raises(ValueError, match="existing"):
        l3.prepare_job(library, spec, work)
    l3.prepare_job(library, spec, work, force=True)
    assert path.read_bytes() != before


def patch_for(source, value=155, fi=0, ident="TEST"):
    rgba, _ = source.frame_hd("building:TEST", fi)
    rgba[..., :3] = value
    return l3.Patch(source, "building:TEST", fi, rgba, ident, "FLAGGED")


def test_compose_merges_regular_page_detaches_links_and_only_touches_rects(library, tmp_path):
    root = tmp_path / "variant"
    root.mkdir()
    (root / "_library").symlink_to(library.dir.parent, target_is_directory=True)
    original = (library.dir / "hd0.png").read_bytes()
    directory = l3.variant_directory(library, root)
    existing = read_png(directory / "hd0.png")
    existing[0, 0, :3] = 71  # Another track's edit outside this frame must survive.
    l3.save_image(directory / "hd0.png", existing)
    (directory / "l3_frames.json").write_text(json.dumps([
        {"page": "hd0.png", "sprite": "other:TRACK", "frame": 9, "job": "OTHER", "status": "ACCEPTED"}]))
    l3.paste_patches([patch_for(library, 140), patch_for(library, 165, ident="LATER")], root)
    got = read_png(directory / "hd0.png")
    expected = existing.copy()
    expected[6:86, 4:100] = patch_for(library, 165).image
    np.testing.assert_array_equal(got, expected)
    assert not (root / "_library").is_symlink() and not directory.is_symlink()
    assert not (directory / "hd0.png").is_symlink()
    for name in ("hd1.png", "index0.png", "library.json", "paint0.png", "paint1.png"):
        assert (directory / name).is_symlink()
    assert (root / "OTHER_MAP").is_symlink()
    assert (root / "_library/common").is_symlink()
    assert (library.dir / "hd0.png").read_bytes() == original
    report = json.loads((directory / "l3_frames.json").read_text())
    assert len(report) == 2 and report[-1]["job"] == "LATER" and report[-1]["rect"] == [4, 6, 96, 80]


def test_no_model_end_to_end_raw_precedence_and_context_only(library, tmp_path, monkeypatch):
    spec = job(context=True)
    plan = tmp_path / "plan.json"
    plan.write_text(json.dumps([spec]))  # A missing prompt is harmless in --no-model mode.
    work = tmp_path / "work"
    base = ["--plan", str(plan), "--work", str(work), "--library", str(library.dir)]
    assert l3.main(["prepare", *base, "--upscaler", "lanczos"]) == 0
    attempt = work / "TEST/attempt1"
    attempt.mkdir()
    shutil.copyfile(attempt.parent / "input.png", attempt / "raw.png")
    shutil.copyfile(attempt.parent / "input.png", attempt / "input.png")
    (attempt / "prompt.txt").write_text("Manual seed: preserve me.")
    (attempt / "output.png").write_bytes(b"raw.png must take precedence")
    monkeypatch.setattr(hr, "run_codex", lambda *a: pytest.fail("--no-model called codex"))
    assert l3.main(["run", *base, "--no-model"]) == 0
    decisions = json.loads((work / "decisions.json").read_text())
    assert decisions[0]["chosen"] == 1
    assert len(decisions[0]["attempts"][0]["panels"]) == 2
    assert (attempt / "panel_0_2x.png").is_file()
    assert (attempt / "prompt.txt").read_text() == "Manual seed: preserve me."
    assert not (work / "TEST/attempt2").exists()
    root = tmp_path / "variant"
    assert l3.main(["compose", *base, "--out-root", str(root)]) == 0
    frames = json.loads((root / "_library/temperate/l3_frames.json").read_text())
    assert len(frames) == 2 and all(e["sprite"] == "building:TEST" for e in frames)
    old = read_png(library.dir / "hd1.png")
    new = read_png(root / "_library/temperate/hd1.png")
    np.testing.assert_array_equal(old[6:30, 6:38], new[6:30, 6:38])
    assert all("colour" in p for p in decisions[0]["attempts"][0]["panels"])


def test_delta_identity_offsets_outside_body_and_glow():
    body = synthetic_panel(24, 30).fd
    body.base_paint[10:14, 12:16] = 127
    body.ref.remap = True
    body.house = np.array([[240 - 12 * i] * 3 for i in range(16)], np.float32)
    anim = hr.FrameData(body.ref, body.art1, body.alpha1, np.pad(body.base, ((4, 6), (6, 2), (0, 0))),
                        np.pad(body.base_paint, ((4, 6), (6, 2))), body.house)
    anim.base[0:2, 0:2] = (200, 170, 140, 155)
    new = body.base.copy()
    new[..., :3] = np.minimum(new[..., :3].astype(int) + 25, 255)
    result = l3.delta_transfer(body, anim, new, (0, 0), (-3, -2))
    inside = body.alpha2 > 0
    np.testing.assert_array_equal(result[4:52, 6:66][inside], new[inside])
    np.testing.assert_array_equal(result[..., 3], anim.alpha2)
    np.testing.assert_array_equal(result[:4], anim.base[:4])
    # A visible glow is a linear additive delta on top of the new facade.
    body = synthetic_panel(24, 30).fd
    body.base[..., :3] = 80
    anim = hr.FrameData(body.ref, body.art1, body.alpha1, body.base.copy(), body.base_paint, None)
    anim.base[20:24, 24:28, :3] = 160
    new = body.base.copy()
    new[..., :3] = 120
    result = l3.delta_transfer(body, anim, new, (0, 0), (0, 0))
    expected = hr.to_u8(rd.linear_to_srgb(rd.srgb_to_linear(np.array([120] * 3)) +
                                        rd.srgb_to_linear(np.array([160] * 3)) - rd.srgb_to_linear(np.array([80] * 3))))
    np.testing.assert_array_equal(result[21, 25, :3], expected)


@pytest.mark.parametrize("unrelated", ["add", "keep"])
def test_delta_unrelated_overlays_and_glow(unrelated):
    body = synthetic_panel(24, 30).fd
    body.base[..., :3] = 100
    body.base_paint[20:24, 24:28] = 127
    body.ref.remap = True
    body.house = np.array([[240 - 12 * i, 180 - 9 * i, 100 - 5 * i] for i in range(16)], np.float32)
    anim = hr.FrameData(body.ref, body.art1, body.alpha1, body.base.copy(), body.base_paint, body.house)
    anim.base[20:24, 24:28, :3] = (15, 25, 10)  # A dark, unrelated door, including fractional paint.
    anim.base[20:24, 32:36, :3] = 180  # Added light must still transfer in both modes.
    new = body.base.copy()
    new[..., :3] = 145
    result = l3.delta_transfer(body, anim, new, (0, 0), (0, 0), unrelated)
    if unrelated == "keep":
        np.testing.assert_array_equal(result[20:24, 24:28], anim.base[20:24, 24:28])
    else:
        assert np.any(result[20:24, 24:28, :3] != anim.base[20:24, 24:28, :3])
        np.testing.assert_array_equal(result, l3.delta_transfer(body, anim, new, (0, 0), (0, 0)))
    np.testing.assert_array_equal(result[16:20, 20:24], new[16:20, 20:24])
    assert np.all(result[20:24, 32:36, :3] > 180)
    np.testing.assert_array_equal(result[..., 3], anim.alpha2)


def test_delta_animation_reference_and_foreign_page_patch(sequence_library, tmp_path):
    source, root = sequence_library, tmp_path / "variant"
    rgba, _ = source.frame_hd("anim:MAKE", 0)
    rgba[..., :3] = 165
    l3.paste_patches([l3.Patch(source, "anim:MAKE", 0, rgba, "REFERENCE", "ACCEPTED")], root)
    directory = root / "_library/temperate"
    before = (directory / "hd2.png").read_bytes()
    foreign = read_png(directory / "hd3.png")
    foreign[0, 0] = (71, 82, 93, 255)
    l3.save_image(directory / "hd3.png", foreign)
    assert l3.main(["delta", "--library", str(source.dir), "--body", "anim:MAKE:0", "--anim", "anim:MAKE",
                    "--frames", "1-2", "--unrelated", "keep", "--new-atlas-root", str(root),
                    "--out-root", str(root)]) == 0
    np.testing.assert_array_equal(read_png(directory / "hd3.png")[0, 0], foreign[0, 0])
    assert (directory / "hd2.png").read_bytes() == before
    variant = l3.Source.library(directory)
    body = source.data("anim:MAKE", 0, source.house_ramp())
    for k in (1, 2):
        anim = source.data("anim:MAKE", k, source.house_ramp())
        expected = l3.delta_transfer(body, anim, rgba, source.offset("anim:MAKE", 0),
                                     source.offset("anim:MAKE", k), "keep")
        np.testing.assert_array_equal(variant.frame_hd("anim:MAKE", k)[0], expected)
        np.testing.assert_array_equal(expected[..., 3], anim.alpha2)
    assert [e["status"] for e in json.loads((directory / "l3_frames.json").read_text())] == ["ACCEPTED", "DELTA", "DELTA"]


def test_delta_keep_does_not_copy_equal_encoding_with_different_display():
    body, anim = synthetic_panel(24, 30).fd, synthetic_panel(24, 30).fd
    body.base[..., :3] = anim.base[..., :3] = 30
    body.base_paint[:] = anim.base_paint[:] = 255
    body.ref.remap = True
    body.house = np.full((16, 3), 220, np.float32)
    new = body.base.copy()
    new[..., :3] = 170
    result = l3.delta_transfer(body, anim, new, (0, 0), (0, 0), "keep")
    np.testing.assert_array_equal(result, anim.base)


def test_delta_cli_preserves_redrawn_body_and_anim_alpha(library, tmp_path):
    root = tmp_path / "variant"
    patch = patch_for(library, 150)
    l3.paste_patches([patch], root)
    before = (root / "_library/temperate/hd0.png").read_bytes()
    assert l3.main(["delta", "--source", "library", "--library", str(library.dir), "--body", "building:TEST:0",
                    "--anim", "anim:GLOW", "--frames", "0-0", "--new-atlas-root", str(root), "--out-root", str(root)]) == 0
    variant = l3.Source.library(root / "_library/temperate")
    anim, _ = variant.frame_hd("anim:GLOW", 0)
    mask = patch.image[..., 3] > 0
    np.testing.assert_array_equal(anim[mask], patch.image[mask])
    np.testing.assert_array_equal(anim[..., 3], library.frame_hd("anim:GLOW", 0)[0][..., 3])
    assert (root / "_library/temperate/hd0.png").read_bytes() == before


def map_source(library):
    directory = library.cache_root / "MAP"
    directory.mkdir()
    (directory / "nested").mkdir()
    for source, target in (("index0.png", "sprites.png"), ("hd0.png", "sprites@2x.png"),
                           ("paint0.png", "sprites@2x-remap.png"), ("palette.png", "palette.png")):
        shutil.copyfile(library.dir / source, directory / target)
    entry = {**library.sprite("building:TEST"), "frames": [library.frame("building:TEST", 0)]}
    manifest = {"spriteAtlas": {"file": "sprites.png", "width": 96, "height": 80},
                "spriteAtlasHd": {"file": "sprites@2x.png", "remap": "sprites@2x-remap.png", "scale": 2},
                "palettes": {"unit": "palette.png"}, "sprites": {"building:TEST": entry},
                "houses": {"First": {"remap": library.house_ramp(0).tolist()},
                           "Second": {"remap": library.house_ramp(1).tolist()}}}
    (directory / "manifest.json").write_text(json.dumps(manifest))
    return l3.Source.map(directory)


def test_map_default_house_base_atlas_and_symlink_farm(library, tmp_path):
    source = map_source(library)
    np.testing.assert_array_equal(source.house_ramp(), library.house_ramp(0))
    np.testing.assert_array_equal(source.house_ramp(1), library.house_ramp(1))
    assert source.frame_1x("building:TEST", 0)[2].any()
    root = tmp_path / "variant"
    root.mkdir()
    keep = root / "OTHER_MAP"
    keep.mkdir()
    (keep / "mine").write_text("preserve")
    base = read_png(source.dir / "sprites@2x.png")
    base[0, 0, :3] = 97
    base_path = tmp_path / "base.png"
    write_png(base_path, base)
    directory = l3.variant_directory(source, root, "NEW_MAP")
    (directory / "l3_frames.json").write_text(json.dumps([
        {"page": "sprites@2x.png", "sprite": "old:FRAME", "frame": 0, "status": "FLAGGED"}]))
    l3.paste_patches([patch_for(source)], root, "NEW_MAP", base_path)
    assert (root / "NEW_MAP/nested").is_symlink()
    assert (root / "NEW_MAP/manifest.json").is_symlink()
    assert (root / "NEW_MAP/sprites@2x-remap.png").is_symlink()
    assert not (root / "NEW_MAP/sprites@2x.png").is_symlink()
    assert (root / "_library").is_symlink() and (root / "MAP").is_symlink()
    assert (keep / "mine").read_text() == "preserve"
    expected = base.copy()
    expected[6:86, 4:100] = patch_for(source).image
    np.testing.assert_array_equal(read_png(root / "NEW_MAP/sprites@2x.png"), expected)
    assert [e["sprite"] for e in json.loads((directory / "l3_frames.json").read_text())] == ["building:TEST"]
    with pytest.raises(ValueError, match="separate"):
        l3.paste_patches([patch_for(source)], source.cache_root)


def test_map_compose_defaults_to_regular_variant_and_merges_records(library, tmp_path):
    source = map_source(library)
    spec = {"id": "MAP", "source": "map", "panels": [
        {"parts": [{"sprite": "building:TEST", "frame": 0}]}]}
    work, root, plan = tmp_path / "work", tmp_path / "variant", tmp_path / "plan.json"
    plan.write_text(json.dumps([spec]))
    args = ["--plan", str(plan), "--work", str(work), "--cache", str(source.cache_root), "--map", "MAP"]
    assert l3.main(["prepare", *args, "--upscaler", "lanczos"]) == 0
    attempt = work / "MAP/attempt1"
    attempt.mkdir()
    shutil.copyfile(attempt.parent / "input.png", attempt / "output.png")
    assert l3.main(["run", *args, "--no-model"]) == 0
    directory = l3.variant_directory(source, root)
    existing = read_png(directory / "sprites@2x.png")
    existing[0, 0] = (71, 82, 93, 255)
    l3.save_image(directory / "sprites@2x.png", existing)
    record = {"page": "sprites@2x.png", "sprite": "building:PREVIOUS", "frame": 0, "job": "PREVIOUS"}
    (directory / "l3_frames.json").write_text(json.dumps([record]))
    (directory / "trees_frames.json").write_text("foreign report: preserve verbatim")
    assert l3.main(["compose", *args, "--out-root", str(root)]) == 0
    expected = existing.copy()
    expected[6:86, 4:100] = read_png(attempt / "part_0_0.png")
    np.testing.assert_array_equal(read_png(directory / "sprites@2x.png"), expected)
    records = json.loads((directory / "l3_frames.json").read_text())
    assert len(records) == 2 and records[0] == record
    assert (directory / "trees_frames.json").read_text() == "foreign report: preserve verbatim"


@pytest.mark.parametrize("kind", ["map", "library"])
@pytest.mark.parametrize("collisions", [1, 3])
def test_page_merge_retries_concurrent_write_and_stops_after_three(library, tmp_path, monkeypatch, kind, collisions):
    source = map_source(library) if kind == "map" else library
    root = tmp_path / "variant"
    directory = l3.variant_directory(source, root)
    dst = directory / source.page_files(0)["hd"]
    original = read_png(dst)
    count = 0
    save = Image.Image.save
    def concurrent_save(image, path, *args, **kwargs):
        nonlocal count
        result = save(image, path, *args, **kwargs)
        path = Path(path)
        if path.parent == directory and path.name.startswith(f".{dst.name}.") and count < collisions:
            count += 1
            foreign = read_png(dst)
            foreign[0, count] = (70 + count, 80, 90, 255)
            temp = directory / "foreign.png"
            save(Image.fromarray(foreign), temp)
            os.replace(temp, dst)
        return result
    monkeypatch.setattr(Image.Image, "save", concurrent_save)
    if collisions == 3:
        with pytest.raises(l3.ConcurrentWriteError, match="changed during update"):
            l3.paste_patches([patch_for(source)], root)
    else:
        l3.paste_patches([patch_for(source)], root)
        original[6:86, 4:100] = patch_for(source).image
    for k in range(1, collisions + 1):
        original[0, k] = (70 + k, 80, 90, 255)
    assert count == collisions
    np.testing.assert_array_equal(read_png(dst), original)
    assert not list(directory.glob(f".{dst.name}.*"))


def mocked_evaluation(failures):
    """A state-machine oracle; geometry, encoding and actual checks are exercised separately above."""
    def evaluate(source, spec, panels, layout, directory, inp, lock, thresholds):
        k = int(directory.name.removeprefix("attempt"))
        items = [{"check": "a_local", "detail": f"missing feature {i}", "hint": "local:upper left",
                  "label": "intact"} for i in range(failures[k - 1])]
        return {"passed": not items, "failures": items, "parts": [{"file": "unused.png"}], "panels": []}
    return evaluate


def setup_mock_run(library, tmp_path, specs):
    work = tmp_path / "work"
    prompt = tmp_path / "prompt.txt"
    prompt.write_text("User's full prompt, verbatim.")
    for spec in specs:
        spec["prompt_file"] = str(prompt)
        l3.prepare_job(library, spec, work)
    plan = tmp_path / "plan.json"
    plan.write_text(json.dumps(specs))
    args = l3.build_parser().parse_args(["run", "--plan", str(plan), "--work", str(work),
                                        "--library", str(library.dir), "--max-attempts", "3", "--parallel", "1"])
    return work, args


def test_retry_prompt_early_accept_and_flagged_best(library, tmp_path, monkeypatch):
    spec = job()
    work, args = setup_mock_run(library, tmp_path, [spec])
    prompts = []
    def call(codex, directory, prompt, timeout):
        prompts.append(prompt)
        shutil.copyfile(directory / "input.png", directory / "output.png")
        return {"exit": 0}
    monkeypatch.setattr(hr, "run_codex", call)
    monkeypatch.setattr(l3, "evaluate_attempt", mocked_evaluation([2, 0, 3]))
    assert l3.run_jobs([spec], {"library": library}, args) == 0
    decision = json.loads((work / "decisions.json").read_text())[0]
    assert len(prompts) == 2 and decision["status"] == "ACCEPTED" and decision["chosen"] == 2
    assert prompts[0] == "User's full prompt, verbatim."
    assert prompts[1].startswith(prompts[0]) and "upper left" in prompts[1] and "intact" in prompts[1]
    monkeypatch.setattr(l3, "evaluate_attempt", mocked_evaluation([3, 1, 2]))
    assert l3.run_jobs([spec], {"library": library}, args) == 0
    decision = json.loads((work / "decisions.json").read_text())[0]
    assert len(prompts) == 3  # Existing attempt outputs were evaluated, not called again.
    assert decision["status"] == "FLAGGED" and decision["chosen"] == 2
    assert len(decision["attempts"]) == 3


@pytest.mark.parametrize("message", ["Usage limit reached", "Rate limit reached", "HTTP 429", "Quota exceeded"])
def test_model_limit_stops_new_calls_and_reports(library, tmp_path, monkeypatch, message):
    specs = [job("FIRST"), job("SECOND")]
    work, args = setup_mock_run(library, tmp_path, specs)
    args.limit_file = tmp_path / "limits/message.txt"
    calls = []
    def call(codex, directory, prompt, timeout):
        calls.append(directory)
        (directory / "run.log").write_text(message)
        shutil.copyfile(directory / "input.png", directory / "output.png")
        return {"exit": 1}
    monkeypatch.setattr(hr, "run_codex", call)
    monkeypatch.setattr(l3, "evaluate_attempt", mocked_evaluation([1, 1, 1]))
    assert l3.run_jobs(specs, {"library": library}, args) == 1
    assert len(calls) == 1
    assert message in args.limit_file.read_text()
    decisions = json.loads((work / "decisions.json").read_text())
    assert decisions[0]["chosen"] == 1 and decisions[1]["chosen"] is None


def test_parallel_limit_finishes_inflight_call(library, tmp_path, monkeypatch):
    specs = [job("FIRST"), job("SECOND"), job("THIRD")]
    work, args = setup_mock_run(library, tmp_path, specs)
    args.parallel = 2
    barrier = threading.Barrier(2)
    limited = threading.Event()
    calls = []
    original_inspect = l3.LimitStop.inspect
    def inspect(self, log):
        original_inspect(self, log)
        if self.event.is_set():
            limited.set()
    def call(codex, directory, prompt, timeout):
        calls.append(directory)
        barrier.wait(timeout=10)
        if directory.parent.name == "FIRST":
            (directory / "run.log").write_text("usage limit")
        else:
            assert limited.wait(10)
        shutil.copyfile(directory / "input.png", directory / "output.png")
        return {"exit": 1 if directory.parent.name == "FIRST" else 0}
    monkeypatch.setattr(l3.LimitStop, "inspect", inspect)
    monkeypatch.setattr(hr, "run_codex", call)
    monkeypatch.setattr(l3, "evaluate_attempt", mocked_evaluation([1, 1, 1]))
    assert l3.run_jobs(specs, {"library": library}, args) == 1
    decisions = json.loads((work / "decisions.json").read_text())
    assert len(calls) == 2 and [d["chosen"] for d in decisions] == [1, 1, None]


def test_job_overrides_cli_and_context_checks(library):
    spec = job(context=True)
    spec["lock"] = {"wL": .2}
    spec["thresholds"] = {"lf_dE_mean": 19}
    lock, thresholds = l3.job_settings(spec, {"wL": .5, "sab": 8}, {"lf_dE_mean": 17})
    assert lock["wL"] == .2 and lock["sab"] == 8
    assert thresholds["lf_dE_mean"] == 19 and thresholds["lf_dE_p95"] == 28
    with pytest.raises(ValueError, match="unknown thresholds"):
        l3.job_settings(spec, None, {"typo": 0})
    fd = l3.build_panels(library, spec)[0].fd
    report = l3.colour_metrics(fd, fd.art1.repeat(2, 0).repeat(2, 1))
    assert report["hue_pixels"] > 0 and abs(report["hue_shift_degrees"]) < 1e-5


def test_resumed_limit_still_evaluates_saved_images_without_launching(library, tmp_path, monkeypatch):
    specs = [job("FIRST"), job("SECOND")]
    work, args = setup_mock_run(library, tmp_path, specs)
    for spec in specs:
        attempt = work / spec["id"] / "attempt1"
        attempt.mkdir()
        shutil.copyfile(attempt.parent / "input.png", attempt / "output.png")
    (work / "SECOND/attempt1/run.log").write_text("rate limit reached")
    # Old attempts recorded exit codes only in decisions.json; resume must still honour those failures.
    (work / "decisions.json").write_text(json.dumps([
        {"id": "SECOND", "attempts": [{"attempt": 1, "call": {"exit": 1}}]}]))
    monkeypatch.setattr(hr, "run_codex", lambda *a: pytest.fail("saved limit must block every new call"))
    monkeypatch.setattr(l3, "evaluate_attempt", mocked_evaluation([1, 1, 1]))
    assert l3.run_jobs(specs, {"library": library}, args) == 1
    decisions = json.loads((work / "decisions.json").read_text())
    assert [d["chosen"] for d in decisions] == [1, 1]


def test_running_limit_log_is_ignored_until_call_finishes(library, tmp_path, monkeypatch):
    specs = [job("FIRST"), job("SECOND")]
    work, args = setup_mock_run(library, tmp_path, specs)
    args.parallel = 2
    barrier = threading.Barrier(2)
    printed = threading.Event()
    inspected = threading.Event()
    calls = []
    limit = l3.LimitStop(work / "limit.txt")
    def call(codex, directory, prompt, timeout):
        calls.append(directory)
        barrier.wait(timeout=10)
        if directory.parent.name == "FIRST":
            (directory / "run.log").write_text("quota exhausted; process still running")
            printed.set()
            assert inspected.wait(10)
        else:
            assert printed.wait(10)
            limit.scan()
            assert not limit.event.is_set()
            inspected.set()
        shutil.copyfile(directory / "input.png", directory / "output.png")
        return {"exit": 0}
    monkeypatch.setattr(l3, "LimitStop", lambda path: limit)
    monkeypatch.setattr(hr, "run_codex", call)
    monkeypatch.setattr(l3, "evaluate_attempt", mocked_evaluation([0, 0, 0]))
    assert l3.run_jobs(specs, {"library": library}, args) == 0
    assert len(calls) == 2 and inspected.is_set() and not limit.event.is_set()
    assert all(d["chosen"] == 1 for d in json.loads((work / "decisions.json").read_text()))


@pytest.mark.parametrize("message,output,exit_code,expected", [
    ("tokens used: 35,429", None, 1, False),
    ("image succeeded; 35429 tokens", "output.png", 0, False),
    ("error: tokens used 35,429", None, 1, False),
    ("429", None, 1, False),
    ("HTTP 429", None, 0, True),
    ("status code: 429", None, 1, True),
    ("Error: 429", "raw.png", 1, True),
    ("429 Too Many Requests", None, 0, True),
    ("usage LIMIT", None, 0, True),
    ("RATE limit", None, 1, True),
    ("Quota exhausted", None, 1, True),
    ("quota remaining: 35,429", "raw.png", 0, False),
    ("recovered HTTP 429 / usage limit / rate limit / quota", "output.png", 0, False),
    ("HTTP 4290", None, 1, False),
])
def test_limit_requires_failed_call_or_missing_image_and_http_status(tmp_path, message, output, exit_code, expected):
    log = tmp_path / "run.log"
    log.write_text(message)
    if output:
        (tmp_path / output).write_bytes(b"saved image")
    limit = l3.LimitStop(tmp_path / "limit.txt")
    limit.start(log)
    limit.inspect(log)
    assert not limit.event.is_set()
    limit.finish(log, {"exit": exit_code})
    assert limit.event.is_set() is expected
    resumed = l3.LimitStop(tmp_path / "resumed.txt")
    resumed.inspect(log)
    assert resumed.event.is_set() is expected


def test_successful_token_log_does_not_block_later_jobs(library, tmp_path, monkeypatch):
    specs = [job("FIRST"), job("SECOND")]
    work, args = setup_mock_run(library, tmp_path, specs)
    calls = []
    def call(codex, directory, prompt, timeout):
        calls.append(directory)
        (directory / "run.log").write_text("image call succeeded, 35,429 tokens; quota remaining")
        shutil.copyfile(directory / "input.png", directory / "raw.png")
        return {"exit": 0}
    monkeypatch.setattr(hr, "run_codex", call)
    monkeypatch.setattr(l3, "evaluate_attempt", mocked_evaluation([0]))
    assert l3.run_jobs(specs, {"library": library}, args) == 0
    assert len(calls) == 2 and not (work / "limit.txt").exists()
