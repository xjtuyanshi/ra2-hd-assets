/**
 * Remaster phase-1 smoke (not part of any CI entry): observe a real YR 1.001 superweapon being built, charged and
 * fired by the original AI in a skirmish started through `?start-page=battle`.
 *
 * Setup is the game's own RA2MD.INI [Skirmish] section in a scratch copy of the installation (symlinks plus an edited
 * INI with SuperWeaponsAllowed=yes and AI slots), served through RA2_GAME_ROOT; see scripts/remaster/perf/README.md.
 * The local player sends no guest input at all. Evidence is read-only:
 *
 * - SuperClass objects are discovered, not assumed: each HouseClass (HouseClass::Array 0xA80228, the address the
 *   existing browser smokes use) is scanned for a DynamicVectorClass (items +4, count +0x10) whose every element
 *   holds the owning house pointer at one common offset and a type pointer whose AbstractTypeClass ID (+0x24) is an
 *   ASCII name ending in "Special" (SuperWeaponType IDs such as LightningStormSpecial). Anything else is reported as
 *   "probe unavailable" instead of guessed.
 * - Raw dwords 0x24..0x7C of every SuperClass are recorded with the native frame counter, so launches can be
 *   analysed from the recharge timer (a start-frame dword reset to "now" after a full charge) and cross-checked
 *   against screenshots of the on-screen superweapon timers.
 *
 * Usage: YR_SMOKE_OUT=/path pnpm exec tsx tests/real-game/remaster/yrSuperweaponSmoke.mts
 * Optional: YR_SW_MAX_S (default 1500), YR_SW_SAMPLE_S (5), YR_SW_SHOT_S (30), YR_SW_AFTER_S (90, keep observing after
 * the first detected launch), YR_SW_RESOLUTION (1440x900).
 */
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type Worker } from '@playwright/test';
import { selectDevelopmentGame } from '../../helpers/selectDevelopmentGame';
import type { GamePerformanceSample } from '../../../src/games/performance';

const origin = process.env.RA2_BROWSER_ORIGIN ?? 'https://127.0.0.1:15174';
const out = process.env.YR_SMOKE_OUT;
assert.ok(out, 'YR_SMOKE_OUT is required');
mkdirSync(out, { recursive: true });
const maxS = Number(process.env.YR_SW_MAX_S ?? 1500);
const sampleS = Number(process.env.YR_SW_SAMPLE_S ?? 5);
const shotS = Number(process.env.YR_SW_SHOT_S ?? 30);
const afterS = Number(process.env.YR_SW_AFTER_S ?? 90);
const resolution = process.env.YR_SW_RESOLUTION ?? '1440x900';
// Only these count as a superweapon launch for stopping; support powers (spy plane, paradrops, psychic reveal) are
// still logged as events because they use the same recharge mechanism.
const stopTypes = new Set(
  (
    process.env.YR_SW_TYPES ??
    'NukeSpecial,IronCurtainSpecial,LightningStormSpecial,ChronoSphereSpecial,PsychicDominatorSpecial,GeneticConverterSpecial,ForceShieldSpecial'
  ).split(','),
);

