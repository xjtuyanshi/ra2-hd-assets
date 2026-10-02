/**
 * HD live view: the garnish table, the fallback anim timing, the effects driver (logic-frame clock, garnish rules,
 * native card frames) and the bridge-field consumers, with synthetic snapshots (no GPU, no game).
 */
import { describe, expect, it, vi } from 'vitest';
import { animFrameAt, animRateFrames } from '../../packages/ra2-assets/src/effects';
import { EffectsLayer, beamSegments, dirtySpans, type BeamSpec } from '../../packages/hd-renderer/src/effects';
import { cellToWorld } from '../../packages/hd-renderer/src/world';
import type { EffectArt, ResolvedAnim } from '../../packages/hd-renderer/src/live/effectArt';
import { CAPTURABLE_BUILDINGS, EFFECT_TABLE, SMOKE_SYSTEMS } from '../../packages/hd-renderer/src/live/effectTable';
import {
  LiveEffectsDriver,
  SMOKE_SPAWN_WINDOW,
  advanceSmoke,
  animStage,
  cardGlows,
  effectRow,
  smokeParticleAt,
  smokeOnVehicle,
  smokeUnlimited,
  type LiveAnim,
  type LiveEffects,
  type LiveParticleSystem,
  type SmokeParticle,
} from '../../packages/hd-renderer/src/live/effects';
import type { EffectInstance } from '../../packages/hd-renderer/src/live/effectSprites';
import { animAlpha } from '../../packages/hd-renderer/src/live/effectSprites';
import {
  buildupStepFrames,
  civilianHouses,
  indexBuildingAnims,
  fallbackLayer,
  layerFrame,
  layerIdle,
  looksLikeStorage,
  objectLight,
} from '../../packages/hd-renderer/src/live/liveView';
import { bulletFrame, velocityFacing } from '../../packages/hd-renderer/src/live/projectiles';

describe('garnish table', () => {
  it('classifies the common combat anims as measured', () => {
    expect(effectRow('PIFFPIFF')).toMatchObject({ c: 'impact', fx: 'spark', s: 0.55 });
    expect(effectRow('SMOKEY2')).toMatchObject({ c: 'smoke', fx: 'smoke', s: 0.28 });
    expect(effectRow('SMOKEY2').loop).toBeUndefined();
    expect(effectRow('TWLT026').s).toBe(0.26);
    expect(effectRow('TWLT036').s).toBe(0.36);
    expect(effectRow('TWLT070')).toMatchObject({ fx: 'explosion', s: 0.93, life: 52 });
    expect(effectRow('S_BRNL58').s).toBe(0.55);
    expect(effectRow('S_CLSN58').s).toBe(0.71);
    expect([effectRow('FIRE01').s, effectRow('FIRE02').s, effectRow('FIRE03').s]).toEqual([0.88, 1.04, 0.62]);
    expect(effectRow('FIRE01').loop).toBe(1);
    expect(effectRow('HTRKPUFF').s).toBe(1.05);
    expect(effectRow('VTMUZZLE').fx).toBe('muzzle');
    expect(effectRow('NUKEPUFF').fx).toBe('smoke');
    // Native-art-only rows: the original art is the whole effect.
    expect(effectRow('TSTIMPCT').fx).toBe('none');
    expect(effectRow('CDGAS').fx).toBe('none');
    expect(effectRow('DEATH_A').c).toBe('corpse');
  });

  it('falls back to no garnish for unknown ids and is case-insensitive', () => {
    expect(effectRow('NOT_AN_ANIM')).toMatchObject({ fx: 'none', s: 0 });
    expect(effectRow('twlt070')).toBe(EFFECT_TABLE['TWLT070']);
  });

  it('never shakes the camera except for super weapons', () => {
    for (const [id, row] of Object.entries(EFFECT_TABLE))
      if (row.shake) expect([id, row.c]).toEqual([id, 'superweapon']);
  });
});

