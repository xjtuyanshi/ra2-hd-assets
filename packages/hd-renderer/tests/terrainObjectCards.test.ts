import { describe, expect, it } from 'vitest';
import { BoxGeometry, MeshStandardNodeMaterial, Vector3 } from 'three/webgpu';
import { CARD_CLEARANCE } from '../src/ra2/cardDepth';
import { GROUND_DEPTH, nativeCardPush, TERRAIN_OBJECT_DEPTH_BONUS } from '../src/ra2/nativeDepth';
import { TerrainObjectCards } from '../src/ra2/terrainObjectCards';
import {
  createVoxelCardExtent,
  voxelCardDelta,
  voxelCardExtent,
  voxelFragmentRow,
  voxelScreenPlace,
} from '../src/ra2/voxelNativeDepth';
import { instantiateVoxel, updateVoxelNativeDepth, type VoxelUnit } from '../src/ra2/voxels';
import { LEVEL_HEIGHT, PIXELS_PER_CELL_EDGE } from '../src/world';

const forward = new Vector3(-Math.sqrt(3 / 8), -0.5, -Math.sqrt(3 / 8));
// A crown 60 px wide and 70 px tall whose inclusive bottom row is 3 px below the draw point.
const treeFrame = { rect: [0, 0, 60, 70] as [number, number, number, number], offset: [-30, -66] as [number, number] };
const TREE_BOTTOM = 3;

/** A hull about one cell long, turned 45 degrees, with a raised block for a turret. */
function hull() {
  const body = new BoxGeometry(1, 0.35, 0.55);
  body.translate(0, 0.175, 0);
  const turret = new BoxGeometry(0.4, 0.2, 0.4);
  turret.translate(0, 0.45, 0);
  const material = new MeshStandardNodeMaterial();
  const unit = instantiateVoxel(
    [
      { role: 'body', geometry: body, turretOffset: 0 },
      { role: 'turret', geometry: turret, turretOffset: 0 },
    ],
    material,
  );
  unit.root.rotation.y = Math.PI / 4;
  return { unit, dispose: () => (body.dispose(), turret.dispose(), material.dispose()) };
}

/** Points all over the posed parts' boxes (surfaces and inside), in world space. */
function samples(root: VoxelUnit): Vector3[] {
  const out: Vector3[] = [];
  for (const mesh of root.partMeshes) {
    mesh.updateWorldMatrix(true, false);
    const box = mesh.geometry.boundingBox!;
    for (let i = 0; i <= 12; i++)
      for (let j = 0; j <= 6; j++)
        for (let k = 0; k <= 8; k++)
          out.push(
            new Vector3(
              box.min.x + ((box.max.x - box.min.x) * i) / 12,
              box.min.y + ((box.max.y - box.min.y) * j) / 6,
              box.min.z + ((box.max.z - box.min.z) * k) / 8,
            ).applyMatrix4(mesh.matrixWorld),
          );
  }
  return out;
}

/**
 * Signs of (unit fragment depth - tree fragment depth) at every sampled hull point that the tree's card covers,
 * with the CPU twins of the two depth shaders: +1 = the tree is drawn over that point, -1 = the hull shows.
 */
function winners(root: VoxelUnit, tree: Vector3): Set<number> {
  const depth = root.nativeDepth;
  const treePlace = voxelScreenPlace(tree, { column: 0, row: 0, depth: 0 });
  const place = { column: 0, row: 0, depth: 0 };
  const signs = new Set<number>();
  for (const point of samples(root)) {
    voxelScreenPlace(point, place);
    const px = place.column - treePlace.column;
    const py = place.row - treePlace.row;
    if (px < treeFrame.offset[0] || px > treeFrame.offset[0] + treeFrame.rect[2]) continue;
    if (py < treeFrame.offset[1] || py > TREE_BOTTOM) continue;
    const unit = point.dot(forward) - voxelCardDelta(point, depth.anchor, depth.bottom, depth.bonus) - root.depthBias;
    const card = treePlace.depth - nativeCardPush(py, TREE_BOTTOM, TERRAIN_OBJECT_DEPTH_BONUS) - CARD_CLEARANCE;
    signs.add(Math.sign(unit - card));
  }
  return signs;
}

