import { describe, expect, it } from 'vitest';
import {
  createByteViewAccessor,
  createGuestMemoryAccessor,
  type GuestMemoryAccessor,
} from '../../src/games/shared/memoryAccessor';
import {
  YR_STATE_GLOBALS as G,
  YR_STATE_LIMITS,
  YR_STATE_OFFSETS as O,
  YR_STATE_VTABLES as V,
  createYrStateReader,
  facingToByte,
  facingToWorldVector,
  readAsciiZ,
  readFacingRaw,
  readPointerVector,
  readUtf16Z,
  readYrState,
  readYrWaypoint,
  worldVectorToFacing,
} from '../../src/games/yr/stateReader';
import { YR_STARTUP_PAGE_HASH } from '../../src/games/yr/startupPage';
import { YR_BUILDING_RENDER_OFFSETS as B } from '../../src/games/yr/buildingRenderState';
import { YR_INFANTRY_RENDER_OFFSETS as I } from '../../src/games/yr/infantryRenderState';

/** Synthetic 16 MiB guest memory: enough for every YR 1.001 global and a small heap above 0xb00000. */
function syntheticMemory() {
  const bytes = new Uint8Array(0x100_0000);
  const view = new DataView(bytes.buffer);
  let heap = 0xb0_0000;
  const alloc = (size: number) => {
    const at = heap;
    heap += (size + 15) & ~15;
    return at;
  };
  const u8 = (address: number, value: number) => view.setUint8(address, value);
  const u16 = (address: number, value: number) => view.setUint16(address, value, true);
  const u32 = (address: number, value: number) => view.setUint32(address, value >>> 0, true);
  const i32 = (address: number, value: number) => view.setInt32(address, value, true);
  const ascii = (address: number, text: string) => {
    for (let i = 0; i < text.length; i++) u8(address + i, text.charCodeAt(i));
    u8(address + text.length, 0);
  };
  const utf16 = (address: number, text: string) => {
    for (let i = 0; i < text.length; i++) u16(address + i * 2, text.charCodeAt(i));
    u16(address + text.length * 2, 0);
  };
  const vector = (base: number, pointers: number[]) => {
    const items = alloc(Math.max(4, pointers.length * 4));
    pointers.forEach((pointer, i) => u32(items + i * 4, pointer));
    u32(base + 4, items);
    u32(base + 0x10, pointers.length);
  };
  const type = (vtable: number, id: string, strength: number, turret = false) => {
    const at = alloc(vtable === V.buildingType ? 0x1800 : 0x1700);
    u32(at, vtable);
    ascii(at + O.typeId, id);
    i32(at + O.typeStrength, strength);
    u8(at + O.typeTurret, turret ? 1 : 0);
    return at;
  };
  const house = (index: number, country: string, human: boolean) => {
    const at = alloc(0x16100);
    const houseType = alloc(0x100);
    ascii(houseType + O.typeId, country);
    i32(at + O.houseArrayIndex, index);
    u32(at + O.houseType, houseType);
    u8(at + O.houseHuman, human ? 1 : 0);
    // PlainName holds the internal placeholder; UIName (UTF-16) holds what the game displays.
    ascii(at + O.housePlainName, human ? '<human player>' : 'Computer');
    utf16(at + O.houseUIName, human ? 'Commander Ünal' : 'Easy AI');
    i32(at + O.houseColorScheme, 3 + index);
    i32(at + O.houseStartingPoint, index);
    return at;
  };
  /** FacingClass at `at`: desired/start DirStruct, rotation timer, ROT. */
  const facing = (at: number, desired: number, start = desired, timerStart = -1, timeLeft = 0, rot = 0) => {
    u16(at, desired);
    u16(at + 4, start);
    i32(at + 8, timerStart);
    i32(at + 0x10, timeLeft);
    u16(at + 0x14, rot);
  };
  const object = (
    vtable: number,
    typeOffset: number,
    typePointer: number,
    owner: number,
    fields: { x: number; y: number; z?: number; health: number; uid: number; facing?: number; limbo?: boolean },
  ) => {
    const at = alloc(0x700);
    u32(at, vtable);
    u32(at + O.uniqueId, fields.uid);
    i32(at + O.health, fields.health);
    u8(at + O.inLimbo, fields.limbo ? 1 : 0);
    i32(at + O.location, fields.x);
    i32(at + O.location + 4, fields.y);
    i32(at + O.location + 8, fields.z ?? 0);
    u32(at + O.owner, owner);
    u32(at + typeOffset, typePointer);
    facing(at + O.primaryFacing, fields.facing ?? 0);
    if (vtable === V.building) {
      i32(at + B.state, 1);
      i32(at + B.queuedState, -1);
    }
    return at;
  };
  return { bytes, view, alloc, u8, u16, u32, i32, ascii, utf16, vector, type, house, facing, object };
}

