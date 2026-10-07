import { Vector2, type Material } from 'three/webgpu';
import {
  Break,
  Fn,
  If,
  Loop,
  abs,
  clamp,
  dot,
  float,
  floor,
  fract,
  int,
  ivec2,
  max,
  min,
  pow,
  select,
  sin,
  textureSize,
  uniform,
  uv,
  varying,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import type { ShaderNode } from './tsl';

/**
 * Smooth object outlines without multisampling.
 *
 * Every surface that writes depth also writes a silhouette code: (0, 0) for ground-class surfaces, which never get
 * an outline of their own, and a per-object pair for everything that stands on the ground. The last pass of the
 * frame then rebuilds the outline between neighbouring pixels of different codes the way morphological
 * anti-aliasing does: a run of outline between two steps is replaced by the straight line through the middle of
 * both steps, and each pixel that line cuts is mixed with its neighbour across the outline by the area cut off.
 *
 * What this guarantees, and why it is done here instead of with multisampling or a colour-based filter:
 *  - a pixel whose four neighbours carry its own code is copied bit for bit, so the inside of every object and the
 *    ground keep the texel-exact picture (a colour-based filter such as FXAA softens art detail);
 *  - nothing is drawn differently: depth, discards and blending of the scene pass are untouched, so which object
 *    covers which is decided exactly as without the pass;
 *  - the cost is one more texture read per pixel of the final pass plus a short search on outline pixels, where
 *    4x multisampling doubled the cost of the whole scene pass.
 *
 * The codes are data of the renderer's caller: this module only compares them.
 */

/** Code channels are multiples of 1/256: exact in the half-float attachment that carries them. */
export const SILHOUETTE_LEVELS = 256;
/** Pixels searched along an outline in each direction: steps up to twice this apart are joined by one line. */
export const SILHOUETTE_SEARCH = 12;
/** Display values are mixed in (approximately) linear light, like the coverage of a multisampled edge. */
export const SILHOUETTE_GAMMA = 2.2;
/** Half a code step: codes further apart than this belong to different objects. */
const DIFFERENT = 0.5 / SILHOUETTE_LEVELS;
/**
 * The horizontal axis must win by this much: at a symmetric corner both axes have the same share, and the choice must
 * not depend on the last bit of the arithmetic (the shader works in 32-bit floats, its twin in 64-bit ones).
 */
const AXIS_MARGIN = 1e-4;

const NONE = new Vector2(0, 0);

/**
 * The code of object number `serial` and one of its parts (parts of one object differ from each other, so a part in
 * front of another part has an outline too). Never (0, 0), which is the ground's.
 */
export function silhouetteCode(serial: number, part = 0, target = new Vector2()): Vector2 {
  const n = Math.abs(Math.floor(serial));
  const first = 1 + (n % 255);
  const second = (Math.floor(n / 255) + 61 * Math.abs(Math.floor(part))) % 256;
  return target.set(first / SILHOUETTE_LEVELS, second / SILHOUETTE_LEVELS);
}

/** The code of the mesh being drawn: its `userData.silhouette` (see silhouetteCode), the ground's without one. */
export const objectSilhouette: ShaderNode = uniform(new Vector2())
  .setName('silhouetteCode')
  .onObjectUpdate(({ object }) => (object?.userData.silhouette as Vector2 | undefined) ?? NONE);

/**
 * A code per instance of instanced art, from any per-instance key (an anchor position, for example): instances with
 * equal keys share a code. `enabled` (0 or 1 per instance) leaves an instance in the ground class. The code is made
 * in the vertex stage and rounded in the fragment stage, so every fragment of an instance holds exactly the same
 * value whatever the interpolation does.
 */
export function instanceSilhouette(key: ShaderNode, enabled: ShaderNode): ShaderNode {
  const first = floor(fract(sin(dot(key, vec3(12.9898, 78.233, 37.719))).mul(43758.5453)).mul(255)).add(1);
  const second = floor(fract(sin(dot(key, vec3(39.3468, 11.135, 83.155))).mul(24634.6345)).mul(256));
  const exact: ShaderNode = varying(vec2(first, second).mul(enabled), 'silhouetteInstanceCode');
  return floor(exact.add(0.5)).div(SILHOUETTE_LEVELS);
}

/** Give `material` the code its fragments write: a node of its own, or the drawn mesh's `userData.silhouette`. */
export function setSilhouette<M extends Material>(material: M, node: ShaderNode = objectSilhouette): M {
  material.userData.silhouetteNode = node;
  return material;
}

/** The code `material`'s fragments write (vec2): the ground's unless setSilhouette gave it one. */
export function silhouetteOf(material: Material): ShaderNode {
  return (material.userData.silhouetteNode as ShaderNode | undefined) ?? vec2(0, 0);
}

/**
 * The final pass: `colour` (a texture node holding the finished display picture) with the outlines of `codes` (a
 * texture node whose green and blue channels hold the silhouette codes of the same pixels) smoothed. Pixels away
 * from an outline are returned exactly as loaded. smoothSilhouettes() below is the same arithmetic on arrays.
 */
export function silhouetteSmooth(colour: ShaderNode, codes: ShaderNode, search = SILHOUETTE_SEARCH): ShaderNode {
  return Fn(() => {
    const size: ShaderNode = textureSize(colour);
    const target: ShaderNode = uv();
    const p: ShaderNode = ivec2(int(floor(target.x.mul(size.x))), int(floor(target.y.mul(size.y)))).toConst();
    const last: ShaderNode = ivec2(size).sub(1).toConst();
    const at = (q: ShaderNode): ShaderNode => (clamp as ShaderNode)(q, ivec2(0, 0), last);
    const code = (q: ShaderNode): ShaderNode => codes.load(at(q)).yz;
    const differs = (a: ShaderNode, b: ShaderNode): ShaderNode =>
      abs(a.x.sub(b.x)).add(abs(a.y.sub(b.y))).greaterThan(DIFFERENT);

    const centre: ShaderNode = colour.load(p);
    const result: ShaderNode = vec4(centre).toVar();
    const c: ShaderNode = code(p).toVar();
    const edgeL: ShaderNode = differs(c, code(p.add(ivec2(-1, 0)))).toVar();
    const edgeR: ShaderNode = differs(c, code(p.add(ivec2(1, 0)))).toVar();
    const edgeU: ShaderNode = differs(c, code(p.add(ivec2(0, -1)))).toVar();
    const edgeD: ShaderNode = differs(c, code(p.add(ivec2(0, 1)))).toVar();

    /**
     * Share of this pixel on the far side of the rebuilt outline, for the outline between it and its neighbour at
     * `n`, which runs along `t`. Each end of the run is where either row steps: a step in this pixel's own row pulls
     * the line half a pixel into it (-0.5), a step in the neighbour's row pushes it half a pixel away (+0.5), a step
     * in both rows or none within reach leaves it on the pixel boundary. The line runs from each end to the middle of
     * the run at height 0; the pixel's share is the area under height 0 within its own column.
     */
    const share = (tx: number, ty: number, nx: number, ny: number): ShaderNode => {
      const end = (direction: 1 | -1): { distance: ShaderNode; height: ShaderNode } => {
        const distance: ShaderNode = float(search).toVar();
        const height: ShaderNode = float(0).toVar();
        const previousOwn: ShaderNode = vec2(c).toVar();
        const previousFar: ShaderNode = vec2(code(p.add(ivec2(nx, ny)))).toVar();
        Loop({ start: int(1), end: int(search + 1), type: 'int', condition: '<' }, ({ i }: { i: ShaderNode }) => {
          const q: ShaderNode = p.add(ivec2(tx * direction, ty * direction).mul(i));
          const own: ShaderNode = vec2(code(q)).toVar();
          const far: ShaderNode = vec2(code(q.add(ivec2(nx, ny)))).toVar();
          const ownStep: ShaderNode = differs(own, previousOwn);
          const farStep: ShaderNode = differs(far, previousFar);
          If(ownStep.or(farStep), () => {
            distance.assign(float(i).sub(1));
            height.assign(select(farStep, float(0.5), float(0)).sub(select(ownStep, float(0.5), float(0))));
            Break();
          });
          previousOwn.assign(own);
          previousFar.assign(far);
        });
        return { distance, height };
      };
      const before = end(-1);
      const after = end(1);
      const length: ShaderNode = before.distance.add(after.distance).add(1).toVar();
      const half: ShaderNode = length.mul(0.5);
      const x0: ShaderNode = before.distance;
      const x1: ShaderNode = before.distance.add(1);
      const b: ShaderNode = min(x1, half);
      const a: ShaderNode = max(x0, half);
      const first: ShaderNode = max(before.height.negate(), 0)
        .mul(max(b.sub(x0), 0))
        .mul(float(1).sub(x0.add(b).div(length)));
      const second: ShaderNode = max(after.height.negate(), 0)
        .mul(max(x1.sub(a), 0))
        .mul(a.add(x1).div(length).sub(1));
      return max(first, 0).add(max(second, 0));
    };

    If(edgeL.or(edgeR).or(edgeU).or(edgeD), () => {
      const shareL: ShaderNode = float(0).toVar();
      const shareR: ShaderNode = float(0).toVar();
      const shareU: ShaderNode = float(0).toVar();
      const shareD: ShaderNode = float(0).toVar();
      If(edgeL, () => {
        shareL.assign(share(0, 1, -1, 0));
      });
      If(edgeR, () => {
        shareR.assign(share(0, 1, 1, 0));
      });
      If(edgeU, () => {
        shareU.assign(share(1, 0, 0, -1));
      });
      If(edgeD, () => {
        shareD.assign(share(1, 0, 0, 1));
      });
      // One axis only, the one with the larger share (as SMAA's neighbourhood blending): a lone pixel keeps three
      // quarters of itself instead of dissolving into its four neighbours.
      const horizontal: ShaderNode = max(shareL, shareR).greaterThan(max(shareU, shareD).add(AXIS_MARGIN));
      const offset: ShaderNode = select(horizontal, ivec2(1, 0), ivec2(0, 1));
      const shareA: ShaderNode = select(horizontal, shareL, shareU).toVar();
      const shareB: ShaderNode = select(horizontal, shareR, shareD).toVar();
      const total: ShaderNode = shareA.add(shareB).toVar();
      If(total.greaterThan(0), () => {
        // What the display shows of a value: the target is a float one and may hold values outside 0..1.
        const linear = (value: ShaderNode): ShaderNode =>
          pow(clamp(value.rgb, vec3(0), vec3(1)), vec3(SILHOUETTE_GAMMA));
        const own: ShaderNode = linear(centre).toVar();
        const sideA: ShaderNode = linear(colour.load(at(p.sub(offset))));
        const sideB: ShaderNode = linear(colour.load(at(p.add(offset))));
        const mixed: ShaderNode = own
          .add(sideA.sub(own).mul(shareA).mul(shareA).div(total))
          .add(sideB.sub(own).mul(shareB).mul(shareB).div(total));
        result.assign(vec4(pow(max(mixed, vec3(0)), vec3(1 / SILHOUETTE_GAMMA)), centre.a));
      });
    });
    return result;
  })();
}

/** A picture and its silhouette codes on the CPU: `colour` RGBA per pixel, `codes` two channels per pixel. */
export interface SilhouetteFrame {
  width: number;
  height: number;
  colour: ArrayLike<number>;
  codes: ArrayLike<number>;
}

/**
 * Pure twin of silhouetteSmooth for tests and for checking the GPU pass against captures: returns the smoothed
 * RGBA picture (same scale as `colour`, unrounded; `white` is the display's full value in that scale). Pixels that
 * keep their value are copied exactly.
 */
export function smoothSilhouettes(frame: SilhouetteFrame, search = SILHOUETTE_SEARCH, white = 255): Float64Array {
  const { width, height, colour, codes } = frame;
  const out = Float64Array.from(colour);
  const index = (x: number, y: number): number =>
    Math.min(height - 1, Math.max(0, y)) * width + Math.min(width - 1, Math.max(0, x));
  const differs = (i: number, j: number): boolean =>
    Math.abs(codes[2 * i]! - codes[2 * j]!) + Math.abs(codes[2 * i + 1]! - codes[2 * j + 1]!) > DIFFERENT;
  const share = (x: number, y: number, tx: number, ty: number, nx: number, ny: number): number => {
    const end = (direction: 1 | -1): { distance: number; height: number } => {
      let previousOwn = index(x, y);
      let previousFar = index(x + nx, y + ny);
      for (let i = 1; i <= search; i++) {
        const own = index(x + tx * direction * i, y + ty * direction * i);
        const far = index(x + tx * direction * i + nx, y + ty * direction * i + ny);
        const ownStep = differs(own, previousOwn);
        const farStep = differs(far, previousFar);
        if (ownStep || farStep) return { distance: i - 1, height: (farStep ? 0.5 : 0) - (ownStep ? 0.5 : 0) };
        previousOwn = own;
        previousFar = far;
      }
      return { distance: search, height: 0 };
    };
    const before = end(-1);
    const after = end(1);
    const length = before.distance + after.distance + 1;
    const half = length / 2;
    const x0 = before.distance;
    const x1 = x0 + 1;
    const b = Math.min(x1, half);
    const a = Math.max(x0, half);
    const first = Math.max(-before.height, 0) * Math.max(b - x0, 0) * (1 - (x0 + b) / length);
    const second = Math.max(-after.height, 0) * Math.max(x1 - a, 0) * ((a + x1) / length - 1);
    return Math.max(first, 0) + Math.max(second, 0);
  };
  const linear = (value: number): number => Math.pow(Math.min(Math.max(value / white, 0), 1), SILHOUETTE_GAMMA);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = index(x, y);
      const edgeL = differs(i, index(x - 1, y));
      const edgeR = differs(i, index(x + 1, y));
      const edgeU = differs(i, index(x, y - 1));
      const edgeD = differs(i, index(x, y + 1));
      if (!edgeL && !edgeR && !edgeU && !edgeD) continue;
      const shareL = edgeL ? share(x, y, 0, 1, -1, 0) : 0;
      const shareR = edgeR ? share(x, y, 0, 1, 1, 0) : 0;
      const shareU = edgeU ? share(x, y, 1, 0, 0, -1) : 0;
      const shareD = edgeD ? share(x, y, 1, 0, 0, 1) : 0;
      const horizontal = Math.max(shareL, shareR) > Math.max(shareU, shareD) + AXIS_MARGIN;
      const shareA = horizontal ? shareL : shareU;
      const shareB = horizontal ? shareR : shareD;
      const total = shareA + shareB;
      if (!(total > 0)) continue;
      const sideA = horizontal ? index(x - 1, y) : index(x, y - 1);
      const sideB = horizontal ? index(x + 1, y) : index(x, y + 1);
      for (let channel = 0; channel < 3; channel++) {
        const own = linear(colour[4 * i + channel]!);
        const mixed =
          own +
          ((linear(colour[4 * sideA + channel]!) - own) * shareA * shareA) / total +
          ((linear(colour[4 * sideB + channel]!) - own) * shareB * shareB) / total;
        out[4 * i + channel] = white * Math.pow(Math.max(mixed, 0), 1 / SILHOUETTE_GAMMA);
      }
    }
  }
  return out;
}
