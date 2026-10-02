import { describe, expect, it, vi } from 'vitest';
import { Vector3 } from 'three/webgpu';
import {
  BuildingLightGate,
  buildingLightOverlay,
  buildingLightPlacements,
  buildingLightSources,
  BUILDING_LIGHTS,
  filamentSlotAngle,
  type BuildingLightCamera,
} from '../src/live/buildingLights';
import { flicker, SHAPE_SOFT, sourceFade } from '../src/lightField';
import { LiveView, type LiveObject, type LiveSnapshot } from '../src/live/liveView';
import { IsoCamera, LEVEL_HEIGHT, PIXELS_PER_CELL_EDGE } from '../src/world';
import { orbOccluded, type EmissiveStroke, type OverlayPoint } from '../src/emissiveOverlay';

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

const luminance = ([r, g, b]: readonly number[]) => 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
const REACTOR = BUILDING_LIGHTS.NAPOWR![0]!;
const ARC = REACTOR.arcStyle!;
const iso = new IsoCamera();
iso.update();
const camera: BuildingLightCamera = {
  right: new Vector3().setFromMatrixColumn(iso.camera.matrixWorld, 0),
  up: new Vector3().setFromMatrixColumn(iso.camera.matrixWorld, 1),
  toCamera: new Vector3().setFromMatrixColumn(iso.camera.matrixWorld, 2),
};
const cameraBases = [
  ['RA2', camera],
  ['front', { right: new Vector3(1, 0, 0), up: new Vector3(0, 1, 0), toCamera: new Vector3(0, 0, 1) }],
] as const;