/** A small but complete battlefield: two houses, a tank, a soldier, a construction yard, a limbo unit and junk. */
function battlefield() {
  const m = syntheticMemory();
  assertGlobalsFit(m);
  m.i32(G.frame, 1000);
  const player = m.house(0, 'Americans', true);
  const ai = m.house(1, 'Russians', false);
  m.vector(G.houses, [player, ai]);
  m.u32(G.localHouse, player);

  const scenario = m.alloc(0x3700);
  m.u32(G.scenario, scenario);
  m.i32(scenario + O.scenarioTheater, 2);
  m.ascii(scenario + O.scenarioFileName, 'XMP29U2.MAP');
  // Waypoint 0 at cell (52, 97): CellStruct {short X, short Y}.
  m.u16(scenario + O.scenarioWaypoints, 52);
  m.u16(scenario + O.scenarioWaypoints + 2, 97);
  for (const [offset, value] of [
    [0, 0],
    [4, 0],
    [8, 60],
    [12, 60],
  ])
    m.i32(G.map + O.mapRect + offset!, value!);
  for (const [offset, value] of [
    [0, 2],
    [4, 4],
    [8, 56],
    [12, 50],
  ])
    m.i32(G.map + O.mapVisibleRect + offset!, value!);
  const tactical = m.alloc(0x100);
  m.u32(G.tactical, tactical);
  m.i32(tactical + O.tacticalPos, 1234);
  m.i32(tactical + O.tacticalPos + 4, -56);

  const mtnk = m.type(V.unitType, 'MTNK', 400, true);
  const amcv = m.type(V.unitType, 'AMCV', 1000);
  const e1 = m.type(V.infantryType, 'E1', 125);
  const gacnst = m.type(V.buildingType, 'GACNST', 1000);
  const tank = m.object(V.unit, O.unitType, mtnk, player, {
    x: 52 * 256 + 128,
    y: 97 * 256 + 128,
    health: 300,
    uid: 11,
    facing: 0x4000,
  });
  m.facing(tank + O.secondaryFacing, 0xc000);
  m.u8(tank + O.isSelected, 1);
  const limboMcv = m.object(V.unit, O.unitType, amcv, player, { x: 0, y: 0, health: 1000, uid: 12, limbo: true });
  const badVtable = m.object(0x12345678, O.unitType, mtnk, player, { x: 256, y: 256, health: 1, uid: 13 });
  const soldier = m.object(V.infantry, O.infantryType, e1, ai, { x: 1000, y: 2000, z: 104, health: 200, uid: 14 });
  m.i32(soldier + I.sequence, 2);
  m.i32(soldier + I.sequenceFrame, 3);
  const yard = m.object(V.building, O.buildingType, gacnst, ai, { x: 5000, y: 6000, health: 500, uid: 15 });
  m.vector(G.units, [tank, limboMcv, badVtable, 0]);
  m.vector(G.infantry, [soldier]);
  m.vector(G.buildings, [yard]);
  m.vector(G.aircraft, []);
  m.vector(G.technos, [tank, limboMcv, badVtable, 0, soldier, yard]);
  return { m, player, ai, tank, limboMcv, soldier, yard, scenario };
}
/** The synthetic layout must fit: every global lies inside the 16 MiB buffer. */
function assertGlobalsFit(m: ReturnType<typeof syntheticMemory>) {
  for (const address of Object.values(G)) expect(address + 0x200).toBeLessThan(m.bytes.length);
}

