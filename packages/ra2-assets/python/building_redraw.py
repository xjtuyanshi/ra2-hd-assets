#!/usr/bin/env python3
"""Building redraw jobs, coherent animation sheets and HD atlas patches.

The buildings-v4 method composites decoded 2x library frames, enlarges them on
flat grey, registers image-model outputs with hybrid_redraw, then locks Lab
low frequencies and local contrast against the original composite. Alpha stays
with the source art; nearby house-hue paint is encoded on the shader grey ramp.
Animation sheets retain static pixels from the accepted body redraw; build-up
sheets use every pixel from the sheet. Normal assists reuse the same registration.

NumPy, Pillow and OpenCV are required. No model is invoked by this tool: supply
raw.png or output.png after preparing jobs. All game-derived images, libraries,
patches and work directories must remain outside Git. The scratch scheduler and
image-agent launcher are intentionally not part of this module.
"""
from __future__ import annotations

import argparse
import json
import math
import os
from pathlib import Path
import shutil
import tempfile

import cv2
import numpy as np
from PIL import Image

import cache_farm
import hybrid_redraw as hr
import redetail_sprites as rd

Image.MAX_IMAGE_PIXELS = None
M = 8  # Margin in original 1x pixels.
GREY = 118.0
GAP = 32
PAD = 6
STORAGE = frozenset({'NAREFN', 'GAREFN'})
COVERAGE_RECORDS = ('l3_frames.json', 'l4_frames_bldg.json')
COVERAGE_PREFIXES = ('GA', 'NA', 'YA', 'GT', 'AT', 'NT', 'TESLA')
COVERAGE_COLUMNS = ('name', 'played_frames', 'earlier', 'l5_model', 'l5_xfer', 'coverage_percent',
                    'body_intact', 'body_damaged', 'buildup', 'gaps')


def cache_root(root=None):
    root = root or os.environ.get('HD_CACHE_DIR')
    if not root:
        raise ValueError('provide --root or set HD_CACHE_DIR')
    return Path(root)


def read_json(path):
    return json.loads(Path(path).read_text(encoding='utf-8'))


def write_json(path, value):
    Path(path).write_text(json.dumps(value, indent=1, default=float), encoding='utf-8')



class Lib:
    def __init__(self, theater: str = 'urban', root: Path | None = None):
        self.dir = cache_root(root) / '_library' / theater
        self.lib = json.loads((self.dir / 'library.json').read_text())
        self.pal = {k: read_image(self.dir / v, 'RGB')[0].astype(np.float32)
                    for k, v in self.lib['palettes'].items()}
        self._idx = {}
        self._hd = {}
        self._rm = {}

    def idx_page(self, p):
        if p not in self._idx:
            a = read_image(self.dir / self.lib['spriteAtlases'][p]['file'])
            self._idx[p] = a[..., 0] if a.ndim == 3 else a
        return self._idx[p]

    def hd_page(self, p):
        if p not in self._hd:
            e = self.lib['spriteAtlasesHd'][p]
            self._hd[p] = read_image(self.dir / e['file'], 'RGBA')
            self._rm[p] = read_image(self.dir / e['remap'], 'L')
        return self._hd[p], self._rm[p]

    def house(self, scheme: int | str = 'DarkBlue'):
        if isinstance(scheme, str):
            scheme = self.lib['colorSchemesByName'][scheme]
        return np.asarray(self.lib['colorSchemes'][scheme]['remap'], np.float32)

    def frame(self, sprite: str, fi: int, house=None, shadow=False):
        """Returns dict: art1 (h,w,3) displayed 1x, a1 bool, hd (2h,2w,4) displayed 2x RGBA, paint2 (2h,2w) float,
        offset (x,y) of the top-left relative to the anchor, rect, page."""
        s = self.lib['sprites'][sprite]
        f = (s['shadows'] if shadow else s['frames'])[fi]
        x, y, w, h = f['rect']
        p = f.get('page', 0)
        idx = self.idx_page(p)[y:y + h, x:x + w].astype(np.int32)
        pal = self.pal[s['palette']].copy()
        hr = house if house is not None else self.house()
        if s.get('remap'):
            pal[16:32] = hr[:16]
        art1 = pal[idx]
        a1 = idx > 0
        hd, rm = self.hd_page(p)
        hd = hd[2 * y:2 * (y + h), 2 * x:2 * (x + w)].astype(np.float32).copy()
        paint = rm[2 * y:2 * (y + h), 2 * x:2 * (x + w)].astype(np.float32) / 255
        if s.get('remap') and paint.any():
            rgb = hd[..., :3]
            k = np.clip((255 - rgb[..., 1]) / 15, 0, 15)
            k0 = np.floor(k).astype(int)
            k1 = np.minimum(k0 + 1, 15)
            col = hr[k0] + (hr[k1] - hr[k0]) * (k - k0)[..., None]
            hd[..., :3] = rgb * (1 - paint[..., None]) + col * paint[..., None]
        return dict(art1=art1, a1=a1, hd=hd, paint2=paint, offset=tuple(f['offset']), rect=(x, y, w, h), page=p,
                    canvas=s.get('canvas'))


def composite(parts, scale=1, key='art1', bg=(118, 118, 118)):
    """parts: list of frame dicts (drawn in order). Returns RGB image on bg, and origin offset."""
    xs, ys, xe, ye = [], [], [], []
    for f in parts:
        ox, oy = f['offset']
        w, h = f['rect'][2], f['rect'][3]
        xs.append(ox)
        ys.append(oy)
        xe.append(ox + w)
        ye.append(oy + h)
    x0, y0, x1, y1 = min(xs), min(ys), max(xe), max(ye)
    W, H = (x1 - x0) * scale, (y1 - y0) * scale
    out = np.zeros((H, W, 3), np.float32) + np.asarray(bg, np.float32)
    for f in parts:
        ox, oy = f['offset']
        if key == 'art1':
            rgb, a = f['art1'], f['a1'].astype(np.float32)
            if scale > 1:
                rgb = np.kron(rgb, np.ones((scale, scale, 1)))
                a = np.kron(a, np.ones((scale, scale)))
        else:
            rgb, a = f['hd'][..., :3], f['hd'][..., 3] / 255
        X, Y = (ox - x0) * scale, (oy - y0) * scale
        h, w = a.shape
        out[Y:Y + h, X:X + w] = rgb * a[..., None] + out[Y:Y + h, X:X + w] * (1 - a[..., None])
    return out, (x0, y0)


def save(img, path):
    Image.fromarray(np.clip(np.rint(img), 0, 255).astype(np.uint8)).save(path)


class MapLib(Lib):
    """Same frame() interface over a map cache (single page; houses from the manifest)."""

    def __init__(self, map_name: str = 'XMP29U2', root: Path | None = None, atlas2x: str | None = None):
        self.dir = cache_root(root) / map_name
        m = json.loads((self.dir / 'manifest.json').read_text())
        self.manifest = m
        hd = dict(m['spriteAtlasHd'])
        if atlas2x:
            hd['file'] = atlas2x
        self.lib = {'sprites': m['sprites'], 'palettes': m['palettes'], 'spriteAtlases': [m['spriteAtlas']],
                    'spriteAtlasesHd': [hd]}
        self.pal = {k: read_image(self.dir / v, 'RGB')[0].astype(np.float32)
                    for k, v in m['palettes'].items()}
        self._idx, self._hd, self._rm = {}, {}, {}

    def house(self, scheme=None):
        h = self.manifest.get('houses') or {}
        k = scheme if scheme in h else next(iter(h), None)
        return np.asarray(h[k]['remap'], np.float32) if k else np.zeros((16, 3), np.float32)


def lib_for(lay, root=None, theater='urban'):
    """Read the job's map cache or the selected type library without global path state."""
    return MapLib(lay['map'], root) if lay.get('map') else Lib(theater, root)



def parse_part(p):
    kind, name, fi = p.split(':')
    return f'{kind}:{name}', int(fi)


def design_rgb(lib, c, palette):
    """Lanczos-2x of the 1x composite in a named palette, blended over GREY with its HD alpha.

    Art with a commented-out INI Palette line (YR CACITY01-04 and CITY01-06:
    ';Palette=City') is colour noise with the unit palette. The theatre 'lib'
    palette shows the intended building for model input and the colour lock.
    Remappable parts use the composite's house ramp on indices 16..31, as in Lib.frame.
    """
    x0, y0 = c['origin']
    w1, h1 = c['size1']
    out = np.full((h1, w1, 3), GREY, np.float32)
    for part in c['parts']:
        sprite, frame = parse_part(part)
        entry = lib.lib['sprites'][sprite]
        pal = lib.pal[palette].copy()
        if entry.get('remap'):
            pal[16:32] = c['ramp'][:16]
        f = entry['frames'][frame]
        x, y, w, h = f['rect']
        idx = lib.idx_page(f.get('page', 0))[y:y + h, x:x + w].astype(int)
        ox, oy = f['offset'][0] - x0, f['offset'][1] - y0
        xs, ys = max(0, ox), max(0, oy)
        xe, ye = min(w1, ox + w), min(h1, oy + h)
        if xe <= xs or ye <= ys:
            continue
        idx = idx[ys - oy:ye - oy, xs - ox:xe - ox]
        mask = idx > 0
        out[ys:ye, xs:xe][mask] = pal[idx][mask]
    im = Image.fromarray(np.clip(out, 0, 255).astype(np.uint8)).resize((w1 * 2, h1 * 2), Image.LANCZOS)
    rgb = np.asarray(im, np.float32)
    return rgb * c['a'][..., None] + GREY * (1 - c['a'][..., None])


def comp2x(lib, parts, house='DarkBlue', box=None, *, design_palette=None):
    """Composite parts (list of 'sprite:frame') at 2x. Returns dict with rgb (displayed, float), a (0..1), paint (0..1),
    origin (1x anchor-relative top-left of the box, excluding margin), size1, rects (per part 2x rect inside the box),
    frames (Lib.frame dictionaries). A design_palette replaces rgb with the
    1x indices rendered through that library palette and Lanczos-enlarged 2x."""
    ramp = lib.house(house)
    frames = [lib.frame(s, f, house=ramp) for s, f in map(parse_part, parts)]
    if box is None:
        x0 = min(f['offset'][0] for f in frames)
        y0 = min(f['offset'][1] for f in frames)
        x1 = max(f['offset'][0] + f['rect'][2] for f in frames)
        y1 = max(f['offset'][1] + f['rect'][3] for f in frames)
    else:
        x0, y0, x1, y1 = box
    W, H = (x1 - x0) * 2, (y1 - y0) * 2
    rgb = np.full((H, W, 3), GREY, np.float32)
    a = np.zeros((H, W), np.float32)
    pt = np.zeros((H, W), np.float32)
    rects = []
    for f in frames:
        X, Y = (f['offset'][0] - x0) * 2, (f['offset'][1] - y0) * 2
        fa = f['hd'][..., 3] / 255
        h, w = fa.shape
        rects.append((X, Y, w, h))
        ys, xs = max(0, Y), max(0, X)
        ye, xe = min(H, Y + h), min(W, X + w)
        if ye <= ys or xe <= xs:
            continue
        sl = (slice(ys, ye), slice(xs, xe))
        fs = (slice(ys - Y, ye - Y), slice(xs - X, xe - X))
        fa = fa[fs]
        rgb[sl] = f['hd'][fs][..., :3] * fa[..., None] + rgb[sl] * (1 - fa[..., None])
        pt[sl] = f['paint2'][fs] * fa + pt[sl] * (1 - fa)
        a[sl] = fa + a[sl] * (1 - fa)
    c = dict(rgb=rgb, a=a, paint=pt, origin=[x0, y0], size1=[x1 - x0, y1 - y0], rects=rects, frames=frames,
             parts=parts, house=house, ramp=ramp)
    if design_palette is not None:
        c['rgb'] = design_rgb(lib, c, design_palette)
    return c


def pad2(img, m2, fill):
    if img.ndim == 3:
        return np.pad(img, ((m2, m2), (m2, m2), (0, 0)), constant_values=fill)
    return np.pad(img, ((m2, m2), (m2, m2)), constant_values=fill)


