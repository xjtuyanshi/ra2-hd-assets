#!/usr/bin/env python3
"""Resume the terrain2 asset task through the coordinator's exact image CLI broker.

Requests only describe existing local inputs. This script never starts a model,
modifies the shared broker/counter, accepts art automatically, or installs caches.
"""
from __future__ import annotations
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import shutil
import sys
import time
import uuid
from PIL import Image
import numpy as np
Image.MAX_IMAGE_PIXELS=None


def read(path, fallback=None):
    return json.loads(path.read_text()) if path.exists() else fallback


def write(path, value):
    path.parent.mkdir(parents=True,exist_ok=True)
    temporary=path.with_name(path.name+'.'+uuid.uuid4().hex+'.tmp')
    temporary.write_text(json.dumps(value,indent=2,ensure_ascii=False,allow_nan=False)+'\n')
    temporary.replace(path)


def note(out, message):
    with (out/'NOTES.md').open('a') as f:f.write(f'\n- {time.strftime("%Y-%m-%d %H:%M:%S")} {message}\n')


def own_pending(requests):
    result=[]
    for path in requests.glob('task1-*.json'):
        if path.name.endswith('.receipt.json'):continue
        receipt=read(path.with_name(path.stem+'.receipt.json'),{})
        if receipt.get('state') not in ('exited','rejected'):result.append(path.stem)
    return result


def module(root):
    folder=root/'packages/ra2-assets/python';sys.path.insert(0,str(folder))
    import terrain_tile_qa
    return terrain_tile_qa


def submit(args, out, cache, requests, ledger):
    if args.mode=='full':
        pilots=[Path(s).name for s in (cache/'pilots.txt').read_text().splitlines() if s]
        if any(not read(cache/'tiles'/t/'qa.json',{}).get('accepted') for t in pilots):
            raise SystemExit('Both ordered pilots must pass numerical AND visual QA first')
    if shutil.disk_usage(out).free<15*2**30:raise SystemExit('Disk below15GiB: pause image-heavy requests')
    if (out/'USAGE_LIMIT.txt').exists():raise SystemExit('Task usage-limit stop marker present')
    pending=own_pending(requests);slots=max(0,3-len(pending));submitted=[]
    # Persist intent before publication. Recover a kill between the ledger write
    # and request rename by publishing the SAME job/id, never a duplicate edit.
    for attempts in ledger.values():
        if not slots:break
        job=attempts[-1]
        request_path=requests/(job['id']+'.json')
        if job['state']=='queued' and not request_path.exists():
            directory=Path(job['job_dir'])
            write(request_path,{'task_id':'task1','job_dir':str(directory.resolve()),'prompt_file':str((directory/'prompt.txt').resolve())})
            submitted.append(job['id']);slots-=1
            note(out,f'RECOVER REQUEST publication {job["id"]}; same immutable job, no new image session.')
    queue=cache/'pilots.txt' if args.mode=='pilots' else cache/'tiles/queue.txt'
    for entry in queue.read_text().splitlines():
        tile=Path(entry);name=tile.name
        if not slots:break
        if (tile/'output.png').exists():continue
        prior=ledger.get(name,[])
        if prior and prior[-1].get('state') in ('queued','running','exited'):continue
        if prior and not args.retry_note:continue
        attempt=len(prior)+1;request_id=f'task1-{args.map}-{name}-a{attempt:03d}-{uuid.uuid4().hex[:10]}'
        job=cache/'jobs'/name/f'a{attempt:03d}-{request_id.rsplit("-",1)[1]}'
        job.mkdir(parents=True,exist_ok=False);shutil.copy2(tile/'input.png',job/'input.png')
        prompt=(tile/'prompt.txt').read_text()
        prompt='This is a self-contained SINGLE IMAGE EDIT. All style/task context is supplied below. Do not inspect unrelated files or memory/history. Read only ROOT/CLAUDE.md as required, then view input.png and use imagegen/edit. Save output.png here.\n\n'+prompt
        prompt+='\nUse the image_gen/imagegen image EDIT tool with THIS DIRECTORY/input.png as the supplied local reference. Save the actual generated image as THIS DIRECTORY/output.png at1536x1024. Do not replace image generation with filters, code textures or source sharpening.\n'
        if args.retry_note:prompt+='\nParent rejection to repair while preserving the immutable original reference: '+args.retry_note+'\n'
        (job/'prompt.txt').write_text(prompt)
        request={'task_id':'task1','job_dir':str(job.resolve()),'prompt_file':str((job/'prompt.txt').resolve())}
        item={'id':request_id,'job_dir':str(job),'state':'queued','attempt':attempt,'input_sha256':hashlib.sha256((job/'input.png').read_bytes()).hexdigest()}
        ledger.setdefault(name,[]).append(item);write(cache/'jobs-ledger.json',ledger)
        write(requests/(request_id+'.json'),request)
        submitted.append(request_id);slots-=1
        note(out,f'BROKER REQUEST {request_id}; fresh job={job}; own queued/running cap3; source untouched; {args.mode} mode. Global process gate waived by latest human for task1 ONLY.')
    print(json.dumps({'submitted':submitted,'own_pending':own_pending(requests)}))


