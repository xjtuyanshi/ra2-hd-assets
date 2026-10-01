"""Integrity check of a copy-on-write symlink farm (see cache_farm.py) against the caches it was built over.

A fix round installs new files into a fresh farm whose other entries are symlinks into older caches. This check finds:

* broken symlinks in the farm;
* write-through: a real file of a base cache, or the target of a farm link, modified after the farm was created
  (``--since`` overrides the farm directory's creation time), and farm files hard-linked to a base cache file (writing
  either changes both);
* library pages the renderer would ignore: in every ``_library/<theatre>/`` with a ``normals.json``, each normals page
  must name the library's HD atlas page file as its ``atlas`` (the renderer drops a material page made for another
  atlas, so the sprites on it lose their normal maps), and every HD page / normals file must exist.

Usage: python3 farm_check.py FARM BASE [BASE...] [--since EPOCH] [--json out.json]
Exit status 1 when a problem is found.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path


def _birth(path: Path) -> float:
    st = path.stat()
    return getattr(st, 'st_birthtime', st.st_ctime)


def check(farm: Path, bases: list[Path], since: float | None = None) -> dict:
    created = since if since is not None else _birth(farm)
    out: dict = {'broken': [], 'write_through': [], 'shared_inodes': [], 'ignored_normals': [], 'missing_pages': [],
                 'real_files': 0, 'links': 0}
    inodes: dict[tuple[int, int], str] = {}
    for root, dirs, files in os.walk(farm):
        for name in files + dirs:
            p = Path(root) / name
            rel = str(p.relative_to(farm))
            if p.is_symlink():
                out['links'] += 1
                if not p.exists():
                    out['broken'].append(rel)
                elif p.stat().st_mtime > created:
                    out['write_through'].append(f'link target {os.path.realpath(p)} (via {rel})')
            elif p.is_file():
                out['real_files'] += 1
                st = p.lstat()
                if st.st_nlink > 1:
                    inodes[(st.st_dev, st.st_ino)] = rel
    for base in bases:
        for root, _dirs, files in os.walk(base):
            for name in files:
                p = Path(root) / name
                if p.is_symlink():
                    continue
                st = p.lstat()
                if st.st_mtime > created:
                    out['write_through'].append(str(p))
                if (st.st_dev, st.st_ino) in inodes:
                    out['shared_inodes'].append(f'{p} == {inodes[(st.st_dev, st.st_ino)]}')
    library = farm / '_library'
    for theatre in sorted(library.iterdir()) if library.is_dir() else []:
        lib_path, normals_path = theatre / 'library.json', theatre / 'normals.json'
        if not lib_path.exists():
            continue
        hd = json.loads(lib_path.read_text(encoding='utf-8')).get('spriteAtlasesHd') or []
        for i, page in enumerate(hd):
            for key in ('file', 'remap'):
                if page and page.get(key) and not (theatre / page[key]).exists():
                    out['missing_pages'].append(f'{theatre.name}: page {i} {page[key]}')
        if not normals_path.exists():
            continue
        for key, page in json.loads(normals_path.read_text(encoding='utf-8')).get('pages', {}).items():
            index = int(key)
            entry = hd[index] if index < len(hd) else None
            if not entry or entry.get('file') != page.get('atlas'):
                out['ignored_normals'].append(
                    f"{theatre.name}: normals page {key} made for {page.get('atlas')}, library page is "
                    f"{entry and entry.get('file')}")
            if not (theatre / page['file']).exists():
                out['missing_pages'].append(f"{theatre.name}: normals page {key} {page['file']}")
    out['problems'] = sum(len(out[k]) for k in ('broken', 'write_through', 'shared_inodes', 'ignored_normals',
                                                  'missing_pages'))
    return out


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('farm', type=Path)
    ap.add_argument('bases', type=Path, nargs='+')
    ap.add_argument('--since', type=float)
    ap.add_argument('--json', type=Path)
    o = ap.parse_args(argv)
    res = check(o.farm, o.bases, o.since)
    if o.json:
        o.json.write_text(json.dumps(res, ensure_ascii=False, indent=1), encoding='utf-8')
    print(f"real {res['real_files']} links {res['links']} problems {res['problems']}")
    for key in ('broken', 'write_through', 'shared_inodes', 'ignored_normals', 'missing_pages'):
        for item in res[key][:20]:
            print(f'  {key}: {item}')
    return 1 if res['problems'] else 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
