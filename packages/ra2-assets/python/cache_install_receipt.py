"""Record reversible, independently guarded file installs in a cache farm.

Receipts are private outputs, never repository assets. JSON rollback reverses only
the recorded key changes, retaining unrelated edits made by later installations.
Binary rollback refuses a changed output rather than destroying later work.
"""

import argparse
import copy
import hashlib
import json
import os
from pathlib import Path
import shutil
import tempfile

import cache_farm

ABSENT = {"kind": "absent"}


def digest(path):
    h = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()


def state(path):
    if not path.exists() and not path.is_symlink():
        return dict(ABSENT)
    result = {'kind': 'symlink' if path.is_symlink() else 'file', 'sha256': digest(path)}
    if path.is_symlink():
        result['source'] = str(path.resolve(strict=True))
    if path.suffix == '.json':
        result['json'] = json.loads(path.read_text())
    return result


def atomic_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(mode='w', dir=path.parent, delete=False) as stream:
        temp = Path(stream.name)
        json.dump(value, stream, indent=2)
        stream.write('\n')
    try:
        os.replace(temp, path)
    finally:
        temp.unlink(missing_ok=True)


def paths(farm, scopes):
    found = set()
    for scope in scopes:
        entry = cache_farm._destination(farm, str(Path(scope) / '.receipt-boundary')).parent
        # Directory realization preserves file links and does not touch base bytes.
        for root, dirs, files in os.walk(entry, followlinks=True):
            dirs[:] = [d for d in dirs if not d.startswith('.')]
            for name in files:
                if name.startswith('.') or name.endswith('.lock'):
                    continue
                found.add(str((Path(root) / name).relative_to(farm)))
    return sorted(found)


def begin(farm, receipt, scopes):
    farm, receipt = Path(farm).absolute(), Path(receipt).absolute()
    if receipt.exists():
        raise FileExistsError(f'receipt already exists: {receipt}')
    if farm == receipt or farm in receipt.parents:
        raise ValueError('receipts and backups must stay outside the farm')
    before = {}
    backup = receipt.parent / (receipt.stem + '-backup')
    if backup.exists():
        raise FileExistsError(backup)
    for rel in paths(farm, scopes):
        item = state(farm / rel)
        if item['kind'] == 'file':
            target = backup / rel
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(farm / rel, target)
            item['backup'] = str(target)
        before[rel] = item
    atomic_json(receipt, {'version': 1, 'farm': str(farm), 'scopes': scopes,
                          'state': 'started', 'before': before})
    return len(before)


def finish(receipt):
    receipt = Path(receipt)
    data = json.loads(receipt.read_text())
    if data['state'] != 'started':
        raise ValueError('only a started receipt can be finalized')
    farm = Path(data['farm'])
    after = {rel: state(farm / rel) for rel in paths(farm, data['scopes'])}
    changed = {}
    for rel in sorted(data['before'].keys() | after.keys()):
        old, new = data['before'].get(rel, ABSENT), after.get(rel, ABSENT)
        if old['kind'] == new['kind'] and old.get('sha256') == new.get('sha256'):
            continue
        changed[rel] = {'before': old, 'after': new}
    data['changes'] = changed
    data['state'] = 'complete'
    atomic_json(receipt, data)
    return len(changed)


_MISSING = object()


def reverse_json(current, before, after, location='root'):
    if before == after:
        return copy.deepcopy(current) if current is not _MISSING else _MISSING
    added_object = before is _MISSING and isinstance(after, dict)
    if added_object:
        before = {}
    if isinstance(before, dict) and isinstance(after, dict) and isinstance(current, dict):
        result = copy.deepcopy(current)
        for key in before.keys() | after.keys():
            value = reverse_json(current.get(key, _MISSING), before.get(key, _MISSING),
                                 after.get(key, _MISSING), f'{location}.{key}')
            if value is _MISSING:
                result.pop(key, None)
            else:
                result[key] = value
        return _MISSING if added_object and not result else result
    if current != after:
        raise ValueError(f'later edit conflicts with rollback at {location}')
    return copy.deepcopy(before) if before is not _MISSING else _MISSING


def undo(receipt):
    receipt = Path(receipt)
    data = json.loads(receipt.read_text())
    if data['state'] != 'complete':
        raise ValueError('receipt must be complete and not already undone')
    farm = Path(data['farm'])
    plans = []
    # Preflight every changed file before touching any output.
    for rel, change in data['changes'].items():
        old, installed = change['before'], change['after']
        current = state(farm / rel)
        merged = None
        if 'json' in installed and 'json' in current and ('json' in old or old['kind'] == 'absent'):
            merged = reverse_json(current['json'], old.get('json', {}), installed['json'])
        elif current.get('sha256') != installed.get('sha256') or current['kind'] != installed['kind']:
            raise ValueError(f'later file edit conflicts with rollback: {rel}')
        if old['kind'] == 'file' and digest(old['backup']) != old['sha256']:
            raise ValueError(f'backup changed: {rel}')
        if old['kind'] == 'symlink' and digest(old['source']) != old['sha256']:
            raise ValueError(f'original source changed: {rel}')
        plans.append((rel, old, current, merged))
    for rel, old, current, merged in plans:
        if old['kind'] == 'absent' and merged == {}:
            cache_farm._destination(farm, rel).unlink(missing_ok=True)
        elif merged is not None and merged != old.get('json'):
            # Retain later sibling JSON keys; do not replace their document wholesale.
            def update(value, merged=merged):
                value.clear()
                value.update(merged)
            cache_farm.patch_json(farm, rel, update)
        elif old['kind'] == 'symlink':
            cache_farm.install_symlink(farm, rel, Path(old['source']))
        elif old['kind'] == 'file':
            cache_farm.install_file(farm, rel, Path(old['backup']))
        else:
            cache_farm._destination(farm, rel).unlink(missing_ok=True)
    data['state'] = 'undone'
    atomic_json(receipt, data)
    return len(plans)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command', required=True)
    start = sub.add_parser('begin')
    start.add_argument('--farm', type=Path, required=True)
    start.add_argument('--receipt', type=Path, required=True)
    start.add_argument('--scope', action='append', required=True)
    for name in ('finish', 'undo'):
        sub.add_parser(name).add_argument('--receipt', type=Path, required=True)
    args = parser.parse_args()
    result = begin(args.farm, args.receipt, args.scope) if args.command == 'begin' else globals()[args.command](args.receipt)
    print(json.dumps({'operation': args.command, 'files': result}))


if __name__ == '__main__':
    main()
