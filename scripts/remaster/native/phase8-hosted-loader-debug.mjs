import { spawn } from 'node:child_process';
import { readFile, mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
const out = process.env.NATIVE_OUT;
const config = JSON.parse(await readFile(join(out, 'run/owner-launch-smoke.json'), 'utf8'));
const taskTmp = await mkdtemp('/private/tmp/phase8-wine-');
for (const [label, extra] of [
  ['no-reexec', { WINELOADERNOEXEC: '1' }],
  ['fresh-temp', { TMPDIR: taskTmp }],
]) {
  const start = Date.now();
  let exited = false,
    code,
    stdout = '',
    stderr = '';
  const child = spawn(
    config.RA2_NATIVE_WINE,
    ['--bottle', config.RA2_NATIVE_WINE_BOTTLE, 'winepath.exe', '-w', config.RA2_NATIVE_GAME_DIR],
    {
      env: { ...process.env, ...config, ...extra, WINEDEBUG: '-all' },
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  child.stdout.on('data', (d) => (stdout += d));
  child.stderr.on('data', (d) => (stderr += d));
  child.once('exit', (c) => {
    exited = true;
    code = c;
  });
  for (let i = 0; i < 100 && !exited; i++) await delay(100);
  if (!exited)
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {}
  console.log(JSON.stringify({ label, ms: Date.now() - start, exited, code, stdout, stderr }));
  await delay(500);
}
