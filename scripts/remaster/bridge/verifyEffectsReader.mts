/**
 * Remaster bridge: empirical verification of the read-only YR 1.001 effects reader (src/games/yr/effectsReader.ts).
 *
 * It starts a real YR skirmish through `?start-page=battle` exactly like verifyStateReader.mts (the scratch
 * installation's RA2MD.INI [Skirmish] section picks the map and one Easy AI), loads the reader into the VM thread and:
 *
 * - reads the ambient effects before any combat and checks every anim/bullet/particle-system type pointer against the
 *   engine's own type arrays (AnimTypeClass::Array 0x8B4150, BulletTypeClass::Array 0xA83C80,
 *   ParticleSystemTypeClass::Array 0xA83D68, VoxelAnimTypeClass::Array 0xA8EB28), an independent path to the type;
 * - polls the reader at EFFECTS_HZ in the VM thread for the whole run, timing every call and following every anim,
 *   voxel anim, bullet and particle system by (pointer, UniqueID): first/last sight, type changes, frame progression;
 * - (a) selects the local tanks (right click clears, a click picks one, `T` adds its type) and force-fires
 *   (Ctrl+click) at free ground: fire events must name the selected tanks with frames after the order and the ordered
 *   cell as target, new anims must appear at the target cell, and frames captured in the same VM-thread turn as the
 *   read must change where the new anims project (pixel-change test against a frame taken before the order, with
 *   random control points);
 * - (b) force-fires at a civilian building (>= 2x2 foundation, LegalTarget) until it burns and collapses, which
 *   creates fire, explosion and debris anims around it;
 * - checks from the poll tracks that anims advance and end (disappear) within about End * Rate logic frames, that
 *   bullets leave their firer and close on their target, that attached anims sit on their owner, and that the poll
 *   stays well inside its budget; with EFFECTS_GAME_DIR, type-level fields are compared with artmd.ini/rulesmd.ini.
 *
 * The only guest input is ordinary mouse/keyboard input a player would give (?mouse-lock=0 keeps absolute pointer
 * coordinates). Nothing writes guest memory. Evidence (report.json, captures, overlay PNGs, tracks) goes to
 * EFFECTS_OUT; it contains frames of the original game's art, so keep it outside Git.
 *
 * Usage (development server started with RA2_GAME_ROOT=<scratch root whose ra2/ holds the YR files and the edited INI>):
 *   EFFECTS_OUT=/path EFFECTS_GAME_DIR=<scratch root>/ra2 RA2_BROWSER_ORIGIN=http://127.0.0.1:15185 \
 *     pnpm exec tsx scripts/remaster/bridge/verifyEffectsReader.mts
 * Optional: VM_BROWSER_MODE=worker, EFFECTS_HZ (30), EFFECTS_POLL_S (120), EFFECTS_HEADLESS=0, EFFECTS_DISCOVER=1;
 * EFFECTS_GAME_DIR (the MIX archives) enables the artmd.ini / rulesmd.ini cross-check of type-level fields.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type Page, type Worker } from '@playwright/test';
import { selectDevelopmentGame } from '../../../tests/helpers/selectDevelopmentGame';
import type { YrObjectState, YrState } from '../../../src/games/yr/stateReader';
import { YR_FOUNDATION_SIZES, type YrEffects, type YrPoint3 } from '../../../src/games/yr/effectsReader';

const env = process.env;
const origin = env.RA2_BROWSER_ORIGIN ?? 'http://127.0.0.1:15185';
const out = env.EFFECTS_OUT;
assert.ok(out, 'EFFECTS_OUT (output directory) is required');
mkdirSync(out, { recursive: true });
const mode = env.VM_BROWSER_MODE === 'worker' ? 'worker' : 'main';
const pollSeconds = Number(env.EFFECTS_POLL_S ?? 120);
const hz = Number(env.EFFECTS_HZ ?? 30);
const headless = env.EFFECTS_HEADLESS !== '0';
const discover = env.EFFECTS_DISCOVER === '1';
/** Installation directory holding the MIX archives (artmd.ini / rulesmd.ini cross-check); optional. */
const gameDir = env.EFFECTS_GAME_DIR ?? '';

/** Engine type arrays (YRpp ABSTRACTTYPE_ARRAY facts) used as an independent check of the reader's type pointers. */
const TYPE_ARRAYS = { anim: 0x8b4150, bullet: 0xa83c80, particleSystem: 0xa83d68, voxelAnim: 0xa8eb28 };

/**
 * Installed into the VM thread. Every capture (effects, state, tactical position, view bounds, primary surface) is
 * read in a single turn, so the emulator cannot advance in between. The poll loop runs here too, so its timing is the
 * cost a renderer bridge polling from this thread would pay.
 */
