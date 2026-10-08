import type { VmFrame } from '../../../vm86/win32';
import { currentCanvasRect, refreshCanvasRect } from './gameInput';

interface AtlasRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The page owns this small composited bitmap. Pointer events never wait for the native input or picture path. */
export async function createNativeCursor(screen: HTMLCanvasElement, base = '/hd-cache/_ui/cursor') {
  const response = await fetch(`${base}/cursor.json`);
  if (!response.ok) return null;
  const manifest = (await response.json()) as { version: number; file?: string; frames: AtlasRect[] };
  if (
    manifest.version !== 1 ||
    !Array.isArray(manifest.frames) ||
    !manifest.frames.length ||
    manifest.frames.length > 4096 ||
    !/^[a-z0-9_-]+\.png$/i.test(manifest.file ?? 'cursor.png')
  )
    return null;
  const imageResponse = await fetch(`${base}/${manifest.file ?? 'cursor.png'}`);
  if (!imageResponse.ok) return null;
  const bitmap = await createImageBitmap(await imageResponse.blob());
  if (
    !manifest.frames.every(
      (r) =>
        r &&
        [r.x, r.y, r.width, r.height].every(Number.isInteger) &&
        r.x >= 0 &&
        r.y >= 0 &&
        r.width > 0 &&
        r.height > 0 &&
        r.x + r.width <= bitmap.width &&
        r.y + r.height <= bitmap.height,
    )
  ) {
    bitmap.close();
    return null;
  }
  const canvas = document.createElement('canvas');
  canvas.id = 'native-page-cursor';
  Object.assign(canvas.style, {
    position: 'fixed',
    left: '0',
    top: '0',
    pointerEvents: 'none',
    zIndex: '100',
    display: 'none',
    imageRendering: 'pixelated',
    transformOrigin: '0 0',
  });
  screen.parentElement!.appendChild(canvas);
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    bitmap.close();
    canvas.remove();
    return null;
  }
  let frame: VmFrame | null = null;
  let inside = false;
  let clientX = 0,
    clientY = 0;
  let lastArt = '';
  let lastSystem: VmFrame['cursor'] | null;
  const oldCursor = screen.style.getPropertyValue('cursor');
  const oldPriority = screen.style.getPropertyPriority('cursor');
  screen.style.setProperty('cursor', 'none', 'important');
  const render = () => {
    const pointer = frame?.pointer;
    const rect = pointer ? manifest.frames[pointer.frame] : null;
    const system = !pointer ? frame?.cursor : null;
    if (!inside || !frame || (!pointer && !system) || (pointer && !rect)) {
      canvas.style.display = 'none';
      return;
    }
    const width = rect?.width ?? system!.width,
      height = rect?.height ?? system!.height;
    const hx = pointer?.hotspotX ?? system!.hotspotX,
      hy = pointer?.hotspotY ?? system!.hotspotY;
    const key = pointer ? `s:${pointer.frame}` : 'w';
    if (lastArt !== key || (system && system !== lastSystem)) {
      canvas.width = width;
      canvas.height = height;
      ctx.imageSmoothingEnabled = false;
      if (rect) ctx.drawImage(bitmap, rect.x, rect.y, width, height, 0, 0, width, height);
      else {
        const pixels = ctx.createImageData(width, height);
        pixels.data.set(system!.rgba);
        ctx.putImageData(pixels, 0, 0);
      }
      lastArt = key;
      lastSystem = system;
    }
    const box = currentCanvasRect(screen);
    const sx = box.width / frame.width,
      sy = box.height / frame.height;
    canvas.style.width = `${width * sx}px`;
    canvas.style.height = `${height * sy}px`;
    canvas.style.transform = `translate(${clientX - hx * sx}px, ${clientY - hy * sy}px)`;
    const left = clientX - hx * sx,
      top = clientY - hy * sy;
    canvas.style.clipPath = `inset(${Math.max(0, box.top - top)}px ${Math.max(0, left + width * sx - box.left - box.width)}px ${Math.max(0, top + height * sy - box.top - box.height)}px ${Math.max(0, box.left - left)}px)`;
    canvas.style.display = 'block';
    screen.style.setProperty('cursor', 'none', 'important');
  };
  // Own layout observation even when used without installCanvasFit. Share the
  // per-canvas cache with input, while keeping layout reads off pointermove.
  const layoutChanged = () => {
    refreshCanvasRect(screen);
    render();
  };
  const resizeObserver = new ResizeObserver(layoutChanged);
  resizeObserver.observe(screen);
  layoutChanged();
  const move = (event: PointerEvent) => {
    if (event.pointerType !== 'mouse') return;
    if (document.pointerLockElement === screen) return;
    if (event.type === 'pointerenter') refreshCanvasRect(screen);
    inside = true;
    clientX = event.clientX;
    clientY = event.clientY;
    render();
  };
  const leave = () => {
    inside = false;
    render();
  };
  const lockChanged = () => {
    if (document.pointerLockElement !== screen) leave();
  };
  const visibilityChanged = () => {
    if (document.hidden) leave();
  };
  const canceled = (event: PointerEvent) => {
    if (event.pointerType === 'mouse') leave();
  };
  for (const type of ['pointermove', 'pointerdown', 'pointerup', 'pointerenter'] as const)
    screen.addEventListener(type, move);
  screen.addEventListener('pointerleave', leave);
  screen.addEventListener('pointercancel', canceled);
  window.addEventListener('blur', leave);
  document.addEventListener('pointerlockchange', lockChanged);
  document.addEventListener('visibilitychange', visibilityChanged);
  window.addEventListener('resize', layoutChanged);
  window.addEventListener('scroll', layoutChanged, true);
  document.addEventListener('fullscreenchange', layoutChanged);
  return {
    position(x: number, y: number, visible: boolean) {
      if (!frame || document.pointerLockElement !== screen) return;
      const box = currentCanvasRect(screen);
      inside = visible;
      clientX = box.left + (x * box.width) / frame.width;
      clientY = box.top + (y * box.height) / frame.height;
      render();
    },
    update(next: VmFrame) {
      frame = next;
      render();
    },
    destroy() {
      for (const type of ['pointermove', 'pointerdown', 'pointerup', 'pointerenter'] as const)
        screen.removeEventListener(type, move);
      screen.removeEventListener('pointerleave', leave);
      screen.removeEventListener('pointercancel', canceled);
      window.removeEventListener('blur', leave);
      document.removeEventListener('pointerlockchange', lockChanged);
      document.removeEventListener('visibilitychange', visibilityChanged);
      window.removeEventListener('resize', layoutChanged);
      window.removeEventListener('scroll', layoutChanged, true);
      document.removeEventListener('fullscreenchange', layoutChanged);
      resizeObserver.disconnect();
      if (oldCursor) screen.style.setProperty('cursor', oldCursor, oldPriority);
      else screen.style.removeProperty('cursor');
      frame = null;
      bitmap.close();
      canvas.remove();
    },
  };
}
