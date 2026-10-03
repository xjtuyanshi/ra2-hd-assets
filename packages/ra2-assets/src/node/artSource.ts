/**
 * Shared art resolution for every extractor (Node only): the per-map cache (extract.ts) and the per-theater type
 * library (library.ts) both turn rules type ids into SHP sprites, palettes and voxel models through this module, so an
 * engine rule fixed here applies to both.
 *
 * Rules encoded here (evidence in extract.ts' header and art.ts):
 *   - rules `Image=` names the art section; non-infantry also uses the art section's `Image=` as the file stem.
 *     Infantry takes its file stem from rules alone (the native ImageFile field), ignoring the art alias.
 *   - SHP names: `Theater=yes` -> theater extension, otherwise theater-letter substitution with the G fallback for
 *     every name matching the engine's prefix pattern, whatever `NewTheater=` says (artFileCandidates; evidence in
 *     art.ts).
 *   - YR art `Palette=<name>` selects `<name><theater ext>.pal`, falling back to `<name>.pal`.
 *   - voxels: `<image>.vxl/.hva` body, `<image>tur` turret and `<image>barl` barrel for Turret=yes types; HVA frame 0
 *     matrices with the translation scaled by the section scale.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { IniFile, IniSection, ShpFile, VxlFile } from 'ra2-formats';
import type { SpriteEntry, SpriteFrame, VoxelModel, VoxelPart } from '../manifest.ts';
import { chooseAtlasWidth, packShelves, packShelvesPaged } from '../atlas.ts';
import { animTimingArt, artFileCandidates, resolveArtFile, splitShadowHalf } from '../art.ts';
import { drawOffsetFor } from '../iso.ts';
import type { LibraryOverlay, LibrarySmudge } from '../library.ts';
import type { TheaterInfo } from '../theater.ts';
import type { GameInstall } from './install.ts';

/** The part of GameInstall the art code reads (lets tests inject a synthetic install). */
export type InstallView = Pick<GameInstall, 'has' | 'ini' | 'shp' | 'palette' | 'vxl' | 'hva'>;
import { encodePng } from './png.ts';

/** Palette key: "iso", "unit", "theater", "anim", or a custom art `Palette=` name (e.g. "lib"). */
export type PaletteKey = string;

export interface PendingFrame {
  w: number;
  h: number;
  offset: [number, number];
  pixels: Uint8Array;
}

/** Chooses which source body frames of a SHP to export (by index), given its body frame count. */
export type FramePicker = (bodyFrames: number) => number[];

export interface PendingSprite {
  entry: Omit<SpriteEntry, 'frames' | 'shadows'>;
  frames: PendingFrame[];
  shadows?: PendingFrame[];
}

export const b64 = (bytes: Uint8Array): string =>
  Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');

/** INI boolean the way the engine reads it (first letter y/t/1). */
export const secBool = (sec: IniSection | undefined, key: string, fallback = false): boolean =>
  sec?.has(key) ? /^(y|t|1)/i.test(sec.getString(key, '').trim()) : fallback;

/** Integer art/rules value, undefined when absent or not a number. */
export const secInt = (sec: IniSection | undefined, key: string): number | undefined => {
  if (!sec?.has(key)) return undefined;
  const v = Number.parseInt(sec.getString(key, ''), 10);
  return Number.isFinite(v) ? v : undefined;
};

/** Rules/art lookups for one theater, with optional scenario INIs overriding rulesmd (maps merge their sections). */
export class ArtSource {
  readonly rules: IniFile;
  readonly art: IniFile;
  /** Palette key -> file; custom art palettes are added as they are resolved. */
  readonly paletteFiles: Record<PaletteKey, string>;

  constructor(
    readonly inst: InstallView,
    readonly theater: TheaterInfo,
    private readonly warn: (m: string) => void,
    /** Scenario INIs consulted before rulesmd.ini (highest priority first). */
    private readonly overrides: readonly IniFile[] = [],
  ) {
    this.rules = inst.ini('rulesmd.ini');
    this.art = inst.ini('artmd.ini');
    this.paletteFiles = {
      iso: theater.isoPalette,
      unit: theater.unitPalette,
      theater: theater.theaterPalette,
      anim: 'anim.pal',
    };
  }

  /** Rules value with the scenario's own section overriding rulesmd. */
  rulesGet(id: string, key: string): string | undefined {
    for (const ini of [...this.overrides, this.rules]) {
      const sec = ini.getSection(id);
      if (sec?.has(key)) return sec.getString(key, '');
    }
    return undefined;
  }

