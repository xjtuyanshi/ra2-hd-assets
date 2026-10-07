# Native host bridge

This development-only package embeds a local agent in cnc-ddraw so an existing
page can attach to the player's original 32-bit game running under Wine or
Windows. It preserves the supplied executable and reuses the page's memory
readers and HD renderer. Without agent configuration and a client, native
presentation/input use stock cnc-ddraw behavior.

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
- Input passes through game-facing WinAPI cursor/key hooks and tagged messages
  dispatched to the game's original WndProc on its window thread. Virtual focus
  notifications do not select an OS window. `INPUT_STATE` exposes separate
  accepted-input, delivered-message, and cursor/key API consumption counters.
  DirectInput formats are explicitly unsupported. Owned modal-dialog and child-control
  input routing remains unimplemented; battle hotkeys require live acceptance.

Run the lead's Stage A/B smoke tools described in the protocol guide. Game-derived
PNGs, mirror dumps, and recordings must remain outside Git under the configured
output directory. A successful compile is not evidence that live gates passed.
