import { BoxGeometry, Color, Group, Mesh, MeshStandardNodeMaterial, Object3D, Vector3 } from 'three/webgpu';
import { HOUSE_COLORS, RENDER_STATE_VERSION, type RenderState, type Weather } from '../contract';
import { HdRenderer } from '../HdRenderer';
import { addHousePalettes, paletteFor, screenToCell, type Ra2Cache } from '../ra2/cache';
import { SpriteLayer, cardPush, objectAnchor, type SpriteInstance } from '../ra2/sprites';
import { buildVoxelGeometry, createVoxelMaterial, instantiateVoxel, type VoxelGeometry } from '../ra2/voxels';
import { loadRa2World, type HdWorld } from '../ra2/world';
import { LEVEL_HEIGHT } from '../world';
import { ShroudLayer, type ShroudCells } from './shroud';

/**
 * Live view: draws a running original match (read from game memory by the host page) with the HD renderer, framed
 * exactly like the game's own tactical view. The host polls snapshots and pushes them here; this module never talks to
 * the game. Static map content (terrain, trees, ore, smudges) comes from the local HD cache; every building, vehicle,
 * infantry and aircraft comes from the snapshots.
 */

export type LiveKind = 'building' | 'vehicle' | 'infantry' | 'aircraft';

/** One live object in engine units: leptons (256 per cell, 104 per height level), 16-bit facings (0 = north). */
export interface LiveObject {
  id: number;
  /** Unique for the whole game; distinguishes a reused native pointer. */
  uid: number;
  kind: LiveKind;
  /** Rules type id, e.g. "MTNK". */
  type: string;
  /** Index into LiveSnapshot.houses (by `index`), -1 when unknown. */
  owner: number;
  x: number;
  y: number;
  z: number;
  facingRaw: number;
  turretFacingRaw?: number;
  health: number;
  isSelected: boolean;
}

export interface LiveHouse {
  index: number;
  /** The game's colour scheme index for this house. */
  colorIndex: number;
}

export interface LiveSnapshot {
  /** Logic frame counter. */
  frame: number;
  /** Engine screen pixel of the tactical view's top-left corner. */
  view: { x: number; y: number } | null;
  houses: LiveHouse[];
  objects: LiveObject[];
  /** The local player's per-cell visibility (see ShroudLayer), when the host can read it. */
  shroud?: ShroudCells | null;
}

export interface LiveViewOptions {
  /** URL of the map's HD cache directory (manifest.json inside). */
  mapBase: string;
  forceWebGL?: boolean;
  /** 16 remap colours (palette indices 16..31) for a colour scheme index; defaults to ramps of HOUSE_COLORS. */
  houseRemap?: (colorIndex: number) => [number, number, number][];
  timeOfDay?: number;
  weather?: Weather;
  weatherIntensity?: number;
}

const LEPTONS_PER_CELL = 256;
const LEPTONS_PER_LEVEL = 104;
/** A logic-frame move longer than this (cells) is a teleport (chrono, reinforcement) and is not interpolated. */
const TELEPORT_CELLS = 3;

interface Timed {
  snapshot: LiveSnapshot;
  at: number;
  byUid: Map<number, LiveObject>;
}

interface Visual {
  type: string;
  paletteKey: string;
  root: Object3D;
  turret?: Group;
  /** Original SHP art id (buildings with art in the cache) drawn through the live sprite layer instead of `root`. */
  sprite?: string;
}

/** Live sprite instances (buildings: body, bib, shadow, anim layers). */
const LIVE_SPRITE_CAPACITY = 4096;
/** Engine rule (rules [AudioVisual] ConditionYellow): at or below half health a building shows its damaged frame. */
const CONDITION_YELLOW = 0.5;

/** Placeholder sizes (world units) for types whose art is not in the cache yet. */
const PLACEHOLDER: Record<LiveKind, [number, number, number]> = {
  building: [0.9, 0.55, 0.9],
  vehicle: [0.55, 0.25, 0.38],
  infantry: [0.14, 0.3, 0.14],
  aircraft: [0.6, 0.12, 0.6],
};

export class LiveView {
  private previous: Timed | null = null;
  private current: Timed | null = null;
  private readonly visuals = new Map<number, Visual>();
  private readonly root = new Group();
  private readonly voxelMaterial = createVoxelMaterial();
  private readonly geometries = new Map<string, VoxelGeometry[]>();
  private readonly placeholderGeometry = new BoxGeometry(1, 1, 1);
  private readonly placeholderMaterials = new Map<string, MeshStandardNodeMaterial>();
  private readonly housePalettes = new Set<number>();
  private readonly sprites: SpriteLayer;
  private readonly shroud: ShroudLayer;
  private viewWidth = 800;
  private viewHeight = 600;
  private lastRender = performance.now();

