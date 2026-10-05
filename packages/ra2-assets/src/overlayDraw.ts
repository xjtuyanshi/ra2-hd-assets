/**
 * Engine draw point of cell overlays (pure, no imports: the HD renderer reads the per-cell part at run time).
 *
 * Screen rows follow iso.ts: a cell is a 60x30 diamond whose centre lies 15 px under its top corner, and one height
 * level is 15 px.
 */
const CELL_CENTRE_Y = 15;
const LEVEL_ROWS = 15;

/** The rules facts of an OverlayType that move its draw point (see overlayDrawOffset). */
export interface OverlayDrawRule {
  /** Position in the [OverlayTypes] registry; the engine keys three of its rules on it. */
  index: number;
  wall?: boolean;
  tiberium?: boolean;
  crate?: boolean;
  /** Rules Land=Railroad. */
  railroad?: boolean;
}

/**
 * [OverlayTypes] indexes the overlay placement (YR 1.001 @0x5FC570) turns into bridge-owner cells: stock BRIDGE1,
 * BRIDGE2, BRIDGEB1 and BRIDGEB2. Only these cells take the high-bridge draw path of CellClass::DrawOverlay.
 */
export const HIGH_BRIDGE_OVERLAY_INDEXES: readonly number[] = [24, 25, 237, 238];
/** Index the engine draws half a cell higher (stock RUBBLE_OVERLAY: the source building's own draw point). */
export const RUBBLE_OVERLAY_INDEX = 239;
/** Index with the vein offsets (stock DUMMYOLD, Tiberian Sun's VEINS; it has no art in YR). */
export const VEINS_OVERLAY_INDEX = 126;
/** First OverlayData of the second high-bridge direction; a bridge owner's frames are 0..8 and 9..17. */
export const HIGH_BRIDGE_SECOND_DIRECTION = 9;

export function isHighBridgeOverlayIndex(index: number): boolean {
  return HIGH_BRIDGE_OVERLAY_INDEXES.includes(index);
}

/**
 * Engine draw point of an overlay (SHP canvas centre) relative to the projected top corner of its cell at the
 * cell's own level. Read from YR 1.001: CellClass::DrawOverlay (0x47F6A0) draws every overlay centred on
 * `cell corner at Z=0 + the cell's overlay offset (0x480110)`, and that offset is
 *   (30, 15 - 15 x Level) from the 60x30 cell box, i.e. the cell centre at the cell's level, plus
 *   the type offset (0x5FDCC0): -12 for Tiberium, Wall, Crate or index 126; a further -1 for Land=Railroad and
 *   a further -1 for index 126;
 *   on a bridge-owner cell -16, and -15 more while OverlayData is 9..17; otherwise -15 for index 239.
 * IsARock and DrawFlat change only the Z arguments of the blit, never the screen position. Frozen original frames
 * of six maps agree to the pixel: walls, ore and gems (0, 3), tracks (0, 14), low bridges, fences, props and rocks
 * (0, 15), BRIDGE1 (0, -1), BRIDGE2 (0, -16); the high-bridge frames carry the four-level lift of the deck.
 */
export function overlayDrawOffset(rule: OverlayDrawRule, overlayData = 0): [number, number] {
  let y = CELL_CENTRE_Y;
  if (rule.tiberium || rule.wall || rule.crate || rule.index === VEINS_OVERLAY_INDEX) y -= 12;
  if (rule.railroad) y -= 1;
  if (rule.index === VEINS_OVERLAY_INDEX) y -= 1;
  if (isHighBridgeOverlayIndex(rule.index)) y -= 16 + highBridgeCell(overlayData, 0, 0).lift;
  else if (rule.index === RUBBLE_OVERLAY_INDEX) y -= LEVEL_ROWS;
  return [0, y];
}

/**
 * Frame variants of an intact high-bridge deck cell (YR 1.001 table @0x81CC30), indexed (cellY & 3) * 4 + (cellX & 3).
 */
const HIGH_BRIDGE_VARIANTS: readonly number[] = [0, 1, 2, 3, 3, 2, 1, 0, 2, 3, 0, 1, 1, 0, 3, 2];

/**
 * What a bridge-owner cell draws (CellClass::DrawOverlay @0x47F7B1 and 0x480131): OverlayData 0 and 9 are the intact
 * deck of the two directions and take one of four art variants by cell position, every other value is its own
 * frame; `lift` is the extra screen rise of the second direction's frames (9..17) over overlayDrawOffset(rule, 0).
 */
export function highBridgeCell(overlayData: number, x: number, y: number): { frame: number; lift: number } {
  const intact = overlayData === 0 || overlayData === HIGH_BRIDGE_SECOND_DIRECTION;
  const frame = intact ? overlayData + HIGH_BRIDGE_VARIANTS[((y & 3) << 2) | (x & 3)]! : overlayData;
  const second = overlayData >= HIGH_BRIDGE_SECOND_DIRECTION && overlayData <= 17;
  return { frame, lift: second ? LEVEL_ROWS : 0 };
}
