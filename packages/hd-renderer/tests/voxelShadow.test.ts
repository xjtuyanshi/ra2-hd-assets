import { describe, expect, it, vi } from 'vitest';
import {
  BackSide,
  BoxGeometry,
  BufferGeometry,
  DoubleSide,
  Group,
  Matrix4,
  Mesh,
  MeshBasicNodeMaterial,
  MeshStandardNodeMaterial,
  NodeFrame,
  Vector3,
  Vector4,
  WebGLCoordinateSystem,
  WebGPUCoordinateSystem,
} from 'three/webgpu';
import { positionGeometry, positionLocal, positionWorld, uniform, vec3 } from 'three/tsl';
import { AtmosphereNodes } from '../src/atmosphere';
import type { ShaderNode } from '../src/tsl';
import { IsoCamera } from '../src/world';
import { spriteLookFor } from '../src/ra2/spriteLook';
import { instantiateVoxel, updateVoxelNativeDepth } from '../src/ra2/voxels';
import { registerVoxelReflectionColour, voxelReflectionColour } from '../src/ra2/voxelReflectionColour';
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
  WATER_FOAM_FORWARD_SCALE,
  WATER_FLAT_REFLECTION_OPACITY,
  WATER_REFLECTION_FADE,
  WATER_REFLECTION_OPACITY,
  applyVoxelShadowParams,
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
  waterFoamProjection,
  waterReflectionProjection,
} from '../src/ra2/voxelShadow';

function graphNodes(root: ShaderNode): Set<ShaderNode> {
  const visited = new Set<ShaderNode>();
  const visit = (node: ShaderNode) => {
    if (visited.has(node)) return;
    visited.add(node);
    for (const child of node.getChildren()) visit(child);
  };
  visit(root);
  return visited;
}

/** Evaluate the material's actual alpha graph at a source vertex; shader compilation is covered by vertexBuffers. */
function sampleWaterAlpha(mesh: VoxelWaterMesh, local: Vector3): number {
  const frame = new NodeFrame();
  frame.object = mesh;
  const alpha = (mesh.material as MeshBasicNodeMaterial).opacityNode!;
  const visited = new Set<ShaderNode>();
  const update = (node: ShaderNode) => {
    if (visited.has(node)) return;
    visited.add(node);
    if (node.isUniformNode && node.updateType !== 'none') node.update(frame);
    for (const child of node.getChildren()) update(child);
  };
  update(alpha);
  const cache = new Map<ShaderNode, number[]>();
  const evaluate = (node: ShaderNode): number[] => {
    const cached = cache.get(node);
    if (cached) return cached;
    let result: number[];
    if (node === positionGeometry || node === positionLocal) result = local.toArray();
    else if (node === positionWorld) result = local.clone().applyMatrix4(mesh.matrixWorld).toArray();
    else if (node.isInputNode) result = typeof node.value === 'number' ? [node.value] : node.value.toArray();
    else if (node.nodes) result = node.nodes.flatMap(evaluate);
    else if (node.components) result = [...node.components].map((c) => evaluate(node.node)['xyzw'.indexOf(c)]!);
    else if (node.isOperatorNode || node.isMathNode) {
      const a = evaluate(node.aNode);
      const b = node.bNode ? evaluate(node.bNode) : [];
      const c = node.cNode ? evaluate(node.cNode) : [];
      if (node.op === '*' && a.length === 16) {
        result = [0, 1, 2, 3].map((row) => b.reduce((sum, v, col) => sum + a[col * 4 + row]! * v, 0));
      } else if (node.method === 'dot') result = [a.reduce((sum, v, i) => sum + v * b[i]!, 0)];
      else
        result = Array.from({ length: Math.max(a.length, b.length, c.length) }, (_, i) => {
          const x = a[i % a.length]!,
            y = b[i % b.length]!,
            z = c[i % c.length]!;
          switch (node.op ?? node.method) {
            case '+':
              return x + y;
            case '-':
              return x - y;
            case '*':
              return x * y;
            case '/':
              return x / y;
            case 'abs':
              return Math.abs(x);
            case 'sin':
              return Math.sin(x);
            case 'floor':
              return Math.floor(x);
            case 'fract':
              return x - Math.floor(x);
            case 'mix':
              return x * (1 - z) + y * z;
            case 'clamp':
              return Math.max(y, Math.min(z, x));
            case 'smoothstep': {
              const t = Math.max(0, Math.min(1, (z - x) / (y - x)));
              return t * t * (3 - 2 * t);
            }
            default:
              throw new Error(`Unsupported alpha operation: ${node.op ?? node.method}`);
          }
        });
    } else if (node.node) result = evaluate(node.node);
    else throw new Error(`Unsupported alpha node: ${node.constructor.name}`);
    cache.set(node, result);
    return result;
  };
  return evaluate(alpha)[0]!;
}

