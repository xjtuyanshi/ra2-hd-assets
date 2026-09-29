import GUI from 'three/addons/libs/lil-gui.module.min.js';
import { Vector3 } from 'three/webgpu';
import { mapAtmosphere, medianHeight, sidecarAtmosphere } from '../../ra2-assets/src/lights';
import { HdRenderer, type ToneMapper } from '../src/HdRenderer';
import type { RenderEvent, RenderObject, RenderState, Weather } from '../src/contract';
import { createScenario } from './scenario';
import { loadRa2World } from '../src/ra2/world';

const canvas = document.querySelector<HTMLCanvasElement>('#view')!;
const hud = document.querySelector<HTMLElement>('#hud')!;
const params = new URLSearchParams(location.search);
const state: RenderState = createScenario();
// Deterministic preset hooks for screenshots: ?time=20&weather=rain
if (params.has('time')) state.environment.timeOfDay = Number(params.get('time'));
if (params.has('weather')) state.environment.weather = params.get('weather') as Weather;

// ?map=<name> draws an original map from the local HD cache (pnpm hd:extract) instead of the procedural scenario.
const mapName = params.get('map');
// ?units=1 parks the extracted voxel vehicles near the start point, in all eight facings, to review them.
const world = mapName
  ? await loadRa2World(`/${encodeURIComponent(mapName)}`, {
      // ?tmap=0 draws the per-tile atlas instead of the (AI-upscaled) whole-map terrain image, for A/B review.
      terrainMap: params.get('tmap') !== '0',
      hdSprites: params.get('hdsprites') !== '0',
      extraObjects: (manifest) => {
        if (!params.has('units')) return [];
        const start = manifest.waypoints.find((w) => w.id === 0) ?? manifest.waypoints[0] ?? { x: 50, y: 50 };
        const owner = Object.keys(manifest.houses ?? {})[0];
        return Object.keys(manifest.voxels).flatMap((voxel, row) =>
          Array.from({ length: 8 }, (_, i) => ({
            kind: 'vehicle' as const,
            type: voxel,
            voxel,
            owner,
            x: start.x - 4 + i * 1.5,
            y: start.y - 5 + row * 1.6,
            z: 0,
            facing: i * 32,
          })),
        );
      },
    })
  : undefined;
if (world?.cache) {
  state.objects = [];
  // The map's own [Lighting] (engine-exact from the light sidecar, else the manifest's) stages it: day, dusk or night.
  const { manifest, lights } = world.cache;
  const lighting = lights?.lighting.normal ?? manifest.lighting ?? state.map.lighting;
  state.map.lighting = lighting;
  // Recomputed from the sidecar's raw [Lighting] and lamp posts, so a sidecar written by an older classifier stages
  // the map like the current one.
  state.map.atmosphere = lights
    ? sidecarAtmosphere(lights)
    : mapAtmosphere(lighting, medianHeight(world.cache.height, world.cache.exists));
  // Without ?time the map decides (noon for day maps, as before).
  if (!params.has('time')) state.environment.timeOfDay = state.map.atmosphere.hour;
}
const hd = new HdRenderer(canvas, state, {
  forceWebGL: params.get('webgl') === '1',
  requiredLimits: await HdRenderer.adapterLimits(),
  // ?perf=1: GPU timestamp queries (window.__hd.stats().gpuMs).
  trackTimestamp: params.get('perf') === '1',
});
// Night presentation: ?lights=0 (map light sources off), ?lamps=auto|on|off, ?windows=0|1, ?mist=<x>, ?nightlevel=<x>.
const atmosphere = hd.atmosphere;
if (params.get('lights') === '0') atmosphere.lights = false;
const lamps = params.get('lamps');
if (lamps === 'on' || lamps === 'off' || lamps === 'auto') atmosphere.lamps = lamps;
if (params.has('windows')) atmosphere.windows = params.get('windows') !== '0';
if (params.has('mist')) atmosphere.mist = Number(params.get('mist'));
if (params.has('nightlevel')) atmosphere.nightLevel = Number(params.get('nightlevel'));
await hd.init(world);
// ?wet=<0..1>: start with wet ground (rain wets surfaces over a few seconds otherwise).
if (params.has('wet') && world) world.terrain.wetness.value = Math.min(1, Math.max(0, Number(params.get('wet'))));
// Development handle for inspecting the scene from the console.
const handle = { hd, world, state, stats: () => hd.stats(), fires: [] as { at: Vector3; scale: number }[] };
(window as unknown as { __hd: unknown }).__hd = handle;
hd.setState(state);

// Fixed camera presets for comparable screenshots: ?cx=12&cy=44&zoom=0.8
if (params.has('cx')) hd.view.target.x = Number(params.get('cx'));
if (params.has('cy')) hd.view.target.z = Number(params.get('cy'));
if (params.has('zoom')) hd.view.zoom = Number(params.get('zoom'));
if (params.has('rain')) state.environment.weatherIntensity = Number(params.get('rain'));

