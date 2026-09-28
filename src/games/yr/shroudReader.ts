import type { GuestMemoryAccessor } from '../shared/memoryAccessor';
import { YR_STARTUP_PAGE_HASH } from './startupPage';

/**
 * Read-only per-cell shroud (and, when a scenario enables it, fog of war) of Yuri's Revenge 1.001 (gamemd.exe, SHA-256
 * in YR_STARTUP_PAGE_HASH) for an external renderer. Like stateReader.ts it only reads guest memory through a
 * GuestMemoryAccessor, never writes guest state and never calls guest code, so it runs on the main thread and in the
 * VM Worker alike.
 *
 * Sources: class layouts, global addresses and flag names come from the community YRpp headers
 * (Phobos-developers/YRpp: MapClass.h, CellClass.h, GeneralDefinitions.h CellFlags/AltCellFlags, ScenarioClass.h),
 * used as facts only. What the flags *mean* was established by disassembling the player's own gamemd.exe 1.001:
 *
 * - The cell state belongs to the player at this computer only (HouseClass::CurrentPlayer): MapClass::Reshroud
 *   (0x577AB0) returns without touching cells for any other house, and each client keeps its own copy.
 * - AltFlags bit 0x08 (YRpp `Mapped`) is "revealed": DisplayClass::MapCell (0x4A9890) sets it,
 *   MapClass::IsLocationShrouded (0x586360) tests only it, and every re-shroud path clears it together with 0x10:
 *   MapClass::Reshroud, the single-cell shroud used by GrowShroud (0x4ACDA0) and the gap generator pass (0x578100),
 *   which re-shrouds every cell whose Flags carry 0x20 (`FlagToShroud`, raised by CellClass::IncreaseShroudCounter
 *   0x487690 while ShroudCounter > 0; ShroudCounter is capped by GapsCoveringThisCell). An enemy gap generator
 *   therefore shows up here exactly as the engine draws it: its cells lose `Mapped`.
 * - AltFlags bit 0x10 (YRpp `NoFog`) caches "no shroud overlay needed" (MapCell sets it when the cell's occlusion is -1).
 * - TacticalClass::GetOcclusion(cell, fog=false) (0x6D8700) decides what is drawn: -2 when neither 0x08 nor 0x10 is
 *   set, -1 when only 0x10 is set, otherwise the signed byte at 0x7F4194[mask], where `mask` has one bit per
 *   neighbour that lacks 0x08 (see YR_SHROUD_NEIGHBOURS). Missing neighbours resolve to MapClass::InvalidCell
 *   (0xABDC50), whose own flags are then used, as GetCellAt (0x5657A0) does.
 * - The per-cell draw (0x4801F0, called for every cell in view) stores that value in CellClass::Visibility (+0x120),
 *   maps -2 to frame 15 and -1 to frame 0, and writes SHROUD.SHP frame N into the alpha buffer (ABuffer) with its
 *   top-left at CoordsToScreen(cell centre with Z forced to 0) - TacticalPos + ViewBounds.XY - (30, 15): both draw
 *   loops (0x6D3660 and 0x6D72F2) zero Z, so the shroud is a flat layer on the Z = 0 plane and does not follow terrain
 *   height. Terrain of cell (X, Y) at height level L therefore sits under the shroud of flat cell (X - L/2, Y - L/2);
 *   MapClass::IsLocationShrouded applies the same shift (see isYrLocationShrouded). SHROUD.SHP (60x30 frames) holds
 *   light intensities: 127 = full light (frame 0 is all 127), 2 = black (frame 15 is all 2), 254 = transparent;
 *   terrain and objects are then drawn through the alpha-lighting remap, so shroud edges are a per-pixel darkening
 *   gradient over everything drawn there.
 * - Fog of war only runs when ScenarioClass::SpecialFlags bit 12 (0x1000, YRpp `FogOfWar`) is set: then a second pass
 *   draws FOG.SHP frames (frame 15 = intensity 66, i.e. about half light) from GetOcclusion(cell, fog=true), which is
 *   the same algorithm over Flags bits 0x02 (primary, YRpp `EdgeRevealed`) and 0x01 (secondary, `CenterRevealed`).
 *   Vanilla skirmish and multiplayer never set that flag and MapClass::IsLocationFogged (0x5865E0) is `return false`.
 *
 * scripts/remaster/bridge/verifyShroudReader.mts checks the result against a running skirmish (frame pixels, the
 * engine's own cached CellClass::Visibility, and cells revealed by a moving unit).
 */

