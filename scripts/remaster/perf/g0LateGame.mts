/**
 * Gate G0 (remaster fork): late-game YR skirmish performance harness.
 *
 * Measurement only. It starts (or loads) a real YR 1.001 skirmish in the development page, lets the AIs
 * build up, and once per second records the native simulation counter (VmCore.getGamePerformance, the same
 * reader behind VmShell.getGamePerformance), the toolbar's presented-frame rate, and read-only native object
 * counts. It never writes guest memory except through the existing game-speed hook when G0_SPEEDS asks for it,
 * and the only guest input it sends is ordinary menu/keyboard input a player would use (pause menu, save, load).
 *
 * Probes are injected exactly like tests/real-game/browser/battleStartupBrowserSmoke.mts: the test-intercepted
 * vmWorker.ts (or runtime.ts for main-thread mode) module gets a read-only accessor appended. Object-array
 * addresses below are YR 1.001 facts (DynamicVectorClass: items at +4, count at +0x10) and are self-checked at
 * runtime: techno must equal unit+infantry+building+aircraft and every techno owner must be a known house.
 *
 * Usage (development server running with RA2_GAME_ROOT pointing at a directory whose ra2/ holds the YR install):
 *   G0_OUT=/tmp/g0 G0_NAME=run1 RA2_BROWSER_ORIGIN=https://127.0.0.1:15174 pnpm exec tsx scripts/remaster/perf/g0LateGame.mts
 * See scripts/remaster/perf/README.md for every variable.
 */
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { loadavg } from 'node:os';
import { chromium, type BrowserContext, type Page, type Worker } from '@playwright/test';
import { selectDevelopmentGame } from '../../../tests/helpers/selectDevelopmentGame';
import { summarizeGamePerformance } from '../../../tests/helpers/gamePerformance';
import type { GamePerformanceSample } from '../../../src/games/performance';

const env = process.env;
const num = (key: string, fallback: number) =>
  env[key] === undefined || env[key] === '' ? fallback : Number(env[key]);
const origin = env.RA2_BROWSER_ORIGIN ?? 'https://127.0.0.1:15174';
const out = env.G0_OUT;
assert.ok(out, 'G0_OUT (output directory) is required');
mkdirSync(out, { recursive: true });
const name = env.G0_NAME ?? 'g0';
const mode = env.VM_BROWSER_MODE === 'main' ? 'main' : 'worker';
const start = env.G0_START ?? 'battle'; // battle | load | skirmish
assert.ok(['battle', 'load', 'skirmish'].includes(start), `unknown G0_START ${start}`);
const resolution = env.G0_RESOLUTION ?? ''; // '' keeps the INI [Video] size; otherwise a toolbar preset such as 1920x1080
const [viewportWidth, viewportHeight] = (env.G0_VIEWPORT ?? '1512x982').split('x').map(Number);
const deviceScaleFactor = num('G0_DPR', 2);
const buildupMaxS = num('G0_BUILDUP_MAX_S', 1500);
const buildupMinS = num('G0_BUILDUP_MIN_S', 0);
const unitTarget = num('G0_UNIT_TARGET', 250); // mobile units (vehicles + infantry + aircraft)
const warmupS = num('G0_WARMUP_S', 30);
const measureS = num('G0_MEASURE_S', 150);
const speeds = (env.G0_SPEEDS ?? '')
  .split(',')
  .filter((value) => value !== '')
  .map(Number);
const speedSettleS = num('G0_SPEED_SETTLE_S', 10);
const saveEveryS = num('G0_SAVE_EVERY_S', 0);
const saveAtEnd = env.G0_SAVE_AT_END === '1';
const diagnostics = env.G0_DIAGNOSTICS !== '0';
const screenshotEveryS = num('G0_SCREENSHOT_EVERY_S', 120);
const loadIndex = num('G0_LOAD_INDEX', 0);
const profile = env.G0_PROFILE; // persistent Chromium profile; required to load a save written by an earlier run
const executablePath = env.RA2_BROWSER_EXECUTABLE;
const headless = env.G0_HEADLESS !== '0';
const contentionWaitS = num('G0_CONTENTION_WAIT_S', 1800);

/**
 * Other heavy jobs on this host (vitest real-game runs, other v86/Chromium sessions, Codex runs) distort timing.
 * List them, excluding this harness's own process tree, the player's everyday browser, and idle helpers.
 */
