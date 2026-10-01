import { describe, expect, it } from 'vitest';
import {
  BufferGeometry,
  Group,
  Matrix4,
  Mesh,
  MeshStandardNodeMaterial,
  NodeFrame,
  Vector3,
  Vector4,
  WebGLCoordinateSystem,
  WebGPUCoordinateSystem,
} from 'three/webgpu';
import { AtmosphereNodes } from '../src/atmosphere';
import { IsoCamera } from '../src/world';
import { spriteLookFor } from '../src/ra2/spriteLook';
import { instantiateVoxel } from '../src/ra2/voxels';
import {
  AIRBORNE_HEIGHT,
  AIRBORNE_SHADOW_DRIFT_X,
  AIRBORNE_SHADOW_DRIFT_Z,
  AIRBORNE_SHADOW_HALF,
  SHADOW_LIFT,
  SHADOW_COPIES,
  SHADOW_COPY_LIFT,
  SHADOW_DEPTH_STEPS,
  SHADOW_OPACITY,
  SHADOW_PENUMBRA,
  SHADOW_SHEAR_X,
  SHADOW_SHEAR_Z,
  VoxelShadowMesh,
  VoxelWaterMesh,
  WATER_CONTACT_OPACITY,
  WATER_FOAM_OPACITY,
  WATER_FOAM_SCALE,
  WATER_REFLECTION_FADE,
  WATER_REFLECTION_OPACITY,
  setShadowGround,
  setShadowOrigin,
  shadowOriginProjection,
  shadowProjection,
  shadowCopyOpacity,
  shadowPlaneDepth,
  voxelShadowFor,
  voxelShadowMaterial,
  voxelWaterMaterial,
  waterContactProjection,
  waterReflectionProjection,
} from '../src/ra2/voxelShadow';

