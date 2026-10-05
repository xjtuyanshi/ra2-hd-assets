import type { VmShell } from '../../../adapter/vmShell';
import type { GameRenderState } from '../../../games/renderState';
import {
  RENDER_PASSTHROUGH,
  RENDER_PASSTHROUGH_ALL,
  RENDER_PASSTHROUGH_KEY_RGB565,
} from '../../../games/renderPassthrough';
import type { FrameRect, VmFrameRenderer } from './vmFrameRenderer';
import type { HdUi } from './hdUi';
import { devicePixelBox } from './devicePixelBox';
import type { LookPreset } from '../../../../packages/hd-renderer/src/HdRenderer';
import type { LiveSnapshot, LiveView } from '../../../../packages/hd-renderer/src/live/liveView';
import { parseWeatherParams } from '../../../../packages/hd-renderer/src/weatherParams';
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
}

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
  let uiEnabled = params.get('hd-ui') === '1';
  let latestState: GameRenderState | null = null;
  let inBattle = false;
  /**
   * The map whose missing HD view was announced in this match, the logic frame at that moment, and until when the
   * notice stays on screen (Infinity until the logic frame moves on: see NOTICE_MS).
   */
  let fallback: { map: string; frame: number; until: number } | null = null;
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
        lastLayout = '';
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
    if (state !== pushed) {
      live.push(toSnapshot(state));
      pushed = state;
    }
    setHole(tacticalRect());
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
    const rect = hole ?? keyRect;
    const size = host.frameSize();
    if (!rect || !size || !live) return;
    // Cover exactly the tactical rectangle of the (scaled) game canvas, on whole device pixels: the drawing buffer then
    // has one pixel per device pixel and the compositor shows it as it is. A CSS box that is a fraction of a device
    // pixel larger than its buffer would be resampled, which softens the whole picture.
    const box = devicePixelBox(host.screen, size, window.devicePixelRatio || 1, rect);
    const budget = Math.min(1, Math.sqrt(MAX_BUFFER_PIXELS / (box.width * box.height)));
    const key = [box.width, box.height, rect.width, rect.height, ...Object.values(box.style)].join();
    if (key === lastLayout) return;
    lastLayout = key;
    Object.assign(canvas.style, box.style);
    live.resizePixels(box.width * budget, box.height * budget, rect.width, rect.height);
  };

  const tick = () => {
    if (stopped) return;
    frame = requestAnimationFrame(tick);
    const now = performance.now();
    if (!polling && now - lastPollAt >= pollInterval()) poll(now);
    if (!hole && keyRect && now >= keyUntil) present();
    if (fallback && now >= fallback.until) publish(null);
    if (live && (hole || keyRect)) {
      layout();
      live.render();
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
    host.frameRenderer.setTransparentKey(null);
    host.frameRenderer.setTransparentRect(null);
    live?.dispose();
    live = null;
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
