/**
 * Map light sidecars (Node only): reads a map's [Lighting], its light-source buildings and the rules/art they use from
 * the player's own install, and writes new files next to an existing HD cache:
 *   <map>/lights.json          MapLightsSidecar (../lights.ts)
 *   <map>/windows.png|.json    lit-window mask over sprites.png (--windows)
 *   <map>/lights-preview.png   surface classes, engine light at night, light and street lamp markers (--preview)
 *   <map>/windows-preview.png  contact sheet of building frames with every detected window outlined (--preview)
 *   _library/<th>/windows-<n>.png + windows.json   the same masks per type-library page (--library <theater>)
 * It never writes manifest.json or library.json: everything is a sidecar the renderer loads when present. All output
 * is derived game data and stays in the gitignored gameres/.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { IniFile } from 'ra2-formats';
import { parseFoundation } from '../art.ts';
import { projectCellCentre } from '../iso.ts';
import type { TypeLibrary } from '../library.ts';
import {
  MAP_LIGHTS_VERSION,
  SURFACE,
  engineCellLight,
  engineLightDelta,
  mapAtmosphere,
  nightEvidence,
  medianHeight,
  nightBaseAmbient,
  placeStreetLamps,
  readEngineLighting,
  readLightType,
  surfaceGrid,
  type InertLight,
  type LightType,
  type MapLightSource,
  type MapLightsSidecar,
} from '../lights.ts';
import type { HdCacheManifest, SpriteEntry, SpriteFrame } from '../manifest.ts';
import { theaterFromMap, type TheaterId } from '../theater.ts';
import { detectBuildingWindows, roofBottom, seededRandom, stringSeed, windowColumns, windowStats } from '../windows.ts';
import { GameInstall, loadMap } from './install.ts';
import { Sheet } from './libraryPreview.ts';
import { decodePng, encodePng, type PngImage } from './png.ts';
import { insideDiamond, terrainLayout } from './terrain.ts';

/** Theaters that get HD street lamps (the city theaters; lamp posts belong on city streets). */
export const STREET_LAMP_THEATERS: readonly string[] = ['urban', 'newurban'];
export const STREET_LAMP_SPACING = 4.5;
export const WINDOWS_VERSION = 2;

const DENY_FILE = resolve(dirname(fileURLToPath(import.meta.url)), '../../data/window-deny.json');

export interface MapLightsOptions {
  gameDir: string;
  /** Cache root containing <mapId>/manifest.json. */
  cacheDir: string;
  mapId: string;
  windows?: boolean;
  preview?: boolean;
  log?: (msg: string) => void;
}

export interface MapLightsResult {
  file: string;
  sidecar: MapLightsSidecar;
  written: string[];
}

export interface WindowsSidecar {
  version: typeof WINDOWS_VERSION;
  /** Library only: mask file per atlas page. */
  pages?: Record<string, string>;
  /**
   * Per building body frame with lit windows: lit pixels, their centroid and the lit-pane columns (windowColumns:
   * [centre x, panes, lowest lit y], frame-relative). `facade` marks frames lit by the large-pane profile.
   */
  frames: Record<
    string,
    Record<string, { lit: number; centroid: [number, number]; columns: [number, number, number][]; facade?: boolean }>
  >;
  /** Building types left dark (packages/ra2-assets/data/window-deny.json). */
  denied: string[];
}

function writeAtomic(file: string, data: string | Uint8Array): void {
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, data);
  renameSync(tmp, file);
}

function readDenyList(): string[] {
  if (!existsSync(DENY_FILE)) return [];
  const json = JSON.parse(readFileSync(DENY_FILE, 'utf8')) as { types?: string[] };
  return (json.types ?? []).map((t) => t.toUpperCase());
}

/** Rules lookups with the map's own sections overriding rulesmd.ini, as the engine merges scenario INIs. */
function rulesView(mapIni: IniFile, rules: IniFile, art: IniFile) {
  const get = (id: string, key: string): string | undefined => {
    for (const ini of [mapIni, rules]) {
      const sec = ini.getSection(id);
      if (sec?.has(key)) return sec.getString(key, '');
    }
    return undefined;
  };
  const artOf = (id: string): { image: string; foundation: [number, number] } => {
    const image = (get(id, 'Image') ?? '').trim() || id;
    const sec = art.getSection(image) ?? art.getSection(id);
    return { image: sec?.name ?? image, foundation: parseFoundation(sec?.getString('Foundation', '1x1')) };
  };
  return { get, artOf };
}

