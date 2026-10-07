import { Vector3 } from 'three/webgpu';
import { describe, expect, it, vi } from 'vitest';
import type { EffectHdAnim } from '../../ra2-assets/src/effects';
import { ENHANCED, type EffectsLayer } from '../src/effects';
import type { EffectArt, ResolvedAnim } from '../src/live/effectArt';
import { effectSphereRadius, engineAnchor, type EffectInstance } from '../src/live/effectSprites';
import { FIREBALL_MERGE, LiveEffectsDriver, type LiveAnim } from '../src/live/effects';
import { fireballDepthBias } from '../src/ra2/fireballDepth';
import { MAX_PAINTER_BIAS } from '../src/ra2/painterOrder';

const HD_TYPES = new Set(['S_BANG48', 'S_TUMU60', 'TWLT070', 'NUKEANIM']);

function resolved(id: string): ResolvedAnim {
  const frames = Array.from({ length: 8 }, (_, i) => ({
    page: 1,
    rect: [i * 12, 0, 10, 12] as [number, number, number, number],
    offset: [-5, -8] as [number, number],
  }));
  return {
    id,
    art: {
      sprite: `anim:${id}`,
      palette: 'anim',
      start: 0,
      frameCount: 8,
      loopStart: 0,
      loopEnd: 8,
      loopCount: 1,
      rate: 900,
      normalized: true,
      rateFrames: 2,
      layer: 'air',
      translucent: true,
      hotW: 10,
      visW: 10,
    },
    sprite: { frames, canvas: [24, 24], palette: 'anim', remap: false },
    palette: 'fx:anim',
    remap: false,
  } as unknown as ResolvedAnim;
}

function fixture(style: 'enhanced' | 'faithful' = 'enhanced') {
  const hd: EffectHdAnim = {
    scale: 2,
    frames: Array.from({ length: 8 }, (_, i) => ({ page: 0, rect: [i * 24, 0, 20, 24], offset: [-5, -8] })),
  };
  const art = {
    ready: true,
    anim: (type: string) => resolved(type),
    hdAnim: (type: string) => (HD_TYPES.has(type) ? hd : null),
    // The redrawn page is there (one still loading keeps the anims' own art on screen).
    hdPageState: () => ({ texture: {}, width: 256, height: 32 }),
  } as unknown as EffectArt;
  const explode = vi.fn();
  const driver = new LiveEffectsDriver({ setBeams: vi.fn(), explode } as unknown as EffectsLayer, () => false);
  driver.style = style;
  driver.hasHdArt = (type) => HD_TYPES.has(type);
  let uid = 0;
  const anims: LiveAnim[] = [];
  const spawn = (type: string, cx: number, cy: number) => {
    uid++;
    anims.push({ id: uid, uid, type, x: Math.round(cx * 256), y: Math.round(cy * 256), z: 0 });
  };
  const push = (frame: number, now: number) =>
    driver.push({ anims: [...anims], bullets: [], particleSystems: [] }, frame, now, new Vector3());
  const cards = () => {
    const out: EffectInstance[] = [];
    driver.cards(art, () => 'fx:anim', out);
    return out;
  };
  return { driver, spawn, push, cards, explode, anims };
}

