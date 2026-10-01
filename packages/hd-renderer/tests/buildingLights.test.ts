import { describe, expect, it, vi } from 'vitest';
import { Vector3 } from 'three/webgpu';
import {
  BuildingLightGate,
  buildingLightOverlay,
  buildingLightPlacements,
  buildingLightSources,
  BUILDING_LIGHTS,
} from '../src/live/buildingLights';
import { flicker, SHAPE_SOFT, sourceFade } from '../src/lightField';
import { LiveView, type LiveObject, type LiveSnapshot } from '../src/live/liveView';
import { LEVEL_HEIGHT } from '../src/world';

const reactor: LiveObject = {
  id: 10,
  uid: 42,
  type: 'NAPOWR',
  kind: 'building',
  owner: 0,
  x: 5 * 256 + 100,
  y: 7 * 256 + 20,
  z: 2 * 104,
  health: 1,
  facingRaw: 0,
  isSelected: false,
  buildState: 'done',
};
const foundation = (): [number, number] => [3, 2];
const select = (objects: LiveObject[] = [reactor], gain = 1, night = 0) =>
  buildingLightSources(objects, { sourceLights: gain, night }, foundation, () => false);

function srgb(v: number) {
  return v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055;
}

const ARC = BUILDING_LIGHTS.NAPOWR![0]!.arcStyle!;

