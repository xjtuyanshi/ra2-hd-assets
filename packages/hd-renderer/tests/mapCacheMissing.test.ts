import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadRa2Cache, MapCacheMissingError } from '../src/ra2/cache';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('loadRa2Cache without a map cache', () => {
  it('a missing manifest.json is a MapCacheMissingError, not a JSON parse error', async () => {
    const fetchFile = vi.fn(async (_url: string) => new Response('not found', { status: 404 }));
    vi.stubGlobal('fetch', fetchFile);
    const failure = await loadRa2Cache('/hd-cache/NOCACHE/').catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(MapCacheMissingError);
    expect((failure as Error).name).toBe('MapCacheMissingError');
    expect((failure as Error).message).toContain('/hd-cache/NOCACHE');
    // Nothing else of the map is requested once its manifest is known to be absent.
    expect(fetchFile.mock.calls.map(([url]) => url)).toEqual(['/hd-cache/NOCACHE/manifest.json']);
  });

  it('a server that answers unknown paths with its HTML page counts as missing too', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('<!doctype html>', { status: 200, headers: { 'content-type': 'text/html' } })),
    );
    await expect(loadRa2Cache('/hd-cache/NOCACHE')).rejects.toBeInstanceOf(MapCacheMissingError);
  });

  it('a manifest that exists but cannot be served is a load failure, not a missing map', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('boom', { status: 500 })),
    );
    const failure = await loadRa2Cache('/hd-cache/BROKEN').catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(MapCacheMissingError);
    expect((failure as Error).message).toContain('HTTP 500');
  });
});
