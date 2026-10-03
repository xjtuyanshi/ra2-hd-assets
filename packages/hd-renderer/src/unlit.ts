import { ACESFilmicToneMapping, AgXToneMapping, NeutralToneMapping, Vector3 } from 'three/webgpu';
import { float, length, mix, screenUV, smoothstep, toneMapping, uniform, vec4 } from 'three/tsl';
import type { AtmosphereNodes } from './atmosphere';
import { cinematicGrade, faithfulToneMap, hasCinematicGrade, type CinematicGradeParams } from './post';
import type { ShaderNode } from './tsl';

/** Authored self-lit art follows the selected clear-day display, independently of scene/map illumination. */
export interface UnlitDisplaySettings extends CinematicGradeParams {
  toneMapper: 'faithful' | 'agx' | 'neutral' | 'aces';
  exposure: number;
  vignette: number;
}

export class UnlitDisplayUniforms {
  readonly exposure = uniform(1);
  readonly vignette = uniform(0);
  readonly toneMapper = uniform(0);
  readonly graded = uniform(0);
  readonly gradeBalance = uniform(new Vector3(1, 1, 1));
  readonly gradeContrast = uniform(0);
  readonly gradePivotLift = uniform(0);
  readonly gradeSaturation = uniform(1);
  readonly gradeShadowTint = uniform(new Vector3(1, 1, 1));
  readonly gradeHighlightTint = uniform(new Vector3(1, 1, 1));
}

const contexts = new WeakMap<AtmosphereNodes, UnlitDisplayUniforms>();

export function unlitDisplayFor(nodes: AtmosphereNodes): UnlitDisplayUniforms {
  let display = contexts.get(nodes);
  if (!display) contexts.set(nodes, (display = new UnlitDisplayUniforms()));
  return display;
}

/** Only explicit display controls enter this context: no event, hour, map tint, or automatic exposure. */
export function updateUnlitDisplay(nodes: AtmosphereNodes, settings: UnlitDisplaySettings): void {
  const display = unlitDisplayFor(nodes);
  display.exposure.value = settings.exposure;
  display.vignette.value = settings.vignette;
  display.toneMapper.value = ['faithful', 'agx', 'neutral', 'aces'].indexOf(settings.toneMapper);
  display.graded.value = hasCinematicGrade(settings) ? 1 : 0;
  display.gradeBalance.value.fromArray(settings.gradeBalance);
  display.gradeContrast.value = settings.gradeContrast;
  display.gradePivotLift.value = settings.gradePivotLift;
  display.gradeSaturation.value = settings.gradeSaturation;
  display.gradeShadowTint.value.fromArray(settings.gradeShadowTint);
  display.gradeHighlightTint.value.fromArray(settings.gradeHighlightTint);
}

/**
 * Palette-normalized clear-noon linear RGB to display-linear RGB. Transform before MRT alpha blending: its alpha
 * must carry every foreground material's coverage for occlusion, so it cannot also retain the unlit-only coverage
 * needed to unpremultiply a nonlinear tone/grade later. The attachment stores premultiplied display colour.
 */
export function unlitDisplayColour(colour: ShaderNode, nodes: AtmosphereNodes): ShaderNode {
  const display = unlitDisplayFor(nodes);
  const vignette = float(1).sub(smoothstep(0.45, 1.05, length(screenUV.sub(0.5).mul(1.6))).mul(display.vignette));
  const exposed: ShaderNode = colour.mul(display.exposure).mul(vignette);
  let linear: ShaderNode = faithfulToneMap(exposed);
  for (const [index, mapper] of [AgXToneMapping, NeutralToneMapping, ACESFilmicToneMapping].entries()) {
    linear = display.toneMapper.equal(index + 1).select(toneMapping(mapper, float(1), vec4(exposed, 1)).rgb, linear);
  }
  return mix(linear, cinematicGrade(linear, display), display.graded);
}
