// Ported from the XCC library by Olaf van der Spek (GPLv3) — misc/tmp_ts_file.h,
// misc/tmp_ts_file.cpp, misc/cc_structures.h. The struct layout, index-table
// convention, and the diamond scanline decode are taken byte-for-byte from XCC;
// the TypeScript class/API surface around them is original Vanguard code.

/**
 * Parser for Tiberian-Sun/Red-Alert-2 isometric terrain tile files (TMP(TS),
 * extensions `.tem` `.sno` `.urb` `.lun` `.des` `.ubn`).
 *
 * A TMP(TS) file packs a rectangular block of isometric cells. Its structure is:
 *
 *   - a 16-byte file header: block count (cx/cy tiles) and the tile pixel
 *     dimensions (always 60x30 in RA2);
 *   - an offset table of `blocksX * blocksY` little-endian int32 entries; an
 *     entry of 0 marks an *empty* tile slot with no data;
 *   - for every present tile, a 52-byte image header followed by the fixed-size
 *     diamond bitmap (cx*cy/2 palette-indexed bytes), and — depending on the
 *     header flags — optional z-data and extra (overlay) graphics.
 *
 * The diamond bitmap is stored as a run of scanlines that widen from the top of
 * the diamond to the middle and then narrow again, exactly matching the XCC
 * `decode_tile` routine.
 */

/** Number of bytes in the file header. */
const FILE_HEADER_SIZE = 16;

/** Number of bytes in a per-tile image header (matches MSVC `sizeof`). */
const IMAGE_HEADER_SIZE = 52;

/** Byte offsets inside the 52-byte image header (little-endian). */
const IMG = {
  x: 0,
  y: 4,
  extraOfs: 8,
  zOfs: 12,
  extraZOfs: 16,
  xExtra: 20,
  yExtra: 24,
  cxExtra: 28,
  cyExtra: 32,
  flags: 36,
  height: 40,
  terrainType: 41,
  rampType: 42,
  radarRedLeft: 43,
  radarGreenLeft: 44,
  radarBlueLeft: 45,
  radarRedRight: 46,
  radarGreenRight: 47,
  radarBlueRight: 48,
} as const;

/** Bit flags packed into the image header's `flags` word. */
const FLAG_HAS_EXTRA_DATA = 0x1;
const FLAG_HAS_Z_DATA = 0x2;
const FLAG_HAS_DAMAGED_DATA = 0x4;

/** An RGB triple (0-255 per channel) from a tile's radar-minimap colours. */
export interface RadarColor {
  readonly red: number;
  readonly green: number;
  readonly blue: number;
}

/**
 * A single decoded isometric tile. All bitmaps are palette-indexed (one byte
 * per pixel); callers resolve the indices against a theater palette.
 */
export interface TmpTile {
  /** Index of this tile in the file's offset table. */
  readonly index: number;
  /** Screen X offset of the tile's diamond within the tile block, in pixels. */
  readonly x: number;
  /** Screen Y offset of the tile's diamond within the tile block, in pixels. */
  readonly y: number;
  /** Cell height level (number of half-cell steps this tile is raised). */
  readonly height: number;
  /** Ramp/slope type index (0 = flat; non-zero encodes a slope direction). */
  readonly rampType: number;
  /** Terrain type index (surface class used by pathfinding/placement). */
  readonly terrainType: number;
  /** Left radar-minimap colour for this cell. */
  readonly radarLeft: RadarColor;
  /** Right radar-minimap colour for this cell. */
  readonly radarRight: RadarColor;
  /** True if the tile carries extra overlay graphics. */
  readonly hasExtraData: boolean;
  /** True if the tile carries per-pixel z (depth) data. */
  readonly hasZData: boolean;
  /** True if the tile carries a damaged-state variant. */
  readonly hasDamagedData: boolean;
  /**
   * The tile's diamond bitmap expanded into a dense `width x height` raster
   * (row-major, palette indices, 0 outside the diamond). Length is
   * `width * height`.
   */
  readonly bitmap: Uint8Array;
  /**
   * The tile's per-pixel z-data, laid out in the same diamond scanline order as
   * the raw bitmap (length `width * height / 2`), or `undefined` when absent.
   */
  readonly zData?: Uint8Array;
  /** The extra overlay graphics, or `undefined` when {@link hasExtraData} is false. */
  readonly extra?: TmpExtraGraphics;
}

/** Extra overlay graphics attached to a tile (e.g. cliff faces, slope tops). */
export interface TmpExtraGraphics {
  /** Screen X offset of the overlay, in pixels. */
  readonly x: number;
  /** Screen Y offset of the overlay, in pixels. */
  readonly y: number;
  /** Overlay width in pixels. */
  readonly width: number;
  /** Overlay height in pixels. */
  readonly height: number;
  /**
   * The overlay bitmap, `width * height` palette indices, row-major. Index 0 is
   * transparent (skipped when compositing).
   */
  readonly bitmap: Uint8Array;
  /**
   * Per-pixel z (depth) bytes of the overlay, `width * height`, row-major like {@link bitmap}; `undefined` when the
   * tile has no z-data flag or no extra z offset. The engine adds each byte to the cell's depth baseline exactly as
   * it does for the diamond's {@link TmpTile.zData}.
   */
  readonly zData?: Uint8Array;
}

