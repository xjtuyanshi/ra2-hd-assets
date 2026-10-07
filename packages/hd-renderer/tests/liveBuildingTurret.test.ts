import { describe, expect, it } from 'vitest';
import { DataTexture, Group, Mesh, Vector3 } from 'three/webgpu';
import { AtmosphereNodes } from '../src/atmosphere';
import { buildingTurretShadowOrigin, LiveView, type LiveObject } from '../src/live/liveView';
import { SpritePool } from '../src/live/spritePool';
import { VoxelUnits } from '../src/live/voxelUnits';
import { foundationPointPush } from '../src/ra2/cardDepth';
import type { Ra2Cache } from '../src/ra2/cache';
import { setShadowGround, SHADOW_LIFT, SHADOW_SHEAR_X, SHADOW_SHEAR_Z, VoxelShadowMesh } from '../src/ra2/voxelShadow';
import { VoxelUnit } from '../src/ra2/voxels';
import { IsoCamera, LEVEL_HEIGHT } from '../src/world';

const camera = new IsoCamera();
camera.update();
const toCamera = camera.camera.position.clone().normalize();

function building(foundation: [number, number], offset: [number, number], level: number) {
  const nodes = new AtmosphereNodes();
  const scene = new Group();
  setShadowGround(scene, () => level * LEVEL_HEIGHT);
  const root = new VoxelUnit();
  const turret = new Group();
  const source = new Mesh();
  const shadow = new VoxelShadowMesh(source, nodes);
  turret.add(source);
  root.add(turret, shadow);
  const visual = {
    root: new Group(),
    buildingTurret: { root, turret },
    libraryType: {
      foundation,
      drawOffset: [0, 0],
      building: { turretVoxel: { offset } },
    },
  };
  visual.root.add(root);
  scene.add(visual.root);
  const state = {
    cache: { depthTemplate: undefined as Ra2Cache['depthTemplate'] },
    world: { sprites: { toCamera: { value: toCamera } } },
    library: { library: { sprites: {} } },
    spritePool: new SpritePool(),
    pose: { x: 0, y: 0, z: 0, facing: 0 },
    voxelUnits: {
      pose: VoxelUnits.prototype.pose,
      setNativeDepth: VoxelUnits.prototype.setNativeDepth,
      setTint: VoxelUnits.prototype.setTint,
    },
  };
  const view = Object.assign(Object.create(LiveView.prototype), state) as {
    buildingTurret(object: LiveObject, visual: unknown, facing: number | null): void;
  };
  const object: LiveObject = {
    id: 1,
    uid: 1,
    kind: 'building',
    type: 'TEST',
    owner: -1,
    x: 10 * 256 + 128,
    y: 20 * 256 + 128,
    z: level * 104,
    facingRaw: 0,
    health: 1,
    isSelected: false,
  };
  return {
    root,
    shadow,
    object,
    state,
    pose(facing: number) {
      state.spritePool.begin();
      view.buildingTurret(object, visual, facing);
      scene.updateMatrixWorld(true);
    },
    dispose() {
      source.geometry.dispose();
      source.material.dispose();
      nodes.dispose();
    },
  };
}