def ingest(args,out,cache,requests,ledger):
    results=[]
    for name,attempts in ledger.items():
        for job in attempts:
            if job.get('ingested') or job.get('state') in ('failed','rejected'):continue
            receipt=read(requests/(job['id']+'.receipt.json'),{})
            if not receipt:continue
            job['state']=receipt['state'];job['receipt']=receipt
            if receipt.get('usage_limit'):
                marker='USAGE LIMIT: '+job['id']+'; see '+str(Path(job['job_dir'])/'broker.log')
                (out/'USAGE_LIMIT.txt').write_text(marker+'\n');notes=out/'NOTES.md';notes.write_text(marker+'\n\n'+notes.read_text())
                write(cache/'jobs-ledger.json',ledger);raise SystemExit(marker)
            if receipt['state'] not in ('exited','rejected'):continue
            directory=Path(job['job_dir']);image=directory/'output.png'
            if receipt['state']=='rejected' or not image.exists():
                job['state']='failed';job['failure']='broker rejected or missing actual output';results.append([name,'failed'])
                note(out,f'IMAGE FAILED {job["id"]}; no deliverable; preserve log/receipt; retry requires diagnosis and fresh directory.')
                continue
            try:
                with Image.open(image) as im:
                    if im.size!=(1536,1024):raise ValueError(f'output dimensions{im.size}')
                    im.verify()
                if hashlib.sha256((directory/'input.png').read_bytes()).hexdigest()!=job['input_sha256']:
                    raise ValueError('image job modified immutable input')
            except Exception as error:
                job['state']='failed';job['failure']=str(error);results.append([name,'failed']);continue
            target=cache/'tiles'/name/'output.png'
            if target.exists():
                if hashlib.sha256(target.read_bytes()).digest()!=hashlib.sha256(image.read_bytes()).digest():
                    raise SystemExit(f'Refuse to overwrite different canonical output {target}')
            else:shutil.copy2(image,target)
            job['ingested']=True;job['state']='ingested'
            results.append([name,'actual PNG ingested'])
            note(out,f'IMAGE RESULT {job["id"]}: actual PNG copied, NOT accepted yet. Raw job remains immutable; producer receipt rc={receipt.get("exit_code")}.')
    write(cache/'jobs-ledger.json',ledger);print(json.dumps(results))


def qa(args,out,cache,requests,ledger):
    tool=module(Path(__file__).resolve().parents[2])
    source=tool.tt.load_image(cache/'source.png','RGBA');current=tool.tt.load_image(cache/'current-hd.png','RGBA');water=tool.tt.load_image(cache/'water-mask.png','L')
    reports=[]
    for raw in sorted((cache/'tiles').glob('*/output.png')):
        directory=raw.parent;meta=read(directory/'tile.json');previous=read(directory/'qa.json',{})
        sha=hashlib.sha256(raw.read_bytes()).hexdigest()
        if previous.get('raw_sha256')==sha:continue
        x,y=meta['x'],meta['y'];rgb=tool.tt.load_image(raw,'RGB');h,w=rgb.shape[:2]
        reference=source[y:y+h,x:x+w];wm=water[y:y+h,x:x+w]
        result,report=tool.condition(reference,rgb,wm)
        report.update(tile=directory.name,raw_sha256=sha,raw_file=str(raw),conditioned_file=str(directory/'conditioned.png'))
        Image.fromarray(result).save(directory/'conditioned.png');write(directory/'qa.json',report)
        tool.review_board(reference,current[y:y+h,x:x+w],result,wm,directory/'qa-board.png',directory.name)
        reports.append({'tile':directory.name,'gain':report['texture_gain'],'dE':report['lowfreq_dE_mean'],'ecc':report['registration_ecc'],'pass':report['numerical_pass']})
        note(out,f'NUMERICAL QA {args.map}/{directory.name}: gain={report["texture_gain"]}; dE={report["lowfreq_dE_mean"]:.3f}; numerical_pass={report["numerical_pass"]}; VISUAL PENDING, not counted accepted.')
    print(json.dumps(reports))


