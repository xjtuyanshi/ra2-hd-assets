import type { VmShell } from '../../../adapter/vmShell';
import type { VmFrame } from '../../../vm86/win32';
import type { GameRenderEffects, GameRenderSidebar, GameRenderState } from '../../../games/renderState';
import {
  RENDER_PASSTHROUGH,
  RENDER_PASSTHROUGH_ALL,
  RENDER_PASSTHROUGH_KEY_RGB565,
} from '../../../games/renderPassthrough';
import type { FrameRect, VmFrameRenderer } from './vmFrameRenderer';
import type { HdUi } from './hdUi';
import type { HdStallMonitor, HdStallActivity } from './hdStallMonitor';
import { devicePixelBox } from './devicePixelBox';
import type { LookPreset } from '../../../../packages/hd-renderer/src/HdRenderer';
import type { LiveSnapshot, LiveView, LiveWarmType } from '../../../../packages/hd-renderer/src/live/liveView';
import {
  browserWarmStorage,
  readShownLayout,
  readTopEffects,
  readWarmTypes,
  warmTypeKey,
  writeShownLayout,
  writeTopEffects,
  writeWarmTypes,
  WARM_TYPES_LIMIT,
  type HdShownLayout,
} from './hdWarmStore';
import { parseWeatherParams } from '../../../../packages/hd-renderer/src/weatherParams';
import { QualityGovernor } from '../../../../packages/hd-renderer/src/qualityGovernor';
import { FramePacer } from '../../../graphics/framePacer';
import { createWebGpuFrameCapture } from '../../../graphics/webGpuFrameCapture';
import { t } from '../../shared/i18n/translate';

/**
 * HD remaster bridge (development only, `?hd=1`): draws the running match with the HD renderer on a canvas under the
 * game canvas. The game's frame is made transparent over the tactical view, so the original sidebar, command bar and
 * cursor stay on top and every click still goes to the game unchanged; only the battlefield picture is replaced.
 *
 * With native overlay passthrough (src/games/renderPassthrough.ts; the page opts the VM in for `?hd=1`) the game stops
 * drawing the world categories in `?hd-passthrough=` (default all: terrain,objects,effects; also `none` or a number) and
 * only key-coloured pixels become transparent: selection brackets, health bars, the band box, placement grid, target
 * lines, text and every other native overlay stay on top. Only the terrain category fills the tactical view with the key
 * colour, so a set without terrain (e.g. `objects,effects`) cannot be keyed: the game still skips those categories, but
 * the page makes the whole tactical rectangle transparent, as it does without passthrough (other games, patches not
 * installed, `none`).
 *
 * Compositing needs the WebGL2 frame renderer (an alpha drawing buffer); with Canvas 2D the bridge does not start.
 *
 * The map's HD cache must exist locally (pnpm hd:prepare -- --map <map>); without it, or outside a battle, the original
 * frame is shown as usual. A map whose view failed to load is tried again after LOAD_RETRY_MS or at the next match on
 * it, so a cache built while the page stays open is picked up without a reload. While a match runs on such a map the
 * host is told why the original picture is shown (`publishStatus`), once per match (see NOTICE_MS).
 *
 * Every route keeps the game's complete, live original picture while HD prepares. A complete HD scene
 * cross-fades in over 300 ms at match start and after reader recovery; no deadline can expose missing units. Passthrough
 * is enabled only after that live-picture fade, and its overlays take over on an actual keyed native frame.
 * Failed preparation leaves the original playable and publishes only a small status notice.
 *
 * The game names the same scenario in different casings (the skirmish menu's `2Peaks`, then `2PEAKS.MAP` once the
 * match runs) and the development server resolves cache names without regard to case, so maps are compared by their
 * lower-cased name: a casing change is neither another map nor a reason to load the view a second time.
 */
export interface HdBridgeHost {
  vm: VmShell;
  screen: HTMLCanvasElement;
  frameRenderer: VmFrameRenderer;
  /** Redraw the game frame (the transparent rectangle changed). */
  invalidate(): void;
  /** Current guest frame size, or null before the first frame. */
  frameSize(): { width: number; height: number } | null;
  /** Read-only local input position; cursor shape always comes from the guest snapshot. */
  pointerPosition?(): Readonly<{ x: number; y: number }> | null;
  pageCursor?(): boolean | undefined;
  /** Startup display cadence, independent of later drawing stalls. */
  displayRefreshMs?(): number | null;
  /**
   * Show a short localized notice over the game picture, or clear it with null: why the running match shows the
   * original picture instead of the HD view (the map has no HD cache, or its view failed to load).
   */
  publishStatus?(text: string | null): void;
  /**
   * The quality tier the shown HD view draws with (0 = everything, see HdRenderer.setQualityTier) out of `tiers`, or
   * null while the original picture is on screen. Called when it changes.
   */
  publishQuality?(tier: number | null, tiers: number): void;
  /**
   * Stalls of the current match: how many presented frames came more than 150 ms late while it ran, and the longest
   * such gap in ms; (0, 0) when another match begins (see hdStallMonitor.ts).
   */
  publishStalls?(count: number, longestMs: number): void;
  /** A shown HD canvas draw and the logic snapshot it used. */
  presented?(frame: number): void;
  /** Complete snapshot delivered to the page, before its next draw opportunity. */
  stateReceived?(frame: number): void;
}

/** The native core's renderHealth diagnostics (epoch milliseconds, null when healthy). */
interface NativeRenderHealth {
  unreadableSinceEpochMs?: number | null;
  incompleteSinceEpochMs?: number | null;
}

/**
 * The frame time the shown view is held to (60 presented frames a second, also on a faster display): when frames stay
 * above it for seconds and giving up passes makes them shorter, the view gives up its least visible passes tier by
 * tier, and takes them back after a calm stretch (QualityGovernor). `?hd-governor=0` keeps every pass whatever the
 * frame rate.
 */
const FRAME_BUDGET_MS = 1000 / 60;
/**
 * Frame rates the shown view is held to (FramePacer, src/graphics/framePacer.ts): 60 while the game keeps up with its
 * speed setting, 40 and then 30 while it does not. The emulator's thread is scheduled below the threads that draw, so
 * every frame the view draws costs the game speed: with the view drawing on every frame of a 120 Hz display a
 * six-player match reached 40 logic frames a second of the 62.5 its setting asks for, held to 40 frames it reached 62
 * (measurements in docs/remaster/HD_BRIDGE.md, "Frame rate").
 */
const PACE_RATES = [60, 40, 30] as const;
/** How often the shown view asks how the game is doing: one diagnostics request on the emulator's thread. */
const PACE_SAMPLE_MS = 1000;

/** `?hd-pace=`: what holds the shown view's frame rate (see parseHdPace). */
export type HdPaceMode = { kind: 'auto' } | { kind: 'fixed'; rate: number } | { kind: 'off' };

/**
 * `?hd-pace=`: `auto` (default) holds the view to 60 frames a second and lowers that while the game is behind its
 * speed setting; a number (10..240) holds it to that rate whatever the game does (`cap` is 60); `off` draws on every
 * display frame, as before the pacer existed (measurements and A/B checks).
 */
export function parseHdPace(value: string | null): HdPaceMode {
  if (value === 'off') return { kind: 'off' };
  if (value === 'cap') return { kind: 'fixed', rate: PACE_RATES[0] };
  const rate = value === null || value.trim() === '' ? NaN : Number(value);
  if (Number.isFinite(rate) && rate >= 10 && rate <= 240) return { kind: 'fixed', rate };
  return { kind: 'auto' };
}

/**
 * How far over the budget the frames of a verdict window may be on average (without the window's longest frames, see
 * QualityGovernor) before the window counts as over it. A browser does not always pace a slow view in whole refresh
 * intervals: a view short of time was measured presenting a steady 18.1 to 18.4 ms (55 frames a second), which a wide
 * margin took for holding 60; on budget the frames are 16.6 to 16.8 ms. Paced in whole intervals, this margin is
 * crossed when more than about one frame in eleven is late (below 55 frames a second).
 */
const FRAME_BUDGET_MARGIN = 1.04;

/** YR's in-game layout around the tactical view: sidebar on the right, command bar at the bottom (engine pixels). */
const SIDEBAR_WIDTH = 168;
const COMMAND_BAR_HEIGHT = 32;
/** After passthrough is switched off, frames the game already rendered may still carry the key colour. */
const PASSTHROUGH_TRAIL_MS = 500;
/** Brief state gaps (including other input windows) keep the last HD picture instead of flashing the original. */
const STATE_HIDE_HOLD_MS = 500;
/** A pending reader must never leave its last HD picture on screen indefinitely. */
const STATE_REQUEST_STALL_MS = 1000;
/**
 * A native capture truncated for this long without one completed render state is not catching up: the match has
 * outgrown what the agent copies per frame (round 9e #10 froze the HD picture over a live game for 5.5 minutes, and a
 * save of that match never left the preparation notice). Short truncations while scrolling end well within it.
 */
const CAPTURE_STARVED_MS = 2000;
/** While the preparation notice waits on such a capture, the health report is read this often. */
const CAPTURE_PROBE_MS = 1000;
/** A health report that never answers must not block every later check. */
const HEALTH_TIMEOUT_MS = 2000;
/** Blend two live pictures without fading the independent pointer or the sidebar. */
const CROSS_FADE_MS = 300;
/** A busy or incomplete native mirror is transient, not evidence of missing passthrough support. */
const PASSTHROUGH_RETRY_MS = 250;
/**
 * Minimum time between two snapshot requests while the HD view shows the current map. Each request runs on the
 * emulator's thread (a snapshot whose logic frame moved on is read in full; an unchanged one comes back as the
 * identical object). About 60 Hz follows a 60 Hz display frame for frame, while 120/144 Hz displays poll every second
 * or third frame; LiveView interpolates between snapshots.
 */
const ACTIVE_POLL_MS = 15;
/** Native simulation snapshots must keep arriving when display frames or art preparation are slow. */
const NATIVE_POLL_MS = 1000 / 60;
/**
 * Poll interval while a snapshot would be read for nothing: the current map has no HD view (cache missing or still
 * loading), the bridge is toggled off, or the VM does not answer. Polling continues only to notice a map change, and
 * the faster rate resumes on the next animation frame once the view is ready or re-enabled.
 */
const IDLE_POLL_MS = 1000;
/**
 * Wait before a map whose HD view failed to load (cache missing or incomplete, the development server restarting, a
 * WebGPU error) is fetched again at the idle poll rate; a new match on the map retries at once. Long enough that a map
 * without a cache costs one failed fetch per wait, not one per poll.
 */
const LOAD_RETRY_MS = 30_000;
/**
 * Most drawing-buffer pixels of the HD canvas. The buffer normally has exactly the device pixels the canvas covers
 * (about 7.3 million for a 1920x1080 game at two device pixels per game pixel); the multisampled scene targets cost
 * roughly 100 bytes per pixel, so a larger rectangle (a 5K display, a browser zoomed far in) renders at this budget and
 * is scaled up by the compositor instead of exhausting GPU memory.
 */
