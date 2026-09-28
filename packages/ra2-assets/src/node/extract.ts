/**
 * HD cache extraction (Node only): reads one map plus the art it references from the player's own install and writes
 * <out>/<mapId>/ as described by ../manifest.ts. Everything written is derived game data and must stay in the
 * gitignored gameres/ directory.
 *
 * Palette choices (engine behaviour; verified by rendering each art class with all four candidate palettes against
 * the player's install — only the listed palette gives natural colours — and consistent with ModEnc and Vanguard
 * apps/client/dev/assetPlugin.ts):
 *   - terrain tiles: iso<th>.pal
 *   - buildings, infantry, SHP vehicles, voxels, walls, building anims/bibs: unit<th>.pal, house-remapped (16..31);
 *     a building's art `Palette=<name>` (YR, e.g. the Statue of Liberty's `lib`) selects <name><ext>.pal and art
 *     `Remapable=no` disables the house remap
 *   - terrain objects (trees, lamps): iso<th>.pal; tiberium trees (SpawnsTiberium=yes, e.g. TIBTRE02 ore mines)
 *     use unit<th>.pal
 *   - smudges: iso<th>.pal (ground decals lit like tiles)
 *   - overlays: Tiberium=yes (ore TIB*, gems GEM*) use <theater>.pal (temperat.pal); walls use unit<th>.pal with
 *     remap; every other overlay (rocks SROCK/TROCK, low bridges LOBRDG, fences, crates) uses iso<th>.pal
 *   - stand-alone anims would use anim.pal; maps place none, so the key is only written when used
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { IniSection, ShpFile, TmpFile, VxlFile } from 'ra2-formats';
import type {
  AtlasRef,
  HdCacheManifest,
  HouseColor,
  MapLighting,
  MapObject,
  MapObjectKind,
  SpriteEntry,
  SpriteFrame,
  TileEntry,
  VoxelModel,
  VoxelPart,
} from '../manifest.ts';
import { HD_CACHE_VERSION } from '../manifest.ts';
import { packShelves } from '../atlas.ts';
import {
  animStillFrame,
  artFileCandidates,
  buildingConditionFrame,
  facingFrame,
  parseFoundation,
  parseIniFraction,
  parseSequenceEntry,
  resolveArtFile,
  splitShadowHalf,
} from '../art.ts';
import {
  cutoffTileHeight,
  DEFAULT_LIGHT_LEVEL,
  drawOffsetFor,
  leptonDelta,
  localScreenRect,
  mapSizeCells,
  mergeTileExtra,
  SUBCELL_LEPTONS,
  tileAnchor,
} from '../iso.ts';
import { parseHsv, remapRamp } from '../remap.ts';
import { THEATERS, buildTileTable, resolveCellTile, theaterFromMap, type TemplateShape } from '../theater.ts';
import { GameInstall, loadMap } from './install.ts';
import { encodePng } from './png.ts';

export interface ExtractOptions {
  gameDir: string;
  map: string;
  outDir: string;
  /** Extra voxel types to extract even when the map does not place them. */
  defaultVoxels?: string[];
  log?: (msg: string) => void;
}

export interface ExtractResult {
  mapId: string;
  dir: string;
  manifest: HdCacheManifest;
}

export const DEFAULT_VOXELS = ['MTNK', 'HTNK', 'HARV', 'CMIN', 'SMCV', 'AMCV'];

/** Palette key: the four standard ones, or a custom art `Palette=` name (e.g. "lib"). */
type PaletteKey = string;

interface PendingFrame {
  w: number;
  h: number;
  offset: [number, number];
  pixels: Uint8Array;
}

/** Chooses which source body frames of a SHP to export (by index), given its body frame count. */
type FramePicker = (bodyFrames: number) => number[];

interface PendingSprite {
  entry: Omit<SpriteEntry, 'frames' | 'shadows'>;
  frames: PendingFrame[];
  shadows?: PendingFrame[];
}

const b64 = (bytes: Uint8Array): string =>
  Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');

