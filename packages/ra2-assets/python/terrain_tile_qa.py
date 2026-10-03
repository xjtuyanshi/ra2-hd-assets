#!/usr/bin/env python3
"""Condition and measure image-painted terrain without claiming visual acceptance.

The immutable reference supplies geometry, alpha and open water. Texture gain is
mean absolute luminance high-pass energy at sigma 1 composite pixel on eroded
opaque land, relative to the native-derived reference at the SAME resolution.
It rejects smoothing, but cannot distinguish physical detail from invented noise;
that judgement remains an explicit human/agent visual review.
"""
from __future__ import annotations
import argparse
import json
from pathlib import Path
import cv2
import numpy as np
from PIL import Image
import terrain_tiles as tt
Image.MAX_IMAGE_PIXELS = None


def measure(reference: np.ndarray, candidate: np.ndarray, land: np.ndarray) -> dict:
    if reference.shape != candidate.shape or land.shape != reference.shape[:2]:
        raise ValueError('reference, candidate and land must share their raster')
    if not land.any():
        return dict(texture_gain=None, texture_gain_by_sigma={}, lowfreq_dE_mean=0,
                    lowfreq_dE_p95=0, structural_correlation=None, sample_pixels=0)
    a = cv2.cvtColor(reference, cv2.COLOR_RGB2GRAY).astype(np.float32)
    b = cv2.cvtColor(candidate, cv2.COLOR_RGB2GRAY).astype(np.float32)
    gains = {}
    for sigma in (1, 2, 4):
        ea = float(np.abs(a - cv2.GaussianBlur(a, (0, 0), sigma))[land].mean())
        eb = float(np.abs(b - cv2.GaussianBlur(b, (0, 0), sigma))[land].mean())
        gains[str(sigma)] = eb / ea if ea > 1e-6 else None
    delta = tt.to_lab(reference) - tt.to_lab(candidate)
    de = np.sqrt(sum(cv2.GaussianBlur(delta[..., c], (0, 0), 20) ** 2 for c in range(3)))
    structural = tt.corr(tt.feat(reference)[land], tt.feat(candidate)[land])
    return dict(texture_gain=gains['1'], texture_gain_by_sigma=gains,
                lowfreq_dE_mean=float(de[land].mean()),
                lowfreq_dE_p95=float(np.percentile(de[land], 95)),
                structural_correlation=structural, sample_pixels=int(land.sum()))


def condition(reference: np.ndarray, raw: np.ndarray, water: np.ndarray,
              *, alignment: bool = True) -> tuple[np.ndarray, dict]:
    if reference.ndim != 3 or reference.shape[2] != 4 or raw.shape != reference[..., :3].shape:
        raise ValueError('expected matching RGBA reference and RGB image output')
    if water.shape != reference.shape[:2]:
        raise ValueError('water mask must match the reference')
    inp, alpha = reference[..., :3], reference[..., 3]
    validity = alpha.astype(np.float32) / 255
    fit = raw.copy()
    fit[alpha == 0] = inp[alpha == 0]
    c0, cc, warp = tt.fit_affine(inp, fit) if alignment else (1, 1, np.eye(2, 3, dtype=np.float32))
    displacement = float(tt.displacement(warp, inp.shape[:2])[:4].max())
    aligned = tt.align(inp, raw, validity=validity) if alignment else raw
    rgb = np.round(tt.colour_lock(inp, aligned, lock_l=1, lock_ab=1, validity=validity) * 255).astype(np.uint8)
    # Open-water art is replaced by the renderer. Do not leave hallucinated waves,
    # cyan shallows or transparent-margin RGB in a material remaster.
    protected = (water >= 128) | (alpha == 0)
    rgb[protected] = inp[protected]
    result = np.dstack([rgb, alpha])
    land = cv2.erode(((alpha >= 250) & (water < 128)).astype(np.uint8),
                     np.ones((9, 9), np.uint8)).astype(bool)
    report = measure(inp, rgb, land)
    report.update(registration_ecc=float(cc) if np.isfinite(cc) else None,
                  registration_correlation_before=float(c0),
                  registration_displacement_max=displacement,
                  alpha_exact=bool(np.array_equal(result[..., 3], alpha)),
                  protected_rgb_exact=bool(np.array_equal(result[..., :3][protected], inp[protected])))
    gain = report['texture_gain']
    reasons = []
    if report['sample_pixels'] and (gain is None or gain <= 1): reasons.append('texture gain <=1 or unmeasurable')
    if report['lowfreq_dE_mean'] > 3 or report['lowfreq_dE_p95'] > 6: reasons.append('low-frequency colour mismatch')
    if report['sample_pixels'] and (not np.isfinite(cc) or cc < .75 or displacement > 8): reasons.append('registration needs repair')
    report.update(numerical_pass=not reasons, rejection_reasons=reasons,
                  visual_status='PENDING: inspect physical material detail and geometry at1:1',
                  accepted=False)
    return result, report


