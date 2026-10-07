#!/usr/bin/env python3
"""Build the practice scenarios of the training mode from the player's own files (see docs/remaster/TRAINING.md).

  buildScenarios.py [--out DIR] [--install DIR] [--farm DIR] [--only NAME ...]

Writes, below --out (default <main checkout>/gameres/s2x/play/train):
  maps/<Map>.<scenario>.map / .yro   the scratch copy of the player's map with the lesson's objects and triggers
  gameroots/<scenario>/ra2/          links to the player's installation + the copy + a one-map list + skirmish settings
  hd-cache/                          links to the HD cache's entries (the copy keeps the map's name, so its HD art applies)
  scenarios.json                     what was placed where (for tests and notes)

Nothing is written into the installation, the HD cache or Git. Every scenario is symmetric: the game gives the human a
random start position, so the same kit stands at both starts and is handed to whoever starts there, while the targets
at a start are handed to the other player (the computer opponent, which the map keeps passive).
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import mapkit  # noqa: E402

CHECKOUT = HERE.parents[2]
common = subprocess.run(['git', '-C', str(CHECKOUT), 'rev-parse', '--path-format=absolute', '--git-common-dir'],
                        capture_output=True, text=True).stdout.strip()
MAIN = Path(common).parent if common else CHECKOUT

# Passive opponent: the easy computer player, with the map telling it to ignore the global attack triggers.
EASY, MEDIUM, BRUTAL = 6, 5, 4


def site_plan(terrain: mapkit.Terrain, start: tuple[int, int]) -> dict:
    """Free sites around one start, nearest first: `near` for the kit, `front` (13 cells out) for targets."""
    for dx in range(-3, 4):
        for dy in range(-3, 4):
            terrain.occupied.add((start[0] + dx, start[1] + dy))
    directions = mapkit.open_sites(terrain, start, 14)
    return {'start': start, 'front': directions[0], 'side': directions[1]}


def basic(m: mapkit.MapText, terrain: mapkit.Terrain, starts: list[tuple[int, int]]) -> dict:
    """Lessons 1-3: a small Soviet force next to a built base; passive targets in front of it."""
    info = {}
    tags = {letter: m.tag_for_house(letter) for letter in 'AB'}
    for index, (start, own, other) in enumerate(((starts[0], 'A', 'B'), (starts[1], 'B', 'A'))):
        plan = site_plan(terrain, start)
        yard = terrain.spots(start, 1, w=4, h=4, min_distance=5, max_distance=12)[0]
        power = terrain.spots(start, 1, w=2, h=3, min_distance=5, max_distance=12)[0]
        m.structure('Neutral', 'NACNST', *yard, tag=tags[own])
        m.structure('Neutral', 'NAPOWR', *power, tag=tags[own])
        tanks = terrain.spots(start, 4, spacing=2, min_distance=3, max_distance=10)
        flak = terrain.spots(start, 3, spacing=2, min_distance=3, max_distance=11)
        troops = terrain.spots(start, 3, spacing=1, min_distance=3, max_distance=11)
        for cell in tanks:
            m.unit('Neutral', 'HTNK', *cell, tag=tags[own])
        for cell in flak:
            m.unit('Neutral', 'HTK', *cell, tag=tags[own])
        for cell in troops:
            for sub in (2, 3):
                m.infantry('Neutral', 'E2', *cell, sub=sub, tag=tags[own])
        # Targets: two power plants of the other player (they do not shoot) and civilians to run over.
        targets = terrain.spots(plan['front'], 2, w=2, h=3, spacing=3, max_distance=7)
        for cell in targets:
            m.structure('Neutral', 'NAPOWR', *cell, tag=tags[other])
        crowd = terrain.spots(plan['side'], 5, spacing=1, max_distance=6)
        for i, cell in enumerate(crowd):
            m.infantry('Neutral', ('CIV1', 'CIV2', 'CIV3')[i % 3], *cell, mission='Sleep')
        # An outpost far from the base under fire from a sentry gun of the other player: the game raises an alert
        # there, which stays the newest event for "jump to the last event" after the outpost is gone.
        outpost_site = mapkit.open_sites(terrain, start, 46, radius=4)[0]
        level = terrain.cell(*start)[0]
        gun = terrain.spots(outpost_site, 1, max_distance=10, level=level)[0]
        outpost = terrain.spots(gun, 2, w=2, h=3, spacing=1, max_distance=5, level=level)
        m.structure('Neutral', 'NALASR', *gun, tag=tags[other])
        for cell in outpost:
            m.structure('Neutral', 'NAPOWR', *cell, tag=tags[own])
        info[own] = {'start': start, 'yard': yard, 'power': power, 'tanks': tanks, 'flak': flak, 'troops': troops,
                     'targets': targets, 'crowd': crowd, 'outpost': outpost, 'outpostGun': gun}
    return info


def build(m: mapkit.MapText, terrain: mapkit.Terrain, starts: list[tuple[int, int]]) -> dict:
    """Lesson 4: only the MCV, a damaged plant and a sentry gun to sell; three tanks and a target for fighting."""
    info = {}
    tags = {letter: m.tag_for_house(letter) for letter in 'AB'}
    for start, own, other in ((starts[0], 'A', 'B'), (starts[1], 'B', 'A')):
        plan = site_plan(terrain, start)
        damaged = terrain.spots(start, 1, w=2, h=3, min_distance=8, max_distance=14)[0]
        m.structure('Neutral', 'NAPOWR', *damaged, tag=tags[own], health=110)
        gun = terrain.spots(start, 1, w=1, h=1, min_distance=8, max_distance=14)[0]
        m.structure('Neutral', 'NALASR', *gun, tag=tags[own])
        tanks = terrain.spots(start, 3, spacing=2, min_distance=4, max_distance=10)
        for cell in tanks:
            m.unit('Neutral', 'HTNK', *cell, tag=tags[own])
        targets = terrain.spots(plan['front'], 2, w=2, h=3, spacing=3, max_distance=7)
        for cell in targets:
            m.structure('Neutral', 'NAPOWR', *cell, tag=tags[other])
        info[own] = {'start': start, 'damaged': damaged, 'gun': gun, 'tanks': tanks, 'targets': targets}
    return info


SCENARIOS = {
    # name: (map package, start waypoints of the stock map to keep, builder, settings)
    'basic': ('Unrepent', (0, 3), basic, {'side': 'soviet', 'credits': 10000, 'units': 0, 'ai': [EASY], 'passive': True}),
    'build': ('Unrepent', (0, 3), build, {'side': 'soviet', 'credits': 10000, 'units': 0, 'ai': [EASY], 'passive': True}),
}


def link_farm(farm: Path, out: Path) -> None:
    """A cache root of links: the development server only reads it, and the real cache is never written."""
    out.mkdir(parents=True, exist_ok=True)
    for entry in farm.iterdir():
        target = out / entry.name
        if not target.exists() and not target.is_symlink():
            os.symlink(entry.resolve(), target)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument('--out', type=Path, default=MAIN / 'gameres' / 's2x' / 'play' / 'train')
    parser.add_argument('--install', type=Path, default=MAIN / 'game' / 'ra2')
    parser.add_argument('--farm', type=Path, default=MAIN / 'gameres' / 'hd-cache-play5')
    parser.add_argument('--only', nargs='*')
    parser.add_argument('--speed', type=int, default=3)
    args = parser.parse_args()
    (args.out / 'maps').mkdir(parents=True, exist_ok=True)
    link_farm(args.farm, args.out / 'hd-cache')
    # The page loads two third-party libraries and its lesson list session from <game root>/ra2: the installation.
    plain = args.out / 'gameroots' / 'ra2'
    plain.parent.mkdir(parents=True, exist_ok=True)
    if not plain.exists() and not plain.is_symlink():
        os.symlink(args.install.resolve(), plain)
    summary_path = args.out / 'scenarios.json'
    summary = json.loads(summary_path.read_text()) if summary_path.exists() else {}
    for name, (map_name, keep, builder, settings) in SCENARIOS.items():
        if args.only and name not in args.only:
            continue
        package = next(p for p in args.install.iterdir() if p.stem.lower() == map_name.lower() and p.suffix.lower() in ('.yro', '.mmx'))
        _, text = mapkit.read_package_map(package)
        terrain = mapkit.load_terrain(args.farm, map_name)
        m = mapkit.MapText(text)
        starts = [terrain.waypoints[number] for number in keep]
        m.set_starts(starts)
        if settings.get('passive'):
            m.set('Basic', 'IgnoreGlobalAITriggers', 'yes')
        info = builder(m, terrain, starts)
        # The lessons are about operating, not scouting: the whole map is visible from the start.
        m.reveal_all(2)
        map_path = args.out / 'maps' / f'{map_name}.{name}.map'
        map_path.write_text(m.finish(), encoding='latin1', newline='')
        package_path = args.out / 'maps' / f'{map_name}.{name}.yro'
        mapkit.write_package(map_name, map_path.read_text(encoding='latin1'), package_path, max_players=len(starts))
        mapkit.write_game_root(args.out / 'gameroots' / name, args.install, map_name, package_path, side=settings['side'],
                               credits=settings['credits'], units=settings['units'], speed=args.speed, ai=settings['ai'])
        summary[name] = {'map': map_name, 'package': str(package_path), 'sites': info}
        print(name, map_name, {k: {kk: vv for kk, vv in v.items() if kk in ('start', 'yard', 'targets')} for k, v in info.items()})
    summary_path.write_text(json.dumps(summary, indent=1))


if __name__ == '__main__':
    main()
