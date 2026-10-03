import { describe, expect, it } from 'vitest';
import { parseIni } from 'ra2-formats';
import {
  DEFAULT_NIGHT_LEVEL,
  MAP_LIGHTS_VERSION,
  SURFACE,
  classifyTileSurface,
  engineCellLight,
  engineLightDelta,
  enginePerMille,
  enginePercent,
  engineToLinear,
  lightPerMille,
  mapAtmosphere,
  medianHeight,
  nightBaseAmbient,
  nightEvidence,
  parseEngineDouble,
  parseEngineInt,
  placeStreetLamps,
  readEngineLighting,
  readLightType,
  sidecarAtmosphere,
  spriteClassGradeExempt,
  surfaceFromLandType,
  validateMapLights,
  type EngineLight,
  type EngineLighting,
} from '../src/lights.ts';

const XMP_LIGHTING: EngineLighting = { ambient: 1, red: 1, green: 0.8, blue: 0.68, ground: 0, level: 0 };
const lampAt = (x: number, y: number, extra: Partial<EngineLight> = {}): EngineLight => ({
  position: [x * 256 + 128, y * 256 + 128, 0],
  radius: 4000,
  intensity: 0.5,
  tint: [0.05, 0.05, 0.01],
  ...extra,
});
const flatGrid = (width: number, height: number, z = 0) => ({
  width,
  height,
  z: new Uint8Array(width * height).fill(z),
  exists: new Uint8Array(width * height).fill(1),
});

describe('engine number parsing and storage', () => {
  it('reads the leading numeric prefix like atof/atoi', () => {
    expect(parseEngineDouble('0,01')).toBe(0);
    expect(parseEngineDouble('.5')).toBe(0.5);
    expect(parseEngineDouble(' 0.68 ; comment')).toBe(0.68);
    expect(parseEngineDouble('abc')).toBe(0);
    expect(parseEngineDouble(undefined)).toBeUndefined();
    expect(parseEngineInt('4000.9')).toBe(4000);
    expect(parseEngineInt('-3x')).toBe(-3);
  });

  it('stores values in the engine precision', () => {
    expect(Math.round(enginePercent(0.68) * 100)).toBe(68);
    expect(enginePercent(0.68)).toBe(0.68);
    expect(Math.round(enginePerMille(0.008) * 1000)).toBe(8);
    expect(enginePercent(0.689)).toBe(0.68);
    // BuildingType light fields add 0.1 before truncating (towards zero for negative values).
    expect(lightPerMille(0.05)).toBe(0.05);
    expect(lightPerMille(-0.15)).toBe(-0.149);
  });
});

describe('readEngineLighting', () => {
  it('reads [Lighting] and records defaulted keys', () => {
    const ini = parseIni('[Lighting]\nAmbient=0,01\nRed=1\nGreen=.8\nBlue=0.68\nLevel=0.008\n');
    const sec = ini.getSection('Lighting')!;
    const set = readEngineLighting((key) => (sec.has(key) ? sec.getString(key, '') : undefined));
    expect(set.normal).toEqual({ ambient: 0, red: 1, green: 0.8, blue: 0.68, ground: 0.05, level: 0.008 });
    expect(set.defaulted).toContain('Ground');
    expect(set.defaulted).not.toContain('Level');
    expect(set.ionStorm).toEqual({ ambient: 0.87, red: 0.3, green: 0.4, blue: 0.75, ground: 0, level: 0 });
    expect(set.dominator).toMatchObject({ ambient: 1.5, red: 0.85, green: 0.2, blue: 0.3, ambientChangeRate: 0.001 });
    expect(set.defaulted).toEqual(expect.arrayContaining(['IonAmbient', 'DominatorAmbient', 'DominatorGround']));
  });

  it('uses every constructor default for a missing section', () => {
    const set = readEngineLighting(() => undefined);
    expect(set.normal).toEqual({ ambient: 1, red: 1, green: 1, blue: 1, ground: 0.05, level: 0.008 });
    expect(set.defaulted).toHaveLength(19);
  });
});

