import { describe, it, expect } from 'vitest';
import {
  VxlFile,
  VXL_HEADER_SIZE,
  VXL_SECTION_HEADER_SIZE,
  VXL_SECTION_TAILER_SIZE,
  VXL_ID,
  VXL_MAGIC,
} from './vxlFile.js';

/** One solid voxel to encode into a synthetic section column. */
interface SynthVoxel {
  x: number;
  y: number;
  z: number;
  color: number;
  normal: number;
}

/**
 * Build a synthetic single-section VXL with the given grid dims and voxels,
 * encoding each column as: skip to the first solid z, one run of the contiguous
 * solid voxels, then a trailing count byte. Voxels within a column must be
 * contiguous in z for this simple encoder (the tests use single-voxel columns).
 */
function buildVxl(opts: {
  cx: number;
  cy: number;
  cz: number;
  normalsMode: number;
  voxels: SynthVoxel[];
  name?: string;
}): Uint8Array {
  const { cx, cy, cz, normalsMode, voxels } = opts;
  const name = opts.name ?? 'DUMMY01';

  // Group voxels by column (x + cx*y), assert contiguity, and encode each column.
  const byColumn = new Map<number, SynthVoxel[]>();
  for (const v of voxels) {
    const col = v.x + cx * v.y;
    const list = byColumn.get(col) ?? [];
    list.push(v);
    byColumn.set(col, list);
  }

  const columnCount = cx * cy;
  const spanStart: number[] = new Array<number>(columnCount).fill(-1);
  const spanEnd: number[] = new Array<number>(columnCount).fill(-1);
  const dataBytes: number[] = [];

  for (let col = 0; col < columnCount; col++) {
    const list = byColumn.get(col);
    if (!list || list.length === 0) continue;
    list.sort((a, b) => a.z - b.z);
    const start = dataBytes.length;
    // skip byte to the first solid z, then a run of the run-length voxels.
    dataBytes.push(list[0]!.z); // skip
    dataBytes.push(list.length); // count
    for (const v of list) {
      dataBytes.push(v.color);
      dataBytes.push(v.normal);
    }
    dataBytes.push(list.length); // trailing dup count
    // Fill remaining z with a final skip so z reaches cz (skip cz - lastZ - 1).
    const lastZ = list[list.length - 1]!.z;
    const remaining = cz - lastZ - 1;
    if (remaining > 0) {
      dataBytes.push(remaining); // skip
      dataBytes.push(0); // count 0
      dataBytes.push(0); // trailing
    }
    spanStart[col] = start;
    spanEnd[col] = dataBytes.length - 1;
  }

  const spanStartBytes = columnCount * 4;
  const spanEndBytes = columnCount * 4;
  const spanDataOfs = spanStartBytes + spanEndBytes;
  const bodySize = spanDataOfs + dataBytes.length;

  const total =
    VXL_HEADER_SIZE + VXL_SECTION_HEADER_SIZE + bodySize + VXL_SECTION_TAILER_SIZE;
  const buf = new Uint8Array(total);
  const dv = new DataView(buf.buffer);

  // Header.
  const enc = new TextEncoder();
  buf.set(enc.encode(VXL_ID), 0); // NUL-padded by the zeroed buffer
  dv.setInt32(16, 1, true); // one
  dv.setUint32(20, 1, true); // sectionHeaderCount
  dv.setUint32(24, 1, true); // sectionTailerCount
  dv.setUint32(28, bodySize, true);
  dv.setUint16(32, VXL_MAGIC, true);
  // Palette: make index i => (i, i, i) mod 64 for something non-trivial.
  for (let i = 0; i < 256; i++) {
    const p = 34 + i * 3;
    buf[p] = i & 63;
    buf[p + 1] = (i * 2) & 63;
    buf[p + 2] = (i * 3) & 63;
  }

  // Section header.
  const shOfs = VXL_HEADER_SIZE;
  buf.set(enc.encode(name), shOfs);
  dv.setInt32(shOfs + 16, 0, true); // index
  dv.setInt32(shOfs + 20, 1, true); // one
  dv.setInt32(shOfs + 24, 0, true); // zero

  // Body.
  const bodyOfs = shOfs + VXL_SECTION_HEADER_SIZE;
  for (let i = 0; i < columnCount; i++) dv.setInt32(bodyOfs + i * 4, spanStart[i]!, true);
  for (let i = 0; i < columnCount; i++)
    dv.setInt32(bodyOfs + spanStartBytes + i * 4, spanEnd[i]!, true);
  for (let i = 0; i < dataBytes.length; i++) buf[bodyOfs + spanDataOfs + i] = dataBytes[i]!;

  // Tailer.
  const tOfs = bodyOfs + bodySize;
  dv.setInt32(tOfs, 0, true); // spanStartOfs
  dv.setInt32(tOfs + 4, spanStartBytes, true); // spanEndOfs
  dv.setInt32(tOfs + 8, spanDataOfs, true); // spanDataOfs
  dv.setFloat32(tOfs + 12, 0.5, true); // scale
  // transform: identity-ish 3x4 with a translation.
  const tf = [1, 0, 0, 10, 0, 1, 0, 20, 0, 0, 1, 30];
  for (let k = 0; k < 12; k++) dv.setFloat32(tOfs + 16 + k * 4, tf[k]!, true);
  dv.setFloat32(tOfs + 64, -1, true); // minx
  dv.setFloat32(tOfs + 68, -2, true);
  dv.setFloat32(tOfs + 72, 0, true);
  dv.setFloat32(tOfs + 76, 3, true); // maxx
  dv.setFloat32(tOfs + 80, 4, true);
  dv.setFloat32(tOfs + 84, 5, true);
  buf[tOfs + 88] = cx;
  buf[tOfs + 89] = cy;
  buf[tOfs + 90] = cz;
  buf[tOfs + 91] = normalsMode;

  return buf;
}

