import { describe, expect, it } from 'vitest';
import { createByteViewAccessor } from '../../src/games/shared/memoryAccessor';
import {
  YR_EFFECTS_GLOBALS as G,
  YR_EFFECTS_LIMITS,
  YR_EFFECTS_OFFSETS as O,
  YR_EFFECTS_VTABLES as V,
  YR_GET_COORDS,
  YR_GET_COORDS_SLOT,
  createYrEffectsReader,
  readYrEffects,
  readYrObjectCoords,
} from '../../src/games/yr/effectsReader';
import { YR_STATE_VTABLES as SV } from '../../src/games/yr/stateReader';
import { YR_STARTUP_PAGE_HASH } from '../../src/games/yr/startupPage';

/** Synthetic 16 MiB guest memory with the vtable slots the reader dispatches on and a small heap above 0xb00000. */
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
  const f32 = (address: number, value: number) => view.setFloat32(address, value, true);
  const f64 = (address: number, value: number) => view.setFloat64(address, value, true);
  const ascii = (address: number, text: string) => {
    for (let i = 0; i < text.length; i++) u8(address + i, text.charCodeAt(i));
    u8(address + text.length, 0);
  };
  const point = (address: number, p: { x: number; y: number; z: number }) => {
    i32(address, p.x);
    i32(address + 4, p.y);
    i32(address + 8, p.z);
  };
  const vector = (base: number, pointers: number[]) => {
    const items = alloc(Math.max(4, pointers.length * 4));
    pointers.forEach((pointer, i) => u32(items + i * 4, pointer));
    u32(base + 4, items);
    u32(base + 0x10, pointers.length);
  };
  /** The GetCoords slot of every vtable the tests use, plus a code pointer in slot 0 (what the factory checks). */
  const installVtables = () => {
    for (const vtable of [...Object.values(V), ...Object.values(SV)]) u32(vtable, 0x410260);
    for (const vtable of [SV.unit, SV.infantry, SV.aircraft, V.terrain, V.bullet, V.particleSystem, V.voxelAnim])
      u32(vtable + YR_GET_COORDS_SLOT, YR_GET_COORDS.object);
    u32(SV.building + YR_GET_COORDS_SLOT, YR_GET_COORDS.building);
    u32(V.anim + YR_GET_COORDS_SLOT, YR_GET_COORDS.anim);
    u32(V.cell + YR_GET_COORDS_SLOT, YR_GET_COORDS.cell);
  };
  const type = (vtable: number, id: string, size = 0x400) => {
    const at = alloc(size);
    u32(at, vtable);
    ascii(at + O.typeId, id);
    return at;
  };
  const object = (vtable: number, uid: number, location: { x: number; y: number; z: number }, size = 0x600) => {
    const at = alloc(size);
    u32(at, vtable);
    u32(at + O.uniqueId, uid);
    point(at + O.location, location);
    return at;
  };
  return { bytes, view, alloc, u8, u16, u32, i32, f32, f64, ascii, point, vector, installVtables, type, object };
}

