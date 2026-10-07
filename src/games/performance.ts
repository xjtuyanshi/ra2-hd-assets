/** Native simulation counters, not DirectDraw/VBlank, rAF, or target frame rates. */
export interface GameFrameCounters {
  frame: number;
  gameSpeed: number;
  sessionSpeed: number;
  requestedFps: number;
  /**
   * Logic frames a second the game's own frame limiter allows right now, when the game module can tell from the
   * validated executable: a number for a limited speed setting, null when the limiter is off (the fastest setting).
   * Absent when unknown (another executable, or a session the game paces another way, such as a network match).
   * It is what the setting asks for, never a measurement.
   */
  targetFps?: number | null;
}
export type GameFrameReader = () => GameFrameCounters | null;
export interface GamePerformanceSample extends GameFrameCounters {
  sampledAtMs: number;
  intervalMs: number | null;
  logicFps: number | null;
  status: 'baseline' | 'sample' | 'reset' | 'inactive';
}
