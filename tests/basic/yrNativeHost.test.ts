import { describe, expect, it, vi } from 'vitest';
import { createByteViewAccessor } from '../../src/games/shared/memoryAccessor';
import { NativeMirrorMemory } from '../../src/adapter/native/memory';
import {
  createYrNativeCellDiscovery,
  createYrNativeHostPolicy,
  YR_NATIVE_FOLLOW_RULES,
  YR_NATIVE_EFFECT_TYPE_ARRAYS,
  YR_NATIVE_RANGES,
} from '../../src/games/yr/nativeHost';
import {
  readYrEffects,
  YR_EFFECTS_GLOBALS as E,
  YR_EFFECTS_OFFSETS as O,
  YR_EFFECTS_VTABLES as V,
} from '../../src/games/yr/effectsReader';
import { YR_STARTUP_PAGE_HASH } from '../../src/games/yr/startupPage';
import { readYrUnitMovingNow, YR_GATHER_OFFSETS, YR_GATHER_LOCOMOTORS } from '../../src/games/yr/unitGatherState';
import {
  createYrStateReader,
  YR_STATE_GLOBALS as G,
  YR_STATE_LIMITS as L,
  YR_STATE_OFFSETS as S,
  YR_STATE_VTABLES,
} from '../../src/games/yr/stateReader';
import { createGuestMemory, writeAsciiZ, writeU32, readU32, type FakeGuestMemory } from '../helpers/guestMemory';

