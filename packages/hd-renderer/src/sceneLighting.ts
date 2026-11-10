/** Presentation inputs supplied by an adapter, independent of native palettes and event names. */
export interface SceneLighting {
  terrain: [number, number, number];
  objects: [number, number, number];
  sunShadow: number;
  overcast: number;
  skyFlash: number;
  /**
   * Share (0..1) of the display's cinematic grade the scene keeps; default 1. A look's grade is tuned on the authored
   * light: an adapter whose game darkens the picture at run time (a night [Lighting] edit, a storm) fades it, as the
   * night presentation does, instead of letting the grade's shadow tint and mid-tone lift take the whole darkened view.
   */
  gradeShare?: number;
  /** Encoded display-sRGB amount per channel (0..1) taken off the lit, visible battlefield after the display transform. */
  darkLoss?: [number, number, number];
}

/** Protect shared GPU uniforms from invalid input, retaining exact finite nonnegative gains. */
export function resolveSceneLighting(live: SceneLighting | null | undefined): Required<SceneLighting> {
  const rgb = (value: readonly number[] | undefined): [number, number, number] =>
    value?.length === 3 && value.every((v) => Number.isFinite(v) && v >= 0)
      ? [value[0]!, value[1]!, value[2]!]
      : [1, 1, 1];
  const unit = (value: number | undefined, fallback: number) =>
    value !== undefined && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : fallback;
  const loss = live?.darkLoss;
  return {
    terrain: rgb(live?.terrain),
    objects: rgb(live?.objects),
    sunShadow: unit(live?.sunShadow, 1),
    overcast: unit(live?.overcast, 0),
    skyFlash: live && Number.isFinite(live.skyFlash) ? Math.max(0, live.skyFlash) : 0,
    gradeShare: unit(live?.gradeShare, 1),
    darkLoss:
      loss?.length === 3 && loss.every((v) => Number.isFinite(v) && v >= 0)
        ? [Math.min(1, loss[0]), Math.min(1, loss[1]), Math.min(1, loss[2])]
        : [0, 0, 0],
  };
}