export function writeMapLights(opts: MapLightsOptions): MapLightsResult {
  const log = opts.log ?? ((m: string) => console.log(m));
  const mapDir = join(opts.cacheDir, opts.mapId);
  const manifestFile = join(mapDir, 'manifest.json');
  if (!existsSync(manifestFile)) throw new Error(`${manifestFile} not found: extract the map first (pnpm hd:prepare)`);
  const manifestBytes = readFileSync(manifestFile);
  const manifest = JSON.parse(manifestBytes.toString('utf8')) as HdCacheManifest;
  const warnings: string[] = [];
  const warn = (m: string) => {
    if (!warnings.includes(m)) warnings.push(m);
  };
  const theater = theaterFromMap(manifest.theater);
  if (!theater) throw new Error(`unsupported theater ${manifest.theater}`);
  const inst = GameInstall.open(opts.gameDir, theater);
  const loaded = loadMap(opts.gameDir, manifest.source);
  const mapIni = loaded.map.ini;
  const rules = inst.ini('rulesmd.ini');
  const art = inst.ini('artmd.ini');
  const view = rulesView(mapIni, rules, art);

  // ------------------------------------------------------------ light types (rules + the map's own sections)
  const buildingIds = new Set<string>();
  for (const ini of [rules, mapIni])
    for (const id of ini.readRegistry('BuildingTypes')) if (id.trim()) buildingIds.add(id.trim().toUpperCase());
  for (const e of loaded.map.structures) if (e.type) buildingIds.add(e.type.toUpperCase());
  const types: Record<string, LightType> = {};
  for (const id of [...buildingIds].sort()) {
    const t = readLightType((key) => view.get(id, key), view.artOf(id));
    if (t) types[id] = t;
  }

  // ------------------------------------------------------------ cells
  const W = manifest.grid.width;
  const H = manifest.grid.height;
  const exists = new Uint8Array(Buffer.from(manifest.cells.exists, 'base64'));
  const heights = new Uint8Array(Buffer.from(manifest.cells.height, 'base64'));
  const tileBytes = Buffer.from(manifest.cells.tile, 'base64');
  const tile = new Uint16Array(W * H);
  for (let i = 0; i < W * H; i++) tile[i] = tileBytes.readUInt16LE(i * 2);
  const heightAt = (x: number, y: number) => (x >= 0 && y >= 0 && x < W && y < H ? heights[y * W + x]! : 0);

  // ------------------------------------------------------------ light sources
  const used = new Set<number>();
  const lights: MapLightSource[] = [];
  loaded.map.structures.forEach((e, structureIndex) => {
    const type = e.type.toUpperCase();
    const t = types[type];
    const x = e.x;
    const y = e.y;
    if (!t || x === undefined || y === undefined) return;
    const z = heightAt(x, y);
    const [fw, fh] = t.foundation;
    const objectIndex = manifest.objects.findIndex(
      (o, i) => !used.has(i) && o.kind === 'building' && o.type.toUpperCase() === type && o.x === x && o.y === y,
    );
    if (objectIndex >= 0) used.add(objectIndex);
    else warn(`light ${type} at ${x},${y}: not among the manifest's objects`);
    lights.push({
      type,
      structureIndex,
      ...(objectIndex >= 0 ? { objectIndex } : {}),
      owner: e.owner,
      cell: [x, y],
      z,
      foundation: [fw, fh],
      position: [x * 256 + fw * 128, y * 256 + fh * 128, z * 104],
      radius: t.radius,
      intensity: t.intensity,
      tint: t.tint,
      invisible: t.invisible,
    });
  });
  // TerrainTypes also carry light keys (TIBTRE* ore trees), but YR creates no light source for them.
  const inertLights: InertLight[] = [];
  for (const t of loaded.map.terrainObjects) {
    const type = t.type.toUpperCase();
    const lt = readLightType((key) => view.get(type, key), view.artOf(type));
    if (!lt) continue;
    inertLights.push({
      type,
      cell: [t.x, t.y],
      z: heightAt(t.x, t.y),
      radius: lt.radius,
      intensity: lt.intensity,
      tint: lt.tint,
    });
  }
  const hiddenObjects: number[] = [];
  manifest.objects.forEach((o, i) => {
    if (/^\s*[yt1]/i.test(view.get(o.type.toUpperCase(), 'InvisibleInGame') ?? '')) hiddenObjects.push(i);
  });

  // ------------------------------------------------------------ surfaces, atmosphere
  const atlas = decodePng(readFileSync(join(mapDir, manifest.terrainAtlas.file)));
  const tileMean = (i: number): [number, number, number] | null => {
    const t = manifest.tiles[i];
    if (!t || atlas.channels !== 4) return null;
    let r = 0;
    let g = 0;
    let b = 0;
    let n = 0;
    const [rx, ry, rw, rh] = t.rect;
    for (let py = 0; py < rh; py++) {
      for (let px = 0; px < rw; px++) {
        if (!insideDiamond(px, py, t.anchor)) continue;
        const s = ((ry + py) * atlas.width + rx + px) * 4;
        if (atlas.data[s + 3]! < 128) continue;
        r += atlas.data[s]!;
        g += atlas.data[s + 1]!;
        b += atlas.data[s + 2]!;
        n++;
      }
    }
    return n ? [r / n, g / n, b / n] : null;
  };
  const surface = surfaceGrid({ width: W, height: H, exists, tile }, manifest.tiles, tileMean);
  const medianZ = medianHeight(heights, exists);
  const lighting = readEngineLighting((key) => {
    const sec = mapIni.getSection('Lighting');
    return sec?.has(key) ? sec.getString(key, '') : undefined;
  });
  const atmosphere = mapAtmosphere(lighting.normal, medianZ, nightEvidence(lights));

  // ------------------------------------------------------------ HD street lamps
  const streetLamps: MapLightsSidecar['hdEmitters']['streetLamps'] = [];
  if (STREET_LAMP_THEATERS.includes(manifest.theater)) {
    const blocked = new Uint8Array(W * H);
    const block = (x: number, y: number) => {
      if (x >= 0 && y >= 0 && x < W && y < H) blocked[y * W + x] = 1;
    };
    manifest.objects.forEach((o) => {
      if (o.kind === 'building') {
        const [fw, fh] = (o.sprite ? manifest.sprites[o.sprite]?.foundation : undefined) ?? [1, 1];
        for (let y = o.y - 1; y <= o.y + fh; y++) for (let x = o.x - 1; x <= o.x + fw; x++) block(x, y);
      } else if (o.kind === 'tree' || (o.kind === 'overlay' && !o.flat)) block(o.x, o.y);
    });
    const rect = manifest.visibleRect;
    const bounds = rect
      ? (x: number, y: number) => {
          const p = projectCellCentre(x, y, heightAt(x, y));
          return (
            p.sx > rect.x + 30 && p.sx < rect.x + rect.width - 30 && p.sy > rect.y + 30 && p.sy < rect.y + rect.height
          );
        }
      : undefined;
    const seed = stringSeed(opts.mapId);
    for (const [x, y] of placeStreetLamps({
      width: W,
      height: H,
      exists,
      surface,
      blocked,
      ...(bounds ? { bounds } : {}),
      seed,
      spacing: STREET_LAMP_SPACING,
    }))
      streetLamps.push({ cell: [x, y], z: heightAt(x, y) });
  }

  const sidecar: MapLightsSidecar = {
    version: MAP_LIGHTS_VERSION,
    map: opts.mapId,
    source: manifest.source,
    theater: manifest.theater,
    lighting,
    atmosphere,
    types,
    lights,
    inertLights,
    hiddenObjects,
    cells: { surface: Buffer.from(surface).toString('base64'), medianZ },
    hdEmitters: {
      streetLamps,
      policy: { spacing: STREET_LAMP_SPACING, theaters: [...STREET_LAMP_THEATERS] },
    },
    extractor: {
      tool: 'ra2-assets lights',
      manifestSha256: createHash('sha256').update(manifestBytes).digest('hex'),
      warnings,
    },
  };
  const file = join(mapDir, 'lights.json');
  writeAtomic(file, JSON.stringify(sidecar, null, 1));
  const written = [file];
  log(
    `${opts.mapId}: ${lights.length} light sources, ${inertLights.length} inert, ${hiddenObjects.length} hidden objects, ` +
      `${streetLamps.length} street lamps, atmosphere ${atmosphere.kind} (medianZ ${medianZ})`,
  );

  if (opts.windows || opts.preview) {
    const deny = readDenyList();
    const sprites = decodePng(readFileSync(join(mapDir, manifest.spriteAtlas.file)));
    const palette = paletteLum(decodePng(readFileSync(join(mapDir, manifest.palettes['unit'] ?? 'palettes/unit.png'))));
    if (opts.windows) {
      const { mask, json } = windowMasks(sprites, manifest.sprites, palette.lum, deny);
      writeAtomic(join(mapDir, 'windows.png'), encodePng(mask));
      writeAtomic(join(mapDir, 'windows.json'), JSON.stringify(json, null, 1));
      written.push(join(mapDir, 'windows.png'), join(mapDir, 'windows.json'));
      log(`${opts.mapId}: windows in ${Object.keys(json.frames).length} building sprites`);
    }
    if (opts.preview) {
      const p1 = join(mapDir, 'lights-preview.png');
      writeAtomic(p1, encodePng(lightsPreview(mapDir, manifest, sidecar, surface, exists, heights)));
      const p2 = join(mapDir, 'windows-preview.png');
      writeAtomic(p2, encodePng(windowsPreview(sprites, manifest.sprites, palette, deny)));
      written.push(p1, p2);
    }
  }
  return { file, sidecar, written };
}

