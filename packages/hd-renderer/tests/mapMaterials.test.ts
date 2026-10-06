import {
  ClampToEdgeWrapping,
  DataUtils,
  HalfFloatType,
  LinearFilter,
  LinearMipmapLinearFilter,
  NoColorSpace,
  RepeatWrapping,
  SRGBColorSpace,
  Texture,
  TextureLoader,
} from 'three/webgpu';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MapMaterials } from '../../ra2-assets/src/mapMaterials';
import { loadRa2Cache, resolveTerrainMaterials } from '../src/ra2/cache';
import { buildShoreField } from '../src/ra2/shoreField';

const ref = {
  file: 'terrain.png',
  waterMask: 'water.png',
  width: 128,
  height: 64,
  scale: 2,
  originX: -32,
  originY: 16,
};

describe('map material water overrides', () => {
  it('keeps the manifest assets and disables bed optics without a sidecar', () => {
    expect(resolveTerrainMaterials(ref, null)).toEqual({
      file: 'terrain.png',
      waterMask: 'water.png',
      shoreIgnore: undefined,
      waterBed: false,
      waterDetail: undefined,
      waterSurface: undefined,
      waterSurfaceScale: 13,
      paintedWaterline: false,
    });
  });

  it('preserves the legacy colour-matched sidecar without opting into bed optics', () => {
    expect(resolveTerrainMaterials(ref, { version: 1, terrainMap: 'matched.png' })).toEqual({
      file: 'matched.png',
      waterMask: 'water.png',
      shoreIgnore: undefined,
      waterBed: false,
      waterDetail: undefined,
      waterSurface: undefined,
      waterSurfaceScale: 13,
      paintedWaterline: false,
    });
  });

  it('prefers the replacement mask and exposes an explicit painted-bed flag without changing the manifest', () => {
    const material: MapMaterials = {
      version: 1,
      terrainMap: 'bed.png',
      waterMask: 'shore.png',
      shoreIgnore: 'cliffs.png',
      waterBed: true,
      waterDetail: 'water-detail.png',
    };
    expect(resolveTerrainMaterials(Object.freeze(ref), Object.freeze(material))).toEqual({
      file: 'bed.png',
      waterMask: 'shore.png',
      shoreIgnore: 'cliffs.png',
      waterBed: true,
      waterDetail: 'water-detail.png',
      waterSurface: undefined,
      waterSurfaceScale: 13,
      paintedWaterline: false,
    });
    expect(ref.waterMask).toBe('water.png');
  });

  it('allows a mask override independently of a bed or colour override', () => {
    expect(resolveTerrainMaterials(ref, { version: 1, waterMask: 'shore.png', waterBed: false })).toEqual({
      file: 'terrain.png',
      waterMask: 'shore.png',
      shoreIgnore: undefined,
      waterBed: false,
      waterDetail: undefined,
      waterSurface: undefined,
      waterSurfaceScale: 13,
      paintedWaterline: false,
    });
  });

  it('follows the painted waterline only for a sidecar that says so about its own mask, never with a lake bed', () => {
    const painted = (material: Record<string, unknown>) =>
      resolveTerrainMaterials(ref, JSON.parse(JSON.stringify({ version: 1, ...material })) as MapMaterials)
        .paintedWaterline;
    expect(painted({ waterMask: 'water-wl.png', waterline: 'painted' })).toBe(true);
    // The flag describes the replacement mask: without one the manifest's whole-cell mask is in use.
    expect(painted({ waterline: 'painted' })).toBe(false);
    expect(painted({ waterMask: 'water-wl.png' })).toBe(false);
    expect(painted({ waterMask: 'water-wl.png', waterline: true })).toBe(false);
    expect(painted({ waterMask: 'water-wl.png', waterline: 'cells' })).toBe(false);
    // The lake-bed shoreline has its own mask and distance fields.
    expect(painted({ waterMask: 'water-wl.png', waterline: 'painted', waterBed: true })).toBe(false);
  });

  it('can supply a mask when the manifest has none, without inventing a missing mask', () => {
    const { waterMask: _unused, ...withoutMask } = ref;
    expect(resolveTerrainMaterials(withoutMask, null).waterMask).toBeUndefined();
    expect(resolveTerrainMaterials(withoutMask, { version: 1, waterMask: 'shore.png' }).waterMask).toBe('shore.png');
  });

  it('does not opt into bed optics for a truthy non-boolean JSON value', () => {
    const material = JSON.parse('{"version":1,"waterBed":"true"}') as MapMaterials;
    expect(resolveTerrainMaterials(ref, material).waterBed).toBe(false);
  });

  it('allows shore-ignore without other overrides', () => {
    expect(resolveTerrainMaterials(ref, { version: 1, shoreIgnore: 'cliffs.png' })).toEqual({
      file: 'terrain.png',
      waterMask: 'water.png',
      shoreIgnore: 'cliffs.png',
      waterBed: false,
      waterDetail: undefined,
      waterSurface: undefined,
      waterSurfaceScale: 13,
      paintedWaterline: false,
    });
  });

  it.each([true, 128, null, {}, []])('ignores a non-string shoreIgnore JSON value: %j', (shoreIgnore) => {
    const material = JSON.parse(JSON.stringify({ version: 1, shoreIgnore, terrainMap: 'matched.png' })) as MapMaterials;
    expect(resolveTerrainMaterials(ref, material)).toEqual({
      file: 'matched.png',
      waterMask: 'water.png',
      shoreIgnore: undefined,
      waterBed: false,
      waterDetail: undefined,
      waterSurface: undefined,
      waterSurfaceScale: 13,
      paintedWaterline: false,
    });
  });

  it('allows water detail independently of other overrides', () => {
    expect(resolveTerrainMaterials(ref, { version: 1, waterDetail: 'water-detail.png' }).waterDetail).toBe(
      'water-detail.png',
    );
  });

  it.each([true, 128, null, {}, []])('ignores a non-string waterDetail JSON value: %j', (waterDetail) => {
    const material = JSON.parse(
      JSON.stringify({ version: 1, waterDetail, terrainMap: 'matched.png', waterBed: true }),
    ) as MapMaterials;
    expect(resolveTerrainMaterials(ref, material)).toEqual({
      file: 'matched.png',
      waterMask: 'water.png',
      shoreIgnore: undefined,
      waterBed: true,
      waterDetail: undefined,
      waterSurface: undefined,
      waterSurfaceScale: 13,
      paintedWaterline: false,
    });
  });

  it.each([0.5, 7, 26])('resolves a water surface tile with a positive scale: %s', (waterSurfaceScale) => {
    expect(resolveTerrainMaterials(ref, { version: 1, waterSurface: 'surface.png', waterSurfaceScale })).toEqual({
      file: 'terrain.png',
      waterMask: 'water.png',
      shoreIgnore: undefined,
      waterBed: false,
      waterDetail: undefined,
      waterSurface: 'surface.png',
      waterSurfaceScale,
      paintedWaterline: false,
    });
  });

  it.each([true, false, 128, null, {}, []].map((waterSurface) => ({ waterSurface })))(
    'ignores a non-string waterSurface JSON value: $waterSurface',
    ({ waterSurface }) => {
      const material = JSON.parse(
        JSON.stringify({ version: 1, waterSurface, waterSurfaceScale: 7, terrainMap: 'matched.png', waterBed: true }),
      ) as MapMaterials;
      expect(resolveTerrainMaterials(ref, material)).toEqual({
        file: 'matched.png',
        waterMask: 'water.png',
        shoreIgnore: undefined,
        waterBed: true,
        waterDetail: undefined,
        waterSurface: undefined,
        waterSurfaceScale: 7,
        paintedWaterline: false,
      });
    },
  );

  it.each([undefined, 0, -2, true, false, '8', null, {}, []].map((waterSurfaceScale) => ({ waterSurfaceScale })))(
    'defaults an absent, non-positive or non-number waterSurfaceScale to 13: $waterSurfaceScale',
    ({ waterSurfaceScale }) => {
      const material = JSON.parse(
        JSON.stringify({ version: 1, waterSurface: 'surface.png', waterSurfaceScale }),
      ) as MapMaterials;
      expect(resolveTerrainMaterials(ref, material)).toEqual({
        file: 'terrain.png',
        waterMask: 'water.png',
        shoreIgnore: undefined,
        waterBed: false,
        waterDetail: undefined,
        waterSurface: 'surface.png',
        waterSurfaceScale: 13,
        paintedWaterline: false,
      });
    },
  );
});

