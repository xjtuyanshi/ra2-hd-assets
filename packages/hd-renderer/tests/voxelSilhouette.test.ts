import { describe, expect, it } from 'vitest';
import { BufferGeometry, Float32BufferAttribute, Group, Mesh, MeshBasicNodeMaterial } from 'three/webgpu';
import {
  footprintGeometry,
  registerSilhouetteGeometry,
  setShadowContact,
  setShadowGround,
  SILHOUETTE_FOOTPRINT,
  silhouetteGeometry,
  VoxelShadowMesh,
  VoxelWaterMesh,
} from '../src/ra2/voxelShadow';
import {
  buildSmoothVoxelGeometry,
  buildStandInVoxelParts,
  ensureSmoothVoxelGeometry,
  smoothVoxelPartGeometries,
} from '../src/ra2/voxelSmoothGeometry';
import { smoothVoxelOptions } from '../src/ra2/voxelSmooth';
import { buildOutlinePartGeometry, buildStandInPartGeometry } from '../src/ra2/voxels';
import { syntheticModel, syntheticSection } from './fixtures/syntheticVoxels';

const triangles = (geometry: BufferGeometry): number => geometry.index!.count / 3;
/** Every triangle as its three corner positions, rounded and sorted: equal sets mean equal surfaces. */
function surface(geometry: BufferGeometry): string[] {
  const position = geometry.getAttribute('position');
  const index = geometry.index!;
  const out: string[] = [];
  for (let i = 0; i < index.count; i += 3) {
    const corners = [0, 1, 2].map((k) => {
      const v = index.getX(i + k);
      return [position.getX(v), position.getY(v), position.getZ(v)].map((c) => c.toFixed(5)).join(',');
    });
    out.push(corners.join(' | '));
  }
  return out.sort();
}

