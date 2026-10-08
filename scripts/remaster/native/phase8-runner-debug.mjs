import { spawnSync } from 'node:child_process';
console.log(JSON.stringify({ node: process.execPath, path: process.env.PATH }));
for (const args of [
  ['/usr/bin/which', ['pnpm']],
  ['pnpm', ['--version']],
  ['pnpm', ['--filter', 'relay-package', 'run', 'build:lib']],
]) {
  const t = Date.now();
  const r = spawnSync(args[0], args[1], { encoding: 'utf8', timeout: 15000 });
  console.log(
    JSON.stringify({
      command: args,
      ms: Date.now() - t,
      status: r.status,
      error: String(r.error || ''),
      stdout: r.stdout,
      stderr: r.stderr,
    }),
  );
}
