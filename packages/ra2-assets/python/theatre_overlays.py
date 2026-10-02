#!/usr/bin/env python3
"""Install scratch-extracted overlays into a copy-on-write theatre cache farm.

Run hd:library --only overlays on a scratch copy of library.json and palettes,
never directly in a shared farm. Only pages used by overlay frames or shadows
are imported. The compose lock covers planning, file installation and the locked
cache_farm.patch_json merge; files are installed before JSON publication.

This replaces every overlay sprite, including later frame redirections. Reapply
them afterwards in this order: ore_fields.py install (ore/gem frames to the ore
page), then theatre_pages.py overlay-walls (walls to HD building frames).
"""

from __future__ import annotations

import argparse
import copy
import fcntl
import hashlib
import json
from pathlib import Path
import sys

import cache_farm


def _read_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding='utf-8'))


def _relative_file(name: str) -> str:
    path = Path(name)
    if path.is_absolute() or '..' in path.parts or not path.name:
        raise ValueError(f'expected a relative file path without traversal: {name}')
    return str(path)


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()


def _validate(source: dict, current: dict, theatre: str) -> list[str]:
    if source['version'] != current['version']:
        raise ValueError('source and destination library version differ')
    if source['theater'] != current['theater'] or source['theater'] != theatre:
        raise ValueError('source and destination theater must match the requested theatre')
    missing = []
    for key in source['palettes']:
        if key not in current['palettes']:
            missing.append(key)
        elif source.get('paletteSources', {}).get(key) != current.get('paletteSources', {}).get(key):
            raise ValueError(f'conflicting paletteSources for {key}')
    return missing


def _overlay_sprites(source: dict) -> tuple[dict, list[int]]:
    # Rubble overlays can have no sprite. Unreferenced old atlas pages need not
    # exist in scratch: the append only needs a real JSON and palette copy.
    sprites = {key: copy.deepcopy(sprite) for key, sprite in source['sprites'].items()
               if key.startswith('overlay:')}
    pages = set()
    for sprite in sprites.values():
        for frame in sprite.get('frames', []) + sprite.get('shadows', []):
            page = frame.get('page', 0)
            if type(page) is not int or not 0 <= page < len(source['spriteAtlases']):
                raise ValueError(f'overlay frame references an invalid source page: {page}')
            pages.add(page)
    return sprites, sorted(pages)


