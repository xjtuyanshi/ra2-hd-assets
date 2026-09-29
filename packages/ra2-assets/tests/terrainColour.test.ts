/** Colour-matched HD terrain (src/node/terrainColour.ts) on synthetic images. */
import { describe, expect, it } from 'vitest';
import { labToSrgb, srgbToLab } from '../src/mapMaterials.ts';
import { colourMatchTerrain } from '../src/node/terrainColour.ts';
import type { PngImage } from '../src/node/png.ts';

function image(width: number, height: number, pixel: (x: number, y: number) => [number, number, number, number]) {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data.set(pixel(x, y), (y * width + x) * 4);
  return { width, height, channels: 4, data } satisfies PngImage;
}

const mean = (img: PngImage, c: number, x0: number, y0: number, x1: number, y1: number) => {
  let s = 0;
  let n = 0;
  for (let y = y0; y < y1; y++)
    for (let x = x0; x < x1; x++) {
      s += img.data[(y * img.width + x) * 4 + c]!;
      n++;
    }
  return s / n;
};

describe('terrain colour match', () => {
  it('round-trips sRGB through Lab', () => {
    const lab = [0, 0, 0];
    const rgb = [0, 0, 0];
    for (const c of [
      [0, 0, 0],
      [255, 255, 255],
      [200, 120, 30],
      [12, 90, 240],
    ] as const) {
      srgbToLab(c[0], c[1], c[2], lab);
      labToSrgb(lab[0]!, lab[1]!, lab[2]!, rgb);
      expect(rgb).toEqual([...c]);
    }
  });

  it('takes low-frequency colour from the original and keeps the HD detail', () => {
    // Original: two flat regions. HD (2x): the same regions with a colour/contrast drift plus fine stripes.
    const source = image(32, 16, (x) => (x < 16 ? [200, 190, 170, 255] : [60, 110, 40, 255]));
    const hd = image(64, 32, (x) => {
      const stripe = x % 2 ? 10 : -10;
      return x < 32 ? [170 + stripe, 168 + stripe, 160 + stripe, 255] : [80 + stripe, 115 + stripe, 60 + stripe, 255];
    });
    const out = colourMatchTerrain(hd, source, 1);
    // Region means (away from the boundary) now match the original within a couple of levels...
    expect(mean(out, 0, 4, 4, 24, 28)).toBeCloseTo(200, -0.5);
    expect(mean(out, 1, 4, 4, 24, 28)).toBeCloseTo(190, -0.5);
    expect(mean(out, 0, 40, 4, 60, 28)).toBeCloseTo(60, -0.5);
    expect(mean(out, 1, 40, 4, 60, 28)).toBeCloseTo(110, -0.5);
    // ...and the stripes survive with about their original amplitude.
    const a = out.data[(10 * 64 + 10) * 4 + 1]!;
    const b = out.data[(10 * 64 + 11) * 4 + 1]!;
    expect(Math.abs(a - b)).toBeGreaterThan(12);
    expect(out.data[3]).toBe(255);
  });

  it('leaves transparent pixels alone and rejects non-integer scales', () => {
    const source = image(8, 8, () => [100, 100, 100, 255]);
    const hd = image(16, 16, (x) => (x < 2 ? [1, 2, 3, 0] : [120, 120, 120, 255]));
    const out = colourMatchTerrain(hd, source, 1);
    expect([...out.data.slice(0, 4)]).toEqual([1, 2, 3, 0]);
    expect(() =>
      colourMatchTerrain(
        image(15, 16, () => [0, 0, 0, 255]),
        source,
        1,
      ),
    ).toThrow(/integer multiple/);
  });
});