describe('clustered explosions merge into one or two big fireballs (FIREBALL_MERGE)', () => {
  it('leaves an anim shown as painted out of the merge: the mushroom is neither a lead nor absorbed', () => {
    const f = fixture();
    // The nuclear cloud in the middle of the blasts of what it destroys, all on one logic frame.
    f.spawn('NUKEANIM', 10, 10);
    f.spawn('S_BANG48', 10.4, 10);
    f.spawn('S_TUMU60', 10, 10.5);
    f.spawn('TWLT070', 9.6, 10.2);
    f.push(100, 1);
    const cards = f.cards();
    const nuke = cards.filter((card) => card.hd?.asPainted);
    expect(nuke).toHaveLength(1);
    expect(nuke[0]!.hd!.size).toBe(1);
    expect(nuke[0]!.anchor).toEqual(engineAnchor(2560, 2560, 0, [0, 0]));
    // The three blasts merge among themselves: one lead, grown for three members, at their centroid.
    const blasts = cards.filter((card) => card.hd && !card.hd.asPainted);
    expect(blasts).toHaveLength(1);
    f.push(101, 1 + FIREBALL_MERGE.grow);
    const grown = f.cards().filter((card) => card.hd && !card.hd.asPainted)[0]!;
    expect(grown.hd!.size).toBeCloseTo(
      ENHANCED.hdSize.explosion * Math.min(FIREBALL_MERGE.maxSize, 1 + 2 * FIREBALL_MERGE.perMember),
    );
    expect(f.cards().filter((card) => card.hd?.asPainted)[0]!.hd!.size).toBe(1);
  });

  it('draws a building death batch as one lead at the centroid, growing with its members', () => {
    const f = fixture();
    // The live oil derrick's Explosion= list: three S_BANG48, one S_TUMU60 and an S_CLSN22 without HD art.
    f.spawn('S_BANG48', 71.5, 34.5);
    f.spawn('S_TUMU60', 74.25, 30.46);
    f.spawn('S_BANG48', 71.55, 31.74);
    f.spawn('S_BANG48', 72.66, 32.3);
    f.spawn('S_CLSN22', 72, 32);
    f.push(100, 10);
    // The garnish's draw point is read when it is spawned (the driver reuses the vector on later snapshots).
    const garnishAt = (f.explode.mock.calls[0]![1] as Vector3).clone();
    let out = f.cards();
    expect(out).toHaveLength(1);
    const lead = out[0]!;
    // S_BANG48 is the most fiery member (scale x flame share), not the smoky S_TUMU60.
    expect(lead.hd).toBeDefined();
    const cx = (71.5 + 74.25 + 71.55 + 72.66 + 72) / 5;
    const cy = (34.5 + 30.46 + 31.74 + 32.3 + 32) / 5;
    const centre = engineAnchor(cx * 256, cy * 256, 0, [0, 0]);
    expect(lead.anchor.x).toBeCloseTo(centre.x, 1);
    expect(lead.anchor.z).toBeCloseTo(centre.z, 1);
    const grown = Math.min(FIREBALL_MERGE.maxSize, 1 + FIREBALL_MERGE.perMember * 4);
    // Born together, the lead is drawn at the cluster's size at once and engulfs the members' footprint in depth.
    expect(lead.hd!.size).toBeCloseTo(ENHANCED.hdSize.explosion * grown, 5);
    expect(lead.depthBias).toBeGreaterThan(FIREBALL_MERGE.engulf);
    expect(lead.depthBias).toBeLessThan(FIREBALL_MERGE.engulf + FIREBALL_MERGE.radius * 2);
    const radius = effectSphereRadius(lead);
    const legacy = MAX_PAINTER_BIAS + lead.depthBias!;
    // This widely spread building-death lead retains its complete old engulf profile, even outside the sphere.
    for (const r of [0, radius * 0.6, radius, radius * 2]) expect(fireballDepthBias(r, radius, legacy)).toBe(legacy);
    f.push(102, 10 + FIREBALL_MERGE.grow + 0.01);
    out = f.cards();
    expect(out).toHaveLength(1);
    expect(out[0]!.hd!.size).toBeCloseTo(ENHANCED.hdSize.explosion * grown, 5);
    // One garnish for the whole cluster, sized for the merged fireball, at the centroid.
    expect(f.explode).toHaveBeenCalledTimes(1);
    expect(f.explode.mock.calls[0]![2]).toBeCloseTo(0.83 * grown, 5);
    expect(garnishAt.x).toBeCloseTo(cx, 3);
    expect(garnishAt.z).toBeCloseTo(cy, 3);
  });

  it('keeps a lone blast and a distant blast unchanged', () => {
    const f = fixture();
    f.spawn('TWLT070', 10, 10);
    f.spawn('TWLT070', 10 + FIREBALL_MERGE.radius + 1.5, 10);
    f.push(100, 10);
    const out = f.cards();
    expect(out).toHaveLength(2);
    for (const card of out) expect(card.hd!.size).toBeCloseTo(ENHANCED.hdSize.explosion, 5);
    expect(f.explode).toHaveBeenCalledTimes(2);
    for (const call of f.explode.mock.calls) {
      expect(call[2]).toBeCloseTo(0.93, 5);
      expect(call[4].charWidth).toBeUndefined();
    }
  });

  it.each([
    [[10, 10], [11, 10], [10, 10.5], 2],
    [[10, 10], [10.5, 10], [10, 11], 2],
  ] as const)('measures the foundation before the lead moves to the centroid (%s, %s, %s)', (a, b, c, width) => {
    const f = fixture();
    // The first (and equally fiery) member leads at an extreme; measuring after centring would lose that bound.
    for (const [x, z] of [a, b, c]) f.spawn('TWLT070', x, z);
    f.push(100, 10);
    expect(f.explode).toHaveBeenCalledTimes(1);
    expect(f.explode.mock.calls[0]![4]).toMatchObject({ charWidth: width });
  });

  it('leaves the art-relative char width for a two-member merge below the building-death threshold', () => {
    const f = fixture();
    f.spawn('TWLT070', 10, 10);
    f.spawn('TWLT070', 11, 10);
    f.push(100, 10);
    expect(f.explode).toHaveBeenCalledTimes(1);
    expect(f.explode.mock.calls[0]![4].charWidth).toBeUndefined();
  });

  it('turns a staggered collapse into at most two leads that grow smoothly with later members', () => {
    const f = fixture();
    // Twelve blasts 0.12 s apart over a 3 x 3 foundation (the collapse bench).
    f.spawn('TWLT070', 60, 60);
    f.push(100, 10);
    expect(f.cards()[0]!.hd!.size).toBeCloseTo(ENHANCED.hdSize.explosion, 5);
    f.spawn('TWLT070', 61, 60);
    f.push(102, 10.12);
    // A later member starts the growth from the current size, never a jump.
    expect(f.cards()[0]!.hd!.size).toBeCloseTo(ENHANCED.hdSize.explosion, 5);
    f.push(103, 10.12 + FIREBALL_MERGE.grow);
    expect(f.cards()[0]!.hd!.size).toBeCloseTo(ENHANCED.hdSize.explosion * (1 + FIREBALL_MERGE.perMember), 5);
    for (let i = 2; i < 12; i++) {
      f.spawn('TWLT070', 60 + (i % 3), 60 + Math.floor(i / 3) * 0.7);
      f.push(104 + i * 2, 10 + i * 0.12);
    }
    expect(f.explode).toHaveBeenCalledTimes(2);
    expect(f.cards()).toHaveLength(2);
  });

  it('leaves the faithful style untouched', () => {
    const f = fixture('faithful');
    f.spawn('S_BANG48', 71.5, 34.5);
    f.spawn('S_BANG48', 71.55, 31.74);
    f.spawn('S_BANG48', 72.66, 32.3);
    f.push(100, 10);
    expect(f.cards()).toHaveLength(3);
    expect(f.explode).toHaveBeenCalledTimes(3);
  });
});
