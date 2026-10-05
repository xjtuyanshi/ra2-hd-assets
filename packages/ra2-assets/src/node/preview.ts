/**
 * Reference compositor (Node only): draws an extracted HD cache the way the original engine does, as the
 * verification tool for the extractor and the ground truth the HD renderer is compared against.
 *
 * Passes (see manifest.ts): tile diamonds by depth, tile extra graphics by depth, flat objects (smudges, ore, low
 * bridges), shadows (50 % darken), then Y-sorted objects (trees, rocks, walls, buildings with bib/anim layers,
 * units, infantry, aircraft) with house-remapped palettes; voxels are splatted with a crude iso projection.
 * By default the image is cropped to the manifest's `visibleRect` (the engine's camera limits), so border strips the
 * player never sees are not shown; `full` draws the whole [Map] Size area.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { lookupNormal, normalTableFor } from 'ra2-formats';
import type { HdCacheManifest, LightingClass, MapObject, SpriteEntry, SpriteFrame, VoxelModel } from '../manifest.ts';
import { CELL_H, mapLightMultipliers, projectCorner } from '../iso.ts';
import { applyRemap } from '../remap.ts';
import { sectionNormalsMode } from '../voxelNormals.ts';
import { decodePng, encodePng, type PngImage } from './png.ts';
import { drawTerrainTiles, loadTerrainDepth, terrainLayout } from './terrain.ts';

export { insideDiamond } from './terrain.ts';

export interface PreviewOptions {
  cacheDir: string;
  /** Output file (default <cacheDir>/preview.png). */
  out?: string;
  /** Also draw every extracted voxel model in a strip above the map (checks the voxel data itself). */
  modelStrip?: boolean;
  /** Draw a 1-px outline of each building foundation (placement debugging). */
  foundations?: boolean;
  /** Apply the map's [Lighting] tint (default true); false draws raw palette colours. */
  lighting?: boolean;
  /** Draw the whole [Map] Size area instead of cropping to the playable `visibleRect` (default false). */
  full?: boolean;
}

export interface PreviewResult {
  file: string;
  width: number;
  height: number;
  /** Canvas pixel of screen origin (projected corner (0, 0, 0)), for locating cells in the image. */
  origin: [number, number];
  drawn: Record<string, number>;
}

const fromB64 = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, 'base64'));

class Canvas {
  readonly rgba: Uint8Array;
  constructor(
    readonly width: number,
    readonly height: number,
    readonly ox: number,
    readonly oy: number,
  ) {
    this.rgba = new Uint8Array(width * height * 4);
    for (let i = 3; i < this.rgba.length; i += 4) this.rgba[i] = 255;
  }
  /** Index of world pixel (x, y) or -1 outside. */
  at(x: number, y: number): number {
    const px = Math.round(x) + this.ox;
    const py = Math.round(y) + this.oy;
    if (px < 0 || py < 0 || px >= this.width || py >= this.height) return -1;
    return (py * this.width + px) * 4;
  }
  put(x: number, y: number, r: number, g: number, b: number): void {
    const i = this.at(x, y);
    if (i < 0) return;
    this.rgba[i] = r;
    this.rgba[i + 1] = g;
    this.rgba[i + 2] = b;
  }
  darken(x: number, y: number, f: number): void {
    const i = this.at(x, y);
    if (i < 0) return;
    this.rgba[i] = this.rgba[i]! * f;
    this.rgba[i + 1] = this.rgba[i + 1]! * f;
    this.rgba[i + 2] = this.rgba[i + 2]! * f;
  }
}

