import { describe, expect, it } from 'vitest';
import { createByteViewAccessor } from '../../src/games/shared/memoryAccessor';
import { createYrSidebarReader, YR_SIDEBAR as G } from '../../src/games/yr/sidebarReader';
import { YR_STARTUP_PAGE_HASH } from '../../src/games/yr/startupPage';
import { YR_STATE_VTABLES as V } from '../../src/games/yr/stateReader';

const S = G.singleton;
const H = 0xc00000,
  SC = 0xc10000,
  TYPE = 0xc20000,
  FACTORY = 0xc60000,
  OBJECT = 0xc70000;
const PRODUCER = 0xc80000,
  PRODUCER_TYPE = 0xc90000;
function fixture(tab = 0, count = 1) {
  const bytes = new Uint8Array(0x1000000),
    data = new DataView(bytes.buffer);
  const i32 = (at: number, value: number) => data.setInt32(at, value, true);
  const u8 = (at: number, value: number) => data.setUint8(at, value);
  const ascii = (at: number, value: string) => {
    bytes.set(new TextEncoder().encode(value + '\0'), at);
  };
  const wide = (at: number, value: string) => {
    [...value, '\0'].forEach((c, i) => data.setUint16(at + i * 2, c.charCodeAt(0), true));
  };
  const rect = (at: number, x: number, y: number, width: number, height: number) => {
    [x, y, width, height].forEach((n, i) => i32(at + i * 4, n));
  };
  const vector = (at: number, items: number, values: number[]) => {
    i32(at + 4, items);
    i32(at + 8, values.length);
    i32(at + 0x10, values.length);
    values.forEach((n, i) => i32(items + i * 4, n));
  };
  i32(G.house, H);
  i32(G.scenario, SC);
  i32(G.frame, 100);
  i32(SC + 0x34b8, 1);
  rect(G.viewBounds, 0, 0, 984, 712);
  rect(G.sidebarBounds, 984, 158, 168, 586);
  i32(G.sidebarWidth, 168);
  i32(G.commandBar, 0xcf0000);
  rect(0xcf0000, 0, 712, 984, 32);
  rect(S + 0x11f0, 16, 49, 140, 108);
  i32(G.pitchX, 64);
  i32(G.pitchY, 50);
  i32(G.stripHeight, 450);
  i32(S + 0x539c, tab);
  for (let t = 0; t < 4; t++) {
    const strip = S + 0x1544 + t * 0xf94;
    i32(strip + 0x20, 1006);
    i32(strip + 0x24, 227);
    rect(strip + 0x28, 0, 0, 60, 450);
    i32(strip + 0x54, t === tab ? count : 0);
    i32(G.tabs + t * 0x60, 0x7e0000);
    rect(G.tabs + t * 0x60 + 0xc, 1004 + 32 * t, 197, 30, 28);
  }
  for (const [at, x, y] of [
    [0xb0b3a0, 1017, 165],
    [0xb07df8, 1069, 165],
    [0xb04978, 998, 21],
    [0xb04910, 1070, 21],
    [0xb0b328, 1023, 684],
    [0xb0b408, 1068, 684],
  ]) {
    i32(at!, 0x7e0000);
    rect(at! + 0xc, x!, y!, 30, 24);
  }
  vector(0xa83c68, 0xce0000, [TYPE]);
  vector(0xa8e348, 0xce1000, [TYPE]);
  vector(0xa83ce0, 0xce2000, [TYPE]);
  vector(0xa8b218, 0xce3000, [TYPE]);
  vector(0xa8e330, 0xce4000, [TYPE]);
  vector(H + 0x68, 0xce5000, [PRODUCER]);
  i32(PRODUCER, V.building);
  i32(PRODUCER + 0x520, PRODUCER_TYPE);
  u8(PRODUCER + 0x660, 1);
  i32(PRODUCER_TYPE + 0xeb8, 7);
  i32(TYPE, V.buildingType);
  ascii(TYPE + 0x24, 'GAPOWR');
  ascii(TYPE + 0x6d6, 'POWRICON.SHP');
  i32(TYPE + 0x60, 0xcd0000);
  wide(0xcd0000, 'Power Plant');
  i32(TYPE + 0x610, 800);
  i32(TYPE + 0x3b8, 100);
  i32(FACTORY + 0x68, -1);
  i32(FACTORY + 0x38, 1);
  i32(OBJECT, V.building);
  i32(OBJECT + 0x520, TYPE);
  const strip = S + 0x1544 + tab * 0xf94;
  const entry = (index = 0) => strip + 0x58 + index * 0x34;
  for (let i = 0; i < count; i++) i32(entry(i) + 4, 7);
  const read = createYrSidebarReader(() => createByteViewAccessor(bytes), YR_STARTUP_PAGE_HASH)!;
  return { bytes, data, i32, u8, ascii, wide, rect, vector, strip, entry, read };
}

