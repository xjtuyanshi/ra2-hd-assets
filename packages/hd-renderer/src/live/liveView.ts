import { BoxGeometry, Color, Group, Mesh, MeshStandardNodeMaterial, Object3D, Vector3 } from 'three/webgpu';
import { HOUSE_COLORS, RENDER_STATE_VERSION, type RenderState, type Weather } from '../contract';
import { HdRenderer } from '../HdRenderer';
import type { LibraryType } from '../../../ra2-assets/src/library';
import { sequenceFrame } from '../../../ra2-assets/src/art';
import { addHousePalettes, paletteFor, ra2Screen, screenToCell, type Ra2Cache } from '../ra2/cache';
import { SpriteLayer, cardPush, type SpriteInstance } from '../ra2/sprites';
import { buildVoxelGeometry, createVoxelMaterial, instantiateVoxel, type VoxelGeometry } from '../ra2/voxels';
import { loadRa2World, type HdWorld } from '../ra2/world';
import { LEVEL_HEIGHT } from '../world';
import { LiveEffectsDriver, type LiveEffects } from './effects';
import { LIBRARY_PALETTE_PREFIX, LiveLibrary } from './library';
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
  /** The engine's live effects (explosions, muzzle flashes, fire, smoke, projectiles), when the host reads them. */
  effects?: LiveEffects | null;
}

export interface LiveViewOptions {
  /** URL of the map's HD cache directory (manifest.json inside). */
  mapBase: string;
  /** URL of the type library root (holding <theater>/library.json), for art of everything players build. */
  libraryBase?: string;
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
  /** How it is drawn: a 3D voxel model, sprites from the map cache or the type library, or a stand-in block. */
  mode: 'voxel' | 'map-sprite' | 'library-sprite' | 'placeholder';
  /** Map-cache sprite id (mode 'map-sprite'). */
  sprite?: string;
  libraryType?: LibraryType;
  /** Library art still loading: the visual is rebuilt once it arrives. */
  pending?: boolean;
  /** When the object last changed position (ms), to tell walking infantry from standing. */
  lastMove?: number;
}

/** Interpolated engine pose: leptons and a facing in radians. */
interface Pose {
  x: number;
  y: number;
  z: number;
  facing: number;
}

