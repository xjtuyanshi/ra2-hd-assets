import { describe, expect, it, vi } from 'vitest';
import { Group, Mesh, Scene } from 'three/webgpu';
import { AtmosphereNodes } from '../src/atmosphere';
import { HdRenderer } from '../src/HdRenderer';
import { voxelShadowFor } from '../src/ra2/voxelShadow';

/** An HdRenderer with only what the tier and warm-up logic touches (no GPU): the pipeline build is recorded. */
function renderer(settings: Record<string, unknown> = {}) {
  const nodes = new AtmosphereNodes();
  const scene = new Scene();
  const topScene = new Scene();
  const drawn: { mist: boolean; pipeline: object; visible: boolean[]; top: boolean }[] = [];
  const watched: Mesh[] = [];
  const state = {
    pipeline: {},
    pipelineKey: '',
    settings: {
      antialias: 'edges',
      toneMapper: 'faithful',
      sharpness: 0,
      debugView: 'none',
      clarity: 0.55,
      ...settings,
    },
    bufferScale: 2,
    world: null,
    nodes,
    scene,
    topScene,
    topEffectsVisible: false,
    topEffectsPass: true,
    topEffectsStale: false,
    qualityTier: 0,
    drawnTier: 0,
    softShadows: null,
    warmQueue: null,
    warmMist: null,
    warmSlicer: null,
    warmClock: () => performance.now(),
    mistInPipeline: false,
    mist: { amount: { value: 0 } },
    outlineSearch: 12,
    retiredPipelines: [],
    parkedPipelines: new Map(),
    pipelineNodes: [],
    mainPasses: [],
    view: { camera: {} },
    effects: { heatShimmer: true },
    clarityAmount: { value: 0.55 },
    terrain: { mirrorAtlas: { warm: vi.fn() } },
    terrainDepth: { warm: vi.fn(), setMainPass: vi.fn() },
    renderer: { getPixelRatio: () => 1, backend: {} },
  };
  const hd = Object.assign(Object.create(HdRenderer.prototype), state) as HdRenderer;
  const internal = hd as unknown as {
    buildPipeline(fresh?: boolean): void;
    settingsPipelineKey(): string;
    renderPipeline(): void;
    renderWarmFrame(): void;
    pipeline: object;
    warmSlicer: object | null;
    warmClock: () => number;
    pipelineKey: string;
    pipelineNodes: object[];
    mainPasses: { renderTarget: { dispose(): void } }[];
    parkedPipelines: Map<string, { pipeline: object }>;
    drawnTier: number;
    topEffectsStale: boolean;
    topEffectsPass: boolean;
    mistInPipeline: boolean;
    warmQueue: boolean[] | null;
    retiredPipelines: { pipeline: object }[];
    switchPipeline(): void;
    disposeRetiredPipelines(): void;
  };
  /** Render targets of scene passes given up so far, by the graph they belong to. */
  const released: object[] = [];
  const graph = () => {
    const pipeline = { dispose: vi.fn() };
    internal.pipeline = pipeline;
    internal.pipelineNodes = [];
    internal.mainPasses = [{ renderTarget: { dispose: () => void released.push(pipeline) } }];
    internal.pipelineKey = internal.settingsPipelineKey();
    return pipeline;
  };
  // What the real build does to the renderer's state: a new graph for the settings and tier in use.
  const build = vi.spyOn(internal, 'buildPipeline').mockImplementation((fresh = true) => {
    if (fresh) {
      // As the real build: what drew and what was parked wait for the new graph's first frame.
      internal.retiredPipelines.push({ pipeline: internal.pipeline }, ...internal.parkedPipelines.values());
      internal.parkedPipelines.clear();
    }
    graph();
    internal.mistInPipeline = internal.settingsPipelineKey().includes('"mist"');
  });
  graph();
  const render = vi.spyOn(internal, 'renderPipeline').mockImplementation(() => {
    drawn.push({
      mist: internal.mistInPipeline,
      pipeline: internal.pipeline,
      visible: watched.map((mesh) => mesh.visible),
      top: internal.topEffectsStale,
    });
  });
  /** Warm frames until the warm-up is through: the slice frames first, then one full frame per form. */
  const warmThrough = () => {
    for (let i = 0; hd.warming && i < 1000; i++) internal.renderWarmFrame();
  };
  return { hd, internal, build, render, drawn, watched, scene, topScene, nodes, state, released, warmThrough };
}

