# HD bridge: drawing a live match with the HD renderer

Development-only path that shows the running original game's battlefield through `packages/hd-renderer`, while the
original game keeps simulating, drawing its sidebar/command bar/cursor and receiving every input. The page starts it
only when `import.meta.env.DEV` and `?hd=1`, and only with the WebGL2 frame renderer.

Production builds contain only inert plumbing: the page's `hdBridgeRequested` is a build-time `false`, the YR hooks
(`createRenderStateReader`, `prepareRenderPassthrough` in `src/games/yr/runtimeHooks.ts`) load their modules through
development-only dynamic imports and resolve to null, and nothing calls the remaining pieces: the VM/Worker
`render-state` and `tactical-passthrough` messages, the VM core's opt-in (`renderPassthrough`) handling and the frame
renderer's key and transparent-rectangle paths. The page bridge, three.js and `packages/hd-renderer`, the YR state,
shroud, overlay, smudge and effects readers, the guest gate engine with the YR passthrough patch table, and the development server's
`/hd-cache` and `/__perf/stalls` routes are not part of production builds or `vite preview`. `tests/basic/architecture/dependencies.test.ts`
walks the production import graph from `index.html` (Worker and worklet entries included) and fails if the YR readers,
the passthrough patch table or the guest gate engine become reachable outside an `import.meta.env.DEV` branch. The
page bridge's gate is the `hdBridgeRequested` constant rather than the flag itself, so the walk counts the bridge as
reachable (and checks what it imports); only a build shows that the bridge itself is left out.

## How it fits together

1. **Game state.** `VmShell.getRenderState()` (main thread and VM Worker alike) returns a game-neutral
   `GameRenderState` (`src/games/renderState.ts`: logic frame, tactical view position, map, houses, objects, shroud, overlays, smudges and
   effects) produced by the game's `GameRuntimeHooks.createRenderStateReader`. For YR 1.001 that is
   `src/games/yr/renderState.ts`, which combines `src/games/yr/stateReader.ts` (objects, houses, map, tactical view
   position), `src/games/yr/shroudReader.ts` (the local player's shroud), `src/games/yr/overlayReader.ts` (cell overlays),
   `src/games/yr/smudgeReader.ts` (cell craters and burn marks), and `src/games/yr/effectsReader.ts` (anims,
   projectiles, lasers, electric bolts and particle systems); the shroud and effects readers are created once a map is
   loaded. All of them only read guest memory, validate every pointer and refuse any executable other than the pinned
   YR 1.001 build. The VM core returns null while a shell page (menus, in-game options, score screen) or a visible full-size Win32 dialog owns the screen, including confirmations without a title control. This display check does not change shell-page input routing or composition.
2. **Page bridge.** `src/ui/pages/game/hdBridge.ts` polls the state, loads the HD world for `state.map.fileName` from
   `/hd-cache/<map>/` and keeps an HD canvas under the game canvas. Polls run at most about 60 times a second while
   the HD view shows the current map, and once a second while a snapshot would go unused (no HD cache for the map, the
   view still loading, the bridge toggled off, or the VM not answering). A map whose HD view failed to load (no or an
   incomplete cache, the development server restarting, a WebGPU error) is tried again after 30 seconds and at the
   next match on it, never on every poll. On the VM route such a match shows the original picture, complete and unkeyed, and the
   page says why in a notice at the top of the game frame (`#vm-hd-status`, styled like the upscale notice): that the
   map has no HD assets (the loader's `MapCacheMissingError`: no `manifest.json`) or that its HD view failed to load.
   The notice appears once per match, stays until the match has run for 12 seconds (the load already fails while the
   game shows its loading screen) and goes when the battle ends or the view loads. The game spells
   one scenario differently over time (`2Peaks` from the skirmish menu, `2PEAKS.MAP` once the match runs) and the
   development server resolves cache names without regard to case, so the bridge compares map names lower-cased: a
   change of casing neither reloads the view nor counts as another map. While the HD view is shown the bridge switches
   on the game's native overlay passthrough (`VmShell.setTacticalPassthrough`, see below) and asks the frame renderer
   to make only key-coloured pixels transparent (`VmFrameRenderer.setTransparentKey`); without passthrough it falls
   back to a transparent tactical rectangle (`setTransparentRect`). Both need the WebGL2 renderer's alpha drawing
   buffer: with Canvas 2D (`?webgl=0`, or no WebGL2 context) the page neither installs the passthrough patches nor
   starts the bridge. The page stops the bridge (passthrough off, HD view released) before it destroys the VM,
   including when the game exits or the boot is cancelled. The toolbar's picture button and the `\\` key switch between
   the HD view and the original picture (the key is the page's only while a bridge runs; otherwise it reaches the
   game), as does `__hdBridge.toggle()` in the console; `__hdBridge.passthrough` shows the state.
   Switching to the original picture closes passthrough even while native preflight has not yet opened a hole.
   Disabled idle polls still track the match, but cannot re-enable the guest's render flags.
   Both routes keep the original battlefield live, visible and interactive while HD prepares. A complete
   scene cross-fades with the current original frames over 300 ms, once per match. No screenshot or cover is
   used. Native preparation shows a noninteractive status notice in the page's language at 16 CSS pixels;
   an early map hint does not show it in menus. The notice clears on HD reveal, a menu return, or bridge stop,
   and yields to cache/art failure explanations. `VmFrameRenderer.setOpacityRegion` scales the tactical region's
   premultiplied RGB and alpha together,
   leaving the sidebar and independent pointer opaque. Passthrough is enabled after the fade; an actual keyed
   game picture switches the original overlays back to full opacity on both routes. A passthrough acknowledgement
   alone cannot replace that picture: its configuration only takes effect in a subsequent game frame.
   Before beginning the fade, a zero-flag
   preflight installs and validates passthrough without changing the original picture; rejection keeps the original
   visible and retries. Disabling passthrough also retries an unconfirmed zero write. The optional HD sidebar
   preloads its chrome from sidebar snapshots while hidden and joins only after the battlefield fade completes
   and that chrome is ready; incomplete chrome leaves the game's sidebar intact. A failed cache load leaves the original
   picture with a small status notice. A state gap or read failure keeps the last HD picture for 500 ms before
   returning to the original dialog/menu. A confirmed native menu video mode resets reveal state immediately,
   while retaining prepared GPU assets for another match. Transient passthrough failures retry; they do not become
   permanent unsupported flags. `__hdBridge.timeline` records the first battle picture, preparation and fade
   timestamps plus a detached, bounded page-session `transitions` history (`atMs`, ISO `time`, map, frame,
   from/to and reason); `transitionsOmitted` explicitly counts records beyond 512.

3. **Live view.** `packages/hd-renderer/src/live/liveView.ts` draws the snapshot: static map content (terrain, water,
   trees) from the map cache; overlays (walls, fences, ore, gems) and smudges (craters, scorch and burn marks) from
   independent live cell snapshots when available, otherwise from the map cache; every building/vehicle/infantry/aircraft from the snapshot using the
   per-theater type library (voxel units through `live/voxelUnits.ts`, SHP vehicles such as the terror drone, squid
   and dolphin through `live/shpUnits.ts`, and the voxel turrets of defences with `TurretAnimIsVoxel=yes` such as the
   sentry gun, flak cannon, Patriot, Grand Cannon and Gattling cannon, placed at the art's `TurretAnimX/Y` and drawn over
   their base); the shroud as a flat Z = 0 visibility mask (`live/shroud.ts`) that the renderer applies in its post
   pass after the mist and before bloom (`HdRenderer.setVisibility`). Native top-layer effect art uses a separate
   transparent pass above that mask, matching storm clouds over black shroud; ground/air effects remain masked. A
   camera framed in engine pixels from the game's `TacticalPos`, so the HD image lines up with the original pixel for
   pixel. Positions and facings are interpolated between logic frames: each step plays at one speed from the poses
   on screen to the newest snapshot, due a period and a quarter after that frame's arrival on a de-jittered logic
   clock (`LiveView.scheduleMotion`; snapshots arrive 30 to 75 ms apart, and interpolating over the last arrival
   interval stalled and jumped). Every animation (walking, building layers,
   build-up, effects) is clocked on the engine's logic frames, not on the wall clock. Infantry, SHP vehicles and
   aircraft get the engine's extra object light (rules `ExtraInfantryLight`/`ExtraUnitLight`/`ExtraAircraftLight`, 0.2
   in YR); buildings get none. Capturable tech buildings (oil derrick, airport, ...) of a civilian house (the bridge's
   flag or, without it, a house that owns no buildable building) keep their powered layers on the first frame, as the
   engine does until a player captures them; layers whose art has `Shadow=yes` draw their shadow frames. Types the
   scenario's own rules define or redefine (DeepFrze's `GTGCANA`, the campaign's numbered tech power plants, a
   lamp-post dummy made visible) are not in the theater library, which is built from `rulesmd.ini` alone: the map
   cache's `scenario-types.json` binds each to the stock type with the same art and carries its rules-derived traits,
   and `live/library.ts` lays those entries over the library's type table when the match loads (see "Scenario types"
   in `packages/ra2-assets/README.md`). Without that file such a building falls back to the map cache's single body
   frame, without layers or turret. An object
   whose art is missing is tracked but drawn as nothing (`LiveView.diagnostics()` lists such types, the building
   types drawn from the map cache's body frame for want of a library record (`mapCacheTypes`), and counts missing
   voxel turrets; `?hd-debug=placeholders` shows a small grey box instead). A voxel model whose smooth mesh is still
   being built is not missing art: it is drawn from a stand-in mesh (`diagnostics().standInVoxels`). Nor is a
   sprite whose atlas page is in while the page's HD art is not: it is drawn from the indexed page
   (`indexedSprites`), and a sprite object whose new state needs a page that has not arrived keeps its previous
   picture (`heldPictures`); `incompletePictures` counts the objects of which a part had nothing to draw from and
   no earlier picture to show (see "A sprite the game shows is never missing" below). Light sources
   and lit windows of the
   buildings standing in the match feed the night dressing (map light sources, HD street lamps, windows).
   Overlay and smudge polls run at most once per 250 ms, with an immediate reset for a new battle. The reader reuses scratch
   arrays, compares contents exactly, and only copies changed publications. Missing host cells warn only after five
   seconds without any publication in that match; a valid empty grid counts as publication. Worker replies omit each unchanged cell
   grid even when other objects move; the page retains its previous immutable grid. LiveView retains overlay and smudge instances
   and GPU batches while their revision and presentation inputs stay unchanged. The complete engine frame byte selects
   both wall connections/damage and resource growth; walls use the local player's unit-palette remap. The
   smudge data byte instead identifies a footprint cell: library Width/Height reconstruct the origin, with native SHP
   frame 0. Smudges use full terrain lighting and the theater iso palette, below overlays. Empty live smudge grids
   remove map-start smudges even if an old library lacks the new section; known map art is used where possible and
   missing metadata/art warns once. The shroud post pass masks these sprites as well. See [Live overlays](LIVE_OVERLAYS.md) for cache upgrade and acceptance.
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
   `LiveViewOptions.effects: 'enhanced'` (or `LiveView.setEffectStyle`; default `'faithful'`) plays the remaster's
   modern effects around the same native art instead (`ENHANCED` in `src/effects.ts`): a real flash in the light field
   that lights ground, buildings and units, a bloomed glow halo, hot sparks and tumbling debris, rolling black-orange
   smoke lit by the sun and the fire below, heat shimmer, a dust ring and, for anims that leave a crater, the crater
   glowing hot for about two seconds. The native frames, their timing and size, and the persistent crater (the engine's
   own smudge) stay as they are.
   Native `Layer=air` draws over the ground layer. The final P-L5H-3b policy is per **(fire, object)**:
   `front=objectCode-fireCode`; less than **FRONT_DISTANCE=1.5 horizontal cells** covers the complete owner;
   at least 1.5 keeps it completely in front. Rhino 5009 is 1.83848 cells ahead of EXPLOLRG but 0.84853
   behind TWLT050, so these two fires receive opposite decisions in the same frame. Trees/bushes and overlay
   mains always cover via code **-1024**. The CPU near test only chooses capture membership: retain uncapped
   native/HD crop unions and merge growth, 0.75-cell fire/object margins, SHP owner parts across pages, voxel
   spheres/turret offsets and building foundation/turret extents. Alive explosion garnish contributes up to seven
   conservative pool circles, including shader motion, so capture survives the end of a native card. Delayed/unborn,
   expired and muzzle/electric/continuous-fire particles do not activate it. Units/infantry/parked aircraft use
   their ground draw anchor with height/bridge placement; buildings use foundation centre at body ground height
   (missing foundation 1x1). Flying aircraft remain excluded (flight layer or height > ground + 0.01).
   `HdRenderer.terrainDepth` owns **one** drawing-buffer-size layer-31 capture, **RG16F + depth32float**, followed
   by one fullscreen reduction with **two RGBA16F MRT attachments without depth**. Capture uses the original materials/depth/alpha discard;
   voxel layers touch only explicit body/turret/barrel part meshes and restore prior masks/userData. Shared voxel
   materials read a code from the rendered mesh's object-group uniform. Sprite flags component 8 (stride 9;
   non-capture stride 8) stores the instance code or **-65504** for capture-only discard. Main/capture sprite
   layouts remain six buffers/nine attributes, ground passes six/eight; native/HD Air cards remain six/eight buffers.
   Codes are horizontal anchor coordinates relative to this frame's `IsoCamera.target`, near view centre.
   Cards use instance anchors; garnish uses each particle's current x/z, including drift/ballistics/wobble.
   With `u=2^-11`, RG encode/decode plus reduction code storage error is bounded by
   `abs(code)*((1+u)^2/(1-u)-1)+2^-20`: <0.011728 cells at |code|<=8, <0.046907 at |code|<=32.
   Wider views increase the bound; no arbitrary-zoom precision claim is made. Capture MRT writes `R=code*a,G=a`
   using original normal blending: over clear `(code*a*b)/(a*b)=code` (b=a). Same-anchor parts preserve the ratio;
   different transparent owners produce weighted code mixtures requiring pixel review. A capture-only MRT
   keeps vec4 shader output on RG16F because r186's normal RG conversion drops the source alpha. Main/mirror
   output and all materials stay unchanged. See three.js 0.186.1 `MRTNode.setup`/`NodeMaterial.setup` and GPUWeb CTS
   `src/webgpu/api/validation/render_pipeline/fragment_state.spec.ts` for the output/blending compatibility evidence.
   The reduction clamps a 3x3 neighbourhood, ignoring depth>=1 or G<=0. Record A keeps the captured centre's
   code, or the nearest captured code if the centre is absent. Record B keeps the nearest captured code differing
   from A by more than **OBJECT_CODE_TOLERANCE=0.1**, or is invalid. Each RGBA16F attachment stores sMin/sMax
   only over texels within tolerance of its own code, that code, and valid; invalid records are zero. Nearest ties
   keep the first row-major texel. Codes are anchor groups, not unique IDs; a third distinct group is not retained.
   Depths are camera-space distances relative to view-centre distance (150 cells): the 0.1..400 range becomes
   [-149.9,250), max half-float rounding 0.0625 cells. Use **CAP=2 camera-space cells, eps=0.2 cells**:
   For each valid record, `spread=min(sMax-sMin,CAP)`, `cover=code-fireCode<1.5`.
   `P=min over cover records of (sMin-spread-eps)`, `Q=max over front records of (sMax+spread+eps)`;
   absent P/Q are +infinity/-infinity. Each eligible main-pass fire fragment makes **two textureLoads** and uses
   `min(max(base,normalized(Q)),normalized(P))`; no valid records keeps base exactly. If Q>P, the covered surface
   is the visible front, so cover wins by applying P last. This covers a centre bush behind a FRONT tank even
   with base behind the bush, while keeping every tank sample in front; it also covers a COVER tank over a centre
   bush. Normalize distances by camera near/far. The 3x3 window and extra spread within each code group
   bound neighbouring-triangle pixel-centre depth extrapolation up to min(spread,CAP), handling MSAA samples
   that retain different triangles than the single-sample centre. eps covers three half-float errors (0.1875)
   plus D24 rounding. Triangles absent from all nine texels or extrapolation beyond CAP are outside this local proof.
   The sphere `sqrt(max(0,R*R-r*r))`, R=min(1.16,displayed max dimension/2), factor 1, 0.5 anchor support, 0.04 Air
   bias and legacy merge max-combination remain the fallback. Same non-flat Air cards and explosion core/blast/
   halo/billow/column/spark/ember garnish are eligible. Existing mode tags keep shared pools gated; Ground/Top/
   flat/shadow, ground garnish, muzzle/electric/continuous-fire garnish, beams/projectiles and volumetric blasts
   retain their policies. Object-group gates recompute after nested reflectors using actual target/camera.
   WebGL2 omits the capture/reduction path. With no Air explosion/collapse card and no explosion garnish alive,
   skip both passes and all clears; pull defaults off. HdRenderer owns resize/disposal; success/failure restores
   target/cube face/mipmap/MRT/clear colour/alpha/depth/auto-clear/background. Pipeline rebuilds retain these targets.
   Storage: **24 bytes/pixel**, **86,400,000 bytes (86.4 MB, 82.40 MiB)** at 2400x1500, excluding existing scene
   attachments and driver overhead: depth32float (4) + RG16F (4) + two RGBA16F records (16), without packing or
   precision loss. This adds **28.8 MB (27.47 MiB, +50%)** over the prior 57.6 MB estimate, or 26.4 MB over the
   approximate 60 MB goal. Active-frame cost: one scene capture, one fullscreen reduction (9 depth + 9 code
   loads shared by both records), two reduction loads per eligible fire fragment; one extra instance scalar, no extra vertex buffer.
   CPU scratch records are reused; active garnish pools scan their allocated slots and owners compare near circles;
   unchanged no-fire frames skip owner uploads. `objectDepth.ts` exports the pure encode/decode/reduction/decision/
   precision twins. CPU tests cover per-pair Rhino, 3D hull/turret/barrel, SHP drone, trees/corners, MSAA shallow/steep
   edges, centre-bush/FRONT and COVER tank edges, conflicting COVER tree/FRONT unit, two FRONT units, ownership
   tolerance, blending, formats/memory, lifecycle/gates and actual WGSL/binding budgets. GPU execution, XMP29U2 4x pixels,
   different-owner transparent edges and same-scene performance remain **UNVERIFIED**.
   See [Painter-order evidence](research/painter-order.md) for the policy and capture contract.
   Smoke particle systems (damaged and burning units and buildings, refinery chimneys) are drawn with their
   ParticleType's original SHP frames: the view runs the system's particles itself from its rules (spawn rate, cap,
   radius, velocity, deceleration, life; `SMOKE_SYSTEMS` in the table) with rise and drift measured on the engine's own
   particles, because the page does not forward particle positions. Fire systems add a small HD flame; gas and spark
   systems draw nothing. Projectiles with known art are drawn natively (`live/projectiles.ts`), others as small grey
   dots. Lasers and electric bolts are rebuilt for changed logic frames or beam publications, including same-frame
   expiration, as soft-edged segments in the bolt's own colour. Zero-lifetime native bolts are omitted.
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

