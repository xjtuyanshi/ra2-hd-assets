import {
  InstancedBufferAttribute,
  InstancedMesh,
  MeshBasicNodeMaterial,
  type Object3D,
  PlaneGeometry,
  Vector3,
} from 'three/webgpu';
import { instancedBufferAttribute, positionGeometry, vec3, vec4 } from 'three/tsl';
import type { MapLightsSidecar } from '../../../ra2-assets/src/lights';
import type { MapObject, SpriteFrame } from '../../../ra2-assets/src/manifest';
import { sceneLevel, type AtmosphereContext, type FrameAtmosphere, type WorldDressing } from '../atmosphere';
import type { Emitter, EmitterLayer } from '../emitters';
import { SHAPE_POOL, type LightEntry } from '../lightField';
import type { ShaderNode } from '../tsl';
import { LEVEL_HEIGHT } from '../world';
import type { Ra2Cache } from './cache';
import { MapLights, type SourceLight } from './mapLights';
import { cardPush } from './sprites';

/**
 * Colour of an HD street lamp's head: saturated sodium orange, so the head and its reflection stay orange below the
 * tone mapper's shoulder (concept C) instead of turning cream-white.
 */
const LAMP_GLOW: [number, number, number] = [1.0, 0.55, 0.18];
/**
 * Irradiance of the pool an HD street lamp throws on the ground (noon reference is about 3.4): amber, a tight pool
 * (SHAPE_POOL over LAMP_POOL_RADIUS cells) with dark gaps between neighbouring lamps, which stand at least 4.5 cells
 * apart; the peak keeps light concrete under the tone mapper's shoulder.
 */
const LAMP_POOL: [number, number, number] = [8.1, 5.2, 1.75];
const LAMP_POOL_RADIUS = 3.0;
/** Reflection colour of a lamp on wet paving, relative to its pool. */
const LAMP_STREAK = 0.55;
/** Lamp posts stand this far towards the camera from their cell centre's depth (a thin post needs little). */
const POLE_PUSH = 0.3;
/** World units per screen pixel of height (a vertical world unit spans cos 30° * 60 / sqrt 2 px). */
const PIXELS_PER_HEIGHT = Math.cos(Math.PI / 6) * (60 / Math.SQRT2);
/** Window glow on the ground in front of a building with lit windows. */
const WINDOW_GLOW: [number, number, number] = [1.0, 0.72, 0.42];
/** Colour of lit windows' reflections on wet paving (amber, like the panes). */
const WINDOW_STREAK: [number, number, number] = [1.0, 0.6, 0.26];
/** Lit window pixels at which a building's ground glow reaches full strength (a well-lit mid-rise facade). */
const WINDOW_FULL = 400;
/** Lit panes stacked in one column at which its wet reflection reaches full strength. */
const COLUMN_FULL = 3;
/** Column reflections closer than this (cells along a wall) merge into one streak. */
const COLUMN_MERGE = 0.45;

/**
 * A building whose windows light the pavement in front of it: its foundation (cells), lit window pixels and the
 * columns of lit panes as [screen x in pixels from the engine draw point (the foundation's top corner), panes].
 */
export interface WindowBuilding {
  x: number;
  y: number;
  w: number;
  h: number;
  lit: number;
  columns?: readonly (readonly [dx: number, panes: number])[];
}

export interface NightDressingOptions {
  cache: Ra2Cache;
  heightAt(x: number, z: number): number;
  /** Parent for the lamp post layer. */
  root: Object3D;
  /** Map objects drawn by the world (buildings with lit windows get a glow in front). */
  objects: readonly MapObject[];
}

/**
 * RA2 night dressing (policy): the map's light sources lit like the engine (MapLights), HD street lamps along city
 * streets (only at night, only in the city theaters unless forced), lamp heads and their wet reflections, and a soft
 * glow on the ground in front of buildings with lit windows plus their reflections on wet paving. HD-only additions
 * follow AtmosphereSettings (lamps, windows) so a lights-from-the-map-data-only night stays available.
 *
 * HD street lamps are dressing, not map objects: their posts are thin generic poles, deliberately not the game's
 * GALITE art, so nobody reads them as the real (targetable, blocking) GALITE structure.
 */
export class Ra2NightDressing implements WorldDressing {
  readonly mapLights: MapLights | null;
  private context: AtmosphereContext | null = null;
  private readonly lights: MapLightsSidecar | null;
  private poles: InstancedMesh | null = null;
  private readonly lampHead: number;
  /** Depth pull of lamp heads towards the camera: just in front of their own post. */
  private readonly headPush: number;
  private windowBuildings: WindowBuilding[];
  /** Cells where no HD lamp may stand (live matches: foundations of the buildings standing now). */
  private blocked: ReadonlySet<number> | null = null;
  private version = 0;
  private built: { lamps: boolean; dummies: boolean; windows: boolean; lights: boolean; version: number } | null = null;
  private lampCount = 0;
  private dummyCount = 0;

