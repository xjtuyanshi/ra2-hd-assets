import { t, localizeLabel, localizeText } from '../../../shared/i18n/translate';
import { useState, type CSSProperties } from 'react';
import { forgetGameDirectory } from '../../../../platform/browser/files/directoryAccess';
import { clearCachedGameFiles } from '../../../../adapter/cachedGameFiles';
import type { BootState, StatusState } from '../state/uiState';
import { NativeMarksNotice } from './NativeMarksNotice';

const panelStyle: CSSProperties = {
  left: '50%',
  top: '50%',
  transform: 'translate(-50%,-50%)',
  width: 'min(560px,calc(100vw - 40px))',
  zIndex: 35,
};
const reasonText = (reason: unknown) => (reason instanceof Error ? reason.message : String(reason));
export function ProblemPanel({ phase, detail }: { phase: 'blocked' | 'error'; detail: string }) {
  const [copied, setCopied] = useState(t('复制错误详情'));
  return (
    <section className="panel game-folder-panel bad-page" style={panelStyle}>
      <h3 style={{ color: '#f00', fontSize: 24 }}>
        {phase === 'blocked' ? t('接口待实现（游戏停在此处）') : t('运行错误')}
      </h3>
      <pre
        style={{
          maxHeight: 220,
          overflow: 'auto',
          whiteSpace: 'pre-wrap',
          overflowWrap: 'anywhere',
          userSelect: 'text',
        }}
      >
        {localizeText(detail)}
      </pre>
      <div style={{ display: 'flex', gap: 8 }}>
        <button
          type="button"
          className="folder-button"
          onClick={() => {
            if (!navigator.clipboard) {
              setCopied(t('复制失败'));
              return;
            }
            void navigator.clipboard.writeText(`${phase.toUpperCase()}\n${localizeText(detail)}`).then(
              () => setCopied(t('已复制')),
              () => setCopied(t('复制失败')),
            );
          }}
        >
          {localizeText(copied)}
        </button>
        <button type="button" className="folder-button" onClick={() => window.location.reload()}>
          {t('重新启动游戏')}{' '}
        </button>
      </div>
    </section>
  );
}
export function ExitPanel({ detail }: { detail: string }) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  if (new URLSearchParams(window.location.search).get('backend') === 'native')
    return (
      <section className="panel game-folder-panel" style={panelStyle}>
        <h3>游戏已关闭</h3>
        <p>如需继续游戏，请重新运行启动器；它会提供新的游戏网址。</p>
      </section>
    );
  return (
    <section className="panel game-folder-panel" style={panelStyle}>
      <h3>{t('已回到网页')}</h3>
      <p>{error || t('原版游戏已正常退出，音频和鼠标锁定已释放。{0}', detail)}</p>
      <button className="folder-button" type="button" onClick={() => window.location.reload()}>
        {t('重新启动游戏')}{' '}
      </button>{' '}
      <button
        className="folder-button"
        type="button"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          void Promise.all([forgetGameDirectory(), clearCachedGameFiles().catch(() => {})]).then(
            () => window.location.reload(),
            (error) => {
              setBusy(false);
              setError(t('无法忘记文件夹：{0}', reasonText(error)));
            },
          );
        }}
      >
        {t('选择其他游戏文件夹')}{' '}
      </button>
    </section>
  );
}

export function BootView({ game, status, cancel, start }: BootState) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  if (start)
    return (
      <div
        id="vm-boot"
        style={{
          position: 'fixed',
          inset: 0,
          zIndex: 10000,
          background: '#111821',
          color: '#f4f6fa',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 24,
          pointerEvents: 'auto',
        }}
      >
        <p style={{ maxWidth: '80vw', fontSize: 24, lineHeight: 1.7, textAlign: 'center', margin: 0 }}>
          全屏开始会让游戏画面匹配整个屏幕。
        </p>
        <NativeMarksNotice />
        <button
          id="native-start"
          type="button"
          onClick={() => start(true)}
          style={{ fontSize: 24, padding: '14px 64px', cursor: 'pointer' }}
        >
          全屏开始
        </button>
        <button
          id="native-start-window"
          type="button"
          onClick={() => start(false)}
          style={{ fontSize: 16, padding: '8px 24px' }}
        >
          按当前窗口开始
        </button>
        <button type="button" onClick={() => void cancel()} style={{ fontSize: 16, padding: '8px 24px' }}>
          取消启动
        </button>
        <p style={{ position: 'absolute', bottom: 16, fontSize: 12, opacity: 0.65 }}>
          本项目与 EA 无关，未获 EA 认可。游戏文件由玩家自行提供。
        </p>
      </div>
    );
  return (
    <div id="vm-boot">
      <div className="vm-boot-icon" aria-hidden="true">
        {game.id.toUpperCase()}
      </div>
      <div className="vm-boot-title">{localizeLabel(game.title)}</div>
      <div className="vm-boot-loading" aria-hidden="true" />
      <div className="vm-boot-phase">
        {status.phase === 'running' ? t('加载资源') : status.phase === 'ready' ? t('内存就绪') : t('启动中')}
      </div>
      <div className="vm-boot-detail">{localizeText(error || status.detail)}</div>

      <button
        type="button"
        className="toolbar-button"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          void cancel().catch((reason) => {
            setBusy(false);
            setError(reasonText(reason));
          });
        }}
      >
        {busy ? t('正在停止…') : t('取消启动')}
      </button>
    </div>
  );
}
export function StatusView({ value, id, bottom }: { value: StatusState; id: string; bottom: number }) {
  return (
    <div
      id={id}
      role="status"
      data-phase={value.phase}
      title={value.title && localizeText(value.title)}
      style={{
        position: 'fixed',
        bottom,
        left: 8,
        zIndex: 50,
        maxWidth: '80vw',
        padding: '5px 8px',
        background: '#111e',
        color: ['error', 'disconnected'].includes(value.phase) ? '#ff8080' : '#ddd',
        fontSize: 12,
        pointerEvents: 'none',
      }}
    >
      {localizeText(value.text)}
    </div>
  );
}
export function ShortcutHelp({ close }: { close(): void }) {
  const rows = [
    [t('点击游戏画面'), t('锁定鼠标；全屏可授权将 Esc 交给游戏')],
    ['Esc', t('获键盘锁授权后交给游戏；长按退出锁定')],
    [t('Shift + 左键'), t('在建造栏上连点 ×10（50ms 间隔）；战场上照常是加选')],
    ['F11', t('沉浸式全屏')],
    ['[ / ]', t('时钟倍率 慢 / 快')],
    ['\\', t('高清画面 / 原版画面（仅高清模式）')],
    ['`', t('开发调试面板')],
    ['?', t('本帮助')],
  ];
  return (
    <section className="panel" style={panelStyle}>
      <h3>{t('快捷键')}</h3>
      <ul>
        {rows.map(([key, description]) => (
          <li key={key}>
            <code>{key}</code> — {description}
          </li>
        ))}
      </ul>
      <button className="folder-button" type="button" onClick={close}>
        {t('关闭')}{' '}
      </button>
    </section>
  );
}