/** YR 1.001 global addresses (YRpp facts, meanings from the disassembly above). */
export const YR_SHROUD_GLOBALS = Object.freeze({
  /** Unsorted::CurrentFrame, the logic frame counter. */
  frame: 0xa8ed84,
  /** ScenarioClass::Instance (pointer). */
  scenario: 0xa8b230,
  /** MapClass::Instance (the global map object itself). */
  map: 0x87f7e8,
  /** MapClass::InvalidCell: the static CellClass that GetCellAt returns for a coordinate without a cell. */
  invalidCell: 0xabdc50,
  /** signed char[256] in .rdata: neighbour mask -> occlusion (-1 clear, -2 black, else SHROUD.SHP frame). */
  occlusionTable: 0x7f4194,
});

/** Field offsets (YRpp facts; MapClass members after VisibleRect computed from the declared order). */
export const YR_SHROUD_OFFSETS = Object.freeze({
  /** MapClass::MapRect (RectangleStruct), the [Map] Size= rectangle. */
  mapRect: 0xec,
  /** MapClass::MapCoordBounds (LTRBStruct {Left, Top, Right, Bottom}): min/max cell coordinates. */
  mapCoordBounds: 0x124,
  /** MapClass::Cells (VectorClass<CellClass*>): Items at +0x13C, Capacity at +0x140; index = (Y << 9) + X. */
  cellItems: 0x13c,
  cellCapacity: 0x140,
  /** CellClass::MapCoords (CellStruct {short X, short Y}). */
  cellMapCoords: 0x24,
  /** CellClass::Level (signed char, height level; 104 leptons each). */
  cellLevel: 0x11b,
  /** CellClass::Visibility / Foggedness (signed char): the occlusion cached by the last draw or reveal. */
  cellVisibility: 0x120,
  cellFoggedness: 0x121,
  /** CellClass::AltFlags (YR_ALT_CELL_FLAGS). */
  cellAltFlags: 0x12c,
  /** CellClass::ShroudCounter / GapsCoveringThisCell (gap generator bookkeeping). */
  cellShroudCounter: 0x130,
  cellGaps: 0x134,
  /** CellClass::Flags (YR_CELL_FLAGS). */
  cellFlags: 0x140,
  /** ScenarioClass::SpecialFlags (ScenarioFlags bitfield). */
  scenarioFlags: 0x0,
});

/** CellClass::AltFlags bits that drive the shroud (names from YRpp AltCellFlags). */
export const YR_ALT_CELL_FLAGS = Object.freeze({ mapped: 0x08, noFog: 0x10 });
/** CellClass::Flags bits that drive fog and gap re-shrouding (names from YRpp CellFlags). */
export const YR_CELL_FLAGS = Object.freeze({
  centerRevealed: 0x01,
  edgeRevealed: 0x02,
  flagToShroud: 0x20,
  fogged: 0x40_0000,
});
/** ScenarioClass::SpecialFlags bit 12 (YRpp `FogOfWar`). */
export const YR_SCENARIO_FOG_OF_WAR = 0x1000;

/** MapClass::Cells always spans 512 x 512 slots (YRpp MapClass::MaxCells). */
const MAX_CELLS = 0x40000;

/**
 * Neighbour bits of the occlusion mask in TacticalClass::GetOcclusion, as cell offsets. On screen they run clockwise
 * from the right: 0x01 right, 0x02 down-right, 0x04 down, 0x08 down-left, 0x10 left, 0x20 up-left, 0x40 up,
 * 0x80 up-right (screen x grows with X - Y, screen y with X + Y).
 */
