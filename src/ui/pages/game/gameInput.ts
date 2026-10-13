import { t } from '../../shared/i18n/translate';
import type { VmShell } from '../../../adapter/runtime';
import {
  keyLParam,
  normalizePointerButton,
  rescaleLogicalPointer,
  virtualKey,
  win32CharacterCode,
  type KeyLike,
} from './input';
import { calculateCanvasFit } from './canvasFit';
import { installFullscreenKeyboardLock, type KeyboardLockState } from './keyboardLock';

let canvasFitObserver: ResizeObserver | null = null;
let canvasDprQuery: MediaQueryList | null = null;
let canvasDprFitListener: (() => void) | null = null;
let canvasFullscreenFitListener: (() => void) | null = null;
// Input can be reinstalled when the game restarts; the page's canvas owns this
// one-time explanation without retaining a removed canvas or another page.
const pointerLockHintShown = new WeakSet<HTMLCanvasElement>();

/**
 * Page shortcuts bypass game injection in installGameInput keydown/keyup and are handled centrally here.
 * Leave number/letter keys available for native game hotkeys.
 */
const UI_SHORTCUT_KEYS = new Set(['`', 'F11', '?', '[', ']']);

/**
 * Reserve a key for a page shortcut whose feature exists only in some sessions (true), or give it back to the game
 * (false). The page calls this when the feature starts and stops, so the key reaches the game whenever the page has no
 * use for it.
 */
export function setSessionShortcutKey(key: string, reserved: boolean): void {
  if (reserved) UI_SHORTCUT_KEYS.add(key);
  else UI_SHORTCUT_KEYS.delete(key);
}

/**
 * Per-canvas CSS-box cache refreshed by layout owners after every fit or observed layout change.
 * Frequent mousemove reads no longer call getBoundingClientRect each time.
 */
const canvasRectCache = new WeakMap<HTMLCanvasElement, { left: number; top: number; width: number; height: number }>();

