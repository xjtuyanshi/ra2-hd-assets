import { afterEach, describe, expect, it, vi } from 'vitest';
import { PlaneGeometry } from 'three/webgpu';
import { HdRenderer, applyLookPreset, LOOK_PRESETS } from '../src/HdRenderer';
import { AtmosphereNodes } from '../src/atmosphere';
import { Lighting } from '../src/lighting';
import {
  ART_LIGHT_ELEVATION,
  MAX_SHADOW_STRETCH,
  relightFactorUpper,
  shadowStretch,
  spriteLookFor,
} from '../src/ra2/spriteLook';
import {
  ENGINE_SHADOW_OPACITY,
  VoxelShadowMesh,
  VoxelWaterMesh,
  voxelShadowMaterial,
  voxelWaterMaterial,
} from '../src/ra2/voxelShadow';
import { instantiateVoxel } from '../src/ra2/voxels';
import { voxelMaterialFor } from '../src/ra2/vpl';
import { createScenario } from '../sandbox/scenario';

const neutral = { sunGain: 1, specularSize: 1, aoPower: 1, contactShade: 1, shadowLength: 1, shadowDarkness: 1 };
const cinematic = {
  sunGain: 1.25,
  specularSize: 1.6,
  aoPower: 1.5,
  contactShade: 1.5,
  shadowLength: 1.4,
  shadowDarkness: 1.15,
};
const shaderGains = ['sunGain', 'specularSize', 'aoPower', 'contactShade', 'shadowLength', 'shadowDarkness'] as const;

/** No backend initialization or draws: exercise only the renderer's per-frame CPU uniform update. */
function headlessRenderer(): HdRenderer {
  vi.stubGlobal('window', { devicePixelRatio: 1 });
  const canvas = {
    width: 1,
    height: 1,
    style: {},
    addEventListener() {},
    removeEventListener() {},
  } as unknown as HTMLCanvasElement;
  return new HdRenderer(canvas, createScenario(2, 2));
}

type LookUpdater = { lighting: Lighting; updateSpriteLook(scale: number, wetness: number): void };
afterEach(() => vi.unstubAllGlobals());

describe('lighting depth presets', () => {
  it('defaults to neutral numeric gains and restores all of them when leaving cinematic', () => {
    const hd = headlessRenderer();
    try {
      expect(hd.settings).toMatchObject(neutral);
      for (const preset of ['faithful', 'golden'] as const) {
        expect(LOOK_PRESETS[preset].settings).toMatchObject(neutral);
        applyLookPreset(hd.settings, 'cinematic');
        expect(hd.settings).toMatchObject(cinematic);
        applyLookPreset(hd.settings, preset);
        expect(hd.settings).toMatchObject(neutral);
      }
      expect(LOOK_PRESETS.cinematic.settings).toMatchObject(cinematic);
      for (const key of Object.keys(neutral) as (keyof typeof neutral)[])
        expect(typeof hd.settings[key]).toBe('number');
    } finally {
      hd.nodes.dispose();
    }
  });
});

describe('lighting depth CPU maths', () => {
  it('widens only the upper relight bound proportionally to sun gain', () => {
    for (const gain of [0, 0.5, 1]) expect(relightFactorUpper(gain)).toBe(2.4);
    expect(relightFactorUpper(1.25)).toBe(3);
    expect(relightFactorUpper(2)).toBe(4.8);
  });

  it('preserves the original stretch exactly at neutral length, including elevation floor and cap', () => {
    for (const keyElevation of [-5, 0, 12, 18, 28, 38, 60, 90]) {
      const expected = Math.min(
        2,
        Math.max(
          0.75,
          Math.tan((ART_LIGHT_ELEVATION * Math.PI) / 180) / Math.tan((Math.max(12, keyElevation) * Math.PI) / 180),
        ),
      );
      expect(shadowStretch(keyElevation)).toBe(expected);
      expect(shadowStretch(keyElevation, 1)).toBe(expected);
      for (const length of [0.5, 1.4, 2]) {
        expect(shadowStretch(keyElevation, length)).toBe(expected * length);
        expect(shadowStretch(keyElevation, length)).toBeLessThanOrEqual(MAX_SHADOW_STRETCH * length);
      }
    }
    expect(shadowStretch(12, 1.4)).toBe(2.8);
  });
});

