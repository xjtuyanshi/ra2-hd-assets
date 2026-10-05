import { LEVEL_HEIGHT } from '../world';

/** Stock high decks: the cell pass (0x47F6A0), not a Ground-layer registration. */
export function isHighBridge(type: string): boolean {
  return /^(BRIDGE[12]|BRIDGEB[12]|RAILBRDG[12])$/i.test(type);
}

/**
 * Height of a stock deck over its owner cell: four levels. The deck art itself carries that rise inside its frames
 * (the engine draws them at the cell, see ra2-assets iso.ts overlayDrawOffset), so this only places the deck's depth
 * plane and the ground of what stands on it.
 */
export const HIGH_BRIDGE_HEIGHT = 4 * LEVEL_HEIGHT;

/**
 * Brightness of a stock deck relative to its owner cell. The engine lights a bridge-owner overlay with the cell's
 * light four levels up, the deck's own height, not with the river's: its cell light update (YR 1.001 @0x484680)
 * builds the bridge intensity (+0x10E) from Level light x (Level + 4) - Ground where the cell's own (+0x10A) takes
 * Level, and DrawOverlay passes that field for bridge owners (0x47F7E0). Light sources add the same amount to both
 * and are left out here; both ends clamp to the engine's 0..2 range.
 */
export function highBridgeLight(lighting: { ambient: number; ground: number; level: number }, level: number): number {
  const at = (z: number): number => Math.max(0, Math.min(2, lighting.ambient - lighting.ground + lighting.level * z));
  const cell = at(level);
  return cell > 0 ? at(level + 4) / cell : 1;
}