export function refreshCanvasRect(canvas: HTMLCanvasElement): {
  left: number;
  top: number;
  width: number;
  height: number;
} {
  const rect = canvas.getBoundingClientRect();
  const box = { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
  canvasRectCache.set(canvas, box);
  return box;
}

export function currentCanvasRect(canvas: HTMLCanvasElement): {
  left: number;
  top: number;
  width: number;
  height: number;
} {
  return canvasRectCache.get(canvas) ?? refreshCanvasRect(canvas);
}

/** Fullscreen frame and lock hints, excluding toolbar/debug layers; input lifecycle owns keyboard locking. */
export async function toggleImmersiveFullscreen(canvas: HTMLCanvasElement): Promise<void> {
  if (document.fullscreenElement) {
    await document.exitFullscreen();
  } else {
    try {
      await (canvas.parentElement ?? canvas).requestFullscreen({ navigationUI: 'hide' });
      // The toolbar button retains keyboard focus when its frame enters fullscreen.
      // Return it to the game so the next real key, including Esc, reaches the VM.
      if ((document.fullscreenElement as Element | null)?.contains(canvas)) canvas.focus({ preventScroll: true });
    } catch (error) {
      console.warn(t('[VM UI] 全屏请求被拒绝'), error);
    }
  }
}

import { controlsCollapsed } from './state/uiState';

/** Input publishes only collapse intent; React owns toolbar classes and button text. */
export function setControlsCollapsed(collapsed: boolean): void {
  controlsCollapsed.set(collapsed);
}

/**
 * Visually scale the canvas to the largest aspect-preserving size allowed by the window. The CSS box fits exactly; physical backing uses integer scales (round up at >=1x, cap at 2x; use exact downscaling below 1x). The raster pipeline therefore has only direct 1:1, one-pass integer Nx nearest-neighbor, and one-pass bilinear downscaling, with at most one canvas resample per frame. Delegate fractional backing-to-CSS scaling to the browser compositor (Skia scaling is almost free on GPU; rounding up supersamples, and compositor downscaling is sharper than upscaling). Fractional backing causes two resamples: software-rendered 1920x1080 menus measured 32fps with a large 1.8x intermediate buffer versus 60fps at integer scales in the same window. Cap at 2x because larger nearest-neighbor scales also take 25ms+ in software rendering. Map pointer coordinates through getBoundingClientRect to current guest-frame logical coordinates.
 */
export interface GameFrameSize {
  width: number;
  height: number;
}

export type GameFrameSizeProvider = () => GameFrameSize;

export interface CanvasFitOptions {
  /** Whole device pixels per frame pixel whenever the stage has room (see CanvasFitInput.integerScale). */
  integerScale?(): boolean;
  preferredScale?(): number | undefined;
  /** Fill the available stage rather than retaining the launch-time pixel scale. */
  fillStage?(): boolean;
  /** Render at the fitted device-pixel size while CSS independently fills a resized play area. */
  devicePixelBacking?(): boolean;
  /**
   * The fitted frame size, its device pixels per frame pixel and the scale that would fill the stage, whenever a fit
   * ran.
   */
  onFit?(frameWidth: number, frameHeight: number, scale: number, fillScale: number): void;
}

export function installCanvasFit(
  canvas: HTMLCanvasElement,
  getFrameSize: GameFrameSizeProvider,
  onResized?: () => void,
  options: CanvasFitOptions = {},
): ((frameWidth?: number, frameHeight?: number) => void) & { destroy(): void } {
  // The first fit() runs during page initialization before the render loop exists; run silently without callbacks.
  let ready = false;
  const initialFrame = getFrameSize();
  let activeFrameWidth = initialFrame.width;
  let activeFrameHeight = initialFrame.height;
  let backingTimer: number | null = null;
  let pendingBacking: { width: number; height: number } | null = null;
  const clearBackingTimer = () => {
    if (backingTimer !== null) window.clearTimeout(backingTimer);
    backingTimer = null;
    pendingBacking = null;
  };
  const resizeBacking = (width: number, height: number) => {
    if (canvas.width === width && canvas.height === height) return;
    canvas.width = width;
    canvas.height = height;
    if (ready) onResized?.();
  };
  const fit = (nextFrameWidth = activeFrameWidth, nextFrameHeight = activeFrameHeight) => {
    if (
      !Number.isFinite(nextFrameWidth) ||
      nextFrameWidth <= 0 ||
      !Number.isFinite(nextFrameHeight) ||
      nextFrameHeight <= 0
    )
      return;
    // Store frame dimensions before reading stage geometry so a first frame arriving before stage layout completes
    // still gives the next ResizeObserver callback the latest aspect ratio instead of stale 800x600.
    const frameChanged = activeFrameWidth !== nextFrameWidth || activeFrameHeight !== nextFrameHeight;
    activeFrameWidth = nextFrameWidth;
    activeFrameHeight = nextFrameHeight;
    // Scaling reference: #stage in normal layout, where flex fills available space and rect is the maximum area;
    // in immersive fullscreen the browser expands the frame container to the viewport, so use viewport dimensions.
    // #screen-frame only wraps the canvas to position pointer-lock effects; it is not the scaling reference.
    const stage = canvas.closest('#stage');
    const isCanvasFullscreen = !!document.fullscreenElement?.contains(canvas);
    if (!stage && !isCanvasFullscreen) return;
    const rect = isCanvasFullscreen
      ? { width: window.innerWidth, height: window.innerHeight }
      : stage!.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const fit = calculateCanvasFit({
      stageWidth: rect.width,
      stageHeight: rect.height,
      frameWidth: nextFrameWidth,
      frameHeight: nextFrameHeight,
      devicePixelRatio: window.devicePixelRatio || 1,
      integerScale: options.integerScale?.() ?? false,
      preferredScale: options.preferredScale?.(),
      fillStage: options.fillStage?.(),
    });
    if (!fit) return;
    // Like onResized, not during the install-time fit: the page's callbacks may not exist yet.
    if (ready) options.onFit?.(activeFrameWidth, activeFrameHeight, fit.scale, fit.fillScale);
    const devicePixelBacking = options.devicePixelBacking?.() ?? false;
    const width = devicePixelBacking
      ? Math.max(1, Math.round(fit.cssWidth * (window.devicePixelRatio || 1)))
      : fit.backingWidth;
    const height = devicePixelBacking
      ? Math.max(1, Math.round(fit.cssHeight * (window.devicePixelRatio || 1)))
      : fit.backingHeight;
    const cssWidth = `${fit.cssWidth}px`;
    const cssHeight = `${fit.cssHeight}px`;
    const aspectRatio = `${activeFrameWidth} / ${activeFrameHeight}`;
    const backingChanged = canvas.width !== width || canvas.height !== height;
    const cssChanged = canvas.style.width !== cssWidth || canvas.style.height !== cssHeight;
    const aspectChanged = canvas.style.aspectRatio !== aspectRatio;
    if (cssChanged) {
      canvas.style.width = cssWidth;
      canvas.style.height = cssHeight;
    }
    if (aspectChanged) canvas.style.aspectRatio = aspectRatio;
    // CSS scales the existing picture on every drag step. Allocate HD-sized buffers only once the area is stable;
    // game video-mode changes and the first frame still apply immediately so their coordinate spaces agree.
    if (backingChanged && ready && devicePixelBacking && !frameChanged) {
      if (pendingBacking?.width !== width || pendingBacking.height !== height) {
        clearBackingTimer();
        pendingBacking = { width, height };
        backingTimer = window.setTimeout(() => {
          clearBackingTimer();
          if (ready) resizeBacking(width, height);
        }, 200);
      }
    } else {
      clearBackingTimer();
      if (backingChanged) resizeBacking(width, height);
    }
    if (!backingChanged && !cssChanged && !aspectChanged) {
      // Skip resetting unchanged dimensions, such as returning to the same scale after fullscreen; even assigning the same canvas.width
      // clears its bitmap and needlessly flashes a frame. Refresh only the potentially moved rect cache.
      refreshCanvasRect(canvas);
      return;
    }
    // Refresh the rect cache synchronously for frequent mousePosition reads; see currentCanvasRect.
    // This is the only canvas-layout-box mutation point, including fullscreen transitions.
    refreshCanvasRect(canvas);
  };
  canvasFitObserver?.disconnect();
  canvasFitObserver = new ResizeObserver(() => fit());
  const stage = canvas.closest('#stage');
  if (stage) canvasFitObserver.observe(stage);
  // Moving between displays or browser zoom can change devicePixelRatio without changing stage CSS size; track the resolution media query.
  const fitEnvironmentChange = () => fit();
  if (canvasDprQuery && canvasDprFitListener) {
    canvasDprQuery.removeEventListener('change', canvasDprFitListener);
  }
  let dprQuery: MediaQueryList;
  const observeDpr = () => {
    dprQuery?.removeEventListener('change', dprChanged);
    dprQuery = matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
    dprQuery.addEventListener('change', dprChanged);
    canvasDprQuery = dprQuery;
  };
  const dprChanged = () => {
    // A query for the old DPR stays false after the first change. Re-arm it so
    // later zoom/display changes also refit even when the CSS area is unchanged.
    observeDpr();
    fit();
  };
  observeDpr();
  canvasDprFitListener = dprChanged;
  // Refit on immersive fullscreen transitions because fullscreen-box dimensions are independent of normal layout.
  if (canvasFullscreenFitListener) document.removeEventListener('fullscreenchange', canvasFullscreenFitListener);
  document.addEventListener('fullscreenchange', fitEnvironmentChange);
  canvasFullscreenFitListener = fitEnvironmentChange;
  fit();
  ready = true;
  const observer = canvasFitObserver;
  return Object.assign(fit, {
    destroy() {
      ready = false;
      clearBackingTimer();
      observer.disconnect();
      dprQuery.removeEventListener('change', dprChanged);
      document.removeEventListener('fullscreenchange', fitEnvironmentChange);
      if (canvasFitObserver === observer) canvasFitObserver = null;
      if (canvasDprQuery === dprQuery) {
        canvasDprQuery = null;
        canvasDprFitListener = null;
      }
      if (canvasFullscreenFitListener === fitEnvironmentChange) canvasFullscreenFitListener = null;
    },
  });
}

/** One input as it was forwarded to the game (modifiers as the game sees them), for observers such as practice lessons. */
export interface GameInputObservation {
  type: 'keydown' | 'pointerdown' | 'pointerup';
  /** KeyboardEvent.code of a key (after the page's modifier mapping), or "Mouse0" / "Mouse1" / "Mouse2". */
  code: string;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  /** Guest frame pixel of a pointer input. */
  x?: number;
  y?: number;
}

export interface GameInputOptions {
  /** An independent page presenter already owns cursor visibility, even before input installation. */
  pageOwnsCursor?: boolean;
  /** A runtime may keep modal menus absolute and confine only an active battlefield. */
  canLockPointer?: () => boolean;
  /** Confine a first held battle drag immediately; modal-menu clicks retain after-up locking. */
  lockPointerOnDown?: () => boolean;
  /**
   * Where Shift + left button is replaced by ten plain clicks (the page's build-queue convenience). Without it the
   * repeat applies everywhere, which also swallows the game's own Shift + click (add to the selection); a game passes
   * its sidebar region here so the tactical view receives Shift + click unchanged.
   */
  shiftClickRepeat?: (x: number, y: number, frame: GameFrameSize) => boolean;
  /**
   * Apple keyboards: forward ⌘ as the game's Ctrl key (in addition to Control itself). macOS keeps several Control
   * combinations for itself (Control + click is the secondary click, Control + F2..F4 and Control + arrows are system
   * shortcuts) while ⌘ has no meaning in the game. macOS delivers no keyup for other keys while ⌘ is held, so such keys
   * are released by the page shortly after they were pressed.
   */
  metaAsControl?: boolean;
  /** Called for every key press and mouse button change that was forwarded; never able to change or block it. */
  observe?: (observation: GameInputObservation) => void;
}

export interface InstalledGameInput {
  adaptResolution(width: number, height: number): void;
  /** Latest locally tracked guest coordinates, copied for presentation without dispatching input. */
  pointerPosition(): Readonly<{ x: number; y: number }> | null;
  /** Release confinement when the presentation owner confirms entry into a menu. */
  releasePointerLock(): void;
  cleanup(): void;
}

export function installGameInput(
  canvas: HTMLCanvasElement,
  vm: VmShell,
  lockDesktopMouse = true,
  onCursorPresentation?: (x: number, y: number, visible: boolean) => void,
  getFrameSize: GameFrameSizeProvider = () => ({ width: 800, height: 600 }),
  options: GameInputOptions = {},
): InstalledGameInput {
  // Retain system mouse acceleration/speed by default; raw counts are not the system cursor's screen displacement.
  // Only explicit ?raw-mouse=1 bypasses system adjustment; never enable it automatically on Windows.
  const rawMouse = new URLSearchParams(window.location.search).get('raw-mouse') === '1';
  // Accept keyboard focus after clicks without letting Tab draw a browser focus outline over the game.
  canvas.tabIndex = -1;
  canvas.style.outline = 'none';
  canvas.style.touchAction = 'none';
  canvas.style.userSelect = 'none';
  const removers: Array<() => void> = [];
  // The emulator uses the browser's hardware cursor on menus in absolute mode.
  // A page presenter and native frames own the exact cursor art; installing
  // input after a warm frame must not briefly re-enable the browser's arrow.
  if (!lockDesktopMouse && !options.pageOwnsCursor && vm.runtimeInfo?.backend !== 'native') {
    const previousCursor = canvas.style.getPropertyValue('cursor');
    const previousCursorPriority = canvas.style.getPropertyPriority('cursor');
    canvas.style.setProperty('cursor', 'default', 'important');
    removers.push(() => {
      if (previousCursor) canvas.style.setProperty('cursor', previousCursor, previousCursorPriority);
      else canvas.style.removeProperty('cursor');
    });
  }
  let mouseFlags = 0;
  let lastMouseLParam = 0;
  const initialFrame = getFrameSize();
  let logicalMouseX = initialFrame.width / 2;
  let logicalMouseY = initialFrame.height / 2;
  let pointerTracked = false;
  let logicalFrameWidth = initialFrame.width;
  let logicalFrameHeight = initialFrame.height;
  let pointerLockPending = false;
  let pointerLockRevision = 0;
  let inputDisposed = false;
  let desktopMoveFrame: number | null = null;
  let pendingDesktopMove: { x: number; y: number; lParam: number; wParam: number } | null = null;
  // Deliver the first desktop click's complete DOWN/UP pair in the same absolute-coordinate mode.
  // Locking immediately in pointerdown makes some Chromium/Windows combinations switch to relative coordinates
  // between the events or cancel pointerup, breaking menus that rely on WM_LBUTTONUP.
  let lockAfterPointerUp = false;
  let lockOnDownGesture = false;
  let lastCtrlPrimaryDispatch: { at: number; lParam: number } | null = null;
  let compatibilityCtrlPrimaryActive = false;
  const hostPlatform = `${navigator.platform ?? ''} ${navigator.userAgent ?? ''}`;
  const normalizedPointerButtons = new Map<number, number>();
  const heldKeys = new Map<string, { vk: number; system: boolean; meta?: boolean }>();
  const applePlatform = /(?:Macintosh|MacIntel|iPhone|iPad|iPod)/i.test(hostPlatform);
  const metaAsControl = !!options.metaAsControl && applePlatform;
  /** Keys released by the page because ⌘ was held (see GameInputOptions.metaAsControl): their real keyup is dropped. */
  const metaReleased = new Set<string>();
  const metaReleaseTimers = new Map<string, number>();
  const META_KEY_RELEASE_MS = 60;
  /** The code a key is forwarded as: ⌘ plays Ctrl when the mapping is on. */
  const forwardedCode = (code: string): string =>
    metaAsControl && code === 'MetaLeft'
      ? 'ControlLeft'
      : metaAsControl && code === 'MetaRight'
        ? 'ControlRight'
        : code;
  const MODIFIER_CODES = new Set([
    'ShiftLeft',
    'ShiftRight',
    'ControlLeft',
    'ControlRight',
    'AltLeft',
    'AltRight',
    'MetaLeft',
    'MetaRight',
  ]);
  const observe = options.observe;
  const notify = (type: GameInputObservation['type'], code: string, lParam?: number): void => {
    if (!observe) return;
    try {
      observe({
        type,
        code,
        ctrl: heldModifier(0x11),
        alt: heldModifier(0x12),
        shift: heldModifier(0x10),
        ...(lParam === undefined ? {} : { x: lParam & 0xffff, y: (lParam >>> 16) & 0xffff }),
      });
    } catch {
      // An observer must never disturb input delivery.
    }
  };
  // Modifiers may already be held before the canvas gains focus; synthesize their missing down edges on pointerdown,
  // then release normally on keyup/blur to keep RA2's key-state table aligned with browser physical state.
  const reconciledModifiers = new Map<number, string>();

  // ---- Touch gesture state machine ----
  // Delay touch DOWN until the gesture is identified as tap, drag, or long-press right-click, ensuring:
  // 1) 400ms long press means right-click; 2) double taps retain two complete physical clicks;
  // 3) drag sends left DOWN at the original contact point. USER32 generates double-click messages from window-class styles.
  // Two-finger trackpad semantics: tap means right-click; drag holds right-click for native map panning.
  // The cursor always follows the primary finger and the map pans 1:1, leaving the cursor at the release point.
  // A second finger cancels pending single-finger long-press/tap intent; ignore it once the first finger is already dragging/right-clicking.
  const TOUCH_LONG_PRESS_MS = 400;
  // See handleTouchPointerMove for the drag threshold, expressed in game pixels and adapted to canvas scaling.
  interface TouchGesture {
    pointerId: number;
    phase: 'pending' | 'drag' | 'right' | 'two-pending' | 'two-drag';
    downX: number;
    downY: number;
    downLParam: number;
    downClientX: number;
    downClientY: number;
    /** Primary finger's client position when entering two-finger mode; anchor for detecting two-finger drags. */
    twoClientX: number;
    twoClientY: number;
    modifiers: number;
    timer: number;
  }
  let touchGesture: TouchGesture | null = null;
  const activeTouches = new Set<number>();
  /**
   * Shift+left-click repeats 10 times: dispatch the first pair immediately, then WM_LBUTTONDOWN/UP pairs every 50ms.
   * Remove Shift from repeated-click modifiers so the game receives 10 ordinary clicks. Swallow physical up while repetition runs because each pair supplies its own; physical up after completion is delivered normally and is harmless.
   */
  const SHIFT_CLICK_COUNT = 10;
  const SHIFT_CLICK_INTERVAL_MS = 50;
  let shiftBurstTimer: number | null = null;
  const cancelShiftBurst = () => {
    if (shiftBurstTimer !== null) {
      window.clearTimeout(shiftBurstTimer);
      shiftBurstTimer = null;
    }
  };
  const startShiftBurst = (lParam: number, modifiers: number) => {
    cancelShiftBurst();
    const mods = modifiers & ~0x0004;
    let remaining = SHIFT_CLICK_COUNT;
    const step = () => {
      vm.setKeyState(0x01, true);
      vm.postMessage(0x0201, mods | 0x0001, lParam); // WM_LBUTTONDOWN
      vm.setKeyState(0x01, false);
      vm.postMessage(0x0202, mods, lParam); // WM_LBUTTONUP
      // Capture click sequences in the ordinary left-click format so multiplayer smoke replay can reproduce repeated clicks.
      console.log(`[click-seq] ${lParam & 0xffff},${(lParam >>> 16) & 0xffff}`);
      remaining -= 1;
      shiftBurstTimer = remaining > 0 ? window.setTimeout(step, SHIFT_CLICK_INTERVAL_MS) : null;
    };
    step();
  };

  /** Dispatch taps by cursor shape: attack/move destinations use right-click; empty ground, friendly units, and UI use left-click. */
  const dispatchTapClick = (downLParam: number, modifiers: number, right: boolean) => {
    if (right) {
      mouseFlags |= 0x0002;
      vm.setKeyState(0x02, true);
      vm.postMessage(0x0204, modifiers | 0x0002, downLParam); // WM_RBUTTONDOWN
      mouseFlags &= ~0x0002;
      vm.setKeyState(0x02, false);
      vm.postMessage(0x0205, modifiers, downLParam); // WM_RBUTTONUP
    } else {
      mouseFlags |= 0x0001;
      vm.setKeyState(0x01, true);
      vm.postMessage(0x0201, modifiers | 0x0001, downLParam);
      mouseFlags &= ~0x0001;
      vm.setKeyState(0x01, false);
      vm.postMessage(0x0202, modifiers, downLParam); // WM_LBUTTONUP
      // Capture local multiplayer smoke click sequences so recorded host/join paths can replay automatically.
      console.log(`[click-seq] ${downLParam & 0xffff},${(downLParam >>> 16) & 0xffff}`);
    }
  };

  /** Map touch taps to ordinary left-click; long presses/two-finger gestures explicitly generate right-click. */
  const scheduleTapClick = (downLParam: number, modifiers: number) => {
    dispatchTapClick(downLParam, modifiers, false);
  };

  const on = <K extends keyof (HTMLElementEventMap & WindowEventMap)>(
    target: HTMLElement | Window,
    type: K,
    listener: (event: (HTMLElementEventMap & WindowEventMap)[K]) => void,
    options?: AddEventListenerOptions,
  ) => {
    target.addEventListener(type, listener as EventListener, options);
    removers.push(() => target.removeEventListener(type, listener as EventListener, options));
  };

  const adaptResolution = (width: number, height: number): void => {
    width = Math.max(1, width | 0);
    height = Math.max(1, height | 0);
    if (width !== logicalFrameWidth || height !== logicalFrameHeight) {
      [logicalMouseX, logicalMouseY] = rescaleLogicalPointer(
        logicalMouseX,
        logicalMouseY,
        logicalFrameWidth,
        logicalFrameHeight,
        width,
        height,
      );
      logicalFrameWidth = width;
      logicalFrameHeight = height;
      cancelDesktopMove();
      const x = Math.floor(logicalMouseX);
      const y = Math.floor(logicalMouseY);
      lastMouseLParam = (((y & 0xffff) << 16) | (x & 0xffff)) >>> 0;
      // Do not wait for the next physical mousemove: after SetDisplayMode immediately synchronize rescaled coordinates
      // to the guest and host cursor layer so the locked cursor is not clamped to old 800x600 bounds.
      vm.setCursorPosition(x, y);
      onCursorPresentation?.(x, y, document.pointerLockElement === canvas);
    }
  };

  const updateMousePosition = (event: MouseEvent): [number, number] => {
    // Use the rect cache maintained by installCanvasFit to avoid layout reads on every mousemove.
    const rect = currentCanvasRect(canvas);
    // Map to guest logical coordinates independently of backing-store physical dimensions.
    const frame = getFrameSize();
    const width = frame.width;
    const height = frame.height;
    adaptResolution(width, height);
    if (document.pointerLockElement === canvas) {
      logicalMouseX = Math.max(0, Math.min(width - 1, logicalMouseX + (event.movementX * width) / (rect.width || 1)));
      logicalMouseY = Math.max(
        0,
        Math.min(height - 1, logicalMouseY + (event.movementY * height) / (rect.height || 1)),
      );
    } else {
      logicalMouseX = Math.max(0, Math.min(width - 1, ((event.clientX - rect.left) * width) / (rect.width || 1)));
      logicalMouseY = Math.max(0, Math.min(height - 1, ((event.clientY - rect.top) * height) / (rect.height || 1)));
    }
    pointerTracked = true;
    return [Math.floor(logicalMouseX), Math.floor(logicalMouseY)];
  };
  const mousePosition = (event: MouseEvent): [number, number] => {
    const [x, y] = updateMousePosition(event);
    vm.setCursorPosition(x, y);
    onCursorPresentation?.(x, y, document.pointerLockElement === canvas);
    return [x, y];
  };
  const mouseLParam = (event: MouseEvent): number => {
    const [x, y] = mousePosition(event);
    lastMouseLParam = (((y & 0xffff) << 16) | (x & 0xffff)) >>> 0;
    return lastMouseLParam;
  };
  const heldModifier = (genericVk: number): boolean => {
    for (const state of heldKeys.values()) {
      if (
        state.vk === genericVk ||
        (genericVk === 0x10 && (state.vk === 0xa0 || state.vk === 0xa1)) ||
        (genericVk === 0x11 && (state.vk === 0xa2 || state.vk === 0xa3)) ||
        (genericVk === 0x12 && (state.vk === 0xa4 || state.vk === 0xa5))
      )
        return true;
    }
    return false;
  };
  /**
   * The physical Control key, for the macOS "Control + primary button is a secondary click" repair only: ⌘ playing
   * Ctrl must not turn a real secondary click into a primary one.
   */
  const physicalControl = (event: MouseEvent): boolean => {
    if (event.ctrlKey) return true;
    for (const state of heldKeys.values())
      if (!state.meta && (state.vk === 0x11 || state.vk === 0xa2 || state.vk === 0xa3)) return true;
    return false;
  };
  const modifierFlags = (event: MouseEvent): number => {
    // Some browsers briefly lose PointerEvent.ctrlKey/shiftKey during Pointer Lock;
    // heldKeys maintained by keyboard listeners is authoritative for the same input sequence. Take their union
    // so Ctrl+click reaches the original game with MK_CONTROL, required for force attack.
    return (
      mouseFlags |
      (event.shiftKey || heldModifier(0x10) ? 0x0004 : 0) |
      (event.ctrlKey || heldModifier(0x11) ? 0x0008 : 0)
    );
  };

  // Dispatch the first movement immediately to avoid an extra input frame of latency; coalesce subsequent high-frequency events at frame end.
  // Still accumulate relative movement per event; flush pending MOVE before DOWN/UP/WHEEL to preserve distance and order.
  const flushDesktopMove = () => {
    if (desktopMoveFrame !== null) cancelAnimationFrame(desktopMoveFrame);
    desktopMoveFrame = null;
    const move = pendingDesktopMove;
    pendingDesktopMove = null;
    if (!move) return;
    vm.setCursorPosition(move.x, move.y);
    vm.postMessage(0x0200, move.wParam, move.lParam);
  };
  const scheduleDesktopMove = (event: PointerEvent) => {
    const [x, y] = updateMousePosition(event);
    const lParam = (((y & 0xffff) << 16) | (x & 0xffff)) >>> 0;
    lastMouseLParam = lParam;
    // The local cursor follows input immediately, without waiting for the VM-message rAF coalescing window.
    // Send leading/trailing movements to the guest to avoid Worker-message buildup with high-polling-rate mice.
    onCursorPresentation?.(x, y, document.pointerLockElement === canvas);
    pendingDesktopMove = {
      x,
      y,
      lParam,
      wParam: modifierFlags(event),
    };
    if (desktopMoveFrame === null) {
      flushDesktopMove();
      desktopMoveFrame = requestAnimationFrame(() => {
        desktopMoveFrame = null;
        flushDesktopMove();
      });
    }
  };
  const cancelDesktopMove = () => {
    if (desktopMoveFrame !== null) cancelAnimationFrame(desktopMoveFrame);
    desktopMoveFrame = null;
    pendingDesktopMove = null;
  };

  const pointerButton = (button: number) => {
    if (button === 0) return { down: 0x0201, up: 0x0202, flag: 0x0001, vk: 0x01 };
    if (button === 1) return { down: 0x0207, up: 0x0208, flag: 0x0010, vk: 0x04 };
    if (button === 2) return { down: 0x0204, up: 0x0205, flag: 0x0002, vk: 0x02 };
    return null;
  };

  const releaseMouseButtons = (lParam = lastMouseLParam) => {
    for (const button of [0, 1, 2]) {
      const info = pointerButton(button)!;
      if (!(mouseFlags & info.flag)) continue;
      mouseFlags &= ~info.flag;
      vm.setKeyState(info.vk, false);
      vm.postMessage(info.up, mouseFlags, lParam);
    }
  };

  const syncKeyState = (code: string, vk: number, down: boolean) => {
    vm.setKeyState(vk, down);
    const modifiers: Record<string, [number, number]> = {
      ShiftLeft: [0x10, 0xa0],
      ShiftRight: [0x10, 0xa1],
      ControlLeft: [0x11, 0xa2],
      ControlRight: [0x11, 0xa3],
      AltLeft: [0x12, 0xa4],
      AltRight: [0x12, 0xa5],
    };
    const pair = modifiers[code];
    if (!pair) return;
    const [generic, sided] = pair;
    vm.setKeyState(sided, down);
    const genericDown = [...heldKeys.keys()].some((heldCode) => modifiers[heldCode]?.[0] === generic);
    vm.setKeyState(generic, genericDown);
  };

  const reconcileMouseModifiers = (event: MouseEvent) => {
    const modifiers: Array<{ active: boolean; generic: number; code: string; scanCode: number }> = [
      { active: event.shiftKey, generic: 0x10, code: 'ShiftLeft', scanCode: 0x2a },
      { active: event.ctrlKey || (metaAsControl && event.metaKey), generic: 0x11, code: 'ControlLeft', scanCode: 0x1d },
    ];
    for (const modifier of modifiers) {
      if (!modifier.active) continue;
      const alreadyForwarded = [...heldKeys.values()].some(
        (state) =>
          state.vk === modifier.generic ||
          (modifier.generic === 0x10 && (state.vk === 0xa0 || state.vk === 0xa1)) ||
          (modifier.generic === 0x11 && (state.vk === 0xa2 || state.vk === 0xa3)),
      );
      if (alreadyForwarded) continue;
      heldKeys.set(modifier.code, {
        vk: modifier.generic,
        system: false,
        ...(modifier.generic === 0x11 && !event.ctrlKey ? { meta: true } : {}),
      });
      reconciledModifiers.set(modifier.generic, modifier.code);
      syncKeyState(modifier.code, modifier.generic, true);
      vm.postMessage(0x0100, modifier.generic, 1 | (modifier.scanCode << 16)); // WM_KEYDOWN
    }
  };

  /**
   * A modifier the page still holds although this keyboard event reports it up has lost its keyup (a system shortcut
   * or overlay took the release without the window losing focus). Release it here: a Ctrl or Alt left down turns
   * every later click into a forced order (force fire, force move) and Shift into an add-to-selection. Only keyboard
   * events decide this; pointer events can drop modifier flags during Pointer Lock.
   */
  const releaseStaleModifiers = (event: KeyboardEvent) => {
    for (const [held, state] of [...heldKeys]) {
      const generic =
        state.vk === 0x10 || state.vk === 0xa0 || state.vk === 0xa1
          ? 0x10
          : state.vk === 0x11 || state.vk === 0xa2 || state.vk === 0xa3
            ? 0x11
            : state.vk === 0x12 || state.vk === 0xa4 || state.vk === 0xa5
              ? 0x12
              : 0;
      if (!generic) continue;
      const down =
        generic === 0x10
          ? event.shiftKey
          : generic === 0x12
            ? event.altKey
            : event.ctrlKey || (metaAsControl && event.metaKey);
      if (down) continue;
      heldKeys.delete(held);
      if (reconciledModifiers.get(generic) === held) reconciledModifiers.delete(generic);
      syncKeyState(held, state.vk, false);
      vm.postMessage(state.system ? 0x0105 : 0x0101, state.vk, 0xc000_0001);
    }
  };

  const releaseKeys = () => {
    for (const [code, state] of heldKeys) {
      heldKeys.delete(code);
      syncKeyState(code, state.vk, false);
      vm.postMessage(state.system ? 0x0105 : 0x0101, state.vk, 0xc000_0001);
    }
    reconciledModifiers.clear();
    for (const timer of metaReleaseTimers.values()) window.clearTimeout(timer);
    metaReleaseTimers.clear();
    metaReleased.clear();
  };

  const clearTouchTimer = () => {
    if (touchGesture) window.clearTimeout(touchGesture.timer);
  };

  /** Unified cleanup for all touch cancellation paths: send UP as required by the current phase and leave no fingerless timers running. */
  const cancelTouchGesture = (lParam = lastMouseLParam) => {
    const state = touchGesture;
    if (!state) return;
    clearTouchTimer();
    touchGesture = null;
    if (state.phase === 'drag') {
      mouseFlags &= ~0x0001;
      vm.setKeyState(0x01, false);
      vm.postMessage(0x0202, state.modifiers, lParam);
    } else if (state.phase === 'right' || state.phase === 'two-drag') {
      mouseFlags &= ~0x0002;
      vm.setKeyState(0x02, false);
      vm.postMessage(0x0205, state.modifiers, lParam);
    }
    // pending / two-pending phases have sent no button down and need no compensating up.
  };

  const touchHoldTimer = () => {
    const state = touchGesture;
    if (!state || state.phase !== 'pending') return;
    state.phase = 'right';
    mouseFlags |= 0x0002;
    vm.setKeyState(0x02, true);
    vm.postMessage(0x0204, state.modifiers | 0x0002, state.downLParam); // WM_RBUTTONDOWN
    if (typeof navigator.vibrate === 'function') navigator.vibrate(40);
  };

  const handleTouchPointerDown = (event: PointerEvent) => {
    // On hybrid devices the expanded controls may cover the left touch area; collapse them on contact with the game.
    setControlsCollapsed(true);
    canvas.focus({ preventScroll: true });
    activeTouches.add(event.pointerId);
    const state = touchGesture;
    if (!state) {
      // First finger starts a single-finger gesture; require all other fingers released before starting another to avoid residual contacts.
      if (activeTouches.size !== 1) {
        event.preventDefault();
        return;
      }
      const lParam = mouseLParam(event);
      const x = lParam & 0xffff;
      const y = (lParam >>> 16) & 0xffff;
      touchGesture = {
        pointerId: event.pointerId,
        phase: 'pending',
        downX: x,
        downY: y,
        downLParam: lParam,
        downClientX: event.clientX,
        downClientY: event.clientY,
        twoClientX: 0,
        twoClientY: 0,
        modifiers: modifierFlags(event),
        timer: window.setTimeout(touchHoldTimer, TOUCH_LONG_PRESS_MS),
      };
    } else if (state.phase === 'pending') {
      // Second finger: cancel long-press/tap intent and upgrade to a two-finger gesture.
      clearTouchTimer();
      state.phase = 'two-pending';
      state.twoClientX = state.downClientX;
      state.twoClientY = state.downClientY;
    }
    // Ignore extra fingers after single-finger drag/right or during two-finger phases.
    try {
      canvas.setPointerCapture(event.pointerId);
    } catch {
      // The browser may have canceled the pointer before delivery; pointercancel performs unified cleanup.
    }
    event.preventDefault();
  };

  const handleTouchPointerMove = (event: PointerEvent) => {
    const state = touchGesture;
    if (!state) return;
    const rect = currentCanvasRect(canvas);
    const slopCss = Math.max(3, (5 * (rect.width || 1)) / getFrameSize().width);
    if (state.phase === 'pending') {
      if (event.pointerId !== state.pointerId) return;
      const dx = event.clientX - state.downClientX;
      const dy = event.clientY - state.downClientY;
      // Express the threshold in game pixels, about 5px, independently of canvas CSS scale; avoid false drags when enlarged
      // and sluggish gestures when reduced or on phones.
      if (dx * dx + dy * dy <= slopCss * slopCss) return;
      // Beyond the drag threshold, send left DOWN at the contact origin; the common path has already sent this WM_MOUSEMOVE.
      clearTouchTimer();
      state.phase = 'drag';
      mouseFlags |= 0x0001;
      vm.setKeyState(0x01, true);
      vm.postMessage(0x0201, state.modifiers | 0x0001, state.downLParam); // WM_LBUTTONDOWN
      return;
    }
    if (state.phase === 'two-pending') {
      // If either finger exceeds the movement threshold, press right to begin panning. The cursor is already at the primary finger
      // through the common path; subsequent movement invokes native right-drag map scrolling.
      const dx = event.clientX - state.twoClientX;
      const dy = event.clientY - state.twoClientY;
      if (dx * dx + dy * dy <= slopCss * slopCss) return;
      state.phase = 'two-drag';
      const lParam = (((logicalMouseY & 0xffff) << 16) | (logicalMouseX & 0xffff)) >>> 0;
      mouseFlags |= 0x0002;
      vm.setKeyState(0x02, true);
      vm.postMessage(0x0204, state.modifiers | 0x0002, lParam); // WM_RBUTTONDOWN
      if (typeof navigator.vibrate === 'function') navigator.vibrate(20);
      return;
    }
    // In drag/right/two-drag phases, the common path and cleanup logic handle cursor and button state.
  };

  const handleTouchPointerUp = (event: PointerEvent) => {
    activeTouches.delete(event.pointerId);
    const state = touchGesture;
    if (!state) return;
    const single = state.phase === 'pending' || state.phase === 'drag' || state.phase === 'right';
    if (single) {
      if (event.pointerId !== state.pointerId) return;
      clearTouchTimer();
      // Clear state before releasing capture; lostpointercapture then sees an empty gesture and cannot clean up twice.
      touchGesture = null;
      const upLParam = mouseLParam(event);
      const modifiers = modifierFlags(event);
      if (state.phase === 'pending') {
        // Match desktop click sequences: MOVE/DOWN/UP all use the contact origin. Small finger movement must not
        // turn a tap into a drag; otherwise the game sees different start/end positions,
        // moves only the cursor, and ignores the click. Double taps likewise send a complete second physical click.
        vm.postMessage(0x0200, modifiers, state.downLParam); // Return the cursor to the contact origin.
        // Mobile adaptation: move to the target, read memory to confirm cursor shape, then press the button;
        // attack/move destinations use right-click, while empty ground, friendly units, and UI use left-click.
        scheduleTapClick(state.downLParam, modifiers);
      } else if (state.phase === 'drag') {
        mouseFlags &= ~0x0001;
        vm.setKeyState(0x01, false);
        vm.postMessage(0x0202, modifiers, upLParam);
      } else {
        mouseFlags &= ~0x0002;
        vm.setKeyState(0x02, false);
        vm.postMessage(0x0205, modifiers, upLParam);
      }
    } else {
      // In two-finger mode, release either finger to finish.
      clearTouchTimer();
      touchGesture = null;
      if (state.phase === 'two-pending') {
        // Two-finger tap means right-click: MOVE/RDOWN/RUP all use the primary contact origin, matching trackpads.
        const modifiers = modifierFlags(event);
        vm.postMessage(0x0200, modifiers, state.downLParam);
        vm.postMessage(0x0204, modifiers | 0x0002, state.downLParam);
        vm.postMessage(0x0205, modifiers, state.downLParam);
      } else {
        // two-drag ends panning: release right-click and leave the cursor at the primary finger, even if the secondary finger was released.
        const modifiers = modifierFlags(event);
        const upLParam = (((logicalMouseY & 0xffff) << 16) | (logicalMouseX & 0xffff)) >>> 0;
        vm.postMessage(0x0200, modifiers, upLParam);
        mouseFlags &= ~0x0002;
        vm.setKeyState(0x02, false);
        vm.postMessage(0x0205, modifiers, upLParam); // WM_RBUTTONUP
      }
    }
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    event.preventDefault();
  };

  const releaseInput = () => {
    lockAfterPointerUp = false;
    lockOnDownGesture = false;
    compatibilityCtrlPrimaryActive = false;
    cancelDesktopMove();
    cancelTouchGesture();
    cancelShiftBurst();
    releaseMouseButtons();
    releaseKeys();
    mouseFlags = 0;
  };

  const requestMouseLock = async () => {
    if (inputDisposed || pointerLockPending || document.pointerLockElement === canvas) return;
    pointerLockPending = true;
    const revision = ++pointerLockRevision;
    try {
      // Windows Chromium does not allow the same pointer in Pointer Capture and Pointer Lock simultaneously.
      // The initial locking click releases capture before pointerup; locked events remain directed to the canvas.
      // Request unadjustedMovement only when raw counts are explicitly enabled; if the platform rejects it,
      // retry without options because ordinary pointer locking remains available.
      try {
        await canvas.requestPointerLock(rawMouse ? { unadjustedMovement: true } : undefined);
      } catch (error) {
        if (!rawMouse || !(error instanceof DOMException)) throw error;
        await canvas.requestPointerLock();
      }
      if ((inputDisposed || revision !== pointerLockRevision) && document.pointerLockElement === canvas)
        document.exitPointerLock();
    } catch (error) {
      console.warn(t('[VM input] 浏览器拒绝鼠标锁定'), error);
    } finally {
      pointerLockPending = false;
    }
  };

  const releasePointerLock = () => {
    pointerLockRevision++;
    lockAfterPointerUp = false;
    if (document.pointerLockElement !== canvas) return;
    releaseInput();
    document.exitPointerLock();
  };

  const finishDesktopPointerUp = (event: PointerEvent, desktopMouse: boolean) => {
    if (!mouseFlags && canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    if (!desktopMouse || mouseFlags || !lockAfterPointerUp) return;
    lockAfterPointerUp = false;
    if (document.pointerLockElement === canvas) return;
    // releasePointerCapture must precede Pointer Lock; the call is still inside the trusted pointerup
    // user gesture, so Chromium permits acquiring the lock.
    void requestMouseLock();
  };

  on(
    canvas,
    'pointermove',
    (event) => {
      if (event.pointerType === 'touch') {
        // Every finger enters the gesture machine, since either may trigger a two-finger drag; only the primary finger uses the common path
        // to send WM_MOUSEMOVE. During two-finger panning, the edge-cursor timer instead
        // drives position here, avoiding movement that conflicts with the panning direction.
        // The cursor always follows the primary finger; two-finger drags hold right-click so the map pans with it.
        if (event.isPrimary) vm.postMessage(0x0200, modifierFlags(event), mouseLParam(event));
        handleTouchPointerMove(event);
        event.preventDefault();
        return;
      }
      if (!event.isPrimary) return;
      scheduleDesktopMove(event);
      if (mouseFlags || event.pointerType !== 'mouse') event.preventDefault();
    },
    { passive: false },
  );
  on(
    canvas,
    'pointerdown',
    (event) => {
      // Every touch finger enters the gesture machine; the second upgrades to a two-finger gesture.
      if (event.pointerType === 'touch') {
        handleTouchPointerDown(event);
        return;
      }
      if (!event.isPrimary) return;
      const controlDown = physicalControl(event);
      const button = normalizePointerButton(event.button, controlDown, hostPlatform, event.buttons);
      const info = pointerButton(button);
      if (!info) return;
      normalizedPointerButtons.set(event.pointerId, button);
      flushDesktopMove();
      canvas.focus({ preventScroll: true });
      reconcileMouseModifiers(event);
      const lParam = mouseLParam(event);
      if (button === 0 && controlDown) {
        lastCtrlPrimaryDispatch = { at: performance.now(), lParam };
      }
      const desktopMouse = event.pointerType === 'mouse';
      // Freeze this policy for the gesture: returning to a menu must not lose its physical UP.
      lockOnDownGesture = desktopMouse && (options.lockPointerOnDown?.() ?? false);
      if (
        lockDesktopMouse &&
        desktopMouse &&
        document.pointerLockElement !== canvas &&
        (options.canLockPointer?.() ?? true)
      )
        lockAfterPointerUp = true;
      mouseFlags |= info.flag;
      vm.setKeyState(info.vk, true);
      const repeat =
        desktopMouse &&
        info.vk === 0x01 &&
        event.shiftKey &&
        (options.shiftClickRepeat?.(lParam & 0xffff, (lParam >>> 16) & 0xffff, getFrameSize()) ?? true);
      if (repeat) {
        startShiftBurst(lParam, modifierFlags(event));
      } else {
        vm.postMessage(info.down, modifierFlags(event), lParam);
      }
      notify('pointerdown', `Mouse${button}`, lParam);
      const lockFromDown = lockAfterPointerUp && lockOnDownGesture;
      if (lockFromDown) {
        // Battles must confine the very first held drag. Request without
        // Pointer Capture: Chromium cannot own the same pointer in both modes.
        // A real mouseup listener below preserves UP if the browser switches its
        // PointerEvent stream while the request is pending.
        lockAfterPointerUp = false;
        void requestMouseLock().then(() => {
          if (inputDisposed || !mouseFlags || document.pointerLockElement === canvas) return;
          try {
            canvas.setPointerCapture(event.pointerId);
          } catch {
            // The physical release may have already ended this pointer.
          }
        });
      }
      // The after-up mode captures its complete initial menu click. The immediate
      // battle mode instead leaves capture free for Pointer Lock acquisition.
      if (!lockFromDown && (!desktopMouse || document.pointerLockElement !== canvas)) {
        try {
          canvas.setPointerCapture(event.pointerId);
        } catch {
          // The browser may have canceled the pointer before delivery; later pointercancel releases state consistently.
        }
      }
      event.preventDefault();
    },
    { passive: false },
  );
  on(
    canvas,
    'pointerup',
    (event) => {
      // Every touch finger must enter the gesture machine; the secondary finger may finish a two-finger gesture.
      if (event.pointerType === 'touch') {
        handleTouchPointerUp(event);
        return;
      }
      if (!event.isPrimary) return;
      const button =
        normalizedPointerButtons.get(event.pointerId) ??
        normalizePointerButton(event.button, physicalControl(event), hostPlatform, event.buttons);
      normalizedPointerButtons.delete(event.pointerId);
      const info = pointerButton(button);
      if (!info) return;
      flushDesktopMove();
      notify('pointerup', `Mouse${button}`, mouseLParam(event));
      const desktopMouse = event.pointerType === 'mouse';
      if (info.vk === 0x01 && shiftBurstTimer !== null) {
        // During Shift-repeat, the repeater already sends each down/up pair; physical up only clears state without another event.
        mouseFlags &= ~info.flag;
        vm.setKeyState(info.vk, false);
        finishDesktopPointerUp(event, desktopMouse);
        event.preventDefault();
        return;
      }
      const lParam = mouseLParam(event);
      // blur/releaseInput may already have sent UP; dispatch only for buttons still recorded as held.
      if ((mouseFlags & info.flag) !== 0) {
        mouseFlags &= ~info.flag;
        vm.setKeyState(info.vk, false);
        vm.postMessage(info.up, modifierFlags(event), lParam);
      }
      // With multiple mouse buttons, Pointer Events guarantee only the first pointerdown and final pointerup;
      // the last released event.button may differ from the initially recorded button, so use buttons=0 for unified cleanup.
      if (event.buttons === 0) releaseMouseButtons(lParam);
      finishDesktopPointerUp(event, desktopMouse);
      event.preventDefault();
    },
    { passive: false },
  );
  // macOS Edge may downgrade Ctrl+primary entirely to compatibility MouseEvents, with no corresponding
  // PointerEvent. Normal PointerEvent handling records lastCtrlPrimaryDispatch first,
  // so supplement only when absent to avoid duplicate DOWN/UP on other browsers.
  on(canvas, 'mousedown', (event) => {
    const controlDown = physicalControl(event);
    if (!controlDown || normalizePointerButton(event.button, controlDown, hostPlatform, event.buttons) !== 0) return;
    const lParam = mouseLParam(event);
    if (
      lastCtrlPrimaryDispatch &&
      performance.now() - lastCtrlPrimaryDispatch.at < 250 &&
      lastCtrlPrimaryDispatch.lParam === lParam
    ) {
      event.preventDefault();
      return;
    }
    flushDesktopMove();
    canvas.focus({ preventScroll: true });
    reconcileMouseModifiers(event);
    mouseFlags |= 0x0001;
    vm.setKeyState(0x01, true);
    vm.postMessage(0x0201, modifierFlags(event), lParam);
    compatibilityCtrlPrimaryActive = true;
    lastCtrlPrimaryDispatch = { at: performance.now(), lParam };
    event.preventDefault();
  });
  on(canvas, 'mouseup', (event) => {
    if (!compatibilityCtrlPrimaryActive) return;
    compatibilityCtrlPrimaryActive = false;
    const lParam = mouseLParam(event);
    if ((mouseFlags & 0x0001) !== 0) {
      mouseFlags &= ~0x0001;
      vm.setKeyState(0x01, false);
      vm.postMessage(0x0202, modifierFlags(event), lParam);
    }
    event.preventDefault();
  });
  on(window, 'mouseup', (event) => {
    if (!lockOnDownGesture || !mouseFlags) return;
    // Lock acquisition can end the initial PointerEvent sequence in Chromium.
    // This fallback consumes only the real physical mouseup, after the ordinary
    // pointerup has had first refusal; already released buttons never repeat.
    const button = normalizePointerButton(event.button, physicalControl(event), hostPlatform, event.buttons);
    const info = pointerButton(button);
    if (!info || !(mouseFlags & info.flag)) return;
    flushDesktopMove();
    const lParam = mouseLParam(event);
    mouseFlags &= ~info.flag;
    vm.setKeyState(info.vk, false);
    if (info.vk === 0x01 && shiftBurstTimer !== null) return;
    vm.postMessage(info.up, modifierFlags(event), lParam);
    notify('pointerup', `Mouse${button}`, lParam);
    if (event.buttons === 0) releaseMouseButtons(lParam);
  });
  on(
    canvas,
    'pointercancel',
    (event) => {
      if (event.pointerType === 'touch') {
        activeTouches.delete(event.pointerId);
        cancelTouchGesture(mouseLParam(event));
        if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
        event.preventDefault();
        return;
      }
      if (!event.isPrimary) return;
      // Acquiring lock can cancel capture without releasing the physical button.
      // The real mouseup fallback, blur or lock exit still releases that button.
      if (lockOnDownGesture && pointerLockPending) return;
      normalizedPointerButtons.delete(event.pointerId);
      lockAfterPointerUp = false;
      cancelShiftBurst();
      flushDesktopMove();
      releaseMouseButtons(mouseLParam(event));
      if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
      event.preventDefault();
    },
    { passive: false },
  );
  on(canvas, 'lostpointercapture', (event) => {
    // Cancel pending touch timers here, or a right-click could fire after every finger has left.
    if (touchGesture && event.pointerId === touchGesture.pointerId) cancelTouchGesture();
    // Pointer Lock actively ends capture; this does not mean the player released the button.
    if (document.pointerLockElement !== canvas && !(lockOnDownGesture && pointerLockPending)) releaseMouseButtons();
  });
  on(canvas, 'dblclick', (event) => {
    // USER32 already generates Win32 double-clicks from two physical clicks and class styles; suppress only browser defaults here.
    event.preventDefault();
  });
  on(
    canvas,
    'wheel',
    (event) => {
      if (!event.deltaY) return;
      flushDesktopMove();
      const delta = event.deltaY < 0 ? 120 : -120;
      const wParam = ((delta & 0xffff) << 16) | modifierFlags(event);
      vm.postMessage(0x020a, wParam, mouseLParam(event));
      event.preventDefault();
    },
    { passive: false },
  );
  on(canvas, 'contextmenu', (event) => {
    event.preventDefault();
    // macOS/WebKit may promote Ctrl+primary directly to contextmenu without a usable
    // left pointerdown. Deduplicate by position/time when the normal pointer path already dispatched it.
    if (!event.ctrlKey || normalizePointerButton(2, true, hostPlatform) !== 0) return;
    const lParam = mouseLParam(event);
    if (
      lastCtrlPrimaryDispatch &&
      performance.now() - lastCtrlPrimaryDispatch.at < 1_000 &&
      lastCtrlPrimaryDispatch.lParam === lParam
    ) {
      // Edge/macOS may omit pointerup after showing contextmenu following DOWN.
      // Send the missing UP immediately; a later physical pointerup is skipped because mouseFlags is already cleared.
      if ((mouseFlags & 0x0001) !== 0) {
        mouseFlags &= ~0x0001;
        vm.setKeyState(0x01, false);
        vm.postMessage(0x0202, modifierFlags(event), lParam);
      }
      compatibilityCtrlPrimaryActive = false;
      return;
    }
    flushDesktopMove();
    canvas.focus({ preventScroll: true });
    reconcileMouseModifiers(event);
    const modifiers = modifierFlags(event);
    vm.postMessage(0x0200, modifiers, lParam); // WM_MOUSEMOVE
    vm.setKeyState(0x01, true);
    vm.postMessage(0x0201, modifiers | 0x0001, lParam); // WM_LBUTTONDOWN
    vm.setKeyState(0x01, false);
    vm.postMessage(0x0202, modifiers, lParam); // WM_LBUTTONUP
    lastCtrlPrimaryDispatch = { at: performance.now(), lParam };
  });
  on(canvas, 'dragstart', (event) => event.preventDefault());
  on(canvas, 'auxclick', (event) => event.preventDefault());

  on(
    window,
    'keydown',
    (event) => {
      // Page shortcuts (` debug / [ ] speed / F11 fullscreen / ? help / \\ HD view) are not injected into the game.
      if (UI_SHORTCUT_KEYS.has(event.key)) return;
      if (document.activeElement !== canvas || event.isComposing) return;
      // A key can follow a physical move before the pending pointer rAF runs.
      // Preserve that position before key state/messages reach either backend.
      flushDesktopMove();
      releaseStaleModifiers(event);
      const code = forwardedCode(event.code);
      const mapped = code !== event.code;
      const key: KeyLike = mapped
        ? { code, key: 'Control', location: event.location, altKey: event.altKey, ctrlKey: true, metaKey: false }
        : event;
      const vk = virtualKey(key);
      if (!vk) return;
      const wasDown = heldKeys.has(code);
      const system = event.altKey || code === 'AltLeft' || code === 'AltRight';
      heldKeys.set(code, mapped ? { vk, system, meta: true } : { vk, system });
      syncKeyState(code, vk, true);
      const lParam = keyLParam(key, false, wasDown);
      vm.postMessage(system ? 0x0104 : 0x0100, vk, lParam); // WM_SYSKEYDOWN / WM_KEYDOWN
      const character = win32CharacterCode(event);
      if (character !== null) vm.postMessage(0x0102, character, lParam); // WM_CHAR
      if (!wasDown && !MODIFIER_CODES.has(event.code)) notify('keydown', code);
      if (metaAsControl && event.metaKey && !MODIFIER_CODES.has(event.code)) {
        // macOS sends no keyup for this key while ⌘ stays down: release it here so it can be pressed again.
        const previous = metaReleaseTimers.get(code);
        if (previous !== undefined) window.clearTimeout(previous);
        metaReleaseTimers.set(
          code,
          window.setTimeout(() => {
            metaReleaseTimers.delete(code);
            const state = heldKeys.get(code);
            if (!state) return;
            flushDesktopMove();
            heldKeys.delete(code);
            metaReleased.add(code);
            syncKeyState(code, state.vk, false);
            vm.postMessage(state.system ? 0x0105 : 0x0101, state.vk, keyLParam(key, true, true));
          }, META_KEY_RELEASE_MS),
        );
      }
      event.preventDefault();
      event.stopPropagation();
    },
    { capture: true },
  );
  on(
    window,
    'keyup',
    (event) => {
      if (UI_SHORTCUT_KEYS.has(event.key)) return;
      const code = forwardedCode(event.code);
      if (metaReleased.delete(code)) {
        // Already released by the page while ⌘ was held; the late physical keyup has nothing left to do.
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      const genericModifier =
        code === 'ShiftLeft' || code === 'ShiftRight'
          ? 0x10
          : code === 'ControlLeft' || code === 'ControlRight'
            ? 0x11
            : 0;
      const reconciledCode = genericModifier ? reconciledModifiers.get(genericModifier) : undefined;
      const state = heldKeys.get(code) ?? (reconciledCode ? heldKeys.get(reconciledCode) : undefined);
      if (document.activeElement !== canvas && !state) return;
      const key: KeyLike =
        code !== event.code
          ? { code, key: 'Control', location: event.location, altKey: event.altKey, ctrlKey: false, metaKey: false }
          : event;
      const vk = state?.vk ?? virtualKey(key);
      if (!vk) return;
      flushDesktopMove();
      const system = state?.system || event.altKey || code === 'AltLeft' || code === 'AltRight';
      if (reconciledCode) {
        heldKeys.delete(reconciledCode);
        reconciledModifiers.delete(genericModifier);
        syncKeyState(reconciledCode, genericModifier, false);
      }
      heldKeys.delete(code);
      syncKeyState(code, vk, false);
      vm.postMessage(system ? 0x0105 : 0x0101, vk, keyLParam(key, true, true)); // WM_SYSKEYUP / WM_KEYUP
      event.preventDefault();
      event.stopPropagation();
    },
    { capture: true },
  );
  on(canvas, 'blur', releaseInput);
  on(window, 'blur', releaseInput);
  const visibilityChanged = () => {
    if (document.hidden) releaseInput();
  };
  document.addEventListener('visibilitychange', visibilityChanged);
  removers.push(() => document.removeEventListener('visibilitychange', visibilityChanged));

  // Pointer-lock effect: an amber outer border and four viewfinder corners pulse while locked
  // (#screen-frame.pointer-locked), with a temporary top hint to press Esc to unlock.
  // The hint fades after a few seconds; the border/corners remain because the browser hides the cursor.
  const lockHint = document.createElement('div');
  lockHint.className = 'pointer-lock-hint';
  canvas.parentElement?.appendChild(lockHint);
  removers.push(() => lockHint.remove());
  let keyboardLockState: KeyboardLockState = 'inactive';
  const showLockHint = () => {
    // Wait for the actual escape behavior, not the browser's permission request.
    if (document.pointerLockElement !== canvas || keyboardLockState === 'pending' || pointerLockHintShown.has(canvas))
      return;
    pointerLockHintShown.add(canvas);
    const message =
      keyboardLockState === 'active'
        ? 'Esc 已交给游戏 · 长按 Esc 释放鼠标，或打开游戏菜单'
        : '鼠标已限制在游戏里 · 按 Esc 释放鼠标，再点游戏继续';
    lockHint.textContent = vm.runtimeInfo?.backend === 'native' ? message : t(message);
    lockHint.classList.remove('show');
    void lockHint.offsetWidth;
    lockHint.classList.add('show');
  };
  removers.push(
    installFullscreenKeyboardLock(
      canvas,
      (state) => {
        keyboardLockState = state;
        if (state !== 'inactive' || document.pointerLockElement === canvas) showLockHint();
        else lockHint.classList.remove('show');
      },
      metaAsControl ? null : ['Escape'],
    ),
  );

  const pointerLockChanged = () => {
    if (document.pointerLockElement === canvas) {
      // Toolbar collapse, resolution changes, and canvas fitting may occur in one layout cycle without a stage ResizeObserver
      // callback. Read the actual CSS box before Pointer Lock switches from absolute to relative coordinates,
      // avoiding stale 800x600/height ratios that slow edge movement and prevent reaching the boundary.
      refreshCanvasRect(canvas);
      lockAfterPointerUp = false;
      onCursorPresentation?.(Math.floor(logicalMouseX), Math.floor(logicalMouseY), true);
      canvas.focus({ preventScroll: true });
      canvas.parentElement?.classList.add('pointer-locked');
      showLockHint();
    } else {
      onCursorPresentation?.(Math.floor(logicalMouseX), Math.floor(logicalMouseY), false);
      cancelTouchGesture();
      releaseMouseButtons();
      canvas.parentElement?.classList.remove('pointer-locked');
      lockHint.classList.remove('show');
      // Tab switching, blur, and script exits also release Pointer Lock; never infer that the user pressed Esc.
      // Game keystrokes come only from real keyboard events; fullscreen Keyboard Lock captures Esc.
    }
  };
  document.addEventListener('pointerlockchange', pointerLockChanged);
  removers.push(() => document.removeEventListener('pointerlockchange', pointerLockChanged));
  // The startup screen can obtain confinement from its Start gesture before
  // the runtime is ready. Adopt that existing lock without requiring another click.
  if (document.pointerLockElement === canvas) pointerLockChanged();

  return {
    adaptResolution,
    pointerPosition: () => (pointerTracked ? { x: Math.floor(logicalMouseX), y: Math.floor(logicalMouseY) } : null),
    releasePointerLock,
    cleanup() {
      inputDisposed = true;
      pointerLockRevision++;
      pointerTracked = false;
      releaseInput();
      removers.splice(0).forEach((remove) => remove());
      canvas.parentElement?.classList.remove('pointer-locked');
      if (document.pointerLockElement === canvas) {
        document.exitPointerLock();
      }
    },
  };
}
