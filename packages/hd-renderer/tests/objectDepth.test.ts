import { describe, expect, it } from 'vitest';
import { DataUtils, OrthographicCamera, Vector3 } from 'three/webgpu';
// @ts-expect-error r186 internal format mapping has no declaration.
import { getFormat } from 'three/src/renderers/webgpu/utils/WebGPUTextureUtils.js';
import {
  ALWAYS_COVER_CODE,
  NOT_CAPTURED_CODE,
  OBJECT_DEPTH_CAP,
  OBJECT_CODE_TOLERANCE,
  OBJECT_DEPTH_EPSILON,
  OBJECT_DEPTH_BYTES_PER_PIXEL,
  anchorCodeErrorBound,
  encodeAnchorCode,
  decodeAnchorCode,
  reduceObjectDepth,
  objectDepthCombine,
  type CapturedDepthTexel,
  type ReducedObjectDepth,
  type ReducedObjectDepthPair,
} from '../src/objectDepth';
import { TerrainDepth } from '../src/terrainDepth';
import { FRONT_DISTANCE } from '../src/ra2/fireEngulf';
import { EffectsLayer } from '../src/effects';

const near = 0.1,
  far = 400,
  reference = 150;
const normalized = (s: number) => (s + reference - near) / (far - near);
const half = (x: number) => halfNeighbours(x)[0]!;
const texel = (s: number, code = 0, alpha = 1): CapturedDepthTexel => {
  const [r, g] = encodeAnchorCode(code, alpha);
  return { depth: normalized(s), r, g };
};
const empty: CapturedDepthTexel = { depth: 1, r: 0, g: 0 };
const invalid: ReducedObjectDepth = { sMin: 0, sMax: 0, code: 0, valid: false };
const combine = (base: number, records: ReducedObjectDepthPair, fireCode = 0) =>
  objectDepthCombine(base, records, fireCode, FRONT_DISTANCE, near, far, reference);
const reduce = (texels: readonly CapturedDepthTexel[]) => reduceObjectDepth(texels, near, far, reference);

/** Round both stored records, including codes, as the two RGBA16F attachments do. */
function stored(records: ReducedObjectDepthPair): ReducedObjectDepthPair {
  const record = (r: ReducedObjectDepth): ReducedObjectDepth => ({
    ...r,
    sMin: half(r.sMin),
    sMax: half(r.sMax),
    code: half(r.code),
  });
  return [record(records[0]), record(records[1])];
}

// DataUtils truncates; bracket its result and select round-to-nearest to match GPU half-float storage.
function halfNeighbours(value: number): number[] {
  const bits = DataUtils.toHalfFloat(value),
    a = DataUtils.fromHalfFloat(bits);
  if (a === value) return [a];
  const b = DataUtils.fromHalfFloat(bits + 1);
  // The actual GPU rounds to nearest; checking both neighbours at up to 249 would instead model a full ULP
  // (0.125), beyond the documented 0.0625 maximum half-ULP. Choose the nearest, plus its tie alternative.
  return Math.abs(a - value) === Math.abs(b - value) ? [a, b] : [Math.abs(a - value) < Math.abs(b - value) ? a : b];
}

