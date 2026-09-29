/**
 * Live-view bench (development only): drives LiveView with synthetic snapshots on a frozen clock, so one engine anim,
 * a set of units or buildings can be looked at (and screenshotted) deterministically, without running the game.
 *
 *   ?fx=TWLT070[,GUNFIRE...]  spawn these anims at the view centre (spread along a diagonal) and show them `time` later
 *   ?fx=units                 voxel tanks, SHP drones and infantry at eight facings, plus a few buildings
 *   &map=XMP29U2&cx=60&cy=62  map cache and centre cell (default: the map's first waypoint)
 *   &zoom=3                   CSS pixels per engine pixel
 *   &time=0.4                 seconds after the spawn to show (logic frames advance at &fps=, default 15)
 *   &hours=12                 time of day
 *   &native=1                 pass the bridge fields (exact anim frame) instead of relying on the fallback timing
 *   &garnish=0                the original art alone, without HD light, sparks or smoke
 *   &house=15                 colour scheme index of the owning house
 *   ?fx=replay&replay=<url>   replay recorded snapshots ({ snapshots: LiveSnapshot[], fps }) at 1 engine px per CSS
 *                             px (the tactical view's own framing), then hold the last one `time` seconds later
 *
 * `performance.now` and `Math.random` are replaced by a controllable clock and a seeded generator before the renderer
 * exists, so the same query always renders the same picture. `window.__fx` exposes the view and a `step` helper.
 */
import { LiveView, type LiveObject, type LiveSnapshot } from '../src/live/liveView';
import type { LiveAnim } from '../src/live/effects';
import { ra2Screen } from '../src/ra2/cache';

const params = new URLSearchParams(location.search);
const canvas = document.querySelector<HTMLCanvasElement>('#view')!;
const hud = document.querySelector<HTMLElement>('#hud')!;
if (params.has('nohud')) hud.hidden = true;

