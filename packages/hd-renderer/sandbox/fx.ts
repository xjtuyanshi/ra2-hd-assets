/**
 * Live-view bench (development only): drives LiveView with synthetic snapshots on a frozen clock, so one engine anim,
 * a set of units or buildings can be looked at (and screenshotted) deterministically, without running the game.
 *
 *   ?fx=TWLT070[,GUNFIRE...]  spawn these anims at the view centre (spread along a diagonal) and show them `time` later
 *   ?fx=units                 voxel tanks, SHP drones and infantry at eight facings, plus a few buildings
 *   ?fx=beams                 rad, temporal, eruption, magnetron and sonic in five screen rows around cx/cy;
 *                             frozen at mid-life (&bprogress=0..1 changes progress); &effects=enhanced brightens halos
 *   ?fx=shpunits&stypes=DRON  one screen row per SHP vehicle, eight clockwise facings from screen-up, DarkRed house;
 *                             &seq=Stand|Walk|Fire&step=0 selects a pose; &animate=N advances every N logic frames
 *                             after warm-up (with &time= or __fx.advance). &sspace=1 controls row/column spacing.
 *   ?fx=squad                 a small battle line: Grizzlies and GIs (house &house) facing Rhinos (house &house2),
 *                             a power plant and a refinery behind them (combine with anims: ?fx=squad,TWLT070,...)
 *   ?fx=infantry              infantry art review: one row per type (&itypes=E1,E2,SHK,...), eight facings each, all
 *                             showing sequence &seq= (default Ready) at step &step= (default 0; &animate=N steps it
 *                             every N logic frames). Types listed in &itypes2= belong to house &house2.
 *   ?fx=parade&ptypes=E1:0,GGI:0|E2:1,HTNK:1  unit parade: one screen row per '|' group, TYPE:owner entries left to
 *                             right (kind from the type library; owner indexes the bench houses, 3 = &house3),
 *                             facing &pface= (default 24576, towards the viewer), infantry in sequence &pseq=
 *                             (default Ready; &animate=N steps it), &pspace=1 scales the spacing
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
 *   &fxvol=ray|off            raymarched 3D blasts in enhanced style (default off)
 *   &fxhd=0                  keep native effect frames even in enhanced style (disable optional HD flipbooks)
 *   &fxhdbase=<url>           directory holding effects-hd.json and its RGBA atlas pages
 *   &stagger=0.5              spawn the listed anims this many seconds apart instead of all at once
 *   &repeat=3                 play the list again every this many seconds (new anim identities each round)
 *   &delay=0,0.5,...          per-anim start delay in seconds (overrides &stagger for the anims it lists)
 *   &period=0,2,...           per-anim repeat period in seconds, 0 = once (overrides &repeat for the anims it lists)
 *   &spread=1.6               cells between the listed anims along the diagonal
 *   &crater=1                 emulate the engine's craters (bridge H3 smudge grid: the map's own smudges plus a
 *                             CRATER/BURNT smudge where a Scorch=yes / Crater=yes anim reaches its middle)
 *   &ore=1                   publish the map's overlays through the live library path (ore, gems and walls)
 *   &harvest=0,0;6,0;6,4     implies ore=1; harvester follows cell offsets from cx,cy, then stops at the endpoint
 *                             &harvester=CMIN selects its rules type; &house its colour; &hspeed=0.8 cells/second
 *                             &hrate=0.6 seconds between growth losses within Chebyshev distance 1 while moving
 *   &ostages=TIB01,GEM01     implies ore=1; replace overlays with rows of growth frames 0..11 from cx,cy (+x/+y)
 *                             &ospace=2 integer cell spacing; &ofill=N adds an N x N frame-11 block per type to
 *                             the right (blocks stagger farther right for each row to avoid overlap)
 *   &house=15                 colour scheme index of the owning house
 *   &objects=T@dx,dy[@owner[@health[@facing]]];...
 *                             extra units/buildings (rules type T, kind from the type library) at cell offsets from
 *                             the centre, e.g. TESLA@4,-2@1 or GAPOWR@-6,2@0@0.3 (a damaged power plant)
 *   &bolts=i:dx,dy,h;...      an electric bolt (engine beam, Tesla colour) from cell offset (dx, dy) at h leptons
 *                             above the ground to listed anim i, during its first &boltfor= seconds (default 0.4)
 *   ?fx=replay&replay=<url>   replay recorded snapshots ({ snapshots: LiveSnapshot[], fps }) at 1 engine px per CSS
 *                             px (the tactical view's own framing), then hold the last one `time` seconds later;
 *                             a snapshot without shroud/overlays/smudges/cells keeps the previous snapshot's (dense
 *                             replays from packages/ra2-assets/python/live_replay.py write them only on change);
 *                             &rstart=N pushes only the first N snapshots before `ready`, and __fx.advance(ms) pushes
 *                             the rest as the clock passes their frames (frame sequences of one replay)
 *
 * `performance.now` and `Math.random` are replaced by a controllable clock and a seeded generator before the renderer
 * exists, so the same query always renders the same picture. `window.__fx` exposes the view, a `step` helper (whole
 * logic frames) and `advance(ms)` (any presentation interval: logic frames are pushed as the clock passes them), so a
 * capture script can record the same scenario frame by frame at any frame rate.
 */
