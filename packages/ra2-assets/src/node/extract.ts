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
import type { TmpFile } from 'ra2-formats';
import type {
  AtlasRef,
  HdCacheManifest,
  HouseColor,
  MapLighting,
  MapObject,
  MapObjectKind,
  TileEntry,
  VoxelModel,
} from '../manifest.ts';
import { HD_CACHE_VERSION } from '../manifest.ts';
import { packShelves } from '../atlas.ts';
import {
  animStillFrame,
  BUILDING_ACTIVE_ANIM_KEYS,
  buildingConditionFrame,
  facingFrame,
  parseFoundation,
  parseIniFraction,
  parseSequenceEntry,
} from '../art.ts';
import {
  cutoffTileHeight,
  DEFAULT_LIGHT_LEVEL,
  drawOffsetFor,
  highBridgeCell,
  leptonDelta,
  localScreenRect,
  mapSizeCells,
  mergeTileExtra,
  SUBCELL_LEPTONS,
  tileAnchor,
} from '../iso.ts';
import { parseHsv, remapRamp } from '../remap.ts';
import { THEATERS, buildTileTable, resolveCellTile, theaterFromMap, type TemplateShape } from '../theater.ts';
import {
  ArtSource,
  b64,
  buildVoxelModel,
  packSprites,
  secBool,
  SpriteCollector,
  unitVoxelParts,
  writePalettes,
} from './artSource.ts';
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

  const control = inst.ini(theater.controlIni);
  const mapIni = map.ini;
  // Rules values: the map's own sections override rulesmd (as the engine merges scenario INIs).
  const src = new ArtSource(inst, theater, warn, [mapIni]);
  const { rules, art } = src;
  const rulesBool = (id: string, key: string, fallback = false): boolean => src.rulesBool(id, key, fallback);
  const artOf = (id: string) => src.artOf(id);
  const shpCandidates = src.shpCandidates.bind(src);

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
  const collector = new SpriteCollector(inst, warn, ['iso', 'unit']);
  const sprites = collector.sprites;
  const addShp = collector.addShp.bind(collector);

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
  // Engine draw points (see drawOffsetFor and overlayDrawOffset): smudges, buildings and tiberium trees put their
  // canvas centre on the cell's top corner; terrain objects and movable objects on the cell centre (or their coord);
  // overlays on the cell centre moved by their type's rule.
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
    const { candidates, palette, remap, flat, drawOffset, lighting } = src.smudgeArt(type);
    const id = `smudge:${type}`;
    const s = addShp(id, candidates, palette, remap);
    if (!s) continue;
    objects.push({
      kind: 'smudge',
      type,
      x,
      y,
      z: heightAt(x, y),
      sprite: id,
      frame: 0,
      flat,
      drawOffset,
      lighting,
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
    const art = src.overlayArt(type);
    // Map files do not supply the live carrier's source building type; never substitute the overlay's Image.
    if (art.rubble) continue;
    const { wall, tiberium } = art;
    const id = `overlay:${type}`;
    const s = addShp(id, art.candidates, art.palette, art.remap);
    if (!s) continue;
    // A bridge-owner cell picks its deck variant and its rise from OverlayData and the cell (iso.ts highBridgeCell).
    const data = od[i]!;
    const bridge = art.highBridge ? highBridgeCell(data, x, y) : undefined;
    let frame = bridge?.frame ?? data;
    if (frame >= s.frames.length) {
      warn(`${id}: OverlayData ${data} beyond ${s.frames.length} body frames (clamped)`);
      frame = s.frames.length - 1;
    }
    objects.push({
      kind: 'overlay',
      type,
      x,
      y,
      z: heightAt(x, y),
      sprite: id,
      frame,
      flat: art.flat,
      drawOffset: bridge ? [art.drawOffset[0], art.drawOffset[1] - bridge.lift] : art.drawOffset,
      lighting: art.lighting,
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
    const layerIds: string[] = [];
    const underIds: string[] = [];
    if (!sprites.has(id)) {
      for (const key of BUILDING_ACTIVE_ANIM_KEYS) {
        const anim = sec?.getString(key, '').trim();
        if (!anim) continue;
        const a = src.animArt(anim);
        const lid = `anim:${anim}`;
        // Renderers draw one still frame per layer, so only that frame is exported (a looping anim such as
        // CAMOV01_A has 31 body frames); the loop range is recorded for later animation.
        const layer = addShp(lid, a.candidates, 'unit', true, {}, (body) => [animStillFrame(a.timing, body)]);
        if (layer) {
          const ls = a.timing.loopStart ?? a.timing.start;
          if (ls !== undefined && a.timing.loopEnd !== undefined) layer.entry.loop = [ls, a.timing.loopEnd];
          layerIds.push(lid);
        }
      }
      const bib = sec?.getString('BibShape', '').trim();
      if (bib) {
        const bid = `bib:${bib}`;
        if (addShp(bid, src.animArt(bib).candidates, 'unit', true)) underIds.push(bid);
      }
    }
    // Art Remapable=no (civilian flags, some tech buildings) keeps palette indices 16..31 unremapped.
    const remapable = secBool(sec, 'Remapable', true);
    const s = addShp(id, shpCandidates(image, sec), src.customPalette(sec) ?? 'unit', remapable, {
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
    const { sec, image } = kind === 'infantry' ? src.infantryArtOf(e.type) : artOf(e.type);
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
    const s = addShp(id, shpCandidates(image, sec), 'unit', true, {}, undefined, kind === 'infantry' ? 12 : undefined);
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
    const { sec, image } = artOf(type);
    const turretOffset = Number.parseInt(sec?.getString('TurretOffset', '0') ?? '0', 10) || 0;
    const model = buildVoxelModel(type, unitVoxelParts(image, rulesBool(type, 'Turret')), turretOffset, inst, warn);
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

  const terrainAtlas: AtlasRef = { file: 'terrain.png', width: terrainPack.width, height: terrainPack.height };
  writeFileSync(
    join(outDir, terrainAtlas.file),
    encodePng({ width: terrainPack.width, height: terrainPack.height, channels: 4, data: terrainRgba }),
  );

  // Sprite atlas: body + shadow frames of every sprite, R = palette index, A = 255 where index != 0.
  const packed = packSprites(sprites, { format: 'rgba' });
  const page = packed.pages[0]!;
  const spriteAtlas: AtlasRef = { file: 'sprites.png', width: page.width, height: page.height };
  writeFileSync(
    join(outDir, spriteAtlas.file),
    encodePng({ width: page.width, height: page.height, channels: 4, data: page.data }),
  );
  const spriteEntries = packed.entries;
  const spriteIds = Object.keys(spriteEntries);

  const { palettes, paletteSources } = writePalettes(inst, outDir, collector.usedPalettes, src.paletteFiles, warn);

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
