import { describe, expect, it, vi } from 'vitest';
import {
  type BufferAttribute,
  type InterleavedBufferAttribute,
  OrthographicCamera,
  Scene,
  Vector3,
  WebGPURenderer,
} from 'three/webgpu';
import { uniform } from 'three/tsl';
import {
  beamFade,
  beamIntensity,
  LiveBeams,
  ribbonPoints,
  waveRings,
  RIBBON_SEGMENTS,
  RING_SEGMENTS,
  BEAM_WIDTHS,
  BEAM_STRANDS,
  BEAM_RIBBON_CAPACITY,
  type LiveRadBeam,
  type LiveWave,
} from '../src/live/beams';
import { engineAnchor } from '../src/live/effectSprites';
import type { LiveEffects } from '../src/live/effects';
import { IsoCamera, LEVEL_HEIGHT, PIXELS_PER_CELL_EDGE } from '../src/world';
import type { DirtyAttribute } from '../src/dirtyAttribute';

const rad: LiveRadBeam = {
  id: 1,
  type: 'rad',
  source: { x: 256, y: 512, z: 104 },
  target: { x: 2304, y: 512, z: 208 },
  color: [40, 255, 80],
  period: 20,
  amplitude: 40,
  age: 10,
  progress: 0.5,
  sustained: false,
};
const wave: LiveWave = {
  id: 2,
  uid: 3,
  type: 'sonic',
  source: rad.source,
  target: rad.target,
  intensity: 50,
  progress: 0.5,
};
const effects = (r: LiveRadBeam[] = [], w: LiveWave[] = []): LiveEffects => ({
  anims: [],
  bullets: [],
  particleSystems: [],
  radBeams: r,
  waves: w,
});
const layer = () => new LiveBeams(uniform(new Vector3(1, 0, 0)), uniform(new Vector3(0, 1, 0)), uniform(0));
const buffers = (beams: LiveBeams) =>
  beams as unknown as { from: DirtyAttribute; to: DirtyAttribute; appearance: DirtyAttribute };

const iso = new IsoCamera();
iso.update();
const right = new Vector3().setFromMatrixColumn(iso.camera.matrixWorld, 0);
const up = new Vector3().setFromMatrixColumn(iso.camera.matrixWorld, 1);
const normal = new Vector3().setFromMatrixColumn(iso.camera.matrixWorld, 2);

function checkEllipses(wave: LiveWave): number[] {
  const from = engineAnchor(wave.source.x, wave.source.y, wave.source.z);
  const to = engineAnchor(wave.target.x, wave.target.y, wave.target.z);
  const delta = to.clone().sub(from);
  const screen = new Vector3(delta.dot(right), delta.dot(up), 0);
  if (screen.lengthSq() < 1e-8) screen.set(1, 0, 0);
  screen.normalize();
  const along = right.clone().multiplyScalar(screen.x).addScaledVector(up, screen.y);
  const across = right.clone().multiplyScalar(-screen.y).addScaledVector(up, screen.x);
  return waveRings(wave).map((ring) => {
    expect(ring).toHaveLength(RING_SEGMENTS + 1);
    expect(ring[0]).toEqual(ring.at(-1));
    const centre = ring
      .slice(0, -1)
      .reduce((sum, p) => sum.add(p), new Vector3())
      .divideScalar(RING_SEGMENTS);
    // Each centre stays on its own source->target segment, including height, rather than an offset ground row.
    const t = delta.lengthSq() ? centre.clone().sub(from).dot(delta) / delta.lengthSq() : 0;
    expect(t).toBeGreaterThanOrEqual(-1e-10);
    expect(t).toBeLessThanOrEqual(1 + 1e-10);
    expect(centre.distanceTo(from.clone().lerp(to, t))).toBeLessThan(1e-10);
    const radius = ring[0]!.distanceTo(centre);
    for (const point of ring) {
      const offset = point.clone().sub(centre);
      expect(offset.dot(normal)).toBeCloseTo(0, 10);
      expect((offset.dot(across) / radius) ** 2 + (offset.dot(along) / (0.2 * radius)) ** 2).toBeCloseTo(1, 10);
    }
    return radius;
  });
}

