/**
 * Effect art sidecar extraction (Node only, `pnpm hd:effects`): the original art of every anim, projectile, debris
 * voxel, particle, overlay and smudge the engine can draw during a match, so an HD renderer following a live game can
 * draw the native effect as its faithful base layer (see ../effects.ts for the contract and layout). Reads only the
 * player's own install; everything written is derived game data for the gitignored
 * gameres/hd-cache/_library/common/effects/ directory, which no other tool writes.
 *
 * It also classifies every anim for the HD garnish (extra light, sparks, smoke) the renderer may add on top of the
 * native card, and can write that classification as a TypeScript table (--table): ids and numbers only, derived from
 * which rules/art keys create the anim (weapon Anim, warhead AnimList, techno Explosion/DebrisAnims, building
 * DestroyAnim, projectile Trailer, [General]/[CombatDamage] keys, Next/ExpireAnim/TrailerAnim/Spawns chains), its art
 * flags and the colour share of its SHP under anim.pal. The classification started as research against live
 * effects-reader runs; the rules it keeps are listed in classifyAnim.
 */
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { IniFile } from 'ra2-formats';
import type { VoxelModel } from '../manifest.ts';
import { resolveArtFile } from '../art.ts';
import {
  EFFECT_LIBRARY_VERSION,
  animRateFrames,
  type EffectAnim,
  type EffectBullet,
  type EffectCellArt,
  type EffectLayer,
  type EffectLibrary,
  type EffectParticle,
  type EffectSpriteRef,
} from '../effects.ts';
import { drawOffsetFor } from '../iso.ts';
import { LIBRARY_ATLAS_MAX } from '../library.ts';
import { THEATERS, type TheaterId } from '../theater.ts';
import {
  ArtSource,
  buildVoxelModel,
  packSprites,
  secBool,
  secInt,
  SpriteCollector,
  type InstallView,
  type PendingSprite,
} from './artSource.ts';
import { GameInstall } from './install.ts';
import { dirBytes } from './library.ts';
import { encodePng } from './png.ts';

export const ALL_EFFECT_THEATERS: readonly TheaterId[] = ['temperate', 'snow', 'urban', 'newurban', 'desert', 'lunar'];

export interface EffectsOptions {
  gameDir: string;
  /** Output directory (the CLI default is <repo>/gameres/hd-cache/_library/common/effects). */
  outDir: string;
  theaters?: readonly TheaterId[];
  log?: (msg: string) => void;
}

export interface EffectsResult {
  dir: string;
  library: EffectLibrary;
  table: Record<string, EffectTableRow>;
  rulesTable: EffectRulesTable;
  bytes: number;
  ms: number;
}

// ------------------------------------------------------------------------------------------------ classification

export type EffectCategory =
  | 'explosion'
  | 'debris'
  | 'muzzle'
  | 'collapse'
  | 'electric'
  | 'special'
  | 'infantry-death'
  | 'corpse'
  | 'smoke'
  | 'fire'
  | 'impact'
  | 'ui'
  | 'water'
  | 'chrono'
  | 'psychic'
  | 'superweapon'
  | 'ignore';

export type EffectGarnish = 'explosion' | 'muzzle' | 'spark' | 'impact' | 'fire' | 'smoke' | 'bolt' | 'none';

/** One row of the generated HD garnish table (hd-renderer live/effectTable.ts). */
export interface EffectTableRow {
  c: EffectCategory;
  fx: EffectGarnish;
  /** Garnish scale (1 = the HD effect's reference footprint, see HD_FOOTPRINT_PX). */
  s: number;
  /** Lifetime of one iteration in logic frames. */
  life: number;
  loop?: 1;
  scorch?: 1;
  /** Smoke share of the original art (0..1), for rows whose garnish may add smoke. */
  smoke?: number;
  /** Light colour (linear RGB) and radius in world units (cells). */
  light?: [number, number, number, number];
  shake?: 1;
}

/**
 * Rules facts the live renderer needs besides the garnish rows (generated into the same table; ids and numbers only).
 */
export interface EffectRulesTable {
  /** rules BuildingTypes with Capturable=yes (the tech buildings among them idle while a civilian house owns them). */
  capturable: string[];
  /** BuildingTypes whose art section says Normalized=yes (their make anim is stretched like Normalized anims). */
  normalizedBuildings: string[];
  /** Smoke ParticleSystemTypes (BehavesLike=Smoke) with their held particle's timing, keyed by system id. */
  smokeSystems: Record<string, SmokeSystemRow>;
  /** rules [AudioVisual] ExtraUnitLight / ExtraInfantryLight / ExtraAircraftLight. */
  extraLight: { unit: number; infantry: number; aircraft: number };
}

/** A smoke particle system: rules [<system>] and [<HoldsWhat>] values (engine defaults where a key is absent). */
export interface SmokeSystemRow {
  /** HoldsWhat: the ParticleType id (its art is EffectLibrary.particles[particle]). */
  particle: string;
  /** SpawnFrames, ParticleCap, SpawnRadius (leptons). */
  spawnFrames: number;
  cap: number;
  radius: number;
  /** Particle Velocity and Deacc (leptons per logic frame, and per frame squared). */
  velocity: number;
  deacc: number;
  /** Particle StateAIAdvance (logic frames per SHP frame) and EndStateAI (the frame it is removed at). */
  stateAdvance: number;
  endState: number;
  /** Particle Translucency (0, 25, 50, 75). */
  translucency: number;
}

/** Colour share buckets of an SHP's visible pixels under its palette. */
type Bucket = 'fire' | 'grey' | 'blue' | 'purple' | 'green' | 'white' | 'dark' | 'other';

export interface ShpStats {
  /** Widest 2..98 % extent of visible (non-soot) and of hot (bright fire/white) pixels over all frames. */
  visW: number;
  hotW: number;
  pixelShare: Record<Bucket, number>;
}

/** Engine pixels per HD world unit along a camera-facing card (hd-renderer world.ts PIXELS_PER_CELL_EDGE). */
const PX_PER_UNIT = 60 / Math.SQRT2;

/**
 * Width in engine pixels each HD garnish covers at scale 1, measured in the sandbox at zoom 1 with a frozen effects
 * clock (explosionHot = bright fireball core, explosionVis = everything incl. smoke, others = visible extent). The
 * table scale makes the garnish footprint match the original art: the renderer then caps it at the native width.
 */
const HD_FOOTPRINT_PX = { explosionHot: 50, explosionVis: 110, muzzle: 33, impact: 14, fire: 26, smoke: 40 };

function hsv(r: number, g: number, b: number): { h: number; s: number; v: number } {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d > 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s: max === 0 ? 0 : d / max, v: max / 255 };
}

function bucket(r: number, g: number, b: number): Bucket {
  const { h, s, v } = hsv(r, g, b);
  // Very dark entries (anim.pal's soot specks included) read as soot.
  if (v < 0.25) return 'dark';
  if (s < 0.2) return v > 0.85 ? 'white' : 'grey';
  // Warm but dark (burnt brown) is smoke, not flame.
  if (h < 65 || h >= 345) return v >= 0.35 ? 'fire' : 'dark';
  if (h < 170) return 'green';
  if (h < 265) return 'blue';
  if (h < 345) return 'purple';
  return 'other';
}

