import type { GuestMemoryAccessor } from '../shared/memoryAccessor';
import { readYrObjectCoords, type YrPoint3 } from './objectCoords';

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
 * - Infantry direction selection quantizes a 16-bit facing to 32 directions and indexes the
 *   reverse eight-facing table 0x7EAEFC. Normally this is PrimaryFacing (0x518F46..0x518F65).
 *   The JumpJet branch (0x518E27..0x518F2E) instead uses direction to Target +0x2B4 when
 *   Type.JumpJet +0xD94 is true, Type.JumpJetTurn +0xECB is false and the locomotor CLSID is
 *   Jumpjet (0x7E9AC0). INI stores: 0x715200 (JumpJet), 0x524668 (JumpJetTurn, key 0x8258FC).
 *   Jumpjet's constructor installs IPersist vtable 0x7ECE34 and ILocomotion 0x7ECD68 at base+4
 *   (0x54ACC3..0x54ACD0); GetClassID 0x54B710 returns that CLSID. Validate those interfaces
 *   without calling guest COM. Direction helper 0x5F3DB0 uses both objects' GetCoords (+0x48),
 *   the atan lookup 0x4CAE30 (float table 0x8610B4, step 0x8650B8), subtracts pi/2 (0x7E2820),
 *   multiplies by -65534/(2*pi) (0x7E2818), then truncates through 0x7C5F00 and stores a word.
 *   Publish that draw-only facing separately from travel/PrimaryFacing. The asset helper uses
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
  type: 0x6c0,
  jumpJet: 0xd94,
  jumpJetTurn: 0xecb,
  locomotor: 0x674,
  target: 0x2b4,
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
  /** Engine-selected 16-bit SHP direction, only when the JumpJet target branch is validated. */
  infantryDrawFacingRaw?: number;
}

const pointerFits = (memory: GuestMemoryAccessor, pointer: number, span: number) =>
  Number.isInteger(pointer) && pointer >= 0x10000 && (pointer & 3) === 0 && pointer + span <= memory.size;
const validCoords = (point: YrPoint3 | null): point is YrPoint3 =>
  point !== null &&
  Number.isInteger(point.x) &&
  Math.abs(point.x) <= 512 * 256 &&
  Number.isInteger(point.y) &&
  Math.abs(point.y) <= 512 * 256 &&
  Number.isInteger(point.z) &&
  Math.abs(point.z) <= 64 * 104;

function readFloat(memory: GuestMemoryAccessor, address: number): number {
  const bytes = memory.bytes(address, 4);
  return bytes.length === 4 ? new DataView(bytes.buffer, bytes.byteOffset, 4).getFloat32(0, true) : NaN;
}

/** Reproduce 0x4CAE30's lookup/quadrants, not Math.atan2's different sector boundaries. */
function targetFacing(memory: GuestMemoryAccessor, source: YrPoint3, target: YrPoint3): number | undefined {
  const x = target.x - source.x;
  const y = source.y - target.y;
  let angle: number;
  if (x === 0) angle = y === 0 ? 0 : y > 0 ? Math.fround(Math.PI / 2) : -Math.fround(Math.PI / 2);
  else {
    const step = readFloat(memory, 0x8650b8);
    if (step !== 0.024413354694843292) return undefined;
    const index = Math.abs(Math.trunc(y / x / step));
    angle = index <= 4096 ? readFloat(memory, 0x8610b4 + index * 4) : Math.fround(Math.PI / 2);
    if (!Number.isFinite(angle) || angle < 0 || angle > Math.fround(Math.PI / 2) || (index > 0 && angle === 0))
      return undefined;
    if (x < 0) angle = Math.PI - angle;
    if (y < 0) angle = -angle;
  }
  return Math.trunc((angle - Math.PI / 2) * (-65534 / (2 * Math.PI))) & 0xffff;
}

/** An unreadable optional target/locomotor never discards a valid sequence or animation step. */
function readDrawFacing(memory: GuestMemoryAccessor, pointer: number): number | undefined {
  const o = YR_INFANTRY_RENDER_OFFSETS;
  try {
    const type = memory.u32(pointer + o.type);
    if (
      !pointerFits(memory, type, o.jumpJetTurn + 1) ||
      memory.u32(type) !== 0x7eb610 ||
      memory.u8(type + o.jumpJet) !== 1 ||
      memory.u8(type + o.jumpJetTurn) !== 0
    )
      return undefined;
    const locomotor = memory.u32(pointer + o.locomotor);
    if (
      !pointerFits(memory, locomotor - 4, 8) ||
      memory.u32(locomotor) !== 0x7ecd68 ||
      memory.u32(locomotor - 4) !== 0x7ece34 ||
      memory.u32(0x7ece40) !== 0x54b710
    )
      return undefined;
    const target = readYrObjectCoords(memory, memory.u32(pointer + o.target));
    const source = readYrObjectCoords(memory, pointer);
    return validCoords(source) && validCoords(target) ? targetFacing(memory, source, target) : undefined;
  } catch {
    return undefined;
  }
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
    const state: YrInfantryRenderState =
      Number.isInteger(sequenceFrame) && sequenceFrame >= 0 && sequenceFrame <= 0x7fffffff
        ? { infantrySequence, sequenceFrame }
        : { infantrySequence };
    const drawFacing = readDrawFacing(memory, pointer);
    if (drawFacing !== undefined) state.infantryDrawFacingRaw = drawFacing;
    return state;
  } catch {
    return null;
  }
}
