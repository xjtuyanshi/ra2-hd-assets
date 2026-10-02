import { describe, expect, it } from 'vitest';
import { BuildingVisualHistory } from '../src/live/buildingVisualHistory';
import type { LiveObject, LiveSnapshot } from '../src/live/liveView';

const building: LiveObject = {
  id: 100,
  uid: 1,
  kind: 'building',
  type: 'TEST',
  owner: 0,
  x: 256,
  y: 256,
  z: 0,
  facingRaw: 0,
  health: 0,
  isSelected: false,
  buildState: 'done',
  buildingFrame: 3,
};
const snap = (frame: number, objects: LiveObject[] = []): LiveSnapshot => ({ frame, objects, houses: [], view: null });

describe('destroyed building last visual', () => {
  it('freezes the last descriptor and animation snapshot for one missing frame, regardless of poll count', () => {
    const history = new BuildingVisualHistory();
    const last = snap(10, [building]);
    history.update(last);
    history.update(snap(11));
    expect(history.retained.get(1)).toMatchObject({ object: building, snapshot: last });
    for (let i = 0; i < 10; i++) history.update(snap(11));
    expect(history.retained.size).toBe(1);
    history.update(snap(12));
    expect(history.retained.size).toBe(0);
    history.update(snap(13));
    expect(history.retained.size).toBe(0);
  });

  it.each([{ health: 1 }, { buildState: 'selling' as const }, { kind: 'vehicle' as const }, { nativeHidden: true }])(
    'does not retain ineligible disappearance %o',
    (change) => {
      const history = new BuildingVisualHistory();
      history.update(snap(10, [{ ...building, ...change }]));
      history.update(snap(11));
      expect(history.retained.size).toBe(0);
    },
  );

  it('cancels retention when the same pointer has a new UID, even on a later same-frame poll', () => {
    const history = new BuildingVisualHistory();
    history.update(snap(10, [building]));
    history.update(snap(11));
    history.update(snap(11, [{ ...building, uid: 2, health: 1 }]));
    expect(history.retained.size).toBe(0);
    history.update(snap(11));
    expect(history.retained.size).toBe(0);
  });

  it('uses the latest reported health and sale state and cancels retention on reappearance', () => {
    const history = new BuildingVisualHistory();
    history.update(snap(10, [building]));
    history.update(snap(11));
    history.update(snap(11, [{ ...building, health: 0.5 }]));
    expect(history.retained.size).toBe(0);
    history.update(snap(12));
    expect(history.retained.size).toBe(0);
    history.update(snap(13, [building]));
    history.update(snap(13, [{ ...building, buildState: 'selling' }]));
    history.update(snap(14));
    expect(history.retained.size).toBe(0);
  });

  it('does not stretch a same-frame disappearance into another logic frame', () => {
    const history = new BuildingVisualHistory();
    history.update(snap(10, [building]));
    history.update(snap(10));
    expect(history.retained.size).toBe(1);
    history.update(snap(11));
    expect(history.retained.size).toBe(0);
  });

  it.each([12, 9])('discards history across a frame gap or rollback to %i', (frame) => {
    const history = new BuildingVisualHistory();
    history.update(snap(10, [building]));
    history.update(snap(frame));
    expect(history.retained.size).toBe(0);
  });
});
