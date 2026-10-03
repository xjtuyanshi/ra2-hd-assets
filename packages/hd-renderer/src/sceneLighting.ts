/** Presentation inputs supplied by an adapter, independent of native palettes and event names. */
export interface SceneLighting {
  terrain: [number, number, number];
  objects: [number, number, number];
  sunShadow: number;
  overcast: number;
  skyFlash: number;
}

/** Protect shared GPU uniforms from invalid input, retaining exact finite nonnegative gains. */
export function resolveSceneLighting(live: SceneLighting | null | undefined): SceneLighting {
  const rgb = (value: readonly number[] | undefined): [number, number, number] =>
    value?.length === 3 && value.every((v) => Number.isFinite(v) && v >= 0)
      ? [value[0]!, value[1]!, value[2]!]
      : [1, 1, 1];
  const unit = (value: number | undefined, fallback: number) =>
    value !== undefined && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : fallback;
  return {
    terrain: rgb(live?.terrain),
    objects: rgb(live?.objects),
    sunShadow: unit(live?.sunShadow, 1),
    overcast: unit(live?.overcast, 0),
    skyFlash: live && Number.isFinite(live.skyFlash) ? Math.max(0, live.skyFlash) : 0,
  };
}