describe('voxel water contact', () => {
  it('parses independent review switches and restores defaults without changing renderer frame inputs', () => {
    const nodes = new AtmosphereNodes();
    const other = new AtmosphereNodes();
    const mode = voxelShadowFor(nodes);
    mode.time = 17;
    mode.toCamera.set(0.2, 0.3, 0.4);
    try {
      for (const hard of [false, true]) {
        for (const old of [false, true]) {
          for (const flat of [false, true]) {
            const params = new URLSearchParams();
            if (hard) params.set('vshadow', 'hard');
            if (old) params.set('vnaval', 'old');
            if (flat) params.set('vrefl', 'flat');
            applyVoxelShadowParams(params, nodes);
            expect(mode).toMatchObject({ soft: !hard, naval: !old, reflection: flat ? 'flat' : 'colour', time: 17 });
            expect(mode.toCamera.toArray()).toEqual([0.2, 0.3, 0.4]);
            expect(voxelShadowFor(other)).toMatchObject({ soft: true, naval: true, reflection: 'colour' });
          }
        }
      }
      for (const params of ['', 'vshadow=unknown&vnaval=unknown&vrefl=unknown']) {
        applyVoxelShadowParams(new URLSearchParams(params), nodes);
        expect(mode).toMatchObject({ soft: true, naval: true, reflection: 'colour' });
      }
    } finally {
      nodes.dispose();
      other.dispose();
    }
  });

  it('caches coloured reflections per source material and renderer, with shared flat/foam fallback and owned disposal', () => {
    const nodes = new AtmosphereNodes();
    const other = new AtmosphereNodes();
    const hull = new MeshStandardNodeMaterial({ color: 0xeeeedd });
    const turret = new MeshStandardNodeMaterial({ color: 0xcc2222 });
    const reflection = voxelWaterMaterial(nodes, 'reflection', hull);
    const turretReflection = voxelWaterMaterial(nodes, 'reflection', turret);
    const otherReflection = voxelWaterMaterial(other, 'reflection', hull);
    const flat = voxelWaterMaterial(nodes, 'reflection');
    const foam = voxelWaterMaterial(nodes, 'foam');
    const disposed = new Map<MeshBasicNodeMaterial, number>();
    for (const material of [reflection, turretReflection, otherReflection, flat, foam]) {
      disposed.set(material, 0);
      material.addEventListener('dispose', () => disposed.set(material, disposed.get(material)! + 1));
    }
    try {
      expect(reflection.name).toBe('voxel-reflection-colour');
      expect(reflection.side).toBe(BackSide);
      expect(flat.side).toBe(DoubleSide);
      expect(foam.side).toBe(DoubleSide);
      expect(reflection.colorNode).not.toBeNull();
      // Weather scene changes multiply the flat/foam base colour too; a null graph would lose that path.
      for (const material of [flat, foam]) {
        const inputs = graphNodes(material.colorNode!);
        expect(inputs.has(nodes.sceneObjectMul)).toBe(true);
        expect([...inputs].some((node) => node.isUniformNode && node.value === material.color)).toBe(true);
      }
      expect(flat.color.toArray()).toEqual([0.16, 0.19, 0.22]);
      expect(new Set([reflection, turretReflection, otherReflection, flat, foam]).size).toBe(5);
      expect(voxelWaterMaterial(nodes, 'reflection', hull)).toBe(reflection);
      expect(voxelWaterMaterial(nodes, 'foam', hull)).toBe(foam);
      expect(voxelWaterMaterial(nodes, 'foam', turret)).toBe(foam);
      applyVoxelShadowParams(new URLSearchParams('vrefl=flat'), nodes);
      expect(voxelWaterMaterial(nodes, 'reflection', hull)).toBe(flat);
      expect(voxelWaterMaterial(nodes, 'reflection', turret)).toBe(flat);
      expect(voxelWaterMaterial(other, 'reflection', hull)).toBe(otherReflection);
      applyVoxelShadowParams(new URLSearchParams(), nodes);
      expect(voxelWaterMaterial(nodes, 'reflection', hull)).toBe(reflection);
      expect(voxelWaterMaterial(nodes, 'reflection', turret)).toBe(turretReflection);
      nodes.dispose();
      for (const material of [reflection, turretReflection, flat, foam]) expect(disposed.get(material)).toBe(1);
      expect(disposed.get(otherReflection)).toBe(0);
      other.dispose();
      expect(disposed.get(otherReflection)).toBe(1);
    } finally {
      nodes.dispose();
      other.dispose();
      hull.dispose();
      turret.dispose();
    }
  });

  it('retains a registered reflection and its cache through native/chrono passes without transferring disposal', () => {
    const nodes = new AtmosphereNodes();
    const source = nodes.own(new MeshStandardNodeMaterial());
    const geometry = new BoxGeometry();
    const build = vi.fn(() => vec3(0.2, 0.3, 0.4));
    registerVoxelReflectionColour(source, build);
    const parts = [{ role: 'body' as const, geometry, turretOffset: 0 }];
    const first = instantiateVoxel(parts, source, nodes);
    const second = instantiateVoxel(parts, source, nodes);
    const mesh = first.root.partMeshes[0]!;
    const reflection = first.root.children.find(
      (child): child is VoxelWaterMesh => child instanceof VoxelWaterMesh && child.layer === 'reflection',
    )!;
    const colour = reflection.material;
    const sourceDispose = vi.spyOn(source, 'dispose');
    const reflectionDispose = vi.spyOn(colour, 'dispose');
    let native: MeshStandardNodeMaterial | undefined;
    let chrono: MeshStandardNodeMaterial | undefined;
    try {
      expect(build).toHaveBeenCalledOnce();
      for (const [enabled, opacity] of [
        [false, 1],
        [true, 1],
        [true, 0.5],
        [false, 0.5],
        [false, 1],
        [true, 1],
      ] as const) {
        first.root.setOpacity(opacity);
        updateVoxelNativeDepth(first, first.root.position, 0, enabled);
        first.root.updateMatrixWorld(true);
        expect(reflection.material).toBe(colour);
        expect(voxelWaterMaterial(nodes, 'reflection', mesh.material as MeshStandardNodeMaterial)).toBe(colour);
        if (opacity < 1) chrono = mesh.material as MeshStandardNodeMaterial;
        else if (enabled) native = mesh.material as MeshStandardNodeMaterial;
        // Exercise the registry directly too, matching the review's isolated API reproduction.
        const matrix = uniform(new Matrix4());
        build.mockClear();
        voxelReflectionColour(mesh.material as MeshStandardNodeMaterial, matrix);
        expect(build).toHaveBeenCalledExactlyOnceWith(matrix);
      }
      second.root.setOpacity(0.5);
      second.root.updateMatrixWorld(true);
      const otherChrono = second.root.partMeshes[0]!.material as MeshStandardNodeMaterial;
      expect(otherChrono).not.toBe(chrono);
      expect(voxelWaterMaterial(nodes, 'reflection', otherChrono)).toBe(colour);
      const nativeDispose = vi.spyOn(native!, 'dispose');
      const chronoDispose = vi.spyOn(chrono!, 'dispose');
      const otherChronoDispose = vi.spyOn(otherChrono, 'dispose');
      first.root.setOpacity(1);
      second.root.setOpacity(1);
      first.root.disposeOpacityMaterials();
      first.root.disposeOpacityMaterials();
      expect(chronoDispose).toHaveBeenCalledOnce();
      expect(otherChronoDispose).not.toHaveBeenCalled();
      expect(nativeDispose).not.toHaveBeenCalled();
      expect(sourceDispose).not.toHaveBeenCalled();
      expect(reflectionDispose).not.toHaveBeenCalled();
      second.root.disposeOpacityMaterials();
      expect(otherChronoDispose).toHaveBeenCalledOnce();
      nodes.dispose();
      nodes.dispose();
      expect(sourceDispose).toHaveBeenCalledOnce();
      expect(nativeDispose).toHaveBeenCalledOnce();
      expect(reflectionDispose).toHaveBeenCalledOnce();
      expect(chronoDispose).toHaveBeenCalledOnce();
      expect(otherChronoDispose).toHaveBeenCalledOnce();
    } finally {
      first.root.disposeOpacityMaterials();
      second.root.disposeOpacityMaterials();
      geometry.dispose();
      nodes.dispose();
    }
  });

  it('switches existing twins between source colours and flat review without changing foam or allocating each frame', () => {
    const nodes = new AtmosphereNodes();
    const source = new Mesh();
    const replacement = new MeshBasicNodeMaterial({ color: 0xff2222 });
    const original = source.material;
    const reflection = new VoxelWaterMesh(source, nodes, 'reflection');
    const foam = new VoxelWaterMesh(source, nodes, 'foam');
    const colour = reflection.material;
    const foamMaterial = foam.material;
    try {
      expect(colour).toBe(voxelWaterMaterial(nodes, 'reflection', original));
      for (const params of ['vrefl=flat', '', 'vrefl=flat', '']) {
        applyVoxelShadowParams(new URLSearchParams(params), nodes);
        for (let frame = 0; frame < 3; frame++) {
          reflection.updateMatrixWorld(true);
          foam.updateMatrixWorld(true);
          expect(reflection.material).toBe(params ? voxelWaterMaterial(nodes, 'reflection') : colour);
          expect(foam.material).toBe(foamMaterial);
        }
      }
      source.material = replacement;
      reflection.updateMatrixWorld(true);
      expect(reflection.material).toBe(voxelWaterMaterial(nodes, 'reflection', replacement));
      expect(reflection.material).not.toBe(colour);
      source.material = original;
      reflection.updateMatrixWorld(true);
      expect(reflection.material).toBe(colour);
    } finally {
      source.geometry.dispose();
      original.dispose();
      replacement.dispose();
      nodes.dispose();
    }
  });

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

  it.each([0, Math.PI / 2, 0.7])('widens foam along the source forward axis at facing %s', (facing) => {
    const origin = new Vector3(12, 1.4, 23);
    const source = new Matrix4().makeRotationY(facing).scale(new Vector3(2, 3, 0.5));
    const forward = new Vector3().setFromMatrixColumn(source, 0).normalize();
    const side = new Vector3().setFromMatrixColumn(source, 2).normalize();
    for (const pulse of [-1, 0, 1]) {
      const out = new Matrix4();
      expect(waterFoamProjection(origin, source, pulse, out)).toBe(out);
      for (const [axis, scale] of [
        [forward, WATER_FOAM_FORWARD_SCALE],
        [side, WATER_FOAM_SCALE],
      ] as const) {
        const projected = origin
          .clone()
          .add(axis)
          .setY(origin.y + 0.3)
          .applyMatrix4(out);
        const expected = origin
          .clone()
          .addScaledVector(axis, scale + 0.02 * pulse)
          .setY(origin.y + SHADOW_LIFT);
        expect(projected.distanceTo(expected)).toBeLessThan(1e-12);
      }
    }
  });

  it('gates foam by unflattened source height with a smooth waterline fade', () => {
    const nodes = new AtmosphereNodes();
    const source = new Mesh();
    const foam = new VoxelWaterMesh(source, nodes, 'foam');
    const unit = new Group();
    const scene = new Group();
    unit.position.set(12, 1.4, 23);
    source.position.y = 0.2;
    unit.add(source, foam);
    scene.add(unit);
    setShadowGround(scene, { height: () => 1.4, waterHeight: () => 1.4 });
    try {
      scene.updateMatrixWorld(true);
      const samples = Array.from(
        { length: 256 },
        (_, i) => new Vector3((i % 16) * 0.025, -0.2, Math.floor(i / 16) * 0.025),
      );
      const at = samples.reduce((a, b) => (sampleWaterAlpha(foam, a) > sampleWaterAlpha(foam, b) ? a : b));
      const full = sampleWaterAlpha(foam, at);
      expect(full).toBeGreaterThan(0);
      for (const [height, gate] of [
        [0.02, 1],
        [0.06, 1],
        [0.1, 0.5],
        [0.14, 0],
        [0.3, 0],
      ]) {
        expect(sampleWaterAlpha(foam, at.clone().setY(height! - 0.2))).toBeCloseTo(full * gate!, 12);
      }
    } finally {
      source.geometry.dispose();
      source.material.dispose();
      nodes.dispose();
    }
  });

  it('keeps noise deterministic on the renderer clock, with broad gaps and slow drift', () => {
    const nodes = new AtmosphereNodes();
    const source = new Mesh();
    const foam = new VoxelWaterMesh(source, nodes, 'foam');
    const mode = voxelShadowFor(nodes);
    const points = Array.from(
      { length: 256 },
      (_, i) => new Vector3((i % 16) * 0.025, 0.02, Math.floor(i / 16) * 0.025),
    );
    try {
      mode.time = 4;
      const first = points.map((p) => sampleWaterAlpha(foam, p));
      expect(points.map((p) => sampleWaterAlpha(foam, p))).toEqual(first);
      expect(first.filter((a) => a === 0).length).toBeGreaterThan(points.length / 5);
      expect(Math.max(...first)).toBeCloseTo(shadowCopyOpacity(WATER_FOAM_OPACITY), 12);
      expect(first.every((a) => a >= 0 && a <= shadowCopyOpacity(WATER_FOAM_OPACITY))).toBe(true);
      mode.time += 1;
      expect(points.map((p) => sampleWaterAlpha(foam, p))).not.toEqual(first);
      mode.time = 4;
      expect(points.map((p) => sampleWaterAlpha(foam, p))).toEqual(first);
    } finally {
      source.geometry.dispose();
      source.material.dispose();
      nodes.dispose();
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

  it.each(['colour', 'flat'] as const)(
    'fades the %s reflection using source height while retaining bounded, clock-driven ripple',
    (variant) => {
      const nodes = new AtmosphereNodes();
      const source = new Mesh();
      const mode = voxelShadowFor(nodes);
      mode.reflection = variant;
      const reflection = new VoxelWaterMesh(source, nodes, 'reflection');
      const unit = new Group();
      const scene = new Group();
      unit.position.set(12, 1.4, 23);
      source.position.y = 0.2;
      source.scale.set(1.5, 2, 0.7);
      source.rotation.y = 0.6;
      unit.add(source, reflection);
      scene.add(unit);
      setShadowGround(scene, { height: () => 1.4, waterHeight: () => 1.4 });
      const opacity = variant === 'colour' ? WATER_REFLECTION_OPACITY : WATER_FLAT_REFLECTION_OPACITY;
      try {
        scene.updateMatrixWorld(true);
        expect(reflection.matrixWorld.determinant()).toBe(0);
        expect(source.matrixWorld.determinant()).toBeGreaterThan(0);
        for (const height of [-1, -WATER_REFLECTION_FADE, -0.25, 0, 0.25, WATER_REFLECTION_FADE, 1]) {
          const local = new Vector3(0.2, (height - 0.2) / 2, -0.1);
          const alpha = sampleWaterAlpha(reflection, local);
          const faded = opacity * Math.max(0, 1 - Math.abs(height) / WATER_REFLECTION_FADE);
          expect(alpha).toBeGreaterThanOrEqual(faded * 0.76 - 1e-12);
          expect(alpha).toBeLessThanOrEqual(faded + 1e-12);
          if (Math.abs(height) >= WATER_REFLECTION_FADE) expect(alpha).toBeCloseTo(0, 12);
        }
        const local = new Vector3(0.2, -0.1, -0.1);
        const first = sampleWaterAlpha(reflection, local);
        mode.time = 1;
        const second = sampleWaterAlpha(reflection, local);
        expect(second).not.toBe(first);
        mode.time = 0;
        expect(sampleWaterAlpha(reflection, local)).toBe(first);
        expect(sampleWaterAlpha(reflection, local.clone().setX(0.23))).not.toBe(first);
        source.position.y += WATER_REFLECTION_FADE;
        scene.updateMatrixWorld(true);
        expect(sampleWaterAlpha(reflection, local)).toBeCloseTo(0, 12);
      } finally {
        source.geometry.dispose();
        source.material.dispose();
        nodes.dispose();
      }
    },
  );

  it.each([WebGLCoordinateSystem, WebGPUCoordinateSystem])(
    'preserves mirrored back-face winding even though the flattened matrix has zero determinant (coordinate system %s)',
    (coordinateSystem) => {
      const iso = new IsoCamera();
      iso.camera.coordinateSystem = coordinateSystem;
      iso.target.set(0, 0, 0);
      iso.resize(800, 600);
      iso.update();
      const view = new Vector3().setFromMatrixColumn(iso.camera.matrixWorld, 2);
      const projection = waterReflectionProjection(iso.target, view, new Matrix4());
      const mirror = new Matrix4().makeScale(1, -1, 1);
      const triangle = [new Vector3(0, 0, 0), new Vector3(0, 1, 0), new Vector3(0, 0, 1)];
      const screenArea = (matrix: Matrix4) => {
        const [a, b, c] = triangle.map((p) => p.clone().applyMatrix4(matrix).project(iso.camera));
        return (b!.x - a!.x) * (c!.y - a!.y) - (b!.y - a!.y) * (c!.x - a!.x);
      };
      expect(screenArea(new Matrix4())).toBeGreaterThan(0);
      expect(screenArea(mirror)).toBeLessThan(0);
      expect(screenArea(projection)).toBeCloseTo(screenArea(mirror), 12);
      expect(mirror.determinant()).toBe(-1);
      // Three cannot infer the winding inversion from this determinant: coloured twins explicitly use BackSide.
      expect(projection.determinant()).toBe(0);
    },
  );

  it.each(['colour', 'flat'] as const)(
    'keeps %s reflection on water and preserves land/flight/override twins',
    (variant) => {
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
      mode.reflection = variant;
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
        const reflection = decals.find((d) => d.layer === 'reflection')!;
        expect(reflection.planeConstant).toBeLessThan(
          Math.min(...decals.filter((d) => d.layer === 'foam').map((d) => d.planeConstant)),
        );
        expect(reflection.renderOrder).toBeLessThan(Math.min(...shadows.map((s) => s.renderOrder)));
        expect(reflection.material).toBe(voxelWaterMaterial(nodes, 'reflection', material));
        const reflectedMaterial = reflection.material as MeshBasicNodeMaterial;
        expect(reflectedMaterial.depthWrite).toBe(true);
        expect(reflectedMaterial.forceSinglePass).toBe(true);
        expect(reflectedMaterial.depthNode).not.toBeNull();
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
    },
  );

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
      const points = Array.from(
        { length: 256 },
        (_, i) => new Vector3((i % 16) * 0.025, 0.02, Math.floor(i / 16) * 0.025),
      );
      for (const pulse of [-1, 0, 1]) {
        foam.foamPulse = pulse;
        const alpha = Math.max(...points.map((p) => sampleWaterAlpha(foam, p)));
        expect(1 - (1 - alpha) ** 5).toBeCloseTo(WATER_FOAM_OPACITY * (1 + 0.03 * pulse), 14);
      }
      expect(WATER_REFLECTION_OPACITY).toBe(0.6);
      expect(WATER_FLAT_REFLECTION_OPACITY).toBe(0.3);
      expect(WATER_REFLECTION_FADE).toBe(0.8);
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
