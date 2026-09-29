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

## Live effects reader

`src/games/yr/effectsReader.ts` reads the visual effects the engine is playing, for an HD renderer that replaces the
original explosion, fire, smoke and weapon art. Same conventions as the other readers: a pure, never-throwing
function over `GuestMemoryAccessor`, guarded by the pinned-executable hash (`createYrEffectsReader` also checks the
GetCoords vtable slots it reproduces), lepton coordinates, and per-kind `invalid`/`limbo` counts in `stats`.
`readYrEffects(memory, { fireWindow, particles, includeLimbo })` returns:

- `anims` (AnimClass): type ID, absolute world position, the SHP frame drawn now (`frame` = Start + `stage`),
  `frameCount`, loop range, `loopsLeft` (255 = forever), `rate` (logic frames per step), draw layer, flat/translucent
  flags, `buildingAnim` (a building's own active/idle anim), `invisible`, owner house, and `attachedTo` for anims
  that follow an object. The engine stores an attached anim's Location relative to its owner, so the reader resolves
  it through the owner's GetCoords exactly like `AnimClass::GetCoords` (buildings add their foundation centre).
  Key effects on (`id`, `uid`): an anim chains to `Type.Next` inside the same object, so its `type` can change.
- `voxelAnims` (VoxelAnimClass, debris): type, position, velocity, tumbling quaternion, frames left.
- `bullets` (BulletClass): projectile, weapon and warhead IDs, position, launch point, aim point, velocity, firer and
  its house, `inviso` (the original never draws it) and `arcing`.
- `lasers` (LaserDrawClass) and `electricBolts` (EBolt): end points, colours, duration/progress or lifetime, firer.
- `particleSystems` (ParticleSystemClass): type, `behavesLike` (smoke, gas, fire, spark, railgun), origin, target,
  owner object/house, particle count and, with `particles: true`, every particle position.
- `fires`: technos whose `TechnoClass::LastFireBulletFrame` is at most `fireWindow` (default 30) logic frames old,
  with their current target and its position; de-duplicate on (`id`, `frame`) to get one event per shot.

The module lists every global, offset and vtable with the YR 1.001 function that confirms it (constructors, GetCoords
implementations, the anim AI/draw code, `TechnoClass::Fire`).

## verifyEffectsReader.mts

Starts a skirmish the same way as `verifyStateReader.mts` (the scratch `RA2MD.INI` picks the map and one Easy AI),
then checks the effects reader against the running game: the ambient effects before combat (every type pointer must
be a member of the engine's own type array); the local tanks (selected with a right click, a click and `T`)
force-fire (Ctrl+click) at free ground, and the fire events, the anims at the target cell and frames captured in the
same VM-thread turn as the read are compared (pixels around projected anims must change far more than random
control points); then the tanks shoot a civilian building until it burns and collapses. A poll at `EFFECTS_HZ` runs
for the whole window and follows every anim, bullet, particle system and debris voxel by (pointer, UniqueID): frames
must advance, single-iteration anims must disappear within about `End * Rate` logic frames, bullets must leave their
firer and close on their target, attached anims must sit on their owner, and every call is timed. With
`EFFECTS_GAME_DIR` the type-level fields of everything seen are compared with the `artmd.ini` / `rulesmd.ini` keys
the engine loaded from the player's MIX archives. The only guest input is ordinary mouse/keyboard input.

```bash
RA2_GAME_ROOT=/path/to/scratch-root RA2_DEV_HTTP=1 pnpm exec vite --host 127.0.0.1 --port 15185 --strictPort
EFFECTS_OUT=/path/to/evidence EFFECTS_GAME_DIR=/path/to/scratch-root/ra2 RA2_BROWSER_ORIGIN=http://127.0.0.1:15185 \
  pnpm exec tsx scripts/remaster/bridge/verifyEffectsReader.mts
```

| Variable                 | Default                  | Meaning                                                                   |
| ------------------------ | ------------------------ | ------------------------------------------------------------------------- |
| `EFFECTS_OUT`            | required                 | Evidence directory (report.json, tracks.json, captures, raw frames, PNGs) |
| `EFFECTS_GAME_DIR`       | none                     | Installation directory holding the MIX archives (INI cross-check)         |
| `RA2_BROWSER_ORIGIN`     | `http://127.0.0.1:15185` | Development server origin                                                 |
| `VM_BROWSER_MODE`        | `main`                   | `main` (`vm-worker=0`) or `worker`                                        |
| `EFFECTS_HZ`             | 30                       | Poll rate inside the VM thread                                            |
| `EFFECTS_POLL_S`         | 120                      | Polling window in seconds (the combat runs inside it)                     |
| `EFFECTS_DISCOVER`       | 0                        | `1` checks and dumps the ambient effects, then exits                      |
| `EFFECTS_HEADLESS`       | 1                        | `0` shows the browser                                                     |
| `RA2_BROWSER_EXECUTABLE` | Playwright default       | Browser binary                                                            |

Overlay PNGs mark anims (yellow; orange when attached, blue for building anims, grey when invisible) with type and
frame, debris voxels (magenta diamonds), bullets (red squares with a dashed source-to-target line), lasers and bolts
(lines), particle systems (green squares with their particles) and technos that just fired (white rings). The
evidence contains frames of the original game's art, so keep `EFFECTS_OUT` outside Git.

## Native overlay passthrough

`src/games/yr/tacticalPassthrough.ts` (on the generic gate engine `src/games/shared/guestGates.ts`) lets the original
game keep drawing every overlay of the tactical view (selection brackets, health bars, pips, band box, placement grid,
target lines, text, timers, beacons, tooltips) while it skips drawing the world, whose place it fills with the key
colour RGB565 0xF81F. Categories are bit flags written into a guest data page at run time
(`VmShell.setTacticalPassthrough(flags)`: terrain 1, objects 2, effects 4; 0 = original picture). The patches are
installed only when the page opts in (`?hd=1` in development, WebGL2 frame renderer) and verify every original byte
first; the HD bridge switches them on while the HD view is shown and makes key-coloured pixels transparent
(`VmFrameRenderer.setTransparentKey`). The draw pipeline map, every patched address with its original bytes and the
known limits are in `docs/remaster/research/tactical-passthrough.md`.

## verifyPassthrough.mts

Starts a skirmish with `?start-page=battle&hd=1` (the map's HD cache must exist, see `docs/remaster/HD_BRIDGE.md`),
checks the patches installed and the bridge engaged, then captures each scenario with the bridge on and toggled off:
the deployed MCV, the power plant placement grid, a held band box, the selection, move orders and a chat message. Raw
primary surfaces (`*.raw.png`, exact guest pixels) and page screenshots (`*.page.png`, HD world plus native overlays)
go to the evidence directory, and every non-key pixel of an "on" frame is compared with the "off" frame. A quiet frame
with every category on lists what is left in the tactical view (leak check). Logic FPS and guest instructions per
logic frame are measured for off / terrain+objects / all in interleaved windows. With a Soviet player (`RA2MD.INI`
`[MultiPlayer] Side=Russians` together with `SideEx=8`; `SideEx=8` alone gives an Allied player) the script builds a
barracks right after the power plant and queues three Tesla troopers there, so they are ready before the AI's early
rush. Later it force-fires them and requires the EBolt, LineTrail and RadBeam list counts to fall back to 0 while every
category stays on, so effects passthrough removes only pixels and never the engine's own effect ageing; frames taken
while a bolt is alive must stay key colour. A stability window runs with the AI attacking, alternating categories every
minute and toggling the bridge every third minute, sampling the effect-list counts; a lost match continues with a new
one. The only guest input is ordinary mouse/keyboard input plus the development game-speed switch, which
slows the game during the scripted captures.

```bash
RA2_GAME_ROOT=/path/to/scratch-root RA2_DEV_HTTP=1 pnpm exec vite --port 15184 --strictPort
PASSTHROUGH_OUT=/path/to/evidence RA2_BROWSER_ORIGIN=http://127.0.0.1:15184 \
  pnpm exec tsx scripts/remaster/bridge/verifyPassthrough.mts
```

| Variable                    | Default                  | Meaning                                                       |
| --------------------------- | ------------------------ | ------------------------------------------------------------- |
| `PASSTHROUGH_OUT`           | required                 | Evidence directory (report.json, raw and page PNGs)           |
| `RA2_BROWSER_ORIGIN`        | `http://127.0.0.1:15184` | Development server origin                                     |
| `VM_BROWSER_MODE`           | `worker`                 | `worker` (production default) or `main` (`vm-worker=0`)       |
| `PASSTHROUGH_STABILITY_S`   | 600                      | Battle seconds of the stability window                        |
| `PASSTHROUGH_PERF_ROUNDS`   | 4                        | Interleaved rounds of off / terrain+objects / all             |
| `PASSTHROUGH_PERF_WINDOW_S` | 6                        | Length of one measurement window                              |
| `PASSTHROUGH_CAPTURE_SPEED` | 4                        | Native game speed (0–6) during the scripted captures          |
| `PASSTHROUGH_GPU`           | `1` on macOS             | Full Chromium with Metal ANGLE (the HD view needs a real GPU) |
| `PASSTHROUGH_HEADLESS`      | 1                        | `0` shows the browser                                         |
| `RA2_BROWSER_EXECUTABLE`    | Playwright default       | Browser binary                                                |

The evidence contains frames and page screenshots of the original game's art, so keep `PASSTHROUGH_OUT` outside Git;
the script refuses a directory inside the repository other than under the gitignored `gameres/`.

When the Chromium revision the installed `@playwright/test` expects is missing (its `playwright-core/browsers.json`
names it; chromium-1223 at the time of the recorded runs), `RA2_BROWSER_EXECUTABLE` can point to the Chromium binary of
another Playwright Chromium already in Playwright's browser cache, for example chromium-1228; the recorded runs used
that with `PASSTHROUGH_GPU=1`.

The scratch installation used for the recorded runs starts `XMP29U2` against one Easy AI with `UnitCount=10` and the
AI's country fixed through the slot's second value (`Slot01=6,9,-2` YuriCountry or `Slot01=6,8,-2` Russians; -2 is
random). The AI starts close to the player on this map and rushes an idle player within a few minutes, which is why the
script deploys the MCV first and why the stability window continues with a new match after a defeat.
