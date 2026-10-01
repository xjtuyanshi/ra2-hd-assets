import type { GameRenderSidebar } from '../../../games/renderState';
import type { FrameRect, VmFrameRenderer } from './vmFrameRenderer';
import { createUiAssets } from '../../../../packages/hd-renderer/src/ui/uiAssets';
import { drawSidebar, transparentRects } from '../../../../packages/hd-renderer/src/ui/sidebarView';

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

  const setRects = (rects: readonly FrameRect[]) => {
    const next = JSON.stringify(rects);
    if (next === rectKey) return;
    rectKey = next;
    host.frameRenderer.setTransparentRects(rects);
    host.invalidate();
  };
  const visible = () => !!ctx && enabled && !!sidebar && !!host.frameSize();
  const sync = () => {
    const show = visible();
    canvas.style.display = show ? 'block' : 'none';
    setRects(show ? transparentRects(sidebar!, assets) : []);
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
    const width = host.screen.clientWidth;
    const height = host.screen.clientHeight;
    const dpr = window.devicePixelRatio || 1;
    Object.assign(canvas.style, {
      left: `${host.screen.offsetLeft}px`,
      top: `${host.screen.offsetTop}px`,
      width: `${width}px`,
      height: `${height}px`,
    });
    const pixelWidth = Math.round(width * dpr);
    const pixelHeight = Math.round(height * dpr);
    if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
    if (canvas.height !== pixelHeight) canvas.height = pixelHeight;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const scale = canvas.width / size.width;
    if (scale > 0 && size.height > 0) {
      ctx.save();
      // Match even a nonuniformly sized screen box without changing the snapshot's frame coordinates.
      ctx.scale(1, canvas.height / size.height / scale);
      drawSidebar(ctx, sidebar, assets, { scale, time, pointerPosition: host.pointerPosition?.() ?? null });
      ctx.restore();
    }
  };
  return {
    update(next) {
      if (!disposed) {
        sidebar = next;
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
      assets.dispose();
      canvas.remove();
      sidebar = null;
    },
  };
}
