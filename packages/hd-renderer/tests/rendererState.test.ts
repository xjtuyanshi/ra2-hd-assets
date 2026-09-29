import { describe, expect, it, vi } from 'vitest';
import { DataTexture, Vector3 } from 'three/webgpu';
import { AtmosphereNodes, DEFAULT_ATMOSPHERE_NODES } from '../src/atmosphere';
import { LightField, type DynamicLight } from '../src/lightField';
import { Lighting } from '../src/lighting';
import { MapLightGrade, paletteGrade, setPaletteGrade, setPaletteNodes } from '../src/ra2/mapLighting';
import { voxelLightingFor, voxelMaterialFor } from '../src/ra2/vpl';

function grade(ambient: number): MapLightGrade {
  return new MapLightGrade(
    { width: 2, height: 2, z: new Uint8Array(4), exists: new Uint8Array(4).fill(1) },
    { ambient, level: 0, ground: 0, red: 1, green: 0.8, blue: 0.6 },
  );
}

describe('renderer shader state isolation', () => {
  it('keeps texture bindings, dimensions and atmospheric uniforms independent across renderers', () => {
    const a = new AtmosphereNodes();
    const b = new AtmosphereNodes();
    const first = new LightField(2, 3, { nodes: a });
    const second = new LightField(4, 5, { halfFloat: false, nodes: b });
    const surface = new DataTexture(new Uint8Array(4), 1, 1);
    a.surfaceTexture.value = surface;
    a.surfaceSize.value.set(2, 3);
    a.night.value = 1;
    a.sceneLevel.value.setRGB(0.2, 0.3, 0.4);
    a.faithfulDisplay.value = 0;
    expect(a.lightFieldTexture.value).toBe(first.target.texture);
    expect(b.lightFieldTexture.value).toBe(second.target.texture);
    expect(a.lightFieldSize.value.toArray()).toEqual([2, 3]);
    expect(b.lightFieldSize.value.toArray()).toEqual([4, 5]);
    expect(a.lightFieldScale.value).toBe(1);
    expect(b.lightFieldScale.value).toBe(8);
    expect(b.surfaceTexture.value).not.toBe(surface);
    expect(b.surfaceSize.value.toArray()).toEqual([1, 1]);
    expect(b.night.value).toBe(0);
    expect(b.sceneLevel.value.toArray()).toEqual([1, 1, 1]);
    expect(b.faithfulDisplay.value).toBe(1);
    expect(DEFAULT_ATMOSPHERE_NODES.lightFieldTexture.value).not.toBe(first.target.texture);
    first.dispose();
    expect(b.lightFieldTexture.value).toBe(second.target.texture);
    second.dispose();
    a.dispose();
    b.dispose();
    surface.dispose();
  });

  it('mirrors adopted world values without replacing pre-initialization layer nodes or scratch values', () => {
    const layers = new AtmosphereNodes();
    const world = new AtmosphereNodes();
    const levelNode = layers.sceneLevel;
    const levelValue = layers.sceneLevel.value;
    const sizeValue = layers.lightFieldSize.value;
    world.sceneLevel.value.setRGB(0.4, 0.6, 0.8);
    world.night.value = 0.75;
    world.rainAmount.value = 0.9;
    world.windowGain.value = 0.8;
    world.faithfulDisplay.value = 0.25;
    world.lightFieldSize.value.set(30, 20);
    world.surfaceSize.value.set(30, 20);
    layers.copyValuesFrom(world);
    expect(layers.sceneLevel).toBe(levelNode);
    expect(layers.sceneLevel.value).toBe(levelValue);
    expect(layers.lightFieldSize.value).toBe(sizeValue);
    expect(levelValue.toArray()).toEqual([0.4, 0.6, 0.8]);
    expect(sizeValue.toArray()).toEqual([30, 20]);
    expect(layers.night.value).toBe(0.75);
    expect(layers.rainAmount.value).toBe(0.9);
    expect(layers.windowGain.value).toBe(0.8);
    expect(layers.faithfulDisplay.value).toBe(0.25);
    expect(layers.lightFieldTexture.value).toBe(world.lightFieldTexture.value);
    expect(layers.surfaceTexture.value).toBe(world.surfaceTexture.value);
    layers.dispose();
    world.dispose();
  });

  it('caches voxel materials within one context while isolating identical palettes and controls between contexts', () => {
    const a = new AtmosphereNodes();
    const b = new AtmosphereNodes();
    const palette = new Uint8Array(768).fill(128);
    const first = voxelMaterialFor(palette, a);
    const second = voxelMaterialFor(palette, b);
    expect(voxelMaterialFor(palette, a)).toBe(first);
    expect(second).not.toBe(first);
    const controlsA = voxelLightingFor(a);
    const controlsB = voxelLightingFor(b);
    const dependencies = new Set<unknown>();
    const visit = (node: { getChildren(): Iterable<unknown> }): void => {
      if (dependencies.has(node)) return;
      dependencies.add(node);
      for (const child of node.getChildren()) visit(child as typeof node);
    };
    visit(first.emissiveNode!);
    expect(dependencies.has(controlsA.voxelFill)).toBe(true);
    expect(dependencies.has(controlsB.voxelFill)).toBe(false);
    expect(dependencies.has(a.lightFieldTexture)).toBe(true);
    expect(dependencies.has(b.lightFieldTexture)).toBe(false);
    controlsA.voxelDebug.value = 2;
    controlsA.voxelFill.value.setScalar(0.3);
    controlsA.lightDirection.value.set(1, 0, 0);
    expect(controlsB.voxelDebug.value).toBe(0);
    expect(controlsB.voxelFill.value.toArray()).toEqual([0, 0, 0]);
    expect(controlsB.lightDirection.value.toArray()).not.toEqual([1, 0, 0]);
    setPaletteNodes(palette, b);
    expect(voxelMaterialFor(palette)).toBe(second);
    const firstDisposed = vi.fn();
    const secondDisposed = vi.fn();
    first.addEventListener('dispose', firstDisposed);
    second.addEventListener('dispose', secondDisposed);
    a.dispose();
    a.dispose();
    expect(firstDisposed).toHaveBeenCalledTimes(1);
    expect(secondDisposed).not.toHaveBeenCalled();
    b.dispose();
    expect(secondDisposed).toHaveBeenCalledTimes(1);
  });

  it('keeps map lighting and palette grade lifetimes independent', () => {
    const a = grade(0.5);
    const b = grade(1);
    const paletteA = new Uint8Array(768);
    const paletteB = new Uint8Array(768);
    setPaletteGrade(paletteA, a);
    setPaletteGrade(paletteB, b);
    const before = new Uint8Array(b.texture.image.data as Uint8Array);
    a.setWeight(0);
    expect(b.texture.image.data).toEqual(before);
    expect(b.currentWeight).toBe(1);
    setPaletteGrade(paletteA, null);
    expect(paletteGrade(paletteA)).toBeNull();
    expect(paletteGrade(paletteB)).toBe(b);
    a.dispose();
    b.dispose();
  });
});

