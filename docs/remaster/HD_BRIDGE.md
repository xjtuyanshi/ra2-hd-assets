# HD bridge: drawing a live match with the HD renderer

Development-only path that shows the running original game's battlefield through `packages/hd-renderer`, while the
original game keeps simulating, drawing its sidebar/command bar/cursor and receiving every input. The page starts it
only when `import.meta.env.DEV` and `?hd=1`, and only with the WebGL2 frame renderer.

Production builds contain only inert plumbing: the page's `hdBridgeRequested` is a build-time `false`, the YR hooks
(`createRenderStateReader`, `prepareRenderPassthrough` in `src/games/yr/runtimeHooks.ts`) load their modules through
development-only dynamic imports and resolve to null, and nothing calls the remaining pieces: the VM/Worker
`render-state` and `tactical-passthrough` messages, the VM core's opt-in (`renderPassthrough`) handling and the frame
renderer's key and transparent-rectangle paths. The page bridge, three.js and `packages/hd-renderer`, the YR state,
shroud, overlay and effects readers, the guest gate engine with the YR passthrough patch table, and the development server's
`/hd-cache` route are not part of production builds or `vite preview`. `tests/basic/architecture/dependencies.test.ts`
walks the production import graph from `index.html` (Worker and worklet entries included) and fails if the YR readers,
the passthrough patch table or the guest gate engine become reachable outside an `import.meta.env.DEV` branch. The
page bridge's gate is the `hdBridgeRequested` constant rather than the flag itself, so the walk counts the bridge as
reachable (and checks what it imports); only a build shows that the bridge itself is left out.

## How it fits together

1. **Game state.** `VmShell.getRenderState()` (main thread and VM Worker alike) returns a game-neutral
   `GameRenderState` (`src/games/renderState.ts`: logic frame, tactical view position, map, houses, objects, shroud, overlays and
   effects) produced by the game's `GameRuntimeHooks.createRenderStateReader`. For YR 1.001 that is
   `src/games/yr/renderState.ts`, which combines `src/games/yr/stateReader.ts` (objects, houses, map, tactical view
   position), `src/games/yr/shroudReader.ts` (the local player's shroud), `src/games/yr/overlayReader.ts` (cell overlays),
   and `src/games/yr/effectsReader.ts` (anims,
   projectiles, lasers, electric bolts and particle systems); the shroud and effects readers are created once a map is
   loaded. All of them only read guest memory, validate every pointer and refuse any executable other than the pinned
   YR 1.001 build. The VM core returns null while a shell page (menus, in-game options, score screen) owns the screen.
2. **Page bridge.** `src/ui/pages/game/hdBridge.ts` polls the state, loads the HD world for `state.map.fileName` from
   `/hd-cache/<map>/` and keeps an HD canvas under the game canvas. Polls run at most about 60 times a second while
   the HD view shows the current map, and once a second while a snapshot would go unused (no HD cache for the map, the
   view still loading, the bridge toggled off, or the VM not answering). A map whose HD view failed to load (no or an
   incomplete cache, the development server restarting, a WebGPU error) is tried again after 30 seconds and at the
   next match on it, never on every poll. While the HD view is shown the bridge switches
   on the game's native overlay passthrough (`VmShell.setTacticalPassthrough`, see below) and asks the frame renderer
   to make only key-coloured pixels transparent (`VmFrameRenderer.setTransparentKey`); without passthrough it falls
   back to a transparent tactical rectangle (`setTransparentRect`). Both need the WebGL2 renderer's alpha drawing
   buffer: with Canvas 2D (`?webgl=0`, or no WebGL2 context) the page neither installs the passthrough patches nor
   starts the bridge. The page stops the bridge (passthrough off, HD view released) before it destroys the VM,
   including when the game exits or the boot is cancelled. `__hdBridge.toggle()` in the console switches between the
   HD view and the original picture; `__hdBridge.passthrough` shows the state.
3. **Live view.** `packages/hd-renderer/src/live/liveView.ts` draws the snapshot: static map content (terrain, water,
   trees and smudges) from the map cache; overlays (walls, fences, ore, gems and other overlay types) from the live
   cell snapshot when present, otherwise from the map cache; every building/vehicle/infantry/aircraft from the snapshot using the
   per-theater type library (voxel units through `live/voxelUnits.ts`, SHP vehicles such as the terror drone, squid
   and dolphin through `live/shpUnits.ts`, and the voxel turrets of defences with `TurretAnimIsVoxel=yes` such as the
   sentry gun, flak cannon, Patriot, Grand Cannon and Gattling cannon, placed at the art's `TurretAnimX/Y` and drawn over
   their base); the shroud as a flat Z = 0 visibility mask (`live/shroud.ts`) that the renderer applies in its post
   pass after the mist and before bloom (`HdRenderer.setVisibility`), so nothing under black shroud glows through; and a
   camera framed in engine pixels from the game's `TacticalPos`, so the HD image lines up with the original pixel for
   pixel. Positions and facings are interpolated between logic frames; every animation (walking, building layers,
   build-up, effects) is clocked on the engine's logic frames, not on the wall clock. Infantry, SHP vehicles and
   aircraft get the engine's extra object light (rules `ExtraInfantryLight`/`ExtraUnitLight`/`ExtraAircraftLight`, 0.2
   in YR); buildings get none. Capturable tech buildings (oil derrick, airport, ...) of a civilian house (the bridge's
   flag or, without it, a house that owns no buildable building) keep their powered layers on the first frame, as the
   engine does until a player captures them; layers whose art has `Shadow=yes` draw their shadow frames. An object
   whose art is missing is tracked but drawn as nothing (`LiveView.diagnostics()` lists such types and counts missing
   voxel turrets; `?hd-debug=placeholders` shows a small grey box instead). Light sources and lit windows of the
   buildings standing in the match feed the night dressing (map light sources, HD street lamps, windows).
   Overlay polls run at most once per 250 ms, with an immediate reset for a new battle. The reader reuses scratch
   arrays, compares contents exactly, and only copies changed publications. Worker replies omit an unchanged overlay
   grid even when other objects move; the page retains its previous immutable grid. LiveView retains overlay instances
   and GPU batches while their revision and presentation inputs stay unchanged. The complete engine frame byte selects
   both wall connections/damage and resource growth; walls use the local player's unit-palette remap. The existing
   shroud post pass masks these sprites as well. See [Live overlays](LIVE_OVERLAYS.md) for cache upgrade and acceptance.