  rulesBool(id: string, key: string, fallback = false): boolean {
    const v = this.rulesGet(id, key);
    if (v === undefined) return fallback;
    return /^(y|t|1)/i.test(v.trim());
  }

  rulesInt(id: string, key: string): number | undefined {
    const v = Number.parseInt(this.rulesGet(id, key) ?? '', 10);
    return Number.isFinite(v) ? v : undefined;
  }

  /** Art section + file stem for a rules type (rules Image= -> art section, art Image= -> file stem). */
  artOf(id: string): { sec: IniSection | undefined; image: string; section: string } {
    const rulesImage = (this.rulesGet(id, 'Image') ?? '').trim() || id;
    const sec = this.art.getSection(rulesImage) ?? this.art.getSection(id);
    const image = sec?.getString('Image', '').trim() || rulesImage;
    return { sec, image, section: sec?.name ?? rulesImage };
  }

  /**
   * Infantry keeps the rules ImageFile stem while reading sequence/remap metadata from its art section. YR 1.001
   * ObjectType::LoadFromINI (0x5F933B) reads Image from the caller's rules INI; Techno's SHP load (0x7157B5) uses that
   * field directly. Thus stock CAML's art Image=JOSH does not change its camel SHP. Scenario rules still override it.
   */
  infantryArtOf(id: string): { sec: IniSection | undefined; image: string; section: string } {
    return { ...this.artOf(id), image: (this.rulesGet(id, 'Image') ?? '').trim() || id };
  }

  /** SHP file candidates for an art image (theater extension for `Theater=yes`, else theater-letter substitution). */
  shpCandidates(image: string, sec: IniSection | undefined): string[] {
    return artFileCandidates(image, {
      theater: secBool(sec, 'Theater'),
      newTheater: true,
      theaterExt: this.theater.ext,
      theaterLetter: this.theater.newTheaterLetter,
    });
  }

  /**
   * Overlay art rules shared by map and live-library extraction. Draw offsets/lighting preserve the map extractor's
   * conventions. YR 1.001 DrawOverlay tests Wall at 0x47F96A and selects the current player's ColorSchemeIndex at
   * 0x47F9B2; walls therefore use the unit palette with current-player remap, rather than WallOwnerIndex.
   */
  overlayArt(id: string): Omit<LibraryOverlay, 'sprite' | 'frames'> & { candidates: string[] } {
    if (this.rulesBool(id, 'IsRubble'))
      return {
        candidates: [],
        rubble: true,
        palette: 'iso',
        wall: false,
        tiberium: false,
        remap: false,
        flat: true,
        drawOffset: drawOffsetFor('overlay'),
        lighting: 'full',
      };
    const { sec, image } = this.artOf(id);
    const wall = this.rulesBool(id, 'Wall');
    const tiberium = this.rulesBool(id, 'Tiberium');
    const highBridge = /^(BRIDGE|BRIDGEB|RAILBRDG)[12]$/i.test(id);
    return {
      candidates: this.shpCandidates(image, sec),
      palette: wall ? 'unit' : tiberium ? 'theater' : 'iso',
      wall,
      tiberium,
      remap: wall,
      flat: !wall && !highBridge && (tiberium || this.rulesBool(id, 'DrawFlat', true)),
      drawOffset: highBridge ? [0, -60] : drawOffsetFor('overlay', { isARock: this.rulesBool(id, 'IsARock') }),
      lighting: tiberium ? 'none' : wall ? 'ambient' : 'full',
    };
  }

  /** SmudgeTypes always use theater art, including types with no art Theater=yes entry. */
  smudgeArt(id: string): Omit<LibrarySmudge, 'sprite' | 'frames'> & { candidates: string[] } {
    const { image } = this.artOf(id);
    return {
      candidates: artFileCandidates(image, {
        theater: true,
        newTheater: false,
        theaterExt: this.theater.ext,
        theaterLetter: this.theater.newTheaterLetter,
      }),
      palette: 'iso',
      width: Math.max(1, this.rulesInt(id, 'Width') ?? 1),
      height: Math.max(1, this.rulesInt(id, 'Height') ?? 1),
      remap: false,
      flat: true,
      drawOffset: drawOffsetFor('smudge'),
      lighting: 'full',
    };
  }

