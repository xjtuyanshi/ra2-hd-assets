# hd-renderer

Base-agnostic HD 2.5D renderer for the RA2 remaster (three.js r186 `WebGPURenderer`, WebGL2 fallback).

It consumes a versioned `RenderState` snapshot (`src/contract.ts`) and never reads or writes engine state, so the same
renderer and assets can sit behind any base: the RA2 VM memory bridge, a reimplementation, or the procedural sandbox.

## Renderer state and ownership

Each world loaded by `loadRa2World()` owns an `AtmosphereNodes` context, carried by `world.nodes` and `cache.nodes`.
`HdRenderer.init(world)` adopts that context; a procedural renderer creates its own. Effects and emitters remain
available from construction. If a world is supplied later with another context, its values are copied into those
existing layers without reallocating or discarding their state; passing `nodes: world.nodes` to the constructor
avoids that copy. Material helpers accept an optional context, and `SpriteLayer` inherits the cache's context.
Light-field and surface textures, day/night uniforms, water display compensation and voxel controls therefore remain
independent when two worlds render on the same page. Use `voxelLightingFor(hd.nodes)` for that renderer's voxel controls.
The former named uniform exports remain available for standalone materials using the compatibility context. Legacy custom
`HdWorld` objects without `nodes` or `cache.nodes` also use that context to keep their existing materials working; pass an
explicit context to custom material builders and their world to isolate multiple such custom worlds.

Call `hd.dispose()` after stopping presentation. It releases the post pipeline, light-field targets and meshes, and
context-owned fallback textures, voxel materials and lookup textures. A context belongs to one world/renderer lifetime;
pass the same `nodes` option to loaders and constructors when explicitly composing them. Map grades remain per cache,
and palette associations preserve existing voxel-builder signatures. CPU geometry can still be shared across contexts.

Asset-free state-isolation tests and the irradiance microbenchmark can be run with the existing root tools:

```bash
pnpm exec vitest run packages/hd-renderer/tests/rendererState.test.ts
pnpm exec node --import tsx packages/hd-renderer/benchmarks/rendererState.ts
```

The benchmark compares the original helper against the allocation-free implementation; it does not measure GPU cost,
full-match FPS, or visual equivalence on a physical device.

See [CPU performance and equivalence checks](benchmarks/README.md) for beam/card uploads, indexed atlas lifetime,
shroud and voxel baselines, regression commands and hardware acceptance boundaries.

## Run the sandbox

```bash
pnpm hd:sandbox        # http://localhost:15180
```

Drag to pan, wheel to zoom, click the ground to detonate. URL presets make screenshots comparable:
`?nogui&nohud&cx=13&cy=42&zoom=0.9&time=9.5&weather=rain&rain=0.9&battle=0&webgl=1`.

