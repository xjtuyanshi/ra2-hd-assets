import '../helpers/chineseLocale';
import { HttpGameFileProvider } from '../../src/platform/browser/files/http';
import { afterEach, expect, it, vi } from 'vitest';
import { GAME_MANIFESTS } from '../../src/games/manifest';
import { SessionGameFileProvider } from '../../src/platform/browser/files/sessionFiles';
import { ProgressiveGameFileProvider } from '../../src/adapter/progressiveFiles';
import { createGameSourcePicker } from '../../src/ui/pages/game/gameSourcePicker';
import type { SupportedGameId } from '../../src/games/catalog';
import type { GameFileProvider } from '../../src/resources/contracts';
const mocks = vi.hoisted(() => ({ load: vi.fn(), thirdParty: vi.fn(), validate: vi.fn() }));
vi.mock('../../src/adapter/gameArchiveLayers', () => ({ openGameArchive: mocks.load }));
vi.mock('../../src/adapter/thirdPartyFiles', () => ({ loadThirdPartyFiles: mocks.thirdParty }));
vi.mock('../../src/resources/discovery/discoverGameSources', () => ({ validateGameDirectory: mocks.validate }));
vi.mock('../../src/adapter/cachedGameFiles', () => ({
  saveCachedGameFiles: vi.fn(),
  restoreCachedFileProvider: vi.fn(),
}));
vi.mock('../../src/platform/browser/files/directoryAccess', () => ({
  rememberPreferredGame: vi.fn(),
  loadPreferredGame: vi.fn(),
}));
afterEach(() => vi.clearAllMocks());
function prepare(ids: SupportedGameId[]) {
  const files = new Map(
    ids.flatMap((id) =>
      GAME_MANIFESTS[id].playerRequired.map((file) => [file.name.toLowerCase(), new Uint8Array([1])] as const),
    ),
  );
  const provider = new SessionGameFileProvider('test', files);
  mocks.load.mockResolvedValue(provider);
  mocks.thirdParty.mockResolvedValue({ files: new Map(), checks: [], missing: [] });
  mocks.validate.mockImplementation(async (_provider: GameFileProvider, game: SupportedGameId) => [
    { game: { id: game } },
  ]);
  return provider;
}
it.each(['ra2', 'yr'] as const)('单版本资源自动启动 %s，只加载对应主程序', async (game) => {
  prepare([game]);
  const selected = vi.fn(),
    picker = createGameSourcePicker(selected);
  picker.beginPick();
  await picker.importArchive(new Blob() as File);
  expect(picker.getSnapshot().games).toEqual([]);
  expect(selected).toHaveBeenCalledWith({ game: { id: game } });
  expect(mocks.thirdParty).toHaveBeenCalledWith(GAME_MANIFESTS[game], expect.anything(), expect.any(Function));
});
it('双版本先显示选择，选择后才加载 EXE，重复点击不重复启动', async () => {
  prepare(['ra2', 'yr']);
  const selected = vi.fn(),
    picker = createGameSourcePicker(selected);
  await picker.importArchive(new Blob() as File);
  expect(picker.getSnapshot().games).toEqual(['ra2', 'yr']);
  mocks.load.mock.calls[0]![2]('后台提取中');
  expect(picker.getSnapshot().description).toContain('请选择');
  expect(mocks.thirdParty).not.toHaveBeenCalled();
  expect(selected).not.toHaveBeenCalled();
  await picker.chooseGame('yr');
  await picker.chooseGame('ra2');
  expect(selected).toHaveBeenCalledTimes(1);
  expect(selected).toHaveBeenCalledWith({ game: { id: 'yr' } });
});
it('缺件不启动、不预下载 EXE；销毁取消待选的后台解压', async () => {
  prepare([]);
  const selected = vi.fn(),
    picker = createGameSourcePicker(selected);
  await picker.importArchive(new Blob() as File);
  expect(picker.getSnapshot().error).toContain('缺少');
  expect(selected).not.toHaveBeenCalled();
  expect(mocks.thirdParty).not.toHaveBeenCalled();
  const base = prepare(['ra2', 'yr']),
    abort = vi.fn();
  mocks.load.mockResolvedValue(new ProgressiveGameFileProvider('pending', new Set(base.files.keys()), abort));
  await picker.importArchive(new Blob() as File);
  picker.dispose();
  expect(abort).toHaveBeenCalledTimes(1);
  await picker.chooseGame('yr');
  expect(selected).not.toHaveBeenCalled();
});

it('目录文件也先识别资源，大小写不影响单版本自动启动', async () => {
  prepare(['yr']);
  const files = GAME_MANIFESTS.yr.playerRequired.map((entry) => {
    const file = new File([new Uint8Array([1])], entry.name.toUpperCase());
    Object.defineProperty(file, 'webkitRelativePath', { value: 'folder/' + entry.name });
    return file;
  });
  const selected = vi.fn(),
    picker = createGameSourcePicker(selected);
  await picker.importFolder(files);
  expect(selected).toHaveBeenCalledWith({ game: { id: 'yr' } });
  expect(mocks.load).not.toHaveBeenCalled();
});

it.each([['ra2'], ['yr'], ['ra2', 'yr']] as SupportedGameId[][])('统一开发入口按资源清单识别 %j', async (...ids) => {
  const provider = prepare(ids);
  const listing = vi.spyOn(HttpGameFileProvider.prototype, 'list').mockResolvedValue([...provider.files.keys()]);
  try {
    const selected = vi.fn(),
      picker = createGameSourcePicker(selected);
    await picker.development();
    expect(listing).toHaveBeenCalledWith('ra2');
    if (ids.length === 1) expect(selected).toHaveBeenCalledWith({ game: { id: ids[0] } });
    else {
      expect(picker.getSnapshot().games).toEqual(ids);
      expect(mocks.thirdParty).not.toHaveBeenCalled();
      expect(selected).not.toHaveBeenCalled();
    }
  } finally {
    listing.mockRestore();
  }
});

it('玩家文件缺主程序时不启动，并在清单里列出缺少的 EXE', async () => {
  prepare(['yr']);
  mocks.thirdParty.mockResolvedValue({ files: new Map(), checks: [], missing: ['gamemd.exe'] });
  const selected = vi.fn(),
    picker = createGameSourcePicker(selected);
  await picker.importArchive(new Blob() as File);
  expect(selected).not.toHaveBeenCalled();
  expect(picker.getSnapshot().description).toContain('gamemd.exe');
  expect(picker.getSnapshot().manifest?.complete).toBe(false);
});

it('主程序与已验证版本不同时仍启动，并提示兼容补丁会停用', async () => {
  prepare(['yr']);
  mocks.thirdParty.mockResolvedValue({
    files: new Map([['gamemd.exe', new Uint8Array([9])]]),
    checks: [{ name: 'gamemd.exe', sha256: 'f'.repeat(64), pinned: false, source: 'player' }],
    missing: [],
  });
  const selected = vi.fn(),
    picker = createGameSourcePicker(selected);
  await picker.importArchive(new Blob() as File);
  expect(selected).toHaveBeenCalledWith({ game: { id: 'yr' } });
  expect(picker.getSnapshot().description).toContain('与已验证版本不同');
});
