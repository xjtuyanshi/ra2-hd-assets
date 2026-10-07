import { t } from '../../shared/i18n/translate';
import { GAME_ARCHIVE_DIRECTORY_RULES } from '../../../games/archivePolicy';
import { SUPPORTED_GAMES, supportedGame, type SupportedGameId } from '../../../games/catalog';
import { HttpGameFileProvider } from '../../../platform/browser/files/http';
import { loadPreferredGame, rememberPreferredGame } from '../../../platform/browser/files/directoryAccess';
import { developmentGameRoot } from './training/trainingQuery';
import { validateGameDirectory } from '../../../resources/discovery/discoverGameSources';
import { OverlayGameFileProvider } from '../../../resources/providers/overlay';
import { ScopedGameFileProvider } from '../../../resources/providers/scoped';
import { type GameFileProvider } from '../../../resources/contracts';
import { type GameSource } from '../../../games/source';
import { SessionGameFileProvider } from '../../../platform/browser/files/sessionFiles';
import { extractArchiveFiles } from '../../../utils/archive/archiveExtract';
import { openGameArchive } from '../../../adapter/gameArchiveLayers';
import { ProgressiveGameFileProvider, progressiveFilesOf } from '../../../adapter/progressiveFiles';
import { restoreCachedFileProvider, saveCachedGameFiles } from '../../../adapter/cachedGameFiles';
import { loadThirdPartyFiles } from '../../../adapter/thirdPartyFiles';
import { ARCHIVE_WANTED_NAMES, GAME_MANIFESTS, type GameManifest } from '../../../games/manifest';
import { createStore } from '../../shared/state/store';

export interface PickerState {
  description: string;
  error: string;
  busy: boolean;
  games: SupportedGameId[];
  manifest: { manifest: GameManifest; present: ReadonlySet<string>; complete: boolean } | null;
}