describe('building light policy', () => {
  it.each([
    [undefined, 'ignore', 1],
    [undefined, 'mirror', 1],
    ['none', 'ignore', 0],
    ['none', 'mirror', 0],
    ['shown', 'ignore', 1],
    ['shown', 'mirror', 1],
    ['detail', 'ignore', 1],
    ['detail', 'mirror', 0],
  ] as const)(
    'selects ActiveAnim %s in %s mode without affecting unrelated lights',
    (activeAnim, nativeDetail, count) => {
      const selectMode = (type: string) =>
        buildingLightSources(
          [{ ...reactor, type, activeAnim }],
          { sourceLights: 1, nativeDetail },
          foundation,
          () => false,
        );
      const lights = selectMode('NAPOWR');
      expect(lights).toHaveLength(count);
      const overlay = buildingLightOverlay(
        lights.map((light) => ({ ...light, fade: 1 })),
        10,
        2,
        camera,
      );
      expect(overlay.discs).toHaveLength(count);
      expect(overlay.strokes.length > 0).toBe(count > 0);
      for (const type of Object.keys(BUILDING_LIGHTS).filter((type) => type !== 'NAPOWR')) {
        expect(selectMode(type)).toEqual(select([{ ...reactor, type }]));
        expect(BUILDING_LIGHTS[type]!.every((spec) => spec.activeAnim === undefined)).toBe(true);
      }
      expect(select([{ ...reactor, activeAnim: 'detail' }])).toHaveLength(1); // Default ignores native detail.
    },
  );
  it('centres the soft pool on the foundation while retaining the head position and depth push', () => {
    const light = buildingLightPlacements('NAPOWR', reactor, [3, 2])[0]!;
    expect(light).toMatchObject({
      x: 6.5,
      z: 8,
      groundOnly: 1,
      key: 'building:42:0',
      radius: REACTOR.radius,
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
  it('tints the measured glass blue-violet without a white core, procedural filaments or halo', () => {
    const orb = select()[0]!.orb!;
    expect(orb).toEqual(REACTOR.orb);
    expect(orb).toMatchObject({
      radius: 0.418,
      filamentMix: 0,
      haloScale: 1,
      haloAlpha: 0,
      occluders: [{ corner: [0.648, -0.085], from: -22, to: 90 }],
    });
    expect(orb.radius * PIXELS_PER_CELL_EDGE).toBeCloseTo(17.75, 1);
    for (const alpha of [orb.coreAlpha, orb.bodyAlpha, orb.limbAlpha]) {
      expect(alpha).toBeGreaterThanOrEqual(0);
      expect(alpha).toBeLessThanOrEqual(0.35);
    }
    for (const name of ['hot', 'mid', 'body'] as const) {
      const channels = orb[name].map(srgb);
      const max = Math.max(...channels);
      expect(channels[2]).toBe(max);
      expect((max - Math.min(...channels)) / max).toBeGreaterThanOrEqual(0.4);
    }
  });
  it('contains the soft ground pool while preserving L5G daytime irradiance', () => {
    expect(REACTOR.radius).toBeLessThanOrEqual(1.5);
    expect(REACTOR.falloff).toBe('soft');
    expect(REACTOR.groundOnly).toBe(1);
    const day = REACTOR.colour.map((v) => v * REACTOR.day!);
    expect(select()[0]!.colour).toEqual(day);
    expect(select([reactor], 1, 1)[0]!.colour).toEqual(REACTOR.colour);
    expect(luminance(day)).toBeLessThanOrEqual(0.2);
    const l5g = 0.066 * luminance([0.75, 2.1, 12.75]);
    expect(Math.abs(luminance(day) - l5g) / l5g).toBeLessThanOrEqual(0.02);
  });
  it('authors thin internal lightning with at most one short strike into the cradle', () => {
    expect(ARC.width).toBeLessThanOrEqual(1.5);
    expect(ARC.glowAlpha).toBeLessThanOrEqual(0.3);
    expect(ARC.filaments).toEqual([3, 4]);
    expect(ARC.filamentEnd![1]).toBeLessThanOrEqual(0.85);
    expect(ARC.strikes[1]).toBeLessThanOrEqual(1);
    expect(ARC.maxBeyond).toBeLessThanOrEqual(10);
    expect(ARC.anchors.length).toBeGreaterThan(0);
    for (const [x, y] of ARC.anchors) {
      expect(y).toBeGreaterThanOrEqual(15);
      expect(Math.hypot(x, y)).toBeLessThanOrEqual(REACTOR.orb!.radius * PIXELS_PER_CELL_EDGE + ARC.maxBeyond);
    }
    expect(REACTOR.at).toEqual([0.47, 0.4]);
    expect(REACTOR.height).toBe(27);
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
    const settings = { sourceLights: 0 };
    const options: { nativeDetail: 'ignore' | 'mirror' } = { nativeDetail: 'ignore' };
    const view = Object.assign(Object.create(LiveView.prototype), {
      options,
      hd: {
        settings,
        seconds: () => 2,
        lightField: { source, clearSources, retainSources, sourceFade: () => 1 },
        emitters: { lampGain: { value: 0 } },
        emissiveOverlay: {
          setDiscs,
          setStrokes,
          cameraRight: { value: camera.right },
          cameraUp: { value: camera.up },
          toCamera: { value: camera.toCamera },
        },
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
    const arcCount = setStrokes.mock.calls[0]![0].filter((s: { width: number }) => s.width === ARC.width).length;
    expect(arcCount).toBeGreaterThanOrEqual(ARC.filaments[0] + ARC.strikes[0]);
    expect(arcCount).toBeLessThanOrEqual(ARC.filaments[1] + ARC.strikes[1]);
    const lights = select().map((light) => ({ ...light, fade: 1 }));
    expect(setStrokes.mock.calls[0]![0]).toEqual(buildingLightOverlay(lights, snapshot.frame, 2, camera).strokes);
    expect(setDecorativeBeams).not.toHaveBeenCalled();
    // Same-frame native gate changes clear the pool, orb and arcs together; mirror is an explicit review option.
    view.updateBuildingLights({ ...snapshot, objects: [{ ...reactor, activeAnim: 'none' }] });
    expect(retainSources).toHaveBeenLastCalledWith(new Set());
    expect(setDiscs).toHaveBeenLastCalledWith([]);
    expect(setStrokes).toHaveBeenLastCalledWith([]);
    view.updateBuildingLights({ ...snapshot, objects: [{ ...reactor, activeAnim: 'detail' }] });
    expect(setDiscs.mock.calls.at(-1)![0]).toHaveLength(1);
    options.nativeDetail = 'mirror';
    view.updateBuildingLights({ ...snapshot, objects: [{ ...reactor, activeAnim: 'detail' }] });
    expect(retainSources).toHaveBeenLastCalledWith(new Set());
    expect(setDiscs).toHaveBeenLastCalledWith([]);
    expect(setStrokes).toHaveBeenLastCalledWith([]);
    view.updateBuildingLights({ ...snapshot, objects: [{ ...reactor, activeAnim: 'shown' }] });
    expect(setDiscs.mock.calls.at(-1)![0]).toHaveLength(1);
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
  it.each(['ignore', 'mirror'] as const)('restarts the existing fade after ActiveAnim returns in %s mode', (mode) => {
    const gate = new BuildingLightGate();
    const lights = (b: LiveObject) =>
      buildingLightSources([b], { sourceLights: 1, nativeDetail: mode }, foundation, () => false, 0.5, gate);
    gate.update([reactor], 100, 1, mode);
    const initial = lights(reactor)[0]!;
    expect(sourceFade(1.5, initial.fadeStart!, initial.fadeIn)).toBe(1);
    const off: LiveObject = { ...reactor, activeAnim: mode === 'mirror' ? 'detail' : 'none' };
    gate.update([off], 100, 2, mode);
    expect(gate.allowed(off)).toBe(false);
    expect(lights(off)).toEqual([]);
    gate.update([{ ...reactor, activeAnim: 'shown' }], 100, 3, mode);
    const relit = lights({ ...reactor, activeAnim: 'shown' })[0]!;
    expect(gate.allowed(reactor)).toBe(true);
    expect(relit.fadeStart).toBe(3);
    expect(sourceFade(3, relit.fadeStart!, relit.fadeIn)).toBe(0);
    expect(sourceFade(3.25, relit.fadeStart!, relit.fadeIn)).toBe(0.5);
    gate.update([{ ...reactor, activeAnim: undefined }], 100, 3.5, mode);
    expect(lights(reactor)[0]!.fadeStart).toBe(3);
    gate.update([off], 1, 4, mode); // A frame rewind drops stale per-building state.
    expect(gate.allowed(off)).toBe(false);
  });

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

describe('confined unbloomed glass overlay', () => {
  const screen = (p: OverlayPoint, centre: Vector3, basis = camera) => {
    const delta = new Vector3().copy(p).sub(centre);
    return { x: delta.dot(basis.right) * PIXELS_PER_CELL_EDGE, y: -delta.dot(basis.up) * PIXELS_PER_CELL_EDGE };
  };
  const crisp = (strokes: EmissiveStroke[]) => strokes.filter((s) => s.coreFraction !== 0);
  const parents = (strokes: EmissiveStroke[]) => crisp(strokes).filter((s) => s.width === ARC.width);
  const isFilament = (s: EmissiveStroke, centre: Vector3, radius: number) =>
    // Filaments start near the centre; strikes start at 0.95 radii.
    new Vector3().copy(s.points[0]!).distanceTo(centre) < 0.95 * radius - 1e-8;

  it.each(cameraBases)('confines arcs and forks for 40 frame pairs in the %s screen plane', (_, basis) => {
    for (const light of [
      select()[0]!,
      { ...select()[0]!, key: 'second-reactor', headPosition: new Vector3(-2, 3, 1) },
    ]) {
      const original = { right: basis.right.clone(), up: basis.up.clone(), toCamera: basis.toCamera.clone() };
      const radius = light.orb!.radius * PIXELS_PER_CELL_EDGE;
      let filamentForks = 0;
      let strikeForks = 0;
      for (let frame = 0; frame < 80; frame += 2) {
        const a = buildingLightOverlay([light], frame, 1, basis);
        expect(a).toEqual(buildingLightOverlay([light], frame + 1, 1, basis));
        expect(a.strokes.map((s) => s.points)).not.toEqual(
          buildingLightOverlay([light], frame + 2, 1, basis).strokes.map((s) => s.points),
        );
        const arcs = parents(a.strokes);
        expect(arcs.length).toBeGreaterThanOrEqual(ARC.filaments[0] + ARC.strikes[0]);
        expect(arcs.length).toBeLessThanOrEqual(ARC.filaments[1] + ARC.strikes[1]);
        const filaments = arcs.filter((s) => isFilament(s, light.headPosition, light.orb!.radius));
        const strikes = arcs.filter((s) => !filaments.includes(s));
        expect(filaments.length).toBeGreaterThanOrEqual(ARC.filaments[0]);
        expect(filaments.length).toBeLessThanOrEqual(ARC.filaments[1]);
        expect(strikes.length).toBeGreaterThanOrEqual(ARC.strikes[0]);
        expect(strikes.length).toBeLessThanOrEqual(ARC.strikes[1]);
        for (const s of a.strokes) {
          expect(s.push).toBeCloseTo(a.discs[0]!.push + 0.05);
          for (const p of s.points) {
            const delta = new Vector3().copy(p).sub(light.headPosition);
            expect(Math.abs(delta.dot(basis.toCamera))).toBeLessThan(1e-6);
            expect(delta.length() * PIXELS_PER_CELL_EDGE).toBeLessThanOrEqual(radius + ARC.maxBeyond + 1e-8);
          }
        }
        for (const filament of filaments) {
          expect(filament.points.length).toBeGreaterThanOrEqual(6);
          expect(filament.points.length).toBeLessThanOrEqual(9);
          const r0 = new Vector3().copy(filament.points[0]!).distanceTo(light.headPosition) * PIXELS_PER_CELL_EDGE;
          const r1 = new Vector3().copy(filament.points.at(-1)!).distanceTo(light.headPosition) * PIXELS_PER_CELL_EDGE;
          expect(r0).toBeGreaterThanOrEqual(ARC.filamentStart![0] * radius - 1e-8);
          expect(r0).toBeLessThanOrEqual(ARC.filamentStart![1] * radius + 1e-8);
          expect(r1).toBeGreaterThanOrEqual(ARC.filamentEnd![0] * radius - 1e-8);
          expect(r1).toBeLessThanOrEqual(ARC.filamentEnd![1] * radius + 1e-8);
          const forks = crisp(a.strokes).filter(
            (s) => s.width === ARC.forkWidth && filament.points.includes(s.points[0]!),
          );
          expect(forks.length).toBeLessThanOrEqual(1);
          filamentForks += forks.length;
          for (const s of [filament, ...forks]) {
            for (const p of s.points) {
              const q = screen(p, light.headPosition, basis);
              expect(Math.hypot(q.x, q.y)).toBeLessThanOrEqual(0.95 * radius + 1e-8);
              for (const o of light.orb!.occluders ?? [])
                expect(orbOccluded(q.x / radius, q.y / radius, o)).toBe(false);
            }
            // Sample the segments too: safe vertices alone would permit a bolt to cut across the tower corner.
            for (let j = 1; j < s.points.length; j++) {
              for (let t = 0; t <= 1; t += 0.1) {
                const q = screen(new Vector3().copy(s.points[j - 1]!).lerp(s.points[j]!, t), light.headPosition, basis);
                for (const o of light.orb!.occluders ?? [])
                  expect(orbOccluded(q.x / radius, q.y / radius, o)).toBe(false);
              }
            }
          }
          for (const fork of forks) {
            const joint = filament.points.indexOf(fork.points[0]!);
            const lengths = filament.points
              .slice(1)
              .map((p, j) => new Vector3().copy(p).distanceTo(filament.points[j]!));
            const fraction = lengths.slice(0, joint).reduce((a, b) => a + b, 0) / lengths.reduce((a, b) => a + b, 0);
            expect(fraction).toBeGreaterThanOrEqual(0.55);
            expect(fraction).toBeLessThanOrEqual(0.8);
            expect(
              new Vector3().copy(fork.points.at(-1)!).distanceTo(light.headPosition) * PIXELS_PER_CELL_EDGE,
            ).toBeCloseTo(Math.min(0.95, ARC.filamentEnd![1]) * radius);
          }
        }
        for (const strike of strikes) {
          expect(strike.points.length).toBeGreaterThanOrEqual(5);
          expect(strike.points.length).toBeLessThanOrEqual(7);
          const start = screen(strike.points[0]!, light.headPosition, basis);
          expect(Math.hypot(start.x, start.y)).toBeCloseTo(0.95 * radius);
          const end = screen(strike.points.at(-1)!, light.headPosition, basis);
          const distance = Math.min(...ARC.anchors.map(([x, y]) => Math.hypot(end.x - x, end.y - y)));
          expect(distance).toBeLessThanOrEqual(3);
          const forks = crisp(a.strokes).filter(
            (s) => s.width === ARC.forkWidth && strike.points.includes(s.points[0]!),
          );
          expect(forks.length).toBeLessThanOrEqual(1);
          strikeForks += forks.length;
          for (const fork of forks) {
            expect(fork.points.length).toBeGreaterThanOrEqual(2);
            expect(fork.points.length).toBeLessThanOrEqual(3);
          }
        }
        // Every crisp arc/fork has its own wider glow immediately underneath, with the authored opacity multiplier.
        for (let i = 0; i < a.strokes.length; i += 2) {
          const glow = a.strokes[i]!;
          const bolt = a.strokes[i + 1]!;
          // The glow is the bolt's tail from its first vertex outside glowStart (at least the final segment).
          const from = bolt.points.findIndex(
            (p) =>
              new Vector3().copy(p).distanceTo(light.headPosition) * PIXELS_PER_CELL_EDGE >=
              ARC.glowStart! * radius - 1e-6,
          );
          const tail = bolt.points.slice(Math.min(from < 0 ? bolt.points.length - 2 : from, bolt.points.length - 2));
          expect(glow.points).toEqual(tail);
          for (const p of glow.points)
            expect(new Vector3().copy(p).distanceTo(light.headPosition) * PIXELS_PER_CELL_EDGE).toBeGreaterThanOrEqual(
              Math.min(
                ARC.glowStart! * radius,
                new Vector3().copy(bolt.points.at(-2)!).distanceTo(light.headPosition) * PIXELS_PER_CELL_EDGE,
              ) - 1e-6,
            );
          expect(glow.width).toBeCloseTo(bolt.width * ARC.glowWidth);
          expect(glow.alpha).toBeCloseTo(bolt.alpha * ARC.glowAlpha);
          expect(glow.core).toEqual(ARC.edge);
          expect(glow.coreFraction).toBe(0);
          expect(bolt.alpha).toBeGreaterThanOrEqual(0.7);
          expect(bolt.alpha).toBeLessThanOrEqual(1);
        }
      }
      expect(filamentForks).toBeGreaterThan(0);
      expect(strikeForks).toBeGreaterThan(0);
      expect(basis).toEqual(original);
    }
  });

  it.each(cameraBases)('keeps energy inside the glass or cradle over 200 frame pairs in the %s basis', (_, basis) => {
    const second: LiveObject = { ...reactor, id: 11, uid: 43, x: reactor.x + 4 * 256 };
    for (const objects of [[reactor], [reactor, second]]) {
      const lights = select(objects);
      let filamentForks = 0;
      let strikesSeen = 0;
      let strikeForks = 0;
      for (let frame = 0; frame < 400; frame += 2) {
        const overlay = buildingLightOverlay(lights, frame, 1, basis);
        expect(overlay.discs).toHaveLength(objects.length);
        expect(overlay).toEqual(buildingLightOverlay(lights, frame + 1, 1, basis));
        const checked = new Set<EmissiveStroke>();
        for (const light of lights) {
          const radius = light.orb!.radius * PIXELS_PER_CELL_EDGE;
          const limit = radius + ARC.maxBeyond;
          // The two foundations are disjoint, so the first point identifies each stroke's owner independently
          // of emission order. Check the combined overlay rather than generating each reactor in isolation.
          const strokes = overlay.strokes.filter((s) => {
            const p = screen(s.points[0]!, light.headPosition, basis);
            return Math.hypot(p.x, p.y) <= limit + 1e-8;
          });
          const arcs = parents(strokes);
          const strikes = arcs.filter((s) => !isFilament(s, light.headPosition, light.orb!.radius));
          expect(arcs.length).toBeGreaterThanOrEqual(ARC.filaments[0] + ARC.strikes[0]);
          expect(arcs.length).toBeLessThanOrEqual(ARC.filaments[1] + ARC.strikes[1]);
          strikesSeen += strikes.length;
          for (let i = 0; i < strokes.length; i += 2) {
            const glow = strokes[i]!;
            const bolt = strokes[i + 1]!;
            const isFork = bolt.width === ARC.forkWidth;
            const strike = strikes.find((s) => s === bolt || (isFork && s.points.includes(bolt.points[0]!)));
            if (isFork) {
              if (strike) strikeForks++;
              else filamentForks++;
            }
            // Classify the crisp path and apply its containment rule to both it and its glow, including forks.
            for (const stroke of [glow, bolt]) {
              expect(checked.has(stroke)).toBe(false);
              checked.add(stroke);
              for (const vertex of stroke.points) {
                const p = screen(vertex, light.headPosition, basis);
                const distance = Math.hypot(p.x, p.y);
                if (strike) {
                  expect(distance).toBeLessThanOrEqual(limit + 1e-8);
                  if (distance > 0.95 * radius + 1e-8) expect(p.y).toBeGreaterThanOrEqual(0.3 * radius - 1e-8);
                } else {
                  expect(distance).toBeLessThanOrEqual(0.95 * radius + 1e-8);
                }
              }
            }
          }
        }
        expect(checked.size).toBe(overlay.strokes.length);
      }
      // Exercise both exceptions and their forks; a run without strikes must not pass the cradle guarantee.
      expect(strikesSeen).toBeGreaterThan(0);
      expect(strikeForks).toBeGreaterThan(0);
      expect(filamentForks).toBeGreaterThan(0);
    }
  });

  it('preserves legacy filament ends and fork radii when filamentEnd is absent', () => {
    const light = select()[0]!;
    const style = { ...ARC, strikes: [0, 0] as const };
    delete style.filamentEnd;
    const legacy = { ...light, orb: { ...light.orb!, occluders: [] }, arcStyle: style };
    const radius = light.orb!.radius;
    let forksSeen = 0;
    for (let frame = 0; frame < 80; frame += 2) {
      const strokes = buildingLightOverlay([legacy], frame, 1, camera).strokes;
      const filaments = parents(strokes);
      expect(filaments.length).toBeGreaterThanOrEqual(style.filaments[0]);
      expect(filaments.length).toBeLessThanOrEqual(style.filaments[1]);
      for (const filament of filaments) {
        const end = new Vector3().copy(filament.points.at(-1)!).distanceTo(light.headPosition) / radius;
        expect(end).toBeGreaterThanOrEqual(0.92 - 1e-8);
        expect(end).toBeLessThanOrEqual(0.985 + 1e-8);
        const forks = crisp(strokes).filter(
          (s) => s.width === style.forkWidth && filament.points.includes(s.points[0]!),
        );
        forksSeen += forks.length;
        for (const fork of forks)
          expect(new Vector3().copy(fork.points.at(-1)!).distanceTo(light.headPosition) / radius).toBeCloseTo(0.95);
      }
    }
    expect(forksSeen).toBeGreaterThan(0);
  });

  it('drifts persistent slot phases by crawl per frame while pair sampling preserves shapes', () => {
    const light = select()[0]!;
    const unmasked = { ...light, orb: { ...light.orb!, occluders: [] } };
    for (let slot = 0; slot < ARC.filaments[1]; slot++) {
      for (let frame = 0; frame < 80; frame++) {
        expect(
          filamentSlotAngle(light.key, slot, frame + 1, ARC.crawl) -
            filamentSlotAngle(light.key, slot, frame, ARC.crawl),
        ).toBeCloseTo(ARC.crawl, 12);
      }
    }
    // With identical seeding, changing crawl must rotate each actual filament slot by pairFrame * deltaCrawl.
    const frame = 20;
    const a = parents(buildingLightOverlay([unmasked], frame, 1, camera).strokes);
    const b = parents(
      buildingLightOverlay([{ ...unmasked, arcStyle: { ...ARC, crawl: 0 } }], frame, 1, camera).strokes,
    );
    a.filter((s) => isFilament(s, light.headPosition, light.orb!.radius)).forEach((s, slot) => {
      const p = screen(s.points.at(-1)!, light.headPosition);
      const q = screen(b[slot]!.points.at(-1)!, light.headPosition);
      const delta = Math.atan2(p.y, p.x) - Math.atan2(q.y, q.x);
      expect(Math.atan2(Math.sin(delta), Math.cos(delta))).toBeCloseTo(frame * ARC.crawl, 12);
      const noise = Math.atan2(p.y, p.x) - filamentSlotAngle(light.key, slot, frame, ARC.crawl);
      expect(Math.abs(Math.atan2(Math.sin(noise), Math.cos(noise)))).toBeLessThanOrEqual(0.3);
    });
    expect(buildingLightOverlay([light], 10, 1)).toEqual(buildingLightOverlay([light], 10, 1, camera));
    expect(buildingLightOverlay([light], 10, 1).strokes.map((s) => s.points)).not.toEqual(
      buildingLightOverlay([{ ...light, key: 'other' }], 10, 1).strokes.map((s) => s.points),
    );
  });

  it('shares field flicker, fades the orb alpha, and starts arcs only above half fade', () => {
    const light = select()[0]!;
    for (const fade of [0, 0.5, 0.51, 1]) {
      const a = buildingLightOverlay([{ ...light, fade }], 10, 1);
      expect(a.discs[0]!.alpha).toBe(fade);
      expect(a.discs[0]!.brightness).toBe(flicker(light.seed!, 1, 0.12));
      if (fade <= 0.5) expect(a.strokes).toEqual([]);
      else
        for (const s of crisp(a.strokes)) {
          expect(s.alpha).toBeGreaterThanOrEqual(0.7 * fade);
          expect(s.alpha).toBeLessThanOrEqual(fade);
        }
    }
    const first = buildingLightOverlay([light], 10, 1);
    const next = buildingLightOverlay([light], 10, 1.016);
    expect(first.strokes.map((s) => s.points)).toEqual(next.strokes.map((s) => s.points));
    expect(first.strokes.map((s) => s.alpha)).not.toEqual(next.strokes.map((s) => s.alpha));
    expect(buildingLightOverlay(select([{ ...reactor, type: 'TESLA' }]), 10, 1)).toEqual({ discs: [], strokes: [] });
  });
});
