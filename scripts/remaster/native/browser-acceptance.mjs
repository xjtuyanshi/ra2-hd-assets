#!/usr/bin/env node
// Real trusted browser input only. Worker instrumentation below exposes read-only diagnostics.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile, appendFile, readdir, lstat, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createWriteStream } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { createConnection } from 'node:net';
import { homedir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from '@playwright/test';
import { observePageCombat } from './page-battle-input.mjs';
import { startBrowserCombatObserver } from './browser-combat-observer.mjs';
import { outputDirectory } from './artifacts.mjs';
import { nativeResolutionIniName } from './native-resolution.mjs';
import { disableWorkerNetworkPayloadObservation, createPhase7EvidenceStream } from './phase7-input-stream.mjs';

const { values: o } = parseArgs({
  options: {
    out: { type: 'string', default: process.env.NATIVE_OUT },
    config: { type: 'string' },
    mode: { type: 'string', default: 'accept' },
    teams: { type: 'string', default: 'original' },
    ai: { type: 'string', default: 'original' },
    scout: { type: 'boolean', default: false },
    harass: { type: 'boolean', default: false },
    'short-game': { type: 'string', default: 'original' },
    'skip-comparison': { type: 'boolean', default: false },
    'interactions-only': { type: 'boolean', default: false },
    'fight-windows': { type: 'string', default: '3' },
    size: { type: 'string' },
    seconds: { type: 'string', default: '60' },
    hold: { type: 'string', default: '0' },
    'mouse-lock': { type: 'string' },
    help: { type: 'boolean' },
  },
});
if (o.help) {
  console.log(
    'browser-acceptance.mjs --out OUT [--config private.json] [--mode reproduce|accept|visual] [--teams original|free-for-all|three-versus-three] [--ai original|easy|medium|hard] [--scout] [--harass] [--short-game original|true|false] [--skip-comparison] [--interactions-only] [--fight-windows 1..3] [--size WxH]',
  );
  process.exit(0);
}
assert(o.out, 'Supply --out or NATIVE_OUT');
assert(['reproduce', 'accept', 'visual'].includes(o.mode), 'Unknown acceptance mode');
assert(['original', 'free-for-all', 'three-versus-three'].includes(o.teams), 'Unknown six-player team preset');
assert(['original', 'easy', 'medium', 'hard'].includes(o.ai), 'Unknown original AI difficulty choice');
assert(['original', 'true', 'false'].includes(o['short-game']), 'Unknown short-game preference');
assert(
  Number.isInteger(Number(o['fight-windows'])) && Number(o['fight-windows']) >= 1 && Number(o['fight-windows']) <= 3,
  'Use one to three independent fight windows',
);
assert(Number(o.seconds) === 60, 'Fight acceptance requires a 60 second sample');
assert(Number.isFinite(Number(o.hold)) && Number(o.hold) >= 0 && Number(o.hold) <= 1000, 'Invalid mouse hold');
const wt = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const out = join(outputDirectory(o.out), 'browser');
await mkdir(out, { recursive: true });
const stamp = new Date().toISOString().replaceAll(':', '-');
const reportPath = join(out, `${stamp}-${o.mode}.json`);
const stepsPath = join(out, `${stamp}-${o.mode}-steps.ndjson`);
const stepEvidence = await createPhase7EvidenceStream(stepsPath);
const launcherLogPath = join(out, `${stamp}-launcher.log`);
const launcherEvidence = createWriteStream(launcherLogPath, { flags: 'wx', mode: 0o600 });
const report = {
  startedAt: new Date().toISOString(),
  mode: o.mode,
  steps: [],
  screenshots: [],
  errors: [],
  cleanup: {},
  error: null,
  stepsPath,
  totalSteps: 0,
  nodeRssHighBytes: Math.max(process.memoryUsage().rss, process.resourceUsage().maxRSS * 1024),
};
const allowed = new Set([
  'RA2_NATIVE_GAME_DIR',
  'RA2_NATIVE_WINE_BOTTLE',
  'RA2_NATIVE_WINE_PREFIX',
  'RA2_NATIVE_WINE',
  'RA2_HD_CACHE_DIR',
  'CX_BOTTLE_PATH',
]);
const config =
  o.config || !process.env.RA2_NATIVE_GAME_DIR
    ? JSON.parse(await readFile(o.config || resolve(o.out, 'run/owner-launch-smoke.json'), 'utf8'))
    : {};
for (const [key, value] of Object.entries(config))
  assert(allowed.has(key) && typeof value === 'string', 'Unsupported configuration');
let launcher,
  browser,
  browserServer,
  page,
  cdp,
  exited,
  privateDirectory,
  launchLog = '',
  launchPending = '',
  stopping = false,
  cleanupPromise,
  launchedUrl,
  dllBefore,
  ownedBrowserProcess;
const redact = (s) => String(s).replace(/agent-token=[a-f0-9]+/gi, 'agent-token=[redacted]');
const rssMonitor = setInterval(() => {
  report.nodeRssHighBytes = Math.max(
    report.nodeRssHighBytes,
    process.memoryUsage().rss,
    process.resourceUsage().maxRSS * 1024,
  );
}, 1000);
rssMonitor.unref();
const save = () => writeFile(reportPath, JSON.stringify(report, null, 2));
const record = async (name, proof) => {
  const entry = { name, at: new Date().toISOString(), proof };
  await stepEvidence.append(entry);
  report.totalSteps++;
  // Full evidence stays on disk. Keep the familiar inline contract for small
  // records, with explicit references for large/older records.
  const text = JSON.stringify(proof);
  report.steps.push(
    text.length <= 65536 ? entry : { ...entry, proof: { evidencePath: stepsPath, record: report.totalSteps } },
  );
  if (report.steps.length > 256) report.steps.shift();
  report.nodeRssHighBytes = Math.max(
    report.nodeRssHighBytes,
    process.memoryUsage().rss,
    process.resourceUsage().maxRSS * 1024,
  );
  console.log(name, JSON.stringify(proof).slice(0, 1200));
  await save();
};
const worker = () =>
  page.workers().find((w) => /vmWorker/.test(w.url())) || page.workers().find((w) => !/audio|ort|model/i.test(w.url()));
const inputState = () =>
  worker().evaluate(async () =>
    JSON.parse(new TextDecoder().decode(await globalThis.__auditCore.connection.request(14))),
  );
const commandState = () => worker().evaluate(() => globalThis.__auditCore.getCommandState());
const mirrorFootprint = () => worker().evaluate(() => globalThis.__auditCore.getMirrorFootprint());
const readBytes = (a, n) =>
  worker().evaluate(async ([a, n]) => Array.from((await globalThis.__auditCore.connection.read(a, n)).bytes), [a, n]);
async function mapDescriptor() {
  // This original YR descriptor is independent direct-read evidence, not a
  // replacement for the same-frame mirror consumed by the renderer.
  const bytes = Buffer.from(await readBytes(0x87f7e8 + 0x138, 12));
  return {
    source: 'Pinned YR MapClass VectorClass; independent direct read',
    items: bytes.readUInt32LE(4),
    capacity: bytes.readInt32LE(8),
    maximumSlots: 512 * 512,
  };
}
async function wait(label, fn, ms = 15000) {
  const until = Date.now() + ms;
  let value;
  do {
    if (stopping) throw new Error('Acceptance interrupted');
    value = await fn();
    if (value) return value;
    await delay(100);
  } while (Date.now() < until);
  throw new Error(`Timeout: ${label}`);
}
async function shot(label) {
  const path = join(out, `${stamp}-${label}.png`);
  await page.screenshot({ path, scale: 'css', timeout: 15000 });
  report.screenshots.push({ label, path });
  if (/^battle-(selected|selected-building|drag-band|placement-preview|cursor)$/.test(label)) {
    const native = await worker().evaluate(() => {
      const picture = globalThis.__auditCore?.connection?.pictureDecoder?.previous;
      if (!picture?.pixels?.length) return null;
      return { width: picture.width, height: picture.height, frame: picture.frame, pixels: Array.from(picture.pixels) };
    });
    if (native) {
      const png = await page.evaluate(({ width, height, pixels }) => {
        const source = document.createElement('canvas');
        source.width = width;
        source.height = height;
        const context = source.getContext('2d');
        const image = context.createImageData(width, height);
        for (let i = 0; i < pixels.length; i++) {
          const p = pixels[i],
            r = (p >>> 11) & 31,
            g = (p >>> 5) & 63,
            b = p & 31;
          image.data.set([(r << 3) | (r >>> 2), (g << 2) | (g >>> 4), (b << 3) | (b >>> 2), 255], i * 4);
        }
        context.putImageData(image, 0, 0);
        const output = document.createElement('canvas');
        output.width = Math.min(1600, width);
        output.height = Math.round((height * output.width) / width);
        output.getContext('2d').drawImage(source, 0, 0, output.width, output.height);
        return output.toDataURL('image/png');
      }, native);
      const nativePath = join(out, `${stamp}-${label}-native.png`);
      await writeFile(nativePath, Buffer.from(png.split(',')[1], 'base64'));
      report.screenshots.push({ label: `${label}-native`, path: nativePath, frame: native.frame });
    }
  }
  await save();
  return path;
}
async function reviewNativePopupRequest(request) {
  // The acceptance operator reviews actual pixels. This never invokes a native
  // control directly: the caller validates and issues an ordinary browser click.
  const owner = randomUUID();
  const base = join(out, `${stamp}-ai-review-${owner}`);
  const requestPath = `${base}.request.json`;
  const responsePath = `${base}.response.json`;
  const screenshotPath = await shot(`ai-review-${owner}`);
  const canvas = await page.locator('#screen').boundingBox();
  const surface = await worker().evaluate(() => ({ ...globalThis.__auditCore.hello.surface }));
  await writeFile(
    requestPath,
    JSON.stringify({ owner, request, screenshotPath, canvas, surface, responsePath }, null, 2),
    { flag: 'wx', mode: 0o600 },
  );
  await record('ai-review-request', { owner, requestPath, screenshotPath, responsePath });
  return wait(
    'actual native-popup screenshot review',
    async () => {
      const handle = await open(responsePath, constants.O_RDONLY | constants.O_NOFOLLOW).catch((error) => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
      if (!handle) return null;
      try {
        const stat = await handle.stat();
        assert(stat.isFile() && stat.size <= 1024, 'Popup response must be a bounded regular private file');
        const choice = JSON.parse(await handle.readFile('utf8'));
        assert(
          choice.owner === owner && Number.isFinite(choice.x) && Number.isFinite(choice.y),
          'Popup response must belong to this actual screenshot',
        );
        return { x: choice.x, y: choice.y };
      } finally {
        await handle.close();
      }
    },
    45000,
  );
}
async function point(x, y) {
  const b = await page.locator('#screen').boundingBox();
  const f = await worker().evaluate(() => [
    globalThis.__auditCore.hello.surface.width,
    globalThis.__auditCore.hello.surface.height,
  ]);
  return [b.x + (x * b.width) / f[0], b.y + (y * b.height) / f[1]];
}
async function click(x, y, mode = 'quick', button = 'left', hold = Number(o.hold)) {
  const [px, py] = await point(x, y);
  if (mode === 'no-move') {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: px, y: py, button, clickCount: 1 });
    await delay(hold);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: px, y: py, button, clickCount: 1 });
  } else {
    await page.mouse.move(px, py);
    await page.mouse.down({ button });
    await delay(hold);
    await page.mouse.up({ button });
  }
  await delay(250);
}
async function focusGameCanvas(label) {
  const toggle = page.locator('#vm-controls-toggle');
  if ((await toggle.getAttribute('aria-expanded')) === 'true') await toggle.click();
  const dimensions = await worker().evaluate(() => globalThis.__auditCore.hello.surface);
  // Real input restores canvas focus after the toolbar's button held it. The
  // ordinary right click cancels a pending placement or sell mode; no DOM focus shortcut.
  await click(Math.floor(dimensions.width / 2), Math.floor(dimensions.height / 2), 'quick', 'right');
  const focused = await page.evaluate(() => document.activeElement === document.querySelector('#screen'));
  await record(label, {
    focused,
    toolbarExpanded: await toggle.getAttribute('aria-expanded'),
    input: 'trusted real browser centre click',
  });
  assert(focused, 'Native keyboard input requires the canvas to own browser focus');
}
const usable = (c) => c.visible && c.enabled && c.rect?.[2] > c.rect?.[0];
const control = (s, id) =>
  s.controls.find((c) => usable(c) && (typeof id === 'number' ? c.id === id : id.test(c.text)));