describe('readLightType', () => {
  const rules = parseIni(
    [
      '[INGALITE]',
      'LightVisibility=4000',
      'LightIntensity=0.5',
      'LightRedTint=.05',
      'LightGreenTint=.05',
      'LightBlueTint=.01',
      'InvisibleInGame=yes',
      '[GAPOWR]',
      'Strength=750',
      '[NEGLAMP]',
      'LightIntensity=-0.15',
      'LightRedTint=.03',
      '[DARK]',
      'LightIntensity=0',
      'LightVisibility=3000',
    ].join('\n'),
  );
  const map = parseIni('[INGALITE]\nLightIntensity=0.3\n');
  const get = (id: string) => (key: string) => {
    for (const ini of [map, rules]) {
      const sec = ini.getSection(id);
      if (sec?.has(key)) return sec.getString(key, '');
    }
    return undefined;
  };
  const art = { image: 'X', foundation: [1, 1] as [number, number] };

  it('lets the map section override rules and reads the invisible flag', () => {
    expect(readLightType(get('INGALITE'), art)).toEqual({
      radius: 4000,
      intensity: 0.3,
      tint: [0.05, 0.05, 0.01],
      invisible: true,
      image: 'X',
      foundation: [1, 1],
    });
  });

  it('skips types without light and keeps negative lights', () => {
    expect(readLightType(get('GAPOWR'), art)).toBeNull();
    expect(readLightType(get('DARK'), art)).toBeNull();
    const neg = readLightType(get('NEGLAMP'), art)!;
    expect(neg.intensity).toBeLessThan(0);
    expect(neg.radius).toBe(5000);
    // Unset tints keep the constructor's 1000.0.
    expect(neg.tint).toEqual([0.03, 1000, 1000]);
    expect(neg.invisible).toBe(false);
  });
});

describe('engineCellLight', () => {
  const grid = flatGrid(24, 24);

  it('matches the engine formula at the centre, 7 cells out and beyond the radius', () => {
    const out = engineCellLight(grid, XMP_LIGHTING, [lampAt(5, 5)]);
    const at = (x: number, y: number) => {
      const c = y * 24 + x;
      return [out.intensity[c]!, out.tint[c * 3]!, out.tint[c * 3 + 1]!, out.tint[c * 3 + 2]!];
    };
    // Centre: I = 1000 + 500 = 1500; RGB = 1050/850/690; M = 1050; I * M / 1000 = 1575.
    const centre = at(5, 5);
    expect(centre[0]).toBeCloseTo(1.575, 6);
    expect(centre[1]).toBe(1);
    expect(centre[2]).toBeCloseTo(850 / 1050, 6);
    expect(centre[3]).toBeCloseTo(690 / 1050, 6);
    // 7 cells east: d = 1792, f = 552; I = 1276; RGB = 1027/827/685.
    const seven = at(12, 5);
    expect(seven[0]).toBeCloseTo((1276 * 1027) / 1e6, 6);
    expect(seven[2]).toBeCloseTo(827 / 1027, 6);
    expect(seven[3]).toBeCloseTo(685 / 1027, 6);
    // 16 cells east (4096 leptons) is outside the 4000 lepton radius: the map's own lighting only.
    const far = at(21, 5);
    expect(far).toEqual([1, 1, expect.closeTo(0.8, 6), expect.closeTo(0.68, 6)]);
  });

  it('subtracts Ground and adds Level per height level', () => {
    const lighting = { ...XMP_LIGHTING, ground: 0.05, level: 0.008 };
    const out = engineCellLight(flatGrid(2, 2, 4), lighting, []);
    // I = 1000 + 8 * 4 - 50 = 982, M = 1000.
    expect(out.intensity[0]).toBeCloseTo(0.982, 6);
  });

  it('clamps at 2000, at 0 for negative lights, and blacks out a zero tint', () => {
    const bright = engineCellLight(grid, XMP_LIGHTING, [lampAt(5, 5, { intensity: 2, tint: [2, 2, 2] })]);
    expect(bright.intensity[5 * 24 + 5]).toBe(2);
    const neg = engineCellLight(grid, XMP_LIGHTING, [lampAt(5, 5, { intensity: -1.5, tint: [0, 0, 0] })]);
    expect(neg.intensity[5 * 24 + 5]).toBe(0);
    const black = engineCellLight(grid, { ...XMP_LIGHTING, red: 0, green: 0, blue: 0 }, []);
    expect(black.intensity[0]).toBe(0);
    expect([...black.tint.slice(0, 3)]).toEqual([0, 0, 0]);
  });

  it('leaves missing cells dark', () => {
    const g = flatGrid(2, 1);
    g.exists[1] = 0;
    const out = engineCellLight(g, XMP_LIGHTING, []);
    expect(out.intensity[0]).toBe(1);
    expect(out.intensity[1]).toBe(0);
  });
});

