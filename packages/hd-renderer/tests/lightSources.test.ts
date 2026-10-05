import { describe, expect, it, vi } from 'vitest';
import {
  Mesh,
  Vector3,
  LinearFilter,
  type InstancedBufferAttribute,
  type InstancedMesh,
  type WebGPURenderer,
} from 'three/webgpu';
import { HdRenderer } from '../src/HdRenderer';
import { AtmosphereNodes } from '../src/atmosphere';
import { EmitterLayer } from '../src/emitters';
import { LightField, SHAPE_SOFT, flicker, type DynamicLight, type SourceSpec } from '../src/lightField';

const spec: SourceSpec = {
  x: 3,
  z: 2,
  colour: [0.35, 0.75, 2.6],
  radius: 3.6,
  peak: 2,
  flicker: 0.3,
  seed: 0.42,
  ttl: 1,
  head: 1.2,
  glow: [0.9, 1.6, 4],
  glowSize: 1.5,
  push: 1.8,
  hole: [1.5, 1],
  holeOffset: [0.2, -0.3],
};

function fixture() {
  const nodes = new AtmosphereNodes();
  const field = new LightField(8, 8, { nodes });
  const renderer = {
    getRenderTarget: () => null,
    setRenderTarget: vi.fn(),
    render: vi.fn(),
    getClearAlpha: () => 1,
    setClearAlpha: vi.fn(),
  } as unknown as WebGPURenderer;
  const dynamics = (
    field as unknown as {
      dynamics: {
        mesh: InstancedMesh;
        aPos: InstancedBufferAttribute;
        aCol: InstancedBufferAttribute;
        aExtra: InstancedBufferAttribute;
        aHoleOffset: InstancedBufferAttribute;
      };
    }
  ).dynamics;
  return {
    field,
    renderer,
    dynamics,
    dispose: () => {
      field.dispose();
      nodes.dispose();
    },
  };
}

describe('electrical source flicker', () => {
  it('is deterministic, bounded and varying, with exactly steady zero amplitude', () => {
    for (const amp of [0, 0.3, 1]) {
      for (const seed of [0, 0.12, 0.42, 123]) {
        const values = Array.from({ length: 3000 }, (_, i) => flicker(seed, (i - 100) / 137, amp));
        expect(values).toEqual(values.map((_, i) => flicker(seed, (i - 100) / 137, amp)));
        expect(Math.min(...values)).toBeGreaterThanOrEqual(1 - amp);
        expect(Math.max(...values)).toBeLessThanOrEqual(1 + amp);
        if (amp > 0) expect(new Set(values).size).toBeGreaterThan(10);
        else expect(values.every((v) => v === 1)).toBe(true);
      }
    }
    expect(flicker(0.12, 1, 0.3)).not.toBe(flicker(0.42, 1, 0.3));
  });

  it('crossfades through a level boundary instead of jumping', () => {
    const values = Array.from({ length: 10000 }, (_, i) => flicker(0.42, i / 10000, 1));
    const changes = values.slice(1).map((v, i) => Math.abs(v - values[i]!));
    expect(Math.max(...changes)).toBeLessThan(0.02);
  });
});