describe('fallback anim timing', () => {
  it('derives the engine step length from Rate= and Normalized=', () => {
    expect(animRateFrames(undefined, false)).toBe(1); // GUNFIRE
    expect(animRateFrames(undefined, true)).toBe(2); // TWLT070
    expect(animRateFrames(450, false)).toBe(2); // FIRE01
    expect(animRateFrames(10, false)).toBe(90); // DEATH_A
    expect(animRateFrames(220, true)).toBe(7); // GAPOWR_A
    expect(animRateFrames(200, true)).toBe(7); // NAREFNL1
    expect(animRateFrames(300, true)).toBe(5); // NAPOWR_A
    expect(animRateFrames(220, false)).toBe(4); // CAOILD_A
  });

  it('plays a one-shot anim once and ends it', () => {
    const twlt = { start: 0, frameCount: 26, loopStart: 0, loopEnd: 26, loopCount: 1, rateFrames: 2 };
    expect(animFrameAt(twlt, 0)).toBe(0);
    expect(animFrameAt(twlt, 3)).toBe(1);
    expect(animFrameAt(twlt, 51)).toBe(25);
    expect(animFrameAt(twlt, 52)).toBeNull();
  });

  it('loops LoopStart..LoopEnd - 1 forever for LoopCount=-1', () => {
    const powr = { start: 0, frameCount: 32, loopStart: 0, loopEnd: 8, loopCount: -1, rateFrames: 7 };
    expect(animFrameAt(powr, 7 * 7)).toBe(7);
    expect(animFrameAt(powr, 8 * 7)).toBe(0);
    expect(animFrameAt(powr, 1000 * 7 + 3)).toBe(1000 % 8);
  });

  it('repeats the loop LoopCount times, then runs to the end', () => {
    const a = { start: 0, frameCount: 10, loopStart: 2, loopEnd: 5, loopCount: 3, rateFrames: 1 };
    const seq = Array.from({ length: 20 }, (_, i) => animFrameAt(a, i));
    expect(seq).toEqual([0, 1, 2, 3, 4, 2, 3, 4, 2, 3, 4, 5, 6, 7, 8, 9, null, null, null, null]);
  });
});

/** A recording stand-in for the HD effects layer. */
function fakeLayer() {
  const calls: { method: string; args: unknown[] }[] = [];
  const record =
    (method: string) =>
    (...args: unknown[]) =>
      calls.push({ method, args });
  const layer = {
    explode: vi.fn(record('explode')),
    muzzleFlash: vi.fn(record('muzzleFlash')),
    sparkFlash: vi.fn(record('sparkFlash')),
    impact: vi.fn(record('impact')),
    smokePuff: vi.fn(record('smokePuff')),
    flame: vi.fn(record('flame')),
    fireLight: vi.fn(record('fireLight')),
    setBeams: vi.fn(record('setBeams')),
    bulletDot: vi.fn(record('bulletDot')),
    shakeCamera: vi.fn(record('shakeCamera')),
  };
  return { layer: layer as unknown as EffectsLayer, calls, fns: layer };
}

const anim = (type: string, uid: number, extra: Partial<LiveAnim> = {}): LiveAnim => ({
  id: uid,
  uid,
  type,
  x: 10 * 256,
  y: 10 * 256,
  z: 0,
  ...extra,
});
const effects = (anims: LiveAnim[], more: Partial<LiveEffects> = {}): LiveEffects => ({
  anims,
  bullets: [],
  particleSystems: [],
  ...more,
});
/** Wind is only passed through to the (fake) effects layer. */
const wind = { x: 0, y: 0, z: 0 } as unknown as Parameters<LiveEffectsDriver['push']>[3];

