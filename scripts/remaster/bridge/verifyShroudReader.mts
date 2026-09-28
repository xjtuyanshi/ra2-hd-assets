/**
 * Remaster bridge: empirical verification of the read-only YR 1.001 shroud reader (src/games/yr/shroudReader.ts).
 *
 * It starts a real YR skirmish through `?start-page=battle` exactly like verifyStateReader.mts (the scratch
 * installation's RA2MD.INI [Skirmish] section picks the map and one Easy AI), loads the reader into the VM thread and:
 *
 * - dumps the map's cell storage (MapCoordBounds vs a full scan of the 512x512 cell pointer table, InvalidCell flags,
 *   the occlusion table in memory) so the bounds the reader uses are checked against every existing cell;
 * - (a) at game start, captures the game's primary surface together with the shroud in one VM-thread turn and
 *   compares every cell whose 60x30 diamond lies inside the tactical view (DSurface::ViewBounds): cells the reader
 *   reports as covered (SHROUD.SHP frame 15) must be black in the frame, clear cells must show terrain (at most 35%
 *   black pixels: dark asphalt and shadows are legitimately dark), and in the soft edge band the per-pixel darkness
 *   predicted from the player's own SHROUD.SHP frames must match the frame (with a rotated-mask control);
 *   it also compares the reader's recomputed frames with the engine's own cached CellClass::Visibility;
 * - (b) orders a local vehicle into shrouded ground with ordinary mouse input, polls the shroud at SHROUD_HZ while
 *   it drives, and checks that the cells memory reveals turn from black to terrain in later frames (and that no
 *   revealed cell is ever re-shrouded);
 * - (c) polls the reader at SHROUD_HZ for SHROUD_POLL_S seconds in the VM thread, timing every call, plus a burst of
 *   back-to-back reads with and without array reuse.
 *
 * Nothing writes guest memory. Evidence (report.json, captures, overlay PNGs) goes to SHROUD_OUT.
 *
 * Usage (development server started with RA2_GAME_ROOT=<scratch root whose ra2/ holds the YR files and the edited INI>):
 *   SHROUD_OUT=/path SHROUD_GAME_DIR=<scratch root>/ra2 RA2_BROWSER_ORIGIN=http://127.0.0.1:15183 \
 *     pnpm exec tsx scripts/remaster/bridge/verifyShroudReader.mts
 * Optional: VM_BROWSER_MODE=worker, SHROUD_POLL_S (60), SHROUD_HZ (15), SHROUD_MOVE_S (15), SHROUD_HEADLESS=0,
 * SHROUD_REANALYSE=<earlier SHROUD_OUT> (re-run the frame analysis on its saved captures into SHROUD_OUT; no game).
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type Page, type Worker } from '@playwright/test';
import { selectDevelopmentGame } from '../../../tests/helpers/selectDevelopmentGame';
import type { YrState } from '../../../src/games/yr/stateReader';
import {
  YR_LEVEL_HEIGHT,
  YR_SHROUD_NEIGHBOURS,
  YR_SHROUD_FRAME,
  YR_SHROUD_STATE,
  isYrLocationShrouded,
  type YrShroud,
} from '../../../src/games/yr/shroudReader';

const env = process.env;
const origin = env.RA2_BROWSER_ORIGIN ?? 'http://127.0.0.1:15183';
const out = env.SHROUD_OUT;
assert.ok(out, 'SHROUD_OUT (output directory) is required');
mkdirSync(out, { recursive: true });
const gameDir = env.SHROUD_GAME_DIR ?? '';
const mode = env.VM_BROWSER_MODE === 'worker' ? 'worker' : 'main';
const pollSeconds = Number(env.SHROUD_POLL_S ?? 60);
const hz = Number(env.SHROUD_HZ ?? 15);
const moveSeconds = Number(env.SHROUD_MOVE_S ?? 15);
const headless = env.SHROUD_HEADLESS !== '0';
/** Directory of an earlier run: re-analyse its saved captures (and redraw overlays) without starting the game. */
const reanalyse = env.SHROUD_REANALYSE;

/**
 * Installed into the VM thread. Everything one capture needs (shroud, raw cell fields, tactical position, view
 * bounds, primary surface pixels) is read in a single turn, so the emulator cannot advance in between.
 */