describe('kept source lights', () => {
  it('shares CPU intensity with its glow, fades in and out, and survives repeated refreshes', () => {
    const { field, renderer, dynamics, dispose } = fixture();
    const out: DynamicLight[] = [];
    try {
      field.source('orb', 0, spec);
      expect(field.dynamicLights(0, out)[0]?.colour).toEqual([0, 0, 0]);
      for (const now of [0.125, 0.25, 1, 2]) {
        field.source('orb', now, spec);
        field.update(now, renderer, 0);
        const light = field.dynamicLights(now, out)[0]!;
        const intensity = spec.peak! * Math.min(1, now / 0.25) * flicker(spec.seed!, now, spec.flicker!);
        expect(light).toMatchObject({ kind: 'source', head: 1.2, glowSize: 1.5, push: 1.8 });
        expect(light.colour[2]).toBeCloseTo(2.6 * intensity);
        expect(light.glow![2]).toBeCloseTo(4 * intensity);
        expect(dynamics.aCol.getZ(0)).toBeCloseTo(light.colour[2]);
        expect(dynamics.aCol.getW(0)).toBe(0);
        expect(dynamics.aExtra.getY(0)).toBe(1.5);
        expect(dynamics.aExtra.getZ(0)).toBe(1);
        // No ground-only share by default: the field's alpha stays zero (objectLightAt is then plain objectLight).
        expect(dynamics.aExtra.getW(0)).toBe(0);
        expect(dynamics.aHoleOffset.getX(0)).toBeCloseTo(0.2);
        expect(field.stats(now).sources).toBe(1);
      }
      const faded = field.dynamicLights(2.75, out)[0]!;
      expect(faded.glow![2]).toBeCloseTo(4 * spec.peak! * 0.5 * flicker(spec.seed!, 2.75, spec.flicker!));
      expect(field.dynamicLights(3.01, out)).toEqual([]);
      field.update(3.01, renderer, 0);
      expect(field.stats(3.01).sources).toBe(0);
      expect(dynamics.mesh.count).toBe(0);
    } finally {
      dispose();
    }
  });

  it('uploads a continuous soft shape without a rectangle and preserves linear field filtering', () => {
    const { field, renderer, dynamics, dispose } = fixture();
    try {
      expect(field.texelsPerCell).toBe(8);
      expect(field.target.texture.minFilter).toBe(LinearFilter);
      expect(field.target.texture.magFilter).toBe(LinearFilter);
      field.source('radial', 0, { ...spec, shape: SHAPE_SOFT, hole: undefined, holeOffset: undefined });
      field.update(0.5, renderer, 0);
      expect(dynamics.aPos.getW(0)).toBe(SHAPE_SOFT);
      expect(dynamics.aExtra.getY(0)).toBe(0);
      expect(dynamics.aExtra.getZ(0)).toBe(0);
    } finally {
      dispose();
    }
  });

  it('shares a custom half-second fade with overlays and preserves it across refreshes', () => {
    const { field, renderer, dynamics, dispose } = fixture();
    try {
      const source = { ...spec, peak: 1, flicker: 0, fadeIn: 0.5, fadeStart: 3 };
      field.source('new', 3, source);
      for (const [now, expected] of [
        [3, 0],
        [3.25, 0.5],
        [3.5, 1],
      ]) {
        field.source('new', now!, source);
        expect(field.sourceFade('new', now!)).toBeCloseTo(expected!);
        field.update(now!, renderer, 0);
        expect(dynamics.aCol.getZ(0)).toBeCloseTo(source.colour[2] * expected!);
        expect(field.dynamicLights(now!, [])[0]!.glow![2]).toBeCloseTo(source.glow![2] * expected!);
      }
      field.source('existing', 3.5, { ...source, fadeStart: 3 });
      expect(field.sourceFade('existing', 3.5)).toBe(1);
      field.retainSources(new Set(['existing']));
      expect(field.sourceFade('new', 3.5)).toBe(0);
      expect(field.dynamicLights(3.5, [])).toHaveLength(1);
      field.retainSources(new Set());
      field.update(3.5, renderer, 0);
      expect(dynamics.mesh.count).toBe(0);
    } finally {
      dispose();
    }
  });

  it('refreshes source colour and emitter metadata and clears immediately when disabled', () => {
    const { field, dispose } = fixture();
    try {
      field.source('orb', 0, spec);
      field.source('orb', 1, { ...spec, colour: [1, 2, 3], glow: null, head: 2, flicker: 0 });
      expect(field.dynamicLights(1, [])[0]).toMatchObject({ colour: [2, 4, 6], glow: [0, 0, 0], head: 2 });
      field.clearSources();
      expect(field.dynamicLights(1, [])).toEqual([]);
      expect(field.stats(1).sources).toBe(0);
    } finally {
      dispose();
    }
  });

  it('preserves pulse and fire intensity, TTL and shader flicker, without a hole', () => {
    const { field, renderer, dynamics, dispose } = fixture();
    try {
      field.source('orb', 0, spec);
      field.dynamicLights(0.25, []);
      field.clearSources();
      field.pulse(0, new Vector3(2, 0, 2), [1, 0.5, 0.25], 2, 3, 1, 2, 'explosion');
      field.keep('fire', 0, new Vector3(1, 0, 1), [1, 0.4, 0.1], 1, 2, 0.2, 1);
      field.update(0.25, renderer, 0);
      expect(dynamics.aCol.getX(0)).toBeCloseTo(3 * Math.exp(-0.5));
      expect(dynamics.aCol.getX(1)).toBe(2);
      expect(dynamics.aCol.getW(1)).toBeCloseTo(0.2);
      for (let i = 0; i < 2; i++) {
        expect(dynamics.aExtra.getY(i)).toBe(0);
        expect(dynamics.aExtra.getZ(i)).toBe(0);
        expect(dynamics.aHoleOffset.getX(i)).toBe(0);
      }
      const lights = field.dynamicLights(0.25, []);
      expect(lights.map((l) => l.kind)).toEqual(['pulse', 'fire']);
      expect(lights.every((l) => l.head === undefined && l.glow === undefined)).toBe(true);
      field.update(0.75, renderer, 0);
      expect(dynamics.aCol.getX(1)).toBe(1);
      field.update(1.01, renderer, 0);
      expect(field.stats(1.01)).toMatchObject({ kept: 0, explosion: 0, sources: 0 });
    } finally {
      dispose();
    }
  });

  it('mirrors source radiance, terrain height, size and depth push without retaining them on reused pulse heads', () => {
    const field = { dynamicLights: vi.fn() };
    const setDynamic = vi.fn();
    const source: DynamicLight = {
      x: 3,
      z: 2,
      kind: 'source',
      colour: [0.35, 0.75, 2.6],
      glow: [0.9, 1.6, 4],
      head: 1.2,
      glowSize: 1.5,
      push: 1.8,
    };
    field.dynamicLights.mockReturnValue([source]);
    const renderer = Object.assign(Object.create(HdRenderer.prototype), {
      lightField: field,
      dynamicLights: [],
      dynamicEmitterPool: [],
      dynamicEmitters: [],
      lighting: { referenceIrradiance: () => 2 },
      terrain: { heightAt: () => 0.8 },
      waterY: 0,
      emitters: { setDynamic },
    }) as { mirrorDynamicEmitters(now: number): void };
    renderer.mirrorDynamicEmitters(1);
    const emitter = setDynamic.mock.calls[0]![0][0];
    expect(emitter).toMatchObject({ x: 3, y: 0.8, z: 2, head: 1.2, size: 1.5, push: 1.8, glow: [0.9, 1.6, 4] });
    expect(emitter.streak[2]).toBeCloseTo((2.6 / 2) * 0.35);
    const coreLuminance = (0.2126 * emitter.glow[0] + 0.7152 * emitter.glow[1] + 0.0722 * emitter.glow[2]) * 2.5;
    expect(coreLuminance).toBeGreaterThan(1);
    field.dynamicLights.mockReturnValue([{ x: 1, z: 1, kind: 'pulse', colour: [1, 0.5, 0.2] }]);
    renderer.mirrorDynamicEmitters(2);
    const pulse = setDynamic.mock.calls[1]![0][0];
    expect(pulse).toBe(emitter);
    expect(pulse.head).toBe(0.8);
    expect(pulse.size).toBeUndefined();
    expect(pulse.push).toBeUndefined();
    expect(pulse.glow[0]).toBe((1 / 2) * 0.12);
  });

  it('honours an explicit dynamic head size without changing the default size', () => {
    const nodes = new AtmosphereNodes();
    const emitters = new EmitterLayer(nodes);
    try {
      const emitter = { x: 0, y: 0, z: 0, head: 1.2, glow: [1, 2, 4] as const, streak: [0, 0, 0] as const };
      emitters.setDynamic([{ ...emitter, size: 1.5 }, emitter]);
      const heads = emitters.root.children[2] as InstancedMesh;
      const attributes = (emitters as unknown as { layers: { attrs: InstancedBufferAttribute[] }[] }).layers[1]!.attrs;
      expect(heads.count).toBe(2);
      expect(attributes[1]!.getW(0)).toBe(1.5);
      expect(attributes[1]!.getW(1)).toBeCloseTo(1.6);
    } finally {
      emitters.root.traverse((o) => {
        if (o instanceof Mesh) {
          o.geometry.dispose();
          if (Array.isArray(o.material)) o.material.forEach((m) => m.dispose());
          else o.material.dispose();
          if ('dispose' in o && typeof o.dispose === 'function') o.dispose();
        }
      });
      nodes.dispose();
    }
  });
});

