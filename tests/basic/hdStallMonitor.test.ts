import { describe, expect, it, vi } from 'vitest';
import type { StallSendResult } from '../../src/utils/stallRecorder';
import {
  stallLogRecord,
  startHdStallMonitor,
  type HdStallActivity,
  type HdStallMatch,
} from '../../src/ui/pages/game/hdStallMonitor';

const IDLE: HdStallActivity = {
  pageUploads: 0,
  voxelMeshes: 0,
  loadingArt: 0,
  shaders: 0,
  pipelines: 0,
  newKinds: [],
  logicFps: 20.4,
};

/** The monitor on a manual clock, with the browser's pieces replaced: visibility, long tasks, the two senders. */
function monitor(options: { longTasks?: boolean; endpoint?: string | null } = {}) {
  vi.useFakeTimers();
  let clock = 0;
  let visible = true;
  const match: HdStallMatch = { map: 'xmp29u2', frame: 120, shown: true };
  let activity: HdStallActivity | null = { ...IDLE };
  let visibility: (visible: boolean) => void = () => undefined;
  /** Long tasks the browser has observed but not reported yet. */
  const unreported: [number, number][] = [];
  let report: (start: number, duration: number) => void = () => undefined;
  const posted: { url: string; records: Record<string, unknown>[] }[] = [];
  const beacons: { url: string; records: Record<string, unknown>[] }[] = [];
  const answers: StallSendResult[] = [];
  const publish = vi.fn();
  const stop = vi.fn();
  const unsubscribe = vi.fn();
  const stalls = startHdStallMonitor({
    endpoint: options.endpoint,
    match: () => ({ ...match }),
    activity: () => activity,
    publish,
    environment: {
      now: () => clock,
      visible: () => visible,
      onVisibility(listener) {
        visibility = listener;
        return unsubscribe;
      },
      longTasks:
        options.longTasks === false
          ? () => null
          : (callback) => {
              report = callback;
              return {
                flush: () => unreported.splice(0).forEach(([start, duration]) => callback(start, duration)),
                stop,
              };
            },
      post: async (url, body) => {
        posted.push({ url, records: JSON.parse(body) });
        return answers.shift() ?? true;
      },
      beacon: (url, body) => {
        beacons.push({ url, records: JSON.parse(body) });
        return true;
      },
    },
  });
  /** Present a frame `ms` after the last one. */
  const frame = (ms: number) => stalls.frame((clock += ms));
  /** Time passes with the loop running smoothly (a frame every 16 ms); timers that come due run. */
  const pass = async (ms: number) => {
    for (let left = ms; left > 0; left -= 16) stalls.frame((clock += Math.min(16, left)));
    await vi.advanceTimersByTimeAsync(ms);
  };
  return {
    stalls,
    frame,
    pass,
    match,
    publish,
    posted,
    beacons,
    answers,
    unreported,
    stop,
    unsubscribe,
    report: (start: number, duration: number) => report(start, duration),
    setActivity: (next: HdStallActivity | null) => (activity = next),
    setVisible(next: boolean) {
      visible = next;
      visibility(next);
    },
    clock: () => clock,
    end() {
      stalls.dispose();
      vi.useRealTimers();
    },
  };
}

