#!/usr/bin/env node
// Bounded real-browser inspection. Commands are private review artifacts, never guest-state writes.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile, appendFile, readdir, lstat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { createConnection } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from '@playwright/test';
import { writePng, outputDirectory } from './artifacts.mjs';
const wt = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const base = outputDirectory();
const tag = process.argv[2] || 'hidden';
assert(/^[a-zA-Z0-9_-]+$/.test(tag));
const out = join(base, 'phase7', tag);
await mkdir(out, { recursive: true });
await writeFile(join(out, 'harness-pid'), String(process.pid) + '\n');
const config = JSON.parse(await readFile(join(base, 'run/owner-launch-smoke.json'), 'utf8'));
const pause = resolve(base, '../play/_slots/PAUSE');
const exists = async (p) => !!(await lstat(p).catch(() => null));
const scopeDeadline = await readFile(join(base, 'phase7/deadline.json'), 'utf8')
  .then((t) => Date.parse(JSON.parse(t).deadlineAt))
  .catch(() => Infinity);
async function ownerIdle() {
  if (await exists(join(out, 'cancel'))) throw new Error('Owned acceptance cancelled');
  if (Date.now() > scopeDeadline) throw new Error('Bounded task deadline reached');
  while (await exists(pause)) {
    if (Date.now() > scopeDeadline) throw new Error('Bounded task deadline reached');
    await writeFile(join(out, 'held'), 'Owner playing; waiting\n');
    await delay(1000);
  }
}
const record = async (name, proof) => {
  await appendFile(
    join(out, 'observations.jsonl'),
    JSON.stringify({ name, at: new Date().toISOString(), proof }) + '\n',
  );
  console.log(name, JSON.stringify(proof).slice(0, 1800));
};
const redact = (s) => String(s).replace(/agent-token=[a-f0-9]+/gi, 'agent-token=[redacted]');
let launch,
  launchExit,
  privateDir,
  server,
  browser,
  page,
  cdp,
  logTail = '',
  url,
  cleanupPromise;
let peakRss = 0;
async function dllIdentity() {
  const path = join(config.RA2_NATIVE_GAME_DIR || process.env.RA2_NATIVE_GAME_DIR, 'ddraw.dll');
  const info = await lstat(path).catch((e) => {
    if (e.code === 'ENOENT') return null;
    throw e;
  });
  if (!info) return null;
  assert(info.isFile());
  return {
    sha256: createHash('sha256')
      .update(await readFile(path))
      .digest('hex'),
    mode: info.mode & 0o777,
  };
}
let dllBefore;
const portReleased = (port) =>
  new Promise((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port: Number(port) });
    const finish = (value) => {
      socket.destroy();
      resolve(value);
    };
    socket.once('connect', () => finish(false));
    socket.once('error', (e) => finish(e.code === 'ECONNREFUSED'));
    socket.setTimeout(1500, () => finish(false));
  });
const rssTimer = setInterval(() => {
  peakRss = Math.max(peakRss, process.memoryUsage().rss);
}, 1000);
async function wait(label, fn, ms = 60000) {
  const deadline = Date.now() + ms;
  do {
    const v = await fn();
    if (v) return v;
    await delay(100);
  } while (Date.now() < deadline);
  throw new Error('Timeout ' + label);
}
const worker = () => page.workers().find((w) => /vmWorker/.test(w.url()));
const state = () =>
  worker().evaluate(async () =>
    JSON.parse(new TextDecoder().decode(await globalThis.__auditCore.connection.request(14))),
  );
