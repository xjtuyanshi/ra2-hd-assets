#!/usr/bin/env node
// Speed-setting provenance for an external no-client probe; never installs a hook.
import { parseArgs } from 'node:util';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { AgentClient, Type, words } from './wire.mjs';
import { outputDirectory } from './artifacts.mjs';

const { values: o } = parseArgs({
  options: {
    url: { type: 'string', default: process.env.RA2_NATIVE_AGENT_URL || 'ws://127.0.0.1:15450' },
    token: { type: 'string', default: process.env.RA2_NATIVE_AGENT_TOKEN },
    origin: { type: 'string', default: process.env.RA2_NATIVE_AGENT_ORIGIN || 'http://127.0.0.1:15451' },
    out: { type: 'string' },
    speed: { type: 'string' },
    'restore-speed': { type: 'string' },
    label: { type: 'string', default: 'speed-proof' },
    'wait-objects': { type: 'string', default: '0' },
  },
});
// A setting marker leaves that setting applied; the following verification
// marker returns the measurement scene to owner speed after its final sample.
o['restore-speed'] ??= o.speed === undefined ? '1' : undefined;
if (!o.token) throw new Error('Supply a configured token');
if (o.speed !== undefined && !/^[0-6]$/.test(o.speed)) throw new Error('Invalid speed');
if (o['restore-speed'] !== undefined && !/^[0-6]$/.test(o['restore-speed'])) throw new Error('Invalid restore speed');
if (!/^[a-zA-Z0-9_-]+$/.test(o.label)) throw new Error('Invalid proof label');
if (!/^\d+$/.test(o['wait-objects']) || +o['wait-objects'] > 120) throw new Error('Invalid object wait');
const client = new AgentClient(o.url, o.token, o.origin);
let failure = null;
client.on('failure', (error) => (failure = error));
client.on('agent-error', (error) => (failure = error));
const proof = { mode: 'no-hook-speed-proof', samples: [], diagnostics: null, error: null };
async function sample() {
  const bytes = (await client.read(0xa8e000, 4096)).bytes;
  return {
    frame: bytes.readUInt32LE(0xd84),
    gameSpeed: bytes.readUInt32LE(0xb60),
    objects: bytes.readUInt32LE(0xc88),
    sessionType: (await client.read(0xa8b238, 4)).bytes.readUInt32LE(),
    sessionSpeed: (await client.read(0xa8b268, 4)).bytes.readUInt32LE(),
    at: new Date().toISOString(),
  };
}
try {
  const hello = await client.connect();
  if (!hello.exe?.verified || hello.exe.sha256 !== '7b8a068535d6af06845edf95ae829b113d00c02909330e16f197426cd7db94b6')
    throw new Error('Unsupported executable');
  proof.pid = hello.pid;
  proof.protocol = hello.protocol;
  proof.exeHash = hello.exe.sha256;
  proof.verified = hello.exe.verified;
  proof.connectedAt = new Date().toISOString();
  proof.before = await sample();
  const deadline = performance.now() + +o['wait-objects'] * 1000;
  while (+o['wait-objects'] && (proof.before.objects < 150 || proof.before.objects > 250)) {
    if (failure) throw failure;
    if (performance.now() >= deadline) throw new Error('Target object range did not arrive');
    await delay(500);
    proof.before = await sample();
  }
  if (o.speed !== undefined) await client.request(Type.WRITE, Buffer.concat([words(0xa8eb60, 4), words(+o.speed)]));
  proof.samples.push(await sample());
  await delay(500);
  proof.samples.push(await sample());
  proof.diagnostics = JSON.parse((await client.request(Type.DIAGNOSTICS)).toString());
  if (failure) throw failure;
  if (proof.diagnostics.hookInstalled) throw new Error('Speed proof requires no installed streaming hook');
  if (o.speed !== undefined && proof.samples.some((row) => row.gameSpeed !== +o.speed))
    throw new Error('Game speed did not remain at the requested setting');
  proof.advancing = proof.samples[1].frame > proof.samples[0].frame;
  if (o['restore-speed'] !== undefined) {
    await client.request(Type.WRITE, Buffer.concat([words(0xa8eb60, 4), words(+o['restore-speed'])]));
    proof.restoredSpeed = (await client.read(0xa8eb60, 4)).bytes.readUInt32LE();
    if (proof.restoredSpeed !== +o['restore-speed']) throw new Error('Restore speed did not apply');
  }
} catch (error) {
  proof.error = error.stack;
  process.exitCode = 1;
} finally {
  try {
    if (client.ws.readyState !== 3)
      await new Promise((resolveClose, reject) => {
        const timer = setTimeout(() => reject(new Error('Client close timeout')), 3000);
        client.once('closed', () => {
          clearTimeout(timer);
          resolveClose();
        });
        client.close();
      });
    proof.closedAt = new Date().toISOString();
  } catch (error) {
    proof.error ??= error.stack;
    process.exitCode = 1;
  }
  const path = resolve(outputDirectory(o.out), `${o.label}.json`);
  writeFileSync(path, JSON.stringify(proof, null, 2));
  console.log(JSON.stringify(proof, null, 2));
}