describe('YR 1.001 read-only sidebar', () => {
  const MOUSE = 0xca0000,
    SHAPE = 0xcb0000,
    TOOLTIP = 0xcc0000;
  const cursor = (f: ReturnType<typeof fixture>) => {
    f.i32(G.mouse, MOUSE);
    f.i32(G.mouseShape, SHAPE);
    f.i32(MOUSE, 0x7f7b2c);
    f.i32(MOUSE + 4, SHAPE);
    f.i32(MOUSE + 8, 12);
    f.i32(MOUSE + 0x14, 1006);
    f.i32(MOUSE + 0x18, 230);
    f.i32(MOUSE + 0x3c, 26);
    f.i32(MOUSE + 0x40, 13);
    [0, 52, 52, 300].forEach((n, i) => f.data.setUint16(SHAPE + i * 2, n, true));
  };
  const nativeTooltip = (f: ReturnType<typeof fixture>) => {
    f.i32(G.tooltip, TOOLTIP);
    f.i32(TOOLTIP, 0x7f74c4);
    f.i32(TOOLTIP + 4, 0xcd1000);
    f.u8(TOOLTIP + 0xc, 1);
    f.rect(TOOLTIP + 0x18, 880, 260, 90, 27);
    f.wide(TOOLTIP + 0x28, '發電廠\r\n$600');
    f.u8(G.sidebarOnRight, 1);
    f.i32(G.tooltipFont, 0xce6000);
    f.i32(0xce6000 + 4, 0xce6100);
    f.i32(0xce6000 + 8, 0xce6250);
    f.u8(0xce6250, 6);
    f.i32(0xce6000 + 0x1c, 12);
    f.i32(0xce6000 + 0x28, 24);
    f.i32(0xce6100 + 0x14, 4);
    f.i32(0xce6100 + 0x18, 0xd00000);
    f.i32(0xce6100 + 0x1c, 0xce6200);
    ['發', '電', '廠'].forEach((code, i) => {
      f.data.setUint16(0xd00000 + code.charCodeAt(0) * 2, i + 1, true);
      f.u8(0xce6200 + i * 4, i ? 29 : 28);
    });
    f.i32(G.compositeSurface, 0xce6300);
    f.i32(0xce6300 + 4, 984);
    f.i32(0xce6300 + 8, 744);
    f.i32(G.sidebarSurface, 0xce6400);
    f.i32(0xce6400 + 4, 168);
    f.i32(0xce6400 + 8, 744);
  };

  it('decodes the final cursor frame/position/resolved hotspot and native multiline tooltip without writes', () => {
    const f = fixture();
    cursor(f);
    nativeTooltip(f);
    const before = f.bytes.slice();
    expect(f.read()).toMatchObject({
      pointer: { x: 1006, y: 230, frame: 12, hotspot: { x: 26, y: 13 } },
      tooltip: { rect: { x: 880, y: 260, width: 94, height: 28 }, text: '發電廠\r\n$600' },
    });
    expect(f.bytes.every((byte, index) => byte === before[index])).toBe(true);
    // WWMouse's final frame can differ from MouseClass's next animation sample; it is authoritative for presentation.
    f.i32(MOUSE + 8, 43);
    f.i32(S + 0x5568, 7);
    expect(f.read()?.pointer?.frame).toBe(43);
  });

  it('uses native glyph metrics/padding and the selected surface edge instead of the cached measurement size', () => {
    const f = fixture();
    nativeTooltip(f);
    f.rect(TOOLTIP + 0x18, 894, 260, 90, 27);
    expect(f.read()?.tooltip?.rect).toEqual({ x: 890, y: 260, width: 94, height: 28 });
    f.rect(TOOLTIP + 0x18, 1062, 260, 90, 27);
    expect(f.read()?.tooltip?.rect).toEqual({ x: 1058, y: 260, width: 94, height: 28 });
    f.wide(TOOLTIP + 0x28, 'A\tB\r\n\n$600');
    expect(f.read()?.tooltip).toEqual({ rect: { x: 1062, y: 260, width: 38, height: 40 }, text: 'A\tB\r\n\n$600' });
    f.i32(G.tooltipFont, 0);
    expect(f.read()?.tooltip).toBeNull();
  });

  it('mirrors native word/character wrapping with bounded reads', () => {
    const f = fixture();
    nativeTooltip(f);
    f.i32(0xce6400 + 4, 24);
    f.rect(TOOLTIP + 0x18, 984, 260, 24, 27);
    f.wide(TOOLTIP + 0x28, 'AB CD EF');
    expect(f.read()?.tooltip?.rect).toEqual({ x: 984, y: 260, width: 20, height: 40 });
    f.wide(TOOLTIP + 0x28, 'ABCDE');
    expect(f.read()?.tooltip?.rect).toEqual({ x: 984, y: 260, width: 24, height: 28 });
    f.i32(0xce6000 + 0x2c, -32);
    expect(f.read()?.tooltip).toBeNull();
  });

  it('returns null for absent or hidden pointers and tooltips without discarding valid sidebar state', () => {
    const f = fixture();
    expect(f.read()).toMatchObject({ pointer: null, tooltip: null });
    cursor(f);
    nativeTooltip(f);
    f.i32(MOUSE + 0xc, -1);
    f.u8(TOOLTIP + 0xc, 0);
    expect(f.read()).toMatchObject({ pointer: null, tooltip: null });
    f.i32(MOUSE + 0xc, 0);
    f.u8(TOOLTIP + 0xc, 1);
    f.i32(TOOLTIP + 4, 0);
    expect(f.read()?.pointer).not.toBeNull();
    expect(f.read()?.tooltip).toBeNull();
  });

  it('rejects corrupt cursor frames/shapes/hotspots and out-of-frame positions independently', () => {
    for (const [at, value] of [
      [MOUSE, 1],
      [MOUSE + 4, 0],
      [MOUSE + 8, 300],
      [MOUSE + 8, -1],
      [MOUSE + 0x3c, 53],
      [MOUSE + 0x40, -1],
      [MOUSE + 0x14, 1152],
      [MOUSE + 0x18, 744],
    ]) {
      const f = fixture();
      cursor(f);
      f.i32(at!, value!);
      expect(f.read()).not.toBeNull();
      expect(f.read()?.pointer).toBeNull();
    }
  });

  it('rejects invalid tooltip rectangles, nonterminated/invalid wide strings and unknown objects', () => {
    const f = fixture();
    nativeTooltip(f);
    f.rect(TOOLTIP + 0x18, 1100, 260, 90, 28);
    expect(f.read()?.tooltip).toBeNull();
    nativeTooltip(f);
    f.wide(TOOLTIP + 0x28, 'X'.repeat(256));
    expect(f.read()?.tooltip).toBeNull();
    f.wide(TOOLTIP + 0x28, '\ud800');
    expect(f.read()?.tooltip).toBeNull();
    f.wide(TOOLTIP + 0x28, '\u0001');
    expect(f.read()?.tooltip).toBeNull();
    nativeTooltip(f);
    f.i32(TOOLTIP, 0x7f57ac);
    expect(f.read()?.tooltip).toBeNull();
  });

  it('guards the build and battle roots, including exceptions and truncated memory', () => {
    const f = fixture();
    expect(createYrSidebarReader(() => createByteViewAccessor(f.bytes), 'other')).toBeNull();
    expect(
      createYrSidebarReader(() => {
        throw new Error('detached');
      }, YR_STARTUP_PAGE_HASH)!(),
    ).toBeNull();
    expect(createYrSidebarReader(() => createByteViewAccessor(new Uint8Array(16)), YR_STARTUP_PAGE_HASH)!()).toBeNull();
    f.i32(G.scenario, 0);
    expect(f.read()).toBeNull();
    f.i32(G.scenario, SC);
    f.i32(G.house, 0);
    expect(f.read()).toBeNull();
  });

  it('derives layout, credits, power, modes and radar from live fields without writes', () => {
    const f = fixture();
    f.i32(S + 0x5520, -123);
    f.i32(H + 0x53a4, 90);
    f.i32(H + 0x53a8, 100);
    [3, 5, 7].forEach((n, i) => f.i32(S + 0x152c + i * 4, n));
    f.u8(S + 0x11b0, 1);
    f.i32(S + 0x14ac, 3);
    f.i32(G.tabs + 0x60 + 0x38, 15);
    const before = f.bytes.slice(),
      r = f.read()!;
    expect(f.bytes.every((byte, index) => byte === before[index])).toBe(true);
    expect(r.frame).toEqual({ width: 1152, height: 744 });
    expect(r.layout.sidebar).toEqual({ x: 984, y: 0, width: 168, height: 744 });
    expect(r.layout.commandBar).toEqual({ x: 0, y: 712, width: 984, height: 32 });
    expect(r.layout.radar).toEqual({ x: 1000, y: 49, width: 140, height: 108 });
    expect(r.layout.strip).toEqual({ x: 1006, y: 227, width: 124, height: 450 });
    expect(r.layout.cameoOrigin).toEqual({ x: 1006, y: 228 });
    expect(r.layout.cameoPitch).toEqual({ x: 64, y: 50 });
    expect(r.layout.cameo).toEqual({ width: 60, height: 48 });
    expect(r.layout.creditsAnchor).toEqual({ x: 1068, y: 2 });
    expect(r.layout.power).toEqual({ x: 984, y: 227, width: 16, slotHeight: 3, slots: 151 });
    expect(r.layout.buttons.repair).toEqual({ x: 1017, y: 165, width: 30, height: 24 });
    expect(r.tabs).toEqual([
      { count: 1, flashing: false },
      { count: 0, flashing: true },
      { count: 0, flashing: false },
      { count: 0, flashing: false },
    ]);
    expect(r.credits).toBe(-123);
    expect(r.power).toEqual({ output: 90, drain: 100, surplus: 3, reserve: 5, used: 7, low: true });
    expect(r.modes).toEqual({ repair: true, sell: false });
    expect(r.radarActive).toBe(true);
    // A second resolution and live art header override the base-art fallback.
    f.rect(G.viewBounds, 0, 0, 1112, 868);
    f.rect(G.sidebarBounds, 1112, 158, 168, 742);
    f.i32(G.powerShape, 0xcc0000);
    f.data.setUint16(0xcc0002, 14, true);
    expect(f.read()!.frame).toEqual({ width: 1280, height: 900 });
    expect(f.read()!.layout.power.width).toBe(14);
    f.i32(SC + 0x34b8, 0);
    f.i32(G.powerShape, 0);
    expect(f.read()!.layout.power).toMatchObject({ x: 1117, width: 12 });
    f.i32(G.commandBar, 3);
    f.i32(0xb07df8 + 0x14, -1);
    expect(f.read()!.layout.commandBar).toBeNull();
    expect(f.read()!.layout.buttons.sell).toBeNull();
  });

  it('lists only the active strip in native order, including partially clipped scrolling rows and visible hover slots', () => {
    const f = fixture(2, 30);
    f.i32(f.strip + 0x44, 2);
    f.u8(f.strip + 0x3f, 1);
    f.i32(f.strip + 0x4c, 25);
    f.u8(G.select + (120 + 0) * 0x38 + 0x34, 1);
    f.i32(f.entry(4) + 0x30, 200);
    const r = f.read()!;
    expect(r.cameos.map((c) => c.index)).toEqual(Array.from({ length: 20 }, (_, i) => i + 4));
    expect(r.cameos[0]).toMatchObject({ x: 1006, y: 203, hovered: true, flashing: true });
    expect(r.cameos[1]).toMatchObject({ x: 1070, y: 203, hovered: false });
    expect(r.cameos.at(-1)!.y).toBe(653);
    f.i32(f.strip + 0x4c, 0);
    expect(f.read()!.cameos[0]!.index).toBe(6);
    f.u8(G.hoverDisabled, 1);
    f.u8(f.strip + 0x3f, 0);
    expect(f.read()!.cameos).toHaveLength(18);
    expect(f.read()!.cameos.every((c) => !c.hovered)).toBe(true);
  });

  it('resolves infantry entries through InfantryTypeClass::Array and vehicles through UnitTypeClass::Array', () => {
    // Regression: the two arrays were swapped once, which drew vehicle cameos on the infantry tab in a live match.
    const f = fixture(2, 2);
    const INF = 0xc30000,
      UNIT = 0xc40000;
    for (const [at, id] of [
      [INF, 'E2'],
      [UNIT, 'HARV'],
    ] as const) {
      f.bytes.copyWithin(at, TYPE, TYPE + 0xe00);
      f.bytes.fill(0, at + 0x24, at + 0x3c);
      f.ascii(at + 0x24, id);
    }
    f.vector(0xa8e348, 0xce1000, [INF]);
    f.vector(0xa83ce0, 0xce2000, [UNIT]);
    f.i32(f.entry(0) + 4, 16);
    f.i32(f.entry(1) + 4, 40);
    const r = f.read()!;
    expect(r.cameos.map((c) => [c.id, c.kind])).toEqual([
      ['E2', 'infantry'],
      ['HARV', 'vehicle'],
    ]);
  });

  it('reproduces production clocks, factory ready, hold, state overrides and native queue display', () => {
    const f = fixture(0, 2),
      e = f.entry();
    f.i32(e + 0xc, FACTORY);
    f.i32(FACTORY + 0x24, 20);
    f.i32(e + 0x10, 1);
    f.i32(e + 0x14, 40);
    expect(f.read()!.cameos[0]).toMatchObject({
      image: 'powricon',
      name: 'Power Plant',
      cost: 800,
      progress: 30 / 54,
      darkened: false,
      ready: false,
      hold: false,
    });
    expect(f.read()!.cameos[1]!.darkened).toBe(true); // Busy building strip.
    f.i32(FACTORY + 0x38, 0);
    expect(f.read()!.cameos[0]!.hold).toBe(true);
    f.i32(FACTORY + 0x24, 54);
    f.i32(FACTORY + 0x58, OBJECT);
    expect(f.read()!.cameos[0]).toMatchObject({ ready: true, progress: null, hold: false });
    f.i32(H + 0x53bc, FACTORY);
    f.vector(FACTORY + 0x40, 0xce6000, []);
    expect(f.read()!.cameos[0]!.queued).toBe(0); // Single current object is not a queue caption.
    f.vector(FACTORY + 0x40, 0xce6000, [TYPE]);
    expect(f.read()!.cameos[0]!.queued).toBe(2);
    f.i32(FACTORY + 0x58, 0);
    expect(f.read()!.cameos[0]!.queued).toBe(1);
    f.i32(FACTORY + 0x58, OBJECT);
    f.i32(OBJECT + 0x520, 0);
    expect(f.read()!.cameos[0]!.queued).toBe(0); // Null native GetType suppresses n==1.
    f.i32(e + 0xc, 0);
    f.i32(e + 0x10, 2);
    expect(f.read()!.cameos[0]).toMatchObject({ progress: 0, hold: true, darkened: true, ready: false });
    f.i32(e + 0x10, 3);
    expect(f.read()!.cameos[0]).toMatchObject({ progress: null, ready: false, darkened: false });
  });

  it('uses owned/ever-produced build limits and producer availability, never a credits affordability test', () => {
    const f = fixture();
    f.i32(S + 0x5520, 0);
    expect(f.read()!.cameos[0]!.darkened).toBe(false);
    f.i32(TYPE + 0x3b8, 1);
    f.i32(H + 0x5500 + 8, 1);
    f.i32(H + 0x5500 + 4, 0xce7000);
    f.i32(0xce7000, 1);
    expect(f.read()!.cameos[0]!.darkened).toBe(true);
    f.i32(TYPE + 0x3b8, -1);
    expect(f.read()!.cameos[0]!.darkened).toBe(false);
    f.i32(H + 0x55a0 + 8, 1);
    f.i32(H + 0x55a0 + 4, 0xce8000);
    f.i32(0xce8000, 1);
    expect(f.read()!.cameos[0]!.darkened).toBe(true);
    f.i32(TYPE + 0x3b8, 100);
    f.u8(PRODUCER + 0x660, 0);
    expect(f.read()!.cameos[0]!.darkened).toBe(true);
    f.i32(f.entry() + 0x10, 1);
    expect(f.read()!.cameos[0]!.darkened).toBe(false);
  });

  it('reads naval/defense kinds and selects the alternate filename by native house/type predicates', () => {
    const f = fixture();
    f.i32(f.entry() + 8, 5);
    expect(f.read()!.cameos[0]!.kind).toBe('defense');
    f.i32(f.entry() + 4, 40);
    f.u8(TYPE + 0xcce, 1);
    f.i32(PRODUCER_TYPE + 0xeb8, 40);
    f.u8(PRODUCER_TYPE + 0xcce, 1);
    f.u8(H + 0x2c0, 1);
    f.u8(TYPE + 0xc8e, 1);
    f.i32(TYPE + 0x710, 0xcc0000);
    f.ascii(TYPE + 0x6f5, 'ALTICON');
    expect(f.read()!.cameos[0]).toMatchObject({ kind: 'naval', image: 'alticon', darkened: false });
  });

  it('reproduces normal and charge-drain superweapon clock frames and label predicates', () => {
    const f = fixture(1),
      SW = 0xcb0000;
    f.i32(f.entry() + 4, 31);
    f.vector(H + 0x254, 0xce9000, [SW]);
    f.i32(SW + 0x28, TYPE);
    f.i32(TYPE + 0xb0, 100);
    f.ascii(TYPE + 0xcc, 'NUKEICON');
    f.i32(SW + 0x24, -1);
    f.u8(SW + 0x6d, 1);
    f.i32(SW + 0x30, 50);
    f.i32(SW + 0x38, 100);
    expect(f.read()!.cameos[0]).toMatchObject({
      kind: 'super',
      image: 'nukeicon',
      cost: null,
      progress: 0.5,
      ready: false,
    });
    f.u8(SW + 0x6f, 1);
    expect(f.read()!.cameos[0]).toMatchObject({ progress: null, ready: true });
    f.u8(SW + 0x70, 1);
    expect(f.read()!.cameos[0]).toMatchObject({ ready: false, hold: true });
    f.u8(TYPE + 0xe5, 1);
    f.u8(SW + 0x70, 0);
    f.i32(SW + 0x7c, 1);
    expect(f.read()!.cameos[0]).toMatchObject({ ready: true, progress: 0.5 });
    f.i32(SW + 0x7c, 2);
    f.i32(0x8871e0, 0xca0000);
    f.data.setFloat64(0xca0760, 2, true);
    expect(f.read()!.cameos[0]).toMatchObject({ ready: false, progress: 13 / 54 });
    f.i32(SW + 0x30, -1);
    f.i32(SW + 0x38, 25);
    f.u8(TYPE + 0xe5, 0);
    f.u8(SW + 0x6f, 0);
    expect(f.read()!.cameos[0]!.progress).toBe(40 / 54);
    f.i32(TYPE + 0xb0, 0);
    expect(f.read()).toBeNull();
  });

  it('binary-searches loaded CSF labels, bounds strings and uses null for missing labels/images', () => {
    const f = fixture();
    const labels = 0xca0000,
      values = 0xca1000;
    f.i32(G.labels, labels);
    f.i32(G.labelCount, 2);
    f.i32(G.values, values);
    f.i32(G.valueCount, 2);
    ['TXT_HOLD', 'TXT_READY'].forEach((name, i) => {
      f.ascii(labels + i * 0x28, name);
      f.i32(labels + i * 0x28 + 0x20, 1);
      f.i32(labels + i * 0x28 + 0x24, i);
      f.i32(values + i * 4, 0xca2000 + i * 0x200);
    });
    f.wide(0xca2000, 'On Hold');
    f.wide(0xca2200, 'Ready');
    expect(f.read()!.labels).toEqual({ hold: 'On Hold', ready: 'Ready' });
    f.i32(labels + 0x28 + 0x24, 9);
    expect(f.read()!.labels.ready).toBeNull();
    f.ascii(TYPE + 0x6d6, '../unsafe');
    expect(f.read()!.cameos[0]!.image).toBeNull();
    f.i32(TYPE + 0x60, 0xcd0002);
    f.wide(0xcd0002, 'Ready');
    expect(f.read()!.cameos[0]!.name).toBe('Ready');
  });

  it.each([
    ['active tab', (f: ReturnType<typeof fixture>) => f.i32(S + 0x539c, 4)],
    ['cameo count', (f: ReturnType<typeof fixture>) => f.i32(f.strip + 0x54, 76)],
    ['type index', (f: ReturnType<typeof fixture>) => f.i32(f.entry(), 1)],
    ['type pointer', (f: ReturnType<typeof fixture>) => f.i32(0xce0000, 0xfffffc)],
    ['factory pointer', (f: ReturnType<typeof fixture>) => f.i32(f.entry() + 0xc, 3)],
    [
      'queue count',
      (f: ReturnType<typeof fixture>) => {
        f.i32(H + 0x53bc, FACTORY);
        f.i32(FACTORY + 0x50, 4097);
      },
    ],
    ['UIName pointer', (f: ReturnType<typeof fixture>) => f.i32(TYPE + 0x60, 0xffffff)],
    [
      'unterminated UIName',
      (f: ReturnType<typeof fixture>) => {
        for (let i = 0; i < 256; i++) f.data.setUint16(0xcd0000 + i * 2, 65, true);
      },
    ],
    ['unterminated id', (f: ReturnType<typeof fixture>) => f.bytes.fill(65, TYPE + 0x24, TYPE + 0x3c)],
    ['power count', (f: ReturnType<typeof fixture>) => f.i32(S + 0x152c, 152)],
  ])('rejects implausible %s', (_, corrupt) => {
    const f = fixture();
    corrupt(f);
    expect(f.read()).toBeNull();
  });

  it('keeps radar opening/closing visible independently of availability and distinguishes open minimap from interference', () => {
    const f = fixture();
    f.u8(S + 0x14d8, 0);
    for (const stage of [2, 3]) {
      f.i32(S + 0x14ac, stage);
      expect(f.read()!.radarActive).toBe(true);
    }
    f.i32(S + 0x14ac, 1);
    f.i32(S + 0x14b0, 1);
    expect(f.read()!.radarActive).toBe(true);
    f.i32(S + 0x14b0, 4);
    expect(f.read()!.radarActive).toBe(false);
    f.i32(S + 0x14ac, 0);
    f.u8(S + 0x14d8, 1);
    expect(f.read()!.radarActive).toBe(false);
    f.i32(H + 0x53a4, -1);
    f.i32(H + 0x53a8, 0);
    expect(f.read()!.power.low).toBe(false);
    f.i32(SC + 0x34b8, 99);
    f.i32(G.powerShape, 0xcc0000);
    f.data.setUint16(0xcc0002, 11, true);
    expect(f.read()!.side).toBe(-1);
  });

  it('rejects a torn poll when a root changes during reading', () => {
    const f = fixture(),
      m = createByteViewAccessor(f.bytes);
    let calls = 0;
    const read = createYrSidebarReader(
      () => ({
        ...m,
        u32(at) {
          if (at === G.house && ++calls > 1) return 0;
          return m.u32(at);
        },
      }),
      YR_STARTUP_PAGE_HASH,
    )!;
    expect(read()).toBeNull();
  });
});