The native YR route also publishes optional `GameRenderState.battlefieldOverlay` observations through
`src/games/yr/battlefieldOverlayReader.ts`: selected-object health, group digits/colors, native mobile-bar parameters,
building foundation dimensions and reader CPU time. It validates the executable and field dependencies, rereads selection
independently of the world-state cache, and returns null for unknown data. Advisory mirror availability checks never
trigger subscriptions or invalidate an otherwise complete world read. These observations do not contain draw-atomic
anchors, clipping or building occlusion and do not enable any replacement gate; all tactical overlays remain native.
The selective replacement and fallback contract is specified in [HD battlefield overlays](HD_OVERLAYS.md).

## Match start

A match must not open on a half-drawn or frozen battlefield. Measured on the base build (XMP29U2 skirmish, 1728x1080
game at two device pixels per game pixel): the players' starting units do not exist until the game's loading screen
ends, so the view first heard of them in the match's first snapshot and spent the next seconds on the thread that
presents frames: 3.0 s building smooth voxel meshes (two freezes of 0.6 and 2.8 s), 1.2 s building shader graphs, and
about 0.6 s uploading 8192 px atlas pages, while objects appeared as their pages arrived.

- **The view prepares without hiding play.** Both routes show the complete original battlefield from its first
  frame, including native input, pointer, selection and sidebar. A validated early scenario hint
  (`VmShell.getRenderPreparation`) may load and warm the map during menus or the game's own loading screen.
  An empty browser profile prepares an empty offscreen scene for map/effect shaders; it does not invent units.
  Remembered opening types add their art when available. A hint is never battle authority: a stale or wrong map
  can only waste preparation. The HD scene replaces the
  original only after a complete battle snapshot, complete local-player art and three complete consecutive frames
  (`LiveView.settledFrames`: pages, meshes, redraw projections, effects and pipelines). `localArtComplete` also
  rejects unknown local ownership or a failed/missing local unit, building page or turret after loading has ended.
  Such a failure retains the original picture with a small notice. There is no deadline
  that permits a partial scene. If preparation takes more than three seconds, the original remains playable
  until a complete scene can cross-fade in. Once shown, HD stays for the match; a new match resets the reveal
  state, including a confirmed menu return followed by a short second match on the same map.
- **Nothing heavy on the presenting thread.** Smooth voxel meshes are built by a small pool of Workers
  (`packages/hd-renderer/src/ra2/voxelSmoothPool.ts`, `voxelSmoothWorker.ts`). Out of sight a model waits for its
  mesh; a **shown** view never does: a vehicle, aircraft, ship, building turret or voxel shell that appears while
  its mesh is being built is drawn at once from a stand-in mesh (the plain exposed-face mesh, milliseconds to
  build, same materials) in the same place, facing and depth, and changes to the smooth mesh in place when the
  Worker answers (`VoxelUnits.build` / `adoptSmooth`; see the renderer README). Before that rule a new kind of
  vehicle was missing from the HD picture until its mesh arrived (measured: 281 presented frames, 7.2 s, for a War
  Miner on a loaded machine). The voxel model files themselves are fetched ahead once the opening is in
  (`LiveLibrary.preloadVoxels`), so a new kind has a model in its first frame. Out of sight a sprite layer waits for its material
  page instead of being built twice. Decoded atlas pages are copied to the GPU in strips
  (`packages/hd-renderer/src/pageUpload.ts`) instead of 253 MiB in one call: 8 M pixels per frame while the view is
  shown (up to twice that when a frame comes late). Out of sight the bridge sets the pace: behind the loading screen
  (the scenario has no objects yet) everything is built and uploaded as it arrives; from the first objects on, when
  the game's own picture is or is about to be on screen, one new kind of art per frame (`LiveView.newArtPerFrame`:
  each brings shaders that are built in the frame that first draws it, and a whole opening in one frame froze the
  page, the game's picture included, for a second) and the same 8 M pixels of pages per frame
  (`LiveView.hiddenUploadPixels`). Sprite material pages no longer keep their decoded bitmap after the upload.
  The smooth-mesh Worker also keeps a content-addressed IndexedDB cache (`ra2-hd-smooth-meshes`). Its key includes
  the complete voxel section, all smoothing options and the mesh algorithm version. It stores GPU-independent
  typed arrays, commits them before transferring the result, and evicts least-recently-used entries above
  128 MiB. Subsequent browser sessions can reuse complete meshes without recomputing them. Unavailable, denied,
  corrupt or quota-limited storage only causes a normal rebuild; cache hits never relax scene completeness.
  `LiveView.activity()` reports cumulative `voxelCacheHits` and `voxelMeshBuilds` for the current view.