describe('guest memory accessors', () => {
  it('read little-endian values and never throw outside guest memory', () => {
    const bytes = new Uint8Array(16);
    bytes.set([0x78, 0x56, 0x34, 0x12, 0xff, 0xff, 0xff, 0xff]);
    for (const memory of [
      createByteViewAccessor(bytes),
      createGuestMemoryAccessor({ read_memory: (o, l) => bytes.subarray(o, o + l), write_memory() {} }, 16),
    ]) {
      expect(memory.u32(0)).toBe(0x12345678);
      expect(memory.u16(2)).toBe(0x1234);
      expect(memory.i32(4)).toBe(-1);
      expect(memory.u32(4)).toBe(0xffffffff);
      expect(memory.u32(13)).toBe(0);
      expect(memory.u8(-1)).toBe(0);
      expect(memory.u32(0.5)).toBe(0);
      expect([...memory.bytes(14, 8)]).toEqual([0, 0]);
      expect(memory.bytes(99, 4).length).toBe(0);
    }
    const throwing = createGuestMemoryAccessor(
      {
        read_memory() {
          throw new Error('boom');
        },
        write_memory() {},
      },
      64,
    );
    expect(throwing.u32(0)).toBe(0);
  });
});

describe('YR 1.001 state reader', () => {
  it('carries a validated JumpJet target facing without replacing primary facing', () => {
    const { m, soldier, tank } = battlefield();
    const data = new DataView(m.bytes.buffer);
    const type = data.getUint32(soldier + O.infantryType, true);
    const base = m.alloc(0xa0);
    m.u8(type + I.jumpJet, 1);
    m.u32(soldier + I.locomotor, base + 4);
    m.u32(base, 0x7ece34);
    m.u32(base + 4, 0x7ecd68);
    m.u32(0x7ece40, 0x54b710);
    m.u32(soldier + I.target, tank);
    m.u32(V.infantry + 0x48, 0x5f65a0);
    m.u32(V.unit + 0x48, 0x5f65a0);
    m.i32(tank + O.location, 1256);
    m.i32(tank + O.location + 4, 2000);
    data.setFloat32(0x8650b8, 0.024413354694843292, true);
    const read = () => readYrState(createByteViewAccessor(m.bytes)).objects.find((o) => o.id === soldier);
    expect(read()).toMatchObject({ infantryDrawFacingRaw: 0x3fff, facingRaw: 0, infantrySequence: 'Prone' });
    m.u8(type + I.jumpJetTurn, 1);
    expect(read()).not.toHaveProperty('infantryDrawFacingRaw');
  });

  it('adds H2 make state and leaves failed optional reads off otherwise valid objects', () => {
    const { m, yard, soldier } = battlefield();
    const type = new DataView(m.bytes.buffer).getUint32(yard + O.buildingType, true);
    m.i32(yard + B.state, 0);
    m.u8(yard + B.hasBuildup, 1);
    m.i32(yard + B.currentMission, 19);
    m.i32(yard + B.queuedMission, -1);
    m.i32(yard + B.stage, 4);
    m.i32(type + B.makeCount, 20);
    const read = () => readYrState(createByteViewAccessor(m.bytes));
    expect(read().objects.find((object) => object.id === yard)).toMatchObject({
      buildState: 'selling',
      buildupFrame: 15,
    });
    m.i32(yard + B.state, 6);
    m.i32(soldier + I.sequence, -1);
    const invalid = read();
    expect(invalid.objects.find((object) => object.id === yard)).not.toHaveProperty('buildState');
    expect(invalid.objects.find((object) => object.id === soldier)).not.toHaveProperty('infantrySequence');
    expect(invalid.objects).toHaveLength(3);
  });

  it.each([
    ['HARV', 'HORV'],
    ['CMIN', 'CMON'],
  ])('selects %s unloading art %s only while docked, without changing the rules type', (id, imageId) => {
    const m = syntheticMemory();
    const type = m.type(V.unitType, id, 1000);
    const unloadingType = m.type(V.unitType, imageId, 500);
    const unit = m.object(V.unit, O.unitType, type, 0, { x: 256, y: 512, health: 750, uid: 1 });
    m.vector(G.units, [unit]);
    m.u8(type + O.unitTypeHarvester, 1);
    m.u32(type + O.technoTypeUnloadingClass, unloadingType);
    m.u8(unit + O.unitUnloading, 1);
    const read = () => readYrState(createByteViewAccessor(m.bytes)).objects[0];
    expect(read()).toMatchObject({ type: id, imageType: imageId, health: 0.75 });
    m.u8(unit + O.unitUnloading, 0);
    expect(read()).toMatchObject({ type: id, health: 0.75 });
    expect(read()).not.toHaveProperty('imageType');
    // A poll during the draw's temporary Type substitution still draws the unloading image.
    m.u8(unit + O.unitUnloading, 1);
    m.u32(unit + O.unitType, unloadingType);
    m.u8(unloadingType + O.unitTypeHarvester, 1);
    expect(read()).toMatchObject({ type: imageId });
    expect(read()).not.toHaveProperty('imageType');
  });

  it('ignores a non-harvester UnloadingClass, including the separate SCHP deployment path', () => {
    const m = syntheticMemory();
    const type = m.type(V.unitType, 'SCHP', 1000);
    const unloadingType = m.type(V.unitType, 'SCHD', 1000);
    const unit = m.object(V.unit, O.unitType, type, 0, { x: 256, y: 512, health: 750, uid: 1 });
    m.vector(G.units, [unit]);
    m.u32(type + O.technoTypeUnloadingClass, unloadingType);
    m.u8(unit + O.unitUnloading, 1);
    m.u8(unit + 0x6e0, 1);
    const read = readYrState(createByteViewAccessor(m.bytes));
    expect(read.objects[0]).toMatchObject({ type: 'SCHP' });
    expect(read.objects[0]).not.toHaveProperty('imageType');
  });

  it.each(['null', 'out-of-bounds', 'wrong-vtable', 'cached-building-type', 'missing-id'])(
    'ignores an %s UnloadingClass while keeping the HARV object',
    (invalid) => {
      const m = syntheticMemory();
      const type = m.type(V.unitType, 'HARV', 1000);
      let unloadingType = m.type(V.unitType, 'HORV', 500);
      const unit = m.object(V.unit, O.unitType, type, 0, { x: 256, y: 512, health: 750, uid: 1 });
      m.vector(G.units, [unit]);
      m.u8(type + O.unitTypeHarvester, 1);
      m.u8(unit + O.unitUnloading, 1);
      if (invalid === 'null') unloadingType = 0;
      else if (invalid === 'out-of-bounds') unloadingType = m.bytes.length - 4;
      else if (invalid === 'wrong-vtable') m.u32(unloadingType, V.infantryType);
      else if (invalid === 'missing-id') m.ascii(unloadingType + O.typeId, '');
      else {
        unloadingType = m.type(V.buildingType, 'GAREFN', 1000);
        const refinery = m.object(V.building, O.buildingType, unloadingType, 0, {
          x: 256,
          y: 512,
          health: 1000,
          uid: 2,
        });
        m.vector(G.buildings, [refinery]);
      }
      m.u32(type + O.technoTypeUnloadingClass, unloadingType);
      const read = readYrState(createByteViewAccessor(m.bytes));
      const miner = read.objects.find((object) => object.id === unit);
      expect(miner).toMatchObject({ type: 'HARV', health: 0.75 });
      expect(miner).not.toHaveProperty('imageType');
      expect(read.stats.invalid.vehicle).toBe(0);
    },
  );

  it('bounds-checks the larger harvester type span without rejecting a valid base type', () => {
    const m = syntheticMemory();
    const type = (m.bytes.length - O.unitTypeHarvester) & ~3;
    m.u32(type, V.unitType);
    m.ascii(type + O.typeId, 'HARV');
    m.i32(type + O.typeStrength, 1000);
    const unloadingType = m.type(V.unitType, 'HORV', 500);
    m.u32(type + O.technoTypeUnloadingClass, unloadingType);
    const unit = m.object(V.unit, O.unitType, type, 0, { x: 256, y: 512, health: 750, uid: 1 });
    m.vector(G.units, [unit]);
    m.u8(unit + O.unitUnloading, 1);
    const memory = createByteViewAccessor(m.bytes.subarray(0, type + O.unitTypeHarvester));
    const miner = readYrState(memory).objects[0];
    expect(miner).toMatchObject({ type: 'HARV', health: 0.75 });
    expect(miner).not.toHaveProperty('imageType');
  });

  it('reads map, houses and objects, skipping limbo and invalid entries', () => {
    const { m, tank, soldier, yard } = battlefield();
    const state = readYrState(createByteViewAccessor(m.bytes));
    expect(state.frame).toBe(1000);
    expect(state.map).toEqual({
      fileName: 'XMP29U2.MAP',
      theater: 'urban',
      width: 60,
      height: 60,
      size: { x: 0, y: 0, width: 60, height: 60 },
      localSize: { x: 2, y: 4, width: 56, height: 50 },
    });
    expect(state.houses).toEqual([
      {
        index: 0,
        country: 'Americans',
        name: 'Commander Ünal',
        plainName: '<human player>',
        colorIndex: 3,
        isHuman: true,
        isLocal: true,
        defeated: false,
        startingPoint: 0,
      },
      {
        index: 1,
        country: 'Russians',
        name: 'Easy AI',
        plainName: 'Computer',
        colorIndex: 4,
        isHuman: false,
        isLocal: false,
        defeated: false,
        startingPoint: 1,
      },
    ]);
    expect(state.localHouse).toBe(0);
    expect(state.view).toEqual({ x: 1234, y: -56 });
    expect(state.objects).toEqual([
      {
        id: yard,
        uid: 15,
        kind: 'building',
        type: 'GACNST',
        owner: 1,
        x: 5000,
        y: 6000,
        z: 0,
        facing: 0,
        facingRaw: 0,
        health: 0.5,
        isSelected: false,
        buildState: 'done',
      },
      {
        id: tank,
        uid: 11,
        kind: 'vehicle',
        type: 'MTNK',
        owner: 0,
        x: 52 * 256 + 128,
        y: 97 * 256 + 128,
        z: 0,
        facing: 64,
        facingRaw: 0x4000,
        turretFacing: 192,
        turretFacingRaw: 0xc000,
        health: 0.75,
        isSelected: true,
      },
      {
        id: soldier,
        uid: 14,
        kind: 'infantry',
        type: 'E1',
        owner: 1,
        x: 1000,
        y: 2000,
        z: 104,
        facing: 0,
        facingRaw: 0,
        health: 1,
        isSelected: false,
        infantrySequence: 'Prone',
        sequenceFrame: 3,
      },
    ]);
    // Unit vector: tank + limbo MCV + wrong vtable + null pointer.
    expect(state.stats).toEqual({
      vectors: { building: 1, vehicle: 4, infantry: 1, aircraft: 0 },
      limbo: { building: 0, vehicle: 1, infantry: 0, aircraft: 0 },
      invalid: { building: 0, vehicle: 2, infantry: 0, aircraft: 0 },
    });
    expect(readYrWaypoint(createByteViewAccessor(m.bytes), 0)).toEqual({ x: 52, y: 97 });
    expect(readYrWaypoint(createByteViewAccessor(m.bytes), 1)).toBeNull();
    expect(readYrWaypoint(createByteViewAccessor(m.bytes), 702)).toBeNull();
    const withLimbo = readYrState(createByteViewAccessor(m.bytes), { includeLimbo: true });
    expect(withLimbo.objects.map((o) => o.type)).toEqual(['GACNST', 'MTNK', 'AMCV', 'E1']);
    expect(withLimbo.stats.limbo.vehicle).toBe(0);
  });

  it('never writes guest memory', () => {
    const { m } = battlefield();
    const before = m.bytes.slice();
    readYrState(createByteViewAccessor(m.bytes), { includeLimbo: true });
    expect(Buffer.compare(m.bytes, before)).toBe(0);
  });

  it('reads registered painter layers and stable tie indices independently of kind, height and UID', () => {
    const { m, tank, soldier, yard, ai } = battlefield();
    m.i32(soldier + O.location, 13248);
    m.i32(soldier + O.location + 4, 20544);
    m.i32(tank + O.location, 13440);
    m.i32(tank + O.location + 4, 20352);
    m.i32(tank + O.location + 8, 1040);
    m.i32(yard + O.location, 13696);
    m.i32(yard + O.location + 4, 20864);
    const effect = m.alloc(0x100);
    const planeType = m.type(V.aircraftType, 'ORCA', 200);
    const plane = m.object(V.aircraft, O.aircraftType, planeType, ai, { x: 1, y: 2, z: 208, health: 200, uid: 1 });
    m.vector(G.aircraft, [plane]);
    m.vector(G.renderLayers + 2 * 0x18, [effect, soldier, tank, yard]);
    m.vector(G.renderLayers + 4 * 0x18, [plane]);
    const read = readYrState(createByteViewAccessor(m.bytes));
    const order = (id: number) => read.objects.find((object) => object.id === id)?.renderOrder;
    expect(order(soldier)).toEqual({ layer: 2, index: 1, ySort: 33792 });
    expect(order(tank)).toEqual({ layer: 2, index: 2, ySort: 33792 });
    expect(order(yard)).toEqual({ layer: 2, index: 3, ySort: 34304 });
    expect(order(plane)).toEqual({ layer: 4, index: 0, ySort: 3 });
    // A layer registration, including an air/ground transition, can change without changing the kind vector.
    m.vector(G.renderLayers + 4 * 0x18, []);
    m.vector(G.renderLayers + 2 * 0x18, [plane, effect, soldier, tank, yard]);
    expect(
      readYrState(createByteViewAccessor(m.bytes)).objects.find((object) => object.id === plane)?.renderOrder,
    ).toEqual({ layer: 2, index: 0, ySort: 3 });
  });

  it.each([
    [false, false, 10744],
    [true, false, 10776],
    [false, true, 10728],
    [true, true, 10760],
  ])('applies building voxel-turret=%s and gate=%s sort adjustments', (voxelTurret, gate, ySort) => {
    const { m, yard } = battlefield();
    const type = m.view.getUint32(yard + O.buildingType, true);
    m.u8(type + O.buildingTypeVoxelTurret, voxelTurret ? 1 : 0);
    m.u8(type + O.buildingTypeGate, gate ? 1 : 0);
    m.vector(G.renderLayers + 2 * 0x18, [yard]);
    expect(
      readYrState(createByteViewAccessor(m.bytes)).objects.find((object) => object.id === yard)?.renderOrder,
    ).toEqual({ layer: 2, index: 0, ySort });
  });

  it('omits uncertain painter metadata while retaining valid objects and other readable layers', () => {
    const { m, tank, soldier, yard } = battlefield();
    const layer = G.renderLayers + 2 * 0x18;
    const read = () => readYrState(createByteViewAccessor(m.bytes));
    expect(read().objects.every((object) => object.renderOrder === undefined)).toBe(true);
    m.vector(layer, [soldier, tank, yard]);
    m.vector(G.renderLayers + 4 * 0x18, [tank]);
    const duplicate = read();
    expect(duplicate.objects).toHaveLength(3);
    expect(duplicate.objects.find((object) => object.id === tank)).not.toHaveProperty('renderOrder');
    expect(duplicate.objects.find((object) => object.id === yard)?.renderOrder?.index).toBe(2);
    m.u32(layer + 0x10, YR_STATE_LIMITS.objectsPerLayer + 1);
    expect(read().objects.find((object) => object.id === yard)).not.toHaveProperty('renderOrder');
    expect(read().objects.find((object) => object.id === tank)?.renderOrder?.layer).toBe(4);
    m.u32(layer + 0x10, 1);
    m.u32(layer + 4, 0xfffffff0);
    expect(read().objects).toHaveLength(3);
    expect(read().objects.find((object) => object.id === soldier)).not.toHaveProperty('renderOrder');
  });

  it('returns an empty state outside a battle', () => {
    const state = readYrState(createByteViewAccessor(new Uint8Array(0x100_0000)));
    expect(state).toMatchObject({ frame: 0, map: null, houses: [], localHouse: -1, view: null, objects: [] });
  });

  it('rejects implausible vectors, owners, strings, coordinates and types', () => {
    const { m, tank, soldier, ai } = battlefield();
    const read = () => readYrState(createByteViewAccessor(m.bytes));
    // An unknown owner pointer resolves to -1 rather than a wrong house.
    m.u32(soldier + O.owner, 0xdead0);
    expect(read().objects.find((o) => o.id === soldier)?.owner).toBe(-1);
    // A house whose ArrayIndex disagrees with its slot is dropped (and so are its objects' owners).
    m.i32(ai + O.houseArrayIndex, 7);
    expect(read().houses.map((h) => h.index)).toEqual([0]);
    // Coordinates beyond any map: skipped as invalid.
    m.i32(tank + O.location, YR_STATE_LIMITS.maxCoordinate + 1);
    expect(read().objects.some((o) => o.id === tank)).toBe(false);
    m.i32(tank + O.location, 1000);
    // A type ID that is not printable ASCII (torn or freed type) is invalid.
    const type = m.view.getUint32(tank + O.unitType, true);
    m.u8(type + O.typeId, 0x07);
    expect(read().objects.some((o) => o.id === tank)).toBe(false);
    m.u8(type + O.typeId, 'M'.charCodeAt(0));
    // Count above the sanity limit: the whole vector is reported invalid, nothing is read from it.
    m.u32(G.units + 0x10, YR_STATE_LIMITS.objectsPerKind + 1);
    const state = read();
    expect(state.objects.some((o) => o.kind === 'vehicle')).toBe(false);
    expect(state.stats.invalid.vehicle).toBe(YR_STATE_LIMITS.objectsPerKind + 1);
    // Items pointer outside memory.
    m.u32(G.units + 0x10, 1);
    m.u32(G.units + 4, 0xffff_fff0);
    expect(read().stats.invalid.vehicle).toBe(1);
    // A dangling scenario pointer yields no map instead of garbage.
    m.u32(G.scenario, 0x7fff_0000);
    expect(read().map).toBeNull();
    // Duplicate pointers in a vector are reported once.
    m.vector(G.units, [tank, tank]);
    expect(read().objects.filter((o) => o.id === tank).length).toBe(1);
  });

  it('survives random memory without throwing or looping', () => {
    const m = syntheticMemory();
    let seed = 12345;
    const random = () => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0);
    for (let round = 0; round < 50; round++) {
      // Random headers pointing into a region of random bytes.
      for (let at = 0xb0_0000; at < 0xb4_0000; at += 4) m.u32(at, random());
      for (const base of [G.units, G.infantry, G.buildings, G.aircraft, G.houses]) {
        m.u32(base + 4, 0xb0_0000 + (random() % 0x3_0000) * 4);
        m.u32(base + 0x10, random() % 64);
      }
      m.u32(G.localHouse, random());
      m.u32(G.scenario, random() % 0x100_0000);
      m.u32(G.tactical, random());
      const state = readYrState(createByteViewAccessor(m.bytes), { includeLimbo: true });
      for (const o of state.objects) {
        expect(o.health).toBeGreaterThanOrEqual(0);
        expect(o.health).toBeLessThanOrEqual(1);
        expect(o.facing).toBeGreaterThanOrEqual(0);
        expect(o.facing).toBeLessThanOrEqual(255);
      }
    }
  });
});