const installer = `(async () => {
  if (globalThis.__shroudBridge) return true;
  const core = () => globalThis.__bridgeCoreGetter?.();
  const c0 = core();
  if (!c0?.shim || !c0.emulator || !c0.source?.executableBytes) return false;
  const shroudModule = await import('/src/games/yr/shroudReader.ts');
  const stateModule = await import('/src/games/yr/stateReader.ts');
  const access = await import('/src/games/shared/memoryAccessor.ts');
  const digest = await crypto.subtle.digest('SHA-256', c0.source.executableBytes);
  const hash = Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
  const accessor = () => { const c = core(); return access.createByteViewAccessor(c.emulator.read_memory(0, c.guestMemoryBytes)); };
  const readShroud = shroudModule.createYrShroudReader(accessor, hash);
  const readState = stateModule.createYrStateReader(accessor, hash);
  const O = shroudModule.YR_SHROUD_OFFSETS, G = shroudModule.YR_SHROUD_GLOBALS;
  const b64 = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); };
  const pack = (s) => s && { frame: s.frame, originX: s.originX, originY: s.originY, width: s.width, height: s.height,
    cells: b64(s.cells), edges: b64(s.edges), fogEdges: s.fogEdges ? b64(s.fogEdges) : null, fogOfWar: s.fogOfWar, counts: s.counts };
  let previous = null;
  const B = {
    hash, supported: !!readShroud && !!readState,
    state: () => readState ? readState({}) : null,
    shroud: () => pack(readShroud ? readShroud({}) : null),
    u32: (a) => accessor().u32(a), i32: (a) => accessor().i32(a),
    f64(a) { const b = accessor().bytes(a, 8); return b.length === 8 ? new DataView(b.buffer).getFloat64(0, true) : null; },
    bytes: (a, n) => b64(accessor().bytes(a, n)),
    env() {
      const c = core(), s = c?.shim; const p = s?.surfaces?.get(s.primarySurface);
      return { phase: c?.currentPhase ?? null, shell: s?.inspectShellPageTitle() ?? null,
        surface: p ? { width: p.width, height: p.height } : null };
    },
    /** Full scan of MapClass::Cells: bounding box of non-null slots, count, and MapCoords consistency. */
    scanCells() {
      const m = accessor(); const items = m.u32(G.map + O.cellItems), capacity = m.i32(G.map + O.cellCapacity);
      let minX = 1e9, minY = 1e9, maxX = -1, maxY = -1, count = 0, coordMismatch = 0;
      for (let i = 0; i < capacity; i++) {
        const p = m.u32(items + i * 4); if (!p) continue;
        const x = i & 511, y = i >> 9; count++;
        if (m.u32(p + O.cellMapCoords) !== (((y << 16) | x) >>> 0)) coordMismatch++;
        if (x < minX) minX = x; if (y < minY) minY = y; if (x > maxX) maxX = x; if (y > maxY) maxY = y;
      }
      const lt = G.map + O.mapCoordBounds, r = G.map + O.mapRect;
      return { items, capacity, count, coordMismatch, scan: { minX, minY, maxX, maxY },
        mapCoordBounds: [m.i32(lt), m.i32(lt + 4), m.i32(lt + 8), m.i32(lt + 12)],
        mapRect: [m.i32(r), m.i32(r + 4), m.i32(r + 8), m.i32(r + 12)],
        invalidCell: { alt: m.u32(G.invalidCell + O.cellAltFlags), flags: m.u32(G.invalidCell + O.cellFlags) },
        scenarioFlags: m.u32(m.u32(G.scenario)), table: b64(m.bytes(G.occlusionTable, 256)) };
    },
    /** Raw fields of every slot in the reader's bounds (little-endian Int32 per field). */
    rawCells(s) {
      const m = accessor(); const items = m.u32(G.map + O.cellItems);
      const n = s.width * s.height;
      const f = { level: new Int32Array(n), visibility: new Int32Array(n), foggedness: new Int32Array(n), alt: new Int32Array(n),
        flags: new Int32Array(n), counter: new Int32Array(n), gaps: new Int32Array(n) };
      for (let y = 0; y < s.height; y++) for (let x = 0; x < s.width; x++) {
        const i = y * s.width + x, p = m.u32(items + (((s.originY + y) << 9) + s.originX + x) * 4);
        if (!p) continue;
        const s8 = (v) => (v << 24) >> 24;
        f.level[i] = s8(m.u8(p + O.cellLevel)); f.visibility[i] = s8(m.u8(p + O.cellVisibility));
        f.foggedness[i] = s8(m.u8(p + O.cellFoggedness)); f.alt[i] = m.u32(p + O.cellAltFlags);
        f.flags[i] = m.u32(p + O.cellFlags); f.counter[i] = m.i32(p + O.cellShroudCounter); f.gaps[i] = m.i32(p + O.cellGaps);
      }
      const o = {}; for (const k in f) o[k] = b64(new Uint8Array(f[k].buffer)); return o;
    },
    /** One consistent capture: shroud, raw cells, tactical position, view bounds and the primary surface. */
    capture() {
      const c = core(), s = c.shim, m = accessor();
      const shroud = readShroud({});
      const p = s.inspectSurface(s.primarySurface);
      const tactical = m.u32(${0x887324});
      return {
        frame: m.i32(G.frame), shroud: pack(shroud), raw: shroud ? B.rawCells(shroud) : null,
        view: { x: m.i32(tactical + 0xb0), y: m.i32(tactical + 0xb4) },
        viewBounds: [m.i32(${0x886fa0}), m.i32(${0x886fa4}), m.i32(${0x886fa8}), m.i32(${0x886fac})],
        state: readState({}),
        surface: p && { width: p.width, height: p.height, pitch: p.pitch, bpp: p.bpp, pixels: b64(p.pixels) },
      };
    },
    poll: null,
    startPoll(rate, withReuse) {
      const P = B.poll = { startedAt: performance.now(), polls: 0, nulls: 0, errors: [], costs: [], frames: [],
        reveals: {}, reshrouds: 0, last: null, timer: 0 };
      const tick = () => {
        const t0 = performance.now(); let s = null;
        try { s = readShroud({ reuse: withReuse ? previous : null }); } catch (error) { P.errors.push(String(error)); }
        P.costs.push(Math.round((performance.now() - t0) * 1000) / 1000); P.polls++;
        if (!s) { P.nulls++; return; }
        previous = s;
        P.frames.push(s.frame);
        // Track visibility transitions per cell (index in the snapshot) against the previous poll's copy.
        const cur = s.cells;
        if (P.last && P.last.length === cur.length) {
          for (let i = 0; i < cur.length; i++) {
            const was = P.last[i], now = cur[i];
            if (was === now) continue;
            if (was === 0 && now === 2 && P.reveals[i] === undefined) P.reveals[i] = { frame: s.frame, t: Math.round(t0 - P.startedAt) };
            if (was === 2 && now === 0) P.reshrouds++;
          }
          P.last.set(cur);
        } else P.last = cur.slice();
      };
      P.timer = setInterval(tick, 1000 / rate);
      return true;
    },
    stopPoll() { if (B.poll) clearInterval(B.poll.timer); return true; },
    pollSummary() { const P = B.poll; if (!P) return null; const { timer, last, ...rest } = P; return { ...rest, elapsedMs: performance.now() - P.startedAt }; },
    burst(n) {
      const cost = (reuse) => { const t = []; let prev = null; for (let i = 0; i < n; i++) { const t0 = performance.now(); prev = readShroud({ reuse: reuse ? prev : null }); t.push(performance.now() - t0); } return t; };
      return { fresh: cost(false), reuse: cost(true) };
    },
  };
  globalThis.__shroudBridge = B;
  return true;
})()`;

type Env = { phase: string | null; shell: string | null; surface: { width: number; height: number } | null };
type Packed = {
  frame: number;
  originX: number;
  originY: number;
  width: number;
  height: number;
  cells: string;
  edges: string;
  fogEdges: string | null;
  fogOfWar: boolean;
  counts: YrShroud['counts'];
};
type Capture = {
  frame: number;
  shroud: Packed | null;
  raw: Record<string, string> | null;
  view: { x: number; y: number };
  viewBounds: [number, number, number, number];
  state: YrState | null;
  surface: { width: number; height: number; pitch: number; bpp: number; pixels: string } | null;
};
type Shroud = Omit<Packed, 'cells' | 'edges' | 'fogEdges'> & {
  cells: Uint8Array;
  edges: Uint8Array;
  fogEdges: Uint8Array | null;
};

const fromB64 = (text: string) => new Uint8Array(Buffer.from(text, 'base64'));
const int32s = (text: string) => {
  const bytes = fromB64(text);
  return new Int32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength >> 2);
};
const unpack = (p: Packed): Shroud => ({
  ...p,
  cells: fromB64(p.cells),
  edges: fromB64(p.edges),
  fogEdges: p.fogEdges ? fromB64(p.fogEdges) : null,
});

const t0 = Date.now();
const events: { t: number; event: string; detail?: unknown }[] = [];
const log = (event: string, detail?: unknown) => {
  events.push({ t: (Date.now() - t0) / 1000, event, detail });
  console.log(
    `[shroud ${((Date.now() - t0) / 1000).toFixed(0)}s] ${event}`,
    detail === undefined ? '' : JSON.stringify(detail),
  );
};
const report: Record<string, unknown> = { origin, mode, pollSeconds, hz, startedAt: new Date().toISOString() };
const checks: { name: string; pass: boolean; detail?: unknown }[] = [];
const check = (name: string, pass: boolean, detail?: unknown) => {
  checks.push({ name, pass, detail });
  log(`${pass ? 'PASS' : 'FAIL'} ${name}`, detail);
};
const flush = () => writeFileSync(join(out, 'report.json'), JSON.stringify({ ...report, checks, events }, null, 1));

/**
 * SHROUD.SHP from the player's own MIX archives, read with the fork's own parser (see verifyStateReader for the
 * computed import specifier). Returns the 60x30 intensity frames, or null (then pixel predictions are skipped).
 */
