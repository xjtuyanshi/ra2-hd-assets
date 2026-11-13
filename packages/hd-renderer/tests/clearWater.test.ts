import { describe, expect, it } from 'vitest';
import { Color } from 'three/webgpu';
import { LOOK_PRESETS } from '../src/HdRenderer';
import { cinematicGradeRgb } from '../src/post';
import {
  CLEAR_GLINT_LIGHT,
  CLEAR_LAYER_TURN,
  CLEAR_WATER,
  CLEAR_LAYERS,
  CLEAR_SURFACE,
  clearDepth,
  clearMetres,
  clearPalette,
  clearShoreSandiness,
  clearShoreTone,
  clearTransmission,
} from '../src/ra2/clearWater';
import { buildShoreField, SHORE_MAX, SHORE_MIN, type ShoreLandValue } from '../src/ra2/shoreField';

describe('clear water optical policy', () => {
  it('deepens monotonically within the shallow band and drops steeply beside rocks', () => {
    const cells = CLEAR_WATER.depthCells;
    expect(cells).toBeLessThanOrEqual(2.5);
    expect(clearDepth(-1)).toBe(0);
    expect(clearDepth(0)).toBe(0);
    expect(clearDepth(cells / 2)).toBeCloseTo(0.5);
    expect(clearDepth(cells)).toBe(1);
    expect(clearDepth(10)).toBe(1);
    expect(clearDepth(0, 1)).toBeCloseTo(0.9);
    let previous = 0;
    for (let shore = 0; shore <= 6; shore += 0.1) {
      expect(clearDepth(shore)).toBeGreaterThanOrEqual(previous);
      previous = clearDepth(shore);
    }
  });
  it('keeps the bed at zero depth, absorbs red fastest and lets the open-water bed show only faintly', () => {
    expect(clearTransmission(0)).toEqual([1, 1, 1]);
    for (const metres of [0.5, 2, 6]) {
      const [r, g, b] = clearTransmission(metres) as [number, number, number];
      expect(r).toBeLessThan(g);
      expect(g).toBeLessThan(b);
      expect(b).toBeLessThan(1);
    }
    // Open shelf water: the bed's red is gone and its green and blue are well below half (dapple, not a glow).
    const [r, g, b] = clearTransmission(clearMetres(4)) as [number, number, number];
    expect(r).toBeLessThan(0.01);
    expect(Math.max(g, b)).toBeLessThan(0.45);
  });
  it('slopes the bed gently: the bed shows through most of the shallows, open teal by about one and a half cells', () => {
    let previous = -1;
    for (let shore = -1; shore <= 9; shore += 0.1) {
      expect(clearMetres(shore)).toBeGreaterThanOrEqual(previous);
      previous = clearMetres(shore);
    }
    expect(clearMetres(0)).toBe(0);
    expect(Math.exp(-CLEAR_WATER.clarity * clearMetres(0.15))).toBeGreaterThan(0.4);
    expect(Math.exp(-CLEAR_WATER.clarity * clearMetres(0.5))).toBeGreaterThan(0.2);
    // The owner's reviewer saw no sand or ripples through the shallows at 1:1: the bed stays visible to about a cell.
    expect(Math.exp(-CLEAR_WATER.clarity * clearMetres(0.8))).toBeGreaterThan(0.2);
    expect(Math.exp(-CLEAR_WATER.clarity * clearMetres(1.6))).toBeLessThan(0.05);
    expect(clearMetres(1.6)).toBeGreaterThanOrEqual(CLEAR_WATER.aquaEnd);
    expect(clearMetres(9)).toBeLessThanOrEqual(CLEAR_WATER.maxMetres);
    // Quays and cliff feet are deep up to the wall.
    expect(clearMetres(0, 1)).toBeGreaterThanOrEqual(CLEAR_WATER.aquaEnd);
    expect(clearMetres(0, 0, 1)).toBeGreaterThanOrEqual(CLEAR_WATER.aquaEnd);
  });
  it('lights the relief and glitter from ahead of the fixed camera, near the mirror direction', () => {
    const [x, y, z] = CLEAR_GLINT_LIGHT;
    expect(Math.hypot(x, y, z)).toBeCloseTo(1, 6);
    // Mirror of the view over flat water (IsoCamera: 30 degree pitch, looking towards -x -z).
    const c = Math.cos(Math.PI / 6) * Math.SQRT1_2;
    const mirror = [-c, 0.5, -c];
    const cos = mirror[0]! * x + mirror[1]! * y + mirror[2]! * z;
    // About 21 degrees off the mirror: glints need a wave facet tilted about 10 degrees, as in prototype A.
    expect(cos).toBeGreaterThan(0.92);
    expect(cos).toBeLessThan(0.95);
  });
  it('keeps every theatre teal-blue (not cobalt or grey) and its open water darker than the shallows', () => {
    const luma = (c: Color) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
    for (const theater of ['temperate', 'snow', 'desert', 'urban', 'newurban']) {
      const palette = clearPalette(theater);
      const deep = new Color(palette.deep),
        shallow = new Color(palette.shallow);
      expect(luma(deep)).toBeLessThan(luma(shallow) * 0.5);
      for (const colour of [deep, shallow]) {
        const srgb = colour.clone().convertLinearToSRGB();
        // Teal-blue: blue may lead green a little; cobalt has a strongly dominant blue channel, grey has no chroma.
        expect(srgb.b / srgb.g).toBeLessThan(1.35);
        expect(srgb.r).toBeLessThan(srgb.g);
        expect(1 - srgb.r / Math.max(srgb.g, srgb.b)).toBeGreaterThan(0.3);
      }
      // Graded under neutral light, the deep colour stays teal-blue (HSV hue 180-215 degrees) rather than cobalt.
      for (const exposure of [0.3, 1, 1.5]) {
        const graded = new Color(
          ...cinematicGradeRgb(
            [deep.r * exposure, deep.g * exposure, deep.b * exposure],
            LOOK_PRESETS.cinematic.settings,
          ),
        ).convertLinearToSRGB();
        const hsl = { h: 0, s: 0, l: 0 };
        graded.getHSL(hsl);
        expect(hsl.h * 360).toBeGreaterThan(180);
        expect(hsl.h * 360).toBeLessThan(215);
      }
    }
    expect(clearPalette('SNOW')).toEqual(clearPalette('snow'));
    expect(clearPalette('unknown')).toEqual(clearPalette('temperate'));
    expect(clearPalette('snow')).not.toEqual(clearPalette('desert'));
    expect(clearPalette('urban')).toEqual(clearPalette('newurban'));
  });
  it('keeps A at its approved physical scale, scroll directions and comfort clock', () => {
    // Slowed to prototype A's 1-second change per unit of local contrast (A 3.67 / 3.55; 0.8 moved about 1.45x A).
    expect(CLEAR_SURFACE.timeScale).toBe(0.5);
    // The wave field is stretched along the view's ground direction so its crests read round on screen; the gain
    // makes up for the slopes that stretch flattens (day local std back in 3-5).
    expect(CLEAR_SURFACE.viewStretch).toBe(1.5);
    expect(CLEAR_SURFACE.normalGain).toBe(1.7);
    expect(CLEAR_SURFACE.tileMetres / CLEAR_SURFACE.metresPerCell).toBe(3.25);
    expect(CLEAR_SURFACE.tileMetres / 9 / CLEAR_SURFACE.metresPerCell).toBeCloseTo(0.3611, 4);
    expect(CLEAR_LAYERS).toEqual([
      [103, 103, 1 / 17, 1 / 29],
      [107, 107, 1 / 19, -1 / 31],
      [8907, 9803, 1 / 101, 1 / 97],
      [1091, 1027, -1 / 109, 1 / 113],
    ]);
    // The second fine layer crosses the first; the large layers keep WaterMesh's frame except for a small turn.
    expect(CLEAR_LAYER_TURN[0]).toBe(0);
    expect(Math.abs(CLEAR_LAYER_TURN[1])).toBeGreaterThanOrEqual(45);
    // Small, sharp glints a little larger than A's (RA3 references), and small whitecaps rather than foam sheets.
    expect(CLEAR_WATER.shininess).toBeGreaterThanOrEqual(500);
    expect(CLEAR_WATER.shininess).toBeLessThanOrEqual(900);
    expect(CLEAR_WATER.sparkle).toBeLessThanOrEqual(8);
    expect(CLEAR_WATER.whitecap).toBeLessThanOrEqual(0.35);
  });
  it('keeps the sky reflection and glare low (owner: the reflection read too strong)', () => {
    expect(CLEAR_WATER.reflectionMax).toBeLessThanOrEqual(0.15);
    expect(CLEAR_WATER.reflection + CLEAR_WATER.fresnelGain * 0.1).toBeLessThan(0.1);
    expect(CLEAR_WATER.sparkle).toBeLessThanOrEqual(4);
  });
});