// ------------------------------------------------------------------ windows

interface PaletteInfo {
  rgb: Uint8Array;
  lum: Float32Array;
}

function paletteLum(png: PngImage): PaletteInfo {
  const rgb = new Uint8Array(256 * 3);
  const lum = new Float32Array(256);
  for (let i = 0; i < Math.min(256, png.width); i++) {
    const r = png.data[i * png.channels]!;
    const g = png.data[i * png.channels + 1]!;
    const b = png.data[i * png.channels + 2]!;
    rgb.set([r, g, b], i * 3);
    lum[i] = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }
  return { rgb, lum };
}

/** Indexed pixels of one atlas frame (R8 atlases, or the map extractor's legacy RGBA with the index in red). */
function framePixels(atlas: PngImage, frame: SpriteFrame): Uint8Array {
  const [x, y, w, h] = frame.rect;
  const out = new Uint8Array(w * h);
  for (let py = 0; py < h; py++)
    for (let px = 0; px < w; px++) out[py * w + px] = atlas.data[((y + py) * atlas.width + x + px) * atlas.channels]!;
  return out;
}

const buildingType = (spriteId: string) => spriteId.slice('building:'.length).toUpperCase();

/**
 * Building types that may show lit windows: civilian art only (CA* types: city blocks, houses, shops, tech buildings
 * such as the hospital). Faction buildings (GA*, NA*, YA*, NT*) are military structures whose dark details (vents,
 * lattices, hangar doors) read as scattered embers at night on a player's own base, so they stay dark, as do the
 * deny-listed civilian types.
 */
