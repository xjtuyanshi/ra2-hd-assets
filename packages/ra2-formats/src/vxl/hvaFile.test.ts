import { describe, it, expect } from 'vitest';
import {
  HvaFile,
  HVA_HEADER_SIZE,
  HVA_SECTION_NAME_SIZE,
  HVA_MATRIX_SIZE,
} from './hvaFile.js';

/**
 * Build a synthetic HVA. `matrices[section][frame]` is a length-12 row-major 3x4
 * matrix; section names are the given strings. Matrices are written frame-major
 * (all sections of frame 0, then frame 1, ...), as in the retail files.
 */
function buildHva(names: string[], matrices: number[][][]): Uint8Array {
  const sectionCount = names.length;
  const frameCount = matrices[0]?.length ?? 0;
  const total =
    HVA_HEADER_SIZE + (HVA_MATRIX_SIZE * frameCount + HVA_SECTION_NAME_SIZE) * sectionCount;
  const buf = new Uint8Array(total);
  const dv = new DataView(buf.buffer);
  const enc = new TextEncoder();

  buf.set(enc.encode('NONE'), 0);
  dv.setInt32(16, frameCount, true);
  dv.setInt32(20, sectionCount, true);

  const namesStart = HVA_HEADER_SIZE;
  for (let i = 0; i < sectionCount; i++) {
    buf.set(enc.encode(names[i]!), namesStart + i * HVA_SECTION_NAME_SIZE);
  }

  const matStart = namesStart + sectionCount * HVA_SECTION_NAME_SIZE;
  for (let i = 0; i < sectionCount; i++) {
    for (let j = 0; j < frameCount; j++) {
      const base = matStart + (sectionCount * j + i) * HVA_MATRIX_SIZE;
      const m = matrices[i]![j]!;
      for (let k = 0; k < 12; k++) dv.setFloat32(base + k * 4, m[k]!, true);
    }
  }
  return buf;
}

describe('HvaFile.parse — synthetic', () => {
  it('parses a single-section single-frame HVA (body-only vehicle case)', () => {
    const m = [1, 0, 0, 5, 0, 1, 0, 6, 0, 0, 1, 7];
    const bytes = buildHva(['DUMMY01'], [[m]]);
    const hva = HvaFile.parse(bytes);
    expect(hva.frameCount).toBe(1);
    expect(hva.sectionCount).toBe(1);
    expect(hva.sectionNames).toEqual(['DUMMY01']);
    expect([...hva.matrix(0, 0)]).toEqual(m);
  });

  it('maps the frame-major file layout to matrix(section, frame)', () => {
    // 2 sections, 2 frames — distinct values per (section,frame).
    const s0f0 = [0, 0, 0, 100, 0, 0, 0, 0, 0, 0, 0, 0];
    const s0f1 = [0, 0, 0, 101, 0, 0, 0, 0, 0, 0, 0, 0];
    const s1f0 = [0, 0, 0, 200, 0, 0, 0, 0, 0, 0, 0, 0];
    const s1f1 = [0, 0, 0, 201, 0, 0, 0, 0, 0, 0, 0, 0];
    const bytes = buildHva(['BODY', 'TURRET'], [
      [s0f0, s0f1],
      [s1f0, s1f1],
    ]);
    const hva = HvaFile.parse(bytes);
    expect(hva.matrix(0, 0)[3]).toBe(100);
    expect(hva.matrix(0, 1)[3]).toBe(101);
    expect(hva.matrix(1, 0)[3]).toBe(200);
    expect(hva.matrix(1, 1)[3]).toBe(201);
  });

  it('reads a 2-frame, 3-section HVA frame-major (ytnktur.hva layout)', () => {
    // Raw file order: [S0F0, S1F0, S2F0, S0F1, S1F1, S2F1]; translation x encodes 10*section + frame.
    const names = ['CYL14', 'CYL22', 'DUMMY01'];
    const frames = 2;
    const buf = new Uint8Array(HVA_HEADER_SIZE + (HVA_MATRIX_SIZE * frames + HVA_SECTION_NAME_SIZE) * names.length);
    const dv = new DataView(buf.buffer);
    dv.setInt32(16, frames, true);
    dv.setInt32(20, names.length, true);
    const enc = new TextEncoder();
    names.forEach((n, i) => buf.set(enc.encode(n), HVA_HEADER_SIZE + i * HVA_SECTION_NAME_SIZE));
    const matStart = HVA_HEADER_SIZE + names.length * HVA_SECTION_NAME_SIZE;
    let k = 0;
    for (let f = 0; f < frames; f++) {
      for (let sct = 0; sct < names.length; sct++, k++) {
        dv.setFloat32(matStart + k * HVA_MATRIX_SIZE + 3 * 4, 10 * sct + f, true);
      }
    }
    const hva = HvaFile.parse(buf);
    for (let sct = 0; sct < names.length; sct++) {
      for (let f = 0; f < frames; f++) expect(hva.matrix(sct, f)[3]).toBe(10 * sct + f);
    }
  });

  it('throws on out-of-range indices', () => {
    const bytes = buildHva(['A'], [[[0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]]]);
    const hva = HvaFile.parse(bytes);
    expect(() => hva.matrix(1, 0)).toThrow(/section index/);
    expect(() => hva.matrix(0, 1)).toThrow(/frame index/);
  });
});

describe('HvaFile.parse — validation', () => {
  it('rejects a too-small buffer', () => {
    expect(() => HvaFile.parse(new Uint8Array(4))).toThrow(/too small/);
  });

  it('rejects a size-identity mismatch', () => {
    const bytes = buildHva(['A'], [[[0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]]]);
    expect(() => HvaFile.parse(bytes.subarray(0, bytes.length - 4))).toThrow(/size mismatch|too small/);
  });

  it('rejects zero frames/sections', () => {
    const buf = new Uint8Array(HVA_HEADER_SIZE);
    const dv = new DataView(buf.buffer);
    dv.setInt32(16, 0, true);
    dv.setInt32(20, 0, true);
    expect(() => HvaFile.parse(buf)).toThrow(/frameCount|sectionCount/);
  });
});