async function shot(label) {
  assert(/^[a-zA-Z0-9_-]+$/.test(label));
  const path = join(out, label + '.png');
  await page.screenshot({ path, scale: 'css' });
  const native = await worker().evaluate(() => {
    const p = globalThis.__auditCore.connection.pictureDecoder.previous;
    if (!p) return null;
    const bytes = new Uint8Array(p.pixels.buffer, p.pixels.byteOffset, p.pixels.byteLength);
    let s = '';
    for (let i = 0; i < bytes.length; i += 32768) s += String.fromCharCode(...bytes.subarray(i, i + 32768));
    return { width: p.width, height: p.height, frame: p.frame, pixels: btoa(s) };
  });
  if (native) writePng(join(out, label + '-native.png'), { ...native, pixels: Buffer.from(native.pixels, 'base64') });
  const s = await state();
  await writeFile(join(out, label + '-controls.json'), JSON.stringify(s, null, 2));
  const diagnostics = await worker().evaluate(async () =>
    JSON.parse(new TextDecoder().decode(await globalThis.__auditCore.connection.request(11))),
  );
  await writeFile(join(out, label + '-diagnostics.json'), JSON.stringify(diagnostics, null, 2));
  if (tag.startsWith('visible')) {
    try {
      const { captureVisibleNativeWindow } = await import('./native-visible-shot.mjs');
      await record('visible-window', await captureVisibleNativeWindow({ out, label }));
    } catch (e) {
      await record('visible-window-unverified', { label, error: String(e) });
    }
  }
  await record('screenshot', {
    label,
    path,
    native: !!native,
    frame: native?.frame,
    browserWindow: await cdp.send('Browser.getWindowForTarget'),
    viewport: await page.evaluate(() => ({
      width: innerWidth,
      height: innerHeight,
      outerWidth,
      outerHeight,
      dpr: devicePixelRatio,
    })),
  });
  return path;
}
async function point(x, y) {
  const b = await page.locator('#screen').boundingBox();
  const s = await worker().evaluate(() => globalThis.__auditCore.hello.surface);
  return [b.x + (x * b.width) / s.width, b.y + (y * b.height) / s.height];
}
async function click(x, y, button = 'left') {
  const [px, py] = await point(x, y);
  await page.mouse.move(px, py);
  await page.mouse.down({ button });
  await delay(40);
  await page.mouse.up({ button });
}
const usable = (c) => c.visible && c.enabled && c.rect?.[2] > c.rect?.[0];
async function execute(c) {
  if (c.action === 'close') return { closing: true };
  await ownerIdle();
  if (c.action === 'batch') {
    const results = [];
    for (const step of c.steps) {
      results.push(await execute(step));
    }
    return results;
  }
  if (c.action === 'latency') {
    const s = await state();
    const control = s.controls.find((v) => usable(v) && v.id === c.id);
    assert(control, 'No click control ' + c.id);
    const x = (control.rect[0] + control.rect[2]) / 2,
      y = (control.rect[1] + control.rect[3]) / 2;
    const templates = await readFile(join(base, 'phase7/menu-raster-templates.json'), 'utf8')
      .then(JSON.parse)
      .catch(() => null);
    const expectedRasterTemplate = templates?.templates?.[String(c.expected)];
    const { measurePhase7MenuClick } = await import('./phase7-input-stream.mjs');
    const result = await measurePhase7MenuClick({
      page,
      cdp,
      worker: worker(),
      click: () => click(x, y),
      targetNativePoint: { x, y },
      label: c.label,
      expectedControlId: c.expected,
      expectedRasterTemplate,
      record,
      out,
    });
    await delay(c.wait ?? 1500);
    if (c.label) await shot(c.label);
    return result;
  }
  if (c.action === 'shot') return shot(c.label);
  if (c.action === 'state') return state();
  if (c.action === 'click') {
    let x = c.x,
      y = c.y;
    if (c.id !== undefined || c.text) {
      const s = await state();
      const control = s.controls.find(
        (v) => usable(v) && (c.id !== undefined ? v.id === c.id : new RegExp(c.text, 'i').test(v.text)),
      );
      assert(control, 'Missing control ' + JSON.stringify(c));
      [x, y] = [(control.rect[0] + control.rect[2]) / 2, (control.rect[1] + control.rect[3]) / 2];
      if (control.class === 'ComboBox') x = control.rect[2] - 8;
    }
    await click(x, y, c.button);
    await delay(c.wait ?? 700);
    return c.label ? shot(c.label) : state();
  }
  if (c.action === 'key') {
    await page.keyboard.press(c.key);
    await delay(c.wait ?? 700);
    return c.label ? shot(c.label) : state();
  }
  if (c.action === 'wheel') {
    const [x, y] = await point(c.x, c.y);
    await page.mouse.move(x, y);
    await page.mouse.wheel(0, c.delta ?? 400);
    await delay(500);
    return c.label ? shot(c.label) : state();
  }
  if (c.action === 'calibrate') {
    const { calibratePhase7Cursor } = await import('./phase7-input-stream.mjs');
    return calibratePhase7Cursor({ page, out, label: c.label, area: c.area, shot });
  }
  if (c.action === 'stream') {
    const { runPhase7InputStream } = await import('./phase7-input-stream.mjs');
    return runPhase7InputStream({
      page,
      cdp,
      worker: worker(),
      out,
      record,
      shot,
      waitOwnerIdle: ownerIdle,
      observeState: () =>
        worker().evaluate(async () => {
          const core = globalThis.__auditCore;
          const nativeState = JSON.parse(
            new TextDecoder().decode(await core.connection.request(14, new Uint8Array([1, 0, 0, 0]))),
          );
          const state = core.render?.previous;
          return {
            source: 'NativeCore completed render cache plus genuine minimal modal state',
            nativeModal: nativeState.modal,
            nativePictureFrame: core.connection.pictureDecoder.previous?.frame ?? null,
            logicFrame: state?.frame ?? null,
            localHouse: state?.localHouse ?? null,
            ownAliveAssets:
              state?.localHouse >= 0
                ? (state.objects?.filter((object) => object.owner === state.localHouse && object.health > 0).length ??
                  null)
                : null,
            pictureSize: [core.hello.surface.width, core.hello.surface.height],
          };
        }),
      rate: c.rate,
      seconds: c.seconds ?? 30,
      label: c.label ?? 'stream',
      ...c,
    });
  }
  if (c.action === 'sleep') {
    await delay(Math.min(c.ms, 60000));
    return { slept: c.ms };
  }
  if (c.action === 'play-input' || c.action === 'end') {
    const { runBrowserBattleInput, runBrowserEnd } = await import('./browser-battle-input.mjs');
    const api = {
      page,
      click: (x, y, mode, button) => click(x, y, button ?? 'left'),
      point,
      commandState: () => worker().evaluate(() => globalThis.__auditCore.getCommandState()),
      readBytes: (a, n) =>
        worker().evaluate(
          async ([a, n]) => Array.from((await globalThis.__auditCore.connection.read(a, n)).bytes),
          [a, n],
        ),
      inputState: state,
      shot,
      record,
      wait,
      selectionComparison: false,
      eliminateHuman: c.eliminateHuman ?? false,
    };
    return c.action === 'end' ? runBrowserEnd(api) : runBrowserBattleInput(api);
  }
  if (c.action === 'deploy-mcv') {
    const before = await wait('genuine battle state before immediate deployment', async () => {
      const value = await worker().evaluate(() => globalThis.__auditCore.getCommandState());
      return value?.view && value.localHouse >= 0 ? value : null;
    });
    const mcv = before.objects.find(
      (o) => o.owner === before.localHouse && o.health > 0 && /^(AMCV|MCV|SMCV|PCV)$/.test(o.type),
    );
    assert(mcv, 'No actual local MCV');
    const zFactor = await worker().evaluate(async () => {
      const bytes = (await globalThis.__auditCore.connection.read(0xb0cd48, 8)).bytes;
      return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getFloat64(0, true);
    });
    const x = Math.trunc((30 * (mcv.x - mcv.y)) / 256) - before.view.x;
    const y =
      Math.trunc((15 * (mcv.x + mcv.y)) / 256) -
      Math.trunc(mcv.z * zFactor + (mcv.z >= 728 ? 1 : 0) + 0.5) -
      before.view.y;
    await click(x, y);
    await page.keyboard.down('d');
    await delay(200);
    await page.keyboard.up('d');
    const yard = await wait(
      'actual construction yard after ordinary D input',
      async () => {
        const s = await worker().evaluate(() => globalThis.__auditCore.getCommandState());
        return s?.objects.find(
          (o) => o.owner === s.localHouse && o.health > 0 && o.kind === 'building' && /CNST$/.test(o.type),
        );
      },
      12000,
    );
    await record('immediate-mcv-deployment', { mcv, point: [x, y], yard, actualGuestState: true });
    await shot('immediate-mcv-deployment');
    return { mcv, yard };
  }
  if (c.action === 'match-state')
    return worker().evaluate(async () => {
      const core = globalThis.__auditCore;
      const read = async (a, n) => new DataView((await core.connection.read(a, n)).bytes.buffer);
      const v = await read(0xa80228, 20),
        count = v.getInt32(16, true),
        items = v.getUint32(4, true),
        pointers = await read(items, count * 4),
        houses = [];
      for (let i = 0; i < count; i++) {
        const p = pointers.getUint32(i * 4, true);
        const name = new TextDecoder().decode((await core.connection.read(p + 0x15ff4, 21)).bytes).split('\0')[0];
        const human = (await core.connection.read(p + 0x1ec, 1)).bytes[0] !== 0;
        const allies = (await read(p + 0x5788, 4)).getUint32(0, true);
        houses.push({ index: i, name, human, allies });
      }
      const s = await core.getCommandState();
      return {
        frame: s?.frame,
        localHouse: s?.localHouse,
        view: s?.view,
        performance: await core.getGamePerformance(),
        houses,
      };
    });
  if (c.action === 'battle')
    return worker().evaluate(async () => {
      const core = globalThis.__auditCore;
      const s = await core.getCommandState();
      return {
        frame: s?.frame,
        view: s?.view,
        localHouse: s?.localHouse,
        players: s?.players,
        objects: s?.objects?.map((o) => ({
          uid: o.uid,
          type: o.type,
          owner: o.owner,
          kind: o.kind,
          health: o.health,
          x: o.x,
          y: o.y,
          z: o.z,
          selected: o.selected,
        })),
        performance: await core.getGamePerformance(),
      };
    });
  if (c.action === 'diag')
    return worker().evaluate(async () =>
      JSON.parse(new TextDecoder().decode(await globalThis.__auditCore.connection.request(11))),
    );
  if (c.action === 'close') return { closing: true };
  throw new Error('Unknown command ' + c.action);
}
async function cleanup() {
  if (cleanupPromise) return cleanupPromise;
  return (cleanupPromise = (async () => {
    clearInterval(rssTimer);
    await browser?.close().catch(() => {});
    await server?.close().catch(() => {});
    if (privateDir) await writeFile(join(privateDir, 'stop'), 'stop\n').catch(() => {});
    launch?.kill('SIGINT');
    const exit = await Promise.race([launchExit, delay(18000).then(() => ({ timeout: true }))]);
    if (exit?.timeout) launch?.kill('SIGTERM');
    let status = null;
    if (privateDir)
      status = await readFile(join(privateDir, 'status.json'), 'utf8')
        .then(JSON.parse)
        .catch(() => null);
    const dllRestored =
      JSON.stringify(await dllIdentity().catch(() => ({ unreadable: true }))) === JSON.stringify(dllBefore);
    const portsReleased = url
      ? await Promise.all([new URL(url).port, new URL(new URL(url).searchParams.get('agent')).port].map(portReleased))
      : null;
    const osHighwaterRssBytes = process.resourceUsage().maxRSS * 1024;
    peakRss = Math.max(peakRss, osHighwaterRssBytes);
    await record('cleanup', {
      exit,
      status,
      browserClosed: !browser?.isConnected(),
      dllRestored,
      portsReleased,
      peakRssBytes: peakRss,
      osHighwaterRssBytes,
      under1GiB: peakRss < 1024 ** 3,
    });
  })());
}
for (const signal of ['SIGINT', 'SIGTERM'])
  process.once(signal, () => {
    cleanup().finally(() => process.exit(1));
  });
