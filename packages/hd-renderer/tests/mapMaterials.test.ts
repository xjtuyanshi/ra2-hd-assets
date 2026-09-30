import { describe, expect, it } from 'vitest';
import type { MapMaterials } from '../../ra2-assets/src/mapMaterials';
import { resolveTerrainMaterials } from '../src/ra2/cache';

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
      waterBed: false,
    });
  });

  it('preserves the legacy colour-matched sidecar without opting into bed optics', () => {
    expect(resolveTerrainMaterials(ref, { version: 1, terrainMap: 'matched.png' })).toEqual({
      file: 'matched.png',
      waterMask: 'water.png',
      waterBed: false,
    });
  });

  it('prefers the replacement mask and exposes an explicit painted-bed flag without changing the manifest', () => {
    const material: MapMaterials = { version: 1, terrainMap: 'bed.png', waterMask: 'shore.png', waterBed: true };
    expect(resolveTerrainMaterials(Object.freeze(ref), Object.freeze(material))).toEqual({
      file: 'bed.png',
      waterMask: 'shore.png',
      waterBed: true,
    });
    expect(ref.waterMask).toBe('water.png');
  });

  it('allows a mask override independently of a bed or colour override', () => {
    expect(resolveTerrainMaterials(ref, { version: 1, waterMask: 'shore.png', waterBed: false })).toEqual({
      file: 'terrain.png',
      waterMask: 'shore.png',
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
});
