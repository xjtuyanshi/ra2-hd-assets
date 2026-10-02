import { DataTexture } from 'three/webgpu';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EffectArt, PAGE_RETRY_SECONDS } from '../src/live/effectArt';
import { loadIndexedPage } from '../src/live/library';
import type { Ra2Cache } from '../src/ra2/cache';

vi.mock('../src/live/library', () => ({ LIBRARY_PALETTE_PREFIX: 'lib:', loadIndexedPage: vi.fn() }));

const library = {
  palettes: {},
  spriteAtlases: [{ file: 'page.png', width: 64, height: 32 }],
  voxels: { debris: 'debris.json' },
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.mocked(loadIndexedPage).mockReset();
});

const art = () => new EffectArt('/synthetic', {} as Ra2Cache, 'temperate', true);

describe('effect art asynchronous revisions', () => {
  it('settles failed pages once and keeps the bounded retry policy without requesting every presentation frame', async () => {
    const now = vi.spyOn(performance, 'now').mockReturnValue(1000);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => library }));
    vi.mocked(loadIndexedPage).mockRejectedValue(new Error('missing synthetic page'));
    const source = art();
    await source.load();
    expect(source.revision).toBe(1);
    expect(source.pageState(0)).toBe('loading');
    await vi.waitFor(() => expect(source.revision).toBe(2));
    for (let i = 0; i < 144; i++) expect(source.pageState(0)).toBeNull();
    expect(loadIndexedPage).toHaveBeenCalledTimes(1);
    expect(source.revision).toBe(2);
    now.mockReturnValue(1000 + (PAGE_RETRY_SECONDS + 1) * 1000);
    expect(source.pageState(0)).toBe('loading');
    await vi.waitFor(() => expect(source.revision).toBe(3));
    expect(loadIndexedPage).toHaveBeenCalledTimes(2);
  });

  it('reuses loaded descriptors and signals voxel readiness as well as page readiness', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (url: string) => ({
        ok: true,
        json: async () => (url.endsWith('effects.json') ? library : { sections: [] }),
      })),
    );
    const texture = new DataTexture();
    vi.mocked(loadIndexedPage).mockResolvedValue(texture);
    const source = art();
    await source.load();
    expect(source.pageState(0)).toBe('loading');
    await vi.waitFor(() => expect(source.revision).toBe(2));
    const page = source.pageState(0);
    expect(page).toEqual({ texture, width: 64, height: 32 });
    expect(source.pageState(0)).toBe(page);
    expect(source.voxel('debris')).toBeNull();
    await vi.waitFor(() => expect(source.revision).toBe(3));
    expect(source.voxel('debris')).toEqual({ sections: [] });
    expect(source.revision).toBe(3);
  });
});
