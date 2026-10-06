import { afterEach, describe, expect, it, vi } from 'vitest';
import { BufferGeometry, Group, InstancedMesh, MeshBasicMaterial, Texture, Vector3 } from 'three/webgpu';
import type { LibraryType } from '../../ra2-assets/src/library';
import type { SpriteEntry, SpriteFrame } from '../../ra2-assets/src/manifest';
import { DEPLOY_TARGETS, cellArtPages, overlayTypePages } from '../src/live/artAhead';
import { LiveView, type LiveDiagnostics, type LiveObject, type LiveSnapshot } from '../src/live/liveView';
import { SpritePool } from '../src/live/spritePool';
import { painterObject } from '../src/ra2/painterOrder';
import { SpriteLayer, type SpriteInstance } from '../src/ra2/sprites';

/** Layers record what they are built from and what they are handed; nothing else of a sprite layer is needed. */
vi.mock('../src/ra2/sprites', async (original) => ({
  ...(await original<typeof import('../src/ra2/sprites')>()),
  SpriteLayer: vi.fn(
    class {
      // The instance count of a layer's mesh is `instances` (InstancedQuad): Mesh.count stays 1.
      readonly mesh = Object.assign(new InstancedMesh(new BufferGeometry(), new MeshBasicMaterial(), 1), {
        instances: 0,
      });
      readonly capacity = 64;
      drawn: readonly SpriteInstance[] = [];
      readonly setInstances = vi.fn((instances: readonly SpriteInstance[]) => {
        this.drawn = [...instances];
        this.mesh.instances = instances.length;
      });
    },
  ),
}));

afterEach(() => {
  vi.clearAllMocks();
});

type Layer = SpriteLayer & { drawn: readonly SpriteInstance[] };
type Batch = Map<'map' | number, SpriteInstance[]>;

const frame = (x: number, page: number): SpriteFrame => ({ rect: [x, 0, 32, 64], offset: [-16, -48], page });

/** One upright card of an object as the view queues it: house palette row, depth profile, painter owner. */
function card(x: number, page: number, uid = 1): SpriteInstance {
  return {
    anchor: new Vector3(10 + x, 0.5, 20),
    frame: frame(x, page),
    palette: 'lib:unit@live3',
    push: 0.4,
    shadow: false,
    nativeDepth: { mode: 'body', origin: [5, 7], base: 16 },
    painter: { ...painterObject(2, 100, 0), uid },
  };
}

/** The real layer selection and flush; atlas pages, HD art and masks arrive when the test says so. */
function sheet() {
  const look = { windows: false, materials: false };
  const indexed = new Map<number, { texture: Texture; width: number; height: number }>();
  const hd = new Map<number, { color: Texture; remap: Texture }>();
  const hdRefs = new Set<number>([3]);
  const windows = new Map<number, Texture>();
  const materials = new Map<number, { texture: Texture }>();
  const arrive = (page: number) => indexed.set(page, { texture: new Texture(), width: 32, height: 40 });
  arrive(3);
  const library = {
    page: vi.fn((page: number) => indexed.get(page) ?? null),
    hdPage: vi.fn((page: number) => hd.get(page) ?? null),
    hasHdPage: vi.fn((page: number) => hdRefs.has(page)),
    hasWindowsPage: vi.fn(() => true),
    windowsPage: vi.fn((page: number) => windows.get(page) ?? null),
    hasMaterialsPage: vi.fn(() => true),
    materialsPage: vi.fn((page: number) => materials.get(page) ?? null),
  };
  const depth = { register: vi.fn(), setCaptured: vi.fn() };
  const batch: Batch = new Map();
  const view = Object.assign(Object.create(LiveView.prototype), {
    hd: { windowsWanted: () => look.windows, materialsWanted: () => look.materials, terrainDepth: depth },
    library,
    cache: {},
    root: new Group(),
    world: {},
    sprites: { mesh: { instances: 0 }, setInstances: vi.fn() },
    pageLayers: new Map(),
    indexedMeanwhile: new Map(),
    spriteBatch: batch,
    visuals: new Map(),
    warnedTypes: new Set(),
    voxelUnits: { standInUnits: 0 },
    effectStats: { drawn: 0, missing: 0 },
    volumetricBlasts: { stats: () => ({ count: 0 }) },
    effectDriver: { unknownTypes: new Set(), logicFps: 0 },
    overlayInstances: { active: false },
    smudgeInstances: { active: false, instances: { missingTypes: new Set() } },
    newArt: 0,
    newArtPerFrame: 1,
    waitingArt: 0,
  }) as unknown as {
    flushSprites(batch: Batch, reorder?: boolean): void;
    pageLayers: Map<number, { layer: Layer; windows: boolean; materials: boolean }>;
    outOfSight: boolean;
    diagnostics(): LiveDiagnostics;
  };
  const built = () => vi.mocked(SpriteLayer).mock.calls.map((call) => ({ atlas: call[3], hd: call[4], mask: call[5] }));
  return { view, library, look, indexed, hd, hdRefs, windows, materials, arrive, batch, built };
}

