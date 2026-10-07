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

- `src/dllmain.c`: include the agent contract; request agent startup after the
  existing hooks initialize and request nonblocking shutdown before teardown.
  The agent does nothing unless explicitly configured.
- `src/ddsurface.c`: include the contract and tap the primary surface where
  upstream publishes Blt, BltFast, Flip, ReleaseDC, and Unlock changes. Pixels
  come from `dds_GetBuffer`, following the existing screenshot implementation.
  RGB555 is identified as an unsupported 15-bit format instead of interpreting
  it as RGB565.
- `src/winapi_hooks.c`: consult virtual client cursor/key state before the stock
  cursor/key paths; avoid OS cursor clipping/warping and foreground selection
  for a connected input client. Expose virtual game foreground focus.
- `inc/hook.h`: increase the internal hook table capacity from 39 to 41,
  preserving the existing entries and terminating sentinel after the two new
  focus hooks. The table is private to the wrapper, with no exported ABI change.
- `src/hook.c`: add game-facing `GetFocus` and `GetActiveWindow` IAT hooks
  that use authenticated virtual focus and retain the physical results when no
  client is active. Saved original pointers participate in stock hook teardown.
- `src/mouse.c`: suppress physical mouse lock/unlock work while virtual input is
  active, so it does not move or capture the real cursor.
- `src/wndproc.c`: dispatch tagged, bounded remote input on the window's game
  thread through its original WndProc, bypassing physical coordinate transforms
  and cursor-lock swallowing; suppress physical focus-loss notifications during
  virtual client focus. No-client input follows the upstream path.
- `README.md`: replaced with this provenance/change inventory; the original was
  renamed to `README.upstream.md` without editing its contents.

All agent implementation lives in `../../agent/`. The rest of the copied
upstream files are unchanged. No game executable, game art, frame, or recording
belongs in this directory.
