"""Compare captured YR depth with the native BUILDNGZ model for a building.

Keeps stage-two projection, template origin (198,446), and template extent
(396,477). These are YR policy, not generic raster-decoder constants.
"""
import argparse
import json
from pathlib import Path
import numpy as np
from yr_zbuffer import decode


def compare(run, i, typ, shp, fi, *, library, data, mode='body', n_adj=0, pm=(0, 0), width=984, height=712):
    if mode != 'body' and not mode.startswith('g0:'):
        raise ValueError('mode must be body or g0:K')
    if mode != 'body':
        int(mode.split(':')[1])
    results = []
    st = json.load(open(f'{run}/pairs/state-{i}.json'))['state']
    z, info = decode(f'{run}/pairs/native-{i}.json', f'{run}/pairs/zbuf-{i}.bin'); z = z.astype(int)
    K = info['ints'][9] & 0xffff
    lib = json.loads(Path(library).read_text())
    W, H = lib['types'][typ]['foundation']
    raw = np.load(str(Path(data) / 'buildngz.npy')).astype(int)
    s = np.where(raw == 0, 0, (raw - 65) & 255); s = np.where(s > 127, s - 256, s)
    m = json.load(open(str(Path(data) / 'shp' / f'{shp}.json'))); f = m['frames'][int(fi)]
    px = np.frombuffer(open(str(Path(data) / 'shp' / f'{shp}_f{fi}.bin'), 'rb').read(), dtype=np.uint8).reshape(f['h'], f['w'])
    v = st['view']
    for o in st['objects']:
        if o['type'] != typ: continue
        cx, cy = int(o['x'] // 256), int(o['y'] // 256); pz = int(o['z'] * 0.14350360082660085 + (1 if o['z'] >= 728 else 0) + 0.5)
        P = (30 * (cx - cy) - v['x'], 15 * (cx + cy) - pz - v['y'])
        O = (f['x'] - m['cw'] // 2, f['y'] - m['ch'] // 2)
        if not (0 <= P[0] + O[0] < width and 0 <= P[1] + O[1] < height): continue
        A = (198 + pm[0] - 30 * (W - H), 446 + pm[1] - 15 * (W + H - 2)); a = (A[0] + O[0], A[1] + O[1])
        hp = min(f['h'], 477 - a[1]); b = P[1] + O[1] + hp - 1
        cnt = {'exact': 0, 'nearer': 0, 'farther': 0}; far = []
        for j in range(hp if mode == 'body' else f['h']):
            for ii in range(min(f['w'], 396 - a[0]) if mode == 'body' else f['w']):
                if px[j, ii] == 0: continue
                x, y = P[0] + O[0] + ii, P[1] + O[1] + j
                if not (0 <= x < width and 0 <= y < height): continue
                if mode == 'body': model = K - b + n_adj - pz - 2 - s[a[1] + j, a[0] + ii]
                else: model = K - y - pz - int(mode.split(':')[1])
                d = z[y, x] - model
                cnt['exact' if d == 0 else 'nearer' if d < 0 else 'farther'] += 1
                if d > 0: far.append(d)
        results.append(dict(type=typ, cell=(cx, cy), frame=fi, point=P, counts=cnt, farther_median=float(np.median(far)) if far else None, buildingFrame=o.get('buildingFrame'), unloading=o.get('unloading')))
    return results


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('run', type=Path)
    parser.add_argument('id')
    parser.add_argument('type')
    parser.add_argument('shp')
    parser.add_argument('frame', type=int)
    parser.add_argument('--library', type=Path, required=True)
    parser.add_argument('--data', type=Path, required=True, help='buildngz.npy and shp/ tree')
    parser.add_argument('--mode', default='body')
    parser.add_argument('--n', type=int, default=0)
    parser.add_argument('--point-move', nargs=2, type=int, default=(0, 0))
    parser.add_argument('--width', type=int, default=984)
    parser.add_argument('--height', type=int, default=712)
    args = parser.parse_args(argv)
    for result in compare(args.run, args.id, args.type, args.shp, args.frame,
                          library=args.library, data=args.data, mode=args.mode, n_adj=args.n,
                          pm=tuple(args.point_move), width=args.width, height=args.height):
        print(json.dumps(result))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
