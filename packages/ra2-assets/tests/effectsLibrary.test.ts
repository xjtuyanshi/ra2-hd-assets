/** Effect art sidecar: collection from a synthetic install, theater variants, classification and the table source. */
import { describe, expect, it } from 'vitest';
import { Palette, ShpFile, parseIni, type IniFile } from 'ra2-formats';
import { animFrameAt, animRateFrames, effectSprite } from '../src/effects.ts';
import type { InstallView } from '../src/node/artSource.ts';
import {
  animGraph,
  classifyAnim,
  collectEffects,
  effectRulesTable,
  ENGINE_ANIM_ART,
  HD_AS_PAINTED,
  renderEffectTable,
  shpStats,
} from '../src/node/effectsLibrary.ts';

/** A raw (uncompressed) SHP(TS) with solid-colour frames. */
function makeShp(canvas: [number, number], frames: { x: number; y: number; w: number; h: number; fill: number }[]) {
  const head = 8 + 24 * frames.length;
  const out = new Uint8Array(head + frames.reduce((n, f) => n + f.w * f.h, 0));
  const dv = new DataView(out.buffer);
  dv.setUint16(2, canvas[0], true);
  dv.setUint16(4, canvas[1], true);
  dv.setUint16(6, frames.length, true);
  let off = head;
  frames.forEach((f, i) => {
    const p = 8 + 24 * i;
    dv.setInt16(p, f.x, true);
    dv.setInt16(p + 2, f.y, true);
    dv.setInt16(p + 4, f.w, true);
    dv.setInt16(p + 6, f.h, true);
    dv.setInt32(p + 20, f.w * f.h ? off : 0, true);
    out.fill(f.fill, off, off + f.w * f.h);
    off += f.w * f.h;
  });
  return out;
}

/** `n` frames growing from 4 pixels wide (up to 28), filled with palette index `fill`. */
const frames = (n: number, fill: number) =>
  makeShp(
    [64, 64],
    Array.from({ length: n }, (_, i) => {
      const k = Math.min(i, 12);
      return { x: 30 - k, y: 30 - k, w: 4 + 2 * k, h: 4 + 2 * k, fill };
    }),
  );

/** Palettes: index 10 bright orange (fire), 20 mid grey (smoke), 30 blue; unit palette index 16.. red remap. */
function palette(kind: string): Palette {
  const rgb = new Uint8Array(768);
  for (let i = 0; i < 256; i++) rgb.set([i >> 2, i >> 2, i >> 2], i * 3);
  rgb.set([63, 44, 10], 10 * 3);
  rgb.set([30, 30, 30], 20 * 3);
  rgb.set([10, 20, 63], 30 * 3);
  if (kind.startsWith('unit')) for (let i = 0; i < 16; i++) rgb.set([63 - i * 3, 0, 0], (16 + i) * 3);
  return Palette.parse(rgb);
}

function fakeInstall(files: Record<string, Uint8Array>, inis: Record<string, string>): InstallView {
  const parsed = new Map<string, IniFile>(Object.entries(inis).map(([k, v]) => [k.toLowerCase(), parseIni(v)]));
  return {
    has: (n: string) => n.toLowerCase() in files || n.toLowerCase().endsWith('.pal'),
    ini: (n: string) => {
      const ini = parsed.get(n.toLowerCase());
      if (!ini) throw new Error(`${n} missing`);
      return ini;
    },
    shp: (n: string) => (files[n.toLowerCase()] ? ShpFile.parse(files[n.toLowerCase()]!) : undefined),
    palette: (n: string) => palette(n.toLowerCase()),
    vxl: () => undefined,
    hva: () => undefined,
  } as unknown as InstallView;
}

