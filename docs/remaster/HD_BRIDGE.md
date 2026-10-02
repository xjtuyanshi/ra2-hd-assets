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
`/hd-cache` route are not part of production builds or `vite preview`. `tests/basic/architecture/dependencies.test.ts`
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
   trees) from the map cache; overlays (walls, fences, ore, gems) and smudges (craters, scorch and burn marks) from
   independent live cell snapshots when available, otherwise from the map cache; every building/vehicle/infantry/aircraft from the snapshot using the
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

## Object occlusion

`ra2/painterOrder.ts` separates the object's tactical painter order from its screen placement and `cardPush`.
The YR reader publishes optional `renderOrder { layer, index, ySort }` from the five native layer vectors;
registered objects retain their actual traversal order, including equal-key registrations and locomotor-specific
air layers. Ground insertion compares `GetYSort`: ordinary units use raw `Location.X + Location.Y`; buildings use
`Location.X + Location.Y - 256`, plus 32 for `TurretAnimIsVoxel` and minus 16 for `Gate`. Neither altitude nor
foundation dimensions enter this key. The building's drawing centre and art offsets are separate coordinates.
YR 1.001 evidence: `GetYSort` at `0x5F6BD0`, building position at `0x459EF0`, building override at `0x449410`,
layer traversal at `0x6D8DB0`; the layer vectors start at `0x8A0360` with stride `0x18`.

Traversal breaks near-equal physical depth ties with a bounded camera-space bias; it never assigns a global NDC
band. Voxel meshes retain their full depth range. Sprite fragment depth is reconstructed independently of frame
padding: ordinary cards stand vertically above their anchor and follow the ground below it; buildings use a
per-column front-facade ramp derived from their foundation. Shifted building animation cards share the owner's
profile. Turrets and lamp heads clear that profile, while physical beams, rain, emitters and garnish test in the
same depth space. Stock high-bridge overlays use a horizontal depth plane four height levels above the cell,
so neighboring deck pieces cannot sort ahead of an on-deck unit merely because of their cell keys.

Visible layer-2 units receive a geometric camera-space dock pull only from their radio contact's visible building
(`contactUid === host.uid`) when it reports `dock === true` and no `unloading` state. The exact anchor must lie
inside the foundation or within its one-cell outer border, and native painter order must place the unit after the
host. There is no stationary-frame gate, so backing-in units clear low pad art immediately. YR defines docks from
Refinery, UnitRepair or Helipad; WeaponsFactory alone does not qualify. Missing contact/dock data disables pull.
`ra2/dockPull.ts` samples `foundationPointPush` at the exact live anchor (`x/256`, `y/256`) and four axial offsets
one cell away, separately from the floored painter cell. Pull is the nonnegative maximum sample plus
`DOCK_PULL_MARGIN` (0.5), capped at `DOCK_PULL_MAX` (3.5). At refinery NW (51,101), foundation [4,3], the measured unit
anchor (13952,26240) leptons receives about 3.00949, compensating for low pad art without decoding `BUILDNGZ.SHA`.

Other ground vehicles/infantry within three cells (Chebyshev) inherit enough pull to remain in front only when they
follow a directly docked unit in painter order. Preceding units retain their depth, and propagation never cascades
through passing units. `PainterObject.pull` feeds both sprite and voxel bias paths. Building turrets, aircraft
above layer 2, projectiles and effects retain their existing biases.

During effective Unload mission, completed buildings report `unloading: 'door' | 'roof'`. When both matching art
layers exist, the deploying image/shadow replaces the body, then the healthy/damaged under-door card follows with
its anchor, push and foundation profile. Queued Unload alone does not open the door unless CurrentMission is -1;
radio link release during drive-out does not close it before the mission changes. Missing art pairs retain the
normal body, and factory exits receive no dock pull. A YR reader instance latches a published roof during the same
continuous effective Unload and reuses it only for NULL link 0; unreadable roof state still omits `unloading`.
It resets when the mission leaves `16`, the building disappears or its UID/type pointer changes, pruning entries
not seen in the latest read. The renderer uses `DOOR_RECESS = 2.75` for UnderDoorAnim and `ROOF_RECESS = 4` for
UnderRoofDoorAnim only; both are x+z units. The deeper roof plane exposes an inside unit at local `(2.5,1.5)` on
the floor or `1.5` levels up, while an outside unit behind the same building column stays hidden.
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

