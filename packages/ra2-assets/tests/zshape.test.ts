import { describe, expect, it } from 'vitest';
import { parseIni } from 'ra2-formats';
import { decodeDepthTemplate, readBuildingZShape, readTypeDepthFlags, readYDrawOffset } from '../src/zshape.ts';
import { collectZShapePatch } from '../src/node/zshape.ts';
import type { InstallView } from '../src/node/artSource.ts';

/** Two synthetic raw SHP frames: a smaller first-frame rectangle inside a larger canvas, then unrelated bytes. */
function syntheticShp(pixels: number[], width = pixels.length, height = 1): Uint8Array {
  const bytes = new Uint8Array(56 + pixels.length + 1);
  const header = new DataView(bytes.buffer);
  header.setUint16(2, width + 10, true);
  header.setUint16(4, height + 10, true);
  header.setUint16(6, 2, true);
  for (const [offset, w, h, data] of [
    [8, width, height, 56],
    [32, 1, 1, 56 + pixels.length],
  ]) {
    header.setInt16(offset!, 2, true);
    header.setInt16(offset! + 2, 3, true);
    header.setInt16(offset! + 4, w!, true);
    header.setInt16(offset! + 6, h!, true);
    header.setInt32(offset! + 8, 1, true);
    header.setInt32(offset! + 20, data!, true);
  }
  bytes.set(pixels, 56);
  bytes[56 + pixels.length] = 222;
  return bytes;
}

describe('native BUILDNGZ transform', () => {
  it('preserves zero and wraps nonzero bytes exactly before signed-int8 interpretation', () => {
    const bytes = syntheticShp([0, 1, 32, 64, 65, 66, 192, 193, 222, 255], 5, 2);
    const original = bytes.slice();
    const decoded = decodeDepthTemplate(bytes);
    expect([decoded.width, decoded.height]).toEqual([5, 2]);
    expect([...decoded.pixels]).toEqual([0, 192, 223, 255, 0, 1, 127, 128, 157, 190]);
    expect([...new Int8Array(decoded.pixels.buffer)]).toEqual([0, -64, -33, -1, 0, 1, 127, -128, -99, -66]);
    expect(bytes).toEqual(original);
  });

  it('covers every input byte without saturation and does not treat an all-zero template as empty', () => {
    const input = Array.from({ length: 256 }, (_, index) => index);
    const decoded = decodeDepthTemplate(syntheticShp(input, 16, 16));
    for (const raw of input) expect(decoded.pixels[raw]).toBe(raw === 0 ? 0 : (raw + 191) % 256);
    expect([...decodeDepthTemplate(syntheticShp([0, 0])).pixels]).toEqual([0, 0]);
  });

  it('rejects missing, empty and truncated frames instead of emitting a fabricated template', () => {
    expect(() => decodeDepthTemplate(new Uint8Array(0))).toThrow();
    expect(() => decodeDepthTemplate(new Uint8Array(8))).toThrow('no frame 0');
    const empty = syntheticShp([65]);
    new DataView(empty.buffer).setInt32(28, 0, true);
    expect(() => decodeDepthTemplate(empty)).toThrow('frame 0 is empty');
    const truncated = syntheticShp([65, 66]);
    new DataView(truncated.buffer).setInt16(12, 5, true);
    expect(() => decodeDepthTemplate(truncated)).toThrow();
  });
});

