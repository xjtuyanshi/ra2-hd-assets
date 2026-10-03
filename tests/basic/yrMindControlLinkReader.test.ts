import { describe, expect, it } from 'vitest';
import { createByteViewAccessor } from '../../src/games/shared/memoryAccessor';
import {
  readYrMindControlLinks,
  YR_CAPTURE_MANAGER_VTABLE,
  YR_MIND_CONTROL_HOUSE_VTABLE,
  YR_MIND_CONTROL_GLOBALS as G,
  YR_MIND_CONTROL_LIMITS as L,
  YR_MIND_CONTROL_OFFSETS as O,
} from '../../src/games/yr/mindControlLinkReader';
import { YR_STATE_VTABLES as V } from '../../src/games/yr/stateReader';

function memory() {
  const bytes = new Uint8Array(0x1000000),
    data = new DataView(bytes.buffer);
  let next = 0xc00000;
  const alloc = (size: number) => {
    const p = next;
    next += (size + 15) & ~15;
    return p;
  };
  const word = (p: number, n: number) => data.setInt32(p, n, true);
  const f32 = (p: number, n: number) => data.setFloat32(p, n, true);
  const point = (p: number, x: number, y: number, z: number) => {
    word(p, x);
    word(p + 4, y);
    word(p + 8, z);
  };
  const matrix = (p: number, entries: number[]) => entries.forEach((n, i) => f32(p + i * 4, n));
  const vector = (p: number, entries: number[]) => {
    const list = alloc(Math.max(4, entries.length * 4));
    word(p + 4, list);
    word(p + 8, entries.length);
    word(p + 0x10, entries.length);
    entries.forEach((e, i) => word(list + i * 4, e));
  };
  word(G.frame, 100);
  f32(G.trigScale, 2607.594482421875);
  for (let i = 0; i < 10240; i++) f32(G.trig + i * 4, Math.sin((i * Math.PI * 2) / 8192));
  const house = alloc(O.houseColor + 4);
  word(house, YR_MIND_CONTROL_HOUSE_VTABLE);
  bytes.set([30, 120, 230], house + O.houseColor);
  const techno = (kind: 'unit' | 'infantry' | 'building' | 'aircraft' = 'infantry') => {
    const id = alloc(0x800),
      type = alloc(0x1800);
    word(id, V[kind]);
    word(type, V[`${kind}Type`]);
    word(id + (kind === 'building' ? 0x520 : kind === 'infantry' ? 0x6c0 : 0x6c4), type);
    word(id + O.owner, house);
    word(id + 0x6c, 100);
    point(id + O.location, 2560, 3072, 104);
    for (let i = 0; i < 5; i++) point(type + O.alternateFlh + i * 12, 0, 0, 140);
    if (kind === 'building') {
      word(type + 0xe44, 65535);
      word(type + 0xe48, 65535);
    }
    word(type + O.targetHeight, 80);
    return { id, type };
  };
  const controller = techno();
  const manager = alloc(0x50);
  word(manager, YR_CAPTURE_MANAGER_VTABLE);
  word(manager + O.controller, controller.id);
  word(controller.id + O.manager, manager);
  vector(G.managers, [manager]);
  const node = (kind: 'unit' | 'infantry' | 'building' | 'aircraft' = 'unit') => {
    const unit = techno(kind),
      id = alloc(0x14);
    point(unit.id + O.location, 4096, 3584, 208);
    word(unit.id + O.controlledBy, controller.id);
    word(id, unit.id);
    word(id + 4, house);
    word(id + O.timerStart, 90);
    word(id + O.timerDuration, 20);
    return { id, unit };
  };
  const first = node();
  vector(manager + O.nodes, [first.id]);
  return {
    bytes,
    data,
    alloc,
    word,
    f32,
    point,
    matrix,
    vector,
    techno,
    controller,
    manager,
    node,
    first,
    house,
    accessor: createByteViewAccessor(bytes),
  };
}

