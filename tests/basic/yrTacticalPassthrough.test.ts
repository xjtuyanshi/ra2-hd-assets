import { afterEach, describe, expect, it, vi } from 'vitest';
import { RENDER_PASSTHROUGH, RENDER_PASSTHROUGH_KEY_RGB565 } from '../../src/games/renderPassthrough';
import { GATE_DATA, readGateSwitches } from '../../src/games/shared/guestGates';
import {
  YR_PASSTHROUGH_GATES,
  installYrTacticalPassthrough,
  yrPassthroughOriginalBytes,
  yrPassthroughSwitches,
} from '../../src/games/yr/tacticalPassthrough';
import { YR_RUNTIME_HOOKS } from '../../src/games/yr/runtimeHooks';
import { YR_STARTUP_PAGE_HASH } from '../../src/games/yr/startupPage';
import { createGuestMemory, readU32 } from '../helpers/guestMemory';

const REGION = 0x00c0_0000;

function imageWithOriginals() {
  const memory = createGuestMemory();
  for (const site of yrPassthroughOriginalBytes()) memory.write_memory(site.bytes, site.address);
  let next = REGION + 0x4000;
  const reserve = (size: number, alignment = 16) => {
    next = Math.floor((next - size) / alignment) * alignment;
    if (next < REGION) throw new Error('region exhausted');
    return next;
  };
  return { memory, reserve };
}

