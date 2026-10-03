"""Asset-free unit coverage regressions using synthetic caches and artwork."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

import numpy as np
import pytest
from PIL import Image

import unit_coverage as coverage


def write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value), encoding="utf-8")


def snapshot(root: Path) -> dict[str, str]:
    return {
        str(path.relative_to(root)): hashlib.sha256(path.read_bytes()).hexdigest()
        for path in root.rglob("*")
        if path.is_file()
    }


def part_manifest(directory: Path, voxel: str, parts: tuple[str, ...]) -> None:
    manifest = {"version": 1, "type": voxel.replace("_turret", ":turret"), "frames": 16, "facingStep": 16, "parts": {}}
    for part in parts:
        colour, paint = f"{voxel}_{part}.png", f"{voxel}_{part}_paint.png"
        Image.new("RGBA", (4, 4), (110, 160, 210, 255)).save(directory / colour)
        Image.new("L", (4, 4), 0).save(directory / paint)
        manifest["parts"][part] = {
            "colour": colour,
            "paint": paint,
            "size": [4, 4],
            "frames": [
                {"k": index, "facing": index * 16, "pivot": [2, 2], "rect": [0, 0, 4, 4]}
                for index in range(16)
            ],
        }
    write_json(directory / f"{voxel}.json", manifest)


@pytest.fixture
def caches(tmp_path: Path) -> tuple[Path, Path]:
    """A symlink farm exposes two calibration classes and mixed coverage."""
    base, farm = tmp_path / "base", tmp_path / "farm"
    source_dir, target_dir = base / "_library/urban", farm / "_library/urban"
    source_dir.mkdir(parents=True)
    target_dir.mkdir(parents=True)
    voxel_dir = farm / "vehicles-hd"
    voxel_dir.mkdir()

    yy, xx = np.mgrid[:8, :8]
    native = np.empty((8, 8, 4), dtype=np.uint8)
    native[:, :, :3] = np.where(
        ((xx + yy) % 2)[..., None] == 0,
        np.array([190, 70, 45]),
        np.array([65, 155, 205]),
    )
    native[:, :, 3] = 255
    native[-1, :, :3] = 2
    redrawn = native.copy()
    redrawn[:-1, :, :3] = np.where(
        (xx[:-1] < 4)[..., None], np.array([70, 215, 90]), np.array([235, 210, 65])
    )
    upscaled = np.repeat(np.repeat(native, 2, axis=0), 2, axis=1)
    # Global shadow changes must not turn an otherwise unchanged body into a redraw.
    upscaled[-2:, :, :3] = 15
    hd_redrawn = np.repeat(np.repeat(redrawn, 2, axis=0), 2, axis=1)

    original = Image.new("RGBA", (96, 8))
    stage0 = Image.new("RGBA", (192, 16))
    current = Image.new("RGBA", (192, 16))
    for index in range(10):
        original.paste(Image.fromarray(native), (index * 8, 0))
        stage0.paste(Image.fromarray(np.repeat(np.repeat(native, 2, 0), 2, 1)), (index * 16, 0))
        changed = index == 0 or (index >= 2 and index % 2 == 0)
        current.paste(Image.fromarray(hd_redrawn if changed else upscaled), (index * 16, 0))
    original.save(source_dir / "original.png")
    stage0.save(source_dir / "hd.png")
    current.save(target_dir / "hd.png")
    (target_dir / "original.png").symlink_to(source_dir / "original.png")

    def frame(index: int) -> dict:
        return {"rect": [index * 8, 0, 8, 8], "offset": [0, 0], "page": 0}

    library = {
        "version": 1,
        "theater": "urban",
        "spriteAtlases": [{"file": "original.png", "width": 96, "height": 8}],
        "spriteAtlasesHd": [{"file": "hd.png", "width": 192, "height": 16, "scale": 2}],
        "sprites": {
            "infantry:GI": {"frames": [frame(0)]},
            "infantry:CIVA": {"frames": [frame(1)]},
            "infantry:PART": {"frames": [frame(i) for i in range(2, 10)] + [
                {"rect": [0, 0, 0, 0], "offset": [0, 0], "page": 0}, frame(10)
            ]},
        },
        "types": {
            "CIVA": {"kind": "infantry", "image": "CIVA", "sprite": "infantry:CIVA"},
            "BODY": {"kind": "vehicle", "image": "BODY", "voxel": "BODY"},
            "E1": {"kind": "infantry", "image": "GI", "sprite": "infantry:GI"},
            "PART": {"kind": "infantry", "image": "PART", "sprite": "infantry:PART", "infantry": {
                "sequences": {
                    "Walk": {"start": 0, "count": 1, "facingMultiplier": 1, "facing": "E"},
                    "Idle": {"start": 0, "count": 2, "facingMultiplier": 0},
                    "Outside": {"start": 20, "count": 1, "facingMultiplier": 0},
                }
            }},
            "MISS": {"kind": "vehicle", "image": "MISS", "voxel": "MISS"},
            "TANK": {"kind": "vehicle", "image": "TANK", "voxel": "TANK", "turret": True},
            "DEPLOY": {"kind": "vehicle", "image": "DEPLOY", "voxel": "DEPLOY", "unloadingVoxel": "FORM"},
        },
        "voxels": {code: f"voxels/{code}.json" for code in ("BODY", "MISS", "TANK", "DEPLOY", "FORM", "BT:turret")},
    }
    write_json(source_dir / "library.json", library)
    (target_dir / "library.json").symlink_to(source_dir / "library.json")
    for voxel in ("BODY", "TANK", "DEPLOY"):
        part_manifest(voxel_dir, voxel, ("body",))
    part_manifest(voxel_dir, "BT_turret", ("turret",))
    return farm, base


def test_scan_calibration_counts_sequences_and_manifest_parts(caches: tuple[Path, Path]) -> None:
    farm, base = caches
    before = snapshot(farm), snapshot(base)
    report = coverage.scan(farm, base, theaters=["urban"])
    rows = {row["code"]: row for row in report["rows"]}

    assert rows["E1"]["status"] == "已完成"
    assert rows["CIVA"]["status"] == "未完成"
    assert rows["PART"]["status"] == "部分"
    partial = rows["PART"]["theaters"]["urban"]
    assert partial["frames_total"] == 8
    assert partial["frames_redrawn"] == 4
    assert partial["sequences"]["Walk"]["frames_total"] == 8
    assert partial["sequences"]["Walk"]["frames_redrawn"] == 4
    assert partial["sequences"]["Idle"]["frames_total"] == 2
    assert partial["sequences"]["Idle"]["frames_redrawn"] == 1
    assert partial["sequences"]["Outside"]["missing_indices"] == [20]
    assert rows["BODY"]["status"] == "已完成"
    assert rows["MISS"]["status"] == "未完成"
    assert rows["TANK"]["status"] == "部分"
    assert rows["DEPLOY"]["status"] == "部分"
    turret = next(row for row in report["rows"] if row["kind"] == "building-turret")
    assert turret["status"] == "已完成"
    assert [row["code"] for row in report["rows"] if row["kind"] == "infantry"] == ["CIVA", "E1", "PART"]
    assert (snapshot(farm), snapshot(base)) == before
    assert (farm / "_library/urban/library.json").is_symlink()


def test_cli_outputs_metadata_and_keeps_input_caches_read_only(caches: tuple[Path, Path], tmp_path: Path) -> None:
    farm, base = caches
    meta = tmp_path / "meta.json"
    write_json(meta, {"E1": {"side": "盟军", "name": "大兵|示例", "note": "第一行\n第二行"}})
    destination = tmp_path / "reports"
    json_path, md_path = destination / "coverage.json", destination / "coverage.md"
    before = snapshot(farm), snapshot(base)
    result = coverage.main([
        "scan", "--farm", str(farm), "--base", str(base), "--theaters", "urban",
        "--meta", str(meta), "--json", str(json_path), "--md", str(md_path),
    ])
    assert result in (None, 0)
    report = json.loads(json_path.read_text(encoding="utf-8"))
    assert next(row for row in report["rows"] if row["code"] == "E1")["name"] == "大兵|示例"
    markdown = md_path.read_text(encoding="utf-8")
    assert "类别 | 阵营 | 代码 | 图像 | 名称 | 状态 | 说明" in markdown
    assert "本表不验收轮廓 IoU、材质质量、阵营色保真或实机遮挡" in markdown
    assert "大兵\\|示例" in markdown
    assert "第一行\n第二行" not in markdown
    assert (snapshot(farm), snapshot(base)) == before


def test_missing_calibration_cohort_is_an_error(caches: tuple[Path, Path]) -> None:
    farm, base = caches
    path = base / "_library/urban/library.json"
    library = json.loads(path.read_text())
    del library["types"]["E1"]
    del library["sprites"]["infantry:GI"]
    write_json(path, library)
    with pytest.raises(ValueError, match="(?i)calibrat|redrawn|cohort"):
        coverage.scan(farm, base, theaters=["urban"])


def test_frozen_calibration_survives_redrawing_a_negative_control(caches: tuple[Path, Path], tmp_path: Path) -> None:
    farm, base = caches
    original_report = coverage.scan(farm, base, theaters=["urban"])
    reference = tmp_path / "original-coverage.json"
    write_json(reference, original_report)
    hd_path = farm / "_library/urban/hd.png"
    with Image.open(hd_path) as source:
        current = source.copy()
    current.paste(current.crop((0, 0, 16, 16)), (16, 0))
    current.save(hd_path)
    with pytest.raises(ValueError, match="cohorts overlap"):
        coverage.scan(farm, base, theaters=["urban"])

    before = snapshot(farm), snapshot(base), reference.read_bytes()
    destination = tmp_path / "frozen-coverage.json"
    markdown_path = tmp_path / "frozen-coverage.md"
    coverage.main([
        "scan", "--farm", str(farm), "--base", str(base), "--theaters", "urban",
        "--calibration-report", str(reference), "--json", str(destination), "--md", str(markdown_path),
    ])
    report = json.loads(destination.read_text())
    assert report["calibration"]["threshold"] == original_report["calibration"]["threshold"]
    assert report["calibration"]["cohorts"] == original_report["calibration"]["cohorts"]
    assert report["calibration"]["reference"]["sha256"] == hashlib.sha256(reference.read_bytes()).hexdigest()
    assert next(row for row in report["rows"] if row["code"] == "CIVA")["status"] == "已完成"
    assert "历史对照" in markdown_path.read_text()
    assert (snapshot(farm), snapshot(base), reference.read_bytes()) == before


@pytest.mark.parametrize("invalid", ["base", "metric", "threshold", "cohort", "frames", "urban", "version"])
def test_frozen_calibration_rejects_incompatible_or_edited_evidence(
    caches: tuple[Path, Path], tmp_path: Path, invalid: str,
) -> None:
    farm, base = caches
    report = coverage.scan(farm, base, theaters=["urban"])
    if invalid == "base":
        report["base"] = str(tmp_path / "different-base")
    elif invalid == "metric":
        report["calibration"]["metric"] = "unrelated pixel metric"
    elif invalid == "threshold":
        report["calibration"]["threshold"] *= 0.1
    elif invalid == "cohort":
        del report["calibration"]["cohorts"]["not_redrawn"]["infantry:CIVA"]
    elif invalid == "frames":
        next(row for row in report["rows"] if row["code"] == "CIVA")["theaters"]["urban"]["frames"][0]["score"] = 1
    elif invalid == "urban":
        next(row for row in report["rows"] if row["code"] == "CIVA")["theaters"].clear()
    else:
        report["version"] = 2
    reference = tmp_path / "invalid-coverage.json"
    write_json(reference, report)
    with pytest.raises(ValueError, match="Calibration"):
        coverage.scan(farm, base, theaters=["urban"], calibration_report=reference)


def test_cli_cannot_overwrite_frozen_calibration(caches: tuple[Path, Path], tmp_path: Path) -> None:
    farm, base = caches
    reference = tmp_path / "original-coverage.json"
    write_json(reference, coverage.scan(farm, base, theaters=["urban"]))
    before = reference.read_bytes()
    with pytest.raises(SystemExit):
        coverage.main([
            "scan", "--farm", str(farm), "--base", str(base), "--calibration-report", str(reference),
            "--json", str(reference), "--md", str(tmp_path / "coverage.md"),
        ])
    assert reference.read_bytes() == before


def test_manifest_reference_without_atlas_is_incomplete(caches: tuple[Path, Path]) -> None:
    farm, base = caches
    (farm / "vehicles-hd/BODY_body.png").unlink()
    report = coverage.scan(farm, base, theaters=["urban"])
    row = next(row for row in report["rows"] if row["code"] == "BODY")
    assert row["status"] == "未完成"


def test_body_only_source_model_does_not_invent_a_turret(caches: tuple[Path, Path]) -> None:
    farm, base = caches
    write_json(farm / "_library/urban/voxels/TANK.json", {"parts": [{"role": "body"}]})
    report = coverage.scan(farm, base, theaters=["urban"])
    row = next(row for row in report["rows"] if row["code"] == "TANK")
    assert row["status"] == "已完成"


def test_manifest_with_missing_facing_is_partial(caches: tuple[Path, Path]) -> None:
    farm, base = caches
    path = farm / "vehicles-hd/BODY.json"
    manifest = json.loads(path.read_text())
    manifest["parts"]["body"]["frames"].pop()
    write_json(path, manifest)
    report = coverage.scan(farm, base, theaters=["urban"])
    row = next(row for row in report["rows"] if row["code"] == "BODY")
    assert row["status"] == "部分"


def test_indexed_palette_and_neutral_hd_remap_agree(tmp_path: Path) -> None:
    """House-colour neutralization alone must not become redraw evidence."""
    farm, base = tmp_path / "indexed-farm", tmp_path / "indexed-base"
    ramp = [[220 - i * 10, 25 + i, 45 + i] for i in range(16)]
    palette = np.zeros((1, 256, 3), dtype=np.uint8)
    palette[0, 23] = ramp[7]
    library = {
        "sprites": {"infantry:PAINT": {
            "palette": "unit", "frames": [{"page": 0, "rect": [0, 0, 4, 4], "offset": [0, 0]}]
        }},
        "palettes": {"unit": "palette.png"},
        "colorSchemes": [{"remap": ramp}],
        "colorSchemesByName": {"Red": 0},
        "spriteAtlases": [{"file": "original.png"}],
        "spriteAtlasesHd": [{"file": "hd.png", "remap": "paint.png", "scale": 2}],
    }
    for directory in (farm, base):
        directory.mkdir()
        Image.new("L", (4, 4), 23).save(directory / "original.png")
        Image.fromarray(palette).save(directory / "palette.png")
        Image.new("RGBA", (8, 8), (150, 150, 150, 255)).save(directory / "hd.png")
        Image.new("L", (8, 8), 255).save(directory / "paint.png")
    frames = coverage.SpriteScanner().scan(farm, library, base, library, ["infantry:PAINT"])["infantry:PAINT"]
    assert frames[0]["body_pixels"] == 16
    assert frames[0]["score"] == pytest.approx(0, abs=1e-8)
    assert frames[0]["original_lab"] == pytest.approx(0, abs=1e-8)


def add_snow(caches: tuple[Path, Path]) -> None:
    farm, base = caches
    for root in (farm, base):
        urban, snow = root / "_library/urban", root / "_library/snow"
        library = json.loads((urban / "library.json").read_text())
        library["theater"] = "snow"
        write_json(snow / "library.json", library)
        for filename in ("original.png", "hd.png"):
            (snow / filename).symlink_to(urban / filename)


def test_selected_theater_still_uses_urban_calibration(caches: tuple[Path, Path]) -> None:
    farm, base = caches
    add_snow(caches)
    report = coverage.scan(farm, base, theaters=["snow"])
    row = next(row for row in report["rows"] if row["code"] == "E1")
    assert set(row["theaters"]) == {"snow"}
    assert row["status"] == "已完成"
    assert report["calibration"]["theater"] == "urban"


def remove_snow_baseline_hd(base: Path) -> None:
    path = base / "_library/snow/library.json"
    library = json.loads(path.read_text())
    del library["spriteAtlasesHd"]
    write_json(path, library)
    (path.parent / "hd.png").unlink()


def test_missing_theater_baseline_can_borrow_identical_original(caches: tuple[Path, Path]) -> None:
    farm, base = caches
    add_snow(caches)
    remove_snow_baseline_hd(base)
    before = snapshot(farm), snapshot(base)
    report = coverage.scan(farm, base, theaters=["snow"])
    row = next(row for row in report["rows"] if row["code"] == "E1")
    assert row["status"] == "已完成"
    frame = row["theaters"]["snow"]["frames"][0]
    assert frame["baseline_theater"] == "urban"
    assert frame["baseline_fallback"] is True
    assert (snapshot(farm), snapshot(base)) == before


def test_missing_theater_baseline_rejects_changed_original(caches: tuple[Path, Path]) -> None:
    farm, base = caches
    add_snow(caches)
    remove_snow_baseline_hd(base)
    path = farm / "_library/snow/original.png"
    with Image.open(path) as source:
        original = source.copy()
    path.unlink()
    original.putpixel((0, 0), (250, 55, 95, 255))
    original.save(path)
    report = coverage.scan(farm, base, theaters=["snow"])
    row = next(row for row in report["rows"] if row["code"] == "E1")
    theater = row["theaters"]["snow"]
    assert row["status"] != "已完成"
    assert theater["frames_redrawn"] == 0
    assert theater["frames_unknown"] == 1
    assert theater["issues"]
    assert not theater["frames"][0].get("baseline_fallback", False)


def test_declared_but_missing_baseline_page_does_not_borrow(caches: tuple[Path, Path]) -> None:
    farm, base = caches
    add_snow(caches)
    (base / "_library/snow/hd.png").unlink()
    report = coverage.scan(farm, base, theaters=["snow"])
    row = next(row for row in report["rows"] if row["code"] == "E1")
    theater = row["theaters"]["snow"]
    assert row["status"] == "未完成"
    assert theater["frames_total"] == 1
    assert theater["issues"]
    assert not theater["frames"][0].get("baseline_fallback", False)


def test_baseline_borrow_ignores_rgb_under_zero_alpha(caches: tuple[Path, Path]) -> None:
    farm, base = caches
    source_path = base / "_library/urban/original.png"
    with Image.open(source_path) as source:
        original = source.copy()
    original.putpixel((0, 0), (25, 45, 230, 0))
    original.save(source_path)
    add_snow(caches)
    remove_snow_baseline_hd(base)
    snow_path = farm / "_library/snow/original.png"
    snow_path.unlink()
    original.putpixel((0, 0), (0, 0, 0, 0))
    original.save(snow_path)
    report = coverage.scan(farm, base, theaters=["snow"])
    row = next(row for row in report["rows"] if row["code"] == "E1")
    assert row["status"] == "已完成"
    assert row["theaters"]["snow"]["frames"][0]["baseline_fallback"] is True


def test_missing_current_hd_preserves_known_nonempty_frame_totals(caches: tuple[Path, Path]) -> None:
    farm, base = caches
    add_snow(caches)
    path = farm / "_library/snow/library.json"
    library = json.loads(path.read_text())
    del library["spriteAtlasesHd"]
    write_json(path, library)
    report = coverage.scan(farm, base, theaters=["snow"])
    row = next(row for row in report["rows"] if row["code"] == "E1")
    theater = row["theaters"]["snow"]
    assert row["status"] == "未完成"
    assert theater["frames_total"] == 1
    assert theater["frames_redrawn"] == 0
    assert theater["frames_unknown"] == 1
    assert theater["issues"]


def test_indexed_baseline_borrow_excludes_changed_palette_pixels(caches: tuple[Path, Path]) -> None:
    farm, base = caches
    urban = base / "_library/urban"
    with Image.open(urban / "original.png") as source:
        rgba = np.asarray(source).copy()
    indices = np.where(rgba[:, :, 0] == 190, 40, 41).astype(np.uint8)
    indices[rgba[:, :, 3] == 0] = 0
    indices[rgba[:, :, :3].max(axis=2) <= 24] = 12
    indices[rgba[:, :, 3] == 0] = 0
    indices[0, 0] = 254
    Image.fromarray(indices).save(urban / "original.png")
    palette = np.zeros((1, 256, 3), dtype=np.uint8)
    palette[0, 12], palette[0, 40], palette[0, 41] = [2, 2, 2], [190, 70, 45], [65, 155, 205]
    palette[0, 254] = palette[0, 40]
    Image.fromarray(palette).save(urban / "palette.png")
    (farm / "_library/urban/palette.png").symlink_to(urban / "palette.png")
    library = json.loads((urban / "library.json").read_text())
    library["palettes"] = {"unit": "palette.png"}
    for sprite in library["sprites"].values():
        sprite["palette"] = "unit"
    write_json(urban / "library.json", library)
    add_snow(caches)
    palette[0, 254] = [70, 90, 240]
    for root in (farm, base):
        Image.fromarray(palette).save(root / "_library/snow/palette.png")
    remove_snow_baseline_hd(base)
    report = coverage.scan(farm, base, theaters=["snow"])
    row = next(row for row in report["rows"] if row["code"] == "E1")
    theater = row["theaters"]["snow"]
    assert row["status"] == "已完成"
    assert theater["frames_unknown"] == 0
    assert theater["frames"][0]["baseline_fallback"] is True
    assert theater["frames"][0]["baseline_palette_pixels_excluded"] == 1
