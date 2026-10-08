import { spawn, spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
const out = process.env.NATIVE_OUT,
  config = JSON.parse(await readFile(join(out, 'run/owner-launch-smoke.json'), 'utf8'));
const child = spawn(
  config.RA2_NATIVE_WINE,
  ['--bottle', config.RA2_NATIVE_WINE_BOTTLE, 'winepath.exe', '-w', config.RA2_NATIVE_GAME_DIR],
  { env: { ...process.env, ...config, WINEDEBUG: '-all' }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] },
);
let output = '',
  exited = false;
child.stdout.on('data', (c) => (output += c));
child.stderr.on('data', (c) => (output += c));
child.once('exit', () => (exited = true));
await delay(3000);
const sample = join(out, 'phase8/owned-winepath.sample.txt');
let r;
if (!exited)
  r = spawnSync('/usr/bin/sample', [String(child.pid), '1', '1', '-file', sample], {
    encoding: 'utf8',
    timeout: 15000,
  });
console.log(
  JSON.stringify({
    pid: child.pid,
    exited,
    output,
    sampleStatus: r?.status,
    sampleOutput: r?.stdout,
    sampleError: r?.stderr,
  }),
);
if (!exited)
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {}
await delay(1000);
console.log((await readFile(sample, 'utf8').catch(() => '')).slice(0, 22000));
