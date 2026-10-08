#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendFile, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { tsImport } from 'tsx/esm/api';
import WebSocket from 'ws';
import { outputDirectory, Recorder } from './artifacts.mjs';

const percentile = (values, quantile) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * quantile) - 1)];
};
const stats = (values) => ({
  count: values.length,
  mean: values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null,
  p95: percentile(values, 0.95),
  max: values.length ? values.reduce((maximum, value) => Math.max(maximum, value), -Infinity) : null,
});

/** Use the page's actual core, subscription/retry lifecycle and render/command/performance reader factories. */
export async function runCoreReaderSmoke(o) {
  if (!o.token) throw new Error('Supply a configured token');
  for (const [key, maximum] of [
    ['seconds', 3600],
    ['warmup', 300],
    ['wait-objects', 120],
  ]) {
    const value = +(o[key] ?? (key === 'seconds' ? 60 : key === 'warmup' ? 15 : 60));
    if (!Number.isFinite(value) || value < 0 || value > maximum || (key === 'seconds' && value === 0))
      throw new Error(`Invalid ${key}`);
    o[key] = value;
  }
  const { NativeCore } = await tsImport('../../../src/adapter/native/core.ts', import.meta.url);
  const { NativeMemoryMiss } = await tsImport('../../../src/adapter/native/memory.ts', import.meta.url);
  const { createYrNativeHostPolicy } = await tsImport('../../../src/games/yr/nativeHost.ts', import.meta.url);
  const { createYrStateReader, YR_STATE_GLOBALS: G } = await tsImport(
    '../../../src/games/yr/stateReader.ts',
    import.meta.url,
  );
  const {
    NativeMessageType: T,
    decodeJson,
    encodeSamples,
  } = await tsImport('../../../src/adapter/native/protocol.ts', import.meta.url);
  const out = outputDirectory(o.out),
    stamp = new Date().toISOString().replaceAll(':', '-'),
    reportPath = resolve(out, `core-reader-smoke-${stamp}.json`),
    attachAt = performance.now();
  let core,
    recorder,
    failure = null,
    measurementStart = null,
    measurementEnd = null;
  let firstCompleteAt = null,
    firstCompleteFrame = null,
    lastCompleteAt = null,
    lastCompleteFrame = null;
  let lastPolledFrame = null,
    latest = null,
    lastPrint = attachAt,
    rawReader = null;
  let pictures = 0,
    measurementMisses = null,
    measurementStateMs = null,
    measurementStateReads = null;
  let verifierMemory = null,
    verifierMisses = 0,
    measuredVerifierMisses = 0;
  let diagnosticsBefore = null,
    diagnosticsAfter = null,
    firstMeasuredFrame = null,
    lastMeasuredFrame = null;
  const statuses = [],
    failures = [],
    directByFrame = new Map(),
    decodeByFrame = new Map();
  const slots = Object.fromEntries(
    ['render', 'command', 'performance'].map((key) => [
      key,
      {
        factory: [],
        decode: [],
        measuredFactory: [],
        measuredDecode: [],
        latency: [],
      },
    ]),
  );
  const stream = { updates: 0, complete: 0, incomplete: 0, invalid: 0, truncations: 0, samples: 0, mismatches: 0 };
  const measured = {
    ...stream,
    readerFrames: 0,
    directCountSamples: 0,
    countMismatches: 0,
    missingDirectSamples: 0,
    minObjects: null,
    maxObjects: null,
  };
  const totals = { readerFrames: 0, directCountSamples: 0, countMismatches: 0, missingDirectSamples: 0 };
  const observations = [];
  const measuredNow = () => measurementStart !== null && measurementEnd === null;
  const rememberFailure = (error) => {
    failure ??= error instanceof Error ? error : new Error(String(error));
    if (failures.length < 16) failures.push(failure.message);
  };
  const instrumentPolicy = (memory, metadata, hash) => {
    const policy = createYrNativeHostPolicy(memory, () => memory.accessor(), hash, metadata);
    for (const [key, name] of [
      ['createRenderReader', 'render'],
      ['createCommandReader', 'command'],
      ['createFrameReader', 'performance'],
    ]) {
      const originalFactory = policy[key];
      const recordTime = (kind, began) => {
        const elapsed = performance.now() - began;
        slots[name][kind].push(elapsed);
        if (!measuredNow()) return;
        slots[name][kind === 'factory' ? 'measuredFactory' : 'measuredDecode'].push(elapsed);
        let frame = decodeByFrame.get(memory.frame);
        if (!frame) decodeByFrame.set(memory.frame, (frame = { render: 0, command: 0, performance: 0 }));
        frame[name] += elapsed;
      };
      policy[key] = () => {
        const began = performance.now();
        let reader;
        try {
          reader = originalFactory();
        } finally {
          recordTime('factory', began);
        }
        if (!reader) return null;
        return (...args) => {
          const began = performance.now();
          try {
            return reader(...args);
          } finally {
            recordTime('decode', began);
          }
        };
      };
    }
    return policy;
  };
  const observeMirror = (update) => {
    const buckets = measuredNow() ? [stream, measured] : [stream];
    for (const bucket of buckets) {
      bucket.updates++;
      if (update.flags & 5) bucket.incomplete++;
      else bucket.complete++;
      if (update.flags & 4) bucket.invalid++;
      if (update.flags & 1) bucket.truncations++;
    }
    if (update.flags & 5) return;
    for (const sample of update.samples) {
      const actual = core.memory.read_memory(sample.address, sample.bytes.length);
      const same =
        actual.length === sample.bytes.length && actual.every((value, index) => value === sample.bytes[index]);
      for (const bucket of buckets) {
        bucket.samples++;
        if (!same) bucket.mismatches++;
      }
      if (sample.address === G.technos + 16 && sample.bytes.length === 4)
        directByFrame.set(
          update.frame,
          new DataView(sample.bytes.buffer, sample.bytes.byteOffset, 4).getUint32(0, true),
        );
    }
    while (directByFrame.size > 1024) directByFrame.delete(directByFrame.keys().next().value);
  };
  const summary = {
    mode: 'live-native-core',
    readerPath: 'src/adapter/native/core.ts',
    hello: null,
    requestedWarmupSeconds: o.warmup,
    warmupSeconds: null,
    measurementSeconds: null,
    firstCompleteRenderSeconds: null,
    firstCompleteRenderFrame: null,
    gates: 'NOT RUN',
  };
  try {
    if (o.record) recorder = new Recorder(resolve(out, `recordings/core-reader-${stamp}.nhrec`));
    core = new NativeCore(
      {
        onStatus: (status) => {
          if (statuses.length < 32) statuses.push({ ...status, seconds: (performance.now() - attachAt) / 1000 });
          if (status.phase === 'error') rememberFailure(new Error(status.detail));
        },
        onFrame: () => {
          pictures++;
          core.requestNextFrame();
        },
      },
      {
        url: o.url || process.env.RA2_NATIVE_AGENT_URL || 'ws://127.0.0.1:15450',
        token: o.token,
        renderPassthrough: false,
        createWebSocket: (url) => {
          const socket = new WebSocket(url, {
            origin: o.origin || process.env.RA2_NATIVE_AGENT_ORIGIN || 'http://127.0.0.1:15451',
          });
          if (recorder) socket.on('message', (raw) => recorder.write(Buffer.from(raw)));
          return socket;
        },
      },
      instrumentPolicy,
      (emit) => emit(),
    );
    const onMiss = core.memory.onMiss;
    core.memory.onMiss = (ranges) => {
      onMiss?.(ranges);
      if (observations.length < 64)
        observations.push({ frame: core.memory.frame, measured: measuredNow(), source: 'NativeCore', ranges });
    };
    // Add independent same-thread samples without replacing any core-owned subscription, retry, ACK or decoder.
    // The core normally requests no samples. Keep the removal capability bit and every other subscription byte.
    const request = core.connection.request.bind(core.connection);
    core.connection.request = async (type, payload) => {
      if (type === T.Subscribe) {
        payload = payload.slice();
        const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
        view.setUint32(16, (view.getUint32(16, true) & 0x80000000) + 16, true);
      } else if (
        type === T.Hook &&
        new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getUint32(0, true) === 1
      ) {
        await request(T.Sample, encodeSamples([{ address: G.technos + 16, length: 4 }]));
      }
      return request(type, payload);
    };
    const mirrorArrived = core.mirrorArrived.bind(core);
    core.mirrorArrived = (update) => {
      mirrorArrived(update);
      try {
        observeMirror(update);
      } catch (error) {
        rememberFailure(error);
      }
    };
    await core.start();
    summary.hello = core.hello;
    const inputState = decodeJson(await request(T.InputState));
    const frameCounter = async () => {
      const result = await core.connection.read(G.frame, 4);
      return new DataView(result.bytes.buffer, result.bytes.byteOffset, 4).getUint32(0, true);
    };
    const beforeFrame = await frameCounter();
    await delay(500);
    const afterFrame = await frameCounter();
    summary.preflight = {
      inputState,
      beforeFrame,
      afterFrame,
      advanced: (afterFrame - beforeFrame) >>> 0,
      advancing: afterFrame > beforeFrame,
    };
    if (inputState.modal || afterFrame <= beforeFrame)
      throw new Error('NativeCore smoke requires an already-running match: modal dialog or nonadvancing frame counter');
    const warmupEnd = performance.now() + o.warmup * 1000;
    const objectDeadline = warmupEnd + o['wait-objects'] * 1000;
    let deadline = objectDeadline + o.seconds * 1000;
    while (performance.now() < deadline) {
      if (failure) throw failure;
      if (performance.now() >= warmupEnd && firstCompleteAt === null)
        throw new Error('NativeCore produced no complete render state during fixed warm-up');
      if (lastCompleteAt !== null && performance.now() - lastCompleteAt > 5000)
        throw new Error('NativeCore complete render state stopped advancing for five seconds');
      if (core.memory.frame === lastPolledFrame) {
        await delay(2);
        continue;
      }
      lastPolledFrame = core.memory.frame;
      const results = {};
      for (const [name, method] of [
        ['render', 'getRenderState'],
        ['command', 'getCommandState'],
        ['performance', 'getGamePerformance'],
      ]) {
        const began = performance.now();
        results[name] = await core[method]();
        if (measuredNow()) slots[name].latency.push(performance.now() - began);
      }
      const render = results.render;
      if (render?.map && render.frame > 0 && !core.render.error) {
        if (firstCompleteAt === null) {
          firstCompleteAt = performance.now();
          firstCompleteFrame = render.frame;
        }
        if (render.frame !== lastCompleteFrame) lastCompleteAt = performance.now();
        lastCompleteFrame = render.frame;
        totals.readerFrames++;
        if (measuredNow()) {
          measured.readerFrames++;
          firstMeasuredFrame ??= render.frame;
          lastMeasuredFrame = render.frame;
        }
      }
      // The page readers omit limbo objects. Verify all technos separately with the original state reader;
      // its CPU time is deliberately excluded from the page-reader timing above and reported separately below.
      const verifyAt = performance.now();
      let raw = null;
      if (render?.map && render.frame > 0 && !core.render.error) {
        // Keep the verifier outside the core's dependency-discovery ownership and subscription lifecycle.
        verifierMemory = core.memory.snapshot();
        verifierMemory.onMiss = undefined;
        verifierMemory.beginOperation();
        try {
          rawReader ??= createYrStateReader(() => verifierMemory.accessor(), core.hello.exe.sha256);
          raw = rawReader?.({ includeLimbo: true }) ?? null;
        } catch (error) {
          if (!(error instanceof NativeMemoryMiss)) throw error;
          rawReader = null;
        }
        verifierMisses += verifierMemory.misses;
        if (measuredNow()) measuredVerifierMisses += verifierMemory.misses;
        if (verifierMemory.operationMissed && observations.length < 64)
          observations.push({
            frame: verifierMemory.frame,
            measured: measuredNow(),
            ranges: verifierMemory.missingRanges,
            source: 'independent count verifier',
          });
      }
      const verifyMs = performance.now() - verifyAt;
      const direct = raw ? directByFrame.get(raw.frame) : undefined;
      if (raw && !verifierMemory.operationMissed) {
        const buckets = measuredNow() ? [totals, measured] : [totals];
        for (const bucket of buckets) {
          if (direct === undefined) bucket.missingDirectSamples++;
          else {
            bucket.directCountSamples++;
            if (raw.objects.length !== direct) bucket.countMismatches++;
          }
        }
        if (measuredNow() && direct !== undefined) {
          measured.minObjects = Math.min(measured.minObjects ?? direct, direct);
          measured.maxObjects = Math.max(measured.maxObjects ?? direct, direct);
        }
      }
      latest = {
        frame: render?.frame ?? core.memory.frame,
        renderObjects: render?.objects.length ?? null,
        commandObjects: results.command?.objects.length ?? null,
        directTechnos: direct ?? null,
        decodedIncludingLimbo: raw?.objects.length ?? null,
        countsEqual: direct !== undefined && raw?.objects.length === direct,
        misses: core.memory.misses,
        readerErrors: { render: core.render.error, command: core.command.error, performance: core.frame.error },
        performance: results.performance,
        verifierMs: verifyMs,
      };
      if (performance.now() - lastPrint >= 1000) {
        console.log(JSON.stringify(latest));
        await writeFile(
          `${reportPath}.progress.json`,
          JSON.stringify({
            ...latest,
            firstCompleteRenderSeconds: firstCompleteAt === null ? null : (firstCompleteAt - attachAt) / 1000,
            measuring: measuredNow(),
            measured,
            failure: failure?.message ?? null,
          }),
        );
        lastPrint = performance.now();
      }
      if (performance.now() >= warmupEnd && measurementStart === null) {
        if (firstCompleteAt === null)
          throw new Error('NativeCore produced no complete render state during fixed warm-up');
        if (direct !== undefined && direct >= 150 && direct <= 250) {
          diagnosticsBefore = decodeJson(await request(T.Diagnostics));
          measurementMisses = core.memory.misses;
          measurementStateMs = core.stateReadMs;
          measurementStateReads = core.stateReads;
          measurementStart = performance.now();
          deadline = measurementStart + o.seconds * 1000;
        } else if (performance.now() >= objectDeadline)
          throw new Error('150-250-object measurement scene was not reached');
      }
      if (lastCompleteAt !== null && performance.now() - lastCompleteAt > 5000)
        throw new Error('NativeCore complete render state stopped advancing for five seconds');
      await delay(0);
    }
    measurementEnd = performance.now();
    if (measurementStart === null) throw new Error('NativeCore measurement did not start');
    diagnosticsAfter = decodeJson(await request(T.Diagnostics));
  } catch (error) {
    rememberFailure(error);
    measurementEnd ??= performance.now();
    if (core?.hello && !core.closed)
      try {
        diagnosticsAfter = decodeJson(await core.connection.request(T.Diagnostics));
      } catch {
        /* Original failure remains. */
      }
  } finally {
    measurementEnd ??= performance.now();
    summary.hello ??= core?.hello ?? null;
    summary.warmupSeconds = measurementStart === null ? null : (measurementStart - attachAt) / 1000;
    summary.measurementSeconds = measurementStart === null ? null : (measurementEnd - measurementStart) / 1000;
    summary.firstCompleteRenderSeconds = firstCompleteAt === null ? null : (firstCompleteAt - attachAt) / 1000;
    summary.firstCompleteRenderFrame = firstCompleteFrame;
    summary.postWarmupMisses = measurementMisses === null ? null : core.memory.misses - measurementMisses;
    summary.independentVerifierMisses = { total: verifierMisses, measured: measuredVerifierMisses };
    summary.frames = stream.updates;
    summary.readerFrames = totals.readerFrames;
    summary.measuredReaderFrames = measured.readerFrames;
    summary.measuredIncompleteUpdates = measured.incomplete;
    summary.measuredInvalidUpdates = measured.invalid;
    summary.measuredPageTruncations = measured.truncations;
    summary.measuredObjectRange = { min: measured.minObjects, max: measured.maxObjects };
    summary.measuredDirectCountSamples = measured.directCountSamples;
    summary.measuredCountMismatches = measured.countMismatches;
    summary.measuredMissingDirectSamples = measured.missingDirectSamples;
    summary.measuredLogicFrames = firstMeasuredFrame === null ? 0 : (lastMeasuredFrame - firstMeasuredFrame) >>> 0;
    const totalsByFrame = [...decodeByFrame.values()].map((frame) => frame.render + frame.command + frame.performance);
    const pure = stats(totalsByFrame);
    summary.measuredReaderMsPerFrame = pure.mean;
    summary.measuredReaderMsP95 = pure.p95;
    summary.pageReaderCpu = {
      ...pure,
      definition:
        'Sum of original render/command/performance factories and synchronous decoder attempts, grouped by actual mirrored logic frame; excludes RPC waits and independent verifier.',
    };
    summary.readerBreakdown = Object.fromEntries(
      Object.entries(slots).map(([name, slot]) => [
        name,
        {
          factoryMs: stats(slot.measuredFactory),
          decoderMs: stats(slot.measuredDecode),
          endToEndMs: stats(slot.latency),
          cpuMsPerLogicFrame: stats([...decodeByFrame.values()].map((frame) => frame[name])),
        },
      ]),
    );
    summary.coreStateRead = {
      calls: measurementStateReads === null ? null : core.stateReads - measurementStateReads,
      totalMs: measurementStateMs === null ? null : core.stateReadMs - measurementStateMs,
      definition:
        'NativeCore stateReadMs includes its policy expansion/subscription/retry awaits; public method latency also includes InputState RPCs.',
    };
    summary.stream = stream;
    summary.measuredStream = measured;
    summary.statuses = statuses;
    summary.failures = failures;
    summary.missObservations = observations;
    summary.pictures = pictures;
    summary.last = latest;
    summary.diagnosticsBefore = diagnosticsBefore;
    summary.diagnostics = diagnosticsAfter;
    summary.error = failure?.stack ?? null;
    summary.gates = {
      firstCompleteRender: firstCompleteAt !== null,
      zeroMissesAfterWarmup: summary.postWarmupMisses === 0,
      completeFrames:
        measured.updates > 0 && measured.incomplete === 0 && measured.invalid === 0 && measured.truncations === 0,
      objectCounts:
        measured.directCountSamples > 0 &&
        measured.countMismatches === 0 &&
        measured.missingDirectSamples === 0 &&
        measuredVerifierMisses === 0,
      objects: measured.minObjects !== null && measured.minObjects >= 150 && measured.maxObjects <= 250,
      readerCost: pure.mean !== null && pure.mean <= 4 && pure.p95 <= 8,
      sixtySeconds: summary.measurementSeconds >= 60,
      equality: measured.samples >= 2000 && measured.mismatches === 0,
      errorFree: !failure,
    };
    try {
      await core?.stop();
    } catch (error) {
      summary.cleanupError = String(error);
      summary.gates.errorFree = false;
    }
    recorder?.close();
    await writeFile(reportPath, JSON.stringify(summary, null, 2) + '\n');
    await appendFile(
      resolve(out, 'NOTES.md'),
      `\n## NativeCore reader smoke ${stamp}\n\n${JSON.stringify(summary, null, 2)}\n`,
    );
    console.log(JSON.stringify({ report: reportPath, ...summary }, null, 2));
  }
  return summary;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
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
      help: { type: 'boolean' },
    },
  });
  if (o.help) {
    console.log(
      'node scripts/remaster/native/core-reader-smoke.mjs --token HEX [--warmup 15 --seconds 60 --wait-objects 60 --out OUT]\nRuns the same NativeCore and complete YR reader set as the page. Pure decoder CPU, RPC/retry latency and first complete render latency are separate. No game input, speed changes or passthrough writes. Runner must stop the game afterwards.',
    );
  } else {
    const summary = await runCoreReaderSmoke(o);
    process.exitCode = Object.values(summary.gates).every((value) => value === true) ? 0 : 1;
  }
}
