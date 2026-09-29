import type { GuestMemory } from '../../vm86/win32';
import { le32 } from './bytes';

/**
 * Runtime-switchable guest code gates: small generated x86 stubs placed in front of original functions, each enabled by
 * one bit ("switch") in a data page the host writes. With every switch off a stub only tests its bit and continues into
 * the original code, so behaviour is unchanged; the host flips switches at any time without touching code again.
 *
 * Game modules own every address and signature; this module only knows the three attachment kinds and three actions:
 *
 * - `skip`: return at once (`ret returnBytes`, eax = returnValue) instead of running the function. Only for functions
 *   that do nothing but draw: whatever else they do (ageing, freeing, list upkeep) is skipped with them.
 * - `suppress` / `unsuppress`: run the original with the shared suppression depth raised (or cleared), restoring it on
 *   return. The caller's return address is swapped for a shared trampoline and kept on a private return stack, so the
 *   stub needs no knowledge of the function's arguments or calling convention.
 * - `blit`: return at once only while the suppression depth is non-zero, i.e. while called (directly or indirectly) from
 *   inside a suppressed function. Used on low-level drawing primitives.
 *
 * Switches can be written in two ways (`writeGateSwitches`): directly into the live bitmap the stubs test, or into a
 * pending bitmap that guest code copies into the live one at a point the game module chooses (`emitLatchSwitches`),
 * typically the start of a frame, so a change never takes effect halfway through one.
 *
 * Guest threads: the suppression depth and the return stack are single words shared by every guest thread, and the VM
 * preempts threads at any instruction. With the `thread` option every gate acts only on the configured owner thread
 * (the one that runs the gated drawing code); any other thread, for example one preempting the owner while the depth
 * is raised, always runs the original code.
 *
 * Nothing is written unless every site still holds its documented original bytes (all-or-nothing), and `restore` puts
 * the original bytes back. Guest-written state (depth, return stack, counters) lives on its own 4 KiB page: v86 treats
 * writes to a page holding compiled code as self-modifying code, so data must never share a page with the stubs.
 */

/** Where a gate attaches. The installer verifies the original state before writing. */
export type GateSite =
  /** A dword function pointer (typically a vtable slot) that currently holds `target`. */
  | { readonly kind: 'pointer'; readonly address: number; readonly target: number }
  /** An `E8 rel32` call instruction that currently calls `target`. */
  | { readonly kind: 'call'; readonly address: number; readonly target: number }
  /**
   * The start of a function: `prologue` (at least 5 bytes of whole, position-independent instructions, never a branch
   * target) is replaced by a jump to the stub and re-executed there before continuing after it.
   */
  | { readonly kind: 'entry'; readonly address: number; readonly prologue: readonly number[] };

export type GateAction =
  | { readonly kind: 'skip'; readonly returnBytes: number; readonly returnValue?: number }
  | { readonly kind: 'suppress' }
  | { readonly kind: 'unsuppress' }
  | { readonly kind: 'blit'; readonly returnBytes: number; readonly returnValue?: number };

export interface GateSpec {
  /** Unique name; also the name of the switch that enables this gate. */
  readonly name: string;
  readonly site: GateSite;
  readonly action: GateAction;
  /**
   * thiscall gates only: when the byte at [ecx + thisByteOffset] is non-zero, the switch named `switch` is consulted
   * instead of the gate's own (for example to classify one class's instances into two categories).
   */
  readonly alternate?: { readonly thisByteOffset: number; readonly switch: string };
}

/** Data page layout (offsets from the page base). */
export const GATE_DATA = {
  magic: 0x000,
  depth: 0x004,
  returnStackPointer: 0x008,
  /** 256 switch bits. */
  switches: 0x010,
  /** 32 dwords owned by the game module (flags, colours, requests, statistics). */
  user: 0x030,
  /** 256 pending switch bits, copied into `switches` by `emitLatchSwitches` code. */
  pendingSwitches: 0x0c0,
  /** One hit counter per gate (incremented whenever the gate acts). */
  counters: 0x100,
  returnStack: 0x500,
  size: 0x1000,
} as const;
export const GATE_MAGIC = 0x4554_4147; // 'GATE'
export const MAX_GATE_SWITCHES = 256;
const MAX_GATES = (GATE_DATA.returnStack - GATE_DATA.counters) / 4;

type Operand = number | string;

/** Minimal x86-32 emitter for the handful of instructions the stubs need; labels may be referenced before definition. */
export class GateAssembler {
  readonly bytes: number[] = [];
  private readonly labels = new Map<string, number>();
  /** `end` is the byte index a rel32 field is relative to; null marks an absolute imm32. */
  private readonly fixups: { at: number; label: string; end: number | null }[] = [];

