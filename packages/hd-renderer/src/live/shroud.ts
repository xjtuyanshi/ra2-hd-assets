import { DataTexture, LinearFilter, RedFormat, UnsignedByteType } from 'three/webgpu';

/** Per-cell state as the live reader reports it: 0 = shroud, 1 = fog, 2 = visible, 0xff = no cell. */
export interface ShroudCells {
  originX: number;
  originY: number;
  width: number;
  height: number;
  cells: Uint8Array;
}

const VISIBLE = 2;
const FOGGED = 1;
const LEPTONS_PER_CELL = 256;
const LEPTONS_PER_LEVEL = 104;

/**
 * The local player's shroud and fog, applied like the engine: a darkening layer on the flat Z = 0 plane (not following
 * the terrain) that covers terrain, objects and effects alike. On an elevated map a cell's shroud therefore lands on
 * the terrain one row "behind" it on screen, exactly as in the original. One texel per cell with linear filtering
 * gives the soft darkened band the engine's edge pieces produce.
 *
 * The layer is a visibility mask (`texture`) the HD renderer applies in its post pass (HdRenderer.setVisibility),
 * after the mist and before bloom: drawn inside the scene it would sit under the mist, whose light-field glow would
 * then show lit buildings and lamps through black shroud.
 */
export class ShroudLayer {
  /** R: 255 visible, 128 fog, 0 shroud; texel i is centred on cell i + 0.5 (world x / width addresses it). */
  readonly texture: DataTexture;
  private readonly data: Uint8Array;
  private latest: ShroudCells | null = null;

  constructor(
    readonly width: number,
    readonly height: number,
  ) {
    // Until the first update everything is visible (no shroud information yet).
    this.data = new Uint8Array(width * height).fill(255);
    this.texture = new DataTexture(this.data, width, height, RedFormat, UnsignedByteType);
    this.texture.magFilter = LinearFilter;
    this.texture.minFilter = LinearFilter;
    this.texture.needsUpdate = true;
  }

  update(shroud: ShroudCells): void {
    this.latest = shroud;
    for (let y = 0; y < this.height; y++)
      for (let x = 0; x < this.width; x++) {
        const state = cellState(shroud, x, y);
        // Fog is the engine's half-light FOG.SHP; missing cells stay dark like the unexplored border.
        this.data[y * this.width + x] = state === VISIBLE ? 255 : state === FOGGED ? 128 : 0;
      }
    this.texture.needsUpdate = true;
  }

  /**
   * The engine's MapClass::IsLocationShrouded for a lepton location: the shroud is a flat Z = 0 layer, so an object at
   * height level L is tested against the flat cell it covers on screen, (X - L/2, Y - L/2); an odd level straddles two
   * cells and is hidden only when both are shrouded. Everything is visible before the first update.
   */
  isLocationShrouded(x: number, y: number, z: number): boolean {
    const shroud = this.latest;
    if (!shroud) return false;
    const level = Math.trunc(z / LEPTONS_PER_LEVEL);
    const cx = Math.trunc(x / LEPTONS_PER_CELL);
    const cy = Math.trunc(y / LEPTONS_PER_CELL);
    const mapped = (px: number, py: number) => {
      const state = cellState(shroud, px, py);
      return state === VISIBLE || state === FOGGED;
    };
    if (level & 1) {
      const shift = Math.trunc(level / 2) + 1;
      return !mapped(cx - shift, cy - shift) && !mapped(cx - shift + 1, cy - shift + 1);
    }
    const shift = Math.trunc(level / 2);
    return !mapped(cx - shift, cy - shift);
  }
}

function cellState(shroud: ShroudCells, x: number, y: number): number {
  const sx = x - shroud.originX;
  const sy = y - shroud.originY;
  if (sx < 0 || sy < 0 || sx >= shroud.width || sy >= shroud.height) return 0xff;
  return shroud.cells[sy * shroud.width + sx]!;
}
