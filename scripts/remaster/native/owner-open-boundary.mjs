import { execFile } from 'node:child_process';
import { lstat, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';

const execute = promisify(execFile);

export async function ownerConnected(executeCommand = execute) {
  try {
    const { stdout } = await executeCommand('/usr/sbin/lsof', ['-nP', '-a', '-iTCP:15400-15409', '-sTCP:ESTABLISHED'], {
      timeout: 20000,
    });
    return /:1540\d\b/.test(stdout);
  } catch (error) {
    // lsof uses exit 1 when there are no matching sockets. Other failures must
    // not be interpreted as permission to start a game.
    if (error.code === 1 && !error.stdout && !error.stderr) return false;
    throw new Error('Could not verify the owner connection state; no game was started', { cause: error });
  }
}

export async function ownerOpenBoundary(directory, dependencies = {}) {
  const sessionDirectory = resolve(directory);
  const deadlinePath = join(sessionDirectory, 'deadline.json');
  const deadline = JSON.parse(await readFile(deadlinePath, 'utf8'));
  const deadlineAt = Date.parse(deadline.deadlineAt);
  if (!Number.isFinite(deadlineAt)) throw new Error('Session deadline.json requires a valid deadlineAt');
  const now = dependencies.now ?? Date.now;
  const queryOwner = dependencies.queryOwner ?? ownerConnected;
  const pause = dependencies.pause ?? (() => delay(1000));
  async function ownerPaused() {
    if (!dependencies.ownerPausePath) return false;
    const entry = await lstat(dependencies.ownerPausePath).catch((error) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    return !!entry;
  }
  async function assertActive() {
    const cancelled = await lstat(join(sessionDirectory, 'cancel')).catch((error) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (cancelled) throw new Error('Owner-open acceptance cancelled');
    // Check time after the asynchronous cancellation lookup as well.
    if (now() >= deadlineAt) throw new Error('Owner-open session deadline reached');
  }
  async function waitForOwnerIdle() {
    for (;;) {
      await assertActive();
      const connected = await queryOwner();
      // Cancellation or expiry can arrive during the asynchronous owner query.
      await assertActive();
      const paused = await ownerPaused();
      await assertActive();
      if (!connected && !paused) return;
      await pause();
    }
  }
  return { sessionDirectory, deadlineAt: new Date(deadlineAt).toISOString(), assertActive, waitForOwnerIdle };
}
