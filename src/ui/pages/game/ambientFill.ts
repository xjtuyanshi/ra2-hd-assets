import {
  ambientFillClipPath,
  ambientFillLayout,
  ambientFillPresentation,
  ambientFillVisibility,
  drawAmbientFill,
  type AmbientFillLayout,
  type AmbientFillSignals,
  type AmbientFillVisibility,
} from '../../../graphics/ambientFill';

/**
 * Page side of the ambient fill (see graphics/ambientFill.ts): one low-resolution canvas behind the empty stage area
 * beside the game canvas. It samples what is actually presented (the game canvas and any picture layer over it, such
 * as the HD menus) right after a presentation, inside the same animation frame, because the WebGL canvas's drawing
 * buffer is not preserved after compositing.
 *
 * Presentation only: the element has pointer-events none, is clipped out of the game canvas's rect and never changes
 * that rect, so pointer mapping and hit testing are untouched. Sampling and drawing run only while the policy shows
 * the fill; during a match a presentation costs one visibility check.
 */
export interface AmbientFillHost {
  screen: HTMLCanvasElement;
  /** Current activation signals; the page injects the game's shell surface and the session's match surface. */
  signals(): AmbientFillSignals;
  /** Visible picture layers drawn over the game canvas (in stacking order), sampled with it. */
  overlays(): readonly HTMLCanvasElement[];
  /** Increments whenever a new game picture is submitted. */
  frameVersion(): number;
  /** Present the current picture again, so a sample skipped by the rate limit is taken on the next presentation. */
  requestRedraw(): void;
}

export interface AmbientFill {
  /** Call right after every presentation of the game canvas (same task). */
  presented(): void;
  /** Re-evaluate the signals without sampling (session released, battle state changed). */
  update(): void;
  /** The stage or the canvas rect may have changed (fit, fullscreen, resize). */
  relayout(): void;
  destroy(): void;
}

/** Buffer pixels the picture's height maps to (the blur resolution). */
const SAMPLE_HEIGHT = 144;
/** Blur radius as a share of the picture's buffer height. */
const BLUR_SHARE = 0.02;
/** Fastest resample while the picture changes (films), and the refresh of an unchanged picture's overlays. */
const SAMPLE_INTERVAL_MS = 100;
const IDLE_SAMPLE_INTERVAL_MS = 1000;

function context(canvas: HTMLCanvasElement): CanvasRenderingContext2D | null {
  return canvas.getContext('2d', { alpha: true, desynchronized: false });
}

