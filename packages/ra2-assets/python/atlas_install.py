"""Install prebuilt RA2 map/library HD sprite atlases using the copy-on-write cache farm.

Only empty spriteAtlasHd / spriteAtlasesHd slots are eligible; existing references
are never replaced. Inputs are explicit cache trees, rather than track-local paths.
"""

import argparse
import fcntl
import json
from pathlib import Path

import cache_farm


def component(value):
    if not value or Path(value).name != value or value in {'.', '..'}:
        raise ValueError('expected one path component')
    return value


def reference(directory, key, page=None):
    data = json.loads((directory / ('manifest.json' if page is None else 'library.json')).read_text())
    ref = data[key] if page is None else data[key][page]
    if not isinstance(ref, dict):
        raise ValueError('source atlas reference is missing')
    for field in ('file', 'remap'):
        name = ref[field]
        if Path(name).is_absolute() or '..' in Path(name).parts:
            raise ValueError('atlas files must be relative paths without traversal')
        if not (directory / name).is_file():
            raise FileNotFoundError(directory / name)
    return ref


def install_map(farm, source, name):
    component(name)
    directory = Path(source) / name
    ref = reference(directory, 'spriteAtlasHd')
    # patch_json holds the per-manifest lock while files are installed, then publishes the reference.
    def put(manifest):
        if manifest.get('spriteAtlasHd'):
            raise ValueError(f'{name}: manifest already has spriteAtlasHd')
        for field in ('file', 'remap'):
            cache_farm.install_file(Path(farm), f'{name}/{ref[field]}', directory / ref[field])
        manifest['spriteAtlasHd'] = ref
    cache_farm.patch_json(Path(farm), f'{name}/manifest.json', put)
    return ref


def install_overlay(farm, source, theatre, page, suffix='s2b'):
    component(theatre)
    component(suffix)
    if page < 0:
        raise ValueError('page must be nonnegative')
    directory = Path(source) / '_library' / theatre
    ref = reference(directory, 'spriteAtlasesHd', page)
    stem = Path(ref['file']).stem
    names = {'file': f'{stem}-{suffix}.png', 'remap': f'{stem}-{suffix}-remap.png'}
    entry = dict(ref, **names)
    # Realise a symlinked library directory before creating its stable composition lock.
    library = cache_farm._destination(Path(farm), f'_library/{theatre}/library.json').parent
    with (library / '.compose.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        def put(data):
            hd = data.setdefault('spriteAtlasesHd', [])
            while len(hd) <= page:
                hd.append(None)
            if hd[page]:
                return
            for field in ('file', 'remap'):
                cache_farm.install_file(Path(farm), f'_library/{theatre}/{names[field]}', directory / ref[field])
            hd[page] = entry
        cache_farm.patch_json(Path(farm), f'_library/{theatre}/library.json', put)
    return entry


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--farm', required=True, type=Path)
    parser.add_argument('--source', required=True, type=Path)
    commands = parser.add_subparsers(dest='command', required=True)
    maps = commands.add_parser('map')
    maps.add_argument('names', nargs='+')
    overlays = commands.add_parser('overlay')
    overlays.add_argument('pages', nargs='+', help='THEATRE:PAGE')
    overlays.add_argument('--suffix', default='s2b')
    args = parser.parse_args(argv)
    if args.command == 'map':
        for name in args.names:
            print('installed', name, install_map(args.farm, args.source, name))
    else:
        for item in args.pages:
            theatre, page = item.split(':')
            print(theatre, page, install_overlay(args.farm, args.source, theatre, int(page), args.suffix))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