const probe = `const controller = installVmWorker(self);
globalThis.__yrSw = (() => {
  let layout = null; // { vectorOffset, ownerOffset, typeOffset }
  const shim = () => controller.core?.shim;
  const LIMIT = 0x28000000;
  const ok = (a) => a >= 0x10000 && a < LIMIT;
  const u32 = (a) => shim().readU32(a) >>> 0, u8 = (a) => shim().readU8(a);
  const ascii = (a, n) => { if (!ok(a)) return null; let r = ''; for (let i = 0; i < n; i++) { const c = u8(a + i); if (!c) return r; if (c < 32 || c > 126) return null; r += String.fromCharCode(c); } return r; };
  const vector = (base) => ({ items: u32(base + 4), count: u32(base + 0x10) });
  const houses = () => { const v = vector(0xa80228); const list = []; if (ok(v.items) && v.count > 0 && v.count <= 64) for (let i = 0; i < v.count; i++) list.push(u32(v.items + i * 4)); return list; };
  const typeId = (p, off) => { const t = u32(p + off); return ok(t) ? ascii(t + 0x24, 24) : null; };
  function discover(house) {
    for (let off = 0x30; off < 0x3000; off += 4) {
      const { items, count } = vector(house + off);
      if (!ok(items) || count < 5 || count > 40) continue;
      const supers = []; let valid = true;
      for (let i = 0; i < count && valid; i++) { const p = u32(items + i * 4); if (!ok(p)) valid = false; else supers.push(p); }
      if (!valid) continue;
      let ownerOffset = -1, typeOffset = -1;
      for (let o = 0x24; o < 0x80 && ownerOffset < 0; o += 4) if (supers.every((p) => u32(p + o) === house)) ownerOffset = o;
      for (let o = 0x24; o < 0x80 && typeOffset < 0; o += 4) if (supers.every((p) => (typeId(p, o) ?? '').endsWith('Special'))) typeOffset = o;
      if (ownerOffset >= 0 && typeOffset >= 0) return { vectorOffset: off, ownerOffset, typeOffset };
    }
    return null;
  }
  return {
    perf: () => controller.core?.getGamePerformance() ?? null,
    phase: () => controller.core?.currentPhase ?? null,
    local() {
      const s = shim(); if (!s) return null;
      const h = u32(0xa83d4c); if (!ok(h)) return null;
      return { human: u8(h + 0x1ec), defeated: u8(h + 0x1f5) };
    },
    scan() {
      const s = shim(); if (!s) return null;
      const list = houses(); if (!list.length) return { error: 'no houses' };
      const local = u32(0xa83d4c);
      if (!layout) for (const h of list) { layout = discover(h); if (layout) break; }
      if (!layout) return { error: 'SuperClass vector not found', houses: list.length };
      const result = { layout, houses: [] };
      for (const [index, h] of list.entries()) {
        const { items, count } = vector(h + layout.vectorOffset);
        const supers = [];
        let consistent = ok(items) && count > 0 && count <= 40;
        if (consistent) for (let i = 0; i < count; i++) {
          const p = u32(items + i * 4);
          if (!ok(p) || u32(p + layout.ownerOffset) !== h) { consistent = false; break; }
          const words = []; for (let o = 0x24; o < 0x80; o += 4) words.push(u32(p + o) | 0);
          supers.push({ ptr: p, type: typeId(p, layout.typeOffset), words });
        }
        result.houses.push({ index, local: h === local, human: u8(h + 0x1ec), defeated: u8(h + 0x1f5), consistent, supers });
      }
      return result;
    },
  };
})();`;

type Super = { ptr: number; type: string | null; words: number[] };
type Scan = {
  error?: string;
  layout?: { vectorOffset: number; ownerOffset: number; typeOffset: number };
  houses?: { index: number; local: boolean; human: number; defeated: number; consistent: boolean; supers: Super[] }[];
};
type Sample = {
  t: number;
  frame: number | null;
  perf: GamePerformanceSample | null;
  scan: Scan | null;
  shell: string | null;
};

const t0 = Date.now();
const log = (step: string, detail?: unknown) =>
  console.log(
    `[yr-sw ${((Date.now() - t0) / 1000).toFixed(0)}s] ${step}`,
    detail === undefined ? '' : JSON.stringify(detail),
  );
const samples: Sample[] = [];
const events: unknown[] = [];
const report: Record<string, unknown> = { origin, maxS, sampleS, resolution, startedAt: new Date().toISOString() };
const flush = () => {
  writeFileSync(join(out, 'yr-superweapon.json'), JSON.stringify({ ...report, events }, null, 2));
  writeFileSync(join(out, 'yr-superweapon-samples.json'), JSON.stringify(samples));
};

/**
 * Launch heuristic over one super's history: a dword that is re-set to (about) the current native frame is a timer
 * start. A start that follows an earlier start by at least the duration stored 8 bytes later (the full recharge, so
 * the weapon had finished charging) and restores that same duration is a recharge restart, i.e. the weapon fired.
 * Power-loss resumes restore only the remaining time and therefore do not match.
 */