def install(extracted: Path, cache_root: Path, theatre: str) -> str:
    """Merge an extracted overlay section, print and return its one-line summary."""
    if theatre in ('', '.', '..') or Path(theatre).name != theatre:
        raise ValueError('theatre must be a single directory name')
    source_dir = Path(extracted)
    directory = Path(cache_root) / '_library' / theatre
    if directory.is_symlink() or not directory.is_dir():
        raise ValueError('destination theatre must be a real directory')

    # A farm's lock files may be symlinks into the base cache. Opening one for append writes nothing and locks the
    # shared inode, which is what ore_fields, theatre_pages and cache_farm do as well, so every writer still excludes
    # every other one.
    with (directory / '.compose.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        try:
            source = _read_json(source_dir / 'library.json')
            current = _read_json(directory / 'library.json')
            missing_palettes = _validate(source, current, theatre)
            # Validate required sections before any file is installed.
            overlays, extractor = source['overlays'], source['overlayExtractor']
            sprites, pages = _overlay_sprites(source)
            atlases = copy.deepcopy(current['spriteAtlases'])
            original_count = len(atlases)
            additions, page_map, checks, hd_updates, files = [], {}, {}, {}, {}
            digests = {}
            listed = {atlas['file'] for atlas in atlases}

            def queue_file(name, relative):
                name, relative = _relative_file(name), _relative_file(relative)
                path = source_dir / relative
                digest = _sha256(path)
                files[name] = (path, digest)
                return digest

            # Decide against the current farm, not the copied scratch atlas list.
            # Planned additions also participate in content reuse within this run.
            for page in pages:
                atlas = source['spriteAtlases'][page]
                relative = _relative_file(atlas['file'])
                digest = _sha256(source_dir / relative)
                index = None
                for i, candidate in enumerate(atlases):
                    if i not in digests:
                        path = directory / _relative_file(candidate['file'])
                        digests[i] = _sha256(path) if path.is_file() else None
                    if digests[i] == digest:
                        index = i
                        break
                if index is None:
                    n = 0
                    while True:
                        name = f'sprites-overlays-{n}.png'
                        path = directory / name
                        if name not in listed and not path.exists() and not path.is_symlink():
                            break
                        n += 1
                    index = len(atlases)
                    entry = dict(file=name, width=atlas['width'], height=atlas['height'])
                    atlases.append(entry)
                    additions.append(entry)
                    listed.add(name)
                    digests[index] = queue_file(name, relative)
                page_map[page] = index
                checks[index] = (atlases[index], digest)
                hd = source.get('spriteAtlasesHd') or []
                reference = hd[page] if page < len(hd) else None
                if reference is None:
                    hd_updates[index] = None
                else:
                    stem = str(Path(atlases[index]['file']).with_suffix(''))
                    entry = {key: copy.deepcopy(reference[key])
                             for key in ('scale', 'width', 'height', 'paintSaturation') if key in reference}
                    for key, suffix in (('file', '@2x.png'), ('remap', '@2x-remap.png')):
                        entry[key] = stem + suffix
                        queue_file(entry[key], reference[key])
                    hd_updates[index] = entry

            palette_additions = {}
            for key in missing_palettes:
                relative = _relative_file(source['palettes'][key])
                palette_additions[key] = (relative, source['paletteSources'][key])
                queue_file(relative, relative)

            for sprite in sprites.values():
                for frame in sprite.get('frames', []) + sprite.get('shadows', []):
                    frame['page'] = page_map[frame.get('page', 0)]

            for name, (path, _) in files.items():
                cache_farm.install_file(directory, name, path)

            palettes_added = 0

            def update(data):
                nonlocal palettes_added
                missing = _validate(source, data, theatre)
                dest_atlases = data['spriteAtlases']
                # A writer using only the JSON lock may have run during file
                # installation. Unrelated edits survive; shifted slots abort.
                if additions and len(dest_atlases) != original_count:
                    raise ValueError('destination atlas indices changed during installation')
                for index, (entry, digest) in checks.items():
                    if index < original_count:
                        if index >= len(dest_atlases) or dest_atlases[index] != entry:
                            raise ValueError('reused destination atlas changed during installation')
                    elif any(atlas['file'] == entry['file'] for atlas in dest_atlases):
                        raise ValueError('new destination atlas filename was claimed during installation')
                    if _sha256(directory / entry['file']) != digest:
                        raise ValueError('destination atlas content changed during installation')
                for name, (_, digest) in files.items():
                    if _sha256(directory / name) != digest:
                        raise ValueError(f'installed file changed before publication: {name}')
                if any(key not in palette_additions for key in missing):
                    raise ValueError('destination palettes changed during installation')

                dest_atlases.extend(copy.deepcopy(additions))
                if 'spriteAtlasesHd' in data or any(hd_updates.values()):
                    hd = data.setdefault('spriteAtlasesHd', [])
                    hd.extend([None] * (len(dest_atlases) - len(hd)))
                    for index, entry in hd_updates.items():
                        hd[index] = copy.deepcopy(entry)
                dest_sprites = data['sprites']
                for key in list(dest_sprites):
                    if key.startswith('overlay:'):
                        del dest_sprites[key]
                dest_sprites.update(sprites)
                data['overlays'] = overlays
                data['overlayExtractor'] = extractor
                for key in missing:
                    relative, palette_source = palette_additions[key]
                    data['palettes'][key] = relative
                    data.setdefault('paletteSources', {})[key] = palette_source
                palettes_added = len(missing)

            # patch_json owns .library.json.lock. Taking it on another descriptor
            # here would deadlock; the compose lock remains held across this call.
            cache_farm.patch_json(directory, 'library.json', update)
            summary = (f'{theatre}: overlay types {len(overlays)}; pages added {len(additions)}, '
                       f'reused {len(pages) - len(additions)}; palettes added {palettes_added}')
            print(summary)
            return summary
        finally:
            fcntl.flock(lock, fcntl.LOCK_UN)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    command = commands.add_parser('install', help='merge scratch overlays into a theatre farm')
    command.add_argument('--extracted', type=Path, required=True)
    command.add_argument('--cache-root', type=Path, required=True)
    command.add_argument('--theatre', required=True)
    args = parser.parse_args(argv)
    try:
        install(args.extracted, args.cache_root, args.theatre)
    except (OSError, ValueError, KeyError) as error:
        print(f'theatre_overlays install: {error}', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
