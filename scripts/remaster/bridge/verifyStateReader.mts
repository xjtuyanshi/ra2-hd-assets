/**
 * Remaster bridge: empirical verification of the read-only YR 1.001 live-state reader (src/games/yr/stateReader.ts).
 *
 * It starts a real YR skirmish through `?start-page=battle` (the scratch installation's RA2MD.INI [Skirmish] section
 * picks the map and one Easy AI; see scripts/remaster/perf/README.md), loads the reader module from the development
 * server into the VM thread (main-thread mode by default, `vm-worker=0`), and then:
 *
 * - checks map file name, theater, [Map] Size/LocalSize and the start waypoints against the loose map file on disk;
 * - finds the local MCV, checks its type/owner and that its cell is the house's start waypoint, deploys it with the
 *   player's own input (click to select, `D`), and checks that a construction yard appears on that spot;
 * - orders a turreted tank to move in four directions and compares the reported body facing with the direction of the
 *   measured displacement, then force-fires (Ctrl+click) to one side and compares the turret facing with the target
 *   direction while the body stays put;
 * - polls the reader at BRIDGE_HZ (30) for at least BRIDGE_POLL_S (150) seconds in the VM thread, counting exceptions,
 *   vector/count mismatches and invalid entries, and timing every call.
 *
 * The only guest input is ordinary mouse/keyboard input a player would give (?mouse-lock=0 keeps absolute pointer
 * coordinates). Nothing writes guest memory. Evidence (JSON, overlay screenshots) goes to BRIDGE_OUT.
 *
 * Usage (development server started with RA2_GAME_ROOT=<scratch root whose ra2/ holds the YR files and the edited INI>):
 *   BRIDGE_OUT=/path BRIDGE_GAME_DIR=<scratch root>/ra2 RA2_BROWSER_ORIGIN=https://127.0.0.1:15174 \
 *     pnpm exec tsx scripts/remaster/bridge/verifyStateReader.mts
 * Optional: VM_BROWSER_MODE=worker, BRIDGE_POLL_S, BRIDGE_HZ, BRIDGE_DISCOVER=1 (print the map and exit).
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type Page, type Worker } from '@playwright/test';
import { selectDevelopmentGame } from '../../../tests/helpers/selectDevelopmentGame';
import { worldVectorToFacing, type YrObjectState, type YrState } from '../../../src/games/yr/stateReader';

const env = process.env;
const origin = env.RA2_BROWSER_ORIGIN ?? 'https://127.0.0.1:15174';
const out = env.BRIDGE_OUT;
assert.ok(out, 'BRIDGE_OUT (output directory) is required');
mkdirSync(out, { recursive: true });
const gameDir = env.BRIDGE_GAME_DIR ?? '';
const mode = env.VM_BROWSER_MODE === 'worker' ? 'worker' : 'main';
const pollSeconds = Number(env.BRIDGE_POLL_S ?? 150);
const hz = Number(env.BRIDGE_HZ ?? 30);
const discover = env.BRIDGE_DISCOVER === '1';
const headless = env.BRIDGE_HEADLESS !== '0';

/**
 * Installed into the VM thread (page for main-thread mode, Worker otherwise). It imports the reader from the dev
 * server, builds a byte-view accessor over live guest memory for every call, and runs the 30 Hz poll loop there so
 * the timing reflects the thread a renderer bridge would poll from.
 */
