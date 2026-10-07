"""Scratch training scenarios from the player's own multiplayer maps (nothing here is a game file).

A scenario is a copy of one of the player's maps with objects, waypoints and triggers added as text, packed the way the
stock loose multiplayer packages are (a MIX with <name>.map and <name>.pkt), plus a scratch game folder that links to
the player's installation and holds the copy, a one-map list and the skirmish settings. Everything is written below a
directory the caller names (kept outside Git); the player's installation is only read.

Used by buildScenarios.py. The map text is edited as INI lines so untouched sections stay byte-identical.
"""
from __future__ import annotations

import os
import re
import struct
import sys
import zlib
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parents[2] / 'packages' / 'ra2-assets' / 'python'))
from scenario_mix import MixArchive  # noqa: E402

# The engine's house numbers of the multiplayer start positions A..H in trigger parameters.
PLAYER_HOUSE = {'A': 4475, 'B': 4476, 'C': 4477, 'D': 4478, 'E': 4479, 'F': 4480, 'G': 4481, 'H': 4482}


def read_package_map(package: Path) -> tuple[str, str]:
    """(map name, map text) of a loose multiplayer package (.yro / .mmx)."""
    archive = MixArchive(package.read_bytes(), strict_size=False)
    name = package.stem
    data = archive.read(f'{name}.map')
    if data is None:
        raise SystemExit(f'{package.name}: no {name}.map inside')
    return name, bytes(data).decode('latin1')


def mix_id(name: str) -> int:
    raw = name.upper().replace('/', '\\').encode('latin1')
    length = len(raw)
    aligned = length & ~3
    if length & 3:
        raw = raw + bytes([length - aligned]) + bytes([raw[aligned]]) * (3 - (length & 3))
    return zlib.crc32(raw) & 0xFFFFFFFF


def write_package(name: str, map_text: str, out: Path, max_players: int = 2) -> None:
    """Plain (unencrypted) MIX holding <name>.map and <name>.pkt."""
    pkt = (f'[MultiMaps]\r\n1={name}\r\n\r\n[{name}]\r\nDescription=Name:{name}\r\nCD=0,1\r\nMinPlayers=1\r\n'
           f'MaxPlayers={max_players}\r\nGameMode=standard\r\n').encode('latin1')
    files = [(f'{name}.map', map_text.encode('latin1')), (f'{name}.pkt', pkt)]
    entries = sorted(((mix_id(n), d) for n, d in files), key=lambda e: struct.unpack('<i', struct.pack('<I', e[0]))[0])
    body = b''
    index = b''
    for file_id, data in entries:
        index += struct.pack('<IiI', file_id, len(body), len(data))
        body += data
    out.write_bytes(struct.pack('<IHI', 0, len(entries), len(body)) + index + body)


def waypoint_letters(number: int) -> str:
    """Trigger actions name waypoints in base 26 letters (0 = A, 26 = AA)."""
    text = ''
    number += 1
    while number:
        number, rest = divmod(number - 1, 26)
        text = chr(65 + rest) + text
    return text


