// Capture fixed sandbox presets for review. Usage: node scripts/shots.mjs <outDir> [baseUrl] [presetSet]
// Needs the sandbox dev server running (pnpm --filter hd-renderer sandbox). Presets with `json: true` also write
// <name>.json with the renderer's window.__hd.stats() (exposure, night level, light counts, GPU time), when present.
import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';

const outDir = process.argv[2] ?? 'shots';
const base = process.argv[3] ?? 'http://localhost:15180/';

// Atmosphere review (night, rain, map light sources): XMP29U2 a01..a10, RiverRam b01..b08, in this order.
const ATMO = [
  ['a01', 'map=XMP29U2&cx=60&cy=62&zoom=1.1&time=12'],
  ['a02', 'map=XMP29U2&cx=60&cy=62&zoom=1.6&time=13'],
  ['a03', 'map=XMP29U2&cx=60&cy=62&zoom=1.1'],
  ['a04', 'map=XMP29U2&cx=60&cy=62&zoom=1.1&time=18.4'],
  ['a05', 'map=XMP29U2&cx=60&cy=62&zoom=1.1&time=22'],
  ['a06', 'map=XMP29U2&cx=60&cy=62&zoom=1.1&time=22&weather=rain&rain=0.8&wet=1'],
  ['a07', 'map=XMP29U2&cx=50&cy=50&zoom=1.6&time=22&weather=rain&rain=0.8&wet=1'],
  ['a08', 'map=XMP29U2&cx=60&cy=62&zoom=1.1&time=22&weather=rain&rain=0.8&wet=1&fires=4&boom=1'],
  ['a09', 'map=XMP29U2&cx=60&cy=62&zoom=1.1&time=15&weather=rain&rain=0.8&wet=1'],
  ['a10', 'map=XMP29U2&cx=60&cy=62&zoom=1.1&time=22&weather=rain&rain=0.8&wet=1&lamps=off&windows=0'],
  ['b01', 'map=RiverRam&cx=52&cy=58&zoom=1.35&time=11'],
  ['b02', 'map=RiverRam&cx=52&cy=58&zoom=1.35&time=12'],
  ['b03', 'map=RiverRam&cx=52&cy=58&zoom=1.35'],
  ['b04', 'map=RiverRam&cx=56&cy=60&zoom=0.62&time=18.4'],
  ['b05', 'map=RiverRam&cx=56&cy=60&zoom=0.62&time=22&boom=1'],
  ['b06', 'map=RiverRam&cx=52&cy=58&zoom=1.35&time=22&weather=rain&rain=0.85&wet=1'],
  ['b07', 'map=RiverRam&cx=52&cy=58&zoom=1.35&time=15&weather=rain&rain=0.85&wet=1'],
  ['b08', 'map=RiverRam&cx=56&cy=60&zoom=0.62&time=22&weather=rain&rain=0.85&wet=1&fires=3&boom=1'],
].map(([name, query]) => ({ name, query, wait: name.startsWith('a') ? 16000 : 14000, json: true }));
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
  atmo: ATMO,
  // The same framings without parameters older renderers ignore (wet, fires, lamps, windows): a before/after baseline.
  atmobase: ATMO.filter((p) => !/fires=|lamps=/.test(p.query)).map((p) => ({
    ...p,
    query: p.query.replace('&wet=1', ''),
  })),
  // Day regression subset: noon/early-afternoon and map-driven default framings.
  atmoday: ATMO.filter((p) => ['a01', 'a02', 'a03', 'b01', 'b02', 'b03'].includes(p.name)),
  // GPU frame time at 2400x1500 (1600x1000 at DPR 1.5): night rain with fires and explosions, and clear noon.
  atmoperf: [
    {
      name: 'perf-night',
      query: 'map=XMP29U2&cx=60&cy=62&zoom=1.1&time=22&weather=rain&rain=0.8&wet=1&fires=4&boom=1&perf=1',
      wait: 20000,
      json: true,
    },
    { name: 'perf-day', query: 'map=XMP29U2&cx=60&cy=62&zoom=1.1&time=12&perf=1', wait: 20000, json: true },
  ],
  // Materials and grounding review: voxel close-ups, city sprites, cliff shadows, water regressions and palette cards.
  materials: [
    {
      name: 'v1-xmp-z2.5',
      query: 'map=XMP29U2&ugrid=1&utypes=MTNK,HTNK,AMCV&ux=52&uy=95&cx=55.5&cy=94.5&zoom=2.5&time=12',
      wait: 12000,
    },
    {
      name: 'v2-xmp-z5',
      query: 'map=XMP29U2&ugrid=1&utypes=MTNK,HTNK,AMCV&ux=52&uy=95&cx=53.9&cy=93.6&zoom=5&time=12',
      wait: 12000,
    },
    {
      name: 'v3-rr-z2.5',
      query: 'map=RiverRam&ugrid=1&utypes=MTNK,HTNK,AMCV,HARV,CMIN&ux=56&uy=88&cx=60&cy=88&zoom=2.5&time=12',
      wait: 12000,
    },
    { name: 'c1', query: 'map=XMP29U2&cx=60&cy=62&zoom=1.6&time=13', wait: 14000 },
    { name: 'c2', query: 'map=XMP29U2&cx=48&cy=52&zoom=1.1&time=13', wait: 14000 },
    { name: 'e1-edges-z2.5', query: 'map=XMP29U2&cx=48&cy=52&zoom=2.5&time=12', wait: 14000 },
    { name: 'cliff', query: 'map=RiverRam&cx=70&cy=40&zoom=2&time=11', wait: 14000 },
    { name: 'w1-close', query: 'map=RiverRam&cx=52&cy=58&zoom=1.35&time=11', wait: 12000 },
    { name: 'w2-wide', query: 'map=RiverRam&cx=56&cy=60&zoom=0.62&time=11', wait: 12000 },
    { name: 'pal-unit-rr', query: 'map=RiverRam&palcard=unit&cx=62&cy=84&zoom=4&time=12', wait: 10000 },
    { name: 'pal-iso-rr', query: 'map=RiverRam&palcard=iso&cx=62&cy=84&zoom=4&time=12', wait: 10000 },
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
// Performance sets run with vsync and the frame-rate limit off, so frame intervals measure the frame cost.
const uncapped = presetSet === 'atmoperf' ? ['--disable-gpu-vsync', '--disable-frame-rate-limit'] : [];
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.SHOTS_CHROME || undefined,
  args: ['--enable-unsafe-webgpu', '--enable-gpu', '--use-angle=metal', '--ignore-gpu-blocklist', ...uncapped],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1.5 });
for (const preset of presets) {
  await page.goto(`${base}?nogui&nohud&${preset.query}`);
  await page.waitForTimeout(preset.wait);
  const path = `${outDir}/${preset.name}.png`;
  await page.screenshot({ path });
  console.log(path);
  if (preset.json) {
    const stats = await page.evaluate(() => window.__hd?.stats?.() ?? null);
    if (stats) await writeFile(`${outDir}/${preset.name}.json`, JSON.stringify(stats, null, 1));
  }
}
console.log('backend:', await page.evaluate(() => document.querySelector('#hud')?.textContent));
await browser.close();
