import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, lstat, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import {
  assertOwnedExecutableIdentity,
  findPorts,
  installDll,
  nativeMainMenuReady,
  runLauncher,
} from './play-native.mjs';

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

test('missing game configuration produces a useful error before any startup', async () => {
  await assert.rejects(runLauncher([], {}), /RA2_NATIVE_GAME_DIR/);
});

test('readiness rejects empty native executable identity before printing a play URL', () => {
  assert.throws(
    () =>
      assertOwnedExecutableIdentity(
        { exe: { size: 0, sha256: '', verified: false } },
        { size: 100, sha256: 'a'.repeat(64) },
      ),
    /empty size\/SHA-256/,
  );
});

test('readiness rejects a different executable even when its agent verified flag is true', () => {
  assert.throws(
    () =>
      assertOwnedExecutableIdentity(
        { exe: { size: 100, sha256: 'b'.repeat(64), verified: true } },
        { size: 100, sha256: 'a'.repeat(64) },
      ),
    /differs from the supplied owned game copy/,
  );
});

test('readiness reports an unsupported owned build explicitly rather than claiming page readiness', () => {
  assert.throws(
    () =>
      assertOwnedExecutableIdentity(
        { exe: { size: 100, sha256: 'a'.repeat(64), verified: false } },
        { size: 100, sha256: 'a'.repeat(64) },
      ),
    /unsupported by the native page policy/,
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

test(
  'CLI lifecycle uses real Vite plus a synthetic authenticated agent; SIGINT restores only its DLL and frees both ports',
  { timeout: 45000 },
  async (t) => {
    const { dir, target } = await fixture(t);
    const prefix = join(dir, 'prefix');
    await mkdir(prefix);
    await writeFile(join(prefix, 'system.reg'), 'synthetic prefix');
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
        Buffer.from(JSON.stringify({modal:true, controlsTruncated:false,
          controls:[{id:1667, visible:true, enabled:true, rect:[80,60,300,90]}]}))));
    });
  });
  await writeFile(status, JSON.stringify({pid:123456, handshake:true, running:true}));
  const timer = setInterval(async () => {
    try { await access(stop); } catch { return; }
    clearInterval(timer);
    await writeFile(status, JSON.stringify({pid:123456, handshake:true, running:false}));
    server.close(() => process.exit(0));
  }, 50);
}
`,
      { mode: 0o755 },
    );
    const child = spawn('bash', ['scripts/remaster/native/play-native.sh'], {
      cwd: repository,
      env: {
        ...process.env,
        RA2_NATIVE_GAME_DIR: dir,
        RA2_NATIVE_WINE_PREFIX: prefix,
        RA2_NATIVE_WINE: wine,
        RA2_NATIVE_WINE_BOTTLE: '',
        WINEPREFIX: '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
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
    const url = new URL(output.match(/Play URL: (\S+)/)[1]);
    assert.equal(url.searchParams.get('backend'), 'native');
    assert.match(url.searchParams.get('agent-token'), /^[a-f0-9]{64}$/);
    const listingResponse = await fetch(`${url.origin}/game/.list?dir=ra2`);
    assert.equal(listingResponse.status, 200);
    assert.ok((await listingResponse.json()).includes('gamemd.exe'));
    const executableResponse = await fetch(`${url.origin}/game/ra2/gamemd.exe`);
    assert.equal(executableResponse.status, 200);
    assert.equal(await executableResponse.text(), 'synthetic executable, never run');
    assert.deepEqual(await readFile(target), await readFile(join(repository, 'packages/native-host/build/ddraw.dll')));
    child.kill('SIGINT');
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
    const runPath = output.match(/Private launch logs and DLL backups: (.+)/)[1];
    const status = JSON.parse(await readFile(join(runPath, 'status.json'), 'utf8'));
    assert.equal(status.running, false);
  },
);
