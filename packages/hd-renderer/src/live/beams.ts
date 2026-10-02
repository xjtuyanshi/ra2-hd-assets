import {
  AdditiveBlending,
  Color as ThreeColor,
  DoubleSide,
  MeshBasicNodeMaterial,
  SRGBColorSpace,
  Vector3,
} from 'three/webgpu';
import {
  Fn,
  cross,
  float,
  floor,
  fract,
  instancedBufferAttribute,
  length,
  max,
  mix,
  normalize,
  positionGeometry,
  sin,
  smoothstep,
  step,
  uniform,
  varying,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import { DirtyAttribute } from '../dirtyAttribute';
import { InstancedQuad } from '../instancedQuad';
import type { ShaderNode } from '../tsl';
import { PIXELS_PER_CELL_EDGE } from '../world';
import { engineAnchor } from './effectSprites';
import type { EffectStyle, LiveEffects } from './effects';

interface Point {
  x: number;
  y: number;
  z: number;
}
export interface LiveRadBeam {
  id: number;
  type: 'rad' | 'temporal' | 'eruption';
  source: Point;
  target: Point;
  color: [number, number, number];
  period: number;
  amplitude: number;
  age: number;
  sustained: boolean;
  progress: number;
}
export interface LiveWave {
  id: number;
  uid: number;
  type: 'sonic' | 'laser' | 'biglaser' | 'magnetron';
  source: Point;
  target: Point;
  intensity: number;
  progress: number;
}
export interface LiveMindControlLink {
  id: number;
  controller: number;
  targetId: number;
  source: Point;
  target: Point;
  color: [number, number, number];
  /** Height of the world-space parabolic arch, in leptons. */
  arcHeight: number;
  remainingFrames: number;
  selected: boolean;
}

// Extend the existing snapshot contract here so effects.ts retains its independent laser/EBolt implementation.
declare module './effects' {
  interface LiveEffects {
    radBeams?: LiveRadBeam[];
    waves?: LiveWave[];
    mindControlLinks?: LiveMindControlLink[];
  }
}

export const RIBBON_SEGMENTS = 64;
export const RAD_MAX_SEGMENTS = 512;
export const BEAM_RIBBON_CAPACITY = 4096;
export const RING_SEGMENTS = 32;
export const LINK_SEGMENTS = 32;
/** Full widths in world units: zoom scales the complete profile, including its white-hot core. */
export const BEAM_WIDTHS = {
  halo: 12 / PIXELS_PER_CELL_EDGE,
  inner: 4 / PIXELS_PER_CELL_EDGE,
  core: 1.5 / PIXELS_PER_CELL_EDGE,
};
export const BEAM_STRANDS = 2;
const toWorld = (p: Point) => engineAnchor(p.x, p.y, p.z);
const clamp01 = (n: number) => Math.max(0, Math.min(1, n));
// IsoCamera's fixed yaw 45°, pitch 30°; using another pitch makes screen-facing ellipses tilt edge-on.
const CAMERA_DIRECTION = new Vector3(Math.sqrt(3 / 8), 0.5, Math.sqrt(3 / 8));
const CAMERA_RIGHT = new Vector3(Math.SQRT1_2, 0, -Math.SQRT1_2);

/** A stable orthonormal frame even for vertical or camera-parallel beams. */
function basis(from: Vector3, to: Vector3): [Vector3, Vector3] {
  const along = to.clone().sub(from);
  along.addScaledVector(CAMERA_DIRECTION, -along.dot(CAMERA_DIRECTION));
  if (along.lengthSq() < 1e-8) along.copy(CAMERA_RIGHT);
  along.normalize();
  return [new Vector3().crossVectors(along, CAMERA_DIRECTION).normalize(), along];
}

/**
 * World-space sine ribbon with exact engine endpoints. Amplitude is in leptons;
 * Period drives the phase through engine age, rather than inventing a host lifetime.
 * The sine envelope pins both endpoints while retaining the native amplitude bound.
 */
export function ribbonPoints(
  beam: Pick<LiveRadBeam, 'source' | 'target' | 'amplitude' | 'age' | 'period'>,
  phaseOffset = 0,
): Vector3[] {
  const from = toWorld(beam.source),
    to = toWorld(beam.target);
  const [across] = basis(from, to);
  const amplitude = engineAnchor(beam.amplitude, 0, 0).length() * Math.sign(beam.amplitude);
  const phase = beam.age / Math.max(1, beam.period);
  return Array.from({ length: RIBBON_SEGMENTS + 1 }, (_, i) => {
    const t = i / RIBBON_SEGMENTS;
    const displacement =
      i === 0 || i === RIBBON_SEGMENTS
        ? 0
        : Math.sin(t * Math.PI) * Math.sin(2 * Math.PI * (3 * t - phase) + phaseOffset) * amplitude;
    return from.clone().lerp(to, t).addScaledVector(across, displacement);
  });
}

function radLength(beam: LiveRadBeam): number {
  return Math.hypot(beam.target.x - beam.source.x, beam.target.y - beam.source.y, beam.target.z - beam.source.z);
}

function radDisplacement(beam: LiveRadBeam, t: number): number {
  const phase = (t * 2 * Math.max(radLength(beam), 360) * Math.PI) / 180;
  return Math.sin(phase) * beam.amplitude * clamp01(beam.age / Math.max(1, beam.period));
}

/** Native type-1 radiation/chrono sine: one strand displaces world Z, with age scaling amplitude, not phase. */
export function nativeRadPoints(beam: LiveRadBeam): Vector3[] {
  const segments = Math.min(RAD_MAX_SEGMENTS, Math.max(RIBBON_SEGMENTS, Math.ceil(radLength(beam) / 15)));
  return Array.from({ length: segments + 1 }, (_, i) => {
    const t = i / segments;
    // Native integer stepping and its final sine can miss the cached target. HD pins the two weapon anchors.
    const displacement = i === 0 || i === segments ? 0 : radDisplacement(beam, t);
    return toWorld({
      x: beam.source.x + (beam.target.x - beam.source.x) * t,
      y: beam.source.y + (beam.target.y - beam.source.y) * t,
      z: beam.source.z + (beam.target.z - beam.source.z) * t + displacement,
    });
  });
}

/** One world-space arch, not a camera-plane wave; its endpoints retain the observed weapon coordinates. */
export function mindControlPoints(link: LiveMindControlLink): Vector3[] {
  return Array.from({ length: LINK_SEGMENTS + 1 }, (_, i) => {
    const t = i / LINK_SEGMENTS;
    return toWorld({
      x: link.source.x + (link.target.x - link.source.x) * t,
      y: link.source.y + (link.target.y - link.source.y) * t,
      z: link.source.z + (link.target.z - link.source.z) * t + 4 * link.arcHeight * t * (1 - t),
    });
  });
}

function ringProgress(wave: LiveWave, i: number, count: number): number {
  return (clamp01(wave.progress) * 1.6 + i / count) % 1;
}

/** Camera-facing ellipses centred on the actual 3D path, with full axes 2r across and 0.4r along the screen path. */
export function waveRings(wave: LiveWave): Vector3[][] {
  const from = toWorld(wave.source),
    to = toWorld(wave.target);
  const [across, along] = basis(from, to);
  const count = wave.type === 'sonic' ? 6 : 7;
  return Array.from({ length: count }, (_, i) => {
    const t = ringProgress(wave, i, count);
    const centre = from.clone().lerp(to, t);
    const radius =
      wave.type === 'sonic'
        ? 0.4 * (0.6 + 0.8 * t)
        : 0.27 * (1 + 0.2 * Math.sin(2 * Math.PI * (wave.progress * 2 + i / count)));
    return Array.from({ length: RING_SEGMENTS + 1 }, (_, j) => {
      const angle = (j === RING_SEGMENTS ? 0 : j / RING_SEGMENTS) * 2 * Math.PI;
      return centre
        .clone()
        .addScaledVector(across, Math.cos(angle) * radius)
        .addScaledVector(along, Math.sin(angle) * radius * 0.2);
    });
  });
}

/** The shader's bounded travelling noise, expressed numerically for deterministic asset-free checks (seconds). */
export function beamIntensity(now: number, distance: number, seed: number): number {
  const phase = distance * 9 - now * 8 + seed * 0.73;
  return 1 + Math.sin(phase) * 0.08 + Math.sin(phase * 2.17 + seed) * 0.04;
}

type Color = readonly [number, number, number];
interface StrokeStyle {
  color: Color;
  hot: Color;
  widths: typeof BEAM_WIDTHS;
  /** A travelling highlight on a 32-segment link; negative phase disables it for other strokes. */
  linkFlow?: boolean;
}
/** Snapshot colours are authored display RGB; shader light values must be linear. */
export function beamColor(color: Color): [number, number, number] {
  const linear = new ThreeColor().setRGB(color[0] / 255, color[1] / 255, color[2] / 255, SRGBColorSpace);
  return [linear.r, linear.g, linear.b];
}
function radStyle(beam: LiveRadBeam): StrokeStyle {
  const color = beamColor(beam.color);
  return {
    color,
    hot: color.map((component) => 0.72 + 0.28 * component) as [number, number, number],
    widths: BEAM_WIDTHS,
  };
}
function scaledStyle(style: StrokeStyle, scale: number): StrokeStyle {
  return {
    ...style,
    widths: { halo: style.widths.halo * scale, inner: style.widths.inner * scale, core: style.widths.core * scale },
  };
}
const MAGNETRON_STYLE = scaledStyle({ color: [0.8, 0.12, 1], hot: [1, 0.65, 1], widths: BEAM_WIDTHS }, 0.6);
const SONIC_STYLE: StrokeStyle = {
  color: [0.42, 0.88, 1],
  hot: [0.8, 1, 1],
  widths: { halo: 3 / PIXELS_PER_CELL_EDGE, inner: 1.5 / PIXELS_PER_CELL_EDGE, core: 0 },
};

/** Native draw-cycle fade; sustained ribbons retain light until the engine removes them. */
export function beamFade(progress: number, sustained = false): number {
  return sustained ? 0.85 + 0.15 * Math.sin(Math.PI * clamp01(progress)) : 1 - clamp01(progress);
}

/** One fixed GPU pool for all ribbons and ripple strokes; LiveView owns construction and disposal. */
export class LiveBeams {
  readonly mesh: InstancedQuad;
  readonly displayScale = uniform(1);
  private readonly enhanced = uniform(0);
  private readonly from = new DirtyAttribute(new Float32Array(BEAM_RIBBON_CAPACITY * 3), 3);
  private readonly to = new DirtyAttribute(new Float32Array(BEAM_RIBBON_CAPACITY * 3), 3);
  // All profile/noise attributes share ONE vertex buffer: four total with the two endpoints and the quad position.
  private readonly appearance = new DirtyAttribute(new Float32Array(BEAM_RIBBON_CAPACITY * 14), 14);
  private count = 0;
  private publication = '';
  private style: EffectStyle = 'faithful';

  constructor(cameraRight: ShaderNode, cameraUp: ShaderNode, now: ShaderNode) {
    const material = new MeshBasicNodeMaterial();
    material.transparent = true;
    material.depthWrite = false;
    material.blending = AdditiveBlending;
    material.side = DoubleSide;
    const a: ShaderNode = instancedBufferAttribute(this.from, 'vec3');
    const b: ShaderNode = instancedBufferAttribute(this.to, 'vec3');
    const appearance = this.appearance.interleaved();
    const tint: ShaderNode = instancedBufferAttribute(appearance, 'vec3', 14, 0);
    const hot: ShaderNode = instancedBufferAttribute(appearance, 'vec3', 14, 3);
    const widths: ShaderNode = instancedBufferAttribute(appearance, 'vec3', 14, 6);
    const gain: ShaderNode = instancedBufferAttribute(appearance, 'float', 14, 9);
    const noise: ShaderNode = instancedBufferAttribute(appearance, 'vec2', 14, 10);
    const legacyFlag: ShaderNode = instancedBufferAttribute(appearance, 'float', 14, 12);
    const linkFlow: ShaderNode = instancedBufferAttribute(appearance, 'float', 14, 13);
    const legacy: ShaderNode = legacyFlag.greaterThan(0);
    const width: ShaderNode = widths.x;
    const span: ShaderNode = length(b.sub(a));
    material.positionNode = Fn(() => {
      // Zero-length strokes are round, camera-facing endpoint flares, using the same bounded GPU pool.
      const axis: ShaderNode = span.greaterThan(1e-5).select(b.sub(a).div(span.max(1e-5)), cameraRight);
      const across: ShaderNode = cross(axis, cross(cameraRight, cameraUp));
      const side: ShaderNode = length(across).greaterThan(1e-4).select(normalize(across), cameraRight);
      const along: ShaderNode = positionGeometry.x.add(0.5).mul(span.add(width)).sub(width.mul(0.5));
      return a.add(axis.mul(along)).add(side.mul(positionGeometry.y.mul(width)));
    })();
    // Per-instance scalars cross to the fragment stage as explicit varyings; reading the endpoint attributes there
    // directly gave a wrong span on Metal (each strand segment rendered as a long quad towards the origin).
    const spanV: ShaderNode = varying(span);
    const seedV: ShaderNode = varying(a.x.mul(11).add(a.z.mul(7)));
    material.colorNode = Fn(() => {
      const span: ShaderNode = spanV;
      // Quad coordinates straight from the geometry (as positionNode uses them), not uv().
      const quad: ShaderNode = varying(positionGeometry.xy);
      const along: ShaderNode = quad.x.add(0.5).mul(span.add(width)).sub(width.mul(0.5));
      const cap: ShaderNode = max(along.negate(), along.sub(span)).max(0).div(width.mul(0.5));
      // Each fragment's light goes through the material's tone mapping before additive blending, so overlapping
      // contributions of one stroke do not sum linearly: round caps at every polyline joint (or any split of a point's
      // light across neighbouring quads) show up as a string of beads. Polyline strokes therefore own exactly their
      // [0, span] interval and only a stroke's true ends get a round cap (flag -(1 + start + 2 * end)); lasers (flag 1)
      // and zero-length flares keep round caps on both ends.
      const capCode: ShaderNode = legacyFlag.negate().sub(1).max(0);
      const endCap: ShaderNode = floor(capCode.mul(0.5));
      const startCap: ShaderNode = capCode.sub(endCap.mul(2));
      // Arithmetic masks (step) rather than nested selects: the body, the start cap side and the end cap side.
      const afterStart: ShaderNode = step(0, along);
      const beforeEnd: ShaderNode = step(along, span);
      const coverage: ShaderNode = mix(
        afterStart
          .mul(beforeEnd)
          .add(float(1).sub(afterStart).mul(startCap))
          .add(float(1).sub(beforeEnd).mul(endCap))
          .min(1),
        1,
        step(0.5, legacyFlag),
      );
      const r: ShaderNode = length(vec2(cap, quad.y.mul(2)));
      const halo: ShaderNode = smoothstep(1, 0, r);
      const inner: ShaderNode = smoothstep(widths.y.div(width).max(1e-5), 0, r);
      const core: ShaderNode = smoothstep(widths.z.div(width).max(1e-5), 0, r).mul(widths.z.greaterThan(0));
      // Path distance, rather than map position, carries low-amplitude noise from muzzle to impact.
      const phase: ShaderNode = noise.x.add(along.clamp(0, span)).mul(9).sub(now.mul(8)).add(noise.y.mul(0.73));
      const flicker: ShaderNode = sin(phase)
        .mul(0.08)
        .add(sin(phase.mul(2.17).add(noise.y)).mul(0.04))
        .add(1);
      // Native links sweep a house-colour -> white highlight along their 32 segments every 1.024 seconds.
      // Interpolate within each segment for a smooth HD flow, without changing their publication-owned lifetime.
      const linkPhase: ShaderNode = fract(
        linkFlow.add(along.div(span.max(1e-5)).clamp(0, 1).div(64)).sub(now.div(1.024)),
      );
      const linkHighlight: ShaderNode = linkPhase
        .mul(2)
        .mul(smoothstep(0.5, 0.45, linkPhase))
        .mul(step(0, linkFlow));
      const strokeHot: ShaderNode = mix(hot, vec3(1), linkHighlight);
      const light = tint
        .mul(
          halo
            .mul(halo)
            .mul(0.55)
            .add(inner.mul(1.1))
            .mul(mix(0.6, 1, this.enhanced)),
        )
        .add(strokeHot.mul(core.mul(2.2)));
      const laserLight = tint
        .mul(halo.mul(halo).mul(mix(0.5, 1.1, this.enhanced)))
        .add(vec3(1, 0.98, 0.96).mul(core.mul(1.8)));
      const laserFlicker = sin(now.mul(23).add(seedV)).mul(0.04).add(0.96);
      return vec4(
        legacy
          .select(laserLight, light)
          .mul(gain)
          .mul(coverage)
          .mul(legacy.select(laserFlicker, flicker))
          .mul(this.displayScale),
        1,
      );
    })();
    this.mesh = new InstancedQuad(material, BEAM_RIBBON_CAPACITY);
    this.mesh.name = 'live-rad-beams-waves-links';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 7;
    this.mesh.count = 0;
    this.mesh.visible = false;
  }

  /** Replace by publication, including same-frame endpoint/life changes and an unavailable/empty effects list. */
  update(
    effects: LiveEffects | null | undefined,
    style: EffectStyle,
    hidden: (x: number, y: number, z: number) => boolean,
  ): void {
    // Include visibility results: a shroud publication can hide a stationary beam without changing its data.
    const rad = (effects?.radBeams ?? []).filter(
      (b) =>
        b.type === 'rad' ||
        (!hidden(b.source.x, b.source.y, b.source.z) && !hidden(b.target.x, b.target.y, b.target.z)),
    );
    const waves = (effects?.waves ?? []).filter(
      (b) => !hidden(b.source.x, b.source.y, b.source.z) && !hidden(b.target.x, b.target.y, b.target.z),
    );
    // These auxiliary links follow their observer's native selection/timer policy, which has no endpoint-shroud gate.
    const links = effects?.mindControlLinks ?? [];
    const publication = JSON.stringify([rad, waves, links]);
    if (publication === this.publication && style === this.style) return;
    this.publication = publication;
    this.style = style;
    this.enhanced.value = style === 'enhanced' ? 1 : 0;
    this.count = 0;
    for (const beam of rad) {
      if (this.count >= BEAM_RIBBON_CAPACITY) break;
      const style = radStyle(beam);
      if (beam.type === 'rad') {
        if (!beam.sustained && beam.age >= beam.period) continue;
        const points = nativeRadPoints(beam);
        // The native segment colour follows its height displacement. There is no age-driven opacity fade.
        const gains = points
          .slice(1)
          .map((_, i) =>
            beam.amplitude
              ? 0.5 + Math.abs(radDisplacement(beam, (i + 1) / (points.length - 1)) / beam.amplitude) / 2
              : 0.5,
          );
        this.stroke(points, style, 1, beam.id, false, gains);
        continue;
      }
      const gain = beamFade(beam.progress, beam.sustained);
      this.strands(beam, style, gain);
      this.endpoints(toWorld(beam.source), toWorld(beam.target), style, gain, beam.id);
    }
    for (const wave of waves) {
      if (this.count >= BEAM_RIBBON_CAPACITY) break;
      const fade = beamFade(wave.progress);
      const from = toWorld(wave.source),
        to = toWorld(wave.target);
      if (wave.type === 'magnetron') {
        this.strands({ ...wave, amplitude: 18, age: wave.progress * 20, period: 20 }, MAGNETRON_STYLE, fade);
        this.endpoints(from, to, MAGNETRON_STYLE, fade, wave.id);
      } else if (wave.type === 'sonic') {
        this.stroke(
          [from, to],
          { ...SONIC_STYLE, widths: { halo: BEAM_WIDTHS.halo, inner: 0, core: 0 } },
          fade * 0.12,
          wave.id,
        );
      } else {
        // Preserve the pre-existing laser/biglaser profile and single-strand policy.
        const width = wave.type === 'biglaser' ? 0.28 : 0.16;
        this.stroke(
          [from, to],
          {
            color: [1, (95 / 255) ** 2.2, (60 / 255) ** 2.2],
            hot: [1, 0.98, 0.96],
            widths: { halo: width, inner: 0, core: width * 0.14 },
          },
          fade,
          wave.id,
          true,
        );
      }
      if (wave.type === 'magnetron' || wave.type === 'sonic') {
        const rings = waveRings(wave);
        const ringStyle = wave.type === 'sonic' ? SONIC_STYLE : scaledStyle(MAGNETRON_STYLE, 0.65);
        rings.forEach((ring, i) => {
          const gain = wave.type === 'sonic' ? 0.5 : 0.55 + 0.9 * ringProgress(wave, i, rings.length);
          this.stroke(ring, ringStyle, fade * gain, wave.id + i);
        });
      }
    }
    for (const link of links) {
      if (this.count >= BEAM_RIBBON_CAPACITY) break;
      const color = beamColor(link.color);
      // The observer owns selection/capture-timer gating. A valid publication stays fully lit until removed.
      this.stroke(
        mindControlPoints(link),
        {
          color,
          hot: color,
          widths: { halo: 6 / PIXELS_PER_CELL_EDGE, inner: 2 / PIXELS_PER_CELL_EDGE, core: 1 / PIXELS_PER_CELL_EDGE },
          linkFlow: true,
        },
        1,
        link.id,
      );
    }
    for (const attribute of [this.from, this.to, this.appearance]) attribute.flush();
    this.mesh.count = this.count;
    this.mesh.visible = this.count > 0;
  }

  private strands(
    beam: Pick<LiveRadBeam, 'id' | 'source' | 'target' | 'amplitude' | 'age' | 'period'>,
    style: StrokeStyle,
    gain: number,
  ): void {
    this.stroke(ribbonPoints(beam), style, gain, beam.id);
    this.stroke(ribbonPoints(beam, Math.PI), scaledStyle(style, 0.7), gain * 0.45, beam.id);
  }

  private endpoints(from: Vector3, to: Vector3, style: StrokeStyle, gain: number, seed: number): void {
    const flare = (centre: Vector3, size: number, intensity: number) =>
      this.stroke([centre, centre], scaledStyle(style, size), gain * intensity, seed);
    flare(from, 1.8, 0.8);
    flare(to, 3, 1.15);
    const [across, along] = basis(from, to);
    // A small six-ray splash, local to the target and in the camera plane (no displaced ground decal).
    for (let i = 0; i < 6; i++) {
      const angle = (i / 6) * Math.PI * 2;
      const direction = across.clone().multiplyScalar(Math.cos(angle)).addScaledVector(along, Math.sin(angle));
      const reach = BEAM_WIDTHS.halo * (0.65 + 0.15 * Math.sin(seed + i * 2.4));
      this.stroke(
        [to.clone().addScaledVector(direction, reach * 0.35), to.clone().addScaledVector(direction, reach)],
        scaledStyle(style, 0.28),
        gain * 0.55,
        seed + i,
      );
    }
  }

  private stroke(
    points: readonly Vector3[],
    style: StrokeStyle,
    gain: number,
    seed: number,
    legacy = false,
    segmentGains?: readonly number[],
  ): void {
    if (!(gain > 0)) return;
    let distance = 0;
    // Closed rings have no ends; a zero-length flare is a single segment with both caps.
    const closed = points.length > 2 && points[0]!.distanceToSquared(points[points.length - 1]!) < 1e-12;
    for (let i = 1; i < points.length && this.count < BEAM_RIBBON_CAPACITY; i++) {
      const a = points[i - 1]!,
        b = points[i]!,
        n = this.count++;
      this.from.setXYZ(n, a.x, a.y, a.z);
      this.to.setXYZ(n, b.x, b.y, b.z);
      this.appearance.setXYZ(n, ...style.color);
      for (let j = 0; j < 3; j++) this.appearance.setComponent(n, 3 + j, style.hot[j]!);
      this.appearance.setComponent(n, 6, style.widths.halo);
      this.appearance.setComponent(n, 7, style.widths.inner);
      this.appearance.setComponent(n, 8, style.widths.core);
      this.appearance.setComponent(n, 9, gain * (segmentGains?.[i - 1] ?? 1));
      this.appearance.setComponent(n, 10, distance);
      this.appearance.setComponent(n, 11, seed);
      const startCap = i === 1 && !closed ? 1 : 0;
      const endCap = i === points.length - 1 && !closed ? 1 : 0;
      this.appearance.setComponent(n, 12, legacy ? 1 : -(1 + startCap + 2 * endCap));
      this.appearance.setComponent(n, 13, style.linkFlow ? (i - 1) / 64 : -1);
      distance += a.distanceTo(b);
    }
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    (this.mesh.material as MeshBasicNodeMaterial).dispose();
  }
}
