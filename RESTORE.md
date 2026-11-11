# 第 12 版高清在另一台 Mac 上恢复 / Restoring Build 12 on another Mac

This public repository is the owner's personal backup. `main` is the Build 12 code
(`2c0ff27`) plus this file. The HD farm and the native-host build outputs are assets of
the release `farm-build12-20261102`. The free Wine, Real-ESRGAN and the diffusion model
weights are assets of the release `env-build12-20261102`. Nothing here is an original game
file: no MIX, EXE or DLL from the game, no INI, no maps, no Wine prefix. Source code
and published release attachments are publicly readable.

**For a complete, step-by-step setup with checks (written for an AI coding agent), use
[AI_SETUP.md](AI_SETUP.md).** It also covers Wine, models, Python environments,
confirming HD and troubleshooting.

本仓库是机主的个人备份，现已公开。`main` 是第 12 版代码（`2c0ff27`）加上本文件。高清缓存与本机组件构建结果放在
发布 `farm-build12-20261102` 的附件中；免费 Wine、Real-ESRGAN 与扩散模型权重在发布
`env-build12-20261102` 中。这里没有任何原版游戏文件（无游戏 MIX/EXE/DLL、INI、地图）和 Wine 环境（prefix）。
源码与已发布附件可公开读取。完整的分步安装与检查见 [AI_SETUP.md](AI_SETUP.md)。

## 发布附件 / Release assets

| Asset                                               | 内容 / Content                                                                                                  |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `hd-cache-play12.part00.tar.zst` … `part31.tar.zst` | 高清缓存 `hd-cache-play12`，32 个独立 tar.zst 分块，每块 < 1.9 GiB / the HD farm in 32 independent chunks       |
| `hd-cache-play12.manifest.json`                     | 清单：每个农场路径 → sha256、大小、所在分块、共享相同内容的路径 / farm path → sha256, size, chunk, shared paths |
| `restore_farm.py`                                   | 恢复与校验脚本 / restore + verify script                                                                        |
| `ddraw.dll`, `ra2launch.exe`                        | 本项目自己构建的原生组件（`packages/native-host/build/`） / first-party native-host builds                      |
| `launcher-build12.command`                          | 第 12 版启动器（路径可配置） / Build 12 launcher with configurable paths                                        |
| `SHA256SUMS`                                        | 以上所有附件的校验和 / checksums of all assets above                                                            |

Farm facts (2026-11-02 snapshot): 13,301 farm paths, 6,303 unique contents,
64,087,009,465 unique bytes (about 59.7 GiB; 96.6 GB if every duplicate were a separate
copy). Duplicates are restored as hard links. The farm includes the 4x infantry
install and the XMP32S8 re-detail. 46 symlinks in the source farm already pointed to a
deleted temporary folder (`vehicles-hd-l3/*`); the renderer could not read them either,
so they are listed in the manifest (`broken_symlinks`) and not restored.

农场快照（2026-11-02）：13,301 个路径，6,303 份不同内容，约 59.7 GiB。重复内容恢复为硬链接。已包含
4 倍步兵安装与 XMP32S8 重绘。原农场里有 46 个指向已删除临时文件夹的失效链接（`vehicles-hd-l3/*`），
渲染器本来就读不到，清单里记录但不恢复。

Not backed up (only needed on the original machine): the install receipts and rollback
state, e.g. `gameres/s2x/build12/units3/infantry/install/20261102-043617/`
(`install.json`, `receipts/`, per-theatre rollback folders), the XMP32S8 redraw work
folders under `gameres/s2x/build12/redraw/`, and the `.realise.lock` work files' history.

未备份（只在原机器上需要）：安装回执与回滚状态，例如
`gameres/s2x/build12/units3/infantry/install/20261102-043617/`（`install.json`、`receipts/`、各地形回滚目录），
以及 `gameres/s2x/build12/redraw/` 下 XMP32S8 重绘的工作目录。

## 1. 准备 / Prerequisites

- macOS (Apple Silicon works through Rosetta 2, which the Wine build needs:
  `softwareupdate --install-rosetta` — run it yourself, it changes the system).
- Your own Yuri's Revenge installation (the folder with `gamemd.exe`, `Blowfish.dll`
  and the game MIX files). Copy it to a separate folder used only by this build; the
  launcher never changes the original install.
  你自己的尤里的复仇安装目录（含 `gamemd.exe`、`Blowfish.dll`、游戏 MIX）。复制一份专供本版使用。
- Free Wine: project Gcenx macOS_Wine_builds, tag `11.0_1`, asset
  `wine-stable-11.0_1-osx64.tar.xz`, sha256
  `b50dc50ec7f41d58b115a6b685d4d1315ba3c797bd3aa0f49213f2703cb82388` (reports `wine-11.0`).
  An unmodified copy is in the release `env-build12-20261102` (restore it with
  `restore_env.py`, see [AI_SETUP.md](AI_SETUP.md) step 7); check the sha256 and unpack it
  so that `Wine Stable.app` is in `~/ra2-hd/wine/`.
  免费 Wine：Gcenx macOS_Wine_builds 项目 `11.0_1` 版的 `wine-stable-11.0_1-osx64.tar.xz`，原样副本在发布
  `env-build12-20261102` 中（见 AI_SETUP.md 第 7 步），核对 sha256 后解压到 `~/ra2-hd/wine/`。
