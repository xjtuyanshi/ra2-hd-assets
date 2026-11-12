import { describe, expect, it, vi } from 'vitest';
import { DataTexture, FloatType, NearestFilter, RedFormat, UnsignedByteType } from 'three/webgpu';
import { LiveView, type LiveObject } from '../src/live/liveView';
import type { RenderEnvironment } from '../src/contract';
import { AtmosphereNodes } from '../src/atmosphere';
import type { Ra2Cache } from '../src/ra2/cache';
import { buildRa2Terrain } from '../src/ra2/terrain';
import { steepWeatherCells, WeatherGroundMask } from '../src/weatherGroundMask';
import { LEVEL_HEIGHT } from '../src/world';

function blocked(mask: WeatherGroundMask): number[] {
  return [...(mask.texture.image.data as Uint8Array)].flatMap((value, index) => (value ? [index] : []));
}

describe('weather ground mask', () => {
  it('uses one nearest-filtered R8 texel per cell and marks only complete foundation cells', () => {
    const mask = new WeatherGroundMask(6, 5);
    expect(mask.texture.image.width).toBe(6);
    expect(mask.texture.image.height).toBe(5);
    expect(mask.texture.format).toBe(RedFormat);
    expect(mask.texture.type).toBe(UnsignedByteType);
    expect(mask.texture.minFilter).toBe(NearestFilter);
    expect(mask.texture.magFilter).toBe(NearestFilter);
    expect(mask.updateFoundations([{ x: 1, z: 2, width: 3, height: 2 }])).toBe(true);
    expect(blocked(mask)).toEqual([13, 14, 15, 19, 20, 21]);
    expect(new Set(mask.texture.image.data)).toEqual(new Set([0, 255]));
    mask.dispose();
  });

  it('clears removed buildings while retaining static cliffs and overlapping foundations', () => {
    const cliff = new Uint8Array(20);
    cliff[0] = 255;
    const mask = new WeatherGroundMask(5, 4, cliff);
    const first = { x: 1, z: 1, width: 2, height: 2 };
    const second = { x: 2, z: 2, width: 2, height: 1 };
    mask.updateFoundations([first, second]);
    expect(blocked(mask)).toEqual([0, 6, 7, 11, 12, 13]);
    mask.updateFoundations([second]);
    expect(blocked(mask)).toEqual([0, 12, 13]);
    mask.updateFoundations([]);
    expect(blocked(mask)).toEqual([0]);
    mask.dispose();
  });

  it('does not request another GPU upload for unchanged, reordered or equivalent coverage', () => {
    const mask = new WeatherGroundMask(4, 4);
    const first = { x: 0, z: 0, width: 2, height: 1 };
    const second = { x: 2, z: 3, width: 1, height: 1 };
    mask.updateFoundations([first, second]);
    // Three's needsUpdate property is write-only. Its version and setter calls expose actual upload requests.
    mask.texture.needsUpdate = false;
    const version = mask.texture.version;
    const upload = vi.spyOn(mask.texture, 'needsUpdate', 'set');
    expect(mask.updateFoundations([{ ...first }, { ...second }])).toBe(false);
    expect(mask.updateFoundations([second, first])).toBe(false);
    expect(mask.updateFoundations([second, first, { x: 0, z: 0, width: 1, height: 1 }])).toBe(false);
    expect(upload).not.toHaveBeenCalled();
    expect(mask.texture.version).toBe(version);
    mask.dispose();
  });

  it('clips edge foundations without wrapping their cells into adjacent rows', () => {
    const mask = new WeatherGroundMask(4, 3);
    mask.updateFoundations([
      { x: -1, z: 1, width: 2, height: 3 },
      { x: 3, z: -1, width: 3, height: 2 },
      { x: -4, z: 2, width: 1, height: 1 },
      { x: 7, z: 1, width: 1, height: 1 },
    ]);
    expect(blocked(mask)).toEqual([3, 4, 8]);
    mask.dispose();
  });

  it('starts with an empty mask when no world terrain was supplied', () => {
    const mask = new WeatherGroundMask(4, 3);
    expect(blocked(mask)).toEqual([]);
    expect(mask.updateFoundations([])).toBe(false);
    const dispose = vi.spyOn(mask.texture, 'dispose');
    mask.dispose();
    expect(dispose).toHaveBeenCalledOnce();
  });
});

