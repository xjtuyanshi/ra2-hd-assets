import { t, localizeLabel, localizeText } from '../../../shared/i18n/translate';
import { useEffect, useRef, useState } from 'react';
import { parseRa2RelayUrl } from '../../../../games/ra2/networkTransport';
import type { GameSource } from '../../../../games/source';
import { useGameSourcePicker } from '../hooks/useGameSourcePicker';
import { SUPPORTED_GAMES } from '../../../../games/catalog';
import { parseTrainingQuery } from '../training/trainingQuery';
import './GameSourcePicker.css';

export function GameSourcePickerView({ onSelected }: { onSelected(source: GameSource): void }) {
  const props = useGameSourcePicker(onSelected);
  const [relay, setRelay] = useState(() => new URLSearchParams(window.location.search).get('relay') ?? '');
  const [networkEnabled, setNetworkEnabled] = useState(() => {
    const query = new URLSearchParams(window.location.search);
    return query.get('network') !== '0' && (query.get('network') === '1' || query.has('relay'));
  });
  // Practice lessons (development, ?train=<lesson>): go straight to the development files and the lesson's game.
  const autoStart = useRef<'idle' | 'picked' | 'chosen'>('idle');
  useEffect(() => {
    const training = parseTrainingQuery(window.location.search);
    if (!training?.lesson || props.busy) return;
    if (autoStart.current === 'idle') {
      autoStart.current = 'picked';
      props.pick('development');
    } else if (autoStart.current === 'picked' && props.games.includes(training.game)) {
      autoStart.current = 'chosen';
      void props.chooseGame(training.game);
    }
  }, [props]);
  let relayError = '';
  try {
    if (networkEnabled) parseRa2RelayUrl(relay);
  } catch (error) {
    relayError = (error as Error).message;
  }
  const updateRelay = (value: string) => {
    setRelay(value);
    try {
      const address = parseRa2RelayUrl(value);
      const url = new URL(window.location.href);
      url.searchParams.set('network', '1');
      if (address) url.searchParams.set('relay', value.trim());
      else url.searchParams.delete('relay');
      window.history.replaceState(window.history.state, '', url);
    } catch {
      /* Keep invalid drafts in the input and disable startup; update configuration only after correction. */
    }
  };
  const toggleNetwork = (enabled: boolean) => {
    setNetworkEnabled(enabled);
    const url = new URL(window.location.href);
    url.searchParams.set('network', enabled ? '1' : '0');
    if (!enabled) url.searchParams.delete('relay');
    else {
      try {
        const value = parseRa2RelayUrl(relay);
        if (value) url.searchParams.set('relay', relay.trim());
      } catch {
        /* Retain the input draft and show the validation error. */
      }
    }
    window.history.replaceState(window.history.state, '', url);
  };
  const state = props.manifest;
  const entries = state
    ? [
        ...state.manifest.thirdParty.map((file) => ({
          name: file.name,
          note: t('主程序（来自你自己的游戏安装）'),
          optional: false,
          ok: state.present.has(file.name.toLowerCase()),
        })),
        ...state.manifest.playerRequired.map((file) => ({
          ...file,
          optional: false,
          ok: state.present.has(file.name.toLowerCase()),
        })),
        ...state.manifest.playerOptional.map((file) => ({
          ...file,
          optional: true,
          ok:
            state.present.has(file.name.toLowerCase()) ||
            (file.directory !== undefined && [...state.present].some((name) => name.startsWith(file.directory!))),
        })),
      ]
    : [];
  return (
    <section className="panel game-folder-panel message-box game-source-picker" aria-labelledby="source-picker-title">
      <input ref={props.archiveRef} type="file" accept=".zip,.exe,.rar,.7z" hidden onChange={props.archiveChanged} />
      <input ref={props.folderRef} type="file" {...{ webkitdirectory: '' }} hidden onChange={props.folderChanged} />
      <header className="source-picker-heading">
        <span className="source-picker-brand">{t('RA2 VM · 红色警戒')}</span>
        <h3 id="source-picker-title">{props.games.length > 1 ? t('选择要启动的游戏') : t('选择游戏资源')}</h3>
        <p className="source-picker-description" role="status">
          {localizeText(props.description)}
        </p>
      </header>
      <div className="network-settings">
        <label className="network-toggle">
          <input
            type="checkbox"
            checked={networkEnabled}
            disabled={props.busy}
            onChange={(event) => toggleNetwork(event.currentTarget.checked)}
          />
          {t('联机')}{' '}
        </label>
        {networkEnabled && (
          <div className="relay-settings">
            <label htmlFor="relay-address">{t('联机 relay 地址（可选）')}</label>
            <input
              id="relay-address"
              type="text"
              value={relay}
              disabled={props.busy}
              placeholder="127.0.0.1:15176"
              spellCheck={false}
              autoCapitalize="none"
              aria-invalid={!!relayError}
              aria-describedby="relay-address-help"
              onChange={(event) => updateRelay(event.currentTarget.value)}
            />
            <small id="relay-address-help">
              {t(
                '留空使用默认服务；只需填写主机和端口，默认房间 /ra2；内网 IP 使用 WS，其他地址使用 WSS。联机玩家填写相同地址；刷新保留设置。',
              )}{' '}
            </small>
            {relayError && <p role="alert">{localizeText(relayError)}</p>}
          </div>
        )}
      </div>
      <div className="manifest-checklist" hidden={!state}>
        {entries.map((entry) => (
          <div
            key={entry.name}
            className={`manifest-line ${entry.ok ? 'ok' : 'missing'}${entry.optional ? ' optional' : ''}`}
          >
            {entry.ok ? '✓' : '✗'} {entry.name} — {localizeLabel(entry.note)}
            {entry.optional && !entry.ok ? t('（可选，不影响启动）') : ''}
          </div>
        ))}
        {state?.complete && <div className="manifest-line ok">{t('✓ 必需文件已集齐，正在启动…')}</div>}
      </div>
      <p className="source-picker-error" role="alert" hidden={!props.error}>
        {localizeText(props.error)}
      </p>
      <div className="resource-actions">
        <button className="dialog-button" disabled={props.busy || !!relayError} onClick={() => props.pick('archive')}>
          {t('选择文件…')}{' '}
        </button>
        <button className="dialog-button" disabled={props.busy || !!relayError} onClick={() => props.pick('folder')}>
          {t('选择文件夹…')}{' '}
        </button>
      </div>
      {props.games.length > 1 && (
        <div className="detected-games" aria-label={t('选择检测到的游戏')}>
          {SUPPORTED_GAMES.filter((game) => props.games.includes(game.id)).map((game) => (
            <button
              key={game.id}
              className="dialog-button"
              disabled={props.busy || !!relayError}
              onClick={() => void props.chooseGame(game.id)}
            >
              {localizeLabel(game.title)}
            </button>
          ))}
        </div>
      )}
      {import.meta.env.DEV && (
        <div className="development-sources">
          <button
            className="dialog-button development-source"
            disabled={props.busy || !!relayError}
            onClick={() => props.pick('development')}
          >
            {t('开发测试')}{' '}
          </button>
        </div>
      )}
      <p className="disclaimer">
        {t(
          '免责声明：个人非商业粉丝项目，EA 未认可也不支持本产品（EA has not endorsed and does not support this product）。本页面不提供任何游戏文件，请只使用你合法拥有的游戏安装。',
        )}
      </p>
    </section>
  );
}