describe('lighting depth frame uniforms', () => {
  it('reads edits every frame without applySettings, preserves sky weight and resets faithful gains', () => {
    const hd = headlessRenderer();
    const frame = hd as unknown as LookUpdater;
    const look = spriteLookFor(hd.nodes);
    try {
      applyLookPreset(hd.settings, 'golden');
      frame.lighting.sunArc = true;
      frame.lighting.update(15, 0);
      frame.updateSpriteLook(1, 0);
      const sun = look.sunWeight.value.clone();
      const sky = look.skyWeight.value.toArray();
      const matrix = look.shadowMatrix.value.clone();
      const determinant = (m: typeof matrix) => Math.abs(m.x * m.w - m.z * m.y);
      const uniforms = shaderGains.map((key) => look[key]);
      Object.assign(hd.settings, cinematic);
      frame.updateSpriteLook(1, 0);
      expect(look.sunWeight.value.toArray()).toEqual(sun.clone().multiplyScalar(1.25).toArray());
      expect(look.skyWeight.value.toArray()).toEqual(sky);
      expect(look.factorUpper.value).toBe(3);
      expect(determinant(look.shadowMatrix.value) / determinant(matrix)).toBeCloseTo(1.4, 12);
      shaderGains.forEach((key, i) => {
        expect(look[key]).toBe(uniforms[i]);
        expect(look[key].value).toBe(cinematic[key]);
      });
      hd.settings.sunGain = 2;
      frame.updateSpriteLook(1, 0);
      expect(look.factorUpper.value).toBe(4.8);
      expect(look.sunWeight.value.toArray()).toEqual(sun.clone().multiplyScalar(2).toArray());
      hd.settings.shadowFollow = 0;
      frame.updateSpriteLook(1, 0);
      expect(look.shadowMatrix.value.toArray()).toEqual([1, 0, 0, 1]);
      applyLookPreset(hd.settings, 'faithful');
      // Gains alone never enable the enhanced branch or change faithful voxel/terrain light.
      Object.assign(hd.settings, cinematic);
      frame.updateSpriteLook(1, 0);
      expect(look.enabled.value).toBe(0);
      shaderGains.forEach((key) => expect(look[key].value).toBe(1));
    } finally {
      hd.nodes.dispose();
    }
  });

  it('restores the exact golden sun weight and shadow matrix after non-neutral edits', () => {
    const hd = headlessRenderer();
    const frame = hd as unknown as LookUpdater;
    try {
      applyLookPreset(hd.settings, 'golden');
      frame.lighting.sunArc = true;
      frame.lighting.update(16.5, 0);
      frame.updateSpriteLook(1, 0);
      const look = spriteLookFor(hd.nodes);
      const before = [look.sunWeight.value.toArray(), look.shadowMatrix.value.toArray()];
      applyLookPreset(hd.settings, 'cinematic');
      frame.updateSpriteLook(1, 0);
      applyLookPreset(hd.settings, 'golden');
      frame.updateSpriteLook(1, 0);
      expect([look.sunWeight.value.toArray(), look.shadowMatrix.value.toArray()]).toEqual(before);
    } finally {
      hd.nodes.dispose();
    }
  });
});

describe('voxel shadow context ownership', () => {
  it('shares within a renderer, binds placed twins to it and disposes the material once', () => {
    const a = new AtmosphereNodes();
    const b = new AtmosphereNodes();
    const shadow = voxelShadowMaterial(a);
    const dispose = vi.spyOn(shadow, 'dispose');
    const geometry = new PlaneGeometry();
    expect(voxelShadowMaterial(a)).toBe(shadow);
    expect(voxelShadowMaterial(b)).not.toBe(shadow);
    expect(shadow.opacity).toBe(ENGINE_SHADOW_OPACITY);
    expect(shadow.opacityNode).toBeTruthy();
    const material = voxelMaterialFor(null, a);
    const unit = instantiateVoxel([{ role: 'body', turretOffset: 0, geometry }], material, a);
    const twins = unit.root.children.filter((o): o is VoxelShadowMesh => o instanceof VoxelShadowMesh);
    expect(twins.every((t) => t.material === shadow)).toBe(true);
    const waterDisposals = (['foam', 'reflection'] as const).map((layer) => {
      const waterMaterial = voxelWaterMaterial(a, layer, material);
      const water = unit.root.children.filter(
        (o): o is VoxelWaterMesh => o instanceof VoxelWaterMesh && o.layer === layer,
      );
      expect(water.length).toBe(layer === 'foam' ? 5 : 1);
      expect(water.every((t) => t.material === waterMaterial && t.geometry === geometry)).toBe(true);
      expect(waterMaterial.forceSinglePass).toBe(true);
      expect(voxelWaterMaterial(b, layer, material)).not.toBe(waterMaterial);
      return vi.spyOn(waterMaterial, 'dispose');
    });
    spriteLookFor(a).shadowDarkness.value = 1.15;
    expect(spriteLookFor(b).shadowDarkness.value).toBe(1);
    a.dispose();
    a.dispose();
    b.dispose();
    geometry.dispose();
    expect(dispose).toHaveBeenCalledOnce();
    waterDisposals.forEach((dispose) => expect(dispose).toHaveBeenCalledOnce());
  });
});
