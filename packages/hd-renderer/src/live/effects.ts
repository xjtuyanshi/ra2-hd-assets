import { Vector3 } from 'three/webgpu';
import type { EffectsLayer } from '../effects';
import { LEVEL_HEIGHT } from '../world';

/**
 * Drives HD effects from the game's own effect list (src/games/yr/effectsReader.ts on the host side): every explosion,
 * muzzle flash, impact, fire and smoke the engine plays spawns the matching HD effect at the same place and moment, so
 * combat reads exactly as in the original, only rendered with modern particles and light. The original anim art is
 * not drawn in the HD view.
 */

/** Minimal effect data the live view needs (lepton coordinates, stable identity). */
export interface LiveAnim {
  id: number;
  uid: number;
  /** Anim type id, e.g. "TWLT070", "GUNFIRE", "FIRE01". */
  type: string;
  x: number;
  y: number;
  z: number;
}

export interface LiveBullet {
  id: number;
  uid: number;
  x: number;
  y: number;
  z: number;
}

export interface LiveParticleSystem {
  id: number;
  uid: number;
  behaviour: 'smoke' | 'gas' | 'fire' | 'spark' | 'railgun' | null;
  x: number;
  y: number;
  z: number;
}

/** An energy beam the engine is drawing this frame (laser, prism, electric/psychic bolt), lepton endpoints. */
export interface LiveBeam {
  source: { x: number; y: number; z: number };
  target: { x: number; y: number; z: number };
  kind: 'laser' | 'bolt';
  /** sRGB colour 0..255. */
  colour: [number, number, number];
}

export interface LiveEffects {
  anims: LiveAnim[];
  bullets: LiveBullet[];
  particleSystems: LiveParticleSystem[];
  beams?: LiveBeam[];
}

type AnimLook = { kind: 'explosion' | 'muzzle' | 'impact' | 'fire' | 'smoke'; scale: number } | { kind: 'ignore' };

/** Seconds between samples of a continuous emitter, per kind. */
const EMIT_INTERVAL = { fire: 1 / 14, smoke: 1 / 4, tracer: 1 / 60, particleSmoke: 1 / 3, particleFire: 1 / 10 };

/**
 * Map an engine anim type to an HD effect. Sizes follow the numeric suffix the art names carry (TWLT070 is bigger than
 * TWLT026), clamped; non-combat anims (move-order ring, ore twinkle, parachutes, teleports, "behind building" markers)
 * are ignored.
 */
export function classifyAnim(type: string): AnimLook {
  const name = type.toUpperCase();
  if (/^(BEHIND|RING|TWNK|PARACH|WARP|MOVEFLSH|D$|IONBEAM|WAKE|SPLASH)/.test(name)) return { kind: 'ignore' };
  const size = Number(/(\d+)/.exec(name)?.[1] ?? NaN);
  const bySize = (base: number) => (Number.isFinite(size) ? Math.min(1.5, Math.max(0.3, size / 55)) : base);
  if (/^(GUNFIRE|MGUN|FLASH|MUZZ|UCFLASH|VULCFLSH)/.test(name))
    return { kind: 'muzzle', scale: /^MGUN/.test(name) ? 0.25 : 0.45 };
  if (/^(PIFF|PIFFPIFF|SPARK|RICO)/.test(name)) return { kind: 'impact', scale: 0.35 };
  if (/^(FIRE|FLAME|BURN|NAPALM|FLMSPT)/.test(name)) return { kind: 'fire', scale: /^FIRE0?3/.test(name) ? 1 : 0.7 };
  if (/^(SMOKE|SMOKEY|SGRYSMK|HTRKPUFF|DUST|SMKMUZ)/.test(name))
    return { kind: 'smoke', scale: /PUFF/.test(name) ? 0.45 : 0.8 };
  if (/^(TWLT|EXPLO|S_(CLSN|BANG|TUMU|BRNL|FLMTH|OFFS)|NUKE|ATOM|ARTYHIT|FLAKTRL|VT)/.test(name))
    return { kind: 'explosion', scale: /^S_CLSN22/.test(name) ? 0.4 : bySize(0.8) };
  if (/^DBRIS|^DBRS/.test(name)) return { kind: 'impact', scale: 0.5 };
  return { kind: 'ignore' };
}

interface Tracked {
  look: AnimLook;
  lastSeen: number;
  nextEmit: number;
  at: Vector3;
}

