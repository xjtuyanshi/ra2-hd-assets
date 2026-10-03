import type { SceneLighting } from '../sceneLighting';

/** Interpolate only adjacent known publications in the same event; event switches and unknown reads are immediate. */
export function interpolateSceneLighting(
  previous: { frame: number; lighting?: SceneLighting | null } | null | undefined,
  current: { frame: number; lighting?: SceneLighting | null },
  alpha: number,
): SceneLighting | null {
  const before = previous?.lighting;
  const after = current.lighting;
  if (
    !before ||
    !after ||
    previous!.frame + 1 !== current.frame ||
    before.event !== after.event ||
    !!before.override !== !!after.override ||
    alpha >= 1
  )
    return after ?? null;
  const t = Math.max(0, alpha);
  const lerp = (a: number, b: number) => a + (b - a) * t;
  const rgb = (a: readonly number[], b: readonly number[]): [number, number, number] => [
    lerp(a[0]!, b[0]!),
    lerp(a[1]!, b[1]!),
    lerp(a[2]!, b[2]!),
  ];
  return {
    ...after,
    ambient: lerp(before.ambient, after.ambient),
    ground: lerp(before.ground, after.ground),
    level: lerp(before.level, after.level),
    tint: rgb(before.tint, after.tint),
    override: before.override && after.override ? rgb(before.override, after.override) : null,
  };
}

/**
 * Blue-white local illumination, calibrated to a 1.6x palette-domain luminance lift over storm-darkened ground.
 * The light field adds linear irradiance outside the scene palette multiplier, hence the 2.2 conversion. Surface
 * colour, directional shading and object-light desaturation vary, so exact displayed pixels require a live capture.
 */
export function stormStrikeLight(
  lighting: SceneLighting,
  height: number,
  reference: number,
): { colour: [number, number, number]; peak: number; radius: number } {
  const intensity = Math.max(0, lighting.ambient + lighting.level * height - lighting.ground);
  const tint = lighting.override ?? [1, 1, 1];
  const stormLinear = tint.map((channel) => Math.pow(Math.max(0, intensity * channel), 2.2));
  const luminance = stormLinear[0]! * 0.2126 + stormLinear[1]! * 0.7152 + stormLinear[2]! * 0.0722;
  const colour: [number, number, number] = [0.68, 0.82, 1];
  const colourLuminance = colour[0] * 0.2126 + colour[1] * 0.7152 + colour[2] * 0.0722;
  return {
    colour,
    peak: (Math.max(0, reference) * luminance * (Math.pow(1.6, 2.2) - 1)) / colourLuminance,
    radius: 4.5,
  };
}
