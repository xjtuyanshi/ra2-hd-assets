import {
  CustomBlending,
  OneFactor,
  OneMinusSrcAlphaFactor,
  OrthographicCamera,
  Scene,
  Vector3,
  WebGPURenderer,
  type InstancedBufferAttribute,
  type InstancedMesh,
  type MeshBasicNodeMaterial,
} from 'three/webgpu';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BEAM_SEGMENTS,
  BeamSegmentBuffer,
  EFFECT_LIGHTS,
  ENHANCED,
  EffectsLayer,
  FX_GARNISH,
  GARNISH_LIGHTS,
  beamSegments,
  emberRampRgb,
  type BeamSpec,
} from '../src/effects';
import type { LightField } from '../src/lightField';
import { LiveEffectsDriver, type LiveEffects } from '../src/live/effects';

type Pool = {
  mesh: InstancedMesh & { material: MeshBasicNodeMaterial };
  start: InstancedBufferAttribute;
  origin: InstancedBufferAttribute;
  velocity: InstancedBufferAttribute;
  params: InstancedBufferAttribute;
  until: number;
};

const layers: EffectsLayer[] = [];
const makeLayer = () => {
  const layer = new EffectsLayer();
  layers.push(layer);
  return layer;
};
const pool = (layer: EffectsLayer, name: string) => (layer as unknown as Record<string, Pool>)[name]!;
const spawned = (p: Pool) => Array.from(p.start.array).filter((born) => born >= 0).length;
const bolt = (to = new Vector3(3, 1, 0), seed = 17): BeamSpec => ({
  from: new Vector3(0, 1, 0),
  to,
  colour: new Vector3(0.08, 0.12, 1),
  bolt: true,
  seed,
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const layer of layers.splice(0)) {
    const meshes = layer.root.children as InstancedMesh[];
    for (const geometry of new Set(meshes.map((mesh) => mesh.geometry))) geometry.dispose();
    for (const mesh of meshes) {
      (mesh.material as MeshBasicNodeMaterial).dispose();
      mesh.dispose();
    }
  }
});

describe('enhanced ember radiance', () => {
  it('matches all five linear HDR stops, clamps endpoints and interpolates gained colour', () => {
    const stops = [
      [0, [0.03, 0.0036, 0]],
      [0.25, [0.6, 0.072, 0.012]],
      [0.5, [1.2, 0.456, 0.072]],
      [0.75, [2, 1.4, 0.5]],
      [1, [3, 2.79, 2.25]],
    ] as const;
    for (const [temperature, expected] of stops)
      emberRampRgb(temperature).forEach((value, i) => expect(value).toBeCloseTo(expected[i]!, 12));
    expect(emberRampRgb(-10)).toEqual(emberRampRgb(0));
    expect(emberRampRgb(10)).toEqual(emberRampRgb(1));
    emberRampRgb(0.625).forEach((value, i) => expect(value).toBeCloseTo([1.6, 0.928, 0.286][i]!, 12));
  });

  it('brightens monotonically through red, orange, yellow and white without an intermediate luminance dip', () => {
    const luminance = ([r, g, b]: number[]) => r! * 0.2126 + g! * 0.7152 + b! * 0.0722;
    let previous = emberRampRgb(0);
    for (let i = 1; i <= 400; i++) {
      const next = emberRampRgb(i / 400);
      expect(luminance(next)).toBeGreaterThan(luminance(previous));
      next.forEach((channel, index) => expect(channel).toBeGreaterThanOrEqual(previous[index]!));
      previous = next;
    }
    expect(luminance(emberRampRgb(1))).toBeGreaterThan(2);
    expect(luminance(emberRampRgb(0))).toBeLessThan(0.02);
  });
});

