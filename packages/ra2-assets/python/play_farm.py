"""Build and check a play farm: a symlink farm over a base HD cache plus a batch of prepared map caches.

``build`` derives FARM from BASE the way earlier farms were derived (one relative symlink per top-level entry, see
cache_farm.py) and then installs every fully prepared map directory of MAPS (the output of
scripts/remaster/prepareMultiplayerMaps.py) as one more symlink. Nothing is copied and no existing cache is written.
It can be run again on the same FARM, also with another MAPS batch: what is already there is left alone. A batch
inventory (MAPS/INVENTORY.json, or ``--inventory``) limits the batch to rows with status ``done`` that are not marked
``"active": false`` (a diagnostic variant of a map the game never asks for); without one every directory with a
manifest.json counts as prepared.

* a map the base does not have is linked to its prepared directory;
* a map the base has without any HD work of its own (no 2x terrain, no HD sprite atlas, no sidecar) is superseded by
  the prepared directory;
* a curated base map (HD sprites, sidecars, AI terrain) is kept. When its terrain composite is still scale 1 while the
  prepared one is HD (2x, or a fractional scale fitted under the texture limit) over the same cell grid, the farm
  directory is realised and only the prepared HD terrain and water mask are linked in, with ``manifest.terrainMap``
  patched in the farm's own manifest copy.

``verify`` is the headless integrity check of every map directory of a farm: the manifest parses, each file it and the
optional sidecars name exists and is a complete PNG/JSON of the recorded size, every image fits the texture limit, cell
arrays, tile and sprite rectangles and object references are consistent, and the map's theatre library is present with
its pages. It reports, per map, errors (the HD view would fail or draw wrongly) and warnings (a documented fallback).

Usage:
  python3 play_farm.py build --base BASE --maps MAPS --farm FARM [--inventory INVENTORY.json] [--report out.json]
  python3 play_farm.py verify --farm FARM [--max-texture 16384] [--report out.json] [--only MAP ...]
Exit status 1 when ``verify`` finds an error or ``build`` cannot install a prepared map.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import math
import os
import struct
import sys
from pathlib import Path

import cache_farm

THEATRES = ('temperate', 'snow', 'urban', 'newurban', 'desert', 'lunar')
# Sidecars that only curated maps carry; a base map with any of them is never superseded by a plain prepared map.
CURATED_SIDECARS = ('materials.json', 'lights.json', 'windows.json', 'normals.json', 'sprite-frame-patches.json')
TECHNO_KINDS = ('building', 'vehicle', 'infantry', 'aircraft')
PNG_SIGNATURE = b'\x89PNG\r\n\x1a\n'
PNG_END = b'\x00\x00\x00\x00IEND\xaeB`\x82'
# WebGPU's guaranteed 2D texture size; larger images need an adapter that offers more (Apple GPUs offer 16384).
DEFAULT_TEXTURE_LIMIT = 8192


def _load_json(path: Path):
    return json.loads(path.read_text(encoding='utf-8'))


def _is_map_dir(path: Path) -> bool:
    return not path.name.startswith(('.', '_')) and (path / 'manifest.json').is_file()


def _entry(directory: Path, name: str) -> Path | None:
    """The directory entry matching ``name`` without regard to case (the dev server resolves map names that way)."""
    lowered = name.lower()
    for child in directory.iterdir():
        if child.name.lower() == lowered:
            return child
    return None


def _terrain_scale(manifest: dict) -> float:
    """terrainMap.scale; fractional for a composite fitted under the texture limit (see terrain_scale.py)."""
    return float((manifest.get('terrainMap') or {}).get('scale') or 0)


def _scale_text(scale: float) -> str:
    return str(int(scale)) if float(scale).is_integer() else f'{scale:g}'


def _curated(directory: Path, manifest: dict) -> bool:
    return (_terrain_scale(manifest) > 1 or bool(manifest.get('spriteAtlasHd'))
            or any((directory / name).exists() for name in CURATED_SIDECARS))


def _same_terrain_registration(base: dict, prepared: dict) -> bool:
    """Whether the prepared HD composite shows exactly the base manifest's cells at the same screen origin.

    A fitted composite (fractional scale) is ceil(side * scale) per side of the scale-1 image (terrain_scale.py)."""
    if base.get('grid') != prepared.get('grid') or base.get('cells') != prepared.get('cells'):
        return False
    if base.get('tiles') != prepared.get('tiles'):
        return False
    old, new = base.get('terrainMap'), prepared['terrainMap']
    if not old:
        return True
    if old['originX'] != new['originX'] or old['originY'] != new['originY']:
        return False
    base_width, base_height = old['width'] / old['scale'], old['height'] / old['scale']
    if base_width.is_integer() and base_height.is_integer():
        return (math.ceil(base_width * new['scale']), math.ceil(base_height * new['scale'])) == (new['width'],
                                                                                              new['height'])
    scale = new['scale'] / old['scale']
    return old['width'] * scale == new['width'] and old['height'] * scale == new['height']


def prepared_maps(maps: Path, inventory: Path | None = None) -> tuple[list[Path], list[dict]]:
    """Fully prepared map directories of a batch, and the rows that are skipped with the reason."""
    inventory = inventory or maps / 'INVENTORY.json'
    rows = {row['id']: row for row in _load_json(inventory)['maps']} if inventory.is_file() else None
    ready, skipped = [], []
    for directory in sorted(maps.iterdir(), key=lambda p: p.name.lower()):
        if not directory.is_dir() or directory.name.startswith(('.', '_')):
            continue
        row = (rows or {}).get(directory.name)
        if not (directory / 'manifest.json').is_file():
            skipped.append({'map': directory.name, 'reason': 'no manifest.json'})
        elif rows is not None and (row or {}).get('status') != 'done':
            skipped.append({'map': directory.name, 'reason': f'batch status {(row or {}).get("status")!r}'})
        elif row is not None and row.get('active') is False:
            skipped.append({'map': directory.name, 'reason': 'inactive variant (the game does not load this name)'})
        else:
            ready.append(directory)
    return ready, skipped


def build(base: Path, maps: Path, farm: Path, inventory: Path | None = None) -> dict:
    base, maps, farm = base.absolute(), maps.absolute(), farm.absolute()
    if not base.is_dir() or not maps.is_dir():
        raise NotADirectoryError('BASE and MAPS must be existing directories')
    for other in (base, maps):
        if farm == other or other in farm.parents or farm in other.parents:
            raise ValueError(f'FARM must be a separate directory, not inside or around {other}')
    report: dict = {'farm': str(farm), 'base': str(base), 'maps': str(maps), 'base_entries': [], 'installed': [],
                    'superseded': [], 'terrain_upgraded': [], 'kept': [], 'skipped': [], 'failed': []}
    farm.mkdir(parents=True, exist_ok=True)
    for child in sorted(base.iterdir(), key=lambda p: p.name.lower()):
        # Lock files coordinate writers of the base; the farm creates its own when a directory is realised.
        if child.name.startswith('.'):
            continue
        if not os.path.lexists(farm / child.name):
            cache_farm.install_symlink(farm, child.name, child)
        report['base_entries'].append(child.name)
    ready, report['skipped'] = prepared_maps(maps, inventory)
    for prepared in ready:
        name = prepared.name
        try:
            existing = _entry(farm, name)
            if existing is None:
                cache_farm.install_symlink(farm, name, prepared)
                report['installed'].append(name)
                continue
            target = existing.resolve()
            if target == prepared.resolve():
                report['installed'].append(name)
                continue
            if not existing.is_symlink():
                # Realised by an earlier build or a later install: that directory is this farm's own state.
                report['kept'].append({'map': existing.name, 'reason': 'directory already realised in this farm'})
                continue
            # The farm's own link (one level), not its final target: base entries may be links into older caches.
            linked = (farm / os.readlink(existing)).parent.resolve()
            if linked != base.resolve():
                # Installed by an earlier build from another batch: the first batch to bring a map keeps it.
                report['kept'].append({'map': existing.name, 'reason': f'already installed from {linked}'})
                continue
            if not (existing / 'manifest.json').is_file():
                cache_farm.install_symlink(farm, existing.name, prepared)
                report['superseded'].append({'map': existing.name, 'reason': 'base entry has no manifest'})
                continue
            old, new = _load_json(existing / 'manifest.json'), _load_json(prepared / 'manifest.json')
            if not _curated(existing, old):
                cache_farm.install_symlink(farm, existing.name, prepared)
                report['superseded'].append({'map': existing.name, 'reason': 'base map has no HD terrain, sprites '
                                             'or sidecars'})
            elif (_terrain_scale(old) <= 1 < _terrain_scale(new) and not (existing / 'materials.json').exists()
                  and _same_terrain_registration(old, new)):
                ref = new['terrainMap']
                files = [ref['file']] + ([ref['waterMask']] if ref.get('waterMask') else [])
                if any(os.path.lexists(existing / file) for file in files):
                    report['kept'].append({'map': existing.name, 'reason': 'curated; HD terrain name already taken'})
                    continue
                for file in files:
                    cache_farm.install_symlink(farm, f'{existing.name}/{file}', prepared / file)

                def patch(manifest, ref=ref):
                    manifest['terrainMap'] = ref

                cache_farm.patch_json(farm, f'{existing.name}/manifest.json', patch)
                report['terrain_upgraded'].append({'map': existing.name, 'files': files})
            else:
                report['kept'].append({'map': existing.name, 'reason': 'curated base map'})
        except Exception as error:  # one bad map must not hide the state of the others
            report['failed'].append({'map': name, 'error': f'{type(error).__name__}: {error}'})
    return report


def _png_info(path: Path) -> tuple[int, int, bool]:
    """Width, height and whether the file ends with a complete IEND chunk (a truncated write does not)."""
    with path.open('rb') as file:
        head = file.read(24)
        if len(head) < 24 or head[:8] != PNG_SIGNATURE or head[12:16] != b'IHDR':
            raise ValueError('not a PNG')
        width, height = struct.unpack('>II', head[16:24])
        file.seek(-12, os.SEEK_END)
        return width, height, file.read(12) == PNG_END


class _MapCheck:
    def __init__(self, directory: Path, limit: int):
        self.directory, self.limit = directory, limit
        self.errors: list[str] = []
        self.warnings: list[str] = []
        self.files = 0
        self.max_dimension = 0

    def file(self, rel: str, what: str) -> Path | None:
        path = self.directory / rel
        # Review maps may share files of the farm's own library (../_library/...); nothing may leave the farm.
        farm = os.path.normpath(self.directory.parent)
        if Path(rel).is_absolute() or os.path.commonpath([farm, os.path.normpath(path)]) != farm:
            self.errors.append(f'{what}: path {rel!r} leaves the farm')
            return None
        if not path.is_file():
            self.errors.append(f'{what}: {rel} is missing' + (' (broken link)' if path.is_symlink() else ''))
            return None
        if path.stat().st_size == 0:
            self.errors.append(f'{what}: {rel} is empty')
            return None
        self.files += 1
        return path

    def png(self, rel: str, what: str, size: tuple[int, int] | None = None) -> tuple[int, int] | None:
        path = self.file(rel, what)
        if not path:
            return None
        try:
            width, height, complete = _png_info(path)
        except (OSError, ValueError, struct.error) as error:
            self.errors.append(f'{what}: {rel} unreadable ({error})')
            return None
        if not complete:
            self.errors.append(f'{what}: {rel} is truncated (no IEND)')
        if size and (width, height) != tuple(size):
            self.errors.append(f'{what}: {rel} is {width}x{height}, recorded {size[0]}x{size[1]}')
        if max(width, height) > self.limit:
            self.errors.append(f'{what}: {rel} is {width}x{height}, above the texture limit {self.limit}')
        self.max_dimension = max(self.max_dimension, width, height)
        return width, height

    def json(self, rel: str, what: str):
        path = self.file(rel, what)
        if not path:
            return None
        try:
            return _load_json(path)
        except (OSError, ValueError) as error:
            self.errors.append(f'{what}: {rel} does not parse ({error})')
            return None


def _check_frames(check: _MapCheck, key: str, frames, atlas: dict, what: str) -> None:
    for index, frame in enumerate(frames or []):
        x, y, w, h = frame['rect']
        if frame.get('page', 0) != 0 or x < 0 or y < 0 or x + w > atlas['width'] or y + h > atlas['height']:
            check.errors.append(f'{what} {key} frame {index}: rect {frame["rect"]} outside the atlas')
            return


def _library(farm: Path, theatre: str, cache: dict) -> dict:
    """Theatre library facts shared by every map of that theatre (checked once per farm)."""
    if theatre in cache:
        return cache[theatre]
    info: dict = {'errors': [], 'warnings': [], 'types': None, 'overlays': None, 'smudges': None}
    root = farm / '_library' / theatre
    try:
        library = _load_json(root / 'library.json')
    except (OSError, ValueError) as error:
        info['errors'].append(f'theatre library {theatre}: library.json unusable ({error})')
        cache[theatre] = info
        return info
    info['types'] = library.get('types') or {}
    info['overlays'], info['smudges'] = library.get('overlays'), library.get('smudges')
    hd = library.get('spriteAtlasesHd')
    if hd is None and (root / 'sprites-hd.json').is_file():
        sidecar = _load_json(root / 'sprites-hd.json')
        hd = sidecar if isinstance(sidecar, list) else sidecar.get('spriteAtlasesHd')
    pages = library.get('spriteAtlases') or []
    for index, page in enumerate(pages):
        if not (root / page['file']).is_file():
            info['errors'].append(f'theatre library {theatre}: page {index} {page["file"]} is missing')
        entry = hd[index] if hd and index < len(hd) else None
        if not entry:
            info['warnings'].append(f'theatre library {theatre}: page {index} has no HD page (original art shown)')
            continue
        for field in ('file', 'remap'):
            if not (root / entry[field]).is_file():
                info['errors'].append(f'theatre library {theatre}: HD page {index} {entry[field]} is missing')
    for key, file in (library.get('palettes') or {}).items():
        if not (root / file).is_file():
            info['errors'].append(f'theatre library {theatre}: palette {key} {file} is missing')
    for section in ('overlays', 'smudges'):
        if not info[section]:
            info['warnings'].append(f'theatre library {theatre}: no {section} section (map-start art only)')
    cache[theatre] = info
    return info


def verify_map(farm: Path, name: str, limit: int, libraries: dict) -> dict:
    directory = farm / name
    check = _MapCheck(directory, limit)
    result: dict = {'map': name, 'errors': check.errors, 'warnings': check.warnings}
    manifest_path = directory / 'manifest.json'
    try:
        manifest_bytes = manifest_path.read_bytes()
        manifest = json.loads(manifest_bytes)
    except (OSError, ValueError) as error:
        check.errors.append(f'manifest.json unusable ({error})')
        return result
    theatre = manifest.get('theater')
    result['theatre'] = theatre
    if manifest.get('version') != 1:
        check.errors.append(f'manifest version {manifest.get("version")!r} (expected 1)')
    if theatre not in THEATRES:
        check.errors.append(f'unknown theatre {theatre!r}')
        return result
    try:
        grid = manifest['grid']
        cells = grid['width'] * grid['height']
        exists = base64.b64decode(manifest['cells']['exists'])
        heights = base64.b64decode(manifest['cells']['height'])
        tiles = base64.b64decode(manifest['cells']['tile'])
        if len(exists) != cells or len(heights) != cells or len(tiles) != cells * 2:
            check.errors.append(f'cell arrays do not match the {grid["width"]}x{grid["height"]} grid')
        else:
            used = set(struct.unpack(f'<{cells}H', tiles))
            used.discard(0xffff)
            if used and max(used) >= len(manifest['tiles']):
                check.errors.append(f'cell tile index {max(used)} beyond the {len(manifest["tiles"])} tiles')

        atlas = manifest['terrainAtlas']
        check.png(atlas['file'], 'terrain atlas', (atlas['width'], atlas['height']))
        # Optional: the engine z byte of every tile pixel; terrain compositors require it to match the atlas.
        if atlas.get('depth'):
            check.png(atlas['depth'], 'terrain depth atlas', (atlas['width'], atlas['height']))
        for index, tile in enumerate(manifest['tiles']):
            x, y, w, h = tile['rect']
            if x < 0 or y < 0 or x + w > atlas['width'] or y + h > atlas['height']:
                check.errors.append(f'tile {index} ({tile["file"]}): rect outside the terrain atlas')
                break

        sprites = manifest['spriteAtlas']
        check.png(sprites['file'], 'sprite atlas', (sprites['width'], sprites['height']))
        hd = manifest.get('spriteAtlasHd')
        if hd:
            size = (hd['width'], hd['height'])
            if size != (sprites['width'] * hd['scale'], sprites['height'] * hd['scale']):
                check.errors.append(f'HD sprite atlas {size} is not {hd["scale"]}x the sprite atlas')
            check.png(hd['file'], 'HD sprite atlas', size)
            check.png(hd['remap'], 'HD sprite remap mask', size)
        else:
            check.warnings.append('no HD sprite atlas (map trees and overlays drawn from original art)')

        for key, file in manifest['palettes'].items():
            size = check.png(file, f'palette {key}')
            if size and size[0] != 256:
                check.errors.append(f'palette {key}: {file} is {size[0]} px wide, expected 256')
        for key, file in manifest['voxels'].items():
            check.json(file, f'voxel {key}')

        for key, sprite in manifest['sprites'].items():
            if sprite['palette'] not in manifest['palettes']:
                check.errors.append(f'sprite {key}: palette {sprite["palette"]!r} not in the manifest')
            _check_frames(check, key, sprite.get('frames'), sprites, 'sprite')
            _check_frames(check, key, sprite.get('shadows'), sprites, 'sprite shadow')

        library = _library(farm, theatre, libraries)
        check.errors.extend(library['errors'])
        check.warnings.extend(library['warnings'])
        missing_types: dict[str, int] = {}
        for index, obj in enumerate(manifest['objects']):
            if not (0 <= obj['x'] < grid['width'] and 0 <= obj['y'] < grid['height']):
                check.errors.append(f'object {index} ({obj["type"]}) outside the grid')
                break
            if obj.get('sprite') is not None:
                sprite = manifest['sprites'].get(obj['sprite'])
                if sprite is None:
                    check.errors.append(f'object {index} ({obj["type"]}): sprite {obj["sprite"]} not in the manifest')
                    break
                if not 0 <= obj.get('frame', 0) < max(1, len(sprite['frames'])):
                    check.errors.append(f'object {index} ({obj["type"]}): frame {obj.get("frame")} out of range')
                    break
            if obj.get('voxel') is not None and obj['voxel'] not in manifest['voxels']:
                check.errors.append(f'object {index} ({obj["type"]}): voxel {obj["voxel"]} not in the manifest')
                break
            # A live match draws these from the theatre library; a type it lacks is tracked but drawn as nothing.
            if obj['kind'] in TECHNO_KINDS and library['types'] is not None and obj['type'] not in library['types']:
                missing_types[obj['type']] = missing_types.get(obj['type'], 0) + 1
        if missing_types:
            listed = ', '.join(f'{key} x{count}' for key, count in sorted(missing_types.items()))
            check.warnings.append(f'map objects without theatre-library art (not drawn in a live match): {listed}')

        terrain = manifest.get('terrainMap')
        result['terrainScale'] = _terrain_scale(manifest)
        materials = None
        if (directory / 'materials.json').exists():
            materials = check.json('materials.json', 'materials sidecar')
            if materials is not None and materials.get('version') != 1:
                check.warnings.append('materials.json is not version 1 and is ignored')
                materials = None
        if terrain:
            size = (terrain['width'], terrain['height'])
            check.png(terrain['file'], 'terrain composite', size)
            if terrain.get('waterMask'):
                check.png(terrain['waterMask'], 'terrain water mask', size)
            if materials:
                if materials.get('terrainMap'):
                    check.png(materials['terrainMap'], 'materials terrain composite', size)
                if materials.get('waterMask'):
                    check.png(materials['waterMask'], 'materials water mask', size)
                for field in ('shoreIgnore', 'waterDetail', 'waterSurface'):
                    if isinstance(materials.get(field), str):
                        check.png(materials[field], f'materials {field}')
            if terrain['scale'] <= 1:
                doubled = max(size) * 2 // terrain['scale']
                check.warnings.append(
                    'terrain composite is scale 1' + (f' (2x would be {doubled} px, above the upscaler limit)'
                                                      if doubled > 16384 else ''))
        else:
            check.warnings.append('no terrain composite (terrain drawn from the tile atlas)')

        if (directory / 'lights.json').exists():
            lights = check.json('lights.json', 'light sidecar')
            recorded = ((lights or {}).get('extractor') or {}).get('manifestSha256')
            if lights is not None and recorded != hashlib.sha256(manifest_bytes).hexdigest():
                check.warnings.append('lights.json was written for another manifest.json (object indices ignored)')
        if (directory / 'windows.json').exists():
            check.json('windows.json', 'window sidecar')
            check.png('windows.png', 'window mask')
        if (directory / 'normals.json').exists():
            normals = check.json('normals.json', 'sprite material sidecar')
            for field in ('file', 'atlas'):
                if isinstance((normals or {}).get(field), str):
                    check.file(normals[field], f'sprite material {field}')
    except (KeyError, TypeError, ValueError, struct.error) as error:
        check.errors.append(f'manifest structure: {type(error).__name__}: {error}')
    result['files'] = check.files
    result['maxDimension'] = check.max_dimension
    return result


def verify(farm: Path, limit: int = 16384, only: list[str] | None = None) -> dict:
    farm = farm.absolute()
    libraries: dict = {}
    wanted = {name.lower() for name in only} if only else None
    maps = []
    for child in sorted(farm.iterdir(), key=lambda p: p.name.lower()):
        if not _is_map_dir(child) or (wanted is not None and child.name.lower() not in wanted):
            continue
        maps.append(verify_map(farm, child.name, limit, libraries))
    broken = sorted(child.name for child in farm.iterdir() if child.is_symlink() and not child.exists())
    theatres: dict[str, int] = {}
    for row in maps:
        if row.get('theatre'):
            theatres[row['theatre']] = theatres.get(row['theatre'], 0) + 1
    return {
        'farm': str(farm),
        'textureLimit': limit,
        'maps': len(maps),
        'ok': sum(not row['errors'] for row in maps),
        'failed': [row['map'] for row in maps if row['errors']],
        'brokenTopLevelLinks': broken,
        'theatres': theatres,
        'scale1Terrain': [row['map'] for row in maps if row.get('terrainScale') == 1],
        # Composites fitted under the texture limit at a fractional scale, e.g. {'XMP22S8': '1.76172'}.
        'fittedTerrain': {row['map']: _scale_text(row['terrainScale']) for row in maps
                          if not float(row.get('terrainScale') or 0).is_integer()},
        'aboveGuaranteedLimit': [row['map'] for row in maps if row.get('maxDimension', 0) > DEFAULT_TEXTURE_LIMIT],
        'results': maps,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    commands = parser.add_subparsers(dest='command', required=True)
    build_parser = commands.add_parser('build')
    build_parser.add_argument('--base', type=Path, required=True)
    build_parser.add_argument('--maps', type=Path, required=True)
    build_parser.add_argument('--farm', type=Path, required=True)
    build_parser.add_argument('--inventory', type=Path, help='batch inventory (default: MAPS/INVENTORY.json)')
    build_parser.add_argument('--report', type=Path)
    verify_parser = commands.add_parser('verify')
    verify_parser.add_argument('--farm', type=Path, required=True)
    verify_parser.add_argument('--max-texture', type=int, default=16384)
    verify_parser.add_argument('--only', nargs='*')
    verify_parser.add_argument('--report', type=Path)
    args = parser.parse_args(argv)
    if args.command == 'build':
        report = build(args.base, args.maps, args.farm, args.inventory)
        summary = {key: len(report[key]) for key in ('base_entries', 'installed', 'superseded', 'terrain_upgraded',
                                                     'kept', 'skipped', 'failed')}
        failed = bool(report['failed'])
    else:
        report = verify(args.farm, args.max_texture, args.only)
        summary = {key: report[key] for key in ('maps', 'ok', 'failed', 'brokenTopLevelLinks', 'theatres',
                                                'scale1Terrain', 'fittedTerrain')}
        summary['warnings'] = sum(len(row['warnings']) for row in report['results'])
        failed = bool(report['failed'] or report['brokenTopLevelLinks'])
    if args.report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(json.dumps(report, indent=1) + '\n', encoding='utf-8')
    print(json.dumps(summary, indent=1))
    return 1 if failed else 0


if __name__ == '__main__':
    sys.exit(main())
