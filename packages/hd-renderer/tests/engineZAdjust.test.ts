import { DataTexture, Vector3, type InstancedBufferAttribute } from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import type { EffectsLayer } from '../src/effects';
import type { EffectArt } from '../src/live/effectArt';
import {
  EffectSpriteLayer,
  MESH_IDLE_SECONDS,
  engineZAdjustBias,
  type EffectInstance,
} from '../src/live/effectSprites';
import { LiveEffectsDriver, type LiveAnim } from '../src/live/effects';
import type { Ra2Cache } from '../src/ra2/cache';
import { GROUND_DEPTH } from '../src/ra2/cardDepth';
import { FIREBALL_VOLUME, packEffectDrawRadius, unpackEffectDrawRadius } from '../src/ra2/fireballDepth';
import { MAX_PAINTER_BIAS } from '../src/ra2/painterOrder';

/**
 * Burning buildings: YR spawns a building's damage fires (FIRE01..03) at its DamageFireOffset points inside the
 * foundation and gives each one a negative ZAdjust (BuildingClass 0x43C0D0; -43 to -264 on YR Allied mission 1), so
 * the engine draws them over the building.
 * Without that offset the HD card kept its anchor depth, which lies inside the building's depth profile: every damage
 * fire on a burning building (and on the Golden Gate bridge pieces of YR Allied mission 1) was hidden.
 */
describe('engine ZAdjust of anims', () => {
  it('turns engine Z units into camera nearness at the native depth scale', () => {
    expect(engineZAdjustBias(0)).toBe(0);
    expect(engineZAdjustBias(-200)).toBeCloseTo(200 * GROUND_DEPTH, 12);
    expect(engineZAdjustBias(100)).toBeCloseTo(-100 * GROUND_DEPTH, 12);
    // -200 is more than the camera depth across a 4x4 foundation (its ground diagonal, sqrt(3/8) per cell step, see
    // foundationPointPush): a fire anchored at the back of such a building still comes out in front of its facade.
    expect(engineZAdjustBias(-200)).toBeGreaterThan((4 + 4) * Math.sqrt(3 / 8));
  });

  it('round-trips the engine-Z flag with draw mode and sphere radius through Float32', () => {
    for (const draw of [0, 1, 2])
      for (const radius of [0, 0.0001, 0.3, 0.99, FIREBALL_VOLUME.maxRadius])
        for (const engineZ of [false, true]) {
          const decoded = unpackEffectDrawRadius(Math.fround(packEffectDrawRadius(draw, radius, engineZ)));
          expect(decoded.draw).toBe(draw);
          expect(decoded.radius).toBeCloseTo(radius, 6);
          expect(decoded.engineZ).toBe(engineZ);
        }
  });

  it.each(['faithful', 'enhanced'] as const)(
    'carries a damage fire offset into the %s card and its buffers',
    (style) => {
      const texture = new DataTexture(new Uint8Array(256 * 4), 256, 1);
      const frame = {
        rect: [0, 0, 20, 30] as [number, number, number, number],
        offset: [-10, -28] as [number, number],
      };
      const hdFrame = {
        page: 0,
        rect: [0, 0, 60, 90] as [number, number, number, number],
        offset: [-10, -28] as [number, number],
      };
      const art = {
        ready: true,
        anim: () => ({ art: { layer: 'air', start: 0, frameCount: 1 }, sprite: { frames: [frame] } }),
        hdAnim: () => ({ scale: 3, frames: [hdFrame] }),
        hdPageState: () => ({ texture, width: 256, height: 1 }),
      } as unknown as EffectArt;
      const driver = new LiveEffectsDriver({ setBeams() {} } as unknown as EffectsLayer, () => false);
      driver.style = style;
      driver.garnishEnabled = false;
      const fire = (uid: number, zAdjust?: number): LiveAnim => ({
        id: uid,
        uid,
        type: 'FIRE01',
        x: 5000,
        y: 6000,
        z: 416,
        frame: 0,
        layer: 'air',
        ...(zAdjust !== undefined ? { zAdjust } : {}),
      });
      driver.push(
        { anims: [fire(1, -200), fire(2), fire(3, 0)], bullets: [], particleSystems: [] },
        1,
        0,
        new Vector3(),
      );
      const cards: EffectInstance[] = [];
      driver.cards(art, () => 'anim', cards);
      expect(cards).toHaveLength(3);
      expect(cards.map((c) => c.pass)).toEqual(['air', 'air', 'air']);
      expect(!!cards[0]!.hd).toBe(style === 'enhanced');
      expect(cards[0]!.engineZ).toBe(true);
      expect(cards[0]!.depthBias).toBeCloseTo(200 * GROUND_DEPTH, 12);
      for (const plain of cards.slice(1)) {
        expect(plain.engineZ).toBeUndefined();
        expect(plain.depthBias).toBeUndefined();
      }
      const cache = { paletteAtlas: texture, paletteRow: new Map([['anim', 0]]) } as unknown as Ra2Cache;
      const atlas = { texture, width: 256, height: 1 };
      const layer = new EffectSpriteLayer(
        cache,
        () => atlas,
        undefined,
        () => atlas,
      );
      try {
        layer.setInstances(cards, 0);
        const page = [
          ...(layer as unknown as { meshes: Map<string, { style: InstancedBufferAttribute }> }).meshes.values(),
        ][0]!;
        // Cards keep their order within one page only up to the legacy depth sort; identify them by bias.
        const rows = cards.map((_, i) =>
          style === 'enhanced'
            ? { packed: page.style.getX(i), bias: page.style.getZ(i) }
            : { packed: page.style.getY(i), bias: page.style.getW(i) },
        );
        const flagged = rows.filter((row) => unpackEffectDrawRadius(row.packed).engineZ);
        expect(flagged).toHaveLength(1);
        expect(flagged[0]!.bias).toBeCloseTo(MAX_PAINTER_BIAS + 200 * GROUND_DEPTH, 5);
        for (const row of rows) expect(unpackEffectDrawRadius(row.packed).draw).toBe(0);
        expect(rows.filter((row) => Math.abs(row.bias - MAX_PAINTER_BIAS) < 1e-6)).toHaveLength(2);
      } finally {
        layer.setInstances([], MESH_IDLE_SECONDS + 1);
        texture.dispose();
      }
    },
  );
});
