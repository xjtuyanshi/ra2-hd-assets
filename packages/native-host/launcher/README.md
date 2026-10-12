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
`RA2_NATIVE_WINE_BOTTLE="$BOTTLE_NAME"`. The named bottle must already exist;
`CX_BOTTLE_PATH` supports a custom bottle root. Wine discovery uses `PATH` and
macOS's installed CrossOver application metadata. Setting `RA2_NATIVE_WINE`
avoids discovery. `WINEPREFIX` is accepted when neither explicit scope variable
is supplied and requires an existing prefix. A game folder, scope and executable
are required; the launcher obtains no game resources.

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

The selected HD cache must already contain a readable `_library/` directory;
without `RA2_HD_CACHE_DIR`, the cache root remains Vite's existing
`gameres/hd-cache` default. Missing game files, Wine configuration and HD cache
produce Chinese guidance before any game-file modification. After any dedicated
prefix preparation and before building or mapping launcher paths, it runs a
scoped Wine command-line self-check and
requires its expected reply within 30 seconds. A failed or hung check leaves
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

`--size WxH` selects the native match resolution, for example
`--size 1280x720`. Without it, the launcher serves the page before starting the
original game. The page reports its actual available play area and device pixel
ratio and remembered view through an authenticated loopback endpoint. The page
offers **视野：经典 / 适中 / 宽**: `classic` / `moderate` / `wide` use 3 / 2.5 / 2
device pixels per game pixel, with Classic initially selected. `--view classic|moderate|wide`
selects that framing explicitly on both launch routes; `resolution=display` remains
a legacy Wide alias. Frames round down to even dimensions. A small window uses a
smaller fitting scale when necessary to keep the minimum usable 800×600 frame.
Sizes must fit the shared 800×600 through 2560×1600 session range and the native
picture protocol's 2,097,152-pixel limit. Explicit `--size` retains the existing proportional
capping behavior and bypasses page measurement. The launcher prints the applied
size and writes only `ScreenWidth`, `ScreenHeight` and `AllowHiResModes` in the
supplied copy's `RA2MD.INI` **before** starting the game. It preserves unrelated
settings, ANSI bytes, comments and line endings, refuses symlinks, Unicode BOMs
and ambiguous INI case variants, and keeps
an exclusive original backup in the private launch directory when changing an
existing file. The selected resolution remains in that supplied copy after
exit. A process without an interactive browser must provide `--size` explicitly.

`--fullscreen` waits for the player to open the page controls and click the
ordinary fullscreen button before reporting the first resolution. Browser
fullscreen requires that user gesture; the page checks the actual fullscreen
element instead of relying on a Chrome launch flag. Normal `--open` requests a
maximized window, and the measured page area remains authoritative.

The **native resolution is fixed for the session**. The page remembers a changed
view and explains in Chinese that it applies after restarting the launcher.
Resizing Chrome only scales the current picture; stop and relaunch to measure
the new page area, or provide another `--size`. Changing fullscreen or
reloading the page after startup does not change the game's video mode. The
native main menu retains its original menu dimensions until a match begins.
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
