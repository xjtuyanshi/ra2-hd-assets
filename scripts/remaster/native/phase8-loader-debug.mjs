import { spawnSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
const bin = '/Applications/CrossOver.app/Contents/SharedSupport/CrossOver/bin';
for (const name of ['wineloader', 'wineserver']) {
  const t = Date.now();
  const r = spawnSync(join(bin, name), ['--version'], { encoding: 'utf8', timeout: 10000 });
  console.log(
    JSON.stringify({
      name,
      ms: Date.now() - t,
      status: r.status,
      error: String(r.error ?? ''),
      stdout: r.stdout,
      stderr: r.stderr,
    }),
  );
}
const r = spawnSync(
  '/usr/bin/log',
  [
    'show',
    '--last',
    '20m',
    '--style',
    'compact',
    '--predicate',
    'eventMessage CONTAINS[c] "wineloader" OR ((process == "oahd" OR process == "syspolicyd") AND eventMessage CONTAINS[c] "wine")',
  ],
  { encoding: 'utf8', timeout: 20000, maxBuffer: 2 * 1024 * 1024 },
);
const path = join(process.env.NATIVE_OUT, 'phase8/loader-system-log.txt');
await writeFile(path, r.stdout ?? '');
console.log(
  JSON.stringify({
    log: path,
    status: r.status,
    error: String(r.error ?? ''),
    stderr: r.stderr,
    tail: r.stdout?.slice(-18000),
  }),
);
