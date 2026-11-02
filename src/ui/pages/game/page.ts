import { t } from '../../shared/i18n/translate';
import type { LiveModelId } from './experiments/modelProbe';
import { FrameEffectController } from '../../../app/session/frameEffectController';
import {
  bootState,
  debugState,
  debugVisible,
  helpVisible,
  gameFocus,
  hotkeySheet,
  hotkeySheetVisible,
  trainingPanel,
  mainPanel,
  resourceStatus,
  networkStatus,
  upscaleStatus,
  hdStatus,
  runtimeNotice,
  selectGameFiles,
  cancelSourceRequest,
  mapRequest,
  gameRunning,
  movieSkip,
} from './state/uiState';
import { createVmShell, type VmShell } from '../../../adapter/runtime';
import type { VmStatus } from '../../../app/session/runtimeEvents';
import { DEFAULT_MASTER_VOLUME } from '../../../adapter/audio';
import type { Win32Call } from '../../../vm86/win32';
import type { SupportedGameId } from '../../../games/catalog';
import { installAdaptiveTouchControls } from './touchControls';
import { installWakeLock } from './wakeLock';
import { createVmFrameRenderer } from './vmFrameRenderer';
import { aiUpscaleEnabled, fsrUpscaleMode, scalefxUpscaleEnabled, spatialUpscaleEnabled } from './spatialUpscale';
import {
  installCanvasFit,
  installGameInput,
  setSessionShortcutKey,
  toggleImmersiveFullscreen,
  type GameInputObservation,
} from './gameInput';
import { installRuntimeToolbar } from './runtimeToolbar';
import { restoreCachedGameSource } from './gameSourcePicker';
import { desktopPointerLock, nativeAutoStart, prepareNativeViewport } from './nativeStartup';
import { measurePlayViewport, prepareWebPlayViewport } from './playStartup';
import { identifyYrHdMenu } from '../../../games/yr/hdMenus';
import { parseTrainingQuery, trainingHref } from './training/trainingQuery';
import { supportedGame } from '../../../games/catalog';
import { progressiveFilesOf } from '../../../adapter/progressiveFiles';
import { VmSessionController, guardVmCallbacks } from '../../../app/session/vmSessionController';
import { startSessionRuntime } from '../../../app/session/startSessionRuntime';
import { startDisplayRefresh } from '../../../graphics/displayRefresh';
import { FramePresenter } from '../../../graphics/framePresenter';
import { forgetGameDirectory } from '../../../platform/browser/files/directoryAccess';
import { type GameSource } from '../../../games/source';
import { clearCachedGameFiles, loadCustomMapFiles } from '../../../adapter/cachedGameFiles';
import { createVmRuntimeCallbacks } from './vmPageRuntimeCallbacks';
import { createNativeCursorFrames } from './nativeCursorFrames';
import { installAmbientFill, type AmbientFill } from './ambientFill';
import { createVmPageToolbarActions } from './vmPageToolbarActions';
import {
  DEFAULT_VIEW_CHOICE,
  loadStoredResolutionChoice,
  nativeViewportChoice,
  parseResolutionChoice,
  resolveResolutionChoice,
  resolutionViewScale,
  resolveResolutionViewScale,
  storeResolutionChoice,
  type ResolutionChoice,
} from './vmPageResolution';
import type { GameResolution } from '../../../games/resolution';
import { parseGameSpeed } from '../../../games/gameSpeed';
import type { HdBridgeControl } from './hdBridge';

let activeVm: VmShell | null = null;
let refreshNoticeShown = false;
const pageController = new VmSessionController();
let activeKeyHandler: ((event: KeyboardEvent) => void) | null = null;
let activeInputCleanup: (() => void) | null = null;
let activeToolbarCleanup: (() => void) | null = null;
let activeResourceCleanup: (() => void) | null = null;
let activeNetworkCleanup: (() => void) | null = null;
let pageGeneration = 0;
let activeRendererCleanup: (() => void) | null = null;
/** HD remaster bridge (dev, ?hd=1): see hdBridge.ts. Stopped before the VM it polls is destroyed. */
let activeHdCleanup: (() => void) | null = null;
const hdBridgeRequested = import.meta.env.DEV && new URLSearchParams(window.location.search).get('hd') === '1';
/** `?game-speed=`: startup speed of this page's sessions on the original scale (0 fastest, 3 normal, 6 slowest). */
const sessionGameSpeed = parseGameSpeed(new URLSearchParams(window.location.search).get('game-speed'));
/**
 * `?mac-cmd-ctrl=0` turns off the Apple-keyboard mapping that lets ⌘ act as the game's Ctrl key (on by default; it has no
 * effect on other platforms). `?debug-key=0` gives the backquote key back to the game instead of toggling the debug
 * panel, for play sessions where a slip next to the "1" key must not open it.
 */
const metaAsControl = new URLSearchParams(window.location.search).get('mac-cmd-ctrl') !== '0';
const debugKeyEnabled = new URLSearchParams(window.location.search).get('debug-key') !== '0';
/** Observer of forwarded inputs (practice lessons); replaced per session, never able to block input. */
let inputObserver: ((observation: GameInputObservation) => void) | null = null;
/** Practice mode (development, `?train=`): see training/trainingQuery.ts. Stopped before the VM it polls is destroyed. */
const trainingQuery = parseTrainingQuery(window.location.search);
let activeTrainingCleanup: (() => void) | null = null;
/** Page shortcut that switches between the HD view and the original picture; the game's own key without a bridge. */
const HD_VIEW_KEY = '\\';

// Actual frames update guest logical coordinates; 800x600 is only a compatibility default before the first frame.
let gameFrameWidth = 800;
let gameFrameHeight = 600;
let refitActiveCanvas: (frameWidth?: number, frameHeight?: number) => void = () => {};
let canvasFitInstalled = false;
let activeFitCleanup: (() => void) | null = null;
let activeNativeViewportAbort: AbortController | null = null;
/** The current session's resolution choice; the canvas fit shows a display-matched frame at whole device pixels. */
let activeResolutionChoice: ResolutionChoice = null;
let activeDisplayScale: number | undefined;