  /** An anim section (building layer, bib, buildup): its file candidates and timing. */
  animArt(anim: string): {
    sec: IniSection | undefined;
    image: string;
    candidates: string[];
    timing: ReturnType<typeof animTimingArt>;
  } {
    const sec = this.art.getSection(anim);
    const image = sec?.getString('Image', '').trim() || anim;
    return { sec, image, candidates: this.shpCandidates(image, sec), timing: animTimingArt(sec) };
  }

  /**
   * YR art `Palette=<name>` (e.g. CANEWY04, the Statue of Liberty: Palette=lib) selects `<name><theater ext>.pal`,
   * falling back to `<name>.pal`. Returns the palette key, or undefined when no such file exists.
   */
  customPalette(sec: IniSection | undefined): PaletteKey | undefined {
    const name = sec?.getString('Palette', '').trim().toLowerCase();
    if (!name) return undefined;
    const file = [`${name}${this.theater.ext}.pal`, `${name}.pal`].find((f) => this.inst.has(f));
    if (!file) {
      this.warn(`art Palette=${name}: no ${name}${this.theater.ext}.pal / ${name}.pal, using the unit palette`);
      return undefined;
    }
    this.paletteFiles[name] = file;
    return name;
  }
}

/** Loads SHPs into pending sprites (idempotent by id) and records which palettes they use. */
export class SpriteCollector {
  readonly sprites = new Map<string, PendingSprite>();
  readonly usedPalettes: Set<PaletteKey>;

  constructor(
    private readonly inst: InstallView,
    private readonly warn: (m: string) => void,
    initialPalettes: readonly PaletteKey[] = [],
  ) {
    this.usedPalettes = new Set(initialPalettes);
  }

  /** Load a SHP into a pending sprite (idempotent by id). Returns undefined when no file resolves. */
  addShp(
    id: string,
    candidates: string[],
    palette: PaletteKey,
    remap: boolean,
    extra: Partial<SpriteEntry> = {},
    pick?: FramePicker,
    inlineShadowIndex?: number,
  ): PendingSprite | undefined {
    const known = this.sprites.get(id);
    if (known) return known;
    const file = resolveArtFile(candidates, (n) => this.inst.has(n));
    if (!file) {
      this.warn(`${id}: no art file (${candidates.join(', ') || 'no candidates'})`);
      return undefined;
    }
    const shp = this.inst.shp(file);
    if (!shp) {
      this.warn(`${id}: ${file} is not a readable SHP`);
      return undefined;
    }
    const decoded = decodeShp(shp);
    const split = splitShadowHalf(decoded);
    const canvas: [number, number] = [shp.cx, shp.cy];
    const toFrame = (f: (typeof decoded)[number]): PendingFrame => ({
      w: f.cx,
      h: f.cy,
      offset: [f.x - Math.floor(shp.cx / 2), f.y - Math.floor(shp.cy / 2)],
      pixels: f.pixels,
    });
    const picked = pick?.(split.body).filter((i) => i >= 0 && i < split.body);
    const bodies = picked ? picked.map((i) => decoded[i]!) : decoded.slice(0, split.body);
    const shadows = (picked ?? bodies.map((_, i) => i)).map((i) =>
      shpShadowFrame(decoded[i]!, split.hasShadows ? decoded[split.body + i] : undefined, inlineShadowIndex),
    );
    const pending: PendingSprite = {
      entry: {
        palette,
        remap,
        canvas,
        file,
        frameCount: decoded.length,
        ...(picked ? { sourceFrames: picked } : {}),
        ...extra,
      },
      frames: bodies.map(toFrame),
      ...(split.hasShadows || inlineShadowIndex !== undefined ? { shadows: shadows.map(toFrame) } : {}),
    };
    this.usedPalettes.add(palette);
    this.sprites.set(id, pending);
    return pending;
  }
}

/** Prefer baked shadow art; otherwise isolate a caller-selected inline palette index without changing body art. */
export function shpShadowFrame(
  body: ReturnType<typeof decodeShp>[number],
  baked: ReturnType<typeof decodeShp>[number] | undefined,
  inlineIndex?: number,
): ReturnType<typeof decodeShp>[number] {
  if (baked?.pixels.some((v) => v !== 0)) return baked;
  if (inlineIndex === undefined) return baked ?? { x: 0, y: 0, cx: 0, cy: 0, pixels: new Uint8Array() };
  // Index 1 is the atlas shadow convention; source palette colours never enter the shadow pass.
  const pixels = body.pixels.map((v) => (v === inlineIndex ? 1 : 0));
  return pixels.some((v) => v !== 0)
    ? { ...body, pixels }
    : { x: body.x, y: body.y, cx: 0, cy: 0, pixels: new Uint8Array() };
}

