import type { GuestMemory, VmFrame } from '../../vm86/win32';
import { YR_SIDEBAR } from './sidebarReader';

/** Pinned YR 1.001 WWMouse::Draw: drawing only, thiscall with three stack arguments (ret 12). */
const DRAW = 0x7b93f0;
const ORIGINAL = Uint8Array.from([0x83, 0xec, 0x48, 0x8b, 0xc1, 0x89, 0x44, 0x24, 0x00]);
const SUPPRESSED = Uint8Array.from([0xc2, 0x0c, 0x00, 0x90, 0x90, 0x90, 0x90, 0x90, 0x90]);
const equal = (left: Uint8Array, right: Uint8Array) =>
  left.length === right.length && left.every((byte, index) => byte === right[index]);

/** Preserve current shape, animation, visibility and native save-under ownership; remove only the final shape blit. */
export function setYrNativePointerDrawing(memory: GuestMemory, enabled: boolean): boolean {
  const current = memory.read_memory(DRAW, ORIGINAL.length);
  if (!equal(current, ORIGINAL) && !equal(current, SUPPRESSED)) return false;
  const desired = enabled ? ORIGINAL : SUPPRESSED;
  if (!equal(current, desired)) memory.write_memory(desired, DRAW);
  return true;
}

/** Direct reads are isolated from the logic mirror, and revalidate the mutable presentation fields. */
export async function readYrNativePointer(
  read: (address: number, length: number) => Promise<Uint8Array>,
  width: number,
  height: number,
): Promise<VmFrame['pointer']> {
  const roots = await Promise.all([read(YR_SIDEBAR.mouse, 4), read(YR_SIDEBAR.mouseShape, 4)]);
  const object = new DataView(roots[0]!.buffer, roots[0]!.byteOffset, 4).getUint32(0, true);
  const shape = new DataView(roots[1]!.buffer, roots[1]!.byteOffset, 4).getUint32(0, true);
  if (object < 0x10000 || object & 3 || shape < 0x10000 || shape & 3) return null;
  const first = await read(object, 0x44);
  const view = new DataView(first.buffer, first.byteOffset, first.byteLength);
  if (
    view.getUint32(0, true) !== 0x7f7b2c ||
    view.getUint32(4, true) !== shape ||
    view.getInt32(12, true) < 0 ||
    !view.getUint8(0x10)
  )
    return null;
  const header = await read(shape, 8);
  const sheet = new DataView(header.buffer, header.byteOffset, header.byteLength);
  const sheetWidth = sheet.getUint16(2, true),
    sheetHeight = sheet.getUint16(4, true);
  const frame = view.getInt32(8, true),
    hotspotX = view.getInt32(0x3c, true),
    hotspotY = view.getInt32(0x40, true);
  if (
    sheet.getUint16(0, true) !== 0 ||
    sheetWidth < 1 ||
    sheetWidth > 256 ||
    sheetHeight < 1 ||
    sheetHeight > 256 ||
    frame < 0 ||
    frame >= sheet.getUint16(6, true) ||
    hotspotX < 0 ||
    hotspotX > sheetWidth ||
    hotspotY < 0 ||
    hotspotY > sheetHeight
  )
    return null;
  const [latest, liveObject, liveShape] = await Promise.all([
    read(object, 0x44),
    read(YR_SIDEBAR.mouse, 4),
    read(YR_SIDEBAR.mouseShape, 4),
  ]);
  if (
    new DataView(liveObject.buffer, liveObject.byteOffset, 4).getUint32(0, true) !== object ||
    new DataView(liveShape.buffer, liveShape.byteOffset, 4).getUint32(0, true) !== shape
  )
    return null;
  const current = new DataView(latest.buffer, latest.byteOffset, latest.byteLength);
  for (const offset of [0, 4, 8, 0x3c, 0x40])
    if (current.getUint32(offset, true) !== view.getUint32(offset, true)) return null;
  if (current.getInt32(12, true) < 0 || !current.getUint8(0x10)) return null;
  const x = current.getInt32(0x14, true),
    y = current.getInt32(0x18, true);
  if (x < 0 || x >= width || y < 0 || y >= height) return null;
  return { frame, x, y, hotspotX, hotspotY };
}
