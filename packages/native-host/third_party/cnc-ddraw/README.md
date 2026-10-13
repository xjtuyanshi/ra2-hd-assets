# cnc-ddraw source and native-host integration

Origin: FunkyFr3sh/cnc-ddraw, commit
`279a057ee7e1e4d584b56141c014ab01f3c6ee6d`. The tracked source was copied from the
locally supplied source checkout. No download is part of this package. The MIT
license is preserved in [LICENSE](LICENSE); the bundled Detours source retains its
own attribution and license. The original project README is preserved as
[README.upstream.md](README.upstream.md).

The upstream Git database, GitHub build workflow, generated `inc/git.h`, build
outputs, and any compiled binaries are omitted. Configuration-editor source and
its original icons are retained; the editor is not built or shipped by this
package. The wrapper uses a separate build directory and does not execute the
upstream Makefile.

## Changes to upstream files

Every integration edit in C source is marked `Native-host bridge`.

- `src/dllmain.c`: validate agent configuration and configure the optional hidden
  host before any game window is created; request agent startup after the existing
  hooks initialize and request nonblocking shutdown before teardown. The agent
  does nothing unless explicitly configured.
- `src/ddsurface.c`: include the contract and tap the primary surface where
  upstream publishes Blt, BltFast, Flip, ReleaseDC, and Unlock changes. Pixels
  come from `dds_GetBuffer`, following the existing screenshot implementation.
  RGB555 is identified as an unsupported 15-bit format instead of interpreting
  it as RGB565. A private GUI-thread credit refresh captures the current primary
  even when a static menu does not present again. Nonblocking renderer/surface
  locks protect the copy; a bounded GUI timer retries contention.
- `inc/ddsurface.h`: declare the private GUI-owner current-primary capture helper.
- Hidden menu capture paints native controls into a private primary-baseline DIB:
  real game/control `WM_PAINT` handlers render their own resources. Scoped
  `GetDC`/`BeginPaint` and paired release/end imports target the scratch HDC;
  changed pixels are committed only after fresh surface
  lifetime validation, with no lock or extra COM reference spanning callbacks.
  The bounded pass preserves physical invisibility,
  defers intermediate picture publication and does not repaint ordinary battle
  frames. Hidden game-facing style and show notifications retain logical visibility;
  owned visible GDI blit destinations also reach the native primary.
- `src/winapi_hooks.c`: consult virtual client cursor/key state before the stock
  cursor/key paths; avoid OS cursor clipping/warping and foreground selection
  for a connected input client. Expose virtual game foreground focus. Preserve
  physical hiding around game-owned dialog subclasses and virtual visibility.
- `src/hook.c`, `inc/winapi_hooks.h`, `src/winapi_hooks.c`: add scoped hidden-paint
  `GetDC`, `ReleaseDC`, `EndPaint` and `GetUpdateRect` imports; the existing
  `BeginPaint` hook also participates. The current forced control repaint exposes
  its actual full client as the update region, since physically hidden ancestors
  cannot retain a User32 invalid region. Outside synchronous hidden painting
  these imports use real APIs.
- `inc/hook.h`: increase the internal hook table capacity from 39 to 53,
  preserving the existing entries and terminating sentinel after the additional
  focus, visibility, mouse-capture, and dialog-lifetime hooks. The table is private to the wrapper,
  with no exported ABI change.
- `src/hook.c`: add game-facing `GetFocus` and `GetActiveWindow` IAT hooks
  that use authenticated virtual focus and retain the physical results when no
  client is active. Add hidden-session focus setters, visibility and capture
  hooks. Saved original pointers participate in stock hook teardown.
  Hook installation and teardown classify game-local modules by both drive and
  directory, so mapping a game folder to a drive root does not include system
  DLLs on another drive. Explicit upstream system-module exceptions are retained.
- `src/hook.c`: retain real `BINKW32.DLL` `_BinkOpen@8` / `_BinkClose@4`
  stdcall exports and observe their successful handle lifetimes through agent
  wrappers. The wrappers delegate without tracking when the agent is not
  configured. Existing IAT teardown restores the original imports. No film
  clock, decoder, resource or game input is changed.
- `src/hook.c`: build-time isolation omits agent-added input, Bink, and hidden
  paint/focus import hooks when their component is disabled, and omits all such
  entries when building without agent objects. Default hook tables are unchanged.
- `src/mouse.c`: suppress physical mouse lock/unlock work while virtual input is
  active, so it does not move or capture the real cursor.
- `src/wndproc.c`: dispatch tagged, bounded remote input on the window's game
  thread into the agent router, bypassing physical coordinate transforms and
  cursor-lock swallowing. The router retains the original battlefield WndProc
  and routes owned dialogs/child controls with virtual capture/focus. Suppress
  physical focus-loss notifications during virtual client focus. Unconfigured
  no-client input follows the upstream path. Handle private picture-refresh
  messages on that same GUI owner.
- `src/dd.c`: install the hidden-window guard on the GUI thread, maintain logical
  game activation without physical focus, and route private geometry/show calls
  through the hidden-mode guard. Align the hidden primary client origin with
  native picture origin. Skip physical cursor initialization for hidden
  sessions. The original DirectDraw surface and presentation taps remain active.
- `src/utils.c`: route private window-position updates through the optional
  hidden-mode guard so fullscreen/maximize helpers cannot show or activate them.
- `src/keyboard.c`: hidden sessions do not install the physical keyboard hook.
- `README.md`: replaced with this provenance/change inventory; the original was
  renamed to `README.upstream.md` without editing its contents.

- `src/ddsurface.c`: native draw-journal capture observes destination writes,
  writable DC access and surface rebinding before mutation, including buffer
  aliases. Its plain 16-bit, unscaled `DDBLT_WAIT` copy can be classified by the
  journal only after message handling and clipping, with the actual source,
  destination, rectangles and strides. Every other copy retains the write fence.
  These optional observations retain every original DirectDraw operation.
- `src/IDirectDraw/IDirectDrawSurface.c`: invalidates capture before the last
  reference releases a surface buffer, preventing a recycled address from being
  treated as the earlier draw plane.

Transport and surface access implementation lives in `../../agent/`; executable
addresses, draw signatures and semantic overlay geometry live in the YR game
module `../../../../src/games/yr/nativeDrawJournal.c`. The rest of the copied
upstream files are unchanged. No game executable, game art, frame, or recording
belongs in this directory.
