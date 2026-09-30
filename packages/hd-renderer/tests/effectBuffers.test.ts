import { DataTexture, Vector3 } from 'three/webgpu';
import { describe, expect, it, vi } from 'vitest';
import { DirtyAttribute } from '../src/dirtyAttribute';
import {
  BEAM_LIGHTS,
  BEAM_SEGMENTS,
  BeamSegmentBuffer,
  beamSegments,
  type BeamSpec,
  type EffectsLayer,
} from '../src/effects';
import { EffectSpriteLayer, type EffectInstance } from '../src/live/effectSprites';
import { LiveEffectsDriver } from '../src/live/effects';
import type { Ra2Cache } from '../src/ra2/cache';
import { assignPainterBias, painterObject, spritePainterBias } from '../src/ra2/painterOrder';

describe('dirty instance uploads', () => {
  it('compares float32 values and retains pending ranges across multiple writes before rendering', () => {
    const attribute = new DirtyAttribute(new Float32Array(12), 3);
    attribute.setXYZ(0, 0.1, 0, 0);
    expect(attribute.flush()).toBe(true);
    expect(attribute.updateRanges).toEqual([{ start: 0, count: 1 }]);
    const version = attribute.version;
    attribute.setXYZ(0, 0.1, 0, 0);
    expect(attribute.flush()).toBe(false);
    expect(attribute.version).toBe(version);
    attribute.setXYZ(3, 0, 1, 0);
    attribute.flush();
    expect(attribute.updateRanges).toEqual([{ start: 0, count: 11 }]);
    attribute.clearUpdateRanges();
    attribute.setXYZ(3, 0, 2, 0);
    attribute.flush();
    expect(attribute.updateRanges).toEqual([{ start: 10, count: 1 }]);
  });

  it('does no upload for repeated cards, uploads only changed attributes, and preserves painter order', () => {
    const cache = {
      paletteAtlas: { image: { height: 4 } },
      paletteRow: new Map([['fx:anim', 1]]),
    } as unknown as Ra2Cache;
    const layer = new EffectSpriteLayer(cache, () => ({ texture: new DataTexture(), width: 64, height: 64 }));
    const cards: EffectInstance[] = [3, 1, 2].map((depth) => ({
      anchor: new Vector3(depth, 0.1, 1),
      frame: { rect: [0, 0, 8, 8], offset: [-4, -4], page: 0 },
      palette: 'fx:anim',
      alpha: 1,
      push: 0.1,
      draw: 'card',
      pass: 'air',
      depth,
      glow: false,
    }));
    layer.setInstances(cards, 0);
    const mesh = (layer as unknown as { meshes: Map<string, Record<string, DirtyAttribute>> }).meshes.get('0:air')!;
    const attributes = ['anchor', 'rect', 'params', 'style'].map((key) => mesh[key]!);
    expect(Array.from(attributes[0]!.array.slice(0, 9))).toEqual([
      1,
      Math.fround(0.1),
      1,
      2,
      Math.fround(0.1),
      1,
      3,
      Math.fround(0.1),
      1,
    ]);
    const versions = attributes.map((attribute) => attribute.version);
    for (const attribute of attributes) attribute.clearUpdateRanges();
    layer.setInstances(cards, 1);
    expect(attributes.map((attribute) => attribute.version)).toEqual(versions);
    cards[2]!.anchor.y = 0.2;
    layer.setInstances(cards, 2);
    expect(attributes[0]!.updateRanges).toEqual([{ start: 4, count: 1 }]);
    expect(attributes.slice(1).map((attribute) => attribute.updateRanges)).toEqual([[], [], []]);
    expect(attributes.slice(1).map((attribute) => attribute.version)).toEqual(versions.slice(1));
    layer.setInstances([], 3);
    expect(layer.count).toBe(0);
  });

  it('shares bounded ground card biases across pages while leaving decals, shadows and air/top passes physical', () => {
    const atlas = new DataTexture();
    const cache = {
      paletteAtlas: { image: { height: 1 } },
      paletteRow: new Map([['fx:anim', 0]]),
    } as unknown as Ra2Cache;
    const layer = new EffectSpriteLayer(cache, () => ({ texture: atlas, width: 64, height: 64 }));
    const behind = painterObject(2, 100, 1);
    const building = painterObject(2, 150, 2);
    const front = painterObject(2, 200, 3);
    assignPainterBias([front, building, behind]);
    const card = (x: number, painter = behind): EffectInstance => ({
      anchor: new Vector3(x, 0.1, 1),
      frame: { rect: [0, 0, 8, 8], offset: [-4, -4], page: 0 },
      palette: 'fx:anim',
      alpha: 1,
      push: 0.1,
      draw: 'card',
      pass: 'ground',
      depth: x,
      glow: false,
      painter,
    });
    const first = card(1);
    const second = card(2, front);
    const flat = { ...card(3), draw: 'flat' as const };
    const shadow = { ...card(4), draw: 'shadow' as const };
    const otherPage = { ...card(5, front), frame: { ...second.frame, page: 1 }, painterPart: 0.1 };
    type Page = {
      anchor: DirtyAttribute;
      params: DirtyAttribute;
      style: DirtyAttribute;
      mesh: { material: { depthTest: boolean; depthWrite: boolean; depthNode: unknown } };
      dispose(): void;
    };
    const meshes = (layer as unknown as { meshes: Map<string, Page> }).meshes;
    try {
      layer.setInstances([second, shadow, otherPage, first, flat], 0);
      const ground = meshes.get('0:ground')!;
      const other = meshes.get('1:ground')!;
      expect(Array.from(ground.anchor.array.slice(0, 12)).filter((_, index) => index % 3 === 0)).toEqual([3, 4, 1, 2]);
      expect(ground.style.array[3]).toBe(0);
      expect(ground.style.array[7]).toBe(0);
      expect(ground.style.array[11]).toBeCloseTo(behind.bias, 7);
      expect(ground.style.array[15]).toBeCloseTo(front.bias, 7);
      expect(ground.style.array[11]).toBeLessThan(building.bias);
      expect(ground.style.array[15]).toBeGreaterThan(building.bias);
      expect(other.style.array[3]).toBeCloseTo(spritePainterBias(front, 0.1), 7);
      expect(ground.mesh.material).toMatchObject({ depthTest: true, depthWrite: false });
      expect(ground.mesh.material.depthNode).not.toBeNull();
      const placement = [Array.from(ground.anchor.array), Array.from(ground.params.array)];
      second.painterPart = 0.1;
      second.alpha = 0.5;
      layer.setInstances([second, shadow, otherPage, first, flat], 1);
      expect(ground.style.array[15]).toBeCloseTo(spritePainterBias(front, 0.1), 7);
      expect(ground.mesh.material).toMatchObject({ depthTest: true, depthWrite: false });
      expect(ground.mesh.material.depthNode).not.toBeNull();
      expect([Array.from(ground.anchor.array), Array.from(ground.params.array)]).toEqual(placement);
      layer.setInstances(
        [
          { ...first, pass: 'air' },
          { ...second, pass: 'top' },
          { ...first, painter: undefined },
        ],
        2,
      );
      for (const key of ['0:air', '0:top']) {
        const page = meshes.get(key)!;
        expect(page.style.array[3]).toBe(0);
        expect(page.mesh.material).toMatchObject({ depthTest: false, depthWrite: false });
      }
      expect(ground.style.array[3]).toBe(0);
    } finally {
      for (const page of meshes.values()) page.dispose();
      atlas.dispose();
    }
  });
});