const installer = `(async () => {
  if (globalThis.__effectsBridge) return true;
  const core = () => globalThis.__bridgeCoreGetter?.();
  const c0 = core();
  if (!c0?.shim || !c0.emulator || !c0.source?.executableBytes) return false;
  const effectsModule = await import('/src/games/yr/effectsReader.ts');
  const stateModule = await import('/src/games/yr/stateReader.ts');
  const access = await import('/src/games/shared/memoryAccessor.ts');
  const digest = await crypto.subtle.digest('SHA-256', c0.source.executableBytes);
  const hash = Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
  const accessor = () => { const c = core(); return access.createByteViewAccessor(c.emulator.read_memory(0, c.guestMemoryBytes)); };
  const readEffects = effectsModule.createYrEffectsReader(accessor, hash);
  const readState = stateModule.createYrStateReader(accessor, hash);
  const O = effectsModule.YR_EFFECTS_OFFSETS;
  const b64 = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); };
  /** Members of a DynamicVectorClass of type pointers (types never change during a game). */
  const typeSet = (address) => { const m = accessor(); const items = m.u32(address + 4), n = Math.min(m.u32(address + 0x10), 20000);
    const set = new Set(); for (let i = 0; i < n; i++) set.add(m.u32(items + i * 4)); return set; };
  let typeSets = null;
  const types = () => typeSets ??= { anim: typeSet(${TYPE_ARRAYS.anim}), bullet: typeSet(${TYPE_ARRAYS.bullet}),
    particleSystem: typeSet(${TYPE_ARRAYS.particleSystem}), voxelAnim: typeSet(${TYPE_ARRAYS.voxelAnim}) };
  /** Independent type check: raw type pointer of every entry is a member of the engine's type array. */
  const typeCheck = (m, e) => {
    const t = types(); let checked = 0, bad = [];
    const test = (list, offset, set, kind) => { for (const x of list) { checked++; const p = m.u32(x.id + offset);
      if (!set.has(p) && bad.length < 10) bad.push({ kind, id: x.id, type: x.type, pointer: p }); } };
    test(e.anims, O.animType, t.anim, 'anim'); test(e.bullets, O.bulletType, t.bullet, 'bullet');
    test(e.particleSystems, O.particleSystemType, t.particleSystem, 'particleSystem');
    test(e.voxelAnims, O.voxelAnimType, t.voxelAnim, 'voxelAnim');
    return { checked, bad };
  };
  const B = {
    hash, supported: !!readEffects && !!readState,
    effects: (o) => readEffects ? readEffects(o ?? {}) : null,
    coords: (id) => effectsModule.readYrObjectCoords(accessor(), id),
    state: () => readState ? readState({}) : null,
    u32: (a) => accessor().u32(a), i32: (a) => accessor().i32(a),
    f64(a) { const b = accessor().bytes(a, 8); return b.length === 8 ? new DataView(b.buffer).getFloat64(0, true) : null; },
    typeCounts() { const t = types(); return { anim: t.anim.size, bullet: t.bullet.size, particleSystem: t.particleSystem.size, voxelAnim: t.voxelAnim.size }; },
    env() {
      const c = core(), s = c?.shim; const p = s?.surfaces?.get(s.primarySurface);
      return { phase: c?.currentPhase ?? null, shell: s?.inspectShellPageTitle() ?? null,
        surface: p ? { width: p.width, height: p.height } : null };
    },
    /** One consistent capture: effects (with particle positions), state, tactical position, view bounds, surface. */
    capture(withPixels = true) {
      const c = core(), s = c.shim, m = accessor();
      const effects = readEffects({ particles: true, fireWindow: 90 });
      const state = readState({});
      const tactical = m.u32(${0x887324});
      const p = withPixels ? s.inspectSurface(s.primarySurface) : null;
      return {
        frame: m.i32(${0xa8ed84}), effects, state, typeCheck: effects ? typeCheck(m, effects) : null,
        view: { x: m.i32(tactical + 0xb0), y: m.i32(tactical + 0xb4) },
        viewBounds: [m.i32(${0x886fa0}), m.i32(${0x886fa4}), m.i32(${0x886fa8}), m.i32(${0x886fac})],
        surface: p && { width: p.width, height: p.height, pitch: p.pitch, bpp: p.bpp, pixels: b64(p.pixels) },
      };
    },
    poll: null,
    startPoll(rate) {
      const P = B.poll = { startedAt: performance.now(), polls: 0, errors: [], nulls: 0, costs: [], counts: [],
        invalid: {}, limbo: {}, unresolved: 0, uidDuplicates: 0, typeChecked: 0, typeBad: [], idUidConflicts: 0,
        frames: { first: null, last: null, backwards: 0 }, anims: new Map(), voxels: new Map(), bullets: new Map(),
        systems: new Map(), lasers: new Map(), bolts: new Map(), fires: new Map(), uidOf: new Map(), timer: 0 };
      const cap = 4000;
      const tick = () => {
        const t0 = performance.now(); let e = null;
        try { e = readEffects({ fireWindow: 90 }); } catch (error) { P.errors.push(String(error)); }
        const t1 = performance.now();
        P.polls++; P.costs.push(Math.round((t1 - t0) * 1000) / 1000);
        if (!e) { P.nulls++; return; }
        const t = Math.round(t0 - P.startedAt);
        if (P.frames.first === null) P.frames.first = e.frame;
        if (P.frames.last !== null && e.frame < P.frames.last) P.frames.backwards++;
        P.frames.last = e.frame;
        P.counts.push([e.anims.length, e.voxelAnims.length, e.bullets.length, e.particleSystems.length, e.lasers.length, e.electricBolts.length, e.fires.length]);
        for (const k in e.stats.invalid) P.invalid[k] = (P.invalid[k] ?? 0) + e.stats.invalid[k];
        for (const k in e.stats.limbo) P.limbo[k] = (P.limbo[k] ?? 0) + e.stats.limbo[k];
        P.unresolved += e.stats.unresolved;
        const m = accessor();
        if (P.polls % 3 === 0) { const tc = typeCheck(m, e); P.typeChecked += tc.checked; for (const b of tc.bad) if (P.typeBad.length < 20) P.typeBad.push({ frame: e.frame, ...b }); }
        const uids = new Set();
        for (const a of e.anims) { if (uids.has(a.uid)) P.uidDuplicates++; uids.add(a.uid);
          const known = P.uidOf.get(a.uid); if (known !== undefined && known !== a.id) P.idUidConflicts++; P.uidOf.set(a.uid, a.id); }
        const follow = (map, key, sample, make) => {
          let r = map.get(key);
          if (!r) { if (map.size >= cap) return; r = make(); map.set(key, r); }
          r.last = sample; r.seen++;
          if (r.samples.length < 400) r.samples.push(sample);
        };
        // Attached anims: distance to the owner's raw Location (read independently of the reader's GetCoords path).
        const ownerOffset = (a) => { if (!a.attachedTo) return null; const o = a.attachedTo.id;
          return Math.round(Math.hypot(a.x - m.i32(o + 0x9c), a.y - m.i32(o + 0xa0))); };
        for (const a of e.anims) follow(P.anims, a.id + ':' + a.uid,
          { t, f: e.frame, type: a.type, frame: a.frame, stage: a.stage, n: a.frameCount, loops: a.loopsLeft, rate: a.rate, x: a.x, y: a.y, z: a.z,
            att: a.attachedTo ? a.attachedTo.kind + ':' + a.attachedTo.id + ':' + a.attachedTo.uid : null, off: ownerOffset(a), inv: a.invisible, b: a.buildingAnim, l: a.layer },
          () => ({ id: a.id, uid: a.uid, seen: 0, samples: [], first: { t, f: e.frame } }));
        for (const v of e.voxelAnims) follow(P.voxels, v.id + ':' + v.uid,
          { t, f: e.frame, type: v.type, x: v.x, y: v.y, z: v.z, d: v.duration, r: v.rotation },
          () => ({ id: v.id, uid: v.uid, seen: 0, samples: [], first: { t, f: e.frame } }));
        // Bullets: the firer's raw Location when the bullet is first seen (the source must be at the shooter).
        for (const b of e.bullets) follow(P.bullets, b.id + ':' + b.uid,
          { t, f: e.frame, type: b.type, weapon: b.weapon, warhead: b.warhead, x: b.x, y: b.y, z: b.z, source: b.source, target: b.target,
            velocity: b.velocity, firer: b.firer, owner: b.owner, inviso: b.inviso, arcing: b.arcing },
          () => ({ id: b.id, uid: b.uid, seen: 0, samples: [], first: { t, f: e.frame },
            firerAt: b.firer ? { x: m.i32(b.firer.id + 0x9c), y: m.i32(b.firer.id + 0xa0), z: m.i32(b.firer.id + 0xa4) } : null }));
        for (const s of e.particleSystems) follow(P.systems, s.id + ':' + s.uid,
          { t, f: e.frame, type: s.type, behavesLike: s.behavesLike, x: s.x, y: s.y, z: s.z, target: s.target, particles: s.particleCount,
            lifetime: s.lifetime, att: s.attachedTo },
          () => ({ id: s.id, uid: s.uid, seen: 0, samples: [], first: { t, f: e.frame } }));
        for (const l of e.lasers) follow(P.lasers, String(l.id) + ':' + l.source.x + ':' + l.target.x,
          { t, f: e.frame, ...l }, () => ({ id: l.id, seen: 0, samples: [], first: { t, f: e.frame } }));
        for (const b of e.electricBolts) follow(P.bolts, String(b.id) + ':' + b.source.x + ':' + b.target.x,
          { t, f: e.frame, ...b }, () => ({ id: b.id, seen: 0, samples: [], first: { t, f: e.frame } }));
        for (const f of e.fires) { const key = f.id + ':' + f.frame; if (!P.fires.has(key)) P.fires.set(key, { t, pollFrame: e.frame, ...f }); }
      };
      P.timer = setInterval(tick, 1000 / rate);
      return true;
    },
    stopPoll() { if (B.poll) clearInterval(B.poll.timer); return true; },
    pollSummary() {
      const P = B.poll; if (!P) return null;
      const { timer, anims, voxels, bullets, systems, lasers, bolts, fires, uidOf, ...rest } = P;
      return { ...rest, elapsedMs: performance.now() - P.startedAt, tracked: { anims: anims.size, voxels: voxels.size, bullets: bullets.size,
        systems: systems.size, lasers: lasers.size, bolts: bolts.size, fires: fires.size } };
    },
    pollTracks() { const P = B.poll; if (!P) return null;
      return { anims: [...P.anims.values()], voxels: [...P.voxels.values()], bullets: [...P.bullets.values()], systems: [...P.systems.values()],
        lasers: [...P.lasers.values()], bolts: [...P.bolts.values()], fires: [...P.fires.values()] }; },
    burst(n) {
      // performance.now() is coarse (0.1 ms without cross-origin isolation): keep per-call samples for the maximum and
      // the total over n calls for the mean.
      const time = (o) => { const t = []; let last = null; const start = performance.now();
        for (let i = 0; i < n; i++) { const t0 = performance.now(); last = readEffects(o); t.push(performance.now() - t0); }
        return { t, last, mean: (performance.now() - start) / n }; };
      const plain = time({ fireWindow: 90 }), withParticles = time({ fireWindow: 90, particles: true });
      const size = (e) => e ? { anims: e.anims.length, voxelAnims: e.voxelAnims.length, bullets: e.bullets.length, particleSystems: e.particleSystems.length,
        particles: e.particleSystems.reduce((s, p) => s + (p.particles?.length ?? 0), 0), fires: e.fires.length, technos: e.stats.technos } : null;
      return { plain: plain.t, withParticles: withParticles.t, plainMean: plain.mean, withParticlesMean: withParticles.mean, size: size(withParticles.last) };
    },
  };
  globalThis.__effectsBridge = B;
  return true;
})()`;

