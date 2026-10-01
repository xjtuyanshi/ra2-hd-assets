import type { GameRenderCameo, GameRenderRect, GameRenderSidebar } from '../renderState';
import type { GuestMemoryAccessor } from '../shared/memoryAccessor';
import { YR_STARTUP_PAGE_HASH } from './startupPage';
import { isPlausiblePointer, readAsciiZ, readPointerVector, readUtf16Z, YR_STATE_VTABLES } from './stateReader';

/** Pinned YR 1.001 guest addresses. Instruction evidence and limitations: research/sidebar-ui.md. */
export const YR_SIDEBAR = Object.freeze({
  singleton: 0x87f7e8,
  scenario: 0xa8b230,
  house: 0xa83d4c,
  frame: 0xa8ed84,
  viewBounds: 0x886fa0,
  sidebarBounds: 0x886f90,
  sidebarWidth: 0x7f5bf8,
  commandBar: 0xb0fc58,
  pitchX: 0xb0b4fc,
  pitchY: 0xb0b500,
  stripHeight: 0xb0b504,
  tabs: 0xb07c48,
  select: 0xb07e80,
  hoverDisabled: 0xa8ed9c,
  powerShape: 0xac4e74,
  labels: 0xb1cf74,
  labelCount: 0xb1cf6c,
  values: 0xb1cf78,
  valueCount: 0xb1cf70,
});

const S = YR_SIDEBAR.singleton;
const STRIPS = S + 0x1544;
const STRIP_SIZE = 0xf94;
const MAX_TYPES = 4096;
const MAX_QUEUE = 4096;
const MAX_SCREEN = 16384;

type TypeSpec = {
  vector: number;
  abstract: number;
  kind: GameRenderCameo['kind'];
  objectVtable: number;
  objectType: number;
  factory: number;
  owned: number;
  produced: number;
};
const building: TypeSpec = {
  vector: 0xa83c68,
  abstract: 7,
  kind: 'building',
  objectVtable: YR_STATE_VTABLES.building,
  objectType: 0x520,
  factory: 0x53bc,
  owned: 0x5500,
  produced: 0x55a0,
};
const infantry: TypeSpec = {
  vector: 0xa83ce0,
  abstract: 16,
  kind: 'infantry',
  objectVtable: YR_STATE_VTABLES.infantry,
  objectType: 0x6c0,
  factory: 0x53b0,
  owned: 0x5528,
  produced: 0x55c8,
};
const unit: TypeSpec = {
  vector: 0xa8e348,
  abstract: 40,
  kind: 'vehicle',
  objectVtable: YR_STATE_VTABLES.unit,
  objectType: 0x6c4,
  factory: 0x53b4,
  owned: 0x5514,
  produced: 0x55b4,
};
const aircraft: TypeSpec = {
  vector: 0xa8b218,
  abstract: 3,
  kind: 'aircraft',
  objectVtable: YR_STATE_VTABLES.aircraft,
  objectType: 0x6c4,
  factory: 0x53ac,
  owned: 0x553c,
  produced: 0x55dc,
};
const SPECS = new Map<number, TypeSpec>([
  [6, building],
  [7, building],
  [15, infantry],
  [16, infantry],
  [1, unit],
  [40, unit],
  [2, aircraft],
  [3, aircraft],
]);