- **A sprite the game shows is never missing.** A page's sprite layer is built from its indexed page (about 2 MB)
  and its HD art (about 50 MB, 67 M pixels); the layer used to wait for both, so a building placed on a page nothing
  had drawn from yet had no picture at all until the HD art was decoded and uploaded (measured before this rule,
  cold start: 46 and 47 presented frames for a construction yard and a refinery on a quiet machine, 25.8 s for the
  refinery on a loaded one; infantry 10 s after a view shown by the deadline). A **shown** view now draws such a
  page's sprites through the page's indexed layer (the one that already draws art which is always indexed) and
  moves them to the final layer in the flush that builds it (`LiveView.flushSprites`): the records are the same
  (anchor, frame rectangle, palette row with the house colours, depth profile) and both layers place a frame by
  the indexed atlas's pixels, so nothing moves or changes size. Live overlays and smudges do the same with their
  own layers (built from the indexed page, rebuilt once with the HD art), a first layer no longer waits for a
  night map's lit-window mask, and an anim whose redrawn page is still loading is drawn from its own art. Out of
  sight nothing is drawn early: the page counts as art on its way, as before.
  A change of state can move an object onto another page (a build-up on one page and the body on the next; damage,
  a sale, a door, a production layer; a soldier whose sequences span two pages). Every page of an object's type is
  fetched as an indexed page when the object first appears, and while a page is still missing the object keeps its
  last complete picture in place instead of losing its body (`live/heldPicture.ts`).
  What can be known before an object exists is loaded before it exists (`LiveView.prepare`): the bridge hands over
  the types the sidebar shows as being produced, queued or waiting to be placed (`sidebarUpcomingTypes`; the
  reader reports the cameos of the tab on screen), the view prepares what the map cache lists as placed on the map
  when it is created, behind the loading screen, and what a vehicle deploys into when the vehicle appears (rules
  DeploysInto is not in the library: `live/artAhead.ts` holds the four stock pairs). Their pages are fetched whole
  and their layer is built one page per frame before the first sprite is drawn from it (three r186 builds the
  shaders of a layer's main pass in the first frame the layer is in the scene, whether or not it has instances:
  `Renderer._renderObjectDirect` updates the pipeline before the draw that an empty mesh skips); a vehicle's model,
  mesh and projection are prepared in the local player's colours. All of it is loaded "ahead"
  (`LiveLibrary.preloadPage`): it does not count as art on its way and does not delay the view being shown, and
  the uploader copies pages that are waited for before pages loaded ahead, the smallest first, so an indexed page
  does not queue behind the HD pages decoded before it. The decode gate in front of the uploader (`PageGate`, which
  bounds the decoded pages in existence) follows the same rule: first come, first served among waited-for pages,
  and a page loaded ahead takes its turn only when no waited-for page waits; the library's per-page upload carries
  the view's gate and the page's "loaded ahead" answer to both.
  The indexed stand-in layers draw with shader graphs of their own. Final foreground layers use their HD page
  when available; shadows and inclusive source-shadow body frames retain the indexed page. Building bodies,
  bibs, build-ups and animation layers use HD even when their art says `Remapable=no`: the engine remaps every
  building to its current owner's scheme, including Neutral. Encoded grey paint in the HD mask keeps its redraw
  shading; where a page has no mask or contains baked coloured paint, `indexedHousePaint` recovers the owner's
  ramp from the indexed source. Types without source house-colour pixels keep their full HD colour. This flag
  shares the existing map-grade attribute, survives held pictures and is reset when a pooled sprite is reused.
  A graph's first layer costs six shader builds in the presenting thread plus
  pipelines that are compiled off the frame, during which the layer draws nothing. The same holds for a final
  layer that is the first of its look in a shown view (HD art with or without a material page, with or without a
  lit-window mask): measured in a live match with the type library's HD pages 90 s late, conscripts were not drawn
  for 15 presented frames when their HD page replaced the stand-in and an overlay page for 0.65 s, and in a
  six-player match a page's first layer of a new look cost 0.2 to 0.4 s without its objects two and a half minutes
  in. `LiveView.warmStandIns` keeps one hidden, empty layer of each such graph in the scene: a library page's
  sprites from the indexed page with the capture code, the same with the lit-window mask on a night map, a live
  overlay or smudge page from the indexed page, and, for every look the library's HD pages can have
  (`LiveLibrary.hdPageLooks`, read from the library's records without loading a page), the final layer of a page
  and of a cell page without and with the material page (and with the mask at night). The warm frames behind the
  loading screen (`HdRenderer.warm`) build and compile them, so a layer made during the match is a clone of
  materials that are ready; a graph the opening builds anyway is not built twice
  (`packages/hd-renderer/tests/liveStandInWarm.test.ts`). Cell decorations are not announced by anything (rubble, a
  crater, a crate), so the indexed pages of the overlay types that are not walls and of every smudge type, three
  small pages, are fetched when the view is created (`cellArtPages`). What still has nothing to draw from is the
  first frames of a building, infantry or SHP-vehicle type that nothing announced (an object the engine creates in
  view without a production: its indexed page is then fetched, decoded and uploaded while it stands there; keeping
  every type page resident would close it at about 380 MB of GPU memory per theatre) and an effect whose own page
  is not in.
- **What the last match showed is prepared behind the loading screen.** The bridge stores the kinds of object of a
  match's first five minutes in `localStorage` (`src/ui/pages/game/hdWarmStore.ts`: rules type, engine image, colour
  scheme and whether a civilian house owns it; never positions or counts): one list per map, and for maps not
  played yet one per theater and one for all theaters, both without civilian objects. While the next match loads,
  `LiveView.warm` draws one object of each kind (a building twice: standing and under construction) at the middle
  of the map through the normal snapshot path, so exactly the art a match would load is fetched, built and compiled
  before the first frame. A list that is not through when the scenario's first objects appear (a second or two
  before the match runs) stays alongside them, in the middle of the hidden view, until it has been drawn completely
  or the logic frame moves on. A list that does not fit (another side or colour) costs only the art it loaded: the
  view still waits for what the match really needs.
