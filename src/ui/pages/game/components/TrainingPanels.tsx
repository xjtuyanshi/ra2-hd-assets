import { t, localizeText } from '../../../shared/i18n/translate';
import { useState } from 'react';
import { useStore } from '../../../shared/state/useStore';
import type { GameHotkeySheet } from '../../../../games/hotkeys';
import * as state from '../state/uiState';
import './TrainingPanels.css';

const applePlatform = () =>
  typeof navigator !== 'undefined' &&
  /(?:Macintosh|MacIntel|iPhone|iPad|iPod)/i.test(`${navigator.platform} ${navigator.userAgent}`);

/** Give the keyboard back to the game after a click on one of the overlay's own controls. */
const refocusGame = () => state.gameFocus.getSnapshot()?.();

const seconds = (ms: number) => {
  const total = Math.floor(ms / 1000);
  return total >= 60 ? t('{0} 分 {1} 秒', Math.floor(total / 60), total % 60) : t('{0} 秒', total);
};

/**
 * Cheat sheet over the game picture. The sheet itself lets every pointer event through to the game (pointer-events:
 * none) and holds nothing focusable except its close control, so keys keep reaching the game while it is open.
 */
export function HotkeySheetOverlay({ sheet, close }: { sheet: GameHotkeySheet; close(): void }) {
  const mac = applePlatform();
  return (
    <aside id="hotkey-sheet" aria-label={t('快捷键')}>
      <header>
        <strong>{t('快捷键')}</strong>
        <button
          id="hotkey-sheet-close"
          type="button"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            close();
            refocusGame();
          }}
        >
          {t('关闭')}
        </button>
      </header>
      <div className="hotkey-groups">
        {sheet.groups.map((group) => (
          <section key={group.title}>
            <h4>{localizeText(group.title)}</h4>
            <table>
              <tbody>
                {group.rows.map((row) => (
                  <tr key={row.keys}>
                    <th scope="row">{localizeText((mac && row.macKeys) || row.keys)}</th>
                    <td>
                      {localizeText(row.action)}
                      <small>{localizeText(row.tip)}</small>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        ))}
      </div>
      <ul className="hotkey-notes">
        {sheet.notes.map((note) => (
          <li key={note}>{localizeText(note)}</li>
        ))}
      </ul>
    </aside>
  );
}

/** Lesson list (practice mode before a lesson is chosen). */
export function TrainingMenu({ lessons }: { lessons: state.TrainingMenuState['lessons'] }) {
  return (
    <section id="training-menu" className="panel" aria-labelledby="training-menu-title">
      <h3 id="training-menu-title">{t('操作训练')}</h3>
      <p>{t('选一课开始。每一课都会自己检查你的按键和游戏里的结果，做对一步进下一步；卡住时会给提示。')}</p>
      <ol>
        {lessons.map((lesson) => (
          <li key={lesson.id}>
            <a className="training-lesson-link" href={lesson.href}>
              <strong>{localizeText(lesson.title)}</strong>
              <span>{localizeText(lesson.summary)}</span>
            </a>
          </li>
        ))}
      </ol>
      <p className="training-menu-note">
        {t(
          '先把浏览器窗口最大化或全屏，再点课程。进入游戏后按一次 Esc 跳过片头；训练中想看全部按键，点左侧工具栏的“快捷键”。',
        )}
      </p>
    </section>
  );
}

/** Coach panel over the game picture: the task list while practising, the summary at the end. */
export function CoachPanel({ panel }: { panel: state.TrainingLessonState }) {
  const [collapsed, setCollapsed] = useState(false);
  // The page toolbar lies over the left edge of the picture while it is open (never in fullscreen).
  const toolbarOpen = !useStore(state.controlsCollapsed);
  const { view } = panel;
  const done = view.phase === 'done';
  const active = view.tasks[view.taskIndex];
  return (
    <aside
      id="coach-panel"
      data-phase={view.phase}
      data-toolbar={toolbarOpen ? 'open' : 'closed'}
      aria-label={t('训练教练')}
    >
      <header>
        <strong>{localizeText(view.title)}</strong>
        <span className="coach-progress">
          {Math.min(view.taskIndex + (done ? 0 : 1), view.tasks.length)}/{view.tasks.length}
        </span>
        <button
          type="button"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            setCollapsed(!collapsed);
            refocusGame();
          }}
        >
          {collapsed ? t('展开') : t('收起')}
        </button>
      </header>
      {view.phase === 'waiting' && <p className="coach-wait">{panel.note ?? t('正在准备场景…进入战场后开始计时。')}</p>}
      {!collapsed && view.phase !== 'waiting' && (
        <ol className="coach-tasks">
          {view.tasks.map((task) => (
            <li key={task.id} data-status={task.status}>
              <span className="coach-task-title">
                {task.status === 'done' ? '✓ ' : ''}
                {localizeText(task.title)}
                {task.status !== 'pending' && <em>{seconds(task.elapsedMs)}</em>}
              </span>
              {task.status === 'active' && <p>{localizeText(task.instruction)}</p>}
              {task.status === 'active' && task.hintVisible && (
                <p className="coach-hint">
                  {t('提示：')}
                  {localizeText(task.hint)}
                </p>
              )}
            </li>
          ))}
        </ol>
      )}
      {collapsed && active && !done && <p className="coach-wait">{localizeText(active.instruction)}</p>}
      {done && (
        <section className="coach-summary">
          <p>
            <strong>{t('本课完成，用时 {0}。', seconds(view.totalMs))}</strong>
          </p>
          {view.hotkeysUsed.length > 0 && (
            <p>
              {t('用到的操作：')}
              {view.hotkeysUsed.map((label) => localizeText(label)).join('、')}
            </p>
          )}
          {view.hotkeysUnused.length > 0 && (
            <p className="coach-unused">
              {t('这次没用到：')}
              {view.hotkeysUnused.map((label) => localizeText(label)).join('、')}
            </p>
          )}
        </section>
      )}
      <nav>
        <a href={panel.restartHref}>{t('重新开始')}</a>
        {panel.nextHref && <a href={panel.nextHref}>{t('下一课')}</a>}
        <a href={panel.menuHref}>{t('课程列表')}</a>
      </nav>
    </aside>
  );
}

/** Everything practice-related that is drawn over the game picture (inside the fullscreen frame). */
export function GameOverlays() {
  const sheet = useStore(state.hotkeySheet);
  const sheetVisible = useStore(state.hotkeySheetVisible);
  const training = useStore(state.trainingPanel);
  return (
    <>
      {training?.mode === 'lesson' && <CoachPanel panel={training} />}
      {sheet && sheetVisible && <HotkeySheetOverlay sheet={sheet} close={() => state.hotkeySheetVisible.set(false)} />}
    </>
  );
}