  private constructor(
    readonly hd: HdRenderer,
    readonly world: HdWorld,
    private readonly cache: Ra2Cache,
    private readonly options: LiveViewOptions,
  ) {
    this.root.name = 'live-objects';
    hd.scene.add(this.root);
    this.shroud = new ShroudLayer(world.width, world.height);
    hd.scene.add(this.shroud.mesh);
    this.sprites = new SpriteLayer(cache, [], LIVE_SPRITE_CAPACITY);
    this.sprites.mesh.name = 'live-sprites';
    this.root.add(this.sprites.mesh);
    // Share the static layer's camera and light uniforms, which HdRenderer updates every frame.
    const shared = world.sprites;
    if (shared) {
      this.sprites.cameraRight.value = shared.cameraRight.value;
      this.sprites.cameraUp.value = shared.cameraUp.value;
      this.sprites.toCamera.value = shared.toCamera.value;
      this.sprites.light.value = shared.light.value;
    }
  }

  static async create(canvas: HTMLCanvasElement, options: LiveViewOptions): Promise<LiveView> {
    const world = await loadRa2World(options.mapBase, {
      includeObject: (object) => object.kind === 'tree' || object.kind === 'overlay' || object.kind === 'smudge',
    });
    const cache = world.cache!;
    const lighting = cache.manifest.lighting ?? { ambient: 1, level: 0.032, red: 1, green: 1, blue: 1, ground: 0 };
    const state: RenderState = {
      version: RENDER_STATE_VERSION,
      tick: 0,
      map: {
        width: world.width,
        height: world.height,
        theater: cache.manifest.theater,
        cornerHeights: new Float32Array(0),
        terrain: [],
        waterLevel: 0,
        lighting,
      },
      objects: [],
      events: [],
      environment: {
        timeOfDay: options.timeOfDay ?? 12,
        weather: options.weather ?? 'clear',
        weatherIntensity: options.weatherIntensity ?? 0,
        windDirection: 0.6,
        windStrength: 0.3,
      },
    };
    const hd = new HdRenderer(canvas, state, {
      forceWebGL: options.forceWebGL ?? false,
      requiredLimits: await HdRenderer.adapterLimits(),
    });
    await hd.init(world);
    hd.setState(state);
    // The original shows no vignette; keep the frame edge faithful to the game's own view.
    hd.settings.vignette = 0;
    hd.applySettings();
    return new LiveView(hd, world, cache, options);
  }

  /**
   * Canvas size in CSS pixels, and the tactical view size in engine pixels. The camera frustum is set in engine pixels
   * so the HD image lines up with the original pixel for pixel, whatever the display scale.
   */
  resize(cssWidth: number, cssHeight: number, viewWidth: number, viewHeight: number): void {
    this.viewWidth = viewWidth;
    this.viewHeight = viewHeight;
    this.hd.renderer.setSize(cssWidth, cssHeight, false);
    this.hd.view.zoom = 1;
    this.hd.view.resize(viewWidth, viewHeight);
  }

  /** Feed a snapshot; repeated frames are ignored. */
  push(snapshot: LiveSnapshot, at = performance.now()): void {
    const current = this.current;
    if (
      current &&
      current.snapshot.frame === snapshot.frame &&
      current.snapshot.view?.x === snapshot.view?.x &&
      current.snapshot.view?.y === snapshot.view?.y
    )
      return;
    this.previous = current;
    this.current = { snapshot, at, byUid: new Map(snapshot.objects.map((o) => [o.uid, o])) };
    for (const house of snapshot.houses) this.ensureHouse(house.colorIndex);
    if (snapshot.shroud) this.shroud.update(snapshot.shroud);
  }

  render(now = performance.now()): void {
    const dt = Math.min(0.1, Math.max(0, (now - this.lastRender) / 1000));
    this.lastRender = now;
    const current = this.current;
    if (current) {
      const previous = this.previous;
      const interval = previous ? Math.min(250, Math.max(10, current.at - previous.at)) : 1;
      // Draw one logic frame behind, blending towards the newest snapshot: smooth motion at any display rate.
      const alpha = previous ? Math.min(1, Math.max(0, (now - current.at) / interval)) : 1;
      this.applyCamera(previous?.snapshot.view ?? null, current.snapshot.view, alpha);
      this.applyObjects(previous, current, alpha);
    }
    this.hd.frame(dt);
  }