describe('enhanced particle routing and lights', () => {
  it.each([
    ['smoke', 0.62, [1.2, 3.0]],
    ['column', 0.6, [1.5, 4.0]],
  ] as const)('documents late %s thinning without changing the early phase', (name, lateOpacity, lateFrom) => {
    const tuning = ENHANCED[name];
    expect(tuning).toMatchObject({ lateOpacity, lateFrom, lateEdge: 0.15 });
    expect(tuning.lateOpacity).toBeGreaterThan(0);
    expect(tuning.lateOpacity).toBeLessThan(1);
    expect(tuning.lateFrom[0]).toBeGreaterThanOrEqual(1.2);
    expect(tuning.lateFrom[0]).toBeLessThan(tuning.lateFrom[1]);
  });

  it('builds a dense smoke dome over the first second, then retains drifting billows and the longer column', () => {
    let seed = 123;
    vi.spyOn(Math, 'random').mockImplementation(() => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 2 ** 32;
    });
    const layer = makeLayer();
    const at = new Vector3(4, 2, 6);
    const wind = new Vector3(0.4, 0, -0.2);
    const width = 2;
    layer.explode(2, at, 1, wind, { enhanced: true, hdArt: true, maxSize: width, maxLife: 0.3 });
    const smoke = pool(layer, 'billow');
    const e = ENHANCED;
    const billows = Math.round(e.smoke.count + e.smoke.perScale);
    expect(spawned(smoke)).toBe(billows);
    expect(smoke.mesh.material).toMatchObject({
      blending: CustomBlending,
      blendSrc: OneFactor,
      blendDst: OneMinusSrcAlphaFactor,
    });
    for (let i = 0; i < billows; i++) {
      // Stratification keeps births building through the full 0.1..1.0 second window, even at low counts.
      expect(smoke.start.getX(i)).toBeGreaterThanOrEqual(
        Math.fround(2 + e.smoke.delay + (i / billows) * e.smoke.spread),
      );
      expect(smoke.start.getX(i)).toBeLessThanOrEqual(
        Math.fround(2 + e.smoke.delay + ((i + 1) / billows) * e.smoke.spread),
      );
      const x = smoke.origin.getX(i) - at.x;
      const y = smoke.origin.getY(i) - at.y;
      const z = smoke.origin.getZ(i) - at.z;
      expect(Math.abs(x)).toBeLessThanOrEqual(0.35 * width);
      expect(Math.abs(z)).toBeLessThanOrEqual(0.35 * width);
      expect(y).toBeGreaterThanOrEqual(0.1 - 1e-6);
      expect(x * x + y * y + z * z).toBeLessThanOrEqual((0.55 * width) ** 2 + 1e-6);
      expect(smoke.params.getX(i)).toBeGreaterThanOrEqual(Math.fround(e.smoke.size * 0.8 * width));
      expect(smoke.params.getX(i)).toBeLessThanOrEqual(Math.fround(e.smoke.size * 1.3 * width));
      expect(smoke.params.getY(i)).toBeGreaterThanOrEqual(Math.fround(e.smoke.life * 0.8));
      expect(smoke.params.getY(i)).toBeLessThanOrEqual(Math.fround(e.smoke.life * 1.2));
      expect(smoke.params.getW(i)).toBe(1);
      expect(smoke.velocity.getX(i)).toBeGreaterThan(0);
      expect(smoke.velocity.getY(i)).toBeGreaterThan(0);
    }
    const column = pool(layer, 'column');
    const puffs = Math.round(e.column.count + e.column.perScale);
    expect(spawned(column)).toBe(puffs);
    for (let i = 0; i < puffs; i++) {
      expect(column.params.getY(i)).toBeGreaterThanOrEqual(Math.fround(e.column.life * 0.8));
      expect(column.params.getY(i)).toBeLessThanOrEqual(Math.fround(e.column.life * 1.2));
    }
    layer.update(6, new Vector3(1, 0, 0), new Vector3(0, 1, 0));
    expect(smoke.mesh.visible).toBe(true);
    expect(column.mesh.visible).toBe(true);
    layer.update(smoke.until + 0.01, new Vector3(1, 0, 0), new Vector3(0, 1, 0));
    expect(smoke.mesh.visible).toBe(false);
    expect(column.mesh.visible).toBe(true);
  });

  it.each([0.1, 0.5])('throws visible chunks with an eight-second nominal rest (random=%s)', (random) => {
    vi.spyOn(Math, 'random').mockReturnValue(random);
    const layer = makeLayer();
    layer.explode(2, new Vector3(), 1, new Vector3(), { enhanced: true, hdArt: true, maxSize: 2 });
    const debris = pool(layer, 'debris');
    const chunks = ENHANCED.debris.count + ENHANCED.debris.perScale;
    expect(spawned(debris)).toBe(chunks);
    const big = random < 0.2;
    const speed = 0.85 * (big ? 0.6 : 1);
    for (let i = 0; i < chunks; i++) {
      expect(debris.params.getX(i)).toBeCloseTo((0.07 + random * 0.09 * 1.6) * (big ? 1.6 : 1) * ENHANCED.debris.size);
      expect(debris.velocity.getX(i)).toBeCloseTo((random - 0.5) * 8 * speed);
      expect(debris.velocity.getZ(i)).toBeCloseTo((random - 0.5) * 8 * speed);
      expect(debris.velocity.getY(i)).toBeCloseTo((2.5 + random * 3.5) * speed);
      expect(debris.params.getY(i) - debris.velocity.getY(i) / 4.9).toBeCloseTo(8 * (0.5 + random));
      expect(debris.params.getW(i)).toBe(random < 0.35 ? 1 : 0);
    }
  });

  it('retains every billow, column puff and chunk across twelve simultaneous maximum-scale blasts', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const layer = makeLayer();
    for (let i = 0; i < 12; i++)
      layer.explode(1, new Vector3(i * 10, 0, 0), 3.5, new Vector3(), { enhanced: true, hdArt: true, maxSize: 4 });
    for (const [name, perBlast] of [
      ['billow', ENHANCED.smoke.count + 2 * ENHANCED.smoke.perScale],
      ['column', ENHANCED.column.count + 1.5 * ENHANCED.column.perScale],
      ['debris', ENHANCED.debris.count + 2 * ENHANCED.debris.perScale],
    ] as const) {
      const particles = pool(layer, name);
      expect(particles.start.count).toBeGreaterThanOrEqual(12 * perBlast);
      expect(spawned(particles)).toBe(12 * perBlast);
      for (let i = 0; i < 12 * perBlast; i++) expect(particles.origin.getX(i)).toBe(Math.floor(i / perBlast) * 10);
    }
  });

  it('emits delayed cooling embers from a blast volume, two light pulses and a narrower HD halo', () => {
    const layer = makeLayer();
    const pulse = vi.fn();
    layer.attachLightField({ pulse } as unknown as LightField);
    const at = new Vector3(4, 2, 6);
    const wind = new Vector3(2, 0, -1);
    const width = 2;
    const e = ENHANCED.embers;
    const count = Math.round(e.count + e.perScale * FX_GARNISH);
    layer.explode(2, at, 1, wind, { enhanced: true, hdArt: true, maxSize: width, hotCrater: true });
    const embers = pool(layer, 'airborneEmbers');
    expect(embers.start.count).toBe(e.pool);
    expect(spawned(embers)).toBe(count);
    for (let i = 0; i < count; i++) {
      expect(embers.start.getX(i)).toBeGreaterThanOrEqual(2);
      expect(embers.start.getX(i)).toBeLessThanOrEqual(Math.fround(2 + e.delay));
      expect(embers.params.getY(i)).toBeGreaterThanOrEqual(Math.fround(e.life[0]));
      expect(embers.params.getY(i)).toBeLessThanOrEqual(Math.fround(e.life[1]));
      expect(embers.params.getW(i)).toBeGreaterThanOrEqual(Math.fround(e.temperature[0]));
      expect(embers.params.getW(i)).toBeLessThanOrEqual(Math.fround(e.temperature[1]));
      expect(embers.velocity.getY(i)).toBeGreaterThanOrEqual(Math.fround(e.rise[0]));
      expect(embers.velocity.getY(i)).toBeLessThanOrEqual(Math.fround(e.rise[1]));
      for (const axis of ['x', 'z'] as const) {
        const velocity = axis === 'x' ? embers.velocity.getX(i) : embers.velocity.getZ(i);
        const origin = axis === 'x' ? embers.origin.getX(i) : embers.origin.getZ(i);
        expect(velocity).toBeGreaterThanOrEqual(Math.fround(wind[axis] * e.wind - e.drift / 2));
        expect(velocity).toBeLessThanOrEqual(Math.fround(wind[axis] * e.wind + e.drift / 2));
        expect(origin).toBeGreaterThanOrEqual(Math.fround(at[axis] - (e.volume * width) / 2));
        expect(origin).toBeLessThanOrEqual(Math.fround(at[axis] + (e.volume * width) / 2));
      }
      expect(embers.origin.getY(i)).toBeGreaterThanOrEqual(at.y);
      expect(embers.origin.getY(i)).toBeLessThanOrEqual(Math.fround(at.y + e.height * width));
    }
    expect(pool(layer, 'halo').params.getX(0)).toBeCloseTo(width * ENHANCED.halo.hdWidth);
    expect(pool(layer, 'blast').until).toBe(-Infinity);
    expect(pool(layer, 'embers').params.getW(0)).toBe(1);
    expect(pulse).toHaveBeenCalledTimes(2);
    const [flash, glow] = pulse.mock.calls;
    expect(flash![3]).toBeCloseTo(glow![3] * ENHANCED.flash.radius);
    expect(flash![4]).toBeCloseTo(glow![4] * ENHANCED.flash.peak);
    expect(flash![5]).toBe(ENHANCED.flash.life);
    expect(flash![6]).toBe(ENHANCED.flash.decay);
    expect(flash![6]).toBeGreaterThan(glow![6]);
    const hot = emberRampRgb(ENHANCED.flash.temperature);
    expect(flash![2]).toEqual(hot.map((value) => value / Math.max(...hot)));
    expect(glow![2]).toEqual(ENHANCED.light.colour);
    expect(glow![5]).toBe(ENHANCED.light.life);
    expect(glow![6]).toBe(ENHANCED.light.decay);
    layer.update(embers.until + 0.01, new Vector3(1, 0, 0), new Vector3(0, 1, 0));
    expect(embers.mesh.visible).toBe(false);
    expect(embers.start.updateRanges).toEqual([{ start: 0, count }]);
  });

  it('retains the non-HD halo and isolates faithful and sandbox explosions, muzzle flashes and ember beds', () => {
    for (const faithful of [true, false]) {
      const layer = makeLayer();
      const pulse = vi.fn();
      layer.attachLightField({ pulse, keep: vi.fn() } as unknown as LightField);
      const options = faithful ? { maxSize: 1, maxLife: 0.3 } : undefined;
      layer.explode(1, new Vector3(), 1, new Vector3(), options);
      layer.muzzleFlash(1, new Vector3(), 1, options);
      expect(pulse.mock.calls.map((call) => call[2])).toEqual(
        faithful
          ? [GARNISH_LIGHTS.explosion.colour, GARNISH_LIGHTS.muzzle.colour]
          : [EFFECT_LIGHTS.explosion.colour, EFFECT_LIGHTS.muzzle.colour],
      );
      for (const name of ['airborneEmbers', 'muzzleStar', 'halo']) expect(pool(layer, name).until).toBe(-Infinity);
      const sparks = pool(layer, 'sparks');
      for (let i = 0; i < spawned(sparks); i++) expect(sparks.params.getW(i)).toBe(faithful ? 1 : 0);
      layer.fire(2, new Vector3(), 1, 'wreck');
      expect(pool(layer, 'embers').params.getW(0)).toBe(0);
    }
    const enhanced = makeLayer();
    enhanced.explode(1, new Vector3(), 1, new Vector3(), { enhanced: true, maxSize: 2 });
    expect(pool(enhanced, 'halo').params.getX(0)).toBeCloseTo(3.2);
    expect(pool(enhanced, 'halo').params.getW(0)).toBeCloseTo(1.8);
    expect(pool(enhanced, 'blast').until).toBeGreaterThan(1);
  });

  it('replaces the enhanced muzzle garnish with a bounded short star and warm light', () => {
    const layer = makeLayer();
    const pulse = vi.fn();
    layer.attachLightField({ pulse } as unknown as LightField);
    layer.muzzleFlash(1, new Vector3(), 10, { enhanced: true, maxSize: 10 });
    const star = pool(layer, 'muzzleStar');
    expect(spawned(star)).toBe(1);
    expect(star.params.getX(0)).toBeCloseTo(1.2);
    expect(star.params.getY(0)).toBeGreaterThanOrEqual(0.06);
    expect(star.params.getY(0)).toBeLessThanOrEqual(0.09);
    expect(pool(layer, 'garnishFire').until).toBe(-Infinity);
    expect(pulse.mock.calls[0]![2]).toEqual([1, 0.78, 0.45]);
    expect(pool(layer, 'sparks').params.getW(0)).toBe(2);
  });

  it('schedules each fire independently at 2-4 embers/s and discards catch-up after a long gap', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    for (const hz of [5, 60]) {
      const layer = makeLayer();
      const fires = [new Vector3(), new Vector3(3, 0, 0)];
      for (let i = 0; i < 2 * hz; i++) for (const at of fires) layer.fireEmbers(1 + i / hz, at, 1);
      const embers = pool(layer, 'airborneEmbers');
      expect(spawned(embers)).toBe(12);
      layer.fireEmbers(100, fires[0]!, 1);
      expect(spawned(embers)).toBe(13);
    }
  });

  it('adds fire embers next to the live light only in enhanced style, respecting shroud and the garnish switch', () => {
    const effects = { fireEmbers: vi.fn(), fireLight: vi.fn(), setBeams: vi.fn() } as unknown as EffectsLayer;
    let hidden = false;
    const driver = new LiveEffectsDriver(effects, () => hidden);
    const snapshot: LiveEffects = {
      anims: [{ id: 1, uid: 1, type: 'FIRE01', x: 256, y: 256, z: 0 }],
      bullets: [],
      particleSystems: [],
    };
    const wind = new Vector3(0.4, 0, -0.1);
    driver.push(snapshot, 1, 0, wind);
    driver.frame(0, wind);
    expect(effects.fireEmbers).not.toHaveBeenCalled();
    expect(effects.enhancedBeams).toBe(false);
    driver.style = 'enhanced';
    driver.push(snapshot, 2, 1, wind);
    driver.frame(1, wind);
    expect(effects.enhancedBeams).toBe(true);
    expect(effects.fireEmbers).toHaveBeenCalledExactlyOnceWith(1, expect.any(Vector3), expect.any(Number), wind);
    hidden = true;
    driver.frame(2, wind);
    hidden = false;
    driver.garnishEnabled = false;
    driver.frame(3, wind);
    expect(effects.enhancedBeams).toBe(false);
    expect(effects.fireEmbers).toHaveBeenCalledTimes(1);
  });

  it('spawns blue-white bolt impacts on each set, while faithful bolts and all lasers spawn none', () => {
    const layer = makeLayer();
    const beam = bolt();
    layer.setBeams(1, [beam]);
    expect(pool(layer, 'sparks').until).toBe(-Infinity);
    layer.enhancedBeams = true;
    layer.setBeams(2, [{ ...beam, bolt: false }]);
    expect(pool(layer, 'halo').until).toBe(-Infinity);
    layer.setBeams(3, [beam]);
    layer.setBeams(3.1, [beam]);
    const halo = pool(layer, 'halo');
    expect(spawned(halo)).toBe(2);
    expect(halo.params.getX(0)).toBeCloseTo(0.6);
    expect(halo.params.getY(0)).toBeCloseTo(0.12);
    expect(halo.origin.getX(0)).toBe(beam.to.x);
    expect(spawned(pool(layer, 'sparks'))).toBe(6);
    expect(pool(layer, 'sparks').params.getW(0)).toBe(3);
    layer.setBeams(4, []);
    expect(layer.beamSegmentCount).toBe(0);
  });

  it('redraws paused beams when style changes and otherwise leaves their geometry untouched between logic frames', () => {
    const layer = makeLayer();
    const driver = new LiveEffectsDriver(layer, () => false);
    const setBeams = vi.spyOn(layer, 'setBeams');
    const wind = new Vector3();
    driver.push(
      {
        anims: [],
        bullets: [],
        particleSystems: [],
        beams: [
          {
            source: { x: 0, y: 0, z: 0 },
            target: { x: 3 * 256, y: 0, z: 0 },
            kind: 'bolt',
            colour: [82, 80, 255],
          },
        ],
      },
      1,
      0,
      wind,
    );
    const faithfulCount = layer.beamSegmentCount;
    driver.style = 'enhanced';
    driver.frame(0.1, wind);
    expect(layer.beamSegmentCount).toBeGreaterThan(faithfulCount);
    driver.frame(0.2, wind);
    expect(setBeams).toHaveBeenCalledTimes(2);
    driver.style = 'faithful';
    driver.frame(0.3, wind);
    expect(layer.beamSegmentCount).toBe(faithfulCount);
    expect(setBeams).toHaveBeenCalledTimes(3);
  });
});

