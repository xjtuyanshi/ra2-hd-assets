// GPU-bound frame cost of the atmosphere scenes: node scripts/gpubench.mjs [baseUrl] [outFile]
// Needs the sandbox dev server (pnpm --filter hd-renderer sandbox) and WebGPU. One page loads the night framing
// (XMP29U2, night rain 0.8, wet, four fires, periodic explosions), waits WARM seconds (default 20, the atmoperf wait;
// set 90 for steady state), then alternates in-page between configurations and measures each with
// HdRenderer.benchmark(N): N renders back to back with the node frame advanced, divided by the time until the GPU
// queue drains. Reports min and median per configuration over REPS rounds. Configurations: night (as loaded) and day
// (the same framing at clear noon), so their difference is a same-scene comparison.
import { chromium } from '@playwright/test';
import { writeFile } from 'node:fs/promises';

const base = process.argv[2] ?? 'http://localhost:15180/';
const out = process.argv[3];
const query = process.env.Q ?? 'map=XMP29U2&cx=60&cy=62&zoom=1.1&time=22&weather=rain&rain=0.8&wet=1&fires=4&boom=1';
const WARM = Number(process.env.WARM ?? 20);
const REPS = Number(process.env.REPS ?? 8);
const N = Number(process.env.N ?? 10);
const configs = ['night', 'day'];

const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.SHOTS_CHROME || undefined,
  args: ['--enable-unsafe-webgpu', '--enable-gpu', '--use-angle=metal', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1.5 });
await page.goto(`${base}?nogui&nohud&${query}`);
await page.waitForFunction(() => window.__hd?.hd, null, { timeout: 60000 });
await page.waitForTimeout(WARM * 1000);
const samples = Object.fromEntries(configs.map((c) => [c, []]));
for (let r = 0; r < REPS; r++) {
  for (const config of configs) {
    const ms = await page.evaluate(
      async ({ config, N }) => {
        const { hd, state } = window.__hd;
        const env = state.environment;
        window.__benchNight ??= { time: env.timeOfDay, weather: env.weather, intensity: env.weatherIntensity };
        const night = window.__benchNight;
        const day = config === 'day';
        env.timeOfDay = day ? 12 : night.time;
        env.weather = day ? 'clear' : night.weather;
        env.weatherIntensity = day ? 0 : night.intensity;
        // A few frames so time and weather settle (wetness, mist, pipeline rebuilds), then measure.
        for (let i = 0; i < 3; i++) await hd.benchmark(1);
        return hd.benchmark(N);
      },
      { config, N },
    );
    if (ms === null) throw new Error('benchmark needs WebGPU');
    samples[config].push(+ms.toFixed(2));
  }
  console.log(r, JSON.stringify(Object.fromEntries(configs.map((c) => [c, samples[c][r]]))));
}
const stat = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return { min: sorted[0], median: sorted[Math.floor(sorted.length / 2)] };
};
const summary = Object.fromEntries(configs.map((c) => [c, stat(samples[c])]));
summary.nightMinusDay = +(summary.night.median - summary.day.median).toFixed(2);
console.log(JSON.stringify(summary));
if (out) await writeFile(out, JSON.stringify({ base, query, warm: WARM, reps: REPS, n: N, samples, summary }, null, 1));
await browser.close();
