#!/usr/bin/env python3
"""A file-driven queue that runs image-model (or coding) jobs through the Codex command-line agent.

Each job is a directory holding ``prompt.txt`` and its input images; the agent works inside it and the job is done
when ``output.png`` exists. The queue file lists job directories one per line ('#' starts a comment) and is re-read
every few seconds, so jobs can be appended or reordered while the queue runs.

* A job with a ``needs`` file (one directory per line) waits until those jobs are done, then runs its ``prep.sh``
  (when present and no ``prompt.txt`` exists yet) before launching; a failing prep stops that job only.
* Slots: ``max_slots.txt`` next to the queue file (default 4) minus every live ``codex exec`` process whose ``-C``
  directory lies under ``--owned`` (so jobs left running by an earlier scheduler are counted, not relaunched).
* Up to three attempts per job. A run log that mentions a usage, rate or quota limit writes ``--limit-file`` and
  stops launching until ``--cleared-file`` is newer than it.

Usage: nohup python3 codex_queue.py QUEUE.txt --owned DIR --limit-file F --cleared-file F [--model M --effort E] &
The log goes to QUEUE.log. Job inputs and outputs derived from game files stay in untracked directories.
"""
from __future__ import annotations

import argparse
from pathlib import Path
import re
import subprocess
import time

CODEX = '/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex'
LIMIT_PATTERN = re.compile(r'(usage limit|rate limit|rate_limit|\b429\b|quota|usage_limit_reached|hit your)', re.I)
MAX_ATTEMPTS = 3


def read_queue(path: Path) -> list[Path]:
    return [Path(line.strip()) for line in path.read_text().splitlines() if line.strip() and not line.startswith('#')]


def done(job: Path) -> bool:
    return (job / 'output.png').is_file()


def ready(job: Path) -> bool:
    needs = job / 'needs'
    if not needs.exists():
        return True
    return all(done(Path(line.strip())) for line in needs.read_text().splitlines() if line.strip())


def limit_text(job: Path) -> str | None:
    """The first error line in the job's run log that reports a usage limit, if any."""
    try:
        text = (job / 'run.log').read_text(errors='ignore')
    except FileNotFoundError:
        return None
    for line in text.splitlines()[-80:]:
        if ('ERROR' in line or 'error' in line) and LIMIT_PATTERN.search(line):
            return line[:400]
    return None


def live_jobs(owned: str, ps_output: str | None = None) -> tuple[int, set[Path]]:
    """Count live codex processes working under ``owned`` and the job directories they use."""
    if ps_output is None:
        ps_output = subprocess.run(['ps', '-axo', 'command'], capture_output=True, text=True).stdout
    lines = [line for line in ps_output.splitlines()
             if 'codex exec' in line and '-C ' + owned in line and 'exec-server' not in line]
    jobs = set()
    for line in lines:
        match = re.search(r'-C (' + re.escape(owned) + r'\S*)', line)
        if match:
            jobs.add(Path(match.group(1)))
    return len(lines), jobs


def pending(jobs: list[Path], running: set[Path], attempts: dict[Path, int]) -> list[Path]:
    """Jobs to consider launching, in queue order."""
    return [job for job in jobs if not done(job) and job not in running and attempts.get(job, 0) < MAX_ATTEMPTS]


def command(job: Path, model: str | None, effort: str, codex: str = CODEX) -> list[str]:
    args = [codex, 'exec', '-s', 'workspace-write']
    if model:
        args += ['-m', model]
    return args + ['-c', f'model_reasoning_effort="{effort}"', '--skip-git-repo-check', '-C', str(job),
                   '-o', str(job / 'last.txt'), (job / 'prompt.txt').read_text()]


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('queue', type=Path)
    parser.add_argument('--owned', required=True, help='directory prefix of this queue\'s job directories')
    parser.add_argument('--limit-file', type=Path, required=True)
    parser.add_argument('--cleared-file', type=Path, required=True)
    parser.add_argument('--model')
    parser.add_argument('--effort', default='high')
    parser.add_argument('--codex', default=CODEX)
    args = parser.parse_args()
    queue = args.queue.resolve()
    log_path = queue.with_suffix('.log')

    def log(message: str) -> None:
        with open(log_path, 'a') as handle:
            handle.write(time.strftime('%H:%M:%S ') + message + '\n')

    running: dict[Path, subprocess.Popen] = {}
    attempts: dict[Path, int] = {}
    limited = args.limit_file.exists() and not args.cleared_file.exists()
    idle_logged = False
    log('start')
    while True:
        jobs = read_queue(queue)
        for job, process in list(running.items()):
            reason = limit_text(job)
            if reason and not limited:
                limited = True
                with open(args.limit_file, 'a') as handle:
                    handle.write(f"{time.strftime('%Y-%m-%d %H:%M:%S')} {queue.parent.name} {job.name}: {reason}\n")
                log(f'LIMIT HIT {job.name}: {reason}')
            if process.poll() is None:
                continue
            del running[job]
            (job / 'done.txt').write_text(f'exit {process.returncode}\n{int(time.time())}\n')
            log(('done ' if done(job) else 'failed ') + job.name + f' (attempt {attempts[job]})')
        if limited and args.cleared_file.exists() and args.cleared_file.stat().st_mtime > (
                args.limit_file.stat().st_mtime if args.limit_file.exists() else 0):
            limited = False
            log('limit cleared')
        try:
            slots = int((queue.parent / 'max_slots.txt').read_text().strip())
        except (OSError, ValueError):
            slots = 4
        live, live_dirs = live_jobs(args.owned)
        free = slots - live
        todo = pending(jobs, set(running) | live_dirs, attempts)
        if not todo and not running and not idle_logged:
            log('queue empty; idle')
        idle_logged = not todo and not running
        for job in todo:
            if free <= 0 or limited:
                break
            if not ready(job):
                continue
            if (job / 'prep.sh').exists() and not (job / 'prompt.txt').exists():
                prep = subprocess.run(['bash', str(job / 'prep.sh')], capture_output=True, text=True)
                if prep.returncode != 0:
                    log(f'prep failed {job.name}: {prep.stderr[-300:]}')
                    attempts[job] = MAX_ATTEMPTS
                    continue
            (job / 'started.txt').write_text(f'{int(time.time())}\n')
            with open(job / 'run.log', 'w') as out:
                running[job] = subprocess.Popen(command(job, args.model, args.effort, args.codex), cwd=job,
                                                stdin=subprocess.DEVNULL, stdout=out, stderr=subprocess.STDOUT)
            attempts[job] = attempts.get(job, 0) + 1
            free -= 1
            log(f'launched {job.name} (attempt {attempts[job]})')
        time.sleep(5)


if __name__ == '__main__':
    main()
