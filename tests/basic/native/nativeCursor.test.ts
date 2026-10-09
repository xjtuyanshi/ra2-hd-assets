import { describe, expect, it } from 'vitest';
import { decodeCursorSnapshot, encodeU32, NativeProtocolError } from '../../../src/adapter/native/protocol';
import { readYrNativePointer, setYrNativePointerDrawing } from '../../../src/games/yr/nativeCursor';
import { YR_SIDEBAR } from '../../../src/games/yr/sidebarReader';
import { createGuestMemory, writeU32 } from '../../helpers/guestMemory';

const DRAW = 0x7b93f0;
const ORIGINAL = [0x83, 0xec, 0x48, 0x8b, 0xc1, 0x89, 0x44, 0x24, 0];
function fixture() {
  const memory = createGuestMemory();
  const object = 0xc00000,
    shape = 0xc01000;
  writeU32(memory, YR_SIDEBAR.mouse, object);
  writeU32(memory, YR_SIDEBAR.mouseShape, shape);
  writeU32(memory, object, 0x7f7b2c);
  writeU32(memory, object + 4, shape);
  writeU32(memory, object + 8, 93);
  memory.bytes[object + 0x10] = 1;
  writeU32(memory, object + 0x14, 320);
  writeU32(memory, object + 0x18, 210);
  writeU32(memory, object + 0x3c, 16);
  writeU32(memory, object + 0x40, 32);
  memory.write_memory([0, 0, 32, 0, 32, 0, 0xe8, 3], shape);
  return {
    memory,
    object,
    shape,
    read: async (address: number, length: number) => memory.read_memory(address, length).slice(),
  };
}

describe('native game-selected cursor', () => {
  it('removes only the validated Draw body and restores it without touching adjacent code', () => {
    const memory = createGuestMemory();
    memory.write_memory([0xbb, ...ORIGINAL, 0xaa], DRAW - 1);
    expect(setYrNativePointerDrawing(memory, false)).toBe(true);
    expect([...memory.read_memory(DRAW - 1, 11)]).toEqual([0xbb, 0xc2, 12, 0, ...Array(6).fill(0x90), 0xaa]);
    expect(setYrNativePointerDrawing(memory, true)).toBe(true);
    expect([...memory.read_memory(DRAW - 1, 11)]).toEqual([0xbb, ...ORIGINAL, 0xaa]);
    memory.bytes[DRAW + 8] = 1;
    const before = memory.read_memory(DRAW - 1, 11).slice();
    expect(setYrNativePointerDrawing(memory, false)).toBe(false);
    expect(memory.read_memory(DRAW - 1, 11)).toEqual(before);
  });

  it('keeps every current sheet frame and the game-resolved full-edge hotspot', async () => {
    const { memory, object, read } = fixture();
    for (const frame of [0, 64, 93, 185, 390, 999]) {
      writeU32(memory, object + 8, frame);
      expect(await readYrNativePointer(read, 800, 600)).toEqual({ frame, x: 320, y: 210, hotspotX: 16, hotspotY: 32 });
    }
  });

  it('distinguishes authoritative hidden/system states from incomplete or invalid samples', async () => {
    const { memory, object, read } = fixture();
    writeU32(memory, object + 12, 0xffffffff);
    expect(await readYrNativePointer(read, 800, 600)).toBeNull();
    writeU32(memory, object + 12, 0);
    memory.bytes[object + 0x10] = 0;
    expect(await readYrNativePointer(read, 800, 600)).toBeNull();
    memory.bytes[object + 0x10] = 1;
    writeU32(memory, object + 0x3c, 33);
    expect(await readYrNativePointer(read, 800, 600)).toBeUndefined();
    writeU32(memory, object + 0x3c, 16);
    expect(await readYrNativePointer(async () => new Uint8Array(), 800, 600)).toBeUndefined();
    writeU32(memory, YR_SIDEBAR.mouse, 0);
    expect(await readYrNativePointer(read, 800, 600)).toBeNull();
    writeU32(memory, YR_SIDEBAR.mouse, object);
    writeU32(memory, YR_SIDEBAR.mouseShape, 0);
    memory.bytes[object + 0x10] = 0;
    expect(await readYrNativePointer(read, 800, 600)).toBeNull();
  });

  it('uses the latest validated animation frame instead of reporting a transient hide', async () => {
    const { memory, object, shape, read } = fixture();
    expect(
      await readYrNativePointer(
        async (address, length) => {
          const bytes = await read(address, length);
          if (address === shape) writeU32(memory, object + 8, 94);
          return bytes;
        },
        800,
        600,
      ),
    ).toEqual({ frame: 94, x: 320, y: 210, hotspotX: 16, hotspotY: 32 });
  });

  it('retains uncertainty for sheet/hotspot races while honoring a sampled software-mode exit', async () => {
    const { memory, object, shape, read } = fixture();
    const changeAfterHeader = (change: () => void) => async (address: number, length: number) => {
      const bytes = await read(address, length);
      if (address === shape) change();
      return bytes;
    };
    expect(
      await readYrNativePointer(
        changeAfterHeader(() => writeU32(memory, object + 0x3c, 0)),
        800,
        600,
      ),
    ).toBeUndefined();
    writeU32(memory, object + 0x3c, 16);
    expect(
      await readYrNativePointer(
        changeAfterHeader(() => writeU32(memory, YR_SIDEBAR.mouseShape, shape + 16)),
        800,
        600,
      ),
    ).toBeUndefined();
    writeU32(memory, YR_SIDEBAR.mouseShape, shape);
    expect(
      await readYrNativePointer(
        changeAfterHeader(() => {
          memory.bytes[object + 0x10] = 0;
        }),
        800,
        600,
      ),
    ).toBeNull();
  });

  it('preserves native cursor RGBA and hotspot and rejects truncated bitmap packets', () => {
    const rgba = Uint8Array.from([4, 9, 2, 255, 0, 0, 0, 0]);
    const bytes = new Uint8Array(36);
    bytes.set(encodeU32(123, 2, 1, 1, 0, 320, 210));
    bytes.set(rgba, 28);
    expect(decodeCursorSnapshot(bytes)).toEqual({
      handle: 123,
      width: 2,
      height: 1,
      hotspotX: 1,
      hotspotY: 0,
      x: 320,
      y: 210,
      rgba,
    });
    expect(decodeCursorSnapshot(new Uint8Array(28))).toBeUndefined();
    expect(() => decodeCursorSnapshot(encodeU32(0, 0, 0, 1, 0, 0, 0))).toThrow(NativeProtocolError);
    const decoded = decodeCursorSnapshot(bytes)!;
    bytes[28] = 255;
    expect(decoded.rgba[0]).toBe(4);
    expect(() => decodeCursorSnapshot(bytes.slice(0, -1))).toThrow(NativeProtocolError);
  });
});