/** Colour shares and footprint widths of `frames` (body frames of one iteration) under `palette` (768 RGB bytes). */
export function shpStats(
  frames: readonly { x: number; y: number; cx: number; cy: number; pixels: Uint8Array }[],
  palette: ArrayLike<number>,
): ShpStats {
  const share: Record<Bucket, number> = { fire: 0, grey: 0, blue: 0, purple: 0, green: 0, white: 0, dark: 0, other: 0 };
  let total = 0;
  let visW = 0;
  let hotW = 0;
  const span = (a: number[]): number => {
    if (a.length < 6) return 0;
    a.sort((p, q) => p - q);
    return a[Math.floor(a.length * 0.98)]! - a[Math.floor(a.length * 0.02)]! + 1;
  };
  for (const f of frames) {
    if (!f.pixels.length) continue;
    const visX: number[] = [];
    const hotX: number[] = [];
    for (let y = 0; y < f.cy; y++)
      for (let x = 0; x < f.cx; x++) {
        const idx = f.pixels[y * f.cx + x]!;
        if (idx === 0) continue;
        const r = palette[idx * 3]!;
        const g = palette[idx * 3 + 1]!;
        const b = palette[idx * 3 + 2]!;
        const k = bucket(r, g, b);
        share[k]++;
        total++;
        if (k !== 'dark') visX.push(f.x + x);
        if ((k === 'fire' || k === 'white') && (r + g + b) / 3 >= 150) hotX.push(f.x + x);
      }
    visW = Math.max(visW, span(visX));
    hotW = Math.max(hotW, span(hotX));
  }
  const pixelShare = Object.fromEntries(
    Object.entries(share).map(([k, v]) => [k, total ? Math.round((v / total) * 1000) / 1000 : 0]),
  ) as Record<Bucket, number>;
  return { visW, hotW, pixelShare };
}

/** How rules/art create an anim: `<context>` from `<section>` (e.g. "warhead.AnimList" from "HE"). */
export interface AnimRef {
  ctx: string;
  from: string;
}

/** Everything classifyAnim reads about one anim. */
export interface AnimFacts {
  id: string;
  refs: readonly AnimRef[];
  /** Reachable from a combat or destruction key (directly or through Next/ExpireAnim/TrailerAnim/Spawns chains). */
  combat: boolean;
  art: EffectAnim;
  stats: ShpStats | null;
  /** Raw art flags the rules below read. */
  flags: { scorch: boolean; crater: boolean; bouncer: boolean; flamingGuy: boolean; altPalette: boolean };
}

const round2 = (v: number): number => Math.round(v * 100) / 100;
const WARM_LIGHT: [number, number, number] = [1, 0.62, 0.28];
const MUZZLE_LIGHT: [number, number, number] = [1, 0.85, 0.6];
const FIRE_LIGHT: [number, number, number] = [1, 0.55, 0.22];
const ELECTRIC_LIGHT: [number, number, number] = [0.43, 0.63, 1];
const PSYCHIC_LIGHT: [number, number, number] = [0.75, 0.35, 1];

/**
 * Classify one anim for the HD garnish. Data first (reference context, art flags, SHP colour shares and size), names
 * only as a last hint; the resulting categories were checked against effects-reader runs of real skirmishes. Known
 * corrections this keeps relative to the older name-regex mapping: PIFFPIFF is a small spark flash, not dust; SMOKEY2
 * is one small trail puff; TWLT sizes follow their art (026/036/070 -> 0.26/0.36/0.93); muzzle anims whose names do not
 * say so (VTMUZZLE) and trail puffs (NUKEPUFF) are found through the weapon/trailer keys that create them.
 */
