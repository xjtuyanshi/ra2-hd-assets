import { describe, expect, it } from 'vitest';
import { Texture, Vector3, Vector4 } from 'three/webgpu';
import { ART_SHADOW_DIRECTION, followedShadowPoint, shadowTransform } from '../src/ra2/spriteLook';
import { SpritePool } from '../src/live/spritePool';
import { SpriteLayer } from '../src/ra2/sprites';
import { painterObject } from '../src/ra2/painterOrder';
import type { Ra2Cache } from '../src/ra2/cache';
import type { DirtyAttribute } from '../src/dirtyAttribute';

const shadow = {
  rect: [2, 2, 12, 7] as [number, number, number, number],
  offset: [-6, -2] as [number, number],
  page: 7,
};
const cache = {
  paletteAtlas: { image: { height: 1 } },
  paletteRow: new Map([['library:unit', 0]]),
  manifest: { spriteAtlas: { width: 64, height: 64 } },
  spriteAtlas: new Texture(),
} as unknown as Ra2Cache;

function dispose(layer: SpriteLayer): void {
  layer.mesh.geometry.dispose();
  layer.mesh.material.dispose();
  layer.mesh.dispose();
  for (const mesh of layer.groundPasses) {
    mesh.material.dispose();
    mesh.dispose();
  }
}

describe('live building shadow pivot', () => {
  it("keeps the building's foundation on its SHP shadow so the sun-follow pivot is the foundation centre", () => {
    const pool = new SpritePool();
    pool.begin();
    const painter = painterObject(2, 100);
    painter.foundation = [4, 3];
    painter.x = 40;
    painter.z = 50;
    pool.painter = painter;
    // Draw point 1.5 cells right of and 0.5 cell below the foundation origin (world x/z).
    const sh = pool.take(new Vector3(41.5, 0, 50.5), shadow, 'library:unit', 0, true, true);
    const bib = pool.take(new Vector3(41.5, 0, 50.5), shadow, 'library:unit', 0, false, true);
    expect(sh.painter).toBe(painter);
    expect(sh.deckHeight).toBeUndefined();
    expect(bib.painter).toBeUndefined();
    const layer = new SpriteLayer(cache, [sh, bib]);
    const flags = (layer as unknown as { flags: DirtyAttribute }).flags;
    const at = (i: number) => Array.from(flags.array.slice(i * flags.itemSize, i * flags.itemSize + 8));
    // Shadow code 2, no painter bias, then foundation [4, 3] and the draw point's offset (dx - dz, -dx - dz).
    expect(at(0)).toEqual([2, 1, 0, 0, 4, 3, 1, -2]);
    expect(at(1)).toEqual([1, 1, 0, 0, 0, 0, 0, 0]);
    dispose(layer);
  });

  it('leaves unit shadows (no foundation) pivoting on their draw point', () => {
    const pool = new SpritePool();
    pool.begin();
    pool.painter = painterObject(2, 100);
    const sh = pool.take(new Vector3(3, 0, 4), shadow, 'library:unit', 0, true, true);
    const layer = new SpriteLayer(cache, [sh]);
    const flags = (layer as unknown as { flags: DirtyAttribute }).flags;
    expect(Array.from(flags.array.slice(0, 8))).toEqual([2, 1, 0, 0, 0, 0, 0, 0]);
    dispose(layer);
  });
});

describe('sun-following building shadow pivot', () => {
  const yard = { origin: [-0.5, -0.5] as const, size: [4, 4] as const };
  const [s0x, s0z] = ART_SHADOW_DIRECTION;
  // Edge of the yard on the art's shadow side, and a point one cell out from it (the cast shadow by the wall).
  const edge: [number, number] = [1.5 + s0x * 2, 1.5 + s0z * 2];
  const out: [number, number] = [edge[0] + s0x, edge[1] + s0z];

  it('keeps the cast shadow on the wall it leaves instead of carrying it away with the stretch', () => {
    const m = shadowTransform(new Vector3(0, 0.5, 1), 1.62, 1, new Vector4());
    // Same sun azimuth as the art: pure stretch along the art's direction.
    const e = followedShadowPoint(edge, m, yard);
    expect(e.point[0]).toBeCloseTo(edge[0], 9);
    expect(e.point[1]).toBeCloseTo(edge[1], 9);
    const o = followedShadowPoint(out, m, yard);
    expect(Math.hypot(o.point[0] - edge[0], o.point[1] - edge[1])).toBeCloseTo(1.62, 9);
    // The centre pivot (the old transform) left (1.62 - 1) x 2 cells of bare ground between wall and shadow.
    const centreEdge = [1.5 + (edge[0] - 1.5) * 1.62, 1.5 + (edge[1] - 1.5) * 1.62];
    expect(Math.hypot(centreEdge[0] - edge[0], centreEdge[1] - edge[1])).toBeGreaterThan(1.2);
  });

  it('keeps the whole shadow-side wall line in place when the sun turns, casting along the turned direction', () => {
    const sun = new Vector3(-0.297, 0.559, 0.774);
    const m = shadowTransform(sun, 1.62, 1, new Vector4());
    // Points along the shadow-side edge, from one end of the wall to the other: none moves.
    const ex = -s0z;
    const ez = s0x;
    for (const u of [-2, -1, 0, 1, 2]) {
      const p: [number, number] = [edge[0] + ex * u, edge[1] + ez * u];
      const r = followedShadowPoint(p, m, yard);
      expect(r.point[0]).toBeCloseTo(p[0], 9);
      expect(r.point[1]).toBeCloseTo(p[1], 9);
      // One cell out from that wall point the shadow lies along M s0 (away from the sun), at the stretched length.
      const q = followedShadowPoint([p[0] + s0x, p[1] + s0z], m, yard);
      expect(q.point[0] - p[0]).toBeCloseTo(m.x * s0x + m.z * s0z, 9);
      expect(q.point[1] - p[1]).toBeCloseTo(m.y * s0x + m.w * s0z, 9);
      expect((q.point[0] - p[0]) * -sun.x + (q.point[1] - p[1]) * -sun.z).toBeGreaterThan(0);
      expect(q.hidden).toBe(false);
    }
  });

  it('drops the under-foundation shadow that the stretch would push out on the sunny side', () => {
    const m = shadowTransform(new Vector3(0, 0.5, 1), 1.62, 1, new Vector4());
    const sunnyEdge: [number, number] = [1.5 - s0x * 1.9, 1.5 - s0z * 1.9];
    expect(followedShadowPoint(sunnyEdge, m, yard).hidden).toBe(true);
    expect(followedShadowPoint([1.5, 1.5], m, yard).hidden).toBe(false);
    expect(followedShadowPoint(out, m, yard).hidden).toBe(false);
  });

  it('is the identity when the look does not follow the sun, and pivots on the draw point without a foundation', () => {
    const id = shadowTransform(new Vector3(-0.3, 0.5, 0.8), 1.62, 0, new Vector4());
    for (const p of [edge, out, [0.2, 3.1] as [number, number]]) {
      const r = followedShadowPoint(p, id, yard);
      expect(r.point[0]).toBeCloseTo(p[0], 12);
      expect(r.point[1]).toBeCloseTo(p[1], 12);
      expect(r.hidden).toBe(false);
    }
    const m = shadowTransform(new Vector3(-0.3, 0.5, 0.8), 1.62, 1, new Vector4());
    const r = followedShadowPoint([1, 2], m);
    expect(r.point[0]).toBeCloseTo(m.x * 1 + m.z * 2, 12);
    expect(r.point[1]).toBeCloseTo(m.y * 1 + m.w * 2, 12);
  });
});
