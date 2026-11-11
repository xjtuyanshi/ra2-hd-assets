# AI setup runbook: Build 12 HD on a Windows PC (port, not yet verified)

**For a friend's independent Windows port, start with [START_HERE.md](START_HERE.md).**
It defines the friend's account and local-only work scope, superseding this runbook's
original-author login/push instructions for that use. The "HD cache" below is the
finished HD resource pack to download and restore, not art to generate again.

This file is written for a coding agent on the owner's Windows PC. Read it together with
[AI_SETUP.md](AI_SETUP.md), which is the verified macOS runbook; this file only says what
is the same on Windows, what is different, and what still has to be built.

**Status (2026-11-10): Build 12 has only ever run on macOS under free Wine. Nothing in this
file has been run on Windows.** The game itself is a Windows program, so the port should
be smaller than the Wine work was, but every Windows step below is `UNVERIFIED` until the
owner has played a full match on the PC.

## 0. Ground rules (AI_SETUP.md section 0, plus Windows specifics)

- Never download game files or game executables. The owner copies their own Yuri's
  Revenge folder to the PC. A `gamemd.exe` that differs from the supported digest
  (YR 1.001, sha256 `7b8a068535d6af06845edf95ae829b113d00c02909330e16f197426cd7db94b6`)
  is reported, not patched and not treated as fatal.
