// Capture fixed sandbox presets for review. Usage: node scripts/shots.mjs <outDir> [baseUrl]
// Needs the sandbox dev server running (pnpm --filter hd-renderer sandbox).
import { chromium } from '@playwright/test';
import { mkdir } from 'node:fs/promises';

const outDir = process.argv[2] ?? 'shots';
const base = process.argv[3] ?? 'http://localhost:15180/';
const presets = [
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