class MapText:
    """Line-level editor of a map's INI text."""

    def __init__(self, text: str):
        self.newline = '\r\n' if '\r\n' in text else '\n'
        self.lines = text.split(self.newline)
        self.serial = 0

    def text(self) -> str:
        return self.newline.join(self.lines)

    def _span(self, section: str) -> tuple[int, int] | None:
        start = next((i for i, line in enumerate(self.lines) if line.strip() == f'[{section}]'), None)
        if start is None:
            return None
        end = next((i for i in range(start + 1, len(self.lines)) if self.lines[i].startswith('[')), len(self.lines))
        return start, end

    def entries(self, section: str) -> dict[str, str]:
        span = self._span(section)
        if not span:
            return {}
        out = {}
        for line in self.lines[span[0] + 1:span[1]]:
            if '=' in line and not line.lstrip().startswith(';'):
                key, value = line.split('=', 1)
                out[key.strip()] = value.strip()
        return out

    def drop_section(self, section: str) -> None:
        span = self._span(section)
        if span:
            del self.lines[span[0]:span[1]]

    def set(self, section: str, key: str, value: str | None) -> None:
        """Set (or with None remove) one entry; the section is created at the end when missing."""
        span = self._span(section)
        if not span:
            if value is not None:
                self.lines.extend([f'[{section}]', f'{key}={value}', ''])
            return
        for i in range(span[0] + 1, span[1]):
            if self.lines[i].split('=', 1)[0].strip() == key and '=' in self.lines[i]:
                if value is None:
                    del self.lines[i]
                else:
                    self.lines[i] = f'{key}={value}'
                return
        if value is not None:
            end = span[1]
            while end > span[0] + 1 and not self.lines[end - 1].strip():
                end -= 1
            self.lines.insert(end, f'{key}={value}')

    def append_numbered(self, section: str, rows: list[str]) -> None:
        if not rows:
            return
        keys = [int(k) for k in self.entries(section) if k.isdigit()]
        base = max(keys, default=-1) + 1
        for i, row in enumerate(rows):
            self.set(section, str(base + i), row)

    # --- scenario vocabulary -------------------------------------------------------------------------------------
    def set_starts(self, cells: list[tuple[int, int]]) -> None:
        """Make these cells the multiplayer start waypoints 0..n-1 and remove the other starts (up to 7).

        The engine numbers start positions consecutively from waypoint 0: a map whose starts are, say, 0 and 3 never
        finishes loading with two players, so kept starts are renumbered.
        """
        for number in range(8):
            self.set('Waypoints', str(number), None)
        for number, (x, y) in enumerate(cells):
            self.waypoint(number, x, y)

    def waypoint(self, number: int, x: int, y: int) -> None:
        self.set('Waypoints', str(number), str(y * 1000 + x))

    def tag_for_house(self, house: str | int, seconds: int = 1) -> str:
        """A tag whose objects are handed to `house` (a start letter A..H or an engine house number) after `seconds`."""
        self.serial += 1
        trigger = f'0B7A{self.serial:04X}'
        tag = f'0B7B{self.serial:04X}'
        number = PLAYER_HOUSE[house] if isinstance(house, str) else house
        self.set('Triggers', trigger, f'Neutral,<none>,train hand over {self.serial},0,1,1,1,0')
        self.set('Events', trigger, f'1,13,0,{seconds}')
        self.set('Actions', trigger, f'1,14,0,{number},0,0,0,0,A')
        self.set('Tags', tag, f'0,train tag {self.serial},{trigger}')
        return tag

    def timed_action(self, seconds: int, action: str) -> None:
        """One-shot trigger: elapsed time -> one action (the action text without its count)."""
        self.serial += 1
        trigger = f'0B7C{self.serial:04X}'
        self.set('Triggers', trigger, f'Neutral,<none>,train timed {self.serial},0,1,1,1,0')
        self.set('Events', trigger, f'1,13,0,{seconds}')
        self.set('Actions', trigger, f'1,{action}')
        self.set('Tags', f'0B7D{self.serial:04X}', f'0,train timed tag {self.serial},{trigger}')

    def reveal_all(self, seconds: int = 2) -> None:
        self.timed_action(seconds, '16,0,0,0,0,0,0,A')

    def unit(self, owner: str, kind: str, x: int, y: int, facing: int = 64, mission: str = 'Guard', tag: str = 'None',
             health: int = 256) -> None:
        self.append_numbered('Units', [f'{owner},{kind},{health},{x},{y},{facing},{mission},{tag},0,-1,0,-1,0,0'])

    def infantry(self, owner: str, kind: str, x: int, y: int, sub: int = 2, facing: int = 64, mission: str = 'Guard',
                 tag: str = 'None', health: int = 256) -> None:
        self.append_numbered('Infantry', [f'{owner},{kind},{health},{x},{y},{sub},{mission},{facing},{tag},0,-1,0,0,0'])

    def structure(self, owner: str, kind: str, x: int, y: int, tag: str = 'None', health: int = 256) -> None:
        self.append_numbered('Structures', [f'{owner},{kind},{health},{x},{y},0,{tag},1,0,1,0,0,None,None,None,0,0'])

    def finish(self) -> str:
        self.drop_section('Digest')
        return self.text()


