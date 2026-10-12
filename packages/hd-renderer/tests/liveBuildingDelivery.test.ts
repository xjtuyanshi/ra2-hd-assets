import { describe, expect, it, vi } from 'vitest';
import { Group } from 'three/webgpu';
import { painterObject } from '../src/ra2/painterOrder';
import type { SpriteInstance } from '../src/ra2/sprites';
import type { LibraryType } from '../../ra2-assets/src/library';
import type { SpriteEntry, SpriteFrame } from '../../ra2-assets/src/manifest';
import { LiveView, type LiveObject, type LiveSnapshot } from '../src/live/liveView';
import { BuildingVisualHistory } from '../src/live/buildingVisualHistory';
import { SpritePool } from '../src/live/spritePool';

/** Real libraryBuildingSprites, buildup, layer, palette and queue paths; no GPU or game assets. */
function deliveryView() {
  let rectX = 0;
  const frame = (): SpriteFrame => ({ rect: [rectX++, 0, 32, 64], offset: [-16, -48], page: 0 });
  const sprite = (): SpriteEntry => ({
    frames: [frame(), frame()],
    shadows: [frame(), frame()],
    canvas: [32, 64],
    palette: 'unit',
    remap: true,
  });
  const sprites: Record<string, SpriteEntry> = Object.fromEntries(
    ['body', 'deploy', 'door', 'roofDeploy', 'roofDoor', 'bib', 'active', 'make'].map((id) => [id, sprite()]),
  );
  const type: LibraryType = {
    kind: 'building',
    image: 'TEST',
    sprite: 'body',
    foundation: [5, 3],
    drawOffset: [0, 0],
    lighting: 'ambient',
    remap: true,
    building: {
      bodyFrames: 2,
      bib: 'bib',
      buildup: 'make',
      layers: [
        { key: 'DeployingAnim', sprite: 'deploy', anim: {} },
        { key: 'UnderDoorAnim', sprite: 'door', anim: {} },
        { key: 'RoofDeployingAnim', sprite: 'roofDeploy', anim: {} },
        { key: 'UnderRoofDoorAnim', sprite: 'roofDoor', anim: {} },
        { key: 'ActiveAnim', sprite: 'active', anim: {} },
      ],
    },
  };
  const painter = { ...painterObject(2, 0, 0), x: 10, z: 20, foundation: type.foundation };
  const pool = new SpritePool();
  const state = {
    library: { library: { sprites }, conditionYellow: 0.5, page: () => ({}), hasHdPage: () => false },
    cache: { paletteRow: new Map([['lib:unit@house0', 1]]), depthTemplate: { width: 396, height: 477 } },
    libraryPaletteKeys: new Map(),
    spritePool: pool,
    civilian: new Set(),
    appearances: new Map(),
    buildingAnimMatches: new Map(),
    firstFrame: 0,
  };
  const visual = { root: new Group(), libraryType: type, paletteKey: 'house0', firstFrame: 0 };
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
    buildState: 'done',
    buildingFrame: 0,
    buildingDamaged: false,
  };
  const view = Object.assign(Object.create(LiveView.prototype), state) as {
    libraryBuildingSprites(
      object: LiveObject,
      visual: unknown,
      batch: Map<number, SpriteInstance[]>,
      snapshot: LiveSnapshot,
    ): boolean;
    queue(batch: Map<number, SpriteInstance[]>, instance: SpriteInstance, indexed?: boolean): void;
  };
  const queued = vi.spyOn(view, 'queue');
  const draw = (frame = 0) => {
    pool.begin();
    pool.painter = painter;
    queued.mockClear();
    const batch = new Map<number, SpriteInstance[]>();
    view.libraryBuildingSprites(object, visual, batch, { frame, houses: [], objects: [object] });
    return { batch, cards: queued.mock.calls.map((call) => call[1]) };
  };
  return { object, type, sprites, painter, state, visual, view, draw, queued };
}