  dispose(): void {
    this.hd.renderer.setAnimationLoop(null);
    this.hd.renderer.dispose();
    this.visuals.clear();
  }

  private applyCamera(from: LiveSnapshot['view'], to: LiveSnapshot['view'], alpha: number): void {
    if (!to) return;
    const jump = from ? Math.hypot(to.x - from.x, to.y - from.y) > 400 : true;
    const x = jump || !from ? to.x : from.x + (to.x - from.x) * alpha;
    const y = jump || !from ? to.y : from.y + (to.y - from.y) * alpha;
    // The camera looks at the ground point (level 0) under the view's centre; orthographic, so height is irrelevant.
    const [cx, cy] = screenToCell(x + this.viewWidth / 2, y + this.viewHeight / 2, 0);
    this.hd.view.target.set(cx, 0, cy);
  }

  private applyObjects(previous: Timed | null, current: Timed, alpha: number): void {
    const alive = new Set<number>();
    const houses = new Map(current.snapshot.houses.map((h) => [h.index, h.colorIndex]));
    const sprites: SpriteInstance[] = [];
    for (const object of current.snapshot.objects) {
      alive.add(object.uid);
      const colorIndex = houses.get(object.owner) ?? -1;
      const visual = this.visualFor(object, colorIndex);
      // Anything standing under black shroud stays hidden, exactly as in the original (no peeking at enemy bases).
      const hidden = this.shroud.isLocationShrouded(object.x, object.y, object.z);
      visual.root.visible = !hidden;
      if (hidden) continue;
      if (visual.sprite) {
        this.buildingSprites(object, visual, sprites);
        continue;
      }
      const before = previous?.byUid.get(object.uid);
      const moved = before
        ? Math.hypot(object.x - before.x, object.y - before.y) / LEPTONS_PER_CELL < TELEPORT_CELLS
        : false;
      const t = moved ? alpha : 1;
      const from = moved ? before! : object;
      const x = lerp(from.x, object.x, t) / LEPTONS_PER_CELL;
      const y = lerp(from.y, object.y, t) / LEPTONS_PER_CELL;
      const z = lerp(from.z, object.z, t) / LEPTONS_PER_LEVEL;
      const facing = lerpAngle16(from.facingRaw, object.facingRaw, t);
      visual.root.position.set(x, z * LEVEL_HEIGHT, y);
      if (visual.turret) {
        // Engine facing 0 = north (world -z), clockwise; the model's nose is local +x. The turret yaws relative to
        // the body.
        visual.root.rotation.y = Math.PI / 2 - facing;
        const turret = lerpAngle16(
          from.turretFacingRaw ?? from.facingRaw,
          object.turretFacingRaw ?? object.facingRaw,
          t,
        );
        visual.turret.rotation.y = facing - turret;
      } else if (object.kind !== 'building') {
        visual.root.rotation.y = Math.PI / 2 - facing;
      }
    }
    for (const [uid, visual] of this.visuals) {
      if (alive.has(uid)) continue;
      this.root.remove(visual.root);
      this.visuals.delete(uid);
    }
    this.sprites.setInstances(sprites);
  }

  /** A building's original SHP art at its engine draw point: bib, shadow, body (damaged below yellow), anim layers. */
  private buildingSprites(object: LiveObject, visual: Visual, out: SpriteInstance[]): void {
    const { manifest } = this.cache;
    const entry = manifest.sprites[visual.sprite!]!;
    // Buildings report the centre of their foundation's top-left cell; the art is anchored at that cell's top corner.
    const anchor = objectAnchor({
      kind: 'building',
      type: object.type,
      x: Math.floor(object.x / LEPTONS_PER_CELL),
      y: Math.floor(object.y / LEPTONS_PER_CELL),
      z: Math.round(object.z / LEPTONS_PER_LEVEL),
      drawOffset: [0, 0],
    });
    const owner = visual.paletteKey || undefined;
    const frameIndex = object.health > CONDITION_YELLOW || entry.frames.length < 2 ? 0 : 1;
    const frame = entry.frames[frameIndex]!;
    const palette = paletteFor(this.cache, entry.palette, entry.remap, owner);
    const push = cardPush(frame);
    for (const underlay of entry.underlays ?? []) {
      const bib = manifest.sprites[underlay];
      if (bib?.frames[0])
        out.push({
          anchor,
          frame: bib.frames[0],
          palette: paletteFor(this.cache, bib.palette, bib.remap, owner),
          push: 0,
          shadow: false,
          flat: true,
        });
    }
    const shadow = entry.shadows?.[frameIndex];
    if (shadow) out.push({ anchor, frame: shadow, palette, push: 0, shadow: true, flat: true });
    out.push({ anchor, frame, palette, push, shadow: false });
    for (const layer of entry.layers ?? []) {
      const art = manifest.sprites[layer];
      if (art?.frames[0])
        out.push({
          anchor,
          frame: art.frames[0],
          palette: paletteFor(this.cache, art.palette, art.remap, owner),
          push: push + 0.01,
          shadow: false,
        });
    }
  }

