/**
 * Theater tables and terrain tile-slot resolution (pure; no I/O).
 *
 * Tile numbering follows the engine: every `[TileSetNNNN]` section of the theater control INI (read in numeric order
 * starting at 0000, stopping at the first missing number) contributes `TilesInSet` consecutive global tile numbers,
 * and template `i` (1-based) of a set lives in `<FileName><ii>.<ext>`. The map's IsoMapPack5 `tileNum` indexes that
 * global list and `subTile` selects the cell inside the template's TMP file.
 *
 * Knowledge adapted from Vanguard (harshilmathur/openra2 @ 8ba59f0, apps/client/dev/theater.ts, GPL-3.0-or-later),
 * with the engine's sequential set walk and clear-tile rules added here.
 */

export type TheaterId = 'temperate' | 'snow' | 'urban' | 'newurban' | 'desert' | 'lunar';

export interface TheaterInfo {
  id: TheaterId;
  /** Control INI holding [General] and the [TileSetNNNN] table (YR names). */
  controlIni: string;
  /** Extension of terrain templates and of `Theater=yes` art (trees, smudges, some overlays). */
  ext: string;
  /** Letter substituted as the 2nd character of `NewTheater=yes` image names (G is the generic fallback). */
  newTheaterLetter: string;
  /** Tile palette (iso<th>.pal). */
  isoPalette: string;
  /** Unit/building/infantry/voxel palette (unit<th>.pal). */
  unitPalette: string;
  /** Plain theater palette (<theater>.pal), used by overlays such as ore/gems and bridges. */
  theaterPalette: string;
  /**
   * Nested theater MIX archives in engine priority order (highest first). The YR engine mounts the MD variant
   * before the RA2 one so YR data wins.
   */
  mixes: string[];
}

export const THEATERS: Readonly<Record<TheaterId, TheaterInfo>> = {
  temperate: {
    id: 'temperate',
    controlIni: 'temperatmd.ini',
    ext: 'tem',
    newTheaterLetter: 'T',
    isoPalette: 'isotem.pal',
    unitPalette: 'unittem.pal',
    theaterPalette: 'temperat.pal',
    mixes: ['isotemmd.mix', 'isotemp.mix', 'temperat.mix', 'tem.mix'],
  },
  snow: {
    id: 'snow',
    controlIni: 'snowmd.ini',
    ext: 'sno',
    newTheaterLetter: 'A',
    isoPalette: 'isosno.pal',
    unitPalette: 'unitsno.pal',
    theaterPalette: 'snow.pal',
    mixes: ['isosnomd.mix', 'snowmd.mix', 'isosnow.mix', 'snow.mix', 'sno.mix'],
  },
  urban: {
    id: 'urban',
    controlIni: 'urbanmd.ini',
    ext: 'urb',
    newTheaterLetter: 'U',
    isoPalette: 'isourb.pal',
    unitPalette: 'uniturb.pal',
    theaterPalette: 'urban.pal',
    mixes: ['isourbmd.mix', 'isourb.mix', 'urban.mix', 'urb.mix'],
  },
  newurban: {
    id: 'newurban',
    controlIni: 'urbannmd.ini',
    ext: 'ubn',
    newTheaterLetter: 'N',
    isoPalette: 'isoubn.pal',
    unitPalette: 'unitubn.pal',
    theaterPalette: 'urbann.pal',
    mixes: ['isoubnmd.mix', 'isoubn.mix', 'urbann.mix', 'ubn.mix'],
  },
  desert: {
    id: 'desert',
    controlIni: 'desertmd.ini',
    ext: 'des',
    newTheaterLetter: 'D',
    isoPalette: 'isodes.pal',
    unitPalette: 'unitdes.pal',
    theaterPalette: 'desert.pal',
    mixes: ['isodesmd.mix', 'isodes.mix', 'desert.mix', 'des.mix'],
  },
  lunar: {
    id: 'lunar',
    controlIni: 'lunarmd.ini',
    ext: 'lun',
    newTheaterLetter: 'L',
    isoPalette: 'isolun.pal',
    unitPalette: 'unitlun.pal',
    theaterPalette: 'lunar.pal',
    mixes: ['isolunmd.mix', 'isolun.mix', 'lunar.mix', 'lun.mix'],
  },
};

/** Map a `[Map] Theater=` value to a theater id (case-insensitive); undefined when unknown. */
export function theaterFromMap(value: string): TheaterId | undefined {
  const v = value.trim().toLowerCase();
  return v in THEATERS ? (v as TheaterId) : undefined;
}

/** Minimal INI view the tile-set walk needs (satisfied by ra2-formats' IniFile). */
export interface TileSetIni {
  getSection(
    name: string,
  ): { getString(key: string, fallback?: string): string; getInt(key: string, fallback?: number): number } | undefined;
}