type Env = { phase: string | null; shell: string | null; surface: { width: number; height: number } | null };
type Surface = { width: number; height: number; pitch: number; bpp: number; pixels: string };
type Capture = {
  frame: number;
  effects: YrEffects | null;
  state: YrState | null;
  typeCheck: { checked: number; bad: unknown[] } | null;
  view: { x: number; y: number };
  viewBounds: [number, number, number, number];
  surface: Surface | null;
};
type AnimSample = {
  t: number;
  f: number;
  type: string;
  frame: number;
  stage: number;
  n: number;
  loops: number;
  rate: number;
  x: number;
  y: number;
  z: number;
  att: string | null;
  off: number | null;
  inv: boolean;
  b: boolean;
  l: string | null;
};
type Track<S> = {
  id: number;
  uid?: number;
  seen: number;
  samples: S[];
  first: { t: number; f: number };
  last: S;
  firerAt?: YrPoint3 | null;
};
type BulletSample = {
  t: number;
  f: number;
  type: string;
  weapon: string | null;
  warhead: string | null;
  x: number;
  y: number;
  z: number;
  source: YrPoint3;
  target: YrPoint3;
  velocity: YrPoint3;
  firer: { id: number; uid: number; kind: string } | null;
  owner: number;
  inviso: boolean;
  arcing: boolean;
};
type Tracks = {
  anims: Track<AnimSample>[];
  voxels: Track<{ t: number; f: number; type: string; x: number; y: number; z: number; d: number }>[];
  bullets: Track<BulletSample>[];
  systems: Track<Record<string, any>>[];
  lasers: Track<Record<string, any>>[];
  bolts: Track<Record<string, any>>[];
  fires: (Record<string, any> & { id: number; frame: number; pollFrame: number; t: number })[];
};

const t0 = Date.now();
const events: { t: number; event: string; detail?: unknown }[] = [];
const log = (event: string, detail?: unknown) => {
  events.push({ t: (Date.now() - t0) / 1000, event, detail });
  console.log(
    `[effects ${((Date.now() - t0) / 1000).toFixed(0)}s] ${event}`,
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
    `(async () => { const B = globalThis.__effectsBridge; if (!B) return null; return ${expression}; })()`,
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

// ---- Projection (YRpp TacticalClass::CoordsToScreen facts, as in verifyShroudReader): 60x30 pixel cells, Z scaled
// by the double at 0xB0CD48; surface = screen - TacticalPos + DSurface::ViewBounds.XY. ----
let zFactor = 0;
const adjustZ = (z: number) => Math.trunc(z * zFactor + (z >= 728 ? 1 : 0) + 0.5);
const toSurface = (c: Pick<Capture, 'view' | 'viewBounds'>, x: number, y: number, z: number) => ({
  x: Math.trunc((30 * x - 30 * y) / 256) - c.view.x + c.viewBounds[0],
  y: Math.trunc((15 * y + 15 * x) / 256) - adjustZ(z) - c.view.y + c.viewBounds[1],
});

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
  for (const key of [...modifiers].reverse()) await page.keyboard.up(key);
}
async function pressKey(key: string) {
  await page.keyboard.down(key);
  await page.waitForTimeout(150);
  await page.keyboard.up(key);
}

const capture = async (withPixels = true) => (await bridge<Capture>(`B.capture(${withPixels})`))!;
const fromB64 = (text: string) => new Uint8Array(Buffer.from(text, 'base64'));
const localOf = (state: YrState) => state.objects.filter((o) => o.owner === state.localHouse);
const dist2 = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);
const dist3 = (a: YrPoint3, b: YrPoint3) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

/** 16-bit RGB565 surface -> function giving 8-bit RGB. */
function pixelReader(surface: Surface) {
  const bytes = fromB64(surface.pixels);
  const px16 = new Uint16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength >> 1);
  const pitch16 = surface.pitch >> 1;
  return (x: number, y: number): [number, number, number] => {
    const v = px16[y * pitch16 + x]!;
    return [((v >> 11) & 31) * 8.226, ((v >> 5) & 63) * 4.048, (v & 31) * 8.226];
  };
}

/**
 * Pixel-change test: fraction of pixels in a (2r+1)^2 box around each projected anim that differ from the reference
 * frame (taken before the order with the same view), compared with random control points away from every effect and
 * every object. Explosions are drawn centred on the anim coordinate, so the boxes must change far more than controls.
 */
function changeTest(reference: Capture, now: Capture, radius = 14) {
  const s = now.surface!,
    r = reference.surface!;
  const a = pixelReader(s),
    b = pixelReader(r);
  const [vx, vy, vw, vh] = now.viewBounds;
  const changedAt = (x: number, y: number) => {
    const p = a(x, y),
      q = b(x, y);
    return Math.abs(p[0] - q[0]) + Math.abs(p[1] - q[1]) + Math.abs(p[2] - q[2]) > 60;
  };
  const boxChange = (cx: number, cy: number) => {
    let n = 0,
      changed = 0;
    for (let y = cy - radius; y <= cy + radius; y++)
      for (let x = cx - radius; x <= cx + radius; x++) {
        if (x < vx || y < vy || x >= vx + vw || y >= vy + vh) continue;
        n++;
        if (changedAt(x, y)) changed++;
      }
    return n ? changed / n : null;
  };
  const inView = (p: { x: number; y: number }) =>
    p.x >= vx + radius && p.y >= vy + radius && p.x < vx + vw - radius && p.y < vy + vh - radius;
  const effects = now.effects!;
  // Only anims created after the reference (ambient ones such as ore twinkles loop with long pauses).
  const before = new Set((reference.effects?.anims ?? []).map((e) => `${e.id}:${e.uid}`));
  const anims = effects.anims
    .filter((e) => !e.invisible && !e.buildingAnim && !before.has(`${e.id}:${e.uid}`))
    .map((e) => ({ e, p: toSurface(now, e.x, e.y, e.z) }))
    .filter(({ p }) => inView(p))
    .map(({ e, p }) => ({ type: e.type, id: e.id, frame: e.frame, sx: p.x, sy: p.y, change: boxChange(p.x, p.y)! }));
  // Controls: random points at least 60 px from every anim, voxel anim, bullet, particle system and object.
  const avoid = [
    ...effects.anims.map((e) => toSurface(now, e.x, e.y, e.z)),
    ...effects.voxelAnims.map((e) => toSurface(now, e.x, e.y, e.z)),
    ...effects.bullets.map((e) => toSurface(now, e.x, e.y, e.z)),
    ...effects.particleSystems.map((e) => toSurface(now, e.x, e.y, e.z)),
    ...(now.state?.objects ?? []).map((o) => toSurface(now, o.x, o.y, o.z)),
    ...(reference.state?.objects ?? []).map((o) => toSurface(reference, o.x, o.y, o.z)),
  ];
  let seed = 7;
  const random = () => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 2 ** 32;
  const controls: number[] = [];
  for (let attempt = 0; attempt < 4000 && controls.length < 200; attempt++) {
    const p = {
      x: Math.floor(vx + radius + random() * (vw - 2 * radius)),
      y: Math.floor(vy + radius + random() * (vh - 2 * radius)),
    };
    if (avoid.some((q) => dist2(p, q) < 60)) continue;
    controls.push(boxChange(p.x, p.y)!);
  }
  const sorted = (values: number[]) => [...values].sort((x, y) => x - y);
  const quantile = (values: number[], q: number) => {
    const v = sorted(values);
    return v.length ? v[Math.min(v.length - 1, Math.floor(q * v.length))]! : null;
  };
  const control90 = quantile(controls, 0.9) ?? 0;
  return {
    anims,
    animsInView: anims.length,
    animMedianChange: quantile(
      anims.map((x) => x.change),
      0.5,
    ),
    controlMedianChange: quantile(controls, 0.5),
    control90,
    animsAboveControl90: anims.length ? anims.filter((x) => x.change > control90).length / anims.length : null,
    controls: controls.length,
  };
}

