import type { TypeLibrary } from '../../../ra2-assets/src/library';
import type { SpriteEntry } from '../../../ra2-assets/src/manifest';
import { objectAnchor, type SpriteInstance } from '../ra2/sprites';
import type { LiveOverlayCells, OverlayTerrain } from './overlays';

/** Same row-major grid as overlays; data is the native row-major footprint selector, not an SHP frame. */
export type LiveSmudgeCells = LiveOverlayCells;
type SmudgeLibrary = Pick<TypeLibrary, 'smudges' | 'sprites'>;
export type SmudgePage = 'map' | number;
export interface SmudgeInstances {
  pages: Map<SmudgePage, SpriteInstance[]>;
  missingTypes: Set<string>;
}

/**
 * Native SmudgeData selects a cell of the type's footprint. DrawIt reconstructs the origin and draws SHP body frame
 * zero, clipped to the tactical/dirty rectangle rather than this cell. Deduplicate identical reconstructed origins;
 * a partially removed footprint still draws while any cell points to it. See yr/smudgeReader.ts for instructions.
 * Older theater libraries can draw map-cache art for selector zero, whose origin is unambiguous without dimensions.
 * Every live grid remains authoritative; missing art is reported and never replaced with a different crater.
 */
export function buildSmudgeInstances(
  cells: LiveSmudgeCells,
  library: SmudgeLibrary | null,
  terrain: OverlayTerrain,
  mapSprites: Record<string, SpriteEntry>,
  palette: (key: string, fromLibrary: boolean) => string,
): SmudgeInstances {
  const pages = new Map<SmudgePage, SpriteInstance[]>();
  const missingTypes = new Set<string>();
  const drawn = new Map<string, [number, number]>();
  if (
    !Number.isSafeInteger(cells.width) ||
    cells.width <= 0 ||
    !Number.isSafeInteger(cells.height) ||
    cells.height <= 0
  )
    return { pages, missingTypes };
  const count = Math.min(cells.width * cells.height, cells.index.length, cells.data.length);
  const add = (instance: SpriteInstance, fromLibrary: boolean): void => {
    const page = fromLibrary ? (instance.frame.page ?? 0) : 'map';
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
    const footprintCell = cells.data[slot]!;
    const type = library?.smudges?.[id];
    const fromLibrary = !!type;
    const sprite = type ? library?.sprites[type.sprite] : mapSprites[`smudge:${id}`];
    const width = type?.width ?? 1;
    const height = type?.height ?? 1;
    const frameIndex = sprite?.sourceFrames ? sprite.sourceFrames.indexOf(0) : 0;
    const frame = sprite?.frames[frameIndex];
    if (
      !sprite ||
      !frame ||
      !Number.isSafeInteger(width) ||
      width <= 0 ||
      !Number.isSafeInteger(height) ||
      height <= 0 ||
      footprintCell >= width * height
    ) {
      missingTypes.add(id);
      continue;
    }
    const originX = x - (footprintCell % width);
    const originY = y - Math.floor(footprintCell / width);
    const z = terrain.levels[cell] ?? 0;
    const key = `${id}:${originX}:${originY}:${z}`;
    const previousLight = drawn.get(key);
    if (previousLight) {
      // Each native copy uses its drawing cell's LightConvert (0x4804D1, 0x6B566F).
      // Keep the bottommost surviving copy's texel centre, as after a full redraw.
      if (x + y + 1 > previousLight[0] + previousLight[1]) {
        previousLight[0] = x + 0.5;
        previousLight[1] = y + 0.5;
      }
      continue;
    }
    const lightSample: [number, number] = [x + 0.5, y + 0.5];
    drawn.set(key, lightSample);
    const anchor = objectAnchor({
      kind: 'smudge',
      type: id,
      x: originX,
      y: originY,
      z,
      drawOffset: type?.drawOffset ?? [0, 0],
    });
    const paletteKey = palette(type?.palette ?? sprite.palette, fromLibrary);
    const shadow = sprite.shadows?.[frameIndex];
    if (shadow)
      add(
        {
          anchor,
          frame: shadow,
          palette: paletteKey,
          push: 0,
          shadow: true,
          flat: true,
          lighting: 'full',
          lightSample,
        },
        fromLibrary,
      );
    add(
      { anchor, frame, palette: paletteKey, push: 0, shadow: false, flat: true, lighting: 'full', lightSample },
      fromLibrary,
    );
  }
  return { pages, missingTypes };
}

/** Content revisions survive Worker structured clones; atlas completion never requires another cell scan. */
export class SmudgeInstanceCache {
  private key: string | null = null;
  private library: SmudgeLibrary | null = null;
  active = false;
  instances: SmudgeInstances = { pages: new Map(), missingTypes: new Set() };

  constructor(
    private readonly terrain: OverlayTerrain,
    private readonly mapSprites: Record<string, SpriteEntry>,
  ) {}

  update(
    cells: LiveSmudgeCells | null,
    library: SmudgeLibrary | null,
    palette: (key: string, fromLibrary: boolean) => string,
  ): boolean {
    const key = cells ? `${cells.revision}:${cells.originX}:${cells.originY}:${cells.width}:${cells.height}` : null;
    if (key === this.key && library === this.library) return false;
    this.key = key;
    this.library = library;
    this.active = cells !== null;
    this.instances = cells
      ? buildSmudgeInstances(cells, library, this.terrain, this.mapSprites, palette)
      : { pages: new Map(), missingTypes: new Set() };
    return true;
  }
}