describe('voxel water contact', () => {
  it('keeps x/z straight down and scales foam about the water origin, independent of height', () => {
    const origin = new Vector3(12, 1.4, 23);
    for (const scale of [1, WATER_FOAM_SCALE - 0.02, WATER_FOAM_SCALE, WATER_FOAM_SCALE + 0.02]) {
      const out = new Matrix4();
      expect(waterContactProjection(origin, scale, out)).toBe(out);
      for (const height of [-0.1, 0, 0.3, 2]) {
        const point = origin
          .clone()
          .add(new Vector3(0.7, height, -0.2))
          .applyMatrix4(out);
        expect(point.x).toBeCloseTo(origin.x + 0.7 * scale, 12);
        expect(point.z).toBeCloseTo(origin.z - 0.2 * scale, 12);
        expect(point.y).toBe(origin.y + SHADOW_LIFT);
      }
    }
  });

  it.each([WebGLCoordinateSystem, WebGPUCoordinateSystem])(
    'flattens mirrored points to the same orthographic screen xy (coordinate system %s)',
    (coordinateSystem) => {
      const iso = new IsoCamera();
      iso.camera.coordinateSystem = coordinateSystem;
      iso.target.set(12, 1.4, 23);
      iso.zoom = 3;
      iso.resize(1000, 700);
      iso.update();
      const view = new Vector3().setFromMatrixColumn(iso.camera.matrixWorld, 2);
      const out = new Matrix4();
      expect(waterReflectionProjection(iso.target, view, out)).toBe(out);
      for (const height of [0, 0.1, WATER_REFLECTION_FADE, 2]) {
        const original = new Vector3(12.7, iso.target.y + height, 22.8);
        const flattened = original.clone().applyMatrix4(out);
        expect(flattened.y).toBe(iso.target.y + SHADOW_LIFT);
        const screen = flattened.project(iso.camera);
        const mirrored = original
          .clone()
          .setY(iso.target.y - height)
          .project(iso.camera);
        expect(screen.x).toBeCloseTo(mirrored.x, 12);
        expect(screen.y).toBeCloseTo(mirrored.y, 12);
      }
    },
  );

  it('switches by water under the origin, retains land/flight/override matrices, and bounds shared twins', () => {
    const nodes = new AtmosphereNodes();
    const geometry = new BufferGeometry();
    const material = new MeshStandardNodeMaterial();
    const unit = instantiateVoxel([{ role: 'body', turretOffset: 0, geometry }], material, nodes);
    const scene = new Group();
    scene.add(unit.root);
    let water = false;
    let samples = 0;
    setShadowGround(scene, {
      height: () => 0.4,
      normal: (_x, _z, out) => out.set(0.2, 1, -0.1).normalize(),
      waterHeight: (x, z) => {
        expect(x).toBe(10);
        expect(z).toBe(20);
        samples++;
        return water ? 0.4 : undefined;
      },
    });
    unit.root.position.set(10, 0.4, 20);
    unit.root.rotation.y = 0.7;
    const shadows = unit.root.children.filter((o): o is VoxelShadowMesh => o instanceof VoxelShadowMesh);
    const decals = unit.root.children.filter((o): o is VoxelWaterMesh => o instanceof VoxelWaterMesh);
    const mode = voxelShadowFor(nodes);
    try {
      expect(shadows).toHaveLength(5);
      expect(decals).toHaveLength(6);
      for (const twin of [...shadows, ...decals]) expect(twin.geometry).toBe(geometry);
      scene.updateMatrixWorld(true);
      const land = shadows.map((s) => s.matrixWorld.clone());
      expect(decals.every((d) => !d.visible)).toBe(true);
      water = true;
      scene.updateMatrixWorld(true);
      expect(samples).toBeGreaterThan(0);
      expect(shadows.every((s) => s.onWater && s.visible)).toBe(true);
      expect(decals.every((d) => d.visible && d.onWater)).toBe(true);
      const sourcePoint = new Vector3(0.6, 0.3, -0.2).applyMatrix4(shadows[0]!.source.matrixWorld);
      const contact = new Vector3(0.6, 0.3, -0.2).applyMatrix4(shadows[0]!.matrixWorld);
      expect(contact.x).toBeCloseTo(sourcePoint.x, 12);
      expect(contact.z).toBeCloseTo(sourcePoint.z, 12);
      for (const twin of [...shadows, ...decals]) {
        const p = new Vector3(0.6, 0.3, -0.2).applyMatrix4(twin.matrixWorld);
        expect(p.y).toBeCloseTo(twin.planeConstant, 12);
      }
      const foam = decals.find((d) => d.layer === 'foam')!;
      expect(Math.max(...decals.map((d) => d.planeConstant))).toBeLessThan(
        Math.min(...shadows.map((s) => s.planeConstant)),
      );
      expect(foam.renderOrder).toBeGreaterThan(Math.max(...shadows.map((s) => s.renderOrder)));
      mode.time = 0.5;
      scene.updateMatrixWorld(true);
      const breathing = foam.matrixWorld.clone();
      expect(foam.foamPulse).toBe(1);
      scene.updateMatrixWorld(true);
      expect(foam.matrixWorld.elements).toEqual(breathing.elements);
      mode.time += 2;
      scene.updateMatrixWorld(true);
      expect(foam.matrixWorld.elements).toEqual(breathing.elements);
      mode.naval = false;
      scene.updateMatrixWorld(true);
      shadows.forEach((s, i) => expect(s.matrixWorld.elements).toEqual(land[i]!.elements));
      expect(decals.every((d) => !d.visible)).toBe(true);
      mode.naval = true;
      for (const height of [AIRBORNE_HEIGHT + 0.01, AIRBORNE_SHADOW_HALF]) {
        unit.root.position.y = 0.4 + height;
        mode.naval = false;
        scene.updateMatrixWorld(true);
        const airborne = shadows.map((s) => s.matrixWorld.clone());
        mode.naval = true;
        scene.updateMatrixWorld(true);
        shadows.forEach((s, i) => expect(s.matrixWorld.elements).toEqual(airborne[i]!.elements));
        expect(decals.every((d) => !d.visible)).toBe(true);
      }
      setShadowOrigin(unit.root, new Vector3(8, 0.9, 18));
      scene.updateMatrixWorld(true);
      const override = shadows.map((s) => s.matrixWorld.clone());
      mode.naval = false;
      scene.updateMatrixWorld(true);
      shadows.forEach((s, i) => expect(s.matrixWorld.elements).toEqual(override[i]!.elements));
      expect(decals.every((d) => !d.visible)).toBe(true);
      setShadowOrigin(unit.root);
      unit.root.position.y = 0.4;
      water = false;
      mode.naval = true;
      scene.updateMatrixWorld(true);
      shadows.forEach((s, i) => expect(s.matrixWorld.elements).toEqual(land[i]!.elements));
    } finally {
      geometry.dispose();
      material.dispose();
      nodes.dispose();
    }
  });

  it('composes water opacity independently of the land preset and uses the deterministic foam pulse', () => {
    const nodes = new AtmosphereNodes();
    const source = new Mesh();
    const shadow = new VoxelShadowMesh(source, nodes);
    const foam = new VoxelWaterMesh(source, nodes, 'foam');
    const frame = new NodeFrame();
    try {
      spriteLookFor(nodes).shadowDarkness.value = 2;
      voxelShadowFor(nodes).soft = false;
      shadow.onWater = true;
      frame.object = shadow;
      const opacity = voxelShadowMaterial(nodes).opacityNode!;
      opacity.update(frame);
      expect(1 - (1 - (opacity as unknown as { value: number }).value) ** 5).toBeCloseTo(WATER_CONTACT_OPACITY, 14);
      const foamOpacity = voxelWaterMaterial(nodes, 'foam').opacityNode!;
      frame.object = foam;
      for (const pulse of [-1, 0, 1]) {
        foam.foamPulse = pulse;
        foamOpacity.update(frame);
        const alpha = (foamOpacity as unknown as { value: number }).value;
        expect(1 - (1 - alpha) ** 5).toBeCloseTo(WATER_FOAM_OPACITY * (1 + 0.03 * pulse), 14);
      }
      expect(WATER_REFLECTION_OPACITY).toBe(0.25);
    } finally {
      source.geometry.dispose();
      source.material.dispose();
      nodes.dispose();
    }
  });
});

