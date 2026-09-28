/**
 * Type library contact sheet (Node only, verification tool): reads a written library back through its contract
 * (library.json, atlas pages, palettes, shared voxels) and draws every type on one PNG so wrong palettes, wrong theater
 * art, missing house colours and misaligned bibs/anims/turrets are visible at a glance.
 *
 * Per type: buildings as two views (healthy: bib frame 0, body frame 0, first frame of every ActiveAnim/IdleAnim layer
 * and the voxel turret; damaged: bib frame 1, body frame 1, damaged layers) over a magenta outline of the foundation;
 * infantry as the Ready frame for 8 facings; voxel units and aircraft as 8 facings (crude splat, voxelSplat.ts); SHP
 * units as 8 facings. House colour: the scheme named by `scheme` (default DarkRed). Each tile is labelled with its type
 * id in a 3x5 pixel font ('*' marks InvisibleInGame types) and indexed in the sidecar JSON with its rectangle.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SpriteEntry, SpriteFrame, VoxelModel } from '../manifest.ts';
import type { LibraryType, TypeLibrary } from '../library.ts';
import { animStillFrame, facingFrame, sequenceFrame } from '../art.ts';
import { applyRemap } from '../remap.ts';
import { decodePng, encodePng, type PngImage } from './png.ts';
import { voxelSplat, type SplatPoint } from './voxelSplat.ts';

export interface LibraryPreviewOptions {
  libraryDir: string;
  /** Output PNG (default <libraryDir>/library-preview.png; the index goes next to it as .json). */
  out?: string;
  /** rules [Colors] name used as the owner colour (default "DarkRed"). */
  scheme?: string;
}

export interface LibraryPreviewResult {
  file: string;
  index: string;
  width: number;
  height: number;
}

const SHEET_WIDTH = 4000;
const GAP = 14;
const BG: [number, number, number] = [96, 104, 92];

/** 3x5 glyphs, rows top to bottom, 3 bits each (MSB = left). */
const FONT: Record<string, number[]> = {
  A: [2, 5, 7, 5, 5],
  B: [6, 5, 6, 5, 6],
  C: [3, 4, 4, 4, 3],
  D: [6, 5, 5, 5, 6],
  E: [7, 4, 6, 4, 7],
  F: [7, 4, 6, 4, 4],
  G: [3, 4, 5, 5, 3],
  H: [5, 5, 7, 5, 5],
  I: [7, 2, 2, 2, 7],
  J: [1, 1, 1, 5, 2],
  K: [5, 5, 6, 5, 5],
  L: [4, 4, 4, 4, 7],
  M: [5, 7, 7, 5, 5],
  N: [6, 5, 5, 5, 5],
  O: [2, 5, 5, 5, 2],
  P: [6, 5, 6, 4, 4],
  Q: [2, 5, 5, 6, 3],
  R: [6, 5, 6, 5, 5],
  S: [3, 4, 2, 1, 6],
  T: [7, 2, 2, 2, 2],
  U: [5, 5, 5, 5, 7],
  V: [5, 5, 5, 5, 2],
  W: [5, 5, 7, 7, 5],
  X: [5, 5, 2, 5, 5],
  Y: [5, 5, 2, 2, 2],
  Z: [7, 1, 2, 4, 7],
  '0': [7, 5, 5, 5, 7],
  '1': [2, 6, 2, 2, 7],
  '2': [6, 1, 2, 4, 7],
  '3': [6, 1, 2, 1, 6],
  '4': [5, 5, 7, 1, 1],
  '5': [7, 4, 6, 1, 6],
  '6': [3, 4, 7, 5, 7],
  '7': [7, 1, 2, 2, 2],
  '8': [7, 5, 7, 5, 7],
  '9': [7, 5, 7, 1, 6],
  _: [0, 0, 0, 0, 7],
  '-': [0, 0, 7, 0, 0],
  ':': [0, 2, 0, 2, 0],
  '.': [0, 0, 0, 0, 2],
  '/': [1, 1, 2, 4, 4],
  '(': [2, 4, 4, 4, 2],
  ')': [2, 1, 1, 1, 2],
  '*': [0, 5, 2, 5, 0],
  ' ': [0, 0, 0, 0, 0],
};
const FONT_SCALE = 2;
const textWidth = (s: string): number => s.length * 4 * FONT_SCALE;
const TEXT_H = 5 * FONT_SCALE;