import { LiveView, type LiveObject, type LiveSmudgeCells, type LiveSnapshot } from '../src/live/liveView';
import { effectRow, type LiveAnim } from '../src/live/effects';
import type { LiveRadBeam, LiveWave } from '../src/live/beams';
import { ra2Screen } from '../src/ra2/cache';
import { applyLookPreset, LOOK_PRESETS, type LookPreset } from '../src/HdRenderer';
import { voxelLookParams } from './look';
import { voxelProjectionFor } from '../src/ra2/voxelProjection';
import { voxelPbrFor } from '../src/ra2/voxelPbr';
import { advanceShpReview, shpUnitReview } from './shpUnitReview';
import type { TypeLibrary } from '../../ra2-assets/src/library';
import { depleteOre, growthGrid, mapOverlayGrid, polylinePosition, type CellPoint } from './oreBench';

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
const house = Number(params.get('house') ?? (params.get('fx')?.split(',').includes('shpunits') ? 11 : 15));
const live = await LiveView.create(canvas, {
  ...voxelLookParams(params),
  mapBase: `/${encodeURIComponent(mapName)}`,
  libraryBase: '/_library',
  timeOfDay: Number(params.get('hours') ?? 12),
  effects: params.get('effects') === 'enhanced' ? 'enhanced' : 'faithful',
  effectsHd: params.get('fxhd') !== '0',
  volumetricEffects: params.get('fxvol') === 'ray' ? 'ray' : 'off',
  effectsHdBase: params.get('fxhdbase') ?? undefined,
  water: params.get('water') === 'enhanced' ? 'enhanced' : 'classic',
});
(window as unknown as { __hd: unknown }).__hd = {
  hd: live.hd,
  world: live.world,
  voxelProjection: voxelProjectionFor(live.hd.nodes),
  voxelPbr: voxelPbrFor(live.hd.nodes),
  stats: () => live.hd.stats(),
};
// &look=golden: the enhanced look preset (src/HdRenderer.ts LOOK_PRESETS; pair it with &hours=16.5), for effect reviews
// in the lighting they will be seen with.
const lookPreset = params.get('look') as LookPreset | null;
if (lookPreset && lookPreset in LOOK_PRESETS) {
  applyLookPreset(live.hd.settings, lookPreset);
  live.hd.applySettings();
}
// &set=key:value,...: numeric setting overrides after the look (A/B reviews of one knob at the same camera/lighting).
const overrides = (params.get('set') ?? '').split(',').filter(Boolean);
if (overrides.length) {
  const settings = live.hd.settings as unknown as Record<string, unknown>;
  for (const item of overrides) {
    const [key, raw] = item.split(':');
    const value = Number(raw);
    if (!key || typeof settings[key] !== 'number' || !Number.isFinite(value))
      throw new Error(`Invalid setting override: ${item}; expected numericKey:value`);
    settings[key] = value;
  }
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
    effects: first.effects && {
      ...first.effects,
      anims: [],
      bullets: [],
      particleSystems: [],
      beams: [],
      radBeams: [],
      waves: [],
    },
  });
  const warm = Number(params.get('warm') ?? 120);
  for (let i = 0; i < warm; i++) {
    clock += 1000 / rate;
    live.push(calm(first.frame - warm - 1 + i), clock);
    live.render(clock);
    await new Promise((r) => setTimeout(r, 25));
  }
  // Snapshots that omit the large per-cell grids keep the previous ones (null would mean "not read" to the view).
  const carried: Partial<LiveSnapshot> = {};
  const withCarried = (snapshot: LiveSnapshot): LiveSnapshot => {
    for (const key of ['shroud', 'overlays', 'smudges', 'cells'] as const)
      if (snapshot[key]) (carried as Record<string, unknown>)[key] = snapshot[key];
    return { ...carried, ...snapshot } as LiveSnapshot;
  };
  // Scheduled clock of each snapshot: the first one a logic frame after the warm-up, then by its frame distance.
  const start = clock + 1000 / rate;
  const due = (index: number) => start + ((snapshots[index]!.frame - first.frame) * 1000) / rate;
  let next = 0;
  const pushDue = () => {
    while (next < snapshots.length && due(next) <= clock + 1e-6)
      live.push(withCarried(snapshots[next++]!), due(next - 1));
  };
  const initial = Math.min(snapshots.length, Math.max(1, Number(params.get('rstart') ?? snapshots.length)));
  for (let i = 0; i < initial; i++) {
    clock = Math.max(clock, due(i));
    pushDue();
    live.render(clock);
  }
  for (let i = 0, n = Math.round(time * rate); i < n; i++) {
    clock += 1000 / rate;
    pushDue();
    live.render(clock);
  }
  const loop = () => {
    live.render(clock);
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
  /** Presentation step for frame captures: later snapshots arrive as the clock passes their frames. */
  const advance = (ms: number) => {
    const end = clock + ms;
    // Push in logic-frame steps so each snapshot is presented at its own clock, like the live page.
    while (clock + 1000 / rate < end) {
      clock += 1000 / rate;
      pushDue();
      live.render(clock);
    }
    clock = end;
    pushDue();
    live.render(clock);
  };
  (window as unknown as { __fx: unknown }).__fx = { live, advance, ready: true };
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
  // A third player house for unit parades (default Purple, Yuri's colour).
  { index: 3, colorIndex: Number(params.get('house3') ?? 17) },
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
        ...at(
          cx + (i - 3.5) * 0.6 * spacing + (row - types.length / 2) * 0.9 * spacing,
          cy - (i - 3.5) * 0.6 * spacing + (row - types.length / 2) * 0.9 * spacing,
        ),
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
const oreEnabled = params.get('ore') === '1' || params.has('harvest') || params.has('ostages');
const benchLibrary =
  params.has('objects') || oreEnabled || params.get('crater') === '1' || fxIds.includes('parade')
    ? await fetch(`/_library/${cache.manifest.theater}/library.json`)
        .then((r) => (r.ok ? (r.json() as Promise<TypeLibrary>) : null))
        .catch(() => null)
    : null;
/** Kind of every rules type in the map theater's type library (for &objects=). */
const libraryKinds = Object.fromEntries(Object.entries(benchLibrary?.types ?? {}).map(([id, t]) => [id, t.kind]));
let oreGrid = !oreEnabled
  ? null
  : params.has('ostages')
    ? growthGrid(
        grid.width,
        grid.height,
        params
          .get('ostages')!
          .split(',')
          .map((id) => id.trim())
          .filter(Boolean),
        cx,
        cy,
        Number(params.get('ospace') ?? 2),
        Number(params.get('ofill') ?? 0),
      )
    : mapOverlayGrid(grid.width, grid.height, cache.manifest.objects);
const tiberium = new Set(
  Object.entries(benchLibrary?.overlays ?? {})
    .filter(([, t]) => t.tiberium)
    .map(([id]) => id),
);
const harvestPath: CellPoint[] = params.has('harvest')
  ? params
      .get('harvest')!
      .split(';')
      .map((pair) => {
        const values = pair.split(',').map(Number);
        if (values.length !== 2 || pair.split(',').some((v) => !v.trim()) || !values.every(Number.isFinite))
          throw new Error(`Invalid harvest point: ${pair}; expected dx,dy`);
        return [cx + values[0]!, cy + values[1]!] as const;
      })
  : [];
const harvestSpeed = Number(params.get('hspeed') ?? 0.8);
const harvestRate = Number(params.get('hrate') ?? 0.6);
if (
  harvestPath.length &&
  (!Number.isFinite(harvestSpeed) || harvestSpeed <= 0 || !Number.isFinite(harvestRate) || harvestRate <= 0)
)
  throw new Error('Harvest speed and rate must be positive finite numbers');
const harvesterUid = harvestPath.length ? nextUid++ : 0;
let harvestTick = 0;

/** Harvest only on logic-time boundaries; repeated snapshot reads must not consume another growth frame. */
function harvestObjects(): LiveObject[] {
  if (!harvestPath.length) return [];
  const age = spawned === null ? 0 : Math.max(0, frame - spawned) / fps;
  const tick = Math.floor(age / harvestRate + 1e-9);
  while (harvestTick < tick) {
    const position = polylinePosition(harvestPath, ++harvestTick * harvestRate, harvestSpeed);
    if (position.moving && oreGrid) {
      // Keep previously published snapshots stable for interpolation and capture/debug readers.
      const next = { ...oreGrid, index: oreGrid.index.slice(), data: oreGrid.data.slice() };
      if (depleteOre(next, position.x, position.y, tiberium)) oreGrid = next;
    }
  }
  const position = polylinePosition(harvestPath, age, harvestSpeed);
  return [
    {
      id: harvesterUid,
      uid: harvesterUid,
      kind: 'vehicle',
      type: params.get('harvester') || 'CMIN',
      owner: 0,
      ...at(position.x, position.y),
      facingRaw: position.facingRaw,
      health: 1,
      isSelected: false,
    },
  ];
}
const units = [
  ...(fxIds.includes('units') ? unitSet() : []),
  ...(fxIds.includes('squad') ? squadSet() : []),
  ...(fxIds.includes('infantry') ? infantrySet() : []),
  ...(fxIds.includes('parade') ? paradeSet() : []),
  ...extraObjects(),
];

/** Unit parade (?fx=parade): rows of mixed units for whole-roster reviews. */
function paradeSet(): LiveObject[] {
  const facing = Number(params.get('pface') ?? 24576);
  const seq = params.get('pseq') ?? 'Ready';
  const space = Number(params.get('pspace') ?? 1);
  const rows = (params.get('ptypes') ?? 'E1:0,MTNK:0|E2:1,HTNK:1')
    .split('|')
    .map((row) => row.split(',').filter(Boolean));
  const objects: LiveObject[] = [];
  const width = (kind: string) => (kind === 'infantry' ? 0.75 : kind === 'aircraft' ? 2.2 : 1.7) * space;
  rows.forEach((row, r) => {
    const entries = row.map((entry) => {
      const [type, owner] = entry.split(':');
      return { type: type!, owner: Number(owner ?? 0), kind: (libraryKinds[type!] ?? 'vehicle') as LiveObject['kind'] };
    });
    const total = entries.reduce((sum, e) => sum + width(e.kind), 0);
    let along = -total / 2;
    // Rows go down the screen (+1 map x and +1 map y), entries to the right (+1 map x, -1 map y).
    const down = (r - (rows.length - 1) / 2) * 1.5 * space;
    for (const e of entries) {
      const d = along + width(e.kind) / 2;
      along += width(e.kind);
      const uid = nextUid++;
      objects.push({
        id: uid,
        uid,
        kind: e.kind,
        type: e.type,
        owner: e.owner,
        ...at(cx + d / 2 + down, cy - d / 2 + down),
        facingRaw: facing,
        ...(e.kind === 'vehicle' || e.kind === 'aircraft' ? { turretFacingRaw: facing } : {}),
        ...(e.kind === 'infantry' ? { infantrySequence: seq, sequenceFrame: 0 } : {}),
        health: 1,
        isSelected: false,
      });
    }
  });
  return objects;
}

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
const shpReview = fxIds.includes('shpunits') ? shpUnitReview(params, cx, cy, levelAt(cx, cy) * 104, nextUid) : [];
nextUid += shpReview.length;
const animateShp = Number(params.get('animate') ?? 0);
const spread = Number(params.get('spread') ?? 1.6);
const offsets = params
  .get('at')
  ?.split(';')
  .map((pair) => pair.split(',').map(Number) as [number, number])
  .filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y));