4. **Effects.** `live/effects.ts` (`LiveEffectsDriver`) draws the engine's effect list in two layers. The base layer is
   the ORIGINAL art: every anim the engine plays is drawn with its own SHP frames from the effect art sidecar
   (`live/effectArt.ts`, `live/effectSprites.ts`) at the engine's position, frame, layer and translucency, with
   filtered edges; it disappears when the engine removes it. `Translucent=yes` art (explosions, gunfire, trail smoke)
   fades by stage like gamemd 1.001's AnimClass draw: opaque while its stage is at most 0.2 of the anim's End, then 75,
   50 and 25 % opaque past 0.2, 0.4 and 0.6 of it (`animAlpha`); `Translucency=25/50/75` is a constant 75/50/25 %.
   Translucent cards are mixed with what lies below in display (sRGB) space, like the engine's mix of 16-bit colours, so
   an orange edge over grey pavement stays orange instead of turning salmon; the scene below is copied once per frame
   (one shared node for every atlas page), and only while a translucent card is on screen. Only opaque one-shot art
   (muzzle flashes, impact sparks, an explosion's solid first fifth) may glow, and only in its first 40 % of frames. On
   top, a table-driven HD garnish (`live/effectTable.ts`, generated by `pnpm hd:effects`) adds a brief hot core at the
   art's centre, a few sparks, a small light in the renderer's light field and, for big smoky blasts, some smoke, capped
   at the native art's width and 1.2x its lifetime; looping fires (FIRE01..03) get no HD flame, their art is the whole
   flame, only a small flickering light. The renderer's own explosion events (sandbox) keep the full procedural blast.
   Smoke particle systems (damaged and burning units and buildings, refinery chimneys) are drawn with their
   ParticleType's original SHP frames: the view runs the system's particles itself from its rules (spawn rate, cap,
   radius, velocity, deceleration, life; `SMOKE_SYSTEMS` in the table) with rise and drift measured on the engine's own
   particles, because the page does not forward particle positions. Fire systems add a small HD flame; gas and spark
   systems draw nothing. Projectiles with known art are drawn natively (`live/projectiles.ts`), others as small grey
   dots. Lasers and electric bolts are rebuilt once per logic frame as soft-edged segments in the bolt's own colour.
   The live view never shakes the camera, so the HD picture stays aligned with the game's own selection boxes, health
   bars and cursor. Atlas pages are single-channel R8 textures (they hold palette indices), uploaded from the decoded
   image straight into the GPU texture; the pages of the common combat anims and smoke particles are requested when the
   view starts, the others on first use and released again after 90 seconds unused, and a page that fails to load is
   skipped (and retried 30 seconds later) instead of being asked for on every frame.
5. **Native overlay passthrough.** With `?hd=1` (and WebGL2) the page opts the VM into
   `GameRuntimeHooks.prepareRenderPassthrough`; for YR 1.001 (`src/games/yr/tacticalPassthrough.ts`) the original game
   then keeps running its tactical drawing code but writes no pixels for the categories switched on (terrain 1,
   objects 2, effects 4). The terrain category fills the tactical view with RGB565 0xF81F instead, so selection
   brackets, health bars, pips, the band box, the placement grid, target lines, text and timers stay native and
   pixel-identical on top of the HD world. `?hd-passthrough=` picks the categories (default all three; e.g.
   `terrain,objects` keeps native effects, `none` restores the plain transparent-rectangle mode). Only terrain
   produces key pixels, so a set without it (e.g. `objects,effects`) still switches those categories off in the game
   but uses the transparent tactical rectangle, and the native overlays are hidden with the rest of the tactical view.
   Details and evidence: `docs/remaster/research/tactical-passthrough.md`,
   `scripts/remaster/bridge/verifyPassthrough.mts`.

## Local data it needs

All of it is derived from the player's own install and lives in the gitignored `gameres/hd-cache/` (served by the
development server at `/hd-cache/`; override the directory with `RA2_HD_CACHE_DIR`). The normal way to build one map's
cache is a single command, which runs extraction, the terrain composite, Real-ESRGAN upscaling, the HD sprite atlases
and the map theater's type library in order and skips steps whose outputs are current:

