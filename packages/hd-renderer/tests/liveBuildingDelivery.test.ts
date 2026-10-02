import { describe, expect, it, vi } from 'vitest';
import { Group, Texture, Vector3 } from 'three/webgpu';
import type { LibraryType } from '../../ra2-assets/src/library';
import type { SpriteEntry, SpriteFrame } from '../../ra2-assets/src/manifest';
import { DOOR_RECESS, LiveView, type LiveObject, type LiveSnapshot } from '../src/live/liveView';
import { SpritePool } from '../src/live/spritePool';
import { cardDepthPush } from '../src/ra2/cardDepth';
import { assignPainterBias, painterObject, spritePainterBias } from '../src/ra2/painterOrder';
import { SpriteLayer, type SpriteInstance } from '../src/ra2/sprites';
import type { Ra2Cache } from '../src/ra2/cache';
import type { DirtyAttribute } from '../src/dirtyAttribute';
import { biasedDepth } from '../src/painterDepth';
import { IsoCamera, PIXELS_PER_CELL_EDGE } from '../src/world';
import { VOXEL_CLEARANCE } from '../src/ra2/voxels';

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
      expect(DOOR_RECESS).toBe(2);
      expect(cards.map((card) => card.foundationRecess)).toEqual([0, 0, 0, 2, 0]);
      // The deploying body retains its facade: a unit inside remains behind opaque posts, then emerges in front.
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
    'fits the %s recess to the frozen factory delivery positions while retaining facade and ground depth',
    (unloading) => {
      const h = deliveryView();
      Object.assign(h.object, { x: 58.5 * 256, y: 98.5 * 256, unloading });
      Object.assign(h.painter, { x: 58, z: 98 });
      h.type.drawOffset = [0, -15];
      // Wide synthetic cards cover the tested column and rows; no private factory pixels are required.
      for (const id of ['deploy', 'door', 'roofDeploy', 'roofDoor']) {
        Object.assign(h.sprites[id]!.frames[0]!, { rect: [0, 0, 360, 300], offset: [-120, -140] });
      }
      const { cards } = h.draw();
      const body = cards[2]!;
      const door = cards[3]!;
      expect(body.anchor.toArray()).toEqual([58, 0, 98]);
      const unitPainter = { ...painterObject(2, 0, 56), x: 60.5, z: 99.5 };
      assignPainterBias([h.painter, unitPainter]);
      const unit: SpriteInstance = {
        anchor: new Vector3(unitPainter.x, 0, unitPainter.z),
        frame: { rect: [0, 0, 21, 30], offset: [-10, -25] },
        palette: 'unit',
        push: 0.4,
        shadow: false,
        painter: unitPainter,
      };
      const atlas = new Texture();
      const layer = new SpriteLayer(
        {
          paletteAtlas: { image: { height: 1 } },
          paletteRow: new Map(),
          manifest: { spriteAtlas: { width: 512, height: 512 } },
          spriteAtlas: atlas,
        } as unknown as Ra2Cache,
        [body, door, unit],
      );
      const uploaded = layer as unknown as {
        params: DirtyAttribute;
        flags: DirtyAttribute;
        orderedCards: SpriteInstance[];
      };
      const camera = new IsoCamera();
      camera.target.copy(body.anchor);
      camera.update();
      const range = camera.camera.far - camera.camera.near;
      const right = new Vector3().setFromMatrixColumn(camera.camera.matrixWorld, 0);
      const up = new Vector3().setFromMatrixColumn(camera.camera.matrixWorld, 1);
      const toward = new Vector3().setFromMatrixColumn(camera.camera.matrixWorld, 2);
      const screen = (p: Vector3): [number, number] => [30 * (p.x - p.z), 15 * (p.x + p.z)];
      const physical = (p: Vector3) =>
        (-p.clone().applyMatrix4(camera.camera.matrixWorldInverse).z - camera.camera.near) / range;
      const depth = (s: SpriteInstance, pixel: [number, number]) => {
        const i = uploaded.orderedCards.indexOf(s);
        const at = screen(s.anchor);
        const px = pixel[0] - at[0];
        const py = pixel[1] - at[1];
        const placement = uploaded.params.array[i * 4 + 3]!;
        const placed = s.anchor
          .clone()
          .addScaledVector(right, px / PIXELS_PER_CELL_EDGE)
          .addScaledVector(up, -py / PIXELS_PER_CELL_EDGE)
          .addScaledVector(toward, placement);
        const [w, sizeH, dx, ds] = Array.from(uploaded.flags.array.slice(i * 8 + 4, i * 8 + 8));
        return biasedDepth(
          physical(placed),
          cardDepthPush(px, py, w, sizeH, dx, ds) - placement + uploaded.flags.array[i * 8 + 3]!,
          range,
        );
      };
      const expectCovered = (s: SpriteInstance, pixel: [number, number]) => {
        const at = screen(s.anchor);
        expect(pixel[0] - at[0]).toBeGreaterThanOrEqual(s.frame.offset[0]);
        expect(pixel[0] - at[0]).toBeLessThan(s.frame.offset[0] + s.frame.rect[2]);
        expect(pixel[1] - at[1]).toBeGreaterThanOrEqual(s.frame.offset[1]);
        expect(pixel[1] - at[1]).toBeLessThan(s.frame.offset[1] + s.frame.rect[3]);
      };
      try {
        for (const s of [body, door]) {
          const i = uploaded.orderedCards.indexOf(s);
          expect(Array.from(uploaded.flags.array.slice(i * 8 + 4, i * 8 + 8))).toEqual([5, 3, 0, s === door ? -2 : 0]);
        }
        for (const [x, z, hidden] of [
          [2.5, 1.5, true],
          [4.13, 1.06, false],
        ] as const) {
          unit.anchor.set(58 + x, 0, 98 + z);
          layer.setInstances([body, door, unit]);
          for (const row of [0, -10]) {
            const pixel = screen(unit.anchor);
            pixel[1] += row;
            // The synthetic opaque body covers this door-post/wall column; these are depth assertions, not art QA.
            for (const s of [body, door, unit]) expectCovered(s, pixel);
            const spriteDepth = depth(unit, pixel);
            const voxelPoint = unit.anchor.clone();
            voxelPoint.y = -row / (Math.cos(Math.PI / 6) * PIXELS_PER_CELL_EDGE);
            const voxelDepth = biasedDepth(
              physical(voxelPoint),
              VOXEL_CLEARANCE + spritePainterBias(unitPainter),
              range,
            );
            for (const unitDepth of [spriteDepth, voxelDepth]) {
              if (hidden) expect(unitDepth).toBeGreaterThan(depth(door, pixel));
              else expect(unitDepth).toBeLessThan(depth(door, pixel));
              expect(unitDepth).toBeGreaterThan(depth(body, pixel));
            }
            // At the later feet row, max(ground, facade) selects the ramp; 10px up it selects the recessed facade.
            expect((spriteDepth - depth(door, pixel)) * range).toBeCloseTo(
              hidden ? 0.810132945 : row === 0 ? -0.006363636 : -0.218652747,
              6,
            );
            expect((voxelDepth - depth(door, pixel)) * range).toBeCloseTo(
              hidden ? 0.805132945 : row === 0 ? -0.011363636 : -0.223652747,
              6,
            );
            if (!hidden) expect((spriteDepth - depth(body, pixel)) * range).toBeCloseTo(1.414340414, 6);
          }
        }
        // Same later tank column d=3.07, outside behind the back surface s=3.07 (z=-0.5, s=2.07).
        const tankColumn = screen(unit.anchor)[0];
        unit.anchor.set(60.57, 0, 97.5);
        layer.setInstances([body, door, unit]);
        expect(screen(unit.anchor)[0]).toBeCloseTo(tankColumn);
        for (const row of [0, -10]) {
          const pixel = screen(unit.anchor);
          pixel[1] += row;
          expect(depth(unit, pixel)).toBeGreaterThan(depth(door, pixel));
          const voxelPoint = unit.anchor.clone();
          voxelPoint.y = -row / (Math.cos(Math.PI / 6) * PIXELS_PER_CELL_EDGE);
          expect(
            biasedDepth(physical(voxelPoint), VOXEL_CLEARANCE + spritePainterBias(unitPainter), range),
          ).toBeGreaterThan(depth(door, pixel));
        }
        // Outside the +x facade, ramp/base rows retain the unchanged ground-depth branch for both cards.
        unit.anchor.set(63.5, 0, 99.5);
        layer.setInstances([body, door, unit]);
        for (const row of [0, 4]) {
          const pixel = screen(unit.anchor);
          pixel[1] += row;
          for (const s of [body, door, unit]) expectCovered(s, pixel);
          for (const s of [body, door]) {
            const at = screen(s.anchor);
            const i = uploaded.orderedCards.indexOf(s);
            const [w, sizeH, dx, ds] = Array.from(uploaded.flags.array.slice(i * 8 + 4, i * 8 + 8));
            expect(cardDepthPush(pixel[0] - at[0], pixel[1] - at[1], w, sizeH, dx, ds)).toBeCloseTo(
              cardDepthPush(pixel[0] - at[0], pixel[1] - at[1]),
              12,
            );
            expect(depth(unit, pixel)).toBeLessThan(depth(s, pixel));
          }
        }
      } finally {
        layer.mesh.dispose();
        layer.mesh.geometry.dispose();
        layer.mesh.material.dispose();
        atlas.dispose();
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
