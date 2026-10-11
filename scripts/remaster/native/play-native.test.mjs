import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, lstat, mkdir, mkdtemp, readFile, readlink, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { createConnection, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import {
  assertOwnedExecutableIdentity,
  findPorts,
  installDll,
  nativeFilmReady,
  nativeMainMenuReady,
  prepareWinePrefix,
  runLauncher,
  validateHdCache,
  waitForStartupCommand,
  wineCheckAcknowledgement,
  wineConfiguration,
} from './play-native.mjs';
import { HD_PLAY_OPTIONS } from '../play-options.mjs';
import { AgentClient } from './wire.mjs';
import { readWineSelfCheckEvidence } from './launcher-wine-evidence.mjs';
import {
  NATIVE_RESOLUTION_LIMITS,
  capNativeResolution,
  configureNativeResolution,
  nativeResolutionIniName,
  nativeViewportResolution,
  parseNativeSize,
  patchNativeResolutionIni,
} from './native-resolution.mjs';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'native-launcher-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const source = join(dir, 'source.dll');
  const target = join(dir, 'ddraw.dll');
  const run = join(dir, 'run');
  await mkdir(run);
  await writeFile(source, 'synthetic native DLL');
  return { dir, source, target, run };
}

test('existing DLL is backed up before replacement and restored with its permissions', async (t) => {
  const { source, target, run } = await fixture(t);
  await writeFile(target, 'player DLL');
  await chmod(target, 0o744);
  const installation = await installDll(source, target, run);
  assert.equal(await readFile(installation.backup, 'utf8'), 'player DLL');
  assert.equal(await readFile(target, 'utf8'), 'synthetic native DLL');
  assert.equal((await installation.restore()).restored, true);
  assert.equal(await readFile(target, 'utf8'), 'player DLL');
  assert.equal((await lstat(target)).mode & 0o777, 0o744);
  assert.equal(await readFile(installation.backup, 'utf8'), 'player DLL');
});

test('a new DLL is removed on exit, while a later player replacement survives', async (t) => {
  const { source, target, run, dir } = await fixture(t);
  const installation = await installDll(source, target, run);
  assert.equal((await installation.restore()).restored, true);
  await assert.rejects(lstat(target), { code: 'ENOENT' });
  const secondRun = join(dir, 'second-run');
  await mkdir(secondRun);
  const changed = await installDll(source, target, secondRun);
  await writeFile(target, 'later player change');
  assert.equal((await changed.restore()).restored, false);
  assert.equal(await readFile(target, 'utf8'), 'later player change');
});

test('symlink DLLs are refused without touching their destination', async (t) => {
  const { source, target, run, dir } = await fixture(t);
  const other = join(dir, 'other.dll');
  await writeFile(other, 'unrelated');
  await symlink(other, target);
  await assert.rejects(installDll(source, target, run), /non-regular DLL/);
  assert.equal(await readFile(other, 'utf8'), 'unrelated');
});

test('a player replacement with identical bytes retains its file identity', async (t) => {
  const { source, target, run, dir } = await fixture(t);
  const installation = await installDll(source, target, run);
  const replacement = join(dir, 'replacement.dll');
  await writeFile(replacement, await readFile(source));
  const identity = (await lstat(replacement)).ino;
  await rename(replacement, target);
  assert.equal((await installation.restore()).restored, false);
  assert.equal((await lstat(target)).ino, identity);
});

test('port selection skips a live listener and stays inside the assigned range', async (t) => {
  const blocker = createServer();
  const original = await findPorts();
  await new Promise((resolve, reject) => {
    blocker.once('error', reject);
    blocker.listen(original.agent, '127.0.0.1', resolve);
  });
  t.after(() => new Promise((resolve) => blocker.close(resolve)));
  const ports = await findPorts();
  for (const port of Object.values(ports)) {
    assert.ok(port >= 15450 && port <= 15459);
    assert.notEqual(port, original.agent);
  }
  assert.notEqual(ports.agent, ports.page);
});

test('temporary reservations close even when a startup poller connects before selection completes', async () => {
  const servers = [],
    probes = [],
    accepted = [];
  let deadline;
  const makeServer = (onConnection) => {
    const server = createServer(onConnection);
    const listen = server.listen.bind(server);
    server.listen = (options, ready) => {
      // Use ephemeral ports so this regression cannot disturb an owner's game.
      listen({ ...options, port: 0 }, () => {
        const probe = createConnection({ host: '127.0.0.1', port: server.address().port });
        probes.push(probe);
        probe.on('error', () => {});
        server.once('connection', (socket) => {
          accepted.push(socket);
          ready();
        });
      });
      return server;
    };
    servers.push(server);
    return server;
  };
  try {
    const result = await Promise.race([
      findPorts(makeServer),
      new Promise((_, reject) => {
        deadline = setTimeout(() => reject(new Error('accepted startup probe blocked reservation release')), 2000);
      }),
    ]);
    assert.notEqual(result.agent, result.page);
    assert.equal(accepted.length, 2);
    assert.ok(accepted.every((socket) => socket.destroyed));
    assert.ok(servers.every((server) => !server.listening));
  } finally {
    clearTimeout(deadline);
    for (const socket of [...probes, ...accepted]) socket.destroy();
    await Promise.all(
      servers.filter((server) => server.listening).map((server) => new Promise((resolve) => server.close(resolve))),
    );
  }
});

test('missing game configuration produces a useful error before any startup', async () => {
  await assert.rejects(runLauncher([], {}), /RA2_NATIVE_GAME_DIR/);
});

test('missing HD library is reported in Chinese without changing the game copy', async (t) => {
  const { dir, target } = await fixture(t);
  await writeFile(target, 'player DLL');
  await assert.rejects(validateHdCache({ RA2_HD_CACHE_DIR: dir }), /找不到高清缓存.*RA2_HD_CACHE_DIR/);
  assert.equal(await readFile(target, 'utf8'), 'player DLL');
  await mkdir(join(dir, '_library'));
  assert.equal(await validateHdCache({ RA2_HD_CACHE_DIR: dir }), dir);
});

