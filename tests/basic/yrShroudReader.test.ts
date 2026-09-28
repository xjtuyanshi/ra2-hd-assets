import { describe, expect, it } from 'vitest';
import {
  createByteViewAccessor,
  createGuestMemoryAccessor,
  type GuestMemoryAccessor,
} from '../../src/games/shared/memoryAccessor';
import {
  YR_ALT_CELL_FLAGS as ALT,
  YR_CELL_FLAGS as FLAGS,
  YR_SCENARIO_FOG_OF_WAR,
  YR_SHROUD_FRAME as FRAME,
  YR_SHROUD_GLOBALS as G,
  YR_SHROUD_NEIGHBOURS,
  YR_SHROUD_OFFSETS as O,
  YR_SHROUD_STATE as STATE,
  YR_LEVEL_HEIGHT,
  createYrShroudReader,
  isYrLocationShrouded,
  readYrShroud,
  yrShroudAt,
} from '../../src/games/yr/shroudReader';
import { YR_STARTUP_PAGE_HASH } from '../../src/games/yr/startupPage';

const MAPPED = ALT.mapped | ALT.noFog;

/**
 * Synthetic occlusion table. It is NOT the game's table (that is game data and stays out of Git): it only satisfies
 * the reader's signature checks (masks 0x00, 0x01, 0x80, 0xAA, 0xFF), gives each single-neighbour mask its own frame
 * so tests can tell which neighbour bit the reader set, and fills the rest with arbitrary frames.
 */
function syntheticTable(): Int8Array {
  const table = new Int8Array(256);
  for (let mask = 0; mask < 256; mask++) table[mask] = 16 + (mask % 31);
  for (const [mask, frame] of [
    [0x00, -1],
    [0x01, 33],
    [0x02, 2],
    [0x04, 4],
    [0x08, 8],
    [0x10, 16],
    [0x20, 32],
    [0x40, 40],
    [0x80, 1],
    [0xaa, -2],
    [0xff, -2],
  ] as const)
    table[mask] = frame;
  return table;
}

/** Guest memory with YR 1.001's map globals, a 512x512 cell pointer table and cells allocated above 0xb00000. */
function syntheticMap(
  options: { size?: number; bounds?: [number, number, number, number]; mapRect?: [number, number] } = {},
) {
  const bytes = new Uint8Array(options.size ?? 0x100_0000);
  const view = new DataView(bytes.buffer);
  let heap = 0xb0_0000;
  const alloc = (size: number) => {
    const at = heap;
    heap += (size + 15) & ~15;
    if (heap > bytes.length) throw new Error('synthetic heap exhausted');
    return at;
  };
  const u32 = (address: number, value: number) => view.setUint32(address, value >>> 0, true);
  const i32 = (address: number, value: number) => view.setInt32(address, value, true);
  const table = syntheticTable();
  bytes.set(new Uint8Array(table.buffer), G.occlusionTable);
  const items = alloc(0x40000 * 4);
  u32(G.map + O.cellItems, items);
  i32(G.map + O.cellCapacity, 0x40000);
  const [width, height] = options.mapRect ?? [10, 10];
  i32(G.map + O.mapRect + 8, width);
  i32(G.map + O.mapRect + 12, height);
  const [l, t, r, b] = options.bounds ?? [1, 1, 8, 8];
  i32(G.map + O.mapCoordBounds, l);
  i32(G.map + O.mapCoordBounds + 4, t);
  i32(G.map + O.mapCoordBounds + 8, r);
  i32(G.map + O.mapCoordBounds + 12, b);
  i32(G.frame, 1234);
  const scenario = alloc(0x100);
  u32(G.scenario, scenario);
  const cells = new Map<string, number>();
  /** Create CellClass (x, y) with the given AltFlags and Flags. */
  const cell = (x: number, y: number, alt = 0, flags = 0) => {
    const at = alloc(0x148);
    view.setInt16(at + O.cellMapCoords, x, true);
    view.setInt16(at + O.cellMapCoords + 2, y, true);
    u32(at + O.cellAltFlags, alt);
    u32(at + O.cellFlags, flags);
    u32(items + ((y << 9) + x) * 4, at);
    cells.set(`${x},${y}`, at);
    return at;
  };
  const setAlt = (x: number, y: number, alt: number) => u32(cells.get(`${x},${y}`)! + O.cellAltFlags, alt);
  const setFlags = (x: number, y: number, flags: number) => u32(cells.get(`${x},${y}`)! + O.cellFlags, flags);
  /** Fill the bounds box with cells. */
  const fill = (alt = 0, flags = 0) => {
    for (let y = t; y <= b; y++) for (let x = l; x <= r; x++) cell(x, y, alt, flags);
  };
  return {
    bytes,
    view,
    table,
    items,
    scenario,
    alloc,
    u32,
    i32,
    cell,
    setAlt,
    setFlags,
    fill,
    accessor: () => createByteViewAccessor(bytes),
  };
}