export const YR_SHROUD_NEIGHBOURS: ReadonlyArray<readonly [bit: number, dx: number, dy: number]> = Object.freeze([
  [0x01, 1, -1],
  [0x02, 1, 0],
  [0x04, 1, 1],
  [0x08, 0, 1],
  [0x10, -1, 1],
  [0x20, -1, 0],
  [0x40, -1, -1],
  [0x80, 0, -1],
]);

/** Values of YrShroud.cells. */
export const YR_SHROUD_STATE = Object.freeze({
  /** Not revealed to the local player (never explored, or re-shrouded by a gap generator / GrowShroud / Reshroud). */
  shrouded: 0,
  /** Revealed but fully fogged (only when the scenario enables fog of war; FOG.SHP frame 15). */
  fogged: 1,
  /** Revealed. */
  visible: 2,
  /** No CellClass exists here (outside the map diamond); the engine draws nothing. */
  none: 0xff,
});

/** Special values of YrShroud.edges / fogEdges (every other value is a SHROUD.SHP / FOG.SHP frame index). */
export const YR_SHROUD_FRAME = Object.freeze({
  /** Occlusion -1: no overlay (SHP frame 0 is uniform full light). */
  clear: 0,
  /** Occlusion -2: fully covered (SHP frame 15: black for SHROUD.SHP, half light for FOG.SHP). */
  covered: 15,
  /** No cell. */
  none: 0xff,
});

export interface YrShroud {
  /** Logic frame (Unsorted::CurrentFrame) at the time of the read. */
  frame: number;
  /** Cell coordinates of cells[0]: the same (X, Y) as stateReader objects, cell = floor(lepton / 256). */
  originX: number;
  originY: number;
  width: number;
  height: number;
  /** YR_SHROUD_STATE per cell, row-major: cells[(y - originY) * width + (x - originX)]. */
  cells: Uint8Array;
  /**
   * SHROUD.SHP frame the engine draws over each cell (0 = nothing, 15 = black, 1..46 = soft edge pieces, 0xFF = no
   * cell), recomputed exactly like TacticalClass::GetOcclusion so it is current even for cells outside the view.
   */
  edges: Uint8Array;
  /** FOG.SHP frame per cell when `fogOfWar` is set (same encoding), otherwise null. */
  fogEdges: Uint8Array | null;
  /** ScenarioClass::SpecialFlags FogOfWar: whether the engine draws fog at all. */
  fogOfWar: boolean;
  counts: {
    shrouded: number;
    fogged: number;
    visible: number;
    none: number;
    /** Slots whose pointer or CellClass::MapCoords failed validation (treated as missing cells). */
    invalid: number;
  };
}

export interface ReadYrShroudOptions {
  /** A previous result whose typed arrays are reused when the dimensions match (no allocation per poll). */
  reuse?: YrShroud | null;
}

// Packed per-cell bits used between the passes (kept inside `cells` until the last pass).
const EXISTS = 0x80;
const ALT_MASK = YR_ALT_CELL_FLAGS.mapped | YR_ALT_CELL_FLAGS.noFog; // 0x18, stored in place
const FOG_MASK = YR_CELL_FLAGS.centerRevealed | YR_CELL_FLAGS.edgeRevealed; // 0x03, stored in place

interface Bounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

const validBounds = (b: Bounds) =>
  b.left >= 0 && b.top >= 0 && b.right >= b.left && b.bottom >= b.top && b.right < 512 && b.bottom < 512;

/**
 * Cell bounds: MapClass::MapCoordBounds when plausible, otherwise the box every cell of a [Map] Size= W x H map fits
 * in (the map is a diamond in cell coordinates with X, Y in 0..W+H+1).
 */
