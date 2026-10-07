import type { GuestMemoryAccessor } from '../shared/memoryAccessor';
import { isPlausiblePointer, type YrObjectKind } from './stateReader';

/**
 * How Yuri's Revenge 1.001 (gamemd.exe) changes the brightness and colour of a whole object picture at draw time:
 * the Iron Curtain and Force Shield pulse, the Berserk and laser-designator colours and the dimming of a deactivated
 * unit. Read-only; nothing here calls or writes the guest.
 *
 * The engine draws every object with a light level ("intensity", 1000 = the palette as painted, capped at 2000) and a
 * 16-bit colour that its blitters add to the lit pixels. The draw routines change both from these techno fields:
 *
 * - IronCurtainTimer (CDTimer: StartTime +0x18C, TimeLeft +0x194). TechnoClass::IronCurtain 0x70E2B0 (virtual +0x154)
 *   starts it for the Iron Curtain and for the Force Shield alike and stores which one in +0x1C4 (1 = Force Shield,
 *   0x70E2E4). IsIronCurtained (virtual +0x160 = 0x41BF40 for all four classes) is "time left > 0".
 * - IronTintStage +0x1A4 with its own timer (StartTime +0x198, TimeLeft +0x1A0), stepped by 0x70E5A0:
 *   0 -> 1 (6 frames) -> 2 (4) -> 3 (20 +- 5) -> 4 (8) <-> 5 (16) ..., then 6 while fewer than 54 frames of the curtain
 *   remain, 7 (6) at 30 frames, 8 (4), 9 (20), 10. 0x70E380 turns stage and time left into the factor of
 *   yrIronTintFactor: a flash to twice the brightness, a fall to 0.2, a pulse between 0.2 and 0.5 every 24 frames, and
 *   the same flash before the end.
 * - AirstrikeTintStage +0x1C0 with its timer (StartTime +0x1B4, TimeLeft +0x1BC) and 0x70E4B0, the laser designator's
 *   pulse between 1 and 2 (yrAirstrikeTintFactor). 0x70E360 applies both; it runs for a curtained object, and for a
 *   building that is the target (airstrike +0x50) of its own airstrike pointer (+0x294).
 * - Colours are entries of the rules' [ColorAdd] list (RulesClass +0x1874: 16 entries of R, G, B bytes already in
 *   5/6/5 bits), chosen by index: LaserTargetColor +0x18A4, IronCurtainColor +0x18A8, BerserkColor +0x18AC,
 *   ForceShieldColor +0x18B0 (parsed at 0x66B818..0x66B891). The draw routines OR the packed colours together:
 *   vehicles 0x73BFBF (curtained: IronCurtainColor) and 0x73C083 (Berzerk byte +0x298: BerserkColor), infantry
 *   0x518FBC (Berzerk), buildings 0x43D386 (airstrike pointer: LaserTargetColor) and 0x43D442 (curtained and
 *   +0x1C4 == 1: ForceShieldColor). The stock rules name colour 0 (none) for the Iron Curtain, so it only changes
 *   the brightness, while the Force Shield adds blue.
 * - Deactivated byte +0x1C8 (getter 0x70FBD0): the vehicle draw halves the level (0x73C143..0x73C158).
 *
 * The flash of a targeted object (virtual +0x464 over the counter at +0xF0) is not part of this reader.
 */
export const YR_TECHNO_TINT = Object.freeze({
  ironCurtainTimer: 0x18c,
  tintTimer: 0x198,
  tintStage: 0x1a4,
  airstrikeTimer: 0x1b4,
  airstrikeStage: 0x1c0,
  forceShielded: 0x1c4,
  deactivated: 0x1c8,
  airstrike: 0x294,
  berzerk: 0x298,
  /** Bytes of a techno this reader touches; also the span the render-state change key hashes. */
  spanStart: 0x18c,
  spanEnd: 0x1cc,
  /** AirstrikeClass::Target. */
  airstrikeTarget: 0x50,
  /** CDTimerClass: StartTime, (owner), TimeLeft. */
  timerLeft: 0x8,
  /** RulesClass::Instance (pointer). */
  rules: 0x8871e0,
  colorAdd: 0x1874,
  colorAddCount: 16,
  laserTargetColor: 0x18a4,
  ironCurtainColor: 0x18a8,
  berserkColor: 0x18ac,
  forceShieldColor: 0x18b0,
  /** A timer further from zero than this is a torn read (the longest stock duration is 1000 frames). */
  maxTimer: 1_000_000,
});

