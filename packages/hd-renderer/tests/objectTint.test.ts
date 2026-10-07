import { describe, expect, it } from 'vitest';
import {
  DataTexture,
  DirectionalLight,
  Mesh,
  OrthographicCamera,
  Scene,
  Texture,
  Vector3,
  Vector4,
  WebGPURenderer,
} from 'three/webgpu';
import { lights } from 'three/tsl';
import { SpritePool } from '../src/live/spritePool';
import type { DirtyAttribute } from '../src/dirtyAttribute';
import type { Ra2Cache } from '../src/ra2/cache';
import { SpriteLayer, type SpriteInstance } from '../src/ra2/sprites';
import { buildVoxelGeometry, createVoxelMaterial, instantiateVoxel } from '../src/ra2/voxels';
import {
  TINT_LEVEL_CAP,
  packTintColour,
  setMeshObjectTint,
  tintLight,
  tintedSrgb,
  unpackTintColour,
} from '../src/objectTint';
import type { SpriteFrame } from '../../ra2-assets/src/manifest';
import { AtmosphereNodes } from '../src/atmosphere';
import { syntheticModel, syntheticSection } from './fixtures/syntheticVoxels';

const frame: SpriteFrame = { rect: [0, 0, 8, 8], offset: [-4, -8] };
const cache = {
  paletteAtlas: { image: { height: 1 } },
  paletteRow: new Map([['unit', 0]]),
  manifest: { spriteAtlas: { width: 256, height: 256 } },
  spriteAtlas: new Texture(),
} as unknown as Ra2Cache;

/** The engine's [ColorAdd] HighBlue (0, 0, 24 of 31) and HighRed (24 of 31, 0, 0), as the bridge publishes them. */
const HIGH_BLUE: [number, number, number] = [0, 0, 24 / 31];
const HIGH_RED: [number, number, number] = [24 / 31, 0, 0];

function fragmentShader(mesh: Parameters<WebGPURenderer['backend']['createNodeBuilder']>[0]): string {
  const renderer = new WebGPURenderer({ canvas: { width: 1, height: 1 } as HTMLCanvasElement });
  renderer.hasFeature = () => false;
  renderer.hasCompatibility = () => false;
  const builder = renderer.backend.createNodeBuilder(mesh, renderer);
  builder.camera = new OrthographicCamera(-1, 1, 1, -1, 0.1, 400);
  builder.scene = new Scene();
  builder.lightsNode = lights([new DirectionalLight()]);
  builder.build();
  return builder.fragmentShader as string;
}

