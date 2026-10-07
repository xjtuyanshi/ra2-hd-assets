import { t } from '../../shared/i18n/translate';
import type { ReShadeMode } from '../../../graphics/reshadePreset';
import { toolbarState } from './state/uiState';
import type { ToolbarModel } from './components/RuntimeToolbarView';
import type { UpscaleMode } from './vmFrameRenderer';
import type { ProbeImage } from './experiments/modelProbe';
import type { CheatGuideGameId } from './cheatGuides';
import type { GameResolution } from '../../../games/resolution';
import { displayMatchIsStale, resolutionChoiceValue, type ResolutionChoice } from './vmPageResolution';

export interface RuntimeToolbar {
  getPerformanceSettings(): Pick<ToolbarModel, 'rate' | 'resolution' | 'upscaleMode' | 'reshadeMode'>;
  setRendererDetail(detail: string): void;
  setGameTitle(title: string): void;
  recordCall(count?: number): void;
  recordLogicFrame(count?: number): void;
  recordPresentedFrame(): void;
  setCheatGame(game: CheatGuideGameId | null): void;
  setResolution(choice: ResolutionChoice): void;
  /**
   * The fitted frame size, how many device pixels one of its pixels covers and how many would fill the stage (shown
   * under the resolution). `matched` is the size a display-matched session measured at its start (null otherwise): a
   * frame of that size that no longer fits the window gets a hint to reload.
   */
  setDisplayScale(
    frameWidth: number,
    frameHeight: number,
    scale: number,
    fillScale: number,
    matched: GameResolution | null,
  ): void;
  setReShadeMode(mode: ReShadeMode): void;
  setUpscaleMode(mode: UpscaleMode): void;
  setMapsAvailable(available: boolean): void;
  /** Whether the HD view (true) or the original picture (false) is shown; null without an HD bridge (no button). */
  setHdView(on: boolean | null): void;
  /**
   * The quality tier the shown HD view draws with: 0 everything, higher ones give up its least visible passes to hold
   * the frame rate (hdBridge.ts FRAME_BUDGET_MS); null while the HD view is not on screen.
   */
  setHdQuality(tier: number | null, tiers?: number): void;
  /**
   * Stalls of the current match as the HD bridge's recorder counts them (presented frames more than 150 ms late) and
   * the longest of them in ms: one line under the frame rates. A count of 0 clears the line.
   */
  setStalls(count: number, longestMs: number): void;
  /**
   * The logic rate the game reached in the telemetry's last window and the rate its speed setting allows (null: the
   * fastest setting has no limit; undefined: unknown): one line, "游戏速度 实际 X / 应有 Y". `actual` null clears it.
   */
  setGameSpeed(actual: number | null, target?: number | null): void;
  /** Select the clock multiplier for both buttons and [ ] shortcuts: synchronize aria-pressed and notify the page. */
  pressClockRate(rate: number): void;
  destroy(): void;
}

export interface RuntimeToolbarCallbacks {
  onCollectPerformance?(signal: AbortSignal, progress: (remainingSeconds: number) => void): Promise<string>;
  onClockRate(rate: number): void;
  onResolution(value: string): Promise<void>;
  /** Switch between the HD view and the original picture. */
  onHdView?(): void;
  onVolume(linear: number): void;
  onPerformance(summary: string): void;
  onSendCheatText(text: string): void;
  onSendCheatKey(code: string): void;
  onChangeSource(): Promise<void>;
  onCustomMaps?(): Promise<void>;
  onReShadeMode?(mode: ReShadeMode): void;
  onUpscaleMode?(mode: UpscaleMode): void;
  onCaptureProbe?(size: number): ProbeImage;
  onLiveModel?(file: File | null, modelId?: import('./experiments/modelProbe').LiveModelId): Promise<void>;
  onQuickStart?(): Promise<void>;
  onDownloadSave(): Promise<void>;
  /** true means import completed and reload is imminent; false means user cancellation. */
  onUploadSave(file: File): Promise<boolean>;
}

