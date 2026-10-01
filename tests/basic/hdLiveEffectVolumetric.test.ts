import { describe, expect, it, vi } from 'vitest';
import { VOLUMETRIC_BLAST_PRESETS, type VolumetricBlast } from '../../packages/hd-renderer/src/volumetricBlasts';
import { VOLUMETRIC_ANIMS } from '../../packages/hd-renderer/src/live/volumetricTable';
import { LiveEffectsDriver, pixelsToWorld, type LiveAnim } from '../../packages/hd-renderer/src/live/effects';
import { animAlphaSmooth, type EffectInstance } from '../../packages/hd-renderer/src/live/effectSprites';
import type { EffectArt, ResolvedAnim } from '../../packages/hd-renderer/src/live/effectArt';
import type { EffectsLayer } from '../../packages/hd-renderer/src/effects';
import { cellToWorld, LEVEL_HEIGHT } from '../../packages/hd-renderer/src/world';

const wind = cellToWorld(0, 0, 0);
function fixture(hidden = false, hd = false) {
  const explode = vi.fn();
  const driver = new LiveEffectsDriver({ explode, setBeams: vi.fn() } as unknown as EffectsLayer, () => hidden);
  driver.style = 'enhanced';
  const frames = Array.from({ length: 20 }, (_, i) => ({
    rect: [i * 8, 0, 8, 8] as [number, number, number, number],
    offset: [-4, -4] as [number, number],
  }));
  const resolved = {
    id: 'EXPLOLRG',
    art: {
      start: 0,
      frameCount: 20,
      loopStart: 0,
      loopEnd: 20,
      loopCount: 1,
      rateFrames: 3,
      visW: 100,
      translucent: true,
      layer: 'air',
    },
    sprite: { frames },
    palette: 'fx:anim',
    remap: false,
  } as ResolvedAnim;
  const art = {
    ready: true,
    anim: () => resolved,
    hdAnim: () => (hd ? { scale: 2, frames: frames.map((f) => ({ ...f, page: 1 })) } : null),
    hdPageState: () => ({}),
  } as unknown as EffectArt;
  const anim: LiveAnim = {
    id: 1,
    uid: 77,
    type: 'EXPLOLRG',
    x: 2560,
    y: 3072,
    z: 104,
    frame: 6,
    stage: 6,
    frameCount: 20,
    rate: 2,
  };
  const push = (a = anim, frame = 100, now = 4) =>
    driver.push({ anims: [a], bullets: [], particleSystems: [] }, frame, now, wind);
  return { driver, art, anim, push, explode };
}

describe('volumetric blast policy', () => {
  it('maps every requested anim to an existing preset at the native half-width scale', () => {
    expect(Object.keys(VOLUMETRIC_ANIMS)).toHaveLength(15);
    for (const row of Object.values(VOLUMETRIC_ANIMS)) {
      expect(VOLUMETRIC_BLAST_PRESETS[row.preset]).toBeDefined();
      expect(row.size).toBe(0.75);
    }
  });
  it('replaces the card and keeps HD garnish with the exact bridge stage clock and level', () => {
    const { driver, art, push, explode } = fixture();
    driver.volumetric = 'ray';
    push();
    const cards: EffectInstance[] = [],
      volumes: VolumetricBlast[] = [];
    expect(driver.cards(art, () => 'fx:anim', cards)).toEqual({ drawn: 0, missing: 0 });
    driver.volumes(art, volumes);
    expect(cards).toEqual([]);
    expect(volumes).toHaveLength(1);
    const b = volumes[0]!;
    expect(b.anchor.toArray()).toEqual([10, LEVEL_HEIGHT, 12]);
    expect(b.radius).toBeCloseTo((0.75 * pixelsToWorld(100)) / 2);
    expect(b.progress0).toBe(0.3);
    expect(b.rate).toBe(15 / (20 * 2));
    expect(b.lifeSeconds).toBe((20 * 2) / 15);
    expect(b.t0).toBe(4);
    expect(b.seed).toBe(77);
    expect(b.fade).toBeCloseTo(Math.sqrt(animAlphaSmooth({ translucent: true }, 6, 20)));
    expect(b.push).toBeGreaterThan(0);
    expect(explode.mock.calls[0]![4]).toMatchObject({ hdArt: true, enhanced: true });
    driver.push({ anims: [], bullets: [], particleSystems: [] }, 101, 4.1, wind);
    const gone: VolumetricBlast[] = [];
    driver.volumes(art, gone);
    expect(gone).toEqual([]);
  });
  it.each([false, true])('retains the usual card with volumes off (HD=%s)', (hd) => {
    const { driver, art, push } = fixture(false, hd);
    push();
    const cards: EffectInstance[] = [],
      volumes: VolumetricBlast[] = [];
    driver.cards(art, () => 'fx:anim', cards);
    driver.volumes(art, volumes);
    expect(cards).toHaveLength(1);
    expect(!!cards[0]!.hd).toBe(hd);
    expect(volumes).toEqual([]);
  });
  it.each(['faithful', 'garnishOff', 'hidden', 'unlisted'] as const)('does not route volumes for %s', (gate) => {
    const { driver, art, push, anim } = fixture(gate === 'hidden');
    driver.volumetric = 'ray';
    if (gate === 'faithful') driver.style = 'faithful';
    if (gate === 'garnishOff') driver.garnishEnabled = false;
    push(gate === 'unlisted' ? { ...anim, type: 'UNLISTED' } : anim);
    const volumes: VolumetricBlast[] = [],
      cards: EffectInstance[] = [];
    driver.volumes(art, volumes);
    driver.cards(art, () => 'fx:anim', cards);
    expect(volumes).toEqual([]);
    expect(cards).toHaveLength(gate === 'hidden' ? 0 : 1);
  });
  it('uses fallback stage plus fractional stage and sidecar rateFrames at the measured logicFps', () => {
    const { driver, art, push, anim } = fixture();
    driver.volumetric = 'ray';
    const a = { ...anim, frame: undefined, stage: undefined, rate: undefined, frameCount: undefined };
    push(a, 100, 4);
    push(a, 107, 4.35);
    // Seven logic frames: sidecar rate 3 -> stage 2 plus 1/3. EMA rate is 15.5 fps.
    const volumes: VolumetricBlast[] = [];
    driver.volumes(art, volumes);
    expect(volumes[0]!.progress0).toBeCloseTo((2 + 1 / 3) / 20);
    expect(volumes[0]!.rate).toBeCloseTo(15.5 / 60);
    expect(volumes[0]!.t0).toBe(4.35);
  });
});
