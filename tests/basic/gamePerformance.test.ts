import { expect, it, vi } from 'vitest';
import { GamePerformanceMeter } from '../../src/adapter/gamePerformance';
import { createRa2FrameReader } from '../../src/games/ra2/performance';
import { createYrFrameReader, yrTargetLogicFps } from '../../src/games/yr/performance';
import { RA2_STARTUP_PAGE_HASH } from '../../src/games/ra2/startupPage';
import { YR_STARTUP_PAGE_HASH } from '../../src/games/yr/startupPage';
import { createGuestMemory, writeU32 } from '../helpers/guestMemory';
import { summarizeGamePerformance } from '../helpers/gamePerformance';

const profiles = [
  {
    create: createRa2FrameReader,
    hash: RA2_STARTUP_PAGE_HASH,
    other: YR_STARTUP_PAGE_HASH,
    site: 0x540676,
    frame: 0xa40d2c,
    bytes: [
      0x8b, 0x15, 0x2c, 0x0d, 0xa4, 0, 0xa1, 0x74, 0x91, 0xab, 0, 0x42, 0x3b, 0xc7, 0x89, 0x15, 0x2c, 0x0d, 0xa4, 0,
    ],
  },
  {
    create: createYrFrameReader,
    hash: YR_STARTUP_PAGE_HASH,
    other: RA2_STARTUP_PAGE_HASH,
    site: 0x55de73,
    frame: 0xa8ed84,
    bytes: [
      0x8b, 0x15, 0x84, 0xed, 0xa8, 0, 0xa1, 0x84, 0x77, 0xb0, 0, 0x42, 0x3b, 0xc7, 0x89, 0x15, 0x84, 0xed, 0xa8, 0,
    ],
  },
];
it.each(profiles)('帧计数仅接受自己的 EXE 和指令签名，采样不写内存：$site', (p) => {
  const memory = createGuestMemory();
  memory.write_memory(p.bytes, p.site);
  writeU32(memory, p.frame, 321);
  const write = vi.spyOn(memory, 'write_memory');
  expect(p.create(memory, p.other)).toBeNull();
  expect(p.create(memory, p.hash)!()?.frame).toBe(321);
  expect(write).not.toHaveBeenCalled();
  memory.write_memory([0x90], p.site);
  expect(p.create(memory, p.hash)).toBeNull();
});
const counters = (frame: number) => ({ frame, gameSpeed: 0, sessionSpeed: 0, requestedFps: 60 });
it('目标 60 不冒充实际 FPS；停滞为零，菜单/重置/同时间不产生假峰值', () => {
  const meter = new GamePerformanceMeter();
  expect(meter.sample(counters(10), 100, true).logicFps).toBeNull();
  expect(meter.sample(counters(40), 1100, true).logicFps).toBe(30);
  expect(meter.sample(counters(40), 2100, true).logicFps).toBe(0);
  expect(meter.sample(counters(1), 3100, true).status).toBe('reset');
  expect(meter.sample(counters(2), 3100, true).logicFps).toBeNull();
  expect(meter.sample(counters(3), 3200, false).status).toBe('inactive');
  expect(meter.sample(counters(4), 3300, true).status).toBe('baseline');
});
it('按实际窗口时长加权，预热不足返回不可用，重置使报告失效', () => {
  const meter = new GamePerformanceMeter();
  const samples = [
    [0, 0],
    [30, 1000],
    [150, 3000],
    [150, 4000],
    [150, 5000],
  ].map(([frame, at]) => meter.sample(counters(frame!), at!, true));
  expect(summarizeGamePerformance(samples)).toMatchObject({
    logicFps: 30,
    windowFpsP05: 0,
    maxObservedStallMs: 2000,
    valid: true,
  });
  expect(summarizeGamePerformance(samples, 30000)).toBeNull();
  samples.push(meter.sample(counters(0), 6000, true));
  expect(summarizeGamePerformance(samples)).toMatchObject({ valid: false, invalidWindows: 1 });
});