  constructor(readonly base: number) {}

  get here(): number {
    return this.base + this.bytes.length;
  }

  label(name: string): void {
    if (this.labels.has(name)) throw new Error(`duplicate label ${name}`);
    this.labels.set(name, this.here);
  }

  raw(...bytes: readonly number[]): this {
    for (const byte of bytes) {
      if (!Number.isInteger(byte) || byte < 0 || byte > 255) throw new Error(`bad byte ${byte}`);
      this.bytes.push(byte);
    }
    return this;
  }

  u32(value: number): this {
    return this.raw(...le32(value));
  }

  /** Absolute address of a label as an imm32 (resolved in `finish`). */
  abs32(label: string): this {
    this.fixups.push({ at: this.bytes.length, label, end: null });
    return this.u32(0);
  }

  /** rel32 to an absolute address or a label, relative to the end of the instruction (`end` bytes after the field). */
  private rel32(target: Operand): this {
    if (typeof target === 'number') return this.u32(target - (this.here + 4));
    this.fixups.push({ at: this.bytes.length, label: target, end: this.bytes.length + 4 });
    return this.u32(0);
  }

  jmp(target: Operand): this {
    return this.raw(0xe9).rel32(target);
  }
  call(target: Operand): this {
    return this.raw(0xe8).rel32(target);
  }
  /** Near conditional jump; `cc` is the low nibble of the 0F 8x opcode (2 = jc, 3 = jnc, 4 = je, 5 = jne). */
  jcc(cc: number, target: Operand): this {
    return this.raw(0x0f, 0x80 | cc).rel32(target);
  }
  jc(target: Operand): this {
    return this.jcc(2, target);
  }
  jnc(target: Operand): this {
    return this.jcc(3, target);
  }
  je(target: Operand): this {
    return this.jcc(4, target);
  }
  jne(target: Operand): this {
    return this.jcc(5, target);
  }
  jae(target: Operand): this {
    return this.jcc(3, target);
  }
  /** bt dword [address], bit (CF = bit). */
  btMem(address: number, bit: number): this {
    return this.raw(0x0f, 0xba, 0x25)
      .u32(address)
      .raw(bit & 31);
  }
  /** cmp dword [address], imm8 (sign-extended). */
  cmpMemImm8(address: number, value: number): this {
    return this.raw(0x83, 0x3d)
      .u32(address)
      .raw(value & 255);
  }
  /** cmp dword [address], imm (imm8 form when the value fits sign-extended, imm32 otherwise). */
  cmpMemImm(address: number, value: number): this {
    return value >= -128 && value <= 127
      ? this.cmpMemImm8(address, value)
      : this.raw(0x81, 0x3d).u32(address).u32(value);
  }
  /** cmp byte [ecx + offset], imm8. */
  cmpByteEcx(offset: number, value: number): this {
    return this.raw(0x80, 0xb9)
      .u32(offset)
      .raw(value & 255);
  }
  incMem(address: number): this {
    return this.raw(0xff, 0x05).u32(address);
  }
  movMemImm(address: number, value: number): this {
    return this.raw(0xc7, 0x05).u32(address).u32(value);
  }
  movEaxMem(address: number): this {
    return this.raw(0xa1).u32(address);
  }
  movMemEax(address: number): this {
    return this.raw(0xa3).u32(address);
  }
  movEcxMem(address: number): this {
    return this.raw(0x8b, 0x0d).u32(address);
  }
  movMemEcx(address: number): this {
    return this.raw(0x89, 0x0d).u32(address);
  }
  movEaxImm(value: number): this {
    return value === 0 ? this.raw(0x31, 0xc0) : this.raw(0xb8).u32(value);
  }
  pushImm(value: number): this {
    return value >= -128 && value <= 127 ? this.raw(0x6a, value & 255) : this.raw(0x68).u32(value);
  }
  pushMem(address: number): this {
    return this.raw(0xff, 0x35).u32(address);
  }
  ret(bytes = 0): this {
    if (!Number.isInteger(bytes) || bytes < 0 || bytes > 0xffff || bytes % 4) throw new Error(`bad ret ${bytes}`);
    return bytes ? this.raw(0xc2, bytes & 255, bytes >> 8) : this.raw(0xc3);
  }