describe('YR 1.001 原生叠加层直通补丁', () => {
  it('站点清单互不重叠', () => {
    const ranges = yrPassthroughOriginalBytes()
      .map((site) => [site.address, site.address + site.bytes.length] as const)
      .sort((a, b) => a[0] - b[0]);
    for (let i = 1; i < ranges.length; i++) expect(ranges[i]![0]).toBeGreaterThanOrEqual(ranges[i - 1]![1]);
  });

  it('全部原始字节吻合才安装；数据页与代码页分离，默认关闭', () => {
    const { memory, reserve } = imageWithOriginals();
    const result = installYrTacticalPassthrough(memory, reserve);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { gates, control } = result;
    expect(gates.data % 0x1000).toBe(0);
    expect(Math.floor(gates.code / 0x1000)).not.toBe(gates.data / 0x1000);
    for (const site of yrPassthroughOriginalBytes())
      expect([...memory.read_memory(site.address, site.bytes.length)], site.name).not.toEqual(site.bytes);
    expect(readU32(memory, gates.data + GATE_DATA.user + 4)).toBe(RENDER_PASSTHROUGH_KEY_RGB565);
    expect(control.read(memory).flags).toBe(0);
    expect([...memory.read_memory(gates.data + GATE_DATA.switches, 32)].every((byte) => byte === 0)).toBe(true);
  });

  it('任一站点不符时整体不安装、不写任何字节', () => {
    const { memory, reserve } = imageWithOriginals();
    const victim = yrPassthroughOriginalBytes().find((site) => site.name === 'blit:voxel')!;
    memory.write_memory([0x90], victim.address);
    const snapshot = yrPassthroughOriginalBytes().map((site) => [
      ...memory.read_memory(site.address, site.bytes.length),
    ]);
    const result = installYrTacticalPassthrough(memory, reserve);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.mismatches.map((m) => m.name)).toEqual(['blit:voxel']);
    expect(
      yrPassthroughOriginalBytes().map((site) => [...memory.read_memory(site.address, site.bytes.length)]),
    ).toEqual(snapshot);
    expect([...memory.read_memory(REGION, 0x4000)].every((byte) => byte === 0)).toBe(true);
  });

  it('建筑后方选择角框的 DrawBehind 槽在安装和全部类别开启后保持原样', () => {
    const { memory, reserve } = imageWithOriginals();
    const buildingDrawBehind = 0x007e_3ebc + 0x10c;
    memory.write_memory([0xd0, 0x60, 0x6f, 0x00], buildingDrawBehind);
    const result = installYrTacticalPassthrough(memory, reserve);
    if (!result.ok) throw new Error(result.reason);
    expect(result.control.set(memory, 7)).toBe(true);
    expect(readU32(memory, buildingDrawBehind)).toBe(0x006f_60d0);
  });

  it('按类别写待定开关位（下一帧开头才锁存）；类别变化时请求一次整屏重绘', () => {
    const { memory, reserve } = imageWithOriginals();
    const result = installYrTacticalPassthrough(memory, reserve);
    if (!result.ok) throw new Error(result.reason);
    const { gates, control } = result;
    const request = gates.data + GATE_DATA.user + 12;
    expect(control.set(memory, RENDER_PASSTHROUGH.terrain | RENDER_PASSTHROUGH.objects)).toBe(true);
    expect(control.read(memory)).toMatchObject({ flags: 3, applied: 0 });
    expect(readGateSwitches(memory, gates, 'pending').sort()).toEqual(yrPassthroughSwitches(3).sort());
    // The live bitmap the stubs test changes only when the guest's redraw:request stub latches it.
    expect(readGateSwitches(memory, gates)).toEqual([]);
    expect(readU32(memory, request)).toBe(1);
    memory.write_memory([0, 0, 0, 0], request); // the guest consumed it
    expect(control.set(memory, 3)).toBe(true);
    expect(readU32(memory, request)).toBe(0);
    expect(control.set(memory, 0)).toBe(true);
    expect(readGateSwitches(memory, gates, 'pending')).toEqual([]);
    expect(readU32(memory, request)).toBe(1);
    expect(control.set(memory, 8)).toBe(false);
    expect(control.set(memory, -1)).toBe(false);
  });

  it('接管运行中的对局：只请求一次整屏重绘，不改类别开关', () => {
    const { memory, reserve } = imageWithOriginals();
    const result = installYrTacticalPassthrough(memory, reserve);
    if (!result.ok) throw new Error(result.reason);
    const { gates, control } = result;
    const request = gates.data + GATE_DATA.user + 12;
    expect(control.repaint?.(memory)).toBe(true);
    expect(readU32(memory, request)).toBe(1);
    expect(control.read(memory)).toMatchObject({ flags: 0, applied: 0 });
    expect(readGateSwitches(memory, gates, 'pending')).toEqual([]);
    expect(readGateSwitches(memory, gates)).toEqual([]);
  });

  it('特效列表：寿命/移除/释放所在的 EBolt、RadBeam 列表压制运行，LineTrail 只跳过单条绘制，纯绘制列表整体跳过', () => {
    const byName = new Map(YR_PASSTHROUGH_GATES.map((gate) => [gate.name, gate]));
    const call = (address: number, target: number) => ({ kind: 'call', address, target });
    // Lists that also age, remove and free their objects keep running; only their pixels are removed.
    expect(byName.get('ebolt:draw-all')).toMatchObject({
      category: 'effects',
      site: call(0x006d_466e, 0x004c_2830),
      action: { kind: 'suppress' },
    });
    expect(byName.get('rad-beam:draw-all')).toMatchObject({
      category: 'effects',
      site: call(0x006d_4678, 0x0065_91b0),
      action: { kind: 'suppress' },
    });
    expect(byName.get('line-trail:draw')).toMatchObject({
      category: 'effects',
      site: call(0x0055_6dd2, 0x0055_6c00),
      action: { kind: 'skip', returnBytes: 0 },
    });
    expect(byName.has('line-trail:draw-all')).toBe(false);
    // Pure drawing lists (pixels written straight into the locked surface) are skipped whole.
    for (const [name, address, target] of [
      ['ion-blast:draw-all', 0x006d_4656, 0x0053_d850],
      ['spotlight:draw-all', 0x006d_4664, 0x005f_ffa0],
      ['laser:draw-all', 0x006d_4669, 0x0055_0240],
    ] as const)
      expect(byName.get(name), name).toMatchObject({ site: call(address, target), action: { kind: 'skip' } });
    // Original bytes as disassembled from gamemd.exe (SHA-256 7b8a0685…94b6).
    const bytes = new Map(yrPassthroughOriginalBytes().map((site) => [site.name, site]));
    expect(bytes.get('line-trail:draw')).toEqual({
      name: 'line-trail:draw',
      address: 0x0055_6dd2,
      bytes: [0xe8, 0x29, 0xfe, 0xff, 0xff],
    });
    expect(bytes.get('ebolt:draw-all')?.bytes).toEqual([0xe8, 0xbd, 0xe1, 0xde, 0xff]);
    expect(bytes.get('rad-beam:draw-all')?.bytes).toEqual([0xe8, 0x33, 0x4b, 0xf8, 0xff]);
  });

  it('类别映射：地形填充、对象（含建筑动画）、特效相互独立，图元闸门随任一类别开启', () => {
    expect(yrPassthroughSwitches(0)).toEqual([]);
    const blits = YR_PASSTHROUGH_GATES.filter((gate) => gate.category === 'always').map((gate) => gate.name);
    const of = (category: string) =>
      YR_PASSTHROUGH_GATES.filter((gate) => gate.category === category).map((gate) => gate.name);
    expect(yrPassthroughSwitches(1).sort()).toEqual([...of('terrain'), ...blits, 'terrain:fill'].sort());
    expect(of('terrain')).toHaveLength(9);
    expect(yrPassthroughSwitches(2).sort()).toEqual([...of('objects'), ...blits, 'anim:building'].sort());
    expect(yrPassthroughSwitches(4).sort()).toEqual([...of('effects'), ...blits].sort());
    expect(of('objects')).toContain('building:draw');
    expect(of('effects')).toContain('anim:draw');
  });

  it('运行时钩子：镜像不符或内存不足时返回 null，不抛出、不改镜像', async () => {
    const memory = createGuestMemory();
    let next = REGION + 0x4000;
    const reserve = (size: number, alignment = 16) => (next = Math.floor((next - size) / alignment) * alignment);
    // Awaited: the hook may load the patch module on demand (development-only code).
    expect(await YR_RUNTIME_HOOKS.prepareRenderPassthrough!(memory, reserve)).toBeNull();
    expect([...memory.read_memory(0x006d_45c7, 20)].every((byte) => byte === 0)).toBe(true);
    const full = imageWithOriginals();
    const exhausted = () => {
      throw new Error('补丁内存区不足');
    };
    expect(await YR_RUNTIME_HOOKS.prepareRenderPassthrough!(full.memory, exhausted)).toBeNull();
    expect(await YR_RUNTIME_HOOKS.prepareRenderPassthrough!(full.memory, full.reserve)).not.toBeNull();
  });
});

