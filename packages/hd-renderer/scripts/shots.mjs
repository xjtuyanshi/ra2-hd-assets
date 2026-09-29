// Capture fixed sandbox presets for review. Usage: node scripts/shots.mjs <outDir> [baseUrl]
// Needs the sandbox dev server running (pnpm --filter hd-renderer sandbox).
import { chromium } from '@playwright/test';
import { mkdir } from 'node:fs/promises';

const outDir = process.argv[2] ?? 'shots';
const base = process.argv[3] ?? 'http://localhost:15180/';
const sets = {
  sandbox: null,
  city: [
    { name: 'c1', query: 'map=XMP29U2&cx=60&cy=62&zoom=1.6&time=13', wait: 14000 },
    { name: 'c2', query: 'map=XMP29U2&cx=48&cy=52&zoom=1.1&time=13', wait: 14000 },
  ],
  sprites: [
    { name: 's1-ore-old', query: 'map=RiverRam&cx=70&cy=40&zoom=2&time=11&hdsprites=0', wait: 12000 },
    { name: 's1-ore-hd', query: 'map=RiverRam&cx=70&cy=40&zoom=2&time=11', wait: 12000 },
    { name: 's2-city-old', query: 'map=XMP29U2&cx=60&cy=62&zoom=1.6&time=13&hdsprites=0', wait: 14000 },
    { name: 's2-city-hd', query: 'map=XMP29U2&cx=60&cy=62&zoom=1.6&time=13', wait: 14000 },
  ],
  remat: [
    { name: 'm1-close', query: 'map=RiverRam&cx=52&cy=58&zoom=1.35&time=11', wait: 14000 },
    { name: 'm2-cliff', query: 'map=RiverRam&cx=70&cy=40&zoom=2&time=11', wait: 14000 },
    { name: 'm3-units', query: 'map=RiverRam&units=1&zoom=1.6&time=13', wait: 14000 },
  ],
  shore: [{ name: 'shore-zoom', query: 'map=RiverRam&cx=60&cy=66&zoom=3.2&time=11', wait: 12000 }],
  water: [
    { name: 'w1-close', query: 'map=RiverRam&cx=52&cy=58&zoom=1.35&time=11', wait: 12000 },
    { name: 'w2-wide', query: 'map=RiverRam&cx=56&cy=60&zoom=0.62&time=11', wait: 12000 },
    { name: 'w3-rain', query: 'map=RiverRam&cx=52&cy=58&zoom=1.35&time=15&weather=rain&rain=0.85', wait: 15000 },
  ],
  upscale: [
    { name: 'u1-atlas', query: 'map=RiverRam&cx=70&cy=40&zoom=1.6&time=12&tmap=0', wait: 9000 },
    { name: 'u2-ai2x', query: 'map=RiverRam&cx=70&cy=40&zoom=1.6&time=12', wait: 12000 },
    { name: 'u3-atlas-wide', query: 'map=RiverRam&cx=56&cy=60&zoom=0.62&time=12&tmap=0', wait: 9000 },
    { name: 'u4-ai2x-wide', query: 'map=RiverRam&cx=56&cy=60&zoom=0.62&time=12', wait: 12000 },
  ],
  riverram: [
    { name: 'r1-day', query: 'map=RiverRam&cx=56&cy=60&zoom=0.62&time=12', wait: 9000 },
    { name: 'r2-rain', query: 'map=RiverRam&cx=56&cy=60&zoom=0.62&time=15&weather=rain&rain=0.85', wait: 14000 },
    { name: 'r3-dusk-battle', query: 'map=RiverRam&cx=56&cy=60&zoom=0.62&time=18.4&boom=1', wait: 10000 },
    { name: 'r4-night-battle', query: 'map=RiverRam&cx=56&cy=60&zoom=0.62&time=21.5&boom=1', wait: 10000 },
    { name: 'r5-vehicles', query: 'map=RiverRam&units=1&zoom=1.25&time=15', wait: 10000 },
  ],
};
const presetSet = process.argv[4] ?? 'sandbox';
const presets = sets[presetSet] ?? [
  { name: '1-day-overview', query: 'cx=30&cy=31&zoom=0.62&time=14.5', wait: 7000 },
  { name: '2-coast-morning', query: 'cx=13&cy=41&zoom=0.95&time=9.5&battle=0', wait: 4000 },
  { name: '3-rain', query: 'cx=20&cy=35&zoom=0.8&time=15&weather=rain&rain=0.9', wait: 9000 },
  { name: '4-dusk-battle', query: 'cx=34&cy=28&zoom=0.95&time=18.4', wait: 7000 },
  { name: '5-night-battle', query: 'cx=34&cy=28&zoom=0.95&time=21.5', wait: 7000 },
];

await mkdir(outDir, { recursive: true });
// SHOTS_CHROME may point at any installed Chrome/Chromium; full Chrome in new-headless mode keeps GPU access.
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.SHOTS_CHROME || undefined,
  args: ['--enable-unsafe-webgpu', '--enable-gpu', '--use-angle=metal', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1.5 });
for (const preset of presets) {
  await page.goto(`${base}?nogui&nohud&${preset.query}`);
  await page.waitForTimeout(preset.wait);
  const path = `${outDir}/${preset.name}.png`;
  await page.screenshot({ path });
  console.log(path);
}
console.log('backend:', await page.evaluate(() => document.querySelector('#hud')?.textContent));
await browser.close();