const WINDOW_TYPE_PREFIX = 'CA';
const litWindowType = (spriteId: string, deny: readonly string[]): boolean => {
  if (!spriteId.startsWith('building:')) return false;
  const type = buildingType(spriteId);
  return type.startsWith(WINDOW_TYPE_PREFIX) && !deny.includes(type);
};

/**
 * Body frames that can show lit windows: 0 (healthy) and 1 (damaged), the only frames renderers draw for a standing
 * building. Later frames are rubble and other states.
 */
const WINDOW_FRAMES = 2;

/**
 * Window masks (R = lit, G = variant; frame-sized, 2 bytes per pixel) of a building's healthy and damaged frames.
 * The damaged frame keeps only windows that are also windows of the healthy frame at the same canvas position, with
 * the healthy frame's lit state and variant, so cracks and holes never light up and a window keeps its light when the
 * building is damaged. `all` marks every candidate lit (review sheets).
 */
function buildingWindowMasks(
  id: string,
  entry: SpriteEntry,
  lum: Float32Array,
  pixelsOf: (frame: SpriteFrame) => Uint8Array,
  foundation: readonly [number, number] | undefined,
  all = false,
): { masks: Uint8Array[]; facade: boolean } {
  const f0 = entry.frames[0];
  if (!f0 || f0.rect[2] === 0 || f0.rect[3] === 0) return { masks: [], facade: false };
  const [, , w0, h0] = f0.rect;
  const rng = all ? () => 0 : seededRandom(stringSeed(id));
  const roof = (pixels: Uint8Array, f: SpriteFrame) =>
    foundation ? roofBottom(pixels, f.rect[2], f.rect[3], foundation) : null;
  const p0 = pixelsOf(f0);
  const healthy = detectBuildingWindows(p0, w0, h0, lum, rng, { roof: roof(p0, f0) });
  const m0 = healthy.mask;
  const out: Uint8Array[] = [m0];
  const f1 = entry.frames[1];
  if (WINDOW_FRAMES > 1 && f1 && f1.rect[2] > 0 && f1.rect[3] > 0) {
    const [, , w1, h1] = f1.rect;
    const p1 = pixelsOf(f1);
    const candidates = detectBuildingWindows(p1, w1, h1, lum, () => 0, { mode: healthy.mode, roof: roof(p1, f1) }).mask;
    const m1 = new Uint8Array(w1 * h1 * 2);
    for (let py = 0; py < h1; py++) {
      for (let px = 0; px < w1; px++) {
        const s = (py * w1 + px) * 2;
        if (!candidates[s]) continue;
        // Same canvas point in the healthy frame.
        const qx = px + f1.offset[0] - f0.offset[0];
        const qy = py + f1.offset[1] - f0.offset[1];
        if (qx < 0 || qy < 0 || qx >= w0 || qy >= h0) continue;
        const q = (qy * w0 + qx) * 2;
        if (!m0[q]) continue;
        m1[s] = m0[q]!;
        m1[s + 1] = m0[q + 1]!;
      }
    }
    out.push(m1);
  }
  return { masks: out, facade: healthy.mode === 'large' };
}