/** Instruction bytes the loaded image must hold where the offsets above were taken from. */
export const YR_TECHNO_TINT_SIGNATURES: ReadonlyArray<{ address: number; bytes: readonly number[] }> = Object.freeze([
  // IsIronCurtained: mov edx,[ecx+18C]; mov eax,[ecx+194].
  { address: 0x41bf40, bytes: [0x8b, 0x91, 0x8c, 0x01, 0x00, 0x00, 0x8b, 0x81, 0x94, 0x01, 0x00, 0x00] },
  // Iron tint: mov edx,[ecx+1A0]; push esi; mov esi,[ecx+198] ... mov ecx,[ecx+1A4].
  { address: 0x70e380, bytes: [0x8b, 0x91, 0xa0, 0x01, 0x00, 0x00, 0x56, 0x8b, 0xb1, 0x98, 0x01, 0x00, 0x00] },
  { address: 0x70e3a3, bytes: [0x8b, 0x89, 0xa4, 0x01, 0x00, 0x00] },
  // The nine stage handlers of the iron tint and of the airstrike tint (jump tables).
  {
    address: 0x70e48c,
    bytes: [
      0xbd, 0xe3, 0x70, 0x00, 0xc9, 0xe3, 0x70, 0x00, 0xd3, 0xe3, 0x70, 0x00, 0xfa, 0xe3, 0x70, 0x00, 0x0f, 0xe4, 0x70,
      0x00, 0x24, 0xe4, 0x70, 0x00, 0x2b, 0xe4, 0x70, 0x00, 0xc9, 0xe3, 0x70, 0x00, 0x54, 0xe4, 0x70, 0x00,
    ],
  },
  { address: 0x70e4b0, bytes: [0x8b, 0x91, 0xbc, 0x01, 0x00, 0x00] },
  { address: 0x70e4d3, bytes: [0x8b, 0x89, 0xc0, 0x01, 0x00, 0x00] },
  {
    address: 0x70e574,
    bytes: [
      0xed, 0xe4, 0x70, 0x00, 0x09, 0xe5, 0x70, 0x00, 0x3d, 0xe5, 0x70, 0x00, 0x10, 0xe5, 0x70, 0x00, 0x25, 0xe5, 0x70,
      0x00, 0x36, 0xe5, 0x70, 0x00, 0xed, 0xe4, 0x70, 0x00, 0x09, 0xe5, 0x70, 0x00, 0x3d, 0xe5, 0x70, 0x00,
    ],
  },
  // TechnoClass::IronCurtain: mov dword [ecx+1C4], 1.
  { address: 0x70e2e4, bytes: [0xc7, 0x81, 0xc4, 0x01, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00] },
  // Vehicle draw: mov al,[ebp+298]; colour indices IronCurtainColor and BerserkColor.
  { address: 0x73c083, bytes: [0x8a, 0x85, 0x98, 0x02, 0x00, 0x00] },
  { address: 0x73bfbf, bytes: [0x8b, 0x86, 0xa8, 0x18, 0x00, 0x00] },
  { address: 0x73c097, bytes: [0x8b, 0x87, 0xac, 0x18, 0x00, 0x00] },
  // Infantry draw: BerserkColor.
  { address: 0x518fda, bytes: [0x8b, 0x81, 0xac, 0x18, 0x00, 0x00] },
  // Building draw: airstrike pointer, LaserTargetColor, ForceShieldColor; airstrike target compare.
  { address: 0x43d386, bytes: [0x8b, 0x86, 0x94, 0x02, 0x00, 0x00] },
  { address: 0x43d39c, bytes: [0x8b, 0x81, 0xa4, 0x18, 0x00, 0x00] },
  { address: 0x43d455, bytes: [0x8b, 0x81, 0xb0, 0x18, 0x00, 0x00] },
  { address: 0x456ffd, bytes: [0x39, 0x41, 0x50] },
  // Deactivated getter: mov al,[ecx+1C8]; ret.
  { address: 0x70fbd0, bytes: [0x8a, 0x81, 0xc8, 0x01, 0x00, 0x00, 0xc3] },
]);

