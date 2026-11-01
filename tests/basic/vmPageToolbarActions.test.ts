import { afterEach, describe, expect, it, vi } from 'vitest';
import { createVmPageToolbarActions, type VmPageToolbarActionDeps } from '../../src/ui/pages/game/vmPageToolbarActions';

afterEach(() => vi.unstubAllGlobals());

function stubPage(search: string): { values: Map<string, string>; href: () => string } {
  const values = new Map<string, string>();
  let href = `http://127.0.0.1:15451/${search}`;
  vi.stubGlobal('window', {
    get location() {
      const url = new URL(href);
      return { href, search: url.search };
    },
    history: {
      state: null,
      replaceState: (_state: unknown, _title: string, url: URL) => {
        href = url.href;
      },
    },
    localStorage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => void values.set(key, value),
      removeItem: (key: string) => void values.delete(key),
    },
  });
  return { values, href: () => href };
}

function actions(overrides: Partial<VmPageToolbarActionDeps>) {
  return createVmPageToolbarActions({
    getSelectedGameId: () => 'yr',
    setRequestedResolution: vi.fn(),
    onRestartForResolution: vi.fn(async () => {}),
    ...overrides,
  } as unknown as VmPageToolbarActionDeps);
}

describe('toolbar view choice', () => {
  it('native route hands the choice to the in-menu restart, which owns remembering it', async () => {
    const page = stubPage('?backend=native&native-viewport=1&resolution=wide');
    const onNativeViewChange = vi.fn(async () => {});
    const onRestartForResolution = vi.fn(async () => {});
    await actions({ onNativeViewChange, onRestartForResolution }).onResolution('moderate');
    expect(onNativeViewChange).toHaveBeenCalledWith('moderate');
    expect(onRestartForResolution).not.toHaveBeenCalled();
    // Remembering the choice and dropping the launch address belong to the accepted in-menu restart.
    expect(new URL(page.href()).searchParams.get('resolution')).toBe('wide');
    expect(page.values.has('vm-resolution-yr')).toBe(false);
  });

  it('native route passes a refusal (a match in progress) through without remembering the choice', async () => {
    const page = stubPage('?backend=native&native-viewport=1');
    const onNativeViewChange = vi.fn(async () => {
      throw new Error('对局中不能切换视野。');
    });
    await expect(actions({ onNativeViewChange }).onResolution('classic')).rejects.toThrow(/对局中/);
    expect(page.values.has('vm-resolution-yr')).toBe(false);
  });

  it('native route keeps a fixed launch size in the address when the change is refused', async () => {
    const page = stubPage('?backend=native&resolution=1280x720');
    const onNativeViewChange = vi.fn(async () => {
      throw new Error('本次启动指定了固定画面大小。');
    });
    await expect(actions({ onNativeViewChange }).onResolution('moderate')).rejects.toThrow(/固定画面/);
    expect(new URL(page.href()).searchParams.get('resolution')).toBe('1280x720');
  });

  it('native route before the main menu is ready refuses without claiming the view was saved', async () => {
    stubPage('?backend=native&native-viewport=1');
    await expect(actions({}).onResolution('moderate')).rejects.toThrow(/still starting|还在启动/);
  });

  it('the web route remembers the choice and reloads the session', async () => {
    const page = stubPage('?hd=1');
    const onRestartForResolution = vi.fn(async () => {});
    const setRequestedResolution = vi.fn();
    await actions({ onRestartForResolution, setRequestedResolution }).onResolution('1280x720');
    expect(page.values.get('vm-resolution-yr')).toBe('1280x720');
    expect(setRequestedResolution).toHaveBeenCalledWith({ width: 1280, height: 720 });
    expect(onRestartForResolution).toHaveBeenCalledOnce();
  });
});
