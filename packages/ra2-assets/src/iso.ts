/**
 * Engine screen projection and anchor math (pure).
 *
 * RA2 cells are 60x30 diamonds; one height level lifts a point 15 px. A cell CORNER (x, y, z) — cell units, where
 * cell (x, y) spans corners (x..x+1, y..y+1) and (x, y) is its top corner — projects to
 *   screen = ((x - y) * 30, (x + y) * 15 - z * 15).
 * A TMP tile's 60x30 diamond has its top corner at raster pixel (30, 0) of the diamond box, so a tile raster whose
 * diamond box starts at (left, top) has anchor (left + 30, top): drawing the raster at `corner - anchor` lines the
 * diamond up with the cell. Engine coordinates in leptons use 256 per cell and 104 per height level.
 */
import { engineCellLight, engineLighting } from './lights.ts';
import type { LightingClass, MapLighting, MapObjectKind } from './manifest.ts';

export const CELL_W = 60;
export const CELL_H = 30;
export const LEVEL_H = 15;
export const LEPTONS_PER_CELL = 256;
export const LEPTONS_PER_LEVEL = 104;

export interface ScreenPoint {
  sx: number;
  sy: number;
}

/** Screen position of cell corner (x, y) at height level z. */
export function projectCorner(x: number, y: number, z: number): ScreenPoint {
  return { sx: (x - y) * (CELL_W / 2), sy: (x + y) * (CELL_H / 2) - z * LEVEL_H };
}

/** Screen position of the centre of cell (x, y) at level z (where the engine places a cell's objects). */
export function projectCellCentre(x: number, y: number, z: number): ScreenPoint {
  return projectCorner(x + 0.5, y + 0.5, z);
}

/** Screen offset of an engine lepton delta (dx, dy along the cell axes, dz up). */
export function leptonDelta(dx: number, dy: number, dz = 0): ScreenPoint {
  return {
    sx: ((dx - dy) * (CELL_W / 2)) / LEPTONS_PER_CELL,
    sy: ((dx + dy) * (CELL_H / 2)) / LEPTONS_PER_CELL - (dz * LEVEL_H) / LEPTONS_PER_LEVEL,
  };
}

/** Anchor (cell top corner inside the raster) of a tile raster whose diamond box top-left is (left, top). */
export function tileAnchor(diamondLeft: number, diamondTop: number): [number, number] {
  return [diamondLeft + CELL_W / 2, diamondTop];
}

/** Top-left screen position at which to draw a tile raster with `anchor` for cell (x, y) at level z. */
export function tileRasterOrigin(x: number, y: number, z: number, anchor: readonly [number, number]): ScreenPoint {
  const c = projectCorner(x, y, z);
  return { sx: c.sx - anchor[0], sy: c.sy - anchor[1] };
}

export interface ExtraPlacement {
  /** Diamond box top-left and extra-graphics top-left inside the merged raster. */
  diamond: [number, number];
  extra: [number, number];
  width: number;
  height: number;
}

/**
 * Merge a tile's 60x30 diamond with its extra graphics (cliff faces, water banks). Both `tile` and `extra` offsets
 * are screen offsets inside the template block (TMP image header x/y and x_extra/y_extra), so the extra sits at
 * `(extra - tile)` relative to the diamond box, as in XCC's TMP renderer. Adapted from Vanguard
 * (harshilmathur/openra2 @ 8ba59f0, apps/client/dev/terrain.ts tileInputFromTmp, GPL-3.0-or-later).
 */
export function mergeTileExtra(
  tile: { x: number; y: number },
  extra: { x: number; y: number; width: number; height: number } | undefined,
  tileW = CELL_W,
  tileH = CELL_H,
): ExtraPlacement {
  if (!extra || extra.width <= 0 || extra.height <= 0) {
    return { diamond: [0, 0], extra: [0, 0], width: tileW, height: tileH };
  }
  const rx = extra.x - tile.x;
  const ry = extra.y - tile.y;
  const minX = Math.min(0, rx);
  const minY = Math.min(0, ry);
  const maxX = Math.max(tileW, rx + extra.width);
  const maxY = Math.max(tileH, ry + extra.height);
  return {
    diamond: [0 - minX, 0 - minY],
    extra: [rx - minX, ry - minY],
    width: maxX - minX,
    height: maxY - minY,
  };
}

/**
 * Lepton offsets of the five infantry sub-cell spots from the cell's top corner (0 = centre, 1 = top, 2 = right,
 * 3 = left, 4 = bottom), as used by the map's [Infantry] sub-cell column.
 */
export const SUBCELL_LEPTONS: readonly (readonly [number, number])[] = [
  [128, 128],
  [64, 64],
  [192, 64],
  [64, 192],
  [192, 192],
];

