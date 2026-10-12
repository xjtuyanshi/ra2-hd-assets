import { afterEach, describe, expect, it, vi } from 'vitest';
import { installRuntimeToolbar, type RuntimeToolbarCallbacks } from '../../src/ui/pages/game/runtimeToolbar';
import { toolbarState } from '../../src/ui/pages/game/state/uiState';
import { createTranslator } from '../../src/ui/shared/i18n/translate';

afterEach(() => {
  vi.unstubAllGlobals();
});

/** The toolbar controller without a page: its timer and storage are the only browser pieces it touches. */
function toolbar() {
  vi.stubGlobal('window', { setInterval: () => 1, clearInterval: () => undefined });
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => undefined });
  const callbacks = { onClockRate: vi.fn(), onPerformance: vi.fn() } as unknown as RuntimeToolbarCallbacks;
  const bar = installRuntimeToolbar(callbacks, {} as HTMLCanvasElement, 'WebGL2', 'test renderer');
  const published = vi.fn();
  const unsubscribe = toolbarState.subscribe(published);
  const stalls = () => toolbarState.getSnapshot()?.model.stalls;
  return { bar, published, stalls, end: () => (unsubscribe(), bar.destroy()) };
}

describe('toolbar line for the stalls of the current match', () => {
  it('publishes a resize notice independently of the collapsed controls and clears it on restoration', () => {
    const t = toolbar();
    Object.assign(window, { location: { search: '?backend=native' } });
    const matched = { width: 1728, height: 1116 };
    t.bar.setDisplayScale(1728, 1116, 2, 2, matched, 2, true);
    expect(toolbarState.getSnapshot()?.model.viewportNotice).toMatch(
      /可在菜单按新窗口大小重新启动|Restart at its new size from a menu/,
    );
    t.bar.setDisplayScale(1728, 1116, 2, 2, matched, 2, false);
    expect(toolbarState.getSnapshot()?.model.viewportNotice).toBe('');
    t.end();
  });

  it('says how many and how long the longest was, in the catalog wording of both languages', () => {
    expect(createTranslator('zh-CN')('卡顿 {0} 次，最长 {1} 秒', 3, '1.7')).toBe('卡顿 3 次，最长 1.7 秒');
    expect(createTranslator('en')('卡顿 {0} 次，最长 {1} 秒', 3, '1.7')).toBe('Stalls: 3, longest 1.7 s');
  });

  it('is empty until the match has stalled, shows count and longest gap in seconds, and clears for a new match', () => {
    const t = toolbar();
    expect(t.stalls()).toBe('');
    t.bar.setStalls(1, 151);
    // 151 ms is 0.2 s to one decimal.
    expect(t.stalls()).toMatch(/1\D+0\.2/);
    t.bar.setStalls(3, 1730);
    expect(t.stalls()).toMatch(/3\D+1\.7/);
    // The page's own language decides which of the two catalog wordings it is.
    expect(
      [createTranslator('zh-CN'), createTranslator('en')].map((translate) =>
        translate('卡顿 {0} 次，最长 {1} 秒', 3, '1.7'),
      ),
    ).toContain(t.stalls());
    t.bar.setStalls(0, 0);
    expect(t.stalls()).toBe('');
    t.end();
  });

  it('tells the view only when the line changes', () => {
    const t = toolbar();
    t.published.mockClear();
    t.bar.setStalls(0, 0);
    expect(t.published).not.toHaveBeenCalled();
    t.bar.setStalls(2, 400);
    t.bar.setStalls(2, 400);
    // A longer stall that rounds to the same tenth is the same line.
    t.bar.setStalls(2, 430);
    expect(t.published).toHaveBeenCalledTimes(1);
    t.bar.setStalls(3, 430);
    expect(t.published).toHaveBeenCalledTimes(2);
    t.end();
  });
});