describe('building light policy', () => {
  it('centres the soft pool on the foundation while retaining the head position and depth push', () => {
    const light = buildingLightPlacements('NAPOWR', reactor, [3, 2])[0]!;
    expect(light).toMatchObject({
      x: 6.5,
      z: 8,
      groundOnly: 1,
      key: 'building:42:0',
      radius: 2.6,
      shape: SHAPE_SOFT,
      glow: null,
      fadeIn: 0.5,
    });
    expect(light.hole).toBeUndefined();
    expect(light.holeOffset).toBeUndefined();
    const spec = BUILDING_LIGHTS.NAPOWR![0]!;
    expect(light.headPosition.x).toBeCloseTo(5 + spec.at[0] * 3);
    expect(light.headPosition.z).toBeCloseTo(7 + spec.at[1] * 2);
    expect(light.headPosition.y).toBeCloseTo(2 * LEVEL_HEIGHT + (spec.height / 15) * LEVEL_HEIGHT);
    expect(light.push).toBeGreaterThan(0.15);
    expect(buildingLightPlacements('UNKNOWN', reactor, [3, 2])).toEqual([]);
  });
  it('preserves the refinery rectangle and factory/Tesla specs', () => {
    const light = buildingLightPlacements('NAREFN', reactor, [4, 2])[0]!;
    expect(light).toMatchObject({ x: 7, z: 8, hole: [2, 1], holeOffset: [0, 0], groundOnly: 1 });
    expect(BUILDING_LIGHTS.TESLA![0]!.colour).toEqual([0.3, 1.4, 7]);
    expect(BUILDING_LIGHTS.NAWEAP![0]!.colour).toEqual([2.6, 1.5, 0.55]);
    expect(BUILDING_LIGHTS.GAWEAP![0]!.colour).toEqual([2.3, 1.7, 1]);
  });
  it('authors a saturated blue body in display-linear colour and a contained daytime pool', () => {
    const light = select()[0]!;
    const body = light.orb!.body.map(srgb);
    const [r, g, b] = body as [number, number, number];
    const hue = 60 * ((r - g) / (b - r) + 4);
    expect(hue).toBeGreaterThanOrEqual(215);
    expect(hue).toBeLessThanOrEqual(235);
    expect((b - r) / b).toBeGreaterThanOrEqual(0.6);
    expect(body.map((v) => Math.round(v * 255))).toEqual([55, 115, 255]);
    expect(0.2126 * light.colour[0] + 0.7152 * light.colour[1] + 0.0722 * light.colour[2]).toBeLessThanOrEqual(0.2);
    // The disc covers the art's whole glass sphere (about 16.5 engine px) with a contained halo.
    expect(light.orb).toMatchObject({
      radius: 0.55,
      coreRadius: 0.42,
      bodyStart: 0.68,
      bodyEnd: 0.88,
      alpha: 1,
      coreAlpha: 1,
      bodyAlpha: 0.7,
      limbAlpha: 0.88,
      filamentMix: 0.75,
      haloScale: 1.4,
      haloAlpha: 0.4,
    });
    expect(select([reactor], 1, 1)[0]!.colour).toEqual([0.75, 2.1, 12.75]);
  });
  it('keeps the hot core cyan-white and authors saturated body, limb and filament colours', () => {
    const orb = select()[0]!.orb!;
    const colours = {
      hot: [205, 250, 255],
      mid: [100, 200, 255],
      body: [55, 115, 255],
      limb: [110, 175, 255],
      filaments: [165, 235, 255],
      halo: [45, 95, 255],
    } as const;
    for (const name of Object.keys(colours) as (keyof typeof colours)[])
      expect(orb[name].map((v) => Math.round(srgb(v) * 255))).toEqual(colours[name]);
    expect(ARC.core.map((v) => Math.round(srgb(v) * 255))).toEqual([210, 250, 255]);
    expect(ARC.edge.map((v) => Math.round(srgb(v) * 255))).toEqual([45, 110, 255]);
    expect(ARC).toMatchObject({ width: 3.2, forkWidth: 2.2, coreFraction: 0.45, reach: [0.5, 1.15], crawl: 0.4 });
    const [r, g, b] = orb.hot.map(srgb) as [number, number, number];
    expect(60 * ((r - g) / (b - r) + 4)).toBeLessThanOrEqual(195);
    const luminance = 0.2126 * orb.hot[0] + 0.7152 * orb.hot[1] + 0.0722 * orb.hot[2];
    expect(116 * Math.cbrt(luminance) - 16).toBeGreaterThan(92);
    const mid = orb.mid.map(srgb) as [number, number, number];
    expect((mid[2] - mid[0]) / mid[2]).toBeGreaterThanOrEqual(0.5);
  });
  it('creates nothing at zero gain without querying foundations or visibility', () => {
    const size = vi.fn(foundation);
    const hidden = vi.fn(() => false);
    expect(buildingLightSources([reactor], { sourceLights: 0 }, size, hidden)).toEqual([]);
    expect(size).not.toHaveBeenCalled();
    expect(hidden).not.toHaveBeenCalled();
  });
  it('filters dead, hidden, constructing, selling, non-building and unknown-foundation objects', () => {
    expect(
      select([
        { ...reactor, health: 0 },
        { ...reactor, buildState: 'building' },
        { ...reactor, buildState: 'selling' },
        { ...reactor, kind: 'vehicle' },
        { ...reactor, buildState: undefined },
      ]),
    ).toEqual([]);
    expect(buildingLightSources([reactor], { sourceLights: 1 }, foundation, () => true)).toEqual([]);
    expect(
      buildingLightSources(
        [reactor],
        { sourceLights: 1 },
        () => undefined,
        () => false,
      ),
    ).toEqual([]);
  });
  it('scales irradiance by gain/damage and retains legacy Tesla glow scaling', () => {
    const normal = select()[0]!;
    const damaged = select([{ ...reactor, health: 0.4 }], 2)[0]!;
    for (let c = 0; c < 3; c++) expect(damaged.colour[c]).toBeCloseTo(normal.colour[c]! * 1.2);
    expect(damaged.glow).toBeNull();
    const coil = { ...reactor, type: 'TESLA' };
    const a = select([coil])[0]!;
    const b = select([{ ...coil, buildingDamaged: true }], 2)[0]!;
    expect(b.glow![2]).toBeCloseTo(a.glow![2]!);
  });
  it('updates the overlay independently of native beams and removes all sources on a faithful switch', () => {
    const source = vi.fn();
    const clearSources = vi.fn();
    const retainSources = vi.fn();
    const setDiscs = vi.fn();
    const setStrokes = vi.fn();
    const setDecorativeBeams = vi.fn();
    const toCamera = new Vector3(1, Math.SQRT2, 1).normalize();
    const settings = { sourceLights: 0 };
    const view = Object.assign(Object.create(LiveView.prototype), {
      hd: {
        settings,
        seconds: () => 2,
        lightField: { source, clearSources, retainSources, sourceFade: () => 1 },
        emitters: { lampGain: { value: 0 } },
        emissiveOverlay: { setDiscs, setStrokes, toCamera: { value: toCamera } },
      },
      library: { type: () => ({ foundation: foundation() }), conditionYellow: 0.5 },
      shroud: { isLocationShrouded: () => false },
      effectDriver: { setDecorativeBeams },
      buildingLightGate: new BuildingLightGate(),
      activeSourceKeys: new Set(),
      sourceLightsActive: false,
    }) as { updateBuildingLights(snapshot: LiveSnapshot): void };
    const snapshot: LiveSnapshot = { frame: 10, view: null, objects: [reactor], houses: [] };
    view.updateBuildingLights(snapshot);
    expect(source).not.toHaveBeenCalled();
    settings.sourceLights = 1;
    view.updateBuildingLights(snapshot);
    expect(source).toHaveBeenCalledWith('building:42:0', 2, expect.objectContaining({ glow: null }));
    expect(setDiscs.mock.calls[0]![0]).toHaveLength(1);
    expect(setStrokes.mock.calls[0]![0].filter((s: { width: number }) => s.width === ARC.width)).toHaveLength(5);
    const lights = select().map((light) => ({ ...light, fade: 1 }));
    expect(setStrokes.mock.calls[0]![0]).toEqual(buildingLightOverlay(lights, snapshot.frame, 2, toCamera).strokes);
    expect(setDecorativeBeams).not.toHaveBeenCalled();
    view.updateBuildingLights({ ...snapshot, objects: [{ ...reactor, health: 0 }] });
    expect(retainSources).toHaveBeenLastCalledWith(new Set());
    expect(setDiscs).toHaveBeenLastCalledWith([]);
    settings.sourceLights = 0;
    view.updateBuildingLights(snapshot);
    expect(clearSources).toHaveBeenCalledTimes(1);
    expect(setStrokes).toHaveBeenLastCalledWith([]);
  });
});