/** Sidecar entry of one frame mask (null when nothing is lit). */
function frameWindows(
  mask: Uint8Array,
  frame: SpriteFrame,
  facade: boolean,
): WindowsSidecar['frames'][string][string] | null {
  const rect: [number, number, number, number] = [0, 0, frame.rect[2], frame.rect[3]];
  const stats = windowStats(mask, frame.rect[2], rect);
  if (!stats.lit) return null;
  return { ...stats, columns: windowColumns(mask, frame.rect[2], rect), ...(facade ? { facade } : {}) };
}

/** Copy a frame mask into an RGBA page buffer at the frame's atlas rectangle. */
function blitMask(data: Uint8Array, pageWidth: number, frame: SpriteFrame, mask: Uint8Array): void {
  const [x, y, w, h] = frame.rect;
  for (let py = 0; py < h; py++) {
    for (let px = 0; px < w; px++) {
      const s = (py * w + px) * 2;
      if (!mask[s]) continue;
      const d = ((y + py) * pageWidth + x + px) * 4;
      data[d] = mask[s]!;
      data[d + 1] = mask[s + 1]!;
    }
  }
}

function emptyMaskPage(width: number, height: number): Uint8Array {
  const data = new Uint8Array(width * height * 4);
  for (let i = 3; i < data.length; i += 4) data[i] = 255;
  return data;
}

/** Lit-window mask over the map cache's sprite atlas (RGBA, same size) plus per-frame stats. */
function windowMasks(
  atlas: PngImage,
  sprites: Record<string, SpriteEntry>,
  lum: Float32Array,
  deny: readonly string[],
): { mask: PngImage; json: WindowsSidecar } {
  const data = emptyMaskPage(atlas.width, atlas.height);
  const json: WindowsSidecar = { version: WINDOWS_VERSION, frames: {}, denied: [...deny] };
  for (const [id, entry] of Object.entries(sprites)) {
    if (!litWindowType(id, deny)) continue;
    const { masks, facade } = buildingWindowMasks(id, entry, lum, (f) => framePixels(atlas, f), entry.foundation);
    masks.forEach((mask, index) => {
      const frame = entry.frames[index]!;
      blitMask(data, atlas.width, frame, mask);
      const stats = frameWindows(mask, frame, facade);
      if (stats) (json.frames[id] ??= {})[String(index)] = stats;
    });
  }
  return { mask: { width: atlas.width, height: atlas.height, channels: 4, data }, json };
}

