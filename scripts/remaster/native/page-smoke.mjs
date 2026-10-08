#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { appendFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createPageHarness } from './page-harness.mjs';
import { outputDirectory, writePng } from './artifacts.mjs';
import { observePageCombat, focusPageCombat } from './page-battle-input.mjs';

const { values: o } = parseArgs({
  options: {
    url: { type: 'string', default: process.env.RA2_NATIVE_AGENT_URL || 'ws://127.0.0.1:15450' },
    token: { type: 'string', default: process.env.RA2_NATIVE_AGENT_TOKEN },
    origin: { type: 'string', default: process.env.RA2_NATIVE_AGENT_ORIGIN || 'http://127.0.0.1:15451' },
    seconds: { type: 'string', default: '60' },
    warmup: { type: 'string', default: '15' },
    passthrough: { type: 'string', default: '7' },
    'poll-clock': { type: 'string', default: 'timer' },
    'display-hz': { type: 'string', default: '60' },
    'wait-fighting': { type: 'string', default: '0' },
    battle: { type: 'boolean', default: false },
    out: { type: 'string' },
    help: { type: 'boolean' },
  },
});
if (o.help) {
  console.log(
    'page-smoke.mjs [--seconds 60 --warmup 15 --passthrough 7] [--battle] [--wait-fighting 120] [--display-hz 1 --poll-clock timer|display]\nReal Worker controller/NativeCore/VmShell path; 60 Hz maximum polls, 1 Hz game counters, presenter picture ACK. display reproduces drawing-bound polling; timer models the independent native scheduler. No browser/GPU/art acceptance.',
  );
  process.exit(0);
}
if (!o.token) throw new Error('Supply RA2_NATIVE_AGENT_TOKEN');
if (!['timer', 'display'].includes(o['poll-clock'])) throw new Error('Invalid poll-clock');
o.displayHz = Number(o['display-hz']);
if (!Number.isFinite(o.displayHz) || o.displayHz < 1 || o.displayHz > 240) throw new Error('Invalid display-hz');
o.waitFighting = Number(o['wait-fighting']);
if (!Number.isFinite(o.waitFighting) || o.waitFighting < 0 || o.waitFighting > 300)
  throw new Error('Invalid wait-fighting');
for (const key of ['seconds', 'warmup', 'passthrough']) {
  o[key] = Number(o[key]);
  if (!Number.isFinite(o[key]) || o[key] < 0 || o[key] > (key === 'passthrough' ? 7 : 300))
    throw new Error(`Invalid ${key}`);
}
const out = outputDirectory(o.out),
  stamp = new Date().toISOString().replaceAll(':', '-');
const reportPath = resolve(out, `page-smoke-${stamp}.json`);
const started = performance.now();
const timeline = {},
  states = [],
  performances = [],
  statuses = [],
  captures = [],
  combatDiagnostics = [],
  observations = new Set();
let harness,
  latestPicture,
  latestState,
  previousState,
  lastDistinctAt,
  failure,
  battle,
  summary,
  combatFocus,
  focusPending,
  metricsBefore,
  battlePending;
let polling = false,
  perfPolling = false,
  running = true,
  passthroughPending;
let lastPoll = -Infinity,
  lastPerf = -Infinity,
  firstStateAt,
  measuredAt,
  finishedAt;
let pictures = 0,
  polls = 0,
  unchanged = 0,
  nulls = 0;