describe('MSAA edge reduction across neighbouring triangles', () => {
  it.each([0.012, 0.7, -0.012, -0.7])('bounds subpixel coverage with slope %s cells/pixel', (slope) => {
    // The single-sample centre sees A; one of the 4x samples sees B, whose frag_depth is evaluated at the
    // pixel centre outside B. B owns the right neighbours. A has an independent vertical slope.
    const a = (x: number, y: number) => 3 + y * Math.abs(slope) * 2;
    const b = (x: number, y: number) => 3 - slope + x * slope + y * Math.abs(slope) * 0.5;
    const neighbourhood: CapturedDepthTexel[] = [];
    for (let y = -1; y <= 1; y++) for (let x = -1; x <= 1; x++) neighbourhood.push(texel(x === 1 ? b(x, y) : a(x, y)));
    const samples = [a(0, 0), a(0, 0), b(0, 0), b(0, 0)].map(normalized);
    const reduced = reduceObjectDepth(neighbourhood, near, far, reference);
    expect(reduced[0].sMax - reduced[0].sMin).toBeLessThanOrEqual(OBJECT_DEPTH_CAP * 2);
    expect(reduced[1].valid).toBe(false);
    for (const low of halfNeighbours(reduced[0].sMin))
      for (const high of halfNeighbours(reduced[0].sMax)) {
        const record = { ...reduced[0], sMin: low, sMax: high };
        const pull = combine(0.9, [record, reduced[1]]);
        const push = combine(0.1, [{ ...record, code: 2 }, reduced[1]]);
        for (const sample of samples) {
          expect(pull).toBeLessThan(sample);
          expect(push).toBeGreaterThan(sample);
        }
      }
    // Round two's centre-only epsilon leaves at least the pull OR push on the wrong side of B.
    const oldPull = normalized(a(0, 0) - 0.001),
      oldPush = normalized(a(0, 0) + 0.001);
    expect(samples.some((s) => oldPull >= s || oldPush <= s)).toBe(true);
  });
  it('falls back to the nearest object when the centre is absent, ignores far/zero-alpha, and preserves empty base', () => {
    const reduced = reduceObjectDepth(
      [empty, texel(3, 2), texel(1, ALWAYS_COVER_CODE), { ...texel(-1, 7), g: 0 }, empty, empty, empty, empty, empty],
      near,
      far,
      reference,
    );
    expect(reduced[0].sMin).toBeCloseTo(1);
    // The code-2 texel at 3 belongs to another object behind the front-most one: it never widens the spread.
    expect(reduced[0].sMax).toBeCloseTo(1);
    expect(reduced[0].code).toBe(ALWAYS_COVER_CODE);
    expect(reduced[1]).toMatchObject({ code: 2, valid: true });
    expect(reduced[1].sMin).toBeCloseTo(3);
    expect(reduced[1].sMax).toBeCloseTo(3);
    const absent = reduceObjectDepth(Array(9).fill(empty), near, far, reference);
    expect(absent).toEqual([invalid, invalid]);
    for (const base of [0, 0.123456789, 0.999999, 1])
      expect(objectDepthCombine(base, absent, 0, FRONT_DISTANCE, near, far, reference)).toBe(base);
  });
  it('keeps a bush behind an in-front tank under the fire in the one-pixel ring around the tank', () => {
    // Ring pixel: its own centre is bush (always cover) 1.0 camera cells behind the tank's silhouette, and a
    // neighbour is the tank (in front of this fire). A keeps the centre bush; B keeps the tank, and each spread
    // uses only its own object. The fire's base card depth is behind the bush, so a tank-only push cannot fix it.
    const tankCode = 1.8;
    const bush = 0.6;
    const ring = [
      empty,
      texel(-0.4, tankCode),
      texel(-0.35, tankCode),
      empty,
      texel(bush, ALWAYS_COVER_CODE),
      empty,
      empty,
      empty,
      empty,
    ];
    const reduced = reduce(ring);
    expect(reduced[0].code).toBe(ALWAYS_COVER_CODE);
    expect(reduced[1].code).toBeCloseTo(tankCode);
    expect(reduced[1].sMax).toBeCloseTo(-0.35);
    const base = normalized(1.2);
    expect(base).toBeGreaterThan(normalized(bush));
    for (const records of [reduced, stored(reduced)]) {
      const depth = combine(base, records);
      expect(depth).toBeLessThan(normalized(bush));
      // Include adjacent-triangle sample extrapolation at the tank silhouette, not just captured centres.
      for (const tank of [-0.45, -0.4, -0.35, -0.3]) expect(depth).toBeGreaterThan(normalized(tank));
      const tankOnly: ReducedObjectDepthPair = [records[1], invalid];
      expect(combine(base, tankOnly)).toBeGreaterThan(normalized(bush));
    }
  });
  it('caps spread across unrelated discontinuities and covers the full supported depth quantization range', () => {
    const reduced = reduceObjectDepth([texel(-50), texel(50)], near, far, reference);
    const pull = objectDepthCombine(0.9, reduced, 0, FRONT_DISTANCE, near, far, reference);
    expect(pull).toBeCloseTo(normalized(-50 - OBJECT_DEPTH_CAP - OBJECT_DEPTH_EPSILON));
    expect(OBJECT_DEPTH_EPSILON).toBeGreaterThan(3 * 0.0625 + (far - near) / 2 ** 24);
    for (const sMin of [-149.9, -128.01, -64.01, -0.00002, 63.99, 127.9, 249.8]) {
      const sMax = sMin + 0.03;
      for (const lo of halfNeighbours(sMin))
        for (const hi of halfNeighbours(sMax)) {
          const r = { sMin: lo, sMax: hi, code: 0, valid: true };
          const pull = combine(1, [r, invalid]);
          const push = combine(0, [{ ...r, code: 2 }, invalid]);
          expect(pull).toBeLessThan(normalized(sMin - 0.03));
          expect(push).toBeGreaterThan(normalized(sMax + 0.03));
        }
    }
  });
});

