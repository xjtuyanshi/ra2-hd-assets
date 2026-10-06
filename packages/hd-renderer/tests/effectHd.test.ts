import {
  CustomBlending,
  DataTexture,
  LinearFilter,
  LinearMipmapLinearFilter,
  OneFactor,
  OneMinusSrcAlphaFactor,
  OrthographicCamera,
  Scene,
  SRGBColorSpace,
  Vector3,
  WebGPURenderer,
  type InstancedMesh,
  type MeshBasicNodeMaterial,
} from 'three/webgpu';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EffectHdAnim, EffectHdLibrary } from '../../ra2-assets/src/effects';
import type { DirtyAttribute } from '../src/dirtyAttribute';
import { bindSlots } from '../src/materialSlots';
import { BlastCrowd, EffectsLayer, ENHANCED } from '../src/effects';
import { EffectArt, PAGE_RETRY_SECONDS, type ResolvedAnim } from '../src/live/effectArt';
import {
  animAlpha,
  animAlphaSmooth,
  EffectSpriteLayer,
  engineAnchor,
  engineDepth,
  MESH_IDLE_SECONDS,
  type EffectInstance,
  type EffectPage,
} from '../src/live/effectSprites';
import { LiveEffectsDriver, type LiveAnim } from '../src/live/effects';
import type { Ra2Cache } from '../src/ra2/cache';
import { assignPainterBias, painterObject } from '../src/ra2/painterOrder';
import { cardPush } from '../src/ra2/sprites';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const cache = {
  paletteAtlas: { image: { height: 1 } },
  paletteRow: new Map([['fx:anim', 0]]),
} as unknown as Ra2Cache;

/** Different crops and fractional offsets expose accidental stretching or atlas/native pixel confusion. */
function flipbook(): EffectHdAnim {
  return {
    scale: 2,
    frames: Array.from({ length: 5 }, (_, i) => ({
      page: 0,
      rect: [i * 24, 0, 16 + i * 2, 24],
      offset: [-4.5 - i, -8 + i],
    })),
  };
}

function fixture() {
  const hd = flipbook();
  const frames = hd.frames.map((_, i) => ({
    page: 1,
    rect: [i * 12, 0, 10, 12] as [number, number, number, number],
    offset: [-5, -8] as [number, number],
  }));
  const resolved: ResolvedAnim = {
    id: 'TWLT070',
    art: {
      sprite: 'anim:TWLT070',
      palette: 'anim',
      start: 0,
      frameCount: 5,
      loopStart: 0,
      loopEnd: 5,
      loopCount: 1,
      rate: 900,
      normalized: true,
      rateFrames: 2,
      layer: 'air',
      translucent: true,
      shadow: true,
      drawOffset: [1.5, -2],
      zAdjust: 3,
      hotW: 10,
      visW: 10,
    },
    sprite: { frames, shadows: frames, canvas: [24, 24], palette: 'anim', remap: false },
    palette: 'fx:anim',
    remap: false,
  };
  const hdAnim = vi.fn(() => hd as EffectHdAnim | null);
  // The redrawn page is there: a page that is still loading keeps the anim's own art on screen (see below).
  const hdPage: EffectPage = { texture: new DataTexture(new Uint8Array(4), 1, 1), width: 64, height: 16 };
  const hdPageState = vi.fn((): EffectPage | 'loading' | null => hdPage);
  const art = { ready: true, anim: () => resolved, hdAnim, hdPageState } as unknown as EffectArt;
  const explode = vi.fn();
  const muzzleFlash = vi.fn();
  const sparkFlash = vi.fn();
  const driver = new LiveEffectsDriver(
    { setBeams: vi.fn(), explode, muzzleFlash, sparkFlash } as unknown as EffectsLayer,
    () => false,
  );
  driver.style = 'enhanced';
  driver.hasHdArt = (type) => !!art.hdAnim(type);
  const push = (fields: Partial<LiveAnim> = {}, logicFrame = 100, now = 4) =>
    driver.push(
      {
        anims: [{ id: 1, uid: 1, type: 'TWLT070', x: 768, y: 512, z: 104, ...fields }],
        bullets: [],
        particleSystems: [],
      },
      logicFrame,
      now,
      new Vector3(),
    );
  const cards = () => {
    const out: EffectInstance[] = [];
    const stats = driver.cards(art, () => 'fx:anim', out);
    return { out, stats };
  };
  return { driver, hd, resolved, hdAnim, hdPageState, push, cards, explode, muzzleFlash, sparkFlash };
}

