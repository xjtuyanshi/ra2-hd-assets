import { describe, expect, it } from 'vitest';
import {
  GATE_DATA,
  GuestGateBuilder,
  readGateCounters,
  restoreGates,
  writeGateSwitches,
  type GuestGateOptions,
  type InstalledGates,
} from '../../../src/games/shared/guestGates';
import {
  GUEST_THREAD_CONTEXT_ESPS,
  GUEST_THREAD_CRITICAL_DEPTH,
  HYPERCALL_THREAD_CURRENT,
  HYPERCALL_THREAD_NEXT,
} from '../../../src/vm86/pe';
import { callShim } from '../../helpers/guestMemory';
import { call32, finish, le32, PROGRAM, push32, withGuestMachine, type GuestMachine } from '../../helpers/guestMachine';

/**
 * Synthetic program exercising every gate kind in real v86:
 * - a "draw" function reached through a vtable (thiscall, 2 stack arguments) that calls a "blit" primitive and records
 *   the suppression depth it sees; the vtable slot carries a suppress gate with an alternate switch chosen by a byte of
 *   the object (like AnimClass::IsBuildingAnim);
 * - the blit primitive (1 stack argument, 5-byte prologue) with an entry blit gate;
 * - a no-argument function reached through `call rel32` with a skip gate on the call site;
 * - a helper called from inside "draw" that blits too, with an unsuppress gate on that call (overlays drawn from inside
 *   a suppressed object must still appear).
 * `phase` runs all of it once; `main` runs `phase` several times, optionally calling a yield import (a host boundary
 * where the test flips switches) or a latch site between phases, on one machine.
 */
const DRAW = PROGRAM + 0x1000;
const BLIT = PROGRAM + 0x1100;
const SKIPPED = PROGRAM + 0x1200;
const HELPER = PROGRAM + 0x1500;
const VTABLE = PROGRAM + 0x1300;
const OBJECT = PROGRAM + 0x1400;
const PHASE = PROGRAM + 0x1600;
/** 5 bytes (`ret` + NOPs) a game module would replace with a jump to its latch code. */
const LATCH_SITE = PROGRAM + 0x1700;
const WORKER = PROGRAM + 0x1800;
const PROGRAM_BYTES = 0x2000;
const OBJECT_FLAG = 0x10;
const VARS = 0x0030_1000;
const V = {
  drawCount: VARS,
  blitCount: VARS + 4,
  skipCount: VARS + 8,
  depthInDraw: VARS + 12,
  drawResult: VARS + 16,
  skipResult: VARS + 20,
  espBefore: VARS + 24,
  espAfter: VARS + 28,
  esiAfter: VARS + 32,
  depthInHelper: VARS + 36,
  workerBlitResult: VARS + 40,
  workerDepth: VARS + 44,
};
const GATE_PAGE = 0x0050_0000;
const GATE_CODE = 0x0050_1000;
const inc = (address: number) => [0xff, 0x05, ...le32(address)];
const call = (from: number, to: number) => [0xe8, ...le32(to - (from + 5))];
const recordDepth = (target: number) => [0xa1, ...le32(GATE_PAGE + GATE_DATA.depth), 0xa3, ...le32(target)];
const MAIN_THREAD = { currentAddress: HYPERCALL_THREAD_CURRENT, owner: 0 } as const;

type Step = 'phase' | 'yield' | 'latch';

/**
 * Write the program. `yieldStub` is called between phases where `steps` asks for it; `drawYield` makes "draw" call it
 * right after raising the depth (to park the main thread inside a suppressed call).
 */
