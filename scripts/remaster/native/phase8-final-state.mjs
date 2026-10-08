#!/usr/bin/env node
// Read-only final ownership and resource audit. Never stop unrelated processes.
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { lstat, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const wt = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const root = resolve(wt, '../..');
const out = join(root, 'gameres/s2x/native');
const config = JSON.parse(await readFile(join(out, 'run/owner-launch-smoke.json'), 'utf8'));
const sha256 = async (path) =>
  createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
const exists = async (path) =>
  !!(await lstat(path).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  }));
const inspect = (command, args) => {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 10000 });
  if (result.error) throw result.error;
  return { exit: result.status, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
};
const ps = inspect('/bin/ps', ['-Ao', 'pid,ppid,pgid,etime,comm']);
const proof = {
  recordedAt: new Date().toISOString(),
  nativeGameDirectory: config.RA2_NATIVE_GAME_DIR,
  nativeDllSha256: await sha256(join(config.RA2_NATIVE_GAME_DIR, 'ddraw.dll')),
  builtDllSha256: await sha256(join(wt, 'packages/native-host/build/ddraw.dll')),
  oneMapOverridePresent: await exists(join(config.RA2_NATIVE_GAME_DIR, 'missionsmd.pkt')),
  oneMapBackupSha256: await sha256(join(out, 'phase8/map-index-backup/missionsmd.pkt')),
  runnerScriptSha256: await sha256(join(out, 'run/devgame.sh')),
  ownerPausePresent: await exists(join(root, 'gameres/s2x/play/_slots/PAUSE')),
  nativeProcesses: ps.stdout.split('\n').filter((line) => /wine|gamemd|ra2launch|ra2ctl|CrossOver/i.test(line)),
  listeningTestPorts: inspect('/usr/sbin/lsof', ['-nP', '-iTCP:15450-15459', '-sTCP:LISTEN']),
  immutableEmulatorWorktreeStatus: inspect('git', ['-C', join(root, '.worktrees/s2-play8'), 'status', '--porcelain']),
  head: inspect('git', ['rev-parse', 'HEAD']),
  boundary: 'Inventory only. No process termination, game launch, bottle modification, asset write or security change.',
};
await writeFile(join(out, 'phase8/final-state.json'), `${JSON.stringify(proof, null, 2)}\n`, { flag: 'wx' });
process.stdout.write(`${JSON.stringify(proof, null, 2)}\n`);
