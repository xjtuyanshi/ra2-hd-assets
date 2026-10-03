import type { MapLighting } from './contract';

/** Current scene light supplied by a game adapter; all values use palette-domain [Lighting] fractions. */
export interface SceneLighting {
  ambient: number;
  ground: number;
  level: number;
  tint: [number, number, number];
  override: [number, number, number] | null;
  event: 'storm' | 'nuke' | 'dominator' | 'timewarp' | null;
  storm?: { active: boolean; pending: boolean; ending: boolean; cell: { x: number; y: number } };
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
  live: SceneLighting | null | undefined,
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