/** Screen position of an infantry sub-cell spot. */
export function projectSubCell(x: number, y: number, z: number, subCell: number): ScreenPoint {
  const [lx, ly] = SUBCELL_LEPTONS[subCell] ?? SUBCELL_LEPTONS[0]!;
  const c = projectCorner(x, y, z);
  const d = leptonDelta(lx, ly);
  return { sx: c.sx + d.sx, sy: c.sy + d.sy };
}

/** SHP draw origin: the engine draws a shape centred on its object's screen point, i.e. canvas centre = point. */
export function shpFrameOffset(canvas: readonly [number, number], frame: { x: number; y: number }): [number, number] {
  return [frame.x - Math.floor(canvas[0] / 2), frame.y - Math.floor(canvas[1] / 2)];
}

/**
 * Painter's depth of a map-space point: the engine sorts ground-layer objects by the screen Y of their sort
 * coordinate (larger = nearer = drawn later). Ties break on screen X so output is deterministic.
 */
export function depthKey(x: number, y: number): number {
  return (x + y) * 1024 + (x - y);
}

/**
 * Cells of a map whose [Map] Size is (width, height): the rhombus of screen rows dy in [0, 2*height) and columns
 * dx in [0, 2*width - 1) with even dx + dy, where dx = x - y + width - 1 and dy = x + y - width - 1.
 */
export function mapSizeCells(width: number, height: number): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];
  for (let dy = 0; dy < 2 * height; dy++) {
    for (let dx = dy % 2; dx <= 2 * width - 2; dx += 2) {
      out.push({ x: (dx + dy) / 2 + 1, y: (dy - dx) / 2 + width });
    }
  }
  return out;
}

/**
 * Engine draw point (SHP canvas centre / voxel origin) relative to the projected top corner of the object's cell,
 * for objects standing on the cell's centre spot. Measured on the player's install and matched against the
 * Chrono Divide-derived reference (huangkaoya/ts-redalert2 src/game/art/ObjectArt.ts getDefaultDrawOffset and
 * getDrawOffset):
 *   - overlays: the union of all TIB01/GEM01 frames spans x -26..26, y 1..26 around the canvas centre, i.e. exactly
 *     the cell diamond hanging below its top corner -> (0, 0). Walls, low bridges and other overlays share it.
 *   - rocks (overlays with rules IsARock=yes: SROCK, TROCK, LUNRK) are drawn at the cell centre -> (0, 15); with
 *     (0, 0) about 70 % of srock01 would sit above its cell.
 *   - terrain objects (trees, lamps) are drawn at the cell centre -> (0, 15) (tree01's trunk base lands on the
 *     centre), except tiberium-spawning trees (TIBTRE, SpawnsTiberium=yes), which use (0, 0).
 *   - smudges: (0, 0), like overlays.
 *   - buildings: averaging the left/right extents of frame 0 against the WxH foundation puts the foundation's top
 *     corner within 1 px of the canvas centre for GACNST 4x4, GAPOWR 2x2, GAPILE 3x2, NAPOWR 3x2, NAHAND 2x2 and
 *     CABHUT 1x1, and no frame reaches below the foundation's bottom corner -> (0, 0).
 *   - infantry: standing frames end ~3 px below the canvas centre (feet on the canvas centre), so the canvas centre
 *     is the sub-cell ground point itself; the cell-centre spot is (0, 15).
 *   - SHP vehicles, voxels and aircraft stand on the cell centre -> (0, 15).
 */
export function drawOffsetFor(
  kind: MapObjectKind,
  variant: { isARock?: boolean; spawnsTiberium?: boolean } = {},
): [number, number] {
  switch (kind) {
    case 'overlay':
      return variant.isARock ? [0, CELL_H / 2] : [0, 0];
    case 'tree':
      return variant.spawnsTiberium ? [0, 0] : [0, CELL_H / 2];
    case 'smudge':
    case 'building':
      return [0, 0];
    default:
      return [0, CELL_H / 2];
  }
}

/**
 * Draw point relative to the projection of an object's engine coordinate (CoordStruct) instead of its cell's top
 * corner, for renderers that place live objects from lepton positions (TypeLibrary). The live reader reports mobile
 * objects at their own coordinate (infantry: the sub-cell spot, vehicles/aircraft: their centre) -> (0, 0), and
 * buildings at the centre of the foundation's top-left cell, half a cell below the top corner where drawOffsetFor
 * puts their canvas centre -> (0, -15).
 */
export function coordDrawOffset(kind: 'building' | 'vehicle' | 'infantry' | 'aircraft'): [number, number] {
  if (kind === 'building') {
    const d = drawOffsetFor('building');
    return [d[0], d[1] - CELL_H / 2];
  }
  return [0, 0];
}

