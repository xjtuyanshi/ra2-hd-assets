import { describe, expect, it } from 'vitest';
import { foundationPointPush } from '../src/ra2/cardDepth';
import { DOCK_PULL_MARGIN, DOCK_PULL_MAX, dockPull, propagateDockPull } from '../src/ra2/dockPull';
import { painterObject, spritePainterBias, type PainterObject } from '../src/ra2/painterOrder';

const building = (index?: number): PainterObject => ({
  ...painterObject(2, 100, index),
  uid: 1,
  dock: true,
  x: 10,
  z: 20,
  foundation: [4, 3],
});
const unit = (x = 13, z = 21, index?: number): PainterObject => ({
  ...painterObject(2, 200, index),
  uid: 2,
  contactUid: 1,
  x,
  z,
});
const anchor = (u: PainterObject) => ({ x: u.x + 0.5, z: u.z + 0.5 });
const pull = (u: PainterObject, host = building()) => dockPull(u, anchor(u), host);

describe('contacted dock pull', () => {
  it.each([0, 100])('never pulls a factory exit, independently of %s stationary frames', (stationaryFrames) => {
    const u = { ...unit(12, 21), stationaryFrames };
    for (const host of [
      { ...building(), foundation: [5, 3] as const, dock: false },
      { ...building(), foundation: [5, 3] as const, unloading: 'door' as const },
      { ...building(), foundation: [5, 3] as const, unloading: 'roof' as const },
    ])
      expect(pull(u, host)).toBe(0);
  });

  it.each([0, 100])('matches the measured dock even at %s stationary frames', (stationaryFrames) => {
    const host = { ...building(), x: 51, z: 101 };
    const exact = { x: 13952 / 256, z: 26240 / 256 };
    const u = { ...unit(Math.floor(exact.x), Math.floor(exact.z)), stationaryFrames };
    expect(dockPull(u, exact, host)).toBeCloseTo(3.00949, 5);
    expect(DOCK_PULL_MARGIN).toBe(0.5);
  });

  it('uses the exact subcell anchor without changing painter coordinates', () => {
    const u = unit();
    expect(dockPull(u, { x: 13.25, z: 21.5 }, building())).toBeGreaterThan(
      dockPull(u, { x: 13.75, z: 21.5 }, building()),
    );
    expect(u).toMatchObject({ x: 13, z: 21 });
  });

  it.each([
    [14, 21],
    [12, 23],
    [14, 23],
    [9, 21],
    [12, 19],
  ])('pulls while backing in at (%s, %s)', (x, z) => {
    expect(pull(unit(x, z))).toBeGreaterThan(0);
  });
  it.each([
    [16, 21],
    [12, 25],
    [8, 21],
    [12, 18],
  ])('does not pull a distant contact at (%s, %s)', (x, z) => {
    expect(pull(unit(x, z))).toBe(0);
  });
  it.each([undefined, 99])('requires contactUid matching the host (%s)', (contactUid) => {
    expect(pull({ ...unit(), contactUid })).toBe(0);
  });
  it('disables pull without validated host data', () => {
    expect(dockPull(unit(), anchor(unit()))).toBe(0);
    expect(pull(unit(), { ...building(), dock: undefined })).toBe(0);
    expect(pull(unit(), { ...building(), uid: undefined })).toBe(0);
  });
  it('retains the native traversal condition, including registered order over ySort', () => {
    expect(pull({ ...unit(), ySort: 50 })).toBe(0);
    const host = building(2);
    expect(pull(unit(13, 21, 1), host)).toBe(0);
    expect(pull(unit(13, 21, 2), host)).toBe(0);
    expect(pull({ ...unit(13, 21, 3), ySort: 50 }, host)).toBeGreaterThan(0);
  });
  it('caps the maximum of the five foundation samples at 3.5', () => {
    expect(foundationPointPush(0.5, 0.5, 4, 3) + DOCK_PULL_MARGIN).toBeGreaterThan(DOCK_PULL_MAX);
    expect(pull(unit(10, 20))).toBe(3.5);
  });
  it.each([0, 1, 3, 4])('does not pull layer %s', (layer) => {
    expect(pull({ ...unit(), layer })).toBe(0);
  });
  it('ignores non-ground hosts, buildings and absent/empty foundations', () => {
    expect(pull(unit(), { ...building(), layer: 3 })).toBe(0);
    expect(pull({ ...unit(), foundation: [1, 1] })).toBe(0);
    for (const foundation of [undefined, [0, 3], [4, 0]] as const)
      expect(pull(unit(), { ...building(), foundation })).toBe(0);
  });
});

describe('passing ground units retain native order', () => {
  const depth = (u: PainterObject) => (u.x + u.z + 1) * Math.sqrt(3 / 8) + spritePainterBias(u);
  it.each([1, 2])('keeps a later unit %s cells in front over a pulled unit', (distance) => {
    const d = unit(13, 21, 3);
    d.pull = pull(d, building(2));
    const u = { ...unit(13 + distance, 21, 4), contactUid: undefined };
    const source = { painter: d, anchor: anchor(d) };
    propagateDockPull([{ painter: u, anchor: anchor(u) }], [source]);
    expect(u.pull).toBeGreaterThan(0);
    expect(depth(u)).toBeGreaterThan(depth(d));
    expect(depth(u) - depth(d)).toBeCloseTo(0.05, 10);
  });
  it('leaves earlier, distant, non-ground and building painters unchanged', () => {
    const d = unit(13, 21, 3);
    d.pull = 3;
    const others = [
      unit(12, 21, 2),
      unit(17, 21, 4),
      { ...unit(14, 21, 4), layer: 4 },
      { ...unit(14, 21, 4), foundation: [1, 1] as const },
    ];
    propagateDockPull(
      others.map((painter) => ({ painter, anchor: anchor(painter) })),
      [{ painter: d, anchor: anchor(d) }],
    );
    for (const u of others) expect(u.pull ?? 0).toBe(0);
  });
  it('does not propagate through passing units or change directly docked pulls', () => {
    const d = unit(13, 21, 3);
    d.pull = 3;
    const u = unit(15, 21, 4);
    const far = unit(17, 21, 5);
    const units = [d, u, far].map((painter) => ({ painter, anchor: anchor(painter) }));
    propagateDockPull(units, [units[0]!]);
    expect(d.pull).toBe(3);
    expect(u.pull).toBeGreaterThan(0);
    expect(far.pull ?? 0).toBe(0);
  });
});