export function decodeShp(shp: ShpFile): { x: number; y: number; cx: number; cy: number; pixels: Uint8Array }[] {
  const out: { x: number; y: number; cx: number; cy: number; pixels: Uint8Array }[] = [];
  for (let i = 0; i < shp.count; i++) {
    try {
      const f = shp.frame(i);
      out.push({ x: f.x, y: f.y, cx: f.pixels.length ? f.cx : 0, cy: f.pixels.length ? f.cy : 0, pixels: f.pixels });
    } catch {
      out.push({ x: 0, y: 0, cx: 0, cy: 0, pixels: new Uint8Array(0) });
    }
  }
  return out;
}

/** One VXL/HVA pair of a voxel model: which part it is, its file stem, and whether a missing file is an error. */
export interface VoxelPartSpec {
  role: VoxelPart['role'];
  stem: string;
  /** Warn when the VXL is missing (the body of a unit; building turrets). */
  required: boolean;
}

/** The body/turret/barrel parts of a rules voxel unit (`<image>`, `<image>tur`, `<image>barl`). */
export function unitVoxelParts(image: string, hasTurret: boolean): VoxelPartSpec[] {
  const stem = image.toLowerCase();
  const parts: VoxelPartSpec[] = [{ role: 'body', stem, required: true }];
  if (hasTurret) {
    parts.push({ role: 'turret', stem: `${stem}tur`, required: false });
    parts.push({ role: 'barrel', stem: `${stem}barl`, required: false });
  }
  return parts;
}

/** Build a VoxelModel from VXL/HVA parts; undefined when no part loads. */
export function buildVoxelModel(
  id: string,
  specs: readonly VoxelPartSpec[],
  turretOffset: number,
  inst: InstallView,
  warn: (m: string) => void,
): VoxelModel | undefined {
  const parts: VoxelPart[] = [];
  let normalsMode: number | undefined;
  for (const { role, stem: name, required } of specs) {
    let vxl: VxlFile | undefined;
    try {
      vxl = inst.vxl(`${name}.vxl`);
    } catch (err) {
      warn(`voxel ${id}: ${name}.vxl unreadable (${(err as Error).message})`);
      continue;
    }
    if (!vxl) {
      if (required) warn(`voxel ${id}: ${name}.vxl missing`);
      continue;
    }
    let hva;
    try {
      hva = inst.hva(`${name}.hva`);
    } catch {
      hva = undefined;
    }
    if (!hva) warn(`voxel ${id}: ${name}.hva missing, using the VXL section transforms`);
    const sections = vxl.sections.map((s) => {
      let m = [...s.transform];
      if (hva) {
        const named = hva.sectionNames.findIndex((n) => n.toLowerCase() === s.name.toLowerCase());
        const hi = named >= 0 ? named : s.index < hva.sectionCount ? s.index : 0;
        m = [...hva.matrix(hi, 0)];
      }
      m[3] = m[3]! * s.scale;
      m[7] = m[7]! * s.scale;
      m[11] = m[11]! * s.scale;
      normalsMode ??= s.normalsMode;
      const buf = new Uint8Array(s.voxels.length * 5);
      s.voxels.forEach((v, i) => buf.set([v.x, v.y, v.z, v.color, v.normal], i * 5));
      return {
        name: s.name,
        size: [s.cx, s.cy, s.cz] as [number, number, number],
        scale: s.scale,
        minBounds: [...s.minBounds] as [number, number, number],
        maxBounds: [...s.maxBounds] as [number, number, number],
        transform: m,
        voxels: b64(buf),
        normalsMode: s.normalsMode,
      };
    });
    parts.push({ role, sections });
  }
  if (!parts.length) return undefined;
  // The model-level mode is the first (body) section's; each section carries its own.
  return { id, palette: 'unit', normalsMode: normalsMode ?? 4, parts, file: `${specs[0]!.stem}.vxl`, turretOffset };
}

export interface PackedSprites {
  /** Page images: RGBA (R = index, A = 255 where index != 0) or single-channel indexed. */
  pages: { width: number; height: number; data: Uint8Array }[];
  entries: Record<string, SpriteEntry>;
}

/**
 * Pack every body and shadow frame of `sprites` (sorted by id) into atlas pages.
 *   - `rgba` (map cache): one page of chooseAtlasWidth's width, R = palette index, A = 255 where the index is not 0;
 *     frames carry no `page`.
 *   - `indexed` (type library): single-channel pages of at most `maxPage` square; frames on pages > 0 carry `page`.
 */