async function loadShroudShp(): Promise<Uint8Array[] | null> {
  if (!gameDir) return null;
  try {
    const specifier = ['..', '..', '..', 'packages', 'ra2-formats', 'src', 'index.ts'].join('/');
    const { Vfs, ShpFile } = (await import(specifier)) as {
      Vfs: new () => {
        mountData(data: Uint8Array): unknown;
        mountNested(outer: unknown, name: string): unknown;
        openFile(name: string): Uint8Array | undefined;
      };
      ShpFile: {
        parse(data: Uint8Array): { count: number; cx: number; cy: number; frame(i: number): { pixels: Uint8Array } };
      };
    };
    const vfs = new Vfs();
    for (const [outer, inners] of [
      ['ra2.mix', ['local.mix', 'cache.mix', 'conquer.mix', 'generic.mix']],
      ['ra2md.mix', ['localmd.mix', 'cachemd.mix', 'conqmd.mix', 'genermd.mix']],
    ] as const) {
      const path = join(gameDir, outer);
      if (!existsSync(path)) continue;
      const mix = vfs.mountData(new Uint8Array(readFileSync(path)));
      for (const inner of inners) vfs.mountNested(mix, inner);
    }
    const bytes = vfs.openFile('SHROUD.SHP');
    if (!bytes) return null;
    const shp = ShpFile.parse(bytes);
    if (shp.cx !== 60 || shp.cy !== 30 || shp.count < 47) return null;
    return Array.from({ length: 47 }, (_, i) => shp.frame(i).pixels);
  } catch (error) {
    log('SHROUD.SHP lookup failed', String(error));
    return null;
  }
}

const executablePath = env.RA2_BROWSER_EXECUTABLE;
const browser = await chromium.launch({
  headless,
  ...(executablePath ? { executablePath } : {}),
  args: ['--no-sandbox', '--enable-unsafe-swiftshader'],
});
const context = await browser.newContext({
  locale: 'zh-CN',
  ignoreHTTPSErrors: true,
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
      ? `const __bridgeController = installVmWorker(self); globalThis.__bridgeCoreGetter = () => __bridgeController.core;`
      : `${marker} globalThis.__bridgeCoreGetter = () => this.core;`;
  await route.fulfill({ response, body: source.replace(marker, replacement) });
});
const page: Page = await context.newPage();
const pageErrors: string[] = [];
page.on('pageerror', (error) => pageErrors.push(error.message));
const target = (): Page | Worker => {
  if (mode === 'main') return page;
  const worker = page.workers().find((w) => w.url().includes('/vmWorker.ts'));
  assert.ok(worker, 'VM Worker not found');
  return worker;
};
const bridge = async <T,>(expression: string): Promise<T> =>
  (await target().evaluate(
    `(async () => { const B = globalThis.__shroudBridge; if (!B) return null; return ${expression}; })()`,
  )) as T;
const waitFor = async <T,>(label: string, probe: () => Promise<T | null | undefined | false>, timeoutMs: number) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe().catch(() => null);
    if (value) return value as T;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await page.waitForTimeout(250);
  }
};

// ---- Projection (YRpp TacticalClass::CoordsToScreen facts). Both per-cell shroud draw loops (0x6D3660, 0x6D72F2)
// force Z = 0, so a cell's SHROUD.SHP frame sits at CoordsToScreen(cell centre, Z = 0) - TacticalPos + ViewBounds.XY
// - (30, 15) whatever the terrain height. ----
let zFactor = 0;
/** The engine's occlusion table as read from guest memory (only used for the rotated-mask control). */
let occlusionTable: Int8Array | null = null;
const adjustZ = (z: number) => Math.trunc(z * zFactor + (z >= 728 ? 1 : 0) + 0.5);
/** Surface pixel of a world lepton point. */
const toSurface = (c: Pick<Capture, 'view' | 'viewBounds'>, x: number, y: number, z: number) => ({
  x: Math.trunc((30 * x - 30 * y) / 256) - c.view.x + c.viewBounds[0],
  y: Math.trunc((15 * y + 15 * x) / 256) - adjustZ(z) - c.view.y + c.viewBounds[1],
});
/** Surface position of a cell's diamond centre on the flat (Z = 0) shroud layer. */
const shroudCentre = (c: Capture, cx: number, cy: number) => toSurface(c, cx * 256 + 128, cy * 256 + 128, 0);
/** Surface position of a cell's terrain centre at its height level (where a click on that cell lands). */
const terrainCentre = (c: Capture, cx: number, cy: number, level: number) =>
  toSurface(c, cx * 256 + 128, cy * 256 + 128, level * 104);

async function canvasPoint(surfaceX: number, surfaceY: number) {
  const box = await page.locator('#screen').boundingBox();
  const surface = (await bridge<Env>('B.env()'))?.surface;
  assert.ok(box && surface, 'canvas or surface missing');
  return {
    x: box.x + ((surfaceX + 0.5) * box.width) / surface.width,
    y: box.y + ((surfaceY + 0.5) * box.height) / surface.height,
  };
}
/** Keep the pointer over the native sidebar so the game cursor is not inside the tactical view in captures. */
async function park() {
  const surface = (await bridge<Env>('B.env()'))?.surface;
  if (!surface) return;
  const p = await canvasPoint(surface.width - 80, surface.height * 0.6);
  await page.mouse.move(p.x, p.y);
}
async function clickSurface(x: number, y: number) {
  const p = await canvasPoint(x, y);
  await page.mouse.move(p.x - 3, p.y - 3);
  await page.waitForTimeout(120);
  await page.mouse.move(p.x, p.y);
  await page.waitForTimeout(250);
  await page.mouse.down();
  await page.waitForTimeout(150);
  await page.mouse.up();
  await page.waitForTimeout(150);
}

// ---- Frame analysis ----
type CellClass = 'black' | 'terrain' | 'partial';
type MemClass = 'covered' | 'edge' | 'clear';
interface CellSample {
  x: number;
  y: number;
  level: number;
  sx: number;
  sy: number;
  state: number;
  edge: number;
  memory: MemClass;
  measuredBlack: number;
  predictedBlack: number | null;
  frameClass: CellClass;
  engineVisibility: number;
}

const BLACK = 24; // max(R, G, B) in 8-bit at or below which a pixel counts as black
/** Analytic 60x30 diamond (used when SHROUD.SHP is not available) shrunk by `shrink`. */
const inDiamond = (px: number, py: number, shrink: number) =>
  Math.abs(px + 0.5 - 30) / 30 + Math.abs(py + 0.5 - 15) / 15 <= shrink;