describe('voxel twin visibility', () => {
  it('keeps hiding done by other code (sandbox bake isolation) until the wanted state changes', () => {
    const nodes = new AtmosphereNodes();
    const unit = instantiateVoxel(
      [{ role: 'body', turretOffset: 0, geometry: new BufferGeometry() }],
      new MeshStandardNodeMaterial(),
      nodes,
    );
    const scene = new Group();
    scene.add(unit.root);
    let water = false;
    setShadowGround(scene, { height: () => 0, waterHeight: () => (water ? 0 : undefined) });
    const twins = unit.root.children.filter(
      (o): o is VoxelShadowMesh | VoxelWaterMesh => o instanceof VoxelShadowMesh || o instanceof VoxelWaterMesh,
    );
    scene.updateMatrixWorld(true);
    expect(twins.filter((t) => t.visible)).toHaveLength(5);
    for (const twin of twins) twin.visible = false;
    scene.updateMatrixWorld(true);
    scene.updateMatrixWorld(true);
    expect(twins.some((t) => t.visible)).toBe(false);
    // A real change (the unit reaches water) still shows the water layers.
    water = true;
    scene.updateMatrixWorld(true);
    expect(twins.filter((t) => t instanceof VoxelWaterMesh && t.visible)).toHaveLength(6);
  });
});

