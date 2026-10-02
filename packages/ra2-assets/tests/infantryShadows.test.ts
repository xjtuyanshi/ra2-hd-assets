import { describe, expect, it } from 'vitest';
import { ShpFile } from 'ra2-formats';
import { decodeShp, packSprites, SpriteCollector, type InstallView } from '../src/node/artSource.ts';

/** Stock-like body/empty-shadow layout, with optional real baked shadows. */
function synthetic(baked = false) {
  const data = new Uint8Array(8 + 4 * 24 + 12 + (baked ? 12 : 0));
  const dv = new DataView(data.buffer);
  dv.setUint16(2, 10, true);
  dv.setUint16(4, 12, true);
  dv.setUint16(6, 4, true);
  const pixels = [
    [0, 40, 0, 12, 12, 0],
    [12, 0, 41, 0, 12, 12],
    [0, 1, 0, 1, 1, 0],
    [1, 0, 1, 0, 1, 0],
  ];
  for (let i = 0; i < (baked ? 4 : 2); i++) {
    const p = 8 + i * 24;
    dv.setInt16(p, 2 + i, true);
    dv.setInt16(p + 2, 6 + i, true);
    dv.setInt16(p + 4, 3, true);
    dv.setInt16(p + 6, 2, true);
    dv.setInt32(p + 20, 104 + i * 6, true);
    data.set(pixels[i]!, 104 + i * 6);
  }
  return ShpFile.parse(data);
}

describe('infantry inline SHP shadows', () => {
  it('recovers index 12 from the selected body frame when the index-1 half is empty, preserving bodies', () => {
    const shp = synthetic();
    const install = { has: () => true, shp: () => shp } as unknown as InstallView;
    const collector = new SpriteCollector(install, () => {});
    const s = collector.addShp('infantry:TEST', ['test.shp'], 'unit', true, {}, () => [1, 0], 12)!;
    expect(s.entry.sourceFrames).toEqual([1, 0]);
    expect(s.frames.map((f) => [...f.pixels])).toEqual([
      [12, 0, 41, 0, 12, 12],
      [0, 40, 0, 12, 12, 0],
    ]);
    expect(s.shadows!.map((f) => [...f.pixels])).toEqual([
      [1, 0, 0, 0, 1, 1],
      [0, 0, 0, 1, 1, 0],
    ]);
    expect(s.shadows!.map((f) => f.offset)).toEqual(s.frames.map((f) => f.offset));
    expect(
      decodeShp(shp)
        .slice(2)
        .every((f) => f.pixels.length === 0),
    ).toBe(true);
    const packed = packSprites(collector.sprites, { format: 'indexed', maxPage: 32 });
    for (const f of packed.entries['infantry:TEST']!.shadows!) {
      expect(f.rect[2]).toBe(3);
      const page = packed.pages[f.page ?? 0]!;
      expect(page.data[(f.rect[1] + 1) * page.width + f.rect[0] + 1]).toBe(1);
    }
  });

  it('prefers genuine shadow-half art and leaves unconfigured building/vehicle extraction identical', () => {
    const shp = synthetic(true);
    const collector = new SpriteCollector({ has: () => true, shp: () => shp } as unknown as InstallView, () => {});
    const infantry = collector.addShp('infantry:TEST', ['t'], 'unit', true, {}, undefined, 12)!;
    const building = collector.addShp('building:TEST', ['t'], 'unit', true)!;
    expect(infantry.frames).toEqual(building.frames);
    expect(infantry.shadows).toEqual(building.shadows);
    const empty = new SpriteCollector({ has: () => true, shp: () => synthetic() } as unknown as InstallView, () => {});
    expect(empty.addShp('vehicle:TEST', ['t'], 'unit', true)!.shadows!.every((f) => f.w === 0)).toBe(true);
  });
});