describe('building state gate', () => {
  it('rejects placement sentinels and build-up until done, then fades over half a second', () => {
    const gate = new BuildingLightGate();
    gate.update([], 0, 0);
    const b = { ...reactor, buildState: undefined };
    for (let f = 1; f <= 3; f++) {
      gate.update([b], f, f / 15);
      expect(gate.allowed(b)).toBe(false);
    }
    for (let f = 4; f <= 43; f++) {
      gate.update([{ ...b, buildState: 'building' }], f, f / 15);
      expect(gate.allowed(b)).toBe(false);
    }
    gate.update([reactor], 44, 3);
    expect(gate.allowed(reactor)).toBe(true);
    const light = buildingLightSources([reactor], { sourceLights: 1 }, foundation, () => false, 0.5, gate)[0]!;
    for (const [time, expected] of [
      [3, 0],
      [3.25, 0.5],
      [3.5, 1],
    ])
      expect(sourceFade(time!, light.fadeStart!, light.fadeIn)).toBeCloseTo(expected!);
  });
  it('lights first-snapshot sandbox objects immediately, including t=0.7 bench renders', () => {
    const gate = new BuildingLightGate();
    const b = { ...reactor, buildState: undefined };
    gate.update([b], 10, 0.7);
    expect(gate.allowed(b)).toBe(true);
    expect(sourceFade(0.7, gate.fadeStart(b)!, 0.5)).toBe(1);
  });
  it('requires 30 logic frames of unknown state and repeated presentations cannot advance the gate', () => {
    const gate = new BuildingLightGate();
    const b = { ...reactor, buildState: undefined };
    gate.update([], 0, 0);
    gate.update([b], 1, 0);
    for (let i = 0; i < 60; i++) gate.update([b], 1, i / 60);
    expect(gate.allowed(b)).toBe(false);
    gate.update([b], 29, 2);
    expect(gate.allowed(b)).toBe(false);
    gate.update([b], 30, 2.1);
    expect(gate.allowed(b)).toBe(true);
    gate.update([{ ...b, buildState: 'selling' }], 31, 2.2);
    gate.update([b], 100, 3);
    expect(gate.allowed(b)).toBe(false);
    gate.update([{ ...b, buildState: 'done', health: 0 }], 101, 3.1);
    expect(gate.allowed(b)).toBe(false);
  });
});

