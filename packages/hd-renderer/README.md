# hd-renderer

Base-agnostic HD 2.5D renderer for the RA2 remaster (three.js r186 `WebGPURenderer`, WebGL2 fallback).

It consumes a versioned `RenderState` snapshot (`src/contract.ts`) and never reads or writes engine state, so the same
renderer and assets can sit behind any base: the RA2 VM memory bridge, a reimplementation, or the procedural sandbox.

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
`docs/remaster/research/yr-scene-lighting.md`). Clear noon is unchanged: exposure stays `pi / referenceIrradiance()`
and every night-only term is exactly zero by day.

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
changes), lit windows use the type library's masks (`pnpm hd:lights -- --library <theater>`), and fires keep their
light alive keyed by the engine anim. The shroud is a visibility mask the renderer applies after the mist and before
bloom (`HdRenderer.setVisibility`), so nothing under black shroud glows through; shrouded buildings light no windows
and cast no light, except the map's invisible lamp-post dummies, which every player knows from the map. Without a
sidecar the view falls back to land-type surfaces and no map light sources.

## What v0 covers

- RA2-exact projection: 2:1 dimetric orthographic camera, 60x30 px cells, 15 px height levels (`src/world.ts`).
- Terrain: height field with smoothed shading normals, per-pixel procedural materials, soft class borders, wet
  surfaces, puddles, wet shore band, border shroud (`src/terrain.ts`).
- Water: analytic sky reflection, sun sheen, depth tint from the terrain height texture, shoreline foam, rain rings
  (`src/water.ts`).
- Weather: world-anchored GPU rain streaks and splashes (`src/weather.ts`).
- Lighting: fixed classic sun azimuth, time-of-day keys, overcast, soft shadows (`src/lighting.ts`).
- Effects: instanced fireballs, smoke, sparks, scorch decals, pooled flash lights, camera shake (`src/effects.ts`).
- Post: bloom, Neutral/AgX/ACES tone mapping, vignette, FXAA (`src/HdRenderer.ts`).

Units and buildings are placeholders (`src/objects.ts`) until real assets exist; the art pipeline replaces them by
`RenderObject.type`.