export function installAmbientFill(host: AmbientFillHost): AmbientFill | null {
  const parent = host.screen.parentElement;
  if (!parent) return null;
  const element = document.createElement('canvas');
  element.id = 'ambient-fill';
  element.setAttribute('aria-hidden', 'true');
  Object.assign(element.style, {
    position: 'absolute',
    pointerEvents: 'none',
    zIndex: '0',
    display: 'none',
    opacity: '0',
    left: '0px',
    top: '0px',
  });
  const sample = document.createElement('canvas');
  const mosaic = document.createElement('canvas');
  const targetContext = context(element);
  const sampleContext = context(sample);
  const mosaicContext = context(mosaic);
  if (!targetContext || !sampleContext || !mosaicContext) return null;
  // First child: every other positioned layer of the frame (HD menus, cursor, status) stacks above it.
  parent.insertBefore(element, parent.firstChild);
  const reducedMotion = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;

  let destroyed = false;
  let visibility: AmbientFillVisibility = 'hidden';
  let ready = false;
  let layout: AmbientFillLayout | null = null;
  let layoutDirty = true;
  let sampledAt = -Infinity;
  let sampledVersion = -1;
  let trailing: number | undefined;
  let fadeTimer: number | undefined;
  let applied = '';

  const clearTrailing = () => {
    if (trailing !== undefined) window.clearTimeout(trailing);
    trailing = undefined;
  };
  const clearFade = () => {
    if (fadeTimer !== undefined) window.clearTimeout(fadeTimer);
    fadeTimer = undefined;
  };
  const apply = () => {
    // Without a current layout (no bars, or not yet measured) nothing may show: the clip would be stale.
    const state = ambientFillPresentation(layout ? visibility : 'hidden', ready, reducedMotion?.matches ?? false);
    const key = `${state.display}/${state.opacity}/${state.transitionMs}`;
    if (key === applied) return;
    applied = key;
    clearFade();
    element.style.transition = state.transitionMs ? `opacity ${state.transitionMs}ms ease` : 'none';
    if (!state.display) {
      element.style.opacity = '0';
      element.style.display = 'none';
      element.dataset.state = 'hidden';
      return;
    }
    element.style.display = 'block';
    element.style.opacity = String(state.opacity);
    element.dataset.state = visibility;
    if (visibility === 'fading')
      fadeTimer = window.setTimeout(() => {
        fadeTimer = undefined;
        if (visibility !== 'fading') return;
        element.style.display = 'none';
        element.dataset.state = 'hidden';
        applied = '';
      }, state.transitionMs + 50);
  };
  const setVisibility = (next: AmbientFillVisibility) => {
    if (next === visibility) return;
    // A new shown period starts transparent and fades in after its first sample, never with a stale picture.
    if (next === 'shown' || next === 'hidden') ready = false;
    if (next !== 'shown') clearTrailing();
    visibility = next;
    apply();
  };
  const readLayout = (): AmbientFillLayout | null => {
    const fullscreen = !!document.fullscreenElement?.contains(host.screen);
    const stageElement = host.screen.closest('#stage');
    const stage = fullscreen
      ? { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight }
      : stageElement?.getBoundingClientRect();
    if (!stage) return null;
    const screen = host.screen.getBoundingClientRect();
    const next = ambientFillLayout(
      { width: stage.width, height: stage.height },
      { x: screen.left - stage.left, y: screen.top - stage.top, width: screen.width, height: screen.height },
      { sampleHeight: SAMPLE_HEIGHT },
    );
    if (!next) return null;
    const origin = parent.getBoundingClientRect();
    Object.assign(element.style, {
      left: `${stage.left - origin.left - parent.clientLeft}px`,
      top: `${stage.top - origin.top - parent.clientTop}px`,
      width: `${next.stage.width}px`,
      height: `${next.stage.height}px`,
      clipPath: ambientFillClipPath(next),
    });
    return next;
  };
  /** Measure now; returns whether the picture's rect moved since the previous layout. */
  const updateLayout = (): boolean => {
    const previous = layout;
    layout = readLayout();
    layoutDirty = false;
    if (
      layout &&
      (!previous || previous.buffer.width !== layout.buffer.width || previous.buffer.height !== layout.buffer.height)
    ) {
      element.width = mosaic.width = layout.buffer.width;
      element.height = mosaic.height = layout.buffer.height;
    }
    const a = previous?.content;
    const b = layout?.content;
    return !a || !b || a.x !== b.x || a.y !== b.y || a.width !== b.width || a.height !== b.height;
  };
  const draw = (): boolean => {
    if (layoutDirty) updateLayout();
    if (!layout) return false;
    const width = Math.max(1, Math.round(layout.bufferContent.width));
    const height = Math.max(1, Math.round(layout.bufferContent.height));
    if (sample.width !== width) sample.width = width;
    if (sample.height !== height) sample.height = height;
    sampleContext.setTransform(1, 0, 0, 1, 0, 0);
    sampleContext.imageSmoothingEnabled = true;
    sampleContext.imageSmoothingQuality = 'medium';
    sampleContext.clearRect(0, 0, width, height);
    sampleContext.drawImage(host.screen, 0, 0, width, height);
    const screen = host.screen.getBoundingClientRect();
    if (screen.width > 0 && screen.height > 0)
      for (const overlay of host.overlays()) {
        const box = overlay.getBoundingClientRect();
        if (!box.width || !box.height || !overlay.width || !overlay.height) continue;
        sampleContext.drawImage(
          overlay,
          ((box.left - screen.left) * width) / screen.width,
          ((box.top - screen.top) * height) / screen.height,
          (box.width * width) / screen.width,
          (box.height * height) / screen.height,
        );
      }
    drawAmbientFill(targetContext, mosaicContext, sample, layout, layout.bufferContent.height * BLUR_SHARE);
    return true;
  };
  const evaluate = () => {
    let next: AmbientFillVisibility;
    try {
      next = ambientFillVisibility(host.signals());
    } catch {
      next = 'hidden';
    }
    setVisibility(next);
    return next;
  };

  return {
    presented() {
      if (destroyed || evaluate() !== 'shown') return;
      const now = performance.now();
      const version = host.frameVersion();
      const changed = version !== sampledVersion;
      const due = now - sampledAt >= (changed ? SAMPLE_INTERVAL_MS : IDLE_SAMPLE_INTERVAL_MS);
      if (ready && !layoutDirty && !due) {
        if (changed && trailing === undefined)
          trailing = window.setTimeout(
            () => {
              trailing = undefined;
              if (!destroyed && visibility === 'shown') host.requestRedraw();
            },
            Math.max(0, SAMPLE_INTERVAL_MS - (now - sampledAt)),
          );
        return;
      }
      clearTrailing();
      sampledAt = now;
      sampledVersion = version;
      const wasReady = ready;
      try {
        ready = draw();
      } catch (error) {
        ready = false;
        console.warn('[ambient fill] sample failed', error);
      }
      // The element became visible (opacity 0) in this same task; resolve that style first so the change to opacity 1
      // below runs as a transition instead of appearing at once.
      if (ready && !wasReady && layout) {
        Object.assign(element.style, { transition: 'none', display: 'block', opacity: '0' });
        void getComputedStyle(element).opacity;
        applied = '';
      }
      element.dataset.samples = String(Number(element.dataset.samples ?? 0) + 1);
      apply();
    },
    update() {
      if (!destroyed) evaluate();
    },
    relayout() {
      if (destroyed) return;
      if (visibility === 'hidden') {
        // Measured again when the fill is next shown.
        layoutDirty = true;
        return;
      }
      // Measure at once: the clip must follow the canvas before the next composite, or a stale hole could let the
      // fill overlap a canvas that just grew (the switch into a match's video mode).
      const moved = updateLayout();
      // A fade belongs to the picture it started on; a moved canvas ends it at once.
      if (visibility === 'fading' && moved) setVisibility('hidden');
      apply();
      if (visibility === 'shown' && layout) host.requestRedraw();
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      clearTrailing();
      clearFade();
      element.remove();
      element.width = element.height = 0;
      sample.width = sample.height = 0;
      mosaic.width = mosaic.height = 0;
    },
  };
}
