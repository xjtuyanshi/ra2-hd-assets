import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MaterialBlending,
  Mesh,
  MeshBasicNodeMaterial,
  OrthographicCamera,
  PlaneGeometry,
  RenderTarget,
  Scene,
  WebGPURenderer,
  type RenderPipeline,
} from 'three/webgpu';
import { float, mrt, output, vec3, vec4 } from 'three/tsl';
import { AtmosphereNodes } from '../src/atmosphere';
import { applyLookPreset, HdRenderer } from '../src/HdRenderer';
import { neutralGrade } from '../src/post';
import { bindUnlitSpriteMaterial } from '../src/ra2/unlitSprites';
import { unlitDisplayColour, unlitDisplayFor, updateUnlitDisplay, type UnlitDisplaySettings } from '../src/unlit';
import { createScenario } from '../sandbox/scenario';

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

afterEach(() => vi.unstubAllGlobals());

describe('self-lit clear-day display', () => {
  it('keeps the original material colour available after emitting a black scene output', () => {
    const nodes = new AtmosphereNodes();
    const material = new MeshBasicNodeMaterial();
    material.colorNode = vec4(0.7, 0.56, 0.03, 1);
    bindUnlitSpriteMaterial(material, float(1), nodes);
    const geometry = new PlaneGeometry();
    const renderer = new WebGPURenderer({ canvas: { width: 1, height: 1 } as HTMLCanvasElement });
    renderer.hasFeature = () => false;
    renderer.hasCompatibility = () => false;
    const target = new RenderTarget(1, 1, { count: 2 });
    target.textures[0]!.name = 'output';
    target.textures[1]!.name = 'unlit';
    renderer.setRenderTarget(target);
    renderer.setMRT(mrt({ output, unlit: vec4(0) }));
    try {
      const backend = renderer.backend as unknown as {
        createNodeBuilder(
          mesh: Mesh,
          renderer: WebGPURenderer,
        ): { camera: OrthographicCamera; scene: Scene; build(): void; fragmentShader: string };
      };
      const builder = backend.createNodeBuilder(new Mesh(geometry, material), renderer);
      builder.camera = new OrthographicCamera();
      builder.scene = new Scene();
      builder.build();
      const shader = builder.fragmentShader;
      // Test generated WGSL, not implementation source: the output struct's m0 must not overwrite the material's
      // Output variable before the m1 transform reads it. No browser, shader validator, or GPU is initialized.
      expect(shader.match(/\bOutput = /g)).toHaveLength(1);
      expect(shader).toMatch(/Output\.xyz \* vec3<f32>\( \( 1\.0 - 1\.0 \) \)/);
      const sceneOutput = shader.indexOf('output.m0 =');
      expect(sceneOutput).toBeGreaterThan(0);
      expect(shader.indexOf('Output.xyz * vec3<f32>( object.', sceneOutput)).toBeGreaterThan(sceneOutput);
      expect(shader.indexOf('output.m1 =', sceneOutput)).toBeGreaterThan(sceneOutput);
    } finally {
      material.dispose();
      geometry.dispose();
      target.dispose();
      nodes.dispose();
    }
  });

  it('has no scene event, moon, map, or automatic exposure inputs, and preserves explicit look controls', () => {
    const nodes = new AtmosphereNodes();
    try {
      const settings: UnlitDisplaySettings = {
        toneMapper: 'faithful',
        exposure: 1.2,
        vignette: 0.3,
        ...neutralGrade(),
      };
      updateUnlitDisplay(nodes, settings);
      const display = unlitDisplayFor(nodes);
      const graph = dependencies(unlitDisplayColour(vec3(0.7, 0.56, 0.03), nodes));
      expect(graph.has(display.exposure)).toBe(true);
      expect(graph.has(display.vignette)).toBe(true);
      for (const input of [
        nodes.sceneTerrainMul,
        nodes.sceneObjectMul,
        nodes.sceneLevel,
        nodes.sceneBrightness,
        nodes.night,
        nodes.moonDesaturation,
        nodes.faithfulDisplay,
        nodes.weatherDesaturation,
      ])
        expect(graph.has(input)).toBe(false);
      const snapshot = () => Object.values(display).map((node) => JSON.stringify(node.value));
      const clear = snapshot();
      nodes.night.value = 1;
      nodes.sceneLevel.value.setRGB(0.1, 0.15, 0.3);
      nodes.sceneTerrainMul.value.setRGB(0.261, 0.435, 0.96);
      nodes.moonDesaturation.value = 1;
      nodes.faithfulDisplay.value = 0;
      updateUnlitDisplay(nodes, settings);
      expect(snapshot()).toEqual(clear);
      expect(display.exposure.value).toBe(1.2);
      settings.exposure = 0.8;
      settings.toneMapper = 'aces';
      settings.gradeSaturation = 1.12;
      updateUnlitDisplay(nodes, settings);
      expect(display.exposure.value).toBe(0.8);
      expect(display.toneMapper.value).toBe(3);
      expect(display.gradeSaturation.value).toBe(1.12);
      expect(display.graded.value).toBe(1);
    } finally {
      nodes.dispose();
    }
  });

  it.each([false, true])('composites captured colour outside bloom and scene adaptation, graded=%s', (graded) => {
    vi.stubGlobal('window', { devicePixelRatio: 1 });
    const canvas = {
      width: 1,
      height: 1,
      style: {},
      addEventListener() {},
      removeEventListener() {},
    } as unknown as HTMLCanvasElement;
    const hd = new HdRenderer(canvas, createScenario(2, 2));
    const internal = hd as unknown as {
      world: object | null;
      buildPipeline(): void;
      pipeline: RenderPipeline;
      pipelineNodes: (GraphNode & {
        dispose(): void;
        getMRT(): ReturnType<typeof mrt>;
        getTextureNode(name: string): GraphNode;
      })[];
      settingsPipelineKey(): string;
    };
    try {
      if (graded) applyLookPreset(hd.settings, 'cinematic');
      hd.settings.clarity = 0;
      hd.settings.sharpness = -1;
      hd.settings.antialias = 'none';
      internal.world = {};
      hd.enablePainterDepth();
      hd.applySettings();
      const scene = internal.pipelineNodes[0]!;
      const captured = scene.getTextureNode('unlit');
      const attachments = scene.getMRT();
      expect(attachments.has('unlit')).toBe(true);
      expect(attachments.getBlendMode('unlit').blending).toBe(MaterialBlending);
      expect(Object.keys(attachments.outputNodes)).toHaveLength(graded ? 4 : 3);
      expect(dependencies(internal.pipeline.outputNode).has(captured)).toBe(true);
      expect(dependencies(internal.pipelineNodes[1]!).has(captured)).toBe(false);
      const clearKey = internal.settingsPipelineKey();
      hd.nodes.night.value = 1;
      hd.nodes.sceneTerrainMul.value.setRGB(0.261, 0.435, 0.96);
      expect(internal.settingsPipelineKey()).toBe(clearKey);
      expect(unlitDisplayFor(hd.nodes).exposure.value).toBe(hd.settings.exposure);
      // The unlit attachment uses the main material blend rule, which WebGL's no-indexed-blend fallback preserves.
      const backend = hd.renderer.backend as unknown as { isWebGPUBackend: boolean; drawBuffersIndexedExt?: unknown };
      backend.isWebGPUBackend = false;
      backend.drawBuffersIndexedExt = null;
      internal.buildPipeline();
      expect(internal.pipelineNodes[0]!.getMRT().has('unlit')).toBe(true);
      expect(internal.pipelineNodes[0]!.getMRT().has('emissive')).toBe(false);
    } finally {
      internal.pipeline?.dispose();
      internal.pipelineNodes.forEach((node) => node.dispose());
      hd.emissiveOverlay.dispose();
      hd.nodes.dispose();
    }
  });
});
