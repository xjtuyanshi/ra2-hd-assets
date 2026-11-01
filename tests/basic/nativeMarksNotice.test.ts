import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, expect, it, vi } from 'vitest';
import { NativeMarksNotice } from '../../src/ui/pages/game/components/NativeMarksNotice';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

it('explains the experimental owner opt-in and how to stop and launch without it', () => {
  vi.stubEnv('DEV', true);
  vi.stubGlobal('window', { location: { search: '?backend=native&native-draw-journal=1' } });
  const notice = renderToStaticMarkup(createElement(NativeMarksNotice));
  expect(notice).toContain('高清血条和编队数字为实验功能');
  expect(notice).toContain('在启动器按 Ctrl-C 退出');
  expect(notice).toContain('重新启动时不加 --hd-marks');
});

it.each(['?backend=native', '?backend=native&native-draw-journal=0', '?native-draw-journal=1'])(
  'omits the notice when native marks are not enabled: %s',
  (search) => {
    vi.stubEnv('DEV', true);
    vi.stubGlobal('window', { location: { search } });
    expect(renderToStaticMarkup(createElement(NativeMarksNotice))).toBe('');
  },
);

it('omits the development notice in production', () => {
  vi.stubEnv('DEV', false);
  expect(renderToStaticMarkup(createElement(NativeMarksNotice))).toBe('');
});