describe('a sprite whose HD page has not arrived', () => {
  it('is drawn from the indexed page in its first frame, never as nothing', () => {
    const s = sheet();
    const yard = [card(0, 3), card(1, 3)];
    s.batch.set(3, yard);
    s.view.flushSprites(s.batch);
    // One layer, of the indexed page alone (key -1 - page), holding exactly the queued records.
    expect(s.built()).toEqual([{ atlas: s.indexed.get(3), hd: null, mask: null }]);
    expect([...s.view.pageLayers.keys()]).toEqual([-4]);
    const meanwhile = s.view.pageLayers.get(-4)!.layer;
    expect(meanwhile.drawn).toEqual(yard);
    expect(meanwhile.drawn[0]).toBe(yard[0]);
    expect(s.view.diagnostics().indexedSprites).toBe(2);
    // The HD art is on its way: asked for by the very flush that drew the stand-in.
    expect(s.library.hdPage).toHaveBeenCalledWith(3);
    // The following frames keep drawing it; no second layer is built while the art loads.
    s.view.flushSprites(s.batch, false);
    s.view.flushSprites(s.batch);
    expect(SpriteLayer).toHaveBeenCalledTimes(1);
    expect(meanwhile.drawn).toEqual(yard);
  });

  it('changes to the HD page in place: same records, so the same anchor, depth and house colours', () => {
    const s = sheet();
    const yard = [card(0, 3), card(1, 3)];
    s.batch.set(3, yard);
    s.view.flushSprites(s.batch);
    const meanwhile = s.view.pageLayers.get(-4)!.layer;
    const before = meanwhile.drawn.map((sprite) => ({
      anchor: sprite.anchor.clone(),
      rect: [...sprite.frame.rect],
      offset: [...sprite.frame.offset],
      palette: sprite.palette,
      push: sprite.push,
      depth: sprite.nativeDepth,
      painter: sprite.painter,
    }));
    const art = { color: new Texture(), remap: new Texture() };
    s.hd.set(3, art);
    s.view.flushSprites(s.batch);
    // The final layer, built once, from the same indexed atlas plus the HD art.
    expect(s.built()[1]).toEqual({ atlas: s.indexed.get(3), hd: art, mask: null });
    const final = s.view.pageLayers.get(3)!.layer;
    expect(final.drawn).toHaveLength(2);
    final.drawn.forEach((sprite, i) => {
      // The very records the indexed layer drew: nothing about the sprite's placement was made anew.
      expect(sprite).toBe(yard[i]);
      expect(sprite.anchor.equals(before[i]!.anchor)).toBe(true);
      // Both layers place a frame by its rectangle in the indexed atlas: no change of size or position.
      expect(sprite.frame.rect).toEqual(before[i]!.rect);
      expect(sprite.frame.offset).toEqual(before[i]!.offset);
      // The palette row holds the owner's remap colours; the HD layer reads the same row for its house paint.
      expect(sprite.palette).toBe(before[i]!.palette);
      expect(sprite.push).toBe(before[i]!.push);
      expect(sprite.nativeDepth).toBe(before[i]!.depth);
      expect(sprite.painter).toBe(before[i]!.painter);
    });
    // The stand-in layer is emptied in the same flush: no frame draws the object twice or not at all.
    expect(meanwhile.drawn).toEqual([]);
    expect((meanwhile.mesh as unknown as { instances: number }).instances).toBe(0);
    expect(s.view.diagnostics().indexedSprites).toBe(0);
    s.view.flushSprites(s.batch);
    expect(SpriteLayer).toHaveBeenCalledTimes(2);
  });

  it('shares the indexed layer with the art of the page that is always drawn indexed', () => {
    const s = sheet();
    const yard = [card(0, 3, 1), card(1, 3, 1)];
    const derrick = [card(5, 3, 2)];
    s.batch.set(3, yard);
    s.batch.set(-4, derrick);
    s.view.flushSprites(s.batch);
    const layer = s.view.pageLayers.get(-4)!.layer;
    expect(new Set(layer.drawn)).toEqual(new Set([...yard, ...derrick]));
    expect(s.view.diagnostics().indexedSprites).toBe(2);
    expect(SpriteLayer).toHaveBeenCalledTimes(1);
    s.hd.set(3, { color: new Texture(), remap: new Texture() });
    s.view.flushSprites(s.batch);
    // Each sprite is in exactly one layer again.
    expect(s.view.pageLayers.get(3)!.layer.drawn).toEqual(yard);
    expect(layer.drawn).toEqual(derrick);
    // When the indexed art leaves too, its layer is emptied.
    s.batch.get(-4)!.length = 0;
    s.view.flushSprites(s.batch);
    expect(layer.drawn).toEqual([]);
  });

  it('waits for the HD page out of sight, and draws from the indexed page the moment the view is shown', () => {
    const s = sheet();
    s.view.outOfSight = true;
    s.batch.set(3, [card(0, 3)]);
    s.view.flushSprites(s.batch);
    // Nobody sees the view: nothing is built twice, and the page counts as art on its way (it was asked for).
    expect(SpriteLayer).not.toHaveBeenCalled();
    expect(s.library.hdPage).toHaveBeenCalledWith(3);
    expect(s.view.diagnostics().indexedSprites).toBe(0);
    // Shown before everything was in (the host's deadline): the next flush draws the object.
    s.view.outOfSight = false;
    s.view.flushSprites(s.batch);
    expect(s.view.pageLayers.get(-4)!.layer.drawn).toHaveLength(1);
  });

  it('builds the final layer at once for a page without HD art, and for one whose HD art failed', () => {
    const s = sheet();
    s.arrive(7);
    s.batch.set(7, [card(0, 7)]);
    s.view.flushSprites(s.batch);
    expect([...s.view.pageLayers.keys()]).toEqual([7]);
    expect(s.built()).toEqual([{ atlas: s.indexed.get(7), hd: null, mask: null }]);
    expect(s.view.diagnostics().indexedSprites).toBe(0);
    // LiveLibrary.hasHdPage answers false once the art has failed.
    s.batch.clear();
    s.batch.set(3, [card(0, 3)]);
    s.view.flushSprites(s.batch);
    expect(s.view.pageLayers.has(3)).toBe(false);
    s.hdRefs.delete(3);
    s.view.flushSprites(s.batch);
    expect(s.view.pageLayers.get(3)!.layer.drawn).toHaveLength(1);
    expect(s.view.pageLayers.get(-4)!.layer.drawn).toEqual([]);
  });

  it('asks for the masks of the final layer beside the HD art, so the layer is built once, complete', () => {
    const s = sheet();
    s.look.windows = s.look.materials = true;
    s.batch.set(3, [card(0, 3)]);
    s.view.flushSprites(s.batch);
    expect(s.library.windowsPage).toHaveBeenCalledWith(3);
    expect(s.library.materialsPage).toHaveBeenCalledWith(3);
    // Everything arrives: one final layer with the HD art and both masks.
    const mask = new Texture();
    const material = { texture: new Texture() };
    s.windows.set(3, mask);
    s.materials.set(3, material);
    s.hd.set(3, { color: new Texture(), remap: new Texture() });
    s.view.flushSprites(s.batch);
    const final = vi.mocked(SpriteLayer).mock.calls.at(-1)!;
    expect(final.slice(4, 7)).toEqual([s.hd.get(3), mask, material]);
    expect(s.view.pageLayers.get(3)).toMatchObject({ windows: true, materials: true });
  });
});

