import type { GuestMemoryAccessor } from '../shared/memoryAccessor';
import { isPlausiblePointer, type YrObjectKind } from './stateReader';

/**
 * How the local player sees a cloaking or cloaked techno in Yuri's Revenge 1.001 (gamemd.exe): the read-only twin
 * of TechnoClass::VisualCharacter (0x703860, virtual +0x68 of vehicles, infantry and aircraft through the FootClass
 * wrapper 0x4DA4E0) as the draw helpers call it, with no specific house: (false, null).
 *
 * The routine returns a VisualType and the draw turns it into a blitter (voxel helper 0x706656..0x70668F, jump table
 * 0x706BB8): 1 Indistinct -> 25 % translucent (flags 0x2002), 2 Darken and 3 Shadowy -> 50 % (0x2004), 4 Ripple ->
 * 25 % or 50 % with the ripple bit (0x200A / 0x200C), 5 Hidden -> not drawn at all.
 *
 *   type InvisibleInGame (+0xC9A): Hidden unless the techno's player-visibility byte (+0x41A) or the reveal global
 *     (0xA8ED6B) is set;
 *   CloakState (+0x220) 0, the reveal global set, or a building: Normal;
 *   CloakState 2 (cloaked): Shadowy when the global at 0xB73550 is zero, when +0x41A is set, when the techno's cell
 *     counts a sensor of the local house (CellClass word at +0x7C + 2 * house index, 0x4870D0), or when the local house
 *     and the owner are allied both ways (HouseClass allies bit field +0x5788, 0x4F9A50; this branch only runs while
 *     the pointer at 0xA8B238 is set); Hidden otherwise;
 *   CloakState 1 or 3 (cloaking, uncloaking): progress (+0x224) / rules CloakingStages (+0x628) * 256 selects
 *     Indistinct below 64, Darken below 128, Shadowy below 192; above that Shadowy when +0x41A is set, else Ripple
 *     and from 255 on Hidden.
 *
 * Not reproduced: the locomotor's own answer, which the FootClass wrapper asks first (ILocomotion slot +0x34); the
 * stock drive, ship, hover, fly and walk locomotors leave the decision to the routine above.
 */
export const YR_TECHNO_VISIBILITY = Object.freeze({
  cloakState: 0x220,
  cloakProgress: 0x224,
  /** Set while the local player may see the techno as its own (owner, ally, spied or revealed). */
  visibleToPlayer: 0x41a,
  owner: 0x21c,
  location: 0x9c,
  typeInvisibleInGame: 0xc9a,
  /** RulesClass::Instance (pointer) and its CloakingStages. */
  rules: 0x8871e0,
  rulesCloakingStages: 0x628,
  /** Byte: everything is drawn (the routine returns Normal). */
  revealAll: 0xa8ed6b,
  /** Dword: while zero a cloaked techno is Shadowy for everyone. */
  cloakHides: 0xb73550,
  /** Pointer: the alliance test for cloaked technos only runs while it is set. */
  allianceGate: 0xa8b238,
  localHouse: 0xa83d4c,
  houseArrayIndex: 0x30,
  houseAllies: 0x5788,
  /** MapClass::Instance cells (VectorClass items, index (y << 9) + x) and the per-house sensor counts of a cell. */
  map: 0x87f7e8,
  mapCellItems: 0x13c,
  cellSensors: 0x7c,
  maxHouses: 24,
});