class Sheet {
  readonly rgba: Uint8Array;
  constructor(
    readonly width: number,
    readonly height: number,
  ) {
    this.rgba = new Uint8Array(width * height * 4);
    for (let i = 0; i < width * height; i++) this.rgba.set([...BG, 255], i * 4);
  }
  at(x: number, y: number): number {
    const px = Math.round(x);
    const py = Math.round(y);
    return px < 0 || py < 0 || px >= this.width || py >= this.height ? -1 : (py * this.width + px) * 4;
  }
  put(x: number, y: number, r: number, g: number, b: number): void {
    const i = this.at(x, y);
    if (i >= 0) this.rgba.set([r, g, b], i);
  }
  darken(x: number, y: number, f: number): void {
    const i = this.at(x, y);
    if (i < 0) return;
    for (let k = 0; k < 3; k++) this.rgba[i + k] = this.rgba[i + k]! * f;
  }
  text(s: string, x: number, y: number, c: [number, number, number] = [255, 255, 255]): void {
    let cx = x;
    for (const ch of s.toUpperCase()) {
      const g = FONT[ch] ?? FONT['*']!;
      for (let row = 0; row < 5; row++) {
        for (let col = 0; col < 3; col++) {
          if (!((g[row]! >> (2 - col)) & 1)) continue;
          for (let dy = 0; dy < FONT_SCALE; dy++)
            for (let dx = 0; dx < FONT_SCALE; dx++)
              this.put(cx + col * FONT_SCALE + dx, y + row * FONT_SCALE + dy, ...c);
        }
      }
      cx += 4 * FONT_SCALE;
    }
  }
  line(ax: number, ay: number, bx: number, by: number, c: [number, number, number]): void {
    const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay)));
    for (let s = 0; s <= steps; s++) this.put(ax + ((bx - ax) * s) / steps, ay + ((by - ay) * s) / steps, ...c);
  }
}

/** Something to draw: its bounds relative to its own origin, and a painter at a given origin. */
interface Item {
  id: string;
  kind: string;
  label: string;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  draw(sheet: Sheet, ox: number, oy: number): void;
}