describe('engineLightDelta', () => {
  const grid = flatGrid(24, 24);
  const base = nightBaseAmbient({ nightLevel: DEFAULT_NIGHT_LEVEL });

  it('is zero without lights', () => {
    expect(engineLightDelta(grid, XMP_LIGHTING, [], base).every((v) => v === 0)).toBe(true);
  });

  it('is positive, radially decreasing and symmetric around a warm lamp', () => {
    const d = engineLightDelta(grid, XMP_LIGHTING, [lampAt(12, 12)], base);
    const r = (x: number, y: number) => d[(y * 24 + x) * 3]!;
    expect(r(12, 12)).toBeGreaterThan(0);
    for (let k = 0; k < 10; k++) expect(r(12 + k, 12)).toBeGreaterThanOrEqual(r(13 + k, 12));
    expect(r(12 + 5, 12)).toBeCloseTo(r(12 - 5, 12), 6);
    expect(r(12, 12 + 5)).toBeCloseTo(r(12 - 5, 12), 6);
    const c = (12 * 24 + 12) * 3;
    expect(d[c]!).toBeGreaterThanOrEqual(d[c + 1]!);
    expect(d[c + 1]!).toBeGreaterThanOrEqual(d[c + 2]!);
    expect(r(0, 0)).toBe(0);
  });

  it('keeps the centre and tightens the pool with a falloff power', () => {
    const exact = engineLightDelta(grid, XMP_LIGHTING, [lampAt(12, 12)], base);
    const pool = engineLightDelta(grid, XMP_LIGHTING, [lampAt(12, 12)], base, 2);
    const at = (d: Float32Array, x: number) => d[(12 * 24 + x) * 3]!;
    expect(at(pool, 12)).toBeCloseTo(at(exact, 12), 6);
    for (const x of [15, 18, 22]) expect(at(pool, x)).toBeLessThan(at(exact, x));
    expect(engineLightDelta(grid, XMP_LIGHTING, [lampAt(12, 12)], base, 1)).toEqual(exact);
  });
});

