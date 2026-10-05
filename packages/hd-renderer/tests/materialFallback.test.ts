import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BoxGeometry,
  Color,
  DataTexture,
  Group,
  Mesh,
  MeshBasicNodeMaterial,
  Scene,
  Vector3,
  type Material,
} from 'three/webgpu';
import { HdRenderer } from '../src/HdRenderer';
import type { Lighting } from '../src/lighting';
import {
  applyMaterialFallbacks,
  failedPipelineMaterials,
  materialIdOfPipelineLabel,
  setMaterialFallback,
  type PipelineHost,
} from '../src/materialFallback';
import { createWaterUniforms } from '../src/waterShading';
import { buildRain, buildSnow } from '../src/weather';
import { createScenario } from '../sandbox/scenario';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const idOf = (material: Material): number => (material as Material & { id: number }).id;

describe('refused pipelines', () => {
  it("reads the material id from three's pipeline label", () => {
    expect(materialIdOfPipelineLabel('renderPipeline_MeshStandardNodeMaterial_21')).toBe(21);
    // A material's own name may contain underscores and digits; the id is the last field.
    expect(materialIdOfPipelineLabel('renderPipeline_ra2_terrain_2_ground_1307')).toBe(1307);
    for (const label of ['', null, undefined, 'computePipeline_x_3', 'renderPipeline_NoId', 'renderPipeline__x'])
      expect(materialIdOfPipelineLabel(label)).toBeNull();
  });

  it('lists the materials of pipelines whose backend data is marked refused, and only those', () => {
    const pipelines = [{ key: 'a' }, { key: 'b' }, { key: 'c' }, { key: 'd' }];
    const data = new Map<unknown, { error?: boolean; pipeline?: { label?: string } | null }>([
      [pipelines[0], { pipeline: { label: 'renderPipeline_MeshStandardNodeMaterial_21' } }],
      [pipelines[1], { error: true, pipeline: { label: 'renderPipeline_MeshStandardNodeMaterial_21' } }],
      [pipelines[2], { error: true, pipeline: { label: 'renderPipeline_SpriteNodeMaterial_7' } }],
      // Refused before the GPU object existed (three's asynchronous path): nothing names the material.
      [pipelines[3], { error: true, pipeline: null }],
    ]);
    const renderer: PipelineHost = {
      _pipelines: { caches: new Map(pipelines.map((pipeline) => [pipeline.key, pipeline])) },
      backend: { get: (object) => data.get(object) },
    };
    expect([...failedPipelineMaterials(renderer)].sort((a, b) => a - b)).toEqual([7, 21]);
    data.get(pipelines[1])!.error = false;
    expect([...failedPipelineMaterials(renderer)]).toEqual([7]);
  });

  it('reports nothing for a renderer without these internals (not initialised, another backend or version)', () => {
    for (const renderer of [
      {},
      { _pipelines: null, backend: null },
      { _pipelines: {}, backend: { get: () => ({ error: true }) } },
      { _pipelines: { caches: new Map([['a', {}]]) }, backend: {} },
      { _pipelines: { caches: new Map([['a', {}]]) }, backend: { get: () => undefined } },
    ] as PipelineHost[])
      expect(failedPipelineMaterials(renderer).size).toBe(0);
  });
});

