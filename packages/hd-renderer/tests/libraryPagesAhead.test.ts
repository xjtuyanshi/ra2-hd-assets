import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Texture } from 'three/webgpu';
import type { LibraryType } from '../../ra2-assets/src/library';
import { LiveLibrary } from '../src/live/library';
import { PageGate, type PageUpload } from '../src/pageUpload';
import type { Ra2Cache } from '../src/ra2/cache';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const frame = (page: number, width = 10) => ({ rect: [0, 0, width, 10], offset: [0, 0], page });

/** A library of four atlas pages (page 3 has no HD art) whose files arrive only when the test says so. */
async function library() {
  const types: Record<string, LibraryType> = {
    // Build-up on page 0, body on page 1, a layer (and its damaged variant) on page 2; shadows on page 3.
    YARD: {
      kind: 'building',
      image: 'YARD',
      sprite: 'building:YARD',
      drawOffset: [0, -15],
      lighting: 'ambient',
      remap: true,
      atlasPages: [1],
      building: {
        bodyFrames: 2,
        buildup: 'anim:YARDMK',
        bib: 'bib:YARD',
        layers: [{ key: 'ActiveAnim', sprite: 'anim:YARD_A', damagedSprite: 'anim:YARD_AD', anim: {} }],
      },
    },
    TANK: { kind: 'vehicle', image: 'TANK', voxel: 'TANK', drawOffset: [0, 0], lighting: 'ambient', remap: true },
  };
  const sprites = {
    'building:YARD': { frames: [frame(1), frame(1)], shadows: [frame(3)], canvas: [1, 1], palette: 'unit' },
    'anim:YARDMK': { frames: [frame(0), frame(0)], canvas: [1, 1], palette: 'unit' },
    // An empty frame names a page it does not use.
    'bib:YARD': { frames: [frame(1), frame(2, 0)], canvas: [1, 1], palette: 'unit' },
    'anim:YARD_A': { frames: [frame(1)], canvas: [1, 1], palette: 'unit' },
    'anim:YARD_AD': { frames: [frame(2)], canvas: [1, 1], palette: 'unit' },
  };
  const json = {
    theater: 'temperate',
    palettes: {},
    voxels: {},
    types,
    sprites,
    spriteAtlases: [0, 1, 2, 3].map((i) => ({ file: `sprites-${i}.png`, width: 8, height: 4 })),
    spriteAtlasesHd: [0, 1, 2].map((i) => ({
      file: `sprites-${i}@2x.png`,
      remap: `sprites-${i}@2x-remap.png`,
      scale: 2,
      width: 16,
      height: 8,
    })),
  };
  const waiting = new Map<string, (response: Response) => void>();
  const fetcher = vi.fn((url: string) => {
    if (url.endsWith('/library.json')) return Promise.resolve(Response.json(json));
    const file = /\/(sprites-[^/]+\.png)$/.exec(url)?.[1];
    if (!file) return Promise.resolve(new Response(null, { status: 404 }));
    return new Promise<Response>((resolve) => waiting.set(file, resolve));
  });
  vi.stubGlobal('fetch', fetcher);
  vi.stubGlobal(
    'createImageBitmap',
    vi.fn(async () => ({ width: 8, height: 4, close: vi.fn() })),
  );
  const lib = (await LiveLibrary.load('/library/temperate', {} as Ra2Cache))!;
  // As in a view: decoded pages go straight to the GPU (here: nowhere).
  lib.uploadPage = (texture: Texture) => texture.onUpdate?.(texture);
  const requested = () =>
    fetcher.mock.calls.map(([url]) => /\/(sprites-[^/]+\.png)$/.exec(url)?.[1]).filter((f): f is string => !!f);
  const arrive = async (file: string, ok = true) => {
    waiting.get(file)!(ok ? new Response('png') : new Response(null, { status: 500 }));
    waiting.delete(file);
    // fetch -> blob -> decode -> upload -> settle
    for (let turn = 0; turn < 12; turn++) await Promise.resolve();
  };
  return { lib, types, requested, arrive };
}