function requirePointer(m: GuestMemoryAccessor, p: number, span: number): number {
  if (!isPlausiblePointer(m, p, span)) throw new Error('unavailable sidebar pointer');
  return p;
}
function bounded(value: number, min: number, max: number): number {
  if (value < min || value > max) throw new Error('unavailable sidebar value');
  return value;
}
function vector(m: GuestMemoryAccessor, at: number, max: number): number[] {
  requirePointer(m, at, 0x18);
  const result = readPointerVector(m, at, max);
  if (!result) throw new Error('unavailable sidebar vector');
  return result;
}
function rect(m: GuestMemoryAccessor, at: number): GameRenderRect | null {
  if (!isPlausiblePointer(m, at, 16)) return null;
  const x = m.i32(at),
    y = m.i32(at + 4),
    width = m.i32(at + 8),
    height = m.i32(at + 12);
  if (x < 0 || y < 0 || width <= 0 || height <= 0 || x + width > MAX_SCREEN || y + height > MAX_SCREEN) return null;
  return { x, y, width, height };
}
function requiredRect(m: GuestMemoryAccessor, at: number): GameRenderRect {
  const value = rect(m, at);
  if (!value) throw new Error('unavailable sidebar rectangle');
  return value;
}
function gadget(m: GuestMemoryAccessor, at: number): GameRenderRect | null {
  // These globals are inline objects, not pointer globals. Reject unconstructed gadgets.
  if (!isPlausiblePointer(m, at, 0x60) || !isPlausiblePointer(m, m.u32(at))) return null;
  return rect(m, at + 0xc);
}
function utf16(m: GuestMemoryAccessor, p: number): string | null {
  if (!p) return null;
  // UTF-16 strings need only two-byte alignment, unlike object pointers.
  if (p < 0x10000 || p & 1 || p + 512 > m.size) throw new Error('unavailable sidebar text');
  const value = readUtf16Z(m, p, 256);
  if (value === null && m.u16(p) !== 0) throw new Error('invalid sidebar text');
  return value;
}
function imageName(m: GuestMemoryAccessor, at: number, max: number): string | null {
  const name = readAsciiZ(m, at, max);
  return name && /^[a-z0-9_-]+(?:\.shp)?$/i.test(name) ? name.toLowerCase().replace(/\.shp$/, '') : null;
}

/** Mirrors 0x734E60's binary search without calling its allocating missing-label path. */
function label(m: GuestMemoryAccessor, wanted: string): string | null {
  wanted = wanted.toLowerCase();
  const labels = m.u32(YR_SIDEBAR.labels),
    values = m.u32(YR_SIDEBAR.values);
  const count = m.i32(YR_SIDEBAR.labelCount),
    valueCount = m.i32(YR_SIDEBAR.valueCount);
  if (
    count <= 0 ||
    count > 65536 ||
    valueCount <= 0 ||
    valueCount > 65536 ||
    !isPlausiblePointer(m, labels, count * 0x28) ||
    !isPlausiblePointer(m, values, valueCount * 4)
  )
    return null;
  let lo = 0,
    hi = count - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1,
      entry = labels + mid * 0x28;
    const name = readAsciiZ(m, entry, 0x20)?.toLowerCase();
    if (!name) return null;
    if (name < wanted) lo = mid + 1;
    else if (name > wanted) hi = mid - 1;
    else {
      const index = m.i32(entry + 0x24),
        n = m.i32(entry + 0x20);
      if (n <= 0 || index < 0 || index + n > valueCount) return null;
      try {
        return utf16(m, m.u32(values + index * 4));
      } catch {
        return null;
      }
    }
  }
  return null;
}

function factoryPointer(m: GuestMemoryAccessor, at: number): number {
  const p = m.u32(at);
  if (p) requirePointer(m, p, 0x74);
  return p;
}
function objectType(m: GuestMemoryAccessor, object: number): number {
  if (!object) return 0;
  requirePointer(m, object, 0x6c8);
  const spec = [building, infantry, unit, aircraft].find((s) => s.objectVtable === m.u32(object));
  if (!spec) throw new Error('unknown sidebar factory object');
  const type = m.u32(object + spec.objectType);
  if (type) requirePointer(m, type, 0x64);
  return type;
}
function queue(m: GuestMemoryAccessor, factory: number, type: number): { total: number; shown: number } {
  if (!factory) return { total: 0, shown: 0 };
  const object = m.u32(factory + 0x58),
    current = objectType(m, object);
  const items = vector(m, factory + 0x40, MAX_QUEUE);
  for (const p of items) requirePointer(m, p, 0x64);
  const total = items.filter((p) => p === type).length + Number(current === type);
  return { total, shown: total > 1 || (total === 1 && (!object || (current !== 0 && current !== type))) ? total : 0 };
}
function counter(m: GuestMemoryAccessor, house: number, offset: number, index: number): number {
  const at = house + offset,
    count = bounded(m.i32(at + 8), 0, MAX_TYPES);
  // Native 0x49FAE0 grows the counter when index exceeds its size. An observer must not grow it; new cells are zero.
  if (index >= count) return 0;
  const items = requirePointer(m, m.u32(at + 4), count * 4);
  return bounded(m.i32(items + index * 4), 0, 1000000);
}