describe('LiveEffectsDriver', () => {
  it('spawns garnish once per anim, keeps it inside the art and never paints a scorch', () => {
    const { layer, fns } = fakeLayer();
    const driver = new LiveEffectsDriver(layer, () => false);
    driver.artWidth = () => 112 / (60 / Math.SQRT2);
    driver.push(effects([anim('TWLT070', 1)]), 1000, 10, wind);
    driver.push(effects([anim('TWLT070', 1)]), 1001, 10.066, wind);
    expect(fns.explode).toHaveBeenCalledTimes(1);
    const options = fns.explode.mock.calls[0]![4] as {
      scorch: boolean;
      maxSize: number;
      smoke: number;
      light: number[];
    };
    expect(options.scorch).toBe(false);
    expect(options.maxSize).toBeCloseTo(112 / (60 / Math.SQRT2), 6);
    expect(options.light).toEqual(EFFECT_TABLE['TWLT070']!.light);
    expect(fns.shakeCamera).not.toHaveBeenCalled();
  });

  it('re-classifies an anim that chains to its Next type and forgets anims that left the list', () => {
    const { layer, fns } = fakeLayer();
    const driver = new LiveEffectsDriver(layer, () => false);
    driver.push(effects([anim('GUNFIRE', 7)]), 10, 1, wind);
    driver.push(effects([anim('TWLT070', 7)]), 11, 1.07, wind);
    expect(fns.muzzleFlash).toHaveBeenCalledTimes(1);
    expect(fns.explode).toHaveBeenCalledTimes(1);
    driver.push(effects([]), 12, 1.13, wind);
    expect(driver.tracked.size).toBe(0);
  });

  it('adds no smoke for small blasts and one puff per trail anim', () => {
    const { layer, fns } = fakeLayer();
    const driver = new LiveEffectsDriver(layer, () => false);
    driver.push(effects([anim('S_CLSN22', 1), anim('SMOKEY2', 2)]), 10, 1, wind);
    expect((fns.explode.mock.calls[0]![4] as { smoke: number }).smoke).toBe(0);
    expect(fns.smokePuff).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 30; i++) driver.frame(1 + i / 60, wind);
    expect(fns.smokePuff).toHaveBeenCalledTimes(1);
  });

  it('adds no HD flame to looping fires (their art is the whole flame), flames fire systems, nothing under shroud', () => {
    const { layer, fns } = fakeLayer();
    let shrouded = false;
    const driver = new LiveEffectsDriver(layer, () => shrouded);
    driver.push(effects([anim('FIRE01', 1)]), 10, 1, wind);
    for (let i = 0; i < 60; i++) driver.frame(1 + i / 60, wind);
    expect(fns.flame).not.toHaveBeenCalled();
    // A looping fire only keeps its small light alive, a few times a second, under the anim's own key.
    expect(fns.fireLight.mock.calls.length).toBeGreaterThanOrEqual(4);
    expect(fns.fireLight.mock.calls.length).toBeLessThanOrEqual(6);
    expect(new Set(fns.fireLight.mock.calls.map((c) => c[0]))).toEqual(new Set(['anim:1:1']));
    const fire = { id: 3, uid: 3, behaviour: 'fire' as const, x: 0, y: 0, z: 0 };
    driver.push(effects([anim('FIRE01', 1)], { particleSystems: [fire] }), 11, 2, wind);
    for (let i = 0; i < 60; i++) driver.frame(2 + i / 60, wind);
    expect(fns.flame.mock.calls.length).toBeGreaterThan(5);
    // Fire systems keep their light under the system's key, garnish-sized (options given).
    expect(fns.flame.mock.calls[0]![3]).toBe('system:3:3');
    expect(fns.flame.mock.calls[0]![4]).toMatchObject({ maxSize: expect.any(Number) });
    shrouded = true;
    const before = fns.flame.mock.calls.length;
    const lightsBefore = fns.fireLight.mock.calls.length;
    for (let i = 60; i < 120; i++) driver.frame(2 + i / 60, wind);
    expect(fns.flame.mock.calls.length).toBe(before);
    expect(fns.fireLight.mock.calls.length).toBe(lightsBefore);
  });

  it('never shakes the camera, super-weapon rows included', () => {
    const { layer, fns } = fakeLayer();
    const driver = new LiveEffectsDriver(layer, () => false);
    const shaking = Object.keys(EFFECT_TABLE).filter((id) => EFFECT_TABLE[id]!.shake);
    expect(shaking.length).toBeGreaterThan(0);
    driver.push(effects(shaking.map((id, i) => anim(id, 100 + i))), 10, 1, wind);
    for (let i = 0; i < 30; i++) driver.frame(1 + i / 60, wind);
    expect(fns.shakeCamera).not.toHaveBeenCalled();
  });

  it('draws no HD puffs for smoke systems and ignores gas (their particles are drawn natively)', () => {
    const { layer, fns } = fakeLayer();
    const driver = new LiveEffectsDriver(layer, () => false);
    const systems = [
      { id: 1, uid: 1, behaviour: 'smoke' as const, x: 0, y: 0, z: 0 },
      { id: 2, uid: 2, behaviour: 'gas' as const, x: 0, y: 0, z: 0 },
    ];
    driver.push(effects([], { particleSystems: systems }), 10, 1, wind);
    for (let i = 0; i <= 180; i++) driver.frame(1 + i / 60, wind);
    expect(fns.smokePuff).not.toHaveBeenCalled();
  });

  it('draws unknown projectiles as grey dots, never fire', () => {
    const { layer, fns } = fakeLayer();
    const driver = new LiveEffectsDriver(
      layer,
      () => false,
      (type) => type === 'Cannon',
    );
    driver.push(
      effects([], {
        bullets: [
          { id: 1, uid: 1, x: 0, y: 0, z: 0 },
          { id: 2, uid: 2, x: 0, y: 0, z: 0, type: 'Cannon' },
        ],
      }),
      10,
      1,
      wind,
    );
    driver.frame(1, wind);
    expect(fns.bulletDot).toHaveBeenCalledTimes(1);
    expect(fns.flame).not.toHaveBeenCalled();
    expect(fns.explode).not.toHaveBeenCalled();
  });

  it('sets beams once per logic frame in the bolt colour and keeps one shape per two logic frames', () => {
    const { layer, fns } = fakeLayer();
    const driver = new LiveEffectsDriver(layer, () => false);
    const bolt = (colour: [number, number, number]) => ({
      source: { x: 0, y: 0, z: 0 },
      target: { x: 512, y: 512, z: 0 },
      kind: 'bolt' as const,
      colour,
    });
    driver.push(effects([], { beams: [bolt([150, 200, 255]), bolt([190, 90, 255])] }), 20, 1, wind);
    // Presented frames between snapshots rebuild nothing: the layer keeps the logic frame's beams.
    for (let i = 0; i < 10; i++) driver.frame(1 + i / 120, wind);
    expect(fns.setBeams).toHaveBeenCalledTimes(1);
    driver.push(effects([], { beams: [bolt([150, 200, 255])] }), 21, 1.07, wind);
    driver.push(effects([]), 22, 1.13, wind);
    expect(fns.setBeams).toHaveBeenCalledTimes(3);
    const specs = fns.setBeams.mock.calls.map((c) => c[1] as BeamSpec[]);
    const [tesla, violet] = specs[0]!.map((b) => b.colour);
    expect(tesla!.z).toBeGreaterThan(tesla!.x);
    expect(violet!.z).toBeGreaterThan(violet!.y);
    expect(violet!.x).toBeGreaterThan(violet!.y);
    // Frames 20 and 21 share a shape seed; a frame without beams clears them.
    expect(specs[0]![0]!.seed).toBe(specs[1]![0]!.seed);
    expect(specs[2]).toEqual([]);
  });

  it('draws native cards at the bridge frame, or the fallback frame counted from the first sighting', () => {
    const { layer } = fakeLayer();
    const driver = new LiveEffectsDriver(layer, () => false);
    const frames = Array.from({ length: 26 }, (_, i) => ({
      rect: [i * 10, 0, 8, 8] as [number, number, number, number],
      offset: [-4, -4] as [number, number],
    }));
    const resolved: ResolvedAnim = {
      id: 'TWLT070',
      art: {
        sprite: 'anim:TWLT070',
        palette: 'anim',
        start: 0,
        frameCount: 26,
        loopStart: 0,
        loopEnd: 26,
        loopCount: 1,
        rate: 900,
        normalized: true,
        rateFrames: 2,
        layer: 'air',
        translucent: true,
        hotW: 42,
        visW: 112,
      },
      sprite: { palette: 'anim', remap: false, canvas: [186, 196], frames },
      palette: 'fx:anim',
      remap: false,
    };
    const art = { ready: true, anim: () => resolved } as unknown as EffectArt;
    const out: EffectInstance[] = [];
    driver.push(effects([anim('TWLT070', 1), anim('TWLT070', 2, { frame: 17 })]), 100, 1, wind);
    driver.push(effects([anim('TWLT070', 1), anim('TWLT070', 2, { frame: 18 })]), 106, 1.4, wind);
    const stats = driver.cards(art, () => 'fx:anim', out);
    expect(stats).toEqual({ drawn: 2, missing: 0 });
    // Fallback: 6 frames after the first sighting at 2 logic frames per step -> frame 3; bridge: frame 18.
    expect(out.map((i) => i.frame.rect[0] / 10).sort((a, b) => a - b)).toEqual([3, 18]);
    expect(out.every((i) => i.pass === 'air' && i.draw === 'card')).toBe(true);
    // Translucent=yes fades by stage: frame 3 of 26 is in the solid first fifth, frame 18 past 0.6 x End.
    const byFrame = [...out].sort((a, b) => a.frame.rect[0] - b.frame.rect[0]);
    expect(byFrame.map((i) => i.alpha)).toEqual([1, 0.25]);
  });

  it('keeps a Translucent=yes card solid while its bridge stage is early, whatever its frame', () => {
    const { layer } = fakeLayer();
    const driver = new LiveEffectsDriver(layer, () => false);
    const frames = Array.from({ length: 10 }, (_, i) => ({
      rect: [i * 10, 0, 8, 8] as [number, number, number, number],
      offset: [-4, -4] as [number, number],
    }));
    const resolved = {
      id: 'S_BANG48',
      art: {
        start: 0,
        frameCount: 10,
        loopStart: 0,
        loopEnd: 10,
        loopCount: 1,
        rateFrames: 1,
        layer: 'air',
        translucent: true,
      },
      sprite: { frames },
      palette: 'fx:anim',
      remap: false,
    } as unknown as ResolvedAnim;
    const art = { ready: true, anim: () => resolved } as unknown as EffectArt;
    driver.push(
      effects([
        anim('S_BANG48', 1, { frame: 2, stage: 2, frameCount: 10 }),
        anim('S_BANG48', 2, { frame: 5, stage: 5, frameCount: 10 }),
      ]),
      10,
      1,
      wind,
    );
    const out: EffectInstance[] = [];
    driver.cards(art, () => 'fx:anim', out);
    expect(out.map((i) => i.alpha)).toEqual([1, 0.5]);
  });
});

