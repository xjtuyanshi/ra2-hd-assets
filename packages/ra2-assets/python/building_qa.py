"""Civil/tech building QA with unchanged stage-two calibrated thresholds.

Numeric warnings accompany native-scale review; they are not visual approval.
"""
import argparse
import json
from pathlib import Path
import building_redraw as br
import hybrid_redraw as hr
from redraw_metrics import metrics

# Calibrated on 18 accepted stage-1 civil/tech redraws: iou .63 (swing set) / .87-.98, edge .53-.91, grid .11-.93,
# dab mean 1.9-6.7 / p95 4.3-14, texture gain 1.4-4.0. Thresholds catch gross failures; the eye review decides.
TH = dict(sil_iou=0.85, solidity=0.45, outside_frac=0.04, edge_corr_s2=0.55, grid_min=0.30, dab_mean=7.0, dab_p95=16.0,
          hue_shift=12.0, mean_ab_shift=6.0, texture_gain=1.2)
def verdict(m):
    f = []
    if m['sil_iou'] < TH['sil_iou'] and m.get('solidity', 1) >= TH['solidity']: f.append('silhouette')
    if m['outside_frac'] > TH['outside_frac']: f.append('outside')
    if m['edge_corr_s2'] < TH['edge_corr_s2']: f.append('structure')
    if m['grid_applies'] and m['grid_min'] < TH['grid_min']: f.append('grid')
    if m['dab_final'][0] > TH['dab_mean'] or m['dab_final'][1] > TH['dab_p95'] or m.get('hue_shift', 0) > TH['hue_shift'] or m.get('mean_ab_shift', 0) > TH['mean_ab_shift']: f.append('colour')
    if m['texture_gain'] < TH['texture_gain']: f.append('no-detail')
    p = m.get('reg_params')
    if p and (abs(p[0] - 1) > 0.12 or abs(p[2] - 1) > 0.12): f.append('framing')
    return f


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('jobs', type=Path, nargs='+')
    args = parser.parse_args(argv)
    errors = 0
    for job in args.jobs:
        try:
            result = metrics(job, margin=br.M, directions=hr.DIRECTIONS, min_grid_area=hr.GRID_MIN_AREA)
            result['fails'] = verdict(result)
            br.atomic_json(job / 'post' / 'qa.json', result)
            print(job.name, json.dumps(result))
        except (OSError, ValueError, KeyError) as error:
            errors += 1
            print(job.name, 'ERROR', str(error))
    return int(bool(errors))


if __name__ == '__main__':
    raise SystemExit(main())
