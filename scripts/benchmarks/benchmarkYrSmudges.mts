import { performance } from 'node:perf_hooks';
import { createByteViewAccessor } from '../../src/games/shared/memoryAccessor';
import {
  readYrSmudges,
  type YrSmudges,
  YR_SMUDGE_GLOBALS as G,
  YR_SMUDGE_OFFSETS as O,
  YR_SMUDGE_VTABLES as V,
} from '../../src/games/yr/smudgeReader';

/** Asset-free observer microbenchmark, not a game/frame-rate or Worker-transfer benchmark. */
for (const stride of [16, 1]) {
  const bytes = new Uint8Array(112 * 1024 * 1024);
  const view = new DataView(bytes.buffer);
  const set = (address: number, value: number) => view.setInt32(address, value, true);
  const slots = 512 * 512;
  const items = 0xb0_0000;
  const typeItems = 0xc0_0000;
  const type = typeItems + 0x100;
  set(G.map + O.cellItems, items);
  set(G.map + O.cellCapacity, slots);
  set(G.map + O.mapCoordBounds + 8, 511);
  set(G.map + O.mapCoordBounds + 12, 511);
  set(G.types + O.vectorItems, typeItems);
  set(G.types + O.vectorCount, 1);
  set(G.types + O.vectorCapacity, 1);
  set(typeItems, type);
  set(type, V.type);
  bytes.set(new TextEncoder().encode('TEST'), type + O.typeId);
  const firstCell = 0xc0_1000;
  let at = firstCell;
  let existingCells = 0;
  for (let slot = 0; slot < slots; slot += stride) {
    set(items + slot * 4, at);
    set(at, V.cell);
    set(at + O.cellMapCoords, (Math.floor(slot / 512) << 16) | (slot % 512));
    set(at + O.cellSmudgeType, slot % 5 === 0 ? 0 : -1);
    at += 0x148;
    existingCells++;
  }
  const memory = createByteViewAccessor(bytes);
  let reuse: YrSmudges | null = null;
  for (let i = 0; i < 30; i++) reuse = readYrSmudges(memory, { reuse });
  if (!reuse) throw new Error('Synthetic map must be readable');
  const measure = (mode: 'unchanged' | 'one-changed-cell') => {
    const timings: number[] = [];
    const beforeRevision = reuse!.revision;
    for (let i = 0; i < 200; i++) {
      if (mode === 'one-changed-cell') bytes[firstCell + O.cellSmudgeData] = (i + 1) % 256;
      const start = performance.now();
      reuse = readYrSmudges(memory, { reuse });
      timings.push(performance.now() - start);
      if (!reuse) throw new Error('Synthetic poll failed');
    }
    timings.sort((a, b) => a - b);
    return { mode, medianMs: timings[100], p95Ms: timings[190], changedPolls: reuse!.revision - beforeRevision };
  };
  console.log(
    JSON.stringify({
      slots,
      existingCells,
      outputBytes: reuse.index.byteLength + reuse.data.byteLength,
      results: [measure('unchanged'), measure('one-changed-cell')],
    }),
  );
}
