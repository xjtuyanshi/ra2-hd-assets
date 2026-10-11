import type { GuestMemory } from '../../vm86/win32';

// YR 1.001's common control procedure (0x61121F) looks up HWNDs in this table.
// The identity hash at 0x600660 selects a bucket; the node embeds its control
// state at +4. The 0x4B2 setter at 0x611BC1 stores UTF-16 text at state+0x28.
// Cached Win32 titles retain GUI:Blank after this private message changes text.
const TABLE = 0x00ac_1b00;
const HASH = 0x0060_0660;
const u32 = (bytes: Uint8Array, offset = 0) =>
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, true);
const pointer = (value: number) => value >= 0x10000 && value <= 0xffff_f000 && (value & 3) === 0;
type ReadBatch = readonly (readonly [number, number])[];

function* menuTexts(hwnds: readonly number[]): Generator<ReadBatch, ReadonlyMap<number, string>, Uint8Array[]> {
  const result = new Map<number, string>();
  if (!hwnds.length) return result;
  const [root, hash] = yield [
    [TABLE, 0x1c],
    [HASH, 3],
  ];
  if (root?.length !== 0x1c || hash?.length !== 3 || hash[0] !== 0x8b || hash[1] !== 0x01 || hash[2] !== 0xc3)
    return result;
  const buckets = u32(root),
    count = u32(root, 4),
    capacity = u32(root, 8),
    bits = u32(root, 12);
  if (!pointer(buckets) || count === 0 || bits > 16 || capacity !== 2 ** bits || u32(root, 24) !== HASH) return result;
  const handles = [...new Set(hwnds)];
  const heads = yield handles.map((hwnd) => [buckets + (hwnd & (capacity - 1)) * 4, 4] as const);
  const pending = handles.map((hwnd, index) => ({ hwnd, node: heads[index]?.length === 4 ? u32(heads[index]!) : 0 }));
  const found: { hwnd: number; node: number; text: number }[] = [];
  const seen = new Set<string>();
  // At most the current table population can occur in any collision chain.
  for (let depth = 0; pending.length && depth < Math.min(count, 4096); depth++) {
    const valid = pending.splice(0).filter(({ hwnd, node }) => pointer(node) && !seen.has(`${hwnd}:${node}`));
    const nodes = yield valid.map(({ node }) => [node, 0x208] as const);
    valid.forEach(({ hwnd, node }, index) => {
      seen.add(`${hwnd}:${node}`);
      const bytes = nodes[index];
      if (bytes?.length !== 0x208) return;
      if (u32(bytes) === hwnd) found.push({ hwnd, node, text: u32(bytes, 0x2c) });
      else pending.push({ hwnd, node: u32(bytes, 0x204) });
    });
  }
  const strings = found.map((entry) => ({ ...entry, offset: 0, value: '', complete: entry.text === 0 }));
  for (let pass = 0; pass < 33; pass++) {
    const active = strings.filter((entry) => !entry.complete && pointer(entry.text) && entry.offset < 4096);
    if (!active.length) break;
    const spans = active.map(
      ({ text, offset }) => [text + offset, Math.min(128, 4096 - ((text + offset) & 4095))] as const,
    );
    const chunks = yield spans;
    active.forEach((entry, index) => {
      const bytes = chunks[index];
      if (bytes?.length !== spans[index]![1]) return;
      for (let offset = 0; offset + 1 < bytes.length; offset += 2) {
        const unit = bytes[offset]! | (bytes[offset + 1]! << 8);
        if (!unit) {
          entry.complete = true;
          break;
        }
        entry.value += String.fromCharCode(unit);
      }
      entry.offset += bytes.length;
    });
  }
  const [latestRoot, ...latestNodes] = yield [[TABLE, 0x1c], ...found.map(({ node }) => [node, 0x30] as const)];
  if (latestRoot?.length !== root.length || !root.every((byte, index) => latestRoot[index] === byte)) return result;
  strings.forEach((entry, index) => {
    const latest = latestNodes[index];
    if (entry.complete && latest?.length === 0x30 && u32(latest) === entry.hwnd && u32(latest, 0x2c) === entry.text)
      result.set(entry.hwnd, entry.value);
  });
  return result;
}

/** Read the game's actual drawn strings without invoking any guest messages. */
export async function readYrNativeMenuTexts(
  read: (address: number, length: number) => Promise<Uint8Array>,
  hwnds: readonly number[],
): Promise<ReadonlyMap<number, string>> {
  const sample = menuTexts(hwnds);
  let step = sample.next();
  while (!step.done)
    step = sample.next(await Promise.all(step.value.map(([address, length]) => read(address, length))));
  return step.value;
}

/** The synchronous VM samples while guest execution is suspended on the host. */
export function readYrVmMenuTexts(memory: GuestMemory, hwnds: readonly number[]): ReadonlyMap<number, string> {
  const sample = menuTexts(hwnds);
  try {
    let step = sample.next();
    while (!step.done) step = sample.next(step.value.map(([address, length]) => memory.read_memory(address, length)));
    return step.value;
  } catch {
    return new Map();
  }
}