function readBounds(memory: GuestMemoryAccessor): Bounds | null {
  const map = YR_SHROUD_GLOBALS.map;
  const at = map + YR_SHROUD_OFFSETS.mapCoordBounds;
  const b = { left: memory.i32(at), top: memory.i32(at + 4), right: memory.i32(at + 8), bottom: memory.i32(at + 12) };
  if (validBounds(b)) return b;
  const width = memory.i32(map + YR_SHROUD_OFFSETS.mapRect + 8);
  const height = memory.i32(map + YR_SHROUD_OFFSETS.mapRect + 12);
  if (!(width > 0 && height > 0 && width + height + 1 < 512)) return null;
  return { left: 0, top: 0, right: width + height + 1, bottom: width + height + 1 };
}

/** The occlusion table from guest memory, or null when it does not look like YR 1.001's (image not loaded/other). */
function readOcclusionTable(memory: GuestMemoryAccessor): Int8Array | null {
  const bytes = memory.bytes(YR_SHROUD_GLOBALS.occlusionTable, 256);
  if (bytes.length !== 256) return null;
  const table = new Int8Array(bytes.buffer, bytes.byteOffset, 256);
  // Spot checks: all neighbours present -> clear; the four edge neighbours missing -> black; a lone corner -> piece.
  if (table[0] !== -1 || table[0xaa] !== -2 || table[0xff] !== -2 || table[0x80] !== 1 || table[0x01] !== 33)
    return null;
  for (const value of table) if (value < -2 || value > 46) return null;
  return table;
}

function arrays(reuse: YrShroud | null | undefined, width: number, height: number, fog: boolean) {
  const size = width * height;
  const same = reuse && reuse.width === width && reuse.height === height && reuse.cells.length === size;
  return {
    cells: same ? reuse.cells : new Uint8Array(size),
    edges: same ? reuse.edges : new Uint8Array(size),
    fogEdges: fog ? (same && reuse.fogEdges ? reuse.fogEdges : new Uint8Array(size)) : null,
  };
}

/**
 * Occlusion of each existing cell from the packed bits in `cells`, the same way TacticalClass::GetOcclusion does:
 * `primary`/`secondary` are the bit pair (0x08/0x10 for shroud, 0x02/0x01 for fog); `outside` holds InvalidCell's
 * packed bits for neighbours without a cell. Writes SHP frame indices into `out`.
 */
function occlusionPass(
  cells: Uint8Array,
  out: Uint8Array,
  width: number,
  height: number,
  table: Int8Array,
  primary: number,
  secondary: number,
  outside: number,
): void {
  const both = primary | secondary;
  const outsideLacks = outside & primary ? 0 : 1;
  /** 1 when a neighbour's packed bits lack `primary` (a missing cell counts as InvalidCell). */
  const lacks = (packed: number) => (packed & EXISTS ? (packed & primary ? 0 : 1) : outsideLacks);
  const frames = new Uint8Array(256);
  for (let mask = 0; mask < 256; mask++) {
    const occlusion = table[mask]!;
    frames[mask] = occlusion === -2 ? YR_SHROUD_FRAME.covered : occlusion === -1 ? YR_SHROUD_FRAME.clear : occlusion;
  }
  for (let y = 0; y < height; y++) {
    const row = y * width;
    const borderRow = y === 0 || y === height - 1;
    for (let x = 0; x < width; x++) {
      const i = row + x;
      const packed = cells[i]!;
      if (!(packed & EXISTS)) {
        out[i] = YR_SHROUD_FRAME.none;
        continue;
      }
      if (!(packed & both)) {
        out[i] = YR_SHROUD_FRAME.covered;
        continue;
      }
      if (!(packed & primary)) {
        out[i] = YR_SHROUD_FRAME.clear;
        continue;
      }
      let mask = 0;
      if (borderRow || x === 0 || x === width - 1) {
        for (const [bit, dx, dy] of YR_SHROUD_NEIGHBOURS) {
          const nx = x + dx,
            ny = y + dy;
          const inside = nx >= 0 && ny >= 0 && nx < width && ny < height;
          if (inside ? lacks(cells[ny * width + nx]!) : outsideLacks) mask |= bit;
        }
      } else {
        // Unrolled YR_SHROUD_NEIGHBOURS for interior cells (the hot path).
        const up = i - width,
          down = i + width;
        mask =
          lacks(cells[up + 1]!) |
          (lacks(cells[i + 1]!) << 1) |
          (lacks(cells[down + 1]!) << 2) |
          (lacks(cells[down]!) << 3) |
          (lacks(cells[down - 1]!) << 4) |
          (lacks(cells[i - 1]!) << 5) |
          (lacks(cells[up - 1]!) << 6) |
          (lacks(cells[up]!) << 7);
      }
      out[i] = frames[mask]!;
    }
  }
}