describe('voxel silhouette geometry', () => {
  it('is the exposed-face surface of the stand-in mesh with one shared vertex per corner and positions only', () => {
    for (const sections of [[syntheticSection(6)], [syntheticSection(5, true), syntheticSection(3)]]) {
      const standIn = buildStandInPartGeometry(sections);
      const outline = buildOutlinePartGeometry(sections);
      expect(Object.keys(outline.attributes)).toEqual(['position']);
      // The same triangles in the same winding, corner for corner.
      expect(surface(outline)).toEqual(surface(standIn));
      expect(triangles(outline)).toBe(triangles(standIn));
      // The stand-in gives every quad four vertices of its own; here faces meeting at a corner share one.
      expect(outline.getAttribute('position').count).toBeLessThan(standIn.getAttribute('position').count / 2);
      // Upward faces lead the index: every triangle whose outside looks up +y is inside the footprint range.
      const footprint = outline.userData[SILHOUETTE_FOOTPRINT] as number;
      expect(footprint % 6).toBe(0);
      expect(footprint).toBeGreaterThan(0);
      expect(footprint).toBeLessThan(outline.index!.count);
      const position = outline.getAttribute('position');
      const up = (i: number): number => {
        const [a, b, c] = [0, 1, 2].map((k) => outline.index!.getX(i + k));
        const bx = position.getX(b!) - position.getX(a!);
        const bz = position.getZ(b!) - position.getZ(a!);
        const cx = position.getX(c!) - position.getX(a!);
        const cz = position.getZ(c!) - position.getZ(a!);
        return bz * cx - bx * cz;
      };
      for (let i = footprint; i < outline.index!.count; i += 3) expect(up(i)).toBeLessThanOrEqual(0);
      let upward = 0;
      for (let i = 0; i < footprint; i += 3) if (up(i) > 0) upward++;
      // At least one triangle of every leading quad looks up.
      expect(upward).toBeGreaterThanOrEqual(footprint / 6);
      expect(outline.boundingSphere!.radius).toBeCloseTo(standIn.boundingSphere!.radius, 5);
      expect(outline.boundingSphere!.center.distanceTo(standIn.boundingSphere!.center)).toBeLessThan(1e-5);
    }
  });

  it('is far coarser than the smooth mesh it stands for, and lies on the same part', () => {
    const model = syntheticModel([syntheticSection(8, true)]);
    const options = smoothVoxelOptions({ aoRays: 0 });
    ensureSmoothVoxelGeometry(model, options);
    const smooth = smoothVoxelPartGeometries(model, options)![0]!;
    const outline = silhouetteGeometry(smooth);
    expect(outline).not.toBe(smooth);
    // A solid cube of 8 voxels a side: 6 x 64 faces, two triangles each.
    expect(triangles(outline)).toBe(6 * 64 * 2);
    expect(triangles(smooth)).toBeGreaterThan(triangles(outline) * (options.supersample ** 2 - 1));
    smooth.computeBoundingBox();
    outline.computeBoundingBox();
    // Within a voxel of the smooth surface on every side (model units; the cube's side is 8 voxels).
    const voxel = (smooth.boundingBox!.max.x - smooth.boundingBox!.min.x) / 8;
    for (const axis of ['x', 'y', 'z'] as const) {
      expect(Math.abs(outline.boundingBox!.min[axis] - smooth.boundingBox!.min[axis])).toBeLessThan(voxel);
      expect(Math.abs(outline.boundingBox!.max[axis] - smooth.boundingBox!.max[axis])).toBeLessThan(voxel);
    }
    // Built once, then shared by every twin of every unit of the model.
    expect(silhouetteGeometry(smooth)).toBe(outline);
    // The stand-in shown while the smooth mesh is built has the same outline: a shadow does not change with it.
    const standIn = buildStandInVoxelParts(model)[0]!.geometry;
    expect(surface(silhouetteGeometry(standIn))).toEqual(surface(outline));
    // The geometry handed out with a material is the registered one.
    expect(buildSmoothVoxelGeometry(model, null, undefined, options)[0]!.geometry).toBe(smooth);
  });

  it('draws shadow and foam twins with the silhouette, the colour reflection with the part itself', () => {
    const part = new BufferGeometry();
    part.setAttribute('position', new Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3));
    let built = 0;
    const coarse = new BufferGeometry();
    registerSilhouetteGeometry(part, () => {
      built++;
      return coarse;
    });
    const source = new Mesh(part, new MeshBasicNodeMaterial());
    // Nothing is built before a twin needs it.
    expect(built).toBe(0);
    const shadows = [0, 1, 2].map((copy) => new VoxelShadowMesh(source, undefined, copy));
    const foam = new VoxelWaterMesh(source, undefined, 'foam');
    const reflection = new VoxelWaterMesh(source, undefined, 'reflection');
    expect(built).toBe(1);
    for (const twin of [...shadows, foam]) expect(twin.geometry).toBe(coarse);
    expect(reflection.geometry).toBe(part);

    // The part's final mesh arrives: the twins follow at their next matrix update, each to its own kind of geometry.
    const final = new BufferGeometry();
    final.setAttribute('position', new Float32BufferAttribute([0, 0, 0, 2, 0, 0, 0, 2, 0], 3));
    const finalCoarse = new BufferGeometry();
    registerSilhouetteGeometry(final, () => finalCoarse);
    source.geometry = final;
    for (const twin of [...shadows, foam, reflection]) twin.updateMatrixWorld(true);
    for (const twin of [...shadows, foam]) expect(twin.geometry).toBe(finalCoarse);
    expect(reflection.geometry).toBe(final);

    // The contact footprint (see setShadowContact) draws the silhouette's leading upward faces over the same buffers.
    finalCoarse.setAttribute('position', new Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 0, 1, 1, 0, 1], 3));
    finalCoarse.setIndex([0, 2, 1, 1, 2, 3, 0, 1, 2, 1, 3, 2]);
    expect(footprintGeometry(finalCoarse)).toBe(finalCoarse);
    finalCoarse.userData[SILHOUETTE_FOOTPRINT] = 6;
    const footprint = footprintGeometry(finalCoarse);
    expect(footprint).not.toBe(finalCoarse);
    expect(footprintGeometry(finalCoarse)).toBe(footprint);
    expect(footprint.getAttribute('position')).toBe(finalCoarse.getAttribute('position'));
    expect(footprint.index).toBe(finalCoarse.index);
    expect(footprint.drawRange).toEqual({ start: 0, count: 6 });
    expect(finalCoarse.drawRange.count).toBe(Infinity);
    const unit = new Group();
    const ground = new Group();
    ground.add(unit);
    unit.add(source, ...shadows);
    setShadowGround(ground, () => 0);
    setShadowContact(unit, true);
    ground.updateMatrixWorld(true);
    for (const twin of shadows) {
      expect(twin.contact).toBe(true);
      expect(twin.geometry).toBe(footprint);
    }
    // Off the ground the shadow is sheared along the light: every face can be on its outline again.
    setShadowContact(unit, false);
    ground.updateMatrixWorld(true);
    for (const twin of shadows) expect(twin.geometry).toBe(finalCoarse);

    // A geometry nobody registered is drawn as it is.
    const plain = new BufferGeometry();
    expect(silhouetteGeometry(plain)).toBe(plain);

    // The silhouette goes with its part.
    let disposed = 0;
    coarse.addEventListener('dispose', () => disposed++);
    part.dispose();
    expect(disposed).toBe(1);
    expect(silhouetteGeometry(part)).toBe(part);
  });
});