const anims: LiveAnim[] = fxIds
  .filter((id) => !['units', 'squad', 'infantry', 'bldgs', 'shpunits', 'parade', 'beams'].includes(id))
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
const delays = (params.get('delay') ?? '')
  .split(',')
  .filter((v) => v !== '')
  .map(Number);
const periods = (params.get('period') ?? '')
  .split(',')
  .filter((v) => v !== '')
  .map(Number);
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
const smudgeLibrary = params.get('crater') === '1' ? (benchLibrary?.smudges ?? {}) : null;
const craterCells = new Map<number, { type: string; age: number }>();
let smudgeRevision = 1;

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

/** Fixed native ribbon/wave publications, independent of warm-up and animation time. */
function benchRibbons(): { radBeams: LiveRadBeam[]; waves: LiveWave[] } {
  if (!fxIds.includes('beams') || spawned === null) return { radBeams: [], waves: [] };
  const value = Number(params.get('bprogress') ?? 0.5);
  const progress = Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0.5;
  const ends = (row: number) => {
    const down = (row - 2) * 1.2 + 0.5;
    const source = at(cx + down - 2.5, cy + down + 2.5);
    const target = at(cx + down + 2.5, cy + down - 2.5);
    source.z += 104;
    target.z += 104;
    return { source, target };
  };
  return {
    radBeams: (['rad', 'temporal', 'eruption'] as const).map((type, row) => ({
      id: 60_000 + row,
      type,
      ...ends(row),
      color: [70, 255, 90],
      period: 20,
      amplitude: 40,
      age: progress * 20,
      sustained: false,
      progress,
    })),
    waves: (['magnetron', 'sonic'] as const).map((type, row) => ({
      id: 60_003 + row,
      uid: 60_003 + row,
      type,
      ...ends(row + 3),
      intensity: 100 * (1 - progress),
      progress,
    })),
  };
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
  const harvesters = harvestObjects();
  const listed = anims.map((a, i) => listedAnim(a, i)).filter((a): a is LiveAnim => !!a);
  listed.push(...buildingLayerAnims());
  return {
    frame,
    view,
    houses,
    // Delaying first appearance lets LiveView's normal make timeline start at the spawn frame.
    objects: ((objs: LiveObject[]) => [
      ...harvesters,
      ...(animateInfantry
        ? objs.map((u) => (u.infantrySequence ? { ...u, sequenceFrame: Math.floor(frame / animateInfantry) } : u))
        : objs),
      ...(shpReview.length ? advanceShpReview(shpReview, spawned === null ? 0 : frame - spawned, animateShp) : []),
    ])(makeBuildings && (spawned === null || frame < spawned) ? units : allObjects),
    effects: {
      anims: listed,
      bullets: [],
      particleSystems: [],
      beams: benchBeams(),
      ...(fxIds.includes('beams') ? benchRibbons() : {}),
    },
    ...(smudgeLibrary ? { smudges: smudgeGrid() } : {}),
    ...(oreGrid ? { overlays: oreGrid, localHouse: 0 } : {}),
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