describe('HD page stall monitor: what a record says', () => {
  it('keeps local stall evidence without HTTP or beacon when endpoint is null', async () => {
    const m = monitor({ endpoint: null });
    m.frame(0);
    m.frame(151);
    expect(m.stalls.entries()).toHaveLength(1);
    expect(m.publish).toHaveBeenLastCalledWith(1, 151);
    await m.pass(5000);
    m.setVisible(false);
    expect(m.posted).toHaveLength(0);
    expect(m.beacons).toHaveLength(0);
    expect(m.stalls.entries()).toHaveLength(1);
    m.end();
  });
  it('records a late frame with the match, the view and what the view was building', () => {
    const m = monitor();
    m.frame(0);
    m.frame(16);
    m.frame(17);
    expect(m.stalls.entries()).toEqual([]);
    m.setActivity({ ...IDLE, pageUploads: 2, loadingArt: 3, shaders: 6, pipelines: 3, newKinds: ['building:NAREFN'] });
    m.frame(151);
    const [entry] = m.stalls.entries();
    expect(entry).toMatchObject({ seq: 1, gapMs: 151, from: 33, to: 184 });
    expect(entry!.context).toMatchObject({
      map: 'xmp29u2',
      frame: 120,
      shown: true,
      visible: true,
      hiddenInGap: false,
      activity: { pageUploads: 2, loadingArt: 3, shaders: 6, pipelines: 3, newKinds: ['building:NAREFN'] },
    });
    // What the log gets: flat, rounded, with the wall-clock time and without the loop's own clock.
    const record = stallLogRecord(entry!);
    expect(record).toMatchObject({
      seq: 1,
      gapMs: 151,
      visible: true,
      hiddenInGap: false,
      map: 'xmp29u2',
      logicFrame: 120,
      hdShown: true,
      logicFps: 20.4,
      pageUploads: 2,
      voxelMeshes: 0,
      loadingArt: 3,
      shaders: 6,
      pipelines: 3,
      newKinds: ['building:NAREFN'],
    });
    expect(typeof record.time).toBe('string');
    expect(new Date(record.time as string).getTime()).toBe(entry!.at);
    expect(record).not.toHaveProperty('from');
    m.end();
  });

  it('records outside a battle and without a view, with nulls for what is not known', () => {
    const m = monitor();
    Object.assign(m.match, { map: null, frame: 0, shown: false });
    m.setActivity(null);
    m.frame(0);
    m.frame(900);
    const record = stallLogRecord(m.stalls.entries()[0]!);
    expect(record).toMatchObject({ map: null, logicFrame: 0, hdShown: false, logicFps: null });
    expect(record).not.toHaveProperty('pageUploads');
    m.end();
  });

  it("tells a stall of the page's own thread from a frame that was not delivered", () => {
    const m = monitor();
    m.frame(0);
    // 400 ms gap, 320 ms of it under a long task the browser has not reported yet.
    m.unreported.push([40, 320]);
    m.frame(400);
    expect(m.stalls.entries()[0]!.context).toMatchObject({ mainThreadMs: 320, cause: 'main-thread' });
    // 600 ms gap with one short task: the page's thread was idle, the frame did not come.
    m.frame(16);
    m.unreported.push([500, 60]);
    m.frame(600);
    expect(m.stalls.entries()[1]!.context).toMatchObject({ mainThreadMs: 60, cause: 'not-delivered' });
    // Exactly half counts as the page's own.
    m.frame(16);
    m.report(1100, 100);
    m.frame(200);
    expect(m.stalls.entries()[2]!.context).toMatchObject({ mainThreadMs: 100, cause: 'main-thread' });
    m.end();
  });

  it('says so when the browser reports no long tasks', () => {
    const m = monitor({ longTasks: false });
    m.frame(0);
    m.frame(500);
    expect(m.stalls.entries()[0]!.context).toMatchObject({ mainThreadMs: null, cause: 'unknown' });
    m.end();
  });

  it('marks a gap the tab was hidden in, whatever else happened in it', () => {
    const m = monitor();
    m.frame(0);
    m.frame(16);
    m.setVisible(false);
    // Frames stop while the tab is hidden; thirty seconds later the player is back.
    m.setVisible(true);
    m.unreported.push([20, 400]);
    m.frame(30_000);
    expect(m.stalls.entries()[0]!.context).toMatchObject({ visible: true, hiddenInGap: true, cause: 'hidden' });
    // The next late frame is an ordinary stall again.
    m.frame(300);
    expect(m.stalls.entries()[1]!.context).toMatchObject({ hiddenInGap: false, cause: 'not-delivered' });
    // A frame presented while the tab is not visible (a throttled background tab) is marked as well.
    m.setVisible(false);
    m.frame(1000);
    expect(m.stalls.entries()[2]!.context).toMatchObject({ visible: false, hiddenInGap: true, cause: 'hidden' });
    m.end();
  });
});

