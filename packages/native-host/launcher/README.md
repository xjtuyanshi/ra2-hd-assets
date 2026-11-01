# Native game launcher

This source is a cleaned copy of the project's private Wine feasibility
`ra2launch` helper. It implements the player's original YR launcher handshake:
the original named mutex/event, inherited verification mapping and `0xBEEF`
thread message. It does not patch the executable, game clock or match state.

Changes from the feasibility source are argument quoting, checked errors and
handle cleanup, caller-selected private logs/status/stop paths, refusal when
another launcher owns the session, and process ownership. A Win32 job with
`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` contains only the game it creates; a private
stop file terminates that exact process. No executable-name or bottle-wide
shutdown is used. The game starts suspended until it belongs to the job, so a
failed ownership setup cannot leave it running.

## Build and play on macOS

From the repository root, with the installed Go toolchain:

```sh
bash packages/native-host/launcher/build.sh
```

This builds a 32-bit Windows GUI helper to the ignored
`packages/native-host/build/ra2launch.exe`. The build is offline, uses the local
toolchain and disables module fetching. `NATIVE_HOST_GO` selects another locally
installed Go executable. The source requires no external Go modules.

Use a separately owned game copy and a dedicated Wine prefix:

```sh
RA2_NATIVE_GAME_DIR="$GAME_COPY" \
RA2_NATIVE_WINE_PREFIX="$WINE_PREFIX" \
RA2_NATIVE_WINE="$WINE_EXECUTABLE" \
RA2_HD_CACHE_DIR="$HD_CACHE" \
scripts/remaster/native/play-native.sh --open
```

For CrossOver, replace `RA2_NATIVE_WINE_PREFIX` with
`RA2_NATIVE_WINE_BOTTLE="$BOTTLE_NAME"`; `CX_BOTTLE_PATH` supports a custom bottle
root. The launcher prefers that bottle only after a successful command probe
bounded to 10 seconds. Missing, refused, expired or unresponsive CrossOver falls
back to the installed free Wine named by `gameres/wine-free/wine-path`, using a
separate launcher-owned `gameres/wine-free/prefix-native` environment. Worktrees
use those resources from the containing repository. With no explicit Wine
executable or scope, that local free installation is the default. One Chinese
line names the selected runtime. Without an explicit executable, a named bottle
first checks macOS's installed CrossOver application metadata and then `PATH`;
plain prefixes retain `PATH` priority. `RA2_NATIVE_WINE` avoids discovery. Explicit plain-Wine executable/prefix choices remain authoritative and
do not silently switch runtimes. `WINEPREFIX` is accepted when neither explicit
scope variable is supplied and requires an existing prefix. The launcher obtains
no Wine or game resources.

An explicit `RA2_NATIVE_WINE_PREFIX` may point to a missing or empty folder.
The launcher claims that folder with a private marker tied to its directory
identity, initializes it, maps `G:` to the chosen game copy, registers the copy's
`Blowfish.dll` with the 32-bit `syswow64\regsvr32.exe`, and verifies its stored
32-bit COM path is `G:\Blowfish.dll`. Initialization is bounded to 240 seconds,
registration to 90 seconds, and mapping/query commands to 40 seconds;
Chinese failure guidance refers to private `wine-prefix.log`. Later launches may
repeat this preparation only for a matching owned directory. Interrupted prefix
initialization is retried until the registry and 32-bit tools are present and
readable, even when the first attempt left `system.reg`. Existing prefixes
without that marker are used unchanged, without automatic repair. Prefix
symlinks and new prefixes inside CrossOver bottle roots are refused. The named
CrossOver bottle path never enters this preparation. DirectDraw's native override
remains scoped to the launched game process.
Preparation also rejects CrossOver executables by their resolved installation
path or wrapper code identity, including aliases and copied wrappers. CrossOver's
wrapper chooses a bottle independently of `WINEPREFIX`; use a free Wine executable
for a new dedicated prefix. Cancelling preparation immediately enters the existing
owned-process shutdown instead of waiting for its startup timeout.

