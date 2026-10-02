import type { GameRenderRadBeam, GameRenderWave } from '../renderState';
import type { GuestMemoryAccessor } from '../shared/memoryAccessor';
import type { YrPoint3 } from './objectCoords';
import { isPlausiblePointer, readPointerVector } from './stateReader';

/**
 * Read-only YR 1.001 RadBeam/Wave observer, used inside the hash-gated effects reader.
 * YRpp RadBeam.h, WaveClass.h, ObjectClass.h and GeneralDefinitions.h are facts only;
 * all native fields below were checked in the player's gamemd.exe disassembly:
 *
 * - RadBeam has no vtable. Allocate (0x659110) registers in the vector at 0xB04A60:
 *   capacity 0x659134, count 0x659139/0x65917A, items 0x659180/0x659186. DrawAll
 *   reads count/items at 0x6591B9/0x6591D7. Ctor stores Type +0x10 at 0x65940F.
 *   Enum 1/2: weapon allocations 0x6FD629/0x6FD929; 0 is YRpp's Temporal value
 *   (the ctor accepts it, but DrawAll only dispatches 1/2 at 0x65928C/0x6592CD).
 * - RGB bytes +0x20..22: 0x659474..0x659480; source +0x24..2C:
 *   0x6594A4..0x6594B4; target +0x30..38: 0x6594C4..0x6594D4.
 *   Period +0x3C: 0x6594E4; Amplitude (double) +0x40: 0x6594F8/0x6594FB.
 *   Period is a draw-cycle duration, not a spatial wavelength. Age +0x7C increments
 *   at 0x6599A8/0x6599AD and returns expired at age >= Period (0x6599B0/0x6599B3);
 *   eruption has the same test at 0x659E0F..0x659E1D. Sustained +0x58 (0x659554)
 *   instead oscillates age with step +0x54 (0x65996F..0x659998), never expiring.
 *   Drawing-enabled byte +9 gates the native ribbons (0x65978C/0x659CB7).
 * - Wave ctor 0x75E950 calls ObjectClass ctor (0x75E956 -> 0x5F3900 ->
 *   0x410170); UniqueID +0x10 is initialized at 0x410191. InLimbo +0x81:
 *   0x5F392A/0x75F912. Primary vtable 0x7F6BF4: 0x75EA3F. It registers in
 *   0xA8EC38 (capacity/count 0x75EAA9/0x75EAAE, items 0x75EAF3/0x75EAF9).
 * - Wave Type +0xB0: 0x75E97B. YRpp enum 0 Sonic, 1 Laser, 2 BigLaser,
 *   3 Magnetron: ctor selects magnetic drawing for 3 at 0x75EB09..0x75EB29,
 *   laser intensity for 1/2 at 0x75EB62..0x75EB87, sonic-specific lift for 0
 *   at 0x761A66..0x761A6B; AI dispatches all four at 0x760F56..0x760F65.
 * - Actual clipped world endpoints (not +0xCC, which is screen-space): source
 *   +0xC0..C8 at 0x761B49..0x761B75 / 0x7625DD..0x762602; target +0xB4..BC
 *   at 0x761B1E..0x761B34 / 0x7625B2..0x7625C8. These cache the coordinates
 *   passed to Draw_NonMagnetic/Draw_Magnetic, including their native inset.
 *   The ctor initializes them via direct calls at 0x75EB1A/0x75EB29; sonic/
 *   magnetic AI calls Update_Wave at 0x760F6E/0x760FA0, which directly refreshes
 *   them at 0x762CBF/0x762D0E/0x762D52. Suppressing DrawIfVisible's vtable slot
 *   does not intercept these calls; short-lived laser waves retain ctor endpoints.
 * - WaveIntensity +0x130 starts at 100 (0x75E98E), decrements to -1 then
 *   destroys (0x760F73..0x760F86 / 0x760FD7..0x760FEB). Magnetron can reset it
 *   to 64 and increment cycle +0x134 (0x762B51/0x762B5C); progress is per cycle,
 *   not a promise of monotonic total age. LaserIntensity +0x1D0 starts at 160
 *   (0x75EB87), subtracts 6, destroys below 32 (0x760FF6..0x761010).
 *
 * No guest calls or writes. Torn/partial objects, counts and pointers are bounded
 * and counted, just like effectsReader. Native list membership owns removal.
 */
export const YR_BEAMS_GLOBALS = Object.freeze({ radBeams: 0xb04a60, waves: 0xa8ec38 });
export const YR_WAVE_VTABLE = 0x7f6bf4;
export const YR_BEAMS_OFFSETS = Object.freeze({
  radDrawing: 0x9,
  radType: 0x10,
  radColor: 0x20,
  radSource: 0x24,
  radTarget: 0x30,
  radPeriod: 0x3c,
  radAmplitude: 0x40,
  radSustained: 0x58,
  radAge: 0x7c,
  waveUid: 0x10,
  waveLimbo: 0x81,
  waveType: 0xb0,
  waveTarget: 0xb4,
  waveSource: 0xc0,
  waveIntensity: 0x130,
  waveLaserIntensity: 0x1d0,
});
/** Defensive bounds, not native capacities or rules. */
export const YR_BEAMS_LIMITS = Object.freeze({ radBeams: 1024, waves: 1024, period: 10_000, amplitude: 4096 });