const RULES = `
[Animations]
0=BOOM
1=FLASH
2=PUFF
3=BURN
4=CORPSE
5=GTPOWR_A
[BuildingTypes]
0=GTPOWR
1=PROC
[VehicleTypes]
0=DRON
[Warheads]
0=HE
[Weapons]
[Particles]
0=SmokeP
[OverlayTypes]
0=GEM01
[SmudgeTypes]
0=CR1
[General]
DeadBodies=CORPSE
[HE]
Verses=100%
AnimList=BOOM
[Gun]
Projectile=Shell
Warhead=HE
Anim=FLASH
[Shell]
Image=SHELL
[GTPOWR]
[PROC]
Refinery=yes
[DRON]
WalkRate=2
[SmokeP]
Image=PUFF
[GEM01]
Tiberium=yes
[CR1]
`;

const ART = `
[BOOM]
Normalized=yes
Translucent=yes
Scorch=yes
Next=PUFF
[FLASH]
[PUFF]
Translucent=yes
Translucency=50
[BURN]
Rate=450
LoopCount=-1
[CORPSE]
Rate=10
Flat=yes
AltPalette=yes
Layer=ground
[GTPOWR]
ActiveAnim=GTPOWR_A
[GTPOWR_A]
Rate=220
Normalized=yes
LoopEnd=4
LoopCount=-1
[SHELL]
Rotates=yes
[DRON]
Voxel=no
WalkFrames=6
[GEM01]
Theater=yes
`;

const FILES = {
  'boom.shp': frames(12, 10),
  'flash.shp': frames(3, 10),
  'puff.shp': frames(8, 20),
  'burn.shp': frames(10, 10),
  'corpse.shp': frames(4, 20),
  // GTPOWR_A resolves per theater (gtpowr_a on temperate, gapowr_a on snow via the prefix rule).
  'gtpowr_a.shp': frames(8, 30),
  'gapowr_a.shp': frames(8, 20),
  'shell.shp': frames(32, 10),
  'gem01.tem': frames(12, 40),
  'gem01.sno': frames(12, 41),
  'cr1.tem': frames(2, 50),
  'cr1.sno': frames(2, 51),
};

