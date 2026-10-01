/**
 * Live-view bench (development only): drives LiveView with synthetic snapshots on a frozen clock, so one engine anim,
 * a set of units or buildings can be looked at (and screenshotted) deterministically, without running the game.
 *
 *   ?fx=TWLT070[,GUNFIRE...]  spawn these anims at the view centre (spread along a diagonal) and show them `time` later
 *   ?fx=units                 voxel tanks, SHP drones and infantry at eight facings, plus a few buildings
 *   ?fx=squad                 a small battle line: Grizzlies and GIs (house &house) facing Rhinos (house &house2),
 *                             a power plant and a refinery behind them (combine with anims: ?fx=squad,TWLT070,...)
 *   ?fx=infantry              infantry art review: one row per type (&itypes=E1,E2,SHK,...), eight facings each, all
 *                             showing sequence &seq= (default Ready) at step &step= (default 0; &animate=N steps it
 *                             every N logic frames). Types listed in &itypes2= belong to house &house2.
 *   ?fx=bldgs&bldgs=NACNST:0:0:0,NAPOWR:4:0:1  TYPE:dx:dy[:owner] buildings, cell offsets from cx,cy;
 *                             owner indexes the bench houses (default 0); combine with anims: ?fx=bldgs,TWLT070
 *   &health=0.4               health of all listed buildings (default 1; <= 0.5 uses damaged art)
 *   &banims=NAREFNL1:0:3:4,NAREFNOR:0:20:3  SPRITE:start:frames:rate building layers played as the bridge's
 *                             building anim list (buildingAnim entries attached to every listed building, looping
 *                             from the spawn), e.g. the refinery's ore unloading that the fallback never shows;
 *                             a building then draws only the listed layers that it has
 *   &make=1&time=0.4          omit listed buildings during warm-up, then spawn them to play the engine-style
 *                             build-up; time selects seconds after spawn (keep the default warm-up for make)
 *   &at=dx,dy;dx,dy           cell offsets from the centre for the listed anims (instead of the diagonal)
 *   &map=XMP29U2&cx=60&cy=62  map cache and centre cell (default: the map's first waypoint)
 *   &zoom=3                   CSS pixels per engine pixel
 *   &time=0.4                 seconds after the spawn to show (logic frames advance at &fps=, default 15)
 *   &hours=12                 time of day
 *   &look=golden              the enhanced look preset (sun arc, relit art, shadows following the sun)
 *   &water=enhanced           the modern water (default: the earlier HD water)
 *   &native=1                 pass the bridge fields (exact anim frame) instead of relying on the fallback timing
 *   &garnish=0                the original art alone, without HD light, sparks or smoke
 *   &effects=enhanced         the enhanced effect style (LiveViewOptions.effects) instead of the faithful garnish
 *   &fxhd=0                  keep native effect frames even in enhanced style (disable optional HD flipbooks)
 *   &fxhdbase=<url>           directory holding effects-hd.json and its RGBA atlas pages
 *   &stagger=0.5              spawn the listed anims this many seconds apart instead of all at once
 *   &repeat=3                 play the list again every this many seconds (new anim identities each round)
 *   &delay=0,0.5,...          per-anim start delay in seconds (overrides &stagger for the anims it lists)
 *   &period=0,2,...           per-anim repeat period in seconds, 0 = once (overrides &repeat for the anims it lists)
 *   &spread=1.6               cells between the listed anims along the diagonal
 *   &crater=1                 emulate the engine's craters (bridge H3 smudge grid: the map's own smudges plus a
 *                             CRATER/BURNT smudge where a Scorch=yes / Crater=yes anim reaches its middle)
 *   &house=15                 colour scheme index of the owning house
 *   &objects=T@dx,dy[@owner[@health[@facing]]];...
 *                             extra units/buildings (rules type T, kind from the type library) at cell offsets from
 *                             the centre, e.g. TESLA@4,-2@1 or GAPOWR@-6,2@0@0.3 (a damaged power plant)
 *   &bolts=i:dx,dy,h;...      an electric bolt (engine beam, Tesla colour) from cell offset (dx, dy) at h leptons
 *                             above the ground to listed anim i, during its first &boltfor= seconds (default 0.4)
 *   ?fx=replay&replay=<url>   replay recorded snapshots ({ snapshots: LiveSnapshot[], fps }) at 1 engine px per CSS
 *                             px (the tactical view's own framing), then hold the last one `time` seconds later
 *
 * `performance.now` and `Math.random` are replaced by a controllable clock and a seeded generator before the renderer
 * exists, so the same query always renders the same picture. `window.__fx` exposes the view, a `step` helper (whole
 * logic frames) and `advance(ms)` (any presentation interval: logic frames are pushed as the clock passes them), so a
 * capture script can record the same scenario frame by frame at any frame rate.
 */
