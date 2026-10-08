import { describe, expect, it } from 'vitest';
import { desktopPointerLock, nativeAutoStart } from '../../src/ui/pages/game/nativeStartup';

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
});