describe('voxel shadow origin override', () => {
  it('translates world geometry before projecting onto flat or sloped ground', () => {
    const drawn = new Vector3(10, 6, 20);
    const physical = new Vector3(8, 1.2, 18);
    const ground = new Vector3(8, 0.4, 18);
    for (const normal of [new Vector3(0, 1, 0), new Vector3(0.3, 1, -0.2).normalize()]) {
      const matrix = shadowOriginProjection(drawn, physical, ground, normal);
      for (const offset of [new Vector3(), new Vector3(0.7, 0.4, -0.3)]) {
        const projected = drawn.clone().add(offset).applyMatrix4(matrix);
        const expected = physical.clone().add(offset).applyMatrix4(shadowProjection(ground, normal));
        expect(projected.distanceTo(expected)).toBeLessThan(1e-12);
      }
      const out = new Matrix4();
      expect(shadowOriginProjection(drawn, physical, ground, normal, out)).toBe(out);
      expect(out.elements).toEqual(matrix.elements);
    }
  });

  it.each([0, AIRBORNE_HEIGHT, AIRBORNE_HEIGHT + 0.01, AIRBORNE_SHADOW_HALF, 3 * AIRBORNE_SHADOW_HALF])(
    'preserves ordinary ground/airborne units and restores them after clearing an override (height %s)',
    (height) => {
      const nodes = new AtmosphereNodes();
      const scene = new Group();
      const root = new Group();
      const source = new Mesh();
      const shadow = new VoxelShadowMesh(source, nodes);
      const g = 0.4;
      root.position.set(10, g + height, 20);
      root.rotation.y = 0.7;
      root.add(source, shadow);
      scene.add(root);
      setShadowGround(scene, () => g);
      try {
        scene.updateMatrixWorld(true);
        const ordinary = shadow.matrixWorld.clone();
        const local = new Vector3(0.6, 0.3, -0.2);
        const worldOffset = local.clone().applyAxisAngle(new Vector3(0, 1, 0), root.rotation.y);
        const p = local.clone().applyMatrix4(ordinary);
        const airborne = height > AIRBORNE_HEIGHT;
        const scale = airborne ? AIRBORNE_SHADOW_HALF / (AIRBORNE_SHADOW_HALF + height) : 1;
        const shearHeight = worldOffset.y + (airborne ? 0 : height);
        expect(p.x).toBeCloseTo(
          10 +
            (airborne ? AIRBORNE_SHADOW_DRIFT_X * height : 0) +
            scale * (worldOffset.x + SHADOW_SHEAR_X * shearHeight),
          12,
        );
        expect(p.z).toBeCloseTo(
          20 +
            (airborne ? AIRBORNE_SHADOW_DRIFT_Z * height : 0) +
            scale * (worldOffset.z + SHADOW_SHEAR_Z * shearHeight),
          12,
        );
        expect(p.y).toBeCloseTo(g + SHADOW_LIFT, 12);
        const physical = new Vector3(8, g + 0.5, 18);
        setShadowOrigin(root, physical);
        physical.set(100, 100, 100);
        scene.updateMatrixWorld(true);
        const origin = new Vector3().applyMatrix4(shadow.matrixWorld);
        expect(origin.x).toBeCloseTo(8 + SHADOW_SHEAR_X * 0.5, 12);
        expect(origin.z).toBeCloseTo(18 + SHADOW_SHEAR_Z * 0.5, 12);
        setShadowOrigin(root);
        scene.updateMatrixWorld(true);
        expect(shadow.matrixWorld.elements).toEqual(ordinary.elements);
      } finally {
        source.geometry.dispose();
        source.material.dispose();
        nodes.dispose();
      }
    },
  );
});