/** Per-page window masks for a type library (_library/<theater>/windows-<n>.png + windows.json). */
export function writeLibraryWindows(opts: {
  cacheDir: string;
  theater: TheaterId;
  log?: (m: string) => void;
}): string[] {
  const log = opts.log ?? ((m: string) => console.log(m));
  const dir = join(opts.cacheDir, '_library', opts.theater);
  const libraryFile = join(dir, 'library.json');
  if (!existsSync(libraryFile)) throw new Error(`${libraryFile} not found: run pnpm hd:library first`);
  const library = JSON.parse(readFileSync(libraryFile, 'utf8')) as TypeLibrary;
  const palette = paletteLum(decodePng(readFileSync(join(dir, library.palettes['unit'] ?? 'palettes/unit.png'))));
  const deny = readDenyList();
  const json: WindowsSidecar = { version: WINDOWS_VERSION, pages: {}, frames: {}, denied: [...deny] };
  const pages = new Map<number, PngImage>();
  const page = (n: number): PngImage => {
    let image = pages.get(n);
    if (!image) pages.set(n, (image = decodePng(readFileSync(join(dir, library.spriteAtlases[n]!.file)))));
    return image;
  };
  // Foundations by sprite (a type's art may come from another type's image).
  const foundations = new Map<string, [number, number]>();
  for (const t of Object.values(library.types)) if (t.sprite && t.foundation) foundations.set(t.sprite, t.foundation);
  // Masks per page, filled sprite by sprite (a sprite's two frames may sit on different pages).
  const out = new Map<number, Uint8Array>();
  for (const [id, entry] of Object.entries(library.sprites)) {
    if (!litWindowType(id, deny)) continue;
    const foundation = foundations.get(id);
    const { masks, facade } = buildingWindowMasks(
      id,
      entry,
      palette.lum,
      (f) => framePixels(page(f.page ?? 0), f),
      foundation,
    );
    masks.forEach((mask, index) => {
      const frame = entry.frames[index]!;
      const stats = frameWindows(mask, frame, facade);
      if (!stats) return;
      const n = frame.page ?? 0;
      const ref = library.spriteAtlases[n]!;
      let data = out.get(n);
      if (!data) out.set(n, (data = emptyMaskPage(ref.width, ref.height)));
      blitMask(data, ref.width, frame, mask);
      (json.frames[id] ??= {})[String(index)] = stats;
    });
  }
  const written: string[] = [];
  for (const [n, data] of [...out].sort(([a], [b]) => a - b)) {
    const ref = library.spriteAtlases[n]!;
    const file = `windows-${n}.png`;
    writeAtomic(join(dir, file), encodePng({ width: ref.width, height: ref.height, channels: 4, data }));
    written.push(join(dir, file));
    json.pages![String(n)] = file;
  }
  writeAtomic(join(dir, 'windows.json'), JSON.stringify(json, null, 1));
  written.push(join(dir, 'windows.json'));
  log(`${opts.theater}: window masks on ${out.size} pages, ${Object.keys(json.frames).length} lit building sprites`);
  return written;
}

/**
 * Review sheet: each building's healthy and damaged frames at 2x with every window candidate (lit or not) filled cyan
 * and outlined in magenta; denied types are labelled DENY.
 */