/** Page-side overlay painter (see overlayPng). */
const DRAW_OVERLAY = `({ w, h, data, shapes, vb, note }) => {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const g = canvas.getContext('2d');
  const bytes = Uint8ClampedArray.from(atob(data), (ch) => ch.charCodeAt(0));
  g.putImageData(new ImageData(bytes, w, h), 0, 0);
  g.font = '10px monospace';
  g.lineWidth = 1;
  const label = (text, x, y, color) => { g.fillStyle = '#000'; g.fillText(text, x + 1, y + 1); g.fillStyle = color; g.fillText(text, x, y); };
  for (const s of shapes.systems) {
    g.strokeStyle = '#8f8'; g.strokeRect(s.x - 6, s.y - 6, 12, 12);
    g.fillStyle = 'rgba(140,255,140,0.7)';
    for (const p of s.particles) g.fillRect(p.x - 1, p.y - 1, 2, 2);
    label(s.label, s.x + 8, s.y + 12, '#8f8');
  }
  for (const l of shapes.lines) { g.strokeStyle = l.color; g.beginPath(); g.moveTo(l.from.x, l.from.y); g.lineTo(l.to.x, l.to.y); g.stroke(); }
  for (const b of shapes.bullets) {
    g.strokeStyle = 'rgba(255,80,80,0.8)'; g.setLineDash([3, 3]);
    g.beginPath(); g.moveTo(b.from.x, b.from.y); g.lineTo(b.to.x, b.to.y); g.stroke(); g.setLineDash([]);
    g.fillStyle = '#f33'; g.fillRect(b.at.x - 3, b.at.y - 3, 6, 6);
    label(b.label, b.at.x + 5, b.at.y - 5, '#f66');
  }
  for (const v of shapes.voxels) {
    g.strokeStyle = '#f0f'; g.beginPath();
    g.moveTo(v.x, v.y - 6); g.lineTo(v.x + 6, v.y); g.lineTo(v.x, v.y + 6); g.lineTo(v.x - 6, v.y); g.closePath(); g.stroke();
    label(v.label, v.x + 7, v.y + 3, '#f8f');
  }
  for (const f of shapes.fires) { g.strokeStyle = '#fff'; g.beginPath(); g.arc(f.x, f.y, 9, 0, Math.PI * 2); g.stroke(); }
  for (const a of shapes.anims) {
    g.strokeStyle = a.color; g.beginPath(); g.arc(a.x, a.y, 4, 0, Math.PI * 2);
    g.moveTo(a.x - 7, a.y); g.lineTo(a.x + 7, a.y); g.moveTo(a.x, a.y - 7); g.lineTo(a.x, a.y + 7); g.stroke();
    label(a.label, a.x + 6, a.y - 6, a.color);
  }
  g.strokeStyle = '#0af'; g.strokeRect(vb[0] + 0.5, vb[1] + 0.5, vb[2] - 1, vb[3] - 1);
  if (note) label(note, vb[0] + 8, vb[1] + 14, '#fff');
  return canvas.toDataURL('image/png');
}`;

/** Frame + effects overlay rendered by the page canvas (anims, voxel anims, bullets, lasers, bolts, systems, fires). */
async function overlayPng(name: string, c: Capture, note = '') {
  const surface = c.surface!;
  const read = pixelReader(surface);
  const rgba = Buffer.alloc(surface.width * surface.height * 4);
  for (let y = 0; y < surface.height; y++)
    for (let x = 0; x < surface.width; x++) {
      const p = read(x, y),
        o = (y * surface.width + x) * 4;
      rgba[o] = p[0];
      rgba[o + 1] = p[1];
      rgba[o + 2] = p[2];
      rgba[o + 3] = 255;
    }
  const e = c.effects!;
  const P = (p: YrPoint3) => toSurface(c, p.x, p.y, p.z);
  const shapes = {
    anims: e.anims.map((a) => ({
      ...P(a),
      label: `${a.type} ${a.frame}/${a.frameCount}${a.attachedTo ? '@' + a.attachedTo.kind : ''}`,
      color: a.invisible ? '#888' : a.buildingAnim ? '#0af' : a.attachedTo ? '#f80' : '#ff0',
    })),
    voxels: e.voxelAnims.map((v) => ({ ...P(v), label: v.type })),
    bullets: e.bullets.map((b) => ({
      at: P(b),
      from: P(b.source),
      to: P(b.target),
      label: `${b.type}/${b.weapon ?? '-'}`,
    })),
    lines: [
      ...e.lasers.map((l) => ({ from: P(l.source), to: P(l.target), color: '#f0f' })),
      ...e.electricBolts.map((l) => ({ from: P(l.source), to: P(l.target), color: '#0ff' })),
    ],
    systems: e.particleSystems.map((s) => ({
      ...P(s),
      label: `${s.type}(${s.particleCount})`,
      particles: (s.particles ?? []).map(P),
    })),
    fires: e.fires
      .map((f) => c.state?.objects.find((o) => o.id === f.id))
      .filter((o): o is YrObjectState => !!o)
      .map((o) => P(o)),
  };
  // The drawing code runs in the page as a string (tsx would otherwise wrap its inner helpers in a `__name` call that
  // does not exist in the page).
  const dataUrl = await page.evaluate(([code, args]) => (0, eval)(code)(args) as string, [
    DRAW_OVERLAY,
    { w: surface.width, h: surface.height, data: rgba.toString('base64'), shapes, vb: c.viewBounds, note },
  ] as const);
  writeFileSync(join(out!, `${name}.png`), Buffer.from(dataUrl.split(',')[1]!, 'base64'));
}

/** Capture JSON without the pixels (the pixels go to a raw .rgb565 file for offline re-analysis). */
function saveCapture(name: string, c: Capture) {
  const { surface, ...rest } = c;
  if (surface)
    writeFileSync(
      join(out!, `${name}.${surface.width}x${surface.height}p${surface.pitch}.rgb565`),
      fromB64(surface.pixels),
    );
  writeFileSync(join(out!, `${name}.json`), JSON.stringify(rest));
}

/**
 * artmd.ini and rulesmd.ini from the player's own MIX archives, read with the fork's own parser (computed import
 * specifier as in verifyStateReader), as case-insensitive section maps. Null when EFFECTS_GAME_DIR is not set.
 */
