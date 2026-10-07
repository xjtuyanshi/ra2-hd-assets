import { Group, Vector3 } from 'three/webgpu';
import { describe, expect, it, vi } from 'vitest';
import type { VoxelModel } from '../../ra2-assets/src/manifest';
import type { EffectArt } from '../src/live/effectArt';
import type { LiveBullet, LiveVoxelAnim } from '../src/live/effects';
import type { EffectInstance } from '../src/live/effectSprites';
import { Projectiles } from '../src/live/projectiles';
import type { VoxelUnits } from '../src/live/voxelUnits';
import { assignPainterBias, painterObject } from '../src/ra2/painterOrder';
import { LEVEL_HEIGHT } from '../src/world';

function fixture() {
  const model = { palette: 'unit' } as VoxelModel;
  const art = {
    bullet: (type: string) =>
      type === 'ROCKET'
        ? { art: { voxel: 'rocket' } }
        : {
            art: {},
            sprite: { frames: [{ rect: [0, 0, 8, 8], offset: [-4, -4] }] },
          },
    voxel: (type: string) => (type === 'rocket' || type === 'chunk' ? model : null),
  } as unknown as EffectArt;
  const build = vi.fn(() => ({ root: new Group() }));
  const dispose = vi.fn((unit: { root: Group }) => unit.root.removeFromParent());
  const voxels = { build, dispose, geometryReady: () => true } as unknown as VoxelUnits;
  const parent = new Group();
  const palette = vi.fn((owner: number | undefined) => `unit:${owner ?? 'neutral'}`);
  const projectiles = new Projectiles(art, voxels, parent, palette);
  return { projectiles, parent, build, dispose, palette };
}

const bullet = (fields: Partial<LiveBullet> = {}): LiveBullet => ({
  id: 1,
  uid: 1,
  type: 'ROCKET',
  x: 256,
  y: 512,
  z: 104,
  velocity: { x: 256, y: 0, z: 0 },
  ...fields,
});
const debris = (fields: Partial<LiveVoxelAnim> = {}): LiveVoxelAnim => ({
  id: 2,
  uid: 1,
  type: 'chunk',
  x: 768,
  y: 1024,
  z: 208,
  rotation: [0, 0, 0, 1],
  owner: 3,
  ...fields,
});

describe('voxel projectile painter entries', () => {
  it('exposes separate missile and debris biases without changing their physical transforms', () => {
    const f = fixture();
    f.projectiles.update([bullet()], [debris()], () => false, []);
    const entries = [...f.projectiles.painterEntries()];
    expect(entries).toHaveLength(2);
    expect(entries.map((entry) => entry.painter)).toMatchObject([
      { layer: 3, ySort: 768, bias: 0 },
      { layer: 3, ySort: 1792, bias: 0 },
    ]);
    expect(entries[0]!.root.position.toArray()).toEqual([1, LEVEL_HEIGHT, 2]);
    expect(entries[1]!.root.position.toArray()).toEqual([3, LEVEL_HEIGHT * 2, 4]);
    expect(new Vector3(1, 0, 0).applyQuaternion(entries[0]!.root.quaternion).toArray()).toEqual([1, 0, 0]);
    expect(entries[1]!.root.quaternion.toArray()).toEqual([-0, -0, -0, 1]);
    const placement = entries.map((entry) => entry.root.position.toArray());
    const ground = painterObject(2, 100000);
    assignPainterBias([ground, ...entries.map((entry) => entry.painter)]);
    expect(entries.every((entry) => entry.painter.bias > ground.bias)).toBe(true);
    expect(entries.map((entry) => entry.root.position.toArray())).toEqual(placement);
    expect(f.parent.children).toEqual(entries.map((entry) => entry.root));
    expect(f.palette.mock.calls).toEqual([[undefined], [3]]);
  });

  it('refreshes keys on retained meshes and discards the previous bias when a uid disappears and returns', () => {
    const f = fixture();
    f.projectiles.update([bullet()], [], () => false, []);
    const first = [...f.projectiles.painterEntries()][0]!;
    assignPainterBias([first.painter]);
    f.projectiles.update([bullet({ x: 2048, y: 4096, z: 1040 })], [], () => false, []);
    const moved = [...f.projectiles.painterEntries()][0]!;
    expect(moved).toBe(first);
    expect(moved.painter.ySort).toBe(6144);
    expect(moved.root.position.toArray()).toEqual([8, LEVEL_HEIGHT * 10, 16]);
    expect(f.build).toHaveBeenCalledTimes(1);
    f.projectiles.update([], [], () => false, []);
    expect([...f.projectiles.painterEntries()]).toEqual([]);
    expect(f.dispose).toHaveBeenCalledTimes(1);
    expect(f.parent.children).toEqual([]);
    f.projectiles.update([bullet()], [], () => false, []);
    const returned = [...f.projectiles.painterEntries()][0]!;
    expect(returned.painter).not.toBe(first.painter);
    expect(returned.painter).toMatchObject({ layer: 3, ySort: 768, bias: 0 });
    expect(f.build).toHaveBeenCalledTimes(2);
  });

  it('keeps SHP shells in their existing air pass and removes hidden or missing voxel art from painter entries', () => {
    const f = fixture();
    const cards: EffectInstance[] = [];
    f.projectiles.update([bullet({ type: 'SHELL' })], [debris({ type: 'missing' })], () => false, cards);
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ pass: 'air', draw: 'card', palette: 'fx:anim' });
    expect(cards[0]!.painter).toBeUndefined();
    expect([...f.projectiles.painterEntries()]).toEqual([]);
    f.projectiles.update([bullet()], [debris()], () => false, []);
    expect([...f.projectiles.painterEntries()]).toHaveLength(2);
    f.projectiles.update([bullet()], [debris()], () => true, []);
    expect([...f.projectiles.painterEntries()]).toEqual([]);
    expect(f.dispose).toHaveBeenCalledTimes(2);
  });

  it("draws an owner-coloured SHP missile as a solid body in the firing house's unit palette", () => {
    const f = fixture();
    const cards: EffectInstance[] = [];
    // The falling nuclear missile: 3000 leptons up, created 20000 above its target, fired by house 4.
    const missile = bullet({
      type: 'GiantNukeDown',
      z: 3000,
      owner: 4,
      ownerPalette: true,
      velocity: { x: 0, y: 0, z: -179 },
    });
    f.projectiles.update([missile, bullet({ uid: 2, type: 'SHELL', owner: 4 })], [], () => false, cards);
    expect(cards).toHaveLength(2);
    expect(cards[0]).toMatchObject({ pass: 'air', draw: 'card', palette: 'unit:4', glow: false, alpha: 1 });
    expect(f.palette).toHaveBeenCalledWith(4);
    // An ordinary shell of the same house keeps the effect palette and may glow.
    expect(cards[1]).toMatchObject({ palette: 'fx:anim', glow: true });
    // Its card stands at the missile's own height: the anchor follows z.
    expect(cards[0]!.anchor.y).toBeCloseTo((3000 / 104) * LEVEL_HEIGHT, 4);
    // Without a known firer the neutral unit palette is used rather than the effect palette.
    cards.length = 0;
    f.projectiles.update([{ ...missile, owner: undefined }], [], () => false, cards);
    expect(cards[0]).toMatchObject({ palette: 'unit:neutral', glow: false });
  });
});