describe('object picture tint', () => {
  it('packs the added colour into the 5/6/5 bits the engine adds and clamps the light factor', () => {
    expect(packTintColour(undefined)).toBe(0);
    expect(packTintColour(HIGH_BLUE)).toBe(24);
    expect(packTintColour(HIGH_RED)).toBe(24 << 11);
    expect(packTintColour([1, 1, 1])).toBe(0xffff);
    expect(packTintColour([2, -1, 0.5])).toBe((31 << 11) | 16);
    expect(unpackTintColour(packTintColour(HIGH_BLUE))).toEqual([0, 0, 24 / 31]);
    expect(unpackTintColour(packTintColour([14 / 31, 28 / 63, 14 / 31]))).toEqual([14 / 31, 28 / 63, 14 / 31]);
    expect(tintLight(undefined)).toBe(1);
    expect(tintLight({ light: 0.2 })).toBe(0.2);
    expect(tintLight({ light: 5 })).toBe(TINT_LEVEL_CAP);
    expect(tintLight({ light: -1 })).toBe(0);
    expect(tintLight({ light: Number.NaN })).toBe(1);
  });

  it('darkens, flashes and colours a display colour the way the engine lights a palette colour', () => {
    const grey: [number, number, number] = [0.6, 0.5, 0.4];
    expect(tintedSrgb(grey, undefined)).toEqual(grey);
    // The dark end of the Iron Curtain's pulse: a fifth of every channel.
    expect(tintedSrgb(grey, { light: 0.2 }).map((v) => +v.toFixed(4))).toEqual([0.12, 0.1, 0.08]);
    // The flash doubles the palette colour and clips at white.
    expect(tintedSrgb(grey, { light: 2 }).map((v) => +v.toFixed(4))).toEqual([1, 1, 0.8]);
    // An object already lit at 1.25 can only reach the cap of 2: its factor is 1.6, not 2.
    expect(tintedSrgb(grey, { light: 2 }, 1.25).map((v) => +v.toFixed(4))).toEqual([0.96, 0.8, 0.64]);
    // Force Shield: the pulse, then blue added and clipped.
    const shield = tintedSrgb(grey, { light: 0.5, add: HIGH_BLUE });
    expect(shield.map((v) => +v.toFixed(4))).toEqual([0.3, 0.25, +(0.2 + 24 / 31).toFixed(4)]);
    expect(tintedSrgb([1, 1, 1], { light: 1, add: HIGH_RED })).toEqual([1, 1, 1]);
  });

  it('gives every body card of the pooled object the tint and leaves shadows untinted', () => {
    const pool = new SpritePool();
    pool.tintLight = 0.2;
    pool.tintColour = packTintColour(HIGH_BLUE);
    const body = pool.take(new Vector3(), frame, 'unit', 0, false);
    const shadow = pool.take(new Vector3(), frame, 'unit', 0, true, true);
    expect([body.tintLight, body.tintColour]).toEqual([0.2, 24]);
    expect([shadow.tintLight, shadow.tintColour]).toEqual([1, 0]);
    // The next frame's first object is untinted until its own tint is set: nothing leaks from a reused record.
    pool.begin();
    const next = pool.take(new Vector3(), frame, 'unit', 0, false);
    expect(next).toBe(body);
    expect([next.tintLight, next.tintColour]).toEqual([1, 0]);
  });

  it('carries a sprite tint as instance data of the one shared graph: no new material, no new attribute layout', () => {
    const body: SpriteInstance = { anchor: new Vector3(1, 2, 3), frame, palette: 'unit', push: 0, shadow: false };
    const nodes = new AtmosphereNodes();
    const paletteAtlas = new DataTexture(new Uint8Array(256 * 4), 256, 1);
    const layer = new SpriteLayer(
      { ...cache, nodes, paletteAtlas } as unknown as Ra2Cache,
      [{ ...body, shadow: true }, { ...body, kind: 'reflection' }, body],
      3,
    );
    const shader = () => fragmentShader(new Mesh(layer.mesh.geometry, layer.mesh.material));
    const anchor = (layer as unknown as { anchor: DirtyAttribute }).anchor;
    const tintOf = (i: number) => [anchor.getComponent(i, 6), anchor.getComponent(i, 7)];
    expect(anchor.itemSize).toBe(8);
    expect([0, 1, 2].map(tintOf)).toEqual([
      [1, 0],
      [1, 0],
      [1, 0],
    ]);
    const material = layer.mesh.material;
    const attributes = Object.keys(layer.mesh.geometry.attributes).sort();
    expect(attributes).toContain('spriteTint');
    const before = shader();
    expect(before).toContain('spriteTint');

    // The Iron Curtain's dark phase and the Force Shield's colour arrive: only numbers of this instance change.
    body.tintLight = 0.2;
    body.tintColour = packTintColour(HIGH_BLUE);
    const shadow = layer.getInstances()[0]!;
    shadow.tintLight = 0.2;
    shadow.tintColour = 24;
    layer.setInstances(layer.getInstances(), false);
    // Rank order: the shadow and the reflection are uploaded before the card; neither takes the tint.
    const rows = [0, 1, 2].map(tintOf);
    expect(rows.filter(([light]) => Math.abs(light! - 0.2) < 1e-6)).toEqual([[expect.closeTo(0.2, 6), 24]]);
    expect(rows.filter(([light]) => light === 1)).toEqual([
      [1, 0],
      [1, 0],
    ]);
    expect(layer.mesh.material).toBe(material);
    expect(Object.keys(layer.mesh.geometry.attributes).sort()).toEqual(attributes);
    expect(shader()).toBe(before);
    layer.mesh.material.dispose();
    layer.mesh.geometry.dispose();
    nodes.dispose();
  });

  it('carries a voxel tint as data of the drawn mesh: the same material and the same shader text', () => {
    const nodes = new AtmosphereNodes();
    const source = createVoxelMaterial(nodes);
    const parts = buildVoxelGeometry(syntheticModel([syntheticSection(2)]), null, nodes);
    const unit = instantiateVoxel(parts, source, nodes);
    const other = instantiateVoxel(parts, source, nodes);
    const mesh = unit.root.partMeshes[0]!;
    const material = mesh.material;
    const before = fragmentShader(mesh);
    expect(before).toContain('objectTint');
    expect(before).not.toMatch(/\b(?:NaN|undefined)\b/);

    unit.root.setTint({ light: 0.35, add: HIGH_RED });
    for (const part of unit.root.partMeshes)
      expect(part.userData.objectTint).toEqual(new Vector4(0.35, 24 << 11, 0, 0));
    // Shadow, foam and reflection twins and every other unit keep their look.
    unit.root.traverse((child) => {
      if (!unit.root.partMeshes.includes(child as never)) expect(child.userData.objectTint).toBeUndefined();
    });
    for (const part of other.root.partMeshes) expect(part.userData.objectTint).toBeUndefined();
    expect(mesh.material).toBe(material);
    expect(fragmentShader(mesh)).toBe(before);

    const kept = mesh.userData.objectTint;
    unit.root.setTint({ light: 0.5 });
    expect(mesh.userData.objectTint).toBe(kept);
    expect(kept).toEqual(new Vector4(0.5, 0, 0, 0));
    unit.root.setTint(undefined);
    expect(mesh.userData.objectTint).toBeUndefined();
    setMeshObjectTint(mesh, { light: 1 });
    expect(mesh.userData.objectTint).toBeUndefined();
    parts.forEach((part) => part.geometry.dispose());
    nodes.dispose();
  });
});