  private visualFor(object: LiveObject, colorIndex: number): Visual {
    const paletteKey = colorIndex >= 0 ? `live${colorIndex}` : '';
    const existing = this.visuals.get(object.uid);
    // Owner changes (capture, mind control) repaint the object.
    if (existing && existing.type === object.type && existing.paletteKey === paletteKey) return existing;
    if (existing) this.root.remove(existing.root);
    const visual = this.buildVisual(object, colorIndex, paletteKey);
    this.visuals.set(object.uid, visual);
    this.root.add(visual.root);
    return visual;
  }

  private buildVisual(object: LiveObject, colorIndex: number, paletteKey: string): Visual {
    const spriteId = `${object.kind}:${object.type}`;
    if (object.kind === 'building' && this.cache.manifest.sprites[spriteId]?.frames.length)
      return { type: object.type, paletteKey, root: new Group(), sprite: spriteId };
    const model = this.cache.voxels.get(object.type);
    if (model) {
      const key = paletteFor(this.cache, model.palette, true, paletteKey || undefined);
      const cacheKey = `${object.type}@${key}`;
      let parts = this.geometries.get(cacheKey);
      if (!parts) {
        parts = buildVoxelGeometry(model, this.cache.paletteRgb.get(key)!);
        this.geometries.set(cacheKey, parts);
      }
      const { root, turret } = instantiateVoxel(parts, this.voxelMaterial);
      return { type: object.type, paletteKey, root, turret };
    }
    // No art for this type in the cache yet: a house-coloured block keeps every live object visible and tracked.
    const colour = colorIndex >= 0 ? HOUSE_COLORS[colorIndex % HOUSE_COLORS.length]! : 0x9a9a9a;
    const materialKey = String(colour);
    let material = this.placeholderMaterials.get(materialKey);
    if (!material) {
      material = new MeshStandardNodeMaterial({ color: new Color(colour), roughness: 0.6, metalness: 0.1 });
      this.placeholderMaterials.set(materialKey, material);
    }
    const [w, h, d] = PLACEHOLDER[object.kind];
    const mesh = new Mesh(this.placeholderGeometry, material);
    mesh.scale.set(w, h, d);
    mesh.position.y = h / 2;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    const root = new Group();
    root.add(mesh);
    root.name = `live:${object.type}`;
    return { type: object.type, paletteKey, root };
  }

  private ensureHouse(colorIndex: number): void {
    if (colorIndex < 0 || this.housePalettes.has(colorIndex)) return;
    this.housePalettes.add(colorIndex);
    const remap = this.options.houseRemap?.(colorIndex) ?? defaultRemap(colorIndex);
    addHousePalettes(this.cache, `live${colorIndex}`, remap);
  }
}

/** Bright-to-dark ramp of a house colour, shaped like the engine's 16-entry remap range. */
function defaultRemap(colorIndex: number): [number, number, number][] {
  const base = new Color(HOUSE_COLORS[colorIndex % HOUSE_COLORS.length]!);
  return Array.from({ length: 16 }, (_, i) => {
    const k = 1.15 - (i / 15) * 0.85;
    return [
      Math.min(255, Math.round(base.r * 255 * k)),
      Math.min(255, Math.round(base.g * 255 * k)),
      Math.min(255, Math.round(base.b * 255 * k)),
    ];
  });
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Interpolate 16-bit engine facings along the short arc; returns radians (0 = north, clockwise). */
function lerpAngle16(a: number, b: number, t: number): number {
  let delta = (((b - a) % 65536) + 65536) % 65536;
  if (delta > 32768) delta -= 65536;
  return ((a + delta * t) / 65536) * Math.PI * 2;
}

/** World position of an engine lepton coordinate, for hosts that place their own overlays. */
export function leptonToWorld(x: number, y: number, z: number, out = new Vector3()): Vector3 {
  return out.set(x / LEPTONS_PER_CELL, (z / LEPTONS_PER_LEVEL) * LEVEL_HEIGHT, y / LEPTONS_PER_CELL);
}