/**
 * A parsed TMP(TS) isometric tile file. Construct with {@link TmpFile.parse}.
 */
export class TmpFile {
  private constructor(
    /** Tile-block width in tiles. */
    readonly blocksX: number,
    /** Tile-block height in tiles. */
    readonly blocksY: number,
    /** Tile pixel width (60 in RA2). */
    readonly tileWidth: number,
    /** Tile pixel height (30 in RA2). */
    readonly tileHeight: number,
    /** Offset table; index 0 marks an empty (absent) tile slot. */
    private readonly offsets: readonly number[],
    private readonly data: Uint8Array,
  ) {}

  /**
   * Parse `data` as a TMP(TS) file.
   *
   * @throws {RangeError} if the header, offset table, or any referenced tile
   *   header lies outside the buffer.
   */
  static parse(data: Uint8Array): TmpFile {
    if (data.length < FILE_HEADER_SIZE) {
      throw new RangeError(
        `TMP file too small: ${data.length} bytes < ${FILE_HEADER_SIZE}-byte header`,
      );
    }
    const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const blocksX = dv.getInt32(0, true);
    const blocksY = dv.getInt32(4, true);
    const tileWidth = dv.getInt32(8, true);
    const tileHeight = dv.getInt32(12, true);

    if (blocksX <= 0 || blocksY <= 0) {
      throw new RangeError(`TMP has invalid block count ${blocksX}x${blocksY}`);
    }
    // RA2/TS tiles are 60x30; TS also allowed 48x24. Height must be half width.
    // The ceiling bounds `expandDiamond`'s `tileWidth*tileHeight` allocation: an
    // int32 tileWidth of 46340 passes the half-height check yet allocates ~1 GB, so a
    // corrupt terrain tile would OOM the dev server. Real tiles are ≤ a few thousand
    // pixels; 1M is far above any RA2 tile and never rejects valid data.
    if (tileWidth <= 0 || 2 * tileHeight !== tileWidth || tileWidth * tileHeight > (1 << 20)) {
      throw new RangeError(
        `TMP has invalid tile dimensions ${tileWidth}x${tileHeight} (height must be half width)`,
      );
    }

    const tileCount = blocksX * blocksY;
    const tableEnd = FILE_HEADER_SIZE + 4 * tileCount;
    if (tableEnd > data.length) {
      throw new RangeError(
        `TMP offset table (${tileCount} entries) overruns buffer of ${data.length} bytes`,
      );
    }

    const offsets: number[] = new Array<number>(tileCount);
    for (let i = 0; i < tileCount; i++) {
      const ofs = dv.getInt32(FILE_HEADER_SIZE + 4 * i, true);
      // Present tiles must have a header that fits; empty slots are 0.
      if (ofs !== 0 && (ofs < 0 || ofs + IMAGE_HEADER_SIZE > data.length)) {
        throw new RangeError(
          `TMP tile ${i} offset ${ofs} points outside buffer of ${data.length} bytes`,
        );
      }
      offsets[i] = ofs;
    }

    return new TmpFile(blocksX, blocksY, tileWidth, tileHeight, offsets, data);
  }

  /** Total number of tile slots (`blocksX * blocksY`), including empty ones. */
  get tileCount(): number {
    return this.offsets.length;
  }

  /** Number of bytes in one tile's diamond bitmap scanline data (`w * h / 2`). */
  get diamondByteCount(): number {
    return (this.tileWidth * this.tileHeight) >> 1;
  }

  /** True if the tile slot at `index` is empty (offset 0, no data). */
  isEmpty(index: number): boolean {
    this.checkIndex(index);
    return this.offsets[index] === 0;
  }

  /**
   * Decode the tile at `index`, or return `undefined` for an empty slot.
   *
   * @throws {RangeError} if `index` is out of range or the tile's pixel data
   *   overruns the buffer.
   */
  getTile(index: number): TmpTile | undefined {
    this.checkIndex(index);
    const base = this.offsets[index]!;
    if (base === 0) return undefined;

    const data = this.data;
    const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);

    const flags = dv.getUint32(base + IMG.flags, true);
    const hasExtraData = (flags & FLAG_HAS_EXTRA_DATA) !== 0;
    const hasZData = (flags & FLAG_HAS_Z_DATA) !== 0;
    const hasDamagedData = (flags & FLAG_HAS_DAMAGED_DATA) !== 0;