export interface YrRadBeamEffect extends GameRenderRadBeam {}
export interface YrWaveEffect extends GameRenderWave {}
export interface YrBeamsStats {
  vectors: { radBeams: number; waves: number };
  invalid: { radBeams: number; waves: number };
  inactive: { radBeams: number; waves: number };
}
export interface YrBeams {
  radBeams: YrRadBeamEffect[];
  waves: YrWaveEffect[];
  stats: YrBeamsStats;
}

const RAD_TYPES = ['temporal', 'rad', 'eruption'] as const;
const WAVE_TYPES = ['sonic', 'laser', 'biglaser', 'magnetron'] as const;
const withinWorld = (p: YrPoint3) =>
  Math.abs(p.x) <= 512 * 256 && Math.abs(p.y) <= 512 * 256 && Math.abs(p.z) <= 64 * 104;
const point = (m: GuestMemoryAccessor, at: number): YrPoint3 => ({
  x: m.i32(at),
  y: m.i32(at + 4),
  z: m.i32(at + 8),
});

export function readYrBeams(m: GuestMemoryAccessor, options: { includeLimbo?: boolean } = {}): YrBeams {
  const o = YR_BEAMS_OFFSETS;
  const stats: YrBeamsStats = {
    vectors: { radBeams: 0, waves: 0 },
    invalid: { radBeams: 0, waves: 0 },
    inactive: { radBeams: 0, waves: 0 },
  };
  const entries = (kind: keyof typeof YR_BEAMS_GLOBALS): number[] => {
    const base = YR_BEAMS_GLOBALS[kind];
    const count = m.u32(base + 0x10);
    stats.vectors[kind] = count;
    // Check capacity as well: a snapshot can land between vector growth/count stores.
    const pointers =
      base + 0x18 <= m.size && count <= m.u32(base + 8) ? readPointerVector(m, base, YR_BEAMS_LIMITS[kind]) : null;
    if (!pointers) stats.invalid[kind] += Math.max(1, count);
    return pointers ?? [];
  };
  const radBeams: YrRadBeamEffect[] = [];
  const waves: YrWaveEffect[] = [];
  const seen = new Set<number>();
  for (const id of entries('radBeams')) {
    if (!isPlausiblePointer(m, id, 0x80) || seen.has(id)) {
      stats.invalid.radBeams++;
      continue;
    }
    seen.add(id);
    const type = RAD_TYPES[m.u32(id + o.radType)];
    const source = point(m, id + o.radSource),
      target = point(m, id + o.radTarget);
    const period = m.i32(id + o.radPeriod),
      age = m.i32(id + o.radAge);
    const bytes = m.bytes(id + o.radAmplitude, 8);
    const amplitude = bytes.length === 8 ? new DataView(bytes.buffer, bytes.byteOffset, 8).getFloat64(0, true) : NaN;
    const sustained = m.u8(id + o.radSustained),
      drawing = m.u8(id + o.radDrawing);
    if (
      !type ||
      !withinWorld(source) ||
      !withinWorld(target) ||
      period < 1 ||
      period > YR_BEAMS_LIMITS.period ||
      age < 0 ||
      age > period + 1 ||
      !Number.isFinite(amplitude) ||
      Math.abs(amplitude) > YR_BEAMS_LIMITS.amplitude ||
      sustained > 1 ||
      drawing > 1
    ) {
      stats.invalid.radBeams++;
      continue;
    }
    if (!drawing || (!sustained && age >= period)) {
      stats.inactive.radBeams++;
      continue;
    }
    radBeams.push({
      id,
      type,
      source,
      target,
      period,
      amplitude,
      color: [m.u8(id + o.radColor), m.u8(id + o.radColor + 1), m.u8(id + o.radColor + 2)],
      age,
      sustained: !!sustained,
      progress: Math.min(1, age / period),
    });
  }
  seen.clear();
  for (const id of entries('waves')) {
    if (!isPlausiblePointer(m, id, 0x1d4) || m.u32(id) !== YR_WAVE_VTABLE || seen.has(id)) {
      stats.invalid.waves++;
      continue;
    }
    seen.add(id);
    const type = WAVE_TYPES[m.u32(id + o.waveType)];
    const source = point(m, id + o.waveSource),
      target = point(m, id + o.waveTarget);
    const laser = type === 'laser' || type === 'biglaser';
    const intensity = m.i32(id + (laser ? o.waveLaserIntensity : o.waveIntensity));
    const limbo = m.u8(id + o.waveLimbo);
    if (
      !type ||
      !withinWorld(source) ||
      !withinWorld(target) ||
      intensity < -6 ||
      intensity > (laser ? 160 : 100) ||
      limbo > 1
    ) {
      stats.invalid.waves++;
      continue;
    }
    if ((limbo && !options.includeLimbo) || intensity < (laser ? 32 : 0)) {
      stats.inactive.waves++;
      continue;
    }
    waves.push({
      id,
      uid: m.u32(id + o.waveUid),
      type,
      source,
      target,
      intensity,
      progress: Math.min(1, laser ? (160 - intensity) / 128 : (100 - intensity) / 100),
    });
  }
  return { radBeams, waves, stats };
}