describe('a night map: the lit-window mask of a page', () => {
  it('does not keep a shown page undrawn: the layer is built without it and rebuilt once it is in', () => {
    const s = sheet();
    s.look.windows = true;
    s.hd.set(3, { color: new Texture(), remap: new Texture() });
    s.batch.set(3, [card(0, 3)]);
    s.view.flushSprites(s.batch);
    const first = s.view.pageLayers.get(3)!;
    expect(first.windows).toBe(false);
    expect(first.layer.drawn).toHaveLength(1);
    // While the mask loads the layer stays.
    s.view.flushSprites(s.batch);
    expect(s.view.pageLayers.get(3)!.layer).toBe(first.layer);
    const mask = new Texture();
    s.windows.set(3, mask);
    s.view.flushSprites(s.batch);
    const lit = s.view.pageLayers.get(3)!;
    expect(lit.layer).not.toBe(first.layer);
    expect(lit.windows).toBe(true);
    expect(lit.layer.drawn).toHaveLength(1);
    expect(SpriteLayer).toHaveBeenCalledTimes(2);
  });

  it('is waited for out of sight, where a layer is built once', () => {
    const s = sheet();
    s.view.outOfSight = true;
    s.look.windows = true;
    s.hd.set(3, { color: new Texture(), remap: new Texture() });
    s.batch.set(3, [card(0, 3)]);
    s.view.flushSprites(s.batch);
    expect(SpriteLayer).not.toHaveBeenCalled();
    s.windows.set(3, new Texture());
    s.view.flushSprites(s.batch);
    expect(SpriteLayer).toHaveBeenCalledTimes(1);
    expect(s.view.pageLayers.get(3)!.windows).toBe(true);
  });
});

