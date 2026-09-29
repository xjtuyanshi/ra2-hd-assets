/** CPU baseline from 4695ab2. Run: pnpm exec node --import tsx packages/hd-renderer/benchmarks/shroud.mts */
import { performance } from 'node:perf_hooks';
import assert from 'node:assert/strict';
import { ShroudLayer } from '../src/live/shroud';

const width = 160,
  height = 160;
const snapshot = { originX: 0, originY: 0, width, height, cells: new Uint8Array(width * height).fill(2) };
const beforeFlags = new Uint8Array((width + 2) * (height + 2));
const beforeData = new Uint8Array((width + 1) * (height + 1) * 2);
let applied = { ...snapshot, cells: snapshot.cells.slice() };
/** The checkout already used a padded typed grid; its remaining per-change allocation was the applied copy. */
function baseline() {
  applied = { ...snapshot, cells: snapshot.cells.slice() };
  const stride = width + 2;
  beforeFlags.fill(0);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const value = snapshot.cells[y * width + x];
      beforeFlags[(y + 1) * stride + x + 1] = value === 2 ? 3 : value === 1 ? 1 : 0;
    }
  for (let y = 0, out = 0; y <= height; y++) {
    let top = y * stride,
      bottom = top + stride;
    for (let x = 0; x <= width; x++, out += 2, top++, bottom++) {
      const all = beforeFlags[top]! & beforeFlags[top + 1]! & beforeFlags[bottom]! & beforeFlags[bottom + 1]!;
      beforeData[out] = all & 1 ? 255 : 0;
      beforeData[out + 1] = all & 2 ? 255 : 0;
    }
  }
}
const layer = new ShroudLayer(width, height);
function optimized() {
  layer.update(snapshot);
}
function measure(run: () => void) {
  const times: number[] = [];
  for (let batch = 0; batch < 9; batch++) {
    const start = performance.now();
    for (let n = 0; n < 250; n++) {
      // Change a cell on every iteration; this intentionally excludes the unchanged-snapshot fast path.
      snapshot.cells[0] = n % 2 ? 2 : 1;
      run();
    }
    times.push((performance.now() - start) / 250);
  }
  return times.sort((a, b) => a - b)[4]!;
}
baseline();
optimized();
assert.deepEqual(layer.texture.image.data, beforeData);
const beforeMs = measure(baseline),
  afterMs = measure(optimized);
assert.deepEqual(layer.texture.image.data, beforeData);
assert.equal(applied.cells.length, width * height);
console.log(
  JSON.stringify({
    node: process.version,
    width,
    height,
    beforeMs,
    afterMs,
    beforeCopiedAllocationBytes: width * height,
    afterCopiedAllocationBytes: 0,
    note: 'Existing typed-grid baseline, changed updates only; not GPU or match FPS.',
  }),
);
