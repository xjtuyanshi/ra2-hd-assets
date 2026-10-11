#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFile, chmod, lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { ownerOpenBoundary } from './owner-open-boundary.mjs';

const { values: options } = parseArgs({
  options: {
    out: { type: 'string', default: process.env.NATIVE_OUT },
    config: { type: 'string' },
    size: { type: 'string' },
    'hold-seconds': { type: 'string', default: '60' },
    'session-dir': { type: 'string' },
    help: { type: 'boolean' },
  },
});
if (options.help) {
  console.log(
    'owner-open-acceptance.mjs --out OUT [--config private.json] [--size WxH] [--hold-seconds 1..90] [--session-dir DIR]\n' +
      'Starts play-native.sh --open in Google Chrome. Private OUT/browser/owner-open-current.json contains the exact URL and closeProofPath for CUA review. The actual page area determines the game size unless --size is supplied. Holds the ready page for 60 seconds by default; root must close the exact launch tab through CUA and write its closure proof. --session-dir opts into deadline.json/cancel guards and waiting for the owner connection to close before launch; the same guards stop this owned run after cancellation/expiry. Finally stops its owned launcher/game. This wrapper does not establish visible UI acceptance or control Chrome tabs.',
  );
  process.exit(0);
}
if (!options.out) throw new Error('Supply --out OUT or NATIVE_OUT');
const holdSeconds = Number(options['hold-seconds']);
if (!Number.isInteger(holdSeconds) || holdSeconds < 1 || holdSeconds > 90)
  throw new Error('--hold-seconds must be an integer from 1 through 90');
if (process.platform !== 'darwin') throw new Error('Google Chrome owner-open acceptance requires macOS');

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const out = resolve(options.out);
const browserOut = join(out, 'browser');
await mkdir(browserOut, { recursive: true });
const stamp = new Date().toISOString().replaceAll(':', '-');
const reportPath = join(browserOut, `${stamp}-owner-open.json`);
const currentPath = join(browserOut, 'owner-open-current.json');
const logPath = join(browserOut, `${stamp}-owner-open-launcher.log`);
const closeProofPath = join(browserOut, `${stamp}-owner-open-close-proof.json`);
const allowed = new Set([
  'RA2_NATIVE_GAME_DIR',
  'RA2_NATIVE_WINE_BOTTLE',
  'RA2_NATIVE_WINE_PREFIX',
  'RA2_NATIVE_WINE',
  'RA2_HD_CACHE_DIR',
  'CX_BOTTLE_PATH',
]);
let configuration = {};
const configPath = options.config || (!process.env.RA2_NATIVE_GAME_DIR && join(out, 'run/owner-launch-smoke.json'));
if (configPath) {
  const stat = await lstat(configPath);
  if (!stat.isFile() || stat.size > 16384) throw new Error('Expected a bounded regular private configuration file');
  configuration = JSON.parse(await readFile(configPath, 'utf8'));
  if (!configuration || Array.isArray(configuration) || typeof configuration !== 'object')
    throw new Error('Private configuration must be a JSON object');
  for (const [key, value] of Object.entries(configuration)) {
    if (!allowed.has(key) || typeof value !== 'string' || !value || value.includes('\0'))
      throw new Error('Private configuration contains an unsupported key/value');
  }
}
const environment = { ...process.env, ...configuration };
if (configuration.RA2_NATIVE_WINE_BOTTLE) {
  delete environment.RA2_NATIVE_WINE_PREFIX;
  delete environment.WINEPREFIX;
} else if (configuration.RA2_NATIVE_WINE_PREFIX) delete environment.RA2_NATIVE_WINE_BOTTLE;
if (!environment.RA2_NATIVE_GAME_DIR) throw new Error('A supplied owned game copy is required');
const redact = (value) => String(value).replace(/agent-token=[a-f0-9]+/gi, 'agent-token=[redacted]');
const report = {
  mode: 'real-owner-open-for-cua',
  startedAt: new Date().toISOString(),
  phase: 'starting',
  holdSeconds,
  requestedSize: options.size ?? 'actual-page-area',
  url: null,
  runDirectory: null,
  observedPid: null,
  closeProofPath,
  rootMustCloseTab: true,
  gates: {
    readyUrl: false,
    exactChromeTabsClosed: false,
    cleanExit: false,
    ownedGameStopped: false,
    portsReleased: false,
    dllRestored: false,
  },
  visibleUiAcceptance: 'UNVERIFIED: root CUA evidence is separate',
  error: null,
};
async function privateWrite(path, contents) {
  await writeFile(path, contents, { mode: 0o600 });
  await chmod(path, 0o600);
}
async function save() {
  const bytes = JSON.stringify(report, null, 2);
  await privateWrite(reportPath, bytes);
  await privateWrite(currentPath, bytes);
}
async function dllIdentity(path) {
  try {
    const [bytes, stat] = await Promise.all([readFile(path), lstat(path)]);
    return { exists: true, sha256: createHash('sha256').update(bytes).digest('hex'), mode: stat.mode & 0o777 };
  } catch (error) {
    if (error.code === 'ENOENT') return { exists: false };
    throw error;
  }
}
async function released(port) {
  const server = createServer();
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen({ host: '127.0.0.1', port, exclusive: true }, resolve);
    });
    return true;
  } catch (error) {
    if (error.code === 'EADDRINUSE') return false;
    throw error;
  } finally {
    if (server.listening) await new Promise((resolve) => server.close(resolve));
  }
}
async function readCloseProof() {
  try {
    const stat = await lstat(closeProofPath);
    if (!stat.isFile() || stat.size > 4096) throw new Error('Expected a bounded regular CUA closure proof');
    const proof = JSON.parse(await readFile(closeProofPath, 'utf8'));
    return proof.closed === true && proof.url === report.url && proof.source === 'CUA' ? proof : null;
  } catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) return null;
    throw error;
  }
}

