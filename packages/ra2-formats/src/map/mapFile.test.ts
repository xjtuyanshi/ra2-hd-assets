import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { idFromName } from '../mix/crc.js';
import { ISO_TILE_RECORD_SIZE } from './isoMapPack.js';
import { MapFile } from './mapFile.js';

const RA2_DIR = process.env.RA2_DIR;

/** Build one 11-byte iso tile record. */
function record(
  x: number,
  y: number,
  tileNum: number,
  subTile: number,
  z: number,
  flags: number,
): Buffer {
  const b = Buffer.alloc(ISO_TILE_RECORD_SIZE);
  b.writeInt16LE(x, 0);
  b.writeInt16LE(y, 2);
  b.writeInt32LE(tileNum, 4);
  b.writeUInt8(subTile, 8);
  b.writeUInt8(z, 9);
  b.writeUInt8(flags, 10);
  return b;
}

function lzoLiterals(raw: Buffer): Buffer {
  return Buffer.concat([Buffer.from([17 + raw.length]), raw, Buffer.from([0x11, 0, 0])]);
}

function chunk(payload: Buffer, uncompressedSize: number): Buffer {
  const hdr = Buffer.alloc(4);
  hdr.writeUInt16LE(payload.length, 0);
  hdr.writeUInt16LE(uncompressedSize, 2);
  return Buffer.concat([hdr, payload]);
}

/** A minimal synthetic map INI carrying two iso tiles as a base64 IsoMapPack5. */
function synthMapIni(): string {
  const raw = Buffer.concat([
    record(3, 4, 505, 1, 2, 0),
    record(5, 6, 0, 0, 3, 1),
  ]);
  const isoB64 = chunk(lzoLiterals(raw), raw.length).toString('base64');
  // LCW overlay: literal [17, 34] at cells 0,1.
  const overlayLcw = Buffer.from([0x82, 17, 34, 0x80]);
  const overlayB64 = chunk(overlayLcw, 2).toString('base64');

  return [
    '[Map]',
    'Size=0,0,10,12',
    'LocalSize=1,1,8,10',
    'Theater=TEMPERATE',
    '',
    '[Waypoints]',
    '0=5006', // x=6, y=5
    '98=12045', // start: x=45, y=12
    '',
    '[Terrain]',
    '5006=TREE07', // x=6, y=5
    '12045=TIBTRE01', // x=45, y=12
    '',
    '[Structures]',
    '0=Americans,GAPOWR,256,50,60,0,...',
    '',
    '[Units]',
    '0=Russians,HTNK,256,70,80,128,...',
    '',
    '[Infantry]',
    '0=Americans,E1,256,40,41,2,...',
    '',
    '[IsoMapPack5]',
    `1=${isoB64}`,
    '',
    '[OverlayPack]',
    `1=${overlayB64}`,
    '',
    '[Preview]',
    'Size=0,0,106,61',
    '[PreviewPack]',
    '1=somedata',
    '',
  ].join('\n');
}

/** Build a plain (unencrypted, unchecksummed) MIX from name→bytes members. */
function buildPlainMix(members: { name: string; data: Buffer }[]): Uint8Array {
  const cFiles = members.length;
  const indexSize = cFiles * 12;
  const body = Buffer.concat(members.map((m) => m.data));
  const bodySize = body.length;

  const head = Buffer.alloc(4 + 6);
  head.writeUInt32LE(0, 0); // flags: none
  head.writeUInt16LE(cFiles, 4);
  head.writeInt32LE(bodySize, 6);

  const index = Buffer.alloc(indexSize);
  let offset = 0;
  let p = 0;
  for (const m of members) {
    index.writeUInt32LE(idFromName(m.name) >>> 0, p);
    index.writeInt32LE(offset, p + 4);
    index.writeInt32LE(m.data.length, p + 8);
    offset += m.data.length;
    p += 12;
  }
  return Uint8Array.from(Buffer.concat([head, index, body]));
}

