import { describe, expect, it } from 'vitest';
import { MapLightGrade } from '../src/ra2/mapLighting';

/** A 4 x 1 strip with one lamp post (INGALITE-like: +50 %, near-neutral tint) at its left end. */
function strip(): MapLightGrade {
  return new MapLightGrade(
    { width: 4, height: 1, z: new Uint8Array(4), exists: new Uint8Array(4).fill(1) },
    { ambient: 1, level: 0, ground: 0, red: 1, green: 0.8, blue: 0.68 },
    [{ position: [128, 128, 0], radius: 1000, intensity: 0.5, tint: [0.05, 0.05, 0.01] }],
  );
}
const texels = (g: MapLightGrade) => Array.from(g.texture.image.data as Uint8Array);

describe('map light sources by day (HdSettings.mapSourcesByDay)', () => {
  it('keeps the engine texels exactly at share 1 and drops only the sources at share 0', () => {
    const lamp = strip();
    const engine = texels(lamp);
    lamp.setSourceWeight(1);
    expect(texels(lamp)).toEqual(engine);
    const plain = new MapLightGrade(
      { width: 4, height: 1, z: new Uint8Array(4), exists: new Uint8Array(4).fill(1) },
      { ambient: 1, level: 0, ground: 0, red: 1, green: 0.8, blue: 0.68 },
    );
    lamp.setSourceWeight(0);
    expect(texels(lamp)).toEqual(texels(plain));
    // The lamp cell is brighter than plain ground at full share, in between at 0.3.
    lamp.setSourceWeight(0.3);
    const mid = texels(lamp);
    expect(mid[0]).toBeGreaterThan(texels(plain)[0]!);
    expect(mid[0]).toBeLessThan(engine[0]!);
    plain.dispose();
    lamp.dispose();
  });
});
