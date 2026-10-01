import { describe, expect, it, vi } from 'vitest';
import { Group, Mesh, Texture, Vector3 } from 'three/webgpu';
import { LiveView, type LiveObject, type LiveSnapshot } from '../src/live/liveView';
import type { EffectInstance } from '../src/live/effectSprites';
import { SpritePool } from '../src/live/spritePool';
import { VoxelUnits } from '../src/live/voxelUnits';
import type { Ra2Cache } from '../src/ra2/cache';
import { SpriteLayer } from '../src/ra2/sprites';
import { VoxelUnit } from '../src/ra2/voxels';
import { VolumetricBlastLayer } from '../src/volumetricBlasts';
import { IsoCamera } from '../src/world';

const object = (x: number): LiveObject => ({
  id: 1,
  uid: 1,
  kind: 'vehicle',
  type: 'TEST',
  owner: -1,
  x,
  y: 256,
  z: 0,
  facingRaw: 0,
  health: 1,
  isSelected: false,
  renderOrder: { layer: 2, index: 1, ySort: x + 256 },
});
const snapshot = (frame: number, x: number): LiveSnapshot => ({
  frame,
  view: { x, y: 0 },
  houses: [],
  objects: [object(x)],
});

/** Real push, render, applyCamera, applyObjects, applyEffects and applyPainterOrder; only resource/GPU edges are fakes. */
function presentation() {
  const frame = { rect: [0, 0, 16, 24] as [number, number, number, number], offset: [-8, -18] as [number, number] };
  const cache = {
    manifest: {
      sprites: { 'building:TESTBUILD': { frames: [frame], palette: 'unit', foundation: [4, 4] } },
      spriteAtlas: { width: 64, height: 64 },
    },
    paletteAtlas: { image: { height: 1 } },
    spriteAtlas: new Texture(),
    paletteRow: new Map([['unit', 0]]),
  } as unknown as Ra2Cache;
  const staticCards = new SpriteLayer(cache, [
    { anchor: new Vector3(), frame, palette: 'unit', push: 0.2, shadow: false },
  ]);
  const cellLayer = new SpriteLayer(cache, []);
  const overlayLayer = new SpriteLayer(cache, []);
  const sprites = new SpriteLayer(cache, [], 8);
  const root = new VoxelUnit();
  const mesh = new Mesh();
  root.addSourceMesh(mesh);
  const visual = { root, mode: 'voxel', type: 'TEST', paletteKey: '', firstFrame: 1 };
  const shroud = { hidden: false, isLocationShrouded: () => shroud.hidden };
  const effectDriver = {
    frame: vi.fn(),
    cards: vi.fn(() => ({ drawn: 0, missing: 0 })),
    smokeCards: vi.fn(),
    volumes: vi.fn(),
  };
  const effectSprites = { setInstances: vi.fn(), now: { value: 0 }, displayScale: { value: 1 } };
  const hd = {
    seconds: () => 1,
    meanExposure: 2,
    frame: vi.fn(),
    windowsWanted: () => false,
    materialsWanted: () => false,
    view: new IsoCamera(),
  };
  const effectArt = { revision: 0, particle: () => ({ sprite: { frames: [frame] }, art: { translucency: 0 } }) };
  const state = {
    current: null as null | { snapshot: LiveSnapshot; at: number; byUid: Map<number, LiveObject> },
    previous: null as null | { snapshot: LiveSnapshot; at: number; byUid: Map<number, LiveObject> },
    appearances: new Map(),
    houseColour: new Map(),
    housePaletteKeys: new Map(),
    buildingAnimMatches: new Map(),
    library: null as null | { revision: number },
    cache,
    hd,
    shroud,
    effectDriver,
    volumetricBlasts: new VolumetricBlastLayer({ light: staticCards.light, sunDirection: staticCards.toCamera }),
    volumeInstances: [],
    effectSprites,
    effectArt,
    warnedCells: true,
    visuals: new Map([[1, visual]]),
    root: new Group(),
    world: { sprites: staticCards, terrain: { heightAt: () => 0 } },
    sprites,
    cellLayer,
    cellInstances: [],
    overlayLayers: new Map([[0, overlayLayer]]),
    overlayInstances: { instances: { pages: new Map() } },
    pageLayers: new Map(),
    spriteBatch: new Map(),
    spritePool: new SpritePool(),
    particlePool: new SpritePool(),
    effectInstances: [] as EffectInstance[],
    painterObjects: [],
    painterDirty: false,
    effectsDirty: false,
    pose: { x: 0, y: 0, z: 0, facing: 0 },
    voxelUnits: { pose: VoxelUnits.prototype.pose, setPainterBias: VoxelUnits.prototype.setPainterBias },
    viewWidth: 0,
    viewHeight: 0,
    lastRender: 0,
    cellsDirty: false,
    ensureHouse: vi.fn(),
    updateOverlays: vi.fn(),
    updateSmudges: vi.fn(),
    updateNightSources: vi.fn(),
  };
  const view = Object.assign(Object.create(LiveView.prototype), state) as LiveView;
  const live = view as unknown as typeof state & {
    applyPainterOrder(): void;
    applyEffects(snapshot: LiveSnapshot): void;
    particleCards(effects: NonNullable<LiveSnapshot['effects']>, out: EffectInstance[]): void;
  };
  const order = vi.spyOn(live, 'applyPainterOrder');
  const uploads = [staticCards, cellLayer, overlayLayer].map((layer) => vi.spyOn(layer, 'setInstances'));
  return { view, live, visual, mesh, order, uploads, effectSprites, effectDriver, effectArt, hd, shroud };
}

