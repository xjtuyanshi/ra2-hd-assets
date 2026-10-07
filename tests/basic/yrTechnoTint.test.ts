import { describe, expect, it } from 'vitest';
import { createByteViewAccessor } from '../../src/games/shared/memoryAccessor';
import {
  YR_TECHNO_TINT as T,
  YR_TECHNO_TINT_SIGNATURES,
  readYrTechnoTint,
  yrAirstrikeTintFactor,
  yrIronTintFactor,
  yrTechnoTintSignaturesMatch,
  yrTimerLeft,
} from '../../src/games/yr/technoTint';

const FRAME = 5000;
const TECHNO = 0x20_0000;
const OTHER = 0x21_0000;
const AIRSTRIKE = 0x22_0000;
const RULES = 0x30_0000;

/** The stock [ColorAdd] list in the engine's 5/6/5 bits, by index. */
const COLOR_ADD: [number, number, number][] = [
  [0, 0, 0],
  [31, 0, 0],
  [0, 63, 0],
  [0, 0, 31],
  [24, 0, 0],
  [0, 56, 0],
  [0, 0, 24],
  [31, 63, 31],
  [7, 7, 7],
  [24, 56, 24],
  [14, 28, 14],
  [15, 0, 15],
  [24, 56, 0],
  [16, 32, 0],
];

/** Synthetic guest memory: one techno, the rules' colour list with the stock indices, and the draw-code signatures. */
function memory() {
  const bytes = new Uint8Array(0x100_0000);
  const view = new DataView(bytes.buffer);
  const u32 = (at: number, value: number) => view.setUint32(at, value >>> 0, true);
  const i32 = (at: number, value: number) => view.setInt32(at, value, true);
  for (const { address, bytes: code } of YR_TECHNO_TINT_SIGNATURES) bytes.set(code, address);
  u32(T.rules, RULES);
  COLOR_ADD.forEach((colour, index) => bytes.set(colour, RULES + T.colorAdd + index * 3));
  // The owner's rulesmd.ini: LaserTargetColor=4, IronCurtainColor=0, BerserkColor=4, ForceShieldColor=6.
  i32(RULES + T.laserTargetColor, 4);
  i32(RULES + T.ironCurtainColor, 0);
  i32(RULES + T.berserkColor, 4);
  i32(RULES + T.forceShieldColor, 6);
  const timer = (at: number, start: number, left: number) => {
    i32(at, start);
    i32(at + T.timerLeft, left);
  };
  /** A curtain with `left` frames to go, in tint stage `stage` with `stageLeft` frames of that stage to go. */
  const curtain = (left: number, stage: number, stageLeft: number, forceShield = false, techno = TECHNO) => {
    timer(techno + T.ironCurtainTimer, FRAME - 10, left + 10);
    timer(techno + T.tintTimer, FRAME - 3, stageLeft + 3);
    i32(techno + T.tintStage, stage);
    i32(techno + T.forceShielded, forceShield ? 1 : 0);
  };
  const read = (kind: Parameters<typeof readYrTechnoTint>[2], frame = FRAME, techno = TECHNO) =>
    readYrTechnoTint(createByteViewAccessor(bytes), techno, kind, frame);
  // Stopped timers hold (-1, 0), like a techno that was never curtained.
  for (const techno of [TECHNO, OTHER])
    for (const at of [T.ironCurtainTimer, T.tintTimer, T.airstrikeTimer]) timer(techno + at, -1, 0);
  return { bytes, view, u32, i32, timer, curtain, read };
}