describe('MapFile.parse', () => {
  it('reads Size, LocalSize, and Theater', () => {
    const m = MapFile.parse(synthMapIni());
    expect(m.size).toEqual({ x: 0, y: 0, width: 10, height: 12 });
    expect(m.localSize).toEqual({ x: 1, y: 1, width: 8, height: 10 });
    expect(m.theater).toBe('TEMPERATE');
  });

  it('decodes IsoMapPack5 tiles', () => {
    const m = MapFile.parse(synthMapIni());
    expect(m.tiles).toEqual([
      { x: 3, y: 4, tileNum: 505, subTile: 1, z: 2, flags: 0 },
      { x: 5, y: 6, tileNum: 0, subTile: 0, z: 3, flags: 1 },
    ]);
    expect(m.isoMapRaw.length).toBe(22);
  });

  it('decodes overlay arrays to the full 262144-byte size', () => {
    const m = MapFile.parse(synthMapIni());
    expect(m.overlay.length).toBe(262144);
    expect(m.overlayData.length).toBe(262144);
    expect(Array.from(m.overlay.subarray(0, 2))).toEqual([17, 34]);
    // No OverlayDataPack section -> all-empty.
    expect(m.overlayData.every((b) => b === 0xff)).toBe(true);
  });

  it('parses waypoints with RA2 cell packing', () => {
    const m = MapFile.parse(synthMapIni());
    const wps = m.waypoints;
    expect(wps).toContainEqual({ number: 0, cell: 5006, x: 6, y: 5 });
    expect(wps).toContainEqual({ number: 98, cell: 12045, x: 45, y: 12 });
  });

  it('parses [Terrain] objects with RA2 cell packing', () => {
    const m = MapFile.parse(synthMapIni());
    const objs = m.terrainObjects;
    expect(objs).toHaveLength(2);
    expect(objs[0]).toEqual({ type: 'TREE07', x: 6, y: 5 });
    expect(objs[1]).toEqual({ type: 'TIBTRE01', x: 45, y: 12 });
  });

  it('exposes object lists with named accessors', () => {
    const m = MapFile.parse(synthMapIni());
    expect(m.structures[0]!.owner).toBe('Americans');
    expect(m.structures[0]!.type).toBe('GAPOWR');
    expect(m.structures[0]!.health).toBe(256);
    expect(m.units[0]!.type).toBe('HTNK');
    expect(m.units[0]!.x).toBe(70);
    expect(m.units[0]!.y).toBe(80);
    expect(m.infantry[0]!.type).toBe('E1');
  });

  it('detects an embedded preview', () => {
    expect(MapFile.parse(synthMapIni()).hasPreview).toBe(true);
    expect(MapFile.parse('[Map]\nSize=0,0,1,1\n').hasPreview).toBe(false);
  });

  it('returns empty terrain/overlay when the sections are absent', () => {
    const m = MapFile.parse('[Map]\nSize=0,0,4,4\nTheater=SNOW\n');
    expect(m.tiles).toEqual([]);
    expect(m.isoMapRaw.length).toBe(0);
    expect(m.overlay.every((b) => b === 0xff)).toBe(true);
    expect(m.waypoints).toEqual([]);
    expect(m.terrainObjects).toEqual([]);
  });
});

describe('MapFile.fromPackage', () => {
  it('opens a .mmx/.yro-style MIX and parses the embedded .map', () => {
    const mapBytes = Buffer.from(synthMapIni(), 'latin1');
    const mix = buildPlainMix([
      { name: 'arena.map', data: mapBytes },
      { name: 'arena.pkt', data: Buffer.from('[Arena]\n') },
    ]);
    const m = MapFile.fromPackage(mix, 'Arena');
    expect(m.theater).toBe('TEMPERATE');
    expect(m.tiles).toHaveLength(2);
  });

  it('throws when the package has no matching scenario', () => {
    const mix = buildPlainMix([{ name: 'other.pkt', data: Buffer.from('x') }]);
    expect(() => MapFile.fromPackage(mix, 'Arena')).toThrow();
  });

  // Regression lock: a package whose scenario is named differently from the
  // archive stem must be resolved via the `<stem>.pkt` [MultiMaps] index rather
  // than only the `<stem>.map` basename. Mirrors `amazon.mmx` (holds
  // `amazon01.map`, indexed by `amazon.pkt` -> [MultiMaps] 1=AMAZON01).
  it('resolves a scenario named via the .pkt [MultiMaps] index', () => {
    const mapBytes = Buffer.from(synthMapIni(), 'latin1');
    const pkt = Buffer.from('[MultiMaps]\n1=AMAZON01\n', 'latin1');
    const mix = buildPlainMix([
      { name: 'amazon01.map', data: mapBytes }, // NOT amazon.map
      { name: 'amazon.pkt', data: pkt },
    ]);
    const m = MapFile.fromPackage(mix, 'amazon');
    expect(m.theater).toBe('TEMPERATE');
    expect(m.tiles).toHaveLength(2);
    expect(m.size).toEqual({ x: 0, y: 0, width: 10, height: 12 });
  });

  it('still throws when there is no pkt index and no basename match', () => {
    const mapBytes = Buffer.from(synthMapIni(), 'latin1');
    const mix = buildPlainMix([
      { name: 'amazon01.map', data: mapBytes }, // present but unindexed
    ]);
    expect(() => MapFile.fromPackage(mix, 'amazon')).toThrow(
      'package contains no amazon.map/.mpr/.yrm scenario',
    );
  });
});

// RA2-gated lock: the real amazon.mmx holds `amazon01.map` (not `amazon.map`)
// and relies on the `amazon.pkt` [MultiMaps] index (1=AMAZON01) for resolution.
// Before the fix fromPackage threw "package contains no amazon.map...".
describe.skipIf(!RA2_DIR)('MapFile.fromPackage (real RA2/YR install)', () => {
  it('resolves amazon.mmx via its .pkt [MultiMaps] index to a 70x90 TEMPERATE map', () => {
    const map = MapFile.fromPackage(
      readFileSync(join(RA2_DIR!, 'amazon.mmx')),
      'amazon',
    );
    expect(map.theater).toBe('TEMPERATE');
    expect(map.size).toEqual({ x: 0, y: 0, width: 70, height: 90 });
  });
});