/** Instruction bytes the loaded image must hold where the offsets above were taken from. */
export const YR_TECHNO_VISIBILITY_SIGNATURES: ReadonlyArray<{ address: number; bytes: readonly number[] }> =
  Object.freeze([
    { address: 0x70386f, bytes: [0x8a, 0x88, 0x9a, 0x0c, 0x00, 0x00] },
    { address: 0x703879, bytes: [0x8a, 0x86, 0x1a, 0x04, 0x00, 0x00] },
    { address: 0x703897, bytes: [0xa0, 0x6b, 0xed, 0xa8, 0x00] },
    { address: 0x7038bb, bytes: [0x8b, 0x8e, 0x20, 0x02, 0x00, 0x00] },
    { address: 0x7038e1, bytes: [0x83, 0xbe, 0x20, 0x02, 0x00, 0x00, 0x02] },
    { address: 0x70396b, bytes: [0xa1, 0x50, 0x35, 0xb7, 0x00] },
    { address: 0x703a09, bytes: [0xa1, 0x38, 0xb2, 0xa8, 0x00] },
    { address: 0x703a67, bytes: [0x8b, 0x86, 0x24, 0x02, 0x00, 0x00] },
    { address: 0x703a83, bytes: [0xda, 0xb2, 0x28, 0x06, 0x00, 0x00] },
    // fmul qword [0x7E1710], and the 256.0 it multiplies by.
    { address: 0x703a89, bytes: [0xdc, 0x0d, 0x10, 0x17, 0x7e, 0x00] },
    { address: 0x7e1710, bytes: [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x70, 0x40] },
    // CellClass sensor count of a house; HouseClass allies test; MapClass cell lookup.
    { address: 0x4870d0, bytes: [0x8b, 0x54, 0x24, 0x04, 0x33, 0xc0, 0x66, 0x39, 0x44, 0x51, 0x7c] },
    { address: 0x4f9a7e, bytes: [0x85, 0x90, 0x88, 0x57, 0x00, 0x00] },
    { address: 0x5657bb, bytes: [0x8b, 0x89, 0x3c, 0x01, 0x00, 0x00, 0x8b, 0x04, 0x81] },
    // The draw's VisualType table and the blitter flags of its cases.
    {
      address: 0x706bb8,
      bytes: [
        0x83, 0x66, 0x70, 0x00, 0x8a, 0x66, 0x70, 0x00, 0x8a, 0x66, 0x70, 0x00, 0x6b, 0x66, 0x70, 0x00, 0xad, 0x6b,
        0x70, 0x00,
      ],
    },
    { address: 0x706683, bytes: [0xbe, 0x02, 0x20, 0x00, 0x00] },
    { address: 0x70668a, bytes: [0xbe, 0x04, 0x20, 0x00, 0x00] },
    { address: 0x706675, bytes: [0xbe, 0x0a, 0x20, 0x00, 0x00] },
    { address: 0x70667c, bytes: [0xbe, 0x0c, 0x20, 0x00, 0x00] },
  ]);

/** True when the image holds every instruction the offsets were taken from. */
export function yrTechnoVisibilitySignaturesMatch(memory: GuestMemoryAccessor): boolean {
  return YR_TECHNO_VISIBILITY_SIGNATURES.every(({ address, bytes }) =>
    bytes.every((byte, i) => memory.u8(address + i) === byte),
  );
}

/** The engine's VisualType, by value. */
export type YrVisual = 'normal' | 'indistinct' | 'darken' | 'shadowy' | 'ripple' | 'hidden';

/** HouseClass::IsAlliedWith (0x4F9A50): the same house, the same index, or the other's bit in the allies field. */
function alliedWith(memory: GuestMemoryAccessor, house: number, other: number): boolean {
  const v = YR_TECHNO_VISIBILITY;
  if (other === 0) return false;
  if (other === house) return true;
  const index = memory.i32(other + v.houseArrayIndex);
  if (index === memory.i32(house + v.houseArrayIndex)) return true;
  if (index < 0 || index >= 32) return false;
  return (memory.u32(house + v.houseAllies) & (1 << index)) !== 0;
}

/**
 * The VisualType the engine's draw sees for this techno and the local player, or undefined when a field is
 * implausible (the caller then draws the object as usual). `typePointer` is the techno's validated type.
 */
