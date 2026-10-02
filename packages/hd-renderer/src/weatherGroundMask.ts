import { DataTexture, NearestFilter, RedFormat, UnsignedByteType } from 'three/webgpu';

/** Cell-aligned footprint supplied by the scene owner, independent of object type or game coordinates. */
export interface WeatherFoundation {
  x: number;
  z: number;
  width: number;
  height: number;
}

/**
 * Derive static exclusions once from a single-channel floating-point height grid. Grids may contain one sample
 * per cell, or corner samples (including subdivided cells). Block both sides of an excessive slope so a cliff's
 * shared boundary cannot leave a ground particle on its other face. The caller supplies its walkable slope limit.
 */
export function steepWeatherCells(width: number, height: number, heights: DataTexture, maxSlope: number): Uint8Array {
  const cells = new Uint8Array(width * height);
  const image = heights.image;
  const values = image.data as unknown as ArrayLike<number>;
  const stepX = width / (image.width === width ? image.width : Math.max(1, image.width - 1));
  const stepZ = height / (image.height === height ? image.height : Math.max(1, image.height - 1));
  const offsetX = image.width === width ? stepX / 2 : 0;
  const offsetZ = image.height === height ? stepZ / 2 : 0;
  const block = (ax: number, az: number, bx: number, bz: number) => {
    // A corner-grid sample on a cell edge belongs to both cells; keep that boundary conservative.
    const x0 = Math.max(0, Math.floor(ax - 1e-6));
    const z0 = Math.max(0, Math.floor(az - 1e-6));
    const x1 = Math.min(width - 1, Math.floor(bx));
    const z1 = Math.min(height - 1, Math.floor(bz));
    for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) cells[z * width + x] = 255;
  };
  for (let z = 0; z < image.height; z++) {
    for (let x = 0; x < image.width; x++) {
      const index = z * image.width + x;
      const value = values[index]!;
      const wx = offsetX + x * stepX;
      const wz = offsetZ + z * stepZ;
      if (x + 1 < image.width && Math.abs(values[index + 1]! - value) > maxSlope * stepX) block(wx, wz, wx + stepX, wz);
      if (z + 1 < image.height && Math.abs(values[index + image.width]! - value) > maxSlope * stepZ)
        block(wx, wz, wx, wz + stepZ);
    }
  }
  return cells;
}

/** Renderer-owned R8 texture: 0 permits ground weather; 255 excludes it. No GPU upload for unchanged coverage. */
export class WeatherGroundMask {
  readonly texture: DataTexture;
  private readonly staticCells: Uint8Array;
  private readonly data: Uint8Array;
  private key = '';

  constructor(
    readonly width: number,
    readonly height: number,
    staticCells: Uint8Array = new Uint8Array(width * height),
  ) {
    this.staticCells = Uint8Array.from(staticCells, (cell) => (cell ? 255 : 0));
    this.data = this.staticCells.slice();
    this.texture = new DataTexture(this.data, width, height, RedFormat, UnsignedByteType);
    this.texture.name = 'weather-ground-mask';
    this.texture.minFilter = this.texture.magFilter = NearestFilter;
    this.texture.generateMipmaps = false;
    this.texture.needsUpdate = true;
  }

  /** Canonical geometry keys ignore object order/identity; only a changed cell union requests another upload. */
  updateFoundations(foundations: readonly WeatherFoundation[]): boolean {
    const key = foundations
      .map(({ x, z, width, height }) => `${x},${z},${width},${height}`)
      .sort()
      .join(';');
    if (key === this.key) return false;
    this.key = key;
    const next = this.staticCells.slice();
    for (const foundation of foundations) {
      const x0 = Math.max(0, foundation.x);
      const z0 = Math.max(0, foundation.z);
      const x1 = Math.min(this.width, foundation.x + foundation.width);
      const z1 = Math.min(this.height, foundation.z + foundation.height);
      if (x0 >= x1 || z0 >= z1) continue;
      for (let z = z0; z < z1; z++) next.fill(255, z * this.width + x0, z * this.width + x1);
    }
    if (next.every((cell, index) => cell === this.data[index])) return false;
    this.data.set(next);
    this.texture.needsUpdate = true;
    return true;
  }

  dispose(): void {
    this.texture.dispose();
  }
}
