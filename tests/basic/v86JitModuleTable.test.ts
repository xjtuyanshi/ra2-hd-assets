import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { V86 } from 'v86';
import {
  expandV86JitModuleTable,
  growV86JitTable,
  isV86JitModuleCount,
  V86_JIT_EXPANDED_MODULES,
  V86_JIT_STOCK_MODULES,
  V86_JIT_TABLE_OFFSET,
} from '../../src/vm86/jitModuleTable';
import { GuestMachine, PROGRAM, finish, le32 } from '../helpers/guestMachine';

const wasm = () => new Uint8Array(readFileSync(resolve('node_modules/v86/build/v86.wasm')));

describe('compiled-module table of the pinned emulator binary', () => {
  it('rewrites only the free-slot list, each immediate in place, and reproduces the stock bytes for the stock count', async () => {
    const stock = wasm();
    const same = await expandV86JitModuleTable(stock, V86_JIT_STOCK_MODULES);
    expect(same).not.toBe(stock);
    expect(Buffer.from(same!).equals(Buffer.from(stock))).toBe(true);
    const expanded = (await expandV86JitModuleTable(stock))!;
    expect(expanded.length).toBe(stock.length);
    const changed: number[] = [];
    for (let i = 0; i < stock.length; i++) if (stock[i] !== expanded[i]) changed.push(i);
    // Nine instructions inside JitState::create_and_initialise, nothing else in two megabytes.
    expect(changed.length).toBeGreaterThan(8);
    expect(changed.length).toBeLessThanOrEqual(21);
    expect(Math.min(...changed)).toBeGreaterThanOrEqual(0x177410);
    expect(Math.max(...changed)).toBeLessThan(0x177606);
    // The input is never modified.
    expect(Buffer.from(stock).equals(Buffer.from(wasm()))).toBe(true);
  });

  it('refuses another binary and slot counts the same-length rewrite cannot encode', async () => {
    const other = wasm();
    other[other.length - 1]! ^= 1;
    expect(await expandV86JitModuleTable(other)).toBeNull();
    expect(await expandV86JitModuleTable(new Uint8Array(16))).toBeNull();
    for (const count of [898, 900, 930, V86_JIT_EXPANDED_MODULES + 32, 4095, 1.5, Number.NaN]) {
      expect(isV86JitModuleCount(count), String(count)).toBe(false);
      expect(await expandV86JitModuleTable(wasm(), count), String(count)).toBeNull();
    }
    expect(isV86JitModuleCount(V86_JIT_STOCK_MODULES + 32)).toBe(true);
    expect(isV86JitModuleCount(V86_JIT_EXPANDED_MODULES)).toBe(true);
  });

  it('grows the function table to slot 0 plus every module, and reports a table that cannot grow', () => {
    const table = new WebAssembly.Table({ element: 'anyfunc', initial: 1924 });
    expect(growV86JitTable(table, V86_JIT_EXPANDED_MODULES)).toBe(true);
    expect(table.length).toBe(V86_JIT_TABLE_OFFSET + V86_JIT_EXPANDED_MODULES + 1);
    expect(growV86JitTable(table, V86_JIT_STOCK_MODULES)).toBe(true);
    expect(table.length).toBe(V86_JIT_TABLE_OFFSET + V86_JIT_EXPANDED_MODULES + 1);
    const capped = new WebAssembly.Table({ element: 'anyfunc', initial: 1924, maximum: 1924 });
    expect(growV86JitTable(capped, V86_JIT_EXPANDED_MODULES)).toBe(false);
  });
});

/**
 * A guest whose code is hot on `pages` pages: one small counting loop per page, all of them called in turn for
 * several rounds (a page is compiled once 200,000 of its instructions were interpreted, one module at a time).
 */
