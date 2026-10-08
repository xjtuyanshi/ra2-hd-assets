import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
const o = process.env.NATIVE_OUT,
  c = JSON.parse(await readFile(join(o, 'run/owner-launch-smoke.json'), 'utf8'));
for (const probe of [
  { label: 'system-x86', command: '/usr/bin/arch', args: ['-x86_64', '/usr/bin/true'], env: process.env },
  {
    label: 'owned-Wine-no-AVX-diagnostic',
    command: c.RA2_NATIVE_WINE,
    args: ['--bottle', c.RA2_NATIVE_WINE_BOTTLE, 'winepath.exe', '-w', c.RA2_NATIVE_GAME_DIR],
    env: { ...process.env, ...c, ROSETTA_ADVERTISE_AVX: '0', WINEDEBUG: '-all' },
  },
]) {
  const t = Date.now(),
    r = spawnSync(probe.command, probe.args, { env: probe.env, encoding: 'utf8', timeout: 10000 });
  console.log(
    JSON.stringify({
      label: probe.label,
      ms: Date.now() - t,
      status: r.status,
      error: String(r.error || ''),
      stdout: r.stdout,
      stderr: r.stderr,
    }),
  );
}