function otherHeavyProcesses(): string[] {
  let table: string;
  try {
    table = execFileSync('ps', ['-axo', 'pid=,ppid=,pcpu=,args='], { encoding: 'utf8', maxBuffer: 16 << 20 });
  } catch {
    return ['(ps failed)'];
  }
  const rows = table
    .split('\n')
    .map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+([\d.]+)\s+(.*)$/))
    .flatMap((match) => (match ? [{ pid: +match[1]!, ppid: +match[2]!, cpu: +match[3]!, args: match[4]! }] : []));
  const children = new Map<number, number[]>();
  for (const row of rows) children.set(row.ppid, [...(children.get(row.ppid) ?? []), row.pid]);
  const mine = new Set<number>();
  const visit = (pid: number) => {
    if (mine.has(pid)) return;
    mine.add(pid);
    for (const child of children.get(pid) ?? []) visit(child);
  };
  visit(process.pid);
  return rows
    .filter((row) => !mine.has(row.pid))
    .filter((row) => /vitest|v86|chrom|codex exec/i.test(row.args))
    .filter(
      (row) =>
        !/Google Chrome\.app|ChatGPT for Chrome|chrome_crashpad_handler|computer_history|Claude\.app|claude\.app/.test(
          row.args,
        ),
    )
    .filter((row) => /vitest/.test(row.args) || row.cpu >= 10)
    .map((row) => `${row.pid} ${row.cpu}% ${row.args.slice(0, 140)}`);
}

// YR 1.001 read-only layout. HouseClass::Array and CurrentPlayer match tests/real-game/browser/ra2NetworkBrowserSmoke.mts.
const YR = {
  techno: 0xa8ec78,
  unit: 0x8b4108,
  infantry: 0xa83de8,
  building: 0xa8eb40,
  aircraft: 0xa8e390,
  house: 0xa80228,
  localHouse: 0xa83d4c,
  houseHuman: 0x1ec,
  houseDefeated: 0x1f5,
  technoOwner: 0x21c,
};

const probe = (core: string) => `globalThis.__g0 = (() => {
  const core = () => (${core});
  const shim = () => core()?.shim;
  const u32 = (a) => shim().readU32(a), u8 = (a) => shim().readU8(a);
  const vector = (base) => ({ items: u32(base + 4), count: u32(base + 0x10) });
  const visible = () => { const s = shim(); if (!s) return []; return s.inspectWindowState().filter((w) => s.isWindowVisible(w.hwnd)).map((w) => ({ hwnd: w.hwnd, id: w.id, className: w.className, text: w.text, rect: w.rect })); };
  return {
    perf: () => core()?.getGamePerformance() ?? null,
    phase: () => core()?.currentPhase ?? null,
    shell: () => shim()?.inspectShellPageTitle() ?? null,
    windows: visible,
    controls: () => shim()?.inspectControlItems() ?? [],
    trackbars: () => { const s = shim(); return s ? [...s.trackbarStates].map(([hwnd, state]) => ({ hwnd, ...state, rect: s.screenRect(hwnd) })) : []; },
    surface() { const s = shim(); const p = s?.surfaces?.get(s.primarySurface); return p ? { width: p.width, height: p.height, bpp: p.bpp } : null; },
    counts() {
      const s = shim(); if (!s) return null;
      const counts = {};
      for (const key of ['techno', 'unit', 'infantry', 'building', 'aircraft', 'house']) counts[key] = u32(${JSON.stringify(YR)}[key] + 0x10);
      const houses = vector(${YR.house}), pointers = [];
      if (houses.items && houses.count > 0 && houses.count <= 64) for (let i = 0; i < houses.count; i++) pointers.push(u32(houses.items + i * 4));
      const owned = new Map(pointers.map((h) => [h, 0]));
      let foreignOwners = 0;
      const technos = vector(${YR.techno});
      if (technos.items && technos.count <= 100000) for (let i = 0; i < technos.count; i++) {
        const object = u32(technos.items + i * 4), owner = object ? u32(object + ${YR.technoOwner}) : 0;
        if (owned.has(owner)) owned.set(owner, owned.get(owner) + 1); else foreignOwners++;
      }
      const local = u32(${YR.localHouse});
      return {
        ...counts,
        mobile: counts.unit + counts.infantry + counts.aircraft,
        consistent: counts.techno === counts.unit + counts.infantry + counts.building + counts.aircraft && foreignOwners === 0,
        foreignOwners,
        localAlive: !!local && !u8(local + ${YR.houseDefeated}),
        houses: pointers.map((h, index) => ({ index, local: h === local, human: u8(h + ${YR.houseHuman}), defeated: u8(h + ${YR.houseDefeated}), technos: owned.get(h) })),
      };
    },
    click(hwnd) {
      const s = shim(), c = core(); const r = s.screenRect(hwnd);
      const x = (r.x + r.width / 2) | 0, y = (r.y + r.height / 2) | 0, point = (y << 16) | x;
      c.setCursorPosition(x, y); c.postMessage(0x200, 0, point);
      c.setKeyState(1, true); c.postMessage(0x201, 1, point); c.setKeyState(1, false); c.postMessage(0x202, 0, point);
      return { x, y };
    },
    clickAt(x, y) {
      const c = core(), point = (y << 16) | x;
      c.setCursorPosition(x, y); c.postMessage(0x200, 0, point);
      c.setKeyState(1, true); c.postMessage(0x201, 1, point); c.setKeyState(1, false); c.postMessage(0x202, 0, point);
    },
    /** Select a ListBox row by clicking it; the shim maps client Y to row using the native item height. */
    listRowPoint(hwnd, index) {
      const s = shim(), r = s.screenRect(hwnd), height = s.controlItemHeights.get(hwnd) ?? 16, top = s.listboxTopIndices.get(hwnd) ?? 0;
      return { x: (r.x + Math.min(40, r.width / 2)) | 0, y: (r.y + (index - top + 0.5) * height) | 0, height, top };
    },
    key(vk) { const c = core(); c.postMessage(0x100, vk, 1); c.postMessage(0x101, vk, 0xc0000001); },
    flush: () => core()?.flushFiles(),
  };
})();`;