/**
 * A building whose build-up is on atlas page 0 and whose body and layer are on page 1, drawn through the real
 * applyObjects, building sprite, palette, queue and picture paths. Pages arrive when the test says so.
 */
function site() {
  const loaded = new Set<number>([0]);
  const art = (first: number, page: number, frames = 3): SpriteEntry => ({
    frames: Array.from({ length: frames }, (_, i) => frame(first + i, page)),
    shadows: Array.from({ length: frames }, (_, i) => frame(first + 50 + i, page)),
    canvas: [32, 64],
    palette: 'unit',
    remap: true,
  });
  const sprites: Record<string, SpriteEntry> = { make: art(0, 0), body: art(100, 1, 2), active: art(200, 1, 1) };
  const type: LibraryType = {
    kind: 'building',
    image: 'TEST',
    sprite: 'body',
    foundation: [2, 2],
    drawOffset: [0, 0],
    lighting: 'ambient',
    remap: true,
    building: { bodyFrames: 2, buildup: 'make', layers: [{ key: 'ActiveAnim', sprite: 'active', anim: {} }] },
  };
  const library = {
    library: { sprites },
    conditionYellow: 0.5,
    type: () => type,
    page: vi.fn((page: number) => (loaded.has(page) ? {} : null)),
    hdPage: vi.fn(() => null),
    hasHdPage: () => false,
    typePages: () => [0, 1],
    preloadPage: vi.fn((page: number) => loaded.has(page)),
  };
  const visual = {
    type: 'TEST',
    paletteKey: 'house0',
    root: new Group(),
    mode: 'library-sprite',
    libraryType: type,
    firstFrame: 0,
    held: undefined as { size: number } | undefined,
    pagesIn: undefined as boolean | undefined,
  };
  const object: LiveObject = {
    id: 1,
    uid: 1,
    kind: 'building',
    type: 'TEST',
    owner: 0,
    x: 10 * 256 + 128,
    y: 20 * 256 + 128,
    z: 0,
    facingRaw: 0,
    health: 1,
    isSelected: false,
    buildState: 'building',
    buildupFrame: 2,
  };
  const batch: Batch = new Map();
  const view = Object.assign(Object.create(LiveView.prototype), {
    library,
    cache: { paletteRow: new Map([['lib:unit@house0', 1]]), depthTemplate: { width: 396, height: 477 } },
    libraryPaletteKeys: new Map(),
    spritePool: new SpritePool(),
    spriteBatch: batch,
    civilian: new Set(),
    appearances: new Map(),
    buildingAnimMatches: new Map(),
    firstFrame: 0,
    visuals: new Map([[1, visual]]),
    houseColour: new Map([[0, 3]]),
    pose: { x: 0, y: 0, z: 0, facing: 0 },
    // Layer order is not under test: applyObjects leaves the flush to the painter pass.
    painterDirty: true,
    world: { terrain: { heightAt: () => 0 } },
    hd: {},
    picture: null,
    pictureScratch: { sprites: [], indexed: [], keys: [], count: 0, incomplete: false },
    pictureBase: new Vector3(),
    heldPictures: 0,
    incompletePictures: 0,
  }) as unknown as {
    applyObjects(previous: null, current: unknown, alpha: number): void;
    visualFor(): unknown;
    heldPictures: number;
    incompletePictures: number;
  };
  vi.spyOn(view, 'visualFor').mockReturnValue(visual);
  /** One presented frame; returns the building's sprites as plain copies (the pool reuses its records). */
  const draw = (logicFrame: number) => {
    const snapshot: LiveSnapshot = { frame: logicFrame, view: null, houses: [], objects: [object] };
    view.applyObjects(null, { snapshot, at: 0, byUid: new Map([[1, object]]) }, 1);
    const drawn: {
      page: number;
      x: number;
      shadow: boolean;
      anchor: Vector3;
      palette: string;
      push: number;
      depth: unknown;
      uid: number | undefined;
    }[] = [];
    for (const [key, list] of batch)
      for (const sprite of list)
        drawn.push({
          page: key as number,
          x: sprite.frame.rect[0],
          shadow: sprite.shadow,
          anchor: sprite.anchor.clone(),
          palette: sprite.palette,
          push: sprite.push,
          depth: sprite.nativeDepth,
          uid: sprite.painter?.uid,
        });
    return drawn;
  };
  return { view, visual, object, loaded, library, draw };
}