describe('HD page stall monitor: the count of the match', () => {
  it('counts the stalls of a running match with the tab on screen, and the longest of them', () => {
    const m = monitor();
    m.frame(0);
    m.frame(200);
    expect(m.publish).toHaveBeenLastCalledWith(1, 200);
    m.frame(16);
    m.frame(1730);
    expect(m.publish).toHaveBeenLastCalledWith(2, 1730);
    m.frame(16);
    m.frame(400);
    expect(m.publish).toHaveBeenLastCalledWith(3, 1730);
    // Not a stutter of the match: the loading screen, the menus, a tab that was hidden.
    Object.assign(m.match, { frame: 0 });
    m.frame(5000);
    Object.assign(m.match, { map: null, frame: 77 });
    m.frame(5000);
    Object.assign(m.match, { map: 'xmp29u2', frame: 300 });
    m.setVisible(false);
    m.setVisible(true);
    m.frame(9000);
    expect(m.publish).toHaveBeenCalledTimes(3);
    // Every one of them is recorded all the same.
    expect(m.stalls.entries()).toHaveLength(6);
    m.end();
  });

  it('starts over with another match', () => {
    const m = monitor();
    m.frame(0);
    m.frame(700);
    m.stalls.newMatch();
    expect(m.publish).toHaveBeenLastCalledWith(0, 0);
    m.frame(16);
    m.frame(250);
    expect(m.publish).toHaveBeenLastCalledWith(1, 250);
    // The records of the earlier match stay in the ring.
    expect(m.stalls.entries()).toHaveLength(2);
    m.end();
  });
});

describe('HD page stall monitor: the development server sink', () => {
  it('posts new records in batches, at most every five seconds, and nothing while the page is smooth', async () => {
    const m = monitor();
    m.frame(0);
    m.frame(300);
    expect(m.posted).toEqual([]);
    await m.pass(0);
    expect(m.posted).toHaveLength(1);
    expect(m.posted[0]!.url).toBe('/__perf/stalls');
    expect(m.posted[0]!.records).toMatchObject([{ seq: 1, gapMs: 300, map: 'xmp29u2' }]);
    m.frame(16);
    m.frame(500);
    m.frame(16);
    m.frame(900);
    await m.pass(3000);
    expect(m.posted).toHaveLength(1);
    await m.pass(2000);
    expect(m.posted).toHaveLength(2);
    expect(m.posted[1]!.records.map((record) => record.seq)).toEqual([2, 3]);
    for (let i = 0; i < 600; i++) m.frame(16);
    await m.pass(60_000);
    expect(m.posted).toHaveLength(2);
    m.end();
  });

  it('settles the cause before sending: a long task reported after the late frame still counts', async () => {
    const m = monitor();
    m.frame(0);
    m.frame(800);
    expect(m.stalls.entries()[0]!.context.cause).toBe('not-delivered');
    // The browser reports the task that held the thread only now.
    m.report(100, 650);
    await m.pass(0);
    expect(m.posted[0]!.records[0]).toMatchObject({ cause: 'main-thread', mainThreadMs: 650 });
    m.end();
  });

  it('stops posting to a server that has no log, and keeps recording', async () => {
    const m = monitor();
    m.answers.push('gone');
    m.frame(0);
    m.frame(300);
    await m.pass(0);
    expect(m.posted).toHaveLength(1);
    m.frame(16);
    m.frame(300);
    await m.pass(20_000);
    expect(m.posted).toHaveLength(1);
    expect(m.stalls.entries()).toHaveLength(2);
    expect(m.publish).toHaveBeenLastCalledWith(2, 300);
    // And nothing is handed over when the page goes away.
    m.setVisible(false);
    expect(m.beacons).toEqual([]);
    m.end();
  });

  it('hands what is unsent to the browser when the tab is hidden or the page goes away', async () => {
    const m = monitor();
    m.frame(0);
    m.frame(300);
    await m.pass(0);
    m.frame(16);
    m.frame(450);
    // Inside the five seconds: not posted yet. The tab is hidden.
    m.setVisible(false);
    expect(m.beacons).toHaveLength(1);
    expect(m.beacons[0]!.url).toBe('/__perf/stalls');
    expect(m.beacons[0]!.records.map((record) => record.seq)).toEqual([2]);
    // Handed over once: the timer that was armed finds nothing left.
    await m.pass(10_000);
    expect(m.posted).toHaveLength(1);
    m.setVisible(false);
    expect(m.beacons).toHaveLength(1);
    m.end();
  });

  it('releases its observer, listener and timer when it is disposed', async () => {
    const m = monitor();
    m.frame(0);
    m.frame(300);
    m.stalls.dispose();
    expect(m.stop).toHaveBeenCalledTimes(1);
    expect(m.unsubscribe).toHaveBeenCalledTimes(1);
    await m.pass(10_000);
    expect(m.posted).toEqual([]);
    m.end();
  });
});