describe('YR mind-control links', () => {
  it('reads the native control-node lifetime, house RGB, muzzle and raised raw target without writes', () => {
    const m = memory(),
      before = m.bytes.slice();
    const result = readYrMindControlLinks(m.accessor);
    expect(result.mindControlLinks).toEqual([
      {
        id: m.first.id,
        controller: m.controller.id,
        targetId: m.first.unit.id,
        source: { x: 2560, y: 3072, z: 244 },
        target: { x: 4096, y: 3584, z: 288 },
        color: [30, 120, 230],
        arcHeight: 512,
        remainingFrames: 10,
        selected: false,
      },
    ]);
    expect(result.stats).toEqual({ managers: 1, nodes: 1, invalid: 0, inactive: 0, unsupported: 0 });
    expect(m.bytes.every((value, index) => value === before[index])).toBe(true);
  });

  it('keeps each node only for its capture timer or endpoint selection, including stopped timers', () => {
    const m = memory(),
      second = m.node();
    m.vector(m.manager + O.nodes, [m.first.id, second.id]);
    m.word(G.frame, 110);
    expect(readYrMindControlLinks(m.accessor).mindControlLinks).toHaveLength(0);
    m.bytes[second.unit.id + O.selected] = 1;
    expect(readYrMindControlLinks(m.accessor).mindControlLinks.map((b) => b.id)).toEqual([second.id]);
    m.bytes[m.controller.id + O.selected] = 1;
    expect(readYrMindControlLinks(m.accessor).mindControlLinks).toHaveLength(2);
    m.bytes[second.unit.id + O.selected] = m.bytes[m.controller.id + O.selected] = 0;
    m.word(m.first.id + O.timerStart, -1);
    expect(readYrMindControlLinks(m.accessor).mindControlLinks[0]?.remainingFrames).toBe(20);
    m.word(m.first.id + O.timerDuration, 0);
    const transport = m.techno('unit');
    m.word(m.controller.id + 0x11c, transport.id);
    m.bytes[transport.id + O.selected] = 1;
    expect(readYrMindControlLinks(m.accessor).mindControlLinks).toHaveLength(0);
  });

  it('suppresses planning mode, without an invented local-owner or shroud gate', () => {
    const m = memory();
    m.word(0xa83d4c, m.alloc(4));
    m.bytes[m.first.unit.id + 0x84] = 1;
    expect(readYrMindControlLinks(m.accessor).mindControlLinks).toHaveLength(1);
    m.bytes[G.planning] = 1;
    expect(readYrMindControlLinks(m.accessor).mindControlLinks).toHaveLength(0);
    m.bytes[G.planning] = 2;
    expect(readYrMindControlLinks(m.accessor).stats.invalid).toBeGreaterThan(0);
  });

  it('invokes the entire manager through any healthy controlled unit and rejects a torn colour owner', () => {
    const m = memory(),
      other = m.node();
    m.vector(m.manager + O.nodes, [m.first.id, other.id]);
    m.word(m.controller.id + 0x6c, 0);
    m.word(m.first.unit.id + 0x6c, 0);
    expect(readYrMindControlLinks(m.accessor).mindControlLinks).toHaveLength(2);
    m.word(other.unit.id + 0x6c, 0);
    expect(readYrMindControlLinks(m.accessor).mindControlLinks).toHaveLength(0);
    m.word(m.house, 0);
    expect(readYrMindControlLinks(m.accessor).stats.invalid).toBe(1);
  });

  it.each(['unit', 'infantry', 'building', 'aircraft'] as const)(
    'uses raw %s target location, not a centre estimate',
    (kind) => {
      const m = memory(),
        node = m.node(kind);
      m.vector(m.manager + O.nodes, [node.id]);
      // A building's foundation/virtual GetCoords centre must not move this endpoint.
      m.word(node.unit.type + 0xef0, 18);
      expect(readYrMindControlLinks(m.accessor).mindControlLinks[0]?.target).toEqual({ x: 4096, y: 3584, z: 288 });
    },
  );

  it.each([0, 16384, 32768, 49152])('applies FLH lateral/barrel and forward offsets at heading %i', (heading) => {
    const m = memory();
    m.word(m.controller.id + 0x388, heading);
    m.point(m.controller.type + O.alternateFlh, 100, 25, 140);
    const p = readYrMindControlLinks(m.accessor).mindControlLinks[0]!.source;
    // Native table/truncation can move an axis by one lepton near a cardinal direction.
    const a = (heading * 2 * Math.PI) / 65536;
    expect(Math.abs(p.x - (2560 + 100 * Math.sin(a) - 25 * Math.cos(a)))).toBeLessThanOrEqual(1);
    expect(Math.abs(p.y - (3072 - 100 * Math.cos(a) - 25 * Math.sin(a)))).toBeLessThanOrEqual(1);
    m.word(m.controller.id + O.barrel, 1);
    const opposite = readYrMindControlLinks(m.accessor).mindControlLinks[0]!.source;
    expect(Math.abs(opposite.x - (2560 + 100 * Math.sin(a) + 25 * Math.cos(a)))).toBeLessThanOrEqual(1);
    expect(Math.abs(opposite.y - (3072 - 100 * Math.cos(a) + 25 * Math.sin(a)))).toBeLessThanOrEqual(1);
  });

  it('uses all five alternate FLH slots for a multi-controller and wraps by original node index', () => {
    const m = memory(),
      nodes = Array.from({ length: 6 }, () => m.node());
    nodes.forEach((_, i) => {
      if (i < 5) m.point(m.controller.type + O.alternateFlh + i * 12, 0, 0, 90 + i * 10);
    });
    m.vector(
      m.manager + O.nodes,
      nodes.map((n) => n.id),
    );
    m.word(nodes[1]!.id + O.timerDuration, 0);
    expect(readYrMindControlLinks(m.accessor).mindControlLinks.map((l) => l.source.z)).toEqual([
      194, 214, 224, 234, 194,
    ]);
  });

  it('composes a drive locomotor fixed-ramp matrix before FLH and rejects changing/rocking transforms', () => {
    const m = memory();
    m.word(m.controller.id, V.unit);
    m.word(m.controller.type, V.unitType);
    m.word(m.controller.id + 0x6c4, m.controller.type);
    m.bytes[m.controller.id + 0x14] = 4;
    const loco = m.alloc(0x70);
    m.word(m.controller.id + O.locomotor, loco);
    m.word(loco, 0x7e7eb0);
    m.word(loco + 8, m.controller.id);
    m.word(loco + 0x18, 1);
    m.word(loco + 0x1c, 1);
    m.matrix(G.rampMatrices + 48, [1, 0, 0, 0, 0, 0.8, -0.6, 0, 0, 0.6, 0.8, 0]);
    const link = readYrMindControlLinks(m.accessor).mindControlLinks[0]!;
    expect(link.source).toEqual({ x: 2560, y: 3156, z: 216 });
    m.word(loco + 0x2c, 10);
    m.word(loco + 0x20, 100);
    m.word(loco + 0x28, 10);
    expect(readYrMindControlLinks(m.accessor).stats.unsupported).toBe(1);
    m.word(loco + 0x2c, 0);
    m.f32(m.controller.id + 0x328, 0.1);
    expect(readYrMindControlLinks(m.accessor).stats.unsupported).toBe(1);
  });

  it('uses a building render origin and native FirePixelOffset inverse matrix', () => {
    const m = memory(),
      b = m.techno('building');
    m.word(m.manager + O.controller, b.id);
    m.word(b.id + O.manager, m.manager);
    m.word(m.first.unit.id + O.controlledBy, b.id);
    expect(readYrMindControlLinks(m.accessor).mindControlLinks[0]?.source).toEqual({ x: 2432, y: 2944, z: 244 });
    const tactical = m.alloc(0xe20);
    m.word(G.tactical, tactical);
    m.matrix(tactical + 0xde4, [4, 8, 0, 0, -4, 8, 0, 0, 0, 0, 1, 0]);
    m.word(b.type + 0xe44, 2);
    m.word(b.type + 0xe48, -5);
    expect(readYrMindControlLinks(m.accessor).mindControlLinks[0]?.source).toEqual({ x: 2400, y: 2896, z: 104 });
  });

  it('bounds vectors, rejects duplicate/torn manager/node/object state and never invents geometry', () => {
    const m = memory();
    m.vector(G.managers, [0, m.manager + 1, m.manager, m.manager]);
    m.vector(m.manager + O.nodes, [0, m.first.id + 1, m.first.id, m.first.id]);
    expect(readYrMindControlLinks(m.accessor).stats.invalid).toBe(6);
    m.vector(G.managers, [m.manager]);
    m.vector(m.manager + O.nodes, [m.first.id]);
    m.word(m.first.unit.id + O.controlledBy, 0);
    expect(readYrMindControlLinks(m.accessor).stats.invalid).toBe(1);
    m.word(m.first.unit.id + O.controlledBy, m.controller.id);
    m.word(m.first.id + O.timerStart, 101);
    expect(readYrMindControlLinks(m.accessor).stats.invalid).toBe(1);
    m.word(m.first.id + O.timerStart, 90);
    m.bytes[m.controller.id + 0x82] = 1;
    m.word(m.controller.id + 0x11c, m.first.unit.id);
    expect(readYrMindControlLinks(m.accessor).stats.unsupported).toBe(1);
    m.word(G.managers + 0x10, L.managers + 1);
    m.word(G.managers + 8, L.managers + 1);
    expect(readYrMindControlLinks(m.accessor).mindControlLinks).toHaveLength(0);
    expect(readYrMindControlLinks(createByteViewAccessor(new Uint8Array(16))).mindControlLinks).toEqual([]);
  });
});
