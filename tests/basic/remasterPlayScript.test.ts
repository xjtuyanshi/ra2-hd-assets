import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DISPLAY_RESOLUTION, parseResolutionChoice } from '../../src/ui/pages/game/vmPageResolution';
import { parseGameSpeed } from '../../src/games/gameSpeed';

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
      'game-speed': '3',
      'start-page': 'skirmish',
    });
    // The page must understand the speed the launcher sends: 3 is the original scale's normal speed.
    expect(parseGameSpeed(url.searchParams.get('game-speed'))).toBe(3);
    // The page must understand the resolution value the launcher sends.
    expect(parseResolutionChoice(url.searchParams.get('resolution'), true)).toBe(DISPLAY_RESOLUTION);
  });

  it('opens the original picture at exact pixels, at the main menu, on request', () => {
    const url = address(['--original', '--menu']);
    expect(Object.fromEntries(url.searchParams)).toEqual({ resolution: 'display', 'game-speed': '3' });
  });

  it('starts at another speed, or at the page default, on request and rejects anything else', () => {
    expect(address([], { RA2_PLAY_SPEED: '0' }).searchParams.get('game-speed')).toBe('0');
    expect(address([], { RA2_PLAY_SPEED: 'default' }).searchParams.has('game-speed')).toBe(false);
    expect(() =>
      execFileSync('bash', [script, '--print'], { stdio: 'pipe', env: { ...process.env, RA2_PLAY_SPEED: '9' } }),
    ).toThrow();
  });

  it('names the stall log for the development server, next to the play tools unless told otherwise or off', () => {
    // --print starts nothing, so the server's environment is read from the script itself.
    const text = readFileSync(script, 'utf8');
    expect(text).toContain('perf="${RA2_PERF_LOG:-$main/gameres/s2x/play/perfmon/stalls.jsonl}"');
    expect(text).toContain('[ "$perf" = 0 ] && perf=""');
    const server = text.split('\n').find((line) => line.includes('exec node_modules/.bin/vite'))!;
    expect(server).toContain('RA2_PERF_LOG="$perf"');
    // The address is the same with or without a log.
    expect(address([], { RA2_PERF_LOG: '0' }).href).toBe(address([]).href);
  });

  it('rejects an unknown option', () => {
    expect(() => execFileSync('bash', [script, '--nope'], { stdio: 'pipe' })).toThrow();
  });
});