import { LiveView, type LiveObject, type LiveSmudgeCells, type LiveSnapshot } from '../src/live/liveView';
import { effectRow, type LiveAnim } from '../src/live/effects';
import { ra2Screen } from '../src/ra2/cache';
import { applyLookPreset, LOOK_PRESETS, type LookPreset } from '../src/HdRenderer';

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
  effects: params.get('effects') === 'enhanced' ? 'enhanced' : 'faithful',
  effectsHd: params.get('fxhd') !== '0',
  effectsHdBase: params.get('fxhdbase') ?? undefined,
  water: params.get('water') === 'enhanced' ? 'enhanced' : 'classic',
});
// &look=golden: the enhanced look preset (src/HdRenderer.ts LOOK_PRESETS; pair it with &hours=16.5), for effect reviews
// in the lighting they will be seen with.
const lookPreset = params.get('look') as LookPreset | null;
if (lookPreset && lookPreset in LOOK_PRESETS) {
  applyLookPreset(live.hd.settings, lookPreset);
  live.hd.applySettings();
}
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
  { index: 1, colorIndex: Number(params.get('house2') ?? 3) },
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

/** A small battle line for effect reviews (?fx=squad). */
function squadSet(): LiveObject[] {
  const objects: LiveObject[] = [];
  const add = (kind: LiveObject['kind'], type: string, x: number, y: number, facing: number, owner: number) => {
    const uid = nextUid++;
    objects.push({
      id: uid,
      uid,
      kind,
      type,
      owner,
      ...at(cx + x, cy + y),
      facingRaw: facing,
      ...(kind === 'vehicle' ? { turretFacingRaw: facing } : {}),
      health: 1,
      isSelected: false,
    });
  };
  // Facing 0 is north (screen up-right); a quarter turn per 16384.
  const east = 16384;
  const west = 49152;
  for (const [x, y] of [
    [-3.2, -1.4],
    [-3.6, 0.4],
    [-2.8, 2.0],
  ])
    add('vehicle', 'MTNK', x!, y!, east, 0);
  for (const [x, y] of [
    [-4.6, -0.6],
    [-4.8, 0.9],
    [-4.2, 1.9],
    [-4.4, -1.8],
  ])
    add('infantry', 'E1', x!, y!, east, 0);
  for (const [x, y] of [
    [3.2, -2.0],
    [3.6, -0.2],
    [3.0, 1.6],
  ])
    add('vehicle', 'HTNK', x!, y!, west, 1);
  add('building', 'GAPOWR', -7.5, 1, 0, 0);
  add('building', 'NAREFN', 5.5, -5, 0, 1);
  return objects;
}

/** Infantry art review (?fx=infantry): a row of eight facings per type, all in one sequence at one step. */
function infantrySet(): LiveObject[] {
  const types = (params.get('itypes') ?? 'E1,E2,SHK,ENGINEER,DOG,ADOG').split(',').filter(Boolean);
  const second = new Set((params.get('itypes2') ?? '').split(',').filter(Boolean));
  const seq = params.get('seq') ?? 'Ready';
  const step = Number(params.get('step') ?? 0);
  const spacing = Number(params.get('ispace') ?? 1);
  const objects: LiveObject[] = [];
  types.forEach((type, row) => {
    for (let i = 0; i < 8; i++) {
      const uid = nextUid++;
      objects.push({
        id: uid,
        uid,
        kind: 'infantry',
        type,
        owner: second.has(type) ? 1 : 0,
        // Screen rows: +1 map x and -1 map y is one step right on screen, +1 on both one step down.
        ...at(cx + (i - 3.5) * 0.6 * spacing + (row - types.length / 2) * 0.9 * spacing,
          cy - (i - 3.5) * 0.6 * spacing + (row - types.length / 2) * 0.9 * spacing),
        facingRaw: i * 8192,
        infantrySequence: seq,
        sequenceFrame: step,
        health: 1,
        isSelected: false,
      });
    }
  });
  return objects;
}

