import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DISPLAY_RESOLUTION, parseResolutionChoice } from '../../src/ui/pages/game/vmPageResolution';

const script = fileURLToPath(new URL('../../scripts/remaster/play.sh', import.meta.url));
/** The address the launcher would open; --print starts nothing and needs neither game files nor an HD cache. */
const address = (args: string[], env: Record<string, string> = {}) =>
  new URL(
    execFileSync('bash', [script, ...args, '--print'], { encoding: 'utf8', env: { ...process.env, ...env } }).trim(),
  );

describe.skipIf(process.platform === 'win32')('scripts/remaster/play.sh', () => {
  it('opens the HD page with the approved look, the display-matched resolution and the skirmish setup', () => {
    const url = address([], { RA2_PLAY_PORT: '15999' });
    expect(url.origin).toBe('http://localhost:15999');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      hd: '1',
      'hd-look': 'cinematic',
      'hd-fx': 'enhanced',
      'hd-water': 'enhanced',
      'hd-vlook': 'remaster',
      'hd-vproj': 'vehicles-hd',
      'hd-ui': '1',
      resolution: 'display',
      'start-page': 'skirmish',
    });
    // The page must understand the resolution value the launcher sends.
    expect(parseResolutionChoice(url.searchParams.get('resolution'), true)).toBe(DISPLAY_RESOLUTION);
  });

  it('opens the original picture at exact pixels, at the main menu, on request', () => {
    const url = address(['--original', '--menu']);
    expect(Object.fromEntries(url.searchParams)).toEqual({ resolution: 'display' });
  });

  it('rejects an unknown option', () => {
    expect(() => execFileSync('bash', [script, '--nope'], { stdio: 'pipe' })).toThrow();
  });
});
