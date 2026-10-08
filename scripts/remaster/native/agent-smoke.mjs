#!/usr/bin/env node
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { createHash } from 'node:crypto';
import { AgentClient, Type, words, subscription, decodeMirror, Mirror, Picture } from './wire.mjs';
import { outputDirectory, writePng, Recorder } from './artifacts.mjs';
const { values: o } = parseArgs({
  options: {
    url: { type: 'string', default: process.env.RA2_NATIVE_AGENT_URL || 'ws://127.0.0.1:15450' },
    token: { type: 'string', default: process.env.RA2_NATIVE_AGENT_TOKEN },
    origin: { type: 'string', default: process.env.RA2_NATIVE_AGENT_ORIGIN || 'http://127.0.0.1:15451' },
    out: { type: 'string' },
    seconds: { type: 'string', default: '30' },
    soak: { type: 'string' },
    phase3: { type: 'boolean', default: false },
    'owner-only': { type: 'boolean', default: false },
    'record-seconds': { type: 'string', default: '60' },
    'baseline-log': { type: 'string' },
    'baseline-speed-proof': { type: 'string' },
    reconnect: { type: 'string', default: '2' },
    'skip-input': { type: 'boolean', default: false },
    help: { type: 'boolean' },
  },
});
if (o.help) {
  console.log(
    'node scripts/remaster/native/agent-smoke.mjs --token HEX [--seconds 30 --soak 600 --record-seconds 60 --reconnect 2 --baseline-log no-client.log --out OUT]\nFocused phase 3: --phase3 --seconds 5 --soak 180 --reconnect 0 --skip-input\nFresh owner-only crash window: add --owner-only (no unlimited rate/ratio)\nExternal SessionSpeed probe: --baseline-speed-proof before.json,after.json requires closed, no-hook GameSpeed=0 proofs\nRun in an already-started XMP26S6 six-player match with five Easy AIs, 150-250 technos. A no-client probe log from the same scene/speed is required for the 85% comparison. Picture streaming continues after recording ends. Token/origin may be supplied by RA2_NATIVE_AGENT_TOKEN/ORIGIN.',
  );
  process.exit(0);
}
if (o['owner-only'] && !o.phase3) throw new Error('--owner-only requires --phase3');
if (o['baseline-speed-proof'] && (!o['baseline-log'] || o['owner-only']))
  throw new Error('--baseline-speed-proof requires --baseline-log and an unlimited rate window');
o.soak ??= o.phase3 ? '180' : '600';
if (!o.token) throw new Error('Supply a configured token');
for (const key of ['seconds', 'soak', 'record-seconds'])
  if (!Number.isFinite(+o[key]) || +o[key] < 0 || +o[key] > 3600) throw new Error(`Invalid ${key}`);
if (+o.seconds < 5) throw new Error('Rate windows must be at least five seconds');
if (!Number.isInteger(+o.reconnect) || +o.reconnect < 0 || +o.reconnect > 10) throw new Error('Invalid reconnect');
const out = outputDirectory(o.out),
  stamp = new Date().toISOString().replaceAll(':', '-'),
  rec = new Recorder(resolve(out, `recordings/agent-${stamp}.nhrec`));
let client = null;
let samples = 0,
  mismatches = 0,
  updates = 0,
  truncated = 0,
  savedPicture = false,
  pictures = 0,
  changingPictures = 0,
  failure = null,
  last = null;
const observations = [];
let pictureTimer = null;
let pictureHash = null;
let lastAdvance = null;
let ownerRunStart = null,
  ownerRunFrame = null;