type Counts = {
  techno: number;
  unit: number;
  infantry: number;
  building: number;
  aircraft: number;
  house: number;
  mobile: number;
  consistent: boolean;
  foreignOwners: number;
  localAlive: boolean;
  houses: { index: number; local: boolean; human: number; defeated: number; technos: number }[];
};
type VisibleWindow = {
  hwnd: number;
  id: number;
  className: string;
  text: string;
  rect: { x: number; y: number; width: number; height: number } | null;
};
type TimelineEntry = {
  t: number;
  phase: string;
  perf: GamePerformanceSample | null;
  counts: Counts | null;
  presentedFps: number | null;
  toolbarVmFps: number | null;
  shell: string | null;
};

const startedAt = new Date().toISOString();
const config = {
  name,
  origin,
  mode,
  start,
  resolution: resolution || '(RA2MD.INI [Video])',
  viewport: { width: viewportWidth, height: viewportHeight, deviceScaleFactor },
  buildupMaxS,
  buildupMinS,
  unitTarget,
  warmupS,
  measureS,
  speeds,
  saveEveryS,
  saveAtEnd,
  diagnostics,
  headless,
  executablePath: executablePath ?? '(playwright default)',
  profile: profile ? '(persistent)' : '(ephemeral)',
  startedAt,
};
console.log('[g0] config', JSON.stringify(config));

const launchOptions = {
  headless,
  ...(executablePath ? { executablePath } : {}),
  args: ['--no-sandbox', '--enable-unsafe-swiftshader'],
};
const contextOptions = {
  locale: 'zh-CN',
  ignoreHTTPSErrors: true,
  viewport: { width: viewportWidth!, height: viewportHeight! },
  deviceScaleFactor,
};
const browser = profile ? null : await chromium.launch(launchOptions);
const context: BrowserContext = profile
  ? await chromium.launchPersistentContext(profile, { ...launchOptions, ...contextOptions })
  : await browser!.newContext(contextOptions);
await context.addInitScript((value) => {
  if (value) localStorage.setItem('vm-resolution-yr', value);
  else localStorage.removeItem('vm-resolution-yr');
}, resolution);
const moduleName = mode === 'worker' ? 'vmWorker' : 'runtime';
await context.route(`**/src/adapter/${moduleName}.ts*`, async (route) => {
  const response = await route.fetch(),
    source = await response.text();
  const marker = mode === 'worker' ? 'installVmWorker(self);' : 'this.core = new VmCore(callbacks, source, platform);';
  assert.ok(source.includes(marker), 'probe entry point changed');
  const replacement =
    mode === 'worker'
      ? `const controller = installVmWorker(self);${probe('controller.core')}`
      : `${marker}globalThis.__g0Core = this.core;${probe('globalThis.__g0Core')}`;
  await route.fulfill({ response, body: source.replace(marker, replacement) });
});

