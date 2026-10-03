"""Asset-free scenario-map contracts, using only invented maps and archives.

Run with ``python3 -m pytest packages/ra2-assets/python/test_scenario_map.py``.
No test reads an installation, launches a game, or uses a network service.
"""

from __future__ import annotations

import copy
import json
from pathlib import Path
import struct
import subprocess
import sys
import zlib

import pytest

import scenario_map as sm
from scenario_mix import Blowfish, MixArchive, MixError, mix_id, westwood_key, write_mix


def synthetic_map() -> bytes:
    return (
        "; Invented fixture, including an opaque byte: \xe9\r\n"
        "[Basic]\r\nName=Original fixture\r\nMultiplayerOnly=yes\r\n\r\n"
        "[Map]\r\nSize=0,0,40,40\r\nLocalSize=1,1,38,38\r\n\r\n"
        "[Houses]\r\n0=Neutral\r\n1=Special\r\n\r\n"
        "[Neutral]\r\nCountry=Neutral\r\n\r\n"
        "[Special]\r\nCountry=Special\r\n\r\n"
        "[Waypoints]\r\n0=30030\r\n1=40040\r\n\r\n"
        "[Infantry]\r\n"
        "7=Neutral,CIVILIAN,256,34,32,2,Guard,0,None,0,-1,0,1,0\r\n"
        "; Preserve this inline position.\r\n\r\n"
        "[Units]\r\n"
        "4=Neutral,VEHICLE,256,38,37,0,Guard,None,0,-1,0,-1,1,0\r\n\r\n"
        "[Aircraft]\r\n"
        "9=Special,PLANE,256,32,37,0,Guard,None,0,-1,1,0\r\n\r\n"
        "[Unrelated]\r\nMixedCase = Keep this spacing ; and comment\r\n"
    ).encode("latin-1")


def synthetic_pkt() -> bytes:
    return (
        "; Invented packet\r\n[MultiMaps]\r\n1=BASE\r\n2=OTHER\r\n\r\n"
        "[BASE]\r\nDescription=Original fixture\r\nMinPlayers=2\r\n"
        "MaxPlayers=4\r\nGameMode=standard\r\nCustomToken=unchanged\r\n\r\n"
        "[OTHER]\r\nDescription=Other fixture\r\nMinPlayers=2\r\nMaxPlayers=2\r\n"
    ).encode("ascii")


def spec(**object_overrides: object) -> dict:
    obj = {
        "house": "<Player @ A>",
        "kind": "infantry",
        "type": "SYNTH",
        "at": {"waypoint": 0, "dx": 4, "dy": 2},
        "facing": 64,
        "mission": "Area Guard",
    }
    obj.update(object_overrides)
    return {"base": "BASE", "name": "DEMO", "objects": [obj]}


def objects(data: bytes, section: str) -> dict[int, list[str]]:
    return {
        int(key): value.split(",")
        for key, value in sm.IniDocument(data).items(section)
        if key.isdecimal()
    }


def nested_install(root: Path) -> Path:
    root.mkdir()
    package = write_mix([("BASE.map", synthetic_map()), ("BASE.pkt", synthetic_pkt())])
    inner = write_mix([("BASE.yro", package), ("opaque.dat", b"not a MIX or map")])
    (root / "expandmd01.mix").write_bytes(write_mix([("maps01.mix", inner)]))
    return root


def encrypted_fixture(files: list[tuple[str, bytes]]) -> bytes:
    plain = write_mix(files)
    count = struct.unpack_from("<H", plain, 4)[0]
    body_start = 10 + count * 12
    header = plain[4:body_start]
    header += bytes((-len(header)) % 8)
    key_source = bytes(80)
    return (struct.pack("<I", 0x20000) + key_source
            + Blowfish(westwood_key(key_source)).encipher(header) + plain[body_start:])


@pytest.mark.parametrize(
    ("name", "expected"),
    [("localmd.mix", 0xFBE0D09D), ("local mix database.dat", 0x366E051F),
     ("XMP29U2.MAP", 0x02150215), ("MISSIONSMD.PKT", 0x480B82E4),
     ("RiverRam.pkt", 0xB26B295B)],
)
def test_filename_hash_known_install_index_vectors(name: str, expected: int):
    # The independent TS format tests pin these against a real ra2md.mix index.
    assert mix_id(name) == expected
    assert mix_id(name.upper()) == expected