SIDES = {'soviet': ('Russians', 8), 'iraq': ('Arabs', 6), 'allied': ('Americans', 0), 'yuri': ('YuriCountry', 9)}


def write_game_root(root: Path, install: Path, map_name: str, package: Path, *, side: str = 'soviet', credits: int = 10000,
                    units: int = 0, speed: int = 3, ai: list[int] | None = None, superweapons: bool = False) -> None:
    """Scratch game folder <root>/ra2: links to the installation, the scenario package, a one-map list and settings.

    The installation's own loose maps and its map list are left out so that the scenario is the only skirmish map
    (the skirmish settings select it as map 0). `ai` lists one difficulty code per computer opponent.
    """
    game = root / 'ra2'
    if game.exists():
        for entry in game.iterdir():
            entry.unlink()
    game.mkdir(parents=True, exist_ok=True)
    for source in install.iterdir():
        low = source.name.lower()
        if low == 'ra2md.ini' or low == 'missionsmd.pkt' or source.suffix.lower() in ('.yro', '.mmx', '.yrm', '.mpr'):
            continue
        (game / source.name).symlink_to(source)
    os.symlink(package.resolve(), game / f'{map_name}.yro')
    (game / 'missionsmd.pkt').write_bytes(b'[MultiMaps]\r\n')
    ai = ai or []
    slots = ''.join(f'Slot0{n}={ai[n - 1]},-2,-2\r\n' if n <= len(ai) else f'Slot0{n}=1,-2,-2\r\n' for n in range(1, 8))
    ini = (f'[Options]\r\nGameSpeed={speed}\r\n\r\n[Skirmish]\r\nGameMode=1\r\nScenIndex=0\r\nGameSpeed={speed}\r\n'
           f'Credits={credits}\r\nUnitCount={units}\r\nShortGame=no\r\nSuperWeaponsAllowed={"yes" if superweapons else "no"}\r\n'
           'BuildOffAlly=yes\r\nMCVRepacks=yes\r\nCratesAppear=no\r\n' + slots +
           '\r\n[MultiPlayer]\r\nSide=%s\r\nSideEx=%d\r\n' % SIDES[side])
    (game / 'RA2MD.INI').write_bytes(ini.encode('latin1'))


