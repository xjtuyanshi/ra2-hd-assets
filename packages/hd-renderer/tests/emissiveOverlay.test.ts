import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BlendMode,
  MaterialBlending,
  MeshBasicNodeMaterial,
  NormalBlending,
  OrthographicCamera,
  PlaneGeometry,
  RenderTarget,
  Scene,
  Vector3,
  WebGPURenderer,
} from 'three/webgpu';
import { mrt, output, vec4 } from 'three/tsl';
import {
  EmissiveOverlay,
  emissiveMrtSupported,
  strokeWorldWidth,
  type EmissiveDisc,
  type EmissiveStroke,
} from '../src/emissiveOverlay';
import { HdRenderer, applyLookPreset, emissiveOverlayEnabled } from '../src/HdRenderer';
import { BUILDING_LIGHTS } from '../src/live/buildingLights';
import { InstancedQuad } from '../src/instancedQuad';
import { createScenario } from '../sandbox/scenario';
import { PIXELS_PER_CELL_EDGE } from '../src/world';

const disc: EmissiveDisc = {
  centre: new Vector3(2, 1, 3),
  orb: BUILDING_LIGHTS.NAPOWR![0]!.orb!,
  push: 1.2,
  seed: 0.5,
  alpha: 1,
  brightness: 1,
};
const stroke: EmissiveStroke = {
  points: [new Vector3(1, 2, 3), new Vector3(2, 2, 3), new Vector3(2, 3, 3)],
  width: 1.3,
  core: [0.7, 0.8, 1],
  edge: [0.03, 0.15, 1],
  alpha: 0.9,
};

afterEach(() => vi.unstubAllGlobals());

describe('emissive primitive buffers and render exclusion', () => {
  it('requires a backend with independent attachment blending', () => {
    const supported = (backend: object) => emissiveMrtSupported({ backend } as WebGPURenderer);
    expect(supported({ isWebGPUBackend: true })).toBe(true);
    expect(supported({ drawBuffersIndexedExt: {} })).toBe(true);
    expect(supported({ drawBuffersIndexedExt: null })).toBe(false);
  });
  it('uses alpha-over after beams with depth testing but no depth writes', () => {
    const overlay = new EmissiveOverlay(PIXELS_PER_CELL_EDGE);
    try {
      for (const mesh of [overlay.discs, overlay.strokes]) {
        expect(mesh.material.blending).toBe(NormalBlending);
        expect(mesh.material.transparent).toBe(true);
        expect(mesh.material.depthTest).toBe(true);
        expect(mesh.material.depthWrite).toBe(false);
        expect(mesh.renderOrder).toBeGreaterThan(7);
        expect(mesh.material.mrtNode!.has('emissive')).toBe(true);
        expect(mesh.material.mrtNode!.has('output')).toBe(true);
      }
      expect(strokeWorldWidth(1.3, PIXELS_PER_CELL_EDGE) * PIXELS_PER_CELL_EDGE * 2).toBeCloseTo(2.6);
    } finally {
      overlay.dispose();
    }
  });
  it('bounds uploads, emits one capsule per segment and reuses buffer identity across setters', () => {
    const overlay = new EmissiveOverlay(PIXELS_PER_CELL_EDGE, 1, 2);
    const internal = overlay as unknown as {
      discData: { array: Float32Array; version: number; updateRanges: { start: number; count: number }[] };
      strokeData: { array: Float32Array; version: number; updateRanges: { start: number; count: number }[] };
    };
    try {
      const discs = internal.discData.array;
      const strokes = internal.strokeData.array;
      overlay.setDiscs([disc, disc]);
      overlay.setStrokes([stroke, stroke]);
      expect(overlay.discs.count).toBe(1);
      expect(overlay.strokes.count).toBe(2);
      const discVersion = internal.discData.version;
      const strokeVersion = internal.strokeData.version;
      overlay.setDiscs([disc]);
      overlay.setStrokes([stroke]);
      expect(internal.discData.array).toBe(discs);
      expect(internal.strokeData.array).toBe(strokes);
      expect(internal.discData.version).toBe(discVersion);
      expect(internal.strokeData.version).toBe(strokeVersion);
      const discRange = internal.discData.updateRanges[0];
      const strokeRange = internal.strokeData.updateRanges[0];
      internal.discData.updateRanges.length = internal.strokeData.updateRanges.length = 0;
      overlay.setDiscs([{ ...disc, brightness: 0.95 }]);
      overlay.setStrokes([{ ...stroke, alpha: 0.8 }]);
      expect(internal.discData.updateRanges[0]).toBe(discRange);
      expect(internal.strokeData.updateRanges[0]).toBe(strokeRange);
      expect(strokes[3]).toBeCloseTo(1.3 / PIXELS_PER_CELL_EDGE);
      overlay.setDiscs([]);
      overlay.setStrokes([]);
      expect(overlay.discs.count).toBe(0);
      expect(overlay.strokes.count).toBe(0);
    } finally {
      overlay.dispose();
    }
  });
  it('removes meshes from no-MRT and no-emissive lists, restoring the main pass after nested mirrors', () => {
    const overlay = new EmissiveOverlay(PIXELS_PER_CELL_EDGE);
    const renderer = {
      getMRT: vi.fn(),
      getRenderTarget: vi.fn(() => ({ textures: [{ name: 'output' }, { name: 'emissive' }] })),
    } as unknown as WebGPURenderer;
    const getMRT = vi.mocked(renderer.getMRT);
    try {
      overlay.setEnabled(true);
      getMRT.mockReturnValue(mrt({ output, emissive: vec4(0) }));
      overlay.beginRender(renderer);
      expect(overlay.root.visible).toBe(true);
      getMRT.mockReturnValue(null);
      overlay.beginRender(renderer);
      expect(overlay.root.visible).toBe(false);
      overlay.endRender();
      expect(overlay.root.visible).toBe(true);
      overlay.endRender();
      expect(overlay.root.visible).toBe(true);
      getMRT.mockReturnValue(mrt({ output }));
      overlay.beginRender(renderer);
      expect(overlay.root.visible).toBe(false);
      overlay.endRender();
      getMRT.mockReturnValue(mrt({ output, emissive: vec4(0) }));
      vi.mocked(renderer.getRenderTarget).mockReturnValue({ textures: [{ name: 'output' }] } as RenderTarget);
      overlay.beginRender(renderer);
      expect(overlay.root.visible).toBe(false);
      overlay.endRender();
      overlay.setEnabled(false);
      getMRT.mockReturnValue(mrt({ output, emissive: vec4(0) }));
      overlay.beginRender(renderer);
      expect(overlay.root.visible).toBe(false);
      overlay.endRender();
    } finally {
      overlay.dispose();
    }
  });
});