describe('LiveView physical occlusion scheduling', () => {
  it('runs real object and painter updates only on changed inputs while units still interpolate each presentation', () => {
    const p = presentation();
    const withBuilding = (frame: number, x: number) => {
      const snap = snapshot(frame, x);
      snap.objects.push({ ...object(512), uid: 2, type: 'TESTBUILD', kind: 'building' });
      return snap;
    };
    const sort = vi.spyOn((p.live.sprites as unknown as { orderedCards: unknown[] }).orderedCards, 'sort');
    p.view.push(withBuilding(1, 256), 0);
    p.view.render(0);
    expect(p.effectSprites.displayScale.value).toBeCloseTo(1 / p.hd.meanExposure);
    p.view.push(withBuilding(2, 356), 100);
    p.view.render(120);
    expect(p.visual.root.position.x).toBeCloseTo(276 / 256);
    const bias = p.mesh.userData.painterDepth.bias;
    const count = p.order.mock.calls.length;
    const sorts = sort.mock.calls.length;
    expect(sorts).toBeGreaterThan(0);
    p.effectSprites.setInstances.mockClear();
    p.hd.seconds = () => 1.5;
    for (const [at, exposure] of [
      [140, 2],
      [160, 0.5],
      [180, 4],
      [200, 1],
    ] as const) {
      p.hd.meanExposure = exposure;
      p.view.render(at);
      expect(p.effectSprites.displayScale.value).toBeCloseTo(1 / exposure);
    }
    expect(p.visual.root.position.x).toBeCloseTo(356 / 256);
    expect(p.order).toHaveBeenCalledTimes(count);
    expect(sort).toHaveBeenCalledTimes(sorts);
    expect(p.mesh.userData.painterDepth.bias).toBe(bias);
    expect(p.effectSprites.setInstances).not.toHaveBeenCalled();
    expect(p.effectSprites.now.value).toBe(p.hd.seconds());
    for (const upload of p.uploads) expect(upload).not.toHaveBeenCalled();
    p.effectArt.revision++;
    p.view.render(210);
    expect(p.order).toHaveBeenCalledTimes(count + 1);
    expect(p.effectSprites.setInstances).toHaveBeenCalledTimes(1);
    for (const upload of p.uploads) expect(upload).not.toHaveBeenCalled();
  });

  it('updates same-frame registration in place without snapping units or a scrolling camera', () => {
    const p = presentation();
    p.view.push(snapshot(1, 256), 0);
    p.view.push(snapshot(2, 356), 100);
    p.view.render(125);
    const bias = p.mesh.userData.painterDepth.bias;
    const current = p.live.current;
    const previous = p.live.previous;
    const reordered = snapshot(2, 356);
    reordered.objects[0]!.renderOrder!.index = 8;
    p.view.push(reordered, 140);
    p.view.render(150);
    expect(p.live.current).toBe(current);
    expect(p.live.previous).toBe(previous);
    expect(p.live.current?.at).toBe(100);
    expect(p.visual.root.position.x).toBeCloseTo(306 / 256);
    expect(p.hd.view.target.x).toBeCloseTo(306 / 60);
    expect(p.live.current?.byUid.get(1)?.renderOrder?.index).toBe(8);
    expect(p.live.current?.byUid.get(1)?.x).toBe(356);
    expect(p.mesh.userData.painterDepth.bias).toBeGreaterThan(bias);
    p.view.push(snapshot(3, 456), 200);
    p.view.render(250);
    expect(p.visual.root.position.x).toBeCloseTo(406 / 256);
    expect(p.hd.view.target.x).toBeCloseTo(406 / 60);
  });

  it('updates a same-frame pose endpoint without restarting interpolation', () => {
    const p = presentation();
    p.view.push(snapshot(1, 256), 0);
    p.view.push(snapshot(2, 356), 100);
    p.view.push(snapshot(2, 456), 140);
    p.view.render(150);
    expect(p.live.current?.at).toBe(100);
    expect(p.live.previous?.snapshot.objects[0]!.x).toBe(256);
    expect(p.visual.root.position.x).toBeCloseTo(356 / 256);
    p.view.render(200);
    expect(p.visual.root.position.x).toBeCloseTo(456 / 256);
  });

  it('keeps shrouded-anchor art for the per-pixel mask and still hides InvisibleInGame types', () => {
    const p = presentation();
    p.view.push(snapshot(1, 256), 0);
    p.view.render(0);
    p.shroud.hidden = true;
    p.view.push(snapshot(2, 256), 100);
    p.view.render(100);
    expect(p.visual.root.visible).toBe(true);
    expect(p.live.painterObjects).toHaveLength(1);
    p.shroud.hidden = false;
    p.view.push(snapshot(3, 256), 200);
    p.view.render(200);
    expect(p.visual.root.visible).toBe(true);
    expect(p.live.painterObjects).toHaveLength(1);
    Object.assign(p.visual, { libraryType: { invisible: true } });
    p.view.push(snapshot(4, 256), 300);
    p.view.render(300);
    expect(p.visual.root.visible).toBe(false);
    expect(p.live.painterObjects).toHaveLength(0);
    for (const upload of p.uploads) expect(upload).not.toHaveBeenCalled();
  });

  it('sweeps old native projectiles when the effects publication becomes unavailable', () => {
    const p = presentation();
    const update = vi.fn();
    Object.assign(p.live, { projectiles: { update } });
    const snap = snapshot(1, 256);
    const bullets = [{ id: 2, uid: 2, type: 'TEST', x: 0, y: 0, z: 0 }];
    p.live.applyEffects({ ...snap, effects: { anims: [], bullets, particleSystems: [] } });
    expect(update.mock.calls[0]![0]).toBe(bullets);
    p.live.applyEffects({ ...snap, effects: null });
    expect(update.mock.calls[1]!.slice(0, 2)).toEqual([[], []]);
  });

  it('keeps particle positions when an object/turret rebuild borrows more sprite anchors', () => {
    const p = presentation();
    const effects = { particleSystems: [{ particles: [{ type: 'TEST', x: 256, y: 512, z: 104 }] }] } as NonNullable<
      LiveSnapshot['effects']
    >;
    p.live.particleCards(effects, p.live.effectInstances);
    const particle = p.live.effectInstances[0]!;
    const original = particle.anchor.clone();
    p.live.spritePool.begin();
    for (let i = 0; i < 20; i++) p.live.spritePool.anchor().set(100 + i, 200, 300);
    p.live.effectsDirty = true;
    p.live.applyPainterOrder();
    expect(particle.anchor.equals(original)).toBe(true);
    expect(p.effectSprites.setInstances).toHaveBeenCalledWith(p.live.effectInstances, 1);
  });
});
