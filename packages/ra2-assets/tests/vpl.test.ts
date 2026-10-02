/** voxels.vpl parser on synthetic files (no game data). */
import { describe, expect, it } from 'vitest';
import { VPL_HEADER_BYTES, VPL_PALETTE_BYTES, parseVpl } from '../src/vpl.ts';

function syntheticVpl(sections: number, extra = 0): Uint8Array {
  const bytes = new Uint8Array(VPL_HEADER_BYTES + VPL_PALETTE_BYTES + sections * 256 + extra);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 16, true);
  view.setUint32(4, 31, true);
  view.setUint32(8, sections, true);
  view.setUint32(12, 0xcdcdcdcd, true);
  for (let i = 0; i < VPL_PALETTE_BYTES; i++) bytes[VPL_HEADER_BYTES + i] = (i * 7) & 0xff;
  // Row s maps index i to (i + s) & 0xff: every entry of every row is distinguishable.
  const start = VPL_HEADER_BYTES + VPL_PALETTE_BYTES;
  for (let s = 0; s < sections; s++) for (let i = 0; i < 256; i++) bytes[start + s * 256 + i] = (i + s) & 0xff;
  return bytes;
}

describe('parseVpl', () => {
  it('reads the header, palette and every section row of a retail-sized file', () => {
    const bytes = syntheticVpl(32);
    expect(bytes.byteLength).toBe(8976);
    const vpl = parseVpl(bytes);
    expect(vpl).toMatchObject({ remapStart: 16, remapEnd: 31, sectionCount: 32, unknown: 0xcdcdcdcd });
    expect(vpl.palette.length).toBe(768);
    expect(vpl.palette[5]).toBe(35);
    expect(vpl.table.length).toBe(32 * 256);
    expect(vpl.table[0]).toBe(0);
    expect(vpl.table[31 * 256 + 250]).toBe((250 + 31) & 0xff);
  });

  it('works on a subarray view and ignores trailing bytes', () => {
    const inner = syntheticVpl(4, 10);
    const outer = new Uint8Array(inner.length + 3);
    outer.set(inner, 3);
    const vpl = parseVpl(outer.subarray(3));
    expect(vpl.sectionCount).toBe(4);
    expect(vpl.table.length).toBe(4 * 256);
    expect(vpl.table[3 * 256 + 1]).toBe(4);
  });

  it('rejects truncated files and implausible section counts', () => {
    expect(() => parseVpl(new Uint8Array(100))).toThrow(/shorter/);
    expect(() => parseVpl(syntheticVpl(32).subarray(0, 8000))).toThrow(/needed/);
    const zero = syntheticVpl(1);
    new DataView(zero.buffer).setUint32(8, 0, true);
    expect(() => parseVpl(zero)).toThrow(/section count/);
  });
});