describe('static weather terrain exclusions', () => {
  it('preserves flat ground and gradual ramps in a subdivided corner grid', () => {
    const values = Float32Array.from({ length: 9 * 5 }, (_, i) => (i % 9) * 0.2);
    const texture = new DataTexture(values, 9, 5, RedFormat, FloatType);
    expect([...steepWeatherCells(4, 2, texture, 0.6)]).toEqual(new Array(8).fill(0));
    texture.dispose();
  });

  it('excludes both cells next to a cliff step, leaving distant plateau cells available', () => {
    const values = Float32Array.from({ length: 9 * 5 }, (_, i) => (i % 9 >= 4 ? 2 : 0));
    const texture = new DataTexture(values, 9, 5, RedFormat, FloatType);
    expect([...steepWeatherCells(4, 2, texture, 0.6)]).toEqual([0, 255, 255, 0, 0, 255, 255, 0]);
    texture.dispose();
  });

  it('also catches discontinuities in a one-height-per-cell texture on both axes', () => {
    const texture = new DataTexture(new Float32Array([0, 0, 0, 2]), 2, 2, RedFormat, FloatType);
    expect([...steepWeatherCells(2, 2, texture, 0.6)]).toEqual([0, 255, 255, 255]);
    texture.dispose();
  });

  it.each([false, true])('uses the actual map terrain corner grid for a ramp=%s height transition', (ramp) => {
    const nodes = new AtmosphereNodes();
    const texture = new DataTexture(new Uint8Array([128, 128, 128, 255]), 1, 1);
    const cache = {
      nodes,
      exists: new Uint8Array(4).fill(1),
      height: new Uint8Array([0, 0, 1, 1]),
      tile: new Uint16Array([0, ramp ? 1 : 0, 0, 0]),
      manifest: {
        grid: { width: 4, height: 1 },
        tiles: [0, 1].map((rampType) => ({
          terrainType: 0,
          file: 'ground.tem',
          rampType,
          rect: [0, 0, 1, 1],
          anchor: [0, 0],
        })),
      },
      terrainMap: {
        texture,
        waterMask: texture,
        shore: texture,
        cliff: null,
        waterBed: false,
        waterDetail: null,
        waterSurface: null,
        ref: { width: 128, height: 64, scale: 1, originX: 0, originY: 0 },
      },
    } as unknown as Ra2Cache;
    const terrain = buildRa2Terrain(cache);
    try {
      expect([...steepWeatherCells(4, 1, terrain.heightTexture, LEVEL_HEIGHT * 1.5)]).toEqual(
        ramp ? [0, 0, 0, 0] : [0, 255, 255, 0],
      );
    } finally {
      terrain.mesh.geometry.dispose();
      for (const material of Array.isArray(terrain.mesh.material) ? terrain.mesh.material : [terrain.mesh.material])
        material.dispose();
      terrain.heightTexture.dispose();
      texture.dispose();
      nodes.dispose();
    }
  });
});

describe('live weather foundations and runtime changes', () => {
  it('uses live resolved foundations, refreshes late art, excludes invisible types and clears removals', () => {
    const mask = new WeatherGroundMask(6, 5);
    const building = { uid: 1, kind: 'building', type: 'VISIBLE', owner: 0, x: 384, y: 640 } as LiveObject;
    const hidden = { ...building, uid: 2, type: 'HIDDEN', x: 0, y: 0 };
    const library = { foundation: [2, 1] };
    const visuals = new Map([
      [1, { libraryType: library }],
      [2, { libraryType: { foundation: [2, 2], invisible: true } }],
    ]);
    const state = {
      hd: { weatherGroundMask: mask },
      cache: { manifest: { sprites: {} } },
      houseColour: new Map(),
      visualFor: (object: LiveObject) => visuals.get(object.uid),
    };
    const view = Object.assign(Object.create(LiveView.prototype), state) as {
      updateFoundations(objects: readonly LiveObject[], frame: number): void;
    };
    view.updateFoundations([building, hidden], 1);
    expect(blocked(mask)).toEqual([13, 14]);
    const version = mask.texture.version;
    view.updateFoundations([{ ...building, health: 0.5 }, hidden], 2);
    expect(mask.texture.version).toBe(version);
    // A library/art revision can resolve a larger footprint without another game snapshot.
    library.foundation = [3, 2];
    view.updateFoundations([building, hidden], 2);
    expect(blocked(mask)).toEqual([13, 14, 15, 19, 20, 21]);
    view.updateFoundations([], 3);
    expect(blocked(mask)).toEqual([]);
    mask.dispose();
  });

  it('accepts snow through the existing runtime environment path', () => {
    const environment: RenderEnvironment = {
      timeOfDay: 12,
      weather: 'rain',
      weatherIntensity: 0.8,
      windDirection: 0.6,
      windStrength: 0.3,
    };
    const view = Object.assign(Object.create(LiveView.prototype), {
      state: { environment },
      hd: { atmosphere: {} },
    }) as LiveView;
    view.setEnvironment({ weather: 'snow', weatherIntensity: 0.65 });
    expect(environment.weather).toBe('snow');
    expect(environment.weatherIntensity).toBe(0.65);
    view.setEnvironment({ weather: 'clear', weatherIntensity: 0 });
    expect(environment.weather).toBe('clear');
    expect(environment.weatherIntensity).toBe(0);
  });

  it('uses light-sidecar foundations before art resolves without changing infantry occlusion', () => {
    const mask = new WeatherGroundMask(6, 5);
    const building = { kind: 'building', type: 'PENDING', owner: 0, x: 384, y: 640 } as LiveObject;
    // Occlusion no longer reads a foundation index (the native building depth model replaced it); the only
    // foundation-derived depth state left is the refinery cell set, which weather footprints must not touch.
    const refineryCells = new Set<string>();
    const view = Object.assign(Object.create(LiveView.prototype), {
      hd: { weatherGroundMask: mask },
      cache: {
        manifest: { sprites: {} },
        lights: { types: { PENDING: { foundation: [3, 2] }, HIDDEN: { foundation: [2, 2], invisible: true } } },
      },
      houseColour: new Map(),
      visualFor: () => ({}),
      refineryCells,
    }) as {
      refineryCells: Set<string>;
      updateFoundations(objects: readonly LiveObject[], frame: number): void;
    };
    view.updateFoundations([building, { ...building, type: 'HIDDEN', x: 0, y: 0 }], 1);
    expect(blocked(mask)).toEqual([13, 14, 15, 19, 20, 21]);
    expect(view.refineryCells).toBe(refineryCells);
    expect(refineryCells.size).toBe(0);
    expect(view).not.toHaveProperty('foundationIndex');
    view.updateFoundations([], 2);
    expect(blocked(mask)).toEqual([]);
    mask.dispose();
  });
});