describe('effect sidecar collection', () => {
  const INIS = { 'rulesmd.ini': RULES, 'artmd.ini': ART };
  const inst = fakeInstall(FILES, INIS);
  const collected = collectEffects([
    { theater: 'temperate', inst },
    { theater: 'snow', inst },
  ]);
  const lib = collected.library;

  it('records every anim with its engine timing and draw flags', () => {
    expect(Object.keys(lib.anims).sort()).toEqual(['BOOM', 'BURN', 'CORPSE', 'FLASH', 'GTPOWR_A', 'PUFF']);
    expect(lib.anims['BOOM']).toMatchObject({
      sprite: 'anim:BOOM',
      palette: 'anim',
      frameCount: 12,
      loopCount: 1,
      normalized: true,
      rateFrames: 2,
      translucent: true,
      scorch: true,
      next: 'PUFF',
      layer: 'air',
    });
    expect(lib.anims['PUFF']).toMatchObject({ translucency: 50, rateFrames: 1 });
    expect(lib.anims['BURN']).toMatchObject({ loopCount: -1, rateFrames: 2 });
    expect(lib.anims['CORPSE']).toMatchObject({ palette: 'unit', flat: true, layer: 'ground', rateFrames: 90 });
    expect(lib.anims['BOOM']!.visW).toBeGreaterThan(20);
  });

  it('collects art the executable loads by file name, without a garnish row', () => {
    const withEngineArt = collectEffects([
      { theater: 'temperate', inst: fakeInstall({ ...FILES, 'oregath.shp': frames(120, 10) }, INIS) },
    ]);
    expect(ENGINE_ANIM_ART).toContain('OREGATH');
    expect(withEngineArt.library.anims['OREGATH']).toMatchObject({
      sprite: 'anim:OREGATH',
      palette: 'anim',
      start: 0,
      frameCount: 120,
      rateFrames: 1,
    });
    expect(withEngineArt.sprites.get('anim:OREGATH')?.frames).toHaveLength(120);
    expect(withEngineArt.table['OREGATH']).toBeUndefined();
    expect(withEngineArt.counts['anims:engine']).toBe(1);
    // An install without the file simply has no entry.
    expect(lib.anims['OREGATH']).toBeUndefined();
  });

  it('keeps theater variants apart when the art resolves to different files', () => {
    const ref = lib.anims['GTPOWR_A']!.sprite;
    expect(typeof ref).toBe('object');
    expect(effectSprite(ref, 'temperate')).toBe('anim:GTPOWR_A@temperate');
    expect(effectSprite(ref, 'snow')).toBe('anim:GTPOWR_A@snow');
    expect(effectSprite(lib.anims['BOOM']!.sprite, 'snow')).toBe('anim:BOOM');
    expect(collected.sprites.has('anim:GTPOWR_A@snow')).toBe(true);
    // Overlays and smudges are theater art.
    expect(effectSprite(lib.overlays['GEM01']!.sprite, 'snow')).toBe('overlay:GEM01@snow');
    expect(lib.overlays['GEM01']).toMatchObject({ palette: 'theater', flat: true });
    expect(lib.smudges['CR1']).toMatchObject({ palette: 'iso', flat: true });
  });

  it('records projectiles, particles, SHP unit rates and ore storage buildings', () => {
    expect(lib.bullets['SHELL']).toMatchObject({ sprite: 'bullet:SHELL', frames: 32, palette: 'anim' });
    expect(lib.particles['SmokeP']).toMatchObject({ sprite: 'anim:PUFF' });
    expect(lib.shpUnits).toEqual({ DRON: { walkRate: 2 } });
    expect(lib.storageBuildings).toEqual(['PROC']);
    expect([...collected.paletteFiles.keys()].sort()).toEqual([
      'anim',
      'iso.snow',
      'iso.temperate',
      'theater.snow',
      'theater.temperate',
      'unit.snow',
      'unit.temperate',
    ]);
  });

  it('classifies anims from the keys that create them', () => {
    const t = collected.table;
    expect(t['BOOM']).toMatchObject({ c: 'explosion', fx: 'explosion', scorch: 1, life: 24 });
    expect(t['BOOM']!.light).toHaveLength(4);
    expect(t['FLASH']).toMatchObject({ c: 'muzzle', fx: 'muzzle' });
    expect(t['CORPSE']).toMatchObject({ c: 'corpse', fx: 'none' });
    expect(t['BURN']).toMatchObject({ c: 'fire', fx: 'fire', loop: 1 });
    expect(t['GTPOWR_A']).toMatchObject({ c: 'ignore', fx: 'none' });
  });

  it('writes the table as TypeScript with ids and numbers only', () => {
    const source = renderEffectTable(collected.table);
    expect(source).toContain('export const EFFECT_TABLE');
    expect(source).toMatch(/ {2}BOOM: \{ c: 'explosion', fx: 'explosion', s: [\d.]+, life: 24, scorch: 1/);
    expect(source).not.toMatch(/#[0-9a-f]{6}/i);
  });
});

describe('reference graph', () => {
  it('follows Next chains from combat roots', () => {
    const rules = parseIni(RULES);
    const art = parseIni(ART);
    const g = animGraph(rules, art);
    expect(g.combat.has('BOOM')).toBe(true);
    expect(g.combat.has('PUFF')).toBe(true);
    expect(g.refs.get('PUFF')!.some((r) => r.ctx === 'anim.Next' && r.from === 'BOOM')).toBe(true);
    expect(g.projectiles.has('SHELL')).toBe(true);
  });
});

describe('classifyAnim', () => {
  const base = {
    sprite: 'anim:X',
    palette: 'anim' as const,
    start: 0,
    frameCount: 10,
    loopStart: 0,
    loopEnd: 10,
    loopCount: 1,
    rate: 900,
    normalized: false,
    rateFrames: 1,
    layer: 'air' as const,
    hotW: 0,
    visW: 0,
  };
  const flags = { scorch: false, crater: false, bouncer: false, flamingGuy: false, altPalette: false };
  const stats = (fire: number, grey: number, hotW: number, visW: number) => ({
    hotW,
    visW,
    pixelShare: { fire, grey, blue: 0, purple: 0, green: 0, white: 0, dark: 0, other: 1 - fire - grey },
  });

  it('treats small grey warhead hits as dust and small warm ones as spark flashes', () => {
    const refs = [{ ctx: 'warhead.AnimList', from: 'SA' }];
    expect(classifyAnim({ id: 'DUST', refs, combat: true, art: base, stats: stats(0.12, 0.8, 10, 14), flags }).fx).toBe(
      'impact',
    );
    expect(classifyAnim({ id: 'P', refs, combat: true, art: base, stats: stats(0.9, 0.05, 19, 18), flags }).fx).toBe(
      'spark',
    );
  });

  it('marks the two sheets finished to the original colours as painted, whatever their category', () => {
    expect([...HD_AS_PAINTED].sort()).toEqual(['CDGAS', 'NUKEANIM']);
    const nuke = classifyAnim({
      id: 'NUKEANIM',
      refs: [{ ctx: 'warhead.AnimList', from: 'NUKE' }],
      combat: true,
      art: base,
      stats: stats(0.6, 0.15, 120, 150),
      flags,
    });
    expect(nuke.asPainted).toBe(1);
    const gas = classifyAnim({ id: 'cdgas', refs: [], combat: false, art: base, stats: stats(0.5, 0, 0, 60), flags });
    expect(gas.asPainted).toBe(1);
    const other = classifyAnim({
      id: 'NUKEBALL',
      refs: [{ ctx: 'warhead.AnimList', from: 'NUKE' }],
      combat: true,
      art: base,
      stats: stats(0.6, 0.15, 120, 150),
      flags,
    });
    expect(other).not.toHaveProperty('asPainted');
    // The flag changes nothing else about the row, and the generated table writes it last.
    expect({ ...nuke, asPainted: undefined }).toEqual({ ...other, asPainted: undefined });
    const source = renderEffectTable({ CDGAS: gas, NUKEBALL: other });
    expect(source).toContain(
      `  CDGAS: { c: '${gas.c}', fx: '${gas.fx}', s: ${gas.s}, life: ${gas.life}, asPainted: 1 },`,
    );
    expect(source).toContain('  asPainted?: 1;');
    expect(source.split('\n').find((line) => line.startsWith('  NUKEBALL:'))).not.toContain('asPainted');
  });

  it('gives trail puffs one smoke puff and keeps super-weapon rows the only shaking ones', () => {
    const trail = classifyAnim({
      id: 'T',
      refs: [{ ctx: 'projectile.Trailer', from: 'M' }],
      combat: true,
      art: base,
      stats: stats(0, 0.9, 0, 11),
      flags,
    });
    expect(trail).toMatchObject({ c: 'smoke', fx: 'smoke' });
    expect(trail.loop).toBeUndefined();
    const sw = classifyAnim({
      id: 'I',
      refs: [{ ctx: 'General.IonBlast', from: 'General' }],
      combat: true,
      art: base,
      stats: stats(0.5, 0.5, 50, 90),
      flags,
    });
    expect(sw).toMatchObject({ c: 'superweapon', shake: 1 });
  });
});

describe('anim timing helpers', () => {
  it('matches the engine stage lengths and loop rule', () => {
    expect(animRateFrames(undefined, false)).toBe(1);
    expect(animRateFrames(undefined, true)).toBe(2);
    expect(animRateFrames(300, false)).toBe(3);
    const loop = { start: 2, frameCount: 8, loopStart: 2, loopEnd: 6, loopCount: -1, rateFrames: 1 };
    expect([0, 3, 4, 5, 8].map((a) => animFrameAt(loop, a))).toEqual([2, 5, 2, 3, 2]);
  });

  it('rests on the first frame between loops of RandomLoopDelay anims (ore twinkles)', () => {
    const twinkle = {
      start: 0,
      frameCount: 6,
      loopStart: 0,
      loopEnd: 6,
      loopCount: -1,
      rateFrames: 2,
      loopDelay: [120, 300] as [number, number],
    };
    const frames = Array.from({ length: 2000 }, (_, age) => animFrameAt(twinkle, age, 12345));
    const resting = frames.filter((f) => f === 0).length / frames.length;
    expect(resting).toBeGreaterThan(0.9);
    expect(new Set(frames)).toEqual(new Set([0, 1, 2, 3, 4, 5]));
    // A fixed delay per instance: the same seed gives the same sequence.
    expect(animFrameAt(twinkle, 777, 12345)).toBe(frames[777]);
  });

  it('measures colour shares and footprint', () => {
    const pal = new Uint8Array(768);
    pal.set([255, 180, 40], 10 * 3);
    const s = shpStats([{ x: 0, y: 0, cx: 20, cy: 10, pixels: new Uint8Array(200).fill(10) }], pal);
    expect(s.pixelShare.fire).toBe(1);
    expect(s.visW).toBe(20);
    expect(s.hotW).toBe(20);
  });
});

describe('rules facts for the live renderer', () => {
  const rules = parseIni(
    [
      '[BuildingTypes]',
      '0=CAOILD',
      '1=GAPOWR',
      '2=CAUSFGL',
      '[ParticleSystems]',
      '0=SmallGreySSys',
      '1=GasCloudSys',
      '[CAOILD]',
      'Capturable=yes',
      '[GAPOWR]',
      'Capturable=true',
      '[CAUSFGL]',
      'Name=Flag',
      '[SmallGreySSys]',
      'HoldsWhat=SmallGreySmoke',
      'SpawnFrames=10',
      'ParticleCap=7',
      'SpawnRadius=5',
      'BehavesLike=Smoke',
      '[GasCloudSys]',
      'HoldsWhat=GasCloud1',
      'BehavesLike=Gas',
      '[SmallGreySmoke]',
      'Velocity=9.0',
      'Deacc=.05',
      'StateAIAdvance=4',
      'EndStateAI=20',
      'Translucency=50',
      '[GasCloud1]',
      'StateAIAdvance=4',
      '[AudioVisual]',
      'ExtraUnitLight=.2',
      'ExtraInfantryLight=.25',
      'ExtraAircraftLight=.2',
    ].join('\n'),
  );
  const art = parseIni(['[GAPOWR]', 'Normalized=yes', '[CAOILD]', 'Normalized=no'].join('\n'));

  it('lists capturable and Normalized buildings, smoke systems with their particle timing, and the object light', () => {
    const t = effectRulesTable(rules, art);
    expect(t.capturable).toEqual(['CAOILD', 'GAPOWR']);
    expect(t.normalizedBuildings).toEqual(['GAPOWR']);
    expect(Object.keys(t.smokeSystems)).toEqual(['SmallGreySSys']);
    expect(t.smokeSystems['SmallGreySSys']).toEqual({
      particle: 'SmallGreySmoke',
      spawnFrames: 10,
      cap: 7,
      radius: 5,
      velocity: 9,
      deacc: 0.05,
      stateAdvance: 4,
      endState: 20,
      translucency: 50,
    });
    expect(t.extraLight).toEqual({ unit: 0.2, infantry: 0.25, aircraft: 0.2 });
    const source = renderEffectTable({}, t);
    expect(source).toContain("export const CAPTURABLE_BUILDINGS: readonly string[] = [\n  'CAOILD',\n  'GAPOWR',\n];");
    expect(source).toContain('export const EXTRA_LIGHT = { unit: 0.2, infantry: 0.25, aircraft: 0.2 };');
    expect(source).toContain("particle: 'SmallGreySmoke',");
  });
});