@pytest.mark.parametrize(
    ("name", "padded"),
    [
        ("abc", b"ABC\x03"),
        ("abcde", b"ABCDE\x01EE"),
        ("abcdef", b"ABCDEF\x02E"),
        ("test.ini", b"TEST.INI"),
    ],
)
def test_filename_hash_classic_padding(name: str, padded: bytes):
    assert mix_id(name) == zlib.crc32(padded)
    assert mix_id("dir/file.shp") == mix_id("DIR\\FILE.SHP")


def test_mix_round_trip_header_index_and_empty_member():
    members = [("z.dat", b"last\0"), ("empty.dat", b""), ("a.dat", b"first")]
    data = write_mix(members)
    assert struct.unpack_from("<IHI", data) == (0, 3, 10)
    archive = MixArchive(data)
    assert not archive.encrypted
    assert not archive.checksum
    assert len(archive.entries) == 3
    for name, payload in members:
        assert archive.read(name.upper()) == payload
        assert archive.read_id(mix_id(name)) == payload
        entry = next(entry for entry in archive.entries if entry.id == mix_id(name))
        assert bytes(archive.data(entry)) == payload
        assert data[entry.offset:entry.offset + entry.size] == payload
        assert entry.offset >= 10 + 12 * len(members)
    assert archive.read("missing.dat") is None


def test_mix_legacy_unencrypted_header():
    payload = b"legacy body"
    data = struct.pack("<HIIII", 1, len(payload), mix_id("test.ini"), 0, len(payload)) + payload
    assert MixArchive(data).read("test.ini") == payload


def test_mix_index_uses_stock_signed_hash_order():
    data = write_mix([("RiverRam.map", b"map"), ("RiverRam.pkt", b"packet")])
    assert [entry.id for entry in MixArchive(data).entries] == [0xB26B295B, 0x5B1735EB]


def test_blowfish_standard_known_vector_and_westwood_zero_key_source():
    cipher = Blowfish(bytes(8))
    ciphertext = bytes.fromhex("4ef997456198dd78")
    assert cipher.encipher(bytes(8)) == ciphertext
    assert cipher.decipher(ciphertext) == bytes(8)
    assert westwood_key(bytes(80)) == bytes(56)


@pytest.mark.parametrize("count", [1, 2, 3])
def test_encrypted_mix_header_index_padding_and_plain_body(count: int):
    members = [(f"member{i}.dat", bytes([i]) * (i + 5)) for i in range(count)]
    archive = MixArchive(encrypted_fixture(members))
    assert archive.encrypted
    assert len(archive.entries) == count
    for name, payload in members:
        assert archive.read(name) == payload


@pytest.mark.parametrize("bad", [b"", b"\0", b"\0" * 5, b"\0\0\2\0"])
def test_mix_reports_truncated_or_encrypted_header(bad: bytes):
    with pytest.raises(MixError):
        MixArchive(bad)


def test_mix_rejects_member_outside_body_and_incomplete_body():
    good = write_mix([("sample.dat", b"sample")])
    bad = bytearray(good)
    struct.pack_into("<I", bad, 14, 1000)
    with pytest.raises(MixError):
        MixArchive(bad)
    with pytest.raises(MixError):
        MixArchive(good[:-1])


def test_mix_writer_rejects_duplicate_case_insensitive_member():
    with pytest.raises(MixError):
        write_mix([("same.map", b"one"), ("SAME.MAP", b"two")])


def test_ini_append_preserves_original_bytes_order_and_sparse_keys():
    original = synthetic_map()
    document = sm.IniDocument(original)
    addition = "<Player @ H>,NEW,256,35,32,3,Guard,0,None,0,-1,0,1,0"
    edited = document.append_entries("Infantry", [addition])
    added_line = b"8=" + addition.encode("ascii") + b"\r\n"
    assert edited.count(added_line) == 1
    assert edited.replace(added_line, b"", 1) == original
    assert document.items("Infantry") == [("7", "Neutral,CIVILIAN,256,34,32,2,Guard,0,None,0,-1,0,1,0")]
    assert sm.IniDocument(edited).section_bytes("Unrelated") == document.section_bytes("Unrelated")


def test_ini_append_missing_section_handles_no_final_newline():
    original = b"; synthetic\n[Basic]\nName=keep"
    edited = sm.IniDocument(original).append_entries("Aircraft", ["entry"])
    assert edited.startswith(original)
    assert sm.IniDocument(edited).items("Aircraft") == [("0", "entry")]
    assert sm.IniDocument(edited).items("Basic") == [("Name", "keep")]


