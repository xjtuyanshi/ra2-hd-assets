# hd-renderer

Base-agnostic HD 2.5D renderer for the RA2 remaster (three.js r186 `WebGPURenderer`, WebGL2 fallback).

It consumes a versioned `RenderState` snapshot (`src/contract.ts`) and never reads or writes engine state, so the same
renderer and assets can sit behind any base: the RA2 VM memory bridge, a reimplementation, or the procedural sandbox.

## Native HD interface

The development bridge's existing `?hd=1&hd-ui=1` switches enable `src/ui/sidebarView.ts` through the page-owned
`startHdUi` controller. The canvas has `pointer-events: none`; it installs no input handlers and never issues a
command to the guest. All destinations and hit areas remain the guest's live frame-pixel geometry. See
[read-only sidebar evidence](../../docs/remaster/research/sidebar-ui.md). Runtime sidebar publication currently
uses the pinned YR reader; auditing base RA2 assets does not establish RA2 runtime sidebar support.

Assets live outside Git at `_ui/cameos/` and `_ui/chrome/{0,1,2}/`. The asset cache owns and closes all bitmaps,
including optional atlases that arrive after disposal. The native image filename takes precedence over `byId`
when indexed, because the engine already selected primary versus alternate cameo; `byId` remains the fallback
for unknown or absent image metadata. Captions use that same image entry. Keep originals and HD entries for
alternate cameos separately rather than silently aliasing them to a primary portrait.

Each `chrome.json` retains `frame`, `pieces` and `tabs` and accepts two independent optional atlases:

```json
{
  "controls": {
    "file": "controls.png",
    "frames": [
      { "id": "command0", "frame": 0, "rect": { "x": 0, "y": 0, "width": 208, "height": 128 } },
      { "id": "command0", "frame": 1, "rect": { "x": 208, "y": 0, "width": 208, "height": 128 } }
    ]
  },
  "radar": {
    "file": "radar.png",
    "frames": [
      { "state": "frame", "rect": { "x": 0, "y": 0, "width": 672, "height": 440 } },
      { "state": "logo", "rect": { "x": 0, "y": 440, "width": 560, "height": 432 } }
    ]
  }
}
```

Atlas rectangles use image pixels. The renderer scales each control to its **live gadget rectangle**, never to a
percentage of the command bar or to the manifest's reference frame. IDs are `repair`, `sell`, `options`,
`diplomacy`, `scrollUp`, `scrollDown`, `command0` through `command24`, `commandExpand` and `commandCollapse`.
Publish only available images; 25 is the executable's capacity, not a claim that a stock installation supplies
25 command shapes. The native frame number is authoritative: 0 normal, 1 active/selected (also the pressed state
for two-frame non-toggle buttons), 2 disabled, 3 pressed and 4 pressed-active. A missing atlas or state leaves
the original gadget visible instead of covering it with a static picture. Native snapshots publish only the
currently drawn command slots and one expand/collapse control. `tabs.frames[].state` additionally accepts
`disabled` and `pressedActive`; missing native tab states likewise retain native pixels.

The radar `frame` artwork spans the sidebar width from aperture y-1 through y+height+1, with a transparent
aperture. The `logo` fills the native aperture while radar is inactive. Keep the native minimap and its padded
one-pixel viewport outline visible. In keyed WebGL presentation, a scissored RGB bilinear pass smoothly scales
**only** `layout.radar` directly from the latest native framebuffer. Indexed colours are decoded before
interpolation; RGB565 channels use the native bit expansion. Samples are clamped to the aperture so sidebar
metal cannot bleed into the map. No reconstructed terrain, recolouring, second cursor copy or frame readback is
used. Disable/dispose clears this region; backend replacement retains its setting. The default interface and
Canvas 2D fallback do not allocate this pass.

Two further optional entries hold single images at their own pixel scale (files may sit one directory below the
manifest); each list is published whole or not at all, independently of the other:

```json
{
  "controlImages": [
    { "id": "options", "frame": 0, "file": "ui3/left-link-frame0@2x.png", "size": { "width": 72, "height": 22 } }
  ],
  "overlays": [
    { "file": "ui3/top@2x.png", "anchor": "sidebar", "rect": { "x": 0, "y": 16, "width": 168, "height": 32 } }
  ]
}
```

- `controlImages`: one image per control id and native frame number, drawn whole into the live gadget rectangle.
  `size` is the gadget size in frame pixels the image was made for; it is used only for a live gadget of exactly
  that size (the image is a whole multiple of it) and then replaces the `controls` atlas frame of the same id and
  frame. A state without an image or atlas frame keeps the native gadget. The id says which gadget, not which
  glyph: the reader's `options` (`0xB04978`) is the left top button and `diplomacy` (`0xB04910`) the right one,
  and the original draws `DIPLOBTN.SHP` in the left and `OPTBTN.SHP` in the right gadget.
- `overlays`: art drawn over an anchor's chrome (`sidebar` or `commandBar`), `rect` in frame pixels relative to the
  live anchor, after the anchor's own art and under the controls. Nothing is drawn on an anchor whose native picture
  stays. A sidebar overlay must end above the cameo strip, the section that does not move with the frame height;
  one that reaches lower is drawn only at the art's own frame height. The original draws `TOP.SHP` (168x32) at
  sidebar y 16, under the two top buttons.

The command bar is still one picture per frame width (the `commandBar` pieces): at another width the native bar
stays. Its native layout is not two end caps around a rail: in the expanded state the left cap (`LENDCAP.SHP`) sits
at x 48 under the toggle, command buttons follow from x 76 on `BTTNBKGD.SHP` tiles and the right cap ends the bar
(matched in a 1728x1080 Soviet frame), so an any-width bar needs that layout, not a repeated middle tile.

Private, offline reference extraction and exhaustive registered-type coverage audit:

```bash
pnpm exec tsx packages/ra2-assets/src/cli/extractControls.mts --game "$RA2_INSTALL" --out "$UI_WORK/controls-original"
pnpm exec tsx packages/ra2-assets/src/cli/auditCameos.mts --game "$RA2_INSTALL" --cache "$HD_CACHE/_ui/cameos" --out "$UI_WORK/coverage"
pnpm exec vitest run tests/basic/hdUi.test.ts tests/basic/yrSidebarReader.test.ts tests/basic/frameRegionFilter.test.ts tests/basic/vmFrameRenderer.test.ts packages/ra2-assets/tests/ui.test.ts
```

The audit hashes the local rules/art/CSF bytes and source index, checks primary and alternate images for all
RA2/YR registries, and distinguishes missing original files from missing HD files. Tech/civil/campaign types are
included even when stock rules mark them unbuildable; shared native placeholder art remains shared. Per-map and
mod overrides are not exhaustively certified by this registry audit. Synthetic fixtures validate cache lifetime,
state selection and presentation geometry; GPU pixels, readability at 1:1, input passthrough and real radar
transitions require separate live acceptance.

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

Both the live view and the sandbox create their device with `HdRenderer.adapterLimits()`, which requests the
adapter's own `maxTextureDimension2D` and `maxBufferSize` instead of the WebGPU defaults (8192 px, 256 MiB). A large
map's whole-map 2x terrain must fit in one texture and in its upload staging buffer: DeepFrze's 12000x6664 terrain
needs about 320 MB and rendered black under the default buffer limit. Hardware below those sizes still fails
validation for such maps; the WebGL2 fallback is unaffected.

A material whose render pipeline the GPU refuses (more than 16 sampled textures or samplers in a stage, a shader
that does not validate) is not an exception: three logs the error and drops every draw with that pipeline, so the
object is silently missing. `src/materialFallback.ts` keeps the picture visible: a material may register a simpler
stand-in (`setMaterialFallback`), and `HdRenderer.frame` checks every 15 frames for refused pipelines
(`failedPipelineMaterials`: three r186 marks the pipeline's backend data and the GPU pipeline's label names the
material) and swaps the stand-in into the meshes that draw the refused material (`applyMaterialFallbacks`), with a
console warning. A stand-in may register its own. The original-map ground registers two: the same ground without
mirrored reflections, then the painted art alone (`src/ra2/terrain.ts`). Renderers without those internals report
nothing and keep their materials.

Call `hd.dispose()` after stopping presentation. It releases the post pipeline, light-field targets and meshes, and
context-owned fallback textures, voxel materials and lookup textures. A context belongs to one world/renderer lifetime;
pass the same `nodes` option to loaders and constructors when explicitly composing them. Map grades remain per cache,
and palette associations preserve existing voxel-builder signatures. CPU geometry can still be shared across contexts.

A live view can be prepared before it is shown. `LiveView.settledFrames` counts the frames in a row that drew their
snapshot completely (`loadingArt()` is the art still on its way: files, voxel meshes, objects that cannot draw yet);
a host that keeps another picture on screen meanwhile sets `outOfSight`, renders, and shows the view after a few
settled frames. `LiveView.warm(types)` draws one object of each listed kind (`LiveWarmType`: rules type, engine
image, colour scheme, civilian owner) at the middle of the map through the normal snapshot path, before the match
has any object; `warmTypes()` lists the kinds of the current match for the next one. The first match snapshot starts
its own timeline: nothing is interpolated from, or counted as appearing after, the prepared list.