describe('YR techno tint', () => {
  it("reproduces the engine's Iron Curtain brightness factors stage by stage", () => {
    // Opening flash: 1.0 -> 2.0 over six frames, held for four.
    expect([6, 5, 3, 1, 0].map((r) => yrIronTintFactor(1, r))).toEqual([256, 298, 384, 469, 512]);
    expect(yrIronTintFactor(2, 3)).toBe(512);
    // Fall to the dark level: (461 r + 1020) / 20; the stage lasts 15 to 25 frames.
    expect([25, 20, 10, 1, 0].map((r) => yrIronTintFactor(3, r))).toEqual([627, 512, 281, 74, 51]);
    // The pulse: 0.2 -> 0.5 over eight frames, 0.5 -> 0.2 over sixteen.
    expect([8, 6, 4, 2, 0].map((r) => yrIronTintFactor(4, r))).toEqual([51, 70, 89, 108, 128]);
    expect([16, 12, 8, 4, 0].map((r) => yrIronTintFactor(5, r))).toEqual([128, 108, 89, 70, 51]);
    expect(yrIronTintFactor(6, 0)).toBe(51);
    // Closing flash: 0.2 -> 2.0 over six frames, held four, back to 1.0 over twenty.
    expect([6, 3, 0].map((r) => yrIronTintFactor(7, r))).toEqual([51, 281, 512]);
    expect(yrIronTintFactor(8, 4)).toBe(512);
    expect([20, 10, 0].map((r) => yrIronTintFactor(9, r))).toEqual([512, 384, 256]);
    for (const stage of [0, 10, -1, 99]) expect(yrIronTintFactor(stage, 7)).toBe(256);
    // Divisions truncate towards zero, like the engine's signed shifts.
    expect(yrIronTintFactor(4, 14)).toBe(Math.trunc((1024 - 77 * 14) / 8));
  });

  it("reproduces the laser designator's brightness factors", () => {
    expect([6, 0].map((r) => yrAirstrikeTintFactor(1, r))).toEqual([256, 512]);
    expect(yrAirstrikeTintFactor(2, 1)).toBe(512);
    expect([20, 0].map((r) => yrAirstrikeTintFactor(3, r))).toEqual([512, 256]);
    expect([64, 32, 0].map((r) => yrAirstrikeTintFactor(4, r))).toEqual([256, 384, 512]);
    expect([64, 32, 0].map((r) => yrAirstrikeTintFactor(5, r))).toEqual([512, 384, 256]);
    expect(yrAirstrikeTintFactor(6, 9)).toBe(256);
    expect([7, 8, 9].map((stage) => yrAirstrikeTintFactor(stage, 0))).toEqual([512, 512, 256]);
    expect(yrAirstrikeTintFactor(0, 5)).toBe(256);
  });

  it('reads a timer like CDTimerClass: running, expired and stopped', () => {
    const m = memory();
    const accessor = createByteViewAccessor(m.bytes);
    m.timer(TECHNO + T.tintTimer, FRAME - 4, 10);
    expect(yrTimerLeft(accessor, TECHNO + T.tintTimer, FRAME)).toBe(6);
    expect(yrTimerLeft(accessor, TECHNO + T.tintTimer, FRAME + 6)).toBe(0);
    expect(yrTimerLeft(accessor, TECHNO + T.tintTimer, FRAME + 600)).toBe(0);
    m.timer(TECHNO + T.tintTimer, -1, 9);
    expect(yrTimerLeft(accessor, TECHNO + T.tintTimer, FRAME + 600)).toBe(9);
  });

  it('draws nothing special for an ordinary techno', () => {
    const m = memory();
    for (const kind of ['vehicle', 'building', 'infantry', 'aircraft'] as const) expect(m.read(kind)).toBeUndefined();
  });

  it('pulses a curtained vehicle between a fifth and a half of its brightness, without colour', () => {
    const m = memory();
    m.curtain(400, 5, 16);
    expect(m.read('vehicle')).toEqual({ light: 0.5, shield: 'ironCurtain' });
    // The pulse follows the frame counter while memory stands still.
    expect(m.read('vehicle', FRAME + 8)).toEqual({ light: 89 / 256, shield: 'ironCurtain' });
    expect(m.read('vehicle', FRAME + 16)).toEqual({ light: 51 / 256, shield: 'ironCurtain' });
    m.curtain(400, 2, 4);
    expect(m.read('vehicle')).toEqual({ light: 2, shield: 'ironCurtain' });
    // Stage 10 (the curtain's last frames after the closing flash): unchanged brightness, still curtained.
    m.curtain(1, 10, 0);
    expect(m.read('vehicle')).toEqual({ light: 1, shield: 'ironCurtain' });
    // Expired: IsIronCurtained is false whatever the stage still holds.
    expect(m.read('vehicle', FRAME + 1)).toBeUndefined();
    // Aircraft and infantry take the same factor through the shared draw helpers.
    m.curtain(400, 6, 0);
    expect(m.read('aircraft')).toEqual({ light: 51 / 256, shield: 'ironCurtain' });
    expect(m.read('infantry')).toEqual({ light: 51 / 256, shield: 'ironCurtain' });
  });

  it('adds the rules colour of the Iron Curtain to vehicles when a mod names one', () => {
    const m = memory();
    m.curtain(400, 6, 0);
    m.i32(RULES + T.ironCurtainColor, 4);
    expect(m.read('vehicle')).toEqual({ light: 51 / 256, add: [24 / 31, 0, 0], shield: 'ironCurtain' });
    // Buildings never take IronCurtainColor (0x43D442 tests the Force Shield flag only).
    expect(m.read('building')).toEqual({ light: 51 / 256, shield: 'ironCurtain' });
    // An index outside the 16-entry list is ignored instead of read as a colour.
    m.i32(RULES + T.ironCurtainColor, 16);
    expect(m.read('vehicle')).toEqual({ light: 51 / 256, shield: 'ironCurtain' });
    m.i32(RULES + T.ironCurtainColor, -1);
    expect(m.read('vehicle')).toEqual({ light: 51 / 256, shield: 'ironCurtain' });
  });

  it('adds blue to a force-shielded building and nothing to a force-shielded vehicle', () => {
    const m = memory();
    m.curtain(300, 4, 0, true);
    expect(m.read('building')).toEqual({ light: 0.5, add: [0, 0, 24 / 31], shield: 'forceShield' });
    expect(m.read('vehicle')).toEqual({ light: 0.5, shield: 'forceShield' });
    // The flag alone, without a running curtain, shows nothing.
    m.timer(TECHNO + T.ironCurtainTimer, -1, 0);
    expect(m.read('building')).toBeUndefined();
  });

  it('colours Berserk vehicles and infantry red at full brightness', () => {
    const m = memory();
    m.bytes[TECHNO + T.berzerk] = 1;
    expect(m.read('vehicle')).toEqual({ light: 1, add: [24 / 31, 0, 0] });
    expect(m.read('infantry')).toEqual({ light: 1, add: [24 / 31, 0, 0] });
    expect(m.read('building')).toBeUndefined();
    expect(m.read('aircraft')).toBeUndefined();
    // Curtained and Berserk: the packed colours are OR-ed (0x73C020 / 0x73C0F4).
    m.i32(RULES + T.ironCurtainColor, 6);
    m.curtain(400, 6, 0);
    expect(m.read('vehicle')).toEqual({ light: 51 / 256, add: [24 / 31, 0, 24 / 31], shield: 'ironCurtain' });
  });

  it('halves a deactivated vehicle and leaves other kinds alone', () => {
    const m = memory();
    m.bytes[TECHNO + T.deactivated] = 1;
    expect(m.read('vehicle')).toEqual({ light: 0.5 });
    for (const kind of ['building', 'infantry', 'aircraft'] as const) expect(m.read(kind)).toBeUndefined();
    m.curtain(400, 2, 1);
    expect(m.read('vehicle')).toEqual({ light: 1, shield: 'ironCurtain' });
  });

  it('marks a laser-designated building: the colour for any airstrike, the pulse only for its own target', () => {
    const m = memory();
    m.u32(TECHNO + T.airstrike, AIRSTRIKE);
    m.u32(AIRSTRIKE + T.airstrikeTarget, OTHER);
    expect(m.read('building')).toEqual({ light: 1, add: [24 / 31, 0, 0] });
    m.u32(AIRSTRIKE + T.airstrikeTarget, TECHNO);
    m.i32(TECHNO + T.airstrikeStage, 4);
    m.timer(TECHNO + T.airstrikeTimer, FRAME - 32, 64);
    expect(m.read('building')).toEqual({ light: 1.5, add: [24 / 31, 0, 0] });
    // A vehicle with the same fields is drawn unchanged: only buildings take the airstrike branch uncurtained.
    expect(m.read('vehicle')).toBeUndefined();
    // Curtained, both factors multiply (0x70E360).
    m.curtain(400, 6, 0);
    expect(m.read('building')).toEqual({
      light: Math.trunc((51 * 384) / 256) / 256,
      add: [24 / 31, 0, 0],
      shield: 'ironCurtain',
    });
  });

  it('publishes nothing on implausible fields instead of a wrong tint', () => {
    const m = memory();
    m.curtain(400, 5, 8);
    m.i32(TECHNO + T.tintStage, 99);
    expect(m.read('vehicle')).toBeUndefined();
    m.i32(TECHNO + T.tintStage, 5);
    m.bytes[TECHNO + T.berzerk] = 7;
    expect(m.read('vehicle')).toBeUndefined();
    m.bytes[TECHNO + T.berzerk] = 0;
    m.timer(TECHNO + T.ironCurtainTimer, FRAME, 0x7fff_0000);
    expect(m.read('vehicle')).toBeUndefined();
    m.curtain(400, 5, 8);
    m.u32(TECHNO + T.airstrike, 0x1235);
    expect(m.read('building')).toBeUndefined();
    expect(readYrTechnoTint(createByteViewAccessor(m.bytes), 0x3, 'vehicle', FRAME)).toBeUndefined();
    // Without a rules object the brightness is still published; only the colour is unknown.
    m.u32(TECHNO + T.airstrike, 0);
    m.u32(T.rules, 0);
    m.i32(TECHNO + T.forceShielded, 1);
    expect(m.read('building')).toEqual({ light: 89 / 256, shield: 'forceShield' });
  });

  it('recognises the draw routines of the pinned build only', () => {
    const m = memory();
    expect(yrTechnoTintSignaturesMatch(createByteViewAccessor(m.bytes))).toBe(true);
    for (const { address, bytes } of YR_TECHNO_TINT_SIGNATURES) {
      m.bytes[address + bytes.length - 1] ^= 0xff;
      expect(yrTechnoTintSignaturesMatch(createByteViewAccessor(m.bytes))).toBe(false);
      m.bytes[address + bytes.length - 1] ^= 0xff;
    }
    expect(yrTechnoTintSignaturesMatch(createByteViewAccessor(new Uint8Array(0x100_0000)))).toBe(false);
  });
});