describe('enhanced bolt geometry', () => {
  it('adds deterministic short branches at every third piece without changing the three original trunks', () => {
    const spec = bolt();
    const plain = beamSegments(spec.from, spec.to, true, spec.seed);
    const enhanced = beamSegments(spec.from, spec.to, true, spec.seed, true);
    expect(enhanced).toEqual(beamSegments(spec.from, spec.to, true, spec.seed, true));
    expect(enhanced).not.toEqual(beamSegments(spec.from, spec.to, true, spec.seed + 1, true));
    expect(enhanced).toHaveLength(48);
    const trunks = enhanced.filter((_, i) => i % 4 !== 3);
    expect(trunks).toEqual(plain);
    for (let i = 3; i < enhanced.length; i += 4) {
      const [joint, end] = enhanced[i]!;
      expect(joint).toEqual(enhanced[i - 1]![1]);
      expect(joint.distanceTo(end)).toBeGreaterThanOrEqual(0.25 * 0.25);
      expect(joint.distanceTo(end)).toBeLessThanOrEqual(0.5 * 0.25);
    }
  });

  it('matches the bounded helper prefix, uploads only changes and leaves lasers unchanged when enhanced', () => {
    const laser = { ...bolt(new Vector3(1, 2, 3), 8), bolt: false };
    const specs = [laser, bolt(), bolt(new Vector3(0, 5, 0), 99), bolt(new Vector3(1e12, 0, 0), 123)];
    const expected = specs
      .flatMap((spec) => beamSegments(spec.from, spec.to, spec.bolt, spec.seed, true))
      .slice(0, BEAM_SEGMENTS);
    const buffer = new BeamSegmentBuffer();
    buffer.set(specs, true);
    expect(buffer.count).toBe(BEAM_SEGMENTS);
    expect(buffer.from.array).toEqual(Float32Array.from(expected.flatMap(([from]) => from.toArray())));
    expect(buffer.to.array).toEqual(Float32Array.from(expected.flatMap(([, to]) => to.toArray())));
    expect(buffer.enhanced.getX(0)).toBe(0);
    expect(buffer.enhanced.getX(1)).toBe(1);
    buffer.flush();
    const attributes = [buffer.from, buffer.to, buffer.colour, buffer.enhanced];
    const versions = attributes.map((attribute) => attribute.version);
    buffer.set(specs, true);
    buffer.flush();
    expect(attributes.map((attribute) => attribute.version)).toEqual(versions);
    expect(beamSegments(specs[3]!.from, specs[3]!.to, true, 123, true)).toHaveLength(BEAM_SEGMENTS);
    buffer.set([laser], true);
    const enhancedLaser = attributes.map((attribute) => Array.from(attribute.array.slice(0, attribute.itemSize)));
    buffer.set([laser]);
    expect(attributes.map((attribute) => Array.from(attribute.array.slice(0, attribute.itemSize)))).toEqual(
      enhancedLaser,
    );
    buffer.set([]);
    expect(buffer.count).toBe(0);
  });
});