function windowsPreview(
  atlas: PngImage,
  sprites: Record<string, SpriteEntry>,
  palette: PaletteInfo,
  deny: readonly string[],
): PngImage {
  const SCALE = 2;
  const GAP = 10;
  const WIDTH = 3000;
  const items: { id: string; frame: number; f: SpriteFrame; mask: Uint8Array; facade: boolean }[] = [];
  for (const [id, entry] of Object.entries(sprites).sort(([a], [b]) => a.localeCompare(b))) {
    if (!id.startsWith('building:')) continue;
    const { masks, facade } = buildingWindowMasks(
      id,
      entry,
      palette.lum,
      (f) => framePixels(atlas, f),
      entry.foundation,
      true,
    );
    masks.forEach((mask, frame) => {
      items.push({ id, frame, f: entry.frames[frame]!, mask, facade });
    });
  }
  // Shelf layout.
  const placed: { x: number; y: number; item: (typeof items)[number] }[] = [];
  let x = GAP;
  let y = GAP;
  let shelf = 0;
  for (const item of items) {
    const w = item.f.rect[2] * SCALE;
    const h = item.f.rect[3] * SCALE + 14;
    if (x + w + GAP > WIDTH) {
      x = GAP;
      y += shelf + GAP;
      shelf = 0;
    }
    placed.push({ x, y, item });
    x += w + GAP;
    shelf = Math.max(shelf, h);
  }
  const sheet = new Sheet(WIDTH, y + shelf + GAP);
  for (const { x: ox, y: oy, item } of placed) {
    const [, , w, h] = item.f.rect;
    const pixels = framePixels(atlas, item.f);
    const denied = !litWindowType(item.id, deny);
    const mask = item.mask;
    for (let py = 0; py < h; py++) {
      for (let px = 0; px < w; px++) {
        const v = pixels[py * w + px]!;
        const lit = mask[(py * w + px) * 2]! > 0;
        if (!v) continue;
        const [r, g, b] = [palette.rgb[v * 3]!, palette.rgb[v * 3 + 1]!, palette.rgb[v * 3 + 2]!];
        for (let dy = 0; dy < SCALE; dy++)
          for (let dx = 0; dx < SCALE; dx++)
            sheet.put(
              ox + px * SCALE + dx,
              oy + 14 + py * SCALE + dy,
              ...((lit ? [0, 255, 255] : [r, g, b]) as [number, number, number]),
            );
      }
    }
    // Outline window pixels (magenta border where a lit pixel meets a non-lit one).
    for (let py = 0; py < h; py++) {
      for (let px = 0; px < w; px++) {
        if (!mask[(py * w + px) * 2]) continue;
        const edge = (qx: number, qy: number) => qx < 0 || qy < 0 || qx >= w || qy >= h || !mask[(qy * w + qx) * 2];
        const sx = ox + px * SCALE;
        const sy = oy + 14 + py * SCALE;
        if (edge(px - 1, py)) sheet.line(sx - 1, sy, sx - 1, sy + SCALE - 1, [255, 0, 255]);
        if (edge(px + 1, py)) sheet.line(sx + SCALE, sy, sx + SCALE, sy + SCALE - 1, [255, 0, 255]);
        if (edge(px, py - 1)) sheet.line(sx, sy - 1, sx + SCALE - 1, sy - 1, [255, 0, 255]);
        if (edge(px, py + 1)) sheet.line(sx, sy + SCALE, sx + SCALE - 1, sy + SCALE, [255, 0, 255]);
      }
    }
    const label = `${buildingType(item.id)}:${item.frame}${denied ? ' DENY' : item.facade ? ' LARGE' : ''}`;
    sheet.text(label, ox, oy + 1, denied ? [255, 120, 120] : [255, 255, 255]);
  }
  return { width: sheet.width, height: sheet.height, channels: 4, data: sheet.rgba };
}

// ------------------------------------------------------------------ lights preview

const SURFACE_COLOURS: Record<number, [number, number, number]> = {
  [SURFACE.soft]: [60, 200, 60],
  [SURFACE.paved]: [150, 150, 230],
  [SURFACE.road]: [240, 150, 40],
  [SURFACE.water]: [40, 110, 255],
  [SURFACE.rock]: [150, 90, 50],
};

/**
 * Two panels over the unlit 1x terrain composite, cropped to the playable rectangle: (top) surface classes, (bottom)
 * the map at its default night: ground at the night level plus the engine light of its sources (at the night ambient),
 * with light sources (cyan rings), inert lights (green) and HD street lamps (yellow) marked.
 */