export function classifyAnim(f: AnimFacts): EffectTableRow {
  const { id, refs, stats, art, flags } = f;
  const life = Math.max(1, art.frameCount * art.rateFrames);
  const loop = art.loopCount < 0;
  const base = (c: EffectCategory, fx: EffectGarnish, extra: Partial<EffectTableRow> = {}): EffectTableRow => ({
    c,
    fx,
    s: 0,
    life,
    ...(loop ? { loop: 1 as const } : {}),
    ...extra,
  });
  const g = (re: RegExp): boolean => refs.some((r) => re.test(r.ctx));
  const count = (re: RegExp): number => refs.filter((r) => re.test(r.ctx)).length;
  if (!stats) return base('ignore', 'none');
  const px = stats.pixelShare;
  const visW = stats.visW;
  const hotW = stats.hotW;
  const scaleFor = (kind: keyof typeof HD_FOOTPRINT_PX | 'explosion', min = 0.1, max = 5): number => {
    const raw =
      kind === 'explosion'
        ? 0.5 * (hotW / HD_FOOTPRINT_PX.explosionHot + visW / HD_FOOTPRINT_PX.explosionVis)
        : visW / HD_FOOTPRINT_PX[kind];
    return round2(Math.min(max, Math.max(min, raw)));
  };
  /** Light radius in world units: within 1.2 x the art's half width, so HD light never spreads past the original. */
  const radius = (w: number): number => round2(Math.max(0.2, (1.2 * w) / 2 / PX_PER_UNIT));
  const light = (rgb: [number, number, number], w: number): [number, number, number, number] => [...rgb, radius(w)];
  const scorch = flags.scorch || flags.crater ? { scorch: 1 as const } : {};

  const onlyLayer = refs.length > 0 && refs.every((r) => r.ctx === 'building.layer');
  if (onlyLayer) return base('ignore', 'none');
  if (refs.length > 0 && refs.every((r) => r.ctx === 'particle.Image')) return base('ignore', 'none');

  // Engine anims with a fixed role.
  if (
    g(/\.(OreTwinkle|Behind|MoveFlash|DropZoneAnim|ChronoPlacement|ChronoBeam|IonBeam|WeatherConClouds)$/i) ||
    /^(TWNK|BEHIND|MOVEFLSH)/.test(id) ||
    id === 'RING' ||
    id === 'D'
  )
    return base('ui', 'none');
  if (g(/\.(Parachute|BombParachute|DropPod|Wake)$/i) || /^(PARACH|BOMBCHUT)/.test(id)) return base('ui', 'none');
  if (g(/\.DeadBodies$/i) || /^DEATH_/.test(id)) return base('corpse', 'none');
  if (g(/\.InfantryExplode$/i))
    return base('explosion', 'explosion', {
      s: scaleFor('explosion'),
      ...scorch,
      light: light(WARM_LIGHT, hotW),
      smoke: round2(px.grey + px.dark),
    });
  if (g(/\.FlamingInfantry$/i) || flags.flamingGuy)
    return base('infantry-death', 'fire', { s: scaleFor('fire'), loop: 1, light: light(FIRE_LIGHT, hotW) });
  if (g(/\.(InfantryHeadPop|InfantryNuked|InfantryVirus|InfantryBrute|InfantryMutate)$/i))
    return base('infantry-death', 'none');
  if (g(/\.SplashList$/i) || /^H2O_EXP/.test(id)) return base('water', 'none');
  if (/^BBBLE/.test(id)) return base('water', 'none');
  if (g(/\.(ChronoBlast|ChronoBlastDest|WarpIn|WarpOut|WarpAway|ChronoSparkle1)$/i) || /^(CHRONO|WARP)/.test(id))
    return base('chrono', 'none');
  if (
    g(
      /\.(IronCurtainInvokeAnim|ForceShieldInvokeAnim|WeaponNullifyAnim|DominatorFirstAnim|DominatorSecondAnim|NukeTakeOff|IonBlast)$/i,
    )
  )
    return base('superweapon', 'none', { shake: 1 });
  if (g(/\.(ControlledAnimationType|PermaControlledAnimationType)$/i) || /^YURICNTL/.test(id))
    return base('psychic', 'none');
  if (g(/\.DrainAnimationType$/i)) return base('electric', 'none');
  if (g(/\.WeatherConBolts$/i)) return base('superweapon', 'none', { light: light(ELECTRIC_LIGHT, visW), shake: 1 });
  if (g(/\.EMPulseSparkles$/i)) return base('electric', 'none', { light: light(ELECTRIC_LIGHT, visW) });
  if (g(/(CrateRules|Powerups)\./i)) return base('ui', 'none');

  // Hits of electric-bolt weapons (ELECTRO for the Tesla weapons): white-blue sparks in the original, never fire.
  // ELECTRO itself is created by the engine (no rules key names it) where a Tesla bolt hits; a name hint covers it.
  const creators = refs.filter((r) => !r.ctx.startsWith('anim.'));
  if (
    (creators.length > 0 && creators.every((r) => r.ctx === 'warhead.AnimList.electric')) ||
    (creators.length === 0 && /ELECTR|TESLA/.test(id))
  )
    return base('electric', 'none', { light: light(ELECTRIC_LIGHT, visW) });

  // Debris and destruction.
  if (g(/(DebrisAnims|DebrisAnim|MetallicDebris|terrain\.Debris)$/) || flags.bouncer) return base('debris', 'none');
  if (g(/^building\.DestroyAnim$/))
    return base('collapse', 'explosion', {
      s: scaleFor('explosion'),
      light: light(WARM_LIGHT, hotW),
      smoke: round2(px.grey + px.dark),
    });

  // Colour-led categories.
  const electric = px.blue + px.white * 0.5;
  const purple = px.purple;
  const green = px.green;
  const fire = px.fire + px.white * 0.5;
  const grey = px.grey + px.dark;
  const warheadRefs = count(/^warhead\.AnimList$/);
  const muzzleRefs = count(/^weapon\.(Anim|OccupantAnim|AssaultAnim|OpenToppedAnim)$/);
  const muzzleCtx = muzzleRefs > 0 && muzzleRefs >= warheadRefs;
  const trailCtx = g(/^(projectile\.Trailer|anim\.TrailerAnim)$/);
  const fireArt = g(/\.DamageFireTypes$/) || /^(FIRE|FLAME|BURN|FLMSPT|NAPALM|INITFIRE)/.test(id);
  const gas = /GAS/.test(id);

  if (muzzleCtx && g(/^weapon\.Anim$/) && !g(/^deathweapon/) && visW > 64 && !flags.scorch && !flags.crater)
    return base('special', 'none');
  if (/^(UCINIT|PSI|PDFX|YURI)/.test(id) || (purple > 0.3 && purple > fire))
    return base('psychic', 'none', { light: light(PSYCHIC_LIGHT, visW) });
  // CDGAS (chaos drone gas) is a flat red ring in the original art; it stays exactly as drawn.
  if (id === 'CDGAS') return base('psychic', 'none');
  if (g(/\.WeatherConBoltExplosion$/i) || (electric > 0.15 && fire < 0.2 && hotW > 0))
    return base('electric', 'none', { light: light(ELECTRIC_LIGHT, visW) });
  if (electric > 0.35 && electric > fire) return base('electric', 'none', { light: light(ELECTRIC_LIGHT, visW) });
  if (gas) return base('special', 'none');
  if (green > 0.3 && green > fire) return base('special', 'none');
  if (trailCtx && grey >= fire) return base('smoke', 'smoke', { s: scaleFor('smoke'), smoke: 1 });
  if (fireArt && (loop || art.loopCount > 1))
    return base('fire', 'fire', { s: scaleFor('fire'), loop: 1, light: light(FIRE_LIGHT, hotW) });
  if (fireArt) return base('fire', 'fire', { s: scaleFor('fire'), light: light(FIRE_LIGHT, hotW) });
  if (muzzleCtx && visW <= 64 && !flags.scorch && !flags.crater)
    return base('muzzle', 'muzzle', { s: scaleFor('muzzle', 0.1, 2.5), light: light(MUZZLE_LIGHT, visW) });
  const explosionCtx =
    g(/^(warhead\.AnimList|techno\.Explosion|deathweapon\.Anim|voxelanim\.ExpireAnim|anim\.ExpireAnim|anim\.Next)$/) ||
    g(/\.(BridgeExplosions|BarrelExplode|WeatherConBoltExplosion)$/i);
  if ((explosionCtx || flags.scorch || flags.crater) && (fire >= 0.1 || (fire >= 0.04 && hotW >= 20))) {
    if (hotW < 26 && !flags.scorch && !flags.crater)
      return grey > 0.5
        ? base('impact', 'impact', { s: scaleFor('impact') })
        : base('impact', 'spark', { s: scaleFor('muzzle') });
    return base('explosion', 'explosion', {
      s: scaleFor('explosion'),
      ...scorch,
      light: light(WARM_LIGHT, hotW),
      smoke: round2(grey),
    });
  }
  if (grey > 0.5) return base('smoke', 'smoke', { s: scaleFor('smoke'), smoke: round2(grey) });
  if (fire >= 0.2) return base('impact', 'spark', { s: scaleFor('muzzle') });
  if (!f.combat) return base('ignore', 'none');
  return base('impact', 'impact', { s: scaleFor('impact') });
}

/** Numeric rules value (INI numbers may be written ".05" or "9.0"), or the fallback. */
function rulesNumber(rules: IniFile, id: string, key: string, fallback: number): number {
  const sec = rules.getSection(id);
  const v = sec?.has(key) ? Number.parseFloat(sec.getString(key, '')) : Number.NaN;
  return Number.isFinite(v) ? v : fallback;
}

/** The rules facts of EffectRulesTable. */
export function effectRulesTable(rules: IniFile, art: IniFile): EffectRulesTable {
  const registry = (name: string) =>
    rules
      .readRegistry(name)
      .map((v) => v.trim())
      .filter(Boolean);
  const yes = (id: string, key: string) => /^(y|t|1)/i.test(rules.getSection(id)?.getString(key, '').trim() ?? '');
  const smokeSystems: Record<string, SmokeSystemRow> = {};
  for (const id of registry('ParticleSystems').sort()) {
    const sec = rules.getSection(id);
    const particle = sec?.getString('HoldsWhat', '').trim();
    if (!sec || !particle || !/^smoke$/i.test(sec.getString('BehavesLike', '').trim())) continue;
    if (!rules.getSection(particle)) continue;
    smokeSystems[id] = {
      particle,
      spawnFrames: rulesNumber(rules, id, 'SpawnFrames', 1),
      cap: rulesNumber(rules, id, 'ParticleCap', 100),
      radius: rulesNumber(rules, id, 'SpawnRadius', 0),
      velocity: rulesNumber(rules, particle, 'Velocity', 0),
      deacc: rulesNumber(rules, particle, 'Deacc', 0),
      stateAdvance: rulesNumber(rules, particle, 'StateAIAdvance', 1),
      endState: rulesNumber(rules, particle, 'EndStateAI', 0),
      translucency: rulesNumber(rules, particle, 'Translucency', 0),
    };
  }
  return {
    capturable: [...new Set(registry('BuildingTypes').filter((id) => yes(id, 'Capturable')))].sort(),
    normalizedBuildings: [
      ...new Set(
        registry('BuildingTypes').filter((id) => {
          const image = rules.getSection(id)?.getString('Image', '').trim() || id;
          const sec = art.getSection(image) ?? art.getSection(id);
          return /^(y|t|1)/i.test(sec?.getString('Normalized', '').trim() ?? '');
        }),
      ),
    ].sort(),
    smokeSystems,
    extraLight: {
      unit: rulesNumber(rules, 'AudioVisual', 'ExtraUnitLight', 0),
      infantry: rulesNumber(rules, 'AudioVisual', 'ExtraInfantryLight', 0),
      aircraft: rulesNumber(rules, 'AudioVisual', 'ExtraAircraftLight', 0),
    },
  };
}