// A 4112x2580 device-pixel page needs 10,608,960 pixels before excluding the sidebar.
const MAX_BUFFER_PIXELS = 12_000_000;
/**
 * How long the notice that a match shows the original picture stays up once the match is running. It is information
 * for the start of a match, not a banner for all of it: it returns at the next match on a map without an HD view, not
 * on every failed retry. The map is known, and its load fails, while the game still shows its loading screen, so the
 * time counts from the first logic frame after the failure, not from the failure.
 */
const NOTICE_MS = 12_000;

/**
 * Complete frames in a row (LiveView.settledFrames) before the view replaces the original picture. The first complete
 * frame builds the shaders and pipelines of everything new in it and can take a quarter of a second; the following
 * ones show that frames have their normal cost again.
 */
const REVEAL_SETTLED_FRAMES = 3;
/**
 * Pace of the preparation once the scenario has objects (the game's own picture is, or is about to be, on screen):
 * new kinds of art added per frame (LiveView.newArtPerFrame) and atlas-page pixels uploaded per frame
 * (LiveView.hiddenUploadPixels), the same as a shown view uploads.
 */
const HIDDEN_NEW_ART_PER_FRAME = 1;
const HIDDEN_UPLOAD_PIXELS = 8 << 20;
/** Out of sight and complete, the view only needs an occasional frame until the match starts (every Nth tick). */
const HIDDEN_IDLE_TICKS = 12;
/**
 * The kinds of object a match shows are collected for the next match's preparation (hdWarmStore.ts) every
 * WARM_COLLECT_FRAMES logic frames during its first WARM_COLLECT_UNTIL_FRAME (about five minutes at normal speed:
 * starting units, the opening buildings and what they produce first). Later kinds are left to load when they appear,
 * so a loading screen never has to prepare a whole tech tree.
 */
const WARM_COLLECT_FRAMES = 60;
const WARM_COLLECT_UNTIL_FRAME = 6000;

/** Times (performance.now(), ms) of the current match's HD start; null until reached. Diagnostics only. */
export interface HdBridgeTimeline {
  map: string | null;
  /** First complete snapshot for this match, before art preparation or reveal. */
  firstStateAt: number | null;
  /** First nonzero passthrough request and its successful reply for this match. */
  passthroughRequestedAt: number | null;
  passthroughAcceptedAt: number | null;
  /** The view's load began (the map became known) and ended (`live view ready`). */
  loadAt: number | null;
  readyAt: number | null;
  /** A remembered list was handed to the view, with its length; when the view first drew it completely. */
  warmAt: number | null;
  warmTypes: number;
  warmSettledAt: number | null;
  /** First snapshot with objects; first snapshot whose logic frame is past 0 (the match runs). */
  objectsAt: number | null;
  matchAt: number | null;
  /** The complete view began replacing the original picture. */
  revealedAt: number | null;
  revealReason: 'settled' | null;
  /** First battle-size picture received; distinct from the first decoded state. */
  firstBattleFrameAt: number | null;
  /** The live original-to-HD fade began and completed. */
  fadeStartedAt: number | null;
  fadeFinishedAt: number | null;
  /** Art still on its way when the view was shown; complete reveals record zero. */
  revealLoading: number;
  /** Legacy diagnostic fields retained for saved-observation readers; always null. No curtain is created. */
  curtainAt: number | null;
  curtainLiftedAt: number | null;
  /** Page-session history, including matches that ended before the current one. */
  transitions: HdBridgeTransition[];
  transitionsOmitted: number;
}

export interface HdBridgeTransition {
  atMs: number;
  time: string;
  map: string | null;
  frame: number;
  from: 'original' | 'hd';
  to: 'original' | 'hd';
  reason: string;
}

/** Page-clock observations at the bridge boundary, independent of rAF and the game's target frame rate. */
export interface HdBridgeCounters {
  distinctStates: number;
  drawnFrames: number;
  shownFrames: number;
  /** First successful LiveView.render(), including preparation out of sight. */
  firstDrawAtMs: number | null;
  /** First completed HD picture shown on this page (performance.now(), from navigation). */
  firstShownDrawAtMs: number | null;
  lastStateAtMs: number | null;
  lastStateFrame: number | null;
  lastStateMap: string | null;
}

/** Only the native visibility, camera bounds and weapon effects needed by combat observation. */
export interface HdBridgeCombatState extends Pick<GameRenderState, 'frame' | 'view' | 'shroud'> {
  sidebar: {
    frame: GameRenderSidebar['frame'];
    layout: Pick<GameRenderSidebar['layout'], 'sidebar' | 'commandBar'>;
  } | null;
  effects:
    | (Pick<GameRenderEffects, 'anims' | 'bullets' | 'lasers' | 'electricBolts' | 'radBeams' | 'waves'> & {
        /** Partial animation evidence must not establish complete combat observation. */
        animsTruncated: boolean;
      })
    | null;
}

/** Development-only readback of an actual completed HD canvas draw. */
export interface HdBridgeDrawCapture {
  frame: number;
  drawAtMs: number;
  shown: boolean;
  nativeSize: { width: number; height: number };
  view: GameRenderState['view'];
  map: string | null;
  rect: FrameRect;
  state: HdBridgeCombatState;
  passthrough: { flags: number; keyed: boolean; unsupported: boolean };
  interpolation: 'normal LiveView interpolation';
  width: number;
  height: number;
  format: string;
  pixels: Uint8Array;
}

const MAX_COMBAT_DIAGNOSTIC_ANIMS = 8192;
const combatSnapshot = (state: GameRenderState | null): HdBridgeCombatState | null => {
  if (!state) return null;
  const { frame, view, shroud, sidebar, effects } = state;
  return structuredClone({
    frame,
    view,
    shroud,
    sidebar: sidebar
      ? {
          frame: sidebar.frame,
          layout: { sidebar: sidebar.layout.sidebar, commandBar: sidebar.layout.commandBar },
        }
      : null,
    effects: effects
      ? {
          // The bridge reports real animation metadata without assigning game
          // meaning to type IDs. A development observer owns that policy.
          anims: effects.anims.slice(0, MAX_COMBAT_DIAGNOSTIC_ANIMS),
          animsTruncated: effects.anims.length > MAX_COMBAT_DIAGNOSTIC_ANIMS,
          bullets: effects.bullets,
          lasers: effects.lasers,
          electricBolts: effects.electricBolts,
          radBeams: effects.radBeams,
          waves: effects.waves,
        }
      : null,
  });
};

export interface HdBridgeCapture {
  startAtMs: number;
  endAtMs: number | null;
  startStateFrame: number | null;
  endStateFrame: number | null;
  startStateMap: string | null;
  endStateMap: string | null;
  distinctStates: number;
  drawnFrames: number;
  shownFrames: number;
  /** Arrival timestamps for distinct map/logic-frame identities, not requests or repeated unchanged replies. */
  deliveries: { atMs: number; frame: number; map: string }[];
  /** Completed render calls, including whether the HD picture was shown at that draw. */
  draws: { atMs: number; frame: number; shown: boolean }[];
  /** Records beyond the bound are counted above, but omitted from the timestamp arrays. */
  truncated: boolean;
}

/** Enough for a minute at 240 Hz; a forgotten development capture must not grow without a bound. */
const CAPTURE_RECORDS = 20_000;

const emptyTimeline = (map: string | null): HdBridgeTimeline => ({
  map,
  firstStateAt: null,
  passthroughRequestedAt: null,
  passthroughAcceptedAt: null,
  loadAt: null,
  readyAt: null,
  warmAt: null,
  warmTypes: 0,
  warmSettledAt: null,
  objectsAt: null,
  matchAt: null,
  revealedAt: null,
  revealReason: null,
  firstBattleFrameAt: null,
  fadeStartedAt: null,
  fadeFinishedAt: null,
  revealLoading: 0,
  curtainAt: null,
  curtainLiftedAt: null,
  transitions: [],
  transitionsOmitted: 0,
});

/**
 * `?hd-passthrough=`: comma list of category names, `all`, `none`, or a number. Default all: the HD renderer draws its
 * own effects, and native translucent effects would blend with the key colour.
 */
export function parsePassthroughFlags(value: string | null): number {
  if (value === null || value === '') return RENDER_PASSTHROUGH_ALL;
  if (/^\d+$/.test(value)) return Number(value) & RENDER_PASSTHROUGH_ALL;
  if (value === 'all') return RENDER_PASSTHROUGH_ALL;
  let flags = 0;
  for (const name of value.split(',')) flags |= RENDER_PASSTHROUGH[name.trim() as keyof typeof RENDER_PASSTHROUGH] ?? 0;
  return flags;
}

/**
 * Rules types the native sidebar shows as on their way: being produced (its clock runs or is on hold), queued, or
 * finished and waiting to be placed or to leave its factory. The view loads their art now (LiveView.prepare), so it is
 * in when the object appears seconds later; before, a building was drawn as nothing for most of a second after it was
 * placed, until its atlas pages had loaded. Superweapons are not objects. The reader reports the cameos of the tab on
 * screen that are inside the strip, which is where a production is started from; one started without its cameo ever
 * being on screen is first heard of when its object appears, as before.
 */
export function sidebarUpcomingTypes(sidebar: GameRenderSidebar | null | undefined): string[] {
  const types: string[] = [];
  for (const cameo of sidebar?.cameos ?? []) {
    if (cameo.kind === 'super' || types.includes(cameo.id)) continue;
    if (cameo.progress !== null || cameo.ready || cameo.queued > 0) types.push(cameo.id);
  }
  return types;
}

/** What the speed telemetry reads from the bridge (speedTelemetry.ts `SpeedScene`); null outside a battle. */
export interface HdBridgeScene {
  map: string | null;
  objects: number;
  localObjects: number;
  hdShown: boolean;
  tier: number | null;
  hdFrames: number;
  /** Frame rate the shown view is held to right now (see PACE_RATES); null when nothing holds it. */
  pace: number | null;
}

/**
 * Stops the bridge when called; `toggle` switches between the HD view and the original picture (true: HD shown);
 * `scene` describes the running match for the speed telemetry.
 */
export type HdBridgeControl = (() => void) & {
  toggle(): boolean;
  scene(): HdBridgeScene | null;
  /** Last observed faction art family; retained while a modal hides battlefield state. */
  menuSide?(): number | null;
  /** Reuse the already sampled battle ownership without another state read. */
  battleActive?(): boolean;
  /** Only sampled when a frame interval is long, never in every pointer event. */
  activity?(): HdStallActivity | null;
  /** Called synchronously for a native picture before it can be painted. */
  frame(frame: VmFrame): void;
};