const resize = () => hd.resize(canvas.clientWidth, canvas.clientHeight);
new ResizeObserver(resize).observe(canvas);
resize();

// ?fires=N: persistent fires (burning wrecks) at seeded spots within 6 cells of the view centre.
const fires: { at: Vector3; scale: number }[] = [];
{
  let seed = 12345;
  const random = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const count = Math.min(32, Math.max(0, Number(params.get('fires') ?? 0) || 0));
  for (let i = 0; i < count; i++) {
    const angle = random() * Math.PI * 2;
    const distance = 1.5 + random() * 4.5;
    const x = hd.view.target.x + Math.cos(angle) * distance;
    const z = hd.view.target.z + Math.sin(angle) * distance;
    const y = world ? world.terrain.heightAt(x, z) : 0;
    fires.push({ at: new Vector3(x, y + 0.05, z), scale: 0.8 + random() * 0.4 });
  }
}
const fireWind = new Vector3(0.15, 0, 0.05);
handle.fires = fires;

// --- scripted motion: allied tanks patrol, turrets track the nearest enemy, enemy tanks idle-rotate ---
const allied = state.objects.filter((o) => o.kind === 'vehicle' && o.house === 1);
const enemy = state.objects.filter((o) => o.kind === 'vehicle' && o.house === 2);
const ship = state.objects.find((o) => o.kind === 'ship');
const home = new Map(allied.map((o) => [o.id, { x: o.x, y: o.y }]));
let eventId = 1;
const pending: RenderEvent[] = [];
const ui = { battle: params.get('battle') !== '0' };

function step(dt: number, t: number): void {
  allied.forEach((tank, i) => {
    const base = home.get(tank.id)!;
    const angle = t * 0.25 + i;
    const nx = base.x + Math.cos(angle) * 1.6;
    const ny = base.y + Math.sin(angle) * 1.6;
    tank.facing = Math.atan2(ny - tank.y, nx - tank.x);
    tank.x = nx;
    tank.y = ny;
    const target = nearest(tank, enemy);
    if (target)
      tank.turretFacing = approachAngle(
        tank.turretFacing ?? tank.facing,
        Math.atan2(target.y - tank.y, target.x - tank.x),
        dt * 2,
      );
  });
  enemy.forEach((tank, i) => {
    const target = nearest(tank, allied);
    tank.facing = approachAngle(tank.facing, 2.3 + Math.sin(t * 0.3 + i) * 0.4, dt);
    if (target)
      tank.turretFacing = approachAngle(
        tank.turretFacing ?? tank.facing,
        Math.atan2(target.y - tank.y, target.x - tank.x),
        dt * 2,
      );
  });
  if (ship) {
    ship.x = 9 + Math.sin(t * 0.08) * 4;
    ship.y = 46 + Math.cos(t * 0.08) * 2;
    ship.facing = Math.atan2(
      Math.cos(t * 0.08 + 0.01) * 2 - Math.cos(t * 0.08) * 2,
      Math.sin(t * 0.08 + 0.01) * 4 - Math.sin(t * 0.08) * 4,
    );
  }
}

function nearest(from: RenderObject, list: RenderObject[]): RenderObject | undefined {
  let best: RenderObject | undefined;
  let bestDistance = Infinity;
  for (const other of list) {
    const d = Math.hypot(other.x - from.x, other.y - from.y);
    if (d < bestDistance) {
      bestDistance = d;
      best = other;
    }
  }
  return best;
}

function approachAngle(current: number, target: number, maxStep: number): number {
  const delta = Math.atan2(Math.sin(target - current), Math.cos(target - current));
  return current + Math.max(-maxStep, Math.min(maxStep, delta));
}

function explosionAt(x: number, y: number, scale: number): void {
  pending.push({ id: eventId++, tick: state.tick, kind: 'explosion', type: 'EXPLOLRG', x, y, z: 0, scale });
}

// --- input: drag to pan, wheel to zoom, WASD/arrows, click to detonate ---
let dragging = false;
let moved = 0;
canvas.addEventListener('pointerdown', (e) => {
  dragging = true;
  moved = 0;
  canvas.setPointerCapture(e.pointerId);
});
canvas.addEventListener('pointermove', (e) => {
  if (!dragging) return;
  moved += Math.abs(e.movementX) + Math.abs(e.movementY);
  hd.view.panPixels(e.movementX, e.movementY);
});
canvas.addEventListener('pointerup', (e) => {
  dragging = false;
  if (moved < 4) {
    const p = hd.pick(e.clientX, e.clientY);
    if (p) explosionAt(p.x, p.z, 1.2);
  }
});
canvas.addEventListener(
  'wheel',
  (e) => {
    e.preventDefault();
    hd.view.zoom = Math.min(2.5, Math.max(0.6, hd.view.zoom * Math.exp(-e.deltaY * 0.0015)));
    resize();
  },
  { passive: false },
);
const keys = new Set<string>();
addEventListener('keydown', (e) => keys.add(e.key.toLowerCase()));
addEventListener('keyup', (e) => keys.delete(e.key.toLowerCase()));