test('unreadable cache traversal remains different from a missing cache', async (t) => {
  const { dir } = await fixture(t);
  await symlink('_library', join(dir, '_library'));
  await assert.rejects(validateHdCache({ RA2_HD_CACHE_DIR: dir }), (error) => {
    assert.match(error.message, /无法读取高清缓存/);
    assert.equal(error.cause.code, 'ELOOP');
    return true;
  });
});

test('relative cache configuration uses the same repository scope as the Vite child from another cwd', async (t) => {
  const { dir } = await fixture(t);
  await mkdir(join(dir, '_library'));
  const launcher = join(repository, 'scripts/remaster/native/play-native.mjs');
  const relativeCache = relative(repository, dir);
  const child = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `const {validateHdCache}=await import(${JSON.stringify(pathToFileURL(launcher).href)}); console.log(await validateHdCache({RA2_HD_CACHE_DIR: ${JSON.stringify(relativeCache)}}));`,
    ],
    { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let output = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    output += chunk;
  });
  const code = await new Promise((resolve) => child.once('close', resolve));
  assert.equal(code, 0);
  assert.equal(output.trim(), dir);
});

test('runLauncher reports missing game, Wine and cache prerequisites before starting any child', async (t) => {
  const { dir, target } = await fixture(t);
  const prefix = join(dir, 'prefix');
  await mkdir(prefix);
  await writeFile(join(prefix, 'system.reg'), 'synthetic prefix');
  await writeFile(target, 'player DLL');
  const wine = join(dir, 'mock-wine.mjs');
  const calls = join(dir, 'calls.json');
  await writeFile(
    wine,
    `#!${process.execPath}\nimport {writeFile} from 'node:fs/promises';\nawait writeFile(${JSON.stringify(calls)}, 'unexpected startup');\n`,
    { mode: 0o755 },
  );
  const env = {
    RA2_NATIVE_GAME_DIR: dir,
    RA2_NATIVE_WINE_PREFIX: prefix,
    RA2_NATIVE_WINE: wine,
    RA2_HD_CACHE_DIR: dir,
  };
  await assert.rejects(runLauncher(['--size', '1280x720'], env), /找不到游戏程序/);
  await writeFile(join(dir, 'gamemd.exe'), 'synthetic executable, never run');
  await assert.rejects(
    runLauncher(['--size', '1280x720'], { ...env, RA2_NATIVE_WINE: join(dir, 'missing-wine') }),
    /找不到 Wine 程序/,
  );
  await assert.rejects(runLauncher(['--size', '1280x720'], env), /找不到高清缓存/);
  await assert.rejects(lstat(calls), { code: 'ENOENT' });
  await assert.rejects(lstat(join(dir, 'RA2MD.INI')), { code: 'ENOENT' });
  assert.equal(await readFile(target, 'utf8'), 'player DLL');
});

test('only an explicitly selected missing or empty prefix is prepared; existing environments remain unchanged', async (t) => {
  const { dir } = await fixture(t);
  const prefix = join(dir, 'new-prefix');
  const env = { RA2_NATIVE_WINE: process.execPath, RA2_NATIVE_WINE_PREFIX: prefix };
  assert.equal((await wineConfiguration(env)).preparePrefix, prefix);
  await assert.rejects(lstat(prefix), { code: 'ENOENT' });
  await assert.rejects(wineConfiguration({ RA2_NATIVE_WINE: process.execPath, WINEPREFIX: prefix }), /首次创建/);
  await mkdir(prefix);
  assert.equal((await wineConfiguration(env)).preparePrefix, prefix);
  await writeFile(join(prefix, 'system.reg'), 'existing user registry');
  const configuration = await wineConfiguration(env);
  assert.equal(configuration.preparePrefix, null);
  await prepareWinePrefix(configuration, dir, async () => assert.fail('existing prefix was modified'));
  assert.equal(await readFile(join(prefix, 'system.reg'), 'utf8'), 'existing user registry');
  await assert.rejects(lstat(join(prefix, '.ra2-native-prefix.json')), { code: 'ENOENT' });
});

test('new dedicated prefix uses the mapped game drive and verifies the 32-bit Blowfish value before startup', async (t) => {
  const { dir } = await fixture(t);
  const prefix = join(dir, 'missing-parent', 'prefix');
  const game = join(dir, '游戏副本');
  await mkdir(game);
  await writeFile(join(game, 'Blowfish.dll'), 'synthetic player component');
  const env = { RA2_NATIVE_WINE: process.execPath, RA2_NATIVE_WINE_PREFIX: prefix };
  const calls = [];
  const command = async (args) => {
    calls.push(args);
    if (args[0] === 'wineboot.exe') {
      await writeFile(join(prefix, 'system.reg'), 'synthetic owned registry');
      await mkdir(join(prefix, 'dosdevices'));
      const modules = join(prefix, 'drive_c/windows/syswow64');
      await mkdir(modules, { recursive: true });
      await writeFile(join(modules, 'regsvr32.exe'), 'synthetic 32-bit registration command');
      await writeFile(join(modules, 'reg.exe'), 'synthetic 32-bit registry command');
    }
    if (args[0] === 'winepath.exe') return 'G:\\Blowfish.dll\r\n';
    if (args[0] === 'reg.exe')
      return 'HKEY_CLASSES_ROOT\\CLSID\\test\r\n    (Default)    REG_SZ    G:\\Blowfish.dll\r\n';
    return '';
  };
  await prepareWinePrefix(await wineConfiguration(env), game, command, () => {});
  assert.equal(await readlink(join(prefix, 'dosdevices/g:')), game);
  assert.deepEqual(
    calls.map((args) => args[0]),
    ['wineboot.exe', 'winepath.exe', 'C:\\windows\\syswow64\\regsvr32.exe', 'reg.exe'],
  );
  assert.deepEqual(calls[2].slice(1), ['/s', 'G:\\Blowfish.dll']);
  assert.deepEqual(calls[3].slice(-2), ['/ve', '/reg:32']);
  assert.equal(JSON.parse(await readFile(join(prefix, '.ra2-native-prefix.json'), 'utf8')).winebootCompleted, true);
  const secondGame = join(dir, 'another-game');
  await mkdir(secondGame);
  await writeFile(join(secondGame, 'Blowfish.dll'), 'another supplied component');
  calls.length = 0;
  await prepareWinePrefix(await wineConfiguration(env), secondGame, command, () => {});
  assert.equal(
    calls.some((args) => args[0] === 'wineboot.exe'),
    false,
  );
  assert.equal(await readlink(join(prefix, 'dosdevices/g:')), secondGame);
  await assert.rejects(
    prepareWinePrefix(
      await wineConfiguration(env),
      secondGame,
      async (args) =>
        args[0] === 'winepath.exe' ? 'G:\\Blowfish.dll' : '(Default)    REG_SZ    Z:\\??\\Blowfish.dll\n',
      () => {},
    ),
    /32 位 Blowfish 注册路径不正确/,
  );
});