describe('VxlFile.parse — synthetic', () => {
  it('parses the header, palette, tailer metadata and decodes voxels', () => {
    const voxels: SynthVoxel[] = [
      { x: 0, y: 0, z: 0, color: 10, normal: 5 },
      { x: 1, y: 0, z: 2, color: 20, normal: 6 },
      { x: 0, y: 1, z: 1, color: 30, normal: 7 },
    ];
    const bytes = buildVxl({ cx: 2, cy: 2, cz: 4, normalsMode: 4, voxels });
    const vxl = VxlFile.parse(bytes);

    expect(vxl.sectionCount).toBe(1);
    const s = vxl.sections[0]!;
    expect(s.name).toBe('DUMMY01');
    expect([s.cx, s.cy, s.cz]).toEqual([2, 2, 4]);
    expect(s.scale).toBeCloseTo(0.5, 6);
    expect(s.normalsMode).toBe(4);
    expect(s.transform).toEqual([1, 0, 0, 10, 0, 1, 0, 20, 0, 0, 1, 30]);
    expect(s.minBounds).toEqual([-1, -2, 0]);
    expect(s.maxBounds).toEqual([3, 4, 5]);

    // Palette entry 10 => (10, 20, 30) mod 64.
    expect(vxl.palette[10]).toEqual({ r: 10, g: 20, b: 30 });
  });

  it('roundtrips every solid voxel (coord/color/normal) through span decode', () => {
    const voxels: SynthVoxel[] = [
      { x: 0, y: 0, z: 0, color: 10, normal: 5 },
      { x: 1, y: 0, z: 2, color: 20, normal: 6 },
      { x: 0, y: 1, z: 1, color: 30, normal: 7 },
      { x: 1, y: 1, z: 3, color: 40, normal: 8 },
    ];
    const bytes = buildVxl({ cx: 2, cy: 2, cz: 4, normalsMode: 2, voxels });
    const s = VxlFile.parse(bytes).sections[0]!;

    const got = [...s.voxels]
      .map((v) => `${v.x},${v.y},${v.z},${v.color},${v.normal}`)
      .sort();
    const want = voxels
      .map((v) => `${v.x},${v.y},${v.z},${v.color},${v.normal}`)
      .sort();
    expect(got).toEqual(want);
  });

  it('handles a multi-voxel contiguous run in one column', () => {
    const voxels: SynthVoxel[] = [
      { x: 0, y: 0, z: 1, color: 11, normal: 1 },
      { x: 0, y: 0, z: 2, color: 12, normal: 2 },
      { x: 0, y: 0, z: 3, color: 13, normal: 3 },
    ];
    const bytes = buildVxl({ cx: 1, cy: 1, cz: 5, normalsMode: 4, voxels });
    const s = VxlFile.parse(bytes).sections[0]!;
    expect(s.voxels.length).toBe(3);
    expect(s.voxels.map((v) => [v.z, v.color, v.normal])).toEqual([
      [1, 11, 1],
      [2, 12, 2],
      [3, 13, 3],
    ]);
  });

  it('leaves empty columns empty', () => {
    const bytes = buildVxl({
      cx: 3,
      cy: 1,
      cz: 2,
      normalsMode: 4,
      voxels: [{ x: 2, y: 0, z: 0, color: 5, normal: 0 }],
    });
    const s = VxlFile.parse(bytes).sections[0]!;
    expect(s.voxels.length).toBe(1);
    expect(s.voxels[0]).toEqual({ x: 2, y: 0, z: 0, color: 5, normal: 0 });
  });

  it('resolves a section voxel normal through the right table', () => {
    const bytes = buildVxl({
      cx: 1,
      cy: 1,
      cz: 1,
      normalsMode: 2,
      voxels: [{ x: 0, y: 0, z: 0, color: 1, normal: 0 }],
    });
    const s = VxlFile.parse(bytes).sections[0]!;
    // TS table (mode 2), index 0.
    expect(VxlFile.normalVec(s, 0)).toEqual([
      0.6712139844894409, 0.19849200546741486, -0.7141939997673035,
    ]);
  });
});