  /** Resolve label references; throws on an unknown label. */
  finish(): Uint8Array {
    for (const fixup of this.fixups) {
      const target = this.labels.get(fixup.label);
      if (target === undefined) throw new Error(`unknown label ${fixup.label}`);
      const value = fixup.end === null ? target : target - (this.base + fixup.end);
      this.bytes.splice(fixup.at, 4, ...le32(value));
    }
    this.fixups.length = 0;
    return new Uint8Array(this.bytes);
  }
}

export interface GateMismatch {
  readonly name: string;
  readonly address: number;
  readonly expected: readonly number[];
  readonly actual: readonly number[];
}

/** A queued write: `original` is verified first, then replaced by `replacement`. */
interface SitePatch {
  readonly name: string;
  readonly address: number;
  readonly original: readonly number[];
  readonly replacement: readonly number[];
}

export interface InstalledGates {
  /** Page-aligned data page (GATE_DATA layout). */
  readonly data: number;
  readonly code: number;
  readonly codeSize: number;
  /** Switch name → bit index. */
  readonly switches: ReadonlyMap<string, number>;
  /** Gate name → index into the counter array. */
  readonly gates: readonly string[];
  readonly patches: readonly { name: string; address: number; original: readonly number[] }[];
}

export interface GuestGateOptions {
  /**
   * Restrict every gate to one guest thread: the dword at `currentAddress` holds the running thread's id (maintained by
   * the VM across switches), and gates act only while it equals `owner`. Supplied by the caller, which knows both the
   * VM's thread bookkeeping and which thread runs the gated code; without it gates act on every thread.
   */
  readonly thread?: { readonly currentAddress: number; readonly owner: number };
}

/**
 * Collects gates and custom patches, emits their stubs into `code`, and installs everything only if every site verifies.
 * `data` must be a 4 KiB page that holds no code; `code` must not share that page.
 */
export class GuestGateBuilder {
  readonly asm: GateAssembler;
  private readonly switchBits = new Map<string, number>();
  private readonly gateNames: string[] = [];
  private readonly patches: SitePatch[] = [];
  private readonly mismatches: GateMismatch[] = [];
  private readonly post: string = 'gate:post';

  constructor(
    private readonly memory: GuestMemory,
    readonly data: number,
    readonly code: number,
    private readonly codeLimit: number,
    private readonly options: GuestGateOptions = {},
  ) {
    if (data % 0x1000) throw new Error('gate data page must be 4 KiB aligned');
    if (code < data + GATE_DATA.size && codeLimit > data) throw new Error('gate code must not share the data page');
    const thread = options.thread;
    if (thread && (!Number.isInteger(thread.currentAddress) || !Number.isInteger(thread.owner)))
      throw new Error('bad gate thread configuration');
    this.asm = new GateAssembler(code);
    this.emitPost();
  }

  /** Bit index of a switch, allocated on first use. */
  switchBit(name: string): number {
    let bit = this.switchBits.get(name);
    if (bit === undefined) {
      bit = this.switchBits.size;
      if (bit >= MAX_GATE_SWITCHES) throw new Error('too many gate switches');
      this.switchBits.set(name, bit);
    }
    return bit;
  }

  /** Dword holding a switch bit, for `bt`. */
  switchWord(name: string): { address: number; bit: number } {
    const bit = this.switchBit(name);
    return { address: this.data + GATE_DATA.switches + (bit >> 5) * 4, bit: bit & 31 };
  }

  userWord(index: number): number {
    if (!Number.isInteger(index) || index < 0 || index >= 32) throw new Error(`bad user word ${index}`);
    return this.data + GATE_DATA.user + index * 4;
  }

  get depthAddress(): number {
    return this.data + GATE_DATA.depth;
  }

  /**
   * Emit code that copies the pending switch bitmap into the live one, preserving every register and the flags. The game
   * module places it where a switch change may take effect (see `writeGateSwitches`).
   */
  emitLatchSwitches(): void {
    const { asm } = this;
    asm.raw(0x50); // push eax
    for (let offset = 0; offset < MAX_GATE_SWITCHES / 8; offset += 4) {
      asm.movEaxMem(this.data + GATE_DATA.pendingSwitches + offset);
      asm.movMemEax(this.data + GATE_DATA.switches + offset);
    }
    asm.raw(0x58); // pop eax
  }

  /** Queue a verified byte replacement owned by the game module (for sites the three attachment kinds cannot express). */
  patch(name: string, address: number, original: readonly number[], replacement: readonly number[]): void {
    if (replacement.length !== original.length) throw new Error(`${name}: patch length differs from original`);
    this.verify(name, address, original);
    this.patches.push({ name, address, original, replacement });
  }

