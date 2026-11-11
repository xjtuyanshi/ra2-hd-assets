import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  DataTexture,
  DirectionalLight,
  HemisphereLight,
  Matrix4,
  Mesh,
  MeshBasicNodeMaterial,
  PerspectiveCamera,
  Scene,
  WebGPURenderer,
  type Material,
} from 'three/webgpu';
import { lights, uniform } from 'three/tsl';
import { AtmosphereNodes, LOCAL_LIGHT_HEIGHT_FALLOFF, localLightLift } from '../src/atmosphere';
import { bindSlots } from '../src/materialSlots';
import { createVoxelProjectionPart } from '../src/ra2/voxelProjection';
import type { VoxelProjectionManifest } from '../src/ra2/voxelProjectionMath';
import { voxelPbrMaterialFor } from '../src/ra2/voxelPbr';
import { voxelReflectionColour } from '../src/ra2/voxelReflectionColour';
import { buildVoxelGeometry, instantiateVoxel, type VoxelUnit } from '../src/ra2/voxels';
import { meshLocalLight, voxelLocalLightShare, voxelMaterialFor, voxelProjectedMaterialFor } from '../src/ra2/vpl';
import { LEVEL_HEIGHT } from '../src/world';
import { syntheticSection } from './fixtures/syntheticVoxels';
import type { VoxelModel } from '../../ra2-assets/src/manifest';

/**
 * B2 #18: the HD light field (fires, explosions, lamps) is ground light. A burning Kirov over explosions at night took
 * the field's ground peak at flight level, unscaled and uncapped, and went near white; the engine lights no object
 * with explosions. Voxel units now take localLightLift of their height above the ground, and the engine voxel look
 * caps the local light to the display headroom like sprites and terrain.
 */

const model: VoxelModel = {
  id: 'ZEP',
  palette: 'unit',
  normalsMode: 4,
  turretOffset: 0,
  parts: [{ role: 'body', sections: [syntheticSection(2, true)] }],
};

function manifest(): VoxelProjectionManifest {
  const part = {
    colour: 'ZEP_body.png',
    paint: 'ZEP_body_paint.png',
    size: [320, 32] as [number, number],
    frames: Array.from({ length: 16 }, (_, i) => ({
      k: i * 2,
      facing: i * 16,
      pivot: [i * 20 + 8, 24] as [number, number],
      rect: [i * 20 + 1, 1, 16, 16] as [number, number, number, number],
    })),
  };
  return {
    version: 1,
    type: 'ZEP',
    frames: 16,
    facingStep: 16,
    scale: 1.5,
    jacobian: [
      [180, 0, -180],
      [90, -220.45407, 90],
    ],
    house: { first: 16, count: 16 },
    parts: { body: part },
    registration: [],
  };
}

type VoxelKind = 'engine' | 'remaster' | 'projected';

function voxelMaterial(kind: VoxelKind, nodes: AtmosphereNodes): Material {
  const palette = new Uint8Array(768);
  const texture = () => nodes.own(new DataTexture(new Uint8Array(320 * 32 * 4), 320, 32));
  return kind === 'engine'
    ? voxelMaterialFor(palette, nodes)
    : kind === 'remaster'
      ? voxelPbrMaterialFor(palette, nodes)
      : voxelProjectedMaterialFor(palette, createVoxelProjectionPart(manifest(), 'body', texture(), texture()), nodes);
}

/** The uniform nodes a voxel material's shaders read (no device needed); `draw` replaces the drawn material. */
function uniformNodes(material: Material, nodes: AtmosphereNodes, draw?: Material): unknown[] {
  const parts = buildVoxelGeometry(model, null, nodes);
  parts[0]!.material = material as never;
  const unit = instantiateVoxel([parts[0]!], material as never, nodes);
  const mesh = unit.root.children.find((o) => o instanceof Mesh && o.material === material) as Mesh;
  if (draw) mesh.material = draw;
  const renderer = new WebGPURenderer({
    canvas: {
      width: 64,
      height: 64,
      style: {},
      addEventListener() {},
      removeEventListener() {},
      setAttribute() {},
    } as unknown as HTMLCanvasElement,
  });
  vi.spyOn(renderer, 'hasFeature').mockReturnValue(false);
  bindSlots(material);
  const builder = renderer.backend.createNodeBuilder(mesh, renderer);
  builder.scene = new Scene();
  builder.camera = new PerspectiveCamera();
  builder.lightsNode = lights([new DirectionalLight(), new HemisphereLight()]);
  builder.build();
  return [...builder.uniforms.vertex, ...builder.uniforms.fragment].flatMap((entry) => {
    const node = entry.node as unknown as { node?: unknown };
    return [entry.node, node.node];
  });
}

