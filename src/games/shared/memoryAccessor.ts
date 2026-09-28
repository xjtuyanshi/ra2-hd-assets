import type { GuestMemory } from '../../vm86/win32';

/**
 * Read-only little-endian access to guest memory for high-frequency observers (for example a renderer bridge polling
 * native object state every presented frame). Every method is total: an address outside the backing store reads as 0
 * (or an empty array) instead of throwing, so a stale pointer can never abort a poll. Callers still validate pointers
 * themselves; `size` lets them reject addresses beyond guest memory before following them.
 */
export interface GuestMemoryAccessor {
  /** Guest memory size in bytes; addresses at or above it are never valid. */
  readonly size: number;
  u8(address: number): number;
  u16(address: number): number;
  u32(address: number): number;
  i32(address: number): number;
  /** Returns a copy, truncated at the end of guest memory. */
  bytes(address: number, length: number): Uint8Array;
}

/**
 * Accessor over a Uint8Array covering guest address 0 upwards. v86's `read_memory(0, size)` returns such a view of
 * the live guest memory (not a copy); create the accessor right before each poll, because growing or replacing the
 * underlying WebAssembly memory detaches older views.
 */
export function createByteViewAccessor(view: Uint8Array): GuestMemoryAccessor {
  const data = new DataView(view.buffer, view.byteOffset, view.byteLength);
  const size = view.byteLength;
  const inside = (address: number, width: number) =>
    Number.isInteger(address) && address >= 0 && address + width <= size;
  return {
    size,
    u8: (address) => (inside(address, 1) ? view[address]! : 0),
    u16: (address) => (inside(address, 2) ? data.getUint16(address, true) : 0),
    u32: (address) => (inside(address, 4) ? data.getUint32(address, true) : 0),
    i32: (address) => (inside(address, 4) ? data.getInt32(address, true) : 0),
    bytes: (address, length) => {
      if (!Number.isInteger(address) || address < 0 || address >= size || !(length > 0)) return new Uint8Array(0);
      return view.slice(address, Math.min(size, address + Math.floor(length)));
    },
  };
}

/**
 * Accessor over the generic GuestMemory contract, one `read_memory` call per field. Slower than a byte view but works
 * with any GuestMemory implementation; read failures read as 0.
 */
export function createGuestMemoryAccessor(memory: GuestMemory, size: number): GuestMemoryAccessor {
  const read = (address: number, width: number): Uint8Array | null => {
    if (!Number.isInteger(address) || address < 0 || address + width > size) return null;
    try {
      const bytes = memory.read_memory(address, width);
      return bytes.length === width ? bytes : null;
    } catch {
      return null;
    }
  };
  return {
    size,
    u8: (address) => read(address, 1)?.[0] ?? 0,
    u16: (address) => {
      const b = read(address, 2);
      return b ? b[0]! | (b[1]! << 8) : 0;
    },
    u32: (address) => {
      const b = read(address, 4);
      return b ? (b[0]! | (b[1]! << 8) | (b[2]! << 16) | (b[3]! << 24)) >>> 0 : 0;
    },
    i32: (address) => {
      const b = read(address, 4);
      return b ? b[0]! | (b[1]! << 8) | (b[2]! << 16) | (b[3]! << 24) : 0;
    },
    bytes: (address, length) => {
      const clamped = Math.max(0, Math.min(Math.floor(length), size - address));
      return read(address, clamped)?.slice() ?? new Uint8Array(0);
    },
  };
}
