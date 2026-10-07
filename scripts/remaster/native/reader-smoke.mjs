#!/usr/bin/env node
import { parseArgs } from 'node:util';
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
    out: { type: 'string' },
    record: { type: 'boolean', default: false },
    replay: { type: 'string' },
    help: { type: 'boolean' },
  },
});
if (o.help) {
  console.log(
    'node scripts/remaster/native/reader-smoke.mjs --token HEX [--seconds 60 --record --out OUT]\nnode scripts/remaster/native/reader-smoke.mjs --replay OUT/recordings/session.nhrec\nRuns the existing YR render reader, prints counts by kind, misses and reader time. Recordings and JSON reports stay under gameres.',
  );
  process.exit(0);
}
if (!Number.isFinite(+o.seconds) || +o.seconds <= 0 || +o.seconds > 3600) throw new Error('Invalid seconds');
const { NativeMirrorMemory, NativeMemoryMiss } = await tsImport(
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
let dynamicRanges = [];
const learned = new Map();
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
  for (const r of memory.missingRanges) learned.set(r.address, r);
  const ranges = mergeRanges([...policy.ranges, ...dynamicRanges, ...learned.values()]),
    key = JSON.stringify(ranges);
  if (key === subscribedKey) return false;
  await connection.request(
    T.Subscribe,
    encodeSubscription({ ranges, rules: policy.rules, maxPages: hello.limits.pages, budgetUs: 4000, sampleCount: 16 }),
  );
  subscribedKey = key;
  return true;
}
async function processUpdate(update) {
  seen++;
  if (!memory.apply(update)) {
    truncated++;
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
  }
  if (memory.operationMissed) {
    missedFrames++;
    rebuild();
    await subscribe(dynamicRanges);
    return;
  }
  if (!rendered || !raw) {
    latest = { frame: update.frame, status: 'NO BATTLE OR UNSUPPORTED READER', misses: memory.misses };
    return;
  }
  good++;
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
    rebuild();
    await subscribe();
    await connection.request(T.Sample, encodeU32(1, 0xa8ec88, 4));
    connection.onMirror((update) => {
      processUpdate(update)
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
    let pictureTimer = null;
    connection.onPicture(() => {
      if (o.record)
        pictureTimer = setTimeout(() => {
          connection.request(T.Credit, encodeU32(1)).catch((e) => {
            failure = e;
          });
        }, 100);
    });
    if (o.record) await connection.request(T.Credit, encodeU32(1));
    const until = performance.now() + +o.seconds * 1000;
    while (performance.now() < until) {
      if (failure) throw failure;
      await delay(100);
    }
    if (pictureTimer) clearTimeout(pictureTimer);
    await connection.request(T.Diagnostics);
  }
  summary.frames = seen;
  summary.readerFrames = good;
  summary.warmupSeconds = firstGood === null ? null : (firstGood - startedAt) / 1000;
  summary.postWarmupMisses = missesAtGood === null ? null : memory.misses - missesAtGood;
  summary.missedFrames = missedFrames;
  summary.directCountSamples = equalities;
  summary.missingDirectSamples = missingDirect;
  summary.countMismatches = countMismatches;
  summary.truncated = truncated;
  summary.readerMsPerFrame = readerCalls ? readerMs / readerCalls : null;
  summary.last = latest;
  summary.lastGoodFrame = renderPrevious?.frame ?? null;
  summary.gates = {
    objectCounts: equalities > 0 && countMismatches === 0 && missingDirect === 0,
    zeroMissesAfterWarmup: summary.postWarmupMisses === 0,
    completeFrames: truncated === 0,
    live: o.replay ? 'UNVERIFIED: replay is not a live gate' : good > 0,
  };
  if (!good || !equalities || missingDirect || countMismatches || truncated || summary.postWarmupMisses !== 0)
    process.exitCode = 1;
} catch (e) {
  summary.error = e.stack;
  process.exitCode = 1;
  console.error(e.message);
} finally {
  clearInterval(progressTimer);
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
