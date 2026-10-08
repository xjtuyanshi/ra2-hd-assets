#!/usr/bin/env node
// One bounded path-query diagnosis only. CrossOver --ux-app preserves its bottle environment but skips winewrapper.exe.
import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
const base = process.env.NATIVE_OUT;
const config = JSON.parse(await readFile(join(base, 'run/owner-launch-smoke.json'), 'utf8'));
const cxRoot = resolve(dirname(config.RA2_NATIVE_WINE), '..');
const args = [
  '--bottle',
  config.RA2_NATIVE_WINE_BOTTLE,
  '--ux-app',
  join(cxRoot, 'bin/wineloader'),
  join(cxRoot, 'lib/wine/i386-windows/winepath.exe'),
  '-w',
  config.RA2_NATIVE_GAME_DIR,
];
const child = spawn(config.RA2_NATIVE_WINE, args, {
  env: { ...process.env, ...config, WINEDEBUG: '-all', CX_LOG: join(base, 'phase8/direct-pe-path.log') },
  detached: true,
  stdio: ['ignore', 'pipe', 'pipe'],
});
let output = '',
  exited = false;
child.stdout.on('data', (chunk) => {
  output = (output + chunk.toString()).slice(-8000);
});
child.stderr.on('data', (chunk) => {
  output = (output + chunk.toString()).slice(-8000);
});
const startedAt = Date.now();
const result = await Promise.race([
  new Promise((resolve) =>
    child.once('exit', (code, signal) => {
      exited = true;
      resolve({ code, signal });
    }),
  ),
  delay(10000, undefined, { ref: false }).then(() => ({ timeout: true })),
]);
if (!exited)
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
await delay(500);
const proof = {
  kind: 'Read-only existing-bottle path-query diagnosis',
  args,
  ms: Date.now() - startedAt,
  ...result,
  output,
  interpretationBoundary:
    'This skips winewrapper.exe through CrossOver documented --ux-app. It does not start a game, change a bottle/global setting or prove native game acceptance.',
};
await writeFile(join(base, 'phase8/direct-pe-path.json'), JSON.stringify(proof, null, 2));
console.log(JSON.stringify(proof));
console.log((await readFile(join(base, 'phase8/direct-pe-path.log'), 'utf8').catch(() => '')).slice(-6000));
