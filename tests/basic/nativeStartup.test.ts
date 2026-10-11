import { afterEach, describe, expect, it, vi } from 'vitest';
import { desktopPointerLock, nativeAutoStart, prepareNativeViewport } from '../../src/ui/pages/game/nativeStartup';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function viewportFixture() {
  const search = '?backend=native&native-autostart=yr&native-viewport=1&agent-token=test';
  vi.stubGlobal('window', { location: { search, href: `http://127.0.0.1:15451/${search}` },
    innerWidth: 1728, innerHeight: 1117, devicePixelRatio: 2, setTimeout, clearTimeout });
  vi.stubGlobal('document', { fullscreenElement: null });
  let at = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => (at += 400));
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  const canvas = { closest: () => ({ getBoundingClientRect: () => ({ width: 1728, height: 1117 }) }) } as unknown as HTMLCanvasElement;
  return { fetch, canvas };
}

describe('native launcher startup', () => {
  it('requires explicit native launcher intent in development', () => {
    expect(nativeAutoStart('?backend=native&native-autostart=yr', true)).toBe('yr');
    expect(nativeAutoStart('?backend=native&native-autostart=yr', false)).toBeNull();
    expect(nativeAutoStart('?backend=native', true)).toBeNull();
    expect(nativeAutoStart('?native-autostart=yr', true)).toBeNull();
    expect(nativeAutoStart('?backend=native&native-autostart=ra2', true)).toBeNull();
  });
  it('keeps absolute native presses and the established emulator default', () => {
    expect(desktopPointerLock('', 'native')).toBe(false);
    expect(desktopPointerLock('', 'v86')).toBe(true);
    expect(desktopPointerLock('?mouse-lock=1', 'native')).toBe(true);
    expect(desktopPointerLock('?mouse-lock=0', 'v86')).toBe(false);
  });
  it('continues the startup wait after a transient viewport poll failure', async () => {
    const { fetch, canvas } = viewportFixture();
    fetch.mockResolvedValueOnce(Response.json({ ready: false }))
      .mockResolvedValueOnce(Response.json({ ready: false }))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(Response.json({ ready: true, resolution: { width: 1728, height: 1117 } }));
    await expect(prepareNativeViewport(canvas)).resolves.toEqual({ width: 1728, height: 1117 });
    expect(fetch).toHaveBeenCalledTimes(4);
  });
  it('ignores an unavailable session poll but respects an explicit stopped launcher', async () => {
    const { fetch, canvas } = viewportFixture();
    fetch.mockResolvedValueOnce(Response.json({ ready: false }))
      .mockResolvedValueOnce(Response.json({ ready: false }))
      .mockResolvedValueOnce(Response.json({ ready: false }))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(Response.json({ ready: false }))
      .mockResolvedValueOnce(Response.json({ state: 'closed' }));
    await expect(prepareNativeViewport(canvas)).rejects.toThrow('游戏启动已停止');
    expect(fetch).toHaveBeenCalledTimes(6);
  });
});