/** TypeScript source of the rules facts that follow the garnish table. */
function renderRulesTable(t: EffectRulesTable): string[] {
  // One id per line, as the repository's Prettier style prints a list that does not fit on one line.
  const list = (ids: string[]) => ids.map((id) => `  '${id}',`);
  const smoke = Object.keys(t.smokeSystems).map((id) => {
    const r = t.smokeSystems[id]!;
    const parts = Object.entries(r).map(([k, v]) => `${k}: ${typeof v === 'string' ? `'${v}'` : v}`);
    return [`  ${id}: {`, ...parts.map((p) => `    ${p},`), '  },'].join('\n');
  });
  return [
    '',
    '/** rules BuildingTypes with Capturable=yes. */',
    'export const CAPTURABLE_BUILDINGS: readonly string[] = [',
    ...list(t.capturable),
    '];',
    '',
    '/** BuildingTypes whose art says Normalized=yes. */',
    'export const NORMALIZED_BUILDINGS: readonly string[] = [',
    ...list(t.normalizedBuildings),
    '];',
    '',
    '/** A smoke particle system (rules [<system>] / [<HoldsWhat>]): see SmokeSystemRow in effectsLibrary.ts. */',
    'export interface SmokeSystemRow {',
    '  particle: string;',
    '  spawnFrames: number;',
    '  cap: number;',
    '  radius: number;',
    '  velocity: number;',
    '  deacc: number;',
    '  stateAdvance: number;',
    '  endState: number;',
    '  translucency: number;',
    '}',
    '',
    'export const SMOKE_SYSTEMS: Record<string, SmokeSystemRow> = {',
    ...smoke,
    '};',
    '',
    '/** rules [AudioVisual] ExtraUnitLight / ExtraInfantryLight / ExtraAircraftLight. */',
    `export const EXTRA_LIGHT = { unit: ${t.extraLight.unit}, infantry: ${t.extraLight.infantry}, aircraft: ${t.extraLight.aircraft} };`,
    '',
  ];
}

/** TypeScript source of the garnish table (ids and numbers only), followed by the rules facts when given. */
export function renderEffectTable(rows: Record<string, EffectTableRow>, rules?: EffectRulesTable): string {
  const ids = Object.keys(rows).sort();
  const lines = ids.map((id) => {
    const r = rows[id]!;
    const parts = [`c: '${r.c}'`, `fx: '${r.fx}'`, `s: ${r.s}`, `life: ${r.life}`];
    if (r.loop) parts.push('loop: 1');
    if (r.scorch) parts.push('scorch: 1');
    if (r.smoke !== undefined) parts.push(`smoke: ${r.smoke}`);
    if (r.light) parts.push(`light: [${r.light.join(', ')}]`);
    if (r.shake) parts.push('shake: 1');
    const key = /^[A-Za-z_$][\w$]*$/.test(id) ? id : `'${id}'`;
    const line = `  ${key}: { ${parts.join(', ')} },`;
    // The repository's Prettier style (print width 120): long rows break one property per line.
    return line.length <= 120 ? line : [`  ${key}: {`, ...parts.map((p) => `    ${p},`), '  },'].join('\n');
  });
  return [
    "// Generated by `pnpm hd:effects --table packages/hd-renderer/src/live/effectTable.ts` from the player's own",
    '// rulesmd.ini / artmd.ini (YR 1.001) and anim SHP colour shares (packages/ra2-assets/src/node/effectsLibrary.ts',
    '// classifyAnim). Ids and numbers only: no art, pixels or palettes. Regenerate instead of editing by hand.',
    '',
    'export type EffectCategory =',
    ...(
      [
        'explosion',
        'debris',
        'muzzle',
        'collapse',
        'electric',
        'special',
        'infantry-death',
        'corpse',
        'smoke',
        'fire',
        'impact',
        'ui',
        'water',
        'chrono',
        'psychic',
        'superweapon',
        'ignore',
      ] as const
    ).map((c, i, a) => `  | '${c}'${i === a.length - 1 ? ';' : ''}`),
    '',
    "export type EffectGarnish = 'explosion' | 'muzzle' | 'spark' | 'impact' | 'fire' | 'smoke' | 'bolt' | 'none';",
    '',
    'export interface EffectTableRow {',
    '  c: EffectCategory;',
    '  fx: EffectGarnish;',
    '  /** Garnish scale. */',
    '  s: number;',
    '  /** One iteration in logic frames. */',
    '  life: number;',
    '  loop?: 1;',
    '  /** Art Scorch=yes / Crater=yes. */',
    '  scorch?: 1;',
    '  /** Smoke share of the original art (0..1). */',
    '  smoke?: number;',
    '  /** Linear RGB and radius in cells. */',
    '  light?: [number, number, number, number];',
    '  shake?: 1;',
    '}',
    '',
    'export const EFFECT_TABLE: Record<string, EffectTableRow> = {',
    ...lines,
    '};',
    ...(rules ? renderRulesTable(rules) : ['']),
  ].join('\n');
}

// ------------------------------------------------------------------------------------------------ reference graph

const U = (s: string): string => s.trim().toUpperCase();
/** Anim-like tokens of an INI value (comma list; no numbers, no "none", no values with spaces). */
const tokens = (v: string): string[] =>
  v
    .split(';')[0]!
    .split(',')
    .map(U)
    .filter((t) => t && t !== 'NONE' && !/\s/.test(t) && !/^-?\d+(\.\d+)?%?$/.test(t));

/** [General]/[CombatDamage]/[AudioVisual] keys whose values the engine turns into AnimClass instances. */
const GLOBAL_ANIM_KEYS = new Set(
  [
    'DamageFireTypes',
    'MetallicDebris',
    'BridgeExplosions',
    'BarrelExplode',
    'InfantryExplode',
    'FlamingInfantry',
    'InfantryHeadPop',
    'InfantryNuked',
    'InfantryVirus',
    'InfantryBrute',
    'InfantryMutate',
    'DeadBodies',
    'IonBlast',
    'IonBeam',
    'ChronoBlast',
    'ChronoBlastDest',
    'WarpIn',
    'WarpOut',
    'WarpAway',
    'ChronoSparkle1',
    'WeatherConBoltExplosion',
    'WeatherConBolts',
    'WeatherConClouds',
    'EMPulseSparkles',
    'Wake',
    'DropPod',
    'NukeTakeOff',
    'WeaponNullifyAnim',
    'IronCurtainInvokeAnim',
    'ForceShieldInvokeAnim',
    'DominatorFirstAnim',
    'DominatorSecondAnim',
    'ChronoPlacement',
    'ChronoBeam',
    'OreTwinkle',
    'Behind',
    'MoveFlash',
    'Parachute',
    'BombParachute',
    'DropZoneAnim',
    'SplashList',
    'ControlledAnimationType',
    'PermaControlledAnimationType',
    'DrainAnimationType',
  ].map(U),
);
/** Global keys that are not combat (ambient markers, UI, delivery). */
const NONCOMBAT_GLOBAL = new Set(
  [
    'OreTwinkle',
    'Behind',
    'MoveFlash',
    'Parachute',
    'BombParachute',
    'DropZoneAnim',
    'DropPod',
    'Wake',
    'ChronoPlacement',
    'ChronoBeam',
    'IonBeam',
    'WeatherConClouds',
    'DominatorFirstAnim',
    'DominatorSecondAnim',
    'IronCurtainInvokeAnim',
    'ForceShieldInvokeAnim',
    'NukeTakeOff',
    'ControlledAnimationType',
    'PermaControlledAnimationType',
    'WarpIn',
    'WarpOut',
    'WarpAway',
    'ChronoSparkle1',
    'DeadBodies',
  ].map(U),
);
const TECHNO_ANIM_KEYS: Record<string, string> = {
  Explosion: 'techno.Explosion',
  DebrisAnims: 'techno.DebrisAnims',
  DebrisAnim: 'building.DebrisAnim',
  DestroyAnim: 'building.DestroyAnim',
  Debris: 'terrain.Debris',
};
const WEAPON_ANIM_KEYS: Record<string, string> = {
  Anim: 'weapon.Anim',
  OccupantAnim: 'weapon.OccupantAnim',
  AssaultAnim: 'weapon.AssaultAnim',
  OpenToppedAnim: 'weapon.OpenToppedAnim',
};
const BUILDING_LAYER =
  /^(Active|Idle|Special|Production|Super|Deploying|UnderDoor|Roof|UnderRoof|LowPower|SuperLowPower|Bib)/i;