For a launcher-owned prefix, only the `wineboot.exe --init` process receives
`mscoree,mshtml=` appended to `WINEDLLOVERRIDES`. Wine 11.0's prefix
initialization can otherwise offer Mono or Gecko installation when optional local
components are absent. The game needs neither component. This suppresses those
installation paths without changing the caller's environment, existing registry
settings, later preparation commands, CrossOver probes, or the game process.
Relevant upstream source: Wine tag `wine-11.0`, `loader/wine.inf.in`,
`dlls/mscoree/mscoree_main.c`, `dlls/mshtml/main.c`, and
`dlls/appwiz.cpl/addons.c`. This is not a system-wide network restriction.

A friend's Mac needs the player's own complete YR copy and HD cache, Node and
the repository's configured pnpm with local project dependencies, Google Chrome,
and a compatible free Wine installation. Supply the native `ddraw.dll` and
`ra2launch.exe` build outputs; otherwise the local native toolchains are also
required. Preserve the Wine runtime's `bin/wine`, `bin/wineserver`, `lib/`
and `share/` together, including their internal links, then update
`gameres/wine-free/wine-path` for its new location. The current macOS Wine
executables are x86_64, so an Apple Silicon Mac also needs Rosetta already
installed. Prefixes should be created locally by this launcher rather than
copied from another Mac. This checklist does not establish a minimal runtime
package or acceptance on a second Mac.

The selected HD cache must already contain a readable `_library/` directory;
without `RA2_HD_CACHE_DIR`, the cache root remains Vite's existing
`gameres/hd-cache` default. Missing game files, Wine configuration and HD cache
produce Chinese guidance before any game-file modification. After any dedicated
prefix preparation and before building or mapping launcher paths, it runs a
scoped Wine command-line self-check and
requires its expected reply within 30 seconds. A successful CrossOver selection
probe already satisfies that self-check. A probe timeout kills only the owned
probe process group before fallback; its output and observation remain in
`wine-crossover-check.log` and `.json`, separate from the free runtime's check. A failed or hung check leaves
the game unstarted and records bounded output in private `wine-check.log`.
The exact successful reply is recognized incrementally, so later diagnostic
output cannot erase an already observed acknowledgement from the bounded log.
The private `wine-check.json` records that observation, command completion,
exit code and failures separately; it never inserts an acknowledgement into
Wine's stdout. Evidence readers use this observation and use the log only for
historical launches with no observation JSON.
Wine path mapping has the same bounded wait. These startup timeouts do not
establish runtime performance or browser acceptance.

`--open` opens **Google Chrome** explicitly. The printed URL goes straight to
the supplied YR development resources and attaches to the owned native game;
no resource-picker or game-version clicks are needed. Both this launcher and
`scripts/remaster/play.sh` obtain the HD picture options from
`scripts/remaster/play-options.mjs`, including the cinematic look, enhanced
effects/water, remaster vehicles, HD vehicle projection and HD UI.

Add `--hd-marks` to opt into experimental sharp mobile health bars and control-group
numbers for this launch only. The default is off; the option sets the existing
`native-draw-journal=1` page flag without saving a preference. The start screen and
tool panel explain this in Chinese. To turn it off, press Ctrl-C in the launcher
and launch again without `--hd-marks`. The original/HD picture switch and cleanup
ownership are unchanged. The new launch without the option requests no draw capture
or installation; live diagnostics and picture checks establish actual acceptance.

