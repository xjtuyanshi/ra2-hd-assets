#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFile, lstat, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { AgentClient, Picture, Type, words } from './wire.mjs';
import { outputDirectory, writePng, WT } from './artifacts.mjs';
import { createPageHarness } from './page-harness.mjs';
import { assertOwnedExecutableIdentity, nativeMainMenuReady } from './play-native.mjs';

const allowedConfiguration = new Set([
  'RA2_NATIVE_GAME_DIR',
  'RA2_NATIVE_WINE_BOTTLE',
  'RA2_NATIVE_WINE_PREFIX',
  'RA2_NATIVE_WINE',
  'RA2_HD_CACHE_DIR',
  'CX_BOTTLE_PATH',
]);

async function dllIdentity(path) {
  try {
    const [bytes, stat] = await Promise.all([readFile(path), lstat(path)]);
    return { exists: true, sha256: createHash('sha256').update(bytes).digest('hex'), mode: stat.mode & 0o777 };
  } catch (error) {
    if (error.code === 'ENOENT') return { exists: false };
    throw error;
  }
}

async function portReleased(port) {
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

async function closeClient(client) {
  if (!client || client.ws.readyState === 3) return;
  const closed = new Promise((resolve) => client.once('closed', resolve));
  client.close();
  await Promise.race([closed, delay(1000, undefined, { ref: false })]);
  if (client.ws.readyState !== 3) client.ws.terminate();
}

/** A launch/observe/stop acceptance run; no browser, match setup or battle input. */
async function runLauncherSmoke() {
  if (!process.env.NATIVE_OUT) throw new Error('Supply NATIVE_OUT; the private owner configuration is required');
  const out = outputDirectory(process.env.NATIVE_OUT);
  const stamp = new Date().toISOString().replaceAll(':', '-');
  const reportPath = resolve(out, `launcher-smoke-${stamp}.json`);
  const configPath = resolve(out, 'run/owner-launch-smoke.json');
  const configStat = await lstat(configPath);
  if (!configStat.isFile() || configStat.size > 16384)
    throw new Error('Expected a bounded regular private owner configuration file');
  const configuration = JSON.parse(await readFile(configPath, 'utf8'));
  if (!configuration || Array.isArray(configuration) || typeof configuration !== 'object')
    throw new Error('Private owner configuration must be a JSON object');
  for (const [key, value] of Object.entries(configuration)) {
    if (!allowedConfiguration.has(key) || typeof value !== 'string' || !value || value.includes('\0'))
      throw new Error('Private owner configuration contains an unsupported key/value');
  }
  if (
    !configuration.RA2_NATIVE_GAME_DIR ||
    !configuration.RA2_NATIVE_WINE ||
    !(configuration.RA2_NATIVE_WINE_BOTTLE || configuration.RA2_NATIVE_WINE_PREFIX)
  )
    throw new Error(
      'Private owner configuration requires a game directory, Wine executable and explicit bottle/prefix',
    );
  const redact = (value) => {
    let text = String(value);
    for (const configured of Object.values(configuration)) {
      text = text.replaceAll(configured, '[configured path]');
      text = text.replaceAll(configured.replaceAll('/', '\\'), '[configured path]');
    }
    return text.replace(/agent-token=[a-f0-9]+/gi, 'agent-token=[redacted]');
  };
  const started = performance.now();
  const report = {
    mode: 'real-owner-launcher-no-browser',
    startedAt: new Date().toISOString(),
    timelineSeconds: {},
    gates: {
      hiddenOwnedHello: false,
      nativeMainMenu: false,
      nativePicture: false,
      cleanExit: false,
      ownedGameStopped: false,
      portsReleased: false,
      dllRestored: false,
      ownerResources: false,
      ownedExecutableIdentity: false,
      nativeCoreMenu: false,
    },
    error: null,
  };
  const sinceStart = () => (performance.now() - started) / 1000;
  const dllPath = join(configuration.RA2_NATIVE_GAME_DIR, 'ddraw.dll');
  report.dllBefore = await dllIdentity(dllPath);
  let child,
    childExit,
    exited = false,
    exitCode = null,
    exitSignal = null;
  let client,
    harness,
    runDirectory,
    playUrl,
    output = '',
    observedStatus,
    failure;
  try {
    const environment = { ...process.env, ...configuration };
    // Explicit scope from the private file wins over inherited controller scope.
    if (configuration.RA2_NATIVE_WINE_BOTTLE) {
      delete environment.RA2_NATIVE_WINE_PREFIX;
      delete environment.WINEPREFIX;
    } else delete environment.RA2_NATIVE_WINE_BOTTLE;
    child = spawn('bash', ['scripts/remaster/native/play-native.sh'], {
      cwd: WT,
      env: environment,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    childExit = new Promise((resolve) => {
      child.once('error', (error) => {
        failure ??= error;
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
    const receive = (data) => {
      output = (output + data).slice(-65536);
      runDirectory ??= output.match(/Private launch logs and DLL backups: ([^\r\n]+)/)?.[1];
      const printed = output.match(/Play URL: (http:\/\/127\.0\.0\.1:\d+\/\?[^\s]+)/)?.[1];
      if (!playUrl && printed) {
        playUrl = new URL(printed);
        report.timelineSeconds.printedUrl = sinceStart();
      }
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', receive);
    child.stderr.on('data', receive);
    const deadline = performance.now() + 90000;
    while (!playUrl && !exited && performance.now() < deadline) await delay(100);
    if (!playUrl)
      throw new Error(
        exited ? 'Owner launcher exited before its play URL' : 'Owner launcher did not become ready within 90 s',
      );
    assert.equal(playUrl.searchParams.get('backend'), 'native');
    assert.equal(playUrl.searchParams.get('hd'), '1');
    const agentUrl = new URL(playUrl.searchParams.get('agent'));
    const token = playUrl.searchParams.get('agent-token');
    assert.match(token, /^[a-f0-9]{64}$/);
    report.ports = { page: Number(playUrl.port), agent: Number(agentUrl.port) };
    for (const port of Object.values(report.ports)) assert.ok(port >= 15450 && port <= 15459);
    assert.notEqual(report.ports.page, report.ports.agent);
    const packageBuild = resolve(WT, 'packages/native-host/build');
    if (!runDirectory || !resolve(runDirectory).startsWith(packageBuild + '/play-'))
      throw new Error('Owner launcher did not expose its private owned run directory');
    const listingResponse = await fetch(`${playUrl.origin}/game/.list?dir=ra2`, { signal: AbortSignal.timeout(5000) });
    assert.equal(listingResponse.status, 200);
    const inventory = await listingResponse.json();
    assert.ok(
      Array.isArray(inventory) && inventory.some((name) => name.toLowerCase() === 'gamemd.exe'),
      'The existing page resource-provider ra2/ scope did not expose the owned executable',
    );
    const executableResponse = await fetch(`${playUrl.origin}/game/ra2/gamemd.exe`, {
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(executableResponse.status, 200);
    const servedExecutable = Buffer.from(await executableResponse.arrayBuffer());
    const ownedExecutable = await readFile(join(configuration.RA2_NATIVE_GAME_DIR, 'gamemd.exe'));
    assert.ok(servedExecutable.equals(ownedExecutable), 'Page executable bytes differ from the supplied owned copy');
    report.resources = {
      inventoryCount: inventory.length,
      executableBytes: servedExecutable.length,
      executableSha256: createHash('sha256').update(servedExecutable).digest('hex'),
    };
    report.timelineSeconds.ownerResources = sinceStart();
    report.gates.ownerResources = true;
    observedStatus = JSON.parse(await readFile(join(runDirectory, 'status.json'), 'utf8'));
    client = new AgentClient(agentUrl.href, token, playUrl.origin);
    const hello = await client.connect();
    report.timelineSeconds.authenticatedHello = sinceStart();
    report.hello = {
      pid: hello.pid,
      protocol: hello.protocol,
      hidden: hello.hidden,
      hiddenHost: hello.hiddenHost,
      exe: hello.exe,
      surface: hello.surface,
    };
    assert.equal(hello.pid, observedStatus.pid);
    assert.equal(observedStatus.running, true);
    assert.equal(observedStatus.handshake, true);
    assert.equal(hello.hidden, true);
    assert.equal(hello.hiddenHost?.enabled, true);
    report.gates.hiddenOwnedHello = true;
    assertOwnedExecutableIdentity(hello, {
      size: report.resources.executableBytes,
      sha256: report.resources.executableSha256,
    });
    report.gates.ownedExecutableIdentity = true;
    const menuDeadline = performance.now() + 20000;
    let state;
    do {
      state = JSON.parse((await client.request(Type.INPUT_STATE)).toString());
      if (nativeMainMenuReady(hello, state)) break;
      await delay(100);
    } while (performance.now() < menuDeadline && !exited);
    assert.ok(
      nativeMainMenuReady(hello, state),
      'The original native main-menu Single Player control was not observed',
    );
    report.mainMenu = state;
    report.timelineSeconds.nativeMainMenu = sinceStart();
    report.gates.nativeMainMenu = true;
    const decoder = new Picture();
    let timer;
    const picture = new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Native main-menu picture timed out')), 8000);
      client.on('packet', (message) => {
        if (message.type !== Type.PICTURE) return;
        try {
          resolve(decoder.apply(message.payload));
        } catch (error) {
          reject(error);
        }
      });
      client.once('failure', reject);
    });
    try {
      const [, image] = await Promise.all([client.request(Type.CREDIT, words(1)), picture]);
      const picturePath = resolve(out, `launcher-smoke-${stamp}-main-menu.png`);
      writePng(picturePath, image);
      report.picture = {
        frame: image.frame,
        width: image.width,
        height: image.height,
        pixelsSha256: createHash('sha256').update(image.pixels).digest('hex'),
        artifact: picturePath,
      };
      report.timelineSeconds.nativePicture = sinceStart();
      report.gates.nativePicture = image.width > 0 && image.height > 0;
    } finally {
      clearTimeout(timer);
    }
    await closeClient(client);
    client = null;
    report.timelineSeconds.directClientReleased = sinceStart();
    let corePicture;
    const coreStatuses = [];
    harness = await createPageHarness(
      { url: agentUrl.href, token, origin: playUrl.origin },
      {
        onStatus(status) {
          coreStatuses.push(status);
        },
        onFrame(frame) {
          if (!corePicture && frame.rgb565) {
            // Presenter recycling detaches prior pictures. Keep a private copy of
            // this actual delivered frame before issuing any further picture ACK.
            corePicture = {
              width: frame.width,
              height: frame.height,
              pixels: Buffer.from(
                new Uint8Array(frame.rgb565.buffer, frame.rgb565.byteOffset, frame.rgb565.byteLength),
              ),
            };
            report.timelineSeconds.nativeCoreFirstPicture = sinceStart();
          }
        },
      },
    );
    report.timelineSeconds.nativeCoreAttach = sinceStart();
    await harness.vm.start();
    report.timelineSeconds.nativeCoreStarted = sinceStart();
    const corePictureDeadline = performance.now() + 8000;
    while (!corePicture && performance.now() < corePictureDeadline) {
      const fatal = coreStatuses.find((status) => status.phase === 'error');
      if (fatal) throw new Error(`NativeCore menu attach failed: ${fatal.detail}`);
      await delay(50);
    }
    assert.ok(corePicture?.pixels.length > 0, 'Actual page Worker NativeCore did not deliver a native menu picture');
    assert.equal(harness.vm.runtimeInfo.backend, 'native');
    const corePicturePath = resolve(out, `launcher-smoke-${stamp}-core-main-menu.png`);
    writePng(corePicturePath, corePicture);
    report.nativeCoreMenu = {
      runtime: harness.vm.runtimeInfo,
      statuses: coreStatuses,
      width: corePicture.width,
      height: corePicture.height,
      pixelsSha256: createHash('sha256').update(corePicture.pixels).digest('hex'),
      artifact: corePicturePath,
    };
    report.gates.nativeCoreMenu = true;
    await harness.destroy();
    harness = null;
    report.timelineSeconds.nativeCoreStopped = sinceStart();
  } catch (error) {
    failure ??= error;
    report.error = redact(error.stack || error);
  } finally {
    await harness?.destroy().catch((error) => {
      failure ??= error;
    });
    await closeClient(client).catch((error) => {
      failure ??= error;
    });
    report.timelineSeconds.disconnect = sinceStart();
    if (child && !exited) {
      // Independent private stop-file delivery also covers a stalled CLI; it
      // reaches only the helper/game owned by this exact launch directory.
      if (runDirectory)
        await writeFile(join(runDirectory, 'stop'), 'stop\n', { mode: 0o600 }).catch((error) => {
          failure ??= error;
        });
      child.kill('SIGINT');
      report.timelineSeconds.interrupt = sinceStart();
      const clean = await Promise.race([childExit.then(() => true), delay(15000, false, { ref: false })]);
      if (!clean) {
        child.kill('SIGTERM');
        await Promise.race([childExit, delay(5000, undefined, { ref: false })]);
        failure ??= new Error('Owner launcher did not finish targeted shutdown within 20 s');
      }
    }
    report.exit = { exited, code: exitCode, signal: exitSignal };
    report.timelineSeconds.exit = sinceStart();
    report.gates.cleanExit = exited && exitCode === 0 && !exitSignal;
    if (runDirectory) {
      try {
        const status = JSON.parse(await readFile(join(runDirectory, 'status.json'), 'utf8'));
        report.ownedStatus = status;
        report.gates.ownedGameStopped = status.running === false && status.pid === observedStatus?.pid;
      } catch (error) {
        report.statusError = redact(error.message);
      }
      const messages = [];
      for (const name of ['launcher.log', 'wine.log']) {
        try {
          const log = await readFile(join(runDirectory, name), 'utf8');
          for (const line of log.split('\n')) {
            if (
              /CreateMutexW:|CreateEventW:|CreateProcess:|CreateJobObjectW:|SetInformationJobObject:|AssignProcessToJobObject:|ResumeThread:|original launcher handshake|already owns this Wine|launcher handshake after|private stop request|owned game exited/.test(
                line,
              )
            )
              messages.push(redact(line));
          }
        } catch {}
      }
      report.launcherDiagnostics = messages.slice(-30);
    }
    if (report.ports) {
      report.releasedPorts = {};
      for (const [name, port] of Object.entries(report.ports)) report.releasedPorts[name] = await portReleased(port);
      report.gates.portsReleased = Object.values(report.releasedPorts).every(Boolean);
    }
    report.dllAfter = await dllIdentity(dllPath);
    report.gates.dllRestored = JSON.stringify(report.dllAfter) === JSON.stringify(report.dllBefore);
    report.durationSeconds = sinceStart();
    report.error ??= failure ? redact(failure.stack || failure) : null;
    report.met = !failure && Object.values(report.gates).every(Boolean);
    await writeFile(reportPath, JSON.stringify(report, null, 2), { mode: 0o600 });
    await appendFile(
      resolve(out, 'NOTES.md'),
      `\nPhase 4 owner launcher smoke ${stamp}: ${report.durationSeconds.toFixed(3)} s; gates ${JSON.stringify(report.gates)}; real native hidden PID ${report.hello?.pid ?? 'not observed'}; exit ${JSON.stringify(report.exit)}; error ${failure ? redact(failure.message) : 'none'}. Report ${reportPath}.\n`,
    );
    // The child prints a private token-bearing URL. Only safe gate metadata and
    // the report path leave this wrapper; neither raw stdout nor config is logged.
    console.log(
      JSON.stringify({ reportPath, durationSeconds: report.durationSeconds, gates: report.gates, met: report.met }),
    );
    if (!report.met) process.exitCode = 1;
  }
}

const { values } = parseArgs({ options: { help: { type: 'boolean' } } });
if (values.help) {
  console.log(
    'NATIVE_OUT=OUT node scripts/remaster/native/launcher-smoke.mjs\nReads only OUT/run/owner-launch-smoke.json for explicit owner launch scope. Starts the real owner launcher, observes authenticated hidden native main-menu state/picture, then verifies targeted shutdown and DLL restoration. No browser or match input.',
  );
} else {
  runLauncherSmoke().catch((error) => {
    console.error(
      'Launcher smoke failed before startup:',
      error.code ? `${error.code}; verify the private owner configuration under NATIVE_OUT/run` : error.message,
    );
    process.exitCode = 1;
  });
}
