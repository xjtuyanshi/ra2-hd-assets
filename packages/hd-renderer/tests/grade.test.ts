import { afterEach, describe, expect, it, vi } from 'vitest';
import { Color, type RenderPipeline } from 'three/webgpu';
import {
  adaptWhiteBalance,
  applyLookPreset,
  HdRenderer,
  LOOK_PRESETS,
  type HdSettings,
  type ToneMapper,
} from '../src/HdRenderer';
import { cinematicGradeRgb, hasCinematicGrade, neutralGrade, type CinematicGradeParams } from '../src/post';
import { Lighting } from '../src/lighting';
import { applyLookParams } from '../sandbox/look';
import { createScenario } from '../sandbox/scenario';

type Rgb = [number, number, number];
const luma = ([r, g, b]: readonly number[]): number => 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
const grey = (v: number): Rgb => [v, v, v];

describe('daylight white adaptation', () => {
  const noon = new Color(3.2, 3, 2.8);
  const flat = new Color(2.4, 1.5, 1.1);
  const original = new Color(Math.PI / noon.r, Math.PI / noon.g, Math.PI / noon.b);

  it('leaves disabled adaptation and full night exactly unchanged', () => {
    for (const [amount, night] of [
      [0, 0],
      [0, 0.5],
      [1, 1],
      [0.6, 1],
    ]) {
      const exposure = original.clone();
      expect(adaptWhiteBalance(exposure, noon, flat, amount!, night!)).toBe(exposure);
      expect(exposure.toArray()).toEqual(original.toArray());
    }
  });

  it('keeps flat-lit grey neutral at full adaptation under the live sun/sky model, with unchanged luminance', () => {
    const lighting = new Lighting(2, 2);
    lighting.update(12, 0);
    const reference = lighting.flatIrradianceColor(new Color());
    lighting.sunArc = true;
    for (const hour of [8, 10, 12, 16.5, 18])
      for (const overcast of [0, 0.8]) {
        lighting.update(hour, overcast);
        const current = lighting.flatIrradianceColor(new Color());
        const exposure = new Color(Math.PI / reference.r, Math.PI / reference.g, Math.PI / reference.b);
        const before = luma(current.clone().multiply(exposure).toArray());
        adaptWhiteBalance(exposure, reference, current, 1, 0);
        const lit = current.clone().multiply(exposure).toArray();
        expect(lit[0]).toBeCloseTo(lit[1]!, 12);
        expect(lit[1]).toBeCloseTo(lit[2]!, 12);
        expect(luma(lit)).toBeCloseTo(before, 12);
      }
  });

  it('interpolates channel ratios geometrically and fades the exponent with the night weight', () => {
    for (const night of [0, 0.4, 0.9]) {
      const exposure = original.clone().multiplyScalar(1.7);
      const before = luma(flat.clone().multiply(exposure).toArray());
      const ratio = exposure.r / exposure.b;
      adaptWhiteBalance(exposure, noon, flat, 0.6, night);
      expect(exposure.r / exposure.b / ratio).toBeCloseTo(
        (noon.r / flat.r / (noon.b / flat.b)) ** (0.6 * (1 - night)),
        12,
      );
      expect(luma(flat.clone().multiply(exposure).toArray())).toBeCloseTo(before, 12);
    }
  });
});

