"""Build additive YR test scenarios from player-owned MIX archives (stdlib only).

Format evidence and the JSON contract are in ../README.md, Scenario maps.
No game rules, executable, launch settings or original map bytes are rewritten.
"""
from __future__ import annotations

import argparse
from dataclasses import dataclass
import json
import mmap
from pathlib import Path
import re
import struct
import sys
from typing import Iterator

from scenario_mix import MixArchive, MixError, mix_id, write_mix


class ScenarioError(ValueError):
    """An invalid or ambiguous scenario input."""


SECTION = re.compile(rb"^[ \t]*\[([^\]\r\n]+)\][ \t]*(?:;[^\r\n]*)?(?:\r\n|\n|\r)?$")
KINDS = {"infantry": "Infantry", "unit": "Units", "aircraft": "Aircraft"}
MISSIONS = (
    "Sleep", "Attack", "Move", "QMove", "Retreat", "Guard", "Sticky", "Enter",
    "Capture", "Eaten", "Harvest", "Area Guard", "Return", "Stop", "Ambush",
    "Hunt", "Unload", "Sabotage", "Construction", "Selling", "Repair", "Rescue",
    "Missile", "Harmless", "Open", "Patrol", "Paradrop Approach", "Paradrop Overfly",
    "Wait", "Attack Move", "Spyplane Approach", "Spyplane Overfly",
)
PLAYER_HOUSES = {f"<Player @ {letter}>" for letter in "ABCDEFGH"}


class IniDocument:
    """Read INI structure without normalizing bytes, comments, case or line order."""

    def __init__(self, data: bytes):
        self.raw = data
        self.lines = data.splitlines(keepends=True)
        self.newline = next((m.group() for m in re.finditer(rb"\r\n|\n|\r", data)), b"\r\n")
        self.sections: dict[str, tuple[int, int]] = {}
        previous = None
        for index, line in enumerate(self.lines):
            match = SECTION.fullmatch(line)
            if not match:
                continue
            name = match[1].decode("latin1").strip().casefold()
            if name in self.sections:
                raise ScenarioError(f"duplicate INI section [{name}]")
            if previous is not None:
                start, _ = self.sections[previous]
                self.sections[previous] = (start, index)
            self.sections[name] = (index, len(self.lines))
            previous = name

    def items(self, section: str) -> list[tuple[str, str]]:
        bounds = self.sections.get(section.casefold())
        if bounds is None:
            return []
        result = []
        for line in self.lines[bounds[0] + 1:bounds[1]]:
            stripped = line.decode("latin1").strip()
            if not stripped or stripped.startswith(";") or "=" not in stripped:
                continue
            key, value = stripped.split("=", 1)
            result.append((key.strip(), value.split(";", 1)[0].strip()))
        return result

    def section_bytes(self, section: str) -> bytes:
        bounds = self.sections.get(section.casefold())
        return b"" if bounds is None else b"".join(self.lines[bounds[0]:bounds[1]])

    def append_entries(self, section: str, values: list[str]) -> bytes:
        if not values:
            return self.raw
        keys = [key for key, _ in self.items(section)]
        if any(not key.isdecimal() for key in keys):
            raise ScenarioError(f"[{section}] contains a non-numbered object key")
        if len(set(int(key) for key in keys)) != len(keys):
            raise ScenarioError(f"[{section}] contains duplicate object numbers")
        next_key = max((int(key) for key in keys), default=-1) + 1
        addition = b"".join(f"{next_key + i}={value}".encode("ascii") + self.newline
                            for i, value in enumerate(values))
        bounds = self.sections.get(section.casefold())
        if bounds is None:
            prefix = self.raw + (self.newline if self.raw and not self.raw.endswith((b"\r", b"\n")) else b"")
            return prefix + f"[{section}]".encode("ascii") + self.newline + addition
        before = b"".join(self.lines[:bounds[1]])
        if before and not before.endswith((b"\r", b"\n")):
            before += self.newline
        return before + addition + b"".join(self.lines[bounds[1]:])


def _integer(value, label: str, low: int, high: int) -> int:
    if type(value) is not int or not low <= value <= high:
        raise ScenarioError(f"{label} must be an integer in {low}..{high}")
    return value