def model_input(c, F):
    """Grey-background model input: composite + margin, Lanczos-enlarged to F x of 1x."""
    rgb = pad2(c['rgb'], 2 * M, GREY)
    H, W = rgb.shape[:2]
    im = Image.fromarray(np.clip(np.rint(rgb), 0, 255).astype(np.uint8))
    return im.resize((W * F // 2, H * F // 2), Image.LANCZOS)


def load(p):
    return read_image(p, 'RGB').astype(np.float32)


def register_out(inp, raw):
    """Registration params (canvas pixel convention of hr.register) of a model image onto the input canvas."""
    ch, cw = inp.shape[:2]
    out_c = raw if raw.shape[:2] == (ch, cw) else hr.resize_linear(raw, (cw, ch))
    weight = hr.dilate(hr.foreground(inp, 6.0), 8)
    params, diag = hr.register(inp, out_c, weight)
    return params, diag


def guard_registration(params, label=''):
    """Identity when a registration scale leaves 0.8..1.25. The image model keeps the input canvas, so a far-off fit
    (seen: x4 on a pack cell with a large empty margin) is a failed solve that would smear the redraw over the frame."""
    if 0.8 < params[0] < 1.25 and 0.8 < params[2] < 1.25:
        return params
    print(f'{label}: registration rejected {[round(float(x), 4) for x in params]}, using identity')
    return (1.0, 0.0, 1.0, 0.0)


def sample(raw, canvas, params, F, scale):
    """Registered image at `scale` x of 1x (canvas is F x of 1x), box filtered in linear light from the model image."""
    cw, ch = canvas
    return hr.registered_4x(raw, (cw, ch), (round(cw * scale / F), round(ch * scale / F)), F / scale, params)


def smoothstep(e0, e1, x):
    t = np.clip((x - e0) / (e1 - e0), 0, 1)
    return t * t * (3 - 2 * t)


def finish(c, rep2, *, lockL=0.1, sigL=14.0, lockab=0.25, sigab=8.0, contrast=0.5, crad=1.2, paint_dilate=3,
           fg=None):
    """rep2: registered redraw at 2x over the box (no margin). Returns encoded RGBA (atlas form), remap (0..255) and the
    displayed preview, all over the composite box."""
    a = c['a']
    inside = a > 0.02
    wgt = inside.astype(np.float32)
    rep = rep2.copy()
    # Silhouette pixels where the redraw shows background (it shrank the object): bleed redraw colour from inside.
    if fg is None:
        fg = hr.foreground(rep, 10.0)
    # Only near the silhouette (mid-grey concrete inside the object must not be mistaken for background).
    rim = hr.dilate(~inside, 8) & inside
    known = inside & ~(rim & ~fg)
    if (~known & inside).any():
        rep = rd.bleed(rep, known, steps=12)
    lab_rep, lab_ref = rd.srgb_to_lab(rep), rd.srgb_to_lab(c['rgb'])
    out = lab_rep.copy()
    for ch, sig, w in ((0, sigL, lockL), (1, sigab, lockab), (2, sigab, lockab)):
        if w <= 0:
            continue
        lo_rep = rd.masked_blur(lab_rep[..., ch], wgt, sig)
        lo_ref = rd.masked_blur(lab_ref[..., ch], wgt, sig)
        out[..., ch] = lab_rep[..., ch] + w * (lo_ref - lo_rep)
    if contrast > 0:
        L = out[..., 0]
        out[..., 0] = np.clip(L + contrast * (L - rd.masked_blur(L, wgt, crad)), 0, 100)
    final = np.clip(rd.lab_to_srgb(out), 0, 255)
    # House paint from the redraw: blue-hue, chromatic pixels near the original paint.
    ramp = np.asarray(c['ramp'], np.float32)
    lab_ramp = rd.srgb_to_lab(ramp[None])[0]
    hue_house = math.atan2(lab_ramp[:, 2].mean(), lab_ramp[:, 1].mean())
    labf = rd.srgb_to_lab(final)
    C = np.hypot(labf[..., 1], labf[..., 2])
    hue = np.arctan2(labf[..., 2], labf[..., 1])
    dh = np.abs((hue - hue_house + np.pi) % (2 * np.pi) - np.pi)
    region = hr.dilate(c['paint'] > 0.5, paint_dilate) & inside
    p = region & (C > 12) & (dh < math.radians(45))
    p = p.astype(np.float32)
    grey = rd.neutral_to_grey(final, ramp)
    enc = np.where(p[..., None] > 0.5, grey, final)
    enc = rd.bleed(enc, inside, steps=8)
    rgba = np.dstack([hr.to_u8(enc), hr.to_u8(a * 255)])
    remap = hr.to_u8(p * 255)
    # Displayed colours (decode exactly like the shader).
    k = np.clip((255 - enc[..., 1]) / 15, 0, 15)
    k0 = np.floor(k).astype(int)
    k1 = np.minimum(k0 + 1, 15)
    col = ramp[k0] + (ramp[k1] - ramp[k0]) * (k - k0)[..., None]
    shown = enc * (1 - p[..., None]) + col * p[..., None]
    return rgba, remap, shown, final


def over_grey(rgb, a, bg=GREY):
    return rgb * a[..., None] + bg * (1 - a[..., None])


def patch_name(sprite, frame):
    return f"{sprite.replace(':', '_')}#{frame}"


def save_patch(sprite, frame, rgba, remap, tag='', *, patches):
    patches = Path(patches)
    patches.mkdir(parents=True, exist_ok=True)
    n = patch_name(sprite, frame)
    Image.fromarray(rgba).save(patches / f'{n}.png')
    Image.fromarray(remap).save(patches / f'{n}-remap.png')
    if tag:
        (patches / f'{n}.src').write_text(tag)


def model_patch(sprite, frame, patches):
    """Treat an existing patch without provenance as model-owned too."""
    name = patch_name(sprite, frame)
    source = Path(patches) / f'{name}.src'
    return (Path(patches) / f'{name}.png').exists() and not (
        source.exists() and source.read_text(encoding='utf-8').startswith('xfer'))


class Xfer:
    """Transfer stored HD blocks where anchor-aligned 1x indices match a redraw."""

    def __init__(self, lib, patches, delta=False):
        self.lib = lib
        self.patches = Path(patches)
        self.delta = delta

    def raw(self, sprite, frame):
        f = self.lib.lib['sprites'][sprite]['frames'][frame]
        x, y, w, h = f['rect']
        page = f.get('page', 0)
        idx = self.lib.idx_page(page)[y:y + h, x:x + w].astype(np.int32)
        hd, remap = self.lib.hd_page(page)
        block = (slice(2 * y, 2 * (y + h)), slice(2 * x, 2 * (x + w)))
        return idx, hd[block].astype(np.float32), remap[block].astype(np.float32) / 255, tuple(f['offset'])

    def hd_of(self, sprite, frame):
        idx, rgba, remap, offset = self.raw(sprite, frame)
        path = self.patches / f'{patch_name(sprite, frame)}.png'
        redrawn = False
        if path.exists():
            patch = read_image(path, 'RGBA').astype(np.float32)
            if patch.shape == rgba.shape:
                rgba = patch
                remap = read_image(path.with_name(path.stem + '-remap.png'), 'L').astype(np.float32) / 255
                if remap.shape != rgba.shape[:2]:
                    raise ValueError(f'remap size differs from patch: {path}')
                redrawn = True
        return idx, rgba, remap, offset, redrawn

    def reference(self, parts):
        if not parts:
            raise ValueError('transfer reference needs at least one part')
        items = [self.hd_of(*parse_part(part)) for part in parts]
        x0 = min(o[0] for _, _, _, o, _ in items) - 64
        y0 = min(o[1] for _, _, _, o, _ in items) - 64
        width = max(o[0] + i.shape[1] for i, _, _, o, _ in items) - x0 + 64
        height = max(o[1] + i.shape[0] for i, _, _, o, _ in items) - y0 + 64
        idx = np.full((height, width), -1, np.int32)
        redrawn = np.zeros((height, width), bool)
        colour = np.zeros((2 * height, 2 * width, 3), np.float32)
        alpha = np.zeros((2 * height, 2 * width), np.float32)
        paint = np.zeros_like(alpha)
        for indices, rgba, remap, (ox, oy), red in items:
            h, w = indices.shape
            x, y = ox - x0, oy - y0
            mask = indices > 0
            idx[y:y + h, x:x + w][mask] = indices[mask]
            redrawn[y:y + h, x:x + w][mask] = red
            a = rgba[..., 3] / 255
            block = (slice(2 * y, 2 * (y + h)), slice(2 * x, 2 * (x + w)))
            colour[block] = rgba[..., :3] * a[..., None] + colour[block] * (1 - a[..., None])
            paint[block] = np.where(a > 0.5, remap, paint[block])
            alpha[block] = a + alpha[block] * (1 - a)
        colour /= np.maximum(alpha, 1e-3)[..., None]
        return dict(idx=idx, red=redrawn, col=colour, rm=paint, origin=(x0, y0))

    def colour_changed(self, sprite, idx, rid, rred, equal):
        """Pixels of colour-cycling, glow or flicker frames: the silhouette stays in place (overlap with the
        reference above 0.93) and only palette indices change. Both frames cover the pixel's 3x3 neighbourhood;
        house-paint indices of remapped sprites are excluded (their stored ramp code must not be shifted)."""
        a0, a1 = rid > 0, idx > 0
        union = (a0 | a1).sum()
        if not union or (a0 & a1).sum() / union <= 0.93:
            return None
        both = cv2.erode((a0 & a1).astype(np.uint8), np.ones((3, 3), np.uint8)).astype(bool)
        changed = both & (rid != idx) & rred & ~equal
        if self.lib.lib['sprites'][sprite].get('remap'):
            changed &= ~((idx >= 16) & (idx < 32)) & ~((rid >= 16) & (rid < 32))
        return changed

    def shift_colour(self, sprite, redraw, idx, rid, changed):
        """Keep the redraw's invented detail and shift it by the 1x colour change (Lab delta, smoothed at 2x)."""
        palette = self.lib.pal[self.lib.lib['sprites'][sprite]['palette']].astype(np.float32) / 255
        lab = cv2.cvtColor(palette[None], cv2.COLOR_RGB2LAB)[0]
        delta = lab[np.clip(idx, 0, 255)] - lab[np.clip(rid, 0, 255)]
        delta[~changed] = 0
        delta = cv2.GaussianBlur(np.repeat(np.repeat(delta, 2, 0), 2, 1).astype(np.float32), (0, 0), 0.6)
        lab_redraw = cv2.cvtColor((redraw / 255).astype(np.float32), cv2.COLOR_RGB2LAB) + delta
        lab_redraw[..., 0] = np.clip(lab_redraw[..., 0], 0, 100)
        shifted = np.clip(cv2.cvtColor(lab_redraw, cv2.COLOR_LAB2RGB) * 255, 0, 255)
        mask = np.repeat(np.repeat(changed, 2, 0), 2, 1)
        return np.where(mask[..., None], shifted, redraw)

    def transfer(self, ref, sprite, frame):
        idx, rgba, remap, (ox, oy) = self.raw(sprite, frame)
        h, w = idx.shape
        if h == 0 or w == 0 or not (idx > 1).any():
            return None
        x, y = ox - ref['origin'][0], oy - ref['origin'][1]
        height, width = ref['idx'].shape
        if x < 0 or y < 0 or x + w > width or y + h > height:
            return None
        rid, rred = ref['idx'][y:y + h, x:x + w], ref['red'][y:y + h, x:x + w]
        equal = (idx > 0) & (rid == idx) & rred
        changed = self.colour_changed(sprite, idx, rid, rred, equal) if self.delta else None
        if equal.sum() + (0 if changed is None else changed.sum()) < 4:
            return None
        block = (slice(2 * y, 2 * (y + h)), slice(2 * x, 2 * (x + w)))
        redraw, redraw_remap = ref['col'][block], ref['rm'][block]
        if changed is not None and changed.any():
            redraw = self.shift_colour(sprite, redraw, idx, rid, changed)
            equal = equal | changed
        mask = np.repeat(np.repeat(equal, 2, 0), 2, 1).astype(np.float32)
        base = rgba[..., :3].copy()
        nonpaint = (remap < 0.05) & (redraw_remap < 0.05)
        fit = (mask > 0.5) & nonpaint & (rgba[..., 3] > 128)
        if fit.sum() > 200:
            lab_base = cv2.cvtColor(base / 255, cv2.COLOR_RGB2LAB)
            lab_redraw = cv2.cvtColor(redraw / 255, cv2.COLOR_RGB2LAB)
            adjusted = lab_base.copy()
            for channel in range(3):
                mb, mr = lab_base[..., channel][fit].mean(), lab_redraw[..., channel][fit].mean()
                if channel == 0:
                    sb = lab_base[..., 0][fit].std() + 1e-3
                    sr = lab_redraw[..., 0][fit].std() + 1e-3
                    gain = float(np.clip(sr / sb, 0.85, 1.35))
                    adjusted[..., 0] = (lab_base[..., 0] - mb) * gain + mr
                else:
                    adjusted[..., channel] = lab_base[..., channel] + (mr - mb)
            adjusted = cv2.cvtColor(adjusted, cv2.COLOR_LAB2RGB) * 255
            adjusted += 0.45 * (adjusted - cv2.GaussianBlur(adjusted, (0, 0), 1.0))
            base = np.where(nonpaint[..., None], adjusted, base)
        feather = cv2.GaussianBlur(mask, (0, 0), 0.7)
        # Bound the feather to the matched region's immediate rim.
        feather = np.minimum(feather, cv2.dilate(mask, np.ones((3, 3))))
        colour = redraw * feather[..., None] + base * (1 - feather[..., None])
        # House paint is stored as a ramp code; blending codes changes the owner's colour.
        paint = (remap > 0.05) | (redraw_remap > 0.05)
        colour[paint] = np.where((mask[paint] > 0.5)[..., None], redraw[paint], rgba[..., :3][paint])
        output_remap = np.where(mask > 0.5, redraw_remap, remap)
        output = np.dstack([np.clip(np.rint(colour), 0, 255), rgba[..., 3]]).astype(np.uint8)
        return output, np.clip(np.rint(output_remap * 255), 0, 255).astype(np.uint8), float(
            equal.sum() / max(1, (idx > 0).sum()))


def xfer_targets(lib, name, state):
    building = lib.lib['types'][name]['building']
    if state == 'mk':
        return [building['buildup']] if building.get('buildup') else []
    return [layer['damagedSprite'] if state == 'd' else layer['sprite']
            for layer in building['layers'] if state != 'd' or 'damagedSprite' in layer]


def save_xfer_patch(sprite, frame, result, tag, patches):
    if result is None or model_patch(sprite, frame, patches):
        return False
    patches = Path(patches)
    patches.mkdir(parents=True, exist_ok=True)
    rgba, remap, _ = result
    name = patch_name(sprite, frame)
    atomic_image(patches / f'{name}.png', Image.fromarray(rgba))
    atomic_image(patches / f'{name}-remap.png', Image.fromarray(remap))
    (patches / f'{name}.src').write_text(tag, encoding='utf-8')
    return True


def xfer(lib, name, state, *, patches, parts=None, log=None, delta=False):
    """Transfer an idle redraw to one state; explicit parts also support bib-only buildings. delta: also keep the
    redraw (colour-shifted) on colour-cycling pixels whose silhouette is unchanged (Xfer.colour_changed)."""
    if state not in ('i', 'd', 'mk'):
        raise ValueError('transfer state must be i, d or mk')
    transfer = Xfer(lib, patches, delta=delta)
    ref = transfer.reference(idle_parts(lib, name, damaged=state == 'd', include_auxiliary=True)
                             if parts is None else parts)
    count = 0
    for sprite in dict.fromkeys(xfer_targets(lib, name, state)):
        for frame in range(len(lib.lib['sprites'][sprite]['frames'])):
            if model_patch(sprite, frame, patches):
                continue
            result = transfer.transfer(ref, sprite, frame)
            if save_xfer_patch(sprite, frame, result, f'xfer:{name}_{state}', patches):
                count += 1
                if log is not None:
                    log.append(f'{sprite}#{frame} {result[2]:.2f}')
    return count


def walls_xfer(lib, name, *, patches):
    """Damaged wall frame k reuses the accepted connection piece k % 16."""
    sprite = lib.lib['types'][name]['sprite']
    transfer = Xfer(lib, patches)
    count = 0
    for frame in range(16, len(lib.lib['sprites'][sprite]['frames'])):
        if model_patch(sprite, frame, patches) or not model_patch(sprite, frame % 16, patches):
            continue
        ref = transfer.reference([f'{sprite}:{frame % 16}'])
        result = transfer.transfer(ref, sprite, frame)
        count += save_xfer_patch(sprite, frame, result, f'xfer:{name}_wall', patches)
    return count


def sheet_patch(sprite, frame, patches):
    """True when the patch was posted from a model animation sheet (provenance 'sheet ...')."""
    source = Path(patches) / f'{patch_name(sprite, frame)}.src'
    return source.exists() and source.read_text(encoding='utf-8').startswith('sheet')


def damaged_from_sheet(lib, intact, damaged, *, patches, log=None):
    """Damaged loop frame k <- the model-drawn intact frame k of the same layer. Damaged loops share most pixels with
    their intact loop, so a sheet redraw of the intact loop also details the damaged one (where 1x indices match)
    instead of the static damaged body. Model-owned damaged frames stay untouched."""
    sprites = lib.lib['sprites']
    transfer = Xfer(lib, patches)
    count = 0
    for frame in range(min(len(sprites[intact]['frames']), len(sprites[damaged]['frames']))):
        if not sheet_patch(intact, frame, patches) or model_patch(damaged, frame, patches):
            continue
        result = transfer.transfer(transfer.reference([f'{intact}:{frame}']), damaged, frame)
        if save_xfer_patch(damaged, frame, result, f'xfer:sheet {intact}', patches):
            count += 1
            if log is not None:
                log.append(f'{damaged}#{frame} {result[2]:.2f}')
    return count


def restore_paint_hue(design, redraw, hue=38.0, *, min_chroma=30.0, tolerance=35.0):
    """Undo a generated sheet's hue drift on fixed (non-remap) paint, e.g. red Tesla fins redrawn violet.

    design/redraw are RGB uint8 (design is resized to the redraw). Where the design shows chromatic paint near `hue`
    (Lab degrees), redraw pixels of a blue-violet hue (-150..-10 degrees) within a small dilation get the design's
    median paint hue; lightness is kept and chroma kept or raised towards the design's. Returns (rgb, count)."""
    grow = max(2, int(round(3 * redraw.shape[1] / design.shape[1])))
    design = cv2.resize(np.ascontiguousarray(design[..., :3]), (redraw.shape[1], redraw.shape[0]),
                        interpolation=cv2.INTER_NEAREST)
    lab_d = cv2.cvtColor(design, cv2.COLOR_RGB2LAB).astype(np.float32)
    lab_r = cv2.cvtColor(np.ascontiguousarray(redraw[..., :3]), cv2.COLOR_RGB2LAB).astype(np.float32)
    def polar(lab):
        a, b = lab[..., 1] - 128, lab[..., 2] - 128
        return np.hypot(a, b), np.degrees(np.arctan2(b, a))
    c_d, h_d = polar(lab_d)
    paint = (c_d > min_chroma) & (np.abs((h_d - hue + 180) % 360 - 180) < tolerance)
    if not paint.any():
        return np.ascontiguousarray(redraw[..., :3]).copy(), 0
    near = cv2.dilate(paint.astype(np.uint8), np.ones((2 * grow + 1, 2 * grow + 1), np.uint8)) > 0
    c_r, h_r = polar(lab_r)
    sel = near & (c_r > 8) & (h_r < -10) & (h_r > -150)
    target = np.radians(np.median(h_d[paint]))
    chroma = np.maximum(c_r * 1.2, np.median(c_d[paint]) * 0.8)
    lab_r[..., 1] = np.where(sel, 128 + chroma * np.cos(target), lab_r[..., 1])
    lab_r[..., 2] = np.where(sel, 128 + chroma * np.sin(target), lab_r[..., 2])
    rgb = cv2.cvtColor(np.clip(lab_r, 0, 255).astype(np.uint8), cv2.COLOR_LAB2RGB)
    rgb = np.where(sel[..., None], rgb, redraw[..., :3]).astype(np.uint8)
    return rgb, int(sel.sum())


def fix_sheet_hue(jobdir, hue=38.0):
    """Apply restore_paint_hue to a job's raw.png (or output.png), keeping the first original as *_prefix.png."""
    jobdir = Path(jobdir)
    source = jobdir / ('raw.png' if (jobdir / 'raw.png').exists() else 'output.png')
    backup = source.with_name(source.stem + '_prefix.png')
    if not backup.exists():
        shutil.copy(source, backup)
    rgb, count = restore_paint_hue(read_image(jobdir / 'input.png', 'RGB'), read_image(backup, 'RGB'), hue)
    atomic_image(source, Image.fromarray(rgb))
    return count


def index_paint(lib, sprite, *, patches, min_chroma=10.0, grow=2, hue_tolerance=30.0):
    """Encode house paint in existing patches of `sprite` from the 1x palette indices 16..31.

    The live renderer draws every building sprite (body, layers, bib, build-up) with the owner's remap, so pixels that
    are house paint in the original must be paint in HD too. Posting only keeps paint where the baseline remap page has
    it, which is empty for some sprites (e.g. Tesla fins, prism tower bands, some build-ups): their redraw bakes the
    default red. Chromatic, not yet painted texels over index 16..31 are re-encoded on the grey ramp of the sprite's
    own unremapped palette ramp (luminance kept), so they decode to the same red for the default house.
    Redraws are registered, not pixel-exact: texels within `grow` (2x) pixels of the index mask whose hue is within
    `hue_tolerance` degrees of the ramp's are encoded too, so no default-red fringe remains on other houses.
    Returns the number of texels encoded."""
    entry = lib.lib['sprites'][sprite]
    ramp = lib.pal[entry['palette']][16:32].astype(np.float32)
    ramp_lab = cv2.cvtColor(np.clip(ramp, 0, 255).astype(np.uint8)[None], cv2.COLOR_RGB2LAB)[0].astype(np.float32)
    ramp_hue = math.degrees(math.atan2((ramp_lab[:, 2] - 128).mean(), (ramp_lab[:, 1] - 128).mean()))
    count = 0
    for frame, f in enumerate(entry['frames']):
        x, y, w, h = f['rect']
        path = Path(patches) / f'{patch_name(sprite, frame)}.png'
        if not w or not path.exists():
            continue
        idx = lib.idx_page(f.get('page', 0))[y:y + h, x:x + w]
        house = np.repeat(np.repeat((idx >= 16) & (idx < 32), 2, 0), 2, 1)
        rgba = read_image(path, 'RGBA').copy()
        remap_path = path.with_name(path.stem + '-remap.png')
        remap = read_image(remap_path, 'L').copy()
        if house.shape != remap.shape:
            raise ValueError(f'patch size differs from the frame: {path}')
        lab = cv2.cvtColor(np.ascontiguousarray(rgba[..., :3]), cv2.COLOR_RGB2LAB).astype(np.float32)
        chroma = np.hypot(lab[..., 1] - 128, lab[..., 2] - 128)
        hue = np.degrees(np.arctan2(lab[..., 2] - 128, lab[..., 1] - 128))
        near = cv2.dilate(house.astype(np.uint8), np.ones((2 * grow + 1, 2 * grow + 1), np.uint8)) > 0
        fringe = near & (np.abs((hue - ramp_hue + 180) % 360 - 180) < hue_tolerance) & (chroma > 1.8 * min_chroma)
        sel = (house | fringe) & (rgba[..., 3] > 0) & (chroma > min_chroma) & (remap == 0)
        if not sel.any():
            continue
        grey = rd.neutral_to_grey(rgba[..., :3].astype(np.float32), ramp)
        rgba[..., :3] = np.where(sel[..., None], np.clip(np.rint(grey), 0, 255), rgba[..., :3]).astype(np.uint8)
        remap[sel] = 255
        atomic_image(path, Image.fromarray(rgba, 'RGBA'))
        atomic_image(remap_path, Image.fromarray(remap))
        count += int(sel.sum())
    return count


def job_comp(lib, jobdir):
    lay = json.loads((Path(jobdir) / 'layout.json').read_text())
    x0, y0 = lay['origin']
    w, h = lay['size1']
    return lay, comp2x(lib, lay['parts'], lay.get('house', 'DarkBlue'), box=(x0, y0, x0 + w, y0 + h),
                      design_palette=lay.get('design_palette'))


def finish_4x(lib, jobdir, img4x, over=None, parts=None):
    """Encode a registered 4x box image (incl. margin) of a job like post4 does: returns rgba, remap, shown, c.
    parts: composite to lock against (default the job's own parts), e.g. the body with another anim frame."""
    lay, c = job_comp(lib, jobdir)
    if parts is not None:
        x0, y0 = lay['origin']
        w, h = lay['size1']
        c = comp2x(lib, parts, lay.get('house', 'DarkBlue'), box=(x0, y0, x0 + w, y0 + h),
                   design_palette=lay.get('design_palette'))
    H4, W4 = img4x.shape[:2]
    rep2m = cv2.resize(np.ascontiguousarray(img4x, np.float32), (W4 // 2, H4 // 2), interpolation=cv2.INTER_AREA)
    m2 = 2 * M
    rep2 = rep2m[m2:m2 + c['a'].shape[0], m2:m2 + c['a'].shape[1]]
    kw = dict(lay.get('finish', {}))
    kw.update(over or {})
    rgba, remap, shown, final = finish(c, rep2, **kw)
    return rgba, remap, shown, c


def layer_cover(lib, sprite, frames, origin, size1):
    """Union and intersection (2x, box space) of an anim's coverage over the given frames."""
    x0, y0 = origin
    U = np.zeros((size1[1] * 2, size1[0] * 2), np.float32)
    I = np.ones_like(U)
    for k in frames:
        f = lib.frame(sprite, k)
        a = np.zeros_like(U)
        X, Y = (f['offset'][0] - x0) * 2, (f['offset'][1] - y0) * 2
        fa = f['hd'][..., 3] / 255
        h, w = fa.shape
        ys, xs = max(0, Y), max(0, X)
        ye, xe = min(U.shape[0], Y + h), min(U.shape[1], X + w)
        a[ys:ye, xs:xe] = fa[ys - Y:ye - Y, xs - X:xe - X]
        U = np.maximum(U, a)
        I = np.minimum(I, a)
    return U, I


def split_box(lib, c, rgba, remap, loops=None):
    """Split an encoded box into per-part patches. Body pixels that an anim covers in frame 0 but not in every loop frame
    are refilled from visible body pixels (they show through in other frames). loops: {sprite: [frames]}."""
    out = []
    loops = loops or {}
    body_fix = np.zeros(c['a'].shape, bool)
    for p, rect in zip(c['parts'][1:], c['rects'][1:]):
        s, k = parse_part(p)
        fr = loops.get(s)
        if fr is None:
            fr = [k]
        U, I = layer_cover(lib, s, fr, c['origin'], c['size1'])
        a0 = np.zeros_like(U)
        X, Y, w, h = rect
        a0[Y:Y + h, X:X + w] = lib.frame(s, k)['hd'][..., 3] / 255
        body_fix |= (a0 > 0.3) & (I < 0.5)
    for i, (p, rect) in enumerate(zip(c['parts'], c['rects'])):
        s, k = parse_part(p)
        X, Y, w, h = rect
        f = c['frames'][i]
        a = f['hd'][..., 3]
        col = rgba[Y:Y + h, X:X + w, :3].astype(np.float32)
        rm = remap[Y:Y + h, X:X + w].copy()
        if i == 0 and body_fix.any():
            fix = body_fix[Y:Y + h, X:X + w]
            known = (a > 0) & ~fix
            col = rd.bleed(col, known, steps=24)
            rmf = rd.bleed(rm[..., None].astype(np.float32).repeat(3, -1), known, steps=24)[..., 0]
            rm = np.where(fix, (rmf > 127) * 255, rm).astype(np.uint8)
        rgba_p = np.dstack([hr.to_u8(rd.bleed(col, a > 0, steps=4)), a.astype(np.uint8)])
        rm = np.where(a > 0, rm, 0).astype(np.uint8)
        out.append((s, k, rgba_p, rm))
    return out


INTACT = """Task: image generation / image editing only. Do not write code other than what is needed to save or resize the image. Do not browse the web.

Files in this directory:
- input.png = DESIGN REFERENCE. One isometric building sprite from the classic real-time-strategy game Command & Conquer: Red Alert 2: {name}, intact. It was enlarged {F}x from a tiny original only {w1} pixels wide, so it is soft and blurry and shows almost no real detail. Flat grey (118,118,118) background.
{refs}
Use your image generation tool (with input.png as the main reference image{refuse}) to produce a REMASTERED version of input.png: the same building as if it had been rebuilt as a highly detailed modern 3D model and rendered by a modern game engine for a 2020s AAA remaster, seen from exactly the same isometric camera.

MOST IMPORTANT - INVENT THE MISSING DETAIL. The original was far too small to show real detail. Do not just sharpen the blurry shapes: re-imagine every surface with the real engineering detail such a structure would have, so that each part reads as a real, solid, finely detailed object. For this building ({design}):
{details}
Everywhere: panel seams, bolts and rivets, weld lines, hinges, handles, cables, small warning plates, realistic weathering (chipped paint on exposed edges, soot, rust streaks running down from joints, dust in crevices).
Detail must be crisp and legible at small size: clear shapes with strong local contrast (dark crevices and gaps, bright lit edges and bevels, specular glints on metal), realistic ambient occlusion in every recess and under every overhang. Sun from the upper left: faces turned to the left are lit, faces turned to the right are in soft shade. Realistic, grounded, gritty military-industrial look. NOT cartoon, NOT toy, NOT plastic, NOT painterly, NOT a sketch, no noise, no blur.

KEEP (design identity - do not break):
- identical camera angle (2.5D isometric, 2:1, orthographic) and framing: the building keeps exactly the same position, size and outer silhouette in the image; nothing is added outside the silhouette;
- the same major parts in the same places with the same proportions ({keep});
- the same colour scheme per part ({colours}). The blue paint is the owner's faction colour: keep it a clean, saturated blue on exactly the parts that are blue in input.png.
You are FREE to change, re-shape and add the small details inside each part - that is the goal. Do not copy the blurry blobs of input.png pixel by pixel.

Keep the flat grey (118,118,118) background around the building; no ground outside the building's own base, no cast shadow on the background, no people, no vehicles, no text labels.

Save the result as output.png in this directory with exactly the same pixel size as input.png (if the tool returns another size, resize the whole generated image to that size; keep everything visible, do not crop). Also copy the generated image before resizing to raw.png in this directory. Then reply with one line saying the tool used and the generated size before resizing.
"""


DAMAGED = """Task: image generation / image editing only. Do not write code other than what is needed to save or resize the image. Do not browse the web.

Files in this directory:
- input.png = DESIGN REFERENCE. One isometric building sprite from the classic real-time-strategy game Command & Conquer: Red Alert 2: {name}, DAMAGED in battle (holes, scorched, broken, bent and missing parts). It was enlarged {F}x from a tiny original only {w1} pixels wide, so it is soft and blurry. Flat grey (118,118,118) background.
- intact_remaster.png = THE SAME BUILDING, INTACT, ALREADY REMASTERED and approved by the art director: a highly detailed modern 3D-rendered look with invented real-world detail. Same camera, same framing as input.png.

Use your image generation tool (input.png as the main reference, intact_remaster.png as the look and detail reference) to produce the DAMAGED building in exactly the remastered look of intact_remaster.png: every intact part must look exactly like it does in intact_remaster.png (same materials, colours, invented details, lighting), and the damage must be exactly where input.png shows it (same holes, same broken, bent and missing parts, same scorch marks and rubble), rendered as real damage with invented detail: torn and bent metal sheets with jagged edges, exposed internal beams, pipes and cables, broken bricks with exposed mortar, shattered glass, deep soot and scorch gradients, small fires' black marks, scattered debris chunks on the base. Crisp, legible detail with strong local contrast; sun from the upper left; realistic, gritty; NOT cartoon, NOT painterly, no blur, no noise.

KEEP: identical camera and framing (same position, size and outer silhouette as input.png; nothing added outside the silhouette); the same major parts in the same places; the same colour scheme ({colours}); the blue faction paint stays blue on the same parts (scorched or chipped where damaged).

Keep the flat grey (118,118,118) background; no ground outside the building's own base, no cast shadow on the background, no people, no vehicles, no text labels.

Save the result as output.png in this directory with exactly the same pixel size as input.png (if the tool returns another size, resize the whole generated image to that size; keep everything visible, do not crop). Also copy the generated image before resizing to raw.png in this directory. Then reply with one line saying the tool used and the generated size before resizing.
"""


def refs_text(has_style, has_sibling):
    lines = []
    if has_style:
        lines.append('- style_reference.png = STYLE REFERENCE. The same building taken from a remaster concept image that the art director approved (it stands on its ground there). It shows the approved LOOK: realistic materials, strong sun and shade, clean crisp metal, rich contrast. It is small and soft; copy its look and colour mood, not its blur.')
    if has_sibling:
        lines.append('- sibling_reference.png = LOOK REFERENCE. Another building of the same game, already remastered in the approved target look (highly detailed, invented real-world detail, crisp materials, strong light). Match its rendering quality, level of detail, materials and lighting exactly; do not copy its shapes.')
    return '\n'.join(lines) + '\n'


def idle_parts(lib, name, damaged=False, storage=STORAGE, *, include_auxiliary=False):
    """Transfers include flat-building bibs and special idle layers; body jobs retain their selection."""
    t = lib.lib['types'][name]
    b = t['building']
    parts = []
    if include_auxiliary and b.get('bib'):
        frame = 1 if damaged and len(lib.lib['sprites'][b['bib']]['frames']) > 1 else 0
        parts.append(f"{b['bib']}:{frame}")
    frame = 1 if damaged else 0
    if not include_auxiliary or lib.lib['sprites'][t['sprite']]['frames'][frame]['rect'][2] > 0:
        parts.append(f"{t['sprite']}:{frame}")
    super_anim = False
    for L in b['layers']:
        k = L['key']
        on = k in ('ActiveAnim', 'IdleAnim') or (include_auxiliary and k == 'IdleAnimTwo') or (
            name not in storage and k in ('ActiveAnimTwo', 'ActiveAnimThree', 'ActiveAnimFour'))
        if include_auxiliary and k == 'SuperAnim' and not super_anim:
            on = True
            super_anim = True
        if not on:
            continue
        s = L.get('damagedSprite', L['sprite']) if damaged else L['sprite']
        parts.append(f"{s}:{L['anim'].get('loopStart', L['anim'].get('start', 0))}")
    return parts


def factor(c):
    w, h = c['size1']
    return max(4, min(10, round(1200 / (max(w, h) + 2 * M))))


def body_make(kind, name, lib, specs, work, *, style_dir=None, sibling=None, storage=STORAGE, design_palette=None):
    spec = specs[name]
    d = Path(work) / f'{name}_{kind[0]}'
    d.mkdir(parents=True, exist_ok=True)
    parts = idle_parts(lib, name, kind == 'damaged', storage)
    c = comp2x(lib, parts, design_palette=design_palette)
    F = factor(c)
    model_input(c, F).save(d / 'input.png')
    lay = dict(parts=parts, house='DarkBlue', factor=F, origin=c['origin'], size1=c['size1'],
               name=name, kind=kind, display_name=spec['name'])
    if design_palette is not None:
        lay['design_palette'] = design_palette
    write_json(d / 'layout.json', lay)
    fmt = dict(spec, F=F, w1=c['size1'][0], details='\n'.join('- ' + x for x in spec['details']))
    if kind == 'intact':
        has_style = bool(spec.get('style'))
        if has_style:
            im = Image.fromarray(read_image(Path(style_dir or '.') / spec['style'], 'RGB'))
            im.resize((im.width * 3, im.height * 3), Image.LANCZOS).save(d / 'style_reference.png')
        elif sibling:
            shutil.copy(sibling, d / 'sibling_reference.png')
        fmt['refs'] = refs_text(has_style, bool(sibling) and not has_style)
        fmt['refuse'] = ' and style_reference.png as a style reference' if has_style else (' and sibling_reference.png as a look reference' if sibling else '')
        prompt = INTACT.format(**fmt)
    else:
        src = Path(work) / f'{name}_i'
        Image.fromarray(read_image(src / 'output.png', 'RGB')).save(d / 'intact_remaster.png')
        prompt = DAMAGED.format(**fmt)
    (d / 'prompt.txt').write_text(prompt)
    print(d, F, parts)
    return d


def post(d, over=None, *, root=None, theater='urban'):
    """Register and finish a body job against its chosen design palette and cache.

    When root is omitted, layout['root'] may select an alternate composite and
    colour-lock cache (for example an ESRGAN baseline replacing a drifted redraw).
    An explicit root takes precedence; otherwise the usual HD_CACHE_DIR applies.
    """
    d = Path(d)
    lay = json.loads((d / 'layout.json').read_text())
    lib = lib_for(lay, root if root is not None else lay.get('root'), theater)
    x0, y0 = lay['origin']
    w, h = lay['size1']
    c = comp2x(lib, lay['parts'], lay.get('house', 'DarkBlue'), box=(x0, y0, x0 + w, y0 + h),
               design_palette=lay.get('design_palette'))
    inp = load(d / 'input.png')
    raw = load(d / ('raw.png' if (d / 'raw.png').exists() else 'output.png'))
    params, diag = register_out(inp, raw)
    params = guard_registration(params, d.name)
    if 'registration_params' in lay:
        chosen = lay['registration_params']
        if (not isinstance(chosen, (list, tuple)) or len(chosen) != 4
                or any(isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v)
                       for v in chosen)
                or not (0.8 < chosen[0] < 1.25 and 0.8 < chosen[2] < 1.25)):
            raise ValueError('registration_params must be four finite numbers [sx, tx, sy, ty] with scales in 0.8..1.25')
        # Repetitive facades can pull the automatic fit away from already aligned
        # source boundaries. Keep its evidence when applying a reviewed local fit.
        diag = dict(diag, auto_params=list(params), registration_source='layout',
                    registration_note=lay.get('registration_note', ''))
        params = tuple(float(v) for v in chosen)
    F = lay['factor']
    ch, cw = inp.shape[:2]
    rep2m = sample(raw, (cw, ch), params, F, 2)
    m2 = 2 * M
    rep2 = rep2m[m2:m2 + c['a'].shape[0], m2:m2 + c['a'].shape[1]]
    kw = dict(lay.get('finish', {}))
    kw.update(over or {})
    rgba, remap, shown, final = finish(c, rep2, **kw)
    out = d / 'post'
    out.mkdir(exist_ok=True)
    Image.fromarray(rgba).save(out / 'box_rgba.png')
    Image.fromarray(remap).save(out / 'box_remap.png')
    Image.fromarray(hr.to_u8(over_grey(shown, c['a']))).save(out / 'shown2x.png')
    Image.fromarray(hr.to_u8(over_grey(c['rgb'], c['a']))).save(out / 'orig2x.png')
    # 4x registered (for review / possible 4x pages)
    rep4m = sample(raw, (cw, ch), params, F, 4)
    Image.fromarray(hr.to_u8(rep4m)).save(out / 'reg4x.png')
    write_json(out / 'post.json', dict(
        params=params, diag={k: vv.tolist() if isinstance(vv, np.ndarray) else vv for k, vv in diag.items()},
        finish=kw, origin=c['origin'], size1=c['size1'], rects=c['rects'], parts=c['parts']))
    print(d.name, 'params', [round(x, 4) for x in params])
    return c, rgba, remap, shown


def body_patches(work, patches, jobs, *, root=None, theater='urban'):
    for job in jobs:
        d = Path(work) / job
        lib = lib_for(read_json(d / 'layout.json'), root, theater)
        lay, c = job_comp(lib, d)
        rgba = read_image(d / 'post' / 'box_rgba.png')
        remap = read_image(d / 'post' / 'box_remap.png')
        t = lib.lib['types'][lay['name']]['building']
        loops = {}
        for L in t['layers']:
            a = L['anim']
            st = a.get('loopStart', a.get('start', 0))
            en = max(a.get('loopEnd', st + 1), st + 1)
            for key in ('sprite', 'damagedSprite'):
                if key in L:
                    loops[L[key]] = list(range(st, en))
        intact_sprites = {L['sprite'] for L in t['layers']}
        for s, k, rp, rm in split_box(lib, c, rgba, remap, loops):
            if lay.get('kind') == 'damaged' and s in intact_sprites:
                continue  # layer without a damaged variant: the intact redraw owns it
            save_patch(s, k, rp, rm, tag=job, patches=patches)
            print(job, s, k, rp.shape)



ANIM_PROMPT = """Task: image generation / image editing only. Do not write code other than what is needed to save or resize the image. Do not browse the web.

Files in this directory:
- input.png = DESIGN REFERENCE: a sprite sheet of {n} ANIMATION FRAMES (reading order: left to right, then top to bottom; {cols} per row) of one part of {name} from the classic real-time-strategy game Command & Conquer: Red Alert 2, each cell enlarged {F}x from tiny blurry pixel art, on flat grey (118,118,118). Every cell shows the SAME part of the building from the same isometric camera; only {moving} changes from frame to frame.
- reference.png = the FIRST FRAME (the top-left cell) ALREADY REMASTERED and approved by the art director: a highly detailed modern 3D-rendered look with invented real-world detail.

Use your image generation tool (reference.png as the look and detail reference, input.png as the frame-by-frame design reference) to produce the WHOLE SHEET remastered, with exactly the same grid, cell positions and cell sizes as input.png:
- in every cell, everything that does not move must be IDENTICAL to reference.png (same shapes, materials, colours, invented details, lighting, same position in the cell) - the frames must play back without flicker;
- {moving} follows input.png exactly, cell by cell (same positions, sizes and shapes per frame), rendered in the same remastered look with invented real-world detail: crisp, legible, strong local contrast, sun from the upper left.{extra}
- keep the flat grey (118,118,118) between and around the cells and wherever input.png shows grey; no text, no labels, no frame numbers, no borders.

Save the result as output.png in this directory with exactly the same pixel size as input.png (if the tool returns another size, resize the whole generated image to that size; keep everything visible, do not crop). Also copy the generated image before resizing to raw.png in this directory. Then reply with one line saying the tool used and the generated size before resizing.
"""


BUILDUP_PROMPT = """Task: image generation / image editing only. Do not write code other than what is needed to save or resize the image. Do not browse the web.

Files in this directory:
- input.png = DESIGN REFERENCE: a sprite sheet of {n} BUILD-UP ANIMATION FRAMES (reading order: left to right, then top to bottom; {cols} per row) of {name} from the classic real-time-strategy game Command & Conquer: Red Alert 2, each cell enlarged {F}x from tiny blurry pixel art, on flat grey (118,118,118). The cells show the building being constructed: it rises and unfolds out of the ground from the same isometric camera, part by part.
- reference.png = the FINISHED building, ALREADY REMASTERED and approved by the art director: a highly detailed modern 3D-rendered look with invented real-world detail (panel seams, bolts, pipes, vents, grilles, cables, weathering).

Use your image generation tool (reference.png as the look and detail reference, input.png as the frame-by-frame design reference) to produce the WHOLE SHEET remastered, with exactly the same grid, cell positions and cell sizes as input.png:
- every cell follows input.png exactly: the same silhouette, the same parts present at the same positions, sizes and heights (do not add parts that are not yet built in that cell, do not remove parts that are there);
- every part visible in a cell looks exactly like the same part in reference.png (same materials, colours, invented details, lighting), so the build-up ends seamlessly on the finished building; parts that are still rising or unfolding keep their real-world detail; the blue paint stays a clean saturated blue on the same parts;
- crisp, legible, strong local contrast, sun from the upper left; frames must play back without flicker;
- keep the flat grey (118,118,118) between and around the cells and wherever input.png shows grey; no text, no labels, no frame numbers, no borders.

Save the result as output.png in this directory with exactly the same pixel size as input.png (if the tool returns another size, resize the whole generated image to that size; keep everything visible, do not crop). Also copy the generated image before resizing to raw.png in this directory. Then reply with one line saying the tool used and the generated size before resizing.
"""


def frames_box(lib, sprite, frames):
    x0 = y0 = 10 ** 6
    x1 = y1 = -10 ** 6
    for k in frames:
        f = lib.frame(*parse_part(k)) if isinstance(k, str) else lib.frame(sprite, k)
        x0 = min(x0, f['offset'][0])
        y0 = min(y0, f['offset'][1])
        x1 = max(x1, f['offset'][0] + f['rect'][2])
        y1 = max(y1, f['offset'][1] + f['rect'][3])
    return x0, y0, x1, y1


def parts_for(lay, sprite, k, replace=None):
    if isinstance(k, str):
        sprite, k = parse_part(k)
    out = []
    hit = False
    for p in lay['parts']:
        s, _ = parse_part(p)
        if s == sprite or (replace and s == replace):
            if not hit:
                out.append(f'{sprite}:{k}')
            hit = True
        else:
            out.append(p)
    if not hit:
        out.append(f'{sprite}:{k}')
    return out


def anim_make(job, body, sprite, frames, cols, F, moving, extra='', *, work, root=None, theater='urban', specs=None, buildup=False):
    W = Path(work)
    lay = json.loads((W / body / 'layout.json').read_text())
    lib = lib_for(lay, root, theater)
    select_parts = alone if buildup else parts_for
    if not frames or cols < 1 or F < 1:
        raise ValueError('frames, columns and factor must be positive')
    bx0, by0 = lay['origin']
    bw, bh = lay['size1']
    x0, y0, x1, y1 = frames_box(lib, sprite, frames)
    x0, y0, x1, y1 = x0 - PAD, y0 - PAD, x1 + PAD, y1 + PAD
    cw, ch = (x1 - x0) * F, (y1 - y0) * F
    rows = math.ceil(len(frames) / cols)
    sheet = Image.new('RGB', (cols * cw + (cols - 1) * GAP, rows * ch + (rows - 1) * GAP), (118, 118, 118))
    cells = []
    for i, k in enumerate(frames):
        c = comp2x(lib, select_parts(lay, sprite, k, replace=sprite), box=(x0, y0, x1, y1))
        im = Image.fromarray(np.clip(np.rint(over_grey(c['rgb'], c['a'])), 0, 255).astype(np.uint8)).resize((cw, ch), Image.LANCZOS)
        X, Y = (i % cols) * (cw + GAP), (i // cols) * (ch + GAP)
        sheet.paste(im, (X, Y))
        cells.append(dict(frame=k, box=[X, Y, cw, ch]))
    d = W / job
    d.mkdir(parents=True, exist_ok=True)
    sheet.save(d / 'input.png')
    # reference: the body redraw (4x registered, box incl. margin) cropped to the region, at cell size
    reg4 = Image.fromarray(read_image(W / body / 'post' / 'reg4x.png'))
    X4, Y4 = (x0 - bx0 + M) * 4, (y0 - by0 + M) * 4
    ref = Image.new('RGB', ((x1 - x0) * 4, (y1 - y0) * 4), (118, 118, 118))
    ref.paste(reg4, (-X4, -Y4))
    ref.resize((cw, ch), Image.LANCZOS).save(d / 'reference.png')
    layout = dict(body=body, sprite=sprite, frames=list(frames), cols=cols, F=F,
                  region=[x0, y0, x1, y1], cells=cells, name=lay['name'])
    display_name = (specs or {}).get(lay['name'], {}).get('name', lay.get('display_name', lay['name']))
    if buildup:
        # Explicit mode replaces the scratch script's global monkeypatch.
        layout['buildup'] = True
        np.save(d / 'static_none.npy', np.zeros(((y1 - y0) * 2, (x1 - x0) * 2), bool))
        layout['static_from'] = f'{job}/static_none.npy'
        prompt = BUILDUP_PROMPT.format(n=len(frames), cols=cols, name=display_name, F=F)
    else:
        prompt = ANIM_PROMPT.format(n=len(frames), cols=cols, name=display_name, F=F,
                                   moving=moving, extra=(' ' + extra) if extra else '')
    write_json(d / 'layout.json', layout)
    (d / 'prompt.txt').write_text(prompt, encoding='utf-8')
    print(d, sheet.size)
    return d


def lab_match(src, ref, mask):
    """Shift src's Lab mean to ref's over mask (cell tone drift)."""
    if mask.sum() < 50:
        return src
    ls, lr = rd.srgb_to_lab(src), rd.srgb_to_lab(ref)
    d = (lr[mask] - ls[mask]).mean(0)
    return np.clip(rd.lab_to_srgb(ls + d), 0, 255)


def anim_post(job, *, work, patches=None, root=None, theater='urban', buildup=False):
    W = Path(work)
    d = W / job
    L = json.loads((d / 'layout.json').read_text())
    body = L['body']
    sprite = L['sprite']
    F = L['F']
    blay = json.loads((W / body / 'layout.json').read_text())
    lib = lib_for(blay, root, theater)
    select_parts = alone if buildup or L.get('buildup') else parts_for
    bx0, by0 = blay['origin']
    x0, y0, x1, y1 = L['region']
    inp = load(d / 'input.png')
    raw = load(d / ('raw.png' if (d / 'raw.png').exists() else 'output.png'))
    ch_, cw_ = inp.shape[:2]
    out_c = raw if raw.shape[:2] == (ch_, cw_) else hr.resize_linear(raw, (cw_, ch_))
    bw, bh = blay['size1']
    ux0, uy0, ux1, uy1 = min(bx0, x0), min(by0, y0), max(bx0 + bw, x1), max(by0 + bh, y1)
    body4 = load(W / body / 'post' / 'reg4x.png')
    base4 = np.full(((uy1 - uy0 + 2 * M) * 4, (ux1 - ux0 + 2 * M) * 4, 3), 118, np.float32)
    bX, bY = (bx0 - ux0) * 4, (by0 - uy0) * 4
    base4[bY:bY + body4.shape[0], bX:bX + body4.shape[1]] = body4
    X4, Y4 = (x0 - ux0 + M) * 4, (y0 - uy0 + M) * 4
    rw4, rh4 = (x1 - x0) * 4, (y1 - y0) * 4
    base_reg = base4[Y4:Y4 + rh4, X4:X4 + rw4]
    ubox = (ux0, uy0, ux1, uy1)
    res = []
    prev_dir = d / 'frames'
    prev_dir.mkdir(exist_ok=True)
    # static mask over every frame of the layer when the anim is split across sheets (static_frames), else the sheet's
    comps = [comp2x(lib, select_parts(blay, sprite, k, replace=sprite), box=(x0, y0, x1, y1))
             for k in (L.get('static_frames') or [cc['frame'] for cc in L['cells']])]
    static2 = np.ones(comps[0]['a'].shape, bool)
    for cc in comps[1:]:
        static2 &= (np.abs(cc['rgb'] - comps[0]['rgb']).max(-1) < 3) & (np.abs(cc['a'] - comps[0]['a']) < 0.05)
    if L.get('static_from'):
        static2 = np.load(W / L['static_from'])
    for cell in L['cells']:
        k = cell['frame']
        X, Y, cw, chh = cell['box']
        csprite = sprite
        if isinstance(k, str):
            csprite, k = parse_part(k)
        ci, co = inp[Y:Y + chh, X:X + cw], out_c[Y:Y + chh, X:X + cw]
        weight = hr.dilate(hr.foreground(ci, 6.0), 6)
        try:
            params, _ = hr.register(ci, co, weight)
            if not (0.8 < params[0] < 1.25 and 0.8 < params[2] < 1.25):
                raise ValueError(params)
        except Exception as error:
            print(f'{job} frame {k}: registration fallback: {error}')
            params = (1.0, 0.0, 1.0, 0.0)
        # sample the cell (from the canvas-size image) at 4x of the region
        cell4 = hr.registered_4x(co, (cw, chh), (rw4, rh4), F / 4, params)
        # static mask from the original composites (frame k vs first frame)
        parts_k = select_parts(blay, csprite, k, replace=sprite)
        same2 = static2  # pixels identical in every frame of the sheet keep the body redraw
        same4 = cv2.resize(same2.astype(np.uint8), (rw4, rh4), interpolation=cv2.INTER_NEAREST).astype(np.float32)
        same4 = cv2.erode(same4, np.ones((3, 3), np.uint8))
        sm = cv2.GaussianBlur(same4, (0, 0), 1.2)
        cell4 = lab_match(cell4, base_reg, same4 > 0.5)
        mix = base_reg * sm[..., None] + cell4 * (1 - sm[..., None])
        img4 = base4.copy()
        img4[Y4:Y4 + rh4, X4:X4 + rw4] = mix
        c = comp2x(lib, parts_k, blay.get('house', 'DarkBlue'), box=ubox)
        H4, W4 = img4.shape[:2]
        rep2m = cv2.resize(np.ascontiguousarray(img4, np.float32), (W4 // 2, H4 // 2), interpolation=cv2.INTER_AREA)
        rep2 = rep2m[2 * M:2 * M + c['a'].shape[0], 2 * M:2 * M + c['a'].shape[1]]
        rgba, remap, shown, _ = finish(c, rep2, **blay.get('finish', {}))
        part = [i for i, p in enumerate(c['parts']) if p.startswith(csprite + ':')][0]
        PX, PY, pw, ph = c['rects'][part]
        a = lib.frame(csprite, k)['hd'][..., 3]
        col = rgba[PY:PY + ph, PX:PX + pw, :3].astype(np.float32)
        rp = np.dstack([hr.to_u8(rd.bleed(col, a > 0, steps=4)), a.astype(np.uint8)])
        rm = np.where(a > 0, remap[PY:PY + ph, PX:PX + pw], 0).astype(np.uint8)
        if patches is not None:
            save_patch(csprite, k, rp, rm, tag=f'sheet {job}', patches=patches)
        # preview: shown colours of the region at 2x
        rx, ry = (x0 - ux0) * 2, (y0 - uy0) * 2
        Image.fromarray(hr.to_u8(over_grey(shown, c['a'])[ry:ry + (y1 - y0) * 2, rx:rx + (x1 - x0) * 2])).save(prev_dir / f'f{len(res):02d}.png')
        res.append(k)
    print(job, 'frames', res)


def alone(lay, sprite, k, replace=None):
    if isinstance(k, str):
        sprite, k = parse_part(k)
    return [f'{sprite}:{k}']


NORMALS_PROMPT = """Task: image generation / image editing only. Do not write code other than what is needed to save or resize the image. Do not browse the web.

input.png is a rendered isometric view (2:1 dimetric game camera, looking down at about 30 degrees) of a building from a real-time-strategy game, on a flat grey background. Use your image generation tool with input.png as the reference to produce its CAMERA-SPACE NORMAL MAP (a technical render pass, like the normal pass of a 3D renderer), with exactly the same framing, position, size and silhouette as input.png:
- background: pure black (0,0,0) everywhere outside the building;
- every pixel of the building coloured by the direction its surface faces, standard normal-map convention: red = facing right, green = facing up on screen, blue = facing the camera. Reference colours: flat tops and roofs facing straight up = (128,238,191); walls facing down-left on screen (the left-hand walls, lit by the sun in input.png) = (38,83,206); walls facing down-right on screen (the right-hand walls) = (218,83,206);
- curved surfaces (cylinders, cones, domes, pipes, tanks, spheres) blend smoothly through the normal colours around their curvature (a vertical cylinder goes from (38,83,206)-like on its left side through (128,83,250)-like at its front to (218,83,206)-like on its right side; a sphere or dome shows the full smooth gradient);
- all the small details visible in input.png (panel seams, bolts, rivets, ribs, louvres, ladders, pipes, valves, ore rocks, bricks) keep their own relief in the normal map, crisp and aligned with input.png;
- no lighting, no shadows, no colours other than normal-map colours, no text.

Save the result as output.png in this directory with exactly the same pixel size as input.png (resize the whole generated image if needed, do not crop). Also copy the generated image before resizing to raw.png. Then reply with one line saying the tool used and the generated size before resizing.
"""


def normals_job(work, jobs):
    for job in jobs:
        d = Path(work) / f'{job}_N'
        d.mkdir(parents=True, exist_ok=True)
        shutil.copy(Path(work) / job / 'output.png', d / 'input.png')
        (d / 'prompt.txt').write_text(NORMALS_PROMPT, encoding='utf-8')
        print(d)



def normals_assist(work, out, jobs, *, root=None, theater='urban', extra=None):
    assist_dir = Path(out)
    assist_dir.mkdir(parents=True, exist_ok=True)
    for job in jobs:
        d = Path(work) / job
        nd = Path(work) / f'{job}_N'
        lib = lib_for(read_json(d / 'layout.json'), root, theater)
        lay, c = job_comp(lib, d)
        post = json.loads((d / 'post' / 'post.json').read_text())
        sx, tx, sy, ty = post['params']
        out = load(d / 'output.png')
        nm = load(nd / 'output.png')
        if nm.shape != out.shape:
            nm = hr.resize_linear(nm, (out.shape[1], out.shape[0]))
        fa = hr.foreground(out, 10.0)
        fb = nm.max(-1) > 30
        ma = np.repeat((fa * 255.0)[..., None], 3, -1)
        mb = np.repeat((fb * 255.0)[..., None], 3, -1)
        pn, _ = hr.register(ma, mb, hr.dilate(fa, 12))
        sxn, txn, syn, tyn = pn
        comp = (sxn * sx, sxn * tx + txn, syn * sy, syn * ty + tyn)
        inp = load(d / 'input.png')
        ch, cw = inp.shape[:2]
        n2m = sample(nm, (cw, ch), comp, lay['factor'], 2)
        m2 = 2 * M
        n2 = n2m[m2:m2 + c['a'].shape[0], m2:m2 + c['a'].shape[1]]
        # renormalise the vectors after filtering
        vec = n2 / 127.5 - 1
        vec /= np.maximum(np.linalg.norm(vec, axis=-1, keepdims=True), 1e-3)
        n2 = np.clip((vec + 1) * 127.5, 0, 255)
        t = lib.lib['types'][lay['name']]['building']
        loops = {}
        for L in t['layers']:
            a = L['anim']
            st = a.get('loopStart', a.get('start', 0))
            en = max(a.get('loopEnd', st + 1), st + 1)
            for key in ('sprite', 'damagedSprite'):
                if key in L:
                    loops[L[key]] = list(range(st, en))
        for i, (p, rect) in enumerate(zip(c['parts'], c['rects'])):
            s, k = parse_part(p)
            X, Y, w, h = rect
            a = c['frames'][i]['hd'][..., 3] > 0
            img = np.where(a[..., None], n2[Y:Y + h, X:X + w], 0).astype(np.uint8)
            targets = [(s, k)]
            if s.startswith('anim:'):
                for kk in loops.get(s, []):
                    targets.append((s, kk))
                for s2 in (extra or {}).get(s, []):
                    for kk in loops.get(s2, [0, 1, 2]):
                        targets.append((s2, kk))
            for s2, kk in dict.fromkeys(targets):
                f2 = lib.frame(s2, kk)
                if f2['hd'].shape[:2] != img.shape[:2] or tuple(f2['offset']) != tuple(c['frames'][i]['offset']):
                    continue  # other geometry: the classifier handles it
                Image.fromarray(img).save(assist_dir / f'{patch_name(s2, kk)}.png')
        print(job, 'normals ok', [round(x, 4) for x in pn])



def atomic_image(path, image, *, root=None):
    """Stage outside the farm, then publish through its copy-on-write installer."""
    path = Path(path)
    root = Path(root) if root is not None else path.parent
    with tempfile.TemporaryDirectory(prefix='building-image-') as directory:
        tmp = Path(directory) / 'image.png'
        image.save(tmp, compress_level=1)
        cache_farm.install_file(root, str(path.relative_to(root)), tmp)


def atomic_json(path, value, *, root=None):
    path = Path(path)
    root = Path(root) if root is not None else path.parent
    with tempfile.TemporaryDirectory(prefix='building-json-') as directory:
        tmp = Path(directory) / 'data.json'
        write_json(tmp, value)
        cache_farm.install_file(root, str(path.relative_to(root)), tmp)


def compose(library, patches, only=None, record='l4_frames_bldg.json'):
    """Serialize page reads, copy-on-write replacements and record merges across cooperating writers.

    The library-wide lock is deliberately held before any manifest/page/record read.
    Other tools modifying these pages must acquire the same .compose.lock.
    """
    root = Path(library)
    if Path(record).name != record or not record.endswith('.json') or record == 'library.json':
        raise ValueError('record must be a JSON filename other than library.json')
    farm = root.parent.parent if root.parent.name == '_library' else root
    cache_farm.ensure_directory(farm, str(root.relative_to(farm)))
    with cache_farm.lock_file(root, '.compose.lock'):
        lib = read_json(root / 'library.json')
        groups = {}
        for p in sorted(Path(patches).glob('*#*.png')):
            if p.name.endswith('-remap.png'):
                continue
            sid, fr = p.stem.rsplit('#', 1)
            sprite = sid.replace('_', ':', 1)
            if only and not any(sprite.startswith(o) for o in only):
                continue
            fi = int(fr)
            if fi < 0:
                raise ValueError(f'negative frame: {p.name}')
            f = lib['sprites'][sprite]['frames'][fi]
            groups.setdefault(f.get('page', 0), []).append((sprite, fi, f, p))
        record_path = root / record
        records = read_json(record_path) if record_path.exists() else {}
        for page, items in sorted(groups.items()):
            ref = lib['spriteAtlasesHd'][page]
            scale = ref.get('scale', 2)
            prepared = []
            # Validate both colour and remap before replacing either page.
            for sprite, fi, frame, p in items:
                x, y, w, h = frame['rect']
                rgba = read_image(p, 'RGBA')
                remap = read_image(p.with_name(p.stem + '-remap.png'), 'L')
                shape = (scale * h, scale * w)
                if rgba.shape[:2] != shape or remap.shape != shape:
                    raise ValueError(f'patch size differs from atlas rect: {p.name}')
                prepared.append((frame, rgba, remap))
            images = []
            for key in ('file', 'remap'):
                path = root / ref[key]
                with Image.open(path) as im:
                    mode, arr = im.mode, np.array(im)
                for frame, rgba, remap in prepared:
                    x, y, w, h = frame['rect']
                    if min(x, y) < 0 or scale * (x + w) > arr.shape[1] or scale * (y + h) > arr.shape[0]:
                        raise ValueError('frame rect lies outside the HD page')
                    sl = (slice(scale * y, scale * (y + h)), slice(scale * x, scale * (x + w)))
                    if key == 'file':
                        if arr.ndim != 3 or arr.shape[2] not in (3, 4):
                            raise ValueError('HD colour page must be RGB or RGBA')
                        arr[sl] = rgba if arr.shape[2] == 4 else rgba[..., :3]
                    elif arr.ndim == 2:
                        arr[sl] = remap
                    else:
                        arr[sl][..., :min(3, arr.shape[2])] = remap[..., None]
                images.append((path, Image.fromarray(arr, mode)))
            for path, im in images:
                atomic_image(path, im, root=root)
            for sprite, fi, _, _ in items:
                records.setdefault(sprite, [])
                if fi not in records[sprite]:
                    records[sprite].append(fi)
            print(f'page {page}: {len(items)} frames')
        atomic_json(record_path, {k: sorted(v) for k, v in sorted(records.items())}, root=root)
    return records


def read_image(path, mode=None):
    with Image.open(path) as im:
        return np.array(im.convert(mode) if mode else im)


def coverage_records(library, patches, records):
    """Read frame provenance without decoding atlas pages or patch images."""
    earlier, model, xfer = {}, {}, {}
    for name in records:
        if Path(name).name != name:
            raise ValueError('records must be filenames inside the library directory')
        path = Path(library) / name
        if not path.exists():
            continue
        data = read_json(path)
        if isinstance(data, dict):
            for sprite, frames in data.items():
                if isinstance(frames, list):
                    earlier.setdefault(sprite, set()).update(frames)
        else:
            for entry in data:
                if entry.get('status') != 'REVERTED_TO_ORIGINAL':
                    earlier.setdefault(entry['sprite'], set()).add(entry['frame'])
    for source in sorted(Path(patches).glob('*.src')):
        try:
            stem, frame = source.stem.rsplit('#', 1)
            kind, sep, name = stem.partition('_')
            frame = int(frame)
        except ValueError:
            continue
        if not sep or not kind or not name or frame < 0:
            continue
        tag = source.read_text(encoding='utf-8')
        target = earlier if tag.startswith(('l4civ', 'map-copy')) else (
            xfer if tag.startswith('xfer') and not tag.startswith('xfer:theatre') else model)
        target.setdefault(f'{kind}:{name}', set()).add(frame)
    return earlier, model, xfer


def played_frames(frames, anim=None):
    """Select nonempty frames, clipping layer animation ranges to the sprite's frame count."""
    start, end = 0, len(frames)
    if anim is not None:
        start = min(anim.get('start', 0), anim.get('loopStart', 0))
        end = min(end, max(anim.get('end', -1) + 1, anim.get('loopEnd', 0), start + 1))
    return {k for k in range(max(0, start), end) if frames[k]['rect'][2]}


def coverage(library, patches, records=COVERAGE_RECORDS, prefix=COVERAGE_PREFIXES):
    """Report redraw coverage over each building type's unique, nonempty played frames."""
    data = read_json(Path(library) / 'library.json')
    earlier, model, xfer = coverage_records(library, patches, records)
    sprites = data['sprites']

    def frames(sprite):
        return sprites.get(sprite, {}).get('frames', [])

    def category(sprite, frame):
        if frame in model.get(sprite, ()):
            return 'l5_model'
        if frame in xfer.get(sprite, ()):
            return 'l5_xfer'
        if frame in earlier.get(sprite, ()):
            return 'earlier'
        return 'gap'

    def body_status(sprite, frame):
        if frame not in played_frames(frames(sprite)):
            return '-'
        kind = category(sprite, frame)
        return 'L5' if kind in ('l5_model', 'l5_xfer') else ('L4' if kind == 'earlier' else '-')

    rows = []
    for name, entry in sorted(data['types'].items()):
        if 'building' not in entry or not name.startswith(tuple(prefix)):
            continue
        building = entry['building']
        body = entry['sprite']
        # the renderer shows body frame 0 (intact) or 1 (damaged) only (ra2-assets art.ts buildingConditionFrame); later
        # body frames (rubble states of civil buildings) are never drawn, so they are not counted
        selected = {body: {k for k in played_frames(frames(body)) if k < 2}}
        for layer in building.get('layers', []):
            for sprite in (layer['sprite'], layer.get('damagedSprite')):
                if sprite:
                    selected.setdefault(sprite, set()).update(played_frames(frames(sprite), layer.get('anim', {})))
        buildup = building.get('buildup')
        buildup_frames = played_frames(frames(buildup)) if buildup else set()
        if buildup:
            selected.setdefault(buildup, set()).update(buildup_frames)
        counts = dict(played_frames=0, earlier=0, l5_model=0, l5_xfer=0)
        gaps = []
        for sprite, chosen in selected.items():
            missing = 0
            for frame in chosen:
                counts['played_frames'] += 1
                kind = category(sprite, frame)
                if kind == 'gap':
                    missing += 1
                else:
                    counts[kind] += 1
            if missing:
                gaps.append(f'{sprite.split(":", 1)[-1]}:{missing}')
        if not played_frames(frames(body)) and building.get('layers'):
            body = building['layers'][0]['sprite']
        covered = counts['earlier'] + counts['l5_model'] + counts['l5_xfer']
        buildup_covered = sum(category(buildup, k) != 'gap' for k in buildup_frames)
        rows.append(dict(name=name, **counts, coverage_percent=100 * covered / max(counts['played_frames'], 1),
                         body_intact=body_status(body, 0), body_damaged=body_status(body, 1),
                         buildup=f'{buildup_covered}/{len(buildup_frames)}' if buildup else '-', gaps=' '.join(gaps)))
    return rows


def coverage_tsv(rows):
    lines = ['\t'.join(COVERAGE_COLUMNS)]
    for row in rows:
        lines.append('\t'.join(f'{row[key]:.0f}%' if key == 'coverage_percent' else str(row[key])
                               for key in COVERAGE_COLUMNS))
    return '\n'.join(lines) + '\n'


def pack_plan(items, cap, max_types):
    """Greedily pack name/home/fam/area records without mutating them.

    Items are ordered by home, family, then descending area. First-fit packs
    accept their own family; after each item, other-family packs become open.
    Homes never mix. An item larger than cap (a big building's intact + damaged
    cells) gets a pack of its own and its factor F drops accordingly; non-positive
    areas are rejected with ValueError.
    """
    if not math.isfinite(cap) or cap <= 0:
        raise ValueError('cap must be positive and finite')
    if not isinstance(max_types, int) or isinstance(max_types, bool) or max_types <= 0:
        raise ValueError('max_types must be a positive integer')
    items = list(items)
    for item in items:
        if not math.isfinite(item['area']) or item['area'] <= 0:
            raise ValueError(f"area must be positive and finite: {item['name']}")
    packs = []
    for item in sorted(items, key=lambda it: (it['home'], it['fam'], -it['area'])):
        for pack in packs:
            if (pack['home'] == item['home'] and pack['area'] + item['area'] <= cap
                    and len(pack['names']) < max_types and (pack['fam'] == item['fam'] or pack['open'])):
                pack['names'].append(item['name'])
                pack['area'] += item['area']
                break
        else:
            packs.append(dict(names=[item['name']], home=item['home'], area=item['area'],
                              fam=item['fam'], open=False))
        for pack in packs:
            if pack['fam'] != item['fam']:
                pack['open'] = True
    return [dict(names=p['names'], home=p['home'], area=p['area'],
                 F=max(3, min(14, round(math.sqrt(2.6e6 / (1.35 * p['area'])))))) for p in packs]


def pack_make(packdir, prompt, jobs, *, max_width=2600, refs=()):
    """Pack equal-factor job canvases with 48-pixel grey gaps; retain absolute job destinations."""
    if not jobs or max_width < 1:
        raise ValueError('provide at least one job and a positive max-width')
    packdir = Path(packdir)
    cells, images, descriptions = [], [], []
    factors = set()
    x = y = row_height = width = 0
    row = column = 1
    for i, job in enumerate(jobs, 1):
        job = Path(job).resolve()
        lay = read_json(job / 'layout.json')
        f = lay.get('factor', lay.get('F'))
        if not isinstance(f, (int, float)) or not math.isfinite(f) or f <= 0:
            raise ValueError(f'missing or invalid factor: {job}')
        factors.add(f)
        im = Image.fromarray(read_image(job / 'input.png', 'RGB'))
        w, h = im.size
        if x and x + w > max_width:
            x = 0
            y += row_height + 48
            row_height = 0
            row += 1
            column = 1
        cells.append(dict(job=str(job), box=[x, y, w, h]))
        text = (job / 'cell.txt').read_text(encoding='utf-8').strip() if (job / 'cell.txt').exists() else ''
        descriptions.append(f'cell {i} (row {row}, column {column}): {text}')
        images.append(im)
        width = max(width, x + w)
        row_height = max(row_height, h)
        x += w + 48
        column += 1
    if len(factors) != 1:
        raise ValueError('all pack jobs must share one factor')
    if len({c['job'] for c in cells}) != len(cells) or str(packdir.resolve()) in {c['job'] for c in cells}:
        raise ValueError('pack and sub-job directories must be distinct')
    references = []
    reserved = {'input.png', 'layout.json', 'prompt.txt', 'raw.png', 'output.png'}
    for ref in refs:
        name, sep, path = ref.partition('=')
        if not sep or not name or Path(name).name != name or name in reserved:
            raise ValueError('reference must be NAME=PATH with a unique, non-reserved filename')
        references.append((name, Path(path)))
        reserved.add(name)
    sheet = Image.new('RGB', (width, y + row_height), (118, 118, 118))
    for cell, im in zip(cells, images):
        sheet.paste(im, tuple(cell['box'][:2]))
    rendered = Path(prompt).read_text(encoding='utf-8').replace('{n}', str(len(cells))).replace('{cells}', '\n'.join(descriptions))
    packdir.mkdir(parents=True, exist_ok=True)
    sheet.save(packdir / 'input.png')
    write_json(packdir / 'layout.json', dict(cells=cells))
    (packdir / 'prompt.txt').write_text(rendered, encoding='utf-8')
    for name, path in references:
        shutil.copyfile(path, packdir / name)
    return cells


def pack_split(packdir):
    packdir = Path(packdir).resolve()
    layout = read_json(packdir / 'layout.json')
    with Image.open(packdir / 'input.png') as im:
        size = im.size
    raw = packdir / ('raw.png' if (packdir / 'raw.png').exists() else 'output.png')
    with Image.open(raw) as im:
        output = im.convert('RGB').resize(size, Image.Resampling.BILINEAR)
    targets = []
    for cell in layout['cells']:
        job = Path(cell['job'])
        x, y, w, h = cell['box']
        with Image.open(job / 'input.png') as im:
            if im.size != (w, h):
                raise ValueError(f'sub-job input size changed: {job}')
        if min(x, y) < 0 or min(w, h) <= 0 or x + w > size[0] or y + h > size[1]:
            raise ValueError('pack cell lies outside the input canvas')
        targets.append((job, (x, y, x + w, y + h)))
    for job, box in targets:
        output.crop(box).save(job / 'output.png')
        (job / 'packed_from.txt').write_text(str(packdir) + '\n', encoding='utf-8')
    return len(targets)


def frame_range(text):
    start, end = map(int, text.split('-'))
    if start < 0 or end < start:
        raise argparse.ArgumentTypeError('frames must be an inclusive nonnegative a-b range')
    return list(range(start, end + 1))


def json_option(text):
    """Accept inline JSON or a UTF-8 JSON file."""
    return json.loads(text) if text.lstrip().startswith(('{', '[')) else read_json(text)


def parser():
    ap = argparse.ArgumentParser(description=__doc__)
    commands = ap.add_subparsers(dest='command', required=True)

    def library_options(p):
        p.add_argument('--root', type=Path, help='HD cache directory (default: HD_CACHE_DIR)')
        p.add_argument('--theater', default='urban')

    p = commands.add_parser('body', help='prepare intact or damaged body jobs')
    library_options(p)
    p.add_argument('--kind', choices=('intact', 'damaged'), required=True)
    p.add_argument('--specs', type=Path, required=True)
    p.add_argument('--work', type=Path, required=True)
    p.add_argument('--style-dir', type=Path)
    p.add_argument('--sibling', type=Path)
    p.add_argument('--design-palette', help='library palette for the 1x design composite and colour lock')
    p.add_argument('--storage', default=','.join(sorted(STORAGE)))
    p.add_argument('names', nargs='+')
    p = commands.add_parser('post', help='register and finish a body job')
    library_options(p)
    p.add_argument('jobdir', type=Path)
    p.add_argument('--finish', type=json_option)
    p = commands.add_parser('patches', help='split finished bodies into frame patches')
    library_options(p)
    p.add_argument('--work', type=Path, required=True)
    p.add_argument('--patches', type=Path, required=True)
    p.add_argument('jobs', nargs='+')
    for command in ('anim', 'buildup'):
        p = commands.add_parser(command)
        sub = p.add_subparsers(dest='action', required=True)
        for action in (('make', 'make_multi', 'post') if command == 'anim' else ('make', 'post')):
            q = sub.add_parser(action)
            library_options(q)
            q.add_argument('--work', type=Path, required=True)
            q.add_argument('--patches', type=Path, required=action == 'post')
            if action == 'post':
                q.add_argument('jobs', nargs='+')
                continue
            q.add_argument('--specs', type=Path, help='optional display names for older body layouts')
            q.add_argument('name' if command == 'buildup' else 'job')
            q.add_argument('body')
            if command == 'anim':
                q.add_argument('sprite')
            q.add_argument('frames', type=(lambda text: text.split(',')) if action == 'make_multi' else frame_range)
            q.add_argument('cols', type=int)
            q.add_argument('factor', type=int)
            if command == 'anim':
                q.add_argument('moving')
                q.add_argument('extra', nargs='?', default='')
            else:
                q.add_argument('suffix', nargs='?', default='')
    p = commands.add_parser('compose', help='patch a variant library under an exclusive lock')
    p.add_argument('--library', type=Path, required=True)
    p.add_argument('--patches', type=Path, required=True)
    p.add_argument('--only', nargs='+')
    p.add_argument('--record', default='l4_frames_bldg.json')
    p = commands.add_parser('coverage', help='report redraw coverage over played building frames as TSV')
    p.add_argument('--library', type=Path, required=True)
    p.add_argument('--patches', type=Path, required=True)
    p.add_argument('--records', default=','.join(COVERAGE_RECORDS), help='comma-separated record filenames')
    p.add_argument('--prefix', default=','.join(COVERAGE_PREFIXES), help='comma-separated building name prefixes')
    p.add_argument('--out', type=Path, help='also write the TSV report to a file')
    for command in ('xfer', 'walls-xfer'):
        p = commands.add_parser(command, help='transfer accepted redraws to animation or damaged wall frames')
        p.add_argument('--library-root', type=Path, required=True, help='variant root containing _library/<theater>')
        p.add_argument('--theater', default='urban')
        p.add_argument('--patches', type=Path, required=True)
        p.add_argument('names', nargs='+')
        if command == 'xfer':
            p.add_argument('--parts', type=json_option, help='JSON mapping NAME or NAME:state to ordered sprite:frame parts')
            p.add_argument('--delta', action='store_true', help='colour-shift the redraw on colour-cycling pixels')
    for command in ('normals-job', 'normals-assist'):
        p = commands.add_parser(command)
        p.add_argument('--work', type=Path, required=True)
        p.add_argument('jobs', nargs='+')
        if command == 'normals-assist':
            library_options(p)
            p.add_argument('--out', type=Path, required=True)
            p.add_argument('--extra', type=json_option, help='JSON mapping source sprite to sibling sprites')
    p = commands.add_parser('dmg-xfer', help='detail damaged loop frames from model-drawn intact loop frames')
    p.add_argument('--library-root', type=Path, required=True, help='variant root containing _library/<theater>')
    p.add_argument('--theater', default='urban')
    p.add_argument('--patches', type=Path, required=True)
    p.add_argument('pairs', nargs='+', help='INTACT_SPRITE,DAMAGED_SPRITE (e.g. anim:GAAIRC_A,anim:GAAIRC_AD)')
    p = commands.add_parser('fix-hue', help='restore fixed paint hue drift in generated sheets (raw.png)')
    p.add_argument('--hue', type=float, default=38.0, help='Lab hue of the design paint in degrees (red ~38)')
    p.add_argument('jobdirs', type=Path, nargs='+')
    p = commands.add_parser('index-paint', help='encode house paint in patches from 1x indices 16..31')
    p.add_argument('--library-root', type=Path, required=True, help='variant root containing _library/<theater>')
    p.add_argument('--theater', default='urban')
    p.add_argument('--patches', type=Path, required=True)
    p.add_argument('sprites', nargs='+')
    p = commands.add_parser('pack-plan', help='print a JSON pack plan for name/home/fam/area items')
    p.add_argument('--items', type=json_option, required=True, help='JSON array or path to a JSON file')
    p.add_argument('--cap', type=int, required=True, help='maximum total 1x area per pack')
    p.add_argument('--max-types', type=int, required=True)
    p = commands.add_parser('pack')
    sub = p.add_subparsers(dest='action', required=True)
    q = sub.add_parser('make')
    q.add_argument('packdir', type=Path)
    q.add_argument('--prompt', type=Path, required=True)
    q.add_argument('--max-width', type=int, default=2600)
    q.add_argument('--ref', action='append', default=[])
    q.add_argument('jobs', type=Path, nargs='+')
    q = sub.add_parser('split')
    q.add_argument('packdir', type=Path)
    return ap


def main(argv=None):
    ap = parser()
    args = ap.parse_args(argv)
    try:
        if args.command == 'body':
            lib = Lib(args.theater, args.root)
            specs = read_json(args.specs)
            for name in args.names:
                body_make(args.kind, name, lib, specs, args.work, style_dir=args.style_dir,
                          sibling=args.sibling, storage=set(filter(None, args.storage.split(','))),
                          design_palette=args.design_palette)
        elif args.command == 'post':
            post(args.jobdir, args.finish, root=args.root, theater=args.theater)
        elif args.command == 'patches':
            body_patches(args.work, args.patches, args.jobs, root=args.root, theater=args.theater)
        elif args.command in ('anim', 'buildup'):
            buildup = args.command == 'buildup'
            if args.action == 'post':
                for job in args.jobs:
                    anim_post(job, work=args.work, patches=args.patches, root=args.root,
                              theater=args.theater, buildup=buildup)
            else:
                anim_make(f'{args.name}_MK{args.suffix}' if buildup else args.job, args.body,
                          f'anim:{args.name}MK' if buildup else args.sprite, args.frames, args.cols,
                          args.factor, 'x' if buildup else args.moving, '' if buildup else args.extra,
                          work=args.work, root=args.root, theater=args.theater,
                          specs=read_json(args.specs) if args.specs else None, buildup=buildup)
        elif args.command == 'compose':
            compose(args.library, args.patches, args.only, args.record)
        elif args.command == 'coverage':
            rows = coverage(args.library, args.patches, tuple(filter(None, args.records.split(','))),
                            tuple(filter(None, args.prefix.split(','))))
            report = coverage_tsv(rows)
            if args.out:
                args.out.write_text(report, encoding='utf-8')
            print(report, end='')
        elif args.command in ('xfer', 'walls-xfer'):
            lib = Lib(args.theater, args.library_root)
            for selector in args.names:
                if args.command == 'walls-xfer':
                    print(selector, 'damaged pieces', walls_xfer(lib, selector, patches=args.patches))
                    continue
                name, _, state = selector.partition(':')
                overrides = args.parts or {}
                for state in ([state] if state else ['i', 'd', 'mk']):
                    parts = overrides.get(f'{name}:{state}', overrides.get(name))
                    print(name, state, xfer(lib, name, state, patches=args.patches, parts=parts, delta=args.delta))
        elif args.command == 'dmg-xfer':
            lib = Lib(args.theater, args.library_root)
            for pair in args.pairs:
                intact, damaged = pair.split(',')
                print(intact, '->', damaged, damaged_from_sheet(lib, intact, damaged, patches=args.patches))
        elif args.command == 'fix-hue':
            for jobdir in args.jobdirs:
                print(jobdir.name, 'recoloured', fix_sheet_hue(jobdir, args.hue))
        elif args.command == 'index-paint':
            lib = Lib(args.theater, args.library_root)
            for sprite in args.sprites:
                print(sprite, 'paint texels', index_paint(lib, sprite, patches=args.patches))
        elif args.command == 'normals-job':
            normals_job(args.work, args.jobs)
        elif args.command == 'normals-assist':
            normals_assist(args.work, args.out, args.jobs, root=args.root, theater=args.theater, extra=args.extra)
        elif args.command == 'pack-plan':
            print(json.dumps(pack_plan(args.items, args.cap, args.max_types)))
        elif args.action == 'make':
            pack_make(args.packdir, args.prompt, args.jobs, max_width=args.max_width, refs=args.ref)
        else:
            pack_split(args.packdir)
    except (ValueError, KeyError, OSError) as error:
        ap.error(str(error))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