const installer = `(async () => {
  if (globalThis.__bridge) return true;
  const core = () => globalThis.__bridgeCoreGetter?.();
  const c0 = core();
  if (!c0?.shim || !c0.emulator || !c0.source?.executableBytes) return false;
  const reader = await import('/src/games/yr/stateReader.ts');
  const access = await import('/src/games/shared/memoryAccessor.ts');
  const digest = await crypto.subtle.digest('SHA-256', c0.source.executableBytes);
  const hash = Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
  const accessor = () => { const c = core(); return access.createByteViewAccessor(c.emulator.read_memory(0, c.guestMemoryBytes)); };
  const read = reader.createYrStateReader(accessor, hash);
  const O = reader.YR_STATE_OFFSETS;
  const typeOffset = { building: O.buildingType, vehicle: O.unitType, infantry: O.infantryType, aircraft: O.aircraftType };
  // Raw ObjectClass::Health and ObjectTypeClass::Strength, read independently of the reader's clamped ratio.
  const rawHealth = (mem, o) => ({ hp: mem.i32(o.id + O.health), strength: mem.i32(mem.u32(o.id + typeOffset[o.kind]) + O.typeStrength) });
  const B = {
    hash, supported: !!read,
    read: (options) => read ? read(options) : null,
    raw(address, length) { return Array.from(accessor().bytes(address, length)); },
    u32(address) { return accessor().u32(address); },
    i32(address) { return accessor().i32(address); },
    // One object plus its raw Health/Strength from the same VM-thread turn (the guest cannot run in between).
    objectWithRaw(id) {
      const state = read ? read({}) : null;
      const o = state?.objects.find((x) => x.id === id);
      return o ? { ...o, raw: rawHealth(accessor(), o) } : null;
    },
    // [MultiPlayer] Handle (comma-separated hex bytes) from the RA2MD.INI the VM actually mounted, for the house name check.
    async handle() {
      try {
        const bytes = await core()?.source?.files?.read('RA2MD.INI');
        if (!bytes) return null;
        // Line-based parse (this runs inside a template literal, so no regex escapes).
        let inSection = false, hex = null;
        for (const line of Array.from(bytes, (b) => String.fromCharCode(b)).join('').split(String.fromCharCode(10))) {
          const t = line.trim();
          if (t.startsWith('[')) inSection = t.toLowerCase() === '[multiplayer]';
          else if (inSection && t.toLowerCase().startsWith('handle=')) hex = t.slice(7);
        }
        if (!hex) return null;
        const codes = hex.split(',').map((h) => h.trim()).filter(Boolean).map((h) => parseInt(h, 16));
        return codes.every((c) => c > 0 && c < 0x80) ? String.fromCharCode(...codes) : { nonAscii: codes };
      } catch (error) { return { error: String(error) }; }
    },
    f64(address) { const b = accessor().bytes(address, 8); return b.length === 8 ? new DataView(b.buffer).getFloat64(0, true) : null; },
    env() {
      const c = core(), s = c?.shim; const p = s?.surfaces?.get(s.primarySurface);
      return { phase: c?.currentPhase ?? null, shell: s?.inspectShellPageTitle() ?? null,
        surface: p ? { width: p.width, height: p.height } : null,
        windows: s ? s.inspectWindowState().filter((w) => s.isWindowVisible(w.hwnd)).length : 0 };
    },
    poll: null,
    startPoll(rate, snapshotEveryMs) {
      const P = B.poll = { startedAt: performance.now(), polls: 0, errors: [], nulls: 0, costs: [], objectCounts: [],
        technoMismatch: 0, kindMismatch: 0, invalid: 0, limbo: 0, ownerUnknown: 0, uidDuplicates: 0,
        rawHealthChecked: 0, rawHealthOutOfRange: 0, healthRatioMismatch: 0, rawHealthExamples: [], clampedHealthOutOfRange: 0,
        facingOutOfRange: 0, zeroHealth: 0, frames: { first: null, last: null, backwards: 0 },
        snapshots: [], tracks: {}, tracked: new Set(), autoTrackLimit: 80, lastKey: {}, timer: 0 };
      const technoCount = () => accessor().u32(${0xa8ec78} + 0x10);
      const tick = () => {
        const t0 = performance.now();
        let state = null;
        try { state = read({}); } catch (error) { P.errors.push(String(error)); }
        const t1 = performance.now();
        P.polls++; P.costs.push(Math.round((t1 - t0) * 1000) / 1000);
        if (!state) { P.nulls++; return; }
        P.objectCounts.push(state.objects.length);
        if (P.frames.first === null) P.frames.first = state.frame;
        if (P.frames.last !== null && state.frame < P.frames.last) P.frames.backwards++;
        P.frames.last = state.frame;
        const v = state.stats.vectors;
        if (technoCount() !== v.building + v.vehicle + v.infantry + v.aircraft) P.technoMismatch++;
        for (const kind of ['building', 'vehicle', 'infantry', 'aircraft']) {
          const n = state.objects.filter((o) => o.kind === kind).length;
          if (n + state.stats.limbo[kind] + state.stats.invalid[kind] !== v[kind]) P.kindMismatch++;
          P.invalid += state.stats.invalid[kind]; P.limbo += state.stats.limbo[kind];
        }
        const uids = new Set();
        const mem = accessor();
        for (const o of state.objects) {
          if (o.owner < 0) P.ownerUnknown++;
          // The reader clamps health to 0..1, so check the raw fields instead: 0 <= Health <= Strength, Strength > 0,
          // and the reported ratio equals Health / Strength (no clamping actually happened).
          const raw = rawHealth(mem, o);
          P.rawHealthChecked++;
          const bad = !(raw.strength > 0 && raw.hp >= 0 && raw.hp <= raw.strength);
          if (bad) P.rawHealthOutOfRange++;
          if (!bad && Math.abs(o.health - raw.hp / raw.strength) > 1e-12) P.healthRatioMismatch++;
          if ((bad || raw.hp < raw.strength) && P.rawHealthExamples.length < 8 && !P.rawHealthExamples.some((e) => e.type === o.type && e.hp === raw.hp))
            P.rawHealthExamples.push({ frame: state.frame, type: o.type, hp: raw.hp, strength: raw.strength, health: o.health });
          if (!(o.health >= 0 && o.health <= 1)) P.clampedHealthOutOfRange++;
          if (o.health === 0) P.zeroHealth++;
          if (!(o.facing >= 0 && o.facing <= 255) || (o.turretFacing !== undefined && !(o.turretFacing >= 0 && o.turretFacing <= 255))) P.facingOutOfRange++;
          if (uids.has(o.uid)) P.uidDuplicates++; uids.add(o.uid);
          if (o.kind !== 'building' && !P.tracked.has(o.id) && P.tracked.size < P.autoTrackLimit) P.tracked.add(o.id);
          if (!P.tracked.has(o.id)) continue;
          const key = [o.x, o.y, o.z, o.facingRaw, o.turretFacingRaw, o.isSelected, o.health].join(',');
          if (P.lastKey[o.id] === key) continue;
          P.lastKey[o.id] = key;
          (P.tracks[o.id] ??= []).push({ t: Math.round(t0 - P.startedAt), frame: state.frame, kind: o.kind, type: o.type, owner: o.owner,
            x: o.x, y: o.y, z: o.z, facing: o.facing, facingRaw: o.facingRaw, turretFacing: o.turretFacing, turretFacingRaw: o.turretFacingRaw,
            selected: o.isSelected, health: o.health });
        }
        if (t0 - (P.lastSnapshotAt ?? -Infinity) >= snapshotEveryMs) { P.lastSnapshotAt = t0; P.snapshots.push({ t: Math.round(t0 - P.startedAt), state }); }
      };
      P.timer = setInterval(tick, 1000 / rate);
      return true;
    },
    track(ids) { for (const id of ids) B.poll?.tracked.add(id); return true; },
    stopPoll() { if (B.poll) clearInterval(B.poll.timer); return true; },
    pollSummary() {
      const P = B.poll; if (!P) return null;
      const { timer, tracked, lastKey, snapshots, tracks, ...rest } = P;
      return { ...rest, elapsedMs: performance.now() - P.startedAt, tracked: tracked.size };
    },
    pollTracks(ids) { const P = B.poll; if (!P) return {}; const r = {}; for (const id of ids ?? Object.keys(P.tracks)) if (P.tracks[id]) r[id] = P.tracks[id]; return r; },
    pollSnapshots() { return B.poll?.snapshots ?? []; },
  };
  globalThis.__bridge = B;
  return true;
})()`;