describe('voxel units take ground light by their height above the ground (B2 #18)', () => {
  it('fades the light field with height like sprite pixels: full on the ground, a few per cent at flight level', () => {
    expect(localLightLift(0)).toBe(1);
    expect(localLightLift(-2)).toBe(1);
    expect(localLightLift(NaN)).toBe(1);
    const flight = (1500 / 104) * LEVEL_HEIGHT;
    expect(localLightLift(flight)).toBeLessThan(0.1);
    expect(localLightLift(1)).toBeCloseTo(Math.exp(-LOCAL_LIGHT_HEIGHT_FALLOFF), 12);
    const sprites = readFileSync(new URL('../src/ra2/sprites.ts', import.meta.url), 'utf8');
    expect(sprites).toMatch(/exp\(height\.mul\(-LOCAL_LIGHT_HEIGHT_FALLOFF\)\)/);
  });

  it('gives the share to every drawn mesh of the unit, twins included; 1 by default', () => {
    const nodes = new AtmosphereNodes();
    try {
      const make = (): VoxelUnit => {
        const parts = buildVoxelGeometry(model, null, nodes);
        return instantiateVoxel(parts, voxelMaterialFor(new Uint8Array(768), nodes) as never, nodes).root;
      };
      const meshes = (root: VoxelUnit) => {
        const all: Mesh[] = [];
        root.traverse((o) => o instanceof Mesh && all.push(o));
        return all;
      };
      const ground = make();
      const air = make();
      air.setLocalLightShare(0.07);
      expect(meshes(air).length).toBeGreaterThan(air.partMeshes.length);
      for (const mesh of meshes(air)) expect(voxelLocalLightShare(mesh)).toBeCloseTo(0.07, 12);
      for (const mesh of meshes(ground)) expect(voxelLocalLightShare(mesh)).toBe(1);
      expect(voxelLocalLightShare(null)).toBe(1);
      air.setLocalLightShare(NaN);
      expect(voxelLocalLightShare(air.partMeshes[0])).toBe(1);
    } finally {
      nodes.dispose();
    }
  });

  it.each(['engine', 'remaster', 'projected'] as const)('the %s voxel material reads the share', (kind) => {
    const nodes = new AtmosphereNodes();
    const used = uniformNodes(voxelMaterial(kind, nodes), nodes);
    expect(used).toContain(meshLocalLight);
    // The engine look (plain and projected) caps the local light to the display headroom like sprites do.
    if (kind !== 'remaster') expect(used).toContain(nodes.localLightCap);
    nodes.dispose();
  });

  it.each(['engine', 'remaster', 'projected'] as const)(
    "the %s voxel material's reflection reads the share",
    (kind) => {
      const nodes = new AtmosphereNodes();
      const material = voxelMaterial(kind, nodes);
      const reflection = new MeshBasicNodeMaterial();
      reflection.colorNode = voxelReflectionColour(material, uniform(new Matrix4()));
      const used = uniformNodes(material, nodes, reflection);
      if (kind !== 'remaster') expect(used).toContain(meshLocalLight);
      nodes.dispose();
    },
  );

  it('is set from the live pose: 0 height for units on the ground or a bridge deck', () => {
    const source = readFileSync(new URL('../src/live/liveView.ts', import.meta.url), 'utf8');
    expect(source).toMatch(
      /setLocalLightHeight\(unit, grounded \? 0 : this\.heightAboveSurface\(unit\.root\.position\)\)/,
    );
  });
});
