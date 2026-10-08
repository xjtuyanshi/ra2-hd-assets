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

Use a separately owned game copy and an existing dedicated Wine prefix:

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
is supplied. A game folder, scope and executable are required; the launcher
never creates a Wine prefix or obtains game resources.

The entry point builds the DLL/helper only when missing, builds the existing
relay library, and selects two currently free loopback ports in 15450–15459.
It creates a fresh 256-bit token and configures hidden agent operation through
the game's environment. Existing `ddraw.ini`, game INIs and Wine registry
settings are not rewritten. The native DLL override is scoped to that process.

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
different or unsupported identity is reported explicitly; no usable page URL is
claimed when NativeCore would reject the executable. The agent reads executable
identity through the wide Windows path APIs so spaces and non-ASCII game paths
retain their exact identity. It closes
this readiness connection before browser use; the agent admits one client.
`--open` opens the URL in the default browser; without it, copy the printed URL
into Chrome. Keep the terminal open. Ctrl-C, SIGHUP, an owned game exit or a page
exit stops the processes created by that launch and restores its DLL.

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
later edits, symlink refusal, allowed-port selection, complete supported identity
and genuine modal-menu readiness. Its process lifecycle
check starts the real Vite server plus a synthetic authenticated agent, using
temporary synthetic game/prefix files. It does not run Wine or a real game.

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