describe('translucency', () => {
  it('maps the engine draw modes to opacity', () => {
    expect(animAlpha({})).toBe(1);
    expect(animAlpha({ translucency: 25 })).toBe(0.75);
    expect(animAlpha({ translucency: 50 })).toBe(0.5);
    expect(animAlpha({ translucency: 75 })).toBe(0.25);
  });

  it('fades Translucent=yes anims in the engine stages: solid, then 75, 50 and 25 % opaque', () => {
    // gamemd 1.001 AnimClass draw: stage > 0.6 End -> 25 %, > 0.4 End -> 50 %, > 0.2 End -> 75 %, else opaque.
    const at = (stage: number, end: number) => animAlpha({ translucent: true }, stage, end);
    expect([0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((stage) => at(stage, 10))).toEqual([
      1, 1, 1, 0.75, 0.75, 0.5, 0.5, 0.25, 0.25, 0.25,
    ]);
    expect([5, 6, 10, 11, 15, 16].map((stage) => at(stage, 26))).toEqual([1, 0.75, 0.75, 0.5, 0.5, 0.25]);
    // Translucent is checked before Translucency.
    expect(animAlpha({ translucent: true, translucency: 75 }, 0, 10)).toBe(1);
  });

  it('counts the stage back from the end for Reverse art', () => {
    expect(animStage({ start: 4, frameCount: 10 }, 4)).toBe(0);
    expect(animStage({ start: 4, frameCount: 10 }, 9)).toBe(5);
    expect(animStage({ start: 4, frameCount: 10, reverse: true }, 13)).toBe(0);
    expect(animStage({ start: 4, frameCount: 10, reverse: true }, 4)).toBe(9);
  });
});

describe('building layers without the bridge', () => {
  const refinery = [
    { key: 'ActiveAnim', sprite: 'anim:NAREFNL1' },
    { key: 'ActiveAnimTwo', sprite: 'anim:NAREFNL2' },
    { key: 'ActiveAnimThree', sprite: 'anim:NAREFNL3' },
    { key: 'ActiveAnimFour', sprite: 'anim:NAREFNL4' },
  ];
  const derrick = [
    { key: 'ActiveAnim', sprite: 'anim:CAOILD_A' },
    { key: 'ActiveAnimTwo', sprite: 'anim:CAOILD_F' },
  ];

  it("never draws a storage building's ActiveAnimTwo..Four (ore levels)", () => {
    expect(refinery.filter((l) => fallbackLayer(l, true)).map((l) => l.key)).toEqual(['ActiveAnim']);
    expect(looksLikeStorage(refinery)).toBe(true);
  });

  it('draws always-on layers of other buildings and no production or special layers', () => {
    expect(derrick.filter((l) => fallbackLayer(l, false)).map((l) => l.key)).toEqual(['ActiveAnim', 'ActiveAnimTwo']);
    expect(looksLikeStorage(derrick)).toBe(false);
    expect(fallbackLayer({ key: 'ProductionAnim' }, false)).toBe(false);
    expect(fallbackLayer({ key: 'SpecialAnim' }, false)).toBe(false);
    expect(fallbackLayer({ key: 'IdleAnim' }, true)).toBe(true);
  });

  it('steps a layer on logic frames at the engine rate (GAPOWR_A: 7 frames per step over 0..7)', () => {
    const layer = { anim: { start: 0, loopStart: 0, loopEnd: 8, loopCount: -1, rate: 220 } };
    expect(layerFrame(layer, 16, 0, undefined, true)).toBe(0);
    expect(layerFrame(layer, 16, 6, undefined, true)).toBe(0);
    expect(layerFrame(layer, 16, 7, undefined, true)).toBe(1);
    expect(layerFrame(layer, 16, 7 * 8, undefined, true)).toBe(0);
    // A period of 56 logic frames, independent of the wall clock.
    for (let f = 0; f < 200; f++) expect(layerFrame(layer, 16, f + 56, 7)).toBe(layerFrame(layer, 16, f, 7));
  });

  it('spreads a make anim over the build-up time, stretched only for Normalized buildings', () => {
    // GACNSTMK (29 frames, GACNST art not Normalized): one logic frame per make frame, as measured on an MCV deploy.
    expect(buildupStepFrames(29)).toBe(1);
    expect(buildupStepFrames(25)).toBe(2);
    expect(buildupStepFrames(25, true)).toBe(3);
    expect(buildupStepFrames(10, true)).toBe(Math.round(5 * 1.69));
  });
});

describe('projectile frames', () => {
  it('turns rotating art along the flight direction and plays other art by its own frame', () => {
    expect(velocityFacing(0, -10)).toBe(0);
    expect(velocityFacing(10, 0)).toBe(64);
    expect(velocityFacing(0, 10)).toBe(128);
    const bullet = { id: 1, uid: 1, x: 0, y: 0, z: 0, frame: 5, velocity: { x: 10, y: 0, z: 0 } };
    expect(bulletFrame(bullet, 32, false)).toBe(5);
    expect(bulletFrame(bullet, 1, true)).toBe(0);
    expect(bulletFrame({ ...bullet, velocity: { x: 0, y: -10, z: 0 } }, 32, true)).toBe(28);
  });
});

describe('smoke particles (fallback for the engine particles the page does not forward)', () => {
  const rules = SMOKE_SYSTEMS['SmallGreySSys']!;
  const system = (extra: Partial<LiveParticleSystem> = {}): LiveParticleSystem => ({
    id: 1,
    uid: 77,
    behaviour: 'smoke',
    x: 4000,
    y: 5000,
    z: 208,
    ...extra,
  });
  const track = (s: LiveParticleSystem, unlimited = false) => ({
    system: s,
    since: 100,
    smoke: [] as SmokeParticle[],
    spawned: 0,
    unlimited,
  });

  it('takes the rules of SmallGreySSys (SGRYSMK1 every 10 frames, 80-frame particles, 50 % translucent)', () => {
    expect(rules).toMatchObject({ particle: 'SmallGreySmoke', spawnFrames: 10, cap: 7, stateAdvance: 4, endState: 20 });
    expect(rules.translucency).toBe(50);
  });

  it('spawns every SpawnFrames frames within the measured window, catching up skipped frames, then lets them rise out', () => {
    const t = track(system());
    advanceSmoke(t, 100 + SMOKE_SPAWN_WINDOW + 30);
    // Spawns at +5, +15, +25, +35, +45 (the damage smoke systems measured all showed 5 particles).
    expect(t.smoke.map((p) => p.born - 100)).toEqual([5, 15, 25, 35, 45]);
    advanceSmoke(t, 100 + 45 + rules.endState * rules.stateAdvance);
    expect(t.smoke).toEqual([]);
  });

  it("keeps a damaged vehicle's smoke going for as long as the system is listed", () => {
    const vehicleAt = (x: number, y: number, z: number) => x === 4000 && y === 5000 && z === 208;
    expect(smokeUnlimited(system(), vehicleAt)).toBe(true);
    expect(smokeUnlimited(system({ x: 4001 }), vehicleAt)).toBe(false);
    expect(smokeUnlimited(system({ lifetime: -30 }), null)).toBe(true);
    expect(smokeUnlimited(system({ lifetime: 48 }), vehicleAt)).toBe(false);
    expect(smokeUnlimited(system({ attachedTo: { id: 1, uid: 2, kind: 'building' } }), vehicleAt)).toBe(false);
    // Without attachment: on the vehicle, or at the HTNK's offset above its rear; a chimney two cells away is not.
    const tanks = [{ x: 4000, y: 5000, z: 208 }];
    expect(smokeOnVehicle(tanks, 4000, 5000, 208)).toBe(true);
    expect(smokeOnVehicle(tanks, 4100, 5100, 483)).toBe(true);
    expect(smokeOnVehicle(tanks, 4512, 5000, 208)).toBe(false);
    expect(smokeOnVehicle(tanks, 4000, 5000, 100)).toBe(false);
    const t = track(system(), true);
    advanceSmoke(t, 100 + 1000);
    expect(t.smoke.length).toBe(rules.cap);
    expect(t.spawned).toBeGreaterThan(90);
  });

  it('rises with the measured kinematics and advances one SHP frame every StateAIAdvance frames', () => {
    const p: SmokeParticle = { born: 0, x: 0, y: 0, z: 0, rise: 0.94, driftX: 0, driftY: 0 };
    const at = (age: number) => smokeParticleAt(p, rules, age)!;
    expect(at(0).z).toBe(10);
    // Over its first 60 frames it rises about 7 leptons a frame (6..8 measured), decelerating.
    expect((at(60).z - at(0).z) / 60).toBeGreaterThan(6);
    expect((at(60).z - at(0).z) / 60).toBeLessThan(8);
    expect(at(60).z - at(50).z).toBeLessThan(at(10).z - at(0).z);
    expect([at(0).frame, at(3).frame, at(4).frame, at(79).frame]).toEqual([0, 0, 1, 19]);
    expect(smokeParticleAt(p, rules, 80)).toBeNull();
  });

  it('draws each particle with the particle art at its translucency in the air pass, never glowing', () => {
    const { layer } = fakeLayer();
    const driver = new LiveEffectsDriver(layer, () => false);
    const frames = Array.from({ length: 20 }, (_, i) => ({
      rect: [i * 10, 0, 8, 8] as [number, number, number, number],
      offset: [-4, -4] as [number, number],
    }));
    const art = {
      particle: (id: string) =>
        id === 'SmallGreySmoke'
          ? { art: { sprite: 'anim:SGRYSMK1', palette: 'anim', translucency: 50 }, sprite: { frames } }
          : null,
    } as unknown as EffectArt;
    driver.push(effects([], { particleSystems: [system()] }), 100, 1, wind);
    driver.push(effects([], { particleSystems: [system()] }), 130, 3, wind);
    const out: EffectInstance[] = [];
    expect(driver.smokeCards(art, out)).toBe(3);
    expect(out.every((i) => i.alpha === 0.5 && i.pass === 'air' && !i.glow && i.palette === 'fx:anim')).toBe(true);
    // Particles born at 105, 115, 125: SHP frames 6, 3 and 1 at frame 130.
    expect(out.map((i) => i.frame.rect[0] / 10).sort((a, b) => a - b)).toEqual([1, 3, 6]);
  });
});

describe('native card glow', () => {
  const oneShot = { start: 0, frameCount: 26, loopCount: 1 };
  it('never boosts translucent explosions, looping fires or remapped art', () => {
    expect(cardGlows(oneShot, 2, 0.5, false)).toBe(false);
    expect(cardGlows({ start: 0, frameCount: 64, loopCount: -1 }, 2, 1, false)).toBe(false);
    expect(cardGlows(oneShot, 2, 1, true)).toBe(false);
  });
  it('boosts opaque one-shot art in its bright early frames only', () => {
    expect(cardGlows(oneShot, 2, 1, false)).toBe(true);
    expect(cardGlows(oneShot, 18, 1, false)).toBe(false);
  });
});

describe('beams and particle uploads', () => {
  it('draws a laser as one segment and a bolt as three jagged strands of quarter-cell pieces', () => {
    const from = { x: 0, y: 0, z: 0 };
    const to = { x: 4, y: 0, z: 0 };
    expect(beamSegments(from, to, false, 1)).toHaveLength(1);
    const bolt = beamSegments(from, to, true, 7);
    expect(bolt).toHaveLength(3 * 16);
    // Same seed, same shape; strands start and end on the endpoints.
    expect(beamSegments(from, to, true, 7).map(([a]) => a.toArray())).toEqual(bolt.map(([a]) => a.toArray()));
    expect(bolt[0]![0].toArray()).toEqual([0, 0, 0]);
    expect(bolt[15]![1].toArray()).toEqual([4, 0, 0]);
    expect(Math.max(...bolt.map(([a]) => Math.abs(a.z)))).toBeLessThanOrEqual(0.12);
  });
  it('uploads the written span of a ring buffer as at most two ranges', () => {
    expect(dirtySpans(10, 0, 100)).toEqual([]);
    expect(dirtySpans(10, 5, 100)).toEqual([[10, 5]]);
    expect(dirtySpans(98, 5, 100)).toEqual([
      [98, 2],
      [0, 3],
    ]);
    expect(dirtySpans(40, 250, 100)).toEqual([[0, 100]]);
  });
});

describe('civilian houses, object light and idle tech buildings', () => {
  const buildable = (type: string) => /^(GA|NA)/.test(type);
  const building = (owner: number, type: string) => ({ owner, type, kind: 'building' as const }) as never;
  it('infers civilian houses from what they own unless the bridge flags them', () => {
    const snapshot = {
      houses: [
        { index: 0, colorIndex: 3 },
        { index: 1, colorIndex: 17 },
        { index: 2, colorIndex: 5 },
      ],
      objects: [building(0, 'GACNST'), building(2, 'CAOILD'), building(2, 'CASTL01')],
    };
    // House 1 owns no building yet (an MCV): not civilian.
    expect([...civilianHouses(snapshot, buildable)]).toEqual([2]);
    expect([...civilianHouses(snapshot, null)]).toEqual([]);
    const flagged = { ...snapshot, houses: snapshot.houses.map((h) => ({ ...h, civilian: h.index === 1 })) };
    expect([...civilianHouses(flagged, buildable)]).toEqual([1]);
  });
  it('brightens infantry, SHP vehicles and aircraft by the Extra*Light rules, never buildings', () => {
    expect(objectLight('infantry')).toBeCloseTo(1.2, 6);
    expect(objectLight('vehicle')).toBeCloseTo(1.2, 6);
    expect(objectLight('aircraft')).toBeCloseTo(1.2, 6);
    expect(objectLight('building')).toBe(1);
  });
  it("holds a civilian tech building's powered layers still (the derrick pump) but not its flame or a flag", () => {
    expect(CAPTURABLE_BUILDINGS).toContain('CAOILD');
    expect(CAPTURABLE_BUILDINGS).not.toContain('CAUSFGL');
    expect(layerIdle({}, 'CAOILD', true)).toBe(true);
    expect(layerIdle({ powered: false }, 'CAOILD', true)).toBe(false);
    expect(layerIdle({}, 'CAUSFGL', true)).toBe(false);
    expect(layerIdle({}, 'CAOILD', false)).toBe(false);
  });
});

describe('EffectsLayer', () => {
  /** Seconds (effect clock) until which each particle pool draws something. */
  const busy = (layer: EffectsLayer) =>
    Object.fromEntries(
      Object.entries(layer as unknown as Record<string, { until?: number }>)
        .filter(([, v]) => typeof v?.until === 'number')
        .map(([k, v]) => [k, v.until!]),
    );
  const beamMesh = (layer: EffectsLayer) =>
    layer.root.children.find((c) => c.name === 'hd-beams') as unknown as {
      material: { side: number };
      visible: boolean;
      count: number;
    };

  it('draws beam quads from both faces and hides the beam mesh while it is empty', () => {
    const layer = new EffectsLayer();
    const mesh = beamMesh(layer);
    // The quad's winding follows the segment's direction on screen: single-sided, half the segments were culled
    // (every bolt vanished). THREE.DoubleSide = 2.
    expect(mesh.material.side).toBe(2);
    expect(mesh.visible).toBe(false);
    const bolt: BeamSpec = {
      from: cellToWorld(10, 10, 0),
      to: cellToWorld(13, 11, 1),
      colour: cellToWorld(0.2, 1, 0.4),
      bolt: true,
      seed: 7,
    };
    layer.setBeams(0, [bolt]);
    expect(layer.beamSegmentCount).toBe(beamSegments(bolt.from, bolt.to, true, 7).length);
    expect(mesh.visible).toBe(true);
    layer.setBeams(0.1, []);
    expect(layer.beamSegmentCount).toBe(0);
    expect(mesh.visible).toBe(false);
  });

  it("keeps the renderer's full explosion for its own events, and only a small garnish with native-art limits", () => {
    const wind = cellToWorld(0, 0, 0);
    const full = new EffectsLayer();
    full.explode(1, cellToWorld(10, 10, 0), 1, wind);
    const f = busy(full);
    // Rolling fireballs, smoke, shockwave, sparks and scorch, and camera shake.
    expect(f['fireballs']).toBeGreaterThan(1.5);
    expect(f['smoke']).toBeGreaterThan(4);
    expect(f['shock']).toBeGreaterThan(1.4);
    expect(f['scorch']).toBeGreaterThan(40);
    expect(full.shake).toBeGreaterThan(0);

    const garnish = new EffectsLayer();
    garnish.explode(1, cellToWorld(10, 10, 0), 1, wind, { maxSize: 1, maxLife: 0.3, smoke: 0, scorch: false });
    const g = busy(garnish);
    // A short hot core in the garnish pool only: no second fireball cloud, no smoke, ring, scorch or shake.
    expect(g['garnishFire']).toBeCloseTo(1.1, 5);
    expect(g['fireballs']).toBe(-Infinity);
    expect(g['smoke']).toBe(-Infinity);
    expect(g['shock']).toBe(-Infinity);
    expect(g['scorch']).toBe(-Infinity);
    expect(g['sparks']).toBeLessThanOrEqual(1.3);
    expect(garnish.shake).toBe(0);
  });
});

describe('indexBuildingAnims', () => {
  it('groups building anims by cell and by attachment, keeping the list order, and skips other anims', () => {
    const at = (type: string, uid: number, cx: number, cy: number, extra: Partial<LiveAnim> = {}): LiveAnim =>
      anim(type, uid, { x: cx * 256 + 100, y: cy * 256 + 40, buildingAnim: true, ...extra });
    const list = [
      at('NAREFNL1', 1, 10, 12),
      anim('TWLT070', 2),
      at('CAOILD_A', 3, 10, 12),
      at('GAPOWR_A', 4, 11, 12, { attachedTo: { id: 9, uid: 77, kind: 'building' } }),
    ];
    const index = indexBuildingAnims(list)!;
    expect(index.cells.get(12 * 4096 + 10)!.map(([i, a]) => [i, a.type])).toEqual([
      [0, 'NAREFNL1'],
      [2, 'CAOILD_A'],
    ]);
    expect(index.attached.get(77)!.map(([i]) => i)).toEqual([3]);
    expect(indexBuildingAnims([anim('TWLT070', 2)])).toBeNull();
  });
});