- Google Chrome; Node (v26 used here); pnpm 11.24.0 (`brew install pnpm`; pnpm switches to
  the version in `package.json`, Node 26 no longer ships corepack); `zstd`, `python3` and `gh` (e.g. `brew install zstd python gh`);
  Public downloads do not require the original author's account; if GitHub CLI requests
  authentication, use the current computer owner's own account.
- Disk: about 60 GiB for the farm, plus 2 GiB per chunk being restored (streaming) or
  another 60 GiB if you download every chunk first.
  磁盘：农场约 60 GiB；逐块恢复时另需约 2 GiB，先下载全部分块则另需约 60 GiB。

Suggested layout / 建议目录：

```
~/ra2-hd/
  code/                      this repository
  farm/hd-cache-play12/      restored HD farm
  game/YURI/                 your own YR copy
  wine/Wine Stable.app       free Wine 11.0
  wine-prefix/               created on first launch
  launcher-build12.command
```

## 2. 代码 / Code

```sh
mkdir -p ~/ra2-hd && cd ~/ra2-hd
gh repo clone xjtuyanshi/ra2-hd-assets code
cd code
git config core.hooksPath scripts/git-hooks
pnpm install --frozen-lockfile
mkdir -p packages/native-host/build
gh release download farm-build12-20261102 --repo xjtuyanshi/ra2-hd-assets \
  -p ddraw.dll -p ra2launch.exe -D packages/native-host/build
```

## 3. 高清缓存 / HD farm

```sh
mkdir -p ~/ra2-hd/dl && cd ~/ra2-hd/dl
gh release download farm-build12-20261102 --repo xjtuyanshi/ra2-hd-assets \
  -p SHA256SUMS -p hd-cache-play12.manifest.json -p restore_farm.py -p launcher-build12.command
shasum -a 256 -c SHA256SUMS --ignore-missing     # manifest, script, launcher
```

Streaming restore (needs only ~2 GiB extra) / 逐块恢复（只需约 2 GiB 额外空间）：

```sh
FARM=~/ra2-hd/farm/hd-cache-play12
for n in $(seq -w 0 31); do
  f=hd-cache-play12.part$n.tar.zst
  gh release download farm-build12-20261102 --repo xjtuyanshi/ra2-hd-assets -p "$f" --clobber
  python3 restore_farm.py hd-cache-play12.manifest.json . "$FARM" --chunks "$((10#$n))" || break
  rm -f "$f"
done
python3 restore_farm.py hd-cache-play12.manifest.json - "$FARM" --finish
```

Each `--chunks` run checks the chunk against `SHA256SUMS`, extracts it, verifies every
extracted file's sha256 against the manifest and hard-links duplicate paths. The final
`--finish` run recreates the three loop links (`_library/_library/_library`,
`_research/_research`, `_ui/_ui/_ui`) and checks that all 13,301 paths exist with the
recorded sizes. It prints `13301 farm paths checked, 0 problems` when complete.

If disk space allows, download everything first and restore in one run:
`gh release download farm-build12-20261102 --repo xjtuyanshi/ra2-hd-assets -p '*.tar.zst'`
then `python3 restore_farm.py hd-cache-play12.manifest.json . ~/ra2-hd/farm/hd-cache-play12`.
`--dry-run` only verifies the downloaded chunks; `--copy` writes copies instead of hard
links.

## 4. 启动 / Run

```sh
cp ~/ra2-hd/dl/launcher-build12.command ~/ra2-hd/
chmod +x ~/ra2-hd/launcher-build12.command
~/ra2-hd/launcher-build12.command --check     # path check only, starts nothing
~/ra2-hd/launcher-build12.command             # or double-click it in Finder
```

The launcher reads `RA2HD_HOME` (default: its own folder) and allows each location to be
overridden: `BUILD12_CODE`, `BUILD12_FARM`, `RA2HD_GAME`, `RA2HD_WINE` (the `wine`
executable inside `Wine Stable.app/Contents/Resources/wine/bin/`) and `BUILD12_PREFIX`.
The first launch creates the dedicated Wine prefix (keep the window open). Click
「全屏开始」or「按当前窗口开始」in Chrome; press Ctrl-C in the launcher window to quit.
Options are the same as on the original machine: `--hd-marks`, `RA2_PLAY12_VIEW`,
`RA2_PLAY12_SIZE`.

启动器读取 `RA2HD_HOME`（默认为启动器所在文件夹），各位置都可用上面的环境变量覆盖。首次启动会创建独立
Wine 环境，请保留窗口。在 Chrome 中点击「全屏开始」或「按当前窗口开始」，退出时在启动器窗口按 Ctrl-C。

The `--check` output and the backup's own verification do not replace a real launch on
the new machine: play a match there before relying on it.
`--check` 与备份校验不能代替在新机器上真正开一局的验收。
