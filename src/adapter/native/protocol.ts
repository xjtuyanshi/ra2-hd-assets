import type { MenuSnapshot } from '../../vm86/menuSnapshot';

/** Loopback native-host wire format. No executable-specific facts belong here. */
export const NATIVE_MAGIC = 0x3142484e;
export const NATIVE_VERSION = 1;
export const NATIVE_MAX_MESSAGE = 32 * 1024 * 1024;
export const NATIVE_PAGE_SIZE = 4096;
/** Reserve complete removal membership and the largest 64 direct samples within the unchanged wire limit. */
export const NATIVE_MAX_PAGES = Math.floor(
  (NATIVE_MAX_MESSAGE - 24 - 64 * (NATIVE_PAGE_SIZE + 8)) / (NATIVE_PAGE_SIZE + 8),
);
export const NATIVE_NO_FRAME = 0xffffffff;
/** Skip cross-thread control metadata while retaining modal/input state. Empty payload stays full. */
export const NATIVE_INPUT_STATE_MINIMAL = 1;
/** Request the current game-selected Win32 cursor bitmap without controls or input-counter side effects. */
export const NATIVE_INPUT_STATE_CURSOR = 2;
/** Read-only dialog tree for picture-only menu presentation. */
export const NATIVE_INPUT_STATE_MENU = 3;

export enum NativeMessageType {
  Hello = 1,
  Read,
  Write,
  Alloc,
  Free,
  Subscribe,
  Mirror,
  Credit,
  Picture,
  Input,
  Diagnostics,
  Hook,
  Error,
  InputState,
  Ack,
  Batch,
  Sample,
}

export class NativeProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NativeProtocolError';
  }
}

export interface NativePacket {
  type: NativeMessageType;
  id: number;
  payload: Uint8Array;
}
export interface NativeHello {
  protocol: number;
  hidden?: boolean;
  pid: number;
  gameThreadId: number;
  exe: { size: number; peTimestamp: number; sha256: string; verified: boolean };
  surface: { width: number; height: number; bpp: number; format: 'RGB565' };
  limits: {
    messageBytes: number;
    pages: number;
    rules: number;
    followRuleKinds?: readonly number[];
    pageRemovals?: boolean;
    maxBudgetUs?: number;
    subscribeRevision?: boolean;
    cursorSnapshot?: boolean;
    menuSnapshot?: boolean;
  };
}
export interface NativeRange {
  address: number;
  length: number;
}
export interface NativeFollowRule {
  kind: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
  source: number;
  bytes: number;
  maxCount: number;
  stride: number;
}
export interface NativeSubscription {
  ranges: readonly NativeRange[];
  rules: readonly NativeFollowRule[];
  maxPages: number;
  budgetUs: number;
  sampleCount: number;
  pageRemovals?: boolean;
}
export interface NativePage {
  address: number;
  bytes: Uint8Array;
}
export interface NativeMirrorUpdate {
  frame: number;
  flags: number;
  pages: NativePage[];
  samples: NativePage[];
  removedPages?: number[];
  subscriptionRevision?: number;
}
export interface NativePicture {
  frame: number;
  width: number;
  height: number;
  pixels: Uint16Array;
}
export interface NativeBatchWrite {
  address: number;
  expected: Uint8Array;
  bytes: Uint8Array;
}

export function decodeCursorSnapshot(bytes: Uint8Array) {
  if (bytes.length < 28) throw new NativeProtocolError('Short native cursor snapshot');
  const source = view(bytes);
  const handle = source.getUint32(0, true),
    width = source.getUint32(4, true),
    height = source.getUint32(8, true);
  if (bytes.length === 28 && bytes.every((byte) => byte === 0)) return undefined;
  const hotspotX = source.getUint32(12, true),
    hotspotY = source.getUint32(16, true);
  if (
    !handle ||
    width < 1 ||
    width > 256 ||
    height < 1 ||
    height > 256 ||
    hotspotX > width ||
    hotspotY > height ||
    bytes.length !== 28 + width * height * 4
  )
    throw new NativeProtocolError('Invalid native cursor snapshot');
  return {
    handle,
    width,
    height,
    hotspotX,
    hotspotY,
    x: source.getInt32(20, true),
    y: source.getInt32(24, true),
    rgba: bytes.slice(28),
  };
}