describe('a building that changes state onto art that has not arrived', () => {
  it('keeps its previous picture, in place and in its colours, until the new one can be drawn', () => {
    const s = site();
    // Under construction: the make anim's third frame and its shadow, from page 0.
    const building = s.draw(10);
    expect(building.map((sprite) => [sprite.page, sprite.x, sprite.shadow])).toEqual([
      [0, 52, true],
      [0, 2, false],
    ]);
    expect(s.view.heldPictures).toBe(0);
    expect(s.visual.held!.size).toBe(2);
    // The type's other page was asked for when the building appeared, as an indexed page.
    expect(s.library.preloadPage).toHaveBeenCalledWith(1);

    // Construction ends, but the page holding the body and its layer is not in.
    Object.assign(s.object, { buildState: 'done', buildupFrame: undefined, buildingFrame: 0 });
    const held = s.draw(11);
    expect(held).toHaveLength(2);
    held.forEach((sprite, i) => {
      const was = building[i]!;
      expect([sprite.page, sprite.x, sprite.shadow]).toEqual([was.page, was.x, was.shadow]);
      expect(sprite.anchor.distanceTo(was.anchor)).toBeLessThan(1e-9);
      expect(sprite.palette).toBe('lib:unit@house0');
      expect(sprite.push).toBe(was.push);
      expect(sprite.depth).toEqual(was.depth);
      expect(sprite.uid).toBe(was.uid);
    });
    expect(s.view.heldPictures).toBe(1);
    expect(s.view.incompletePictures).toBe(0);
    // The missing page (and its HD art beside it) is on its way: asked for by the frame that could not draw it.
    expect(s.library.page).toHaveBeenCalledWith(1);
    expect(s.library.hdPage).toHaveBeenCalledWith(1);
    // Frame after frame, the same picture: never the shadow alone, never nothing.
    expect(s.draw(12).map((sprite) => sprite.x)).toEqual([52, 2]);

    // The page arrives: the finished building, complete, and nothing of the old picture.
    s.loaded.add(1);
    const done = s.draw(13);
    expect(done.filter((sprite) => sprite.page === 0)).toEqual([]);
    // Body shadow, body, and the always-on layer (whose art casts no shadow of its own).
    expect(done.map((sprite) => [sprite.page, sprite.x, sprite.shadow])).toEqual([
      [1, 150, true],
      [1, 100, false],
      [1, 200, false],
    ]);
    expect(done[1]!.anchor.distanceTo(building[1]!.anchor)).toBeLessThan(1e-9);
    expect(s.view.heldPictures).toBe(0);
    // Every page of the type is in: nothing is recorded or kept any more.
    s.draw(14);
    expect(s.visual.pagesIn).toBe(true);
    expect(s.visual.held).toBeUndefined();
  });

  it('holds through a sale as through construction: any part without a page keeps the old picture', () => {
    const s = site();
    s.loaded.add(1);
    s.loaded.delete(0);
    // Standing complete (body, layer); the build-up page is the one that is missing now.
    Object.assign(s.object, { buildState: 'done', buildupFrame: undefined, buildingFrame: 0 });
    const standing = s.draw(20);
    expect(standing.map((sprite) => sprite.x)).toEqual([150, 100, 200]);
    // Sold: the make anim runs backwards from a page that is not in. The standing building stays.
    Object.assign(s.object, { buildState: 'selling', buildupFrame: 1 });
    expect(s.draw(21).map((sprite) => sprite.x)).toEqual([150, 100, 200]);
    expect(s.view.heldPictures).toBe(1);
    s.loaded.add(0);
    expect(s.draw(22).map((sprite) => [sprite.page, sprite.x])).toEqual([
      [0, 51],
      [0, 1],
    ]);
  });

  it('draws what it can of a first picture, and counts the object as incomplete', () => {
    const s = site();
    s.loaded.delete(0);
    // Nothing was ever drawn for this building, and its page is not in: there is nothing to show yet.
    expect(s.draw(10)).toEqual([]);
    expect(s.view.incompletePictures).toBe(1);
    expect(s.view.heldPictures).toBe(0);
    s.loaded.add(0);
    expect(s.draw(11).map((sprite) => sprite.x)).toEqual([52, 2]);
    expect(s.view.incompletePictures).toBe(0);
  });

  it('does not treat a missing shadow as a missing picture', () => {
    const s = site();
    s.loaded.add(1);
    Object.assign(s.object, { buildState: 'done', buildupFrame: undefined, buildingFrame: 0 });
    // The body's shadow frame sits on a third page that is not in.
    (s.library.library.sprites.body!.shadows![0] as SpriteFrame).page = 2;
    const drawn = s.draw(30);
    expect(drawn.map((sprite) => sprite.x)).toEqual([100, 200]);
    expect(s.view.heldPictures).toBe(0);
    expect(s.view.incompletePictures).toBe(0);
  });
});