const CHAIN_KEYS = ['Next', 'ExpireAnim', 'TrailerAnim', 'Spawns'];

export interface AnimGraph {
  /** Every anim id: the [Animations] registry plus every referenced id. */
  ids: Set<string>;
  refs: Map<string, AnimRef[]>;
  combat: Set<string>;
  /** Projectile ids (sections a weapon names in Projectile=). */
  projectiles: Set<string>;
}

/** Which rules/art keys create which anims (see the module notes). */
export function animGraph(rules: IniFile, art: IniFile): AnimGraph {
  const registry = new Set(rules.readRegistry('Animations').map(U));
  const reg = (name: string): Set<string> => new Set(rules.readRegistry(name).map(U));
  const buildings = reg('BuildingTypes');
  const vehicles = reg('VehicleTypes');
  const infantry = reg('InfantryTypes');
  const aircraft = reg('AircraftTypes');
  const terrain = reg('TerrainTypes');
  const warheads = reg('Warheads');
  const techno = (s: string): boolean =>
    buildings.has(s) || vehicles.has(s) || infantry.has(s) || aircraft.has(s) || terrain.has(s);
  const weapons = new Set<string>();
  const projectiles = new Set<string>();
  const deathWeapons = new Set<string>();
  /** Warheads of electric-bolt weapons (Tesla coil/trooper/tank): their AnimList hits are electric, not fire. */
  const electricWarheads = new Set<string>();
  for (const s of rules.sectionNames()) {
    const sec = rules.getSection(s)!;
    if (sec.has('Projectile') && sec.has('Warhead')) {
      weapons.add(U(s));
      const p = U(sec.getString('Projectile', ''));
      if (p && p !== 'NONE') projectiles.add(p);
      if (/^(y|t|1)/i.test(sec.getString('IsElectricBolt', '').trim()))
        electricWarheads.add(U(sec.getString('Warhead', '')));
    }
    if (sec.has('Verses')) warheads.add(U(s));
    for (const k of ['DeathWeapon', 'SuicideWeapon']) if (sec.has(k)) deathWeapons.add(U(sec.getString(k, '')));
  }
  const refs = new Map<string, AnimRef[]>();
  const addRef = (anim: string, ctx: string, from: string): void => {
    let list = refs.get(anim);
    if (!list) refs.set(anim, (list = []));
    if (!list.some((r) => r.ctx === ctx && r.from === from)) list.push({ ctx, from });
  };
  for (const s of rules.sectionNames()) {
    const S = U(s);
    if (S === 'ANIMATIONS') continue;
    const sec = rules.getSection(s)!;
    const global = ['GENERAL', 'COMBATDAMAGE', 'AUDIOVISUAL', 'CRATERULES', 'POWERUPS'].includes(S);
    for (const e of sec.entries) {
      const toks = tokens(e.value);
      if (!toks.length) continue;
      if (global) {
        if (GLOBAL_ANIM_KEYS.has(U(e.key)) || S === 'CRATERULES' || S === 'POWERUPS')
          for (const t of toks) if (registry.has(t)) addRef(t, `${s}.${e.key}`, s);
        continue;
      }
      if (weapons.has(S) && WEAPON_ANIM_KEYS[e.key]) {
        const ctx = deathWeapons.has(S) && e.key === 'Anim' ? 'deathweapon.Anim' : WEAPON_ANIM_KEYS[e.key]!;
        for (const t of toks) addRef(t, ctx, s);
      } else if (warheads.has(S) && e.key === 'AnimList')
        for (const t of toks) addRef(t, electricWarheads.has(S) ? 'warhead.AnimList.electric' : 'warhead.AnimList', s);
      else if (TECHNO_ANIM_KEYS[e.key] && techno(S)) for (const t of toks) addRef(t, TECHNO_ANIM_KEYS[e.key]!, s);
      else if (e.key === 'ExpireAnim' && !techno(S) && !registry.has(S))
        for (const t of toks) addRef(t, 'voxelanim.ExpireAnim', s);
      else if (e.key === 'Image' && registry.has(U(e.value)) && !techno(S)) addRef(U(e.value), 'particle.Image', s);
    }
  }
  for (const s of art.sectionNames()) {
    const sec = art.getSection(s)!;
    for (const e of sec.entries) {
      if (e.key === 'Trailer') for (const t of tokens(e.value)) addRef(t, 'projectile.Trailer', s);
      else if (BUILDING_LAYER.test(e.key) && /Anim|Shape|Power/.test(e.key))
        for (const t of tokens(e.value)) if (registry.has(t) || art.hasSection(t)) addRef(t, 'building.layer', s);
    }
  }
  const ids = new Set<string>([...registry, ...refs.keys()]);
  for (const id of [...ids]) {
    const sec = art.getSection(id);
    for (const k of CHAIN_KEYS) {
      const v = sec?.getString(k, '');
      if (!v) continue;
      for (const t of tokens(v)) {
        addRef(t, `anim.${k}`, id);
        if (!ids.has(t)) {
          ids.add(t);
          // Chains of chains (Next of a Next).
          const sub = art.getSection(t);
          for (const k2 of CHAIN_KEYS)
            for (const t2 of tokens(sub?.getString(k2, '') ?? '')) {
              addRef(t2, `anim.${k2}`, t);
              ids.add(t2);
            }
        }
      }
    }
  }
  const isCombatCtx = (ctx: string): boolean => {
    if (ctx.startsWith('anim.') || ctx === 'building.layer' || ctx === 'particle.Image') return false;
    const m = /^(General|CombatDamage|AudioVisual|CrateRules|Powerups)\.(.+)$/i.exec(ctx);
    if (m) return !NONCOMBAT_GLOBAL.has(U(m[2]!)) && !/^(CrateRules|Powerups)$/i.test(m[1]!);
    return true;
  };
  const combat = new Set<string>();
  for (const [id, list] of refs) if (list.some((r) => isCombatCtx(r.ctx))) combat.add(id);
  for (let changed = true; changed;) {
    changed = false;
    for (const [id, list] of refs)
      if (!combat.has(id) && list.some((r) => r.ctx.startsWith('anim.') && combat.has(r.from))) {
        combat.add(id);
        changed = true;
      }
  }
  return { ids, refs, combat, projectiles };
}

