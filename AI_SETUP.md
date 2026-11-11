# AI setup runbook: Build 12 HD on a fresh Apple Silicon Mac

This file is written for a coding agent (and for the owner reading along). Follow the
steps in order. Every step ends with a check; do not continue past a failed check. The
repository is private and belongs to the owner; keep it private and never push it, or
anything from it, anywhere else.

A Chinese summary is at the end. [RESTORE.md](RESTORE.md) is the shorter human guide to
the same backup; this runbook supersedes it where they differ.

## 0. Ground rules for the agent

- Never download game files. The owner supplies their own Yuri's Revenge copy (step 9).
  No MIX, EXE, DLL, INI or map from the game is in this repository or its releases.
- Steps that change the system or need the owner's identity are the owner's to perform:
  installing Rosetta, `gh auth login`, any `sudo`, accepting licences in installers.
  Print the exact command and wait for the owner.
- Do not delete anything except the temporary downloads in `~/ra2-hd/dl*` and the files a
  troubleshooting row below names.
- Do not copy a Wine prefix from another Mac and do not install CrossOver; the launcher
  creates its own prefix.
- Report what you actually verified. Path checks and checksums are not a played match;
  the last step is the owner playing.

## 1. What is backed up where

| Release                 | Assets                                                                                                                                                                                                                |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `farm-build12-20261102` | HD farm `hd-cache-play12.part00..31.tar.zst` (32 chunks), `hd-cache-play12.manifest.json`, `restore_farm.py`, `ddraw.dll`, `ra2launch.exe` (first-party native-host builds), `launcher-build12.command`, `SHA256SUMS` |
| `env-build12-20261102`  | `env-build12.part00..05.tar.zst` (6 chunks), `env-build12.manifest.json`, `restore_env.py`, `SHA256SUMS`                                                                                                              |

`env-build12` holds 54 files, 10,036,472,075 bytes before compression:

- `wine/wine-stable-11.0_1-osx64.tar.xz`: the free Wine used by Build 12, the unmodified
  upstream archive (Gcenx macOS_Wine_builds tag `11.0_1`, 185,303,032 bytes, sha256
  `b50dc50ec7f41d58b115a6b685d4d1315ba3c797bd3aa0f49213f2703cb82388`, reports `wine-11.0`),
  plus `wine/SOURCE.txt`.
- `gameres/tools/realesrgan/`: `realesrgan-ncnn-vulkan` (macOS build 20220424), its
  `models/` (realesrgan-x4plus, realesrgan-x4plus-anime, realesr-animevideov3 x2/x3/x4)
  and `README_macos.md`.
- `gameres/tools/diffusion/models/`: `sdxl-base` (fp16 UNet, text encoders, tokenizers,
  scheduler, VAE), `sdxl-vae-fp16-fix`, `controlnet-tile-sdxl`; and
  `gameres/tools/diffusion/download.py` (records what was fetched).
- `LICENSES/`: licence texts and model cards (same as [backup/LICENSES](backup/LICENSES/README.md)).

Files larger than one chunk (the 5.1 GB SDXL UNet, and others at chunk borders) are
split into byte segments; `restore_env.py` reassembles them when chunks are restored in
ascending order and checks every segment and every whole file against the manifest.
A copy of the manifest is committed as [backup/env-build12.manifest.json](backup/env-build12.manifest.json).

The environment release is uploaded after the farm release finishes (queued on the
owner's original machine on 2026-11-02; farm ETA about 24 h, environment about 4 h more at
~0.7 MiB/s). Before step 6 (farm, 32 chunks) and before step 7 (environment, 6 chunks), confirm the
uploads are complete; each restore step downloads `SHA256SUMS` again right before it
restores:

```sh
gh release view farm-build12-20261102 -R xjtuyanshi/ra2-hd-assets --json assets --jq '[.assets[].name|select(test("part[0-9]+"))]|length'   # 32
gh release view env-build12-20261102  -R xjtuyanshi/ra2-hd-assets --json assets --jq '[.assets[].name|select(test("part[0-9]+"))]|length'   # 6
```

