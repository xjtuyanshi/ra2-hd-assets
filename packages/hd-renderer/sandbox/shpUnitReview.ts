/** Deterministic SHP review rows; no browser or renderer ownership, so geometry/step policy is asset-free testable. */
import type { LiveObject } from '../src/live/liveView';
import type { ShpUnitState } from '../src/live/shpUnits';

export function shpUnitReview(
  params: URLSearchParams,
  cx: number,
  cy: number,
  z: number,
  firstUid: number,
): LiveObject[] {
  const types = (params.get('stypes') ?? 'DRON')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
  const state = (params.get('seq') ?? 'stand').toLowerCase() as ShpUnitState;
  const step = Number(params.get('step') ?? 0);
  const spacing = Number(params.get('sspace') ?? 1);
  if (!['stand', 'walk', 'fire'].includes(state)) throw new Error('SHP review seq must be Stand, Walk or Fire');
  if (!types.length || !Number.isFinite(step) || !Number.isFinite(spacing) || spacing <= 0)
    throw new Error('SHP review needs types, a finite step and positive spacing');
  return types.flatMap((type, row) =>
    Array.from({ length: 8 }, (_, facing) => {
      const uid = firstUid + row * 8 + facing;
      const across = (facing - 3.5) * 0.6 * spacing;
      const down = (row - (types.length - 1) / 2) * 0.9 * spacing;
      return {
        id: uid,
        uid,
        kind: 'vehicle',
        type,
        owner: 0,
        // Equal height and opposite x/y offsets keep every facing on the same screen row.
        x: Math.round((cx + 0.5 + across + down) * 256),
        y: Math.round((cy + 0.5 - across + down) * 256),
        z,
        // Engine NW is screen-up: the row matches the sheet's clockwise body blocks 0..7.
        facingRaw: ((facing + 7) % 8) * 8192,
        shpUnitPose: { state, step: Math.floor(step) },
        health: 1,
        isSelected: false,
      };
    }),
  );
}

export function advanceShpReview(objects: LiveObject[], elapsed: number, period: number): LiveObject[] {
  if (!Number.isFinite(period) || period < 0) throw new Error('SHP review animate must be finite and non-negative');
  if (period === 0) return objects;
  return objects.map((object) =>
    object.shpUnitPose
      ? {
          ...object,
          shpUnitPose: {
            state: object.shpUnitPose.state,
            step: object.shpUnitPose.step + Math.floor(Math.max(0, elapsed) / period),
          },
        }
      : object,
  );
}
