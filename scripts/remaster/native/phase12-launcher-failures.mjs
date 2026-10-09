#!/usr/bin/env node
// Exercise genuine prerequisite failures in the current CLI without permitting
// Wine, build tools, page servers or other subprocesses inside that CLI.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { outputDirectory, WT } from './artifacts.mjs';
import { ownerOpenBoundary } from './owner-open-boundary.mjs';

const base = outputDirectory();
const phase = join(base, 'phase12');
const boundary = await ownerOpenBoundary(phase, { ownerPausePath: resolve(base, '../play/_slots/PAUSE') });
const active = () => boundary.assertActive();
await boundary.waitForOwnerIdle();
const configPath = join(base, 'run/owner-launch-smoke.json');
const configBytes = await readFile(configPath);
const configuration = JSON.parse(configBytes);
const allowed = new Set([
  'RA2_NATIVE_GAME_DIR',
  'RA2_NATIVE_WINE_BOTTLE',
  'RA2_NATIVE_WINE_PREFIX',
  'RA2_NATIVE_WINE',
  'RA2_HD_CACHE_DIR',
  'CX_BOTTLE_PATH',
]);
assert(configuration && typeof configuration === 'object' && !Array.isArray(configuration));
for (const [key, value] of Object.entries(configuration))
  assert(
    allowed.has(key) && typeof value === 'string' && value && !value.includes('\0'),
    'Unsupported private configuration',
  );