Not backed up on purpose: Wine prefixes (owner's registry and game state), CrossOver,
Python virtual environments (recreated in step 8), caches, the owner's game copy, and the
machine-local install receipts listed in RESTORE.md.

## 2. Layout and disk budget

```
~/ra2-hd/                      RA2HD_HOME
  code/                        this repository (BUILD12_CODE)
    gameres/tools/realesrgan/  restored in step 7 (gitignored)
    gameres/tools/diffusion/   models + .venv (gitignored)
  farm/hd-cache-play12/        restored HD farm (BUILD12_FARM), about 59.7 GiB
  game/YURI/                   the owner's own YR copy (RA2HD_GAME)
  wine/Wine Stable.app         free Wine 11.0 (RA2HD_WINE points inside it)
  wine-prefix/                 created by the first launch (BUILD12_PREFIX)
  env/                         restored environment bundle (LICENSES stay here)
  run/                         launcher lock files
  launcher-build12.command
  dl/  dl-env/                 temporary download folders
```

Needed free space: farm 59.7 GiB, models and tools 9.4 GiB, Wine 0.7 GiB, diffusion venv
0.8 GiB, code with `node_modules` about 0.5 GiB, the game copy (about 1.1 GiB on the
Build 12 machine), prefix 0.35 GiB, plus 2 GiB for the one chunk being restored. Require
at least 85 GiB free before starting:

```sh
df -h ~        # check: Avail >= 85Gi
```

Never download all chunks first unless another 70 GiB is free.

## 3. Prerequisites (versions recorded on the Build 12 machine, 2026-11-02)

Reference machine: macOS 27.2 (26B123), Apple M5 Pro, arm64.

| Tool                     | Version used      | Install                                                                      |
| ------------------------ | ----------------- | ---------------------------------------------------------------------------- |
| Xcode Command Line Tools | current           | `xcode-select --install` (owner; installer dialog)                           |
| Rosetta 2                | current           | `softwareupdate --install-rosetta --agree-to-license` (owner; system change) |
| Homebrew                 | 7.0.11            | the official Homebrew installer (owner; needs the admin password)            |
| git                      | Xcode CLT         | included above                                                               |
| GitHub CLI `gh`          | 2.93.0            | `brew install gh`                                                            |
| Node.js                  | 26.0.0 (any 26.x) | `brew install node@26 && brew link --force --overwrite node@26`              |
| pnpm                     | 11.24.0           | `brew install pnpm`; the repo's `packageManager` field selects 11.24.0       |
| zstd                     | 1.5.7             | `brew install zstd`                                                          |
| xz                       | 5.8.4             | `brew install xz` (macOS `tar` also reads .xz)                               |
| Python (Homebrew)        | 3.14.5            | `brew install python@3.14`                                                   |
| uv                       | 0.11.19           | `brew install uv`                                                            |
| Google Chrome            | 156.0.8078.79     | `brew install --cask google-chrome`                                          |
| mingw-w64 (optional)     | 14.0.0_3          | `brew install mingw-w64`, only to rebuild `ddraw.dll`                        |
| Go (optional)            | 1.26.4            | `brew install go`, only to rebuild `ra2launch.exe`                           |

Homebrew installs the current release of each formula; minor differences from the table
are expected. Record the versions you got:

```sh
sw_vers; uname -m                                  # arm64
/usr/bin/arch -x86_64 /usr/bin/true && echo rosetta-ok
brew --version | head -1; gh --version | head -1; node --version; zstd --version; uv --version
/opt/homebrew/bin/python3 --version
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --version
```

Checks: `uname -m` prints `arm64`, `rosetta-ok` is printed, `node --version` starts with
`v26.`. Then the owner signs in to GitHub (browser flow; the agent never handles tokens):

```sh
gh auth login            # owner, account xjtuyanshi
gh auth status           # check: logged in to github.com
```

## 4. Clone and install code dependencies

```sh
mkdir -p ~/ra2-hd && cd ~/ra2-hd
gh repo clone xjtuyanshi/ra2-hd-assets code
cd code
git config core.hooksPath scripts/git-hooks
git log -1 --oneline          # main of the private repo
pnpm --version                # check: 11.24.0
pnpm install --frozen-lockfile
test -x node_modules/.bin/vite && echo deps-ok
```

## 5. Native-host binaries

Use the released first-party builds:

```sh
mkdir -p ~/ra2-hd/dl && cd ~/ra2-hd/dl
gh release download farm-build12-20261102 -R xjtuyanshi/ra2-hd-assets --clobber \
  -p SHA256SUMS -p hd-cache-play12.manifest.json -p restore_farm.py \
  -p launcher-build12.command -p ddraw.dll -p ra2launch.exe
shasum -a 256 -c SHA256SUMS --ignore-missing   # check: 5 files OK, no FAILED
mkdir -p ~/ra2-hd/code/packages/native-host/build
cp ddraw.dll ra2launch.exe ~/ra2-hd/code/packages/native-host/build/
```

This `SHA256SUMS` may be a snapshot taken while the farm upload was still running; it is
downloaded again in step 6. Expected digests: `ddraw.dll` `90ca96e594af9b51618de4b00826f42ade578f603500b89d88a7d3004a238653`,
`ra2launch.exe` `66c709c02d53ea5607b1d655ce92625bea1e831c48aa134c9f9fc6e0164dcb45`.

Only if those assets are unavailable, rebuild (needs mingw-w64 and Go):
`nice -n 10 packages/native-host/build.sh` and `bash packages/native-host/launcher/build.sh`
from `~/ra2-hd/code`. A rebuilt `ra2launch.exe` matched the released digest on the
Build 12 machine; a rebuilt `ddraw.dll` is not guaranteed to be byte-identical, so the
first launch in step 11 is its real check.

## 6. Restore the HD farm (chunk by chunk)

Do not start until the release shows all 32 farm chunks (see step 1; the command prints
`32`), then download `SHA256SUMS` again, because the copy from step 5 may predate the
last chunks:

```sh
gh release view farm-build12-20261102 -R xjtuyanshi/ra2-hd-assets --json assets --jq '[.assets[].name|select(test("part[0-9]+"))]|length'   # must print 32
cd ~/ra2-hd/dl
gh release download farm-build12-20261102 -R xjtuyanshi/ra2-hd-assets --clobber -p SHA256SUMS
FARM=~/ra2-hd/farm/hd-cache-play12
for n in $(seq -w 0 31); do
  f=hd-cache-play12.part$n.tar.zst
  gh release download farm-build12-20261102 -R xjtuyanshi/ra2-hd-assets -p "$f" --clobber || break
  python3 -I restore_farm.py hd-cache-play12.manifest.json . "$FARM" --chunks "$((10#$n))" || break
  rm -f "$f"
done
python3 -I restore_farm.py hd-cache-play12.manifest.json - "$FARM" --finish
```

Check: every chunk run ends with `verified`, and the final line is
`13301 farm paths checked, 0 problems`. The loop stops at the first failure; rerun it
from that chunk (`seq -w N 31`). Each run checks the chunk against `SHA256SUMS` and
every extracted file against the manifest; duplicates become hard links. Downloads run
at the uplink's speed; 60 GiB takes hours.

## 7. Restore Wine, Real-ESRGAN and the models (chunk by chunk)

Do not start until the environment release shows all 6 chunks; `SHA256SUMS` is
downloaded here, right before restoring, so it lists every chunk.

```sh
mkdir -p ~/ra2-hd/dl-env && cd ~/ra2-hd/dl-env
R=env-build12-20261102
gh release view $R -R xjtuyanshi/ra2-hd-assets --json assets --jq '[.assets[].name|select(test("part[0-9]+"))]|length'   # must print 6
gh release download $R -R xjtuyanshi/ra2-hd-assets --clobber \
  -p SHA256SUMS -p env-build12.manifest.json -p restore_env.py
shasum -a 256 -c SHA256SUMS --ignore-missing                       # manifest + script OK
cmp env-build12.manifest.json ~/ra2-hd/code/backup/env-build12.manifest.json && echo manifest-matches-repo
for n in 0 1 2 3 4 5; do
  f=env-build12.part0$n.tar.zst
  gh release download $R -R xjtuyanshi/ra2-hd-assets -p "$f" --clobber || break
  python3 -I restore_env.py env-build12.manifest.json . ~/ra2-hd/env --chunks $n || break
  rm -f "$f"
done
python3 -I restore_env.py env-build12.manifest.json - ~/ra2-hd/env --finish
```

Check: each run prints `ok  env-build12.partNN.tar.zst` and `restored chunk NN`, and the
final line is `54 files checked, 0 problems`. Chunks must be restored in ascending order.
If a chunk is reported as not in `SHA256SUMS`, the upload is unfinished (see step 1).

Install Wine:

```sh
cd ~/ra2-hd/env/wine
shasum -a 256 wine-stable-11.0_1-osx64.tar.xz
# check: b50dc50ec7f41d58b115a6b685d4d1315ba3c797bd3aa0f49213f2703cb82388
mkdir -p ~/ra2-hd/wine
tar -xJf wine-stable-11.0_1-osx64.tar.xz -C ~/ra2-hd/wine
xattr -dr com.apple.quarantine ~/ra2-hd/wine/"Wine Stable.app" 2>/dev/null || true
WINE=~/ra2-hd/wine/"Wine Stable.app"/Contents/Resources/wine/bin/wine
"$WINE" --version                      # check: wine-11.0
file "$WINE"                           # x86_64 (runs through Rosetta)
mkdir -p ~/ra2-hd/code/gameres/wine-free
printf '%s\n' "$WINE" > ~/ra2-hd/code/gameres/wine-free/wine-path   # default for scripts without RA2_NATIVE_WINE
```

Keep `bin/`, `lib/` and `share/` of the app together; do not move single files out of it.
The `.tar.xz` can be deleted after the check (it stays in the release).

Place the tools where the code expects them (`<code>/gameres/tools/...`). Run
`restore_env.py ... --finish` once, before this move: afterwards the `mv` takes the two
folders out of `~/ra2-hd/env`, where the manifest expects them, so a second `--finish`
would report them missing. If it must be re-run, first move the folders back
(`mv ~/ra2-hd/code/gameres/tools/{realesrgan,diffusion} ~/ra2-hd/env/gameres/tools/`).

```sh
mkdir -p ~/ra2-hd/code/gameres/tools
mv ~/ra2-hd/env/gameres/tools/realesrgan ~/ra2-hd/env/gameres/tools/diffusion ~/ra2-hd/code/gameres/tools/
chmod +x ~/ra2-hd/code/gameres/tools/realesrgan/realesrgan-ncnn-vulkan
```

The Real-ESRGAN check follows in step 8c, once Pillow is installed.

## 8. Recreate the Python environments

8a. Diffusion venv (used by `pnpm hd:prepare ... --steps ...,remat`, `rematerialize.py`,
`redetail_terrain.py` and the other diffusion tools; the code calls
`gameres/tools/diffusion/.venv/bin/python`). Pinned list:
[backup/python/diffusion-requirements.txt](backup/python/diffusion-requirements.txt)
(Python 3.12.13, torch 2.14.0, diffusers 0.40.0, transformers 5.17.0, accelerate 1.15.0).

```sh
cd ~/ra2-hd/code
uv python install 3.12.13
uv venv --python 3.12.13 gameres/tools/diffusion/.venv
uv pip install --python gameres/tools/diffusion/.venv/bin/python -r backup/python/diffusion-requirements.txt
gameres/tools/diffusion/.venv/bin/python -I backup/tools/check_models.py gameres/tools/diffusion/models
```

Check: the last line is `models OK (mps=True)` (offline load of the three models the
same way `rematerialize.py` loads them; about 15 s, ~10 GB RAM). `mps=False` means the
GPU backend is unavailable and diffusion would fall back to a very slow CPU path.

8b. System-Python packages for the other asset tools in `packages/ra2-assets/python/`
(NumPy, Pillow, OpenCV), pinned in
[backup/python/system-python-requirements.txt](backup/python/system-python-requirements.txt).
They were installed into Homebrew Python 3.14 on the Build 12 machine:

```sh
PY=/opt/homebrew/bin/python3   # explicit interpreter; the bare `python3` on PATH may differ
$PY -m pip install --break-system-packages -r ~/ra2-hd/code/backup/python/system-python-requirements.txt
$PY -c "import numpy, PIL, cv2; print(numpy.__version__, PIL.__version__, cv2.__version__)"   # check: 2.5.2 12.3.0 5.0.0
```

8c. Real-ESRGAN check (runs on the GPU through Vulkan/MoltenVK, no network):

```sh
cd ~/ra2-hd/code/gameres/tools/realesrgan
PY=/opt/homebrew/bin/python3   # same interpreter as 8b
T=~/ra2-hd/dl-env
$PY -c "import sys; from PIL import Image; Image.new('RGB',(32,32),(90,140,60)).save(sys.argv[1])" $T/esr-in.png
./realesrgan-ncnn-vulkan -i $T/esr-in.png -o $T/esr-out.png -n realesrgan-x4plus -s 4 -m models
$PY -c "import sys; from PIL import Image; print(Image.open(sys.argv[1]).size)" $T/esr-out.png   # check: (128, 128)
```

Neither environment is needed just to play; they are needed to prepare new maps or
redraw art.

## 9. The owner's game copy (never downloaded)

Ask the owner to copy their own Yuri's Revenge installation (the folder with
`gamemd.exe`, `Blowfish.dll` and the game MIX files) to `~/ra2-hd/game/YURI`. Use a copy
reserved for this build: the launcher installs `ddraw.dll` into it while a game runs and
restores the original afterwards.

