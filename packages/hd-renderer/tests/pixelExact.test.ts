import { describe, expect, it, vi } from 'vitest';
import { Vector2 } from 'three/webgpu';
import { HdRenderer, applyLookPreset } from '../src/HdRenderer';
import { LiveView, snapToPixelGrid, type LiveSnapshot } from '../src/live/liveView';
import { IsoCamera, PIXELS_PER_CELL_EDGE } from '../src/world';
import { createScenario } from '../sandbox/scenario';

/** LiveView's sizing and camera methods on a stand-in renderer (no GPU, no caches). */
function liveView() {
  const size = new Vector2(1, 1);
  const renderer = {
    setSize: vi.fn((width: number, height: number) => size.set(Math.floor(width * 2), Math.floor(height * 2))),
    setDrawingBufferSize: vi.fn((width: number, height: number, ratio: number) =>
      size.set(Math.floor(width * ratio), Math.floor(height * ratio)),
    ),
    getDrawingBufferSize: (target: Vector2) => target.copy(size),
  };
  const hd = { renderer, view: new IsoCamera(), setBufferScale: vi.fn() };
  const view = Object.assign(Object.create(LiveView.prototype), { hd, bufferSize: new Vector2(), bufferScale: 1 }) as {
    hd: typeof hd;
    resize(cssWidth: number, cssHeight: number, viewWidth: number, viewHeight: number): void;
    resizePixels(bufferWidth: number, bufferHeight: number, viewWidth: number, viewHeight: number): void;
    applyCamera(from: LiveSnapshot['view'], to: LiveSnapshot['view'], alpha: number): void;
  };
  /** The view's left edge in engine pixels, back from the camera target. */
  const viewX = (viewWidth: number) => (hd.view.target.x - hd.view.target.z) * 30 - viewWidth / 2;
  return { view, hd, renderer, viewX };
}

describe('pixel-exact live view', () => {
  it('snaps a value to the drawing-buffer pixel grid and leaves it alone without a usable scale', () => {
    expect(snapToPixelGrid(10.37, 2)).toBe(10.5);
    expect(snapToPixelGrid(10.2, 2)).toBe(10);
    expect(snapToPixelGrid(-3.26, 2)).toBe(-3.5);
    expect(snapToPixelGrid(10.37, 1)).toBe(10);
    expect(snapToPixelGrid(10.37, 3)).toBeCloseTo(10 + 1 / 3, 12);
    expect(snapToPixelGrid(10.37, 0)).toBe(10.37);
    expect(snapToPixelGrid(10.37, Number.NaN)).toBe(10.37);
  });

  it('sizes the drawing buffer in its own pixels and frames the camera in engine pixels', () => {
    const { view, hd, renderer } = liveView();
    view.resizePixels(3120, 2096, 1560, 1048);
    expect(renderer.setDrawingBufferSize).toHaveBeenCalledExactlyOnceWith(3120, 2096, 1);
    expect(hd.setBufferScale).toHaveBeenLastCalledWith(2);
    expect(hd.view.camera.right - hd.view.camera.left).toBeCloseTo(1560 / PIXELS_PER_CELL_EDGE, 9);
    expect(hd.view.camera.top - hd.view.camera.bottom).toBeCloseTo(1048 / PIXELS_PER_CELL_EDGE, 9);
    // A fractional request (a host scaling a huge rectangle down to its pixel budget) becomes whole pixels.
    view.resizePixels(2858.4, 2066.6, 984, 712);
    expect(renderer.setDrawingBufferSize).toHaveBeenLastCalledWith(2858, 2067, 1);
    expect(hd.setBufferScale).toHaveBeenLastCalledWith(2858 / 984);
  });

  it('keeps reporting device pixels per engine pixel when sized through CSS pixels and the pixel ratio', () => {
    const { view, hd, renderer } = liveView();
    view.resize(1476, 1068, 984, 712);
    expect(renderer.setSize).toHaveBeenCalledExactlyOnceWith(1476, 1068, false);
    expect(hd.setBufferScale).toHaveBeenLastCalledWith(3);
  });

  it('keeps an interpolated scroll position on the device-pixel grid', () => {
    const { view, viewX } = liveView();
    view.resizePixels(1968, 1424, 984, 712);
    // Half-way between two snapshots 3 engine pixels apart: 101.5 is on the half-pixel grid of a 2x buffer.
    view.applyCamera({ x: 100, y: 200 }, { x: 103, y: 200 }, 0.5);
    expect(viewX(984)).toBeCloseTo(101.5, 9);
    // 0.37 of the way is 101.11: the nearest device pixel is 101.
    view.applyCamera({ x: 100, y: 200 }, { x: 103, y: 200 }, 0.37);
    expect(viewX(984)).toBeCloseTo(101, 9);
    // A jump (or the first snapshot) uses the engine's own whole-pixel position.
    view.applyCamera(null, { x: 77, y: 200 }, 0.4);
    expect(viewX(984)).toBeCloseTo(77, 9);
    view.applyCamera({ x: 0, y: 0 }, { x: 900, y: 0 }, 0.4);
    expect(viewX(984)).toBeCloseTo(900, 9);
  });
});

describe('HdRenderer buffer scale', () => {
  it('keeps clarity kernels and the post graph while changing sample spacing with the drawing-buffer scale', () => {
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
      pipeline: { dispose(): void } | null;
      pipelineNodes: { dispose(): void }[];
      claritySampleScale: { value: number };
    };
    try {
      applyLookPreset(hd.settings, 'cinematic');
      internal.buildPipeline();
      const build = vi.spyOn(internal, 'buildPipeline');
      const ratioKey = internal.settingsPipelineKey();
      const pipeline = internal.pipeline;
      const nodes = internal.pipelineNodes;
      // The renderer's own pixel ratio (2 here) is the default: the same scale given explicitly changes nothing.
      hd.setBufferScale(2);
      expect(internal.claritySampleScale.value).toBe(1);
      expect(internal.settingsPipelineKey()).toBe(ratioKey);
      expect(build).not.toHaveBeenCalled();
      hd.setBufferScale(3);
      expect(internal.settingsPipelineKey()).toBe(ratioKey);
      expect(internal.claritySampleScale.value).toBe(1.5);
      expect(build).not.toHaveBeenCalled();
      hd.setBufferScale(3);
      expect(build).not.toHaveBeenCalled();
      hd.setBufferScale(1.25);
      expect(internal.claritySampleScale.value).toBe(0.625);
      hd.setBufferScale(null);
      expect(internal.settingsPipelineKey()).toBe(ratioKey);
      expect(internal.claritySampleScale.value).toBe(1);
      expect(build).not.toHaveBeenCalled();
      expect(internal.pipeline).toBe(pipeline);
      expect(internal.pipelineNodes).toBe(nodes);
      // Without the clarity pass nothing in the pipeline depends on the scale.
      hd.settings.clarity = 0;
      internal.buildPipeline();
      build.mockClear();
      hd.setBufferScale(3);
      expect(build).not.toHaveBeenCalled();
    } finally {
      internal.pipeline?.dispose();
      internal.pipelineNodes.forEach((node) => node.dispose());
      hd.emissiveOverlay.dispose();
      hd.nodes.dispose();
      vi.unstubAllGlobals();
    }
  });
});