/** A skirmish moment: explosions, attached fire/smoke, a shell in flight, a laser, a bolt, smoke, debris, a shot. */
function battle() {
  const m = syntheticMemory();
  for (const address of Object.values(G)) expect(address + 0x20).toBeLessThan(m.bytes.length);
  m.installVtables();
  m.i32(G.frame, 500);
  const house = (index: number) => {
    const at = m.alloc(0x100);
    m.i32(at + O.houseArrayIndex, index);
    return at;
  };
  const player = house(0);
  const ai = house(1);
  m.vector(G.houses, [player, ai]);

  // Anim types. End/LoopEnd as resolved by the first instance; Layer 2 = ground, 3 = air.
  const animType = (
    id: string,
    fields: { start?: number; end: number; loopStart?: number; loopEnd?: number; layer?: number },
  ) => {
    const at = m.type(V.animType, id);
    m.i32(at + O.animTypeStart, fields.start ?? 0);
    m.i32(at + O.animTypeLoopStart, fields.loopStart ?? 0);
    m.i32(at + O.animTypeLoopEnd, fields.loopEnd ?? fields.end);
    m.i32(at + O.animTypeEnd, fields.end);
    m.i32(at + O.animTypeLayer, fields.layer ?? 2);
    return at;
  };
  const explolrg = animType('EXPLOLRG', { end: 20, layer: 3 });
  const fire = animType('FIRE01', { start: 4, end: 30, loopStart: 4, loopEnd: 34 });
  m.u8(fire + O.animTypeTranslucent, 1);
  m.i32(fire + O.animTypeTranslucency, 50);
  const smoke = animType('SMOKEY', { end: 45 });
  m.u8(smoke + O.animTypeFlat, 1);

  // Owners: a 3x3 building (Foundation 6), a tank, and a building type with a 2x3 foundation (4).
  const buildingType = m.type(SV.buildingType, 'CAHOSP', 0x1000);
  m.i32(buildingType + O.buildingTypeFoundation, 6);
  const building = m.object(SV.building, 21, { x: 5000, y: 6000, z: 0 });
  m.u32(building + O.buildingType, buildingType);
  const tank = m.object(SV.unit, 22, { x: 3000, y: 3000, z: 104 });
  m.u32(tank + O.technoOwner, player);

  const anim = (
    typePointer: number,
    uid: number,
    location: { x: number; y: number; z: number },
    fields: { stage?: number; rate?: number; loops?: number; owner?: number; attached?: number; limbo?: boolean } = {},
  ) => {
    const at = m.object(V.anim, uid, location);
    m.u32(at + O.animType, typePointer);
    m.i32(at + O.animStage, fields.stage ?? 0);
    m.i32(at + O.animRate, fields.rate ?? 1);
    m.u8(at + O.animLoopsLeft, fields.loops ?? 1);
    m.u32(at + O.animOwner, fields.owner ?? 0);
    m.u32(at + O.animOwnerObject, fields.attached ?? 0);
    m.u8(at + O.inLimbo, fields.limbo ? 1 : 0);
    return at;
  };
  const boom = anim(explolrg, 31, { x: 1000, y: 2000, z: 0 }, { stage: 5, rate: 2 });
  const burning = anim(fire, 32, { x: 10, y: -20, z: 30 }, { stage: 3, loops: 0xff, attached: building, owner: ai });
  m.u8(burning + O.animBuilding, 1);
  const smoking = anim(smoke, 33, { x: 0, y: 0, z: 50 }, { attached: tank });
  // An anim riding on the smoke anim: owner chain anim -> anim -> unit.
  const riding = anim(explolrg, 34, { x: 5, y: 5, z: 5 }, { attached: smoking });
  const limbo = anim(explolrg, 35, { x: 0, y: 0, z: 0 }, { limbo: true });
  const badVtable = anim(explolrg, 36, { x: 0, y: 0, z: 0 });
  m.u32(badVtable, 0x12345678);
  const junkOwner = m.alloc(0x100);
  m.u32(junkOwner, 0x0040_1000); // a code address, not a .rdata vtable
  const orphan = anim(explolrg, 37, { x: 0, y: 0, z: 0 }, { attached: junkOwner });
  const badType = anim(m.alloc(0x400), 38, { x: 0, y: 0, z: 0 });
  m.vector(G.anims, [boom, burning, smoking, riding, limbo, badVtable, 0, orphan, badType, boom]);

  // A shell in flight.
  const cannon = m.type(V.bulletType, 'Cannon');
  m.u8(cannon + O.bulletTypeArcing, 1);
  const weapon = m.type(V.weaponType, '105mm');
  const warhead = m.type(V.warheadType, 'AP');
  const shell = m.object(V.bullet, 41, { x: 3100, y: 3200, z: 300 });
  m.u32(shell + O.bulletType, cannon);
  m.u32(shell + O.bulletFirer, tank);
  m.u32(shell + O.bulletWeapon, weapon);
  m.u32(shell + O.bulletWarhead, warhead);
  m.u8(shell + O.bulletFrame, 7);
  m.point(shell + O.bulletSource, { x: 3000, y: 3000, z: 200 });
  m.point(shell + O.bulletTargetCoords, { x: 3600, y: 4000, z: 0 });
  m.f64(shell + O.bulletVelocity, 12.5);
  m.f64(shell + O.bulletVelocity + 8, 25);
  m.f64(shell + O.bulletVelocity + 16, -3.25);
  const nanShell = m.object(V.bullet, 42, { x: 0, y: 0, z: 0 });
  m.u32(nanShell + O.bulletType, cannon);
  m.f64(nanShell + O.bulletVelocity, Number.NaN);
  m.vector(G.bullets, [shell, nanShell]);

  // A prism beam and a tesla bolt (plain structs).
  const laser = m.alloc(0x60);
  m.point(laser + O.laserSource, { x: 100, y: 200, z: 300 });
  m.point(laser + O.laserTarget, { x: 900, y: 800, z: 0 });
  m.u8(laser + O.laserInnerColor, 255);
  m.u8(laser + O.laserInnerColor + 1, 128);
  m.u8(laser + O.laserInnerColor + 2, 1);
  m.u8(laser + O.laserOuterColor + 2, 200);
  m.u8(laser + O.laserOuterSpread, 9);
  m.i32(laser + O.laserThickness, 3);
  m.u8(laser + O.laserHouseColor, 1);
  m.i32(laser + O.laserDuration, 15);
  m.i32(laser + O.laserProgress, 4);
  m.u8(laser + O.laserFades, 1);
  const badLaser = m.alloc(0x60);
  m.i32(badLaser + O.laserDuration, -5);
  m.vector(G.lasers, [laser, badLaser]);
  const bolt = m.alloc(0x30);
  m.point(bolt + O.boltSource, { x: 10, y: 20, z: 30 });
  m.point(bolt + O.boltTarget, { x: 40, y: 50, z: 60 });
  m.u32(bolt + O.boltFirer, tank);
  m.i32(bolt + O.boltWeaponSlot, 1);
  m.i32(bolt + O.boltLifetime, 0x4000);
  m.u8(bolt + O.boltAlternateColor, 1);
  const badBolt = m.alloc(0x30);
  m.i32(badBolt + O.boltLifetime, 0x20000);
  m.vector(G.electricBolts, [bolt, badBolt]);

  // A smoke column on the tank with two particles.
  const smokeSys = m.type(V.particleSystemType, 'SmokeSys');
  m.i32(smokeSys + O.particleSystemTypeBehavesLike, 0);
  const system = m.object(V.particleSystem, 51, { x: 3000, y: 3000, z: 150 });
  m.u32(system + O.particleSystemType, smokeSys);
  m.point(system + O.particleSystemTargetCoords, { x: 3000, y: 3000, z: 600 });
  m.u32(system + O.particleSystemOwnerObject, tank);
  m.u32(system + O.particleSystemHouse, ai);
  m.i32(system + O.particleSystemLifetime, -1);
  const particle = (location: { x: number; y: number; z: number }) => {
    const at = m.object(V.particle, 0, location);
    return at;
  };
  m.vector(system + O.particleSystemParticles, [
    particle({ x: 3010, y: 3000, z: 200 }),
    particle({ x: 3020, y: 2990, z: 260 }),
    0,
  ]);
  m.vector(G.particleSystems, [system]);

  // A flying turret.
  const debris = m.type(V.voxelAnimType, 'TURRET01');
  const voxel = m.object(V.voxelAnim, 61, { x: 4000, y: 4100, z: 400 });
  m.u32(voxel + O.voxelAnimType, debris);
  [1.5, -2, 8].forEach((v, i) => m.f32(voxel + O.voxelAnimVelocity + i * 4, v));
  [0, 0.5, 0, 0.75].forEach((v, i) => m.f32(voxel + O.voxelAnimRotation + i * 4, v));
  m.u32(voxel + O.voxelAnimHouse, player);
  m.i32(voxel + O.voxelAnimDuration, 40);
  m.vector(G.voxelAnims, [voxel]);

  // Technos: the tank fired 5 frames ago at a cell; the building fired long ago; a junk pointer.
  const cell = m.alloc(0x150);
  m.u32(cell, V.cell);
  m.u16(cell + O.cellMapCoords, 20);
  m.u16(cell + O.cellMapCoords + 2, 30);
  m.u8(cell + O.cellLevel, 2);
  m.i32(tank + O.technoLastFireFrame, 495);
  m.u32(tank + O.technoTarget, cell);
  m.i32(building + O.technoLastFireFrame, 100);
  m.vector(G.technos, [tank, building, 0x0dead0]);

  return { m, player, ai, building, tank, boom, burning, smoking, riding, shell, laser, bolt, system, voxel, cell };
}

