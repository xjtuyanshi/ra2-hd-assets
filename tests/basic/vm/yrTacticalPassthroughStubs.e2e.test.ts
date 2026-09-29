import { describe, expect, it } from 'vitest';
import { RENDER_PASSTHROUGH, RENDER_PASSTHROUGH_KEY_RGB565 } from '../../../src/games/renderPassthrough';
import { GATE_DATA, readGateSwitches } from '../../../src/games/shared/guestGates';
import {
  installYrTacticalPassthrough,
  yrPassthroughOriginalBytes,
  yrPassthroughSwitches,
} from '../../../src/games/yr/tacticalPassthrough';
import { call32, finish, le32, PROGRAM, push32, withGuestMachine } from '../../helpers/guestMachine';

/**
 * Runs the YR passthrough's hand-assembled stubs (terrain fill, redraw request with the switch latch) and the effect
 * list gates in real v86, without the game: every patched site holds its original bytes from
 * yrPassthroughOriginalBytes(), and the code the sites call or return to is replaced by small fakes that log what
 * happens. One "frame" follows GScreenClass::Render's order: the redraw request read (0x4F44A5), terrain pass 1 (call
 * at 0x6D4471), a host boundary, the terrain copy (0x6D45C7), the EBolt list (call at 0x6D466E) and one LineTrail draw
 * (call at 0x556DD2).
 */
const VIEW_BOUNDS = 0x0088_6fa0;
const DSURFACE_VTABLE = 0x007e_85d4;
const SITE = {
  redraw: 0x004f_44a5,
  redrawResume: 0x004f_44af,
  markNeedsRedraw: 0x004f_42f0,
  passArgs: 0x006d_4469, // 8 bytes of pushes placed right before the call site
  pass1: 0x006d_4471,
  pass1Resume: 0x006d_4476,
  pass1Target: 0x006d_2b60,
  fill: 0x006d_45c7,
  fillResume: 0x006d_45db,
  ebolt: 0x006d_466e,
  eboltResume: 0x006d_4673,
  eboltDrawAll: 0x004c_2830,
  lineColour: 0x004b_fd30, // DSurface vtable +0x34 original target
  trail: 0x0055_6dd2,
  trailResume: 0x0055_6dd7,
  trailDraw: 0x0055_6c00,
} as const;

const VARS = 0x0031_0000;
const GSCREEN = VARS; // +0xC: the game's redraw request word
const COMPOSITE = VARS + 0x100; // fake surface: [COMPOSITE] = FAKE_VTABLE
const FAKE_VTABLE = VARS + 0x200;
const REAL_SURFACE = VARS + 0x300; // [REAL_SURFACE] = the DSurface vtable, whose +0x34 slot is blit-gated
const TILE = VARS + 0x400;
const V = {
  frame: VARS + 0x500,
  logPointer: VARS + 0x504,
  copyThis: VARS + 0x508,
  fillThis: VARS + 0x50c,
  markArgument: VARS + 0x510,
  markThis: VARS + 0x514,
  afterFill: VARS + 0x518,
  espBefore: VARS + 0x520,
  espAfter: VARS + 0x524,
  ebx: VARS + 0x528,
  esi: VARS + 0x52c,
  edi: VARS + 0x530,
  ebp: VARS + 0x534,
  copyArgs: VARS + 0x540, // 5 dwords
  fillArgs: VARS + 0x560, // 2 dwords
  fullRedraw: VARS + 0x600, // per frame
  eboltDepth: VARS + 0x640, // per frame
  eboltLine: VARS + 0x680, // per frame: eax returned by the line primitive
  log: VARS + 0x1000,
} as const;
const FRAME_ROUTINE = PROGRAM + 0x1000;
const FAKE_COPY = PROGRAM + 0x2000;
const FAKE_FILL = PROGRAM + 0x2100;
const REGION = 0x0100_0000;

const LOG = { copy: 0x100, fill: 0x200, pass: 0x300, mark: 0x400, ebolt: 0x600, trail: 0x700, line: 0x800 } as const;

