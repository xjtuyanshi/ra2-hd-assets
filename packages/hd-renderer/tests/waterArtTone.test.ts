import { afterEach, describe, expect, it, vi } from 'vitest';
import { Color, DataTexture, Vector3, type Material } from 'three/webgpu';
import { float, vec3 } from 'three/tsl';
import { mapAtmosphere } from '../../ra2-assets/src/lights';
import { AtmosphereNodes } from '../src/atmosphere';
import type { AtmosphereProfile } from '../src/contract';
import { HdRenderer } from '../src/HdRenderer';
import type { Lighting } from '../src/lighting';
import { NO_TILE, type Ra2Cache } from '../src/ra2/cache';
import { buildRa2Terrain } from '../src/ra2/terrain';
import * as waterLook from '../src/ra2/waterLook';
import { waterPreset, type WaterStyle } from '../src/ra2/waterLook';
import type { ShaderNode } from '../src/tsl';
import { createWaterUniforms } from '../src/waterShading';
import { buildRain, buildSnow } from '../src/weather';
import { createScenario } from '../sandbox/scenario';

const originalStyle = waterPreset.style;
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  waterPreset.style = originalStyle;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('which maps keep their painted water tone', () => {
  // [Lighting] of the stock maps the classes were tuned on: a sunny day map, the warm dusk of "El Dorado"
  // (Ambient 0.73, tint 1 / 0.92 / 0.8) and a blue night map.
  const maps: [string, AtmosphereProfile, number][] = [
    ['day', mapAtmosphere({ ambient: 0.9, red: 1, green: 0.9, blue: 0.9, ground: 0.05, level: 0.008 }, 2), 0],
    ['dusk', mapAtmosphere({ ambient: 0.73, red: 1, green: 0.92, blue: 0.8, ground: 0, level: 0.035 }, 4), 1],
    ['night', mapAtmosphere({ ambient: 0.6, red: 0.8, green: 0.85, blue: 1.1, ground: 0, level: 0.03 }, 4), 1],
  ];

  it.each(maps)('a %s map', (kind, profile, expected) => {
    expect(profile.kind).toBe(kind);
    vi.stubGlobal('window', { devicePixelRatio: 1 });
    const canvas = { width: 1, height: 1, style: {}, addEventListener() {}, removeEventListener() {} };
    const state = createScenario(2, 2);
    state.map.atmosphere = profile;
    const hd = new HdRenderer(canvas as unknown as HTMLCanvasElement, state);
    const water = createWaterUniforms();
    expect(water.artTone.value).toBe(0); // A look draws its own water unless the renderer says otherwise.
    water.artTone.value = 1 - expected; // Start from the opposite, so the frame has to set it.
    const height = new DataTexture();
    const sprites = {
      light: { value: new Color() },
      cameraRight: { value: new Vector3() },
      cameraUp: { value: new Vector3() },
      toCamera: { value: new Vector3() },
    };
    // The complete CPU frame path; the GPU operations are stubs (as in lightingAirless.test.ts).
    Object.assign(hd, {
      world: { mapLight: null, sprites },
      terrain: { wetness: { value: 0 } },
      water: { uniforms: water },
      rain: buildRain(2, 2, height, 0, hd.nodes),
      snow: buildSnow(2, 2, height, 0, hd.nodes),
      lightField: { update: vi.fn(), dynamicLights: () => [] },
      renderPipeline: vi.fn(),
    });
    const internals = hd as unknown as { lighting: Lighting; noonIrradiance: Color };
    internals.lighting.update(12, 0);
    internals.lighting.flatIrradianceColor(internals.noonIrradiance);
    hd.frame(0);
    expect(water.artTone.value).toBe(expected);
    // The dusk staging itself has no night share: without the art tone its water was drawn as full daylight water.
    if (kind === 'dusk') expect(hd.nodes.night.value).toBe(0);
  });
});

