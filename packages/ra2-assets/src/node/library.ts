/**
 * Type library extraction (Node only): art for every TechnoType of the game, per theater, so an HD renderer can draw
 * any object a live match reports (see ../library.ts for the contract and layout). Reads only the player's own
 * install; everything written is derived game data and belongs in the gitignored gameres/hd-cache/_library/.
 *
 * Type lists: rulesmd.ini [BuildingTypes], [VehicleTypes], [InfantryTypes], [AircraftTypes] (values in file order,
 * duplicates dropped). Art resolution, palettes and voxel models go through artSource.ts, the same code the map
 * extractor uses. Differences from the map cache, all deliberate:
 *   - every body/anim frame is exported (no still-frame or used-frame trimming);
 *   - art Remapable= is honoured for infantry and vehicles too (animals such as DNOA/DNOB/ALL/CAML set it to no);
 *   - building layers cover every anim key in BUILDING_LAYER_KEYS, with their damaged variants, and the buildup anim.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { VoxelModel } from '../manifest.ts';
import {
  BUILDING_LAYER_KEYS,
  buildingLayerArt,
  parseFoundation,
  parseInfantrySequences,
  parseIniFraction,
  resolveArtFile,
} from '../art.ts';
import { coordDrawOffset } from '../iso.ts';
import {
  LIBRARY_ATLAS_MAX,
  TYPE_LIBRARY_VERSION,
  type ColorSchemeEntry,
  type LibraryAnimLayer,
  type LibraryBuilding,
  type LibraryKind,
  type LibraryType,
  type TypeLibrary,
} from '../library.ts';
import { colorSchemeSlots, remapRamp } from '../remap.ts';
import { THEATERS, type TheaterId } from '../theater.ts';
import {
  ArtSource,
  buildVoxelModel,
  packSprites,
  secBool,
  secInt,
  SpriteCollector,
  unitVoxelParts,
  writePalettes,
  type InstallView,
  type PaletteKey,
  type VoxelPartSpec,
} from './artSource.ts';
import { GameInstall } from './install.ts';
import { encodePng } from './png.ts';

export const ALL_THEATERS: readonly TheaterId[] = ['temperate', 'snow', 'urban', 'newurban', 'desert', 'lunar'];

export interface LibraryOptions {
  gameDir: string;
  /** Library root (default <repo>/gameres/hd-cache/_library in the CLI). */
  outDir: string;
  theaters?: readonly TheaterId[];
  log?: (msg: string) => void;
}

export interface LibraryResult {
  theater: TheaterId;
  dir: string;
  library: TypeLibrary;
  /** Bytes written under the theater directory (library.json, atlas pages, palettes). */
  bytes: number;
  ms: number;
}

/** Type-list sections of rulesmd.ini and the kind each yields. */
const TYPE_LISTS: readonly [LibraryKind, string][] = [
  ['building', 'BuildingTypes'],
  ['vehicle', 'VehicleTypes'],
  ['infantry', 'InfantryTypes'],
  ['aircraft', 'AircraftTypes'],
];

/** Art frame-layout keys of TS-style SHP vehicles/aircraft, recorded raw in LibraryShpUnit.frames. */
const SHP_UNIT_FRAME_KEYS = [
  'StartStandFrame',
  'StandingFrames',
  'StartWalkFrame',
  'WalkFrames',
  'StartFiringFrame',
  'FiringFrames',
  'StartDeathFrame',
  'DeathFrames',
  'FiringSyncFrame0',
  'FiringSyncFrame1',
];

export function extractLibrary(opts: LibraryOptions): LibraryResult[] {
  const log = opts.log ?? ((m: string) => console.log(m));
  const theaters = opts.theaters?.length ? opts.theaters : ALL_THEATERS;
  const commonVoxels = new Map<string, string>();
  return theaters.map((t) => extractTheater(t, opts, log, commonVoxels));
}