function writeProgram(
  machine: GuestMachine,
  steps: readonly Step[] = ['phase'],
  yieldStub?: number,
  drawYield = false,
): { skipSite: number; helperSite: number } {
  // draw(this, a, b): count, [yield], blit(0x44), helper(), remember the depth, return 0x1234 (ret 8)
  const draw = [...inc(V.drawCount)];
  if (drawYield) draw.push(...push32(0), ...call32(yieldStub!));
  draw.push(0x6a, 0x44); // push 0x44
  draw.push(...call(DRAW + draw.length, BLIT));
  const helperSite = DRAW + draw.length;
  draw.push(...call(helperSite, HELPER));
  draw.push(...recordDepth(V.depthInDraw));
  draw.push(0xb8, ...le32(0x1234), 0xc2, 8, 0);
  machine.code(DRAW, draw);
  // helper(): remember the depth, blit(0x55), return
  const helper = [...recordDepth(V.depthInHelper), 0x6a, 0x55];
  helper.push(...call(HELPER + helper.length, BLIT), 0xc3);
  machine.code(HELPER, helper);
  // blit(x): sub esp,0x10; push ebx; push ebp | count | pop ebp; pop ebx; add esp,0x10; mov eax,0x5678; ret 4
  machine.code(BLIT, [
    0x83,
    0xec,
    0x10,
    0x53,
    0x55,
    ...inc(V.blitCount),
    0x5d,
    0x5b,
    0x83,
    0xc4,
    0x10,
    0xb8,
    ...le32(0x5678),
    0xc2,
    4,
    0,
  ]);
  machine.code(SKIPPED, [...inc(V.skipCount), 0xb8, ...le32(0x9abc), 0xc3]);
  machine.write(VTABLE, DRAW);
  machine.write(OBJECT, VTABLE);
  // phase: vtable call; direct blit; skippable call; results.
  const phase: number[] = [0xb9, ...le32(OBJECT), 0x6a, 0x11, 0x6a, 0x22, 0x8b, 0x01, 0xff, 0x10]; // mov ecx,obj; push; push; call [[ecx]]
  phase.push(0xa3, ...le32(V.drawResult));
  phase.push(0x6a, 0x33);
  phase.push(...call(PHASE + phase.length, BLIT));
  const skipSite = PHASE + phase.length;
  phase.push(...call(skipSite, SKIPPED));
  phase.push(0xa3, ...le32(V.skipResult), 0xc3);
  machine.code(PHASE, phase);
  machine.code(LATCH_SITE, [0xc3, 0x90, 0x90, 0x90, 0x90]);
  // main: esi as a callee-saved sentinel; the steps; record esp/esi.
  const main: number[] = [0x89, 0x25, ...le32(V.espBefore), 0xbe, ...le32(0x5a5a_5a5a)];
  for (const step of steps) {
    if (step === 'yield') main.push(...push32(0), ...call32(yieldStub!));
    else main.push(...call(PROGRAM + main.length, step === 'phase' ? PHASE : LATCH_SITE));
  }
  main.push(0x89, 0x25, ...le32(V.espAfter), 0x89, 0x35, ...le32(V.esiAfter));
  main.push(...finish);
  machine.code(PROGRAM, main);
  return { skipSite, helperSite };
}

function install(
  machine: GuestMachine,
  { skipSite, helperSite }: ReturnType<typeof writeProgram>,
  options: GuestGateOptions & { latch?: boolean } = { thread: MAIN_THREAD },
): InstalledGates {
  const builder = new GuestGateBuilder(machine.memory, GATE_PAGE, GATE_CODE, GATE_CODE + 0x1000, options);
  if (options.latch) {
    const latch = builder.asm.here;
    builder.emitLatchSwitches();
    builder.asm.ret();
    builder.patch('latch', LATCH_SITE, [0xc3, 0x90, 0x90, 0x90, 0x90], [0xe9, ...le32(latch - (LATCH_SITE + 5))]);
  }
  builder.addGate({
    name: 'draw',
    site: { kind: 'pointer', address: VTABLE, target: DRAW },
    action: { kind: 'suppress' },
    alternate: { thisByteOffset: OBJECT_FLAG, switch: 'draw:flagged' },
  });
  builder.addGate({
    name: 'blit',
    site: { kind: 'entry', address: BLIT, prologue: [0x83, 0xec, 0x10, 0x53, 0x55] },
    action: { kind: 'blit', returnBytes: 4, returnValue: 7 },
  });
  builder.addGate({
    name: 'skip',
    site: { kind: 'call', address: skipSite, target: SKIPPED },
    action: { kind: 'skip', returnBytes: 0, returnValue: 0x55 },
  });
  builder.addGate({
    name: 'helper',
    site: { kind: 'call', address: helperSite, target: HELPER },
    action: { kind: 'unsuppress' },
  });
  const result = builder.install();
  if (!result.ok) throw new Error(result.reason);
  return result.gates;
}

