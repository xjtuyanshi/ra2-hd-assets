import type { VmShell } from '../../../adapter/vmShell';
import type { GameRenderSidebar, GameRenderState } from '../../../games/renderState';
import {
  RENDER_PASSTHROUGH,
  RENDER_PASSTHROUGH_ALL,
  RENDER_PASSTHROUGH_KEY_RGB565,
} from '../../../games/renderPassthrough';
import type { FrameRect, VmFrameRenderer } from './vmFrameRenderer';
import type { HdUi } from './hdUi';
import type { HdStallMonitor } from './hdStallMonitor';
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
 * A match does not start with a half-drawn battlefield. The view is created while the game shows its loading screen
 * and draws out of sight from then on; the original picture stays (no transparent rectangle, no passthrough) until
 * the match runs and the view has drawn REVEAL_SETTLED_FRAMES complete frames in a row (LiveView.settledFrames), or
 * until REVEAL_DEADLINE_MS have passed. What a match showed in its first minutes is remembered (hdWarmStore.ts) and
 * prepared during the next loading screen, so that wait is normally a few frames. Once shown, the view stays for the
 * match: art that loads later appears as it arrives.
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
}

/**
 * The frame time the shown view is held to (60 presented frames a second, also on a faster display): when frames stay
 * above it the view gives up its least visible passes tier by tier, and takes them back after a calm stretch
 * (QualityGovernor). `?hd-governor=0` keeps every pass whatever the frame rate.
 */
const FRAME_BUDGET_MS = 1000 / 60;
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
/**
 * Minimum time between two snapshot requests while the HD view shows the current map. Each request runs on the
 * emulator's thread (a snapshot whose logic frame moved on is read in full; an unchanged one comes back as the
 * identical object). About 60 Hz follows a 60 Hz display frame for frame, while 120/144 Hz displays poll every second
 * or third frame; LiveView interpolates between snapshots.
 */
const ACTIVE_POLL_MS = 15;
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
const MAX_BUFFER_PIXELS = 10_000_000;
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
 * Longest a running match keeps the original picture while the view prepares. Art that never settles (a file that
 * keeps loading, a server that went away) must not hide the HD view for a whole match: after this the view is shown
 * with what it has, as it was before this wait existed.
 */
const REVEAL_DEADLINE_MS = 20_000;
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
  /** The view replaced the original picture, and why: it was complete, or the deadline passed. */
  revealedAt: number | null;
  revealReason: 'settled' | 'deadline' | null;
  /** Art still on its way when the view was shown (0 unless the deadline passed). */
  revealLoading: number;
}