def _token(value, label: str) -> str:
    if not isinstance(value, str) or not value or not value.isascii() or any(c in value for c in ",;[]=") or any(ord(c) < 32 for c in value):
        raise ScenarioError(f"{label} must be a nonempty ASCII INI token")
    return value


def validate_spec(spec: dict) -> dict:
    if not isinstance(spec, dict) or set(spec) - {"base", "name", "description", "objects"}:
        raise ScenarioError("spec must contain base, name, objects and optional description only")
    if not {"base", "name", "objects"} <= spec.keys():
        raise ScenarioError("spec requires base, name and objects")
    base = _token(spec["base"], "base")
    if "/" in base or "\\" in base or base in {".", ".."}:
        raise ScenarioError("base must be a map name, not a path")
    name = spec["name"]
    if not isinstance(name, str) or not re.fullmatch(r"[A-Za-z][A-Za-z0-9_]{0,31}", name):
        raise ScenarioError("name must be 1..32 ASCII letters/digits/underscores, beginning with a letter")
    if not isinstance(spec["objects"], list) or not spec["objects"]:
        raise ScenarioError("objects must be a nonempty list")
    result = {"base": base, "name": name.upper(), "objects": []}
    result["description"] = _token(spec.get("description", name.upper()), "description")
    total = 0
    for index, obj in enumerate(spec["objects"]):
        label = f"objects[{index}]"
        common = {"house", "kind", "type", "at", "facing", "mission", "count", "strength", "veterancy", "group",
                  "autocreate_no_recruitable", "autocreate_yes_recruitable"}
        if not isinstance(obj, dict) or not {"house", "kind", "type", "at"} <= obj.keys():
            raise ScenarioError(f"{label} requires house, kind, type and at")
        kind = obj["kind"]
        if not isinstance(kind, str) or kind not in KINDS:
            raise ScenarioError(f"{label}.kind must be infantry, unit or aircraft")
        allowed = common | ({"sub_cell", "on_bridge"} if kind == "infantry" else {"on_bridge", "follows_index"} if kind == "unit" else set())
        if set(obj) - allowed:
            raise ScenarioError(f"{label} has unknown or inapplicable fields: {sorted(set(obj) - allowed)}")
        item = {"kind": kind, "house": _token(obj["house"], f"{label}.house"), "type": _token(obj["type"], f"{label}.type")}
        if item["house"].startswith("<Player") and item["house"] not in PLAYER_HOUSES:
            raise ScenarioError(f"{label}.house player slot must be <Player @ A> through <Player @ H>")
        for key, default, low, high in (("strength", 256, 0, 256), ("facing", 0, 0, 255),
                                      ("count", 1, 1, 10000), ("veterancy", 0, 0, 200), ("group", -1, -1, 9),
                                      ("autocreate_no_recruitable", 1, 0, 1), ("autocreate_yes_recruitable", 0, 0, 1)):
            item[key] = _integer(obj.get(key, default), f"{label}.{key}", low, high)
        if kind != "aircraft":
            item["on_bridge"] = _integer(obj.get("on_bridge", 0), f"{label}.on_bridge", 0, 1)
        if kind == "unit":
            item["follows_index"] = _integer(obj.get("follows_index", -1), f"{label}.follows_index", -1, 65535)
        if "sub_cell" in obj:
            item["sub_cell"] = _integer(obj["sub_cell"], f"{label}.sub_cell", 2, 4)
        mission = obj.get("mission", "Guard")
        if mission not in MISSIONS:
            raise ScenarioError(f"{label}.mission must be one of {', '.join(MISSIONS)}")
        item["mission"] = mission
        at = obj["at"]
        if not isinstance(at, dict):
            raise ScenarioError(f"{label}.at must be an object")
        if set(at) == {"x", "y"}:
            item["at"] = {key: _integer(at[key], f"{label}.at.{key}", 0, 511) for key in ("x", "y")}
        elif "waypoint" in at and not set(at) - {"waypoint", "dx", "dy"}:
            item["at"] = {"waypoint": _integer(at["waypoint"], f"{label}.at.waypoint", 0, 701)}
            item["at"].update({key: _integer(at.get(key, 0), f"{label}.at.{key}", -511, 511) for key in ("dx", "dy")})
        else:
            raise ScenarioError(f"{label}.at must be x/y OR waypoint with optional dx/dy")
        total += item["count"]
        result["objects"].append(item)
    if total > 10000:
        raise ScenarioError("at most 10000 objects may be added")
    return result


