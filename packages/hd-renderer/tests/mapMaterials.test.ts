import { Texture, TextureLoader } from 'three/webgpu';
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
    });
  });

  it('preserves the legacy colour-matched sidecar without opting into bed optics', () => {
    expect(resolveTerrainMaterials(ref, { version: 1, terrainMap: 'matched.png' })).toEqual({
      file: 'matched.png',
      waterMask: 'water.png',
      shoreIgnore: undefined,
      waterBed: false,
    });
  });

  it('prefers the replacement mask and exposes an explicit painted-bed flag without changing the manifest', () => {
    const material: MapMaterials = {
      version: 1,
      terrainMap: 'bed.png',
      waterMask: 'shore.png',
      shoreIgnore: 'cliffs.png',
      waterBed: true,
    };
    expect(resolveTerrainMaterials(Object.freeze(ref), Object.freeze(material))).toEqual({
      file: 'bed.png',
      waterMask: 'shore.png',
      shoreIgnore: 'cliffs.png',
      waterBed: true,
    });
    expect(ref.waterMask).toBe('water.png');
  });

  it('allows a mask override independently of a bed or colour override', () => {
    expect(resolveTerrainMaterials(ref, { version: 1, waterMask: 'shore.png', waterBed: false })).toEqual({
      file: 'terrain.png',
      waterMask: 'shore.png',
      shoreIgnore: undefined,
      waterBed: false,
    });
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
    });
  });

  it.each([true, 128, null, {}, []])('ignores a non-string shoreIgnore JSON value: %j', (shoreIgnore) => {
    const material = JSON.parse(JSON.stringify({ version: 1, shoreIgnore, terrainMap: 'matched.png' })) as MapMaterials;
    expect(resolveTerrainMaterials(ref, material)).toEqual({
      file: 'matched.png',
      waterMask: 'water.png',
      shoreIgnore: undefined,
      waterBed: false,
    });
  });
});

describe('shore-ignore cache loading', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function fixture(materials: unknown = { version: 1, shoreIgnore: 'cliffs.png' }, hasWater = true) {
    const width = 16;
    const height = 8;
    const water = Uint8Array.from({ length: width * height }, (_, i) => (i % width < 8 ? 0 : 255));
    const blank = { width, height, bytes: new Uint8Array(water.length) };
    const images = new Map([
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
              data = new Uint8ClampedArray(image.bytes.length * 4).fill(255);
              image.bytes.forEach((value, i) => (data[i * 4] = value));
            },
            getImageData: () => ({ data }),
          };
        }
      },
    );
    vi.spyOn(TextureLoader.prototype, 'loadAsync').mockImplementation(async () => new Texture());
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    return { images, fetchFile, warn, water, width, height };
  }

  it.each([false, true])('applies the loaded bytes to the field only (waterBed=%s)', async (waterBed) => {
    const { warn, water } = fixture({ version: 1, shoreIgnore: 'cliffs.png', waterBed });
    const cache = await loadRa2Cache('/map');
    const map = cache.terrainMap!;
    expect(map.waterMask.image.data).toEqual(water);
    const values = map.shore.image.data as Uint8Array | Uint16Array;
    const width = waterBed ? 8 : 4;
    expect(Array.from(values)).toEqual(
      Array.from({ length: values.length }, (_, i) => (i % width < width / 2 ? 0 : waterBed ? 0x3c00 : 255)),
    );
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
      expect(warn).not.toHaveBeenCalled();
      baseline.texture.dispose();
    },
  );

  it('bypasses shore-ignore with the rest of the sidecar when colour matching is disabled', async () => {
    const { fetchFile, warn } = fixture();
    await loadRa2Cache('/map', { colourMatched: false });
    expect(fetchFile).not.toHaveBeenCalledWith('/map/materials.json');
    expect(fetchFile).not.toHaveBeenCalledWith('/map/cliffs.png');
    expect(warn).not.toHaveBeenCalled();
  });
});