const at = (s: NonNullable<ReturnType<typeof readYrShroud>>, x: number, y: number) =>
  s.edges[(y - s.originY) * s.width + (x - s.originX)]!;

describe('YR 1.001 shroud reader', () => {
  it('returns null outside a battle or when the image is not YR 1.001', () => {
    const empty = createByteViewAccessor(new Uint8Array(0x100_0000));
    expect(readYrShroud(empty)).toBeNull();
    const m = syntheticMap();
    m.u32(G.map + O.cellItems, 0); // no cell array yet
    expect(readYrShroud(m.accessor())).toBeNull();
    const wrongTable = syntheticMap();
    wrongTable.bytes[G.occlusionTable + 0xaa] = 3; // signature mismatch
    expect(readYrShroud(wrongTable.accessor())).toBeNull();
  });

  it('reports the bounds, per-cell state and covered/clear frames of a partly revealed map', () => {
    const m = syntheticMap();
    m.fill();
    // Reveal a 4x4 block (3..6, 3..6): its interior is clear, its rim gets edge pieces, the rest stays covered.
    for (let y = 3; y <= 6; y++) for (let x = 3; x <= 6; x++) m.setAlt(x, y, MAPPED);
    const s = readYrShroud(m.accessor())!;
    expect(s).toMatchObject({
      frame: 1234,
      originX: 1,
      originY: 1,
      width: 8,
      height: 8,
      fogOfWar: false,
      fogEdges: null,
    });
    expect(s.counts).toEqual({ shrouded: 48, fogged: 0, visible: 16, none: 0, invalid: 0 });
    expect(yrShroudAt(s, 4, 4)).toBe(STATE.visible);
    expect(yrShroudAt(s, 2, 2)).toBe(STATE.shrouded);
    expect(yrShroudAt(s, 0, 0)).toBe(STATE.none);
    expect(yrShroudAt(s, 20, 4)).toBe(STATE.none);
    expect(at(s, 4, 4)).toBe(FRAME.clear); // all eight neighbours mapped: table[0] = -1
    expect(at(s, 5, 5)).toBe(FRAME.clear);
    expect(at(s, 2, 2)).toBe(FRAME.covered); // not mapped: -2
    // Top corner (3, 3): neighbours (2,2) up, (3,2) up-right, (4,2) right, (2,3) up-left, (2,4) left are unmapped.
    const mask = 0x40 | 0x80 | 0x01 | 0x20 | 0x10;
    expect(at(s, 3, 3)).toBe(m.table[mask]);
  });

  it('uses the engine neighbour bit for each of the eight directions', () => {
    for (const [bit, dx, dy] of YR_SHROUD_NEIGHBOURS) {
      const m = syntheticMap();
      m.fill(MAPPED);
      m.setAlt(4 + dx, 4 + dy, 0);
      const s = readYrShroud(m.accessor())!;
      expect(at(s, 4, 4), `bit ${bit.toString(16)}`).toBe(m.table[bit]);
    }
    const singles = YR_SHROUD_NEIGHBOURS.map(([bit]) => syntheticTable()[bit]);
    expect(new Set(singles).size).toBe(8); // so each direction above was told apart
    // The bits run clockwise on screen from the right (screen x ~ X - Y, screen y ~ X + Y).
    const screen = YR_SHROUD_NEIGHBOURS.map(([, dx, dy]) => Math.atan2(dx + dy, dx - dy));
    for (let i = 1; i < screen.length; i++) {
      const step = (screen[i]! - screen[i - 1]! + Math.PI * 2) % (Math.PI * 2);
      expect(step).toBeCloseTo(Math.PI / 4);
    }
  });

  it('maps occlusion -2 to frame 15 and -1 to frame 0, including NoFog without Mapped', () => {
    const m = syntheticMap();
    m.fill(MAPPED);
    // Only the four edge neighbours of (4, 4) unmapped -> mask 0xaa -> -2 -> covered although the cell is mapped.
    for (const [dx, dy] of [
      [1, 0],
      [0, 1],
      [-1, 0],
      [0, -1],
    ])
      m.setAlt(4 + dx, 4 + dy, 0);
    // NoFog without Mapped: GetOcclusion returns -1 (nothing drawn) but the cell is not revealed.
    m.setAlt(7, 7, ALT.noFog);
    const s = readYrShroud(m.accessor())!;
    expect(at(s, 4, 4)).toBe(FRAME.covered);
    expect(yrShroudAt(s, 4, 4)).toBe(STATE.visible);
    expect(at(s, 7, 7)).toBe(FRAME.clear);
    expect(yrShroudAt(s, 7, 7)).toBe(STATE.shrouded);
  });

  it('treats missing neighbours like MapClass::InvalidCell', () => {
    const m = syntheticMap();
    m.fill(MAPPED);
    m.u32(m.items + ((5 << 9) + 5) * 4, 0); // hole at (5, 5)
    let s = readYrShroud(m.accessor())!;
    expect(yrShroudAt(s, 5, 5)).toBe(STATE.none);
    expect(at(s, 5, 5)).toBe(FRAME.none);
    expect(at(s, 4, 4)).toBe(m.table[0x04]); // (5, 5) is down of (4, 4); InvalidCell is unmapped
    expect(at(s, 1, 1)).toBe(m.table[0x01 | 0x10 | 0x20 | 0x40 | 0x80]); // map corner: five outside neighbours
    m.u32(G.invalidCell + O.cellAltFlags, MAPPED); // a reveal near the edge that reached InvalidCell
    s = readYrShroud(m.accessor())!;
    expect(at(s, 4, 4)).toBe(FRAME.clear);
    expect(at(s, 1, 1)).toBe(FRAME.clear);
    expect(s.counts.none).toBe(1);
  });

  it('counts implausible pointers and cells whose MapCoords do not match their slot as invalid', () => {
    const m = syntheticMap();
    m.fill(MAPPED);
    m.u32(m.items + ((2 << 9) + 2) * 4, 0x123); // misaligned / below the heap
    const wrong = m.cell(9, 9, MAPPED); // outside the bounds, then placed in slot (3, 3)
    m.u32(m.items + ((3 << 9) + 3) * 4, wrong);
    m.u32(m.items + ((4 << 9) + 4) * 4, 0x7fff_fff0); // beyond guest memory
    const s = readYrShroud(m.accessor())!;
    expect(s.counts.invalid).toBe(3);
    expect(yrShroudAt(s, 2, 2)).toBe(STATE.none);
    expect(yrShroudAt(s, 3, 3)).toBe(STATE.none);
    expect(yrShroudAt(s, 4, 4)).toBe(STATE.none);
  });

  it('falls back to the [Map] Size box when MapCoordBounds is implausible', () => {
    const m = syntheticMap({ bounds: [0, 0, -1, -1], mapRect: [3, 2] });
    m.cell(1, 3, MAPPED);
    m.cell(5, 2, 0);
    const s = readYrShroud(m.accessor())!;
    expect(s).toMatchObject({ originX: 0, originY: 0, width: 7, height: 7 });
    expect(yrShroudAt(s, 1, 3)).toBe(STATE.visible);
    expect(yrShroudAt(s, 5, 2)).toBe(STATE.shrouded);
    expect(s.counts).toMatchObject({ visible: 1, shrouded: 1, none: 47 });
  });

  it('adds FOG.SHP frames and the fogged state only when the scenario enables fog of war', () => {
    const m = syntheticMap();
    m.fill(MAPPED, FLAGS.centerRevealed | FLAGS.edgeRevealed);
    m.setFlags(4, 4, 0); // revealed earlier, not currently seen
    m.setFlags(6, 6, FLAGS.centerRevealed); // secondary bit only: fog -1
    expect(readYrShroud(m.accessor())!.fogEdges).toBeNull();
    m.u32(m.scenario + O.scenarioFlags, YR_SCENARIO_FOG_OF_WAR);
    const s = readYrShroud(m.accessor())!;
    expect(s.fogOfWar).toBe(true);
    const fog = (x: number, y: number) => s.fogEdges![(y - s.originY) * s.width + (x - s.originX)];
    expect(fog(4, 4)).toBe(FRAME.covered);
    expect(yrShroudAt(s, 4, 4)).toBe(STATE.fogged);
    expect(fog(6, 6)).toBe(FRAME.clear);
    expect(fog(5, 4)).toBe(m.table[0x20]); // (4, 4) is up-left of (5, 4) and lacks EdgeRevealed
    expect(fog(2, 2)).toBe(FRAME.clear);
    expect(s.counts).toMatchObject({ fogged: 1, visible: 63 });
    expect(at(s, 4, 4)).toBe(FRAME.clear); // the shroud itself is unaffected
  });

  it('tests elevated locations against the flat shroud cell they cover, like MapClass::IsLocationShrouded', () => {
    const m = syntheticMap();
    m.fill();
    m.setAlt(4, 4, MAPPED);
    const s = readYrShroud(m.accessor())!;
    const centre = (x: number, y: number) => [x * 256 + 128, y * 256 + 128] as const;
    expect(isYrLocationShrouded(s, ...centre(4, 4), 0)).toBe(false);
    expect(isYrLocationShrouded(s, ...centre(5, 5), 0)).toBe(true);
    // Level 2: one cell step up on screen, so the object on terrain cell (5, 5) is under flat cell (4, 4).
    expect(isYrLocationShrouded(s, ...centre(5, 5), 2 * YR_LEVEL_HEIGHT)).toBe(false);
    expect(isYrLocationShrouded(s, ...centre(4, 4), 2 * YR_LEVEL_HEIGHT)).toBe(true);
    // Odd levels straddle two flat cells: (X - 1, Y - 1) and (X, Y) for level 1.
    expect(isYrLocationShrouded(s, ...centre(5, 5), YR_LEVEL_HEIGHT)).toBe(false);
    expect(isYrLocationShrouded(s, ...centre(4, 4), YR_LEVEL_HEIGHT + 50)).toBe(false);
    expect(isYrLocationShrouded(s, ...centre(6, 6), YR_LEVEL_HEIGHT)).toBe(true);
    expect(isYrLocationShrouded(s, ...centre(40, 40), 0)).toBe(true); // outside the snapshot
  });

  it('reuses the result arrays when the dimensions match', () => {
    const m = syntheticMap();
    m.fill(MAPPED);
    const first = readYrShroud(m.accessor())!;
    m.setAlt(4, 4, 0);
    const second = readYrShroud(m.accessor(), { reuse: first })!;
    expect(second.cells).toBe(first.cells);
    expect(second.edges).toBe(first.edges);
    expect(yrShroudAt(second, 4, 4)).toBe(STATE.shrouded);
    const other = syntheticMap({ bounds: [1, 1, 5, 5] });
    other.fill(MAPPED);
    expect(readYrShroud(other.accessor(), { reuse: first })!.cells).not.toBe(first.cells);
  });

  it('gives the same result through the per-field GuestMemory accessor', () => {
    const m = syntheticMap();
    m.fill();
    for (let y = 2; y <= 5; y++) for (let x = 3; x <= 7; x++) m.setAlt(x, y, MAPPED);
    const guest = createGuestMemoryAccessor(
      { read_memory: (address: number, length: number) => m.bytes.slice(address, address + length) } as never,
      m.bytes.length,
    );
    const fast = readYrShroud(m.accessor())!;
    const slow = readYrShroud(guest)!;
    expect(Array.from(slow.cells)).toEqual(Array.from(fast.cells));
    expect(Array.from(slow.edges)).toEqual(Array.from(fast.edges));
  });

  it('never throws on garbage and the guarded factory rejects other images', () => {
    const m = syntheticMap();
    m.fill(MAPPED);
    let seed = 7;
    const random = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff);
    for (let round = 0; round < 50; round++) {
      for (const offset of [O.cellItems, O.cellCapacity, O.mapCoordBounds, O.mapCoordBounds + 8, O.mapRect + 8])
        m.u32(G.map + offset, random() % 3 === 0 ? random() : random() % 600);
      m.u32(G.scenario, random());
      expect(() => readYrShroud(m.accessor())).not.toThrow();
    }
    const good = syntheticMap();
    good.fill(MAPPED);
    expect(createYrShroudReader(good.accessor, 'other')).toBeNull();
    expect(
      createYrShroudReader(() => createByteViewAccessor(new Uint8Array(0x100_0000)), YR_STARTUP_PAGE_HASH),
    ).toBeNull();
    const read = createYrShroudReader(good.accessor, YR_STARTUP_PAGE_HASH)!;
    expect(read()?.counts.visible).toBe(64);
    const throwing: GuestMemoryAccessor = {
      ...good.accessor(),
      u32: () => {
        throw new Error('detached');
      },
    };
    let calls = 0;
    const flaky = createYrShroudReader(() => (calls++ === 0 ? good.accessor() : throwing), YR_STARTUP_PAGE_HASH)!;
    expect(flaky()).toBeNull();
  });

  it('reads a 256x256-cell bounding box (a maximum-size map) without per-cell allocation', () => {
    const m = syntheticMap({ size: 0x400_0000, bounds: [1, 1, 256, 256], mapRect: [128, 128] });
    for (let y = 1; y <= 256; y++)
      for (let x = 1; x <= 256; x++)
        if (Math.abs(x - y) < 128 && x + y > 129 && x + y < 385) m.cell(x, y, (x + y) % 7 ? MAPPED : 0);
    const first = readYrShroud(m.accessor())!;
    const again = readYrShroud(m.accessor(), { reuse: first })!;
    expect(again.width * again.height).toBe(65536);
    expect(again.counts.visible + again.counts.shrouded).toBeGreaterThan(30000);
    expect(again.cells).toBe(first.cells);
  });
});