describe('voxel contact penumbra', () => {
  it('composes the actual material layers to faithful/enhanced darkness, including the cap and hard mode', () => {
    const nodes = new AtmosphereNodes();
    const look = spriteLookFor(nodes);
    const opacity = voxelShadowMaterial(nodes).opacityNode!;
    const frame = new NodeFrame();
    try {
      for (const enabled of [0, 1]) {
        look.enabled.value = enabled;
        for (const multiplier of [0.8, 1, 1.15, 2]) {
          look.shadowDarkness.value = multiplier;
          const target = enabled && multiplier !== 1 ? Math.min(SHADOW_OPACITY * multiplier, 0.9) : SHADOW_OPACITY;
          for (const soft of [false, true]) {
            voxelShadowFor(nodes).soft = soft;
            opacity.update(frame);
            const copies = soft ? SHADOW_COPIES.length : 1;
            const alpha = (opacity as unknown as { value: number }).value;
            expect(alpha).toBe(shadowCopyOpacity(target, copies));
            expect(1 - (1 - alpha) ** copies).toBeCloseTo(target, 14);
            if (soft) expect(alpha).toBeLessThan(target);
          }
        }
      }
    } finally {
      nodes.dispose();
    }
  });

  it('bounds draw cost, uses symmetric world offsets and separates every lifted depth layer', () => {
    expect(SHADOW_COPIES).toHaveLength(5);
    expect(SHADOW_COPIES[0]).toEqual({ x: 0, z: 0, lift: 0 });
    expect(SHADOW_PENUMBRA).toBeGreaterThanOrEqual(0.03);
    expect(SHADOW_PENUMBRA).toBeLessThanOrEqual(0.05);
    expect(SHADOW_COPIES.reduce((sum, c) => sum + c.x, 0)).toBe(0);
    expect(SHADOW_COPIES.reduce((sum, c) => sum + c.z, 0)).toBe(0);
    const iso = new IsoCamera();
    iso.zoom = 2;
    iso.resize(800, 600);
    iso.update();
    const centre = new Vector3().project(iso.camera);
    for (let i = 1; i < SHADOW_COPIES.length; i++) {
      const copy = SHADOW_COPIES[i]!;
      expect(SHADOW_COPIES.some((c) => c.x === -copy.x && c.z === -copy.z)).toBe(true);
      expect(Math.hypot(copy.x, copy.z)).toBe(SHADOW_PENUMBRA);
      const projected = new Vector3(copy.x, 0, copy.z).project(iso.camera).sub(centre);
      expect(Math.hypot(projected.x * 400, projected.y * 300)).toBeGreaterThan(2);
      expect(Math.hypot(projected.x * 400, projected.y * 300)).toBeLessThan(4);
      const increment = copy.lift - SHADOW_COPIES[i - 1]!.lift;
      expect(increment).toBeCloseTo(SHADOW_COPY_LIFT, 14);
      expect(increment).toBeGreaterThan((iso.camera.far - iso.camera.near) / SHADOW_DEPTH_STEPS);
    }
  });

  it.each([0, AIRBORNE_SHADOW_HALF])(
    'shares geometry/materials and preserves ground, flight and physical-origin projection for all copies (height %s)',
    (height) => {
      const nodes = new AtmosphereNodes();
      const otherNodes = new AtmosphereNodes();
      const scene = new Group();
      const geometry = new BufferGeometry();
      const material = new MeshStandardNodeMaterial();
      const unit = instantiateVoxel(
        [
          { role: 'body', turretOffset: 0, geometry },
          { role: 'turret', turretOffset: 0.2, geometry },
        ],
        material,
        nodes,
      );
      unit.root.position.set(10, 0.4 + height, 20);
      unit.root.rotation.y = 0.7;
      unit.turret!.rotation.y = -0.4;
      scene.add(unit.root);
      const twins = unit.root.children.filter((o): o is VoxelShadowMesh => o instanceof VoxelShadowMesh);
      expect(twins).toHaveLength(2 * SHADOW_COPIES.length);
      try {
        for (const normal of [new Vector3(0, 1, 0), new Vector3(0.2, 1, -0.1).normalize()]) {
          setShadowGround(scene, { height: () => 0.4, normal: (_x, _z, out) => out.copy(normal) });
          for (const physical of [undefined, new Vector3(8, 0.9, 18)]) {
            setShadowOrigin(unit.root, physical);
            scene.updateMatrixWorld(true);
            for (const twin of twins) {
              const centre = twins.find((t) => t.source === twin.source && t.copyIndex === 0)!;
              const copy = SHADOW_COPIES[twin.copyIndex]!;
              const n = twin.planeNormal;
              const offset = new Vector3(copy.x, -(n.x * copy.x + n.z * copy.z) / n.y, copy.z).addScaledVector(
                n,
                copy.lift,
              );
              const local = new Vector3(0.6, 0.3, -0.2);
              const p = local.clone().applyMatrix4(twin.matrixWorld);
              expect(p.distanceTo(local.applyMatrix4(centre.matrixWorld).add(offset))).toBeLessThan(1e-12);
              expect(n.dot(p)).toBeCloseTo(twin.planeConstant, 12);
              expect(twin.geometry).toBe(geometry);
              expect(twin.material).toBe(voxelShadowMaterial(nodes));
              const sameLayer = twins.filter((t) => t.copyIndex === twin.copyIndex);
              expect(sameLayer[0]!.planeConstant).toBe(sameLayer[1]!.planeConstant);
              if (twin.copyIndex) expect(twin.renderOrder).toBeGreaterThan(centre.renderOrder);
              expect(twin.visible).toBe(true);
            }
          }
        }
        voxelShadowFor(nodes).soft = false;
        scene.updateMatrixWorld(true);
        expect(twins.filter((t) => t.visible)).toHaveLength(2);
        expect(twins.every((t) => t.visible === (t.copyIndex === 0))).toBe(true);
        expect(voxelShadowFor(otherNodes).soft).toBe(true);
        voxelShadowFor(nodes).soft = true;
        scene.updateMatrixWorld(true);
        expect(twins.every((t) => t.visible)).toBe(true);
      } finally {
        geometry.dispose();
        material.dispose();
        nodes.dispose();
        otherNodes.dispose();
      }
    },
  );
});

