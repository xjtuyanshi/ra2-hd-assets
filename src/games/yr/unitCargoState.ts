import type { GuestMemoryAccessor } from '../shared/memoryAccessor';
import { isPlausiblePointer } from './stateReader';

/**
 * What a harvester carries (YR 1.001, gamemd.exe). TechnoClass keeps a StorageClass at +0x33C: four floats, the
 * amount held of each Tiberium type in bales (the unit of the rules' `Storage=`), in the order of the rules'
 * [Tiberiums] list: Riparius, Cruentus, Vinifera, Aboreus. Yuri's Revenge maps the overlays to these types in code:
 * TIB01..TIB20 (ore) are Riparius, GEM01..GEM12 (gems) are Cruentus, the two unused ore sets are Vinifera and Aboreus.
 *
 * Evidence: `lea ecx, [esi+0x33C]` in the unit's harvest and unload code (0x73E3BF, 0x73E412, 0x73E451, 0x73D4F7) and
 * `lea edi, [ebp+0x33C]` where the pips under a selected harvester are counted (0x70A1F6). Read in a running match:
 * a Chrono Miner gathering ore shows float 11.0 at +0x33C and zeros at +0x340..+0x348, a miner that has not gathered
 * yet shows four zeros, and the dword before the block (+0x338, the hijacker's infantry type) is -1.
 */
export const YR_UNIT_CARGO = Object.freeze({
  /** TechnoClass::Tiberium (StorageClass: float[4]). */
  storage: 0x33c,
  types: 4,
  /** Index of Cruentus, the type of the gem overlays. */
  gems: 1,
  /** More than any harvester holds (Storage= is 20 to 40 in the stock rules): a larger value is a torn read. */
  limit: 4096,
});

const scratch = new DataView(new ArrayBuffer(4));
function f32(memory: GuestMemoryAccessor, address: number): number {
  scratch.setUint32(0, memory.u32(address), true);
  return scratch.getFloat32(0, true);
}

/** Bales carried, by what the refinery pays for them: ordinary ore (three of the four types) and gems. */
export interface YrUnitCargo {
  ore: number;
  gems: number;
}

/** The harvester's load, or undefined when the block cannot be read or holds an implausible amount. */
export function readYrUnitCargo(memory: GuestMemoryAccessor, unit: number): YrUnitCargo | undefined {
  const c = YR_UNIT_CARGO;
  if (!isPlausiblePointer(memory, unit, c.storage + c.types * 4)) return undefined;
  let ore = 0;
  let gems = 0;
  for (let type = 0; type < c.types; type++) {
    const amount = f32(memory, unit + c.storage + type * 4);
    if (!Number.isFinite(amount) || amount < 0 || amount > c.limit) return undefined;
    if (type === c.gems) gems += amount;
    else ore += amount;
  }
  return { ore, gems };
}
