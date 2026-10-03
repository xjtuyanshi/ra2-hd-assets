"""Measure registered redraws without choosing game-specific acceptance thresholds.

Port of stage2 civil QA: post/{orig2x,shown2x,box_rgba,reg4x}.png.
The caller supplies the 1x registration margin. Requires NumPy and Pillow.
"""
from pathlib import Path
import json
import numpy as np
from PIL import Image
import hybrid_redraw as hr
import redetail_sprites as rd

GREY = 118.0
def rgb(p):
    with Image.open(p) as image:
        return np.asarray(image.convert('RGB'), np.float32)

def metrics(d, *, margin, directions, min_grid_area):
    d = Path(d); P = d / 'post'
    orig = rgb(P / 'orig2x.png'); shown = rgb(P / 'shown2x.png')
    with Image.open(P / 'box_rgba.png') as image:
        a = np.asarray(image.convert('RGBA'))[..., 3].astype(np.float32) / 255
    reg4 = rgb(P / 'reg4x.png'); m4 = 4 * margin
    raw2m = hr.box_down(reg4, 2) if hasattr(hr, 'box_down') else reg4[::2, ::2]
    m2 = 2 * margin
    if margin < 0 or orig.shape != shown.shape or orig.shape[:2] != a.shape:
        raise ValueError('inconsistent posted image dimensions or margin')
    if raw2m.shape[:2] != (a.shape[0] + 2*m2, a.shape[1] + 2*m2):
        raise ValueError('registered redraw does not match the supplied margin')
    raw2 = raw2m[m2:m2 + a.shape[0], m2:m2 + a.shape[1]]
    a2 = a > 0.5
    wgt = a2.astype(np.float32)
    inside = rd.erode_distance(a2, 3) > 2
    lo, lf, lr = hr.luminance(orig), hr.luminance(shown), hr.luminance(raw2)
    m = {}
    # silhouette: model foreground vs original alpha (IoU), plus growth outside / holes inside
    fg = hr.foreground(raw2m, 14.0)
    a2m = np.pad(a2, m2)
    fgm = hr.dilate(hr.erode(fg, 1), 1)
    inter = (fgm & a2m).sum(); union = (fgm | a2m).sum()
    m['sil_iou'] = round(float(inter / max(1, union)), 4)
    diff = np.abs(hr.gaussian_blur(raw2m, 1.0) - GREY).max(-1) if hasattr(hr, 'gaussian_blur') else None
    outside = ~hr.dilate(a2m, 3)
    m['outside_frac'] = round(float((outside & (diff > 24)).sum() / max(1, a2.sum())), 4)
    def edges(l, s): return rd.sobel(rd.masked_blur(l, wgt, s))
    eo2, ef2 = edges(lo, 2.0), edges(lf, 2.0)
    m['edge_corr_s2'] = round(hr.pearson(eo2[inside], ef2[inside]), 4) if inside.sum() > 16 else 1.0
    sm = inside.astype(np.float64)
    hp = lambda p: p - hr.gaussian_blur(p[None, :], 6.0)[0]
    g = {}
    for name, dd in directions.items():
        po = hr.projection_profile(hr.gaussian_blur(lo, 1.0), sm, dd)
        pf = hr.projection_profile(hr.gaussian_blur(lf, 1.0), sm, dd)
        qo, valid = hr.luminance_profile(lo, sm, dd)
        qf, _ = hr.luminance_profile(lf, sm, dd)
        g[name] = [round(hr.pearson(hp(po), hp(pf)), 3), round(hr.pearson(qo[valid], qf[valid]), 3) if valid.sum() > 8 else 1.0]
    m['grid'] = g
    m['grid_min'] = min(min(v) for v in g.values())
    m['grid_applies'] = bool(a2.sum() / 4 >= min_grid_area)
    # colour drift: low-frequency Lab (sigma 3 at 2x) of raw (pre-lock) and final vs original
    lab_o = rd.masked_blur(rd.srgb_to_lab(orig), wgt, 3.0)
    for tag, img in (('final', shown), ('raw', raw2)):
        lab = rd.masked_blur(rd.srgb_to_lab(img), wgt, 3.0)
        dE = np.sqrt(((lab - lab_o) ** 2).sum(-1))[inside]
        dab = np.sqrt(((lab[..., 1:] - lab_o[..., 1:]) ** 2).sum(-1))[inside]
        m[f'dE_{tag}'] = [round(float(dE.mean()), 2), round(float(np.percentile(dE, 95)), 2)] if dE.size else [0, 0]
        m[f'dab_{tag}'] = [round(float(dab.mean()), 2), round(float(np.percentile(dab, 95)), 2)] if dab.size else [0, 0]
    # mean chroma/hue shift of the whole object (catches olive -> brown-grey type drifts)
    lo_ab = rd.srgb_to_lab(orig)[inside][:, 1:].mean(0) if inside.any() else np.zeros(2)
    lf_ab = rd.srgb_to_lab(shown)[inside][:, 1:].mean(0) if inside.any() else np.zeros(2)
    m['mean_ab_orig'] = [round(float(x), 1) for x in lo_ab]; m['mean_ab_final'] = [round(float(x), 1) for x in lf_ab]
    m['mean_ab_shift'] = round(float(np.hypot(*(lf_ab - lo_ab))), 2)
    # chroma-weighted hue shift of low-frequency colour where the original is chromatic (olive -> brown type drifts)
    lab_f = rd.masked_blur(rd.srgb_to_lab(shown), wgt, 3.0)
    Co = np.hypot(lab_o[..., 1], lab_o[..., 2]); sel = inside & (Co > 6)
    if sel.sum() > 20:
        ho = np.arctan2(lab_o[..., 2], lab_o[..., 1]); hf = np.arctan2(lab_f[..., 2], lab_f[..., 1])
        dh = np.degrees(np.abs((hf - ho + np.pi) % (2 * np.pi) - np.pi))[sel]
        m['hue_shift'] = round(float((dh * Co[sel]).sum() / Co[sel].sum()), 2)
    else:
        m['hue_shift'] = 0.0
    m['solidity'] = round(float(a2.sum() / max(1, a2.shape[0] * a2.shape[1])), 3)
    # detail gain: fine texture (sigma-1 residual) in flat areas, redraw vs original baseline
    edges_o = rd.sobel(rd.masked_blur(lo, wgt, 1.0))
    flat = inside & (edges_o < np.percentile(edges_o[inside], 70)) if inside.sum() > 16 else inside
    tex = lambda l: float(np.abs(l - rd.masked_blur(l, wgt, 1.0))[flat].mean()) if flat.sum() else 0.0
    m['texture_gain'] = round(tex(lf) / max(1e-3, tex(lo)), 3)
    try:
        m['reg_params'] = json.load(open(P / 'post.json'))['params']
    except Exception:
        pass
    return m