export class LiveEffectsDriver {
  private readonly anims = new Map<string, Tracked>();
  private readonly systems = new Map<string, Tracked>();
  private bullets: LiveBullet[] = [];
  private beams: LiveBeam[] = [];
  private generation = 0;

  constructor(
    private readonly effects: EffectsLayer,
    /** True when a lepton location is hidden under black shroud (nothing is spawned there). */
    private readonly hidden: (x: number, y: number, z: number) => boolean,
  ) {}

  /** A new snapshot arrived: spawn one-shot effects for anims seen for the first time, and track the ongoing ones. */
  push(effects: LiveEffects, now: number, wind: Vector3): void {
    const generation = ++this.generation;
    for (const anim of effects.anims) {
      const key = `${anim.id}:${anim.uid}`;
      let tracked = this.anims.get(key);
      if (!tracked) {
        tracked = { look: classifyAnim(anim.type), lastSeen: generation, nextEmit: now, at: new Vector3() };
        this.anims.set(key, tracked);
        world(anim, tracked.at);
        if (!this.hidden(anim.x, anim.y, anim.z)) this.spawnOnce(tracked, now, wind);
      }
      tracked.lastSeen = generation;
      world(anim, tracked.at);
    }
    for (const [key, tracked] of this.anims) if (tracked.lastSeen !== generation) this.anims.delete(key);
    for (const system of effects.particleSystems) {
      const key = `${system.id}:${system.uid}`;
      let tracked = this.systems.get(key);
      const kind = system.behaviour === 'fire' ? 'fire' : system.behaviour === 'smoke' ? 'smoke' : null;
      if (!kind) continue;
      if (!tracked) {
        tracked = { look: { kind, scale: 0.7 }, lastSeen: generation, nextEmit: now, at: new Vector3() };
        this.systems.set(key, tracked);
      }
      tracked.lastSeen = generation;
      world(system, tracked.at);
    }
    for (const [key, tracked] of this.systems) if (tracked.lastSeen !== generation) this.systems.delete(key);
    this.bullets = effects.bullets.filter((bullet) => !this.hidden(bullet.x, bullet.y, bullet.z));
    this.beams = (effects.beams ?? []).filter((beam) => !this.hidden(beam.target.x, beam.target.y, beam.target.z));
  }

  /** Per presented frame: continuous emitters (fire, smoke, tracers). */
  frame(now: number, wind: Vector3): void {
    for (const tracked of this.anims.values()) this.emit(tracked, now, wind, 1);
    for (const tracked of this.systems.values()) this.emit(tracked, now, wind, 0.6);
    const at = new Vector3();
    for (const bullet of this.bullets) this.effects.tracer(now, world(bullet, at));
    const from = new Vector3();
    const colour = new Vector3();
    for (const beam of this.beams) {
      colour.set(...(beam.colour.map((c) => Math.pow(c / 255, 2.2)) as [number, number, number]));
      this.effects.beam(now, world(beam.source, from), world(beam.target, at), colour, beam.kind === 'bolt');
    }
  }

  private spawnOnce(tracked: Tracked, now: number, wind: Vector3): void {
    const { look, at } = tracked;
    if (look.kind === 'explosion') this.effects.explode(now, at, look.scale, wind);
    else if (look.kind === 'muzzle') this.effects.muzzleFlash(now, at, look.scale);
    else if (look.kind === 'impact') this.effects.impact(now, at, look.scale, wind);
  }

  private emit(tracked: Tracked, now: number, wind: Vector3, rateScale: number): void {
    const { look } = tracked;
    if (look.kind !== 'fire' && look.kind !== 'smoke') return;
    if (now < tracked.nextEmit) return;
    if (look.kind === 'fire') {
      this.effects.flame(now, tracked.at, look.scale);
      // Burning things smoke too.
      if (Math.random() < 0.25)
        this.effects.smokePuff(now, tracked.at.clone().setY(tracked.at.y + 0.3), look.scale, wind);
      tracked.nextEmit = now + EMIT_INTERVAL.fire / rateScale;
    } else {
      this.effects.smokePuff(now, tracked.at, look.scale, wind);
      tracked.nextEmit = now + EMIT_INTERVAL.smoke / rateScale;
    }
  }
}

function world(p: { x: number; y: number; z: number }, out: Vector3): Vector3 {
  return out.set(p.x / 256, (p.z / 104) * LEVEL_HEIGHT, p.y / 256);
}
