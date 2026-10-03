"""Publish JSON commands to a file-driven driver; optionally wait for its result.

The transport is independent of browser, game, and command vocabulary.
The caller owns the run directory and must start its own compatible driver.
"""

import argparse
import json
import os
from pathlib import Path
import sys
import time
import uuid


def submit(run, command):
    if not isinstance(command, (dict, list)):
        raise ValueError('command must be a JSON object or array')
    run = Path(run)
    ident = f'c{time.time_ns()}-{uuid.uuid4().hex}'
    # Like the original client, require the driver's cmd/done directories to exist.
    if not (run / 'cmd').is_dir() or not (run / 'done').is_dir():
        raise FileNotFoundError('driver cmd/ and done/ directories are missing')
    tmp = run / 'cmd' / f'{ident}.tmp'
    target = tmp.with_suffix('.json')
    try:
        tmp.write_text(json.dumps(command), encoding='utf-8')
        os.replace(tmp, target)
    finally:
        tmp.unlink(missing_ok=True)
    return target.name


def wait_result(run, name, timeout=60, interval=0.25):
    if Path(name).name != name or not name.endswith('.json'):
        raise ValueError('expected a command JSON filename')
    result = Path(run) / 'done' / f'{name}.result'
    deadline = time.monotonic() + timeout
    while not result.is_file():
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError(f'TIMEOUT: resume waiting for {name}')
        time.sleep(min(interval, remaining))
    return result


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--run', type=Path, required=True)
    inputs = parser.add_mutually_exclusive_group(required=True)
    inputs.add_argument('--json')
    inputs.add_argument('--file', type=Path)
    inputs.add_argument('--wait', help='resume waiting for an already submitted .json filename')
    parser.add_argument('--timeout', type=float, default=60)
    parser.add_argument('--result-file', action='store_true', help='print result path instead of contents')
    args = parser.parse_args(argv)
    if args.timeout < 0:
        parser.error('--timeout must be nonnegative')
    name = args.wait or submit(args.run, json.loads(args.json if args.json is not None else args.file.read_text()))
    print(name, file=sys.stderr)
    try:
        result = wait_result(args.run, name, args.timeout)
    except TimeoutError as error:
        print(error, file=sys.stderr)
        return 1
    print(result if args.result_file else result.read_text())
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
