import { describe, expect, it } from 'vitest';
import { BoxGeometry, MeshStandardNodeMaterial } from 'three/webgpu';
import { instantiateVoxel } from '../src/ra2/voxels';

describe('translucent voxel variant', () => {
  it('keeps the nodes its source material carries in userData (three drops them on clone)', () => {
    // Without the silhouette node the variant's shader did not build and the unit was drawn solid black: a tank being
    // erased by a Chrono Legionnaire, a cloaked submarine seen by its owner.
    const source = new MeshStandardNodeMaterial();
    const silhouette = { marker: 'silhouette node' };
    source.userData.silhouetteNode = silhouette;
    const unit = instantiateVoxel([{ role: 'body', geometry: new BoxGeometry(), turretOffset: 0 }], source);
    unit.root.setOpacity(0.5);
    const variant = unit.root.partMeshes[0]!.material as MeshStandardNodeMaterial;
    expect(variant).not.toBe(source);
    expect(variant.transparent).toBe(true);
    expect(variant.userData.silhouetteNode).toBe(silhouette);
    // Opaque again: the shared source material itself.
    unit.root.setOpacity(1);
    expect(unit.root.partMeshes[0]!.material).toBe(source);
    unit.root.disposeOpacityMaterials();
  });
});