export async function startVmPage(canvas: HTMLCanvasElement, resumedSource?: GameSource): Promise<void> {
  const generation = ++pageGeneration;
  let requestedResolution: GameResolution | null = null;
  let nativeArea: { width: number; height: number; dpr: number } | null = null;
  let resizeTimer: number | undefined;
  let resizeBusy = false;
  let refreshNoticeTimer: number | undefined;
  let restartForViewport = async () => {};
  /** Apply a toolbar choice on the native route; undefined where the launcher cannot restart this session. */
  let restartForNativeView: ((choice: ResolutionChoice) => Promise<void>) | undefined;
  const readArea = () => measurePlayViewport(canvas);
  movieSkip.set(null);
  activeNativeViewportAbort?.abort();
  activeNativeViewportAbort = null;
  /** Ambient side fill beside the game's fixed-size front end (see ambientFill.ts); owned by this page's renderer. */
  let ambientFill: AmbientFill | null = null;
  // Release the old presentation and size listeners before switching sessions so resize callbacks cannot retain prior closures.
  activeTrainingCleanup?.();
  activeHdCleanup?.();
  activeHdCleanup = null;
  activeRendererCleanup?.();
  activeRendererCleanup = null;
  activeFitCleanup?.();
  activeFitCleanup = null;
  canvasFitInstalled = false;
  activeResolutionChoice = null;
  activeDisplayScale = undefined;
  await pageController.destroy();
  if (generation !== pageGeneration) return;
  activeVm = null;
  if (!canvasFitInstalled) {
    canvasFitInstalled = true;
    // Backing-store resets clear the bitmap; force an immediate redraw after resizing or sparse-frame scenes such as menus
    // remain blank until the next frame, appearing broken. This callback runs only on resize,
    // after the let declarations below initialize; capturing TDZ variables is safe because they are not accessed early.
    const fit = installCanvasFit(
      canvas,
      () => ({ width: gameFrameWidth, height: gameFrameHeight }),
      () => {
        presenter.invalidate();
      },
      {
        fillStage: () => true,
        devicePixelBacking: () => hdBridgeRequested,
        onFit: (width, height, scale, fillScale) => {
          toolbar.setDisplayScale(
            width,
            height,
            scale,
            fillScale,
            resolutionViewScale(activeResolutionChoice) !== null ? requestedResolution : null,
            activeDisplayScale,
            nativeArea !== null && JSON.stringify(nativeArea) !== JSON.stringify(readArea()),
          );
          // onFit runs before the fit writes the canvas's new CSS box; measure once this fit has finished.
          queueMicrotask(() => ambientFill?.relayout());
        },
      },
    );
    refitActiveCanvas = fit;
    activeFitCleanup = fit.destroy;
  }
  // By default WebGL2 shaders expand 8-bit indexed frames; ?webgl=0 forces Canvas 2D
  // for comparison when hardware acceleration is unavailable or specific browsers fall back.
  const frameRenderer = createVmFrameRenderer(
    canvas,
    new URLSearchParams(window.location.search).get('webgl') !== '0',
    spatialUpscaleEnabled(window.location.search),
    fsrUpscaleMode(window.location.search),
    scalefxUpscaleEnabled(window.location.search),
    aiUpscaleEnabled(window.location.search),
    new URLSearchParams(window.location.search).get('sr-model') === 'fast' ? 'fast' : 'gan',
    hdBridgeRequested,
  );
  // The bridge composites through the WebGL2 renderer's alpha channel. Canvas 2D (?webgl=0, or no WebGL2 context) draws
  // every frame opaque, so the key-coloured tactical view would show as solid magenta: keep the bridge and the game's
  // passthrough patches off there.
  const hdBridgeEnabled = hdBridgeRequested && frameRenderer.backend === 'WebGL2';
  if (hdBridgeRequested && !hdBridgeEnabled) console.warn('[HD] ?hd=1 needs the WebGL2 frame renderer; HD bridge off');
  /** This session's HD bridge; releaseRuntime stops it, and a bridge whose import resolves after release never starts. */
  let hdCleanup: HdBridgeControl | null = null;
  /** Game-speed telemetry of this session (development only, see speedTelemetry.ts); stopped with the runtime. */
  let speedCleanup: (() => void) | null = null;
  let feelTelemetry: ReturnType<(typeof import('./sessionFeelTelemetry'))['startSessionFeelTelemetry']> | null = null;
  let nativeCursor: Awaited<ReturnType<(typeof import('./nativeCursor'))['createNativeCursor']>> = null;
  let hdMenus: import('./hdMenus').HdMenus | null = null;
  const menuAbort = new AbortController();
  const menuFrameListeners = new Set<() => void>();
  let hdViewEnabled = true;
  /** Game frames presented since the page started this session (the telemetry takes differences). */
  let presentedFrames = 0;
  /** Switch between the HD view and the original picture (toolbar button and the \\ key); no-op without a bridge. */
  const toggleHdView = () => {
    if (hdCleanup) {
      const enabled = hdCleanup.toggle();
      hdViewEnabled = enabled;
      toolbar.setHdView(enabled);
      hdMenus?.setEnabled(enabled);
    }
  };
  let runtimeReleased = false;
  const calls: string[] = [];
  /** Cumulative calls per Win32 API; the backtick panel shows top hotspots for performance diagnosis. */
  const callHistogram = new Map<string, number>();
  const exposeRuntimeCallProbe = () => {
    if (!debugAutoOpen) return;
    canvas.dataset.vmBinkCalls = JSON.stringify(
      Object.fromEntries([...callHistogram].filter(([key]) => key.startsWith('BINKW32.DLL!'))),
    );
    canvas.dataset.vmAudioCalls = JSON.stringify(
      Object.fromEntries(
        [...callHistogram].filter(([key]) => key.startsWith('DSOUND.COM!') || key.startsWith('WINMM.DLL!waveOut')),
      ),
    );
    canvas.dataset.vmTextOutCalls = String(callHistogram.get('GDI32.DLL!TextOutA') ?? 0);
  };
  // Do not create the debug panel or collect samples by default: DOM updates and guest-memory sampling cost time, and the panel obscures gameplay.
  // ?debug=1 opens it at startup; otherwise the first backtick creates it lazily, and later presses toggle visibility.
  const debugAutoOpen = new URLSearchParams(window.location.search).get('debug') === '1';
  let status: VmStatus = { phase: 'loading', detail: t('初始化…') };
  let callCount = 0;
  let lastPointerProbeAt = 0;
  let pointerProbeSeq = 0;
  let requestedClockRate = 1;
  // Default gain and initial toolbar slider values share one source: DEFAULT_VOLUME_PERCENT derives from DEFAULT_MASTER_VOLUME,
  // avoiding separate literals in page, toolbar, and Worker configuration.
  let requestedVolume = DEFAULT_MASTER_VOLUME;
  let performanceLine = t('HC --/s · 主线程阻塞 --');
  let schedulePerformanceRender = () => {};
  let exitHandled = false;
  let vm: VmShell | null = null;
  let adaptInputResolution: ((width: number, height: number) => void) | null = null;
  let inputPointerPosition: (() => Readonly<{ x: number; y: number }> | null) | null = null;
  let releaseInputPointerLock: (() => void) | null = null;
  let softwarePointerActive = false;
  let pointerMenuPending = false;
  let pointerMenuActive = false;
  let pointerMenuCheck: Promise<void> | null = null;
  let pointerMenuCheckedAt = 0;
  let gameSource: GameSource | null = null;
  let selectedGameId: SupportedGameId | null = null;
  let changeGameSource = async () => {
    await forgetGameDirectory();
    window.location.reload();
  };
  let restartForResolution = async () => {
    window.location.reload();
  };
  const presenter: FramePresenter = new FramePresenter(frameRenderer, {
    targetSize: () => ({ width: canvas.width, height: canvas.height }),
    transform: (frame) => effects.transform(frame),
    presented: () => {
      effects.publishStatus(frameRenderer.upscaleStatus);
      presentedFrames++;
      for (const listener of menuFrameListeners) listener();
      // Same task as the draw: the WebGL drawing buffer is still readable here.
      ambientFill?.presented();
      toolbar.recordPresentedFrame();
      feelTelemetry?.frame('original', presenter.frameVersion);
      if (!nativeCursor) feelTelemetry?.pointerDrawn();
    },
    tick: () => renderDebug(),
  });
  const effects: FrameEffectController<LiveModelId> = new FrameEffectController<LiveModelId>({
    create: import.meta.env.DEV
      ? async (changed) => {
          const { LiveModel } = await import('./experiments/liveModel');
          return new LiveModel(changed);
        }
      : async () => {
          throw new Error(t('生产模式不开放模型实验'));
        },
    currentFrame: () => presenter.frame,
    isCurrent: () => generation === pageGeneration && !exitHandled,
    invalidate: () => presenter.invalidate(),
    beforeLoad: () => {
      // The enhancement model already upscaled by its native factor; do not stack CNN/GAN in the display stage.
      frameRenderer.setUpscaleMode('off');
      toolbar.setUpscaleMode('off');
    },
    publish: (value) => upscaleStatus.set(value),
  });
  const scheduleRender = () => presenter.schedule();
  if (new URLSearchParams(window.location.search).get('ambient-fill') !== '0')
    ambientFill = installAmbientFill({
      screen: canvas,
      signals: () => {
        // The submitted original picture, not an enhanced one: model output has its own size.
        const frame = presenter.frame;
        return {
          shellSurface: gameSource?.game.shellSurface ?? null,
          matchSurface: requestedResolution,
          frame: frame
            ? {
                width: frame.width,
                height: frame.height,
                matchPicture: frame.matchGeneration !== undefined || frame.overlayJournal !== undefined,
              }
            : null,
          battleActive: hdCleanup?.battleActive?.() ?? false,
          released: runtimeReleased || exitHandled,
        };
      },
      overlays: () => {
        const menus = canvas.parentElement?.querySelector<HTMLCanvasElement>('#hd-menus');
        return menus && menus.style.display !== 'none' ? [menus] : [];
      },
      frameVersion: () => presenter.frameVersion,
      requestRedraw: () => presenter.invalidate(),
    });
  activeToolbarCleanup?.();
  const toolbar = installRuntimeToolbar(
    {
      ...createVmPageToolbarActions({
        canvas,
        debugAutoOpen,
        presenter,
        effects,
        frameRenderer,
        getToolbar: () => toolbar,
        getVm: () => vm,
        getStatus: () => status,
        getExitHandled: () => exitHandled,
        getSelectedGameId: () => selectedGameId,
        getGameSource: () => gameSource,
        setRequestedClockRate: (rate) => {
          requestedClockRate = rate;
        },
        setRequestedResolution: (resolution) => {
          requestedResolution = resolution;
        },
        setRequestedVolume: (linear) => {
          requestedVolume = linear;
        },
        setPerformanceLine: (summary) => {
          performanceLine = summary;
        },
        onRestartForResolution: () => restartForResolution(),
        onNativeViewChange: async (choice) => {
          if (restartForNativeView) return restartForNativeView(choice);
          toolbar.setResolution(activeResolutionChoice);
          // A launch with a fixed --size never measured this page, so its launcher cannot restart at a new view.
          if (new URLSearchParams(window.location.search).get('native-viewport') === '1')
            throw new Error('游戏还在启动。请等主菜单出现后再切换视野。');
          throw new Error('本次启动指定了固定画面大小，不能在页面切换视野。请关闭游戏和启动器，再启动一次。');
        },
        onToggleHdView: () => toggleHdView(),
        onChangeGameSource: () => changeGameSource(),
        onSchedulePerformanceRender: () => schedulePerformanceRender(),
      }),
      onViewportRestart: () => restartForViewport(),
    },
    canvas,
    frameRenderer.backend,
    frameRenderer.detail,
  );
  const displayRefresh = startDisplayRefresh((sample) => {
    if (refreshNoticeShown || sample.refreshHz === null || sample.refreshHz >= 55) return;
    refreshNoticeShown = true;
    toolbar.setRefreshNotice(
      t('当前屏幕约 {0} Hz；可在 系统设置 → 显示器 → 刷新率 调整。', sample.refreshHz.toFixed(1)),
    );
    refreshNoticeTimer = window.setTimeout(() => toolbar.setRefreshNotice(''), 12000);
  });
  upscaleStatus.set(frameRenderer.upscaleStatus);
  toolbar.setUpscaleMode(frameRenderer.upscaleMode);
  activeToolbarCleanup = () => {
    toolbar.destroy();
    upscaleStatus.set(null);
  };

  let panelCreated = false;
  // The as assertion prevents TS narrowing a variable assigned only inside closures to null, then never after a null check.
  let gameTitle = 'Red Alert 2';
  let lastDebugUpdate = 0;
  const renderDebug = () => {
    if (!panelCreated || !debugVisible.getSnapshot() || performance.now() - lastDebugUpdate < 200) return;
    lastDebugUpdate = performance.now();
    debugState.set({
      title: gameTitle,
      phase: status.phase,
      calls: callCount,
      performance: performanceLine,
      detail: status.detail,
      hot: [...callHistogram.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6),
      trace: calls.join('\n'),
      getVm: () => vm,
    });
  };
  const ensureDebugPanel = () => {
    if (panelCreated) return;
    panelCreated = true;
    vm?.setCallTracing(true);
    lastDebugUpdate = 0;
  };
  const toggleShortcutHelp = () => helpVisible.set(!helpVisible.getSnapshot());

  if (activeKeyHandler) window.removeEventListener('keydown', activeKeyHandler);
  activeKeyHandler = (event) => {
    if (event.key === '`' && debugKeyEnabled) {
      event.preventDefault();
      ensureDebugPanel();
      debugVisible.set(!debugVisible.getSnapshot());
      return;
    }
    // Player shortcuts: ignore while input controls are focused and do nothing before VM startup.
    const target = event.target as HTMLElement | null;
    if (target?.closest('input, select, textarea, [contenteditable="true"]')) return;
    if (!vm) return;
    if (event.key === 'F11') {
      event.preventDefault();
      void toggleImmersiveFullscreen(canvas);
      return;
    }
    if (event.key === '[' || event.key === ']') {
      // Slower/faster clock multipliers: 1x -> 2x -> 4x with clamped endpoints; reserve number keys for native game hotkeys.
      const rates = [1, 2, 4];
      const index = rates.indexOf(requestedClockRate);
      const next = event.key === ']' ? rates[Math.min(index + 1, rates.length - 1)]! : rates[Math.max(index - 1, 0)]!;
      if (next !== requestedClockRate) toolbar.pressClockRate(next);
      event.preventDefault();
      return;
    }
    if (event.key === HD_VIEW_KEY && hdCleanup) {
      if (event.repeat) {
        event.preventDefault();
        return;
      }
      event.preventDefault();
      toggleHdView();
      return;
    }
    if (event.key === '?') {
      event.preventDefault();
      toggleShortcutHelp();
    }
  };
  window.addEventListener('keydown', activeKeyHandler);
  // Without the debug shortcut the backquote key is an ordinary key of the game again.
  setSessionShortcutKey('`', debugKeyEnabled);
  if (debugAutoOpen) {
    // ?debug=1 is explicit: open even in production or on touch devices; backtick still toggles it.
    ensureDebugPanel();
    debugVisible.set(true);
  } else {
    // Without ?debug=1, keep the panel and collection inactive, with no overhead or obstruction of the game.
    debugVisible.set(false);
  }

  schedulePerformanceRender = scheduleRender;

  const refreshPointerProbe = () => {
    if (!debugAutoOpen || !vm) return;
    const seq = ++pointerProbeSeq;
    void vm.getPointerState().then(
      (state) => {
        if (seq !== pointerProbeSeq || !state) return;
        canvas.dataset.vmWorkerCursor = `${state.x},${state.y}/${state.width}x${state.height}`;
        canvas.dataset.vmWorkerClient = `${state.clientWidth}x${state.clientHeight}`;
        canvas.dataset.vmWorkerKey = `0x${state.lastKeyMessage.toString(16)}:${state.lastKeyVirtualKey}`;
        canvas.dataset.vmWorkerMouse =
          `0x${state.lastMouseMessage.toString(16)}:0x${state.lastMouseHwnd.toString(16)}:` +
          `${state.lastMouseControlId}:0x${state.lastMouseCallback.toString(16)}`;
        canvas.dataset.vmWorkerDispatch =
          `0x${state.lastMouseDispatchHwnd.toString(16)}:${state.lastMouseDispatchControlId}:` +
          `0x${state.lastMouseDispatchCallback.toString(16)}`;
        canvas.dataset.vmCampaignHoverDispatches = `${state.campaignHoverDispatches}`;
      },
      () => {
        /* Debug-probe failures must not affect input. */
      },
    );
  };

  const presentHostCursor = (x: number, y: number, visible: boolean) => {
    nativeCursor?.position(x, y, visible);
    if (!nativeCursor && vm?.runtimeInfo.backend === 'native' && presenter.frame?.cursor) visible = true;
    if (debugAutoOpen) {
      canvas.dataset.vmCursor = `${x},${y}/${gameFrameWidth}x${gameFrameHeight}`;
      const now = performance.now();
      if (vm && now - lastPointerProbeAt >= 100) {
        lastPointerProbeAt = now;
        refreshPointerProbe();
      }
    }
    presenter.presentCursor(x, y, visible);
  };

  const nativeCursorFrames = createNativeCursorFrames({
    screen: canvas,
    pageCursor: () => nativeCursor,
    presentCursor: (x, y, visible) => presenter.presentCursor(x, y, visible),
    isReleased: () => runtimeReleased,
  });
  activeRendererCleanup = () => {
    window.clearInterval(resizeTimer);
    window.clearTimeout(refreshNoticeTimer);
    displayRefresh.dispose();
    speedCleanup?.();
    speedCleanup = null;
    feelTelemetry?.dispose();
    feelTelemetry = null;
    menuAbort.abort();
    hdMenus?.dispose();
    hdMenus = null;
    nativeCursorFrames.dispose();
    nativeCursor?.destroy();
    nativeCursor = null;
    ambientFill?.destroy();
    ambientFill = null;
    effects.stop();
    presenter.destroy();
  };
  presenter.render();
  // Restore and start directly from the last persisted complete import without showing the picker;
  // missing/incomplete caches, such as quota-reduced sets, return to the picker.
  if (trainingQuery && trainingQuery.lesson === null) {
    // Practice mode without a lesson: show the lesson list and start nothing.
    const lessons = (await supportedGame(trainingQuery.game).loadTrainingLessons?.()) ?? [];
    if (generation !== pageGeneration) return;
    trainingPanel.set({
      mode: 'menu',
      lessons: lessons.map((lesson) => ({
        id: lesson.id,
        title: lesson.title,
        summary: lesson.summary,
        href: trainingHref(window.location.href, lesson.id, lesson.scenario),
      })),
    });
    return;
  }
  // A practice lesson always plays its own scenario from the development files, never a cached import.
  const cachedSource =
    trainingQuery || nativeAutoStart(window.location.search) ? null : await restoreCachedGameSource().catch(() => null);
  if (generation !== pageGeneration) return;
  gameSource = resumedSource ?? cachedSource ?? (await selectGameFiles());
  if (generation !== pageGeneration) {
    progressiveFilesOf(gameSource.files)?.cancel();
    return;
  }
  activeResourceCleanup?.();
  const progressive = progressiveFilesOf(gameSource.files);
  if (progressive) {
    const indicator = resourceStatus;
    const unsubscribe = progressive.subscribe((status) =>
      indicator.set({
        phase: status.phase,
        text:
          status.phase === 'loading'
            ? t('启动层已就绪 · 其他资源 {0}/{1}：{2}', status.loaded, status.total, status.detail)
            : status.detail,
      }),
    );
    activeResourceCleanup = () => {
      unsubscribe();
      indicator.set(null);
      progressive.cancel();
    };
  } else activeResourceCleanup = null;
  // Base-game caches and add-ons are independent; development HTTP and restored caches share the same startup mount path.
  gameSource.additionalFiles = await loadCustomMapFiles(gameSource.game.id).catch((error) => {
    console.warn(t('[自定义地图] 无法读取已保存的附加包'), error);
    return new Map<string, Uint8Array>();
  });
  if (generation !== pageGeneration) return;
  gameTitle = gameSource.game.executable;
  activeNetworkCleanup?.();
  const networkIndicator = networkStatus;
  activeNetworkCleanup = () => networkIndicator.set(null);
  selectedGameId = gameSource.game.id;
  hotkeySheetVisible.set(false);
  hotkeySheet.set(null);
  gameFocus.set(() => canvas.focus({ preventScroll: true }));
  void gameSource.game.loadHotkeySheet?.().then((sheet) => {
    if (generation === pageGeneration) hotkeySheet.set(sheet);
  });
  // ?resolution= (a size, `display` or `ini`) wins for this page load; otherwise the stored toolbar choice. Without
  // either, the HD bridge uses Moderate framing (2.5 device pixels per game pixel). A view named in the address is an
  // explicit launcher choice and is remembered; launchers pass one only when the player asked for it.
  const urlChoice = parseResolutionChoice(new URLSearchParams(window.location.search).get('resolution'), true);
  if (urlChoice === 'classic' || urlChoice === 'moderate' || urlChoice === 'wide')
    storeResolutionChoice(selectedGameId, urlChoice);
  const storedChoice = urlChoice === undefined ? loadStoredResolutionChoice(selectedGameId) : urlChoice;
  activeResolutionChoice = storedChoice === undefined ? (hdBridgeRequested ? DEFAULT_VIEW_CHOICE : null) : storedChoice;
  requestedResolution = resolveResolutionChoice(
    activeResolutionChoice,
    canvas.closest('#stage'),
    window.devicePixelRatio || 1,
  );
  activeDisplayScale = resolveResolutionViewScale(
    activeResolutionChoice,
    canvas.closest('#stage'),
    window.devicePixelRatio || 1,
    requestedResolution,
  );
  toolbar.setResolution(activeResolutionChoice);
  refitActiveCanvas();
  toolbar.setGameTitle(gameSource.game.title);
  mainPanel.set(null);

  bootState.set({
    game: gameSource.game,
    status: { phase: 'loading', detail: t('初始化…') },
    cancel: async () => {
      if (exitHandled) return;
      exitHandled = true;
      await releaseRuntime();
      mainPanel.set({ phase: 'exited', detail: t('启动已取消') });
    },
  });
  const hideBootOverlay = () => bootState.set(null);
  const leaveGameFullscreen = async () => {
    // Runtime panels are siblings of the game frame. A fullscreen frame's top
    // layer otherwise hides them even when their DOM boxes remain visible.
    if (document.fullscreenElement?.contains(canvas))
      await document.exitFullscreen().catch((error) => console.warn('[VM] Fullscreen release:', error));
  };
  let problemPanelShown = false;
  const showProblemPanel = (phase: 'blocked' | 'error', detail: string) => {
    if (problemPanelShown) return;
    problemPanelShown = true;
    hideBootOverlay();
    void leaveGameFullscreen().then(() => mainPanel.set({ phase, detail }));
  };
  const updateBootOverlay = (next: VmStatus) => {
    if (next.phase === 'blocked' || next.phase === 'error') showProblemPanel(next.phase, next.detail);
    else if (next.phase === 'exited' || next.phase === 'stopped') hideBootOverlay();
    else {
      const boot = bootState.getSnapshot();
      if (boot) bootState.set({ ...boot, status: next });
    }
  };

  const releaseRuntime = async (preserveFullscreen = false) => {
    runtimeReleased = true;
    ambientFill?.update();
    runtimeNotice.set(null);
    menuAbort.abort();
    window.clearInterval(resizeTimer);
    window.clearTimeout(refreshNoticeTimer);
    displayRefresh.dispose();
    activeNativeViewportAbort?.abort();
    activeNativeViewportAbort = null;
    nativeCursorFrames.dispose();
    nativeCursor?.destroy();
    nativeCursor = null;
    // Stop the HD bridge while the VM still runs: it switches the game's passthrough off and must not keep polling (and
    // holding its GPU view) after the VM is gone.
    activeTrainingCleanup?.();
    hdMenus?.dispose();
    hdMenus = null;
    hdCleanup?.();
    if (activeHdCleanup === hdCleanup) activeHdCleanup = null;
    hdCleanup = null;
    toolbar.setHdView(null);
    toolbar.setHdQuality(null);
    toolbar.setStalls(0, 0);
    speedCleanup?.();
    speedCleanup = null;
    feelTelemetry?.dispose();
    feelTelemetry = null;
    toolbar.setGameSpeed(null);
    setSessionShortcutKey(HD_VIEW_KEY, false);
    effects.stop();
    activeNetworkCleanup?.();
    activeNetworkCleanup = null;
    activeResourceCleanup?.();
    activeResourceCleanup = null;
    if (document.pointerLockElement === canvas) await document.exitPointerLock();
    if (!preserveFullscreen) await leaveGameFullscreen();
    bootState.set(null);
    helpVisible.set(false);
    hotkeySheetVisible.set(false);
    hotkeySheet.set(null);
    gameFocus.set(null);
    activeInputCleanup?.();
    activeInputCleanup = null;
    if (activeKeyHandler) window.removeEventListener('keydown', activeKeyHandler);
    activeKeyHandler = null;
    debugVisible.set(false);
    if (activeVm === vm) activeVm = null;
    debugState.set(null);
    await pageController.destroy();
    if (preserveFullscreen) frameRenderer.destroy(true);
    presenter.destroy();
    activeToolbarCleanup?.();
    activeToolbarCleanup = null;
  };

  restartForResolution = async () => {
    if (exitHandled) return;
    exitHandled = true;
    await releaseRuntime();
    window.location.reload();
  };

  const finishExitedRuntime = async (detail: string) => {
    if (exitHandled) return;
    exitHandled = true;
    await releaseRuntime();
    mainPanel.set({ phase: 'exited', detail });
  };

  changeGameSource = async () => {
    if (exitHandled) return;
    exitHandled = true;
    await releaseRuntime();
    await forgetGameDirectory();
    // Clear persisted file sets so switching sources returns to the picker rather than restoring automatically again.
    await clearCachedGameFiles().catch(() => {});
    window.location.reload();
  };

  const installRuntimeInput = (startedVm: VmShell) => {
    if (activeInputCleanup) activeInputCleanup();
    // Overlay RA2's Win32 hardware cursor as a small independent framebuffer texture; it remains visible after Pointer Lock
    // hides the system cursor and moves without retransmitting the whole frame. At screen edges, clamp the logical
    // cursor to current guest-frame bounds for sustained edge scrolling; ?mouse-lock=0 restores absolute coordinates.
    // Both backends receive the same confined logical coordinates. Absolute
    // input is an explicit accessibility/development choice, never a native default.
    const lockDesktopMouse = desktopPointerLock(window.location.search, startedVm.runtimeInfo.backend);
    const buildStrip = gameSource.game.buildStripWidth;
    const installedInput = installGameInput(
      canvas,
      startedVm,
      lockDesktopMouse,
      presentHostCursor,
      () => ({ width: gameFrameWidth, height: gameFrameHeight }),
      {
        metaAsControl,
        pageOwnsCursor: nativeCursor !== null,
        lockPointerOnDown: () =>
          startedVm.runtimeInfo.backend === 'native' || (!pointerMenuActive && (hdCleanup?.battleActive?.() ?? false)),
        canLockPointer: () =>
          startedVm.runtimeInfo.backend !== 'native' ||
          (!pointerMenuActive && ((hdCleanup?.battleActive?.() ?? false) || softwarePointerActive)),
        ...(buildStrip === undefined ? {} : { shiftClickRepeat: (x, _y, frame) => x >= frame.width - buildStrip }),
        observe: (observation) => inputObserver?.(observation),
      },
    );
    const pointerProbeTimer = debugAutoOpen ? window.setInterval(refreshPointerProbe, 250) : null;
    adaptInputResolution = installedInput.adaptResolution;
    inputPointerPosition = installedInput.pointerPosition;
    releaseInputPointerLock = installedInput.releasePointerLock;
    const cleanupTouch = installAdaptiveTouchControls(canvas, startedVm);
    const cleanupWake = installWakeLock();
    activeInputCleanup = () => {
      adaptInputResolution = null;
      inputPointerPosition = null;
      releaseInputPointerLock = null;
      installedInput.cleanup();
      if (pointerProbeTimer !== null) window.clearInterval(pointerProbeTimer);
      cleanupTouch();
      cleanupWake();
    };
  };

  if (
    import.meta.env.DEV &&
    (new URLSearchParams(window.location.search).get('backend') === 'native' ||
      (hdBridgeEnabled && gameSource?.game.id === 'yr')) &&
    new URLSearchParams(window.location.search).get('native-cursor') !== 'game'
  ) {
    try {
      const { createNativeCursor } = await import('./nativeCursor');
      nativeCursor = await createNativeCursor(canvas, undefined, () => feelTelemetry?.pointerDrawn());
    } catch (error) {
      console.warn('[native] Cursor art unavailable; retaining game cursor', error);
    }
    if (generation !== pageGeneration || runtimeReleased) {
      nativeCursor?.destroy();
      return;
    }
  }
  const viewportAbort = new AbortController();
  activeNativeViewportAbort = viewportAbort;
  let nativeViewport: GameResolution | null;
  const showStart = (start: ((fullscreen?: boolean) => void) | null) => {
    const boot = bootState.getSnapshot();
    if (boot)
      bootState.set({
        ...boot,
        start: start ?? undefined,
        status: {
          phase: 'loading',
          detail: start ? '全屏开始会让游戏画面匹配整个屏幕，也可以按当前窗口大小开始。' : '正在启动游戏…',
        },
      });
  };
  try {
    const webViewport = await prepareWebPlayViewport(canvas, viewportAbort.signal, showStart);
    if (webViewport) {
      nativeArea = webViewport;
      requestedResolution = resolveResolutionChoice(
        activeResolutionChoice,
        canvas.closest('#stage'),
        webViewport.dpr,
        webViewport,
      );
      activeDisplayScale = resolveResolutionViewScale(
        activeResolutionChoice,
        canvas.closest('#stage'),
        webViewport.dpr,
        requestedResolution,
        webViewport,
      );
      toolbar.setResolution(activeResolutionChoice);
      refitActiveCanvas();
    }
    nativeViewport = await prepareNativeViewport(
      canvas,
      viewportAbort.signal,
      (waiting) => {
        updateBootOverlay({ phase: 'loading', detail: waiting ? '正在进入全屏并匹配画面…' : t('初始化…') });
      },
      resolutionViewScale(activeResolutionChoice) ?? 2,
      typeof activeResolutionChoice === 'object' ? activeResolutionChoice : null,
      activeResolutionChoice === null,
      (area) => {
        nativeArea = area;
      },
      showStart,
    );
  } catch (error) {
    if (viewportAbort.signal.aborted || generation !== pageGeneration) return;
    showProblemPanel('error', error instanceof Error ? error.message : String(error));
    await releaseRuntime();
    return;
  } finally {
    if (activeNativeViewportAbort === viewportAbort) activeNativeViewportAbort = null;
  }
  if (generation !== pageGeneration || runtimeReleased) return;
  if (!nativeArea && (nativeAutoStart(window.location.search) || resolutionViewScale(activeResolutionChoice) !== null))
    nativeArea = readArea();
  if (nativeViewport) {
    requestedResolution = nativeViewport;
    activeDisplayScale = resolveResolutionViewScale(
      activeResolutionChoice,
      canvas.closest('#stage'),
      nativeArea?.dpr ?? (window.devicePixelRatio || 1),
      requestedResolution,
      nativeArea ?? undefined,
    );
    toolbar.setResolution(activeResolutionChoice);
    refitActiveCanvas();
  }
  vm = await startSessionRuntime(
    () =>
      pageController.start(({ isCurrent }) =>
        createVmShell(
          guardVmCallbacks(
            createVmRuntimeCallbacks({
              canvas,
              debugAutoOpen,
              toolbar,
              presenter,
              effects,
              getVm: () => vm,
              getSelectedGameId: () => selectedGameId,
              setStatus: (next) => {
                status = next;
              },
              getCallCount: () => callCount,
              setCallCount: (next) => {
                callCount = next;
              },
              getPanelCreated: () => panelCreated,
              callHistogram,
              calls,
              getGameFrameSize: () => ({ width: gameFrameWidth, height: gameFrameHeight }),
              setGameFrameSize: (width, height) => {
                gameFrameWidth = width;
                gameFrameHeight = height;
              },
              getAdaptInputResolution: () => adaptInputResolution,
              getRefitActiveCanvas: () => refitActiveCanvas,
              onUpdateBootOverlay: updateBootOverlay,
              onScheduleRender: scheduleRender,
              onHideBootOverlay: hideBootOverlay,
              onFinishExited: finishExitedRuntime,
              onExposeRuntimeCallProbe: exposeRuntimeCallProbe,
              onAppendCall: appendCall,
              onCursorFrame: (frame) => {
                if ('pointer' in frame && frame.pointer !== undefined) {
                  // Hidden software art is not proof of a menu. Confirm modal
                  // ownership before releasing confinement, including in-game
                  // options; transient hide/read misses keep a combat drag held.
                  if (softwarePointerActive && frame.pointer === null) pointerMenuPending = true;
                  if (frame.pointer !== null) {
                    pointerMenuPending = false;
                    pointerMenuActive = false;
                  }
                  softwarePointerActive = frame.pointer !== null;
                  if (
                    pointerMenuPending &&
                    !pointerMenuCheck &&
                    performance.now() - pointerMenuCheckedAt >= 100 &&
                    vm?.getMenuSnapshot
                  ) {
                    pointerMenuCheckedAt = performance.now();
                    pointerMenuCheck = vm
                      .getMenuSnapshot()
                      .then((menu) => {
                        if (!runtimeReleased && pointerMenuPending && menu?.complete && menu.dialogHwnd) {
                          pointerMenuPending = false;
                          pointerMenuActive = true;
                          releaseInputPointerLock?.();
                        }
                      })
                      .catch(() => undefined)
                      .finally(() => {
                        pointerMenuCheck = null;
                      });
                  }
                }
                hdCleanup?.frame(frame);
                nativeCursorFrames.onFrame(frame);
              },
            }),
            isCurrent,
          ),
          gameSource!,
          {
            resolution: requestedResolution,
            // ?game-speed=0..6 (original scale, 3 = normal): this session's startup speed; absent = the game's default.
            ...(sessionGameSpeed !== undefined ? { gameSpeed: sessionGameSpeed } : {}),
            startupPage: new URLSearchParams(window.location.search).get('start-page') || undefined,
            // The HD bridge switches the game's native overlay passthrough; normal play installs no patches.
            renderPassthrough: hdBridgeEnabled,
            recycleFrames: true,
            nativePageCursor: nativeCursor !== null,
          },
        ),
      ),
    (error, detail) => {
      console.error(t('[VM] 启动失败'), error);
      if (!problemPanelShown) showProblemPanel('error', detail);
    },
    releaseRuntime,
    installRuntimeInput,
  );
  if (!vm) {
    if (!problemPanelShown) presenter.destroy();
    return;
  }
  // Resizing only scales the picture. Re-negotiate the game's video mode on
  // the player's explicit menu action; pause/options dialogs never allow it.
  // A measured native session can also apply a new toolbar choice the same way.
  const nativeRestartable =
    vm.runtimeInfo.backend === 'native' && new URLSearchParams(window.location.search).get('native-viewport') === '1';
  const restartFollowsWindow = resolutionViewScale(activeResolutionChoice) !== null;
  const initialArea = nativeArea ?? readArea();
  let menuCheckPending = false;
  const canRestartInMenu = async () => {
    if (!vm || runtimeReleased || resizeBusy || generation !== pageGeneration) return false;
    // Incomplete archive providers are cancelled on release; keep their current session until extraction finishes.
    const resources = progressiveFilesOf(gameSource!.files);
    if (resources && resources.status().phase !== 'complete') return false;
    const currentVm = vm;
    const menu = await currentVm.getMenuSnapshot?.();
    if (!menu || vm !== currentVm || runtimeReleased || resizeBusy || generation !== pageGeneration) return false;
    return (
      identifyYrHdMenu(menu) === 'main' ||
      (vm.runtimeInfo.backend === 'native' &&
        requestedResolution !== null &&
        (requestedResolution.width > 800 || requestedResolution.height > 600) &&
        menu.width === 800 &&
        menu.height === 600 &&
        gameFrameWidth === 800 &&
        gameFrameHeight === 600)
    );
  };
  /**
   * Restart the owned game from an out-of-match menu. Without `nextChoice` this follows a changed window and does
   * nothing while the area is unchanged. With it (a toolbar choice) the area this session was matched to is restarted
   * at the new choice: the toolbar is outside the fullscreen element, so the player leaves fullscreen to reach it and
   * the current window must not replace the fullscreen measurement (the resize restart remains for real changes).
   * The choice is remembered once the menu allows the restart; a refusal keeps the current choice.
   */
  const restartInMenu = async (nextChoice?: ResolutionChoice) => {
    const viewChange = nextChoice !== undefined;
    if (!viewChange && JSON.stringify(initialArea) === JSON.stringify(readArea())) return;
    const menuAvailable = await canRestartInMenu().catch((error) => {
      console.warn('[viewport] Menu state unavailable:', error);
      return false;
    });
    if (!menuAvailable || resizeBusy || runtimeReleased || generation !== pageGeneration) {
      if (!viewChange) return;
      toolbar.setResolution(activeResolutionChoice);
      throw new Error('对局中不能切换视野。请回到游戏主菜单后再选，约 20 秒后会按新视野重开菜单。');
    }
    resizeBusy = true;
    toolbar.setViewportRestart(false);
    try {
      const native = vm!.runtimeInfo.backend === 'native';
      const nextArea = viewChange ? initialArea : readArea();
      if (viewChange) {
        storeResolutionChoice(selectedGameId!, nextChoice);
        activeResolutionChoice = nextChoice;
        // The restarted page re-reads the choice; a ?resolution= from the launch would override it. A refused
        // change above keeps the address, so a reload still matches the running game.
        const url = new URL(window.location.href);
        if (url.searchParams.has('resolution')) {
          url.searchParams.delete('resolution');
          window.history.replaceState(window.history.state, '', url);
        }
      }
      // Reuse the validated source and canvas context. Reloading loses unpersisted directory/HTTP selections.
      await releaseRuntime(true);
      if (generation !== pageGeneration) return;
      bootState.set({
        game: gameSource!.game,
        status: {
          phase: 'loading',
          detail: viewChange ? '正在按新视野重新启动游戏，约 20 秒…' : '正在按现在的窗口大小重新启动游戏，约 20 秒…',
        },
        cancel: async () => {
          viewportAbort.abort();
          stopVmPage();
          mainPanel.set({ phase: 'exited', detail: '调整已停止。请重新打开本次启动器的页面。' });
        },
      });
      if (native) {
        const query = new URLSearchParams(window.location.search);
        const response = await fetch(new URL('/__native/viewport', window.location.href), {
          method: 'POST',
          headers: { Authorization: `Bearer ${query.get('agent-token')}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ...nextArea,
            ...nativeViewportChoice(activeResolutionChoice),
            restart: true,
          }),
          signal: AbortSignal.any([viewportAbort.signal, AbortSignal.timeout(5000)]),
        });
        if (!response.ok) throw new Error('无法按新的画面设置重开菜单。请重新启动启动器。');
      }
      if (!viewportAbort.signal.aborted && generation === pageGeneration) {
        await startVmPage(canvas, gameSource!);
      }
    } catch (error) {
      if (!viewportAbort.signal.aborted && generation === pageGeneration) {
        bootState.set(null);
        mainPanel.set({ phase: 'error', detail: error instanceof Error ? error.message : String(error) });
      }
    } finally {
      resizeBusy = false;
    }
  };
  if (restartFollowsWindow) restartForViewport = () => restartInMenu();
  if (nativeRestartable) restartForNativeView = (choice) => restartInMenu(choice);
  // Fixed-size and INI sessions have no window match to go stale; only view choices offer the resize restart.
  if (restartFollowsWindow) {
    resizeTimer = window.setInterval(() => {
      // Menu availability is asynchronous. Keep the one-time battle hint tied
      // to an observed battle, not the initial false value of that menu check.
      toolbar.setViewportBattle(hdCleanup?.battleActive?.() ?? false);
      const changed = JSON.stringify(initialArea) !== JSON.stringify(readArea());
      if (!changed || runtimeReleased || resizeBusy) {
        toolbar.setViewportRestart(false);
        return;
      }
      if (menuCheckPending) return;
      menuCheckPending = true;
      void canRestartInMenu()
        .then((available) => {
          if (!runtimeReleased && generation === pageGeneration) {
            toolbar.setViewportRestart(available && JSON.stringify(initialArea) !== JSON.stringify(readArea()));
          }
        })
        .catch((error) => console.warn('[viewport] Menu state unavailable:', error))
        .finally(() => {
          menuCheckPending = false;
        });
    }, 500);
  }
  if (panelCreated) vm.setCallTracing(true);
  vm.setGameClockRate(requestedClockRate);
  vm.setMasterVolume(requestedVolume);
  activeVm = vm;
  toolbar.setMapsAvailable(status.phase === 'running');
  if (trainingQuery?.lesson) {
    const trainingVm = vm;
    const lessonId = trainingQuery.lesson;
    void Promise.all([import('./training/trainingSession'), gameSource.game.loadTrainingLessons?.() ?? []])
      .then(([{ startTrainingSession }, lessons]) => {
        if (generation !== pageGeneration || runtimeReleased) return;
        const index = lessons.findIndex((lesson) => lesson.id === lessonId);
        const lesson = lessons[index];
        if (!lesson) {
          console.warn('[train] unknown lesson', lessonId);
          return;
        }
        const next = lessons[index + 1];
        let finished = false;
        activeTrainingCleanup?.();
        const session = startTrainingSession({
          lesson,
          getCommandState: () => trainingVm.getCommandState(),
          publish: (view) => {
            trainingPanel.set({
              mode: 'lesson',
              view,
              restartHref: trainingHref(window.location.href, lesson.id, lesson.scenario),
              nextHref: next ? trainingHref(window.location.href, next.id, next.scenario) : null,
              menuHref: trainingHref(window.location.href, null),
              note: null,
            });
            if (view.phase === 'done' && !finished) {
              finished = true;
              // The summary's links need the mouse: hand the pointer back once the last task is done.
              if (document.pointerLockElement === canvas) document.exitPointerLock();
            }
          },
        });
        inputObserver = session.observe;
        activeTrainingCleanup = () => {
          session.stop();
          inputObserver = null;
          trainingPanel.set(null);
          activeTrainingCleanup = null;
        };
      })
      .catch((error) => console.warn('[train] lesson failed to start', error));
  }
  // Game-speed telemetry: like the stall recorder, behind DEV so that neither the module nor a request to the log
  // route exists in a production build. It runs with or without the HD bridge.
  if (import.meta.env.DEV) {
    const telemetryVm = vm;
    void Promise.all([import('./speedTelemetry'), import('./sessionFeelTelemetry')])
      .then(([{ startSpeedTelemetry }, { startSessionFeelTelemetry }]) => {
        if (generation !== pageGeneration || runtimeReleased) return;
        feelTelemetry = startSessionFeelTelemetry({
          screen: canvas,
          display: () => displayRefresh.snapshot(),
          backend: telemetryVm.runtimeInfo?.backend === 'native' ? 'native' : 'v86',
          scene: () => hdCleanup?.scene() ?? null,
          activity: () => hdCleanup?.activity?.() ?? null,
        });
        const telemetry = startSpeedTelemetry({
          diagnostics: () => telemetryVm.getDiagnostics('usage'),
          presentedFrames: () => presentedFrames,
          frameSize: () => (presenter.frame ? { width: presenter.frame.width, height: presenter.frame.height } : null),
          scene: () => hdCleanup?.scene() ?? null,
          publish: (actual, target) => toolbar.setGameSpeed(actual, target),
          observe: (record, diagnostics) => feelTelemetry?.speed(record, diagnostics.native),
        });
        const globals = window as unknown as {
          __speedTelemetry?: { readonly records: unknown[] };
          __feelTelemetry?: { readonly records: unknown[]; flush(): void };
        };
        const feelHandle = {
          get records() {
            return feelTelemetry?.records() ?? [];
          },
          flush: () => feelTelemetry?.flush(),
        };
        globals.__feelTelemetry = feelHandle;
        const handle = {
          get records() {
            return telemetry.records();
          },
        };
        globals.__speedTelemetry = handle;
        speedCleanup = () => {
          telemetry.dispose();
          if (globals.__speedTelemetry === handle) delete globals.__speedTelemetry;
          if (globals.__feelTelemetry === feelHandle) delete globals.__feelTelemetry;
        };
      })
      .catch((error) => console.warn('[speed] telemetry unavailable', error));
  }
  if (hdBridgeEnabled) {
    const bridgeVm = vm;
    if (selectedGameId === 'yr' && new URLSearchParams(window.location.search).get('hd-menus') !== '0') {
      void import('./hdMenus')
        .then(async ({ startHdMenus }) => {
          if (generation !== pageGeneration || runtimeReleased) return;
          const menus = await startHdMenus({
            screen: canvas,
            vm: bridgeVm,
            side: () => hdCleanup?.menuSide?.() ?? null,
            pageCursorAvailable: () => nativeCursor !== null,
            battleActive: () => hdCleanup?.battleActive?.() ?? false,
            signal: menuAbort.signal,
            pictureGeneration: () => presenter.displayedFrame?.menuGeneration,
            onFramePresented: (listener) => {
              menuFrameListeners.add(listener);
              return () => menuFrameListeners.delete(listener);
            },
            pointerPosition: () => inputPointerPosition?.() ?? null,
            frameSize: () =>
              presenter.frame ? { width: presenter.frame.width, height: presenter.frame.height } : null,
          });
          if (generation !== pageGeneration || runtimeReleased) menus?.dispose();
          else {
            hdMenus = menus;
            hdMenus?.setEnabled(hdViewEnabled);
          }
        })
        .catch((error) => console.warn('[HD] Menu art unavailable; retaining original menus', error));
    }
    void import('./hdBridge')
      .then(({ startHdBridge }) => {
        // The session may have been replaced, or released (game exit, boot cancel), while the module loaded.
        if (generation !== pageGeneration || runtimeReleased) return;
        activeHdCleanup?.();
        hdCleanup = activeHdCleanup = startHdBridge({
          vm: bridgeVm,
          screen: canvas,
          displayRefreshMs: () => displayRefresh.snapshot().refreshMs,
          frameRenderer,
          invalidate: () => presenter.invalidate(),
          frameSize: () => (presenter.frame ? { width: presenter.frame.width, height: presenter.frame.height } : null),
          pointerPosition: () => inputPointerPosition?.() ?? null,
          pageCursor: () => (nativeCursor !== null ? true : vm?.runtimeInfo.backend === 'native' ? false : undefined),
          publishStatus: (text) => hdStatus.set(text),
          publishQuality: (tier, tiers) => toolbar.setHdQuality(tier, tiers),
          publishStalls: (count, longestMs) => toolbar.setStalls(count, longestMs),
          presented: (frame) => feelTelemetry?.frame('hd', frame),
          stateReceived: (frame) => feelTelemetry?.stateReceived(frame),
        });
        // Only a running bridge has a view to switch: the button appears and the key stops reaching the game.
        toolbar.setHdView(true);
        setSessionShortcutKey(HD_VIEW_KEY, true);
      })
      .catch((error) => console.warn('[HD] bridge failed to start', error));
  }
  // Overlay RA2's Win32 hardware cursor as a small independent framebuffer texture; it remains visible after Pointer Lock
  // hides the system cursor and moves without retransmitting the whole frame. At screen edges, clamp the logical
  // cursor to current guest-frame bounds for sustained edge scrolling; ?mouse-lock=0 restores absolute coordinates.
  try {
    const debugRoute = readDebugRoute();
    if (debugRoute.length) {
      void playDebugRoute(vm, debugRoute, () => presenter.frame !== null).catch((error) =>
        console.warn(t('[VM] URL debug 路线失败'), error),
      );
    }
  } catch (error) {
    // Runtime already rendered a readable error through onStatus; prevent an unhandled rejection from the dynamic entry point here.
    console.error(t('[VM] 启动失败'), error);
  }
}

function readDebugRoute(): Array<[number, number]> {
  const clicks = new URLSearchParams(window.location.search).get('clicks') ?? '';
  return clicks
    .split(';')
    .filter(Boolean)
    .map((part) => {
      const [x, y] = part.split(',').map(Number);
      if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error(t('无效 debug 路线坐标：{0}', part));
      return [Math.max(0, Math.min(gameFrameWidth - 1, x | 0)), Math.max(0, Math.min(gameFrameHeight - 1, y | 0))];
    });
}

async function playDebugRoute(vm: VmShell, route: Array<[number, number]>, hasFrame: () => boolean): Promise<void> {
  await waitForDebugRouteReady(hasFrame);
  for (const [x, y] of route) {
    await new Promise<void>((resolve) => window.setTimeout(resolve, 600));
    const lParam = (y << 16) | x;
    vm.setCursorPosition(x, y);
    vm.postMessage(0x0200, 0, lParam);
    vm.setKeyState(1, true);
    vm.postMessage(0x0201, 1, lParam);
    vm.setKeyState(1, false);
    vm.postMessage(0x0202, 0, lParam);
  }
}

async function waitForDebugRouteReady(hasFrame: () => boolean): Promise<void> {
  const deadline = performance.now() + 30_000;
  let stableFrames = 0;
  while (performance.now() < deadline) {
    const shellPage = (document.getElementById('screen') as HTMLCanvasElement | null)?.dataset.shellPage ?? '';
    const shellReady = shellPage.toLowerCase().includes('mainmenu');
    if (hasFrame() && shellReady) {
      stableFrames++;
      if (stableFrames >= 3) return;
    } else {
      stableFrames = 0;
    }
    await new Promise<void>((resolve) => window.setTimeout(resolve, 100));
  }
  throw new Error(t('主菜单尚未就绪，未发送快速进入路线'));
}

/** React unmount and HMR share service destruction; the service layer no longer removes UI nodes. */
export function stopVmPage(): void {
  activeNativeViewportAbort?.abort();
  activeNativeViewportAbort = null;
  ++pageGeneration;
  cancelSourceRequest();
  mapRequest.getSnapshot()?.finish(false);
  activeNetworkCleanup?.();
  activeNetworkCleanup = null;
  activeResourceCleanup?.();
  activeResourceCleanup = null;
  activeVm = null;
  if (activeKeyHandler) window.removeEventListener('keydown', activeKeyHandler);
  activeKeyHandler = null;
  activeInputCleanup?.();
  activeInputCleanup = null;
  activeToolbarCleanup?.();
  activeToolbarCleanup = null;
  activeTrainingCleanup?.();
  activeHdCleanup?.();
  activeHdCleanup = null;
  activeRendererCleanup?.();
  activeRendererCleanup = null;
  activeFitCleanup?.();
  activeFitCleanup = null;
  canvasFitInstalled = false;
  bootState.set(null);
  debugState.set(null);
  debugVisible.set(false);
  helpVisible.set(false);
  hotkeySheetVisible.set(false);
  hotkeySheet.set(null);
  gameFocus.set(null);
  gameRunning.set(false);
  movieSkip.set(null);
  void pageController.destroy();
}
if (import.meta.hot) import.meta.hot.dispose(stopVmPage);

function appendCall(lines: string[], call: Win32Call, ordinal: number, suffix = ''): void {
  const args = call.args.map((v) => `0x${v.toString(16)}`).join(', ');
  lines.push(`${String(ordinal).padStart(3, '0')}  ${call.imported.key}(${args}) ${suffix}`.trimEnd());
  if (lines.length > 36) lines.splice(0, lines.length - 36);
}