function uint(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
    throw new NativeProtocolError(`Invalid ${name}`);
  }
  return value;
}
function range(address: number, length: number): void {
  uint(address, 'address');
  uint(length, 'length');
  if (address + length > 0x100000000) throw new NativeProtocolError('Address range wraps');
}
function view(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

export function encodeU32(...values: number[]): Uint8Array {
  const bytes = new Uint8Array(values.length * 4);
  const target = view(bytes);
  values.forEach((value, index) => target.setUint32(index * 4, uint(value, 'u32'), true));
  return bytes;
}

export function encodePacket(type: NativeMessageType, id: number, payload: Uint8Array = new Uint8Array()): Uint8Array {
  if (!Number.isInteger(type) || type < NativeMessageType.Hello || type > NativeMessageType.Sample) {
    throw new NativeProtocolError('Unknown message type');
  }
  if (payload.byteLength > NATIVE_MAX_MESSAGE) throw new NativeProtocolError('Message exceeds limit');
  const bytes = new Uint8Array(16 + payload.byteLength);
  const target = view(bytes);
  target.setUint32(0, NATIVE_MAGIC, true);
  target.setUint16(4, NATIVE_VERSION, true);
  target.setUint16(6, type, true);
  target.setUint32(8, uint(id, 'request id'), true);
  target.setUint32(12, payload.byteLength, true);
  bytes.set(payload, 16);
  return bytes;
}

export function decodePacket(input: ArrayBuffer | Uint8Array): NativePacket {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.byteLength < 16 || bytes.byteLength > NATIVE_MAX_MESSAGE + 16) {
    throw new NativeProtocolError('Invalid message size');
  }
  const source = view(bytes);
  if (source.getUint32(0, true) !== NATIVE_MAGIC || source.getUint16(4, true) !== NATIVE_VERSION) {
    throw new NativeProtocolError('Unknown protocol magic or version');
  }
  const type = source.getUint16(6, true);
  if (type < NativeMessageType.Hello || type > NativeMessageType.Sample) {
    throw new NativeProtocolError('Unknown message type');
  }
  if (source.getUint32(12, true) !== bytes.byteLength - 16) throw new NativeProtocolError('Message length mismatch');
  return { type, id: source.getUint32(8, true), payload: bytes.subarray(16) };
}

export function decodeJson(payload: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(payload));
  } catch {
    throw new NativeProtocolError('Invalid UTF-8 JSON');
  }
}

export function decodeMenuSnapshot(payload: Uint8Array): MenuSnapshot | null {
  const value = decodeJson(payload) as MenuSnapshot | null;
  if (value === null) return null;
  const integer = (item: unknown) => typeof item === 'number' && Number.isSafeInteger(item);
  if (
    !value ||
    !integer(value.width) ||
    !integer(value.height) ||
    value.width < 1 ||
    value.height < 1 ||
    value.width > 4096 ||
    value.height > 4096 ||
    !integer(value.dialogHwnd) ||
    value.dialogHwnd <= 0 ||
    typeof value.complete !== 'boolean' ||
    (value.moviePlaying !== null && typeof value.moviePlaying !== 'boolean') ||
    !value.pointer ||
    !integer(value.pointer.x) ||
    !integer(value.pointer.y) ||
    !Array.isArray(value.controls) ||
    value.controls.length > 128 ||
    !value.controls.every(
      (control) =>
        control &&
        integer(control.hwnd) &&
        control.hwnd > 0 &&
        integer(control.parent) &&
        integer(control.id) &&
        integer(control.style) &&
        typeof control.className === 'string' &&
        control.className.length <= 64 &&
        typeof control.text === 'string' &&
        control.text.length <= 4096 &&
        typeof control.textComplete === 'boolean' &&
        typeof control.visible === 'boolean' &&
        typeof control.enabled === 'boolean' &&
        typeof control.focused === 'boolean' &&
        typeof control.pressed === 'boolean' &&
        control.rect &&
        Object.values(control.rect).length === 4 &&
        integer(control.rect.x) &&
        integer(control.rect.y) &&
        integer(control.rect.width) &&
        integer(control.rect.height) &&
        control.rect.width >= 0 &&
        control.rect.height >= 0 &&
        (control.items === undefined ||
          (Array.isArray(control.items) &&
            control.items.length <= 4096 &&
            control.items.every((item) => typeof item === 'string' && item.length <= 4096))) &&
        (control.selection === undefined || control.selection === null || integer(control.selection)),
    )
  )
    throw new NativeProtocolError('Invalid native menu snapshot');
  return value;
}