describe('VxlFile.parse — validation', () => {
  const valid = buildVxl({
    cx: 1,
    cy: 1,
    cz: 1,
    normalsMode: 4,
    voxels: [{ x: 0, y: 0, z: 0, color: 1, normal: 0 }],
  });

  it('rejects a bad id', () => {
    const b = valid.slice();
    b[0] = 0x58; // 'X'
    expect(() => VxlFile.parse(b)).toThrow(/not a VXL/);
  });

  it('rejects a bad magic', () => {
    const b = valid.slice();
    new DataView(b.buffer).setUint16(32, 0x1234, true);
    expect(() => VxlFile.parse(b)).toThrow(/magic/);
  });

  it('rejects a body-size mismatch', () => {
    const b = valid.slice();
    new DataView(b.buffer).setUint32(28, 999999, true);
    expect(() => VxlFile.parse(b)).toThrow(/body-size mismatch/);
  });

  it('rejects a too-small buffer', () => {
    expect(() => VxlFile.parse(new Uint8Array(10))).toThrow(/too small/);
  });
});

describe('VxlFile.parse — determinism', () => {
  it('two parses of the same bytes produce identical voxel lists', () => {
    const bytes = buildVxl({
      cx: 2,
      cy: 2,
      cz: 3,
      normalsMode: 4,
      voxels: [
        { x: 0, y: 0, z: 0, color: 1, normal: 1 },
        { x: 1, y: 1, z: 2, color: 2, normal: 2 },
      ],
    });
    const a = JSON.stringify(VxlFile.parse(bytes).sections);
    const b = JSON.stringify(VxlFile.parse(bytes).sections);
    expect(a).toBe(b);
  });
});
