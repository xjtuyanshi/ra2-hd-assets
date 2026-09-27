/**
 * Resolve the version-pinned executables (game.exe / gamemd.exe) for a game session.
 *
 * Remaster fork policy: executables are never fetched from third-party hosts. They come from the player's own
 * imported installation; development may additionally serve a local copy from .tmp-third-party/ through the
 * /__third-party endpoint (src/server/thirdPartyCache.ts), filled by `pnpm run prepare:third-party -- --from <dir>`.
 * A build whose SHA-256 differs from the manifest is still used and reported: version-sensitive patches validate
 * their own signatures and stand down on mismatch, so rejecting here would only hide which build the player owns.
 */
import { sha256Hex } from '../utils/sha256';
import type { GameFileProvider } from '../resources/contracts';
import type { GameManifest, ThirdPartyFile } from '../games/manifest';

export interface ExecutableCheck {
  name: string;
  /** SHA-256 of the bytes actually used. */
  sha256: string;
  /** Whether the bytes match the build the manifest was verified against. */
  pinned: boolean;
  source: 'player' | 'development-cache';
}

export interface ResolvedExecutables {
  files: Map<string, Uint8Array>;
  checks: ExecutableCheck[];
  /** Executables found neither in the player's files nor in the development cache. */
  missing: string[];
}

async function readDevelopmentCache(file: ThirdPartyFile): Promise<Uint8Array | null> {
  // The production build removes this branch, so online sessions never request development endpoints.
  if (!import.meta.env.DEV) return null;
  const response = await fetch(`/__third-party/${encodeURIComponent(file.name)}`, { cache: 'no-store' });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`本地主程序缓存 ${file.name} 读取失败（HTTP ${response.status}）`);
  if (response.headers.get('Content-Type')?.toLowerCase().includes('text/html')) {
    throw new Error(`本地主程序端点 ${file.name} 返回了 HTML 页面，请重启开发服务（pnpm run dev）后刷新页面`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

export async function loadThirdPartyFiles(
  manifest: GameManifest,
  playerFiles: GameFileProvider | null,
  onStatus?: (message: string) => void,
): Promise<ResolvedExecutables> {
  const resolved: ResolvedExecutables = { files: new Map(), checks: [], missing: [] };
  for (const file of manifest.thirdParty) {
    onStatus?.(`正在校验 ${file.name}…`);
    let source: ExecutableCheck['source'] = 'player';
    let bytes = (await playerFiles?.read(file.name)) ?? null;
    if (!bytes?.length) {
      source = 'development-cache';
      bytes = await readDevelopmentCache(file);
    }
    if (!bytes?.length) {
      resolved.missing.push(file.name);
      continue;
    }
    const sha256 = await sha256Hex(bytes);
    const pinned = sha256 === file.sha256;
    if (!pinned) {
      console.warn(`[主程序] ${file.name} 与已验证版本不同（SHA-256 ${sha256}），版本敏感补丁将按签名自行停用`);
    }
    // The VM may modify or transfer the EXE; hand out an independent copy so the player's source stays intact.
    resolved.files.set(file.name, bytes.slice());
    resolved.checks.push({ name: file.name, sha256, pinned, source });
    onStatus?.(`已加载 ${file.name}`);
  }
  return resolved;
}
