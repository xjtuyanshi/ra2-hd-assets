import { t } from '../../shared/i18n/translate';
import { useEffect, useRef } from 'react';
import {
  BootRegion,
  DebugRegion,
  Dialogs,
  MainRegion,
  OverlayRegion,
  ScreenStatus,
  Toolbar,
} from './components/AppRegions';
import { gameRunning, mainPanel, sourceRequest } from './state/uiState';
import { useStore } from '../../shared/state/useStore';
import { usePanelWheelAcceleration } from './hooks/usePanelWheelAcceleration';

/** One React tree owns all page UI; refs only form the boundary to VM graphics/input adapters. */
export function AppShell() {
  usePanelWheelAcceleration();
  const running = useStore(gameRunning);
  const choosingSource = useStore(sourceRequest) !== null;
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    let cancelled = false;
    let stop: (() => void) | undefined;
    void import('./page')
      .then((runtime) => {
        if (cancelled) return;
        stop = runtime.stopVmPage;
        return runtime.startVmPage(canvas.current!);
      })
      .catch((error) => {
        if (!cancelled && error?.name !== 'AbortError') {
          stop?.();
          mainPanel.set({ phase: 'error', detail: String(error) });
        }
      });
    return () => {
      cancelled = true;
      stop?.();
    };
  }, []);
  return (
    <div className={choosingSource ? 'game-home' : running ? 'game-running' : undefined}>
      <Toolbar />
      <div id="app-layout">
        <div id="stage">
          <div id="screen-frame">
            <canvas ref={canvas} id="screen" width="800" height="600"></canvas>
            <ScreenStatus />
            <OverlayRegion />
            <span className="lock-corner lock-corner-tl" aria-hidden="true"></span>
            <span className="lock-corner lock-corner-tr" aria-hidden="true"></span>
            <span className="lock-corner lock-corner-bl" aria-hidden="true"></span>
            <span className="lock-corner lock-corner-br" aria-hidden="true"></span>
            <div id="client-page" aria-hidden="true"></div>
          </div>
          <BootRegion />
        </div>
        <DebugRegion />
      </div>
      <div id="vm-touch-controls" hidden aria-label={t('触屏虚拟按键')}>
        <button className="touch-key touch-collapse" type="button" data-role="collapse" aria-label={t('折叠虚拟按键')}>
          <svg className="touch-keyboard-icon" viewBox="0 0 24 16" aria-hidden="true" focusable="false">
            <rect x="1" y="1" width="22" height="14" rx="2" />
            <path d="M5 5h1M9 5h1M13 5h1M17 5h1M5 9h1M9 9h1M13 9h6M7 12h10" />
          </svg>
        </button>
        <button className="touch-key" type="button" data-code="Escape" aria-label={t('Esc 键')}>
          Esc
        </button>
        <button className="touch-key" type="button" data-code="Enter" aria-label={t('Enter 键')}>
          Enter
        </button>
        <button className="touch-key" type="button" data-code="Space" aria-label={t('空格键')}>
          {t('空格')}{' '}
        </button>
        <div className="touch-dpad" aria-label={t('方向键')}>
          <button className="touch-key" type="button" data-code="ArrowUp" aria-label={t('上方向键')}>
            ▲
          </button>
          <button className="touch-key" type="button" data-code="ArrowLeft" aria-label={t('左方向键')}>
            ◀
          </button>
          <button className="touch-key" type="button" data-code="ArrowRight" aria-label={t('右方向键')}>
            ▶
          </button>
          <button className="touch-key" type="button" data-code="ArrowDown" aria-label={t('下方向键')}>
            ▼
          </button>
        </div>
      </div>
      <button
        id="vm-touch-joystick"
        type="button"
        data-role="joystick"
        hidden
        aria-label={t('摇杆：拖动摇杆向上下左右卷动地图')}
      >
        <span className="joystick-knob"></span>
      </button>
      <MainRegion />
      <Dialogs />
    </div>
  );
}
