// Capture native effect art with its HD garnish on the live-view bench (sandbox ?fx=, see sandbox/fx.ts), frozen at a
// few ages, for colour and size review against the original frames.
// Usage: node scripts/fxShots.mjs <outDir> [baseUrl] [ids] [ages in logic frames]
// Needs the sandbox dev server (pnpm --filter hd-renderer sandbox) and the effect sidecar (pnpm hd:effects).
import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';

const outDir = process.argv[2] ?? 'fx-shots';
const base = process.argv[3] ?? 'http://localhost:15180/';
const ids = (process.argv[4] ?? 'TWLT070,S_CLSN22,S_BANG48,PIFFPIFF,GUNFIRE,FIRE02,SMOKEY2,HTRKPUFF,TSTIMPCT').split(
  ',',
);
const ages = (process.argv[5] ?? '2,6,12,20,32').split(',').map(Number);
const map = process.env.FX_MAP ?? 'XMP29U2';
const cell = process.env.FX_CELL ?? 'cx=48&cy=52';
const zoom = Number(process.env.FX_ZOOM ?? 3);
const fps = 15;

await mkdir(outDir, { recursive: true });
// SHOTS_CHROME may point at any installed Chrome/Chromium; full Chrome in new-headless mode keeps GPU access.
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.SHOTS_CHROME || undefined,
  args: ['--enable-unsafe-webgpu', '--enable-gpu', '--use-angle=metal', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 600, height: 600 }, deviceScaleFactor: 1 });
page.on('pageerror', (e) => console.log('[pageerror]', e.message.slice(0, 300)));
const meta = { map, cell, zoom, fps, shots: [] };
const shoot = async (query, path) => {
  await page.goto(`${base}?nogui&nohud&map=${map}&${cell}&zoom=${zoom}&fps=${fps}&${query}`);
  await page.waitForFunction(() => window.__fx?.ready === true, null, { timeout: 120000 });
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  await page.screenshot({ path });
  console.log(path);
};
// The same view without any effect (an id with no art), to difference the effect out of the terrain.
await shoot('fx=NONE&time=0', `${outDir}/background.png`);
for (const id of ids) {
  for (const age of ages) {
    const stem = `${outDir}/${id}-f${String(age).padStart(2, '0')}`;
    await shoot(`fx=${id}&time=${age / fps}`, `${stem}.png`);
    // The native art alone (no HD garnish).
    await shoot(`fx=${id}&time=${age / fps}&garnish=0`, `${stem}-native.png`);
    meta.shots.push({ id, age, path: `${stem}.png`, native: `${stem}-native.png` });
  }
}
meta.background = `${outDir}/background.png`;
await writeFile(`${outDir}/meta.json`, JSON.stringify(meta, null, 1));
await browser.close();