export function extractMap(opts: ExtractOptions): ExtractResult {
  const log = opts.log ?? ((m: string) => console.log(m));
  const warnings: string[] = [];
  const warn = (m: string): void => {
    if (!warnings.includes(m)) warnings.push(m);
  };

  const loaded = loadMap(opts.gameDir, opts.map);
  const { map } = loaded;
  const theaterId = theaterFromMap(map.theater);
  if (!theaterId) throw new Error(`unsupported theater "${map.theater}" in ${loaded.source}`);
  const theater = THEATERS[theaterId];
  const inst = GameInstall.open(opts.gameDir, theaterId);
  log(`mounted ${inst.report.mounted.length} archives; theater ${theaterId}`);

  const rules = inst.ini('rulesmd.ini');
  const art = inst.ini('artmd.ini');
  const control = inst.ini(theater.controlIni);
  const mapIni = map.ini;

  /** rules value with the map's own section overriding rulesmd (as the engine merges scenario INIs). */
  const rulesGet = (id: string, key: string): string | undefined => {
    for (const ini of [mapIni, rules]) {
      const sec = ini.getSection(id);
      if (sec?.has(key)) return sec.getString(key, '');
    }
    return undefined;
  };
  const rulesBool = (id: string, key: string, fallback = false): boolean => {
    const v = rulesGet(id, key);
    if (v === undefined) return fallback;
    return /^(y|t|1)/i.test(v.trim());
  };
  const secBool = (sec: IniSection | undefined, key: string, fallback = false): boolean =>
    sec?.has(key) ? /^(y|t|1)/i.test(sec.getString(key, '').trim()) : fallback;

  // ---------------------------------------------------------------- palettes
  const paletteFiles: Record<PaletteKey, string> = {
    iso: theater.isoPalette,
    unit: theater.unitPalette,
    theater: theater.theaterPalette,
    anim: 'anim.pal',
  };
  /**
   * YR art `Palette=<name>` (e.g. CANEWY04, the Statue of Liberty: Palette=lib) selects `<name><theater ext>.pal`,
   * falling back to `<name>.pal`. Returns the palette key, or undefined when no such file exists.
   */
  const customPalette = (sec: IniSection | undefined): PaletteKey | undefined => {
    const name = sec?.getString('Palette', '').trim().toLowerCase();
    if (!name) return undefined;
    const file = [`${name}${theater.ext}.pal`, `${name}.pal`].find((f) => inst.has(f));
    if (!file) {
      warn(`art Palette=${name}: no ${name}${theater.ext}.pal / ${name}.pal, using the unit palette`);
      return undefined;
    }
    paletteFiles[name] = file;
    return name;
  };
  const usedPalettes = new Set<PaletteKey>(['iso', 'unit']);

  // ---------------------------------------------------------------- terrain
  const table = buildTileTable(control, theater.ext);
  const shapeCache = new Map<number, (TemplateShape & { tmp: TmpFile; file: string }) | null>();
  const shapeOf = (tileNum: number): (TemplateShape & { tmp: TmpFile; file: string }) | undefined => {
    if (!shapeCache.has(tileNum)) {
      const slot = table.slots[tileNum];
      const tmp = slot ? inst.tmp(slot.file) : undefined;
      if (slot && !tmp) warn(`tile ${tileNum}: template ${slot.file} missing`);
      shapeCache.set(
        tileNum,
        tmp && slot
          ? { blocksX: tmp.blocksX, blocksY: tmp.blocksY, isEmpty: (i: number) => tmp.isEmpty(i), tmp, file: slot.file }
          : null,
      );
    }
    return shapeCache.get(tileNum) ?? undefined;
  };

  // Cells the pack omits are clear ground at level 0 in the engine (the cell array starts cleared), so every cell of
  // the map's [Map] Size rhombus that has no record gets the clear tile.
  const isoTiles = [...map.tiles];
  const size = map.size;
  let filled = 0;
  if (size) {
    const have = new Set(isoTiles.map((t) => t.y * 4096 + t.x));
    for (const c of mapSizeCells(size.width, size.height)) {
      if (have.has(c.y * 4096 + c.x)) continue;
      isoTiles.push({ x: c.x, y: c.y, tileNum: 0xffff, subTile: 0, z: 0, flags: 0 });
      filled++;
    }
  }
  let gridW = 0;
  let gridH = 0;
  for (const t of isoTiles) {
    gridW = Math.max(gridW, t.x + 1);
    gridH = Math.max(gridH, t.y + 1);
  }
  const exists = new Uint8Array(gridW * gridH);
  const heights = new Uint8Array(gridW * gridH);
  const tileIdx = new Uint16Array(gridW * gridH).fill(0xffff);
  const tileKeys = new Map<string, number>();
  const tiles: TileEntry[] = [];
  const tileRasters: { width: number; height: number; bitmap: Uint8Array }[] = [];
  let substituted = 0;
  let unresolved = 0;

  for (const cell of isoTiles) {
    if (cell.x < 0 || cell.y < 0) continue;
    const i = cell.y * gridW + cell.x;
    exists[i] = 1;
    heights[i] = cell.z;
    const res = resolveCellTile(cell, table, shapeOf);
    if (!res) {
      unresolved++;
      continue;
    }
    if (res.substituted) substituted++;
    const shape = shapeOf(res.tileNum)!;
    const key = `${shape.file}#${res.subTile}`;
    let index = tileKeys.get(key);
    if (index === undefined) {
      const tile = shape.tmp.getTile(res.subTile);
      if (!tile) {
        unresolved++;
        continue;
      }
      const place = mergeTileExtra(tile, tile.extra, shape.tmp.tileWidth, shape.tmp.tileHeight);
      const bitmap = new Uint8Array(place.width * place.height);
      const tw = shape.tmp.tileWidth;
      for (let py = 0; py < shape.tmp.tileHeight; py++) {
        for (let px = 0; px < tw; px++) {
          const v = tile.bitmap[py * tw + px]!;
          if (v) bitmap[(py + place.diamond[1]) * place.width + px + place.diamond[0]] = v;
        }
      }
      if (tile.extra) {
        const e = tile.extra;
        for (let py = 0; py < e.height; py++) {
          for (let px = 0; px < e.width; px++) {
            const v = e.bitmap[py * e.width + px]!;
            if (v) bitmap[(py + place.extra[1]) * place.width + px + place.extra[0]] = v;
          }
        }
      }
      index = tiles.length;
      tileKeys.set(key, index);
      tiles.push({
        file: shape.file,
        subTile: res.subTile,
        height: tile.height,
        rampType: tile.rampType,
        terrainType: tile.terrainType,
        rect: [0, 0, place.width, place.height],
        anchor: tileAnchor(place.diamond[0], place.diamond[1]),
      });
      tileRasters.push({ width: place.width, height: place.height, bitmap });
    }
    tileIdx[i] = index;
  }
  if (unresolved) warn(`${unresolved} cells have no drawable tile`);

  const isoPal = inst.palette(theater.isoPalette).rgb;
  const terrainPack = packShelves(
    tileRasters.map((r) => ({ w: r.width, h: r.height })),
    1,
  );
  const terrainRgba = new Uint8Array(terrainPack.width * terrainPack.height * 4);
  tileRasters.forEach((r, i) => {
    const rect = terrainPack.rects[i]!;
    tiles[i]!.rect = [rect.x, rect.y, rect.w, rect.h];
    for (let py = 0; py < r.height; py++) {
      for (let px = 0; px < r.width; px++) {
        const v = r.bitmap[py * r.width + px]!;
        if (!v) continue;
        const d = ((rect.y + py) * terrainPack.width + rect.x + px) * 4;
        terrainRgba[d] = isoPal[v * 3]!;
        terrainRgba[d + 1] = isoPal[v * 3 + 1]!;
        terrainRgba[d + 2] = isoPal[v * 3 + 2]!;
        terrainRgba[d + 3] = 255;
      }
    }
  });
  const heightAt = (x: number, y: number): number =>
    x >= 0 && y >= 0 && x < gridW && y < gridH ? heights[y * gridW + x]! : 0;

  // ---------------------------------------------------------------- sprites
  const sprites = new Map<string, PendingSprite>();

  /** Load a SHP into a pending sprite (idempotent by id). Returns undefined when no file resolves. */
  const addShp = (
    id: string,
    candidates: string[],
    palette: PaletteKey,
    remap: boolean,
    extra: Partial<SpriteEntry> = {},
    pick?: FramePicker,
  ): PendingSprite | undefined => {
    const known = sprites.get(id);
    if (known) return known;
    const file = resolveArtFile(candidates, (n) => inst.has(n));
    if (!file) {
      warn(`${id}: no art file (${candidates.join(', ') || 'no candidates'})`);
      return undefined;
    }
    const shp = inst.shp(file);
    if (!shp) {
      warn(`${id}: ${file} is not a readable SHP`);
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
    const shadows = picked ? picked.map((i) => decoded[split.body + i]!) : decoded.slice(split.body);
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
      ...(split.hasShadows ? { shadows: shadows.map(toFrame) } : {}),
    };
    usedPalettes.add(palette);
    sprites.set(id, pending);
    return pending;
  };

  /** art section + file stem for a rules type (rules Image= -> art section, art Image= -> file stem). */
  const artOf = (id: string): { sec: IniSection | undefined; image: string } => {
    const rulesImage = (rulesGet(id, 'Image') ?? '').trim() || id;
    const sec = art.getSection(rulesImage) ?? art.getSection(id);
    const image = sec?.getString('Image', '').trim() || rulesImage;
    return { sec, image };
  };
  const shpCandidates = (image: string, sec: IniSection | undefined, forceNewTheater = false): string[] =>
    artFileCandidates(image, {
      theater: secBool(sec, 'Theater'),
      newTheater: forceNewTheater || secBool(sec, 'NewTheater'),
      theaterExt: theater.ext,
      theaterLetter: theater.newTheaterLetter,
    });

  // ---------------------------------------------------------------- houses
  const houses: Record<string, HouseColor> = {};
  const unitPalRgb = inst.palette(theater.unitPalette).rgb;
  const colors = rules.getSection('Colors');
  const houseColor = (owner: string): void => {
    if (!owner) return;
    if (!houses[owner]) {
      const colorName =
        mapIni.getSection(owner)?.getString('Color', '') ||
        rules.getSection(owner)?.getString('Color', '') ||
        (owner.toLowerCase() === 'neutral' || owner.toLowerCase() === 'special' ? 'LightGrey' : 'Gold');
      const hsv = parseHsv(colors?.getString(colorName, '') ?? '') ?? [0, 0, 180];
      houses[owner] = { colorName, hsv, remap: remapRamp(unitPalRgb, hsv) };
    }
  };

  const objects: MapObject[] = [];
  const counts: Record<string, number> = {};
  const count = (k: string): void => {
    counts[k] = (counts[k] ?? 0) + 1;
  };
  // Engine draw points (see drawOffsetFor): overlays, smudges, buildings and tiberium trees put their canvas centre on
  // the cell's top corner; rocks, other terrain objects and movable objects on the cell centre (or their coord).
  const cellCorner = drawOffsetFor('overlay');
  const cellCentre = drawOffsetFor('vehicle');
  // YR writes these as percentages ("50%"); parseIniFraction reads them as the engine does.
  const conditionYellow = parseIniFraction(rules.getSection('AudioVisual')?.getString('ConditionYellow', ''), 0.5);

  // Terrain objects ------------------------------------------------------------
  for (const t of map.terrainObjects) {
    const { sec, image } = artOf(t.type);
    const tiberiumTree = rulesBool(t.type, 'SpawnsTiberium');
    const id = `tree:${t.type}`;
    const s = addShp(id, shpCandidates(image, sec), tiberiumTree ? 'unit' : 'iso', false);
    if (!s) continue;
    objects.push({
      kind: 'tree',
      type: t.type,
      x: t.x,
      y: t.y,
      z: heightAt(t.x, t.y),
      sprite: id,
      frame: 0,
      drawOffset: drawOffsetFor('tree', { spawnsTiberium: tiberiumTree }),
      lighting: tiberiumTree ? 'none' : 'full',
    });
    count('tree');
  }

  // Smudges ---------------------------------------------------------------------
  for (const e of mapIni.getSection('Smudge')?.entries ?? []) {
    const [type, xs, ys] = e.value.split(',').map((p) => p.trim());
    const x = Number.parseInt(xs ?? '', 10);
    const y = Number.parseInt(ys ?? '', 10);
    if (!type || !Number.isFinite(x) || !Number.isFinite(y)) continue;
    const { image } = artOf(type);
    const id = `smudge:${type}`;
    // SmudgeTypes are always theater art (cr1.tem, burn01.tem, ...) even without an art Theater=yes entry.
    const candidates = artFileCandidates(image, {
      theater: true,
      newTheater: false,
      theaterExt: theater.ext,
      theaterLetter: theater.newTheaterLetter,
    });
    const s = addShp(id, candidates, 'iso', false);
    if (!s) continue;
    objects.push({
      kind: 'smudge',
      type,
      x,
      y,
      z: heightAt(x, y),
      sprite: id,
      frame: 0,
      flat: true,
      drawOffset: cellCorner,
      lighting: 'full',
    });
    count('smudge');
  }

  // Overlays ----------------------------------------------------------------------
  const overlayIds = [
    ...new Set(
      rules
        .readRegistry('OverlayTypes')
        .map((v) => v.trim())
        .filter(Boolean),
    ),
  ];
  const ov = map.overlay;
  const od = map.overlayData;
  for (let i = 0; i < ov.length; i++) {
    const idx = ov[i]!;
    if (idx === 0xff) continue;
    const x = i % 512;
    const y = Math.floor(i / 512);
    const type = overlayIds[idx];
    if (!type) {
      warn(`overlay index ${idx} not in [OverlayTypes]`);
      continue;
    }
    const { sec, image } = artOf(type);
    const wall = rulesBool(type, 'Wall');
    const tiberium = rulesBool(type, 'Tiberium');
    const id = `overlay:${type}`;
    const s = addShp(id, shpCandidates(image, sec), wall ? 'unit' : tiberium ? 'theater' : 'iso', wall);
    if (!s) continue;
    let frame = od[i]!;
    if (frame >= s.frames.length) {
      warn(`${id}: OverlayData ${frame} beyond ${s.frames.length} body frames (clamped)`);
      frame = s.frames.length - 1;
    }
    // High bridges (BRIDGE1/2, BRIDGEB1/2, RAILBRDG1/2) are drawn BridgeLevels (4) levels above their cell. They have
    // no DrawFlat key, so the DrawFlat default must not put their raised deck into the ground pass.
    const highBridge = /^(BRIDGE|BRIDGEB|RAILBRDG)[12]$/i.test(type);
    const drawFlat = rulesBool(type, 'DrawFlat', true);
    const flat = !wall && !highBridge && (tiberium || drawFlat);
    const off: [number, number] = highBridge
      ? [0, -4 * 15]
      : drawOffsetFor('overlay', { isARock: rulesBool(type, 'IsARock') });
    objects.push({
      kind: 'overlay',
      type,
      x,
      y,
      z: heightAt(x, y),
      sprite: id,
      frame,
      flat,
      drawOffset: off,
      lighting: tiberium ? 'none' : wall ? 'ambient' : 'full',
    });
    count(
      tiberium
        ? 'overlay:tiberium'
        : wall
          ? 'overlay:wall'
          : /BRDG|BRIDGE/i.test(type)
            ? 'overlay:bridge'
            : 'overlay:other',
    );
  }

  // Buildings ------------------------------------------------------------------
  const voxelTypes = new Set<string>();
  const building = (e: { owner: string; type: string; fields: readonly string[] }): void => {
    const x = Number.parseInt(e.fields[3] ?? '', 10);
    const y = Number.parseInt(e.fields[4] ?? '', 10);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    const { sec, image } = artOf(e.type);
    const foundation = parseFoundation(sec?.getString('Foundation', '1x1'));
    const id = `building:${e.type}`;
    const newTheater = secBool(sec, 'NewTheater');
    const layerIds: string[] = [];
    const underIds: string[] = [];
    if (!sprites.has(id)) {
      for (const key of ['ActiveAnim', 'ActiveAnimTwo', 'ActiveAnimThree', 'ActiveAnimFour']) {
        const anim = sec?.getString(key, '').trim();
        if (!anim) continue;
        const animSec = art.getSection(anim);
        const animImage = animSec?.getString('Image', '').trim() || anim;
        const lid = `anim:${anim}`;
        // Renderers draw one still frame per layer, so only that frame is exported (a looping anim such as
        // CAMOV01_A has 31 body frames); the loop range is recorded for later animation.
        const artInt = (key: string): number | undefined => {
          const v = Number.parseInt(animSec?.getString(key, '') ?? '', 10);
          return Number.isFinite(v) ? v : undefined;
        };
        const loopArt = { start: artInt('Start'), loopStart: artInt('LoopStart'), loopEnd: artInt('LoopEnd') };
        const layer = addShp(lid, shpCandidates(animImage, animSec, newTheater), 'unit', true, {}, (body) => [
          animStillFrame(loopArt, body),
        ]);
        if (layer) {
          const ls = loopArt.loopStart ?? loopArt.start;
          if (ls !== undefined && loopArt.loopEnd !== undefined) layer.entry.loop = [ls, loopArt.loopEnd];
          layerIds.push(lid);
        }
      }
      const bib = sec?.getString('BibShape', '').trim();
      if (bib) {
        const bid = `bib:${bib}`;
        if (addShp(bid, shpCandidates(bib, art.getSection(bib), newTheater), 'unit', true)) underIds.push(bid);
      }
    }
    // Art Remapable=no (civilian flags, some tech buildings) keeps palette indices 16..31 unremapped.
    const remapable = secBool(sec, 'Remapable', true);
    const s = addShp(id, shpCandidates(image, sec), customPalette(sec) ?? 'unit', remapable, {
      foundation,
      ...(layerIds.length ? { layers: layerIds } : {}),
      ...(underIds.length ? { underlays: underIds } : {}),
    });
    if (!s) return;
    const health = Number.parseInt(e.fields[2] ?? '256', 10);
    const facing = Number.parseInt(e.fields[5] ?? '0', 10);
    const hp = Number.isFinite(health) ? health : 256;
    houseColor(e.owner);
    objects.push({
      kind: 'building',
      type: e.type,
      x,
      y,
      z: heightAt(x, y),
      owner: e.owner,
      facing: Number.isFinite(facing) ? facing : 0,
      sprite: id,
      frame: buildingConditionFrame(hp, conditionYellow, s.frames.length),
      health: hp,
      drawOffset: drawOffsetFor('building'),
      lighting: 'ambient',
    });
    count('building');
  };
  for (const e of map.structures) building(e);

  // Units / aircraft / infantry ---------------------------------------------------------
  const techno = (kind: MapObjectKind, e: { owner: string; type: string; fields: readonly string[] }): void => {
    const x = Number.parseInt(e.fields[3] ?? '', 10);
    const y = Number.parseInt(e.fields[4] ?? '', 10);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    const { sec, image } = artOf(e.type);
    const facingField = kind === 'infantry' ? 7 : 5;
    const facing = Number.parseInt(e.fields[facingField] ?? '0', 10) || 0;
    const health = Number.parseInt(e.fields[2] ?? '256', 10);
    houseColor(e.owner);
    const base: MapObject = {
      kind,
      type: e.type,
      x,
      y,
      z: heightAt(x, y),
      owner: e.owner,
      facing,
      health: Number.isFinite(health) ? health : 256,
      drawOffset: cellCentre,
      lighting: 'ambient',
    };
    if (kind !== 'infantry' && secBool(sec, 'Voxel')) {
      voxelTypes.add(e.type.toUpperCase());
      objects.push({ ...base, voxel: e.type.toUpperCase() });
      count(`${kind}:voxel`);
      return;
    }
    const id = `${kind}:${e.type}`;
    const s = addShp(id, shpCandidates(image, sec), 'unit', true);
    if (!s) return;
    let frame = 0;
    if (kind === 'infantry') {
      const sub = Number.parseInt(e.fields[5] ?? '0', 10) || 0;
      base.subCell = sub;
      const [lx, ly] = SUBCELL_LEPTONS[sub] ?? SUBCELL_LEPTONS[0]!;
      const d = leptonDelta(lx, ly);
      base.drawOffset = [Math.round(d.sx), Math.round(d.sy)];
      const seqName = sec?.getString('Sequence', '').trim();
      const ready = parseSequenceEntry(seqName ? art.getSection(seqName)?.getString('Ready', '') : undefined) ?? {
        start: 0,
        count: 1,
        facingMultiplier: 1,
      };
      frame = ready.start + facingFrame(facing, 8) * ready.facingMultiplier;
    } else {
      const facings = Number.parseInt(sec?.getString('Facings', '8') ?? '8', 10) || 8;
      frame = facingFrame(facing, facings);
    }
    if (frame >= s.frames.length) frame = 0;
    objects.push({ ...base, sprite: id, frame });
    count(kind);
  };
  for (const e of map.units) techno('vehicle', e);
  for (const e of map.aircraft) techno('aircraft', e);
  for (const e of map.infantry) techno('infantry', e);

  // Voxels ----------------------------------------------------------------------------
  for (const t of opts.defaultVoxels ?? DEFAULT_VOXELS) voxelTypes.add(t.toUpperCase());
  const voxelModels = new Map<string, VoxelModel>();
  for (const type of [...voxelTypes].sort()) {
    const model = buildVoxelModel(type, artOf(type), rulesBool(type, 'Turret'), inst, warn);
    if (model) {
      voxelModels.set(type, model);
      count('voxel');
    }
  }

  // Movable SHP art (infantry, SHP vehicles, aircraft) keeps only the frames the map's objects use: an infantry SHP
  // holds hundreds of walk/fire/die frames (DNOB alone filled most of an 8192-wide atlas on CrctBrd), while a static
  // map needs one standing frame per facing. `sourceFrames` records the original indices.
  for (const [sid, s] of sprites) {
    if (!/^(infantry|vehicle|aircraft):/.test(sid) || s.entry.sourceFrames) continue;
    const users = objects.filter((o) => o.sprite === sid);
    const used = [...new Set(users.map((o) => o.frame ?? 0))].sort((a, b) => a - b);
    const index = new Map(used.map((f, i) => [f, i]));
    s.frames = used.map((f) => s.frames[f]!);
    if (s.shadows) s.shadows = used.map((f) => s.shadows![f]!);
    s.entry.sourceFrames = used;
    for (const o of users) o.frame = index.get(o.frame ?? 0)!;
  }

  // ---------------------------------------------------------------- write output
  const outDir = join(opts.outDir, loaded.id);
  mkdirSync(join(outDir, 'voxels'), { recursive: true });
  mkdirSync(join(outDir, 'palettes'), { recursive: true });

  const terrainAtlas: AtlasRef = { file: 'terrain.png', width: terrainPack.width, height: terrainPack.height };
  writeFileSync(
    join(outDir, terrainAtlas.file),
    encodePng({ width: terrainPack.width, height: terrainPack.height, channels: 4, data: terrainRgba }),
  );

  // Sprite atlas: body + shadow frames of every sprite, R = palette index, A = 255 where index != 0.
  const spriteIds = [...sprites.keys()].sort();
  const allFrames: PendingFrame[] = [];
  for (const sid of spriteIds) {
    const s = sprites.get(sid)!;
    allFrames.push(...s.frames, ...(s.shadows ?? []));
  }
  const nonEmpty = allFrames.filter((f) => f.w > 0 && f.h > 0);
  const spritePack = packShelves(
    nonEmpty.map((f) => ({ w: f.w, h: f.h })),
    1,
  );
  const rectOf = new Map<PendingFrame, [number, number, number, number]>();
  nonEmpty.forEach((f, i) => {
    const r = spritePack.rects[i]!;
    rectOf.set(f, [r.x, r.y, r.w, r.h]);
  });
  const spriteRgba = new Uint8Array(spritePack.width * spritePack.height * 4);
  for (const f of nonEmpty) {
    const [rx, ry] = rectOf.get(f)!;
    for (let py = 0; py < f.h; py++) {
      for (let px = 0; px < f.w; px++) {
        const v = f.pixels[py * f.w + px]!;
        if (!v) continue;
        const d = ((ry + py) * spritePack.width + rx + px) * 4;
        spriteRgba[d] = v;
        spriteRgba[d + 3] = 255;
      }
    }
  }
  const spriteAtlas: AtlasRef = { file: 'sprites.png', width: spritePack.width, height: spritePack.height };
  writeFileSync(
    join(outDir, spriteAtlas.file),
    encodePng({ width: spritePack.width, height: spritePack.height, channels: 4, data: spriteRgba }),
  );

  const toFrame = (f: PendingFrame): SpriteFrame => ({ rect: rectOf.get(f) ?? [0, 0, 0, 0], offset: f.offset });
  const spriteEntries: Record<string, SpriteEntry> = {};
  for (const sid of spriteIds) {
    const s = sprites.get(sid)!;
    spriteEntries[sid] = {
      ...s.entry,
      frames: s.frames.map(toFrame),
      ...(s.shadows ? { shadows: s.shadows.map(toFrame) } : {}),
    } as SpriteEntry;
  }

  const palettes: Record<string, string> = {};
  const paletteSources: Record<string, string> = {};
  for (const key of [...usedPalettes].sort()) {
    const src = paletteFiles[key];
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

  const voxels: Record<string, string> = {};
  for (const [type, model] of voxelModels) {
    const file = `voxels/${type}.json`;
    writeFileSync(join(outDir, file), JSON.stringify(model));
    voxels[type] = file;
  }

  const local = map.localSize;
  const lightSec = mapIni.getSection('Lighting');
  const lightNum = (key: string, fallback: number): number => {
    const v = Number.parseFloat(lightSec?.getString(key, '') ?? '');
    return Number.isFinite(v) ? v : fallback;
  };
  const lighting: MapLighting = {
    ambient: lightNum('Ambient', 1),
    red: lightNum('Red', 1),
    green: lightNum('Green', 1),
    blue: lightNum('Blue', 1),
    ground: lightNum('Ground', 0),
    level: lightNum('Level', DEFAULT_LIGHT_LEVEL),
  };
  // Playable screen rectangle (engine camera limits), see localScreenRect.
  let visibleRect: HdCacheManifest['visibleRect'];
  if (size && local) {
    const cutoff = cutoffTileHeight(
      size,
      isoTiles.filter((t) => t.x >= 0 && t.y >= 0),
    );
    visibleRect = localScreenRect(size, local, cutoff);
    counts['cutoffHeight'] = cutoff;
  }
  counts['tiles'] = tiles.length;
  counts['cells'] = isoTiles.length;
  counts['cellsFilled'] = filled;
  counts['clearSubstituted'] = substituted;
  counts['sprites'] = spriteIds.length;
  const manifest: HdCacheManifest = {
    version: HD_CACHE_VERSION,
    name: loaded.name,
    source: loaded.source,
    theater: theaterId,
    grid: { width: gridW, height: gridH },
    ...(local ? { localSize: { x: local.x, y: local.y, width: local.width, height: local.height } } : {}),
    ...(size ? { mapSize: { width: size.width, height: size.height } } : {}),
    ...(visibleRect ? { visibleRect } : {}),
    cells: { exists: b64(exists), height: b64(heights), tile: b64(new Uint8Array(tileIdx.buffer)) },
    tiles,
    terrainAtlas,
    spriteAtlas,
    palettes,
    sprites: spriteEntries,
    voxels,
    objects,
    waypoints: map.waypoints.map((w) => ({ id: w.number, x: w.x, y: w.y })),
    houses,
    paletteSources,
    lighting,
    extractor: { tool: 'ra2-assets extract', counts, warnings },
  };
  writeFileSync(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 1));
  for (const w of warnings) log(`warning: ${w}`);
  return { mapId: loaded.id, dir: outDir, manifest };
}

