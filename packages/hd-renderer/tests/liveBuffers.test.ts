import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three/webgpu';
import { SpriteLayer, objectAnchor, type SpriteInstance } from '../src/ra2/sprites';
import { paletteFor, ra2Screen, screenToCell, type Ra2Cache } from '../src/ra2/cache';
import { ShroudLayer, shroudCorners } from '../src/live/shroud';
import { SpritePool } from '../src/live/spritePool';
import type { DirtyAttribute } from '../src/dirtyAttribute';
import type { MapObject } from '../../ra2-assets/src/manifest';
import { LEVEL_HEIGHT } from '../src/world';

const frame = { rect: [2, 3, 8, 12], offset: [-4, -6] } as const;
const cache = {
  paletteAtlas: { image: { height: 4 } },
  paletteRow: new Map([['unit', 1]]),
  manifest: { spriteAtlas: { width: 64, height: 64 } },
  spriteAtlas: new ShroudLayer(1, 1).texture,
} as unknown as Ra2Cache;
type Buffers = { anchor: DirtyAttribute; rect: DirtyAttribute; params: DirtyAttribute; flags: DirtyAttribute };
function sprite(x: number, flat = false, shadow = false): SpriteInstance {
  return {
    anchor: new Vector3(x, 0, 1),
    frame: { rect: [...frame.rect], offset: [...frame.offset] },
    palette: 'unit',
    push: 0.1,
    shadow,
    flat,
  };
}

describe('live sprite buffers', () => {
  it('observes palette rows arriving after a cached key lookup', () => {
    const local = { paletteRow: new Map<string, number>() } as Ra2Cache;
    expect(paletteFor(local, 'unit', true, 'house')).toBe('unit');
    local.paletteRow.set('unit@house', 1);
    expect(paletteFor(local, 'unit', true, 'house')).toBe('unit@house');
    expect(paletteFor(local, 'unit', false, 'house')).toBe('unit');
  });

  it('keeps stable decal/shadow/card ordering and only uploads changed float32 components', () => {
    const layer = new SpriteLayer(cache, [], 5);
    const cards = [sprite(1), sprite(2, true), sprite(3, false, true), sprite(4, true), sprite(5)];
    layer.setInstances(cards);
    const buffers = layer as unknown as Buffers;
    expect(Array.from(buffers.anchor.array).filter((_, i) => i % 3 === 0)).toEqual([2, 4, 3, 1, 5]);
    const attrs = [buffers.anchor, buffers.rect, buffers.params, buffers.flags];
    const versions = attrs.map((a) => a.version);
    attrs.forEach((a) => a.clearUpdateRanges());
    layer.setInstances(cards);
    expect(attrs.map((a) => a.version)).toEqual(versions);
    expect(attrs.every((a) => a.updateRanges.length === 0)).toBe(true);
    cards[0]!.anchor.x += 0.25;
    layer.setInstances(cards);
    expect(buffers.anchor.updateRanges).toEqual([{ start: 9, count: 1 }]);
    expect(attrs.slice(1).map((a) => a.version)).toEqual(versions.slice(1));
    attrs.forEach((a) => a.clearUpdateRanges());
    const moved = attrs.map((a) => a.version);
    layer.setInstances([]);
    expect(layer.mesh.count).toBe(0);
    expect(attrs.map((a) => a.version)).toEqual(moved);
  });

  it('reuses card records and vectors without retaining stale optional fields', () => {
    const pool = new SpritePool();
    const source = sprite(2);
    const first = pool.take(source.anchor, source.frame, 'unit', 1, true, true, 2, 'full');
    pool.begin();
    const second = pool.take(new Vector3(3, 4, 5), source.frame, 'unit', 0, false);
    expect(second).toBe(first);
    expect(second.anchor.toArray()).toEqual([3, 4, 5]);
    expect(second).toMatchObject({ flat: false, shadow: false, light: 1, lighting: 'ambient' });
    expect(source.anchor.x).toBe(2);
  });

  it('preserves the projection while filling a caller-owned anchor', () => {
    const out = new Vector3();
    for (const drawOffset of [undefined, [12, -9], [-30, 15]] as const) {
      const object = { x: 17, y: 3, z: 2, drawOffset } as MapObject;
      const [sx, sy] = ra2Screen(object.x, object.y, object.z);
      const [dx, dy] = drawOffset ?? [0, 15];
      const [x, y] = screenToCell(sx + dx, sy + dy, object.z);
      expect(objectAnchor(object, out)).toBe(out);
      expect(out.toArray()).toEqual([x, object.z * LEVEL_HEIGHT, y]);
    }
  });
});

describe('shroud reuse', () => {
  it('accepts reusable output and scratch grids with the same corner values', () => {
    const state = (x: number, y: number) => (x >= 0 && y >= 0 && x < 6 && y < 5 ? (x + y) % 3 : 255);
    const expected = shroudCorners(6, 5, state);
    const out = new Uint8Array(7 * 6 * 2);
    const flags = new Uint8Array(8 * 7);
    expect(shroudCorners(6, 5, state, out, flags)).toBe(out);
    expect(out).toEqual(expected);
    out.fill(128);
    expect(shroudCorners(6, 5, state, out, flags)).toEqual(expected);
  });

  it('reuses the applied copy for changed cells and skips a repeated update', () => {
    const layer = new ShroudLayer(5, 5);
    const cells = { originX: 0, originY: 0, width: 5, height: 5, cells: new Uint8Array(25) };
    layer.update(cells);
    const applied = (layer as unknown as { applied: { cells: Uint8Array } }).applied;
    const version = layer.texture.version;
    cells.cells[12] = 2;
    layer.update(cells);
    expect((layer as unknown as { applied: unknown }).applied).toBe(applied);
    expect(applied.cells[12]).toBe(2);
    expect(layer.texture.version).toBeGreaterThan(version);
    const updated = layer.texture.version;
    layer.update(cells);
    expect(layer.texture.version).toBe(updated);
    expect(layer.isLocationShrouded(2 * 256, 2 * 256, 0)).toBe(false);
  });
  it('matches full corner reconstruction through sparse edits and shifted reader boxes', () => {
    const layer = new ShroudLayer(12, 9);
    const cells = { originX: -1, originY: -1, width: 15, height: 12, cells: new Uint8Array(180).fill(2) };
    let seed = 123;
    for (let iteration = 0; iteration < 40; iteration++) {
      if (iteration === 20) {
        cells.originX = 2;
        cells.originY = 1;
      }
      seed = (seed * 1664525 + 1013904223) >>> 0;
      cells.cells[seed % cells.cells.length] = iteration % 3;
      layer.update(cells);
      const expected = shroudCorners(12, 9, (x, y) => {
        const sx = x - cells.originX,
          sy = y - cells.originY;
        return sx < 0 || sy < 0 || sx >= cells.width || sy >= cells.height ? 255 : cells.cells[sy * cells.width + sx]!;
      });
      expect(layer.texture.image.data).toEqual(expected);
    }
  });
});
