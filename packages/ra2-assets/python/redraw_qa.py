"""Faithfulness metrics for a posted building_redraw body job.

Each job's post/ contains orig2x.png, shown2x.png, box_rgba.png, reg4x.png,
and optional registration parameters in post.json. No asset library is needed.
"""

import argparse
import json
from pathlib import Path

import numpy as np
from PIL import Image

import building_redraw as br
import hybrid_redraw as hr
import redetail_sprites as rd


# Calibrated on 18 accepted stage-1 civil/tech redraws: iou .63 (swing set) / .87-.98, edge .53-.91, grid .11-.93,
# dab mean 1.9-6.7 / p95 4.3-14, texture gain 1.4-4.0. Thresholds catch gross failures; the eye review decides.
TH = dict(sil_iou=0.85, solidity=0.45, outside_frac=0.04, edge_corr_s2=0.55, grid_min=0.30,
          dab_mean=7.0, dab_p95=16.0, hue_shift=12.0, mean_ab_shift=6.0, texture_gain=1.2)


def rgb(path):
    with Image.open(path) as image:
        return np.asarray(image.convert('RGB'), np.float32)


def metrics(jobdir):
    """Compare the registered raw and finished redraw with the posted reference."""
    post = Path(jobdir) / 'post'
    orig = rgb(post / 'orig2x.png')
    shown = rgb(post / 'shown2x.png')
    with Image.open(post / 'box_rgba.png') as image:
        alpha = np.asarray(image)[..., 3].astype(np.float32) / 255
    raw2m = hr.box_down(rgb(post / 'reg4x.png'), 2)
    margin = 2 * br.M
    raw2 = raw2m[margin:margin + alpha.shape[0], margin:margin + alpha.shape[1]]
    opaque = alpha > 0.5
    weight = opaque.astype(np.float32)
    inside = rd.erode_distance(opaque, 3) > 2
    if not inside.any():
        raise ValueError('posted alpha has no opaque interior pixels for colour and detail metrics')
    lo, lf = hr.luminance(orig), hr.luminance(shown)
    result = {}

    # Compare model foreground with original alpha, including growth beyond the margin.
    foreground = hr.foreground(raw2m, 14.0)
    padded_alpha = np.pad(opaque, margin)
    foreground = hr.dilate(hr.erode(foreground, 1), 1)
    intersection = (foreground & padded_alpha).sum()
    union = (foreground | padded_alpha).sum()
    result['sil_iou'] = round(float(intersection / max(1, union)), 4)
    difference = np.abs(hr.gaussian_blur(raw2m, 1.0) - br.GREY).max(-1)
    outside = ~hr.dilate(padded_alpha, 3)
    result['outside_frac'] = round(float((outside & (difference > 24)).sum() / max(1, opaque.sum())), 4)

    eo2 = rd.sobel(rd.masked_blur(lo, weight, 2.0))
    ef2 = rd.sobel(rd.masked_blur(lf, weight, 2.0))
    result['edge_corr_s2'] = round(hr.pearson(eo2[inside], ef2[inside]), 4) if inside.sum() > 16 else 1.0
    structure_mask = inside.astype(np.float64)

    def highpass(profile):
        return profile - hr.gaussian_blur(profile[None, :], 6.0)[0]

    grid = {}
    for name, direction in hr.DIRECTIONS.items():
        po = hr.projection_profile(hr.gaussian_blur(lo, 1.0), structure_mask, direction)
        pf = hr.projection_profile(hr.gaussian_blur(lf, 1.0), structure_mask, direction)
        qo, valid = hr.luminance_profile(lo, structure_mask, direction)
        qf, _ = hr.luminance_profile(lf, structure_mask, direction)
        grid[name] = [round(hr.pearson(highpass(po), highpass(pf)), 3),
                      round(hr.pearson(qo[valid], qf[valid]), 3) if valid.sum() > 8 else 1.0]
    result['grid'] = grid
    result['grid_min'] = min(min(value) for value in grid.values())
    result['grid_applies'] = bool(opaque.sum() / 4 >= hr.GRID_MIN_AREA)

    # Low-frequency Lab drift at sigma 3 (2x pixels), both before and after colour lock.
    lab_o = rd.masked_blur(rd.srgb_to_lab(orig), weight, 3.0)
    for tag, image in (('final', shown), ('raw', raw2)):
        lab = rd.masked_blur(rd.srgb_to_lab(image), weight, 3.0)
        delta_e = np.sqrt(((lab - lab_o) ** 2).sum(-1))[inside]
        delta_ab = np.sqrt(((lab[..., 1:] - lab_o[..., 1:]) ** 2).sum(-1))[inside]
        result[f'dE_{tag}'] = [round(float(delta_e.mean()), 2),
                              round(float(np.percentile(delta_e, 95)), 2)] if delta_e.size else [0, 0]
        result[f'dab_{tag}'] = [round(float(delta_ab.mean()), 2),
                               round(float(np.percentile(delta_ab, 95)), 2)] if delta_ab.size else [0, 0]

    orig_ab = rd.srgb_to_lab(orig)[inside][:, 1:].mean(0)
    final_ab = rd.srgb_to_lab(shown)[inside][:, 1:].mean(0)
    result['mean_ab_orig'] = [round(float(value), 1) for value in orig_ab]
    result['mean_ab_final'] = [round(float(value), 1) for value in final_ab]
    result['mean_ab_shift'] = round(float(np.hypot(*(final_ab - orig_ab))), 2)

    # Select by ORIGINAL low-frequency chroma: near-neutral greys have unstable hue.
    lab_f = rd.masked_blur(rd.srgb_to_lab(shown), weight, 3.0)
    chroma_o = np.hypot(lab_o[..., 1], lab_o[..., 2])
    selected = inside & (chroma_o > 6)
    if selected.sum() > 20:
        hue_o = np.arctan2(lab_o[..., 2], lab_o[..., 1])
        hue_f = np.arctan2(lab_f[..., 2], lab_f[..., 1])
        delta_hue = np.degrees(np.abs((hue_f - hue_o + np.pi) % (2 * np.pi) - np.pi))[selected]
        result['hue_shift'] = round(float((delta_hue * chroma_o[selected]).sum() / chroma_o[selected].sum()), 2)
    else:
        result['hue_shift'] = 0.0
    result['solidity'] = round(float(opaque.sum() / max(1, opaque.shape[0] * opaque.shape[1])), 3)

    # Fine texture is the sigma-1 residual in flatter parts of the original.
    edges_o = rd.sobel(rd.masked_blur(lo, weight, 1.0))
    flat = inside & (edges_o < np.percentile(edges_o[inside], 70)) if inside.sum() > 16 else inside

    def texture(luminance):
        return float(np.abs(luminance - rd.masked_blur(luminance, weight, 1.0))[flat].mean()) if flat.sum() else 0.0

    result['texture_gain'] = round(texture(lf) / max(1e-3, texture(lo)), 3)
    try:
        result['reg_params'] = json.loads((post / 'post.json').read_text(encoding='utf-8'))['params']
    except (OSError, ValueError, KeyError, TypeError):
        pass
    return result