async function clickControl(id, label, mode = 'quick') {
  const s = await wait(label, async () => {
    const s = await inputState();
    return control(s, id) ? s : null;
  });
  const c = control(s, id);
  await delay(1300);
  await click(Math.floor((c.rect[0] + c.rect[2]) / 2), Math.floor((c.rect[1] + c.rect[3]) / 2), mode);
  await record(label, {
    id: c.id,
    text: c.text,
    rect: c.rect,
    mode,
    after: await inputState(),
    events: await page.evaluate(() => window.__browserInputs),
  });
}
async function chooseTeam(team, desired, waitFor = wait) {
  const current = control(await inputState(), team.id);
  if (current.combo.selection === desired) return;
  await click(
    current.rect[2] - Math.min(11, (current.rect[2] - current.rect[0]) / 2),
    (current.rect[1] + current.rect[3]) / 2,
    'quick',
  );
  const popup = await waitFor('owned team popup', async () => {
    const s = await inputState();
    return s.controls.find(
      (c) =>
        usable(c) &&
        c.class === 'ComboDropWin' &&
        c.hwnd === s.gameCaptureHwnd &&
        c.parentHwnd === current.parentHwnd &&
        c.rect[0] === current.rect[0] &&
        c.rect[1] >= current.rect[3] &&
        c.rect[1] <= current.rect[3] + 4,
    );
  });
  await shot(`team-${team.id}-popup`);
  // The pinned native menu's inspected PNG has five rows: None, A, B, C, D,
  // with centres at +11,+34,+57,+80,+103 from the actual owned popup top.
  const y = popup.rect[1] + 11 + desired * 23;
  assert(y < popup.rect[3] && current.combo.count === 5);
  await click((popup.rect[0] + popup.rect[2]) / 2, y, 'no-move');
  const result = await waitFor('team selection', async () => {
    const s = await inputState();
    return control(s, team.id)?.combo?.selection === desired ? s : null;
  });
  await record('team-selection', { id: team.id, desired, popup, result });
}
async function savedTeamPreferences(teams) {
  const path = join(out, 'team-preferences.json');
  const observed = teams.map((team) => ({ id: team.id, selection: team.combo.selection }));
  try {
    await writeFile(path, JSON.stringify({ source: stamp, teams: observed }, null, 2), { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  const stat = await lstat(path);
  assert(stat.isFile() && stat.size <= 16384, 'Team preferences must be a bounded regular private file');
  const saved = JSON.parse(await readFile(path, 'utf8'));
  const baseline = Array.isArray(saved) ? saved : saved.teams;
  assert(Array.isArray(baseline) && baseline.length === 6, 'Team preferences must contain six original selections');
  const original = baseline.map((team, index) =>
    typeof team === 'number' ? { id: 1901 + index, selection: team } : { id: team.id, selection: team.selection },
  );
  assert(
    original.every(
      (team, index) =>
        team.id === 1901 + index && Number.isInteger(team.selection) && team.selection >= 0 && team.selection < 5,
    ),
    'Team preferences must match original menu IDs 1901–1906 and selections 0–4',
  );
  await record('team-preferences-baseline', { path, original, observed });
  return original;
}
async function readShortGamePreference() {
  const directory = config.RA2_NATIVE_GAME_DIR || process.env.RA2_NATIVE_GAME_DIR;
  const file = nativeResolutionIniName(await readdir(directory));
  const text = (await readFile(join(directory, file))).toString('latin1');
  let skirmish = false,
    value = null;
  for (const line of text.split(/\r\n|\n|\r/)) {
    const section = /^\s*\[([^\]]+)\]/.exec(line);
    if (section) skirmish = section[1].toLowerCase() === 'skirmish';
    else if (skirmish) {
      const setting = /^\s*ShortGame\s*=\s*([^;#\s]+)/i.exec(line);
      if (setting) value = setting[1].toLowerCase();
    }
  }
  assert(
    ['yes', 'no', 'true', 'false', '1', '0'].includes(value),
    'Original ShortGame preference must be known before changing it',
  );
  return ['yes', 'true', '1'].includes(value);
}
async function savedShortGamePreference() {
  const path = join(out, 'team-preferences.json');
  const stat = await lstat(path);
  assert(stat.isFile() && stat.size <= 16384, 'Settings baseline must remain a bounded regular private file');
  const saved = JSON.parse(await readFile(path, 'utf8'));
  const baseline = Array.isArray(saved) ? { teams: saved } : saved;
  if (typeof baseline.shortGame !== 'boolean') {
    baseline.shortGame = await readShortGamePreference();
    baseline.shortGameSource = { source: 'supplied INI before browser setting changes', observedAt: stamp };
    await writeFile(path, JSON.stringify(baseline, null, 2), { mode: 0o600 });
  }
  await record('short-game-preference-baseline', {
    path,
    original: baseline.shortGame,
    source: baseline.shortGameSource ?? 'existing private baseline',
  });
  return baseline.shortGame;
}
async function observedShortGame() {
  // Pinned YR 1.001 Session.Options.ShortGame (GameOptionsClass +0x14).
  // Skirmish Start 1559 latches checkbox 1358 at 0x6AD78D..0x6AD7BC.
  // Before Start this is the prior session option, not the checkbox's state.
  const value = (await readBytes(0xa8b262, 1))[0];
  assert(value === 0 || value === 1, 'Native ShortGame setting must be a known boolean');
  return value === 1;
}
async function observedShortGameCheckbox(checkbox) {
  return worker().evaluate((rect) => {
    const picture = globalThis.__auditCore?.connection?.pictureDecoder?.previous;
    const center = { x: Math.trunc(rect[0] + 8), y: Math.trunc(rect[1] + 8) };
    const sampleRect = { x: center.x - 2, y: center.y - 2, width: 5, height: 5 };
    const result = {
      checked: null,
      classification: 'UNKNOWN',
      pictureFrame: picture?.frame ?? null,
      pictureSize: picture ? { width: picture.width, height: picture.height } : null,
      controlRect: rect,
      sampleRect,
      meanRGB: null,
      samples: 0,
      source: 'read-only NativePictureDecoder.previous RGB565',
    };
    if (
      !picture?.pixels?.length ||
      picture.pixels.length !== picture.width * picture.height ||
      sampleRect.x < 0 ||
      sampleRect.y < 0 ||
      sampleRect.x + sampleRect.width > picture.width ||
      sampleRect.y + sampleRect.height > picture.height
    )
      return result;
    let red = 0,
      green = 0,
      blue = 0;
    for (let y = sampleRect.y; y < sampleRect.y + sampleRect.height; y++)
      for (let x = sampleRect.x; x < sampleRect.x + sampleRect.width; x++) {
        const pixel = picture.pixels[y * picture.width + x];
        const r = (pixel >>> 11) & 31,
          g = (pixel >>> 5) & 63,
          b = pixel & 31;
        red += (r << 3) | (r >>> 2);
        green += (g << 2) | (g >>> 4);
        blue += (b << 3) | (b >>> 2);
        result.samples++;
      }
    red /= result.samples;
    green /= result.samples;
    blue /= result.samples;
    result.meanRGB = { red, green, blue };
    const spread = Math.max(red, green, blue) - Math.min(red, green, blue);
    const brightness = (red + green + blue) / 3;
    // The inspected native checkbox is orange when checked and neutral grey
    // when unchecked. Black/white carriers or unrelated colours stay unknown.
    if (red - green >= 60 && green - blue >= 30) {
      result.classification = 'ON';
      result.checked = true;
    } else if (spread <= 35 && brightness >= 32 && brightness <= 240) {
      result.classification = 'OFF';
      result.checked = false;
    }
    return result;
  }, checkbox.rect);
}
async function setShortGame(wanted, label, waitFor = wait) {
  const state = await waitFor(`${label} setup`, async () => {
    const current = await inputState();
    return control(current, 1559) && control(current, 1358) ? current : null;
  });
  const checkbox = control(state, 1358);
  const before = await observedShortGameCheckbox(checkbox);
  const beforeScreenshot = await shot(`${label}-before`);
  const sessionBefore = await observedShortGame();
  await record(`${label}-observed`, { before, sessionBefore, wanted, screenshot: beforeScreenshot });
  assert(before.checked !== null, 'UNKNOWN native ShortGame checkbox pixels; no input sent');
  let after = before;
  if (before.checked !== wanted) {
    await delay(1300);
    // The square is at the left edge; clicking its label can miss the skinned
    // checkbox. This press intentionally has no preceding move and lasts 80 ms.
    await click(checkbox.rect[0] + 8, (checkbox.rect[1] + checkbox.rect[3]) / 2, 'no-move', 'left', 80);
    try {
      await waitFor(`${label} native checkbox pixels`, async () => {
        after = await observedShortGameCheckbox(checkbox);
        return after.checked === wanted;
      });
    } catch (error) {
      await record(`${label}-unverified`, {
        before,
        after,
        wanted,
        screenshot: await shot(`${label}-unverified`),
        verified: false,
      });
      throw error;
    }
  }
  after = await observedShortGameCheckbox(checkbox);
  const sessionAfter = await observedShortGame();
  const screenshot = await shot(label);
  await record(label, {
    controlId: checkbox.id,
    rect: checkbox.rect,
    before: before.checked,
    after: after.checked,
    beforePixels: before,
    afterPixels: after,
    wanted,
    clicked: before.checked !== wanted,
    holdMs: before.checked !== wanted ? 80 : null,
    mode: 'no-move',
    sessionBefore,
    sessionAfter,
    sessionAddress: '0xA8B262',
    sessionScope: 'latched on Skirmish Start; may remain stale before Start',
    screenshot,
    verified: after.checked === wanted,
  });
  assert.equal(after.checked, wanted, 'Original ShortGame checkbox observed at requested value');
}
async function restoreTeamPreferences(teams, api, endingState, runBrowserEnd) {
  const restoration = { met: false, original: teams, steps: [], ending: null };
  const restorationLimitMs = o.ai === 'hard' ? 180000 : 120000;
  const deadline = Date.now() + restorationLimitMs;
  const remaining = () => {
    if (stopping) throw new Error('Team restoration interrupted by session cleanup');
    const milliseconds = deadline - Date.now();
    if (milliseconds <= 0) throw new Error(`Team restoration exceeded its ${restorationLimitMs / 1000} second limit`);
    return milliseconds;
  };
  const stageWait = (label, observe, milliseconds = 15000) => wait(label, observe, Math.min(milliseconds, remaining()));
  const singlePlayer = (state) => control(state, /Skirmish/i) && control(state, /MainMenu/i);
  try {
    remaining();
    let current = await inputState();
    if (!control(current, 1559) && !control(current, 1667) && !singlePlayer(current)) {
      const knownOptions = control(current, /resume.*mission|abort.*mission|save.?game|load.?game/i);
      const knownEnding = control(current, /score|defeat|victory|mission.?failed|^(?:GUI:)?Continue$/i);
      if (current.modal && !knownOptions && !knownEnding)
        throw new Error('UNVERIFIED: an unrelated native modal prevents safe team restoration');
      const state = await commandState();
      if (!endingState.attempted && ((state?.localHouse >= 0 && state.view) || knownOptions || knownEnding)) {
        endingState.attempted = true;
        endingState.result = await runBrowserEnd(api);
        restoration.ending = endingState.result;
        await record('restoration-ending', endingState.result);
        remaining();
        current = await inputState();
      }
      if (
        endingState.attempted &&
        !endingState.result?.met &&
        !control(current, 1559) &&
        !control(current, 1667) &&
        !singlePlayer(current)
      ) {
        // A failed natural defeat attempt must not strand changed preferences.
        // Abort restores preferences through its normal direct-to-setup route;
        // a failed natural defeat attempt retains its own earlier failure.
        restoration.fallbackEnding = await runBrowserEnd({ ...api, eliminateHuman: false });
        await record('restoration-abort-fallback', restoration.fallbackEnding);
        remaining();
        current = await inputState();
      }
    }
    if (control(current, 1667)) {
      remaining();
      await clickControl(1667, 'restore-single-player', 'no-move');
      current = await stageWait('restore single player', async () => {
        const state = await inputState();
        return singlePlayer(state) ? state : null;
      });
    }
    if (singlePlayer(current) && !control(current, 1559)) {
      remaining();
      await clickControl(/Skirmish/i, 'restore-skirmish', 'quick');
      current = await stageWait('restore setup', async () => {
        const state = await inputState();
        return control(state, 1559) ? state : null;
      });
    }
    if (!control(current, 1559))
      throw new Error('UNVERIFIED: original skirmish setup is unavailable for team restoration');
    await delay(1300);
    if (api.originalAi) {
      const { restoreBrowserAiSettings } = await import('./browser-ai-settings.mjs');
      restoration.ai = await restoreBrowserAiSettings({ ...api, wait: stageWait }, api.originalAi);
      await record('ai-preferences-restored', restoration.ai);
      assert(restoration.ai.met, 'Original five AI preferences restored through native menus');
    }
    for (const team of teams) {
      remaining();
      await chooseTeam(team, team.selection, stageWait);
      restoration.steps.push({ id: team.id, selection: control(await inputState(), team.id)?.combo?.selection });
    }
    await setShortGame(api.originalShortGame, 'restore-short-game', stageWait);
    assert(
      restoration.steps.every((team, index) => team.selection === teams[index].selection),
      'Original teams restored',
    );
    await record('team-preferences-restored', restoration.steps);
    remaining();
    await clickControl(1472, 'restore-setup-back', 'no-move');
    await stageWait('restore single-player menu', async () => singlePlayer(await inputState()));
    await clickControl(/MainMenu/i, 'restore-main-menu', 'no-move');
    const menu = await stageWait('restored main menu', async () => control(await inputState(), 1667));
    restoration.shortGame = await readShortGamePreference();
    assert.equal(restoration.shortGame, api.originalShortGame, 'Original ShortGame preference restored');
    restoration.mainMenu = menu;
    restoration.met = true;
  } catch (error) {
    restoration.error = String(error.stack || error);
    restoration.verification = 'UNVERIFIED: original team preferences or final menu were not restored';
  }
  await record('team-preferences-restoration', restoration);
  return restoration;
}
async function reproduce() {
  await shot('main-menu');
  const initial = await inputState();
  await record('main-menu-ready', initial);
  await clickControl(1667, 'first-single-player-click', 'no-move');
  await delay(6000);
  let s = await inputState();
  const firstWorked = !!control(s, /Skirmish/i);
  if (!firstWorked) await clickControl(1667, 'repeat-single-player-click', 'no-move');
  s = await wait('single player', async () => {
    const s = await inputState();
    return control(s, /Skirmish/i) ? s : null;
  });
  await shot('single-player');
  await clickControl(/Skirmish/i, 'no-move-skirmish-click', 'no-move');
  await delay(6000);
  await shot('after-skirmish-click');
  s = await inputState();
  await record('click-reproduction', {
    firstWorked,
    skirmishWorked: !!control(s, /StartGame/i),
    state: s,
    events: await page.evaluate(() => window.__browserInputs),
  });
}
async function accept() {
  const { runBrowserBattleInput, runBrowserEnd } = await import('./browser-battle-input.mjs');
  const { applyBrowserAiSettings } = await import('./browser-ai-settings.mjs');
  const toolbarToggle = page.locator('#vm-controls-toggle');
  if ((await toolbarToggle.getAttribute('aria-expanded')) === 'true') await toolbarToggle.click();
  assert.equal(
    await toolbarToggle.getAttribute('aria-expanded'),
    'false',
    'Toolbar collapsed before native menu input',
  );
  await record('toolbar-collapsed', { expanded: await toolbarToggle.getAttribute('aria-expanded') });
  await shot('main-menu');
  await clickControl(1667, 'single-player', 'no-move');
  await wait('single player', async () => control(await inputState(), /Skirmish/i));
  await clickControl(/Skirmish/i, 'skirmish', 'quick');
  const setup = await wait('skirmish setup', async () => {
    const s = await inputState();
    return control(s, 1559) ? s : null;
  });
  await record('skirmish-setup', setup);
  // Play the owner's saved six-player configuration. Select each actual native
  // combo with trusted browser input; never write game memory.
  const teams = setup.controls
    .filter((c) => usable(c) && c.class === 'ComboBox' && c.id >= 1901 && c.id <= 1906)
    .sort((a, b) => a.id - b.id);
  assert.equal(teams.length, 6, 'six visible team controls');
  const originalTeams = await savedTeamPreferences(teams);
  const originalShortGame = await savedShortGamePreference();
  const api = {
    page,
    click,
    point,
    commandState,
    readBytes,
    inputState,
    shot,
    record,
    wait,
    originalShortGame,
    originalAi: null,
    eliminateHuman: false,
    selectionComparison: o['interactions-only'],
    reviewNativePopupRequest,
  };
  const endingState = { attempted: false, result: null };
  let primaryError = null;
  try {
    await delay(1300);
    const aiSettings = await applyBrowserAiSettings(api, {
      out,
      preset: o.ai,
      source: stamp,
      onBaseline: (original) => {
        api.originalAi = original;
      },
    });
    await record('six-player-match-ai', aiSettings);
    assert(aiSettings.met, 'Five actual AI slots use the requested real difficulty choices');
    const matchTeams = originalTeams.map((team, index) => ({
      id: team.id,
      selection:
        o.teams === 'free-for-all' ? 0 : o.teams === 'three-versus-three' ? (index < 3 ? 1 : 2) : team.selection,
    }));
    for (const team of teams) {
      const match = matchTeams.find((saved) => saved.id === team.id);
      assert(match, 'Each actual team control must have a six-player match selection');
      await chooseTeam(team, match.selection);
    }
    const matchShortGame = o['short-game'] === 'original' ? originalShortGame : o['short-game'] === 'true';
    await setShortGame(matchShortGame, 'match-short-game');
    const selectedTeams = (await inputState()).controls.filter((c) => teams.some((t) => t.id === c.id));
    assert(
      matchTeams.every((saved) => selectedTeams.find((c) => c.id === saved.id)?.combo?.selection === saved.selection),
      'Acceptance match uses the six requested team selections',
    );
    await record('six-player-match-teams', {
      preset: o.teams,
      original: originalTeams,
      match: matchTeams,
      before: teams.map((c) => ({ id: c.id, selection: c.combo.selection })),
      after: selectedTeams,
    });
    await shot('skirmish-setup');
    await clickControl(1559, 'start-six-player', 'no-move');
    await wait('HD visible', () => page.evaluate(() => window.__hdBridge?.diagnostics?.shown), 120000);
    const state = await wait(
      'first live command snapshot',
      async () => {
        const s = await commandState();
        return s?.localHouse >= 0 && s?.view ? s : null;
      },
      30000,
    );
    const vector = Buffer.from(await readBytes(0xa80228, 20));
    const count = vector.readInt32LE(16);
    assert(count >= 6 && count <= 32);
    const pointers = Buffer.from(await readBytes(vector.readUInt32LE(4), count * 4));
    const allHouses = [];
    for (let i = 0; i < count; i++) {
      const p = pointers.readUInt32LE(i * 4);
      const name = Buffer.from(await readBytes(p + 0x15ff4, 21))
        .toString('ascii')
        .split('\0')[0];
      const human = (await readBytes(p + 0x1ec, 1))[0] !== 0;
      const allies = Buffer.from(await readBytes(p + 0x5788, 4)).readUInt32LE();
      allHouses.push({ index: i, pointer: p, name, human, allies });
    }
    const houses = allHouses.filter((h) => !/^(Neutral|Special)$/i.test(h.name));
    const localAllies = allHouses.find((house) => house.index === state.localHouse)?.allies;
    assert(Number.isInteger(localAllies), 'Actual local house allies must be available');
    api.alliedHouses = houses.filter((house) => (localAllies & (1 << house.index)) !== 0).map((house) => house.index);
    assert.equal(houses.length, 6, 'six actual players');
    assert.equal(await observedShortGame(), matchShortGame, 'Original engine latched the requested native checkbox');
    await record('HD-first-frame', {
      houses,
      allHouses,
      matchShortGame,
      frame: state.frame,
      counters: await page.evaluate(() => window.__hdBridge.diagnostics.counters),
      timeline: await page.evaluate(() => window.__hdBridge.timeline),
      preparationStalls: await page.evaluate(() => window.__hdBridge.stalls),
    });
    assert.equal(await toolbarToggle.getAttribute('aria-expanded'), 'false', 'Toolbar remains collapsed');
    await record('toolbar-remains-collapsed', { expanded: await toolbarToggle.getAttribute('aria-expanded') });
    const interactions = await runBrowserBattleInput(api);
    await record('interactions', interactions);
    assert(interactions.met, interactions.error);
    await record('battle-mirror-footprint', await mirrorFootprint());
    await record('battle-map-descriptor', await mapDescriptor());
    if (o['interactions-only']) {
      await record('interactions-only', { met: true, performance: 'not requested' });
      return;
    }
    api.eliminateHuman = o.mode !== 'visual';
    if (!o.scout) {
      const before = await commandState();
      for (const key of ['KeyH', 'KeyP', 'KeyS']) {
        await page.keyboard.down(key);
        try {
          await delay(120);
        } finally {
          await page.keyboard.up(key);
        }
        await delay(120);
      }
      const after = await commandState();
      const selectedCombatants = (after?.objects ?? []).filter(
        (object) =>
          object.owner === after.localHouse &&
          object.selected &&
          object.health > 0 &&
          ['vehicle', 'infantry', 'aircraft'].includes(object.kind),
      );
      assert(selectedCombatants.length > 0, 'Real P selected the local combatants before Stop');
      await record('combat-retain-local-army', {
        keys: ['KeyH', 'KeyP', 'KeyS'],
        holdMs: 120,
        source: 'Original CenterBase H, CombatantSelect P and StopObject S hotkeys',
        before,
        after,
        selectedCombatants: selectedCombatants.map(({ uid, type, mission, queuedMission, destination }) => ({
          uid,
          type,
          mission,
          queuedMission,
          destination,
        })),
        scoutSkipped: 'Keep the selected human army near its base for the natural fight',
      });
    } else {
      const { scoutForCombat } = await import('./browser-combat-scout.mjs');
      await record('combat-scout', await scoutForCombat(api));
    }
    let performance = { met: false };
    if (o.mode === 'visual') {
      performance = await captureVisualFight();
    } else {
      report.windows = [];
      const identity = await worker().evaluate(() => ({
        pid: globalThis.__auditCore.hello.pid,
        sha256: globalThis.__auditCore.hello.exe.sha256,
      }));
      const map = await page.evaluate(() => window.__hdBridge.timeline.map);
      for (let index = 1; index <= Number(o['fight-windows']); index++) {
        const beganAt = new Date().toISOString();
        report.activeWindow = index;
        for (const field of [
          'nativeBefore',
          'nativeAfter',
          'footprintBefore',
          'footprintAfter',
          'logicBefore',
          'logicAfter',
          'mapDescriptorBefore',
          'mapDescriptorAfter',
          'fightSamples',
          'captureCamera',
          'combatObserver',
          'capturePath',
          'captureUnavailable',
        ])
          delete report[field];
        performance = { met: false };
        await record('measurement-window-start', { index, identity, map });
        let error = null;
        try {
          const currentIdentity = await worker().evaluate(() => ({
            pid: globalThis.__auditCore.hello.pid,
            sha256: globalThis.__auditCore.hello.exe.sha256,
          }));
          assert.deepEqual(currentIdentity, identity, 'Disjoint windows keep the same owned game');
          assert.equal(await page.evaluate(() => window.__hdBridge.timeline.map), map);
          const currentCommand = await commandState();
          assert(currentCommand?.localHouse === state.localHouse, 'Disjoint windows keep the same local human');
          assert(currentCommand.frame >= state.frame, 'Game logic advances without a restart');
          if (o.harass) {
            const { attackVisibleEnemyBuilding } = await import('./browser-combat-attack.mjs');
            await record('combat-attack', await attackVisibleEnemyBuilding(api));
          }
          performance = await measureFight(index);
        } catch (failure) {
          error = String(failure.stack || failure);
          await record('measurement-error', { index, error });
        }
        const archive = { index, beganAt, endedAt: new Date().toISOString(), identity, map, error, ...performance };
        for (const field of [
          'nativeBefore',
          'nativeAfter',
          'footprintBefore',
          'footprintAfter',
          'logicBefore',
          'logicAfter',
          'mapDescriptorBefore',
          'mapDescriptorAfter',
          'fightSamples',
          'captureCamera',
          'combatObserver',
          'capturePath',
          'captureUnavailable',
        ])
          archive[field] = report[field] ?? null;
        const windowPath = join(out, `${stamp}-window-${index}.json`);
        await writeFile(windowPath, JSON.stringify(archive, null, 2), { flag: 'wx' });
        report.windows.push({
          index,
          windowPath,
          capturePath: archive.capturePath,
          met: performance.met,
          numbers: performance.numbers ?? null,
          error,
        });
        await record('measurement-window-finished', report.windows.at(-1));
        if (performance.met) {
          report.selectedWindow = index;
          break;
        }
        const currentInput = await inputState();
        if (control(currentInput, /Score|Defeat|Victory|Continue/i)) {
          await record('measurement-stopped-for-genuine-ending', currentInput);
          break;
        }
        if (!(await commandState())) {
          await record('measurement-stopped-for-unavailable-command', {
            input: currentInput,
            diagnostics: await page.evaluate(() => window.__hdBridge.diagnostics.getVmDiagnostics()),
          });
          break;
        }
      }
    }
    endingState.attempted = true;
    endingState.result = await runBrowserEnd(api);
    await record('ending', endingState.result);
    await record(
      'ending-native-diagnostics',
      await page.evaluate(() => window.__hdBridge.diagnostics.getVmDiagnostics()),
    );
    assert(endingState.result.met, endingState.result.error);
    assert(
      performance.met,
      o.mode === 'visual' ? 'Independent same-frame visual audit' : 'browser 60 second cadence or HD frame-rate target',
    );
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    // Restore through original menus on both success and failure. Keep the
    // first acceptance failure when restoration itself cannot reach the UI.
    try {
      const restoration = await restoreTeamPreferences(originalTeams, api, endingState, runBrowserEnd);
      if (restoration.met) {
        await delay(1800);
        await shot('settled-restored-main-menu');
        await record(
          'restored-main-native-diagnostics',
          await page.evaluate(() => window.__hdBridge.diagnostics.getVmDiagnostics()),
        );
      }
      if (!restoration.met && !primaryError) throw new Error(restoration.error);
    } catch (error) {
      if (!primaryError) throw error;
      console.error('Team restoration also failed:', String(error.message || error));
    }
  }
}
// The observer follows visible effects and the game's own newest radar alert.
// Camera mutations are real browser keys, with the pointer away from edges.
const combatAlerts = { lastEventKey: null, nextPollAt: 0, jumps: [] };
async function focusCombat(zFactor, timeout = 240000) {
  const until = Date.now() + Math.min(timeout, 240000);
  const actions = [];
  let target = null,
    combat,
    consecutive = 0,
    lastCombatFrame = null,
    alertPolls = 0;
  const pollAlert = async () => {
    combatAlerts.nextPollAt = Date.now() + 1000;
    alertPolls++;
    return commandState();
  };
  while (Date.now() < until) {
    // Observe inside the page: shroud and animation layers must never be
    // serialized through Playwright on each combat-search iteration.
    combat = await page.evaluate(
      ({ source, zFactor }) => {
        const observe = Function(`return (${source})`)();
        return observe(window.__hdBridge.diagnostics.combatState, zFactor);
      },
      { source: observePageCombat.toString(), zFactor },
    );
    const state = { view: combat.view };
    if (combat.inView) {
      if (combat.frame !== lastCombatFrame) consecutive++;
      lastCombatFrame = combat.frame;
      if (consecutive >= 3) {
        await record('combat-camera', { actions, combat, alertPolls });
        return combat;
      }
      await delay(100);
      continue;
    }
    consecutive = 0;
    lastCombatFrame = null;
    if (Date.now() >= combatAlerts.nextPollAt) {
      const before = await pollAlert();
      const event = before?.lastEvent;
      const key = event ? `${event.x},${event.y}` : null;
      combatAlerts.jumps = combatAlerts.jumps.filter((at) => Date.now() - at < 240000);
      if (key && key !== combatAlerts.lastEventKey && combatAlerts.jumps.length < 24 && combat.bounds) {
        combatAlerts.lastEventKey = key;
        const x = (combat.bounds.left + combat.bounds.right) / 2,
          y = (combat.bounds.top + combat.bounds.bottom) / 2;
        const [px, py] = await point(x, y);
        await page.mouse.move(px, py);
        combatAlerts.jumps.push(Date.now());
        await page.keyboard.down('Space');
        try {
          await delay(120);
        } finally {
          await page.keyboard.up('Space');
        }
        // Keep both command snapshots outside the saved performance window and
        // separated by at least one second. The event is not an enemy lookup.
        await delay(Math.max(0, combatAlerts.nextPollAt - Date.now()));
        const after = await pollAlert();
        const action = {
          key: 'Space',
          ms: 120,
          pointer: { x, y },
          before: { frame: before?.frame, view: before?.view, lastEvent: event },
          after: { frame: after?.frame, view: after?.view, lastEvent: after?.lastEvent },
          jumpsIn240Seconds: combatAlerts.jumps.length,
        };
        actions.push(action);
        await record('combat-radar-alert-jump', action);
        target = null;
        continue;
      }
      if (!key) combatAlerts.lastEventKey = null;
    }
    if (combat.visible)
      target = combat.effects.reduce((a, b) =>
        Math.hypot(a.pixel.x - 640, a.pixel.y - 360) < Math.hypot(b.pixel.x - 640, b.pixel.y - 360) ? a : b,
      );
    if (target && combat.bounds && state?.view) {
      const x = (combat.bounds.left + combat.bounds.right) / 2,
        y = (combat.bounds.top + combat.bounds.bottom) / 2;
      const dx = target.worldPixel.x - state.view.x - x,
        dy = target.worldPixel.y - state.view.y - y;
      const horizontal = Math.abs(dx) > Math.abs(dy),
        delta = horizontal ? dx : dy;
      if (Math.abs(delta) > 32) {
        const [px, py] = await point(x, y);
        await page.mouse.move(px, py);
        const key = horizontal ? (delta > 0 ? 'ArrowRight' : 'ArrowLeft') : delta > 0 ? 'ArrowDown' : 'ArrowUp';
        const ms = Math.min(350, Math.max(60, Math.abs(delta) * 0.5));
        await page.keyboard.down(key);
        try {
          await delay(ms);
        } finally {
          await page.keyboard.up(key);
        }
        actions.push({ key, ms, before: state.view, target: target.worldPixel });
        await delay(120);
        continue;
      }
      target = null;
    }
    await delay(100);
  }
  await record('combat-camera', { actions, combat, alertPolls });
  throw new Error('No visible fight after real browser camera search');
}
async function captureVisualFight() {
  const zFactor = Buffer.from(await readBytes(0xb0cd48, 8)).readDoubleLE();
  const before = await commandState();
  assert(before, 'Visual audit starts in a coherent living battle');
  const identity = await worker().evaluate(() => ({
    pid: globalThis.__auditCore.hello.pid,
    sha256: globalThis.__auditCore.hello.exe.sha256,
  }));
  const map = await page.evaluate(() => window.__hdBridge.timeline.map);
  const originalUrl = new URL(page.url());
  originalUrl.searchParams.delete('hd-passthrough');
  let pair = { met: false };
  try {
    const former = worker();
    let closed = false;
    former.once('close', () => (closed = true));
    const visualUrl = new URL(page.url());
    visualUrl.searchParams.set('hd-passthrough', 'none');
    await page.goto(visualUrl.href);
    await wait('normal worker closed before visual comparison', () => closed, 10000);
    await wait(
      'visual comparison HD visible',
      () => page.evaluate(() => window.__hdBridge?.diagnostics?.shown),
      120000,
    );
    await focusGameCanvas('visual-comparison-canvas-focus');
    await record('independent-visual-audit', {
      identity,
      map,
      localHouse: before.localHouse,
      mode: 'existing hd-passthrough=none; no performance acceptance from this run',
    });
    await focusCombat(zFactor);
    await shot('fight-HD-visual-only');
    const { captureSameFramePair } = await import('./browser-frame-pair.mjs');
    pair = await captureSameFramePair({
      page,
      worker: worker(),
      out,
      prefix: `${stamp}-visual-only`,
      combatObserverSource: observePageCombat.toString(),
      zFactor,
    });
    await record('same-frame-visual-only-picture-pair', pair);
  } catch (error) {
    pair = { ...pair, met: false, error: String(error.stack || error) };
    await record('visual-audit-error', pair);
  } finally {
    try {
      const former = worker();
      let closed = false;
      former.once('close', () => (closed = true));
      await page.goto(originalUrl.href);
      await wait('visual observer worker closed', () => closed, 10000);
      await wait(
        'same native identity after visual audit',
        async () => {
          try {
            return await worker()?.evaluate((pid) => globalThis.__auditCore?.hello?.pid === pid, identity.pid);
          } catch {
            return false;
          }
        },
        120000,
      );
      await wait(
        'normal mode shown after visual audit',
        () => page.evaluate(() => window.__hdBridge?.diagnostics?.shown),
        120000,
      );
      await focusGameCanvas('visual-audit-normal-canvas-focus');
      const state = await wait(
        'normal coherent command after visual audit',
        async () => {
          const command = await commandState();
          return command?.localHouse === before.localHouse ? command : null;
        },
        30000,
      );
      const restored = await page.evaluate(() => ({
        map: window.__hdBridge.timeline.map,
        passthrough: window.__hdBridge.passthrough,
        shown: window.__hdBridge.diagnostics.shown,
        requested: new URL(location.href).searchParams.get('hd-passthrough'),
      }));
      const actualIdentity = await worker().evaluate(() => ({
        pid: globalThis.__auditCore.hello.pid,
        sha256: globalThis.__auditCore.hello.exe.sha256,
      }));
      const diagnostics = await page.evaluate(() => window.__hdBridge.diagnostics.getVmDiagnostics());
      await record('visual-audit-normal-restoration', {
        identity: actualIdentity,
        restored,
        frame: state.frame,
        localHouse: state.localHouse,
        workerClosed: closed,
        diagnostics,
      });
      assert.deepEqual(actualIdentity, identity);
      assert.equal(restored.map, map);
      assert.equal(restored.requested, null);
      assert.equal(restored.passthrough.flags, 7);
      assert.equal(restored.passthrough.keyed, true);
      assert.equal(restored.shown, true);
      assert(state.frame >= before.frame);
      assert.equal(diagnostics.native.mirrorComplete, true);
      assert.equal(diagnostics.native.teardownFailures, 0);
      await shot('normal-mode-restored-after-visual-audit');
    } catch (error) {
      pair = { ...pair, met: false, restorationError: String(error.stack || error) };
      await record('visual-audit-normal-restoration-error', {
        error: pair.restorationError,
        earlierError: pair.error ?? null,
        diagnostics: await page.evaluate(() => window.__hdBridge?.diagnostics?.getVmDiagnostics()).catch(() => null),
        input: await inputState().catch(() => null),
        footprint: await mirrorFootprint().catch(() => null),
      });
    }
  }
  return { pair, met: pair.met, performance: 'Not measured in this independent visual-only run' };
}
async function measureFight(index = 1) {
  const raw = Buffer.from(await readBytes(0xb0cd48, 8));
  const zFactor = raw.readDoubleLE();
  const combat = await focusCombat(zFactor, index === 1 ? 240000 : 90000);
  await record('fight-visible', combat);
  if (index === 1) {
    await shot('fight-HD');
    await page.keyboard.press('Backslash');
    await wait('original picture', () => page.evaluate(() => !window.__hdBridge.diagnostics.enabled));
    await delay(600);
    await shot('fight-original');
    await page.keyboard.press('Backslash');
    await wait('HD restored', () => page.evaluate(() => window.__hdBridge.diagnostics.shown));
    await delay(1500);
    const displayCadence = await page.evaluate(async () => {
      const timestamps = [];
      await new Promise((resolve) => {
        const tick = (at) => {
          timestamps.push(at);
          if (timestamps.length >= 121) resolve();
          else requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
      const intervals = timestamps
        .slice(1)
        .map((at, i) => at - timestamps[i])
        .sort((a, b) => a - b);
      const medianMs = intervals[Math.floor(intervals.length / 2)];
      return { samples: intervals.length, medianMs, observedHz: 1000 / medianMs };
    });
    await record('display-cadence', displayCadence);
  }
  report.nativeBefore = await page.evaluate(() => window.__hdBridge.diagnostics.getVmDiagnostics());
  report.footprintBefore = await mirrorFootprint();
  report.mapDescriptorBefore = await mapDescriptor();
  await shot(`window-${index}-fight-start`);
  await save();
  const observer = await startBrowserCombatObserver(page, observePageCombat.toString(), zFactor);
  let start,
    observed,
    captureError = null;
  const captureCamera = [];
  let cameraAt = 0;
  const measureEnd = Date.now() + Number(o.seconds) * 1000;
  try {
    start = await commandState();
    report.logicBefore = await page.evaluate(() => window.__hdBridge.diagnostics.getGamePerformance());
    while (Date.now() < measureEnd) {
      await delay(Math.max(0, Math.min(250, measureEnd - Date.now())));
      const c = await observer.latest();
      if (!c) continue;
      // Follow only effects already visible to this player. Camera keys are real
      // browser input; the independent bridge scheduler continues during the hold.
      if (!c.inView && c.visible && c.stateAgeMs <= 150 && c.bounds && c.view && Date.now() - cameraAt >= 1000) {
        const x = (c.bounds.left + c.bounds.right) / 2,
          y = (c.bounds.top + c.bounds.bottom) / 2;
        const target = c.effects.reduce((a, b) =>
          Math.hypot(a.pixel.x - x, a.pixel.y - y) < Math.hypot(b.pixel.x - x, b.pixel.y - y) ? a : b,
        );
        const dx = target.worldPixel.x - c.view.x - x,
          dy = target.worldPixel.y - c.view.y - y;
        const horizontal = Math.abs(dx) > Math.abs(dy),
          delta = horizontal ? dx : dy;
        if (Math.abs(delta) > 32 && measureEnd - Date.now() >= 400) {
          const [px, py] = await point(x, y);
          await page.mouse.move(px, py);
          const key = horizontal ? (delta > 0 ? 'ArrowRight' : 'ArrowLeft') : delta > 0 ? 'ArrowDown' : 'ArrowUp';
          const ms = Math.min(250, Math.max(60, Math.abs(delta) * 0.5));
          cameraAt = Date.now();
          await page.keyboard.down(key);
          try {
            await delay(ms);
          } finally {
            await page.keyboard.up(key);
          }
          captureCamera.push({ at: cameraAt, frame: c.frame, key, ms, before: c.view, target: target.worldPixel });
        }
      }
    }
  } catch (error) {
    captureError = error;
  } finally {
    report.captureCamera = captureCamera;
    try {
      observed = await observer.stop();
    } catch (error) {
      report.captureUnavailable = String(error.stack || error);
      captureError ??= error;
    }
    if (observed) {
      report.capturePath = join(out, `${stamp}-window-${index}-capture.json`);
      await writeFile(report.capturePath, JSON.stringify(observed.capture), { flag: 'wx' });
      report.fightSamples = observed.samples;
      report.combatObserver = {
        truncated: observed.truncated,
        animsTruncated: observed.animsTruncated,
        startAtMs: observed.startAtMs,
      };
    }
    await save();
  }
  if (captureError) throw captureError;
  const fightSamples = observed.samples;
  report.fightSamples = fightSamples;
  report.combatObserver = {
    source:
      'page rAF; at most 20 Hz and each observed delivered logic frame once; arrival/draw counters independently retain all deliveries',
    truncated: observed.truncated,
    animsTruncated: observed.animsTruncated,
    muzzleEvidence:
      'First native id+uid sighting only; pre-window and offscreen identities are primed; supplied weapon Anim references GUNFIRE/APMUZZLE/VTMUZZLE only',
    startAtMs: observed.startAtMs,
    costsMs: observed.costsMs,
  };
  report.captureCamera = captureCamera;
  const capture = observed.capture;
  await shot(`window-${index}-fight-end`);
  const end = await commandState();
  report.logicAfter = await page.evaluate(() => window.__hdBridge.diagnostics.getGamePerformance());
  report.nativeAfter = await page.evaluate(() => window.__hdBridge.diagnostics.getVmDiagnostics());
  report.footprintAfter = await mirrorFootprint();
  report.mapDescriptorAfter = await mapDescriptor();
  const times = [capture.startAtMs, ...capture.deliveries.map((d) => d.atMs), capture.endAtMs];
  const gaps = times
    .slice(1)
    .map((t, i) => t - times[i])
    .sort((a, b) => a - b);
  const quant = (q) => gaps[Math.ceil(q * gaps.length) - 1];
  const seconds = (capture.endAtMs - capture.startAtMs) / 1000;
  const logicBefore = report.logicBefore,
    logicAfter = report.logicAfter;
  const logicIntervalMs =
    Number.isFinite(logicBefore?.sampledAtMs) && Number.isFinite(logicAfter?.sampledAtMs)
      ? logicAfter.sampledAtMs - logicBefore.sampledAtMs
      : null;
  const logicDelta =
    Number.isFinite(logicBefore?.frame) && Number.isFinite(logicAfter?.frame)
      ? logicAfter.frame - logicBefore.frame
      : null;
  const logicPerSecond =
    logicIntervalMs > 0 && logicDelta !== null && logicDelta >= 0 ? (logicDelta * 1000) / logicIntervalMs : null;
  const seenCombat = new Set();
  const uniqueCombat = fightSamples.filter((sample) => {
    if (!sample.inView || sample.stateAgeMs > 150 || seenCombat.has(sample.frame)) return false;
    seenCombat.add(sample.frame);
    return true;
  });
  const nativeBefore = report.nativeBefore?.native,
    nativeAfter = report.nativeAfter?.native;
  const mirrorDeltas = Object.fromEntries(
    ['truncatedUpdates', 'invalidUpdates', 'budgetOverruns', 'mirrorMisses', 'droppedUpdates'].map((key) => [
      key,
      Number.isFinite(nativeBefore?.[key]) && Number.isFinite(nativeAfter?.[key])
        ? nativeAfter[key] - nativeBefore[key]
        : null,
    ]),
  );
  const numbers = {
    window: index,
    seconds,
    distinctStates: capture.distinctStates,
    statesPerSecond: capture.distinctStates / seconds,
    p50Ms: quant(0.5),
    p99Ms: quant(0.99),
    maxMs: gaps.at(-1),
    drawnPerSecond: capture.drawnFrames / seconds,
    shownPerSecond: capture.shownFrames / seconds,
    logicPerSecond,
    logicIntervalMs,
    logicFrames: [logicBefore?.frame ?? null, logicAfter?.frame ?? null],
    commandFrames: [start?.frame ?? null, end?.frame ?? null],
    battleEnded: end === null,
    activeLogicDiagnostics: [logicBefore, logicAfter].map((sample) =>
      sample
        ? {
            status: sample.status,
            logicFps: sample.logicFps,
            intervalMs: sample.intervalMs,
            targetFps: sample.targetFps,
          }
        : null,
    ),
    firstShownDrawAtMs: (await page.evaluate(() => window.__hdBridge.diagnostics.counters)).firstShownDrawAtMs,
    fightSamples: fightSamples.length,
    samplesWithVisibleEffects: fightSamples.filter((s) => s.inView > 0).length,
    distinctFreshCombatSamples: uniqueCombat.length,
    freshMuzzleEvents: uniqueCombat.reduce(
      (sum, sample) => sum + sample.effects.filter((effect) => effect.kind === 'muzzle').length,
      0,
    ),
    projectileOrBeamFrames: uniqueCombat.filter((sample) => sample.effects.some((effect) => effect.kind !== 'muzzle'))
      .length,
    freshCombatTenSecondBuckets: Array.from(
      { length: 6 },
      (_, bucket) =>
        uniqueCombat.filter((sample) => {
          const seconds = (sample.atMs - capture.startAtMs) / 1000;
          return seconds >= bucket * 10 && seconds < (bucket + 1) * 10;
        }).length,
    ),
    mirrorDeltas,
    completeMirrorEndpoints: nativeBefore?.mirrorComplete === true && nativeAfter?.mirrorComplete === true,
    combatSpanSeconds: (() => {
      const samples = uniqueCombat;
      return samples.length > 1 ? (samples.at(-1).atMs - samples[0].atMs) / 1000 : 0;
    })(),
  };
  numbers.cadenceMet =
    numbers.statesPerSecond >= 55 &&
    numbers.p99Ms <= 50 &&
    numbers.maxMs <= 150 &&
    numbers.shownPerSecond >= 55 &&
    numbers.logicPerSecond !== null;
  numbers.mirrorQualityMet =
    numbers.completeMirrorEndpoints &&
    ['truncatedUpdates', 'invalidUpdates', 'budgetOverruns', 'mirrorMisses'].every(
      (key) => numbers.mirrorDeltas[key] === 0,
    );
  numbers.visibleFightMet =
    !observed.truncated && !observed.animsTruncated && numbers.freshCombatTenSecondBuckets.every((count) => count > 0);
  numbers.met = !numbers.battleEnded && numbers.cadenceMet && numbers.mirrorQualityMet && numbers.visibleFightMet;
  await record('browser-60s', numbers);
  if (o['skip-comparison']) {
    const pair = {
      met: false,
      skipped:
        'Explicit independent normal-performance run; inspect the separately saved visual-only pair for visual acceptance',
    };
    await record('same-frame-picture-pair', pair);
    return { numbers, pair, met: numbers.met };
  }
  if (numbers.battleEnded) {
    const pair = { met: false, skipped: 'Battle ended before the saved 60-second window completed' };
    await shot('battle-ended-after-capture');
    await record('same-frame-picture-pair', pair);
    return { numbers, pair, met: false };
  }
  await shot('fight-HD-after');
  await focusCombat(zFactor, 60000);
  const { captureSameFramePair } = await import('./browser-frame-pair.mjs');
  const normalPair = await captureSameFramePair({
    page,
    worker: worker(),
    out,
    prefix: stamp,
    combatObserverSource: observePageCombat.toString(),
    zFactor,
  });
  await record('same-frame-normal-picture-pair', normalPair);
  let pair = normalPair;
  const comparisonCommand = await commandState();
  if (!normalPair.met && comparisonCommand) {
    // The normal keyed picture for F contains its tactical colour key. Turning
    // HD off can publish a complete original only after F has advanced. Use
    // the existing non-keyed mode as a separate comparison carrier, after the
    // saved normal-mode measurement; restore the owner's mode before ending.
    const normalUrl = page.url();
    const normalIdentity = await worker().evaluate(() => ({
      pid: globalThis.__auditCore.hello.pid,
      frame: globalThis.__auditCore.memory.frame,
      executableSha256: globalThis.__auditCore.hello.exe.sha256,
    }));
    normalIdentity.localHouse = comparisonCommand.localHouse;
    const normalMap = await page.evaluate(() => window.__hdBridge.timeline.map);
    const visualUrl = new URL(normalUrl);
    visualUrl.searchParams.set('hd-passthrough', 'none');
    try {
      const formerWorker = worker();
      let formerWorkerClosed = false;
      formerWorker.once('close', () => (formerWorkerClosed = true));
      for (const key of ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Space']) await page.keyboard.up(key);
      await page.goto(visualUrl.href);
      await wait('former comparison worker retired', () => formerWorkerClosed, 10000);
      await wait(
        'same native process after visual navigation',
        async () => {
          try {
            return await worker()?.evaluate((pid) => globalThis.__auditCore?.hello?.pid === pid, normalIdentity.pid);
          } catch {
            return false;
          }
        },
        120000,
      );
      await wait('non-keyed visible HD view', () => page.evaluate(() => window.__hdBridge?.diagnostics?.shown), 120000);
      await focusGameCanvas('visual-comparison-canvas-focus');
      const identity = await worker().evaluate(() => ({
        pid: globalThis.__auditCore.hello.pid,
        frame: globalThis.__auditCore.memory.frame,
        executableSha256: globalThis.__auditCore.hello.exe.sha256,
      }));
      const configuration = await page.evaluate(() => ({
        map: window.__hdBridge.timeline.map,
        passthrough: { ...window.__hdBridge.passthrough },
      }));
      const diagnostics = await page.evaluate(() => window.__hdBridge.diagnostics.getVmDiagnostics());
      assert.equal(identity.pid, normalIdentity.pid, 'The comparison uses the same owned game process');
      assert.equal(identity.executableSha256, normalIdentity.executableSha256);
      assert(identity.frame >= normalIdentity.frame, 'The comparison did not restart game logic');
      assert.equal(configuration.map, normalMap, 'The comparison uses the same battle map');
      assert.equal(configuration.passthrough.flags, 0);
      assert.equal(configuration.passthrough.keyed, false);
      const command = await wait(
        'coherent same local house after visual navigation',
        async () => {
          const state = await commandState();
          return state?.localHouse === normalIdentity.localHouse ? state : null;
        },
        30000,
      );
      await record('visual-comparison-ready-state', {
        identity,
        configuration,
        commandFrame: command.frame,
        localHouse: command.localHouse,
        diagnostics,
      });
      assert.equal(command.localHouse, normalIdentity.localHouse, 'The local human house is unchanged');
      assert(command.frame >= comparisonCommand.frame);
      assert.equal(diagnostics.native.mirrorComplete, true);
      assert.equal(diagnostics.native.teardownFailures, 0, 'Disconnect restored the former owned patches');
      await record('visual-only-comparison-carrier', {
        normalIdentity,
        identity,
        localHouse: command.localHouse,
        formerWorkerClosed,
        configuration,
        teardownFailures: diagnostics.native.teardownFailures,
        performanceSource: 'The preceding saved 60 seconds used the normal owner mode',
        overlayScope: 'Native tactical overlays are assessed only in normal-mode browser screenshots',
      });
      await focusCombat(zFactor, 60000);
      await shot('fight-HD-visual-only');
      pair = await captureSameFramePair({
        page,
        worker: worker(),
        out,
        prefix: `${stamp}-visual-only`,
        combatObserverSource: observePageCombat.toString(),
        zFactor,
      });
      await record('same-frame-visual-only-picture-pair', pair);
    } catch (error) {
      pair = { met: false, error: String(error.stack || error), normalAttemptMet: normalPair.met };
      pair.native = await page.evaluate(() => window.__hdBridge?.diagnostics?.getVmDiagnostics()).catch(() => null);
      pair.input = await inputState().catch(() => null);
      pair.footprint = await mirrorFootprint().catch(() => null);
      await shot('visual-comparison-error').catch(() => undefined);
      await record('visual-comparison-error', pair);
    } finally {
      try {
        const formerWorker = worker();
        let formerWorkerClosed = false;
        formerWorker?.once('close', () => (formerWorkerClosed = true));
        await page.goto(normalUrl);
        if (formerWorker) await wait('visual-only worker retired', () => formerWorkerClosed, 10000);
        await wait(
          'same native process restored to normal navigation',
          async () => {
            try {
              return await worker()?.evaluate((pid) => globalThis.__auditCore?.hello?.pid === pid, normalIdentity.pid);
            } catch {
              return false;
            }
          },
          120000,
        );
        await wait(
          'normal HD view or genuine ending after comparison',
          async () => {
            if (await page.evaluate(() => window.__hdBridge?.diagnostics?.shown)) return true;
            return !!control(await inputState(), /Score|Continue/i);
          },
          120000,
        );
        await focusGameCanvas('normal-restoration-canvas-focus');
        const restored = await page.evaluate(() => ({
          shown: window.__hdBridge.diagnostics.shown,
          map: window.__hdBridge.timeline.map,
          passthrough: { ...window.__hdBridge.passthrough },
          requestedMode: new URL(location.href).searchParams.get('hd-passthrough'),
        }));
        const identity = await worker().evaluate(() => ({
          pid: globalThis.__auditCore.hello.pid,
          frame: globalThis.__auditCore.memory.frame,
          executableSha256: globalThis.__auditCore.hello.exe.sha256,
        }));
        const diagnostics = await page.evaluate(() => window.__hdBridge.diagnostics.getVmDiagnostics());
        const command = await wait(
          'normal coherent local command or genuine ending',
          async () => {
            const state = await commandState();
            if (state?.localHouse === normalIdentity.localHouse) return { state };
            return control(await inputState(), /Score|Continue/i) ? { ended: true } : null;
          },
          30000,
        );
        await record('normal-restoration-ready-state', {
          identity,
          restored,
          commandFrame: command.state?.frame ?? null,
          localHouse: command.state?.localHouse ?? null,
          diagnostics,
        });
        assert.equal(restored.requestedMode, new URL(normalUrl).searchParams.get('hd-passthrough'));
        assert.equal(identity.pid, normalIdentity.pid);
        assert.equal(identity.executableSha256, normalIdentity.executableSha256);
        assert(identity.frame >= normalIdentity.frame);
        assert.equal(diagnostics.native.teardownFailures, 0);
        if (restored.shown) {
          assert.equal(restored.map, normalMap);
          assert.equal(restored.passthrough.flags, 7);
          assert.equal(restored.passthrough.keyed, true);
          assert.equal(command.state?.localHouse, normalIdentity.localHouse);
          assert(command.state.frame >= comparisonCommand.frame);
          assert.equal(diagnostics.native.mirrorComplete, true);
        }
        const toggle = page.locator('#vm-controls-toggle');
        if ((await toggle.getAttribute('aria-expanded')) === 'true') await toggle.click();
        assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
        await record('normal-mode-restored-after-comparison', {
          identity,
          restored,
          formerWorkerClosed,
          teardownFailures: diagnostics.native.teardownFailures,
        });
        await shot('normal-mode-restored-after-comparison');
      } catch (error) {
        await record('normal-restoration-error', {
          error: String(error.stack || error),
          earlierComparisonError: pair.error ?? null,
          native: await page.evaluate(() => window.__hdBridge?.diagnostics?.getVmDiagnostics()).catch(() => null),
          input: await inputState().catch(() => null),
          footprint: await mirrorFootprint().catch(() => null),
        });
        pair = { ...pair, met: false, restorationError: String(error.stack || error) };
      }
    }
  }
  await record('same-frame-picture-pair', { ...pair, normalAttemptMet: normalPair.met });
  return {
    numbers,
    pair,
    met: numbers.met && pair.met,
  };
}
async function dllIdentity() {
  const path = join(config.RA2_NATIVE_GAME_DIR || process.env.RA2_NATIVE_GAME_DIR, 'ddraw.dll');
  const stat = await lstat(path).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!stat) return null;
  assert(stat.isFile(), 'Supplied DLL must remain a regular file');
  return {
    sha256: createHash('sha256')
      .update(await readFile(path))
      .digest('hex'),
    mode: stat.mode & 0o777,
  };
}
const portReleased = (port) =>
  new Promise((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port: Number(port) });
    const finish = (released) => {
      socket.destroy();
      resolve(released);
    };
    socket.once('connect', () => finish(false));
    socket.once('error', (error) => finish(error.code === 'ECONNREFUSED'));
    socket.setTimeout(1500, () => finish(false));
  });
async function cleanup() {
  if (cleanupPromise) return cleanupPromise;
  stopping = true;
  cleanupPromise = (async () => {
    if (browser || browserServer) {
      const close = async () => {
        await browser?.close();
        await browserServer?.close();
        return true;
      };
      const closed = await Promise.race([
        close().catch((e) => {
          report.cleanup.browserError = String(e);
          return false;
        }),
        delay(10000, false),
      ]);
      if (!closed && (browserServer || ownedBrowserProcess)) {
        report.cleanup.browserEscalated = true;
        await Promise.race([
          (browserServer ? browserServer.kill() : ownedBrowserProcess.kill()).catch(
            (e) => (report.cleanup.browserKillError = String(e)),
          ),
          delay(5000),
        ]);
      }
      const process = browserServer?.process() ?? ownedBrowserProcess?.process;
      report.cleanup.browserProcess = process
        ? { pid: process.pid, exitCode: process.exitCode, signalCode: process.signalCode }
        : null;
      report.cleanup.browserClosed =
        (!browser || !browser.isConnected()) && (!process || process.exitCode !== null || process.signalCode !== null);
    }
    if (launcher) {
      if (privateDirectory && resolve(privateDirectory).startsWith(join(wt, 'packages/native-host/build/play-')))
        await writeFile(join(privateDirectory, 'stop'), 'stop\n', { mode: 0o600 }).catch(
          (e) => (report.cleanup.stopFileError = String(e)),
        );
      launcher.kill('SIGINT');
      report.cleanup.launcher = await Promise.race([exited, delay(15000).then(() => ({ timeout: true }))]);
      if (report.cleanup.launcher.timeout) {
        launcher.kill('SIGTERM');
        report.cleanup.escalated = true;
        report.cleanup.launcher = await Promise.race([exited, delay(5000).then(() => ({ timeout: true }))]);
      }
    }
    report.cleanup.dllRestored =
      JSON.stringify(await dllIdentity().catch(() => 'unreadable')) === JSON.stringify(dllBefore);
    if (launchedUrl) {
      const url = new URL(launchedUrl);
      report.cleanup.portsReleased = await Promise.all(
        [url.port, new URL(url.searchParams.get('agent')).port].map(portReleased),
      );
    }
    if (privateDirectory) {
      try {
        report.cleanup.game = JSON.parse(await readFile(join(privateDirectory, 'status.json'), 'utf8'));
      } catch (e) {
        report.cleanup.statusError = String(e);
      }
    }
    report.cleanup.met =
      report.cleanup.browserClosed === true &&
      report.cleanup.game?.running === false &&
      report.cleanup.launcher?.code === 0 &&
      report.cleanup.dllRestored &&
      report.cleanup.portsReleased?.every(Boolean);
    if (!report.cleanup.met) {
      report.error ??= 'Owned browser/game/launcher cleanup did not pass every gate';
      process.exitCode = 1;
    }
    await save();
  })();
  return cleanupPromise;
}
for (const signal of ['SIGINT', 'SIGTERM'])
  process.once(signal, async () => {
    report.error = `Acceptance interrupted by ${signal}`;
    await cleanup();
    process.exit(1);
  });
const deadline = setTimeout(async () => {
  report.error = 'Acceptance exceeded 20 minute safety limit';
  await cleanup();
  process.exit(1);
}, 1200000);
deadline.unref();
try {
  dllBefore = await dllIdentity();
  launcher = spawn(
    'bash',
    [join(wt, 'scripts/remaster/native/play-native.sh'), ...(o.size ? ['--size', o.size] : [])],
    { cwd: wt, env: { ...process.env, ...config }, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  exited = new Promise((r) => launcher.once('exit', (code, signal) => r({ code, signal })));
  for (const stream of [launcher.stdout, launcher.stderr]) {
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      launchLog = (launchLog + chunk).slice(-65536);
      launchPending += chunk;
      let cut = launchPending.lastIndexOf('\n') + 1;
      if (!cut && launchPending.length > 65536) cut = launchPending.length - 512;
      const persisted = launchPending.slice(0, cut);
      launchPending = launchPending.slice(cut);
      if (persisted && !launcherEvidence.write(redact(persisted))) {
        stream.pause();
        launcherEvidence.once('drain', () => stream.resume());
      }
      const m = launchLog.match(/Private launch logs and DLL backups: (.+)/);
      if (m) privateDirectory = m[1];
      launchedUrl ??= launchLog.match(/http:\/\/127\.0\.0\.1:\d+\/\?[^\s]+/)?.[0];
    });
  }
  let url = await wait('launcher URL', () => launchedUrl, 120000);
  launchedUrl = url;
  if (o['mouse-lock'] !== undefined) {
    assert(['0', '1'].includes(o['mouse-lock']));
    const selected = new URL(url);
    selected.searchParams.set('mouse-lock', o['mouse-lock']);
    url = selected.href;
  }
  const cache = join(homedir(), 'Library/Caches/ms-playwright/chromium-1243');
  const exe = join(
    cache,
    (await readdir(cache)).find((d) => d.startsWith('chrome-')),
    'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  );
  await record('launcher-ready', {});
  // In-process transport avoids copying native binary WebSocket inspector
  // events through a second JSON WebSocket and its unbounded driver queue.
  browser = await chromium.launch({
    headless: false,
    executablePath: exe,
    args: [
      '--enable-unsafe-webgpu',
      '--enable-gpu',
      '--use-angle=metal',
      '--ignore-gpu-blocklist',
      '--autoplay-policy=no-user-gesture-required',
      '--enable-webgpu-developer-features',
    ],
  });
  ownedBrowserProcess = browser._connection.toImpl(browser).options.browserProcess;
  await record('browser-started', {});
  const context = await browser.newContext({
    viewport: { width: 1280, height: 850 },
    deviceScaleFactor: 2,
    locale: 'en-US',
  });
  await context.grantPermissions(['local-network-access'], { origin: new URL(url).origin });
  await context.addInitScript(() => {
    window.__browserInputs = [];
    for (const type of ['pointermove', 'pointerdown', 'pointerup'])
      window.addEventListener(
        type,
        (e) => {
          if (e.target.id === 'screen' && window.__browserInputs.length < 120)
            window.__browserInputs.push({
              type,
              trusted: e.isTrusted,
              x: e.clientX,
              y: e.clientY,
              mx: e.movementX,
              my: e.movementY,
              locked: !!document.pointerLockElement,
            });
        },
        true,
      );
  });
  await context.route('**/src/adapter/vmWorker.ts*', async (route) => {
    const response = await route.fetch();
    const source = await response.text();
    const marker = 'installVmWorker(self);';
    assert(source.includes(marker), 'worker diagnostic seam');
    await route.fulfill({
      response,
      body: source.replace(
        marker,
        'const auditController = installVmWorker(self); Object.defineProperty(globalThis, "__auditCore", { get: () => auditController.core });',
      ),
    });
  });
  page = await context.newPage();
  cdp = await context.newCDPSession(page);
  page.on('worker', async () => {
    await delay(150);
    await disableWorkerNetworkPayloadObservation(page).catch(() => {});
  });
  const retainError = (error) => {
    report.errorsTotal = (report.errorsTotal ?? 0) + 1;
    if (report.errors.length < 128) report.errors.push(String(error).slice(0, 700));
  };
  page.on('websocket', (ws) => {
    ws.on('socketerror', (e) => retainError('websocket ' + e));
  });
  page.on('pageerror', retainError);
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') retainError(m.text());
  });
  await page.goto(url);
  await page.bringToFront();
  await record('page-loaded', { buttons: await page.getByRole('button').allInnerTexts() });
  await shot('page-loaded');
  // The owner URL must attach its supplied copy automatically. Clicking the
  // transient picker would race the auto-start effect and conceal a startup failure.
  assert.equal(new URL(url).searchParams.get('native-autostart'), 'yr');
  await wait('native worker', () => worker(), 120000);
  await record('bounded-worker-inspector', await disableWorkerNetworkPayloadObservation(page));
  await delay(2000);
  await record(
    'worker-status',
    await worker().evaluate(() => ({
      hasCore: !!globalThis.__auditCore,
      hello: globalThis.__auditCore?.hello,
      ws: globalThis.__auditCore?.connection?.socket?.readyState,
    })),
  );
  await wait(
    'native main menu',
    async () => {
      try {
        return control(await inputState(), 1667);
      } catch {
        return false;
      }
    },
    60000,
  );
  if (o.mode === 'reproduce') await reproduce();
  else await accept();
} catch (e) {
  report.error = String(e.stack || e);
  console.error(report.error);
  if (page) await shot('failure').catch(() => {});
  process.exitCode = 1;
} finally {
  clearTimeout(deadline);
  await cleanup();
  clearInterval(rssMonitor);
  report.stepEvidence = await stepEvidence.close();
  await new Promise((resolve, reject) => {
    launcherEvidence.once('error', reject);
    if (launchPending) launcherEvidence.write(redact(launchPending));
    launcherEvidence.end(resolve);
  });
  await save();
  await appendFile(
    resolve(o.out, 'NOTES.md'),
    `\n### Phase5 browser ${stamp}\n- ${o.mode}: ${report.error ? 'FAIL ' + report.error.split('\n')[0] : 'completed'}; ${report.steps.length} observations; cleanup ${JSON.stringify(report.cleanup)}; ${reportPath}\n`,
  );
  console.log('report', reportPath, 'cleanup', JSON.stringify(report.cleanup));
}
