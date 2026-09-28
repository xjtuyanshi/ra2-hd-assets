// Ported from the XCC library by Olaf van der Spek (GPLv3) — misc/palet.cpp, misc/pal_file.h
//
// Westwood PAL palette parser for Red Alert 2 / Yuri's Revenge (and Tiberian
// Sun). A PAL is exactly 768 bytes: 256 consecutive RGB triplets, each channel
// stored as a 6-bit VGA value (0..63). The engine expands these to 8-bit
// byte-exactly with XCC's convert_palet_18_to_24 (palet.cpp:132-140):
// `(c & 63) * 255 / 63`. The mask drops any stray high bits in a specimen file,
// and the `* 255 / 63` scale spreads 0..63 across the full 0..255 range so the
// maximum 6-bit value 63 reaches a true white 255 (not 252 as a bare `<< 2`
// would give). Integer division truncates, matching XCC's C++ semantics exactly.

/** Number of color entries in a PAL palette. */
export const PALETTE_ENTRY_COUNT = 256;

/** Size in bytes of a well-formed PAL file (256 * 3). */
export const PAL_FILE_SIZE = PALETTE_ENTRY_COUNT * 3;

/**
 * Player-remap palette index range for RA2/YR SHP art. Palette indices 16..31
 * (inclusive) are the "remap" ramp: the game substitutes the owning player's
 * house color for these entries at draw time. Consumers that want to recolor a
 * unit per-player key on this range. Exposed here so both palette and sprite
 * layers share a single source of truth.
 */
export const REMAP_INDEX_START = 16;
/** Last player-remap palette index (inclusive). See {@link REMAP_INDEX_START}. */
export const REMAP_INDEX_END = 31;

/** A single decoded palette entry with 8-bit channels. */
export interface PaletteColor {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

/**
 * A decoded 256-color palette. Channels are expanded to 8-bit. The raw 6-bit
 * source values are scaled to 8-bit by masking to 6 bits then applying XCC's
 * `(c & 63) * 255 / 63`, so the range 0..63 maps onto the full 0..255.
 */
export class Palette {
  /**
   * Packed 8-bit RGB, 3 bytes per entry (768 bytes total). Index `i`'s red byte
   * is at `rgb[i * 3]`. This is a private-facing view; use {@link rgb} for a
   * shared read-only handle or {@link rgba} for composited output.
   */
  private readonly data: Uint8Array;

  private constructor(data: Uint8Array) {
    this.data = data;
  }

  /**
   * Parse a 768-byte PAL buffer. Throws if the buffer is not exactly
   * {@link PAL_FILE_SIZE} bytes, which is the only valid PAL length.
   */
  static parse(bytes: Uint8Array): Palette {
    if (bytes.length !== PAL_FILE_SIZE) {
      throw new Error(
        `PAL must be exactly ${PAL_FILE_SIZE} bytes, got ${bytes.length}`,
      );
    }
    const out = new Uint8Array(PAL_FILE_SIZE);
    for (let i = 0; i < PAL_FILE_SIZE; i++) {
      // Mask to 6 bits (VGA DAC width) then scale to 8 bits with XCC's
      // convert_palet_18_to_24: (c & 63) * 255 / 63, integer-truncated.
      out[i] = Math.trunc((((bytes[i] as number) & 0x3f) * 255) / 63);
    }
    return new Palette(out);
  }

  /** Number of entries (always 256). */
  get length(): number {
    return PALETTE_ENTRY_COUNT;
  }

  /**
   * A read-only view of the packed 8-bit RGB bytes (768 bytes, 3 per entry).
   * The returned array shares storage with the palette; do not mutate it.
   */
  get rgb(): Uint8Array {
    return this.data;
  }

  /** The 8-bit color at `index` (0..255). Throws if out of range. */
  color(index: number): PaletteColor {
    if (index < 0 || index >= PALETTE_ENTRY_COUNT || !Number.isInteger(index)) {
      throw new RangeError(`palette index out of range: ${index}`);
    }
    const p = index * 3;
    return {
      r: this.data[p] as number,
      g: this.data[p + 1] as number,
      b: this.data[p + 2] as number,
    };
  }

  /**
   * The color at `index` packed as an RGBA byte quad `[r, g, b, a]`. `alpha`
   * defaults to fully opaque (255). By the RA2 convention, palette index 0 is
   * the transparent color for sprites; callers that need per-sprite
   * transparency should test the index themselves and pass `alpha = 0`.
   */
  rgba(index: number, alpha = 0xff): [number, number, number, number] {
    const c = this.color(index);
    return [c.r, c.g, c.b, alpha & 0xff];
  }
}
