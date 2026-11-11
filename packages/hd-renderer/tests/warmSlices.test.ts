import { describe, expect, it } from 'vitest';
import { Group, InstancedMesh, Mesh, MeshBasicMaterial, PointLight, Scene } from 'three/webgpu';
import { isDrawable, showOnly, warmGroups, WarmSlicer, type WarmGroup } from '../src/warmSlices';

function groupsOf(count: number): WarmGroup[] {
  return Array.from({ length: count }, (_, i) => ({ key: String(i), objects: [] }));
}

describe('warm-up slices', () => {
  it('groups drawable objects by material and geometry layout, hidden ones included, lights and groups left out', () => {
    const scene = new Scene();
    const material = new MeshBasicMaterial();
    const a = new Mesh(undefined, material);
    const b = new Mesh(undefined, material);
    b.visible = false;
    const other = new Mesh();
    const holder = new Group();
    holder.visible = false;
    const inside = new Mesh(undefined, material);
    holder.add(inside);
    scene.add(a, b, other, holder, new PointLight());
    const groups = warmGroups([scene]);
    expect(groups.map((group) => group.objects)).toEqual([[a, b, inside], [other]]);
    expect(isDrawable(holder)).toBe(false);
    expect(isDrawable(new PointLight())).toBe(false);
  });

  it('gives an instanced object a group of its own, as three keys its graph by the object', () => {
    const material = new MeshBasicMaterial();
    const a = new InstancedMesh(undefined, material, 8);
    const b = new InstancedMesh(undefined, material, 8);
    const c = new Mesh(undefined, material);
    const d = new Mesh(undefined, material);
    const scene = new Scene();
    scene.add(a, b, c, d);
    expect(warmGroups([scene]).map((group) => group.objects)).toEqual([[a], [b], [c, d]]);
  });

  it('sizes each slice from the cost measured before it, never below one group, and slowly after a cheap run', () => {
    const groups = groupsOf(60);
    const slicer = new WarmSlicer({ budgetMs: 12, first: 4, maxGrowth: 2, maxGroups: 8 });
    expect(slicer.next(groups)!.length).toBe(4);
    // 40 ms for four groups: one group fits.
    slicer.report(40);
    expect(slicer.next(groups)!.length).toBe(1);
    // One group took 50 ms: still one.
    slicer.report(50);
    expect(slicer.next(groups)!.length).toBe(1);
    // Cheap now (graphs built already), but the estimate only halves a frame: 25, 12.5, 6.25, ... ms a group.
    slicer.report(0.5);
    expect(slicer.next(groups)!.length).toBe(1);
    slicer.report(0.5);
    expect(slicer.next(groups)!.length).toBe(1);
    slicer.report(0.5);
    expect(slicer.next(groups)!.length).toBe(1);
    slicer.report(0.5);
    // 3.1 ms a group: three fit, but a slice at most doubles the one before.
    expect(slicer.next(groups)!.length).toBe(2);
    for (let i = 0; i < 4; i++) {
      slicer.report(0.5);
      slicer.next(groups);
    }
    slicer.report(0.5);
    // Never more than maxGroups in one slice.
    expect(slicer.next(groups)!.length).toBe(8);
  });

  it('takes the scene as it is each frame, hands out each group once and ends when nothing is new', () => {
    const slicer = new WarmSlicer({ first: 2, maxGroups: 2 });
    const [a, b, c] = groupsOf(3);
    expect(slicer.next([a!, b!])).toEqual([a, b]);
    slicer.report(1);
    // A group that arrived meanwhile is still handed out; the ones handed out are not again.
    expect(slicer.next([a!, b!, c!])).toEqual([c]);
    expect(slicer.next([a!, b!, c!])).toBeNull();
    const limited = new WarmSlicer({ first: 1, maxSlices: 2 });
    expect(limited.next(groupsOf(5))).toHaveLength(1);
    expect(limited.next(groupsOf(5).slice(1))).toHaveLength(1);
    // A scene that keeps gaining kinds is left to the full frames after the slice limit.
    expect(limited.next(groupsOf(5).slice(2))).toBeNull();
  });

  it('shows exactly one slice and the way to it for a frame, then puts every visibility back', () => {
    const scene = new Scene();
    const shown = new Mesh();
    const idle = new Mesh();
    idle.visible = false;
    const holder = new Group();
    holder.visible = false;
    const inside = new Mesh();
    holder.add(inside);
    const parentMesh = new Mesh();
    parentMesh.visible = false;
    const child = new Mesh();
    parentMesh.add(child);
    scene.add(shown, idle, holder, parentMesh);
    const groups = warmGroups([scene]);
    const byObject = (object: Mesh) => groups.find((group) => group.objects.includes(object))!;
    const restore = showOnly([scene], [byObject(inside), byObject(child)]);
    expect([shown.visible, idle.visible, holder.visible, inside.visible]).toEqual([false, false, true, true]);
    // A drawable parent on the way to a slice object is drawn as well (its subtree would be skipped otherwise).
    expect([parentMesh.visible, child.visible]).toEqual([true, true]);
    restore();
    expect([shown.visible, idle.visible, holder.visible, inside.visible, parentMesh.visible, child.visible]).toEqual([
      true,
      false,
      false,
      true,
      false,
      true,
    ]);
  });

  it('keeps an object that draws the scene again (a water mirror) and all under it in every slice', () => {
    const scene = new Scene();
    const terrain = new Mesh();
    const wall = new Mesh();
    wall.visible = false;
    terrain.add(wall);
    const unit = new Mesh();
    const other = new Mesh();
    scene.add(terrain, unit, other);
    const groups = warmGroups([scene]);
    const restore = showOnly([scene], [groups.find((group) => group.objects.includes(unit))!], [terrain]);
    expect([terrain.visible, wall.visible, unit.visible, other.visible]).toEqual([true, true, true, false]);
    restore();
    expect([terrain.visible, wall.visible, unit.visible, other.visible]).toEqual([true, false, true, true]);
  });
});