/** prepare() and its per-frame step, with the library and the layer builder replaced. */
function ahead() {
  const settled = new Set<number>();
  const failed = new Set<number>();
  const look = { windows: false, materials: false };
  const pages = new Map<LibraryType, number[]>();
  const type = (kind: LibraryType['kind'], list: number[] | null): LibraryType => {
    const made: LibraryType = {
      kind,
      image: 'X',
      drawOffset: [0, 0],
      lighting: 'ambient',
      remap: true,
      ...(list ? { sprite: 'x' } : { voxel: 'V' }),
    };
    if (list) pages.set(made, list);
    return made;
  };
  const types: Record<string, LibraryType> = {
    NAPOWR: type('building', [0]),
    NAREFN: type('building', [1, 2]),
    E2: type('infantry', [21]),
    HTNK: type('vehicle', null),
  };
  const library = {
    library: {
      overlays: { NAWALL: { sprite: 'overlay:NAWALL' } },
      sprites: { 'overlay:NAWALL': { frames: [frame(0, 5), frame(1, 6)], shadows: [frame(2, 6)] } },
    },
    type: (id: string) => types[id],
    typePages: (made: LibraryType) => pages.get(made) ?? [],
    preloadPage: vi.fn((page: number) => settled.has(page) || failed.has(page)),
    pageFailed: (page: number) => failed.has(page),
    hasWindowsPage: () => true,
    hasMaterialsPage: () => true,
    voxel: vi.fn(() => ({ id: 'V', palette: 'unit', normalsMode: 4, parts: [] })),
    voxelFailed: () => false,
  };
  const prepared = { ready: false };
  const view = Object.assign(Object.create(LiveView.prototype), {
    library,
    cache: { voxels: new Map(), paletteRow: new Map([['lib:unit@live7', 1]]) },
    hd: { windowsWanted: () => look.windows, materialsWanted: () => look.materials },
    preparedTypes: new Set(),
    aheadPages: new Set(),
    aheadVoxels: new Set(),
    pageLayers: new Map(),
    libraryPaletteKeys: new Map(),
    houseColour: new Map([[2, 7]]),
    housePaletteKeys: new Map([[7, 'live7']]),
    current: { snapshot: { localHouse: 2 } },
    voxelUnits: { prepare: vi.fn(() => prepared.ready) },
    newArt: 0,
    newArtPerFrame: 1,
    waitingArt: 0,
  }) as unknown as {
    prepare(types: Iterable<string>, local?: boolean): void;
    stepAhead(): void;
    pageLayer(key: number): unknown;
    aheadPages: Set<number>;
    aheadVoxels: Set<string>;
    pageLayers: Map<number, { layer: unknown; windows: boolean; materials: boolean }>;
    outOfSight: boolean;
    newArt: number;
    waitingArt: number;
  };
  const layers = vi.spyOn(view, 'pageLayer').mockImplementation((page: number) => {
    const layer = { page };
    view.pageLayers.set(page, { layer, windows: look.windows, materials: look.materials });
    view.newArt++;
    return layer;
  });
  return { view, library, settled, failed, look, layers, prepared };
}

