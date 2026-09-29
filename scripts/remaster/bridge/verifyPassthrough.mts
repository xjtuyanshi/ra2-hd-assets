/**
 * Remaster bridge: empirical verification of the YR 1.001 native overlay passthrough (src/games/yr/tacticalPassthrough.ts,
 * src/games/renderPassthrough.ts) together with the HD bridge's key-colour compositing (src/ui/pages/game/hdBridge.ts,
 * vmFrameRenderer.setTransparentKey).
 *
 * It starts a real YR skirmish through `?start-page=battle&hd=1` (the scratch installation's RA2MD.INI [Skirmish]
 * section picks the map and one AI; the map's HD cache must exist so the bridge engages), then:
 *
 * - checks the patches installed and the bridge switched them on (terrain + objects) with the key path in use;
 * - deploys the MCV, opens the building placement grid for a power plant, drags a band box, selects units, gives move
 *   orders and sends a chat message, capturing each with the bridge on (passthrough) and toggled off (original
 *   picture): raw primary surfaces (exact guest pixels) and page screenshots (HD world + native overlays);
 * - compares every non-key pixel of an "on" frame with the same pixel of the "off" frame taken right after it;
 * - checks for world pixels leaking through with every category on: in a quiet frame (nothing selected, cursor over the
 *   sidebar) the tactical area must be key colour except for connected components the report lists;
 * - measures logic FPS and guest instructions per logic frame for passthrough off / terrain+objects / all, in
 *   interleaved windows of the same scene;
 * - checks that the effect lists keep ageing with effects passthrough on: with a Soviet player (RA2MD.INI
 *   [MultiPlayer] Side=Russians and SideEx=8) it builds a barracks after the power plant, trains Tesla troopers and
 *   force-fires them, then requires the EBolt::Array (0x8A0E98) count to keep draining during the fire and the
 *   EBolt, LineTrail (0xABCB88) and RadBeam (0xB04A70) counts to be 0 afterwards while every category stays on, and
 *   the tactical view to stay key colour while bolts are alive;
 * - runs a stability window (default 10 minutes of battle) with the AI attacking, switching categories and the bridge
 *   periodically, sampling the patches' data page, the effect-list counts and the game's progress; a lost match is
 *   followed by a new one.
 *
 * The only guest input is ordinary mouse/keyboard input a player would give, plus the development speed switch
 * (VmShell.setGameSpeedFlag) to slow the game down during the scripted captures. Evidence goes to PASSTHROUGH_OUT; it
 * contains frames and screenshots of the original game's art, so keep it outside Git (the script refuses a directory
 * inside the repository other than under the gitignored gameres/).
 *
 * Usage (development server started with RA2_GAME_ROOT=<scratch root> RA2_DEV_HTTP=1):
 *   PASSTHROUGH_OUT=/path RA2_BROWSER_ORIGIN=http://127.0.0.1:15184 pnpm exec tsx scripts/remaster/bridge/verifyPassthrough.mts
 */
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadavg } from 'node:os';
import { chromium, type Page, type Worker } from '@playwright/test';
import { selectDevelopmentGame } from '../../../tests/helpers/selectDevelopmentGame';

const env = process.env;
const num = (key: string, fallback: number) => (env[key] ? Number(env[key]) : fallback);
const origin = env.RA2_BROWSER_ORIGIN ?? 'http://127.0.0.1:15184';
const out = env.PASSTHROUGH_OUT ?? '';
assert.ok(out, 'PASSTHROUGH_OUT (output directory) is required');
{
  // Evidence holds frames of the original art: never inside the repository, except the gitignored gameres/.
  const repository = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
  const inside = relative(repository, resolve(out));
  const escapes = inside.startsWith('..') || resolve(inside) === inside;
  assert.ok(
    escapes || inside === 'gameres' || inside.startsWith(`gameres${sep}`),
    `PASSTHROUGH_OUT must be outside the repository (or under gameres/): ${out}`,
  );
}
mkdirSync(out, { recursive: true });
const mode = env.VM_BROWSER_MODE === 'main' ? 'main' : 'worker';
const headless = env.PASSTHROUGH_HEADLESS !== '0';
const gpu = (env.PASSTHROUGH_GPU ?? (process.platform === 'darwin' ? '1' : '0')) === '1';
const stabilitySeconds = num('PASSTHROUGH_STABILITY_S', 600);
const perfRounds = num('PASSTHROUGH_PERF_ROUNDS', 4);
const perfWindowMs = num('PASSTHROUGH_PERF_WINDOW_S', 6) * 1000;
const captureSpeed = num('PASSTHROUGH_CAPTURE_SPEED', 4);
const KEY = 0xf81f;

/**
 * Installed into the VM thread. Reads guest memory only, except through the public passthrough/speed setters.
 * `capture(name)` keeps the raw RGB565 tactical frame so `compare(on, off)` can check overlay pixels exactly.
 */