/** Resolve policy-selected live graphs independently of any reader miss discovery. */
function policyPages(source: FakeGuestMemory): Set<number> {
  const pages = new Set<number>();
  const add = (address: number, bytes: number) => {
    for (let page = Math.floor(address / 4096) * 4096; page < address + bytes; page += 4096) pages.add(page);
  };
  const entries = (at: number) => {
    const count = readU32(source, at + 16),
      items = readU32(source, at + 4);
    if (!count) return [];
    add(items, count * 4);
    return Array.from({ length: count }, (_, index) => readU32(source, items + index * 4));
  };
  for (const range of YR_NATIVE_RANGES) add(range.address, range.length);
  for (const rule of YR_NATIVE_FOLLOW_RULES) {
    add(rule.source, rule.kind === 1 ? 4 : 20);
    if (rule.kind === 1) {
      const pointer = readU32(source, rule.source);
      if (pointer) add(pointer, rule.bytes);
      continue;
    }
    if (rule.kind === 3) {
      const count = readU32(source, rule.source + 16);
      if (count) add(readU32(source, rule.source + 4), (count - 1) * rule.stride + rule.bytes);
      continue;
    }
    for (const parent of entries(rule.source)) {
      if (rule.kind === 2) {
        add(parent, rule.bytes);
        continue;
      }
      let member = parent + (rule.kind >= 7 ? rule.stride & 0xffff : rule.stride);
      if (rule.kind >= 7) {
        add(member, 4);
        const target = readU32(source, member);
        if (!target) continue;
        member = target + (rule.stride >>> 16);
      }
      add(member, rule.kind === 4 || rule.kind === 7 ? 20 : rule.kind === 6 ? 12 : 4);
      if (rule.kind === 5 || rule.kind === 8) {
        const child = readU32(source, member);
        if (child) add(child, rule.bytes);
      } else if (rule.kind === 6) {
        const count = readU32(source, member + 8);
        if (count) add(readU32(source, member + 4), count * rule.bytes);
      } else for (const child of entries(member)) add(child, rule.bytes);
    }
  }
  return pages;
}

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
  it('prepopulates effect types and follows current nested production allocations at each native frame', () => {
    for (const source of Object.values(YR_NATIVE_EFFECT_TYPE_ARRAYS))
      expect(YR_NATIVE_FOLLOW_RULES.some((rule) => rule.kind === 2 && rule.source === source)).toBe(true);
    expect(YR_NATIVE_FOLLOW_RULES).toContainEqual({
      kind: 4,
      source: 0xa80208,
      stride: 0xbc,
      bytes: 0xa8,
      maxCount: 2048,
    });
    for (const offset of [0x53ac, 0x53b0, 0x53b4, 0x53b8, 0x53bc]) {
      expect(YR_NATIVE_FOLLOW_RULES).toContainEqual({
        kind: 5,
        source: G.houses,
        stride: offset,
        bytes: 0x74,
        maxCount: L.houses,
      });
      expect(YR_NATIVE_FOLLOW_RULES).toContainEqual({
        kind: 7,
        source: G.houses,
        stride: offset + 0x40 * 0x10000,
        bytes: 0x64,
        maxCount: 4096,
      });
      expect(YR_NATIVE_FOLLOW_RULES).toContainEqual({
        kind: 8,
        source: G.houses,
        stride: offset + 0x58 * 0x10000,
        bytes: 0x800,
        maxCount: L.houses,
      });
    }
    for (const offset of [0x5500, 0x5514, 0x5528, 0x553c, 0x55a0, 0x55b4, 0x55c8, 0x55dc])
      expect(YR_NATIVE_FOLLOW_RULES).toContainEqual({
        kind: 6,
        source: G.houses,
        stride: offset,
        bytes: 4,
        maxCount: 4096,
      });
  });
  it('reads newly created effects and relocated particle storage from policy-selected sparse pages', () => {
    const source = createGuestMemory(),
      mirror = new NativeMirrorMemory();
    const system = 0xc00f80,
      type = 0xd00f00;
    const vector = (at: number, items: number, pointers: number[]) => {
      writeU32(source, at + 4, items);
      writeU32(source, at + 16, pointers.length);
      pointers.forEach((pointer, index) => writeU32(source, items + index * 4, pointer));
    };
    vector(YR_NATIVE_EFFECT_TYPE_ARRAYS.particleSystem, 0xc10000, [type]);
    writeU32(source, type, V.particleSystemType);
    writeAsciiZ(source, type + O.typeId, 'SMOKESYS');
    writeU32(source, system, V.particleSystem);
    writeU32(source, system + O.uniqueId, 71);
    writeU32(source, system + O.particleSystemType, type);
    writeU32(source, system + O.location, 1000);
    writeU32(source, system + O.location + 4, 2000);
    writeU32(source, system + O.particleSystemTargetCoords, 1000);
    writeU32(source, system + O.particleSystemTargetCoords + 4, 2000);

    // Select only current graph pages, independently of the reader's addresses or miss discovery.
    const capture = (frame: number) => {
      const pages = policyPages(source);
      writeU32(source, E.frame, frame);
      mirror.apply({
        frame,
        flags: 2,
        pages: [...pages].map((address) => ({ address, bytes: source.read_memory(address, 4096) })),
      });
      mirror.beginOperation();
      return readYrEffects(mirror.accessor(), { particles: true });
    };
    expect(capture(1).particleSystems).toEqual([]); // type is present before its first instance
    vector(E.particleSystems, 0xc20000, [system]);
    const particle = (address: number, x: number) => {
      writeU32(source, address, V.particle);
      writeU32(source, address + O.location, x);
      writeU32(source, address + O.location + 4, 2000);
    };
    particle(0xe10000, 1000);
    vector(system + O.particleSystemParticles, 0xe00000, [0xe10000]);
    expect(capture(2).particleSystems[0]).toMatchObject({
      uid: 71,
      type: 'SMOKESYS',
      particles: [{ x: 1000, y: 2000, z: 0 }],
    });
    particle(0xe30000, 1200);
    vector(system + O.particleSystemParticles, 0xe20000, [0xe30000]);
    expect(capture(3).particleSystems[0]).toMatchObject({ particles: [{ x: 1200, y: 2000, z: 0 }] });
    expect(mirror.misses).toBe(0);
    expect(() => mirror.read_memory(0xe10000, 4)).toThrow('missing'); // retired allocation was not fixed-subscribed
  });

  it('follows reallocated radio contacts and owned-building lists in their first frame', () => {
    const source = createGuestMemory(),
      mirror = new NativeMirrorMemory();
    const unit = 0xc00000,
      building = 0xc10000,
      unitType = 0xd00000,
      buildingType = 0xd10000,
      house = 0xc80000;
    for (const address of Object.values(YR_STATE_VTABLES)) writeU32(source, address, 0x401000);
    const vector = (at: number, items: number, pointers: number[]) => {
      writeU32(source, at + 4, items);
      writeU32(source, at + 16, pointers.length);
      pointers.forEach((pointer, index) => writeU32(source, items + index * 4, pointer));
    };
    vector(G.technos, 0xe00000, [unit, building]);
    vector(G.units, 0xe01000, [unit]);
    vector(G.buildings, 0xe02000, [building]);
    vector(G.houses, 0xe03000, [house]);
    vector(0xa83ce0, 0xe04000, [unitType]);
    vector(0xa83c68, 0xe05000, [buildingType]);
    // Native layers only supply pointer ordering. An anim at the end of committed memory must not cause a body read.
    vector(G.renderLayers + 3 * 0x18, 0xe06000, [0xfffff0]);
    writeU32(source, unit, YR_STATE_VTABLES.unit);
    writeU32(source, unit + S.uniqueId, 11);
    writeU32(source, unit + S.unitType, unitType);
    writeU32(source, building, YR_STATE_VTABLES.building);
    writeU32(source, building + S.uniqueId, 12);
    writeU32(source, building + S.buildingType, buildingType);
    writeU32(source, unitType, YR_STATE_VTABLES.unitType);
    writeU32(source, buildingType, YR_STATE_VTABLES.buildingType);
    writeAsciiZ(source, unitType + S.typeId, 'MTNK');
    writeAsciiZ(source, buildingType + S.typeId, 'GACNST');
    let accessor = createByteViewAccessor(source.bytes);
    const read = createYrStateReader(() => accessor, YR_STARTUP_PAGE_HASH)!;
    const capture = (frame: number, radioItems: number, buildingItems: number, locomotor: number) => {
      writeU32(source, G.frame, frame);
      writeU32(source, unit + S.radioItems, radioItems);
      writeU32(source, unit + S.radioCapacity, 1);
      writeU32(source, radioItems, building);
      vector(house + 0x68, buildingItems, [building]);
      writeU32(source, unit + YR_GATHER_OFFSETS.locomotor, locomotor);
      writeU32(source, locomotor, YR_GATHER_LOCOMOTORS.drive);
      writeU32(source, locomotor + YR_GATHER_OFFSETS.locomotorLinkedTo, unit);
      const pages = policyPages(source);
      expect(pages.has(0xfff000)).toBe(false);
      expect(pages.has(0x1000000)).toBe(false);
      mirror.apply({
        frame,
        flags: 2,
        pages: [...pages].map((address) => ({ address, bytes: source.read_memory(address, 4096) })),
      });
      mirror.beginOperation();
      accessor = mirror.accessor();
      expect(read()!.objects.find((object) => object.id === unit)).toMatchObject({ uid: 11, contactUid: 12 });
      expect(accessor.u32(buildingItems)).toBe(building);
      expect(readYrUnitMovingNow(accessor, unit, unitType, frame)).toBe(false);
      expect(mirror.operationMissed).toBe(false);
    };
    capture(1, 0xe10000, 0xe20000, 0xe50fd0); // Drive coordinates extend beyond the former +0x30 span.
    capture(2, 0xe30000, 0xe40000, 0xe60fd0);
    expect(mirror.misses).toBe(0);
    expect(() => mirror.read_memory(0xe10000, 4)).toThrow('missing');
    expect(() => mirror.read_memory(0xe20000, 4)).toThrow('missing');
    expect(() => mirror.read_memory(0xe51000, 4)).toThrow('missing');
  });

  it('captures only the pointer lists of all five native render layers', () => {
    for (let layer = 0; layer < 5; layer++)
      expect(YR_NATIVE_FOLLOW_RULES.find((rule) => rule.source === G.renderLayers + layer * 0x18)).toEqual({
        kind: 3,
        source: G.renderLayers + layer * 0x18,
        bytes: 4,
        maxCount: L.objectsPerLayer,
        stride: 4,
      });
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