describe('art asked for ahead of its first object', () => {
  it('lists the pages of sprite types and walls and the models of vehicles, once, and ignores unknown types', () => {
    const a = ahead();
    a.view.prepare(['NAPOWR', 'NAREFN', 'E2', 'HTNK', 'NAWALL', 'NOSUCH']);
    expect([...a.view.aheadPages].sort((x, y) => x - y)).toEqual([0, 1, 2, 5, 6, 21]);
    expect([...a.view.aheadVoxels]).toEqual(['HTNK']);
    // Asked again (the sidebar reports a production on every poll): nothing more to do.
    a.view.aheadPages.clear();
    a.view.prepare(['NAPOWR', 'E2']);
    expect(a.view.aheadPages.size).toBe(0);
  });

  it("leaves vehicles out for types that will not be the local player's (the map's own objects)", () => {
    const a = ahead();
    a.view.prepare(['HTNK', 'NAPOWR'], false);
    expect([...a.view.aheadPages]).toEqual([0]);
    expect(a.view.aheadVoxels.size).toBe(0);
  });

  it('fetches each page whole, with the masks the look wants, and builds its layer when everything is in', () => {
    const a = ahead();
    a.look.materials = true;
    a.view.prepare(['NAPOWR', 'NAREFN']);
    a.view.stepAhead();
    expect(a.library.preloadPage.mock.calls).toEqual([
      [0, true, false, true],
      [1, true, false, true],
      [2, true, false, true],
    ]);
    // Nothing is in: no layer, and the pages stay listed.
    expect(a.layers).not.toHaveBeenCalled();
    expect(a.view.aheadPages.size).toBe(3);
    // The power plant's page is in: its layer (and with it its shaders) is built before the building is placed.
    a.settled.add(0);
    a.view.stepAhead();
    expect(a.layers.mock.calls).toEqual([[0]]);
    expect([...a.view.aheadPages]).toEqual([1, 2]);
    // A shown view builds one layer per frame: two pages that arrive together take two frames.
    a.settled.add(1).add(2);
    a.view.stepAhead();
    expect(a.layers.mock.calls).toEqual([[0], [1]]);
    a.view.stepAhead();
    expect(a.layers.mock.calls).toEqual([[0], [1], [2]]);
    expect(a.view.aheadPages.size).toBe(0);
    // Done: later frames cost nothing.
    a.library.preloadPage.mockClear();
    a.view.stepAhead();
    expect(a.library.preloadPage).not.toHaveBeenCalled();
  });

  it('drops a page that failed and leaves a layer alone that already has what the look wants', () => {
    const a = ahead();
    a.view.prepare(['NAREFN']);
    a.failed.add(1);
    a.settled.add(2);
    a.view.pageLayers.set(2, { layer: {}, windows: false, materials: false });
    a.view.stepAhead();
    expect(a.layers).not.toHaveBeenCalled();
    expect(a.view.aheadPages.size).toBe(0);
  });

  it('never takes the turn of art the hidden view is waiting for, and never counts as waiting itself', () => {
    const a = ahead();
    a.view.outOfSight = true;
    a.view.prepare(['NAPOWR', 'E2']);
    a.settled.add(0).add(21);
    // The frame's own art used the frame's one new kind.
    a.view.newArt = 1;
    a.view.stepAhead();
    expect(a.layers).not.toHaveBeenCalled();
    expect(a.view.waitingArt).toBe(0);
    // A frame with room: one layer, as for any new kind out of sight.
    a.view.newArt = 0;
    a.view.stepAhead();
    expect(a.layers.mock.calls).toEqual([[0]]);
    expect(a.view.waitingArt).toBe(0);
    a.view.newArt = 0;
    a.view.stepAhead();
    expect(a.layers.mock.calls).toEqual([[0], [21]]);
  });

  it("prepares a vehicle in the local player's colours once the view is shown, until it is ready", () => {
    const a = ahead();
    a.view.outOfSight = true;
    a.view.prepare(['HTNK']);
    a.view.stepAhead();
    // A mesh being built counts as art on its way: not before the view is shown.
    expect(a.view.aheadVoxels.size).toBe(1);
    a.view.outOfSight = false;
    a.view.stepAhead();
    const voxelUnits = (a.view as unknown as { voxelUnits: { prepare: ReturnType<typeof vi.fn> } }).voxelUnits;
    expect(voxelUnits.prepare).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'V' }),
      'lib:unit@live7',
      'HTNK@lib:unit@live7',
    );
    expect(a.view.aheadVoxels.size).toBe(1);
    a.prepared.ready = true;
    a.view.stepAhead();
    expect(a.view.aheadVoxels.size).toBe(0);
  });
});

