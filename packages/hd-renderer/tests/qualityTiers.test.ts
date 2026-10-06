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
  const drawn: { tier: number; visible: boolean[]; top: boolean }[] = [];
  const watched: Mesh[] = [];
  const state = {
    pipeline: {},
    pipelineKey: '',
    settings: {
      antialias: 'msaa4',
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
    pipelineKey: string;
    pipelineNodes: object[];
    mainPasses: { renderTarget: { dispose(): void } }[];
    parkedPipelines: Map<string, { pipeline: object }>;
    drawnTier: number;
    topEffectsStale: boolean;
    warmQueue: number[] | null;
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
    if (fresh) internal.parkedPipelines.clear();
    graph();
  });
  graph();
  const render = vi.spyOn(internal, 'renderPipeline').mockImplementation(() => {
    drawn.push({
      tier: internal.drawnTier,
      visible: watched.map((mesh) => mesh.visible),
      top: internal.topEffectsStale,
    });
  });
  return { hd, internal, build, render, drawn, watched, scene, topScene, nodes, state, released };
}

describe('quality tiers of the frame-time safeguard', () => {
  it('gives up the heat shimmer first, then multisampling, then soft unit shadows', () => {
    const { hd, internal, build, nodes, state, released } = renderer();
    const shadows = voxelShadowFor(nodes);
    expect(shadows.soft).toBe(true);
    const full = internal.pipeline;
    const keys: string[] = [internal.settingsPipelineKey()];
    expect(hd.quality).toBe(0);
    expect(hd.qualityTiers).toBe(HdRenderer.QUALITY_TIERS);

    hd.setQualityTier(1);
    expect(state.effects.heatShimmer).toBe(false);
    // Nothing of the post graph changes: no rebuild, no new render targets.
    expect(build).not.toHaveBeenCalled();
    keys.push(internal.settingsPipelineKey());
    expect(keys[1]).toBe(keys[0]);

    // Without multisampling: another post graph. It is built once; the one that drew is parked, not disposed, and
    // gives up its scene target.
    hd.setQualityTier(2);
    expect(build).toHaveBeenCalledTimes(1);
    expect(build).toHaveBeenLastCalledWith(false);
    keys.push(internal.settingsPipelineKey());
    expect(keys[2]).not.toBe(keys[1]);
    expect(JSON.parse(keys[2]!)[0]).toBe('none');
    const lean = internal.pipeline;
    expect(lean).not.toBe(full);
    expect(internal.parkedPipelines.get(keys[0]!)?.pipeline).toBe(full);
    expect(released).toEqual([full]);
    expect((full as { dispose: ReturnType<typeof vi.fn> }).dispose).not.toHaveBeenCalled();
    expect(shadows.soft).toBe(true);

    // Hard unit shadows: the same passes again.
    hd.setQualityTier(3);
    expect(build).toHaveBeenCalledTimes(1);
    expect(internal.settingsPipelineKey()).toBe(keys[2]);
    expect(shadows.soft).toBe(false);
    expect(state.clarityAmount.value).toBe(0.55);

    // Out of range is the nearest tier; the same tier again does nothing.
    hd.setQualityTier(9);
    hd.setQualityTier(3);
    expect(hd.quality).toBe(HdRenderer.QUALITY_TIERS - 1);

    // Back up: everything returns, and the parked graph draws again without anything being built.
    hd.setQualityTier(0);
    expect(build).toHaveBeenCalledTimes(1);
    expect(internal.pipeline).toBe(full);
    expect(internal.pipelineKey).toBe(keys[0]);
    expect(internal.parkedPipelines.get(keys[2]!)?.pipeline).toBe(lean);
    expect(released).toEqual([full, lean]);
    expect(state.terrainDepth.setMainPass).toHaveBeenCalledTimes(1);
    expect(internal.topEffectsStale).toBe(true);
    expect(shadows.soft).toBe(true);
    expect(state.effects.heatShimmer).toBe(true);
    // And down again: the lean graph comes back the same way.
    hd.setQualityTier(2);
    expect(build).toHaveBeenCalledTimes(1);
    expect(internal.pipeline).toBe(lean);
    hd.setQualityTier(Number.NaN);
    expect(hd.quality).toBe(0);
    expect(internal.pipeline).toBe(full);
  });

  it('leaves settings alone that a tier has nothing to give up from', () => {
    // Hard shadows chosen by the user stay hard after the tier is left; FXAA and no anti-aliasing are not changed.
    for (const antialias of ['fxaa', 'none']) {
      const { hd, internal, nodes } = renderer({ antialias, clarity: 0 });
      const shadows = voxelShadowFor(nodes);
      shadows.soft = false;
      const key = internal.settingsPipelineKey();
      hd.setQualityTier(3);
      expect(internal.settingsPipelineKey()).toBe(key);
      hd.setQualityTier(0);
      expect(shadows.soft).toBe(false);
    }
  });

  it('warms one frame per set of passes, with everything hidden made visible, and ends on the tier in use', () => {
    const { hd, internal, build, drawn, watched, scene, topScene, state } = renderer();
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
    // Tiers 0 and 1 draw the same passes, and so do 2 and 3: two frames (without multisampling, then the tier in use).
    expect(internal.warmQueue).toEqual([3, 0]);
    // The governor may ask for a tier meanwhile: it is applied when the warm frames are done.
    hd.setQualityTier(1);
    expect(internal.drawnTier).toBe(0);
    for (let i = 0; i < 2; i++) internal.renderWarmFrame();
    expect(hd.warming).toBe(false);
    expect(drawn.map((frame) => frame.tier)).toEqual([3, 0]);
    for (const frame of drawn) {
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
    expect(state.terrainDepth.warm).toHaveBeenCalledTimes(2);
    expect(state.terrain.mirrorAtlas.warm).toHaveBeenCalledTimes(2);
    expect(internal.drawnTier).toBe(1);
    expect(hd.quality).toBe(1);
    // The graph without multisampling was built once, and the one in use was taken back from where it was parked.
    expect(build).toHaveBeenCalledTimes(1);
    // A second request while warming is ignored; one after it starts again.
    hd.warm();
    hd.warm();
    expect(internal.warmQueue).toEqual([3, 1]);
  });

  it('gives up warming when a hidden object cannot be drawn, and leaves the scene as it was', () => {
    const { hd, internal, render, scene } = renderer();
    const idle = new Mesh();
    idle.visible = false;
    scene.add(idle);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    render.mockImplementationOnce(() => {
      throw new Error('not ready');
    });
    hd.warm();
    internal.renderWarmFrame();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(hd.warming).toBe(false);
    expect(idle.visible).toBe(false);
    expect(internal.drawnTier).toBe(0);
    warn.mockRestore();
  });
});
