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

describe('vanished building last visual', () => {
  it.each([0, 0.5, 1])(
    'retains the last visual for one missing frame without requiring a zero-HP publication (health %s)',
    (health) => {
      const history = new BuildingVisualHistory();
      const object = { ...building, health };
      const last = snap(10, [object]);
      history.update(last);
      history.update(snap(11));
      expect(history.retained.get(1)).toMatchObject({ object, snapshot: last });
      for (let i = 0; i < 10; i++) history.update(snap(11));
      expect(history.retained.size).toBe(1);
      history.update(snap(12));
      expect(history.retained.size).toBe(0);
      history.update(snap(13));
      expect(history.retained.size).toBe(0);
    },
  );

  it.each([{ buildState: 'selling' as const }, { kind: 'vehicle' as const }, { nativeHidden: true }])(
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
    history.update(snap(11, [{ ...building, uid: 2, kind: 'vehicle', health: 1 }]));
    expect(history.retained.size).toBe(0);
    history.update(snap(11));
    expect(history.retained.size).toBe(0);
  });

  it('cancels retention on reappearance and uses the latest drawable descriptor', () => {
    const history = new BuildingVisualHistory();
    history.update(snap(10, [building]));
    history.update(snap(11));
    const returned = { ...building, health: 0.5, buildingFrame: 2, type: 'REPLACEMENT' };
    history.update(snap(11, [returned]));
    expect(history.retained.size).toBe(0);
    history.update(snap(12));
    expect(history.retained.get(1)?.object).toEqual(returned);
    history.update(snap(13));
    expect(history.retained.size).toBe(0);
  });

  it.each([{ buildState: 'selling' as const }, { nativeHidden: true }])(
    'cancels both current retention and future resurrection on explicit exclusion %o',
    (change) => {
      const history = new BuildingVisualHistory();
      history.update(snap(10, [building]));
      history.update(snap(11));
      expect(history.retained.size).toBe(1);
      history.update(snap(11, [{ ...building, ...change }]));
      expect(history.retained.size).toBe(0);
      history.update(snap(11));
      expect(history.retained.size).toBe(0);
      history.update(snap(12));
      expect(history.retained.size).toBe(0);
    },
  );

  it('cannot restore a vanished predecessor after the pointer is reused by another building', () => {
    const history = new BuildingVisualHistory();
    history.update(snap(10, [building]));
    history.update(snap(11));
    const replacement = { ...building, uid: 2, type: 'REPLACEMENT', health: 1 };
    history.update(snap(11, [replacement]));
    expect(history.retained.size).toBe(0);
    history.update(snap(11));
    expect([...history.retained.keys()]).toEqual([2]);
    expect(history.retained.get(2)?.object).toEqual(replacement);
    history.update(snap(12));
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
    history.update(snap(frame));
    expect(history.retained.size).toBe(0);
  });

  it('clears a pending visual across rollback or disposal even when the old frame is revisited', () => {
    const history = new BuildingVisualHistory();
    history.update(snap(10, [building]));
    history.update(snap(11));
    history.update(snap(9));
    history.update(snap(10));
    expect(history.retained.size).toBe(0);
    history.update(snap(10, [building]));
    history.update(snap(11));
    history.clear();
    expect(history.retained.size).toBe(0);
    history.update(snap(11));
    expect(history.retained.size).toBe(0);
  });
});
