import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { YR_STARTUP_PAGE_HASH } from '../../../src/games/yr/startupPage';
import { installYrTacticalPassthrough, yrPassthroughOriginalBytes } from '../../../src/games/yr/tacticalPassthrough';
import { le32 } from '../../../src/games/shared/bytes';
import { createGuestMemory } from '../../helpers/guestMemory';
import { gameResourceExe, requireGameResources } from '../helpers/gameDir';

/** Map a PE's sections to their virtual addresses (headers only as far as the installer needs). */
function mapImage(exe: Uint8Array) {
  const view = new DataView(exe.buffer, exe.byteOffset, exe.byteLength);
  const pe = view.getUint32(0x3c, true);
  const sections = view.getUint16(pe + 6, true);
  const optional = view.getUint16(pe + 20, true);
  const imageBase = view.getUint32(pe + 24 + 28, true);
  const memory = createGuestMemory(16 * 1024 * 1024);
  for (let i = 0; i < sections; i++) {
    const header = pe + 24 + optional + i * 40;
    const virtualAddress = view.getUint32(header + 12, true);
    const rawSize = view.getUint32(header + 16, true);
    const rawPointer = view.getUint32(header + 20, true);
    memory.write_memory(exe.subarray(rawPointer, rawPointer + rawSize), imageBase + virtualAddress);
  }
  return memory;
}

describe('YR 1.001 原生叠加层直通：原版 gamemd.exe 站点', () => {
  requireGameResources('yr');
  const exe = new Uint8Array(readFileSync(gameResourceExe('yr')));

  it('固定版本的每个站点都保持文档记录的原始字节，补丁可完整安装', () => {
    expect(createHash('sha256').update(exe).digest('hex')).toBe(YR_STARTUP_PAGE_HASH);
    const memory = mapImage(exe);
    for (const site of yrPassthroughOriginalBytes())
      expect([...memory.read_memory(site.address, site.bytes.length)], site.name).toEqual(site.bytes);
    let next = 0x00f0_0000;
    const result = installYrTacticalPassthrough(memory, (size, alignment = 16) => {
      next = Math.floor((next - size) / alignment) * alignment;
      return next;
    });
    expect(result.ok ? [] : result.mismatches).toEqual([]);
  });

  it('特效列表的处理依据：EBolt/LineTrail/RadBeam 的 DrawAll 自己负责老化与释放，逐条绘制只经所记录的图元', () => {
    const memory = mapImage(exe);
    const call = (address: number, target: number) => [0xe8, ...le32(target - (address + 5))];
    // Instructions the patch's choice rests on (docs/remaster/research/tactical-passthrough.md, "effect lists").
    const premises: [string, number, number[]][] = [
      ['EBolt DrawAll: per-bolt draw 0x4C1F20', 0x004c_2938, call(0x004c_2938, 0x004c_1f20)],
      ['EBolt DrawAll: Lifetime >>= 1', 0x004c_2940, [0x8b, 0x0b, 0xd1, 0xf9, 0x89, 0x0b]],
      ['EBolt DrawAll: free the bolt', 0x004c_29ba, call(0x004c_29ba, 0x007c_8b3d)],
      ['EBolt draw: DSurface vtable +0x34 line', 0x004c_2512, [0xff, 0x52, 0x34]],
      ['LineTrail DrawAll: LineTrail::Update', 0x0055_6d5e, call(0x0055_6d5e, 0x0055_6b70)],
      ['LineTrail DrawAll: free the trail', 0x0055_6dc6, call(0x0055_6dc6, 0x007c_8b3d)],
      ['LineTrail DrawAll: per-trail draw 0x556C00', 0x0055_6dd2, call(0x0055_6dd2, 0x0055_6c00)],
      ['LineTrail draw: direct line call 0x4BEAC0 (not gated)', 0x0055_6ce5, call(0x0055_6ce5, 0x004b_eac0)],
      ['RadBeam DrawAll: update 0x659650', 0x0065_92c6, call(0x0065_92c6, 0x0065_9650)],
      ['RadBeam DrawAll: update 0x659CA0', 0x0065_930a, call(0x0065_930a, 0x0065_9ca0)],
      ['RadBeam DrawAll: free the beam', 0x0065_93cd, call(0x0065_93cd, 0x007c_8b3d)],
    ];
    for (const [name, address, bytes] of premises)
      expect([...memory.read_memory(address, bytes.length)], name).toEqual(bytes);
  });
});