export function renderPreview(opts: PreviewOptions): PreviewResult {
  const dir = opts.cacheDir;
  const m = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as HdCacheManifest;
  const terrain = decodePng(readFileSync(join(dir, m.terrainAtlas.file)));
  const spriteAtlas = decodePng(readFileSync(join(dir, m.spriteAtlas.file)));
  const palettes = new Map<string, Uint8Array>();
  for (const [key, file] of Object.entries(m.palettes))
    palettes.set(key, decodePng(readFileSync(join(dir, file))).data);
  const drawn: Record<string, number> = {};
  const bump = (k: string): void => {
    drawn[k] = (drawn[k] ?? 0) + 1;
  };

  const layout = terrainLayout(m);
  const { minX, minY, maxX, maxY } = layout;
  // Room above the map for tall sprites and the optional voxel strip.
  const top = opts.modelStrip ? 220 : 120;
  const crop = !opts.full && m.visibleRect ? m.visibleRect : undefined;
  const canvas = crop
    ? new Canvas(
        Math.ceil(crop.width),
        Math.ceil(crop.height) + (opts.modelStrip ? top : 0),
        -Math.floor(crop.x),
        -Math.floor(crop.y) + (opts.modelStrip ? top : 0),
      )
    : new Canvas(
        Math.ceil(maxX - minX) + 64,
        Math.ceil(maxY - minY) + top + 32,
        -Math.floor(minX) + 32,
        -Math.floor(minY) + top,
      );
  // The optional voxel strip is drawn in the band above the map (above the visible rectangle when cropping).
  const stripY = -canvas.oy + 120;

  // Engine lighting: every palette drawn on a cell at level z is multiplied by mapLightMultipliers for its class.
  const lit = opts.lighting !== false && m.lighting ? m.lighting : undefined;
  const lightCache = new Map<string, [number, number, number]>();
  const lightAt = (z: number, cls: LightingClass = 'full'): [number, number, number] => {
    const key = `${cls}|${z}`;
    let l = lightCache.get(key);
    if (!l) {
      l = lit ? mapLightMultipliers(lit, z, cls) : [1, 1, 1];
      lightCache.set(key, l);
    }
    return l;
  };
  const clamp = (v: number): number => (v > 255 ? 255 : v);

  drawTerrainTiles(m, terrain, layout, canvas, lightAt, loadTerrainDepth(dir, m));

  // Palette per (palette key, owner, height level, lighting class): house remap, then the cell's lighting.
  const palCache = new Map<string, Uint8Array>();
  const paletteFor = (
    entry: SpriteEntry | { palette: string; remap: boolean },
    owner: string | undefined,
    z: number,
    cls: LightingClass = 'full',
  ): Uint8Array => {
    const key = `${entry.palette}|${entry.remap ? (owner ?? '') : ''}|${z}|${cls}`;
    let pal = palCache.get(key);
    if (!pal) {
      const base = palettes.get(entry.palette) ?? palettes.get('unit')!;
      const house = owner ? m.houses?.[owner] : undefined;
      const remapped = entry.remap && house ? applyRemap(base, house.remap) : Uint8Array.from(base);
      const [lr, lg, lb] = lightAt(z, cls);
      for (let i = 0; i < 256; i++) {
        remapped[i * 3] = clamp(remapped[i * 3]! * lr);
        remapped[i * 3 + 1] = clamp(remapped[i * 3 + 1]! * lg);
        remapped[i * 3 + 2] = clamp(remapped[i * 3 + 2]! * lb);
      }
      pal = remapped;
      palCache.set(key, pal);
    }
    return pal;
  };

  const blit = (frame: SpriteFrame, px: number, py: number, pal: Uint8Array, shadow = false): void => {
    const [rx, ry, rw, rh] = frame.rect;
    const ox = px + frame.offset[0];
    const oy = py + frame.offset[1];
    for (let y = 0; y < rh; y++) {
      for (let x = 0; x < rw; x++) {
        const s = ((ry + y) * spriteAtlas.width + rx + x) * 4;
        if (spriteAtlas.data[s + 3] === 0) continue;
        if (shadow) {
          canvas.darken(ox + x, oy + y, 0.5);
        } else {
          const v = spriteAtlas.data[s]!;
          canvas.put(ox + x, oy + y, pal[v * 3]!, pal[v * 3 + 1]!, pal[v * 3 + 2]!);
        }
      }
    }
  };

  const drawPoint = (o: MapObject): { sx: number; sy: number } => {
    const c = projectCorner(o.x, o.y, o.z);
    const d = o.drawOffset ?? [0, CELL_H / 2];
    return { sx: c.sx + d[0], sy: c.sy + d[1] };
  };

  const drawSprite = (o: MapObject, shadowPass: boolean): void => {
    const entry = o.sprite ? m.sprites[o.sprite] : undefined;
    if (!entry) return;
    const p = drawPoint(o);
    const frameIdx = Math.min(o.frame ?? 0, entry.frames.length - 1);
    const cls = o.lighting ?? 'full';
    if (shadowPass) {
      const sh = entry.shadows?.[frameIdx];
      if (sh) blit(sh, p.sx, p.sy, paletteFor(entry, undefined, o.z, cls), true);
      return;
    }
    for (const u of entry.underlays ?? []) {
      const ue = m.sprites[u];
      if (ue?.frames[0]) blit(ue.frames[0], p.sx, p.sy, paletteFor(ue, o.owner, o.z, cls));
    }
    const f = entry.frames[frameIdx];
    if (f) blit(f, p.sx, p.sy, paletteFor(entry, o.owner, o.z, cls));
    for (const l of entry.layers ?? []) {
      const le = m.sprites[l];
      if (le?.frames[0]) blit(le.frames[0], p.sx, p.sy, paletteFor(le, o.owner, o.z, cls));
    }
    bump(o.kind);
  };

  // Voxels (crude): world units -> leptons (8 per unit), rotated by facing, iso-projected, painter-sorted.
  const voxelCache = new Map<string, VoxelModel | null>();
  const loadVoxel = (id: string): VoxelModel | undefined => {
    if (!voxelCache.has(id)) {
      const file = m.voxels[id];
      voxelCache.set(id, file ? (JSON.parse(readFileSync(join(dir, file), 'utf8')) as VoxelModel) : null);
    }
    return voxelCache.get(id) ?? undefined;
  };
  const splatVoxel = (model: VoxelModel, sx: number, sy: number, z: number, facing: number, owner?: string): void => {
    const pal = paletteFor({ palette: model.palette, remap: true }, owner, z, 'ambient');
    const ang = (facing / 256) * Math.PI * 2;
    // Facing 0 = north = cell -Y; model +X is the vehicle's front.
    const fx = Math.sin(ang);
    const fy = -Math.cos(ang);
    const pts: { x: number; y: number; d: number; r: number; g: number; b: number }[] = [];
    const light: [number, number, number] = [0.2, -0.5, 0.85];
    for (const part of model.parts) {
      const partShift = part.role === 'body' ? 0 : (model.turretOffset ?? 0) / 8;
      for (const s of part.sections) {
        const vox = fromB64(s.voxels);
        const t = s.transform;
        const table = normalTableFor(sectionNormalsMode(s, vox));
        const sc = [0, 1, 2].map((k) => (s.maxBounds[k]! - s.minBounds[k]!) / Math.max(1, s.size[k]!));
        for (let i = 0; i < vox.length; i += 5) {
          const p = [0, 1, 2].map((k) => s.minBounds[k]! + (vox[i + k]! + 0.5) * sc[k]!);
          const wx = t[0]! * p[0]! + t[1]! * p[1]! + t[2]! * p[2]! + t[3]! + partShift;
          const wy = t[4]! * p[0]! + t[5]! * p[1]! + t[6]! * p[2]! + t[7]!;
          const wz = t[8]! * p[0]! + t[9]! * p[1]! + t[10]! * p[2]! + t[11]!;
          // Model (front x, left y) -> cell space.
          const cx = (wx * fx + wy * fy) * 8;
          const cy = (wx * fy - wy * fx) * 8;
          const n = lookupNormal(table, vox[i + 4]!);
          const lum = 0.55 + 0.45 * Math.max(0, n[0] * light[0] + n[1] * light[1] + n[2] * light[2]);
          const ci = vox[i + 3]!;
          pts.push({
            x: sx + ((cx - cy) * 30) / 256,
            y: sy + ((cx + cy) * 15) / 256 - (wz * 8 * 15) / 104,
            d: cx + cy + wz * 0.01,
            r: pal[ci * 3]! * lum,
            g: pal[ci * 3 + 1]! * lum,
            b: pal[ci * 3 + 2]! * lum,
          });
        }
      }
    }
    pts.sort((a, b) => a.d - b.d);
    for (const q of pts) {
      canvas.put(q.x, q.y, q.r, q.g, q.b);
      canvas.put(q.x + 1, q.y, q.r, q.g, q.b);
    }
  };

  const flat = m.objects.filter((o) => o.flat);
  const upright = m.objects.filter((o) => !o.flat);
  const sortY = (o: MapObject): number => {
    const e = o.sprite ? m.sprites[o.sprite] : undefined;
    if (o.kind === 'building' && e?.foundation) {
      const [w, h] = e.foundation;
      return projectCorner(o.x + w, o.y + h, o.z).sy;
    }
    return drawPoint(o).sy;
  };
  flat.sort((a, b) => drawPoint(a).sy - drawPoint(b).sy || a.x - b.x);
  upright.sort((a, b) => sortY(a) - sortY(b) || a.x - b.x);

  for (const o of flat) drawSprite(o, false);
  for (const o of [...flat, ...upright]) drawSprite(o, true);
  for (const o of upright) {
    if (o.voxel) {
      const model = loadVoxel(o.voxel);
      if (model) {
        const p = drawPoint(o);
        splatVoxel(model, p.sx, p.sy, o.z, o.facing ?? 0, o.owner);
        bump(`${o.kind}:voxel`);
      }
    } else {
      drawSprite(o, false);
    }
  }

  if (opts.foundations) {
    for (const o of m.objects) {
      const e = o.sprite ? m.sprites[o.sprite] : undefined;
      if (o.kind !== 'building' || !e?.foundation) continue;
      const [w, h] = e.foundation;
      const corners = [
        projectCorner(o.x, o.y, o.z),
        projectCorner(o.x + w, o.y, o.z),
        projectCorner(o.x + w, o.y + h, o.z),
        projectCorner(o.x, o.y + h, o.z),
      ];
      for (let k = 0; k < 4; k++) {
        const a = corners[k]!;
        const b = corners[(k + 1) % 4]!;
        const steps = Math.ceil(Math.hypot(b.sx - a.sx, b.sy - a.sy));
        for (let s = 0; s <= steps; s++)
          canvas.put(a.sx + ((b.sx - a.sx) * s) / steps, a.sy + ((b.sy - a.sy) * s) / steps, 255, 0, 255);
      }
    }
  }

  if (opts.modelStrip) {
    const ids = Object.keys(m.voxels).sort();
    ids.forEach((id, i) => {
      const model = loadVoxel(id);
      if (!model) return;
      const wx = -canvas.ox + 60 + i * 90;
      const wy = stripY;
      splatVoxel(model, wx, wy, 0, 96, undefined);
    });
  }

  const file = opts.out ?? join(dir, 'preview.png');
  const img: PngImage = { width: canvas.width, height: canvas.height, channels: 4, data: canvas.rgba };
  writeFileSync(file, encodePng(img));
  return { file, width: canvas.width, height: canvas.height, origin: [canvas.ox, canvas.oy], drawn };
}