The native building path also consumes `BUILDNGZ.SHA` and software integer Z gradients. The foundation ramp is
an approximation, not a decoded per-art Z shape: roofs, recesses, nonrectangular foundations, custom bridges and
individual `ZAdjust` interactions require live comparison. See [tactical occlusion research](research/painter-order.md)
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
`/?start-page=battle&hd=1`. By default the HD lighting follows the map's own `[Lighting]` (day, dusk or night maps, see
`pnpm hd:lights`); `hd-time=<hours>` overrides the hour. Decorative weather is off by default;
`hd-weather=rain|snow|storm` enables it, with optional `hd-weather-intensity=<0..1>` (default 0.8 for rain/snow,
1 for storm; finite values are clamped, invalid intensities use the default, unknown weather selects clear).
Snow stays dry and ground weather excludes building foundations and steep cells.
`hd-look=<preset>` (`faithful|golden|cinematic`)
applies the preset and, on day maps, its suggested hour unless `hd-time` is given (dusk and night maps keep their own
`[Lighting]` hour; `cinematic` is the approved look with medium cooling); `hd-fx=enhanced` selects the enhanced effect style (point 4); `hd-water=enhanced` the modern water;
`hd-vlook=remaster` selects the remaster voxel look; `hd-vproj=<dir>` selects vehicle redraw projection atlases under
the HD cache (e.g. `vehicles-hd`); `hd-rect=x,y,w,h`
overrides the tactical rectangle (default: the frame minus YR's 168 px sidebar and 32 px command bar).

## HD interface layer (`hd-ui=1`)

In development, `?hd=1&hd-ui=1` adds a separate Canvas 2D interface controller (`hdUi.ts`). It consumes the optional
`GameRenderState.sidebar` snapshot, including live frame-space layout, faction, active tab, visible cameos,
animated credits, native power slot counts, radar state, repair/sell modes and localized ready/hold labels. It works
without a battlefield HD cache. While enabled in a battle, uncached-map polls run at least every 50 ms; a live
battlefield keeps its faster polling cadence. Unavailable snapshots and poll failures hide the interface.

The `#hd-ui` canvas sits immediately before `#screen`, at z-index 0 above `#hd-screen`, matches the screen's CSS box
and device pixel ratio, and receives no input. The WebGL2 frame renderer clears the covered rectangles after every
frame path (plain, upscaled or keyed), before its independent native cursor pass. These extra rectangles are
independent of the tactical key/hole. All pointer and keyboard input continues to reach the original game.
The read-only native `sidebar.pointer` supplies cursor sheet frame and resolved hotspot; the input controller's
read-only position accessor supplies low-latency guest coordinates when available. The cursor is drawn last,
clipped to the exact covered union, including partial intersections at its edges. Outside that union the native
software cursor remains visible. Missing cursor art uses a vector arrow; unknown/hidden pointer state draws none.
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
  hotspots remain runtime data. Export with `pnpm hd:ui -- cursor --game "$RA2_INSTALL" --out "$HD_CACHE/_ui/cursor"`.
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
- The day-time brightening around the map's lamp posts and other light sources (the engine adds them to every cell's
  light, up to 1.34x next to an INGALITE post) is not part of the live view; it belongs to the renderer's map lighting.
- The normalized anim rate (`NORMALIZED_RATE_FACTOR`), the build-up rate, the smoke kinematics and the shroud edge
  (`EDGE_INSET`, `EDGE_SOFTNESS`) were fitted on XMP29U2 skirmishes at the development settings; other game speeds may
  need the bridge's exact values. The build-up rate estimate is used only when engine H2 state is unavailable.