function observe(machine: GuestMachine, gates: InstalledGates): Record<string, number> {
  const observed: Record<string, number> = Object.fromEntries(
    Object.entries(V).map(([name, address]) => [name, machine.read(address)]),
  );
  observed.depthAfter = machine.read(GATE_PAGE + GATE_DATA.depth);
  observed.stackAfter = machine.read(GATE_PAGE + GATE_DATA.returnStackPointer) - GATE_PAGE;
  for (const [name, count] of Object.entries(readGateCounters(machine.memory, gates))) observed[`hits:${name}`] = count;
  return observed;
}

async function run(switches: string[], flagged = false) {
  let observed: Record<string, number> = {};
  await withGuestMachine(async (machine) => {
    const sites = writeProgram(machine);
    if (flagged) machine.memory.write_memory([1], OBJECT + OBJECT_FLAG);
    const gates = install(machine, sites);
    writeGateSwitches(machine.memory, gates, switches);
    await machine.run();
    observed = observe(machine, gates);
  });
  return observed;
}

/** Counter deltas between two observations. */
const delta = (after: Record<string, number>, before: Record<string, number>, keys: readonly string[]) =>
  Object.fromEntries(keys.map((key) => [key, after[key]! - before[key]!]));
const COUNTS = ['drawCount', 'blitCount', 'skipCount', 'hits:draw', 'hits:blit', 'hits:skip'] as const;

