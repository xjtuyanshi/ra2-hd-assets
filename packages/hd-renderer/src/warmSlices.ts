/**
 * Warm-up of a scene's shaders in frame-sized slices.
 *
 * three builds an object's node graph (its shader source, bindings and uniforms) in JavaScript, on the thread that
 * draws, the first time it draws the object with a material/geometry combination in a pass. A warm frame that draws
 * every object of a running six-player match at once spent 2.0-2.2 s in those builds in one task (live, Ice_Age,
 * HighExpR, Transylv; profile: `renderWarmFrame` -> `NodeBuilder.build`), and that task froze the original picture
 * the player was looking at too. Built node graphs are cached by material, geometry layout and scene environment,
 * not by pass or object, so a frame that draws only some objects builds only theirs, and the objects that share them
 * later cost a cache lookup.
 *
 * `warmGroups` sorts a scene's drawable objects into groups that build the same graphs; `WarmSlicer` hands out a
 * few groups per frame, as many as the measured cost of the frame before says fit the time budget; `showOnly` makes
 * exactly those groups (and what leads to them) visible for one frame and gives back the visibility it changed.
 * The groups are taken again every frame: a view out of sight keeps adding objects while their art arrives (a few
 * new kinds a frame), and a plan made once left those to the full frame (sandbox: 0.9 s in it after 50 slices).
 * Nothing here knows about any game: the host decides which roots, which budget and when a frame is out of sight.
 */
import type { Object3D } from 'three';

/** Objects that build the same node graphs when drawn first (same materials, geometry layout and kind). */
export interface WarmGroup {
  readonly key: string;
  readonly objects: readonly Object3D[];
}

interface DrawableLike {
  isLight?: boolean;
  isInstancedMesh?: boolean;
  count?: number;
  uuid: string;
  type: string;
  material?: { id: number } | readonly { id: number }[] | null;
  geometry?: { attributes?: Record<string, unknown>; index?: unknown } | null;
}

/** Whether three's render list draws `object` itself (it has a material and is not a light). */
export function isDrawable(object: Object3D): boolean {
  const drawable = object as unknown as DrawableLike;
  return drawable.isLight !== true && drawable.material !== undefined && drawable.material !== null;
}

function groupKey(object: Object3D): string {
  const drawable = object as unknown as DrawableLike;
  const material = drawable.material!;
  const materials = Array.isArray(material)
    ? (material as readonly { id: number }[]).map((m) => m.id).join(',')
    : String((material as { id: number }).id);
  const geometry = drawable.geometry;
  const layout = geometry?.attributes ? Object.keys(geometry.attributes).sort().join(',') : '';
  // three r186 keys the graph of an instanced object (or one drawn more than once) by the object itself
  // (RenderObject.getMaterialCacheKey), so such an object shares its build with nothing.
  const own = drawable.isInstancedMesh === true || (drawable.count ?? 0) > 1 ? `|${drawable.uuid}` : '';
  return `${drawable.type}|${materials}|${layout}|${geometry?.index ? 'i' : ''}${own}`;
}

/** The drawable objects under `roots` (hidden ones included), grouped as their first draws would build them. */
export function warmGroups(roots: readonly Object3D[]): WarmGroup[] {
  const groups = new Map<string, Object3D[]>();
  for (const root of roots)
    root.traverse((object) => {
      if (!isDrawable(object)) return;
      const key = groupKey(object);
      let objects = groups.get(key);
      if (!objects) groups.set(key, (objects = []));
      objects.push(object);
    });
  return [...groups].map(([key, objects]) => ({ key, objects }));
}

export interface WarmSlicerOptions {
  /** Time a slice frame should take, in milliseconds. */
  budgetMs?: number;
  /** Groups in the first slice, before anything was measured. */
  first?: number;
  /** A slice holds at most this many times the groups of the one before it. */
  maxGrowth?: number;
  /** Groups in one slice at most. */
  maxGroups?: number;
  /** Slices at most; the rest is left to the full frames. */
  maxSlices?: number;
}