describe('native HD UI gadget states', () => {
  it('reads exact ShapeButton frames and keeps missing/undrawn command gadgets absent', () => {
    const f = fixture();
    const button = 0xb0b3a0;
    f.i32(button + 0x58, 0xcc0000);
    const source = f.bytes.slice();
    expect(f.read()?.controls?.find((c) => c.id === 'repair')).toMatchObject({
      frame: 0,
      rect: { x: 1017, y: 165, width: 30, height: 24 },
    });
    expect(f.bytes.every((value, index) => value === source[index])).toBe(true);
    f.u8(button + 0x2c, 1);
    expect(f.read()?.controls?.[0]?.frame).toBe(1);
    f.u8(button + 0x40, 1);
    f.u8(button + 0x34, 1);
    expect(f.read()?.controls?.[0]?.frame).toBe(3);
    f.u8(button + 0x2d, 1);
    expect(f.read()?.controls?.[0]?.frame).toBe(4);
    f.u8(button + 0x1e, 1);
    expect(f.read()?.controls?.[0]?.frame).toBe(2);
    expect(f.read()?.controls?.some((c) => c.id.startsWith('command'))).toBe(false);
  });
  it('publishes only native drawn slots, deduplicates them, and selects one toolbar toggle', () => {
    const f = fixture();
    for (let i = 0; i < 25; i++) f.i32(G.commandSlots + i * 4, -1);
    f.i32(G.commandSlots, 24);
    f.i32(G.commandSlots + 4, 24);
    f.i32(G.commandSlots + 8, 25);
    const cmd = G.commandButtons + 24 * 0x60;
    f.i32(cmd, 0x7e0000);
    f.rect(cmd + 0xc, 150, 712, 24, 24);
    f.i32(cmd + 0x58, 0xcc0000);
    for (const at of [0xb0cc40, 0xb0ccb0]) {
      f.i32(at, 0x7e0000);
      f.rect(at + 0xc, 0, 712, 24, 24);
      f.i32(at + 0x58, 0xcc0000);
    }
    expect(f.read()?.controls?.map((c) => c.id)).toEqual(['commandExpand']);
    f.u8(S + 0x5544, 1);
    expect(f.read()?.controls?.map((c) => c.id)).toEqual(['command24', 'commandCollapse']);
    f.u8(G.tabs + 0x1e, 1);
    f.u8(G.tabs + 0x60 + 0x40, 1);
    f.u8(G.tabs + 0x60 + 0x34, 1);
    expect(f.read()?.tabFrames).toEqual([2, 3, 0, 0]);
    f.i32(G.commandBar, 0);
    expect(f.read()?.controls).toEqual([]);
  });
});