let child,
  childExit,
  exited = false,
  exitCode = null,
  exitSignal = null,
  output = '',
  interrupted = false;
const signal = () => {
  interrupted = true;
};
for (const name of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(name, signal);
const dllPath = join(resolve(environment.RA2_NATIVE_GAME_DIR), 'ddraw.dll');
let boundary;
try {
  if (options['session-dir']) {
    boundary = await ownerOpenBoundary(options['session-dir'], {
      ownerPausePath: resolve(out, '../play/_slots/PAUSE'),
    });
    report.sessionBoundary = { directory: boundary.sessionDirectory, deadlineAt: boundary.deadlineAt };
    await boundary.waitForOwnerIdle();
  }
  report.dllBefore = await dllIdentity(dllPath);
  await save();
  // File observation and report writes are asynchronous. Recheck owner state,
  // cancellation and expiry immediately before creating the owned child.
  if (boundary) await boundary.waitForOwnerIdle();
  if (interrupted) throw new Error('Owner-open run interrupted before launch');
  child = spawn(
    'bash',
    [
      join(repository, 'scripts/remaster/native/play-native.sh'),
      '--open',
      ...(options.size ? ['--size', options.size] : []),
    ],
    {
      cwd: repository,
      env: environment,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  childExit = new Promise((resolve) => {
    child.once('error', (error) => {
      report.error ??= redact(error.message);
      exited = true;
      resolve();
    });
    child.once('exit', (code, signal) => {
      exited = true;
      exitCode = code;
      exitSignal = signal;
      resolve();
    });
  });
  const receive = (chunk) => {
    output = (output + chunk).slice(-65536);
    report.runDirectory ??= output.match(/Private launch logs and DLL backups: ([^\r\n]+)/)?.[1] ?? null;
    report.url ??= output.match(/Play URL: (http:\/\/127\.0\.0\.1:\d+\/\?[^\s]+)/)?.[1] ?? null;
  };
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding('utf8');
    stream.on('data', receive);
  }
  const startupDeadline = Date.now() + 90000;
  while (!report.url && !exited && !interrupted && Date.now() < startupDeadline) {
    if (boundary) await boundary.assertActive();
    await delay(100);
  }
  if (boundary) await boundary.assertActive();
  if (!report.url)
    throw new Error(
      interrupted ? 'Owner-open run interrupted before readiness' : 'No owner play URL before exit/startup deadline',
    );
  const url = new URL(report.url);
  const agent = new URL(url.searchParams.get('agent'));
  if (
    url.hostname !== '127.0.0.1' ||
    !/^1545[0-9]$/.test(url.port) ||
    agent.hostname !== '127.0.0.1' ||
    !/^1545[0-9]$/.test(agent.port)
  )
    throw new Error('Launcher returned an unexpected loopback scope');
  const runPrefix = join(repository, 'packages/native-host/build/play-');
  if (!report.runDirectory || !resolve(report.runDirectory).startsWith(runPrefix))
    throw new Error('Launcher returned an unexpected owned run directory');
  report.ports = { page: Number(url.port), agent: Number(agent.port) };
  // Default launches print the URL before Chrome measures the page and the game
  // starts. The CUA review window begins only after the original helper is
  // running and the launcher has confirmed a usable menu, within the same
  // startup deadline and owner/cancellation boundary as URL discovery.
  let status;
  let viewportStatus;
  while (!exited && !interrupted && Date.now() < startupDeadline) {
    if (boundary) await boundary.assertActive();
    try {
      status = JSON.parse(await readFile(join(report.runDirectory, 'status.json'), 'utf8'));
      if (status.running === false) throw new Error('Owned game exited before the CUA review window');
      if (url.searchParams.get('native-viewport') === '1')
        viewportStatus = JSON.parse(await readFile(join(report.runDirectory, 'viewport-state.json'), 'utf8'));
      if (boundary) await boundary.assertActive();
      if (
        status.running === true &&
        status.handshake === true &&
        (url.searchParams.get('native-viewport') !== '1' || viewportStatus?.ready === true)
      )
        break;
    } catch (error) {
      if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
    }
    await delay(100);
  }
  if (boundary) await boundary.assertActive();
  report.observedPid = status?.pid ?? null;
  report.nativeResolution = viewportStatus?.resolution
    ? `${viewportStatus.resolution.width}x${viewportStatus.resolution.height}`
    : url.searchParams.get('resolution');
  report.gates.readyUrl =
    !exited &&
    !interrupted &&
    status?.running === true &&
    status.handshake === true &&
    (url.searchParams.get('native-viewport') !== '1' || viewportStatus?.ready === true);
  if (!report.gates.readyUrl) throw new Error('Owned game did not report ready/running');
  report.phase = 'ready-for-cua';
  report.readyAt = new Date().toISOString();
  report.reviewDeadline = new Date(Date.now() + holdSeconds * 1000).toISOString();
  await save();
  await privateWrite(logPath, redact(output));
  console.log(
    JSON.stringify({
      phase: report.phase,
      currentPath,
      reportPath,
      closeProofPath,
      rootMustCloseTab: true,
      reviewDeadline: report.reviewDeadline,
    }),
  );
  const holdDeadline = Date.now() + holdSeconds * 1000;
  while (!exited && !interrupted && Date.now() < holdDeadline) {
    if (boundary) await boundary.assertActive();
    if (await readCloseProof()) break;
    if (boundary) await boundary.assertActive();
    await delay(100);
  }
  if (exited) throw new Error('Owner launcher exited during the CUA review window');
} catch (error) {
  report.error ??= redact(error.stack || error);
} finally {
  report.phase = 'stopping';
  if (report.url) {
    try {
      report.chromeCloseProof = await readCloseProof();
      report.gates.exactChromeTabsClosed = !!report.chromeCloseProof;
      report.rootMustCloseTab = !report.gates.exactChromeTabsClosed;
      report.chromeCleanupStatus = report.gates.exactChromeTabsClosed
        ? 'Root supplied exact-URL CUA closure proof'
        : 'UNVERIFIED: root must close the exact launch tab through CUA';
    } catch (error) {
      report.closeProofError = redact(error.message);
      report.error ??= report.closeProofError;
    }
  }
  if (child && !exited) {
    if (
      report.runDirectory &&
      resolve(report.runDirectory).startsWith(join(repository, 'packages/native-host/build/play-'))
    )
      await privateWrite(join(report.runDirectory, 'stop'), 'stop\n').catch((error) => {
        report.error ??= redact(error.message);
      });
    child.kill('SIGINT');
    const clean = await Promise.race([childExit.then(() => true), delay(15000, false, { ref: false })]);
    if (!clean) {
      child.kill('SIGTERM');
      await Promise.race([childExit, delay(5000, undefined, { ref: false })]);
      report.error ??= 'Owner launcher did not finish targeted shutdown within 20 seconds';
    }
  }
  report.exit = { exited, code: exitCode, signal: exitSignal };
  report.gates.cleanExit = exited && exitCode === 0 && !exitSignal;
  if (
    report.runDirectory &&
    resolve(report.runDirectory).startsWith(join(repository, 'packages/native-host/build/play-'))
  ) {
    try {
      report.finalGameStatus = JSON.parse(await readFile(join(report.runDirectory, 'status.json'), 'utf8'));
      report.gates.ownedGameStopped =
        report.finalGameStatus.running === false &&
        (report.observedPid === null || report.finalGameStatus.pid === report.observedPid);
    } catch (error) {
      report.statusError = redact(error.message);
    }
  }
  if (report.ports) {
    report.releasedPorts = {};
    for (const [name, port] of Object.entries(report.ports)) report.releasedPorts[name] = await released(port);
    report.gates.portsReleased = Object.values(report.releasedPorts).every(Boolean);
  }
  report.dllAfter = await dllIdentity(dllPath);
  report.gates.dllRestored = JSON.stringify(report.dllBefore) === JSON.stringify(report.dllAfter);
  report.phase = 'finished';
  report.finishedAt = new Date().toISOString();
  report.met = !report.error && Object.values(report.gates).every(Boolean);
  await save();
  await privateWrite(logPath, redact(output));
  await appendFile(
    join(out, 'NOTES.md'),
    `\nPhase 5 owner-open ${stamp}: ${holdSeconds}s CUA review window; native size ${report.nativeResolution ?? 'not ready'}; gates ${JSON.stringify(report.gates)}; actual UI requires separate root CUA evidence; report ${reportPath}.\n`,
  );
  console.log(JSON.stringify({ phase: report.phase, reportPath, gates: report.gates, met: report.met }));
  for (const name of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.off(name, signal);
  if (!report.met) process.exitCode = 1;
}