describe('live delivery building image', () => {
  it('swaps to and from the delivery pair one logic frame after the published state', () => {
    const h = deliveryView();
    const history = new BuildingVisualHistory();
    Object.assign(h.view, { buildingVisualHistory: history });
    const bodies = (frame: number, unloading?: 'door') => {
      h.object.unloading = unloading;
      history.update({ frame, houses: [], objects: [{ ...h.object }], view: null });
      const cards = h.draw(frame).cards;
      return { body: cards[2]!.frame, depth: cards[2]!.nativeDepth, count: cards.length };
    };
    const closed = { body: h.sprites.body!.frames[0], count: 4 };
    const open = { body: h.sprites.deploy!.frames[0], count: 5 };
    expect(bodies(20)).toMatchObject(closed);
    // State enters Unload: the ordinary body, its depth and no interior card for one more frame.
    const first = bodies(21, 'door');
    expect(first).toMatchObject(closed);
    expect(first.depth).toMatchObject({ mode: 'body', base: 16 });
    const second = bodies(22, 'door');
    expect(second).toMatchObject(open);
    expect(second.depth).toMatchObject({ mode: 'body', base: 36 });
    // State leaves Unload: the delivery pair stays for one more frame.
    expect(bodies(23)).toMatchObject(open);
    expect(bodies(24)).toMatchObject(closed);
  });

  it.each(['door', 'roof'] as const)(
    'replaces body and shadow with the %s pair, before ordinary active layers',
    (unloading) => {
      const h = deliveryView();
      h.object.unloading = unloading;
      const deploy = h.sprites[unloading === 'roof' ? 'roofDeploy' : 'deploy']!;
      const door = h.sprites[unloading === 'roof' ? 'roofDoor' : 'door']!;
      const { cards } = h.draw();
      expect(cards.map((card) => card.frame)).toEqual([
        h.sprites.bib!.frames[0],
        deploy.shadows![0],
        deploy.frames[0],
        door.frames[0],
        h.sprites.active!.frames[0],
      ]);
      const body = cards[2]!;
      const section = cards[3]!;
      expect(section.anchor.equals(body.anchor)).toBe(true);
      expect(section.push).toBe(body.push);
      expect(section.painter).toBe(body.painter);
      expect(section.painter!.foundation).toEqual([5, 3]);
      expect(section.painterPart).toBe(body.painterPart);
      expect(section.palette).toBe('lib:unit@house0');
      expect(body.palette).toBe(section.palette);
      expect(cards[1]).toMatchObject({ shadow: true, flat: true });
      expect(body).toMatchObject({ shadow: false, flat: false });
      expect(cards.map((card) => card.nativeDepth?.mode)).toEqual(['ground', undefined, 'body', 'ground', 'body']);
      expect(cards[0]!.nativeDepth).toEqual({ mode: 'ground', bonus: 2 });
      expect(section.nativeDepth).toEqual({ mode: 'ground', bonus: 1 });
      expect(body.nativeDepth).toMatchObject({
        mode: 'body',
        origin: [138, 356],
        base: unloading === 'roof' ? 56 : 36,
      });
      expect(cards[4]!.nativeDepth).toMatchObject(body.nativeDepth!);
    },
  );

  it.each(['unit', 'iso', 'lib'] as const)(
    'keeps the %s building source palette contract for body, bib, layers and buildup',
    (palette) => {
      const h = deliveryView();
      h.state.cache.paletteRow.set(`lib:${palette}`, 2);
      h.state.cache.paletteRow.set(`lib:${palette}@house0`, 3);
      for (const art of Object.values(h.sprites)) {
        art.palette = palette;
        art.remap = false;
      }
      const expected = palette === 'iso' ? 'lib:iso' : `lib:${palette}@house0`;
      for (const state of ['done', 'building'] as const) {
        h.object.buildState = state;
        h.object.buildupFrame = state === 'building' ? 0 : undefined;
        const cards = h.draw().cards.filter((card) => !card.shadow);
        expect(cards.length).toBeGreaterThan(0);
        expect(cards.every((card) => card.palette === expected)).toBe(true);
        expect(cards.every((card) => card.indexedHousePaint === (palette !== 'iso'))).toBe(true);
      }
    },
  );

  it('keeps legacy building profiles only when the template is absent', () => {
    const h = deliveryView();
    h.object.unloading = 'door';
    delete (h.state.cache as { depthTemplate?: unknown }).depthTemplate;
    expect(h.draw().cards.every((card) => card.nativeDepth === undefined)).toBe(true);
  });

  it('translates attached layers to the current body origin and bottom, including YDrawOffset', () => {
    const h = deliveryView();
    h.type.building!.zShape = { pointMove: [30, 15], normalZAdjust: 4 };
    const active = h.type.building!.layers.find((layer) => layer.key === 'ActiveAnim')!;
    active.offset = [12, -9];
    active.yDrawOffset = 3;
    const cards = h.draw().cards;
    const body = cards[2]!;
    const layer = cards[3]!;
    expect(body.nativeDepth).toMatchObject({ mode: 'body', origin: [168, 371], base: 12 });
    expect(layer.nativeDepth).toMatchObject({ mode: 'body', origin: [168, 371], base: 12, offset: [12, -6] });
    expect(layer.anchor.x - body.anchor.x).toBeCloseTo(0);
    expect(layer.anchor.z - body.anchor.z).toBeCloseTo(-0.4);
  });

  it('draws DoorAnim with native ground depth without writing unit-occluding depth', () => {
    const h = deliveryView();
    h.type.building!.layers.push({ key: 'DoorAnim', sprite: 'active', anim: {} });
    Object.assign(h.view, {
      buildingAnims: { attached: new Map([[1, [[0, { type: 'active', frame: 0 }]]]]), cells: new Map() },
    });
    // Resolve a unique DoorAnim image through the native animation path.
    h.type.building!.layers = h.type.building!.layers.filter((layer) => layer.key !== 'ActiveAnim');
    const card = h.draw().cards.at(-1)!;
    expect(card.nativeDepth).toEqual({ mode: 'ground', bonus: 6 });
    expect(card.depthWrite).toBe(false);
  });

  it.each(['door', 'roof'] as const)(
    'uses the inclusive native %s frame cap and independently selects yellow damage',
    (unloading) => {
      const h = deliveryView();
      h.object.unloading = unloading;
      h.object.buildingFrame = 99;
      h.object.buildingDamaged = true;
      const deploy = h.sprites[unloading === 'roof' ? 'roofDeploy' : 'deploy']!;
      const door = h.sprites[unloading === 'roof' ? 'roofDoor' : 'door']!;
      expect(
        h
          .draw()
          .cards.map((card) => card.frame)
          .slice(0, 4),
      ).toEqual([h.sprites.bib!.frames[1], deploy.shadows![0], door.frames[1], h.sprites.active!.frames[0]]);
      door.frames.length = 1;
      expect(h.draw().cards[2]!.frame).toBe(door.frames[0]);
    },
  );

  it('keeps the delivery image and native stage after contact release, until unloading ends', () => {
    const h = deliveryView();
    h.object.unloading = 'door';
    h.object.contactUid = 99;
    h.object.buildingFrame = 1;
    const original = h.draw().cards.map((card) => card.frame);
    delete h.object.contactUid;
    expect(h.draw().cards.map((card) => card.frame)).toEqual(original);
    expect(original).toContain(h.sprites.deploy!.frames[1]);
    delete h.object.unloading;
    expect(h.draw().cards.map((card) => card.frame)).toContain(h.sprites.body!.frames[1]);
  });

  it('follows repeated and changing native frames through a long hold and close without running a door clock', () => {
    const h = deliveryView();
    // Ordinary attached animations keep their own clocks; this fixture isolates the replacement body/door.
    h.type.building!.layers = h.type.building!.layers.filter((layer) => layer.key !== 'ActiveAnim');
    h.object.unloading = 'door';
    h.object.contactUid = 99;
    h.object.buildingFrame = 0;
    const opening = h.draw(100).cards.map((card) => card.frame);
    expect(opening).toContain(h.sprites.deploy!.frames[0]);
    expect(h.draw(140).cards.map((card) => card.frame)).toEqual(opening);

    h.object.buildingFrame = 1;
    const held = h.draw(140).cards.map((card) => card.frame);
    expect(held).toContain(h.sprites.deploy!.frames[1]);
    expect(held).toContain(h.sprites.door!.frames[0]);
    delete h.object.contactUid;
    for (const frame of [141, 180, 1000]) expect(h.draw(frame).cards.map((card) => card.frame)).toEqual(held);

    // Only the next native stage changes the body, even at the same published logic frame.
    h.object.buildingFrame = 0;
    expect(h.draw(1000).cards.map((card) => card.frame)).toEqual(opening);
    delete h.object.unloading;
    const closed = h.draw(1000).cards.map((card) => card.frame);
    expect(closed).toContain(h.sprites.body!.frames[0]);
    expect(closed).not.toContain(h.sprites.deploy!.frames[0]);
    expect(closed).not.toContain(h.sprites.door!.frames[0]);
  });

  it('halves the complete source count when delivery art has no extracted shadow half', () => {
    const h = deliveryView();
    h.object.unloading = 'door';
    h.object.buildingFrame = 99;
    const deploy = h.sprites.deploy!;
    deploy.frames.push(...deploy.shadows!);
    delete deploy.shadows;
    expect(h.draw().cards[1]!.frame).toBe(deploy.frames[2]);
  });

  it('draws the inclusive source-shadow boundary from indexed art even when its HD atlas rectangle is empty', () => {
    const h = deliveryView();
    h.object.unloading = 'door';
    h.object.buildingFrame = 99;
    h.sprites.deploy!.frameCount = 4;
    h.state.library.hasHdPage = () => true;
    const { batch } = h.draw();
    const cap = batch.get(-1)!.find((card) => card.frame === h.sprites.deploy!.shadows![0]);
    expect(cap).toMatchObject({ shadow: false });
    expect(batch.get(0)?.some((card) => card.frame === cap!.frame)).toBe(false);
  });

  it('keeps the normal body/shadow when unloading is absent and restores it when delivery ends', () => {
    const h = deliveryView();
    const normal = () =>
      expect(h.draw().cards.map((card) => card.frame)).toEqual([
        h.sprites.bib!.frames[0],
        h.sprites.body!.shadows![0],
        h.sprites.body!.frames[0],
        h.sprites.active!.frames[0],
      ]);
    normal();
    h.object.unloading = 'door';
    h.draw();
    delete h.object.unloading;
    normal();
  });

  it.each(['DeployingAnim', 'UnderDoorAnim', 'RoofDeployingAnim', 'UnderRoofDoorAnim'])(
    'falls back as a pair when %s art is missing',
    (key) => {
      const h = deliveryView();
      h.object.unloading = key.includes('Roof') ? 'roof' : 'door';
      const missing = h.type.building!.layers.find((layer) => layer.key === key)!;
      delete h.sprites[missing.sprite];
      expect(h.draw().cards.map((card) => card.frame)).toEqual([
        h.sprites.bib!.frames[0],
        h.sprites.body!.shadows![0],
        h.sprites.body!.frames[0],
        h.sprites.active!.frames[0],
      ]);
    },
  );

  it('uses HD replacement foregrounds with indexed house paint and retains source shadows', () => {
    const h = deliveryView();
    h.object.unloading = 'door';
    h.sprites.deploy!.remap = false;
    h.sprites.door!.remap = false;
    h.state.library.hasHdPage = () => true;
    const { batch } = h.draw();
    expect(batch.get(-1)!.map((card) => card.frame)).toEqual([h.sprites.deploy!.shadows![0]]);
    for (const art of [h.sprites.deploy!, h.sprites.door!]) {
      expect(batch.get(0)!.find((card) => card.frame === art.frames[0])).toMatchObject({
        palette: 'lib:unit@house0',
        indexedHousePaint: true,
      });
    }
    h.sprites.door!.frames.length = 0;
    expect(h.draw().cards[2]!.frame).toBe(h.sprites.body!.frames[0]);
  });

  it('keeps non-remappable bodies, bibs, layers and make art in HD under neutral and captured house palettes', () => {
    const h = deliveryView();
    for (const sprite of Object.values(h.sprites)) sprite.remap = false;
    h.state.library.hasHdPage = () => true;
    for (const owner of ['neutral', 'capturingHouse']) {
      h.state.cache.paletteRow.set(`lib:unit@${owner}`, 2);
      h.visual.paletteKey = owner;
      for (const building of [false, true]) {
        h.object.buildState = building ? 'building' : 'done';
        h.object.buildupFrame = building ? 0 : undefined;
        const { batch, cards } = h.draw();
        const foregrounds = cards.filter((card) => !card.shadow);
        expect(foregrounds).toHaveLength(building ? 1 : 3);
        expect(batch.get(-1)!.every((card) => card.shadow)).toBe(true);
        expect(batch.get(0)).toEqual(foregrounds);
        for (const card of foregrounds) {
          expect(card).toMatchObject({ palette: `lib:unit@${owner}`, indexedHousePaint: true });
        }
      }
    }
  });

  it.each(['building', 'selling'] as const)(
    'retains make frames during %s even with delivery metadata',
    (buildState) => {
      const h = deliveryView();
      h.object.unloading = 'door';
      h.object.buildState = buildState;
      h.object.buildupFrame = 1;
      h.type.building!.zShape = { pointMove: [30, 15], normalZAdjust: 4 };
      expect(h.draw().cards[1]!.nativeDepth).toMatchObject({ mode: 'body', origin: [138, 356], base: 12 });
      expect(h.draw().cards.map((card) => card.frame)).toEqual([
        h.sprites.make!.shadows![1],
        h.sprites.make!.frames[1],
      ]);
    },
  );

  it('does not substitute delivery art for known construction without make art', () => {
    const h = deliveryView();
    h.object.unloading = 'door';
    h.object.buildState = 'building';
    delete h.type.building!.buildup;
    expect(h.draw().cards[2]!.frame).toBe(h.sprites.body!.frames[0]);
  });
});