describe('cinematic display grade', () => {
  it('is exactly the identity with neutral parameters', () => {
    const params = neutralGrade();
    expect(hasCinematicGrade(params)).toBe(false);
    for (const r of [0, 0.0123, 0.18, 0.8, 1])
      for (const g of [0, 0.09, 0.5, 1])
        for (const b of [0, 0.31, 0.99, 1]) expect(cinematicGradeRgb([r, g, b], params)).toEqual([r, g, b]);
  });

  it('keeps grey achromatic through contrast, lift and saturation with balanced tints', () => {
    for (const gradeContrast of [-0.5, 0, 0.18, 1])
      for (const gradePivotLift of [-0.5, 0, 0.5])
        for (const gradeSaturation of [0, 1, 1.1, 2])
          for (const level of [0, 0.001, 0.18, 0.5, 0.9, 1]) {
            const [r, g, b] = cinematicGradeRgb(grey(level), {
              gradeBalance: [0.7, 0.7, 0.7],
              gradeContrast,
              gradePivotLift,
              gradeSaturation,
              gradeShadowTint: [0.5, 0.5, 0.5],
              gradeHighlightTint: [1.5, 1.5, 1.5],
            });
            expect(r).toBeCloseTo(g, 14);
            expect(g).toBeCloseTo(b, 14);
          }
  });

  it('flattens perceptual shadows/highlights with negative contrast and fixes black and white', () => {
    const params = { ...neutralGrade(), gradeContrast: -0.5 };
    const shadow = 0.2 ** 2.2;
    const highlight = 0.8 ** 2.2;
    expect(cinematicGradeRgb(grey(shadow), params)[0]).toBeGreaterThan(shadow);
    expect(cinematicGradeRgb(grey(highlight), params)[0]).toBeLessThan(highlight);
    for (const gradePivotLift of [-0.5, 0.5]) {
      expect(cinematicGradeRgb(grey(0), { ...params, gradePivotLift })).toEqual(grey(0));
      expect(cinematicGradeRgb(grey(1), { ...params, gradePivotLift })).toEqual(grey(1));
    }
    expect(cinematicGradeRgb(grey(0.18), { ...neutralGrade(), gradePivotLift: 0.1 })[0]).toBeGreaterThan(0.18);
    expect(cinematicGradeRgb(grey(0.18), { ...neutralGrade(), gradePivotLift: -0.1 })[0]).toBeLessThan(0.18);
  });

  it('preserves grey luminance under balance and colour luminance under each split tint before clipping', () => {
    const balanced = cinematicGradeRgb(grey(0.2), { ...neutralGrade(), gradeBalance: [0.97, 1, 1.04] });
    expect(luma(balanced)).toBeCloseTo(0.2, 12);
    const colour: Rgb = [0.05, 0.08, 0.12];
    for (const key of ['gradeShadowTint', 'gradeHighlightTint'] as const) {
      const toned = cinematicGradeRgb(colour, { ...neutralGrade(), [key]: [0.8, 1, 1.2] });
      expect(luma(toned)).toBeCloseTo(luma(colour), 12);
      expect(toned[0] / toned[2]).toBeLessThan(colour[0] / colour[2]);
    }
  });

  it('removes chroma at zero saturation', () => {
    const rgb: Rgb = [0.1, 0.3, 0.6];
    const output = cinematicGradeRgb(rgb, { ...neutralGrade(), gradeSaturation: 0 });
    for (const channel of output) expect(channel).toBeCloseTo(luma(rgb), 12);
  });

  const extremes: CinematicGradeParams[] = [
    LOOK_PRESETS.cinematic.settings,
    { ...neutralGrade(), gradeContrast: -0.5, gradePivotLift: -0.5, gradeSaturation: 2 },
    { ...neutralGrade(), gradeContrast: 1, gradePivotLift: 0.5, gradeSaturation: 2 },
    { ...neutralGrade(), gradeBalance: [0, 0, 0], gradeShadowTint: [0, 0, 0], gradeHighlightTint: [0, 0, 0] },
    {
      ...neutralGrade(),
      gradeBalance: [-1, 0, 2],
      gradeShadowTint: [2, 0, 0],
      gradeHighlightTint: [0, 2, 0],
      gradeSaturation: 20,
    },
  ];
  it.each(extremes)('stays finite and in gamut for boundary colours with %j', (params) => {
    for (const r of [0, 1e-12, 0.01, 0.2, 0.5, 0.9, 1])
      for (const g of [0, 1e-12, 0.01, 0.2, 0.5, 0.9, 1])
        for (const b of [0, 1e-12, 0.01, 0.2, 0.5, 0.9, 1]) {
          for (const v of cinematicGradeRgb([r, g, b], params)) {
            expect(Number.isFinite(v)).toBe(true);
            expect(v).toBeGreaterThanOrEqual(0);
            expect(v).toBeLessThanOrEqual(1);
          }
        }
  });
});