/** Build r186's actual WGSL/MRT layouts without a browser/device; GPU validation remains the reviewer's. */
function buildShader(mesh: InstancedQuad, attachments: ReturnType<typeof mrt> | null) {
  const renderer = new WebGPURenderer({ canvas: { width: 1, height: 1 } as HTMLCanvasElement });
  renderer.hasFeature = () => false;
  renderer.hasCompatibility = () => false;
  const target = new RenderTarget(1, 1, { count: attachments ? 3 : 1 });
  target.textures[0]!.name = 'output';
  if (attachments) {
    target.textures[1]!.name = 'emissive';
    target.textures[2]!.name = 'physicalDepth';
  }
  renderer.setRenderTarget(target);
  renderer.setMRT(attachments);
  const backend = renderer.backend as unknown as {
    capabilities: { getUniformBufferLimit(): number };
    createNodeBuilder(
      mesh: InstancedQuad,
      renderer: WebGPURenderer,
    ): {
      camera: OrthographicCamera;
      scene: Scene;
      build(): void;
      fragmentShader: string;
      vertexShader: string;
      getAttributesArray(): { name: string; node?: { attribute?: unknown } }[];
    };
    attributeUtils: { createShaderVertexBuffers(object: { getAttributes(): unknown[] }): unknown[] };
  };
  backend.capabilities.getUniformBufferLimit = () => 65536;
  const builder = backend.createNodeBuilder(mesh, renderer);
  builder.camera = new OrthographicCamera(-1, 1, 1, -1, 0.1, 400);
  builder.scene = new Scene();
  builder.build();
  const attrs = builder.getAttributesArray().map((a) => a.node?.attribute ?? mesh.geometry.getAttribute(a.name));
  const buffers = backend.attributeUtils.createShaderVertexBuffers({ getAttributes: () => attrs });
  target.dispose();
  return {
    fragment: builder.fragmentShader,
    vertex: builder.vertexShader,
    buffers: buffers.length,
    attributes: attrs.length,
  };
}

describe('emissive MRT shader graphs', () => {
  it('builds both primitive shaders with the combined painter-depth/emissive MRT within WebGPU layout limits', () => {
    const overlay = new EmissiveOverlay(PIXELS_PER_CELL_EDGE);
    try {
      const attachments = mrt({ output, emissive: vec4(0, 0, 0, output.a), physicalDepth: vec4(0) }).setBlendMode(
        'emissive',
        new BlendMode(MaterialBlending),
      );
      for (const mesh of [overlay.discs, overlay.strokes]) {
        const shader = buildShader(mesh, attachments);
        expect(shader.fragment).toContain('@location( 2 )');
        expect(shader.fragment).not.toContain('NaN');
        expect(shader.buffers).toBeLessThanOrEqual(8);
        expect(shader.attributes).toBeLessThanOrEqual(16);
      }
    } finally {
      overlay.dispose();
    }
  });
  it('defaults emission to zero RGB and final output alpha for ordinary foreground materials', () => {
    const m = new MeshBasicNodeMaterial();
    m.transparent = true;
    m.colorNode = vec4(1, 0, 0, 0.4);
    const mesh = new InstancedQuad(m, 1, new PlaneGeometry(1, 1));
    try {
      const shader = buildShader(mesh, mrt({ output, emissive: vec4(0, 0, 0, output.a), physicalDepth: vec4(0) }));
      expect(shader.fragment).toMatch(/vec4<f32>\( 0\.0, 0\.0, 0\.0, Output\.w \)/);
    } finally {
      mesh.geometry.dispose();
      m.dispose();
    }
  });
});

