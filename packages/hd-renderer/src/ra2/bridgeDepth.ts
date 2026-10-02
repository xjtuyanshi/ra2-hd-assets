import { LEVEL_HEIGHT } from '../world';

/** Stock high decks: the cell pass (0x47F6A0), not a Ground-layer registration. */
export function isHighBridge(type: string): boolean {
  return /^(BRIDGE[12]|BRIDGEB[12]|RAILBRDG[12])$/i.test(type);
}

/** The library already projects the stock deck four levels above its cell with a -60 px draw offset. */
export const HIGH_BRIDGE_HEIGHT = 4 * LEVEL_HEIGHT;
