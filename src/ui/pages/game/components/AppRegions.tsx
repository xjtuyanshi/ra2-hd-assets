import { t, localizeText } from '../../../shared/i18n/translate';
import { createPortal } from 'react-dom';
import { lazy, Suspense } from 'react';
import { useStore } from '../../../shared/state/useStore';
import * as state from '../state/uiState';
import { RuntimeToolbarView } from './RuntimeToolbarView';
import { DebugPanel } from './DebugPanel';
import { BootView, ExitPanel, ProblemPanel, ShortcutHelp, StatusView } from './RuntimePanels';
import { EdgeNotice, edgeRequest } from './edgeMouseNotice';

const GameSourcePickerView = lazy(() =>
  import('./GameSourcePickerView').then((module) => ({ default: module.GameSourcePickerView })),
);
const TrainingPanels = {
  GameOverlays: lazy(() => import('./TrainingPanels').then((module) => ({ default: module.GameOverlays }))),
  TrainingMenu: lazy(() => import('./TrainingPanels').then((module) => ({ default: module.TrainingMenu }))),
};
const CustomMapDialog = lazy(() => import('./CustomMapDialog').then((module) => ({ default: module.CustomMapDialog })));

// Each region subscribes only to its own low-frequency snapshot; toolbar counters do not rerender the canvas or resource picker.
export function Toolbar() {
  const props = useStore(state.toolbarState);
  const collapsed = useStore(state.controlsCollapsed);
  return (
    <nav id="vm-controls" aria-label={t('运行状态与控制')} className={collapsed ? 'collapsed' : undefined}>
      {props && <RuntimeToolbarView {...props} />}
    </nav>
  );
}
export function DebugRegion() {
  const visible = useStore(state.debugVisible),
    props = useStore(state.debugState);
  return (
    <aside id="vm-debug" hidden={!visible} aria-label={t('调试信息')}>
      {props && <DebugPanel {...props} />}
    </aside>
  );
}
export function MainRegion() {
  const request = useStore(state.sourceRequest),
    panel = useStore(state.mainPanel);
  const help = useStore(state.helpVisible);
  const training = useStore(state.trainingPanel);
  return (
    <div id="ui">
      {training?.mode === 'menu' && (
        <Suspense fallback={null}>
          <TrainingPanels.TrainingMenu lessons={training.lessons} />
        </Suspense>
      )}
      {request && (
        <Suspense fallback={<p role="status">{t('正在加载资源选择器…')}</p>}>
          <GameSourcePickerView key={request.id} onSelected={request.finish} />
        </Suspense>
      )}
      {panel &&
        (panel.phase === 'exited' ? (
          <ExitPanel detail={panel.detail} />
        ) : (
          <ProblemPanel phase={panel.phase} detail={panel.detail} />
        ))}
      {help && <ShortcutHelp close={() => state.helpVisible.set(false)} />}
    </div>
  );
}
/** Overlays drawn over the game picture; loaded only once a cheat sheet or a practice lesson exists. */
export function OverlayRegion() {
  const sheet = useStore(state.hotkeySheet);
  const training = useStore(state.trainingPanel);
  return sheet !== null || training?.mode === 'lesson' ? (
    <Suspense fallback={null}>
      <TrainingPanels.GameOverlays />
    </Suspense>
  ) : null;
}
export function BootRegion() {
  const boot = useStore(state.bootState);
  return boot && <BootView {...boot} />;
}
export function ScreenStatus() {
  const network = useStore(state.networkStatus),
    resource = useStore(state.resourceStatus);
  const upscale = useStore(state.upscaleStatus);
  const hd = useStore(state.hdStatus);
  const skipMovie = useStore(state.movieSkip);
  return (
    <>
      {skipMovie && (
        <aside
          id="vm-movie-skip"
          style={{
            position: 'absolute',
            top: 24,
            right: 24,
            zIndex: 20,
            padding: '14px 20px',
            background: 'rgba(12,16,24,.94)',
            color: 'white',
            border: '2px solid #ffd166',
            borderRadius: 8,
          }}
        >
          <button id="vm-skip-movie" onClick={skipMovie} style={{ fontSize: 20, padding: '8px 24px' }}>
            {t('跳过影片')}
          </button>
          <p style={{ margin: '8px 0 0' }}>{t('也可以按 Esc')}</p>
          <p style={{ margin: '4px 0 0' }}>{t('鼠标锁定时，先按 Esc 解锁，再点按钮或再按 Esc。')}</p>
        </aside>
      )}
      <output id="vm-upscale-status" role="status" aria-live="polite" hidden={upscale === null}>
        {upscale && localizeText(upscale)}
      </output>
      <output id="vm-hd-status" role="status" aria-live="polite" hidden={hd === null}>
        {hd}
      </output>
      {network && <StatusView id="vm-network-status" bottom={38} value={network} />}
      {resource && <StatusView id="vm-resource-status" bottom={8} value={resource} />}
    </>
  );
}
export function Dialogs() {
  const maps = useStore(state.mapRequest),
    edge = useStore(edgeRequest);
  return createPortal(
    <>
      {maps && (
        <Suspense fallback={<p role="status">{t('正在加载地图管理…')}</p>}>
          <CustomMapDialog key={maps.id} gameId={maps.gameId} applyLive={maps.applyLive} finish={maps.finish} />
        </Suspense>
      )}
      {edge && <EdgeNotice close={edge.close} />}
    </>,
    document.body,
  );
}