try {
  await ownerIdle();
  dllBefore = await dllIdentity();
  launch = spawn('bash', [join(wt, 'scripts/remaster/native/play-native.sh')], {
    cwd: wt,
    env: { ...process.env, ...config, RA2_NATIVE_AGENT_HIDDEN: tag.startsWith('visible') ? '0' : '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  launchExit = new Promise((r) => launch.once('exit', (code, signal) => r({ code, signal })));
  for (const s of [launch.stdout, launch.stderr])
    s.on('data', (chunk) => {
      const text = chunk.toString();
      appendFile(join(out, 'launcher.log'), redact(text)).catch(() => {});
      logTail = (logTail + text).slice(-32768);
      const p = logTail.match(/Private launch logs and DLL backups: (.+)/);
      if (p) privateDir = p[1];
      const u = logTail.match(/http:\/\/127\.0\.0\.1:\d+\/\?[^\s]+/);
      if (u) url = u[0];
    });
  await wait('launcher URL', () => url, 120000);
  const cache = join(homedir(), 'Library/Caches/ms-playwright/chromium-1243');
  const exe = join(
    cache,
    (await readdir(cache)).find((d) => d.startsWith('chrome-')),
    'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  );
  browser = await chromium.launch({
    headless: false,
    executablePath: exe,
    args: [
      '--window-size=1728,1117',
      '--enable-unsafe-webgpu',
      '--enable-gpu',
      '--use-angle=metal',
      '--ignore-gpu-blocklist',
      '--autoplay-policy=no-user-gesture-required',
      '--enable-webgpu-developer-features',
    ],
  });
  const context = await browser.newContext({ viewport: { width: 1728, height: 1117 }, deviceScaleFactor: 2 });
  await context.grantPermissions(['local-network-access'], { origin: new URL(url).origin });
  await context.route('**/src/adapter/vmWorker.ts*', async (route) => {
    const r = await route.fetch();
    const source = await r.text();
    assert(source.includes('installVmWorker(self);'));
    await route.fulfill({
      response: r,
      body: source.replace(
        'installVmWorker(self);',
        'const auditController=installVmWorker(self); Object.defineProperty(globalThis,"__auditCore",{get:()=>auditController.core});',
      ),
    });
  });
  await context.route('**/src/ui/pages/game/gameInput.ts*', async (route) => {
    const r = await route.fetch();
    const source = await r.text();
    const needle = 'onCursorPresentation?.(x, y, document.pointerLockElement === canvas);';
    assert(source.includes(needle));
    await route.fulfill({
      response: r,
      body: source.replaceAll(needle, needle + ' window.__phase7InputProbe?.position(x,y);'),
    });
  });
  await context.route('**/src/ui/pages/game/vmFrameRenderer.ts*', async (route) => {
    const r = await route.fetch();
    const source = await r.text();
    const needle = 'if (!destroyed) backend.draw(...args);';
    assert(source.includes(needle));
    await route.fulfill({
      response: r,
      body: source.replace(
        needle,
        'if (!destroyed) { backend.draw(...args); window.__phase7Presentation?.draw(args); }',
      ),
    });
  });
  page = await context.newPage();
  cdp = await context.newCDPSession(page);
  const initialWindow = await cdp.send('Browser.getWindowForTarget');
  await cdp.send('Browser.setWindowBounds', {
    windowId: initialWindow.windowId,
    bounds: { width: 1728, height: 1117, windowState: 'normal' },
  });
  page.on('response', (r) => {
    if (r.status() >= 400) record('http-error', { status: r.status(), url: redact(r.url()) });
  });
  page.on('pageerror', (e) => record('pageerror', { error: String(e) }));
  page.on('console', (m) => {
    if (m.type() === 'error') record('console-error', { text: m.text().slice(0, 1000) });
  });
  await page.goto(url);
  await page.bringToFront();
  const ownedWindow = await cdp.send('Browser.getWindowForTarget');
  await cdp.send('Browser.setWindowBounds', { windowId: ownedWindow.windowId, bounds: { windowState: 'fullscreen' } });
  await delay(1000);
  await wait(
    'native main menu',
    async () => {
      try {
        return (await state()).controls?.some((c) => usable(c) && c.id === 1667);
      } catch {
        return false;
      }
    },
    120000,
  );
  const toggle = page.locator('#vm-controls-toggle');
  if ((await toggle.getAttribute('aria-expanded')) === 'true') await toggle.click();
  const { installPhase7InputProbe } = await import('./phase7-input-stream.mjs');
  await installPhase7InputProbe(page);
  try {
    const { disableWorkerNetworkPayloadObservation } = await import('./phase7-input-stream.mjs');
    await record('worker-payload-observation', await disableWorkerNetworkPayloadObservation(page));
  } catch (e) {
    await record('payload-probe-unavailable', { error: String(e) });
  }
  await wait(
    'first native picture on page',
    async () => await worker().evaluate(() => !!globalThis.__auditCore.connection.pictureDecoder.previous),
    120000,
  );
  await delay(1000);
  await shot('main-menu');
  await record('ready', {
    tag,
    installedAgent: await dllIdentity(),
    viewport: await page.evaluate(() => ({
      width: innerWidth,
      height: innerHeight,
      outerWidth,
      outerHeight,
      dpr: devicePixelRatio,
    })),
    browserWindow: await cdp.send('Browser.getWindowForTarget'),
    hello: await worker().evaluate(() => globalThis.__auditCore.hello),
  });
  await writeFile(join(out, 'ready'), 'ready\n');
  const until = Math.min(Date.now() + 21 * 60000, scopeDeadline);
  const done = new Set();
  while (Date.now() < until) {
    if (await exists(join(out, 'cancel'))) break;
    const files = (await readdir(out)).filter((f) => /^command-[0-9]+\.json$/.test(f)).sort();
    let close = false;
    for (const file of files) {
      if (done.has(file)) continue;
      done.add(file);
      const cmd = JSON.parse(await readFile(join(out, file), 'utf8'));
      try {
        const result = await execute(cmd);
        await writeFile(join(out, file.replace('command-', 'result-')), JSON.stringify({ ok: true, result }, null, 2));
        await record('command', { file, action: cmd.action });
        if (cmd.action === 'close') close = true;
      } catch (e) {
        await writeFile(
          join(out, file.replace('command-', 'result-')),
          JSON.stringify({ ok: false, error: String(e.stack || e) }, null, 2),
        );
        await record('command-error', { file, error: String(e) });
      }
    }
    if (close) break;
    await delay(100);
  }
} catch (e) {
  await record('fatal', { error: String(e.stack || e) });
  process.exitCode = 1;
} finally {
  await cleanup();
}
