# Remaster renderer bridge tools

Development-only tools for the HD renderer bridge (docs/remaster/PLAN.md). They use the player's own YR 1.001 files
and never ship with the game.

## Live state reader

`src/games/yr/stateReader.ts` reads the running battlefield from guest memory without writing it: frame, map (file
name, theater, `[Map] Size`/`LocalSize`), houses (country, displayed name from `HouseClass::UIName`, internal `PlainName`, colour scheme index,
human/local/defeated) and every
building, vehicle, infantry and aircraft outside limbo (type ID, owner, lepton position, body/turret facing, health,
selection). It is a pure function over `GuestMemoryAccessor` (`src/games/shared/memoryAccessor.ts`), so it works on
the main thread and in the VM Worker; `createByteViewAccessor(emulator.read_memory(0, size))` gives the fast path.
Offsets come from the YRpp headers (facts only) and are listed with their sources in the module.

Facing convention: the native 16-bit `DirStruct` (interpolated like `FacingClass::Current()` while turning) is
converted with the engine rounding `((raw >> 7) + 1) >> 1`; 0 = north (world −Y, screen up-right), 64 = east (+X,
screen down-right), increasing clockwise. A world displacement (dx, dy) has facing `atan2(dx, −dy)` in 256ths.

## verifyStateReader.mts

Starts a skirmish through `?start-page=battle` (the scratch installation's `RA2MD.INI` `[Skirmish]` section picks the
map and one Easy AI, e.g. `Slot01=6,-2,-2` and `1,-2,-2` for the closed slots; see ../perf/README.md for the scratch
root), then checks every reader field against the map file, a deployed MCV, ordered moves, a force-fire turret test
and a 30 Hz poll of at least 150 seconds, timing each call. Health is checked on the raw fields (0 ≤ Health ≤
Strength, and the reported ratio equals Health / Strength), because the reader's 0..1 ratio is clamped. The local
house's displayed name is compared with the `[MultiPlayer] Handle` in the `RA2MD.INI` the VM mounted. The only guest input is ordinary mouse/keyboard input.

```bash
RA2_GAME_ROOT=/path/to/scratch-root pnpm exec vite --host 127.0.0.1
BRIDGE_OUT=/path/to/evidence BRIDGE_GAME_DIR=/path/to/scratch-root/ra2 RA2_BROWSER_ORIGIN=https://127.0.0.1:15174 \
  pnpm exec tsx scripts/remaster/bridge/verifyStateReader.mts
```

| Variable                 | Default            | Meaning                                                            |
| ------------------------ | ------------------ | ------------------------------------------------------------------ |
| `BRIDGE_OUT`             | required           | Evidence directory (report.json, state/track dumps, overlay PNGs)  |
| `BRIDGE_GAME_DIR`        | none               | Installation directory used to find the map file (loose or in MIX) |
| `VM_BROWSER_MODE`        | `main`             | `main` (`vm-worker=0`) or `worker`                                 |
| `BRIDGE_POLL_S`          | 150                | Polling window in seconds                                          |
| `BRIDGE_HZ`              | 30                 | Poll rate inside the VM thread                                     |
| `BRIDGE_DISCOVER`        | 0                  | `1` prints the loaded map and exits                                |
| `RA2_BROWSER_EXECUTABLE` | Playwright default | Browser binary                                                     |

## Live shroud reader

`src/games/yr/shroudReader.ts` reads the local player's per-cell shroud (and fog of war, when a scenario enables it)
with the same conventions as the state reader: a pure, never-throwing function over `GuestMemoryAccessor`, guarded by
the pinned-executable hash, with cell (X, Y) = floor(lepton / 256). `readYrShroud(memory, { reuse })` returns the
cell bounds (`originX`, `originY`, `width`, `height`) and, row-major:

- `cells`: 0 shrouded, 1 fogged (only with fog of war), 2 revealed, 0xFF no cell (outside the map diamond);
- `edges`: the SHROUD.SHP frame the engine draws over the cell (0 nothing, 15 black, 1..46 soft edge pieces, 0xFF no
  cell), recomputed exactly like `TacticalClass::GetOcclusion`, so it is current outside the view too;
- `fogEdges`: the FOG.SHP frame per cell when the scenario's fog-of-war flag is set, otherwise null.

Passing the previous result as `reuse` keeps the typed arrays, so a 10–15 Hz poll allocates nothing per cell. The
module documents the addresses, the flag semantics established from the engine code, and how the original draws
shroud edges (SHROUD.SHP intensities written into the alpha buffer that darkens terrain and objects per pixel). The
original draws the shroud as a flat layer at Z = 0: cell (X, Y)'s frame sits at the screen position of the cell centre
with height 0, so terrain at height level L lies under the shroud of cell (X − L/2, Y − L/2).
`isYrLocationShrouded(shroud, x, y, z)` applies the engine's own rule for a lepton location, e.g. an object.

## verifyShroudReader.mts

Starts a skirmish the same way as `verifyStateReader.mts`, then checks the shroud reader against the running game:
the reader bounds against a full scan of the cell pointer table; at game start, every cell whose diamond lies inside
the tactical view (`DSurface::ViewBounds`) in a primary-surface capture taken in the same VM-thread turn as the read
(covered cells must be black, clear cells must show terrain, the soft edge band must match the darkness predicted
from the player's own SHROUD.SHP, and the reader's frames must equal the engine's cached `CellClass::Visibility`);
then it drives a local vehicle into shrouded ground with ordinary mouse input and checks that the cells memory reveals
turn from black to terrain; finally it polls at `SHROUD_HZ` and times every call. The only guest input is ordinary
mouse input.

```bash
RA2_GAME_ROOT=/path/to/scratch-root RA2_DEV_HTTP=1 pnpm exec vite --host 127.0.0.1 --port 15183 --strictPort
SHROUD_OUT=/path/to/evidence SHROUD_GAME_DIR=/path/to/scratch-root/ra2 RA2_BROWSER_ORIGIN=http://127.0.0.1:15183 \
  pnpm exec tsx scripts/remaster/bridge/verifyShroudReader.mts
```

| Variable                 | Default                  | Meaning                                                                  |
| ------------------------ | ------------------------ | ------------------------------------------------------------------------ |
| `SHROUD_OUT`             | required                 | Evidence directory (report.json, captures, raw RGB565 frames, overlays)  |
| `SHROUD_GAME_DIR`        | none                     | Installation directory holding the MIX archives (SHROUD.SHP predictions) |
| `RA2_BROWSER_ORIGIN`     | `http://127.0.0.1:15183` | Development server origin                                                |
| `VM_BROWSER_MODE`        | `main`                   | `main` (`vm-worker=0`) or `worker`                                       |
| `SHROUD_HZ`              | 15                       | Poll rate inside the VM thread                                           |
| `SHROUD_POLL_S`          | 60                       | Timed polling window in seconds                                          |
| `SHROUD_MOVE_S`          | 15                       | How long the vehicle drives into the shroud (one capture per second)     |
| `SHROUD_REANALYSE`       | none                     | An earlier `SHROUD_OUT`: re-run the frame analysis on its saved captures |
| `SHROUD_HEADLESS`        | 1                        | `0` shows the browser                                                    |
| `RA2_BROWSER_EXECUTABLE` | Playwright default       | Browser binary                                                           |

Overlay PNGs outline every in-view cell by what memory says (red covered, yellow edge piece with its frame number,
green clear); magenta fills mark disagreements with the frame, cyan marks the move target and newly revealed cells.
The evidence contains frames of the original game's art, so keep `SHROUD_OUT` outside Git.