describe('clear water shore class', () => {
  it('tells natural ground from masonry by hue, as measured in the sandbox', () => {
    // Linear colours sampled from the enhanced sandbox stills (g2 beach and islet, XGoldSt plaza and seawall).
    expect(clearShoreSandiness(0.305, 0.211, 0.086)).toBeGreaterThan(0.95); // sand
    expect(clearShoreSandiness(0.088, 0.066, 0.05)).toBeGreaterThan(0.95); // dark islet rock
    expect(clearShoreSandiness(0.106, 0.134, 0.08)).toBeGreaterThan(0.95); // olive coast grass
    expect(clearShoreSandiness(0.316, 0.325, 0.172)).toBeLessThan(0.05); // seawall
    expect(clearShoreSandiness(0.597, 0.566, 0.27)).toBeLessThan(0.2); // plaza
    expect(clearShoreSandiness(0.2, 0.2, 0.2)).toBe(0); // grey masonry
  });
  it('encodes the shore tone around the theatre sand', () => {
    const sand = new Color(clearPalette('temperate').bed);
    const mid = clearShoreTone(sand.r, sand.g, sand.b);
    expect(clearShoreTone(-1, -1, -1)).toBeCloseTo(mid, 6);
    expect(clearShoreTone(0.02, 0.02, 0.02)).toBeLessThan(mid);
    expect(clearShoreTone(1, 1, 1)).toBe(1);
  });
  it('spreads the land class onto the water smoothly, with the shore mass of islets below a coast', () => {
    // 160 x 120 mask, scale 1, step 1: water everywhere except a coast along the bottom (left half masonry, right half
    // sand) and a 30 x 14 pixel islet (about 0.7 cells across) near the top.
    const w = 160,
      h = 120;
    const mask = new Uint8Array(w * h).fill(255);
    for (let y = 90; y < h; y++) for (let x = 0; x < w; x++) mask[y * w + x] = 0;
    for (let y = 15; y < 29; y++) for (let x = 90; x < 120; x++) mask[y * w + x] = 0;
    const land: ShoreLandValue = {
      defaults: [1, 0.5],
      read: (x0) => [x0 < 80 ? 0 : 1, 0.5],
    };
    const { data, values } = buildShoreField(mask, w, h, 1, 1, false, undefined, land);
    expect(values).not.toBeNull();
    const [sandy, , mass] = values!;
    const at = (x: number, y: number) => y * w + x;
    const cells = (x: number, y: number) => (data[at(x, y)]! / 255) * (SHORE_MAX - SHORE_MIN) + SHORE_MIN;
    // Water a third of a cell off each half of the coast takes that half's class.
    expect(cells(20, 80)).toBeGreaterThan(0);
    expect(sandy![at(20, 80)]! / 255).toBeLessThan(0.1);
    expect(sandy![at(140, 80)]! / 255).toBeGreaterThan(0.9);
    // Across the boundary the class changes gradually, without a step between neighbouring texels.
    for (let x = 1; x < w; x++) expect(Math.abs(sandy![at(x, 80)]! - sandy![at(x - 1, 80)]!)).toBeLessThan(20);
    // The islet's water has less shore mass than the coast's, and both have some.
    const islet = mass![at(105, 32)]!;
    const coast = mass![at(140, 85)]!;
    expect(islet).toBeGreaterThan(0);
    expect(islet).toBeLessThan(coast * 0.6);
  });
});
