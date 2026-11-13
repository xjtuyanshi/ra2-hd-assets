#!/usr/bin/env node
// Comparable, bounded menu measurements. The emulator checkout is observed through browser routes only.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile, appendFile, readdir, lstat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from '@playwright/test';
import { outputDirectory } from './artifacts.mjs';
import { inspectEmulatorMapModes } from './phase8-emulator-map-inspection.mjs';
import {
  installMenuRasterProbe,
  phase8MenuRoutes,
  usableMenuControl,
  calibrateMenuTemplate,
  measureMenuRoute,
  summarizeMenuRecords,
} from './phase8-menu-measure.mjs';

const wt = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const root = resolve(wt, '../..');
const base = outputDirectory();
const mode = process.argv[2] ?? 'hidden';
const tag = process.argv[3] ?? '01';
const task = process.argv[4] ?? 'menus';
assert(['hidden', 'visible', 'emulator'].includes(mode));
assert(/^[a-zA-Z0-9_-]+$/.test(tag));
assert(['menus', 'maps', 'menus-and-maps'].includes(task));
assert(task === 'menus' || mode === 'emulator', 'Map inspection currently observes the immutable emulator');
const out = join(base, 'phase8', `${task === 'maps' ? 'maps' : 'menu'}-${mode}-${tag}`);
let mapInspectionActive = task === 'maps';
const perfLogFile = join(out, 'stalls.jsonl');
await mkdir(out, { recursive: true });
const config = JSON.parse(await readFile(join(base, 'run/owner-launch-smoke.json'), 'utf8'));
const deadline = await readFile(join(base, 'phase8/deadline.json'), 'utf8')
  .then((text) => Date.parse(JSON.parse(text).deadlineAt))
  .catch(() => Date.now() + 30 * 60000);
const exists = async (path) => !!(await lstat(path).catch(() => null));
const redact = (text) => String(text).replace(/agent-token=[a-f0-9]+/gi, 'agent-token=[redacted]');
const record = async (name, proof) => {
  await appendFile(
    join(out, 'observations.jsonl'),
    JSON.stringify({ name, at: new Date().toISOString(), proof }) + '\n',
  );
  console.log(name, JSON.stringify(proof).slice(0, 1400));
};
async function ownerIdle() {
  if (await exists(join(out, 'cancel'))) throw new Error('Owned benchmark cancelled');
  while (await exists(join(root, 'gameres/s2x/play/_slots/PAUSE'))) {
    if (Date.now() > deadline) throw new Error('Phase 8 deadline reached while held');
    await writeFile(join(out, 'held'), 'Owner playing; benchmark held\n');
    await delay(1000);
  }
  if (Date.now() > deadline) throw new Error('Phase 8 deadline reached');
}
async function wait(label, fn, ms = 60000) {
  const until = Math.min(Date.now() + ms, deadline);
  do {
    const value = await fn();
    if (value) return value;
    await delay(50);
  } while (Date.now() < until);
  throw new Error('Timeout ' + label);
}
let launch,
  launchExit,
  browser,
  page,
  cdp,
  privateDir,
  url,
  logTail = '',
  dllBefore,
  lastStateError = null;