const page: Page = context.pages()[0] ?? (await context.newPage());
const errors: string[] = [];
page.on('pageerror', (error) => errors.push(error.message));
const timeline: TimelineEntry[] = [];
const events: { t: number; event: string; detail?: unknown }[] = [];
let battleStartedAt = 0;
const now = () => (battleStartedAt ? (Date.now() - battleStartedAt) / 1000 : 0);
const log = (event: string, detail?: unknown) => {
  events.push({ t: now(), event, detail });
  console.log(`[g0 ${now().toFixed(0)}s] ${event}`, detail === undefined ? '' : JSON.stringify(detail));
};
const target = (): Page | Worker => {
  if (mode === 'main') return page;
  const worker = page.workers().find((w) => w.url().includes('/vmWorker.ts'));
  assert.ok(worker, 'VM Worker not found');
  return worker;
};
const g0 = async <T,>(expression: string): Promise<T> =>
  (await target().evaluate(
    `(async () => { const g = globalThis.__g0; if (!g) return null; return ${expression}; })()`,
  )) as T;
const visibleWindows = () => g0<VisibleWindow[]>('g.windows()');
const findWindow = async (text: string) => (await visibleWindows())?.find((window) => window.text === text);
const waitFor = async <T,>(label: string, probeFn: () => Promise<T | null | undefined | false>, timeoutMs: number) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probeFn().catch(() => null);
    if (value) return value as T;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await page.waitForTimeout(250);
  }
};
const clickWindow = async (text: string, timeoutMs = 60_000) => {
  await waitFor(text, () => findWindow(text), timeoutMs);
  // Native menu transitions briefly expose controls before accepting mouse input (same as the save/load regression).
  await page.waitForTimeout(2500);
  const window = await findWindow(text);
  assert.ok(window, `${text} disappeared`);
  await g0(`g.click(${window.hwnd})`);
  log('click', text);
};
const pressKey = (vk: number) => g0(`g.key(${vk})`);
const parseToolbar = (text: string | null) => {
  const vm = text?.match(/VM\s*([\d.]+)/);
  const presented = text?.match(/(?:显示|Display)\s*([\d.]+)/);
  return { vm: vm ? Number(vm[1]) : null, presented: presented ? Number(presented[1]) : null };
};

let lastScreenshot = -Infinity;
async function sample(phase: string): Promise<TimelineEntry> {
  const [perf, counts, shell] = (await g0<[GamePerformanceSample | null, Counts | null, string | null]>(
    '[await g.perf(), g.counts(), g.shell()]',
  )) ?? [null, null, null];
  const toolbar = parseToolbar(
    await page
      .locator('#vm-fps')
      .textContent({ timeout: 2000 })
      .catch(() => null),
  );
  const entry: TimelineEntry = {
    t: now(),
    phase,
    perf,
    counts,
    presentedFps: toolbar.presented,
    toolbarVmFps: toolbar.vm,
    shell,
  };
  timeline.push(entry);
  // Screenshots cost page/compositor time; never take periodic ones inside a measurement window.
  if (!phase.startsWith('measure') && screenshotEveryS > 0 && entry.t - lastScreenshot >= screenshotEveryS) {
    lastScreenshot = entry.t;
    await page
      .screenshot({ path: join(out!, `${name}-t${Math.round(entry.t)}s.png`) })
      .catch((error) => log('screenshot failed', String(error)));
  }
  return entry;
}
const flush = (extra: Record<string, unknown> = {}) =>
  writeFileSync(join(out!, `${name}.json`), JSON.stringify({ config, events, errors, timeline, ...extra }, null, 1));