/** An explicit building layout for comparing intact, damaged and make art at the same camera/lighting. */
function buildingSet(): LiveObject[] {
  const health = Number(params.get('health') ?? 1);
  if (!Number.isFinite(health) || health < 0 || health > 1) throw new Error('health must be between 0 and 1');
  return (params.get('bldgs') ?? '')
    .split(',')
    .filter(Boolean)
    .map((spec) => {
      const fields = spec.split(':');
      const [type, dx, dy] = fields;
      const x = Number(dx);
      const y = Number(dy);
      const owner = Number(fields[3] ?? 0);
      if (
        fields.length < 3 ||
        fields.length > 4 ||
        !type ||
        !dx ||
        !dy ||
        !Number.isFinite(x) ||
        !Number.isFinite(y) ||
        !Number.isInteger(owner) ||
        !houses.some((h) => h.index === owner)
      )
        throw new Error(`Invalid building spec: ${spec}; expected TYPE:dx:dy[:owner]`);
      const uid = nextUid++;
      return {
        id: uid,
        uid,
        kind: 'building',
        type,
        owner,
        ...at(cx + x, cy + y),
        facingRaw: 0,
        health,
        isSelected: false,
      };
    });
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
/** Kind of every rules type in the map theater's type library (for &objects=). */
const libraryKinds: Record<string, string> = params.has('objects')
  ? Object.fromEntries(
      Object.entries(
        ((await fetch(`/_library/${cache.manifest.theater}/library.json`)
          .then((r) => (r.ok ? r.json() : null))
          .catch(() => null)) as { types?: Record<string, { kind: string }> } | null)?.types ?? {},
      ).map(([id, t]) => [id, t.kind]),
    )
  : {};
const units = [
  ...(fxIds.includes('units') ? unitSet() : []),
  ...(fxIds.includes('squad') ? squadSet() : []),
  ...(fxIds.includes('infantry') ? infantrySet() : []),
  ...extraObjects(),
];

/** &objects=: extra units and buildings for effect scenarios (kind looked up in the type library). */
function extraObjects(): LiveObject[] {
  const spec = params.get('objects');
  if (!spec) return [];
  const objects: LiveObject[] = [];
  for (const item of spec.split(';').filter(Boolean)) {
    const [type, offset, owner, health, facing] = item.split('@');
    const [dx, dy] = (offset ?? '0,0').split(',').map(Number);
    const kind = (libraryKinds[type!] ?? 'building') as LiveObject['kind'];
    const uid = nextUid++;
    objects.push({
      id: uid,
      uid,
      kind,
      type: type!,
      owner: Number(owner ?? 0),
      ...at(cx + (dx ?? 0), cy + (dy ?? 0)),
      facingRaw: Number(facing ?? 0),
      ...(kind === 'vehicle' ? { turretFacingRaw: Number(facing ?? 0) } : {}),
      health: Number(health ?? 1),
      isSelected: false,
    });
  }
  return objects;
}
const buildings = fxIds.includes('bldgs') ? buildingSet() : [];
const allObjects = [...units, ...buildings];
const makeBuildings = params.get('make') === '1';
const spread = Number(params.get('spread') ?? 1.6);
const offsets = params
  .get('at')
  ?.split(';')
  .map((pair) => pair.split(',').map(Number) as [number, number])
  .filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y));
const anims: LiveAnim[] = fxIds
  .filter((id) => id !== 'units' && id !== 'squad' && id !== 'infantry' && id !== 'bldgs')
  .map((type, i, list) => {
    const offset = offsets?.length ? offsets[i % offsets.length]! : null;
    const d = (i - (list.length - 1) / 2) * spread;
    const [x, y] = offset ? [cx + 0.5 + offset[0], cy + 0.5 + offset[1]] : [cx + 0.5 + d, cy + 0.5 - d];
    return { id: 9000 + i, uid: 9000 + i, type, ...at(x, y) };
  });