type GraphNode = { getChildren(): Iterable<GraphNode> };
function dependencies(root: GraphNode): Set<GraphNode> {
  const found = new Set<GraphNode>();
  const visit = (node: GraphNode): void => {
    if (found.has(node)) return;
    found.add(node);
    for (const child of node.getChildren()) visit(child);
  };
  visit(root);
  return found;
}

describe('overlay pipeline choice', () => {
  function fixture() {
    vi.stubGlobal('window', { devicePixelRatio: 2 });
    const canvas = {
      width: 1,
      height: 1,
      style: {},
      addEventListener() {},
      removeEventListener() {},
    } as unknown as HTMLCanvasElement;
    const hd = new HdRenderer(canvas, createScenario(2, 2));
    const internal = hd as unknown as {
      buildPipeline(): void;
      settingsPipelineKey(): string;
      pipelineNodes: {
        dispose(): void;
        getMRT?(): ReturnType<typeof mrt> | null;
        getTextureNode?(name: string): GraphNode;
      }[];
      pipeline: { dispose(): void; outputNode: GraphNode };
    };
    return {
      hd,
      internal,
      dispose: () => {
        internal.pipeline?.dispose();
        internal.pipelineNodes.forEach((n) => n.dispose());
        hd.emissiveOverlay.dispose();
        hd.nodes.dispose();
      },
    };
  }
  it.each([false, true])('composites emission outside bloom with graded=%s, including the night branch', (graded) => {
    const { hd, internal, dispose } = fixture();
    try {
      if (graded) applyLookPreset(hd.settings, 'cinematic');
      else hd.settings.sourceLights = 1;
      hd.settings.clarity = 0;
      hd.settings.sharpness = -1;
      hd.settings.antialias = 'none';
      internal.buildPipeline();
      const emission = internal.pipelineNodes[0]!.getTextureNode!('emissive');
      expect(dependencies(internal.pipeline.outputNode).has(emission)).toBe(true);
      expect(dependencies(internal.pipelineNodes[1] as unknown as GraphNode).has(emission)).toBe(false);
      const key = internal.settingsPipelineKey();
      hd.nodes.night.value = 1;
      expect(internal.settingsPipelineKey()).toBe(key);
      expect(dependencies(internal.pipeline.outputNode).has(emission)).toBe(true);
    } finally {
      dispose();
    }
  });
  it('leaves the faithful key and graph overlay-free, including after toggling from cinematic', () => {
    const { hd, internal, dispose } = fixture();
    try {
      const original = internal.settingsPipelineKey();
      hd.applySettings();
      expect(hd.nodes.localLightCap.value).toBe(0);
      expect(JSON.parse(original)).toHaveLength(6);
      expect(internal.pipelineNodes[0]!.getMRT?.()).toBeNull();
      expect(hd.emissiveOverlay.root.visible).toBe(false);
      applyLookPreset(hd.settings, 'cinematic');
      hd.applySettings();
      expect(hd.nodes.localLightCap.value).toBe(1);
      expect(internal.settingsPipelineKey()).toContain('emissive');
      expect(internal.pipelineNodes[0]!.getMRT?.()?.has('emissive')).toBe(true);
      applyLookPreset(hd.settings, 'faithful');
      hd.applySettings();
      expect(hd.nodes.localLightCap.value).toBe(0);
      expect(internal.settingsPipelineKey()).toBe(original);
      expect(internal.pipelineNodes[0]!.getMRT?.()).toBeNull();
    } finally {
      dispose();
    }
  });
  it('disables the overlay for debug views, sourceLights 0 and the WebGL fallback', () => {
    expect(emissiveOverlayEnabled({ sourceLights: 1, debugView: 'none' }, true)).toBe(true);
    expect(emissiveOverlayEnabled({ sourceLights: 0, debugView: 'none' }, true)).toBe(false);
    expect(emissiveOverlayEnabled({ sourceLights: 1, debugView: 'none' }, false)).toBe(false);
    for (const debugView of ['overbright', 'voxel-xy', 'voxel-z'] as const)
      expect(emissiveOverlayEnabled({ sourceLights: 1, debugView }, true)).toBe(false);
  });
});
