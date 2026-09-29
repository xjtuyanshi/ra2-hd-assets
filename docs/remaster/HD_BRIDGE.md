# HD bridge: drawing a live match with the HD renderer

Development-only path that shows the running original game's battlefield through `packages/hd-renderer`, while the
original game keeps simulating, drawing its sidebar/command bar/cursor and receiving every input. The page starts it
only when `import.meta.env.DEV` and `?hd=1`, and only with the WebGL2 frame renderer.

Production builds contain only inert plumbing: the page's `hdBridgeRequested` is a build-time `false`, the YR hooks
(`createRenderStateReader`, `prepareRenderPassthrough` in `src/games/yr/runtimeHooks.ts`) load their modules through
development-only dynamic imports and resolve to null, and nothing calls the remaining pieces: the VM/Worker
`render-state` and `tactical-passthrough` messages, the VM core's opt-in (`renderPassthrough`) handling and the frame
renderer's key and transparent-rectangle paths. The page bridge, three.js and `packages/hd-renderer`, the YR state,
shroud and effects readers, the guest gate engine with the YR passthrough patch table, and the development server's
`/hd-cache` route are not part of production builds or `vite preview`. `tests/basic/architecture/dependencies.test.ts`
walks the production import graph from `index.html` (Worker and worklet entries included) and fails if the YR readers,
the passthrough patch table or the guest gate engine become reachable outside an `import.meta.env.DEV` branch. The
page bridge's gate is the `hdBridgeRequested` constant rather than the flag itself, so the walk counts the bridge as
reachable (and checks what it imports); only a build shows that the bridge itself is left out.

## How it fits together

1. **Game state.** `VmShell.getRenderState()` (main thread and VM Worker alike) returns a game-neutral
   `GameRenderState` (`src/games/renderState.ts`: logic frame, tactical view position, map, houses, objects, shroud and
   effects) produced by the game's `GameRuntimeHooks.createRenderStateReader`. For YR 1.001 that is
   `src/games/yr/renderState.ts`, which combines `src/games/yr/stateReader.ts` (objects, houses, map, tactical view
   position), `src/games/yr/shroudReader.ts` (the local player's shroud) and `src/games/yr/effectsReader.ts` (anims,
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
   trees, ore, smudges) from the map cache, every building/vehicle/infantry/aircraft from the snapshot using the
   per-theater type library, the shroud as a flat Z = 0 darkening layer (`live/shroud.ts`), and a camera framed in
   engine pixels from the game's `TacticalPos`, so the HD image lines up with the original pixel for pixel. Positions
   and facings are interpolated between logic frames. Effects go through `live/effects.ts` (`LiveEffectsDriver`):
   each explosion, muzzle flash, impact, fire and smoke anim the engine plays spawns the matching HD effect at the same
   place and moment, projectiles in flight draw tracers, lasers and electric bolts draw beams, and fire and smoke
   particle systems emit HD fire and smoke.
4. **Native overlay passthrough.** With `?hd=1` (and WebGL2) the page opts the VM into
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
pnpm hd:terrain-map -- --map RiverRam        # whole-map terrain composite + water mask
pnpm hd:upscale -- --map RiverRam --scale 2  # Real-ESRGAN 2x terrain (local binary under gameres/tools)
pnpm hd:sprites -- --map RiverRam            # 2x HD sprite atlas with house-paint mask
pnpm hd:sprites -- --library temperate       # same for the type library pages (slow: minutes per page)
```

Optional terrain re-materialisation with a local diffusion model (SDXL + tile ControlNet, weights and a Python venv
under `gameres/tools/diffusion/`) is the opt-in `remat` step of `hd:prepare` (add it to `--steps`), which runs
`packages/ra2-assets/python/rematerialize.py`; to try it on part of the map first, run the script directly with
`--region`.

## Running it

Start a development server whose game root holds a skirmish setup (a scratch copy of the installation with an edited
`RA2MD.INI` `[Skirmish]` section, as described in `scripts/remaster/perf/README.md`), then open
`/?start-page=battle&hd=1`. `hd-time=<hours>` and `hd-weather=rain` change the HD lighting; `hd-rect=x,y,w,h`
overrides the tactical rectangle (default: the frame minus YR's 168 px sidebar and 32 px command bar).

## Known limits

- Native effects are skipped by default. With `?hd-passthrough=terrain,objects` they stay native, and translucent ones
  (smoke, explosion edges) blend with the key colour and look magenta-tinted over the HD world.
- HD effects cover what the page forwards to the live view: building animations, invisible anims and anims without
  art, and projectiles the original never draws (`Inviso`) are left out; beam colours are approximated (lasers use
  their inner colour, electric bolts one of two fixed colours); particle systems other than fire and smoke (gas,
  sparks, railgun) are not drawn; non-combat anims such as the move-order ring or ore glints are ignored.
- Building layers that depend on engine state the readers do not expose (production, super weapon charge, low power)
  are not animated; infantry only distinguishes walking from standing.