def test_edit_all_three_sections_exact_field_layouts():
    specification = spec(strength=128, veterancy=2, group=7, on_bridge=1,
                         autocreate_no_recruitable=0, autocreate_yes_recruitable=1)
    specification["objects"].extend([
        {"house": "<Player @ B>", "kind": "unit", "type": "TANK",
         "at": {"x": 40, "y": 35}, "facing": 128, "mission": "Sleep",
         "strength": 200, "veterancy": 1, "group": -1, "on_bridge": 1,
         "follows_index": -1, "autocreate_no_recruitable": 0, "autocreate_yes_recruitable": 1},
        {"house": "Neutral", "kind": "aircraft", "type": "AIR",
         "at": {"x": 44, "y": 35}, "facing": 255, "mission": "Guard"},
    ])
    edited, placements = sm.edit_map(synthetic_map(), specification)
    assert objects(edited, "Infantry")[8] == [
        "<human player>", "SYNTH", "128", "34", "32", "3", "Area Guard", "64",
        "None", "2", "7", "1", "0", "1",
    ]
    assert objects(edited, "Units")[5] == [
        "Computer", "TANK", "200", "40", "35", "128", "Sleep", "None",
        "1", "-1", "1", "-1", "0", "1",
    ]
    assert objects(edited, "Aircraft")[10] == [
        "Neutral", "AIR", "256", "44", "35", "255", "Guard", "None",
        "0", "-1", "1", "0",
    ]
    assert len(placements) == 3
    assert placements[0]["x"] == 34 and placements[0]["y"] == 32
    assert placements[0]["sub_cell"] == 3
    assert placements[0]["house"] == "<Player @ A>"
    assert placements[0]["map_house"] == "<human player>"
    assert placements[1]["house"] == "<Player @ B>"
    assert placements[1]["map_house"] == "Computer"
    before = sm.IniDocument(synthetic_map())
    after = sm.IniDocument(edited)
    for section in ("Basic", "Map", "Houses", "Neutral", "Special", "Waypoints", "Unrelated"):
        assert before.section_bytes(section) == after.section_bytes(section)


def test_count_fills_free_subcells_then_neighbours_without_collisions():
    specification = spec(count=5)
    specification["objects"].append({
        "house": "<Player @ A>", "kind": "infantry", "type": "SECOND",
        "at": {"x": 34, "y": 32}, "count": 2,
    })
    edited, placements = sm.edit_map(synthetic_map(), specification)
    used = {(34, 32, 2)}
    for row in placements:
        cell = (row["x"], row["y"], row["sub_cell"])
        assert cell not in used
        assert cell[2] in (2, 3, 4)
        used.add(cell)
    assert {(row["x"], row["y"], row["sub_cell"]) for row in placements[:2]} == {
        (34, 32, 3), (34, 32, 4),
    }
    assert len(placements) == 7
    assert len(objects(edited, "Infantry")) == 8
    assert sm.edit_map(synthetic_map(), specification) == (edited, placements)


def test_vehicle_count_uses_separate_cells_and_avoids_existing_vehicle():
    specification = spec(kind="unit", type="TANK", count=3, at={"x": 38, "y": 37})
    _, placements = sm.edit_map(synthetic_map(), specification)
    cells = [(row["x"], row["y"]) for row in placements]
    assert len(set(cells)) == 3
    assert (38, 37) not in cells


@pytest.mark.parametrize(
    ("key", "value"),
    [
        ("kind", "building"), ("type", "X,Y"), ("type", "X\n[Units]"),
        ("house", "<Player @ I>"), ("house", "Neutral,Enemy"),
        ("strength", -1), ("strength", 257), ("strength", True),
        ("facing", -1), ("facing", 256), ("count", 0), ("count", -1),
        ("count", 1.5), ("mission", "Made Up"), ("sub_cell", 1),
        ("autocreate_yes_recruitable", 2), ("unexpected", 1),
        ("at", {}), ("at", {"x": 34}), ("at", {"x": 34, "y": "32"}),
        ("at", {"waypoint": 0, "x": 34, "y": 32}),
        ("at", {"x": 34, "y": 32, "dx": 1}),
    ],
)
def test_spec_rejects_invalid_object_fields(key: str, value: object):
    with pytest.raises(sm.ScenarioError):
        sm.validate_spec(spec(**{key: value}))


