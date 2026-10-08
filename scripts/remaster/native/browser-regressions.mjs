#!/usr/bin/env node
import { spawn, execFile } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { access, appendFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { parseArgs, promisify } from 'node:util';
import { chromium } from '@playwright/test';
import { tsImport } from 'tsx/esm/api';
import { outputDirectory } from './artifacts.mjs';

const cases = {
  'react-ui': 'tests/basic/browser/reactUiBrowserSmoke.mts',
  performance: 'tests/basic/browser/performanceDiagnosticsBrowserSmoke.mts',
};
const { values } = parseArgs({
  options: {
    out: { type: 'string', default: process.env.NATIVE_OUT },
    case: { type: 'string' },
    help: { type: 'boolean' },
  },
});
if (values.help) {
  console.log(
    'browser-regressions.mjs [--out NATIVE_OUT] [--case react-ui|performance]\nRuns existing asset-free tests in isolated processes using installed Chrome for Testing. RA2_BROWSER_EXECUTABLE overrides binary discovery.',
  );
  process.exit(0);
}
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
if (values.case) {
  await runBrowserCase(values.case);
  process.exit(process.exitCode ?? 0);
}

async function runBrowserCase(name) {
  if (!Object.hasOwn(cases, name)) throw new Error('Unknown browser regression case');
  const origin = new URL(process.env.RA2_BROWSER_ORIGIN);
  if (!['http:', 'https:'].includes(origin.protocol) || origin.hostname !== '127.0.0.1')
    throw new Error('Browser regression cases require an explicit owned loopback RA2_BROWSER_ORIGIN');
  const cache = join(homedir(), 'Library/Caches/ms-playwright/chromium-1243');
  let executablePath = process.env.RA2_BROWSER_EXECUTABLE;
  if (!executablePath) {
    const directories = await readdir(cache);
    for (const directory of directories.filter((item) => item.startsWith('chrome-')).sort()) {
      const candidate = join(
        cache,
        directory,
        'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
      );
      try {
        await access(candidate);
        executablePath = candidate;
        break;
      } catch {
        /* Inspect the next installed variant. */
      }
    }
  }
  if (!executablePath) throw new Error('No installed Chrome for Testing executable; supply RA2_BROWSER_EXECUTABLE');
  await access(executablePath);
  const require = createRequire(import.meta.url);
  const testRequire = createRequire(require.resolve('@playwright/test'));
  const coreDirectory = dirname(testRequire.resolve('playwright-core'));
  const packageInfo = JSON.parse(await readFile(join(coreDirectory, 'package.json'), 'utf8'));
  const manifest = JSON.parse(await readFile(join(coreDirectory, 'browsers.json'), 'utf8'));
  const expected = manifest.browsers.find((item) => item.name === 'chromium');
  const installedRevision = executablePath.match(/chromium-(\d+)/)?.[1] ?? null;
  const metadata = {
    case: name,
    originalCommand: `pnpm run test:browser:${name}`,
    originalTest: cases[name],
    playwrightVersion: packageInfo.version,
    expectedChromiumRevision: expected?.revision ?? null,
    expectedChromiumVersion: expected?.browserVersion ?? null,
    installedChromiumRevision: installedRevision,
    executablePath,
    defaultExecutablePath: chromium.executablePath(),
    crossVersion: installedRevision !== null && installedRevision !== expected?.revision,
    launches: [],
    completed: false,
    error: null,
  };
  const saveMetadata = async () => {
    if (process.env.RA2_BROWSER_RUN_METADATA)
      await writeFile(process.env.RA2_BROWSER_RUN_METADATA, `${JSON.stringify(metadata, null, 2)}\n`);
  };
  const originalLaunch = chromium.launch;
  const browsers = [];
  chromium.launch = async (options = {}) => {
    // Scope this adapter to this child only. Original test arguments and the default headless mode are preserved;
    // the owner's installed browser is selected explicitly without modifying tests or Playwright's global cache.
    const args = [
      ...new Set([
        ...(options.args ?? []),
        '--enable-unsafe-webgpu',
        '--enable-gpu',
        '--use-angle=metal',
        '--ignore-gpu-blocklist',
        '--autoplay-policy=no-user-gesture-required',
        '--enable-webgpu-developer-features',
      ]),
    ];
    const launch = { headless: options.headless ?? true, args, version: null, closed: false };
    metadata.launches.push(launch);
    await saveMetadata();
    const browser = await originalLaunch.call(chromium, { ...options, executablePath, args });
    launch.version = browser.version();
    metadata.crossVersion ||= launch.version !== expected?.browserVersion;
    browsers.push({ browser, launch });
    console.log('Installed regression browser', JSON.stringify({ ...metadata, launches: metadata.launches }));
    await saveMetadata();
    return browser;
  };
  try {
    await tsImport(resolve(repository, cases[name]), import.meta.url);
    metadata.completed = true;
  } catch (error) {
    metadata.error = String(error.stack ?? error);
    throw error;
  } finally {
    chromium.launch = originalLaunch;
    for (const { browser, launch } of browsers) {
      try {
        await browser.close();
        launch.closed = true;
      } catch (error) {
        launch.cleanupError = String(error);
        process.exitCode = 1;
      }
    }
    await saveMetadata();
  }
}

const out = join(outputDirectory(values.out), 'browser');
const stamp = new Date().toISOString().replaceAll(':', '-');
const screenshotDirectory = join(out, `${stamp}-regression-screenshots`);
await mkdir(screenshotDirectory, { recursive: true });
const reportPath = join(out, `${stamp}-regressions.json`);
const report = { startedAt: new Date().toISOString(), tests: [], cleanup: [], error: null, met: false };
const children = [];
const runFile = promisify(execFile);
let interrupted = null;
let tracking = false;
const onInterrupt = (signal) => {
  interrupted ??= signal;
};
const onSigint = () => onInterrupt('SIGINT');
const onSigterm = () => onInterrupt('SIGTERM');
process.on('SIGINT', onSigint);
process.on('SIGTERM', onSigterm);

async function processRows() {
  if (process.platform === 'win32') return [];
  const { stdout } = await runFile('ps', ['-axo', 'pid=,ppid=,pgid=,lstart='], { timeout: 2000 });
  return stdout.split('\n').flatMap((line) => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+?)\s*$/);
    return match ? [{ pid: +match[1], parent: +match[2], group: +match[3], started: match[4] }] : [];
  });
}