/** Resource-import service: accepts files/versions and publishes state; the React hook owns file-picker lifetime. */
export function createGameSourcePicker(resolve: (source: GameSource) => void) {
  let disposed = false;
  const state: PickerState = {
    description: t('先选择游戏资源；只包含一个版本时自动启动，包含两个版本时再选择要玩的游戏。'),
    error: '',
    busy: false,
    manifest: null,
    games: [],
  };
  const store = createStore({ ...state });
  let pendingSource: GameFileProvider | null = null;
  const publish = () => {
    if (!disposed) store.set({ ...state });
  };
  const setButtonsDisabled = (disabled: boolean): void => {
    state.busy = disabled;
    publish();
  };
  const presentNames = (names: Iterable<string>): Set<string> => new Set([...names].map((name) => name.toLowerCase()));
  const renderManifest = (manifest: GameManifest, present: ReadonlySet<string>, complete: boolean): void => {
    state.manifest = { manifest, present, complete };
    publish();
  };
  const use = async (load: () => Promise<GameFileProvider | null>, gameId?: SupportedGameId) => {
    state.error = '';
    publish();
    setButtonsDisabled(true);
    try {
      const base = await load();
      if (disposed) {
        if (base) progressiveFilesOf(base)?.cancel();
        return;
      }
      // null means canceled selection, such as closing the archive dialog; silently return to the panel using AbortError semantics.
      if (!base) throw new DOMException(t('已取消'), 'AbortError');
      if (gameId) await runImport(base, gameId);
      else {
        const names = presentNames(
          base instanceof ProgressiveGameFileProvider ? base.inventory : ((await base.list('')) ?? []),
        );
        const games = (Object.keys(GAME_MANIFESTS) as SupportedGameId[]).filter((id) =>
          GAME_MANIFESTS[id].playerRequired.every((file) => names.has(file.name.toLowerCase())),
        );
        if (games.length === 1) await runImport(base, games[0]!);
        else if (games.length > 1) {
          pendingSource = base;
          state.games = games;
          state.description = t('资源中包含以下游戏，请选择要启动的版本。');
          publish();
        } else {
          progressiveFilesOf(base)?.cancel();
          throw new Error(
            t('未找到完整游戏资源。') +
              (Object.keys(GAME_MANIFESTS) as SupportedGameId[])
                .map(
                  (id) =>
                    supportedGame(id).title +
                    t(' 缺少：') +
                    GAME_MANIFESTS[id].playerRequired
                      .filter((file) => !names.has(file.name.toLowerCase()))
                      .map((file) => file.name)
                      .join('、'),
                )
                .join('；'),
          );
        }
      }
    } catch (reason) {
      if ((reason as DOMException)?.name !== 'AbortError') {
        state.error = reason instanceof Error ? reason.message : String(reason);
        publish();
      }
    } finally {
      setButtonsDisabled(false);
    }
  };
  /**
   * Manifest gate: resolve the selected version's executable (game.exe / gamemd.exe) from the player's own files, overlay it, then render the manifest. Return null for missing required files while retaining the checklist.
   */
  const manifestGate = async (
    base: GameFileProvider,
    archiveNames: ReadonlySet<string>,
    gameId: SupportedGameId,
  ): Promise<GameFileProvider | null> => {
    const manifest = GAME_MANIFESTS[gameId];
    // A progressive archive may still be extracting other layers, but the executable belongs to the startup layer.
    const executables = await loadThirdPartyFiles(manifest, base, (message) => {
      state.description = message;
      publish();
    });
    if (disposed) return null;
    // Overlay-first so a development-cache executable fills a gap; player executables overlay identical bytes.
    const provider = new OverlayGameFileProvider(base, executables.files, t(' + 主程序'), false, false, false);
    const present = new Set(archiveNames);
    for (const name of executables.files.keys()) present.add(name.toLowerCase());
    const missing = [
      ...executables.missing,
      ...manifest.playerRequired.filter((file) => !present.has(file.name.toLowerCase())).map((file) => file.name),
    ];
    const complete = missing.length === 0;
    renderManifest(manifest, present, complete);
    if (!complete) {
      state.description =
        t('{0} 缺少必需文件：{1}。', supportedGame(gameId).title, missing.join('、')) +
        t('请重新选择包含这些文件的资源。');
      publish();
      return null;
    }
    const unpinned = executables.checks.filter((check) => !check.pinned).map((check) => check.name);
    state.description = unpinned.length
      ? t('{0} 与已验证版本不同，部分兼容补丁会自动停用；正在启动…', unpinned.join('、'))
      : t('必需文件已集齐，正在启动…');
    publish();
    // Remember this import, executables included, for automatic restoration next time without another selection.
    if (base instanceof SessionGameFileProvider) {
      const persist = () => {
        const playerFiles = new Map<string, Uint8Array>();
        for (const [path, bytes] of base.files) {
          const lower = path.toLowerCase();
          if (base instanceof ProgressiveGameFileProvider && !base.inventory.has(lower)) continue;
          playerFiles.set(lower, bytes);
        }
        // Layered imports must not fall back to required-files-only persistence on quota failure, which would lose empty movie placeholders
        // or MOD overrides. Let the transaction roll back on failure, retaining the last complete package.
        return saveCachedGameFiles(
          gameId,
          playerFiles,
          base instanceof ProgressiveGameFileProvider
            ? []
            : [...manifest.thirdParty, ...manifest.playerRequired].map((file) => file.name),
        );
      };
      // Wait for every other layer to succeed before replacing the cache atomically; cancellation/failure preserves the last complete asset set,
      // and startup-layer readiness must never be labeled a complete package restorable after refresh.
      if (base instanceof ProgressiveGameFileProvider) {
        void base.completion
          .then(persist)
          .catch((error) => console.warn(t('[游戏文件] 后台解压未完成，不更新资源缓存'), error));
      } else void persist();
    }
    return provider;
  };

  /** Finish import through the manifest gate; once complete, verify the executable and start, otherwise remain on the panel. */
  const runImport = async (base: GameFileProvider, gameId: SupportedGameId): Promise<void> => {
    try {
      const present =
        base instanceof ProgressiveGameFileProvider
          ? presentNames(base.inventory)
          : base instanceof SessionGameFileProvider
            ? presentNames(base.files.keys())
            : // Development uses a directory provider, not a memory archive; derive the manifest from the actual directory,
              // or a fixed empty manifest permanently traps complete resources in the picker and prevents browser regressions from starting.
              presentNames((await base.list('')) ?? []);
      const provider = await manifestGate(base, present, gameId);
      if (!provider) {
        progressiveFilesOf(base)?.cancel();
        return;
      }
      const source = (await validateGameDirectory(provider, gameId))[0]!;
      if (disposed) {
        progressiveFilesOf(base)?.cancel();
        return;
      }
      rememberPreferredGame(source.game.id);
      disposed = true;
      resolve(source);
    } catch (error) {
      progressiveFilesOf(base)?.cancel();
      throw error;
    }
  };

  // Write parsing/reading progress text into the panel description.
  const onStatus = (message: string): void => {
    if (state.games.length < 2) {
      state.description = message;
      publish();
    }
  };
  /**
   * Parse the selected archive. Reuse late change events by restarting the full use flow if the pending selection was already canceled, restoring disabled-button/error behavior. The manifest gate runs inside use.
   */
  const processArchiveFile = async (file: File): Promise<GameFileProvider | null> => {
    onStatus(t('正在解析归档目录并准备启动层…'));
    return openGameArchive(file, undefined, onStatus);
  };
  /** Read manifest-required files from the selected directory, handling late change like archives; the manifest gate runs in use. */
  const processFolderFiles = (files: File[]): Promise<GameFileProvider | null> =>
    (async () => {
      // Read only manifest-required files; match basenames at any depth.
      const wanted = presentNames(ARCHIVE_WANTED_NAMES);
      const wantedDirs = [...wanted].filter((name) => name.endsWith('/'));
      const extracted = new Map<string, Uint8Array>();
      const archives: File[] = [];
      const readBytes = async (file: File): Promise<Uint8Array> => new Uint8Array(await file.arrayBuffer());
      for (const file of files) {
        const name = file.name.toLowerCase();
        // Store directory-prefix entries such as taunts/ with their webkitRelativePath structure.
        const rel = file.webkitRelativePath.split('/').slice(1).join('/').toLowerCase();
        const storeKey = wanted.has(name) ? name : (wantedDirs.find((dir) => rel.startsWith(dir)) ?? null);
        if (storeKey) {
          extracted.set(storeKey, await readBytes(file));
        } else if (/\.(zip|rar|7z|exe)$/.test(name)) {
          archives.push(file);
        }
      }
      // Also recursively extract archives such as installers found inside directories, using the same 7z-wasm Worker;
      // ordinary EXEs such as launcher copies are not archives, so skip failed attempts.
      for (const archive of archives.slice(0, 8)) {
        onStatus(t('正在解压目录内归档：{0} …', archive.name));
        try {
          const result = await extractArchiveFiles(await readBytes(archive), {
            wanted: [...ARCHIVE_WANTED_NAMES],
            directoryRules: GAME_ARCHIVE_DIRECTORY_RULES,
            onStatus,
          });
          for (const [name, entryBytes] of result.files) extracted.set(name, entryBytes);
        } catch (error) {
          console.warn(t('[游戏文件] 目录内归档无法解析，跳过'), archive.name, error);
        }
      }
      onStatus(t('目录读取完成：{0} 个所需文件。', extracted.size));
      return new SessionGameFileProvider(t('本地目录'), extracted);
    })();
  return {
    ...store,
    beginPick() {
      if (pendingSource) progressiveFilesOf(pendingSource)?.cancel();
      pendingSource = null;
      state.games = [];
      state.manifest = null;
      state.error = '';
      setButtonsDisabled(true);
    },
    chooseGame(gameId: SupportedGameId) {
      if (state.busy || !pendingSource || !state.games.includes(gameId)) return;
      const base = pendingSource;
      pendingSource = null;
      state.games = [];
      return use(async () => base, gameId);
    },
    cancelPick() {
      setButtonsDisabled(false);
    },
    importArchive(file: File) {
      return use(() => processArchiveFile(file));
    },
    importFolder(files: File[]) {
      return use(() => processFolderFiles(files));
    },
    development() {
      // RA2/YR share a development resource directory and use the same version discovery as player imports.
      return use(() =>
        developmentSourceProvider(
          new HttpGameFileProvider(),
          developmentGameRoot(typeof window === 'undefined' ? '' : window.location.search),
        ),
      );
    },
    dispose() {
      disposed = true;
      if (pendingSource) progressiveFilesOf(pendingSource)?.cancel();
      pendingSource = null;
    },
  };
}

