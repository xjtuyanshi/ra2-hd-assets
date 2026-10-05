import { highBridgeCell } from '../../../ra2-assets/src/overlayDraw';
import type { TypeLibrary } from '../../../ra2-assets/src/library';
import { spriteClassGradeExempt, type AtmosphereProfile } from '../../../ra2-assets/src/lights';
import { cardPush, objectAnchor, type SpriteInstance } from '../ra2/sprites';
import { HIGH_BRIDGE_HEIGHT, highBridgeLight, isHighBridge } from '../ra2/bridgeDepth';

/** Row-major live cell overlays. A negative index is empty; data is the engine's exact sprite frame. */
export interface LiveOverlayCells {
  originX: number;
  originY: number;
  width: number;
  height: number;
  index: Int16Array;
  data: Uint8Array;
  types: string[];
  /** Source building type of a rubble overlay; only the engine's single carrier cell is listed. */
  rubble?: { slot: number; type: string }[];
  /** Changes only when cell contents, rubble carriers or the type table change; monotonic for the reader's lifetime. */
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
 * terrain, and draw points, palettes and flat/card rules come from the extracted library. A bridge-owner type takes
 * its deck variant and the rise of its second direction from the cell, as the engine's cell pass does.
 */
export function buildOverlayInstances(
  cells: LiveOverlayCells,
  library: Pick<TypeLibrary, 'overlays' | 'sprites' | 'types'> | null,
  terrain: OverlayTerrain,
  palette: (key: string, remap: boolean) => string,
  atmosphere: Pick<AtmosphereProfile, 'airless'> = {},
  /** Light of a bridge deck over an owner cell at this level, relative to the cell's own (bridgeDepth.ts). */
  deckLight: (level: number) => number = () => 1,
): OverlayInstances {
  const pages = new Map<number, SpriteInstance[]>();
  const missingTypes = new Set<string>();
  if (!Number.isSafeInteger(cells.width) || cells.width <= 0 || !Number.isSafeInteger(cells.height))
    return { pages, missingTypes };
  const count = Math.min(cells.width * cells.height, cells.index.length, cells.data.length);
  const rubble = new Map<number, string>();
  const rubbleOverlayIds = new Set<string>();
  for (const entry of cells.rubble ?? []) {
    if (!Number.isSafeInteger(entry.slot) || entry.slot < 0 || entry.slot >= count) continue;
    const id = cells.types[cells.index[entry.slot]!];
    if (!id) continue;
    rubble.set(entry.slot, entry.type);
    // A carrier identifies the overlay type even in older libraries that still contain its unused Image sprite.
    rubbleOverlayIds.add(id);
  }
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
    if (!type) {
      missingTypes.add(id);
      continue;
    }
    const isRubble = type.rubble === true || rubbleOverlayIds.has(id);
    let sprite;
    let frameIndex;
    if (isRubble) {
      const source = rubble.get(slot);
      if (!source) continue;
      const building = library?.types[source];
      sprite = building?.kind === 'building' && building.sprite ? library?.sprites[building.sprite] : undefined;
      if (!sprite) {
        missingTypes.add(`rubble:${source}`);
        continue;
      }
      if (sprite.frames.length <= 3) continue;
      frameIndex = 3;
    } else {
      sprite = type.sprite ? library?.sprites[type.sprite] : undefined;
      frameIndex = cells.data[slot]!;
    }
    const bridge = !isRubble && type.highBridge ? highBridgeCell(frameIndex, x, y) : undefined;
    if (bridge) frameIndex = bridge.frame;
    const frame = isRubble || frameIndex < type.frames ? sprite?.frames[frameIndex] : undefined;
    if (!sprite || !frame) {
      missingTypes.add(isRubble ? `rubble:${rubble.get(slot)}` : id);
      continue;
    }
    const level = terrain.levels[cell] ?? 0;
    const anchor = objectAnchor({
      kind: 'overlay',
      type: id,
      x,
      y,
      z: level,
      drawOffset: bridge ? [type.drawOffset[0], type.drawOffset[1] - bridge.lift] : type.drawOffset,
    });
    const paletteKey = palette(type.palette, isRubble ? false : type.remap);
    const shadow = sprite.shadows?.[frameIndex];
    if (shadow)
      add({
        anchor,
        frame: shadow,
        palette: paletteKey,
        push: 0,
        shadow: true,
        flat: isRubble ? type.flat : true,
        lighting: type.lighting,
      });
    add({
      anchor,
      frame,
      palette: paletteKey,
      push: type.flat ? 0 : cardPush(frame),
      shadow: false,
      flat: type.flat,
      glint: !isRubble && type.tiberium === true ? 1 : undefined,
      unlit: !isRubble && type.tiberium === true,
      lighting: type.lighting,
      light: bridge ? deckLight(level) : undefined,
      deckHeight: !isRubble && isHighBridge(id) ? HIGH_BRIDGE_HEIGHT : undefined,
      gradeExempt: spriteClassGradeExempt(atmosphere, !isRubble && type.tiberium ? 'ore' : 'overlay'),
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
  private library: Pick<TypeLibrary, 'overlays' | 'sprites' | 'types'> | null = null;
  active = false;
  instances: OverlayInstances = { pages: new Map(), missingTypes: new Set() };

  constructor(private readonly terrain: OverlayTerrain) {}

  update(
    cells: LiveOverlayCells | null,
    library: Pick<TypeLibrary, 'overlays' | 'sprites' | 'types'> | null,
    paletteKey: string,
    palette: (key: string, remap: boolean) => string,
    atmosphere: Pick<AtmosphereProfile, 'airless'> = {},
    /** The map's [Lighting] in force; bridge decks are lit four levels above their owner cells. */
    lighting?: { ambient: number; ground: number; level: number },
  ): boolean {
    // Libraries extracted before the overlay section existed cannot replace the map's art yet.
    if (!library?.overlays) cells = null;
    const lightKey = lighting ? `${lighting.ambient},${lighting.ground},${lighting.level}` : '';
    const key = cells
      ? `${cells.revision}:${cells.originX}:${cells.originY}:${cells.width}:${cells.height}:${paletteKey}:${JSON.stringify(cells.rubble ?? [])}:${spriteClassGradeExempt(atmosphere, 'ore')}:${lightKey}`
      : null;
    if (key === this.key && library === this.library) return false;
    this.key = key;
    this.library = library;
    this.active = cells !== null;
    this.instances = cells
      ? buildOverlayInstances(
          cells,
          library,
          this.terrain,
          palette,
          atmosphere,
          lighting ? (level) => highBridgeLight(lighting, level) : undefined,
        )
      : { pages: new Map(), missingTypes: new Set() };
    return true;
  }
}