// ------------------------------------------------------------------------------------------------ collection

/**
 * SHP art the executable loads by file name instead of through [Animations] or an art key. YR 1.001's unit draw
 * (0x73CEC0) loads OREGATH.SHP once (name at 0x845904, load at 0x73CED6) and blits it under a harvesting miner with the
 * anim palette (0x73D276). Such art has no art section, so it is collected with the anim defaults; it gets no garnish
 * table row because the engine never plays it as an AnimClass.
 */
export const ENGINE_ANIM_ART: readonly string[] = ['OREGATH'];

/** One theater's view of the install. */
interface TheaterView {
  id: TheaterId;
  inst: InstallView;
  src: ArtSource;
  collector: SpriteCollector;
}

export interface CollectedEffects {
  library: Omit<EffectLibrary, 'spriteAtlases' | 'sprites' | 'palettes' | 'paletteSources' | 'extractor'>;
  /** Pending sprites by final sprite id (theater variants already suffixed). */
  sprites: Map<string, PendingSprite>;
  voxelModels: Map<string, VoxelModel>;
  /** Palette key -> [install, file] to write. */
  paletteFiles: Map<string, { inst: InstallView; file: string }>;
  table: Record<string, EffectTableRow>;
  rulesTable: EffectRulesTable;
  counts: Record<string, number>;
  warnings: string[];
}

const LAYERS: readonly EffectLayer[] = ['underground', 'surface', 'ground', 'air', 'top'];

/**
 * Resolve every effect art of the game against one install per theater (the first theater is the primary: its rules
 * and art INIs are used, and theater-independent art is read from it). No I/O besides reading the installs.
 */