  /** Emit the stub for one gate and queue its site patch. Returns the stub address. */
  addGate(spec: GateSpec): number {
    if (this.gateNames.includes(spec.name)) throw new Error(`duplicate gate ${spec.name}`);
    if (this.gateNames.length >= MAX_GATES) throw new Error('too many gates');
    const index = this.gateNames.length;
    this.gateNames.push(spec.name);
    const counter = this.data + GATE_DATA.counters + index * 4;
    const { asm } = this;
    const entry = asm.here;
    const cont = `gate:${index}:continue`;
    const on = `gate:${index}:on`;
    const { action } = spec;
    if (action.kind === 'blit') {
      asm.cmpMemImm8(this.depthAddress, 0).je(cont);
    }
    const own = this.switchWord(spec.name);
    if (spec.alternate) {
      const other = this.switchWord(spec.alternate.switch);
      const alternate = `gate:${index}:alternate`;
      asm.cmpByteEcx(spec.alternate.thisByteOffset, 0).jne(alternate);
      asm.btMem(own.address, own.bit).jnc(cont).jmp(on);
      asm.label(alternate);
      asm.btMem(other.address, other.bit).jnc(cont);
    } else {
      asm.btMem(own.address, own.bit).jnc(cont);
    }
    asm.label(on);
    const thread = this.options.thread;
    if (thread) asm.cmpMemImm(thread.currentAddress, thread.owner).jne(cont);
    asm.incMem(counter);
    if (action.kind === 'skip' || action.kind === 'blit') {
      asm.movEaxImm(action.returnValue ?? 0).ret(action.returnBytes);
    } else {
      const full = `gate:${index}:full`;
      const stack = this.data + GATE_DATA.returnStackPointer;
      asm.raw(0x50, 0x51); // push eax; push ecx
      asm.movEaxMem(stack);
      asm.raw(0x3d).u32(this.data + GATE_DATA.size - 8); // cmp eax, end of the return stack (last slot unused)
      asm.jae(full); // overflow: run the original unwrapped rather than corrupt the stack
      asm.raw(0x8b, 0x4c, 0x24, 0x08); // mov ecx, [esp+8]  (caller's return address)
      asm.raw(0x89, 0x08); // mov [eax], ecx
      asm.movEcxMem(this.depthAddress);
      asm.raw(0x89, 0x48, 0x04); // mov [eax+4], ecx
      asm.raw(0x83, 0xc0, 0x08); // add eax, 8
      asm.movMemEax(stack);
      asm.raw(0xc7, 0x44, 0x24, 0x08).abs32(this.post); // mov dword [esp+8], post
      if (action.kind === 'suppress') asm.incMem(this.depthAddress);
      else asm.movMemImm(this.depthAddress, 0);
      asm.label(full);
      asm.raw(0x59, 0x58); // pop ecx; pop eax
    }
    asm.label(cont);
    this.emitContinuation(spec);
    this.queueSite(spec, entry);
    if (asm.here > this.codeLimit) throw new Error('gate code area exhausted');
    return entry;
  }

  /** Verify every queued site, then write data page, stubs and site patches; on any mismatch write nothing. */
  install(): { ok: true; gates: InstalledGates } | { ok: false; reason: string; mismatches: readonly GateMismatch[] } {
    if (this.mismatches.length) return { ok: false, reason: 'original bytes differ', mismatches: [...this.mismatches] };
    const code = this.asm.finish();
    if (this.code + code.length > this.codeLimit) return { ok: false, reason: 'code area exhausted', mismatches: [] };
    const current = this.memory.read_memory(this.data, GATE_DATA.size);
    if (current.length !== GATE_DATA.size || current.some((byte) => byte !== 0))
      return { ok: false, reason: 'data page is not free', mismatches: [] };
    const page = new Uint8Array(GATE_DATA.size);
    const view = new DataView(page.buffer);
    view.setUint32(GATE_DATA.magic, GATE_MAGIC, true);
    view.setUint32(GATE_DATA.returnStackPointer, this.data + GATE_DATA.returnStack, true);
    this.memory.write_memory(page, this.data);
    this.memory.write_memory(code, this.code);
    // Patch sites last: until then nothing reaches the stubs.
    for (const patch of this.patches) this.memory.write_memory(new Uint8Array(patch.replacement), patch.address);
    return {
      ok: true,
      gates: {
        data: this.data,
        code: this.code,
        codeSize: code.length,
        switches: new Map(this.switchBits),
        gates: [...this.gateNames],
        patches: this.patches.map(({ name, address, original }) => ({ name, address, original })),
      },
    };
  }