`node scripts/shots.mjs <outDir> [baseUrl] [presetSet]` captures fixed review presets with Playwright (set
`SHOTS_CHROME` to an installed Chrome if Playwright's bundled headless shell is missing). Presets marked `json` also
write `<name>.json` with `window.__hd.stats()`. Sets for night and weather: `atmo` (XMP29U2 a01..a10, RiverRam
b01..b08: noon, map-driven default, dusk, night, night rain, fires, day rain, lamps off), `atmoday` (the day
regression framings), `atmobase` (the same framings without parameters older builds ignore, for before/after
comparisons) and `atmoperf` (frame cost, see below).

## Night, weather and map light sources

Maps are staged from their own `[Lighting]` (`RenderMap.atmosphere`: `sidecarAtmosphere` recomputes it from the raw
`[Lighting]` and lamp posts in the `lights.json` sidecar written by `pnpm hd:lights`, else `mapAtmosphere` from the
manifest): day maps default to noon, warm mid-ambient maps to dusk, stock night maps to 22:00. The class comes from the
authored `Ambient - Ground` and tint plus lamp posts as evidence, not from the height term (see
`docs/remaster/research/yr-scene-lighting.md`). Every night-only term is exactly zero by day. By day the map's own
`[Lighting]` and light sources grade the original art as the engine does (see Original maps below); the night
presentation below keeps the calibration it was tuned with: the day's per-channel exposure, faithful display transform,
bloom threshold and sprite level blend into `pi / referenceIrradiance()`, PBR Neutral, the 0.85 threshold and the scene
level with the night weight, and the day map grade fades out with it (the night keys already derive their level and
tint from the same `[Lighting]`).

- **Night level.** Night light keys are scaled so unlit flat ground shows the profile's night level (30 % of noon
  for a typical stock night, 26-40 % for night maps), 40 % from a desaturated moon and 60 % from the sky. Moonlight is
  cool (`MOON_TINT`); only maps built as night maps add their own `[Lighting]` tint, a day map's warm grade never tints
  its night (`src/lighting.ts`, `profileKeys`). The keys aim 1.15x higher (`NIGHT_TONE_COMPENSATION`) because Neutral
  tone mapping's toe displays dark values darker than linear; measured on XMP29U2 with every local light off, the
  unlit park lawn shows at 0.26 of noon. Dawn and dusk keys stay brighter than night. Rain moves light from the sun to the sky
  instead of darkening the frame (flat ground keeps 1 - 0.08 x overcast of its clear brightness by day, 95 % at night, never below 26 % of noon).
- **Light field** (`src/lightField.ts`). Every local light is drawn top-down into one whole-map texture (up to 8
  texels per cell): the light of the map's light sources (`src/ra2/mapLights.ts`, YR 1.001's cell formula staged by
  `mapLightStaging`: exact on night maps, exact and always on for dusk maps, tight pools when a day map is forced to
  night), HD street lamps and window glows (static, faded in with the night), and dynamic lights: explosion and
  muzzle/beam pulses in separate ring pools and kept-alive fires, each pool with its own reserved instances. Static and
  dynamic lights are separate instanced meshes; static ones are written once per change and hidden by day. The
  per-cell base grid is half float (filterable on every WebGPU adapter and in WebGL2). Terrain, sprites,
  voxels, rain, smoke and mist read it (`src/atmosphere.ts`) at uv = world xz / map size; the field is rendered with
  z = 0 at the top because three samples render targets top-down on both backends. `node scripts/lightprobe.mjs
[baseUrl]` checks on WebGPU and WebGL2 that a light lands where it stands (within half a cell).
- **Night grade.** At night the moonlit term of terrain, sprites and voxels is desaturated 35 % (`moonDesaturation`,
  `moonlit()`; house paint excluded), while local lights, lit windows and fires keep full colour, and the display
  black level is lifted after tone mapping (the Neutral toe crushed shadows to 6-9 of 255; now about 12-15, never
  under shroud). Measured on a05/a06: lawn median 50/49 (was 74/71), mean saturation 124/113 (was 156/159).
- **Wet ground** (`src/ra2/terrain.ts`). Paved cells (asphalt, concrete, brick, roads; from the sidecar's surface
  classes) darken, gloss and form puddles (little sky in them by day: darker wet asphalt, not milky patches; at night
  sparse twinkling glints of the lamps mirrored in them); soft ground only darkens a little.
- **Emitters** (`src/emitters.ts`). Sodium-orange lamp heads glow and, on wet paving, cast long reflection streaks
  towards the camera; lit windows reflect as even streaks under each column of lit panes (from the pane columns in
  `windows.json`, on the wall the panes are on, starting at its base), fires as streaks, explosions also as a glow.
  Layers that would add exactly zero (static heads by day, streaks on dry ground) are hidden. Heads are pulled
  towards the camera only just past their own post, so units in front still cover them. At night the wet sheen
  follows the scene's light level, so puddles stay dark and mirror-like instead of milky.