    const diamondBytes = this.diamondByteCount;
    const imageStart = base + IMAGE_HEADER_SIZE;
    if (imageStart + diamondBytes > data.length) {
      throw new RangeError(
        `TMP tile ${index} diamond data overruns buffer (${imageStart + diamondBytes} > ${data.length})`,
      );
    }
    const raw = data.subarray(imageStart, imageStart + diamondBytes);
    const bitmap = this.expandDiamond(raw);

    let zData: Uint8Array | undefined;
    if (hasZData) {
      const zOfs = dv.getInt32(base + IMG.zOfs, true);
      const zStart = base + zOfs;
      if (zOfs > 0 && zStart + diamondBytes <= data.length) {
        zData = data.slice(zStart, zStart + diamondBytes);
      }
    }

    let extra: TmpExtraGraphics | undefined;
    if (hasExtraData) {
      extra = this.readExtra(dv, data, base, hasZData);
    }

    const tile: TmpTile = {
      index,
      x: dv.getInt32(base + IMG.x, true),
      y: dv.getInt32(base + IMG.y, true),
      height: dv.getInt8(base + IMG.height),
      rampType: dv.getInt8(base + IMG.rampType),
      terrainType: dv.getInt8(base + IMG.terrainType),
      radarLeft: {
        red: dv.getUint8(base + IMG.radarRedLeft),
        green: dv.getUint8(base + IMG.radarGreenLeft),
        blue: dv.getUint8(base + IMG.radarBlueLeft),
      },
      radarRight: {
        red: dv.getUint8(base + IMG.radarRedRight),
        green: dv.getUint8(base + IMG.radarGreenRight),
        blue: dv.getUint8(base + IMG.radarBlueRight),
      },
      hasExtraData,
      hasZData,
      hasDamagedData,
      bitmap,
      // `zData`/`extra` are omitted (not set to undefined) when absent, to
      // satisfy exactOptionalPropertyTypes.
      ...(zData ? { zData } : {}),
      ...(extra ? { extra } : {}),
    };
    return tile;
  }

  /**
   * Iterate the decoded, non-empty tiles in table order.
   */
  *tiles(): Generator<TmpTile> {
    for (let i = 0; i < this.offsets.length; i++) {
      const t = this.getTile(i);
      if (t) yield t;
    }
  }

  /**
   * Expand the diamond scanline data into a dense `tileWidth x tileHeight`
   * raster (row-major, index 0 outside the diamond). Ported from XCC
   * `decode_tile`: the diamond widens by four pixels per row down to the middle
   * scanline, then narrows again. {@link TmpTile.zData} uses the same packed layout, so callers expand it with this
   * method too.
   */
  expandDiamond(raw: Uint8Array): Uint8Array {
    const w = this.tileWidth;
    const h = this.tileHeight;
    const out = new Uint8Array(w * h);
    let r = 0; // read cursor into raw
    let x = w >> 1; // left edge of the current scanline
    let cx = 0; // width of the current scanline
    let y = 0;
    const half = h >> 1;
    // Top half: scanlines widen.
    for (; y < half; y++) {
      cx += 4;
      x -= 2;
      out.set(raw.subarray(r, r + cx), y * w + x);
      r += cx;
    }
    // Bottom half: scanlines narrow.
    for (; y < h; y++) {
      cx -= 4;
      x += 2;
      out.set(raw.subarray(r, r + cx), y * w + x);
      r += cx;
    }
    return out;
  }

  /** Read and expand the extra overlay graphics for a present tile. */
  private readExtra(dv: DataView, data: Uint8Array, base: number, hasZData: boolean): TmpExtraGraphics {
    const x = dv.getInt32(base + IMG.xExtra, true);
    const y = dv.getInt32(base + IMG.yExtra, true);
    const width = dv.getInt32(base + IMG.cxExtra, true);
    const height = dv.getInt32(base + IMG.cyExtra, true);
    const extraOfs = dv.getInt32(base + IMG.extraOfs, true);
    const start = base + extraOfs;
    const count = width * height;
    if (width <= 0 || height <= 0 || extraOfs <= 0 || start + count > data.length) {
      throw new RangeError(
        `TMP extra graphics for tile at ${base} are invalid or overrun the buffer`,
      );
    }
    // Extra graphics are stored as a plain width*height row-major raster.
    const bitmap = data.slice(start, start + count);
    // Extra z-data has the same plain raster layout (XCC `get_z_extra_data`); it exists only with the z-data flag.
    const extraZOfs = hasZData ? dv.getInt32(base + IMG.extraZOfs, true) : 0;
    const zStart = base + extraZOfs;
    if (extraZOfs > 0 && zStart + count <= data.length) {
      return { x, y, width, height, bitmap, zData: data.slice(zStart, zStart + count) };
    }
    return { x, y, width, height, bitmap };
  }

  private checkIndex(index: number): void {
    if (!Number.isInteger(index) || index < 0 || index >= this.offsets.length) {
      throw new RangeError(
        `tile index ${index} out of range [0, ${this.offsets.length})`,
      );
    }
  }
}