const YR_COUNTER = profiles[1]!;
const YR_TIMER = { site: 0x6c8c40, bytes: [0xff, 0x15, 0x30, 0x15, 0x7e, 0x00, 0xc1, 0xe8, 0x04, 0xc3] };
const YR_LIMITER = {
  site: 0x55d79e,
  bytes: [
    0x8b, 0x35, 0x60, 0xeb, 0xa8, 0x00, 0x8d, 0x4c, 0x24, 0x14, 0xe8, 0x93, 0xb4, 0x16, 0x00, 0x8b, 0x4c, 0x24, 0x14,
    0xa3, 0x48, 0x73, 0x88, 0x00, 0x89, 0x0d, 0x4c, 0x73, 0x88, 0x00, 0x89, 0x35, 0x50, 0x73, 0x88, 0x00, 0xa1, 0x38,
    0xb2, 0xa8, 0x00, 0x85, 0xc0, 0x74, 0x09, 0x83, 0xf8, 0x05,
  ],
};
it('YR 的应有帧率来自限帧指令：每档 16 毫秒一拍，0 档不限速，联机会话不给出', () => {
  expect(yrTargetLogicFps(5, 1)).toBe(62.5);
  expect(yrTargetLogicFps(5, 3)).toBeCloseTo(20.83, 2);
  expect(yrTargetLogicFps(0, 2)).toBe(31.25);
  expect(yrTargetLogicFps(5, 6)).toBeCloseTo(10.42, 2);
  expect(yrTargetLogicFps(5, 0)).toBeNull();
  expect(yrTargetLogicFps(3, 1)).toBeUndefined();
  expect(yrTargetLogicFps(5, 7)).toBeUndefined();
});
it('YR 帧计数只有在限帧指令也吻合时才附带应有帧率，且不写内存', () => {
  const memory = createGuestMemory();
  memory.write_memory(YR_COUNTER.bytes, YR_COUNTER.site);
  writeU32(memory, YR_COUNTER.frame, 900);
  writeU32(memory, 0xa8eb60, 1); // GameSpeed
  writeU32(memory, 0xa8b238, 5); // skirmish
  // Counter signature alone: the counters, no target.
  expect(createYrFrameReader(memory, YR_STARTUP_PAGE_HASH)!()).toEqual({
    frame: 900,
    gameSpeed: 1,
    sessionSpeed: 0,
    requestedFps: 0,
  });
  memory.write_memory(YR_TIMER.bytes, YR_TIMER.site);
  memory.write_memory(YR_LIMITER.bytes, YR_LIMITER.site);
  const write = vi.spyOn(memory, 'write_memory');
  const read = createYrFrameReader(memory, YR_STARTUP_PAGE_HASH)!;
  expect(read()).toMatchObject({ frame: 900, gameSpeed: 1, targetFps: 62.5 });
  expect(write).not.toHaveBeenCalled();
  write.mockRestore();
  // The setting is read at every sample: the in-game slider moves it during a match.
  writeU32(memory, 0xa8eb60, 3);
  expect(read()!.targetFps).toBeCloseTo(20.83, 2);
  writeU32(memory, 0xa8eb60, 0);
  expect(read()!.targetFps).toBeNull();
  writeU32(memory, 0xa8b238, 3); // a network session paces itself from the negotiated rate
  expect(read()).not.toHaveProperty('targetFps');
  // One changed limiter byte: the reader still counts frames but claims no target.
  memory.write_memory([0x05], YR_TIMER.site + 8);
  writeU32(memory, 0xa8b238, 5);
  expect(createYrFrameReader(memory, YR_STARTUP_PAGE_HASH)!()).not.toHaveProperty('targetFps');
  // The meter passes the target through to the sample the page reads.
  memory.write_memory(YR_TIMER.bytes, YR_TIMER.site);
  writeU32(memory, 0xa8eb60, 1);
  const sample = new GamePerformanceMeter().sample(createYrFrameReader(memory, YR_STARTUP_PAGE_HASH)!()!, 10, true);
  expect(sample.targetFps).toBe(62.5);
});
