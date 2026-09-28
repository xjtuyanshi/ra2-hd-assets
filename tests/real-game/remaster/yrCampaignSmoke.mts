/**
 * Remaster phase-1 smoke (not part of any CI entry): start the first YR Allied campaign mission through the
 * normal menus in Chromium, observe the briefing movie, and confirm the mission map loads and simulates.
 *
 * Guest input is ordinary player input only (mouse clicks on native menu controls, Esc through a real
 * keyboard event on the focused canvas). A read-only accessor is appended to the test-intercepted vmWorker.ts
 * module exactly like tests/real-game/browser/battleStartupBrowserSmoke.mts; it never writes guest memory.
 *
 * Usage (development server on RA2_BROWSER_ORIGIN serving a full YR 1.001 install with movmd03.mix):
 *   YR_SMOKE_OUT=/path/to/out pnpm exec tsx tests/real-game/remaster/yrCampaignSmoke.mts
 * Optional: YR_CAMPAIGN_WATCH_S (seconds of movie to observe before pressing Esc, default 20; 0 lets the
 * movie finish on its own), YR_CAMPAIGN_MISSION_S (seconds to observe the mission, default 45).
 */
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type Locator, type Page, type Worker } from '@playwright/test';
import { selectDevelopmentGame } from '../../helpers/selectDevelopmentGame';
import { summarizeGamePerformance } from '../../helpers/gamePerformance';
import type { GamePerformanceSample } from '../../../src/games/performance';

const origin = process.env.RA2_BROWSER_ORIGIN ?? 'https://127.0.0.1:15174';
const out = process.env.YR_SMOKE_OUT;
assert.ok(out, 'YR_SMOKE_OUT is required');
mkdirSync(out, { recursive: true });
const watchMovieS = Number(process.env.YR_CAMPAIGN_WATCH_S ?? 20);
const missionS = Number(process.env.YR_CAMPAIGN_MISSION_S ?? 45);
const battleResolution = process.env.YR_CAMPAIGN_RESOLUTION ?? '1440x900';

// clickLogical takes coordinates normalized to 1440x900, like tests/real-game/browser/ra2BrowserSmoke.mts (YR sidebar).
const MAIN_SINGLE_PLAYER: readonly [number, number] = [1288, 330];
const SINGLE_PLAYER_CAMPAIGN: readonly [number, number] = [1288, 330];
// Allied logo on the 800x600 CampaignMenu, guest coordinates (same point the existing browser smoke uses).
const ALLIED_LOGO: readonly [number, number] = [454, 188];

// YR 1.001 read-only layout shared with battleStartupBrowserSmoke.mts.
const ABI = { local: 0xa83d4c, human: 0x1ec, units: 0x5518, dead: 0x1f5 };
const probe = `const controller = installVmWorker(self);
globalThis.__yrSmoke = {
  perf: () => controller.core?.getGamePerformance() ?? null,
  house() {
    const s = controller.core?.shim; if (!s) return null;
    const house = s.readU32(${ABI.local}); if (!house) return null;
    const units = s.readU32(house + ${ABI.units}), size = s.readU32(house + ${ABI.units} + 4);
    let total = 0;
    if (units && size > 0 && size <= 4096) for (let i = 0; i < size; i++) total += s.readU32(units + i * 4);
    return { human: s.readU8(house + ${ABI.human}), dead: s.readU8(house + ${ABI.dead}), units: total };
  },
};`;

type Report = Record<string, unknown>;
const report: Report = { origin, watchMovieS, missionS, battleResolution, startedAt: new Date().toISOString() };
const steps: { t: number; step: string; detail?: unknown }[] = [];
const t0 = Date.now();
const log = (step: string, detail?: unknown) => {
  steps.push({ t: Math.round((Date.now() - t0) / 100) / 10, step, detail });
  console.log(
    `[yr-campaign ${((Date.now() - t0) / 1000).toFixed(1)}s] ${step}`,
    detail === undefined ? '' : JSON.stringify(detail),
  );
};
const flush = () => writeFileSync(join(out, 'yr-campaign.json'), JSON.stringify({ ...report, steps }, null, 2));

async function expectShellPage(page: Page, expected: string, timeout: number): Promise<void> {
  await page.waitForFunction(
    (name) => document.querySelector<HTMLCanvasElement>('#screen')?.dataset.shellPage?.toLowerCase().includes(name),
    expected.toLowerCase(),
    { timeout },
  );
}

