/**
 * Copy the player's own executables (game.exe / gamemd.exe) into the development cache. Never downloads anything.
 * - .tmp-third-party/ (gitignored): local cache served by the Vite development endpoint /__third-party and used by
 *   original-EXE regressions; public unit tests do not depend on it.
 * - game/<folder>/: fill in missing EXEs when the directory exists for e2e/development; never overwrite existing files.
 * Builds that differ from the manifest's verified SHA-256 are copied and reported, not rejected.
 *
 * Usage: pnpm run prepare:third-party -- --from <your RA2/YR installation directory>
 *   (or set RA2_GAME_ROOT). The directory is searched case-insensitively, one level deep.
 */
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256Hex } from '../../src/utils/sha256';
import { SUPPORTED_GAMES } from '../../src/games/catalog';
import { GAME_MANIFESTS } from '../../src/games/manifest';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const CACHE_DIR = join(REPO_ROOT, '.tmp-third-party');
const fromIndex = process.argv.indexOf('--from');
const sourceRoot = fromIndex >= 0 ? process.argv[fromIndex + 1] : process.env.RA2_GAME_ROOT;

async function findCaseInsensitive(root: string, name: string): Promise<string | null> {
  const wanted = name.toLowerCase();
  for (const directory of [
    root,
    ...(await readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(root, entry.name)),
  ]) {
    const match = (await readdir(directory)).find((entry) => entry.toLowerCase() === wanted);
    if (match) return join(directory, match);
  }
  return null;
}

if (!sourceRoot || !existsSync(sourceRoot)) {
  console.error('用法：pnpm run prepare:third-party -- --from <你自己的红警2/尤里安装目录>（或设置 RA2_GAME_ROOT）');
  process.exit(1);
}

let found = 0;
for (const game of SUPPORTED_GAMES) {
  for (const executable of GAME_MANIFESTS[game.id].thirdParty) {
    const source = await findCaseInsensitive(sourceRoot, executable.name);
    if (!source) {
      console.log(`[未找到] ${executable.name}`);
      continue;
    }
    found++;
    const actual = await sha256Hex(new Uint8Array(await readFile(source)));
    const note = actual === executable.sha256 ? '与已验证版本一致' : `与已验证版本不同（${actual}）`;
    await mkdir(CACHE_DIR, { recursive: true });
    await copyFile(source, join(CACHE_DIR, executable.name));
    console.log(`[已缓存] ${executable.name}：${note}`);
    const gameDir = join(REPO_ROOT, 'game', game.folder);
    const target = join(gameDir, executable.name);
    if (existsSync(gameDir) && !existsSync(target)) {
      await copyFile(source, target);
      console.log(`[已就位] ${target}`);
    }
  }
}

if (!found) {
  process.exitCode = 1;
  console.error('没有找到任何主程序。');
} else {
  console.log('主程序就绪。');
}