const probe = `(async () => {
  if (globalThis.__pt) return true;
  const core = () => globalThis.__passthroughCoreGetter?.();
  const c0 = core();
  if (!c0?.shim || !c0.emulator) return false;
  const KEY = ${KEY};
  const u32 = (a) => { const b = core().emulator.read_memory(a, 4); return (b[0] | b[1] << 8 | b[2] << 16 | b[3] << 24) >>> 0; };
  const f64 = (a) => new DataView(core().emulator.read_memory(a, 8).slice().buffer).getFloat64(0, true);
  const frames = {};
  const primary = () => { const s = core().shim; return s.surfaces.get(s.primarySurface); };
  const P = {
    env() {
      const c = core(), s = c?.shim, p = s?.surfaces?.get(s.primarySurface);
      return { phase: c?.currentPhase ?? null, shell: s?.inspectShellPageTitle() ?? null,
        surface: p ? { width: p.width, height: p.height } : null, installed: !!c?.renderPassthrough };
    },
    async perf() { return await core().getGamePerformance(); },
    stats() { const c = core(); return c.renderPassthrough ? c.renderPassthrough.read(c.emulator) : null; },
    set(flags) { return core().setTacticalPassthrough(flags); },
    speed(value) { return core().setGameSpeedFlag(value); },
    sanity() {
      const control = core().renderPassthrough; if (!control) return null;
      const d = control.configAddress;
      return { address: d, magic: u32(d), depth: u32(d + 4), stackOffset: u32(d + 8) - d, flags: u32(d + 0x30),
        key: u32(d + 0x34), fills: u32(d + 0x38), redrawRequest: u32(d + 0x3c), redraws: u32(d + 0x40),
        applied: u32(d + 0x44) };
    },
    /** Live counts of the effect lists whose DrawAll also ages, removes and frees their objects. */
    lists() { return { ebolt: u32(${0x8a0e98}), lineTrail: u32(${0xabcb88}), radBeam: u32(${0xb04a70}) }; },
    /**
     * Sample the lists every \`ms\` in the VM thread: maxima, final counts, the latched categories seen, how often each
     * list drained back to 0, and the longest stretch it stayed non-empty while effects passthrough was applied.
     */
    listsStart(ms) {
      P.listsStop();
      const names = ['ebolt', 'lineTrail', 'radBeam'];
      const zero = () => Object.fromEntries(names.map((n) => [n, 0]));
      const s = { ms, samples: 0, appliedMin: 7, appliedMax: 0, max: zero(), final: zero(), drains: zero(),
        longestNonEmptyWithEffectsMs: zero(), timeline: [] };
      const since = {}, prev = zero();
      P._lists = s;
      P._listsTimer = setInterval(() => {
        const c = core(); if (!c?.renderPassthrough) return;
        const now = performance.now(), v = P.lists(), applied = c.renderPassthrough.read(c.emulator).applied;
        s.samples++; s.appliedMin = Math.min(s.appliedMin, applied); s.appliedMax = Math.max(s.appliedMax, applied);
        let changed = false;
        for (const n of names) {
          s.max[n] = Math.max(s.max[n], v[n]);
          if (prev[n] > 0 && v[n] === 0) s.drains[n]++;
          if (v[n] > 0 && applied & 4) { since[n] ??= now; s.longestNonEmptyWithEffectsMs[n] = Math.max(s.longestNonEmptyWithEffectsMs[n], now - since[n]); }
          else delete since[n];
          if (v[n] !== prev[n]) changed = true;
          prev[n] = v[n];
        }
        s.final = { ...v };
        if (changed && s.timeline.length < 400) s.timeline.push([Math.round(now), applied, v.ebolt, v.lineTrail, v.radBeam]);
      }, ms);
      return true;
    },
    listsStop() {
      if (P._listsTimer) clearInterval(P._listsTimer);
      P._listsTimer = null;
      return P._lists ?? null;
    },
    async objects() {
      const s = await core().getRenderState(); if (!s?.view) return null;
      const zf = f64(${0xb0cd48});
      const project = (o) => { const adj = Math.trunc(o.z * zf + (o.z >= 728 ? 1 : 0) + 0.5);
        return { sx: Math.trunc((30 * o.x - 30 * o.y) / 256) - s.view.x, sy: Math.trunc((15 * o.y + 15 * o.x) / 256) - adj - s.view.y }; };
      return { frame: s.frame, local: s.localHouse, houses: s.houses.map((h) => ({ index: h.index, local: h.index === s.localHouse })),
        objects: s.objects.map((o) => ({ id: o.id, kind: o.kind, type: o.type, owner: o.owner, health: o.health, selected: o.isSelected, ...project(o) })) };
    },
    windows() {
      const s = core().shim;
      return s.inspectWindowState().filter((w) => s.isWindowVisible(w.hwnd)).map((w) => ({ text: w.text, className: w.className, rect: s.screenRect(w.hwnd) }));
    },
    grid() {
      const p = primary(), px = core().emulator.read_memory(p.pixels, p.pitch * p.height);
      let green = 0, red = 0;
      for (let y = 0; y < p.height - 32; y++) for (let x = 0; x < p.width - 168; x++) {
        const o = y * p.pitch + x * 2, v = px[o] | (px[o + 1] << 8);
        if (v === 0x0620) green++; else if (v === 0xe800) red++;
      }
      return { green, red };
    },
    /** Raw primary surface: key statistics inside the tactical rectangle, connected non-key components, PNG. */
    async capture(name, exclude) {
      const p = primary(), w = p.width, h = p.height, tw = w - 168, th = h - 32;
      const px = core().emulator.read_memory(p.pixels, p.pitch * p.height);
      const raw = new Uint16Array(w * h);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const o = y * p.pitch + x * 2; raw[y * w + x] = px[o] | (px[o + 1] << 8); }
      frames[name] = { w, h, raw };
      let key = 0; const seen = new Uint8Array(tw * th); const components = [];
      const skip = (x, y) => exclude && x >= exclude.x0 && x < exclude.x1 && y >= exclude.y0 && y < exclude.y1;
      for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) if (raw[y * w + x] === KEY) key++;
      for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) {
        if (seen[y * tw + x] || raw[y * w + x] === KEY) continue;
        const stack = [[x, y]]; seen[y * tw + x] = 1; let n = 0, x0 = x, x1 = x, y0 = y, y1 = y; const colours = new Map();
        while (stack.length) { const [cx, cy] = stack.pop(); n++; const v = raw[cy * w + cx]; colours.set(v, (colours.get(v) ?? 0) + 1);
          x0 = Math.min(x0, cx); x1 = Math.max(x1, cx); y0 = Math.min(y0, cy); y1 = Math.max(y1, cy);
          for (const [nx, ny] of [[cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]])
            if (nx >= 0 && ny >= 0 && nx < tw && ny < th && !seen[ny * tw + nx] && raw[ny * w + nx] !== KEY) { seen[ny * tw + nx] = 1; stack.push([nx, ny]); } }
        if (!skip((x0 + x1) >> 1, (y0 + y1) >> 1)) components.push({ pixels: n, x0, y0, x1, y1, colours: [...colours].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([v, c]) => [v.toString(16), c]) });
      }
      components.sort((a, b) => b.pixels - a.pixels);
      // Pixels with a magenta cast (translucent drawing blended with the key): red and blue both well above green.
      const nearKey = { pixels: 0, x0: 1e9, y0: 1e9, x1: -1, y1: -1, samples: [] };
      for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) {
        const v = raw[y * w + x]; if (v === KEY) continue;
        const r = (((v >> 11) & 31) << 3) | (((v >> 11) & 31) >> 2), g = (((v >> 5) & 63) << 2) | (((v >> 5) & 63) >> 4), b = ((v & 31) << 3) | ((v & 31) >> 2);
        if (r - g < 40 || b - g < 40 || skip(x, y)) continue;
        nearKey.pixels++; nearKey.x0 = Math.min(nearKey.x0, x); nearKey.y0 = Math.min(nearKey.y0, y); nearKey.x1 = Math.max(nearKey.x1, x); nearKey.y1 = Math.max(nearKey.y1, y);
        if (nearKey.samples.length < 8) nearKey.samples.push([x, y, v.toString(16)]);
      }
      const canvas = new OffscreenCanvas(w, h), ctx = canvas.getContext('2d'), img = ctx.createImageData(w, h);
      for (let i = 0; i < w * h; i++) { const v = raw[i], r = (v >> 11) & 31, g = (v >> 5) & 63, b = v & 31;
        img.data[i * 4] = (r << 3) | (r >> 2); img.data[i * 4 + 1] = (g << 2) | (g >> 4); img.data[i * 4 + 2] = (b << 3) | (b >> 2); img.data[i * 4 + 3] = 255; }
      ctx.putImageData(img, 0, 0);
      const bytes = new Uint8Array(await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer());
      let bin = ''; for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      return { name, width: w, height: h, tactical: { width: tw, height: th }, keyPixels: key, nonKeyPixels: tw * th - key,
        excludedCursor: exclude ?? null, components: components.slice(0, 40), componentCount: components.length, nearKey, png: btoa(bin) };
    },
    /** Non-key pixels of \`on\` inside the tactical rectangle, and how many equal the same pixel of \`off\`. */
    compare(on, off) {
      const a = frames[on], b = frames[off]; if (!a || !b || a.w !== b.w || a.h !== b.h) return null;
      const tw = a.w - 168, th = a.h - 32; let nonKey = 0, same = 0, x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1;
      for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) { const i = y * a.w + x; if (a.raw[i] === KEY) continue; nonKey++;
        if (a.raw[i] === b.raw[i]) same++; else { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); } }
      return { nonKey, identical: same, differing: nonKey - same, differingBox: x1 < 0 ? null : { x0, y0, x1, y1 } };
    },
    /** Logic frames and guest instructions over one window (instruction counter unwrapped every 100 ms). */
    async perfWindow(ms) {
      const cpu = core().emulator.v86.cpu; let instr = 0, last = cpu.instruction_counter[0] >>> 0;
      const f0 = (await core().getGamePerformance())?.frame ?? 0, t0 = performance.now();
      const timer = setInterval(() => { const n = cpu.instruction_counter[0] >>> 0; instr += (n - last) >>> 0; last = n; }, 100);
      await new Promise((r) => setTimeout(r, ms)); clearInterval(timer);
      const n = cpu.instruction_counter[0] >>> 0; instr += (n - last) >>> 0;
      const f1 = (await core().getGamePerformance())?.frame ?? 0, s = (performance.now() - t0) / 1000;
      return { seconds: s, frames: f1 - f0, logicFps: (f1 - f0) / s, mips: instr / s / 1e6, instrPerFrame: f1 > f0 ? instr / (f1 - f0) : null };
    },
  };
  globalThis.__pt = P;
  return true;
})()`;