function callsOf(raw: string | null): Record<string, number> {
  return JSON.parse(raw ?? '{}') as Record<string, number>;
}

async function vmStatus(canvas: Locator): Promise<{ phase: string; detail: string } | null> {
  const raw = await canvas.getAttribute('data-vm-status');
  return raw ? (JSON.parse(raw) as { phase: string; detail: string }) : null;
}

async function assertHealthy(canvas: Locator, where: string): Promise<void> {
  const status = await vmStatus(canvas);
  if (status && ['error', 'blocked', 'exited'].includes(status.phase)) {
    throw new Error(`${where}: VM ${status.phase}: ${status.detail}`);
  }
}

async function moveLockedGuest(canvas: Locator, x: number, y: number): Promise<void> {
  const box = (await canvas.boundingBox())!;
  const [width, height] = ((await canvas.getAttribute('data-vm-resolution')) ?? '800x600').split('x').map(Number);
  const cursor = (await canvas.getAttribute('data-vm-cursor'))?.match(/^(\d+),(\d+)\//);
  const currentX = Number(cursor?.[1] ?? width! / 2);
  const currentY = Number(cursor?.[2] ?? height! / 2);
  const relative = (delta: number, css: number, logical: number) => {
    if (!delta) return 0;
    const scaled = (delta * css) / logical;
    return Math.sign(scaled) * Math.max(1, Math.abs(scaled));
  };
  await canvas.dispatchEvent('pointermove', {
    pointerType: 'mouse',
    isPrimary: true,
    pointerId: 1,
    movementX: relative(x - currentX, box.width, width!),
    movementY: relative(y - currentY, box.height, height!),
  });
}

/** Click at guest coordinates; under Pointer Lock headless Chromium needs explicit relative PointerEvents. */
async function clickGuest(page: Page, canvas: Locator, x: number, y: number): Promise<void> {
  const box = await canvas.boundingBox();
  if (!box) throw new Error('canvas not visible');
  const [width, height] = ((await canvas.getAttribute('data-vm-resolution')) ?? '800x600').split('x').map(Number);
  if (await page.evaluate(() => document.pointerLockElement?.id === 'screen')) {
    await moveLockedGuest(canvas, width! / 4, y);
    await page.waitForTimeout(100);
    await moveLockedGuest(canvas, x, y);
    await page.waitForTimeout(300);
    for (const type of ['pointerdown', 'pointerup']) {
      await canvas.dispatchEvent(type, {
        pointerType: 'mouse',
        isPrimary: true,
        pointerId: 1,
        button: 0,
        buttons: type === 'pointerdown' ? 1 : 0,
      });
      await page.waitForTimeout(200);
    }
    return;
  }
  await page.mouse.move(box.x + box.width * 0.25, box.y + (y / height!) * box.height);
  await page.waitForTimeout(100);
  await page.mouse.move(box.x + (x / width!) * box.width, box.y + (y / height!) * box.height);
  await page.waitForTimeout(300);
  await page.mouse.down();
  await page.waitForTimeout(200);
  await page.mouse.up();
}

async function clickLogical(page: Page, canvas: Locator, x: number, y: number): Promise<void> {
  const [width, height] = ((await canvas.getAttribute('data-vm-resolution')) ?? '800x600').split('x').map(Number);
  await clickGuest(page, canvas, (x / 1440) * width!, (y / 900) * height!);
}

async function clickUntilShellPage(page: Page, canvas: Locator, expected: string, x: number, y: number) {
  const offsets = [
    [0, 0],
    [-20, 0],
    [20, 0],
    [0, -10],
    [0, 10],
    [-35, -12],
    [35, 12],
  ] as const;
  for (const [dx, dy] of offsets) {
    const current = (await canvas.getAttribute('data-shell-page')) ?? '';
    if (current.toLowerCase().includes(expected.toLowerCase())) return;
    await clickLogical(page, canvas, x + dx, y + dy);
    try {
      await expectShellPage(page, expected, 6_000);
      return;
    } catch {
      await assertHealthy(canvas, `menu transition to ${expected}`);
    }
  }
  await expectShellPage(page, expected, 1_000);
}

/** A real keyboard Esc delivered to the focused canvas (page forwards keydown/keyup to the guest). */
async function pressGuestEscape(page: Page, canvas: Locator): Promise<void> {
  if (await page.evaluate(() => document.pointerLockElement !== null)) {
    await page.evaluate(() => document.exitPointerLock());
    await page.waitForFunction(() => document.pointerLockElement === null, undefined, { timeout: 5_000 });
  }
  await canvas.focus();
  await page.keyboard.press('Escape');
}

async function shot(page: Page, name: string): Promise<string> {
  const path = join(out!, `yr-campaign-${name}.png`);
  try {
    await page.locator('#screen').screenshot({ path, timeout: 15_000 });
  } catch (error) {
    log('screenshot failed', { name, error: String(error) });
  }
  return path;
}

const browser = await chromium.launch({
  args: [
    '--no-sandbox',
    '--enable-unsafe-swiftshader',
    '--js-flags=--max-old-space-size=4096',
    '--autoplay-policy=no-user-gesture-required',
  ],
});
let failure: unknown = null;
let pageRef: Page | null = null;
try {
  const context = await browser.newContext({
    locale: 'zh-CN',
    viewport: { width: 1440, height: 1000 },
    ignoreHTTPSErrors: true,
  });
  await context.addInitScript((resolution) => {
    localStorage.setItem('ra2-vm-preferred-game', 'yr');
    localStorage.setItem('vm-resolution-yr', resolution);
    localStorage.removeItem('vm-clock-rate');
  }, battleResolution);
  await context.route('**/src/adapter/vmWorker.ts*', async (route) => {
    const response = await route.fetch();
    const source = await response.text();
    assert.ok(source.includes('installVmWorker(self);'), 'read-only probe entry changed');
    await route.fulfill({ response, body: source.replace('installVmWorker(self);', probe) });
  });
  const page = await context.newPage();
  pageRef = page;
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.stack ?? error.message));
  page.on('crash', () => pageErrors.push('renderer crashed'));
  const worker = async (): Promise<Worker> => {
    const found = page.workers().find((w) => w.url().includes('/vmWorker.ts'));
    if (!found) throw new Error('VM Worker not found');
    return found;
  };
  const perf = async () =>
    (await (await worker()).evaluate(() => (globalThis as any).__yrSmoke.perf())) as GamePerformanceSample | null;
  const house = async () =>
    (await (await worker()).evaluate(() => (globalThis as any).__yrSmoke.house())) as {
      human: number;
      dead: number;
      units: number;
    } | null;

  await page.goto(`${origin}/?debug=1`, { waitUntil: 'domcontentloaded' });
  await selectDevelopmentGame(page, 'yr');
  const canvas = page.locator('#screen');
  log('resources selected');

  // A full YR package may play its intro before the main menu; dismiss it with Esc like a player would.
  const menuDeadline = Date.now() + 240_000;
  let introEscapes = 0;
  while (!((await canvas.getAttribute('data-shell-page')) ?? '').toLowerCase().includes('mainmenu')) {
    if (Date.now() > menuDeadline) throw new Error('main menu not reached in 240 s');
    await assertHealthy(canvas, 'startup');
    const opens = callsOf(await canvas.getAttribute('data-vm-bink-calls'))['BINKW32.DLL!_BinkOpen@8'] ?? 0;
    if (opens > 0 && !(await canvas.getAttribute('data-shell-page')) && Date.now() - t0 > 20_000 && introEscapes < 20) {
      if (introEscapes === 0) await shot(page, '00-intro');
      await pressGuestEscape(page, canvas);
      introEscapes++;
    }
    await page.waitForTimeout(2_000);
  }
  report.introEscapes = introEscapes;
  log('main menu', { introEscapes, bink: callsOf(await canvas.getAttribute('data-vm-bink-calls')) });
  await page.waitForTimeout(8_000);
  await shot(page, '01-main-menu');

  await clickUntilShellPage(page, canvas, 'singleplayer', ...MAIN_SINGLE_PLAYER);
  log('single player menu');
  await page.waitForTimeout(1_500);
  await shot(page, '02-single-player');
  await clickUntilShellPage(page, canvas, 'campaign', ...SINGLE_PLAYER_CAMPAIGN);
  log('campaign menu');
  await page.waitForTimeout(2_000);
  await shot(page, '03-campaign-menu');

  const binkBefore = callsOf(await canvas.getAttribute('data-vm-bink-calls'));
  const audioBefore = callsOf(await canvas.getAttribute('data-vm-audio-calls'));
  for (const [dx, dy] of [
    [0, 0],
    [-20, 0],
    [20, 0],
    [0, -10],
    [0, 10],
  ] as const) {
    if (!(await canvas.getAttribute('data-shell-page'))) break;
    await clickGuest(page, canvas, ALLIED_LOGO[0] + dx, ALLIED_LOGO[1] + dy);
    try {
      await page.waitForFunction(
        () => !document.querySelector<HTMLCanvasElement>('#screen')?.dataset.shellPage,
        undefined,
        {
          timeout: 4_000,
        },
      );
      break;
    } catch {
      await assertHealthy(canvas, 'choosing Allied campaign');
    }
  }
  assert.equal(
    await canvas.getAttribute('data-shell-page'),
    null,
    'still on CampaignMenu after clicking the Allied logo',
  );
  log('Allied campaign chosen', { binkBefore });

  // Briefing movie: require a new BinkOpen, changing frames and DirectSound activity.
  await page.waitForFunction(
    (before) => {
      const calls = JSON.parse(document.querySelector<HTMLCanvasElement>('#screen')?.dataset.vmBinkCalls ?? '{}');
      return (calls['BINKW32.DLL!_BinkOpen@8'] ?? 0) > before;
    },
    binkBefore['BINKW32.DLL!_BinkOpen@8'] ?? 0,
    { timeout: 60_000 },
  );
  const movieOpenedAt = Date.now();
  log('briefing movie opened', callsOf(await canvas.getAttribute('data-vm-bink-calls')));
  const hashes = new Set<string>();
  const movieShots: string[] = [];
  const shotAt = new Set([1, 5, 10, 15, 30, 60, 90, 120]);
  let lastShot = 0;
  const watchLimitS = watchMovieS > 0 ? watchMovieS : 600;
  let movieEndedNaturally = false;
  while ((Date.now() - movieOpenedAt) / 1000 < watchLimitS) {
    hashes.add(
      (await canvas.getAttribute('data-vm-frame-sample')) ?? `frame:${await canvas.getAttribute('data-vm-frame')}`,
    );
    const elapsed = Math.floor((Date.now() - movieOpenedAt) / 1000);
    if (shotAt.has(elapsed) && elapsed !== lastShot) {
      lastShot = elapsed;
      movieShots.push(await shot(page, `04-movie-${String(elapsed).padStart(3, '0')}s`));
    }
    await assertHealthy(canvas, 'briefing movie');
    if (watchMovieS <= 0 && (await canvas.getAttribute('data-vm-resolution')) === battleResolution) {
      movieEndedNaturally = true;
      break;
    }
    await page.waitForTimeout(250);
  }
  const binkDuring = callsOf(await canvas.getAttribute('data-vm-bink-calls'));
  const audioDuring = callsOf(await canvas.getAttribute('data-vm-audio-calls'));
  report.movie = {
    observedS: Math.round((Date.now() - movieOpenedAt) / 100) / 10,
    distinctFrameSamples: hashes.size,
    endedNaturally: movieEndedNaturally,
    binkBefore,
    binkDuring,
    createSoundBuffer: [
      audioBefore['DSOUND.COM!IDirectSound.CreateSoundBuffer'] ?? 0,
      audioDuring['DSOUND.COM!IDirectSound.CreateSoundBuffer'] ?? 0,
    ],
    play: [
      audioBefore['DSOUND.COM!IDirectSoundBuffer.Play'] ?? 0,
      audioDuring['DSOUND.COM!IDirectSoundBuffer.Play'] ?? 0,
    ],
    lock: [
      audioBefore['DSOUND.COM!IDirectSoundBuffer.Lock'] ?? 0,
      audioDuring['DSOUND.COM!IDirectSoundBuffer.Lock'] ?? 0,
    ],
    screenshots: movieShots,
  };
  log('movie observed', report.movie);
  flush();
  assert.ok(hashes.size >= 10, `briefing movie did not animate: ${hashes.size} distinct frame samples`);
  assert.ok(
    (audioDuring['DSOUND.COM!IDirectSoundBuffer.Lock'] ?? 0) > (audioBefore['DSOUND.COM!IDirectSoundBuffer.Lock'] ?? 0),
    'no DirectSound PCM writes during the briefing movie',
  );

  // Skip the rest of the movie (and any follow-up movie) with Esc until the battlefield resolution applies.
  const skipDeadline = Date.now() + 180_000;
  let skips = 0;
  let lastOpens = binkDuring['BINKW32.DLL!_BinkOpen@8'] ?? 0;
  let lastSkipAt = 0;
  while ((await canvas.getAttribute('data-vm-resolution')) !== battleResolution) {
    if (Date.now() > skipDeadline) throw new Error('battlefield resolution never applied after the movie');
    await assertHealthy(canvas, 'after movie');
    const opens = callsOf(await canvas.getAttribute('data-vm-bink-calls'))['BINKW32.DLL!_BinkOpen@8'] ?? 0;
    const closes = callsOf(await canvas.getAttribute('data-vm-bink-calls'))['BINKW32.DLL!_BinkClose@4'] ?? 0;
    // Only press Esc while a fullscreen movie is open (opens > closes) and not faster than every 3 s.
    if (!movieEndedNaturally && opens > closes && Date.now() - lastSkipAt > 3_000 && skips < 10) {
      if (opens !== lastOpens || skips === 0) {
        await pressGuestEscape(page, canvas);
        skips++;
        lastSkipAt = Date.now();
        lastOpens = opens;
        log('Esc sent to skip movie', { opens, closes });
      }
    }
    await page.waitForTimeout(1_000);
  }
  report.movieSkips = skips;
  log('battle resolution applied', { resolution: battleResolution });
  await shot(page, '05-loading-or-map');

  // Playable battlefield: sidebar and map pixels, native local House alive with units, native frames advancing.
  const fieldDeadline = Date.now() + 120_000;
  let signal = [0, 0];
  for (;;) {
    await assertHealthy(canvas, 'mission load');
    signal = ((await canvas.getAttribute('data-vm-battlefield')) ?? '0,0').split(',').map(Number);
    if (signal[0]! >= 0.08 && signal[1]! >= 0.05) break;
    if (Date.now() > fieldDeadline) throw new Error(`battlefield never became playable: ${signal.join(',')}`);
    await page.waitForTimeout(500);
  }
  log('battlefield visible', { rightEdge: signal[0], field: signal[1] });
  await shot(page, '06-mission-start');
  const samples: GamePerformanceSample[] = [];
  const houses: unknown[] = [];
  const missionStart = Date.now();
  let lastMissionShot = 0;
  while ((Date.now() - missionStart) / 1000 < missionS) {
    const sample = await perf();
    if (sample) samples.push(sample);
    houses.push(await house());
    const elapsed = Math.floor((Date.now() - missionStart) / 1000);
    if (elapsed - lastMissionShot >= 15) {
      lastMissionShot = elapsed;
      await shot(page, `07-mission-${String(elapsed).padStart(3, '0')}s`);
    }
    await assertHealthy(canvas, 'mission');
    await page.waitForTimeout(1_000);
  }
  await shot(page, '08-mission-end');
  const lastHouse = houses.at(-1) as { human: number; dead: number; units: number } | null;
  const summary = summarizeGamePerformance(samples);
  report.mission = {
    shell: await canvas.getAttribute('data-shell-page'),
    resolution: await canvas.getAttribute('data-vm-resolution'),
    battlefieldSignal: signal,
    localHouseFirst: houses[0],
    localHouseLast: lastHouse,
    nativePerf: summary,
    firstSample: samples[0] ?? null,
    lastSample: samples.at(-1) ?? null,
  };
  report.pageErrors = pageErrors;
  log('mission observed', report.mission);
  flush();
  assert.ok(
    lastHouse && lastHouse.human === 1 && lastHouse.dead === 0 && lastHouse.units > 0,
    'local House missing/dead/no units',
  );
  assert.ok(summary && summary.frames > 0, 'native simulation counter did not advance in the mission');
  assert.deepEqual(pageErrors, [], `page errors: ${pageErrors.join('\n')}`);
  report.result = 'pass';
  log('PASS');
} catch (error) {
  failure = error;
  report.result = 'fail';
  report.error = String((error as Error)?.stack ?? error);
  console.error('[yr-campaign] FAIL', error);
  if (pageRef) {
    try {
      report.failureState = await pageRef.locator('#screen').evaluate((c) => ({ ...(c as HTMLElement).dataset }));
    } catch {
      /* renderer may be gone */
    }
    await shot(pageRef, '99-failure');
  }
} finally {
  report.finishedAt = new Date().toISOString();
  flush();
  await browser.close();
}
if (failure) process.exit(1);