const stagger = Math.max(0, Number(params.get('stagger') ?? 0));
/** &bolts=: electric bolts from a point to listed anims (anim index -> source cell offset and height in leptons). */
const bolts = new Map<number, { x: number; y: number; z: number }>();
for (const item of (params.get('bolts') ?? '').split(';').filter(Boolean)) {
  const [index, rest] = item.split(':');
  const [dx, dy, h] = (rest ?? '').split(',').map(Number);
  const ground = at(cx + 0.5 + (dx ?? 0), cy + 0.5 + (dy ?? 0));
  bolts.set(Number(index), { ...ground, z: ground.z + (h ?? 0) });
}
const boltFor = Number(params.get('boltfor') ?? 0.4);
const repeat = Math.max(0, Number(params.get('repeat') ?? 0));
const delays = (params.get('delay') ?? '').split(',').filter((v) => v !== '').map(Number);
const periods = (params.get('period') ?? '').split(',').filter((v) => v !== '').map(Number);
/** Start delay and repeat period (seconds) of listed anim `i`. */
const delayOf = (i: number) => (Number.isFinite(delays[i]) ? delays[i]! : i * stagger);
const periodOf = (i: number) => Math.max(0, Number.isFinite(periods[i]) ? periods[i]! : repeat);

let frame = 100_000;
let spawned: number | null = null;

/**
 * Anim `i` of the list as the engine list holds it now, or null (not spawned yet, or ended): its own start after the
 * stagger, and a new identity every `repeat` seconds (the engine creates a new AnimClass for every blast).
 */
function listedAnim(anim: LiveAnim, i: number): LiveAnim | null {
  if (spawned === null) return null;
  let age = frame - spawned - Math.round(delayOf(i) * fps);
  if (age < 0) return null;
  let round = 0;
  if (periodOf(i) > 0) {
    const period = Math.max(1, Math.round(periodOf(i) * fps));
    round = Math.floor(age / period);
    age %= period;
  }
  const listed = benchAnim(anim, age);
  const current = listed && round ? { ...listed, id: anim.id + round * 1000, uid: anim.uid + round * 1000 } : listed;
  if (current) craterAt(current, age);
  return current;
}

// --- engine craters (&crater=1): the map's own smudges plus one where each scorching anim reaches its middle ----------
const smudgeLibrary = params.get('crater') === '1' ? await loadSmudgeLibrary() : null;
const craterCells = new Map<number, { type: string; age: number }>();
let smudgeRevision = 1;

async function loadSmudgeLibrary(): Promise<Record<string, { width: number; height: number }>> {
  const library = (await fetch(`/_library/${cache.manifest.theater}/library.json`)
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null)) as { smudges?: Record<string, { width: number; height: number }> } | null;
  return library?.smudges ?? {};
}

/** The engine's crater for a scorching anim: a random CRATER (big blasts) or BURNT (small ones) 1x1 smudge. */
function craterType(anim: LiveAnim, scale: number): string {
  const n = 1 + (anim.uid % 6);
  return `${scale >= 0.6 ? 'CRATER' : 'BURNT'}0${n}`;
}

function smudgeGrid(): LiveSmudgeCells | null {
  if (!smudgeLibrary) return null;
  const width = grid.width;
  const height = grid.height;
  const types: string[] = [];
  const typeIndex = (type: string) => {
    let i = types.indexOf(type);
    if (i < 0) i = types.push(type) - 1;
    return i;
  };
  const index = new Int16Array(width * height).fill(-1);
  const data = new Uint8Array(width * height);
  for (const object of cache.manifest.objects) {
    if (object.kind !== 'smudge') continue;
    const size = smudgeLibrary[object.type] ?? { width: 1, height: 1 };
    for (let dy = 0; dy < size.height; dy++)
      for (let dx = 0; dx < size.width; dx++) {
        const x = object.x + dx;
        const y = object.y + dy;
        if (x < 0 || y < 0 || x >= width || y >= height) continue;
        index[y * width + x] = typeIndex(object.type);
        data[y * width + x] = dy * size.width + dx;
      }
  }
  for (const [cell, crater] of craterCells) {
    index[cell] = typeIndex(crater.type);
    data[cell] = 0;
  }
  return { originX: 0, originY: 0, width, height, index, data, types, revision: smudgeRevision };
}

/** Record the crater of a scorching anim once it reaches its middle (`age` logic frames after its start). */
function craterAt(anim: LiveAnim, age: number): void {
  if (!smudgeLibrary) return;
  const row = effectRow(anim.type);
  if (!row.scorch || row.fx !== 'explosion') return;
  const art = fxArt.get(anim.type);
  if (age < Math.floor(((art?.frames ?? 20) * (art?.rate ?? 2)) / 2)) return;
  const cell = Math.floor(anim.y / 256) * grid.width + Math.floor(anim.x / 256);
  if (craterCells.has(cell)) return;
  craterCells.set(cell, { type: craterType(anim, row.s), age });
  smudgeRevision++;
}

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