export function decodeHello(payload: Uint8Array): NativeHello {
  const candidate = decodeJson(payload) as Partial<NativeHello> | null;
  const hello = candidate;
  if (!hello || hello.protocol !== NATIVE_VERSION || !hello.exe || !hello.surface || !hello.limits) {
    throw new NativeProtocolError('Invalid native hello');
  }
  uint(hello.pid!, 'pid');
  uint(hello.gameThreadId!, 'game thread id');
  uint(hello.exe.size, 'executable size');
  uint(hello.exe.peTimestamp, 'PE timestamp');
  if (
    !hello.pid ||
    typeof hello.exe.verified !== 'boolean' ||
    typeof hello.exe.sha256 !== 'string' ||
    (hello.exe.sha256 !== '' && !/^[0-9a-f]{64}$/.test(hello.exe.sha256))
  ) {
    throw new NativeProtocolError('Invalid native executable identity');
  }
  uint(hello.surface.width, 'surface width');
  uint(hello.surface.height, 'surface height');
  uint(hello.surface.bpp, 'surface format');
  if (
    hello.surface.format !== 'RGB565' ||
    !Number.isInteger(hello.limits.messageBytes) ||
    hello.limits.messageBytes <= 0 ||
    hello.limits.messageBytes > NATIVE_MAX_MESSAGE ||
    !Number.isInteger(hello.limits.pages) ||
    hello.limits.pages <= 0 ||
    hello.limits.pages > NATIVE_MAX_PAGES ||
    !Number.isInteger(hello.limits.rules) ||
    hello.limits.rules <= 0 ||
    hello.limits.rules > 256
  ) {
    throw new NativeProtocolError('Invalid native limits or surface');
  }
  if (
    hello.limits.followRuleKinds !== undefined &&
    (!Array.isArray(hello.limits.followRuleKinds) ||
      hello.limits.followRuleKinds.some((kind) => ![1, 2, 3, 4, 5, 6, 7, 8].includes(kind)) ||
      new Set(hello.limits.followRuleKinds).size !== hello.limits.followRuleKinds.length)
  )
    throw new NativeProtocolError('Invalid native follow-rule capabilities');
  if (hello.limits.pageRemovals !== undefined && typeof hello.limits.pageRemovals !== 'boolean')
    throw new NativeProtocolError('Invalid native page-removal capability');
  if (hello.limits.subscribeRevision !== undefined && typeof hello.limits.subscribeRevision !== 'boolean')
    throw new NativeProtocolError('Invalid native subscription-revision capability');
  if (hello.limits.cursorSnapshot !== undefined && typeof hello.limits.cursorSnapshot !== 'boolean')
    throw new NativeProtocolError('Invalid native cursor-snapshot capability');
  if (hello.limits.menuSnapshot !== undefined && typeof hello.limits.menuSnapshot !== 'boolean')
    throw new NativeProtocolError('Invalid native menu-snapshot capability');
  if (
    hello.limits.maxBudgetUs !== undefined &&
    (!Number.isInteger(hello.limits.maxBudgetUs) || hello.limits.maxBudgetUs < 100 || hello.limits.maxBudgetUs > 20000)
  )
    throw new NativeProtocolError('Invalid native hook-budget capability');
  return hello as NativeHello;
}

export function encodeSubscription(subscription: NativeSubscription): Uint8Array {
  const { ranges, rules, maxPages, budgetUs, sampleCount, pageRemovals } = subscription;
  if (
    ranges.length > 4096 ||
    rules.length > 256 ||
    !Number.isInteger(maxPages) ||
    maxPages < 1 ||
    maxPages > NATIVE_MAX_PAGES ||
    !Number.isInteger(budgetUs) ||
    budgetUs < 100 ||
    budgetUs > 20000 ||
    !Number.isInteger(sampleCount) ||
    sampleCount < 0 ||
    sampleCount > 64 ||
    (pageRemovals !== undefined && typeof pageRemovals !== 'boolean')
  ) {
    throw new NativeProtocolError('Subscription exceeds bounds');
  }
  const values = [ranges.length, rules.length, maxPages, budgetUs, sampleCount + (pageRemovals ? 0x80000000 : 0)];
  for (const item of ranges) {
    range(item.address, item.length);
    values.push(item.address, item.length);
  }
  for (const rule of rules) {
    if (
      ![1, 2, 3, 4, 5, 6, 7, 8].includes(rule.kind) ||
      rule.bytes < 1 ||
      rule.bytes > NATIVE_MAX_PAGES * NATIVE_PAGE_SIZE ||
      (rule.kind !== 1 && (!rule.maxCount || rule.maxCount > 65536)) ||
      (rule.kind === 3 && !rule.stride) ||
      (rule.kind >= 4 &&
        rule.kind <= 6 &&
        rule.stride + (rule.kind === 4 ? 20 : rule.kind === 6 ? 12 : 4) > 0x100000000)
    ) {
      throw new NativeProtocolError('Invalid follow rule');
    }
    range(rule.source, rule.kind === 1 ? 4 : 20);
    values.push(rule.kind, rule.source, rule.bytes, rule.maxCount, rule.stride);
  }
  return encodeU32(...values);
}
export const encodeSubscribe = encodeSubscription;

