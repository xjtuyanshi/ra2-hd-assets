import type { GuestMemoryAccessor } from '../shared/memoryAccessor';

/** YR 1.001 only; the enclosing render-state factory owns the executable hash/image guard. */
export const YR_NATIVE_DETAIL = Object.freeze({
  fps: 0xabcd44,
  lowFrameRate: 0xabcd50,
  level: 0xa8eb78,
  min: 0x829ff4,
  buffer: 0x829ff8,
});

export const YR_BUILDING_ACTIVE_ANIM = Object.freeze({
  slot: 0x568, // BuildingClass::Anims +0x55C, ActiveAnim slot 3.
  type: 0xc8,
  invisible: 0x19d,
  detailLevel: 0x2d4,
});

export interface YrNativeDetail {
  fps: number;
  lowFrameRate: boolean;
  level: number;
  min: number;
  buffer: number;
}

const pointerFits = (memory: GuestMemoryAccessor, pointer: number, span: number) =>
  Number.isInteger(pointer) && pointer >= 0x10000 && (pointer & 3) === 0 && pointer + span <= memory.size;

/** Failed reads must remain unknown: the accessor's scalar fallback of zero cannot establish a null slot. */
function read(memory: GuestMemoryAccessor, address: number, width: 1 | 4): number | null {
  if (address < 0 || address + width > memory.size) return null;
  const bytes = memory.bytes(address, width);
  if (bytes.length !== width) return null;
  return width === 1 ? bytes[0]! : new DataView(bytes.buffer, bytes.byteOffset, width).getUint32(0, true);
}

/** Read once per render-state poll, including cached polls; never run the mutating native DetailThreshold(). */
export function readYrNativeDetail(memory: GuestMemoryAccessor): YrNativeDetail | null {
  try {
    const g = YR_NATIVE_DETAIL;
    const fps = read(memory, g.fps, 4);
    const flag = read(memory, g.lowFrameRate, 1);
    const level = read(memory, g.level, 4);
    const min = read(memory, g.min, 4);
    const buffer = read(memory, g.buffer, 4);
    // Bounded integers reject uninitialized/torn configuration, while retaining map/session overrides.
    if (
      fps === null ||
      fps > 1000 ||
      (flag !== 0 && flag !== 1) ||
      level === null ||
      level > 3 ||
      min === null ||
      min < 1 ||
      min > 1000 ||
      buffer === null ||
      buffer > 1000 ||
      min + buffer > 1000
    )
      return null;
    return { fps, lowFrameRate: flag === 1, level, min, buffer };
  } catch {
    return null;
  }
}

/**
 * Player-verified YR 1.001 evidence: NAPOWR has no Light* keys. NAPOWR_A (DetailLevel=2,
 * ActiveAnimPoweredSpecial=true) redraws the blue sphere/walls; its absence leaves pale glass.
 * 0x4549B0 tests power via vtable +0x350 and creates PoweredSpecial slots through 0x451890;
 * 0x454930 removes them through 0x451E40 (null slot, delete via anim vtable +0x20).
 * AnimClass draw 0x422FCC..0x42300E gates Type.DetailLevel +0x2D4, Invisible +0x19D,
 * options [0xA8EB78] and measured FPS [0xABCD44] (writer 0x55E3B5). Threshold 0x55AF60
 * uses flag [0xABCD50], min [0x829FF4] and buffer [0x829FF8]: the non-mutating equivalent
 * is fps < (flag ? min + buffer : min), only for DetailLevel > 1.
 * User live proof: 519 normal-speed samples at 250 ms, flag 1 iff the original sphere was
 * unlit, zero exceptions, FPS 1..19; object bytes and layer order did not change. These are
 * native dynamic-detail windows, not delayed lights or a change in game state.
 */
export function readYrBuildingActiveAnim(
  memory: GuestMemoryAccessor,
  building: number,
  detail: YrNativeDetail | null,
): 'none' | 'shown' | 'detail' | undefined {
  const o = YR_BUILDING_ACTIVE_ANIM;
  try {
    if (!pointerFits(memory, building, o.slot + 4) || memory.u32(building) !== 0x7e3ebc) return undefined;
    const anim = read(memory, building + o.slot, 4);
    if (anim === 0) return 'none';
    if (anim === null || !pointerFits(memory, anim, o.invisible + 1) || memory.u32(anim) !== 0x7e3354) return undefined;
    const type = read(memory, anim + o.type, 4);
    if (type === null || !pointerFits(memory, type, o.detailLevel + 4) || memory.u32(type) !== 0x7e3608)
      return undefined;
    const level = read(memory, type + o.detailLevel, 4);
    const invisible = read(memory, anim + o.invisible, 1);
    if (level === null || level > 3 || (invisible !== 0 && invisible !== 1) || !detail) return undefined;
    const skippedByFrameRate = detail.fps < (detail.lowFrameRate ? detail.min + detail.buffer : detail.min);
    return invisible || level > detail.level || (level > 1 && skippedByFrameRate) ? 'detail' : 'shown';
  } catch {
    return undefined;
  }
}
