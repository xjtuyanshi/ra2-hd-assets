/** Operator-assisted capture. Attaches to ONE existing CDP tab; never starts a VM or changes guest memory. */
import { chromium } from '@playwright/test';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline/promises';

export const scenes = ['g2', 'alca', 'isle', 'beach', 'bay', 'gold', 'pac2', 'fleet', 'night'];
export const looks = ['original', 'enhanced', 'clear', 'muted'];
export function validateManifest(m) {
  if (!m.cdp || !m.pageUrl || !m.out || !Array.isArray(m.videoInput))
    throw Error('cdp, pageUrl, out, videoInput required');
  for (const [name, s] of Object.entries(m.scenes ?? {})) {
    if (!scenes.includes(name)) throw Error(`Unknown scene ${name}`);
    if (s.missing) continue;
    if (!s.state || s.zoom !== 2.5 || !s.crop || !s.screenCrop || !s.shoreCrop)
      throw Error(`${name}: state, zoom=2.5, crop, screenCrop, shoreCrop required`);
    for (const r of [s.crop, s.screenCrop, s.shoreCrop]) {
      if (![r.x, r.y, r.width, r.height].every(Number.isFinite) || r.width <= 0 || r.height <= 0)
        throw Error(`${name}: invalid crop`);
    }
    if (s.crop.width !== s.screenCrop.width || s.crop.height !== s.screenCrop.height)
      throw Error(`${name}: screen and browser crops must match 1:1 (DPR=1)`);
  }
  return m;
}
const run = (command, args) =>
  new Promise((ok, fail) => {
    const child = spawn(command, args, { stdio: 'inherit' });
    child.on('error', fail);
    child.on('exit', (code) => (code === 0 ? ok() : fail(Error(`${command} exited ${code}`))));
  });
async function main() {
  const path = process.argv[2];
  if (!path || path === '--help') {
    console.log(
      'pnpm exec node scripts/remaster/qa/water_boards.mjs MANIFEST.json [--validate]\nSee scripts/remaster/qa/WATER.md. No browser/VM is launched.',
    );
    return;
  }
  const m = validateManifest(JSON.parse(await readFile(path, 'utf8')));
  if (process.argv.includes('--validate')) {
    console.log('Manifest valid');
    return;
  }
  const browser = await chromium.connectOverCDP(m.cdp);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const receipt = { manifest: resolve(path), scenes: {}, failures: [] };
  await mkdir(m.out, { recursive: true });
  const save = () => writeFile(join(m.out, 'capture.json'), JSON.stringify(receipt, null, 2));
  try {
    const pages = browser
      .contexts()
      .flatMap((c) => c.pages())
      .filter((p) => p.url() === m.pageUrl);
    if (pages.length !== 1) throw Error(`Expected one exact pageUrl match, got ${pages.length}`);
    const page = pages[0];
    if ((await page.evaluate(() => devicePixelRatio)) !== 1)
      throw Error('Capture requires devicePixelRatio=1; do not resize images');
    for (const name of scenes) {
      const scene = m.scenes?.[name];
      if (!scene || scene.missing) {
        receipt.scenes[name] = { missing: scene?.missing ?? 'Not configured' };
        await save();
        continue;
      }
      const dir = join(m.out, name);
      await mkdir(dir, { recursive: true });
      receipt.scenes[name] = { state: scene.state, zoom: scene.zoom, looks: {} };
      for (const look of looks) {
        try {
          const answer = await rl.question(
            `${name}/${look}: restore SAME native save/replay ${scene.state}, freeze SAME camera at zoom 2.5, pause via native UI. Type READY (or MISSING): `,
          );
          if (answer !== 'READY') throw Error('Operator did not confirm restored paused scene');
          await page.evaluate((look) => {
            const b = window.__hdBridge;
            if (!b?.live || !b.water) throw Error('Development HD bridge not ready');
            if (look !== 'original') b.water.set(look);
            const isOriginal = b.presentation.mode === 'original';
            if ((look === 'original') !== isOriginal) b.toggle();
          }, look);
          // Allow presentation handoff and shader warm-up before capture, without changing the camera.
          await page.waitForFunction(
            (look) => window.__hdBridge?.presentation.mode === (look === 'original' ? 'original' : 'hd'),
            look,
            { timeout: 30000 },
          );
          await page.waitForTimeout(2000);
          await page.screenshot({ path: join(dir, `${look}.png`), clip: scene.crop, animations: 'allow' });
          const record = await rl.question(
            'Resume at NORMAL speed using native UI; keep camera fixed and cursor outside captured area. Type RECORD when ready: ',
          );
          if (record !== 'RECORD') throw Error('Operator did not confirm normal-speed recording');
          const r = scene.screenCrop;
          await run('ffmpeg', [
            '-nostdin',
            '-y',
            ...m.videoInput,
            '-t',
            '4',
            '-vf',
            `crop=${r.width}:${r.height}:${r.x}:${r.y}`,
            '-an',
            '-c:v',
            'ffv1',
            join(dir, `${look}.mkv`),
          ]);
          receipt.scenes[name].looks[look] = { captured: true, restoredByOperator: true, normalSpeedByOperator: true };
        } catch (e) {
          receipt.failures.push(`${name}/${look}: ${e.message}`);
          receipt.scenes[name].looks[look] = { error: e.message };
        }
        await save();
      }
      if (name === 'fleet') {
        for (const look of ['enhanced', 'clear', 'muted']) {
          await rl.question(
            `Fleet FPS ${look}: restore SAME save, select native slider 5, set __hdBridge.water.set('${look}'), resume, record 60 seconds in existing RA2_PERF_LOG. Press Enter after saving ${dir}/${look}-fps.json (see WATER.md): `,
          );
        }
      }
    }
  } finally {
    await save();
    rl.close();
    await browser.close();
  }
  if (receipt.failures.length) process.exitCode = 1;
}
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) await main();