/** [Lighting] Level used when a map omits it (engine default, as in the reference MapLighting.read). */
export const DEFAULT_LIGHT_LEVEL = 0.032;

/**
 * Per-channel palette multipliers for something drawn on a cell at height level z under the map's [Lighting], with
 * the engine's own cell formula (lights.ts engineCellLight, YR 1.001 @0x484180): intensity = Ambient - Ground +
 * Level x z in the engine's truncated precision, clamped to [0, 2], and the per-channel tint normalised by its largest
 * channel. Classes (MapObject.lighting): 'full' = tiles, terrain objects, overlays, smudges (intensity x tint);
 * 'ambient' = buildings, units, infantry, aircraft, walls (the object level I only: no tint and not its largest
 * channel, CellLight.level); 'none' = ore, gems (unlit). Measured
 * against same-moment captures of XMP29U2 in packages/hd-renderer (src/ra2/mapLighting.ts). Light sources, Ion Storm
 * and Dominator lighting are not included here.
 */
export function mapLightMultipliers(l: MapLighting, z: number, cls: LightingClass = 'full'): [number, number, number] {
  if (cls === 'none') return [1, 1, 1];
  const cell = engineCellLight(
    { width: 1, height: 1, z: Uint8Array.of(Math.max(0, Math.min(255, Math.round(z)))), exists: Uint8Array.of(1) },
    engineLighting(l),
    [],
  );
  const k = cell.intensity[0]!;
  // Objects take the engine's object level (no tint and not its largest channel either, see CellLight.level).
  const o = cell.level[0]!;
  return cls === 'full' ? [k * cell.tint[0]!, k * cell.tint[1]!, k * cell.tint[2]!] : [o, o, o];
}

/**
 * The playable screen rectangle of a map, in this module's screen coordinates (projectCorner, heights included),
 * from [Map] Size (width, height), [Map] LocalSize and the map's cutoff height. Port of the reference's
 * MapBounds.fromMapFile/computeLocalSize + WorldView.computeMapScreenBounds (huangkaoya/ts-redalert2
 * src/game/map/MapBounds.ts, src/gui/screen/game/WorldView.ts): in display-tile units (30 x 15 px) the view spans
 *   x = 2 * max(2, L.x), width = 2 * min(W - 2 - x, L.w), y = 2 * L.y - 4,
 *   height = min(2 * (L.h + 5) - 1, 2 * H - 2 * (L.y - 3) - max(9, cutoff)),
 * and the reference's screen origin sits (30 * W, -15 * W) px from ours.
 */
export function localScreenRect(
  size: { width: number; height: number },
  local: { x: number; y: number; width: number; height: number },
  cutoffHeight: number,
): { x: number; y: number; width: number; height: number } {
  const lx = Math.max(2, local.x);
  const lw = Math.min(size.width - 2 - lx, local.width);
  const tx = 2 * lx;
  const ty = 2 * local.y - 4;
  const tw = 2 * lw;
  const th = Math.min(2 * (local.height + 5) - 1, 2 * size.height - 2 * (local.y - 3) - Math.max(9, cutoffHeight));
  const left = tx * (CELL_W / 2) - (CELL_W / 2) * size.width;
  const top = ty * (CELL_H / 2) + (CELL_H / 2) * size.width;
  return { x: left, y: top, width: tw * (CELL_W / 2), height: (th - 1) * (CELL_H / 2) };
}

/**
 * The engine's cutoff tile height (reference TileCollection.computeCutoffTileHeight): with display coordinates
 * dx = x - y + W - 1, dy = x + y - W - 1 (cells outside the [Map] Size display box are ignored) and dw = max dx + 1,
 * the highest level among the cells of the bottom-most display row that has any cell with 1 <= dx < dw - 4.
 */
export function cutoffTileHeight(
  size: { width: number; height: number },
  cells: Iterable<{ x: number; y: number; z: number }>,
): number {
  const inBox: { dx: number; dy: number; z: number }[] = [];
  let dw = 0;
  for (const c of cells) {
    const dx = c.x - c.y + size.width - 1;
    const dy = c.x + c.y - size.width - 1;
    if (dx < 0 || dy < 0 || dx >= 2 * size.width || dy >= 2 * size.height) continue;
    inBox.push({ dx, dy, z: c.z });
    dw = Math.max(dw, dx + 1);
  }
  const rows = new Map<number, number>();
  for (const c of inBox) {
    if (c.dx < 1 || c.dx >= dw - 4) continue;
    rows.set(c.dy, Math.max(rows.get(c.dy) ?? 0, c.z));
  }
  let best = -1;
  for (const dy of rows.keys()) best = Math.max(best, dy);
  return best < 0 ? 0 : rows.get(best)!;
}
