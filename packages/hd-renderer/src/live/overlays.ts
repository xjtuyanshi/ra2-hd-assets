import type { TypeLibrary } from '../../../ra2-assets/src/library';
import { cardPush, objectAnchor, type SpriteInstance } from '../ra2/sprites';
import { painterObject } from '../ra2/painterOrder';

/** Row-major live cell overlays. A negative index is empty; data is the engine's exact sprite frame. */
export interface LiveOverlayCells {
  originX: number;
  originY: number;
  width: number;
  height: number;
  index: Int16Array;
  data: Uint8Array;
  types: string[];
  /** Changes only when cell contents or the type table change; monotonic for the reader's lifetime. */
  revision: number;
}

export interface OverlayTerrain {
  width: number;
  height: number;
  levels: Uint8Array;
  exists: Uint8Array;
}

export interface OverlayInstances {
  /** Library atlas page -> its overlay bodies and shadows. */
  pages: Map<number, SpriteInstance[]>;
  missingTypes: Set<string>;
}

/**
 * Pure instance construction, separate from texture loading. Native overlay frames must not wrap or clamp: doing
 * so would show a different connection/growth state. Missing art is omitted and reported. Heights come from the map
 * terrain, and draw points, palettes and flat/card rules come from the extracted library.
 */
export function buildOverlayInstances(
  cells: LiveOverlayCells,
  library: Pick<TypeLibrary, 'overlays' | 'sprites'> | null,
  terrain: OverlayTerrain,
  palette: (key: string, remap: boolean) => string,
): OverlayInstances {
  const pages = new Map<number, SpriteInstance[]>();
  const missingTypes = new Set<string>();
  if (!Number.isSafeInteger(cells.width) || cells.width <= 0 || !Number.isSafeInteger(cells.height))
    return { pages, missingTypes };
  const count = Math.min(cells.width * cells.height, cells.index.length, cells.data.length);
  const add = (instance: SpriteInstance): void => {
    const page = instance.frame.page ?? 0;
    let list = pages.get(page);
    if (!list) pages.set(page, (list = []));
    list.push(instance);
  };
  for (let slot = 0; slot < count; slot++) {
    const index = cells.index[slot]!;
    if (index < 0) continue;
    const id = cells.types[index];
    if (!id) continue;
    const x = cells.originX + (slot % cells.width);
    const y = cells.originY + Math.floor(slot / cells.width);
    if (x < 0 || y < 0 || x >= terrain.width || y >= terrain.height) continue;
    const cell = y * terrain.width + x;
    if (!terrain.exists[cell]) continue;
    const type = library?.overlays?.[id];
    const sprite = type ? library?.sprites[type.sprite] : undefined;
    const frameIndex = cells.data[slot]!;
    const frame = type && frameIndex < type.frames ? sprite?.frames[frameIndex] : undefined;
    if (!type || !sprite || !frame) {
      missingTypes.add(id);
      continue;
    }
    const anchor = objectAnchor({
      kind: 'overlay',
      type: id,
      x,
      y,
      z: terrain.levels[cell] ?? 0,
      drawOffset: type.drawOffset,
    });
    const paletteKey = palette(type.palette, type.remap);
    const shadow = sprite.shadows?.[frameIndex];
    if (shadow)
      add({ anchor, frame: shadow, palette: paletteKey, push: 0, shadow: true, flat: true, lighting: type.lighting });
    add({
      anchor,
      frame,
      palette: paletteKey,
      push: type.flat ? 0 : cardPush(frame),
      shadow: false,
      flat: type.flat,
      lighting: type.lighting,
      painter: type.flat ? undefined : painterObject(2, (x + y + 1) * 256),
    });
  }
  return { pages, missingTypes };
}

/**
 * Cache by content revision, rather than object identity (Worker messages may be structured clones). Null changes
 * back to map-cache drawing. A palette change also rebuilds: native walls use the current player's colour scheme.
 */
export class OverlayInstanceCache {
  private key: string | null = null;
  private library: Pick<TypeLibrary, 'overlays' | 'sprites'> | null = null;
  active = false;
  instances: OverlayInstances = { pages: new Map(), missingTypes: new Set() };

  constructor(private readonly terrain: OverlayTerrain) {}

  update(
    cells: LiveOverlayCells | null,
    library: Pick<TypeLibrary, 'overlays' | 'sprites'> | null,
    paletteKey: string,
    palette: (key: string, remap: boolean) => string,
  ): boolean {
    // Libraries extracted before the overlay section existed cannot replace the map's art yet.
    if (!library?.overlays) cells = null;
    const key = cells
      ? `${cells.revision}:${cells.originX}:${cells.originY}:${cells.width}:${cells.height}:${paletteKey}`
      : null;
    if (key === this.key && library === this.library) return false;
    this.key = key;
    this.library = library;
    this.active = cells !== null;
    this.instances = cells
      ? buildOverlayInstances(cells, library, this.terrain, palette)
      : { pages: new Map(), missingTypes: new Set() };
    return true;
  }
}