describe('facings', () => {
  const memory = (): [GuestMemoryAccessor, ReturnType<typeof syntheticMemory>] => {
    const m = syntheticMemory();
    return [createByteViewAccessor(m.bytes), m];
  };

  it('reproduces FacingClass::Current() while the rotation timer runs', () => {
    const [accessor, m] = memory();
    const at = 0xb0_0000;
    // Rotating from 0 to 0x4000 at ROT 0x400 per frame: 16 steps, timer started at frame 100.
    m.facing(at, 0x4000, 0, 100, 16, 0x400);
    expect(readFacingRaw(accessor, at, 100)).toBe(0);
    expect(readFacingRaw(accessor, at, 104)).toBe(0x1000);
    expect(readFacingRaw(accessor, at, 116)).toBe(0x4000);
    expect(readFacingRaw(accessor, at, 999)).toBe(0x4000);
    // Counter-clockwise across north: from 0x1000 to 0xf000 (diff -0x2000).
    m.facing(at, 0xf000, 0x1000, 0, 8, 0x400);
    expect(readFacingRaw(accessor, at, 4)).toBe(0); // half way, passing north
    expect(readFacingRaw(accessor, at, 6)).toBe(0xf800);
    // Paused timer (StartTime -1) keeps its stored remaining time.
    m.facing(at, 0x4000, 0, -1, 8, 0x400);
    expect(readFacingRaw(accessor, at, 12345)).toBe(0x2000);
    // ... even a negative one: the game only tests it for non-zero (0x4000 - (0x4000 / 16) * -2 = 0x4800).
    m.facing(at, 0x4000, 0, -1, -2, 0x400);
    expect(readFacingRaw(accessor, at, 12345)).toBe(0x4800);
    // Divide first, then multiply, like 0x4C93D0: diff 101, ROT 32 -> steps 3, 2 left: 101 - trunc(101 / 3) * 2 = 35.
    m.facing(at, 101, 0, 10, 2, 32);
    expect(readFacingRaw(accessor, at, 10)).toBe(101 - 66);
    // Negative diff truncates toward zero too: -101 / 3 -> -33, * 2 -> -66.
    m.facing(at, 0xffff - 100, 0, 10, 2, 32);
    expect(readFacingRaw(accessor, at, 10)).toBe((0xffff - 100 + 66) & 0xffff);
    // No rotation rate: the desired facing is current.
    m.facing(at, 0x1234, 0, 0, 100, 0);
    expect(readFacingRaw(accessor, at, 1)).toBe(0x1234);
  });

  it('converts 16-bit directions with the engine rounding and orientation', () => {
    expect(facingToByte(0)).toBe(0);
    expect(facingToByte(0x4000)).toBe(64);
    expect(facingToByte(0x8000)).toBe(128);
    expect(facingToByte(0xc000)).toBe(192);
    expect(facingToByte(0x7f)).toBe(0);
    expect(facingToByte(0x80)).toBe(1);
    expect(facingToByte(0xff80)).toBe(0); // wraps to north
    // 0 = north (-Y), 64 = east (+X), 128 = south (+Y), 192 = west (-X).
    expect(worldVectorToFacing(0, -1)).toBeCloseTo(0);
    expect(worldVectorToFacing(1, 0)).toBeCloseTo(64);
    expect(worldVectorToFacing(0, 1)).toBeCloseTo(128);
    expect(worldVectorToFacing(-1, 0)).toBeCloseTo(192);
    for (let f = 0; f < 256; f += 16) {
      const { dx, dy } = facingToWorldVector(f);
      expect(worldVectorToFacing(dx, dy)).toBeCloseTo(f);
    }
  });
});