describe('ground-only source share', () => {
  it('writes the clamped share per instance and renders the field from a zero clear alpha', () => {
    const { field, renderer, dynamics, dispose } = fixture();
    try {
      field.source('orb', 1, { ...spec, groundOnly: 1 });
      field.source('half', 1, { ...spec, x: 6, groundOnly: 2 });
      field.update(1, renderer, 0);
      expect(dynamics.aExtra.getW(0)).toBe(1);
      expect(dynamics.aExtra.getW(1)).toBe(1);
      const r = renderer as unknown as { setClearAlpha: ReturnType<typeof vi.fn> };
      // Zero while the field renders, then the renderer's own clear alpha again.
      expect(r.setClearAlpha.mock.calls).toEqual([[0], [1]]);
    } finally {
      dispose();
    }
  });
});

describe('base grid night gain', () => {
  const baseGain = (field: LightField) => (field as unknown as { baseGain: { value: number } }).baseGain.value;
  const encodeScale = (field: LightField) => (field as unknown as { encodeScale: number }).encodeScale;

  it('follows the static gain unless the renderer gives the base grid its own night gain', () => {
    const { field, renderer, dispose } = fixture();
    try {
      const cells = new Float32Array(8 * 8 * 3).fill(0.25);
      field.setBase(cells, 3, true);
      // One gain for both, as before.
      field.update(0, renderer, 0.5);
      expect(baseGain(field)).toBeCloseTo((3 * 0.5) / encodeScale(field), 12);
      // A night map lit by its engine grade: the static dressing stays on, the map sources' own field is off.
      field.update(0, renderer, 2.5, 0);
      expect(baseGain(field)).toBe(0);
      expect(field.stats(0).staticGain).toBe(2.5);
      field.update(0, renderer, 1, 1);
      expect(baseGain(field)).toBeCloseTo(3 / encodeScale(field), 12);
      // A base that is always on (it does not follow the night) ignores both.
      field.setBase(cells, 3, false);
      field.update(0, renderer, 0, 0);
      expect(baseGain(field)).toBeCloseTo(3 / encodeScale(field), 12);
    } finally {
      dispose();
    }
  });
});