describe('可运行时切换的客体代码闸门（真实 v86）', () => {
  it('开关全关时原样执行：结果、栈与被调用者保存寄存器不变', async () => {
    const r = await run([]);
    expect(r).toMatchObject({ drawCount: 1, blitCount: 3, skipCount: 1, depthInDraw: 0, depthInHelper: 0 });
    expect(r).toMatchObject({ drawResult: 0x1234, skipResult: 0x9abc, esiAfter: 0x5a5a_5a5a });
    expect(r).toMatchObject({ depthAfter: 0, stackAfter: GATE_DATA.returnStack });
    expect(r.espAfter).toBe(r.espBefore);
    expect(r).toMatchObject({ 'hits:draw': 0, 'hits:blit': 0, 'hits:skip': 0, 'hits:helper': 0 });
  });

  it('压制闸门照常执行原函数，只让其内部（含嵌套调用）的图元提前返回；跳过闸门直接返回指定值', async () => {
    const r = await run(['draw', 'blit', 'skip']);
    // draw and its helper still run (their logic is kept) and return through the trampoline; only nested blits stop.
    expect(r).toMatchObject({ drawCount: 1, depthInDraw: 1, depthInHelper: 1, drawResult: 0x1234, blitCount: 1 });
    expect(r).toMatchObject({ skipCount: 0, skipResult: 0x55, esiAfter: 0x5a5a_5a5a });
    expect(r).toMatchObject({ depthAfter: 0, stackAfter: GATE_DATA.returnStack });
    expect(r.espAfter).toBe(r.espBefore);
    expect(r).toMatchObject({ 'hits:draw': 1, 'hits:blit': 2, 'hits:skip': 1 });
  });

  it('解除压制闸门在调用期间清零深度并在返回后恢复', async () => {
    const r = await run(['draw', 'blit', 'helper']);
    expect(r).toMatchObject({ depthInHelper: 0, depthInDraw: 1, blitCount: 2, depthAfter: 0 });
    expect(r).toMatchObject({ stackAfter: GATE_DATA.returnStack, 'hits:helper': 1, 'hits:blit': 1 });
    expect(r.espAfter).toBe(r.espBefore);
  });

  it('图元闸门只在压制深度非零时生效', async () => {
    const r = await run(['blit']);
    expect(r).toMatchObject({ blitCount: 3, depthInDraw: 0, 'hits:blit': 0 });
  });

  it('对象标志字节选择备用开关', async () => {
    const own = await run(['draw', 'blit'], true);
    expect(own).toMatchObject({ depthInDraw: 0, blitCount: 3, 'hits:draw': 0 });
    const alternate = await run(['draw:flagged', 'blit'], true);
    expect(alternate).toMatchObject({ depthInDraw: 1, blitCount: 1, 'hits:draw': 1 });
    expect(alternate.espAfter).toBe(alternate.espBefore);
  });

  it('原始字节不符时不写入任何东西；restore 还原全部站点', async () => {
    await withGuestMachine(async (machine) => {
      const sites = writeProgram(machine);
      const before = machine.memory.read_memory(PROGRAM, PROGRAM_BYTES).slice();
      const builder = new GuestGateBuilder(machine.memory, GATE_PAGE, GATE_CODE, GATE_CODE + 0x1000);
      builder.addGate({
        name: 'blit',
        site: { kind: 'entry', address: BLIT, prologue: [0x83, 0xec, 0x20, 0x53, 0x55] },
        action: { kind: 'blit', returnBytes: 4 },
      });
      const failed = builder.install();
      expect(failed.ok).toBe(false);
      if (!failed.ok) expect(failed.mismatches[0]).toMatchObject({ name: 'blit', address: BLIT });
      expect(machine.memory.read_memory(PROGRAM, PROGRAM_BYTES)).toEqual(before);
      expect(machine.memory.read_memory(GATE_PAGE, 16).every((byte) => byte === 0)).toBe(true);

      const gates = install(machine, sites);
      expect(machine.memory.read_memory(PROGRAM, PROGRAM_BYTES)).not.toEqual(before);
      restoreGates(machine.memory, gates);
      expect(machine.memory.read_memory(PROGRAM, PROGRAM_BYTES)).toEqual(before);
    });
  });
  it('同一台机器运行中翻转开关：下一阶段立即按新开关执行，关回后恢复原样', async () => {
    await withGuestMachine(async (machine) => {
      const yieldStub = machine.api('Sleep', 4);
      const sites = writeProgram(machine, ['phase', 'yield', 'phase', 'yield', 'phase'], yieldStub);
      const gates = install(machine, sites);
      const snapshots: Record<string, number>[] = [];
      machine.afterCall = () => {
        snapshots.push(observe(machine, gates));
        // The host writes the live bitmap between guest instructions (here: while the guest waits in an import).
        writeGateSwitches(machine.memory, gates, snapshots.length === 1 ? ['draw', 'blit', 'skip'] : []);
      };
      await machine.run();
      const end = observe(machine, gates);
      expect(snapshots).toHaveLength(2);
      const zero = Object.fromEntries(COUNTS.map((key) => [key, 0]));
      // Phase 1: switches off, original behaviour.
      expect(delta(snapshots[0]!, zero, COUNTS)).toEqual({
        drawCount: 1,
        blitCount: 3,
        skipCount: 1,
        'hits:draw': 0,
        'hits:blit': 0,
        'hits:skip': 0,
      });
      // Phase 2: gated after the flip; draw still runs, its blits and the skipped call do not.
      expect(delta(snapshots[1]!, snapshots[0]!, COUNTS)).toEqual({
        drawCount: 1,
        blitCount: 1,
        skipCount: 0,
        'hits:draw': 1,
        'hits:blit': 2,
        'hits:skip': 1,
      });
      expect(snapshots[1]).toMatchObject({ depthInDraw: 1, skipResult: 0x55, depthAfter: 0 });
      expect(snapshots[1]!.stackAfter).toBe(GATE_DATA.returnStack);
      // Phase 3: switched off again.
      expect(delta(end, snapshots[1]!, COUNTS)).toEqual({
        drawCount: 1,
        blitCount: 3,
        skipCount: 1,
        'hits:draw': 0,
        'hits:blit': 0,
        'hits:skip': 0,
      });
      expect(end).toMatchObject({ depthInDraw: 0, skipResult: 0x9abc, drawResult: 0x1234, esiAfter: 0x5a5a_5a5a });
      expect(end).toMatchObject({ depthAfter: 0, stackAfter: GATE_DATA.returnStack });
      expect(end.espAfter).toBe(end.espBefore);
    });
  });

  it('写入待定开关位不影响正在运行的代码，只在游戏模块选定的锁存点生效', async () => {
    await withGuestMachine(async (machine) => {
      const yieldStub = machine.api('Sleep', 4);
      const sites = writeProgram(
        machine,
        ['phase', 'yield', 'phase', 'yield', 'latch', 'phase', 'yield', 'phase', 'latch', 'phase'],
        yieldStub,
      );
      const gates = install(machine, sites, { thread: MAIN_THREAD, latch: true });
      const snapshots: Record<string, number>[] = [];
      machine.afterCall = () => {
        snapshots.push(observe(machine, gates));
        if (snapshots.length === 1) writeGateSwitches(machine.memory, gates, ['draw', 'blit', 'skip'], 'pending');
        if (snapshots.length === 3) writeGateSwitches(machine.memory, gates, [], 'pending');
      };
      await machine.run();
      const end = observe(machine, gates);
      expect(snapshots).toHaveLength(3);
      const hits = ['hits:draw', 'hits:blit', 'hits:skip'] as const;
      // Pending bits written after phase 1 change nothing in phase 2.
      expect(delta(snapshots[1]!, snapshots[0]!, hits)).toEqual({ 'hits:draw': 0, 'hits:blit': 0, 'hits:skip': 0 });
      expect(snapshots[1]).toMatchObject({ blitCount: 6, skipCount: 2 });
      // Latched before phase 3.
      expect(delta(snapshots[2]!, snapshots[1]!, hits)).toEqual({ 'hits:draw': 1, 'hits:blit': 2, 'hits:skip': 1 });
      // Cleared pending bits written after phase 3: phase 4 still gated, phase 5 (after the latch) not.
      expect(delta(end, snapshots[2]!, hits)).toEqual({ 'hits:draw': 1, 'hits:blit': 2, 'hits:skip': 1 });
      expect(end).toMatchObject({ drawCount: 5, blitCount: 6 + 1 + 1 + 3, skipCount: 3, skipResult: 0x9abc });
      expect(end).toMatchObject({ depthAfter: 0, stackAfter: GATE_DATA.returnStack, esiAfter: 0x5a5a_5a5a });
      expect(end.espAfter).toBe(end.espBefore);
    });
  });

  it.each([
    ['只对主线程生效', true],
    ['未配置线程时', false],
  ])('线程所有权（%s）：主线程停在压制调用内时，另一线程的图元照常执行', async (_label, owned) => {
    await withGuestMachine(async (machine) => {
      // Two cooperative threads, PIT preemption off; every import return switches to the other thread.
      callShim(machine.shim, 'KERNEL32.DLL!CreateThread', [0, 0x10000, WORKER, 0, 0, 0]);
      machine.write(GUEST_THREAD_CRITICAL_DEPTH, 1);
      machine.write(GUEST_THREAD_CRITICAL_DEPTH + 4, 1);
      machine.write(machine.read(GUEST_THREAD_CONTEXT_ESPS + 4) + 32, 2);
      machine.afterCall = () => machine.write(HYPERCALL_THREAD_NEXT, 1 - machine.read(HYPERCALL_THREAD_CURRENT));
      const yieldStub = machine.api('Sleep', 4);
      const sites = writeProgram(machine, ['phase'], yieldStub, true);
      // Worker: runs while the main thread is parked inside the suppressed draw (depth 1), blits, yields back.
      const worker = [...recordDepth(V.workerDepth), 0x6a, 0x66];
      worker.push(...call(WORKER + worker.length, BLIT));
      worker.push(0xa3, ...le32(V.workerBlitResult), ...push32(0), ...call32(yieldStub), 0xfa, 0xf4);
      machine.code(WORKER, worker);
      const gates = install(machine, sites, owned ? { thread: MAIN_THREAD } : {});
      writeGateSwitches(machine.memory, gates, ['draw', 'blit']);
      await machine.run();
      const r = observe(machine, gates);
      expect(r.workerDepth).toBe(1);
      // Owned: the worker's primitive runs (0x5678) and only the main thread's two nested blits return early.
      // Unowned (the old behaviour): the worker's primitive is dropped as well.
      expect(r).toMatchObject(
        owned
          ? { workerBlitResult: 0x5678, blitCount: 2, 'hits:blit': 2 }
          : { workerBlitResult: 7, blitCount: 1, 'hits:blit': 3 },
      );
      expect(r).toMatchObject({ drawCount: 1, depthInDraw: 1, drawResult: 0x1234, 'hits:draw': 1 });
      expect(r).toMatchObject({ depthAfter: 0, stackAfter: GATE_DATA.returnStack, esiAfter: 0x5a5a_5a5a });
      expect(r.espAfter).toBe(r.espBefore);
    });
  });
});
