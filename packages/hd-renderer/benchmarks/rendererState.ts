/** CPU-only comparison of the original irradiance helper and its allocation-free equivalent; no FPS claim. */
import { Color } from 'three/webgpu';
import { Lighting } from '../src/lighting';

const lighting = new Lighting(128, 128);
lighting.update(19, 0.4);
const out = new Color();
const iterations = 2_000_000;
let checksum = 0;
function before(): void {
  const sunHeight = Math.max(0, lighting.state.sunDirection.y);
  out
    .copy(lighting.sun.color)
    .multiplyScalar(lighting.sun.intensity * sunHeight)
    .add(lighting.hemi.color.clone().multiplyScalar(lighting.hemi.intensity));
  checksum += out.r;
}
function after(): void {
  lighting.flatIrradianceColor(out);
  checksum += out.r;
}
function measure(run: () => void): number {
  const start = performance.now();
  for (let i = 0; i < iterations; i++) run();
  return performance.now() - start;
}
measure(before);
measure(after);
const beforeMs: number[] = [];
const afterMs: number[] = [];
for (let i = 0; i < 7; i++) {
  beforeMs.push(measure(before));
  afterMs.push(measure(after));
}
const median = (values: number[]) => values.sort((a, b) => a - b)[3]!;
const original = median(beforeMs);
const optimized = median(afterMs);
console.log(
  JSON.stringify(
    {
      node: process.version,
      operation: 'flatIrradianceColor',
      iterations,
      beforeMs: original,
      afterMs: optimized,
      speedup: original / optimized,
      colorAllocationsBefore: iterations,
      colorAllocationsAfter: 0,
      checksum,
    },
    null,
    2,
  ),
);
