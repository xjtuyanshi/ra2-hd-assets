#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { tsImport } from 'tsx/esm/api';
import WebSocket from 'ws';
import { outputDirectory } from './artifacts.mjs';

const { values: o } = parseArgs({
  options: {
    token: { type: 'string', default: process.env.RA2_NATIVE_AGENT_TOKEN },
    origin: { type: 'string', default: process.env.RA2_NATIVE_AGENT_ORIGIN || 'http://127.0.0.1:15451' },
    url: { type: 'string', default: process.env.RA2_NATIVE_AGENT_URL || 'ws://127.0.0.1:15450' },
    seconds: { type: 'string', default: '0.35' },
    'max-seconds': { type: 'string', default: '50' },
    out: { type: 'string' },
    help: { type: 'boolean' },
  },
});
if (o.help) {
  console.log(
    'Diagnose actual native follow subscriptions without WRITE/INPUT. Compares fixed roots, full policy without/with discovered cells, then groups and failing rules. Diagnostic output is not gate acceptance. --seconds 0.35 --max-seconds 50',
  );
  process.exit(0);
}
if (!o.token || !(+o.seconds >= 0.1 && +o.seconds <= 2) || !(+o['max-seconds'] >= 10 && +o['max-seconds'] <= 120))
  throw new Error('Invalid diagnostic options');
const { NativeConnection } = await tsImport('../../../src/adapter/native/connection.ts', import.meta.url);
const { NativeMirrorMemory } = await tsImport('../../../src/adapter/native/memory.ts', import.meta.url);
const {
  NativeMessageType: T,
  encodeU32,
  encodeSubscription,
  decodeJson,
} = await tsImport('../../../src/adapter/native/protocol.ts', import.meta.url);
const {
  YR_NATIVE_RANGES: fixed,
  YR_NATIVE_FOLLOW_RULES: rules,
  YR_NATIVE_EFFECT_TYPE_ARRAYS: effects,
  createYrNativeHostPolicy,
} = await tsImport('../../../src/games/yr/nativeHost.ts', import.meta.url);
const { YR_STARTUP_PAGE_HASH } = await tsImport('../../../src/games/yr/startupPage.ts', import.meta.url);
const stamp = new Date().toISOString().replaceAll(':', '-'),
  out = outputDirectory(o.out);
const report = { status: 'DIAGNOSTIC ONLY', cases: [], cellRanges: null };
const memory = new NativeMirrorMemory(),
  deadline = performance.now() + +o['max-seconds'] * 1000;
const livePages = new Set();
let current = null,
  failure = null,
  connection = null;