type Env = {
  phase: string | null;
  shell: string | null;
  surface: { width: number; height: number } | null;
  installed: boolean;
};
type Obj = {
  id: number;
  kind: string;
  type: string;
  owner: number;
  health: number;
  selected: boolean;
  sx: number;
  sy: number;
};
type Objects = {
  frame: number;
  local: number;
  houses: { index: number; local: boolean }[];
  objects: Obj[];
};
type Capture = {
  name: string;
  width: number;
  height: number;
  keyPixels: number;
  nonKeyPixels: number;
  components: { pixels: number; x0: number; y0: number; x1: number; y1: number; colours: [string, number][] }[];
  componentCount: number;
  nearKey: { pixels: number; x0: number; y0: number; x1: number; y1: number; samples: [number, number, string][] };
  png?: string;
};

const t0 = Date.now();
const events: { t: number; event: string; detail?: unknown }[] = [];
const log = (event: string, detail?: unknown) => {
  events.push({ t: (Date.now() - t0) / 1000, event, detail });
  console.log(
    `[passthrough ${((Date.now() - t0) / 1000).toFixed(0)}s] ${event}`,
    detail === undefined ? '' : JSON.stringify(detail),
  );
};
const report: Record<string, unknown> = { origin, mode, gpu, stabilitySeconds, startedAt: new Date().toISOString() };
const checks: { name: string; pass: boolean; detail?: unknown }[] = [];
const check = (name: string, pass: boolean, detail?: unknown) => {
  checks.push({ name, pass, detail });
  log(`${pass ? 'PASS' : 'FAIL'} ${name}`, detail);
};
const flush = () => writeFileSync(join(out, 'report.json'), JSON.stringify({ ...report, checks, events }, null, 1));

const browser = await chromium.launch({
  headless,
  ...(env.RA2_BROWSER_EXECUTABLE ? { executablePath: env.RA2_BROWSER_EXECUTABLE } : gpu ? { channel: 'chromium' } : {}),
  args: gpu
    ? ['--no-sandbox', '--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist']
    : ['--no-sandbox', '--enable-unsafe-swiftshader'],
});
const context = await browser.newContext({
  locale: 'zh-CN',
  viewport: { width: 1400, height: 950 },
  deviceScaleFactor: 1,
});
const moduleName = mode === 'worker' ? 'vmWorker' : 'runtime';
await context.route(`**/src/adapter/${moduleName}.ts*`, async (route) => {
  const response = await route.fetch(),
    source = await response.text();
  const marker = mode === 'worker' ? 'installVmWorker(self);' : 'this.core = new VmCore(callbacks, source, platform);';
  assert.ok(source.includes(marker), 'probe entry point changed');
  const replacement =
    mode === 'worker'
      ? `const __ptController = installVmWorker(self); globalThis.__passthroughCoreGetter = () => __ptController.core;`
      : `${marker} globalThis.__passthroughCoreGetter = () => this.core;`;
  await route.fulfill({ response, body: source.replace(marker, replacement) });
});
const page: Page = await context.newPage();
const pageErrors: string[] = [];
const consoleWarnings: string[] = [];
page.on('pageerror', (error) => pageErrors.push(error.message));
page.on('console', (message) => {
  const text = message.text();
  if (/passthrough|\[HD\]/i.test(text)) consoleWarnings.push(text);
});
const target = (): Page | Worker => {
  if (mode === 'main') return page;
  const worker = page.workers().find((w) => w.url().includes('/vmWorker.ts'));
  assert.ok(worker, 'VM Worker not found');
  return worker;
};
const pt = async <T,>(expression: string): Promise<T> =>
  (await target().evaluate(
    `(async () => { const P = globalThis.__pt; if (!P) return null; return ${expression}; })()`,
  )) as T;
