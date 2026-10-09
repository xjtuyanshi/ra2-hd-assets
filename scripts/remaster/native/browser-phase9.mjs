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
import { ownerConnected } from './owner-open-boundary.mjs';
const wt = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const base = outputDirectory();
const phase = process.env.NATIVE_BROWSER_PHASE || 'phase9';
const naturalWindowDimensions = process.env.NATIVE_BROWSER_USE_WINDOW_DIMENSIONS === '1';
assert(/^phase[0-9]+$/.test(phase));
const tag = process.argv[2] || 'hidden';
assert(/^[a-zA-Z0-9_-]+$/.test(tag));
const out = join(base, phase, tag);
await mkdir(out, { recursive: true });
await writeFile(join(out, 'harness-pid'), String(process.pid) + '\n');
const config = JSON.parse(await readFile(join(base, 'run/owner-launch-smoke.json'), 'utf8'));
const pause = resolve(base, '../play/_slots/PAUSE');
const exists = async (p) =>
  lstat(p)
    .then(() => true)
    .catch((error) => {
      if (error.code === 'ENOENT') return false;
      throw error;
    });
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
    if (Date.now() > scopeDeadline) {
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
    await ownerIdle();
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
  const capture = await cdp.send('Page.captureScreenshot', {
    format: 'png',
    fromSurface: true,
    captureBeyondViewport: false,
  });
  await writeFile(path, Buffer.from(capture.data, 'base64'));
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
  const s = await worker().evaluate(() => globalThis.__auditCore.hello.surface);
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
  if (c.action === 'launcher-stop-notice') {
    const label = c.label ?? 'launcher-closed';
    assert(/^[a-zA-Z0-9_-]+$/.test(label));
    assert(privateDir, 'Owned launcher private directory required');
    await writeFile(join(privateDir, 'stop'), 'stop\n', { mode: 0o600 });
    await wait(
      'Chinese normal close notice',
      () =>
        page
          .locator('.game-folder-panel h3')
          .filter({ hasText: /^游戏已关闭$/ })
          .isVisible(),
      15000,
    );
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
      await toggle.click();
    }
    await ownerIdle();
    await page.locator('#vm-fullscreen').click();
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
      readBytes: (a, n) =>
        worker().evaluate(
          async ([a, n]) => Array.from((await globalThis.__auditCore.connection.read(a, n)).bytes),
          [a, n],
        ),
      record,
      shot,
    });
  }
  if (c.action === 'base-play') {
    const m = await import('./phase9-base-play.mjs');
    return m.runPhase9BasePlay({
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
    await click(control.rect[2] - 8, (control.rect[1] + control.rect[3]) / 2);
    await delay(100);
    await page.keyboard.press('Home');
    for (let i = 0; i < c.index; i++) {
      await ownerIdle();
      await page.keyboard.press('ArrowDown');
    }
    await page.keyboard.press('Enter');
    await delay(300);
    const after = await state();
    const selected = after.controls.find((v) => v.hwnd === control.hwnd);
    await record('combo-selection', { id: c.id, requested: c.index, before: control.combo, after: selected?.combo });
    assert.equal(selected?.combo?.selection, c.index, 'Actual combo selection did not match ordinary input');
    return selected;
  }
  if (c.action === 'hover-object') {
    const state = await worker().evaluate(() => globalThis.__auditCore.getCommandState());
    const factor = await worker().evaluate(async () => {
      const b = (await globalThis.__auditCore.connection.read(0xb0cd48, 8)).bytes;
      return new DataView(b.buffer, b.byteOffset, b.byteLength).getFloat64(0, true);
    });
    const candidates = state.objects
      .filter(
        (o) =>
          o.health > 0 &&
          (c.uid !== undefined
            ? o.uid === c.uid
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
    await delay(400);
    await shot(c.label);
    return target;
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
      if (monitor) rates = await monitor.stop();
    }
    return monitor ? { stream: result, rates } : result;
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
      ownerIdle,
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
      dllBefore === undefined
        ? null
        : JSON.stringify(await dllIdentity().catch(() => ({ unreadable: true }))) === JSON.stringify(dllBefore);
    const portsReleased = url
      ? await Promise.all([new URL(url).port, new URL(new URL(url).searchParams.get('agent')).port].map(portReleased))
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
  dllBefore = await dllIdentity();
  await ownerIdle();
  launch = spawn(
    process.execPath,
    [join(wt, 'scripts/remaster/native/phase8-launch-trace.mjs'), '--size', '1728x1117'],
    {
      cwd: wt,
      env: { ...process.env, ...config, RA2_NATIVE_AGENT_HIDDEN: tag.startsWith('visible') ? '0' : '1' },
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
  const cache = join(homedir(), 'Library/Caches/ms-playwright/chromium-1243');
  const exe =
    process.env.NATIVE_BROWSER_EXECUTABLE ||
    join(
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
  const context = await browser.newContext(
    naturalWindowDimensions ? { viewport: null } : { viewport: { width: 1728, height: 1117 }, deviceScaleFactor: 2 },
  );
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
  page.on('dialog', (dialog) => {
    void record('javascript-dialog', { type: dialog.type(), message: dialog.message() });
    // Attaching a listener replaces Playwright's default auto-dismissal.
    // Keep that behavior after recording whole-session failure evidence.
    void dialog.dismiss().catch((error) => record('javascript-dialog-dismiss-error', { error: String(error) }));
  });
  page.on('console', (m) => {
    if (m.type() === 'error') record('console-error', { text: m.text().slice(0, 1000) });
  });
  const pageUrl = new URL(url);
  pageUrl.searchParams.set('game-speed', '3');
  await page.goto(pageUrl.toString());
  await page.bringToFront();
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
    phase,
    browserExecutable: exe,
    naturalWindowDimensions,
    browserVersion: browser.version(),
    installedAgent: await dllIdentity(),
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
    hello: await worker().evaluate(() => globalThis.__auditCore.hello),
  });
  await writeFile(join(out, 'ready'), 'ready\n');
  const until = Math.min(Date.now() + 23 * 60000, scopeDeadline);
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
