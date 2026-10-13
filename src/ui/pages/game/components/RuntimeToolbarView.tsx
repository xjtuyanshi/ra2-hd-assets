import { t, localizeLabel, localizeText } from '../../../shared/i18n/translate';
import type { ReShadeMode } from '../../../../graphics/reshadePreset';
import { Component, lazy, Suspense, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { CHEAT_GUIDES, type CheatGuideGameId } from '../cheatGuides';
import { normalizeCheatText, CHEAT_TEXT_MAX_LENGTH } from '../input';
import { setControlsCollapsed, toggleImmersiveFullscreen } from '../gameInput';
import type { RuntimeToolbarCallbacks } from '../runtimeToolbar';
import { Modal } from './Modal';
import { PerformanceDiagnostics } from './PerformanceDiagnostics';
import { GameSelect } from './GameSelect';
import type { UpscaleMode } from '../vmFrameRenderer';
import { DISPLAY_RESOLUTION } from '../vmPageResolution';
import { controlsCollapsed, hotkeySheet, hotkeySheetVisible } from '../state/uiState';
import { DEFAULT_VOLUME_PERCENT } from '../../../../adapter/audio';
import { useStore } from '../../../shared/state/useStore';
import { isDesktopEdge, showEdgeMouseNotice } from './edgeMouseNotice';

// Remove experiments at the import boundary so production excludes ONNX/experimental Workers, rather than merely hiding buttons.
const loadModelProbeDialog = import.meta.env.DEV
  ? () => import('./ModelProbeDialog').then((module) => ({ default: module.ModelProbeDialog }))
  : () => Promise.reject(new Error(t('模型实验仅在开发模式可用')));
let modelProbeDialogPromise: ReturnType<typeof loadModelProbeDialog> | undefined;

const preloadModelProbeDialog = () => {
  modelProbeDialogPromise ??= loadModelProbeDialog();
  return modelProbeDialogPromise;
};

const ModelProbeDialog = import.meta.env.DEV ? lazy(preloadModelProbeDialog) : null;

class ModelProbeDialogLoadBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: unknown): { error: Error } {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  render() {
    if (this.state.error) {
      return (
        <p role="alert">
          {t('模型实验加载失败：')}
          {localizeText(this.state.error.message)}
        </p>
      );
    }
    return this.props.children;
  }
}

export interface ToolbarModel {
  fps: string;
  performance: string;
  performanceTitle: string;
  rendererDetail: string;
  title: string;
  cheatGame: CheatGuideGameId | null;
  resolution: string;
  /** Frame size and device pixels per frame pixel of the current canvas fit. */
  resolutionStatus?: string;
  /** A negotiated native viewport changed; visible even with the controls collapsed. */
  viewportNotice?: string;
  viewportRestart?: boolean;
  viewportBattle?: boolean;
  refreshNotice?: string;
  /** Stalls of the current match ("卡顿 N 次，最长 X 秒"), empty while there were none or no recorder runs. */
  stalls?: string;
  /** Logic rate reached and allowed ("游戏速度 实际 X / 应有 Y"), empty outside a battle or without telemetry. */
  gameSpeed?: string;
  rate: number;
  upscaleMode: UpscaleMode;
  reshadeMode?: ReShadeMode;
  mapsAvailable: boolean;
  /** HD view shown (true) or the original picture (false); null/absent: no HD bridge in this session. */
  hdView?: boolean | null;
  /** Quality tier of the shown HD view (0 = everything) out of `hdQualityTiers`; null/absent while it is not shown. */
  hdQuality?: number | null;
  hdQualityTiers?: number;
}
const resolutions = [
  'classic',
  'moderate',
  'wide',
  '',
  DISPLAY_RESOLUTION,
  '800x600',
  '1024x768',
  '1280x720',
  '1280x800',
  '1440x900',
  '1600x900',
  '1920x1080',
];
const resolutionLabel = (value: string) =>
  value === 'classic'
    ? t('视野：经典')
    : value === 'moderate'
      ? t('视野：适中')
      : value === 'wide' || value === DISPLAY_RESOLUTION
        ? t('视野：宽')
        : value === ''
          ? t('跟随 INI')
          : value.replace('x', '×');