const sleep = (ms: number) => page.waitForTimeout(ms);
const waitFor = async <T,>(label: string, probeFn: () => Promise<T | null | undefined | false>, timeoutMs: number) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probeFn().catch(() => null);
    if (value) return value as T;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await sleep(300);
  }
};

// ---- Input helpers (surface coordinates → page coordinates of the scaled canvas) ----
let lastMouse = { x: 0, y: 0 };
async function toPage(x: number, y: number) {
  const box = await page.locator('#screen').boundingBox();
  const surface = (await pt<Env>('P.env()'))?.surface;
  assert.ok(box && surface, 'canvas or surface missing');
  return { x: box.x + ((x + 0.5) * box.width) / surface.width, y: box.y + ((y + 0.5) * box.height) / surface.height };
}
async function move(x: number, y: number) {
  const p = await toPage(x, y);
  await page.mouse.move(p.x, p.y);
  lastMouse = { x, y };
}
async function click(x: number, y: number, button: 'left' | 'right' = 'left', modifiers: string[] = []) {
  await move(x - 3, y - 3);
  await sleep(100);
  await move(x, y);
  await sleep(200);
  for (const key of modifiers) await page.keyboard.down(key);
  await page.mouse.down({ button });
  await sleep(150);
  await page.mouse.up({ button });
  for (const key of [...modifiers].reverse()) await page.keyboard.up(key);
  await sleep(150);
}
async function pressKey(key: string) {
  await page.keyboard.down(key);
  await sleep(120);
  await page.keyboard.up(key);
}
/** Park the cursor over the sidebar so its software cursor is not inside the tactical rectangle. */
const park = () => move(1100, 600);
const cursorBox = () => ({ x0: lastMouse.x - 8, y0: lastMouse.y - 8, x1: lastMouse.x + 48, y1: lastMouse.y + 48 });

type ShellWindow = { text: string; className: string; rect: { x: number; y: number; width: number; height: number } };
/** Click a native shell control by its text resource (e.g. GUI:StartGame) or, failing that, by a predicate. */
async function clickShellButton(text: string, fallback?: (w: ShellWindow) => boolean) {
  const windows = (await pt<ShellWindow[]>('P.windows()')) ?? [];
  const button = windows.find((w) => w.text === text) ?? (fallback ? windows.find(fallback) : undefined);
  if (!button) return false;
  await click(button.rect.x + button.rect.width / 2, button.rect.y + button.rect.height / 2);
  return true;
}

// ---- Evidence helpers ----
const captures: Record<string, Omit<Capture, 'png'> & { flags: number | null }> = {};
async function capture(name: string, excludeCursor = true) {
  const flags = (await pt<{ flags: number } | null>('P.stats()'))?.flags ?? null;
  const result = await pt<Capture>(
    `P.capture(${JSON.stringify(name)}, ${excludeCursor ? JSON.stringify(cursorBox()) : 'null'})`,
  );
  if (result.png) writeFileSync(join(out, `${name}.raw.png`), Buffer.from(result.png, 'base64'));
  delete result.png;
  await page.screenshot({ path: join(out, `${name}.page.png`) });
  captures[name] = { ...result, flags };
  return result;
}
const bridge = <T,>(expression: string) =>
  page.evaluate(`(() => { const B = window.__hdBridge; return B ? ${expression} : null; })()`) as Promise<T>;
async function bridgeEnabled(on: boolean) {
  const state = await bridge<{ flags: number; keyed: boolean }>('B.passthrough');
  const enabled = state ? state.flags !== 0 || state.keyed : false;
  if (enabled !== on) await bridge('B.toggle()');
  // The guest applies the switch at its next frame and repaints once; the page keeps the key for a 500 ms trail.
  await sleep(900);
}
/** Capture the current scene with the bridge on (passthrough) and off (original), and compare overlay pixels. */
async function onOff(name: string, prepare?: () => Promise<void>) {
  await bridgeEnabled(true);
  await prepare?.();
  const on = await capture(`${name}-on`);
  await bridgeEnabled(false);
  await prepare?.();
  const off = await capture(`${name}-off`);
  const comparison = await pt<{ nonKey: number; identical: number; differing: number }>(
    `P.compare(${JSON.stringify(`${name}-on`)}, ${JSON.stringify(`${name}-off`)})`,
  );
  await bridgeEnabled(true);
  return { on, off, comparison };
}

const localObjects = async () => {
  const s = await pt<Objects | null>('P.objects()');
  return s ? s.objects.filter((o) => o.owner === s.local) : [];
};
const tacticalSafe = (o: { sx: number; sy: number }) => o.sx > 200 && o.sx < 950 && o.sy > 40 && o.sy < 680;

async function waitForBattle(timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  let lastClick = 0;
  for (;;) {
    const e = await pt<Env>('P.env()').catch(() => null);
    const s =
      e?.phase === 'running' && e.shell === '' ? await pt<Objects | null>('P.objects()').catch(() => null) : null;
    const perf = e?.phase === 'running' ? await pt<{ frame: number } | null>('P.perf()').catch(() => null) : null;
    if (s && s.local >= 0 && s.objects.some((o) => o.owner === s.local) && (perf?.frame ?? 0) > 30) return s;
    if (e?.phase === 'error') throw new Error('VM error while waiting for the battle');
    // The intro movie ends on a click; clicks on the loading screen are ignored.
    if (e?.phase === 'running' && e.shell === '' && !s && Date.now() - lastClick > 5000) {
      lastClick = Date.now();
      const box = await page.locator('#screen').boundingBox();
      if (box) await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    }
    if (Date.now() > deadline) throw new Error('timed out waiting for the battle');
    await sleep(1000);
  }
}

/** Select the MCV with a click, deploy it (D) and wait for the construction yard. */
async function deployMcv() {
  const mcv = (await localObjects()).find((o) => /MCV$/.test(o.type));
  if (!mcv) return (await localObjects()).find((o) => /CNST$/.test(o.type)) ?? null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const now = (await localObjects()).find((o) => o.id === mcv.id);
    if (!now) break;
    await click(now.sx, now.sy);
    await sleep(300);
    await pressKey('d');
    const yard = await waitFor(
      'construction yard',
      async () => (await localObjects()).find((o) => /CNST$/.test(o.type)),
      15_000,
    ).catch(() => null);
    if (yard) return yard;
  }
  return null;
}