- **Rain** (`src/weather.ts`) is lit by the scene and the light field (bright only near lamps at night); splashes are
  rings, full size on paving, small and faint on grass, none on open water. `storm` is heavier rain; there is no
  lightning (decorative weather rule in `docs/remaster/PLAN.md`).
- **Mist** (`src/mist.ts`): a thin height-based veil before bloom, at most 20 %, none on a clear day (the pipeline is
  rebuilt without it while its amount is 0), lit by the light field so lamps get halos.
- **Fire** (`src/effects.ts`): a flickering ember bed on the ground, golden flame tongues rooted in it (upright,
  stretching upwards, licked by noise) under a continuous dark soot column that fades in above them and is lit from
  below, and golden fireballs; red-dominant colours pushed into the tone mapper's shoulder turned pink. Particle
  materials collapse dead instances to a point in the vertex stage and a pool whose last particle died is not drawn,
  so spent smoke and flames cost nothing.
- **Night dressing** (`src/ra2/nightDressing.ts`, HD-only and switchable): street lamps along city streets, at night
  only, on thin generic poles (deliberately not the game's GALITE art, so nobody takes them for the real, targetable
  structure), each with a tight amber pool; the map's invisible lamp-post dummies (`INGALITE` and the coloured ones)
  get the same post and head whenever lamps are not `off`, so their light has a visible source; lit windows from the
  masks detected in the original civilian art (`windows.png`: warm amber panes with per-pane brightness), shown at
  night only. `lights=0` also switches off visible map lamps and the dummies' heads.