export function encodeSamples(samples: readonly NativeRange[]): Uint8Array {
  if (samples.length > 16) throw new NativeProtocolError('Fixed sample count exceeds limit');
  const values = [samples.length];
  for (const sample of samples) {
    range(sample.address, sample.length);
    if (!sample.length || sample.length > 64) throw new NativeProtocolError('Fixed sample length exceeds limit');
    values.push(sample.address, sample.length);
  }
  return encodeU32(...values);
}

export function decodeMirror(payload: Uint8Array): NativeMirrorUpdate {
  if (payload.byteLength < 16 || payload.byteLength > NATIVE_MAX_MESSAGE)
    throw new NativeProtocolError('Invalid mirror size');
  const source = view(payload);
  const frame = source.getUint32(0, true);
  const flags = source.getUint32(4, true);
  const pageCount = source.getUint32(8, true);
  const sampleCount = source.getUint32(12, true);
  if (
    flags & ~31 ||
    (flags & 8 && flags & 7) ||
    (flags & 16 && flags & 5) ||
    pageCount > NATIVE_MAX_PAGES ||
    sampleCount > 64
  )
    throw new NativeProtocolError('Invalid mirror bounds');
  let offset = 16;
  const pages: NativePage[] = [],
    samples: NativePage[] = [];
  const seen = new Set<number>();
  for (let index = 0; index < pageCount; index++) {
    if (offset + 4 + NATIVE_PAGE_SIZE > payload.byteLength) throw new NativeProtocolError('Truncated mirror page');
    const address = source.getUint32(offset, true);
    if (address % NATIVE_PAGE_SIZE || seen.has(address))
      throw new NativeProtocolError('Invalid or duplicate mirror page');
    seen.add(address);
    offset += 4;
    pages.push({ address, bytes: payload.subarray(offset, offset + NATIVE_PAGE_SIZE) });
    offset += NATIVE_PAGE_SIZE;
  }
  for (let index = 0; index < sampleCount; index++) {
    if (offset + 8 > payload.byteLength) throw new NativeProtocolError('Truncated mirror sample header');
    const address = source.getUint32(offset, true),
      length = source.getUint32(offset + 4, true);
    offset += 8;
    range(address, length);
    if (!length || length > NATIVE_PAGE_SIZE || offset + length > payload.byteLength)
      throw new NativeProtocolError('Invalid mirror sample');
    samples.push({ address, bytes: payload.subarray(offset, offset + length) });
    offset += length;
  }
  let removedPages: number[] | undefined;
  if (flags & 8) {
    if (offset + 4 > payload.byteLength) throw new NativeProtocolError('Truncated mirror removal count');
    const removedCount = source.getUint32(offset, true);
    offset += 4;
    if (removedCount > NATIVE_MAX_PAGES || offset + removedCount * 4 > payload.byteLength)
      throw new NativeProtocolError('Invalid mirror removal bounds');
    removedPages = [];
    let previous = -1;
    for (let index = 0; index < removedCount; index++) {
      const address = source.getUint32(offset, true);
      if (address % NATIVE_PAGE_SIZE || address <= previous || seen.has(address))
        throw new NativeProtocolError('Invalid mirror removal page');
      removedPages.push(address);
      previous = address;
      offset += 4;
    }
  }
  let subscriptionRevision: number | undefined;
  if (flags & 16) {
    if (offset + 4 > payload.byteLength) throw new NativeProtocolError('Truncated mirror subscription revision');
    subscriptionRevision = source.getUint32(offset, true);
    offset += 4;
  }
  if (offset !== payload.byteLength) throw new NativeProtocolError('Trailing mirror bytes');
  return {
    frame,
    flags,
    pages,
    samples,
    ...(removedPages ? { removedPages } : {}),
    ...(subscriptionRevision !== undefined ? { subscriptionRevision } : {}),
  };
}