/** A one-level map with open water and whole-map art; `waterBed` selects the painted lake-bed path. */
function terrain(style: WaterStyle, waterBed: boolean) {
  waterPreset.style = style;
  const width = 14;
  const exists = new Uint8Array(width).fill(1);
  const pixel = () => new DataTexture(new Uint8Array([32, 64, 96, 255]), 1, 1);
  const textures = { art: pixel(), mask: pixel(), shore: pixel(), detail: pixel() };
  const nodes = new AtmosphereNodes();
  const cache = {
    nodes,
    exists,
    height: new Uint8Array(width),
    tile: new Uint16Array(width).fill(0),
    mapLight: null,
    manifest: {
      grid: { width, height: 1 },
      tiles: [{ terrainType: 9, rampType: 0, file: 'water01.tem', rect: [0, 0, 1, 1], anchor: [0, 0] }],
    },
    terrainMap: {
      texture: textures.art,
      waterMask: textures.mask,
      shore: textures.shore,
      cliff: null,
      waterBed,
      waterDetail: waterBed ? textures.detail : null,
      waterSurface: null,
      ref: { file: 'terrain.png', width: 128, height: 64, scale: 1, originX: 0, originY: 0 },
    },
  } as unknown as Ra2Cache;
  void NO_TILE;
  const build = buildRa2Terrain(cache);
  cleanups.push(() => {
    build.mirrorAtlas?.dispose();
    for (const material of build.mesh.material as Material[]) material.dispose();
    build.mesh.geometry.dispose();
    build.heightTexture.dispose();
    for (const texture of Object.values(textures)) texture.dispose();
    nodes.dispose();
  });
  const ground = (build.mesh.material as unknown as { emissiveNode: ShaderNode }[])[0]!;
  const reached = new Set<ShaderNode>();
  const visit = (node: ShaderNode) => {
    if (!node || reached.has(node)) return;
    reached.add(node);
    for (const child of node.getChildren()) visit(child);
  };
  visit(ground.emissiveNode);
  return { build, reached };
}

describe('painted water tone in the terrain material', () => {
  it.each(['enhanced', 'classic'] as const)(
    'gives the water albedo and its reflected light to the art tone on maps with painted water (%s look)',
    (style) => {
      const body = vi.spyOn(waterLook, 'tonedWaterBody');
      const relief = vi.spyOn(waterLook, 'artToneContactRelief');
      const { build, reached } = terrain(style, false);
      const tone = build.water.artTone;
      // Cliff-foot contact shading is relieved by the same tone, measured from the painted mask's own edge.
      expect(relief).toHaveBeenCalledTimes(1);
      expect(relief.mock.calls[0]![1]).toBe(tone);
      expect(reached.has(relief.mock.results[0]!.value)).toBe(true);
      // Albedo: the look's body against the painted water, by the renderer-driven tone.
      expect(body).toHaveBeenCalledTimes(1);
      expect(body.mock.calls[0]![2]).toBe(tone);
      expect(body.mock.calls[0]![0]).not.toBe(body.mock.calls[0]![1]);
      // Reflected light: the look's emission reaches the same uniform (tonedReflection and its foam mask).
      expect(reached.has(tone)).toBe(true);
    },
  );

  it('leaves the painted lake bed alone: its composite has no painted water to fall back to', () => {
    const body = vi.spyOn(waterLook, 'tonedWaterBody');
    const relief = vi.spyOn(waterLook, 'artToneContactRelief');
    const { build, reached } = terrain('enhanced', true);
    expect(body).not.toHaveBeenCalled();
    expect(relief).not.toHaveBeenCalled();
    expect(reached.has(build.water.artTone)).toBe(false);
  });

  it('builds both mixes from the tone, the look and the painted colour only', () => {
    const inputsOf = (node: ShaderNode) => {
      const inputs = new Set<ShaderNode>();
      const visit = (n: ShaderNode) => {
        if (inputs.has(n)) return;
        inputs.add(n);
        for (const child of n.getChildren()) visit(child);
      };
      visit(node);
      return inputs;
    };
    const look = vec3(0.1, 0.4, 0.5);
    const painted = vec3(0.02, 0.02, 0.03);
    const tone = float(0);
    const body = inputsOf(waterLook.tonedWaterBody(look, painted, tone));
    for (const input of [look, painted, tone]) expect(body.has(input)).toBe(true);
    const reflected = vec3(0.2, 0.3, 0.4);
    const depth = float(2);
    const toned = inputsOf(waterLook.tonedReflection(reflected, look, painted, tone, depth));
    for (const input of [reflected, look, painted, tone, depth]) expect(toned.has(input)).toBe(true);
    const shore = float(-1);
    const relief = inputsOf(waterLook.artToneContactRelief(shore, tone));
    for (const input of [shore, tone]) expect(relief.has(input)).toBe(true);
    // The relief covers the water and the cliff-foot cell beyond the mask, and is gone a cell further inland.
    expect(waterLook.ART_TONE_CONTACT.near).toBeLessThanOrEqual(-1);
    expect(waterLook.ART_TONE_CONTACT.far).toBeLessThan(waterLook.ART_TONE_CONTACT.near);
    // The added light starts inside the water mask, not at its (cell-stepped) edge.
    expect(waterLook.ART_TONE_SHORE.near).toBeGreaterThan(0);
    expect(waterLook.ART_TONE_SHORE.far).toBeGreaterThan(waterLook.ART_TONE_SHORE.near);
    // The share of the painted colour a reflection may add stays small: dusk and night water is near-black.
    expect(waterLook.ART_TONE_REFLECTION).toBeGreaterThan(0);
    expect(waterLook.ART_TONE_REFLECTION).toBeLessThanOrEqual(0.15);
  });
});