assert(configuration.RA2_NATIVE_GAME_DIR && configuration.RA2_NATIVE_WINE, 'Explicit game and Wine paths are required');
assert(
  !!configuration.RA2_NATIVE_WINE_BOTTLE !== !!configuration.RA2_NATIVE_WINE_PREFIX,
  'Exactly one existing private Wine scope is required',
);
const environment = { ...process.env, ...configuration };
if (configuration.RA2_NATIVE_WINE_BOTTLE) {
  delete environment.RA2_NATIVE_WINE_PREFIX;
  delete environment.WINEPREFIX;
} else delete environment.RA2_NATIVE_WINE_BOTTLE;
const gameDirectory = resolve(configuration.RA2_NATIVE_GAME_DIR);
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
async function identity(path) {
  try {
    const [bytes, info] = await Promise.all([readFile(path), lstat(path)]);
    return { sha256: sha(bytes), bytes: bytes.length, mode: info.mode & 0o777, inode: info.ino };
  } catch (error) {
    if (error.code === 'ENOENT') return { absent: true };
    throw error;
  }
}
async function protectedFiles() {
  const iniNames = (await readdir(gameDirectory)).filter((name) => /^ra2md\.ini$|^ddraw\.ini$/i.test(name)).sort();
  const files = {};
  for (const name of ['gamemd.exe', 'ddraw.dll', ...iniNames]) files[name] = await identity(join(gameDirectory, name));
  files.privateConfiguration = await identity(configPath);
  return files;
}
const before = await protectedFiles();
assert(!before['gamemd.exe'].absent, 'The supplied development game copy is required');
await mkdir(join(phase, 'preflight-faults'), { recursive: true });
const run = await mkdtemp(join(phase, 'preflight-faults/run-'));
await chmod(run, 0o700);
const guardPath = join(run, 'no-subprocess-import.mjs');
await writeFile(
  guardPath,
  `import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {appendFileSync} from 'node:fs';
const path=process.env.NATIVE_PREFLIGHT_GUARD_LOG;
appendFileSync(path,JSON.stringify({kind:'guard-installed'})+'\\n',{mode:0o600});
for(const name of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork'])
  childProcess[name]=()=>{
    appendFileSync(path,JSON.stringify({kind:'subprocess-refused',operation:name})+'\\n');
    throw new Error('Preflight safety guard refused an unexpected subprocess operation: '+name);
  };
syncBuiltinESMExports();
`,
  { mode: 0o600 },
);
const report = {
  scope:
    'Current CLI prerequisite failures with real configured development paths and actual filesystem absence; Wine execution is prohibited',
  startedAt: new Date().toISOString(),
  realWineRun: false,
  gameStarted: false,
  browserStarted: false,
  simulatedWineReply: false,
  source: {
    launcher: await identity(join(WT, 'scripts/remaster/native/play-native.mjs')),
    driver: await identity(fileURLToPath(import.meta.url)),
    boundary: await identity(join(WT, 'scripts/remaster/native/owner-open-boundary.mjs')),
    guard: await identity(guardPath),
  },
  cases: [],
  before,
  after: null,
  protectedFilesUnchanged: false,
  limitations: [
    'Game startup failure after a real successful Wine self-check is not exercised by this no-start preflight review',
  ],
  error: null,
};
const scenarios = [
  {
    name: 'missing-game-folder',
    overrides: { RA2_NATIVE_GAME_DIR: join(run, 'absent-game') },
    expected: /找不到游戏程序/,
  },
  {
    name: 'missing-wine-executable',
    overrides: { RA2_NATIVE_WINE: join(run, 'absent-wine') },
    expected: /找不到 Wine 程序/,
  },
  { name: 'missing-hd-cache', overrides: { RA2_HD_CACHE_DIR: join(run, 'absent-cache') }, expected: /找不到高清缓存/ },
];
try {
  for (const scenario of scenarios) {
    await boundary.waitForOwnerIdle();
    const guardLog = join(run, scenario.name + '-guard.jsonl');
    const child = spawn(
      process.execPath,
      ['--import', guardPath, join(WT, 'scripts/remaster/native/play-native.mjs'), '--size', '1728x1117'],
      {
        cwd: WT,
        env: { ...environment, ...scenario.overrides, NATIVE_PREFLIGHT_GUARD_LOG: guardLog },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let output = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, 10000);
    for (const stream of [child.stdout, child.stderr]) {
      stream.setEncoding('utf8');
      stream.on('data', (chunk) => (output = (output + chunk).slice(-65536)));
    }
    let exit;
    try {
      exit = await new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('close', (code, signal) => resolve({ code, signal }));
      });
    } finally {
      clearTimeout(timer);
    }
    await writeFile(join(run, scenario.name + '-output.log'), output, { mode: 0o600 });
    const guardRecords = (await readFile(guardLog, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    const attempts = guardRecords.filter((item) => item.kind === 'subprocess-refused');
    const result = {
      name: scenario.name,
      exit,
      timedOut,
      outputArtifact: scenario.name + '-output.log',
      guardArtifact: scenario.name + '-guard.jsonl',
      subprocessAttemptsInsideCli: attempts.length,
      guardInstalled: guardRecords.some((item) => item.kind === 'guard-installed'),
      expectedChineseFailure: scenario.expected.test(output),
      startedNoRunDirectory: !output.includes('Private launch logs and DLL backups:'),
      printedNoPlayUrl: !output.includes('Play URL:'),
    };
    report.cases.push(result);
    assert(
      !timedOut && exit.code === 1 && !exit.signal,
      'The current CLI must exit through its actual prerequisite error',
    );
    assert(
      result.guardInstalled && attempts.length === 0,
      'The prerequisite error must occur before any internal subprocess attempt',
    );
    assert(
      result.expectedChineseFailure && result.startedNoRunDirectory && result.printedNoPlayUrl,
      'Unexpected prerequisite result',
    );
    await active();
  }
} catch (error) {
  report.error = String(error.stack ?? error);
} finally {
  report.after = await protectedFiles();
  report.protectedFilesUnchanged = JSON.stringify(report.before) === JSON.stringify(report.after);
  report.finishedAt = new Date().toISOString();
  report.met = !report.error && report.cases.length === 3 && report.protectedFilesUnchanged;
  const reportPath = join(run, 'summary.json');
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  await writeFile(
    join(phase, 'launcher-preflight-faults-current.json'),
    JSON.stringify({ reportPath, ...report }, null, 2) + '\n',
    { mode: 0o600 },
  );
  console.log(JSON.stringify({ reportPath, cases: report.cases, met: report.met, error: report.error }));
  if (!report.met) process.exitCode = 1;
}