describe('HD native beam geometry and publications', () => {
  it('pins the engine endpoints, bounds the sinusoidal amplitude and uses Period to phase the ribbon', () => {
    const points = ribbonPoints(rad),
      from = engineAnchor(256, 512, 104),
      to = engineAnchor(2304, 512, 208);
    expect(points).toHaveLength(RIBBON_SEGMENTS + 1);
    expect(points[0]).toEqual(from);
    expect(points.at(-1)).toEqual(to);
    const offsets = points.map((p, i) => p.distanceTo(from.clone().lerp(to, i / RIBBON_SEGMENTS)));
    expect(Math.max(...offsets)).toBeGreaterThan(0.1);
    expect(Math.max(...offsets)).toBeLessThanOrEqual(engineAnchor(40, 0, 0).length() + 1e-10);
    expect(ribbonPoints({ ...rad, amplitude: 0 })[20]).toEqual(from.clone().lerp(to, 20 / RIBBON_SEGMENTS));
    expect(ribbonPoints({ ...rad, period: 40 })[20]).not.toEqual(points[20]);
    const secondary = ribbonPoints(rad, Math.PI);
    expect(secondary[0]).toEqual(from);
    expect(secondary.at(-1)).toEqual(to);
    points.forEach((p, i) => {
      expect(
        p
          .clone()
          .add(secondary[i]!)
          .multiplyScalar(0.5)
          .distanceTo(from.clone().lerp(to, i / RIBBON_SEGMENTS)),
      ).toBeLessThan(1e-10);
    });
  });

  it('draws six growing sonic ellipses in the actual camera plane and advances their centres with engine progress', () => {
    const rings = waveRings(wave);
    expect(rings).toHaveLength(6);
    const radii = checkEllipses(wave);
    const from = engineAnchor(wave.source.x, wave.source.y, wave.source.z);
    const to = engineAnchor(wave.target.x, wave.target.y, wave.target.z);
    radii.forEach((radius, i) => {
      const centre = rings[i]!.slice(0, -1)
        .reduce((sum, p) => sum.add(p), new Vector3())
        .divideScalar(RING_SEGMENTS);
      expect(radius).toBeCloseTo(0.4 * (0.6 + (0.8 * centre.distanceTo(from)) / to.distanceTo(from)), 10);
    });
    expect(waveRings({ ...wave, progress: 0.6 })[0]).not.toEqual(rings[0]);
  });

  it('draws seven pulsing magnetron ellipses and handles oblique, vertical, camera-parallel and coincident endpoints', () => {
    const magnetron: LiveWave = { ...wave, type: 'magnetron' };
    expect(waveRings(magnetron)).toHaveLength(7);
    for (const progress of [0, 0.25, 0.5, 0.75, 1]) {
      const radii = checkEllipses({ ...magnetron, progress });
      expect(Math.min(...radii)).toBeGreaterThanOrEqual(0.27 * 0.8 - 1e-10);
      expect(Math.max(...radii)).toBeLessThanOrEqual(0.27 * 1.2 + 1e-10);
    }
    expect(waveRings({ ...magnetron, progress: 0.6 })[0]).not.toEqual(waveRings(magnetron)[0]);
    for (const target of [
      { x: 1800, y: 2000, z: 700 },
      { ...rad.source, z: 600 },
      rad.source,
      { x: 256 + normal.x * 256, y: 512 + normal.z * 256, z: 104 + (normal.y * 104) / LEVEL_HEIGHT },
    ]) {
      checkEllipses({ ...magnetron, target });
    }
    const points = ribbonPoints({ ...rad, target: { ...rad.source, z: 600 } });
    expect(points.every((p) => p.toArray().every(Number.isFinite))).toBe(true);
    expect(
      waveRings({ ...wave, target: wave.source })
        .flat()
        .every((p) => p.toArray().every(Number.isFinite)),
    ).toBe(true);
  });

  it('uploads two strands, zoom-proportional 12/4/1.5px profiles, specified colours and centred endpoint flares/splash', () => {
    expect(BEAM_STRANDS).toBe(2);
    for (const type of ['rad', 'temporal', 'eruption'] as const) {
      const beams = layer();
      beams.update(effects([{ ...rad, type }]), 'enhanced', () => false);
      expect(beams.mesh.count).toBe(BEAM_STRANDS * RIBBON_SEGMENTS + 8);
      const { appearance: a, from, to } = buffers(beams);
      const profile = (n: number) => [6, 7, 8].map((component) => a.getComponent(n, component) * PIXELS_PER_CELL_EDGE);
      [12, 4, 1.5].forEach((width, i) => expect(profile(0)[i]).toBeCloseTo(width, 5));
      [12, 4, 1.5].forEach((width, i) => expect(profile(64)[i]).toBeCloseTo(width * 0.7, 5));
      expect(a.getComponent(64, 9) / a.getComponent(0, 9)).toBeCloseTo(0.45, 5);
      expect(a.getComponent(0, 6)).toBeCloseTo(BEAM_WIDTHS.halo, 6);
      const expected = type === 'rad' ? [0.45, 1, 0.2] : type === 'temporal' ? [0.5, 0.82, 1] : [1, 0.22, 0.035];
      expected.forEach((color, i) => expect(a.getComponent(0, i)).toBeCloseTo(color, 6));
      for (const [n, endpoint, scale] of [
        [128, rad.source, 1.8],
        [129, rad.target, 3],
      ] as const) {
        const point = engineAnchor(endpoint.x, endpoint.y, endpoint.z);
        expect(new Vector3().fromBufferAttribute(from, n).distanceTo(point)).toBeLessThan(1e-6);
        expect(new Vector3().fromBufferAttribute(to, n).distanceTo(point)).toBeLessThan(1e-6);
        expect(a.getComponent(n, 6)).toBeCloseTo(BEAM_WIDTHS.halo * scale, 6);
      }
      expect(a.getComponent(63, 10)).toBeGreaterThan(a.getComponent(0, 10));
      beams.dispose();
    }
  });

  it('gives magnetron a 60% beam and target-bright hoops while sonic has only translucent ripples and a faint core-free streak', () => {
    const beams = layer();
    beams.update(effects([], [{ ...wave, type: 'magnetron' }]), 'enhanced', () => false);
    expect(beams.mesh.count).toBe(2 * RIBBON_SEGMENTS + 8 + 7 * RING_SEGMENTS);
    const { appearance: a } = buffers(beams);
    expect(a.getComponent(0, 6)).toBeCloseTo(BEAM_WIDTHS.halo * 0.6, 6);
    const ringStart = 2 * RIBBON_SEGMENTS + 8;
    // At progress .5, ring zero is at .8 and ring two has wrapped to the source region.
    expect(a.getComponent(ringStart, 9)).toBeGreaterThan(a.getComponent(ringStart + 2 * RING_SEGMENTS, 9));
    beams.update(effects([], [wave]), 'enhanced', () => false);
    expect(beams.mesh.count).toBe(1 + 6 * RING_SEGMENTS);
    expect(a.getComponent(0, 9)).toBeCloseTo(0.06, 6);
    expect(a.getComponent(0, 7)).toBe(0);
    for (let n = 0; n < beams.mesh.count; n++) expect(a.getComponent(n, 8)).toBe(0);
    expect(a.getComponent(1, 9)).toBeCloseTo(0.25, 6);
    const { from, to } = buffers(beams);
    expect(
      new Vector3().fromBufferAttribute(from, 0).distanceTo(engineAnchor(wave.source.x, wave.source.y, wave.source.z)),
    ).toBeLessThan(1e-6);
    expect(
      new Vector3().fromBufferAttribute(to, 0).distanceTo(engineAnchor(wave.target.x, wave.target.y, wave.target.z)),
    ).toBeLessThan(1e-6);
    beams.dispose();
  });

  it('keeps travelling intensity noise deterministic, gentle, seed-dependent and independent of wall time', () => {
    const samples = Array.from({ length: 256 }, (_, i) => beamIntensity(i / 15, i / 20, rad.id));
    expect(samples).toEqual(Array.from({ length: 256 }, (_, i) => beamIntensity(i / 15, i / 20, rad.id)));
    expect(Math.min(...samples)).toBeGreaterThanOrEqual(0.88);
    expect(Math.max(...samples)).toBeLessThanOrEqual(1.12);
    expect(beamIntensity(0.25, 1, 1)).not.toBe(beamIntensity(0.5, 1, 1));
    expect(beamIntensity(0.25, 1, 1)).not.toBe(beamIntensity(0.25, 1, 2));
    expect(beamIntensity(0.25, 1, 1)).toBeCloseTo(beamIntensity(0.25 + 9 / 8, 2, 1), 10);
  });

  it('compiles the actual WebGPU vertex layout with all appearance fields sharing one buffer', () => {
    const beams = layer();
    const renderer = new WebGPURenderer({ canvas: { width: 1, height: 1 } as HTMLCanvasElement });
    renderer.hasFeature = () => false;
    renderer.hasCompatibility = () => false;
    type Attribute = BufferAttribute | InterleavedBufferAttribute;
    const backend = renderer.backend as unknown as {
      capabilities: { getUniformBufferLimit(): number };
      createNodeBuilder: (
        mesh: typeof beams.mesh,
        renderer: WebGPURenderer,
      ) => {
        camera: OrthographicCamera;
        scene: Scene;
        build(): void;
        getAttributesArray(): { name: string; node?: { attribute?: Attribute } }[];
      };
      attributeUtils: { createShaderVertexBuffers: (object: { getAttributes(): Attribute[] }) => unknown[] };
    };
    backend.capabilities.getUniformBufferLimit = () => 65536;
    const builder = backend.createNodeBuilder(beams.mesh, renderer);
    builder.camera = iso.camera;
    builder.scene = new Scene();
    builder.build();
    const attributes = builder
      .getAttributesArray()
      .map((a) => a.node?.attribute ?? beams.mesh.geometry.getAttribute(a.name)) as Attribute[];
    const layouts = backend.attributeUtils.createShaderVertexBuffers({ getAttributes: () => attributes });
    expect(layouts).toHaveLength(4);
    expect(attributes.length).toBeLessThanOrEqual(16);
    const packed = attributes.filter((a): a is InterleavedBufferAttribute => 'isInterleavedBufferAttribute' in a);
    expect(packed).toHaveLength(6);
    expect(new Set(packed.map((a) => a.data)).size).toBe(1);
    beams.dispose();
  });

  it('fades finite effects with engine progress without host ageing of sustained beams', () => {
    expect([0, 0.5, 1].map((p) => beamFade(p))).toEqual([1, 0.5, 0]);
    expect(beamFade(1, true)).toBeGreaterThan(0.8);
    expect(beamFade(2)).toBe(0);
  });

  it('replaces same-frame life/endpoints, clears removal, shares additive depth-tested geometry and disposes it', () => {
    const beams = layer(),
      visible = () => false;
    beams.update(effects([rad], [wave]), 'faithful', visible);
    expect(beams.mesh.count).toBe(2 * RIBBON_SEGMENTS + 8 + 1 + 6 * RING_SEGMENTS);
    const flush = vi.spyOn((beams as unknown as { from: { flush(): void } }).from, 'flush');
    beams.update(effects([rad], [wave]), 'faithful', visible);
    expect(flush).not.toHaveBeenCalled();
    beams.update(effects([{ ...rad, target: { ...rad.target, x: 2560 } }]), 'faithful', visible);
    expect(flush).toHaveBeenCalledOnce();
    beams.update(effects([{ ...rad, progress: 1 }]), 'faithful', visible);
    expect(beams.mesh.visible).toBe(false);
    beams.update(effects([rad]), 'enhanced', visible);
    expect(beams.mesh.count).toBe(2 * RIBBON_SEGMENTS + 8);
    beams.update(undefined, 'enhanced', visible);
    expect(beams.mesh.count).toBe(0);
    const disposeGeometry = vi.spyOn(beams.mesh.geometry, 'dispose');
    const disposeMaterial = vi.spyOn(beams.mesh.material as { dispose(): void }, 'dispose');
    beams.dispose();
    expect(disposeGeometry).toHaveBeenCalledOnce();
    expect(disposeMaterial).toHaveBeenCalledOnce();
  });

  it('bounds GPU uploads and re-evaluates shroud visibility on an unchanged publication', () => {
    const beams = layer(),
      many = effects(Array.from({ length: 100 }, (_, id) => ({ ...rad, id })));
    beams.update(many, 'faithful', () => false);
    expect(beams.mesh.count).toBe(BEAM_RIBBON_CAPACITY);
    beams.update(many, 'faithful', () => true);
    expect(beams.mesh.count).toBe(0);
    beams.dispose();
  });
});