type Env = {
  phase: string | null;
  shell: string | null;
  surface: { width: number; height: number } | null;
  windows: number;
};
type TrackPoint = {
  t: number;
  frame: number;
  kind: string;
  type: string;
  owner: number;
  x: number;
  y: number;
  z: number;
  facing: number;
  facingRaw: number;
  turretFacing?: number;
  turretFacingRaw?: number;
  selected: boolean;
  health: number;
};

const t0 = Date.now();
const events: { t: number; event: string; detail?: unknown }[] = [];
const log = (event: string, detail?: unknown) => {
  events.push({ t: (Date.now() - t0) / 1000, event, detail });
  console.log(
    `[bridge ${((Date.now() - t0) / 1000).toFixed(0)}s] ${event}`,
    detail === undefined ? '' : JSON.stringify(detail),
  );
};
const report: Record<string, unknown> = { origin, mode, pollSeconds, hz, startedAt: new Date().toISOString() };
const checks: { name: string; pass: boolean; detail?: unknown }[] = [];
const check = (name: string, pass: boolean, detail?: unknown) => {
  checks.push({ name, pass, detail });
  log(`${pass ? 'PASS' : 'FAIL'} ${name}`, detail);
};
const flush = (extra: Record<string, unknown> = {}) =>
  writeFileSync(join(out, 'report.json'), JSON.stringify({ ...report, checks, events, ...extra }, null, 1));

/** Circular distance of two 0..256 facings. */
const facingDelta = (a: number, b: number) => {
  const d = (((a - b) % 256) + 256) % 256;
  return d > 128 ? 256 - d : d;
};

/** Minimal INI reader (sections are case-insensitive, keys case-sensitive). */
function parseIni(text: string): Map<string, Map<string, string>> {
  const sections = new Map<string, Map<string, string>>();
  let current: Map<string, string> | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/;.*$/, '').trim();
    const header = line.match(/^\[(.+)\]$/);
    if (header) {
      const name = header[1]!.toLowerCase();
      current = sections.get(name) ?? new Map();
      sections.set(name, current);
    } else if (current && line.includes('=')) {
      const at = line.indexOf('=');
      current.set(line.slice(0, at).trim(), line.slice(at + 1).trim());
    }
  }
  return sections;
}

/**
 * The scenario file as the game read it: a loose file in the installation, otherwise an entry of one of its MIX
 * archives (one nesting level), read with the fork's own MIX parser. The import specifier is computed so the root
 * type check does not pull the package sources in; any failure just means "not found".
 */
