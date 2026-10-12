#!/usr/bin/env node
// Bounded real-browser inspection. Commands are private review artifacts, never guest-state writes.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile, appendFile, readdir, lstat, symlink, unlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { createConnection } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from '@playwright/test';
import { writePng, outputDirectory } from './artifacts.mjs';
import { ownerConnected } from './owner-open-boundary.mjs';
const wt = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const base = outputDirectory();
const phase = process.env.NATIVE_BROWSER_PHASE || 'phase9';
const naturalWindowDimensions = process.env.NATIVE_BROWSER_USE_WINDOW_DIMENSIONS === '1';
assert(/^phase[0-9]+$/.test(phase));
const tag = process.argv[2] || 'hidden';
const webRoute = tag.startsWith('web');
const fullWindow = tag.startsWith('full') || tag.startsWith('webfull');
const gameSpeed = process.argv[5] ?? '3';
const feelSettings = ['phase26', 'phase32', 'phase33'].includes(phase)
  ? await readFile(join(base, phase, `${tag}-settings.json`), 'utf8')
      .then(JSON.parse)
      .catch(() => ({}))
  : {};
const viewChoice = process.argv[7] ?? feelSettings.view ?? null;
assert(viewChoice === null || ['classic', 'moderate', 'wide'].includes(viewChoice), 'Use a player view choice');
const stagedFarmPattern = /^(?:phase20\/farm|phase24\/(?:[a-zA-Z0-9_-]+\/)*farm)$/;
const stagedFarmName = process.argv[6] ?? null;
assert(stagedFarmName === null || stagedFarmPattern.test(stagedFarmName), 'Use a private staged atlas farm');
const stagedFarmRoot = stagedFarmName === null ? null : resolve(base, stagedFarmName);
assert(/^[0-6]$/.test(gameSpeed), 'Game speed must use the original 0..6 scale');
assert(/^[a-zA-Z0-9_-]+$/.test(tag));
const useViewportHandshake = naturalWindowDimensions && Number(phase.slice(5)) >= 18 && !tag.startsWith('baseline');
const out = join(base, phase, tag);
await mkdir(out, { recursive: true });
// A duplicated runner request must not start a second game against the same
// artifacts and DLL backup. Evidence tags are single-use.
await writeFile(join(out, 'harness-pid'), String(process.pid) + '\n', { flag: 'wx' });
const config = JSON.parse(await readFile(join(base, 'run/owner-launch-smoke.json'), 'utf8'));
if (['phase19', 'phase26'].includes(phase) && tag.startsWith('nativeintro'))
  config.RA2_NATIVE_GAME_DIR = join(base, phase, 'native-game');
const pause = resolve(base, '../play/_slots/PAUSE');
const exists = async (p) =>
  lstat(p)
    .then(() => true)
    .catch((error) => {
      if (error.code === 'ENOENT') return false;
      throw error;
    });
if (stagedFarmRoot) assert(await exists(join(stagedFarmRoot, '_library')), 'Staged farm has no type library');
const harnessDeadline = Date.now() + 22 * 60000;
const scopeDeadline = await readFile(join(base, phase, 'deadline.json'), 'utf8')
  .then((t) => Date.parse(JSON.parse(t).deadlineAt))
  .catch(() => Infinity);
let ownerConnectionCheckedAt = 0;
let ownerConnectionActive = false;
async function ownerPlaying() {
  if (await exists(pause)) return true;
  if (Date.now() - ownerConnectionCheckedAt >= 1000) {
    ownerConnectionActive = await ownerConnected();
    ownerConnectionCheckedAt = Date.now();
  }
  return ownerConnectionActive || (await exists(pause));
}
async function ownerIdle(options = {}) {
  let held = false;
  const bounded = async () => {
    if (await exists(join(out, 'cancel'))) {
      await options.onBlocked?.();
      throw new Error('Owned acceptance cancelled');
    }
    if (Date.now() > Math.min(scopeDeadline, harnessDeadline)) {
      await options.onBlocked?.();
      throw new Error('Bounded task deadline reached');
    }
  };
  await bounded();
  if (options.isStopped?.()) return { held, stopped: true };
  while (await ownerPlaying()) {
    await bounded();
    if (options.isStopped?.()) return { held, stopped: true };
    if (!held) await options.onHeld?.();
    held = true;
    await bounded();
    await writeFile(join(out, 'held'), 'Owner playing; waiting\n');
    await delay(1000);
  }
  // The owner probe is asynchronous; cancellation may arrive while it waits.
  await bounded();
  if (options.isStopped?.()) return { held, stopped: true };
  return { held };
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
  context,
  page,
  cdp,
  logTail = '',
  url,
  cleanupPromise;
let launchStartedAtMs = null,
  mainMenuObservedAtMs = null,
  mainMenuControlsObserved = false;
let beforeBuildings = false;
let hdCacheMode = null;
let hdAtlasLayerRoute = null;
let servedFarmRoot = null;
let hdAtlasAlias = null;
let peakRss = 0;
let acceptanceRates = null;
let humanPointer = { x: 0, y: 0 };
let directMouseMove;
// Session 26 observes ordinary pointer travel, including moves made by the
// reused battle helpers. Other sessions retain their existing input protocol.
async function timedHumanMove(x, y) {
  const start = { ...humanPointer };
  const duration = (Math.hypot(x - start.x, y - start.y) / 600) * 1000;
  const steps = Math.max(1, Math.ceil(duration / 8));
  const began = performance.now();
  for (let index = 1; index <= steps; index++) {
    const due = began + (duration * index) / steps;
    if (due > performance.now()) await delay(due - performance.now());
    const fraction = index / steps;
    humanPointer = { x: start.x + (x - start.x) * fraction, y: start.y + (y - start.y) * fraction };
    await directMouseMove(humanPointer.x, humanPointer.y);
  }
}
async function humanMove(x, y, options) {
  if (['phase26', 'phase32', 'phase33'].includes(phase)) {
    const readPointer = () =>
      page.evaluate(() => {
        const canvas = document.querySelector('#screen');
        const frame = window.__phase7Presentation?.latestFrame;
        return {
          locked: !!document.pointerLockElement,
          point: window.__phase32Pointer,
          box: canvas?.getBoundingClientRect().toJSON(),
          width: frame?.width,
          height: frame?.height,
        };
      });
    let actual = await readPointer();
    if (!actual.locked || !actual.point || !actual.width || !actual.height) {
      if (phase === 'phase26') return timedHumanMove(x, y);
      humanPointer = { x, y };
      return directMouseMove(x, y, options);
    }
    const wanted = {
      x: Math.max(0, Math.min(actual.width - 1, ((x - actual.box.x) * actual.width) / actual.box.width)),
      y: Math.max(0, Math.min(actual.height - 1, ((y - actual.box.y) * actual.height) / actual.box.height)),
    };
    // CDP movement deltas under Chrome page zoom differ from its absolute CSS
    // coordinates. Observe the page's actual logical cursor between ordinary
    // trusted movements; never set or bypass the game's input coordinates.
    for (let attempt = 0; attempt < 8; attempt++) {
      const dx = ((wanted.x - actual.point.x) * actual.box.width) / actual.width;
      const dy = ((wanted.y - actual.point.y) * actual.box.height) / actual.height;
      if (Math.abs(dx) < 0.8 && Math.abs(dy) < 0.8) return;
      const target = { x: humanPointer.x + dx, y: humanPointer.y + dy };
      if (phase === 'phase26') await timedHumanMove(target.x, target.y);
      else {
        humanPointer = target;
        await directMouseMove(humanPointer.x, humanPointer.y, attempt ? undefined : options);
      }
      actual = await readPointer();
      if (!actual.locked || !actual.point) return;
    }
    return;
  }
  return directMouseMove(x, y, options);
}
async function locatorClick(locator) {
  if (phase !== 'phase26') return locator.click();
  await locator.waitFor({ state: 'visible' });
  const box = await locator.boundingBox();
  assert(box && box.width > 0 && box.height > 0, 'Visible page input target required');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  try {
    await delay(40);
  } finally {
    await page.mouse.up();
  }
}
const readBytes = (address, length) =>
  worker().evaluate(
    async ([address, length, web]) => {
      const core = globalThis.__auditCore;
      return Array.from(
        web ? core.emulator.read_memory(address, length).slice() : (await core.connection.read(address, length)).bytes,
      );
    },
    [address, length, webRoute],
  );
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
    await ownerIdle();
    const v = await fn();
    if (v) return v;
    await delay(100);
  } while (Date.now() < deadline);
  throw new Error('Timeout ' + label);
}
const worker = () => page.workers().find((w) => /vmWorker/.test(w.url()));
const state = () =>
  webRoute
    ? worker().evaluate(() => {
        const core = globalThis.__auditCore;
        const shim = core.shim;
        const windows = shim.inspectWindowState();
        const byHandle = new Map(windows.map((window) => [window.hwnd, window]));
        const items = new Map(shim.inspectControlItems().map((control) => [control.hwnd, control]));
        const controls = windows.map((window) => {
          let x = window.rect?.x ?? 0,
            y = window.rect?.y ?? 0;
          let visible = (window.style & 0x10000000) !== 0;
          let enabled = (window.style & 0x08000000) === 0;
          let parent = window.parent;
          const seen = new Set([window.hwnd]);
          while (parent && !seen.has(parent)) {
            seen.add(parent);
            const ancestor = byHandle.get(parent);
            if (!ancestor) break;
            x += ancestor.rect?.x ?? 0;
            y += ancestor.rect?.y ?? 0;
            visible &&= (ancestor.style & 0x10000000) !== 0;
            enabled &&= (ancestor.style & 0x08000000) === 0;
            parent = ancestor.parent;
          }
          const content = items.get(window.hwnd);
          return {
            hwnd: window.hwnd,
            parent: window.parent,
            id: window.id,
            class: window.className,
            text: window.text,
            visible,
            enabled,
            rect: window.rect ? [x, y, x + window.rect.width, y + window.rect.height] : null,
            ...(content ? { combo: { selection: content.selection, items: content.items } } : {}),
          };
        });
        return {
          route: 'web',
          moviePlaying: shim.inspectMoviePlayback(),
          nativeBinkPlaybackOpens: shim.nativeBinkPlaybackOpens,
          nativeBinkPlaybackActive: shim.nativeBinkPlaybackActive,
          title: shim.inspectShellPageTitle(),
          pointer: core.getPointerState(),
          modal: shim.inspectFullSizeDialogVisible(),
          fullSizeDialogVisible: shim.inspectFullSizeDialogVisible?.() ?? null,
          controls,
        };
      })
    : worker().evaluate(async () =>
        JSON.parse(new TextDecoder().decode(await globalThis.__auditCore.connection.request(14))),
      );
