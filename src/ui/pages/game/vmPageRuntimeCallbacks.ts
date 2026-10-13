import { t } from '../../shared/i18n/translate';
/**
 * VM runtime callback object extracted from page.ts startVmPage.
 * Compose status, call, and frame callbacks into GameVmCallbacks, filtered by guardVmCallbacks generations. Pass session-reassigned local state through getters/setters to avoid capturing stale values.
 */
import type { VmShell } from '../../../adapter/vmShell';
import type { GameVmCallbacks } from '../../../app/session/runtimeEvents';
import type { VmStatus } from '../../../app/session/runtimeEvents';
import type { Win32Call } from '../../../vm86/win32';
import type { SupportedGameId } from '../../../games/catalog';
import type { LiveModelId } from './experiments/modelProbe';
import type { FrameEffectController } from '../../../app/session/frameEffectController';
import type { FramePresenter } from '../../../graphics/framePresenter';
import { measureRa2BattlefieldFrame, sampleVmFrameHash } from './debug/frameProbes';
import { formatNetworkStatus } from './networkStatus';
import { activeCheatGameForPhase } from './cheatGuides';
import { gameRunning, networkStatus, movieSkip, runtimeNotice } from './state/uiState';
import type { RuntimeToolbar } from './runtimeToolbar';
import type { VmFrame } from '../../../vm86/win32';

export interface VmPageRuntimeCallbackDeps {
  canvas: HTMLCanvasElement;
  debugAutoOpen: boolean;
  toolbar: RuntimeToolbar;
  presenter: FramePresenter;
  effects: FrameEffectController<LiveModelId>;
  getVm: () => VmShell | null;
  getSelectedGameId: () => SupportedGameId | null;
  setStatus: (next: VmStatus) => void;
  getCallCount: () => number;
  setCallCount: (next: number) => void;
  getPanelCreated: () => boolean;
  callHistogram: Map<string, number>;
  calls: string[];
  getGameFrameSize: () => { width: number; height: number };
  setGameFrameSize: (width: number, height: number) => void;
  getAdaptInputResolution: () => ((width: number, height: number) => void) | null;
  getRefitActiveCanvas: () => (frameWidth?: number, frameHeight?: number) => void;
  onUpdateBootOverlay: (next: VmStatus) => void;
  onScheduleRender: () => void;
  onHideBootOverlay: () => void;
  onFinishExited: (detail: string) => void;
  onExposeRuntimeCallProbe: () => void;
  onAppendCall: (lines: string[], call: Win32Call, ordinal: number, suffix?: string) => void;
  onCursorFrame?: (frame: VmFrame) => void;
}

