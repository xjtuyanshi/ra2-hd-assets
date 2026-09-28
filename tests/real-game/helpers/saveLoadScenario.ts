import { readFileSync, readdirSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import { V86 } from 'v86';
import { VmCore, type VmAudioSink } from '../../../src/adapter/vmCore';
import { PortGameFileProvider, serveFileProvider } from '../../../src/adapter/fileProviderPort';
import type { VmStatus } from '../../../src/app/session/runtimeEvents';
import { SUPPORTED_GAMES, type SupportedGameId } from '../../../src/games/catalog';
import { Win32Shim } from '../../../src/games/win32Shim';
import { RA2_YR_RESOURCE_POLICY } from '../../../src/games/shared/resourcePolicy';
import type { GameFrameReader } from '../../../src/games/performance';
import { MemoryGameFileProvider } from '../../../src/resources/providers/memory';
import { normalizeGuestPath } from '../../../src/vm86/paths';
import { requireGameResources, REPO_ROOT, resolveGameDir } from './gameDir';

class InspectableShim extends Win32Shim {
  public override isWindowVisible(hwnd: number) {
    return super.isWindowVisible(hwnd);
  }
  public override screenRect(hwnd: number) {
    return super.screenRect(hwnd);
  }
}

const silentAudio: VmAudioSink = {
  createBuffer() {},
  duplicateBuffer: () => true,
  setFormat: () => true,
  writeBuffer: (_id, _offset, bytes) => bytes.byteLength,
  play: () => true,
  stop: () => true,
  setCurrentPosition: () => true,
  setVolume: () => true,
  setPan: () => true,
  setFrequency: () => true,
  getState: () => null,
  releaseBuffer: () => true,
  setMasterVolume() {},
  stopAll() {},
  async destroy() {},
};

/** Read installation files lazily; never write saves into the player's installation. */
class InstallationFiles extends MemoryGameFileProvider {
  private readonly paths = new Map<string, string>();
  constructor(directory: string) {
    super();
    const visit = (relative: string) => {
      for (const entry of readdirSync(join(directory, relative), { withFileTypes: true })) {
        const path = relative ? `${relative}/${entry.name}` : entry.name;
        if (entry.isDirectory()) visit(path);
        else if (!/\.(sav|ini)$/i.test(path)) this.paths.set(normalizeGuestPath(path), join(directory, path));
      }
    };
    visit('');
  }
  hasKnownFile(path: string): boolean {
    return this.files.has(normalizeGuestPath(path)) || this.paths.has(normalizeGuestPath(path));
  }
  override async read(path: string): Promise<Uint8Array | null> {
    const own = await super.read(path);
    if (own) return own;
    const disk = this.paths.get(normalizeGuestPath(path));
    return disk ? new Uint8Array(readFileSync(disk)) : null;
  }
  override async readPrefix(path: string, length: number) {
    const bytes = await this.read(path);
    return bytes ? { bytes: bytes.slice(0, length), totalSize: bytes.length } : null;
  }
  override async readRange(path: string, offset: number, length: number) {
    return (await this.read(path))?.slice(offset, offset + length) ?? null;
  }
  override async list(directory: string): Promise<string[]> {
    const prefix = normalizeGuestPath(directory);
    const entries = new Set<string>();
    for (const path of [...this.paths.keys(), ...this.files.keys()]) {
      if (prefix && !path.startsWith(`${prefix}/`)) continue;
      entries.add((prefix ? path.slice(prefix.length + 1) : path).split('/')[0]!);
    }
    return [...entries];
  }
}

interface SaveSnapshot {
  bytes: Uint8Array;
  frame: number;
  objects: number;
}

async function runSession(
  gameId: SupportedGameId,
  expectedHash: string,
  saved?: SaveSnapshot,
): Promise<SaveSnapshot | undefined> {
  const game = SUPPORTED_GAMES.find((game) => game.id === gameId)!;
  const files = new InstallationFiles(resolveGameDir(gameId));
  if (saved) await files.write('cold.sav', saved.bytes.slice());
  const executableBytes = (await files.read(game.executable))!;
  // The read-only frame counter is version-specific.
  expect(createHash('sha256').update(executableBytes).digest('hex')).toBe(expectedHash);
  const channel = new MessageChannel();
  const close = serveFileProvider(files, channel.port1);
  const remote = new PortGameFileProvider('cold-load regression', channel.port2, await files.list(''));
  let shim!: InspectableShim;
  let vm!: V86;
  let frameReader: GameFrameReader | undefined;
  let status: VmStatus | undefined;
  let writingSave = false;
  let readingSave = false;
  let restoredFrame: number | undefined;
  let savedObjects = 0;
  let loadedObjects = 0;
  const core = new VmCore(
    {
      onStatus: (next) => (status = next),
      onCall: (call) => {
        const key = call.imported.key;
        if (writingSave && key === 'OLE32.DLL!OleSaveToStream') {
          savedObjects++;
        }
        if (readingSave && key === 'OLE32.DLL!OleLoadFromStream') loadedObjects++;

        // Read-only observation: never seed the new VM with old heap addresses or game state.
        if (readingSave && loadedObjects && restoredFrame === undefined) {
          const frame = nativeFrame();
          if (frame > 0) restoredFrame = frame;
        }
      },
    },
    {
      game,
      files: remote,
      executableBytes,
    },
    {
      resourcePolicy: RA2_YR_RESOURCE_POLICY,
      fetchBytes: async () => new Uint8Array(readFileSync(join(REPO_ROOT, 'src/vm86/boot.bin'))),
      scheduleFrame: (emit) => setImmediate(emit),
      deferFrameSnapshot: true,
      fastFileRead: true,
      audio: silentAudio,
      createEmulator: (options) =>
        (vm = new V86({ ...options, wasm_path: join(REPO_ROOT, 'node_modules/v86/build/v86.wasm') })),
      createShim: (memory, options) => (shim = new InspectableShim(memory, options)),
    },
  );
  const visible = (text: string) =>
    shim.inspectWindowState().find((window) => window.text === text && shim.isWindowVisible(window.hwnd));
  const wait = async (label: string, condition: () => boolean, timeoutMs = 60_000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (status && ['error', 'blocked', 'exited'].includes(status.phase)) throw new Error(status.detail);
      if (condition()) return;
      await delay(100);
    }
    throw new Error(`Timed out waiting for ${label}: ${status?.detail}`);
  };
  const click = (hwnd: number) => {
    const rect = shim.screenRect(hwnd);
    const x = (rect.x + rect.width / 2) | 0;
    const y = (rect.y + rect.height / 2) | 0;
    const point = (y << 16) | x;
    core.setCursorPosition(x, y);
    core.postMessage(0x200, 0, point);
    core.setKeyState(1, true);
    core.postMessage(0x201, 1, point);
    core.setKeyState(1, false);
    core.postMessage(0x202, 0, point);
  };
  const button = async (text: string) => {
    await wait(text, () => !!visible(text));
    // Native menu transitions briefly expose controls before accepting mouse input.
    await delay(2500);
    click(visible(text)!.hwnd);
  };
  const nativeFrame = () => {
    frameReader ??= game.runtimeHooks!.createFrameReader!(vm, expectedHash)!;
    const counters = frameReader?.();
    if (!counters) throw new Error('Unsupported native frame counter');
    return counters.frame;
  };
  try {
    await core.start();
    // VmCore already applies the signature-validated logo skip. Full YR packages can
    // still play an intro: dismiss it through normal keyboard messages, only until
    // the main menu appears. Retry because startup may not yet be accepting input.
    let nextEscape = Date.now() + 1000;
    await wait(
      'main menu',
      () => {
        if (visible('GUI:SinglePlayer')) return true;
        if (gameId === 'yr' && Date.now() >= nextEscape) {
          core.postMessage(0x100, 27, 1);
          core.postMessage(0x101, 27, 0xc0000001);
          nextEscape = Date.now() + 1000;
        }
        return false;
      },
      gameId === 'yr' ? 180_000 : 60_000,
    );
    await delay(8000);
    await button('GUI:SinglePlayer');
    if (saved) {
      // No battle startup, warmup match, save, or reused shim before loading.
      await button('GUI:LoadSavedGame');
      await wait('save list', () => !!visible('GUI:Load'));
      const list = shim.inspectWindowState().find((w) => w.className === 'ListBox' && shim.isWindowVisible(w.hwnd))!;
      click(list.hwnd);
      core.postMessage(0x100, 0x24, 1);
      core.postMessage(0x101, 0x24, 0xc0000001);
      readingSave = true;
      await button('GUI:Load');
      await wait('loaded battlefield', () => shim.inspectWindowState().length === 1);
      expect(restoredFrame, 'native frame restored from the save').toBe(saved.frame);
      expect(loadedObjects, 'native object restoration count').toBe(saved.objects);
      const before = nativeFrame();
      await wait('loaded simulation advances', () => nativeFrame() > before + 60);
      // The loaded game must still accept input; frame progression alone misses broken modal state.
      core.postMessage(0x100, 27, 1);
      core.postMessage(0x101, 27, 0xc0000001);
      await wait('loaded game pause menu', () => !!visible('GUI:SaveGame'));
      return;
    }
    await button('GUI:Skirmish');
    await button('GUI:StartGame');
    await wait('battlefield', () => shim.inspectWindowState().length === 1);
    const before = nativeFrame();
    await wait('battle simulation advances', () => nativeFrame() > before + 120);
    core.postMessage(0x100, 27, 1);
    core.postMessage(0x101, 27, 0xc0000001);
    await button('GUI:SaveGame');
    writingSave = true;
    await button('GUI:Save');
    await wait('save confirmation', () => !!visible('GUI:OK'));
    await core.flushFiles();
    const result = [...files.files].find(([path]) => path.endsWith('.sav'))?.[1];
    expect(result).toBeDefined();
    expect(savedObjects, 'native persistence must not be a successful no-op').toBeGreaterThan(0);
    const snapshot = { bytes: result!.slice(), frame: nativeFrame(), objects: savedObjects };
    await button('GUI:OK');
    await wait('save confirmation closes', () => !visible('GUI:OK'));
    return snapshot;
  } finally {
    try {
      await core.destroy();
    } finally {
      remote.dispose();
      close();
    }
  }
}

// Fail at collection time: missing game resources must surface as a failure, never as a silently removed suite.
export function describeSaveLoad(gameId: SupportedGameId, expectedHash: string): void {
  requireGameResources(gameId);
  describe(`${gameId} native save cold load`, () => {
    // Both sessions may play the YR intro; budget the extra main-menu wait twice.
    const timeoutMs = gameId === 'yr' ? 480_000 : 240_000;
    it(
      'saves through the normal menus, then loads persisted bytes in a fresh VM through the file port',
      async () => {
        const saved = await runSession(gameId, expectedHash);
        const directory = await mkdtemp(join(tmpdir(), 'ra2-save-load-'));
        try {
          const path = join(directory, 'cold.sav');
          await writeFile(path, saved!.bytes);
          await runSession(gameId, expectedHash, { ...saved!, bytes: new Uint8Array(await readFile(path)) });
        } finally {
          await rm(directory, { recursive: true, force: true });
        }
      },
      timeoutMs,
    );
  });
}
