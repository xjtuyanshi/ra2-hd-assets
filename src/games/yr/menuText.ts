import type { MenuSnapshot } from '../../vm86/menuSnapshot';
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

function themedProcedure(memory: GuestMemory, hwnd: number): number | null {
  const table = memory.read_memory(0xac18c0, 28);
  if (table.length !== 28) return null;
  const buckets = u32(table),
    count = u32(table, 4),
    capacity = u32(table, 8),
    bits = u32(table, 12);
  if (!pointer(buckets) || !count || bits > 16 || capacity !== 2 ** bits || u32(table, 24) !== HASH) return null;
  const head = memory.read_memory(buckets + (hwnd & (capacity - 1)) * 4, 4);
  if (head.length !== 4) return null;
  let node = u32(head);
  for (let depth = 0; pointer(node) && depth < Math.min(count, 4096); depth++) {
    const entry = memory.read_memory(node, 12);
    if (entry.length !== 12) return null;
    if (u32(entry) === hwnd) return u32(entry, 4);
    const next = u32(entry, 8);
    if (next === node) return null;
    node = next;
  }
  return null;
}

function* menuTexts(
  hwnds: readonly number[],
  records?: Map<number, Uint8Array>,
): Generator<ReadBatch, ReadonlyMap<number, string>, Uint8Array[]> {
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
  const found: { hwnd: number; node: number; text: number; bytes: Uint8Array }[] = [];
  const seen = new Set<string>();
  // At most the current table population can occur in any collision chain.
  for (let depth = 0; pending.length && depth < Math.min(count, 4096); depth++) {
    const valid = pending.splice(0).filter(({ hwnd, node }) => pointer(node) && !seen.has(`${hwnd}:${node}`));
    const nodes = yield valid.map(({ node }) => [node, 0x208] as const);
    valid.forEach(({ hwnd, node }, index) => {
      seen.add(`${hwnd}:${node}`);
      const bytes = nodes[index];
      if (bytes?.length !== 0x208) return;
      if (u32(bytes) === hwnd) found.push({ hwnd, node, text: u32(bytes, 0x2c), bytes });
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
    if (entry.complete && latest?.length === 0x30 && u32(latest) === entry.hwnd && u32(latest, 0x2c) === entry.text) {
      result.set(entry.hwnd, entry.value);
      records?.set(entry.hwnd, entry.bytes);
    }
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
export function readYrVmMenuTexts(
  memory: GuestMemory,
  hwnds: readonly number[],
  records?: Map<number, Uint8Array>,
): ReadonlyMap<number, string> {
  const sample = menuTexts(hwnds, records);
  try {
    let step = sample.next();
    while (!step.done) step = sample.next(step.value.map(([address, length]) => memory.read_memory(address, length)));
    return step.value;
  } catch {
    return new Map();
  }
}

/** Capture every displayed string while the emulator is paused at its picture boundary. */
export function readYrVmMenuSnapshot(memory: GuestMemory, snapshot: MenuSnapshot): MenuSnapshot {
  const records = new Map<number, Uint8Array>();
  const texts = readYrVmMenuTexts(
    memory,
    snapshot.controls.map(({ hwnd }) => hwnd),
    records,
  );
  const readText = (address: number): string | null => {
    if (!address) return '';
    if (address < 0x10000 || address & 1) return null;
    let text = '';
    for (let offset = 0; offset < 2048;) {
      const length = Math.min(128, 4096 - ((address + offset) & 4095), 2048 - offset);
      const bytes = memory.read_memory(address + offset, length);
      if (bytes.length !== length) return null;
      for (let index = 0; index < length; index += 2) {
        const unit = bytes[index]! | (bytes[index + 1]! << 8);
        if (!unit) return text;
        text += String.fromCharCode(unit);
      }
      offset += length;
    }
    return null;
  };
  return {
    ...snapshot,
    controls: snapshot.controls.map((original) => {
      const control = { ...original };
      if (texts.has(control.hwnd)) {
        control.sourceText = control.text;
        control.text = texts.get(control.hwnd)!;
        control.textComplete = true;
      }
      const record = records.get(control.hwnd);
      if (control.id === 1696 && control.className.toLowerCase() === 'listbox') {
        delete control.edit;
        // Skirmish's NewEdit uses its own string, caret and blink state. The
        // common title at +0x28 is only the last assigned text. Its painter at
        // 0x623880 has no text-selection range; active IME composition keeps
        // this complete control original instead of inventing an empty range.
        const signature = memory.read_memory(0x614e7c, 13);
        const expected = [0x8b, 0x7e, 0x4c, 0x6a, 0, 0x83, 0xf7, 1, 0x6a, 0, 0x89, 0x7e, 0x4c];
        const composition = memory.read_memory(0xb73564, 12);
        const color = memory.read_memory(0xac184c, 4);
        if (
          record &&
          u32(record, 0x6c) === 1 &&
          themedProcedure(memory, control.hwnd) === 0x614b30 &&
          signature.length === expected.length &&
          expected.every((byte, index) => signature[index] === byte) &&
          composition.length === 12 &&
          u32(composition) === 0 &&
          u32(composition, 8) === 0 &&
          color.length === 4
        ) {
          const object = u32(record, 0x40);
          const contents = pointer(object) ? memory.read_memory(object, 4) : null;
          const text = contents?.length === 4 ? readText(u32(contents)) : null;
          const caret = u32(record, 0x44),
            firstVisible = u32(record, 0x48),
            focus = u32(record, 0x3c),
            blink = u32(record, 0x50);
          if (text !== null && caret <= text.length && firstVisible <= caret && focus <= 1 && blink <= 1) {
            // 0x60FA5D sets white to 0x00FFFFFF; 0x62010A masks the
            // original line painter's argument to its 16-bit surface.
            const packed = u32(color) & 0xffff,
              red = packed >>> 11,
              green = (packed >>> 5) & 63,
              blue = packed & 31;
            control.text = text;
            control.textComplete = true;
            control.edit = {
              caret,
              firstVisible,
              caretVisible: focus === 1 && blink === 0,
              caretColor:
                (((red << 3) | (red >>> 2)) << 16) | (((green << 2) | (green >>> 4)) << 8) | (blue << 3) | (blue >>> 2),
            };
          }
        }
      }
      if (control.className.toLowerCase() === 'listbox' && [1363, 1771].includes(control.id)) {
        // YR's choose-map ListBox procedure owns LB_SETTOPINDEX/LB_GETTOPINDEX
        // itself (0x61A3E3/0x61A411). Its state+0xF0 is node+0xF4 here;
        // the underlying USER32 list index is unchanged by scrollbar drags.
        const top = record ? u32(record, 0xf4) : -1;
        const rows = control.visibleRows;
        if (control.items && rows && top >= 0 && top <= Math.max(0, control.items.length - rows)) {
          control.topIndex = top;
        } else delete control.topIndex;
      }
      if (control.className.toLowerCase() === 'scrollbar') {
        // Type 8 installs the game's scrollbar skin; its Win32 state remains
        // zero. Type 11 leaves the shim's scrollbar painter and state in use.
        const skin = record ? u32(record, 0x6c) : 0;
        if (skin !== 11) delete control.scroll;
        if (record && skin === 8 && (control.style & 1) !== 0) {
          const borderBytes = memory.read_memory(0xac1df0, 4);
          const border = borderBytes.length === 4 ? u32(borderBytes) : -1;
          const max = u32(record, 0xf4),
            pos = u32(record, 0xf8);
          const span = control.rect.height - 2 * border - 44;
          if (
            border >= 0 &&
            border <= 8 &&
            max > 0 &&
            max <= 1000000 &&
            pos <= max &&
            span >= 14 &&
            control.rect.width > 2 * border &&
            !u32(record, 0xf0)
          ) {
            const height = Math.max(14, Math.trunc(span * (1 - 0.2 * Math.log(max + 1))));
            if (height <= span) {
              const groove = {
                x: control.rect.x + border,
                y: control.rect.y + border + 22,
                width: control.rect.width - 2 * border,
                height: span,
              };
              control.scroll = {
                min: 0,
                max,
                page: 0,
                pos,
                arrowSize: 22,
                groove,
                thumb: { ...groove, y: groove.y + Math.trunc(((span - height) * pos) / max), height },
              };
            }
          }
        }
      }
      if (record && control.className.toLowerCase() === 'combobox') {
        const popupHwnd = u32(record, 0xf8);
        const popup = snapshot.controls.find(
          (candidate) => candidate.hwnd === popupHwnd && candidate.className.toLowerCase() === 'combodropwin',
        );
        const child = records.get(popupHwnd);
        if (!popupHwnd)
          control.popup = {
            dropped: false,
            hwnd: 0,
            selection: -1,
            scrollbarHwnd: 0,
            topIndex: 0,
            rect: { ...control.rect },
          };
        else if (popup && child)
          control.popup = {
            dropped: true,
            hwnd: popupHwnd,
            selection: new DataView(child.buffer, child.byteOffset, child.byteLength).getInt32(0xec, true),
            scrollbarHwnd: u32(child, 0x10),
            topIndex: u32(child, 0xf4),
            rect: { ...popup.rect },
          };
        else delete control.popup;
      }
      if (control.className.toLowerCase() === 'combodropwin') {
        const owners = snapshot.controls.filter((candidate) => {
          const state = records.get(candidate.hwnd);
          return candidate.className.toLowerCase() === 'combobox' && state && u32(state, 0xf8) === control.hwnd;
        });
        if (owners.length === 1) control.popupOwner = owners[0]!.hwnd;
      }
      if (record && control.className.toLowerCase() === 'button' && [2, 3, 4, 5, 6, 9].includes(control.style & 15)) {
        // YR's checkbox procedure at 0x616698 returns its own state+0xE8,
        // rather than the unchanged underlying Win32 button state.
        const checked = u32(record, 0xec);
        if (checked <= 2) control.checked = checked;
        else delete control.checked;
      }
      if (record && control.className.toLowerCase() === 'msctls_trackbar32') {
        const range = u32(record, 0xf4),
          delta = u32(record, 0xf8),
          min = u32(record, 0xfc);
        const offset = u32(record, 0x100),
          step = u32(record, 0x104),
          shown = u32(record, 0x108);
        const width = control.rect.width - (shown ? 50 : 0);
        if (range > 0 && range <= 1000000 && delta <= range && min <= 1000000 && step > 0 && offset + 13 <= width) {
          // 0x61DBB9 and 0x61E27A use these cached skin coordinates and
          // quantization; the host does not map a guessed credits index.
          control.slider = {
            min,
            max: min + range,
            value: min + delta,
            valueText: shown ? String(Math.trunc((min + delta) / step) * step) : '',
            groove: { ...control.rect, width },
            thumb: { ...control.rect, x: control.rect.x + offset + 1, width: 12 },
          };
        }
      }
      if (record?.[0xd0] && control.itemData && control.itemData.length <= 50) {
        control.itemColors = control.itemData.map((_, index) => {
          const color = u32(record, 0x114 + index * 4);
          return color === 0xffffffff ? null : ((color & 255) << 16) | (color & 0xff00) | ((color >>> 16) & 255);
        });
      }
      if (control.itemsComplete === false && control.itemData) {
        try {
          // 0x6193D9..0x61941E: item data points at the record whose +8
          // field is the actual UTF-16 caption used by YR's list painter.
          const values = control.itemData.map((record) => {
            if (!pointer(record)) return null;
            const data = memory.read_memory(record + 8, 4);
            return data.length === 4 ? readText(u32(data)) : null;
          });
          if (values.every((value): value is string => value !== null)) {
            control.items = values;
            control.itemsComplete = true;
          }
        } catch {
          // A missing private record keeps the entire dialog original.
          control.itemsComplete = false;
        }
      }
      return control;
    }),
  };
}
