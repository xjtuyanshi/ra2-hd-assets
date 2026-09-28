import { describe, it, expect } from 'vitest';
import {
  NORMAL_TABLE_1,
  NORMAL_TABLE_2,
  NORMAL_TABLE_3,
  NORMAL_TABLE_4,
  TS_NORMAL_TABLE,
  RA2_NORMAL_TABLE,
  normalTableFor,
  lookupNormal,
} from './vxlNormals.js';

describe('voxel normal tables — retail sizes', () => {
  it('has the four classes at their retail vector counts', () => {
    expect(NORMAL_TABLE_1.length).toBe(16);
    expect(NORMAL_TABLE_2.length).toBe(36); // TS
    expect(NORMAL_TABLE_3.length).toBe(64);
    expect(NORMAL_TABLE_4.length).toBe(245); // RA2
  });

  it('aliases point at the right classes', () => {
    expect(TS_NORMAL_TABLE).toBe(NORMAL_TABLE_2);
    expect(RA2_NORMAL_TABLE).toBe(NORMAL_TABLE_4);
  });

  it('every entry is a unit vector', () => {
    for (const table of [NORMAL_TABLE_1, NORMAL_TABLE_2, NORMAL_TABLE_3, NORMAL_TABLE_4]) {
      for (const [x, y, z] of table) {
        const len = Math.hypot(x, y, z);
        expect(len).toBeCloseTo(1, 4);
      }
    }
  });
});

describe('voxel normal tables — golden values (from FS/FA2 voxel_normal_tables.bin)', () => {
  // Exact float64 representations of the float32 values in the retail data file.
  it('TS (class 2) endpoints', () => {
    expect(NORMAL_TABLE_2[0]).toEqual([
      0.6712139844894409, 0.19849200546741486, -0.7141939997673035,
    ]);
    expect(NORMAL_TABLE_2[35]).toEqual([
      0.0705690011382103, -0.4784739911556244, 0.8752620220184326,
    ]);
  });

  it('RA2 (class 4) endpoints', () => {
    expect(NORMAL_TABLE_4[0]).toEqual([
      0.5265780091285706, -0.35962098836898804, -0.770317018032074,
    ]);
    expect(NORMAL_TABLE_4[1]).toEqual([
      0.15048199892044067, 0.4359839856624603, 0.887283980846405,
    ]);
    expect(NORMAL_TABLE_4[244]).toEqual([
      -0.3281880021095276, 0.14025099575519562, 0.9341430068016052,
    ]);
  });

  it('class 1 and 3 first entries', () => {
    expect(NORMAL_TABLE_1[0]).toEqual([
      0.5494629740715027, -0.0001829999964684248, -0.8355180025100708,
    ]);
    expect(NORMAL_TABLE_3[0]).toEqual([
      0.456510990858078, -0.07396800071001053, -0.8866379857063293,
    ]);
  });
});

describe('normalTableFor / lookupNormal', () => {
  it('maps normalsMode 2 -> TS, 4 -> RA2, else RA2', () => {
    expect(normalTableFor(2)).toBe(NORMAL_TABLE_2);
    expect(normalTableFor(4)).toBe(NORMAL_TABLE_4);
    expect(normalTableFor(1)).toBe(NORMAL_TABLE_1);
    expect(normalTableFor(3)).toBe(NORMAL_TABLE_3);
    expect(normalTableFor(99)).toBe(RA2_NORMAL_TABLE);
  });

  it('clamps an out-of-range index to the (0,1,0) engine fallback', () => {
    expect(lookupNormal(NORMAL_TABLE_4, 244)).toEqual(NORMAL_TABLE_4[244]);
    expect(lookupNormal(NORMAL_TABLE_4, 245)).toEqual([0, 1, 0]);
    expect(lookupNormal(NORMAL_TABLE_2, 1000)).toEqual([0, 1, 0]);
  });
});