function lightsPreview(
  mapDir: string,
  manifest: HdCacheManifest,
  sidecar: MapLightsSidecar,
  surface: Uint8Array,
  exists: Uint8Array,
  heights: Uint8Array,
): PngImage {
  const W = manifest.grid.width;
  const H = manifest.grid.height;
  const base = decodePng(readFileSync(join(mapDir, 'terrain-map.png')));
  const terrain = decodePng(readFileSync(join(mapDir, manifest.terrainAtlas.file)));
  const layout = terrainLayout(manifest);
  const originX = Math.floor(layout.minX);
  const originY = Math.floor(layout.minY);
  // Which cell drew each composite pixel (same painter order as the composite).
  const cellAt = new Int32Array(base.width * base.height).fill(-1);
  for (const pass of [0, 1]) {
    for (const c of layout.cells) {
      const t = manifest.tiles[c.t]!;
      const [rx, ry, rw, rh] = t.rect;
      for (let py = 0; py < rh; py++) {
        for (let px = 0; px < rw; px++) {
          if (terrain.data[((ry + py) * terrain.width + rx + px) * 4 + 3] === 0) continue;
          if (insideDiamond(px, py, t.anchor) !== (pass === 0)) continue;
          const X = Math.round(c.sx + px) - originX;
          const Y = Math.round(c.sy + py) - originY;
          if (X >= 0 && Y >= 0 && X < base.width && Y < base.height) cellAt[Y * base.width + X] = c.y * W + c.x;
        }
      }
    }
  }
  const grid = { width: W, height: H, z: heights, exists };
  const profile = sidecar.atmosphere;
  const normal = sidecar.lighting.normal;
  const ambient = nightBaseAmbient(profile) - (normal.level * sidecar.cells.medianZ - normal.ground);
  const delta = engineLightDelta(grid, normal, sidecar.lights, ambient);
  const unlit = engineCellLight(grid, { ...normal, ambient }, []);
  const rect = manifest.visibleRect ?? { x: originX, y: originY, width: base.width, height: base.height };
  const x0 = Math.max(0, rect.x - originX);
  const y0 = Math.max(0, rect.y - originY);
  const cw = Math.min(base.width - x0, rect.width);
  const ch = Math.min(base.height - y0, rect.height);
  const sheet = new Sheet(cw, ch * 2 + 20);
  const toSrgb = (v: number) => Math.round(255 * Math.min(1, Math.max(0, v)) ** (1 / 2.2));
  const toLin = (v: number) => (v / 255) ** 2.2;
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      const s = ((y0 + y) * base.width + x0 + x) * 4;
      const c = cellAt[(y0 + y) * base.width + x0 + x]!;
      const rgb = [base.data[s]!, base.data[s + 1]!, base.data[s + 2]!];
      const tint = c >= 0 ? SURFACE_COLOURS[surface[c]!] : undefined;
      const top = tint ? rgb.map((v, k) => v * 0.55 + tint[k]! * 0.45) : rgb.map((v) => v * 0.3);
      sheet.put(x, y, top[0]!, top[1]!, top[2]!);
      // Unlit ground at the night level (tinted like the engine's unlit cell), plus the sources' light at 0.8 of the
      // engine's full footprint (an overview; the renderer stages it per map class, see hd-renderer mapLights.ts).
      const lit = rgb.map((v, k) => {
        if (c < 0) return 0;
        const tint =
          unlit.tint[c * 3 + k]! / Math.max(1e-6, unlit.tint[c * 3]!, unlit.tint[c * 3 + 1]!, unlit.tint[c * 3 + 2]!);
        return toSrgb(toLin(v) * (profile.nightLevel * tint + 0.8 * delta[c * 3 + k]!));
      });
      sheet.put(x, ch + 20 + y, lit[0]!, lit[1]!, lit[2]!);
    }
  }
  const mark = (cx: number, cy: number, z: number, r: number, colour: [number, number, number]) => {
    const p = projectCellCentre(cx, cy, z);
    for (const panel of [0, ch + 20]) {
      const px = p.sx - originX - x0;
      const py = p.sy - originY - y0 + panel;
      for (let a = 0; a < 48; a++) {
        const t = (a / 48) * Math.PI * 2;
        sheet.put(px + Math.cos(t) * r, py + Math.sin(t) * r * 0.5, ...colour);
        sheet.put(px + Math.cos(t) * (r + 1), py + Math.sin(t) * (r + 1) * 0.5, ...colour);
      }
    }
  };
  for (const l of sidecar.lights)
    mark(l.cell[0] + (l.foundation[0] - 1) / 2, l.cell[1] + (l.foundation[1] - 1) / 2, l.z, 10, [0, 255, 255]);
  for (const l of sidecar.inertLights) mark(l.cell[0], l.cell[1], l.z, 6, [0, 255, 0]);
  for (const l of sidecar.hdEmitters.streetLamps) mark(l.cell[0], l.cell[1], l.z, 4, [255, 230, 0]);
  sheet.text('SURFACES: SOFT GREEN / PAVED BLUE / ROAD ORANGE / WATER / ROCK BROWN', 6, 6);
  sheet.text(
    `DEFAULT NIGHT ${profile.kind.toUpperCase()} LEVEL ${profile.nightLevel.toFixed(2)} + ENGINE LIGHTS (CYAN) HD LAMPS (YELLOW)`,
    6,
    ch + 26,
  );
  return { width: sheet.width, height: sheet.height, channels: 4, data: sheet.rgba };
}