Sandbox parameters: `time=<hours>` (default: the map's hour), `weather=clear|rain|storm`, `rain=<0..1>`, `wet=<0..1>`
(start wet), `lights=0` (map light sources off), `lamps=auto|on|off` (`auto`: urban and newurban only),
`windows=0|1`, `mist=<multiplier>`, `nightlevel=<fraction of noon>`, `fires=<N>` (persistent fires around the view
centre), `boom=1` (periodic explosions), `perf=1` (frames back to back plus GPU timestamps; diagnostics only). `lamps=off&windows=0` gives a night lit only by
the map's own light sources and effects. `window.__hd.stats()` reports exposure, night, light counts, mist, wetness
and frame times; `window.__hd.hd.effects.lightStats(window.__hd.hd.seconds())` the active effect lights.

**Performance.** Measure frame cost with `node scripts/gpubench.mjs [baseUrl] [out.json]` (WebGPU): it loads the
`atmoperf` night framing (XMP29U2, night rain 0.8, wet, four fires, periodic explosions, 2400x1500), waits `WARM`
seconds (default 20; 90 for steady state, when the particle rings are full) and alternates in-page between that scene
and the same framing at clear noon, timing `HdRenderer.benchmark(N)`: N pipeline renders with three's node frame
advanced (otherwise passes are not re-rendered), divided by the time until the GPU queue drains. Budget: night median
at most 12 ms and at most 2.5 ms above clear noon. `stats().frameMs` under `perf=1` is a presentation interval, not a
cost, and `stats().gpuTimestampMs` is unusable on Apple GPUs (hundreds of ms per frame); neither measures the budget.
Other GPU work on the machine inflates every number, so compare configurations within one run.

**Live view.** `LiveView.create` without `timeOfDay` follows the map's staging; `liveView.setEnvironment({ timeOfDay,
weather, weatherIntensity, lamps, windows, lights, mist })` changes it without a reload. Light sources follow the
buildings standing in the match (light-emitting types from `lights.json`; the engine grid is recomputed when that set
changes), lit windows use the type library's masks (`pnpm hd:lights -- --library <theater>`), and fires keep a small
light alive keyed by the engine anim. The shroud is a visibility mask the renderer applies after the mist and before
bloom (`HdRenderer.setVisibility`, which also takes a `VisibilityMask` with its own extent and shaping function: the
live view's per-corner field with the engine-fitted edge), so nothing under black shroud glows through; shrouded
buildings light no windows
and cast no light, except the map's invisible lamp-post dummies, which every player knows from the map. Without a
sidecar the view falls back to land-type surfaces and no map light sources.

## What v0 covers

- RA2-exact projection: 2:1 dimetric orthographic camera, 60x30 px cells, 15 px height levels (`src/world.ts`).
- Terrain: height field with smoothed shading normals, per-pixel procedural materials, soft class borders, wet
  surfaces, puddles, wet shore band, border shroud (`src/terrain.ts`).
- Water: analytic sky reflection, sun sheen, depth tint from the terrain height texture, shoreline foam, rain rings
  (`src/water.ts`).
- Weather: world-anchored GPU rain streaks and splashes (`src/weather.ts`).
- Lighting: fixed classic sun azimuth, time-of-day keys, overcast, soft shadows for the procedural scenario
  (`src/lighting.ts`). Original maps take no sun shadows (see below).
- Effects: instanced fireballs, flame tongues, smoke, sparks, scorch decals, light-field flashes, camera shake; with
  garnish options (the live view) only a small flash, sparks and light on top of the original art (`src/effects.ts`).
- Post (`src/HdRenderer.ts`, `src/post.ts`): per-channel exposure, mist and the visibility (shroud) mask, bloom, the
  display transform, the night toe lift, anti-aliasing and sharpening; see HdSettings below.

Units and buildings are placeholders (`src/objects.ts`) until real assets exist; the art pipeline replaces them by
`RenderObject.type`.

## Settings (`HdSettings`)

| Setting      | Default      | Meaning                                                                                                                                                                                                                                                                                                                                                                    |
| ------------ | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `toneMapper` | `'faithful'` | Display transform. `'faithful'` is the identity up to linear 0.8 and a hue-preserving shoulder above (`src/post.ts`), so original palette colours reach the screen unchanged by day; on original maps it blends into PBR Neutral with the night weight (the night presentation's calibration). `'neutral'`, `'agx'` and `'aces'` are three's filmic curves for comparison. |
| `exposure`   | `1`          | Multiplier on the scene exposure. For original maps the day exposure is pi / (flat-ground irradiance at clear noon) per channel, so lit art shows its own colour at noon (blending into the night's pi / reference with the night weight).                                                                                                                                 |
| `bloom`      | `0.55`       | Bloom strength. By day only exposed luminance above 1 (effect cores, glints) blooms; the night keeps its 0.85 threshold on the unexposed scene.                                                                                                                                                                                                                            |
| `vignette`   | `0.25`       | Screen-edge darkening (the live view sets 0, like the original).                                                                                                                                                                                                                                                                                                           |
| `shadows`    | `true`       | Sun shadows of the procedural scenario; original maps never cast them.                                                                                                                                                                                                                                                                                                     |
| `antialias`  | `'msaa4'`    | `'msaa4'` (4x multisampled scene pass), `'fxaa'` or `'none'`. `defaultAntialias()` picks `'fxaa'` on devices reporting 4 GB of memory or less.                                                                                                                                                                                                                             |
| `sharpness`  | `1`          | RCAS sharpening after the display transform (0 strongest, 2 off, below 0 disabled).                                                                                                                                                                                                                                                                                        |
| `debugView`  | `'none'`     | `'overbright'` marks exposed luminance above 1; `'voxel-xy'` / `'voxel-z'` write voxel palette index, world normal and corner occlusion raw to the screen, for fitting the voxel lighting against captures of the original.                                                                                                                                                |

Call `applySettings()` after changing a setting; it rebuilds the post pipeline and frees the previous one's targets.

GPU memory of the post targets at 2400x1500 device pixels (estimated from their formats): with `'msaa4'` the scene
colour takes about 115 MB multisampled (RGBA16F) plus a 29 MB resolve texture and its depth about 58 MB; with
`'fxaa'` or `'none'` about 29 MB and 14 MB. The bloom chain (half resolution and below, RGBA16F) adds about 20 MB and
the sharpening target about 29 MB. Live painter ordering adds an RGBA16F physical-depth attachment: about 29 MB
single-sampled, or 115 MB multisampled plus 29 MB resolve with `'msaa4'`, at the same resolution. These are format
estimates, not measured full-match memory or performance. Every mid-pass copy of the scene colour (three's viewport textures, e.g. a
backdrop-sampling effect material) ends and restarts the scene pass; under `'msaa4'` that stores, resolves and reloads
the multisampled target, about 0.5 ms per copy at 2400x1500 on an Apple M-series GPU against about 0.1 ms
single-sampled, so layers should copy at most once per frame and only while they draw.

## Original maps (`src/ra2`)

- Map lighting (`mapLighting.ts`): the map's `[Lighting]` and light sources as the engine applies them by day, per cell
  (`MapLightGrade`, one texel per cell from `engineCellLight` in `ra2-assets` `lights.ts`: Ambient - Ground + Level x z
  plus lamp posts such as `INGALITE`, normalised tint). Terrain-class art (tiles, overlays, smudges, trees) takes the
  level x per-channel colour, objects (buildings, units, infantry, aircraft) the level only, both on the palette's own
  sRGB values. `SpriteInstance.lighting` selects the class per sprite (`'ambient'` by default, `'full'`, `'none'`); map
  objects take `MapObject.lighting`. Each map cache owns its grade (`Ra2Cache.mapLight`), live light sources update it
  through the night dressing, and the renderer weights it with the day (`setWeight`, baked into the texels). The HD
  water look takes no grade of its own (it mixes the graded tile art's hue in already).
- Terrain (`terrain.ts`): original tile art is lit by plain Lambert diffuse from the sun and sky, with specular only on
  wet ground, so flat ground at clear noon shows exactly composite x map lighting. Contact shading from the height
  field darkens ground and water at the feet of cliffs; no sun shadows are cast.
- Sprites (`sprites.ts`): filtered coverage of the indexed mask for soft edges; within about one original texel of
  transparent texels HD atlas colours keep their hue but are never brighter than the original texel there (the
  upscaler's pale background fringe goes without a rim of raw palette colours). SHP shadows halve the displayed
  colour, like the engine's. Live object occlusion uses scene-wide painter depth slots (`ra2/painterOrder.ts`),
  independently of art placement and per-frame `cardPush`; all atlas pages and voxel parts share the same order.
  Physical depth remains available to atmospheric post processing, while ground decals and shadows keep their
  existing depth paths. See `docs/remaster/HD_BRIDGE.md`, "Object occlusion", for the native rule and fallback limits.
- Voxels (`voxels.ts`, `vpl.ts`, `voxelShadow.ts`): geometry is built once per model (palette indices, normals, corner
  occlusion) and shared by every house colour; each palette gets a small lookup texture and material. Every section is
  decoded with its own normal table (`ra2-assets` `voxelNormals.ts`). Colour comes from the engine's `voxels.vpl` table
  (the `pnpm hd:materials` sidecar) with the engine's own shade rule (YR 1.001 @0x7586F0: section = int(16 x
  (max(0, N.L) + max(0, b / (3 - 2b)))), b = N.H, H between the voxel light and the model's up axis), lit by the cell's
  object level plus the units' extra light (rules `ExtraUnitLight`). Shadows are the model flattened onto the ground
  along a fixed light, halving the displayed colour once per pixel (depth-tested, see `voxelShadow.ts`); airborne units
  drop theirs straight down, shrunk with height. Review parameters (sandbox and replays): `?vpl=<extra>,<occlusion>,
<sheen>`, `?vshape=<corner relax>,<normal blend>`, `?ml=0` (no map day light).