export function startHdBridge(host: HdBridgeHost): HdBridgeControl {
  if (host.frameRenderer.backend !== 'WebGL2') {
    // Canvas 2D draws every frame opaque: neither the key nor the transparent rectangle could show the HD view.
    console.warn('[HD] the HD bridge needs the WebGL2 frame renderer; showing the original picture');
    return Object.assign(() => undefined, { toggle: () => false, scene: () => null, frame: () => undefined });
  }
  const params = new URLSearchParams(window.location.search);
  const canvas = document.createElement('canvas');
  canvas.id = 'hd-screen';
  Object.assign(canvas.style, {
    position: 'absolute',
    left: '0px',
    top: '0px',
    zIndex: '0',
    pointerEvents: 'none',
    display: 'none',
  });
  const screenStyle = { position: host.screen.style.position, zIndex: host.screen.style.zIndex };
  host.screen.style.position = 'relative';
  host.screen.style.zIndex = '1';
  host.screen.parentElement!.insertBefore(canvas, host.screen);

  let live: LiveView | null = null;
  /** Map names below are keys: lower-cased, without the extension (see `mapKey`). */
  let liveMap: string | null = null;
  /** Last snapshot pushed to `live`; readers return the identical object while nothing changed. */
  let pushed: GameRenderState | null = null;
  /** Real native publications waiting for their draw, never more than one state behind the newest receipt. */
  const nativeDrawQueue: { state: GameRenderState; receivedAt: number }[] = [];
  let loading: string | null = null;
  /** Maps whose HD view failed to load, with the time from which a load is tried again. */
  const failed = new Map<string, number>();
  /** Map of the latest snapshot (null outside a battle): decides whether full snapshots are worth polling for. */
  let stateMap: string | null = null;
  /** Logic frame of the latest snapshot; a smaller one on the same map means a new match started. */
  let stateFrame = 0;
  let hole: FrameRect | null = null;
  let polling = false;
  let pollFailed = false;
  let lastPollAt = -Infinity;
  let nativePollTimer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  let enabled = true;
  let menuSide: number | null = null;
  let ui: HdUi | null = null;
  let stallMonitor: HdStallMonitor | null = null;
  let uiEnabled = params.get('hd-ui') === '1';
  let latestState: GameRenderState | null = null;
  let inBattle = false;
  /**
   * The map whose missing HD view was announced in this match, the logic frame at that moment, and until when the
   * notice stays on screen (Infinity until the logic frame moves on: see NOTICE_MS).
   */
  let fallback: { map: string; frame: number; until: number } | null = null;
  /** Map and newest logic frame of the match the reveal state below belongs to (kept while no snapshot arrives). */
  let matchMap: string | null = null;
  let matchFrame = 0;
  /** The view has replaced the original picture in the current match (see REVEAL_SETTLED_FRAMES). */
  let revealed = false;
  /** The match's snapshots have no objects yet: the game still loads the scenario. */
  let prematch = true;
  /** Whether the view of the current match was handed its remembered list (once per match). */
  let warmed = false;
  /** The sidebar's upcoming types as last handed to the current view (see sidebarUpcomingTypes). */
  let upcomingKey = '';
  /** Kinds of object of the current match, for the next one (hdWarmStore.ts), and the last frame they were read at. */
  const matchTypes = new Map<string, LiveWarmType>();
  let collectedAt = -Infinity;
  let hiddenTicks = 0;
  /** Frame-time safeguard of the shown view (null with ?hd-governor=0 and before a view exists). */
  let governor: QualityGovernor | null = null;
  /** When the shown view drew its previous frame (null while it is not shown). */
  let shownAt: number | null = null;
  /** Frames the shown view has drawn (cumulative; the speed telemetry takes differences). */
  let shownFrames = 0;
  const paceMode = parseHdPace(params.get('hd-pace'));
  const native = host.vm.runtimeInfo?.backend === 'native';
  let fadeStartedAt: number | null = null;
  let fadeFinished = false;
  let nativeBattleSurface = false;
  let nativeMenuSurface = false;
  let nativeDialogSurface = false;
  let battleEpoch = 0;
  let preparationMap: string | null = null;
  let preparationAsking = false;
  let preparationAskedAt = -Infinity;
  let keyFrameAt: number | null = null;
  let hidePending: { at: number; reason: string } | null = null;
  let healthPending = false;
  let healthCheckedAt = -Infinity;
  let completeStateSerial = 0;
  let recoveringState = false;
  let recoveryOriginalFrameSeen = false;
  let presentation: HdBridgeTransition['to'] = 'original';
  /** Holds the shown view's frame rate (null with ?hd-pace=off: every display frame is drawn). */
  const pacer =
    paceMode.kind === 'off'
      ? null
      : new FramePacer({
          displayRefreshMs: host.displayRefreshMs,
          rates: paceMode.kind === 'fixed' ? [paceMode.rate] : PACE_RATES,
          sharedDrawingScheduler: !native,
        });
  /** The game's counters at the last pace sample, with their own timestamp; null before one and after a gap. */
  let paceLast: { atMs: number; frame: number; waitMs: number | null } | null = null;
  let paceAsking = false;
  let paceAskedAt = -Infinity;
  let publishedTier: number | null = null;
  const publishTier = (tier: number | null) => {
    if (tier === publishedTier) return;
    publishedTier = tier;
    host.publishQuality?.(tier, live?.hd.qualityTiers ?? 0);
  };
  const uiVisible = () => enabled && uiEnabled && revealed && !!hole && fadeFinished;
  const syncUiVisibility = () => ui?.setEnabled(uiVisible());
  const storage = browserWarmStorage();
  /** Layout the view was last shown with (this page load or an earlier one), see `layout`. */
  let shownLayout: HdShownLayout | null = readShownLayout(storage);
  /** An earlier match showed top-layer art: views get its pass before they are shown (see readTopEffects). */
  let topEffects = readTopEffects(storage);
  /** Guest frame size when the current view finished loading: the loading screen's video mode, as a key. */
  let loadingFrame: string | null = null;
  let timeline = emptyTimeline(null);
  const transitions: HdBridgeTransition[] = [];
  let transitionsOmitted = 0;
  const changePresentation = (to: HdBridgeTransition['to'], reason: string) => {
    if (to === presentation) return;
    const entry: HdBridgeTransition = {
      atMs: performance.now(),
      time: new Date().toISOString(),
      map: matchMap ?? stateMap,
      frame: stateFrame,
      from: presentation,
      to,
      reason,
    };
    // Repeated toggles cannot retain an unbounded history in a forgotten page.
    if (transitions.length < 512) transitions.push(entry);
    else transitionsOmitted++;
    presentation = to;
  };
  // This bridge is a development entry, but keep the measurement buffers and read-only probe surface under DEV
  // as well: production builds neither collect records nor gain a game-state console interface.
  const diagnostics = import.meta.env.DEV
    ? (() => {
        const counters: HdBridgeCounters = {
          distinctStates: 0,
          drawnFrames: 0,
          shownFrames: 0,
          firstDrawAtMs: null,
          firstShownDrawAtMs: null,
          lastStateAtMs: null,
          lastStateFrame: null,
          lastStateMap: null,
        };
        let previousState: string | null = null;
        let capture: HdBridgeCapture | null = null;
        const frameCapture = createWebGpuFrameCapture(({ atMs, shown }: { atMs: number; shown: boolean }) => {
          const rect = hole ?? keyRect;
          const nativeSize = host.frameSize();
          const state = combatSnapshot(pushed);
          if (!live || !rect || !nativeSize || !state) return null;
          return {
            backend: live.hd.renderer.backend,
            metadata: {
              frame: state.frame,
              drawAtMs: atMs,
              shown,
              nativeSize: { ...nativeSize },
              view: state.view,
              map: liveMap,
              rect: { ...rect },
              state,
              passthrough: { flags: passthroughRequest, keyed: !!keyRect, unsupported: passthroughUnsupported },
              interpolation: 'normal LiveView interpolation' as const,
            },
          };
        });
        const append = <T>(records: T[], record: T) => {
          if (records.length < CAPTURE_RECORDS) records.push(record);
          else if (capture) capture.truncated = true;
        };
        const snapshot = () => (capture ? structuredClone(capture) : null);
        return {
          state(state: GameRenderState | null) {
            const map = state?.map?.fileName?.replace(/\.[^.]+$/, '').toLowerCase() ?? null;
            const key = state && map ? `${map}:${state.frame}` : null;
            if (key !== null && key !== previousState && state && map) {
              const atMs = performance.now();
              counters.distinctStates++;
              counters.lastStateAtMs = atMs;
              counters.lastStateFrame = state.frame;
              counters.lastStateMap = map;
              if (capture && capture.endAtMs === null) {
                capture.distinctStates++;
                capture.endStateFrame = state.frame;
                capture.endStateMap = map;
                append(capture.deliveries, { atMs, frame: state.frame, map });
              }
            }
            previousState = key;
          },
          draw(shown: boolean) {
            const atMs = performance.now();
            counters.drawnFrames++;
            counters.firstDrawAtMs ??= atMs;
            if (shown) {
              counters.shownFrames++;
              counters.firstShownDrawAtMs ??= atMs;
            }
            if (capture && capture.endAtMs === null) {
              capture.drawnFrames++;
              if (shown) capture.shownFrames++;
              append(capture.draws, { atMs, frame: pushed?.frame ?? stateFrame, shown });
            }
            frameCapture.draw({ atMs, shown });
          },
          cancelFrameCapture: (reason: string) => frameCapture.cancel(reason),
          dispose: () => frameCapture.dispose(),
          reveal() {
            // A settled picture was rendered out of sight immediately before it became visible. Its completed
            // render counts once; the first-visible time belongs to reveal, not to the following display frame.
            counters.firstShownDrawAtMs ??= performance.now();
          },
          handle: {
            get enabled() {
              return enabled;
            },
            get shown() {
              return enabled && revealed && !!hole;
            },
            get state() {
              return latestState ? structuredClone(latestState) : null;
            },
            get combatState(): HdBridgeCombatState | null {
              // Observe the last delivered snapshot without copying map/object layers or issuing another RPC.
              // Detached copies keep diagnostics from changing the data consumed by the live renderer.
              return combatSnapshot(latestState);
            },
            get counters(): HdBridgeCounters {
              return { ...counters };
            },
            get capture(): HdBridgeCapture | null {
              return snapshot();
            },
            startCapture(): HdBridgeCapture {
              capture = {
                startAtMs: performance.now(),
                endAtMs: null,
                startStateFrame: counters.lastStateFrame,
                endStateFrame: counters.lastStateFrame,
                startStateMap: counters.lastStateMap,
                endStateMap: counters.lastStateMap,
                distinctStates: 0,
                drawnFrames: 0,
                shownFrames: 0,
                deliveries: [],
                draws: [],
                truncated: false,
              };
              return snapshot()!;
            },
            finishCapture(): HdBridgeCapture | null {
              if (capture && capture.endAtMs === null) capture.endAtMs = performance.now();
              return snapshot();
            },
            async captureNextDraw(timeoutMs = 10_000): Promise<HdBridgeDrawCapture> {
              const { metadata, ...image } = await frameCapture.request(timeoutMs);
              return { ...metadata, ...image };
            },
            getCommandState: () => host.vm.getCommandState(),
            getGamePerformance: () => host.vm.getGamePerformance(),
            getPointerState: () => host.vm.getPointerState(),
            getVmDiagnostics: () => host.vm.getDiagnostics('sample'),
          },
        };
      })()
    : null;
  let published: string | null = null;
  const publish = (text: string | null) => {
    if (text === published) return;
    published = text;
    host.publishStatus?.(text);
  };
  const preparationNotice = t('正在准备高清战场…');
  // The native launcher's recovery and terminal notices are deliberately in the owner's language.
  const recoveryNotice = '高清画面已暂停，正在恢复；您可以继续操作。';
  const capacityNotice = t('本局战场过大，高清画面跟不上，继续显示原版画面');
  /** The notice of the current recovery: a read fault recovers, a starved capture says why it may not. */
  let recoveryText = recoveryNotice;
  /** The capture of this battle is starved (see CAPTURE_STARVED_MS) while the view has not been revealed yet. */
  let captureStarved = false;
  let awaitingRevealSince: number | null = null;
  const isRecoveryNotice = (text: string | null) => text === recoveryNotice || text === capacityNotice;
  const clearFallback = () => {
    fallback = null;
    // A missing snapshot can clear a fallback while the actual battlefield still prepares.
    if (published !== preparationNotice && !isRecoveryNotice(published)) publish(null);
  };
  const awaitingReveal = () =>
    native && enabled && nativeBattleSurface && !nativeDialogSurface && !revealed && !fallback && !pollFailed;
  const syncPreparationNotice = () => {
    if (recoveringState) {
      if (enabled && nativeBattleSurface && !nativeDialogSurface && !fallback) publish(recoveryText);
      else if (isRecoveryNotice(published)) publish(null);
      return;
    }
    // An actual native battlefield, not an early map hint, owns this notice. It never covers play or replaces
    // a missing-cache/incomplete-art explanation, and a completed reveal does not reannounce on state gaps.
    const waiting = awaitingReveal();
    const notice = captureStarved ? capacityNotice : preparationNotice;
    if (waiting && (published === null || published === preparationNotice || published === capacityNotice))
      publish(notice);
    else if (!waiting && (published === preparationNotice || published === capacityNotice)) publish(null);
  };
  // The production graph walker follows page.ts -> hdBridge.ts, so the import itself must be under DEV.
  if (import.meta.env.DEV && params.get('hd-ui') === '1') {
    void import('./hdUi')
      .then(({ startHdUi }) => {
        if (stopped) return;
        ui = startHdUi(host);
        syncUiVisibility();
        ui.update(latestState?.sidebar ?? null);
      })
      .catch((error) => console.warn('[HD] interface layer unavailable', error));
  }
  // The stall recorder and its development-server sink: like the interface layer, behind DEV so that neither the
  // recorder nor a request to the log route exists in a production build.
  if (import.meta.env.DEV) {
    void import('./hdStallMonitor')
      .then(({ startHdStallMonitor }) => {
        if (stopped) return;
        stallMonitor = startHdStallMonitor({
          match: () => ({ map: stateMap, frame: stateFrame, shown: revealed && !!hole }),
          activity: () => live?.activity() ?? null,
          publish: (count, longestMs) => host.publishStalls?.(count, longestMs),
        });
      })
      .catch((error) => console.warn('[HD] stall recorder unavailable', error));
  }
  let frame = 0;
  let lastLayout = '';
  let appliedBuffer: HdShownLayout | null = null;
  let pendingBuffer: { key: string; since: number } | null = null;
  const passthroughFlags = parsePassthroughFlags(params.get('hd-passthrough'));
  /** Only the terrain category fills the tactical view with the key colour; without it no pixel could be keyed. */
  const keyable = (passthroughFlags & RENDER_PASSTHROUGH.terrain) !== 0;
  /** Guest passthrough state: requested flags (0 = off) and whether the game accepted them. */
  let passthroughRequest = 0;
  const passthroughUnsupported = passthroughFlags === 0;
  let passthroughInFlight = false;
  let passthroughConfirmed: number | null = null;
  let passthroughEverRequested = false;
  let passthroughRetryAt = 0;
  let passthroughSerial = 0;
  let passthroughAcceptedAt: number | null = null;
  /** Key rectangle kept for PASSTHROUGH_TRAIL_MS after switching off (see PASSTHROUGH_TRAIL_MS). */
  let keyRect: FrameRect | null = null;
  let keyUntil = 0;

  // The key programs are compiled now, not inside the frame that first shows the HD view.
  if (keyable && !passthroughUnsupported) host.frameRenderer.prepareTransparentKey();

  const requestPassthrough = (flags: number) => {
    if (flags && passthroughUnsupported) return;
    if (flags === passthroughRequest) {
      if (passthroughConfirmed === flags || passthroughInFlight || performance.now() < passthroughRetryAt) return;
    }
    passthroughRequest = flags;
    passthroughEverRequested = true;
    passthroughConfirmed = null;
    passthroughInFlight = true;
    passthroughAcceptedAt = null;
    keyFrameAt = null;
    const serial = ++passthroughSerial;
    const requestedTimeline = timeline;
    if (flags) requestedTimeline.passthroughRequestedAt ??= performance.now();
    if (!flags) keyUntil = performance.now() + PASSTHROUGH_TRAIL_MS;
    void host.vm.setTacticalPassthrough(flags).then(
      (accepted) => {
        if (stopped || serial !== passthroughSerial) return;
        passthroughInFlight = false;
        if (accepted) passthroughConfirmed = flags;
        if (flags && accepted) {
          passthroughAcceptedAt = performance.now();
          if (timeline === requestedTimeline) timeline.passthroughAcceptedAt ??= passthroughAcceptedAt;
        } else if (!accepted) {
          // Both routes return false while a runtime or mirror is not ready. Retain the desired flags and retry;
          // a rejected request may also have applied its write, so a later disable must still send zero.
          passthroughRetryAt = performance.now() + PASSTHROUGH_RETRY_MS;
        }
        if (!flags) keyUntil = performance.now() + PASSTHROUGH_TRAIL_MS;
        present();
      },
      () => {
        if (stopped || serial !== passthroughSerial) return;
        passthroughInFlight = false;
        passthroughRetryAt = performance.now() + PASSTHROUGH_RETRY_MS;
      },
    );
  };

  /** Apply hole/key/canvas visibility without ever replacing the original with an incomplete scene. */
  const present = () => {
    const keyedReady = passthroughAcceptedAt !== null && (keyFrameAt ?? -Infinity) >= passthroughAcceptedAt;
    const keyed = !!hole && fadeFinished && keyable && !passthroughUnsupported && keyedReady;
    if (keyed) keyRect = hole;
    const trailing = !hole && !!keyRect && performance.now() < keyUntil;
    if (!keyed && !trailing) keyRect = null;
    host.frameRenderer.setTransparentKey(keyRect ? { rect: keyRect, rgb565: RENDER_PASSTHROUGH_KEY_RGB565 } : null);
    // Fade the current original frame, never a screenshot. At its end an ordinary transparent rectangle keeps
    // HD visible until the first keyed native frame supplies the game's independent overlays.
    const opacity = fadeStartedAt === null ? 0 : Math.max(0, 1 - (performance.now() - fadeStartedAt) / CROSS_FADE_MS);
    host.frameRenderer.setOpacityRegion(hole && !keyRect && opacity > 0 ? { rect: hole, opacity } : null);
    host.frameRenderer.setTransparentRect(hole && !keyRect && opacity <= 0 ? hole : null);
    canvas.style.display = (hole || keyRect) && live ? 'block' : 'none';
    host.invalidate();
  };

  const setHole = (rect: FrameRect | null, reason = 'state-update') => {
    const next = enabled ? rect : null;
    if (!next) nativeDrawQueue.length = 0;
    if (JSON.stringify(next) === JSON.stringify(hole)) return;
    hole = next;
    changePresentation(next ? 'hd' : 'original', reason);
    syncUiVisibility();
    if (!hole) requestPassthrough(0);
    present();
  };

  const tacticalRect = (): FrameRect | null => {
    const size = host.frameSize();
    if (!size) return null;
    const override = params.get('hd-rect')?.split(',').map(Number);
    if (override?.length === 4 && override.every(Number.isFinite)) {
      const [x, y, width, height] = override as [number, number, number, number];
      return { x, y, width, height };
    }
    return { x: 0, y: 0, width: size.width - SIDEBAR_WIDTH, height: size.height - COMMAND_BAR_HEIGHT };
  };

  const showHd = (reason: string, fade = false) => {
    if (stopped || !enabled || nativeDialogSurface) return false;
    const rect = tacticalRect();
    if (!rect) return false;
    if (fade && passthroughFlags && passthroughConfirmed !== 0) {
      // Installing the validated passthrough patches with zero flags leaves every original pixel intact.
      // Unsupported runtimes and transient install failures must never begin a fade that could lose overlays.
      requestPassthrough(0);
      return false;
    }
    if (fade) {
      fadeStartedAt = performance.now();
      fadeFinished = false;
      timeline.fadeStartedAt = fadeStartedAt;
    }
    setHole(rect, reason);
    if (fadeFinished) requestPassthrough(passthroughFlags);
    return true;
  };
  const hideForUnavailableState = (reason: string) => {
    if (!native) {
      setHole(null, reason);
      return;
    }
    if (hole || passthroughRequest) {
      hidePending ??= { at: performance.now(), reason };
      // A later explicit failure supersedes an earlier ordinary missing-publication wait.
      if (reason === 'state-reader-error' || reason === 'state-apply-error') hidePending.reason = reason;
    }
  };
  const recoverOriginal = (reason: string, notice = recoveryNotice) => {
    hidePending = null;
    recoveryText = notice;
    setHole(null, reason);
    requestPassthrough(0);
    changePresentation('original', reason);
    if (!nativeBattleSurface || nativeDialogSurface || recoveringState) return;
    recoveringState = true;
    recoveryOriginalFrameSeen = false;
    // A read begun before the recovery can complete late with the old image. The next poll must own its state.
    battleEpoch++;
    latestState = null;
    pushed = null;
    stateMap = null;
    stateFrame = 0;
    revealed = false;
    fadeStartedAt = null;
    fadeFinished = false;
    ui?.update(null);
    if (live) live.outOfSight = true;
    syncPreparationNotice();
  };
  const checkUnavailableState = (reason: string) => {
    const now = performance.now();
    if (reason === 'state-reader-error' || reason === 'state-apply-error') {
      recoverOriginal(reason);
      return;
    }
    if (healthPending || now - healthCheckedAt < STATE_HIDE_HOLD_MS || recoveringState) return;
    readHealth(now, (health) => {
      const unreadableSince = health?.unreadableSinceEpochMs;
      // A late or incomplete capture is not an unreadable game. Keep the last complete scene drawing while
      // subscriptions catch up; only a confirmed persistent read fault, or a capture that has stopped catching up,
      // may replace it with the original.
      if (typeof unreadableSince === 'number' && sinceEpoch(unreadableSince) >= STATE_HIDE_HOLD_MS)
        recoverOriginal(reason);
      else if (captureStarvedNow(health)) recoverOriginal('capture-starved', capacityNotice);
    });
  };
  const sinceEpoch = (epochMs: number) => performance.timeOrigin + performance.now() - epochMs;
  const captureStarvedNow = (health: NativeRenderHealth | undefined) => {
    const incompleteSince = health?.incompleteSinceEpochMs;
    return typeof incompleteSince === 'number' && sinceEpoch(incompleteSince) >= CAPTURE_STARVED_MS;
  };
  /**
   * Read the native render health once (one at a time, at most HEALTH_TIMEOUT_MS) and hand it to `use` while the
   * same battle, without a newer complete state, is still on the native battlefield.
   */
  const readHealth = (now: number, use: (health: NativeRenderHealth | undefined) => void) => {
    if (typeof host.vm.getDiagnostics !== 'function') return;
    healthPending = true;
    healthCheckedAt = now;
    const epoch = battleEpoch;
    const serial = completeStateSerial;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('native health report timed out')), HEALTH_TIMEOUT_MS);
    });
    void Promise.race([host.vm.getDiagnostics('usage'), timeout])
      .then((diagnostics) => {
        if (
          stopped ||
          epoch !== battleEpoch ||
          serial !== completeStateSerial ||
          !enabled ||
          !nativeBattleSurface ||
          nativeDialogSurface
        )
          return;
        use(diagnostics.native?.renderHealth as NativeRenderHealth | undefined);
      })
      .catch(() => {
        // Session termination owns the game-closed notice. A failed diagnostic is not a mirror fault diagnosis.
      })
      .finally(() => {
        if (timer !== null) clearTimeout(timer);
        healthPending = false;
      });
  };
  /** Before the first HD frame nothing is hidden, so the preparation notice asks after a starved capture itself. */
  const probeCaptureWhilePreparing = (now: number) => {
    if (!awaitingReveal() || recoveringState) {
      awaitingRevealSince = null;
      return;
    }
    awaitingRevealSince ??= now;
    if (healthPending || now - awaitingRevealSince < CAPTURE_STARVED_MS || now - healthCheckedAt < CAPTURE_PROBE_MS)
      return;
    readHealth(now, (health) => {
      const starved = captureStarvedNow(health);
      if (starved === captureStarved) return;
      captureStarved = starved;
      syncPreparationNotice();
    });
  };
  const onGameFrame = (picture: VmFrame) => {
    if (stopped) return;
    if (native) {
      nativeDialogSurface = picture.menuVisible === true;
      if (nativeDialogSurface) {
        // Dialogs keep the battle's video mode. Their native background and
        // question text must be opaque immediately, without the missing-state
        // grace period or the keyed battlefield's trailing frame.
        hidePending = null;
        setHole(null, 'native-dialog-surface');
        if (passthroughEverRequested) requestPassthrough(0);
        keyRect = null;
        keyUntil = 0;
        present();
      }
      const battleSurface = picture.width > 800 || picture.height > 600;
      if (battleSurface) {
        if (!nativeBattleSurface) {
          battleEpoch++;
          nativeDrawQueue.length = 0;
        }
        nativeMenuSurface = false;
        timeline.firstBattleFrameAt ??= performance.now();
        nativeBattleSurface = true;
      } else if (nativeBattleSurface && picture.width === 800 && picture.height === 600) {
        battleEpoch++;
        nativeBattleSurface = false;
        nativeMenuSurface = true;
        hidePending = null;
        recoveringState = false;
        recoveryOriginalFrameSeen = false;
        captureStarved = false;
        if (isRecoveryNotice(published)) publish(null);
        setHole(null, 'menu-video-mode');
        requestPassthrough(0);
        // This actual unkeyed menu picture has already replaced every trailing keyed battlefield frame.
        keyRect = null;
        keyUntil = 0;
        present();
        // A confirmed menu surface ends the match, including a short one whose successor has a larger frame
        // number. Keep GPU assets but never carry its revealed state or last pushed picture into another match.
        revealed = false;
        fadeStartedAt = null;
        fadeFinished = false;
        matchMap = null;
        matchFrame = 0;
        stateMap = null;
        stateFrame = 0;
        latestState = null;
        pushed = null;
        prematch = true;
        warmed = false;
        if (live) live.outOfSight = true;
        timeline = emptyTimeline(null);
        changePresentation('original', 'menu-video-mode');
      }
      syncPreparationNotice();
    }
    if (!picture.rgb565) return;
    const rect = tacticalRect();
    if (!rect) return;
    // Both runtimes acknowledge the configuration write before a rendered frame applies it. Keep the full HD
    // hole until an actual key pixel proves the switch; otherwise an older opaque frame briefly covers HD again.
    // Sparse game overlays may occupy a sample; the other positions stay key-coloured without scanning the frame.
    for (const y of [0.25, 0.5, 0.75]) {
      for (const x of [0.25, 0.5, 0.75]) {
        const px = Math.floor(rect.x + rect.width * x);
        const py = Math.floor(rect.y + rect.height * y);
        if (picture.rgb565[py * picture.width + px] === RENDER_PASSTHROUGH_KEY_RGB565) {
          if (passthroughRequest && passthroughAcceptedAt !== null) {
            keyFrameAt = performance.now();
            present();
          }
          return;
        }
      }
    }
    if (native && !passthroughRequest) {
      // This complete original frame supersedes queued keyed frames. Retire the old HD tail immediately.
      if (recoveringState && !nativeDialogSurface) recoveryOriginalFrameSeen = true;
      if (keyRect) {
        keyRect = null;
        keyUntil = 0;
        present();
      }
    }
  };

  /** `mapId` is the key; `mapName` is the game's own spelling, for the cache URL and for messages. */
  const load = (mapId: string, mapName: string) => {
    if (loading === mapId || performance.now() < (failed.get(mapId) ?? -Infinity)) return;
    loading = mapId;
    if (timeline.map !== mapId) timeline = emptyTimeline(mapId);
    timeline.loadAt ??= performance.now();
    const look = params.get('hd-look');
    const preset: LookPreset | undefined =
      look === 'faithful' || look === 'golden' || look === 'cinematic' ? look : undefined;
    const projectionDir = params
      .get('hd-vproj')
      ?.trim()
      .replace(/^\/+|\/+$/g, '');
    void Promise.all([
      import('../../../../packages/hd-renderer/src/live/liveView'),
      preset ? import('../../../../packages/hd-renderer/src/HdRenderer') : null,
    ])
      .then(async ([{ LiveView }, renderer]) => {
        // A stopped bridge must not create a GPU device for its detached canvas.
        if (stopped) return null;
        const timeOfDay = params.has('hd-time') ? Number(params.get('hd-time')) : undefined;
        // A preset's suggested hour stages day maps only: dusk and night maps keep their own [Lighting] hour.
        const dayHour = preset && renderer ? renderer.LOOK_PRESETS[preset].hour : undefined;
        const view = await LiveView.create(canvas, {
          mapBase: `/hd-cache/${encodeURIComponent(mapName)}`,
          libraryBase: '/hd-cache/_library',
          // Without hd-time, the map's own [Lighting] decides day, dusk or night (a preset's hour applies to day maps).
          ...(timeOfDay !== undefined ? { timeOfDay } : {}),
          ...(dayHour !== undefined ? { dayHour } : {}),
          ...parseWeatherParams(params, { weather: 'hd-weather', intensity: 'hd-weather-intensity' }),
          // hd-fx=enhanced: the remaster's modern effects around the engine's own anims (default: faithful).
          effects: params.get('hd-fx') === 'enhanced' ? 'enhanced' : 'faithful',
          nativeDetail: params.get('hd-native-detail') === 'mirror' ? 'mirror' : 'ignore',
          // Development opt-in: retain the default effect cards unless explicitly selected.
          volumetricEffects: params.get('hd-fxvol') === 'ray' ? 'ray' : 'off',
          // hd-water=enhanced: the remaster's modern water (default: the earlier HD water).
          water: params.get('hd-water') === 'enhanced' ? 'enhanced' : 'classic',
          // hd-glints=off: leave out the engine's ore/gem glints; hd-sparkle=0..1: the HD star twinkle on crystals.
          ...(params.get('hd-glints') === 'off' ? { oreGlints: false } : {}),
          ...(params.has('hd-sparkle') && Number.isFinite(Number(params.get('hd-sparkle')))
            ? { crystalSparkle: Number(params.get('hd-sparkle')) }
            : {}),
          ...(params.get('hd-vlook') === 'remaster' ? { voxelLook: 'remaster' } : {}),
          ...(projectionDir && !/\.\.|[\\:]/.test(projectionDir)
            ? { voxelProjection: `/hd-cache/${projectionDir}` }
            : {}),
        });
        if (preset && renderer) {
          renderer.applyLookPreset(view.hd.settings, preset);
          view.hd.applySettings();
        }
        if (topEffects) view.hd.enableTopEffects();
        // A watched view never waits for a pipeline compiler: what is new appears a few frames later instead of the
        // whole picture standing still (?hd-pipelines=sync keeps three's own behaviour).
        if (params.get('hd-pipelines') !== 'sync') view.hd.enableAsyncPipelines();
        return view;
      })
      .then((view) => {
        if (!view) return;
        // Stopped, or superseded by a load for another map while this one was in flight.
        if (stopped || loading !== mapId) return view.dispose();
        diagnostics?.cancelFrameCapture('HD view replaced');
        live?.dispose();
        live = view;
        liveMap = mapId;
        failed.delete(mapId);
        pushed = null;
        nativeDrawQueue.length = 0;
        upcomingKey = '';
        lastLayout = '';
        appliedBuffer = null;
        pendingBuffer = null;
        governor =
          params.get('hd-governor') === '0'
            ? null
            : new QualityGovernor({
                tiers: view.hd.qualityTiers,
                budgetMs: FRAME_BUDGET_MS,
                overFactor: FRAME_BUDGET_MARGIN,
              });
        // Out of sight until the match it is for has been drawn completely (see tick).
        view.outOfSight = true;
        // Its first frame is drawn at once, whatever it reports before it has drawn anything.
        hiddenTicks = HIDDEN_IDLE_TICKS;
        revealed = false;
        warmed = false;
        if (timeline.map !== mapId) timeline = emptyTimeline(mapId);
        timeline.readyAt = performance.now();
        if (stateMap === null || (stateMap === mapId && latestState?.objects.length === 0)) {
          // Even an empty profile can prepare the map and generic passes before any starting units are known.
          const types = readWarmTypes(storage, mapId, view.theater) ?? [];
          view.warm(types);
          warmed = true;
          timeline.warmAt = performance.now();
          timeline.warmTypes = types.length;
        }
        const frameSize = host.frameSize();
        loadingFrame = frameSize ? `${frameSize.width}x${frameSize.height}` : null;
        if (fallback?.map === mapId) clearFallback();
        console.info(`[HD] live view ready for ${mapName}`);
      })
      .catch((error) => {
        if (stopped) return;
        failed.set(mapId, performance.now() + LOAD_RETRY_MS);
        console.warn(
          `[HD] no HD view for ${mapName}; trying again in ${LOAD_RETRY_MS / 1000} s or at the next match on it ` +
            `(build its cache with: pnpm hd:prepare -- --map ${mapName})`,
          error,
        );
        // Say so on screen while the match on this map is still the current one, once per match (not per retry).
        if (stateMap !== mapId || fallback?.map === mapId) return;
        fallback = { map: mapId, frame: stateFrame, until: Infinity };
        // The loader's MapCacheMissingError: the map was never prepared, as opposed to a cache that fails to load.
        const missing = (error as { name?: unknown } | null)?.name === 'MapCacheMissingError';
        if (enabled)
          publish(
            missing
              ? t('高清画面未启用：地图 {0} 没有高清素材，显示原版画面', mapName)
              : t('高清画面加载失败：地图 {0} 显示原版画面，稍后自动重试', mapName),
          );
      })
      .finally(() => {
        if (loading === mapId) loading = null;
      });
  };

  const prepareEarly = (now: number) => {
    if (
      !enabled ||
      stateMap !== null ||
      !host.vm.getRenderPreparation ||
      preparationAsking ||
      now - preparationAskedAt < 500
    )
      return;
    preparationAskedAt = now;
    preparationAsking = true;
    void host.vm
      .getRenderPreparation()
      .then((hint) => {
        if (stopped || !enabled || !hint || stateMap !== null) return;
        const name = hint.map.fileName.replace(/\.[^.]+$/, '');
        const key = name.toLowerCase();
        preparationMap = key;
        // A validated hint can still name the previous scenario. It only spends preparation work;
        // a real complete battle snapshot remains the sole authority for showing the view.
        if (liveMap !== key || !live) load(key, name);
      })
      .catch(() => undefined)
      .finally(() => {
        preparationAsking = false;
      });
  };

  const onState = (state: GameRenderState | null) => {
    // A reply that was already in flight when the bridge stopped belongs to a session being torn down.
    if (stopped) return;
    // A retained native mirror can outlive Abort/score's switch back to the menu video mode.
    if (nativeMenuSurface || nativeDialogSurface) state = null;
    if (state?.map && state.view) {
      completeStateSerial++;
      // A complete state: the capture is keeping up again (the preparation notice says so on the next frame).
      captureStarved = false;
    }
    if (!state && native && nativeBattleSurface && !nativeDialogSurface && revealed && !recoveringState) {
      // Keep the complete battlefield and sidebar together, including their map identity and draw queue.
      // Null means no new coherent publication; it must not erase the last one or flash the original art.
      pollFailed = false;
      hideForUnavailableState('state-unavailable');
      return;
    }
    const receivedAt = performance.now();
    pollFailed = false;
    diagnostics?.state(state);
    if (state?.map) host.stateReceived?.(state.frame);
    latestState = state;
    inBattle = !!state?.map;
    ui?.update(state?.sidebar ?? null);
    if (state?.sidebar && state.sidebar.side >= 0) menuSide = state.sidebar.side;
    const mapName = state?.map?.fileName?.replace(/\.[^.]+$/, '') ?? null;
    const mapId = mapName?.toLowerCase() ?? null;
    // A new match on a map (coming from another map or from outside a battle, or the logic frame starting over) may
    // find a cache built since its last failed load; if not, it is told again that the original picture is shown.
    if (state && mapId && (mapId !== stateMap || state.frame < stateFrame)) {
      failed.delete(mapId);
      clearFallback();
    }
    // Another match (another map, or the logic frame starting over): its view, the same one when the map is the
    // same, starts out of sight again. A match that merely had no snapshot for a while (an in-game menu owned the
    // screen) goes on where it was: its view is complete, and hiding it would flash the original picture.
    if (state && mapId && (mapId !== matchMap || state.frame < matchFrame)) {
      const firstBattleFrameAt = matchMap === null ? timeline.firstBattleFrameAt : null;
      setHole(null, 'new-match');
      fadeStartedAt = null;
      fadeFinished = false;
      revealed = false;
      recoveringState = false;
      recoveryOriginalFrameSeen = false;
      if (isRecoveryNotice(published)) publish(null);
      warmed = false;
      matchTypes.clear();
      collectedAt = -Infinity;
      stallMonitor?.newMatch();
      if (live) {
        live.outOfSight = true;
        // Another match starts with everything; what it can afford shows once it is on screen.
        governor?.reset();
        live.hd.setQualityTier(0);
      }
      pacer?.reset();
      paceLast = null;
      const prepared = timeline.map === mapId ? timeline : null;
      timeline = {
        ...emptyTimeline(mapId),
        loadAt: prepared?.loadAt ?? null,
        readyAt: prepared?.readyAt ?? null,
        warmAt: prepared?.warmAt ?? null,
        warmTypes: prepared?.warmTypes ?? 0,
        warmSettledAt: prepared?.warmSettledAt ?? null,
      };
      timeline.firstBattleFrameAt = firstBattleFrameAt;
      if (liveMap === mapId && live) timeline.readyAt ??= performance.now();
    }
    if (state && mapId) {
      timeline.firstStateAt ??= performance.now();
      matchMap = mapId;
      matchFrame = state.frame;
    }
    if (!mapId) clearFallback();
    stateMap = mapId;
    stateFrame = state?.frame ?? 0;
    if (fallback && fallback.until === Infinity && stateFrame > fallback.frame)
      fallback.until = performance.now() + NOTICE_MS;
    if (!state || !mapId || !mapName || !state.view) {
      nativeDrawQueue.length = 0;
      hideForUnavailableState(
        !state ? 'state-unavailable' : !mapId || !mapName ? 'map-unavailable' : 'view-unavailable',
      );
      return;
    }
    hidePending = null;
    if (liveMap !== mapId || !live) {
      setHole(null, 'view-preparing');
      load(mapId, mapName);
      return;
    }
    const now = performance.now();
    prematch = state.objects.length === 0;
    // Nothing moves behind a loading screen: prepare as fast as possible. Once the scenario has objects the game's
    // own picture is about to be (or is) on screen, and the view prepares at a pace that leaves it its frames.
    live.newArtPerFrame = prematch ? Infinity : HIDDEN_NEW_ART_PER_FRAME;
    live.hiddenUploadPixels = prematch ? Infinity : HIDDEN_UPLOAD_PIXELS;
    if (!prematch) timeline.objectsAt ??= now;
    if (state.frame > 0) timeline.matchAt ??= now;
    if (prematch && !revealed && !warmed) {
      // The scenario is still loading: hand the view what the last match on this map (or theater) showed.
      warmed = true;
      const types = readWarmTypes(storage, mapId, live.theater) ?? [];
      live.warm(types);
      timeline.warmAt = now;
      timeline.warmTypes = types.length;
    }
    // A match snapshot ends the preparation; before the match has objects, a prepared view keeps its list.
    if (state !== pushed && !(prematch && timeline.warmAt !== null && !revealed)) {
      if (native && enabled && revealed && fadeFinished && hole && !recoveringState) {
        const newest = nativeDrawQueue.at(-1);
        if (newest?.state !== state) {
          // A newer publication of one logic frame can still change its view, selection or discrete effects.
          if (newest?.state.frame === state.frame) nativeDrawQueue[nativeDrawQueue.length - 1] = { state, receivedAt };
          else nativeDrawQueue.push({ state, receivedAt });
          if (nativeDrawQueue.length > 2) nativeDrawQueue.shift();
        }
      } else {
        nativeDrawQueue.length = 0;
        live.push(toSnapshot(state));
        pushed = state;
      }
    }
    if (!topEffects && live.hd.topEffectsEnabled) {
      topEffects = true;
      writeTopEffects(storage);
    }
    const upcoming = sidebarUpcomingTypes(state.sidebar);
    if (upcoming.join() !== upcomingKey) {
      upcomingKey = upcoming.join();
      live.prepare(upcoming);
    }
    // The opening is read at every snapshot: the starting units arrive in steps, and some are gone within seconds
    // (an MCV that deploys at once).
    if (
      !prematch &&
      state.frame <= WARM_COLLECT_UNTIL_FRAME &&
      (state.frame < WARM_COLLECT_FRAMES || state.frame - collectedAt >= WARM_COLLECT_FRAMES)
    ) {
      collectedAt = state.frame;
      let grew = false;
      for (const type of live.warmTypes()) {
        const key = warmTypeKey(type);
        if (matchTypes.has(key) || matchTypes.size >= WARM_TYPES_LIMIT) continue;
        matchTypes.set(key, type);
        grew = true;
      }
      if (grew) writeWarmTypes(storage, mapId, live.theater, [...matchTypes.values()]);
    }
    // A recovered snapshot resumes the same complete HD view without a second automatic fade.
    if (revealed) {
      showHd('state-restored');
    } else setHole(null, 'view-preparing');
  };

  /**
   * Whether the view draws out of sight this tick: it belongs to the current map and has not been shown in this
   * match. That is the time to fetch, build and compile, behind the game's loading screen or its original picture.
   */
  const preparing = () =>
    enabled &&
    !!live &&
    !revealed &&
    !pollFailed &&
    (stateMap !== null ? liveMap === stateMap : liveMap === preparationMap);

  /** Show the view once the match runs and the frame just drawn (and the ones before it) lacked nothing. */
  const reveal = (now: number) => {
    if (!live || !preparing() || prematch || stateFrame < 1 || !pushed) return;
    if (recoveringState && !recoveryOriginalFrameSeen) return;
    if (live.settledFrames < REVEAL_SETTLED_FRAMES) return;
    if (!live.localArtComplete) {
      if (latestState?.localHouse !== undefined && latestState.localHouse >= 0 && live.loadingArt() === 0)
        publish(t('高清素材不完整，继续显示原版画面'));
      return;
    }
    if (!showHd(recoveringState ? 'state-restored' : 'view-settled', true)) return;
    revealed = true;
    recoveringState = false;
    publish(null);
    live.outOfSight = false;
    timeline.revealedAt = now;
    timeline.revealReason = 'settled';
    timeline.revealLoading = live.loadingArt();
    diagnostics?.reveal();
  };

  /** Full snapshots are only worth their cost while the HD view can show them (null replies are cheap). */
  const pollInterval = () =>
    enabled && uiEnabled && ui && inBattle && !pollFailed && (liveMap !== stateMap || !live)
      ? 50
      : !enabled || pollFailed || (stateMap !== null && (liveMap !== stateMap || !live))
        ? IDLE_POLL_MS
        : // A view held below 60 frames a second needs no more snapshots than it draws frames: each one is read
          // on the emulator's thread.
          Math.max(ACTIVE_POLL_MS, pacer ? 1000 / pacer.rate - 2 : 0);

  const poll = (now: number) => {
    polling = true;
    lastPollAt = now;
    const epoch = battleEpoch;
    host.vm
      .getRenderState()
      .then(
        (state) => {
          if (epoch === battleEpoch) onState(state);
        },
        () => {
          if (stopped || epoch !== battleEpoch) return;
          pollFailed = true;
          latestState = null;
          nativeDrawQueue.length = 0;
          ui?.update(null);
          hideForUnavailableState('state-reader-error');
        },
      )
      .catch((error) => {
        if (stopped || epoch !== battleEpoch) return;
        pollFailed = true;
        latestState = null;
        nativeDrawQueue.length = 0;
        ui?.update(null);
        hideForUnavailableState('state-apply-error');
        console.warn('[HD] could not apply the render state', error);
      })
      .finally(() => {
        polling = false;
        if (native) scheduleNativePoll();
      });
  };

  /**
   * About once a second while the view is shown: what the game reached against what its speed setting asks for,
   * for the pacer. One request at a time; a VM that cannot answer leaves the pace where it is.
   */
  const samplePace = (now: number) => {
    if (!pacer || paceMode.kind !== 'auto' || paceAsking || now - paceAskedAt < PACE_SAMPLE_MS) return;
    if (typeof (native ? host.vm.getGamePerformance : host.vm.getDiagnostics) !== 'function') return;
    paceAsking = true;
    paceAskedAt = now;
    const request = native
      ? host.vm.getGamePerformance().then((game) => ({
          game,
          sampledAtMs: game?.sampledAtMs ?? now,
          running: !!game && game.status !== 'inactive',
          waitMs: null,
        }))
      : host.vm.getDiagnostics('usage').then((diagnostics) => ({
          game: diagnostics.game,
          sampledAtMs: diagnostics.sampledAtMs,
          running: diagnostics.phase === 'running',
          waitMs: diagnostics.usage?.guestWaitMs ?? null,
        }));
    request
      .then(
        (sample) => {
          if (stopped) return;
          const game = sample.game;
          // Frame 0 is the scenario still loading; outside a running battle there is no rate to judge.
          const running = sample.running && !!game && game.status !== 'inactive' && game.frame > 0;
          const previous = paceLast;
          paceLast = running ? { atMs: sample.sampledAtMs, frame: game.frame, waitMs: sample.waitMs } : null;
          if (!previous || !paceLast || !game || paceLast.frame < previous.frame) return;
          const intervalMs = paceLast.atMs - previous.atMs;
          // A window far longer than the period (a hidden tab, a stopped guest) is not one stretch of play.
          if (!(intervalMs > 0) || intervalMs > PACE_SAMPLE_MS * 3) return;
          pacer.sample({
            intervalMs,
            rate: ((paceLast.frame - previous.frame) * 1000) / intervalMs,
            targetRate: game.targetFps,
            idleShare:
              paceLast.waitMs !== null && previous.waitMs !== null
                ? Math.min(1, Math.max(0, (paceLast.waitMs - previous.waitMs) / intervalMs))
                : null,
          });
        },
        () => {
          paceLast = null;
        },
      )
      .finally(() => {
        paceAsking = false;
      });
  };

  // One request per draw interval drifts behind both the game and the display when timers round up or drawing
  // delays their turn. A shown native view gets a request opportunity between draws as well, so its asynchronous
  // reply can arrive before the next draw. The outstanding-request guard still bounds work to one RPC.
  const nativePollInterval = () =>
    !enabled
      ? IDLE_POLL_MS
      : hole
        ? Math.min(NATIVE_POLL_MS, (pacer?.pacedIntervalMs ?? NATIVE_POLL_MS) / 2)
        : NATIVE_POLL_MS;

  const scheduleNativePoll = () => {
    if (stopped || nativePollTimer !== null) return;
    const interval = nativePollInterval();
    // Count from the request's start, so decoding time does not add another
    // complete poll interval. The previous request has finished before scheduling.
    const delay = Math.max(0, lastPollAt + interval - performance.now());
    const timer = setTimeout(() => {
      if (nativePollTimer !== timer) return;
      nativePollTimer = null;
      if (stopped) return;
      const now = performance.now();
      // Timer delays are rounded by the browser. A callback already queued when an animation frame took its
      // turn must also respect the latest request's actual start, without overlapping or catching up in bursts.
      if (polling) return;
      if (now - lastPollAt < nativePollInterval()) {
        scheduleNativePoll();
        return;
      }
      poll(now);
      if (hole) samplePace(now);
    }, Math.ceil(delay));
    nativePollTimer = timer;
  };

  /**
   * The interval between two drawn frames as the frame-time safeguard should judge it. A view the pacer holds to
   * fewer frames than the safeguard's budget (30 a second while the game is behind, 55 on a 165 Hz display) is on
   * time when it keeps that pace: its intervals are scaled to the budget. The same applies to a display below
   * 60 Hz even when every refresh is drawn; its startup cadence is not a rendering deficit.
   */
  const judgedInterval = (intervalMs: number) => {
    const paced = pacer && pacer.stride > 1 ? pacer.pacedIntervalMs : (host.displayRefreshMs?.() ?? null);
    return paced !== null && paced > FRAME_BUDGET_MS ? (intervalMs * FRAME_BUDGET_MS) / paced : intervalMs;
  };

  const layout = () => {
    const shown = hole ?? keyRect;
    // Out of sight the view is laid out as it will be shown, so its buffers and pipelines are the final ones.
    const rect = shown ?? (preparing() ? tacticalRect() : null);
    const size = host.frameSize();
    if (!rect || !size || !live) return;
    // Cover exactly the tactical rectangle of the (scaled) game canvas, on whole device pixels: the drawing buffer then
    // has one pixel per device pixel and the compositor shows it as it is. A CSS box that is a fraction of a device
    // pixel larger than its buffer would be resampled, which softens the whole picture.
    const box = devicePixelBox(host.screen, size, window.devicePixelRatio || 1, rect);
    const budget = Math.min(1, Math.sqrt(MAX_BUFFER_PIXELS / (box.width * box.height)));
    let buffer: HdShownLayout = [
      Math.max(1, Math.round(box.width * budget)),
      Math.max(1, Math.round(box.height * budget)),
      rect.width,
      rect.height,
    ];
    // Behind the loading screen the game is still in the loading screen's video mode: a view laid out for it would
    // build its post passes for a size it is never shown at, and again when the match's first frame arrives. Until
    // the frame size changes (or the match runs), prepare for the layout of the last match instead.
    if (!shown && shownLayout && stateFrame < 1 && `${size.width}x${size.height}` === loadingFrame)
      buffer = shownLayout;
    // Follow the window immediately through CSS, retaining the current picture throughout a resize drag.
    Object.assign(canvas.style, box.style);
    const key = buffer.join();
    if (key === lastLayout) {
      pendingBuffer = null;
      // First reveal can reuse a size prepared out of sight; remember it even without a buffer allocation.
      if (shown && !buffer.every((value, index) => value === shownLayout?.[index])) {
        shownLayout = buffer;
        writeShownLayout(storage, buffer);
      }
      return;
    }
    // Only a display-size change waits. A new scene or game video mode needs the matching camera immediately,
    // and hidden preparation must compile at its target size before the picture is revealed.
    if (shown && appliedBuffer && buffer[2] === appliedBuffer[2] && buffer[3] === appliedBuffer[3]) {
      const now = performance.now();
      if (pendingBuffer?.key !== key) pendingBuffer = { key, since: now };
      if (now - pendingBuffer.since < 200) return;
    }
    pendingBuffer = null;
    lastLayout = key;
    appliedBuffer = buffer;
    // What the view is shown with is what the next loading screen prepares for.
    if (shown && !buffer.every((value, index) => value === shownLayout?.[index])) {
      shownLayout = buffer;
      writeShownLayout(storage, buffer);
    }
    live.resizePixels(...buffer);
  };

  const tick = (frameTime?: number) => {
    if (stopped) return;
    frame = requestAnimationFrame(tick);
    const now = performance.now();
    stallMonitor?.frame(now);
    prepareEarly(now);
    if (native) probeCaptureWhilePreparing(now);
    syncPreparationNotice();
    if (
      native &&
      enabled &&
      nativeBattleSurface &&
      !nativeDialogSurface &&
      revealed &&
      polling &&
      now - lastPollAt >= STATE_REQUEST_STALL_MS
    )
      checkUnavailableState('state-reader-timeout');
    if (hidePending && now - hidePending.at >= STATE_HIDE_HOLD_MS) {
      const reason = hidePending.reason;
      checkUnavailableState(reason);
    }
    if (hole && !fadeFinished && fadeStartedAt !== null) {
      if (now - fadeStartedAt >= CROSS_FADE_MS) {
        fadeFinished = true;
        timeline.fadeFinishedAt = now;
        syncUiVisibility();
        requestPassthrough(passthroughFlags);
      }
      present();
    } else if (hole && fadeFinished) requestPassthrough(passthroughFlags);
    else if (passthroughEverRequested && passthroughRequest === 0 && passthroughConfirmed !== 0) requestPassthrough(0);
    // Take a due native request before drawing can delay its timer. The independent timer still delivers states
    // without display callbacks or ready art; both paths share the same minimum interval and outstanding request.
    if (native && enabled && !polling && now - lastPollAt >= nativePollInterval()) {
      if (nativePollTimer !== null) clearTimeout(nativePollTimer);
      nativePollTimer = null;
      poll(performance.now());
      if (hole) samplePace(now);
    }
    if (!native && !polling && now - lastPollAt >= pollInterval()) poll(now);
    if (!hole && keyRect && now >= keyUntil) present();
    if (fallback && now >= fallback.until) publish(null);
    if (live && (hole || keyRect)) {
      // The display frame's own time is steady from frame to frame; the clock read inside the callback is not.
      const displayTime = typeof frameTime === 'number' ? frameTime : now;
      if (!pacer || pacer.due(displayTime)) {
        layout();
        // Frames of the shown view feed the safeguard: the interval between two of them is what the player sees. It
        // is taken between display frames, as the pacer takes it: a callback that runs a few ms late because the
        // main thread was busy is not a frame that reached the screen late.
        if (governor && shownAt !== null) live.hd.setQualityTier(governor.frame(judgedInterval(displayTime - shownAt)));
        shownAt = displayTime;
        if (native && enabled && revealed && fadeFinished && hole) {
          const next = nativeDrawQueue.shift();
          if (next) {
            // Preserve actual arrival time for LiveView interpolation instead of restarting it at this draw.
            try {
              live.push(toSnapshot(next.state), next.receivedAt);
              pushed = next.state;
            } catch (error) {
              nativeDrawQueue.length = 0;
              pollFailed = true;
              latestState = null;
              ui?.update(null);
              hideForUnavailableState('state-apply-error');
              console.warn('[HD] could not apply the render state', error);
            }
          }
        }
        live.render();
        diagnostics?.draw(enabled && revealed && !!hole);
        shownFrames++;
        if (enabled && revealed && hole) host.presented?.(pushed?.frame ?? stateFrame);
        publishTier(live.hd.quality);
      }
      // Not while the view is being switched off (the key colour's trail): the game repaints its whole picture then.
      if (!native && hole) samplePace(now);
    } else if (live && preparing()) {
      shownAt = null;
      publishTier(null);
      // Draw out of sight: every frame while art is arriving or the match already runs, else now and then.
      const complete = live.settledFrames >= REVEAL_SETTLED_FRAMES;
      if (complete && timeline.warmAt !== null) timeline.warmSettledAt ??= now;
      if (!complete || stateFrame >= 1 || ++hiddenTicks >= HIDDEN_IDLE_TICKS) {
        hiddenTicks = 0;
        layout();
        live.render();
        diagnostics?.draw(false);
      }
      reveal(now);
    } else {
      shownAt = null;
      publishTier(null);
    }
  };
  frame = requestAnimationFrame(tick);
  if (native) poll(performance.now());

  // Console handle for A/B checks: __hdBridge.toggle() switches between the HD view and the original picture.
  const handle = {
    ...(diagnostics ? { diagnostics: diagnostics.handle } : {}),
    toggle() {
      if (stopped) return enabled;
      enabled = !enabled;
      nativeDrawQueue.length = 0;
      if (native && !polling) {
        if (nativePollTimer !== null) clearTimeout(nativePollTimer);
        nativePollTimer = null;
        scheduleNativePoll();
      }
      syncUiVisibility();
      if (!enabled) {
        hidePending = null;
        // Native preflight can already be enabled before a hole exists, so setHole(null) may be a no-op.
        requestPassthrough(0);
        setHole(null, 'commanded-toggle');
        changePresentation('original', 'commanded-toggle');
        // The original picture was asked for: nothing to explain.
        publish(null);
      }
      return enabled;
    },
    ui: {
      get state() {
        // Return a detached copy so console/test drivers cannot mutate the live bridge's retained snapshot.
        return latestState?.sidebar ? structuredClone(latestState.sidebar) : null;
      },
      get enabled() {
        return uiVisible() && !!ui;
      },
      toggle() {
        if (stopped) return false;
        uiEnabled = !uiEnabled;
        syncUiVisibility();
        return uiVisible() && !!ui;
      },
    },
    get live() {
      return live;
    },
    /** Presented frames that came more than 150 ms late, oldest first (the last 500; see hdStallMonitor.ts). */
    get stalls() {
      return stallMonitor?.entries() ?? [];
    },
    /** When the current match's view loaded, prepared and was shown (copy; see HdBridgeTimeline). */
    get timeline(): HdBridgeTimeline {
      return { ...timeline, transitions: structuredClone(transitions), transitionsOmitted };
    },
    /** What currently covers the tactical view; separate from whether a GPU view has finished preparing. */
    get presentation() {
      return {
        mode: presentation,
        recovering: recoveringState,
        recoveryOriginalFrameSeen,
        curtain: false,
        fading: !!hole && !fadeFinished && fadeStartedAt !== null,
        hidePending: !!hidePending,
      };
    },
    /** Native overlay passthrough: requested guest flags (0 = off) and whether the key path is in use. */
    get passthrough() {
      return { flags: passthroughRequest, unsupported: passthroughUnsupported, keyed: !!keyRect };
    },
    /**
     * Frame pacing of the shown view: the mode asked for, the level in use (0 = fastest), the rate it holds the view
     * to and how many display frames lie between two drawn ones; null with ?hd-pace=off.
     */
    get pace() {
      return pacer
        ? { mode: paceMode.kind, level: pacer.level, levels: pacer.levels, rate: pacer.rate, stride: pacer.stride }
        : null;
    },
  };
  const globals = window as unknown as { __hdBridge?: typeof handle };
  globals.__hdBridge = handle;

  const stop = () => {
    if (stopped) return;
    stopped = true;
    diagnostics?.dispose();
    cancelAnimationFrame(frame);
    if (nativePollTimer !== null) clearTimeout(nativePollTimer);
    nativePollTimer = null;
    clearFallback();
    publish(null);
    ui?.dispose();
    ui = null;
    stallMonitor?.dispose();
    stallMonitor = null;
    latestState = null;
    nativeDrawQueue.length = 0;
    hidePending = null;
    changePresentation('original', 'bridge-stopped');
    if (passthroughEverRequested) void host.vm.setTacticalPassthrough(0).catch(() => undefined);
    // Pending polls, loads and passthrough replies check `stopped`; reset the rest so nothing refers to this session.
    passthroughRequest = 0;
    hole = null;
    keyRect = null;
    keyUntil = 0;
    liveMap = null;
    loading = null;
    stateMap = null;
    pushed = null;
    revealed = false;
    matchMap = null;
    matchTypes.clear();
    host.frameRenderer.setTransparentKey(null);
    host.frameRenderer.setTransparentRect(null);
    host.frameRenderer.setOpacityRegion(null);
    live?.dispose();
    live = null;
    governor = null;
    publishTier(null);
    canvas.remove();
    host.screen.style.position = screenStyle.position;
    host.screen.style.zIndex = screenStyle.zIndex;
    if (globals.__hdBridge === handle) delete globals.__hdBridge;
  };
  const scene = (): HdBridgeScene | null => {
    const hdShown = !!live && !!hole;
    // A brief unavailable-state hold still shows the last drawn HD picture. Observation must follow the visible
    // surface, or original-picture callbacks compete with HD telemetry until the actual hole is removed.
    const state = latestState?.map ? latestState : hdShown ? pushed : null;
    if (stopped || !state?.map) return null;
    let localObjects = 0;
    for (const object of state.objects) if (object.owner === state.localHouse) localObjects++;
    return {
      map: state === latestState ? stateMap : liveMap,
      objects: state.objects.length,
      localObjects,
      hdShown,
      tier: hdShown ? live!.hd.quality : null,
      hdFrames: shownFrames,
      pace: hdShown && pacer ? pacer.rate : null,
    };
  };
  return Object.assign(stop, {
    toggle: () => handle.toggle(),
    scene,
    frame: onGameFrame,
    menuSide: () => menuSide,
    // A failed mirror does not turn a real battlefield into a menu or release its input confinement.
    battleActive: () => (inBattle || (native && nativeBattleSurface)) && !nativeDialogSurface,
    activity: () => live?.activity() ?? null,
  });
}