describe('decorative unbloomed source overlay', () => {
  it('builds five jagged arcs with inner-joint forks, glow strokes and stable shapes for frame pairs', () => {
    const lights = select();
    const a = buildingLightOverlay(lights, 10, 1);
    expect(a).toEqual(buildingLightOverlay(lights, 10, 1));
    expect(a).toEqual(buildingLightOverlay(lights, 11, 1));
    expect(a).not.toEqual(buildingLightOverlay(lights, 12, 1));
    expect(a).not.toEqual(buildingLightOverlay([{ ...lights[0]!, key: 'other' }], 10, 1));
    const arcs = a.strokes.filter((s) => s.width === ARC.width);
    const forks = a.strokes.filter((s) => s.width === ARC.forkWidth);
    const glows = a.strokes.filter((s) => s.width > ARC.width);
    expect(arcs).toHaveLength(5);
    expect(forks.length).toBeGreaterThanOrEqual(5);
    expect(forks.length).toBeLessThanOrEqual(10);
    // Every crisp arc and fork has a wider, fainter glow stroke in the edge colour drawn before it.
    expect(glows).toHaveLength(arcs.length + forks.length);
    glows.forEach((g) => {
      expect(g.core).toEqual(ARC.edge);
      expect(g.edge).toEqual(ARC.edge);
      expect(g.coreFraction).toBe(0);
    });
    for (let i = 0; i < a.strokes.length; i += 2) {
      const glow = a.strokes[i]!;
      const crisp = a.strokes[i + 1]!;
      expect(glow.points).toBe(crisp.points);
      expect(glow.width).toBeCloseTo(crisp.width * 3.5);
      expect(glow.alpha).toBeCloseTo(crisp.alpha * 0.5);
      expect(crisp.coreFraction).toBe(ARC.coreFraction);
    }
    arcs.forEach((s) => {
      expect(s.points.length).toBeGreaterThanOrEqual(7);
      expect(s.points.length).toBeLessThanOrEqual(10);
    });
    forks.forEach((f) => {
      const parent = arcs.find((a) => a.points.includes(f.points[0]!))!;
      const joint = parent.points.indexOf(f.points[0]!);
      const distances = parent.points.slice(1).map((p, i) => {
        const q = parent.points[i]!;
        return Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z);
      });
      const t = distances.slice(0, joint).reduce((a, b) => a + b, 0) / distances.reduce((a, b) => a + b, 0);
      expect(t).toBeGreaterThanOrEqual(0.3);
      expect(t).toBeLessThanOrEqual(0.5);
    });
    for (const s of [...arcs, ...forks]) {
      expect(s.alpha).toBeGreaterThanOrEqual(0.7);
      expect(s.alpha).toBeLessThanOrEqual(1);
    }
    for (const s of glows) {
      expect(s.alpha).toBeGreaterThanOrEqual(0.7 * 0.5);
      expect(s.alpha).toBeLessThanOrEqual(0.5);
    }
  });
  it('keeps crawling arcs over the glass and outgoing arcs within the authored reach with downward bias', () => {
    const l = select()[0]!;
    const arcs = buildingLightOverlay([l], 10, 1).strokes.filter((s) => s.width === ARC.width);
    for (let i = 0; i < 5; i++) {
      const s = arcs[i]!;
      const a = s.points[0]!;
      const b = s.points.at(-1)!;
      if ([2, 4].includes(i)) {
        for (const p of s.points)
          expect(Math.hypot(p.x - l.headPosition.x, p.y - l.headPosition.y, p.z - l.headPosition.z)).toBeCloseTo(
            l.orb!.radius * 1.04,
          );
      } else {
        expect(Math.hypot(a.x - l.headPosition.x, a.y - l.headPosition.y, a.z - l.headPosition.z)).toBeCloseTo(
          l.orb!.radius,
        );
        const d = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
        expect(d).toBeGreaterThanOrEqual(ARC.reach[0]);
        expect(d).toBeLessThanOrEqual(ARC.reach[1]);
        expect(b.y - a.y).toBeLessThanOrEqual(d * 0.25);
      }
    }
  });
  it.each([new Vector3(0, 0, 1), new Vector3(1, Math.SQRT2, 1).normalize()])(
    'keeps outgoing arcs in the screen plane without changing camera or frame-pair seeding (%j)',
    (toCamera) => {
      const l = select()[0]!;
      const originalCamera = toCamera.clone();
      for (let frame = 0; frame < 100; frame += 2) {
        const a = buildingLightOverlay([l], frame, 1, toCamera);
        expect(a).toEqual(buildingLightOverlay([l], frame + 1, 1, toCamera));
        const scaled = buildingLightOverlay([l], frame, 1, toCamera.clone().multiplyScalar(3));
        expect(scaled.strokes).toHaveLength(a.strokes.length);
        a.strokes.forEach((s, i) => {
          expect(scaled.strokes[i]!.points).toHaveLength(s.points.length);
          s.points.forEach((p, j) => {
            const q = scaled.strokes[i]!.points[j]!;
            expect(p.x).toBeCloseTo(q.x, 12);
            expect(p.y).toBeCloseTo(q.y, 12);
            expect(p.z).toBeCloseTo(q.z, 12);
          });
        });
        const arcs = a.strokes.filter((s) => s.width === ARC.width);
        arcs.forEach((s, i) => {
          if (Math.floor((i + 1) * ARC.crawl) > Math.floor(i * ARC.crawl)) return;
          const start = new Vector3().copy(s.points[0]!);
          const end = new Vector3().copy(s.points.at(-1)!);
          expect(Math.abs(end.sub(start).normalize().dot(toCamera))).toBeLessThanOrEqual(0.5 + 1e-12);
          expect(start.distanceTo(l.headPosition)).toBeCloseTo(l.orb!.radius);
        });
      }
      expect(toCamera).toEqual(originalCamera);
      expect(buildingLightOverlay([l], 10, 1, new Vector3())).toEqual(buildingLightOverlay([l], 10, 1));
    },
  );
  it('shares field flicker, fades the orb alpha, and starts arcs only after half fade', () => {
    const l = select()[0]!;
    for (const fade of [0, 0.5, 1]) {
      const a = buildingLightOverlay([{ ...l, fade }], 10, 1);
      expect(a.discs[0]!.alpha).toBe(fade);
      expect(a.discs[0]!.brightness).toBe(flicker(l.seed!, 1, 0.12));
      if (fade <= 0.5) expect(a.strokes).toEqual([]);
      else expect(a.strokes.length).toBeGreaterThan(5);
    }
    const first = buildingLightOverlay([l], 10, 1);
    const next = buildingLightOverlay([l], 10, 1.016);
    expect(first.strokes.map((s) => s.points)).toEqual(next.strokes.map((s) => s.points));
    expect(first.strokes.map((s) => s.alpha)).not.toEqual(next.strokes.map((s) => s.alpha));
    expect(buildingLightOverlay(select([{ ...reactor, type: 'TESLA' }]), 10, 1)).toEqual({ discs: [], strokes: [] });
  });
});