/** Everything a theater's library holds before atlas packing and file output. */
export interface CollectedLibrary {
  src: ArtSource;
  collector: SpriteCollector;
  types: Record<string, LibraryType>;
  voxelModels: Map<string, VoxelModel>;
  colorSchemes: ColorSchemeEntry[];
  colorSchemesByName: Record<string, number>;
  conditionYellow: number;
  conditionRed: number;
  counts: Record<string, number>;
  warnings: string[];
}

function extractTheater(
  theaterId: TheaterId,
  opts: LibraryOptions,
  log: (m: string) => void,
  /** Voxel JSON already written to _library/common in this run, by voxel id. */
  commonVoxels: Map<string, string>,
): LibraryResult {
  const t0 = Date.now();
  const inst = GameInstall.open(opts.gameDir, theaterId);
  const lib = collectTypeLibrary(inst, theaterId);
  return writeTypeLibrary(inst, theaterId, lib, opts.outDir, commonVoxels, log, t0);
}

/**
 * Resolve every TechnoType of `theaterId` against an install: type records, pending sprites (all frames), voxel models
 * and colour schemes. No I/O besides reading the install.
 */
export function collectTypeLibrary(inst: InstallView, theaterId: TheaterId): CollectedLibrary {
  const theater = THEATERS[theaterId];
  const warnings: string[] = [];
  const warn = (m: string): void => {
    if (!warnings.includes(m)) warnings.push(m);
  };
  const src = new ArtSource(inst, theater, warn);
  const { rules, art } = src;
  const collector = new SpriteCollector(inst, warn, ['unit']);
  const has = (n: string): boolean => inst.has(n);

  const counts: Record<string, number> = {};
  const count = (k: string, n = 1): void => {
    counts[k] = (counts[k] ?? 0) + n;
  };
  const types: Record<string, LibraryType> = {};
  const voxelModels = new Map<string, VoxelModel>();
  /** Skip a type with one warning naming the reason. */
  const skip = (kind: LibraryKind, id: string, reason: string): void => {
    warn(`${kind} ${id}: skipped, ${reason}`);
    count(`skipped:${kind}`);
  };
  /** Add a SHP when one of `candidates` exists; otherwise return undefined without a warning. */
  const tryShp = (
    id: string,
    candidates: string[],
    palette: PaletteKey,
    remap: boolean,
  ): ReturnType<SpriteCollector['addShp']> =>
    resolveArtFile(candidates, has) ? collector.addShp(id, candidates, palette, remap) : undefined;
  const voxelOf = (id: string, specs: VoxelPartSpec[], turretOffset: number): string | undefined => {
    if (voxelModels.has(id)) return id;
    const model = buildVoxelModel(id, specs, turretOffset, inst, warn);
    if (!model) return undefined;
    voxelModels.set(id, model);
    return id;
  };
  /** Voxel model of a rules vehicle/aircraft type keyed by its id (body + tur/barl for Turret=yes). */
  const unitVoxel = (id: string): string | undefined => {
    const { sec, image } = src.artOf(id);
    const turretOffset = Number.parseInt(sec?.getString('TurretOffset', '0') ?? '0', 10) || 0;
    return voxelOf(id, unitVoxelParts(image, src.rulesBool(id, 'Turret')), turretOffset);
  };

  // ---------------------------------------------------------------- buildings
  const building = (id: string): LibraryType | undefined => {
    const { sec, image, section } = src.artOf(id);
    const candidates = src.shpCandidates(image, sec);
    if (!resolveArtFile(candidates, has)) {
      skip('building', id, `no art file (${candidates.join(', ')})${sec ? '' : `, no art section ${section}`}`);
      return undefined;
    }
    // art TerrainPalette=yes (lamp posts, CITY06) is recorded but not applied: rendered with iso<th>.pal the lamp
    // gglite.shp turns into green/orange noise while unit<th>.pal gives a clean white lamp on a brown post.
    const terrainPalette = secBool(sec, 'TerrainPalette');
    const palette = src.customPalette(sec) ?? 'unit';
    const remap = secBool(sec, 'Remapable', true);
    const spriteId = `building:${section}`;
    const body = collector.addShp(spriteId, candidates, palette, remap);
    if (!body) {
      skip('building', id, `unreadable art ${candidates[0]}`);
      return undefined;
    }
    const layers: LibraryAnimLayer[] = [];
    const animSprite = (anim: string): string | undefined => {
      const a = src.animArt(anim);
      const lid = `anim:${anim}`;
      const s = collector.addShp(lid, a.candidates, 'unit', true);
      if (!s) return undefined;
      const ls = a.timing.loopStart ?? a.timing.start;
      if (ls !== undefined && a.timing.loopEnd !== undefined) s.entry.loop = [ls, a.timing.loopEnd];
      return lid;
    };
    for (const key of BUILDING_LAYER_KEYS) {
      const l = buildingLayerArt(sec, key);
      if (!l) continue;
      const sprite = animSprite(l.anim);
      if (!sprite) continue;
      const layer: LibraryAnimLayer = { key, sprite, anim: src.animArt(l.anim).timing };
      if (l.damaged) {
        const d = animSprite(l.damaged);
        if (d) layer.damagedSprite = d;
      }
      if (l.offset) layer.offset = l.offset;
      if (l.zAdjust !== undefined) layer.zAdjust = l.zAdjust;
      if (l.ySort !== undefined) layer.ySort = l.ySort;
      if (l.powered !== undefined) layer.powered = l.powered;
      layers.push(layer);
      count('layers');
    }
    const info: LibraryBuilding = { bodyFrames: body.frames.length, layers };
    const bib = sec?.getString('BibShape', '').trim();
    if (bib) {
      const bid = `bib:${bib}`;
      if (collector.addShp(bid, src.animArt(bib).candidates, 'unit', true)) info.bib = bid;
    }
    // Buildup: art Buildup= (NewTheater applies, e.g. GAPOWRMK -> gtpowrmk.shp), else <art section>MK when present.
    const buildupName = sec?.getString('Buildup', '').trim();
    for (const name of buildupName ? [buildupName] : [`${section}MK`]) {
      const a = src.animArt(name);
      const bid = `anim:${name}`;
      const s = buildupName
        ? collector.addShp(bid, a.candidates, palette, remap)
        : tryShp(bid, a.candidates, palette, remap);
      if (s) {
        info.buildup = bid;
        count('buildups');
      }
    }
    if (src.rulesBool(id, 'Turret') && src.rulesBool(id, 'TurretAnimIsVoxel')) {
      const anim = (src.rulesGet(id, 'TurretAnim') ?? '').trim();
      if (anim) {
        // Building turrets: TurretAnim.vxl is the turret; the barrel, when there is one, is <TurretAnim>barl or
        // <image>barl (only GTGCAN has one in YR: gtgcanbarl.vxl next to gtgcantur.vxl).
        const barrel = [`${anim}barl`, `${image}barl`].map((s) => s.toLowerCase()).find((s) => has(`${s}.vxl`));
        const specs: VoxelPartSpec[] = [{ role: 'turret', stem: anim.toLowerCase(), required: true }];
        if (barrel) specs.push({ role: 'barrel', stem: barrel, required: false });
        const vid = voxelOf(`${id}:turret`, specs, 0);
        if (vid) {
          info.turretVoxel = {
            voxel: vid,
            offset: [src.rulesInt(id, 'TurretAnimX') ?? 0, src.rulesInt(id, 'TurretAnimY') ?? 0],
            zAdjust: src.rulesInt(id, 'TurretAnimZAdjust') ?? 0,
          };
        }
      }
    }
    const height = secInt(sec, 'Height');
    if (height !== undefined) info.height = height;
    if (terrainPalette) info.terrainPalette = true;
    if (secBool(sec, 'AltPalette')) info.altPalette = true;
    if (secBool(sec, 'Flat')) info.flat = true;
    return {
      kind: 'building',
      image: section,
      sprite: spriteId,
      ...(src.rulesBool(id, 'Turret') ? { turret: true } : {}),
      foundation: parseFoundation(sec?.getString('Foundation', '1x1')),
      drawOffset: coordDrawOffset('building'),
      lighting: 'ambient',
      remap,
      building: info,
    };
  };

  // ---------------------------------------------------------------- infantry
  const infantry = (id: string): LibraryType | undefined => {
    const { sec, image, section } = src.artOf(id);
    const candidates = src.shpCandidates(image, sec);
    if (!resolveArtFile(candidates, has)) {
      skip('infantry', id, `no art file (${candidates.join(', ')})`);
      return undefined;
    }
    const remap = secBool(sec, 'Remapable', true);
    const spriteId = `infantry:${section}`;
    const s = collector.addShp(spriteId, candidates, 'unit', remap);
    if (!s) {
      skip('infantry', id, `unreadable art ${candidates[0]}`);
      return undefined;
    }
    const sequenceName = sec?.getString('Sequence', '').trim() ?? '';
    const seqSec = sequenceName ? art.getSection(sequenceName) : undefined;
    const sequences = parseInfantrySequences(seqSec?.entries ?? []);
    if (!seqSec) warn(`infantry ${id}: no Sequence section${sequenceName ? ` [${sequenceName}]` : ''}`);
    // Sequences whose last frame (8 facings) falls outside the SHP point at art the engine never draws or at
    // placeholder entries (stock Die3..5=0,1,1 style defaults are fine); list them for the renderer author.
    const frames = s.frames.length;
    const beyond = Object.entries(sequences)
      .filter(([, q]) => q.start + 7 * q.facingMultiplier + q.count > frames)
      .map(([k]) => k);
    if (beyond.length) warn(`infantry ${id}: sequences beyond its ${frames} frames: ${beyond.join(', ')}`);
    return {
      kind: 'infantry',
      image: section,
      sprite: spriteId,
      drawOffset: coordDrawOffset('infantry'),
      lighting: 'ambient',
      remap,
      infantry: {
        sequenceName,
        sequences,
        ...(sec?.has('Crawls') ? { crawls: secBool(sec, 'Crawls', true) } : {}),
        ...(secInt(sec, 'FireUp') !== undefined ? { fireUp: secInt(sec, 'FireUp')! } : {}),
      },
    };
  };

  // ---------------------------------------------------------------- vehicles and aircraft
  const unit = (kind: 'vehicle' | 'aircraft', id: string): LibraryType | undefined => {
    const { sec, image, section } = src.artOf(id);
    const remap = secBool(sec, 'Remapable', true);
    const base = { kind, image: section, drawOffset: coordDrawOffset(kind), lighting: 'ambient' as const, remap };
    let type: LibraryType;
    if (secBool(sec, 'Voxel')) {
      const voxel = unitVoxel(id);
      if (!voxel) {
        skip(kind, id, `voxel ${image.toLowerCase()}.vxl did not load`);
        return undefined;
      }
      type = { ...base, voxel, ...(src.rulesBool(id, 'Turret') ? { turret: true } : {}) };
      count(`${kind}:voxel`);
    } else {
      const candidates = src.shpCandidates(image, sec);
      if (!resolveArtFile(candidates, has)) {
        skip(kind, id, `no voxel art and no SHP (${candidates.join(', ')})${sec ? '' : `, no art section ${section}`}`);
        return undefined;
      }
      const spriteId = `${kind}:${section}`;
      if (!collector.addShp(spriteId, candidates, 'unit', remap)) {
        skip(kind, id, `unreadable art ${candidates[0]}`);
        return undefined;
      }
      const frames: Record<string, number> = {};
      for (const k of SHP_UNIT_FRAME_KEYS) {
        const v = secInt(sec, k);
        if (v !== undefined) frames[k] = v;
      }
      type = { ...base, sprite: spriteId, shpUnit: { facings: secInt(sec, 'Facings') ?? 8, frames } };
      count(`${kind}:shp`);
    }
    const unloading = (src.rulesGet(id, 'UnloadingClass') ?? '').trim();
    if (unloading) {
      const v = unitVoxel(unloading);
      if (v) type.unloadingVoxel = v;
      else warn(`${kind} ${id}: UnloadingClass ${unloading} has no voxel model`);
    }
    const deploying = (src.rulesGet(id, 'DeployingAnim') ?? '').trim();
    if (deploying) {
      const a = src.animArt(deploying);
      if (collector.addShp(`anim:${deploying}`, a.candidates, 'unit', remap)) type.deployingAnim = `anim:${deploying}`;
    }
    return type;
  };

  for (const [kind, list] of TYPE_LISTS) {
    const ids = [
      ...new Set(
        rules
          .readRegistry(list)
          .map((v) => v.trim())
          .filter(Boolean),
      ),
    ];
    count(`listed:${kind}`, ids.length);
    for (const id of ids) {
      if (types[id]) {
        warn(`${kind} ${id}: already listed as ${types[id]!.kind}, kept the first`);
        continue;
      }
      const t = kind === 'building' ? building(id) : kind === 'infantry' ? infantry(id) : unit(kind, id);
      if (!t) continue;
      if (src.rulesBool(id, 'InvisibleInGame')) t.invisible = true;
      types[id] = t;
      count(`types:${kind}`);
    }
  }

  // ---------------------------------------------------------------- colour schemes
  const unitPal = inst.palette(theater.unitPalette).rgb;
  const colorSchemes: ColorSchemeEntry[] = colorSchemeSlots(rules.getSection('Colors')?.entries ?? []).map((s) => ({
    ...s,
    remap: remapRamp(unitPal, s.hsv),
  }));
  const colorSchemesByName: Record<string, number> = {};
  colorSchemes.forEach((c, i) => {
    if (c.copy === 1) colorSchemesByName[c.name] = i;
  });
  if (!colorSchemes.length) warn('rules [Colors] is empty: no colour schemes');

  const av = rules.getSection('AudioVisual');
  return {
    src,
    collector,
    types,
    voxelModels,
    colorSchemes,
    colorSchemesByName,
    conditionYellow: parseIniFraction(av?.getString('ConditionYellow', ''), 0.5),
    conditionRed: parseIniFraction(av?.getString('ConditionRed', ''), 0.25),
    counts,
    warnings,
  };
}