function toSnapshot(state: GameRenderState): LiveSnapshot {
  return {
    frame: state.frame,
    view: state.view,
    ...(state.nativeDetail !== undefined ? { nativeDetail: state.nativeDetail } : {}),
    houses: state.houses.map((house) => ({ index: house.index, colorIndex: house.colorIndex })),
    localHouse: state.localHouse,
    shroud: state.shroud,
    lighting: state.lighting,
    overlays: state.overlays,
    smudges: state.smudges,
    effects: state.effects && {
      // The view routes building layers separately; preserve native frame/alpha and attachment metadata.
      anims: state.effects.anims.filter((anim) => !anim.invisible && anim.frameCount > 0),
      bullets: state.effects.bullets
        .filter((bullet) => !bullet.inviso)
        .map(({ id, uid, x, y, z, type, frame, velocity, owner, ownerPalette }) => ({
          id,
          uid,
          x,
          y,
          z,
          type,
          frame,
          velocity,
          ...(owner !== undefined ? { owner } : {}),
          ...(ownerPalette ? { ownerPalette } : {}),
        })),
      beams: [
        ...state.effects.lasers.map(({ source, target, innerColor }) => ({
          source,
          target,
          kind: 'laser' as const,
          colour: innerColor,
        })),
        // YR draws psychic/magnetron bolts in its alternate (purple) colours, Tesla bolts in blue-white.
        ...state.effects.electricBolts.map(({ source, target, alternateColor }) => ({
          source,
          target,
          kind: 'bolt' as const,
          colour: (alternateColor ? [190, 90, 255] : [150, 200, 255]) as [number, number, number],
        })),
      ],
      radBeams: state.effects.radBeams,
      waves: state.effects.waves,
      mindControlLinks: state.effects.mindControlLinks,
      particleSystems: state.effects.particleSystems.map(({ id, uid, behavesLike, x, y, z }) => ({
        id,
        uid,
        behaviour: behavesLike,
        x,
        y,
        z,
      })),
    },
    objects: state.objects.map((object) => ({
      id: object.id,
      uid: object.uid,
      kind: object.kind,
      type: object.type,
      ...(object.imageType ? { imageType: object.imageType } : {}),
      ...(object.nativeHidden !== undefined ? { nativeHidden: object.nativeHidden } : {}),
      ...(object.translucent !== undefined ? { translucent: object.translucent } : {}),
      ...(object.tint !== undefined
        ? { tint: { light: object.tint.light, ...(object.tint.add ? { add: [...object.tint.add] } : {}) } }
        : {}),
      ...(object.underlay !== undefined ? { underlay: { ...object.underlay } } : {}),
      ...(object.cargo !== undefined ? { cargo: { ...object.cargo } } : {}),
      owner: object.owner,
      x: object.x,
      y: object.y,
      z: object.z,
      facingRaw: object.facingRaw,
      ...(object.turretFacingRaw !== undefined ? { turretFacingRaw: object.turretFacingRaw } : {}),
      ...(object.turretIndex !== undefined ? { turretIndex: object.turretIndex } : {}),
      ...(object.buildState !== undefined ? { buildState: object.buildState } : {}),
      ...(object.buildupFrame !== undefined ? { buildupFrame: object.buildupFrame } : {}),
      ...(object.buildingFrame !== undefined ? { buildingFrame: object.buildingFrame } : {}),
      ...(object.buildingDamaged !== undefined ? { buildingDamaged: object.buildingDamaged } : {}),
      ...(object.contactUid !== undefined ? { contactUid: object.contactUid } : {}),
      ...(object.dock !== undefined ? { dock: object.dock } : {}),
      ...(object.unloading !== undefined ? { unloading: object.unloading } : {}),
      ...(object.activeAnim !== undefined ? { activeAnim: object.activeAnim } : {}),
      ...(object.infantrySequence !== undefined ? { infantrySequence: object.infantrySequence } : {}),
      ...(object.sequenceFrame !== undefined ? { sequenceFrame: object.sequenceFrame } : {}),
      ...(object.infantryDrawFacingRaw !== undefined ? { infantryDrawFacingRaw: object.infantryDrawFacingRaw } : {}),
      ...(object.renderOrder !== undefined ? { renderOrder: object.renderOrder } : {}),
      ...(object.tilt !== undefined ? { tilt: object.tilt } : {}),
      health: object.health,
      isSelected: object.isSelected,
    })),
  };
}