describe('building turret physical shadow origin', () => {
  it('keeps the physical fallback without a template and enables the native card only in the ground layer', () => {
    const b = building([2, 2], [0, -20], 0);
    const texture = new DataTexture(new Uint8Array([0]), 1, 1);
    try {
      b.pose(0);
      const placement = b.root.position.clone();
      const shadow = b.shadow.matrixWorld.clone();
      expect(b.root.nativeDepth.enabled).toBe(0);
      b.state.cache.depthTemplate = { texture, width: 1, height: 1 };
      b.pose(0);
      expect(b.root.nativeDepth.enabled).toBe(1);
      expect(b.root.nativeDepth.bonus).toBe(-1);
      expect(b.root.position.distanceTo(placement)).toBeLessThan(1e-12);
      expect(b.shadow.matrixWorld.equals(shadow)).toBe(true);
      expect(b.root.nativeDepth.anchor.y).toBe(0);
      expect(b.root.nativeDepth.anchor.distanceTo(placement)).toBeGreaterThan(0);
      b.object.renderOrder = { layer: 3, index: 0, ySort: 0 };
      b.pose(0);
      expect(b.root.nativeDepth.enabled).toBe(0);
      b.object.renderOrder.layer = 2;
      b.state.cache.depthTemplate = undefined;
      b.pose(0);
      expect(b.root.nativeDepth.enabled).toBe(0);
      expect(b.root.position.distanceTo(placement)).toBeLessThan(1e-12);
    } finally {
      b.dispose();
      texture.dispose();
    }
  });

  it('chooses the closest ground position on the view ray without changing the screen position', () => {
    const centre = new Vector3(10, 2, 20);
    const drawn = new Vector3(9.2, 2, 19.6).addScaledVector(toCamera, 4);
    const q = buildingTurretShadowOrigin(drawn, toCamera, centre);
    expect(q.y).toBeGreaterThan(centre.y);
    expect(q.y).toBeLessThan(centre.y + 3 * LEVEL_HEIGHT);
    expect((q.x - centre.x) * toCamera.x + (q.z - centre.z) * toCamera.z).toBeCloseTo(0, 12);
    const screenQ = q.clone().project(camera.camera);
    const screenDrawn = drawn.clone().project(camera.camera);
    expect(screenQ.x).toBeCloseTo(screenDrawn.x, 12);
    expect(screenQ.y).toBeCloseTo(screenDrawn.y, 12);
  });

  it.each([-10, 10])('clamps a closest point outside the physical height range (centre offset %s)', (offset) => {
    const drawn = new Vector3(0, 2, 0).addScaledVector(toCamera, 4);
    const centre = new Vector3(offset, 2, offset);
    const q = buildingTurretShadowOrigin(drawn, toCamera, centre);
    expect(q.y).toBeCloseTo(2 + (offset < 0 ? 0 : 3 * LEVEL_HEIGHT), 12);
    expect(q.clone().sub(drawn).cross(toCamera).length()).toBeLessThan(1e-12);
  });

  it.each([
    { foundation: [1, 1] as [number, number], offset: [0, -12] as [number, number], level: 0 },
    { foundation: [2, 2] as [number, number], offset: [0, -20] as [number, number], level: 2 },
  ])('keeps the $foundation turret shadow at its foundation with vehicle shear at every facing', (spec) => {
    const b = building(spec.foundation, spec.offset, spec.level);
    try {
      for (const facing of [0, Math.PI / 4, Math.PI / 2, Math.PI, (3 * Math.PI) / 2, (7 * Math.PI) / 4]) {
        b.pose(facing);
        const x0 = Math.floor(b.object.x / 256);
        const z0 = Math.floor(b.object.y / 256);
        // The render root still follows the established screen anchor and facade pull.
        const anchor = new Vector3(
          b.object.x / 256 + spec.offset[1] / 30 + spec.offset[0] / 60,
          spec.level * LEVEL_HEIGHT,
          b.object.y / 256 + spec.offset[1] / 30 - spec.offset[0] / 60,
        );
        const push = foundationPointPush(anchor.x - x0, anchor.z - z0, ...spec.foundation) + 0.45;
        expect(b.root.position.distanceTo(anchor.addScaledVector(toCamera, push))).toBeLessThan(1e-12);
        const origin = new Vector3().applyMatrix4(b.shadow.matrixWorld);
        expect(origin.x).toBeGreaterThanOrEqual(x0 - 0.25);
        expect(origin.x).toBeLessThanOrEqual(x0 + spec.foundation[0] + 0.25);
        expect(origin.z).toBeGreaterThanOrEqual(z0 - 0.25);
        expect(origin.z).toBeLessThanOrEqual(z0 + spec.foundation[1] + 0.25);
        expect(origin.y).toBeCloseTo(spec.level * LEVEL_HEIGHT + SHADOW_LIFT, 12);
        for (const h of [0.1, 0.4, 1]) {
          const delta = new Vector3(0, h, 0).applyMatrix4(b.shadow.matrixWorld).sub(origin);
          expect(delta.x).toBeCloseTo(SHADOW_SHEAR_X * h, 12);
          expect(delta.z).toBeCloseTo(SHADOW_SHEAR_Z * h, 12);
          expect(delta.y).toBeCloseTo(0, 12);
        }
        // Reusing pooled anchors must not move the stored physical origin.
        b.state.spritePool.begin();
        b.state.spritePool.anchor().set(100, 100, 100);
        b.state.spritePool.anchor().set(200, 200, 200);
        b.root.updateMatrixWorld(true);
        expect(new Vector3().applyMatrix4(b.shadow.matrixWorld).distanceTo(origin)).toBeLessThan(1e-12);
        b.object.x += 3 * 256;
        b.object.y += 2 * 256;
      }
    } finally {
      b.dispose();
    }
  });
});