describe('material stand-ins', () => {
  const box = new BoxGeometry();

  it('swaps a refused material for its stand-in in every mesh that draws it, single or per group', () => {
    const refused = new MeshBasicNodeMaterial();
    const healthy = new MeshBasicNodeMaterial();
    const standIn = new MeshBasicNodeMaterial();
    const build = vi.fn(() => standIn);
    setMaterialFallback(refused, build);
    const scene = new Scene();
    const single = new Mesh(box, refused);
    const grouped = new Mesh(box, [healthy, refused]);
    const untouched = new Mesh(box, healthy);
    const nested = new Group();
    nested.add(grouped);
    scene.add(single, nested, untouched);

    // Nothing refused: nothing built, nothing changed.
    expect(applyMaterialFallbacks(scene, new Set())).toEqual([]);
    expect(applyMaterialFallbacks(scene, new Set([idOf(healthy) + 1000]))).toEqual([]);
    expect(build).not.toHaveBeenCalled();

    const swaps = applyMaterialFallbacks(scene, new Set([idOf(refused)]));
    expect(swaps).toEqual([{ from: refused, to: standIn }]);
    expect(build).toHaveBeenCalledTimes(1); // one stand-in shared by both meshes
    expect(single.material).toBe(standIn);
    expect(grouped.material).toEqual([healthy, standIn]);
    expect(untouched.material).toBe(healthy);

    // The refused pipeline stays in three's cache: later polls find nothing left to swap.
    expect(applyMaterialFallbacks(scene, new Set([idOf(refused)]))).toEqual([]);
    expect(build).toHaveBeenCalledTimes(1);
  });

  it('leaves a refused material without a stand-in in place and asks its builder only once', () => {
    const plain = new MeshBasicNodeMaterial();
    const hopeless = new MeshBasicNodeMaterial();
    const build = vi.fn(() => null);
    setMaterialFallback(hopeless, build);
    const scene = new Scene();
    const a = new Mesh(box, plain);
    const b = new Mesh(box, hopeless);
    scene.add(a, b);
    const failed = new Set([idOf(plain), idOf(hopeless)]);
    expect(applyMaterialFallbacks(scene, failed)).toEqual([]);
    expect(applyMaterialFallbacks(scene, failed)).toEqual([]);
    expect(a.material).toBe(plain);
    expect(b.material).toBe(hopeless);
    expect(build).toHaveBeenCalledTimes(1);
  });

  it('walks a ladder one rung per refusal', () => {
    const full = new MeshBasicNodeMaterial();
    const lighter = new MeshBasicNodeMaterial();
    const plain = new MeshBasicNodeMaterial();
    setMaterialFallback(full, () => {
      setMaterialFallback(lighter, () => plain);
      return lighter;
    });
    const scene = new Scene();
    const mesh = new Mesh(box, full);
    scene.add(mesh);
    // Even if both ids are already known as refused, a mesh only ever leaves the material it actually draws.
    applyMaterialFallbacks(scene, new Set([idOf(full)]));
    expect(mesh.material).toBe(lighter);
    applyMaterialFallbacks(scene, new Set([idOf(full), idOf(lighter)]));
    expect(mesh.material).toBe(plain);
    applyMaterialFallbacks(scene, new Set([idOf(full), idOf(lighter), idOf(plain)]));
    expect(mesh.material).toBe(plain);
  });
});

describe('renderer polling', () => {
  it('swaps the stand-in of a refused material into the scene within a quarter of a second of frames', () => {
    vi.stubGlobal('window', { devicePixelRatio: 1 });
    const canvas = { width: 1, height: 1, style: {}, addEventListener() {}, removeEventListener() {} };
    const hd = new HdRenderer(canvas as unknown as HTMLCanvasElement, createScenario(2, 2));
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
      water: { uniforms: createWaterUniforms() },
      rain: buildRain(2, 2, height, 0, hd.nodes),
      snow: buildSnow(2, 2, height, 0, hd.nodes),
      lightField: { update: vi.fn(), dynamicLights: () => [] },
      renderPipeline: vi.fn(),
    });
    const internals = hd as unknown as { lighting: Lighting; noonIrradiance: Color };
    internals.lighting.update(12, 0);
    internals.lighting.flatIrradianceColor(internals.noonIrradiance);

    const ground = new MeshBasicNodeMaterial();
    const standIn = new MeshBasicNodeMaterial();
    setMaterialFallback(ground, () => standIn);
    const mesh = new Mesh(new BoxGeometry(), ground);
    hd.scene.add(mesh);
    // What three r186 leaves behind when the GPU refuses a pipeline: an entry in the pipeline cache whose backend
    // data carries `error`, and a GPU pipeline object labelled with the material.
    const refused = { cacheKey: 'ground' };
    let reported = false;
    Object.assign(hd.renderer, { _pipelines: { caches: new Map([['ground', refused]]) } });
    vi.spyOn(hd.renderer.backend as unknown as { get(object: unknown): unknown }, 'get').mockImplementation((object) =>
      object === refused && reported
        ? { error: true, pipeline: { label: `renderPipeline_MeshBasicNodeMaterial_${idOf(ground)}` } }
        : {},
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    for (let i = 0; i < 30; i++) hd.frame(0);
    expect(mesh.material).toBe(ground); // nothing refused: nothing swapped, nothing logged
    expect(warn).not.toHaveBeenCalled();

    reported = true; // the validation error arrives asynchronously, some frames after the first draw
    let frames = 0;
    while (mesh.material === ground && frames < 60) {
      hd.frame(0);
      frames++;
    }
    expect(mesh.material).toBe(standIn);
    expect(frames).toBeLessThanOrEqual(15);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain('[HD] the GPU refused');
    // The refused pipeline stays in three's cache; later polls neither swap nor warn again.
    for (let i = 0; i < 30; i++) hd.frame(0);
    expect(mesh.material).toBe(standIn);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
