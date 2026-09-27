import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sha256Hex } from '../../src/utils/sha256';
import { SessionGameFileProvider } from '../../src/platform/browser/files/sessionFiles';
import type { GameManifest } from '../../src/games/manifest';

const pinnedBytes = new Uint8Array([1, 2, 3]);
async function manifest(): Promise<GameManifest> {
  return {
    gameId: 'yr',
    thirdParty: [{ name: 'gamemd.exe', sha256: await sha256Hex(pinnedBytes) }],
    playerRequired: [],
    playerOptional: [],
  };
}
const player = (bytes?: Uint8Array) =>
  new SessionGameFileProvider('player', new Map(bytes ? [['gamemd.exe', bytes]] : []));

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv('DEV', false);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('player-supplied executables', () => {
  it('uses the player executable and reports a pinned build', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const { loadThirdPartyFiles } = await import('../../src/adapter/thirdPartyFiles');
    const source = pinnedBytes.slice();
    const resolved = await loadThirdPartyFiles(await manifest(), player(source));
    expect(resolved.missing).toEqual([]);
    expect(resolved.checks).toEqual([
      { name: 'gamemd.exe', sha256: await sha256Hex(pinnedBytes), pinned: true, source: 'player' },
    ]);
    const bytes = resolved.files.get('gamemd.exe')!;
    expect(bytes).toEqual(pinnedBytes);
    bytes[0] = 99;
    expect(source[0]).toBe(1);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('keeps a different build but reports it as unpinned', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { loadThirdPartyFiles } = await import('../../src/adapter/thirdPartyFiles');
    const other = new Uint8Array([7, 7, 7]);
    const resolved = await loadThirdPartyFiles(await manifest(), player(other));
    expect(resolved.files.get('gamemd.exe')).toEqual(other);
    expect(resolved.checks[0]).toMatchObject({ pinned: false, sha256: await sha256Hex(other) });
    expect(warn).toHaveBeenCalled();
  });

  it('never downloads in production: a missing executable is reported as missing', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const { loadThirdPartyFiles } = await import('../../src/adapter/thirdPartyFiles');
    const resolved = await loadThirdPartyFiles(await manifest(), player());
    expect(resolved).toEqual({ files: new Map(), checks: [], missing: ['gamemd.exe'] });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('development falls back only to the local /__third-party cache', async () => {
    vi.stubEnv('DEV', true);
    const fetch = vi.fn(async () => new Response(pinnedBytes.slice(), { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    const { loadThirdPartyFiles } = await import('../../src/adapter/thirdPartyFiles');
    const resolved = await loadThirdPartyFiles(await manifest(), null);
    expect(fetch).toHaveBeenCalledWith('/__third-party/gamemd.exe', { cache: 'no-store' });
    expect(resolved.checks[0]).toMatchObject({ pinned: true, source: 'development-cache' });
  });

  it('development cache 404 leaves the executable missing', async () => {
    vi.stubEnv('DEV', true);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('', { status: 404 })),
    );
    const { loadThirdPartyFiles } = await import('../../src/adapter/thirdPartyFiles');
    const resolved = await loadThirdPartyFiles(await manifest(), player());
    expect(resolved.missing).toEqual(['gamemd.exe']);
  });
});
