#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { appendFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { AgentClient, Type, words, Picture } from './wire.mjs';
import { outputDirectory, writePng } from './artifacts.mjs';

const { values: o } = parseArgs({
  options: {
    url: { type: 'string', default: process.env.RA2_NATIVE_AGENT_URL || 'ws://127.0.0.1:15450' },
    token: { type: 'string', default: process.env.RA2_NATIVE_AGENT_TOKEN },
    origin: { type: 'string', default: process.env.RA2_NATIVE_AGENT_ORIGIN || 'http://127.0.0.1:15451' },
    out: { type: 'string' },
    'deploy-only': { type: 'boolean', default: false },
    help: { type: 'boolean' },
  },
});
if (o.help) {
  console.log(
    'node scripts/remaster/native/deploy-defense.mjs [--deploy-only]\nRuns ordinary protocol mouse/key input in an already-started match. Reads positions/selection, deploys the local MCV and requires its replacement by an owned construction yard. The optional Soviet defense sequence builds ordinary cameos and verifies resulting owned buildings; it does not guarantee 600 s survival. No guest memory writes or game-resource edits.',
  );
  process.exit(0);
}
if (!o.token) throw new Error('Supply a configured token');
const out = outputDirectory(o.out),
  stamp = new Date().toISOString().replaceAll(':', '-');
const client = new AgentClient(o.url, o.token, o.origin),
  picture = new Picture();
const result = {
  hello: null,
  mode: o['deploy-only'] ? 'deploy-only' : 'deploy-and-defense',
  deployment: null,
  buildings: [],
  queues: [],
  inputOnlyMutations: true,
  survival600s: 'UNVERIFIED',
};
let failure = null,
  pendingPicture = null,
  latestPicture = null,
  completed = false;
client.on('failure', (e) => {
  failure = e;
});
client.on('closed', () => {
  if (!completed) failure ??= new Error('Agent disconnected');
});
client.on('agent-error', (e) => {
  failure = e;
});
client.on('packet', (p) => {
  try {
    if (p.type === Type.PICTURE) {
      latestPicture = picture.apply(p.payload);
      pendingPicture?.(latestPicture);
      pendingPicture = null;
    }
  } catch (e) {
    failure = e;
  }
});
const G = {
  units: 0x8b4108,
  buildings: 0xa8eb40,
  localHouse: 0xa83d4c,
  tactical: 0x887324,
  zFactor: 0xb0cd48,
  frame: 0xa8ed84,
  sidebar: 0x87f7e8,
  tabs: 0xb07c48,
  pitchX: 0xb0b4fc,
  pitchY: 0xb0b500,
};
const O = { owner: 0x21c, uid: 0x10, location: 0x9c, selected: 0x83, unitType: 0x6c4, buildingType: 0x520 };
const STRIPS = G.sidebar + 0x1544,
  STRIP_SIZE = 0xf94;
let localHouse = 0,
  width = 1024,
  height = 768;