export function renderLibraryPreview(opts: LibraryPreviewOptions): LibraryPreviewResult {
  const dir = opts.libraryDir;
  const lib = JSON.parse(readFileSync(join(dir, 'library.json'), 'utf8')) as TypeLibrary;
  const pages = lib.spriteAtlases.map((a) => decodePng(readFileSync(join(dir, a.file))));
  const basePalettes = new Map<string, Uint8Array>();
  for (const [key, file] of Object.entries(lib.palettes))
    basePalettes.set(key, decodePng(readFileSync(join(dir, file))).data);
  const schemeIndex = lib.colorSchemesByName[opts.scheme ?? 'DarkRed'] ?? 1;
  const scheme = lib.colorSchemes[schemeIndex];
  const palCache = new Map<string, Uint8Array>();
  const paletteOf = (key: string, remap: boolean): Uint8Array => {
    const k = `${key}|${remap}`;
    let p = palCache.get(k);
    if (!p) {
      const base = basePalettes.get(key) ?? basePalettes.get('unit')!;
      p = remap && scheme ? applyRemap(base, scheme.remap) : base;
      palCache.set(k, p);
    }
    return p;
  };

  // Frame blitting relative to a draw point (SHP canvas centre).
  const frameBounds = (f: SpriteFrame | undefined, dx = 0, dy = 0): [number, number, number, number] | undefined =>
    f && f.rect[2] > 0
      ? [f.offset[0] + dx, f.offset[1] + dy, f.offset[0] + dx + f.rect[2], f.offset[1] + dy + f.rect[3]]
      : undefined;
  const blit = (
    sheet: Sheet,
    f: SpriteFrame | undefined,
    px: number,
    py: number,
    pal: Uint8Array,
    shadow = false,
  ): void => {
    if (!f || f.rect[2] <= 0) return;
    const page = pages[f.page ?? 0]!;
    const [rx, ry, rw, rh] = f.rect;
    for (let y = 0; y < rh; y++) {
      for (let x = 0; x < rw; x++) {
        const v = page.data[(ry + y) * page.width + rx + x]!;
        if (!v) continue;
        if (shadow) sheet.darken(px + f.offset[0] + x, py + f.offset[1] + y, 0.55);
        else sheet.put(px + f.offset[0] + x, py + f.offset[1] + y, pal[v * 3]!, pal[v * 3 + 1]!, pal[v * 3 + 2]!);
      }
    }
  };
  const sprite = (id: string | undefined): SpriteEntry | undefined => (id ? lib.sprites[id] : undefined);
  const voxelCache = new Map<string, VoxelModel | null>();
  const voxel = (id: string | undefined): VoxelModel | undefined => {
    if (!id) return undefined;
    if (!voxelCache.has(id)) {
      const file = lib.voxels[id];
      voxelCache.set(id, file ? (JSON.parse(readFileSync(join(dir, file), 'utf8')) as VoxelModel) : null);
    }
    return voxelCache.get(id) ?? undefined;
  };
  const splatBounds = (pts: SplatPoint[], dx: number, dy: number, b: number[]): void => {
    for (const q of pts) {
      b[0] = Math.min(b[0]!, q.x + dx);
      b[1] = Math.min(b[1]!, q.y + dy);
      b[2] = Math.max(b[2]!, q.x + dx + 2);
      b[3] = Math.max(b[3]!, q.y + dy + 1);
    }
  };
  const splat = (sheet: Sheet, pts: SplatPoint[], x: number, y: number, pal: Uint8Array): void => {
    for (const q of pts) {
      const r = pal[q.index * 3]! * q.lum;
      const g = pal[q.index * 3 + 1]! * q.lum;
      const b = pal[q.index * 3 + 2]! * q.lum;
      sheet.put(x + q.x, y + q.y, r, g, b);
      sheet.put(x + q.x + 1, y + q.y, r, g, b);
    }
  };
  const grow = (b: number[], r: [number, number, number, number] | undefined): void => {
    if (!r) return;
    b[0] = Math.min(b[0]!, r[0]);
    b[1] = Math.min(b[1]!, r[1]);
    b[2] = Math.max(b[2]!, r[2]);
    b[3] = Math.max(b[3]!, r[3]);
  };

  const items: Item[] = [];
  const label = (id: string, t: LibraryType): string => `${t.invisible ? '*' : ''}${id}`;

  // ------------------------------------------------------------ buildings
  const buildingView = (t: LibraryType, damaged: boolean) => {
    const body = sprite(t.sprite)!;
    const b = t.building!;
    const bib = sprite(b.bib);
    const pick = (e: SpriteEntry | undefined, i: number): number => (e ? Math.min(i, e.frames.length - 1) : 0);
    const bodyFrame = damaged && body.frames.length > 1 ? 1 : 0;
    // Body frames can be empty (the nuclear silo NAMISL is drawn entirely by its SuperAnim layers): then show the
    // SuperAnim idle state too.
    const bodyEmpty = !body.frames[bodyFrame] || body.frames[bodyFrame]!.rect[2] === 0;
    const shown = b.layers.filter(
      (l) =>
        (/^(ActiveAnim|IdleAnim)/.test(l.key) && l.key !== 'ActiveAnimGarrisoned') ||
        (bodyEmpty && l.key === 'SuperAnim'),
    );
    const layerDraws = shown.map((l) => {
      const id = damaged && l.damagedSprite ? l.damagedSprite : l.sprite;
      const e = sprite(id)!;
      // A representative frame (middle of the loop): frame 0 of some anims is a dark start-up image (CAMOV01_A).
      return { e, frame: animStillFrame(l.anim, e.frames.length), off: l.offset ?? [0, 0] };
    });
    const turret = b.turretVoxel && !damaged ? voxel(b.turretVoxel.voxel) : undefined;
    const turretPts = turret ? voxelSplat(turret, 96) : [];
    const [fw, fh] = t.foundation ?? [1, 1];
    const bounds = [Infinity, Infinity, -Infinity, -Infinity];
    grow(bounds, frameBounds(body.frames[bodyFrame]));
    grow(bounds, frameBounds(body.shadows?.[bodyFrame]));
    if (bib) grow(bounds, frameBounds(bib.frames[pick(bib, damaged ? 1 : 0)]));
    for (const l of layerDraws) grow(bounds, frameBounds(l.e.frames[l.frame], l.off[0], l.off[1]));
    grow(bounds, [-fh * 30, 0, fw * 30, (fw + fh) * 15]);
    if (turret) splatBounds(turretPts, b.turretVoxel!.offset[0], b.turretVoxel!.offset[1], bounds);
    const draw = (sheet: Sheet, x: number, y: number): void => {
      // Foundation outline on the ground: top corner at the draw point.
      const c = [
        [0, 0],
        [fw * 30, fw * 15],
        [(fw - fh) * 30, (fw + fh) * 15],
        [-fh * 30, fh * 15],
      ];
      for (let k = 0; k < 4; k++)
        sheet.line(x + c[k]![0]!, y + c[k]![1]!, x + c[(k + 1) % 4]![0]!, y + c[(k + 1) % 4]![1]!, [200, 0, 200]);
      const pal = paletteOf(body.palette, body.remap);
      if (bib) blit(sheet, bib.frames[pick(bib, damaged ? 1 : 0)], x, y, paletteOf(bib.palette, bib.remap && t.remap));
      blit(sheet, body.shadows?.[bodyFrame], x, y, pal, true);
      for (const l of layerDraws) blit(sheet, l.e.shadows?.[l.frame], x + l.off[0], y + l.off[1], pal, true);
      blit(sheet, body.frames[bodyFrame], x, y, pal);
      for (const l of layerDraws)
        blit(sheet, l.e.frames[l.frame], x + l.off[0], y + l.off[1], paletteOf(l.e.palette, l.e.remap && t.remap));
      if (turret)
        splat(sheet, turretPts, x + b.turretVoxel!.offset[0], y + b.turretVoxel!.offset[1], paletteOf('unit', t.remap));
    };
    return { bounds, draw };
  };
  // ------------------------------------------------------------ 8-facing strips
  const strip = (
    cells: { bounds: number[]; draw: (s: Sheet, x: number, y: number) => void }[],
    spacing: number,
  ): { bounds: number[]; draw: (s: Sheet, x: number, y: number) => void } => {
    const bounds = [Infinity, Infinity, -Infinity, -Infinity];
    cells.forEach((c, i) =>
      grow(bounds, [c.bounds[0]! + i * spacing, c.bounds[1]!, c.bounds[2]! + i * spacing, c.bounds[3]!]),
    );
    return { bounds, draw: (s, x, y) => cells.forEach((c, i) => c.draw(s, x + i * spacing, y)) };
  };
  const shpCell = (e: SpriteEntry, frame: number, remap: boolean) => {
    const f = Math.max(0, Math.min(frame, e.frames.length - 1));
    const bounds = [Infinity, Infinity, -Infinity, -Infinity];
    grow(bounds, frameBounds(e.frames[f]));
    grow(bounds, frameBounds(e.shadows?.[f]));
    if (!Number.isFinite(bounds[0])) grow(bounds, [-2, -2, 2, 2]);
    return {
      bounds,
      draw: (s: Sheet, x: number, y: number) => {
        const pal = paletteOf(e.palette, e.remap && remap);
        blit(s, e.shadows?.[f], x, y, pal, true);
        blit(s, e.frames[f], x, y, pal);
        s.put(x, y, 255, 255, 0);
      },
    };
  };
  const voxelCell = (m: VoxelModel, facing: number, remap: boolean) => {
    const pts = voxelSplat(m, facing);
    const bounds = [Infinity, Infinity, -Infinity, -Infinity];
    splatBounds(pts, 0, 0, bounds);
    if (!Number.isFinite(bounds[0])) grow(bounds, [-2, -2, 2, 2]);
    return { bounds, draw: (s: Sheet, x: number, y: number) => splat(s, pts, x, y, paletteOf(m.palette, remap)) };
  };
  const FACINGS = [0, 32, 64, 96, 128, 160, 192, 224];

  const order: LibraryType['kind'][] = ['building', 'infantry', 'vehicle', 'aircraft'];
  const ids = Object.keys(lib.types).sort((a, b) => {
    const ka = order.indexOf(lib.types[a]!.kind);
    const kb = order.indexOf(lib.types[b]!.kind);
    return ka - kb || (a < b ? -1 : a > b ? 1 : 0);
  });
  for (const id of ids) {
    const t = lib.types[id]!;
    let v: { bounds: number[]; draw: (s: Sheet, x: number, y: number) => void } | undefined;
    if (t.kind === 'building' && t.sprite) {
      // Healthy view, then the damaged view to its right.
      const healthy = buildingView(t, false);
      const damaged = buildingView(t, true);
      const w = healthy.bounds[2]! + GAP - damaged.bounds[0]!;
      v = {
        bounds: [
          healthy.bounds[0]!,
          Math.min(healthy.bounds[1]!, damaged.bounds[1]!),
          w + damaged.bounds[2]!,
          Math.max(healthy.bounds[3]!, damaged.bounds[3]!),
        ],
        draw: (s, x, y) => {
          healthy.draw(s, x, y);
          damaged.draw(s, x + w, y);
        },
      };
    } else if (t.kind === 'infantry' && t.sprite) {
      const e = sprite(t.sprite)!;
      const ready = t.infantry?.sequences['Ready'] ?? { start: 0, count: 1, facingMultiplier: 1 };
      v = strip(
        FACINGS.map((f) => shpCell(e, sequenceFrame(ready, f, 0), t.remap)),
        34,
      );
    } else if (t.voxel) {
      const m = voxel(t.voxel);
      if (m)
        v = strip(
          FACINGS.map((f) => voxelCell(m, f, t.remap)),
          64,
        );
    } else if (t.sprite && t.shpUnit) {
      const e = sprite(t.sprite)!;
      const u = t.shpUnit;
      const per = u.frames['WalkFrames'] ?? 1;
      const start = u.frames['StartWalkFrame'] ?? 0;
      v = strip(
        FACINGS.map((f) => shpCell(e, start + facingFrame(f, u.facings) * per, t.remap)),
        48,
      );
    }
    if (!v || !Number.isFinite(v.bounds[0])) continue;
    const text = label(id, t);
    items.push({
      id,
      kind: t.kind,
      label: text,
      minX: v.bounds[0]!,
      minY: v.bounds[1]!,
      maxX: Math.max(v.bounds[2]!, v.bounds[0]! + textWidth(text)),
      maxY: v.bounds[3]! + TEXT_H + 4,
      draw: v.draw,
    });
  }

  // Row layout: kinds start on a new row with a header.
  const placed: { item: Item; x: number; y: number }[] = [];
  const headers: { text: string; y: number }[] = [];
  let x = GAP;
  let y = GAP;
  let rowH = 0;
  let kind = '';
  for (const it of items) {
    const w = Math.ceil(it.maxX - it.minX);
    const h = Math.ceil(it.maxY - it.minY);
    if (it.kind !== kind) {
      if (kind) y += rowH + GAP * 2;
      kind = it.kind;
      headers.push({ text: `${kind}s`, y });
      y += TEXT_H * 2 + GAP;
      x = GAP;
      rowH = 0;
    }
    if (x + w + GAP > SHEET_WIDTH && x > GAP) {
      x = GAP;
      y += rowH + GAP;
      rowH = 0;
    }
    placed.push({ item: it, x, y });
    x += w + GAP;
    rowH = Math.max(rowH, h);
  }
  const height = Math.ceil(y + rowH + GAP);
  const sheet = new Sheet(SHEET_WIDTH, height);
  const title = `${lib.theater} type library - ${Object.keys(lib.types).length} types - owner colour ${scheme?.name ?? '?'} (#${schemeIndex})`;
  sheet.text(title, SHEET_WIDTH - textWidth(title) - GAP, GAP, [255, 255, 160]);
  for (const h of headers) {
    sheet.text(h.text, GAP, h.y, [255, 255, 160]);
    sheet.text(h.text, GAP + 1, h.y, [255, 255, 160]);
  }
  const index: { id: string; kind: string; rect: [number, number, number, number] }[] = [];
  for (const { item, x: px, y: py } of placed) {
    const ox = px - item.minX;
    const oy = py - item.minY;
    item.draw(sheet, ox, oy);
    sheet.text(item.label, px, py + (item.maxY - item.minY) - TEXT_H);
    index.push({
      id: item.id,
      kind: item.kind,
      rect: [px, py, Math.ceil(item.maxX - item.minX), Math.ceil(item.maxY - item.minY)],
    });
  }
  const file = opts.out ?? join(dir, 'library-preview.png');
  // Opaque sheet: write RGB (a quarter smaller than RGBA).
  const rgb = new Uint8Array(sheet.width * sheet.height * 3);
  for (let i = 0, j = 0; i < sheet.rgba.length; i += 4, j += 3) rgb.set(sheet.rgba.subarray(i, i + 3), j);
  const img: PngImage = { width: sheet.width, height: sheet.height, channels: 3, data: rgb };
  writeFileSync(file, encodePng(img));
  const indexFile = file.replace(/\.png$/i, '') + '.json';
  writeFileSync(indexFile, JSON.stringify({ theater: lib.theater, scheme: scheme?.name, items: index }, null, 1));
  return { file, index: indexFile, width: sheet.width, height: sheet.height };
}