describe('HD anim opacity', () => {
  it('joins the native step centres smoothly, holds the opaque head and remains monotone through the tail', () => {
    const art = { translucent: true, translucency: 75 };
    const at = (stage: number) => animAlphaSmooth(art, stage, 100);
    expect([-10, 0, 10, 20].map(at)).toEqual([1, 1, 1, 1]);
    expect(at(40)).toBe(0.75);
    expect(at(60)).toBe(0.5);
    expect(at(100)).toBeCloseTo(0.3);
    expect(at(120)).toBeCloseTo(0.3);
    expect(at(30)).toBeCloseTo(0.875);
    expect(at(80)).toBeCloseTo(0.4);
    for (let stage = 0; stage <= 120; stage += 0.25) expect(at(stage)).toBeLessThanOrEqual(at(stage - 0.25));
  });

  it('preserves all constant native translucency modes for art without Translucent=yes', () => {
    for (const translucency of [undefined, 0, 25, 50, 75])
      for (const stage of [0, 2.5, 5, 10, 20]) {
        const art = { translucency };
        expect(animAlphaSmooth(art, stage, 10)).toBe(animAlpha(art, stage, 10));
      }
  });
});

describe('live HD flipbook selection', () => {
  it('uses the bridge frame and rate at the native anchor, pass and depth, without a native shadow', () => {
    const f = fixture();
    f.push({ frame: 2, stage: 1, rate: 5 });
    const { out, stats } = f.cards();
    expect(stats).toEqual({ drawn: 1, missing: 0 });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      frame: f.resolved.sprite.frames[2],
      pass: 'air',
      draw: 'card',
      alpha: 1,
      hd: { frame: f.hd.frames[2], next: f.hd.frames[3], scale: 2, size: 1.3, blend0: 0, t0: 4, stageSeconds: 5 / 15 },
    });
    expect(out[0]!.anchor).toEqual(engineAnchor(768, 512, 104, [1.5, -2]));
    expect(out[0]!.depth).toBe(engineDepth(768, 512, 104) + 0.003);
    expect(out[0]!.push).toBe(cardPush({ rect: [0, 0, 10 * 1.3, 12 * 1.3], offset: [-6.5 * 1.3, -6 * 1.3] }));
  });

  it.each([
    ['TWLT070', 1.3, 'explode', 4],
    ['CACH06DM', 1.3, 'explode', 4],
    ['BIGBLUE', 1.15, 'sparkFlash', 3],
    ['APMUZZLE', 1, 'muzzleFlash', 3],
  ] as const)(
    'scales %s HD placement and garnish together while retaining native fallbacks',
    (type, size, fx, optionIndex) => {
      const f = fixture();
      f.driver.artWidth = () => 2;
      f.push({ type, frame: 2 });
      const card = f.cards().out[0]!;
      expect(card.hd!.size).toBe(size);
      expect(card.anchor).toEqual(engineAnchor(768, 512, 104, [1.5, -2]));
      expect(card.push).toBe(cardPush({ rect: [0, 0, 10 * size, 12 * size], offset: [-6.5 * size, -6 * size] }));
      expect(f[fx].mock.calls[0]![optionIndex]).toMatchObject({ hdArt: true, maxSize: 2 * size });
      for (const mode of ['disabled', 'missing', 'faithful'] as const) {
        f.driver.hdEnabled = mode !== 'disabled';
        f.hdAnim.mockReturnValue(mode === 'missing' ? null : f.hd);
        f.driver.style = mode === 'faithful' ? 'faithful' : 'enhanced';
        f[fx].mockClear();
        f.push({ type, frame: 2, uid: { disabled: 2, missing: 3, faithful: 4 }[mode] });
        expect(f.cards().out.every((instance) => instance.hd === undefined)).toBe(true);
        expect(f.cards().out[1]!.push).toBe(cardPush(f.resolved.sprite.frames[2]!));
        expect(f[fx].mock.calls[0]![optionIndex]).toMatchObject({ hdArt: false, maxSize: 2 });
      }
    },
  );

  it('leaves unknown HD garnish widths uncapped', () => {
    const f = fixture();
    f.push();
    expect(f.explode.mock.calls[0]![4]).toMatchObject({ hdArt: true, maxSize: undefined });
  });

  it.each([
    ['CRYSTAL1', 1.3],
    ['UNKNOWN_HD', 1],
  ] as const)('sizes %s by category even when no garnish is emitted', (type, size) => {
    const f = fixture();
    f.push({ type, frame: 2 });
    expect(f.cards().out[0]!.hd!.size).toBe(size);
    expect(f.explode).not.toHaveBeenCalled();
  });

  it.each(['ground', 'air', 'top'] as const)('keeps the native %s pass and flat/decal handling', (layer) => {
    const f = fixture();
    f.push({ frame: 0, stage: 0, layer });
    expect(f.cards().out[0]!.pass).toBe(layer);
    f.push({ frame: 0, stage: 0, layer, flat: true });
    expect(f.cards().out[0]).toMatchObject({ pass: layer === 'top' ? 'top' : 'ground', draw: 'flat', push: 0 });
  });

  it('holds the last one-shot frame and wraps looping art to its own loopStart', () => {
    const f = fixture();
    f.push({ frame: 4, stage: 4 });
    expect(f.cards().out[0]!.hd!.next).toBeNull();
    f.resolved.art.loopCount = -1;
    f.resolved.art.loopStart = 1;
    f.resolved.art.loopEnd = 4;
    f.push({ frame: 3, stage: 3 });
    expect(f.cards().out[0]!.hd!.next).toBe(f.hd.frames[1]);
    f.push({ frame: 3, stage: 3, loopsLeft: 1 });
    expect(f.cards().out[0]!.hd!.next).toBeNull();
  });

  it('keeps the fallback frame clock and sub-stage phase anchored to the newest push', () => {
    const f = fixture();
    f.push();
    f.push({}, 105, 4 + 5 / 15);
    const card = f.cards().out[0]!;
    expect(card.hd).toMatchObject({ frame: f.hd.frames[2], next: f.hd.frames[3], blend0: 0.5, t0: 4 + 5 / 15 });
    expect(card.hd!.stageSeconds).toBeCloseTo(2 / 15);
    expect(card.alpha).toBeCloseTo(0.625);
    // A repeated logic frame is still a new interpolation origin; FPS estimation stays on changed logic frames.
    f.push({ frame: 2, stage: 2 }, 105, 4.4);
    expect(f.cards().out[0]!.hd).toMatchObject({ blend0: 0, t0: 4.4 });
  });

  it('leaves faithful and explicitly disabled effects on native cards and shadows without an HD lookup', () => {
    const f = fixture();
    f.driver.style = 'faithful';
    f.push({ frame: 3, stage: 3 });
    const native = f.cards().out;
    expect(native.map((card) => [card.draw, card.hd])).toEqual([
      ['shadow', undefined],
      ['card', undefined],
    ]);
    expect(native[1]!.alpha).toBe(animAlpha(f.resolved.art, 3, 5));
    expect(f.hdAnim).not.toHaveBeenCalled();
    f.driver.style = 'enhanced';
    f.driver.hdEnabled = false;
    expect(f.cards().out).toEqual(native);
    expect(f.hdAnim).not.toHaveBeenCalled();
  });

  it('draws nothing for an empty HD frame, holds across atlas pages and falls back when HD is unavailable', () => {
    const f = fixture();
    f.hd.frames[1] = null;
    f.push({ frame: 1 });
    expect(f.cards()).toEqual({ out: [], stats: { drawn: 0, missing: 0 } });
    f.hd.frames[3]!.page = 1;
    f.push({ frame: 2 });
    expect(f.cards().out[0]!.hd!.next).toBeNull();
    f.hdPageState.mockReturnValue(null);
    expect(f.cards().out.map((card) => card.draw)).toEqual(['shadow', 'card']);
    // A page on its way: the anim is drawn from its own art until then, not skipped.
    f.hdPageState.mockReturnValue('loading');
    const meanwhile = f.cards().out;
    expect(meanwhile.map((card) => card.draw)).toEqual(['shadow', 'card']);
    expect(meanwhile.every((card) => card.hd === undefined)).toBe(true);
    expect(meanwhile[1]!.frame).toBe(f.resolved.sprite.frames[2]);
    f.hdPageState.mockReturnValue({ texture: new DataTexture(new Uint8Array(4), 1, 1), width: 64, height: 16 });
    expect(f.cards().out[0]!.hd!.frame).toBe(f.hd.frames[2]);
    f.hdAnim.mockReturnValue(null);
    expect(f.cards().out.every((card) => card.hd === undefined)).toBe(true);
  });

  it('marks enhanced garnish only when HD art is enabled and known', () => {
    const f = fixture();
    f.push();
    expect(f.explode.mock.calls[0]![4]).toMatchObject({ enhanced: true, hdArt: true });
    f.driver.hdEnabled = false;
    f.push({ uid: 2 });
    expect(f.explode.mock.calls[1]![4]).toMatchObject({ enhanced: true, hdArt: false });
    f.driver.hdEnabled = true;
    f.driver.style = 'faithful';
    f.push({ uid: 3 });
    expect(f.explode.mock.calls[2]![4]).toMatchObject({ enhanced: false, hdArt: false });
  });

  it('removes the procedural blast, halves the garnish core and narrows the graded halo for an HD explosion', () => {
    const names = [
      'garnishFire',
      'blast',
      'halo',
      'sparks',
      'airborneEmbers',
      'debris',
      'debrisShadow',
      'column',
      'billow',
      'shimmer',
      'dust',
      'embers',
      'scorch',
    ];
    const pools = Object.fromEntries(names.map((name) => [name, { spawn: vi.fn() }]));
    const layer = Object.assign(Object.create(EffectsLayer.prototype), pools, {
      zeroVelocity: new Vector3(),
      crowd: new BlastCrowd(),
    }) as EffectsLayer;
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const at = new Vector3(1, 2, 3);
    const wind = new Vector3();
    const width = 2;
    layer.explode(1, at, 1, wind, { enhanced: true, maxSize: width });
    expect(pools.blast!.spawn).toHaveBeenCalledTimes(1);
    expect(pools.airborneEmbers!.spawn).toHaveBeenCalled();
    const core = pools.garnishFire!.spawn.mock.calls[0]!;
    const halo = pools.halo!.spawn.mock.calls[0]!;
    // -3 retains native-halo intensity while selecting the explosion's spherical front (muzzle halos stay positive).
    expect(halo.slice(3)).toEqual([width * ENHANCED.halo.width, ENHANCED.halo.life, -3]);
    const unchanged = names.filter((name) => !['garnishFire', 'blast', 'halo'].includes(name));
    const garnish = unchanged.map((name) => pools[name]!.spawn.mock.calls.slice());
    for (const pool of Object.values(pools)) pool.spawn.mockClear();
    // Compare independent blasts: the cluster budget is intentionally exhausted by repeated births at one point.
    Object.assign(layer, { crowd: new BlastCrowd() });
    layer.explode(1, at, 1, wind, { enhanced: true, hdArt: true, maxSize: width });
    expect(pools.blast!.spawn).not.toHaveBeenCalled();
    const hdCore = pools.garnishFire!.spawn.mock.calls[0]!;
    expect(hdCore.slice(0, 3)).toEqual(core.slice(0, 3));
    expect(hdCore[3]).toBe(core[3] / 2);
    expect(hdCore.slice(4)).toEqual(core.slice(4));
    const hdHalo = pools.halo!.spawn.mock.calls[0]!;
    expect(hdHalo.slice(0, 3)).toEqual(halo.slice(0, 3));
    expect(hdHalo[3]).toBe(width * ENHANCED.halo.hdWidth);
    expect(hdHalo[3]).toBeLessThan(halo[3]);
    expect(hdHalo[4]).toBe(ENHANCED.halo.life);
    // The negative mode selects the HD temperature grade instead of a positive native-halo intensity.
    expect(hdHalo[5]).toBe(-1);
    expect(unchanged.map((name) => pools[name]!.spawn.mock.calls)).toEqual(garnish);
  });
});