describe('two-record ownership and combined interval', () => {
  it('keeps the captured centre and the nearest different code, with spreads limited to each own object', () => {
    const records = reduce([
      texel(-1, 2),
      texel(-0.8, 2.04),
      texel(-4, OBJECT_CODE_TOLERANCE),
      texel(-5, 0.09),
      texel(3, 0),
      texel(-0.6, 2.08),
      texel(4, -0.09),
      texel(5, 0),
      texel(2, 7),
    ]);
    expect(records[0]).toMatchObject({ code: 0, valid: true });
    expect(records[0].sMin).toBeCloseTo(-5);
    expect(records[0].sMax).toBeCloseTo(5);
    expect(records[1]).toMatchObject({ code: 2, valid: true });
    expect(records[1].sMin).toBeCloseTo(-1);
    expect(records[1].sMax).toBeCloseTo(-0.6);
  });
  it('covers all samples of a COVER tank in front of a bush when the centre is on the bush', () => {
    const records = reduce([
      empty,
      texel(-0.4, 0.8),
      texel(-0.35, 0.8),
      empty,
      texel(0.6, ALWAYS_COVER_CODE),
      empty,
      empty,
      empty,
      empty,
    ]);
    for (const bounds of [records, stored(records)]) {
      const depth = combine(normalized(1.2), bounds);
      for (const sample of [-0.45, -0.4, -0.35, -0.3, 0.6]) expect(depth).toBeLessThan(normalized(sample));
      // Bush-only centre logic would leave the tank edge visible.
      expect(combine(normalized(1.2), [bounds[0], invalid])).toBeGreaterThan(normalized(-0.35));
    }
  });
  it.each([false, true])(
    'lets a COVER tree in front of a FRONT unit win a conflicting interval (tree centre=%s)',
    (treeCentre) => {
      const tree = texel(-0.4, ALWAYS_COVER_CODE),
        unit = texel(0.6, 2);
      const records = reduce([
        treeCentre ? unit : tree,
        empty,
        empty,
        empty,
        treeCentre ? tree : unit,
        empty,
        empty,
        empty,
        empty,
      ]);
      for (const bounds of [records, stored(records)]) {
        const p = normalized(-0.4 - OBJECT_DEPTH_EPSILON),
          q = normalized(0.6 + OBJECT_DEPTH_EPSILON);
        expect(q).toBeGreaterThan(p);
        const depth = combine(normalized(1.2), bounds);
        expect(depth).toBeCloseTo(p, 5);
        for (const sample of [-0.4, 0.6]) expect(depth).toBeLessThan(normalized(sample));
      }
    },
  );
  it('keeps both FRONT units in front, using the farther push even when the nearer unit is the centre', () => {
    const records = reduce([
      texel(0.6, 3),
      texel(0.65, 3),
      empty,
      empty,
      texel(-0.4, 2),
      texel(-0.35, 2),
      empty,
      empty,
      empty,
    ]);
    for (const bounds of [records, stored(records)]) {
      const depth = combine(normalized(-1), bounds);
      for (const sample of [-0.45, -0.4, -0.35, -0.3, 0.55, 0.6, 0.65, 0.7])
        expect(depth).toBeGreaterThan(normalized(sample));
      const base = normalized(1.2);
      expect(combine(base, bounds)).toBe(base);
    }
  });
});