function analyse(capture: Capture, shp: Uint8Array[] | null) {
  const s = unpack(capture.shroud!);
  const raw = Object.fromEntries(Object.entries(capture.raw!).map(([k, v]) => [k, int32s(v)])) as Record<
    string,
    Int32Array
  >;
  const surface = capture.surface!;
  assert.equal(surface.bpp, 16, 'primary surface is expected to be 16-bit');
  const pixels = fromB64(surface.pixels);
  const px16 = new Uint16Array(pixels.buffer, pixels.byteOffset, pixels.byteLength >> 1);
  const pitch16 = surface.pitch >> 1;
  const isBlack = (x: number, y: number) => {
    const v = px16[y * pitch16 + x]!;
    const r = ((v >> 11) & 31) * 8.226,
      g = ((v >> 5) & 63) * 4.048,
      b = (v & 31) * 8.226;
    return Math.max(r, g, b) <= BLACK;
  };
  const [vx, vy, vw, vh] = capture.viewBounds;
  const samples: CellSample[] = [];
  for (let y = 0; y < s.height; y++)
    for (let x = 0; x < s.width; x++) {
      const i = y * s.width + x;
      if (s.cells[i] === YR_SHROUD_STATE.none) continue;
      const cx = s.originX + x,
        cy = s.originY + y,
        level = raw.level![i]!;
      const centre = shroudCentre(capture, cx, cy);
      const left = centre.x - 30,
        top = centre.y - 15;
      if (left < vx || top < vy || left + 60 > vx + vw || top + 30 > vy + vh) continue;
      const edge = s.edges[i]!;
      // Inner 70% of the diamond only, so one-pixel rounding at the border never counts a neighbour's piece.
      let n = 0,
        black = 0,
        predicted = 0;
      for (let py = 0; py < 30; py++)
        for (let px = 0; px < 60; px++) {
          if (!inDiamond(px, py, 0.7)) continue;
          n++;
          if (isBlack(left + px, top + py)) black++;
          if (shp && shp[edge === YR_SHROUD_FRAME.covered ? 15 : edge]![py * 60 + px]! <= 10) predicted++;
        }
      const measuredBlack = black / n;
      samples.push({
        x: cx,
        y: cy,
        level,
        sx: centre.x,
        sy: centre.y,
        state: s.cells[i]!,
        edge,
        memory: edge === YR_SHROUD_FRAME.covered ? 'covered' : edge === YR_SHROUD_FRAME.clear ? 'clear' : 'edge',
        measuredBlack,
        predictedBlack: shp ? predicted / n : null,
        frameClass: measuredBlack >= 0.95 ? 'black' : measuredBlack <= 0.35 ? 'terrain' : 'partial',
        engineVisibility: raw.visibility![i]!,
      });
    }

  // Per-pixel comparison over the tactical view: rasterise the predicted SHROUD.SHP intensity in the engine's draw
  // order (screen rows of constant X + Y, left to right), then compare decisive pixels with the frame.
  let pixelStats: Record<string, number> | null = null;
  if (shp) {
    // `rotated` is a control: the same cells with every edge mask turned by 180 degrees on screen, which must fit the
    // frame clearly worse if the edge frames carry real information.
    const rasterise = (frameOf: (i: number) => number) => {
      const predicted = new Uint8Array(surface.width * surface.height).fill(255);
      const band = new Uint8Array(surface.width * surface.height);
      for (const i of order) {
        const cx = s.originX + (i % s.width),
          cy = s.originY + Math.floor(i / s.width);
        const centre = shroudCentre(capture, cx, cy);
        const f = frameOf(i);
        const frame = shp[f]!;
        const isEdge = f !== 0 && f !== 15 ? 1 : 0;
        for (let py = 0; py < 30; py++) {
          const sy = centre.y - 15 + py;
          if (sy < vy || sy >= vy + vh) continue;
          for (let px = 0; px < 60; px++) {
            const sx = centre.x - 30 + px;
            if (sx < vx || sx >= vx + vw) continue;
            const v = frame[py * 60 + px]!;
            if (v === 254) continue;
            predicted[sy * surface.width + sx] = v;
            band[sy * surface.width + sx] = isEdge;
          }
        }
      }
      return { predicted, band };
    };
    const order: number[] = [];
    for (let i = 0; i < s.cells.length; i++) if (s.cells[i] !== YR_SHROUD_STATE.none) order.push(i);
    order.sort((a, b) => {
      const ax = s.originX + (a % s.width),
        ay = s.originY + Math.floor(a / s.width);
      const bx = s.originX + (b % s.width),
        by = s.originY + Math.floor(b / s.width);
      return ax + ay - (bx + by) || ax - bx;
    });
    const brightness = (x: number, y: number) => {
      const v = px16[y * pitch16 + x]!;
      return Math.max(((v >> 11) & 31) * 8.226, ((v >> 5) & 63) * 4.048, (v & 31) * 8.226);
    };
    const score = (predicted: Uint8Array, band: Uint8Array) => {
      const st = { darkPixels: 0, darkBlack: 0, litPixels: 0, litBlack: 0, bandDark: 0, bandDarkBlack: 0, bandLit: 0 };
      let bandLitBlack = 0,
        n = 0,
        sx1 = 0,
        sy1 = 0,
        sxx = 0,
        syy = 0,
        sxy = 0;
      for (let y = vy; y < vy + vh; y++)
        for (let x = vx; x < vx + vw; x++) {
          const at = y * surface.width + x;
          const v = predicted[at]!;
          if (v === 255) continue;
          const b = isBlack(x, y);
          const inBand = band[at] === 1;
          if (v <= 10) {
            st.darkPixels++;
            if (b) st.darkBlack++;
            if (inBand) {
              st.bandDark++;
              if (b) st.bandDarkBlack++;
            }
          } else if (v >= 100) {
            st.litPixels++;
            if (b) st.litBlack++;
            if (inBand) {
              st.bandLit++;
              if (b) bandLitBlack++;
            }
          }
          if (inBand) {
            const l = brightness(x, y);
            n++;
            sx1 += v;
            sy1 += l;
            sxx += v * v;
            syy += l * l;
            sxy += v * l;
          }
        }
      const correlation =
        (n * sxy - sx1 * sy1) / Math.sqrt(Math.max(1e-9, (n * sxx - sx1 * sx1) * (n * syy - sy1 * sy1)));
      return {
        ...st,
        darkAgreement: st.darkBlack / Math.max(1, st.darkPixels),
        litAgreement: 1 - st.litBlack / Math.max(1, st.litPixels),
        bandDarkAgreement: st.bandDark ? st.bandDarkBlack / st.bandDark : 1,
        bandLitAgreement: st.bandLit ? 1 - bandLitBlack / st.bandLit : 1,
        bandPixels: n,
        bandCorrelation: correlation,
      };
    };
    const frameOf = (i: number) => (s.edges[i] === YR_SHROUD_FRAME.covered ? 15 : s.edges[i]!);
    const actual = rasterise(frameOf);
    const table = occlusionTable;
    const control = table
      ? rasterise((i) => {
          const f = frameOf(i);
          if (f === 0 || f === 15) return f;
          // Recompute the mask from the states (missing neighbours count as unrevealed, as InvalidCell does here).
          const x = i % s.width,
            y = Math.floor(i / s.width);
          let mask = 0;
          for (const [bit, dx, dy] of YR_SHROUD_NEIGHBOURS) {
            const nx = x + dx,
              ny = y + dy;
            const state = nx >= 0 && ny >= 0 && nx < s.width && ny < s.height ? s.cells[ny * s.width + nx] : 255;
            if (state !== YR_SHROUD_STATE.visible && state !== YR_SHROUD_STATE.fogged) mask |= bit;
          }
          const turned = ((mask << 4) | (mask >> 4)) & 0xff;
          const o = table[turned]!;
          return o === -2 ? 15 : o === -1 ? 0 : o;
        })
      : null;
    pixelStats = {
      ...score(actual.predicted, actual.band),
      ...(control ? { controlBandCorrelation: score(control.predicted, control.band).bandCorrelation } : {}),
    };
  }

  const tally = (filter: (c: CellSample) => boolean) => samples.filter(filter).length;
  const confusion: Record<string, Record<MemClass, number>> = {};
  for (const fc of ['black', 'terrain', 'partial'] as const)
    confusion[fc] = {
      covered: tally((c) => c.frameClass === fc && c.memory === 'covered'),
      edge: tally((c) => c.frameClass === fc && c.memory === 'edge'),
      clear: tally((c) => c.frameClass === fc && c.memory === 'clear'),
    };
  const blackCells = samples.filter((c) => c.frameClass === 'black');
  const terrainCells = samples.filter((c) => c.frameClass === 'terrain');
  const covered = samples.filter((c) => c.memory === 'covered');
  const clear = samples.filter((c) => c.memory === 'clear');
  const edges = samples.filter((c) => c.memory === 'edge');
  const edgeErrors = edges
    .filter((c) => c.predictedBlack !== null)
    .map((c) => Math.abs(c.measuredBlack - c.predictedBlack!))
    .sort((a, b) => a - b);
  const engineFrame = (v: number) => (v === -2 ? 15 : v === -1 ? 0 : v);
  const engineMismatch = samples.filter((c) => engineFrame(c.engineVisibility) !== c.edge);
  return {
    shroud: s,
    raw,
    samples,
    summary: {
      frame: capture.frame,
      viewBounds: capture.viewBounds,
      view: capture.view,
      cellsInView: samples.length,
      confusion,
      /** Frame-black cells that memory reports as shrouded (state) / as covered (frame 15). */
      blackReadShrouded:
        blackCells.filter((c) => c.state === YR_SHROUD_STATE.shrouded).length / Math.max(1, blackCells.length),
      blackReadCoveredOrEdge: blackCells.filter((c) => c.memory !== 'clear').length / Math.max(1, blackCells.length),
      /** Frame-terrain cells that memory reports as revealed (state) / clear (frame 0). */
      terrainReadVisible:
        terrainCells.filter((c) => c.state === YR_SHROUD_STATE.visible).length / Math.max(1, terrainCells.length),
      terrainReadClearOrEdge:
        terrainCells.filter((c) => c.memory !== 'covered').length / Math.max(1, terrainCells.length),
      /** Memory-covered cells that are black in the frame; memory-clear cells that show terrain. */
      coveredAreBlack: covered.filter((c) => c.frameClass === 'black').length / Math.max(1, covered.length),
      clearShowTerrain: clear.filter((c) => c.frameClass === 'terrain').length / Math.max(1, clear.length),
      edgeCells: edges.length,
      edgeBlackFractionError: edgeErrors.length
        ? {
            median: edgeErrors[Math.floor(edgeErrors.length / 2)],
            p90: edgeErrors[Math.floor(edgeErrors.length * 0.9)],
            max: edgeErrors.at(-1),
          }
        : null,
      engineVisibilityAgreement: 1 - engineMismatch.length / Math.max(1, samples.length),
      engineVisibilityMismatches: engineMismatch
        .slice(0, 20)
        .map((c) => ({ x: c.x, y: c.y, ours: c.edge, engine: c.engineVisibility })),
      pixels: pixelStats,
    },
  };
}