describe('cinematic preset and sandbox parameters', () => {
  it('inherits all of golden except the explicit lighting depth, white balance and display-grade overrides', () => {
    const cinematic = LOOK_PRESETS.cinematic;
    for (const [key, value] of Object.entries(LOOK_PRESETS.golden.settings)) {
      if (
        [
          'whiteAdapt',
          'mapTintAdapt',
          'sunGain',
          'specularSize',
          'aoPower',
          'contactShade',
          'shadowLength',
          'shadowDarkness',
          'clarity',
        ].includes(key) ||
        key in neutralGrade()
      )
        continue;
      expect(cinematic.settings[key as keyof HdSettings]).toEqual(value);
    }
    expect(cinematic.hour).toBe(16.5);
    // Calibrated against the approved targets (see the preset's comment).
    expect(cinematic.settings).toMatchObject({
      // L5G: 15 % of the afternoon sun's colour stays on flat ground (battle grass warmth from the light).
      whiteAdapt: 0.85,
      mapTintAdapt: 0.3,
      // Light sources keep the engine's full share, like golden: a reduced share left everything near a lamp post
      // darker than the game draws it (frozen XMP29U2 pair 7.6 cells from a post: ground 0.90, a building 0.74).
      mapSourcesByDay: 1,
      gradeBalance: [0.955, 1, 1.085],
      gradeContrast: 0.14,
      gradePivotLift: 0.045,
      gradeSaturation: 1.08,
      gradeShadowTint: [0.8, 1, 1.2],
      gradeHighlightTint: [1.15, 1, 0.85],
      sunGain: 1.25,
      specularSize: 1.6,
      aoPower: 1.5,
      contactShade: 1.5,
      shadowLength: 1.4,
      shadowDarkness: 1.15,
      clarity: 0.55,
    });
    // The faithful default and golden leave the clarity pass out entirely.
    expect(LOOK_PRESETS.faithful.settings.clarity).toBe(0);
    expect(LOOK_PRESETS.golden.settings.clarity).toBe(0);
  });

  it.each(['faithful', 'golden'] as const)('restores all neutral grade settings when switching to %s', (preset) => {
    const settings = {} as HdSettings;
    applyLookPreset(settings, 'cinematic');
    settings.gradePivotLift = 0.1;
    expect(hasCinematicGrade(settings)).toBe(true);
    applyLookPreset(settings, preset);
    expect(settings).toMatchObject({ whiteAdapt: 0, mapTintAdapt: 0, ...neutralGrade() });
    expect(hasCinematicGrade(settings)).toBe(false);
  });

  it('does not let calibration edits mutate presets or another renderer', () => {
    const a = {} as HdSettings;
    const b = {} as HdSettings;
    applyLookPreset(a, 'cinematic');
    applyLookPreset(b, 'cinematic');
    for (const key of ['gradeBalance', 'gradeShadowTint', 'gradeHighlightTint'] as const) {
      const original = [...LOOK_PRESETS.cinematic.settings[key]];
      a[key][0] = 0.5;
      expect(b[key]).toEqual(original);
      expect(LOOK_PRESETS.cinematic.settings[key]).toEqual(original);
    }
  });

  it('applies scalar/RGB overrides after cinematic and respects the explicit hour', () => {
    const hd = { settings: {} as HdSettings } as HdRenderer;
    const state = createScenario(2, 2);
    state.environment.timeOfDay = 9;
    applyLookParams(
      hd,
      new URLSearchParams(
        'look=cinematic&time=9&wbadapt=0.8&gbal=0.9,1,1.1&gcon=-0.2&glift=0.08&gsat=1.2&gshadow=0.8,1,1.2&ghigh=1.1,1,0.9',
      ),
      state,
    );
    expect(state.environment.timeOfDay).toBe(9);
    expect(hd.settings).toMatchObject({
      whiteAdapt: 0.8,
      gradeBalance: [0.9, 1, 1.1],
      gradeContrast: -0.2,
      gradePivotLift: 0.08,
      gradeSaturation: 1.2,
      gradeShadowTint: [0.8, 1, 1.2],
      gradeHighlightTint: [1.1, 1, 0.9],
    });
    applyLookParams(hd, new URLSearchParams('look=cinematic'), state);
    expect(state.environment.timeOfDay).toBe(16.5);
  });

  it('ignores malformed RGB/non-finite overrides and bounds white adaptation and contrast', () => {
    const hd = { settings: {} as HdSettings } as HdRenderer;
    applyLookParams(
      hd,
      new URLSearchParams(
        'look=cinematic&wbadapt=2&gcon=-2&glift=NaN&gsat=Infinity&gbal=1,2&gshadow=1,,1&ghigh=1,1,NaN',
      ),
      createScenario(2, 2),
    );
    expect(hd.settings).toMatchObject({ ...LOOK_PRESETS.cinematic.settings, whiteAdapt: 1, gradeContrast: -0.5 });
  });
});

/** Headless graph inspection only: no renderer initialization, shader compilation or GPU draws. */
function headlessRenderer(): HdRenderer {
  vi.stubGlobal('window', { devicePixelRatio: 1 });
  const canvas = {
    width: 1,
    height: 1,
    style: {},
    addEventListener() {},
    removeEventListener() {},
  } as unknown as HTMLCanvasElement;
  return new HdRenderer(canvas, createScenario(2, 2));
}

type GraphNode = { getChildren(): Iterable<GraphNode> };
type PipelineState = {
  pipeline: RenderPipeline;
  gradeUniforms: { [K in keyof CinematicGradeParams]: GraphNode & { value: unknown } };
  pipelineNodes: { dispose(): void }[];
};
function dependencies(root: GraphNode): Set<GraphNode> {
  const found = new Set<GraphNode>();
  const visit = (node: GraphNode): void => {
    if (found.has(node)) return;
    found.add(node);
    for (const child of node.getChildren()) visit(child);
  };
  visit(root);
  return found;
}

afterEach(() => vi.unstubAllGlobals());