def review(args,out,cache,requests,ledger):
    if not args.tiles or not args.review_note:raise SystemExit('--tiles and --review-note required')
    for name in args.tiles.split(','):
        directory=cache/'tiles'/name;report=read(directory/'qa.json',{})
        if args.action=='approve':
            if not report.get('numerical_pass'):raise SystemExit(f'Cannot accept numerical failure {name}')
            report.update(accepted=True,visual_status='ACCEPTED by parent1:1 review',visual_review=args.review_note)
            write(directory/'qa.json',report);note(out,f'VISUAL ACCEPT {args.map}/{name}: {args.review_note}')
        else:
            archive=directory/'rejected'/(time.strftime('%Y%m%dT%H%M%S')+'-'+uuid.uuid4().hex[:8]);archive.mkdir(parents=True,exist_ok=False)
            for f in ['output.png','conditioned.png','qa.json','qa-board.png']:
                if (directory/f).exists():shutil.move(directory/f,archive/f)
            (archive/'rejection.txt').write_text(args.review_note+'\n')
            if ledger.get(name):ledger[name][-1]['state']='rejected'
            note(out,f'VISUAL/NUMERICAL REJECT {args.map}/{name}: {args.review_note}; immutable evidence={archive}')
    write(cache/'jobs-ledger.json',ledger)
    status(args,out,cache,requests,ledger)


def status(args,out,cache,requests,ledger):
    queue=[Path(s) for s in (cache/'tiles/queue.txt').read_text().splitlines() if s]
    result={'map':args.map,'total':len(queue),'generated':sum((p/'output.png').exists() for p in queue),'numerical_pass':sum(read(p/'qa.json',{}).get('numerical_pass',False) for p in queue),'accepted':sum(read(p/'qa.json',{}).get('accepted',False) for p in queue),'own_pending':own_pending(requests),'failed':[name for name,jobs in ledger.items() if jobs[-1]['state'] in ('failed','rejected')]}
    write(cache/'production-status.json',result)
    maps=[]
    for queue_path in sorted(out.glob('*/tiles/queue.txt')):
        directory=queue_path.parent.parent;tiles=[Path(v) for v in queue_path.read_text().splitlines() if v]
        maps.append({'map':directory.name,'total':len(tiles),'generated':sum((t/'output.png').exists() for t in tiles),
                     'accepted':sum(read(t/'qa.json',{}).get('accepted',False) for t in tiles),
                     'completed':read(directory/'final-qa.json',{}).get('accepted',False)})
    previous=read(out/'FINAL.json',{})
    completed=sum(m['completed'] for m in maps);usage=(out/'USAGE_LIMIT.txt').exists()
    final={'state':'done' if completed==6 else ('blocked' if usage else 'incomplete'),
           'summary':f'{completed}/6 maps delivered;{sum(m["generated"] for m in maps)}/321 generated outputs;{sum(m["accepted"] for m in maps)}/321 accepted tiles',
           'completed':completed,'total':6,'notes':str(out/'NOTES.md'),'needs_live_check':True,
           'usage_limit':usage,'blocked_reason':(out/'USAGE_LIMIT.txt').read_text() if usage else None,
           'maps':maps,'active_or_queued_jobs':own_pending(requests),'code_commit':previous.get('code_commit'),
           'headless':True,'hd_cache_s2_written':False}
    write(out/'FINAL.json',final);print(json.dumps(result))


def validated_tiles(cache):
    tiles=[Path(v) for v in (cache/'tiles/queue.txt').read_text().splitlines() if v]
    for tile in tiles:
        report=read(tile/'qa.json',{})
        if not report.get('accepted') or not report.get('numerical_pass'):
            raise ValueError(f'Tile has no complete numerical/visual acceptance: {tile.name}')
        if not (tile/'conditioned.png').is_file() or not (tile/'output.png').is_file():
            raise ValueError(f'Accepted tile missing actual images: {tile.name}')
        if hashlib.sha256((tile/'output.png').read_bytes()).hexdigest()!=report.get('raw_sha256'):
            raise ValueError(f'Raw image changed after QA: {tile.name}')
    return tiles