/** Frame + memory overlay: cell diamonds outlined by memory class, disagreements filled. Rendered by the page canvas. */
async function overlayPng(name: string, capture: Capture, samples: CellSample[], highlight: Set<string> = new Set()) {
  const surface = capture.surface!;
  const pixels = fromB64(surface.pixels);
  const px16 = new Uint16Array(pixels.buffer, pixels.byteOffset, pixels.byteLength >> 1);
  const rgba = Buffer.alloc(surface.width * surface.height * 4);
  for (let y = 0; y < surface.height; y++)
    for (let x = 0; x < surface.width; x++) {
      const v = px16[y * (surface.pitch >> 1) + x]!,
        o = (y * surface.width + x) * 4;
      rgba[o] = ((v >> 11) & 31) * 8.226;
      rgba[o + 1] = ((v >> 5) & 63) * 4.048;
      rgba[o + 2] = (v & 31) * 8.226;
      rgba[o + 3] = 255;
    }
  const shapes = samples.map((c) => {
    const wrong =
      (c.frameClass === 'black' && c.memory === 'clear') || (c.frameClass === 'terrain' && c.memory === 'covered');
    return {
      x: c.sx,
      y: c.sy,
      color: highlight.has(`${c.x},${c.y}`)
        ? '#00e5ff'
        : c.memory === 'covered'
          ? '#ff3b3b'
          : c.memory === 'clear'
            ? '#3bff6b'
            : '#ffd400',
      fill: wrong ? 'rgba(255,0,255,0.55)' : highlight.has(`${c.x},${c.y}`) ? 'rgba(0,229,255,0.25)' : null,
      label: c.edge !== 0 && c.edge !== 15 ? String(c.edge) : '',
    };
  });
  const dataUrl = await page.evaluate(
    ({ w, h, data, shapes, vb }) => {
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const g = canvas.getContext('2d')!;
      const bytes = Uint8ClampedArray.from(atob(data), (ch) => ch.charCodeAt(0));
      g.putImageData(new ImageData(bytes, w, h), 0, 0);
      g.lineWidth = 1;
      for (const s of shapes) {
        g.beginPath();
        g.moveTo(s.x, s.y - 15);
        g.lineTo(s.x + 30, s.y);
        g.lineTo(s.x, s.y + 15);
        g.lineTo(s.x - 30, s.y);
        g.closePath();
        if (s.fill) {
          g.fillStyle = s.fill;
          g.fill();
        }
        g.strokeStyle = s.color;
        g.globalAlpha = 0.55;
        g.stroke();
        g.globalAlpha = 1;
        if (s.label) {
          g.fillStyle = '#fff';
          g.font = '9px monospace';
          g.fillText(s.label, s.x - 5, s.y + 3);
        }
      }
      g.strokeStyle = '#0af';
      g.strokeRect(vb[0] + 0.5, vb[1] + 0.5, vb[2] - 1, vb[3] - 1);
      return canvas.toDataURL('image/png');
    },
    { w: surface.width, h: surface.height, data: rgba.toString('base64'), shapes, vb: capture.viewBounds },
  );
  writeFileSync(join(out!, `${name}.png`), Buffer.from(dataUrl.split(',')[1]!, 'base64'));
}

function saveCapture(name: string, capture: Capture, analysis: ReturnType<typeof analyse>) {
  const { surface, ...rest } = capture;
  // Raw primary surface (RGB565, `pitch` bytes per row) for offline re-analysis.
  if (surface)
    writeFileSync(
      join(out!, `${name}.${surface.width}x${surface.height}p${surface.pitch}.rgb565`),
      fromB64(surface.pixels),
    );
  writeFileSync(
    join(out!, `${name}.json`),
    JSON.stringify({ ...rest, summary: analysis.summary, samples: analysis.samples }),
  );
}

const capture = async () => (await bridge<Capture>('B.capture()'))!;
const localOf = (state: YrState) => state.objects.filter((o) => o.owner === state.localHouse);