// --- controls ---
const gui = new GUI({ title: 'HD 沙盘 v0（占位素材）' });
const env = state.environment;
gui.add(env, 'timeOfDay', 0, 24, 0.1).name('时间（小时）');
gui.add(env, 'weather', { 晴: 'clear', 雨: 'rain', 暴雨: 'storm' }).name('天气');
gui.add(env, 'weatherIntensity', 0, 1, 0.01).name('雨量');
gui.add(env, 'windStrength', 0, 1, 0.01).name('风力');
gui.add(ui, 'battle').name('自动交火');
const night = gui.addFolder('夜景');
night.add(atmosphere, 'lights').name('地图光源');
night.add(atmosphere, 'lamps', { 自动: 'auto', 开: 'on', 关: 'off' }).name('HD 路灯');
night.add(atmosphere, 'windows').name('窗户灯光');
night.add(atmosphere, 'mist', 0, 3, 0.05).name('薄雾倍数');
const wetness = world?.terrain.wetness;
if (wetness) night.add(wetness, 'value', 0, 1, 0.01).name('地面湿度').listen();
const look = gui.addFolder('画质');
look
  .add(hd.settings, 'toneMapper', { Neutral: 'neutral', AgX: 'agx', ACES: 'aces' } satisfies Record<string, ToneMapper>)
  .name('色调映射')
  .onChange(() => hd.applySettings());
look.add(hd.settings, 'exposure', 0.4, 2, 0.01).name('曝光');
look
  .add(hd.settings, 'bloom', 0, 1.5, 0.01)
  .name('泛光')
  .onChange(() => hd.applySettings());
look
  .add(hd.settings, 'vignette', 0, 0.8, 0.01)
  .name('暗角')
  .onChange(() => hd.applySettings());
look
  .add(hd.settings, 'shadows')
  .name('阴影')
  .onChange(() => hd.applySettings());
look
  .add(hd.settings, 'antialias')
  .name('抗锯齿 FXAA')
  .onChange(() => hd.applySettings());
if (params.has('nogui')) gui.hide();
if (params.has('nohud')) hud.hidden = true;

// --- loop ---
let last = performance.now();
let fpsFrames = 0;
let fpsTime = 0;
let fps = 0;
let nextShot = 0;
const start = performance.now();
function loop(now: number): void {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  const t = (now - start) / 1000;
  const pan = 600 * dt;
  if (keys.has('a') || keys.has('arrowleft')) hd.view.panPixels(pan, 0);
  if (keys.has('d') || keys.has('arrowright')) hd.view.panPixels(-pan, 0);
  if (keys.has('w') || keys.has('arrowup')) hd.view.panPixels(0, pan);
  if (keys.has('s') || keys.has('arrowdown')) hd.view.panPixels(0, -pan);

  step(dt, t);
  for (const [i, fire] of fires.entries())
    hd.effects.fire(hd.seconds(), fire.at, fire.scale, `sandbox-fire-${i}`, fireWind);
  // ?boom=1 on original maps: periodic explosions around the view centre (no scripted armies there).
  if (world && params.has('boom') && t > nextShot) {
    nextShot = t + 0.7 + Math.random() * 0.9;
    explosionAt(
      hd.view.target.x + (Math.random() - 0.5) * 10,
      hd.view.target.z + (Math.random() - 0.5) * 10,
      0.8 + Math.random(),
    );
  }
  if (ui.battle && t > nextShot && allied.length && enemy.length) {
    nextShot = t + 0.9 + Math.random() * 1.4;
    const targetList = Math.random() < 0.5 ? allied : enemy;
    const target = targetList[Math.floor(Math.random() * targetList.length)]!;
    explosionAt(target.x + (Math.random() - 0.5) * 2, target.y + (Math.random() - 0.5) * 2, 0.7 + Math.random() * 0.8);
  }
  state.tick++;
  state.events = pending.splice(0);
  hd.setState(state);
  hd.frame(dt);

  fpsFrames++;
  fpsTime += dt;
  if (fpsTime > 0.5) {
    fps = fpsFrames / fpsTime;
    fpsFrames = 0;
    fpsTime = 0;
    hud.textContent = `${hd.backend} · ${fps.toFixed(0)} fps · ${canvas.width}×${canvas.height}px · 拖动平移 · 滚轮缩放 · 点击地面=爆炸`;
  }
  schedule();
}

// ?perf=1 on WebGPU: frames run back to back, each waiting for the GPU to finish, so the frame interval
// (hd.stats().frameMs) is the frame's full cost, independent of the display's refresh rate.
const queue = (hd.renderer.backend as { device?: { queue: { onSubmittedWorkDone(): Promise<void> } } }).device?.queue;
const benchmark = params.get('perf') === '1' && !!queue;
const channel = new MessageChannel();
channel.port1.onmessage = () => loop(performance.now());
function schedule(): void {
  if (!benchmark) {
    requestAnimationFrame(loop);
    return;
  }
  void queue!.onSubmittedWorkDone().then(() => channel.port2.postMessage(0));
}
schedule();
