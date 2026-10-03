"""Resumable, disk-gated driver for the existing local hd:prepare pipeline."""
import argparse
import json
import os
from pathlib import Path
import shlex
import signal
import subprocess
import time


def write_json(path, value):
    temporary = path.with_suffix(path.suffix + '.tmp')
    temporary.write_text(json.dumps(value, indent=2) + '\n')
    temporary.replace(path)


def disk_receipt(root):
    result = subprocess.run(['df', '-k', str(root)], capture_output=True, text=True, check=True)
    available = int(result.stdout.splitlines()[-1].split()[3]) * 1024
    return {'checked_at_unix': time.time(), 'availableBytes': available, 'df': result.stdout}


def output_size(directory):
    return sum(path.stat().st_size for path in directory.rglob('*') if path.is_file()) if directory.exists() else 0


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', required=True)
    parser.add_argument('--out', required=True)
    parser.add_argument('--steps', default='extract,terrain,upscale,sprites',
                        choices=['extract,terrain', 'extract,terrain,upscale,sprites'])
    parser.add_argument('--blocked-reason', default='')
    args = parser.parse_args()
    root, out = Path(args.root).resolve(), Path(args.out).resolve()
    inventory = json.loads((out / 'INVENTORY.json').read_text())
    maps = inventory['maps']
    (out / '_logs').mkdir(exist_ok=True)
    history = out / 'DISK_RECEIPTS.jsonl'
    resume = ['python3', str(Path(__file__).resolve()), '--root', str(root), '--out', str(out)]
    status = {'state': 'running', 'started_at_unix': time.time(), 'pid': os.getpid(),
              'steps': args.steps, 'total': len(maps), 'blocked_reason': args.blocked_reason}

    def save_receipt():
        receipt = disk_receipt(root)
        with history.open('a') as log:
            log.write(json.dumps(receipt) + '\n')
        status['freeGiB'] = round(receipt['availableBytes'] / 1024 ** 3, 3)
        return receipt['availableBytes']

    def publish():
        status['updated_at_unix'] = time.time()
        status['completed'] = sum(row['status'] == 'done' for row in maps)
        status['terrain_ready'] = sum(row['status'] in ('done', 'partial-gpu-blocked') for row in maps)
        write_json(out / 'INVENTORY.json', inventory)
        write_json(out / 'STATUS.json', status)
        table = ['# Multiplayer map preparation', '',
                 'Derived local assets only. Full completion requires all four requested steps.', '',
                 '| Map | Theatre | Size (cells) | Status | Time (s) | Output MiB | Errors / remaining work |',
                 '| --- | --- | --- | --- | ---: | ---: | --- |']
        for row in maps:
            size = row['size']
            error = '; '.join(row['errors']).replace('|', '/').replace('\n', ' ')[:500]
            table.append(f"| {row['id']} | {row['theater']} | {size['width']}x{size['height']} | "
                         f"{row['status']} | {row['elapsedSeconds']:.2f} | {row['outputBytes']/1024**2:.2f} | {error} |")
        (out / 'MAPS.md').write_text('\n'.join(table) + '\n')
        notes = f"""# Task 9 — multiplayer map preparation

Status: {status['state']}. Fully completed: {status['completed']} / {len(maps)}.
Terrain-ready: {status['terrain_ready']} / {len(maps)}. Free disk: {status.get('freeGiB')} GiB.
Current map: {status.get('current_map', 'none')}. Current steps: {args.steps}.

## Work and evidence
- Read CLAUDE.md, the HD bridge preparation guide, ra2-assets README, and testing guide.
- Inventory scanned 74 local archive/container nodes and loose maps; includes co-op multiplayer scenarios.
- Eleven map filenames were unavailable; stable archived CRC ids preserve every detected multiplayer map.
- Original source bytes and SHA-256 are staged in _sources/; player installation is read-only.
- Initial disk exceeded 40 GiB; actual df is recorded before every map and every five seconds while running.
- Stop below 30 GiB. DISK_RECEIPTS.jsonl and START_RECEIPT.json preserve receipts.
- Per-map prepare.json, _logs/, INVENTORY.json and MAPS.md retain timings, errors and output sizes.
- Original four-step pilot failed at upscale: pilot-XMP29U2.log and PILOT_RECEIPT.json.
- The installed executable also rejected CPU mode (-g -1): cpu-probe.log; no fake scaling fallback.
- No image-model sessions were launched; the codex-exec process gate is therefore not used.
- No writes to hd-cache-s2, no browser, no live matches, no ports, no push or merge.

## Resume commands
```bash
{shlex.join(resume)}
```
Run that exact four-step command on the host with Metal available. It reuses current extraction/terrain.
For sandbox-only extraction and terrain, append --steps extract,terrain --blocked-reason \
{shlex.quote(args.blocked_reason or 'Metal/Vulkan unavailable in child sandbox')}.
An incomplete extraction is retried with --force automatically; successful partial steps are retained.

## Code checkout
Independent local checkout: ROOT/.worktrees/s2x-task9-maps, branch codex/s2x-task9-maps,
based on remaster ffc7480. Parent .git is read-only; direct worktree registration failed.
Existing dependency links are reused; invoke pnpm with --config.verify-deps-before-run=false
inside that checkout to avoid pnpm trying to replace shared node_modules. No dependencies changed.

## Open problems
- {args.blocked_reason or 'See per-map errors.'}
- thememd.mix is an audio container rejected by the MIX parser; explicitly recorded in inventory errors.
- Every partial-gpu-blocked map still needs both upscale and sprites. Those steps are not passes.
- HEADLESS preparation is not an AI material redraw or art-director acceptance.

## NEEDS LIVE CHECK
UNVERIFIED: Claude must validate each theatre, map seams, water masks, sprite colour/remap,
large texture support, loading and performance in real matches. This task must remain headless.
"""
        (out / 'NOTES.md').write_text(notes)

    if save_receipt() <= 40 * 1024 ** 3:
        status.update(state='blocked', blocked_reason='Start gate requires more than 40 GiB free')
        publish()
        return
    publish()
    for row in maps:
        if row['status'] == 'done' or (args.steps == 'extract,terrain' and row['status'] == 'partial-gpu-blocked'):
            continue
        if save_receipt() < 30 * 1024 ** 3:
            status.update(state='incomplete', blocked_reason='Disk stop threshold: below 30 GiB')
            break
        status['current_map'] = row['id']
        row['status'] = 'running'
        publish()
        command = ['pnpm', 'hd:prepare', '--', '--map', row['input'], '--game', inventory['game'],
                   '--cache', str(out), '--bin', str(root / 'gameres/tools/realesrgan/realesrgan-ncnn-vulkan'),
                   '--steps', args.steps]
        directory = out / row['id']
        if directory.exists() and not (directory / 'manifest.json').is_file():
            command.append('--force')
        started = time.monotonic()
        log_path = out / '_logs' / f"{row['id']}-{int(time.time())}.log"
        row['command'] = command
        row['log'] = str(log_path)
        interrupted = False
        with log_path.open('w') as log:
            process = subprocess.Popen(command, cwd=root, stdin=subprocess.DEVNULL, stdout=log,
                                       stderr=subprocess.STDOUT, start_new_session=True)
            while process.poll() is None:
                time.sleep(5)
                if save_receipt() < 30 * 1024 ** 3:
                    interrupted = True
                    os.killpg(process.pid, signal.SIGTERM)
                    try:
                        process.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        os.killpg(process.pid, signal.SIGKILL)
                        process.wait()
                publish()
        row['elapsedSeconds'] += time.monotonic() - started
        row['outputBytes'] = output_size(directory)
        if interrupted:
            row.update(status='interrupted-disk', errors=['Stopped below 30 GiB; rerun to resume'])
            status.update(state='incomplete', blocked_reason='Disk stop threshold: below 30 GiB')
            publish()
            break
        if process.returncode:
            row.update(status='failed', errors=[log_path.read_text()[-2000:]])
        elif args.steps == 'extract,terrain':
            row.update(status='partial-gpu-blocked', errors=[args.blocked_reason or 'Upscale and sprites not yet run'])
        else:
            row.update(status='done', errors=[])
        print(f"{row['id']}: {row['status']} ({row['elapsedSeconds']:.1f}s, {row['outputBytes']/1024**2:.1f} MiB)", flush=True)
        publish()
    if status['state'] == 'running':
        status['state'] = 'done' if all(row['status'] == 'done' for row in maps) else 'blocked'
    status['current_map'] = None
    publish()
    print(json.dumps(status), flush=True)


if __name__ == '__main__':
    main()