// --- deterministic clock and randomness ------------------------------------------------------------------------
let clock = 1000;
performance.now = () => clock;
let seed = Number(params.get('seed') ?? 7) >>> 0;
Math.random = () => {
  // mulberry32
  seed = (seed + 0x6d2b79f5) >>> 0;
  let t = seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const mapName = params.get('map') ?? 'XMP29U2';
const zoom = Number(params.get('zoom') ?? 1);
const fps = Number(params.get('fps') ?? 15);
const time = Number(params.get('time') ?? 0);
const house = Number(params.get('house') ?? 15);
const live = await LiveView.create(canvas, {
  mapBase: `/${encodeURIComponent(mapName)}`,
  libraryBase: '/_library',
  timeOfDay: Number(params.get('hours') ?? 12),
});
// &garnish=0: the original art alone (no HD light, sparks or smoke), for side-by-side checks.
if (params.get('garnish') === '0')
  (live as unknown as { effectDriver: { garnishEnabled: boolean } }).effectDriver.garnishEnabled = false;
const cache = live.world.cache!;
const grid = cache.manifest.grid;
const waypoint = cache.manifest.waypoints[0] ?? { x: grid.width / 2, y: grid.height / 2 };
const cx = Number(params.get('cx') ?? waypoint.x);
const cy = Number(params.get('cy') ?? waypoint.y);

const cssWidth = canvas.clientWidth;
const cssHeight = canvas.clientHeight;
const viewWidth = Math.round(cssWidth / zoom);
const viewHeight = Math.round(cssHeight / zoom);
live.resize(cssWidth, cssHeight, viewWidth, viewHeight);
if (params.get('fx') === 'replay') await replay();

/** Replay recorded snapshots (the page never continues past this). */
async function replay(): Promise<never> {
  const data = (await fetch(params.get('replay')!).then((r) => r.json())) as {
    snapshots: LiveSnapshot[];
    fps?: number;
  };
  const snapshots = data.snapshots;
  const rate = data.fps ?? fps;
  const first = snapshots[0]!;
  // Load art on the first snapshot's objects without any effect, so nothing spawns before the replay starts.
  const calm = (frame: number): LiveSnapshot => ({
    ...first,
    frame,
    effects: first.effects && { ...first.effects, anims: [], bullets: [], particleSystems: [], beams: [] },
  });
  const warm = Number(params.get('warm') ?? 120);
  for (let i = 0; i < warm; i++) {
    clock += 1000 / rate;
    live.push(calm(first.frame - warm - 1 + i), clock);
    live.render(clock);
    await new Promise((r) => setTimeout(r, 25));
  }
  let previous = first.frame - 1;
  for (const snapshot of snapshots) {
    clock += (Math.max(1, snapshot.frame - previous) * 1000) / rate;
    previous = snapshot.frame;
    live.push(snapshot, clock);
    live.render(clock);
  }
  for (let i = 0, n = Math.round(time * rate); i < n; i++) {
    clock += 1000 / rate;
    live.render(clock);
  }
  const loop = () => {
    live.render(clock);
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
  (window as unknown as { __fx: unknown }).__fx = { live, ready: true };
  return new Promise<never>(() => {});
}

/** Height level of a cell from the cache (0 outside the map). */
function levelAt(x: number, y: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  if (ix < 0 || iy < 0 || ix >= grid.width || iy >= grid.height) return 0;
  return cache.height[iy * grid.width + ix] ?? 0;
}

const [sx, sy] = ra2Screen(cx + 0.5, cy + 0.5, levelAt(cx, cy));
const view = { x: Math.round(sx - viewWidth / 2), y: Math.round(sy - viewHeight / 2) };

/** Lepton coordinate of a cell point, on the ground. */
function at(x: number, y: number): { x: number; y: number; z: number } {
  return { x: Math.round(x * 256), y: Math.round(y * 256), z: levelAt(x, y) * 104 };
}

const houses = [
  { index: 0, colorIndex: house },
  { index: 1, colorIndex: 3 },
  // The Neutral house of a skirmish (colour scheme LightGrey).
  { index: 2, colorIndex: 5 },
];

let nextUid = 5000;
function unitSet(): LiveObject[] {
  const objects: LiveObject[] = [];
  const add = (
    kind: LiveObject['kind'],
    type: string,
    x: number,
    y: number,
    facing = 0,
    owner = 0,
    turret?: number,
  ) => {
    const uid = nextUid++;
    objects.push({
      id: uid,
      uid,
      kind,
      type,
      owner,
      ...at(x, y),
      facingRaw: facing,
      ...(turret !== undefined ? { turretFacingRaw: turret } : {}),
      health: 1,
      isSelected: false,
    });
  };
  const rows: [LiveObject['kind'], string][] = [
    ['vehicle', 'MTNK'],
    ['vehicle', 'HTNK'],
    ['vehicle', 'DRON'],
    ['infantry', 'E2'],
  ];
  rows.forEach(([kind, type], row) => {
    for (let i = 0; i < 8; i++)
      add(
        kind,
        type,
        cx - 3.5 + i,
        cy - 3 + row * 1.4,
        i * 8192,
        0,
        kind === 'vehicle' ? (i * 8192 + 16384) % 65536 : undefined,
      );
  });
  add('building', 'GAPOWR', cx - 4, cy + 3, 0, 0);
  add('building', 'NAREFN', cx - 1, cy + 3, 0, 1);
  add('building', 'CAOILD', cx + 3, cy + 3, 0, 2);
  return objects;
}

/** Engine timing of an anim type from the effect art sidecar (pnpm hd:effects), when it exists. */
interface FxArt {
  frames: number;
  rate: number;
  start: number;
  loopCount: number;
}
const fxArt = new Map<string, FxArt>();
const effectsJson = (await fetch('/_library/common/effects/effects.json')
  .then((r) => (r.ok ? r.json() : null))
  .catch(() => null)) as { anims?: Record<string, Record<string, unknown>> } | null;
for (const [id, a] of Object.entries(effectsJson?.anims ?? {}))
  fxArt.set(id, {
    frames: Math.max(1, Number(a.frameCount ?? 1)),
    rate: Math.max(1, Number(a.rateFrames ?? 1)),
    start: Number(a.start ?? 0),
    loopCount: Number(a.loopCount ?? 1),
  });

const fxIds = (params.get('fx') ?? 'units').split(',').filter(Boolean);
const units = fxIds.includes('units') ? unitSet() : [];
const anims: LiveAnim[] = fxIds
  .filter((id) => id !== 'units')
  .map((type, i, list) => {
    const d = (i - (list.length - 1) / 2) * 1.6;
    return { id: 9000 + i, uid: 9000 + i, type, ...at(cx + 0.5 + d, cy + 0.5 - d) };
  });

let frame = 100_000;
let spawned: number | null = null;

/** The anim as the engine list would hold it `age` logic frames after its creation, or null once it has ended. */
function benchAnim(anim: LiveAnim, age: number): LiveAnim | null {
  const art = fxArt.get(anim.type);
  const frames = art?.frames ?? 20;
  const rate = art?.rate ?? 2;
  const loops = art && art.loopCount < 0 ? Infinity : Math.max(1, art?.loopCount ?? 1);
  const stage = Math.floor(age / rate);
  if (stage >= frames * loops) return null;
  if (params.get('native') !== '1') return anim;
  const native = { frame: (art?.start ?? 0) + (stage % frames), stage: stage % frames, frameCount: frames, rate };
  return { ...anim, ...native };
}

function snapshot(): LiveSnapshot {
  const age = spawned === null ? -1 : frame - spawned;
  return {
    frame,
    view,
    houses,
    objects: units,
    effects: {
      anims: age < 0 ? [] : anims.map((a) => benchAnim(a, age)).filter((a): a is LiveAnim => !!a),
      bullets: [],
      particleSystems: [],
    },
  };
}

/** Advance `seconds` of game time at the bench's logic rate, rendering every logic frame (continuous emitters). */
function step(seconds: number): void {
  const frames = Math.round(seconds * fps);
  for (let i = 0; i < frames; i++) {
    frame++;
    clock += 1000 / fps;
    live.push(snapshot(), clock);
    live.render(clock);
  }
}

// Let library pages and effect art load before the spawn (real timers; the render clock only advances per frame).
for (let i = 0; i < Number(params.get('warm') ?? 120); i++) {
  step(1 / fps);
  await new Promise((r) => setTimeout(r, 25));
}
spawned = frame + 1;
step(1 / fps + time);
let presented = 0;
function loop(): void {
  live.render(clock);
  presented++;
  hud.textContent = `fx ${fxIds.join(',')} · t=${time}s · age ${spawned === null ? 0 : frame - spawned} · ${presented}`;
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);
(window as unknown as { __fx: unknown }).__fx = { live, step, snapshot, ready: true };