const errorText = (error: unknown) => localizeText(error instanceof Error ? error.message : String(error));
function CheatContent({ game, callbacks }: { game: CheatGuideGameId | null; callbacks: RuntimeToolbarCallbacks }) {
  const [status, setStatus] = useState(t('页面只报告已交给 VM，不代表游戏接受。'));
  const guide = game === null ? null : CHEAT_GUIDES[game];
  const send = (raw: string) => {
    const result = normalizeCheatText(raw);
    if (!result.ok) {
      setStatus(result.error);
      return;
    }
    try {
      callbacks.onSendCheatText(result.text);
      setStatus(t('已将「{0}」交给 VM。', result.text));
    } catch (error) {
      setStatus(errorText(error));
    }
  };
  return (
    <>
      <div id="vm-cheat-content">
        <p className="cheat-guide-steps">{guide?.steps ?? t('当前游戏尚未提供经过验证的指南。')}</p>
        <div className="cheat-entry-list">
          {guide?.entries.map((entry, index) => (
            <article key={index} className="cheat-entry">
              <div className="cheat-entry-top">
                <code className="cheat-code mono" translate="no">
                  {entry.kind === 'text' ? entry.text : entry.label}
                </code>
                <span className="cheat-effect">{entry.effect}</span>
              </div>
              <p className="cheat-hint">{entry.hint}</p>
              <div className="cheat-entry-actions">
                {entry.kind === 'text' && (
                  <button
                    type="button"
                    className="toolbar-button"
                    onClick={() => {
                      if (!navigator.clipboard) {
                        setStatus(t('当前浏览器不允许复制，请手动复制。'));
                        return;
                      }
                      void navigator.clipboard.writeText(entry.text).then(
                        () => setStatus(t('已复制')),
                        (error) => setStatus(errorText(error)),
                      );
                    }}
                  >
                    {t('复制')}{' '}
                  </button>
                )}
                <button
                  type="button"
                  className="toolbar-button"
                  onClick={() => {
                    if (entry.kind === 'text') send(entry.text);
                    else
                      try {
                        callbacks.onSendCheatKey(entry.keyCode);
                        setStatus(t('已将「{0}」交给 VM。', entry.label));
                      } catch (error) {
                        setStatus(errorText(error));
                      }
                  }}
                >
                  {entry.kind === 'text' ? t('发送到游戏') : t('发送按键')}
                </button>
              </div>
            </article>
          ))}
        </div>
        <section className="cheat-custom">
          <h3>{t('自定义秘籍')}</h3>
          <form
            className="cheat-custom-form"
            onSubmit={(event) => {
              event.preventDefault();
              send(String(new FormData(event.currentTarget).get('cheat') ?? ''));
            }}
          >
            <label htmlFor="vm-cheat-custom-input">{t('手机软键盘输入秘籍')}</label>
            <input
              id="vm-cheat-custom-input"
              name="cheat"
              type="text"
              maxLength={CHEAT_TEXT_MAX_LENGTH}
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
            />
            <button type="submit" className="toolbar-button">
              {t('发送到游戏')}{' '}
            </button>
          </form>
        </section>
        <ul className="cheat-guide-notes">
          {guide?.notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      </div>
      <p id="vm-cheat-status" className="cheat-status" role="status">
        {status}
      </p>
    </>
  );
}
export function RuntimeToolbarView({
  model,
  callbacks,
  canvas,
  pressRate,
  setResolution,
}: {
  model: ToolbarModel;
  callbacks: RuntimeToolbarCallbacks;
  canvas: HTMLCanvasElement;
  pressRate(rate: number): void;
  setResolution(value: string): void;
}) {
  const collapsed = useStore(controlsCollapsed);
  const hotkeys = useStore(hotkeySheet) !== null;
  const hotkeysShown = useStore(hotkeySheetVisible);
  const [fullscreen, setFullscreen] = useState(!!document.fullscreenElement);
  const viewportHintShown = useRef(false);
  const [viewportHintVisible, setViewportHintVisible] = useState(false);
  useEffect(() => {
    viewportHintShown.current = false;
    setViewportHintVisible(false);
  }, [callbacks]);
  useEffect(() => {
    if (!model.viewportNotice || !model.viewportBattle || model.viewportRestart || viewportHintShown.current) return;
    viewportHintShown.current = true;
    setViewportHintVisible(true);
    const timer = window.setTimeout(() => setViewportHintVisible(false), 12000);
    return () => {
      window.clearTimeout(timer);
      setViewportHintVisible(false);
    };
  }, [model.viewportNotice, model.viewportRestart, model.viewportBattle]);
  const [changingResolution, setChangingResolution] = useState(false);
  const [cheats, setCheats] = useState(false);
  const [probe, setProbe] = useState(false);
  const [quickStart, setQuickStart] = useState(false);
  // The native page attaches to an already-running process; startup-page hooks
  // are owned by the VM route and cannot open native skirmish setup.
  const quickStartAvailable = new URLSearchParams(window.location.search).get('backend') !== 'native';
  const [volume, setVolume] = useState(() => {
    try {
      const raw = localStorage.getItem('vm-master-volume');
      const value = raw === null ? DEFAULT_VOLUME_PERCENT : Number(raw);
      return Number.isFinite(value) && value >= 0 && value <= 100 ? value : DEFAULT_VOLUME_PERCENT;
    } catch {
      return DEFAULT_VOLUME_PERCENT;
    }
  });
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  // The HD view is on screen (not merely available): with the native overlay passthrough the original picture is
  // then drawn in one keyed 1:1 pass, without upscaling, AI inference or post-processing (vmFrameRenderer.ts draw).
  const hdShown = model.hdView === true && model.hdQuality !== null && model.hdQuality !== undefined;
  const file = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const sync = () => setFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', sync);
    callbacks.onVolume((volume / 100) ** 2);
    return () => {
      document.removeEventListener('fullscreenchange', sync);
    };
  }, [callbacks]);
  useEffect(() => {
    if (ModelProbeDialog) {
      void preloadModelProbeDialog().catch(() => undefined);
    }
  }, []);
  const chooseResolution = async (value: string) => {
    if (value === model.resolution) return;
    setChangingResolution(true);
    setResolution(value);
    try {
      await callbacks.onResolution(value);
    } catch (error) {
      setMessage(errorText(error));
    } finally {
      setChangingResolution(false);
    }
  };
  const run = async (name: string, action: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(name);
    setMessage('');
    try {
      await action();
    } catch (error) {
      setMessage(errorText(error));
    } finally {
      setBusy(null);
    }
  };
  return (
    <>
      {model.viewportNotice &&
        (model.viewportRestart || viewportHintVisible) &&
        canvas.closest('#screen-frame') &&
        createPortal(
          <p id="native-viewport-notice" role="status">
            {model.viewportNotice}{' '}
            {model.viewportRestart && callbacks.onViewportRestart && (
              <button type="button" onClick={() => void callbacks.onViewportRestart?.()}>
                按现在的窗口大小重新启动游戏，约 20 秒
              </button>
            )}
          </p>,
          canvas.closest('#screen-frame')!,
        )}
      <button
        id="vm-controls-toggle"
        className="toolbar-button"
        type="button"
        aria-label={t('收起或展开控制栏')}
        aria-expanded={!collapsed}
        onClick={() => setControlsCollapsed(!collapsed)}
      >
        {collapsed ? '☰' : '✕'}
      </button>
      <span className="brand">{localizeLabel(model.title)}</span>
      <output id="vm-fps" title={localizeText(model.rendererDetail)}>
        {model.fps}
      </output>
      <output id="vm-performance" title={localizeText(message || model.performanceTitle)}>
        {localizeText(message || model.performance)}
      </output>
      <output id="vm-stalls" role="status" title={t('本局中画面停顿超过 150 毫秒的次数与最长一次的时长')}>
        {model.stalls ?? ''}
      </output>
      <output
        id="vm-game-speed"
        role="status"
        title={t('游戏每秒实际推进的逻辑帧数，与当前速度档位应有的帧数（最近 5 秒）')}
      >
        {model.gameSpeed ?? ''}
      </output>
      <div className="resolution-controls">
        <span className="label">{t('超分')}</span>
        <GameSelect
          id="vm-upscale"
          nativeId="vm-upscale-mode"
          label={t('实时超分模式')}
          value={model.upscaleMode}
          options={[
            { value: 'off', label: t('关闭') },
            { value: 'bicubic', label: t('Bicubic（非 AI）') },
            { value: 'fsr', label: t('FSR 1.0（柔和）') },
            { value: 'fsr-rcas-soft', label: t('FSR 1.0+RCAS（轻锐化）') },
            { value: 'fsr-rcas', label: t('FSR 1.0+RCAS（锐化）') },
            { value: 'scalefx', label: t('ScaleFX 3×（像素画）') },
            { value: 'fast', label: t('CNN（快速）') },
            { value: 'gan', label: t('GAN-M（画质）') },
          ]}
          onChange={(value) => callbacks.onUpscaleMode?.(value as UpscaleMode)}
        />
        {hdShown && model.upscaleMode !== 'off' && (
          <output id="vm-upscale-hd-note" role="status">
            {t('高清画面显示时不运行（只作用于原版画面）')}
          </output>
        )}
      </div>
      <div className="resolution-controls reshade-controls">
        <span className="label" title={t('SweetFX 的 Vibrance 与 LumaSharpen 浏览器移植')}>
          ReShade
        </span>
        <GameSelect
          id="vm-reshade"
          nativeId="vm-reshade-mode"
          label={t('ReShade 后处理')}
          value={model.reshadeMode ?? 'off'}
          options={[
            { value: 'off', label: t('关闭') },
            { value: 'enhance', label: t('色彩 + 锐化') },
            { value: 'compare', label: t('左右对照') },
          ]}
          onChange={(value) => {
            try {
              callbacks.onReShadeMode?.(value as ReShadeMode);
              setMessage('');
            } catch (error) {
              setMessage(errorText(error));
            }
          }}
        />
        <output id="vm-reshade-status" role="status">
          {hdShown && (model.reshadeMode ?? 'off') !== 'off'
            ? t('高清画面显示时不运行（只作用于原版画面）')
            : model.reshadeMode === 'compare'
              ? t('左：原图 · 右：增强')
              : model.reshadeMode === 'enhance'
                ? t('已开启 · 色彩 + 锐化')
                : t('已关闭')}
        </output>
      </div>
      <div className="rate-controls vm-clock-controls" role="group" aria-label={t('时钟倍率')}>
        <span>{t('时钟')}</span>
        {[1, 2, 4].map((rate) => (
          <button
            key={rate}
            className="rate-button"
            type="button"
            data-clock-rate={rate}
            aria-pressed={model.rate === rate}
            onClick={() => pressRate(rate)}
          >
            {rate}×
          </button>
        ))}
      </div>
      <div className="resolution-controls resolution-size-controls">
        <span className="label">{t('视野 / 分辨率')}</span>
        <GameSelect
          id="vm-resolution"
          label={t('游戏分辨率')}
          value={model.resolution}
          disabled={changingResolution}
          // A size from ?resolution= need not be a preset; list it so the dropdown shows what is running.
          options={(resolutions.includes(model.resolution) ? resolutions : [...resolutions, model.resolution]).map(
            (value) => ({ value, label: resolutionLabel(value) }),
          )}
          onChange={(value) => void chooseResolution(value)}
        />
        <output id="vm-resolution-status" role="status">
          {model.resolutionStatus ?? ''}
        </output>
      </div>
      <div className="volume-controls slider-item">
        <span className="label">{t('主音量')}</span>
        <div className="slider-fields">
          <input
            id="vm-volume"
            type="range"
            min="0"
            max="100"
            step="1"
            value={volume}
            aria-label={t('主音量')}
            onChange={(event) => {
              const value = Number(event.target.value);
              setVolume(value);
              callbacks.onVolume((value / 100) ** 2);
              try {
                localStorage.setItem('vm-master-volume', String(value));
              } catch {
                /* Private mode retains only the session value. */
              }
            }}
          />
          <input id="vm-volume-value" type="text" disabled readOnly value={`${volume}%`} aria-label={t('主音量读数')} />
        </div>
      </div>
      {quickStartAvailable && (
        <button
          id="vm-quick-start"
          className="toolbar-button"
          type="button"
          disabled={!!busy || !model.mapsAvailable || !callbacks.onQuickStart}
          onClick={() => setQuickStart(true)}
        >
          {t('快速开局…')}{' '}
        </button>
      )}
      {callbacks.onCollectPerformance && (
        <PerformanceDiagnostics collect={callbacks.onCollectPerformance} available={model.mapsAvailable} />
      )}
      {ModelProbeDialog && (
        <button
          id="vm-model-probe"
          className="toolbar-button"
          type="button"
          disabled={!callbacks.onCaptureProbe}
          onClick={() => setProbe(true)}
        >
          {t('模型实验…')}{' '}
        </button>
      )}
      {import.meta.env.DEV && callbacks.onLiveModel && (
        <button
          id="vm-live-model-stop"
          className="toolbar-button"
          type="button"
          onClick={() => void run('stop-model', () => callbacks.onLiveModel!(null))}
        >
          {t('停止整帧模型')}{' '}
        </button>
      )}
      <button
        id="vm-cheat-guides"
        className="toolbar-button"
        type="button"
        disabled={model.cheatGame === null}
        onClick={() => setCheats(true)}
      >
        {t('作弊码指南')}{' '}
      </button>
      <button
        id="vm-save-download"
        className="toolbar-button"
        type="button"
        disabled={!!busy}
        onClick={() => void run('download', callbacks.onDownloadSave)}
      >
        {busy === 'download' ? t('正在打包…') : t('下载存档')}
      </button>
      <button
        id="vm-save-upload"
        className="toolbar-button"
        type="button"
        disabled={!!busy}
        onClick={() => file.current?.click()}
      >
        {busy === 'upload' ? t('正在校验…') : t('上传存档')}
      </button>
      <input
        ref={file}
        id="vm-save-file"
        type="file"
        accept=".json,.ra2-save,application/json"
        hidden
        onChange={(event) => {
          const selected = event.currentTarget.files?.[0];
          event.currentTarget.value = '';
          if (selected) void run('upload', () => callbacks.onUploadSave(selected));
        }}
      />
      <button
        id="vm-custom-maps"
        className="toolbar-button"
        type="button"
        disabled={!!busy || !model.mapsAvailable}
        title={model.mapsAvailable ? t('建议在开始对局前附加地图包') : t('游戏启动后可附加地图包')}
        onClick={() =>
          void run('maps', async () => {
            await callbacks.onCustomMaps?.();
          })
        }
      >
        {t('附加地图包…')}{' '}
      </button>
      <button
        id="vm-change-source"
        className="toolbar-button"
        type="button"
        disabled={!!busy}
        onClick={() => void run('source', callbacks.onChangeSource)}
      >
        {busy === 'source' ? t('正在安全停止…') : t('更换游戏目录…')}
      </button>
      <a
        id="vm-open-source"
        className="toolbar-button"
        href="https://github.com/ra2-games/ra2"
        target="_blank"
        rel="noopener noreferrer"
      >
        GitHub
      </a>
      {isDesktopEdge() && (
        <button
          id="vm-edge-notice"
          className="toolbar-button"
          type="button"
          onClick={() => void showEdgeMouseNotice(true)}
        >
          Edge 提醒
        </button>
      )}
      {model.hdView !== null && model.hdView !== undefined && callbacks.onHdView && (
        <button
          id="vm-hd-view"
          className="toolbar-button"
          type="button"
          aria-pressed={model.hdView}
          title={
            model.hdView && model.hdQuality
              ? t(
                  '帧率不足，已自动减少最不显眼的效果（热浪与半透明特效混色、抗锯齿、软影）；精灵与地形仍是 1:1，帧率恢复后自动还原',
                )
              : t('切换高清画面与原版画面（快捷键 \\）')
          }
          onClick={() => callbacks.onHdView?.()}
        >
          {!model.hdView
            ? t('画面：原版')
            : model.hdQuality
              ? t('画面：高清 · 减负 {0}/{1}', model.hdQuality, Math.max(1, (model.hdQualityTiers ?? 1) - 1))
              : t('画面：高清')}
        </button>
      )}
      {hotkeys && (
        <button
          id="vm-hotkeys"
          className="toolbar-button"
          type="button"
          aria-pressed={hotkeysShown}
          title={t('在游戏画面上显示全部按键；显示时游戏照常接收键盘和鼠标')}
          onClick={() => {
            hotkeySheetVisible.set(!hotkeysShown);
            canvas.focus({ preventScroll: true });
          }}
        >
          {t('快捷键')}
        </button>
      )}
      <button
        id="vm-fullscreen"
        className="toolbar-button"
        type="button"
        onClick={() => void toggleImmersiveFullscreen(canvas).catch((error) => setMessage(errorText(error)))}
      >
        {fullscreen ? t('退出全屏') : t('全屏')}
      </button>
      {createPortal(
        <Modal
          id="vm-cheat-dialog"
          open={cheats && model.cheatGame !== null}
          title={t('作弊码指南')}
          onClose={() => setCheats(false)}
          className="cheat-dialog"
        >
          <header>
            <h2 id="vm-cheat-dialog-title">{t('作弊码指南')}</h2>
            <button
              id="vm-cheat-dialog-close"
              className="toolbar-button"
              type="button"
              onClick={() => setCheats(false)}
            >
              {t('关闭')}{' '}
            </button>
          </header>
          <CheatContent game={model.cheatGame} callbacks={callbacks} />
        </Modal>,
        document.body,
      )}
      {ModelProbeDialog &&
        probe &&
        callbacks.onCaptureProbe &&
        createPortal(
          <ModelProbeDialogLoadBoundary>
            <Suspense fallback={<p role="status">{t('正在打开模型实验…')}</p>}>
              <ModelProbeDialog
                capture={callbacks.onCaptureProbe}
                live={callbacks.onLiveModel}
                close={() => setProbe(false)}
              />
            </Suspense>
          </ModelProbeDialogLoadBoundary>,
          document.body,
        )}
      {quickStart &&
        createPortal(
          <Modal
            open
            title={t('快速开局')}
            onClose={() => setQuickStart(false)}
            busy={busy === 'quick'}
            className="quick-start-dialog"
          >
            <h3>{t('重新启动并进入遭遇战设置？')}</h3>
            <p>{t('当前游戏会关闭，未保存的对局进度会丢失，联机会断开。资源未缓存时需重新选择游戏文件。')}</p>
            <p>{t('这会直达设置页，国家、地图和开始战斗仍由你选择。')}</p>
            <button type="button" className="dialog-button" disabled={!!busy} onClick={() => setQuickStart(false)}>
              {t('取消')}{' '}
            </button>
            <button
              type="button"
              className="dialog-button"
              disabled={!!busy}
              onClick={() =>
                void run('quick', async () => {
                  await callbacks.onQuickStart?.();
                  setQuickStart(false);
                })
              }
            >
              {busy === 'quick' ? t('正在安全重启…') : t('重启并进入遭遇战')}
            </button>
            {message && <p role="alert">{message}</p>}
          </Modal>,
          document.body,
        )}
    </>
  );
}
