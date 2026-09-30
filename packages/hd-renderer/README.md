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
centre), `boom=1` (periodic explosions), `water=enhanced|classic` (the modern water on original maps, opt-in; `look=golden` turns
it on unless `water=` is given; default `classic`, the earlier HD water), `perf=1` (frames
back to back plus GPU timestamps; diagnostics only). `lamps=off&windows=0` gives a night lit only by
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

**Live-view bench** (`sandbox/fx.ts`, `?fx=<anim ids>`): deterministic clock and randomness; `fx=units` or
`fx=squad` add objects. `?fx=bldgs&bldgs=NACNST:0:0,NAPOWR:4:0:1` lists buildings as `TYPE:dx:dy[:owner]`:
cell offsets from `cx,cy`, with owner indexing the bench houses (default 0). `health=0.4` selects damaged art
(health <= 0.5); `make=1&time=0.4` omits these buildings during warm-up and shows their build-up 0.4 seconds after
spawn. Keep the default warm-up for build-up timing. Combine with anims using `fx=bldgs,TWLT070`.
`effects=enhanced` selects the enhanced effect style, `look=golden` the enhanced look preset,
`water=enhanced` the modern water, `stagger=<s>`, `repeat=<s>`, `at=dx,dy;...` and
`spread=<cells>` place and time the listed anims, `crater=1` emulates the engine's crater smudges, and
`window.__fx.advance(ms)` steps the clock for frame-by-frame capture (header of `sandbox/fx.ts`).

Set `HD_CACHE` to an absolute variant-cache root when starting the development sandbox to review L3 redraws;
the default remains `gameres/hd-cache`. For example, `HD_CACHE="$OUT_ROOT" pnpm hd:sandbox --port 15215`.

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
  (`src/water.ts`). Original maps shade their water per pixel on the terrain (`src/ra2/waterLook.ts`, below).
- Weather: world-anchored GPU rain streaks and splashes (`src/weather.ts`).
- Lighting: fixed classic sun azimuth, time-of-day keys, overcast, soft shadows for the procedural scenario
  (`src/lighting.ts`). Original maps take no sun shadows (see below).