/** Read-only subset of FindFactory (0x5F7900); country/tech/prerequisite CanBuild and dock checks remain approximations. */
function hasFactory(m: GuestMemoryAccessor, buildings: number[], spec: TypeSpec, naval: boolean): boolean {
  for (const p of buildings) {
    requirePointer(m, p, 0x664);
    const type = requirePointer(m, m.u32(p + 0x520), 0xebc);
    if (
      !m.u8(p + 0x81) &&
      m.u8(p + 0x660) &&
      m.i32(p + 0xac) !== 19 &&
      m.i32(p + 0xb4) !== 19 &&
      m.i32(type + 0xeb8) === spec.abstract &&
      Boolean(m.u8(type + 0xcce)) === naval
    )
      return true;
  }
  return false;
}

function techno(
  m: GuestMemoryAccessor,
  entry: number,
  type: number,
  spec: TypeSpec,
  house: number,
  buildings: number[],
  busy: boolean,
): Pick<GameRenderCameo, 'image' | 'kind' | 'cost' | 'progress' | 'ready' | 'hold' | 'darkened' | 'queued'> {
  const naval = spec === unit && m.u8(type + 0xcce) !== 0;
  const state = bounded(m.i32(entry + 0x10), 0, 3);
  const factory = factoryPointer(m, entry + 0xc);
  // Queue drawing explicitly passes BuildCat=0, including defense cameos (0x6A9C52).
  const primary = factoryPointer(m, house + (naval ? 0x53b8 : spec.factory));
  const counts = queue(m, primary, type);
  const limit = m.i32(type + 0x3b8),
    arrayIndex = bounded(m.i32(type + 0xdf8), 0, MAX_TYPES - 1);
  const limited =
    limit > 0
      ? counter(m, house, spec.owned, arrayIndex) + counts.total >= limit
      : counter(m, house, spec.produced, arrayIndex) + counts.total >= -limit;
  // CanBuild(false,false)==-1 is not simply cost>credits. Do not invent a money test.
  // BuildLimit subset excludes deployment counts, shared pad-aircraft limits and prerequisite/country routing.
  let darkened = (spec === building && busy) || !hasFactory(m, buildings, spec, naval) || limited;
  let clock = !!factory || state === 1 || state === 2;
  let p = factory ? bounded(m.i32(factory + 0x24), 0, 54) : 0;
  const animation = bounded(m.i32(entry + 0x14), 0, 54);
  const ready = !!factory && p === 54 && (!!m.u32(factory + 0x58) || m.i32(factory + 0x68) !== -1);
  if (factory) {
    objectType(m, m.u32(factory + 0x58));
    darkened = false;
  }
  if (state === 1 && animation > p) p = Math.trunc((p + animation) / 2);
  if (!factory && state !== 0) darkened = state === 2;
  // State3 suppresses the clock but does not supply TXT_READY (0x6A98DA).
  if (!factory && state === 3) clock = false;
  const progress = clock && !ready ? Math.min(1, p / 54) : null;
  const hold = progress !== null && ((!!factory && (!m.i32(factory + 0x38) || !!m.u8(factory + 0x70))) || state === 2);
  const alt =
    !!m.u32(type + 0x710) &&
    !!m.u8(type + 0xc8e) &&
    ((spec === infantry && !!m.u8(house + 0x2bf)) ||
      (!!m.u8(house + 0x2c0) && (spec === unit || (spec === building && !!m.u32(type + 0x408)))));
  return {
    image: imageName(m, type + (alt ? 0x6f5 : 0x6d6), 0x19),
    kind: naval ? 'naval' : spec === building && m.i32(entry + 8) === 5 ? 'defense' : spec.kind,
    cost: m.i32(type + 0x610),
    progress,
    ready,
    hold,
    darkened,
    queued: counts.shown,
  };
}

