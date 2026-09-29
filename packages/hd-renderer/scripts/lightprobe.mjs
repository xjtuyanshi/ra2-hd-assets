// Light-field placement check: a local light must land where it stands. Usage:
//   node scripts/lightprobe.mjs [baseUrl] [map]
// Needs the sandbox dev server and a local HD cache of the map (default XMP29U2). For each backend (WebGPU, WebGL2)
// and several points spread over the map (both halves in z and x, so a mirrored field cannot pass by symmetry), it
// adds one kept light straight into the light field (no flame art), diffs the frame against the unlit one, and
// compares the centroid of the brightening with the projected light position. Fails (exit 1) when any centroid is
// more than 0.5 cell away. Night, no map lights, lamps or windows, no mist: only the probe light changes the frame.
// Points sit on open ground: a light at a building's foot also lights the building's upright art, which moves the
// centroid up the facade. Environment: SHOTS_CHROME (browser), LIGHTPROBE_BACKENDS=webgpu,webgl, LIGHTPROBE_OUT=<dir>.
import { chromium } from '@playwright/test';
import { writeFile } from 'node:fs/promises';

const base = process.argv[2] ?? 'http://localhost:15180/';
const map = process.argv[3] ?? 'XMP29U2';
const TOLERANCE_CELLS = 0.5;
/** Keeps each probe's before/after screenshots for review. */
const keep = process.env.LIGHTPROBE_OUT;

const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.SHOTS_CHROME || undefined,
  args: ['--enable-unsafe-webgpu', '--enable-gpu', '--use-angle=metal', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1200, height: 800 }, deviceScaleFactor: 1 });

/** Luminance of every pixel of a PNG screenshot, decoded in the page. */
async function lumaOf(png) {
  return page.evaluate(async (b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, 0, 0);
    const { data } = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
    const out = new Array(bitmap.width * bitmap.height);
    for (let i = 0; i < out.length; i++)
      out[i] = 0.2126 * data[i * 4] + 0.7152 * data[i * 4 + 1] + 0.0722 * data[i * 4 + 2];
    return { width: bitmap.width, height: bitmap.height, luma: out };
  }, png.toString('base64'));
}

let failures = 0;
for (const backend of (process.env.LIGHTPROBE_BACKENDS ?? 'webgpu,webgl').split(',')) {
  for (const [x, z] of [
    [60, 30],
    [60, 90],
    [35, 60],
    [88, 70],
  ]) {
    const query = `nogui&nohud&map=${map}&time=22&lamps=off&lights=0&windows=0&mist=0&cx=${x}&cy=${z}&zoom=1.6${
      backend === 'webgl' ? '&webgl=1' : ''
    }`;
    await page.goto(`${base}?${query}`);
    await page.waitForFunction(() => window.__hd?.hd?.lightField, null, { timeout: 60000 });
    await page.waitForTimeout(4000);
    const beforePng = await page.screenshot();
    const before = await lumaOf(beforePng);
    const expected = await page.evaluate(
      ([px, pz]) => {
        const { hd, world } = window.__hd;
        const V = hd.view.camera.position.constructor;
        const y = world.terrain.heightAt(px, pz);
        const at = new V(px, y, pz);
        hd.lightField.keep('lightprobe', hd.seconds(), at, [1, 1, 1], 1.5, 18, 0, 1e6);
        const rect = hd.canvas.getBoundingClientRect();
        const project = (v) => {
          const p = v.clone().project(hd.view.camera);
          return [((p.x + 1) / 2) * rect.width, ((1 - p.y) / 2) * rect.height];
        };
        const centre = project(at);
        const east = project(new V(px + 1, y, pz));
        return { centre, cellPixels: Math.hypot(east[0] - centre[0], east[1] - centre[1]), backend: hd.backend };
      },
      [x, z],
    );
    await page.waitForTimeout(1200);
    const afterPng = await page.screenshot();
    const after = await lumaOf(afterPng);
    if (keep) {
      await writeFile(`${keep}/${backend}-${x}-${z}-before.png`, beforePng);
      await writeFile(`${keep}/${backend}-${x}-${z}-after.png`, afterPng);
    }
    let sum = 0;
    let sx = 0;
    let sy = 0;
    for (let i = 0; i < after.luma.length; i++) {
      const d = after.luma[i] - before.luma[i];
      if (d < 6) continue;
      sum += d;
      sx += (i % after.width) * d;
      sy += Math.floor(i / after.width) * d;
    }
    const got = sum > 0 ? [sx / sum, sy / sum] : [NaN, NaN];
    const error = Math.hypot(got[0] - expected.centre[0], got[1] - expected.centre[1]) / expected.cellPixels;
    const ok = sum > 0 && error <= TOLERANCE_CELLS;
    if (!ok) failures++;
    console.log(
      `${ok ? 'ok  ' : 'FAIL'} ${expected.backend} light (${x}, ${z}): expected px (${expected.centre
        .map((v) => v.toFixed(0))
        .join(', ')}), centroid (${got.map((v) => v.toFixed(0)).join(', ')}), error ${error.toFixed(2)} cells`,
    );
  }
}
await browser.close();
if (failures) {
  console.error(`${failures} light(s) misplaced`);
  process.exitCode = 1;
}
