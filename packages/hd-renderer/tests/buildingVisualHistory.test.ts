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
    // The replacement was last present in frame 11, so its own deadline is frame 12; the predecessor stays gone.
    history.update(snap(12));
    expect([...history.retained.keys()]).toEqual([2]);
    expect(history.retained.get(2)?.object).toEqual(replacement);
    history.update(snap(13));
    expect(history.retained.size).toBe(0);
  });

  it('keeps a building first missed under its last frame number through the next logic frame only', () => {
    // Live frozen pairs (NAPOWR, logic frames 12407..12409): the engine removes the building in the middle of the
    // tick, so a poll misses it while the counter still reads 12407; the native picture keeps the intact building
    // when the counter stops at 12408 and drops it at 12409. The deadline counts from the last present frame.
    const history = new BuildingVisualHistory();
    const last = snap(10, [building]);
    history.update(last);
    history.update(snap(10));
    expect(history.retained.get(1)).toMatchObject({ object: building, snapshot: last });
    for (let i = 0; i < 3; i++) history.update(snap(10));
    expect(history.retained.size).toBe(1);
    history.update(snap(11));
    expect(history.retained.get(1)).toMatchObject({ object: building, snapshot: last });
    for (let i = 0; i < 3; i++) history.update(snap(11));
    expect(history.retained.size).toBe(1);
    history.update(snap(12));
    expect(history.retained.size).toBe(0);
    // Returning to the retained frame number cannot revive it.
    history.update(snap(12));
    expect(history.retained.size).toBe(0);
  });

  it('drops a building first missed under its last frame number when the next publication skips a frame', () => {
    const history = new BuildingVisualHistory();
    history.update(snap(10, [building]));
    history.update(snap(10));
    expect(history.retained.size).toBe(1);
    history.update(snap(12));
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

describe('delivery image presentation frame', () => {
  const factory = (unloading?: 'door' | 'roof'): LiveObject => ({ ...building, health: 1, unloading });

  it('shows the delivery image one logic frame after the state, at both ends', () => {
    // Frozen GAWEAP pairs at one-frame steps: the state entered Unload in a mid-tick publication of frame 8711 and
    // left it at the 8835 stop; the native picture changed at the following counter stops.
    const history = new BuildingVisualHistory();
    const shown = (frame: number, object: LiveObject) => {
      history.update(snap(frame, [object]));
      return history.shownUnloading(object, frame);
    };
    expect(shown(10, factory())).toBeUndefined();
    expect(shown(11, factory())).toBeUndefined();
    // The change is first published under the old frame number: nothing changes in that frame ...
    expect(shown(11, factory('door'))).toBeUndefined();
    // ... nor in the next one, whose predecessor's first publication was still closed.
    expect(shown(12, factory('door'))).toBeUndefined();
    expect(shown(12, factory('door'))).toBeUndefined();
    expect(shown(13, factory('door'))).toBe('door');
    expect(shown(14, factory('door'))).toBe('door');
    // Closing: the first publication of frame 15 already lacks the state; the image stays for that frame.
    expect(shown(15, factory())).toBe('door');
    expect(shown(15, factory())).toBe('door');
    expect(shown(16, factory())).toBeUndefined();
  });

  it('follows a change that is first published with a new frame number one frame later', () => {
    const history = new BuildingVisualHistory();
    const shown = (frame: number, object: LiveObject) => {
      history.update(snap(frame, [object]));
      return history.shownUnloading(object, frame);
    };
    expect(shown(10, factory())).toBeUndefined();
    expect(shown(11, factory('roof'))).toBeUndefined();
    expect(shown(12, factory('roof'))).toBe('roof');
    expect(shown(13, factory())).toBe('roof');
    expect(shown(14, factory())).toBeUndefined();
  });

  it('draws the current state without an observation of exactly the previous frame', () => {
    const history = new BuildingVisualHistory();
    // First sighting.
    history.update(snap(10, [factory('door')]));
    expect(history.shownUnloading(factory('door'), 10)).toBe('door');
    // Frame gap.
    history.update(snap(13, [factory()]));
    expect(history.shownUnloading(factory(), 13)).toBeUndefined();
    // A frame other than the newest observed one, and an unknown building.
    expect(history.shownUnloading(factory('roof'), 12)).toBe('roof');
    expect(history.shownUnloading({ ...factory('door'), uid: 9 }, 13)).toBe('door');
    // Rollback forgets every observation.
    history.update(snap(14, [factory('door')]));
    history.update(snap(9, [factory('door')]));
    expect(history.shownUnloading(factory('door'), 9)).toBe('door');
    history.update(snap(10, [factory()]));
    expect(history.shownUnloading(factory(), 10)).toBe('door');
  });

  it('keeps the lagged image of a vanished building while its last visual is retained, then forgets it', () => {
    const history = new BuildingVisualHistory();
    history.update(snap(10, [factory()]));
    history.update(snap(11, [factory('door')]));
    history.update(snap(12));
    const last = history.retained.get(1)!;
    expect(last.snapshot.frame).toBe(11);
    expect(history.shownUnloading(last.object, last.snapshot.frame)).toBeUndefined();
    history.update(snap(13));
    // A new building with the same UID starts without history.
    history.update(snap(14, [factory('door')]));
    expect(history.shownUnloading(factory('door'), 14)).toBe('door');
  });
});