/**
 * A building: queue it from its cameo (default the first: the power plant), enter placement mode when ready, and find a
 * spot the grid shows green.
 */
const CAMEO_FIRST = { x: 1035, y: 252 };
/** Second cameo of the first row (Soviet structures: barracks after the power plant; Soviet infantry: Tesla trooper). */
const CAMEO_SECOND = { x: 1098, y: 252 };
/** Sidebar tabs at 1152x744: structures, defences, infantry, vehicles. */
const TAB_STRUCTURES = { x: 1024, y: 210 };
const TAB_INFANTRY = { x: 1081, y: 210 };
async function enterPlacement(yard: Obj, cameo = CAMEO_FIRST) {
  await click(cameo.x, cameo.y);
  const spots: [number, number][] = [];
  for (const [dx, dy] of [
    [120, 60],
    [150, 20],
    [110, 100],
    [-120, 60],
    [0, 120],
    [60, 130],
    [-150, 20],
    [0, -110],
    [180, 80],
  ])
    spots.push([yard.sx + dx, yard.sy + dy]);
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    await click(cameo.x, cameo.y);
    for (const [x, y] of spots.filter(([x, y]) => x > 180 && x < 960 && y > 30 && y < 690)) {
      await move(x, y);
      await sleep(250);
      await move(x + 1, y + 1);
      await sleep(350);
      const grid = await pt<{ green: number; red: number }>('P.grid()');
      if (grid.green + grid.red === 0) break; // not in placement mode yet
      if (grid.green > 300 && grid.red === 0) return { x: x + 1, y: y + 1, grid };
    }
    await sleep(2000);
  }
  return null;
}

/** Weapons with IsElectricBolt (rulesmd.ini): Tesla trooper and Tesla tank. */
const TESLA = /^(SHK|TTNK)$/;
/** The first four cameos (two columns, 50 px rows). */
const CAMEOS = [CAMEO_FIRST, CAMEO_SECOND, { x: CAMEO_FIRST.x, y: 302 }, { x: CAMEO_SECOND.x, y: 302 }];
/**
 * Soviet player only: build a barracks (NAHAND) and queue Tesla troopers (SHK); called right after the power plant so
 * they are ready before the AI's early rush. Neither can be a start unit (AllowedToStartInMultiplayer=no), and the
 * sidebar order is not the rulesmd.ini type order, so the structure cameos after the power plant are tried until the
 * placed building is a barracks (Russians: power plant, refinery, barracks). The Soviet infantry tab then shows
 * conscript, engineer, attack dog, Tesla trooper.
 */
async function startTeslaTraining(yard: Obj) {
  const attempts: Record<string, unknown>[] = [];
  let barracks = (await localObjects()).find((o) => o.type === 'NAHAND');
  for (const cameo of [CAMEOS[2]!, CAMEOS[1]!, CAMEOS[3]!]) {
    if (barracks) break;
    await click(TAB_STRUCTURES.x, TAB_STRUCTURES.y);
    const before = new Set((await localObjects()).map((o) => o.id));
    const spot = await enterPlacement(yard, cameo);
    const attempt: Record<string, unknown> = { cameo, spot };
    attempts.push(attempt);
    if (!spot) continue;
    await move(spot.x, spot.y);
    await click(spot.x, spot.y);
    const placed = await waitFor(
      'new building',
      async () => (await localObjects()).find((o) => o.kind === 'building' && !before.has(o.id)),
      30_000,
    ).catch(() => undefined);
    attempt.placed = placed?.type ?? null;
    if (placed?.type === 'NAHAND') barracks = placed;
  }
  const events: Record<string, unknown> = { attempts, barracks: barracks?.type ?? null };
  if (barracks) {
    await click(TAB_INFANTRY.x, TAB_INFANTRY.y);
    await sleep(500);
    await capture('tesla-infantry-tab', false);
    for (let i = 0; i < 3; i++) await click(CAMEOS[3]!.x, CAMEOS[3]!.y);
    await click(TAB_STRUCTURES.x, TAB_STRUCTURES.y);
  }
  await park();
  return events;
}

type ListCounts = { ebolt: number; lineTrail: number; radBeam: number };
type ListSummary = {
  samples: number;
  appliedMin: number;
  appliedMax: number;
  max: ListCounts;
  final: ListCounts;
  drains: ListCounts;
  longestNonEmptyWithEffectsMs: ListCounts;
  timeline: number[][];
};