/**
 * Hands out the groups of a warm-up a slice at a time. A slice's size follows the cost per group measured in the
 * frames before it (`report`; the estimate falls by half a frame at most, since a run of groups whose graphs exist
 * says nothing about the next group: sandbox, 16 groups after four cheap ones took 393 ms), so cheap groups go through
 * in a few frames and expensive ones a few at a time. A single group is never split: one material's graph is built in one go. A group is handed out
 * once by its key; objects that join it later build nothing new.
 */
export class WarmSlicer {
  private readonly done = new Set<string>();
  private size: number;
  private last = 0;
  private perGroup = 0;
  private slices = 0;
  private readonly budget: number;
  private readonly growth: number;
  private readonly maxGroups: number;
  private readonly maxSlices: number;

  constructor(options: WarmSlicerOptions = {}) {
    this.budget = options.budgetMs ?? 14;
    this.size = Math.max(1, Math.floor(options.first ?? 4));
    this.growth = Math.max(1, options.maxGrowth ?? 2);
    this.maxGroups = Math.max(1, Math.floor(options.maxGroups ?? 8));
    this.size = Math.min(this.size, this.maxGroups);
    this.maxSlices = Math.max(1, options.maxSlices ?? 600);
  }

  /**
   * The groups of the next slice among `groups` (the scene as it is now); null once none is new or the slice limit
   * is reached (a scene that keeps gaining new kinds must not keep its view out of sight for ever).
   */
  next(groups: readonly WarmGroup[]): readonly WarmGroup[] | null {
    if (this.slices >= this.maxSlices) return null;
    const slice: WarmGroup[] = [];
    for (const group of groups) {
      if (slice.length >= this.size) break;
      if (this.done.has(group.key)) continue;
      this.done.add(group.key);
      slice.push(group);
    }
    if (!slice.length) return null;
    this.slices++;
    this.last = slice.length;
    return slice;
  }

  /** How long the frame that drew the last slice took (milliseconds); sizes the next slice. */
  report(elapsedMs: number): void {
    if (this.last <= 0) return;
    this.perGroup = Math.max(Math.max(elapsedMs, 0.01) / this.last, this.perGroup / 2);
    const fits = Math.floor(this.budget / this.perGroup);
    this.size = Math.max(1, Math.min(fits, this.last * this.growth, this.maxGroups));
  }
}

/**
 * Make only the objects of `groups` drawable under `roots` for one frame: every other drawable object is hidden, and
 * everything on the way to a group's object (and every object that draws nothing, as a full warm frame would) is
 * shown. Everything under `keep` is shown in every slice: objects whose drawing renders the scene again (a water
 * mirror: three keys a built graph by render context too, so a slice's objects must also be drawn in the mirror's
 * pass, or the full frame builds them all there; sandbox: 81 of 89 graphs left to it). Returns the function that
 * puts every changed `visible` back.
 */
export function showOnly(
  roots: readonly Object3D[],
  groups: readonly WarmGroup[],
  keep: readonly Object3D[] = [],
): () => void {
  const wanted = new Set<Object3D>();
  const onPath = new Set<Object3D>();
  for (const root of keep)
    root.traverse((object) => {
      wanted.add(object);
    });
  for (const root of keep)
    for (let parent = root.parent; parent && !onPath.has(parent); parent = parent.parent) onPath.add(parent);
  for (const group of groups)
    for (const object of group.objects) {
      wanted.add(object);
      for (let parent = object.parent; parent && !onPath.has(parent); parent = parent.parent) onPath.add(parent);
    }
  const changed: Object3D[] = [];
  for (const root of roots)
    root.traverse((object) => {
      const visible = isDrawable(object) ? wanted.has(object) || onPath.has(object) : true;
      if (object.visible === visible) return;
      object.visible = visible;
      changed.push(object);
    });
  // Each changed object had the opposite value before; set explicitly, whatever the frame did to it meanwhile.
  const before = changed.map((object) => !object.visible);
  return () => {
    for (let i = 0; i < changed.length; i++) changed[i]!.visible = before[i]!;
  };
}