  private emitPost(): void {
    const { asm } = this;
    const stack = this.data + GATE_DATA.returnStackPointer;
    asm.label(this.post);
    asm.raw(0x50, 0x50, 0x51); // push eax (slot); push eax; push ecx
    asm.movEaxMem(stack);
    asm.raw(0x83, 0xe8, 0x08); // sub eax, 8
    asm.movMemEax(stack);
    asm.raw(0x8b, 0x48, 0x04); // mov ecx, [eax+4]
    asm.movMemEcx(this.depthAddress);
    asm.raw(0x8b, 0x08); // mov ecx, [eax]
    asm.raw(0x89, 0x4c, 0x24, 0x08); // mov [esp+8], ecx
    asm.raw(0x59, 0x58); // pop ecx; pop eax
    asm.ret();
  }

  private emitContinuation(spec: GateSpec): void {
    const { site } = spec;
    if (site.kind === 'entry') {
      if (site.prologue.length < 5) throw new Error(`${spec.name}: prologue shorter than a jump`);
      this.asm.raw(...site.prologue).jmp(site.address + site.prologue.length);
    } else {
      this.asm.jmp(site.target);
    }
  }

  private queueSite(spec: GateSpec, stub: number): void {
    const { site } = spec;
    if (site.kind === 'pointer') {
      const original = le32(site.target);
      this.verify(spec.name, site.address, original);
      this.patches.push({ name: spec.name, address: site.address, original, replacement: le32(stub) });
    } else if (site.kind === 'call') {
      const original = [0xe8, ...le32(site.target - (site.address + 5))];
      this.verify(spec.name, site.address, original);
      this.patches.push({
        name: spec.name,
        address: site.address,
        original,
        replacement: [0xe8, ...le32(stub - (site.address + 5))],
      });
    } else {
      const original = [...site.prologue];
      this.verify(spec.name, site.address, original);
      const replacement = [0xe9, ...le32(stub - (site.address + 5))];
      while (replacement.length < original.length) replacement.push(0x90);
      this.patches.push({ name: spec.name, address: site.address, original, replacement });
    }
  }

  private verify(name: string, address: number, expected: readonly number[]): void {
    let actual: number[];
    try {
      actual = [...this.memory.read_memory(address, expected.length)];
    } catch {
      actual = [];
    }
    if (actual.length !== expected.length || actual.some((byte, i) => byte !== expected[i]))
      this.mismatches.push({ name, address, expected: [...expected], actual });
  }
}

/**
 * Write a switch bitmap: bit i set iff the switch with index i is in `enabled`. `live` (default) takes effect at the
 * next stub the guest runs; `pending` only once guest code emitted by `emitLatchSwitches` copies it.
 */
export function writeGateSwitches(
  memory: GuestMemory,
  gates: InstalledGates,
  enabled: Iterable<string>,
  target: 'live' | 'pending' = 'live',
): void {
  const words = new Uint32Array((MAX_GATE_SWITCHES / 32) | 0);
  for (const name of enabled) {
    const bit = gates.switches.get(name);
    if (bit === undefined) continue;
    words[bit >> 5]! |= 1 << (bit & 31);
  }
  const offset = target === 'pending' ? GATE_DATA.pendingSwitches : GATE_DATA.switches;
  memory.write_memory(new Uint8Array(words.buffer), gates.data + offset);
}

/** Names of the switches set in the live or pending bitmap (diagnostics and tests). */
export function readGateSwitches(
  memory: GuestMemory,
  gates: InstalledGates,
  target: 'live' | 'pending' = 'live',
): string[] {
  const offset = target === 'pending' ? GATE_DATA.pendingSwitches : GATE_DATA.switches;
  const bytes = memory.read_memory(gates.data + offset, MAX_GATE_SWITCHES / 8);
  return [...gates.switches].filter(([, bit]) => bytes[bit >> 3]! & (1 << (bit & 7))).map(([name]) => name);
}

/** Per-gate hit counters (gate name → count). */
export function readGateCounters(memory: GuestMemory, gates: InstalledGates): Record<string, number> {
  const bytes = memory.read_memory(gates.data + GATE_DATA.counters, gates.gates.length * 4);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return Object.fromEntries(gates.gates.map((name, index) => [name, view.getUint32(index * 4, true)]));
}

/** Put every original byte back (development and tests); the stubs stay in place but are no longer reachable. */
export function restoreGates(memory: GuestMemory, gates: InstalledGates): void {
  for (const patch of [...gates.patches].reverse()) memory.write_memory(new Uint8Array(patch.original), patch.address);
}