def verdict(measured, thresholds=None):
    """Return failure labels using calibrated defaults and optional threshold overrides."""
    threshold = {**TH, **(thresholds or {})}
    fails = []
    if measured['sil_iou'] < threshold['sil_iou'] and measured.get('solidity', 1) >= threshold['solidity']:
        fails.append('silhouette')
    if measured['outside_frac'] > threshold['outside_frac']:
        fails.append('outside')
    if measured['edge_corr_s2'] < threshold['edge_corr_s2']:
        fails.append('structure')
    if measured['grid_applies'] and measured['grid_min'] < threshold['grid_min']:
        fails.append('grid')
    if (measured['dab_final'][0] > threshold['dab_mean'] or measured['dab_final'][1] > threshold['dab_p95']
            or measured.get('hue_shift', 0) > threshold['hue_shift']
            or measured.get('mean_ab_shift', 0) > threshold['mean_ab_shift']):
        fails.append('colour')
    if measured['texture_gain'] < threshold['texture_gain']:
        fails.append('no-detail')
    params = measured.get('reg_params')
    if params and (abs(params[0] - 1) > 0.12 or abs(params[2] - 1) > 0.12):
        fails.append('framing')
    return fails


def threshold_option(value):
    """Accept an inline JSON object or a path to a JSON threshold file."""
    try:
        content = value if value.lstrip().startswith('{') else Path(value).read_text(encoding='utf-8')
        thresholds = json.loads(content)
        if not isinstance(thresholds, dict) or any(key not in TH for key in thresholds):
            raise ValueError('thresholds must be an object with keys from TH')
        if any(isinstance(number, bool) or not isinstance(number, (int, float))
               or not np.isfinite(number) for number in thresholds.values()):
            raise ValueError('threshold values must be finite numbers')
        return thresholds
    except (OSError, ValueError) as error:
        raise argparse.ArgumentTypeError(str(error)) from error


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('jobdirs', nargs='+', type=Path)
    parser.add_argument('--thresholds', type=threshold_option, default={}, metavar='JSON',
                        help='threshold overrides as an inline JSON object or JSON file path')
    args = parser.parse_args(argv)
    status = 0
    for jobdir in args.jobdirs:
        try:
            measured = metrics(jobdir)
            measured['fails'] = verdict(measured, args.thresholds)
            encoded = json.dumps(measured, indent=1, allow_nan=False) + '\n'
            (jobdir / 'post' / 'qa.json').write_text(encoded, encoding='utf-8')
            print(json.dumps({'job': str(jobdir), **measured}, allow_nan=False))
        except (OSError, ValueError, KeyError, TypeError, IndexError) as error:
            print(json.dumps({'job': str(jobdir), 'error': str(error)}))
            status = 1
    return status


if __name__ == '__main__':
    raise SystemExit(main())