async function shot(label, simple = false) {
  assert(/^[a-zA-Z0-9_-]+$/.test(label));
  const path = join(out, label + '.png');
  const capture = await cdp.send('Page.captureScreenshot', {
    format: 'png',
    fromSurface: true,
    captureBeyondViewport: false,
  });
  await writeFile(path, Buffer.from(capture.data, 'base64'));
  if (simple) {
    await record('screenshot-lite', { label, path });
    return path;
  }
  if (webRoute) {
    const hd = await page.evaluate(() => {
      const h = window.__hdBridge;
      return {
        timeline: h?.timeline ?? null,
        pace: h?.pace ?? null,
        presentation: h?.presentation ?? null,
        speedRecords: window.__speedTelemetry?.records ?? [],
        ui: { enabled: h?.ui?.enabled ?? false, state: h?.ui?.state ?? null },
        canvases: [...document.querySelectorAll('canvas')].map((canvas) => ({
          id: canvas.id,
          width: canvas.width,
          height: canvas.height,
          box: canvas.getBoundingClientRect().toJSON(),
          display: getComputedStyle(canvas).display,
        })),
        filmButton: document.querySelector('#vm-skip-movie, #vm-movie-skip')?.getBoundingClientRect().toJSON() ?? null,
        movieUi: document.querySelector('#vm-movie-skip')
          ? {
              text: document.querySelector('#vm-movie-skip').textContent,
              display: getComputedStyle(document.querySelector('#vm-movie-skip')).display,
              canvasDataset: { ...document.querySelector('#screen').dataset },
            }
          : null,
        viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
      };
    });
    await writeFile(join(out, label + '-hd.json'), JSON.stringify(hd, null, 2));
    await writeFile(join(out, label + '-controls.json'), JSON.stringify(await state(), null, 2));
    await record('screenshot', { label, path, route: 'web', viewport: hd.viewport });
    return path;
  }
  const m = await import('./phase9-page-pointer-observer.mjs');
  await m.installPhase9PagePointerObserver(page);
  await m.setPhase9PointerScene(page, label);
  const pointerProof = await m.readPhase9PagePointerObserver(page, {
    worker: worker(),
    drain: true,
    inspectNative: true,
  });
  await writeFile(join(out, label + '-pointer.json'), JSON.stringify(pointerProof, null, 2));
  const native = await worker().evaluate(() => {
    const p = globalThis.__auditCore.connection.pictureDecoder.previous;
    if (!p) return null;
    const bytes = new Uint8Array(p.pixels.buffer, p.pixels.byteOffset, p.pixels.byteLength);
    let s = '';
    for (let i = 0; i < bytes.length; i += 32768) s += String.fromCharCode(...bytes.subarray(i, i + 32768));
    return { width: p.width, height: p.height, frame: p.frame, pixels: btoa(s) };
  });
  if (native) writePng(join(out, label + '-native.png'), { ...native, pixels: Buffer.from(native.pixels, 'base64') });
  const hd = await page.evaluate(() => {
    const h = window.__hdBridge;
    return h
      ? {
          timeline: h.timeline,
          presentation: h.presentation,
          passthrough: h.passthrough,
          pace: h.pace,
          activity: h.live?.activity(),
          localArtComplete: h.live?.localArtComplete,
          stalls: h.stalls,
          speedRecords: window.__speedTelemetry?.records ?? [],
          preparationNotice: (() => {
            const notice = document.querySelector('#vm-hd-status');
            if (!notice) return null;
            const style = getComputedStyle(notice);
            return {
              text: notice.textContent,
              hidden: notice.hidden,
              display: style.display,
              fontSize: style.fontSize,
              box: notice.getBoundingClientRect().toJSON(),
              language: document.documentElement.lang,
            };
          })(),
          interface: {
            moviePlaying: document.querySelector('#screen')?.dataset.moviePlaying ?? null,
            movieHint: document.querySelector('#vm-movie-skip')?.textContent ?? null,
            quickStartVisible:
              !!document.querySelector('#vm-quick-start') &&
              getComputedStyle(document.querySelector('#vm-quick-start')).display !== 'none',
          },
          canvases: [...document.querySelectorAll('canvas')].map((c) => ({
            id: c.id,
            width: c.width,
            height: c.height,
            box: c.getBoundingClientRect().toJSON(),
            display: getComputedStyle(c).display,
          })),
        }
      : null;
  });
  await writeFile(join(out, label + '-hd.json'), JSON.stringify(hd, null, 2));
  const s = await state();
  await writeFile(join(out, label + '-controls.json'), JSON.stringify(s, null, 2));
  const combat = await page.evaluate(() => {
    const state = window.__hdBridge?.diagnostics?.combatState;
    if (!state) return null;
    return {
      frame: state.frame,
      view: state.view,
      sidebar: state.sidebar,
      effects: state.effects,
      shroud: state.shroud,
    };
  });
  if (combat) {
    const owned = await worker().evaluate(async () => {
      const state = await globalThis.__auditCore.getCommandState();
      return { frame: state?.frame, objects: state?.objects.filter((object) => object.owner === state.localHouse) };
    });
    await writeFile(join(out, label + '-combat.json'), JSON.stringify({ ...combat, owned }));
  }
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
      display: {
        width: screen.width,
        height: screen.height,
        availableWidth: screen.availWidth,
        availableHeight: screen.availHeight,
        availableLeft: screen.availLeft,
        availableTop: screen.availTop,
      },
      visualViewport: window.visualViewport
        ? {
            width: visualViewport.width,
            height: visualViewport.height,
            scale: visualViewport.scale,
            offsetLeft: visualViewport.offsetLeft,
            offsetTop: visualViewport.offsetTop,
          }
        : null,
      canvasBacking: {
        width: document.querySelector('#screen')?.width,
        height: document.querySelector('#screen')?.height,
      },
      fullscreen: !!document.fullscreenElement,
      screenBox: document.querySelector('#screen')?.getBoundingClientRect().toJSON(),
    })),
  });
  return path;
}
async function point(x, y) {
  const b = await page.locator('#screen').boundingBox();
  const s = await worker().evaluate(
    (web) => (web ? globalThis.__auditCore.getPointerState() : globalThis.__auditCore.hello.surface),
    webRoute,
  );
  return [b.x + (x * b.width) / s.width, b.y + (y * b.height) / s.height];
}
async function click(x, y, button = 'left') {
  const [px, py] = await point(x, y);
  await ownerIdle();
  await page.mouse.move(px, py);
  await ownerIdle();
  await page.mouse.down({ button });
  try {
    await delay(40);
  } finally {
    // Releases remain allowed after cancellation so an owned press cannot stick.
    await page.mouse.up({ button });
  }
}
const usable = (c) => c.visible && c.enabled && c.rect?.[2] > c.rect?.[0];
async function execute(c) {
  if (c.action === 'close') return { closing: true };
  await ownerIdle();
  if (['phase26', 'phase33'].includes(phase)) await page.bringToFront();
  if (c.action === 'feel-start') {
    if (c.hdOnly)
      await wait('visible HD scene', () => page.evaluate(() => !!window.__hdBridge?.diagnostics?.shown), 60000);
    const { installPhase7InputProbe } = await import('./phase7-input-stream.mjs');
    await installPhase7InputProbe(page);
    await page.evaluate(() => {
      const probe = {
        startedAt: performance.now(),
        frames: [],
        animationFrames: [],
        pointer: [],
        tasks: [],
        gaps: [],
        previous: null,
        previousAnimationFrame: null,
      };
      const animate = (at) => {
        if (probe.previousAnimationFrame !== null) probe.animationFrames.push(at - probe.previousAnimationFrame);
        probe.previousAnimationFrame = at;
        probe.raf = requestAnimationFrame(animate);
      };
      probe.raf = requestAnimationFrame(animate);
      probe.present = (route) => {
        const at = performance.now();
        if (probe.previous !== null) {
          const gap = at - probe.previous;
          probe.frames.push(gap);
          if (gap > 25)
            probe.gaps.push({ at, gapMs: gap, route, activity: window.__hdBridge?.live?.activity?.() ?? null });
        }
        probe.previous = at;
      };
      const pointer = (event) => {
        const at = performance.now();
        requestAnimationFrame(() =>
          probe.pointer.push({
            handlerMs: at - event.timeStamp,
            nextPaintOpportunityMs: performance.now() - event.timeStamp,
          }),
        );
      };
      document.addEventListener('pointermove', pointer, { passive: true });
      const observer = new PerformanceObserver((entries) => {
        for (const task of entries.getEntries())
          probe.tasks.push({ startTime: task.startTime, duration: task.duration, name: task.name });
      });
      observer.observe({ entryTypes: ['longtask'] });
      probe.stop = () => {
        document.removeEventListener('pointermove', pointer);
        observer.disconnect();
        cancelAnimationFrame(probe.raf);
      };
      window.__phase32Feel = probe;
    });
    return execute({ action: 'rates-start', label: c.label ?? 'feel-rates' });
  }
  if (c.action === 'feel-stop') {
    const rates = await execute({ action: 'rates-stop', label: c.label ?? 'feel-rates' });
    const evidence = await page.evaluate(() => {
      const p = window.__phase32Feel;
      p.stop();
      const values = [...p.frames].sort((a, b) => a - b);
      const percentile = (f) => (values.length ? values[Math.ceil(values.length * f) - 1] : null);
      const result = {
        source: 'Actual completed visible HD draws or classic presenter draws; browser scanout is not instrumented',
        seconds: (performance.now() - p.startedAt) / 1000,
        intervals: {
          n: values.length,
          p50: percentile(0.5),
          p95: percentile(0.95),
          p99: percentile(0.99),
          over25: values.filter((v) => v > 25).length,
          over50: values.filter((v) => v > 50).length,
          over100: values.filter((v) => v > 100).length,
        },
        pointer: p.pointer,
        longTasks: p.tasks,
        gaps: p.gaps,
        animationFrameIntervals: p.animationFrames,
        focused: document.hasFocus(),
        visible: !document.hidden,
        notice: document.querySelector('#display-refresh-notice')?.textContent ?? null,
        pace: window.__hdBridge?.pace ?? null,
        stalls: window.__hdBridge?.stalls ?? null,
        telemetry: window.__feelTelemetry?.records ?? null,
        viewport: {
          width: innerWidth,
          height: innerHeight,
          dpr: devicePixelRatio,
          screen: { width: screen.width, height: screen.height },
        },
      };
      delete window.__phase32Feel;
      return result;
    });
    await writeFile(
      join(out, `${c.label ?? 'feel'}-measurements.json`),
      JSON.stringify({ ...evidence, rates }, null, 2),
    );
    return { ...evidence, pointer: { count: evidence.pointer.length }, gaps: { count: evidence.gaps.length }, rates };
  }
  if (c.action === 'feel-edges') {
    const proof = [];
    for (const edge of ['left', 'right', 'top', 'bottom']) {
      const box = await page.locator('#screen').boundingBox();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 40 });
      const before = await worker().evaluate(() => globalThis.__auditCore.getCommandState());
      const target = {
        left: [box.x - 80, box.y + box.height / 2],
        right: [box.x + box.width + 80, box.y + box.height / 2],
        top: [box.x + box.width / 2, box.y - 80],
        bottom: [box.x + box.width / 2, box.y + box.height + 80],
      }[edge];
      await page.mouse.down();
      try {
        await page.mouse.move(...target, { steps: 80 });
        await delay(600);
        const observation = await page.evaluate(() => ({
          locked: !!document.pointerLockElement,
          pointer: window.__phase7InputProbe?.latest,
          cursor: document.querySelector('#native-page-cursor')?.getBoundingClientRect().toJSON(),
        }));
        const after = await worker().evaluate(() => globalThis.__auditCore.getCommandState());
        const screenshot = await shot(`${c.label ?? 'drag'}-${edge}`);
        let originalScreenshot = null;
        if (['phase26', 'phase33'].includes(phase)) {
          await page.keyboard.press('\\');
          await delay(300);
          originalScreenshot = await shot(`${c.label ?? 'drag'}-${edge}-original`);
          await page.keyboard.press('\\');
        }
        proof.push({ edge, before: before?.view, after: after?.view, observation, screenshot, originalScreenshot });
      } finally {
        await page.mouse.up();
      }
      if (['phase26', 'phase33'].includes(phase)) {
        await delay(600);
        await shot(`${c.label ?? 'drag'}-${edge}-released`);
      }
    }
    await writeFile(join(out, `${c.label ?? 'drag'}-edges.json`), JSON.stringify(proof, null, 2));
    return proof;
  }
  if (c.action === 'feel-play') {
    const began = performance.now();
    const seconds = Math.max(1, Math.min(c.seconds ?? 300, 600));
    let nextAction = 0,
      actions = 0;
    while (performance.now() - began < seconds * 1000) {
      await ownerIdle();
      const box = await page.locator('#screen').boundingBox();
      const segmentStart = performance.now();
      while (performance.now() - segmentStart < 1200) {
        const t = (performance.now() - began) / 1000;
        await cdp.send('Input.dispatchMouseEvent', {
          type: 'mouseMoved',
          x: box.x + box.width * (0.42 + 0.23 * Math.sin(t * 1.3)),
          y: box.y + box.height * (0.48 + 0.25 * Math.cos(t * 0.9)),
          buttons: 0,
        });
        humanPointer = {
          x: box.x + box.width * (0.42 + 0.23 * Math.sin(t * 1.3)),
          y: box.y + box.height * (0.48 + 0.25 * Math.cos(t * 0.9)),
        };
        await delay(8);
      }
      if (performance.now() >= nextAction) {
        const keys = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'];
        await page.keyboard.down(keys[actions % keys.length]);
        await delay(300);
        await page.keyboard.up(keys[actions % keys.length]);
        if (actions % 4 === 0) await shot(`feel-playing-${actions}`, true);
        actions++;
        nextAction = performance.now() + 12000;
      }
    }
    return { seconds: (performance.now() - began) / 1000, scrollActions: actions };
  }
  if (c.action === 'rates-start') {
    assert(['phase26', 'phase32', 'phase33'].includes(phase) && !acceptanceRates, 'One owned match observer required');
    const { startPhase10MatchRates } = await import('./phase10-match-rates.mjs');
    acceptanceRates = await startPhase10MatchRates({
      page,
      out,
      record,
      label: c.label ?? 'played-match',
      externallyDismissedDialogs: true,
      readNativeLogicEndpoint: () =>
        worker().evaluate(async (web) => {
          const core = globalThis.__auditCore;
          const bytes = web
            ? core.emulator.read_memory(0xa8ed84, 4).slice()
            : (await core.connection.read(0xa8ed84, 4)).bytes;
          if (bytes.byteLength !== 4) throw new Error('Incomplete actual game frame counter');
          return {
            frame: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, true),
            atMs: performance.now(),
            timeOrigin: performance.timeOrigin,
            clockContext: 'worker',
            fresh: true,
            source: web ? 'Read-only actual v86 guest frame counter' : 'Direct validated native frame counter reply',
          };
        }, webRoute),
    });
    await acceptanceRates.inputCheckpoint('start', {
      label: c.label ?? 'played-match',
      rate: null,
      input: 'Continuous time-paced pointer paths and ordinary played actions; not a fixed-rate stress stream',
    });
    return { observing: true };
  }
  if (c.action === 'rates-stop') {
    assert(
      ['phase26', 'phase32', 'phase33'].includes(phase) && acceptanceRates,
      'Owned played-match observer required',
    );
    await acceptanceRates.inputCheckpoint('end', { completed: c.completed !== false });
    const result = await acceptanceRates.stop();
    acceptanceRates = null;
    const transitions = await page.evaluate(() => window.__hdBridge?.timeline ?? null);
    await writeFile(join(out, (c.label ?? 'played-match') + '-transitions.json'), JSON.stringify(transitions, null, 2));
    return { ...result, transitions };
  }
  if (c.action === 'hd-atlas-layer') {
    assert(
      typeof c.layer === 'string' && stagedFarmPattern.test(c.layer),
      'Atlas comparison layers must be staged farms under the private output directory',
    );
    const layerRoot = resolve(base, c.layer);
    assert(await exists(join(layerRoot, '_library')), 'Staged atlas layer has no type library');
    assert(servedFarmRoot?.startsWith(base + '/'), 'Atlas comparison requires a served private farm');
    const theater = await page.evaluate(() => window.__hdBridge?.live?.library?.library.theater);
    assert(typeof theater === 'string' && /^[a-z]+$/.test(theater), 'A loaded live theatre is required');
    const selectedLibrary = JSON.parse(await readFile(join(layerRoot, '_library', theater, 'library.json'), 'utf8'));
    const refs = selectedLibrary.spriteAtlasesHd;
    assert(Array.isArray(refs), 'Staged type library has no HD atlas references');
    const types = c.types ?? ['CAOILD', 'CAAIRP', 'CATEXS03', 'GACNST', 'GAPOWR', 'GAPILE', 'NAPOWR'];
    assert(
      Array.isArray(types) && types.length && types.every((type) => /^[A-Z0-9_]+$/.test(type)),
      'Building type IDs required',
    );
    const targets = types.map((id) => {
      const type = selectedLibrary.types[id];
      assert(type?.kind === 'building' && type.sprite, `Staged building ${id} is missing`);
      const sprites = [type.sprite, type.building?.bib, type.building?.buildup, type.deployingAnim];
      for (const layer of type.building?.layers ?? []) sprites.push(layer.sprite, layer.damagedSprite);
      const pages = new Set();
      for (const name of sprites.filter(Boolean)) {
        const sprite = selectedLibrary.sprites[name];
        assert(sprite, `Staged building sprite ${name} is missing`);
        for (const frame of sprite.frames) if (frame.rect[2] > 0 && frame.rect[3] > 0) pages.add(frame.page ?? 0);
      }
      assert(pages.size, `Staged building ${id} has no foreground frames`);
      const standing = selectedLibrary.sprites[type.sprite].frames[0];
      assert(standing?.rect[2] > 0 && standing.rect[3] > 0, `Staged building ${id} has no standing frame`);
      return { id, standingPage: standing.page ?? 0, pages: [...pages].sort((a, b) => a - b) };
    });
    const pages = [...new Set(targets.flatMap((target) => target.pages))].sort((a, b) => a - b);
    if (hdAtlasAlias) await unlink(hdAtlasAlias);
    const aliasName = `.native-atlas-${tag}`;
    hdAtlasAlias = join(servedFarmRoot, aliasName);
    await symlink(layerRoot, hdAtlasAlias, 'dir');
    if (hdAtlasLayerRoute) await page.context().unroute('**/hd-cache/**', hdAtlasLayerRoute);
    hdAtlasLayerRoute = async (route) => {
      const resource = new URL(route.request().url());
      const pathname = decodeURIComponent(resource.pathname);
      const prefix = '/hd-cache/';
      if (!pathname.startsWith(prefix) || !pathname.endsWith('.png')) return route.fallback();
      const file = resolve(layerRoot, pathname.slice(prefix.length));
      if (!file.startsWith(layerRoot + '/')) return route.fulfill({ status: 400, body: 'Invalid staged asset path' });
      // The existing cache server streams the staged page; large PNGs never cross Playwright's fulfilment channel.
      resource.pathname = `${prefix}${aliasName}/${pathname.slice(prefix.length)}`;
      return route.continue({ url: resource.href });
    };
    await page.context().route('**/hd-cache/**', hdAtlasLayerRoute);
    const proof = await page.evaluate(
      async ({ layer, refs, pages, targets }) => {
        const live = window.__hdBridge?.live;
        const library = live?.library;
        if (!live || !library?.hdPages || !library.uploadPage)
          throw new Error('A loaded live type library is required');
        const loaded = (index) => {
          const atlas = library.hdPages.get(index);
          return !!atlas && typeof atlas === 'object' && !!atlas.color && !!atlas.remap;
        };
        for (const target of targets) {
          const atlas = library.hdPages.get(target.standingPage);
          if (!atlas || typeof atlas !== 'object' || !atlas.color || !atlas.remap)
            throw new Error(`Standing body of ${target.id} is not loaded (atlas ${target.standingPage})`);
        }
        const loadedPages = pages.filter(loaded);
        const deferred = pages
          .filter((index) => !loaded(index))
          .map((index) => ({
            index,
            state: typeof library.hdPages.get(index) === 'string' ? library.hdPages.get(index) : 'not requested',
          }));
        const { withDecodedPage } = await import('/packages/hd-renderer/src/pageUpload.ts');
        const stamp = Date.now();
        const previousRefs = library.library.spriteAtlasesHd;
        for (let index = 0; index < previousRefs.length; index++) {
          const before = previousRefs[index];
          const after = refs[index];
          if (!before && !after) continue;
          if (
            !before ||
            !after ||
            before.width !== after.width ||
            before.height !== after.height ||
            before.scale !== after.scale
          )
            throw new Error(`Staged atlas ${index} changes geometry`);
        }
        const updated = [];
        const upload = library.uploadPage;
        // Existing materials keep their Texture objects; the view's gate bounds sequential page uploads.
        for (const index of loadedPages) {
          const atlas = library.hdPages.get(index);
          const ref = refs[index];
          for (const [texture, file] of [
            [atlas.color, ref.file],
            [atlas.remap, ref.remap],
          ]) {
            const asset = await fetch(`${library.base}/${file}?native-atlas-layer=${stamp}`);
            if (!asset.ok) throw new Error(`Staged atlas ${file}: HTTP ${asset.status}`);
            await withDecodedPage(await asset.blob(), upload, async (bitmap) => {
              if (bitmap.width !== ref.width || bitmap.height !== ref.height) {
                bitmap.close();
                throw new Error(`Staged atlas ${file} changes dimensions`);
              }
              texture.image = bitmap;
              texture.needsUpdate = true;
              try {
                await upload(texture);
              } finally {
                bitmap.close();
                texture.image = { width: ref.width, height: ref.height };
              }
            });
          }
          updated.push({ index, file: ref.file, remap: ref.remap, width: ref.width, height: ref.height });
        }
        library.library.spriteAtlasesHd = refs;
        library.revision++;
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        return {
          layer,
          theater: library.library.theater,
          targets,
          deferred,
          scope:
            'Standing-building comparison; unloaded animation and rubble pages use the selected route when requested.',
          updated,
          activity: live.activity(),
          presentation: window.__hdBridge.presentation,
        };
      },
      { layer: c.layer, refs, pages, targets },
    );
    await record('hd-atlas-layer', proof);
    await delay(c.wait ?? 700);
    if (c.label) await shot(c.label);
    return proof;
  }
  if (c.action === 'hd-cache-mode') {
    if (hdCacheMode) await page.context().unroute('**/hd-cache/**', hdCacheMode);
    hdCacheMode =
      c.mode === 'normal'
        ? null
        : async (route) => {
            if (!c.match || route.request().url().includes(c.match)) {
              if (c.mode === 'fail')
                return route.fulfill({ status: 503, body: 'Deliberate cache failure for acceptance' });
              await delay(c.delayMs ?? 15000);
            }
            return route.continue();
          };
    if (hdCacheMode) await page.context().route('**/hd-cache/**', hdCacheMode);
    else await cdp.send('Network.setCacheDisabled', { cacheDisabled: false });
    return { mode: c.mode, match: c.match, delayMs: c.delayMs };
  }
  if (c.action === 'preparation-state') return worker().evaluate(() => globalThis.__auditCore.getRenderPreparation());
  if (c.action === 'launcher-stop-notice') {
    const label = c.label ?? 'launcher-closed';
    assert(/^[a-zA-Z0-9_-]+$/.test(label));
    assert(privateDir, 'Owned launcher private directory required');
    await writeFile(join(privateDir, 'stop'), 'stop\n', { mode: 0o600 });
    try {
      await wait(
        'Chinese normal close notice',
        () =>
          page
            .locator('.game-folder-panel h3')
            .filter({ hasText: /^游戏已关闭$/ })
            .isVisible(),
        15000,
      );
    } catch (error) {
      // Retain the actual failure surface before cleanup closes the tab. A
      // clean process exit cannot substitute for this missing UI acceptance.
      const capture = await cdp.send('Page.captureScreenshot', {
        format: 'png',
        fromSurface: true,
        captureBeyondViewport: false,
      });
      const screenshot = join(out, label + '-failed.png');
      await writeFile(screenshot, Buffer.from(capture.data, 'base64'));
      const nativeWorker = worker();
      const core = nativeWorker
        ? await nativeWorker
            .evaluate(() => {
              const core = globalThis.__auditCore;
              return core
                ? {
                    phase: core.phase,
                    running: core.running,
                    failing: core.failing,
                    closed: core.closed,
                    mirrorWaiters: core.waiters.size,
                    connectionClosed: core.connection.closed,
                    socketReadyState: core.connection.socket?.readyState ?? null,
                    pendingRequests: core.connection.pending.size,
                  }
                : null;
            })
            .catch((error) => ({ unavailable: String(error) }))
        : null;
      const proof = {
        screenshot,
        core,
        page: await page.evaluate(() => ({
          panels: [...document.querySelectorAll('.game-folder-panel')].map((panel) => panel.textContent),
          canvasStatus: document.querySelector('#screen')?.dataset.vmStatus ?? null,
          fullscreen: document.fullscreenElement?.id ?? null,
        })),
        sessionState: await readFile(join(privateDir, 'session-state.json'), 'utf8').catch(() => null),
        gameStatus: await readFile(join(privateDir, 'status.json'), 'utf8').catch(() => null),
        source: 'Actual timed-out close UI and read-only current Worker/launcher state; failure remains a failure',
      };
      await writeFile(join(out, label + '-failed.json'), JSON.stringify(proof, null, 2));
      await record('normal-close-notice-failure', proof);
      throw error;
    }
    const text = await page.locator('.game-folder-panel').innerText();
    assert(text.includes('请重新运行启动器'), 'Launcher restart instruction required');
    assert(!/Runtime error|Native WebSocket closed|运行错误/.test(text), 'Normal close must not show an error');
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await delay(250);
    const presentation = await page.locator('.game-folder-panel').evaluate((panel) => {
      const bounds = panel.getBoundingClientRect();
      const middle = document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
      const style = getComputedStyle(panel);
      return {
        bounds: bounds.toJSON(),
        innerWidth,
        innerHeight,
        fullscreen: document.fullscreenElement?.id ?? null,
        display: style.display,
        visibility: style.visibility,
        opacity: style.opacity,
        insideViewport: bounds.x >= 0 && bounds.y >= 0 && bounds.right <= innerWidth && bounds.bottom <= innerHeight,
        centerBelongsToPanel: !!middle && panel.contains(middle),
      };
    });
    const capture = await cdp.send('Page.captureScreenshot', {
      format: 'png',
      fromSurface: true,
      captureBeyondViewport: false,
    });
    const screenshot = join(out, label + '.png');
    await writeFile(screenshot, Buffer.from(capture.data, 'base64'));
    await delay(250);
    const settledCapture = await cdp.send('Page.captureScreenshot', {
      format: 'png',
      fromSurface: true,
      captureBeyondViewport: false,
    });
    const settledScreenshot = join(out, label + '-settled.png');
    await writeFile(settledScreenshot, Buffer.from(settledCapture.data, 'base64'));
    const exit = await Promise.race([launchExit, delay(18000).then(() => ({ timeout: true }))]);
    const proof = {
      text,
      screenshot,
      settledScreenshot,
      presentation,
      exit,
      source: 'Actual owned launcher stop and browser-rendered notice',
    };
    await writeFile(join(out, label + '.json'), JSON.stringify(proof, null, 2));
    assert(
      presentation.insideViewport && presentation.centerBelongsToPanel,
      'Close notice must reach the painted viewport',
    );
    return proof;
  }
  if (c.action === 'window-fullscreen') {
    const owned = await cdp.send('Browser.getWindowForTarget');
    await ownerIdle();
    await cdp.send('Browser.setWindowBounds', { windowId: owned.windowId, bounds: { windowState: 'fullscreen' } });
    await delay(1000);
    return shot(c.label ?? 'window-fullscreen');
  }
  if (c.action === 'fullscreen') {
    if (await page.evaluate(() => !!document.fullscreenElement)) return shot(c.label ?? 'fullscreen');
    const toggle = page.locator('#vm-controls-toggle');
    if ((await toggle.getAttribute('aria-expanded')) !== 'true') {
      await ownerIdle();
      await locatorClick(toggle);
    }
    await ownerIdle();
    await locatorClick(page.locator('#vm-fullscreen'));
    await wait('actual page fullscreen', () => page.evaluate(() => !!document.fullscreenElement));
    return shot(c.label ?? 'fullscreen');
  }
  if (c.action === 'pointer-observe') {
    const m = await import('./phase9-page-pointer-observer.mjs');
    await m.installPhase9PagePointerObserver(page);
    if (c.label) await m.setPhase9PointerScene(page, c.label);
    const proof = await m.readPhase9PagePointerObserver(page, {
      worker: worker(),
      drain: c.drain ?? true,
      inspectNative: true,
    });
    if (c.label) await writeFile(join(out, c.label + '-pointer.json'), JSON.stringify(proof, null, 2));
    return proof;
  }
  if (c.action === 'menu-feedback') {
    const m = await import('./phase9-menu-feedback.mjs');
    await mkdir(join(out, 'menu-feedback'), { recursive: true });
    return m.measurePhase9MenuFeedback({
      page,
      point,
      state,
      wait,
      out: join(out, 'menu-feedback'),
      record,
      ownerIdle,
      count: 30,
    });
  }
  if (c.action === 'command-state') return worker().evaluate(() => globalThis.__auditCore.getCommandState());
  if (c.action === 'scale-proof') {
    assert(typeof c.label === 'string' && /^[a-zA-Z0-9_-]+$/.test(c.label), 'A screenshot label is required');
    let command = await worker().evaluate(() => globalThis.__auditCore.getCommandState());
    assert(command?.view && command.sidebar, 'A real battle with its native sidebar is required');
    const tab = command.sidebar.layout.tabs[0];
    if (command.sidebar.activeTab !== 0) {
      await click(tab.x + tab.width / 2, tab.y + tab.height / 2);
      command = await wait('building sidebar tab', async () => {
        const next = await worker().evaluate(() => globalThis.__auditCore.getCommandState());
        return next?.sidebar?.activeTab === 0 ? next : null;
      });
    }
    const projectionFactor = await worker().evaluate(async (web) => {
      const core = globalThis.__auditCore;
      const bytes = web
        ? core.emulator.read_memory(0xb0cd48, 8).slice()
        : (await core.connection.read(0xb0cd48, 8)).bytes;
      return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getFloat64(0, true);
    }, webRoute);
    const frame = command.sidebar.frame;
    const layout = command.sidebar.layout;
    const tactical = {
      x: layout.sidebar.x === 0 ? layout.sidebar.width : 0,
      y: 0,
      width: frame.width - layout.sidebar.width,
      height: layout.commandBar?.y ?? frame.height,
    };
    const project = (object) => ({
      x: Math.trunc((30 * (object.x - object.y)) / 256) - command.view.x,
      y:
        Math.trunc((15 * (object.x + object.y)) / 256) -
        Math.trunc(object.z * projectionFactor + (object.z >= 728 ? 1 : 0) + 0.5) -
        command.view.y,
    });
    const owned = command.objects.filter((object) => object.owner === command.localHouse && object.health > 0);
    const onScreen = (object) => {
      const p = project(object);
      return p.x > tactical.x + 30 && p.x < tactical.x + tactical.width - 30 && p.y > 50 && p.y < tactical.height - 30;
    };
    const targets = [
      [
        'building',
        owned.find((object) => /^(GAWEAP|NAWEAP|YAWEAP)$/.test(object.type) && onScreen(object)) ??
          owned.find((object) => object.kind === 'building' && onScreen(object)),
      ],
      ['infantry', owned.find((object) => object.kind === 'infantry' && onScreen(object))],
      ['tank', owned.find((object) => /^(MTNK|HTNK|LTNK)$/.test(object.type) && onScreen(object))],
    ].map(([category, object]) => ({ category, object: object ?? null, point: object ? project(object) : null }));
    // Move away from every scroll edge and leave the actual page-drawn pointer in this full-page capture.
    const pointer = { x: Math.round(tactical.x + tactical.width * 0.58), y: Math.round(tactical.height * 0.5) };
    await page.mouse.move(...(await point(pointer.x, pointer.y)));
    await delay(400);
    const screen = await page.evaluate(() => ({
      box: document.querySelector('#screen').getBoundingClientRect().toJSON(),
      dpr: devicePixelRatio,
      width: innerWidth,
      height: innerHeight,
      pointer: [...document.querySelectorAll('canvas')]
        .filter((canvas) => /cursor|pointer/.test(canvas.id))
        .map((canvas) => ({
          id: canvas.id,
          width: canvas.width,
          height: canvas.height,
          box: canvas.getBoundingClientRect().toJSON(),
        })),
    }));
    const cells = await worker().evaluate(
      async ({ web, tactical }) => {
        const core = globalThis.__auditCore;
        const render = await core.getRenderState();
        const shroud = render?.shroud;
        let centers = 0,
          unshrouded = 0;
        if (shroud && render.view) {
          for (let index = 0; index < shroud.cells.length; index++) {
            if (shroud.cells[index] === 255) continue;
            const x = shroud.originX + (index % shroud.width);
            const y = shroud.originY + Math.floor(index / shroud.width);
            const px = 30 * (x - y) - render.view.x;
            const py = 15 * (x + y) - render.view.y;
            if (
              px >= tactical.x &&
              px < tactical.x + tactical.width &&
              py >= tactical.y &&
              py < tactical.y + tactical.height
            ) {
              centers++;
              if (shroud.cells[index] > 0) unshrouded++;
            }
          }
        }
        return {
          map: render?.map,
          view: render?.view,
          centers: shroud ? centers : null,
          unshrouded: shroud ? unshrouded : null,
          definition:
            'Actual map cells whose level-zero projected centers lie inside the tactical rectangle; elevation and partial boundary diamonds are not counted',
        };
      },
      { web: webRoute, tactical },
    );
    const physical = (rect) => ({
      x: Math.round((screen.box.x + (rect.x * screen.box.width) / frame.width) * screen.dpr),
      y: Math.round((screen.box.y + (rect.y * screen.box.height) / frame.height) * screen.dpr),
      width: Math.round(((rect.width * screen.box.width) / frame.width) * screen.dpr),
      height: Math.round(((rect.height * screen.box.height) / frame.height) * screen.dpr),
    });
    const cropRects = targets.map(({ category, object, point: p }) => ({
      category,
      object,
      rect: p
        ? physical(
            category === 'building'
              ? { x: p.x - 125, y: p.y - 155, width: 250, height: 190 }
              : category === 'tank'
                ? { x: p.x - 45, y: p.y - 55, width: 90, height: 85 }
                : { x: p.x - 22, y: p.y - 55, width: 44, height: 70 },
          )
        : null,
    }));
    cropRects.push({
      category: 'sidebar',
      rect: physical({
        x: layout.strip.x,
        y: layout.strip.y,
        width: layout.cameoPitch.x * 2,
        height: layout.cameoPitch.y * 2,
      }),
    });
    cropRects.push({
      category: 'pointer',
      rect: physical({ x: pointer.x - 15, y: pointer.y - 15, width: 65, height: 65 }),
    });
    const screenshot = await shot(c.label);
    const proof = {
      screenshot,
      viewChoice,
      logicalFrame: frame,
      tactical,
      mapCells: cells,
      sidebarRows: Math.floor((frame.height - layout.strip.y - (layout.stripReserve ?? 0)) / layout.cameoPitch.y),
      sidebar: command.sidebar,
      view: command.view,
      localHouse: command.localHouse,
      owned: owned.map(({ uid, type, kind, x, y, z }) => ({ uid, type, kind, x, y, z })),
      devicePixelsPerGamePixel: {
        x: (screen.box.width * screen.dpr) / frame.width,
        y: (screen.box.height * screen.dpr) / frame.height,
      },
      screen,
      cropRects,
      cropContract: 'Coordinates in the full-page PNG device pixels; crop without resampling or enhancement',
    };
    await writeFile(join(out, c.label + '-scale.json'), JSON.stringify(proof, null, 2));
    await record('scale-proof', proof);
    return proof;
  }
  if (c.action === 'render-state') return worker().evaluate(() => globalThis.__auditCore.getRenderState());
  if (c.action === 'overlay-state') {
    assert(!webRoute, 'Overlay observations currently require the native route');
    const iterations = c.iterations ?? 1;
    assert(Number.isInteger(iterations) && iterations >= 1 && iterations <= 500);
    return worker().evaluate(async (iterations) => {
      const core = globalThis.__auditCore;
      const state = await core.getRenderState();
      const { createYrBattlefieldOverlayReader } = await import('/src/games/yr/battlefieldOverlayReader.ts');
      const reader = createYrBattlefieldOverlayReader(() => core.memory.accessor(), core.hello.exe.sha256);
      if (!reader) throw new Error('Current executable does not validate the overlay reader');
      const samples = [];
      let failed = 0;
      let last = null;
      for (let index = 0; index < iterations; index++) {
        const value = reader();
        if (!value) failed++;
        else {
          samples.push(value.readerMs);
          last = value;
        }
      }
      samples.sort((a, b) => a - b);
      return {
        scope:
          'Repeated read-only measurements of the actual selected objects in one live mirror snapshot; not a match-rate measurement',
        iterations,
        failed,
        mirrorFrame: core.memory.frame,
        readerError: core.render?.error ?? null,
        published: state?.battlefieldOverlay ?? null,
        observed: last,
        timingMs: {
          mean: samples.length ? samples.reduce((a, b) => a + b, 0) / samples.length : null,
          p95: samples.length ? samples[Math.ceil(samples.length * 0.95) - 1] : null,
          max: samples.at(-1) ?? null,
        },
      };
    }, iterations);
  }
  if (c.action === 'ending-checkpoint') {
    const m = await import('./phase11-endings.mjs');
    return m.capturePhase11EndingCheckpoint({
      page,
      worker,
      inputState: state,
      shot,
      record,
      ownerIdle,
      out,
      label: c.label,
      expectedScreen: c.expectedScreen,
      compareWith: c.compareWith,
    });
  }
  if (c.action === 'abort-observe') {
    const st = await state();
    const yes = st.controls.find((v) => usable(v) && v.id === 1737);
    assert(yes, 'Actual Abort confirmation Yes required');
    const m = await import('./phase9-abort-observer.mjs');
    const proof = await m.observePhase9Abort({
      page,
      clickYes: () => click((yes.rect[0] + yes.rect[2]) / 2, (yes.rect[1] + yes.rect[3]) / 2),
      out,
      record,
      label: c.label ?? 'abort',
    });
    await shot((c.label ?? 'abort') + '-settled');
    return proof;
  }
  if (c.action === 'paint-audit') {
    const m = await import('./phase9-paint-audit.mjs');
    const proof = await m.inspect(worker(), { ids: c.ids });
    await writeFile(join(out, c.label + '-paint-audit.json'), JSON.stringify(proof, null, 2));
    return proof;
  }
  if (c.action === 'map-inspect') {
    const m = await import('./phase9-native-maps.mjs');
    return m.inspectPhase9NativeMaps({ page, point, state, click, shot, wait, out, record, ownerIdle });
  }
  if (c.action === 'scout') {
    const m = await import('./browser-combat-scout.mjs');
    return m.scoutForCombat({
      page,
      click: (x, y, mode, button) => click(x, y, button ?? 'left'),
      point,
      commandState: async () => {
        await ownerIdle();
        return worker().evaluate(() => globalThis.__auditCore.getCommandState());
      },
      readBytes,
      record,
      shot,
    });
  }
  if (c.action === 'attack-visible' || c.action === 'fight-to-victory') {
    const { attackVisibleEnemyBuilding } = await import('./browser-combat-attack.mjs');
    const current = await worker().evaluate(() => globalThis.__auditCore.getCommandState());
    assert(current?.localHouse >= 0 && current.localHouse <= 5, 'Actual six-player local house required');
    const vector = Buffer.from(await readBytes(0xa80228, 20));
    assert(vector.readInt32LE(16) > current.localHouse, 'Actual house vector required');
    const house = Buffer.from(await readBytes(vector.readUInt32LE(4) + current.localHouse * 4, 4)).readUInt32LE();
    const mask = Buffer.from(await readBytes(house + 0x5788, 4)).readUInt32LE();
    return attackVisibleEnemyBuilding({
      page,
      point,
      click: (x, y, mode, button) => click(x, y, button ?? 'left'),
      shot,
      record,
      readBytes,
      commandState: async () => {
        await ownerIdle();
        return worker().evaluate(() => globalThis.__auditCore.getCommandState());
      },
      combatUnits: true,
      selectedGroup: c.action === 'fight-to-victory' || c.selectedGroup === true,
      seconds: c.seconds ?? 600,
      inputState: state,
      ownerIdle,
      alliedHouses: Array.from({ length: 6 }, (_, index) => index).filter((index) => mask & (1 << index)),
    });
  }
  if (c.action === 'base-play') {
    const m = await import('./phase9-base-play.mjs');
    return m.runPhase9BasePlay({
      buildOnly: c.buildOnly ?? false,
      stopAfter: c.stopAfter ?? null,
      page,
      click: (x, y, mode, button) => click(x, y, button ?? 'left'),
      point,
      commandState: () => worker().evaluate(() => globalThis.__auditCore.getCommandState()),
      readBytes,
      inputState: state,
      shot,
      record,
      wait,
      ownerIdle,
    });
  }

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
  if (c.action === 'move') {
    const p = await point(c.x, c.y);
    await page.mouse.move(...p);
    await delay(c.wait ?? 300);
    return c.label ? shot(c.label) : state();
  }
  if (c.action === 'drag') {
    const a = await point(c.x, c.y),
      b = await point(c.toX, c.toY);
    await page.mouse.move(...a);
    await page.mouse.down();
    try {
      await page.mouse.move(...b, { steps: 12 });
      await delay(300);
      return await shot(c.label);
    } finally {
      await page.mouse.up();
    }
  }
  if (c.action === 'pointer-state')
    return worker().evaluate(async () => {
      const core = globalThis.__auditCore;
      const roots = await Promise.all([core.connection.read(0x887640, 4), core.connection.read(0xabf294, 4)]);
      return {
        roots: roots.map((x) => Array.from(x.bytes)),
        pointer: core.pointer,
        suppressed: core.pointerSuppressed,
      };
    });
  if (c.action === 'pointer-latency') {
    const evidence = await page.evaluate(() => {
      const screen = document.querySelector('#screen'),
        cursor = document.querySelector('#native-page-cursor');
      const samples = [];
      let pending = [];
      let raf = 0;
      let displayFrame = 0;
      const event = (e) => {
        const r = cursor.getBoundingClientRect();
        pending.push({
          eventAt: e.timeStamp,
          handlerFinishedAt: performance.now(),
          eventDisplayFrame: displayFrame,
          x: e.clientX,
          y: e.clientY,
          left: r.left,
          top: r.top,
          visible: getComputedStyle(cursor).display === 'block',
        });
      };
      const tick = () => {
        raf = requestAnimationFrame(tick);
        displayFrame++;
        const at = performance.now();
        for (const sample of pending)
          samples.push({ ...sample, nextAnimationFrameAt: at, nextDisplayFrame: displayFrame });
        pending = [];
      };
      screen.addEventListener('pointermove', event);
      raf = requestAnimationFrame(tick);
      window.__phase8PointerMeasure = {
        samples,
        stop() {
          screen.removeEventListener('pointermove', event);
          cancelAnimationFrame(raf);
        },
      };
      return {
        source:
          'Actual tiny cursor canvas CSS position after pointer event, next display rAF; display scanout uninstrumented',
      };
    });
    const b = await page.locator('#screen').boundingBox();
    for (let i = 0; i < 120; i++) {
      await cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: b.x + b.width * (0.25 + 0.25 * Math.sin(i / 12)),
        y: b.y + b.height * (0.4 + 0.1 * Math.cos(i / 12)),
        buttons: 0,
      });
      await delay(8);
    }
    const result = await page.evaluate(() => {
      const p = window.__phase8PointerMeasure;
      p.stop();
      const s = p.samples;
      delete window.__phase8PointerMeasure;
      return s;
    });
    await writeFile(join(out, c.label + '.json'), JSON.stringify({ evidence, samples: result }, null, 2));
    return { evidence, count: result.length };
  }
  if (c.action === 'picture-sequence') {
    const directory = join(out, c.label);
    await mkdir(directory, { recursive: true });
    const samples = [];
    await page.evaluate(() => {
      window.__phase18NativeFrameSamples = [];
      window.__phase18NativeFrameProbe = (frame) => {
        const curtain = document.querySelector('#hd-curtain');
        const style = curtain ? getComputedStyle(curtain) : null;
        window.__phase18NativeFrameSamples.push({
          atMs: performance.now(),
          width: frame.width,
          height: frame.height,
          presentation: window.__hdBridge?.presentation,
          curtain: style
            ? { display: style.display, opacity: style.opacity, box: curtain.getBoundingClientRect().toJSON() }
            : null,
        });
      };
    });
    const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    const started = Date.now();
    const action = c.steps ? execute({ action: 'batch', steps: c.steps }) : Promise.resolve();
    // Retain an early input failure until the sequence is saved; it must not terminate the process before cleanup.
    void action.catch(() => {});
    while (Date.now() - started < (c.ms ?? 25000)) {
      await ownerIdle();
      const at = Date.now();
      const capture = await cdp.send('Page.captureScreenshot', {
        format: c.compact ? 'jpeg' : 'png',
        ...(c.compact ? { quality: 75, clip: { x: 0, y: 0, ...viewport, scale: 0.5 } } : {}),
        fromSurface: true,
        captureBeyondViewport: false,
      });
      const file = String(samples.length).padStart(4, '0') + (c.compact ? '.jpg' : '.png');
      await writeFile(join(directory, file), Buffer.from(capture.data, 'base64'));
      samples.push({
        file,
        at: new Date(at).toISOString(),
        elapsedMs: at - started,
        ...(c.logic
          ? {
              logic: await worker().evaluate(async (web) => {
                const core = globalThis.__auditCore;
                const bytes = web
                  ? core.emulator.read_memory(0xa8ed84, 4).slice()
                  : (await core.connection.read(0xa8ed84, 4)).bytes;
                return {
                  frame: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, true),
                  atMs: performance.now(),
                  timeOrigin: performance.timeOrigin,
                };
              }, webRoute),
            }
          : {}),
        hd: await page.evaluate(() => ({
          atMs: performance.now(),
          timeline: window.__hdBridge?.timeline,
          presentation: window.__hdBridge?.presentation,
          passthrough: window.__hdBridge?.passthrough,
          activity: window.__hdBridge?.live?.activity(),
          localArtComplete: window.__hdBridge?.live?.localArtComplete,
          preparationNotice: (() => {
            const notice = document.querySelector('#vm-hd-status');
            if (!notice) return null;
            const style = getComputedStyle(notice);
            return {
              text: notice.textContent,
              hidden: notice.hidden,
              display: style.display,
              fontSize: style.fontSize,
              box: notice.getBoundingClientRect().toJSON(),
              language: document.documentElement.lang,
            };
          })(),
        })),
      });
      await delay(Math.max(0, (c.intervalMs ?? 100) - (Date.now() - at)));
    }
    const nativeFrames = await page.evaluate(() => {
      delete window.__phase18NativeFrameProbe;
      const s = window.__phase18NativeFrameSamples;
      delete window.__phase18NativeFrameSamples;
      return s;
    });
    await writeFile(join(directory, 'native-presented-frames.json'), JSON.stringify(nativeFrames, null, 2));
    await writeFile(join(directory, 'sequence.json'), JSON.stringify(samples, null, 2));
    await writeFile(
      join(directory, 'stalls.json'),
      JSON.stringify(await page.evaluate(() => window.__hdBridge?.stalls ?? null), null, 2),
    );
    await action;
    await shot(c.label + '-settled');
    return { frames: samples.length, elapsedMs: Date.now() - started, directory };
  }
  if (c.action === 'reload') {
    beforeBuildings = c.beforeBuildings === true;
    if (c.fullscreenRequested !== undefined) {
      const target = new URL(page.url());
      target.searchParams.set('native-fullscreen', c.fullscreenRequested ? '1' : '0');
      await page.goto(target.href);
    } else await page.reload();
    if (c.reenterFullscreen === true) {
      const toggle = page.locator('#vm-controls-toggle');
      if ((await toggle.getAttribute('aria-expanded')) !== 'true') await locatorClick(toggle);
      await locatorClick(page.locator('#vm-fullscreen'));
      await wait('reattached real fullscreen gesture', () => page.evaluate(() => !!document.fullscreenElement));
    }
    await wait(
      'reattached native picture',
      async () =>
        !!worker() && !!(await worker().evaluate(() => globalThis.__auditCore?.connection?.pictureDecoder?.previous)),
    );
    const probe = await import('./phase7-input-stream.mjs');
    await probe.installPhase7InputProbe(page);
    await probe.disableWorkerNetworkPayloadObservation(page);
    const toggle = page.locator('#vm-controls-toggle');
    if (
      !(await page.evaluate(() => !!document.fullscreenElement)) &&
      (await toggle.getAttribute('aria-expanded')) === 'true'
    )
      await locatorClick(toggle);
    await delay(c.wait ?? 15000);
    return shot(c.label);
  }
  if (c.action === 'window-maximized') {
    const w = await cdp.send('Browser.getWindowForTarget');
    if (c.sizes) {
      assert(Array.isArray(c.sizes) && c.sizes.length <= 30, 'Bounded browser window resize sequence required');
      await cdp.send('Browser.setWindowBounds', { windowId: w.windowId, bounds: { windowState: 'normal' } });
      for (const [width, height] of c.sizes) {
        await ownerIdle();
        assert(Number.isSafeInteger(width) && Number.isSafeInteger(height), 'Explicit window dimensions required');
        await cdp.send('Browser.setWindowBounds', { windowId: w.windowId, bounds: { width, height } });
        await delay(50);
      }
    } else if (c.width !== undefined || c.height !== undefined) {
      assert(Number.isSafeInteger(c.width) && Number.isSafeInteger(c.height), 'Explicit window dimensions required');
      await cdp.send('Browser.setWindowBounds', { windowId: w.windowId, bounds: { windowState: 'normal' } });
      await cdp.send('Browser.setWindowBounds', { windowId: w.windowId, bounds: { width: c.width, height: c.height } });
    } else await cdp.send('Browser.setWindowBounds', { windowId: w.windowId, bounds: { windowState: 'maximized' } });
    await delay(Math.min(c.wait ?? 1000, 60000));
    return shot(c.label ?? 'window-maximized');
  }
  if (c.action === 'shot') return shot(c.label, c.simple === true);
  if (c.action === 'state') return state();
  if (c.action === 'menu-state') {
    return {
      snapshot: await worker().evaluate(() => globalThis.__auditCore.getMenuSnapshot?.() ?? null),
      layer: await page.locator('#hd-menus').evaluateAll((layers) =>
        layers.map((layer) => ({
          display: getComputedStyle(layer).display,
          pointerEvents: getComputedStyle(layer).pointerEvents,
          data: { ...layer.dataset },
          width: layer.width,
          height: layer.height,
          box: layer.getBoundingClientRect().toJSON(),
        })),
      ),
    };
  }
  if (c.action === 'press-control') {
    const current = await state();
    const control = current.controls.find((control) => usable(control) && control.id === c.id);
    assert(control, 'Missing press control ' + c.id);
    await page.mouse.move(
      ...(await point((control.rect[0] + control.rect[2]) / 2, (control.rect[1] + control.rect[3]) / 2)),
    );
    await page.mouse.down();
    try {
      await delay(100);
      await shot(c.label);
      return await execute({ action: 'menu-state' });
    } finally {
      await page.mouse.up();
    }
  }
  if (c.action === 'locator-select') {
    assert(typeof c.selector === 'string' && c.selector, 'A page selector is required');
    await page.locator(c.selector).selectOption(c.value);
    await delay(c.wait ?? 700);
    return c.label ? shot(c.label) : state();
  }
  if (c.action === 'locator-click') {
    assert(typeof c.selector === 'string' && c.selector, 'A page selector is required');
    await locatorClick(page.locator(c.selector));
    await delay(c.wait ?? 700);
    return c.label ? shot(c.label, c.simple === true) : state();
  }
  if (c.action === 'click') {
    let x = c.x,
      y = c.y;
    if (c.id !== undefined || c.text) {
      const findControl = async () => {
        const s = await state();
        return s.controls.find(
          (v) => usable(v) && (c.id !== undefined ? v.id === c.id : new RegExp(c.text, 'i').test(v.text)),
        );
      };
      const control =
        c.waitForControl === true ? await wait('control ' + JSON.stringify(c), findControl) : await findControl();
      assert(control, 'Missing control ' + JSON.stringify(c));
      [x, y] = [(control.rect[0] + control.rect[2]) / 2, (control.rect[1] + control.rect[3]) / 2];
      if (control.class === 'ComboBox') x = control.rect[2] - 8;
    }
    await click(x, y, c.button);
    await delay(c.wait ?? 700);
    return c.label ? shot(c.label) : state();
  }
  if (c.action === 'key-hold') {
    await page.keyboard.down(c.key);
    try {
      await delay(Math.min(c.ms ?? 500, 10000));
    } finally {
      await page.keyboard.up(c.key);
    }
    await delay(150);
    return c.label ? shot(c.label) : state();
  }
  if (c.action === 'combo-select') {
    const before = await state();
    const control = before.controls.find((v) => usable(v) && v.id === c.id && v.class === 'ComboBox');
    assert(control, 'Missing real combo ' + c.id);
    if (control.combo?.selection === c.index) return control;
    await click(control.rect[2] - 8, (control.rect[1] + control.rect[3]) / 2);
    await delay(150);
    const opened = await state();
    const popup = opened.controls.find(
      (v) => usable(v) && v.class.toLowerCase() === 'combodropwin' && Math.abs(v.rect[0] - control.rect[0]) < 2,
    );
    if (popup) {
      // The pinned native skirmish controls draw 23-pixel rows. Their custom
      // popup does not take keyboard focus, so select its actual visible row.
      const rowY = popup.rect[1] + 11 + c.index * 23;
      assert(rowY < popup.rect[3], 'Requested native combo row must be visible');
      await shot(`combo-${c.id}-open`);
      await click((popup.rect[0] + popup.rect[2]) / 2, rowY);
    } else {
      await page.keyboard.press('Home');
      for (let i = 0; i < c.index; i++) {
        await ownerIdle();
        await page.keyboard.press('ArrowDown');
      }
      await page.keyboard.press('Enter');
    }
    await delay(300);
    const after = await state();
    const selected = after.controls.find((v) => v.hwnd === control.hwnd);
    await record('combo-selection', { id: c.id, requested: c.index, before: control.combo, after: selected?.combo });
    assert.equal(selected?.combo?.selection, c.index, 'Actual combo selection did not match ordinary input');
    return selected;
  }
  if (c.action === 'hover-object') {
    const state = await worker().evaluate(() => globalThis.__auditCore.getCommandState());
    const factor = Buffer.from(await readBytes(0xb0cd48, 8)).readDoubleLE();
    const candidates = state.objects
      .filter(
        (o) =>
          o.health > 0 &&
          (c.uid !== undefined
            ? o.uid === c.uid
            : c.type !== undefined
              ? o.type === c.type && (!c.own || o.owner === state.localHouse)
              : c.own
                ? o.owner === state.localHouse && o.kind === 'vehicle'
                : o.owner !== state.localHouse && /^(HTNK|MTNK|LTNK|E1|E2|INIT)$/.test(o.type)),
      )
      .map((o) => ({
        object: o,
        x: Math.trunc((30 * (o.x - o.y)) / 256) - state.view.x,
        y: Math.trunc((15 * (o.x + o.y)) / 256) - Math.trunc(o.z * factor + (o.z >= 728 ? 1 : 0) + 0.5) - state.view.y,
      }));
    const target = candidates.find((o) => o.x > 30 && o.x < 1560 && o.y > 30 && o.y < 1050);
    assert(target, 'No requested real object in tactical view');
    await record('pointer-object-target', { label: c.label, view: state.view, factor, ...target });
    await page.mouse.move(...(await point(target.x, target.y)));
    if (c.select === true) {
      await click(target.x, target.y);
      const selected = await wait('actual selected object ' + target.object.uid, () =>
        worker().evaluate(
          async (uid) =>
            (await globalThis.__auditCore.getCommandState())?.objects.find((o) => o.uid === uid && o.selected),
          target.object.uid,
        ),
      );
      assert.equal(selected.uid, target.object.uid);
      await record('object-selected', { input: 'Trusted browser mouse click', object: selected });
    }
    await delay(400);
    await shot(c.label);
    return target;
  }
  if (c.action === 'key') {
    await page.keyboard.press(c.key, { delay: 100 });
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
    if (c.menuFrames)
      await page.evaluate(() => {
        const probe = (window.__menuFrameProof = { active: true, frames: 0, hidden: 0, samples: [] });
        const tick = () => {
          if (!probe.active) return;
          const layer = document.querySelector('#hd-menus');
          const visible = layer && getComputedStyle(layer).display !== 'none';
          probe.frames++;
          if (!visible) {
            probe.hidden++;
            if (probe.samples.length < 20)
              probe.samples.push({ at: performance.now(), data: layer ? { ...layer.dataset } : null });
          }
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
    const p = await import('./phase9-page-pointer-observer.mjs');
    await p.streamPhase9PointerEvidenceThroughPhase7(page);
    const { runPhase7InputStream } = await import('./phase7-input-stream.mjs');
    const monitor = c.rates
      ? await (
          await import('./phase10-match-rates.mjs')
        ).startPhase10MatchRates({
          page,
          out,
          record,
          label: (c.label ?? 'stream') + '-rates',
          externallyDismissedDialogs: true,
          readNativeLogicEndpoint: () =>
            worker().evaluate(async () => {
              // YR 1.001 frame counter, already validated by the NativeCore game policy.
              // A direct read reply cannot silently substitute the previous mirror reader result.
              const core = globalThis.__auditCore;
              const bytes = (await core.connection.read(0xa8ed84, 4)).bytes;
              if (bytes.byteLength !== 4) throw new Error('Incomplete direct native logic counter read');
              return {
                frame: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, true),
                atMs: performance.now(),
                timeOrigin: performance.timeOrigin,
                clockContext: 'worker',
                fresh: true,
                source: 'Direct read-only NativeConnection.read reply for the validated YR logic frame counter',
              };
            }),
        })
      : null;
    const gameMemory = [];
    const sampleGameMemory = async (stage) => {
      const ps = spawnSync('/bin/ps', ['-axo', 'pid=,rss=,command='], { encoding: 'utf8', timeout: 3000 });
      const candidates = (ps.stdout || '')
        .split('\n')
        .map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/))
        .filter((m) => m && /^(?:[^ \t]*[\\/])?gamemd\.exe(?:\s|$)/i.test(m[3]));
      const match = ps.status === 0 && candidates.length === 1 ? candidates[0] : null;
      const sample = {
        at: new Date().toISOString(),
        label: c.label ?? 'stream',
        stage,
        pid: match ? +match[1] : null,
        rssBytes: match ? +match[2] * 1024 : null,
        unknown: match ? null : ps.error?.message || `game process candidates: ${candidates.length}`,
      };
      gameMemory.push(sample);
      await appendFile(join(out, 'game-process-memory.jsonl'), JSON.stringify(sample) + '\n');
    };
    if (monitor) await sampleGameMemory('start');
    const memoryTimer = monitor
      ? setInterval(() => {
          sampleGameMemory('interval').catch(() => {});
        }, 10000)
      : null;
    let result, rates;
    try {
      result = await runPhase7InputStream({
        page,
        cdp,
        worker: worker(),
        out,
        record,
        shot,
        waitOwnerIdle: ownerIdle,
        asyncOwnerNotifications: true,
        onInputCheckpoint: monitor ? (stage, detail) => monitor.inputCheckpoint(stage, detail) : undefined,
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
              renderReaderError: core.render?.error ?? null,
              localHouse: state?.localHouse ?? null,
              selectedCount: state?.battlefieldOverlay?.objects.length ?? null,
              selectedObjects:
                state?.battlefieldOverlay?.objects.map(({ uid, kind, group }) => ({ uid, kind, group })) ?? null,
              overlayReaderMs: state?.battlefieldOverlay?.readerMs ?? null,
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
    } finally {
      if (c.menuFrames) {
        const proof = await page.evaluate(() => {
          const proof = window.__menuFrameProof;
          proof.active = false;
          return proof;
        });
        await writeFile(join(out, (c.label ?? 'stream') + '-menu-frames.json'), JSON.stringify(proof, null, 2));
        await record('menu-frame-proof', proof);
      }
      if (memoryTimer) clearInterval(memoryTimer);
      if (monitor) {
        rates = await monitor.stop();
        await sampleGameMemory('end');
      }
    }
    const knownMemory = gameMemory.filter((sample) => sample.rssBytes !== null);
    const gameProcessMemory = {
      source: 'macOS ps RSS for the single gamemd.exe process in the runner-isolated game scope',
      start: gameMemory[0] ?? null,
      end: gameMemory.at(-1) ?? null,
      minBytes: knownMemory.length ? Math.min(...knownMemory.map((sample) => sample.rssBytes)) : null,
      maxBytes: knownMemory.length ? Math.max(...knownMemory.map((sample) => sample.rssBytes)) : null,
      pids: [...new Set(knownMemory.map((sample) => sample.pid))],
      knownSamples: knownMemory.length,
      unknownSamples: gameMemory.length - knownMemory.length,
    };
    return monitor ? { stream: result, rates, gameProcessMemory } : result;
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
          async ([a, n, web]) => {
            const core = globalThis.__auditCore;
            return Array.from(web ? core.emulator.read_memory(a, n).slice() : (await core.connection.read(a, n)).bytes);
          },
          [a, n, webRoute],
        ),
      inputState: state,
      shot,
      record,
      wait,
      ownerIdle,
      selectionComparison: false,
      eliminateHuman: c.eliminateHuman ?? false,
    };
    return c.action === 'end' ? runBrowserEnd(api) : runBrowserBattleInput(api);
  }
  if (c.action === 'deploy-mcv') {
    const requestedAt = Date.now();
    const before = await wait('genuine battle state before immediate deployment', async () => {
      const value = c.direct
        ? await worker().evaluate(async (web) => {
            // Read only the opening MCV and camera, using the same pinned fields as
            // yr/stateReader.ts. Input still goes through ordinary browser clicks.
            // This avoids making a first-second click wait for the large HD mirror.
            const core = globalThis.__auditCore;
            if (web) {
              // The same pinned YR 1.001 image as the state reader; the hash is produced by VmCore, never injected.
              if (
                !core.emulator ||
                (await core.executableHash) !== '7b8a068535d6af06845edf95ae829b113d00c02909330e16f197426cd7db94b6' ||
                !(core.getPointerState()?.width > 800) ||
                core.shim.inspectShellPageTitle() !== '' ||
                core.shim.inspectFullSizeDialogVisible()
              )
                return null;
            } else if (!core.hello.exe.verified || core.hello.surface.width <= 800) return null;
            const read = async (a, n) =>
              web ? core.emulator.read_memory(a, n).slice() : (await core.connection.read(a, n)).bytes;
            const u32 = (a, n = 0) => new DataView(a.buffer, a.byteOffset, a.byteLength).getUint32(n, true);
            const i32 = (a, n = 0) => new DataView(a.buffer, a.byteOffset, a.byteLength).getInt32(n, true);
            const [f, h, v, t] = await Promise.all([
              read(0xa8ed84, 4),
              read(0xa83d4c, 4),
              read(0x8b4108, 20),
              read(0x887324, 4),
            ]);
            const frame = u32(f),
              local = u32(h),
              count = u32(v, 16),
              items = u32(v, 4),
              tactical = u32(t);
            if (!frame || frame > 900 || !local || !tactical || count < 1 || count > 512 || !items) return null;
            const pointers = await read(items, count * 4);
            const units = await Promise.all(
              Array.from({ length: count }, async (_, i) => {
                const pointer = u32(pointers, i * 4);
                if (pointer < 0x10000 || pointer % 4) return null;
                const unit = await read(pointer, 0x6c8);
                if (u32(unit) !== 0x7f5c70 || u32(unit, 0x21c) !== local || unit[0x81] || i32(unit, 0x6c) <= 0)
                  return null;
                const name = new TextDecoder().decode(await read(u32(unit, 0x6c4) + 0x24, 24)).split('\0')[0];
                if (!/^(AMCV|MCV|SMCV|PCV)$/.test(name)) return null;
                return {
                  uid: u32(unit, 0x10),
                  owner: local,
                  type: name,
                  health: i32(unit, 0x6c),
                  x: i32(unit, 0x9c),
                  y: i32(unit, 0xa0),
                  z: i32(unit, 0xa4),
                };
              }),
            );
            const camera = await read(tactical + 0xb0, 8);
            return {
              frame,
              localHouse: local,
              objects: units.filter(Boolean),
              view: { x: i32(camera), y: i32(camera, 4) },
            };
          }, webRoute)
        : await worker().evaluate(() => globalThis.__auditCore.getCommandState());
      return value?.view &&
        value.localHouse >= 0 &&
        value.objects.some((o) => o.owner === value.localHouse && o.health > 0 && /^(AMCV|MCV|SMCV|PCV)$/.test(o.type))
        ? value
        : null;
    });
    const mcv = before.objects.find(
      (o) => o.owner === before.localHouse && o.health > 0 && /^(AMCV|MCV|SMCV|PCV)$/.test(o.type),
    );
    assert(mcv, 'No actual local MCV');
    const zFactor = await worker().evaluate(async (web) => {
      const core = globalThis.__auditCore;
      const bytes = web
        ? core.emulator.read_memory(0xb0cd48, 8).slice()
        : (await core.connection.read(0xb0cd48, 8)).bytes;
      return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getFloat64(0, true);
    }, webRoute);
    const x = Math.trunc((30 * (mcv.x - mcv.y)) / 256) - before.view.x;
    const y =
      Math.trunc((15 * (mcv.x + mcv.y)) / 256) -
      Math.trunc(mcv.z * zFactor + (mcv.z >= 728 ? 1 : 0) + 0.5) -
      before.view.y;
    await click(x, y);
    const selectedAt = Date.now();
    if (c.clickDeploy) {
      // A second ordinary click on the selected construction vehicle deploys it.
      await delay(90);
      await click(x, y);
    } else {
      await page.keyboard.down('d');
      await delay(200);
      await page.keyboard.up('d');
    }
    const inputAt = Date.now();
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
    await record('immediate-mcv-deployment', {
      requestedAt,
      selectedAt,
      inputAt,
      observedAt: Date.now(),
      input: c.clickDeploy ? 'two ordinary trusted clicks' : 'trusted click and D',
      beforeFrame: before.frame,
      mcv,
      point: [x, y],
      yard,
      actualGuestState: true,
    });
    if (c.shot !== false) await shot('immediate-mcv-deployment');
    return { mcv, yard };
  }
  if (c.action === 'match-state')
    return worker().evaluate(async (web) => {
      const core = globalThis.__auditCore;
      const bytes = async (a, n) =>
        web ? core.emulator.read_memory(a, n).slice() : (await core.connection.read(a, n)).bytes;
      const read = async (a, n) => {
        const value = await bytes(a, n);
        return new DataView(value.buffer, value.byteOffset, value.byteLength);
      };
      const v = await read(0xa80228, 20),
        count = v.getInt32(16, true),
        items = v.getUint32(4, true),
        pointers = await read(items, count * 4),
        houses = [];
      for (let i = 0; i < count; i++) {
        const p = pointers.getUint32(i * 4, true);
        const name = new TextDecoder().decode(await bytes(p + 0x15ff4, 21)).split('\0')[0];
        const human = (await bytes(p + 0x1ec, 1))[0] !== 0;
        const allies = (await read(p + 0x5788, 4)).getUint32(0, true);
        // The same pinned HouseClass::Defeated field used by ending checkpoints.
        // Record every player so a surviving local house is never mistaken for a win.
        const originalDefeatedByte = (await bytes(p + 0x1f5, 1))[0];
        houses.push({ index: i, pointer: p, name, human, allies, originalDefeatedByte });
      }
      const localPointer = (await read(0xa83d4c, 4)).getUint32(0, true);
      const localHouse = houses.find((house) => house.pointer === localPointer)?.index ?? null;
      const s = await core.getCommandState();
      return {
        frame: s?.frame,
        localHouse,
        view: s?.view,
        performance: await core.getGamePerformance(),
        houses,
      };
    }, webRoute);
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
    if (acceptanceRates) {
      await acceptanceRates.stop().catch((error) => record('played-match-observer-cleanup-error', String(error)));
      acceptanceRates = null;
    }
    if (context) {
      let routeTimer;
      const routes = await Promise.race([
        context.unrouteAll({ behavior: 'ignoreErrors' }).then(
          () => 'removed',
          (error) => String(error),
        ),
        new Promise((resolve) => {
          routeTimer = setTimeout(() => resolve('timeout after 2000 ms'), 2000);
        }),
      ]);
      clearTimeout(routeTimer);
      await record('route-cleanup', { status: routes });
    }
    await browser?.close().catch(() => {});
    await server?.close().catch(() => {});
    if (hdAtlasAlias) await unlink(hdAtlasAlias).catch(() => {});
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
      dllBefore === undefined
        ? null
        : JSON.stringify(await dllIdentity().catch(() => ({ unreadable: true }))) === JSON.stringify(dllBefore);
    const portsReleased = url
      ? await Promise.all(
          (webRoute
            ? [new URL(url).port]
            : [new URL(url).port, new URL(new URL(url).searchParams.get('agent')).port]
          ).map(portReleased),
        )
      : null;
    const osHighwaterRssBytes = process.resourceUsage().maxRSS * 1024;
    peakRss = Math.max(peakRss, osHighwaterRssBytes);
    await record('cleanup', {
      launchStarted: !!launch,
      browserStarted: !!browser,
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
  if (webRoute) {
    const root = resolve(wt, '../..');
    process.env.RA2_DEV_HTTP = '1';
    if (['phase26', 'phase32', 'phase33'].includes(phase)) process.env.RA2_PERF_LOG = join(out, 'session-feel.jsonl');
    process.env.RA2_GAME_ROOT ||= feelSettings.webGameRoot || join(base, phase, 'web-game');
    process.env.RA2_THIRD_PARTY_CACHE_DIR ||= join(root, '.tmp-third-party');
    if (stagedFarmRoot) process.env.RA2_HD_CACHE_DIR = stagedFarmRoot;
    else
      process.env.RA2_HD_CACHE_DIR ||= (await exists(join(base, phase, 'farm', '_library')))
        ? join(base, phase, 'farm')
        : config.RA2_HD_CACHE_DIR;
    servedFarmRoot = resolve(process.env.RA2_HD_CACHE_DIR);
    const { createServer } = await import('vite');
    server = await createServer({
      root: wt,
      configFile: join(wt, 'vite.config.ts'),
      configLoader: 'runner',
      cacheDir: join(out, 'vite-cache'),
      server: { port: 15451, strictPort: true, host: '127.0.0.1' },
    });
    await server.listen();
    const { HD_PLAY_OPTIONS } = await import('../play-options.mjs');
    const options = new URLSearchParams(HD_PLAY_OPTIONS);
    if (tag.startsWith('webbefore')) options.set('sr', '0');
    const query = options.toString();
    url = `http://127.0.0.1:15451/?${query}&resolution=${viewChoice ?? 'display'}&lang=zh`;
    await record('web-server', { checkout: wt, gameRoot: process.env.RA2_GAME_ROOT, route: 'web' });
  } else {
    dllBefore = await dllIdentity();
    await ownerIdle();
    const launchEnvironment = { ...process.env, ...config };
    if (stagedFarmRoot) launchEnvironment.RA2_HD_CACHE_DIR = stagedFarmRoot;
    else if (await exists(join(base, phase, 'farm', '_library'))) {
      launchEnvironment.RA2_HD_CACHE_DIR = join(base, phase, 'farm');
    }
    servedFarmRoot = resolve(launchEnvironment.RA2_HD_CACHE_DIR);
    // The runner's explicit free-Wine scope must override the saved CrossOver
    // smoke configuration; never launch the two prefixes by accident.
    if (['free', 'free-cx'].includes(process.env.RA2_NATIVE_WINE_FLAVOR)) {
      launchEnvironment.RA2_NATIVE_WINE = process.env.RA2_NATIVE_WINE;
      launchEnvironment.RA2_NATIVE_WINE_PREFIX = process.env.RA2_NATIVE_WINE_PREFIX;
      delete launchEnvironment.RA2_NATIVE_WINE_BOTTLE;
      delete launchEnvironment.WINEPREFIX;
      delete launchEnvironment.CX_BOTTLE_PATH;
    }
    launchStartedAtMs = Date.now();
    launch = spawn(
      process.execPath,
      [
        join(wt, 'scripts/remaster/native/phase8-launch-trace.mjs'),
        ...(useViewportHandshake ? (fullWindow ? ['--fullscreen'] : []) : ['--size', '1728x1117']),
        ...(viewChoice ? ['--view', viewChoice] : []),
      ],
      {
        cwd: wt,
        env: { ...launchEnvironment, RA2_NATIVE_AGENT_HIDDEN: tag.startsWith('visible') ? '0' : '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
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
  }
  const cache = join(homedir(), 'Library/Caches/ms-playwright/chromium-1243');
  const exe =
    process.env.NATIVE_BROWSER_EXECUTABLE ||
    join(
      cache,
      (await readdir(cache)).find((d) => d.startsWith('chrome-')),
      'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
    );
  const browserOptions = {
    headless: false,
    executablePath: exe,
    args: [
      '--window-size=1728,1117',
      ...(fullWindow ? ['--kiosk', '--start-fullscreen', '--window-position=0,0'] : []),
      '--enable-unsafe-webgpu',
      '--enable-gpu',
      '--use-angle=metal',
      '--ignore-gpu-blocklist',
      '--autoplay-policy=no-user-gesture-required',
      '--enable-webgpu-developer-features',
    ],
  };
  const contextOptions = naturalWindowDimensions
    ? { viewport: null, locale: 'zh-CN' }
    : { viewport: { width: 1728, height: 1117 }, deviceScaleFactor: 2, locale: 'zh-CN' };
  // A retained, isolated Chrome profile measures the player's second launch,
  // including browser-owned caches. It never attaches to the owner's profile.
  const profileName = process.argv[4];
  if (profileName) assert(/^[a-zA-Z0-9_-]+$/.test(profileName));
  if (profileName) {
    const profilePath = join(base, phase, 'profiles', profileName);
    if (feelSettings.zoom) {
      const preferencesPath = join(profilePath, 'Default', 'Preferences');
      await mkdir(dirname(preferencesPath), { recursive: true });
      const preferences = await readFile(preferencesPath, 'utf8')
        .then(JSON.parse)
        .catch(() => ({}));
      preferences.partition ??= {};
      preferences.partition.default_zoom_level = { x: Math.log(feelSettings.zoom) / Math.log(1.2) };
      await writeFile(preferencesPath, JSON.stringify(preferences));
    }
    context = await chromium.launchPersistentContext(profilePath, {
      ...browserOptions,
      ...contextOptions,
    });
    browser = context.browser();
  } else {
    browser = await chromium.launch(browserOptions);
    context = await browser.newContext(contextOptions);
  }
  await context.grantPermissions(['local-network-access'], { origin: new URL(url).origin });
  await context.route('**/packages/hd-renderer/src/live/liveView.ts*', async (route) => {
    if (!beforeBuildings) return route.continue();
    const response = await route.fetch();
    const source = await response.text();
    const needle = 'const key = indexed && this.library.hasHdPage(page) ? -1 - page : page;';
    assert(source.includes(needle), 'Original non-remapable building baseline route must match source');
    await route.fulfill({
      response,
      body: source.replace(
        needle,
        'const key = (indexed || instance.indexedHousePaint === true) && this.library.hasHdPage(page) ? -1 - page : page;',
      ),
    });
  });
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
      body: source.replaceAll(
        needle,
        needle + ' window.__phase7InputProbe?.position(x,y); window.__phase32Pointer = {x,y};',
      ),
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
        'if (!destroyed) { backend.draw(...args); window.__phase7Presentation?.draw(args); window.__phase18NativeFrameProbe?.(args[0]); if (!window.__hdBridge?.diagnostics?.shown) window.__phase32Feel?.present("classic"); }',
      ),
    });
  });
  if (['phase26', 'phase32', 'phase33'].includes(phase))
    await context.route('**/src/ui/pages/game/hdBridge.ts*', async (route) => {
      const response = await route.fetch();
      const source = await response.text();
      const needle = 'counters.shownFrames++;';
      assert(source.includes(needle), 'Visible HD draw observation must match current source');
      await route.fulfill({ response, body: source.replace(needle, needle + ' window.__phase32Feel?.present("hd");') });
    });
  await context.route('**/src/ui/pages/game/nativeCursor.ts*', async (route) => {
    const response = await route.fetch();
    const source = await response.text();
    const needle = 'frame = next;\n      render();';
    assert(source.includes(needle));
    await route.fulfill({
      response,
      body: source.replace(needle, needle + ' window.__phase9PointerProbe?.frame(next);'),
    });
  });
  page = await context.newPage();
  directMouseMove = page.mouse.move.bind(page.mouse);
  if (phase === 'phase26' || ['phase32', 'phase33'].includes(phase)) {
    page.mouse.move = humanMove;
    for (const method of ['click', 'dblclick']) {
      const direct = page.mouse[method].bind(page.mouse);
      page.mouse[method] = async (x, y, options) => {
        await humanMove(x, y);
        return direct(x, y, options);
      };
    }
  }
  page.on('crash', () => void record('browser-page-crashed', { cleanup: !!cleanupPromise }));
  page.on('close', () => void record('browser-page-closed', { cleanup: !!cleanupPromise }));
  browser.on('disconnected', () => void record('browser-disconnected', { cleanup: !!cleanupPromise }));
  cdp = await context.newCDPSession(page);
  if (profileName) {
    // Playwright routing disables HTTP caching. Restore Chrome's own cache after
    // the read-only observation routes are installed; record cache evidence.
    await cdp.send('Network.enable');
    await cdp.send('Network.setCacheDisabled', { cacheDisabled: false });
    const resourceRequests = new Map();
    cdp.on('Network.requestWillBeSent', (event) => {
      if (event.request.url.includes('/hd-cache/')) resourceRequests.set(event.requestId, event.request.url);
    });
    cdp.on('Network.responseReceived', (event) => {
      if (resourceRequests.has(event.requestId))
        void record('hd-resource', {
          url: event.response.url,
          atSeconds: event.timestamp,
          diskCache: event.response.fromDiskCache ?? false,
          serviceWorker: event.response.fromServiceWorker ?? false,
          timing: event.response.timing,
        });
    });
    cdp.on('Network.loadingFinished', (event) => resourceRequests.delete(event.requestId));
  }
  const initialWindow = await cdp.send('Browser.getWindowForTarget');
  if (!fullWindow)
    await cdp.send('Browser.setWindowBounds', {
      windowId: initialWindow.windowId,
      bounds: {
        left: 0,
        top: 30,
        width: feelSettings.width ?? 1728,
        height: feelSettings.height ?? 1117,
        windowState: 'normal',
      },
    });
  page.on('response', (r) => {
    if (r.status() >= 400) record('http-error', { status: r.status(), url: redact(r.url()) });
  });
  page.on('pageerror', (e) => record('pageerror', { error: String(e) }));
  page.on('dialog', (dialog) => {
    void record('javascript-dialog', { type: dialog.type(), message: dialog.message() });
    // Attaching a listener replaces Playwright's default auto-dismissal.
    // Keep that behavior after recording whole-session failure evidence.
    void dialog.dismiss().catch((error) => record('javascript-dialog-dismiss-error', { error: String(error) }));
  });
  page.on('console', (m) => {
    if (m.type() === 'error') record('console-error', { text: m.text().slice(0, 1000) });
  });
  const ownedWindowForSizing = await cdp.send('Browser.getWindowForTarget');
  const pageUrl = new URL(url);
  pageUrl.searchParams.set('game-speed', gameSpeed);
  if (viewChoice) pageUrl.searchParams.set('resolution', viewChoice);
  if (feelSettings.playStart) pageUrl.searchParams.set('play-start', '1');
  if (feelSettings.gameCursor) pageUrl.searchParams.set('native-cursor', 'game');
  if (useViewportHandshake && !tag.startsWith('window') && !feelSettings.smallWindow) {
    await cdp.send('Browser.setWindowBounds', {
      windowId: ownedWindowForSizing.windowId,
      bounds: { windowState: fullWindow ? 'fullscreen' : 'maximized' },
    });
    await delay(1200);
  }
  await page.goto(pageUrl.toString());
  await page.bringToFront();
  if (webRoute) {
    if (useViewportHandshake && fullWindow) {
      // The web session fixes its display-matched resolution when the game is selected.
      // Recheck the real window after navigation, before that resolution is measured.
      const webWindow = await cdp.send('Browser.getWindowForTarget');
      await cdp.send('Browser.setWindowBounds', {
        windowId: webWindow.windowId,
        bounds: { windowState: 'fullscreen' },
      });
      await delay(1200);
      await record('web-game-selection-area', {
        browserWindow: await cdp.send('Browser.getWindowForTarget'),
        viewport: await page.evaluate(() => ({ width: innerWidth, height: innerHeight, dpr: devicePixelRatio })),
      });
    }
    await locatorClick(page.locator('button.development-source'));
    const yr = page.locator('.detected-games button').filter({ hasText: /Yuri|尤里/i });
    await wait(
      'development game choice',
      async () =>
        (await yr.isVisible()) || (!!worker() && !!(await worker().evaluate(() => globalThis.__auditCore?.shim))),
      120000,
    );
    if (await yr.isVisible()) await locatorClick(yr);
  }
  if (useViewportHandshake && fullWindow && pageUrl.searchParams.get('native-fullscreen') === '1') {
    const fullWindow = await cdp.send('Browser.getWindowForTarget');
    await cdp.send('Browser.setWindowBounds', { windowId: fullWindow.windowId, bounds: { windowState: 'fullscreen' } });
    await delay(1200);
    // macOS can acknowledge CDP's request while retaining a maximized window. A real OS fullscreen gesture must
    // complete before the page negotiates the game's fixed video mode; a DOM-only fullscreen flag is insufficient.
    await record('os-fullscreen-needed', { window: await cdp.send('Browser.getWindowForTarget') });
    await wait(
      'actual macOS fullscreen window before measurement',
      () => page.evaluate(() => outerHeight === screen.height && outerWidth === screen.width),
      120000,
    );
    const toggle = page.locator('#vm-controls-toggle');
    if ((await toggle.getAttribute('aria-expanded')) !== 'true') await locatorClick(toggle);
    await locatorClick(page.locator('#vm-fullscreen'));
    await wait('startup real fullscreen gesture', () => page.evaluate(() => !!document.fullscreenElement));
    await record(
      'fullscreen-startup-area',
      await page.evaluate(() => ({
        width: innerWidth,
        height: innerHeight,
        dpr: devicePixelRatio,
        display: { width: screen.width, height: screen.height },
        fullscreenBox: document.fullscreenElement?.getBoundingClientRect().toJSON(),
      })),
    );
  }
  const ownedWindow = await cdp.send('Browser.getWindowForTarget');
  if (!naturalWindowDimensions) {
    await page.setViewportSize({ width: 1728, height: 1117 });
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 1728,
      height: 1117,
      deviceScaleFactor: 2,
      mobile: false,
    });
  }
  await delay(1000);
  if (['phase26', 'phase32', 'phase33'].includes(phase)) {
    const start = page.getByRole('button', { name: '开始', exact: true });
    if (!webRoute || feelSettings.playStart)
      await wait(
        'player start gate or attached native runtime',
        async () => (await start.isVisible()) || !!worker(),
        30000,
      );
    if (await start.isVisible()) {
      const startCapture = await cdp.send('Page.captureScreenshot', {
        format: 'png',
        fromSurface: true,
        captureBeyondViewport: false,
      });
      await writeFile(join(out, 'before-start.png'), Buffer.from(startCapture.data, 'base64'));
      await record('player-start-gate', {
        viewport: await page.evaluate(() => ({
          width: innerWidth,
          height: innerHeight,
          dpr: devicePixelRatio,
          screen: { width: screen.width, height: screen.height },
        })),
        browserWindow: await cdp.send('Browser.getWindowForTarget'),
      });
      if (['phase26', 'phase33'].includes(phase)) {
        await page
          .locator('#display-refresh-notice')
          .waitFor({ state: 'visible', timeout: 8000 })
          .catch(() => {});
        await page.screenshot({ path: join(out, 'startup-refresh-notice.png') });
      }
      await locatorClick(start);
    }
  }
  if (webRoute) {
    await wait(
      'web Worker and shim',
      async () => !!worker() && !!(await worker().evaluate(() => globalThis.__auditCore?.shim)),
      120000,
    );
  } else {
    await wait(
      'native main menu',
      async () => {
        try {
          const input = await state();
          mainMenuControlsObserved = !!input.controls?.some((c) => usable(c) && c.id === 1667);
          return (
            mainMenuControlsObserved || (tag.startsWith('nativeintro') && input.moviePlaying === true && !input.modal)
          );
        } catch {
          return false;
        }
      },
      120000,
    );
  }
  const toggle = page.locator('#vm-controls-toggle');
  if (
    !(await page.evaluate(() => !!document.fullscreenElement)) &&
    (await toggle.getAttribute('aria-expanded')) === 'true'
  )
    await locatorClick(toggle);
  const { installPhase7InputProbe } = await import('./phase7-input-stream.mjs');
  await installPhase7InputProbe(page);
  try {
    const { disableWorkerNetworkPayloadObservation } = await import('./phase7-input-stream.mjs');
    await record('worker-payload-observation', await disableWorkerNetworkPayloadObservation(page));
  } catch (e) {
    await record('payload-probe-unavailable', { error: String(e) });
  }
  if (!webRoute)
    await wait(
      'first native picture on page',
      async () => await worker().evaluate(() => !!globalThis.__auditCore.connection.pictureDecoder.previous),
      120000,
    );
  if (!webRoute && mainMenuControlsObserved) mainMenuObservedAtMs = Date.now();
  await delay(1000);
  await shot(webRoute ? 'startup-ready' : 'main-menu');
  await record('ready', {
    tag,
    phase,
    browserExecutable: exe,
    naturalWindowDimensions,
    browserVersion: browser.version(),
    installedAgent: webRoute ? null : await dllIdentity(),
    launcherStartAt: launchStartedAtMs === null ? null : new Date(launchStartedAtMs).toISOString(),
    mainMenuObservedAt: mainMenuObservedAtMs === null ? null : new Date(mainMenuObservedAtMs).toISOString(),
    launcherStartToObservedMainMenuMs: mainMenuObservedAtMs === null ? null : mainMenuObservedAtMs - launchStartedAtMs,
    mainMenuTimingSource:
      'Usable native main-menu control and first decoded picture; upper bound includes browser startup; intro readiness excluded',
    viewport: await page.evaluate(() => ({
      width: innerWidth,
      height: innerHeight,
      outerWidth,
      outerHeight,
      dpr: devicePixelRatio,
      display: {
        width: screen.width,
        height: screen.height,
        availableWidth: screen.availWidth,
        availableHeight: screen.availHeight,
        availableLeft: screen.availLeft,
        availableTop: screen.availTop,
      },
      visualViewport: window.visualViewport
        ? {
            width: visualViewport.width,
            height: visualViewport.height,
            scale: visualViewport.scale,
            offsetLeft: visualViewport.offsetLeft,
            offsetTop: visualViewport.offsetTop,
          }
        : null,
      canvasBacking: {
        width: document.querySelector('#screen')?.width,
        height: document.querySelector('#screen')?.height,
      },
    })),
    browserWindow: await cdp.send('Browser.getWindowForTarget'),
    hello: webRoute ? await state() : await worker().evaluate(() => globalThis.__auditCore.hello),
  });
  await writeFile(join(out, 'ready'), 'ready\n');
  const until = Math.min(harnessDeadline, scopeDeadline);
  const done = new Set();
  while (Date.now() < until) {
    if (await exists(join(out, 'cancel'))) break;
    const files = (await readdir(out)).filter((f) => /^command-[0-9]+\.json$/.test(f)).sort();
    let close = false;
    for (const file of files) {
      if (done.has(file) || !(await exists(join(out, file)))) continue;
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
        if (['phase26', 'phase32', 'phase33'].includes(phase)) {
          await writeFile(join(out, 'paused-command'), file + '\n');
          while (!(await exists(join(out, 'resume'))) && !(await exists(join(out, 'cancel')))) {
            await ownerIdle();
            await delay(250);
          }
          await unlink(join(out, 'resume')).catch(() => {});
          await unlink(join(out, 'paused-command')).catch(() => {});
        }
      }
    }
    if (close) break;
    await delay(100);
  }
} catch (e) {
  await record('fatal', { error: String(e.stack || e) });
  if (page) {
    const path = join(out, 'fatal-page.png');
    await page
      .screenshot({ path, timeout: 5000 })
      .then(() => record('fatal-page', { path }))
      .catch(() => {});
  }
  process.exitCode = 1;
} finally {
  await cleanup();
}
