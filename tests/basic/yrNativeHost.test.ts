import { describe, expect, it, vi } from 'vitest';
import { createByteViewAccessor } from '../../src/games/shared/memoryAccessor';
import {
  createYrNativeCellDiscovery,
  createYrNativeHostPolicy,
  YR_NATIVE_FOLLOW_RULES,
} from '../../src/games/yr/nativeHost';
import { YR_STARTUP_PAGE_HASH } from '../../src/games/yr/startupPage';
import { YR_STATE_GLOBALS as G, YR_STATE_VTABLES } from '../../src/games/yr/stateReader';
import { createGuestMemory, writeU32 } from '../helpers/guestMemory';

describe('native YR policy and bulk cell discovery', () => {
  it('runs the existing render reader through an injected accessor without requesting a dense address-space view', () => {
    const memory = createGuestMemory();
    for (const address of Object.values(YR_STATE_VTABLES)) writeU32(memory, address, 0x401000);
    const accessor = createByteViewAccessor(memory.read_memory(0, 0x1000000));
    const read = vi.spyOn(memory, 'read_memory');
    const policy = createYrNativeHostPolicy(memory, () => accessor, YR_STARTUP_PAGE_HASH, { gameThreadId: 0 });
    const render = policy.createRenderReader();
    expect(render).not.toBeNull();
    expect(render!()).toMatchObject({ frame: 0, map: null, objects: [] });
    expect(read.mock.calls.some(([address]) => address === 0)).toBe(false);
  });
  it('keeps game layout in the policy and gates unknown executable identities', () => {
    const memory = createGuestMemory();
    expect(() =>
      createYrNativeHostPolicy(memory, () => createByteViewAccessor(memory.read_memory(0, 0xc00000)), 'unknown', {
        gameThreadId: 1,
      }),
    ).toThrow('pinned executable');
    expect(YR_NATIVE_FOLLOW_RULES.find((rule) => rule.source === G.technos)).toMatchObject({ kind: 2, bytes: 0x800 });
    expect(YR_NATIVE_FOLLOW_RULES.find((rule) => rule.source === G.map + 0x13c)).toMatchObject({
      kind: 1,
      bytes: 512 * 512 * 4,
    });
    const policy = createYrNativeHostPolicy(
      memory,
      () => createByteViewAccessor(memory.read_memory(0, 0xc00000)),
      YR_STARTUP_PAGE_HASH,
      { gameThreadId: 0 },
    );
    expect(
      policy.installPassthrough(memory, () => {
        throw new Error('must not allocate without native owner');
      }),
    ).toBeNull();
  });

  it('coalesces active cell pages and neighbouring shroud cells, then invalidates on frame reset', () => {
    const memory = createGuestMemory();
    const items = 0xc00000;
    writeU32(memory, G.scenario, 0xc80000);
    writeU32(memory, G.frame, 20);
    writeU32(memory, G.map + 0x13c, items);
    writeU32(memory, G.map + 0x140, 512 * 512);
    for (const [offset, value] of [
      [0, 1],
      [4, 1],
      [8, 1],
      [12, 1],
    ])
      writeU32(memory, G.map + 0x124 + offset!, value!);
    writeU32(memory, items + ((1 << 9) + 1) * 4, 0xd00f80); // crosses two pages
    writeU32(memory, items + ((0 << 9) + 0) * 4, 0xd02000); // neighbour
    writeU32(memory, items + ((5 << 9) + 5) * 4, 0xd08000); // outside bounds and neighbours
    const discover = createYrNativeCellDiscovery(() => createByteViewAccessor(memory.read_memory(0, 0x1000000)));
    const first = discover();
    expect(first).toContainEqual({ address: 0xd00000, length: 0x3000 });
    expect(first.some((range) => range.address <= 0xd08000 && range.address + range.length > 0xd08000)).toBe(false);
    writeU32(memory, G.frame, 21);
    expect(discover()).toBe(first);
    writeU32(memory, G.frame, 1);
    writeU32(memory, items + ((1 << 9) + 1) * 4, 0xd04000);
    expect(discover()).toContainEqual({ address: 0xd04000, length: 0x1000 });
  });

  it('propagates strict misses without caching an incomplete discovery', () => {
    const memory = createGuestMemory();
    writeU32(memory, G.scenario, 0xc80000);
    writeU32(memory, G.map + 0x13c, 0xc00000);
    writeU32(memory, G.map + 0x140, 512 * 512);
    const accessor = createByteViewAccessor(memory.read_memory(0, 0x1000000));
    let missing = true;
    const strict = {
      ...accessor,
      bytes: (address: number, length: number) => {
        if (missing) throw new Error('typed mirror miss');
        return accessor.bytes(address, length);
      },
    };
    const discover = createYrNativeCellDiscovery(() => strict);
    expect(discover).toThrow('typed mirror miss');
    missing = false;
    expect(discover()).toBeDefined();
  });
});