```bash
pnpm hd:prepare -- --map XMP29U2        # a map id, a map file name, or a path; add --dry-run to see the plan
```

A cache built while the game page is open needs no reload: the bridge retries a map that had no HD view 30 seconds
after the failed load, or at once when a new match starts on it.

`--map` accepts maps stored inside the game's MIX archives (most multiplayer maps; the extractor looks in top-level
archives and one level down in the stock map archives) as well as loose map files and `.yro`/`.mmx` packages. The
individual steps remain available when one needs rerunning by hand (options, defaults and the upscaler binary are
documented in `packages/ra2-assets/README.md`):

```bash
pnpm hd:extract -- --map RiverRam.yro        # map cache (terrain, map objects, palettes)
pnpm hd:library -- --theater temperate       # every buildable type for that theater
pnpm hd:effects                              # effect art sidecar: every anim, projectile, particle, overlay, smudge
pnpm hd:terrain-map -- --map RiverRam        # whole-map terrain composite + water mask
pnpm hd:upscale -- --map RiverRam --scale 2  # Real-ESRGAN 2x terrain (local binary under gameres/tools)
pnpm hd:sprites -- --map RiverRam            # 2x HD sprite atlas with house-paint mask
pnpm hd:sprites -- --library temperate       # same for the type library pages (slow: minutes per page)
```

The effect art sidecar (`gameres/hd-cache/_library/common/effects/`, about 80 MiB for all six theaters) is shared by
every map; without it the live view draws no native effects and only the HD garnish remains.

Optional terrain re-materialisation with a local diffusion model (SDXL + tile ControlNet, weights and a Python venv
under `gameres/tools/diffusion/`) is the opt-in `remat` step of `hd:prepare` (add it to `--steps`), which runs
`packages/ra2-assets/python/rematerialize.py`; to try it on part of the map first, run the script directly with
`--region`.

## Running it