function createClient() {
  const client = new AgentClient(o.url, o.token, o.origin),
    mirror = new Mirror(),
    picture = new Picture();
  let closing = false;
  client.stop = async () => {
    closing = true;
    if (pictureTimer) clearTimeout(pictureTimer);
    await Promise.race([
      new Promise((resolve) => {
        client.once('closed', resolve);
        client.close();
      }),
      delay(3000).then(() => {
        if (client.ws.readyState !== 3) throw new Error('Client close timeout');
      }),
    ]);
  };
  client.on('raw', (raw) => {
    if (performance.now() - rec.start <= +o['record-seconds'] * 1000) rec.write(raw);
    else rec.close();
  });
  client.on('failure', (e) => {
    failure = e;
  });
  client.on('closed', () => {
    if (!closing) failure ??= new Error('Agent disconnected');
  });
  client.on('agent-error', (e) => {
    failure = e;
  });
  client.on('packet', (p) => {
    try {
      if (p.type === Type.MIRROR) {
        const u = decodeMirror(p.payload);
        updates++;
        if (u.flags & 5) {
          truncated++;
        } else {
          mirror.apply(u);
          for (const s of u.samples) {
            samples++;
            if (!mirror.read(s.address, s.bytes.length).equals(s.bytes)) mismatches++;
          }
          const frameBytes = mirror.read(0xa8ed84, 4);
          if (frameBytes.readUInt32LE() !== u.frame)
            throw new Error('Published logic frame does not match mirrored frame counter');
          const count = mirror.read(0xa8ec88, 4).readUInt32LE();
          if (!last || last.frame !== u.frame) lastAdvance = performance.now();
          last = { at: performance.now(), frame: u.frame, count };
          observations.push(last);
        }
        client.send(Type.ACK, words(u.frame));
      } else if (p.type === Type.PICTURE) {
        const f = picture.apply(p.payload);
        pictures++;
        const hash = createHash('sha256').update(f.pixels).digest('hex');
        if (pictureHash && hash !== pictureHash) changingPictures++;
        pictureHash = hash;
        if (!savedPicture) {
          writePng(resolve(out, `native-${stamp}.png`), f);
          savedPicture = true;
        }
        if (!closing)
          pictureTimer = setTimeout(() => {
            try {
              client.send(Type.CREDIT, words(1));
            } catch (e) {
              failure = e;
            }
          }, 33);
      }
    } catch (e) {
      failure = e;
      client.close();
    }
  });
  return client;
}
function baselineSpeedProof(rates, pid, exeHash) {
  const paths = o['baseline-speed-proof'].split(',');
  const reject = (reason) => {
    throw new Error(`Baseline speed proof rejected: ${reason}`);
  };
  if (paths.length !== 2 || paths.some((path) => !path)) reject('supply exactly before.json,after.json');
  const proofs = paths.map((path) => {
    try {
      return JSON.parse(readFileSync(path, 'utf8'));
    } catch (error) {
      reject(`cannot read/decode ${path}: ${error.message}`);
    }
  });
  const time = (value, field) => {
    const at = typeof value === 'string' ? Date.parse(value) : NaN;
    if (!Number.isFinite(at)) reject(`invalid ${field} timestamp`);
    return at;
  };
  const sessionSpeeds = new Set();
  for (const [index, proof] of proofs.entries()) {
    const label = index ? 'after' : 'before';
    if (
      proof.mode !== 'no-hook-speed-proof' ||
      proof.pid !== pid ||
      proof.protocol !== 1 ||
      proof.verified !== true ||
      proof.exeHash !== exeHash ||
      proof.error !== null ||
      proof.diagnostics?.hookInstalled !== false
    )
      reject(`${label} must identify the same verified process with no hook and no error`);
    const connected = time(proof.connectedAt, `${label}.connectedAt`),
      closed = time(proof.closedAt, `${label}.closedAt`);
    if (closed < connected || !Array.isArray(proof.samples) || proof.samples.length < 2)
      reject(`${label} requires multiple samples and a completed connection interval`);
    let prior = null;
    for (const sample of proof.samples) {
      const at = time(sample.at, `${label}.sample.at`);
      if (
        sample.gameSpeed !== 0 ||
        sample.sessionType !== 5 ||
        !Number.isInteger(sample.frame) ||
        sample.frame < 0 ||
        sample.frame > 0xffffffff ||
        at < connected ||
        at > closed ||
        (prior && (sample.frame < prior.frame || at < time(prior.at, `${label}.prior.at`)))
      )
        reject(`${label} samples must remain GameSpeed=0 in skirmish with ordered frames/timestamps`);
      if (sample.sessionSpeed !== undefined) {
        if (!Number.isInteger(sample.sessionSpeed) || sample.sessionSpeed < 0 || sample.sessionSpeed > 6)
          reject(`${label} has an invalid SessionSpeed sample`);
        sessionSpeeds.add(sample.sessionSpeed);
      }
      prior = sample;
    }
  }
  const [before, after] = proofs;
  if (time(before.closedAt, 'before.closedAt') > time(after.connectedAt, 'after.connectedAt'))
    reject('before client must close before the after client connects');
  if (
    rates.length < 2 ||
    rates.some(
      (row, index) =>
        !Number.isFinite(row.fps) ||
        row.fps <= 0 ||
        row.objects < 150 ||
        row.objects > 250 ||
        !Number.isInteger(row.frame) ||
        row.frame > 0xffffffff ||
        (index > 0 && row.frame <= rates[index - 1].frame),
    )
  )
    reject('probe requires at least two advancing samples in the 150-250 object range');
  if (before.samples.at(-1).frame > rates[0].frame || rates.at(-1).frame > after.samples[0].frame)
    reject('probe frames must lie between the before and after speed samples');
  if (sessionSpeeds.size > 1 || (sessionSpeeds.size && rates.some((row) => !sessionSpeeds.has(row.speed))))
    reject('logged SessionSpeed must match the optional proof SessionSpeed');
  return {
    paths,
    gameSpeed: 0,
    sessionType: 5,
    sessionSpeedRaw: [...new Set(rates.map((row) => row.speed))],
    before: before.samples.at(-1),
    beforeClosedAt: before.closedAt,
    after: after.samples[0],
    afterConnectedAt: after.connectedAt,
    afterClosedAt: after.closedAt,
    hookInstalled: false,
  };
}
const result = {
  ...(o.phase3
    ? {
        mode: o['owner-only'] ? 'phase3-owner-only-crash' : 'phase3-gate-a',
        scope: {
          stream:
            'Frame/count root pages, Techno vector and bounded 0x900-byte object bodies; no HD reader or map-cell subscription',
          crashWindow: o['owner-only']
            ? '180 seconds from the owner-rate measurement start, including that rate window'
            : 'Requested soak after both rate measurements',
          coverage: o['owner-only']
            ? 'Owner-only three-minute crash smoke; no unlimited rate or baseline ratio, so this is partial Gate A evidence'
            : 'Owner and unlimited rates, equality, picture delivery and requested crash window',
          requiredNoCrashSeconds: 180,
          rateWindowSeconds: +o.seconds,
          hookBudgetUs: 4000,
          independentSampleCount: 16,
        },
      }
    : {}),
  gates: 'NOT RUN until live tool completes',
  hello: null,
  rates: [],
  samples: 0,
  mismatches: 0,
  truncated: 0,
  updates: 0,
  picture: false,
  pictures: 0,
  changingPictures: 0,
  reconnects: [],
  input: 'UNVERIFIED',
  soakSeconds: 0,
  baseline: null,
};
function recordHookTiming(before, after) {
  if (!before || !after) return;
  const calls = (after.hookCalls ?? after.logicFrames) - (before.hookCalls ?? before.logicFrames);
  result.hookTiming = {
    measuredCalls: calls,
    measuredMeanUs: calls > 0 ? (after.hookUs - before.hookUs) / calls : null,
    processMeanUs: after.hookCalls > 0 ? after.hookUs / after.hookCalls : null,
    p99Us: after.hookP99Us ?? null,
    p99Samples: after.hookPercentileSamples ?? null,
    p99Scope: 'Latest bounded hook-call ring in this game process',
    maxUs: after.hookMaxUs ?? null,
    maxScope: 'All recorded hook calls in this game process',
  };
}
async function checkedWait(ms, watchFrames = true) {
  const end = performance.now() + ms;
  while (performance.now() < end) {
    if (failure) throw failure;
    if (watchFrames && last && performance.now() - last.at > 5000)
      throw new Error('No complete advancing mirror for five seconds');
    if (watchFrames && lastAdvance !== null && performance.now() - lastAdvance > 5000)
      throw new Error('Mirrored frame counter stopped advancing for five seconds');
    await delay(Math.min(100, end - performance.now()));
  }
}
async function attach() {
  client = createClient();
  const hello = await client.connect();
  if (
    hello.protocol !== 1 ||
    !hello.exe?.verified ||
    hello.exe?.sha256 !== '7b8a068535d6af06845edf95ae829b113d00c02909330e16f197426cd7db94b6'
  )
    throw new Error('Unsupported executable/protocol');
  await client.request(
    Type.SUBSCRIBE,
    subscription(
      [
        { address: 0xa8e000, length: 4096 },
        { address: 0xa8b000, length: 4096 },
      ],
      [{ kind: 2, source: 0xa8ec78, bytes: 0x900, maxCount: 4096, stride: 4 }],
      {
        sampleCount: o.phase3 ? 16 : 64,
        ...(o.phase3
          ? {
              budgetUs: 4000,
              pageRemovals: hello.limits?.pageRemovals === true && hello.limits?.subscribeRevision === true,
            }
          : {}),
      },
    ),
  );
  await client.request(Type.SAMPLE, Buffer.concat([words(1), words(0xa8ec88, 4)]));
  await client.request(Type.HOOK, words(1));
  client.send(Type.CREDIT, words(1));
  await checkedWait(1500, false);
  if (!last || performance.now() - last.at > 1000) throw new Error('Hook did not publish complete frames');
  return hello;
}
async function rate(speed, seconds) {
  const before = observations.length;
  await client.request(Type.WRITE, Buffer.concat([words(0xa8eb60, 4), words(speed)]));
  await checkedWait(1000);
  const start = performance.now();
  if (o['owner-only'] && speed === 1) {
    ownerRunStart = start;
    ownerRunFrame = last.frame;
  }
  await checkedWait(seconds * 1000);
  const rows = observations.slice(before).filter((r) => r.at >= start);
  if (rows.length < 2) throw new Error('Too few complete mirror frames');
  const first = rows[0],
    end = rows.at(-1);
  const fps = (((end.frame - first.frame) >>> 0) * 1000) / (end.at - first.at);
  const bounds = rows.reduce((b, r) => ({ min: Math.min(b.min, r.count), max: Math.max(b.max, r.count) }), {
    min: Infinity,
    max: -Infinity,
  });
  const entry = {
    speed,
    seconds,
    logicFps: fps,
    minObjects: bounds.min,
    maxObjects: bounds.max,
    samples: rows.length,
  };
  console.log(JSON.stringify(entry));
  result.rates.push(entry);
  return entry;
}
let originalSpeed = null;
try {
  result.hello = await attach();
  console.log('hello', JSON.stringify(result.hello));
  if (
    result.hello.protocol !== 1 ||
    result.hello.exe?.sha256 !== '7b8a068535d6af06845edf95ae829b113d00c02909330e16f197426cd7db94b6'
  )
    throw new Error('Unsupported executable/protocol');
  const f = await client.read(0xa8ed84, 4),
    count = await client.read(0xa8ec88, 4);
  originalSpeed = (await client.read(0xa8eb60, 4)).bytes.readUInt32LE();
  await client.request(Type.WRITE, Buffer.concat([words(0xa8eb60, 4), words(1)]));
  console.log('direct', JSON.stringify({ frame: f.bytes.readUInt32LE(), objects: count.bytes.readUInt32LE() }));
  if (o.phase3) result.diagnosticsBefore = JSON.parse((await client.request(Type.DIAGNOSTICS)).toString());
  for (let cycle = 0; cycle < +o.reconnect; cycle++) {
    const before = last.frame;
    const priorDiagnostics = JSON.parse((await client.request(Type.DIAGNOSTICS)).toString());
    await client.stop();
    await checkedWait(1500, false);
    const hello = await attach();
    if (hello.pid !== result.hello.pid) throw new Error('Agent process changed across reconnect');
    const after = last.frame;
    const diagnostics = JSON.parse((await client.request(Type.DIAGNOSTICS)).toString());
    const advancing = (after - before) >>> 0 > 0 && (after - before) >>> 0 < 0x80000000;
    const entry = { cycle: cycle + 1, before, after, advancing, priorDiagnostics, diagnostics };
    result.reconnects.push(entry);
    console.log('reconnect', JSON.stringify(entry));
    if (!advancing || diagnostics.teardownFailures || !diagnostics.gameThreadId)
      throw new Error('Reconnect did not preserve a live game-thread hook');
  }
  await rate(1, +o.seconds);
  if (!o['owner-only']) await rate(0, +o.seconds);
  if (o['baseline-log'] && !o['owner-only']) {
    const text = readFileSync(o['baseline-log'], 'utf8'),
      pid = /attached pid=(\d+)/.exec(text),
      rates = [...text.matchAll(/frame=(\d+) logic\/s=([\d.]+) objs=(\d+) speed=(\d+)/g)].map((m) => ({
        frame: +m[1],
        fps: +m[2],
        objects: +m[3],
        speed: +m[4],
      }));
    if (!pid || +pid[1] !== result.hello.pid) throw new Error('Baseline must identify this same native process');
    let speedProof = null;
    if (o['baseline-speed-proof']) {
      speedProof = baselineSpeedProof(rates, result.hello.pid, result.hello.exe.sha256);
      const loggedTimes = [...text.matchAll(/^(\d{2}):(\d{2}):(\d{2})\.(\d{3}) (?:attached pid=|frame=)/gm)].map(
        (match) => ((+match[1] * 60 + +match[2]) * 60 + +match[3]) * 1000 + +match[4],
      );
      speedProof.probeRows = rates.length;
      speedProof.probeTimestampSpanSeconds =
        loggedTimes.length === rates.length + 1
          ? ((loggedTimes.at(-1) - loggedTimes[0] + 86400000) % 86400000) / 1000
          : null;
      speedProof.probeDurationSource = 'External probe attached-to-last-row log timestamps';
    } else if (
      rates.length < 2 ||
      rates.some(
        (r, i) =>
          r.speed !== 0 || r.fps <= 0 || r.objects < 150 || r.objects > 250 || (i > 0 && r.frame <= rates[i - 1].frame),
      )
    )
      throw new Error('Baseline must advance at speed 0 throughout the target object range');
    result.baseline = {
      ...(speedProof ? { speedProof } : {}),
      samples: rates.length,
      logicFps: rates.reduce((s, r) => s + r.fps, 0) / rates.length,
      provenance: o['baseline-log'],
      sameScene: speedProof
        ? 'Same verified process/session, bracketed monotonic frames; map/team setup is recorded by the runner menu report'
        : 'LEAD MUST CONFIRM',
    };
    result.baseline.ratio = result.rates.at(-1).logicFps / result.baseline.logicFps;
  }
  // A no-limit baseline can leave the entry speed at zero; the requested soak uses owner speed.
  await client.request(Type.WRITE, Buffer.concat([words(0xa8eb60, 4), words(1)]));
  if (!o['skip-input']) {
    const before = JSON.parse((await client.request(Type.INPUT_STATE)).toString());
    await client.request(Type.INPUT, words(3, 321, 234, 0));
    await client.request(Type.INPUT, words(2, 16, 1, 0));
    await client.request(Type.INPUT, words(1, 0x100, 16, 0x002a0001));
    await checkedWait(500);
    const after = JSON.parse((await client.request(Type.INPUT_STATE)).toString());
    await client.request(Type.INPUT, words(1, 0x101, 16, 0xc02a0001));
    await client.request(Type.INPUT, words(2, 16, 0, 0));
    result.input = {
      before,
      after,
      confirmed:
        after.x === 321 &&
        after.y === 234 &&
        (after.cursorReads ?? 0) > (before.cursorReads ?? 0) &&
        after.cursorLastReadX === 321 &&
        after.cursorLastReadY === 234 &&
        (after.injectedKeyReads ?? 0) > (before.injectedKeyReads ?? 0) &&
        after.lastInjectedKey === 16 &&
        (after.deliveredMessages ?? 0) > (before.deliveredMessages ?? 0),
    };
  }
  const soakStart = performance.now(),
    start = o['owner-only'] ? ownerRunStart : soakStart;
  const soakFrame = last.frame;
  let nextProgress = soakStart + 10000;
  while (performance.now() - start < +o.soak * 1000) {
    if (o.phase3) {
      result.soakSeconds = (performance.now() - soakStart) / 1000;
      if (o['owner-only']) {
        result.totalRunSeconds = (performance.now() - start) / 1000;
        result.totalRunFrames = (last.frame - ownerRunFrame) >>> 0;
      }
      result.soakFrames = (last.frame - soakFrame) >>> 0;
    }
    await checkedWait(Math.min(1000, +o.soak * 1000 - (performance.now() - start)));
    if (performance.now() >= nextProgress) {
      console.log(
        'soak',
        JSON.stringify({
          seconds: (performance.now() - soakStart) / 1000,
          ...(o['owner-only'] ? { totalRunSeconds: (performance.now() - start) / 1000 } : {}),
          frame: last.frame,
          objects: last.count,
          samples,
          pictures,
          changingPictures,
        }),
      );
      nextProgress += 10000;
    }
  }
  result.soakSeconds = (performance.now() - soakStart) / 1000;
  if (o['owner-only']) {
    result.totalRunSeconds = (performance.now() - start) / 1000;
    result.totalRunFrames = (last.frame - ownerRunFrame) >>> 0;
  }
  result.soakFrames = (last.frame - soakFrame) >>> 0;
  result.diagnostics = JSON.parse((await client.request(Type.DIAGNOSTICS)).toString());
  result.samples = samples;
  result.mismatches = mismatches;
  result.truncated = truncated;
  result.updates = updates;
  result.picture = savedPicture;
  result.pictures = pictures;
  result.changingPictures = changingPictures;
  result.equality = samples >= 2000 && mismatches === 0 && truncated === 0;
  if (o.phase3) recordHookTiming(result.diagnosticsBefore, result.diagnostics);
  result.gates = {
    ownerRate: result.rates[0].logicFps >= 62,
    ...(o['owner-only']
      ? {}
      : { streamRatio: result.baseline ? result.baseline.ratio >= 0.85 : 'UNVERIFIED: no no-client baseline' }),
    equality: result.equality,
    ...(o.phase3
      ? {
          noCrash:
            (o['owner-only'] ? result.totalRunSeconds : result.soakSeconds) >= 180 &&
            (o['owner-only'] ? result.totalRunFrames : result.soakFrames) > 0,
        }
      : {
          tenMinute: result.soakSeconds >= 600 && result.soakFrames > 0,
          reconnect: result.reconnects.length >= 2 && result.reconnects.every((r) => r.advancing),
          input: typeof result.input === 'object' && result.input.confirmed,
          stock: 'UNVERIFIED: requires separate no-config run',
        }),
    picture: savedPicture && changingPictures > 0,
    objects: result.rates.every((r) => r.minObjects >= 150 && r.maxObjects <= 250),
  };
  if (Object.values(result.gates).some((gate) => (o.phase3 ? gate !== true : gate === false))) process.exitCode = 1;
} catch (e) {
  result.error = e.stack;
  process.exitCode = 1;
  console.error(e.message);
  result.partialGates = {
    ownerRate: result.rates.length > 0 && result.rates[0].logicFps >= 62,
    streamRatio: result.baseline ? result.baseline.ratio >= 0.85 : 'UNVERIFIED',
    equality: samples >= 2000 && mismatches === 0 && truncated === 0,
    noCrash: false,
    objects: result.rates.length > 0 && result.rates.every((r) => r.minObjects >= 150 && r.maxObjects <= 250),
  };
  if (o.phase3 && client?.ws.readyState === 1) {
    try {
      result.diagnostics = JSON.parse((await client.request(Type.DIAGNOSTICS)).toString());
      recordHookTiming(result.diagnosticsBefore, result.diagnostics);
      result.failureInputState = JSON.parse((await client.request(Type.INPUT_STATE)).toString());
      if (picture.pixels) {
        result.failurePicture = resolve(out, `native-failure-${stamp}.png`);
        writePng(result.failurePicture, picture);
      }
    } catch (error) {
      result.diagnosticsError = error.message;
    }
  }
} finally {
  result.samples = samples;
  result.mismatches = mismatches;
  result.truncated = truncated;
  result.updates = updates;
  result.picture = savedPicture;
  result.pictures = pictures;
  result.changingPictures = changingPictures;
  if (pictureTimer) clearTimeout(pictureTimer);
  try {
    if (originalSpeed !== null && client?.ws.readyState === 1)
      await client.request(Type.WRITE, Buffer.concat([words(0xa8eb60, 4), words(originalSpeed)]));
    if (client?.ws.readyState === 1) await client.request(Type.HOOK, words(0));
  } catch (e) {
    result.cleanupError = e.message;
    process.exitCode = 1;
  }
  rec.close();
  client?.close();
  writeFileSync(resolve(out, `agent-smoke-${stamp}.json`), JSON.stringify(result, null, 2));
  appendFileSync(resolve(out, 'NOTES.md'), `\n## Agent smoke ${stamp}\n\n${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result, null, 2));
}