@pytest.mark.parametrize(
    ("key", "value"),
    [("name", "../escape"), ("name", "TOO.LONG.MAP"), ("name", ""),
     ("base", ""), ("objects", "not a list"), ("unexpected", 1)],
)
def test_spec_rejects_invalid_top_level_fields(key: str, value: object):
    specification = spec()
    specification[key] = value
    with pytest.raises(sm.ScenarioError):
        sm.validate_spec(specification)


def test_spec_validation_does_not_mutate_input():
    original = spec()
    saved = copy.deepcopy(original)
    validated = sm.validate_spec(original)
    assert original == saved
    assert validated["name"] == "DEMO"


def test_edit_reports_missing_waypoint_and_undeclared_house():
    with pytest.raises(sm.ScenarioError, match="(?i)waypoint"):
        sm.edit_map(synthetic_map(), spec(at={"waypoint": 19}))
    with pytest.raises(sm.ScenarioError, match="(?i)house"):
        sm.edit_map(synthetic_map(), spec(house="Undeclared"))


def test_edit_reports_outside_rhombus_without_silently_relocating_request():
    with pytest.raises(sm.ScenarioError, match="(?i)outside"):
        sm.edit_map(synthetic_map(), spec(at={"x": 1, "y": 1}))


@pytest.mark.parametrize("letter", "CDEFGH")
def test_distinct_additional_player_ownership_is_reported_not_fabricated(letter: str):
    with pytest.raises(sm.ScenarioError):
        sm.edit_map(synthetic_map(), spec(house=f"<Player @ {letter}>"))


def test_packet_contains_only_new_entry_and_copies_metadata():
    edited = sm.make_pkt(synthetic_pkt(), "BASE", "DEMO", "New description")
    document = sm.IniDocument(edited)
    assert document.items("MultiMaps") == [("1", "DEMO")]
    assert dict(document.items("DEMO")) == {
        "Description": "New description", "MinPlayers": "2", "MaxPlayers": "4",
        "GameMode": "standard", "CustomToken": "unchanged",
    }
    assert not document.items("BASE")
    assert not document.items("OTHER")


def test_nested_lookup_finds_map_without_filename_database(tmp_path: Path):
    game = nested_install(tmp_path / "game")
    with sm.GameCatalog(game) as catalog:
        source = catalog.find("BASE")
        assert source.name == "BASE"
        assert source.map_bytes == synthetic_map()
        assert source.pkt_bytes == synthetic_pkt()
        assert mix_id(source.map_filename) == mix_id("BASE.map")
        assert mix_id(source.pkt_filename) == mix_id("BASE.pkt")
        assert "expandmd01.mix" in source.container
        assert [entry.name for entry in catalog.maps()] == ["BASE"]
        with pytest.raises(sm.ScenarioError):
            catalog.find("MISSING")


def test_nested_lookup_through_encrypted_archive(tmp_path: Path):
    game = tmp_path / "game"
    game.mkdir()
    package = encrypted_fixture([("BASE.map", synthetic_map()), ("BASE.pkt", synthetic_pkt())])
    (game / "multimd.mix").write_bytes(encrypted_fixture([("BASE.yro", package)]))
    with sm.GameCatalog(game) as catalog:
        source = catalog.find("BASE")
        assert source.map_bytes == synthetic_map()
        assert source.pkt_bytes == synthetic_pkt()


def test_catalog_reports_malformed_root_without_mmap_buffer_error(tmp_path: Path):
    game = tmp_path / "game"
    game.mkdir()
    (game / "broken.mix").write_bytes(write_mix([("member.dat", b"content")])[:-1])
    with sm.GameCatalog(game) as catalog:
        assert catalog.maps() == []
        assert any("broken.mix" in warning for warning in catalog.warnings)
        with pytest.raises(sm.ScenarioError, match="broken.mix"):
            catalog.find("BASE")


def test_catalog_reports_excessive_nesting_without_mmap_buffer_error(tmp_path: Path):
    game = tmp_path / "game"
    game.mkdir()
    archive = write_mix([("BASE.map", synthetic_map()), ("BASE.pkt", synthetic_pkt())])
    for level in range(20):
        archive = write_mix([(f"layer{level}.mix", archive)])
    (game / "too-deep.mix").write_bytes(archive)
    with sm.GameCatalog(game) as catalog:
        with pytest.raises(sm.ScenarioError, match="(?i)depth|nested|traversal"):
            catalog.find("BASE")


