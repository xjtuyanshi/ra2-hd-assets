#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
  access,
  chmod,
  copyFile,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  stat,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { AgentClient, Type } from './wire.mjs';
import { HD_PLAY_OPTIONS } from '../play-options.mjs';
import {
  capNativeResolution,
  configureNativeResolution,
  mainDisplaySize,
  parseNativeSize,
} from './native-resolution.mjs';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const packageDirectory = join(repository, 'packages/native-host');
const help = `Usage: scripts/remaster/native/play-native.sh [--open] [--size WxH]

Required environment:
  RA2_NATIVE_GAME_DIR           Player-owned game copy containing gamemd.exe.
  RA2_NATIVE_WINE_BOTTLE        Existing CrossOver bottle name; or
  RA2_NATIVE_WINE_PREFIX        Existing Wine prefix directory (WINEPREFIX also works).

Optional environment:
  RA2_NATIVE_WINE               Wine executable; otherwise PATH/CrossOver discovery.
  RA2_HD_CACHE_DIR              Existing HD cache, passed unchanged to Vite.
  NATIVE_HOST_CC/WINDRES/GO      Installed local build tools.

Starts a hidden native game and the local development page, attached directly to
the supplied YR copy with the shared HD play look. --open opens Google Chrome.
--size defaults to the main macOS display's size in points, capped to supported
game/picture bounds. Writes only the resolution keys in the supplied RA2MD.INI
before start and retains its original backup. Native resolution stays fixed for
the session; resizing Chrome scales its picture. Keep this terminal open.
Ctrl-C stops the owned game/page and restores a backed-up DLL. No downloads,
bottle-wide shutdown, or game automation are performed.`;

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function validateHdCache(environment) {
  // Match Vite's cache root and the existing HD launcher's _library contract.
  const cache = resolve(repository, environment.RA2_HD_CACHE_DIR || 'gameres/hd-cache');
  const library = join(cache, '_library');
  const info = await stat(library).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw new Error(`无法读取高清缓存：${cache}。请检查文件夹的路径和访问权限。`, { cause: error });
  });
  if (!info?.isDirectory())
    throw new Error(`找不到高清缓存：${cache}。请将 RA2_HD_CACHE_DIR 指向已有且包含 _library 文件夹的高清缓存。`);
  await access(library, constants.R_OK | constants.X_OK).catch(() => {
    throw new Error(`无法读取高清缓存：${cache}。请检查文件夹的访问权限。`);
  });
  return cache;
}