export function encodeWrite(address: number, bytes: Uint8Array): Uint8Array {
  range(address, bytes.byteLength);
  if (bytes.byteLength > NATIVE_MAX_MESSAGE - 8) throw new NativeProtocolError('Write exceeds message limit');
  const payload = new Uint8Array(8 + bytes.byteLength);
  payload.set(encodeU32(address, bytes.byteLength));
  payload.set(bytes, 8);
  return payload;
}

export function encodeBatch(writes: readonly NativeBatchWrite[]): Uint8Array {
  let amount = 0;
  if (!writes.length || writes.length > 256) throw new NativeProtocolError('Invalid batch count');
  for (const write of writes) {
    range(write.address, write.bytes.byteLength);
    if (!write.bytes.byteLength || write.expected.byteLength !== write.bytes.byteLength)
      throw new NativeProtocolError('Batch signature length mismatch');
    amount += write.bytes.byteLength;
  }
  if (amount > 65536) throw new NativeProtocolError('Batch exceeds write limit');
  const payload = new Uint8Array(4 + writes.length * 8 + amount * 2);
  payload.set(encodeU32(writes.length));
  let offset = 4;
  for (const write of writes) {
    payload.set(encodeU32(write.address, write.bytes.byteLength), offset);
    offset += 8;
    payload.set(write.expected, offset);
    offset += write.expected.byteLength;
    payload.set(write.bytes, offset);
    offset += write.bytes.byteLength;
  }
  return payload;
}

/** Applies row deltas only after validating the entire picture, preserving the previous good baseline on failure. */
export class NativePictureDecoder {
  private previous: NativePicture | null = null;

  reset(): void {
    this.previous = null;
  }

  apply(payload: Uint8Array): NativePicture {
    if (payload.byteLength < 16 || payload.byteLength > NATIVE_MAX_MESSAGE)
      throw new NativeProtocolError('Invalid picture size');
    const source = view(payload);
    const frame = source.getUint32(0, true),
      width = source.getUint32(4, true),
      height = source.getUint32(8, true);
    const rowCount = source.getUint32(12, true);
    if (!width || !height || width > 4096 || height > 4096 || width * height > 2 * 1024 * 1024 || rowCount > height) {
      throw new NativeProtocolError('Invalid picture dimensions');
    }
    const matching = this.previous?.width === width && this.previous.height === height;
    if (!matching && rowCount !== height) throw new NativeProtocolError('First picture must contain every row');
    const pixels = matching ? this.previous!.pixels.slice() : new Uint16Array(width * height);
    const seen = new Set<number>();
    let offset = 16;
    for (let row = 0; row < rowCount; row++) {
      if (offset + 8 > payload.byteLength) throw new NativeProtocolError('Truncated picture row');
      const y = source.getUint32(offset, true),
        encodedBytes = source.getUint32(offset + 4, true);
      offset += 8;
      if (y >= height || seen.has(y) || encodedBytes < 2 || offset + encodedBytes > payload.byteLength)
        throw new NativeProtocolError('Invalid picture row');
      seen.add(y);
      const end = offset + encodedBytes;
      let x = 0;
      while (offset < end) {
        if (offset + 2 > end) throw new NativeProtocolError('Truncated picture segment');
        const tag = source.getUint16(offset, true),
          count = tag & 0x7fff;
        offset += 2;
        if (!count || x + count > width) throw new NativeProtocolError('Invalid picture run');
        if (tag & 0x8000) pixels.fill(0xf81f, y * width + x, y * width + x + count);
        else {
          if (offset + count * 2 > end) throw new NativeProtocolError('Truncated literal pixels');
          for (let index = 0; index < count; index++)
            pixels[y * width + x + index] = source.getUint16(offset + index * 2, true);
          offset += count * 2;
        }
        x += count;
      }
      if (x !== width) throw new NativeProtocolError('Picture row does not cover its width');
    }
    if (offset !== payload.byteLength) throw new NativeProtocolError('Trailing picture bytes');
    // Keep a private baseline: consumers may transfer or mutate the returned pixels.
    this.previous = { frame, width, height, pixels: pixels.slice() };
    return { frame, width, height, pixels };
  }
}
