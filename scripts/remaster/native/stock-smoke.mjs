#!/usr/bin/env node
import { writeFileSync, openSync, closeSync } from 'node:fs';
import { copyFile, readFile, writeFile, mkdir, readdir, stat, unlink } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { homedir } from 'node:os';
import { resolve, join, dirname } from 'node:path';
import { AgentClient, Type } from './wire.mjs';
import { outputDirectory, WT } from './artifacts.mjs';
import { installDll, wineConfiguration } from './play-native.mjs';

// The product launcher waits for the agent. DLL bisection must also observe a
// build without an agent, using the same DLL transaction and Wine selection.
async function isolateDll() {
  const tag = process.argv[3];
  const phase = process.argv[4] || 'phase23';
  const connectAtSecond =
    process.argv[5] === 'connect'
      ? 1
      : /^connect-after=\d+$/.test(process.argv[5] || '')
        ? Number(process.argv[5].split('=')[1])
        : Infinity;
  if (!/^[a-zA-Z0-9_-]+$/.test(tag || '') || !/^phase[0-9]+$/.test(phase))
    throw new Error('Usage: stock-smoke.mjs isolate TAG phase23 [connect]');
  const base = outputDirectory();
  const out = join(base, phase, tag);
  await mkdir(out, { recursive: true });
  await writeFile(join(out, 'harness-pid'), `${process.pid}\n`, { flag: 'wx' });
  const config = JSON.parse(await readFile(join(base, 'run/owner-launch-smoke.json'), 'utf8'));
  const environment = { ...process.env, ...config };
  if (['free', 'free-cx'].includes(process.env.RA2_NATIVE_WINE_FLAVOR)) {
    environment.RA2_NATIVE_WINE = process.env.RA2_NATIVE_WINE;
    environment.RA2_NATIVE_WINE_PREFIX = process.env.RA2_NATIVE_WINE_PREFIX;
    delete environment.RA2_NATIVE_WINE_BOTTLE;
  }
  const game = resolve(environment.RA2_NATIVE_GAME_DIR);
  if (game !== resolve(WT, '../../gameres/native-dev/YURI'))
    throw new Error('DLL isolation is restricted to the dedicated native-dev/YURI copy');
  const wine = await wineConfiguration(environment);
  const prefix =
    wine.environment.WINEPREFIX ||
    join(
      environment.CX_BOTTLE_PATH || join(homedir(), 'Library/Application Support/CrossOver/Bottles'),
      environment.RA2_NATIVE_WINE_BOTTLE,
    );
  if (!wine.environment.WINEPREFIX && environment.RA2_NATIVE_WINE_BOTTLE !== 'ra2dev')
    throw new Error('DLL isolation requires the dedicated ra2dev bottle');
  const env = {
    ...wine.environment,
    WINEPREFIX: prefix,
    WINEDEBUG: '+seh,+loaddll,+debugstr',
    WINEDLLOVERRIDES: 'ddraw=n,b',
    RA2_NATIVE_AGENT_HIDDEN: environment.RA2_NATIVE_AGENT_HIDDEN || '1',
  };
  const enabled = process.env.RA2_NATIVE_ISOLATE_AGENT !== '0';
  if (!enabled) {
    delete env.RA2_NATIVE_AGENT_PORT;
    delete env.RA2_NATIVE_AGENT_TOKEN;
  }
  const execute = (command, args, options = {}) => {
    const result = spawnSync(command, args, { env, encoding: 'utf8', timeout: 15000, ...options });
    if (result.error || result.status !== 0)
      throw new Error(`${command}: ${result.error?.message || result.stderr || result.status}`);
    return result.stdout.trim();
  };
  const windowsPath = (path) => execute(wine.wine, [...wine.args, 'winepath.exe', '-w', path]);
  const processes = () =>
    execute('/bin/ps', ['-axo', 'pid=,rss=,pcpu=,etime=,command='])
      .split('\n')
      .map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(.+)$/))
      .filter((m) => m && /^(?:[^ \t]*[\\/])gamemd\.exe(?:\s|$)|^gamemd\.exe(?:\s|$)/i.test(m[5]))
      .map((m) => ({ pid: +m[1], rssKiB: +m[2], cpuPercent: +m[3], elapsed: m[4], command: m[5] }));
  const before = new Set(processes().map((p) => p.pid));
  if (before.size) throw new Error('A game is already running; refusing the isolation probe');
  const ini = [];
  for (const name of await readdir(game)) {
    if (!/^(?:ddraw|ra2md)\.ini$/i.test(name)) continue;
    const path = join(game, name);
    const bytes = await readFile(path);
    const mode = (await stat(path)).mode & 0o777;
    await writeFile(join(out, `${name}.original`), bytes);
    ini.push({ path, bytes, mode });
  }
  const helper = join(prefix, 'drive_c/tools', `ra2-isolate-${tag}.exe`);
  const source = join(WT, 'packages/native-host/build/ra2launch.exe');
  await mkdir(dirname(helper), { recursive: true });
  await copyFile(source, helper, 1);
  const result = { wine: wine.wine, prefix, agentConfigured: enabled, samples: [], screenshots: [], error: null };
  let installation;
  let child;
  let client;
  let agentTask;
  async function sampleAgent(sample) {
    try {
      if (!client) {
        client = new AgentClient(
          `ws://127.0.0.1:${env.RA2_NATIVE_AGENT_PORT}`,
          env.RA2_NATIVE_AGENT_TOKEN,
          env.RA2_NATIVE_AGENT_ORIGIN,
        );
        client.on('failure', () => {});
        sample.hello = await client.connect();
        result.hello = sample.hello;
      }
      sample.inputState = JSON.parse((await client.request(Type.INPUT_STATE)).toString());
    } catch (error) {
      sample.agentError = error.message;
      client?.close();
      client = null;
    }
  }
  let stopRequested = false;
  const onSignal = () => {
    stopRequested = true;
  };
  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);
  try {
    const gamePath = windowsPath(join(game, 'gamemd.exe'));
    const statusPath = windowsPath(join(out, 'status.json'));
    const logPath = windowsPath(join(out, 'launcher.log'));
    installation = await installDll(join(WT, 'packages/native-host/build/ddraw.dll'), join(game, 'ddraw.dll'), out);
    const fd = openSync(join(out, 'wine.log'), 'wx', 0o600);
    try {
      child = spawn(
        wine.wine,
        [
          ...wine.args,
          'explorer',
          '/desktop=ra2isolate,1728x1117',
          `C:\\tools\\ra2-isolate-${tag}.exe`,
          '--status-file',
          statusPath,
          '--log',
          logPath,
          gamePath,
        ],
        { env, cwd: '/private/tmp', stdio: ['ignore', fd, fd] },
      );
      child.on('error', (error) => {
        result.error = error.message;
        stopRequested = true;
      });
      child.on('exit', (code, signal) => {
        result.launcherExit = { code, signal };
      });
    } finally {
      closeSync(fd);
    }
    const started = performance.now();
    for (let second = 1; second <= 30 && !stopRequested; second++) {
      await delay(Math.max(0, second * 1000 - (performance.now() - started)));
      const sample = { milliseconds: Math.round(performance.now() - started), game: processes() };
      result.samples.push(sample);
      if (second >= connectAtSecond && !agentTask)
        agentTask = sampleAgent(sample).finally(() => {
          agentTask = null;
        });
      if (second === 10 || second === 30) {
        const path = join(out, `screen-${second}s.png`);
        execute('/usr/sbin/screencapture', ['-x', path]);
        execute('/usr/bin/sips', ['-Z', '1400', path]);
        result.screenshots.push(path);
        console.log(JSON.stringify(sample));
      }
    }
    result.status = await readFile(join(out, 'status.json'), 'utf8')
      .then(JSON.parse)
      .catch(() => null);
  } catch (error) {
    result.error = error.message;
    process.exitCode = 1;
  } finally {
    client?.close();
    if (agentTask) await Promise.race([agentTask, delay(1000)]);
    if (child) {
      try {
        execute(join(dirname(wine.wine), 'wineserver'), ['-k']);
      } catch (error) {
        result.stopError = error.message;
        process.exitCode = 1;
      }
      await delay(500);
      result.remainingGame = processes();
    }
    if (!result.remainingGame?.length) {
      if (installation) result.dllRestore = await installation.restore();
      for (const saved of ini) await writeFile(saved.path, saved.bytes, { mode: saved.mode });
      await unlink(helper);
    } else {
      result.restoreDeferred = 'Game still running; DLL and configuration backups retained';
      process.exitCode = 1;
    }
    process.off('SIGTERM', onSignal);
    process.off('SIGINT', onSignal);
    await writeFile(join(out, 'isolation.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify({ ...result, samples: [result.samples[0], result.samples.at(-1)] }));
  }
}

if (process.argv[2] === 'isolate') {
  await isolateDll();
} else {
  // Run only for an explicitly unconfigured game launch. Other runner actions
  // supply its visible menus, native screenshot and external frame-rate evidence.
  const client = new AgentClient(
    'ws://127.0.0.1:15450',
    process.env.RA2_NATIVE_AGENT_TOKEN,
    process.env.RA2_NATIVE_AGENT_ORIGIN,
  );
  client.on('failure', () => {});
  let timer;
  const result = { agentListenerAbsent: false, error: null };
  try {
    await Promise.race([
      client.connect(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Agent absence check timed out')), 5000);
      }),
    ]);
    throw new Error('An unconfigured game unexpectedly exposes the agent');
  } catch (e) {
    result.agentListenerAbsent = e.code === 'ECONNREFUSED' || /ECONNREFUSED/.test(e.message);
    result.error = e.message;
    if (!result.agentListenerAbsent) process.exitCode = 1;
  } finally {
    clearTimeout(timer);
    client.close();
    writeFileSync(resolve(outputDirectory(), 'run', 'stock-agent-absence.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result));
  }
}