  constructor(private readonly options: NightDressingOptions) {
    const { cache } = options;
    this.lights = cache.lights;
    const lamp = this.lampArt();
    // Head: a few pixels below the top of the game's lamp-post frame (the globe), above the cell centre, so HD lamps
    // stand as tall as the map's own posts.
    this.lampHead = lamp ? Math.max(0.5, (15 - lamp.frame.offset[1] - 5) / PIXELS_PER_HEIGHT) : 1.0;
    this.headPush = Math.max(POLE_PUSH, lamp ? cardPush(lamp.frame) : 0) + 0.05;
    const sidecar = cache.lights;
    if (sidecar) {
      const W = cache.manifest.grid.width;
      const H = cache.manifest.grid.height;
      this.mapLights = new MapLights(
        { width: W, height: H, z: cache.height, exists: cache.exists },
        sidecar.lighting.normal,
        sidecar.cells.medianZ,
      );
      this.mapLights.setSources(
        sidecar.lights.map((l) => ({
          type: l.type,
          cell: l.cell,
          z: l.z,
          foundation: l.foundation,
          position: l.position,
          radius: l.radius,
          intensity: l.intensity,
          tint: l.tint,
          invisible: l.invisible,
        })),
      );
    } else this.mapLights = null;
    this.windowBuildings = this.mapWindowBuildings(options.objects);
  }

  /** The map cache's own INGALITE/GALITE sprite (gglite.shp): sizes HD lamps and places visible map lamps' heads. */
  private lampArt(): { id: string; frame: SpriteFrame } | null {
    const sprites = this.options.cache.manifest.sprites;
    for (const id of ['building:GALITE', 'building:INGALITE']) {
      const frame = sprites[id]?.frames[0];
      if (frame && frame.rect[2] > 0) return { id, frame };
    }
    return null;
  }

  private mapWindowBuildings(objects: readonly MapObject[]): WindowBuilding[] {
    const index = this.options.cache.windows?.index.frames;
    if (!index) return [];
    const out: WindowBuilding[] = [];
    for (const o of objects) {
      if (o.kind !== 'building' || !o.sprite) continue;
      const frame = o.frame ?? 0;
      const entry = index[o.sprite]?.[String(frame)];
      if (!entry?.lit) continue;
      const sprite = this.options.cache.manifest.sprites[o.sprite];
      const [w, h] = sprite?.foundation ?? [1, 1];
      const art = sprite?.frames[frame];
      // The card's canvas centre sits on the draw point, the top corner of cell (x, y) shifted by drawOffset.
      const dx = (o.drawOffset?.[0] ?? 0) + (art?.offset[0] ?? 0);
      const columns = art ? (entry.columns ?? []).map(([x, panes]) => [dx + x, panes] as const) : [];
      out.push({ x: o.x, y: o.y, w, h, lit: entry.lit, columns });
    }
    return out;
  }

  /** Live matches: the light-emitting buildings currently standing. */
  setSources(sources: readonly SourceLight[]): void {
    this.mapLights?.setSources(sources);
    this.version++;
  }

  /** Live matches: buildings with lit windows currently standing. */
  setWindowBuildings(list: readonly WindowBuilding[]): void {
    this.windowBuildings = [...list];
    this.version++;
  }

  /**
   * Live matches: cells (y * width + x) no HD street lamp may stand on, i.e. the foundations of the buildings standing
   * now. A structure built over a lamp spot hides that lamp, its post and its pool; null blocks nothing.
   */
  setBlockedCells(cells: ReadonlySet<number> | null): void {
    this.blocked = cells;
    this.version++;
  }

  attach(context: AtmosphereContext): void {
    this.context = context;
  }

  private lampBase(x: number, y: number, z: number): Vector3 {
    const cx = x + 0.5;
    const cz = y + 0.5;
    return new Vector3(cx, Math.max(z * LEVEL_HEIGHT, this.options.heightAt(cx, cz)), cz);
  }

  /** Whether HD street lamps are shown under the current setting. */
  private lampsEnabled(setting: FrameAtmosphere['settings']['lamps']): boolean {
    if (setting === 'on') return true;
    if (setting === 'off') return false;
    const theaters = this.lights?.hdEmitters.policy.theaters ?? ['urban', 'newurban'];
    return theaters.includes(this.options.cache.manifest.theater);
  }