/** Pause through the native Esc menu, save through the native dialogs, then resume with Esc. */
async function saveGame(label: string) {
  log('save begin', label);
  await pressKey(27);
  await clickWindow('GUI:SaveGame', 30_000);
  await clickWindow('GUI:Save', 30_000);
  await waitFor('save confirmation', () => findWindow('GUI:OK'), 120_000);
  await g0('await g.flush(), true');
  await clickWindow('GUI:OK', 30_000);
  await waitFor('save confirmation closes', async () => !(await findWindow('GUI:OK')), 30_000);
  // Resume play: the pause menu is still open after the confirmation closes.
  const windows = await visibleWindows();
  log('after save windows', windows.map((window) => window.text).filter(Boolean));
  const resume = windows.find((window) => /resume/i.test(window.text));
  if (resume) {
    await page.waitForTimeout(2500);
    await g0(`g.click(${resume.hwnd})`);
  } else await pressKey(27);
  await waitFor('battlefield after save', async () => (await visibleWindows()).length === 1, 60_000);
  log('save done', label);
}

/** Context only (not a gate): load average and the busiest processes of any kind, e.g. compilers or other browsers. */
function hostLoad() {
  try {
    const busiest = execFileSync('ps', ['-axro', 'pcpu=,comm='], { encoding: 'utf8', maxBuffer: 16 << 20 })
      .split('\n')
      .slice(0, 8)
      .map((line) => {
        const [cpu, ...command] = line.trim().split(/\s+/);
        return command.length ? `${cpu}% ${command.join(' ').split('/').pop()}` : '';
      })
      .filter(Boolean);
    return { loadavg: loadavg().map((value) => Number(value.toFixed(2))), busiest };
  } catch {
    return { loadavg: loadavg(), busiest: [] };
  }
}

/**
 * Change the native game speed the way a player does: pause menu -> Game Controls -> speed slider -> Back -> Resume.
 * (Writing the Settings singleton through VmShell.setGameSpeedFlag did not change the single-player rate in YR 1.001
 * here, so the harness uses the native dialog.) Slider positions run from speed 6 (left) to speed 0 (right).
 */
async function setSpeedViaMenu(speed: number) {
  assert.ok(Number.isInteger(speed) && speed >= 0 && speed <= 6, 'speed must be 0..6');
  await pressKey(27);
  await clickWindow('GUI:GameControls', 30_000);
  await page.waitForTimeout(2000);
  const slider = (await visibleWindows()).find((window) => window.text === 'Slider1');
  assert.ok(slider?.rect, 'speed slider missing');
  const fraction = Math.min(0.99, Math.max(0.01, 1 - speed / 6));
  const x = Math.round(slider.rect.x + 1 + fraction * (slider.rect.width - 3));
  await g0(`g.clickAt(${x}, ${Math.round(slider.rect.y + slider.rect.height / 2)})`);
  await page.waitForTimeout(1000);
  await clickWindow('GUI:Back', 30_000);
  await clickWindow('GUI:ResumeMission', 30_000);
  await waitFor('battlefield after speed change', async () => (await visibleWindows()).length === 1, 60_000);
  const applied = await waitFor(
    'native speed applied',
    async () => {
      const perf = await g0<GamePerformanceSample | null>('await g.perf()');
      return perf && perf.gameSpeed === speed ? perf : null;
    },
    15_000,
  ).catch(() => null);
  log('game speed set', { speed, fraction, applied: applied?.gameSpeed ?? 'not observed' });
}

async function waitForQuietHost(label: string) {
  const deadline = Date.now() + contentionWaitS * 1000;
  for (;;) {
    const others = otherHeavyProcesses();
    log('contention check', { label, others, host: hostLoad() });
    if (!others.length) return { quiet: true, others };
    if (Date.now() > deadline) return { quiet: false, others };
    // Keep the simulation sampled while waiting; the scene keeps building up.
    for (let i = 0; i < 15; i++) {
      const tick = Date.now();
      const entry = await sample('wait-quiet');
      if (entry.counts && !entry.counts.localAlive) return { quiet: false, others: ['local house defeated'] };
      await page.waitForTimeout(Math.max(0, 1000 - (Date.now() - tick)));
    }
  }
}