const hex = (n) => `0x${n.toString(16)}`;
function addPages(set, ranges) {
  for (const r of ranges)
    for (let p = Math.floor(r.address / 4096) * 4096; p < r.address + r.length; p += 4096) set.add(p);
}
async function diagnostics() {
  return decodeJson(await connection.request(T.Diagnostics));
}
async function test(name, selectedRules, ranges = fixed) {
  if (performance.now() + 500 >= deadline) {
    report.timeBoundReached = true;
    return null;
  }
  const before = await diagnostics();
  const item = {
    name,
    rules: selectedRules.map((r) => ({ ...r, sourceHex: hex(r.source) })),
    flags: {},
    updates: 0,
    complete: 0,
    frameFirst: null,
    frameLast: null,
    pagesMax: 0,
    before,
  };
  await connection.request(
    T.Subscribe,
    encodeSubscription({ ranges, rules: selectedRules, maxPages: 4096, budgetUs: 4000, sampleCount: 0 }),
  );
  await delay(120); // Drain any preceding in-flight publication; every received packet is ACKed immediately.
  const addresses = new Set(livePages);
  current = { item, addresses };
  await delay(+o.seconds * 1000);
  current = null;
  if (failure) throw failure;
  item.after = await diagnostics();
  item.delta = Object.fromEntries(
    ['truncatedUpdates', 'invalidUpdates', 'budgetOverruns', 'droppedUpdates', 'logicFrames'].map((key) => [
      key,
      (item.after[key] ?? 0) - (before[key] ?? 0),
    ]),
  );
  item.currentPages = addresses.size;
  item.failing = !item.complete || Object.keys(item.flags).some((flags) => +flags & 5);
  report.cases.push(item);
  if (!item.delta.logicFrames && !item.updates) {
    item.status = 'UNVERIFIED: logic stopped; this is not a failed follow rule';
    throw new Error('Real logic stopped during diagnostics; later groups were not tested');
  }
  console.log(
    JSON.stringify({
      name,
      updates: item.updates,
      complete: item.complete,
      flags: item.flags,
      pages: item.currentPages,
      delta: item.delta,
    }),
  );
  return { item, addresses };
}
async function read(address, bytes) {
  const r = await connection.read(address, bytes);
  return new DataView(r.bytes.buffer, r.bytes.byteOffset, r.bytes.byteLength);
}
async function inspect(rule) {
  const result = { rule, sourceHex: hex(rule.source), parents: [] };
  try {
    const source = await read(rule.source, rule.kind === 1 ? 4 : 20);
    if (rule.kind === 1) {
      result.pointer = hex(source.getUint32(0, true));
      return result;
    }
    const items = source.getUint32(4, true),
      count = source.getInt32(16, true);
    result.items = hex(items);
    result.count = count;
    result.capacity = source.getInt32(8, true);
    if (!items || count <= 0 || count > rule.maxCount || rule.kind === 3) return result;
    const pointers = await read(items, Math.min(count, 4) * 4);
    for (let i = 0; i < Math.min(count, 4); i++) {
      const parent = pointers.getUint32(i * 4, true),
        entry = { parent: hex(parent) };
      result.parents.push(entry);
      if (!parent || rule.kind === 2) continue;
      try {
        let member = parent + (rule.kind >= 7 ? rule.stride & 0xffff : rule.stride);
        if (rule.kind >= 7) {
          const target = (await read(member, 4)).getUint32(0, true);
          entry.intermediate = hex(target);
          if (!target) continue;
          member = target + (rule.stride >>> 16);
        }
        entry.member = hex(member);
        const value = await read(member, rule.kind === 4 || rule.kind === 7 ? 20 : rule.kind === 6 ? 12 : 4);
        if ([4, 6, 7].includes(rule.kind)) {
          entry.items = hex(value.getUint32(4, true));
          entry.count = value.getInt32(rule.kind === 6 ? 8 : 16, true);
        } else entry.pointer = hex(value.getUint32(0, true));
      } catch (e) {
        entry.error = e.message;
      }
    }
  } catch (e) {
    result.error = e.message;
  }
  return result;
}
try {
  connection = new NativeConnection({
    url: o.url,
    token: o.token,
    createWebSocket: (url) => new WebSocket(url, { origin: o.origin, maxPayload: 32 * 1024 * 1024 + 16 }),
  });
  connection.onError((error) => {
    failure = error;
  });
  report.hello = await connection.connect();
  if (!report.hello.exe.verified || report.hello.exe.sha256 !== YR_STARTUP_PAGE_HASH)
    throw new Error('Diagnostic requires the pinned executable');
  report.inputState = decodeJson(await connection.request(T.InputState));
  if (report.inputState.modal) throw new Error('Resume the actual mission before diagnostic');
  connection.onMirror((update) => {
    try {
      const complete = memory.apply(update);
      if (complete) {
        if (update.flags & 2) livePages.clear();
        for (const page of update.pages) livePages.add(page.address);
      }
      if (current) {
        const { item, addresses } = current;
        item.updates++;
        item.flags[update.flags] = (item.flags[update.flags] ?? 0) + 1;
        item.frameFirst ??= update.frame;
        item.frameLast = update.frame;
        item.pagesMax = Math.max(item.pagesMax, update.pages.length);
        if (complete) {
          item.complete++;
          if (update.flags & 2) addresses.clear();
          for (const page of update.pages) addresses.add(page.address);
        }
      }
      connection.notify(T.Ack, encodeU32(update.frame));
    } catch (e) {
      failure = e;
    }
  });
  await connection.request(T.Sample, encodeU32(0));
  await connection.request(
    T.Subscribe,
    encodeSubscription({ ranges: fixed, rules: [], maxPages: 4096, budgetUs: 4000, sampleCount: 0 }),
  );
  await connection.request(T.Hook, encodeU32(1));
  await test('fixed-pages', []);
  const full = await test('full-no-cells', rules);
  let cells = [];
  if (full?.item.complete) {
    try {
      memory.beginOperation();
      cells = createYrNativeHostPolicy(memory, () => memory.accessor(), report.hello.exe.sha256, {
        gameThreadId: 0,
      }).additionalRanges();
      const cellPages = new Set();
      addPages(cellPages, cells);
      const union = new Set(full.addresses);
      addPages(union, cells);
      report.cellRanges = { ranges: cells.length, pages: cellPages.size, predictedFullUnionPages: union.size };
      await test('full-with-cells', rules, [...fixed, ...cells]);
      await test('cells-without-follow-rules', [], [...fixed, ...cells]);
    } catch (e) {
      report.cellDiscoveryError = e.message;
    }
  }
  const groups = new Map();
  for (const rule of rules) {
    const name =
      rule.kind === 1
        ? 'root-pointers'
        : rule.kind !== 2
          ? `nested-kind-${rule.kind}`
          : Object.values(effects).includes(rule.source)
            ? 'effect-types'
            : 'pointer-vectors';
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(rule);
  }
  const failing = [];
  for (const [name, group] of groups) {
    const result = await test(name, group);
    if (result?.item.failing) failing.push(...group);
  }
  for (const rule of failing) {
    const result = await test(`rule-${rules.indexOf(rule)}-kind-${rule.kind}-${hex(rule.source)}`, [rule]);
    if (!result) break;
    if (result.item.failing) result.item.inspection = await inspect(rule);
  }
} catch (e) {
  report.error = e.stack;
  process.exitCode = 1;
} finally {
  current = null;
  try {
    if (connection) report.diagnostics = await diagnostics();
  } catch (e) {
    report.diagnosticsError = e.message;
  }
  try {
    if (connection) report.finalInputState = decodeJson(await connection.request(T.InputState));
  } catch (e) {
    report.finalInputStateError = e.message;
  }
  try {
    if (connection) await connection.request(T.Hook, encodeU32(0));
  } catch (e) {
    report.cleanupError = e.message;
    process.exitCode = 1;
  }
  connection?.dispose();
  const path = resolve(out, `diagnose-rules-${stamp}.json`);
  await writeFile(path, JSON.stringify(report, null, 2));
  console.log(
    JSON.stringify(
      {
        report: path,
        status: report.status,
        cellRanges: report.cellRanges,
        error: report.error,
        diagnostics: report.diagnostics,
        cases: report.cases.map(({ rules, before, after, inspection, ...item }) => item),
      },
      null,
      2,
    ),
  );
}