describe('map material cache loading', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function fixture(materials: unknown = { version: 1, shoreIgnore: 'cliffs.png' }, hasWater = true) {
    const width = 16;
    const height = 8;
    const water = Uint8Array.from({ length: width * height }, (_, i) => (i % width < 8 ? 0 : 255));
    type FixtureImage = { width: number; height: number; bytes: Uint8Array; rgba?: Uint8Array };
    const blank: FixtureImage = { width, height, bytes: new Uint8Array(water.length) };
    const images = new Map<string, FixtureImage>([
      ['atlas.png', blank],
      ['terrain.png', blank],
      ['water.png', { width, height, bytes: water }],
      ['cliffs.png', { width, height, bytes: new Uint8Array(water.length).fill(255) }],
    ]);
    const manifest = {
      cells: { tile: 'AAA=', exists: 'AQ==', height: 'AA==' },
      terrainAtlas: { file: 'atlas.png', width, height },
      spriteAtlas: { file: 'sprites.png' },
      terrainMap: { ...ref, width, height, waterMask: hasWater ? 'water.png' : undefined },
      tiles: [],
      palettes: {},
      voxels: {},
    };
    const fetchFile = vi.fn(async (url: string) => {
      const file = url.split('/').at(-1)!;
      if (file === 'manifest.json') return Response.json(manifest);
      if (file === 'materials.json') return Response.json(materials);
      if (file.endsWith('.json')) return new Response(null, { status: 404 });
      if (!images.has(file)) throw new Error(`Missing fixture: ${file}`);
      return new Response(new Blob([file]));
    });
    vi.stubGlobal('fetch', fetchFile);
    vi.stubGlobal('createImageBitmap', async (blob: Blob) => images.get(await blob.text())!);
    vi.stubGlobal(
      'OffscreenCanvas',
      class {
        getContext() {
          let data: Uint8ClampedArray;
          return {
            drawImage(image: typeof blank) {
              data = image.rgba
                ? new Uint8ClampedArray(image.rgba)
                : new Uint8ClampedArray(image.bytes.length * 4).fill(255);
              if (!image.rgba) image.bytes.forEach((value, i) => (data[i * 4] = value));
            },
            getImageData: () => ({ data }),
          };
        }
      },
    );
    const loadTexture = vi.spyOn(TextureLoader.prototype, 'loadAsync').mockImplementation(async (url) => {
      const file = url.split('/').at(-1)!;
      const texture = new Texture();
      if (file !== 'sprites.png') {
        const image = images.get(file);
        if (!image) throw new Error(`Missing fixture: ${file}`);
        texture.image = image;
      }
      return texture;
    });
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    return { images, fetchFile, loadTexture, warn, water, width, height };
  }

  it.each([false, true])('applies the loaded bytes to both distance fields (waterBed=%s)', async (waterBed) => {
    const { images, warn, water } = fixture({ version: 1, shoreIgnore: 'cliffs.png', waterBed });
    images.get('cliffs.png')!.bytes = water.map((value) => 255 - value);
    const cache = await loadRa2Cache('/map');
    const map = cache.terrainMap!;
    expect(map.waterMask.image.data).toEqual(water);
    const values = map.shore.image.data as Uint8Array | Uint16Array;
    const width = waterBed ? 8 : 4;
    expect(Array.from(values)).toEqual(
      Array.from({ length: values.length }, (_, i) => (i % width < width / 2 ? 0 : waterBed ? 0x3c00 : 255)),
    );
    expect(map.cliff).not.toBeNull();
    expect(map.cliff!.type).toBe(HalfFloatType);
    expect([map.cliff!.image.width, map.cliff!.image.height]).toEqual([map.shore.image.width, map.shore.image.height]);
    const cliff = map.cliff!.image.data as Uint16Array;
    const step = waterBed ? 2 : 4;
    for (let i = 0; i < cliff.length; i++) {
      const distance = (Math.max(0, (i % width) - (width / 2 - 1)) * step * Math.SQRT2) / (ref.scale * 60);
      expect(DataUtils.fromHalfFloat(cliff[i]!) * 1.5).toBeCloseTo(distance, 3);
    }
    expect(warn).not.toHaveBeenCalled();
  });

  it.each(['width', 'height', 'same-area', 'load failure'])(
    'warns once and preserves the field on %s',
    async (problem) => {
      const { images, warn, water, width, height } = fixture();
      const ignore = images.get('cliffs.png')!;
      if (problem === 'width') ignore.width--;
      else if (problem === 'height') ignore.height--;
      else if (problem === 'same-area') [ignore.width, ignore.height] = [height, width];
      else images.delete('cliffs.png');
      const cache = await loadRa2Cache('/map');
      const baseline = buildShoreField(water, width, height, ref.scale);
      expect(cache.terrainMap!.shore.image.data).toEqual(baseline.texture.image.data);
      expect(cache.terrainMap!.cliff).toBeNull();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]![0]).toContain('/map/cliffs.png');
      baseline.texture.dispose();
    },
  );

  it('does not load shore-ignore without a water mask', async () => {
    const { fetchFile, warn } = fixture(undefined, false);
    const cache = await loadRa2Cache('/map');
    expect(fetchFile).not.toHaveBeenCalledWith('/map/cliffs.png');
    expect(cache.terrainMap!.shore.image.data).toEqual(new Uint8Array(1));
    expect(cache.terrainMap!.cliff).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });

  it.each([{}, { shoreIgnore: true }, { shoreIgnore: null }, { version: 2, shoreIgnore: 'cliffs.png' }])(
    'keeps legacy loading when the optional override is absent or invalid: %j',
    async (overrides) => {
      const { fetchFile, warn, water, width, height } = fixture({ version: 1, ...overrides });
      const cache = await loadRa2Cache('/map');
      const baseline = buildShoreField(water, width, height, ref.scale);
      expect(fetchFile).not.toHaveBeenCalledWith('/map/cliffs.png');
      expect(cache.terrainMap!.shore.image.data).toEqual(baseline.texture.image.data);
      expect(cache.terrainMap!.cliff).toBeNull();
      expect(warn).not.toHaveBeenCalled();
      baseline.texture.dispose();
    },
  );

  it('bypasses shore-ignore with the rest of the sidecar when colour matching is disabled', async () => {
    const { fetchFile, warn } = fixture();
    const cache = await loadRa2Cache('/map', { colourMatched: false });
    expect(cache.terrainMap!.cliff).toBeNull();
    expect(fetchFile).not.toHaveBeenCalledWith('/map/materials.json');
    expect(fetchFile).not.toHaveBeenCalledWith('/map/cliffs.png');
    expect(warn).not.toHaveBeenCalled();
  });

  it('loads smaller water detail with the same top-down orientation as the mask and composite', async () => {
    const { images, loadTexture, warn, water, width, height } = fixture({
      version: 1,
      waterDetail: 'detail.png',
      waterBed: true,
    });
    // Unequal top/bottom rows and left/right halves expose either UV flip; detail covers the same area at half size.
    const marker = (u: number, v: number) => (v < 0.5 ? 16 : 224) + (u < 0.5 ? 0 : 1);
    for (let i = 0; i < water.length; i++) water[i] = marker((i % width) / width, Math.floor(i / width) / height);
    images.get('terrain.png')!.bytes = water.slice();
    const detailW = width / 2;
    const detailH = height / 2;
    const rgba = new Uint8Array(detailW * detailH * 4);
    for (let i = 0; i < detailW * detailH; i++) {
      rgba.set([marker((i % detailW) / detailW, Math.floor(i / detailW) / detailH), 93, 174, (i % 3) * 127], i * 4);
    }
    images.set('detail.png', { width: detailW, height: detailH, bytes: new Uint8Array(), rgba });
    const map = (await loadRa2Cache('/map')).terrainMap!;
    const detail = map.waterDetail!;
    expect(loadTexture).toHaveBeenCalledWith('/map/detail.png');
    expect(detail.colorSpace).toBe(SRGBColorSpace);
    expect(detail.magFilter).toBe(LinearFilter);
    expect(detail.minFilter).toBe(LinearMipmapLinearFilter);
    expect(detail.generateMipmaps).toBe(true);
    expect([detail.wrapS, detail.wrapT]).toEqual([ClampToEdgeWrapping, ClampToEdgeWrapping]);
    expect(detail.premultiplyAlpha).toBe(false);
    expect([detail.flipY, map.waterMask.flipY, map.texture.flipY]).toEqual([false, false, false]);
    expect(detail.image.rgba).toEqual(rgba);
    for (const [u, v] of [
      [0.25, 0.25],
      [0.75, 0.25],
      [0.25, 0.75],
      [0.75, 0.75],
    ]) {
      const i = Math.floor(v * height) * width + Math.floor(u * width);
      const d = Math.floor(v * detailH) * detailW + Math.floor(u * detailW);
      expect(detail.image.rgba[d * 4]).toBe(map.waterMask.image.data[i]);
      expect(detail.image.rgba[d * 4]).toBe(map.texture.image.data[i * 4]);
    }
    expect(warn).not.toHaveBeenCalled();
  });

  it('warns and leaves water detail null on a load failure without failing the map', async () => {
    const { warn } = fixture({ version: 1, waterDetail: 'missing.png', waterBed: true });
    const map = (await loadRa2Cache('/map')).terrainMap!;
    expect(map.waterBed).toBe(true);
    expect(map.waterDetail).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain('/map/missing.png');
  });

  it.each([{}, { waterDetail: true }, { waterDetail: null }, { version: 2, waterDetail: 'detail.png' }])(
    'does not load absent or invalid water detail: %j',
    async (overrides) => {
      const { loadTexture, warn } = fixture({ version: 1, ...overrides });
      const map = (await loadRa2Cache('/map')).terrainMap!;
      expect(map.waterDetail).toBeNull();
      expect(loadTexture).toHaveBeenCalledTimes(1); // The original sprite atlas only.
      expect(warn).not.toHaveBeenCalled();
    },
  );

  it('bypasses water detail when colour matching is disabled', async () => {
    const { loadTexture, warn } = fixture({ version: 1, waterDetail: 'detail.png' });
    const map = (await loadRa2Cache('/map', { colourMatched: false })).terrainMap!;
    expect(map.waterDetail).toBeNull();
    expect(loadTexture).not.toHaveBeenCalledWith('/map/detail.png');
    expect(warn).not.toHaveBeenCalled();
  });

  it.each([
    { waterSurfaceScale: undefined, expectedScale: 13 },
    { waterSurfaceScale: 6.5, expectedScale: 6.5 },
  ])('loads a repeating water surface tile with scale $expectedScale', async ({ waterSurfaceScale, expectedScale }) => {
    const { images, loadTexture, warn } = fixture({
      version: 1,
      waterSurface: 'surface.png',
      waterSurfaceScale,
      waterBed: true,
    });
    const rgba = new Uint8Array([128, 0, 0, 255, 160, 64, 16, 255, 96, 128, 32, 255, 192, 192, 255, 255]);
    images.set('surface.png', { width: 2, height: 2, bytes: new Uint8Array(), rgba });
    const map = (await loadRa2Cache('/map')).terrainMap!;
    expect(map.waterSurface).toEqual({ texture: expect.any(Texture), scale: expectedScale });
    const { texture } = map.waterSurface!;
    expect(loadTexture).toHaveBeenCalledWith('/map/surface.png');
    expect(texture.colorSpace).toBe(NoColorSpace);
    expect(texture.magFilter).toBe(LinearFilter);
    expect(texture.minFilter).toBe(LinearMipmapLinearFilter);
    expect(texture.generateMipmaps).toBe(true);
    expect(texture.anisotropy).toBe(8);
    expect([texture.wrapS, texture.wrapT]).toEqual([RepeatWrapping, RepeatWrapping]);
    expect(texture.premultiplyAlpha).toBe(false);
    expect(texture.flipY).toBe(false);
    expect(texture.image.rgba).toEqual(rgba);
    expect(warn).not.toHaveBeenCalled();
  });

  it.each(['missing file', 'load failure'])('warns once and leaves water surface null on %s', async (problem) => {
    const { images, loadTexture, warn } = fixture({ version: 1, waterSurface: 'surface.png', waterBed: true });
    if (problem === 'load failure') {
      images.set('surface.png', { width: 2, height: 2, bytes: new Uint8Array(4) });
      const loadFixture = loadTexture.getMockImplementation()!;
      loadTexture.mockImplementation(async (url) => {
        if (url === '/map/surface.png') throw new Error('Invalid surface image');
        return loadFixture(url);
      });
    }
    const map = (await loadRa2Cache('/map')).terrainMap!;
    expect(map.waterBed).toBe(true);
    expect(map.waterSurface).toBeNull();
    expect(loadTexture).toHaveBeenCalledWith('/map/surface.png');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('/map/surface.png: failed to load water surface; ignoring it', expect.any(Error));
  });

  it.each([{}, { waterSurface: true }, { waterSurface: null }, { version: 2, waterSurface: 'surface.png' }])(
    'does not load absent or invalid water surface: %j',
    async (overrides) => {
      const { loadTexture, warn } = fixture({ version: 1, ...overrides });
      const map = (await loadRa2Cache('/map')).terrainMap!;
      expect(map.waterSurface).toBeNull();
      expect(loadTexture).toHaveBeenCalledTimes(1); // The original sprite atlas only.
      expect(warn).not.toHaveBeenCalled();
    },
  );

  it('bypasses water surface when colour matching is disabled', async () => {
    const { loadTexture, warn } = fixture({ version: 1, waterSurface: 'surface.png', waterSurfaceScale: 7 });
    const map = (await loadRa2Cache('/map', { colourMatched: false })).terrainMap!;
    expect(map.waterSurface).toBeNull();
    expect(loadTexture).not.toHaveBeenCalledWith('/map/surface.png');
    expect(warn).not.toHaveBeenCalled();
  });
});