describe('reused frame scratch storage', () => {
  it('reuses mirrored light records after quiet frames without aliasing different output buffers', () => {
    const nodes = new AtmosphereNodes();
    const field = new LightField(2, 2, { nodes });
    const out: DynamicLight[] = [];
    const other: DynamicLight[] = [];
    field.pulse(0, new Vector3(), [1, 0.5, 0.2], 1, 1, 1, 2, 'explosion');
    const entry = field.dynamicLights(0.1, out)[0];
    expect(field.dynamicLights(0.1, other)[0]).not.toBe(entry);
    expect(field.dynamicLights(2, out)).toHaveLength(0);
    field.pulse(2, new Vector3(1, 0, 1), [1, 1, 1], 1, 1, 1, 2, 'explosion');
    expect(field.dynamicLights(2.1, out)[0]).toBe(entry);
    expect(entry?.x).toBe(1);
    field.dispose();
    nodes.dispose();
  });

  it('computes flat irradiance into the supplied colour without mutating the lights', () => {
    const lighting = new Lighting(2, 2);
    lighting.update(19, 0.4);
    const expected = lighting.sun.color
      .clone()
      .multiplyScalar(lighting.sun.intensity * Math.max(0, lighting.state.sunDirection.y))
      .add(lighting.hemi.color.clone().multiplyScalar(lighting.hemi.intensity));
    const out = expected.clone();
    expect(lighting.flatIrradianceColor(out)).toBe(out);
    expect(out.toArray()).toEqual(expected.toArray());
  });
});