function decodeShp(shp: ShpFile): { x: number; y: number; cx: number; cy: number; pixels: Uint8Array }[] {
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

function buildVoxelModel(
  type: string,
  artInfo: { sec: IniSection | undefined; image: string },
  hasTurret: boolean,
  inst: GameInstall,
  warn: (m: string) => void,
): VoxelModel | undefined {
  const stem = artInfo.image.toLowerCase();
  const parts: VoxelPart[] = [];
  let normalsMode = 4;
  const roles: [VoxelPart['role'], string, boolean][] = [
    ['body', stem, true],
    ['turret', `${stem}tur`, hasTurret],
    ['barrel', `${stem}barl`, hasTurret],
  ];
  for (const [role, name, wanted] of roles) {
    if (!wanted) continue;
    let vxl: VxlFile | undefined;
    try {
      vxl = inst.vxl(`${name}.vxl`);
    } catch (err) {
      warn(`voxel ${type}: ${name}.vxl unreadable (${(err as Error).message})`);
      continue;
    }
    if (!vxl) {
      if (role === 'body') warn(`voxel ${type}: ${name}.vxl missing`);
      continue;
    }
    let hva;
    try {
      hva = inst.hva(`${name}.hva`);
    } catch {
      hva = undefined;
    }
    if (!hva) warn(`voxel ${type}: ${name}.hva missing, using the VXL section transforms`);
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
      normalsMode = s.normalsMode;
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
      };
    });
    parts.push({ role, sections });
  }
  if (!parts.length) return undefined;
  const turretOffset = Number.parseInt(artInfo.sec?.getString('TurretOffset', '0') ?? '0', 10) || 0;
  return { id: type, palette: 'unit', normalsMode, parts, file: `${stem}.vxl`, turretOffset };
}