describe('YR 1.001 effects reader', () => {
  it('reads anims (attached ones in world coordinates), bullets, beams, particle systems, debris and shots', () => {
    const b = battle();
    const effects = readYrEffects(createByteViewAccessor(b.m.bytes), { particles: true });
    expect(effects.frame).toBe(500);
    expect(effects.anims).toEqual([
      {
        id: b.boom,
        uid: 31,
        type: 'EXPLOLRG',
        x: 1000,
        y: 2000,
        z: 0,
        frame: 5,
        stage: 5,
        frameCount: 20,
        loopStart: 0,
        loopEnd: 20,
        loopsLeft: 1,
        rate: 2,
        attachedTo: null,
        owner: -1,
        layer: 'air',
        flat: false,
        translucent: false,
        translucency: 0,
        buildingAnim: false,
        invisible: false,
        paused: false,
      },
      {
        id: b.burning,
        uid: 32,
        type: 'FIRE01',
        // Building Location (5000, 6000) + 3x3 foundation centre (256, 256) + relative (10, -20, 30).
        x: 5266,
        y: 6236,
        z: 30,
        frame: 7,
        stage: 3,
        frameCount: 30,
        loopStart: 4,
        loopEnd: 34,
        loopsLeft: 255,
        rate: 1,
        attachedTo: { id: b.building, uid: 21, kind: 'building' },
        owner: 1,
        layer: 'ground',
        flat: false,
        translucent: true,
        translucency: 50,
        buildingAnim: true,
        invisible: false,
        paused: false,
      },
      expect.objectContaining({
        id: b.smoking,
        type: 'SMOKEY',
        x: 3000,
        y: 3000,
        z: 154,
        flat: true,
        attachedTo: { id: b.tank, uid: 22, kind: 'vehicle' },
      }),
      expect.objectContaining({
        id: b.riding,
        x: 3005,
        y: 3005,
        z: 159,
        layer: 'ground',
        attachedTo: { id: b.smoking, uid: 33, kind: 'anim' },
      }),
    ]);
    expect(effects.bullets).toEqual([
      {
        id: b.shell,
        uid: 41,
        type: 'Cannon',
        weapon: '105mm',
        warhead: 'AP',
        x: 3100,
        y: 3200,
        z: 300,
        source: { x: 3000, y: 3000, z: 200 },
        target: { x: 3600, y: 4000, z: 0 },
        velocity: { x: 12.5, y: 25, z: -3.25 },
        firer: { id: b.tank, uid: 22, kind: 'vehicle' },
        owner: 0,
        inviso: false,
        arcing: true,
        frame: 7,
      },
      // A torn velocity reads as zero rather than NaN.
      expect.objectContaining({ uid: 42, velocity: { x: 0, y: 0, z: 0 }, firer: null, owner: -1, weapon: null }),
    ]);
    expect(effects.lasers).toEqual([
      {
        id: b.laser,
        source: { x: 100, y: 200, z: 300 },
        target: { x: 900, y: 800, z: 0 },
        innerColor: [255, 128, 1],
        outerColor: [0, 0, 200],
        outerSpread: [9, 0, 0],
        thickness: 3,
        houseColor: true,
        duration: 15,
        progress: 4,
        fades: true,
        blinks: false,
      },
    ]);
    expect(effects.electricBolts).toEqual([
      {
        id: b.bolt,
        source: { x: 10, y: 20, z: 30 },
        target: { x: 40, y: 50, z: 60 },
        firer: { id: b.tank, uid: 22, kind: 'vehicle' },
        weaponSlot: 1,
        lifetime: 0x4000,
        alternateColor: true,
      },
    ]);
    expect(effects.particleSystems).toEqual([
      {
        id: b.system,
        uid: 51,
        type: 'SmokeSys',
        behavesLike: 'smoke',
        x: 3000,
        y: 3000,
        z: 150,
        target: { x: 3000, y: 3000, z: 600 },
        attachedTo: { id: b.tank, uid: 22, kind: 'vehicle' },
        owner: 1,
        particleCount: 3,
        lifetime: -1,
        particles: [
          { x: 3010, y: 3000, z: 200 },
          { x: 3020, y: 2990, z: 260 },
        ],
      },
    ]);
    expect(effects.voxelAnims).toEqual([
      {
        id: b.voxel,
        uid: 61,
        type: 'TURRET01',
        x: 4000,
        y: 4100,
        z: 400,
        velocity: { x: 1.5, y: -2, z: 8 },
        rotation: [0, 0.5, 0, 0.75],
        owner: 0,
        duration: 40,
        invisible: false,
      },
    ]);
    expect(effects.fires).toEqual([
      {
        id: b.tank,
        uid: 22,
        kind: 'vehicle',
        frame: 495,
        target: { id: b.cell, uid: 0, kind: 'cell' },
        targetPosition: { x: 20 * 256 + 128, y: 30 * 256 + 128, z: 208 },
      },
    ]);
    // Anim vector: 4 good + limbo + bad vtable + null + unresolvable owner + bad type + duplicate.
    expect(effects.stats).toEqual({
      vectors: { anims: 10, voxelAnims: 1, bullets: 2, particleSystems: 1, lasers: 2, electricBolts: 2 },
      invalid: { anims: 4, voxelAnims: 0, bullets: 0, particleSystems: 0, lasers: 1, electricBolts: 1 },
      limbo: { anims: 1, voxelAnims: 0, bullets: 0, particleSystems: 0, lasers: 0, electricBolts: 0 },
      unresolved: 1,
      technos: 3,
    });
  });

  it('honours includeLimbo, fireWindow and particles options', () => {
    const b = battle();
    const memory = createByteViewAccessor(b.m.bytes);
    const withLimbo = readYrEffects(memory, { includeLimbo: true });
    expect(withLimbo.anims.map((a) => a.uid)).toEqual([31, 32, 33, 34, 35]);
    expect(withLimbo.stats.limbo.anims).toBe(0);
    expect(withLimbo.particleSystems[0]!.particles).toBeUndefined();
    const noFires = readYrEffects(memory, { fireWindow: 0 });
    expect(noFires.fires).toEqual([]);
    expect(noFires.stats.technos).toBe(0);
    // The building's shot at frame 100 is inside a 400-frame window.
    expect(readYrEffects(memory, { fireWindow: 400 }).fires.map((f) => f.uid)).toEqual([22, 21]);
    // A shot "in the future" (torn read) is never reported.
    b.m.i32(b.tank + O.technoLastFireFrame, 501);
    expect(readYrEffects(memory).fires).toEqual([]);
  });

  it('never writes guest memory', () => {
    const { m } = battle();
    const before = m.bytes.slice();
    readYrEffects(createByteViewAccessor(m.bytes), { includeLimbo: true, particles: true, fireWindow: 1000 });
    expect(Buffer.compare(m.bytes, before)).toBe(0);
  });

  it('returns empty lists outside a battle', () => {
    const effects = readYrEffects(createByteViewAccessor(new Uint8Array(0x100_0000)));
    expect(effects).toMatchObject({
      frame: 0,
      anims: [],
      voxelAnims: [],
      bullets: [],
      lasers: [],
      electricBolts: [],
      particleSystems: [],
      fires: [],
    });
  });

  it('rejects implausible vectors, coordinates and values', () => {
    const b = battle();
    const read = () => readYrEffects(createByteViewAccessor(b.m.bytes));
    // Coordinates beyond any map.
    b.m.i32(b.boom + O.location, YR_EFFECTS_LIMITS.maxCoordinate + 1);
    expect(read().anims.some((a) => a.id === b.boom)).toBe(false);
    b.m.i32(b.boom + O.location, 1000);
    b.m.i32(b.shell + O.bulletTargetCoords + 8, YR_EFFECTS_LIMITS.maxHeight + 1);
    expect(read().bullets.some((x) => x.id === b.shell)).toBe(false);
    b.m.i32(b.shell + O.bulletTargetCoords + 8, 0);
    // A type ID that is not printable ASCII is invalid.
    const type = b.m.view.getUint32(b.boom + O.animType, true);
    b.m.u8(type + O.typeId, 0x07);
    expect(read().anims.some((a) => a.type === 'EXPLOLRG')).toBe(false);
    b.m.u8(type + O.typeId, 'E'.charCodeAt(0));
    // A building owner with an out-of-range foundation cannot be resolved.
    const buildingType = b.m.view.getUint32(b.building + O.buildingType, true);
    b.m.i32(buildingType + O.buildingTypeFoundation, 99);
    expect(read().anims.some((a) => a.id === b.burning)).toBe(false);
    expect(read().stats.unresolved).toBe(2);
    b.m.i32(buildingType + O.buildingTypeFoundation, 6);
    // An attached anim whose Location is still absolute (torn read inside SetOwnerObject) is skipped, not doubled.
    b.m.i32(b.smoking + O.location, 3000);
    expect(read().anims.some((a) => a.id === b.smoking)).toBe(false);
    b.m.i32(b.smoking + O.location, 0);
    // A particle count above the limit rejects the system.
    b.m.u32(b.system + O.particleSystemParticles + 0x10, YR_EFFECTS_LIMITS.particlesPerSystem + 1);
    expect(read().stats.invalid.particleSystems).toBe(1);
    b.m.u32(b.system + O.particleSystemParticles + 0x10, 3);
    // Vector count above the sanity limit: nothing is read and the whole count is invalid.
    b.m.u32(G.anims + 0x10, YR_EFFECTS_LIMITS.anims + 1);
    expect(read().anims).toEqual([]);
    expect(read().stats.invalid.anims).toBe(YR_EFFECTS_LIMITS.anims + 1);
    // Items pointer outside memory.
    b.m.u32(G.bullets + 4, 0xffff_fff0);
    expect(read().stats.invalid.bullets).toBe(2);
    // An unknown house pointer resolves to -1.
    b.m.u32(b.system + O.particleSystemHouse, 0xdead0);
    expect(read().particleSystems[0]?.owner).toBe(-1);
  });

  it('resolves object coordinates like the engine GetCoords implementations', () => {
    const b = battle();
    const memory = createByteViewAccessor(b.m.bytes);
    expect(readYrObjectCoords(memory, b.tank)).toEqual({ x: 3000, y: 3000, z: 104 });
    expect(readYrObjectCoords(memory, b.building)).toEqual({ x: 5256, y: 6256, z: 0 });
    expect(readYrObjectCoords(memory, b.cell)).toEqual({ x: 5248, y: 7808, z: 208 });
    expect(readYrObjectCoords(memory, b.riding)).toEqual({ x: 3005, y: 3005, z: 159 });
    // The attachment chain is followed at most `depth` levels deep.
    expect(readYrObjectCoords(memory, b.riding, 1)).toBeNull();
    // Unknown GetCoords implementation, null and unaligned pointers.
    b.m.u32(V.terrain + YR_GET_COORDS_SLOT, 0x401234);
    const tree = b.m.object(V.terrain, 70, { x: 1, y: 2, z: 3 });
    expect(readYrObjectCoords(memory, tree)).toBeNull();
    expect(readYrObjectCoords(memory, 0)).toBeNull();
    expect(readYrObjectCoords(memory, b.tank + 2)).toBeNull();
  });

  it('survives random memory without throwing or looping', () => {
    const m = syntheticMemory();
    m.installVtables();
    let seed = 99;
    const random = () => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0);
    const heads = [G.anims, G.voxelAnims, G.bullets, G.particleSystems, G.lasers, G.electricBolts, G.technos, G.houses];
    for (let round = 0; round < 40; round++) {
      for (let at = 0xb0_0000; at < 0xb4_0000; at += 4)
        m.u32(at, round % 2 ? random() : [V.anim, V.bullet, V.particleSystem, SV.unit, 0xb0_1000][random() % 5]!);
      for (const base of heads) {
        m.u32(base + 4, 0xb0_0000 + (random() % 0x3_0000) * 4);
        m.u32(base + 0x10, random() % 64);
      }
      m.i32(G.frame, random() % 100000);
      const effects = readYrEffects(createByteViewAccessor(m.bytes), {
        includeLimbo: true,
        particles: true,
        fireWindow: 1 << 30,
      });
      for (const a of effects.anims) expect(Math.abs(a.x)).toBeLessThanOrEqual(YR_EFFECTS_LIMITS.maxCoordinate);
      for (const x of effects.bullets) expect(Number.isFinite(x.velocity.x)).toBe(true);
    }
  });
});

describe('effects reader factory', () => {
  it('only supports the pinned image with the expected GetCoords slots', () => {
    const b = battle();
    const accessor = () => createByteViewAccessor(b.m.bytes);
    expect(createYrEffectsReader(accessor, 'other')).toBeNull();
    const read = createYrEffectsReader(accessor, YR_STARTUP_PAGE_HASH);
    expect(read?.()?.anims.length).toBe(4);
    b.m.u32(V.anim + YR_GET_COORDS_SLOT, 0x401000);
    expect(createYrEffectsReader(accessor, YR_STARTUP_PAGE_HASH)).toBeNull();
    const empty = new Uint8Array(0x100_0000);
    expect(createYrEffectsReader(() => createByteViewAccessor(empty), YR_STARTUP_PAGE_HASH)).toBeNull();
  });
});