export interface TileSet {
  /** TileSetNNNN number. */
  index: number;
  name: string;
  fileName: string;
  /** First global tile number of the set. */
  start: number;
  count: number;
}

export interface TileSlot {
  /** Global tile number. */
  tileNum: number;
  /** Template file name, e.g. "clat12.tem". */
  file: string;
  /** Owning TileSetNNNN number. */
  setIndex: number;
}

export interface TileTable {
  sets: TileSet[];
  slots: TileSlot[];
  /** Global tile number of the first template of the [General] ClearTile set (the implicit ground). */
  clearTileNum: number;
}

const pad4 = (n: number): string => String(n).padStart(4, '0');

/**
 * Walk `[TileSet0000]`, `[TileSet0001]`, ... exactly like the engine: numeric order, stop at the first missing
 * section, every set contributes `TilesInSet` global numbers (even when its files are absent).
 */
export function buildTileTable(ini: TileSetIni, ext: string): TileTable {
  const sets: TileSet[] = [];
  const slots: TileSlot[] = [];
  let next = 0;
  for (let index = 0; index < 10000; index++) {
    const sec = ini.getSection(`TileSet${pad4(index)}`);
    if (!sec) break;
    const fileName = sec.getString('FileName', '').trim().toLowerCase();
    const count = Math.max(0, sec.getInt('TilesInSet', 0));
    sets.push({ index, name: sec.getString('SetName', ''), fileName, start: next, count });
    for (let i = 1; i <= count; i++) {
      slots.push({ tileNum: next, file: `${fileName}${String(i).padStart(2, '0')}.${ext}`, setIndex: index });
      next++;
    }
  }
  const general = ini.getSection('General');
  const clearSet = general ? general.getInt('ClearTile', 0) : 0;
  const clearTileNum = sets.find((s) => s.index === clearSet)?.start ?? 0;
  return { sets, slots, clearTileNum };
}

/** IsoMapPack5's "no explicit tile" sentinel. */
export const CLEAR_TILE_SENTINEL = 0xffff;

/** Template geometry needed to pick sub-tiles (blocksX x blocksY slots, some possibly empty). */
export interface TemplateShape {
  blocksX: number;
  blocksY: number;
  /** True when the slot at `index` holds no tile. */
  isEmpty(index: number): boolean;
}

/**
 * The template slot the engine draws for the clear ground at cell (x, y). The clear template is a
 * `blocksX x blocksY` pattern (vanilla clear01 is 4x4 on some theaters, 1x1 on others) tiled across the map by
 * cell position, which is what avoids a visibly repeating single diamond. Empty slots fall back to slot 0.
 */
export function clearSubTile(x: number, y: number, shape: TemplateShape): number {
  const bx = Math.max(1, shape.blocksX);
  const by = Math.max(1, shape.blocksY);
  const sub = (((x % bx) + bx) % bx) + (((y % by) + by) % by) * bx;
  return sub < bx * by && !shape.isEmpty(sub) ? sub : 0;
}

export interface ResolvedCellTile {
  tileNum: number;
  subTile: number;
  /** True when the cell's own tile was replaced by the clear ground. */
  substituted: boolean;
}

/**
 * Resolve the (tileNum, subTile) the engine actually draws for an IsoMapPack5 cell: the 0xffff sentinel and any
 * out-of-range tile number mean "clear ground"; an out-of-range or empty sub-tile of a real template also falls
 * back to clear so a cell is never left black.
 */
export function resolveCellTile(
  cell: { x: number; y: number; tileNum: number; subTile: number },
  table: TileTable,
  shapeOf: (tileNum: number) => TemplateShape | undefined,
): ResolvedCellTile | undefined {
  const clear = (): ResolvedCellTile | undefined => {
    const shape = shapeOf(table.clearTileNum);
    if (!shape) return undefined;
    return { tileNum: table.clearTileNum, subTile: clearSubTile(cell.x, cell.y, shape), substituted: true };
  };
  const n = cell.tileNum;
  if (n === CLEAR_TILE_SENTINEL || n < 0 || n >= table.slots.length) return clear();
  if (n === table.clearTileNum) {
    // Explicitly placed clear ground is drawn with the same positional pattern as implicit clear ground.
    const shape = shapeOf(n);
    if (!shape) return undefined;
    return { tileNum: n, subTile: clearSubTile(cell.x, cell.y, shape), substituted: false };
  }
  const shape = shapeOf(n);
  if (!shape) return clear();
  if (cell.subTile >= shape.blocksX * shape.blocksY || shape.isEmpty(cell.subTile)) return clear();
  return { tileNum: n, subTile: cell.subTile, substituted: false };
}