- Effects: instanced fireballs, flame tongues, smoke, sparks, scorch decals, light-field flashes, camera shake; with
  garnish options (the live view) only a small flash, sparks and light on top of the original art (`src/effects.ts`).
  The live view's opt-in `enhanced` effect style (`ENHANCED`) adds, around the engine's own anim: a boiling fireball
  over the native art for its duration (original fire colours), a longer light, sparks and landing debris, rolling
  smoke and, after bigger blasts, a smoke column rising for about ten seconds, heat shimmer, a dust ring, and around
  craters a hot glow and charred ground that fades over most of a minute (the engine's crater smudge stays).
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

## Enhanced look (opt-in, `src/ra2/spriteLook.ts`)

Modern light on the original art, off by default: with every setting below at 0 the frame is the faithful one bit for
bit (the sprite shader skips the whole branch; checked by render hash on XMP29U2). `LOOK_PRESETS` / `applyLookPreset`
name two looks: `faithful` and `golden` (golden afternoon: every effect on, the sun arc, exposure adaptation, hour
16.5). Sandbox: `?look=golden`, single overrides `?relight= ?contrast= ?spec= ?glass= ?ao= ?shfollow= ?shsoft= ?wetrefl=
?sunpath=fixed|arc ?adapt= ?vsheen= ?vsheencap= ?vao=` and the "现代光影" GUI folder (`sandbox/look.ts`).

| Setting                                         | Meaning                                                                                                                                                                                                                                                              |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `relight`, `lightContrast`                      | Building and tree art relit by the sun as a delta on its baked shading: each pixel scales by (irradiance of its normal under the current sun and sky, relative to flat ground) / (the same under the art's own light, `ART_LIGHT`). Exactly 1 under the art's light. |
| `specular`                                      | GGX sun highlights on facades and roofs (and the sheen of wet surfaces).                                                                                                                                                                                             |
| `glass`                                         | Window panes of the material atlas mirror the sky (stylised street-level mirror, tinted by the pane, a smooth tilt field over the facade) with a sun glint on the inside of full panes.                                                                              |
| `occlusion`                                     | Baked occlusion of the material atlas (wall feet, roofs next to higher tiers) and soft ground contact decals around foundations.                                                                                                                                     |
| `shadowFollow`, `shadowSoftness`                | SHP shadow decals turn and stretch about their object's base with the sun (voxel shadows turn with them); their penumbra grows with distance.                                                                                                                        |
| `wetReflections`                                | Upright art mirrored about its base line on wet paving (short, rippled, strongest in puddles).                                                                                                                                                                       |
| `sunPath`                                       | `'arc'`: `Lighting.sunArc`, east in the morning, over the camera side at noon, west in the evening (the art's azimuth at 15:00); `'fixed'`: the classic azimuth.                                                                                                     |
| `adaptExposure`                                 | Lifts early and late daylight towards noon's flat-ground brightness (the colour of the light stays).                                                                                                                                                                 |
| `voxelSheen`, `voxelSheenCap`, `voxelOcclusion` | Voxel highlight strength and cap and crease occlusion (`vpl.ts`); null leaves the voxel material as configured.                                                                                                                                                      |

Per-pixel normals come from an optional material atlas next to the HD sprite atlas (`normals.json` +
`sprites@2x-normals.png`, written by `packages/ra2-assets/python/sprite_normals.py`, loaded by `spriteMaterials.ts`);
without it the relighting has no normals and sprites keep their baked shading, while shadows, contact decals and
reflections still follow the settings.

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
- Water (`waterLook.ts`, `shoreField.ts`, `../proceduralTextures.ts`): open water is shaded per pixel from the signed
  shore distance (land specks of at most `SPECK_TEXELS` field texels count as water). The opt-in `enhanced` look:
  a narrow turquoise shallow band with caustics over a sandy bed, dark blue-teal depths, a wind sea from three
  scrolled layers of a tileable ripple normal map plus two swells under drifting gust patches, sun glitter in ripple
  facets, rippled reflections of the mirrored scene, explosions and lamps mirrored from the light field, a swash that
  laps up and back with a thin foam line, breaker lines and wet sand, no surf at cliff feet, and rain rings. The default
  is the earlier `classic` look; sandbox `water=enhanced` (or `look=golden`), `LiveViewOptions.water` and in game
  `hd-water=enhanced` select the modern one (`waterPreset`, chosen before the world is built).
- Sprites (`sprites.ts`): filtered coverage of the indexed mask for soft edges; within about one original texel of
  transparent texels HD atlas colours keep their hue but are never brighter than the original texel there (the
  upscaler's pale background fringe goes without a rim of raw palette colours). SHP shadows halve the displayed
  colour, like the engine's. Live object occlusion uses scene-wide painter depth slots (`ra2/painterOrder.ts`),
  independently of art placement and per-frame `cardPush`; all atlas pages and voxel parts share the same order.
  Physical depth remains available to atmospheric post processing, while ground decals and shadows keep their
  existing depth paths. See `docs/remaster/HD_BRIDGE.md`, "Object occlusion", for the native rule and fallback limits.
  With the enhanced look on, a layer draws its ground art in two extra passes just before its cards
  (`SpriteLayer.groundPasses`): decals and contact shades without depth writes, then SHP shadows and wet reflections
  against an exact per-pixel depth of their ground plane pulled forward by less than a card's clearance
  (`GROUND_PULL`), so coplanar decals cannot z-fight (turning shadows used to pop hour by hour) and a turned shadow
  cannot hide the foot of a card (fence rails). Overlapping shadows darken a pixel once. The faithful look keeps the
  single pass.
- Voxels (`voxels.ts`, `vpl.ts`, `voxelShadow.ts`): geometry is built once per model (palette indices, normals, corner
  occlusion) and shared by every house colour; each palette gets a small lookup texture and material. Every section is
  decoded with its own normal table (`ra2-assets` `voxelNormals.ts`). Colour comes from the engine's `voxels.vpl` table
  (the `pnpm hd:materials` sidecar) with the engine's own shade rule (YR 1.001 @0x7586F0: section = int(16 x
  (max(0, N.L) + max(0, b / (3 - 2b)))), b = N.H, H between the voxel light and the model's up axis), lit by the cell's
  object level plus the units' extra light (rules `ExtraUnitLight`). Shadows are the model flattened onto the ground
  along a fixed light, halving the displayed colour once per pixel (depth-tested, see `voxelShadow.ts`); airborne units
  drop theirs straight down, shrunk with height. Review parameters (sandbox and replays): `?vpl=<extra>,<occlusion>,
<sheen>`, `?vshape=<corner relax>,<normal blend>`, `?ml=0` (no map day light).
