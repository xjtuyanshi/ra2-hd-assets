#!/usr/bin/env node
// Exercise genuine prerequisite failures in the current CLI without permitting
// Wine, build tools, page servers or other subprocesses inside that CLI.
// Optional live-failure uses the real Wine/launcher with an unchanged owned
// executable in an isolated directory missing its required DLLs/resources.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { outputDirectory, WT } from './artifacts.mjs';
import { ownerOpenBoundary } from './owner-open-boundary.mjs';
import { readWineSelfCheckEvidence } from './launcher-wine-evidence.mjs';

const base = outputDirectory();
const phaseName = process.argv[2] || 'phase12';
assert(/^phase[0-9]+$/.test(phaseName), 'A numbered session is required');
const liveFailure = process.argv[3] === 'live-failure';
assert(process.argv[3] === undefined || liveFailure, 'Expected optional live-failure mode');
const phase = join(base, phaseName);
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
const isolatedGame = join(run, 'incomplete-owned-game');
if (liveFailure) {
  await mkdir(isolatedGame, { mode: 0o700 });
  await copyFile(join(gameDirectory, 'gamemd.exe'), join(isolatedGame, 'gamemd.exe'));
  const isolatedExecutable = await identity(join(isolatedGame, 'gamemd.exe'));
  assert.equal(isolatedExecutable.sha256, before['gamemd.exe'].sha256, 'The isolated executable must be unchanged');
}
const guardPath = join(run, 'no-subprocess-import.mjs');
if (!liveFailure)
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
  scope: liveFailure
    ? 'Real successful Wine self-check followed by a genuine game startup failure from an isolated unchanged player-owned executable missing its dependencies/resources'
    : 'Current CLI prerequisite failures with real configured development paths and actual filesystem absence; Wine execution is prohibited',
  startedAt: new Date().toISOString(),
  realWineRun: false,
  gameStarted: false,
  browserStarted: false,
  simulatedWineReply: false,
  source: {
    launcher: await identity(join(WT, 'scripts/remaster/native/play-native.mjs')),
    driver: await identity(fileURLToPath(import.meta.url)),
    boundary: await identity(join(WT, 'scripts/remaster/native/owner-open-boundary.mjs')),
    guard: liveFailure ? null : await identity(guardPath),
    trace: liveFailure ? await identity(join(WT, 'scripts/remaster/native/phase8-launch-trace.mjs')) : null,
  },
  cases: [],
  before,
  after: null,
  protectedFilesUnchanged: false,
  limitations: liveFailure
    ? [
        'Wine uses the existing dedicated scope; the driver does not alter bottle configuration. No complete bottle-file comparison is made.',
      ]
    : [
        'Game startup failure after a real successful Wine self-check is not exercised by this no-start preflight review',
      ],
  error: null,
};
const scenarios = liveFailure
  ? [
      {
        name: 'game-not-up-after-wine-check',
        overrides: { RA2_NATIVE_GAME_DIR: isolatedGame },
        expected: /游戏未能正常启动或已退出|游戏在 60 秒内没有进入可操作的主菜单/,
      },
    ]
  : [
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
      {
        name: 'missing-hd-cache',
        overrides: { RA2_HD_CACHE_DIR: join(run, 'absent-cache') },
        expected: /找不到高清缓存/,
      },
    ];
try {
  for (const scenario of scenarios) {
    await boundary.waitForOwnerIdle();
    const guardLog = join(run, scenario.name + '-guard.jsonl');
    const child = spawn(
      process.execPath,
      liveFailure
        ? [join(WT, 'scripts/remaster/native/phase8-launch-trace.mjs'), '--size', '1728x1117']
        : ['--import', guardPath, join(WT, 'scripts/remaster/native/play-native.mjs'), '--size', '1728x1117'],
      {
        cwd: WT,
        env: { ...environment, ...scenario.overrides, NATIVE_PREFLIGHT_GUARD_LOG: guardLog },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let output = '';
    let timedOut = false;
    const timer = setTimeout(
      () => {
        timedOut = true;
        // The real launcher owns its detached descendants and must unwind them
        // itself. A timed-out live attempt is never accepted as the intended fault.
        child.kill(liveFailure ? 'SIGTERM' : 'SIGKILL');
      },
      liveFailure ? 150000 : 10000,
    );
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
    const guardRecords = liveFailure
      ? []
      : (await readFile(guardLog, 'utf8'))
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
    if (liveFailure) {
      result.runDirectory = output.match(/Private launch logs and DLL backups: ([^\r\n]+)/)?.[1] ?? null;
      assert(
        result.runDirectory?.startsWith(join(WT, 'packages/native-host/build/play-')),
        'Owned launch directory required',
      );
      const wine = await readWineSelfCheckEvidence(result.runDirectory);
      report.realWineRun = wine.successful;
      result.wineSelfCheck = wine;
      result.launcherLog = await readFile(join(result.runDirectory, 'launcher.log'), 'utf8');
      result.wineLog = await readFile(join(result.runDirectory, 'wine.log'), 'utf8');
      result.nativeGameProcessCreated = /started pid=\d+/.test(result.launcherLog);
      result.realLauncherAttempted =
        result.nativeGameProcessCreated ||
        /CreateProcess|handshake did not complete|binkw32|c0000135/i.test(result.launcherLog + result.wineLog);
      result.sessionState = JSON.parse(await readFile(join(result.runDirectory, 'session-state.json'), 'utf8'));
      result.isolatedDllRemoved = (await identity(join(isolatedGame, 'ddraw.dll'))).absent === true;
      assert(wine.successful && output.includes('Wine 自检通过。'), 'Real Wine self-check must succeed first');
      assert(result.realLauncherAttempted, 'Actual Wine/game startup failure evidence is required');
      assert(result.expectedChineseFailure && result.printedNoPlayUrl, 'Expected actual game-not-up failure');
      assert(
        result.sessionState.state === 'failed' && result.isolatedDllRemoved,
        'Failed launch cleanup must complete',
      );
    } else {
      assert(
        result.guardInstalled && attempts.length === 0,
        'The prerequisite error must occur before any internal subprocess attempt',
      );
      assert(
        result.expectedChineseFailure && result.startedNoRunDirectory && result.printedNoPlayUrl,
        'Unexpected prerequisite result',
      );
    }
    await active();
  }
} catch (error) {
  report.error = String(error.stack ?? error);
} finally {
  report.after = await protectedFiles();
  report.protectedFilesUnchanged = JSON.stringify(report.before) === JSON.stringify(report.after);
  report.finishedAt = new Date().toISOString();
  report.met = !report.error && report.cases.length === (liveFailure ? 1 : 3) && report.protectedFilesUnchanged;
  const reportPath = join(run, 'summary.json');
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  await writeFile(
    join(phase, liveFailure ? 'launcher-live-startup-failure-current.json' : 'launcher-preflight-faults-current.json'),
    JSON.stringify({ reportPath, ...report }, null, 2) + '\n',
    { mode: 0o600 },
  );
  console.log(JSON.stringify({ reportPath, cases: report.cases, met: report.met, error: report.error }));
  if (!report.met) process.exitCode = 1;
}
