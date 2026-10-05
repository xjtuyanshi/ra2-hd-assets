import { afterEach, describe, expect, it, vi } from 'vitest';
import { LiveLibrary } from '../src/live/library';
import type { Ra2Cache } from '../src/ra2/cache';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** A library of five voxel models whose files arrive only when the test says so. */
async function library() {
  const voxels = Object.fromEntries(['A', 'B', 'C', 'D', 'E'].map((id) => [id, `voxels/${id}.json`]));
  const waiting = new Map<string, (response: Response) => void>();
  const fetcher = vi.fn((url: string) => {
    if (url.endsWith('/library.json')) return Promise.resolve(Response.json({ palettes: {}, voxels, types: {} }));
    const id = /voxels\/(\w+)\.json$/.exec(url)?.[1];
    if (!id) return Promise.resolve(new Response(null, { status: 404 }));
    return new Promise<Response>((resolve) => waiting.set(id, resolve));
  });
  vi.stubGlobal('fetch', fetcher);
  const lib = (await LiveLibrary.load('/library/', {} as Ra2Cache))!;
  const requested = () =>
    fetcher.mock.calls.map(([url]) => /voxels\/(\w+)\.json$/.exec(url)?.[1]).filter((id): id is string => !!id);
  const arrive = async (id: string, ok = true) => {
    waiting.get(id)!(
      ok ? Response.json({ id, palette: 'unit', normalsMode: 4, parts: [] }) : new Response(null, { status: 500 }),
    );
    waiting.delete(id);
    // fetch -> json -> settle
    for (let turn = 0; turn < 6; turn++) await Promise.resolve();
  };
  return { lib, requested, arrive };
}

describe('voxel model files fetched ahead of their first use', () => {
  it('requests every model a few at a time, silently: nothing counts as loading and no revision changes', async () => {
    const { lib, requested, arrive } = await library();
    expect(lib.preloadVoxels(2)).toBe(false);
    expect(requested()).toEqual(['A', 'B']);
    // Asked again before anything arrived: no more in flight than allowed.
    expect(lib.preloadVoxels(2)).toBe(false);
    expect(requested()).toEqual(['A', 'B']);
    expect(lib.loading).toBe(0);
    const revision = lib.revision;
    await arrive('A');
    expect(lib.revision).toBe(revision);
    expect(lib.loading).toBe(0);
    expect(lib.preloadVoxels(2)).toBe(false);
    expect(requested()).toEqual(['A', 'B', 'C']);
    await arrive('B');
    await arrive('C');
    // D and E are requested now: nothing is left to ask for.
    expect(lib.preloadVoxels(2)).toBe(true);
    expect(requested()).toEqual(['A', 'B', 'C', 'D', 'E']);
    expect(lib.preloadVoxels(2)).toBe(true);
    expect(requested()).toHaveLength(5);
    // A unit of a kind that has not appeared before finds its model in its first frame.
    expect(lib.voxel('A')).toMatchObject({ id: 'A' });
    expect(lib.revision).toBe(revision);
    expect(requested()).toHaveLength(5);
  });

  it('turns a model that is asked for while it is fetched ahead into art on its way', async () => {
    const { lib, requested, arrive } = await library();
    lib.preloadVoxels(1);
    expect(requested()).toEqual(['A']);
    expect(lib.voxel('A')).toBeNull();
    expect(lib.loading).toBe(1);
    // Still one request: the fetch under way is the one that answers.
    expect(requested()).toEqual(['A']);
    const revision = lib.revision;
    await arrive('A');
    expect(lib.revision).toBe(revision + 1);
    expect(lib.loading).toBe(0);
    expect(lib.voxel('A')).toMatchObject({ id: 'A' });
  });

  it('still loads a model on first use when it has not been fetched ahead', async () => {
    const { lib, requested, arrive } = await library();
    expect(lib.voxel('D')).toBeNull();
    expect(requested()).toEqual(['D']);
    expect(lib.loading).toBe(1);
    const revision = lib.revision;
    // Fetching ahead skips what was already asked for.
    lib.preloadVoxels(4);
    expect(requested()).toEqual(['D', 'A', 'B', 'C', 'E']);
    await arrive('D');
    expect(lib.revision).toBe(revision + 1);
    expect(lib.voxel('D')).toMatchObject({ id: 'D' });
  });

  it('records a file that fails ahead as failed, silently, and does not retry it', async () => {
    const { lib, requested, arrive } = await library();
    lib.preloadVoxels(1);
    const revision = lib.revision;
    await arrive('A', false);
    expect(lib.voxelFailed('A')).toBe(true);
    expect(lib.revision).toBe(revision);
    expect(lib.voxel('A')).toBeNull();
    expect(lib.loading).toBe(0);
    expect(requested()).toEqual(['A']);
    // The failure of a model something waits for is news, as before.
    expect(lib.voxel('B')).toBeNull();
    await arrive('B', false);
    expect(lib.voxelFailed('B')).toBe(true);
    expect(lib.revision).toBe(revision + 1);
  });
});
