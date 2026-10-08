# Native host bridge

This development-only package embeds a local agent in cnc-ddraw so an existing
page can attach to the player's original 32-bit game running under Wine or
Windows. It preserves the supplied executable and reuses the page's memory
readers and HD renderer. Without agent configuration, native presentation/input
use stock cnc-ddraw behavior.

The vendored source, original license, upstream attribution, exact base commit,
and complete upstream-file edit inventory are in
[third_party/cnc-ddraw/README.md](third_party/cnc-ddraw/README.md).
The binary protocol and security/lifecycle contract are in
[Native host protocol](../../docs/remaster/NATIVE_HOST.md).

## Build

From the repository root:

```sh
nice -n 10 packages/native-host/build.sh
```

Requires the already installed `i686-w64-mingw32-gcc` and
`i686-w64-mingw32-windres`. There are no downloads or dependency installations.
`NATIVE_HOST_CC` and `NATIVE_HOST_WINDRES` can select equivalent local toolchains.
Compilation is serial. The pinned upstream version strings and PE link timestamp
are stable; build output is `packages/native-host/build/ddraw.dll` and remains
Git-ignored. The upstream source and Makefile are not modified by building.

Install only into a separately owned development copy of the game. Keep the
previous stock DLL for comparison/rollback. Enable the native `ddraw` override
in that copy's Wine bottle; the original game directory is never changed.

For a scoped macOS game/page launch, use
`scripts/remaster/native/play-native.sh`; its required environment, private
backup/restore behavior and local Go helper are documented in
[launcher/README.md](launcher/README.md).

## Agent behavior

- A single authenticated binary WebSocket serves memory, mirror, RGB565 native
  pictures, input, and diagnostics over loopback. Configuration is explicit;
  absent configuration leaves the agent dormant.
- Mirror sampling runs at the verified game logic hook. WebSocket I/O runs on a
  separate thread. Stream handoff has bounded mailboxes and applies backpressure
  without blocking the game.
- One picture credit grants one delta picture. The delta baseline advances only
  after that exact packet is sent. Clients request their next credit after
  receiving/decoding the previous picture; early outstanding credits are errors.
  Resolution changes and reconnections produce a complete picture. Changed rows
  use RGB565 literals and compressed `0xF81F` runs.
- Input passes through game-facing WinAPI cursor/key hooks and bounded tagged
  messages on the game window thread. Battle input reaches its original WndProc;
  logically visible owned dialogs route picture-coordinate mouse messages to
  their deepest enabled child or owned Combo popup, with virtual control capture/focus and keyboard
  dialog navigation. Virtual focus does not select an OS window. `INPUT_STATE`
  exposes accepted/delivered/API-consumption counters and bounded control IDs,
  text, geometry, bounded Combo selection/list diagnostics and routing counters. DirectInput is explicitly unsupported.
  Native dialog/battle interactions and browser overlays require live acceptance.

Run the lead's Stage A/B smoke tools described in the protocol guide. Game-derived
PNGs, mirror dumps, and recordings must remain outside Git under the configured
output directory. A successful compile is not evidence that live gates passed.

`node scripts/remaster/native/menu-smoke.mjs --step all` starts at the main menu
and uses only protocol input to exercise main options, enter a prepared
six-player match, open in-game options, cancel quit and resume. Step mode allows
independent window observations between transitions; `--step deploy-mcv` selects
and deploys an owned MCV through normal keys and verifies its construction yard.

## Hidden host configuration

A valid enabled agent defaults to hidden mode, independently of client connection
or disconnection. Set `RA2_NATIVE_AGENT_HIDDEN=1` in the game's process environment
for an explicit hidden start. Set `RA2_NATIVE_AGENT_HIDDEN=0` for visible debugging;
the environment overrides `ddraw.ini` `[agent] hidden=0` or `hidden=1`.

Hidden mode keeps top-level native windows physically hidden and provides logical
visibility, focus, cursor/key state, and mouse capture to the game. Controls retain
their geometry and requested visibility for protocol input. The primary RGB565
surface remains available to picture credits. Static menu captures use bounded
genuine native control painting: original game/control `WM_PAINT` handlers
render into a private DIB copied from the actual current primary. Scoped
`GetDC`/`BeginPaint` imports and paired release/end calls target that scratch HDC
only during synchronous hidden control painting.
Logical show notifications and game-facing style visibility stay intact; ordinary
battlefield pictures receive no additional control redraw. Complete text and
open Combo popup coverage require saved native-picture evidence.
Hidden sessions temporarily use windowed GDI presentation with the hidden primary
client at screen origin `(0,0)`,
avoid changing the host display mode, and disable
cnc-ddraw window-settings persistence so hidden geometry is not saved into the
player's normal configuration. Matching physical and picture origins also keeps
custom native controls within the picture when they combine game-facing geometry
hooks with User32's internal control layout. The original game clock and logic
remain intact.

Under Wine, `[agent] desktop` or `RA2_NATIVE_AGENT_DESKTOP` names the isolated
virtual desktop to hide as well. The development runner's default is `ra2dev`.
The agent acts only when the current Wine desktop has that exact name and the
desktop window has the expected system class; Windows desktops and other Wine
desktops are untouched. The runner must also avoid showing its explorer desktop
before the DLL loads if startup must have no visible host-window interval.
