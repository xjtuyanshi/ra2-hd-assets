#!/usr/bin/env node
// Read existing live-launch evidence without opening Wine, Chrome or another client.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { outputDirectory } from './artifacts.mjs';
import { readWineSelfCheckEvidence } from './launcher-wine-evidence.mjs';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const base = outputDirectory();
const out = join(base, 'phase11');
const [mode = 'owner', tag] = process.argv.slice(2);
if (mode === '--help') {
  console.log(
    'phase11-launcher-evidence.mjs owner | harness TAG\n' +
      'Read OUT/browser/owner-open-current.json or OUT/phase11/TAG after the real launcher stops. ' +
      'Write OUT/phase11/launcher-MODE[-TAG]-evidence.json. No processes or live clients are started. ' +
      'Screenshots and real browser input still require a separate inspected review record.',
  );
  process.exit(0);
}
assert(mode === 'owner' || mode === 'harness', 'Use owner or harness TAG');
if (mode === 'harness') assert(/^[A-Za-z0-9_-]+$/.test(tag ?? ''), 'Supply a safe harness tag');
await mkdir(out, { recursive: true });
const label = mode === 'owner' ? 'owner' : `harness-${tag}`;
const evidencePath = join(out, `launcher-${label}-evidence.json`);
const redact = (value) => String(value).replace(/agent-token=[a-f0-9]+/gi, 'agent-token=[redacted]');
async function json(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}
async function identity(path) {
  try {
    const [bytes, info] = await Promise.all([readFile(path), stat(path)]);
    return {
      path: relative(repository, path),
      sha256: createHash('sha256').update(bytes).digest('hex'),
      bytes: bytes.length,
      modifiedAt: info.mtime.toISOString(),
    };
  } catch (error) {
    if (error.code === 'ENOENT') return { path: relative(repository, path), missing: true };
    throw error;
  }
}
const report = {
  mode: `read-existing-${label}-evidence`,
  collectedAt: new Date().toISOString(),
  startsNoProcess: true,
  source: null,
  liveRunStartedAt: null,
  runDirectory: null,
  gates: {},
  screenshots: [],
  screenshotInspection: 'UNVERIFIED: record the actual inspected browser screenshots separately',
  humanInput: 'UNVERIFIED: retain the actual CUA or trusted browser input evidence separately',
  missingPrerequisites: 'Separate offline fault evidence; this collector does not simulate failures',
  error: null,
};
try {
  const deadline = await json(join(out, 'deadline.json')).catch(() => null);
  report.sessionBoundary = deadline;
  if (mode === 'owner') {
    const path = join(base, 'browser/owner-open-current.json');
    const owner = await json(path);
    report.source = relative(base, path);
    report.liveRunStartedAt = owner.startedAt;
    report.runDirectory = owner.runDirectory;
    report.nativeResolution = owner.nativeResolution;
    report.ownerPhase = owner.phase;
    report.ownerGates = owner.gates;
    report.finalGameStatus = owner.finalGameStatus;
    report.exit = owner.exit;
    report.gates.finished = owner.phase === 'finished';
    report.gates.readyUrl = owner.gates?.readyUrl === true;
    report.gates.exactChromeTabsClosed = owner.gates?.exactChromeTabsClosed === true;
    report.gates.cleanExit = owner.gates?.cleanExit === true;
    report.gates.ownedGameStopped = owner.gates?.ownedGameStopped === true;
    report.gates.portsReleased = owner.gates?.portsReleased === true;
    report.gates.dllRestored = owner.gates?.dllRestored === true;
    report.launcherError = owner.error;
    const logPath = path.replace('owner-open-current.json', '');
    report.ownerCloseProofPath = owner.closeProofPath ? relative(base, owner.closeProofPath) : null;
    // The wrapper's closure proof confirms only its exact launch URL. It does
    // not establish that the menu painted, accepted input or used the right DPR.
    report.chromeClosureProof = owner.chromeCloseProof
      ? { closed: owner.chromeCloseProof.closed, source: owner.chromeCloseProof.source }
      : null;
    report.browserEvidenceDirectory = relative(base, logPath);
  } else {
    const directory = join(out, tag);
    const path = join(directory, 'observations.jsonl');
    const observations = (await readFile(path, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
    const ready = observations.find((entry) => entry.name === 'ready');
    const cleanup = observations.findLast((entry) => entry.name === 'cleanup');
    const log = await readFile(join(directory, 'launcher.log'), 'utf8');
    report.source = relative(base, path);
    report.liveRunStartedAt = observations[0]?.at ?? null;
    report.runDirectory = log.match(/Private launch logs and DLL backups: ([^\r\n]+)/)?.[1] ?? null;
    report.browser = ready?.proof;
    report.cleanup = cleanup?.proof;
    report.gates.installedChrome =
      ready?.proof.browserExecutable === '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    report.gates.ownerViewport =
      ready?.proof.viewport?.width === 1728 &&
      ready?.proof.viewport?.height === 1117 &&
      ready?.proof.viewport?.dpr === 2;
    report.gates.readyNativeMenu = !!ready;
    report.gates.cleanExit = cleanup?.proof.exit?.code === 0 && !cleanup?.proof.exit?.signal;
    report.gates.ownedGameStopped =
      cleanup?.proof.status?.running === false && cleanup?.proof.status?.pid === ready?.proof.hello?.pid;
    report.gates.browserClosed = cleanup?.proof.browserClosed === true;
    report.gates.portsReleased = cleanup?.proof.portsReleased?.every((value) => value === true) === true;
    report.gates.dllRestored = cleanup?.proof.dllRestored === true;
    report.screenshots = observations
      .filter((entry) => entry.name === 'screenshot')
      .map((entry) => ({ at: entry.at, ...entry.proof, path: relative(base, entry.proof.path) }));
    report.inputCommands = observations
      .filter((entry) => entry.name === 'command')
      .map((entry) => ({ at: entry.at, ...entry.proof }));
    report.pageErrors = observations.filter((entry) => entry.name === 'pageerror');
    report.fatalErrors = observations.filter((entry) => entry.name === 'fatal');
    const installedHash = ready?.proof.installedAgent?.sha256;
    report.gates.currentInstalledDll =
      /^[a-f0-9]{64}$/.test(installedHash ?? '') &&
      installedHash === (await identity(join(repository, 'packages/native-host/build/ddraw.dll'))).sha256;
  }
  const runPrefix = join(repository, 'packages/native-host/build/play-');
  assert(report.runDirectory && resolve(report.runDirectory).startsWith(runPrefix), 'No owned launcher run directory');
  report.installedDllSnapshot = await identity(join(report.runDirectory, 'ddraw.installed.dll'));
  report.currentBuiltDll = await identity(join(repository, 'packages/native-host/build/ddraw.dll'));
  report.gates.currentInstalledDllSnapshot =
    /^[a-f0-9]{64}$/.test(report.installedDllSnapshot.sha256 ?? '') &&
    report.installedDllSnapshot.sha256 === report.currentBuiltDll.sha256;
  if (mode === 'owner') report.gates.currentInstalledDll = report.gates.currentInstalledDllSnapshot;
  const wineCheck = await readWineSelfCheckEvidence(report.runDirectory);
  report.wineSelfCheck = {
    artifact: relative(repository, wineCheck.logPath),
    ...(await identity(wineCheck.logPath)),
    observationArtifact: wineCheck.observationPath ? await identity(wineCheck.observationPath) : null,
    observation: wineCheck.observation,
    observedExactOkLine: wineCheck.observedExactOkLine,
  };
  report.gates.realWineSelfCheck = wineCheck.successful;
  report.gates.currentSession =
    !!deadline?.startedAt &&
    !!report.liveRunStartedAt &&
    Date.parse(report.liveRunStartedAt) >= Date.parse(deadline.startedAt);
  report.currentCode = await Promise.all(
    [
      'scripts/remaster/native/play-native.sh',
      'scripts/remaster/native/play-native.mjs',
      'scripts/remaster/native/launcher-wine-evidence.mjs',
      'scripts/remaster/native/native-resolution.mjs',
      'scripts/remaster/native/owner-open-acceptance.mjs',
      'scripts/remaster/native/owner-open-boundary.mjs',
      'scripts/remaster/native/browser-phase9.mjs',
      'packages/native-host/build/ddraw.dll',
      'packages/native-host/build/ra2launch.exe',
    ].map((path) => identity(join(repository, path))),
  );
  report.codeIdentityScope =
    'Hashes are from collection time. Use the session source snapshots and final check to prove no changes after the live run.';
  const reviewPath = join(out, `launcher-${label}-review.json`);
  report.browserReview = await json(reviewPath).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (report.browserReview) report.browserReviewArtifact = relative(base, reviewPath);
  report.liveTechnicalGatesMet = !report.launcherError && Object.values(report.gates).every(Boolean);
  report.a7Acceptance = 'UNVERIFIED: combine the real lifecycle, inspected browser/input and fault evidence';
} catch (error) {
  report.error = redact(error.stack || error);
  report.liveTechnicalGatesMet = false;
}
await writeFile(evidencePath, redact(JSON.stringify(report, null, 2)) + '\n', { mode: 0o600 });
console.log(
  JSON.stringify({
    evidencePath,
    gates: report.gates,
    liveTechnicalGatesMet: report.liveTechnicalGatesMet,
    error: report.error,
  }),
);
if (report.error) process.exitCode = 1;
