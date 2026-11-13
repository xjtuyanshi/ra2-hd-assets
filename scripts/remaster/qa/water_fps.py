"""Extract one bounded native game-counter window from existing speed telemetry."""
import argparse
import datetime as dt
import hashlib
import json
from pathlib import Path

def timestamp(value):
    return dt.datetime.fromisoformat(value.replace('Z', '+00:00')).timestamp()

def extract(records, start, end):
    samples = [r for r in records if r.get('kind') == 'speed' and start <= timestamp(r['time']) - r['windowMs']/1000 and timestamp(r['time']) <= end]
    if not samples or any(r.get('logicSource') != 'game' or r.get('targetFps') != 60 or not r.get('hdShown') or r['windowMs'] <= 0 for r in samples):
        raise ValueError('Need native game-counter, target-60, HD-shown telemetry throughout the window')
    if sum(r['windowMs'] for r in samples) < 60000:
        raise ValueError('Less than 60 seconds of measured native windows')
    for a,b in zip(samples,samples[1:]):
        if abs(timestamp(b['time']) - b['windowMs']/1000 - timestamp(a['time'])) > .25:
            raise ValueError('Gapped or overlapping native windows')
    return [{'logicFps':r['logicFps'],'intervalMs':r['windowMs']} for r in samples]

def main():
    ap=argparse.ArgumentParser(); ap.add_argument('--log',required=True); ap.add_argument('--start',required=True); ap.add_argument('--end',required=True); ap.add_argument('--state',required=True); ap.add_argument('--out',required=True)
    a=ap.parse_args(); raw=Path(a.log).read_bytes(); records=[json.loads(line) for line in raw.splitlines() if line.strip()]
    samples=extract(records,timestamp(a.start),timestamp(a.end))
    result={'state':a.state,'slider':5,'durationSeconds':sum(s['intervalMs'] for s in samples)/1000,'samples':samples,'source':str(Path(a.log).resolve()),'sourceSha256':hashlib.sha256(raw).hexdigest(),'start':a.start,'end':a.end}
    Path(a.out).write_text(json.dumps(result,indent=2)+'\n')
if __name__=='__main__': main()