test('a failed first initialization that leaves system.reg is retried until its 32-bit files are complete', async (t) => {
  const { dir } = await fixture(t);
  const prefix = join(dir, 'prefix');
  await writeFile(join(dir, 'Blowfish.dll'), 'synthetic player component');
  const env = { RA2_NATIVE_WINE: process.execPath, RA2_NATIVE_WINE_PREFIX: prefix };
  let attempts = 0;
  const command = async (args) => {
    if (args[0] === 'wineboot.exe') {
      attempts++;
      await writeFile(join(prefix, 'system.reg'), 'incomplete first registry');
      if (attempts === 1) throw new Error('synthetic interrupted initialization');
      await mkdir(join(prefix, 'dosdevices'));
      const modules = join(prefix, 'drive_c/windows/syswow64');
      await mkdir(modules, { recursive: true });
      await writeFile(join(modules, 'regsvr32.exe'), 'synthetic 32-bit command');
      await writeFile(join(modules, 'reg.exe'), 'synthetic 32-bit command');
    }
    if (args[0] === 'winepath.exe') return 'G:\\Blowfish.dll';
    if (args[0] === 'reg.exe') return '(Default)    REG_SZ    G:\\Blowfish.dll\n';
    return '';
  };
  await assert.rejects(
    prepareWinePrefix(await wineConfiguration(env), dir, command, () => {}),
    /interrupted initialization/,
  );
  assert.equal(JSON.parse(await readFile(join(prefix, '.ra2-native-prefix.json'), 'utf8')).winebootCompleted, false);
  await prepareWinePrefix(await wineConfiguration(env), dir, command, () => {});
  assert.equal(attempts, 2);
  assert.equal(JSON.parse(await readFile(join(prefix, '.ra2-native-prefix.json'), 'utf8')).winebootCompleted, true);
});

test('foreign files, symlink prefixes and copied ownership markers cannot be claimed', async (t) => {
  const { dir } = await fixture(t);
  const prefix = join(dir, 'prefix');
  await mkdir(prefix);
  await writeFile(join(prefix, 'player-file'), 'preserve me');
  const env = { RA2_NATIVE_WINE: process.execPath, RA2_NATIVE_WINE_PREFIX: prefix };
  await assert.rejects(wineConfiguration(env), /找不到已有的 Wine 文件夹/);
  await writeFile(join(prefix, '.ra2-native-prefix.json'), JSON.stringify({ version: 1, dev: 0, ino: 0 }));
  await assert.rejects(wineConfiguration(env), /标记与目录不符/);
  const alias = join(dir, 'alias');
  await symlink(prefix, alias, 'dir');
  await assert.rejects(wineConfiguration({ ...env, RA2_NATIVE_WINE_PREFIX: alias }), /不能是文件或链接/);
  assert.equal(await readFile(join(prefix, 'player-file'), 'utf8'), 'preserve me');
});

test('CrossOver bottles and aliases to their root never enter dedicated-prefix preparation', async (t) => {
  const { dir } = await fixture(t);
  const root = join(dir, 'Bottles');
  const bottle = join(root, 'player-bottle');
  await mkdir(bottle, { recursive: true });
  await writeFile(join(bottle, 'system.reg'), 'existing bottle registry');
  const env = { RA2_NATIVE_WINE: process.execPath, CX_BOTTLE_PATH: root };
  const configuration = await wineConfiguration({
    ...env,
    RA2_NATIVE_WINE_BOTTLE: 'player-bottle',
    WINEPREFIX: '/unused',
  });
  assert.equal(configuration.preparePrefix, null);
  assert.equal(configuration.environment.WINEPREFIX, undefined);
  await assert.rejects(
    wineConfiguration({ ...env, RA2_NATIVE_WINE_BOTTLE: 'player-bottle', RA2_NATIVE_WINE_PREFIX: bottle }),
    /只能设置一个/,
  );
  await assert.rejects(
    wineConfiguration({ ...env, RA2_NATIVE_WINE_PREFIX: join(root, 'new-bottle') }),
    /不会为 CrossOver/,
  );
  await assert.rejects(
    wineConfiguration({ ...env, RA2_NATIVE_WINE_PREFIX: join(root, '..another-bottle') }),
    /不会为 CrossOver/,
  );
  const alias = join(dir, 'root-alias');
  await symlink(root, alias, 'dir');
  await assert.rejects(
    wineConfiguration({ ...env, RA2_NATIVE_WINE_PREFIX: join(alias, 'new-bottle') }),
    /不会为 CrossOver/,
  );
  assert.equal(await readFile(join(bottle, 'system.reg'), 'utf8'), 'existing bottle registry');
});