- **No compiler in a shown frame.** Art that differs only in data shares one shader (the renderer README's "Frame
  cost" section): a new sprite page, palette, house colour or unit type builds none. What does have to be built is
  built out of sight: the view draws warm frames behind the loading screen and again when the opening's art is in
  (`HdRenderer.warm`: everything that exists, hidden or not, in every pass and for both forms of the post graph,
  with mist and without; the top-layer pass joins the graph then), render pipelines are compiled asynchronously (`HdRenderer.enableAsyncPipelines`; `?hd-pipelines=sync`
  keeps three's own behaviour), and the view counts as complete only when no warm frame is due and no pipeline is
  still compiling (`LiveView.settledFrames`). In a shown view a pipeline that is new after all (a unit type's first
  appearance, a blend state not met before) delays that object by the time its compile takes (0.3 s typical), not
  the frame.
- **No post-pass rebuilds.** The game shows its loading screen in 800x600 and switches to the match's video mode half
  a second before the first logic frame; a view laid out for the loading screen rebuilt every post material at that
  moment. The bridge remembers the layout the view was last shown with and prepares with it while the frame size is
  still the loading screen's. The top-layer effect pass stays in the post graph once the first top-layer art has
  shown (it used to be added and removed with every such anim, rebuilding the post chain each time) and is given to
  the view before it is shown when an earlier match had such art. The frame renderer compiles its key programs when
  the bridge starts (`VmFrameRenderer.prepareTransparentKey`), not inside the frame that first shows the view.

`__hdBridge.timeline` (console) reports, in `performance.now()` milliseconds, when the current match's view loaded,
was handed a list, first drew it completely, saw the first objects and the first logic frame, and began and ended
the live-picture cross-fade. The only reveal reason is `settled`.

In development, `__hdBridge.diagnostics` exposes the current `enabled`/`shown` flags, a detached copy of the last
delivered render `state`, cumulative `counters`, and read-only `getCommandState()`, `getGamePerformance()`, `getPointerState()` and
`getVmDiagnostics()` probes. `startCapture()` begins a bounded browser-clock capture; `finishCapture()` freezes it
and returns its duration endpoints, counts, state-arrival `deliveries` and completed-render `draws`. Both methods
and the `capture` getter return detached copies. A distinct state is a changed map/logic-frame identity at reply
arrival, including replies that reuse unchanged map-cell layers; repeated replies for the same frame do not count.
Draws are counted after `LiveView.render()` returns, with a `shown` flag separating preparation from the displayed
HD view, rather than counting display callbacks. Each timestamp array retains at most 20,000 records; counts keep
advancing and `truncated` reports an exceeded bound. `counters.firstDrawAtMs` includes hidden preparation;
`firstShownDrawAtMs` is the first completed HD picture made visible. Both use `performance.now()` from page
navigation, independently of game startup or map loading. Capturing or reading these diagnostics does not inject
input or change the game's clock, speed, resources or rendering policy.

`diagnostics.captureNextDraw()` requests a one-shot readback of the next actual presented HD canvas draw. In the
same task immediately after the normal `LiveView.render()`, it takes three r186.1's actual WebGPU current canvas
texture (already configured with `COPY_SRC`) and submits a copy to one owned `COPY_DST | MAP_READ` buffer. Mapping
then completes asynchronously in GPU queue order. It does not render another frame, reconfigure the canvas,
preserve the drawing buffer, or modify textures, art or postprocessing. Only RGBA8/BGRA8 unorm formats and their
sRGB variants are accepted; aligned rows are removed and BGRA bytes are swizzled without changing colour or alpha.
The detached RGBA result carries the draw timestamp, native source frame and combat-state subset, camera view,
map, native size, actual tactical rectangle and passthrough flags fixed at that draw. Normal LiveView interpolation
continues and is explicitly named in the result. A Backslash trail draw may correctly report `shown=false`.
Readback accepts at most ten million pixels, a 48 MiB aligned buffer, and one pending request/buffer; another
request, unsupported backend/format/usage, failed mapping or a ten-second timeout rejects. Bridge stop or view
replacement rejects the request and destroys its buffer; late mapping replies cannot revive the session. The
generic ownership and byte-copy mechanism lives in `src/graphics/webGpuFrameCapture.ts`; only the development
bridge exposes the diagnostic, and ordinary diagnostics do not include image bytes.

`diagnostics.combatState` is a detached, narrower copy of the last delivered state for repeated combat observation:
logic `frame`, camera `view`, local-player `shroud`, sidebar frame and tactical bounds, and bullets, lasers, electric
bolts, radiation beams, waves and up to 8192 real animation instances, with `effects.animsTruncated` identifying an
exceeded bound. This detached animation metadata is also fixed in a captured draw's state. The generic bridge does
not classify game-specific animation types or synthesize firing state. It excludes objects, map-cell layers, sidebar
cameos and particle systems, avoiding their copy cost without issuing another render request. Null or unavailable fields remain null or
absent; visibility and in-view tests use the same native coordinates and shroud as the complete `state` getter.

Measured with the same skirmish starts (test Chrome, the frame times of the first 20 seconds after the first logic
frame): on XMP29U2 the base build had 12 to 15 frames over 100 ms, the longest 2.8 to 3.1 s. Now matches after the
first show the HD view with the first logic frame and no frame over 62 ms in five of six runs (the sixth had one
frame of 0.23 s while the page's own thread was idle). A first match without any stored list shows the original
picture for 2.7 s and then the complete HD view with no frame over 82 ms in the best run; with other WebGPU pages
running on the same machine it took 3 to 12 s, with frames of 0.1 to 0.8 s in between (see the limits). On the
largest skirmish map (XMP20T6, 277 x 277 cells; base: 11 frames over 100 ms, the longest 2.8 s) a first match on the
map shows the HD view after 0.9 s with four frames of 0.2 s before it, later matches after 0.0 to 0.7 s with at most
one such frame.

Limits:

- A view's own load (`LiveView.create`: the map's terrain, masks and distance fields, partly on the presenting
  thread) takes 2 s on a small map and 4 to 5 s on the largest; it normally ends 4 to 9 s before the match runs. If it
  ends later (a slow disk, a busy machine), the list is not through when the match runs and the rest is prepared
  behind the original picture.
- A shader graph that no art has used yet is still built in one piece on the presenting thread (5 to 25 ms each;
  a sprite graph has six passes). Warm frames cover the graphs that exist when the view is prepared; a graph first
  needed later (a page with a feature combination not seen before) costs such a frame in the shown view. Meshes are
  built off the presenting thread and pages arrive in strips.
- Uploads wait for the GPU process. Next to other pages that load the same GPU, single strips were seen to block for
  0.1 to 0.6 s, and the preparation of a first match without a list, which is paced by frames, took that much
  longer.
- The top-layer pass is remembered per browser profile, not per match: its first use ever still rebuilds the post
  passes once.

## Frame rate

The shown view is held to at most 60 drawn frames a second, also on a faster display, and to fewer while the game
is behind its speed setting (see "Frame pacing" below). Its frame intervals feed a `QualityGovernor` (`packages/hd-renderer/src/qualityGovernor.ts`): every half
second it judges the last second of frames (their mean interval without the longest twentieth); over budget the
renderer gives up its least visible work one tier down (`HdRenderer.setQualityTier`: first what reads a copy of the
frame, the heat shimmer and the display-space colour mix of translucent engine effects, then the soft edge of unit
shadows), far over budget it goes straight to the last tier, and after a calm stretch it tries one tier up again,
waiting twice as long after a trial that fails. No tier changes a resolution or the outline pass: sprites and
terrain stay texel-exact and outlines smooth. Every tier draws the same passes: a change of tier builds, compiles and
allocates nothing. The play toolbar's HD button reads `画面：高清 · 减负 n/2` while a tier above 0 is in use
(`RuntimeToolbar.setHdQuality`); `?hd-governor=0` keeps every pass whatever the frame rate.

Outlines are smoothed without multisampling: the scene pass writes a silhouette code per object and the frame's
last pass rebuilds the outline between pixels of different codes (`packages/hd-renderer/src/silhouette.ts`, the
renderer README's "Outlines"). Pixels inside an object and on the ground are copied unchanged.

Measured with the base this work started from (the same staged skirmish battle on XMP29U2: about 270 objects with a
hundred vehicles in view and 80 to 100 engine animations, 3120x2096 drawing buffer, test Chrome on an Apple M-series
laptop): 23 to 26 frames a second before; 38 to 44 with every pass (tier 0, governor off); 57 to 60 with the
governor, which settled on tier 2 for the fight. At the skirmish speed slider's 5 (`game-speed=1`, 60 logic frames a
second) the emulator reached 59 to 63 logic frames a second under the HD view in that battle: the view's own work
per logic frame is about 1.3 ms (snapshot push and object update).

Measured again after multisampling was replaced by the outline pass (same staged battle at the slider's 5, same
machine, no other session on it): with every pass (tier 0, governor off) 54 to 56 frames a second in the first twelve
seconds after the battle is revealed (about 300 objects, 140 engine animations and 720 to 750 draws; 1 % low 42 to 45) and 60 from then on (1 % low 47 to 55); with the governor 55 to 58 in the first twelve seconds and 60 from then
on. The opening seconds are bound by the main thread, not by a pass a tier can give up: the view's own work is 9 to
11 ms a frame there, 6.5 to 9 afterwards.

### Frame pacing: the game's speed comes first

Every frame the HD view draws is taken from the game's speed. The emulator runs on a Worker thread, and the browser
schedules that thread below every thread that takes part in drawing: in the test browser on macOS the Worker runs at
priority 37, the page's main thread and the GPU process's threads at 47 (`ps -M`). While the view draws, the
emulator executes the same guest code more slowly: it does not get less work, it gets less of the machine. Measured
on the build before the pacer (`8532d5c`), a natural six-player skirmish at the slider's 5 (62.5 logic frames a second
asked for), about 260 objects, 1728 px wide game at two device pixels per game pixel, a headed test Chrome on a 120 Hz
laptop display, mouse moving, the map scrolled every second and band selections made (12 s windows of one match):

| HD view                                   | drawn frames/s | logic frames/s | guest instructions per ms of CPU loop | emulator thread idle |
| ----------------------------------------- | -------------- | -------------- | ------------------------------------- | -------------------- |
| every display frame (main thread at 99 %) | 81 to 93       | 39 to 41       | 145 to 149 k                          | 0 %                  |
| every second display frame                | 60             | 55             | 213 k                                 | 5 %                  |
| every third                               | 40             | 62             | 261 k                                 | 19 %                 |
| every fourth                              | 30             | 62             | 265 k                                 | 25 %                 |

The guest executed 2.6 to 2.8 million instructions per logic frame in every row, and exactly one native render per
logic frame (one `IDirectDrawSurface::Blt` of the frame, one key-colour fill): the mouse, scrolling and selections
add a few percent of guest work, not a second render. With the view's drawing switched off and its snapshot polls
and the native frame snapshots left running, the emulator ran as fast as with the tab hidden; a main thread that
merely burned 15 ms of CPU per frame without drawing cost nothing; a smaller drawing buffer or a lower quality tier
changed nothing. What costs is the per-frame work of the WebGPU view itself (the scene traversal on the main thread
and the several hundred draws the GPU process decodes), so only fewer frames give the time back.

`FramePacer` (`src/graphics/framePacer.ts`, used by `hdBridge.ts`) therefore decides for every display frame whether
the shown view draws it:

- It holds the view to a frame rate in whole display frames, by the time since the last drawn frame (within 10 %):
  at 60 a 120 Hz display draws every second frame and a 165 Hz display every third (55 a second); a 60 Hz display
  draws every frame. No display rate is configured.
- Once a second while the view is shown, the bridge asks the emulator for its counters (`getDiagnostics('usage')`,
  one request on its thread) and hands the pacer what the game reached: its logic rate against the rate its speed
  setting allows (`GameFrameCounters.targetFps`) and the share of its thread it spent in waits it asked for. Behind
  the setting (below 95.5 %) on two samples in a row: one level down, 60 to 40 to 30 (straight to 30 when the game
  is below 80 % of its rate); the game's limiter never catches up a late frame, so it can be behind while its thread
  still waits a tenth of the time, and only a game that mostly waits (a paused one) is not behind whatever its rate. Holding the setting with a tenth of its thread idle for eight seconds:
  one level up is tried; if the game then falls behind, the level is given up at once, the wait before the next try
  doubles (up to two minutes) and that level asks for more idle share before it is tried again. A game without a
  limited speed setting (the fastest setting, a network match) has no rate to protect: the view stays at 60.
- Native-host sessions use `getGamePerformance` and differences of the game's own frame counter and its
  `sampledAtMs`, rather than an emulator diagnostics timestamp or wait accounting. Drawing does not share the
  native game's scheduler: while those counters hold its target the view stays at the display cap, and after an
  actual deficit it returns to the cap as soon as the target is held. Only a counter rate below the same 95.5 %
  threshold on two consecutive samples permits a lower level; missing or unlimited targets keep the cap.
- While the native HD bridge is enabled, state polling runs independently of display callbacks, view loading and
  draw pacing. One request starts immediately; subsequent requests start no sooner than 1/60 second after the
  previous start, with at most one request outstanding. Disposal cancels the timer and late replies cannot restart
  it. A display callback may take an already due request before drawing delays its timer; it cancels that timer,
  obeys the same minimum interval and outstanding-request guard, and leaves the independent timer as a fallback.
  Early timer callbacks rearm without reading, and a canceled callback cannot replace a newer timer. No missed
  polling slots are caught up in a burst. Native performance sampling also uses either polling opportunity while
  the HD view is shown. Display callbacks still own
  drawing and art reveal; only complete settled frames can begin the live-picture cross-fade. The match timeline
  records first state arrival and passthrough request/acceptance separately from art readiness and reveal.
- Emulator snapshots are polled no faster than frames are drawn (each one is read on the emulator's thread), and the
  frame-time safeguard above judges a view that is held to fewer frames by the interval it is held to, not by the
  60 it would otherwise have to reach.

Measured with the pacer against the build before it, same machine, display, match kind and input script, one
session at a time (the hidden reference is the same page with its animation frames held: no HD drawing, no polls, no
frame acknowledgements):

| Scene (objects)                                 | before: logic frames/s (HD frames/s) | with the pacer (HD frames/s)       | hidden reference |
| ----------------------------------------------- | ------------------------------------ | ---------------------------------- | ---------------- |
| natural six-player match (240 to 272)           | 42.8 to 59.2, mean 51.5 (72 to 100)  | 57.8 to 61.6, mean 60.5 (40 to 58) | 62.4 to 62.5     |
| calm two-player match (73 to 89)                | 62.4 to 62.5 (119 to 120)            | 62.5 (58 to 59)                    | 62.5             |
| staged battle at six bases (435 to 445)         | 32.1 to 40.9 (62 to 75)              | 32.0 to 42.7 (30)                  | 57.1 to 62.1     |
| staged battle at six bases, larger (514 to 559) | 33.8 to 37.5 (51 to 55)              | 19.0 to 45.3 (30)                  | 51.1 to 61.3     |

In the staged battles the guest's own work decides the rate (5 to 16 million instructions per logic frame, different
in every window, so their logic rates do not compare window to window); what the pacer changes there is the
emulator's throughput under the same input, 264 to 307 thousand guest instructions per ms of CPU loop before and 306
to 357 with it (354 to 403 hidden). What is left of that gap is the view at 30 frames a second, the snapshot reads
(5 to 7 % of the emulator's thread) and the rest of the page's drawing at the display rate: while the mouse moves
the native frame is snapshotted and presented up to 106 times a second on the 120 Hz display against 62 native
renders. Holding every animation callback of the page to 60 a second, holding only the frame acknowledgements to
60, or switching the interface layer off each measured 3 to 6 % more throughput, within the spread between two
windows of the same case; none of it is done.

`?hd-pace=<rate>` holds a fixed rate (10 to 240; `cap` is 60) whatever the game does, and `?hd-pace=off` draws on
every display frame as before the pacer existed, both for measurements. `__hdBridge.pace` shows the mode, the level,
the rate and how many display frames lie between two drawn ones; the speed telemetry's records carry the rate as
`hdPace`. The native picture over the view (sidebar, radar, selection brackets, health bars, text), the HD interface
layer and the cursor are not paced: they keep their own rate.

**The original picture under the HD view.** With native overlay passthrough (the default) the frame renderer draws
the game's frame in one keyed 1:1 pass (`vmFrameRenderer.ts` `drawKeyed`) plus the smoothed region, the punched
rectangle and the cursor. The page's own picture options (bicubic, FSR and ScaleFX upscaling, the AI models, the
ReShade pass) are not run in that path; they apply again when the original picture is shown (`\` or the toolbar
button), and the toolbar says so next to an option that is switched on. Without passthrough
(`?hd-passthrough=none`) the frame is drawn as usual and the tactical rectangle is punched out of it afterwards:
those options then run for the whole frame.

## Object occlusion

`ra2/painterOrder.ts` separates the object's tactical painter order from its screen placement and `cardPush`.
The YR reader publishes optional `renderOrder { layer, index, ySort }` from the five native layer vectors;
registered objects retain their actual traversal order, including equal-key registrations and locomotor-specific
air layers. Ground insertion compares `GetYSort`: ordinary units use raw `Location.X + Location.Y`; buildings use
`Location.X + Location.Y - 256`, plus 32 for `TurretAnimIsVoxel` and minus 16 for `Gate`. Neither altitude nor
foundation dimensions enter this key. The building's drawing centre and art offsets are separate coordinates.
YR 1.001 evidence: `GetYSort` at `0x5F6BD0`, building position at `0x459EF0`, building override at `0x449410`,
layer traversal at `0x6D8DB0`; the layer vectors start at `0x8A0360` with stride `0x18`.

Traversal breaks near-equal depth ties with a bounded camera-space bias; it never assigns a global NDC band.
With an extracted native depth template, building fragment depth uses signed `BUILDNGZ.SHA` corrections and native
frame baselines, while attached building parts inherit the owner's template. Ground SHP units use native upright
card gradients. Ground voxel units approximate the native projected bitmap bottom with posed bounds, retaining
six percent of physical depth for internal face ordering. A harvester receives the native card bonus only while
its current cell belongs to a refinery foundation. The previous contact-based dock pull and propagation are
removed; `contactUid` and `dock` remain optional state metadata. Buildings without a template retain the analytic
foundation fallback. Flight, shadows and bridge-deck geometry retain their existing paths. Full formulas and
approximation bounds are in [Native Z model](research/painter-order.md#native-z-model).

During effective Unload mission, completed buildings report `unloading: 'door' | 'roof'`. When both matching art
layers exist, the deploying image/shadow replaces the body, then the healthy/damaged under-door card follows.
The replacement persists through radio link release and logical door closing, until effective mission 16 ends;
native `buildingFrame` keeps the body stage and damage offset instead of restarting at Unload. Logical door
progress does not animate this replacement SHP. The native inclusive cap uses the source `frameCount / 2`
rounded down (foreground plus shadow array lengths when legacy metadata is absent). It can select the first
source shadow-half frame at its boundary, rather than the last foreground frame. Queued Unload alone does not open the
door unless CurrentMission is -1. Missing art pairs retain the normal body. LiveView draws the pair one logic frame
after the published state, at both ends: the image of a frame is the `unloading` value of the first publication of
the previous logic frame (see [Presentation phase](research/painter-order.md#presentation-phase-of-discrete-state)).
A YR reader instance latches a
published roof during the same
continuous effective Unload and reuses it only for NULL link 0; unreadable roof state still omits `unloading`.
It resets when the mission leaves `16`, the building disappears or its UID/type pointer changes, pruning entries
not seen in the latest read. This retained roof is a compatibility policy from supplied observations; the native
DrawIt null-contact branch alone selects ground delivery. The replacement body uses native Z adjust -20 for door
or -40 for roof delivery, and both under-door interiors use ground gradient k=1. No measured recess or rectangular
infantry-hide workaround remains; opaque body posts and the ground interior have their own fragment depth.
Supplied frozen native GAWEAP `5x3`, NW `(58,98)`, SHAD frames show: `9171` (mission `5`, queued `16`, link SHAD,
Z `208`) closed; `9184/9208` (mission `16`, link SHAD, Z `208`) open with heli parts inside; `9235` (mission `16`,
link NULL, Z `368`) still open as the heli rises. The latch fixes the released-link selection. `9278` (mission `5`,
link NULL, Z `798`) is still open natively for an unexplained reason and remains `UNVERIFIED`, outside the latch;
`9342` is closed in both. These are supplied observations, not a new HD runtime acceptance run.
Native field/address evidence and the accompanying factory
trace are in [Painter order research](research/painter-order.md#contacted-dock-pull-and-delivery-images).

Ground decals, ore and shadow transforms retain their existing paths. The separate geometry-depth attachment
keeps mist and shroud independent of the card's analytic occlusion depth. Older snapshots retain the Ground-key
fallback and terrain-relative flight layer; exact ties and unusual locomotor layers without native metadata remain
unverified. Ground effect cards use physical depth and a small tie bias. Air/Top effect cards retain their existing
pass policy; voxel missiles/debris use a bounded Air bias because the bridge does not yet publish their registration.

Ordering is refreshed only for snapshot/registration, art, cell or visibility changes. Interpolation reuses card
order and updates poses; it does not rescan or rewrite static trees, cells, overlays or effects. Particle cards own
a separate anchor pool. Same-frame publications replace discrete object/effect state and the current pose endpoint
without restarting its timestamp or replacing the previous interpolation endpoint. The reader's change key includes
native animation stages, health, occupancy and effect instance state: a logic frame number is not a render revision.
Techno art is not culled by its anchor's shroud cell; the common pixel mask clips revealed roofs and vehicle edges.
See [native presentation evidence](research/native-presentation.md) for the pinned draw paths and damage-body rule.

Synthetic depth and draw-eligibility regressions do not establish live WebGPU pixel parity. Template-edge clipping,
the ground-voxel approximation, special locomotors and individual `ZAdjust` interactions still require live
comparison. See [tactical occlusion research](research/painter-order.md)
for verified read/write blitters, addresses, formulas and the precise limitations. CPU regressions do not establish
WebGPU execution or same-moment original-art parity.

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

A map is HD-playable when the served cache has a directory with the scenario's file name without its extension
(case-insensitive; a `.yro` package's scenario carries the package name) holding `manifest.json` and the files it
names: the terrain tile atlas, the indexed sprite atlas of the map's own trees and other map sprites with its
optional 2x HD atlas and house-paint mask, palettes, map voxel models and the whole-map terrain composite with its
water mask. Everything else is shared and bound by the manifest's `theater`: units, buildings, overlays and smudges
come from `_library/<theatre>/` (`library.json` and its sprite pages with their HD pages), effects from
`_library/common/effects/`, the interface from `_ui/`, vehicle redraw projections from the directory named by
`hd-vproj`. The optional sidecars (`materials.json`, `lights.json`, `windows.json`, `normals.json`) refine one map
and are not required. To serve many prepared maps at once, build a symlink farm over an existing cache with
`packages/ra2-assets/python/play_farm.py` (see the asset tools guide) and point `RA2_HD_CACHE_DIR` at it.

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

The offline L5 ore/gem pipeline is `packages/ra2-assets/python/ore_fields.py`: `extract`, `build`, `install` and
`sheet` use explicit source/cache/output paths. It writes 68x46 decals, four atlas PNGs and frame metadata;
installation preserves other library entries under a compose lock. Commands and defaults are documented in
[the asset tools guide](../../packages/ra2-assets/README.md#ore-and-gem-field-redraw-python-experimental).
Game art and derived images remain outside Git.

## Running it

Start a development server whose game root holds a skirmish setup (a scratch copy of the installation with an edited
`RA2MD.INI` `[Skirmish]` section, as described in `scripts/remaster/perf/README.md`), then open
`/?start-page=battle&hd=1`. By default the HD lighting follows the map's own `[Lighting]` (the engine's cell light on
every map; day, dusk or night staging, see `pnpm hd:lights`); `hd-time=<hours>` overrides the hour. Decorative weather is off by default;
`hd-weather=rain|snow|storm` enables it, with optional `hd-weather-intensity=<0..1>` (default 0.8 for rain/snow,
1 for storm; finite values are clamped, invalid intensities use the default, unknown weather selects clear).
Snow stays dry and ground weather excludes building foundations and steep cells.
`hd-look=<preset>` (`faithful|golden|cinematic`)
applies the preset and its suggested hour unless `hd-time` is given (authored dusk maps keep their own hour; night
maps are day maps with night dressing and take it; `cinematic` is the approved look with medium cooling); `hd-fx=enhanced` selects the enhanced effect style (point 4); `hd-water=enhanced` the modern water
(on maps staged as dusk or night, water keeps the tone the map paints it in under either setting; see the water notes
in `packages/hd-renderer/README.md`);
`hd-vlook=remaster` selects the remaster voxel look; `hd-vproj=<dir>` selects vehicle redraw projection atlases under
the HD cache (e.g. `vehicles-hd`); `hd-rect=x,y,w,h`
overrides the tactical rectangle (default: the frame minus YR's 168 px sidebar and 32 px command bar).
`hd-governor=0` switches the frame-rate safeguard off, `hd-pace=<rate>|cap|off` replaces the frame pacer's own
choice of rate, and `hd-pipelines=sync` switches the asynchronous pipeline compiles off (see "Frame rate" and
"Match start").

## Display scale

The HD art has two texels per game pixel, so it is only shown texel for pixel when one game pixel covers exactly two
device pixels. Any other scale resamples every texel: a 1152x744 game filling a 3456x2160 screen stretches the art
1.45 times, and a window with a device pixel ratio of 1 shows no more pixels than the original.

- `?resolution=display` (toolbar: "match window") computes the game resolution at every start from the stage the
  canvas is fitted into: half its device pixels, even numbers, within `GAME_RESOLUTION_LIMITS` (`src/games/resolution.ts`:
  the 800x600 the shell pages are laid out for up to the 2560x1600 the display-mode shim accepts); a stage too small
  for two device pixels per game pixel uses one. It is the default for `?hd=1` while the player has never chosen a
  resolution, and is passed to the game as the usual in-memory INI overlay. `?resolution=WxH` requests any size within
  the limits, `?resolution=ini` the game's own INI; the parameter wins over the stored toolbar choice for that page load,
  and choosing in the toolbar removes it from the address.
- The size is measured once, when the game starts: put the window in its final state (maximised or fullscreen) first.
  The canvas fit then shows a display-matched frame at whole device pixels per game pixel (`calculateCanvasFit` with
  `integerScale`), leaving a border instead of resampling; the toolbar shows the frame size and scale under the
  resolution and suggests a reload when a matched frame no longer fits its window. The shell pages keep their own
  800x600 frame and are shown at their own whole scale.
- The HD canvas and the HD interface canvas are laid out on whole device pixels with one drawing-buffer pixel each
  (`devicePixelBox.ts`, `LiveView.resizePixels`), up to a budget of 10 million pixels; the device pixel ratio is not
  capped. Interpolated scrolling stays on the drawing buffer's pixel grid (`snapToPixelGrid`), and post passes whose
  radii are given in view pixels follow the device pixels per game pixel (`HdRenderer.setBufferScale`).

`scripts/remaster/play.sh` (or a double click on `scripts/remaster/play.command` on macOS) starts the development
server and opens the HD page with the approved look, `resolution=display`, `game-speed=3` (the original scale's normal
speed; the page's own startup default is the fastest, see
[the startup configuration](../RA2_COMMAND_LINE_AND_SPAWNER.md#current-startup-configuration)) and the skirmish setup as
the first page; `--original` opens the original picture without the HD bridge, `--train` opens the practice lessons
([Practice lessons](TRAINING.md)), `--print` only prints the address. It
reads the player's game from `RA2_GAME_ROOT` (default `game/`), the HD cache from `RA2_HD_CACHE_DIR` (default: the
newest play cache under `gameres/` that holds `_library/`) and the starting speed from `RA2_PLAY_SPEED`, and names
the stall log for the development server in `RA2_PERF_LOG` (default `gameres/s2x/play/perfmon/stalls.jsonl` under
the main checkout; `0` for none).

Both owner launchers select `sr=1`: single-pass anti-ringing Catmull-Rom reconstruction for original menus,
dialogs and the original-picture view. It preserves exact source pixels at 1:1 or when shrinking, and leaves the
HD view's keyed overlay path unchanged. The toolbar can switch reconstruction off for comparison.

## Stall recorder

A hitch a player reports cannot be looked into from outside the browser, so the HD page records its own. The bridge's
frame loop reports every animation frame to `src/ui/pages/game/hdStallMonitor.ts` (loaded behind
`import.meta.env.DEV`, like the interface layer); the generic parts are in `src/utils/stallRecorder.ts`. A frame
more than 150 ms after the one before it is a stall. An ordinary frame costs one subtraction and one comparison;
everything below happens only when a frame is late.

A record holds the wall-clock time, the gap, whether the tab was visible and whether it was hidden at some time
during the gap, the map, the logic frame and the measured logic rate, whether the HD view was shown, and what the
view was busy with (`LiveView.activity`): atlas pages still being uploaded, voxel meshes and projections on their
way, everything still loading, the shader modules and render pipelines the frame before the gap had the backend
create (`packages/hd-renderer/src/compileCounter.ts` wraps the two backend calls three r186 makes only on a cache
miss, so nothing is counted per frame), and the kinds of object whose first visual that frame built. Long tasks
(`PerformanceObserver`, where the browser has it) tell whose stall it was: `cause` is `main-thread` when long tasks
cover at least half the gap, `not-delivered` when they do not (the page's thread was free and the frame still did
not come: GPU process, compositor, another process), `hidden` when the tab was, and `unknown` without the observer.
The last 500 records are kept (`__hdBridge.stalls` in the console).

Two sinks. The development server appends records as JSON lines to the file named by `RA2_PERF_LOG`
(`POST /__perf/stalls`, `src/server/perfStallLog.ts`: same-origin JSON only, 256 KiB at most, each line written from
the parsed record with the time it was received); without the variable the route answers 404 and the page stops
posting for the session. The page posts new records in batches at most every five seconds (`fetch` with
`keepalive`), hands the rest to `navigator.sendBeacon` when the tab is hidden or the page goes away, and does not
retry a refused batch by itself: it goes out again with the next stall. The toolbar shows one line for the current
match, "卡顿 N 次，最长 X 秒" (`RuntimeToolbar.setStalls`): stalls while the match ran and the tab was on screen.
Native-host sessions keep the same local records and toolbar counters with `endpoint: null`; they do not probe
the emulator development-log route or send a beacon. An omitted endpoint retains the emulator's server sink.

## Snapshot cost on the emulator's thread

A snapshot is read on the thread that runs the game, so its time is taken from the game's logic rate. Measured
with the usage accounting below and a CPU profile of the VM worker in a staged six-player battle (about 500
objects, the game far behind its speed setting): one full read took 4.8 ms, of which the shroud walk (every cell of
the map) 2.0 ms, the change key 1.1 ms and objects 1.6 ms, and the page's 60 polls a second found half-updated
objects in the middle of every logic frame, so there were 2.6 full reads per logic frame: 17 to 20 % of the thread.
Three rules of the YR reader (`src/games/yr/renderState.ts`) keep that down; what a snapshot says about objects and
effects once a logic frame is complete is unchanged:

- one look per logic frame: a poll that finds the logic frame, the scenario and the view position of the last
  snapshot gets that snapshot back (five words read) until `YR_SAME_FRAME_REREAD_MS` (100 ms) have passed since the
  last look; then the change key decides as before. A new logic frame and a moved view (scrolling) are read at once,
  and a game that stands still still shows a same-frame change within a tenth of a second;
- the shroud is read every `YR_SHROUD_POLL_MS` (250 ms, the cell layers' cadence) instead of with every snapshot;
  the game keeps no counter for shroud changes, so the mask the view draws trails the game's by at most that long
  (about one cell of a fast unit), and a new battle or a shroud that was unavailable is read at once;
- the change key hashes its words from a 32-bit view of guest memory when the accessor has one
  (`GuestMemoryAccessor.words`): the same values in the same order as before.

The decoding itself still runs on the emulator's thread. Moving it to another thread needs the raw bytes there
first: guest memory is never shared across threads (docs/ARCHITECTURE.md), and the readers follow pointers through
the whole heap (objects, their types, cells, effects), so a copy step would have to know those ranges before the
decode that finds them.

## Game-speed telemetry

The picture says little about whether the game in the emulator keeps up with its speed setting, so "it feels
slow" has its own measurement. In development the play page (with or without the bridge) loads
`src/ui/pages/game/speedTelemetry.ts` behind `import.meta.env.DEV`. Every five seconds it asks the VM once
(`VmShell.getDiagnostics('usage')`) and turns the difference from the previous answer into one record:

- `logicFps`: logic frames the game advanced a second (the native frame counter against the VM thread's clock);
  `targetFps`: what the current speed setting allows, from the game module (`GameFrameCounters.targetFps`; for YR
  1.001 `src/games/yr/performance.ts` reads it off the frame limiter: 62.5 / GameSpeed in a campaign or skirmish,
  so 62.5 at the skirmish slider's 5 and 20.8 at its 3; `uncapped` at the fastest setting; unknown in a network
  session). The setting is read at every sample, so moving the in-game slider shows in the next record;
- `presentedFps` (game frames the page presented), `hdFps`, `hdShown`, the HD view's quality `tier` and `hdPace`,
  the frame rate the view was held to at the end of the window (see "Frame pacing");
- `objects` / `localObjects` and `map` from the bridge's last snapshot, `resolution` of the game frame, `gameSpeed`,
  `logicFrame`, `visible`;
- `hypercallsPerS` and `vm`: where the emulator's thread spent the window, in percent (`VmUsage` in
  `src/adapter/vmDiagnostics.ts`): `guestPct` inside the CPU loop (guest code), `hostCallPct` handling the guest's
  Win32/DirectX calls, `guestWaitPct` in waits the guest asked for (its frame limiter's Sleep: near zero means the
  game is behind schedule and never waits), `stateReadPct` reading snapshots for the page, `otherPct` the rest
  (scheduler turnaround between slices, frame snapshots, messages), with `slicesPerS`, `stateReadsPerS` and
  `framesPerS` (game frames handed to presentation), and `jitCompiled` / `jitFreed`: modules of guest code the
  emulator compiled and gave up in the window. A few of each are normal; several hundred given up at once is the
  emulator throwing its whole compiled cache away (`src/vm86/jitModuleTable.ts`), after which the game runs
  interpreted, several times slower, until its code has been counted hot again.

The accounting behind `vm` starts with the first `usage` request and costs one clock pair per CPU slice and per
host call; a session that never asks (every production build) keeps the unwrapped loop and takes no reading.
Records exist only for windows of a running battle: menus, the loading screen, a stopped VM and the window in which
another match begins are skipped.

Two sinks, like the stall recorder: the development server appends each record as a JSON line with
`"kind":"speed"` to the same `RA2_PERF_LOG` file (`POST /__perf/speed`, the same handler; a 404 stops the posting for
the session), and the toolbar shows one line under the stall line, "游戏速度 实际 X / 应有 Y"
(`RuntimeToolbar.setGameSpeed`), the last window's rate against the allowed one. `__speedTelemetry.records` in the
console holds the last 240 records.
Native-host sessions use `endpoint: null` to keep these records and toolbar rates local without requesting the
optional emulator log route. The default endpoint and server-log behavior remain unchanged for emulator sessions.

## HD interface layer (`hd-ui=1`)

In development, `?hd=1&hd-ui=1` adds a separate Canvas 2D interface controller (`hdUi.ts`). It consumes the optional
`GameRenderState.sidebar` snapshot, including live frame-space layout, faction, active tab, visible cameos,
animated credits, native power slot counts, radar state, repair/sell modes and localized ready/hold labels. It works
without a battlefield HD cache. While enabled in a battle, uncached-map polls run at least every 50 ms; a live
battlefield keeps its faster polling cadence. Unavailable snapshots and poll failures hide the interface.

The `#hd-ui` canvas sits immediately before `#screen`, at z-index 0 above `#hd-screen`, covers the screen's box on
whole device pixels with one buffer pixel each, and receives no input. The WebGL2 frame renderer clears the covered rectangles after every
frame path (plain, upscaled or keyed), before its independent native cursor pass. These extra rectangles are
independent of the tactical key/hole. All pointer and keyboard input continues to reach the original game.
Without the optional page cursor, the read-only native `sidebar.pointer` supplies cursor sheet frame and resolved
hotspot; the input controller's read-only position accessor supplies low-latency guest coordinates when available.
The cursor is drawn last, clipped to the exact covered union, including partial intersections at its edges. Outside
that union the native software cursor remains visible. Missing cursor art uses a vector arrow; unknown/hidden
pointer state draws none.

The development YR page can instead load a complete cursor atlas before attaching either backend. On the web route,
the optional `GameRuntimeHooks.preparePagePointer` validates the pinned executable hash and `WWMouse::Draw` signature
before suppressing only that final software-cursor blit. Main-thread and Worker frames then carry synchronously
sampled `VmFrame.pointer` metadata; an inconsistent sample retains the last confirmed state, while null is an
observed hidden/off state. The native route uses the same pointer validation through its asynchronous READs.
`#native-page-cursor` presents the atlas at the local pointer immediately and covers the whole game canvas in HD
and original view; the sidebar controller omits its own pointer copy. Missing/invalid page art or an unsupported
game hook retains game drawing. Menu/dialog Win32 cursors remain the actual resource bitmap and hotspot, independent
of the software atlas: the supplied 2x MOUSE art does not replace the original 32x32 menu arrow.
The optional `sidebar.tooltip` supplies the native frame rectangle and copied UTF-16 text, including native cost
lines and line breaks. That rectangle is added to the transparent regions while shown and filled with an HD tooltip.

Optional art lives under the local HD cache's `_ui/` directory:

- `_ui/cameos/index.json`: `{ "version": 1, "images": { "image": { "hd": "hd.png", "orig": "orig.png" } },
"byId": { "TYPE_ID": "image" } }`. Both image paths are optional and relative to `_ui/cameos/`.
  The type-ID mapping takes precedence over the snapshot's image name; missing HD art falls back to original art.
  An image entry's optional `caption` (string) is the short name printed on the original cameo (Simplified Chinese
  for this install, for example `矿石精炼厂` where the type's UIName is `苏联矿石精炼厂`); the HD caption prefers it over
  the snapshot's UIName, which remains the fallback. The native tooltip is unchanged.
- `_ui/chrome/<side>/chrome.json`: `{ "frame": { "width": 800, "height": 600 }, "pieces": [
{ "file": "sidebar.png", "rect": { "x": 0, "y": 0, "width": 168, "height": 600 },
"anchor": "sidebar" } ] }`. Side is `0` Allied, `1` Soviet, `2` Yuri, or `-1` unknown. Files are relative to
  that side's chrome directory. `rect.x/y` are frame-pixel offsets from the live anchor's origin and `width/height`
  are frame-pixel sizes. PNG scale does not affect geometry. Three 168x248 sidebar pieces use y=0/248/496;
  two 492x32 command halves use x=0/492, y=0. Loaded chrome replaces procedural tab icons. When every piece of an
  anchor has the same art-to-frame scale, the pieces are composited once into one bitmap per anchor and drawn with a
  single scaled `drawImage`, so filtered piece edges cannot leave a dark seam at their joins.
  Chrome art is a redraw at ONE frame size (`frame`). At another frame height the sidebar is cut the way the game
  builds it (`chromeSlices` in `packages/hd-renderer/src/ui/sidebarView.ts`): the part above the cameo strip stays,
  the strip shows as many rows as the live layout has (extra rows reuse the art's inner rows), and the part under the
  strip follows the strip's bottom. That needs the game's row rule, published as the optional `layout.stripReserve`
  (YR: `sidebarReader.ts`), and the anchor's art in one composite. A fixed-width anchor whose width differs from the
  art gets no chrome: its native picture stays visible unless the responsive command background below is available.
  Optional `commandBar` is `{ "scale": 2, "left": [{ "frame": 0, "file": "ui3/left0@2x.png" }],
"middle": "ui3/middle@2x.png", "right": "ui3/right@2x.png" }`. Every image must load and share its art scale and
  height before the replacement publishes. The left/right caps retain their frame-pixel sizes; the middle repeats
  between them and its last tile is cropped from the left edge, never stretched. `commandBarLeftFrame` selects the
  source cap frame from the game snapshot (pinned YR draws frame 0; see research/sidebar-ui.md). The live bar rectangle
  owns the placement and transparent region at any fitting width. Independent command-button art is drawn afterward
  at the original gadget rectangles; unsupported states retain their native pixels and no hit area changes.
  Optional `tabs` is `{ "file": "tabs.png", "scale": 4, "frames": [
{ "tab": 0, "state": "normal", "rect": { "x": 0, "y": 0, "width": 112, "height": 108 } } ] }`.
  Each rectangle is in atlas pixels and includes the whole native tab canvas with transparency; it is scaled into
  `layout.tabs[tab]`. A usable atlas has unique, bounded normal/active frames for tabs 0–3; pressed frames are optional.
  Nonempty tabs select active art when selected, or alternate active/normal every 500 ms when flashing; empty tabs
  leave the chrome's blank disabled plate visible. Art replaces tab pulse/glow/outline overlays. Pressed art is reserved
  until the page exposes held-button state; no input listeners are added. Missing/malformed manifests, missing PNGs,
  decode errors or invalid frames disable only tab art, retaining complete chrome and the prior tab overlays.
  Extract native strips with `pnpm hd:ui -- tabs --game "$RA2_INSTALL" --out "$UI_WORK/tabs-orig"`, then use
  `packages/ra2-assets/python/ui_chrome.py tabs-sheet` / `tabs-pack` as described in the asset package README.
- `_ui/cursor/cursor.json`: `{ "version": 1, "frames": [{ "x": 0, "y": 0, "width": 55, "height": 43 }] }`.
  Rectangles index `cursor.png` (or optional relative `file`). Each frame includes transparent bounding-box padding;
  optional positive integer `scale` is atlas pixels per frame pixel and defaults to 1. With `scale: 2`, a 110x86
  atlas rectangle still occupies 55x43 frame pixels. The page copies those art pixels directly to its cursor backing
  canvas; only final CSS/DPR presentation resamples when needed. Hotspots remain unchanged frame-pixel runtime data.
  Export with `pnpm hd:ui -- cursor --game "$RA2_INSTALL" --out "$HD_CACHE/_ui/cursor"`.
  This YR build uses `MOUSE.SHA` and `MOUSEPAL.PAL`; CLI `--shape`/`--palette` can select other supplied files.

Manifests and bitmaps load lazily. Missing files (including 404 responses) are remembered for the controller's
lifetime; reload to pick up newly created assets. A complete loaded chrome set covers the sidebar and command bar,
with an active radar aperture preserved by up to four rectangles around it. Without complete chrome, only the cameo
strip, power column, credits band and tab rectangles are replaced procedurally; native radar, buttons and command
bar remain visible. Missing cameo art uses a named dark tile. Cameos retain captions, progress sectors, queue badges,
ready/hold labels, availability shading, flashing and hover outlines. Ready/Hold use bold 13 frame-pixel warm yellow
text (`#ffd84a`), a 1.25 px dark stroke below the fill and a text-sized translucent black rounded box with 3 px padding.
The vertical centre is cameo y+20; long translations shrink to 10 px and then fit the available width. The pulse floor
is 85%; queued Hold stays left aligned so its badge remains visible. Name captions retain their existing styling.
All extracted or derived art stays outside Git.

`__hdBridge.toggle()` toggles both battlefield and interface for original/HD A/B checks.
`__hdBridge.ui.enabled` reports the effective interface switch and `__hdBridge.ui.toggle()` independently toggles
only the interface. `__hdBridge.ui.state` returns a detached read-only-access snapshot of the last sidebar publication
(null when unavailable), so inspection cannot mutate the bridge's live state. The controller owns its animation request, canvas and bitmap cache; session cleanup cancels
animation, removes its canvas, closes bitmaps (including late results) and clears the extra frame rectangles.

Asset-free regressions are in `tests/basic/hdUi.test.ts`, `tests/basic/vmFrameRenderer.test.ts` and
`tests/basic/hdBridge.test.ts`. With a running development server, `pnpm exec tsx
tests/basic/browser/hdUiBrowserSmoke.mts` exercises synthetic fallback/chrome composition, radar/cursor pixels,
input passthrough, both A/B switches and cleanup in a real browser. `RA2_BROWSER_ORIGIN` selects the development
origin, `RA2_BROWSER_EXECUTABLE` optionally selects an installed Chromium executable, and `HD_UI_EVIDENCE_DIR`
optionally retains screenshots and the JSON transcript. A blocked browser launch is unverified acceptance.

The dynamic import of `hdUi.ts` is lexically guarded by `import.meta.env.DEV` in `hdBridge.ts`; the production-graph
architecture regression rejects reachable `hdUi.ts` and the guest sidebar reader. Production builds contain neither
the interface controller nor its renderer/assets. Synthetic drawing tests and browser previews verify page-side
rendering and lifecycle separately from real-game guest-reader, native-tooltip and interaction acceptance.

## Bridge fields

The live view's snapshot types carry optional fields beyond what the page forwards today. Each consumer is active only
when its field is present and falls back to a documented estimate otherwise; all of them are unit-tested with
synthetic snapshots (`tests/basic/hdLive*.test.ts`, `tests/basic/liveSmudges.test.ts`). Building/infantry H2 fields
and the H3 overlay and smudge grids are read from pinned YR 1.001 and forwarded end to end. Evidence, optional-read
boundaries and the remaining H1/H2 proposals are in `docs/remaster/research/hd-bridge-fields.md`. H1 is partial:
native anim frame/stage/alpha/layer/owner/attachment/buildingAnim and bullet type/frame/velocity are forwarded;
the table also lists the remaining optional fields alongside implemented observer fields.

`GameRenderState.lighting` is forwarded unchanged as `LiveSnapshot.lighting`: current ambient, selected ground/level
in `[Lighting]` fractions, normal `tint`, raw palette `override`, `event`, storm active/pending/ending/target-cell
state, and `sources`: the local light sources the engine applies to cells right now (position, reach, intensity and
RGB tint in engine units), read from the game's own LightSourceClass vector with its switched-off and detail-gated
lights left out. The map light grade takes them on every map, including the many without a `lights.json` sidecar.
`src/games/yr/sceneLighting.ts` validates the ScenarioClass pointer and reads native words/statics; invalid
or unavailable reads publish null, never fabricated zero light, and an unreadable light vector leaves `sources`
absent (the view then keeps the sidecar's types on the standing buildings) rather than empty. Lighting participates in the YR same-frame cache
key, so event transitions can publish without waiting for the next logic-frame number. No event timing is inferred
from animations. See [Scene lighting events](research/yr-scene-lighting.md#scene-lighting-events) for addresses,
independent palette/height selection priorities and the limits of global state versus per-cell engine caches.
The renderer applies terrain/object event multipliers independently of map-grade weight and freezes adaptation
to event-free light; ordinary snapshots and older recordings without lighting keep identity event uniforms.

| Step | Fields                                                                                                                       | Used for                                                                                                       | Fallback without it                                                                                                                                                                                                                                                        |
| ---- | ---------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| H1   | `LiveAnim` frame, stage, frameCount, loop range, loopsLeft, rate, flat, translucency, layer, owner, attachedTo, buildingAnim | exact anim frames; AltPalette art in the owner's colours; building layers exactly as played                    | frame counted from the anim's first sighting at the art's rate (`animFrameAt`, `animRateFrames` in `packages/ra2-assets/src/effects.ts`); ActiveAnim/IdleAnim always, ActiveAnimTwo..Four except on ore storage buildings, powered layers of civilian tech buildings still |
| H1   | `LiveBullet` type, weapon, warhead, frame, velocity, source, target, arcing                                                  | projectile art (SHP by frame or flight direction, voxel along its velocity)                                    | a small grey dot                                                                                                                                                                                                                                                           |
| H1   | `voxelAnims`, `fireEvents`, laser outer colour/thickness/progress                                                            | debris voxels; firing frames of SHP units and infantry                                                         | none; no firing frames                                                                                                                                                                                                                                                     |
| H1   | particle system type, particleCount, lifetime, attachedTo, particles (with type and frame)                                   | the system's own rules and spawn window; the engine's particles as they are                                    | `SmallGreySSys` rules; spawning for 48 logic frames after the first sighting, or for as long as the system is listed when it sits exactly on a vehicle                                                                                                                     |
| H1   | `LiveHouse.civilian` (Neutral and Special houses)                                                                            | idle tech buildings                                                                                            | houses owning no buildable building count as civilian                                                                                                                                                                                                                      |
| H2   | `LiveObject` buildState, buildupFrame, infantrySequence, sequenceFrame, infantryDrawFacingRaw                                | engine make frame (already reversed for selling); named infantry sequence, local step and optional draw facing | first-seen frame recorded at snapshot push; new buildings after a push gap greater than 54 logic frames assumed complete; otherwise estimated make after initial 60-frame grace period; selling unavailable; infantry walk/stand, Die1 at 0 health, FireUp after a shot    |
| H3   | `snapshot.overlays`, `snapshot.smudges` (implemented independent grids)                                                      | ore growth and harvesting, walls, the engine's craters                                                         | the map's initial overlays and smudges; no HD scorch marks                                                                                                                                                                                                                 |

Completed-building H2 also supplies `buildingFrame` and `buildingDamaged`: the engine-selected body/shadow frame
(including occupancy) is independent of the yellow condition used for bibs and damage-animation variants.
Without these optional fields the view retains its library-yellow body/layer estimate.

Completed-building H2 also publishes `activeAnim?: 'none' | 'shown' | 'detail'` from the validated native
ActiveAnim slot: `none` means no anim, `shown` means its native draw gate allows it, and `detail` means
Invisible, options detail or dynamic frame-rate detail suppresses it. Invalid reads omit the field (unknown).
The YR projection's `buildingActiveAnim.ts` observer reads detail globals once per poll; optional snapshot
`nativeDetail { fps, lowFrameRate, level }` exposes the validated native renderer diagnostics. These fields
participate in the same-frame change key and pass through the page to LiveView. RA2 supplies neither.
Only NAPOWR's HD glow opts into this state: `none` removes its orb, arcs and pool, then their existing fade
restarts when the anim returns. The default `LiveViewOptions.nativeDetail: 'ignore'` keeps `detail` lit;
`?hd-native-detail=mirror` (option `'mirror'`) suppresses it for native/HD reviews. Unknown state retains
the existing build-state/sandbox policy. See [ActiveAnim evidence](research/hd-bridge-fields.md#activeanim-and-native-dynamic-detail).

Optional object `imageType` forwards the engine's draw image without replacing the rules `type` used for health,
selection, ownership and events. YR 1.001 UnitClass draw saves Type at `0x73D29C`, tests Harvester (+`0xE0E`) at
`0x73D2A6` and Unloading (+`0x6D1`) at `0x73D2B0`, reads UnloadingClass (+`0x6B8`) at `0x73D2BA`, swaps Type at
`0x73D2C4` and restores it at `0x73D3A2`. The reader validates the alternate UnitTypeClass pointer/vtable/id, so
unloading HARV/CMIN draw HORV/CMON; absent or invalid fields and missing alternate art retain `type`. A rare poll
inside the swap window can already see the unloading type for one snapshot. SCHP deployment is a separate policy.

Optional object `turretIndex` forwards the engine-selected numbered vehicle turret independently of facing and
rules type. YR publishes a validated `CurrentTurretNumber` for non-gattling multi-turret vehicles, including zero;
unavailable fields remain absent. The map/type-library voxel model can contain optional `turretVariants` with
alternate turret/barrel parts. LiveView keeps the shared hull, replaces those parts, and caches geometry by turret
selection and owner palette. Older caches or unavailable variants retain the default model. Alternate turrets keep
their own voxel material; only the hull receives the default HD projection, whose turret paint fits another shape.
Boarding, unloading, repair and weapons remain original-engine behavior. See
[numbered vehicle turret evidence](research/yr-unit-turrets.md).

Optional object `underlay { art, frame, x, y, z }` is one frame of effect-library art the engine draws inside the
object's own picture, right before its body: the art's canvas centre goes to the projection of the lepton point, the
body covers it, and ground, overlays and shadows lie under it. YR emits it for the ore-gathering sparks
(`src/games/yr/unitGatherState.ts`): UnitClass draw `0x73D0D1..0x73D283` blits `OREGATH.SHP` (loaded by name at
`0x73CED6`) when the type is a Harvester (+`0xE0E`), the unit's harvesting flag (+`0x6D2`, written by the harvest
mission at `0x73E87D`/`0x73E99A`/`0x73EB19`) is set, the locomotor's `Is_Moving_Now` is false, nothing targets it
with a temporal weapon (+`0x278`) and neither chrono flag is set. The frame is
`(FootClass +0x538 + CurrentFrame) % 15 + (7 - f8) * 15` with `f8` the body facing rounded to eight directions; the
point is Location moved 30 leptons along that facing; the blit is opaque (flags `0x2A00`: centred, read-only Z test,
ground gradient), with the anim palette and the unit's brightness. Its Z is the unit's adjustment minus 2, which on
dumped native Z-buffers is two units in front of the ground of each screen row: every sprite pixel passes over ground,
ore and the miner's own shadow, and only a terrain object's shadow written at the same Z cuts it. `Is_Moving_Now` is a COM call, so the reader
evaluates the drive locomotor's (`0x4AFC20`: facing rotating, or moving with a head-to coordinate and a positive
current speed) and the teleport locomotor's (`0x718080`) from their fields and reports nothing for any other
locomotor. War Miner and Chrono Miner have `Harvester=yes`; the Slave Miner does not and never shows the sparks.
Frozen native frames confirm the frame group, the pixel position and, with raw unit memory dumped at the same
instant, the phase: the native picture is drawn before the logic tick the reader sees, so at the same frozen instant
it shows the phase of `CurrentFrame - 1`. The same lag makes the picture keep (or lack) the sparks for one tick
after the harvesting flag changes. The live view draws the frame as a ground decal through the effect sprite layer
(`objectUnderlayCard` in `live/liveView.ts`), pulled in front of the unit shadow planes and behind upright bodies,
with the native indexed art or, in the enhanced effect style, the `effects-hd.json` entry of the same id when one
exists.

Optional `nativeHidden` suppresses a complete object visual, including its shadows and HD extras. YR emits true
for the proven UnitClass gate: nonzero tether byte, a validated building in radio link 0, effective or queued
Unload 16, and canonical door booleans. It covers opening, closing, open and closed; it is independent of the
factory's own effective-mission-only delivery image rule. The gate only says that the unit does not draw itself:
a building in effective Unload whose own tether byte is set draws each of its radio contacts in its second pass,
so such a contact (the vehicle driving out of a war factory) stays visible and the flag is omitted. The flag
remains for a queued Unload before the door mission starts, an untethered building, and a link the building does
not hold. Invalid or inactive observations omit the flag. The
bridge preserves the object's simulation/selection state; selection brackets and health bars are native overlay
pixels, and LiveView creates no selection geometry.
Owner-attached anims, particle systems and fire events follow this gate when both UID and pointer match;
independent explosions and projectiles keep their native publication lifetime. Same-frame unhide restores the
attached presentation without restarting the snapshot's interpolation timestamp.

Optional object `tilt` is the unit up vector the game draws a vehicle's body with, in object axes (z up; (0, 0, 1)
is level). YR reads it for Drive locomotors from the locomotor's current and previous ramp, its slope timer and the
engine's own ramp matrix table (`src/games/yr/unitTilt.ts`: `Draw_Matrix` `0x4AFF60`, table `0xB45188`; 29.31 degrees
on edge ramps, 21.36 on corner ramps, a three-frame blend between ramps); locomotors that draw with the base matrix
report level, the others nothing. LiveView tilts the voxel body with it, blends it between logic frames and lays the
contact shadow in the same plane; without the field the body follows the renderer's terrain normal as before.

Optional `translucent` is body opacity: YR emits 0.5 while BeingWarpedOut or WarpingOut is nonzero. SHP and voxel
body parts use 50% opacity and do not write depth while shadows retain their normal opacity. The chrono bytes
alone never set `nativeHidden`. Both fields pass through unchanged when defined, participate in same-frame
reader revisions, and restore ordinary rendering when omitted. Neither rule proves a CMIN-specific invisibility
window. Static predicates and their limits are in
[Native draw eligibility](research/painter-order.md#native-draw-eligibility-and-body-translucency).

Optional `tint` is how the game changes the whole picture of an object on one frame: `light`, a factor on the
object's own light level, and `add`, a colour added afterwards (0..1 per channel in display scale). YR
(`src/games/yr/technoTint.ts`) derives both from the fields its draw routines read, after checking the instruction
bytes those offsets were taken from (`YR_TECHNO_TINT_SIGNATURES`; a different build publishes no tint):

- Iron Curtain and Force Shield share one timer (techno +0x18C, IsIronCurtained 0x41BF40) and one tint stage machine
  (+0x1A4 with its timer at +0x198, stepped at 0x70E5A0). The factor is the engine's own arithmetic (0x70E380): a
  flash to 2 over six frames, held four, a fall to 0.2, a pulse between 0.2 and 0.5 every 24 frames (8 up, 16
  down), and the same flash 30 frames before the end; each object runs its own phase. The engine caps the lit level
  at twice the palette's brightness. A frozen native frame shows the factor of the previous logic frame.
- Colours are entries of the rules' [ColorAdd] list in the engine's 5/6/5 bits: ForceShieldColor on a force-shielded
  building, IronCurtainColor on a curtained vehicle (colour 0, none, in the stock rules: the Iron Curtain only
  darkens), BerserkColor on Berserk vehicles and infantry, LaserTargetColor on a building with an airstrike. Several
  colours are OR-ed as the engine does.
- A deactivated vehicle is drawn at half its level; a building that is the target of its airstrike takes the laser
  designator's pulse between 1 and 2 (0x70E4B0).

LiveView carries the tint as data, never as a material or shader variant, so the first tinted object compiles
nothing: two floats per sprite instance (`spriteTint` in the anchor buffer: every body card, layer and bib of the
object, not its shadows) and one per-mesh uniform for voxel parts and building turrets (`objectTint`, written when
each mesh is drawn). The shader multiplies the finished colour in display scale, limits the factor so that
level x factor stays within the cap, clips at white and adds the colour (`packages/hd-renderer/src/objectTint.ts`).
The flash of a targeted object is not published.

Projectiles are read up to 65536 leptons above the map (`YR_EFFECTS_LIMITS.maxProjectileHeight`), not the 64 levels
of ordinary objects: the falling nuclear missile is created 20000 leptons above its target and keeps that point as
its source, so the narrower bound rejected it for its whole flight. A bullet also carries `owner` and, for types with
FirersPalette (BulletTypeClass +0x2A9: both nuclear missiles), `ownerPalette`: LiveView then draws its SHP as a solid
body in the firing house's unit palette instead of a glowing effect in the animation palette. A building whose body
frame has no pixels (the nuclear silo is drawn entirely by the SuperAnim layer the engine lists as a building anim)
gives its layers the push and the body depth of the SHP's whole canvas; with the empty rectangle the ground hid them.

Cloak: `src/games/yr/technoVisibility.ts` is the read-only twin of TechnoClass::VisualCharacter (0x703860) as the
draw helpers call it for the local player, behind its own instruction signatures. A cloaked techno (CloakState +0x220
= 2) the local player may not see is published with `nativeHidden` (not drawn, shadow included); one he may see (his
own, an ally's both ways, or on a cell his sensors cover) and the fading stages (progress +0x224 over the rules'
CloakingStages) lower `translucent` to 0.75 or 0.5, the complement of the engine's 25 % and 50 % blitters. The
engine's ripple distortion of the last stages is not drawn. The translucent variant of a voxel material keeps the nodes
its source carries in `userData` (three's clone drops them); without them its shader did not build and every half
transparent voxel unit, chrono-erased or seen through its cloak, was a solid black shape. The answers of
special locomotors are not reproduced.

When a drawable building disappears, LiveView retains its frozen last visual through the logic frame after the
last one it was published in, whatever its last health. The deadline counts from that last present frame, not
from the publication that first missed the building: a poll can already miss it under the old frame number,
because the engine removes it in the middle of a logic tick. Selling, pointer/UID replacement, larger frame gaps
and rollback do not retain it; repeated polls of a frame do not extend it. This is a bounded presentation
heuristic: native prelogic rendering leaves the previous picture on screen at the frame increment, but another
native render can occur after it. Frozen same-frame pairs stopped at the increment match (see
[Last destroyed-building visual](research/painter-order.md#last-destroyed-building-visual)); parity at every
presentation phase is `UNCERTAIN`.

## Known limits

- The page skips native effects by default (`?hd-passthrough=` all) and the live view draws them itself from their
  original art, so translucent smoke and explosions no longer blend with the key colour. With
  `?hd-passthrough=terrain,objects` the game's own effects stay on top of the HD world and translucent ones still pick
  up the magenta key.
- HD effects cover what the page forwards to the live view: invisible anims and anims without art, and projectiles the
  original never draws (`Inviso`) are left out; beam colours are approximated (lasers use their inner colour, electric
  bolts one of two fixed colours); non-combat anims such as the move-order ring or ore glints are ignored.
- YR publishes native anim frame/stage, alpha, layer, owner and attachment data, including building anims, and
  projectile type/frame/velocity. Older hosts retain the timing and grey-dot fallbacks. Smoke columns still follow
  the view's particles rather than native particle frames; full H1 beam/debris/particle metadata remains incomplete.
- Optional `radBeams` and `waves` now pass from the YR effects reader through the bridge to an independent HD ribbon
  layer. It redraws RadBeam rad/temporal/eruption and WaveClass sonic/magnetron/laser/biglaser at the cached engine
  endpoints, fading from native age/intensity and clearing on removal, including within the same logic frame.
  Shapes/colors are procedural approximations; sustained rad cycles and magnetron intensity resets follow the
  observed state. Missing optional arrays draw nothing. The sandbox `fx.html?fx=beams&bprogress=0.5` is a frozen
  five-effect preview; actual weapon-trigger coverage requires a separate live-game run.
- Completed YR building bodies use `buildingFrame` from the native chooser, while bibs and animation variants use
  the independent `buildingDamaged` yellow condition. Civilian `CanBeOccupied` bodies normally damage at red;
  occupancy, TechLevel, gates and active mode offsets are included. Invalid rules/type reads and special
  LaserFence/FirestormWall bodies retain the legacy library threshold fallback. Old hosts also retain that fallback.
- YR 1.001 now supplies H2 building construction/selling and infantry sequence state. Invalid or partially initialized
  fields remain optional: without them, placed buildings estimate make progress from their first pushed snapshot,
  and sold buildings vanish without sale animation. A new building first observed after a snapshot gap longer than
  54 logic frames is assumed complete; rendering pauses and delayed art never restart its make clock. Only buildings
  retain appearance records, and records missing for more than 54 logic frames are evicted. A library
  missing a named infantry sequence keeps walk/stand/fire/death estimates; one without sequence metadata draws its
  first body frame. The normal type library already extracts all artmd sequences.
- SHP vehicles take
  the object's facing (their directions run clockwise from screen-up, the mirror of the infantry order; frame-matched
  on four live terror drones, two of them at a correlation of 0.95 and more) and walk on logic frame / `WalkRate`; a
  walk step counter and body facing from H2 would make the walk and firing frames exact.
- Runtime H3 overlays and smudges are implemented, but real-match visual acceptance remains unverified by synthetic
  tests. Theater libraries need the `smudges` section to cover types absent from the map. Libraries without it warn
  once and draw only interpretable map-cache art; live removals remain authoritative. `LiveView.diagnostics()` exposes
  `overlaysFromEngine` and `smudgesFromEngine` separately (`cellsFromEngine` means any live cell path).
- H2 infantry sequence state covers prone/crawling/deployment/death art and the JumpJet target-facing branch through
  optional `infantryDrawFacingRaw`. Invalid branch/target reads retain primary facing. Spy disguise type substitution
  remains unprojected. Real-game same-moment HD build/sell/infantry comparison is separate
  acceptance from reader tests and executable disassembly.
- The brightening around the map's lamp posts and other light sources (the engine adds them to every cell's
  light, up to 1.34x next to an INGALITE post) belongs to the renderer's map lighting, which the live view feeds with
  the game's active light list (`lighting.sources`).
- The normalized anim rate (`NORMALIZED_RATE_FACTOR`), the build-up rate, the smoke kinematics and the shroud edge
  (`EDGE_INSET`, `EDGE_SOFTNESS`) were fitted on XMP29U2 skirmishes at the development settings; other game speeds may
  need the bridge's exact values. The build-up rate estimate is used only when engine H2 state is unavailable.