/**
 * `root` (the page's `?game-root=`, see training/trainingQuery.ts) names a sub-folder of the development server's game
 * directory that holds a session's own game folder, for example a practice scenario's.
 */
export async function developmentSourceProvider(provider: HttpGameFileProvider, root = ''): Promise<GameFileProvider> {
  const folder = supportedGame('ra2').folder;
  return new ScopedGameFileProvider(provider, root ? `${root}/${folder}` : folder);
}

/**
 * Restore a game source from the last imported IndexedDB file set. If required files are complete, skip the picker and start automatically; return null for missing/incomplete caches to show the picker.
 */
export async function restoreCachedGameSource(): Promise<GameSource | null> {
  const preferred = loadPreferredGame();
  const order = [preferred, ...SUPPORTED_GAMES.map((game) => game.id).filter((id) => id !== preferred)];
  for (const gameId of order) {
    if (!gameId) continue;
    const manifest = GAME_MANIFESTS[gameId];
    const cached = await restoreCachedFileProvider(gameId).catch(() => null);
    if (!cached) continue;
    const missing = manifest.playerRequired.filter((file) => cached.hasKnownFile(file.name.toLowerCase()) !== true);
    if (missing.length) continue;
    const executables = await loadThirdPartyFiles(manifest, cached).catch(() => null);
    if (!executables || executables.missing.length) continue;
    const provider = new OverlayGameFileProvider(cached, executables.files, t(' + 主程序'), false, false, false);
    const sources = await validateGameDirectory(provider, gameId).catch(() => []);
    if (sources[0]) return sources[0];
  }
  return null;
}