describe('helpers and factory', () => {
  it('reads bounded ASCII strings and pointer vectors defensively', () => {
    const m = syntheticMemory();
    const accessor = createByteViewAccessor(m.bytes);
    m.ascii(0xb0_0000, 'GACNST');
    expect(readAsciiZ(accessor, 0xb0_0000, 0x18)).toBe('GACNST');
    expect(readAsciiZ(accessor, 0xb0_0000, 3)).toBeNull(); // no terminator within the limit
    expect(readAsciiZ(accessor, 0xb1_0000, 8)).toBeNull(); // empty
    m.utf16(0xb2_0000, 'ra2hd-yu 尤里');
    expect(readUtf16Z(accessor, 0xb2_0000, 21)).toBe('ra2hd-yu 尤里');
    expect(readUtf16Z(accessor, 0xb2_0000, 4)).toBeNull(); // no terminator within the limit
    expect(readUtf16Z(accessor, 0xb3_0000, 21)).toBeNull(); // empty
    m.utf16(0xb4_0000, 'a\u0001b');
    expect(readUtf16Z(accessor, 0xb4_0000, 21)).toBeNull(); // control character
    m.utf16(0xb5_0000, 'a\ud800b');
    expect(readUtf16Z(accessor, 0xb5_0000, 21)).toBeNull(); // unpaired surrogate
    m.utf16(0xb6_0000, 'a\ud83d\ude80');
    expect(readUtf16Z(accessor, 0xb6_0000, 21)).toBe('a\ud83d\ude80');
    expect(readPointerVector(accessor, G.units, 10)).toEqual([]);
    m.vector(G.units, [1, 2, 3]);
    expect(readPointerVector(accessor, G.units, 10)).toEqual([1, 2, 3]);
    expect(readPointerVector(accessor, G.units, 2)).toBeNull();
    m.u32(G.units + 4, 0xb0_0002); // unaligned items pointer
    expect(readPointerVector(accessor, G.units, 10)).toBeNull();
  });

  it('only supports the pinned image with plausible vtables', () => {
    const { m } = battlefield();
    const accessor = () => createByteViewAccessor(m.bytes);
    expect(createYrStateReader(accessor, 'other')).toBeNull();
    expect(createYrStateReader(accessor, YR_STARTUP_PAGE_HASH)).toBeNull(); // vtables empty
    for (const vtable of Object.values(V)) m.u32(vtable, 0x6d_0000);
    const read = createYrStateReader(accessor, YR_STARTUP_PAGE_HASH);
    expect(read?.()?.objects.length).toBe(3);
  });
});