  update(frame: FrameAtmosphere): void {
    const context = this.context;
    if (!context) return;
    const lamps = this.lampsEnabled(frame.settings.lamps);
    // The map's own lamp posts get HD heads whenever HD lamps are not switched off, in every theater: they mark light
    // the map really places (the street-lamp policy only decides where HD lamps are invented).
    const dummies = frame.settings.lamps !== 'off' && frame.settings.lights;
    const { windows, lights } = frame.settings;
    const built = this.built;
    if (
      !built ||
      built.lamps !== lamps ||
      built.dummies !== dummies ||
      built.windows !== windows ||
      built.lights !== lights ||
      built.version !== this.version
    ) {
      this.built = { lamps, dummies, windows, lights, version: this.version };
      this.rebuild(context, lamps, dummies, windows, lights);
    }
    this.mapLights?.update(context.lightField, frame.profile, context.reference, lights);
    // Posts appear with the night (the heads fade in with the emitter layer's lamp gain).
    if (this.poles) this.poles.visible = frame.night > 0.5;
  }

  private rebuild(
    context: AtmosphereContext,
    lampsOn: boolean,
    dummiesOn: boolean,
    windowsOn: boolean,
    lightsOn: boolean,
  ): void {
    const statics: LightEntry[] = [];
    const emitters: Emitter[] = [];
    const posts: Vector3[] = [];
    const reference = context.reference;
    const width = this.options.cache.manifest.grid.width;
    this.lampCount = 0;
    this.dummyCount = 0;
    if (lampsOn) {
      for (const lamp of this.lights?.hdEmitters.streetLamps ?? []) {
        if (this.blocked?.has(lamp.cell[1] * width + lamp.cell[0])) continue;
        const base = this.lampBase(lamp.cell[0], lamp.cell[1], lamp.z);
        posts.push(base);
        this.lampCount++;
        statics.push({ x: base.x, z: base.z, radius: LAMP_POOL_RADIUS, shape: SHAPE_POOL, colour: LAMP_POOL });
        emitters.push({
          x: base.x,
          y: base.y,
          z: base.z,
          head: this.lampHead,
          glow: LAMP_GLOW,
          streak: LAMP_POOL.map((c) => c * LAMP_STREAK) as [number, number, number],
          push: this.headPush,
          streakWidth: 0.24,
        });
      }
    }
    // The map's invisible lamp-post dummies (INGALITE ...): their light is the engine's (MapLights); the HD post and head
    // give it a visible source. Coloured dummies keep their tint.
    if (this.mapLights && dummiesOn) {
      for (const s of this.mapLights.lampPostDummies()) {
        const base = this.lampBase(s.position[0] / 256 - 0.5, s.position[1] / 256 - 0.5, s.z);
        posts.push(base);
        this.dummyCount++;
        const glow = lampTint(s.tint, LAMP_GLOW);
        emitters.push({
          x: base.x,
          y: base.y,
          z: base.z,
          head: this.lampHead,
          glow,
          streak: glow.map((c) => c * reference * 1.2 * LAMP_STREAK) as [number, number, number],
          push: this.headPush,
          streakWidth: 0.24,
        });
      }
    }
    // Visible map lamps (GALITE and the like) are map light sources: off with the map lights.
    if (this.mapLights && lightsOn) {
      statics.push(...this.mapLights.visiblePools(reference));
      for (const s of this.mapLights.visibleSources()) {
        const base = this.lampBase(s.position[0] / 256 - 0.5, s.position[1] / 256 - 0.5, s.z);
        const tint = s.tint.map((c) => Math.min(1.5, Math.max(0, c)) + 0.25);
        const max = Math.max(...tint, 1e-6);
        const glow = tint.map((c) => c / max) as [number, number, number];
        emitters.push({
          x: base.x,
          y: base.y,
          z: base.z,
          head: this.lampHead,
          glow,
          streak: glow.map((c) => c * reference * 1.2 * LAMP_STREAK) as [number, number, number],
          push: this.headPush,
        });
      }
    }
    if (windowsOn) {
      for (const b of this.windowBuildings) {
        const share = Math.min(1, b.lit / WINDOW_FULL);
        const k = 0.35 * reference * share;
        statics.push({
          // The front edge of the foundation (towards the camera), spilling onto the pavement.
          x: b.x + b.w * 0.85,
          z: b.y + b.h * 0.85,
          radius: 1.2 + 0.4 * Math.max(b.w, b.h),
          shape: SHAPE_POOL,
          colour: [WINDOW_GLOW[0] * k, WINDOW_GLOW[1] * k, WINDOW_GLOW[2] * k],
        });
        emitters.push(...this.facadeReflections(b));
      }
    }
    context.lightField.setStatic(statics);
    context.emitters.setStatic(emitters);
    this.setPoles(posts, context.emitters);
  }

