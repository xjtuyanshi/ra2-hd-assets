import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
const o = process.env.NATIVE_OUT,
  c = JSON.parse(await readFile(join(o, 'run/owner-launch-smoke.json'), 'utf8'));
const wa = [c.RA2_NATIVE_WINE, '--bottle', c.RA2_NATIVE_WINE_BOTTLE, 'winepath.exe', '-w', c.RA2_NATIVE_GAME_DIR];
for (const probe of [
  { label: 'x86-Perl-wrapper', command: '/usr/bin/arch', args: ['-x86_64', '/usr/bin/perl', ...wa] },
  { label: 'bash-exec-wrapper', command: '/bin/bash', args: ['-c', 'exec "$@"', 'phase8-wine-probe', ...wa] },
]) {
  const t = Date.now(),
    r = spawnSync(probe.command, probe.args, {
      env: { ...process.env, ...c, WINEDEBUG: '-all' },
      encoding: 'utf8',
      timeout: 10000,
    });
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