describe('mapAtmosphere', () => {
  const L = (ambient: number, red: number, green: number, blue: number, ground = 0, level = 0) => ({
    ambient,
    red,
    green,
    blue,
    ground,
    level,
  });

  it('classifies stock lighting', () => {
    expect(mapAtmosphere(L(1, 1, 0.8, 0.68), 2)).toMatchObject({ kind: 'day', hour: 12 });
    expect(mapAtmosphere(L(0.9, 1, 0.9, 0.9, 0.05, 0.008), 4)).toMatchObject({ kind: 'day' });
    const night = mapAtmosphere(L(0.6, 1, 1, 1, 0, 0.039), 2);
    expect(night).toMatchObject({ kind: 'night', hour: 22 });
    expect(night.nightLevel).toBeGreaterThanOrEqual(0.26);
    expect(night.nightLevel).toBeLessThanOrEqual(0.4);
    expect(mapAtmosphere(L(0.68, 0.75, 0.75, 1.2), 0).kind).toBe('night');
    expect(mapAtmosphere(L(0.73, 1, 0.92, 0.8), 0)).toMatchObject({ kind: 'dusk', hour: 18.2 });
    expect(mapAtmosphere(L(0.76, 0.7, 0.7, 1), 0).kind).toBe('night');
    expect(mapAtmosphere(L(0.76, 1, 1, 1), 0).kind).toBe('day');
  });

  it('stages MoonPatr as dim airless daylight regardless of night evidence', () => {
    const lighting = L(0.65, 1, 1, 1.1, 0.05, 0.008);
    const profile = mapAtmosphere(lighting, 3, { lamps: 20 }, 'lunar');
    expect(profile).toMatchObject({ kind: 'day', hour: 12, airless: true, nightLevel: DEFAULT_NIGHT_LEVEL });
    expect(profile.tint).toEqual([1, 1, 1]);
    expect(profile).not.toHaveProperty('exposure');
    expect(mapAtmosphere(lighting, 3).kind).toBe('night');
  });

  it('leaves lunar dimming to the palette grade and preserves staging for every other theater', () => {
    for (const [ambient, height] of [
      [0.05, 0],
      [0.65, 3],
      [2, 10],
    ] as const) {
      expect(mapAtmosphere(L(ambient, 1, 1, 1.1, 0.05, 0.008), height, undefined, 'LUNAR')).toEqual({
        kind: 'day',
        hour: 12,
        airless: true,
        nightLevel: DEFAULT_NIGHT_LEVEL,
        tint: [1, 1, 1],
      });
    }
    const transylv = L(0.6, 0.9, 0.9, 1, 0.05, 0.008);
    expect(mapAtmosphere(transylv, 2, { lamps: 4 }, 'newurban')).toEqual(mapAtmosphere(transylv, 2, { lamps: 4 }));
    expect(mapAtmosphere(transylv, 2, { lamps: 4 }, 'newurban').kind).toBe('night');
    const alamo = mapAtmosphere(XMP_LIGHTING, 2, { lamps: 7 });
    for (const theater of ['temperate', 'snow', 'urban', 'newurban', 'desert']) {
      expect(mapAtmosphere(XMP_LIGHTING, 2, { lamps: 7 }, theater)).toEqual(alamo);
    }
    expect(alamo.kind).toBe('day');
    expect(alamo).not.toHaveProperty('exposure');
    expect(alamo).not.toHaveProperty('airless');
  });

  it('recomputes lunar staging from sidecar theater instead of stale atmosphere', () => {
    const lighting = readEngineLighting(() => undefined);
    lighting.normal = L(0.65, 1, 1, 1.1, 0.05, 0.008);
    const cells = { medianZ: 3, surface: 'AQ==' };
    expect(sidecarAtmosphere({ lighting, cells, lights: [], theater: 'lunar' })).toEqual(
      mapAtmosphere(lighting.normal, 3, undefined, 'lunar'),
    );
    expect(sidecarAtmosphere({ lighting, cells, lights: [] }, 'lunar')).toEqual(
      mapAtmosphere(lighting.normal, 3, undefined, 'lunar'),
    );
    expect(sidecarAtmosphere({ lighting, cells, lights: [] })).toEqual(mapAtmosphere(lighting.normal, 3));
  });

  // The stock night maps listed in docs/remaster/research/yr-scene-lighting.md, with their real [Lighting], median
  // cell height (the extractor's missing-cell fill) and lamp posts (positive InvisibleInGame light sources).
  const NIGHT_MAPS: [name: string, lighting: ReturnType<typeof L>, medianZ: number, lamps: number][] = [
    ['XMP06T2 Urban Rush', L(0.6, 1, 1, 1, 0, 0.039), 4, 8],
    ['XMP13S4 (multimd a6506e58)', L(0.68, 0.75, 0.75, 1.2, 0, 0.028), 5, 8],
    ['amazon.mmx', L(0.68, 0.68, 0.8, 1, 0, 0.029), 6, 5],
    ['sov07tmd.map', L(0.55, 0.4, 0.4, 0.7, 0, 0.003), 2, 12],
    ['Transylv.yro', L(0.6, 0.9, 0.9, 1, 0.05, 0.008), 2, 4],
    ['NOWIMPS', L(0.7, 1, 1, 1, 0.05, 0.008), 0, 20],
    ['XTN01T2', L(0.68, 1, 1, 1, 0, 0.017), 2, 6],
  ];
  it.each(NIGHT_MAPS)('stages %s as night', (_name, lighting, medianZ, lamps) => {
    const profile = mapAtmosphere(lighting, medianZ, { lamps });
    expect(profile).toMatchObject({ kind: 'night', hour: 22 });
    expect(profile.nightLevel).toBeGreaterThanOrEqual(0.26);
    expect(profile.nightLevel).toBeLessThanOrEqual(0.4);
    // Without the lamp evidence they are night maps by their authored ambient alone.
    expect(mapAtmosphere(lighting, medianZ).kind).toBe('night');
  });

  it('stages the cached day maps and warm grades as day or dusk', () => {
    // XMP29U2 "The Alamo" and RiverRam.
    expect(mapAtmosphere(L(1, 1, 0.8, 0.68, 0, 0), 2, { lamps: 7 }).kind).toBe('day');
    expect(mapAtmosphere(L(0.9, 1, 0.9, 0.9, 0.05, 0.008), 1).kind).toBe('day');
    // invasion.mmx: Ambient 0.8 with a yellow grade is a sunny day, not dusk.
    expect(mapAtmosphere(L(0.8, 1, 1, 0.68, 0, 0.028), 3).kind).toBe('day');
    // A warm mid-ambient map stays dusk even with lamp posts (multimd 3f671c70).
    expect(mapAtmosphere(L(0.73, 1, 0.93, 0.75, 0, 0.05), 2, { lamps: 9 }).kind).toBe('dusk');
  });

  it('counts lamp posts as night evidence near the threshold', () => {
    expect(mapAtmosphere(L(0.75, 1, 1, 1), 1).kind).toBe('day');
    expect(mapAtmosphere(L(0.75, 1, 1, 1), 1, { lamps: 4 }).kind).toBe('night');
    expect(mapAtmosphere(L(0.8, 1, 1, 1), 1, { lamps: 12 }).kind).toBe('day');
    expect(
      nightEvidence([
        { intensity: 0.5, invisible: true },
        { intensity: -0.15, invisible: true },
        { intensity: 0.4, invisible: false },
      ]),
    ).toEqual({ lamps: 1 });
  });

  it('anchors a typical stock night at 30 % of noon and inverts it', () => {
    expect(engineToLinear(0.62)).toBeCloseTo(0.3, 9);
    expect(nightBaseAmbient({ nightLevel: 0.3 })).toBeCloseTo(0.62, 9);
    expect(engineToLinear(nightBaseAmbient({ nightLevel: 0.36 }))).toBeCloseTo(0.36, 9);
    expect(mapAtmosphere(L(1, 1, 0.8, 0.68), 0).tint).toEqual([1, 0.8, 0.68]);
  });

  it('keeps night readable with clamps', () => {
    expect(mapAtmosphere(L(0.3, 1, 1, 1), 0).nightLevel).toBe(0.26);
  });
});

