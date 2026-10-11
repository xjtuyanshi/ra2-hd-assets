import type { VoxelModel } from '../../../ra2-assets/src/manifest';

// Model identity owns the mesh caches. Reusing a selected model across objects and houses avoids rebuilding its
// geometry on every state publication; weak keys release the selections with their source library/map cache.
const selections = new WeakMap<VoxelModel, Map<number, VoxelModel>>();
const selectedIndices = new WeakMap<VoxelModel, number>();

/** Keep legacy/default art when the engine index or the corresponding extracted turret is unavailable. */
export function selectVoxelTurretModel(model: VoxelModel, index: number | undefined): VoxelModel {
  if (index === undefined || !Number.isSafeInteger(index) || index <= 0) return model;
  const parts = model.turretVariants?.[String(index)];
  if (
    !parts?.some((part) => part.role === 'turret' && part.sections.length > 0) ||
    parts.some((part) => (part.role !== 'turret' && part.role !== 'barrel') || !part.sections.length)
  )
    return model;
  let variants = selections.get(model);
  if (!variants) selections.set(model, (variants = new Map()));
  let selected = variants.get(index);
  if (!selected) {
    // Preserve the original id: the hull still uses that type's HD projection. Only the turret/barrel changes.
    selected = { ...model, parts: [...model.parts.filter((part) => part.role === 'body'), ...parts] };
    variants.set(index, selected);
    selectedIndices.set(selected, index);
  }
  return selected;
}

/** A nonzero value means only the body may use the type's default redraw projection. */
export function selectedVoxelTurretIndex(model: VoxelModel): number {
  return selectedIndices.get(model) ?? 0;
}