const movEaxMem = (address: number) => [0xa1, ...le32(address)];
const movMemEax = (address: number) => [0xa3, ...le32(address)];
const argument = (offset: number, target: number) => [0x8b, 0x44, 0x24, offset, ...movMemEax(target)];
/** Append `kind | frame` to the log (clobbers eax, edx). */
const log = (kind: number) => [
  0x8b,
  0x15,
  ...le32(V.frame), // mov edx,[frame]
  0x81,
  0xca,
  ...le32(kind), // or edx,kind
  ...movEaxMem(V.logPointer),
  0x89,
  0x10, // mov [eax],edx
  0x83,
  0xc0,
  0x04, // add eax,4
  ...movMemEax(V.logPointer),
];
/** mov edx,[frame]; mov [table + edx*4], eax */
const perFrame = (table: number) => [0x8b, 0x15, ...le32(V.frame), 0x89, 0x04, 0x95, ...le32(table)];
const callRel = (from: number, to: number) => [0xe8, ...le32(to - (from + 5))];

describe('YR 原生叠加层直通：手写桩与特效列表闸门在真实 v86 中运行', () => {
  it('开关在帧开头锁存并整屏重绘；帧中途关闭地形仍整帧填充键色；特效列表照常运行只去掉像素', async () => {
    await withGuestMachine(async (m) => {
      for (const site of yrPassthroughOriginalBytes()) m.code(site.address, site.bytes);
      let next = REGION + 0x4000;
      const result = installYrTacticalPassthrough(m.memory, (size, alignment = 16) => {
        next = Math.floor((next - size) / alignment) * alignment;
        if (next < REGION) throw new Error('region exhausted');
        return next;
      });
      if (!result.ok) throw new Error(result.reason);
      const { control, gates } = result;
      const depth = gates.data + GATE_DATA.depth;

      // Fakes for the code around the patched sites.
      m.code(SITE.markNeedsRedraw, [
        0xc7,
        0x41,
        0x0c,
        ...le32(1), // mov dword [ecx+0xC],1 (the request the original read then consumes)
        ...argument(4, V.markArgument),
        0x89,
        0x0d,
        ...le32(V.markThis),
        ...log(LOG.mark),
        0xc2,
        4,
        0,
      ]);
      m.code(SITE.redrawResume, [...perFrame(V.fullRedraw), 0xc3]);
      m.code(SITE.passArgs, [0x6a, 1, 0x6a, 2, 0x6a, 3, 0x6a, 4]);
      m.code(SITE.pass1Resume, [0xc3]);
      m.code(SITE.pass1Target, [...log(LOG.pass), 0xc2, 0x10, 0]);
      m.code(SITE.fillResume, [...movMemEax(V.afterFill), 0xc3]);
      m.code(SITE.eboltResume, [0xc3]);
      m.code(SITE.eboltDrawAll, [
        ...log(LOG.ebolt),
        ...movEaxMem(depth),
        ...perFrame(V.eboltDepth),
        0xb9,
        ...le32(REAL_SURFACE), // mov ecx, surface
        0x8b,
        0x11, // mov edx,[ecx]
        ...[7, 6, 5, 4, 3, 2, 1].flatMap((value) => [0x6a, value]),
        0xff,
        0x52,
        0x34, // call [edx+0x34] (DrawLineColor, ret 0x1C)
        ...perFrame(V.eboltLine),
        0xc3,
      ]);
      m.code(SITE.lineColour, [...log(LOG.line), 0xb8, ...le32(0x2222), 0xc2, 0x1c, 0]);
      m.code(SITE.trailResume, [0xc3]);
      m.code(SITE.trailDraw, [...log(LOG.trail), 0xc3]);
      m.code(FAKE_COPY, [
        ...log(LOG.copy),
        ...[0, 1, 2, 3, 4].flatMap((i) => argument(4 + i * 4, V.copyArgs + i * 4)),
        0x89,
        0x0d,
        ...le32(V.copyThis),
        0xb8,
        ...le32(0x1111),
        0xc2,
        0x14,
        0,
      ]);
      m.code(FAKE_FILL, [
        ...log(LOG.fill),
        ...argument(4, V.fillArgs),
        ...argument(8, V.fillArgs + 4),
        0x89,
        0x0d,
        ...le32(V.fillThis),
        0xb8,
        ...le32(0x3333),
        0xc2,
        8,
        0,
      ]);
      m.write(COMPOSITE, FAKE_VTABLE);
      m.write(FAKE_VTABLE + 0x08, FAKE_COPY);
      m.write(FAKE_VTABLE + 0x14, FAKE_FILL);
      m.write(REAL_SURFACE, DSURFACE_VTABLE);
      m.write(V.logPointer, V.log);

      const yieldStub = m.api('Sleep', 4);
      const frame: number[] = [0xff, 0x05, ...le32(V.frame), 0xbe, ...le32(GSCREEN)]; // inc [frame]; mov esi,screen
      const at = () => FRAME_ROUTINE + frame.length;
      frame.push(...callRel(at(), SITE.redraw));
      frame.push(...callRel(at(), SITE.passArgs));
      frame.push(...push32(0), ...call32(yieldStub)); // host boundary between the terrain passes and the copy
      frame.push(0xb9, ...le32(COMPOSITE), 0xb8, ...le32(TILE)); // mov ecx,Composite; mov eax,Tile
      frame.push(...callRel(at(), SITE.fill));
      frame.push(...callRel(at(), SITE.ebolt));
      frame.push(0xb9, ...le32(VARS + 0x800)); // mov ecx, trail
      frame.push(...callRel(at(), SITE.trail));
      frame.push(0xc3);
      m.code(FRAME_ROUTINE, frame);
      const main: number[] = [0x89, 0x25, ...le32(V.espBefore)];
      main.push(0xbb, ...le32(0xb0b0_b0b0), 0xbf, ...le32(0xd0d0_d0d0), 0xbd, ...le32(0xe0e0_e0e0));
      for (let i = 0; i < 4; i++) main.push(...callRel(PROGRAM + main.length, FRAME_ROUTINE));
      main.push(0x89, 0x25, ...le32(V.espAfter), 0x89, 0x1d, ...le32(V.ebx), 0x89, 0x35, ...le32(V.esi));
      main.push(0x89, 0x3d, ...le32(V.edi), 0x89, 0x2d, ...le32(V.ebp), ...finish);
      m.code(PROGRAM, main);

      const terrainEffects = RENDER_PASSTHROUGH.terrain | RENDER_PASSTHROUGH.effects;
      const midFrame: { applied: number; live: string[]; pending: string[] }[] = [];
      m.afterCall = () => {
        const { applied } = control.read(m.memory);
        midFrame.push({
          applied,
          live: readGateSwitches(m.memory, gates),
          pending: readGateSwitches(m.memory, gates, 'pending'),
        });
        // Frame 1: switch terrain and effects on mid-frame. Frame 2: switch everything off after the redraw request
        // was read and the terrain passes were skipped (the reviewed failure). Frame 3: the game's own full-redraw
        // request (as after a large scroll).
        if (midFrame.length === 1) expect(control.set(m.memory, terrainEffects)).toBe(true);
        if (midFrame.length === 2) expect(control.set(m.memory, 0)).toBe(true);
        if (midFrame.length === 3) m.write(GSCREEN + 0x0c, 1);
      };
      await m.run();

      const entries: number[] = [];
      for (let address = V.log; address < m.read(V.logPointer); address += 4) entries.push(m.read(address));
      const at1 = (kind: number, frameNumber: number) => kind | frameNumber;
      expect(entries.map((entry) => entry.toString(16))).toEqual(
        [
          // Frame 1: all off. The switch change requested mid-frame does not affect this frame's copy.
          at1(LOG.pass, 1),
          at1(LOG.copy, 1),
          at1(LOG.ebolt, 1),
          at1(LOG.line, 1),
          at1(LOG.trail, 1),
          // Frame 2: latched at the redraw request with MarkNeedsRedraw(1); passes skipped; switched off mid-frame,
          // yet this frame still fills with the key colour instead of copying the unmaintained Tile. The EBolt list
          // still runs (lifetimes, removal) with its line suppressed; the LineTrail draw is skipped.
          at1(LOG.mark, 2),
          at1(LOG.fill, 2),
          at1(LOG.ebolt, 2),
          // Frame 3: the switch-off latched with another full repaint; original behaviour again.
          at1(LOG.mark, 3),
          at1(LOG.pass, 3),
          at1(LOG.copy, 3),
          at1(LOG.ebolt, 3),
          at1(LOG.line, 3),
          at1(LOG.trail, 3),
          // Frame 4: no change: no MarkNeedsRedraw; the game's own request passes through unchanged.
          at1(LOG.pass, 4),
          at1(LOG.copy, 4),
          at1(LOG.ebolt, 4),
          at1(LOG.line, 4),
          at1(LOG.trail, 4),
        ].map((entry) => entry.toString(16)),
      );
      // Observed at each frame's host boundary, before that boundary's change.
      const latched = yrPassthroughSwitches(terrainEffects).sort();
      expect(
        midFrame.map(({ applied, live, pending }) => ({ applied, live: live.sort(), pending: pending.sort() })),
      ).toEqual([
        { applied: 0, live: [], pending: [] },
        { applied: terrainEffects, live: latched, pending: latched },
        { applied: 0, live: [], pending: [] },
        { applied: 0, live: [], pending: [] },
      ]);
      expect(latched).toEqual(expect.arrayContaining(['terrain:fill', 'terrain:pass1', 'ebolt:draw-all']));
      // The redraw stub returns the original request in eax and clears it.
      expect([1, 2, 3, 4].map((f) => m.read(V.fullRedraw + f * 4))).toEqual([0, 1, 1, 1]);
      expect(m.read(GSCREEN + 0x0c)).toBe(0);
      expect([m.read(V.markArgument), m.read(V.markThis)]).toEqual([1, GSCREEN]);
      // Composite->CopyFromPart(&ViewBounds, Tile, &ViewBounds, 0, 1) and Composite->FillRect(&ViewBounds, key).
      expect([0, 1, 2, 3, 4].map((i) => m.read(V.copyArgs + i * 4))).toEqual([VIEW_BOUNDS, TILE, VIEW_BOUNDS, 0, 1]);
      expect([m.read(V.fillArgs), m.read(V.fillArgs + 4)]).toEqual([VIEW_BOUNDS, RENDER_PASSTHROUGH_KEY_RGB565]);
      expect([m.read(V.copyThis), m.read(V.fillThis)]).toEqual([COMPOSITE, COMPOSITE]);
      // EBolt::DrawAll ran under a raised depth only in frame 2, where the gated primitive reported success (1).
      expect([1, 2, 3, 4].map((f) => m.read(V.eboltDepth + f * 4))).toEqual([0, 1, 0, 0]);
      expect([1, 2, 3, 4].map((f) => m.read(V.eboltLine + f * 4))).toEqual([0x2222, 1, 0x2222, 0x2222]);
      // Stack and callee-saved registers survive every stub.
      expect(m.read(V.espAfter)).toBe(m.read(V.espBefore));
      expect([m.read(V.ebx), m.read(V.esi), m.read(V.edi), m.read(V.ebp)]).toEqual([
        0xb0b0_b0b0,
        GSCREEN,
        0xd0d0_d0d0,
        0xe0e0_e0e0,
      ]);
      expect(m.read(gates.data + GATE_DATA.depth)).toBe(0);
      expect(m.read(gates.data + GATE_DATA.returnStackPointer)).toBe(gates.data + GATE_DATA.returnStack);
      const { flags, applied, counters } = control.read(m.memory);
      expect({ flags, applied }).toEqual({ flags: 0, applied: 0 });
      expect(counters).toMatchObject({
        'terrain:fill': 1,
        'redraw:request': 2,
        'terrain:pass1': 1,
        'ebolt:draw-all': 1,
        'line-trail:draw': 1,
        'blit:surface-line-colour': 1,
      });
    });
  });
});