let outcome = 'incomplete';
try {
  await page.goto(`${origin}/?start-page=battle&mouse-lock=0&hd=1${mode === 'main' ? '&vm-worker=0' : ''}`);
  await selectDevelopmentGame(page, 'yr');
  await waitFor('probe installed', async () => (await target().evaluate(probe)) === true, 300_000);
  const battle = await waitForBattle(900_000);
  log('battle', { frame: battle.frame, houses: battle.houses });

  // ---- Installation and bridge engagement ----
  const installed = await pt<Env>('P.env()');
  const sanity0 = await pt<Record<string, number> | null>('P.sanity()');
  check('passthrough patches installed at startup (all original bytes matched)', !!installed?.installed, sanity0);
  const engaged = await waitFor(
    'bridge passthrough',
    async () => {
      const b = await bridge<{ flags: number; unsupported: boolean; keyed: boolean }>('B.passthrough');
      return b && b.flags === 7 && b.keyed ? b : null;
    },
    120_000,
  ).catch(() => null);
  check('HD bridge switched the guest to every category (default) and composites by key colour', !!engaged, {
    bridge: engaged,
    guest: await pt('P.sanity()'),
  });
  report.configAddress = sanity0?.address;

  // Slow the simulation for the scripted captures (the AI rushes early); restored before measuring.
  await pt(`P.speed(${captureSpeed})`);

  // ---- Deploy ----
  const yard = await deployMcv();
  check('MCV deployed with passthrough on (construction yard appeared)', !!yard, yard && { type: yard.type });
  assert.ok(yard, 'no construction yard');
  await park();
  const deployed = await onOff('deployed');
  report.deployed = deployed.comparison;

  // ---- Building placement grid ----
  const spot = await enterPlacement(yard);
  check('power plant placement mode reached with a valid (green) grid', !!spot, spot);
  if (spot) {
    const placement = await onOff('placement', () => move(spot.x, spot.y).then(() => sleep(300)));
    report.placement = placement.comparison;
    check(
      'placement grid drawn over the key colour and pixel-identical to the original frame',
      placement.on.nonKeyPixels > 300 && (placement.comparison?.differing ?? 1) <= 400,
      { on: placement.on.nonKeyPixels, comparison: placement.comparison },
    );
    await move(spot.x, spot.y);
    await click(spot.x, spot.y);
    await sleep(2000);
  }
  // Barracks and Tesla troopers for the effect-list check, trained while the next scenarios are captured.
  report.teslaTraining = await startTeslaTraining(yard);

  // ---- Band box and selection ----
  const drag = { x0: 220, y0: 60, x1: 950, y1: 660 };
  let bandHeld = false;
  const band = await onOff('band', async () => {
    if (bandHeld) return;
    bandHeld = true;
    await move(drag.x0, drag.y0);
    await sleep(150);
    await page.mouse.down();
    for (let i = 1; i <= 12; i++) {
      await move(drag.x0 + ((drag.x1 - drag.x0) * i) / 12, drag.y0 + ((drag.y1 - drag.y0) * i) / 12);
      await sleep(40);
    }
    await sleep(400);
  });
  await page.mouse.up();
  await sleep(600);
  report.band = band.comparison;
  check(
    'drag-select band box visible with passthrough (its rectangle outline is a non-key component)',
    band.on.components.some((c) => c.x1 - c.x0 > 300 && c.y1 - c.y0 > 200),
    band.on.components.slice(0, 3),
  );
  await park();
  const selected = (await localObjects()).filter((o) => o.selected);
  const selection = await onOff('selection');
  report.selection = { units: selected.map((o) => o.type), comparison: selection.comparison };
  check(
    'selection brackets / health bars / pips identical to the original frame',
    selected.length > 0 && selection.on.nonKeyPixels > 100 && (selection.comparison?.differing ?? 1) <= 200,
    { selected: selected.map((o) => o.type), on: selection.on.nonKeyPixels, comparison: selection.comparison },
  );

  // ---- Move orders (target / action lines) ----
  const mobile = (await localObjects()).filter((o) => o.kind !== 'building' && o.selected);
  if (mobile.length) {
    const orders: { flags: string; capture: Omit<Capture, 'png'> }[] = [];
    for (const on of [true, false]) {
      await bridgeEnabled(on);
      const unit = (await localObjects()).find((o) => o.id === mobile[0]!.id && tacticalSafe(o));
      const targetPoint = unit
        ? { x: Math.min(930, unit.sx + 160), y: Math.max(60, unit.sy - 90) }
        : { x: 700, y: 200 };
      await click(targetPoint.x, targetPoint.y);
      await sleep(80);
      orders.push({ flags: on ? 'on' : 'off', capture: await capture(`move-${on ? 'on' : 'off'}`) });
    }
    await bridgeEnabled(true);
    report.moveOrders = orders.map((o) => ({
      flags: o.flags,
      nonKey: o.capture.nonKeyPixels,
      components: o.capture.components.slice(0, 5),
    }));
  }

  // ---- Text message (chat) ----
  await park();
  await pressKey('Enter');
  await sleep(500);
  await page.keyboard.type('passthrough check', { delay: 60 });
  await sleep(300);
  await pressKey('Enter');
  await sleep(700);
  const message = await onOff('message');
  report.message = message.comparison;

  // ---- Leak check: every category on, nothing selected, cursor on the sidebar ----
  await click(600, 400, 'right'); // right click deselects
  await park();
  await sleep(500);
  const leakFlags: Record<string, unknown> = {};
  for (const flags of [7, 3]) {
    await pt(`P.set(${flags})`);
    await sleep(1500);
    const c = await capture(`quiet-flags${flags}`, false);
    leakFlags[flags] = {
      keyPixels: c.keyPixels,
      nonKeyPixels: c.nonKeyPixels,
      componentCount: c.componentCount,
      components: c.components.slice(0, 12),
    };
  }
  await pt('P.set(7)');
  report.leakCheck = leakFlags;
  const all = leakFlags[7] as { nonKeyPixels: number; components: { pixels: number }[] };
  check(
    'no world pixels leak with every category on: quiet tactical view is key colour except small overlay components',
    all.nonKeyPixels < 0.01 * 984 * 712,
    all,
  );

  // ---- Firefight: force-fire the ground next to our units (explosions, muzzle flashes, smoke, craters) ----
  // Tanks first (bigger explosions); a click selects one unit, Shift+click adds the others.
  const shooters = (await localObjects())
    .filter((o) => o.kind !== 'building' && tacticalSafe(o))
    .sort((a, b) => Number(b.kind === 'vehicle') - Number(a.kind === 'vehicle'))
    .slice(0, 4);
  const firefight: Record<string, unknown>[] = [];
  if (shooters.length) {
    for (const [index, unit] of shooters.entries()) await click(unit.sx, unit.sy, 'left', index ? ['Shift'] : []);
    await sleep(300);
    report.firefightShooters = (await localObjects()).filter((o) => o.selected).map((o) => o.type);
    const centre = shooters[0]!;
    for (let shot = 0; shot < 10; shot++) {
      const flags = shot < 7 ? 7 : 3;
      await pt(`P.set(${flags})`);
      await click(
        Math.min(930, centre.sx + 70 + (shot % 3) * 25),
        Math.max(50, centre.sy - 60 + (shot % 2) * 30),
        'left',
        ['Control'],
      );
      await park();
      await sleep(900);
      const c = await capture(`firefight-${shot}-flags${flags}`, false);
      firefight.push({ shot, flags, nonKey: c.nonKeyPixels, nearKey: c.nearKey, components: c.components.slice(0, 6) });
    }
    await pressKey('s');
    await pt('P.set(7)');
  }
  report.firefight = firefight;
  const fired = firefight.filter((f) => f.flags === 7);
  check(
    'firefight with the default categories: no magenta-blended pixel (translucent draw over the key) in any frame',
    fired.length > 0 && fired.every((f) => (f.nearKey as { pixels: number }).pixels === 0),
    fired.map((f) => ({ shot: f.shot, nearKey: f.nearKey, nonKey: f.nonKey })),
  );
  log(
    'firefight with effects left native (terrain,objects): magenta-blended pixels',
    firefight.filter((f) => f.flags === 3).map((f) => (f.nearKey as { pixels: number }).pixels),
  );

  // ---- Effect lists: EBolt/LineTrail/RadBeam must keep ageing and leave their arrays with effects passthrough on ----
  // Their DrawAll functions are the only code that ages, removes and frees these objects; the patch runs them with
  // only the pixels removed. Tesla troopers force-fire at the ground; while every category stays on, the bolt count
  // must keep draining during the fire and all three counts must be 0 once it stops.
  {
    await pt('P.set(7)');
    await pt(`P.speed(${captureSpeed})`);
    const counters0 = (await pt<{ counters: Record<string, number> }>('P.stats()')).counters;
    const tesla = await waitFor(
      'Tesla troopers',
      async () => {
        const found = (await localObjects()).filter((o) => TESLA.test(o.type));
        return found.length >= 2 ? found : null;
      },
      120_000,
    ).catch(async () => (await localObjects()).filter((o) => TESLA.test(o.type)));
    report.teslaUnits = tesla.map((o) => o.type);
    report.localTypes = [...new Set((await localObjects()).map((o) => o.type))];
    const boltFrames: Record<string, unknown>[] = [];
    /** Capture up to two frames while at least one bolt is alive. */
    const captureBolts = async (flags: number) => {
      for (let attempt = 0; attempt < 80; attempt++) {
        const lists = await pt<ListCounts>('P.lists()');
        if (lists.ebolt > 0) {
          const c = await capture(`tesla-flags${flags}-${boltFrames.length}`, false);
          boltFrames.push({
            flags,
            ebolt: lists.ebolt,
            nonKey: c.nonKeyPixels,
            nearKey: c.nearKey.pixels,
            components: c.components.slice(0, 6),
          });
          if (boltFrames.filter((f) => f.flags === flags).length >= 2) return;
        }
        await sleep(100);
      }
    };
    const shooters = tesla.filter(tacticalSafe).slice(0, 4);
    const selectShooters = async () => {
      const now = await localObjects();
      const units = shooters.map((unit) => now.find((o) => o.id === unit.id)).filter((o): o is Obj => !!o);
      for (const [index, unit] of units.entries()) await click(unit.sx, unit.sy, 'left', index ? ['Shift'] : []);
      await sleep(300);
    };
    if (shooters.length) {
      await selectShooters();
      const centre = shooters[0]!;
      // Force-fire (Ctrl+click) at the ground; the attack persists until stopped.
      for (let shot = 0; shot < 3; shot++) {
        await click(
          Math.min(930, Math.max(220, centre.sx + 60 + (shot % 3) * 20)),
          Math.max(50, centre.sy - 50 + (shot % 2) * 25),
          'left',
          ['Control'],
        );
        await sleep(700);
      }
      // Nothing selected, cursor on the sidebar. Effects native first: the bolts show.
      await click(600, 400, 'right');
      await park();
      await pt('P.set(3)');
      await sleep(1200);
      await captureBolts(3);
      // Every category on from here to the end of the sampling: bolts keep being fired and must keep draining, and
      // frames taken while one is alive must stay key colour.
      await pt('P.set(7)');
      await sleep(1200);
      await pt('P.listsStart(50)');
      await captureBolts(7);
      await sleep(4000);
      await selectShooters();
      await pressKey('s'); // stop
      await click(600, 400, 'right');
      await park();
    } else await pt('P.listsStart(50)');
    // Every category stays on; give the last bolts well over their ~17-frame lifetime.
    await sleep(6000);
    const lists = await pt<ListSummary>('P.listsStop()');
    const counters1 = (await pt<{ counters: Record<string, number> }>('P.stats()')).counters;
    const grew = (name: string) => (counters1[name] ?? 0) - (counters0[name] ?? 0);
    report.effectLists = {
      lists,
      boltFrames,
      gateHits: {
        'ebolt:draw-all': grew('ebolt:draw-all'),
        'rad-beam:draw-all': grew('rad-beam:draw-all'),
        'line-trail:draw': grew('line-trail:draw'),
        'blit:surface-line-colour': grew('blit:surface-line-colour'),
      },
    };
    check(
      'effect lists keep ageing with effects passthrough on: after Tesla fire the EBolt::Array (0x8A0E98), LineTrail (0xABCB88) and RadBeam (0xB04A70) counts fall back to 0',
      !!lists &&
        lists.max.ebolt > 0 &&
        lists.drains.ebolt > 0 &&
        lists.appliedMin === 7 &&
        lists.appliedMax === 7 &&
        lists.final.ebolt === 0 &&
        lists.final.lineTrail === 0 &&
        lists.final.radBeam === 0,
      {
        teslaUnits: tesla.map((o) => o.type),
        max: lists?.max,
        final: lists?.final,
        drains: lists?.drains,
        longestNonEmptyWithEffectsMs: lists?.longestNonEmptyWithEffectsMs,
        applied: lists && [lists.appliedMin, lists.appliedMax],
      },
    );
    const keyed = boltFrames.filter((f) => f.flags === 7);
    const native = boltFrames.filter((f) => f.flags === 3);
    check(
      'electric bolts drawn through the gated line primitive only: while bolts are alive with every category on, the tactical view stays key colour; with effects native they show',
      keyed.length > 0 &&
        native.length > 0 &&
        keyed.every((f) => (f.nonKey as number) < 0.01 * 984 * 712 && f.nearKey === 0) &&
        Math.max(...native.map((f) => f.nonKey as number)) > Math.max(...keyed.map((f) => f.nonKey as number)) &&
        grew('blit:surface-line-colour') > 0,
      { boltFrames, lineGateHits: grew('blit:surface-line-colour') },
    );
  }

  // ---- Performance: same scene, interleaved windows ----
  await pt('P.speed(0)');
  await park();
  const windows: Record<string, unknown>[] = [];
  for (let round = 0; round < perfRounds; round++)
    for (const flags of [0, 3, 7]) {
      await pt(`P.set(${flags})`);
      await sleep(1500);
      windows.push({
        round,
        flags,
        load: loadavg()[0],
        ...(await pt<Record<string, number>>(`P.perfWindow(${perfWindowMs})`)),
      });
    }
  await pt('P.set(7)');
  const mean = (flags: number, key: string) => {
    const values = windows
      .filter((w) => w.flags === flags)
      .map((w) => w[key] as number)
      .filter((v) => Number.isFinite(v));
    return values.reduce((a, b) => a + b, 0) / values.length;
  };
  const perf = Object.fromEntries(
    [0, 3, 7].map((flags) => [
      flags,
      { logicFps: mean(flags, 'logicFps'), instrPerFrame: mean(flags, 'instrPerFrame'), mips: mean(flags, 'mips') },
    ]),
  );
  report.performance = { windows, perf };
  log('performance', perf);
  check(
    'passthrough reduces guest instructions per logic frame (terrain+objects and all vs off)',
    perf[3]!.instrPerFrame < perf[0]!.instrPerFrame && perf[7]!.instrPerFrame < perf[0]!.instrPerFrame,
    perf,
  );

  // ---- Stability ----
  const stability = {
    samples: [] as Record<string, unknown>[],
    matches: 1,
    defeats: 0,
    insane: 0,
    frameStalls: 0,
    flagsSet: 0,
    bridgeToggles: 0,
  };
  await pt('P.listsStart(100)');
  const startedAt = Date.now();
  let battleMs = 0;
  let lastSample = Date.now();
  let lastFrame = -1;
  let stalledSince = 0;
  let flip = 0;
  while (battleMs < stabilitySeconds * 1000) {
    await sleep(5000);
    const e = await pt<Env>('P.env()');
    if (e.phase === 'error') throw new Error('VM error during the stability run');
    const now = Date.now();
    const perfSample = await pt<{ frame: number; logicFps: number | null } | null>('P.perf()');
    if (e.shell === '') {
      battleMs += now - lastSample;
      const sanity = await pt<Record<string, number>>('P.sanity()');
      const stats = await pt<{ flags: number; applied: number; counters: Record<string, number> }>('P.stats()');
      const objects = await pt<Objects | null>('P.objects()');
      const own = objects ? objects.objects.filter((o) => o.owner === objects.local) : [];
      const sane =
        sanity.magic === 0x45544147 && sanity.depth < 64 && sanity.stackOffset >= 0x500 && sanity.stackOffset < 0x1000;
      if (!sane) stability.insane++;
      if (perfSample && perfSample.frame === lastFrame) {
        stalledSince ||= now;
        if (now - stalledSince > 20_000) stability.frameStalls++;
      } else stalledSince = 0;
      lastFrame = perfSample?.frame ?? lastFrame;
      stability.samples.push({
        t: Math.round((now - startedAt) / 1000),
        battleS: Math.round(battleMs / 1000),
        frame: perfSample?.frame,
        logicFps: perfSample?.logicFps,
        flags: stats.flags,
        sane,
        own: own.length,
        ownDamaged: own.filter((o) => o.health < 1).length,
        enemy: objects
          ? objects.objects.filter((o) => o.owner !== objects.local && o.owner < objects.houses.length - 2).length
          : null,
        blits: stats.counters['blit:shape'],
        fills: stats.counters['terrain:fill'],
        redraws: stats.counters['redraw:request'],
        applied: stats.applied,
        lists: await pt<ListCounts>('P.lists()'),
      });
      // Exercise the switch path: alternate effects on/off every minute, toggle the whole bridge every third minute.
      const minute = Math.floor(battleMs / 60_000);
      if (minute !== flip) {
        flip = minute;
        await pt(`P.set(${minute % 2 ? 3 : 7})`);
        stability.flagsSet++;
        if (minute % 3 === 2) {
          await bridgeEnabled(false);
          await capture(`stability-${minute}-off`);
          await bridgeEnabled(true);
          stability.bridgeToggles++;
        }
        await capture(`stability-${minute}`);
      }
    } else if (/Score/i.test(e.shell ?? '')) {
      // The AI won: continue to the skirmish page and start the next match with the same settings.
      stability.defeats++;
      await capture(`stability-defeat-${stability.defeats}`, false);
      // The score screen's only button (bottom right) continues to the skirmish setup page.
      await clickShellButton('GUI:Continue', (w) => /button/i.test(w.className) && w.rect.x > 500 && w.rect.y > 400);
      await sleep(4000);
      await clickShellButton('GUI:StartGame');
      await waitForBattle(300_000);
      stability.matches++;
      await pt(`P.speed(0)`);
      await deployMcv().catch(() => null);
      lastFrame = -1;
    }
    lastSample = Date.now();
    if (stability.samples.length % 12 === 0) {
      report.stability = stability;
      flush();
    }
  }
  report.stability = stability;
  report.stabilityEffectLists = await pt<ListSummary | null>('P.listsStop()');
  check(
    `stability: ${stabilitySeconds}s of battle with passthrough on, no VM error, data page always sane, frames never stalled`,
    stability.insane === 0 && stability.frameStalls === 0,
    {
      matches: stability.matches,
      defeats: stability.defeats,
      samples: stability.samples.length,
      flagsSet: stability.flagsSet,
      bridgeToggles: stability.bridgeToggles,
    },
  );
  const keyedCaptures = Object.entries(captures).filter(([, c]) => c.flags === 7 && c.width > 800);
  check(
    'every capture with the default categories is free of magenta-blended pixels (placement, band box, selection, firefight, stability)',
    keyedCaptures.length > 0 && keyedCaptures.every(([, c]) => c.nearKey.pixels === 0),
    keyedCaptures.filter(([, c]) => c.nearKey.pixels > 0).map(([name, c]) => ({ name, nearKey: c.nearKey })),
  );
  const damaged = stability.samples.some((s) => (s.ownDamaged as number) > 0) || stability.defeats > 0;
  check('the AI attacked during the stability run (own objects damaged or a match lost)', damaged, {
    defeats: stability.defeats,
  });
  outcome = checks.every((c) => c.pass) ? 'pass' : 'fail';
} catch (error) {
  outcome = `error: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`;
  log('stopped', outcome);
  await page.screenshot({ path: join(out, 'error.png') }).catch(() => undefined);
} finally {
  report.captures = captures;
  report.pageErrors = pageErrors;
  report.consoleWarnings = consoleWarnings.slice(-50);
  report.outcome = outcome;
  report.finishedAt = new Date().toISOString();
  flush();
  console.log(
    '[passthrough] outcome',
    outcome,
    `${checks.filter((c) => c.pass).length}/${checks.length} checks passed`,
  );
  await context.close();
  await browser.close();
}