function detectLaunches(history: { frame: number; words: number[] }[], windowFrames: number) {
  const found: { offset: number; startFrame: number; previousStart: number; duration: number }[] = [];
  const width = history[0]?.words.length ?? 0;
  for (let w = 0; w + 2 < width; w++) {
    const starts: { start: number; duration: number }[] = [];
    for (let i = 1; i < history.length; i++) {
      const previous = history[i - 1]!,
        current = history[i]!;
      const value = current.words[w]!;
      if (value === previous.words[w]) continue;
      if (value <= previous.frame - 2 || value > current.frame + 2 || current.frame - value > windowFrames) continue;
      starts.push({ start: value, duration: current.words[w + 2]! });
    }
    for (let i = 1; i < starts.length; i++) {
      const a = starts[i - 1]!,
        b = starts[i]!;
      if (a.duration > 0 && b.duration === a.duration && b.start - a.start >= a.duration) {
        found.push({ offset: 0x24 + w * 4, startFrame: b.start, previousStart: a.start, duration: a.duration });
      }
    }
  }
  return found;
}

const browser = await chromium.launch({
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--js-flags=--max-old-space-size=4096'],
});
let failure: unknown = null;
try {
  const context = await browser.newContext({
    locale: 'zh-CN',
    ignoreHTTPSErrors: true,
    viewport: { width: 1440, height: 1000 },
  });
  await context.addInitScript((value) => localStorage.setItem('vm-resolution-yr', value), resolution);
  await context.route('**/src/adapter/vmWorker.ts*', async (route) => {
    const response = await route.fetch();
    const source = await response.text();
    assert.ok(source.includes('installVmWorker(self);'), 'read-only probe entry changed');
    await route.fulfill({ response, body: source.replace('installVmWorker(self);', probe) });
  });
  const page = await context.newPage();
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.stack ?? error.message));
  page.on('crash', () => pageErrors.push('renderer crashed'));
  const worker = (): Worker => {
    const found = page.workers().find((w) => w.url().includes('/vmWorker.ts'));
    if (!found) throw new Error('VM Worker not found');
    return found;
  };
  const shot = async (name: string) => {
    try {
      await page.locator('#screen').screenshot({ path: join(out!, `yr-sw-${name}.png`), timeout: 15_000 });
    } catch (error) {
      log('screenshot failed', String(error));
    }
  };

  // No debug=1: its side panel would cover the tactical view in screenshots. Battlefield = VM running, no native shell
  // page, a live local House, and the native simulation counter advancing (loading screens do not advance it).
  await page.goto(`${origin}/?start-page=battle`);
  await selectDevelopmentGame(page, 'yr');
  const startDeadline = Date.now() + 300_000;
  let firstFrame: number | null = null;
  for (;;) {
    if (Date.now() > startDeadline) throw new Error('battlefield not reached in 300 s');
    await page.waitForTimeout(2_000);
    const w = page.workers().find((candidate) => candidate.url().includes('/vmWorker.ts'));
    if (!w) continue;
    // getGamePerformance() is asynchronous; await it inside the Worker.
    const state = (await w.evaluate(async () => {
      const g = (globalThis as any).__yrSw;
      return { phase: g.phase(), local: g.local(), frame: (await g.perf())?.frame ?? null };
    })) as { phase: string | null; local: { human: number; defeated: number } | null; frame: number | null };
    if (['error', 'blocked', 'exited'].includes(state.phase ?? '')) throw new Error(`VM ${state.phase}`);
    const shell = await page.locator('#screen').getAttribute('data-shell-page');
    if (state.phase !== 'running' || shell || !state.local || state.frame === null) continue;
    if (firstFrame === null) firstFrame = state.frame;
    else if (state.frame > firstFrame + 120) break;
  }
  log('battlefield');
  await shot('000-start');
  const battleAt = Date.now();
  let lastShot = 0;
  let firstLaunchAt = 0;
  const reported = new Set<string>();
  while ((Date.now() - battleAt) / 1000 < maxS) {
    const w = worker();
    const perf = (await w.evaluate(() => (globalThis as any).__yrSw.perf())) as GamePerformanceSample | null;
    const scan = (await w.evaluate(() => (globalThis as any).__yrSw.scan())) as Scan | null;
    const shell = await page.locator('#screen').getAttribute('data-shell-page');
    const phase = (await w.evaluate(() => (globalThis as any).__yrSw.phase())) as string | null;
    const t = Math.round((Date.now() - battleAt) / 1000);
    samples.push({ t, frame: perf?.frame ?? null, perf, scan, shell });
    if (['error', 'blocked', 'exited'].includes(phase ?? '')) throw new Error(`VM ${phase}`);
    if (shell) {
      log('left the battlefield (match over?)', { shell });
      await shot(`${String(t).padStart(4, '0')}-shell`);
      break;
    }
    // Per super history across samples, keyed by house index and type.
    const histories = new Map<string, { frame: number; words: number[] }[]>();
    for (const sample of samples) {
      if (sample.frame === null) continue;
      for (const house of sample.scan?.houses ?? [])
        for (const sw of house.supers) {
          const key = `${house.index}:${sw.type}`;
          const list = histories.get(key) ?? [];
          list.push({ frame: sample.frame, words: sw.words });
          histories.set(key, list);
        }
    }
    const windowFrames = Math.max(200, (perf?.logicFps ?? 60) * sampleS * 2);
    for (const [key, history] of histories) {
      for (const launch of detectLaunches(history, windowFrames)) {
        const id = `${key}@${launch.startFrame}`;
        if (reported.has(id)) continue;
        reported.add(id);
        const event = { t, key, ...launch, nativeFrame: perf?.frame };
        events.push(event);
        log('LAUNCH detected', event);
        await shot(`${String(t).padStart(4, '0')}-launch-${key.replace(/[^A-Za-z0-9]/g, '_')}`);
        if (!firstLaunchAt && stopTypes.has(key.split(':')[1] ?? '')) firstLaunchAt = Date.now();
      }
    }
    if (t - lastShot >= shotS) {
      lastShot = t;
      await shot(String(t).padStart(4, '0'));
      const granted = (scan?.houses ?? []).map((h) => h.supers.length);
      log('sample', {
        frame: perf?.frame,
        logicFps: perf?.logicFps,
        layout: scan?.layout,
        error: scan?.error,
        supersPerHouse: granted,
      });
      flush();
    }
    if (firstLaunchAt && (Date.now() - firstLaunchAt) / 1000 >= afterS) break;
    await page.waitForTimeout(sampleS * 1000);
  }
  await shot('zzzz-end');
  report.pageErrors = pageErrors;
  report.layout = [...samples].reverse().find((s) => s.scan?.layout)?.scan?.layout ?? null;
  report.probeErrors = [...new Set(samples.map((s) => s.scan?.error).filter(Boolean))];
  report.observedS = Math.round((Date.now() - battleAt) / 1000);
  report.frames = [
    samples.find((s) => s.frame !== null)?.frame ?? null,
    [...samples].reverse().find((s) => s.frame !== null)?.frame ?? null,
  ];
  report.stopTypes = [...stopTypes];
  report.result = firstLaunchAt
    ? 'superweapon-launch-detected'
    : events.length
      ? 'support-power-only'
      : 'no-launch-detected';
  log('done', { events: events.length, layout: report.layout, pageErrors });
} catch (error) {
  failure = error;
  report.result = 'error';
  report.error = String((error as Error)?.stack ?? error);
  console.error('[yr-sw] FAIL', error);
  try {
    await browser
      .contexts()[0]
      ?.pages()[0]
      ?.screenshot({ path: join(out, 'yr-sw-failure.png') });
  } catch {
    /* renderer may be gone */
  }
} finally {
  report.finishedAt = new Date().toISOString();
  flush();
  await browser.close();
}
if (failure) process.exit(1);