describe('cinematic pipeline lifecycle', () => {
  it.each(['faithful', 'neutral', 'agx', 'aces'] satisfies ToneMapper[])(
    'omits neutral grading and reuses uniform edits after %s tone mapping',
    (toneMapper) => {
      const hd = headlessRenderer();
      const internal = hd as unknown as PipelineState;
      hd.settings.toneMapper = toneMapper;
      hd.settings.antialias = 'none';
      hd.settings.sharpness = -1;
      hd.applySettings();
      const original = internal.pipeline;
      expect(hd.settings).toMatchObject({ ...neutralGrade(), whiteAdapt: 0 });
      expect(dependencies(original.outputNode).has(internal.gradeUniforms.gradeContrast)).toBe(false);
      applyLookPreset(hd.settings, 'cinematic');
      hd.applySettings();
      const graded = internal.pipeline;
      expect(graded).not.toBe(original);
      for (const uniform of Object.values(internal.gradeUniforms))
        expect(dependencies(graded.outputNode).has(uniform)).toBe(true);
      hd.settings.gradeContrast = 0.3;
      hd.settings.gradeBalance[2] = 1.08;
      hd.applySettings();
      expect(internal.pipeline).toBe(graded);
      expect(internal.gradeUniforms.gradeContrast.value).toBe(0.3);
      for (const key of [
        'sunGain',
        'specularSize',
        'aoPower',
        'contactShade',
        'shadowLength',
        'shadowDarkness',
      ] as const) {
        hd.settings[key] = 1.7;
        hd.applySettings();
        expect(internal.pipeline).toBe(graded);
      }
      applyLookPreset(hd.settings, 'golden');
      hd.applySettings();
      expect(internal.pipeline).not.toBe(graded);
      expect(dependencies(internal.pipeline.outputNode).has(internal.gradeUniforms.gradeContrast)).toBe(false);
      // Dispose graph targets without initializing a backend solely for this test.
      internal.pipeline.dispose();
      internal.pipelineNodes.forEach((node) => node.dispose());
      hd.nodes.dispose();
    },
  );

  it.each(['overbright', 'voxel-xy', 'voxel-z'] as const)(
    'keeps %s diagnostics free of display grading',
    (debugView) => {
      const hd = headlessRenderer();
      const internal = hd as unknown as PipelineState;
      hd.settings.debugView = debugView;
      applyLookPreset(hd.settings, 'cinematic');
      hd.applySettings();
      for (const uniform of Object.values(internal.gradeUniforms))
        expect(dependencies(internal.pipeline.outputNode).has(uniform)).toBe(false);
      internal.pipeline.dispose();
      internal.pipelineNodes.forEach((node) => node.dispose());
      hd.nodes.dispose();
    },
  );
});

describe('map tint neutralisation', () => {
  it('divides the map tint out with luminance kept, scaled by the amount', async () => {
    const { neutralizeMapTint } = await import('../src/HdRenderer');
    const { Color } = await import('three/webgpu');
    const tint = { red: 1, green: 0.8, blue: 0.68 };
    const full = neutralizeMapTint(new Color(1, 1, 1), tint, 1);
    // A grey under the tint comes out grey.
    const out = [tint.red * full.r, tint.green * full.g, tint.blue * full.b];
    expect(out[0]).toBeCloseTo(out[1]!, 6);
    expect(out[1]).toBeCloseTo(out[2]!, 6);
    const level = 0.2126 * tint.red + 0.7152 * tint.green + 0.0722 * tint.blue;
    expect(0.2126 * out[0]! + 0.7152 * out[1]! + 0.0722 * out[2]!).toBeCloseTo(level, 6);
    expect(neutralizeMapTint(new Color(1, 2, 3), tint, 0).toArray()).toEqual([1, 2, 3]);
    const half = neutralizeMapTint(new Color(1, 1, 1), tint, 0.5);
    expect(half.b / half.r).toBeCloseTo(Math.sqrt(full.b / full.r), 6);
  });
});

describe('HD source light presets', () => {
  it('adds nothing by default or in faithful and enables both enhanced presets', () => {
    const hd = headlessRenderer();
    try {
      expect(hd.settings.sourceLights).toBe(0);
      expect(LOOK_PRESETS.faithful.settings.sourceLights).toBe(0);
      for (const preset of ['golden', 'cinematic'] as const) {
        expect(LOOK_PRESETS[preset].settings.sourceLights).toBe(1);
        applyLookPreset(hd.settings, preset);
        expect(hd.settings.sourceLights).toBe(1);
      }
      applyLookPreset(hd.settings, 'faithful');
      expect(hd.settings.sourceLights).toBe(0);
    } finally {
      // No backend was initialized; release only the nodes allocated by construction.
      hd.nodes.dispose();
      vi.unstubAllGlobals();
    }
  });
});
