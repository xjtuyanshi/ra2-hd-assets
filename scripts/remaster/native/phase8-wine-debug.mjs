import { spawn, spawnSync } from 'node:child_process';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
const out = process.env.NATIVE_OUT;
const config = JSON.parse(await readFile(join(out, 'run/owner-launch-smoke.json'), 'utf8'));
const child = spawn(
  config.RA2_NATIVE_WINE,
  ['--bottle', config.RA2_NATIVE_WINE_BOTTLE, 'winepath.exe', '-w', config.RA2_NATIVE_GAME_DIR],
  {
    env: { ...process.env, ...config, CX_LOG: join(out, 'phase8/crossover-path.log') },
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  },
);
let output = '';
child.stdout.on('data', (c) => (output += c));
child.stderr.on('data', (c) => (output += c));
let exited = false;
child.once('exit', () => (exited = true));
await delay(3000);
const p = spawnSync('/bin/ps', ['-Ao', 'pid,ppid,pcpu,etime,comm'], { encoding: 'utf8', timeout: 5000 });
console.log(
  p.stdout
    ?.split('\n')
    .filter((l) => /wine|perl|CrossOver|python|cx/.test(l))
    .join('\n'),
);
const dir = join(process.env.TMPDIR || '/tmp', '.wine-' + process.getuid());
for (const f of (await readdir(dir)).filter((f) => f.endsWith('.lock'))) {
  const r = spawnSync('/usr/sbin/lsof', [join(dir, f)], { encoding: 'utf8', timeout: 5000 });
  console.log('Lock ' + f + '\n' + r.stdout);
}
console.log(JSON.stringify({ ownedWinePid: child.pid, exited, output }));
if (!exited)
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {}
await delay(1000);
console.log((await readFile(join(out, 'phase8/crossover-path.log'), 'utf8').catch(() => '')).slice(-18000));