export function createVmRuntimeCallbacks(deps: VmPageRuntimeCallbackDeps): GameVmCallbacks {
  let pictureStarted = false;
  const revealPicture = () => {
    if (pictureStarted) return;
    pictureStarted = true;
    deps.onHideBootOverlay();
  };
  const {
    canvas,
    debugAutoOpen,
    toolbar,
    presenter,
    effects,
    getVm,
    getSelectedGameId,
    setStatus,
    getCallCount,
    setCallCount,
    getPanelCreated,
    callHistogram,
    calls,
    getGameFrameSize,
    setGameFrameSize,
    getAdaptInputResolution,
    getRefitActiveCanvas,
    onUpdateBootOverlay,
    onScheduleRender,
    onFinishExited,
    onExposeRuntimeCallProbe,
    onAppendCall,
  } = deps;
  return {
    onNetworkStatus(next) {
      networkStatus.set({
        phase: next.phase,
        text: formatNetworkStatus(next),
        title: t('虚拟 LAN：{0}。中继连接状态不代表游戏逻辑同步。', next.room),
      });
    },
    onStatus(next) {
      runtimeNotice.set(next.notice ?? null);
      if (next.phase !== 'running') {
        movieSkip.set(null);
        effects.stop();
      }
      setStatus(next);
      if (debugAutoOpen) canvas.dataset.vmStatus = JSON.stringify(next);
      toolbar.setCheatGame(activeCheatGameForPhase(getSelectedGameId(), next.phase));
      toolbar.setMapsAvailable(next.phase === 'running' && getVm() !== null);
      onUpdateBootOverlay(next);
      onScheduleRender();
      // Switch the client shell with game state: running fills the window with gameplay; menus restore the content page and navigation bar.
      gameRunning.set(next.phase === 'running');
      if (next.phase === 'exited') queueMicrotask(() => void onFinishExited(next.detail));
    },
    onMoviePlayback(playing) {
      canvas.dataset.moviePlaying = String(playing);
      // A movie can begin with black frames; its Skip control must remain available.
      if (playing) revealPicture();
      movieSkip.set(
        playing
          ? () => {
              const vm = getVm();
              if (!vm || canvas.dataset.moviePlaying !== 'true') return;
              vm.setKeyState(27, true);
              vm.postMessage(0x100, 27, 0x00010001);
              vm.setKeyState(27, false);
              vm.postMessage(0x101, 27, 0xc0010001);
              canvas.focus();
            }
          : null,
      );
    },
    onShellPage(title) {
      if (title) canvas.dataset.shellPage = title;
      else delete canvas.dataset.shellPage;
    },
    onCall(call, ordinal) {
      setCallCount(ordinal);
      toolbar.recordCall();
      if (!getPanelCreated()) return;
      callHistogram.set(call.imported.key, (callHistogram.get(call.imported.key) ?? 0) + 1);
      onExposeRuntimeCallProbe();
      // Initialization can issue hundreds of thousands of calls; sample logs sparsely and coalesce DOM updates with rAF.
      if (ordinal <= 200 || ordinal % 256 === 0) {
        onAppendCall(calls, call, ordinal);
        onScheduleRender();
      }
    },
    onCallBatch(batch) {
      setCallCount(batch.ordinal);
      toolbar.recordCall(batch.delta);
      toolbar.recordLogicFrame(batch.logicFrames);
      if (debugAutoOpen) {
        canvas.dataset.vmBatch = JSON.stringify({
          calls: batch.delta,
          logicFrames: batch.logicFrames,
          hot: [...batch.histogram].sort((left, right) => right[1] - left[1]).slice(0, 8),
        });
      }
      if (!getPanelCreated()) return;
      for (const [key, count] of batch.histogram) {
        callHistogram.set(key, (callHistogram.get(key) ?? 0) + count);
      }
      onExposeRuntimeCallProbe();
      if (batch.samples.length) {
        for (const sample of batch.samples) onAppendCall(calls, sample.call, sample.ordinal);
        onScheduleRender();
      }
    },
    onBlocked(call) {
      if (getPanelCreated()) onAppendCall(calls, call, getCallCount(), t('← 下一个迁移边界'));
      onScheduleRender();
    },
    onLogicFrame(count) {
      toolbar.recordLogicFrame(count);
    },
    onFrame(frame) {
      const size = getGameFrameSize();
      if (frame.width !== size.width || frame.height !== size.height) {
        setGameFrameSize(frame.width, frame.height);
        getAdaptInputResolution()?.(frame.width, frame.height);
        getRefitActiveCanvas()(frame.width, frame.height);
      }
      presenter.submit(frame);
      deps.onCursorFrame?.(frame);
      if (debugAutoOpen) {
        canvas.dataset.vmFrame = `${presenter.frameVersion}`;
        canvas.dataset.vmResolution = `${frame.width}x${frame.height}`;
        // Hashes serve low-frequency E2E sampling, not every 60fps presentation frame. Sampling every fourth frame
        // captures logo/video changes without the probe starving transition audio or page responsiveness.
        if ((presenter.frameVersion & 3) === 0) canvas.dataset.vmFrameSample = sampleVmFrameHash(frame);
        const battlefield = measureRa2BattlefieldFrame(frame);
        canvas.dataset.vmBattlefield = `${battlefield.rightEdgeRatio.toFixed(4)},${battlefield.fieldRatio.toFixed(4)}`;
      }
      // DirectDraw creates and presents an empty primary surface before the game
      // has loaded its menu. Keep the loading/cancel panel until picture content
      // arrives instead of leaving the player on an unexplained black page.
      if (!pictureStarted && frameHasPicture(frame)) revealPicture();
      onScheduleRender();
    },
  };
}

function frameHasPicture(frame: VmFrame): boolean {
  if (frame.rgba) {
    for (let offset = 0; offset < frame.rgba.length; offset += 4) {
      if (frame.rgba[offset] || frame.rgba[offset + 1] || frame.rgba[offset + 2]) return true;
    }
  } else if (frame.rgb565) {
    for (const pixel of frame.rgb565) if (pixel) return true;
  } else {
    const lit = new Uint8Array(256);
    for (let index = 0; index < lit.length; index++) {
      const offset = index * 4;
      lit[index] = frame.palette[offset] || frame.palette[offset + 1] || frame.palette[offset + 2] ? 1 : 0;
    }
    for (const pixel of frame.pixels) if (lit[pixel]) return true;
  }
  return false;
}
