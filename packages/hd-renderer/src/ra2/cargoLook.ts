/**
 * How a Red Alert 2 harvester's bin is drawn for what it carries. The redraw pages of the War Miner and the Chrono
 * Miner (and of their unloading images) show a bin heaped with gold ore; their manifests may name other pages of the
 * same frames for the other loads (VoxelProjectionManifest part `variants`): an empty bin, gems, and both mixed.
 *
 * The game counts the load in bales per ore type (LiveObject.cargo); a miner gathers about one bale per scoop and a
 * refinery takes them out one by one, so the amounts move in whole steps.
 */
export type CargoLook = '' | 'empty' | 'gems' | 'mixed';

/** The variant names a miner's manifest can carry, for tools and tests. */
export const CARGO_LOOKS: readonly Exclude<CargoLook, ''>[] = ['empty', 'gems', 'mixed'];

/** Less than this many bales in all is an empty bin (amounts are whole bales; half a bale is rounding room). */
const EMPTY_BELOW = 0.5;
/** A load is drawn as one kind when the other is at most this share of it. */
const MINOR_SHARE = 0.25;

/**
 * The page variant for a load: '' is the page as drawn (gold ore), also for an object that reports no load at all
 * (not a harvester, or a game that does not publish it).
 */
export function cargoLook(cargo: { ore: number; gems: number } | undefined | null): CargoLook {
  if (!cargo) return '';
  const ore = Math.max(0, cargo.ore) || 0;
  const gems = Math.max(0, cargo.gems) || 0;
  const total = ore + gems;
  if (!(total >= EMPTY_BELOW)) return 'empty';
  const share = gems / total;
  return share <= MINOR_SHARE ? '' : share >= 1 - MINOR_SHARE ? 'gems' : 'mixed';
}