describe('analytic voxel shadow depth', () => {
  it.each([WebGLCoordinateSystem, WebGPUCoordinateSystem])(
    'matches flat/ramp depth across targets and camera zoom, covering every 4x MSAA sample (coordinate system %s)',
    (coordinateSystem) => {
      const iso = new IsoCamera();
      iso.camera.coordinateSystem = coordinateSystem;
      iso.target.set(10, 0.4, 20);
      const out = new Vector4();
      for (const zoom of [1, 2, 3]) {
        iso.zoom = zoom;
        iso.resize(800, 600);
        iso.update();
        for (const normal of [new Vector3(0, 1, 0), new Vector3(0.2, 1, -0.1).normalize()]) {
          for (const copy of SHADOW_COPIES) {
            const constant = normal.dot(iso.target) + SHADOW_LIFT + copy.lift;
            expect(shadowPlaneDepth(iso.camera, 1600, 1200, normal, constant, out)).toBe(out);
            for (const [x, z] of [
              [10, 20],
              [12, 18],
              [9, 21],
            ]) {
              const y = (constant - normal.x * x! - normal.z * z!) / normal.y;
              const p = new Vector3(x, y, z).project(iso.camera);
              const sx = (p.x + 1) * 800;
              const sy = (1 - p.y) * 600;
              const depth = coordinateSystem === WebGPUCoordinateSystem ? p.z : (p.z + 1) / 2;
              expect(out.x + out.y * sx + out.z * sy).toBeCloseTo(depth, 12);
              const nearest = Math.floor((depth - out.w) * SHADOW_DEPTH_STEPS) / SHADOW_DEPTH_STEPS;
              for (const [dx, dy] of [
                [-0.125, -0.375],
                [0.375, -0.125],
                [-0.375, 0.125],
                [0.125, 0.375],
              ]) {
                expect(nearest).toBeLessThan(depth + out.y * dx! + out.z * dy!);
              }
            }
          }
        }
      }
    },
  );
});