if (reanalyse) {
  const shp = await loadShroudShp();
  const saved = JSON.parse(readFileSync(join(reanalyse, 'report.json'), 'utf8')) as {
    cellStorage?: { table: number[] };
  };
  if (saved.cellStorage) occlusionTable = Int8Array.from(saved.cellStorage.table);
  const files = readdirSync(reanalyse);
  const summaries: Record<string, unknown> = {};
  for (const file of files.filter((f) => /^capture-.*\.json$/.test(f)).sort()) {
    const name = file.slice(0, -'.json'.length);
    const pixels = files.find((f) => f.startsWith(`${name}.`) && f.endsWith('.rgb565'));
    const size = pixels?.match(/\.(\d+)x(\d+)p(\d+)\.rgb565$/);
    if (!pixels || !size) continue;
    const json = JSON.parse(readFileSync(join(reanalyse, file), 'utf8')) as Omit<Capture, 'surface'>;
    const capture: Capture = {
      ...json,
      surface: {
        width: Number(size[1]),
        height: Number(size[2]),
        pitch: Number(size[3]),
        bpp: 16,
        pixels: readFileSync(join(reanalyse, pixels)).toString('base64'),
      },
    };
    const analysis = analyse(capture, shp);
    summaries[name] = analysis.summary;
    log(`reanalysed ${name}`, analysis.summary);
    await overlayPng(`re-${name}`, capture, analysis.samples);
  }
  writeFileSync(join(out, 'reanalysis.json'), JSON.stringify({ source: reanalyse, summaries }, null, 1));
  await context.close();
  await browser.close();
  process.exit(0);
}

