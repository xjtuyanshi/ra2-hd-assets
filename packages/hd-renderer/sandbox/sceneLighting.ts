import type { MapLighting } from '../src/contract';
import type { SceneLighting } from '../src/sceneLighting';

/** Optional bench override, in [Lighting] fractions. A seven-value override stages a storm palette. */
export function parseSceneLighting(value: string | null, map: MapLighting): SceneLighting | undefined {
  if (value === null) return undefined;
  const fields = value.split(',').map((part) => part.trim());
  const values = fields.map(Number);
  if (
    (fields.length !== 4 && fields.length !== 7) ||
    fields.some((part) => part.length === 0) ||
    values.some((v) => !Number.isFinite(v) || v < 0 || v > 10)
  )
    throw new Error('Invalid lighting: expected ambient,r,g,b[,overrideR,overrideG,overrideB] in [0,10]');
  return {
    ambient: values[0]!,
    ground: map.ground,
    level: map.level,
    tint: [values[1]!, values[2]!, values[3]!],
    override: values.length === 7 ? [values[4]!, values[5]!, values[6]!] : null,
    event: values.length === 7 ? 'storm' : null,
  };
}