describe('生产构建中的 HD 桥接钩子', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.doUnmock('../../src/games/yr/renderState');
    vi.doUnmock('../../src/games/yr/tacticalPassthrough');
  });

  it('import.meta.env.DEV 为 false 时两个钩子都返回 null，且不加载开发期模块', async () => {
    // Production builds fold the flag to false and drop the dynamic imports (the architecture test keeps the modules
    // off the static graph); here the flag is stubbed and the modules are mocked to record whether they were loaded.
    const loaded: string[] = [];
    vi.doMock('../../src/games/yr/renderState', () => {
      loaded.push('renderState');
      return { createYrRenderStateReader: () => 'reader' };
    });
    vi.doMock('../../src/games/yr/tacticalPassthrough', () => {
      loaded.push('tacticalPassthrough');
      return { prepareYrRenderPassthrough: () => 'control' };
    });
    const full = imageWithOriginals();
    const size = full.memory.bytes.length;
    vi.stubEnv('DEV', false);
    expect(await YR_RUNTIME_HOOKS.createRenderStateReader!(full.memory, size, YR_STARTUP_PAGE_HASH)).toBeNull();
    expect(await YR_RUNTIME_HOOKS.prepareRenderPassthrough!(full.memory, full.reserve)).toBeNull();
    expect(loaded).toEqual([]);
    for (const site of yrPassthroughOriginalBytes())
      expect([...full.memory.read_memory(site.address, site.bytes.length)], site.name).toEqual(site.bytes);
    // Control: with the flag on, the same calls reach the mocked modules, so the nulls above come from the DEV branch.
    vi.stubEnv('DEV', true);
    expect(await YR_RUNTIME_HOOKS.createRenderStateReader!(full.memory, size, YR_STARTUP_PAGE_HASH)).toBe('reader');
    expect(await YR_RUNTIME_HOOKS.prepareRenderPassthrough!(full.memory, full.reserve)).toBe('control');
    expect(loaded).toEqual(['renderState', 'tacticalPassthrough']);
  });
});