class Terrain:
    """Cell facts of a prepared map (the HD cache's manifest.json of the same map): which cells are flat free land."""

    LAND = (11, 12, 13, 14)

    def __init__(self, manifest: dict, library: dict):
        import base64
        self.width = manifest['grid']['width']
        self.height_cells = manifest['grid']['height']
        cells = manifest['cells']
        self.exists = base64.b64decode(cells['exists'])
        self.height = base64.b64decode(cells['height'])
        self.tile = struct.unpack(f'<{self.width * self.height_cells}H', base64.b64decode(cells['tile']))
        self.tiles = manifest['tiles']
        self.visible = manifest['visibleRect']
        self.waypoints = {w['id']: (w['x'], w['y']) for w in manifest['waypoints']}
        self.occupied: set[tuple[int, int]] = set()
        for obj in manifest['objects']:
            if obj['kind'] == 'overlay' and obj['type'][:3] not in ('GEM', 'TIB'):
                self.occupied.add((obj['x'], obj['y']))
                continue
            if obj['kind'] == 'overlay':
                self.occupied.add((obj['x'], obj['y']))
                continue
            foundation = library.get(obj['type'], {}).get('foundation') if obj['kind'] == 'building' else None
            w, h = foundation or ((3, 3) if obj['kind'] == 'building' else (1, 1))
            for dx in range(-1, w + 1):
                for dy in range(-1, h + 1):
                    self.occupied.add((obj['x'] + dx, obj['y'] + dy))

    def cell(self, x: int, y: int) -> tuple[int, int, int] | None:
        """(height level, ramp type, terrain type) or None outside the map."""
        if not (0 <= x < self.width and 0 <= y < self.height_cells):
            return None
        i = y * self.width + x
        if not self.exists[i] or self.tile[i] == 0xFFFF:
            return None
        tile = self.tiles[self.tile[i]]
        return self.height[i], tile['rampType'], tile['terrainType']

    def pixel(self, x: float, y: float) -> tuple[float, float]:
        """World pixel of a cell (the tactical view's coordinates)."""
        info = self.cell(int(x), int(y))
        level = info[0] if info else 0
        return (x - y) * 30, (x + y) * 15 - level * 15

    def inside(self, x: int, y: int, margin: int = 120) -> bool:
        px, py = self.pixel(x, y)
        v = self.visible
        return v['x'] + margin <= px <= v['x'] + v['width'] - margin and v['y'] + margin <= py <= v['y'] + v['height'] - margin

    def free(self, x: int, y: int, level: int | None = None) -> bool:
        info = self.cell(x, y)
        return bool(info) and info[1] == 0 and info[2] in self.LAND and (level is None or info[0] == level) \
            and (x, y) not in self.occupied and self.inside(x, y)

    def take(self, x: int, y: int, w: int = 1, h: int = 1) -> None:
        for dx in range(w):
            for dy in range(h):
                self.occupied.add((x + dx, y + dy))

    def spots(self, origin: tuple[int, int], count: int, *, spacing: int = 2, w: int = 1, h: int = 1,
              min_distance: float = 0, max_distance: float = 40, same_level: bool = True,
              level: int | None = None) -> list[tuple[int, int]]:
        """`count` free flat sites of w x h cells, nearest to `origin` first, at least `spacing` cells apart."""
        ox, oy = origin
        base = self.cell(ox, oy)
        if level is None:
            level = base[0] if base and same_level else None
        found: list[tuple[int, int]] = []
        ring = sorted(((x, y) for x in range(ox - int(max_distance), ox + int(max_distance) + 1)
                       for y in range(oy - int(max_distance), oy + int(max_distance) + 1)),
                      key=lambda c: (c[0] - ox) ** 2 + (c[1] - oy) ** 2)
        for x, y in ring:
            distance = ((x - ox) ** 2 + (y - oy) ** 2) ** 0.5
            if distance < min_distance or distance > max_distance:
                continue
            if not all(self.free(x + dx, y + dy, level) for dx in range(-1, w + 1) for dy in range(-1, h + 1)):
                continue
            if any(abs(x - fx) < spacing + w - 1 and abs(y - fy) < spacing + h - 1 for fx, fy in found):
                continue
            found.append((x, y))
            self.take(x, y, w, h)
            if len(found) == count:
                break
        return found


def load_terrain(farm: Path, map_name: str) -> Terrain:
    import json
    manifest = json.loads((farm / map_name / 'manifest.json').read_text())
    library = json.loads((farm / '_library' / manifest['theater'] / 'library.json').read_text())['types']
    return Terrain(manifest, library)


def open_sites(terrain: Terrain, origin: tuple[int, int], distance: int, radius: int = 5) -> list[tuple[int, int]]:
    """Points `distance` cells from `origin` in the eight directions, the one with the most free flat land first."""
    base = terrain.cell(*origin)
    level = base[0] if base else None
    d = distance
    k = round(distance * 0.7)
    scored = []
    for dx, dy in ((d, 0), (-d, 0), (0, d), (0, -d), (k, k), (-k, -k), (k, -k), (-k, k)):
        x, y = origin[0] + dx, origin[1] + dy
        free = sum(terrain.free(x + i, y + j, level) for i in range(-radius, radius + 1) for j in range(-radius, radius + 1))
        scored.append((free, (x, y)))
    scored.sort(key=lambda item: -item[0])
    return [point for _, point in scored]