def assemble(args,out,cache,requests,ledger):
    tool=module(Path(__file__).resolve().parents[2]);tiles=validated_tiles(cache)
    token=time.strftime('%Y%m%dT%H%M%S')+'-'+uuid.uuid4().hex[:8]
    snapshot=cache/'assembly'/token/'tiles';snapshot.mkdir(parents=True)
    shutil.copy2(cache/'tiles/prep.json',snapshot/'prep.json')
    for tile in tiles:
        destination=snapshot/tile.name;destination.mkdir()
        for name in ['input.png','tile.json']:shutil.copy2(tile/name,destination/name)
        shutil.copy2(tile/'conditioned.png',destination/'output.png')
    draft=snapshot.parent/'assembled.png'
    tool.tt.main(['assemble','--source',str(cache/'source.png'),'--tiles',str(snapshot),
                  '--require-complete','--no-align','--lock-l','0','--lock-ab','0',
                  '--feather',str(args.feather),'--output',str(draft)])
    reference=tool.tt.load_image(cache/'source.png','RGBA');image=tool.tt.load_image(draft,'RGBA')
    water=tool.tt.load_image(cache/'water-mask.png','L')
    if not np.array_equal(reference[...,3],image[...,3]):raise ValueError('Assembly changed reference alpha')
    protected=(water>=128)|(reference[...,3]==0);image[protected]=reference[protected]
    final=cache/'terrain-map@2x-t2.png'
    if final.exists():shutil.copy2(final,snapshot.parent/'previous-candidate.png')
    Image.fromarray(image).save(final)
    measurements=[]
    for tile in tiles:
        meta=read(tile/'tile.json');x,y=meta['x'],meta['y'];h,w=1024,1536
        ref=reference[y:y+h,x:x+w];result=image[y:y+h,x:x+w];wm=water[y:y+h,x:x+w]
        import cv2
        land=cv2.erode(((ref[...,3]>=250)&(wm<128)).astype(np.uint8),np.ones((9,9),np.uint8)).astype(bool)
        measurement=tool.measure(ref[...,:3],result[...,:3],land);measurement['tile']=tile.name
        measurements.append(measurement)
    failed=[m['tile'] for m in measurements if m['sample_pixels'] and (m['texture_gain'] is None or m['texture_gain']<=1 or m['lowfreq_dE_mean']>3 or m['lowfreq_dE_p95']>6)]
    with Image.open(cache/'original.png') as im:original=im.convert('RGBA').resize((im.width*2,im.height*2),Image.Resampling.NEAREST)
    with Image.open(cache/'current-hd.png') as im:current=im.convert('RGBA')
    generated=Image.fromarray(image)
    from PIL import ImageDraw
    crops=read(cache/'boards/CROPS.json')['crops']
    for crop in crops:
        box=tuple(crop['box_2x']);cw,ch=box[2]-box[0],box[3]-box[1]
        board=Image.new('RGB',(cw*3,ch+36),(24,26,28));draw=ImageDraw.Draw(board)
        for col,(im,label) in enumerate([(original,'Original (nearest2x)'),(current,'Current composite / labelled native fallback'),(generated,'AI terrain2 —1:1 texture pixels')]):
            draw.text((col*cw+8,10),label,fill='white');part=im.crop(box);board.paste(part,(col*cw,36),part)
        board.save(cache/'boards'/(crop['name']+'.png'))
    overview=generated.copy();overview.thumbnail((1800,1200));overview.save(cache/'boards/overview.png')
    write(cache/'final-qa.json',{'accepted':False,'visual_status':'PENDING whole-map seam/edge and final crop review',
                               'source_alpha_exact':True,'open_water_rgb_exact':True,'tile_qa_complete':True,
                               'final_numerical_pass':not failed,'failed_final_tiles':failed,'tile_measurements':measurements,
                               'terrain_sha256':hashlib.sha256(final.read_bytes()).hexdigest(),'snapshot':str(snapshot),'feather':args.feather})
    note(out,f'ASSEMBLED {args.map}: accepted tiles{len(tiles)}, final numeric failures={failed}; final PNG and3 boards exist but whole-map visual acceptance PENDING. Immutable snapshot={snapshot}.')
    print(json.dumps({'map':args.map,'final':str(final),'failed_final_tiles':failed,'visual':'PENDING'}))
    status(args,out,cache,requests,ledger)


def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('action',choices=['submit','ingest','qa','approve','reject','status','assemble'])
    p.add_argument('--root',type=Path,required=True);p.add_argument('--out',type=Path,required=True);p.add_argument('--map',required=True)
    p.add_argument('--feather',type=float,default=96)
    p.add_argument('--mode',choices=['pilots','full'],default='pilots');p.add_argument('--retry-note');p.add_argument('--tiles');p.add_argument('--review-note')
    a=p.parse_args();out=a.out.resolve();cache=out/a.map;requests=a.root/'gameres/s2x/coordinator/image-requests'
    if not cache.is_dir() or not cache.resolve().is_relative_to(out):raise SystemExit('Map must be beneath assigned OUT')
    ledger=read(cache/'jobs-ledger.json',{})
    actions={'submit':submit,'ingest':ingest,'qa':qa,'approve':review,'reject':review,'status':status,'assemble':assemble}
    actions[a.action](a,out,cache,requests,ledger)
if __name__=='__main__':main()