function superweapon(
  m: GuestMemoryAccessor,
  type: number,
  index: number,
  house: number,
  frame: number,
): Pick<GameRenderCameo, 'image' | 'kind' | 'cost' | 'progress' | 'ready' | 'hold' | 'darkened' | 'queued'> {
  const supers = vector(m, house + 0x254, MAX_TYPES);
  const sw = requirePointer(m, supers[index] ?? 0, 0x80);
  if (m.u32(sw + 0x28) !== type) throw new Error('inconsistent sidebar superweapon');
  const chargeDrain = !!m.u8(type + 0xe5),
    isReady = !!m.u8(sw + 0x6f);
  const hold = !!m.u8(sw + 0x70),
    state = bounded(m.i32(sw + 0x7c), 0, 2);
  // These booleans describe TXT_READY/TXT_HOLD, not firestorm-on or charging captions (contract has no such fields).
  const ready = !hold && (chargeDrain ? state === 1 : isReady);
  let progress: number | null = null;
  if (chargeDrain || !isReady) {
    let p = 0;
    if (m.u8(sw + 0x6d)) {
      const custom = m.i32(sw + 0x24);
      const duration = bounded(custom === -1 ? m.i32(type + 0xb0) : custom, 1, 0x7fffffff);
      const start = m.i32(sw + 0x30),
        left = bounded(m.i32(sw + 0x38), 0, 0x7fffffff);
      const remaining = start === -1 ? left : Math.max(0, left - (frame - bounded(start, 0, frame)));
      let fraction = (duration - remaining) / duration;
      if (chargeDrain && state === 2) {
        const rules = requirePointer(m, m.u32(0x8871e0), 0x768);
        const bytes = m.bytes(rules + 0x760, 8);
        const factor = new DataView(bytes.buffer, bytes.byteOffset, 8).getFloat64(0, true);
        if (!Number.isFinite(factor) || factor <= 0) throw new Error('invalid charge-drain duration');
        fraction = remaining / (duration * factor);
      }
      p = Math.min(53, Math.max(0, Math.trunc(54 * fraction)));
    }
    progress = p / 54;
  }
  return {
    image: imageName(m, type + 0xcc, 0x19),
    kind: 'super',
    cost: null,
    progress,
    ready,
    hold,
    darkened: false,
    queued: 0,
  };
}

