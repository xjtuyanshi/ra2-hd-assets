import type { MapLighting } from '../contract';
import type { SceneLighting } from '../sceneLighting';

/** Current scene light supplied by a game adapter; all values use palette-domain [Lighting] fractions. */
export interface Ra2SceneLighting {
  ambient: number;
  ground: number;
  level: number;
  tint: [number, number, number];
  override: [number, number, number] | null;
  event: 'storm' | 'nuke' | 'dominator' | 'timewarp' | null;
  storm?: { active: boolean; pending: boolean; ending: boolean; cell: { x: number; y: number } };
  /**
   * The engine's active light sources (leptons; intensity and tint in fractional [Lighting] units), when the adapter
   * reads them from the game: the map light grade then follows the game itself instead of a map sidecar's type table.
   */
  sources?: { x: number; y: number; z: number; radius: number; intensity: number; tint: [number, number, number] }[];
}

export interface SceneMultipliers {
  terrain: [number, number, number];
  objects: [number, number, number];
}

/**
 * Replace the authored light, without modifying its grade, exposure or white adaptation. Height is the map's median
 * cell height and excludes light-source contributions. Palette overrides replace the normalized terrain tint but
 * multiply untinted object art directly; ordinary scene changes only replace the intensity.
 */
export function computeSceneMultipliers(
  map: MapLighting | null | undefined,
  live: Ra2SceneLighting | null | undefined,
  medianZ: number,
): SceneMultipliers {
  const identity = (): SceneMultipliers => ({ terrain: [1, 1, 1], objects: [1, 1, 1] });
  if (!map || !live) return identity();
  const values = [
    map.ambient,
    map.ground,
    map.level,
    map.red,
    map.green,
    map.blue,
    live.ambient,
    live.ground,
    live.level,
    medianZ,
  ];
  if (!values.every(Number.isFinite) || (live.override && !live.override.every((v) => Number.isFinite(v) && v >= 0)))
    return identity();
  // Avoid a divide (and any rounding) in the normal authored state, including a map with zero ambient light.
  if (live.override === null && live.ambient === map.ambient && live.ground === map.ground && live.level === map.level)
    return identity();
  const authored = Math.max(0, map.ambient + map.level * medianZ - map.ground);
  const current = Math.max(0, live.ambient + live.level * medianZ - live.ground);
  // A completely black authored channel has no recoverable palette signal. Keep the transform finite rather than
  // inventing a huge gain; valid ordinary maps retain the exact ratio, without an arbitrary brightness ceiling.
  const ratio = authored > 0 ? current / authored : current === 0 ? 0 : 1;
  if (!live.override) return { terrain: [ratio, ratio, ratio], objects: [ratio, ratio, ratio] };
  const mapTint = [map.red, map.green, map.blue];
  const maxTint = Math.max(...mapTint);
  const objects = live.override.map((channel) => ratio * channel) as [number, number, number];
  const terrain = live.override.map((channel, i) => {
    const normalized = maxTint > 0 ? Math.max(0, mapTint[i]!) / maxTint : 1;
    return ratio * (normalized > 0 ? channel / normalized : channel);
  }) as [number, number, number];
  return { terrain, objects };
}

/** Translate native palette/event policy into renderer-only presentation inputs. */
export function ra2SceneLighting(
  map: MapLighting | null | undefined,
  live: Ra2SceneLighting | null | undefined,
  medianZ: number,
  skyFlash = 0,
): SceneLighting | null {
  if (!live) return null;
  const multipliers = computeSceneMultipliers(map, live, medianZ);
  const storm = live.event === 'storm';
  return {
    ...multipliers,
    sunShadow: storm ? 0 : 1,
    overcast: storm ? 1 : 0,
    skyFlash: storm && Number.isFinite(skyFlash) ? Math.min(0.12, Math.max(0, skyFlash)) : 0,
  };
}

/** Interpolate only adjacent known publications in the same event; event switches and unknown reads are immediate. */
export function interpolateSceneLighting(
  previous: { frame: number; lighting?: Ra2SceneLighting | null } | null | undefined,
  current: { frame: number; lighting?: Ra2SceneLighting | null },
  alpha: number,
): Ra2SceneLighting | null {
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
  lighting: Ra2SceneLighting,
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