describe('spriteClassGradeExempt', () => {
  it('exempts only the ore class from the airless map grade', () => {
    const profile = mapAtmosphere(
      { ambient: 0.65, red: 1, green: 1, blue: 1.1, ground: 0.05, level: 0.008 },
      3,
      undefined,
      'lunar',
    );
    expect(spriteClassGradeExempt(profile, 'ore')).toBe(true);
    for (const spriteClass of ['ground', 'overlay', 'smudge', 'building', 'infantry', 'unit']) {
      expect(spriteClassGradeExempt(profile, spriteClass)).toBe(false);
    }
  });

  it('leaves all classes on ordinary day/night profiles subject to the map grade', () => {
    for (const profile of [
      mapAtmosphere(XMP_LIGHTING, 2),
      mapAtmosphere({ ...XMP_LIGHTING, ambient: 0.6 }, 2),
      { airless: false },
    ]) {
      for (const spriteClass of ['ore', 'ground', 'overlay', 'smudge', 'building', 'infantry', 'unit']) {
        expect(spriteClassGradeExempt(profile, spriteClass)).toBe(false);
      }
    }
  });
});

describe('surfaces', () => {
  it('classifies land types with the probed tile colours', () => {
    expect(classifyTileSurface(9, [66, 69, 90])).toBe(SURFACE.water);
    expect(classifyTileSurface(15, [159, 140, 71])).toBe(SURFACE.rock);
    expect(classifyTileSurface(11, [81, 83, 82])).toBe(SURFACE.road);
    expect(classifyTileSurface(12, [123, 119, 110])).toBe(SURFACE.road);
    // XMP29U2: brick and concrete at 13, grey asphalt lots at 14, lawns at 13/14.
    expect(classifyTileSurface(13, [155, 99, 74])).toBe(SURFACE.paved);
    expect(classifyTileSurface(13, [185, 178, 162])).toBe(SURFACE.paved);
    expect(classifyTileSurface(14, [60, 62, 65])).toBe(SURFACE.paved);
    expect(classifyTileSurface(13, [108, 131, 60])).toBe(SURFACE.soft);
    expect(classifyTileSurface(14, [108, 131, 61])).toBe(SURFACE.soft);
    // RiverRam: yellow-green grass at 13, sand and dirt at 14, beach at 10.
    expect(classifyTileSurface(13, [145, 153, 66])).toBe(SURFACE.soft);
    expect(classifyTileSurface(13, [158, 148, 73])).toBe(SURFACE.soft);
    expect(classifyTileSurface(14, [216, 186, 124])).toBe(SURFACE.soft);
    expect(classifyTileSurface(10, [98, 106, 96])).toBe(SURFACE.soft);
    expect(classifyTileSurface(0, null)).toBe(SURFACE.soft);
    expect(classifyTileSurface(13, null)).toBe(SURFACE.paved);
  });

  it('falls back to land types by theater', () => {
    const cells = { width: 3, height: 1, exists: Uint8Array.of(1, 1, 0), tile: Uint16Array.of(0, 1, 0) };
    const tiles = [{ terrainType: 13 }, { terrainType: 11 }];
    expect([...surfaceFromLandType(cells, tiles, 'urban')]).toEqual([SURFACE.paved, SURFACE.road, SURFACE.none]);
    expect([...surfaceFromLandType(cells, tiles, 'temperate')]).toEqual([SURFACE.soft, SURFACE.road, SURFACE.none]);
  });

  it('takes the median height of existing cells', () => {
    expect(medianHeight(Uint8Array.of(0, 2, 2, 9, 4), Uint8Array.of(1, 1, 1, 0, 1))).toBe(2);
  });
});