describe('anchor code, format and memory contract', () => {
  it.each([0.041, 0.1, 0.37, 0.5, 0.99, 1])('decodes soft alpha %s through normal blending over clear', (alpha) => {
    for (const code of [-31.9, -8.23, 0, 1.5, 7.13, 31.9, ALWAYS_COVER_CODE]) {
      const [r, g] = encodeAnchorCode(code, alpha);
      // NormalBlending: the source RGB multiplier is alpha, for both retained channels.
      expect(decodeAnchorCode(r * alpha, g * alpha)).toBeCloseTo(code, 10);
      if (code !== ALWAYS_COVER_CODE) {
        const actual = half(decodeAnchorCode(half(r * alpha), half(g * alpha)));
        expect(Math.abs(actual - code)).toBeLessThan(anchorCodeErrorBound(32));
      }
    }
    expect(decodeAnchorCode(0, 0)).toBe(NOT_CAPTURED_CODE);
  });
  it('same-anchor overlapping parts preserve R/G under blending; different anchors produce weighted mixtures', () => {
    const blend = (code: number, a: number, old: [number, number]): [number, number] => {
      const [r, g] = encodeAnchorCode(code, a);
      return [r * a + old[0] * (1 - a), g * a + old[1] * (1 - a)];
    };
    const same = blend(7, 0.3, blend(7, 0.7, [0, 0]));
    expect(decodeAnchorCode(...same)).toBeCloseTo(7);
    const mixed = blend(7, 0.3, blend(2, 0.7, [0, 0]));
    expect(decodeAnchorCode(...mixed)).toBeGreaterThan(2);
    expect(decodeAnchorCode(...mixed)).toBeLessThan(7);
  });
  it('rebases CPU/shader codes near view centre instead of retaining absolute map coordinates', () => {
    const depth = new TerrainDepth(FRONT_DISTANCE),
      camera = new OrthographicCamera(-20, 20, 12, -12, near, far);
    try {
      const centre = new Vector3(10000, 0, 10000),
        direction = new Vector3(Math.sqrt(3 / 8), 0.5, Math.sqrt(3 / 8));
      camera.position.copy(centre).addScaledVector(direction, 150);
      camera.lookAt(centre);
      camera.updateMatrixWorld();
      depth.setReference(camera, centre);
      expect(depth.depthReference.value).toBeCloseTo(150);
      expect(depth.horizontal.value.length()).toBeCloseTo(1);
      expect(depth.anchorCode({ x: 10001, z: 10001 })).toBeCloseTo(Math.SQRT2);
      expect(anchorCodeErrorBound(8)).toBeLessThan(0.012);
      expect(anchorCodeErrorBound(32)).toBeLessThan(0.047);
    } finally {
      depth.dispose();
    }
  });
  it('uses blendable rg16float plus depth32float and two rgba16float MRT records without reduction depth', () => {
    const depth = new TerrainDepth(FRONT_DISTANCE);
    const device = { features: new Set() };
    try {
      expect(getFormat(depth.target.texture, device)).toBe('rg16float');
      expect(getFormat(depth.target.depthTexture, device)).toBe('depth32float');
      expect(depth.reductionTarget.textures).toHaveLength(2);
      for (const texture of depth.reductionTarget.textures) expect(getFormat(texture, device)).toBe('rgba16float');
      expect(depth.reductionTarget.samples).toBe(0);
      expect(depth.reductionTarget.depthBuffer).toBe(false);
      expect(OBJECT_DEPTH_BYTES_PER_PIXEL).toBe(24);
      expect(2400 * 1500 * OBJECT_DEPTH_BYTES_PER_PIXEL).toBe(86400000);
      expect(2400 * 1500 * (OBJECT_DEPTH_BYTES_PER_PIXEL - 16)).toBe(28800000);
    } finally {
      depth.dispose();
    }
  });
  it('keeps explosion-only garnish membership after the card dies, excluding delayed and muzzle/electric/continuous particles', () => {
    const effects = new EffectsLayer();
    const fires: { x: number; y: number; z: number; screenX: number; screenY: number; radius: number }[] = [];
    const right = new Vector3(Math.SQRT1_2, 0, -Math.SQRT1_2),
      up = new Vector3(-0.5 / Math.SQRT2, Math.sqrt(3) / 2, -0.5 / Math.SQRT2);
    try {
      effects.update(0, right, up);
      expect(effects.appendExplosionFootprints(fires, 0, right, up, 0.75)).toBe(0);
      effects.muzzleFlash(0, new Vector3(5, 0, 5), 1, { enhanced: true });
      effects.fireEmbers(0, new Vector3(5, 0, 5), 1, new Vector3());
      expect(effects.appendExplosionFootprints(fires, 0, right, up, 0.75)).toBe(0);
      effects.explode(0, new Vector3(5, 0, 5), 1, new Vector3(), { enhanced: true, maxSize: 2 });
      effects.update(0.8, right, up);
      expect(effects.appendExplosionFootprints(fires, 0, right, up, 0.75)).toBeGreaterThan(0);
      effects.update(10, right, up);
      expect(effects.appendExplosionFootprints(fires, 0, right, up, 0.75)).toBe(0);
    } finally {
      effects.root.traverse((object) => {
        if ('material' in object) (object.material as { dispose(): void }).dispose();
      });
    }
  });
});