export function readYrTechnoVisual(
  memory: GuestMemoryAccessor,
  pointer: number,
  kind: YrObjectKind,
  typePointer: number,
): YrVisual | undefined {
  const v = YR_TECHNO_VISIBILITY;
  if (!isPlausiblePointer(memory, pointer, v.visibleToPlayer + 1)) return undefined;
  if (!isPlausiblePointer(memory, typePointer, v.typeInvisibleInGame + 1)) return undefined;
  const invisibleType = memory.u8(typePointer + v.typeInvisibleInGame);
  const visibleToPlayer = memory.u8(pointer + v.visibleToPlayer);
  const revealAll = memory.u8(v.revealAll);
  if (invisibleType > 1 || visibleToPlayer > 1 || revealAll > 1) return undefined;
  if (invisibleType === 1) {
    if (visibleToPlayer === 1) return 'normal';
    if (revealAll === 0) return 'hidden';
  }
  const state = memory.i32(pointer + v.cloakState);
  if (state < 0 || state > 3) return undefined;
  if (state === 0 || revealAll === 1 || kind === 'building') return 'normal';
  if (state === 2) {
    if (memory.u32(v.cloakHides) === 0 || visibleToPlayer === 1) return 'shadowy';
    const local = memory.u32(v.localHouse);
    if (!isPlausiblePointer(memory, local, v.houseAllies + 4)) return undefined;
    const localIndex = memory.i32(local + v.houseArrayIndex);
    if (localIndex < 0 || localIndex >= v.maxHouses) return undefined;
    const x = memory.i32(pointer + v.location) >> 8;
    const y = memory.i32(pointer + v.location + 4) >> 8;
    const cells = memory.u32(v.map + v.mapCellItems);
    const index = (y << 9) + x;
    if (x >= 0 && y >= 0 && index < 0x40000 && isPlausiblePointer(memory, cells, (index + 1) * 4)) {
      const cell = memory.u32(cells + index * 4);
      if (cell !== 0) {
        if (!isPlausiblePointer(memory, cell, v.cellSensors + v.maxHouses * 2)) return undefined;
        // A signed word, like the engine's `cmp word ptr [...], 0` / setg.
        const sensors = (memory.u16(cell + v.cellSensors + localIndex * 2) << 16) >> 16;
        if (sensors > 0) return 'shadowy';
      }
    }
    if (memory.u32(v.allianceGate) === 0) return 'hidden';
    const owner = memory.u32(pointer + v.owner);
    if (owner === 0) return 'hidden';
    if (!isPlausiblePointer(memory, owner, v.houseAllies + 4)) return undefined;
    return alliedWith(memory, local, owner) && alliedWith(memory, owner, local) ? 'shadowy' : 'hidden';
  }
  const progress = memory.i32(pointer + v.cloakProgress);
  if (progress <= 0) return 'normal';
  const rules = memory.u32(v.rules);
  if (!isPlausiblePointer(memory, rules, v.rulesCloakingStages + 4)) return undefined;
  const stages = memory.i32(rules + v.rulesCloakingStages);
  if (stages <= 0 || stages > 4096 || progress > 4096) return undefined;
  // fild / fidiv / fmul 256.0, then the engine's truncating float-to-int helper (0x7C5F00).
  const value = Math.trunc((progress / stages) * 256);
  if (value < 0x40) return 'indistinct';
  if (value < 0x80) return 'darken';
  if (value < 0xc0) return 'shadowy';
  if (visibleToPlayer === 1) return 'shadowy';
  return value >= 0xff ? 'hidden' : 'ripple';
}

/**
 * What a VisualType means for a renderer that draws the object itself: not drawn at all, or drawn with a body
 * opacity (the complement of the blitter's translucency). Ripple keeps the opacity of its blitter's translucency; the
 * engine picks 25 % while the progress field is zero and 50 % otherwise.
 */
export function yrVisualPresentation(visual: YrVisual): { hidden: true } | { opacity: number } | null {
  switch (visual) {
    case 'hidden':
      return { hidden: true };
    case 'indistinct':
      return { opacity: 0.75 };
    case 'darken':
    case 'shadowy':
    case 'ripple':
      return { opacity: 0.5 };
    default:
      return null;
  }
}
