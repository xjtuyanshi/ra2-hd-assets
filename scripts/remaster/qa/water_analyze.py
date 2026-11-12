"""Offline water boards and acceptance. Uses the supplied wmeasure.py by path, never copies it."""
import argparse
from collections import deque
import contextlib
import io
import json
import math
from pathlib import Path
import runpy
import subprocess
import sys
import numpy as np
from PIL import Image, ImageDraw, ImageFont

SCENES = ['g2', 'alca', 'isle', 'beach', 'bay', 'gold', 'pac2', 'fleet', 'night']
LOOKS = ['original', 'enhanced', 'faithful', 'muted', 'calm']
LABELS = ['原版', '当前', '忠实版', '柔和增强', '平静海面']

def run(args):
    subprocess.run(args, check=True, stdout=subprocess.DEVNULL)

def mask_morph(mask, radius, operation):
    # Binary square morphology via summed areas: identical edge replication without a quadratic large-kernel scan.
    size=2*radius+1
    padded=np.pad(mask.astype(np.int32),radius,mode='edge')
    integral=np.pad(padded,((1,0),(1,0))).cumsum(0).cumsum(1)
    count=integral[size:,size:]-integral[:-size,size:]-integral[size:,:-size]+integral[:-size,:-size]
    return count==size*size if operation=='e' else count>0

