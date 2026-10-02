import { describe, expect, it, vi } from 'vitest';
import { float, uniform, vec3, vec4 } from 'three/tsl';
import { Vector3 } from 'three/webgpu';
import { AtmosphereNodes } from '../src/atmosphere';
import {
  BEACH_PROFILE,
  BED_ABSORPTION,
  BED_SHALLOW_DESAT,
  beachDepth,
  bedWaterLook,
  WATER_SHEEN,
} from '../src/ra2/waterLook';
import type { ShaderNode } from '../src/tsl';
import { createWaterUniforms } from '../src/waterShading';

const transmission = (shore: number) => BED_ABSORPTION.map((absorption) => Math.exp(-absorption * beachDepth(shore)));

function dependencies(root: ShaderNode): Set<ShaderNode> {
  const seen = new Set<ShaderNode>();
  const visit = (node: ShaderNode) => {
    if (seen.has(node)) return;
    seen.add(node);
    for (const child of node.getChildren()) visit(child);
  };
  visit(root);
  return seen;
}

describe('painted-bed beach profile', () => {
  it('has no optical depth or absorption at the waterline or on exposed land', () => {
    for (const shore of [-3, -0.3, -0.13, -0.001, 0]) {
      expect(beachDepth(shore)).toBe(0);
      expect(transmission(shore)).toEqual([1, 1, 1]);
    }
    expect(transmission(1e-8).every((channel) => channel > 0.999999)).toBe(true);
  });

  it('deepens monotonically without a slope discontinuity at the shallow shelf', () => {
    const step = 1e-5;
    const edge = BEACH_PROFILE.shelf;
    const before = (beachDepth(edge) - beachDepth(edge - step)) / step;
    const after = (beachDepth(edge + step) - beachDepth(edge)) / step;
    expect(before).toBeCloseTo(after, 3);
    for (let i = 1; i <= 100; i++) expect(beachDepth(i / 100)).toBeGreaterThan(beachDepth((i - 1) / 100));
    // The offshore drop, not an abrupt colour ramp, removes the bed.
    expect(beachDepth(0.8) - beachDepth(0.7)).toBeGreaterThan(5 * (beachDepth(0.2) - beachDepth(0.1)));
  });

  it('keeps the sand visible in the first 0.15 cells while absorbing red fastest', () => {
    // Tuned against the approved river target: the turquoise column takes over within about a quarter cell, but the
    // sand still shows through clearly at 0.15 cells (more than half of green and blue, a fifth of red).
    const [r, g, b] = transmission(0.15);
    expect(r).toBeGreaterThan(0.18);
    expect(r).toBeLessThan(g!);
    expect(g).toBeGreaterThan(0.5);
    expect(g).toBeLessThan(b!);
    expect(b).toBeGreaterThan(0.6);
  });

  it('keeps sand visible through the luminous shallows out to about 0.4 cells', () => {
    // L5 (owner feedback: wider luminous turquoise shallows): the bright bed still shows through at 0.4 cells, red is
    // mostly absorbed there (the turquoise comes from the sand seen through clear water).
    const [r, g, b] = transmission(0.4);
    expect(r).toBeLessThan(0.15);
    expect(g).toBeGreaterThan(0.3);
    expect(b).toBeGreaterThan(0.4);
  });

  it('keeps the reflective sheen waves across the view and the warm glitter near the beaches', () => {
    for (const [angle, wavelength, slope, speed] of WATER_SHEEN.trains) {
      // Crests run across the screen (the target's horizontal wavy crest lines), not a cross-hatch.
      expect(Math.abs(angle)).toBeLessThanOrEqual(0.6);
      expect(wavelength).toBeGreaterThan(0.2);
      expect(wavelength).toBeLessThan(0.8);
      expect(slope).toBeGreaterThan(0);
      expect(slope).toBeLessThan(0.15);
      expect(speed).toBeGreaterThan(0);
    }
    expect(WATER_SHEEN.glintNear).toBeLessThan(WATER_SHEEN.glintFar);
    expect(WATER_SHEEN.glintOffshore).toBeLessThan(0.5);
    expect(WATER_SHEEN.glintBoostFull).toBeLessThan(WATER_SHEEN.glintFar);
    expect(WATER_SHEEN.enhanced.openNear).toBeLessThan(WATER_SHEEN.enhanced.openFar);
  });

  it('removes the bed by 0.8-1 cells without negative or non-finite transmission offshore', () => {
    for (const shore of [0.8, 1, 3, 9]) {
      for (const channel of transmission(shore)) {
        expect(Number.isFinite(channel)).toBe(true);
        expect(channel).toBeGreaterThanOrEqual(0);
        expect(channel).toBeLessThan(0.01);
      }
    }
  });
});