const emulatorWt = join(root, '.worktrees/s2-play8');
const dllIdentity = async () => {
  const path = join(config.RA2_NATIVE_GAME_DIR || process.env.RA2_NATIVE_GAME_DIR, 'ddraw.dll');
  const info = await lstat(path).catch(() => null);
  return info
    ? {
        sha256: createHash('sha256')
          .update(await readFile(path))
          .digest('hex'),
        mode: info.mode & 0o777,
      }
    : null;
};
const worker = () => page.workers().find((value) => /vmWorker/.test(value.url()));
async function state() {
  if (mode !== 'emulator')
    return worker().evaluate(async () =>
      JSON.parse(new TextDecoder().decode(await globalThis.__auditCore.connection.request(14))),
    );
  return worker().evaluate((mapsOnly) => {
    const shim = globalThis.__auditCore?.shim;
    if (!shim) return { controls: [] };
    const controls = Array.from(shim.controlIds, ([hwnd, id]) => {
      const rect = shim.screenRect(hwnd);
      return {
        hwnd,
        id,
        class: shim.windowClassNames.get(hwnd),
        text: shim.windowTexts.get(hwnd),
        visible: shim.isWindowVisible(hwnd) && shim.isActiveShellWindow(hwnd),
        enabled: ((shim.windowLongs.get(`${hwnd}:-16`) ?? 0) & 0x08000000) === 0,
        rect: [rect.x, rect.y, rect.x + rect.width, rect.y + rect.height],
        items: shim.controlItems.get(hwnd) ?? [],
        selection: shim.controlSelections.get(hwnd) ?? -1,
        topIndex: shim.listboxTopIndices.get(hwnd) ?? 0,
        ...(mapsOnly
          ? {
              rowHeight: shim.controlItemHeights.get(hwnd) ?? 16,
              parentHwnd: shim.windowParents.get(hwnd),
              scroll: shim.scrollbarStates.get(hwnd) ?? null,
            }
          : {}),
      };
    });
    return { controls, shellPageTitle: shim.shellPageTitle, primaryWindow: shim.primaryWindow };
  }, mapInspectionActive);
}
async function point(x, y) {
  const bounds = await page.locator('#screen').boundingBox();
  const frame = await page.evaluate(() => window.__phase8MenuProbe.latest);
  return [bounds.x + (x * bounds.width) / frame.width, bounds.y + (y * bounds.height) / frame.height];
}
async function click(x, y) {
  const [px, py] = await point(x, y);
  await page.mouse.move(px, py);
  let pose = null;
  if (mode === 'emulator') {
    // Observe the real browser event and genuine shim state; do not write guest coordinates.
    const expected = await page.evaluate(() => {
      const probe = window.__phase8MenuProbe;
      const event = probe.lastPointerMove;
      const rect = document.getElementById('screen').getBoundingClientRect();
      if (!event) throw new Error('Actual browser pointermove required before menu click');
      return {
        x: Math.floor(((event.clientX - rect.left) * probe.latest.width) / rect.width),
        y: Math.floor(((event.clientY - rect.top) * probe.latest.height) / rect.height),
        event,
        pointerLocked: !!document.pointerLockElement,
      };
    });
    assert(!expected.pointerLocked, 'Absolute menu measurement must not acquire Pointer Lock');
    let observed = null;
    try {
      observed = await wait(
        'real emulator pointer pose before click',
        async () => {
          observed = await worker().evaluate(() => globalThis.__auditCore.getPointerState());
          return observed?.x === expected.x && observed?.y === expected.y ? observed : null;
        },
        5000,
      );
    } finally {
      pose = { requestedGame: { x, y }, requestedPage: { x: px, y: py }, expected, observed };
      await record('menu-click-pose', pose);
    }
  }
  await page.mouse.down();
  await delay(40);
  await page.mouse.up();
  return pose;
}
async function shot(label) {
  await page.screenshot({ path: join(out, `${label}.png`), scale: 'css' });
  await writeFile(join(out, `${label}-controls.json`), JSON.stringify(await state(), null, 2));
  await record('screenshot', { label, path: join(out, `${label}.png`) });
}
async function diagnostic(label) {
  const proof = { label, lastStateError, at: new Date().toISOString() };
  if (page && !page.isClosed()) {
    await page.screenshot({ path: join(out, `${label}.png`), scale: 'css' }).catch((error) => {
      proof.screenshotError = String(error);
    });
    proof.page = await page
      .evaluate(() => ({
        title: document.title,
        bodyText: document.body.innerText.slice(0, 12000),
        controls: Array.from(document.querySelectorAll('button,select')).map((element) => ({
          tag: element.tagName,
          id: element.id,
          text: element.textContent,
          disabled: element.disabled,
        })),
        screen: document.getElementById('screen')
          ? {
              width: document.getElementById('screen').width,
              height: document.getElementById('screen').height,
              rect: document.getElementById('screen').getBoundingClientRect().toJSON(),
            }
          : null,
        latestRaster: window.__phase8MenuProbe?.latest
          ? {
              width: window.__phase8MenuProbe.latest.width,
              height: window.__phase8MenuProbe.latest.height,
              at: window.__phase8MenuProbe.latest.at,
              draws: window.__phase8MenuProbe.draws,
            }
          : null,
      }))
      .catch((error) => ({ error: String(error) }));
    proof.workers = page.workers().map((value) => redact(value.url()));
    if (worker())
      proof.worker = await worker()
        .evaluate(() => {
          const core = globalThis.__auditCore,
            shim = core?.shim;
          const proto = (value) => {
            const names = [];
            for (let current = value; current && names.length < 200; current = Object.getPrototypeOf(current))
              names.push(...Object.getOwnPropertyNames(current));
            return [...new Set(names)];
          };
          return {
            auditCorePresent: !!core,
            coreType: core?.constructor?.name,
            coreKeys: core ? Object.keys(core) : [],
            shimType: shim?.constructor?.name,
            shimKeys: shim ? Object.keys(shim) : [],
            shimMethods: shim ? proto(shim) : [],
            controls: shim?.controlIds
              ? Array.from(shim.controlIds, ([hwnd, id]) => ({
                  hwnd,
                  id,
                  text: shim.windowTexts?.get(hwnd),
                  class: shim.windowClassNames?.get(hwnd),
                  rect: shim.windowRects?.get(hwnd),
                  visible: typeof shim.isWindowVisible === 'function' ? shim.isWindowVisible(hwnd) : null,
                }))
              : null,
            shell: shim
              ? {
                  activeShellPage: shim.activeShellPage,
                  primaryWindow: shim.primaryWindow,
                  shellPageTitle: shim.shellPageTitle,
                  size: [shim.displayWidth, shim.displayHeight],
                }
              : null,
            calls: core?.calls,
            presentedFrames: core?.presentedFrames,
          };
        })
        .catch((error) => ({ error: String(error) }));
    proof.state = await state().catch((error) => ({ error: String(error) }));
  }
  await writeFile(join(out, `${label}-diagnostic.json`), JSON.stringify(proof, null, 2));
  await record('diagnostic', {
    label,
    screenshot: `${label}.png`,
    lastStateError,
    corePresent: proof.worker?.auditCorePresent,
    controls: proof.worker?.controls?.length,
    bodyText: proof.page?.bodyText?.slice(0, 1200),
  });
}
async function cleanup() {
  await browser?.close().catch(() => {});
  if (privateDir) await writeFile(join(privateDir, 'stop'), 'stop\n').catch(() => {});
  launch?.kill('SIGINT');
  const exit = await Promise.race([
    launchExit ?? Promise.resolve(null),
    delay(18000, undefined, { ref: false }).then(() => ({ timeout: true })),
  ]);
  if (exit?.timeout) launch?.kill('SIGTERM');
  await record('cleanup', {
    exit,
    browserClosed: !browser?.isConnected(),
    dllRestored: mode === 'emulator' ? null : JSON.stringify(await dllIdentity()) === JSON.stringify(dllBefore),
    peakRssBytes: process.resourceUsage().maxRSS * 1024,
  });
}
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => cleanup().finally(() => process.exit(1)));
try {
  await ownerIdle();
  if (mode === 'emulator') {
    assert(
      await exists(join(emulatorWt, 'node_modules/.bin/vite')),
      'Immutable emulator dependencies must already exist',
    );
    assert(
      await exists(join(emulatorWt, 'node_modules/relay-package/dist/lib/server.js')),
      'Immutable emulator relay build must already exist',
    );
    url =
      'http://localhost:15452/?hd=1&hd-look=cinematic&hd-fx=enhanced&hd-water=clear&hd-vlook=remaster&hd-vproj=vehicles-hd&hd-ui=1&resolution=display&game-speed=3&mouse-lock=0';
    launch = spawn(
      process.execPath,
      [join(wt, 'scripts/remaster/native/phase8-emulator-server.mjs'), emulatorWt, join(out, 'vite-cache')],
      {
        cwd: out,
        env: {
          ...process.env,
          RA2_DEV_HTTP: '1',
          RA2_GAME_ROOT: join(root, 'game'),
          RA2_HD_CACHE_DIR: join(root, 'gameres/hd-cache-play6'),
          RA2_PERF_LOG: perfLogFile,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
  } else {
    dllBefore = await dllIdentity();
    launch = spawn('bash', [join(wt, 'scripts/remaster/native/play-native.sh')], {
      cwd: wt,
      env: { ...process.env, ...config, RA2_NATIVE_AGENT_HIDDEN: mode === 'visible' ? '0' : '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  }
  launchExit = new Promise((resolve) => launch.once('exit', (code, signal) => resolve({ code, signal })));
  for (const stream of [launch.stdout, launch.stderr])
    stream.on('data', (chunk) => {
      const text = chunk.toString();
      appendFile(join(out, 'launcher.log'), redact(text)).catch(() => {});
      logTail = (logTail + text).slice(-32768);
      const privateMatch = logTail.match(/Private launch logs and DLL backups: (.+)/);
      if (privateMatch) privateDir = privateMatch[1];
      if (mode !== 'emulator') url = logTail.match(/http:\/\/127\.0\.0\.1:\d+\/\?[^\s]+/)?.[0] ?? url;
    });
  await wait('launch URL', () => url, 120000);
  await wait(
    'server',
    () =>
      fetch(new URL(url).origin)
        .then((response) => response.ok)
        .catch(() => false),
    120000,
  );
  const cache = join(homedir(), 'Library/Caches/ms-playwright/chromium-1243');
  const exe = join(
    cache,
    (await readdir(cache)).find((entry) => entry.startsWith('chrome-')),
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
  await context.addInitScript(installMenuRasterProbe);
  await context.route('**/src/adapter/vmWorker.ts*', async (route) => {
    const response = await route.fetch();
    const source = await response.text();
    assert(source.includes('installVmWorker(self);'), 'Actual Worker entry required');
    await route.fulfill({
      response,
      body: source.replace(
        'installVmWorker(self);',
        'const auditController=installVmWorker(self); Object.defineProperty(globalThis,"__auditCore",{get:()=>auditController.core});',
      ),
    });
  });
  await context.route('**/src/ui/pages/game/vmFrameRenderer.ts*', async (route) => {
    const response = await route.fetch();
    const source = await response.text();
    const needle = 'if (!destroyed) backend.draw(...args);';
    assert(source.includes(needle), 'Actual backend draw boundary required');
    await route.fulfill({
      response,
      body: source.replace(needle, 'if (!destroyed) { backend.draw(...args); window.__phase8MenuProbe?.draw(args); }'),
    });
  });
  page = await context.newPage();
  cdp = await context.newCDPSession(page);
  page.on('pageerror', (error) => record('pageerror', { error: String(error) }));
  page.on('console', (message) => {
    if (message.type() === 'error') record('console-error', { text: message.text().slice(0, 700) });
  });
  page.on('response', (response) => {
    if (response.status() >= 400) record('http-error', { status: response.status(), url: redact(response.url()) });
    if (new URL(response.url()).pathname === '/__perf/stalls')
      record('actual-page-stall-log-response', { status: response.status(), destination: perfLogFile });
  });
  page.on('requestfailed', (request) =>
    record('request-failed', { url: redact(request.url()), error: request.failure()?.errorText }),
  );
  await page.goto(url);
  await page.bringToFront();
  const browserWindow = await cdp.send('Browser.getWindowForTarget');
  await cdp.send('Browser.setWindowBounds', {
    windowId: browserWindow.windowId,
    bounds: { width: 1728, height: 1117, windowState: 'normal' },
  });
  if (mode === 'emulator') {
    await page.locator('.development-source').click();
    const choices = page.locator('.detected-games button');
    // A Worker can exist before a source is selected. Wait for the actual choices or a started game.
    await wait(
      'emulator game discovery',
      async () => (await choices.count()) || (await state().catch(() => ({ controls: [] }))).controls.length,
      30000,
    );
    if (await choices.count()) await choices.filter({ hasText: /Yuri|尤里/i }).click();
  }
  const mainMenuWaitStarted = Date.now();
  let warmDiagnosticTaken = false;
  let startupSkipCount = 0;
  let lastStartupSkipAt = 0;
  const earlyToggle = page.locator('#vm-controls-toggle');
  if ((await earlyToggle.getAttribute('aria-expanded')) === 'true') await earlyToggle.click();
  if (mode === 'emulator') await page.locator('#screen').focus();
  await wait(
    'actual main menu',
    async () => {
      if (!warmDiagnosticTaken && Date.now() - mainMenuWaitStarted >= 30000) {
        warmDiagnosticTaken = true;
        await diagnostic('warm-wait-30s');
      }
      try {
        const current = await state();
        lastStateError = null;
        if (current.controls.some((control) => usableMenuControl(control) && control.id === 1667)) return true;
        if (mode === 'emulator' && worker() && startupSkipCount < 8 && Date.now() - lastStartupSkipAt >= 1000) {
          const movie = await worker().evaluate(() => {
            const shim = globalThis.__auditCore?.shim;
            return shim
              ? {
                  active: !!shim.nativeBinkPlaybackActive || !!shim.binkVideos?.size,
                  handles: Array.from(shim.binkVideos ?? []),
                  activeShellPage: shim.activeShellPage,
                }
              : null;
          });
          if (movie?.active && !movie.activeShellPage) {
            await ownerIdle();
            await page.locator('#screen').focus();
            await page.keyboard.press('Escape');
            startupSkipCount++;
            lastStartupSkipAt = Date.now();
            await record('startup-movie-skip-input', {
              input: 'Ordinary focused browser Escape',
              count: startupSkipCount,
              observedMovie: movie,
              measuredRoute: false,
            });
          }
        }
        return false;
      } catch (error) {
        lastStateError = String(error.stack ?? error);
        return false;
      }
    },
    120000,
  );
  const toggle = page.locator('#vm-controls-toggle');
  if ((await toggle.getAttribute('aria-expanded')) === 'true') await toggle.click();
  await wait('first actual raster', () => page.evaluate(() => !!window.__phase8MenuProbe.latest));
  await delay(1500);
  await shot('main-menu');
  await record('ready', {
    mode,
    tag,
    task,
    viewport: await page.evaluate(() => ({
      width: innerWidth,
      height: innerHeight,
      outerWidth,
      outerHeight,
      dpr: devicePixelRatio,
    })),
    browserWindow: await cdp.send('Browser.getWindowForTarget'),
    installedAgent: mode === 'emulator' ? null : await dllIdentity(),
    emulatorReadOnlyCheckout: mode === 'emulator' ? emulatorWt : null,
    emulatorPerfLog: mode === 'emulator' ? perfLogFile : null,
    measurementInput: {
      mode: 'absolute',
      queryOverride: mode === 'emulator' ? 'mouse-lock=0' : null,
      reason:
        'The documented emulator absolute-input option matches native page input and allows ordinary coordinate clicks. The immutable checkout and its Pointer Lock default remain unchanged.',
    },
  });
  if (task === 'maps') {
    await inspectEmulatorMapModes({ page, out, state, click, point, shot, wait, record, ownerIdle });
  } else {
    const templates = {},
      records = [];
    // Unmeasured warmup visits learn each backend's real target pixels rather than assuming identical fonts.
    for (const route of phase8MenuRoutes) {
      await ownerIdle();
      const source = (await state()).controls.find((value) => usableMenuControl(value) && value.id === route.id);
      assert(source, 'Missing warmup source ' + route.id);
      await click((source.rect[0] + source.rect[2]) / 2, (source.rect[1] + source.rect[3]) / 2);
      const destination = await wait(
        'warmup target ' + route.expected,
        async () => {
          const value = await state();
          return value.controls.some((control) => usableMenuControl(control) && control.id === route.expected)
            ? value
            : null;
        },
        30000,
      );
      const [nx, ny] = await point(400, 560);
      await page.mouse.move(nx, ny);
      await delay(2000);
      const control = destination.controls.find((value) => usableMenuControl(value) && value.id === route.expected);
      templates[route.expected] = await calibrateMenuTemplate({ page, control, label: route.name, wait });
      await shot('warmup-' + route.name);
      if (route.name === 'skirmish-to-map')
        await record(
          'map-list',
          destination.controls.filter((value) => value.visible && [1771, 1363].includes(value.id)),
        );
    }
    await writeFile(join(out, 'raster-templates.json'), JSON.stringify(templates));
    for (let repeat = 1; repeat <= 4; repeat++)
      for (const route of phase8MenuRoutes) {
        const evidence = await measureMenuRoute({
          page,
          route,
          template: templates[route.expected],
          point,
          click,
          state,
          wait,
          ownerIdle,
        });
        const label = `${route.name}-${repeat}`;
        await writeFile(join(out, `${label}-measurement.json`), JSON.stringify(evidence, null, 2));
        const { actualDestination, draws, ...compact } = evidence;
        records.push({ ...compact, repeat, evidenceFile: `${label}-measurement.json` });
        await record('menu-measurement', records.at(-1));
        await delay(600);
        await shot(label);
        await writeFile(
          join(out, 'summary.json'),
          JSON.stringify(
            { mode, tag, updatedAt: new Date().toISOString(), records, ...summarizeMenuRecords(records) },
            null,
            2,
          ),
        );
      }
    await record('complete', summarizeMenuRecords(records));
    if (task === 'menus-and-maps') {
      mapInspectionActive = true;
      await inspectEmulatorMapModes({ page, out, state, click, point, shot, wait, record, ownerIdle });
    }
  }
} catch (error) {
  await diagnostic('fatal-page').catch((diagnosticError) =>
    record('diagnostic-error', { error: String(diagnosticError) }),
  );
  await record('fatal', { error: String(error.stack ?? error) });
  process.exitCode = 1;
} finally {
  await cleanup();
}