/** Sprite instances per atlas: 'map' for the map cache's atlas, page numbers for type library pages. */
type SpriteBatch = Map<'map' | number, SpriteInstance[]>;

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
  private readonly pageLayers = new Map<number, SpriteLayer>();
  private readonly shroud: ShroudLayer;
  private readonly effectDriver: LiveEffectsDriver;
  private readonly wind = new Vector3(Math.cos(0.6), 0, Math.sin(0.6)).multiplyScalar(0.3 * 0.8);
  private viewWidth = 800;
  private viewHeight = 600;
  private lastRender = performance.now();

  private constructor(
    readonly hd: HdRenderer,
    readonly world: HdWorld,
    private readonly cache: Ra2Cache,
    private readonly options: LiveViewOptions,
    private readonly library: LiveLibrary | null,
  ) {
    this.root.name = 'live-objects';
    hd.scene.add(this.root);
    this.shroud = new ShroudLayer(world.width, world.height);
    hd.scene.add(this.shroud.mesh);
    this.effectDriver = new LiveEffectsDriver(hd.effects, (x, y, z) => this.shroud.isLocationShrouded(x, y, z));
    this.sprites = new SpriteLayer(cache, [], LIVE_SPRITE_CAPACITY, undefined, cache.spriteAtlasHd);
    this.sprites.mesh.name = 'live-sprites';
    this.root.add(this.sprites.mesh);
    this.shareSpriteUniforms(this.sprites);
  }

  static async create(canvas: HTMLCanvasElement, options: LiveViewOptions): Promise<LiveView> {
    const world = await loadRa2World(options.mapBase, {
      includeObject: (object) => object.kind === 'tree' || object.kind === 'overlay' || object.kind === 'smudge',
    });
    const cache = world.cache!;
    // The theater's type library (art for everything players can build), when it has been extracted.
    const library = options.libraryBase
      ? await LiveLibrary.load(`${options.libraryBase.replace(/\/$/, '')}/${cache.manifest.theater}`, cache)
      : null;
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
    return new LiveView(hd, world, cache, options, library);
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
    if (snapshot.effects) this.effectDriver.push(snapshot.effects, this.hd.seconds(), this.wind);
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
    this.effectDriver.frame(this.hd.seconds(), this.wind);
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
    const now = performance.now();
    const alive = new Set<number>();
    const houses = new Map(current.snapshot.houses.map((h) => [h.index, h.colorIndex]));
    const batch: SpriteBatch = new Map();
    for (const object of current.snapshot.objects) {
      alive.add(object.uid);
      const colorIndex = houses.get(object.owner) ?? -1;
      const visual = this.visualFor(object, colorIndex);
      // Anything standing under black shroud stays hidden, exactly as in the original (no peeking at enemy bases).
      const hidden = this.shroud.isLocationShrouded(object.x, object.y, object.z) || !!visual.libraryType?.invisible;
      visual.root.visible = !hidden;
      if (hidden) continue;
      const before = previous?.byUid.get(object.uid);
      const near = before
        ? Math.hypot(object.x - before.x, object.y - before.y) / LEPTONS_PER_CELL < TELEPORT_CELLS
        : false;
      const t = near ? alpha : 1;
      const from = near ? before! : object;
      const pose: Pose = {
        x: lerp(from.x, object.x, t),
        y: lerp(from.y, object.y, t),
        z: lerp(from.z, object.z, t),
        facing: lerpAngle16(from.facingRaw, object.facingRaw, t),
      };
      if (before && (before.x !== object.x || before.y !== object.y)) visual.lastMove = now;
      if (visual.mode === 'map-sprite') {
        this.mapBuildingSprites(object, visual, batch);
        continue;
      }
      if (visual.mode === 'library-sprite') {
        if (object.kind === 'building') this.libraryBuildingSprites(object, visual, batch, now);
        else this.libraryInfantrySprites(pose, visual, batch, now);
        continue;
      }
      visual.root.position.set(
        pose.x / LEPTONS_PER_CELL,
        (pose.z / LEPTONS_PER_LEVEL) * LEVEL_HEIGHT,
        pose.y / LEPTONS_PER_CELL,
      );
      if (object.kind === 'building') continue;
      // Engine facing 0 = north (world -z), clockwise; the model's nose is local +x. The turret yaws relative to the
      // body.
      visual.root.rotation.y = Math.PI / 2 - pose.facing;
      if (visual.turret) {
        const turret = lerpAngle16(
          from.turretFacingRaw ?? from.facingRaw,
          object.turretFacingRaw ?? object.facingRaw,
          t,
        );
        visual.turret.rotation.y = pose.facing - turret;
      }
    }
    for (const [uid, visual] of this.visuals) {
      if (alive.has(uid)) continue;
      this.root.remove(visual.root);
      this.visuals.delete(uid);
    }
    this.flushSprites(batch);
  }

  /** Hand each atlas its instances; library pages get their sprite layer when their texture has loaded. */
  private flushSprites(batch: SpriteBatch): void {
    this.sprites.setInstances(batch.get('map') ?? []);
    for (const [key, instances] of batch) {
      if (key === 'map') continue;
      this.pageLayer(key)?.setInstances(instances);
    }
    for (const [page, layer] of this.pageLayers) if (!batch.has(page)) layer.setInstances([]);
  }

  private pageLayer(page: number): SpriteLayer | null {
    let layer = this.pageLayers.get(page);
    if (layer) return layer;
    const atlas = this.library?.page(page);
    if (!atlas) return null;
    // Wait for the page's HD art when it has some, so a layer is built once with its final textures.
    const hd = this.library!.hdPage(page);
    if (!hd && this.library!.hasHdPage(page)) return null;
    layer = new SpriteLayer(this.cache, [], LIVE_SPRITE_CAPACITY, atlas, hd);
    layer.mesh.name = `live-sprites-${page}`;
    this.shareSpriteUniforms(layer);
    this.root.add(layer.mesh);
    this.pageLayers.set(page, layer);
    return layer;
  }

  private shareSpriteUniforms(layer: SpriteLayer): void {
    // The static layer's camera and light uniforms are updated by HdRenderer every frame; share their values.
    const shared = this.world.sprites;
    if (!shared) return;
    layer.cameraRight.value = shared.cameraRight.value;
    layer.cameraUp.value = shared.cameraUp.value;
    layer.toCamera.value = shared.toCamera.value;
    layer.light.value = shared.light.value;
  }

  /** Queue a library frame on its atlas page (skipped while the page loads). */
  private queue(batch: SpriteBatch, instance: SpriteInstance): void {
    const page = instance.frame.page ?? 0;
    if (!this.library?.page(page)) return;
    let list = batch.get(page);
    if (!list) batch.set(page, (list = []));
    list.push(instance);
  }

  /** A building's library art: bib, shadow, body (damaged at or below yellow) and its always-on anim layers. */
  private libraryBuildingSprites(object: LiveObject, visual: Visual, batch: SpriteBatch, now: number): void {
    const library = this.library!;
    const type = visual.libraryType!;
    const sprites = library.library.sprites;
    const entry = sprites[type.sprite!];
    if (!entry) return;
    const owner = visual.paletteKey || undefined;
    const palette = (art: { palette: string; remap: boolean }) =>
      paletteFor(this.cache, LIBRARY_PALETTE_PREFIX + art.palette, art.remap && type.remap, owner);
    const damaged = object.health <= library.conditionYellow;
    const anchor = leptonAnchor(object.x, object.y, object.z, type.drawOffset);
    const body = damaged && entry.frames.length > 1 ? 1 : 0;
    const bib = type.building?.bib ? sprites[type.building.bib] : undefined;
    const bibFrame = bib?.frames[damaged && bib.frames.length > 1 ? 1 : 0];
    if (bib && bibFrame)
      this.queue(batch, { anchor, frame: bibFrame, palette: palette(bib), push: 0, shadow: false, flat: true });
    const shadow = entry.shadows?.[body];
    if (shadow)
      this.queue(batch, { anchor, frame: shadow, palette: palette(entry), push: 0, shadow: true, flat: true });
    const frame = entry.frames[body];
    const push = frame ? cardPush(frame) : 0.03;
    if (frame && frame.rect[2] > 0) this.queue(batch, { anchor, frame, palette: palette(entry), push, shadow: false });
    for (const layer of type.building?.layers ?? []) {
      // Always-on idle animation only; production, super weapon and low-power layers need engine state not read yet.
      if (!layer.key.startsWith('ActiveAnim') && layer.key !== 'IdleAnim') continue;
      const art = sprites[damaged && layer.damagedSprite ? layer.damagedSprite : layer.sprite];
      if (!art?.frames.length) continue;
      const first = Math.min(art.frames.length - 1, layer.anim.loopStart ?? layer.anim.start ?? 0);
      const last = Math.min(
        art.frames.length,
        Math.max(first + 1, layer.anim.loopEnd ?? layer.anim.end ?? art.frames.length),
      );
      // Rate= reads as milliseconds per frame closely enough for ambient loops (e.g. 220 for the power plant).
      const step = Math.floor(now / Math.max(40, layer.anim.rate ?? 100));
      const layerFrame = art.frames[first + (step % (last - first))]!;
      const layerAnchor = layer.offset
        ? leptonAnchor(object.x, object.y, object.z, [
            type.drawOffset[0] + layer.offset[0],
            type.drawOffset[1] + layer.offset[1],
          ])
        : anchor;
      this.queue(batch, {
        anchor: layerAnchor,
        frame: layerFrame,
        palette: palette(art),
        push: push + 0.01,
        shadow: false,
      });
    }
  }

  /** Infantry from its art sequence: walking while it moved recently, otherwise standing ready. */
  private libraryInfantrySprites(pose: Pose, visual: Visual, batch: SpriteBatch, now: number): void {
    const type = visual.libraryType!;
    const entry = this.library!.library.sprites[type.sprite!];
    const sequences = type.infantry?.sequences;
    if (!entry || !sequences) return;
    const walking = now - (visual.lastMove ?? -Infinity) < 250;
    const sequence = (walking ? sequences.Walk : undefined) ?? sequences.Ready ?? sequences.Guard;
    if (!sequence) return;
    const facing = Math.round((pose.facing / (Math.PI * 2)) * 256) & 255;
    const index = sequenceFrame(sequence, facing, walking ? Math.floor(now / 90) : 0);
    const frame = entry.frames[index];
    if (!frame) return;
    const anchor = leptonAnchor(pose.x, pose.y, pose.z, type.drawOffset);
    const palette = paletteFor(
      this.cache,
      LIBRARY_PALETTE_PREFIX + entry.palette,
      entry.remap && type.remap,
      visual.paletteKey || undefined,
    );
    const shadow = entry.shadows?.[index];
    if (shadow) this.queue(batch, { anchor, frame: shadow, palette, push: 0, shadow: true, flat: true });
    this.queue(batch, { anchor, frame, palette, push: cardPush(frame), shadow: false });
  }

  /** A building whose art only the map cache has (library missing): the still frames the map extractor exported. */
  private mapBuildingSprites(object: LiveObject, visual: Visual, batch: SpriteBatch): void {
    const { manifest } = this.cache;
    const entry = manifest.sprites[visual.sprite!]!;
    const anchor = leptonAnchor(object.x, object.y, object.z, [0, -15]);
    const owner = visual.paletteKey || undefined;
    const frameIndex = object.health > CONDITION_YELLOW || entry.frames.length < 2 ? 0 : 1;
    const frame = entry.frames[frameIndex]!;
    const palette = paletteFor(this.cache, entry.palette, entry.remap, owner);
    const push = cardPush(frame);
    let list = batch.get('map');
    if (!list) batch.set('map', (list = []));
    for (const underlay of entry.underlays ?? []) {
      const bib = manifest.sprites[underlay];
      if (bib?.frames[0])
        list.push({
          anchor,
          frame: bib.frames[0],
          palette: paletteFor(this.cache, bib.palette, bib.remap, owner),
          push: 0,
          shadow: false,
          flat: true,
        });
    }
    const shadow = entry.shadows?.[frameIndex];
    if (shadow) list.push({ anchor, frame: shadow, palette, push: 0, shadow: true, flat: true });
    list.push({ anchor, frame, palette, push, shadow: false });
    for (const layer of entry.layers ?? []) {
      const art = manifest.sprites[layer];
      if (art?.frames[0])
        list.push({
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
    // Owner changes (capture, mind control) repaint the object; art that was still loading is retried.
    if (existing && existing.type === object.type && existing.paletteKey === paletteKey && !existing.pending)
      return existing;
    if (existing?.pending && !this.artReady(object)) return existing;
    if (existing) this.root.remove(existing.root);
    const visual = this.buildVisual(object, colorIndex, paletteKey);
    if (existing?.lastMove !== undefined) visual.lastMove = existing.lastMove;
    this.visuals.set(object.uid, visual);
    this.root.add(visual.root);
    return visual;
  }

  /** Whether a pending object's library voxel has arrived. */
  private artReady(object: LiveObject): boolean {
    const type = this.library?.type(object.type);
    return !!type?.voxel && !!this.library!.voxel(type.voxel);
  }

  private buildVisual(object: LiveObject, colorIndex: number, paletteKey: string): Visual {
    const libraryType = this.library?.type(object.type);
    if (libraryType?.sprite && (object.kind === 'building' || object.kind === 'infantry'))
      return { type: object.type, paletteKey, root: new Group(), mode: 'library-sprite', libraryType };
    const spriteId = `${object.kind}:${object.type}`;
    if (object.kind === 'building' && this.cache.manifest.sprites[spriteId]?.frames.length)
      return { type: object.type, paletteKey, root: new Group(), mode: 'map-sprite', sprite: spriteId };
    const fromMap = this.cache.voxels.get(object.type);
    const fromLibrary = !fromMap && libraryType?.voxel ? this.library!.voxel(libraryType.voxel) : null;
    const model = fromMap ?? fromLibrary;
    if (model) {
      const base = fromMap ? model.palette : LIBRARY_PALETTE_PREFIX + model.palette;
      const key = paletteFor(this.cache, base, libraryType?.remap ?? true, paletteKey || undefined);
      const cacheKey = `${object.type}@${key}`;
      let parts = this.geometries.get(cacheKey);
      if (!parts) {
        parts = buildVoxelGeometry(model, this.cache.paletteRgb.get(key)!);
        this.geometries.set(cacheKey, parts);
      }
      const { root, turret } = instantiateVoxel(parts, this.voxelMaterial);
      return { type: object.type, paletteKey, root, turret, mode: 'voxel', libraryType };
    }
    // No art (yet): a house-coloured block keeps every live object visible and tracked; library voxels still loading
    // are retried on later frames.
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
    return {
      type: object.type,
      paletteKey,
      root,
      mode: 'placeholder',
      libraryType,
      pending: !!libraryType?.voxel,
    };
  }

  private ensureHouse(colorIndex: number): void {
    if (colorIndex < 0 || this.housePalettes.has(colorIndex)) return;
    this.housePalettes.add(colorIndex);
    const remap = this.options.houseRemap?.(colorIndex) ?? this.library?.remap(colorIndex) ?? defaultRemap(colorIndex);
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

/**
 * World anchor of an engine draw point: the object's lepton coordinate projected like the engine, shifted by a screen
 * offset in pixels, and lifted back onto the ground at the object's height (how the type library defines drawOffset).
 */
function leptonAnchor(x: number, y: number, z: number, offset: readonly [number, number]): Vector3 {
  const level = z / LEPTONS_PER_LEVEL;
  const [sx, sy] = ra2Screen(x / LEPTONS_PER_CELL, y / LEPTONS_PER_CELL, level);
  const [cx, cy] = screenToCell(sx + offset[0], sy + offset[1], level);
  return new Vector3(cx, level * LEVEL_HEIGHT, cy);
}