describe('what an object turns into', () => {
  it('names the construction yard of every MCV and the refinery of the Slave Miner (stock rules DeploysInto)', () => {
    expect(Object.fromEntries(DEPLOY_TARGETS)).toEqual({
      AMCV: 'GACNST',
      SMCV: 'NACNST',
      PCV: 'YACNST',
      SMIN: 'YAREFN',
    });
    // A type named like an object member is not a deploying vehicle.
    expect(DEPLOY_TARGETS.get('constructor')).toBeUndefined();
  });

  it("is prepared when the object's visual is built: the yard's art loads while the MCV still drives", () => {
    const types = new Map<string, LibraryType>([
      ['SMCV', { kind: 'vehicle', image: 'SMCV', voxel: 'SMCV', drawOffset: [0, 0], lighting: 'ambient', remap: true }],
      ['HTNK', { kind: 'vehicle', image: 'HTNK', voxel: 'HTNK', drawOffset: [0, 0], lighting: 'ambient', remap: true }],
    ]);
    const view = Object.assign(Object.create(LiveView.prototype), {
      library: {
        type: (id: string) => types.get(id),
        voxel: () => null,
        voxelFailed: () => false,
        voxelType: () => undefined,
      },
      cache: { voxels: new Map(), manifest: { sprites: {} }, paletteRow: new Map() },
      voxelUnits: { geometryReady: () => false, built: () => false },
      libraryPaletteKeys: new Map(),
      warnedTypes: new Set(),
      options: {},
    }) as unknown as {
      buildVisual(object: LiveObject, paletteKey: string, firstFrame: number): unknown;
      prepare(types: Iterable<string>): void;
    };
    const prepare = vi.spyOn(view, 'prepare').mockImplementation(() => undefined);
    const unit = (type: string): LiveObject => ({
      id: 1,
      uid: 1,
      kind: 'vehicle',
      type,
      owner: 0,
      x: 0,
      y: 0,
      z: 0,
      facingRaw: 0,
      health: 1,
      isSelected: false,
    });
    view.buildVisual(unit('HTNK'), 'house0', 0);
    expect(prepare).not.toHaveBeenCalled();
    view.buildVisual(unit('SMCV'), 'house0', 0);
    expect(prepare.mock.calls).toEqual([[['NACNST']]]);
  });
});

describe('cell decorations that nothing announces', () => {
  const library = {
    overlays: {
      TIB01: { sprite: 'overlay:TIB01' },
      RUBBLE: { sprite: 'overlay:RUBBLE' },
      NOART: { sprite: 'overlay:NOART' },
      // A wall's art sits on a building page; the sidebar announces it.
      NAWALL: { sprite: 'overlay:NAWALL', wall: true },
    },
    smudges: { CRATER01: { sprite: 'smudge:CRATER01' }, BURNT01: { sprite: 'smudge:BURNT01' } },
    sprites: {
      'overlay:TIB01': { frames: [frame(0, 24), frame(1, 23)], shadows: [] },
      'overlay:RUBBLE': { frames: [frame(0, 25)], shadows: [frame(1, 25)] },
      'smudge:CRATER01': { frames: [frame(0, 29)] },
      'smudge:BURNT01': { frames: [frame(1, 28)] },
      'overlay:NAWALL': { frames: [frame(0, 1)] },
      // A building's art is not a cell decoration.
      'building:NAPOWR': { frames: [frame(0, 0)] },
    },
  } as unknown as Parameters<typeof cellArtPages>[0];

  it('lists every page of the overlay types that are not walls and of every smudge type, once, in page order', () => {
    expect(cellArtPages(library)).toEqual([23, 24, 25, 28, 29]);
    // A library extracted before overlays and smudges were added has none.
    expect(cellArtPages({ sprites: {} } as unknown as Parameters<typeof cellArtPages>[0])).toEqual([]);
  });

  it('has its indexed pages fetched when the view is created: rubble, a crater or a crate draws in its first frame', () => {
    const preloadPage = vi.fn(() => false);
    const view = Object.assign(Object.create(LiveView.prototype), { library: { library, preloadPage } }) as unknown as {
      preloadCellPages(): void;
    };
    view.preloadCellPages();
    // The indexed page alone (one argument): the HD art of such a page loads when a cell first uses it.
    expect(preloadPage.mock.calls).toEqual([[23], [24], [25], [28], [29]]);
    // Without a type library there is nothing to fetch.
    const bare = Object.assign(Object.create(LiveView.prototype), { library: null }) as unknown as {
      preloadCellPages(): void;
    };
    expect(() => bare.preloadCellPages()).not.toThrow();
  });
});

describe('pages of a live overlay type', () => {
  it('lists the pages its frames and shadows sit on, skipping empty frames and unknown types', () => {
    const library = {
      overlays: { NAWALL: { sprite: 'overlay:NAWALL' } },
      sprites: {
        'overlay:NAWALL': {
          frames: [frame(0, 6), frame(1, 5), { rect: [0, 0, 0, 0], offset: [0, 0], page: 9 }],
          shadows: [frame(2, 7)],
        },
      },
    } as unknown as Parameters<typeof overlayTypePages>[0];
    expect(overlayTypePages(library, 'NAWALL')).toEqual([5, 6, 7]);
    expect(overlayTypePages(library, 'NAPOWR')).toEqual([]);
    expect(overlayTypePages({ sprites: {} } as unknown as Parameters<typeof overlayTypePages>[0], 'NAWALL')).toEqual(
      [],
    );
  });
});
