import { describe, expect, it } from 'vitest';
import { vec3, float } from 'three/tsl';
import {
  createWaterTuning,
  parseWaterStyle,
  WATER_STYLES,
  WATER_TUNING,
  withWaterTuning,
  writeWaterTuning,
  tonedReflection,
} from '../src/ra2/waterLook';
import { paintedWaterMask } from '../src/ra2/paintedWater';
import type { ShaderNode } from '../src/tsl';

function inputs(root: ShaderNode): Set<ShaderNode> {
  const seen = new Set<ShaderNode>();
  const visit = (node: ShaderNode) => {
    if (seen.has(node)) return;
    seen.add(node);
    for (const child of node.getChildren()) visit(child);
  };
  visit(root);
  return seen;
}
describe('live water tuning', () => {
  it.each(WATER_STYLES)('parses %s', (style) => expect(parseWaterStyle(style)).toBe(style));
  it.each([null, '', 'Enhanced', 'unknown'])('retains classic fallback for %s', (value) =>
    expect(parseWaterStyle(value)).toBe('classic'),
  );
  it('retains every legacy enhanced shader and display coefficient', () => {
    const expected = {
      saturation: 1.8,
      level: 0.67,
      artHue: 0.15,
      artToneForce: 0,
      artToneReflection: 0.12,
      reflectMax: 0.26,
      sheenGain: 0.9,
      sheenTrains: 5,
      crest: 1,
      glitterGain: 6,
      gust: 1,
      rippleSlope: 1,
      rippleDrift: 1,
      windOverride: -1,
      shallowMix: 0.9,
      shallowSandOnly: 0,
      foam: 1,
      colourBlend: 0,
      swellAmplitude: 0,
      swellPeriod: 10,
      newShore: 0,
    };
    expect(WATER_TUNING.enhanced).toEqual(expected);
    expect(WATER_TUNING.classic).toEqual(expected);
  });
  it('changes values in place and keeps per-terrain graphs isolated even after a construction error', () => {
    const a = createWaterTuning('enhanced'),
      b = createWaterTuning('muted');
    const nodes = { ...a };
    const reflection = () => tonedReflection(vec3(1), vec3(1), vec3(0.02), float(1), float(3));
    const graphA = withWaterTuning(a, reflection);
    const graphB = withWaterTuning(b, reflection);
    expect(inputs(graphA).has(a.artToneReflection)).toBe(true);
    expect(inputs(graphA).has(b.artToneReflection)).toBe(false);
    expect(inputs(graphB).has(b.artToneReflection)).toBe(true);
    expect(() =>
      withWaterTuning(b, () => {
        throw Error('construction');
      }),
    ).toThrow('construction');
    for (const style of WATER_STYLES) {
      writeWaterTuning(a, style);
      for (const key of Object.keys(WATER_TUNING.enhanced) as (keyof typeof WATER_TUNING.enhanced)[]) {
        expect(a[key]).toBe(nodes[key]);
        expect(a[key].value).toBe(WATER_TUNING[style][key]);
      }
    }
    expect(b.sheenGain.value).toBe(0.35);
  });
  it('forces painted daytime water for faithful and limits its ambient sources', () => {
    const f = WATER_TUNING.faithful;
    expect(f.artToneForce).toBe(1);
    expect(f.artToneReflection).toBe(0.06);
    for (const key of ['sheenGain', 'crest', 'glitterGain', 'gust', 'shallowMix', 'foam'] as const)
      expect(f[key]).toBe(0);
    expect(f.swellPeriod).toBeGreaterThanOrEqual(8);
  });
});

describe('painted small-water protection', () => {
  it('protects an enclosed pool while leaving the boundary-connected sea and dry land alone', () => {
    const width = 80,
      height = 80,
      data = new Uint8Array(width * height);
    for (let y = 0; y < height; y++) for (let x = 0; x < 20; x++) data[y * width + x] = 255;
    for (let y = 32; y < 48; y++) for (let x = 40; x < 56; x++) data[y * width + x] = 255;
    const result = paintedWaterMask({ data, width, height }, 1);
    expect(result.data[10 * result.width + 12]).toBe(255);
    expect(result.data[10 * result.width + 1]).toBe(0);
    expect(result.data[10 * result.width + 7]).toBe(0);
  });
  it('does not classify a large enclosed lake as a pool', () => {
    const width = 200,
      height = 200,
      data = new Uint8Array(width * height);
    for (let y = 10; y < 190; y++) for (let x = 10; x < 190; x++) data[y * width + x] = 255;
    expect(paintedWaterMask({ data, width, height }, 1).data.some(Boolean)).toBe(false);
  });
});