export function packSprites(
  sprites: ReadonlyMap<string, PendingSprite>,
  opts: { format: 'rgba' } | { format: 'indexed'; maxPage: number },
): PackedSprites {
  const spriteIds = [...sprites.keys()].sort();
  const allFrames: PendingFrame[] = [];
  const groupOf = new Map<PendingFrame, number>();
  // Paged atlases keep each sprite's frames together, in collection order (a type's body, layers, bib and buildup
  // were collected one after another), so a renderer that loads pages lazily needs few pages per type.
  const insertion = new Map([...sprites.keys()].map((id, i) => [id, i]));
  for (const sid of spriteIds) {
    const s = sprites.get(sid)!;
    for (const f of [...s.frames, ...(s.shadows ?? [])]) {
      allFrames.push(f);
      groupOf.set(f, insertion.get(sid)!);
    }
  }
  const nonEmpty = allFrames.filter((f) => f.w > 0 && f.h > 0);
  const sizes = nonEmpty.map((f) => ({ w: f.w, h: f.h }));
  const channels = opts.format === 'rgba' ? 4 : 1;
  let pageSizes: { width: number; height: number }[];
  let rects: { x: number; y: number; w: number; h: number; page: number }[];
  if (opts.format === 'rgba') {
    const pack = packShelves(sizes, 1, chooseAtlasWidth(sizes, 1));
    pageSizes = [{ width: pack.width, height: pack.height }];
    rects = pack.rects.map((r) => ({ ...r, page: 0 }));
  } else {
    const pack = packShelvesPaged(
      sizes,
      1,
      opts.maxPage,
      opts.maxPage,
      nonEmpty.map((f) => groupOf.get(f)!),
    );
    pageSizes = pack.pages;
    rects = pack.rects;
  }
  const pages = pageSizes.map((p) => ({ ...p, data: new Uint8Array(p.width * p.height * channels) }));
  const placed = new Map<PendingFrame, { rect: [number, number, number, number]; page: number }>();
  nonEmpty.forEach((f, i) => {
    const r = rects[i]!;
    placed.set(f, { rect: [r.x, r.y, r.w, r.h], page: r.page });
    const page = pages[r.page]!;
    for (let py = 0; py < f.h; py++) {
      for (let px = 0; px < f.w; px++) {
        const v = f.pixels[py * f.w + px]!;
        if (!v) continue;
        const d = ((r.y + py) * page.width + r.x + px) * channels;
        page.data[d] = v;
        if (channels === 4) page.data[d + 3] = 255;
      }
    }
  });
  const toFrame = (f: PendingFrame): SpriteFrame => {
    const p = placed.get(f);
    return {
      rect: p?.rect ?? [0, 0, 0, 0],
      offset: f.offset,
      ...(p && p.page > 0 ? { page: p.page } : {}),
    };
  };
  const entries: Record<string, SpriteEntry> = {};
  for (const sid of spriteIds) {
    const s = sprites.get(sid)!;
    entries[sid] = {
      ...s.entry,
      frames: s.frames.map(toFrame),
      ...(s.shadows ? { shadows: s.shadows.map(toFrame) } : {}),
    } as SpriteEntry;
  }
  return { pages, entries };
}

/**
 * Write `palettes/<key>.png` (256x1 RGB) for every used key that has a file, returning the manifest maps. Missing
 * palette files are warned about and skipped.
 */
export function writePalettes(
  inst: InstallView,
  outDir: string,
  used: Iterable<PaletteKey>,
  files: Record<PaletteKey, string>,
  warn: (m: string) => void,
): { palettes: Record<string, string>; paletteSources: Record<string, string> } {
  mkdirSync(join(outDir, 'palettes'), { recursive: true });
  const palettes: Record<string, string> = {};
  const paletteSources: Record<string, string> = {};
  for (const key of [...used].sort()) {
    const src = files[key];
    if (!src) continue;
    let pal;
    try {
      pal = inst.palette(src);
    } catch {
      warn(`palette ${src} missing`);
      continue;
    }
    const file = `palettes/${key}.png`;
    writeFileSync(
      join(outDir, file),
      encodePng({ width: 256, height: 1, channels: 3, data: Uint8Array.from(pal.rgb) }),
    );
    palettes[key] = file;
    paletteSources[key] = src;
  }
  return { palettes, paletteSources };
}