export function collectEffects(installs: readonly { theater: TheaterId; inst: InstallView }[]): CollectedEffects {
  if (!installs.length) throw new Error('collectEffects: no install');
  const warnings: string[] = [];
  const warn = (m: string): void => {
    if (!warnings.includes(m)) warnings.push(m);
  };
  const counts: Record<string, number> = {};
  const count = (k: string, n = 1): void => {
    counts[k] = (counts[k] ?? 0) + n;
  };
  const views: TheaterView[] = installs.map(({ theater, inst }) => ({
    id: theater,
    inst,
    src: new ArtSource(inst, THEATERS[theater], warn),
    collector: new SpriteCollector(inst, warn),
  }));
  const primary = views[0]!;
  const { rules, art } = primary.src;
  const sprites = new Map<string, PendingSprite>();
  const paletteFiles = new Map<string, { inst: InstallView; file: string }>();
  paletteFiles.set('anim', { inst: primary.inst, file: 'anim.pal' });
  const themed = (key: 'unit' | 'iso' | 'theater'): void => {
    for (const v of views) {
      const t = THEATERS[v.id];
      const file = key === 'unit' ? t.unitPalette : key === 'iso' ? t.isoPalette : t.theaterPalette;
      paletteFiles.set(`${key}.${v.id}`, { inst: v.inst, file });
    }
  };

  /**
   * Load a SHP for every theater and store it once per distinct file: a plain id when every theater resolves the same
   * file, otherwise `<id>@<theater>` variants (theaters sharing a file share the variant). Undefined when no theater
   * has the art.
   */
  const addArt = (
    id: string,
    candidatesFor: (v: TheaterView) => string[],
    palette: string,
    remap: boolean,
  ): { ref: EffectSpriteRef; sprite: PendingSprite } | undefined => {
    const files = views.map((v) => resolveArtFile(candidatesFor(v), (n) => v.inst.has(n)));
    const found = files.findIndex((f) => f !== undefined);
    if (found < 0) return undefined;
    const distinct = [...new Set(files.filter((f): f is string => !!f))];
    if (distinct.length === 1 && files.every((f) => f === distinct[0])) {
      const v = views[found]!;
      const s = v.collector.addShp(id, [distinct[0]!], palette, remap);
      if (!s) return undefined;
      sprites.set(id, s);
      return { ref: id, sprite: s };
    }
    const ref: Partial<Record<TheaterId, string>> = {};
    let first: PendingSprite | undefined;
    const byFile = new Map<string, string>();
    views.forEach((v, i) => {
      const file = files[i];
      if (!file) return;
      let sid = byFile.get(file);
      if (!sid) {
        sid = `${id}@${v.id}`;
        const s = v.collector.addShp(sid, [file], palette, remap);
        if (!s) return;
        sprites.set(sid, s);
        byFile.set(file, sid);
        first ??= s;
      }
      ref[v.id] = sid;
    });
    return first ? { ref, sprite: first } : undefined;
  };

  // ---------------------------------------------------------------- anims
  const graph = animGraph(rules, art);
  const anims: Record<string, EffectAnim> = {};
  const table: Record<string, EffectTableRow> = {};
  const animPal = primary.inst.palette('anim.pal').rgb;
  const unitPal = primary.inst.palette(THEATERS[primary.id].unitPalette).rgb;
  let usesUnit = false;
  for (const id of [...new Set([...graph.ids, ...ENGINE_ANIM_ART])].sort()) {
    const sec = art.getSection(id);
    const image = sec?.getString('Image', '').trim() || id;
    const altPalette = secBool(sec, 'AltPalette');
    const palette = altPalette ? 'unit' : 'anim';
    const loaded = addArt(`anim:${id}`, (v) => v.src.shpCandidates(image, sec), palette, altPalette);
    if (!loaded) {
      count('anims:noArt');
      continue;
    }
    if (altPalette) usesUnit = true;
    const body = loaded.sprite.frames.length;
    const total = loaded.sprite.entry.frameCount ?? body;
    const shadowArt = secBool(sec, 'Shadow');
    const start = Math.max(0, secInt(sec, 'Start') ?? 0);
    const endKey = secInt(sec, 'End');
    // AnimTypeClass::End: art End= when set, else the SHP's whole frame count, halved only for Shadow=yes (a shadow half
    // without the key still counts, e.g. NAREFNL1: 12 frames of which 6 are shadows; its loop never reaches them).
    const frames = endKey !== undefined && endKey > 0 ? endKey : shadowArt ? Math.floor(total / 2) : total;
    const frameCount = Math.max(1, frames);
    const rate = secInt(sec, 'Rate') ?? 900;
    const normalized = secBool(sec, 'Normalized');
    const layerName = (sec?.getString('Layer', '') ?? '').trim().toLowerCase();
    const layer = (LAYERS as readonly string[]).includes(layerName) ? (layerName as EffectLayer) : 'air';
    const translucency = secInt(sec, 'Translucency') ?? 0;
    const x = secInt(sec, 'XDrawOffset');
    const y = secInt(sec, 'YDrawOffset');
    const next = (sec?.getString('Next', '') ?? '').trim();
    const entry: EffectAnim = {
      sprite: loaded.ref,
      palette,
      start,
      frameCount,
      loopStart: secInt(sec, 'LoopStart') ?? start,
      loopEnd: secInt(sec, 'LoopEnd') ?? start + frameCount,
      loopCount: secInt(sec, 'LoopCount') ?? 1,
      rate,
      normalized,
      rateFrames: animRateFrames(rate, normalized),
      layer,
      hotW: 0,
      visW: 0,
    };
    const delay = (sec?.getString('RandomLoopDelay', '') ?? '').split(',').map((v) => Number.parseInt(v, 10));
    if (delay.length === 2 && delay.every(Number.isFinite)) entry.loopDelay = [Math.min(...delay), Math.max(...delay)];
    if (secBool(sec, 'Reverse')) entry.reverse = true;
    if (secBool(sec, 'Translucent')) entry.translucent = true;
    if ([25, 50, 75].includes(translucency)) entry.translucency = translucency;
    if (secBool(sec, 'Flat')) entry.flat = true;
    if (shadowArt && loaded.sprite.shadows?.length) entry.shadow = true;
    if (x !== undefined || y !== undefined) entry.drawOffset = [x ?? 0, y ?? 0];
    const z = secInt(sec, 'ZAdjust');
    if (z !== undefined) entry.zAdjust = z;
    if (next && U(next) !== 'NONE') entry.next = U(next);
    if (secBool(sec, 'Scorch')) entry.scorch = true;
    if (secBool(sec, 'Crater')) entry.crater = true;
    // Colour shares and footprint over the frames one iteration shows.
    const pending = loaded.sprite.frames.slice(start, start + frameCount).map((fr) => ({
      x: fr.offset[0],
      y: fr.offset[1],
      cx: fr.w,
      cy: fr.h,
      pixels: fr.pixels,
    }));
    const stats = pending.length ? shpStats(pending, altPalette ? unitPal : animPal) : null;
    entry.hotW = stats?.hotW ?? 0;
    entry.visW = stats?.visW ?? 0;
    anims[id] = entry;
    if (!graph.ids.has(id)) {
      count('anims:engine');
      continue;
    }
    table[id] = classifyAnim({
      id,
      refs: graph.refs.get(id) ?? [],
      combat: graph.combat.has(id),
      art: entry,
      stats,
      flags: {
        scorch: !!entry.scorch,
        crater: !!entry.crater,
        bouncer: secBool(sec, 'Bouncer'),
        flamingGuy: secBool(sec, 'IsFlamingGuy'),
        altPalette,
      },
    });
    count('anims');
  }
  if (usesUnit) themed('unit');

  // ---------------------------------------------------------------- projectiles
  const voxelModels = new Map<string, VoxelModel>();
  const bullets: Record<string, EffectBullet> = {};
  for (const id of [...graph.projectiles].sort()) {
    if (primary.src.rulesBool(id, 'Inviso')) continue;
    const { sec, image } = primary.src.artOf(id);
    if (!image || U(image) === 'NONE') continue;
    if (secBool(sec, 'Voxel')) {
      const model = buildVoxelModel(
        id,
        [{ role: 'body', stem: image.toLowerCase(), required: false }],
        0,
        primary.inst,
        warn,
      );
      if (model) {
        voxelModels.set(id, model);
        bullets[id] = { voxel: id, palette: 'unit' };
        count('bullets:voxel');
      }
      continue;
    }
    const loaded = addArt(`bullet:${id}`, (v) => v.src.shpCandidates(image, sec), 'anim', false);
    if (!loaded) continue;
    bullets[id] = {
      sprite: loaded.ref,
      palette: 'anim',
      frames: loaded.sprite.frames.length,
      ...(primary.src.rulesBool(id, 'Rotates') ? { rotates: true } : {}),
      ...(secBool(sec, 'Translucent') ? { translucent: true } : {}),
    };
    count('bullets:shp');
  }

  // ---------------------------------------------------------------- voxel anims (debris)
  for (const id of rules
    .readRegistry('VoxelAnims')
    .map((v) => v.trim())
    .filter(Boolean)) {
    if (voxelModels.has(id)) continue;
    const { image } = primary.src.artOf(id);
    const model = buildVoxelModel(
      id,
      [{ role: 'body', stem: image.toLowerCase(), required: false }],
      0,
      primary.inst,
      warn,
    );
    if (model) {
      voxelModels.set(id, model);
      count('voxelAnims');
    }
  }

  // ---------------------------------------------------------------- particles
  const particles: Record<string, EffectParticle> = {};
  for (const id of rules
    .readRegistry('Particles')
    .map((v) => v.trim())
    .filter(Boolean)) {
    const image = (primary.src.rulesGet(id, 'Image') ?? '').trim();
    if (!image || U(image) === 'NONE') continue;
    const sec = art.getSection(image);
    const loaded =
      anims[U(image)] && typeof anims[U(image)]!.sprite === 'string'
        ? { ref: anims[U(image)]!.sprite }
        : addArt(
            `particle:${id}`,
            (v) => v.src.shpCandidates(sec?.getString('Image', '').trim() || image, sec),
            'anim',
            false,
          );
    if (!loaded) continue;
    const translucency = primary.src.rulesInt(id, 'Translucency');
    particles[id] = {
      sprite: loaded.ref,
      palette: 'anim',
      ...(translucency ? { translucency } : {}),
    };
    count('particles');
  }

  // ---------------------------------------------------------------- overlays and smudges (theater art)
  const overlays: Record<string, EffectCellArt> = {};
  let usesIso = false;
  let usesTheater = false;
  for (const id of [
    ...new Set(
      rules
        .readRegistry('OverlayTypes')
        .map((v) => v.trim())
        .filter(Boolean),
    ),
  ]) {
    const wall = primary.src.rulesBool(id, 'Wall');
    const tiberium = primary.src.rulesBool(id, 'Tiberium');
    const palette = wall ? 'unit' : tiberium ? 'theater' : 'iso';
    const loaded = addArt(
      `overlay:${id}`,
      (v) => {
        const { sec, image } = v.src.artOf(id);
        return v.src.shpCandidates(image, sec);
      },
      palette,
      wall,
    );
    if (!loaded) continue;
    if (palette === 'iso') usesIso = true;
    if (palette === 'theater') usesTheater = true;
    if (palette === 'unit') usesUnit = true;
    const highBridge = /^(BRIDGE|BRIDGEB|RAILBRDG)[12]$/i.test(id);
    const flat = !wall && !highBridge && (tiberium || primary.src.rulesBool(id, 'DrawFlat', true));
    overlays[id] = {
      sprite: loaded.ref,
      palette,
      ...(wall ? { remap: true } : {}),
      ...(flat ? { flat: true } : {}),
      drawOffset: highBridge ? [0, -60] : drawOffsetFor('overlay', { isARock: primary.src.rulesBool(id, 'IsARock') }),
    };
    count('overlays');
  }
  const smudges: Record<string, EffectCellArt> = {};
  for (const id of [
    ...new Set(
      rules
        .readRegistry('SmudgeTypes')
        .map((v) => v.trim())
        .filter(Boolean),
    ),
  ]) {
    const loaded = addArt(
      `smudge:${id}`,
      (v) => {
        const { image } = v.src.artOf(id);
        const t = THEATERS[v.id];
        return [`${image.toLowerCase()}.${t.ext}`, `${image.toLowerCase()}.shp`];
      },
      'iso',
      false,
    );
    if (!loaded) continue;
    usesIso = true;
    smudges[id] = { sprite: loaded.ref, palette: 'iso', flat: true, drawOffset: drawOffsetFor('smudge') };
    count('smudges');
  }
  if (usesIso) themed('iso');
  if (usesTheater) themed('theater');
  if (usesUnit) themed('unit');

  // ---------------------------------------------------------------- SHP unit timing
  const shpUnits: EffectLibrary['shpUnits'] = {};
  for (const list of ['VehicleTypes', 'AircraftTypes']) {
    for (const id of rules
      .readRegistry(list)
      .map((v) => v.trim())
      .filter(Boolean)) {
      const { sec } = primary.src.artOf(id);
      if (!sec || secBool(sec, 'Voxel')) continue;
      if (secInt(sec, 'WalkFrames') === undefined && secInt(sec, 'FiringFrames') === undefined) continue;
      const walkRate = primary.src.rulesInt(id, 'WalkRate');
      const idleRate = primary.src.rulesInt(id, 'IdleRate');
      shpUnits[id] = {
        ...(walkRate !== undefined ? { walkRate } : {}),
        ...(idleRate !== undefined ? { idleRate } : {}),
      };
    }
  }

  const storageBuildings = rules
    .readRegistry('BuildingTypes')
    .map((v) => v.trim())
    .filter((id) => id && (primary.src.rulesBool(id, 'Refinery') || (primary.src.rulesInt(id, 'Storage') ?? 0) > 0));

  counts['voxels'] = voxelModels.size;
  return {
    rulesTable: effectRulesTable(rules, art),
    library: {
      version: EFFECT_LIBRARY_VERSION,
      theaters: views.map((v) => v.id),
      anims,
      bullets,
      overlays,
      smudges,
      voxels: {},
      particles,
      shpUnits,
      storageBuildings: [...new Set(storageBuildings)].sort(),
    },
    sprites,
    voxelModels,
    paletteFiles,
    table,
    counts,
    warnings,
  };
}

