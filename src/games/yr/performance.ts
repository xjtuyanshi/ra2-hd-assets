import type { GuestMemory } from '../../vm86/win32';
import type { GameFrameReader } from '../performance';
import { createFrameCounterReader } from '../shared/frameCounter';
import { YR_STARTUP_PAGE_HASH } from './startupPage';
import type { NativeHostMetadata } from '../nativeHost';

const YR_GAME_SPEED = 0xa8eb60;
/** SessionClass game mode: 0 campaign, 5 skirmish, the values between are network sessions. */
const YR_SESSION_TYPE = 0xa8b238;

/**
 * The frame limiter of a campaign or skirmish frame, from disassembling the pinned gamemd.exe:
 * - 0x6C8C40 (the system timer every frame timer reads): `call [timeGetTime]; shr eax, 4; ret`, so one tick is 16 ms;
 * - main loop 0x55D79E: the frame timer starts at the current tick and lasts GameSpeed (0xA8EB60) ticks, and the
 *   session type (0xA8B238) of 0 or 5 selects this local limiter; the end of the loop (0x55E2B4) sleeps until the
 *   timer has run out.
 * A frame therefore may not end before GameSpeed tick boundaries have passed: 62.5 / GameSpeed frames a second
 * (62.5 at the skirmish slider's 5, 20.8 at its 3), and no limit at GameSpeed 0. Network sessions pace themselves
 * from the negotiated rate instead and are left unknown here.
 */
const YR_TIMER_TICK_MS = 16;
const YR_LIMITER_SITES: ReadonlyArray<{ site: number; bytes: readonly number[] }> = [
  { site: 0x6c8c40, bytes: [0xff, 0x15, 0x30, 0x15, 0x7e, 0x00, 0xc1, 0xe8, 0x04, 0xc3] },
  {
    site: 0x55d79e,
    bytes: [
      0x8b, 0x35, 0x60, 0xeb, 0xa8, 0x00, 0x8d, 0x4c, 0x24, 0x14, 0xe8, 0x93, 0xb4, 0x16, 0x00, 0x8b, 0x4c, 0x24, 0x14,
      0xa3, 0x48, 0x73, 0x88, 0x00, 0x89, 0x0d, 0x4c, 0x73, 0x88, 0x00, 0x89, 0x35, 0x50, 0x73, 0x88, 0x00, 0xa1, 0x38,
      0xb2, 0xa8, 0x00, 0x85, 0xc0, 0x74, 0x09, 0x83, 0xf8, 0x05,
    ],
  },
];

/** Logic frames a second the limiter allows: null without a limit, undefined when the session is paced otherwise. */
export function yrTargetLogicFps(sessionType: number, gameSpeed: number): number | null | undefined {
  if (sessionType !== 0 && sessionType !== 5) return undefined;
  if (gameSpeed === 0) return null;
  return Number.isInteger(gameSpeed) && gameSpeed >= 1 && gameSpeed <= 6
    ? 1000 / (YR_TIMER_TICK_MS * gameSpeed)
    : undefined;
}

function limiterMatches(memory: GuestMemory): boolean {
  try {
    return YR_LIMITER_SITES.every(({ site, bytes }) => {
      const found = memory.read_memory(site, bytes.length);
      return found.length === bytes.length && bytes.every((byte, index) => found[index] === byte);
    });
  } catch {
    return false;
  }
}

/**
 * YR 1.001: read the frame counter at 0x55de73, INC EDX at 0x55de7e, and write back at 0x55de81. The target rate is
 * added only when the limiter's own instructions match as well; without them the counters stay as they were.
 */
export function createYrFrameReader(
  memory: GuestMemory,
  hash: string,
  verifiedNativeHook?: NativeHostMetadata['verifiedNativeHook'],
): GameFrameReader | null {
  const signature = [
    0x8b, 0x15, 0x84, 0xed, 0xa8, 0, 0xa1, 0x84, 0x77, 0xb0, 0, 0x42, 0x3b, 0xc7, 0x89, 0x15, 0x84, 0xed, 0xa8, 0,
  ];
  if (verifiedNativeHook) {
    const { site, original, patched } = verifiedNativeHook;
    if (
      site !== 0x55de81 ||
      original.length !== 6 ||
      !original.every((byte, index) => byte === signature[index + 14]) ||
      patched.length !== 6 ||
      patched[0] !== 0xe9 ||
      patched[5] !== 0x90 ||
      !patched.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)
    )
      return null;
    // The agent supplies its verified detour, and the reader checks those exact
    // bytes in memory. Neither unrecognized hooks nor fabricated original reads are accepted.
    signature.splice(14, 6, ...patched);
  }
  const counters = createFrameCounterReader(memory, hash, {
    hash: YR_STARTUP_PAGE_HASH,
    site: 0x55de73,
    signature,
    frame: 0xa8ed84,
    gameSpeed: YR_GAME_SPEED,
    sessionSpeed: 0xa8b268,
    requestedFps: 0xa8b558,
  });
  if (!counters || !limiterMatches(memory)) return counters;
  return () => {
    const sample = counters();
    if (!sample) return null;
    try {
      const bytes = memory.read_memory(YR_SESSION_TYPE, 4);
      const sessionType = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, true);
      const targetFps = yrTargetLogicFps(sessionType, sample.gameSpeed);
      return targetFps === undefined ? sample : { ...sample, targetFps };
    } catch {
      return sample;
    }
  };
}
