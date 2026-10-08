import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
const out = process.env.NATIVE_OUT;
const p = spawnSync('/bin/ps', ['-Ao', 'pid,ppid,pcpu,etime,comm'], { encoding: 'utf8', timeout: 5000 });
console.log('Owned-test process observations');
console.log(
  p.stdout
    ?.split('\n')
    .filter((l) => /wine|gamemd|node|pnpm|esbuild/i.test(l))
    .join('\n'),
);
const config = JSON.parse(await readFile(join(out, 'run/owner-launch-smoke.json'), 'utf8'));
const t = Date.now();
const r = spawnSync(
  config.RA2_NATIVE_WINE,
  ['--bottle', config.RA2_NATIVE_WINE_BOTTLE, 'winepath.exe', '-w', config.RA2_NATIVE_GAME_DIR],
  { encoding: 'utf8', timeout: 15000, env: { ...process.env, ...config, WINEDEBUG: '-all' } },
);
console.log(
  JSON.stringify({
    winePathMs: Date.now() - t,
    status: r.status,
    error: String(r.error || ''),
    stdout: r.stdout,
    stderr: r.stderr,
  }),
);