- The repository `xjtuyanshi/ra2-hd-assets` is private. Push only there, never anywhere
  else. Commit after each finished step (Chinese commit description, English comments and
  docs, the agent's `Co-Authored-By` trailer) and push to `main` of that repository.
  Never commit game files, executables from the game, screenshots, recordings, model
  weights or caches; run `git config core.hooksPath scripts/git-hooks` first so the
  pre-commit guard is active.
- Installing programs (winget), anything that needs administrator rights, `gh auth login`,
  registering `Blowfish.dll`, Windows Defender, SmartScreen and firewall prompts are the
  owner's to perform. Print the exact command and wait.
- Keep the UI's EA non-endorsement disclaimer. Do not ship C&C music.
- Report what was actually verified. A passing `pnpm run check` is not a played match.

## 1. What carries over unchanged

| Item                                       | Where                                                                                  | Notes                                                                                                                                    |
| ------------------------------------------ | -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Code, page, HD renderer                    | this repository                                                                        | Platform-independent TypeScript, served by Vite.                                                                                         |
| `ddraw.dll`, `ra2launch.exe`               | release `farm-build12-20261102`, or rebuilt from `packages/native-host` with MinGW-w64 | Already 32-bit Windows binaries (the in-process agent is a cnc-ddraw fork). On macOS they run inside Wine; on Windows they run natively. |
| HD farm `hd-cache-play12` (about 59.7 GiB) | release `farm-build12-20261102`, 32 chunks                                             | Plain files. `restore_farm.py` needs Python and `zstd`; restore chunk 0 alone first to confirm it handles Windows paths.                 |
| SDXL / ControlNet weights                  | release `env-build12-20261102`, 6 chunks                                               | Only needed for terrain re-detail, not for playing.                                                                                      |
| Python asset tools                         | `packages/ra2-assets/python/`, `backup/python/*.txt`                                   | Recreate the environments with `uv`; `.venv/bin/python` becomes `.venv\Scripts\python.exe`.                                              |

Not usable on Windows: the Wine archive in the environment release (not needed), and the
macOS `realesrgan-ncnn-vulkan` binary (only needed for terrain re-detail; ask the owner
before fetching the Windows build from the upstream Real-ESRGAN project).

Known gap: some HD farm changes made after 2026-11-02 (for example the round-9e nuke
mushroom edge smoothing) exist only in the original Mac's farm and are not in the release.
Playing works without them.

## 2. Prerequisites (the owner installs)

Git, GitHub CLI, Node.js 26.x, pnpm (the repository's `packageManager` field selects the
version), Python 3.12 or later with `uv`, `zstd`, Google Chrome with hardware-accelerated
WebGPU (`chrome://gpu`), and MinGW-w64 only if the native-host binaries are rebuilt.
Suggested command for the owner:

```powershell
winget install Git.Git GitHub.cli OpenJS.NodeJS Python.Python.3.12 astral-sh.uv Meta.Zstandard Google.Chrome
```

Then `gh auth login` (owner), clone the private repository to a path **without non-ASCII
characters or spaces** (for example `C:\ra2-hd\code`), `pnpm install --frozen-lockfile`,
and `pnpm run check`, which must pass before any porting work.

## 3. The port: what the agent has to build

The launcher `scripts/remaster/native/play-native.mjs` (entry `play-native.sh`) is
Wine-specific: it resolves a Wine executable, creates and owns a prefix, maps the game
folder to `G:`, registers `Blowfish.dll` through Wine's `regsvr32`, sets
`WINEDLLOVERRIDES=ddraw=n,b`, and starts `ra2launch.exe` through Wine. The parts that are
not about Wine stay as they are: installing `ddraw.dll` into the game folder with an exact
backup and byte-for-byte restore, the agent token and port (`127.0.0.1`, 15450–15459), the
Vite page, the Chrome launch, run-folder logs and locks, and cleanup.

Add a `win32` path without changing macOS behaviour:

1. **Process start.** Run `ra2launch.exe` directly with the game folder as working
   directory. No Wine, prefix, `wineboot` or drive mapping. Windows loads `ddraw.dll` from
   the application folder first, so no DLL override is needed.
2. **Blowfish.** A copied game folder may lack the 32-bit COM registration of
   `Blowfish.dll`. Check the 32-bit registry view first; if it is missing, print
   `C:\Windows\SysWOW64\regsvr32.exe "<game folder>\Blowfish.dll"` for the owner to run
   as administrator. Never register silently.
3. **Paths.** Use Windows-safe path joins and quoting, and keep non-ASCII paths away from
   the game (its ANSI APIs lose them, which is why the Mac build maps the folder to `G:`).
   Locate Chrome under `Program Files`.
4. **Hidden mode.** `RA2_NATIVE_AGENT_HIDDEN=1` hides the real game window. It was
   written against Win32 semantics but only exercised under Wine: check `hiddenHost` in
   the agent diagnostics and confirm no game window appears or steals focus.
5. **Owner entry.** Add a `play-native.cmd` or PowerShell equivalent of `play-native.sh`,
   and a double-click launcher equivalent to `launcher-build12.command`.
6. **Tests.** Keep the platform difference behind injected configuration so unit tests run
   on both systems; do not widen architecture-test allowlists. `pnpm run check` must pass.
7. **Docs.** Update `docs/remaster/NATIVE_HOST.md` and this file with what was verified.

## 4. Acceptance (the owner at the screen)

1. The original main menu appears and responds to the real mouse.
2. A six-player skirmish starts. HD appears within 3 seconds of the match starting, or the
   original picture stays playable until HD is ready; nothing covers a running match.
3. In a busy six-player scene at game speed slider 5, record the logic rate against its
   target (logic frames per second, not page frames).
4. Select, move, drag-select, build and place, arrow-key and edge scrolling, save and load,
   and return to the menu all work.
5. On exit the original `ddraw.dll` (or its absence) is restored byte for byte.
6. A YR campaign mission loads and plays with HD.

Report each item as passed, failed or unverified, with its evidence.

## 5. 中文摘要

- 第 12 版只在 Mac 的免费 Wine 下跑过，Windows 上还没跑过。在机主实际玩完一整局之前，下面每一步都算"未验证"。
- 能直接用的：代码；`ddraw.dll` 和 `ra2launch.exe`（本来就是 Windows 程序）；高清缓存（发布 `farm-build12-20261102`）；SDXL 权重（只有重做地形才需要）。
- 要新做的：启动器的 Windows 分支（不用 Wine，直接运行游戏，`ddraw.dll` 放进游戏文件夹，Blowfish 注册由机主手动执行）、Windows 双击启动器、文档。
- 规矩：
  - 游戏文件只由机主从自己的安装复制，绝不下载。
  - 每完成一步就提交，并推送到私人仓库 `xjtuyanshi/ra2-hd-assets`，不推到别处。
  - 安装软件、管理员权限、登录都由机主操作。
