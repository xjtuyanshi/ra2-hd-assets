import type { GameRenderSidebar } from '../../../games/renderState';
import type { FrameRect, VmFrameRenderer } from './vmFrameRenderer';
import { createUiAssets } from '../../../../packages/hd-renderer/src/ui/uiAssets';
import { drawSidebar, transparentRects } from '../../../../packages/hd-renderer/src/ui/sidebarView';
import { devicePixelBox } from './devicePixelBox';

export interface HdUi {
  update(sidebar: GameRenderSidebar | null): void;
  setEnabled(on: boolean): void;
  dispose(): void;
}

/** Development-only controller. Owns the canvas, animation request and optional art cache; no input listeners. */
export function startHdUi(host: {
  screen: HTMLCanvasElement;
  frameRenderer: VmFrameRenderer;
  invalidate(): void;
  frameSize(): { width: number; height: number } | null;
  pointerPosition?(): Readonly<{ x: number; y: number }> | null;
  /** Undefined retains the legacy UI path; false preserves all native sidebar pixels for the game-cursor fallback. */
  pageCursor?(): boolean | undefined;
}): HdUi {
  const canvas = document.createElement('canvas');
  canvas.id = 'hd-ui';
  Object.assign(canvas.style, { position: 'absolute', pointerEvents: 'none', zIndex: '0', display: 'none' });
  host.screen.parentElement!.insertBefore(canvas, host.screen);
  const ctx = canvas.getContext('2d');
  const assets = createUiAssets();
  let sidebar: GameRenderSidebar | null = null;
  let enabled = true;
  let disposed = false;
  let request: number | null = null;
  let rectKey = '[]';
  let smoothKey = 'null';

  const setRects = (rects: readonly FrameRect[]) => {
    const next = JSON.stringify(rects);
    if (next === rectKey) return;
    rectKey = next;
    host.frameRenderer.setTransparentRects(rects);
    host.invalidate();
  };
  const visible = () =>
    !!ctx &&
    enabled &&
    !!sidebar &&
    sidebar.side >= 0 &&
    !!assets.chrome(sidebar.side) &&
    !!host.frameSize() &&
    host.pageCursor?.() !== false;
  const sync = () => {
    const show = visible();
    canvas.style.display = show ? 'block' : 'none';
    setRects(show ? transparentRects(sidebar!, assets) : []);
    const smooth = show && sidebar?.radarActive ? sidebar.layout.radar : null;
    const nextSmooth = JSON.stringify(smooth);
    if (nextSmooth !== smoothKey) {
      smoothKey = nextSmooth;
      host.frameRenderer.setSmoothRect(smooth);
      host.invalidate();
    }
    if (show && request === null) request = requestAnimationFrame(draw);
    if (!show && request !== null) {
      cancelAnimationFrame(request);
      request = null;
    }
  };
  const draw = (time: number) => {
    request = null;
    if (disposed) return;
    sync();
    const size = host.frameSize();
    if (!visible() || !size || !ctx || !sidebar) return;
    // Keep one buffer pixel per device pixel at every view scale. Supplied art is sampled directly at that size;
    // the compositor never stretches a 2x intermediate canvas, and 3x chrome stays texel for pixel at scale 3.
    const box = devicePixelBox(host.screen, size, window.devicePixelRatio || 1);
    Object.assign(canvas.style, box.style);
    if (canvas.width !== box.width) canvas.width = box.width;
    if (canvas.height !== box.height) canvas.height = box.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const scale = canvas.width / size.width;
    if (scale > 0 && size.height > 0) {
      ctx.save();
      // Match even a nonuniformly sized screen box without changing the snapshot's frame coordinates.
      ctx.scale(1, canvas.height / size.height / scale);
      drawSidebar(ctx, host.pageCursor?.() ? { ...sidebar, pointer: null } : sidebar, assets, {
        scale,
        time,
        pointerPosition: host.pointerPosition?.() ?? null,
      });
      ctx.restore();
    }
  };
  return {
    update(next) {
      if (!disposed) {
        sidebar = next;
        // Prepare chrome while the original sidebar is still visible, including during the battlefield fade.
        // An absent or incomplete cache keeps the game's pixels instead of exposing procedural placeholders.
        if (sidebar && sidebar.side >= 0) assets.chrome(sidebar.side);
        sync();
      }
    },
    setEnabled(on) {
      if (!disposed) {
        enabled = on;
        sync();
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (request !== null) cancelAnimationFrame(request);
      request = null;
      setRects([]);
      host.frameRenderer.setSmoothRect(null);
      assets.dispose();
      canvas.remove();
      sidebar = null;
    },
  };
}