async function loadGameIni(): Promise<Record<'art' | 'rules', Map<string, Map<string, string>>> | null> {
  if (!gameDir) return null;
  try {
    const specifier = ['..', '..', '..', 'packages', 'ra2-formats', 'src', 'index.ts'].join('/');
    const { Vfs } = (await import(specifier)) as {
      Vfs: new () => {
        mountData(data: Uint8Array): unknown;
        mountNested(outer: unknown, name: string): unknown;
        openFile(name: string): Uint8Array | undefined;
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
    const parse = (name: string) => {
      const bytes = vfs.openFile(name);
      const sections = new Map<string, Map<string, string>>();
      if (!bytes) return sections;
      let current: Map<string, string> | null = null;
      for (const raw of new TextDecoder('latin1').decode(bytes).split(/\r?\n/)) {
        const line = raw.replace(/;.*$/, '').trim();
        const header = line.match(/^\[(.+)\]$/);
        if (header) {
          const key = header[1]!.toLowerCase();
          current = sections.get(key) ?? new Map();
          sections.set(key, current);
        } else if (current && line.includes('=')) {
          const at = line.indexOf('=');
          current.set(line.slice(0, at).trim().toLowerCase(), line.slice(at + 1).trim());
        }
      }
      return sections;
    };
    return { art: parse('artmd.ini'), rules: parse('rulesmd.ini') };
  } catch (error) {
    log('INI lookup failed', String(error));
    return null;
  }
}

/**
 * Type-level cross-check against the INI data the engine loaded: every key present in the INI must match what the
 * reader reports (AnimTypeClass Start/LoopStart/LoopEnd/Translucent/Flat/Layer/LoopCount, BulletTypeClass
 * Arcing/Inviso, ParticleSystemTypeClass BehavesLike), which checks those offsets independently of the disassembly.
 */
function iniCrossCheck(ini: NonNullable<Awaited<ReturnType<typeof loadGameIni>>>, all: Capture[]) {
  const yes = (v: string) => /^(yes|true|1)/i.test(v);
  const results: { kind: string; type: string; key: string; ini: string; reader: unknown; ok: boolean }[] = [];
  const seen = new Set<string>();
  const add = (
    kind: string,
    type: string,
    key: string,
    iniValue: string | undefined,
    reader: unknown,
    ok: (v: string) => boolean,
  ) => {
    if (iniValue === undefined || seen.has(`${kind}:${type}:${key}`)) return;
    seen.add(`${kind}:${type}:${key}`);
    results.push({ kind, type, key, ini: iniValue, reader, ok: ok(iniValue) });
  };
  for (const c of all) {
    for (const a of c.effects?.anims ?? []) {
      const art = ini.art.get(a.type.toLowerCase());
      if (!art) continue;
      add('anim', a.type, 'Start', art.get('start'), a.frame - a.stage, (v) => Number(v) === a.frame - a.stage);
      add('anim', a.type, 'LoopStart', art.get('loopstart'), a.loopStart, (v) => Number(v) === a.loopStart);
      add('anim', a.type, 'LoopEnd', art.get('loopend'), a.loopEnd, (v) => Number(v) === a.loopEnd);
      add('anim', a.type, 'Translucent', art.get('translucent'), a.translucent, (v) => yes(v) === a.translucent);
      add('anim', a.type, 'Flat', art.get('flat'), a.flat, (v) => yes(v) === a.flat);
      if (!a.attachedTo) add('anim', a.type, 'Layer', art.get('layer'), a.layer, (v) => v.toLowerCase() === a.layer);
      add('anim', a.type, 'LoopCount', art.get('loopcount'), a.loopsLeft, (v) =>
        Number(v) === -1 ? a.loopsLeft === 255 : a.loopsLeft >= 1 && a.loopsLeft <= Number(v),
      );
    }
    for (const b of c.effects?.bullets ?? []) {
      const rules = ini.rules.get(b.type.toLowerCase());
      if (!rules) continue;
      add('bullet', b.type, 'Arcing', rules.get('arcing'), b.arcing, (v) => yes(v) === b.arcing);
      add('bullet', b.type, 'Inviso', rules.get('inviso'), b.inviso, (v) => yes(v) === b.inviso);
    }
    for (const p of c.effects?.particleSystems ?? []) {
      const rules = ini.rules.get(p.type.toLowerCase());
      add(
        'particleSystem',
        p.type,
        'BehavesLike',
        rules?.get('behaveslike'),
        p.behavesLike,
        (v) => v.toLowerCase() === p.behavesLike,
      );
    }
  }
  return results;
}

let outcome = 'incomplete';
try {
  await page.goto(`${origin}/?start-page=battle&mouse-lock=0${mode === 'main' ? '&vm-worker=0' : ''}`);
  await selectDevelopmentGame(page, 'yr');
  await waitFor('bridge installed', async () => (await target().evaluate(installer)) === true, 300_000);
  const supported = await bridge<boolean>('B.supported');
  check(
    'reader factory accepts the pinned YR 1.001 image (hash + GetCoords slots + vtables)',
    supported,
    await bridge('B.hash'),
  );
  assert.ok(supported, 'reader unsupported');

  const battle = await waitFor(
    'battlefield',
    async () => {
      const [env, state] = (await bridge<[Env, YrState | null]>('[B.env(), B.state()]')) ?? [];
      return env?.phase === 'running' && env.shell === '' && state && state.localHouse >= 0 && state.objects.length > 0
        ? state
        : null;
    },
    900_000,
  );
  const firstFrame = battle.frame;
  await waitFor(
    'simulation advancing',
    async () => ((await bridge<YrState>('B.state()'))?.frame ?? 0) > firstFrame + 60,
    120_000,
  );
  zFactor = (await bridge<number>(`B.f64(${0xb0cd48})`)) ?? 0;
  const typeCounts = await bridge<Record<string, number>>('B.typeCounts()');
  log('battlefield', { frame: battle.frame, map: battle.map, zFactor, typeCounts });

  // ---- Ambient effects before any combat ----
  await park();
  await page.waitForTimeout(1000);
  const c0 = await capture();
  saveCapture('capture-00-ambient', c0);
  await overlayPng('overlay-00-ambient', c0, 'ambient (before combat)');
  const e0 = c0.effects!;
  report.ambient = {
    frame: e0.frame,
    counts: {
      anims: e0.anims.length,
      voxelAnims: e0.voxelAnims.length,
      bullets: e0.bullets.length,
      particleSystems: e0.particleSystems.length,
      lasers: e0.lasers.length,
      electricBolts: e0.electricBolts.length,
    },
    animTypes: Object.entries(
      e0.anims.reduce<Record<string, number>>((m, a) => ((m[a.type] = (m[a.type] ?? 0) + 1), m), {}),
    ).sort((a, b) => b[1] - a[1]),
    stats: e0.stats,
    typeCheck: c0.typeCheck,
  };
  log('ambient effects', report.ambient);
  check(
    'ambient read: every type pointer is a member of the engine type arrays; no invalid entries',
    !!c0.typeCheck &&
      c0.typeCheck.bad.length === 0 &&
      Object.values(e0.stats.invalid).every((n) => n === 0) &&
      e0.stats.unresolved === 0 &&
      Object.values(typeCounts).every((n) => n > 0),
    { typeCheck: c0.typeCheck, invalid: e0.stats.invalid, unresolved: e0.stats.unresolved, typeCounts },
  );
  if (discover) {
    writeFileSync(join(out, 'discover-effects.json'), JSON.stringify(e0, null, 1));
    outcome = 'discover';
    throw new Error('discover mode');
  }

  // ---- Poll for the rest of the run ----
  await bridge(`B.startPoll(${hz})`);
  const pollStartedAt = Date.now();

  // ---- (a) Select the local tanks and force-fire at open ground ----
  const [vbx, vby, vbw, vbh] = c0.viewBounds;
  // The page's own control panel overlays the left of the canvas; keep clicks right of it and inside the view.
  const safe = (p: { x: number; y: number }, margin = 60) =>
    p.x >= vbx + margin + 200 && p.y >= vby + margin && p.x <= vbx + vbw - margin && p.y <= vby + vbh - margin;
  const selectTanks = async () => {
    // Right-click clears the selection, a click selects one tank, `T` adds every unit of its type on screen.
    const clear = await canvasPoint(vbx + vbw * 0.7, vby + vbh * 0.35);
    await page.mouse.move(clear.x, clear.y);
    await page.waitForTimeout(200);
    await page.mouse.down({ button: 'right' });
    await page.waitForTimeout(150);
    await page.mouse.up({ button: 'right' });
    await page.waitForTimeout(300);
    const c = await capture(false);
    const tank = localOf(c.state!)
      .filter((o) => o.kind === 'vehicle' && o.turretFacing !== undefined && !/MCV$/.test(o.type))
      .map((o) => ({ o, p: toSurface(c, o.x, o.y, o.z) }))
      .find(({ p }) => safe(p));
    if (!tank) return [];
    await clickSurface(tank.p.x, tank.p.y);
    await pressKey('t');
    await page.waitForTimeout(300);
    return (await capture(false)).state!.objects.filter((o) => o.isSelected && o.owner === c.state!.localHouse);
  };
  const shooters = await selectTanks();
  log(
    'selected',
    shooters.map((o) => ({ id: o.id, type: o.type })),
  );
  check(
    'selection: the local tanks are selected (click + T), nothing else',
    shooters.length >= 2 && shooters.every((o) => o.turretFacing !== undefined && o.kind === 'vehicle'),
    shooters.map((o) => o.type),
  );
  assert.ok(shooters.length > 0, 'no local tank selected');
  const shooterIds = new Set(shooters.map((o) => o.id));
  const s1 = (await capture(false)).state!;
  // Ground target: a free cell 5..8 cells from the group centre (no object within 2 cells, so friendly splash is
  // impossible), inside the safe part of the view.
  const centre = {
    x: shooters.reduce((s, o) => s + o.x, 0) / shooters.length,
    y: shooters.reduce((s, o) => s + o.y, 0) / shooters.length,
  };
  let groundTarget: { x: number; y: number; z: number } | null = null;
  for (let ring = 5; ring <= 8 && !groundTarget; ring++)
    for (let k = 0; k < 24 && !groundTarget; k++) {
      const angle = (k / 24) * Math.PI * 2;
      const cell = {
        x: Math.floor((centre.x + Math.cos(angle) * ring * 256) / 256) * 256 + 128,
        y: Math.floor((centre.y + Math.sin(angle) * ring * 256) / 256) * 256 + 128,
        z: shooters[0]!.z,
      };
      if (!safe(toSurface(c0, cell.x, cell.y, cell.z), 120)) continue;
      if (s1.objects.some((o) => Math.hypot(o.x - cell.x, o.y - cell.y) < 512)) continue;
      groundTarget = cell;
    }
  assert.ok(groundTarget, 'no free ground target in view');
  const reference = await capture();
  const orderFrame = reference.frame;
  const tp = toSurface(reference, groundTarget.x, groundTarget.y, groundTarget.z);
  await clickSurface(tp.x, tp.y, ['Control']);
  await park();
  log('force-fire at ground ordered', { orderFrame, target: groundTarget, surface: tp, shooters: shooters.length });
  const captures: Capture[] = [];
  for (let i = 0; i < 18; i++) {
    await page.waitForTimeout(350);
    captures.push(await capture());
  }
  await pressKey('s');
  // The captures with the most combat anims near the target are the most informative ones.
  const nearTarget = (c: Capture) =>
    c.effects!.anims.filter(
      (a) => !a.buildingAnim && Math.hypot(a.x - groundTarget!.x, a.y - groundTarget!.y) < 3 * 256,
    ).length;
  const ranked = captures
    .map((c, i) => ({ c, i, n: nearTarget(c) }))
    .filter(({ c }) => c.view.x === reference.view.x && c.view.y === reference.view.y)
    .sort((a, b) => b.n - a.n);
  const tests = ranked.slice(0, 4).map(({ c, i }) => ({ i, frame: c.frame, test: changeTest(reference, c) }));
  saveCapture('capture-01-reference', reference);
  await overlayPng('overlay-01-reference', reference, `reference before the order, frame ${reference.frame}`);
  for (const [k, { c, i }] of ranked.slice(0, 4).entries()) {
    saveCapture(`capture-02-ground-${k}`, c);
    await overlayPng(
      `overlay-02-ground-${k}`,
      c,
      `force-fire ground +${((i + 1) * 0.35).toFixed(2)}s frame ${c.frame}`,
    );
  }
  report.groundFire = {
    target: groundTarget,
    orderFrame,
    captures: captures.map((c) => ({ frame: c.frame, anims: c.effects!.anims.length, nearTarget: nearTarget(c) })),
    changeTests: tests.map(({ i, frame, test }) => ({ i, frame, ...test, anims: test.anims.slice(0, 40) })),
  };
  const newNear = new Map<string, { type: string; distanceCells: number; frame: number }>();
  for (const c of captures)
    for (const a of c.effects!.anims) {
      const d = Math.hypot(a.x - groundTarget.x, a.y - groundTarget.y) / 256;
      if (!a.buildingAnim && d < 1 && !newNear.has(`${a.id}:${a.uid}`))
        newNear.set(`${a.id}:${a.uid}`, { type: a.type, distanceCells: d, frame: c.frame });
    }
  check('force-fire at ground: new anims appear within 1 cell of the target cell within 6 s', newNear.size >= 2, {
    count: newNear.size,
    anims: [...newNear.values()].slice(0, 20),
  });
  const fireEvents = captures
    .flatMap((c) => c.effects!.fires)
    .filter((f) => shooterIds.has(f.id) && f.frame >= orderFrame);
  const firedIds = new Set(fireEvents.map((f) => f.id));
  const targetErrors = fireEvents
    .filter((f) => f.targetPosition)
    .map((f) => Math.hypot(f.targetPosition!.x - groundTarget!.x, f.targetPosition!.y - groundTarget!.y));
  check(
    'fire events: the selected tanks report LastFireBulletFrame after the order, aimed at the ordered cell (<= 0.5 cell)',
    firedIds.size >= Math.min(2, shooters.length) &&
      targetErrors.length > 0 &&
      targetErrors.every((d) => d <= 128) &&
      fireEvents.every((f) => f.target?.kind === 'cell'),
    {
      shooters: shooters.length,
      fired: firedIds.size,
      events: fireEvents.length,
      targetErrorLeptons: targetErrors.length ? [Math.min(...targetErrors), Math.max(...targetErrors)] : null,
      sample: fireEvents.slice(0, 3),
    },
  );
  const best = tests[0]?.test;
  check(
    'frame overlay: pixels around projected combat anims changed far more than around random control points (median >= 3x control median + 0.1, >= 70% of anims above the control 90th percentile)',
    !!best &&
      best.animsInView >= 2 &&
      (best.animMedianChange ?? 0) >= 3 * (best.controlMedianChange ?? 0) + 0.1 &&
      (best.animsAboveControl90 ?? 0) >= 0.7,
    tests.map(({ i, frame, test }) => ({
      i,
      frame,
      animsInView: test.animsInView,
      animMedianChange: test.animMedianChange,
      controlMedianChange: test.controlMedianChange,
      control90: test.control90,
      animsAboveControl90: test.animsAboveControl90,
    })),
  );

  // ---- (b) Force-fire at a civilian building until it burns and collapses ----
  await page.waitForTimeout(1000);
  const s2 = (await capture(false)).state!;
  const neutral = new Set(
    s2.houses.filter((h) => h.country === 'Neutral' || h.country === 'Special').map((h) => h.index),
  );
  // Civilian buildings with a foundation of at least 2x2 cells (a click on a small prop's centre lands on its cell,
  // which force-fires at the ground instead) that are legal targets (ObjectTypeClass::LegalTarget +0x231), nearest to
  // the tanks first; the first one the tanks actually aim at (TechnoClass::Target +0x2B4) is used.
  const candidates: { o: YrObjectState; centre: YrPoint3 }[] = [];
  for (const o of s2.objects.filter((o) => o.kind === 'building' && neutral.has(o.owner) && !/^CAOIL/.test(o.type))) {
    const type = await bridge<number>(`B.u32(${o.id} + 0x520)`);
    const legal = await bridge<number>(`(B.u32(${type} + 0x230) >> 8) & 0xff`);
    const size = YR_FOUNDATION_SIZES[await bridge<number>(`B.i32(${type} + 0xef0)`)] ?? [0, 0];
    const centreOf = await bridge<YrPoint3 | null>(`B.coords(${o.id})`);
    if (legal && size[0] * size[1] >= 4 && centreOf && safe(toSurface(c0, centreOf.x, centreOf.y, centreOf.z), 90))
      candidates.push({ o, centre: centreOf });
  }
  candidates.sort((a, b) => dist2(a.centre, centre) - dist2(b.centre, centre));
  let victim: (typeof candidates)[number] | undefined;
  for (const candidate of candidates.slice(0, 4)) {
    const again = await selectTanks();
    const c3 = await capture(false);
    const vp = toSurface(c3, candidate.centre.x, candidate.centre.y, candidate.centre.z);
    await clickSurface(vp.x, vp.y, ['Control']);
    await park();
    await page.waitForTimeout(800);
    let aimed = 0;
    for (const o of again) if ((await bridge<number>(`B.u32(${o.id} + 0x2b4)`)) === candidate.o.id) aimed++;
    log('victim ordered', { type: candidate.o.type, shooters: again.length, aimed });
    if (aimed > 0) {
      victim = candidate;
      break;
    }
    await pressKey('s');
  }
  check('a civilian building (>= 2x2) in view takes the force-fire order', !!victim, {
    candidates: candidates.map((c) => c.o.type),
  });
  report.victim = victim && {
    id: victim.o.id,
    type: victim.o.type,
    centre: victim.centre,
    candidates: candidates.length,
  };
  log('victim', report.victim);
  const burnCaptures: Capture[] = [];
  let victimOrderFrame: number | null = null;
  const nearVictim = (a: YrPoint3) => !!victim && Math.hypot(a.x - victim.centre.x, a.y - victim.centre.y) < 5 * 256;
  if (victim) {
    victimOrderFrame = (await capture(false)).frame;
    // The game can run at 100+ logic frames per second, so short explosions may live for well under a second: sample
    // often without pixels and keep only the two most informative frames (with pixels) for the overlays.
    const burningScore = (c: Capture) => c.effects!.anims.filter((a) => /FIRE/.test(a.type) && nearVictim(a)).length;
    const destructionScore = (c: Capture) =>
      c.effects!.anims.filter((a) => !a.buildingAnim && nearVictim(a)).length +
      5 * c.effects!.voxelAnims.length +
      5 * c.effects!.particleSystems.filter((s) => nearVictim(s)).length;
    let burning: Capture | null = null,
      destruction: Capture | null = null;
    const started = Date.now();
    let destroyedAt: number | null = null;
    while (Date.now() - started < 60_000) {
      await page.waitForTimeout(150);
      const probe = await capture(false);
      const alive = probe.state!.objects.find((o) => o.id === victim.o.id);
      if (!alive && destroyedAt === null) destroyedAt = Date.now();
      if (destroyedAt !== null && Date.now() - destroyedAt > 5000) break;
      if (burningScore(probe) > (burning ? burningScore(burning) : 0)) burning = await capture();
      if (destructionScore(probe) > (destruction ? destructionScore(destruction) : 0)) destruction = await capture();
    }
    await pressKey('s');
    report.victimResult = { destroyed: destroyedAt !== null, seconds: (Date.now() - started) / 1000 };
    log('victim result', report.victimResult);
    for (const [name, c] of [
      ['03-burning', burning],
      ['04-destruction', destruction],
    ] as const) {
      if (!c) continue;
      burnCaptures.push(c);
      saveCapture(`capture-${name}`, c);
      await overlayPng(`overlay-${name}`, c, `${name} frame ${c.frame}`);
    }
  }

  // ---- Keep polling for the full window ----
  for (;;) {
    const elapsed = (Date.now() - pollStartedAt) / 1000;
    if (elapsed >= pollSeconds) break;
    await page.waitForTimeout(Math.min(10_000, (pollSeconds - elapsed) * 1000));
    const summary = await bridge<Record<string, any>>('B.pollSummary()');
    log('poll progress', { elapsed: Math.round(elapsed), polls: summary?.polls, tracked: summary?.tracked });
  }
  await bridge('B.stopPoll()');
  const summary = (await bridge<Record<string, any>>('B.pollSummary()'))!;
  const tracks = (await bridge<Tracks>('B.pollTracks()'))!;
  const burst = (await bridge<{
    plain: number[];
    withParticles: number[];
    plainMean: number;
    withParticlesMean: number;
    size: Record<string, number>;
  }>('B.burst(300)'))!;
  writeFileSync(join(out, 'tracks.json'), JSON.stringify(tracks));
  const final = await capture();
  saveCapture('capture-06-final', final);
  await overlayPng('overlay-06-final', final, 'end of poll');

  // ---- Victim: anims created after the order within 5 cells of its centre (from the 30 Hz poll) ----
  if (victim && victimOrderFrame !== null) {
    const victimTypes = new Map<string, number>();
    for (const a of tracks.anims)
      if (a.first.f >= victimOrderFrame && !a.samples[0]!.b && a.samples.some((s) => nearVictim(s)))
        victimTypes.set(a.samples[0]!.type, (victimTypes.get(a.samples[0]!.type) ?? 0) + 1);
    report.victimAnimTypes = [...victimTypes.entries()].sort((a, b) => b[1] - a[1]);
    check(
      'civilian building under fire: burning and destruction anims appear within 5 cells of its centre',
      victimTypes.size >= 2,
      report.victimAnimTypes,
    );
  }

  // ---- Poll integrity ----
  const costs = [...(summary.costs as number[])].sort((a, b) => a - b);
  const q = (values: number[], p: number) => values[Math.min(values.length - 1, Math.floor(p * values.length))]!;
  const countsPerPoll = summary.counts as number[][];
  const burstSorted = (values: number[]) => [...values].sort((a, b) => a - b);
  const perf = {
    polls: summary.polls,
    elapsedS: summary.elapsedMs / 1000,
    achievedHz: summary.polls / (summary.elapsedMs / 1000),
    costMs: {
      mean: costs.reduce((a, b) => a + b, 0) / costs.length,
      p50: q(costs, 0.5),
      p95: q(costs, 0.95),
      p99: q(costs, 0.99),
      max: costs.at(-1),
    },
    maxPerPoll: {
      anims: Math.max(...countsPerPoll.map((c) => c[0]!)),
      voxelAnims: Math.max(...countsPerPoll.map((c) => c[1]!)),
      bullets: Math.max(...countsPerPoll.map((c) => c[2]!)),
      particleSystems: Math.max(...countsPerPoll.map((c) => c[3]!)),
      lasers: Math.max(...countsPerPoll.map((c) => c[4]!)),
      electricBolts: Math.max(...countsPerPoll.map((c) => c[5]!)),
      fires: Math.max(...countsPerPoll.map((c) => c[6]!)),
    },
    burst: {
      size: burst.size,
      plainMs: {
        mean: burst.plainMean,
        p50: q(burstSorted(burst.plain), 0.5),
        p95: q(burstSorted(burst.plain), 0.95),
        max: Math.max(...burst.plain),
      },
      withParticlesMs: {
        mean: burst.withParticlesMean,
        p50: q(burstSorted(burst.withParticles), 0.5),
        p95: q(burstSorted(burst.withParticles), 0.95),
        max: Math.max(...burst.withParticles),
      },
    },
  };
  const { costs: _c, counts: _n, ...rest } = summary;
  report.poll = { ...rest, perf };
  check(
    `polled >= ${pollSeconds}s at ~${hz} Hz without exceptions or null reads; frame never goes backwards`,
    summary.errors.length === 0 &&
      summary.nulls === 0 &&
      perf.elapsedS >= pollSeconds - 1 &&
      summary.frames.backwards === 0,
    {
      polls: summary.polls,
      errors: summary.errors.slice(0, 5),
      nulls: summary.nulls,
      elapsedS: perf.elapsedS,
      achievedHz: perf.achievedHz,
      frames: summary.frames,
    },
  );
  check(
    'no invalid or unresolved entries in any poll; anim UniqueIDs unique per poll and never shared by two pointers',
    Object.values(summary.invalid as Record<string, number>).every((n) => n === 0) &&
      summary.unresolved === 0 &&
      summary.uidDuplicates === 0 &&
      summary.idUidConflicts === 0,
    {
      invalid: summary.invalid,
      limbo: summary.limbo,
      unresolved: summary.unresolved,
      uidDuplicates: summary.uidDuplicates,
      idUidConflicts: summary.idUidConflicts,
    },
  );
  check(
    'every polled anim/bullet/particle-system/voxel-anim type pointer is a member of the engine type array',
    summary.typeChecked > 0 && summary.typeBad.length === 0,
    { checked: summary.typeChecked, bad: summary.typeBad },
  );
  check(
    'poll cost: p95 < 1 ms and max < 5 ms (VM thread, byte-view accessor)',
    perf.costMs.p95 < 1 && (perf.costMs.max ?? 99) < 5,
    perf,
  );

  // ---- Anim lifecycle: frames advance, anims end ----
  const lastPollFrame = summary.frames.last as number;
  const combat = tracks.anims.filter((a) => a.first.f > orderFrame && !a.samples.some((s) => s.b));
  const lifecycle = combat.map((a) => {
    const types = [...new Set(a.samples.map((s) => s.type))];
    const frames = a.samples.map((s) => s.frame);
    const single = types.length === 1 && a.samples[0]!.loops === 1;
    const monotonic =
      frames.every((f, i) => i === 0 || f >= frames[i - 1]!) || frames.every((f, i) => i === 0 || f <= frames[i - 1]!);
    const ended = a.last.f < lastPollFrame - 30;
    const observedFrames = a.last.f - a.first.f;
    const expectedFrames = a.samples[0]!.n * Math.max(1, a.samples[0]!.rate);
    return {
      key: `${a.id}:${a.uid}`,
      types,
      seen: a.seen,
      distinctFrames: new Set(frames).size,
      single,
      monotonic,
      ended,
      observedFrames,
      expectedFrames,
      loops: a.samples[0]!.loops,
      rate: a.samples[0]!.rate,
      n: a.samples[0]!.n,
    };
  });
  const typeStats = new Map<
    string,
    { count: number; frameCount: number; rate: number; loops: number; attached: number; layer: string | null }
  >();
  for (const a of combat) {
    const s = a.samples[0]!;
    const entry = typeStats.get(s.type) ?? {
      count: 0,
      frameCount: s.n,
      rate: s.rate,
      loops: s.loops,
      attached: 0,
      layer: s.l,
    };
    entry.count++;
    if (s.att) entry.attached++;
    typeStats.set(s.type, entry);
  }
  report.combatAnimTypes = [...typeStats.entries()].sort((a, b) => b[1].count - a[1].count);
  report.lifecycle = {
    combatAnims: combat.length,
    ended: lifecycle.filter((l) => l.ended).length,
    typeChanges: lifecycle
      .filter((l) => l.types.length > 1)
      .map((l) => l.types)
      .slice(0, 20),
    examples: lifecycle.slice(0, 30),
  };
  const multi = lifecycle.filter((l) => l.single && l.seen >= 4 && l.rate > 0 && l.n > 2);
  const advancing = multi.filter((l) => l.distinctFrames >= 2 && l.monotonic);
  const endedSingles = lifecycle.filter((l) => l.single && l.ended && l.seen >= 2 && l.rate > 0);
  // One iteration lasts about End * Rate logic frames; sightings are 1/hz apart, so allow two poll intervals of slack
  // at each end plus the frames the game advances per poll.
  const slack = 2 * Math.ceil(60 / hz) + 4;
  const lifetimeOk = endedSingles.filter((l) => l.observedFrames <= l.expectedFrames + slack);
  check(
    'combat anims advance: >= 90% of single-iteration anims seen >= 4 times show >= 2 distinct frames, monotonic',
    multi.length >= 5 && advancing.length / multi.length >= 0.9,
    {
      candidates: multi.length,
      advancing: advancing.length,
      bad: multi.filter((l) => !advancing.includes(l)).slice(0, 10),
    },
  );
  check(
    'combat anims end: most single-iteration anims disappear before the poll ends, within End * Rate (+ poll slack) frames',
    endedSingles.length >= 5 &&
      lifecycle.filter((l) => l.single).filter((l) => l.ended).length /
        Math.max(1, lifecycle.filter((l) => l.single).length) >=
        0.8 &&
      lifetimeOk.length / endedSingles.length >= 0.9,
    {
      singles: lifecycle.filter((l) => l.single).length,
      ended: endedSingles.length,
      withinExpected: lifetimeOk.length,
      over: endedSingles.filter((l) => !lifetimeOk.includes(l)).slice(0, 10),
    },
  );

  // ---- Bullets travel from source towards target ----
  const bulletTracks = tracks.bullets.filter((b) => b.seen >= 2);
  const travelling = bulletTracks.map((b) => {
    const first = b.samples[0]!,
      last = b.samples.at(-1)!;
    return {
      type: first.type,
      weapon: first.weapon,
      inviso: first.inviso,
      arcing: first.arcing,
      firer: first.firer?.kind ?? null,
      fromSourceFirst: dist3(first, first.source),
      fromSourceLast: dist3(last, last.source),
      toTargetFirst: dist3(first, first.target),
      toTargetLast: dist3(last, last.target),
      /** Launch point vs the firer's Location when the bullet was first seen (barrel FLH offsets are < 1.5 cells). */
      sourceFromFirer: b.firerAt ? dist2(first.source, b.firerAt) : null,
      ok:
        dist3(last, last.source) > dist3(first, first.source) &&
        dist3(last, last.target) < dist3(first, first.target) &&
        (!b.firerAt || dist2(first.source, b.firerAt) <= 384),
    };
  });
  report.bullets = {
    tracked: tracks.bullets.length,
    seenTwice: bulletTracks.length,
    types: [
      ...new Set(tracks.bullets.map((b) => `${b.samples[0]!.type}/${b.samples[0]!.weapon}/${b.samples[0]!.warhead}`)),
    ],
    travelling: travelling.slice(0, 30),
  };
  if (bulletTracks.length > 0)
    check(
      'bullets seen in >= 2 polls start at their firer (<= 1.5 cells), move away from SourceCoords and towards TargetCoords (>= 90%)',
      travelling.filter((b) => b.ok).length / travelling.length >= 0.9,
      {
        seenTwice: bulletTracks.length,
        ok: travelling.filter((b) => b.ok).length,
        bad: travelling.filter((b) => !b.ok).slice(0, 10),
      },
    );
  else log('no bullet was seen in two polls (instant-hit weapons only)', report.bullets);
  // ---- Attached anims lie on their owner ----
  const attachedSamples = tracks.anims.flatMap((a) =>
    a.samples
      .filter((s) => s.att !== null && s.off !== null)
      .map((s) => ({ type: s.type, owner: s.att!.split(':')[0]!, off: s.off! })),
  );
  const attachedBad = attachedSamples.filter((s) => s.off > (s.owner === 'building' ? 4 * 256 : 384));
  report.attached = {
    samples: attachedSamples.length,
    types: [...new Set(attachedSamples.map((s) => `${s.type}@${s.owner}`))],
    maxOffset: attachedSamples.length ? Math.max(...attachedSamples.map((s) => s.off)) : null,
    bad: attachedBad.slice(0, 20),
  };
  check(
    'attached anims resolve to world positions on their owner (<= 1.5 cells from its raw Location; buildings <= 4 cells)',
    attachedSamples.length > 0 && attachedBad.length === 0,
    report.attached,
  );
  // ---- Type-level fields against the game's own INI data ----
  const ini = await loadGameIni();
  if (ini) {
    const all = [c0, reference, ...captures, ...burnCaptures, final];
    const results = iniCrossCheck(ini, all);
    report.iniCrossCheck = { compared: results.length, types: new Set(results.map((r) => r.type)).size, results };
    check(
      'type fields equal the artmd.ini / rulesmd.ini keys the engine loaded (anim Start/LoopStart/LoopEnd/Translucent/Flat/Layer/LoopCount, projectile Arcing/Inviso, particle BehavesLike)',
      results.length >= 10 && results.every((r) => r.ok),
      { compared: results.length, bad: results.filter((r) => !r.ok) },
    );
  } else log('EFFECTS_GAME_DIR not set: INI cross-check skipped');
  report.particleSystems = {
    tracked: tracks.systems.length,
    types: [...new Set(tracks.systems.map((s) => `${s.samples[0]!.type}/${s.samples[0]!.behavesLike}`))],
  };
  report.voxelAnims = {
    tracked: tracks.voxels.length,
    types: [...new Set(tracks.voxels.map((v) => v.samples[0]!.type))],
  };
  report.lasers = { tracked: tracks.lasers.length };
  report.electricBolts = { tracked: tracks.bolts.length };
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
  console.log('[effects] outcome', outcome, `${checks.filter((c) => c.pass).length}/${checks.length} checks passed`);
  await context.close();
  await browser.close();
  if (existsSync(out)) console.log('[effects] evidence in', out);
}
