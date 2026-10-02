import { describe, expect, it, vi } from 'vitest';
import { Group } from 'three/webgpu';
import type { LibraryType } from '../../ra2-assets/src/library';
import type { SpriteEntry, SpriteFrame } from '../../ra2-assets/src/manifest';
import { LiveView, type LiveObject, type LiveSnapshot } from '../src/live/liveView';
import { SpritePool } from '../src/live/spritePool';
import { cardDepthPush } from '../src/ra2/cardDepth';
import { painterObject } from '../src/ra2/painterOrder';
import type { SpriteInstance } from '../src/ra2/sprites';

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
    cache: { paletteRow: new Map([['lib:unit@house0', 1]]) },
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
  const draw = () => {
    pool.begin();
    pool.painter = painter;
    queued.mockClear();
    const batch = new Map<number, SpriteInstance[]>();
    view.libraryBuildingSprites(object, visual, batch, { frame: 0, houses: [], objects: [object] });
    return { batch, cards: queued.mock.calls.map((call) => call[1]) };
  };
  return { object, type, sprites, painter, state, draw, queued };
}

describe('live delivery building image', () => {
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
      // Both cards sample the same foundation profile: a unit inside remains behind it, then emerges in front.
      for (const [x, z, hidden] of [
        [12.5, 21.5, true],
        [15.5, 21.5, false],
      ] as const) {
        const px = (x - body.anchor.x - (z - body.anchor.z)) * 30;
        const py = (x - body.anchor.x + z - body.anchor.z) * 15 - 0.3 * Math.cos(Math.PI / 6) * (60 / Math.SQRT2);
        const bodyDepth = cardDepthPush(
          px,
          py,
          5,
          3,
          body.anchor.x - body.anchor.z - h.painter.x + h.painter.z,
          h.painter.x + h.painter.z - body.anchor.x - body.anchor.z,
        );
        const unitDepth = (x + z - body.anchor.x - body.anchor.z) * Math.sqrt(3 / 8) + 0.3 * 0.5 + 0.035;
        expect(bodyDepth > unitDepth).toBe(hidden);
      }
    },
  );

  it.each(['door', 'roof'] as const)(
    'clamps the %s body/shadow frame and independently selects yellow damage',
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
      ).toEqual([h.sprites.bib!.frames[1], deploy.shadows![1], deploy.frames[1], door.frames[1]]);
      door.frames.length = 1;
      expect(h.draw().cards[3]!.frame).toBe(door.frames[0]);
    },
  );

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

  it('retains palette/remap routing for replacement images and clamps empty pairs to the normal body', () => {
    const h = deliveryView();
    h.object.unloading = 'door';
    h.sprites.deploy!.remap = false;
    h.sprites.door!.remap = false;
    h.state.library.hasHdPage = () => true;
    const { batch } = h.draw();
    expect(batch.get(-1)!.map((card) => card.frame)).toEqual([
      h.sprites.deploy!.shadows![0],
      h.sprites.deploy!.frames[0],
      h.sprites.door!.frames[0],
    ]);
    for (const card of batch.get(-1)!) expect(card.palette).toBe('lib:unit@house0');
    h.sprites.door!.frames.length = 0;
    expect(h.draw().cards[2]!.frame).toBe(h.sprites.body!.frames[0]);
  });

  it.each(['building', 'selling'] as const)(
    'retains make frames during %s even with delivery metadata',
    (buildState) => {
      const h = deliveryView();
      h.object.unloading = 'door';
      h.object.buildState = buildState;
      h.object.buildupFrame = 1;
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