let outcome = 'incomplete';
try {
  const shp = await loadShroudShp();
  report.shroudShp = shp ? 'loaded from the player MIX archives (47 frames used)' : 'not available';
  await page.goto(`${origin}/?start-page=battle&mouse-lock=0${mode === 'main' ? '&vm-worker=0' : ''}`);
  await selectDevelopmentGame(page, 'yr');
  await waitFor('bridge installed', async () => (await target().evaluate(installer)) === true, 300_000);
  const supported = await bridge<boolean>('B.supported');
  check(
    'reader factories accept the pinned YR 1.001 image (hash + occlusion table)',
    supported,
    await bridge('B.hash'),
  );
  assert.ok(supported, 'reader unsupported');

  const battle = await waitFor(
    'battlefield',
    async () => {
      const [env, state, shroud] = (await bridge<[Env, YrState | null, Packed | null]>(
        '[B.env(), B.state(), B.shroud()]',
      )) ?? [null, null, null];
      return env?.phase === 'running' &&
        env.shell === '' &&
        state &&
        state.localHouse >= 0 &&
        state.objects.length > 0 &&
        shroud
        ? { state, shroud }
        : null;
    },
    900_000,
  );
  const firstFrame = battle.state.frame;
  await waitFor(
    'simulation advancing',
    async () => ((await bridge<YrState>('B.state()'))?.frame ?? 0) > firstFrame + 60,
    120_000,
  );
  zFactor = (await bridge<number>(`B.f64(${0xb0cd48})`)) ?? 0;
  log('battlefield', { frame: battle.state.frame, map: battle.state.map, zFactor });

  // ---- Cell storage ----
  const scan = (await bridge<Record<string, any>>('B.scanCells()'))!;
  const shroud0 = unpack((await bridge<Packed>('B.shroud()'))!);
  const table = fromB64(scan.table);
  occlusionTable = new Int8Array(table.buffer, table.byteOffset, 256);
  const bounds = {
    originX: shroud0.originX,
    originY: shroud0.originY,
    right: shroud0.originX + shroud0.width - 1,
    bottom: shroud0.originY + shroud0.height - 1,
  };
  report.cellStorage = { ...scan, table: Array.from(new Int8Array(table.buffer)), readerBounds: bounds };
  check(
    'every existing cell lies inside the reader bounds and MapCoords match the slot index',
    scan.count > 0 &&
      scan.coordMismatch === 0 &&
      scan.scan.minX >= bounds.originX &&
      scan.scan.minY >= bounds.originY &&
      scan.scan.maxX <= bounds.right &&
      scan.scan.maxY <= bounds.bottom,
    {
      scan: scan.scan,
      count: scan.count,
      coordMismatch: scan.coordMismatch,
      mapCoordBounds: scan.mapCoordBounds,
      bounds,
    },
  );
  check(
    'reader counts every existing cell exactly once (visible + shrouded + fogged == scan count, no invalid slots)',
    shroud0.counts.visible! + shroud0.counts.shrouded! + shroud0.counts.fogged! === scan.count &&
      shroud0.counts.invalid === 0,
    shroud0.counts,
  );
  log('invalid cell / scenario', {
    invalidCell: scan.invalidCell,
    scenarioFlags: scan.scenarioFlags,
    fogOfWar: shroud0.fogOfWar,
  });

  // ---- (a) Start: only the base area is revealed ----
  await park();
  await page.waitForTimeout(1500);
  const c0 = await capture();
  const a0 = analyse(c0, shp);
  saveCapture('capture-01-start', c0, a0);
  await overlayPng('overlay-01-start', c0, a0.samples);
  const sum0 = a0.summary;
  log('start analysis', sum0);
  const local = localOf(c0.state!);
  const revealed: { x: number; y: number }[] = [];
  for (let i = 0; i < a0.shroud.cells.length; i++)
    if (a0.shroud.cells[i] === YR_SHROUD_STATE.visible)
      revealed.push({
        x: a0.shroud.originX + (i % a0.shroud.width),
        y: a0.shroud.originY + Math.floor(i / a0.shroud.width),
      });
  const nearestLocal = (p: { x: number; y: number }) =>
    Math.min(...local.map((o) => Math.hypot(o.x / 256 - p.x - 0.5, o.y / 256 - p.y - 0.5)));
  const farthest = Math.max(...revealed.map(nearestLocal));
  const aiStart = c0.state!.objects.filter((o) => o.owner !== c0.state!.localHouse && /CNST$|MCV$/.test(o.type));
  const aiCells = aiStart.map((o) => {
    const cx = Math.floor(o.x / 256) - a0.shroud.originX,
      cy = Math.floor(o.y / 256) - a0.shroud.originY;
    return a0.shroud.cells[cy * a0.shroud.width + cx];
  });
  check(
    'start: only cells around the local units are revealed (all within 16 cells of a local unit, < 25% of the map), the AI start is shrouded',
    revealed.length > 0 &&
      farthest <= 16 &&
      revealed.length / scan.count < 0.25 &&
      aiCells.length > 0 &&
      aiCells.every((c) => c === YR_SHROUD_STATE.shrouded),
    { revealed: revealed.length, total: scan.count, farthestFromLocalUnit: farthest, aiStartStates: aiCells },
  );
  const levelHeight = await bridge<number>(`B.i32(${0xabde88})`);
  const aiHouses = new Set(
    c0
      .state!.houses.filter((h) => !h.isLocal && h.country !== 'Neutral' && h.country !== 'Special')
      .map((h) => h.index),
  );
  const aiObjects = c0.state!.objects.filter((o) => aiHouses.has(o.owner));
  check(
    'isYrLocationShrouded (MapClass::IsLocationShrouded rule): every local object is unshrouded, every AI object shrouded; level height global is 104',
    levelHeight === YR_LEVEL_HEIGHT &&
      local.every((o) => !isYrLocationShrouded(a0.shroud, o.x, o.y, o.z)) &&
      aiObjects.length > 0 &&
      aiObjects.every((o) => isYrLocationShrouded(a0.shroud, o.x, o.y, o.z)),
    {
      levelHeight,
      localShrouded: local.filter((o) => isYrLocationShrouded(a0.shroud, o.x, o.y, o.z)).map((o) => o.type),
      aiObjects: aiObjects.length,
      aiVisible: aiObjects.filter((o) => !isYrLocationShrouded(a0.shroud, o.x, o.y, o.z)).map((o) => o.type),
    },
  );
  check(
    'start frame: >= 95% of cells that are pure black in the frame read as shrouded/covered, >= 95% of terrain cells read as revealed',
    sum0.cellsInView > 100 && sum0.blackReadCoveredOrEdge >= 0.95 && sum0.terrainReadVisible >= 0.95,
    {
      cellsInView: sum0.cellsInView,
      blackReadShrouded: sum0.blackReadShrouded,
      blackReadCoveredOrEdge: sum0.blackReadCoveredOrEdge,
      terrainReadVisible: sum0.terrainReadVisible,
      confusion: sum0.confusion,
    },
  );
  check(
    'start frame: memory-covered cells are black (>= 95%) and memory-clear cells show terrain (>= 95%)',
    sum0.coveredAreBlack >= 0.95 && sum0.clearShowTerrain >= 0.95,
    { coveredAreBlack: sum0.coveredAreBlack, clearShowTerrain: sum0.clearShowTerrain },
  );
  if (shp)
    check(
      'soft edge band: in edge-piece cells, pixels the reader-chosen SHROUD.SHP frames predict dark (<= 10/127) are black >= 99%, lit (>= 100/127) not black >= 97%; predicted intensity correlates with frame brightness >= 0.6 and >= 0.4 better than the 180-degree-rotated control',
      !!sum0.pixels &&
        sum0.pixels.bandDarkAgreement! >= 0.99 &&
        sum0.pixels.bandLitAgreement! >= 0.97 &&
        sum0.pixels.bandCorrelation! >= 0.6 &&
        sum0.pixels.bandCorrelation! >= (sum0.pixels.controlBandCorrelation ?? 1) + 0.4,
      { edgeCells: sum0.edgeCells, edgeBlackFractionError: sum0.edgeBlackFractionError, pixels: sum0.pixels },
    );
  check(
    "reader edge frames equal the engine's own cached CellClass::Visibility for >= 99% of cells in view",
    sum0.engineVisibilityAgreement >= 0.99,
    { agreement: sum0.engineVisibilityAgreement, mismatches: sum0.engineVisibilityMismatches },
  );

  // ---- (b) Drive a vehicle into the unknown ----
  const [vbx, vby, vbw, vbh] = c0.viewBounds;
  const safe = (p: { x: number; y: number }) =>
    p.x >= vbx + 80 && p.y >= vby + 60 && p.x <= vbx + vbw - 80 && p.y <= vby + vbh - 60;
  const vehicles = local
    .filter((o) => o.kind === 'vehicle' && !/MCV$|^HARV$|^CMIN$/.test(o.type))
    .map((o) => ({ o, p: toSurface(c0, o.x, o.y, o.z) }))
    .filter(({ p }) => safe(p));
  // Target: a covered cell inside the safe part of the view, 6..14 cells from the vehicle, deepest into the shroud.
  const covered = a0.samples.filter(
    (c) => c.memory === 'covered' && c.state === YR_SHROUD_STATE.shrouded && safe({ x: c.sx, y: c.sy }),
  );
  type Plan = { vehicle: (typeof vehicles)[number]; cell: CellSample; distance: number; depth: number };
  let best: Plan | null = null;
  const revealedSamples = a0.samples.filter((c) => c.memory !== 'covered');
  for (const vehicle of vehicles)
    for (const cell of covered) {
      const distance = Math.hypot(vehicle.o.x / 256 - cell.x - 0.5, vehicle.o.y / 256 - cell.y - 0.5);
      if (distance < 6 || distance > 14) continue;
      const depth = Math.min(...revealedSamples.map((c) => Math.hypot(c.x - cell.x, c.y - cell.y)));
      if (!best || depth > best.depth || (depth === best.depth && distance < best.distance))
        best = { vehicle, cell, distance, depth };
    }
  const plan: Plan | null = best;
  report.movePlan = plan && {
    vehicle: {
      id: plan.vehicle.o.id,
      type: plan.vehicle.o.type,
      cell: [Math.floor(plan.vehicle.o.x / 256), Math.floor(plan.vehicle.o.y / 256)],
    },
    target: [plan.cell.x, plan.cell.y],
    distance: plan.distance,
    depth: plan.depth,
  };
  log('move plan', report.movePlan);
  if (plan) {
    await bridge(`B.startPoll(${hz}, true)`);
    // Select the vehicle (retry with small offsets), then click the shrouded target cell.
    let selected = false;
    for (let attempt = 0; attempt < 4 && !selected; attempt++) {
      const s = (await bridge<YrState>('B.state()'))!;
      const now = s.objects.find((o) => o.id === plan.vehicle.o.id);
      if (!now) break;
      const cap = await capture();
      const p = toSurface(cap, now.x, now.y, now.z);
      await clickSurface(p.x, p.y - 4 + attempt * 3);
      await page.waitForTimeout(400);
      selected = !!(await bridge<YrState>('B.state()'))!.objects.find((o) => o.id === plan.vehicle.o.id)?.isSelected;
    }
    const cBefore = await capture();
    const aBefore = analyse(cBefore, shp);
    const targetNow = terrainCentre(cBefore, plan.cell.x, plan.cell.y, plan.cell.level);
    await clickSurface(targetNow.x, targetNow.y);
    await park();
    log('move ordered', { selected, target: [plan.cell.x, plan.cell.y] });
    const midCaptures: { t: number; capture: Capture; analysis: ReturnType<typeof analyse> }[] = [];
    const moveStart = Date.now();
    while (Date.now() - moveStart < moveSeconds * 1000) {
      await page.waitForTimeout(1000);
      const cap = await capture();
      midCaptures.push({ t: (Date.now() - moveStart) / 1000, capture: cap, analysis: analyse(cap, shp) });
    }
    await bridge('B.stopPoll()');
    const moveSummary = (await bridge<Record<string, any>>('B.pollSummary()'))!;
    const cAfter = midCaptures.at(-1)!.capture;
    const aAfter = midCaptures.at(-1)!.analysis;
    // Cells revealed during the move, as seen in the two captures (same bounds on the same map).
    const key = (c: CellSample) => `${c.x},${c.y}`;
    const before = new Map(aBefore.samples.map((c) => [key(c), c]));
    const newly = aAfter.samples.filter((c) => {
      const b = before.get(key(c));
      return b && b.state === YR_SHROUD_STATE.shrouded && c.state === YR_SHROUD_STATE.visible;
    });
    const newlyClear = newly.filter((c) => c.memory === 'clear');
    const vehicleAfter = cAfter.state!.objects.find((o) => o.id === plan.vehicle.o.id);
    const moved = vehicleAfter
      ? Math.hypot(vehicleAfter.x - plan.vehicle.o.x, vehicleAfter.y - plan.vehicle.o.y) / 256
      : null;
    saveCapture('capture-02-before-move', cBefore, aBefore);
    saveCapture('capture-03-after-move', cAfter, aAfter);
    await overlayPng('overlay-02-before-move', cBefore, aBefore.samples, new Set([`${plan.cell.x},${plan.cell.y}`]));
    await overlayPng('overlay-03-after-move', cAfter, aAfter.samples, new Set(newly.map(key)));
    if (midCaptures.length > 2) {
      const mid = midCaptures[Math.floor(midCaptures.length / 2)]!;
      await overlayPng('overlay-04-mid-move', mid.capture, mid.analysis.samples);
    }
    // Per capture: cells memory reports revealed-since-start that are in view, and whether the frame shows them.
    const progression = midCaptures.map(({ t, analysis }) => {
      const revealedNow = analysis.samples.filter((c) => {
        const b = before.get(key(c));
        return b && b.state === YR_SHROUD_STATE.shrouded && c.state === YR_SHROUD_STATE.visible;
      });
      return {
        t,
        frame: analysis.summary.frame,
        revealedInView: revealedNow.length,
        revealedClearShowTerrain:
          revealedNow.filter((c) => c.memory === 'clear' && c.frameClass === 'terrain').length /
          Math.max(1, revealedNow.filter((c) => c.memory === 'clear').length),
        coveredAreBlack: analysis.summary.coveredAreBlack,
        clearShowTerrain: analysis.summary.clearShowTerrain,
        engineVisibilityAgreement: analysis.summary.engineVisibilityAgreement,
      };
    });
    const revealCount = Object.keys(moveSummary.reveals).length;
    report.move = {
      selected,
      moved,
      pollRevealEvents: revealCount,
      reshrouds: moveSummary.reshrouds,
      newlyRevealedInView: newly.length,
      newlyRevealedWereBlackBefore: newly.filter((c) => before.get(key(c))!.frameClass === 'black').length,
      newlyRevealedClearShowTerrainAfter: newlyClear.filter((c) => c.frameClass === 'terrain').length,
      newlyRevealedClear: newlyClear.length,
      progression,
      polls: moveSummary.polls,
    };
    log('move result', report.move);
    check(
      'move: the vehicle drove at least 4 cells and memory revealed cells in view that were black before',
      selected &&
        (moved ?? 0) >= 4 &&
        newly.length >= 10 &&
        newly.filter((c) => before.get(key(c))!.frameClass === 'black').length / newly.length >= 0.9,
      { selected, moved, newly: newly.length },
    );
    check(
      'move: newly revealed cells that memory reports clear show terrain in the later frame (>= 95%)',
      newlyClear.length >= 5 && newlyClear.filter((c) => c.frameClass === 'terrain').length / newlyClear.length >= 0.95,
      { newlyClear: newlyClear.length, showTerrain: newlyClear.filter((c) => c.frameClass === 'terrain').length },
    );
    check(
      'move: during the drive every capture keeps covered-is-black and clear-shows-terrain >= 95%',
      progression.every((p) => p.coveredAreBlack >= 0.95 && p.clearShowTerrain >= 0.95),
      progression,
    );
    check(
      'move: no cell went from revealed back to shrouded while polling (no gap generator on the map)',
      moveSummary.reshrouds === 0,
      {
        reshrouds: moveSummary.reshrouds,
        revealEvents: revealCount,
      },
    );
  } else
    check('a local vehicle and a shrouded target 6..14 cells away are on screen for the move test', false, {
      vehicles: vehicles.length,
      covered: covered.length,
    });

  // ---- (c) Poll timing ----
  await bridge(`B.startPoll(${hz}, true)`);
  const pollStart = Date.now();
  while ((Date.now() - pollStart) / 1000 < pollSeconds) await page.waitForTimeout(5000);
  await bridge('B.stopPoll()');
  const poll = (await bridge<Record<string, any>>('B.pollSummary()'))!;
  const costs = [...(poll.costs as number[])].sort((a, b) => a - b);
  const q = (arr: number[], p: number) => arr[Math.min(arr.length - 1, Math.floor(p * arr.length))]!;
  const burst = (await bridge<{ fresh: number[]; reuse: number[] }>('B.burst(200)'))!;
  const stat = (arr: number[]) => {
    const sorted = [...arr].sort((a, b) => a - b);
    return {
      mean: sorted.reduce((a, b) => a + b, 0) / sorted.length,
      p50: q(sorted, 0.5),
      p95: q(sorted, 0.95),
      max: sorted.at(-1),
    };
  };
  const frames = poll.frames as number[];
  report.poll = {
    polls: poll.polls,
    nulls: poll.nulls,
    errors: poll.errors.slice(0, 5),
    elapsedS: poll.elapsedMs / 1000,
    achievedHz: poll.polls / (poll.elapsedMs / 1000),
    costMs: stat(costs),
    burstMs: { fresh: stat(burst.fresh), reuse: stat(burst.reuse) },
    cellsPerRead: shroud0.width * shroud0.height,
    framesBackwards: frames.filter((f, i) => i > 0 && f < frames[i - 1]!).length,
    reshrouds: poll.reshrouds,
  };
  check(
    `polled ${pollSeconds}s at ${hz} Hz in the VM thread without exceptions or null reads; p95 cost < 5 ms`,
    poll.errors.length === 0 && poll.nulls === 0 && q(costs, 0.95) < 5,
    report.poll,
  );
  const cEnd = await capture();
  const aEnd = analyse(cEnd, shp);
  saveCapture('capture-05-end', cEnd, aEnd);
  await overlayPng('overlay-05-end', cEnd, aEnd.samples);
  check(
    'end frame: covered cells black and clear cells show terrain (>= 95%), engine Visibility agreement >= 99%',
    aEnd.summary.coveredAreBlack >= 0.95 &&
      aEnd.summary.clearShowTerrain >= 0.95 &&
      aEnd.summary.engineVisibilityAgreement >= 0.99,
    {
      coveredAreBlack: aEnd.summary.coveredAreBlack,
      clearShowTerrain: aEnd.summary.clearShowTerrain,
      engineVisibilityAgreement: aEnd.summary.engineVisibilityAgreement,
      cellsInView: aEnd.summary.cellsInView,
    },
  );
  outcome = checks.every((c) => c.pass) ? 'pass' : 'fail';
} catch (error) {
  outcome = `error: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`;
  log('stopped', outcome);
  await page.screenshot({ path: join(out, 'error.png') }).catch(() => undefined);
} finally {
  report.pageErrors = pageErrors;
  report.outcome = outcome;
  report.finishedAt = new Date().toISOString();
  flush();
  console.log('[shroud] outcome', outcome, `${checks.filter((c) => c.pass).length}/${checks.length} checks passed`);
  await context.close();
  await browser.close();
  console.log('[shroud] evidence in', out);
}