const capture = async (label) => {
  if (!latestPicture?.rgb565) throw new Error('No delivered native picture');
  const path = resolve(out, `page-${stamp}-${label}.png`);
  writePng(path, {
    ...latestPicture,
    pixels: Buffer.from(latestPicture.rgb565.buffer, latestPicture.rgb565.byteOffset, latestPicture.rgb565.byteLength),
  });
  captures.push(path);
  return path;
};
const sinceStart = () => (performance.now() - started) / 1000;
try {
  harness = await createPageHarness(o, {
    onStatus: (status) => {
      statuses.push({ ...status, seconds: sinceStart() });
      if (status.phase === 'error') failure ??= new Error(status.detail);
    },
    onFrame: (frame) => {
      latestPicture = frame;
      pictures++;
      timeline.firstPictureSeconds ??= sinceStart();
      if (
        timeline.passthroughAcceptedSeconds !== undefined &&
        timeline.firstKeyedPictureSeconds === undefined &&
        frame.rgb565
      ) {
        let keyed = 0,
          sampled = 0;
        for (let y = 24; y < frame.height - 40; y += 16)
          for (let x = 24; x < frame.width - 168; x += 16) {
            sampled++;
            if (frame.rgb565[y * frame.width + x] === 0xf81f) keyed++;
          }
        if (sampled && keyed / sampled > 0.5) {
          timeline.firstKeyedPictureSeconds = sinceStart();
          timeline.keyedTacticalFraction = keyed / sampled;
        }
      }
    },
  });
  timeline.attachSeconds = sinceStart();
  await harness.vm.start();
  timeline.runningSeconds = sinceStart();
  const hello = await harness.hello();
  const beganCounter = await harness.readBytes(0xa8ed84, 4);
  await delay(500);
  const endCounter = await harness.readBytes(0xa8ed84, 4);
  if (
    (await harness.getInputState().then((state) => state.modal)) ||
    Buffer.from(endCounter).readUInt32LE() <= Buffer.from(beganCounter).readUInt32LE()
  )
    throw new Error('Requires an advancing live match');
  const renderPoll = async () => {
    polling = true;
    lastPoll = performance.now();
    try {
      const state = await harness.vm.getRenderState();
      polls++;
      latestState = state;
      const deliveredAt = performance.now();
      if (!state?.map) {
        nulls++;
        return;
      }
      if (firstStateAt === undefined) {
        firstStateAt = deliveredAt;
        timeline.firstStateSeconds = sinceStart();
        timeline.firstStateFrame = state.frame;
        if (!o.waitFighting) measuredAt = deliveredAt + o.warmup * 1000;
        timeline.passthroughRequestedSeconds = sinceStart();
        passthroughPending = harness.vm
          .setTacticalPassthrough(o.passthrough)
          .then((accepted) => {
            timeline.passthroughAccepted = accepted;
            timeline.passthroughAcceptedSeconds = sinceStart();
          })
          .catch((error) => {
            failure ??= error;
          });
      }
      if (state === previousState) {
        unchanged++;
        return;
      }
      const record = {
        seconds: (deliveredAt - started) / 1000,
        frame: state.frame,
        intervalMs: lastDistinctAt === undefined ? null : deliveredAt - lastDistinctAt,
        objects: state.objects.length,
        effects: state.effects?.bullets?.length ?? 0,
        view: state.view,
        measured: measuredAt !== undefined && deliveredAt >= measuredAt,
        ...(combatFocus?.met && { combat: observePageCombat(state, combatFocus.zFactor) }),
      };
      states.push(record);
      lastDistinctAt = deliveredAt;
      previousState = state;
      const observation = harness
        .readBytes(0xa8ed84, 4)
        .then((bytes) => {
          record.counter = Buffer.from(bytes).readUInt32LE();
          record.behind = (record.counter - state.frame) >>> 0;
          record.counterObservedAfterMs = performance.now() - deliveredAt;
        })
        .catch((error) => {
          failure ??= error;
        })
        .finally(() => {
          observations.delete(observation);
        });
      observations.add(observation);
    } catch (error) {
      failure ??= error;
    } finally {
      polling = false;
    }
  };
  while (running) {
    const now = performance.now();
    if (failure) throw failure;
    if (firstStateAt === undefined && now - started > 30000) throw new Error('No first state within 30 s');
    if (measuredAt !== undefined && now >= measuredAt + o.seconds * 1000) break;
    if (measuredAt !== undefined && now >= measuredAt && metricsBefore === undefined)
      metricsBefore = await harness.observe('metrics');
    if (!polling && now - lastPoll >= Math.max(1000 / 60, o['poll-clock'] === 'display' ? 1000 / o.displayHz : 0))
      void renderPoll();
    if (!perfPolling && now - lastPerf >= 1000) {
      lastPerf = now;
      perfPolling = true;
      void harness.vm
        .getGamePerformance()
        .then(async (value) => {
          performances.push({ seconds: sinceStart(), value });
          if (o.waitFighting && latestState?.map) {
            const diagnostic = await harness.observe('combat').catch((error) => ({ error: error.message }));
            combatDiagnostics.push({ seconds: sinceStart(), ...diagnostic });
          }
          console.log(
            JSON.stringify({ seconds: sinceStart(), frame: latestState?.frame, distinct: states.length, polls, value }),
          );
          void writeFile(
            `${reportPath}.progress.json`,
            JSON.stringify({
              seconds: sinceStart(),
              frame: latestState?.frame,
              distinct: states.length,
              timeline,
              measuring: measuredAt !== undefined && performance.now() >= measuredAt,
              battleMet: battle?.met,
              combatFocusMet: combatFocus?.met,
              combatDiagnostic: combatDiagnostics.at(-1),
              value,
            }),
          ).catch((error) => {
            failure ??= error;
          });
        })
        .catch((error) => {
          failure ??= error;
        })
        .finally(() => {
          perfPolling = false;
        });
    }
    if (o.battle && firstStateAt !== undefined && timeline.passthroughAccepted && !battlePending) {
      const { runPageBattleInput } = await import('./page-battle-input.mjs');
      battlePending = runPageBattleInput({
        vm: harness.vm,
        readBytes: harness.readBytes,
        getInputState: harness.getInputState,
        capture,
        hello,
      });
      battlePending
        .then((result) => {
          battle = result;
          if (!result.met) failure ??= new Error(`Battle input acceptance failed: ${result.error}`);
        })
        .catch((error) => {
          failure ??= error;
        });
    }
    if (
      o.waitFighting &&
      firstStateAt !== undefined &&
      timeline.passthroughAccepted &&
      !focusPending &&
      (!o.battle || battle?.met)
    ) {
      focusPending = focusPageCombat({
        vm: harness.vm,
        readBytes: harness.readBytes,
        getLatestRenderState: () => latestState,
        seconds: o.waitFighting,
      });
      focusPending
        .then((result) => {
          combatFocus = result;
          if (!result.met) failure ??= new Error('No genuine visible fighting scene within wait window');
          else measuredAt = performance.now() + o.warmup * 1000;
        })
        .catch((error) => {
          failure ??= error;
        });
    }
    await delay(1);
  }
  running = false;
  while (polling || perfPolling) await delay(2);
  await Promise.all(observations);
  await passthroughPending;
  if (battlePending) await battlePending;
  if (focusPending) await focusPending;
  finishedAt = performance.now();
  await capture('last');
} catch (error) {
  failure ??= error;
} finally {
  running = false;
  finishedAt ??= performance.now();
  await Promise.allSettled([passthroughPending, battlePending, focusPending].filter(Boolean));
  while (polling || perfPolling) await delay(2);
  await Promise.all(observations);
  const metrics = harness ? await harness.observe('metrics').catch((error) => ({ error: error.message })) : null;
  if (metrics?.trace?.firstCreditAt !== undefined)
    timeline.firstPictureCreditSeconds = (metrics.trace.firstCreditAt - started) / 1000;
  const sync =
    metricsBefore && metrics
      ? {
          misses: metrics.misses - metricsBefore.misses,
          complete: metrics.trace.mirrors.complete - metricsBefore.trace.mirrors.complete,
          incomplete: metrics.trace.mirrors.incomplete - metricsBefore.trace.mirrors.incomplete,
          invalid: metrics.trace.mirrors.invalid - metricsBefore.trace.mirrors.invalid,
          truncated: metrics.trace.mirrors.truncated - metricsBefore.trace.mirrors.truncated,
        }
      : null;
  const cpuByFrame = new Map();
  for (const record of metrics?.trace?.readerCpu ?? []) {
    if (measuredAt === undefined || record.at < measuredAt || record.at > finishedAt) continue;
    cpuByFrame.set(record.frame, (cpuByFrame.get(record.frame) ?? 0) + record.ms);
  }
  const cpu = [...cpuByFrame.values()].sort((a, b) => a - b);
  const readerCpu = {
    count: cpu.length,
    meanMs: cpu.length ? cpu.reduce((sum, ms) => sum + ms, 0) / cpu.length : null,
    p95Ms: cpu[Math.ceil(cpu.length * 0.95) - 1] ?? null,
    maxMs: cpu.at(-1) ?? null,
    definition:
      'Unchanged synchronous reader factories/decoders by mirrored frame, excludes IO waits and independent observers.',
  };
  const measured = states.filter((state) => state.measured),
    intervals = measured
      .map((state) => state.intervalMs)
      .filter((value) => value !== null)
      .sort((a, b) => a - b);
  const quantile = (p) => (intervals.length ? intervals[Math.ceil(intervals.length * p) - 1] : null);
  const seconds = measuredAt === undefined ? 0 : Math.max(0, (finishedAt - measuredAt) / 1000);
  const terminalGap = lastDistinctAt === undefined ? null : finishedAt - lastDistinctAt;
  summary = {
    mode: 'real-worker-vmshell-page-poll',
    pollClock: o['poll-clock'],
    displayHz: o.displayHz,
    timeline,
    durationSeconds: seconds,
    polls,
    unchanged,
    nulls,
    pictures,
    delivered: measured.length,
    deliveredPerSecond: seconds ? measured.length / seconds : 0,
    intervalsMs: { p50: quantile(0.5), p95: quantile(0.95), p99: quantile(0.99), max: intervals.at(-1) ?? null },
    behindMax: measured.length ? Math.max(...measured.map((state) => state.behind)) : null,
    terminalGapMs: terminalGap,
    lagDefinition:
      'Counter read after actual client delivery; conservative lag upper bound, observation latency reported per state; observation does not block page polls.',
    metrics,
    measuredSync: sync,
    readerCpu,
    combatFocus,
    combatDiagnostics,
    fightingInViewStates: measured.filter((state) => state.combat?.inView > 0).length,
    wireCounts: harness?.wireCounts,
    performances,
    statuses,
    states,
    battle,
    captures,
    error: failure?.stack ?? null,
  };
  summary.gates = {
    duration60: seconds >= 60,
    distinct55: summary.deliveredPerSecond >= 55,
    p99under50: quantile(0.99) !== null && quantile(0.99) <= 50,
    noGap150: intervals.length > 0 && intervals.at(-1) <= 150 && terminalGap <= 150,
    atMost2Behind: summary.behindMax !== null && summary.behindMax <= 2,
    sync: sync ? sync.misses === 0 && sync.incomplete === 0 && sync.invalid === 0 && sync.truncated === 0 : false,
    battle: o.battle ? !!battle?.met : 'NOT RUN',
    fightingInView: o.waitFighting
      ? !!combatFocus?.met && measured.some((state) => state.combat?.inView > 0)
      : 'NOT RUN',
  };
  try {
    await harness?.destroy();
  } catch (error) {
    summary.stopError = String(error.stack || error);
    failure ??= error;
  }
  await writeFile(reportPath, JSON.stringify(summary, null, 2));
  console.log(JSON.stringify({ reportPath, ...summary, states: undefined, performances: undefined }, null, 2));
  await appendFile(
    resolve(out, 'NOTES.md'),
    `\nPhase 4 page harness ${stamp}: ${summary.delivered}/${seconds.toFixed(3)} s = ${summary.deliveredPerSecond.toFixed(3)} distinct/s; intervals ${JSON.stringify(summary.intervalsMs)}; lag max ${summary.behindMax}; timeline ${JSON.stringify(timeline)}; gates ${JSON.stringify(summary.gates)}; error ${failure?.message ?? 'none'}. Report ${reportPath}.\n`,
  );
}
process.exitCode =
  failure || !Object.values(summary.gates).every((pass) => pass === true || pass === 'NOT RUN') ? 1 : 0;