/** Pack, write and describe one theater's library under `outDir/<theater>` (voxels shared in `outDir/common`). */
function writeTypeLibrary(
  inst: InstallView,
  theaterId: TheaterId,
  lib: CollectedLibrary,
  outDir: string,
  commonVoxels: Map<string, string>,
  log: (m: string) => void,
  t0: number,
): LibraryResult {
  const { src, collector, types, voxelModels, counts, warnings } = lib;
  const warn = (m: string): void => {
    if (!warnings.includes(m)) warnings.push(m);
  };
  const dir = join(outDir, theaterId);
  mkdirSync(dir, { recursive: true });
  for (const f of readdirSync(dir)) if (/^sprites-\d+\.png$/.test(f)) rmSync(join(dir, f));
  const packed = packSprites(collector.sprites, { format: 'indexed', maxPage: LIBRARY_ATLAS_MAX });
  const spriteAtlases = packed.pages.map((p, i) => {
    const file = `sprites-${i}.png`;
    writeFileSync(join(dir, file), encodePng({ width: p.width, height: p.height, channels: 1, data: p.data }));
    return { file, width: p.width, height: p.height };
  });
  const { palettes, paletteSources } = writePalettes(inst, dir, collector.usedPalettes, src.paletteFiles, warn);
  for (const t of Object.values(types)) {
    const ids = [t.sprite, t.deployingAnim, t.building?.bib, t.building?.buildup];
    for (const l of t.building?.layers ?? []) ids.push(l.sprite, l.damagedSprite);
    const pages = new Set<number>();
    for (const id of ids) {
      const e = id ? packed.entries[id] : undefined;
      for (const f of [...(e?.frames ?? []), ...(e?.shadows ?? [])]) if (f.rect[2] > 0) pages.add(f.page ?? 0);
    }
    if (pages.size) t.atlasPages = [...pages].sort((a, b) => a - b);
  }

  // Voxel models are theater-independent; share them in _library/common unless this theater's mount differs.
  const voxels: Record<string, string> = {};
  const commonDir = join(outDir, 'common', 'voxels');
  mkdirSync(commonDir, { recursive: true });
  for (const [id, model] of [...voxelModels].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const json = JSON.stringify(model);
    const name = `${id.replace(/[^A-Za-z0-9_.-]/g, '_')}.json`;
    const shared = commonVoxels.get(id);
    if (shared === undefined || shared === json) {
      if (shared === undefined) {
        writeFileSync(join(commonDir, name), json);
        commonVoxels.set(id, json);
      }
      voxels[id] = `../common/voxels/${name}`;
    } else {
      mkdirSync(join(dir, 'voxels'), { recursive: true });
      writeFileSync(join(dir, 'voxels', name), json);
      voxels[id] = `voxels/${name}`;
      warn(`voxel ${id}: differs from the shared model on this theater, written to ${theaterId}/voxels`);
    }
  }

  counts['sprites'] = Object.keys(packed.entries).length;
  counts['frames'] = Object.values(packed.entries).reduce((n, e) => n + e.frames.length + (e.shadows?.length ?? 0), 0);
  counts['atlasPages'] = spriteAtlases.length;
  const perType = Object.values(types)
    .map((t) => t.atlasPages?.length ?? 0)
    .filter((n) => n > 0);
  counts['maxPagesPerType'] = Math.max(0, ...perType);
  counts['voxels'] = voxelModels.size;
  counts['colorSchemes'] = lib.colorSchemes.length;
  const library: TypeLibrary = {
    version: TYPE_LIBRARY_VERSION,
    theater: theaterId,
    palettes,
    paletteSources,
    spriteAtlases,
    sprites: packed.entries,
    voxels,
    types,
    colorSchemes: lib.colorSchemes,
    colorSchemesByName: lib.colorSchemesByName,
    conditionYellow: lib.conditionYellow,
    conditionRed: lib.conditionRed,
    extractor: { tool: 'ra2-assets library', counts, warnings },
  };
  writeFileSync(join(dir, 'library.json'), JSON.stringify(library, null, 1));
  const bytes = dirBytes(dir);
  log(
    `${theaterId}: ${Object.keys(types).length} types, ${counts['sprites']} sprites (${counts['frames']} frames) on ` +
      `${spriteAtlases.length} pages, ${voxelModels.size} voxels, ${warnings.length} warnings, ` +
      `${(bytes / 1048576).toFixed(1)} MiB (${Date.now() - t0} ms)`,
  );
  return { theater: theaterId, dir, library, bytes, ms: Date.now() - t0 };
}

/** Total size of the regular files under `dir` (recursive). */
export function dirBytes(dir: string): number {
  if (!existsSync(dir)) return 0;
  let n = 0;
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    const st = statSync(p);
    n += st.isDirectory() ? dirBytes(p) : st.size;
  }
  return n;
}

/** Read a library back (for the preview and tests of written output). */
export function readLibrary(dir: string): TypeLibrary {
  return JSON.parse(readFileSync(join(dir, 'library.json'), 'utf8')) as TypeLibrary;
}