/** True when the image holds every instruction the offsets were taken from. */
export function yrTechnoTintSignaturesMatch(memory: GuestMemoryAccessor): boolean {
  return YR_TECHNO_TINT_SIGNATURES.every(({ address, bytes }) =>
    bytes.every((byte, i) => memory.u8(address + i) === byte),
  );
}

/** The engine's fixed-point unit of the tint factors. */
const ONE = 256;
/** The engine caps a light level at twice the palette's brightness (cmp eax, 0x7D0 at 0x70E475). */
export const YR_TINT_LEVEL_CAP = 2;

/**
 * Iron Curtain / Force Shield brightness factor in 1/256 (0x70E380), for a stage and the frames left on the stage's
 * timer. Stages outside 1..9 leave the level unchanged. The integer arithmetic is the engine's (divisions truncate).
 */
export function yrIronTintFactor(stage: number, left: number): number {
  const r = left;
  switch (stage) {
    case 1:
      return Math.trunc(((12 - r) * ONE) / 6);
    case 2:
    case 8:
      return 2 * ONE;
    case 3:
      return Math.trunc((461 * r + 1020) / 20);
    case 4:
      return Math.trunc((1024 - 77 * r) / 8);
    case 5:
      return Math.trunc((77 * r + 816) / 16);
    case 6:
      return 51;
    case 7:
      return Math.trunc((3072 - 461 * r) / 6);
    case 9:
      return Math.trunc(((r + 20) * ONE) / 20);
    default:
      return ONE;
  }
}

/** Laser-designator brightness factor in 1/256 (0x70E4B0), for its stage and the frames left on its timer. */
export function yrAirstrikeTintFactor(stage: number, left: number): number {
  const r = left;
  switch (stage) {
    case 1:
    case 7:
      return Math.trunc(((12 - r) * ONE) / 6);
    case 2:
    case 8:
      return 2 * ONE;
    case 3:
    case 9:
      return Math.trunc(((r + 20) * ONE) / 20);
    case 4:
      return Math.trunc(((128 - r) * ONE) / 64);
    case 5:
      return Math.trunc(((r + 64) * ONE) / 64);
    case 6:
      return ONE;
    default:
      return ONE;
  }
}

/** CDTimerClass::GetTimeLeft: a stopped timer (StartTime -1) keeps TimeLeft as stored. */
export function yrTimerLeft(memory: GuestMemoryAccessor, timer: number, frame: number): number {
  const start = memory.i32(timer);
  const left = memory.i32(timer + YR_TECHNO_TINT.timerLeft);
  if (start === -1) return left;
  const elapsed = frame - start;
  return elapsed >= left ? 0 : left - elapsed;
}

export interface YrTechnoTint {
  /**
   * Factor on the object's light level, 1 = unchanged. The engine caps the product at YR_TINT_LEVEL_CAP times the
   * palette's brightness.
   */
  light: number;
  /** Colour the engine adds to the lit picture, 0..1 per channel of its 5/6/5-bit display; absent = none. */
  add?: [number, number, number];
  /** Which timed protection is running, for consumers that add their own presentation. */
  shield?: 'ironCurtain' | 'forceShield';
}

function colorAdd(memory: GuestMemoryAccessor, rules: number, indexOffset: number): [number, number, number] | null {
  const t = YR_TECHNO_TINT;
  const index = memory.i32(rules + indexOffset);
  if (!Number.isInteger(index) || index < 0 || index >= t.colorAddCount) return null;
  const at = rules + t.colorAdd + index * 3;
  return [memory.u8(at), memory.u8(at + 1), memory.u8(at + 2)];
}