`--size WxH` selects the native match resolution, for example
`--size 1280x720`. Without it, the launcher serves the page before starting the
original game. The page reports its actual available play area and device pixel
ratio and remembered view through an authenticated loopback endpoint. The page
offers **视野：经典 / 适中 / 宽**: `classic` / `moderate` / `wide` use 3 / 2.5 / 2
device pixels per game pixel, with Wide initially selected. Each game's old unversioned
remembered Classic choice migrates to Wide once. Explicitly selecting Classic again
records the new preference version and keeps that choice on later starts; Moderate,
fixed sizes and the INI choice remain unchanged. `--view classic|moderate|wide`
selects that framing explicitly on both launch routes; `resolution=display` remains
a legacy Wide alias. Fullscreen measurement retains fractional CSS dimensions;
both launch routes round those to integral device pixels before calculating the
even-sized game frame. A small window uses a
smaller fitting scale when necessary to keep the minimum usable 800×600 frame.
Sizes must fit the shared 800×600 through 2560×1600 session range and the native
picture protocol's 3,145,728-pixel allocation limit. This admits a 2056×1290 Wide
frame and its 4112×2580 device-pixel view at 75% browser zoom (DPR 1.5); the HD
backing budget is 12,000,000 pixels. Explicit `--size` retains the existing proportional
capping behavior and bypasses page measurement. The launcher prints the applied
size and writes only `ScreenWidth`, `ScreenHeight` and `AllowHiResModes` in the
supplied copy's `RA2MD.INI` **before** starting the game. It preserves unrelated
settings, ANSI bytes, comments and line endings, refuses symlinks, Unicode BOMs
and ambiguous INI case variants, and keeps
an exclusive original backup in the private launch directory when changing an
existing file. The selected resolution remains in that supplied copy after
exit. A process without an interactive browser must provide `--size` explicitly.

Before automatic sizing starts the original game, the page asks the player in
Chinese to choose their window size and press Start. That click measures the
actual play area. `--fullscreen` uses the same gesture to enter fullscreen
before measuring; the page checks the actual fullscreen element instead of
relying on a Chrome launch flag. Normal `--open` requests a maximized window.

Resizing Chrome immediately fits the existing picture into the page. During a
match its logical video mode is preserved; once the page confirms a menu it
can request an automatic restart at the new size. The launcher stops only its
owned helper/game, waits for its agent port to close, and starts a new helper
under the same token and page server. It retains the installed DLL until final
shutdown. Each resize keeps its preceding INI backup and a fresh helper log in
`resize-N/` within the original private run directory; the Wine log is appended.
An explicit `--size` remains fixed. The native main menu retains its original
menu dimensions until a match begins.
The native URL records the selected view and uses `native-viewport=1`; the
page waits for the usable original main menu before attaching. Explicit sizes
remain recorded in the URL. On a 1728×914-point play area at DPR 2 the calculated
Classic / Moderate / Wide frames are 1152×608 / 1382×730 / 1728×914; 1728×1117
fullscreen gives Classic 1152×744. Classic is closest to original 1024×768
framing on that display. Wider frames show more map and sidebar rows; HD canvases
still render at device resolution. These examples are sizing rules, not acceptance evidence.

This worktree automatically uses the staged 2x page-cursor atlas when present,
keeping the selected HD cache unchanged. `RA2_HD_CURSOR_DIR` selects a different
cursor-art directory; `RA2_HD_CURSOR_DIR=0` uses the selected cache's cursor files.
Cursor dimensions and hotspot follow the chosen view scale. The original menu
arrow and 13 remaining atlas frames still require a 2x redraw.

The entry point builds the DLL/helper only when missing, builds the existing
relay library, and selects two currently free loopback ports in 15450–15459.
It creates a fresh 256-bit token and configures hidden agent operation through
the game's environment. The resolution keys above are the only game-setting
changes; existing `ddraw.ini` and Wine registry settings are not rewritten. The
native DLL override is scoped to that process.

Before installing `ddraw.dll`, the launcher makes an exclusive byte-verified
backup of any existing regular file. Symlink DLLs are refused. Private logs,
the original DLL and the installed snapshot stay under the ignored
`packages/native-host/build/play-*` directory, which has owner-only access.
On exit, it restores the original DLL or removes a DLL it created, provided the
installed file's identity and contents are unchanged. A player replacement or
edit is preserved, with the backup retained.