async function readScenarioFile(name: string): Promise<{ source: string; text: string } | null> {
  if (!gameDir) return null;
  const files = readdirSync(gameDir);
  const loose = files.find((file) => file.toLowerCase() === name.toLowerCase());
  if (loose) return { source: loose, text: readFileSync(join(gameDir, loose), 'latin1') };
  try {
    const specifier = ['..', '..', '..', 'packages', 'ra2-formats', 'src', 'index.ts'].join('/');
    const { MixFile } = (await import(specifier)) as {
      MixFile: { parse(data: Uint8Array): { read(name: string): Uint8Array | undefined; list(): unknown[] } };
    };
    const decode = (bytes: Uint8Array) => new TextDecoder('latin1').decode(bytes);
    for (const file of files.filter((file) => /\.mix$/i.test(file))) {
      const mix = MixFile.parse(new Uint8Array(readFileSync(join(gameDir, file))));
      const direct = mix.read(name);
      if (direct) return { source: file, text: decode(direct) };
      for (const inner of ['maps01.mix', 'maps02.mix', 'mapsmd03.mix', 'multimd.mix']) {
        const nested = mix.read(inner);
        const found = nested && MixFile.parse(nested).read(name);
        if (found) return { source: `${file}/${inner}`, text: decode(found) };
      }
    }
  } catch (error) {
    log('MIX lookup failed', String(error));
  }
  return null;
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
    `(async () => { const B = globalThis.__bridge; if (!B) return null; return ${expression}; })()`,
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
const readState = () => bridge<YrState | null>('B.read({})');

/** Screen projection (YRpp TacticalClass::CoordsToScreen facts): 60x30 pixel cells, Z scaled by the double at 0xB0CD48. */
let zFactor = 0;
const project = (state: YrState, x: number, y: number, z: number) => {
  const adjustZ = Math.trunc(z * zFactor + (z >= 728 ? 1 : 0) + 0.5);
  const sx = Math.trunc((30 * x - 30 * y) / 256);
  const sy = Math.trunc((15 * y + 15 * x) / 256) - adjustZ;
  return { x: sx - (state.view?.x ?? 0), y: sy - (state.view?.y ?? 0) };
};
async function canvasPoint(surfaceX: number, surfaceY: number) {
  const box = await page.locator('#screen').boundingBox();
  const surface = (await bridge<Env>('B.env()'))?.surface;
  assert.ok(box && surface, 'canvas or surface missing');
  return {
    x: box.x + ((surfaceX + 0.5) * box.width) / surface.width,
    y: box.y + ((surfaceY + 0.5) * box.height) / surface.height,
  };
}
async function park() {
  const surface = (await bridge<Env>('B.env()'))?.surface;
  if (!surface) return;
  const p = await canvasPoint(surface.width * 0.4, surface.height * 0.45);
  await page.mouse.move(p.x, p.y);
}
/** A press spanning several logic frames, as a player's click does (instantaneous clicks can be swallowed). */
async function clickSurface(x: number, y: number, modifiers: string[] = []) {
  const p = await canvasPoint(x, y);
  await page.mouse.move(p.x - 3, p.y - 3);
  await page.waitForTimeout(120);
  await page.mouse.move(p.x, p.y);
  await page.waitForTimeout(250);
  for (const key of modifiers) await page.keyboard.down(key);
  await page.waitForTimeout(modifiers.length ? 150 : 0);
  await page.mouse.down();
  await page.waitForTimeout(150);
  await page.mouse.up();
  await page.waitForTimeout(150);
  for (const key of modifiers.reverse()) await page.keyboard.up(key);
}
async function pressKey(key: string) {
  await page.keyboard.down(key);
  await page.waitForTimeout(150);
  await page.keyboard.up(key);
}

/** Overlay every object's projected position and label on the canvas, screenshot, then remove the overlay. */
async function overlayShot(name: string, state: YrState, highlight: number[] = []) {
  const surface = (await bridge<Env>('B.env()'))?.surface;
  const box = await page.locator('#screen').boundingBox();
  if (!surface || !box) return;
  const marks = state.objects.map((o) => {
    const s = project(state, o.x, o.y, o.z);
    return {
      x: box.x + ((s.x + 0.5) * box.width) / surface.width,
      y: box.y + ((s.y + 0.5) * box.height) / surface.height,
      label: `${o.type} f${o.facing}${o.turretFacing === undefined ? '' : ` t${o.turretFacing}`} ${Math.floor(o.x / 256)},${Math.floor(o.y / 256)}`,
      color: highlight.includes(o.id) ? '#ff0' : o.owner === state.localHouse ? '#0f0' : '#f44',
      facing: o.facing,
    };
  });
  await page.evaluate((marks) => {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.id = '__bridge_overlay';
    svg.setAttribute('style', 'position:fixed;left:0;top:0;width:100vw;height:100vh;pointer-events:none;z-index:99999');
    for (const m of marks) {
      // Facing arrow in screen space: world (sin f, -cos f) projected with the 2:1 isometric transform.
      const a = (m.facing / 256) * Math.PI * 2,
        wx = Math.sin(a),
        wy = -Math.cos(a);
      const dx = (wx - wy) * 14,
        dy = (wx + wy) * 7;
      svg.insertAdjacentHTML(
        'beforeend',
        `<circle cx="${m.x}" cy="${m.y}" r="4" fill="none" stroke="${m.color}" stroke-width="2"/>` +
          `<line x1="${m.x}" y1="${m.y}" x2="${m.x + dx}" y2="${m.y + dy}" stroke="${m.color}" stroke-width="2"/>` +
          `<text x="${m.x + 6}" y="${m.y - 6}" fill="${m.color}" font-size="10" font-family="monospace" stroke="#000" stroke-width="0.4">${m.label}</text>`,
      );
    }
    document.body.appendChild(svg);
  }, marks);
  await page.screenshot({ path: join(out!, `${name}.png`) });
  await page.evaluate(() => document.getElementById('__bridge_overlay')?.remove());
}

const localOf = (state: YrState) => state.objects.filter((o) => o.owner === state.localHouse);
const cell = (o: { x: number; y: number }) => ({ x: Math.floor(o.x / 256), y: Math.floor(o.y / 256) });

let outcome = 'incomplete';
try {
  await page.goto(`${origin}/?start-page=battle&mouse-lock=0${mode === 'main' ? '&vm-worker=0' : ''}`);
  await selectDevelopmentGame(page, 'yr');
  await waitFor('bridge installed', async () => (await target().evaluate(installer)) === true, 300_000);
  const supported = await bridge<boolean>('B.supported');
  check('reader factory accepts the pinned YR 1.001 image (hash + vtable sanity)', supported, await bridge('B.hash'));
  assert.ok(supported, 'reader unsupported');

  const battle = await waitFor(
    'battlefield',
    async () => {
      const [env, state] = (await bridge<[Env, YrState | null]>('[B.env(), B.read({})]')) ?? [];
      return env?.phase === 'running' && env.shell === '' && state && state.localHouse >= 0 && state.objects.length > 0
        ? state
        : null;
    },
    900_000,
  );
  const firstFrame = battle.frame;
  await waitFor('simulation advancing', async () => ((await readState())?.frame ?? 0) > firstFrame + 60, 120_000);
  zFactor = (await bridge<number>(`B.f64(${0xb0cd48})`)) ?? 0;
  log('battlefield', { frame: battle.frame, map: battle.map, zFactor, env: await bridge('B.env()') });
  if (discover) {
    outcome = 'discover';
    throw new Error('discover mode');
  }

  // ---- Map ----
  const state0 = (await readState())!;
  writeFileSync(join(out, 'state-initial.json'), JSON.stringify(state0, null, 1));
  const map = state0.map!;
  check(
    'map.fileName is a plausible map file name',
    !!map.fileName && /^[\w\-. ]+\.(yro|map|mpr|mmx)$/i.test(map.fileName),
    map.fileName,
  );
  check('map.theater is a known theater', !!map.theater, map.theater);
  const mapFile = map.fileName ? await readScenarioFile(map.fileName) : null;
  let waypointsOnDisk: Map<string, string> | undefined;
  if (mapFile) {
    const ini = parseIni(mapFile.text);
    const size = ini.get('map')?.get('Size')?.split(',').map(Number) ?? [];
    const local = ini.get('map')?.get('LocalSize')?.split(',').map(Number) ?? [];
    const theater = ini.get('map')?.get('Theater')?.toLowerCase();
    report.mapFile = {
      source: mapFile.source,
      size,
      local,
      theater,
      waypoints: Object.fromEntries(ini.get('waypoints') ?? []),
    };
    check('map width/height equal [Map] Size=', map.width === size[2] && map.height === size[3], {
      reader: map.size,
      file: size,
      source: mapFile.source,
    });
    check(
      'map.localSize equals [Map] LocalSize=',
      JSON.stringify([map.localSize?.x, map.localSize?.y, map.localSize?.width, map.localSize?.height]) ===
        JSON.stringify(local),
      { reader: map.localSize, file: local },
    );
    check('map.theater equals [Map] Theater=', map.theater === theater, { reader: map.theater, file: theater });
    waypointsOnDisk = ini.get('waypoints');
  } else check('scenario file found on disk for cross-checking', false, { gameDir, file: map.fileName });

  // ---- Houses ----
  const houses = state0.houses;
  // Skirmish houses: the player and AI houses, then the map's Neutral and Special houses.
  const players = houses.filter((h) => h.country !== 'Neutral' && h.country !== 'Special');
  check(
    'houses: indices match HouseClass::ArrayIndex, exactly one local human, AI houses not human, countries and PlainName readable',
    players.length === 2 &&
      houses.filter((h) => h.isLocal).length === 1 &&
      houses.find((h) => h.isLocal)!.isHuman &&
      houses.filter((h) => !h.isLocal).every((h) => !h.isHuman) &&
      houses.every((h, i) => h.index === i && !!h.country && !!h.plainName),
    houses,
  );
  // The displayed name (HouseClass::UIName) of the local human is the [MultiPlayer] Handle the VM mounted (the page
  // generates a random ra2hd-xxxxx handle per VM); PlainName only holds the "<human player>" placeholder.
  const handle = await bridge<unknown>('B.handle()');
  const localHouse = houses.find((h) => h.isLocal);
  check(
    'local house name (UIName, UTF-16 at +0x1602A) equals the mounted [MultiPlayer] Handle, not the PlainName placeholder',
    !!localHouse?.name &&
      localHouse.name !== localHouse.plainName &&
      (typeof handle === 'string' ? localHouse.name === handle : /^ra2hd-[0-9a-z]{5}$/.test(localHouse.name)),
    { handle, houses: houses.map((h) => ({ index: h.index, name: h.name, plainName: h.plainName })) },
  );
  check(
    'house colour scheme indices are small distinct integers for the two players',
    new Set(players.map((h) => h.colorIndex)).size === players.length &&
      players.every((h) => h.colorIndex >= 0 && h.colorIndex < 64),
    players.map((h) => ({ index: h.index, colorIndex: h.colorIndex, country: h.country, name: h.name })),
  );

  // ---- MCV at a start waypoint ----
  const mcv = localOf(state0).find((o) => o.kind === 'vehicle' && /^(AMCV|SMCV|PCV)$/.test(o.type));
  check(
    'local MCV exists with an MCV type, owned by the local house',
    !!mcv,
    mcv && { id: mcv.id, type: mcv.type, owner: mcv.owner },
  );
  assert.ok(mcv, 'no MCV');
  // ScenarioClass::Waypoints[0..7] (CellStruct {short X, short Y}, array at +0x632) are the multiplayer start positions.
  const waypoints = await bridge<[number, number][]>(
    `(() => { const s = B.u32(${0xa8b230}); const r = []; for (let i = 0; i < 8; i++) { const v = B.u32(s + 0x632 + i * 4); r.push([(v << 16) >> 16, v >> 16]); } return r; })()`,
  );
  const fileWaypoints = Array.from({ length: 8 }, (_, i) => {
    const raw = waypointsOnDisk?.get(String(i));
    return raw ? [Number(raw) % 1000, Math.floor(Number(raw) / 1000)] : [0, 0];
  });
  check(
    'memory start waypoints 0..7 equal the map file [Waypoints] (file value = Y * 1000 + X)',
    !!waypointsOnDisk && JSON.stringify(waypoints) === JSON.stringify(fileWaypoints),
    { memory: waypoints, file: fileWaypoints },
  );
  const mcvCell = cell(mcv);
  const mcvStart = waypoints.findIndex(([x, y]) => x === mcvCell.x && y === mcvCell.y);
  // The Easy AI usually deploys within the first frames, so its start is its MCV or its construction yard (whose
  // location is the MCV cell - (1, 1), see the deploy check below).
  const aiStartObjects = state0.objects.filter(
    (o) =>
      o.owner !== state0.localHouse &&
      (/^(AMCV|SMCV|PCV)$/.test(o.type) || (o.kind === 'building' && /CNST$/.test(o.type))),
  );
  const aiStarts = aiStartObjects.map((o) => {
    const c = cell(o),
      shift = o.kind === 'building' ? 1 : 0;
    return waypoints.findIndex(([x, y]) => x === c.x + shift && y === c.y + shift);
  });
  check(
    'MCV cell = floor(x/256), floor(y/256) is a start waypoint; the AI starts on a different one',
    mcvStart >= 0 && aiStarts.length === 1 && aiStarts[0]! >= 0 && aiStarts[0] !== mcvStart,
    {
      mcv: { x: mcv.x, y: mcv.y, z: mcv.z, cell: mcvCell, waypoint: mcvStart },
      ai: aiStartObjects.map((o, i) => ({ type: o.type, x: o.x, y: o.y, cell: cell(o), waypoint: aiStarts[i] })),
      startingPointField: houses.map((h) => h.startingPoint),
    },
  );
  // TechnoTypeClass::Turret: turreted tanks report a turret facing, infantry/MCV/harvesters do not.
  const turretTypes = new Map<string, boolean>();
  for (const o of state0.objects) if (o.kind !== 'building') turretTypes.set(o.type, o.turretFacing !== undefined);
  const knownTurret = /^(MTNK|HTNK|LTNK)$/;
  const knownNoTurret =
    /^(AMCV|SMCV|PCV|CMIN|HARV|SMIN|E1|E2|INIT|GGI|CAR|BUS|TAXI|SUVB|SUVW|STANG|PTRUCK|CONA|TRUCKA|TRUCKB|PICK)$/;
  check(
    'turretFacing present for Turret=yes types (MTNK/HTNK/LTNK) and absent for MCVs, harvesters, infantry, civilian cars',
    [...turretTypes].some(([type]) => knownTurret.test(type)) &&
      [...turretTypes].every(([type, turret]) =>
        knownTurret.test(type) ? turret : knownNoTurret.test(type) ? !turret : true,
      ),
    Object.fromEntries(turretTypes),
  );
  log('local house', { country: houses.find((h) => h.isLocal)?.country, mcvType: mcv.type });
  await overlayShot('overlay-01-start', state0, [mcv.id]);

  // ---- Start the 30 Hz poll ----
  await bridge(`B.startPoll(${hz}, 5000)`);
  const pollStartedAt = Date.now();
  await bridge(`B.track([${mcv.id}])`);

  // ---- Deploy the MCV ----
  await park();
  let selected = false;
  for (let attempt = 0; attempt < 4 && !selected; attempt++) {
    const s = (await readState())!;
    const now = s.objects.find((o) => o.id === mcv.id)!;
    const p = project(s, now.x, now.y, now.z);
    await clickSurface(p.x, p.y + attempt * 3);
    await page.waitForTimeout(500);
    selected = !!(await readState())!.objects.find((o) => o.id === mcv.id)?.isSelected;
  }
  const afterSelect = (await readState())!;
  check(
    'isSelected: clicking the MCV selects exactly it',
    selected && afterSelect.objects.filter((o) => o.isSelected).length === 1,
    {
      selected: afterSelect.objects.filter((o) => o.isSelected).map((o) => o.type),
    },
  );
  await pressKey('d');
  const yard = await waitFor(
    'construction yard',
    async () => {
      const s = await readState();
      const conyard = s?.objects.find((o) => o.kind === 'building' && o.owner === s.localHouse && /CNST$/.test(o.type));
      return conyard && !s!.objects.some((o) => o.id === mcv.id) ? { s: s!, conyard } : null;
    },
    60_000,
  ).catch(() => null);
  if (yard) {
    const c = cell(yard.conyard);
    check(
      'deploy: MCV disappears and a construction yard of the local house appears at the MCV spot (within 2 cells)',
      Math.abs(c.x - mcvCell.x) <= 2 && Math.abs(c.y - mcvCell.y) <= 2,
      {
        conyard: {
          id: yard.conyard.id,
          type: yard.conyard.type,
          x: yard.conyard.x,
          y: yard.conyard.y,
          z: yard.conyard.z,
          cell: c,
          health: yard.conyard.health,
        },
        mcvCell,
        offsetLeptons: { dx: yard.conyard.x - mcv.x, dy: yard.conyard.y - mcv.y },
      },
    );
    writeFileSync(join(out, 'state-after-deploy.json'), JSON.stringify(yard.s, null, 1));
    await overlayShot('overlay-02-deployed', yard.s, [yard.conyard.id]);
  } else
    check(
      'deploy: construction yard appeared',
      false,
      (await readState())?.objects.filter((o) => o.owner === state0.localHouse).map((o) => o.type),
    );

  // ---- Movement and facing ----
  // Clicks must land on the tactical view: the page's own control panel overlays the left edge of the canvas and the
  // native sidebar/tab bar occupy the right and bottom edges, so only pick a tank projecting well inside.
  const surfaceSize = (await bridge<Env>('B.env()'))!.surface!;
  const safe = (p: { x: number; y: number }) =>
    p.x >= 330 && p.y >= 200 && p.x <= surfaceSize.width - 350 && p.y <= surfaceSize.height - 220;
  const pickTank = (s: YrState) =>
    localOf(s)
      .filter((o) => o.kind === 'vehicle' && o.turretFacing !== undefined && !/MCV$/.test(o.type))
      .filter((o) => safe(project(s, o.x, o.y, o.z)))
      .sort((a, b) => b.health - a.health)[0];
  const tank = pickTank((await readState())!);
  const moves: unknown[] = [];
  if (tank) {
    await bridge(`B.track([${tank.id}])`);
    log('moving tank', { id: tank.id, type: tank.type });
    // Screen-space directions: right, down, left, up; each converted to a world target 5 cells away.
    for (const [name, sx, sy] of [
      ['screen-right', 1, 0],
      ['screen-down', 0, 1],
      ['screen-left', -1, 0],
      ['screen-up', 0, -1],
    ] as const) {
      await park();
      const s = (await readState())!;
      const now = s.objects.find((o) => o.id === tank.id);
      if (!now) break;
      const p = project(s, now.x, now.y, now.z);
      let ok = now.isSelected;
      for (let attempt = 0; attempt < 3 && !ok; attempt++) {
        const s2 = (await readState())!;
        const n2 = s2.objects.find((o) => o.id === tank.id)!;
        const p2 = project(s2, n2.x, n2.y, n2.z);
        await clickSurface(p2.x, p2.y - 4 + attempt * 4);
        await page.waitForTimeout(400);
        ok = !!(await readState())!.objects.find((o) => o.id === tank.id)?.isSelected;
      }
      const distance = 150;
      const before = (await readState())!.frame;
      await clickSurface(p.x + sx * distance, p.y + sy * distance * 0.75);
      await page.waitForTimeout(9000);
      const s3 = (await readState())!;
      const n3 = s3.objects.find((o) => o.id === tank.id);
      moves.push({
        name,
        selected: ok,
        fromFrame: before,
        toFrame: s3.frame,
        from: { x: now.x, y: now.y },
        to: n3 && { x: n3.x, y: n3.y, facing: n3.facing },
      });
      log('move', moves.at(-1));
    }
    const last = (await readState())!;
    await overlayShot('overlay-03-after-moves', last, [tank.id]);

    // ---- Turret: force-fire at ground perpendicular to the body ----
    const now = last.objects.find((o) => o.id === tank.id);
    if (now) {
      const bodyFacing = now.facing;
      // Try both perpendicular sides; a ground click is only an order when it lands on the tactical view.
      let s = last,
        n = now,
        targetWorld = { x: now.x, y: now.y },
        attempts = 0;
      for (const side of [64, 192]) {
        const a = (((bodyFacing + side) % 256) / 256) * Math.PI * 2;
        // Aim at the centre of the cell 3.5 cells away: the game resolves a force-fire click to a cell, so a point on a
        // cell corner (the 45-degree case lands 6 leptons from one) can pick a neighbouring cell and a different angle.
        const centre = (v: number) => Math.floor(v / 256) * 256 + 128;
        const candidate = { x: centre(now.x + Math.sin(a) * 3.5 * 256), y: centre(now.y - Math.cos(a) * 3.5 * 256) };
        const current = (await readState())!;
        const tp = project(current, candidate.x, candidate.y, now.z);
        if (!safe(tp)) continue;
        attempts++;
        targetWorld = candidate;
        const self = current.objects.find((o) => o.id === tank.id)!;
        if (!self.isSelected) {
          const p = project(current, self.x, self.y, self.z);
          await clickSurface(p.x, p.y);
          await page.waitForTimeout(400);
        }
        await clickSurface(tp.x, tp.y, ['Control']);
        await page.waitForTimeout(2500);
        s = (await readState())!;
        n = s.objects.find((o) => o.id === tank.id)!;
        if (n.turretFacing !== undefined && facingDelta(n.turretFacing, n.facing) >= 40) break;
        await pressKey('s');
      }
      const expectedTurret = worldVectorToFacing(targetWorld.x - n.x, targetWorld.y - n.y);
      const turretCheck = {
        attempts,
        bodyBefore: bodyFacing,
        bodyAfter: n.facing,
        turret: n.turretFacing,
        expectedTurret: Math.round(expectedTurret),
        turretError: n.turretFacing === undefined ? null : facingDelta(n.turretFacing, expectedTurret),
        positionMoved: Math.hypot(n.x - now.x, n.y - now.y),
      };
      check(
        'turretFacing: force-fire to the side turns the turret towards the target (<= 12/256) while the body stays (<= 8/256)',
        turretCheck.turretError !== null &&
          turretCheck.turretError <= 12 &&
          facingDelta(n.facing, bodyFacing) <= 8 &&
          facingDelta(n.turretFacing!, n.facing) >= 40,
        turretCheck,
      );
      await overlayShot('overlay-04-turret', s, [tank.id]);
      await pressKey('s');

      // ---- Health: force-fire at one of our own vehicles and watch Health/Strength drop ----
      await page.waitForTimeout(500);
      const s4 = (await readState())!;
      const shooter = s4.objects.find((o) => o.id === tank.id)!;
      const victim = localOf(s4)
        .filter((o) => o.kind === 'vehicle' && o.id !== tank.id && o.health === 1 && !/MCV$/.test(o.type))
        .filter((o) => safe(project(s4, o.x, o.y, o.z)))
        .sort((a, b) => Math.hypot(a.x - shooter.x, a.y - shooter.y) - Math.hypot(b.x - shooter.x, b.y - shooter.y))[0];
      if (victim) {
        await bridge(`B.track([${victim.id}])`);
        if (!shooter.isSelected) {
          const p = project(s4, shooter.x, shooter.y, shooter.z);
          await clickSurface(p.x, p.y);
          await page.waitForTimeout(400);
        }
        const vp = project(s4, victim.x, victim.y, victim.z);
        await clickSurface(vp.x, vp.y, ['Control']);
        const hit = await waitFor(
          'victim damaged',
          async () => {
            const v = await bridge<(YrObjectState & { raw: { hp: number; strength: number } }) | null>(
              `B.objectWithRaw(${victim.id})`,
            );
            return v && v.health < 1 ? v : null;
          },
          20_000,
        ).catch(() => null);
        await pressKey('s');
        const after = (await readState())?.objects.find((o) => o.id === victim.id);
        check(
          'health: a friendly vehicle hit by force-fire drops below 1, equal to raw Health (+0x6C) / Strength (type+0xA0)',
          !!hit &&
            hit.raw.strength > 0 &&
            hit.raw.hp > 0 &&
            hit.raw.hp < hit.raw.strength &&
            hit.health === hit.raw.hp / hit.raw.strength,
          {
            victim: victim.type,
            before: victim.health,
            hit: hit?.health ?? null,
            raw: hit?.raw ?? null,
            later: after?.health ?? 'destroyed',
          },
        );
      } else
        check(
          'health: a friendly vehicle to damage was on screen',
          false,
          localOf(s4).map((o) => o.type),
        );
    }
  } else
    check(
      'a turreted local vehicle exists for the movement test',
      false,
      localOf((await readState())!).map((o) => o.type),
    );
  report.moves = moves;

  // ---- Keep polling for the full window ----
  for (;;) {
    const elapsed = (Date.now() - pollStartedAt) / 1000;
    if (elapsed >= pollSeconds) break;
    await page.waitForTimeout(Math.min(10_000, (pollSeconds - elapsed) * 1000));
    const summary = await bridge<Record<string, unknown>>('B.pollSummary()');
    log('poll progress', {
      elapsed: Math.round(elapsed),
      polls: summary?.polls,
      errors: (summary?.errors as unknown[])?.length,
    });
  }
  await bridge('B.stopPoll()');
  const final = (await readState())!;
  await overlayShot('overlay-05-end', final);
  writeFileSync(join(out, 'state-final.json'), JSON.stringify(final, null, 1));

  const summary = (await bridge<Record<string, any>>('B.pollSummary()'))!;
  const tracks = (await bridge<Record<string, TrackPoint[]>>('B.pollTracks()'))!;
  const snapshots = await bridge<unknown[]>('B.pollSnapshots()');
  writeFileSync(join(out, 'tracks.json'), JSON.stringify(tracks));
  writeFileSync(join(out, 'snapshots.json'), JSON.stringify(snapshots));
  const costs = [...(summary.costs as number[])].sort((a, b) => a - b);
  const q = (p: number) => costs[Math.min(costs.length - 1, Math.floor(p * costs.length))]!;
  const counts = summary.objectCounts as number[];
  const perf = {
    polls: summary.polls,
    elapsedS: summary.elapsedMs / 1000,
    achievedHz: summary.polls / (summary.elapsedMs / 1000),
    costMs: {
      mean: costs.reduce((a, b) => a + b, 0) / costs.length,
      p50: q(0.5),
      p95: q(0.95),
      p99: q(0.99),
      max: costs.at(-1),
    },
    objects: {
      min: Math.min(...counts),
      max: Math.max(...counts),
      mean: counts.reduce((a, b) => a + b, 0) / counts.length,
    },
  };
  const { costs: _c, objectCounts: _o, ...rest } = summary;
  report.poll = { ...rest, perf };
  check(
    `polled >= ${pollSeconds}s at ~${hz} Hz without exceptions or null reads`,
    summary.errors.length === 0 && summary.nulls === 0 && perf.elapsedS >= pollSeconds - 1,
    {
      polls: summary.polls,
      errors: summary.errors.slice(0, 5),
      nulls: summary.nulls,
      elapsedS: perf.elapsedS,
      achievedHz: perf.achievedHz,
    },
  );
  check('per-kind objects + limbo + invalid == DynamicVector count, every poll', summary.kindMismatch === 0, {
    kindMismatch: summary.kindMismatch,
  });
  check('technos vector count == sum of the four kind vectors, every poll', summary.technoMismatch === 0, {
    technoMismatch: summary.technoMismatch,
  });
  check(
    'no invalid entries (vtable/type/pointer/coordinate validation never rejected a live object)',
    summary.invalid === 0,
    { invalid: summary.invalid, limbo: summary.limbo },
  );
  check(
    'every object owner resolves to a house; uids unique',
    summary.ownerUnknown === 0 && summary.uidDuplicates === 0,
    {
      ownerUnknown: summary.ownerUnknown,
      uidDuplicates: summary.uidDuplicates,
    },
  );
  check(
    'raw Health (object+0x6C) within 0..Strength (type+0xA0 > 0) and health == Health / Strength, every object every poll',
    summary.rawHealthChecked > 0 && summary.rawHealthOutOfRange === 0 && summary.healthRatioMismatch === 0,
    {
      rawHealthChecked: summary.rawHealthChecked,
      rawHealthOutOfRange: summary.rawHealthOutOfRange,
      healthRatioMismatch: summary.healthRatioMismatch,
      zeroHealth: summary.zeroHealth,
      damagedExamples: summary.rawHealthExamples,
    },
  );
  check('facings in 0..255', summary.facingOutOfRange === 0, { facingOutOfRange: summary.facingOutOfRange });
  check('frame counter never goes backwards', summary.frames.backwards === 0, summary.frames);

  // ---- Facing vs movement direction over every tracked mobile object ----
  const samples: { kind: string; motion: number; facing: number }[] = [];
  for (const points of Object.values(tracks)) {
    let anchor = points[0];
    for (const p of points.slice(1)) {
      if (!anchor) break;
      const dx = p.x - anchor.x,
        dy = p.y - anchor.y,
        dz = p.z - anchor.z;
      const distance = Math.hypot(dx, dy);
      if (distance > 512) {
        anchor = p; // teleport/deploy/reinforcement drop: not a movement step
        continue;
      }
      if (distance >= 96 && Math.abs(dz) < 40 && p.frame > anchor.frame && facingDelta(p.facing, anchor.facing) <= 4) {
        samples.push({ kind: p.kind, motion: worldVectorToFacing(dx, dy), facing: p.facing });
        anchor = p;
      }
    }
  }
  const fit = (sign: number, offset: number) => {
    const errors = samples.map((s) => facingDelta((sign * s.motion + offset + 512) % 256, s.facing));
    errors.sort((a, b) => a - b);
    return {
      sign,
      offset,
      median: errors[Math.floor(errors.length / 2)] ?? null,
      p90: errors[Math.floor(errors.length * 0.9)] ?? null,
    };
  };
  const fits = [1, -1].flatMap((sign) => Array.from({ length: 256 }, (_, offset) => fit(sign, offset)));
  fits.sort((a, b) => (a.median ?? 999) - (b.median ?? 999) || (a.p90 ?? 999) - (b.p90 ?? 999));
  const identity = fit(1, 0);
  report.facing = {
    samples: samples.length,
    byKind: Object.fromEntries(
      ['vehicle', 'infantry', 'aircraft'].map((k) => [k, samples.filter((s) => s.kind === k).length]),
    ),
    best: fits.slice(0, 3),
    identity,
  };
  check(
    'facing = direction of motion: best fit is sign +1, offset 0 (0 = -Y north, 64 = +X east), median error <= 3/256',
    samples.length >= 20 &&
      fits[0]!.sign === 1 &&
      facingDelta(fits[0]!.offset, 0) <= 1 &&
      (identity.median ?? 999) <= 3,
    report.facing,
  );
  outcome = checks.every((c) => c.pass) ? 'pass' : 'fail';
} catch (error) {
  if (outcome !== 'discover')
    outcome = `error: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`;
  log('stopped', outcome);
  await page.screenshot({ path: join(out, 'error.png') }).catch(() => undefined);
} finally {
  report.pageErrors = pageErrors;
  report.outcome = outcome;
  report.finishedAt = new Date().toISOString();
  flush();
  console.log('[bridge] outcome', outcome, `${checks.filter((c) => c.pass).length}/${checks.length} checks passed`);
  await context.close();
  await browser.close();
  if (existsSync(out)) console.log('[bridge] evidence in', out);
}