/** Keep high-frequency counters in the controller and notify React only after 500ms sampling; components do not handle per-frame/per-hypercall updates. */
export function installRuntimeToolbar(
  callbacks: RuntimeToolbarCallbacks,
  canvas: HTMLCanvasElement,
  rendererBackend: 'WebGL2' | 'Canvas 2D',
  rendererDetail: string,
): RuntimeToolbar {
  let disposed = false;
  let hypercalls = 0,
    logicFrames = 0,
    presentedFrames = 0,
    longTaskMs = 0;
  let sampleStarted = performance.now();
  const label = /llvmpipe|swiftshader|software|mesa offscreen/i.test(rendererDetail)
    ? t('{0}（软件）', rendererBackend)
    : rendererBackend;
  const model: ToolbarModel = {
    title: 'RA2 VM',
    fps: t('{0} · VM -- · 显示 --', label),
    performance: t('HC --/s · 阻塞 --'),
    performanceTitle: '',
    rendererDetail,
    cheatGame: null,
    resolution: '',
    resolutionStatus: '',
    stalls: '',
    gameSpeed: '',
    rate: 1,
    upscaleMode: 'off',
    reshadeMode: 'off',
    mapsAvailable: false,
    hdView: null,
    hdQuality: null,
    hdQualityTiers: 0,
  };
  const publish = () => {
    if (disposed) return;
    toolbarState.set({
      model: { ...model },
      callbacks,
      canvas,
      pressRate: pressClockRate,
      setResolution(value) {
        model.resolution = value;
        publish();
      },
    });
  };
  const pressClockRate = (rate: number) => {
    if (![1, 2, 4].includes(rate) || disposed) return;
    model.rate = rate;
    try {
      localStorage.setItem('vm-clock-rate', String(rate));
    } catch {
      /* Private mode affects only restoration next time. */
    }
    callbacks.onClockRate(rate);
    publish();
  };
  try {
    const stored = Number(localStorage.getItem('vm-clock-rate'));
    if ([1, 2, 4].includes(stored)) {
      model.rate = stored;
      callbacks.onClockRate(stored);
    }
  } catch {
    /* Local storage is optional. */
  }
  const observer =
    typeof PerformanceObserver !== 'undefined' && PerformanceObserver.supportedEntryTypes.includes('longtask')
      ? new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) longTaskMs += entry.duration;
        })
      : null;
  observer?.observe({ entryTypes: ['longtask'] });
  publish();
  const timer = window.setInterval(() => {
    const now = performance.now(),
      elapsed = Math.max(1, now - sampleStarted);
    model.fps = t(
      '{0} · VM {1} · 显示 {2}',
      label,
      ((logicFrames * 1000) / elapsed).toFixed(1),
      ((presentedFrames * 1000) / elapsed).toFixed(1),
    );
    const calls = ((hypercalls * 1000) / elapsed).toFixed(0);
    const blocked = Math.min(100, (Math.max(longTaskMs, Math.max(0, elapsed - 550)) * 100) / elapsed).toFixed(0);
    model.performance = t('HC {0}/s · 阻塞 {1}%', calls, blocked);
    const summary = t('{0} HC/s · 主线程阻塞 {1}%', calls, blocked);
    model.performanceTitle = t('{0}；此值表示页面主线程，不是整机 CPU 占用', summary);
    callbacks.onPerformance(summary);
    hypercalls = logicFrames = presentedFrames = longTaskMs = 0;
    sampleStarted = now;
    publish();
  }, 500);
  return {
    getPerformanceSettings: () => ({
      rate: model.rate,
      resolution: model.resolution,
      upscaleMode: model.upscaleMode,
      reshadeMode: model.reshadeMode,
    }),
    setRendererDetail(detail) {
      model.rendererDetail = detail;
      publish();
    },
    setReShadeMode(mode) {
      model.reshadeMode = mode;
      publish();
    },
    setUpscaleMode(mode) {
      model.upscaleMode = mode;
      publish();
    },
    setMapsAvailable(available) {
      if (model.mapsAvailable !== available) {
        model.mapsAvailable = available;
        publish();
      }
    },
    setHdView(on) {
      if (model.hdView !== on) {
        model.hdView = on;
        publish();
      }
    },
    setHdQuality(tier, tiers = 0) {
      if (model.hdQuality !== tier || (tier !== null && model.hdQualityTiers !== tiers)) {
        model.hdQuality = tier;
        if (tier !== null) model.hdQualityTiers = tiers;
        publish();
      }
    },
    setStalls(count, longestMs) {
      const stalls = count > 0 ? t('卡顿 {0} 次，最长 {1} 秒', count, (longestMs / 1000).toFixed(1)) : '';
      if (stalls === model.stalls) return;
      model.stalls = stalls;
      publish();
    },
    setGameSpeed(actual, target) {
      const rate = (value: number) => value.toFixed(1);
      const line =
        actual === null
          ? ''
          : typeof target === 'number'
            ? t('游戏速度 实际 {0} / 应有 {1}', rate(actual), rate(target))
            : target === null
              ? t('游戏速度 实际 {0} / 不限速', rate(actual))
              : t('游戏速度 实际 {0}', rate(actual));
      if (line === model.gameSpeed) return;
      model.gameSpeed = line;
      publish();
    },
    setGameTitle(title) {
      model.title = title;
      publish();
    },
    recordCall(count = 1) {
      hypercalls += count;
    },
    recordLogicFrame(count = 1) {
      logicFrames += count;
    },
    recordPresentedFrame() {
      presentedFrames++;
    },
    setCheatGame(game) {
      if (model.cheatGame !== game) {
        model.cheatGame = game;
        publish();
      }
    },
    setResolution(choice) {
      model.resolution = resolutionChoiceValue(choice);
      publish();
    },
    setDisplayScale(frameWidth, frameHeight, scale, fillScale, matched) {
      const whole = Math.abs(scale - Math.round(scale)) < 1e-6;
      const stale = displayMatchIsStale(matched, { width: frameWidth, height: frameHeight }, scale, fillScale);
      const status =
        t(
          '{0}×{1} · 每像素 {2} 设备像素',
          frameWidth,
          frameHeight,
          whole ? String(Math.round(scale)) : scale.toFixed(2),
        ) + (stale ? t(' · 窗口已变，刷新页面重新匹配') : '');
      if (status === model.resolutionStatus) return;
      model.resolutionStatus = status;
      publish();
    },
    pressClockRate,
    destroy() {
      if (disposed) return;
      disposed = true;
      window.clearInterval(timer);
      observer?.disconnect();
      if (toolbarState.getSnapshot()?.callbacks === callbacks) toolbarState.set(null);
    },
  };
}