describe('native depth INI keys', () => {
  it('reads signed, case-insensitive values and keeps NormalZAdjust distinct from ZAdjust', () => {
    const ini = parseIni(
      '[B]\nzshapepointmove = -30, +15 ; comment\nNormalZAdjust=-7\nZAdjust=500\n' +
        '[PLAIN]\nZAdjust=-99\n[BOTH]\nZShapePointMove=0,0\nNormalZAdjust=0\n[A]\nYDrawOffset=-8\n',
    );
    expect(readBuildingZShape(ini.getSection('b'))).toEqual({ pointMove: [-30, 15], normalZAdjust: -7 });
    expect(readBuildingZShape(ini.getSection('PLAIN'))).toBeUndefined();
    expect(readBuildingZShape(ini.getSection('BOTH'))).toBeUndefined();
    expect(readBuildingZShape(undefined)).toBeUndefined();
    expect(readYDrawOffset(ini.getSection('A'))).toBe(-8);
    expect(readYDrawOffset(undefined)).toBe(0);
  });

  it('omits each default member and uses the existing lenient integer/default behavior', () => {
    const ini = parseIni(
      '[MOVE]\nZShapePointMove=0,35\nNormalZAdjust=oops\n' +
        '[Z]\nZShapePointMove=bad,bad\nNormalZAdjust=12\n[A]\nYDrawOffset=0\n[B]\nYDrawOffset=oops\n',
    );
    expect(readBuildingZShape(ini.getSection('MOVE'))).toEqual({ pointMove: [0, 35] });
    expect(readBuildingZShape(ini.getSection('Z'))).toEqual({ normalZAdjust: 12 });
    expect(readYDrawOffset(ini.getSection('A'))).toBe(0);
    expect(readYDrawOffset(ini.getSection('B'))).toBe(0);
  });

  it('emits only true flags on the applicable type kind', () => {
    const ini = parseIni('[YES]\nHarvester=YeS\nRefinery=true\n[NO]\nHarvester=no\nRefinery=0\n');
    expect(readTypeDepthFlags('vehicle', ini.getSection('YES'))).toEqual({ harvester: true });
    expect(readTypeDepthFlags('building', ini.getSection('YES'))).toEqual({ refinery: true });
    for (const kind of ['infantry', 'aircraft'] as const)
      expect(readTypeDepthFlags(kind, ini.getSection('YES'))).toEqual({});
    expect(readTypeDepthFlags('vehicle', ini.getSection('NO'))).toEqual({});
    expect(readTypeDepthFlags('building', undefined)).toEqual({});
  });
});

describe('staging metadata collection', () => {
  it('follows rules art aliases, preserves layer keys and emits only non-default entries without reading art files', () => {
    const rules = parseIni(
      '[BuildingTypes]\n0=B\n1=EMPTY\n2=FALLBACK\n3=B\n' +
        '[VehicleTypes]\n0=V\n1=NO\n[B]\nImage=ART_B\nRefinery=yes\nHarvester=yes\n' +
        '[FALLBACK]\nImage=MISSING\n[V]\nHarvester=yes\nRefinery=yes\n',
    );
    const art = parseIni(
      '[ART_B]\nImage=FILE_STEM\nZShapePointMove=30,15\nNormalZAdjust=-9\n' +
        'ActiveAnim=ANIM\nActiveAnimTwo=ZERO\nIdleAnim=ANIM\nActiveAnimY=7\n' +
        '[ANIM]\nImage=ANIM_FILE\nYDrawOffset=4\n[ZERO]\nYDrawOffset=0\n' +
        '[FALLBACK]\nNormalZAdjust=3\n[EMPTY]\nZAdjust=90\n',
    );
    const noArt = (): never => {
      throw new Error('metadata-only extraction must not read art assets');
    };
    const inst: InstallView = {
      ini: (name) => (name === 'rulesmd.ini' ? rules : art),
      has: noArt,
      shp: noArt,
      palette: noArt,
      vxl: noArt,
      hva: noArt,
    };
    expect(collectZShapePatch(inst, 'urban')).toEqual({
      types: {
        B: { refinery: true, zShape: { pointMove: [30, 15], normalZAdjust: -9 } },
        FALLBACK: { zShape: { normalZAdjust: 3 } },
        V: { harvester: true },
      },
      layers: { B: { ActiveAnim: { yDrawOffset: 4 }, IdleAnim: { yDrawOffset: 4 } } },
    });
  });
});