describe('painted-bed shallow chroma (L5F art review)', () => {
  it('desaturates only the near-shore band, keeping luminance within 1 %', () => {
    expect(BED_SHALLOW_DESAT.amount).toBeGreaterThanOrEqual(0.15);
    expect(BED_SHALLOW_DESAT.amount).toBeLessThanOrEqual(0.35);
    expect(BED_SHALLOW_DESAT.near).toBeLessThan(BED_SHALLOW_DESAT.far);
    // Open water (beyond about 1.5 cells) keeps the approved sheen colour untouched.
    expect(BED_SHALLOW_DESAT.far).toBeLessThanOrEqual(1.8);
    const [r, g, b] = BED_SHALLOW_DESAT.tint;
    expect(Math.abs(0.2126 * r + 0.7152 * g + 0.0722 * b - 1)).toBeLessThan(0.01);
    expect(g).toBeGreaterThan(b);
  });
});

describe('painted-bed shader graph', () => {
  it('keeps bed colour out of display compensation while retaining weather and mirrored light inputs', () => {
    const nodes = new AtmosphereNodes();
    const water = createWaterUniforms();
    const art = uniform(new Vector3(0.7, 0.5, 0.3));
    const bed = uniform(new Vector3(0.6, 0.4, 0.2));
    const bedAt = vi.fn((_offset: ShaderNode) => bed);
    const columnForDisplay = vi.fn((column: ShaderNode) => column.mul(0.67));
    const look = bedWaterLook(
      {
        position: vec3(2, 0, 3),
        shore: float(0.15),
        waterness: float(1),
        art,
        uniforms: water,
        bedAt,
        columnForDisplay,
        reflectionLevel: float(0.67),
      },
      nodes,
    );
    expect(bedAt).toHaveBeenCalledTimes(1);
    expect(columnForDisplay).toHaveBeenCalledTimes(1);
    const compensated = dependencies(columnForDisplay.mock.calls[0]![0]);
    expect(compensated.has(art)).toBe(false);
    expect(compensated.has(bed)).toBe(false);
    expect(compensated.has(nodes.night)).toBe(true);
    expect(dependencies(look.body).has(bed)).toBe(true);
    expect(dependencies(look.land).has(art)).toBe(true);
    expect(dependencies(look.normal).has(water.rain)).toBe(true);
    expect(dependencies(look.emission).has(nodes.lightFieldTexture)).toBe(true);
    nodes.dispose();
  });

  it('keeps detail colour out of display compensation and applies detail roughness to the water graph', () => {
    const nodes = new AtmosphereNodes();
    const water = createWaterUniforms();
    const detail = vec4(uniform(new Vector3(0.04, 0.2, 0.3)), uniform(0.75));
    const columnForDisplay = vi.fn((column: ShaderNode) => column.mul(0.67));
    try {
      const look = bedWaterLook(
        {
          position: vec3(2, 0, 3),
          shore: float(0.15),
          waterness: float(1),
          art: vec3(0.5),
          uniforms: water,
          bedAt: () => vec3(0.5),
          columnForDisplay,
          reflectionLevel: float(0.67),
          detail,
        },
        nodes,
      );
      expect(columnForDisplay).toHaveBeenCalledTimes(1);
      const compensated = dependencies(columnForDisplay.mock.calls[0]![0]);
      expect(compensated.has(detail)).toBe(false);
      expect(compensated.has(nodes.night)).toBe(false); // Night dims the mixed display column afterwards.
      expect(dependencies(look.body).has(detail)).toBe(true);
      expect(dependencies(look.body).has(nodes.night)).toBe(true);
      expect(dependencies(look.normal).has(detail)).toBe(true);
      expect(dependencies(look.normal).has(water.rain)).toBe(true);
      expect(dependencies(look.emission).has(detail)).toBe(true);
      expect(dependencies(look.land).has(detail)).toBe(false);
      // Whitecaps on the open water follow the detail layer's roughness (A); the shore foam itself does not.
      expect(dependencies(look.foam).has(detail)).toBe(true);
    } finally {
      nodes.dispose();
    }
  });
});