/** Categories whose art a battle shows constantly: packed first and together, so a live view loads few pages. */
const COMBAT_CATEGORIES = new Set<EffectCategory>([
  'explosion',
  'muzzle',
  'impact',
  'smoke',
  'fire',
  'debris',
  'corpse',
  'infantry-death',
  'electric',
  'psychic',
  'water',
]);

/**
 * Page family of a sprite id: combat anims first, then the other theater-independent anims, projectiles and
 * particles, then one family per theater variant suffix (anim, overlay and smudge variants of one theater together).
 */
function spriteFamily(id: string, table: Record<string, EffectTableRow>): string {
  const [kindId, theater] = id.split('@') as [string, string | undefined];
  const [kind, name] = kindId.split(':') as [string, string];
  if (theater) return `9-${theater}`;
  if (kind === 'anim') return COMBAT_CATEGORIES.has(table[name]?.c ?? 'ignore') ? '0-combat' : '2-anim';
  if (kind === 'bullet' || kind === 'particle') return '1-projectile';
  return `3-${kind}`;
}

/** packSprites per family, pages concatenated (frames keep their page index across families). */
function packFamilies(
  sprites: ReadonlyMap<string, PendingSprite>,
  familyOf: (id: string) => string,
): ReturnType<typeof packSprites> {
  const families = new Map<string, Map<string, PendingSprite>>();
  for (const [id, s] of sprites) {
    const key = familyOf(id);
    let family = families.get(key);
    if (!family) families.set(key, (family = new Map()));
    family.set(id, s);
  }
  const pages: ReturnType<typeof packSprites>['pages'] = [];
  const entries: ReturnType<typeof packSprites>['entries'] = {};
  for (const key of [...families.keys()].sort()) {
    const part = packSprites(families.get(key)!, { format: 'indexed', maxPage: LIBRARY_ATLAS_MAX });
    const offset = pages.length;
    pages.push(...part.pages);
    for (const [id, e] of Object.entries(part.entries)) {
      const shift = (f: (typeof e.frames)[number]) => {
        const page = (f.page ?? 0) + offset;
        const plain = { rect: f.rect, offset: f.offset };
        return page > 0 && f.rect[2] > 0 ? { ...plain, page } : plain;
      };
      entries[id] = { ...e, frames: e.frames.map(shift), ...(e.shadows ? { shadows: e.shadows.map(shift) } : {}) };
    }
  }
  return { pages, entries };
}

/** Pack and write a collected sidecar into `dir` (effects.json, effects-<n>.png, palettes/, voxels/). */
export function writeEffects(collected: CollectedEffects, dir: string): EffectLibrary {
  mkdirSync(dir, { recursive: true });
  for (const f of existsSync(dir) ? readdirSync(dir) : []) if (/^effects-\d+\.png$/.test(f)) rmSync(join(dir, f));
  const packed = packFamilies(collected.sprites, (id) => spriteFamily(id, collected.table));
  const spriteAtlases = packed.pages.map((p, i) => {
    const file = `effects-${i}.png`;
    writeFileSync(join(dir, file), encodePng({ width: p.width, height: p.height, channels: 1, data: p.data }));
    return { file, width: p.width, height: p.height };
  });
  mkdirSync(join(dir, 'palettes'), { recursive: true });
  const palettes: Record<string, string> = {};
  const paletteSources: Record<string, string> = {};
  for (const [key, { inst, file }] of [...collected.paletteFiles].sort(([a], [b]) => (a < b ? -1 : 1))) {
    let pal;
    try {
      pal = inst.palette(file);
    } catch {
      collected.warnings.push(`palette ${file} missing`);
      continue;
    }
    const out = `palettes/${key}.png`;
    writeFileSync(join(dir, out), encodePng({ width: 256, height: 1, channels: 3, data: Uint8Array.from(pal.rgb) }));
    palettes[key] = out;
    paletteSources[key] = file;
  }
  const voxels: Record<string, string> = {};
  if (collected.voxelModels.size) mkdirSync(join(dir, 'voxels'), { recursive: true });
  for (const [id, model] of [...collected.voxelModels].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const name = `${id.replace(/[^A-Za-z0-9_.-]/g, '_')}.json`;
    writeFileSync(join(dir, 'voxels', name), JSON.stringify(model));
    voxels[id] = `voxels/${name}`;
  }
  const counts = { ...collected.counts };
  counts['sprites'] = Object.keys(packed.entries).length;
  counts['frames'] = Object.values(packed.entries).reduce((n, e) => n + e.frames.length + (e.shadows?.length ?? 0), 0);
  counts['atlasPages'] = spriteAtlases.length;
  const library: EffectLibrary = {
    ...collected.library,
    palettes,
    paletteSources,
    spriteAtlases,
    sprites: packed.entries,
    voxels,
    extractor: { tool: 'ra2-assets effects', counts, warnings: collected.warnings },
  };
  writeFileSync(join(dir, 'effects.json'), JSON.stringify(library));
  return library;
}

/** Open the install once per theater, collect and write the sidecar. */
export function extractEffects(opts: EffectsOptions): EffectsResult {
  const t0 = Date.now();
  const log = opts.log ?? ((m: string) => console.log(m));
  const theaters = opts.theaters?.length ? opts.theaters : ALL_EFFECT_THEATERS;
  const installs = theaters.map((theater) => ({
    theater,
    inst: GameInstall.open(opts.gameDir, theater) as InstallView,
  }));
  const collected = collectEffects(installs);
  const library = writeEffects(collected, opts.outDir);
  const bytes = dirBytes(opts.outDir);
  const c = library.extractor.counts;
  log(
    `effects: ${Object.keys(library.anims).length} anims, ${Object.keys(library.bullets).length} projectiles, ` +
      `${Object.keys(library.overlays).length} overlays, ${Object.keys(library.smudges).length} smudges, ` +
      `${Object.keys(library.particles).length} particles, ${Object.keys(library.voxels).length} voxels; ` +
      `${c['sprites']} sprites (${c['frames']} frames) on ${c['atlasPages']} pages, ` +
      `${library.extractor.warnings.length} warnings, ${(bytes / 1048576).toFixed(1)} MiB (${Date.now() - t0} ms)`,
  );
  return {
    dir: opts.outDir,
    library,
    table: collected.table,
    rulesTable: collected.rulesTable,
    bytes,
    ms: Date.now() - t0,
  };
}