export async function waitForStartupCommand(item, milliseconds, message) {
  let timer;
  try {
    await Promise.race([
      item.done,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function sameFile(left, right) {
  try {
    const [a, b] = await Promise.all([readFile(left), readFile(right)]);
    return a.equals(b);
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

export function assertOwnedExecutableIdentity(hello, expected) {
  const identity = hello.exe;
  if (!Number.isSafeInteger(identity?.size) || identity.size <= 0 || !/^[a-f0-9]{64}$/i.test(identity.sha256 ?? ''))
    throw new Error(
      'Native agent could not read the owned executable identity (empty size/SHA-256); NativeCore cannot attach',
    );
  if (identity.size !== expected.size || identity.sha256.toLowerCase() !== expected.sha256)
    throw new Error(
      'Native agent executable identity differs from the supplied owned game copy; NativeCore cannot attach',
    );
  if (identity.verified !== true)
    throw new Error(
      `Owned game build is unsupported by the native page policy: size=${identity.size}, SHA-256=${identity.sha256}; NativeCore cannot attach`,
    );
}

export function nativeMainMenuReady(hello, state) {
  const surface = hello.surface;
  if (
    !surface ||
    surface.width <= 0 ||
    surface.height <= 0 ||
    state.modal !== true ||
    state.controlsTruncated !== false
  )
    return false;
  return (
    state.controls?.some((control) => {
      if (
        control.id !== 1667 ||
        !control.visible ||
        !control.enabled ||
        !Array.isArray(control.rect) ||
        control.rect.length !== 4
      )
        return false;
      const [left, top, right, bottom] = control.rect;
      return (
        control.rect.every(Number.isFinite) &&
        left >= 0 &&
        top >= 0 &&
        right > left &&
        bottom > top &&
        right <= surface.width &&
        bottom <= surface.height
      );
    }) ?? false
  );
}

// Every overwritten file has a verified, exclusive backup first. Restoration
// is conditional on unchanged installed bytes, so later player changes survive.
export async function installDll(source, target, runDirectory) {
  const installed = join(runDirectory, 'ddraw.installed.dll');
  await copyFile(source, installed, constants.COPYFILE_EXCL);
  let original = null;
  let mode = null;
  const stat = await lstat(target).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (stat) {
    if (!stat.isFile()) throw new Error(`Refusing to replace a non-regular DLL: ${target}`);
    mode = stat.mode & 0o777;
    original = join(runDirectory, 'ddraw.original.dll');
    await copyFile(target, original, constants.COPYFILE_EXCL);
    if (!(await sameFile(target, original)))
      throw new Error('DLL changed while its backup was being made; leaving it alone');
  }
  const staging = join(dirname(target), `.native-host-ddraw-${randomUUID()}.dll`);
  try {
    await copyFile(installed, staging, constants.COPYFILE_EXCL);
    if (mode !== null) await chmod(staging, mode);
    if (original) await rename(staging, target);
    else await link(staging, target); // Exclusive installation if no DLL existed.
  } finally {
    await unlink(staging).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
  const installedStat = await lstat(target);
  return {
    backup: original,
    async restore() {
      const current = await lstat(target).catch((error) => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
      if (!current?.isFile() || current.dev !== installedStat.dev || current.ino !== installedStat.ino)
        return { restored: false, reason: 'DLL was replaced or disappeared during play; backup retained' };
      if (!(await sameFile(target, installed)))
        return { restored: false, reason: 'DLL changed or disappeared during play; backup retained' };
      if (!original) {
        await unlink(target);
        return { restored: true, reason: 'Removed the DLL created by this launch' };
      }
      const restorePath = join(dirname(target), `.native-host-restore-${randomUUID()}.dll`);
      try {
        await copyFile(original, restorePath, constants.COPYFILE_EXCL);
        await chmod(restorePath, mode);
        await rename(restorePath, target);
      } finally {
        await unlink(restorePath).catch((error) => {
          if (error.code !== 'ENOENT') throw error;
        });
      }
      return { restored: true, reason: 'Restored the original DLL; backup retained' };
    },
  };
}

export async function findPorts(serverFactory) {
  const { createServer } = await import('node:net');
  const held = [];
  try {
    for (let port = 15450; port <= 15459 && held.length < 2; port++) {
      // Reservation listeners must reject probes: close() otherwise waits for a
      // polling client's accepted connection before the real agent can launch.
      const server = (serverFactory ?? createServer)((socket) => socket.destroy());
      try {
        await new Promise((resolve, reject) => {
          server.once('error', reject);
          server.listen({ host: '127.0.0.1', port, exclusive: true }, resolve);
        });
        held.push({ port, server });
      } catch (error) {
        if (error.code !== 'EADDRINUSE') throw error;
      }
    }
    if (held.length !== 2)
      throw new Error('Need two free loopback ports in 15450–15459; stop an existing owned session first');
    return { agent: held[0].port, page: held[1].port };
  } finally {
    await Promise.all(held.map(({ server }) => new Promise((resolve) => server.close(resolve))));
  }
}

function executableOnPath(name) {
  const result = spawnSync('/usr/bin/which', [name], { encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : null;
}

async function wineConfiguration(environment) {
  const bottle = environment.RA2_NATIVE_WINE_BOTTLE;
  const explicitPrefix = environment.RA2_NATIVE_WINE_PREFIX;
  if (bottle && explicitPrefix) throw new Error('RA2_NATIVE_WINE_BOTTLE 和 RA2_NATIVE_WINE_PREFIX 只能设置一个。');
  const prefix = explicitPrefix || (!bottle && environment.WINEPREFIX);
  if (!bottle && !prefix)
    throw new Error(
      '请将 RA2_NATIVE_WINE_BOTTLE 设置为已有的专用 Wine 容器名称，或用 RA2_NATIVE_WINE_PREFIX 指定已有的 Wine 文件夹。',
    );
  let wine = environment.RA2_NATIVE_WINE || executableOnPath('wine');
  if (!wine && process.platform === 'darwin') {
    const search = spawnSync('/usr/bin/mdfind', ['kMDItemCFBundleIdentifier == "com.codeweavers.CrossOver"'], {
      encoding: 'utf8',
    });
    for (const app of search.stdout?.trim().split('\n') || []) {
      const candidate = join(app, 'Contents/SharedSupport/CrossOver/bin/wine');
      if (await exists(candidate)) {
        wine = candidate;
        break;
      }
    }
  }
  if (!wine) throw new Error('找不到 Wine。请安装 Wine 或 CrossOver，并用 RA2_NATIVE_WINE 指定它的运行程序。');
  await access(wine, constants.X_OK).catch((error) => {
    if (error.code === 'ENOENT') throw new Error(`找不到 Wine 程序：${wine}。请检查 RA2_NATIVE_WINE 指定的路径。`);
    throw new Error(`Wine 无法运行：${wine}。请检查 RA2_NATIVE_WINE 的路径和执行权限。`);
  });
  const scopeEnvironment = { ...environment };
  if (prefix) {
    const absolutePrefix = resolve(prefix);
    const stat = await lstat(absolutePrefix).catch(() => null);
    if (!stat?.isDirectory() || !(await exists(join(absolutePrefix, 'system.reg'))))
      throw new Error(
        `找不到已有的 Wine 文件夹：${absolutePrefix}（应包含 system.reg）。请检查 RA2_NATIVE_WINE_PREFIX；启动器不会创建 Wine 环境。`,
      );
    scopeEnvironment.WINEPREFIX = absolutePrefix;
  } else {
    if (bottle.includes('/') || bottle.includes('\\'))
      throw new Error('RA2_NATIVE_WINE_BOTTLE 应填写容器名称；文件夹路径请填写到 RA2_NATIVE_WINE_PREFIX。');
    // CrossOver's normal macOS bottle root, or its user-supplied search root.
    const bottleRoots = (
      environment.CX_BOTTLE_PATH || join(homedir(), 'Library/Application Support/CrossOver/Bottles')
    ).split(':');
    if (!(await Promise.all(bottleRoots.map((root) => exists(join(root, bottle, 'system.reg'))))).some(Boolean))
      throw new Error(
        `找不到已有的 CrossOver 容器：${bottle}。自定义位置请设置 CX_BOTTLE_PATH，或用 RA2_NATIVE_WINE_PREFIX 指定文件夹。`,
      );
    delete scopeEnvironment.WINEPREFIX;
  }
  return { wine, args: bottle ? ['--bottle', bottle] : [], environment: scopeEnvironment };
}

export async function runLauncher(arguments_, environment = process.env) {
  if (arguments_.includes('--help') || arguments_.includes('-h')) {
    console.log(help);
    return;
  }
  let openBrowser = false;
  let requestedSize = null;
  for (let index = 0; index < arguments_.length; index++) {
    const argument = arguments_[index];
    if (argument === '--open') openBrowser = true;
    else if (argument === '--size') requestedSize = parseNativeSize(arguments_[++index]);
    else throw new Error(`Unknown argument: ${argument}; use --help`);
  }
  if (!environment.RA2_NATIVE_GAME_DIR)
    throw new Error('没有设置游戏文件夹。请将 RA2_NATIVE_GAME_DIR 指向你拥有且包含 gamemd.exe 的游戏副本。');
  const gameDirectory = resolve(environment.RA2_NATIVE_GAME_DIR);
  const gameExecutable = join(gameDirectory, 'gamemd.exe');
  const executableBytes = await readFile(gameExecutable).catch((error) => {
    if (error.code === 'ENOENT')
      throw new Error(`找不到游戏程序：${gameExecutable}。请检查 RA2_NATIVE_GAME_DIR，并提供你拥有的完整游戏文件。`);
    throw new Error(`无法读取游戏程序：${gameExecutable}。请检查游戏文件和访问权限。`, { cause: error });
  });
  const expectedIdentity = {
    size: executableBytes.length,
    sha256: createHash('sha256').update(executableBytes).digest('hex'),
  };
  const wine = await wineConfiguration(environment);
  await validateHdCache(environment);
  const resolution = capNativeResolution(requestedSize ?? mainDisplaySize());
  const vite = join(repository, 'node_modules/vite/bin/vite.js');
  if (!(await exists(vite))) throw new Error('启动器所需的本地组件缺失。请先完成项目准备，再运行启动器。');

  await mkdir(join(packageDirectory, 'build'), { recursive: true });
  const runDirectory = await mkdtemp(join(packageDirectory, 'build/play-'));
  await chmod(runDirectory, 0o700);
  console.log('正在启动游戏；本次记录和文件备份的位置如下。');
  console.log(`Private launch logs and DLL backups: ${runDirectory}`);
  const stopPath = join(runDirectory, 'stop');
  const statusPath = join(runDirectory, 'status.json');
  const owned = new Set();
  let installation;
  let launcher;
  let cleanupPromise;
  let stopping = false;
  function start(command, args, options = {}) {
    if (stopping) throw new Error('启动已取消。');
    const child = spawn(command, args, {
      cwd: repository,
      env: wine.environment,
      detached: true,
      stdio: 'inherit',
      ...options,
    });
    const item = { child, exited: false, closed: false, error: null, code: null };
    owned.add(item);
    item.closedDone = new Promise((resolve) => {
      child.once('close', () => {
        item.closed = true;
        resolve();
      });
    });
    item.done = new Promise((resolve) => {
      child.once('error', (error) => {
        item.error = error;
        item.exited = true;
        resolve();
      });
      child.once('exit', (code, signal) => {
        item.code = code ?? (signal ? 1 : 0);
        item.exited = true;
        resolve();
      });
    });
    return item;
  }
  async function complete(item) {
    await item.done;
    if (stopping) throw new Error('启动已取消。');
    if (item.error) throw item.error;
    if (item.code !== 0) throw new Error(`启动步骤失败，退出码 ${item.code}。请查看本次启动记录。`);
  }
  function kill(item, signal) {
    // A command wrapper can exit while its owned descendants still hold the
    // pipes open. Its detached group remains ours until those handles close.
    if (!item.closed && item.child.pid) {
      try {
        process.kill(-item.child.pid, signal);
      } catch (error) {
        if (error.code !== 'ESRCH') throw error;
      }
    }
  }
  async function cleanup() {
    if (cleanupPromise) return cleanupPromise;
    stopping = true;
    cleanupPromise = (async () => {
      await writeFile(stopPath, 'stop\n', { mode: 0o600 });
      // The helper watches this private file and its job contains only its game.
      // Never kill a whole Wine server, prefix, executable name or another page.
      if (launcher && !launcher.exited) await Promise.race([launcher.done, delay(5000, undefined, { ref: false })]);
      for (const item of owned) kill(item, 'SIGTERM');
      await Promise.race([
        Promise.all([...owned].map((item) => item.closedDone)),
        delay(1500, undefined, { ref: false }),
      ]);
      for (const item of owned) kill(item, 'SIGKILL');
      await Promise.all([...owned].map((item) => item.closedDone));
      if (installation) {
        const result = await installation.restore();
        console.log(result.reason);
      }
    })();
    return cleanupPromise;
  }
  const signalHandler = () => {
    stopping = true;
    // Let the current file transaction finish before final restoration. Killing
    // finite startup/page children breaks awaited work; the helper gets its own
    // targeted stop request and keeps its job handle until the game exits.
    void writeFile(stopPath, 'stop\n', { mode: 0o600 }).catch((error) =>
      console.error(`Stop request failed: ${error.message}`),
    );
    for (const item of owned) {
      if (item !== launcher) {
        try {
          kill(item, 'SIGTERM');
        } catch (error) {
          console.error(`Stop failed: ${error.message}`);
        }
      }
    }
  };
  process.on('SIGINT', signalHandler);
  process.on('SIGTERM', signalHandler);
  process.on('SIGHUP', signalHandler);
  try {
    console.log('正在检查 Wine 是否能正常运行……');
    let checkOutput = '';
    let checkErrors = '';
    const wineCheck = start(wine.wine, [...wine.args, 'cmd.exe', '/c', 'echo RA2_NATIVE_WINE_OK'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    wineCheck.child.stdout.setEncoding('utf8');
    wineCheck.child.stderr.setEncoding('utf8');
    wineCheck.child.stdout.on('data', (chunk) => {
      checkOutput = (checkOutput + chunk).slice(-8192);
    });
    wineCheck.child.stderr.on('data', (chunk) => {
      checkErrors = (checkErrors + chunk).slice(-8192);
    });
    try {
      await waitForStartupCommand(
        { done: wineCheck.closedDone },
        30000,
        'Wine 自检超过 30 秒仍未完成，游戏尚未启动。请检查 Wine 或 CrossOver 能否运行程序后再试；详情见 wine-check.log。',
      );
    } finally {
      await writeFile(join(runDirectory, 'wine-check.log'), `${checkOutput}\n${checkErrors}`, { mode: 0o600 });
    }
    if (stopping) throw new Error('启动已取消。');
    if (
      wineCheck.error ||
      wineCheck.code !== 0 ||
      !checkOutput.split(/\r?\n/).some((line) => line.trim() === 'RA2_NATIVE_WINE_OK')
    )
      throw new Error(
        'Wine 自检失败，游戏尚未启动。请检查 Wine 或 CrossOver 和所选容器是否能正常运行程序；详情见 wine-check.log。',
      );
    console.log('Wine 自检通过。');
    const dll = join(packageDirectory, 'build/ddraw.dll');
    const helper = join(packageDirectory, 'build/ra2launch.exe');
    if (!(await exists(dll))) await complete(start('bash', [join(packageDirectory, 'build.sh')]));
    if (!(await exists(helper))) await complete(start('bash', [join(packageDirectory, 'launcher/build.sh')]));
    await complete(start('pnpm', ['--filter', 'relay-package', 'run', 'build:lib']));
    const ports = await findPorts();
    const origin = `http://127.0.0.1:${ports.page}`;
    const agentUrl = `ws://127.0.0.1:${ports.agent}`;
    const token = randomBytes(32).toString('hex');
    async function windowsPath(path) {
      let output = '';
      let truncated = false;
      const item = start(wine.wine, [...wine.args, 'winepath.exe', '-w', path], {
        stdio: ['ignore', 'pipe', 'inherit'],
      });
      item.child.stdout.setEncoding('utf8');
      item.child.stdout.on('data', (chunk) => {
        if (output.length + chunk.length > 65536) truncated = true;
        else if (!truncated) output += chunk;
      });
      await waitForStartupCommand(
        { done: item.closedDone },
        30000,
        'Wine 无法在 30 秒内读取文件路径，游戏尚未启动。请检查 Wine 或 CrossOver 后再试。',
      );
      await complete(item);
      if (truncated) throw new Error('Wine 返回的文件路径超过安全范围，游戏尚未启动。请检查本次启动记录。');
      const result = output.trim();
      if (!/^(?:[a-z]:\\|\\\\)[^\r\n]*$/i.test(result))
        throw new Error('Wine 无法读取指定的文件路径。请查看本次启动记录。');
      return result;
    }
    const gamePath = await windowsPath(gameExecutable);
    const stopFile = await windowsPath(stopPath);
    const statusFile = await windowsPath(statusPath);
    const logFile = await windowsPath(join(runDirectory, 'launcher.log'));
    // The development source provider scopes the unified RA2/YR inventory to
    // ra2/. Keep that existing contract without rearranging the player's copy.
    const gameRoot = join(runDirectory, 'game');
    await mkdir(gameRoot);
    await symlink(gameDirectory, join(gameRoot, 'ra2'), 'dir');
    const configured = await configureNativeResolution(gameDirectory, runDirectory, resolution);
    console.log(
      `Native resolution: ${resolution.width}x${resolution.height} (fixed for this session; ${configured.target})`,
    );
    console.log(`本次游戏画面为 ${resolution.width}×${resolution.height}；需要改变尺寸时请退出并重新启动。`);
    installation = await installDll(dll, join(gameDirectory, 'ddraw.dll'), runDirectory);
    const { open } = await import('node:fs/promises');
    const pageLog = await open(join(runDirectory, 'page.log'), 'wx', 0o600);
    let page;
    try {
      page = start(process.execPath, [vite, '--host', '127.0.0.1', '--port', String(ports.page), '--strictPort'], {
        env: { ...wine.environment, RA2_DEV_HTTP: '1', RA2_GAME_ROOT: gameRoot },
        stdio: ['ignore', pageLog.fd, pageLog.fd],
      });
    } finally {
      await pageLog.close();
    }
    const startupDeadline = Date.now() + 30000;
    for (;;) {
      if (stopping || page.exited) throw new Error('游戏页面在启动时退出。请查看本次记录中的 page.log。');
      try {
        const response = await fetch(origin, { signal: AbortSignal.timeout(1000) });
        if (response.ok) break;
      } catch {}
      if (Date.now() >= startupDeadline) throw new Error('游戏页面未能在 30 秒内启动。请查看本次记录中的 page.log。');
      await delay(100);
    }
    const gameLog = await open(join(runDirectory, 'wine.log'), 'wx', 0o600);
    const gameEnvironment = {
      ...wine.environment,
      RA2_NATIVE_AGENT_PORT: String(ports.agent),
      RA2_NATIVE_AGENT_TOKEN: token,
      RA2_NATIVE_AGENT_ORIGIN: origin,
      // Visible operation is an explicit diagnostic comparison mode. Owner
      // launches retain hidden operation unless this exact opt-out is supplied.
      RA2_NATIVE_AGENT_HIDDEN: environment.RA2_NATIVE_AGENT_HIDDEN === '0' ? '0' : '1',
      WINEDLLOVERRIDES: `${wine.environment.WINEDLLOVERRIDES ? `${wine.environment.WINEDLLOVERRIDES};` : ''}ddraw=n,b`,
    };
    try {
      launcher = start(
        wine.wine,
        [...wine.args, helper, '--stop-file', stopFile, '--status-file', statusFile, '--log', logFile, gamePath],
        { env: gameEnvironment, stdio: ['ignore', gameLog.fd, gameLog.fd] },
      );
    } finally {
      await gameLog.close();
    }
    const agentDeadline = Date.now() + 60000;
    let hello;
    for (;;) {
      if (stopping || launcher.exited)
        throw new Error('游戏未能正常启动或已退出。请查看本次记录中的 launcher.log 和 wine.log。');
      let client;
      let receivedHello = false;
      try {
        const status = JSON.parse(await readFile(statusPath, 'utf8'));
        if (!status.handshake || !status.running) throw new Error('Waiting for original launcher handshake');
        client = new AgentClient(agentUrl, token, origin);
        hello = await client.connect();
        receivedHello = true;
        if (hello.pid !== status.pid) throw new Error('Agent process identity differs from the owned launcher process');
        if (!!hello.hiddenHost?.enabled !== (gameEnvironment.RA2_NATIVE_AGENT_HIDDEN === '1'))
          throw new Error('The owned agent did not report the requested visibility mode');
        assertOwnedExecutableIdentity(hello, expectedIdentity);
        receivedHello = false; // A valid identity can precede the native menu.
        const inputState = JSON.parse((await client.request(Type.INPUT_STATE)).toString());
        if (!nativeMainMenuReady(hello, inputState))
          throw new Error('Waiting for the usable original native main menu');
        break;
      } catch (error) {
        if (receivedHello) throw error;
        if (Date.now() >= agentDeadline)
          throw new Error(
            `游戏在 60 秒内没有进入可操作的主菜单：${error.message}。请查看本次记录中的 launcher.log 和 wine.log。`,
          );
      } finally {
        if (client) {
          const closed = new Promise((resolve) => client.once('closed', resolve));
          client.close();
          await Promise.race([closed, delay(1000, undefined, { ref: false })]);
          if (client.ws.readyState !== 3) client.ws.terminate();
        }
      }
      await delay(100);
    }
    const url = new URL(origin);
    url.search = new URLSearchParams({
      ...HD_PLAY_OPTIONS,
      backend: 'native',
      agent: agentUrl,
      'agent-token': token,
      'native-autostart': 'yr',
      resolution: `${resolution.width}x${resolution.height}`,
    }).toString();
    console.log(`Native process ${hello.pid}; agent ${ports.agent}; page ${ports.page}`);
    console.log(`Play URL: ${url.href}`);
    console.log('请在 Chrome 打开上面的游戏网址。保留本窗口；按 Ctrl-C 可退出本次游戏。');
    if (openBrowser) await complete(start('/usr/bin/open', ['-a', 'Google Chrome', url.href]));
    await Promise.race([launcher.done, page.done]);
    if (!stopping && page.exited) throw new Error('游戏页面已停止，正在关闭本次游戏。');
    if (!stopping && launcher.error) throw launcher.error;
    if (!stopping && launcher.code !== 0)
      throw new Error(`游戏启动器异常退出，退出码 ${launcher.code}。请查看本次启动记录。`);
  } finally {
    await cleanup();
    process.off('SIGINT', signalHandler);
    process.off('SIGTERM', signalHandler);
    process.off('SIGHUP', signalHandler);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runLauncher(process.argv.slice(2)).catch((error) => {
    console.error(`Native play: ${error.message}`);
    process.exitCode = 1;
  });
}
