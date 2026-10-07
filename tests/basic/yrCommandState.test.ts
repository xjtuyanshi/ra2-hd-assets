import { describe, expect, it } from 'vitest';
import { createByteViewAccessor } from '../../src/games/shared/memoryAccessor';
import {
  createYrCommandStateReaderFrom,
  readYrCommandState,
  YR_CELL_VTABLE,
  YR_COMMAND_OFFSETS as C,
  YR_COMMAND_SIGNATURES,
  YR_RADAR_EVENTS,
  yrCommandSignaturesMatch,
} from '../../src/games/yr/commandState';
import { YR_STARTUP_PAGE_HASH } from '../../src/games/yr/startupPage';
import { YR_STATE_GLOBALS as G, YR_STATE_OFFSETS as O, YR_STATE_VTABLES as V } from '../../src/games/yr/stateReader';

/** A synthetic guest image: two houses, a selected grouped tank moving to a cell, a tank attacking a building. */
function image() {
  const bytes = new Uint8Array(0x1000000);
  const data = new DataView(bytes.buffer);
  let next = 0xc00000;
  const alloc = (size: number) => {
    const pointer = next;
    next += (size + 15) & ~15;
    return pointer;
  };
  const u32 = (address: number, value: number) => data.setUint32(address, value >>> 0, true);
  const ascii = (address: number, text: string) =>
    [...text].forEach((char, i) => (bytes[address + i] = char.charCodeAt(0)));
  const vector = (address: number, items: number[]) => {
    const list = alloc(Math.max(4, items.length * 4));
    items.forEach((item, i) => u32(list + i * 4, item));
    u32(address + 4, list);
    u32(address + 0x10, items.length);
  };
  for (const { address, bytes: signature } of YR_COMMAND_SIGNATURES) bytes.set(signature, address);
  for (const vtable of [...Object.values(V), YR_CELL_VTABLE]) u32(vtable, 0x401000);
  const house = (index: number) => {
    const pointer = alloc(0x200);
    u32(pointer + O.houseArrayIndex, index);
    return pointer;
  };
  const houses = [house(0), house(1)];
  vector(G.houses, houses);
  u32(G.localHouse, houses[0]!);
  u32(G.scenario, alloc(0x40));
  u32(G.frame, 1234);
  const tactical = alloc(0x100);
  u32(G.tactical, tactical);
  data.setInt32(tactical + O.tacticalPos, -2940, true);
  data.setInt32(tactical + O.tacticalPos + 4, 1650, true);
  const type = (vtable: number, id: string, strength: number) => {
    const pointer = alloc(0x1800);
    u32(pointer, vtable);
    ascii(pointer + O.typeId, id);
    u32(pointer + O.typeStrength, strength);
    return pointer;
  };
  const cell = (x: number, y: number) => {
    const pointer = alloc(0x40);
    u32(pointer, YR_CELL_VTABLE);
    data.setInt16(pointer + C.cellCoords, x, true);
    data.setInt16(pointer + C.cellCoords + 2, y, true);
    return pointer;
  };
  const object = (
    vtable: number,
    typeOffset: number,
    typePointer: number,
    uid: number,
    owner: number,
    x: number,
    y: number,
  ) => {
    const pointer = alloc(0x700);
    u32(pointer, vtable);
    u32(pointer + O.uniqueId, uid);
    u32(pointer + typeOffset, typePointer);
    u32(pointer + O.owner, houses[owner]!);
    data.setInt32(pointer + O.location, x, true);
    data.setInt32(pointer + O.location + 4, y, true);
    data.setInt32(pointer + C.queuedMission, -1, true);
    data.setInt32(pointer + C.group, -1, true);
    u32(pointer + C.mission, 5);
    return pointer;
  };
  const rhino = type(V.unitType, 'HTNK', 400);
  const plantType = type(V.buildingType, 'NAPOWR', 750);
  const plant = object(V.building, O.buildingType, plantType, 30, 1, 25 * 256, 95 * 256);
  u32(plant + O.health, 375);
  const mover = object(V.unit, O.unitType, rhino, 10, 0, 28 * 256, 110 * 256);
  bytes[mover + O.isSelected] = 1;
  u32(mover + O.health, 400);
  u32(mover + C.mission, 2);
  u32(mover + C.group, 0);
  u32(mover + C.destination, cell(40, 101));
  const attacker = object(V.unit, O.unitType, rhino, 11, 0, 29 * 256, 110 * 256);
  u32(attacker + O.health, 100);
  u32(attacker + C.mission, 1);
  u32(attacker + C.target, plant);
  u32(attacker + C.queuedMission, 11);
  u32(attacker + C.focus, mover);
  u32(mover + C.passengers, 2);
  data.setUint16(mover + O.primaryFacing, 0x4000, true);
  const hidden = object(V.unit, O.unitType, rhino, 12, 0, 0, 0);
  bytes[hidden + O.inLimbo] = 1;
  vector(G.technos, [plant, mover, attacker, hidden, 0x123]);
  data.setInt32(YR_RADAR_EVENTS.newest, 2, true);
  data.setInt16(YR_RADAR_EVENTS.cells + 8, 57, true);
  data.setInt16(YR_RADAR_EVENTS.cells + 10, 75, true);
  return { bytes, data, mover };
}