```sh
ls ~/ra2-hd/game/YURI/gamemd.exe ~/ra2-hd/game/YURI/Blowfish.dll && echo game-ok
echo "7b8a068535d6af06845edf95ae829b113d00c02909330e16f197426cd7db94b6  $HOME/ra2-hd/game/YURI/gamemd.exe" | shasum -a 256 -c -
```

The supported `gamemd.exe` is Yuri's Revenge 1.001 with sha256
`7b8a068535d6af06845edf95ae829b113d00c02909330e16f197426cd7db94b6` (the digest of both
the owner's play copy and the development copy on the original machine). A different
digest is reported to the owner, not treated as fatal: the launcher's own version check
in step 10 decides whether the page supports that build, and the file is never patched or
replaced.

## 10. Launcher path check

```sh
cp ~/ra2-hd/dl/launcher-build12.command ~/ra2-hd/
chmod +x ~/ra2-hd/launcher-build12.command
~/ra2-hd/launcher-build12.command --check
```

The launcher reads `RA2HD_HOME` (default: its own folder) and the overrides
`BUILD12_CODE`, `BUILD12_FARM`, `RA2HD_GAME`, `RA2HD_WINE`, `BUILD12_PREFIX`; the layout in
step 2 needs none of them. Check: the output lists code, game, HD cache, Wine and prefix
paths and ends with `路径检查通过；未启动任何进程，真实游戏验收仍需单独完成。`
Any other last line names the missing piece (code, `node_modules`, game, farm `_library`,
Wine, or the native-host binaries).

## 11. First launch (owner at the screen)

```sh
~/ra2-hd/launcher-build12.command        # or double-click it in Finder
```

- The first launch creates `~/ra2-hd/wine-prefix` (prints `首次启动将创建独立 Wine 环境`),
  maps `G:` to the game copy and registers `Blowfish.dll`. On the Build 12 machine a
  fresh prefix reached the main menu in 61–69 s; preparation has a 240 s limit.
- Google Chrome opens the game page. The owner clicks 「全屏开始」 or 「按当前窗口开始」.
- Quit with Ctrl-C in the launcher window; closing the tab alone does not end the game.
- Each launch has a private run folder `~/ra2-hd/code/packages/native-host/build/play-*/`
  (newest by time; the launcher prints it as 「本次记录文件夹」). It holds
  `launcher-output.log` (Wine, MoltenVK, build and English diagnostics),
  `wine-check.log`/`.json` (Wine self-check), `wine-prefix.log` (first-run prefix
  preparation), `wine.log`, `page.log`, `status.json`, `session-state.json` and
  `play-url.txt` (tokened page address, mode 0600).

## 12. Confirm HD works

Start a skirmish on a map the farm has prepared (map folders sit at the top of
`~/ra2-hd/farm/hd-cache-play12/`; for example XMP29U2). Then:

1. Look: terrain, buildings, units and infantry are visibly sharper than the original
   picture; no magenta or pink blocks, no floating units, docked miners drawn behind the
   refinery correctly. Compare at 1:1, not only at a glance.
2. Press `\` (backslash): the picture switches between HD and the original; press again
   to return. The toolbar button 「高清画面 / 原版画面」 does the same.
3. No notice such as 「高清画面未启用：地图 … 没有高清素材」 or 「高清画面加载失败…」.
   The first means the map is not in the farm (prepare it with `pnpm hd:prepare`); the
   second points to a farm or GPU problem (see the run folder's `page.log`).
4. In Chrome DevTools (Console) on the game page:
   `__hdBridge.presentation.mode` is `'hd'`; `__hdBridge.timeline.revealedAt` and
   `readyAt` are numbers (not `null`) and `revealLoading` is `0` after the reveal;
   `__hdBridge.stalls` lists HD stalls (ideally empty).
5. Play a few minutes: building, fighting, scrolling. A path check, checksums or a menu
   screenshot are not acceptance; the owner playing a real match is.

## 13. Troubleshooting

| Symptom                                                              | Cause and fix                                                                                                                                                                                                                                                                                                                                                                                     |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Bad CPU type in executable` from `wine`                             | Rosetta 2 missing. Owner runs `softwareupdate --install-rosetta --agree-to-license`.                                                                                                                                                                                                                                                                                                              |
| 「Wine 文件夹的启动器标记与目录不符；不会修改」                      | The prefix marker (`.ra2-native-prefix.json`) identifies its folder by inode. Build 12 no longer compares the device number, which macOS renumbers after a reboot (the original failure). The message now means the folder was moved or copied. Do not edit the marker: move the folder aside (`mv ~/ra2-hd/wine-prefix ~/ra2-hd/wine-prefix.old`) and launch again so a fresh prefix is created. |
| 「Wine 文件夹已包含其他文件」                                        | `BUILD12_PREFIX` points at a non-empty folder without the marker. Choose a new empty folder.                                                                                                                                                                                                                                                                                                      |
| Wine self-check fails or hangs (30 s)                                | Read `wine-check.log` in the run folder. Usually Rosetta or a Wine app that was moved apart; reinstall Wine from step 7.                                                                                                                                                                                                                                                                          |
| A Mono or Gecko install dialog                                       | The launcher disables both for prefix creation; if one appears anyway, cancel it. The game needs neither.                                                                                                                                                                                                                                                                                         |
| Chrome does not open, or opens a blank page                          | Google Chrome must be installed in `/Applications`. The address is in `play-url.txt` in the run folder; open it in Chrome. Check `chrome://gpu` shows WebGPU as hardware accelerated. Other browsers are not supported by the launcher.                                                                                                                                                           |
| 「正在等待现有原生游戏或测试结束」, then 「原生通道仍在使用」        | Something listens on loopback ports 15450–15459. `lsof -nP -iTCP:15450-15459 -sTCP:LISTEN` names it; end a leftover launcher with Ctrl-C in its window. Do not kill unrelated processes.                                                                                                                                                                                                          |
| 「机主原生游戏已在另一个窗口运行」 with no launcher running          | A stale `~/ra2-hd/run/session.pid` after a crash or forced quit. Delete `~/ra2-hd/run/session.pid` and, if present, `~/ra2-hd/run/_slots/PAUSE`. These PAUSE/LIVE slot files only kept automated test runners on the original machine away from the owner's game; a single-user machine needs no slot files and nothing must be created there.                                                    |
| The launcher reports the game executable as different or unsupported | The game copy's `gamemd.exe` is not a version the native page supports. Ask the owner for their original YR install; never patch or download an executable.                                                                                                                                                                                                                                       |
| `restore_*.py`: checksum mismatch or BAD file                        | Delete that chunk file, download it again, rerun the same chunk. Repeated failure: stop and report the asset name.                                                                                                                                                                                                                                                                                |
| `restore_env.py`: 「needs the earlier chunks restored first」        | Restore env chunks in ascending order from the first one not yet restored.                                                                                                                                                                                                                                                                                                                        |
| Disk full during restore                                             | Free space, then rerun from the failed chunk. Never download all chunks at once on a small disk.                                                                                                                                                                                                                                                                                                  |
| `pnpm install --frozen-lockfile` fails                               | Check `pnpm --version` is 11.24.0 inside `~/ra2-hd/code` and Node is 26.x. Do not regenerate the lockfile.                                                                                                                                                                                                                                                                                        |
| `models OK (mps=False)`                                              | The venv is not an arm64 Python or macOS lacks MPS. Recreate it with `uv venv --python 3.12.13` on the native arm64 shell (not under Rosetta).                                                                                                                                                                                                                                                    |
| Real-ESRGAN fails with a Vulkan error                                | Run it from a normal user session (not over SSH without a GUI login); the binary needs the GPU.                                                                                                                                                                                                                                                                                                   |

## 14. Licences

All third-party texts are in [backup/LICENSES](backup/LICENSES/README.md) and inside the
environment bundle under `LICENSES/`. Summary (checked 2026-11-02):

| Component                                                  | Licence                                                                                                                                      | Private storage / redistribution                                                            |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Wine 11.0 (Gcenx macOS build, unmodified)                  | LGPL-2.1-or-later; bundled dylibs under their own permissive or LGPL/GPL licences (listed in backup/LICENSES/README.md); MoltenVK Apache-2.0 | Allowed. Licence texts included; source is Wine tag `wine-11.0` plus Gcenx's build scripts. |
| SDXL base 1.0 (`stabilityai/stable-diffusion-xl-base-1.0`) | CreativeML Open RAIL++-M                                                                                                                     | Allowed with the licence copy and the Attachment A use restrictions passed on (included).   |
| SDXL VAE fp16 fix (`madebyollin/sdxl-vae-fp16-fix`)        | MIT                                                                                                                                          | Allowed.                                                                                    |
| ControlNet Tile SDXL (`xinsir/controlnet-tile-sdxl-1.0`)   | Apache-2.0                                                                                                                                   | Allowed with the licence text (included).                                                   |
| Real-ESRGAN models                                         | BSD-3-Clause                                                                                                                                 | Allowed with the notice (included).                                                         |
| realesrgan-ncnn-vulkan program / ncnn                      | MIT / BSD-3-Clause                                                                                                                           | Allowed with the notices (included).                                                        |
| Python packages                                            | various                                                                                                                                      | Not redistributed; reinstalled from the package index.                                      |
| CrossOver                                                  | proprietary                                                                                                                                  | Not stored.                                                                                 |
| Game files                                                 | EA copyright                                                                                                                                 | Not stored; supplied by the owner.                                                          |

## 15. Maintenance (original machine)

The tools that made the backup are in [backup/tools](backup/tools): `build_manifest.py`,
`pack_upload.py`, `run-upload.sh` (farm); `build_env_manifest.py`, `pack_env_upload.py`,
`run-env-upload.sh` (environment; waits for the farm upload, packs one chunk at a time,
verifies each asset's sha256 digest through the GitHub API and deletes the local chunk);
`restore_farm.py`, `restore_env.py`, `check_models.py`. On the original machine they run
from `gameres/s2x/backup/` (logs in `work/upload.log` and `env/work/upload.log`).

## 中文摘要

本文件是给 AI 编程助手的新 Mac（Apple Silicon）安装手册，机主可同时阅读。按顺序执行，每一步都有检查，检查不通过就停下。

1. 发布 `farm-build12-20261102` 存高清缓存（32 块）、原生组件 `ddraw.dll`/`ra2launch.exe` 和启动器；发布 `env-build12-20261102` 存免费 Wine 11.0（原样的上游压缩包）、Real-ESRGAN 程序与模型、SDXL 扩散模型及许可证（6 块）。环境附件在高清缓存上传完成后才开始上传；第 6、7 步各自在恢复前确认块数分别为 32 和 6，并重新下载 `SHA256SUMS`。
2. 需要至少 85 GiB 可用空间；逐块下载、恢复、删除，不要一次下载全部。
3. 用 Homebrew 安装 gh、node@26、pnpm（仓库固定 11.24.0）、zstd、xz、python@3.14、uv、Google Chrome；Rosetta、`gh auth login`、sudo 等由机主本人执行。
4. 克隆本仓库到 `~/ra2-hd/code`，`pnpm install --frozen-lockfile`。
5. 下载并核对 `ddraw.dll`、`ra2launch.exe`，放入 `packages/native-host/build/`。
6. 用 `restore_farm.py` 逐块恢复高清缓存，最后应显示 `13301 farm paths checked, 0 problems`。
7. 用 `restore_env.py` 按顺序逐块恢复环境包，最后应显示 `54 files checked, 0 problems`；解压 Wine 到 `~/ra2-hd/wine`（`wine --version` 为 `wine-11.0`），`--finish` 只在移动之前运行一次；把 `realesrgan`、`diffusion` 移到 `code/gameres/tools/` 后如需重跑，要先把两个文件夹移回 `~/ra2-hd/env/gameres/tools/`。
8. 用 uv 按 `backup/python/diffusion-requirements.txt` 重建扩散虚拟环境（Python 3.12.13），`check_models.py` 应输出 `models OK (mps=True)`；系统 python3 按 `system-python-requirements.txt` 安装 NumPy、Pillow、OpenCV。仅玩游戏不需要这两个环境。解释器使用显式路径 `/opt/homebrew/bin/python3`。
9. 游戏副本必须由机主从自己的安装复制到 `~/ra2-hd/game/YURI`，绝不下载；受支持的 `gamemd.exe`（YR 1.001）sha256 为 `7b8a0685…db94b6`，不一致只报告、不视为致命。
10. `launcher-build12.command --check` 最后一行应为「路径检查通过……」。
11. 首次启动会创建独立 Wine 环境（约 1 分钟），在 Chrome 中点「全屏开始」；记录在 `packages/native-host/build/play-*/`。
12. 确认高清：画面明显更清晰、无洋红/粉色块；按 `\` 能在高清与原版之间切换；没有「高清画面未启用/加载失败」提示；控制台 `__hdBridge.presentation.mode` 为 `'hd'`。最终以机主真实对局为准。
13. 常见问题：缺 Rosetta；Wine 环境标记与目录不符（换一个新的空文件夹，不要改标记）；Chrome 未打开（看 `play-url.txt`）；15450–15459 端口被占用；残留 `run/session.pid`、`run/_slots/PAUSE` 可删除，单用户机器不需要任何 PAUSE/LIVE 槽文件；磁盘不足。
14. 许可证：Wine 为 LGPL-2.1+，SDXL 为 CreativeML Open RAIL++-M（须随附许可证与使用限制），VAE 修复版为 MIT，ControlNet Tile 为 Apache-2.0，Real-ESRGAN 为 BSD-3/MIT；均允许私人保存与再分发，许可证全文在 `backup/LICENSES/`。本仓库保持私有。