def test_catalog_rejects_conflicting_packets_for_shared_map(tmp_path: Path):
    game = tmp_path / "game"
    game.mkdir()
    (game / "maps01.mix").write_bytes(write_mix([("BASE.map", synthetic_map())]))
    for name, description in (("first.mix", b"First packet"), ("second.mix", b"Second packet")):
        packet = synthetic_pkt().replace(b"Original fixture", description)
        (game / name).write_bytes(write_mix([("BASE.pkt", packet)]))
    with sm.GameCatalog(game) as catalog:
        with pytest.raises(sm.ScenarioError, match="(?i)ambiguous"):
            catalog.find("BASE")


def test_build_refuses_game_directory_as_output_before_writing(tmp_path: Path):
    game = nested_install(tmp_path / "game")
    before = {path.name: path.read_bytes() for path in game.iterdir()}
    with pytest.raises(sm.ScenarioError, match="(?i)outside|read.only"):
        sm.build(game, spec(), game / "new-folder")
    assert {path.name: path.read_bytes() for path in game.iterdir()} == before


@pytest.mark.parametrize("suffix", ["map", "yro"])
def test_build_preserves_existing_output_and_writes_no_partial_pair(tmp_path: Path, suffix: str):
    game = nested_install(tmp_path / "game")
    out = tmp_path / "out"
    out.mkdir()
    existing = out / f"DEMO.{suffix}"
    existing.write_bytes(b"Do not overwrite this file.")
    with pytest.raises((sm.ScenarioError, FileExistsError)):
        sm.build(game, spec(), out)
    assert {path.name: path.read_bytes() for path in out.iterdir()} == {
        existing.name: b"Do not overwrite this file.",
    }


def test_build_removes_new_outputs_when_second_write_fails(tmp_path: Path, monkeypatch):
    game = nested_install(tmp_path / "game")
    out = tmp_path / "out"
    original_open = Path.open

    class FailingMapWrite:
        def __init__(self, path, args, kwargs):
            self.path, self.args, self.kwargs = path, args, kwargs

        def __enter__(self):
            self.stream = original_open(self.path, *self.args, **self.kwargs)
            return self

        def write(self, data):
            self.stream.write(data[:7])
            raise OSError("synthetic partial map-write failure")

        def __exit__(self, *args):
            self.stream.close()

    def injected_open(path, *args, **kwargs):
        mode = args[0] if args else kwargs.get("mode", "r")
        if path == out / "DEMO.map" and ("x" in mode or "w" in mode):
            return FailingMapWrite(path, args, kwargs)
        return original_open(path, *args, **kwargs)

    monkeypatch.setattr(Path, "open", injected_open)
    with pytest.raises(OSError, match="synthetic partial map-write failure"):
        sm.build(game, spec(), out)
    assert not out.exists() or list(out.iterdir()) == []


def test_cli_build_and_ls_are_asset_free_and_leave_install_unchanged(tmp_path: Path):
    game = nested_install(tmp_path / "game")
    archive_path = game / "expandmd01.mix"
    original_archive = archive_path.read_bytes()
    specification = tmp_path / "spec.json"
    specification.write_text(json.dumps(spec(count=2)), encoding="utf-8")
    out = tmp_path / "out"
    script = str(Path(sm.__file__).resolve())
    listed = subprocess.run([sys.executable, script, "ls", "--game", str(game), "--find", "BASE"],
                            capture_output=True, text=True, check=False)
    assert listed.returncode == 0, listed.stderr
    assert "BASE" in listed.stdout and "expandmd01.mix" in listed.stdout
    built = subprocess.run([sys.executable, script, "build", "--game", str(game),
                            "--spec", str(specification), "--out", str(out)],
                           capture_output=True, text=True, check=False)
    assert built.returncode == 0, built.stderr
    assert archive_path.read_bytes() == original_archive
    assert set(path.name for path in game.iterdir()) == {"expandmd01.mix"}
    edited_map = (out / "DEMO.map").read_bytes()
    archive = MixArchive((out / "DEMO.yro").read_bytes())
    assert archive.read("DEMO.map") == edited_map
    assert len(archive.entries) == 2
    assert len(objects(edited_map, "Infantry")) == 3
    with sm.GameCatalog(out) as catalog:
        new = catalog.find("DEMO")
        assert sm.IniDocument(new.pkt_bytes).items("MultiMaps") == [("1", "DEMO")]
        assert dict(sm.IniDocument(new.pkt_bytes).items("DEMO"))["Description"] != "Original fixture"