// Playwright launches Chromium in its own process group. Preserve only descendants of our exact child PIDs,
// with their start identity, so a timed-out test cannot leave its detached browser running or kill another run.
async function trackOwned() {
  if (tracking) return;
  tracking = true;
  try {
    const rows = await processRows();
    for (const child of children) {
      if (child.result) continue;
      const parents = new Set([child.process.pid]);
      let changed = true;
      while (changed) {
        changed = false;
        for (const row of rows)
          if (parents.has(row.parent) && !parents.has(row.pid)) {
            parents.add(row.pid);
            changed = true;
          }
      }
      for (const row of rows) if (parents.has(row.pid)) child.owned.set(row.pid, row);
    }
  } finally {
    tracking = false;
  }
}

function startChild(name, args, env = {}, command = 'pnpm') {
  const log = join(out, `${stamp}-${name}.log`);
  const stream = createWriteStream(log, { flags: 'wx' });
  const proc = spawn(command, args, {
    cwd: repository,
    env: { ...process.env, ...env },
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const child = { name, process: proc, log, owned: new Map(), result: null, exited: null };
  child.exited = new Promise((done) => {
    proc.once('error', (error) => {
      child.spawnError = String(error);
    });
    proc.once('close', (code, signal) => {
      child.result = { code, signal, ...(child.spawnError ? { error: child.spawnError } : {}) };
      stream.end(() => done(child.result));
    });
  });
  for (const pipe of [proc.stdout, proc.stderr]) pipe.on('data', (chunk) => stream.write(chunk));
  children.push(child);
  return child;
}

function signalOwned(child, signal) {
  if (!child.process.pid) return;
  try {
    process.kill(process.platform === 'win32' ? child.process.pid : -child.process.pid, signal);
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
}

async function survivingOwned(child) {
  const rows = await processRows();
  return rows.filter((row) => child.owned.get(row.pid)?.started === row.started);
}

async function stopChild(child) {
  const cleanup = { name: child.name, interrupted: false, escalated: false };
  try {
    await trackOwned();
    if (!child.result) {
      cleanup.interrupted = true;
      signalOwned(child, 'SIGINT');
      await Promise.race([child.exited, delay(5000)]);
    }
    let survivors = await survivingOwned(child);
    if (!child.result || survivors.length) {
      cleanup.escalated = true;
      signalOwned(child, 'SIGTERM');
      for (const row of survivors) {
        try {
          process.kill(row.group === row.pid ? -row.pid : row.pid, 'SIGTERM');
        } catch (error) {
          if (error.code !== 'ESRCH') throw error;
        }
      }
      await Promise.race([child.exited, delay(3000)]);
      survivors = await survivingOwned(child);
      if (!child.result) signalOwned(child, 'SIGKILL');
      for (const row of survivors) {
        try {
          process.kill(row.group === row.pid ? -row.pid : row.pid, 'SIGKILL');
        } catch (error) {
          if (error.code !== 'ESRCH') throw error;
        }
      }
      await Promise.race([child.exited, delay(2000)]);
    }
    cleanup.exit = child.result;
    cleanup.remainingOwnedPids = (await survivingOwned(child)).map((row) => row.pid);
    cleanup.stopped = !!child.result && cleanup.remainingOwnedPids.length === 0;
  } catch (error) {
    cleanup.error = String(error.stack ?? error);
    cleanup.stopped = false;
  }
  report.cleanup.push(cleanup);
}

async function freePort() {
  const socket = createServer();
  try {
    await new Promise((done, reject) => {
      socket.once('error', reject);
      socket.listen({ host: '127.0.0.1', port: 0, exclusive: true }, done);
    });
    return socket.address().port;
  } finally {
    if (socket.listening) await new Promise((done) => socket.close(done));
  }
}

function responds(origin) {
  return new Promise((done) => {
    const request = (origin.startsWith('https:') ? httpsRequest : httpRequest)(
      origin,
      {
        timeout: 1500,
        // Only this owned loopback readiness request accepts Vite's development certificate.
        rejectUnauthorized: false,
      },
      (response) => {
        response.resume();
        done(response.statusCode === 200);
      },
    );
    request.on('timeout', () => request.destroy());
    request.on('error', () => done(false));
    request.end();
  });
}

const tracker = setInterval(() => {
  void trackOwned().catch(() => undefined);
}, 500);
try {
  const port = await freePort();
  const origin = `${process.env.RA2_DEV_HTTP ? 'http' : 'https'}://127.0.0.1:${port}`;
  report.origin = origin;
  const server = startChild('regression-vite', [
    'exec',
    'vite',
    '--host',
    '127.0.0.1',
    '--port',
    String(port),
    '--strictPort',
  ]);
  const until = Date.now() + 45_000;
  while (!(await responds(origin))) {
    if (interrupted) throw new Error(`Interrupted: ${interrupted}`);
    if (server.result) throw new Error(`Owned Vite exited before readiness: ${JSON.stringify(server.result)}`);
    if (Date.now() >= until) throw new Error('Owned Vite did not become ready within 45 seconds');
    await delay(150);
  }
  for (const [name, timeout] of [
    ['test:browser:react-ui', 180_000],
    ['test:browser:performance', 120_000],
  ]) {
    if (interrupted) throw new Error(`Interrupted: ${interrupted}`);
    if (server.result) throw new Error('Owned Vite exited before the next regression');
    const caseName = name.replace('test:browser:', '');
    const browserMetadata = join(out, `${stamp}-${caseName}-browser.json`);
    const entry = {
      name,
      originalCommand: `pnpm run ${name}`,
      case: caseName,
      browserMetadata,
      startedAt: new Date().toISOString(),
    };
    report.tests.push(entry);
    const child = startChild(
      name.replaceAll(':', '-'),
      [fileURLToPath(import.meta.url), '--case', caseName],
      {
        RA2_BROWSER_ORIGIN: origin,
        RA2_BROWSER_SCREENSHOT_DIR: screenshotDirectory,
        RA2_BROWSER_RUN_METADATA: browserMetadata,
      },
      process.execPath,
    );
    entry.log = child.log;
    const deadline = Date.now() + timeout;
    while (!child.result && Date.now() < deadline && !interrupted) await delay(100);
    entry.timedOut = !child.result && !interrupted;
    entry.interrupted = interrupted;
    await stopChild(child);
    entry.exit = child.result;
    try {
      entry.browser = JSON.parse(await readFile(browserMetadata, 'utf8'));
    } catch (error) {
      entry.browserMetadataError = String(error);
    }
    entry.met = !entry.timedOut && !entry.interrupted && child.result?.code === 0 && !child.result?.signal;
    entry.finishedAt = new Date().toISOString();
    console.log(name, entry.met ? 'PASS' : 'FAIL', JSON.stringify(entry.exit), child.log);
  }
} catch (error) {
  report.error = String(error.stack ?? error);
} finally {
  clearInterval(tracker);
  for (const child of [...children].reverse())
    if (!report.cleanup.some((item) => item.name === child.name)) await stopChild(child);
  process.off('SIGINT', onSigint);
  process.off('SIGTERM', onSigterm);
  report.finishedAt = new Date().toISOString();
  report.met =
    !report.error &&
    report.tests.length === 2 &&
    report.tests.every((test) => test.met) &&
    report.cleanup.every((item) => item.stopped);
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  await appendFile(
    resolve(out, '../NOTES.md'),
    `\nPhase 5 asset-free browser regressions ${stamp}: ${report.tests.filter((test) => test.met).length}/2 PASS; cleanup ${JSON.stringify(report.cleanup)}; error ${report.error ?? 'none'}; report ${reportPath}.\n`,
  );
  console.log('Browser regressions', report.met ? 'PASS' : 'FAIL', reportPath);
  if (!report.met) process.exitCode = 1;
}
