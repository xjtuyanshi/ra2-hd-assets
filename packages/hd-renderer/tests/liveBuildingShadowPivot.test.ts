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
  it("keeps the building's foundation on its SHP shadow (penumbra base, no sun-follow transform)", () => {
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

describe('sun-following SHP shadows', () => {
  const yard = { origin: [-0.5, -0.5] as const, size: [4, 4] as const };
  const [s0x, s0z] = ART_SHADOW_DIRECTION;
  // The yard's shadow-side edge, a point one cell out from it, and points beside its side walls.
  const edge: [number, number] = [1.5 + s0x * 2, 1.5 + s0z * 2];
  const out: [number, number] = [edge[0] + s0x, edge[1] + s0z];
  const beside: [number, number][] = [
    [3.6, 0.5],
    [4.5, 2.5],
    [-0.6, 1],
  ];

  it("keeps a building's shadow where the art draws it under a turned and stretched sun", () => {
    // The cinematic look at 16.5 h: turned 21 degrees and stretched 1.62 times. Every transform of the flat shadow
    // tore it off the walls somewhere (live construction yards: smaller, lighter and stepped against the original).
    const m = shadowTransform(new Vector3(-0.297, 0.559, 0.774), 1.62, 1, new Vector4());
    for (const p of [edge, out, [1.5, 1.5] as [number, number], ...beside])
      expect(followedShadowPoint(p, m, yard)).toEqual(p);
  });

  it('turns and stretches shadows without a foundation (trees, SHP units) about their draw point', () => {
    const m = shadowTransform(new Vector3(-0.3, 0.5, 0.8), 1.62, 1, new Vector4());
    const r = followedShadowPoint([1, 2], m);
    expect(r[0]).toBeCloseTo(m.x * 1 + m.z * 2, 12);
    expect(r[1]).toBeCloseTo(m.y * 1 + m.w * 2, 12);
    // Along the art's own direction: the stretched length.
    const along = followedShadowPoint([s0x, s0z], shadowTransform(new Vector3(0, 0.5, 1), 1.62, 1, new Vector4()));
    expect(Math.hypot(along[0], along[1])).toBeCloseTo(1.62, 9);
    // Without follow the transform is the identity.
    const id = shadowTransform(new Vector3(-0.3, 0.5, 0.8), 1.62, 0, new Vector4());
    const q = followedShadowPoint([0.2, 3.1], id);
    expect(q[0]).toBeCloseTo(0.2, 12);
    expect(q[1]).toBeCloseTo(3.1, 12);
  });
});
