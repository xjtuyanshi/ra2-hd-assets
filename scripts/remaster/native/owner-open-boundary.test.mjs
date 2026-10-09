import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { ownerConnected, ownerOpenBoundary } from './owner-open-boundary.mjs';

async function fixture(t, deadlineAt = '2026-10-10T00:00:00Z') {
  const directory = await mkdtemp(join(tmpdir(), 'owner-open-boundary-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, 'deadline.json'), JSON.stringify({ deadlineAt }));
  return directory;
}

test('expired or cancelled sessions refuse launch without querying the owner', async (t) => {
  const directory = await fixture(t);
  const dependencies = {
    now: () => Date.parse('2026-10-10T00:00:00Z'),
    queryOwner: () => assert.fail('must not query an expired session'),
  };
  await assert.rejects((await ownerOpenBoundary(directory, dependencies)).waitForOwnerIdle(), /deadline reached/);
  await writeFile(join(directory, 'cancel'), 'cancel\n');
  dependencies.now = () => 0;
  await assert.rejects((await ownerOpenBoundary(directory, dependencies)).waitForOwnerIdle(), /cancelled/);
});

test('cancellation arriving during an idle owner query prevents spawn', async (t) => {
  const directory = await fixture(t);
  let spawned = false;
  const boundary = await ownerOpenBoundary(directory, {
    now: () => 0,
    queryOwner: async () => {
      await writeFile(join(directory, 'cancel'), 'cancel\n');
      return false;
    },
  });
  await assert.rejects(async () => {
    await boundary.waitForOwnerIdle();
    spawned = true;
  }, /cancelled/);
  assert.equal(spawned, false);
});

test('expiry arriving during an idle owner query prevents spawn', async (t) => {
  const directory = await fixture(t);
  let now = 0;
  const boundary = await ownerOpenBoundary(directory, {
    now: () => now,
    queryOwner: async () => {
      now = Date.parse('2026-10-10T00:00:00Z');
      return false;
    },
  });
  await assert.rejects(boundary.waitForOwnerIdle(), /deadline reached/);
});

test('the second pre-spawn guard catches cancellation during file observation', async (t) => {
  const directory = await fixture(t);
  const boundary = await ownerOpenBoundary(directory, { now: () => 0, queryOwner: async () => false });
  await boundary.waitForOwnerIdle();
  await readFile(join(directory, 'deadline.json'));
  await writeFile(join(directory, 'cancel'), 'cancel\n');
  await assert.rejects(boundary.waitForOwnerIdle(), /cancelled/);
});

test('a connected owner is waited out and a query failure cannot authorize launch', async (t) => {
  const directory = await fixture(t);
  let calls = 0;
  let pauses = 0;
  const boundary = await ownerOpenBoundary(directory, {
    now: () => 0,
    queryOwner: async () => ++calls < 3,
    pause: async () => pauses++,
  });
  await boundary.waitForOwnerIdle();
  assert.equal(calls, 3);
  assert.equal(pauses, 2);
  const failing = await ownerOpenBoundary(directory, {
    now: () => 0,
    queryOwner: async () => {
      throw new Error('owner state unreadable');
    },
  });
  await assert.rejects(failing.waitForOwnerIdle(), /owner state unreadable/);
});

test('an invalid session deadline cannot disable the boundary', async (t) => {
  const directory = await fixture(t, 'invalid');
  await assert.rejects(ownerOpenBoundary(directory), /valid deadlineAt/);
});

test('owner connection queries are scoped and bounded and fail closed on execution errors', async () => {
  assert.equal(
    await ownerConnected(async (command, args, options) => {
      assert.equal(command, '/usr/sbin/lsof');
      assert.deepEqual(args, ['-nP', '-a', '-iTCP:15400-15409', '-sTCP:ESTABLISHED']);
      assert.equal(options.timeout, 20000);
      return { stdout: 'Chrome 123 TCP 127.0.0.1:15407->127.0.0.1:50000 (ESTABLISHED)' };
    }),
    true,
  );
  assert.equal(
    await ownerConnected(async () => {
      throw Object.assign(new Error('no matching sockets'), { code: 1, stdout: '', stderr: '' });
    }),
    false,
  );
  for (const error of [
    Object.assign(new Error('lsof unavailable'), { code: 'ENOENT' }),
    Object.assign(new Error('timed out'), { code: null, killed: true }),
    Object.assign(new Error('denied'), { code: 1, stderr: 'permission denied' }),
  ])
    await assert.rejects(
      ownerConnected(async () => {
        throw error;
      }),
      /Could not verify the owner connection state/,
    );
});

for (const duringQuery of [false, true])
  test(`owner pause ${duringQuery ? 'appearing during query' : 'without a connection'} prevents spawn`, async (t) => {
    const directory = await fixture(t);
    const ownerPausePath = join(directory, 'owner-pause');
    if (!duringQuery) await writeFile(ownerPausePath, 'pause\n');
    let waited = false;
    let spawned = false;
    const boundary = await ownerOpenBoundary(directory, {
      ownerPausePath,
      now: () => 0,
      queryOwner: async () => {
        if (duringQuery) await writeFile(ownerPausePath, 'pause\n');
        return false;
      },
      pause: async () => {
        waited = true;
        await writeFile(join(directory, 'cancel'), 'cancel\n');
      },
    });
    await assert.rejects(async () => {
      await boundary.waitForOwnerIdle();
      spawned = true;
    }, /cancelled/);
    assert.equal(waited, true);
    assert.equal(spawned, false);
  });

test('the owner-open CLI records cancellation before observing a DLL or spawning its launcher', async (t) => {
  const directory = await fixture(t, '2099-10-10T00:00:00Z');
  await writeFile(join(directory, 'cancel'), 'cancel\n');
  const config = join(directory, 'config.json');
  await writeFile(config, JSON.stringify({ RA2_NATIVE_GAME_DIR: directory }));
  const child = spawn(
    process.execPath,
    [
      fileURLToPath(new URL('./owner-open-acceptance.mjs', import.meta.url)),
      '--out',
      directory,
      '--config',
      config,
      '--session-dir',
      directory,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let output = '';
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => (output += chunk));
  }
  const code = await new Promise((resolve) => child.once('close', resolve));
  assert.equal(code, 1, output);
  const report = JSON.parse(await readFile(join(directory, 'browser/owner-open-current.json'), 'utf8'));
  assert.match(report.error, /cancelled/);
  assert.equal(report.phase, 'finished');
  assert.equal(report.dllBefore, undefined);
  assert.equal(report.url, null);
  assert.equal(report.runDirectory, null);
  assert.equal(report.exit.exited, false);
  assert.doesNotMatch(output, /正在启动游戏|Play URL:/);
});