  /** Rebuild the thin posts under every HD lamp head currently shown. */
  private setPoles(posts: readonly Vector3[], emitters: EmitterLayer): void {
    if (this.poles) {
      this.options.root.remove(this.poles);
      this.poles.geometry.dispose();
      (this.poles.material as MeshBasicNodeMaterial).dispose();
      this.poles.dispose();
      this.poles = null;
    }
    if (!posts.length) return;
    this.poles = buildPoles(posts, this.lampHead, emitters);
    this.poles.visible = false;
    this.options.root.add(this.poles);
  }

  /**
   * Reflections of lit windows on wet paving: one streak (no head) under each column of lit panes, on the wall that
   * column belongs to, starting at the wall's base and as strong as the panes stacked in it. A pane's screen x relative
   * to the foundation's bottom corner (cell x + w, y + h) says which camera-facing wall it is on and where: 30 pixels
   * per cell to the left along y = y + h, to the right along x = x + w. Walls without lit panes cast nothing.
   */
  private facadeReflections(b: WindowBuilding): Emitter[] {
    const out: Emitter[] = [];
    const placed: { x: number; z: number; k: number }[] = [];
    for (const [dx, panes] of b.columns ?? []) {
      // Screen x relative to the foundation's bottom corner, whose own offset from the top corner is 30 (w - h).
      const s = (dx - 30 * (b.w - b.h)) / 30;
      const along = Math.min(Math.abs(s), s < 0 ? b.w : b.h);
      const x = s < 0 ? b.x + b.w - along : b.x + b.w;
      const z = s < 0 ? b.y + b.h : b.y + b.h - along;
      const k = Math.min(1, panes / COLUMN_FULL);
      const near = placed.find((p) => Math.hypot(p.x - x, p.z - z) < COLUMN_MERGE);
      if (near) near.k = Math.min(1, near.k + k);
      else placed.push({ x, z, k });
    }
    for (const p of placed) {
      // Just in front of the wall; each column's streak varies a little in length (the floors above it).
      const x = p.x + 0.12;
      const z = p.z + 0.12;
      const variation = 0.8 + 0.4 * ((((x * 7.13 + z * 3.71) % 1) + 1) % 1);
      out.push({
        x,
        y: this.options.heightAt(x, z),
        z,
        // Only sets the mirror point (no head is drawn): about a fifth of the way out, near the wall's base.
        head: 0.28 * variation,
        glow: [0, 0, 0],
        streak: WINDOW_STREAK.map((c) => c * 0.9 * p.k) as [number, number, number],
        streakLength: 2.4 * variation,
        streakWidth: 0.2,
      });
    }
    return out;
  }

  stats(): Record<string, number> {
    return {
      mapLights: this.mapLights?.count ?? 0,
      visibleMapLamps: this.mapLights?.visibleSources().length ?? 0,
      streetLamps: this.lampCount,
      streetLampSpots: this.lights?.hdEmitters.streetLamps.length ?? 0,
      mapLampPosts: this.dummyCount,
      windowBuildings: this.windowBuildings.length,
      lampPostsVisible: this.poles?.visible ? 1 : 0,
    };
  }
}

/**
 * Head colour of a map lamp post: `fallback` (sodium orange) for a faint tint such as INGALITE's 0.05/0.05/0.01, which
 * barely changes the engine's light; otherwise the tint with a small floor, normalised by its largest channel
 * (INYELWLAMP yellow, INBLULMP blue ...).
 */
function lampTint(
  tint: readonly [number, number, number],
  fallback: readonly [number, number, number],
): [number, number, number] {
  const t = tint.map((c) => Math.min(1.5, Math.max(0, c)));
  const max = Math.max(...t);
  if (max < 0.3) return [...fallback] as [number, number, number];
  return t.map((c) => (c + 0.25) / (max + 0.25)) as [number, number, number];
}

/**
 * Thin dark poles under the HD lamp heads: camera-facing, pulled towards the camera along the view direction (no shift
 * on screen) just in front of their cell, so units standing in front still cover them.
 */
function buildPoles(bases: readonly Vector3[], head: number, camera: EmitterLayer): InstancedMesh {
  const attribute = new InstancedBufferAttribute(new Float32Array(bases.length * 3), 3);
  bases.forEach((b, i) => attribute.setXYZ(i, b.x, b.y, b.z));
  const material = new MeshBasicNodeMaterial();
  const base: ShaderNode = instancedBufferAttribute(attribute, 'vec3');
  material.positionNode = base
    .add(camera.cameraRight.mul(positionGeometry.x.mul(0.06)))
    .add(vec3(0, positionGeometry.y.add(0.5).mul(head), 0))
    .add(camera.toCamera.mul(POLE_PUSH));
  material.colorNode = vec4(vec3(0.07, 0.07, 0.075).mul(sceneLevel), 1);
  const mesh = new InstancedMesh(new PlaneGeometry(1, 1), material, bases.length);
  mesh.frustumCulled = false;
  mesh.renderOrder = 4;
  mesh.name = 'hd-lamp-poles';
  return mesh;
}