function sidecar() {
  const library: EffectHdLibrary = {
    version: 1,
    pages: [{ file: 'page.png', width: 128, height: 32 }],
    anims: { TWLT070: flipbook() },
  };
  const fetcher = vi.fn(async (url: string) => ({
    ok: true,
    json: async () => (url.endsWith('effects-hd.json') ? library : {}),
    blob: async () => new Blob(),
  }));
  vi.stubGlobal('fetch', fetcher);
  const bitmap = { width: 128, height: 32, close: vi.fn() };
  vi.stubGlobal(
    'createImageBitmap',
    vi.fn(async () => bitmap),
  );
  return { library, fetcher, bitmap };
}

describe('optional HD sidecar and page lifecycle', () => {
  it.each(['missing', 'network'] as const)(
    'settles a %s sidecar once without throwing or rejecting native art',
    async (failure) => {
      const info = vi.spyOn(console, 'info').mockImplementation(() => {});
      const fetcher = vi.fn();
      if (failure === 'missing') fetcher.mockResolvedValue({ ok: false, statusText: 'Not Found' });
      else fetcher.mockRejectedValue(new Error('offline'));
      vi.stubGlobal('fetch', fetcher);
      const art = new EffectArt('/library/common/effects', cache, 'temperate', true);
      expect(art.hdAnim('TWLT070')).toBeNull();
      await expect(Promise.all([art.loadHd(), art.loadHd()])).resolves.toEqual([undefined, undefined]);
      expect(art.hdAnim('twlt070')).toBeNull();
      expect(art.hdPageState(0)).toBeNull();
      expect(art.preloadHd(/TWLT/)).toEqual([]);
      expect(art.revision).toBe(1);
      expect(fetcher).toHaveBeenCalledExactlyOnceWith('/library/common/effects/../effects-hd/effects-hd.json');
      expect(info).toHaveBeenCalledTimes(1);
    },
  );

  it('loads straight-alpha sRGB textures, signals readiness, frees the bitmap and releases unpinned pages', async () => {
    const { library, fetcher, bitmap } = sidecar();
    const art = new EffectArt('/native', cache, 'temperate', true, '/replacement');
    art.uploadPage = vi.fn((texture) => {
      expect(texture.image).toBe(bitmap);
      expect(texture).toMatchObject({
        colorSpace: SRGBColorSpace,
        magFilter: LinearFilter,
        minFilter: LinearMipmapLinearFilter,
        generateMipmaps: true,
        flipY: false,
        premultiplyAlpha: false,
      });
      texture.onUpdate?.(texture);
    });
    await art.loadHd();
    expect(art.hdAnim('twlt070')).toBe(library.anims.TWLT070);
    expect(art.hdAnim('UNKNOWN')).toBeNull();
    expect(art.hdPageState(99)).toBeNull();
    expect(art.hdPageState(0)).toBe('loading');
    expect(art.hdPageState(0)).toBe('loading');
    await vi.waitFor(() => expect(art.revision).toBe(2));
    const page = art.hdPageState(0) as EffectPage;
    expect(art.hdPageState(0)).toBe(page);
    expect(page).toMatchObject({ width: 128, height: 32 });
    expect(page.texture.image).toEqual({ width: 128, height: 32 });
    expect(bitmap.close).toHaveBeenCalledTimes(1);
    expect(art.uploadPage).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual(['/replacement/effects-hd.json', '/replacement/page.png']);
    expect(createImageBitmap).toHaveBeenCalledWith(expect.any(Blob), {
      colorSpaceConversion: 'none',
      premultiplyAlpha: 'none',
    });
    const dispose = vi.spyOn(page.texture, 'dispose');
    art.releaseHd(0);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(bitmap.close).toHaveBeenCalledTimes(1);
    expect(art.hdPageState(0)).toBe('loading');
    await vi.waitFor(() => expect(art.revision).toBe(3));
    art.releaseHd(0);
  });

  it.each(['upload', 'dispose'] as const)('retains a deferred bitmap only until its first %s', async (finish) => {
    const { bitmap } = sidecar();
    const art = new EffectArt('/native', cache, 'temperate', true);
    await art.loadHd();
    art.hdPageState(0);
    await vi.waitFor(() => expect(art.revision).toBe(2));
    const { texture } = art.hdPageState(0) as EffectPage;
    expect(bitmap.close).not.toHaveBeenCalled();
    if (finish === 'upload') texture.onUpdate?.(texture);
    art.releaseHd(0);
    expect(bitmap.close).toHaveBeenCalledTimes(1);
    expect(texture.onUpdate).toBeNull();
  });

  it('pins matching pages and bounds retries after upload failure while closing the failed bitmap', async () => {
    const { fetcher, bitmap } = sidecar();
    const now = vi.spyOn(performance, 'now').mockReturnValue(1000);
    const art = new EffectArt('/native', cache, 'temperate', true);
    art.uploadPage = () => {
      throw new Error('upload failed');
    };
    await art.loadHd();
    expect(art.preloadHd(/UNKNOWN/)).toEqual([]);
    expect(art.preloadHd(/TWLT/)).toEqual([0]);
    await vi.waitFor(() => expect(art.revision).toBe(2));
    expect(bitmap.close).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 100; i++) expect(art.hdPageState(0)).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(2);
    now.mockReturnValue(1000 + (PAGE_RETRY_SECONDS + 1) * 1000);
    art.uploadPage = vi.fn();
    expect(art.hdPageState(0)).toBe('loading');
    await vi.waitFor(() => expect(art.revision).toBe(3));
    const page = art.hdPageState(0) as EffectPage;
    const dispose = vi.spyOn(page.texture, 'dispose');
    art.releaseHd(0);
    expect(dispose).not.toHaveBeenCalled();
    expect(art.hdPageState(0)).toBe(page);
    page.texture.dispose();
  });
});