/** Drive the hull straight down the screen past the tree in quarter-row steps; returns the winners of every step. */
function sweep(cards: TerrainObjectCards | null, treeLevel = 0, unitLevel = 0, bonus = 0, painterBias = 0) {
  const { unit, dispose } = hull();
  const tree = new Vector3(20.5, treeLevel * LEVEL_HEIGHT, 20.5);
  unit.root.setPainterBias(painterBias);
  const steps: { rows: number; signs: Set<number>; bonus: number }[] = [];
  // One cell along +x and +z is 30 rows down the screen; a level up is 15 rows up at the same depth-per-row.
  const lift = ((unitLevel - treeLevel) * 15) / 30 / 2;
  for (let rows = -60; rows <= 60; rows += 0.25) {
    const shift = rows / 30 / 2 + lift;
    unit.root.position.set(tree.x + shift, unitLevel * LEVEL_HEIGHT, tree.z + shift);
    updateVoxelNativeDepth(unit, unit.root.position, bonus, true, cards);
    steps.push({ rows, signs: winners(unit.root, tree), bonus: unit.root.nativeDepth.bonus });
  }
  dispose();
  return steps;
}

describe('vehicle against a terrain object card', () => {
  it('shows the defect it resolves: without it the winner alternates across the hull where the two cards cross', () => {
    const steps = sweep(null);
    const mixed = steps.filter((step) => step.signs.size > 1);
    expect(mixed.length).toBeGreaterThan(0);
    // Far behind and far in front the plain cards already decide for the whole hull.
    const overlapping = steps.filter((step) => step.signs.size > 0);
    expect([...overlapping[0]!.signs]).toEqual([1]);
    expect([...overlapping.at(-1)!.signs]).toEqual([-1]);
    // The crossing takes a few rows of travel: the two step phases and the hull's own six percent of depth.
    expect(mixed.at(-1)!.rows - mixed[0]!.rows).toBeLessThan(4);
  });

  it.each([
    ['on level ground', 0, 0, 0, 0],
    ['with the largest painter bias', 0, 0, 0, 0.04],
    ['with the refinery bonus', 0, 0, 13, 0],
    ['with the tree a level above the vehicle', 1, 0, 0, 0],
    ['with the vehicle two levels above the tree', 0, 2, 0, 0],
  ] as const)(
    'puts the hull wholly behind or wholly in front at every step %s',
    (_, treeLevel, unitLevel, bonus, bias) => {
      const cards = new TerrainObjectCards();
      cards.add(new Vector3(20.5, treeLevel * LEVEL_HEIGHT, 20.5), treeFrame);
      const plain = sweep(null, treeLevel, unitLevel, bonus, bias);
      const steps = sweep(cards, treeLevel, unitLevel, bonus, bias);
      let flips = 0;
      let last = 0;
      for (const [index, step] of steps.entries()) {
        expect(step.signs.size, `rows ${step.rows}`).toBeLessThanOrEqual(1);
        const sign = [...step.signs][0];
        if (sign === undefined) continue;
        if (last && sign !== last) flips++;
        last = sign;
        // Only ever pushed back, by at most the width of the tie (two card steps and the hull's own six percent),
        // and a hull that is pushed back is behind the tree.
        expect(step.bonus).toBeLessThanOrEqual(bonus);
        expect(step.bonus).toBeGreaterThan(bonus - 3);
        if (step.bonus !== bonus) expect(sign).toBe(1);
        // A hull the plain cards put wholly behind stays there.
        const before = plain[index]!;
        if (before.signs.size === 1 && before.signs.has(1)) expect(sign).toBe(1);
      }
      // One change from behind to in front along the drive, never back.
      expect(flips).toBe(1);
      expect(last).toBe(-1);
      // The flip stays where the cards cross: at the last step the plain cards still put the tree in front anywhere.
      const lastBehind = steps.filter((step) => step.signs.has(1)).at(-1)!.rows;
      const plainBehind = plain.filter((step) => step.signs.has(1)).at(-1)!.rows;
      expect(lastBehind).toBeGreaterThanOrEqual(plainBehind);
      expect(lastBehind - plainBehind).toBeLessThanOrEqual(0.5);
    },
  );

  it('leaves vehicles alone that no tree overlaps on screen', () => {
    const cards = new TerrainObjectCards();
    const tree = new Vector3(20.5, 0, 20.5);
    cards.add(tree, treeFrame);
    expect(cards.size).toBe(1);
    const { unit, dispose } = hull();
    // The same screen rows as a tie, but 200 px to the right of the crown.
    const tie = sweep(cards).find((step) => step.bonus < 0)!;
    const shift = tie.rows / 30 / 2;
    const aside = 200 / 30 / 2;
    unit.root.position.set(tree.x + shift + aside, 0, tree.z + shift - aside);
    updateVoxelNativeDepth(unit, unit.root.position, 0, true, cards);
    expect(unit.root.nativeDepth.bonus).toBe(0);
    // Back under the crown the tie is resolved again, and switching the card off or passing no cards clears it.
    unit.root.position.set(tree.x + shift, 0, tree.z + shift);
    updateVoxelNativeDepth(unit, unit.root.position, 0, true, cards);
    expect(unit.root.nativeDepth.bonus).toBeCloseTo(tie.bonus, 9);
    updateVoxelNativeDepth(unit, unit.root.position, 0, true);
    expect(unit.root.nativeDepth.bonus).toBe(0);
    updateVoxelNativeDepth(unit, unit.root.position, 7, false, cards);
    expect(unit.root.nativeDepth.bonus).toBe(7);
    expect(new TerrainObjectCards().tieBonus(unit.root.position, 20, 0, 0, createVoxelCardExtent())).toBe(0);
    dispose();
  });

  it('measures the posed bounds and their distance behind the card on the fixed screen axes', () => {
    const { unit, dispose } = hull();
    unit.root.position.set(12, 2 * LEVEL_HEIGHT, 9);
    updateVoxelNativeDepth(unit, unit.root.position);
    const { bottom, anchor } = unit.root.nativeDepth;
    const extent = voxelCardExtent(unit.root.partMeshes, anchor, bottom, 0, createVoxelCardExtent());
    let left = Infinity;
    let right = -Infinity;
    let top = Infinity;
    let near = Infinity;
    let far = -Infinity;
    for (const mesh of unit.root.partMeshes) {
      const box = mesh.geometry.boundingBox!;
      for (const x of [box.min.x, box.max.x])
        for (const y of [box.min.y, box.max.y])
          for (const z of [box.min.z, box.max.z]) {
            const point = new Vector3(x, y, z).applyMatrix4(mesh.matrixWorld);
            const row = voxelFragmentRow(point, anchor);
            const column = ((point.x - anchor.x - (point.z - anchor.z)) / Math.SQRT2) * PIXELS_PER_CELL_EDGE;
            const behind = point.clone().sub(anchor).dot(forward) + nativeCardPush(row, bottom);
            left = Math.min(left, column);
            right = Math.max(right, column);
            top = Math.min(top, row);
            near = Math.min(near, behind);
            far = Math.max(far, behind);
          }
    }
    expect(extent.left).toBeCloseTo(left, 9);
    expect(extent.right).toBeCloseTo(right, 9);
    expect(extent.top).toBeCloseTo(top, 9);
    expect(extent.behindMin).toBeCloseTo(near, 9);
    expect(extent.behindMax).toBeCloseTo(far, 9);
    // The hull turned 45 degrees lies along the screen's horizontal: its length of one cell edge is 42.4 px there,
    // plus the corners of its width.
    expect(extent.right - extent.left).toBeGreaterThan(PIXELS_PER_CELL_EDGE);
    expect(extent.right - extent.left).toBeLessThan(PIXELS_PER_CELL_EDGE + 1);
    expect(far - near).toBeLessThan(40 * GROUND_DEPTH);
    // Screen places are fixed to the map: one cell east is 30 px right and 15 px down, a level up 15 px up.
    const origin = voxelScreenPlace(new Vector3(3, 0, 5), { column: 0, row: 0, depth: 0 });
    const east = voxelScreenPlace(new Vector3(4, 0, 5), { column: 0, row: 0, depth: 0 });
    const up = voxelScreenPlace(new Vector3(3, LEVEL_HEIGHT, 5), { column: 0, row: 0, depth: 0 });
    expect(east.column - origin.column).toBeCloseTo(30, 9);
    expect(east.row - origin.row).toBeCloseTo(15, 9);
    expect(up.row - origin.row).toBeCloseTo(-15, 9);
    expect(east.depth - origin.depth).toBeCloseTo(-15 * GROUND_DEPTH, 9);
    dispose();
  });
});