/**
 * The brightness factor and added colour the engine draws this techno with on logic frame `frame`, or undefined when
 * it draws it unchanged or a field is implausible. `frame` is Unsorted::CurrentFrame of the same read.
 */
export function readYrTechnoTint(
  memory: GuestMemoryAccessor,
  pointer: number,
  kind: YrObjectKind,
  frame: number,
): YrTechnoTint | undefined {
  const t = YR_TECHNO_TINT;
  if (!isPlausiblePointer(memory, pointer, t.berzerk + 1)) return undefined;
  const curtainLeft = yrTimerLeft(memory, pointer + t.ironCurtainTimer, frame);
  if (!Number.isInteger(curtainLeft) || Math.abs(curtainLeft) > t.maxTimer) return undefined;
  const curtained = curtainLeft > 0;
  const forceShielded = memory.i32(pointer + t.forceShielded) === 1;
  const berzerk = memory.u8(pointer + t.berzerk);
  const deactivated = memory.u8(pointer + t.deactivated);
  if (berzerk > 1 || deactivated > 1) return undefined;
  const airstrike = memory.u32(pointer + t.airstrike);
  if (airstrike !== 0 && !isPlausiblePointer(memory, airstrike, t.airstrikeTarget + 4)) return undefined;
  // 0x7067A3..0x7067D0 / 0x456FD3..0x457000: only a building takes the airstrike pulse without a curtain.
  const targeted = kind === 'building' && airstrike !== 0 && memory.u32(airstrike + t.airstrikeTarget) === pointer;

  let factor = ONE;
  if (curtained || targeted) {
    const stage = memory.i32(pointer + t.tintStage);
    const stageLeft = yrTimerLeft(memory, pointer + t.tintTimer, frame);
    const airStage = memory.i32(pointer + t.airstrikeStage);
    const airLeft = yrTimerLeft(memory, pointer + t.airstrikeTimer, frame);
    if (![stage, airStage].every((value) => Number.isInteger(value) && value >= 0 && value <= 16)) return undefined;
    if (![stageLeft, airLeft].every((value) => Number.isInteger(value) && Math.abs(value) <= t.maxTimer))
      return undefined;
    // 0x70E360: the iron factor first, then the airstrike factor on its (capped) result.
    factor = Math.trunc((yrIronTintFactor(stage, stageLeft) * yrAirstrikeTintFactor(airStage, airLeft)) / ONE);
  }
  let light = Math.max(0, factor) / ONE;
  // 0x73C143: only the vehicle draw halves the level of a deactivated unit.
  if (kind === 'vehicle' && deactivated === 1) light /= 2;

  let red = 0;
  let green = 0;
  let blue = 0;
  const rules = memory.u32(t.rules);
  const or = (indexOffset: number): void => {
    if (!isPlausiblePointer(memory, rules, t.forceShieldColor + 4)) return;
    const colour = colorAdd(memory, rules, indexOffset);
    if (!colour) return;
    red |= colour[0] & 31;
    green |= colour[1] & 63;
    blue |= colour[2] & 31;
  };
  if (kind === 'vehicle') {
    if (curtained) or(t.ironCurtainColor);
    if (berzerk === 1) or(t.berserkColor);
  } else if (kind === 'infantry') {
    if (berzerk === 1) or(t.berserkColor);
  } else if (kind === 'building') {
    if (airstrike !== 0) or(t.laserTargetColor);
    if (curtained && forceShielded) or(t.forceShieldColor);
  }
  const coloured = red !== 0 || green !== 0 || blue !== 0;
  if (light === 1 && !coloured && !curtained) return undefined;
  return {
    light,
    ...(coloured ? { add: [red / 31, green / 63, blue / 31] as [number, number, number] } : {}),
    ...(curtained ? { shield: forceShielded ? ('forceShield' as const) : ('ironCurtain' as const) } : {}),
  };
}