type PageInternals = {
  mesh: InstancedMesh & { material: MeshBasicNodeMaterial };
  offsets: DirtyAttribute;
  rect: DirtyAttribute;
  nextRect: DirtyAttribute;
  style: DirtyAttribute;
  timing: DirtyAttribute;
};

describe('HD page routing and placement buffers', () => {
  // The shader derives the union from packed frame offsets, atlas rects and HD scale; no bounds buffer is uploaded.
  const nativeBounds = (page: PageInternals) => {
    const x = page.offsets.getX(0);
    const y = page.offsets.getY(0);
    const nextX = page.offsets.getZ(0);
    const nextY = page.offsets.getW(0);
    const scale = page.style.getW(0);
    const left = Math.min(x, nextX);
    const top = Math.min(y, nextY);
    const right = Math.max(x + page.rect.getZ(0) / scale, nextX + page.nextRect.getZ(0) / scale);
    const bottom = Math.max(y + page.rect.getW(0) / scale, nextY + page.nextRect.getW(0) / scale);
    return [left, top, right - left, bottom - top];
  };

  const card = (): EffectInstance => {
    const f = fixture();
    f.push({ frame: 1 });
    return f.cards().out[0]!;
  };

  it('expands the HD material into WGSL without a GPU, native palettes or a scene backdrop', () => {
    // Only the compiler's capability queries are supplied. No adapter/device, upload, browser or draw is created;
    // this catches invalid lazy TSL expressions while making no claim about GPU validation or the final image.
    const canvas = { width: 1, height: 1, style: {}, addEventListener() {} } as unknown as HTMLCanvasElement;
    const renderer = new WebGPURenderer({ canvas });
    Object.assign(renderer.backend, {
      device: { limits: { maxUniformBufferBindingSize: 65536 }, features: new Set() },
      renderer,
    });
    renderer.hasFeature = () => false;
    renderer.hasCompatibility = () => false;
    const texture = new DataTexture(new Uint8Array(128 * 32 * 4), 128, 32);
    texture.colorSpace = SRGBColorSpace;
    texture.magFilter = LinearFilter;
    texture.minFilter = LinearMipmapLinearFilter;
    texture.generateMipmaps = true;
    const layer = new EffectSpriteLayer(
      {} as Ra2Cache,
      () => null,
      undefined,
      () => ({ texture, width: 128, height: 32 }),
    );
    layer.setInstances([{ ...card(), pass: 'ground' }], 0);
    const mesh = layer.root.children[0] as Mesh;
    // What the renderer does before it draws the mesh (Object3D.onBeforeRender): the page is in the graph's slot.
    bindSlots(mesh.material);
    const builder = renderer.backend.createNodeBuilder(mesh, renderer);
    builder.scene = new Scene();
    builder.camera = new OrthographicCamera();
    builder.build();
    expect(builder.vertexShader).toContain('@vertex');
    expect(builder.fragmentShader).toContain('@fragment');
    expect(builder.fragmentShader).toContain('textureSampleLevel');
    layer.setInstances([], MESH_IDLE_SECONDS + 1);
    texture.dispose();
  });

  it('uses native-pixel union bounds, shared painter bias and premultiplied blending without a backdrop material', () => {
    const atlas = { texture: new DataTexture(), width: 128, height: 32 };
    const layer = new EffectSpriteLayer(
      cache,
      () => atlas,
      undefined,
      () => atlas,
    );
    const instance = card();
    instance.pass = 'ground';
    instance.painter = painterObject(2, 100);
    assignPainterBias([instance.painter, painterObject(2, 200)]);
    layer.setInstances([instance, { ...instance, pass: 'air' }, { ...instance, pass: 'top' }], 1);
    const meshes = (layer as unknown as { meshes: Map<string, PageInternals> }).meshes;
    const page = meshes.get('hd:0:ground')!;
    // Frame 1: [-5.5,-7 .. 3.5,5]; frame 2: [-6.5,-6 .. 3.5,6]. One-pixel margins are added in the shader.
    expect(Array.from(page.rect.array.slice(0, 4))).toEqual(instance.hd!.frame.rect);
    expect(Array.from(page.nextRect.array.slice(0, 4))).toEqual(instance.hd!.next!.rect);
    expect(Array.from(page.offsets.array.slice(0, 4))).toEqual([-5.5, -7, -6.5, -6]);
    expect(page.style.getW(0)).toBe(instance.hd!.scale);
    expect(page.timing.getW(0)).toBeCloseTo(1.3);
    expect(nativeBounds(page)).toEqual([-6.5, -7, 10, 13]);
    expect(page.style.getZ(0)).toBeCloseTo(instance.painter.bias, 7);
    expect(page.mesh.material).toMatchObject({
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: CustomBlending,
      blendSrc: OneFactor,
      blendDst: OneMinusSrcAlphaFactor,
      blendSrcAlpha: OneFactor,
      blendDstAlpha: OneMinusSrcAlphaFactor,
      premultipliedAlpha: false,
    });
    expect(page.mesh.material.depthNode).not.toBeNull();
    expect([
      page.mesh.renderOrder,
      meshes.get('hd:0:air')!.mesh.renderOrder,
      meshes.get('hd:0:top')!.mesh.renderOrder,
    ]).toEqual([6, 7, 8]);
    expect(meshes.get('hd:0:air')!.mesh.material.depthTest).toBe(true);
    expect(meshes.get('hd:0:top')!.style.getZ(0)).toBe(0);
    expect(layer.meshStats().translucent).toBe(0);
    const attributes = [page.rect, page.nextRect, page.offsets, page.style, page.timing];
    const versions = attributes.map((attribute) => attribute.version);
    layer.now.value = 4.5;
    layer.setInstances([instance], 2);
    expect(attributes.map((attribute) => attribute.version)).toEqual(versions);
    // Display-only changes use timing.w; frame crops, interpolation and all six vertex buffers stay the same.
    instance.hd!.size = undefined;
    layer.setInstances([instance], 2.5);
    expect(page.timing.getW(0)).toBe(1);
    expect([page.rect, page.nextRect, page.offsets, page.style].map((attribute) => attribute.version)).toEqual(
      versions.slice(0, 4),
    );
    expect(Array.from(page.timing.array.slice(0, 3))).toEqual(
      Array.from(Float32Array.from([instance.hd!.blend0, instance.hd!.t0, instance.hd!.stageSeconds])),
    );
    instance.hd!.next = { ...instance.hd!.next!, page: 7 };
    layer.setInstances([instance], 3);
    expect(page.nextRect.array.slice(0, 4)).toEqual(page.rect.array.slice(0, 4));
    expect(Array.from(page.offsets.array.slice(0, 4))).toEqual([-5.5, -7, -5.5, -7]);
    expect(nativeBounds(page)).toEqual([-5.5, -7, 9, 12]);
    layer.setInstances([], MESH_IDLE_SECONDS + 4);
    atlas.texture.dispose();
  });

  it('skips HD instances without a source and waits for pending HD pages without requesting indexed art', () => {
    const native = vi.fn(() => null);
    expect(new EffectSpriteLayer(cache, native).setInstances([card()])).toBe(true);
    const source = vi.fn(() => 'loading' as const);
    const layer = new EffectSpriteLayer(cache, native, undefined, source);
    expect(layer.setInstances([card()])).toBe(false);
    expect(source).toHaveBeenCalledWith(0);
    expect(native).not.toHaveBeenCalled();
    expect(layer.count).toBe(0);
  });

  it('releases idle pages independently across native/HD namespaces and keeps pages used by another pass', () => {
    const atlas = { texture: new DataTexture(), width: 128, height: 32 };
    const release = vi.fn();
    const releaseHd = vi.fn();
    const layer = new EffectSpriteLayer(
      cache,
      () => atlas,
      release,
      () => atlas,
      releaseHd,
    );
    const hd = card();
    const native = { ...hd, hd: undefined, frame: { ...hd.frame, page: 0 } };
    layer.setInstances([hd, { ...hd, pass: 'ground' }, native], 0);
    layer.setInstances([{ ...hd, pass: 'ground' }], MESH_IDLE_SECONDS + 1);
    expect(release).toHaveBeenCalledExactlyOnceWith(0);
    expect(releaseHd).not.toHaveBeenCalled();
    layer.setInstances([], 2 * MESH_IDLE_SECONDS + 2);
    expect(releaseHd).toHaveBeenCalledExactlyOnceWith(0);
    expect(layer.meshStats().meshes).toBe(0);
    atlas.texture.dispose();
  });
});
