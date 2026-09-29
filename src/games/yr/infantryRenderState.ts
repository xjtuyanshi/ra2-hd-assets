import type { GuestMemoryAccessor } from '../shared/memoryAccessor';

/**
 * Read-only H2 infantry animation fields for the image guarded by createYrStateReader (YR 1.001,
 * YR_STARTUP_PAGE_HASH). Community YRpp InfantryClass.h, TechnoClass.h, InfantryTypeClass.h and
 * GeneralDefinitions.h supplied leads; each offset and every enum name below were checked against
 * the player's pinned gamemd.exe, rather than inferred from the headers' field order.
 *
 * - InfantryClass constructor 0x517A50 installs vtable 0x7EB058 at 0x517ACC and initializes
 *   SequenceAnim (+0x6C4) to -1 at 0x517A64. InfantryClass::PlayAnim (0x51D6F0, vtable +0x558)
 *   stores the selected sequence at 0x51D9D2: `mov [esi + 0x6c4], edi`.
 * - All 42 DoType/Sequence values are confirmed by the executable's string-pointer table at
 *   0x8255C8: index 0 is Ready, 1 Guard, ... 41 SecondaryProne. InfantryTypeClass's art Sequence
 *   loader (0x523D00) loads that table at 0x523D3F, advances records by 0x24 at 0x524077 and
 *   table entries by four at 0x52407A, and stops at 0x825670 (= base + 42 * 4) at 0x52407D.
 *   This proves these are the art keys and confirms every index independently of YRpp.
 * - TechnoClass::Animation.Value (+0xF8) is the relative sequence step. PlayAnim clears it at
 *   0x51DA8C (`mov [esi + 0xf8], 0`) or stores a random starting step at 0x51DA84. The infantry
 *   image chooser 0x518D80 reads it at 0x518E18 (`mov eax, [ebp + 0xf8]`), takes the remainder
 *   after `idiv max(1, CountFrames)` at 0x518E1F, and adds the sequence StartFrame and facing
 *   stride at 0x518F70..0x518F82. It is therefore not an absolute SHP frame; the renderer must
 *   apply the chosen library sequence. Facing/disguise/type substitutions remain separate.
 * - Infantry direction selection at 0x518F52..0x518F65 quantizes the current 16-bit facing to
 *   32 directions and indexes the reverse eight-facing table 0x7EAEFC. The asset helper uses
 *   its equivalent sector boundaries; Sequence.Facing instead turns primary facing in AI
 *   (0x520CFA..0x520D16), so it must not replace the direction when selecting an SHP frame.
 * - The stage is an accumulator, not bounded by the SHP frame count: sequence AI (0x520AE0)
 *   compares it with CountFrames at 0x520B09 and requests the next/current sequence. PlayAnim
 *   returns before clearing the stage when that request equals the current sequence
 *   (0x51D90B..0x51D913), so a looping Ready/Prone/Deployed sequence may keep a large stage.
 *   Accept its whole nonnegative signed-32-bit range and let the renderer apply the modulo.
 *
 * Unknown/initial (-1) sequences or an invalid object yield no H2 state. An implausible stage
 * omits only sequenceFrame, leaving the independently valid sequence usable by the view.
 */
export const YR_INFANTRY_RENDER_OFFSETS = Object.freeze({
  sequence: 0x6c4,
  sequenceFrame: 0xf8,
});

/** Enum order verified from the pinned executable's art-key table at 0x8255C8. */
export const YR_INFANTRY_SEQUENCES = Object.freeze([
  'Ready',
  'Guard',
  'Prone',
  'Walk',
  'FireUp',
  'Down',
  'Crawl',
  'Up',
  'FireProne',
  'Idle1',
  'Idle2',
  'Die1',
  'Die2',
  'Die3',
  'Die4',
  'Die5',
  'Tread',
  'Swim',
  'WetIdle1',
  'WetIdle2',
  'WetDie1',
  'WetDie2',
  'WetAttack',
  'Hover',
  'Fly',
  'Tumble',
  'FireFly',
  'Deploy',
  'Deployed',
  'DeployedFire',
  'DeployedIdle',
  'Undeploy',
  'Cheer',
  'Paradrop',
  'AirDeathStart',
  'AirDeathFalling',
  'AirDeathFinish',
  'Panic',
  'Shovel',
  'Carry',
  'SecondaryFire',
  'SecondaryProne',
] as const);

export interface YrInfantryRenderState {
  infantrySequence: (typeof YR_INFANTRY_SEQUENCES)[number];
  /** Engine's relative sequence step; apply the art sequence's start, stride and frame count. */
  sequenceFrame?: number;
}

/** Low-level observer; the owning state-reader factory enforces the executable hash/image gate. */
export function readYrInfantryRenderState(memory: GuestMemoryAccessor, pointer: number): YrInfantryRenderState | null {
  if (
    !Number.isInteger(pointer) ||
    pointer < 0x10000 ||
    (pointer & 3) !== 0 ||
    pointer + YR_INFANTRY_RENDER_OFFSETS.sequence + 4 > memory.size
  ) {
    return null;
  }
  try {
    if (memory.u32(pointer) !== 0x7eb058) return null;
    const sequence = memory.i32(pointer + YR_INFANTRY_RENDER_OFFSETS.sequence);
    if (!Number.isInteger(sequence) || sequence < 0 || sequence >= YR_INFANTRY_SEQUENCES.length) return null;
    const infantrySequence = YR_INFANTRY_SEQUENCES[sequence]!;
    const sequenceFrame = memory.i32(pointer + YR_INFANTRY_RENDER_OFFSETS.sequenceFrame);
    // A looping sequence can retain its accumulated stage; only invalid signed-int values are omitted.
    return Number.isInteger(sequenceFrame) && sequenceFrame >= 0 && sequenceFrame <= 0x7fffffff
      ? { infantrySequence, sequenceFrame }
      : { infantrySequence };
  } catch {
    return null;
  }
}