async function measureWindow(label: string, seconds: number) {
  const gate = await waitForQuietHost(label);
  const contention: { t: number; others: string[]; host: ReturnType<typeof hostLoad> }[] = [];
  const first = timeline.length;
  const deadline = Date.now() + seconds * 1000;
  let ended = false;
  while (Date.now() < deadline) {
    const tick = Date.now();
    const entry = await sample(label);
    if ((timeline.length - first) % 15 === 1)
      contention.push({ t: entry.t, others: otherHeavyProcesses(), host: hostLoad() });
    if (entry.counts && !entry.counts.localAlive) {
      log('local house defeated during measurement', label);
      ended = true;
      break;
    }
    await page.waitForTimeout(Math.max(0, 1000 - (Date.now() - tick)));
  }
  await page.screenshot({ path: join(out!, `${name}-${label}-end.png`) }).catch(() => undefined);
  const entries = timeline.slice(first);
  const samples = entries.flatMap((entry) => (entry.perf ? [entry.perf] : []));
  const report = summarizeGamePerformance(samples);
  const presented = entries.flatMap((entry) => (entry.presentedFps === null ? [] : [entry.presentedFps]));
  const sorted = [...presented].sort((a, b) => a - b);
  const mobile = entries.flatMap((entry) => (entry.counts ? [entry.counts.mobile] : []));
  const technos = entries.flatMap((entry) => (entry.counts ? [entry.counts.techno] : []));
  const summary = {
    label,
    seconds,
    endedEarly: ended,
    hostQuietAtStart: gate.quiet,
    contendedChecks: contention.filter((check) => check.others.length).length,
    contention,
    gameSpeed: samples.at(-1)?.gameSpeed ?? null,
    native: report,
    presented: sorted.length
      ? {
          mean: presented.reduce((sum, value) => sum + value, 0) / presented.length,
          p05: sorted[Math.max(0, Math.ceil(0.05 * sorted.length) - 1)],
          p50: sorted[Math.max(0, Math.ceil(0.5 * sorted.length) - 1)],
          min: sorted[0],
        }
      : null,
    mobileUnits: mobile.length ? { min: Math.min(...mobile), max: Math.max(...mobile) } : null,
    technos: technos.length ? { min: Math.min(...technos), max: Math.max(...technos) } : null,
    lastCounts: entries.at(-1)?.counts ?? null,
  };
  log('window summary', summary);
  return summary;
}