/**
 * Snapshot of the local player's shroud. Returns null outside a battle (no map, no cell array) or when the memory
 * does not hold YR 1.001; never throws for any memory content. Cost is O(slots in the bounding box): one guest read
 * per slot, three more per existing cell (MapCoords check, AltFlags, Flags), then two passes over the result arrays
 * (about 0.1-0.4 ms for a 60x60 map, 1 ms for 128x128, 4 ms for 200x200 on an Apple M-series host).
 */
export function readYrShroud(memory: GuestMemoryAccessor, options: ReadYrShroudOptions = {}): YrShroud | null {
  const o = YR_SHROUD_OFFSETS;
  const map = YR_SHROUD_GLOBALS.map;
  const table = readOcclusionTable(memory);
  if (!table) return null;
  const items = memory.u32(map + o.cellItems);
  const capacity = memory.i32(map + o.cellCapacity);
  if (!(capacity > 0 && capacity <= MAX_CELLS)) return null;
  if (items < 0x10000 || (items & 3) !== 0 || items + capacity * 4 > memory.size) return null;
  const bounds = readBounds(memory);
  if (!bounds) return null;

  const scenario = memory.u32(YR_SHROUD_GLOBALS.scenario);
  const fogOfWar =
    scenario >= 0x10000 && scenario + 4 <= memory.size
      ? (memory.u32(scenario + o.scenarioFlags) & YR_SCENARIO_FOG_OF_WAR) !== 0
      : false;

  const width = bounds.right - bounds.left + 1;
  const height = bounds.bottom - bounds.top + 1;
  const { cells, edges, fogEdges } = arrays(options.reuse, width, height, fogOfWar);
  const counts = { shrouded: 0, fogged: 0, visible: 0, none: 0, invalid: 0 };

  // Pass 1: pack each slot's AltFlags 0x18 and Flags 0x03 (both already in place) plus EXISTS into `cells`.
  const cellSpan = o.cellFlags + 4;
  for (let y = 0; y < height; y++) {
    const cy = bounds.top + y;
    const row = y * width;
    for (let x = 0; x < width; x++) {
      const cx = bounds.left + x;
      const index = (cy << 9) + cx;
      if (index >= capacity) {
        cells[row + x] = 0;
        continue;
      }
      const cell = memory.u32(items + index * 4);
      if (cell === 0) {
        cells[row + x] = 0;
        continue;
      }
      if (
        cell < 0x10000 ||
        (cell & 3) !== 0 ||
        cell + cellSpan > memory.size ||
        memory.u32(cell + o.cellMapCoords) !== (((cy & 0xffff) << 16) | (cx & 0xffff)) >>> 0
      ) {
        counts.invalid++;
        cells[row + x] = 0;
        continue;
      }
      cells[row + x] =
        EXISTS | (memory.u8(cell + o.cellAltFlags) & ALT_MASK) | (memory.u8(cell + o.cellFlags) & FOG_MASK);
    }
  }
  const invalid = YR_SHROUD_GLOBALS.invalidCell;
  const outside = (memory.u8(invalid + o.cellAltFlags) & ALT_MASK) | (memory.u8(invalid + o.cellFlags) & FOG_MASK);

  // Pass 2: SHP frames, from the packed bits of each cell and its eight neighbours.
  occlusionPass(cells, edges, width, height, table, YR_ALT_CELL_FLAGS.mapped, YR_ALT_CELL_FLAGS.noFog, outside);
  if (fogEdges)
    occlusionPass(
      cells,
      fogEdges,
      width,
      height,
      table,
      YR_CELL_FLAGS.edgeRevealed,
      YR_CELL_FLAGS.centerRevealed,
      outside,
    );

  // Pass 3: packed bits -> YR_SHROUD_STATE.
  for (let i = 0; i < cells.length; i++) {
    const packed = cells[i]!;
    let state: number;
    if (!(packed & EXISTS)) state = YR_SHROUD_STATE.none;
    else if (!(packed & YR_ALT_CELL_FLAGS.mapped)) state = YR_SHROUD_STATE.shrouded;
    else if (fogEdges && fogEdges[i] === YR_SHROUD_FRAME.covered) state = YR_SHROUD_STATE.fogged;
    else state = YR_SHROUD_STATE.visible;
    cells[i] = state;
    if (state === YR_SHROUD_STATE.none) counts.none++;
    else if (state === YR_SHROUD_STATE.shrouded) counts.shrouded++;
    else if (state === YR_SHROUD_STATE.fogged) counts.fogged++;
    else counts.visible++;
  }

  return {
    frame: memory.i32(YR_SHROUD_GLOBALS.frame),
    originX: bounds.left,
    originY: bounds.top,
    width,
    height,
    cells,
    edges,
    fogEdges,
    fogOfWar,
    counts,
  };
}

