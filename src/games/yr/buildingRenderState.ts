import type { GuestMemoryAccessor } from '../shared/memoryAccessor';

/**
 * Read-only H2 make-animation state, called by the hash/image-gated YR 1.001 state reader. YRpp
 * BuildingClass.h, BuildingTypeClass.h, TechnoClass.h and MissionClass.h supplied layout leads;
 * these facts were confirmed in the player's gamemd.exe (YR_STARTUP_PAGE_HASH):
 *
 * - BState +0x534 and QueueBState +0x538 start at -1 (0x43B777 / 0x43B77D). BeginMode
 *   (0x447780) stores the requested mode in the queue at 0x447794, clears it at 0x4477B6 and
 *   writes the displayed mode at 0x4477C1: `mov [esi + 0x534], edi`. AI promotes the queue at
 *   0x43FFD5 and clears it at 0x44003C. A queued mode is future intent, never the drawn mode.
 * - Construction mode 0 is requested at 0x44D6BD; completed construction switches to idle 1
 *   at 0x449AC5/0x449AC9. Repair requests active 2 at 0x44B802/0x44B806; missile code requests
 *   modes 4 and 5 at 0x44CA84/0x44CA88 and 0x44CCBE/0x44CCC2. Mode 3's YRpp name "Full" is
 *   not independently established here; H2 only distinguishes mode 0 from other valid modes.
 * - Mission getter 0x5B3040 reads CurrentMission +0xAC and, only when it is -1, QueuedMission
 *   +0xB4 at 0x5B304B. ForceMission stores +0xAC at 0x5B2FE9. The string table 0x816CAC maps
 *   18 to Construction and 19 to Selling; AI bounds the dispatch to 0..31 at 0x5B30B8.
 * - GetCurrentFrame (0x43EF90) reads inline Animation.Value +0xF8 at 0x43EF9A. Animation AI
 *   (0x4509D0) adds Step +0x110 at 0x450A05 and stores Value at 0x450A0E. Selling still
 *   advances this value: 0x43EFF7 compares the effective mission with 19 and 0x43F00F..0x43F025
 *   computes Start + Count - Value - 1. Thus the published make frame is already reversed.
 * - Type.LoadBuildup (0x45F230) writes construction Start +0xF04 = 0 at 0x45F2FE and foreground
 *   Count +0xF08 at 0x45F304 (SHP foreground/shadow count halved at 0x45F2B4..0x45F2C8).
 *   For Gate=yes, 0x45F2D2..0x45F2D9 replaces that count with GateStages +0x16F8 plus one;
 *   the INI loader stores GateStages at 0x4612E8 (key 0x81A6F4, default 9 at 0x45E1F0).
 *   BeginMode initializes Value from Start at 0x447AA7. HasBuildUp +0x6E9 is cleared at
 *   0x43B990 and set after successful loading at 0x442CCF. A missing make is not a done state:
 *   GetImageData 0x4513D0 still requests it in mode 0; DrawIt exits at 0x43D2BB when absent.
 * - Type.Gate +0x16B7 is written by the INI loader at 0x460A13 (key 0x81AA8C); 0x43EFD0
 *   checks it and 0x43EFDA..0x43EFEB applies the same reversal before the selling reversal.
 *   LaserFence +0x16BF / FirestormWall +0x16C0 (stores 0x460ABA / 0x460ADA, keys 0x81AA30 /
 *   0x81AA20) override the frame at 0x43EFAA / 0x43EFBD; their make state is left unavailable.
 *
 * No new indirect pointer is followed beyond the BuildingType pointer. Invalid or partially
 * initialized active-make fields yield no H2 state, allowing the view's snapshot-age fallback.
 */
export const YR_BUILDING_RENDER_OFFSETS = Object.freeze({
  currentMission: 0xac,
  queuedMission: 0xb4,
  stage: 0xf8,
  type: 0x520,
  state: 0x534,
  queuedState: 0x538,
  hasBuildup: 0x6e9,
  makeStart: 0xf04,
  makeCount: 0xf08,
  gate: 0x16b7,
  laserFence: 0x16bf,
  firestormWall: 0x16c0,
});

export interface YrBuildingRenderState {
  buildState: 'building' | 'selling' | 'done';
  /** Actual make SHP frame; selling/gate reversal is already applied. */
  buildupFrame?: number;
}

const pointerFits = (memory: GuestMemoryAccessor, pointer: number, span: number) =>
  Number.isInteger(pointer) && pointer >= 0x10000 && (pointer & 3) === 0 && pointer + span <= memory.size;
const validMode = (mode: number) => Number.isInteger(mode) && mode >= -1 && mode <= 5;
const validMission = (mission: number) => Number.isInteger(mission) && mission >= -1 && mission <= 31;

/** Low-level observer; createYrStateReader owns the executable hash/image guard. */
export function readYrBuildingRenderState(memory: GuestMemoryAccessor, pointer: number): YrBuildingRenderState | null {
  const o = YR_BUILDING_RENDER_OFFSETS;
  if (!pointerFits(memory, pointer, o.hasBuildup + 1)) return null;
  try {
    if (memory.u32(pointer) !== 0x7e3ebc) return null;
    const state = memory.i32(pointer + o.state);
    const queued = memory.i32(pointer + o.queuedState);
    if (!validMode(state) || !validMode(queued)) return null;
    // Constructor sentinel: a queued construction mode does not establish that a body is already complete.
    if (state === -1) return null;
    if (state !== 0) return { buildState: 'done' };
    if (memory.u8(pointer + o.hasBuildup) !== 1) return null;
    const type = memory.u32(pointer + o.type);
    if (!pointerFits(memory, type, o.firestormWall + 1) || memory.u32(type) !== 0x7e4570) return null;
    const gate = memory.u8(type + o.gate);
    if ((gate !== 0 && gate !== 1) || memory.u8(type + o.laserFence) !== 0 || memory.u8(type + o.firestormWall) !== 0)
      return null;
    const currentMission = memory.i32(pointer + o.currentMission);
    const queuedMission = memory.i32(pointer + o.queuedMission);
    if (!validMission(currentMission) || !validMission(queuedMission)) return null;
    const mission = currentMission === -1 ? queuedMission : currentMission;
    const start = memory.i32(type + o.makeStart);
    const count = memory.i32(type + o.makeCount);
    const stage = memory.i32(pointer + o.stage);
    // The pinned loader uses start 0. 0x7FFF is a sanity limit, not an SHP bound: gates use GateStages + 1.
    if (
      start !== 0 ||
      !Number.isInteger(count) ||
      !Number.isInteger(stage) ||
      count <= 0 ||
      count > 0x7fff ||
      stage < 0 ||
      stage >= count
    )
      return null;
    let buildupFrame = gate ? start + count - stage - 1 : stage;
    if (mission === 19) buildupFrame = start + count - buildupFrame - 1;
    return { buildState: mission === 19 ? 'selling' : 'building', buildupFrame };
  } catch {
    return null;
  }
}