Vite binds only `127.0.0.1`, uses the existing `RA2_DEV_HTTP=1` local-development
mode and sets `RA2_GAME_ROOT` to a private `game/` directory containing a `ra2`
symlink to the supplied game folder. This preserves the existing development
provider's unified `ra2/` scope for both RA2 and YR without rearranging the
player's files. `/game/.list?dir=ra2` and `/game/ra2/gamemd.exe` serve that owned
copy.
`RA2_HD_CACHE_DIR` is passed unchanged. Localhost remains a secure browser
context; the native agent uses its required authenticated loopback WebSocket.
The launcher verifies the authenticated hello PID against its owned process,
checks the complete executable size/SHA-256 against the supplied game copy,
requires that identity to be supported by the native page policy, and waits for
the actual modal main menu with a visible enabled Single Player control inside
the native picture before printing the exact private play URL. A missing,
different or unsupported identity is reported in Chinese; process or visibility
identity mismatches likewise explain why startup was refused. No usable page URL is
claimed when NativeCore would reject the executable. The agent reads executable
identity through the wide Windows path APIs so spaces and non-ASCII game paths
retain their exact identity. It closes
this readiness connection before browser use; the agent admits one client.
Without `--open`, copy the printed URL into Chrome. Keep the terminal open.
Ctrl-C, SIGHUP, an owned game exit or a page
exit stops the processes created by that launch and restores its DLL.
For a normal game exit or an explicit launcher stop, the page releases its
runtime and shows a Chinese notice to run the launcher again for a fresh URL.
It leaves the game frame's immersive fullscreen before showing that page panel;
the fullscreen top layer would otherwise hide its sibling even with a visible DOM box.
The authenticated development-only session endpoint returns only this launch's
coarse state. The launcher keeps its page server alive briefly during shutdown
after closing the owned game process groups and their native sockets, so the
Worker can distinguish a confirmed normal exit from transport loss and paint
its notice before the page server stops.
A crashed game, an unavailable status endpoint or an unexplained disconnect
still produces the runtime error panel.
An explicit stop also wakes the launcher's final wait independently of the
private stop-file. If that file cannot be written, it reports the failure and
continues the existing bounded shutdown of its owned process groups, followed
by conditional DLL restoration; it never shuts down a whole Wine bottle.

Build/readiness checks do not prove a rendered browser match. Actual Wine
job-object support, game startup, native menu interaction and Chrome/WebGPU
acceptance require a live owner run.

## Focused checks

```sh
GOPROXY=off GOSUMDB=off GOTOOLCHAIN=local \
  go test packages/native-host/launcher/command.go packages/native-host/launcher/command_test.go
node --test scripts/remaster/native/play-native.test.mjs
```

The Node suite checks backup/restoration, new-file removal, preservation of
later edits, symlink refusal, allowed-port selection, complete supported identity,
genuine modal-menu readiness, size bounds and byte-preserving INI configuration.
Its process lifecycle
check starts the real Vite server plus a synthetic authenticated agent, using
temporary synthetic game/prefix files. It does not run Wine or a real game.
It also checks dedicated-prefix ownership, CrossOver exclusion, mapped 32-bit
Blowfish registration verification, missing cache guidance, startup wait cancellation and a failed
synthetic Wine self-check that cannot proceed to path mapping, DLL replacement
or resolution changes.

An explicitly scoped real launcher smoke can run through the lead's Node runner:

```sh
NATIVE_OUT="$OUT" node scripts/remaster/native/launcher-smoke.mjs
```

It reads only `$OUT/run/owner-launch-smoke.json`, whose string-valued keys are
`RA2_NATIVE_GAME_DIR`, `RA2_NATIVE_WINE`, one of `RA2_NATIVE_WINE_BOTTLE` or
`RA2_NATIVE_WINE_PREFIX`, and optionally `RA2_HD_CACHE_DIR` / `CX_BOTTLE_PATH`.
The lead supplies this private file and runs the smoke only after stopping its
previous game. It starts the real owner launcher without opening a browser,
checks the scoped resource endpoints, authenticates the hidden owned process,
matches its complete verified executable identity against the served owned
bytes, observes the original main menu and native picture, then starts the
actual Worker/controller/NativeCore page backend and requires a delivered native
menu picture. It releases both clients sequentially before checking targeted
shutdown, released ports and exact DLL restoration. The token-bearing child URL
and private configuration are not printed. Results and the original menu PNG
stay under `NATIVE_OUT`; successful native launcher checks still do not establish
Chrome/WebGPU acceptance.