const beam = (length: number, seed = 7, bolt = true): BeamSpec => ({
  from: new Vector3(0.123, 0.456, -0.789),
  to: new Vector3(length, 2.25, 3.5),
  colour: new Vector3(0.12, 0.34, 0.9),
  bolt,
  seed,
});

describe('bounded beam geometry', () => {
  it('matches the previous builder exactly, including the visible capacity prefix and white first strands', () => {
    const beams = [beam(0.5, 11, false), beam(4.7), beam(300, 12), beam(100, 19)];
    const expected: number[][] = [[], [], []];
    let count = 0;
    for (const spec of beams) {
      const segments = beamSegments(spec.from, spec.to, spec.bolt, spec.seed);
      const white = spec.bolt ? segments.length / 3 : Infinity;
      for (let i = 0; i < segments.length && count < BEAM_SEGMENTS; i++, count++) {
        const [from, to] = segments[i]!;
        expected[0]!.push(from.x, from.y, from.z);
        expected[1]!.push(to.x, to.y, to.z);
        expected[2]!.push(...(i < white ? [1, 1, 1] : spec.colour.toArray()));
      }
    }
    const buffer = new BeamSegmentBuffer();
    buffer.set(beams);
    expect(buffer.count).toBe(BEAM_SEGMENTS);
    for (const [index, attribute] of [buffer.from, buffer.to, buffer.colour].entries())
      expect(attribute.array.slice(0, count * 3)).toEqual(Float32Array.from(expected[index]!));
    buffer.flush();
    const versions = [buffer.from.version, buffer.to.version, buffer.colour.version];
    buffer.set(beams);
    buffer.flush();
    expect([buffer.from.version, buffer.to.version, buffer.colour.version]).toEqual(versions);
  });

  it('bounds work even for a huge beam or more lasers than capacity', () => {
    const buffer = new BeamSegmentBuffer();
    const random = vi.spyOn(buffer as unknown as { random(): number }, 'random');
    buffer.set([beam(1e12)]);
    expect(buffer.count).toBe(BEAM_SEGMENTS);
    expect(random).toHaveBeenCalledTimes(BEAM_SEGMENTS * 2);
    buffer.set(new Array<BeamSpec>(BEAM_SEGMENTS * 2).fill(beam(1, 0, false)));
    expect(buffer.count).toBe(BEAM_SEGMENTS);
    buffer.set([]);
    expect(buffer.count).toBe(0);
  });

  it('updates beams only on changed logic frames, independent of presentation refresh', () => {
    const setBeams = vi.fn();
    const driver = new LiveEffectsDriver({ setBeams } as unknown as EffectsLayer, () => false);
    const snapshot = { anims: [], bullets: [], particleSystems: [], beams: [] };
    const wind = new Vector3();
    driver.push(snapshot, 100, 0, wind);
    for (let i = 0; i < 144; i++) {
      driver.push(snapshot, 100, i / 144, wind);
      driver.frame(i / 144, wind);
    }
    expect(setBeams).toHaveBeenCalledTimes(1);
    driver.push(snapshot, 101, 1, wind);
    expect(setBeams).toHaveBeenCalledTimes(2);
  });

  it('bounds beam specs while preserving both the visible geometry prefix and surviving light tail', () => {
    const setBeams = vi.fn();
    const driver = new LiveEffectsDriver({ setBeams } as unknown as EffectsLayer, () => false);
    const beams = Array.from({ length: 5000 }, (_, i) => ({
      source: { x: i * 256, y: 0, z: 0 },
      target: { x: (i + 1) * 256, y: 0, z: 0 },
      kind: 'laser' as const,
      colour: [255, 0, 0] as [number, number, number],
    }));
    driver.push({ anims: [], bullets: [], particleSystems: [], beams }, 1, 0, new Vector3());
    const specs = setBeams.mock.calls[0]![1] as BeamSpec[];
    expect(specs).toHaveLength(BEAM_SEGMENTS + BEAM_LIGHTS);
    expect(specs.slice(0, BEAM_SEGMENTS).map((spec) => spec.from.x)).toEqual(
      Array.from({ length: BEAM_SEGMENTS }, (_, i) => i),
    );
    expect(specs.slice(-BEAM_LIGHTS).map((spec) => spec.from.x)).toEqual(
      Array.from({ length: BEAM_LIGHTS }, (_, i) => 5000 - BEAM_LIGHTS + i),
    );
  });
});
