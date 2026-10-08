#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { open, writeFile, appendFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { tsImport } from 'tsx/esm/api';
import WebSocket from 'ws';
import { outputDirectory, Recorder } from './artifacts.mjs';
const { values: o } = parseArgs({
  options: {
    url: { type: 'string', default: process.env.RA2_NATIVE_AGENT_URL || 'ws://127.0.0.1:15450' },
    token: { type: 'string', default: process.env.RA2_NATIVE_AGENT_TOKEN },
    origin: { type: 'string', default: process.env.RA2_NATIVE_AGENT_ORIGIN || 'http://127.0.0.1:15451' },
    seconds: { type: 'string', default: '60' },
    warmup: { type: 'string', default: '15' },
    'wait-objects': { type: 'string', default: '60' },
    out: { type: 'string' },
    record: { type: 'boolean', default: false },
    'cpu-prof': { type: 'boolean', default: false },
    'direct-reader': { type: 'boolean', default: false },
    replay: { type: 'string' },
    help: { type: 'boolean' },
  },
});
if (o.help) {
  console.log(
    'node scripts/remaster/native/reader-smoke.mjs --token HEX [--seconds 60 --warmup 15 --record --out OUT]\nnode scripts/remaster/native/reader-smoke.mjs --replay OUT/recordings/session.nhrec\nLive default runs the page NativeCore render, command and performance readers. --direct-reader isolates the legacy reader path; --cpu-prof saves a Node CPU profile. Prints counts, misses and pure decoder/whole-core costs. The fixed warm-up precedes the measured interval. Recordings and JSON reports stay under gameres.',
  );
  process.exit(0);
}
if (o['cpu-prof']) {
  const child = spawnSync(
    process.execPath,
    [
      '--cpu-prof',
      `--cpu-prof-dir=${outputDirectory(o.out)}`,
      process.argv[1],
      ...process.argv.slice(2).filter((arg) => arg !== '--cpu-prof'),
    ],
    { stdio: 'inherit' },
  );
  if (child.error) throw child.error;
  process.exit(child.status ?? 1);
}
if (!Number.isFinite(+o.seconds) || +o.seconds <= 0 || +o.seconds > 3600) throw new Error('Invalid seconds');
if (!Number.isFinite(+o['wait-objects']) || +o['wait-objects'] < 0 || +o['wait-objects'] > 120)
  throw new Error('Invalid wait-objects');
if (!Number.isFinite(+o.warmup) || +o.warmup < 0 || +o.warmup > 300) throw new Error('Invalid warmup');
if (!o.replay && !o['direct-reader']) {
  const { runCoreReaderSmoke } = await import('./core-reader-smoke.mjs');
  const summary = await runCoreReaderSmoke(o);
  process.exit(Object.values(summary.gates).every((gate) => gate === true) ? 0 : 1);
}
const { NativeMirrorMemory, NativeMemoryMiss, NativeReaderWorkingSet } = await tsImport(
  '../../../src/adapter/native/memory.ts',
  import.meta.url,
);
const { NativeConnection } = await tsImport('../../../src/adapter/native/connection.ts', import.meta.url);
const {
  NativeMessageType: T,
  decodePacket,
  decodeMirror,
  decodeJson,
  encodeU32,
  encodeSubscription,
} = await tsImport('../../../src/adapter/native/protocol.ts', import.meta.url);
const { createYrNativeHostPolicy } = await tsImport('../../../src/games/yr/nativeHost.ts', import.meta.url);
const { createYrStateReader } = await tsImport('../../../src/games/yr/stateReader.ts', import.meta.url);
const out = outputDirectory(o.out),
  stamp = new Date().toISOString().replaceAll(':', '-'),
  memory = new NativeMirrorMemory();
let hello = null,
  policy = null,
  metadata = { gameThreadId: 0 },
  renderReader = null,
  rawReader = null,
  connection = null,
  recorder = null,
  renderPrevious = null;
let startedAt = performance.now(),
  lastPrint = startedAt,
  seen = 0,
  good = 0,
  missedFrames = 0,
  truncated = 0,
  equalities = 0,
  countMismatches = 0,
  missingDirect = 0,
  firstGood = null,
  latest = null,
  failure = null;
let readerMs = 0,
  readerCalls = 0,
  missesAtGood = null;