Atlas pages reach the GPU through the view's `PageUploader` (`src/pageUpload.ts`): the texture is allocated empty
(three's `Source.dataReady = false` path), its rows are copied in strips with a per-frame pixel budget
(`render()` steps it: 8 M pixels per frame, or `hiddenUploadPixels` out of sight) and the mipmaps are generated after the
last row; the loaders hand a page out only then. One `copyExternalImageToTexture` of an 8192 x 8096 page blocked
the presenting thread for 100 to 330 ms. Pages up to 2048 x 2048, flipped pages and backends other than three's
WebGPU backend as that module reads it (the WebGL2 fallback) are uploaded whole by `initTexture`, as before. The
uploader finishes the page it has begun and then takes a page that is waited for before one loaded ahead of its
use (`LiveLibrary.preloadPage`), the smallest first: an indexed page that an object can already be drawn from does
not queue behind HD pages decoded earlier. The decode gate (`PageGate`) gives its turns by the same answer: first
come, first served among waited-for pages, pages loaded ahead only when none of those waits. Out
of sight, `newArtPerFrame` bounds how many new voxel kinds and sprite layers a frame adds to the scene (their
shaders are built in the frame that first draws them).

The post graph is rebuilt (new materials for every post pass, about half a second of shader building) only when
its settings change. `setTopEffectsVisible` therefore adds the top-layer pass with the first visible top-layer art
and keeps it; while no such art is visible the pass is not drawn and its empty target composites as zeros.
`enableTopEffects()` adds it ahead of time. The clarity pass's blur radius follows the buffer scale, so a host should
lay the view out at its final size before the first frame (`resizePixels`), not at a temporary one.

Asset-free state-isolation tests and the irradiance microbenchmark can be run with the existing root tools:

```bash
pnpm exec vitest run packages/hd-renderer/tests/rendererState.test.ts
pnpm exec node --import tsx packages/hd-renderer/benchmarks/rendererState.ts
```

The benchmark compares the original helper against the allocation-free implementation; it does not measure GPU cost,
full-match FPS, or visual equivalence on a physical device.

See [CPU performance and equivalence checks](benchmarks/README.md) for beam/card uploads, indexed atlas lifetime,
shroud and voxel baselines, regression commands and hardware acceptance boundaries.

## Frame cost: shaders, pipelines and quality tiers

What a frame costs was measured on one machine class (Apple M-series GPU, a 3120x2096 drawing buffer at two device
pixels per engine pixel, three r186) with a recorded battle of about a hundred vehicles in view; the figures below
are that scene's and say what each mechanism is for, not what any other scene will cost.

**One shader per graph, not per art (`src/materialSlots.ts`).** three builds a shader on the calling thread (15 to
100 ms) for every material whose node graph it has not drawn in a pass, and compiles a pipeline for every new shader
text. Art that differs only in data therefore shares one graph: the material of a layer, page, palette or unit type
is a clone of a prototype (`slotMaterial`), and what differs (its atlas page, its size, its lookup table, its redraw
projection) sits in slot nodes that the clone's binder writes in `Object3D.onBeforeRender`. Sprite layers
(`ra2/sprites.ts` `SpriteGraph`), engine effect pages (`live/effectSprites.ts`), voxel materials (`ra2/vpl.ts`,
`ra2/voxelPbr.ts`) and redraw projections (`ra2/voxelProjection.ts`: the per-type constants are uniforms and a small
frame table texture) work this way. Three things three decides from the texture a slot holds when the shader is built
must be equal for every texture of a slot: its sampling class (`samplingClass`: a texture whose filters are both
nearest is read with texel loads), its sample type and its wrap mode. `NodeMaterial.clone()` in r186 does not copy
`alphaTest` or `userData`; `slotMaterial` restores both.

**Instance data are geometry attributes.** Batches whose shader places the instances (`src/instancedQuad.ts`) keep
their instance count on an `InstancedBufferGeometry` and their per-instance buffers as named attributes of it. A
mesh with `count > 1` gets a shader build of its own in r186 (its uuid is part of the builder's cache key), and the
layout of node attributes is not part of three's pipeline cache key: two layers with the same shader text and
different instance strides shared one pipeline, and the second read its instances with the first one's stride (seen
as ground passes that drew nothing or the wrong instances). Named geometry attributes are in the key.

**Outlines for what only needs an outline (`ra2/voxelShadow.ts` `registerSilhouetteGeometry`).** A voxel part's
ground shadow and waterline foam are the part flattened and drawn in one colour, five offset copies for a soft edge.
They draw a silhouette geometry (`ra2/voxels.ts` `buildOutlinePartGeometry`: one quad per exposed voxel face, shared
corners, positions only) in place of the part's render mesh, and the contact footprint draws only its leading range
of upward faces (`SILHOUETTE_FOOTPRINT`). In the measured scene shadows were 48 of 59 million triangles per frame.

**Mirrors leave flat twins out (`MIRROR_SKIP_LAYER`, `src/world.ts`).** Every water plane in view draws the scene
once more into its mirror tile. Objects that lie flat on the ground or on the water (a voxel unit's shadow copies,
its waterline foam and reflection decal) set their layers to this one: the scene's own camera enables it, the mirror
cameras do not. With four water levels in view most of the mirror draws were such twins.

**Pipelines compiled off the frame (`src/asyncPipelines.ts`, `HdRenderer.enableAsyncPipelines`).** For views that
are watched live. The draw loop's pipeline requests take three's asynchronous path; an object is drawn from the
frame its pipeline is ready (`HdRenderer.pendingPipelines` counts the ones still compiling). Full-screen passes stay
synchronous. Tools that draw a frame and read it back keep the default.

**Warm frames (`HdRenderer.warm`).** While a view is out of sight, a warm frame draws everything that exists, hidden
or not, in every pass (the depth capture and one water mirror tile are forced), once per form of the post graph:
with mist and without. The first request also puts the top-layer pass into the post graph (it is drawn only while
top-layer art shows), so neither the first top-layer art nor the first mist of a match builds anything. `LiveView`
asks for warm frames behind the loading screen and again when the opening's art is in, and does not count as
settled while they run or while pipelines are pending; `EffectSpriteLayer.warm` adds one idle page mesh of every
kind and pass for them to build.

**Quality tiers (`HdRenderer.setQualityTier`, `HdRenderer.QUALITY_TIERS`).** What the renderer gives up to hold a
frame rate, least visible first; no tier changes the resolution of anything or the outline pass (see "Outlines"
below):

| Tier | Gives up                                                                                                                                                                               |
| ---: | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
|    0 | nothing                                                                                                                                                                                |
|    1 | copies of the frame (no heat shimmer on new blasts; translucent engine effects blend in linear light, not the engine's display-space mix); the light field is drawn every second frame |
|    2 | and the soft edge of unit shadows (one flattened copy for five)                                                                                                                        |

Every tier draws the same passes with the same post graph: a step builds, compiles and allocates nothing.
(Multisampling used to be a tier of its own. It smoothed only the outlines of voxel units and cost as much as the
rest of the scene pass together: 13 ms of a 30 ms frame in the staged battle below.) `src/qualityGovernor.ts`
(`QualityGovernor`) chooses the tier from the intervals between presented frames. Every half second it judges the
last second of frames by their mean interval without the longest twentieth: over budget is one tier down, far over
budget (one and a half times) straight to the last tier; after a calm stretch it tries one tier up, returns at the
first verdict over budget and then waits twice as long. A view that misses every tenth refresh is over budget
although its median frame is on time, which is why the verdict is a trimmed mean.

**Post graph forms (`HdRenderer.switchPipeline`).** The post graph has two forms in a match, with the mist pass and
without it. Each is built once and parked while the other draws (only the scene and top pass give up their render
targets). A rebuild for any other reason (a setting, the buffer scale, the top pass joining outside a warm-up)
retires the old graph and disposes it after the new one has drawn a frame: three counts the users of a compiled
shader and pipeline and drops them with the last one, so disposing first made the new graph compile about thirty
small pipelines again in one frame. The scene pass keeps one MRT node per set of outputs for the renderer's
lifetime: three keys a render context, and with it every built shader of the scene, by that node.

**Outlines (`src/silhouette.ts`, `antialias: 'edges'`).** Object outlines are smoothed by the frame's last pass
instead of by multisampling. Every surface that writes depth also writes a silhouette code into the green and blue
channels of the physical-depth attachment: (0, 0) for ground-class surfaces (terrain, decals, shadows, wet
reflections), a pair per draw point for upright sprite cards (`instanceSilhouette`, made in the vertex stage and
rounded per fragment) and a pair per unit and part for voxel meshes (`userData.silhouette`, `silhouetteCode`). The
last pass, which used to copy the finished picture to the canvas, compares each pixel's code with its four
neighbours'. Where they are equal the pixel is a `textureLoad` copy, bit for bit. Where they differ it searches the
outline up to `HdRenderer.outlineSearch` (12) pixels each way for the next step, takes the straight line through the
middle of both steps and mixes the pixel with its neighbour across the outline by the area the line cuts off, in
linear light and along one axis only (morphological anti-aliasing with codes for edges). Nothing of the scene pass
changes: depth, discards and blending are as without the pass, so what covers what is untouched.
`smoothSilhouettes` is the same arithmetic on arrays (tests, and checks of the GPU pass against captures:
`debugView: 'silhouette'` shows the codes as bytes). Measured on a frozen frame of the staged battle (3120x2096,
Apple M-series GPU): the pass adds 0.11 ms to the last pass; 1.4 % of the pixels change, every one of them on an
outline; the GPU result is within one 8-bit level of the twin everywhere.

## Run the sandbox

```bash
pnpm hd:sandbox        # http://localhost:15180
```

`HD_CACHE_DIR=<absolute dir>` makes the sandbox serve another cache root instead of `gameres/hd-cache` (for
example a directory of variant map caches built as symlink farms for side-by-side comparisons).

Drag to pan, wheel to zoom, click the ground to detonate. URL presets make screenshots comparable:
`?nogui&nohud&cx=13&cy=42&zoom=0.9&time=9.5&weather=rain&rain=0.9&battle=0&webgl=1`.

`node scripts/shots.mjs <outDir> [baseUrl] [presetSet]` captures fixed review presets with Playwright (set
`SHOTS_CHROME` to an installed Chrome if Playwright's bundled headless shell is missing). Presets marked `json` also
write `<name>.json` with `window.__hd.stats()`. Sets for night and weather: `atmo` (XMP29U2 a01..a10, RiverRam
b01..b08: noon, map-driven default, dusk, night, night rain, fires, day rain, lamps off), `atmoday` (the day
regression framings), `atmobase` (the same framings without parameters older builds ignore, for before/after
comparisons) and `atmoperf` (frame cost, see below).

## Scene lighting events

`LiveSnapshot.lighting` carries the engine's current ambient, selected ground/level terms, normal RGB, raw event
RGB override and event identity. Missing or null lighting is unknown and restores identity multipliers. Replays
consume the same field; there is no renderer-owned ambient fade. Same-event consecutive snapshots interpolate on
the live presentation clock, while event changes use the newest snapshot immediately.

`src/ra2/sceneLighting.ts` compares that state with the map's authored `MapLightGrade.lighting` (manifest fallback),
at its median cell height without local light-source contributions. For `I = ambient + level * z - ground`, it
uses `I_live / I_map`; `sceneTerrainMul` additionally replaces the map's normalized RGB with raw event RGB,
while `sceneObjectMul` multiplies untinted object art by raw event RGB. These shared vec3 uniforms apply in palette
colour space independently of the day/night map-grade weight. Tiles, whole-map terrain, water, ordinary overlays,
walls, smudges, trees and bridges use the terrain multiplier; buildings and all unit art use the object multiplier.
Effect art, local-light emission, window/lamp/Tesla glows, bloom and UI keep their own colours. Exposure, white
adaptation and map-tint adaptation use authored, event-free lighting. An absent or authored-normal state leaves
both multipliers exactly `(1,1,1)` and takes the material's identity branch. The RA2 adapter also selects sun-shadow share,
overcast and the bounded strike sky flash. Generic `src/sceneLighting.ts` accepts only terrain/object gains,
sun-shadow share, overcast and sky flash, with finite-value protection; `HdRenderer.setSceneLighting` consumes
that presentation DTO. It has no native event names, palette coefficients or map-height normalization policy.

A storm transfers all direct flat-ground irradiance into the hemisphere light with `Lighting.applySceneOvercast(1)`
after adaptation and multiplier calculation. The transfer preserves each linear RGB channel and luminance, including
any decorative rain/snow already applied; it does not select the grey-blue weather key or change exposure, white
adaptation, map-tint adaptation, bloom threshold or weather metadata. `sceneSunShadow = 0` removes hard sun shadows
while retaining contact shading. Top-layer effect cards (including storm clouds) use a
separate transparent pass after shroud/fog; ground and air effects retain their existing visibility/depth rules.
The extra pass exists only while top art is visible. Storm bolts produce a blue-white light-field pulse at their
ground point (4.5-cell radius, 0.12-second peak and 0.35-second decay) and a bounded 12% sky flash (0.08-second peak,
0.25-second decay). Pulse timing follows the renderer's effect clock; a repeated snapshot does not retrigger it.

The live bench accepts `&lighting=<ambient>,<r>,<g>,<b>[,<overrideR>,<overrideG>,<overrideB>]` for synthetic scenes
and replays. Four values force ordinary lighting; seven also stage a storm. Ground and level retain the authored
map values. Example: `?fx=WCCLOUD1,WCLBOLT1&map=XMP29U2&lighting=.87,1,.8,.68,.3,.4,.75`.
Without this parameter each replay snapshot retains its own lighting (including null/absent reset semantics).
Asset-free math, reader, bridge, shroud routing and shader-layout tests do not establish GPU pixel equivalence,
storm-cloud composition, pulse strength or real-game timing; those require same-scene captures.

Ore and gems are self-lit overlays. The live adapter uses the overlay type's `tiberium` flag; static caches already
carry the extractor's `lighting: 'none'` classification. Only those overlay instances bypass map grade, scene-event
multipliers, time-of-day light and the night display transform. Their HD crystal lighting uses a fixed clear-noon
reference, while decorative wetness remains available. Walls, rubble, bridges and crates retain normal lighting.
A renderer-local `unlit` MRT attachment carries their noon display colour through ordinary foreground occlusion,
shroud and top effects. It shares material blending and uses at most four attachments alongside physical depth and
emission. Explicit exposure, the selected daytime tone/grade and vignette still apply. Self-lit highlights bypass
scene bloom (their material sparkle remains); matching the former noon bloom halo is not established by this path.
The night toe is suppressed where self-lit colour survives; fractional filtered edges and GPU composition
remain **UNVERIFIED** until replay captures are measured.

## Night, weather and map light sources

Maps are staged from their own `[Lighting]` (`RenderMap.atmosphere`: `sidecarAtmosphere` recomputes it from the raw
`[Lighting]` and lamp posts in the `lights.json` sidecar written by `pnpm hd:lights`, else `mapAtmosphere` from the
manifest). The engine's cell light (`MapLightGrade`, see Original maps below) owns brightness and tint on every map
at its authored staging: the game draws every map, dark or bright, with one cell formula, so the class only chooses
the key light's style and whether the night dressing shows. Day and night maps default to noon (a look preset moves
both to its hour), warm mid-ambient maps to dusk; lunar maps are covered below. The night class comes from the object
level the game shows at the map's median height (`Ambient - Ground + Level x medianZ`) and tint plus lamp posts as
evidence (see `docs/remaster/research/yr-scene-lighting.md`). The moonlit presentation described under Night level is
what an hour forced to night shows (`timeOfDay`, `hd-time`): it keeps the calibration it was tuned with (the day's
per-channel exposure, faithful display transform, bloom threshold and sprite level blend into
`pi / referenceIrradiance()`, PBR Neutral, the 0.85 threshold and the scene level with the night weight), and the map
grade fades out with it past a night weight of 0.1 (`gradeNight`; a look's afternoon hour stays below that and keeps
the whole grade).

- **Night maps.** A map authored as night is a day map with night dressing: the same light keys, exposure, display
  transform and look as a day map at the same hour, with the engine grade supplying its darkness, its tint (terrain
  only) and its light sources. Its keys carry a dressing weight of 1 at every hour (`LightingState.dressing`), which
  drives lit windows, lamp heads and HD street lamp pools (the pools keep their plain irradiance on the graded art:
  about its ungraded brightness under the post, like one of the engine's own lamps). The map sources' own light field follows the moonlit night weight instead
  and is off at the authored staging, so no source is applied twice. Frozen same-frame pairs against the game under
  the cinematic look (docs/remaster/research/yr-scene-lighting.md lists them): ground 1.09-1.10, vehicles 0.89-0.96
  of the native luminance on Transylv and XXmas, against 0.97-1.52 and 0.61-0.68 under the former moonlit staging.

- **Authored dusk.** A dusk profile places its warm sunset key at the map's hour (DuskPen: 18.2), with a 10-degree
  sun floor instead of the usual 28 degrees. At that key the night weight is exactly zero, `MapLightGrade` weight and
  source share are both 1, and effective `adaptExposure`, `whiteAdapt` and `mapTintAdapt` are zero. Clear flat-ground
  irradiance is calibrated per channel to clear noon before decorative weather, so the engine grade owns brightness
  and tint while direct light stays warm and diffuse shade cooler. This calibration fades into the night keys if the
  hour is manually advanced. The separate dusk source field follows night gain, avoiding duplicate lamp washes at
  the authored hour. DuskPen's per-channel ±8% and saturation ≥0.33 replay targets are **UNVERIFIED** by asset-free
  tests; a frozen pair of XMP14T2 (the same `[Lighting]`) measured ground 1.08 of the native luminance, hue +5
  degrees and b* +6, vehicles 0.83.

- **Lunar staging.** Theater `lunar` always defaults to day at 12:00, with `airless: true`; its low ambient is dim
  airless daylight. The engine-exact palette grade stays enabled, including the map's own
  light sources: terrain-class art takes cell intensity x tint, objects take the object level. The lunar profile has
  neutral tint and no `exposure` multiplier; sun and sky use luminance-matched neutral greys, so the grade owns the
  ambient, height and authored tint once. Exposure adaptation remains off for airless profiles, as do white/tint
  adaptation and sky/haze/display-grade colour; instead the keys' day share is scaled to the noon flat-ground
  luminance and kept grey at every hour (`Lighting.update`), so a look's afternoon hour applies to the moon as well
  without dimming it: its objects then take the sun the look's relighting was tuned for (MoonPatr vehicles under the
  cinematic look: 1.17 of the native luminance at noon, 0.98 at 16.5). The light sources keep their full engine share
  on airless maps, whatever a look's `mapSourcesByDay`. Same-moment original MoonPatr captures show strong blue-violet pools around the
  player's base from nine map sources (`SNONITLAMP` x5, `INBLULMP` x4); these must remain visible while the unlit
  regolith stays dim. The game policy marks library ore/gem overlay sprites (`tiberium` types) grade-exempt through
  a generic per-instance flag, selecting multiplier 1 instead of the terrain/object grade and preserving full art
  brightness. Other sprite classes and terrestrial day maps keep their existing grade. Default lunar staging keeps
  HD night dressing off while retaining the original map lamps. Live same-moment check (MoonPatr base, cinematic):
  flat regolith L* 47 (original 43-47), b* -9 like the original away from the lamps; HD buildings render about 10 L*
  brighter than the original's (their relit HD art), see docs/remaster/research/yr-scene-lighting.md.
- **Night level** (an hour forced to night). Night light keys are scaled so unlit flat ground shows the profile's
  night level (30 % of noon for a typical stock night, 26-40 % for night maps), 40 % from a desaturated moon and 60 %
  from the sky. Moonlight is cool (`MOON_TINT`) on every map; a map's own `[Lighting]` tint lives in its engine grade
  and never tints the moon (`src/lighting.ts`, `profileKeys`). The keys aim 1.15x higher (`NIGHT_TONE_COMPENSATION`) because Neutral
  tone mapping's toe displays dark values darker than linear; measured on XMP29U2 with every local light off, the
  unlit park lawn shows at 0.26 of noon. Dawn and dusk keys stay brighter than night. Rain moves light from the sun to the sky
  instead of darkening the frame (flat ground keeps 1 - 0.08 x overcast of its clear brightness by day, 95 % at night, never below 26 % of noon).
- **Light field** (`src/lightField.ts`). Every local light is drawn top-down into one whole-map texture (up to 8
  texels per cell): the light of the map's light sources (`src/ra2/mapLights.ts`, YR 1.001's cell formula staged by
  `mapLightStaging`, only as the map grade fades towards a forced night: exact on night and dusk maps, tight pools
  on day maps), HD street lamps and window glows (static, following the night dressing weight), and dynamic lights: explosion and
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
- **Day overcast** (`src/lighting.ts`, `DAY_WEATHER_LIGHTING`). Original day-map profiles transfer direct sun into
  diffuse sky light. At intensity 0.8, rain retains 0.232 of the clear direct-light fraction and 0.92 of incident
  flat-ground luminance; snow retains 0.312 and 0.94. At noon this gives fully shadowed/sunlit irradiance ratios
  0.821 and 0.759. Rain's hemisphere B/R increases 8%, snow's 3.2%; the key tends to cool grey (0.96:1:1.04).
  Exposure and white adaptation use the clear light at the same hour, preserving the weather change. SHP shadows,
  infantry shadows, voxel shadows and contact shades scale by the same retained sun fraction. Rain terrain albedo
  is desaturated 12.5% at intensity 0.8. These day-map changes fade with night weight; night/dusk profiles retain
  their existing light curve, and the procedural sandbox retains its original lighting curve.
- **Wet ground** (`src/ra2/terrain.ts`, `WET_GROUND_LOOK`). Paved cells (asphalt, concrete, brick, roads; from the
  sidecar's surface classes) gain a glossy water film: saturated diffuse multiplier 0.75, roughness 0.26, and a
  grey-sky reflection weighted by 0.20 at the fixed isometric view. Reflected sky luminance is relative to the lit
  wet art, giving 0.90 of dry radiance before the weather light change. Puddle cores add 14% over adjacent wet
  paving, with soft noise edges (0.56..0.72) and expanding impact rings (radius 0.14, width 0.018, 1.6 cycles/s,
  up to another 2% inside puddles). Grass, sand and soil only darken to 0.90 at saturation, without gloss or puddles.
  At rain intensity 0.8, saturated flat ground therefore models 0.92 × 0.90 = 0.828 of clear luminance. Building
  mirror images remain paved-only and faint (0.10..0.22 strength, final alpha capped at 0.25). Night ground retains
  its dim sky and sparse lamp glints. Shader/state checks are asset-free; tone mapping, local lighting, source-art
  shading, pixel chroma and mixed-material crop averages still require same-frame rendered review.
- **Emitters** (`src/emitters.ts`). Sodium-orange lamp heads glow and, on wet paving, cast long reflection streaks
  towards the camera; lit windows reflect as even streaks under each column of lit panes (from the pane columns in
  `windows.json`, on the wall the panes are on, starting at its base), fires as streaks, explosions also as a glow.
  Layers that would add exactly zero (static heads by day, streaks on dry ground) are hidden. Heads are pulled
  towards the camera only just past their own post, so units in front still cover them. At night the wet sheen
  follows the scene's light level, so puddles stay dark and mirror-like instead of milky.
- **Rain** (`src/weather.ts`, `RAIN_LOOK`) uses 12000 wind-slanted streaks, width 0.026, length 0.55..0.85 units,
  with daytime core opacity 0.24..0.38 and a faint tapered motion trail. Scene and light-field illumination still
  controls visibility at night. Its 3500 bright splash rings land only on paved, non-water cells; radius 0.047 and
  expansion 0.6..1 correspond to 2.4..4 pixels horizontally at native 1x camera scale. `storm` is heavier rain;
  there is no lightning (decorative weather rule in `docs/remaster/PLAN.md`).
- **Snow** (`src/weather.ts`, `SNOW_LOOK`) uses 9000 world-anchored, camera-facing soft discs in the same
  camera-wrapped 48-cell volume as rain. Far/middle/near layers occupy 50/35/15% of flakes, with sizes
  0.04..0.055 / 0.055..0.075 / 0.075..0.09 units and speeds 0.55..0.8 / 0.85..1.15 / 1.2..1.65 units/s.
  Larger flakes sway more; about 2% extend to size 0.12. Daytime RGB is floored at (0.9212, 0.9506, 0.98) with
  core opacity 0.8..1; night keeps scene and local lamp illumination. Flakes vanish above terrain or open water
  without accumulation or splashes. Snow is dry: selecting it clears residual wetness, puddles and wet reflections.
  Clear weather hides both particle groups and resets day-weather gains to neutral; decorative weather remains
  off by default and never changes the map's chosen hour.
- **Ground exclusions** (`src/weatherGroundMask.ts`) are a renderer-owned, nearest-filtered R8 texture with one
  texel per cell: 255 excludes ground weather. Height-grid slopes steeper than 1.5 terrain levels per cell are
  excluded once at load; static and live building foundations mark their complete cells. Wet films, puddles,
  ripple rings, building mirror images and rain splashes are suppressed there, including fragments crossing in from
  adjacent cells. Cliff walls do not receive wet ground shading. Snow vanishes 0.6 units above excluded cells, 0.15
  above open water, or over its final 0.08 units above ordinary ground. Live snapshots and resolved art refresh
  foundation coverage only on change, with no texture upload for unchanged coverage or interpolation-only frames.
  Removing a building restores its cells while preserving terrain exclusions. The procedural sandbox has an empty mask.
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

Sandbox parameters: `time=<hours>` (default: the map's hour), `weather=clear|rain|snow|storm`, `rain=<0..1>` (legacy
precipitation intensity), `wet=<0..1>`
(start wet), `lights=0` (map light sources off), `lamps=auto|on|off` (`auto`: urban and newurban only),
`windows=0|1`, `mist=<multiplier>`, `nightlevel=<fraction of noon>`, `fires=<N>` (persistent fires around the view
centre), `boom=1` (periodic explosions), `water=enhanced|classic` (the modern water on original maps, opt-in; `look=golden` turns
it on unless `water=` is given; default `classic`, the earlier HD water), `perf=1` (frames
back to back plus GPU timestamps; diagnostics only). `lamps=off&windows=0` gives a night lit only by
the map's own light sources and effects. `window.__hd.stats()` reports exposure, night, light counts, mist, wetness
and frame times, plus separate `rain` and `snow` intensities; `window.__hd.hd.effects.lightStats(window.__hd.hd.seconds())`
the active effect lights.

The live/replay bench (`?fx=...`, `sandbox/fx.ts`) accepts `weather=rain|snow|storm&wi=<0..1>` and exposes
`window.__hd.setWeather('snow', 0.8)` to change weather through `LiveView.setEnvironment` without reloading.
The development game bridge uses `hd-weather=rain|snow|storm&hd-weather-intensity=<0..1>`. Both default to clear;
rain and snow default to intensity 0.8, storm to 1. Unknown weather values select clear, finite intensity values
are clamped to 0..1, and empty or invalid intensities use the weather default (`src/weatherParams.ts`).

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

**Native radiation, chrono and control links** (`src/live/beams.ts`): the live snapshot's `radBeams` and
`mindControlLinks` share one bounded, additive, depth-tested stroke pool with the existing waves. Type-1 radiation
and chrono rays use their published RGB colour, a single sine strand displaced in world Z, and native age/period
amplitude. The stock Chrono Legionnaire uses the same type-1 path as radiation, with `ChronoBeamColor`
`128,200,255`, period 15 and amplitude 40; the RadBeam enum value named `temporal` is not its drawing path.
The renderer previously ignored the published RGB and drew both as green. Correcting this shared path also
corrects the Desolator strand. HD interpolates the native curve with 64..512 segments, pins its first/last points
to the observed weapon/target coordinates, and adds a soft core, halo and gentle intensity flow. Unlike native
integer stepping, the final sine cannot move the endpoint off the target. No extra strand or impact splash is added.

Mind-control links use the controller house's published colour and one 32-segment world-Z parabolic arch,
`z(t) = lerp(source.z,target.z,t) + 4*arcHeight*t*(1-t)`, with native `arcHeight=512` leptons. A smooth highlight
travels toward the target on the native approximately 1.024-second cycle. The source and target are the reader's
validated weapon coordinates; the renderer adds no head offset. Selection and capture-timer visibility belong to
the observer: a link remains fully lit while published and disappears when removed, with no host-side lifetime
or fade. These auxiliary links and type-1 rays have no additional endpoint-shroud rejection; the shared scene
mask and depth pass still apply. This does not establish pixel parity with native links drawn after shroud.
Unknown/removed effects clear immediately, including publications that change within the same game frame.

`?fx=beams` provides deterministic radiation, chrono, eruption, magnetron, sonic and mind-control rows.
`btypes=chrono,mindcontrol` selects just the new review pair; other accepted entries are `rad`, `eruption`,
`magnetron` and `sonic`. `bprogress=0..1` selects ray age and wave progress (default 0.5); the chrono example uses
the stock period and colour, and the control link is a fixed red-house example. `effects=enhanced` brightens
halos; `time=<seconds>` and `window.__fx.advance(ms)` move only presentation flow, leaving these publications
fixed. For isolated screenshots, use `?fx=beams&btypes=chrono&bprogress=0.5&zoom=3` and
`?fx=beams&btypes=mindcontrol&zoom=3`. CPU geometry, upload, shader-binding and bench-snapshot tests do not
replace an original-versus-HD frozen-pair review of live FLH endpoints, native link selection/expiry, depth or GPU pixels.

`src/volumetricBlasts.ts` adds opt-in procedural 3D fireballs with turbulent lobes, dark internal soot,
a white flash and sun-lit rolling smoke. Use `effects=enhanced&fxvol=ray` in the bench,
`LiveViewOptions.volumetricEffects = 'ray'`, or `hd-fx=enhanced&hd-fxvol=ray` in the development bridge.
The default `off` retains the existing HD/native cards. The layer is exposed as `live.volumetricBlasts`;
its public uniforms support runtime look review. Each blast uses one depth-tested card and at most 28 ray steps,
with two main noise reads and one soot-pocket read per step; self-shadowing is analytic (sun side lit, far side and
underside shaded, broken up by the large-scale noise) because extra density taps toward the sun tripled the step cost.
In the L5 review (four blast types side by side with the redrawn flipbooks, at the target painting's scale) the
procedural volume read as soft, cotton-like lobes without the crisp flame tongues, soot pockets and debris of the
target, and 20 simultaneous blasts cost more GPU time than the flipbooks; it therefore stays an opt-in experiment and
the redrawn flipbooks are the enhanced default.

Set `HD_CACHE_DIR` (or its older alias `HD_CACHE`) to an absolute variant-cache root when starting the development
sandbox to review L3 redraws; the default remains `gameres/hd-cache`. For example,
`HD_CACHE_DIR="$OUT_ROOT" pnpm hd:sandbox --port 15215`.

### SHP vehicle review bench

Serve either cache root with `HD_CACHE_DIR="$SHP_SOURCE" pnpm hd:sandbox` or
`HD_CACHE_DIR="$SHP_VARIANT" pnpm hd:sandbox` (restart the server between roots). Open the printed local origin
with `?fx=shpunits&stypes=DRON&map=XMP29U2&seq=Stand&step=0&zoom=4`. Each type occupies one screen row with
eight clockwise facings, starting at screen-up, matching the redraw sheets. DarkRed (house index 11) is the default
for this bench; `house=<index>` overrides it. Existing `units` and `squad` bench defaults remain unchanged.

`seq=Stand|Walk|Fire` and zero-based `step=<n>` select an explicit pose; `sspace=1` controls spacing.
`animate=2` adds one step every two logic frames after warm-up; `time=0.4` or `window.__fx.advance(ms)` advances
the deterministic bench clock. The ordinary animation loop holds that clock still for screenshots. Steps wrap
inside each facing's sequence. `LiveObject.shpUnitPose` supplies this explicit art pose; when absent, the renderer
continues using movement, fire events and rules timing. Body and shadow always use the same selected frame.

Use identical query parameters and viewport for both cache roots. The bench uses synthetic snapshots and is a
visual review surface, not evidence of native gameplay. The [SHP sheet CLI](../ra2-assets/README.md#shp-vehicle-redraw-sheets-python)
documents preparation and the manual image-editing handoff.

**Live view.** `LiveView.create` without `timeOfDay` follows the map's staging (`dayHour`, a look preset's suggested hour, replaces the staging hour of every map but authored dusk, which keeps its own); `liveView.setEnvironment({ timeOfDay,
weather, weatherIntensity, lamps, windows, lights, mist })` changes it without a reload. Light sources follow the
buildings standing in the match (light-emitting types from `lights.json`; the engine grid is recomputed when that set
changes), lit windows use the type library's masks (`pnpm hd:lights -- --library <theater>`), and fires keep a small
light alive keyed by the engine anim. The shroud is a visibility mask the renderer applies after the mist and before
bloom (`HdRenderer.setVisibility`, which also takes a `VisibilityMask` with its own extent and shaping function: the
live view's per-corner field with the engine-fitted edge), so nothing under black shroud glows through; shrouded
buildings light no windows
and cast no light, except the map's invisible lamp-post dummies, which every player knows from the map. Without a
sidecar the view falls back to land-type surfaces and no map light sources.

Live object fields include optional `imageType`, the engine-selected draw image; `type` retains the rules identity
for ownership, health and events. YR 1.001 tests Harvester at `0x73D2A6` and Unloading at `0x73D2B0`, reads
UnloadingClass at `0x73D2BA`, then swaps Type at `0x73D2C4` and restores it at `0x73D3A2`: docked HARV/CMIN
therefore draw HORV/CMON. Image changes rebuild the visual while retaining animation clocks; missing image art
falls back to `type`.

Optional `underlay { art, frame, x, y, z }` is one frame of effect-library art the engine draws inside the
object's own picture right before its body; YR sends the ore-gathering sparks of a harvesting miner (`OREGATH`, see
docs/remaster/HD_BRIDGE.md). `objectUnderlayCard` turns it into a ground-pass decal of the effect sprite layer at the
engine's point: the body, standing above the ground, covers it where they overlap, and ore, ground and shadows stay
under it. Unit shadows are depth-writing planes a little above the ground (`voxelShadow.ts`), over ordinary effect
decals, so the underlay is pulled `UNDERLAY_DEPTH_PULL` (0.1 world units) along the view in front of the ground under
each pixel: above every shadow layer, and behind a unit body from its third pixel row up (a body's depth is a card
standing on its lowest row). The pull is applied to the anchor together with the decal's own lift, so the art stays on
the engine's pixel. It is opaque, scene-lit with the art's palette (no glow lift: it turned the pale grains white in frozen
pairs), follows the engine frame on every snapshot and is skipped for a hidden owner or a shrouded point. In the
enhanced effect style an `effects-hd.json` entry of the same id replaces the pixels, held for the whole engine stage;
its warm pixels are self-lit like other HD flipbooks, which is what keeps the sparks orange and readable.

Optional `nativeHidden` suppresses the complete live object, including shadows and HD extras. The YR reader
uses this for tethered UnitClass vehicles whose validated building radio link has effective or queued Unload 16
and canonical door booleans, unless that building draws the vehicle itself (effective Unload, its own tether byte
set, the vehicle among its radio links): a vehicle leaving a war factory is drawn. All four door states qualify.
Optional `translucent` is body opacity: the reader
publishes 0.5 while either native chrono byte is nonzero, and SHP/voxel body parts blend at 50% without writing
depth; shadows stay unchanged. Omitted fields retain normal rendering. These are independent predicates, and
the chrono flags alone never hide the object. Selection brackets remain the game's native overlay; LiveView
does not generate selection geometry. This does not establish a CMIN-specific invisibility window.
CMIN's normal teleport path clears the WarpingOut byte and timer immediately for harvesters. A reported invisible
arrival therefore requires a native render/present trace, including locomotor state; a matching logic-frame number
alone cannot distinguish body suppression from a framebuffer that still shows the miner before relocation.
Attached anims, particle systems and fire events follow the hidden owner's UID/pointer match, including same-frame
hide/unhide; independent explosions and projectiles retain their native publication lifetime.

Optional `tint` (`{ light, add? }`, `src/objectTint.ts`) is the game's change of a whole object picture on one frame:
a factor on its light level (the Iron Curtain's pulse between 0.2 and 0.5 and its flashes to 2) and a colour added
afterwards (the Force Shield's blue, a Berserk unit's red). It is per-instance data of the sprite layers (`spriteTint`,
two floats beside the anchor; shadows, contact shades and reflections stay untinted) and a per-mesh uniform of the
voxel materials (`objectTint`, set through `VoxelUnit.setTint`), applied to the finished colour in display scale and
limited so that level x factor stays within the engine's cap of 2. Nothing about a tint selects a material: the shader
text and the pipelines are the same with and without it (`tests/objectTint.test.ts`).

Live technos may report `contactUid`, the validated radio contact's stable ID in the same snapshot. Buildings also
report `dock` (refinery, repair or helipad policy) and `unloading: 'door' | 'roof'` while their effective mission is
Unload. The YR reader instance latches a previously published roof during that continuous Unload when link 0
is released. It resets on another effective mission, missing buildings or changed pointer identity (UID/type),
prunes entries not seen in the latest read, and still omits unreadable roof state. The renderer consumes this
policy without reading missions or links. A completed delivering building with both matching library layers replaces its body/shadow with
`DeployingAnim` and queues `UnderDoorAnim` immediately after it; roof delivery uses `RoofDeployingAnim` and
`UnderRoofDoorAnim`. The replacement remains through link release and logical door closing until effective
Unload ends; it uses the native `buildingFrame` stage/damage offset, without restarting the stage or deriving it
from logical door openness. The body uses the native inclusive half-count cap from the source `frameCount`
(foreground plus shadow array lengths for legacy entries), including the source shadow-half frame at that
boundary; the door uses healthy/damaged frame 0/1. Native DrawIt's null-contact branch defaults to
ground delivery; the retained roof latch is a separate observed compatibility policy.
Both cards retain their anchor, palette/remap routing and geometry placement. With an extracted native depth
template, the replacement body uses BUILDNGZ with `NormalZAdjust = -20` for door delivery or -40 for roof delivery;
the interior card uses native gradient 0 with k=1. Opaque foreground posts keep their body depth, so the floor
plane and posts can occlude the same unit differently. Missing/empty pairs retain the ordinary body. Queued Unload
alone does not open the door unless CurrentMission is the -1 sentinel. The pair is drawn one logic frame after the
published state, on appearing and on leaving: `BuildingVisualHistory.shownUnloading` returns the `unloading` value
of the first publication of the previous logic frame, because the native picture at a counter stop is one logic
frame older than the state read after it. Without an observation of exactly the previous frame (first sighting,
frame gap, rollback) the current value is drawn.

A vanished drawable building retains its frozen visual through the logic frame after the last one it was
published in, and expires when a later frame arrives. The deadline counts from the last present frame: the engine
removes a building in the middle of a tick, so a poll can miss it under the old frame number. The last published
health need not be zero: a fatal hit and removal can occur between polls. Selling, native-hidden objects,
pointer/UID replacement, larger frame gaps and rollback do not retain it; repeated polls of a frame do not extend
the lifetime. This is a bounded presentation heuristic, not established exact native frame
parity: the normal prelogic render can leave old pixels, but native wait paths can render after the frame increment.
Exact parity is `UNCERTAIN`; live original/HD acceptance is `UNVERIFIED`. See the
[native eligibility and presentation evidence](../../docs/remaster/research/painter-order.md#native-draw-eligibility-and-body-translucency).

Supplied frozen native GAWEAP `5x3`, NW `(58,98)`, SHAD evidence: frame `9171`, CurrentMission `5` / queued `16`,
link 0 SHAD, Z `208`, has a closed roof. Frames `9184/9208`, mission `16`, same link/Z, show RoofDeployingAnim and
heli parts inside. Frame `9235`, mission `16`, released link and Z `368`, still shows an open roof with the heli
rising; the reader latch preserves that roof. Frame `9278`, mission `5`, link NULL, Z `798`, also shows an open
native roof for an unexplained reason: this remains `UNVERIFIED` and outside the latch. Frame `9342` is closed
in both views. These frozen observations do not establish new HD runtime acceptance.

**Native depth.** The optional library `depthTemplate: { file, width, height }` supplies already transformed
BUILDNGZ bytes. `LiveLibrary` validates their exact size and shares one unfiltered R8 texture across sprite atlas
pages; its owner releases the texture. Absent metadata retains the analytic building fallback. Declared malformed
or unreadable bytes are reported as a load error, rather than silently selecting another depth model.

`src/ra2/nativeDepth.ts` expresses native Z as nearness in camera-space world units, with `G = GROUND_DEPTH` per
native ground row and V=G/3. At body-relative pixel offsets px,py, foundation W,H and point move mx,my:

```text
A = (198 + mx - 30*(W-H), 446 + my - 15*(W+H-2))
beta = frame.offset.y + min(frameHeight, templateHeight - A.y - frame.offset.y) - 1
push_body = (beta + 1 - NormalZAdjust + int8(template[A + floor(px,py)])) * G
push_ground = (py + k) * G
push_card = (e + c + floor((e - py) / 3)) * G
```

Body template coordinates clamp at the edge for HD fringe pixels. Construction/selling ignore pointMove, and
foundation width W>=8 uses a card with c=1-NormalZAdjust instead. Body depth depends on the current clipped frame
bottom and template, not art Height. Attached animation and light/conveyor cards inherit the owner's body depth
with their existing part bias. Bib k=2, door/roof interior k=1 and test-only DoorAnim k=6 reproduce the ground-like
parts; the former door/roof recess constants and rectangular infantry-hiding workaround have been removed.
DoorAnim's no-write material also needs to draw before passing units: disabling depth writes alone would still
let a later door overwrite a unit's color. Body, read-only DoorAnim and native ground-unit passes use render orders
4, 4.001 and 4.002. Ground SHP cards use a child over shared instance buffers; ground voxels use cloned materials.
Both unit paths join the transparent queue with depth writes enabled, preserving internal/overlap depth while
enforcing the door-before-unit color order. Airborne and shadow materials keep their physical behavior.

For ground SHP vehicles/infantry, e is the current frame's inclusive bottom; c=0/12 respectively. A type marked
`harvester` gets c=13 while its current cell lies in a `refinery` foundation, independent of docking contacts or
missions. Voxel vehicles/landed aircraft use the same card. e is the lowest projected corner of each part's own
bounding box as it is posed (turned, tilted on a ramp, turret/barrel articulated; shadow twins excluded) plus the
engine's bitmap margin: YR 1.001 `0x754510` sizes the voxel surface as the projected bounds plus eight pixels and
places it four pixels before their minimum. (A world-axis box around the posed parts overshot by up to a third of a
cell for a body turned 45 degrees or tilted, and a vehicle then drew over the tree it stood behind.) Building voxel
turrets use their own bottom and c=-1-turretVoxel.zAdjust. Trees are the engine's own Z writers: measured in the
tactical Z-buffer (global `0x887644`, frozen-frame dumps), a tree is a card from its frame's inclusive bottom row,
one unit nearer per three rows up and 12 to 13 units nearer than the ground at that row. `terrainObjectDepth` gives
static trees that card (c=12, `writer`), and `SpriteLayer` keeps writer cards in the depth-writing body pass instead
of the late unit pass. A vehicle therefore shows in front of a tree only when its bitmap bottom is more than nine
rows below the tree's. Where the two cards cross, the per-fragment depths cannot decide cleanly: each card steps at
its own row phase and the voxel keeps 6% of its physical depth, so for about one row of travel the tree showed through
the hull in stripes (sandbox sweep of a frozen frame in half-row steps). `TerrainObjectCards`
(`src/ra2/terrainObjectCards.ts`, filled by `loadRa2World`, passed to `updateVoxelNativeDepth` by the live view)
decides that case for the vehicle as a whole: unless every part of its posed bounds is in front of an overlapping
tree, its card bonus is lowered until all of it is behind (at most about three units). The engine compares integer
cards and draws a tree over every unit registered before it, and the original's frozen frame at such a tie shows the
tree in front. SHP units keep their plain cards. `src/ra2/voxelNativeDepth.ts` pulls physical fragment depth
94% toward the card, retaining 6% to order internal faces; its error is bounded by 6% of the fragment's original
distance from the card. Flight and shadow passes keep their existing behavior. The additive painter bias,
CARD_CLEARANCE, other terrain/effect paths and fireball capture codes remain separate.

Synthetic refinery dock, factory doorway, barracks spawn/stairs, signed-byte and WGSL/layout regressions cover
these contracts. The source native body formula matched 9,316/9,370 opaque pixels in a supplied refinery Z dump
(the rest were overwritten by later nearer draws); current HD WebGPU rendered-pixel parity remains `UNVERIFIED`.
The native addresses, bounds and remaining approximations are recorded in
`docs/remaster/research/painter-order.md`.

Live cell overlays (`src/live/overlays.ts`) draw each overlay's library frame at its cell. Upright pieces (walls,
fences; not flat overlays, not bridge decks) carry `overlayTieBias`: 0.0008 of nearness per step of x + y, starting
over every 64 diagonals (0.05 at most, under `CARD_CLEARANCE`). Below its base line a card follows the ground, so
where two neighbouring pieces overlap their depths were equal and rounding picked the winner row by row (stripes at
wall corners); now the piece of the nearer cell shows, as the engine's back-to-front cell order has it. Rubble
overlays (`LibraryOverlay.rubble`, rules IsRubble) never draw their own image: the carrier cell named in the
snapshot's `overlays.rubble` draws its destroyed building's body frame 3 and shadow with the overlay's ISO palette,
lighting and flat flag, exactly like YR 1.001 (evidence in `docs/remaster/LIVE_OVERLAYS.md`); other rubble cells stay
empty.

## What v0 covers

- RA2-exact projection: 2:1 dimetric orthographic camera, 60x30 px cells, 15 px height levels (`src/world.ts`).
- Terrain: height field with smoothed shading normals, per-pixel procedural materials, soft class borders, wet
  surfaces, puddles, wet shore band, border shroud (`src/terrain.ts`).
- Water: analytic sky reflection, sun sheen, depth tint from the terrain height texture, shoreline foam, rain rings
  (`src/water.ts`). Original maps shade their water per pixel on the terrain (`src/ra2/waterLook.ts`, below).
- Weather: world-anchored GPU rain streaks, masked splashes and dry snowflakes (`src/weather.ts`).
- Lighting: fixed classic sun azimuth, time-of-day keys, overcast, soft shadows for the procedural scenario
  (`src/lighting.ts`). Original maps take no sun shadows (see below).
- Effects: instanced fireballs, flame tongues, smoke, sparks, scorch decals, light-field flashes, camera shake; with
  garnish options (the live view) only a small flash, sparks and light on top of the original art (`src/effects.ts`).
  The live view's opt-in `enhanced` effect style (`ENHANCED`) adds, around the engine's own anim: a boiling fireball
  over native art for its duration (original fire colours), a warm light on the ground and on units next to the blast
  (strongest over the first 0.8 seconds, gone by about 1.2), fewer sparks and brief airborne embers,
  heat shimmer, a ragged ground dust ring, and lobed billows with sunlit tops and dark undersides.
  Billows and larger blasts' column puffs form over the first second and are gone by about four seconds after the blast.
  Four rolling lobes and uneven density break up each puff, ageing from young soot to neutral grey. Puffs are at most
  1.8 world units wide at birth (`maxSize`; a merged collapse fireball is several cells wide, and art-sized puffs merged
  into one flat sheet) and grow at most about 1.5 times. Over puff ages 0.3-1.0 seconds, opacity reaches a 0.6
  multiplier for billows and 0.8 for column puffs, with final late alpha capped at 0.5, so units under late smoke stay
  readable. The same ramp shrinks lobe radii by 0.15 (`lateOpacity`, `lateFrom`, `maxLate`, `lateEdge`), retaining the
  fire glow underneath young smoke. HD puffs over trail anims (SMOKEY2 behind flying debris, missile
  trails) stay at most 0.4 world units wide and 1.2 seconds long in the enhanced style (`ENHANCED.trail`): a building
  death's dozens of trail puffs accumulated into a grey sheet with depth-cut edges, while without them the native trail
  art shows as raw octagonal dots.
  Billows, column puffs, halos, garnish flashes and procedural blast cards take depth from a vertical card through
  their centre's ground point, switching to the ground plane below its base. This depth uses the shared card clearance
  plus `anchorBias` (0.5 world units), so lift and growth do not pull smoke over foreground units; shadow passes keep
  physical depth. Explosion fire puffs and explosion halos add the bounded sphere profile described below; smoke,
  muzzle and electric garnish keep the original anchor profile. Ground heights are interleaved with particle origins
  to stay within the WebGPU vertex-buffer budget. A negative garnish-fire cover encodes an explosion as `-(1 + cover)`;
  halo modes `-1` (HD explosion) and `-3` (native-art explosion) select volume depth without changing colour/intensity.
  Optional HD flipbooks enlarge explosions, collapses and debris by 1.3 and impacts by 1.15 around the native draw
  point, with matching garnish footprints; other categories and native cards keep their size. Enhanced debris throws
  6 + 12 chunks per scale, slightly larger than L5's (`ENHANCED.debris.size` 1.35) and dark faceted rubble colours that
  read as silhouettes against the fire (bright sunlit facets read as grey slabs floating in the fireball). Airborne
  chunks stretch along projected velocity with thinner streak ends, then stop, rest for 0.9 seconds (0.7-1.3 times)
  and fade over 0.6 seconds. Capped flight speed keeps the complete lifetime below 2.5 seconds. Each chunk has a soft
  ground contact ellipse that follows its ballistics and weakens with height. Shadows draw at 5.5 and cut-out rubble
  (`alphaTest` 0.5) at 5.9 without writing depth, before smoke at 6 and effect cards at 7: later smoke and fireball cards
  cover the chunks they overlap, so no chunk shows as a dark speck on a fireball's white-yellow core.
  Blasts within 2.5 cells and 2.5 seconds share hard ceilings of 36 chunks, 10 billows and 3 column puffs (`BLAST_CROWD`),
  with later-blast floors of two chunks, one billow and zero column puffs while allowance remains. Craters receive a
  0.3-second flash of thin emissive cracks along a noise-broken rim plus scattered ember specks (coverage alpha 0.25,
  `gain` 1.8, hot orange cooling to deep orange), over one charred noise decal per death/place: blasts within 2.5 cells
  share the mark for its 9-second lifetime. A building death's char covers its foundation (the larger member span plus
  one cell), capped at 2.5 world units; other blasts use the art-relative width with the same cap. The decal darkens in
  within 0.15 seconds, peaks at alpha 0.35, has no glow and disappears within 9 seconds. The engine's own crater smudge
  stays as the lasting mark.
  Redrawn HD frames are graded in the shader: flame pixels are self-lit and re-mapped through a temperature ramp with
  a heat gamma (`HD_FX_GAMMA`), only the white-hot core gets a modest HDR gain for the bloom (`HD_FX_EMISSIVE`), the
  anim's translucency fade is softened by separate smoke and flame exponents (`HD_FX_FADE`), and consecutive frames
  crossfade only around mid-stage (`HD_FX_BLEND_WIDTH`), so chaotic flame does not read as a double exposure. The
  matching `EffectSpriteLayer` uniforms (`hdHotGain`, `hdFireGamma`, `hdSmokeFade`, `hdFlameFade`, `hdBlendWidth`)
  support look reviews. The L5 explosion flipbooks (`packages/ra2-assets/python/volumetric_explosions.py`) are drawn
  as layered volumetric fireballs and rely on these values. The fix-round ramp keeps red for the coolest flame (the
  fringe), spends the middle heats on orange and yellow-orange and ends in a warm white, with a heat gamma of 1.25
  (L5: a red-heavy ramp with gamma 2.3 turned the mid-life fireball red-orange around a dark core). Low-coverage
  pixels count as added light only when they are coloured (fire glow, arcs); neutral low-coverage smoke rims are
  scene-lit, which removed a white outline around redrawn smoke.
  An anim whose effect-table row says `asPainted: 1` is shown as its sheet is painted: at the original's size
  whatever its category (`hdSize` answers 1, for the card and the garnish around it), outside the fireball merge
  (neither a lead nor absorbed), without the flame re-map and without the white-hot gain; its fire is still
  self-lit at the painted colour and its smoke still takes the scene's light. The flag is effects data, not renderer
  code: `HD_AS_PAINTED` in `packages/ra2-assets/src/node/effectsLibrary.ts` lists NUKEANIM (the nuclear mushroom: a
  pure yellow stem and a pale cap that the ramp turns orange) and CDGAS (the Chaos Drone's red-pink gas, 89 % of
  whose coverage passes the fire test), and the generator writes it into the table. On the card it travels in the
  sign of the size (`packHdSize`), so no vertex buffer is added; `hdFlameGradeDisplay` is the grade's CPU twin. HD cards of the ground and air layers are
  depth-tested like the native cards (only Top is untested). Native `Layer=air` draws over the ground layer. The final P-L5H-3b policy is per **(fire, object)**:
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
  materials read a code from the rendered mesh's object-group uniform. Sprite flags component 8 (stride 17;
  non-capture stride 16) stores the instance code or **-65504** for capture-only discard. Sprite paths retain six
  buffers: main/capture has 11 attributes (10 without capture), ground passes at most 10. Native/HD Air effect
  cards retain six buffers/eight attributes. Native ground-unit sprite children share instance codes and capture
  registration; DoorAnim's test-only child is excluded. The last native flags scalar selects main (0), test-only
  (1) or ground-unit (2) draw pass without another attribute or vertex buffer.
  Codes are horizontal anchor coordinates relative to this frame's `IsoCamera.target`, near view centre.
  Cards use instance anchors; garnish uses each particle's current x/z, including drift/ballistics/wobble.
  With `u=2^-11`, RG encode/decode plus reduction code storage error is bounded by
  `abs(code)*((1+u)^2/(1-u)-1)+2^-20`: <0.011728 cells at |code|<=8, <0.046907 at |code|<=32.
  Wider views increase the bound; no arbitrary-zoom precision claim is made. Capture MRT writes `R=code*a,G=a`
  using original normal blending: over clear `(code*a*b)/(a*b)=code` (b=a). Same-anchor parts preserve the ratio;
  different transparent owners produce weighted code mixtures requiring pixel review. A capture-only MRT
  keeps vec4 shader output on RG16F because r186's normal RG conversion drops the source alpha. Its merge retains
  the capture's authoritative code/coverage outputs when a material carries its own MRT (including self-lit art).
  Main/mirror outputs remain independent. See three.js 0.186.1 `MRTNode.setup`/`NodeMaterial.setup` and GPUWeb CTS
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
  Clustered explosions merge (`FIREBALL_MERGE` in `src/live/effects.ts`, enhanced style with HD flipbooks): the
  blasts one snapshot spawns within 2.5 cells of each other (a building's Explosion= list) form a group whose most
  fiery blast is drawn at the group's centroid, enlarged by 0.15 per member up to 1.7, with one garnish for the
  whole group; the others draw nothing. Later blasts within 1.6 cells of a member join for 0.5 s (the lead grows
  smoothly), after which a later group starts a second lead (at most two per 2.5 s). A merged lead's depth comes
  forward by its members' spread plus 0.5 world units (`EffectInstance.depthBias`), so it engulfs the dying
  building without covering units beyond its legacy footprint. The effective front is the **maximum** of that legacy
  profile and the sphere, not their sum: overlapping engulf profiles must not extend the lead's reach twice.
  A lone blast has only the bounded sphere profile and keeps its original merge size.
- Post (`src/HdRenderer.ts`, `src/post.ts`): per-channel exposure, mist and shroud visibility, bloom of the scene
  `output` only, the display transform and cinematic grade, then the unbloomed emissive overlay in display-linear
  colour **before** `renderOutput` encodes sRGB. The same composite applies at night and with neutral grading;
  emission is multiplied by pixel shroud visibility. Night toe lift, anti-aliasing and sharpening follow as before.
  With positive `sourceLights`, debug view `none` and supported MRT blending, the scene adds an `emissive` attachment
  alongside painter physical depth when enabled. Overlay materials attenuate the scene underneath by alpha and
  alpha-over their colour into emission. Other materials write zero emission RGB with their final output alpha and
  `MaterialBlending`: opaque foreground art clears it, transparent foreground art attenuates it, additive effects
  add zero. Faithful (`sourceLights=0`) retains the original pipeline key and graph without an emissive attachment.
  WebGL2 without indexed draw-buffer blending and diagnostic views omit the overlay.
  Before each scene render list is built, the overlay checks the renderer's actual MRT for `emissive`, restoring
  visibility after nested renders. In three r186, `src/nodes/utils/ReflectorNode.js` clones the camera (including its
  layers) but explicitly sets MRT to null for mirrors; the attachment check therefore excludes both meshes from
  reflections and any other no-emissive pass without punching dark holes. See HdSettings below.

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
| `antialias`  | `'edges'`    | `'edges'` (single-sample scene pass, outlines smoothed by the last pass: see "Outlines"), `'msaa4'` (4x multisampled scene pass), `'fxaa'` or `'none'`; the last three are for comparisons.                                                                                                                                                                                |
| `sharpness`  | `1`          | RCAS sharpening after the display transform (0 strongest, 2 off, below 0 disabled).                                                                                                                                                                                                                                                                                        |
| `debugView`  | `'none'`     | `'overbright'` marks exposed luminance above 1; `'voxel-xy'` / `'voxel-z'` write voxel palette index, world normal and corner occlusion raw to the screen, for fitting the voxel lighting against captures of the original; `'silhouette'` writes the silhouette codes to red and green as byte values.                                                                    |

Call `applySettings()` after changing a setting; structural changes rebuild the post pipeline and free its previous
targets, while uniform changes update the existing pipeline.

GPU memory of the post targets at 2400x1500 device pixels (estimated from their formats): with `'msaa4'` the scene
colour takes about 115 MB multisampled (RGBA16F) plus a 29 MB resolve texture and its depth about 58 MB; with
`'edges'`, `'fxaa'` or `'none'` about 29 MB and 14 MB. The bloom chain (half resolution and below, RGBA16F) adds about 20 MB and
the sharpening target about 29 MB. Live painter ordering adds an RGBA16F physical-depth attachment: about 29 MB
single-sampled, or 115 MB multisampled plus 29 MB resolve with `'msaa4'`, at the same resolution. When enabled,
the emissive overlay adds another RGBA16F attachment of the same size (29 MB single-sampled, or 115 MB plus 29 MB
resolve with MSAA). These are format
estimates, not measured full-match memory or performance. Every mid-pass copy of the scene colour (three's viewport textures, e.g. a
backdrop-sampling effect material) ends and restarts the scene pass; under `'msaa4'` that stores, resolves and reloads
the multisampled target, about 0.5 ms per copy at 2400x1500 on an Apple M-series GPU against about 0.1 ms
single-sampled, so layers should copy at most once per frame and only while they draw.

## Enhanced look (opt-in, `src/ra2/spriteLook.ts`)

Modern light on the original art, off by default: with effect strengths at 0 and lighting depth gains at 1 the frame is the faithful one bit for
bit (the sprite shader skips the whole branch; checked by render hash on XMP29U2). `LOOK_PRESETS` / `applyLookPreset`
name `faithful`, `golden` and `cinematic` (golden afternoon: every effect on, the sun arc, exposure adaptation, hour
16.5). Sandbox: `?look=golden`, single overrides `?relight= ?contrast= ?spec= ?glass= ?ao= ?shfollow= ?shsoft= ?wetrefl=
?sunpath=fixed|arc ?adapt= ?vsheen= ?vsheencap= ?vao=` and the "现代光影" GUI folder (`sandbox/look.ts`).

`?look=cinematic` adds the approved S2 direction with medium cooling to `golden` at 16.5; both enhanced presets select
enhanced water unless `water=` overrides it. Calibration controls in "现代光影" also accept URL overrides after the preset:
`wbadapt` (`whiteAdapt`, 0..1), `gbal=r,g,b`, `gcon` (-0.5..1), `glift`, `gsat`, `gshadow=r,g,b`, `ghigh=r,g,b`.
White adaptation geometrically balances exposure toward the current flat-ground irradiance without changing its
luminance. The display grade runs after tone mapping, before sRGB encoding and the night toe lift; it skips debug
views and fades out with the night weight, as white adaptation does. Defaults and the `faithful`/`golden` presets are
neutral and omit the grade node entirely. Grade values update uniforms; only switching between neutral and active
grading rebuilds the pipeline. The `cinematic` values are calibrated by material class (neutral greys, greens, warm
surfaces, blue/teal) against the three approved target framings (XMP29U2 city park and battle, RiverRam river): neutral
greys land within about 1-3 b* units of the targets (golden: 7-9 units warmer); the remaining gap in local contrast is
in the art and lighting, not in the grade. Cinematic white adaptation is 0.85: 15 % of the afternoon sun's colour
stays on flat ground, which warms the open battle grass from the light. The targets flip the originals' grass order
(original battle grass greener than the park lawn, target battle grass golden and park lawn green) on the same
foliage, so neither a tile hue nor a global grade can serve both framings; the remaining battle-grass gap
(S-weighted hue 62 against 52) is a known trade-off for the owner's green park lawn (hue 58 or more).

Lighting depth gains are plain numeric settings read every frame, with uniform updates and no shader rebuild.
Defaults, `faithful` and `golden` use 1 for all six; only `cinematic` uses the initial gains below, pending rendered
review. The FX sandbox (`sandbox/fx.ts`) accepts overrides after the preset, for example
`?look=cinematic&set=sunGain:1.3,specularSize:1.8,aoPower:1.4,contactShade:1.5,shadowLength:1.4,shadowDarkness:1.15`.
The gains remain dormant when the enhanced look is off. Neutral AO and roughness take the original value; neutral
shadow stretch takes the original calculation, and other neutral gains multiply by exactly 1.

| Setting                                         | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `relight`, `lightContrast`                      | Building and tree art relit by the sun as a delta on its baked shading: each pixel scales by (irradiance of its normal under the current sun and sky, relative to flat ground) / (the same under the art's own light, `ART_LIGHT`). Exactly 1 under the art's light.                                                                                                                                                                            |
| `specular`                                      | GGX sun highlights on facades and roofs (and the sheen of wet surfaces).                                                                                                                                                                                                                                                                                                                                                                        |
| `glass`                                         | Window panes of the material atlas mirror the sky (stylised street-level mirror, tinted by the pane, a smooth tilt field over the facade) with a sun glint on the inside of full panes.                                                                                                                                                                                                                                                         |
| `occlusion`                                     | Baked occlusion of the material atlas (wall feet, roofs next to higher tiers) and soft ground contact decals around foundations.                                                                                                                                                                                                                                                                                                                |
| `shadowFollow`, `shadowSoftness`                | SHP shadow decals turn and stretch about their object's base with the sun (voxel shadows turn with them); their penumbra grows with distance.                                                                                                                                                                                                                                                                                                   |
| `wetReflections`                                | Upright art mirrored about its base line on wet paving (short, rippled, strongest in puddles).                                                                                                                                                                                                                                                                                                                                                  |
| `sourceLights`                                  | HD building emitter gain: default and `faithful` 0; `golden` / `cinematic` 1. The Tesla reactor adds a small blue ground pool, an unbloomed glass tint and thin internal lightning with at most one short cradle strike; the Tesla coil, war factory doors and Soviet refinery furnace add smaller lights (mostly after dusk).                                                                                                                  |
| `mapSourcesByDay`                               | Share of the map's light sources (lamp posts such as `INGALITE`) in the map's day light: 1 (the engine's) in the default and every preset. A reduced share (0.2 was tried for `cinematic` against a concept image of the lamp-lit park) leaves everything near a lamp post darker than the game draws it: a frozen XMP29U2 pair 7.6 cells from a post measured ground 0.90, vehicles 0.83 and a civilian building 0.74 of the native luminance. |
| `sunPath`                                       | `'arc'`: `Lighting.sunArc`, east in the morning, over the camera side at noon, west in the evening (the art's azimuth at 15:00); `'fixed'`: the classic azimuth.                                                                                                                                                                                                                                                                                |
| `adaptExposure`                                 | Lifts early and late daylight towards noon's flat-ground brightness (the colour of the light stays).                                                                                                                                                                                                                                                                                                                                            |
| `voxelSheen`, `voxelSheenCap`, `voxelOcclusion` | Voxel highlight strength and cap and crease occlusion (`vpl.ts`); null leaves the voxel material as configured.                                                                                                                                                                                                                                                                                                                                 |
| `sunGain` (neutral 1; cinematic 1.25)           | Multiplies the sprite relight sun weight without changing its sky weight; the upper factor limit becomes `2.4 * max(1, sunGain)`. Also scales VPL/PBR voxel direct light and projected-vehicle Lambert/form/relight sun terms; their ambient and reference terms stay unchanged.                                                                                                                                                                |
| `specularSize` (neutral 1; cinematic 1.6)       | Scales facade/metal GGX roughness (cap 0.9) and highlight intensity by its square. Glass retains a tighter lobe with square-root roughness scaling. Applies to sprite GGX/glass glints, voxel GGX (the VPL sheen cap still applies), and both projected-vehicle Blinn-Phong glints (exponents divided by the size squared).                                                                                                                     |
| `aoPower` (neutral 1; cinematic 1.5)            | Raises baked sprite AO and voxel crease AO to this power, bypassing `pow` at 1. Includes VPL, PBR and the projected vehicle's mesh form AO; baked occlusion inside redraw textures cannot be separated.                                                                                                                                                                                                                                         |
| `contactShade` (neutral 1; cinematic 1.5)       | Multiplies foundation contact alpha (`0.42 * contactShade`, final alpha capped at 0.85) and the terrain's contact darkening only while the enhanced look is enabled (darkening cap 0.85). Faithful terrain keeps its original contact attribute.                                                                                                                                                                                                |
| `shadowLength` (neutral 1; cinematic 1.4)       | Multiplies the elevation-derived SHP/voxel stretch and its cap (`MAX_SHADOW_STRETCH * shadowLength`), only with `shadowFollow > 0`; partial follow still blends from the original transform.                                                                                                                                                                                                                                                    |
| `shadowDarkness` (neutral 1; cinematic 1.15)    | Multiplies enhanced building/vehicle SHP and voxel shadow opacity (cap 0.9). Their faithful path keeps `ENGINE_SHADOW_OPACITY`; infantry footprints have their own setting (`infantryShadow`). Voxel shadow materials and uniforms share one renderer context and lifetime.                                                                                                                                                                     |
| `infantryShadow` (neutral 1; cinematic 0.35)    | Core opacity of the infantry footprint in an enhanced look (linear light): 1 is the original's solid black blob; 0.35 shows the ground under a soldier at about half its brightness, together with the soft contact shadow the HD body pages carry. The faithful look always uses 1. Shape, place and fringe of the footprint do not change.                                                                                                    |
| `clarity` (neutral 0; cinematic 0.55)           | Mid-scale local contrast on the display image: the luminance band between Gaussian blurs of 1.25 and 5 view px (CSS px by default; engine px in the live view, which reports its device pixels per engine pixel through `setBufferScale`) is added back this many times (shaded side at half strength, mid-tones only). 0 leaves the pass out of the pipeline.                                                                                  |

Building emitters are authored in `src/live/buildingLights.ts` (`BUILDING_LIGHTS`); foundation fractions and
engine-pixel head heights come from the live type library. `LiveView` owns a pure `BuildingLightGate`: completed
(`done`) buildings are eligible; undefined state is eligible only for buildings already in the first snapshot or
following 30 consecutive logic frames of undefined state without a building/selling state. Repeated presentation
frames cannot advance that wait. This suppresses the engine constructor sentinel's placement flash before build-up.
Dead, shrouded and unknown-foundation objects emit nothing; disappearance/shroud removes their sources immediately.
First-snapshot sandbox objects with undefined state start fully lit, including the 0.7-second review bench.

`LightField.source()` keeps refreshed sources alive and shares its configurable `SourceSpec.fadeIn` ramp with the
visible overlay (default 0.25 seconds; NAPOWR 0.5 seconds). The NAPOWR orb fades its alpha with that ramp and starts
arcs only above half fade. CPU electrical flicker drives both pool intensity and orb brightness (amplitude 0.12).
Other building glow specifications remain unchanged. Switching source gain to zero clears the sources and overlay.

NAPOWR alone sets `BuildingLightSpec.activeAnim`: its glow represents native `NAPOWR_A`, which redraws
the blue sphere and lit walls (`DetailLevel=2`, `ActiveAnimPoweredSpecial=true`); the type has no `Light*`
keys and its body alone shows pale glass. Optional `LiveObject.activeAnim` distinguishes `none` (no anim),
`shown` (native draw allowed) and `detail` (native draw suppressed by Invisible, options detail or frame-rate
detail). `none` removes the pool, orb and arcs immediately; return restarts their existing half-second fade.
`LiveViewOptions.nativeDetail` defaults to `'ignore'`, keeping `detail` lit to present game state independently
of native renderer load. Use `'mirror'` or the development bridge URL parameter `hd-native-detail=mirror`
to turn `detail` off too for original/HD reviews. Undefined state keeps the existing policy for sandbox,
replay and unknown reads; other building light types remain unchanged. Optional snapshot `nativeDetail`
contains the native renderer's FPS, low-frame-rate flag and options level, not HD settings.

The user verified YR 1.001's dynamic-detail fallback with 519 normal-speed samples at 250 ms: the native
low-frame-rate flag was equivalent to an unlit sphere with zero exceptions, FPS 1..19 and unchanged
building/anim bytes and layer order. Stock hysteresis suppresses detail-2 art below 15 FPS until 20 FPS.
These off windows are renderer fallback, not delayed lights or game-state changes. Address evidence and
validation boundaries stay in [HD bridge research](../../docs/remaster/research/hd-bridge-fields.md#activeanim-and-native-dynamic-detail).

The reactor uses `SHAPE_SOFT`: a Euclidean, world-space radial pool centred on the foundation centre, radius 1
cell, no exclusion hole, weight `(1 - smoothstep(0, 1, distance / radius))^2`. The field's existing up-to-eight
texels per cell and linear min/mag filtering keep the profile continuous across cell boundaries. Its night irradiance
is `[0.45, 1.25, 7.6]`, with day share 0.11 (day luminance about 0.17 before flicker, within 2 % of L5G). The smaller
pool confines the tint to the reactor's own 3x2 foundation instead of washing neighbouring pavement and facades blue.
Rectangle-edge pools and foundation holes remain available for other sources, including the refinery.

A source's `groundOnly` share is summed as luminance in the field's alpha channel, independently of RGB. Upright
building sprites sample this share inside their own foundation instead of the ground in front of the card
(`objectLightAt`), retaining `NEIGHBOUR_GROUND_SHARE` (0.3). Ground, pads and units still take the pool. Ground,
cliff walls and sprite diffuse lighting clamp the **summed** added local term to display-white headroom, scaling its
RGB equally: `k = clamp((1 - max(base)) / max(max(added), 1e-4), 0, 1)`. The base estimates the surface's own current
lit colour in the same units. Lamp-lit sandstone cannot accumulate a white veil; pools and fire/explosion light
within dark-ground headroom remain unscaled. This replaces per-source lamp gains; the clamp is dormant with
`sourceLights=0`, retaining faithful local-light rendering.

The owner read the earlier white core and outward lightning as "a Tesla coil about to explode". The original is a
glass globe with lightning inside: energy stays inside the machine. The HD art's own `NAPOWR_A` frames paint the glass,
lightning and cradle crackle, so the overlay only tints the glass and adds thin internal lightning with a short cradle
strike. It uses the generic `src/emissiveOverlay.ts`, outside bloom and `BeamLayer`.

The clipped orb matches the art's measured glass radius (17.75 engine px, 0.418 world units) with no halo;
its head remains at foundation [0.47, 0.40], 27 px up. A screen-space occluder wedge at (+11.5, -1.5) engine px,
between -22 and 90 degrees in the y-down frame, preserves the front-right tower overlap. Radial and wedge edges
use derivatives for roughly one device pixel of antialiasing. The hot, mid and body colours are blue-violet tints,
with core/body/limb opacity at most 0.35 and `filamentMix=0`: no white-hot core or procedural radial spokes hide the
painted glass and lightning.

Each reactor has 3–4 crawling filaments from 0.08–0.22 to 0.55–0.85 radii, ending inside the glass. Optional forks
end at `min(0.95, filamentEnd[1])` radii; filaments and forks clear the tower wedge. At most one strike starts at
0.95 radii and drops into the cradle anchors ([-12, 22], [-2, 26], [8, 22] engine px), never to the coil or towers.
Strike vertices and forks stay within the glass radius plus 9 engine px; outside 0.95 radii they stay at least
0.3 radii below the centre line. Tests cover every crisp/glow path vertex over 200 frame pairs for one and two
reactors in both camera bases. Omitting `BuildingArcStyle.filamentEnd` preserves legacy ends at 0.92–0.985 radii
and forks at 0.95 for other specs.

All vertices lie in the camera's screen plane before depth push; strokes sit just 0.05 world units ahead of the
disc. Capsule widths are 1.1 engine px (forks 0.8), with a white-blue core occupying 50 % of the half-width; each
arc/fork has a 2.2 times wider blue under-stroke at 0.22 opacity, starting at the same vertex (`glowStart=0`).
Persistent filament slots drift by 0.06 radians per logic frame, sampled at the start of each two-frame pair;
geometry reseeds per pair while presentation-time alpha flickers 0.7–1.0 times the shared source fade. Arcs appear
only above half fade. Plain-data setters reuse fixed buffers (256 discs, 16384 segments); HdRenderer owns their
lifetime. Native attack beams and their impact effects retain their existing pipeline.

`packages/ra2-assets/python/look_metrics.py` compares renders of one bench framing with the approved targets (L*
percentiles, local contrast at pixel and mid scale, sun/shade separation, highlight and deep-shade shares, chroma;
`--rings` gives the b*/L* spill profile around a light), which is how the `cinematic` grade, `clarity` and the
reactor's light were calibrated.

Per-pixel normals come from an optional material atlas next to the HD sprite atlas (`normals.json` +
`sprites@2x-normals.png`, written by `packages/ra2-assets/python/sprite_normals.py`, loaded by `spriteMaterials.ts`);
without it the relighting has no normals and sprites keep their baked shading, while shadows, contact decals and
reflections still follow the settings.

Live libraries accept the same encoding in per-page PNGs described by `normals.json.pages` (see the
[generator contract](../ra2-assets/README.md#sprite-material-atlas-python-experimental)). A page is ignored with one
warning if its HD filename, dimensions or scale no longer match `spriteAtlasesHd`. Material PNGs load lazily when
`HdRenderer.materialsWanted()` sees positive relight, occlusion, specular or glass strength. Faithful and shadow-only
looks do not request them. Existing sprites stay visible while a page loads; its arrival increments the library
revision and replaces that page's mesh once. Loaded masks are retained across look/hour changes and released when
the live view disposes. Indexed-only negative-key layers never get materials; smudge layers keep their existing path.

SpriteLayer uses `atlasUv = (frame.rect.xy + frameUV * frame.rect.zw) / indexedAtlasSize` for indexed, HD, window and
material sampling. The coverage and edge-filter distances are intentionally in original indexed pixels, and the
material shader has no colour-atlas texel-size uniform. A correctly aligned 4x colour/remap page therefore renders
with the same UVs and geometry, including a 1x material page, subject to the device's texture-size/memory limits.
`HdAtlasRef.scale` is not used to transform UVs. The following offline sprite contracts still assume 2x:

- `ra2-assets/src/manifest.ts`: `SpriteAtlasHdRef.scale` is the literal type `2`; library/map contracts inherit it.
- `ra2-assets/src/node/spriteHdCache.ts`, `outputRef`: `@2x` filenames, `scale: 2` and doubled dimensions.
- `ra2-assets/src/node/spriteHd.ts`, `scatterBatch` / `upscaleSpriteAtlas`: 4x inference is reduced to 2x; frame
  dimensions, destination offsets, page allocation and shadow clearing use doubled indexed coordinates.
- `ra2-assets/src/node/prepareMap.ts`, `hdFresh`: freshness requires scale 2 and doubled dimensions. A 4x page is
  considered stale by this preparation workflow.
- `ra2-assets/python/sprite_normals.py`: map `Cache` and output require 2x, and classifier/assist geometry and pixel
  radii use `SCALE = 2`. Library inputs use their declared scale, then classify at 2x and output 1x or 2x. Its
  `@2x-normals` filenames do not constrain texture resolution.
- `ra2-assets/python/redetail_sprites.py`: `MapCache` requires/crops 2x; `compose` downsamples to 2x and writes
  doubled frame rectangles; `frame_metrics` and colour-lock radii are calibrated at 2x.
- `ra2-assets/python/hybrid_redraw.py`: `FrameData` / `frame_data`, `postprocess`, `lock_colour`, `checks`,
  `consistency` and `compose_atlas` use 2x frames, masks and atlas writes.
- `ra2-assets/python/l3_redraw.py`: `Source` requires/crops 2x; `composite_hd`, `register_panel`, `process_sheet`,
  stabilization, `paste_patches` and delta transfer use doubled frame coordinates and masks.

The `2x` mentions in `ra2/cache.ts`, `ra2/spriteLook.ts`, the library contract comments and CLI descriptions are
documentation/naming of those generated assets, not shader restrictions. `ra2-assets/src/node/lights.ts` also uses
`SCALE = 2` for its window **preview sheet** only, not library material or colour sampling.

## Original maps (`src/ra2`)

- Map lighting (`mapLighting.ts`): the map's `[Lighting]` and light sources as the engine applies them by day, per cell
  (`MapLightGrade`, one texel per cell from `engineCellLight` in `ra2-assets` `lights.ts`: Ambient - Ground + Level x z
  plus lamp posts such as `INGALITE`, normalised tint). Terrain-class art (tiles, overlays, smudges, trees) takes the
  terrain intensity (I x the tint's largest channel, drawn through the engine's shade rows: `engineShade`) x the
  normalised per-channel colour; objects (buildings, units, infantry, aircraft) take the object level I alone, kept in
  the texture's alpha, plus their own extra light, added as the engine adds it. Both act on the palette's own sRGB
  values. `SpriteInstance.lighting` selects the class per sprite (`'ambient'` by default, `'full'`, `'none'`); map
  objects take `MapObject.lighting`. Each map cache owns its grade (`Ra2Cache.mapLight`); in a live match its light
  sources are the game's own active list (`LiveSnapshot.lighting.sources`) or, without one, the sidecar's types on the
  standing buildings, and the renderer weights it (`setWeight`, baked into the texels). Lunar
  airless staging uses this same grade with neutral sun/sky; the game layer exempts ore/gem sprites through the generic
  per-instance grade flag so their art stays bright. The HD
  water look takes no grade of its own (it mixes the graded tile art's hue in already).
- Terrain (`terrain.ts`): original tile art is lit by plain Lambert diffuse from the sun and sky, with specular only on
  wet ground, so flat ground at clear noon shows exactly composite x map lighting. Contact shading from the height
  field darkens ground and water at the feet of cliffs; no sun shadows are cast.
- Water (`waterLook.ts`, `shoreField.ts`, `../proceduralTextures.ts`): open water is shaded per pixel from the signed
  shore distance (land specks of at most `SPECK_TEXELS` field texels count as water). An optional `shoreIgnore` image
  in the map's `materials.json` uses the water mask's size/layout; greyscale values >= 128 mark cliff tops and walls
  that must stay dry and not create a beach beside water in screen space. At least half a field texel's pixels must
  be marked, and it must remain land after speck filling. Missing or mismatched images warn once and leave the
  field unchanged; the image is only loaded when a water mask is available. The same loaded bytes also produce
  `terrainMap.cliff`, an unsigned distance to marked texels using the shore field's isometric metric and majority
  downsampling (2 composite pixels per texel for lake beds, otherwise 4). Its R16F texture uses linear filtering,
  no mipmaps and a normalised 0..1 range capped at `CLIFF_FIELD_MAX` (1.5 cells); wall texels are zero. Marked water
  and specks remain cliff targets. The enhanced bed path receives the red channel as `BedWaterInputs.cliff`;
  without a valid loaded ignore mask the cache field is null and the shader input is absent.
  The opt-in `enhanced` look:
  a narrow turquoise shallow band with caustics over a sandy bed, dark blue-teal depths, a wind sea from three
  scrolled layers of a tileable ripple normal map plus two swells under drifting gust patches, sun glitter in ripple
  facets, rippled reflections of the mirrored scene, explosions and lamps mirrored from the light field, a swash that
  laps up and back with a thin foam line, breaker lines and wet sand, no surf at cliff feet, and rain rings. The default
  is the earlier `classic` look; sandbox `water=enhanced` (or `look=golden`), `LiveViewOptions.water` and in game
  `hd-water=enhanced` select the modern one (`waterPreset`, chosen before the world is built).
  With `waterBed: true`, enhanced water mirrors every base water level with at least 12 open-water cells, keeping
  the four largest levels. All of them share one mirror atlas (`../mirrorAtlas.ts`): one colour and one depth
  texture, a half-resolution tile per level (2 x 2 tiles for four levels, the pixels four separate mirrors had). A
  level's tile renders only while its padded cell bounds intersect the camera frustum; fragment height selects the
  matching plane, and other levels keep sky only. Classic and legacy enhanced water retain the single lowest mirror
  (three's own reflector). Where that mirror shows raised ground it is read through a box of five taps one cell
  diamond wide (`cliffSoftMirror`, `CLIFF_MIRROR_TAPS`): the mirror renders the terrain's own geometry, whose cliffs
  stand on whole cells, so a mirrored cliff ended in a staircase of cell diagonals out in the water, where the painted
  cliff is one line. The zone is a ground-vertex value (`cliffMirrorZone`, packed with the contact shade in the
  `contact` attribute): the points whose mirrored view ray meets ground 0.75 levels or more above them within six
  cells (a cliff of n levels mirrors n / 2 cells towards the camera), spread by a cell and a half. Outside it, and for
  trees, buildings and units mirrored in open water, the lookup is the single tap it was; the two mirror textures are
  the only ones bound whatever the tap count. `WaterUniforms.cliffSoft` (1) is the review switch. The atlas exists
  because a fragment shader may sample only 16 textures on a default WebGPU device: with a render target per level the
  ground of a map with four water terraces needed 22, its pipeline was refused and the ground was not drawn.
  `tests/terrainTextureBudget.test.ts` builds the ground of a map with every optional layer through three's WGSL
  builder and fails above 16; it is 15 today, whatever the number of
  levels. The ground and wall lighting model also skips three's DFG lookup, which it never reads.
  On maps staged as dusk or night (`AtmosphereProfile.kind`, see `ra2-assets/src/lights.ts` `mapAtmosphere`) the
  renderer sets `WaterUniforms.artTone` to 1 and water with painted art keeps the tone the map paints it in: the
  albedo is the painted water with its painted shore (no shallow band, foam, bared sand or inland band of the look),
  and the look's reflected light is kept at the painted level and hue (`tonedReflection`, at most
  `ART_TONE_REFLECTION` of the painted colour, fading in over `ART_TONE_SHORE` from the mask's edge). The daylight
  looks read as glowing blue there, where the original water is near-black, and their shoreline traced the
  cell-stepped edge of the water mask under cliffs. The terrain's cliff-foot contact shading is dropped from 1.5
  cells inland of the mask to the water on those maps (`artToneContactRelief`): it darkens the ground at a cliff's
  foot but not the wall above it, and painted water continues across the wall's lower edge, where the step showed
  the cliff's cell staircase. The painted lake bed (`waterBed: true`) has no painted water in its composite and
  ignores the tone.
  Day maps: the extractor's water mask ends at whole water cells under cliffs, quays and overpasses, 1 to 30
  original pixels short of the painted waterline, and the look drew its turquoise shallows and foam along that
  staircase with a strip of contact-shaded painted water behind it. A sidecar with `waterline: "painted"`
  (`ra2-assets/python/waterline_mask.py`) names a mask that follows the painted waterline; `terrainMap.paintedWaterline`
  then turns off the cliff-foot extension of the water onto land, and `ra2/hardShore.ts` gives the ground a
  `hardShore` vertex attribute (no texture: the ground stays at 15 sampled textures): 1 on cells of tiles outside the
  extractor's water families that hold, or touch, mask water (a cliff face is painted on low cells, often more than
  a cell in front of the height step the `contact` attribute finds), fading over 1.5 cells. At a hard shore
  (`waterLook.ts` `hardShoreInputs`) the look sees deep water wherever the water covers (`HARD_SHORE`: no shallows,
  sandy bed, swash or foam), the land keeps its art (no wet band or inland replacement) and the cliff-foot contact
  shading is dropped on the land within 1.5 cells of the water (`HARD_SHORE_CONTACT`; ground triangles were shaded,
  wall quads not, which showed the cells as dark facets on the rock). Every shore of a snow map is a hard one
  (`BEACHLESS_THEATERS` in `ra2/terrain.ts`): its shore tiles are ice, and the sand beach drew an orange line and a
  turquoise glow around every floe. The look on beaches of the other theatres, on open water and on the lake-bed path is unchanged.
  Optional `materials.json.waterDetail` supplies sRGB
  apparent water colour and alpha roughness/glitter weight over the composite's area (same aspect, any resolution).
  It shares the mask's top-down UVs and uses linear/mipmap filtering with clamped edges; load failures warn and leave it unused.
  `WATER_DETAIL` in `waterLook.ts` controls column blending, retained shallow turquoise and alpha modulation. Only the
  constant column receives display compensation; the mixed column then dims at night. Without detail, the bed shader
  keeps its original calculation order.
  Optional `materials.json.waterSurface` names a seamless RGBA8 painted water surface tile with linear data channels:
  R = relief luminance ratio / 2 (0.5 neutral), G = crest glints, B = foam lace, A = unused. The tile repeats in
  screen-aligned ground space; one tile spans `waterSurfaceScale` screen units of 30 engine px on each axis
  (positive number, default 13). It uses `NoColorSpace`, repeat wrapping on both axes, linear/mipmap filtering and
  anisotropy 8. Only enhanced lake-bed water (`waterBed: true`) with a `waterDetail` layer samples it; absent tiles
  leave the existing shading intact, and load failures warn once and leave the surface null. Tiles are made from
  image-model texture tiles by a scratch tool outside the repository.
  Reflective sheen (`WATER_SHEEN`, both enhanced paths): offshore the sky is mirrored by a separate short-crested
  wind-wave normal (directional trains near the camera axis, domain-warped) with a full Schlick Fresnel term seen from
  a virtual perspective eye on the camera axis, so farther water is more grazing; the trains' own crest lines add a
  thin sky-lit crest net. The mirrored sky is the scene's horizon pulled towards a clear cyan and a tinted zenith; the
  water body is dimmed by the reflected share and tinted so the mean colour stays on the calibrated profile. On
  painted-bed water the warm sun glints thin out offshore (`glintNear`/`glintFar`) and gather on the wavelets within a
  cell of beaches; three breaker lines and fbm iso-line lace threads form the surf band. Water without a detail layer
  (every other map) uses the same sheen beyond `enhanced.openNear..openFar` cells from the bank. The shallow shelf
  (`BEACH_PROFILE`) keeps the sand visible to about half a cell. Within about 1.6 cells of the bank
  `BED_SHALLOW_DESAT` pulls the water body's chroma 30 % toward its own luminance (Rec.709, brightness kept) and shifts
  it slightly from blue to green, so the luminous shallows read as the target's muted teal rather than tropical cyan
  (river framing: chroma of the first 0.6 cells 19.6 -> 16.4, lightness unchanged, open water untouched). Tools: `packages/ra2-assets/python/water_metrics.py`
  (water metrics at the river framing) and `shallow_bed.py` (lifts the painted waterline stroke on the land side).
- Sprites (`sprites.ts`): filtered coverage of the indexed mask for soft edges; within about one original texel of
  transparent texels HD atlas colours keep their hue but are never brighter than the original texel there (the
  upscaler's pale background fringe goes without a rim of raw palette colours). An HD page's optional
  `paintSaturation` (0..1, absent = 1) grades only the decoded house colour in linear light, preserving Rec.709
  luminance before the coverage-mask mix. A value of 1 or absent adds no shader nodes. HD pages and their paint masks
  are decoded off the main thread (`loadHdTexture` in `ra2/cache.ts`: `createImageBitmap`, straight alpha, no colour
  conversion) and a library page is uploaded as soon as it arrives; the bitmap is released after the first upload, so a
  page cannot be uploaded a second time. Building and vehicle SHP
  shadows halve the displayed colour; infantry uses solid black palette-index-12 contact cores in the faithful and
  golden looks and a calibrated half-brightness footprint in `cinematic` (see "Infantry contact shadows").
  Live object occlusion combines native BUILDNGZ body samples, ground-like parts and
  gradient-2 ground-unit cards (`ra2/nativeDepth.ts`) with small scene-wide traversal/component biases
  (`ra2/painterOrder.ts`). Atlas pages share a depth template; a current-cell Harvester/Refinery predicate supplies
  the native 13-row bonus. No radio-contact dock pull or neighbor propagation remains. Libraries without a depth
  template keep analytic building depth. Physical depth remains available to atmospheric post processing, while
  decals, shadows and wet reflections retain their existing ground-depth paths. See the Native depth paragraph
  above and `docs/remaster/research/painter-order.md` for the formulas and verification boundaries.
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
  along a fixed light, with a 0.04-cell contact penumbra from five shared-geometry/material twins whose overlapping
  core keeps the original darkness (depth-tested once per layer, see `voxelShadow.ts`); `?vshadow=hard` restores one
  crisp twin in the sandbox and replays. A unit the live view marks as standing on terrain or a bridge deck
  (`setShadowContact`) instead casts the engine's own ground shadow: the top-down footprint of the body alone
  (no turret or barrel, no shear by height) in the plane through the unit's origin, for vehicles on the bottom face
  of the body's bounds (`bottomFace`; the Chrono Miner's lies four voxels below its origin), drawn three engine
  pixels to the right of the draw point (YR 1.001 unit draw `0x73C47A`, shadow matrix `0x55A7D0`, offset vector at
  `0x887420`). On a ramp the footprint lies in the plane the body is drawn in; its depth is the ground's plane at
  the unit, raised until it is nowhere under the registered surface beneath the footprint plus a quarter level
  (`contactClearance`, at most one level; level ground unchanged): one plane through the unit's origin dips under
  the real ground where a ramp begins or ends and on corner ramps, and the ground's own depth then hid the footprint
  (frozen pairs with the hull hidden: 0 to 25 visible pixels where the original shows 91 to 169). Its edge is crisp
  (`CONTACT_SHADOW_PENUMBRA`, a sixth of an engine pixel: a half-pixel penumbra drew a dark line under the whole
  lower outline of a hull) and its darkness is the engine's own whatever the look's `shadowDarkness` is
  (`CONTACT_SHADOW_OPACITY`): the original halves the ground under a vehicle, and the enhanced look's 1.15 turned the
  three-pixel band into a black outline. Measured on frozen same-frame pairs with exact masks (original: a shadow
  pixel is the background with every 16-bit channel halved; HD: sandbox replays of the same state with the hulls
  hidden): brightness under the shadow 0.49 original, 0.45 to 0.47 HD (0.30 with the look's figure); the whole HD
  footprint covers the engine's at 0.93 to 0.97 intersection over union; the visible shadow is 0.96 to 1.2 times
  the original's area for hulls facing north to west and 1.4 to 2.9 times for hulls pointing at the camera (east to
  south), where the smooth HD hull's lower outline lies up to two pixels inside the engine's splatted voxels and
  bares a strip of footprint the original covers. The sheared projection measured 2.2 to 5 times. Flight, water
  contact and physical-origin overrides keep the earlier rules. Grounded voxel origins on water are identified by the terrain's surface
  lookup, regardless of unit type: five straight-down twins give 0.3 core contact darkness; five blue-white foam twins
  retain only source points near the waterline (smooth fade from 0.06 to 0.14 world units above it), scale 1.06 across
  the hull and 1.14 along its forward axis, and break their 0.3 core alpha with drifting 0.1/0.2-cell value noise
  (±0.02 scale and ±3% alpha breathing over two seconds on the renderer clock). One coloured reflection mirrors
  each part about the water and flattens it along the camera view ray; its 0.6 waterline alpha ripples horizontally
  and fades to zero by 0.8 world units below it (stage-2 review: at 0.45/0.5 the mirrored hull barely showed under
  the ship). The reflection reads the part's palette colours or projected HD
  atlas (including house paint) from original geometry coordinates and a separate, unflattened source matrix.
  Its ambient-only colour (0.6 of the albedo) is attenuated and slightly water-tinted, with no added sun glints; it never transforms
  normals through the singular decal matrix (`voxelReflectionColour.ts`). Coloured twins compensate the mirrored
  winding when culling rear faces; concave front-face overlaps retain the existing once-per-pixel plane-depth rule.
  All twins share source geometry; reflection materials are cached per
  source material and renderer, with no per-frame allocations or new passes. Water draws at most eleven twins per
  part, land five.
  Contact depth masks the foam core so only the enlarged soft rim shows; all layers sit just above the water,
  behind upright art. `?vrefl=flat` restores the previous blue-grey silhouette and its 0.3 alpha while retaining
  the foam/contact layers. `?vnaval=old` restores the ordinary water drop shadow for before/after review; both
  controls are independent of `vshadow=hard`. Airborne units drop theirs straight down, shrunk with height. Building voxel
  turrets cast from a bounded physical point on their
  view ray nearest the foundation centre, using the same ground shear as vehicles rather than their pulled render
  altitude. Review parameters (sandbox and replays): `?vpl=<extra>,<occlusion>,
<sheen>`, `?vshape=<corner relax>,<normal blend>`, `?ml=0` (no map day light).

### Optional remaster voxel look

The default `HdSettings.voxelLook = 'engine'` retains the existing geometry and VPL material. Select
`?vlook=remaster` before loading the sandbox map to use smooth, physically lit vehicles. This is a load-time
geometry choice; changing the setting on an already built world does not rebuild its units. `loadRa2World`
accepts `voxelLook` and `smoothVoxel: Partial<SmoothVoxelOptions>`. `VoxelUnits` inherits those world options,
or accepts overrides as its fifth constructor argument. Geometry is shared by model and normalized options;
house palettes share geometry but own different LUT materials, scoped to their `AtmosphereNodes` lifetime.

Use `?vlook=remaster&vproj=vehicles-hd` for [projected vehicle redraws](#projected-vehicle-redraws) on the same mesh.

- `src/ra2/voxelSmooth.ts` is renderer-independent, returning typed arrays from `buildSmoothSection`.
  The thin `voxelSmoothGeometry.ts` wrapper merges sections in `buildSmoothPartGeometry`. Original bounds,
  section transforms, normal tables, voxel scale, turret pivots and flattened shadow geometry are retained.
- A live view builds these meshes off the thread that presents frames: `VoxelUnits` owns a `SmoothVoxelPool`
  (`src/ra2/voxelSmoothPool.ts`, up to four `voxelSmoothWorker.ts` Workers, closed after 20 idle seconds and when
  the view is disposed). `VoxelUnits.geometryReady(model)` starts the build and answers false until
  `prepareSmoothVoxelGeometry` has filled the same per-model cache `buildSmoothVoxelGeometry` reads;
  `VoxelUnits.revision` changes when it has. Without Workers (tests, other hosts, `smoothBuilder: null`) and in
  static worlds (`loadRa2World`) the mesh is built in place as before; a Worker that fails falls back to that once,
  with a warning. Measured on one skirmish start (XMP29U2, two players): 3.0 s of main-thread time before, 0.07 s
  (assembling the returned arrays) after.
- A unit never waits for that build. A smooth mesh takes 0.02 to 3.3 s of CPU (measured over the 94 models of the
  extracted library; the War Miner 0.5 s) and longer on a busy machine with the Workers started anew (measured: 7.2 s
  for a War Miner, during which the view drew nothing for it). `VoxelUnits.build` therefore instantiates a
  **stand-in** while the mesh is on its way: the plain exposed-face mesh of the model
  (`buildStandInPartGeometry` in `src/ra2/voxels.ts`, the engine look's geometry; 0.4 to 25 ms per model, 8.5 on
  average) in the smooth mesh's attribute layout (`pshade` = the palette index, `curvature` 0, `vpos` = the lattice
  position), drawn with the materials the smooth mesh gets (PBR, then the redraw projection when that arrives). The
  layout is what three r186 keys a compiled shader on (`RenderObject.getGeometryCacheKey`), so the stand-in costs no
  shader of its own. When the Worker answers, `VoxelUnits.adoptSmooth` exchanges the geometry of every placed unit
  **in place** (`VoxelUnit.replaceGeometry`: part meshes and their shadow, foam and reflection twins) and releases
  the stand-in: the unit is the same object before and after, so its place, facing, turret angle, opacity, capture
  membership and depth card cannot jump. Measured on real models at two device pixels per voxel: the smooth
  silhouette lies inside the stand-in's (IoU 0.97 for bodies, 0.91 to 0.96 for turrets, 0.85 to 0.89 for one-voxel
  barrels), bounds differ by at most 0.23 voxel per side and the centroid moves 0.05 to 0.73 device pixels.
  `VoxelUnits.isStandIn(unit)` and `standInUnits` (and `LiveView.diagnostics().standInVoxels`) report it.
  `prepare()` stays false while only the stand-in exists: it is not the final look.
- `LiveView` applies this to vehicles, aircraft and ships, to buildings' voxel turrets and to voxel shells and
  debris (`voxelDrawable`): a **shown** view builds the unit in its first frame; a view **out of sight** still
  waits for the mesh (nobody sees it, and it does not count as settled until then), and what waited is drawn in the
  frame after `outOfSight` becomes false, with or without a new snapshot. The engine's alternate image of a unit
  that already has a picture (a miner's unloading model) is different: the unit keeps its current picture until the
  other one is final (`drawArt`), so it changes look once.
- Sprites have the same rule with another stand-in. A **shown** view draws a page's sprites from the page's
  indexed layer until its HD art is in (`LiveView.flushSprites`: same records, so no change of place, size, depth
  or house colours when the final layer takes over), keeps an object's last complete picture while a change of
  state waits for a page (`live/heldPicture.ts`), and loads what is announced before its object exists
  (`LiveView.prepare`: sidebar productions through the bridge, the objects the map cache lists, deploy targets).
  The shader graphs of the stand-in layers and of every look a page's final layer can have
  (`LiveLibrary.hdPageLooks`) are built and compiled behind the loading screen from hidden, empty layers
  (`LiveView.warmStandIns`), so neither the first stand-in of a match nor the layer that replaces it builds a
  shader or waits for a pipeline.
  `diagnostics()` counts `indexedSprites`, `heldPictures` and `incompletePictures`; see "A sprite the game shows is
  never missing" in `docs/remaster/HD_BRIDGE.md`.
- A model **file** has no stand-in: a unit whose file is still being fetched draws nothing. The files are therefore
  fetched ahead: `LiveLibrary.preloadVoxels` requests every voxel model of the type library (94 files, 5.7 MB),
  two at a time, once the view has drawn its opening completely or is shown; models fetched ahead do not count as
  `loading` and do not change `revision`. `EffectArt.preloadVoxels` requests the ten debris and shell models with
  the combat pages.
- The exact separable boundary EDT uses samples on exposed cube faces. The distance to a union-of-cubes
  boundary is exact on this aligned lattice; its occupancy sign gives the inside and outside fields in one
  transform. This avoids the corner error of subtracting half a sample from a binary centre-distance EDT.
  IMLS estimates the artist's planes from stored normals; the optional occupancy mode blurs signed distance.
  Both clamp displacement to a band, preserving one-voxel features. Material-index-constant quads have separate
  vertices; normals, curvature and ray AO are computed once per surface-net vertex before duplication.
- Material classes still use the original `pindex`. A separate fractional `pshade` averages exposed voxel
  indices within `shadeRadius` (default 1.5 voxels), weighted by a Gaussian with sigma `shadeRadius / 2`.
  Only neighbours within `shadeThreshold` (default 3 index steps) and the same `floor(index / shadeRamp)`
  group (default ramp size 16) contribute; the owning voxel always has unit weight. This reduces palette
  dithering while preserving separated details and house stripes. Radius 0 disables it. Radius/threshold
  accept finite nonnegative values; ramp size must be an integer 1–256. All three are geometry cache keys.
- AO uses deterministic cosine-distributed rays, starting 0.6 voxel off the surface. Half-voxel marching
  stops at occupied voxels or the transformed part's model ground plane. A hit at distance `t` contributes
  `sqrt(1 - t / aoLength)`. Zero rays or zero length disables AO. The maximum inward band is below 0.5 voxel,
  preserving a negative core in a one-voxel rod; supersampling accepts integers 2–8 (an aligned lattice needs an
  interior sample). `smoothSigma`/`imlsRadius` are limited to 4 voxels, the outward band to 1 voxel,
  and rays/length to 256.
- `voxelClasses.ts` owns the RA2 palette policy. `voxelPbr.ts` uses a 256×3 nearest-filtered LUT, GGX with the
  scene sun, diffuse HemisphereLight, and a procedural reflection sky. The sky adds no second diffuse term.
  Lambert lighting already divides irradiance by pi, so the existing noon exposure supplies the same flat
  diffuse reference as terrain. Metallic energy conservation, wear and reflections deliberately alter the
  final surface response; `brightness` trims it without an additional exposure or emissive daylight fill.
  Glass shading is available, but no stock palette ramp is guessed to be glass (the blue ramp stays paint).
- Armour and house colours use rough military paint; the historical `metal` class is painted steel
  (roughness 0.52, metalness 0.25). Neutral reflections replace the strong blue sky. `shadeSmooth` blends
  raw colour with the interpolated `pshade` LUT colour, keeping both taps within the owning palette ramp.
  `edgeLight` adds convex bevel highlights independently of wear. Dark/rubber surfaces below `treadHeight`
  receive soft track ridges along voxel x, including view-space normal relief; `treadPeriod` is in voxels.
  `dust` tints upward faces and the lower hull with low-frequency noise and raises roughness towards 0.9.
  `streaks` adds thin vertical grime on near-vertical faces. Heights use the same transformed model ground
  as grime. All detail layers are procedural and affect only the remaster look.

Geometry review parameters, captured before loading:

```text
?vlook=remaster&vsmooth=supersample:3,shape:imls,imlsRadius:1.1,bandIn:0.3,bandOut:0.3,storedNormals:0.35,aoRays:48
```

`supersample` defaults to 2: quads of half a voxel, about one device pixel at the engine's size on a 2x display.
3 costs 2.25 times the triangles, vertex memory and build time and shows only in captures at higher zoom.

Other geometry defaults: `smoothSigma:0.55`, `aoLength:10`, `groundOcclusion:true`, `shadeRadius:1.5`,
`shadeThreshold:3`, `shadeRamp:16`. `shape:occupancy` selects
Gaussian smoothing. Uniforms can be changed through `?vk=aoStrength:0.8,wear:0.5` or, without reloading,
`window.__hd.voxelPbr.wear.value = 0.5`. The complete defaults are:

| Uniform     | Default | Uniform       | Default |
| ----------- | ------: | ------------- | ------: |
| brightness  |       1 | aoStrength    |     0.8 |
| envStrength |    0.35 | specular      |       1 |
| shadeSmooth |       1 | edgeLight     |    0.25 |
| tread       |     0.8 | treadPeriod   |     0.8 |
| treadHeight |     3.5 | dust          |    0.35 |
| streaks     |    0.25 |               |         |
| wear        |     0.5 | wearStart     |     0.6 |
| cavity      |     0.4 | cavityStart   |     0.6 |
| grime       |    0.35 | grimeHeight   |       4 |
| microNoise  |    0.06 | lightStrength |       1 |

For example, `?vlook=remaster&vk=shadeSmooth:1,edgeLight:0.25,tread:0.8,dust:0.35,streaks:0.25`.
Each detail strength accepts 0 to disable that layer. `dustColour` is a separate colour uniform, initialized
from sRGB `(0.55, 0.48, 0.38)` and stored in linear space; change it live with
`window.__hd.voxelPbr.dustColour.value.set('#8c7a61')`. Reflection colours are zenith `(0.42, 0.47, 0.55)`,
horizon `(0.62, 0.64, 0.66)`, and ground `(0.12, 0.11, 0.10)` in linear space.

Asset-free acceptance:

```bash
pnpm --filter hd-renderer run typecheck
pnpm --filter hd-renderer test
```

Read-only CPU benchmark against a user-supplied voxel JSON directory (all parts, default options; first build
and median of three subsequent uncached builds, excluding JSON I/O):

```bash
pnpm exec tsx packages/hd-renderer/scripts/benchmarkVoxelSmooth.ts "$VOXEL_JSON_DIRECTORY"
```

The synthetic tests check geometry topology, thin features, palette boundaries, normals, ground AO,
determinism, cache isolation, shadows, depth compatibility and CPU shader generation. These checks and the
build benchmark do not establish GPU rendering, visual quality, noon pixel matching or live-match FPS.

### Projected vehicle redraws

For pre-lit image-model redraws on those meshes, use `?vlook=remaster&vproj=vehicles-hd` (recommended), or
`?vlook=engine&vproj=vehicles-hd` for the original geometry. `vproj` is relative to the HD cache root served by
Vite. The map viewer and live bench (`?fx=units&vlook=remaster&vproj=vehicles-hd`) both support it.
`loadRa2World`, `LiveViewOptions` and `VoxelUnitsOptions` accept `voxelProjection: string` as the atlas URL base.
An absent index, missing type, invalid manifest or incomplete part set logs once and retains that type's selected
engine/PBR look. Live types load asynchronously and update existing instances once the complete set arrives.
Building turrets (`TYPE:turret`) use turret-only manifests in `vehicles-hd`, with the building body remaining a sprite.

A part may name other colour pages of the same frames, `"variants": { "<name>": "<file>" }` (same size, rects, pivots
and paint page). They are fetched together with the type, and `VoxelProjectionLibrary.get(type, parts, variant)`
answers the asset painted with that page (a name the type lacks, or a page that failed to load, is the page as
drawn). Which variant an object is drawn with is game policy: a harvester reports its load (`LiveObject.cargo`, bales
of ore and of gems; YR keeps them per Tiberium type at TechnoClass +0x33C, `src/games/yr/unitCargoState.ts`), and
`src/ra2/cargoLook.ts` turns it into `empty`, `gems`, `mixed` or the page as drawn (gold ore). `LiveView` keys a voxel
unit's geometry set by the variant and rebuilds the visual when the look changes, exactly as it does for an
engine-selected image; a farm without variant pages draws every load with the base page.

The projection layer reads `<base>/index.json`, each listed type's manifest, and colour/paint atlases. It uses
the mesh's complete world matrix (including parent turret yaw, scale and ground tilt) to select adjacent baked
facings and project local positions through the recorded orthographic Jacobian. Turret and barrel share the
turret atlas and pivot. Four atlas reads per fragment blend coverage-weighted colour and house paint; no
per-unit JavaScript update is added to the frame loop. Texture coordinates have a top-left origin, `flipY=false`,
and explicit sRGB decoding matching the VPL LUT. Frame metadata uses uniform arrays; atlases use trilinear
mip filtering and clamp wrapping. Materials are cached per atmosphere, palette and projection part. Atlases,
decoded bitmaps, palette LUTs and materials are released with the atmosphere, including cancelled/failed loads.

The projected material uses the engine pre-lit lighting path on either geometry: map object light, extra unit
light, night desaturation (excluding house paint), local light and `voxelFill`. Mesh AO and the extra diffuse/sheen
affect only uncovered engine art. Depth, silhouettes, turret articulation and shadow twins still come from the
mesh; the redraw does not create geometry outside it. At intermediate facings, differently drawn details can
ghost during the cross-fade. GPU alignment, paint, mip seams, motion and performance need Chrome review.

Both entries expose the following uniforms:

```js
window.__hd.voxelProjection.relight.value = 0; // Default 0; 1 enables directional relighting.
window.__hd.voxelProjection.blend.value = 1; // Default 1; 0 selects only the nearest facing.
window.__hd.voxelProjection.strength.value = 1; // Default 1; 0 shows plain engine shading on the chosen mesh.
window.__hd.voxelProjection.levelRef.value = 1.7; // Object light level the redraws were baked under.
window.__hd.voxelProjection.gain.value = 1; // Linear-light gain of the redraw colour (grading review).
window.__hd.voxelProjection.saturation.value = 1; // Saturation of the redraw colour (grading review).
window.__hd.voxelProjection.sharpen.value = 0.5; // Negative mip LOD bias (levels) for the redraw atlases.
window.__hd.voxelProjection.paintShade.value = 0.85; // Mesh-normal form shading of the house paint (0..1).
window.__hd.voxelProjection.paintSpec.value = 0.5; // Camera glint on the house paint.
window.__hd.voxelProjection.formShade.value = 0.7; // Mesh Lambert form light on the whole redraw (0..1).
window.__hd.voxelProjection.formAO.value = 0.25; // Mesh voxel occlusion on the redraw (0..1).
window.__hd.voxelProjection.spec.value = 0.5; // Luminance-gated glint on the whole redraw.
window.__hd.voxelProjection.contrast.value = 1.15; // Hue-preserving luminance power around linear mid grey.
```

The sandbox also takes them in the URL: `?vpk=relight:0.5,levelRef:1.7,gain:1,saturation:1`. The redraws are drawn about three times larger than the game shows them, so trilinear filtering lands between mips; `sharpen` biases the colour and paint reads toward the finer mip (0 restores plain trilinear sampling). Image models paint the remappable house colour almost flat, so the paint alone receives Lambert shading from the mesh normal against the current sun (normalised to 1 at n.l = 0.65) and a Blinn-Phong glint toward the iso camera; `vpk=sharpen:0,paintShade:0,paintSpec:0` reproduces the earlier projection look for A/B reviews. The redraws themselves are lit almost evenly, so at game scale a vehicle read as a flat painting next to the approved target frames (dark lower hulls, bright top faces, glossy edges); `formShade`, `formAO`, `spec` and `contrast` give the whole redraw form light from the smooth mesh, the mesh's voxel occlusion, a glint gated by the redraw's luminance and a luminance contrast, and `vpk=formShade:0,formAO:0,spec:0,contrast:1` turns them off. The three multiplying terms are mild (0.7, 0.25 and 1.15): the pages are tone-locked to the voxel designs, which already carry the engine's facing-dependent shade, and against the original's frozen frames (20 vehicle types at four facings on a temperate, a snow and a lunar map) occlusion 0.75 with contrast 1.35 put 5 to 7 points more hull pixels below luma 40 than the original shows (13 points on ships), and the Lambert term at 0.85 added a facing- and map-dependent 2 to 4 points. A type manifest may carry `"exposure": E` (1 to 4, default 1): its colour pages then store sRGB / E and the shader multiplies it back before decoding, so a light hull's top faces are not held at the page's white (255 x level / levelRef on screen, about 150 at a plain day level) while the original reaches white; house paint comes from the palette ramp and is not scaled. The bakes are
screenshots of the engine look at the XMP29U2 noon object level, so their colours already carry that level: the
projected colour is scaled by `level / levelRef` rather than `level`, and 1.7 reproduces the redraw frames' median
brightness at noon on that map (measured in Chrome). relight, blend and strength are clamped to 0..1 in the shader. Optional relighting uses the existing sprite sun-direction uniform
for the current sun and the VPL light direction as its reference. It is disabled by default. Omitting `vproj`
retains the original material path and defaults. Build player-supplied assets using
[the projection builder](../ra2-assets/README.md#vehicle-projection-atlases-python); keep all derived images outside Git.

## Infantry contact shadows

Live infantry queues the shadow matching its selected body/sequence frame, including a dedicated library page.
Only infantry shadows carry a contact marker (cleared whenever a sprite-pool record is reused). Their
native core opacity is **1** (`INFANTRY_SHADOW_OPACITY`), matching solid palette-index-12 pixels instead of the
half-colour shadow blitter: in frozen same-frame pairs the original shows the ground under a conscript's footprint
at 0.00 of the ground beside it, on snow and on temperate ground. The faithful and golden looks draw exactly that.
An enhanced look can draw the footprint as a shadow instead (`HdSettings.infantryShadow`, the look uniform
`SpriteLook.infantryShadow`, read every frame): at twice the resolution the solid blob is a smooth black disc under
every soldier and reads as a hole in bright ground. `cinematic` uses `INFANTRY_SHADOW_SOFT_OPACITY` = 0.35. That is
not the engine's shadow opacity (0.78): the HD infantry body pages already carry a soft contact shadow in the
footprint's place (alpha 0.25 to 0.5 in all 54 infantry sprites of the library), which the solid footprint used to
hide, and the two multiply. Same-frame sweeps of the value in frozen live frames (12 conscripts each; ground under
the footprint / ground beside it, snow / temperate): 1 -> 0.02 / 0.03, 0.78 -> 0.26 / 0.23, 0.6 -> 0.37 / 0.33,
0.4 -> 0.47 / 0.42, 0.2 -> 0.55 / 0.50, 0 -> 0.62 / 0.56; the HD vehicles' contact shadows measure 0.45 to 0.47.
A library whose infantry pages lack that baked shadow needs a higher value. Full opacity is reached at filtered coverage
0.22 (`INFANTRY_SHADOW_RAMP`, smoothstep 0.02-0.22), with an antialiased exterior. The upscaled mask is only
about 0.5 at the original blob's edge, so a linear ramp would leave the edge transmitting bright ground.
Their original SHP offsets remain attached to the feet even in `cinematic`. Sun following,
shadow-length transforms and the distance-based blur are bypassed for infantry. The dedicated 2x black RGBA page
supplies alpha coverage with a solid core and antialiased exterior; the indexed page is the loading fallback. Both
colour and over-pass depth use that same coverage. The other look strength controls (`shadowDarkness`, softness, sun
following) do not touch the infantry footprint. Building and
vehicle shadows retain their existing indexed coverage, transforms, opacity, softness and ground-depth ordering.
In the enhanced ground pass, the infantry core has a 0.028 depth pull, ahead of ordinary shadow ranks (up to 0.027)
but behind reflections and upright feet. Thus an earlier building shadow cannot reject its solid core in LessDepth.
Build/repair the library with [the infantry shadow tool](../ra2-assets/README.md#infantry-shadow-repair-python--typescript).
Fixture tests cover coverage, sprite-pool reuse, dedicated page routing and generated main/ground-pass shaders.
Full alpha removes ground transmission before postprocessing; mist, bloom and night tone mapping can still affect
displayed colour. The tests do not establish displayed-pixel strength: conscripts were measured on frozen live
frames (above); live GI, Initiate and Slave comparisons remain `UNVERIFIED`.