const windowsSummary: unknown[] = [];
let diagnosticReport: unknown = null;
let outcome = 'incomplete';
try {
  // debug=1 opens the call-trace side panel and per-frame dataset probes; keep it off by default so the page matches
  // normal play. All state needed here comes from the injected read-only probe instead.
  const params = new URLSearchParams();
  if (env.G0_DEBUG === '1') params.set('debug', '1');
  if (start !== 'load') params.set('start-page', start);
  if (mode === 'main') params.set('vm-worker', '0');
  const query = params.size ? `?${params}` : '';
  await page.goto(`${origin}/${query}`);
  await selectDevelopmentGame(page, 'yr');
  await waitFor('VM probe', () => g0<boolean>('true'), 300_000);
  log('probe ready');

  if (start === 'skirmish') {
    await waitFor(
      'skirmish page',
      async () => (await visibleWindows()).some((window) => window.text === 'GUI:StartGame'),
      300_000,
    );
    await page.waitForTimeout(4000);
    await page.screenshot({ path: join(out, `${name}-skirmish.png`) });
    writeFileSync(
      join(out, `${name}-skirmish.json`),
      JSON.stringify({ windows: await visibleWindows(), controls: await g0('g.controls()') }, null, 1),
    );
    // Optional exploration: open one native control (e.g. the map chooser) and dump what it lists.
    if (env.G0_EXPLORE_CLICK) {
      await clickWindow(env.G0_EXPLORE_CLICK);
      await page.waitForTimeout(5000);
      await page.screenshot({ path: join(out, `${name}-explore.png`) });
      writeFileSync(
        join(out, `${name}-explore.json`),
        JSON.stringify({ windows: await visibleWindows(), controls: await g0('g.controls()') }, null, 1),
      );
    }
    outcome = 'skirmish-page';
  } else {
    if (start === 'load') {
      await waitFor('main menu', () => findWindow('GUI:SinglePlayer'), 300_000);
      await page.waitForTimeout(8000);
      await clickWindow('GUI:SinglePlayer');
      await clickWindow('GUI:LoadSavedGame');
      await waitFor('save list', () => findWindow('GUI:Load'), 60_000);
      const listBox = (await visibleWindows()).find((window) => window.className === 'ListBox');
      assert.ok(listBox, 'save list box missing');
      log('save list', await g0('g.controls().filter((c) => c.className === "ListBox")'));
      // Click the requested row directly (the save list is not keyboard-navigable through the shim).
      const row = await g0<{ x: number; y: number; height: number; top: number }>(
        `g.listRowPoint(${listBox.hwnd}, ${loadIndex})`,
      );
      await g0(`g.clickAt(${row.x}, ${row.y})`);
      await page.waitForTimeout(1500);
      log('save row selected', {
        requested: loadIndex,
        row,
        selection: (await g0<{ hwnd: number; selection: number }[]>('g.controls()')).find(
          (control) => control.hwnd === listBox.hwnd,
        )?.selection,
      });
      await clickWindow('GUI:Load');
    }
    // Battlefield: VM running, no native shell page, a live local House owning objects, and the native simulation
    // counter advancing (loading screens do not advance it).
    await waitFor(
      'battlefield',
      async () => {
        const [phase, shell, counts] =
          (await g0<[string, string, Counts | null]>('[g.phase(), g.shell(), g.counts()]')) ?? [];
        return phase === 'running' && shell === '' && counts?.localAlive && counts.techno > 0;
      },
      600_000,
    );
    const firstFrame = (await g0<GamePerformanceSample | null>('await g.perf()'))?.frame ?? 0;
    await waitFor(
      'simulation advancing',
      async () => ((await g0<GamePerformanceSample | null>('await g.perf()'))?.frame ?? 0) > firstFrame + 120,
      120_000,
    );
    battleStartedAt = Date.now();
    const surface = await g0('g.surface()');
    log('battlefield', {
      surface,
      frame: (await g0<GamePerformanceSample | null>('await g.perf()'))?.frame ?? null,
      counts: await g0('g.counts()'),
    });
    await page.screenshot({ path: join(out, `${name}-start.png`) });

    if (env.G0_EXPLORE_SPEED_CLICKS) {
      // Exploration only: move the native Game Controls speed slider through the pause menu (a player's own input)
      // and record which native speed and simulation rate each position produces.
      const results: unknown[] = [];
      for (const fraction of env.G0_EXPLORE_SPEED_CLICKS.split(',').map(Number)) {
        await pressKey(27);
        await clickWindow('GUI:GameControls', 30_000);
        await page.waitForTimeout(2000);
        const slider = (await visibleWindows()).find((window) => window.text === 'Slider1');
        assert.ok(slider?.rect, 'speed slider missing');
        const x = Math.round(slider.rect.x + 1 + fraction * (slider.rect.width - 3));
        const y = Math.round(slider.rect.y + slider.rect.height / 2);
        await g0(`g.clickAt(${x}, ${y})`);
        await page.waitForTimeout(1000);
        const bars = await g0('g.trackbars()');
        await page.screenshot({ path: join(out, `${name}-slider-${fraction}.png`) });
        await clickWindow('GUI:Back', 30_000);
        await clickWindow('GUI:ResumeMission', 30_000);
        await waitFor('battlefield after controls', async () => (await visibleWindows()).length === 1, 60_000);
        await page.waitForTimeout(5000);
        const first = timeline.length;
        for (let i = 0; i < 12; i++) {
          await sample(`speed-click-${fraction}`);
          await page.waitForTimeout(1000);
        }
        const samples = timeline.slice(first).flatMap((entry) => (entry.perf ? [entry.perf] : []));
        const result = {
          fraction,
          x,
          bars,
          gameSpeed: samples.at(-1)?.gameSpeed,
          native: summarizeGamePerformance(samples),
        };
        log('speed click', result);
        results.push(result);
      }
      writeFileSync(join(out, `${name}-speed-clicks.json`), JSON.stringify(results, null, 1));
      throw new Error('speed clicks explored');
    }
    if (env.G0_EXPLORE_OPTIONS === '1') {
      // Exploration only: open the native in-game options dialog and record its controls.
      await page.waitForTimeout(5000);
      await pressKey(27);
      await clickWindow('GUI:GameControls', 30_000);
      await page.waitForTimeout(4000);
      await page.screenshot({ path: join(out, `${name}-options.png`) });
      writeFileSync(
        join(out, `${name}-options.json`),
        JSON.stringify({ windows: await visibleWindows(), trackbars: await g0('g.trackbars()') }, null, 1),
      );
      throw new Error('options explored');
    }

    // Build-up phase (new skirmish) or post-load warm-up.
    const buildupLimit = start === 'battle' ? buildupMaxS : warmupS;
    let lastSave = 0;
    let periodicSaves = saveEveryS > 0;
    for (;;) {
      const tick = Date.now();
      const entry = await sample(start === 'battle' ? 'buildup' : 'warmup');
      if (timeline.length % 30 === 0) {
        log('progress', {
          frame: entry.perf?.frame,
          logicFps: entry.perf?.logicFps,
          presented: entry.presentedFps,
          mobile: entry.counts?.mobile,
          buildings: entry.counts?.building,
          alive: entry.counts?.houses.filter((house) => !house.defeated).length,
          consistent: entry.counts?.consistent,
        });
        flush();
      }
      if (entry.counts && !entry.counts.localAlive) {
        outcome = 'local-defeated-during-buildup';
        break;
      }
      if (entry.shell) {
        outcome = `left-battlefield:${entry.shell}`;
        break;
      }
      const elapsed = now();
      if (start === 'battle' && elapsed >= buildupMinS && (entry.counts?.mobile ?? 0) >= unitTarget) {
        log('unit target reached', { mobile: entry.counts?.mobile, technos: entry.counts?.techno });
        break;
      }
      if (elapsed >= buildupLimit) {
        log(start === 'battle' ? 'buildup time limit' : 'warmup done', { mobile: entry.counts?.mobile });
        break;
      }
      if (periodicSaves && elapsed - lastSave >= saveEveryS) {
        lastSave = elapsed;
        try {
          await saveGame(`periodic-${Math.round(elapsed)}s`);
        } catch (error) {
          // A failed save must not end the build-up; stop trying and make sure the game is not left paused.
          periodicSaves = false;
          log('periodic save failed; disabled', String(error));
          await page.screenshot({ path: join(out, `${name}-save-failed.png`) }).catch(() => undefined);
          if ((await visibleWindows()).length > 1) await pressKey(27);
        }
      }
      await page.waitForTimeout(Math.max(0, 1000 - (Date.now() - tick)));
    }

    if (!outcome.startsWith('local-defeated') && !outcome.startsWith('left-battlefield')) {
      if (speeds.length) {
        for (const speed of speeds) {
          await setSpeedViaMenu(speed);
          await page.waitForTimeout(speedSettleS * 1000);
          windowsSummary.push(await measureWindow(`measure-speed${speed}`, measureS));
          flush({ windows: windowsSummary });
        }
      } else {
        windowsSummary.push(await measureWindow('measure', measureS));
        flush({ windows: windowsSummary });
      }
      outcome = 'measured';
      if (diagnostics) {
        try {
          await page.locator('#vm-performance-diagnostics').click();
          const dialog = page.getByRole('dialog', { name: '性能诊断', exact: true });
          await dialog.getByRole('button', { name: '开始 20 秒采样', exact: true }).click();
          await dialog.waitFor({ state: 'hidden' });
          await dialog.waitFor({ state: 'visible', timeout: 60_000 });
          diagnosticReport = JSON.parse(await dialog.getByRole('textbox', { name: '性能诊断报告' }).inputValue());
          await dialog.getByRole('button', { name: '关闭', exact: true }).click();
          const summary = (diagnosticReport as { summary?: unknown; runtime?: unknown; renderer?: unknown }) ?? {};
          log('diagnostics', { summary: summary.summary, runtime: summary.runtime, renderer: summary.renderer });
        } catch (error) {
          log('diagnostics failed', String(error));
        }
      }
      if (saveAtEnd) await saveGame('end');
    }
  }
} catch (error) {
  outcome = `error: ${error instanceof Error ? error.message : String(error)}`;
  log('error', outcome);
  await page.screenshot({ path: join(out, `${name}-error.png`) }).catch(() => undefined);
} finally {
  const final = await page
    .locator('#screen')
    .evaluate((c) => ({ ...(c as HTMLElement).dataset }))
    .catch(() => null);
  flush({
    outcome,
    windows: windowsSummary,
    diagnostic: diagnosticReport,
    finalDataset: final,
    finishedAt: new Date().toISOString(),
  });
  console.log('[g0] outcome', outcome);
  await page.screenshot({ path: join(out, `${name}-end.png`) }).catch(() => undefined);
  await context.close();
  await browser?.close();
}
