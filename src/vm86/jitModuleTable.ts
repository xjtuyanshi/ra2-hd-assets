import { sha256Hex } from '../utils/sha256';

/**
 * Room for compiled code in the pinned emulator build (v86 0.5.441+g847e34d, `v86.wasm` SHA-256 below).
 *
 * v86 compiles hot guest code one 4 KiB page at a time into a WebAssembly module of its own and keeps the modules
 * in a table with a fixed number of slots (its `WASM_TABLE_SIZE` of 900, slot 0 unused). A page counts as hot after
 * 200,000 interpreted instructions and its module then stays for good: nothing is evicted. When a module is needed and
 * no slot is free, the emulator throws its whole compiled cache away (v86 src/rust/jit.rs, "wasm_table_index_free_list
 * empty, clearing cache") and every page starts again in the interpreter, several times slower, until it has been
 * counted hot once more. A guest program with more than 899 pages of code that all run now and then never keeps a
 * cache: a large game's executable alone can be about a thousand pages, and the code that ran while it started up
 * holds slots during play.
 *
 * The slot count exists in the wasm binary only as the list of free slot numbers that the JIT state is created with
 * (in v86's source the one use of the constant besides a debug assertion): a `Vec<u16>` holding 1..=899, built by a
 * vectorised loop that writes 32 numbers at a time and a three-number tail. `expandV86JitModuleTable` rewrites the
 * immediates of exactly that initialisation so the list holds 1..=modules. Every rewritten immediate keeps its encoded
 * length, so no other byte of the module moves; that bounds `modules` to 899 + 32k and at most 2019 (the tail's packed
 * constant must stay a four-byte immediate). The caller must give the module's function table matching room
 * (`growV86JitTable`) before instantiating: compiled modules are stored at table index 1024 + slot.
 *
 * Nothing is rewritten unless the whole file has the pinned hash and every site holds its original bytes. With
 * another emulator build the function returns null and the stock binary runs as it is.
 */
export const V86_WASM_SHA256 = '6121632f6d657d03f2286341ed87edcafd4945fa65ae765b4c7fd0bf2554a9c7';
/** Slots of the stock build (1..=899). */
export const V86_JIT_STOCK_MODULES = 899;
/** The most a same-length rewrite allows; more than twice the code pages of the largest supported executable. */
export const V86_JIT_EXPANDED_MODULES = 2019;
/** Table index of slot 0 (v86 `WASM_TABLE_OFFSET`). */
export const V86_JIT_TABLE_OFFSET = 1024;

/** Signed LEB128 of a non-negative value in exactly `length` bytes, or null when it does not fit that length. */
function sleb(value: number, length: number): number[] | null {
  if (!Number.isInteger(value) || value < 0 || value >= 2 ** (7 * length - 1)) return null;
  return Array.from({ length }, (_, index) => ((value >>> (7 * index)) & 0x7f) | (index < length - 1 ? 0x80 : 0));
}

/** Unsigned LEB128 in exactly two bytes (a memory-access offset). */
function uleb2(value: number): number[] | null {
  if (!Number.isInteger(value) || value < 0 || value >= 1 << 14) return null;
  return [(value & 0x7f) | 0x80, value >>> 7];
}

const I32_CONST = 0x41;

interface Site {
  offset: number;
  /** Bytes of the stock build. */
  original: readonly number[];
  /** The same instruction for a list of `modules` slot numbers; null when it cannot keep its length. */
  rewrite(modules: number): number[] | null;
}

const i32Const = (value: number, length: number) => {
  const bytes = sleb(value, length);
  return bytes && [I32_CONST, ...bytes];
};

/** File offsets in the pinned `v86.wasm`: JitState::create_and_initialise, in the order the code runs. */
const SITES: readonly Site[] = [
  // Allocation of the list: 2 bytes per slot number.
  { offset: 0x177410, original: [0x41, 0x86, 0x0e], rewrite: (n) => i32Const(2 * n, 2) },
  // Its capacity.
  { offset: 0x177430, original: [0x41, 0x83, 0x07], rewrite: (n) => i32Const(n, 2) },
  // End of the vectorised loop (64 bytes = 32 numbers a turn): everything but the last three numbers.
  { offset: 0x1774db, original: [0x41, 0x80, 0x0e], rewrite: (n) => i32Const(2 * (n - 3), 2) },
  // Tail: the last number, stored as 16 bits at its place ...
  { offset: 0x1774e4, original: [0x41, 0x83, 0x07], rewrite: (n) => i32Const(n, 2) },
  {
    offset: 0x1774e7,
    original: [0x3b, 0x01, 0x84, 0x0e],
    rewrite: (n) => {
      const offset = uleb2(2 * (n - 1));
      return offset && [0x3b, 0x01, ...offset];
    },
  },
  // ... and the two before it, packed into one 32-bit store.
  {
    offset: 0x1774ed,
    original: [0x41, 0x81, 0x87, 0x88, 0x1c],
    rewrite: (n) => i32Const(((n - 1) << 16) | (n - 2), 4),
  },
  {
    offset: 0x1774f2,
    original: [0x36, 0x01, 0x80, 0x0e],
    rewrite: (n) => {
      const offset = uleb2(2 * (n - 3));
      return offset && [0x36, 0x01, ...offset];
    },
  },
  // Its length.
  { offset: 0x177503, original: [0x41, 0x83, 0x07], rewrite: (n) => i32Const(n, 2) },
  // The size reported if the allocation fails.
  { offset: 0x177603, original: [0x41, 0x86, 0x0e], rewrite: (n) => i32Const(2 * n, 2) },
];

/** Slot counts the rewrite can produce: the stock count plus whole turns of the vectorised loop. */
export function isV86JitModuleCount(modules: number): boolean {
  return (
    Number.isInteger(modules) &&
    modules >= V86_JIT_STOCK_MODULES &&
    modules <= V86_JIT_EXPANDED_MODULES &&
    (modules - V86_JIT_STOCK_MODULES) % 32 === 0
  );
}

/**
 * A copy of the pinned `v86.wasm` whose JIT keeps up to `modules` compiled modules, or null (input untouched) when
 * the bytes are not the pinned build, a site differs, or the count is not one the rewrite can encode.
 */
export async function expandV86JitModuleTable(
  wasm: Uint8Array,
  modules = V86_JIT_EXPANDED_MODULES,
): Promise<Uint8Array | null> {
  if (!isV86JitModuleCount(modules)) return null;
  if ((await sha256Hex(wasm)) !== V86_WASM_SHA256) return null;
  const patched = wasm.slice();
  for (const site of SITES) {
    if (!site.original.every((byte, index) => wasm[site.offset + index] === byte)) return null;
    const bytes = site.rewrite(modules);
    if (!bytes || bytes.length !== site.original.length) return null;
    patched.set(bytes, site.offset);
  }
  return patched;
}

/** Make the emulator's function table long enough for `modules` compiled modules; false if it cannot grow. */
export function growV86JitTable(table: WebAssembly.Table, modules: number): boolean {
  const needed = V86_JIT_TABLE_OFFSET + modules + 1;
  try {
    if (table.length < needed) table.grow(needed - table.length);
    return table.length >= needed;
  } catch {
    return false;
  }
}