describe('effect colour shader construction', () => {
  it('expands spark, ember, halo, smoke, crater, debris, muzzle and bolt shaders into WGSL without a GPU or browser', () => {
    // Compiler capability queries only: this checks lazy TSL graph construction, not a driver or rendered image.
    const canvas = { width: 1, height: 1, style: {}, addEventListener() {} } as unknown as HTMLCanvasElement;
    const renderer = new WebGPURenderer({ canvas });
    Object.assign(renderer.backend, {
      device: { limits: { maxUniformBufferBindingSize: 65536 }, features: new Set() },
      renderer,
    });
    renderer.hasFeature = () => false;
    renderer.hasCompatibility = () => false;
    const layer = makeLayer();
    const meshes = ['sparks', 'airborneEmbers', 'muzzleStar', 'halo', 'embers', 'debris', 'billow', 'column'].map(
      (name) => pool(layer, name).mesh,
    );
    meshes.push(layer.root.children.find((mesh) => mesh.name === 'hd-beams') as Pool['mesh']);
    for (const mesh of meshes) {
      const builder = renderer.backend.createNodeBuilder(mesh, renderer);
      builder.scene = new Scene();
      builder.camera = new OrthographicCamera();
      builder.build();
      expect(builder.vertexShader).toContain('@vertex');
      expect(builder.fragmentShader).toContain('@fragment');
      expect(`${builder.vertexShader}\n${builder.fragmentShader}`).not.toMatch(/\b(?:NaN|undefined)\b/);
    }
    expect(pool(layer, 'airborneEmbers').mesh.count).toBe(ENHANCED.embers.pool);
  });
});