test('dedicated preparation refuses real CrossOver executable paths and copied wrapper identities', async (t) => {
  const { dir } = await fixture(t);
  const installed = join(dir, 'App/Contents/SharedSupport/CrossOver/bin/renamed-command');
  await mkdir(dirname(installed), { recursive: true });
  await writeFile(installed, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const alias = join(dir, 'ordinary-command');
  await symlink(installed, alias);
  const prefix = join(dir, 'new-prefix');
  const env = { RA2_NATIVE_WINE: alias, RA2_NATIVE_WINE_PREFIX: prefix };
  await assert.rejects(wineConfiguration(env), /CrossOver.*免费 Wine 的可执行文件/);
  const copied = join(dir, 'copied-command');
  await writeFile(copied, '#!/usr/bin/perl\n# CodeWeavers, Inc.\nCXBottle::setup_bottle_wineprefix($scope);\n', {
    mode: 0o755,
  });
  await assert.rejects(wineConfiguration({ ...env, RA2_NATIVE_WINE: copied }), /CrossOver.*免费 Wine 的可执行文件/);
  await assert.rejects(lstat(prefix), { code: 'ENOENT' });
  await mkdir(prefix);
  await writeFile(join(prefix, 'system.reg'), 'existing unowned registry');
  assert.equal((await wineConfiguration({ ...env, RA2_NATIVE_WINE: copied })).preparePrefix, null);
  assert.equal(
    (await wineConfiguration({ RA2_NATIVE_WINE: alias, RA2_NATIVE_WINE_BOTTLE: 'new-prefix', CX_BOTTLE_PATH: dir }))
      .preparePrefix,
    null,
  );
});

test(
  'cancelling first-prefix initialization promptly kills its owned unresponsive command',
  { timeout: 10000 },
  async (t) => {
    const { dir, target } = await fixture(t);
    await writeFile(join(dir, 'gamemd.exe'), 'synthetic executable, never run');
    await writeFile(join(dir, 'Blowfish.dll'), 'synthetic player component');
    await writeFile(target, 'player DLL');
    await mkdir(join(dir, '_library'));
    const call = join(dir, 'command.json');
    const wine = join(dir, 'mock-wine.mjs');
    await writeFile(
      wine,
      `#!${process.execPath}\nimport {writeFile} from 'node:fs/promises';\nawait writeFile(${JSON.stringify(call)}, JSON.stringify({args:process.argv.slice(2),pid:process.pid}));\nprocess.on('SIGTERM',()=>{});setInterval(()=>{},1000);\n`,
      { mode: 0o755 },
    );
    const child = spawn(process.execPath, ['scripts/remaster/native/play-native.mjs', '--size', '1280x720'], {
      cwd: repository,
      env: {
        ...process.env,
        RA2_NATIVE_GAME_DIR: dir,
        RA2_NATIVE_WINE: wine,
        RA2_NATIVE_WINE_PREFIX: join(dir, 'new-prefix'),
        RA2_NATIVE_WINE_BOTTLE: '',
        RA2_HD_CACHE_DIR: dir,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const closed = new Promise((resolve) => child.once('close', resolve));
    let record;
    t.after(async () => {
      child.kill('SIGKILL');
      if (record?.pid) {
        try {
          process.kill(-record.pid, 'SIGKILL');
        } catch (error) {
          if (error.code !== 'ESRCH') throw error;
        }
      }
      await closed;
    });
    const readyDeadline = Date.now() + 3000;
    while (!record) {
      try {
        record = JSON.parse(await readFile(call, 'utf8'));
      } catch {}
      if (Date.now() >= readyDeadline) assert.fail('synthetic initialization was not started');
      await delay(10);
    }
    assert.deepEqual(record.args, ['wineboot.exe', '--init']);
    const cancelStarted = Date.now();
    child.kill('SIGINT');
    let cancelTimer;
    try {
      await Promise.race([
        closed,
        new Promise((_, reject) => {
          cancelTimer = setTimeout(() => reject(new Error('prefix cancellation waited for its startup timeout')), 5000);
        }),
      ]);
    } finally {
      clearTimeout(cancelTimer);
    }
    assert.ok(Date.now() - cancelStarted < 5000);
    assert.throws(() => process.kill(record.pid, 0), { code: 'ESRCH' });
    assert.equal(await readFile(target, 'utf8'), 'player DLL');
    await assert.rejects(lstat(join(dir, 'RA2MD.INI')), { code: 'ENOENT' });
  },
);

test('an owned startup command has a bounded wait even when the child does not complete', async () => {
  await assert.rejects(waitForStartupCommand({ done: new Promise(() => {}) }, 20, 'Wine 自检超时'), /Wine 自检超时/);
  await waitForStartupCommand({ done: Promise.resolve() }, 20, 'unexpected timeout');
});

test('Wine acknowledgement survives trailing logs and chunk splits without accepting an embedded marker', () => {
  for (const chunks of [
    ['RA2_NATIVE_WINE_OK\n', 'diagnostic noise '.repeat(8192)],
    ['\tRA2_NAT', 'IVE_WINE_', 'OK\r', '\n'],
    ['RA2_NATIVE_WINE_OK'],
    [' '.repeat(20000), 'RA2_NATIVE_WINE_OK', ' '.repeat(20000), '\n'],
  ]) {
    const acknowledgement = wineCheckAcknowledgement();
    for (const chunk of chunks) acknowledgement.append(chunk);
    assert.equal(acknowledgement.finish(), true);
  }
  for (const chunks of [
    ['prefix RA2_NATIVE_WINE_OK\n'],
    ['RA2_NATIVE_WINE_OK suffix\n'],
    ['RA2_NATIVE_', ' ', 'WINE_OK\n'],
    ['x'.repeat(8192), 'RA2_NATIVE_WINE_OK\n'],
    ['RA2_NATIVE_WINE_OK\rRA2_NATIVE_WINE_OK'],
    [''],
  ]) {
    const acknowledgement = wineCheckAcknowledgement();
    for (const chunk of chunks) acknowledgement.append(chunk);
    assert.equal(acknowledgement.finish(), false);
  }
});

test('Wine evidence falls back only for old launches without an observation, never for failed or invalid observations', async (t) => {
  const { run } = await fixture(t);
  await writeFile(join(run, 'wine-check.log'), 'RA2_NATIVE_WINE_OK\n');
  const historical = await readWineSelfCheckEvidence(run);
  assert.equal(historical.observationPath, null);
  assert.equal(historical.successful, true);
  await writeFile(
    join(run, 'wine-check.json'),
    JSON.stringify({
      source: 'stdout-exact-trimmed-line',
      acknowledged: true,
      closed: false,
      exitCode: 0,
      error: null,
    }),
  );
  assert.equal((await readWineSelfCheckEvidence(run)).successful, false);
  await writeFile(join(run, 'wine-check.json'), 'null');
  await assert.rejects(readWineSelfCheckEvidence(run), /observation object/);
  await writeFile(join(run, 'wine-check.json'), 'not json');
  await assert.rejects(readWineSelfCheckEvidence(run), SyntaxError);
});

for (const scenario of [
  {
    name: 'failed self-check',
    body: "console.error('synthetic Wine refusal');process.exitCode=7;",
    message: /Wine 自检失败/,
  },
  { name: 'empty successful self-check', body: "console.error('synthetic empty reply');", message: /Wine 自检失败/ },
  {
    name: 'hung self-check',
    body: "console.error('synthetic Wine hang');setInterval(()=>{},1000);",
    message: /Wine 自检超过 30 秒/,
  },
  {
    name: 'exited wrapper with inherited pipes',
    body: `import {spawn} from 'node:child_process';const child=spawn(process.execPath,['-e', "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdio:'inherit'});await appendFile(CALLS,JSON.stringify({args:['owned inherited-pipe child'],pid:child.pid})+'\\n');console.error('synthetic inherited pipe');child.unref();`,
    message: /Wine 自检超过 30 秒/,
  },
  {
    name: 'oversized path mapping',
    body: "if(process.argv[2]==='cmd.exe')console.log('RA2_NATIVE_WINE_OK');else console.log('Z:'+ 'X'.repeat(131072));",
    message: /Wine 返回的文件路径超过安全范围/,
  },
])
  test(`runLauncher ${scenario.name} stops before game-file replacement`, { timeout: 45000 }, async (t) => {
    const { dir, target } = await fixture(t);
    const prefix = join(dir, 'prefix');
    await mkdir(prefix);
    await writeFile(join(prefix, 'system.reg'), 'synthetic prefix');
    await mkdir(join(dir, '_library'));
    await writeFile(join(dir, 'gamemd.exe'), 'synthetic executable, never run');
    await writeFile(target, 'player DLL');
    const wine = join(dir, 'mock-wine.mjs');
    const calls = join(dir, 'calls.json');
    await writeFile(
      wine,
      `#!${process.execPath}\nimport {appendFile} from 'node:fs/promises';\nconst CALLS=${JSON.stringify(calls)};await appendFile(CALLS, JSON.stringify({args:process.argv.slice(2), pid:process.pid})+'\\n');\n${scenario.body}\n`,
      { mode: 0o755 },
    );
    const child = spawn(process.execPath, ['scripts/remaster/native/play-native.mjs', '--size', '1280x720'], {
      cwd: repository,
      env: {
        ...process.env,
        RA2_NATIVE_GAME_DIR: dir,
        RA2_NATIVE_WINE_PREFIX: prefix,
        RA2_NATIVE_WINE: wine,
        RA2_NATIVE_WINE_BOTTLE: '',
        RA2_HD_CACHE_DIR: dir,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let exited = false;
    t.after(async () => {
      if (exited) return;
      if (!exited) {
        child.kill('SIGINT');
        await delay(2000);
        if (!exited) child.kill('SIGKILL');
      }
      const recorded = await readFile(calls, 'utf8').catch(() => '');
      for (const line of recorded.trim().split('\n').filter(Boolean)) {
        const { pid } = JSON.parse(line);
        try {
          process.kill(pid, 'SIGKILL');
        } catch (error) {
          if (error.code !== 'ESRCH') throw error;
        }
      }
    });
    let output = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      output += chunk;
    });
    child.stderr.on('data', (chunk) => {
      output += chunk;
    });
    const code = await new Promise((resolve) =>
      child.once('close', (code) => {
        exited = true;
        resolve(code);
      }),
    );
    assert.equal(code, 1, output);
    assert.match(output, scenario.message);
    assert.doesNotMatch(output, /Play URL:/);
    const records = (await readFile(calls, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.deepEqual(records[0].args, ['cmd.exe', '/c', 'echo RA2_NATIVE_WINE_OK']);
    assert.equal(
      records.length,
      ['oversized path mapping', 'exited wrapper with inherited pipes'].includes(scenario.name) ? 2 : 1,
    );
    for (const { pid } of records) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
    assert.equal(await readFile(target, 'utf8'), 'player DLL');
    await assert.rejects(lstat(join(dir, 'RA2MD.INI')), { code: 'ENOENT' });
    const runPath = output.match(/Private launch logs and DLL backups: (.+)/)[1];
    if (scenario.name !== 'oversized path mapping')
      assert.match(await readFile(join(runPath, 'wine-check.log'), 'utf8'), /synthetic/);
    const evidence = await readWineSelfCheckEvidence(runPath);
    assert.equal(evidence.successful, scenario.name === 'oversized path mapping');
    if (['hung self-check', 'exited wrapper with inherited pipes'].includes(scenario.name)) {
      assert.equal(evidence.observation.closed, false);
      assert.match(evidence.observation.error, /30 秒/);
    }
  });

test('native size parsing and main-display capping respect game and picture bounds', () => {
  assert.deepEqual(parseNativeSize('1512x982'), { width: 1512, height: 982 });
  assert.deepEqual(capNativeResolution({ width: 1512, height: 982 }), { width: 1512, height: 982 });
  for (const size of [
    { width: 5120, height: 2880 },
    { width: 99999, height: 600 },
    { width: 800, height: 99999 },
  ]) {
    const capped = capNativeResolution(size);
    assert.ok(capped.width >= 800 && capped.width <= 2560);
    assert.ok(capped.height >= 600 && capped.height <= 1600);
    assert.ok(capped.width * capped.height <= NATIVE_RESOLUTION_LIMITS.maxPixels);
  }
  for (const value of [undefined, '1270', '700x600', '1280x599', '1280x720junk'])
    assert.throws(() => parseNativeSize(value), /--size/);
  assert.throws(() => capNativeResolution({ width: 0, height: 600 }), /valid size/);
});

test('native viewport matching uses measured device pixels and keeps odd heights', () => {
  assert.deepEqual(nativeViewportResolution({ width: 1728, height: 963, dpr: 2 }), { width: 1728, height: 963 });
  assert.deepEqual(nativeViewportResolution({ width: 1728, height: 1117, dpr: 2 }), { width: 1728, height: 1117 });
  assert.deepEqual(nativeViewportResolution({ width: 1728, height: 900, dpr: 1.5 }), { width: 1296, height: 675 });
  assert.throws(() => nativeViewportResolution({ width: 2560, height: 1440, dpr: 2 }), /超出/);
  assert.throws(() => nativeViewportResolution({ width: 700, height: 600, dpr: 2 }), /超出/);
  assert.throws(() => nativeViewportResolution({ width: 1728, height: 963, dpr: 0 }), /有效/);
});

test('native resolution patch preserves unrelated ANSI bytes, comments, sections and line endings', () => {
  const before = Buffer.from(
    '; \xff player comment\r\n[Video]\r\n ScreenWidth = 800 ; width\r\nScreenHeight=600\r\nScreenWidth=1024\r\nAllowHiResModes=no\r\n[Options]\r\nGameSpeed=1\r\nSoundVolume=0.7\r\n',
    'latin1',
  );
  const after = patchNativeResolutionIni(before, { width: 1512, height: 982 });
  assert.equal(
    after.toString('latin1'),
    '; \xff player comment\r\n[Video]\r\n ScreenWidth = 1512 ; width\r\nScreenHeight=982\r\nScreenWidth=1512\r\nAllowHiResModes=yes\r\n[Options]\r\nGameSpeed=1\r\nSoundVolume=0.7\r\n',
  );
  assert.ok(patchNativeResolutionIni(after, { width: 1512, height: 982 }).equals(after));
  assert.match(patchNativeResolutionIni(Buffer.alloc(0), { width: 1280, height: 720 }).toString(), /^\[Video\]\n/);
});

test('native resolution configuration backs up the supplied case-insensitive INI and rejects symlinks', async (t) => {
  const { dir, run } = await fixture(t);
  const target = join(dir, 'ra2md.ini');
  const original = Buffer.from('[Options]\r\nGameSpeed=1\r\n');
  await writeFile(target, original, { mode: 0o640 });
  const configured = await configureNativeResolution(dir, run, { width: 1280, height: 720 });
  assert.equal(configured.target, target);
  assert.deepEqual(await readFile(configured.backup), original);
  assert.equal((await lstat(target)).mode & 0o777, 0o640);
  assert.match((await readFile(target)).toString(), /ScreenWidth=1280\r\nScreenHeight=720/);
  assert.equal((await configureNativeResolution(dir, run, { width: 1280, height: 720 })).changed, false);
  const linkedGame = join(dir, 'linked');
  await mkdir(linkedGame);
  await symlink(target, join(linkedGame, 'RA2MD.INI'));
  await assert.rejects(configureNativeResolution(linkedGame, run, { width: 1280, height: 720 }), /non-regular/);
});

test('native resolution refuses Unicode BOM files without rewriting or creating a backup', async (t) => {
  const { dir, run } = await fixture(t);
  const target = join(dir, 'RA2MD.INI');
  const original = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('[Video]\r\nScreenWidth=800\r\n', 'utf16le')]);
  await writeFile(target, original);
  await assert.rejects(configureNativeResolution(dir, run, { width: 1280, height: 720 }), /Unicode BOM/);
  assert.deepEqual(await readFile(target), original);
  await assert.rejects(lstat(join(run, 'RA2MD.original.ini')), { code: 'ENOENT' });
  for (const bom of [
    [0xef, 0xbb, 0xbf],
    [0xfe, 0xff],
    [0, 0, 0xfe, 0xff],
  ])
    assert.throws(() => patchNativeResolutionIni(Buffer.from(bom), { width: 1280, height: 720 }), /Unicode BOM/);
});

test('native resolution refuses ambiguous INI case variants rather than choosing a file', () => {
  assert.equal(nativeResolutionIniName(['other.ini', 'ra2md.INI']), 'ra2md.INI');
  assert.equal(nativeResolutionIniName(['other.ini']), 'RA2MD.INI');
  assert.throws(() => nativeResolutionIniName(['RA2MD.INI', 'ra2md.ini']), /Multiple case variants/);
});

test('readiness rejects empty native executable identity before printing a play URL', () => {
  assert.throws(
    () =>
      assertOwnedExecutableIdentity(
        { exe: { size: 0, sha256: '', verified: false } },
        { size: 100, sha256: 'a'.repeat(64) },
      ),
    /游戏未能完成启动.*文件大小或 SHA-256 为空/,
  );
});

test('readiness rejects a different executable even when its agent verified flag is true', () => {
  assert.throws(
    () =>
      assertOwnedExecutableIdentity(
        { exe: { size: 100, sha256: 'b'.repeat(64), verified: true } },
        { size: 100, sha256: 'a'.repeat(64) },
      ),
    /游戏未能完成启动.*指定副本.*不一致/,
  );
});

test('readiness reports an unsupported owned build explicitly rather than claiming page readiness', () => {
  assert.throws(
    () =>
      assertOwnedExecutableIdentity(
        { exe: { size: 100, sha256: 'a'.repeat(64), verified: false } },
        { size: 100, sha256: 'a'.repeat(64) },
      ),
    /游戏未能完成启动.*当前游戏版本尚不受支持.*SHA-256/,
  );
  assert.doesNotThrow(() =>
    assertOwnedExecutableIdentity(
      { exe: { size: 100, sha256: 'a'.repeat(64), verified: true } },
      { size: 100, sha256: 'a'.repeat(64) },
    ),
  );
});

test('readiness waits for a real modal menu with a visible enabled control inside the native picture', () => {
  const hello = { surface: { width: 1280, height: 720 } };
  const state = {
    modal: true,
    controlsTruncated: false,
    controls: [{ id: 1667, visible: true, enabled: true, rect: [80, 60, 300, 90] }],
  };
  assert.equal(nativeMainMenuReady(hello, state), true);
  assert.equal(nativeMainMenuReady(hello, { ...state, modal: false }), false);
  assert.equal(nativeMainMenuReady(hello, { ...state, controlsTruncated: true }), false);
  assert.equal(nativeMainMenuReady(hello, { ...state, controls: [] }), false);
  assert.equal(
    nativeMainMenuReady(hello, { ...state, controls: [{ ...state.controls[0], rect: [80, 60, 3000, 90] }] }),
    false,
  );
  assert.equal(nativeMainMenuReady(hello, { ...state, controls: [{ ...state.controls[0], enabled: false }] }), false);
});

test('film readiness accepts observed successful playback outside a modal and rejects unknown or closed playback', () => {
  const hello = { surface: { width: 800, height: 600 } };
  const state = { modal: false, moviePlaying: true, movieOpens: 1 };
  assert.equal(nativeFilmReady(hello, state), true);
  assert.equal(nativeFilmReady(hello, { ...state, modal: true }), false);
  assert.equal(nativeFilmReady(hello, { ...state, modal: undefined }), false);
  assert.equal(nativeFilmReady(hello, { ...state, moviePlaying: false }), false);
  assert.equal(nativeFilmReady(hello, { ...state, moviePlaying: null }), false);
  assert.equal(nativeFilmReady(hello, { ...state, movieOpens: 0 }), false);
  assert.equal(nativeFilmReady(hello, { ...state, movieOpens: undefined }), false);
  assert.equal(nativeFilmReady({ surface: { width: 0, height: 600 } }, state), false);
  assert.equal(nativeFilmReady({}, state), false);
});

for (const stopFailure of [false, true])
  test(
    `CLI lifecycle uses real Vite plus a synthetic authenticated agent; ${stopFailure ? 'failed stop-file delivery still restores its DLL and frees both ports' : 'SIGINT restores only its DLL and frees both ports'}`,
    { timeout: 45000 },
    async (t) => {
      const { dir, target } = await fixture(t);
      const prefix = join(dir, 'prefix');
      await mkdir(prefix);
      await writeFile(join(prefix, 'system.reg'), 'synthetic prefix');
      await mkdir(join(dir, '_library'));
      await writeFile(join(dir, 'gamemd.exe'), 'synthetic executable, never run');
      await writeFile(target, 'player DLL preserved by lifecycle test');
      const wine = join(dir, 'mock-wine.mjs');
      const wsPath = join(repository, 'node_modules/ws/index.js');
      const wirePath = join(repository, 'scripts/remaster/native/wire.mjs');
      await writeFile(
        wine,
        `#!${process.execPath}
import { readFile, writeFile, access } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
const require = createRequire(import.meta.url);
const { WebSocketServer } = require(${JSON.stringify(wsPath)});
const { packet, Type, decodePacket } = await import(${JSON.stringify(wirePath)});
const args = process.argv.slice(2);
const unix = (path) => path.slice(2).replaceAll('\\\\', '/');
if (args[0] === 'winepath.exe') {
  console.log('Z:' + args[2].replaceAll('/', '\\\\'));
} else if (args[0] === 'cmd.exe') {
  console.log('synthetic noisy Wine self-check '.repeat(8192));
  console.log('RA2_NATIVE_WINE_OK');
  console.log('synthetic trailing Wine self-check '.repeat(8192));
} else {
  const value = (name) => unix(args[args.indexOf(name) + 1]);
  const stop = value('--stop-file');
  const status = value('--status-file');
  const game = await readFile(unix(args.at(-1)));
  await writeFile(value('--log'), 'synthetic launcher; no game was run');
  const server = new WebSocketServer({ host: '127.0.0.1', port: +process.env.RA2_NATIVE_AGENT_PORT,
    verifyClient: ({req}) => req.headers.origin === process.env.RA2_NATIVE_AGENT_ORIGIN &&
      new URL(req.url, 'http://localhost').searchParams.get('token') === process.env.RA2_NATIVE_AGENT_TOKEN });
  server.on('connection', (socket) => {
    socket.send(packet(Type.HELLO, 0,
      Buffer.from(JSON.stringify({ pid: 123456, hiddenHost: { enabled: process.env.RA2_NATIVE_AGENT_HIDDEN === '1' },
        surface: {width: 1280, height: 720},
        exe: {size: game.length, sha256: createHash('sha256').update(game).digest('hex'), verified:true} }))));
    socket.on('message', (raw) => {
      const request = decodePacket(raw);
      if (request.type === Type.INPUT_STATE) socket.send(packet(Type.INPUT_STATE, request.id,
        Buffer.from(JSON.stringify(${JSON.stringify(
          stopFailure
            ? { modal: false, moviePlaying: true, movieOpens: 1, controls: [] }
            : {
                modal: true,
                controlsTruncated: false,
                controls: [{ id: 1667, visible: true, enabled: true, rect: [80, 60, 300, 90] }],
              },
        )}))));
    });
  });
  await writeFile(status, JSON.stringify({pid:123456, handshake:true, running:true}));
  const timer = setInterval(async () => {
    try { await access(stop); } catch { return; }
    clearInterval(timer);
    await writeFile(status, JSON.stringify({pid:123456, handshake:true, running:false, exitCode:0}));
    server.close(() => process.exit(0));
  }, 50);
}
`,
        { mode: 0o755 },
      );
      const child = spawn(
        'bash',
        ['scripts/remaster/native/play-native.sh', ...(stopFailure ? ['--size', '1280x720'] : ['--fullscreen'])],
        {
          cwd: repository,
          env: {
            ...process.env,
            RA2_NATIVE_GAME_DIR: dir,
            RA2_NATIVE_WINE_PREFIX: prefix,
            RA2_NATIVE_WINE: wine,
            RA2_HD_CACHE_DIR: dir,
            RA2_NATIVE_WINE_BOTTLE: '',
            WINEPREFIX: '',
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      let output = '';
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (data) => {
        output += data;
      });
      child.stderr.on('data', (data) => {
        output += data;
      });
      let exited = false;
      const exit = new Promise((resolve) =>
        child.once('exit', (code) => {
          exited = true;
          resolve(code);
        }),
      );
      t.after(async () => {
        if (!exited) child.kill('SIGINT');
        await Promise.race([exit, delay(7000)]);
        if (!exited) child.kill('SIGKILL');
      });
      const deadline = Date.now() + 30000;
      while (!output.includes('Play URL: ') && !exited && Date.now() < deadline) await delay(100);
      assert.match(output, /Play URL: /, output);
      if (stopFailure) {
        assert.match(output, /影片已经开始播放.*Chrome.*跳过影片/);
        assert.doesNotMatch(output, /Native main menu ready/);
      }
      const url = new URL(output.match(/Play URL: (\S+)/)[1]);
      const runPath = output.match(/Private launch logs and DLL backups: (.+)/)[1];
      if (!stopFailure) {
        const endpoint = `${url.origin}/__native/viewport`;
        const headers = { Authorization: `Bearer ${url.searchParams.get('agent-token')}` };
        assert.equal((await fetch(endpoint)).status, 404);
        assert.deepEqual(await (await fetch(endpoint, { headers })).json(), { ready: false, resolution: null });
        assert.equal(await readFile(target, 'utf8'), 'player DLL preserved by lifecycle test');
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify({ width: 1728, height: 963, dpr: 2 }),
        });
        assert.equal(response.status, 200);
        const readyDeadline = Date.now() + 30000;
        while (!output.includes('Native process ') && !exited && Date.now() < readyDeadline) await delay(100);
        assert.match(output, /Native process /, output);
        assert.deepEqual(await (await fetch(endpoint, { headers })).json(), {
          ready: true,
          resolution: { width: 1728, height: 963 },
        });
        assert.match(await readFile(join(dir, 'RA2MD.INI'), 'utf8'), /ScreenWidth=1728\nScreenHeight=963/);
      }
      assert.equal(url.searchParams.get('backend'), 'native');
      assert.equal(url.searchParams.get('native-autostart'), 'yr');
      assert.equal(url.searchParams.get('native-fullscreen'), stopFailure ? '0' : '1');
      assert.equal(url.searchParams.get('resolution'), stopFailure ? '1280x720' : 'display');
      for (const [key, value] of Object.entries(HD_PLAY_OPTIONS)) assert.equal(url.searchParams.get(key), value);
      assert.match(
        output,
        stopFailure
          ? /Native resolution: 1280x720 \(fixed for this session/
          : /Native resolution: 1728x963 \(fixed for this session/,
      );
      assert.match(url.searchParams.get('agent-token'), /^[a-f0-9]{64}$/);
      const listingResponse = await fetch(`${url.origin}/game/.list?dir=ra2`);
      assert.equal(listingResponse.status, 200);
      assert.ok((await listingResponse.json()).includes('gamemd.exe'));
      const executableResponse = await fetch(`${url.origin}/game/ra2/gamemd.exe`);
      assert.equal(executableResponse.status, 200);
      assert.equal(await executableResponse.text(), 'synthetic executable, never run');
      assert.deepEqual(
        await readFile(target),
        await readFile(join(repository, 'packages/native-host/build/ddraw.dll')),
      );
      const statusUrl = `${url.origin}/__native/session`;
      assert.equal((await fetch(statusUrl)).status, 404);
      const statusOptions = { headers: { Authorization: `Bearer ${url.searchParams.get('agent-token')}` } };
      assert.deepEqual(await (await fetch(statusUrl, statusOptions)).json(), { state: 'running' });
      // Keep the synthetic native transport open until owned-group teardown,
      // mirroring Wine handles which can outlive the helper's exit status.
      const agent = new AgentClient(url.searchParams.get('agent'), url.searchParams.get('agent-token'), url.origin);
      t.after(() => agent.close());
      const nativeClosed = new Promise((resolve) => agent.once('closed', resolve));
      await agent.connect();
      if (stopFailure) await symlink(join(dir, 'missing-stop-parent', 'stop'), join(runPath, 'stop'));
      child.kill('SIGINT');
      const noticeDeadline = Date.now() + 1000;
      let closure;
      do {
        closure = await (await fetch(statusUrl, statusOptions)).json();
        if (closure.state === 'closed') break;
        await delay(20);
      } while (Date.now() < noticeDeadline);
      assert.deepEqual(closure, { state: 'closed' });
      await nativeClosed;
      await delay(200);
      assert.deepEqual(await (await fetch(statusUrl, statusOptions)).json(), { state: 'closed' });
      assert.equal(await exit, 0, output);
      assert.equal(await readFile(target, 'utf8'), 'player DLL preserved by lifecycle test');
      for (const port of [+url.port, +new URL(url.searchParams.get('agent')).port]) {
        const server = createServer();
        await new Promise((resolve, reject) => {
          server.once('error', reject);
          server.listen(port, '127.0.0.1', resolve);
        });
        await new Promise((resolve) => server.close(resolve));
      }
      const checkLog = await readFile(join(runPath, 'wine-check.log'), 'utf8');
      assert.ok(checkLog.length <= 16385);
      assert.match(checkLog, /synthetic trailing Wine self-check/);
      assert.doesNotMatch(checkLog, /RA2_NATIVE_WINE_OK/);
      const evidence = await readWineSelfCheckEvidence(runPath);
      assert.deepEqual(evidence.observation, {
        source: 'stdout-exact-trimmed-line',
        acknowledged: true,
        closed: true,
        exitCode: 0,
        error: null,
      });
      assert.equal(evidence.observedExactOkLine, true);
      assert.equal(evidence.successful, true);
      const status = JSON.parse(await readFile(join(runPath, 'status.json'), 'utf8'));
      // Forced cleanup must not invent an exit acknowledgement from the helper.
      assert.equal(status.running, stopFailure);
      if (stopFailure) assert.match(output, /无法写入停止请求，将继续关闭本次游戏/);
    },
  );
