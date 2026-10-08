#!/usr/bin/env node
// Mechanism-only browser smoke: real owned cursor atlas, explicit non-game surface and pointer metadata fixtures.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, readdir, lstat } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { homedir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from '@playwright/test';
import { outputDirectory } from './artifacts.mjs';

const wt = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const root = resolve(wt, '../..');
const base = outputDirectory();
const tag = process.argv[2] ?? '01';
const lifecycleOnly = process.argv[3] === 'lifecycle';
assert(process.argv[3] === undefined || lifecycleOnly, 'Expected optional lifecycle mode');
assert(/^[a-zA-Z0-9_-]+$/.test(tag));
const out = join(base, 'phase8', tag === '01' ? 'page-pointer-smoke' : `page-pointer-smoke-${tag}`);
assert(
  !(await lstat(join(out, 'report.json')).catch(() => null)),
  'Existing mechanism evidence must be preserved; use a new tag',
);
await mkdir(out, { recursive: true });
const deadline = await readFile(join(base, 'phase8/deadline.json'), 'utf8').then((text) =>
  Date.parse(JSON.parse(text).deadlineAt),
);
const pause = join(root, 'gameres/s2x/play/_slots/PAUSE');
const exists = async (path) => !!(await lstat(path).catch(() => null));
async function ownerIdle() {
  while (await exists(pause)) {
    if (Date.now() > deadline) throw new Error('Bounded deadline while held');
    await writeFile(join(out, 'held'), 'Owner playing; mechanism smoke held\n');
    await delay(1000);
  }
  if (Date.now() > deadline) throw new Error('Bounded deadline reached');
}
const summary = (values) => {
  const sorted = values.toSorted((a, b) => a - b);
  return {
    n: sorted.length,
    p50: sorted[Math.max(0, Math.ceil(sorted.length * 0.5) - 1)] ?? null,
    p95: sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)] ?? null,
    max: sorted.at(-1) ?? null,
  };
};
let server, browser, page;
try {
  await ownerIdle();
  const config = JSON.parse(await readFile(join(base, 'run/owner-launch-smoke.json'), 'utf8'));
  Object.assign(process.env, {
    RA2_DEV_HTTP: '1',
    RA2_GAME_ROOT: join(root, 'game'),
    RA2_HD_CACHE_DIR: config.RA2_HD_CACHE_DIR,
    RA2_PERF_LOG: '',
  });
  // Vite's runner config loader also uses cwd for its transient in-memory environment.
  process.chdir(out);
  const { createServer } = await import(pathToFileURL(join(wt, 'node_modules/vite/dist/node/index.js')).href);
  server = await createServer({
    root: wt,
    configFile: join(wt, 'vite.config.ts'),
    configLoader: 'runner',
    cacheDir: join(out, 'vite-cache'),
    server: { port: 15452, strictPort: true, host: '127.0.0.1' },
  });
  await server.listen();
  const cache = join(homedir(), 'Library/Caches/ms-playwright/chromium-1243');
  const exe = join(
    cache,
    (await readdir(cache)).find((entry) => entry.startsWith('chrome-')),
    'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  );
  browser = await chromium.launch({
    executablePath: exe,
    headless: false,
    args: [
      '--window-size=1728,1117',
      '--enable-unsafe-webgpu',
      '--enable-gpu',
      '--use-angle=metal',
      '--ignore-gpu-blocklist',
    ],
  });
  const context = await browser.newContext({ viewport: { width: 1728, height: 1117 }, deviceScaleFactor: 2 });
  const errors = [];
  page = await context.newPage();
  page.on('pageerror', (error) => errors.push(String(error)));
  await page.route('**/__phase8_pointer_fixture', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><html><head><meta charset="utf-8"><title>Phase 8 pointer mechanism smoke</title><style>html,body{margin:0;width:100%;height:100%;background:#121822;color:#e2e8f0;font:16px system-ui}#screen{position:absolute;left:64px;top:70px;width:1600px;height:1000px;cursor:crosshair;background:#202b39}p{position:absolute;z-index:2;left:24px;top:8px;pointer-events:none}</style></head><body><p>Mechanism smoke — blank test surface, fixture pointer state, real player-owned cursor atlas. This is not a game screenshot.</p><canvas id="screen" width="800" height="500"></canvas></body></html>',
    }),
  );
  await page.route('**/__phase8_missing_cursor/**', (route) =>
    route.fulfill({ status: 404, contentType: 'text/plain', body: 'Intentional absent asset for fallback smoke' }),
  );
  await page.goto('http://127.0.0.1:15452/__phase8_pointer_fixture');
  const cdp = await context.newCDPSession(page);
  const browserWindow = await cdp.send('Browser.getWindowForTarget');
  await cdp.send('Browser.setWindowBounds', {
    windowId: browserWindow.windowId,
    bounds: { width: 1728, height: 1117, windowState: 'normal' },
  });
  await page.bringToFront();
  if (lifecycleOnly) {
    const active = await page.evaluate(async () => {
      const { createNativeCursorFrames } = await import('/src/ui/pages/game/nativeCursorFrames.ts');
      const screen = document.getElementById('screen');
      document.querySelector('p').textContent =
        'Lifecycle smoke — explicit native-picture fallback fixture, genuine browser CSS ownership. No game runs.';
      screen.style.setProperty('cursor', 'crosshair', 'important');
      const snapshot = () => ({
        value: screen.style.getPropertyValue('cursor'),
        priority: screen.style.getPropertyPriority('cursor'),
        computed: getComputedStyle(screen).cursor,
      });
      const state = { released: false, presented: [] };
      const initial = snapshot();
      const controller = createNativeCursorFrames({
        screen,
        pageCursor: () => null,
        presentCursor: (x, y, visible) => state.presented.push({ x, y, visible }),
        isReleased: () => state.released,
      });
      const frame = {
        width: 800,
        height: 500,
        pixels: new Uint8Array(),
        palette: new Uint8Array(),
        pointer: null,
      };
      controller.onFrame(frame);
      window.__phase8CursorFrameLifecycle = { state, controller, frame, snapshot };
      return { initial, active: snapshot(), presented: [...state.presented] };
    });
    await page.mouse.move(500, 500);
    await page.screenshot({ path: join(out, 'native-picture-fallback-active.png'), scale: 'css' });
    const released = await page.evaluate(() => {
      const { state, controller, frame, snapshot } = window.__phase8CursorFrameLifecycle;
      state.released = true;
      const before = state.presented.length;
      controller.onFrame(frame);
      const ignoredDuringRelease = state.presented.length === before;
      controller.dispose();
      const restored = snapshot();
      controller.onFrame(frame);
      controller.dispose();
      return {
        ignoredDuringRelease,
        restored,
        afterLateFrame: snapshot(),
        presentedBeforeRelease: before,
        presentedAfterLateFrame: state.presented.length,
      };
    });
    await page.screenshot({ path: join(out, 'native-picture-fallback-restored.png'), scale: 'css' });
    assert.deepEqual(active.initial, { value: 'crosshair', priority: 'important', computed: 'crosshair' });
    assert.deepEqual(active.active, { value: 'none', priority: 'important', computed: 'none' });
    assert(released.ignoredDuringRelease);
    assert.deepEqual(released.restored, active.initial);
    assert.deepEqual(released.afterLateFrame, active.initial);
    assert.equal(released.presentedAfterLateFrame, released.presentedBeforeRelease);
    const report = {
      kind: 'Explicit non-game native cursor frame lifecycle evidence only',
      tag,
      mode: 'lifecycle',
      active,
      released,
      errors,
      screenshots: ['native-picture-fallback-active.png', 'native-picture-fallback-restored.png'],
      limitation:
        'Real browser DOM and the production frame helper are exercised with explicit frame metadata fixtures. No Wine process, game picture, hardware cursor bitmap, latency or native suppression acceptance is represented.',
    };
    await writeFile(join(out, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
  } else {
    const setup = await page.evaluate(async () => {
      const { createNativeCursor } = await import('/src/ui/pages/game/nativeCursor.ts');
      const { currentCanvasRect } = await import('/src/ui/pages/game/gameInput.ts');
      const screen = document.getElementById('screen');
      const manifestResponse = await fetch('/hd-cache/_ui/cursor/cursor.json');
      const manifest = await manifestResponse.json();
      const cursor = await createNativeCursor(screen);
      if (!cursor) throw new Error('The actual owned cursor atlas failed to load');
      const frame = {
        width: 800,
        height: 500,
        pixels: new Uint8Array(),
        palette: new Uint8Array(),
        pointer: { frame: 0, x: 0, y: 0, hotspotX: 16, hotspotY: 16 },
      };
      cursor.update(frame);
      const smoke = {
        cursor,
        frame,
        samples: [],
        frameNumber: 0,
        lastRafAt: performance.now(),
        lastSequence: 0,
        listeners: [],
        fixtureMetadata: true,
        geometryReady: false,
        layoutDeliveries: [],
      };
      const tick = () => {
        smoke.frameNumber++;
        smoke.lastRafAt = performance.now();
        smoke.raf = requestAnimationFrame(tick);
      };
      smoke.raf = requestAnimationFrame(tick);
      const observe = (event) => {
        const element = document.getElementById('native-page-cursor');
        const box = screen.getBoundingClientRect();
        const pointer = smoke.frame.pointer;
        const sx = box.width / smoke.frame.width,
          sy = box.height / smoke.frame.height;
        const transform = new DOMMatrixReadOnly(element.style.transform);
        const actual = { x: transform.m41 + pointer.hotspotX * sx, y: transform.m42 + pointer.hotspotY * sy };
        const at = performance.now(),
          sequence = ++smoke.lastSequence;
        const sample = {
          sequence,
          type: event.type,
          trusted: event.isTrusted,
          at,
          eventTimeStamp: event.timeStamp,
          pointer: { x: event.clientX, y: event.clientY },
          actualCssHotspot: actual,
          exactAtHandler: actual.x === event.clientX && actual.y === event.clientY,
          visible: element.style.display === 'block',
          screenCursor: getComputedStyle(screen).cursor,
          handlerFrame: smoke.frameNumber,
          lastRafAt: smoke.lastRafAt,
          glyphFrame: pointer.frame,
          fixtureHotspot: [pointer.hotspotX, pointer.hotspotY],
          scale: [sx, sy],
          stableResizedGeometry: smoke.geometryReady,
        };
        smoke.samples.push(sample);
        requestAnimationFrame(() => {
          sample.nextRafAt = performance.now();
          sample.nextFrame = smoke.frameNumber;
          sample.displayFrameDelta = sample.nextFrame - sample.handlerFrame;
          sample.supersededBeforePresentation = smoke.lastSequence !== sequence;
          const latest = new DOMMatrixReadOnly(element.style.transform);
          sample.exactAtNextRaf =
            latest.m41 + pointer.hotspotX * sx === event.clientX &&
            latest.m42 + pointer.hotspotY * sy === event.clientY;
        });
      };
      for (const type of ['pointerenter', 'pointermove', 'pointerdown', 'pointerup']) {
        screen.addEventListener(type, observe);
        smoke.listeners.push([type, observe]);
      }
      smoke.update = async (glyphFrame, scale) => {
        smoke.geometryReady = false;
        const cssAppliedAt = performance.now();
        smoke.frame.pointer.frame = glyphFrame;
        screen.style.width = `${800 * scale}px`;
        screen.style.height = `${500 * scale}px`;
        smoke.cursor.update(smoke.frame);
        await new Promise((resolve, reject) => {
          const observer = new ResizeObserver(() => {
            const actual = screen.getBoundingClientRect();
            const cached = currentCanvasRect(screen);
            if (
              cached.width !== actual.width ||
              cached.height !== actual.height ||
              cached.left !== actual.left ||
              cached.top !== actual.top
            )
              return;
            smoke.layoutDeliveries.push({
              glyphFrame,
              scale,
              cssAppliedAt,
              resizeObserverDeliveredAt: performance.now(),
              actual: actual.toJSON(),
              cached: { ...cached },
            });
            smoke.geometryReady = true;
            observer.disconnect();
            clearTimeout(timer);
            resolve();
          });
          const timer = setTimeout(() => {
            observer.disconnect();
            reject(new Error('Actual ResizeObserver delivery did not refresh shared cursor/input geometry'));
          }, 5000);
          observer.observe(screen);
        });
      };
      smoke.stopObserver = () => {
        cancelAnimationFrame(smoke.raf);
        for (const [type, listener] of smoke.listeners) screen.removeEventListener(type, listener);
      };
      window.__phase8PointerSmoke = smoke;
      return {
        atlasFrames: manifest.frames.length,
        atlasUrl: '/hd-cache/_ui/cursor/cursor.json',
        artSource: 'Actual player-owned atlas via existing Vite hd-cache plugin',
        fixtureState: frame.pointer,
        frameSize: [frame.width, frame.height],
      };
    });
    for (const [stage, frame, scale] of [
      ['software-frame-0-scale2', 0, 2],
      ['software-frame-93-scale2', 93, 2],
      ['software-frame-185-scale1', 185, 1],
    ]) {
      await ownerIdle();
      assert(frame < setup.atlasFrames);
      await page.evaluate(([frame, scale]) => window.__phase8PointerSmoke.update(frame, scale), [frame, scale]);
      const bounds = await page.locator('#screen').boundingBox();
      const center = [bounds.x + bounds.width / 2, bounds.y + bounds.height / 2];
      await page.mouse.move(...center);
      for (let i = 0; i < 80; i++) {
        const x = Math.round(bounds.x + bounds.width * (0.5 + 0.35 * Math.sin(i / 13)));
        const y = Math.round(bounds.y + bounds.height * (0.5 + 0.3 * Math.sin(i / 17 + 0.7)));
        await page.mouse.move(x, y);
        if (i === 20) await page.mouse.down();
        if (i === 45) await page.mouse.up();
        await delay(4);
      }
      // Edge clipping has an ordinary trusted event too; screenshot still contains only the owned atlas glyph.
      await page.mouse.move(Math.round(bounds.x + bounds.width - 1), Math.round(bounds.y + bounds.height - 1));
      await delay(50);
      await page.screenshot({ path: join(out, stage + '-edge.png'), scale: 'css' });
      await page.mouse.move(...center);
      await delay(50);
      await page.screenshot({ path: join(out, stage + '.png'), scale: 'css' });
    }
    await page.mouse.move(10, 10);
    await delay(50);
    const leave = await page.evaluate(() => ({ display: document.getElementById('native-page-cursor').style.display }));
    const samples = await page.evaluate(() => window.__phase8PointerSmoke.samples);
    const layoutDeliveries = await page.evaluate(() => window.__phase8PointerSmoke.layoutDeliveries);
    await writeFile(join(out, 'pointer-events.json'), JSON.stringify(samples, null, 2));
    const teardown = await page.evaluate(async () => {
      const smoke = window.__phase8PointerSmoke,
        screen = document.getElementById('screen');
      smoke.stopObserver();
      smoke.cursor.destroy();
      const restoredStyle = screen.style.getPropertyValue('cursor');
      const { createNativeCursor } = await import('/src/ui/pages/game/nativeCursor.ts');
      const missing = await createNativeCursor(screen, '/__phase8_missing_cursor');
      return {
        remainingCursorElements: document.querySelectorAll('#native-page-cursor').length,
        restoredStyle,
        restoredComputedCursor: getComputedStyle(screen).cursor,
        missingReturnsNull: missing === null,
        cursorAfterMissing: getComputedStyle(screen).cursor,
      };
    });
    await page.mouse.move(500, 500);
    await delay(50);
    await page.screenshot({ path: join(out, 'destroyed-and-missing-fallback.png'), scale: 'css' });
    const eligible = samples.filter((sample) => !sample.supersededBeforePresentation);
    const report = {
      kind: 'Explicit non-game mechanism evidence only',
      tag,
      setup,
      viewport: await page.evaluate(() => ({
        width: innerWidth,
        height: innerHeight,
        outerWidth,
        outerHeight,
        dpr: devicePixelRatio,
      })),
      browserWindow: await cdp.send('Browser.getWindowForTarget'),
      eventCount: samples.length,
      trustedEvents: samples.filter((sample) => sample.trusted).length,
      exactHandlerHotspotCount: samples.filter((sample) => sample.exactAtHandler).length,
      oneDisplayFrameOpportunities: samples.filter((sample) => sample.displayFrameDelta === 1).length,
      eligibleLatestEvents: eligible.length,
      exactLatestAtNextRaf: eligible.filter((sample) => sample.exactAtNextRaf).length,
      eventToNextRafMs: summary(samples.map((sample) => sample.nextRafAt - sample.at)),
      eventTimeStampToNextRafMs: summary(samples.map((sample) => sample.nextRafAt - sample.eventTimeStamp)),
      eventToHandlerMs: summary(samples.map((sample) => sample.at - sample.eventTimeStamp)),
      stableResizedGeometry: {
        waitingPolicy:
          'Each stream waits for actual ResizeObserver delivery and shared cursor/input cached rect equality with current DOM geometry. Earlier failed runs are preserved separately.',
        layoutDeliveries,
        stableEvents: samples.filter((sample) => sample.stableResizedGeometry).length,
        changingGeometryEvents: samples.filter((sample) => !sample.stableResizedGeometry).length,
        exactStableHandlerHotspots: samples.filter((sample) => sample.stableResizedGeometry && sample.exactAtHandler)
          .length,
        exactStableLatestAtNextRaf: eligible.filter((sample) => sample.stableResizedGeometry && sample.exactAtNextRaf)
          .length,
      },
      leave,
      teardown,
      errors,
      screenshots: [
        'software-frame-0-scale2.png',
        'software-frame-0-scale2-edge.png',
        'software-frame-93-scale2.png',
        'software-frame-93-scale2-edge.png',
        'software-frame-185-scale1.png',
        'software-frame-185-scale1-edge.png',
        'destroyed-and-missing-fallback.png',
      ],
      limitation:
        'No Wine process, game state, game-drawn cursor suppression, menu/battle art or live hotspot acceptance is represented. State and neutral screen are explicit fixtures; glyph pixels come from the player-owned atlas. Streams start only after actual ResizeObserver layout delivery, so this run concerns stable resized geometry and does not erase the transition failures of runs 01/02. All observed events remain in pointer-events.json with their geometry phase. Next-rAF observes a page display opportunity, not physical scanout. Events superseded before the next display opportunity are identified separately.',
    };
    await writeFile(join(out, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
  }
} finally {
  await browser?.close().catch(() => {});
  await server?.close().catch(() => {});
  await writeFile(
    join(out, 'cleanup.json'),
    JSON.stringify(
      {
        browserClosed: !browser?.isConnected(),
        serverClosed: true,
        peakRssBytes: process.resourceUsage().maxRSS * 1024,
      },
      null,
      2,
    ),
  );
}