def gates(s, o):
    checks = {'sat': s['hsvS'] <= o['hsvS'] + .15, 'mean_L': abs(s['L']-o['L']) <= 4,
              'std_L': s['Lstd'] <= 4, 'p99_med': s['p99_med'] <= 10,
              'highlights': s['highlight_frac'] <= .01,
              'anisotropy': None if s['spectrum'] is None else s['spectrum']['anisotropy'] <= .45,
              'wavelength': None if s['spectrum'] is None else s['spectrum']['wavelength_gpx'] <= 6,
              'motion_1_6': s['motion_1_6'] <= .8, 'motion_1s': s['motion_1s'] <= 2,
              'shore': None if s['shore_step'] is None or o['shore_step'] is None else s['shore_step'] >= .8*o['shore_step'] and (o['shore_step'] <= 0 or s['shore_step'] > 0)}
    return {k: 'UNVERIFIED' if v is None else 'PASS' if v else 'FAIL' for k,v in checks.items()}

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('manifest'); ap.add_argument('--measure', required=True); ap.add_argument('--font', required=True)
    args = ap.parse_args()
    m = json.loads(Path(args.manifest).read_text()); out = Path(m['out']); out.mkdir(parents=True, exist_ok=True)
    # wmeasure's CLI is tied to historical input directories. Load its functions without CLI cases.
    previous = sys.argv; sys.argv = [args.measure]
    try:
        with contextlib.redirect_stdout(io.StringIO()): w = runpy.run_path(args.measure)
    finally: sys.argv = previous
    font = ImageFont.truetype(args.font, 24)
    result = {}; rows = ['| Scene | Encode | Look | L | Sat | Std | p99-med | Highlight | Anisotropy | Wavelength | Motion 1/6s | Motion 1s | Shore | Gates |', '|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|']
    for name in SCENES:
        scene = m.get('scenes', {}).get(name)
        result[name] = {}
        if not scene or scene.get('missing'):
            result[name] = {'missing': (scene or {}).get('missing', 'Not configured')}; continue
        d = out/name
        try:
            pictures = [Image.open(d/f'{look}.png').convert('RGB') for look in LOOKS]
            width, height = pictures[0].size
            if any(im.size != (width,height) for im in pictures): raise ValueError('Board dimensions differ')
            board = Image.new('RGB', (width+160, height*5), '#161616')
            crop = scene['shoreCrop']; crops = Image.new('RGB', (crop['width']*2+160, crop['height']*2*5), '#161616')
            for i, im in enumerate(pictures):
                board.paste(im, (160,i*height)); ImageDraw.Draw(board).text((8,i*height+8), LABELS[i], font=font)
                box=(crop['x'],crop['y'],crop['x']+crop['width'],crop['y']+crop['height'])
                crops.paste(im.crop(box).resize((crop['width']*2,crop['height']*2), Image.Resampling.NEAREST), (160,i*crop['height']*2))
                ImageDraw.Draw(crops).text((8,i*crop['height']*2+8),LABELS[i],font=font)
            board.save(d/'board.png'); crops.save(d/'shore-2x.png')
            inputs=[]
            for look in LOOKS: inputs += ['-i',str(d/f'{look}.mkv')]
            # Scale the whole side-by-side comparison to fit 1080p; no sharpening.
            run(['ffmpeg','-nostdin','-y',*inputs,'-filter_complex','hstack=inputs=5[v]','-map','[v]','-an','-c:v','ffv1',str(d/'comparison.mkv')])
            run(['ffmpeg','-nostdin','-y','-i',str(d/'comparison.mkv'),'-vf','scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2','-c:v','libx264','-pix_fmt','yuv420p','-b:v','4M','-maxrate','4M','-bufsize','8M',str(d/'comparison-1080p.mp4')])
            # Measure each look at full 1080p separately; tiled preview is for the owner's display only.
            for look in LOOKS:
                run(['ffmpeg','-nostdin','-y','-i',str(d/f'{look}.mkv'),'-vf','scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2','-c:v','libx264','-pix_fmt','yuv420p','-b:v','4M','-maxrate','4M','-bufsize','8M',str(d/f'{look}-1080p.mp4')])
            for encode in ['lossless','h264']:
                scores={}
                for look in LOOKS:
                    frames=d/f'{look}-{encode}'; frames.mkdir(exist_ok=True)
                    src=d/(f'{look}.mkv' if encode=='lossless' else f'{look}-1080p.mp4')
                    # Preserve actual cadence; do not synthesize frames with an fps filter.
                    probe=json.loads(subprocess.check_output(['ffprobe','-v','error','-count_frames','-show_streams','-of','json',str(src)]))['streams'][0]
                    rate=probe['avg_frame_rate'].split('/'); fps=float(rate[0])/float(rate[1])
                    if abs(fps-30)>.01 or int(probe['nb_read_frames']) != 120: raise ValueError(f'{src}: expected 120 real frames at 30fps, got {probe["nb_read_frames"]} at {fps}')
                    run(['ffmpeg','-nostdin','-y','-i',str(src),'-frames:v','120',str(frames/'%03d.png')])
                    image=np.asarray(Image.open(frames/'001.png').convert('RGB')).astype(float)
                    water=Image.open(scene['waterMask']).convert('L'); core=Image.open(scene['coreMask']).convert('L')
                    if water.size != (width,height) or core.size != (width,height): raise ValueError('Masks must match native captured dimensions')
                    scale=1.; pad_x=pad_y=0
                    if encode=='h264':
                        scale=min(1920/width,1080/height); nw,nh=round(width*scale),round(height*scale); pad_x=(1920-nw)//2; pad_y=(1080-nh)//2
                        def fitted(im):
                            dst=Image.new('L',(1920,1080)); dst.paste(im.resize((nw,nh),Image.Resampling.NEAREST),(pad_x,pad_y)); return dst
                        water,core=fitted(water),fitted(core)
                    water=np.asarray(water)>127; core=np.asarray(core)>127
                    if not core.any() or np.any(core & ~mask_morph(water,max(1,round(4*2.5*scale)),'e')): raise ValueError('Empty core or core not four game pixels inside water')
                    key=f'{name}-{encode}'; w['SCALE'][key]=2.5*scale
                    L,*_=w['lab'](image); st=w['stats'](image,core); med=np.median(L[core]); st['p99_med']=float(np.percentile(L[core],99)-med); st['highlight_frac']=float(((L[core]-med)>15).mean()); st['spectrum']=w['spectral'](L,core,key)
                    if st['spectrum'] and any(st['spectrum'].get(k) is None or not math.isfinite(st['spectrum'][k]) for k in ['anisotropy','wavelength_gpx']): st['spectrum']=None
                    temporal = deque(maxlen=31)
                    differences = {5: [], 30: []}
                    for index in range(1,121):
                        current,*_=w['lab'](np.asarray(Image.open(frames/f'{index:03}.png').convert('RGB'))[core].astype(float))
                        current=current.astype(np.float32)
                        for lag in differences:
                            if len(temporal)>=lag: differences[lag].append(float(np.abs(current-temporal[-lag]).mean()))
                        temporal.append(current)
                    for lag,label in [(5,'motion_1_6'),(30,'motion_1s')]:
                        st[label]=float(np.mean(differences[lag]))
                    r=lambda n: max(1,round(n*2.5*scale))
                    land=mask_morph(water,r(6),'d') & ~mask_morph(water,r(2),'d')
                    wet=mask_morph(water,r(2),'e') & ~mask_morph(water,r(6),'e')
                    st['shore_step']=float(np.median(L[land & (L>8)])-np.median(L[wet])) if (land & (L>8)).sum()>200 and wet.sum()>200 else None
                    st['pool_hue']='UNVERIFIED'
                    if scene.get('poolMask'):
                        pool=Image.open(scene['poolMask']).convert('L')
                        if pool.size != (width,height): raise ValueError('Pool mask size differs')
                        if encode=='h264': pool=fitted(pool)
                        pool=np.asarray(pool)>127
                        if not pool.any(): raise ValueError('Empty pool mask')
                        st['pool_hue']=w['stats'](image,pool)['hue']
                    scores[look]=st
                for look,st in scores.items():
                    st['gates']=gates(st,scores['original']); sp=st['spectrum'] or {}
                    original_pool=scores['original']['pool_hue']
                    if isinstance(st['pool_hue'],(int,float)) and isinstance(original_pool,(int,float)):
                        st['pool_hue_delta']=abs((st['pool_hue']-original_pool+180)%360-180)
                        st['gates']['pool_hue']='PASS' if st['pool_hue_delta']<=8 else 'FAIL'
                    elif name=='gold': st['gates']['pool_hue']='UNVERIFIED'
                    values=[st['L'],st['hsvS'],st['Lstd'],st['p99_med'],st['highlight_frac'],sp.get('anisotropy'),sp.get('wavelength_gpx'),st['motion_1_6'],st['motion_1s'],st['shore_step']]
                    rows.append('| '+ ' | '.join([name,encode,look,*['UNVERIFIED' if v is None else f'{v:.4f}' for v in values],', '.join(f'{k}:{v}' for k,v in st['gates'].items())])+' |')
                result[name][encode]=scores
        except Exception as e: result[name]['error']=str(e)
    for look in ['enhanced','faithful','muted']:
        f=out/'fleet'/f'{look}-fps.json'
        try:
            perf=json.loads(f.read_text()); samples=perf['samples']
            if perf['slider'] != 5 or perf['durationSeconds'] < 60 or sum(s['intervalMs'] for s in samples) < 60000 or perf['state'] != m['scenes']['fleet']['state'] or not samples or any(s['logicFps'] is None for s in samples): raise ValueError('Invalid 60s same-state slider-5 evidence')
            result.setdefault('fleet',{}).setdefault('fps',{})[look]={'logicFps':sum(s['logicFps']*s['intervalMs'] for s in samples)/sum(s['intervalMs'] for s in samples),'target':60}
        except Exception as e: result.setdefault('fleet',{}).setdefault('fps',{})[look]={'error':str(e),'status':'UNVERIFIED'}
    (out/'metrics.json').write_text(json.dumps(result,indent=2,allow_nan=False))
    (out/'SUMMARY.md').write_text('\n'.join(rows)+'\n\nMissing/errors:\n'+ '\n'.join(f'- {n}: {v.get("missing",v.get("error"))}' for n,v in result.items() if 'missing' in v or 'error' in v)+'\n\nFleet FPS:\n```json\n'+json.dumps(result.get('fleet',{}).get('fps',{}),indent=2)+'\n```\n')
    if any('error' in v or 'missing' in v for v in result.values()) or any('error' in v for v in result.get('fleet',{}).get('fps',{}).values()): return 1
    if any(value != 'PASS' for scene in result.values() for encode in ['lossless','h264'] for score in scene.get(encode,{}).values() for value in score.get('gates',{}).values()): return 1
    return 0

if __name__=='__main__': sys.exit(main())
