/**
 * Summarize g0LateGame.mts outputs: every measurement window plus a 30-second bucket view of the whole timeline.
 * Usage: pnpm exec tsx scripts/remaster/perf/g0Summarize.mts <run.json> [...]
 */
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

type Entry = {
  t: number;
  phase: string;
  perf: { logicFps: number | null; intervalMs: number | null; status: string; gameSpeed: number; frame: number } | null;
  counts: { mobile: number; building: number; techno: number; houses: { defeated: number }[] } | null;
  presentedFps: number | null;
};

for (const file of process.argv.slice(2)) {
  const run = JSON.parse(readFileSync(file, 'utf8')) as {
    config: Record<string, unknown>;
    outcome?: string;
    timeline: Entry[];
    windows?: Record<string, unknown>[];
    diagnostic?: { summary?: Record<string, unknown>; runtime?: unknown; renderer?: unknown } | null;
  };
  console.log(`\n== ${basename(file)}  outcome=${run.outcome}`);
  const buckets = new Map<number, Entry[]>();
  for (const entry of run.timeline) {
    const key = Math.floor(entry.t / 30) * 30;
    buckets.set(key, [...(buckets.get(key) ?? []), entry]);
  }
  console.log('  t(s)  phase        logicFps(avg/min/max)  presented(min/mean)  mobile  buildings  alive  speed');
  for (const [t, entries] of buckets) {
    const samples = entries.flatMap((entry) =>
      entry.perf?.status === 'sample' && entry.perf.intervalMs ? [entry.perf] : [],
    );
    const ms = samples.reduce((sum, sample) => sum + sample.intervalMs!, 0);
    const avg = ms ? samples.reduce((sum, sample) => sum + sample.logicFps! * sample.intervalMs!, 0) / ms : NaN;
    const fps = samples.map((sample) => sample.logicFps!);
    const presented = entries.flatMap((entry) => (entry.presentedFps === null ? [] : [entry.presentedFps]));
    const last = entries.at(-1)!;
    console.log(
      `  ${String(t).padStart(4)}  ${last.phase.padEnd(12)} ${avg.toFixed(1).padStart(6)} / ${Math.min(...fps).toFixed(0)} / ${Math.max(...fps).toFixed(0)}` +
        `        ${Math.min(...presented).toFixed(1)} / ${(presented.reduce((a, b) => a + b, 0) / presented.length).toFixed(1)}` +
        `      ${last.counts?.mobile ?? '-'}     ${last.counts?.building ?? '-'}      ${last.counts ? last.counts.houses.filter((house) => !house.defeated).length : '-'}     ${last.perf?.gameSpeed ?? '-'}`,
    );
  }
  for (const window of run.windows ?? []) {
    const { contention: _contention, lastCounts: _lastCounts, ...rest } = window;
    console.log('  window', JSON.stringify(rest));
  }
  if (run.diagnostic?.summary) console.log('  diagnostics', JSON.stringify(run.diagnostic.summary));
}
