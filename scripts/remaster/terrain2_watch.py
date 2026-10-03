#!/usr/bin/env python3
"""Keep one approved map's broker queue supplied without accepting art.

This local bookkeeping process starts no model itself. Only the existing
pipeline publishes task-owned requests, enforcing pilot/concurrency/disk/usage
gates. Do not run manual submit/ingest/reject while this watcher owns its lease;
visual approvals are safe after the reported QA phase finishes.
"""
from __future__ import annotations
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time
import terrain2_pipeline as pipeline


def needs_qa(cache):
    for raw in (cache/'tiles').glob('*/output.png'):
        report=pipeline.read(raw.parent/'qa.json',{})
        if report.get('raw_sha256')!=hashlib.sha256(raw.read_bytes()).hexdigest():
            return True
    return False


def cycle(run, cache, phase):
    """A restart checks pre-existing raw paint even if ingestion already happened."""
    phase('ingest');run('ingest')
    if needs_qa(cache):
        phase('qa');run('qa')
    phase('status');state=run('status')
    if state['generated']==state['total']:
        return 'awaiting_visual_review',state
    phase('submit');published=run('submit')
    state=run('status')
    if not published['own_pending'] and not published['submitted']:
        return 'needs_diagnosed_repair',state
    return 'waiting',state


def lease(path):
    path.parent.mkdir(parents=True,exist_ok=True)
    handle=path.open('a+')
    try:fcntl.flock(handle,fcntl.LOCK_EX|fcntl.LOCK_NB)
    except BlockingIOError:
        handle.close();raise RuntimeError('A terrain2 watcher already owns the production lease')
    return handle


def main(argv=None):
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--root',type=Path,required=True);p.add_argument('--out',type=Path,required=True)
    p.add_argument('--map',required=True);p.add_argument('--poll',type=float,default=12)
    a=p.parse_args(argv)
    if not 1<=a.poll<=60:p.error('--poll must be1..60 seconds')
    out=a.out.resolve();cache=out/a.map;directory=out/'watch'
    handle=lease(directory/'producer.lock');stopping=False
    def stop(_signal,_frame):
        nonlocal stopping;stopping=True
    signal.signal(signal.SIGTERM,stop);signal.signal(signal.SIGINT,stop)
    status_path=directory/'status.json';state={}
    def phase(name,reason=None):
        pipeline.write(status_path,dict(pid=os.getpid(),map=a.map,phase=name,
            updated_at_unix=time.time(),state=state,reason=reason,
            visual_acceptance='NEVER automatic; parent1:1 review required'))
    command=[sys.executable,'-B',str(Path(__file__).with_name('terrain2_pipeline.py')),
             '--root',str(a.root.resolve()),'--out',str(out),'--map',a.map,'--mode','full']
    def run(action):
        if stopping:raise InterruptedError('Watcher stop requested before '+action)
        result=subprocess.run(command+[action],capture_output=True,text=True)
        with (directory/'producer.log').open('a') as f:
            if action!='ingest' or result.stdout.strip()!='[]':
                f.write(f'\n{time.strftime("%Y-%m-%d %H:%M:%S")} {a.map} {action}\n'+result.stdout+result.stderr)
        if result.returncode:
            raise RuntimeError(action+': '+(result.stderr or result.stdout).strip())
        return json.loads(result.stdout)
    pipeline.note(out,f'LOCAL WATCH START pid={os.getpid()} map={a.map}; bookkeeping only; host broker cap3/default CLI unchanged. No automatic visual accept or retries. SIGTERM then wait for stopped phase before manual ledger mutations.')
    try:
        while not stopping:
            outcome,state=cycle(run,cache,phase);phase(outcome)
            if outcome!='waiting':break
            deadline=time.monotonic()+a.poll
            while not stopping and time.monotonic()<deadline:time.sleep(min(.5,deadline-time.monotonic()))
        if stopping:phase('stopped',reason='Signal received; broker image jobs retain their original receipts and may finish')
    except InterruptedError as error:phase('stopped',str(error))
    except Exception as error:
        phase('stopped_error',str(error));pipeline.note(out,f'LOCAL WATCH STOP {a.map}: {error}; no further requests, preserve logs/receipts.')
        print(str(error),file=sys.stderr);return 1
    finally:
        handle.close()
    pipeline.note(out,f'LOCAL WATCH END {a.map}: '+pipeline.read(status_path)['phase']+f'; generated={state.get("generated")}/{state.get("total")}, accepted={state.get("accepted")}; art still requires explicit review/assembly/seams.')
    print(json.dumps(pipeline.read(status_path)));return 0


if __name__=='__main__':raise SystemExit(main())