/** &animate=N: infantry of ?fx=infantry step their sequence every N logic frames (0 = frozen at &step=). */
const animateInfantry = Number(params.get('animate') ?? 0);
/** Logic frames since anim `i` of the list started its current round, or null before its first start. */
function roundAge(i: number): number | null {
  if (spawned === null) return null;
  const age = frame - spawned - Math.round(delayOf(i) * fps);
  if (age < 0) return null;
  return periodOf(i) > 0 ? age % Math.max(1, Math.round(periodOf(i) * fps)) : age;
}

/** Engine beams of the bench's bolts this logic frame. */
function benchBeams(): NonNullable<LiveSnapshot['effects']>['beams'] {
  const beams: NonNullable<NonNullable<LiveSnapshot['effects']>['beams']> = [];
  for (const [i, source] of bolts) {
    const anim = anims[i];
    const age = roundAge(i);
    if (!anim || age === null || age >= Math.round(boltFor * fps)) continue;
    beams.push({ source, target: { x: anim.x, y: anim.y, z: anim.z }, kind: 'bolt', colour: [82, 80, 255] });
  }
  return beams;
}

/** &banims: the listed building layers as the engine's building anim list would hold them now (looping). */
const buildingLayerSpecs = (params.get('banims') ?? '')
  .split(',')
  .filter(Boolean)
  .map((spec) => {
    const [type, start, frames, rate] = spec.split(':');
    const parsed = { type: type ?? '', start: Number(start), frames: Number(frames), rate: Number(rate) };
    if (!parsed.type || !(parsed.start >= 0) || !(parsed.frames >= 1) || !(parsed.rate >= 1))
      throw new Error(`Invalid building anim spec: ${spec}; expected SPRITE:start:frames:rate`);
    return parsed;
  });
function buildingLayerAnims(): LiveAnim[] {
  if (!buildingLayerSpecs.length || spawned === null || frame < spawned) return [];
  const age = frame - spawned;
  return buildings.flatMap((b, bi) =>
    buildingLayerSpecs.map((s, i) => {
      const stage = Math.floor(age / s.rate) % s.frames;
      const uid = 50_000 + bi * 64 + i;
      return {
        id: uid,
        uid,
        type: s.type,
        x: b.x,
        y: b.y,
        z: b.z,
        frame: s.start + stage,
        stage,
        frameCount: s.frames,
        rate: s.rate,
        buildingAnim: true,
        attachedTo: { id: b.id, uid: b.uid, kind: 'building' },
      };
    }),
  );
}

function snapshot(): LiveSnapshot {
  const listed = anims.map((a, i) => listedAnim(a, i)).filter((a): a is LiveAnim => !!a);
  listed.push(...buildingLayerAnims());
  return {
    frame,
    view,
    houses,
    // Delaying first appearance lets LiveView's normal make timeline start at the spawn frame.
    objects: ((objs: LiveObject[]) =>
      animateInfantry
        ? objs.map((u) => (u.infantrySequence ? { ...u, sequenceFrame: Math.floor(frame / animateInfantry) } : u))
        : objs)(makeBuildings && (spawned === null || frame < spawned) ? units : allObjects),
    effects: {
      anims: listed,
      bullets: [],
      particleSystems: [],
      beams: benchBeams(),
    },
    ...(smudgeLibrary ? { smudges: smudgeGrid() } : {}),
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
/** Renderer clock of the newest logic frame. */
let logicClock = clock;

/** Advance the presentation clock by `ms`, pushing every logic frame it passes, and render once (video capture). */
function advance(ms: number): void {
  clock += ms;
  while (clock - logicClock >= 1000 / fps - 1e-6) {
    logicClock += 1000 / fps;
    frame++;
    live.push(snapshot(), logicClock);
  }
  live.render(clock);
}
let presented = 0;
function loop(): void {
  live.render(clock);
  presented++;
  hud.textContent = `fx ${fxIds.join(',')} · t=${time}s · age ${spawned === null ? 0 : frame - spawned} · ${presented}`;
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);
(window as unknown as { __fx: unknown }).__fx = { live, step, advance, snapshot, ready: true };