/** No guest calls or writes. Each poll obtains a fresh memory view and rejects torn roots/counts. */
export function createYrSidebarReader(
  memory: () => GuestMemoryAccessor,
  hash: string,
): (() => GameRenderSidebar | null) | null {
  if (hash !== YR_STARTUP_PAGE_HASH) return null;
  return () => {
    try {
      const m = memory();
      requirePointer(m, YR_SIDEBAR.valueCount, 4);
      const scenario = requirePointer(m, m.u32(YR_SIDEBAR.scenario), 0x34bc);
      const house = requirePointer(m, m.u32(YR_SIDEBAR.house), 0x55f0);
      const frame = bounded(m.i32(YR_SIDEBAR.frame), 0, 0x7fffffff);
      const rawSide = m.i32(scenario + 0x34b8),
        side = rawSide >= 0 && rawSide <= 2 ? rawSide : -1;
      const activeTab = bounded(m.i32(S + 0x539c), 0, 3);
      const active = STRIPS + activeTab * STRIP_SIZE;
      const view = requiredRect(m, YR_SIDEBAR.viewBounds),
        lower = requiredRect(m, YR_SIDEBAR.sidebarBounds);
      const width = bounded(m.i32(YR_SIDEBAR.sidebarWidth), 1, 1024);
      const frameWidth = bounded(view.x + view.width + width, 1, MAX_SCREEN);
      const frameHeight = bounded(lower.y + lower.height, 1, MAX_SCREEN);
      const pitchX = bounded(m.i32(YR_SIDEBAR.pitchX), 60, 256),
        pitchY = bounded(m.i32(YR_SIDEBAR.pitchY), 48, 256);
      const stripHeight = bounded(m.i32(YR_SIDEBAR.stripHeight), pitchY, frameHeight);
      const x = bounded(m.i32(active + 0x20), 0, frameWidth - 60);
      const y = bounded(m.i32(active + 0x24), 0, frameHeight - 48);
      const strip = { x, y, width: pitchX + 60, height: stripHeight };
      if (strip.x + strip.width > frameWidth || strip.y + strip.height > frameHeight || stripHeight % pitchY)
        return null;
      const tabs = Array.from({ length: 4 }, (_, i) => ({
        count: bounded(m.i32(STRIPS + i * STRIP_SIZE + 0x54), 0, 75),
        flashing: m.i32(YR_SIDEBAR.tabs + i * 0x60 + 0x38) !== 0,
      }));
      const tabRects = Array.from({ length: 4 }, (_, i) => {
        const r = gadget(m, YR_SIDEBAR.tabs + i * 0x60);
        if (!r) throw new Error('unavailable sidebar tab');
        return r;
      });
      const count = tabs[activeTab]!.count,
        top = bounded(m.i32(active + 0x44), 0, 37);
      const scrolling = !!m.u8(active + 0x3f),
        slid = bounded(m.i32(active + 0x4c), 0, pitchY);
      const buildings = vector(m, house + 0x68, 16384);
      const entries = Array.from({ length: count }, (_, i) => active + 0x58 + i * 0x34);
      const busy = entries.some((e) => m.i32(e + 0x10) === 1 || m.i32(e + 0x10) === 2);
      const typeArrays = new Map<number, number[]>();
      const resolved = entries.map((entry) => {
        const itemType = m.i32(entry + 4),
          spec = SPECS.get(itemType);
        const isSuper = itemType === 31 || itemType === 32;
        if (!spec && !isSuper) throw new Error('unknown sidebar type');
        const array = spec?.vector ?? 0xa8e330;
        let types = typeArrays.get(array);
        if (!types) {
          types = vector(m, array, MAX_TYPES);
          typeArrays.set(array, types);
        }
        const index = bounded(m.i32(entry), 0, types.length - 1);
        const type = requirePointer(m, types[index]!, isSuper ? 0xe8 : 0xdfc);
        const id = readAsciiZ(m, type + 0x24, 0x18);
        if (!id) throw new Error('invalid sidebar type id');
        return { entry, type, spec, index, id };
      });
      const cameos: GameRenderCameo[] = [];
      const rows = Math.trunc(stripHeight / pitchY) + Number(scrolling);
      if (rows * 2 > 60) return null; // SelectClass has only 60 inline slots per tab.
      for (let row = 0; row < rows; row++)
        for (let column = 0; column < 2; column++) {
          const index = 2 * (top + row) + column,
            r = resolved[index];
          if (!r) continue;
          const cameoX = x + column * pitchX;
          const cameoY = y + 1 + row * pitchY + (scrolling ? slid - pitchY : 0);
          if (cameoY + 48 <= strip.y || cameoY >= strip.y + strip.height) continue;
          const fields = r.spec
            ? techno(m, r.entry, r.type, r.spec, house, buildings, busy)
            : superweapon(m, r.type, r.index, house, frame);
          cameos.push({
            index,
            x: cameoX,
            y: cameoY,
            id: r.id,
            name: utf16(m, m.u32(r.type + 0x60)) ?? r.id,
            ...fields,
            flashing: m.i32(r.entry + 0x30) > frame,
            hovered:
              !!m.u8(YR_SIDEBAR.select + (activeTab * 60 + row * 2 + column) * 0x38 + 0x34) &&
              !m.u8(YR_SIDEBAR.hoverDisabled),
          });
        }
      const slots = Math.trunc((stripHeight + 3) / 3);
      const surplus = bounded(m.i32(S + 0x152c), 0, slots),
        reserve = bounded(m.i32(S + 0x1530), 0, slots);
      const used = bounded(m.i32(S + 0x1534), 0, slots);
      if (surplus + reserve + used > slots) return null;
      const output = m.i32(house + 0x53a4),
        drain = m.i32(house + 0x53a8);
      const aperture = requiredRect(m, S + 0x11f0);
      const shape = m.u32(YR_SIDEBAR.powerShape);
      // POWERP.SHP loader 0x63F7CA; supplied SIDEC01/02 art headers prove widths 12/16, height2, five frames.
      // Prefer the live SHP header (+2), including mods. Unknown side with no readable art cannot supply a width.
      const shapeWidth = isPlausiblePointer(m, shape, 8) ? m.u16(shape + 2) : 0;
      const powerWidth = shapeWidth > 0 && shapeWidth <= width ? shapeWidth : side === 0 ? 12 : side >= 0 ? 16 : 0;
      if (!powerWidth) return null;
      const radarStage = bounded(m.i32(S + 0x14ac), 0, 3);
      const activation = bounded(m.i32(S + 0x14b0), 0, 4);
      const sidebar: GameRenderSidebar = {
        frame: { width: frameWidth, height: frameHeight },
        side,
        activeTab,
        tabs,
        cameos,
        layout: {
          sidebar: { x: lower.x, y: 0, width, height: frameHeight },
          commandBar: rect(m, m.u32(YR_SIDEBAR.commandBar)),
          radar: { ...aperture, x: lower.x + aperture.x },
          credits: { x: lower.x, y: 0, width, height: 16 },
          creditsAnchor: { x: lower.x + Math.trunc(width / 2), y: 2 },
          strip,
          cameo: { width: 60, height: 48 },
          cameoPitch: { x: pitchX, y: pitchY },
          cameoOrigin: { x, y: y + 1 },
          tabs: tabRects,
          buttons: {
            repair: gadget(m, 0xb0b3a0),
            sell: gadget(m, 0xb07df8),
            options: gadget(m, 0xb04978),
            diplomacy: gadget(m, 0xb04910),
            scrollUp: gadget(m, 0xb0b408),
            scrollDown: gadget(m, 0xb0b328),
          },
          power: { x: lower.x + (side === 0 ? 5 : 0), y: lower.y + 0x45, width: powerWidth, slotHeight: 3, slots },
        },
        credits: m.i32(S + 0x5520),
        power: { output, drain, surplus, reserve, used, low: output < drain && drain !== 0 },
        // 0x6531DB: stage3 opens, stage2 closes, stage1 is open. Activation1 draws the minimap;
        // other activation states draw interference/emblem. Availability alone must not hide closing animation.
        radarActive: radarStage === 2 || radarStage === 3 || (radarStage === 1 && activation === 1),
        modes: { repair: !!m.u8(S + 0x11b0), sell: !!m.u8(S + 0x11b1) },
        labels: { ready: label(m, 'TXT_READY'), hold: label(m, 'TXT_HOLD') },
      };
      if (
        m.u32(YR_SIDEBAR.scenario) !== scenario ||
        m.u32(YR_SIDEBAR.house) !== house ||
        m.i32(S + 0x539c) !== activeTab ||
        m.i32(YR_SIDEBAR.frame) !== frame ||
        tabs.some((tab, i) => m.i32(STRIPS + i * STRIP_SIZE + 0x54) !== tab.count)
      )
        return null;
      return sidebar;
    } catch {
      return null;
    }
  };
}