/** What the view's uploader is told about each page it is handed. */
function uploads(lib: LiveLibrary) {
  const background: (() => boolean)[] = [];
  lib.uploadPage = (texture: Texture, isBackground) => {
    background.push(isBackground ?? (() => false));
    texture.onUpdate?.(texture);
  };
  return background;
}

describe('atlas pages fetched ahead of their first use', () => {
  it('lists every page a type draws from: body, bib, build-up, layers and shadows, with the recorded ones', async () => {
    const { lib, types } = await library();
    expect(lib.typePages(types.YARD!)).toEqual([0, 1, 2, 3]);
    // The same list every time (it is read for every object of the type on every frame until its pages are in).
    expect(lib.typePages(types.YARD!)).toBe(lib.typePages(types.YARD!));
    expect(lib.typePages(types.TANK!)).toEqual([]);
  });

  it('fetches an indexed page silently: nothing counts as loading and no revision changes', async () => {
    const { lib, requested, arrive } = await library();
    expect(lib.pageSettled(1)).toBe(false);
    expect(lib.preloadPage(1)).toBe(false);
    expect(requested()).toEqual(['sprites-1.png']);
    // Asked again on later frames: one request, still silent.
    expect(lib.preloadPage(1)).toBe(false);
    expect(requested()).toEqual(['sprites-1.png']);
    expect(lib.loading).toBe(0);
    const revision = lib.revision;
    await arrive('sprites-1.png');
    expect(lib.revision).toBe(revision);
    expect(lib.loading).toBe(0);
    expect(lib.preloadPage(1)).toBe(true);
    expect(lib.pageSettled(1)).toBe(true);
    // An object of the type finds the page in its first frame, without another request.
    expect(lib.page(1)).toMatchObject({ width: 8, height: 4 });
    expect(requested()).toEqual(['sprites-1.png']);
    // The HD art was not asked for: an indexed page is 2 MB, its HD art 50.
    expect(requested().some((file) => file.includes('@2x'))).toBe(false);
  });

  it('fetches everything a layer is built from when asked for the final page, and says when it is all in', async () => {
    const { lib, requested, arrive } = await library();
    expect(lib.preloadPage(0, true)).toBe(false);
    expect(requested().sort()).toEqual(['sprites-0.png', 'sprites-0@2x-remap.png', 'sprites-0@2x.png']);
    expect(lib.loading).toBe(0);
    const revision = lib.revision;
    await arrive('sprites-0.png');
    // The indexed page is in, the HD art is not: there is something to draw from, but not the final look.
    expect(lib.pageSettled(0)).toBe(true);
    expect(lib.preloadPage(0, true)).toBe(false);
    await arrive('sprites-0@2x.png');
    await arrive('sprites-0@2x-remap.png');
    expect(lib.preloadPage(0, true)).toBe(true);
    expect(lib.revision).toBe(revision);
    expect(lib.hdPage(0)).not.toBeNull();
    // A page without HD art is final as soon as its indexed page is in.
    expect(lib.preloadPage(3, true)).toBe(false);
    expect(requested().filter((file) => file.startsWith('sprites-3'))).toEqual(['sprites-3.png']);
    await arrive('sprites-3.png');
    expect(lib.preloadPage(3, true)).toBe(true);
  });

  it('turns a page that is asked for while it is fetched ahead into art on its way', async () => {
    const { lib, requested, arrive } = await library();
    lib.preloadPage(2, true);
    expect(lib.loading).toBe(0);
    // An object needs the page now: it counts, and its arrival is news; the fetch under way answers.
    expect(lib.page(2)).toBeNull();
    expect(lib.loading).toBe(1);
    expect(lib.hdPage(2)).toBeNull();
    expect(lib.loading).toBe(2);
    expect(requested()).toHaveLength(3);
    const revision = lib.revision;
    await arrive('sprites-2.png');
    expect(lib.revision).toBe(revision + 1);
    expect(lib.loading).toBe(1);
    await arrive('sprites-2@2x.png');
    await arrive('sprites-2@2x-remap.png');
    expect(lib.revision).toBe(revision + 2);
    expect(lib.loading).toBe(0);
  });

  it('settles a page that failed, ahead or not, and stops asking for its HD art once that has failed', async () => {
    const { lib, arrive } = await library();
    lib.preloadPage(1, true);
    const revision = lib.revision;
    await arrive('sprites-1.png', false);
    expect(lib.pageSettled(1)).toBe(true);
    expect(lib.pageFailed(1)).toBe(true);
    expect(lib.page(1)).toBeNull();
    expect(lib.revision).toBe(revision);
    await arrive('sprites-1@2x.png', false);
    await arrive('sprites-1@2x-remap.png');
    expect(lib.hasHdPage(1)).toBe(false);
    expect(lib.preloadPage(1, true)).toBe(true);
    // A page the library does not have is nothing to wait for.
    expect(lib.pageSettled(9)).toBe(true);
    expect(lib.preloadPage(9, true)).toBe(true);
  });

  it('tells the uploader which pages nothing waits for, until something does', async () => {
    const { lib, arrive } = await library();
    const background = uploads(lib);
    lib.preloadPage(0);
    lib.page(1);
    await arrive('sprites-0.png');
    await arrive('sprites-1.png');
    expect(background).toHaveLength(2);
    // Both are in by now; what matters is what the uploader was told while their rows waited.
    const { lib: second, arrive: arriveSecond } = await library();
    const answers: boolean[] = [];
    let ask: (() => boolean) | undefined;
    second.uploadPage = (_texture: Texture, isBackground) =>
      new Promise<void>((resolve) => {
        ask = isBackground;
        answers.push(isBackground!());
        // The page is asked for in earnest while its rows wait their turn.
        second.page(2);
        answers.push(isBackground!());
        resolve();
      });
    second.preloadPage(2);
    await arriveSecond('sprites-2.png');
    expect(answers).toEqual([true, false]);
    expect(ask).toBeDefined();
    expect(second.page(2)).not.toBeNull();
  });

  it('lists the looks its HD pages can have without loading one', async () => {
    const { lib, requested } = await library();
    // Three HD pages, none with a material page or a lit-window mask in this library: one look.
    expect(lib.hdPageLooks()).toEqual([{ paintSaturation: 1, materials: false, windows: false }]);
    expect(requested()).toEqual([]);
  });

  it("decodes its pages inside the view's gate, and tells the gate which pages nothing waits for", async () => {
    const { lib, arrive } = await library();
    // What the view hands the library: its uploader with the decode gate attached (LiveView's constructor).
    const gate = new PageGate();
    const turns: { pixels: number; background: boolean | undefined }[] = [];
    const run = gate.run.bind(gate);
    vi.spyOn(gate, 'run').mockImplementation((pixels, task, background) => {
      turns.push({ pixels, background: background?.() });
      return run(pixels, task, background);
    });
    const handed: (boolean | undefined)[] = [];
    const upload: PageUpload = Object.assign(
      (texture: Texture, background?: () => boolean) => {
        handed.push(background?.());
        texture.onUpdate?.(texture);
      },
      { gate },
    );
    lib.uploadPage = upload;
    // One page loaded ahead, one that an object waits for: each takes its turn at the view's gate, and both the gate
    // and the uploader are told which is which.
    lib.preloadPage(0);
    lib.page(1);
    await arrive('sprites-0.png');
    await arrive('sprites-1.png');
    expect(turns.map((turn) => turn.background)).toEqual([true, false]);
    expect(handed).toEqual([true, false]);
    expect(gate.inFlight).toBe(0);
    expect(lib.page(1)).not.toBeNull();
  });
});
