import type { GuestMemory } from '../../vm86/win32';
import type { GuestMemoryAccessor } from '../../games/shared/memoryAccessor';
import { NATIVE_MAX_PAGES } from './protocol';

export const NATIVE_PAGE_SIZE = 4096;
export interface NativePage {
  address: number;
  bytes: Uint8Array;
}
export interface NativeMirrorUpdate {
  frame: number;
  flags: number;
  pages: readonly NativePage[];
  removedPages?: readonly number[];
}
export interface NativeRange {
  address: number;
  length: number;
}
export interface NativeWrite {
  address: number;
  expected: Uint8Array;
  bytes: Uint8Array;
}
export class NativeMemoryMiss extends Error {
  constructor(readonly ranges: readonly NativeRange[]) {
    super(`Native mirror is missing ${ranges.length} page ranges`);
    this.name = 'NativeMemoryMiss';
  }
}
export class NativeAllocationMiss extends Error {
  constructor(
    readonly index: number,
    readonly size: number,
    readonly alignment: number,
  ) {
    super('Native installer requires an allocation');
    this.name = 'NativeAllocationMiss';
  }
}
function checkRange(address: number, length: number): void {
  if (
    !Number.isSafeInteger(address) ||
    !Number.isSafeInteger(length) ||
    address < 0 ||
    length < 0 ||
    address + length > 0x100000000
  )
    throw new RangeError('Invalid native memory range');
}
interface MirrorPageData {
  readonly bytes: Uint8Array;
  readonly view: DataView;
  accessedEpoch?: symbol;
}
function mirrorPageData(input: Uint8Array): MirrorPageData {
  const bytes = new Uint8Array(input);
  return {
    bytes,
    view: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
  };
}
/** No dense address-space allocation and no zero substitution. Pages are immutable once published. */
export class NativeMirrorMemory implements GuestMemory {
  private pages = new Map<number, MirrorPageData>();
  private missing = new Set<number>();
  private accessed = new Set<number>();
  private observedMiss = false;
  private operationEpoch = Symbol();
  private lastPageAddress = -1;
  private lastPage: MirrorPageData | undefined;
  frame: number | null = null;
  complete = false;
  misses = 0;
  constructor(private readonly onMiss?: (ranges: readonly NativeRange[]) => void) {}
  apply(update: NativeMirrorUpdate): boolean {
    if (update.flags & 5) {
      this.complete = false;
      return false;
    }
    const next = update.flags & 2 ? new Map<number, MirrorPageData>() : new Map(this.pages);
    const removed = update.removedPages ?? [];
    if (
      update.flags & ~31 ||
      (update.flags & 8 && update.flags & 2) ||
      (update.flags & 8 && update.removedPages === undefined) ||
      (update.removedPages !== undefined && !(update.flags & 8)) ||
      removed.length > NATIVE_MAX_PAGES ||
      update.pages.length > NATIVE_MAX_PAGES
    )
      throw new Error('Invalid mirror removal bounds');
    let previous = -1;
    for (const address of removed) {
      checkRange(address, NATIVE_PAGE_SIZE);
      if (address % NATIVE_PAGE_SIZE || address <= previous) throw new Error('Invalid mirror removal page');
      next.delete(address);
      previous = address;
    }
    const seen = new Set<number>(),
      removedSet = new Set(removed);
    for (const page of update.pages) {
      checkRange(page.address, NATIVE_PAGE_SIZE);
      if (page.address % NATIVE_PAGE_SIZE || page.bytes.length !== NATIVE_PAGE_SIZE || seen.has(page.address))
        throw new Error('Invalid mirror page');
      if (removedSet.has(page.address)) throw new Error('Removed mirror page also updated');
      seen.add(page.address);
      next.set(page.address, mirrorPageData(page.bytes));
    }
    if (update.flags & 2) this.missing.clear();
    for (const address of removed) this.missing.delete(address);
    for (const page of update.pages) this.missing.delete(page.address);
    this.pages = next;
    this.lastPageAddress = -1;
    this.lastPage = undefined;
    this.frame = update.frame;
    this.complete = true;
    return true;
  }
  reset(): void {
    this.pages.clear();
    this.lastPageAddress = -1;
    this.lastPage = undefined;
    this.missing.clear();
    this.frame = null;
    this.complete = false;
    this.observedMiss = false;
    this.accessed.clear();
  }
  beginOperation(): void {
    this.observedMiss = false;
    this.accessed.clear();
    this.operationEpoch = Symbol();
  }
  get operationMissed(): boolean {
    return this.observedMiss;
  }
  get missingRanges(): NativeRange[] {
    return coalesceNativePages([...this.missing]);
  }
  /** Includes caught misses; callers may retire a scope only after a complete successful reader operation. */
  get operationRanges(): NativeRange[] {
    return coalesceNativePages([...this.accessed]);
  }
  /** Detached membership of the last accepted mirror, retained when a later update is incomplete. */
  get publishedRanges(): NativeRange[] {
    return coalesceNativePages([...this.pages.keys()]);
  }
  /** Explicit direct-read fetches are for installer transactions only, never merged into a frame image. */
  snapshot(): NativeMirrorMemory {
    const m = new NativeMirrorMemory(this.onMiss);
    m.pages = new Map(this.pages);
    m.frame = this.frame;
    m.complete = this.complete;
    return m;
  }
  installFetchedPage(address: number, bytes: Uint8Array): void {
    if (address % NATIVE_PAGE_SIZE || bytes.length !== NATIVE_PAGE_SIZE) throw new Error('Invalid fetched page');
    this.pages.set(address, mirrorPageData(bytes));
    this.lastPageAddress = -1;
    this.lastPage = undefined;
    this.missing.delete(address);
  }
  private pageData(address: number): MirrorPageData | undefined {
    const page = this.lastPageAddress === address ? this.lastPage : this.pages.get(address);
    if (this.lastPageAddress !== address) {
      this.lastPageAddress = address;
      this.lastPage = page;
    }
    // Symbols separate footprints even when snapshots share immutable page storage.
    if (!page || page.accessedEpoch !== this.operationEpoch) {
      this.accessed.add(address);
      if (page) page.accessedEpoch = this.operationEpoch;
    }
    return page;
  }
  private reportMiss(missed: number[]): never {
    for (const page of missed) this.missing.add(page);
    this.observedMiss = true;
    this.misses++;
    const ranges = coalesceNativePages(missed);
    this.onMiss?.(ranges);
    throw new NativeMemoryMiss(ranges);
  }
  private scalar(address: number, width: 1 | 2 | 4, signed = false): number {
    checkRange(address, width);
    const pageAddress = (address >>> 12) * NATIVE_PAGE_SIZE,
      offset = address & (NATIVE_PAGE_SIZE - 1),
      first = this.pageData(pageAddress);
    if (offset + width <= NATIVE_PAGE_SIZE) {
      if (!first) return this.reportMiss([pageAddress]);
      if (width === 1) return first.bytes[offset]!;
      if (width === 2) return first.view.getUint16(offset, true);
      return signed ? first.view.getInt32(offset, true) : first.view.getUint32(offset, true);
    }
    const second = this.pageData(pageAddress + NATIVE_PAGE_SIZE);
    if (!first || !second)
      return this.reportMiss([...(first ? [] : [pageAddress]), ...(second ? [] : [pageAddress + NATIVE_PAGE_SIZE])]);
    let value = 0;
    for (let index = 0; index < width; index++) {
      const at = offset + index,
        byte = at < NATIVE_PAGE_SIZE ? first.bytes[at]! : second.bytes[at - NATIVE_PAGE_SIZE]!;
      value |= byte << (index * 8);
    }
    return signed ? value : value >>> 0;
  }
  read_memory(address: number, length: number): Uint8Array {
    checkRange(address, length);
    if (!length) return new Uint8Array();
    const missed: number[] = [];
    for (
      let page = Math.floor(address / NATIVE_PAGE_SIZE) * NATIVE_PAGE_SIZE;
      page < address + length;
      page += NATIVE_PAGE_SIZE
    ) {
      if (!this.pageData(page)) missed.push(page);
    }
    if (missed.length) {
      return this.reportMiss(missed);
    }
    const result = new Uint8Array(length);
    for (let at = 0; at < length;) {
      const a = address + at,
        page = Math.floor(a / NATIVE_PAGE_SIZE) * NATIVE_PAGE_SIZE,
        offset = a - page,
        count = Math.min(length - at, NATIVE_PAGE_SIZE - offset);
      result.set(this.pages.get(page)!.bytes.subarray(offset, offset + count), at);
      at += count;
    }
    return result;
  }
  write_memory(_bytes: Uint8Array | number[], _address: number): never {
    throw new Error('Native mirror is read-only; use a buffered transaction');
  }
  /** Advisory probes never participate in strict reader retry/subscription or working-set bookkeeping. */
  isRangeAvailable(address: number, length: number): boolean {
    if (
      !this.complete ||
      !Number.isSafeInteger(address) ||
      !Number.isSafeInteger(length) ||
      address < 0 ||
      length < 0 ||
      address + length > 0x100000000
    )
      return false;
    if (length === 0) return true;
    for (
      let page = Math.floor(address / NATIVE_PAGE_SIZE) * NATIVE_PAGE_SIZE;
      page < address + length;
      page += NATIVE_PAGE_SIZE
    )
      if (!this.pages.has(page)) return false;
    return true;
  }
  accessor(size = 0x100000000): GuestMemoryAccessor {
    return {
      size,
      u8: (a) => this.scalar(a, 1),
      u16: (a) => this.scalar(a, 2),
      u32: (a) => this.scalar(a, 4),
      i32: (a) => this.scalar(a, 4, true),
      bytes: (a, n) => this.read_memory(a, n),
      isRangeAvailable: (a, n) => a + n <= size && this.isRangeAvailable(a, n),
    };
  }
}
export function coalesceNativePages(pages: readonly number[]): NativeRange[] {
  const sorted = [...new Set(pages)].sort((a, b) => a - b),
    ranges: NativeRange[] = [];
  for (const address of sorted) {
    const last = ranges.at(-1);
    if (last && last.address + last.length === address) last.length += NATIVE_PAGE_SIZE;
    else ranges.push({ address, length: NATIVE_PAGE_SIZE });
  }
  return ranges;
}
/** Reader caches own their footprints. A cold complete pass replaces only that owner's former heap pages. */
export class NativeReaderWorkingSet {
  private learned = new Set<number>();
  private owners = new Map<unknown, Set<number>>();
  constructor(private readonly maxPages = NATIVE_MAX_PAGES) {}
  private pages(ranges: readonly NativeRange[]): Set<number> {
    const pages = new Set<number>();
    for (const range of ranges) {
      checkRange(range.address, range.length);
      if (!range.length) continue;
      for (
        let page = Math.floor(range.address / NATIVE_PAGE_SIZE) * NATIVE_PAGE_SIZE;
        page < range.address + range.length;
        page += NATIVE_PAGE_SIZE
      )
        pages.add(page);
    }
    return pages;
  }
  learn(owner: unknown, ranges: readonly NativeRange[]): void {
    const pages = this.pages(ranges),
      next = new Set([...this.learned, ...pages]);
    if (next.size > this.maxPages) throw new Error('Native reader working set exceeds page limit');
    this.learned = next;
    this.owners.set(owner, new Set([...(this.owners.get(owner) ?? []), ...pages]));
  }
  complete(owner: unknown, memory: NativeMirrorMemory, cold: boolean): boolean {
    if (!memory.complete || memory.operationMissed) return false;
    const pages = this.pages(memory.operationRanges);
    this.owners.set(owner, cold ? pages : new Set([...(this.owners.get(owner) ?? []), ...pages]));
    const active = new Set([...this.owners.values()].flatMap((scope) => [...scope]));
    for (const page of this.learned) if (!active.has(page)) this.learned.delete(page);
    return true;
  }
  get ranges(): NativeRange[] {
    return coalesceNativePages([...this.learned]);
  }
  /** Owner identities stay opaque; no mutable allocation sets escape the working set. */
  get scopes(): { owner: unknown; ranges: NativeRange[] }[] {
    return [...this.owners].map(([owner, pages]) => ({ owner, ranges: coalesceNativePages([...pages]) }));
  }
  clear(): void {
    this.learned.clear();
    this.owners.clear();
  }
}
/** Keep writes local until the entire installer has completed without even a caught miss. */
export class NativeMemoryTransaction implements GuestMemory {
  private writes: { address: number; bytes: Uint8Array }[] = [];
  private allocationIndex = 0;
  constructor(
    readonly base: NativeMirrorMemory,
    private readonly allocations: readonly { address: number; size: number }[] = [],
  ) {
    base.beginOperation();
  }
  read_memory(address: number, length: number): Uint8Array {
    checkRange(address, length);
    const result = new Uint8Array(length),
      covered = new Uint8Array(length);
    for (const write of this.writes) {
      const start = Math.max(address, write.address),
        end = Math.min(address + length, write.address + write.bytes.length);
      if (start < end) {
        result.set(write.bytes.subarray(start - write.address, end - write.address), start - address);
        covered.fill(1, start - address, end - address);
      }
    }
    for (let i = 0; i < length;) {
      if (covered[i]) {
        i++;
        continue;
      }
      let end = i + 1;
      while (end < length && !covered[end]) end++;
      result.set(this.base.read_memory(address + i, end - i), i);
      i = end;
    }
    return result;
  }
  write_memory(bytes: Uint8Array | number[], address: number): void {
    checkRange(address, bytes.length);
    this.writes.push({ address, bytes: Uint8Array.from(bytes) });
  }
  reserve = (size: number, alignment = 4096): number => {
    if (
      !Number.isSafeInteger(size) ||
      size <= 0 ||
      size > 16 * 1024 * 1024 ||
      !Number.isSafeInteger(alignment) ||
      alignment < 1 ||
      alignment & (alignment - 1)
    )
      throw new Error('Invalid native reservation');
    const index = this.allocationIndex++,
      allocation = this.allocations[index];
    if (!allocation) throw new NativeAllocationMiss(index, size, alignment);
    if (allocation.size < size || allocation.address % alignment)
      throw new Error('Native allocation does not meet installer reservation');
    return allocation.address;
  };
  finish(): NativeWrite[] {
    if (this.base.operationMissed) throw new NativeMemoryMiss(this.base.missingRanges);
    /* Merge overlapping writes so expected bytes always describe pre-transaction memory. */
    const ranges = this.writes
        .map((w) => ({ start: w.address, end: w.address + w.bytes.length }))
        .sort((a, b) => a.start - b.start),
      merged: { start: number; end: number }[] = [];
    for (const r of ranges) {
      const last = merged.at(-1);
      if (last && r.start <= last.end) last.end = Math.max(last.end, r.end);
      else merged.push({ ...r });
    }
    return merged.map((r) => ({
      address: r.start,
      expected: this.base.read_memory(r.start, r.end - r.start),
      bytes: this.read_memory(r.start, r.end - r.start),
    }));
  }
}
export interface NativeTransactionHost {
  fetchPage(address: number): Promise<Uint8Array>;
  alloc(size: number, alignment: number): Promise<{ address: number; size: number }>;
  free(address: number): Promise<void>;
  commit(writes: readonly NativeWrite[]): Promise<void>;
  subscribe(ranges: readonly NativeRange[]): Promise<void>;
  nextMirror(): Promise<void>;
}
/** Readers retry only against later complete frame images, so IO reads never contaminate reader snapshots. */
export async function readNativeWithRetry<T>(
  memory: NativeMirrorMemory,
  read: () => T,
  previous: T,
  host: Pick<NativeTransactionHost, 'subscribe' | 'nextMirror'>,
  discard: () => void,
  attempts = 4,
): Promise<T> {
  for (let i = 0; i < attempts; i++) {
    memory.beginOperation();
    let result: T | undefined;
    try {
      result = read();
    } catch (error) {
      if (!(error instanceof NativeMemoryMiss)) throw error;
    }
    if (!memory.operationMissed && result !== undefined) return result;
    discard();
    await host.subscribe(memory.missingRanges);
    await host.nextMirror();
  }
  return previous;
}
/** Allocation/fetch retries recreate the whole transaction. Nothing reaches the game until commit. */
export async function runNativeTransaction<T>(
  memory: NativeMirrorMemory,
  run: (transaction: NativeMemoryTransaction) => T | Promise<T>,
  host: NativeTransactionHost,
  maxAttempts = 128,
): Promise<T> {
  const allocations: { address: number; size: number }[] = [],
    working = memory.snapshot();
  let commitStarted = false;
  try {
    for (let i = 0; i < maxAttempts; i++) {
      const tx = new NativeMemoryTransaction(working, allocations);
      try {
        const result = await run(tx);
        const writes = tx.finish();
        if (!writes.length) {
          for (const allocation of allocations) await host.free(allocation.address);
          return result;
        }
        commitStarted = true;
        await host.commit(writes);
        return result;
      } catch (error) {
        if (error instanceof NativeAllocationMiss) {
          const allocation = await host.alloc(error.size, error.alignment);
          allocations[error.index] = allocation;
          for (let page = allocation.address; page < allocation.address + allocation.size; page += NATIVE_PAGE_SIZE)
            working.installFetchedPage(page, await host.fetchPage(page));
          continue;
        }
        if (error instanceof NativeMemoryMiss) {
          for (const range of error.ranges)
            for (let page = range.address; page < range.address + range.length; page += NATIVE_PAGE_SIZE)
              working.installFetchedPage(page, await host.fetchPage(page));
          continue;
        }
        throw error;
      }
    }
    throw new Error('Native installer retry limit exceeded');
  } catch (error) {
    // A lost reply can follow a successful patch. Keep executable reservations alive
    // once commit has started; process exit reclaims them without dangling jumps.
    if (!commitStarted)
      for (const allocation of allocations) await host.free(allocation.address).catch(() => undefined);
    throw error;
  }
}