const typeIds = new Map();
function checked() {
  if (failure) throw failure;
}
async function bytes(address, length) {
  checked();
  return (await client.read(address, length)).bytes;
}
async function u32(address) {
  return (await bytes(address, 4)).readUInt32LE();
}
async function input(kind, a, b, c = 0) {
  checked();
  await client.request(Type.INPUT, words(kind, a, b, c));
}
async function move(x, y) {
  x = Math.round(x);
  y = Math.round(y);
  if (x < 0 || y < 0 || x >= width || y >= height) throw new Error(`Off-surface input ${x},${y}`);
  await input(3, x, y);
  await input(1, 0x200, 0, ((y << 16) | x) >>> 0);
}
async function click(x, y) {
  x = Math.round(x);
  y = Math.round(y);
  await move(x, y);
  const point = ((y << 16) | x) >>> 0;
  await input(2, 1, 1);
  await input(1, 0x201, 1, point);
  await delay(50);
  await input(1, 0x202, 0, point);
  await input(2, 1, 0);
}
async function key(vk, scan) {
  await input(2, vk, 1);
  await input(1, 0x100, vk, ((scan << 16) | 1) >>> 0);
  await delay(80);
  await input(1, 0x101, vk, (0xc0000001 | (scan << 16)) >>> 0);
  await input(2, vk, 0);
}
async function pointers(at) {
  const d = await bytes(at, 20),
    count = d.readUInt32LE(16),
    items = d.readUInt32LE(4);
  if (count > 4096 || (count && (items < 0x10000 || items % 4 || items + count * 4 > 0x100000000)))
    throw new Error('Invalid game vector');
  if (!count) return [];
  const p = await bytes(items, count * 4);
  return Array.from({ length: count }, (_, i) => p.readUInt32LE(i * 4));
}
async function id(at) {
  if (!typeIds.has(at)) typeIds.set(at, (await bytes(at + 0x24, 24)).toString('ascii').split('\0')[0]);
  return typeIds.get(at);
}
async function owned(kind) {
  let error;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await ownedOnce(kind);
    } catch (e) {
      error = e;
      if (failure) throw failure;
      if (attempt < 3) {
        console.log('owned-read-retry', JSON.stringify({ kind, attempt, error: e.message }));
        await delay(50);
      }
    }
  }
  throw new Error(`Persistent ${kind} read failure after three whole-vector attempts: ${error.message}`, {
    cause: error,
  });
}
async function ownedOnce(kind) {
  const list = await pointers(G[kind]),
    objects = [];
  for (let i = 0; i < list.length; i += 8) {
    const rows = await Promise.all(
      list.slice(i, i + 8).map(async (pointer) => {
        const length = kind === 'units' ? 0x6c8 : 0x524;
        if (pointer < 0x10000 || pointer % 4 || pointer + length > 0x100000000)
          throw new Error(`Invalid ${kind} object pointer 0x${pointer.toString(16)}`);
        return { pointer, data: await bytes(pointer, length) };
      }),
    );
    for (const { pointer, data } of rows) {
      if (data[0x81] || data.readInt32LE(0x6c) <= 0) continue;
      if (data.readUInt32LE(0) !== (kind === 'units' ? 0x7f5c70 : 0x7e3ebc))
        throw new Error(`Unexpected live ${kind} vtable at 0x${pointer.toString(16)}`);
      if (data.readUInt32LE(O.owner) !== localHouse) continue;
      const typePointer = data.readUInt32LE(kind === 'units' ? O.unitType : O.buildingType);
      if (typePointer < 0x10000 || typePointer % 4 || typePointer + 0x3c > 0x100000000)
        throw new Error(`Invalid owned ${kind} type pointer at 0x${pointer.toString(16)}`);
      const uid = data.readUInt32LE(O.uid),
        x = data.readInt32LE(O.location),
        y = data.readInt32LE(O.location + 4);
      if (!uid || Math.abs(x) > 512 * 256 || Math.abs(y) > 512 * 256)
        throw new Error(`Invalid owned ${kind} identity/location at 0x${pointer.toString(16)}`);
      objects.push({
        pointer,
        uid,
        type: await id(typePointer),
        selected: Boolean(data[O.selected]),
        health: data.readInt32LE(0x6c),
        x,
        y,
        z: data.readInt32LE(O.location + 8),
      });
    }
  }
  return objects;
}
async function project(obj) {
  const tactical = await u32(G.tactical),
    view = await bytes(tactical + 0xb0, 8),
    zFactor = (await bytes(G.zFactor, 8)).readDoubleLE();
  if (!Number.isFinite(zFactor)) throw new Error('Invalid native projection factor');
  return {
    x: Math.trunc((30 * (obj.x - obj.y)) / 256) - view.readInt32LE(0),
    y:
      Math.trunc((15 * (obj.x + obj.y)) / 256) -
      Math.trunc(obj.z * zFactor + (obj.z >= 728 ? 1 : 0) + 0.5) -
      view.readInt32LE(4),
  };
}
async function shot(label) {
  let timer;
  const delivered = new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      pendingPicture = null;
      reject(new Error('Native picture timeout'));
    }, 5000);
    pendingPicture = (f) => {
      clearTimeout(timer);
      resolve(f);
    };
  });
  try {
    await client.request(Type.CREDIT, words(1));
    const f = await delivered;
    writePng(resolve(out, `deploy-${stamp}-${label}.png`), f);
    return f;
  } finally {
    clearTimeout(timer);
    pendingPicture = null;
  }
}
async function deploy() {
  const existing = (await owned('buildings')).find((b) => /CNST$/.test(b.type));
  if (existing) {
    result.deployment = { alreadyDeployed: true, yard: existing };
    return existing;
  }
  const mcv = (await owned('units')).find((u) => /^(AMCV|SMCV|PCV)$/.test(u.type));
  if (!mcv) throw new Error('No live local MCV or construction yard');
  const attempts = [];
  for (let attempt = 0; attempt < 3; attempt++) {
    const now = (await owned('units')).find((u) => u.uid === mcv.uid);
    if (!now) break;
    const p = await project(now);
    await click(p.x, p.y + attempt * 3);
    await delay(250);
    const selected = (await owned('units')).find((u) => u.uid === mcv.uid)?.selected ?? false;
    attempts.push({ point: p, selected });
    console.log('select-mcv', JSON.stringify(attempts.at(-1)));
    if (!selected) continue;
    await key(0x44, 0x20);
    const until = performance.now() + 15000;
    while (performance.now() < until) {
      await delay(500);
      const yard = (await owned('buildings')).find((b) => /CNST$/.test(b.type));
      if (yard && !(await owned('units')).some((u) => u.uid === mcv.uid)) {
        result.deployment = { mcv, attempts, yard, verified: true, frame: await u32(G.frame) };
        console.log('deployed', JSON.stringify(result.deployment));
        return yard;
      }
    }
  }
  result.deployment = { mcv, attempts, verified: false };
  throw new Error('Ordinary click/D did not replace the selected MCV with an owned construction yard');
}
async function tab(index) {
  const r = await bytes(G.tabs + index * 0x60 + 0xc, 16);
  await click(r.readInt32LE(0) + r.readInt32LE(8) / 2, r.readInt32LE(4) + r.readInt32LE(12) / 2);
  await delay(150);
  const actual = await u32(G.sidebar + 0x539c);
  if (actual !== index) throw new Error(`Native sidebar tab ${index} click left active tab ${actual}`);
}
async function cameo(wanted) {
  const active = await u32(G.sidebar + 0x539c);
  if (active > 3) throw new Error('Invalid sidebar active tab');
  const strip = await bytes(STRIPS + active * STRIP_SIZE, STRIP_SIZE),
    count = strip.readUInt32LE(0x54),
    top = strip.readUInt32LE(0x44),
    pitch = await bytes(G.pitchX, 8);
  if (count > 75 || top > 37) throw new Error('Invalid sidebar cameo bounds');
  const arrays = new Map();
  for (let i = 0; i < count; i++) {
    const at = 0x58 + i * 0x34,
      kind = strip.readUInt32LE(at + 4),
      index = strip.readUInt32LE(at);
    const vector =
      kind === 6 || kind === 7
        ? 0xa83c68
        : kind === 1 || kind === 40
          ? 0xa83ce0
          : kind === 15 || kind === 16
            ? 0xa8e348
            : 0;
    if (!vector) continue;
    if (!arrays.has(vector)) arrays.set(vector, await pointers(vector));
    const type = arrays.get(vector)[index];
    if (!type) continue;
    if ((await id(type)) !== wanted) continue;
    const row = Math.floor(i / 2) - top;
    if (row < 0) throw new Error(`${wanted} is scrolled above the visible strip`);
    const x = strip.readInt32LE(0x20) + (i % 2) * pitch.readInt32LE(0) + 30;
    const y = strip.readInt32LE(0x24) + 1 + row * pitch.readInt32LE(4) + 24;
    if (y >= strip.readInt32LE(0x24) + (await u32(0xb0b504))) throw new Error(`${wanted} is below the visible strip`);
    const factory = strip.readUInt32LE(at + 0xc);
    let ready = false;
    if (factory) {
      const f = await bytes(factory, 0x74);
      ready = f.readInt32LE(0x24) === 54 && (f.readUInt32LE(0x58) !== 0 || f.readInt32LE(0x68) !== -1);
    }
    return { id: wanted, x, y, factory, ready };
  }
  return null;
}
async function build(wanted, tabIndex, yard) {
  const existing = await owned('buildings');
  if (['NAPOWR', 'NAHAND', 'NAREFN', 'NAWEAP'].includes(wanted)) {
    const reused = existing.find((b) => b.type === wanted);
    if (reused) {
      result.buildings.push({ type: wanted, reused: true, placed: reused, frame: await u32(G.frame) });
      console.log('reuse-building', JSON.stringify(result.buildings.at(-1)));
      return reused;
    }
  }
  await tab(tabIndex);
  const target = await cameo(wanted);
  if (!target) throw new Error(`Native sidebar does not offer ${wanted}`);
  const before = new Set(existing.map((b) => b.uid));
  if (!target.ready && !target.factory) await click(target.x, target.y);
  const until = performance.now() + 90000;
  let ready = null;
  while (performance.now() < until) {
    await delay(700);
    ready = await cameo(wanted);
    if (ready?.ready) break;
    checked();
  }
  if (!ready?.ready) throw new Error(`${wanted} did not reach the native ready state`);
  await click(ready.x, ready.y);
  await delay(300);
  await shot(`placement-${wanted}`);
  // Candidate cells surround observed owned foundations, including extensions of the base.
  // The original game decides terrain, foundation collision, shroud and adjacency legality.
  const anchors = (await owned('buildings')).filter((b) => !['NALASR', 'NATSLA'].includes(b.type));
  if (!anchors.length) anchors.push(yard);
  const cells = new Map();
  for (const anchor of anchors)
    for (let dx = -6; dx <= 6; dx++)
      for (let dy = -6; dy <= 6; dy++) {
        const distance = Math.max(Math.abs(dx), Math.abs(dy));
        if (distance < 2) continue;
        const cx = Math.floor(anchor.x / 256) + dx,
          cy = Math.floor(anchor.y / 256) + dy;
        const key = `${cx},${cy}`,
          previous = cells.get(key);
        const candidate = { x: cx * 256 + 128, y: cy * 256 + 128, z: anchor.z, distance, cx, cy };
        if (!previous || distance < previous.distance) cells.set(key, candidate);
      }
  const candidates = [...cells.values()].sort((a, b) => a.distance - b.distance || a.cy - b.cy || a.cx - b.cx);
  let attempts = 0;
  for (const candidate of candidates) {
    const point = await project(candidate);
    const x = Math.round(point.x),
      y = Math.round(point.y);
    if (x < 40 || x >= width - 190 || y < 40 || y >= height - 60) continue;
    if (++attempts > 160) break;
    await click(x, y);
    await delay(220);
    const placed = (await owned('buildings')).find((b) => b.type === wanted && !before.has(b.uid));
    if (placed) {
      result.buildings.push({
        type: wanted,
        placed,
        placement: { cell: [candidate.cx, candidate.cy], point: [x, y], attempts },
        frame: await u32(G.frame),
      });
      console.log('built', JSON.stringify(result.buildings.at(-1)));
      return placed;
    }
  }
  result.placementFailure = {
    wanted,
    attempts,
    input: JSON.parse((await client.request(Type.INPUT_STATE)).toString()),
    cameo: await cameo(wanted),
    frame: await u32(G.frame),
  };
  await shot(`failed-${wanted}`);
  throw new Error(`${wanted} was ready but no ordinary placement attempt created the building`);
}
async function queue(wanted, tabIndex, count) {
  await tab(tabIndex);
  const target = await cameo(wanted);
  if (!target) throw new Error(`Native sidebar does not offer ${wanted}`);
  for (let i = 0; i < count; i++) {
    await click(target.x, target.y);
    await delay(80);
  }
  result.queues.push({
    type: wanted,
    requestedClicks: count,
    frame: await u32(G.frame),
    production: 'UNVERIFIED until later owned-object observation',
  });
  console.log('queue-input', JSON.stringify(result.queues.at(-1)));
}
try {
  result.hello = await client.connect();
  if (
    !result.hello.exe?.verified ||
    result.hello.exe.sha256 !== '7b8a068535d6af06845edf95ae829b113d00c02909330e16f197426cd7db94b6'
  )
    throw new Error('Unsupported original executable');
  width = result.hello.surface.width;
  height = result.hello.surface.height;
  localHouse = await u32(G.localHouse);
  if (!localHouse) throw new Error('No local house; enter a match first');
  result.inputBefore = JSON.parse((await client.request(Type.INPUT_STATE)).toString());
  if (result.inputBefore.modal)
    throw new Error('Native modal dialog is active; resume the actual mission through protocol before deployment');
  await shot('before');
  const yard = await deploy();
  await shot('deployed');
  if (!o['deploy-only']) {
    if (yard.type !== 'NACNST') throw new Error('Defense sequence currently supports the supplied Soviet player only');
    await build('NAPOWR', 0, yard);
    await build('NAHAND', 0, yard);
    await build('NAREFN', 0, yard);
    await queue('SHK', 2, 4);
    const existingSentries = (await owned('buildings')).filter((b) => b.type === 'NALASR').length;
    for (let i = existingSentries; i < 2; i++) await build('NALASR', 1, yard);
    await build('NAWEAP', 0, yard);
    await queue('HTNK', 3, 12);
    await shot('defense');
  }
  result.inputAfter = JSON.parse((await client.request(Type.INPUT_STATE)).toString());
  result.finalBuildings = await owned('buildings');
  result.finalUnits = await owned('units');
  result.finalFrame = await u32(G.frame);
} catch (e) {
  result.error = e.stack;
  process.exitCode = 1;
  console.error(e.message);
} finally {
  completed = true;
  client.close();
  writeFileSync(resolve(out, `deploy-defense-${stamp}.json`), JSON.stringify(result, null, 2));
  appendFileSync(
    resolve(out, 'NOTES.md'),
    `\n## Protocol deploy/defense ${stamp}\n\n${JSON.stringify(result, null, 2)}\n`,
  );
  console.log(JSON.stringify(result, null, 2));
}