def _cells_near(x: int, y: int) -> Iterator[tuple[int, int]]:
    yield x, y
    for radius in range(1, 512):
        for dy in range(-radius, radius + 1):
            columns = range(-radius, radius + 1) if abs(dy) == radius else (-radius, radius)
            for dx in columns:
                yield x + dx, y + dy


def edit_map(data: bytes, spec: dict) -> tuple[bytes, list[dict]]:
    spec = validate_spec(spec)
    doc = IniDocument(data)
    houses = {value for _, value in doc.items("Houses")} | {value for _, value in doc.items("Countries")}
    blocked: set[tuple[int, int]] = set()
    infantry: dict[tuple[int, int], set[int]] = {}
    for section in ("Infantry", "Units", "Aircraft", "Structures"):
        for key, value in doc.items(section):
            fields = value.split(",")
            try:
                cell = int(fields[3]), int(fields[4])
                houses.add(fields[0])
                if section == "Infantry":
                    infantry.setdefault(cell, set()).add(int(fields[5]))
                else:
                    blocked.add(cell)
            except (IndexError, ValueError) as error:
                raise ScenarioError(f"malformed existing [{section}] entry {key}") from error
    for key, _ in doc.items("Terrain"):
        try:
            packed = int(key)
            blocked.add((packed % 1000, packed // 1000))
        except ValueError as error:
            raise ScenarioError(f"invalid [Terrain] cell {key}") from error
    size_text = dict((k.casefold(), v) for k, v in doc.items("Map")).get("size")
    try:
        origin_x, origin_y, width, height = map(int, size_text.split(","))
        if origin_x or origin_y or not (0 < width <= 256 and 0 < height <= 256):
            raise ValueError()
    except (ValueError, AttributeError) as error:
        raise ScenarioError("[Map] Size must be 0,0,width,height with dimensions 1..256") from error

    def inside(x, y):
        # Same isometric rhombus as src/iso.ts mapSizeCells; not LocalSize's screen rectangle.
        return (0 <= x < 512 and 0 <= y < 512 and 0 <= x-y+width-1 <= 2*width-2
                and 0 <= x+y-width-1 < 2*height)

    values: dict[str, list[str]] = {section: [] for section in KINDS.values()}
    placements = []
    waypoints = dict(doc.items("Waypoints"))
    for obj in spec["objects"]:
        if obj["house"] not in houses | PLAYER_HOUSES:
            raise ScenarioError(f"house {obj['house']!r} is neither a player slot nor a house declared/used by the map; known: {sorted(houses)}")
        # YR object ReadINI calls 0x50C170 (exact house name), not the trigger
        # player-token decoder 0x510FB0. Normal skirmish names are assigned at
        # 0x68804A / 0x688210. Only one human plus one AI is unambiguous.
        if obj["house"] in PLAYER_HOUSES - {"<Player @ A>", "<Player @ B>"}:
            raise ScenarioError("preplaced skirmish ownership supports A (human) and B (one AI) only; original YR names all AI houses Computer")
        map_house = {"<Player @ A>": "<human player>", "<Player @ B>": "Computer"}.get(obj["house"], obj["house"])
        at = obj["at"]
        if "waypoint" in at:
            try:
                packed = int(waypoints[str(at["waypoint"])])
            except (KeyError, ValueError) as error:
                raise ScenarioError(f"missing/invalid waypoint {at['waypoint']}") from error
            x, y = packed % 1000 + at["dx"], packed // 1000 + at["dy"]
        else:
            x, y = at["x"], at["y"]
        if not inside(x, y):
            raise ScenarioError(f"requested cell ({x},{y}) is outside [Map] Size")
        kind = obj["kind"]
        section = KINDS[kind]
        existing = doc.items(section)
        try:
            next_index = max((int(key) for key, _ in existing), default=-1) + 1
        except ValueError as error:
            raise ScenarioError(f"[{section}] has a non-numbered key") from error
        candidates = _cells_near(x, y)
        remaining = obj["count"]
        for cx, cy in candidates:
            if not inside(cx, cy) or (cx, cy) in blocked:
                continue
            if kind == "infantry":
                occupied = infantry.setdefault((cx, cy), set())
                # Reserved/legacy positions cannot safely share a cell with the three YR ground slots.
                if occupied - {2, 3, 4}:
                    continue
                slots = [obj["sub_cell"]] if "sub_cell" in obj else [2, 3, 4]
                available = [slot for slot in slots if slot not in occupied]
            else:
                available = [] if infantry.get((cx, cy)) else [None]
            for slot in available:
                common = [map_house, obj["type"], obj["strength"], cx, cy]
                tail = ["None", obj["veterancy"], obj["group"]]
                flags = [obj["autocreate_no_recruitable"], obj["autocreate_yes_recruitable"]]
                if kind == "infantry":
                    fields = common + [slot, obj["mission"], obj["facing"]] + tail + [obj["on_bridge"]] + flags
                    infantry[(cx, cy)].add(slot)
                else:
                    fields = common + [obj["facing"], obj["mission"]] + tail
                    if kind == "unit":
                        fields += [obj["on_bridge"], obj["follows_index"]]
                    fields += flags
                    blocked.add((cx, cy))
                record = {"kind": kind, "type": obj["type"], "house": obj["house"], "x": cx, "y": cy,
                          "map_house": map_house, "index": next_index + len(values[section])}
                if slot is not None:
                    record["sub_cell"] = slot
                placements.append(record)
                values[section].append(",".join(map(str, fields)))
                remaining -= 1
                if not remaining:
                    break
            if not remaining:
                break
        if remaining:
            raise ScenarioError(f"not enough unoccupied cells for {obj['type']}")
    edited = data
    for section, additions in values.items():
        edited = IniDocument(edited).append_entries(section, additions)
    return edited, placements


def make_pkt(pkt_bytes: bytes, base: str, new_name: str, description: str | None = None) -> bytes:
    doc = IniDocument(pkt_bytes)
    block = doc.section_bytes(base)
    if not block:
        raise ScenarioError(f"packet has no [{base}] description block")
    lines = block.splitlines(keepends=True)
    lines[0] = f"[{new_name}]".encode("ascii") + doc.newline
    changed = False
    for index, line in enumerate(lines[1:], 1):
        match = re.match(rb"([ \t]*Description[ \t]*=[ \t]*)([^\r\n]*)(\r\n|\n|\r)?$", line, re.I)
        if match:
            lines[index] = match[1] + _token(description or new_name, "description").encode("ascii") + (match[3] or doc.newline)
            changed = True
    if not changed:
        if not lines[-1].endswith((b"\r", b"\n")):
            lines[-1] += doc.newline
        lines.append(f"Description={description or new_name}".encode("ascii") + doc.newline)
    return b"[MultiMaps]" + doc.newline + f"1={new_name}".encode("ascii") + doc.newline * 2 + b"".join(lines)


@dataclass(frozen=True)
class MapSource:
    name: str
    container: str
    map_filename: str
    pkt_filename: str
    map_bytes: bytes
    pkt_bytes: bytes
    pkt_container: str = ""


class GameCatalog:
    """Discover maps by packet contents, including unknown hash-only nested MIXes.

    Mapping each root read-only avoids copying large movie/audio archives. Only
    map and packet bytes survive traversal; no borrowed mmap views escape it.
    """

    def __init__(self, game: Path):
        self.game = Path(game)
        self.warnings: list[str] = []
        self._maps: list[MapSource] | None = None

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def maps(self) -> list[MapSource]:
        if self._maps is not None:
            return self._maps
        if not self.game.is_dir():
            raise ScenarioError(f"game directory does not exist: {self.game}")
        roots = sorted((p for p in self.game.iterdir() if p.is_file() and p.suffix.lower() in {".mix", ".yro", ".mmx"}), key=lambda p: p.name.casefold())
        known = {mix_id(p.name): p.name for p in roots}
        for name in ["multimd.mix", "multi.mix", "maps01.mix", "maps02.mix", "maps03.mix", "mapsmd03.mix", "local.mix", "localmd.mix", "cache.mix", "cachemd.mix"]:
            known[mix_id(name)] = name
        packets: list[tuple[str, int, bytes, dict[int, bytes]]] = []
        maps: dict[int, list[tuple[str, bytes]]] = {}
        visited = 0

        def scan(data, path, depth):
            nonlocal visited
            if depth > 16 or visited > 4096:
                raise ScenarioError("nested MIX traversal limit exceeded")
            archive = MixArchive(data)
            visited += 1
            local_maps = {}
            local_packets = []
            for entry in archive.entries:
                view = archive.data(entry)
                prefix = bytes(view[:1024])
                classic_candidate = False
                if entry.size >= 6:
                    count, body_size = struct.unpack_from("<HI", prefix)
                    classic_candidate = count > 0 and 6 + count * 12 + body_size == entry.size
                if classic_candidate or (entry.size >= 10 and prefix[:4] in (b"\0\0\0\0", b"\0\0\1\0", b"\0\0\2\0", b"\0\0\3\0")):
                    child = known.get(entry.id, f"id:{entry.id:08X}")
                    try:
                        scan(view, f"{path} > {child}", depth + 1)
                        continue
                    except MixError as error:
                        if entry.id in known:
                            self.warnings.append(f"{path} > {child}: {error}")
                # Map/packet text begins with ASCII INI syntax; binary art is not decoded.
                if entry.size <= 4 * 1024 * 1024 and b"[" in prefix and b"\0" not in prefix:
                    body = bytes(view)
                    if re.search(rb"(?im)^\s*\[MultiMaps\]\s*$", body):
                        local_packets.append((entry.id, body))
                    elif re.search(rb"(?im)^\s*\[Map\]\s*$", body):
                        local_maps[entry.id] = body
                        maps.setdefault(entry.id, []).append((path, body))
            packets.extend((path, entry_id, body, local_maps) for entry_id, body in local_packets)

        for root in roots:
            try:
                with root.open("rb") as source:
                    if not root.stat().st_size:
                        raise MixError("empty archive")
                    with mmap.mmap(source.fileno(), 0, access=mmap.ACCESS_READ) as data:
                        # Clear exception tracebacks before closing the mmap: a parser
                        # failure can otherwise keep an exported memoryview alive.
                        try:
                            scan(data, root.name, 0)
                        except (MixError, ScenarioError) as error:
                            self.warnings.append(f"{root.name}: {error}")
            except MixError as error:
                self.warnings.append(f"{root.name}: {error}")
        found = []
        for pkt_path, pkt_id, pkt, local_maps in packets:
            try:
                doc = IniDocument(pkt)
            except ScenarioError as error:
                self.warnings.append(f"{pkt_path}: {error}")
                continue
            pkt_names = ["missionsmd.pkt", "missions.pkt", Path(pkt_path.split(" > ")[-1]).stem + ".pkt"]
            pkt_names.extend(Path(name).stem + ".pkt" for _, name in doc.items("MultiMaps"))
            pkt_name = next((name for name in pkt_names if mix_id(name) == pkt_id), f"id:{pkt_id:08X}")
            for _, name in doc.items("MultiMaps"):
                if not doc.section_bytes(name):
                    continue
                for filename in ([name] if Path(name).suffix.lower() in {".map", ".mpr", ".yrm"} else [name + ext for ext in (".map", ".mpr", ".yrm")]):
                    entry_id = mix_id(filename)
                    matches = [(pkt_path, local_maps[entry_id])] if entry_id in local_maps else maps.get(entry_id, [])
                    for map_path, map_body in matches:
                        found.append(MapSource(name, map_path, filename, pkt_name, map_body, pkt, pkt_path))
                    if matches:
                        break
        self._maps = list({(item.name.casefold(), item.container, item.pkt_container, item.pkt_filename): item for item in found}.values())
        return self._maps

    def find(self, base: str) -> MapSource:
        needle = re.sub(r"\.(map|mpr|yrm)$", "", base, flags=re.I).casefold()
        matches = [item for item in self.maps() if re.sub(r"\.(map|mpr|yrm)$", "", item.name, flags=re.I).casefold() == needle]
        if not matches:
            detail = "; ".join(self.warnings)
            raise ScenarioError(f"map {base!r} not found in readable packet/map pairs" + (f"; archive errors: {detail}" if detail else ""))
        signatures = {(item.map_bytes, IniDocument(item.pkt_bytes).section_bytes(item.name)) for item in matches}
        if len(signatures) > 1:
            raise ScenarioError(f"ambiguous map {base!r}: " + "; ".join(f"{m.container} ({m.pkt_filename})" for m in matches))
        return matches[0]


def build(game: Path, spec: dict, out: Path) -> dict:
    spec = validate_spec(spec)
    game, out = Path(game).resolve(), Path(out).resolve()
    if out == game or game in out.parents:
        raise ScenarioError("output must be outside the read-only game directory")
    with GameCatalog(game) as catalog:
        source = catalog.find(spec["base"])
        if any(Path(item.map_filename).stem.casefold() == spec["name"].casefold() for item in catalog.maps()):
            raise ScenarioError("new map name already exists in the game archives; choose a unique name")
        edited, placements = edit_map(source.map_bytes, spec)
        pkt = make_pkt(source.pkt_bytes, source.name, spec["name"], spec["description"])
        extension = Path(source.map_filename).suffix
        map_name = spec["name"] + extension
        pkt_name = spec["name"] + ".pkt"
        archive = write_mix([(pkt_name, pkt), (map_name, edited)])
        # Read back the exact bytes to check the output contract before publication.
        check = MixArchive(archive)
        if check.read(map_name) != edited or check.read(pkt_name) != pkt:
            raise ScenarioError("generated MIX failed round-trip verification")
        out.mkdir(parents=True, exist_ok=True)
        paths = {"yro": out / f"{spec['name']}.yro", "map": out / f"{spec['name']}.map"}
        for path in paths.values():
            if path.is_symlink() or path.exists():
                raise ScenarioError(f"output already exists (choose an empty output directory): {path}")
        created = []
        try:
            for path, contents in ((paths["yro"], archive), (paths["map"], edited)):
                # Exclusive creation protects against races and never follows an
                # output symlink. Remove only files this invocation created.
                with path.open("xb") as output:
                    created.append(path)
                    output.write(contents)
        except OSError:
            for path in created:
                path.unlink(missing_ok=True)
            raise
        return {"paths": {key: str(path) for key, path in paths.items()}, "source": source.container,
                "source_map": source.map_filename, "source_pkt": f"{source.pkt_container} > {source.pkt_filename}",
                "entries": [{"name": name, "id": f"{mix_id(name):08X}", "size": len(body)} for name, body in [(pkt_name, pkt), (map_name, edited)]],
                "pkt": pkt.decode("latin1"), "placements": placements, "warnings": catalog.warnings,
                "ownership": "A -> <human player>, B -> Computer; requires normal skirmish with one human and one AI; network and multiple-AI ownership are unsupported",
                "terrain": "UNVERIFIED: placement checks map bounds and listed object occupancy, not water/cliffs, structure footprints or runtime passability"}


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    ls = commands.add_parser("ls", help="list packet/map pairs and their archive paths")
    ls.add_argument("--game", type=Path, required=True)
    ls.add_argument("--find", default="")
    build_parser = commands.add_parser("build", help="write an additive map and one-map .yro")
    build_parser.add_argument("--game", type=Path, required=True)
    build_parser.add_argument("--spec", type=Path, required=True)
    build_parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args(argv)
    try:
        if args.command == "build":
            result = build(args.game, json.loads(args.spec.read_text(encoding="utf-8")), args.out)
            print(json.dumps(result, indent=2))
        else:
            with GameCatalog(args.game) as catalog:
                matches = [item for item in catalog.maps() if args.find.casefold() in item.name.casefold() or args.find.casefold() in item.container.casefold()]
                for item in matches:
                    print(f"{item.name}\t{item.container} > {item.map_filename} [0x{mix_id(item.map_filename):08X}]\tPKT {item.pkt_container} > {item.pkt_filename}")
                for warning in catalog.warnings:
                    print(f"WARNING: {warning}", file=sys.stderr)
                if not matches:
                    raise ScenarioError(f"no maps match {args.find!r}")
        return 0
    except (ScenarioError, MixError, OSError, ValueError) as error:
        print(f"scenario_map: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
