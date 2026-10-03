import { describe, expect, it } from 'vitest';
import { createByteViewAccessor } from '../../src/games/shared/memoryAccessor';
import { readYrEffects } from '../../src/games/yr/effectsReader';
import {
  readYrBeams,
  YR_BEAMS_GLOBALS as G,
  YR_BEAMS_OFFSETS as O,
  YR_BEAMS_LIMITS as L,
  YR_WAVE_VTABLE,
} from '../../src/games/yr/beamsReader';

function memory() {
  const bytes = new Uint8Array(0x1000000),
    data = new DataView(bytes.buffer);
  let next = 0xc00000;
  const alloc = (size: number) => {
    const at = next;
    next += (size + 15) & ~15;
    return at;
  };
  const word = (at: number, value: number) => data.setInt32(at, value, true);
  const point = (at: number, x: number, y: number, z: number) => {
    word(at, x);
    word(at + 4, y);
    word(at + 8, z);
  };
  const vector = (base: number, pointers: number[]) => {
    const items = alloc(Math.max(4, pointers.length * 4));
    word(base + 4, items);
    word(base + 8, pointers.length);
    word(base + 0x10, pointers.length);
    pointers.forEach((p, i) => word(items + i * 4, p));
  };
  const rad = (type = 1, age = 5) => {
    const at = alloc(0xc8);
    word(at + O.radType, type);
    bytes[at + O.radDrawing] = 1;
    point(at + O.radSource, 2560, 3072, 104);
    point(at + O.radTarget, 4096, 3584, 208);
    bytes.set([20, 250, 70], at + O.radColor);
    word(at + O.radPeriod, 20);
    word(at + O.radAge, age);
    data.setFloat64(at + O.radAmplitude, 40.5, true);
    return at;
  };
  const wave = (type = 3, intensity = 50) => {
    const at = alloc(0x240);
    word(at, YR_WAVE_VTABLE);
    word(at + O.waveUid, 123 + type);
    word(at + O.waveType, type);
    point(at + O.waveSource, 2560, 3072, 104);
    point(at + O.waveTarget, 4096, 3584, 208);
    // Screen-space +CC deliberately differs, to catch accidental endpoint interpretation.
    point(at + 0xcc, 800, 600, 0);
    word(at + O.waveIntensity, intensity);
    word(at + O.waveLaserIntensity, intensity);
    return at;
  };
  return { bytes, data, alloc, word, point, vector, rad, wave, accessor: createByteViewAccessor(bytes) };
}