def review_board(reference: np.ndarray, current: np.ndarray, candidate: np.ndarray,
                 water: np.ndarray, output: Path, label: str) -> None:
    from PIL import ImageDraw
    h, w = reference.shape[:2]
    land = (reference[..., 3] >= 250) & (water < 128)
    gray = cv2.cvtColor(reference[..., :3], cv2.COLOR_RGB2GRAY).astype(np.float32)
    texture = np.abs(gray-cv2.GaussianBlur(gray, (0, 0), 2))
    edge = tt.feat(reference[..., :3])
    cw, ch = min(512,w), min(256,h)
    centers = []
    for field in (cv2.GaussianBlur(land.astype(np.float32), (0, 0), 64), edge, texture):
        valid = field.copy(); valid[~land] = -1
        _, _, _, location = cv2.minMaxLoc(valid)
        cx, cy = location
        centers.append((min(max(0,cx-cw//2),w-cw),min(max(0,cy-ch//2),h-ch)))
    board = Image.new('RGB',(1536,384+3*(ch+32)),(24,26,28));draw=ImageDraw.Draw(board)
    for col,(r,title) in enumerate([(reference,'native-derived reference'),(current,'current composite / native fallback'),(candidate,'AI conditioned; VISUAL REVIEW PENDING')]):
        draw.text((col*512+6,6),title,fill='white')
        thumb=Image.fromarray(r).convert('RGBA');thumb.thumbnail((512,342));board.paste(thumb,(col*512,32),thumb)
        for row,(x,y) in enumerate(centers):
            yy=384+row*(ch+32);draw.text((col*512+6,yy+6),f'{label} crop{row+1} ({x},{y}) 1:1',fill='white')
            crop=Image.fromarray(r[y:y+ch,x:x+cw]).convert('RGBA');board.paste(crop,(col*512,yy+32),crop)
    output.parent.mkdir(parents=True,exist_ok=True);board.save(output)


def main(argv=None):
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--reference',type=Path,required=True);p.add_argument('--raw',type=Path,required=True)
    p.add_argument('--water-mask',type=Path,required=True);p.add_argument('--output',type=Path,required=True)
    p.add_argument('--report',type=Path,required=True);p.add_argument('--no-align',action='store_true')
    a=p.parse_args(argv)
    with Image.open(a.reference) as im:reference=np.array(im.convert('RGBA'))
    with Image.open(a.raw) as im:raw=np.array(im.convert('RGB'))
    with Image.open(a.water_mask) as im:water=np.array(im.convert('L'))
    result,report=condition(reference,raw,water,alignment=not a.no_align)
    a.output.parent.mkdir(parents=True,exist_ok=True);Image.fromarray(result).save(a.output)
    a.report.write_text(json.dumps(report,indent=2,allow_nan=False)+'\n')
    print(json.dumps(report,allow_nan=False))
    return 0 if report['numerical_pass'] else 1

if __name__=='__main__':raise SystemExit(main())
