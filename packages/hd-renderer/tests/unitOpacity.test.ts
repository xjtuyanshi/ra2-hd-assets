import { describe, expect, it, vi } from 'vitest';
import {
  BoxGeometry,
  DirectionalLight,
  Mesh,
  MeshStandardNodeMaterial,
  OrthographicCamera,
  Scene,
  Texture,
  Vector3,
  WebGPURenderer,
} from 'three/webgpu';
import { lights } from 'three/tsl';
import { SpritePool } from '../src/live/spritePool';
import type { DirtyAttribute } from '../src/dirtyAttribute';
import type { Ra2Cache } from '../src/ra2/cache';
import { NATIVE_UNIT_RENDER_ORDER } from '../src/ra2/nativeDepth';
import { SpriteLayer, type SpriteInstance } from '../src/ra2/sprites';
import { buildVoxelGeometry, createVoxelMaterial, instantiateVoxel, updateVoxelNativeDepth } from '../src/ra2/voxels';
import { NOT_CAPTURED_CODE } from '../src/objectDepth';
import { TerrainDepth } from '../src/terrainDepth';
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

describe('native body opacity', () => {
  it.each([1, 0.5])('retains custom voxel lighting inputs in the material clone at opacity %s', (opacity) => {
    const nodes = new AtmosphereNodes();
    const source = createVoxelMaterial(nodes);
    const parts = buildVoxelGeometry(syntheticModel([syntheticSection(2)]), null, nodes);
    const unit = instantiateVoxel(parts, source, nodes);
    updateVoxelNativeDepth(unit, new Vector3());
    unit.root.setOpacity(opacity);
    const mesh = unit.root.partMeshes[0]!;
    const renderer = new WebGPURenderer({ canvas: { width: 1, height: 1 } as HTMLCanvasElement });
    renderer.hasFeature = () => false;
    renderer.hasCompatibility = () => false;
    const builder = renderer.backend.createNodeBuilder(mesh, renderer);
    builder.camera = new OrthographicCamera(-1, 1, 1, -1, 0.1, 400);
    builder.scene = new Scene();
    builder.lightsNode = lights([new DirectionalLight()]);
    builder.build();
    expect(builder.fragmentShader).not.toMatch(/\b(?:NaN|undefined)\b/);
    expect(builder.fragmentShader).toContain('voxelNativeRow');
    expect(mesh.material).toMatchObject({ opacity });
    unit.root.disposeOpacityMaterials();
    parts.forEach((part) => part.geometry.dispose());
    nodes.dispose();
  });
  it('routes SHP bodies after doors without depth writes and preserves shadow, reflection and sibling alpha', () => {
    const body: SpriteInstance = {
      anchor: new Vector3(),
      frame,
      palette: 'unit',
      push: 0,
      shadow: false,
      nativeDepth: { mode: 'card', bottom: -1, bonus: 0 },
      opacity: 0.5,
    };
    const capture = new TerrainDepth(1);
    const layer = new SpriteLayer(
      cache,
      [{ ...body, shadow: true }, { ...body, kind: 'reflection' }, { ...body, opacity: undefined }, body],
      4,
      undefined,
      null,
      null,
      null,
      capture,
    );
    const flags = (layer as unknown as { flags: DirtyAttribute }).flags;
    const pass = (i: number) => flags.getComponent(i, flags.itemSize - 1);
    expect(flags.itemSize).toBe(17);
    expect([0, 1, 2, 3].map(pass)).toEqual([0, 0, 2, 3.5]);
    expect(layer.translucentMesh.material).toMatchObject({ transparent: true, depthWrite: false, depthTest: true });
    expect(layer.translucentMesh.renderOrder).toBeGreaterThan(NATIVE_UNIT_RENDER_ORDER);
    expect(layer.translucentMesh.visible).toBe(true);
    expect(layer.unitMesh.visible).toBe(true);
    expect(layer.translucentMesh.geometry).toBe(layer.mesh.geometry);
    layer.updateCaptureCodes(() => -3);
    expect([0, 1, 2, 3].map((i) => flags.getComponent(i, 8))).toEqual([
      NOT_CAPTURED_CODE,
      NOT_CAPTURED_CODE,
      -3,
      NOT_CAPTURED_CODE,
    ]);
    body.opacity = 1;
    layer.setInstances(layer.getInstances(), false);
    expect(pass(3)).toBe(2);
    expect(layer.translucentMesh.visible).toBe(false);
    const dispose = vi.spyOn(layer.translucentMesh.material, 'dispose');
    const disposeMesh = vi.spyOn(layer.translucentMesh, 'dispose');
    layer.mesh.material.dispose();
    layer.mesh.dispose();
    expect(dispose).toHaveBeenCalledOnce();
    expect(disposeMesh).toHaveBeenCalledOnce();
    layer.mesh.geometry.dispose();
    capture.dispose();
  });

  it('resets pooled body opacity before the record becomes another object or shadow', () => {
    const pool = new SpritePool();
    const body = pool.take(new Vector3(), frame, 'unit', 0, false);
    body.opacity = 0.5;
    pool.begin();
    const next = pool.take(new Vector3(), frame, 'unit', 0, true);
    expect(next).toBe(body);
    expect(next.opacity).toBeUndefined();
  });

  it('isolates voxel body, turret and barrel opacity, keeps twins unchanged and restores native/flight materials', () => {
    const geometry = new BoxGeometry();
    const material = new MeshStandardNodeMaterial();
    const parts = (['body', 'turret', 'barrel'] as const).map((role) => ({ role, geometry, turretOffset: 0 }));
    const first = instantiateVoxel(parts, material);
    const second = instantiateVoxel(parts, material);
    first.root.partMeshes.forEach((mesh) => {
      mesh.renderOrder = 7;
    });
    const twins: Mesh[] = [];
    first.root.traverse((mesh) => {
      if (mesh instanceof Mesh && !first.root.partMeshes.includes(mesh)) twins.push(mesh);
    });
    const twinMaterials = twins.map((mesh) => mesh.material);
    updateVoxelNativeDepth(first, new Vector3(1, 2, 3), 13);
    updateVoxelNativeDepth(second, new Vector3(1, 2, 3), 13);
    const originalNative = first.root.partMeshes[0]!.material;
    first.root.setOpacity(0.5);
    const blended = first.root.partMeshes[0]!.material as MeshStandardNodeMaterial;
    for (const mesh of first.root.partMeshes) {
      expect(mesh.material).toBe(blended);
      expect(mesh.renderOrder).toBe(NATIVE_UNIT_RENDER_ORDER);
      expect(mesh.userData.voxelNativeDepth).toBe(first.root.nativeDepth);
    }
    expect(blended).toMatchObject({ transparent: true, depthWrite: false, opacity: 0.5 });
    expect(blended.depthNode).toBe(material.depthNode);
    expect(material).toMatchObject({ transparent: false, depthWrite: true, opacity: 1 });
    expect(second.root.partMeshes.every((mesh) => mesh.material === originalNative)).toBe(true);
    twins.forEach((mesh, i) => expect(mesh.material).toBe(twinMaterials[i]));
    updateVoxelNativeDepth(first, new Vector3(1, 2, 3), 13);
    expect(first.root.partMeshes[0]!.material).toBe(blended);
    updateVoxelNativeDepth(first, new Vector3(1, 2, 3), 0, false);
    expect(first.root.partMeshes[0]!.material).toBe(blended);
    expect(first.root.partMeshes[0]!.renderOrder).toBe(7);
    first.root.setOpacity(1);
    expect(first.root.partMeshes.every((mesh) => mesh.material === material)).toBe(true);
    updateVoxelNativeDepth(first, new Vector3());
    expect(first.root.partMeshes[0]!.material).toBe(originalNative);
    const dispose = vi.spyOn(blended, 'dispose');
    first.root.disposeOpacityMaterials();
    expect(dispose).toHaveBeenCalledOnce();
    material.dispose();
    geometry.dispose();
  });
});