describe('YR RadBeam and Wave memory', () => {
  it('reads dispatched native kinds, world endpoints, RGB/double amplitude and lifetimes without writes', () => {
    const m = memory();
    const rad = [m.rad(0), m.rad(1), m.rad(2)];
    const waves = [m.wave(0), m.wave(1, 96), m.wave(2, 96), m.wave(3)];
    m.vector(G.radBeams, rad);
    m.vector(G.waves, waves);
    const before = m.bytes.slice();
    const read = readYrBeams(m.accessor);
    expect(read.radBeams.map((b) => b.type)).toEqual(['rad', 'eruption']);
    expect(read.radBeams[0]).toMatchObject({
      color: [20, 250, 70],
      amplitude: 40.5,
      period: 20,
      age: 5,
      progress: 0.25,
    });
    expect(read.waves.map((b) => b.type)).toEqual(['sonic', 'laser', 'biglaser', 'magnetron']);
    expect(read.waves.every((b) => b.progress === 0.5)).toBe(true);
    expect(read.waves[0]).toMatchObject({
      source: { x: 2560, y: 3072, z: 104 },
      target: { x: 4096, y: 3584, z: 208 },
      uid: 123,
    });
    expect(read.stats.invalid).toEqual({ radBeams: 0, waves: 0 });
    expect(read.stats.inactive.radBeams).toBe(1);
    expect(m.bytes.every((b, i) => b === before[i])).toBe(true);
  });

  it('observes chrono as native type 1 with cached RGB and exact FLH/target anchors for its 15 draw cycles', () => {
    const m = memory();
    const chrono = m.rad(1, 0);
    m.bytes.set([128, 200, 255], chrono + O.radColor);
    m.word(chrono + O.radPeriod, 15);
    m.data.setFloat64(chrono + O.radAmplitude, 40, true);
    m.point(chrono + O.radSource, 2560 + 100, 3072 - 25, 104 + 135);
    m.point(chrono + O.radTarget, 4096 + 64, 3584 - 32, 208 + 180);
    m.vector(G.radBeams, [chrono]);
    expect(readYrBeams(m.accessor).radBeams).toEqual([
      {
        id: chrono,
        type: 'rad',
        color: [128, 200, 255],
        source: { x: 2660, y: 3047, z: 239 },
        target: { x: 4160, y: 3552, z: 388 },
        amplitude: 40,
        period: 15,
        age: 0,
        progress: 0,
        sustained: false,
      },
    ]);
    // A map may override ChronoBeamColor; color never changes native type semantics.
    m.bytes.set([227, 66, 19], chrono + O.radColor);
    m.word(chrono + O.radAge, 14);
    expect(readYrBeams(m.accessor).radBeams[0]).toMatchObject({
      type: 'rad',
      color: [227, 66, 19],
      age: 14,
      progress: 14 / 15,
    });
    m.word(chrono + O.radAge, 15);
    expect(readYrBeams(m.accessor).radBeams).toEqual([]);
    expect(readYrBeams(m.accessor).stats.inactive.radBeams).toBe(1);
  });

  it('adds optional effects arrays and diagnostics through the existing observer', () => {
    const m = memory();
    m.vector(G.radBeams, [m.rad()]);
    m.vector(G.waves, [m.wave()]);
    const read = readYrEffects(m.accessor, { fireWindow: 0 });
    expect(read.radBeams).toHaveLength(1);
    expect(read.waves).toHaveLength(1);
    expect(read.stats.beams?.vectors).toEqual({ radBeams: 1, waves: 1 });
    expect(read.lasers).toEqual([]);
    expect(read.electricBolts).toEqual([]);
  });

  it('rejects null, unaligned, truncated, wrong-vtable and duplicate pointers independently', () => {
    const m = memory(),
      rad = m.rad(),
      wave = m.wave(),
      badWave = m.wave();
    m.word(badWave, 0x7e3354);
    m.vector(G.radBeams, [0, rad + 1, m.bytes.length - 4, rad, rad]);
    m.vector(G.waves, [0, wave + 1, m.bytes.length - 4, badWave, wave, wave]);
    const read = readYrBeams(m.accessor);
    expect(read.radBeams).toHaveLength(1);
    expect(read.waves).toHaveLength(1);
    expect(read.stats.invalid).toEqual({ radBeams: 4, waves: 5 });
  });

  it.each(['radBeams', 'waves'] as const)('bounds %s count, capacity, items and header before scanning', (kind) => {
    const m = memory(),
      base = G[kind];
    m.word(base + 0x10, L[kind] + 1);
    m.word(base + 8, L[kind] + 1);
    expect(readYrBeams(m.accessor).stats.invalid[kind]).toBe(L[kind] + 1);
    m.word(base + 0x10, 2);
    m.word(base + 8, 1);
    expect(readYrBeams(m.accessor).stats.invalid[kind]).toBe(2);
    m.word(base + 8, 2);
    m.word(base + 4, m.bytes.length - 4);
    expect(readYrBeams(m.accessor).stats.invalid[kind]).toBe(2);
    const short = createByteViewAccessor(new Uint8Array(32));
    expect(readYrBeams(short)[kind]).toEqual([]);
    expect(readYrBeams(short).stats.invalid[kind]).toBe(1);
    m.vector(base, []);
    expect(readYrBeams(m.accessor).stats.invalid[kind]).toBe(0);
  });

  it('rejects torn kinds, coordinates, nonfinite/huge amplitude, periods and intensity', () => {
    const m = memory();
    const rad = Array.from({ length: 7 }, () => m.rad());
    m.word(rad[0]! + O.radType, 3);
    m.word(rad[1]! + O.radSource, 512 * 256 + 1);
    m.word(rad[2]! + O.radPeriod, 0);
    m.word(rad[3]! + O.radPeriod, L.period + 1);
    m.data.setFloat64(rad[4]! + O.radAmplitude, NaN, true);
    m.data.setFloat64(rad[5]! + O.radAmplitude, L.amplitude + 1, true);
    m.word(rad[6]! + O.radAge, -1);
    const waves = [m.wave(4), m.wave(0, 101), m.wave(1, 161), m.wave()];
    m.word(waves[3]! + O.waveTarget + 8, 64 * 104 + 1);
    m.vector(G.radBeams, rad);
    m.vector(G.waves, waves);
    expect(readYrBeams(m.accessor).stats.invalid).toEqual({ radBeams: 7, waves: 4 });
  });

  it('filters expired/disabled and limbo effects but preserves sustained age and magnetron resets', () => {
    const m = memory(),
      rad = m.rad(1, 20),
      sustained = m.rad(1, 20),
      disabled = m.rad();
    m.bytes[sustained + O.radSustained] = 1;
    m.bytes[disabled + O.radDrawing] = 0;
    const limbo = m.wave();
    m.bytes[limbo + O.waveLimbo] = 1;
    const mag = m.wave(3, 64);
    m.vector(G.radBeams, [rad, sustained, disabled]);
    m.vector(G.waves, [limbo, m.wave(0, -1), m.wave(1, 31), mag]);
    const read = readYrBeams(m.accessor);
    expect(read.radBeams.map((b) => b.id)).toEqual([sustained]);
    expect(read.waves).toMatchObject([{ id: mag, progress: 0.36 }]);
    expect(read.stats.inactive).toEqual({ radBeams: 2, waves: 3 });
    expect(readYrBeams(m.accessor, { includeLimbo: true }).waves).toHaveLength(2);
  });
});