Start a development server whose game root holds a skirmish setup (a scratch copy of the installation with an edited
`RA2MD.INI` `[Skirmish]` section, as described in `scripts/remaster/perf/README.md`), then open
`/?start-page=battle&hd=1`. By default the HD lighting follows the map's own `[Lighting]` (day, dusk or night maps, see `pnpm hd:lights`); `hd-time=<hours>` and `hd-weather=rain` override it; `hd-rect=x,y,w,h`
overrides the tactical rectangle (default: the frame minus YR's 168 px sidebar and 32 px command bar).

## Bridge fields

The live view's snapshot types carry optional fields beyond what the page forwards today. Each consumer is active only
when its field is present and falls back to a documented estimate otherwise; all of them are unit-tested with
synthetic snapshots (`tests/basic/hdLive*.test.ts`). Building/infantry H2 fields are now read from pinned YR 1.001 and
forwarded end to end. Evidence, optional-read boundaries and remaining H1/H2/H3 proposals are in
`docs/remaster/research/hd-bridge-fields.md`; H1 only stops dropping fields the readers already read.

| Step | Fields                                                                                                                       | Used for                                                                                    | Fallback without it                                                                                                                                                                                                                                                        |
| ---- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| H1   | `LiveAnim` frame, stage, frameCount, loop range, loopsLeft, rate, flat, translucency, layer, owner, attachedTo, buildingAnim | exact anim frames; AltPalette art in the owner's colours; building layers exactly as played | frame counted from the anim's first sighting at the art's rate (`animFrameAt`, `animRateFrames` in `packages/ra2-assets/src/effects.ts`); ActiveAnim/IdleAnim always, ActiveAnimTwo..Four except on ore storage buildings, powered layers of civilian tech buildings still |
| H1   | `LiveBullet` type, weapon, warhead, frame, velocity, source, target, arcing                                                  | projectile art (SHP by frame or flight direction, voxel along its velocity)                 | a small grey dot                                                                                                                                                                                                                                                           |
| H1   | `voxelAnims`, `fireEvents`, laser outer colour/thickness/progress                                                            | debris voxels; firing frames of SHP units and infantry                                      | none; no firing frames                                                                                                                                                                                                                                                     |
| H1   | particle system type, particleCount, lifetime, attachedTo, particles (with type and frame)                                   | the system's own rules and spawn window; the engine's particles as they are                 | `SmallGreySSys` rules; spawning for 48 logic frames after the first sighting, or for as long as the system is listed when it sits exactly on a vehicle                                                                                                                     |
| H1   | `LiveHouse.civilian` (Neutral and Special houses)                                                                            | idle tech buildings                                                                         | houses owning no buildable building count as civilian                                                                                                                                                                                                                      |
| H2   | `LiveObject` buildState, buildupFrame, infantrySequence, sequenceFrame                                                       | engine make frame (already reversed for selling); named infantry sequence and local step    | first-seen frame recorded at snapshot push; new buildings after a push gap greater than 54 logic frames assumed complete; otherwise estimated make after initial 60-frame grace period; selling unavailable; infantry walk/stand, Die1 at 0 health, FireUp after a shot    |
| H3   | `snapshot.overlays` (implemented); optional `snapshot.cells` tuple proposal for overlays/smudges                             | engine ore growth/depletion and wall frames; runtime smudges still proposed                 | the map's initial overlays/smudges when live data is absent; no HD scorch marks                                                                                                                                                                                            |

## Known limits

- The page skips native effects by default (`?hd-passthrough=` all) and the live view draws them itself from their
  original art, so translucent smoke and explosions no longer blend with the key colour. With
  `?hd-passthrough=terrain,objects` the game's own effects stay on top of the HD world and translucent ones still pick
  up the magenta key.
- HD effects cover what the page forwards to the live view: invisible anims and anims without art, and projectiles the
  original never draws (`Inviso`) are left out; beam colours are approximated (lasers use their inner colour, electric
  bolts one of two fixed colours); non-combat anims such as the move-order ring or ore glints are ignored.
- Without H1 the native effect frames are estimates: anims whose engine rate differs from the art's (a few building
  anims) drift, AltPalette art (corpses, civilian building collapses) shows the palette's default red remap instead of
  its owner's colours, projectiles are grey dots, and smoke columns follow the view's own particles, which match the
  engine's in rate, rise and life but not particle for particle. Building layers that depend on engine state the
  readers do not expose (production, super weapon charge, low power) are not animated.
- YR 1.001 now supplies H2 building construction/selling and infantry sequence state. Invalid or partially initialized
  fields remain optional: without them, placed buildings estimate make progress from their first pushed snapshot,
  and sold buildings vanish without sale animation. A new building first observed after a snapshot gap longer than
  54 logic frames is assumed complete; rendering pauses and delayed art never restart its make clock. A library
  missing a named infantry sequence keeps walk/stand/fire/death estimates; one without sequence metadata draws its
  first body frame. The normal type library already extracts all artmd sequences.
- SHP vehicles take
  the object's facing (their directions run clockwise from screen-up, the mirror of the infantry order; frame-matched
  on four live terror drones, two of them at a correlation of 0.95 and more) and walk on logic frame / `WalkRate`; a
  walk step counter and body facing from H2 would make the walk and firing frames exact.
- Live overlay snapshots cover engine ore growth/depletion and wall frames (see [Live overlays](LIVE_OVERLAYS.md)).
  When live data is absent, the map's initial overlays remain the fallback and
  `LiveView.diagnostics().cellsFromEngine` stays false. Engine craters/burn marks are not yet forwarded; the runtime
  smudge portion of H3 remains a proposal in `docs/remaster/research/hd-bridge-fields.md`.
- H2 infantry sequence state covers prone/crawling/deployment/death art, but Spy disguise type substitution and some
  jumpjet target-based facing remain unprojected. Real-game same-moment HD build/sell/infantry comparison is separate
  acceptance from reader tests and executable disassembly.
- The day-time brightening around the map's lamp posts and other light sources (the engine adds them to every cell's
  light, up to 1.34x next to an INGALITE post) is not part of the live view; it belongs to the renderer's map lighting.
- The normalized anim rate (`NORMALIZED_RATE_FACTOR`), the build-up rate, the smoke kinematics and the shroud edge
  (`EDGE_INSET`, `EDGE_SOFTNESS`) were fitted on XMP29U2 skirmishes at the development settings; other game speeds may
  need the bridge's exact values. The build-up rate estimate is used only when engine H2 state is unavailable.