/** State of cell (x, y) in a snapshot, or YR_SHROUD_STATE.none outside it. */
export function yrShroudAt(shroud: YrShroud, x: number, y: number): number {
  const cx = x - shroud.originX,
    cy = y - shroud.originY;
  if (!(cx >= 0 && cy >= 0 && cx < shroud.width && cy < shroud.height)) return YR_SHROUD_STATE.none;
  return shroud.cells[cy * shroud.width + cx]!;
}

/** Leptons per height level (YRpp Unsorted::LevelHeight; the engine divides by the value stored at 0xABDE88). */
export const YR_LEVEL_HEIGHT = 104;

/**
 * Whether a world location (leptons, e.g. a stateReader object's x/y/z) is under shroud, the way
 * MapClass::IsLocationShrouded (0x586360) decides it: because the shroud is a flat Z = 0 layer, a location at height
 * level L (= trunc(z / 104)) is tested against the flat cell it covers on screen, (X - L/2, Y - L/2) for even L; for
 * odd L it straddles (X - (L+1)/2, Y - (L+1)/2) and its south-east neighbour (+1, +1) and is shrouded only when both
 * are. Cells outside the snapshot count as shrouded (InvalidCell carries no flags in a normal game).
 */
export function isYrLocationShrouded(shroud: YrShroud, x: number, y: number, z: number): boolean {
  const level = Math.trunc(z / YR_LEVEL_HEIGHT);
  const cx = Math.trunc(x / 256),
    cy = Math.trunc(y / 256);
  const mapped = (px: number, py: number) => {
    const state = yrShroudAt(shroud, px, py);
    return state === YR_SHROUD_STATE.visible || state === YR_SHROUD_STATE.fogged;
  };
  if (level & 1) {
    const shift = Math.trunc(level / 2) + 1;
    return !mapped(cx - shift, cy - shift) && !mapped(cx - shift + 1, cy - shift + 1);
  }
  const shift = Math.trunc(level / 2);
  return !mapped(cx - shift, cy - shift);
}

/**
 * Guarded factory: only the pinned YR 1.001 image is supported, and the occlusion table must already be in guest
 * memory (the image is loaded). Each call builds nothing but the result; pass the previous result back through
 * `reuse` to poll without allocating.
 */
export function createYrShroudReader(
  memory: () => GuestMemoryAccessor,
  hash: string,
): ((options?: ReadYrShroudOptions) => YrShroud | null) | null {
  if (hash !== YR_STARTUP_PAGE_HASH) return null;
  if (!readOcclusionTable(memory())) return null;
  return (options) => {
    try {
      return readYrShroud(memory(), options);
    } catch {
      return null;
    }
  };
}