let measurementStart = null,
  measurementMs = 0,
  measurementCalls = 0,
  measuredGood = 0,
  measuredDirect = 0,
  measuredCountMismatches = 0,
  measuredMissingDirect = 0,
  measurementMisses = null,
  measurementTruncated = 0,
  measurementInvalid = 0,
  measurementPageTruncations = 0,
  measuredMinObjects = null,
  measuredMaxObjects = null,
  measuredReaderTimes = [],
  firstMeasuredFrame = null,
  lastMeasuredFrame = null,
  lastGoodAt = null,
  lastAdvancingAt = null,
  lastGoodLogicFrame = null,
  mirrorWork = Promise.resolve(),
  pictureTimer = null;
let dynamicRanges = [];
const learned = new NativeReaderWorkingSet();
const missObservations = [];
let coldReaderAt = null,
  coldReaderPending = true;
let subscribedKey = '';
const progressTimer = setInterval(
  () =>
    console.log(
      JSON.stringify(
        latest ?? {
          frame: memory.frame,
          status: 'WARMING UP',
          misses: memory.misses,
          readerMs: readerCalls ? readerMs / readerCalls : null,
        },
      ),
    ),
  1000,
);
const summary = {
  mode: o.replay ? 'replay' : 'live',
  hello: null,
  frames: 0,
  readerFrames: 0,
  warmupSeconds: null,
  requestedWarmupSeconds: +o.warmup,
  measurementSeconds: null,
  postWarmupMisses: null,
  directCountSamples: 0,
  countMismatches: 0,
  truncated: 0,
  readerMsPerFrame: null,
  gates: 'NOT RUN',
};
function rebuild() {
  renderReader = null;
  rawReader = null;
  coldReaderPending = true;
  policy = createYrNativeHostPolicy(memory, () => memory.accessor(), hello.exe.sha256, metadata);
}
function mergeRanges(ranges) {
  const sorted = ranges
      .filter((r) => r.length > 0)
      .map((r) => ({
        address: Math.floor(r.address / 4096) * 4096,
        length: Math.ceil(((r.address % 4096) + r.length) / 4096) * 4096,
      }))
      .sort((a, b) => a.address - b.address),
    result = [];
  for (const r of sorted) {
    const prev = result.at(-1);
    if (prev && r.address <= prev.address + prev.length)
      prev.length = Math.max(prev.address + prev.length, r.address + r.length) - prev.address;
    else result.push(r);
  }
  return result;
}
async function subscribe(extra = []) {
  if (!connection || !policy) return false;
  dynamicRanges = extra;
  learned.learn('reader', memory.missingRanges);
  const ranges = mergeRanges([...policy.ranges, ...dynamicRanges, ...learned.ranges]),
    key = JSON.stringify(ranges);
  if (key === subscribedKey) return false;
  await connection.request(
    T.Subscribe,
    encodeSubscription({
      ranges,
      rules: policy.rules,
      maxPages: hello.limits.pages,
      budgetUs: Math.min(12000, hello.limits.maxBudgetUs ?? 4000),
      sampleCount: 16,
      pageRemovals: hello.limits.pageRemovals === true,
    }),
  );
  subscribedKey = key;
  return true;
}
async function processUpdate(update) {
  const measured = measurementStart !== null;
  seen++;
  if (!memory.apply(update)) {
    truncated++;
    if (measured) {
      measurementTruncated++;
      if (update.flags & 4) measurementInvalid++;
      if (update.flags & 1) measurementPageTruncations++;
    }
    if (connection && update.flags & 4) {
      learned.clear();
      dynamicRanges = [];
      memory.reset();
      rebuild();
      subscribedKey = '';
      await subscribe();
    }
    return;
  }
  if (!policy) rebuild();
  memory.beginOperation();
  let readerBegin = null,
    elapsed = 0;
  let rendered = null,
    raw = null;
  try {
    const ranges = policy.additionalRanges?.() ?? [];
    if (await subscribe(ranges)) return;
    if (coldReaderAt === null || performance.now() - coldReaderAt >= 1000) {
      renderReader = rawReader = null;
      coldReaderPending = true;
    }
    readerBegin = performance.now();
    renderReader ??= policy.createRenderReader();
    rawReader ??= createYrStateReader(() => memory.accessor(), hello.exe.sha256);
    rendered = renderReader?.() ?? null;
    raw = rawReader?.({ includeLimbo: true }) ?? null;
  } catch (e) {
    if (!(e instanceof NativeMemoryMiss)) throw e;
  }
  if (readerBegin !== null) {
    elapsed = performance.now() - readerBegin;
    readerMs += elapsed;
    readerCalls++;
    if (measured) {
      measurementMs += elapsed;
      measurementCalls++;
      measuredReaderTimes.push(elapsed);
    }
  }
  if (memory.operationMissed) {
    missedFrames++;
    if (missObservations.length < 64)
      missObservations.push({
        frame: update.frame,
        measured,
        ranges: memory.missingRanges.slice(0, 32),
        readerHadResult: !!rendered,
      });
    rebuild();
    await subscribe(dynamicRanges);
    return;
  }
  if (!rendered || !raw) {
    latest = { frame: update.frame, status: 'NO BATTLE OR UNSUPPORTED READER', misses: memory.misses };
    return;
  }
  learned.complete('reader', memory, coldReaderPending);
  if (coldReaderPending) coldReaderAt = performance.now();
  coldReaderPending = false;
  good++;
  lastGoodAt = performance.now();
  if (lastGoodLogicFrame === null || lastGoodLogicFrame !== update.frame) lastAdvancingAt = lastGoodAt;
  lastGoodLogicFrame = update.frame;
  if (measured) {
    measuredGood++;
    firstMeasuredFrame ??= update.frame;
    lastMeasuredFrame = update.frame;
  }
  renderPrevious = rendered;
  if (firstGood === null) {
    firstGood = performance.now();
    missesAtGood = memory.misses;
  }
  const byKind = {};
  for (const obj of rendered.objects) byKind[obj.kind] = (byKind[obj.kind] ?? 0) + 1;
  const sample = update.samples.find((s) => s.address === 0xa8ec88 && s.bytes.length === 4);
  if (sample) {
    const own = new DataView(sample.bytes.buffer, sample.bytes.byteOffset, 4).getUint32(0, true);
    equalities++;
    if (raw.objects.length !== own) countMismatches++;
    if (measured) {
      measuredDirect++;
      if (raw.objects.length !== own) measuredCountMismatches++;
      measuredMinObjects = Math.min(measuredMinObjects ?? own, own);
      measuredMaxObjects = Math.max(measuredMaxObjects ?? own, own);
    }
    latest = {
      frame: update.frame,
      objects: byKind,
      rendered: rendered.objects.length,
      decodedIncludingLimbo: raw.objects.length,
      directTechnos: own,
      countsEqual: raw.objects.length === own,
      misses: memory.misses,
      readerMs: elapsed,
    };
  } else {
    missingDirect++;
    if (measured) measuredMissingDirect++;
    latest = {
      frame: update.frame,
      objects: byKind,
      rendered: rendered.objects.length,
      decodedIncludingLimbo: raw.objects.length,
      directTechnos: 'UNVERIFIED: no frame-thread sample',
      misses: memory.misses,
      readerMs: elapsed,
    };
  }
  if (performance.now() - lastPrint >= 1000) {
    console.log(JSON.stringify(latest));
    lastPrint = performance.now();
  }
  await subscribe(dynamicRanges);
}
async function replay(path) {
  const file = await open(path, 'r');
  let position = 0;
  async function exact(size, optional = false) {
    const b = Buffer.alloc(size);
    let at = 0;
    while (at < size) {
      const { bytesRead } = await file.read(b, at, size - at, position);
      if (!bytesRead) {
        if (optional && !at) return null;
        throw new Error('Truncated recording');
      }
      at += bytesRead;
      position += bytesRead;
    }
    return b;
  }
  try {
    if ((await exact(7)).toString() !== 'NHREC1\n') throw new Error('Invalid recording header');
    let h;
    while ((h = await exact(12, true)) !== null) {
      const len = h.readUInt32LE(8);
      if (len < 16 || len > 32 * 1024 * 1024 + 16) throw new Error('Recording packet bounds');
      const packet = decodePacket(await exact(len));
      if (packet.type === T.Hello) {
        hello = decodeJson(packet.payload);
        summary.hello = hello;
        rebuild();
      } else if (packet.type === T.Diagnostics) {
        const d = decodeJson(packet.payload);
        if (d.gameThreadId && d.frameHook) {
          metadata = { gameThreadId: d.gameThreadId, verifiedNativeHook: d.frameHook };
          if (hello) rebuild();
        }
      } else if (packet.type === T.Mirror) {
        if (!hello) throw new Error('Recording lacks hello');
        await processUpdate(decodeMirror(packet.payload));
        if (seen % 100 === 0) await delay(0);
      }
    }
  } finally {
    await file.close();
  }
}
function finalizeSummary() {
  summary.frames = seen;
  summary.readerFrames = good;
  summary.misses = memory.misses;
  summary.firstGoodSeconds = firstGood === null ? null : (firstGood - startedAt) / 1000;
  summary.warmupSeconds =
    measurementStart === null ? (o.replay ? summary.firstGoodSeconds : null) : (measurementStart - startedAt) / 1000;
  if (measurementStart !== null && summary.measurementSeconds === null)
    summary.measurementSeconds = (performance.now() - measurementStart) / 1000;
  summary.postWarmupMisses =
    measurementMisses === null
      ? o.replay && missesAtGood !== null
        ? memory.misses - missesAtGood
        : null
      : memory.misses - measurementMisses;
  summary.missedFrames = missedFrames;
  summary.directCountSamples = equalities;
  summary.missingDirectSamples = missingDirect;
  summary.countMismatches = countMismatches;
  summary.truncated = truncated;
  summary.readerMsPerFrame = readerCalls ? readerMs / readerCalls : null;
  summary.measuredReaderFrames = measuredGood;
  summary.measuredDirectCountSamples = measuredDirect;
  summary.measuredCountMismatches = measuredCountMismatches;
  summary.measuredMissingDirectSamples = measuredMissingDirect;
  summary.measuredTruncated = measurementTruncated;
  summary.measuredIncompleteUpdates = measurementTruncated;
  summary.measuredInvalidUpdates = measurementInvalid;
  summary.measuredPageTruncations = measurementPageTruncations;
  summary.measuredObjectRange = { min: measuredMinObjects, max: measuredMaxObjects };
  summary.measuredReaderMsPerFrame = measurementCalls ? measurementMs / measurementCalls : null;
  const sortedTimes = [...measuredReaderTimes].sort((a, b) => a - b);
  summary.measuredReaderP95Ms = sortedTimes.length ? sortedTimes[Math.ceil(sortedTimes.length * 0.95) - 1] : null;
  summary.measuredLogicFrames = firstMeasuredFrame === null ? 0 : (lastMeasuredFrame - firstMeasuredFrame) >>> 0;
  summary.last = latest;
  summary.lastGoodFrame = renderPrevious?.frame ?? null;
  summary.learnedPages = learned.ranges.reduce((n, range) => n + range.length / 4096, 0);
  summary.missObservations = missObservations;
  summary.gates = {
    objectCounts: o.replay
      ? equalities > 0 && countMismatches === 0 && missingDirect === 0
      : measuredDirect > 0 && measuredCountMismatches === 0 && measuredMissingDirect === 0,
    zeroMissesAfterWarmup: summary.postWarmupMisses === 0,
    completeFrames: o.replay ? truncated === 0 : measurementTruncated === 0,
    live: o.replay ? 'UNVERIFIED: replay is not a live gate' : measuredGood > 0 && summary.measuredLogicFrames > 0,
    objectRange: o.replay
      ? 'UNVERIFIED: replay is not a live gate'
      : measuredMinObjects >= 150 && measuredMaxObjects <= 250,
    sixtySeconds: o.replay ? 'UNVERIFIED: replay is not a live gate' : summary.measurementSeconds >= 60,
    errorFree: !summary.error,
  };
}
try {
  if (o.replay) {
    if (!resolve(o.replay).split(/[\\/]/).includes('gameres'))
      throw new Error('Private recordings must stay under gameres');
    await replay(o.replay);
  } else {
    if (!o.token) throw new Error('Supply a configured token');
    connection = new NativeConnection({
      url: o.url,
      token: o.token,
      createWebSocket: (url) => {
        const ws = new WebSocket(url, { origin: o.origin, maxPayload: 32 * 1024 * 1024 + 16 });
        if (o.record) {
          recorder ??= new Recorder(resolve(out, `recordings/reader-${stamp}.nhrec`));
          ws.on('message', (raw) => recorder.write(Buffer.from(raw)));
        }
        return ws;
      },
    });
    connection.onError((e) => {
      failure = e;
    });
    hello = await connection.connect();
    summary.hello = hello;
    if (!hello.exe.verified) throw new Error('Unsupported executable');
    const inputState = decodeJson(await connection.request(T.InputState));
    const before = await connection.read(0xa8ed84, 4);
    const beforeFrame = new DataView(before.bytes.buffer, before.bytes.byteOffset, 4).getUint32(0, true);
    if (inputState.modal) {
      summary.preflight = { inputState, beforeFrame, advancing: false };
      throw new Error('Native modal dialog is active; resume the real mission before reader measurement');
    }
    await delay(500);
    const after = await connection.read(0xa8ed84, 4);
    const afterFrame = new DataView(after.bytes.buffer, after.bytes.byteOffset, 4).getUint32(0, true);
    const advanced = (afterFrame - beforeFrame) >>> 0;
    summary.preflight = {
      inputState,
      beforeFrame,
      afterFrame,
      advanced,
      advancing: advanced > 0 && advanced < 0x80000000,
    };
    if (!summary.preflight.advancing)
      throw new Error('Real logic frame counter is not advancing before reader measurement');
    const objectDeadline = performance.now() + +o['wait-objects'] * 1000;
    let sceneObjects;
    do {
      const count = await connection.read(0xa8ec88, 4);
      sceneObjects = new DataView(count.bytes.buffer, count.bytes.byteOffset, 4).getUint32(0, true);
      if (sceneObjects >= 150 && sceneObjects <= 250) break;
      if (performance.now() >= objectDeadline) throw new Error(`Scene has ${sceneObjects} objects; requires 150-250`);
      await delay(500);
    } while (true);
    summary.preflight.sceneObjects = sceneObjects;
    startedAt = performance.now();
    rebuild();
    await subscribe();
    await connection.request(T.Sample, encodeU32(1, 0xa8ec88, 4));
    connection.onMirror((update) => {
      mirrorWork = mirrorWork
        .then(() => processUpdate(update))
        .catch((e) => {
          failure = e;
        })
        .finally(() => {
          try {
            connection.notify(T.Ack, encodeU32(update.frame));
          } catch (e) {
            failure ??= e;
          }
        });
    });
    await connection.request(T.Hook, encodeU32(1));
    connection.onPicture(() => {
      if (o.record)
        pictureTimer = setTimeout(() => {
          connection.request(T.Credit, encodeU32(1)).catch((e) => {
            failure = e;
          });
        }, 100);
    });
    if (o.record) await connection.request(T.Credit, encodeU32(1));
    const warmupUntil = performance.now() + +o.warmup * 1000;
    while (performance.now() < warmupUntil) {
      if (failure) throw failure;
      await delay(100);
    }
    await mirrorWork;
    if (!good) throw new Error('Reader produced no good frame during the fixed warm-up');
    measurementStart = performance.now();
    measurementMisses = memory.misses;
    summary.measurementDiagnosticsStart = decodeJson(await connection.request(T.Diagnostics));
    const until = measurementStart + +o.seconds * 1000;
    while (performance.now() < until) {
      if (failure) throw failure;
      if (lastGoodAt === null || performance.now() - lastGoodAt > 5000)
        throw new Error('No complete reader frame for five seconds during measurement');
      if (lastAdvancingAt === null || performance.now() - lastAdvancingAt > 5000)
        throw new Error('Reader frame counter stopped advancing for five seconds during measurement');
      await delay(100);
    }
    if (pictureTimer) clearTimeout(pictureTimer);
    await mirrorWork;
    summary.measurementSeconds = (performance.now() - measurementStart) / 1000;
    summary.diagnostics = decodeJson(await connection.request(T.Diagnostics));
  }
  finalizeSummary();
  if (!good || Object.values(summary.gates).some((gate) => gate === false)) process.exitCode = 1;
} catch (e) {
  summary.error = e.stack;
  process.exitCode = 1;
  console.error(e.message);
} finally {
  finalizeSummary();
  clearInterval(progressTimer);
  if (pictureTimer) clearTimeout(pictureTimer);
  try {
    if (connection && !summary.diagnostics) summary.diagnostics = decodeJson(await connection.request(T.Diagnostics));
  } catch (e) {
    summary.diagnosticsError = e.message;
  }
  try {
    if (connection) await connection.request(T.Hook, encodeU32(0));
  } catch (e) {
    summary.cleanupError = e.message;
    process.exitCode = 1;
  }
  connection?.dispose();
  recorder?.close();
  await writeFile(resolve(out, `reader-smoke-${stamp}.json`), JSON.stringify(summary, null, 2));
  await appendFile(resolve(out, 'NOTES.md'), `\n## Reader smoke ${stamp}\n\n${JSON.stringify(summary, null, 2)}\n`);
  console.log(JSON.stringify(summary, null, 2));
}