const emptyTimeline = (map: string | null): HdBridgeTimeline => ({
  map,
  loadAt: null,
  readyAt: null,
  warmAt: null,
  warmTypes: 0,
  warmSettledAt: null,
  objectsAt: null,
  matchAt: null,
  revealedAt: null,
  revealReason: null,
  revealLoading: 0,
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

/** Stops the bridge when called; `toggle` switches between the HD view and the original picture (true: HD shown). */
export type HdBridgeControl = (() => void) & { toggle(): boolean };

export function startHdBridge(host: HdBridgeHost): HdBridgeControl {
  if (host.frameRenderer.backend !== 'WebGL2') {
    // Canvas 2D draws every frame opaque: neither the key nor the transparent rectangle could show the HD view.
    console.warn('[HD] the HD bridge needs the WebGL2 frame renderer; showing the original picture');
    return Object.assign(() => undefined, { toggle: () => false });
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
  let stopped = false;
  let enabled = true;
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
  /** Since when a running match has been waiting for the view (REVEAL_DEADLINE_MS counts from here). */
  let waitingSince: number | null = null;
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
  let publishedTier: number | null = null;
  const publishTier = (tier: number | null) => {
    if (tier === publishedTier) return;
    publishedTier = tier;
    host.publishQuality?.(tier, live?.hd.qualityTiers ?? 0);
  };
  const storage = browserWarmStorage();
  /** Layout the view was last shown with (this page load or an earlier one), see `layout`. */
  let shownLayout: HdShownLayout | null = readShownLayout(storage);
  /** An earlier match showed top-layer art: views get its pass before they are shown (see readTopEffects). */
  let topEffects = readTopEffects(storage);
  /** Guest frame size when the current view finished loading: the loading screen's video mode, as a key. */
  let loadingFrame: string | null = null;
  let timeline = emptyTimeline(null);
  let published: string | null = null;
  const publish = (text: string | null) => {
    if (text === published) return;
    published = text;
    host.publishStatus?.(text);
  };
  const clearFallback = () => {
    fallback = null;
    publish(null);
  };
  // The production graph walker follows page.ts -> hdBridge.ts, so the import itself must be under DEV.
  if (import.meta.env.DEV && params.get('hd-ui') === '1') {
    void import('./hdUi')
      .then(({ startHdUi }) => {
        if (stopped) return;
        ui = startHdUi(host);
        ui.setEnabled(enabled && uiEnabled);
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
  const passthroughFlags = parsePassthroughFlags(params.get('hd-passthrough'));
  /** Only the terrain category fills the tactical view with the key colour; without it no pixel could be keyed. */
  const keyable = (passthroughFlags & RENDER_PASSTHROUGH.terrain) !== 0;
  /** Guest passthrough state: requested flags (0 = off) and whether the game accepted them. */
  let passthroughRequest = 0;
  let passthroughUnsupported = passthroughFlags === 0;
  /** Key rectangle kept for PASSTHROUGH_TRAIL_MS after switching off (see PASSTHROUGH_TRAIL_MS). */
  let keyRect: FrameRect | null = null;
  let keyUntil = 0;

  // The key programs are compiled now, not inside the frame that first shows the HD view.
  if (keyable && !passthroughUnsupported) host.frameRenderer.prepareTransparentKey();

  const requestPassthrough = (flags: number) => {
    if (flags === passthroughRequest || (flags && passthroughUnsupported)) return;
    passthroughRequest = flags;
    if (!flags) keyUntil = performance.now() + PASSTHROUGH_TRAIL_MS;
    void host.vm.setTacticalPassthrough(flags).then(
      (accepted) => {
        // After cleanup the renderer and presenter belong to a session that is being torn down.
        if (stopped) return;
        if (flags && !accepted && passthroughRequest === flags) {
          passthroughUnsupported = true;
          passthroughRequest = 0;
          console.info('[HD] native overlay passthrough unavailable; making the whole tactical view transparent');
        }
        if (!flags) keyUntil = performance.now() + PASSTHROUGH_TRAIL_MS;
        present();
      },
      () => undefined,
    );
  };

  /** Apply hole/key/canvas visibility for the current state. */
  const present = () => {
    const keyed = !!hole && keyable && !passthroughUnsupported;
    if (keyed) keyRect = hole;
    const trailing = !keyed && !!keyRect && performance.now() < keyUntil;
    if (!keyed && !trailing) keyRect = null;
    host.frameRenderer.setTransparentKey(keyRect ? { rect: keyRect, rgb565: RENDER_PASSTHROUGH_KEY_RGB565 } : null);
    host.frameRenderer.setTransparentRect(hole && !keyRect ? hole : null);
    canvas.style.display = (hole || keyRect) && live ? 'block' : 'none';
    host.invalidate();
  };

  const setHole = (rect: FrameRect | null) => {
    const next = enabled ? rect : null;
    if (JSON.stringify(next) === JSON.stringify(hole)) return;
    hole = next;
    requestPassthrough(hole ? passthroughFlags : 0);
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
        live?.dispose();
        live = view;
        liveMap = mapId;
        failed.delete(mapId);
        pushed = null;
        upcomingKey = '';
        lastLayout = '';
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
        waitingSince = null;
        warmed = false;
        if (timeline.map !== mapId) timeline = emptyTimeline(mapId);
        timeline.readyAt = performance.now();
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

  const onState = (state: GameRenderState | null) => {
    // A reply that was already in flight when the bridge stopped belongs to a session being torn down.
    if (stopped) return;
    pollFailed = false;
    latestState = state;
    inBattle = !!state?.map;
    ui?.update(state?.sidebar ?? null);
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
      revealed = false;
      waitingSince = null;
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
      timeline = { ...emptyTimeline(mapId), loadAt: timeline.map === mapId ? timeline.loadAt : null };
      if (liveMap === mapId && live) timeline.readyAt = performance.now();
    }
    if (state && mapId) {
      matchMap = mapId;
      matchFrame = state.frame;
    }
    if (!mapId) clearFallback();
    stateMap = mapId;
    stateFrame = state?.frame ?? 0;
    if (fallback && fallback.until === Infinity && stateFrame > fallback.frame)
      fallback.until = performance.now() + NOTICE_MS;
    if (!state || !mapId || !mapName || !state.view) {
      setHole(null);
      return;
    }
    if (liveMap !== mapId || !live) {
      setHole(null);
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
      const types = readWarmTypes(storage, mapId, live.theater);
      if (types) {
        live.warm(types);
        timeline.warmAt = now;
        timeline.warmTypes = types.length;
      }
    }
    // A match snapshot ends the preparation; before the match has objects, a prepared view keeps its list.
    if (state !== pushed && !(prematch && timeline.warmAt !== null && !revealed)) {
      live.push(toSnapshot(state));
      pushed = state;
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
    // The original picture stays until tick() finds the view complete (see REVEAL_SETTLED_FRAMES).
    setHole(revealed ? tacticalRect() : null);
  };

  /**
   * Whether the view draws out of sight this tick: it belongs to the current map and has not been shown in this
   * match. That is the time to fetch, build and compile, behind the game's loading screen or its original picture.
   */
  const preparing = () => enabled && !!live && liveMap === stateMap && stateMap !== null && !revealed && !pollFailed;

  /** Show the view once the match runs and the frame just drawn (and the ones before it) lacked nothing. */
  const reveal = (now: number) => {
    if (!live || !preparing() || prematch || stateFrame < 1 || !pushed) return;
    waitingSince ??= now;
    const settled = live.settledFrames >= REVEAL_SETTLED_FRAMES;
    if (!settled && now - waitingSince < REVEAL_DEADLINE_MS) return;
    revealed = true;
    live.outOfSight = false;
    timeline.revealedAt = now;
    timeline.revealReason = settled ? 'settled' : 'deadline';
    timeline.revealLoading = live.loadingArt();
    if (!settled)
      console.warn(`[HD] view shown after ${REVEAL_DEADLINE_MS / 1000} s with ${timeline.revealLoading} loads pending`);
    setHole(tacticalRect());
    // Shown before it was complete: the frame drawn a moment ago was drawn for a view out of sight, which leaves out
    // what is not final (a voxel unit whose mesh is still being built). A shown view draws such a unit from its
    // stand-in, so draw once more: the first frame the player sees has every unit the game shows.
    if (!settled) {
      layout();
      live.render();
    }
  };

  /** Full snapshots are only worth their cost while the HD view can show them (null replies are cheap). */
  const pollInterval = () =>
    enabled && uiEnabled && ui && inBattle && !pollFailed && (liveMap !== stateMap || !live)
      ? 50
      : !enabled || pollFailed || (stateMap !== null && (liveMap !== stateMap || !live))
        ? IDLE_POLL_MS
        : ACTIVE_POLL_MS;

  const poll = (now: number) => {
    polling = true;
    lastPollAt = now;
    host.vm
      .getRenderState()
      .then(onState, () => {
        if (stopped) return;
        pollFailed = true;
        latestState = null;
        ui?.update(null);
        setHole(null);
      })
      .catch((error) => console.warn('[HD] could not apply the render state', error))
      .finally(() => {
        polling = false;
      });
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
    // What the view is shown with is what the next loading screen prepares for.
    if (shown && !buffer.every((value, index) => value === shownLayout?.[index])) {
      shownLayout = buffer;
      writeShownLayout(storage, buffer);
    }
    const key = [...buffer, ...Object.values(box.style)].join();
    if (key === lastLayout) return;
    lastLayout = key;
    Object.assign(canvas.style, box.style);
    live.resizePixels(...buffer);
  };

  const tick = () => {
    if (stopped) return;
    frame = requestAnimationFrame(tick);
    const now = performance.now();
    stallMonitor?.frame(now);
    if (!polling && now - lastPollAt >= pollInterval()) poll(now);
    if (!hole && keyRect && now >= keyUntil) present();
    if (fallback && now >= fallback.until) publish(null);
    if (live && (hole || keyRect)) {
      layout();
      // Frames of the shown view feed the safeguard: the interval between two of them is what the player sees.
      if (governor && shownAt !== null) live.hd.setQualityTier(governor.frame(now - shownAt));
      shownAt = now;
      live.render();
      publishTier(live.hd.quality);
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
      }
      reveal(now);
    } else {
      shownAt = null;
      publishTier(null);
    }
  };
  frame = requestAnimationFrame(tick);

  // Console handle for A/B checks: __hdBridge.toggle() switches between the HD view and the original picture.
  const handle = {
    toggle() {
      if (stopped) return enabled;
      enabled = !enabled;
      ui?.setEnabled(enabled && uiEnabled);
      if (!enabled) {
        setHole(null);
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
        return enabled && uiEnabled && !!ui;
      },
      toggle() {
        if (stopped) return false;
        uiEnabled = !uiEnabled;
        ui?.setEnabled(enabled && uiEnabled);
        return enabled && uiEnabled && !!ui;
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
      return { ...timeline };
    },
    /** Native overlay passthrough: requested guest flags (0 = off) and whether the key path is in use. */
    get passthrough() {
      return { flags: passthroughRequest, unsupported: passthroughUnsupported, keyed: !!keyRect };
    },
  };
  const globals = window as unknown as { __hdBridge?: typeof handle };
  globals.__hdBridge = handle;

  const stop = () => {
    if (stopped) return;
    stopped = true;
    cancelAnimationFrame(frame);
    clearFallback();
    ui?.dispose();
    ui = null;
    stallMonitor?.dispose();
    stallMonitor = null;
    latestState = null;
    if (passthroughRequest) void host.vm.setTacticalPassthrough(0).catch(() => undefined);
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
    live?.dispose();
    live = null;
    governor = null;
    publishTier(null);
    canvas.remove();
    host.screen.style.position = screenStyle.position;
    host.screen.style.zIndex = screenStyle.zIndex;
    if (globals.__hdBridge === handle) delete globals.__hdBridge;
  };
  return Object.assign(stop, { toggle: () => handle.toggle() });
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
        .map(({ id, uid, x, y, z, type, frame, velocity }) => ({ id, uid, x, y, z, type, frame, velocity })),
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
      ...(object.underlay !== undefined ? { underlay: { ...object.underlay } } : {}),
      ...(object.cargo !== undefined ? { cargo: { ...object.cargo } } : {}),
      owner: object.owner,
      x: object.x,
      y: object.y,
      z: object.z,
      facingRaw: object.facingRaw,
      ...(object.turretFacingRaw !== undefined ? { turretFacingRaw: object.turretFacingRaw } : {}),
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