describe('quality tiers of the frame-time safeguard', () => {
  it('gives up the heat shimmer first, then soft unit shadows, and never touches the post graph', () => {
    const { hd, internal, build, nodes, state, released } = renderer();
    const shadows = voxelShadowFor(nodes);
    expect(shadows.soft).toBe(true);
    const full = internal.pipeline;
    const key = internal.settingsPipelineKey();
    expect(hd.quality).toBe(0);
    expect(hd.qualityTiers).toBe(HdRenderer.QUALITY_TIERS);
    expect(HdRenderer.QUALITY_TIERS).toBe(3);
    // The outline pass is part of the graph at every tier.
    expect(JSON.parse(key)[0]).toBe('edges12');

    hd.setQualityTier(1);
    expect(state.effects.heatShimmer).toBe(false);
    expect(shadows.soft).toBe(true);
    expect(internal.settingsPipelineKey()).toBe(key);

    // Hard unit shadows: the same passes again.
    hd.setQualityTier(2);
    expect(shadows.soft).toBe(false);
    expect(internal.settingsPipelineKey()).toBe(key);
    expect(state.clarityAmount.value).toBe(0.55);

    // Out of range is the nearest tier; the same tier again does nothing.
    hd.setQualityTier(9);
    hd.setQualityTier(2);
    expect(hd.quality).toBe(HdRenderer.QUALITY_TIERS - 1);

    // Back up: everything returns.
    hd.setQualityTier(0);
    expect(shadows.soft).toBe(true);
    expect(state.effects.heatShimmer).toBe(true);
    hd.setQualityTier(2);
    hd.setQualityTier(Number.NaN);
    expect(hd.quality).toBe(0);
    // No tier built, parked or released anything.
    expect(build).not.toHaveBeenCalled();
    expect(internal.pipeline).toBe(full);
    expect(internal.parkedPipelines.size).toBe(0);
    expect(released).toEqual([]);
  });

  it('leaves settings alone that a tier has nothing to give up from', () => {
    // Hard shadows chosen by the user stay hard after the tier is left; no anti-aliasing setting is changed.
    for (const antialias of ['edges', 'msaa4', 'fxaa', 'none']) {
      const { hd, internal, nodes } = renderer({ antialias, clarity: 0 });
      const shadows = voxelShadowFor(nodes);
      shadows.soft = false;
      const key = internal.settingsPipelineKey();
      expect(JSON.parse(key)[0]).toBe(antialias === 'edges' ? 'edges12' : antialias);
      hd.setQualityTier(2);
      expect(internal.settingsPipelineKey()).toBe(key);
      hd.setQualityTier(0);
      expect(shadows.soft).toBe(false);
    }
  });

  it('keeps the graphs with and without mist, and returns to one without building', () => {
    const { internal, build, state, released } = renderer();
    const clear = internal.pipeline;
    const clearKey = internal.pipelineKey;
    // Mist starts (frame() sees the amount and changes graph).
    state.mist.amount.value = 0.05;
    expect(internal.settingsPipelineKey()).not.toBe(clearKey);
    internal.switchPipeline();
    expect(build).toHaveBeenCalledTimes(1);
    expect(build).toHaveBeenLastCalledWith(false);
    const misty = internal.pipeline;
    expect(misty).not.toBe(clear);
    expect(internal.mistInPipeline).toBe(true);
    // The clear graph is parked, not disposed, and gave up its scene target.
    expect(internal.parkedPipelines.get(clearKey)?.pipeline).toBe(clear);
    expect(released).toEqual([clear]);
    expect((clear as { dispose: ReturnType<typeof vi.fn> }).dispose).not.toHaveBeenCalled();
    // Mist ends: the parked graph draws again; nothing is built.
    state.mist.amount.value = 0;
    internal.switchPipeline();
    expect(build).toHaveBeenCalledTimes(1);
    expect(internal.pipeline).toBe(clear);
    expect(internal.pipelineKey).toBe(clearKey);
    expect(internal.mistInPipeline).toBe(false);
    expect(released).toEqual([clear, misty]);
    expect(state.terrainDepth.setMainPass).toHaveBeenCalledTimes(1);
    expect(internal.topEffectsStale).toBe(true);
    // And again.
    state.mist.amount.value = 0.05;
    internal.switchPipeline();
    expect(build).toHaveBeenCalledTimes(1);
    expect(internal.pipeline).toBe(misty);
    expect(internal.mistInPipeline).toBe(true);
  });

  it('disposes a replaced graph only after the graph that replaced it has drawn', () => {
    const { internal } = renderer();
    // The real build and the real frame end, with stand-ins for what they touch.
    const old = { dispose: vi.fn() };
    const oldNode = { dispose: vi.fn() };
    const parked = { pipeline: { dispose: vi.fn() }, nodes: [{ dispose: vi.fn() }], mainPasses: [] };
    internal.retiredPipelines.push({ pipeline: old, nodes: [oldNode], mainPasses: [] } as never, parked as never);
    expect(old.dispose).not.toHaveBeenCalled();
    internal.disposeRetiredPipelines();
    expect(old.dispose).toHaveBeenCalledTimes(1);
    expect(oldNode.dispose).toHaveBeenCalledTimes(1);
    expect(parked.pipeline.dispose).toHaveBeenCalledTimes(1);
    expect(parked.nodes[0]!.dispose).toHaveBeenCalledTimes(1);
    expect(internal.retiredPipelines).toEqual([]);
    // Nothing left to dispose a second time.
    internal.disposeRetiredPipelines();
    expect(old.dispose).toHaveBeenCalledTimes(1);
  });

  it('warms one frame per form of the post graph, with everything hidden made visible and the top pass in', () => {
    const { hd, internal, build, drawn, watched, scene, topScene, state, warmThrough } = renderer();
    internal.topEffectsPass = false;
    const before = internal.pipeline;
    const shown = new Mesh();
    const idle = new Mesh();
    idle.visible = false;
    const group = new Group();
    group.visible = false;
    const inside = new Mesh();
    group.add(inside);
    const top = new Mesh();
    top.visible = false;
    scene.add(shown, idle, group);
    topScene.add(top);
    watched.push(shown, idle, inside, top);

    expect(hd.warming).toBe(false);
    hd.warm();
    expect(hd.warming).toBe(true);
    // The top pass joins the graph before anything is shown: one rebuild, the graph without it retired.
    expect(hd.topEffectsEnabled).toBe(true);
    expect(build).toHaveBeenCalledTimes(1);
    expect(build).toHaveBeenLastCalledWith();
    expect(internal.retiredPipelines.map((graph) => graph.pipeline)).toEqual([before]);
    const clear = internal.pipeline;
    // Two frames: with mist (the form the frame does not have now), then without (the one in use, which stays).
    expect(internal.warmQueue).toEqual([true, false]);
    // The governor may ask for a tier meanwhile: tiers change no graph.
    hd.setQualityTier(1);
    expect(internal.drawnTier).toBe(1);
    warmThrough();
    expect(hd.warming).toBe(false);
    // The slices (see the slicing test) draw in the first form, then come the two full frames.
    const full = drawn.slice(-2);
    const slices = drawn.slice(0, -2);
    expect(slices.length).toBeGreaterThan(0);
    for (const frame of slices) expect(frame.mist).toBe(true);
    expect(full.map((frame) => frame.mist)).toEqual([true, false]);
    expect(full[0]!.pipeline).not.toBe(clear);
    expect(full[0]!.pipeline).toBe(slices[0]!.pipeline);
    expect(full[1]!.pipeline).toBe(clear);
    for (const frame of full) {
      // Hidden meshes, the children of a hidden group and top-layer art were all drawn; the top pass was forced.
      expect(frame.visible).toEqual([true, true, true, true]);
      expect(frame.top).toBe(true);
    }
    // And hidden again afterwards, exactly as before.
    expect([shown.visible, idle.visible, group.visible, inside.visible, top.visible]).toEqual([
      true,
      false,
      false,
      true,
      false,
    ]);
    expect(state.terrainDepth.warm).toHaveBeenCalledTimes(drawn.length);
    expect(state.terrain.mirrorAtlas.warm).toHaveBeenCalledTimes(drawn.length);
    expect(hd.quality).toBe(1);
    // The misty graph was built once and is parked; the one in use was taken back from where it was parked.
    expect(build).toHaveBeenCalledTimes(2);
    expect(internal.pipeline).toBe(clear);
    expect(internal.mistInPipeline).toBe(false);
    expect(internal.parkedPipelines.size).toBe(1);
    // A second request while warming is ignored; one after it starts again and builds nothing new.
    hd.warm();
    hd.warm();
    expect(internal.warmQueue).toEqual([true, false]);
    warmThrough();
    expect(build).toHaveBeenCalledTimes(2);
    expect(internal.pipeline).toBe(clear);
  });

  it('warms a misty map the other way round: the clear form first, the misty one in use last', () => {
    const { hd, internal, drawn, state, warmThrough } = renderer();
    state.mist.amount.value = 0.05;
    internal.buildPipeline();
    const misty = internal.pipeline;
    hd.warm();
    expect(internal.warmQueue).toEqual([false, true]);
    warmThrough();
    // An empty scene has no slice: just the two full frames.
    expect(drawn.map((frame) => frame.mist)).toEqual([false, true]);
    expect(internal.pipeline).toBe(misty);
    expect(internal.mistInPipeline).toBe(true);
  });

  it('gives up warming when a hidden object cannot be drawn, and leaves the scene as it was', () => {
    const { hd, internal, render, scene } = renderer();
    const idle = new Mesh();
    idle.visible = false;
    scene.add(idle);
    const before = internal.pipeline;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    render.mockImplementationOnce(() => {
      throw new Error('not ready');
    });
    hd.warm();
    internal.renderWarmFrame();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(hd.warming).toBe(false);
    expect(idle.visible).toBe(false);
    // Back on the graph of the form in use.
    expect(internal.pipeline).toBe(before);
    expect(internal.mistInPipeline).toBe(false);
    warn.mockRestore();
  });

  it('builds a running match a few material groups per frame, then draws the full warm frames', () => {
    const { hd, internal, render, drawn, watched, scene, state } = renderer();
    // Thirty objects with materials of their own (as many kinds of art), half of them hidden, one inside a hidden
    // group; three more share one material and build together.
    const meshes: Mesh[] = [];
    const hiddenGroup = new Group();
    hiddenGroup.visible = false;
    scene.add(hiddenGroup);
    for (let i = 0; i < 30; i++) {
      const mesh = new Mesh();
      mesh.visible = i % 2 === 0;
      (i === 7 ? hiddenGroup : scene).add(mesh);
      meshes.push(mesh);
    }
    const shared = new Mesh().material;
    for (let i = 0; i < 3; i++) {
      const mesh = new Mesh(undefined, shared);
      scene.add(mesh);
      meshes.push(mesh);
    }
    watched.push(...meshes);
    const before = meshes.map((mesh) => mesh.visible);
    // A frame costs 3 ms per object drawn in it (what three's first builds cost, scaled down).
    let clock = 0;
    internal.warmClock = () => clock;
    render.mockImplementation(() => {
      const visible = meshes.map((mesh) => mesh.visible && (mesh.parent?.visible ?? true));
      drawn.push({ mist: internal.mistInPipeline, pipeline: internal.pipeline, visible, top: true });
      clock += 3 * visible.filter(Boolean).length;
    });
    hd.warm();
    internal.renderWarmFrame();
    // The first frame draws one group, not the whole match.
    expect(drawn[0]!.visible.filter(Boolean).length).toBe(1);
    for (let i = 0; hd.warming && i < 100; i++) internal.renderWarmFrame();
    expect(hd.warming).toBe(false);
    const slices = drawn.slice(0, -2);
    const full = drawn.slice(-2);
    // 31 groups (30 own materials, 1 shared by three) at 12 ms: about four groups a frame, each object in one slice.
    expect(slices.length).toBeGreaterThanOrEqual(8);
    expect(slices.length).toBeLessThanOrEqual(12);
    for (const frame of slices) expect(frame.visible.filter(Boolean).length * 3).toBeLessThanOrEqual(18);
    for (let m = 0; m < meshes.length; m++) expect(slices.filter((frame) => frame.visible[m]).length).toBe(1);
    // The three objects of the shared material were drawn in the same slice.
    const sharedSlice = slices.findIndex((frame) => frame.visible[30]);
    expect(slices[sharedSlice]!.visible.slice(30)).toEqual([true, true, true]);
    // The full frames still draw everything, as before, and the scene is left as it was.
    for (const frame of full) expect(frame.visible.every(Boolean)).toBe(true);
    expect(meshes.map((mesh) => mesh.visible)).toEqual(before);
    expect(hiddenGroup.visible).toBe(false);
    expect(state.terrainDepth.warm).toHaveBeenCalledTimes(slices.length + 2);
  });

  it('draws the rest of a warm-up in full frames once the host asks it to finish', () => {
    const { hd, internal, drawn, watched, scene } = renderer();
    for (let i = 0; i < 20; i++) {
      const mesh = new Mesh();
      scene.add(mesh);
      watched.push(mesh);
    }
    hd.warm();
    internal.renderWarmFrame();
    expect(drawn[0]!.visible.filter(Boolean).length).toBe(1);
    hd.finishWarm();
    internal.renderWarmFrame();
    internal.renderWarmFrame();
    expect(hd.warming).toBe(false);
    expect(drawn.length).toBe(3);
    expect(drawn[1]!.visible.every(Boolean)).toBe(true);
    expect(drawn[2]!.visible.every(Boolean)).toBe(true);
  });
});