async function runHotPages(pages: number, expanded: boolean) {
  const bios = new Uint8Array(readFileSync(resolve('src/vm86/boot.bin')));
  const vm = new V86({
    ...(expanded
      ? {
          wasm_fn: async (imports: WebAssembly.Imports) => {
            const patched = await expandV86JitModuleTable(wasm());
            if (!patched) throw new Error('not the pinned binary');
            if (!growV86JitTable(imports.env!.__indirect_function_table as WebAssembly.Table, V86_JIT_EXPANDED_MODULES))
              throw new Error('table did not grow');
            return (await WebAssembly.instantiate(patched as BufferSource, imports)).instance.exports;
          },
        }
      : { wasm_path: resolve('node_modules/v86/build/v86.wasm') }),
    memory_size: 32 * 1024 * 1024,
    bios: { buffer: bios.buffer },
    autostart: false,
    disable_keyboard: true,
    disable_mouse: true,
    disable_speaker: true,
  });
  await new Promise<void>((done) => vm.add_listener('emulator-ready', done));
  try {
    const machine = new GuestMachine(vm);
    const BASE = 0x0100_0000,
      COUNTER = 0x0030_0100,
      ROUNDS = 8,
      LOOP = 110_000;
    // page i: mov ecx, LOOP; dec ecx; jnz -3; inc dword [COUNTER]; ret
    for (let i = 0; i < pages; i++)
      machine.code(BASE + i * 0x1000, [0xb9, ...le32(LOOP), 0x49, 0x75, 0xfd, 0xff, 0x05, ...le32(COUNTER), 0xc3]);
    // mov ebx, ROUNDS; round: mov esi, BASE; mov edi, pages; page: call esi; add esi, 0x1000; dec edi; jnz page;
    // dec ebx; jnz round
    machine.code(PROGRAM, [
      ...[0xbb, ...le32(ROUNDS), 0xbe, ...le32(BASE), 0xbf, ...le32(pages)],
      ...[0xff, 0xd6, 0x81, 0xc6, ...le32(0x1000), 0x4f, 0x75, 0xf5, 0x4b, 0x75, 0xe8],
      ...finish,
    ]);
    const cpu = (vm as unknown as { v86: { cpu: Record<string, (...args: never[]) => unknown> } }).v86.cpu;
    let compiled = 0,
      freed = 0,
      firstFreeAfter = -1;
    const finalize = cpu.codegen_finalize!,
      clear = cpu.jit_clear_func!;
    cpu.codegen_finalize = function (this: unknown, ...args: never[]) {
      compiled++;
      return finalize.apply(this, args);
    };
    cpu.jit_clear_func = function (this: unknown, ...args: never[]) {
      if (firstFreeAfter < 0) firstFreeAfter = compiled;
      freed++;
      return clear.apply(this, args);
    };
    await machine.run(120_000);
    return { compiled, freed, firstFreeAfter, counted: machine.read(COUNTER), expected: pages * ROUNDS };
  } finally {
    await vm.destroy();
  }
}

describe('real emulator with more hot code pages than the stock table has slots', () => {
  it('stock: the 900th module throws the whole compiled cache away, again and again', async () => {
    const run = await runHotPages(1000, false);
    expect(run.counted).toBe(run.expected);
    expect(run.firstFreeAfter).toBe(V86_JIT_STOCK_MODULES);
    // Every clear frees all 899 modules; the pages then count hot from zero and are compiled again.
    expect(run.freed).toBeGreaterThanOrEqual(2 * V86_JIT_STOCK_MODULES);
    expect(run.compiled).toBeGreaterThan(1000 + V86_JIT_STOCK_MODULES);
  }, 130_000);

  it('expanded: every page is compiled once and nothing is ever thrown away; the guest computes the same', async () => {
    const run = await runHotPages(1000, true);
    expect(run.counted).toBe(run.expected);
    expect(run.freed).toBe(0);
    expect(run.compiled).toBe(1000);
  }, 130_000);

  it('expanded: a program within the stock limit behaves as before', async () => {
    const run = await runHotPages(300, true);
    expect(run.counted).toBe(run.expected);
    expect(run.freed).toBe(0);
    expect(run.compiled).toBe(300);
  }, 130_000);
});