describe('YR command state reader', () => {
  it('reads selection, groups, missions and what orders point at', () => {
    const { bytes } = image();
    const state = readYrCommandState(createByteViewAccessor(bytes))!;
    expect(state).toMatchObject({
      frame: 1234,
      localHouse: 0,
      view: { x: -2940, y: 1650 },
      lastEvent: { x: 57, y: 75 },
    });
    expect(state.objects.map((object) => object.uid)).toEqual([30, 10, 11]);
    const [plant, mover, attacker] = state.objects;
    expect(plant).toMatchObject({ kind: 'building', type: 'NAPOWR', owner: 1, health: 0.5, destination: null });
    expect(mover).toMatchObject({
      kind: 'vehicle',
      type: 'HTNK',
      selected: true,
      group: 0,
      mission: 'Move',
      queuedMission: null,
      destination: { kind: 'cell', x: 40, y: 101 },
      target: null,
      // A quarter turn clockwise from north, and two units inside.
      facing: 64,
      passengers: 2,
    });
    expect(attacker).toMatchObject({
      selected: false,
      group: -1,
      health: 0.25,
      mission: 'Attack',
      queuedMission: 'Area_Guard',
      target: { kind: 'object', uid: 30 },
      focus: { kind: 'object', uid: 10 },
    });
  });

  it('ignores pointers that are not cells or objects and reports no event without one', () => {
    const { bytes, data, mover } = image();
    data.setUint32(mover + C.destination, 0x10, true);
    data.setInt32(YR_RADAR_EVENTS.newest, -1, true);
    const state = readYrCommandState(createByteViewAccessor(bytes))!;
    expect(state.objects[1]!.destination).toBeNull();
    expect(state.lastEvent).toBeNull();
  });

  it('only reads the pinned build whose instructions match', () => {
    const { bytes, data } = image();
    const accessor = () => createByteViewAccessor(bytes);
    expect(createYrCommandStateReaderFrom(accessor, 'other')).toBeNull();
    const reader = createYrCommandStateReaderFrom(accessor, YR_STARTUP_PAGE_HASH)!;
    expect(reader()?.objects.length).toBe(3);
    // No scenario: no battle.
    data.setUint32(G.scenario, 0, true);
    expect(reader()).toBeNull();
    bytes[YR_COMMAND_SIGNATURES[2]!.address] ^= 0xff;
    expect(yrCommandSignaturesMatch(accessor())).toBe(false);
    expect(createYrCommandStateReaderFrom(accessor, YR_STARTUP_PAGE_HASH)).toBeNull();
  });
});