describe('placeStreetLamps', () => {
  const N = 24;
  const make = () => {
    const surface = new Uint8Array(N * N).fill(SURFACE.soft);
    for (let i = 0; i < N; i++) {
      surface[12 * N + i] = SURFACE.road;
      surface[i * N + 12] = SURFACE.road;
    }
    // A pond and a rock next to the road never get lamps.
    surface[11 * N + 3] = SURFACE.water;
    surface[13 * N + 20] = SURFACE.rock;
    const blocked = new Uint8Array(N * N);
    for (let y = 2; y < 6; y++) for (let x = 13; x < 18; x++) blocked[y * N + x] = 1;
    return { width: N, height: N, exists: new Uint8Array(N * N).fill(1), surface, blocked, seed: 7 };
  };

  it('is deterministic and keeps its spacing along the roads', () => {
    const input = make();
    const a = placeStreetLamps(input);
    expect(placeStreetLamps(make())).toEqual(a);
    expect(a.length).toBeGreaterThan(6);
    for (const [x, y] of a) {
      const c = y * N + x;
      expect(input.surface[c]).not.toBe(SURFACE.road);
      expect(input.surface[c]).not.toBe(SURFACE.water);
      expect(input.surface[c]).not.toBe(SURFACE.rock);
      expect(input.blocked[c]).toBe(0);
      expect(x === 11 || x === 13 || y === 11 || y === 13).toBe(true);
    }
    for (let i = 0; i < a.length; i++)
      for (let j = i + 1; j < a.length; j++)
        expect(Math.hypot(a[i]![0] - a[j]![0], a[i]![1] - a[j]![1])).toBeGreaterThanOrEqual(4.5);
    expect(placeStreetLamps({ ...make(), seed: 8 })).not.toEqual(a);
  });

  it('respects bounds', () => {
    const lamps = placeStreetLamps({ ...make(), bounds: (x, y) => x < 12 && y < 12 });
    expect(lamps.length).toBeGreaterThan(0);
    for (const [x, y] of lamps) expect(x < 12 && y < 12).toBe(true);
  });
});

describe('validateMapLights', () => {
  const minimal = {
    version: MAP_LIGHTS_VERSION,
    lighting: { normal: XMP_LIGHTING },
    atmosphere: {},
    lights: [],
    cells: { surface: '' + 'AA==' },
    hiddenObjects: [],
    types: {},
    hdEmitters: { streetLamps: [] },
  };

  it('accepts the current version and rejects others', () => {
    expect(validateMapLights(minimal)).toBe(minimal);
    expect(() => validateMapLights({ ...minimal, version: 2 })).toThrow(/version 2/);
    expect(() => validateMapLights(null)).toThrow();
    expect(() => validateMapLights({ version: 1 })).toThrow(/missing/);
  });
});
