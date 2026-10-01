# ra2-assets

Local "install step" for the HD remaster: reads one map and the art it references from the player's own Yuri's
Revenge install and writes an HD cache that the HD renderer consumes. The contract is `src/manifest.ts`. For live
matches it also writes a per-theater type library with art for every building, vehicle, infantry and aircraft type;
that contract is `src/library.ts`.

Everything the extractor writes is derived from EA game data. It goes to the gitignored `gameres/` directory and must
never be committed or redistributed.

## Commands

```bash
# Prepare one map through extraction, terrain, upscaling, map sprites and its shared theater library
pnpm hd:prepare -- --map XMP29U2.MAP --cache "$HD_CACHE"
pnpm hd:prepare -- --map RiverRam.yro --game "$RA2_INSTALL" --cache "$HD_CACHE" --dry-run

# Extract (defaults: --game <repo>/game/ra2, --out <repo>/gameres/hd-cache; --map may repeat)
pnpm hd:extract -- --map RiverRam.yro --map IsleLand.yro
pnpm --filter ra2-assets extract -- --game <install dir> --map <file> [--out <dir>] [--voxels MTNK,HTNK]

# Composite <out>/<mapId>/ into preview.png the way the original engine draws the map
pnpm hd:preview -- --map RiverRam --map IsleLand [--cache <dir>] [--models] [--foundations] [--unlit] [--full]

# Composite only unlit terrain, with transparency and an open-water mask (map may repeat)
pnpm hd:terrain-map -- --map RiverRam [--cache <dir>]

# Type library for live matches (defaults: all six theaters, --out <repo>/gameres/hd-cache/_library)
pnpm hd:library -- [--game <install dir>] [--theater temperate --theater snow ...] [--out <dir>] [--preview]

# Effect art sidecar for live matches (defaults: all six theaters, --out <repo>/gameres/hd-cache/_library/common/effects);
# --table also writes the HD garnish table the live renderer imports
pnpm hd:effects -- [--game <install dir>] [--theater urban ...] [--out <dir>] [--table packages/hd-renderer/src/live/effectTable.ts]

# Upscale the scale-1 composite with a separately installed Real-ESRGAN ncnn-vulkan executable
pnpm hd:upscale -- --map RiverRam [--cache <dir>] [--scale 2] [--model realesrgan-x4plus] [--tile 256]
pnpm hd:upscale -- --map RiverRam --bin <binary-path> --compare 1200,700,160,100

# Map light sidecars next to an existing cache: lights.json always; lit-window masks with --windows; review images
# with --preview; per-page window masks of a type library with --library <theater> (never rewrites manifests)
pnpm hd:lights -- --map XMP29U2 --map RiverRam [--game <install dir>] [--cache <dir>] [--windows] [--preview]
pnpm hd:lights -- --library urban [--cache <dir>]

# Build offline 2x sprite colours and house-remap masks from an existing indexed atlas
pnpm hd:sprites -- --map RiverRam [--cache <dir>] [--bin <binary-path>] [--model realesrgan-x4plus]
pnpm hd:sprites -- --library temperate --pages 0 [--cache <dir>] [--bin <binary-path>]

# Material sidecars: the voxel lighting table into <library>/common/, colour-matched HD terrain per map
pnpm hd:materials -- [--game <install dir>] [--out <library dir>]
pnpm hd:materials -- --terrain XMP29U2 --terrain RiverRam [--cache <dir>] [--sigma 2]
```

## Prepare a complete map cache

`prepare-map` runs the existing Node steps in order: `extract,terrain,upscale,sprites,library,library-sprites`.
`remat` is opt-in. `--steps` selects an exact subset, always executed in that order, with `remat` last; prerequisites
must already exist when their steps are omitted. The package command is `pnpm --filter ra2-assets prepare-map -- ...`.
Relative CLI paths resolve against the directory from which pnpm was invoked.

`--map` accepts one supported map file/path or cache id (the file's stem). For extraction by id, the command reuses
the cached source name, searches loose map filenames, then tries the stock archived `<id>.map`. Ambiguous loose ids
require an explicit filename. Defaults are this checkout's `game/ra2`, `gameres/hd-cache`, and
`gameres/tools/realesrgan/realesrgan-ncnn-vulkan`; override with `--game`, `--cache`, and `--bin`.
Nothing is downloaded. Use an external disposable cache for testing or inspection.

An existing map directory always skips extraction unless `--force` is given, even when the original map is newer.
Use `--force` to refresh it (including an incomplete extraction). Re-extraction keeps existing `terrainMap`,
`spriteAtlasHd`, and unknown top-level extensions whose cache-relative file references still exist; freshly
extracted fields take precedence. Extensions without file references are retained. File references are recognized
by `file`/`files`, `path`/`paths`, `waterMask`, `remap`, and image/JSON/binary suffixes, including nested values.
Selected dependent steps rerun, and invalidation persists for dependencies omitted from this invocation.

`--force` rebuilds selected map steps. The shared theater library is extracted only when its `library.json` is
missing, including under `--force`. Library sprite processing selects only incomplete or outdated pages, retaining
completed pages. Incremental checks compare input/output existence and modification times, plus recorded input
metadata signatures. Changes to generated manifest references alone do not invalidate unrelated steps.

`--scale` defaults to 2 and accepts integers 1 through 4, matching the existing x4plus wrapper. The planner chooses
the largest scale no greater than the request that fits within 16384 pixels on both axes; it fails if 1x cannot fit.
Outputs above 8192 pixels produce a warning because that is WebGPU's default limit; the renderer requests the
adapter maximum. Sprite output remains 2x regardless of terrain scale.

Each step prints its action, reason, and elapsed time. `<cache>/<mapId>/prepare.json` records the latest invocation,
step results (including failures), timings, Node/package/cache format versions, and reusable input signatures.
An interrupted step remains invalidated until successful completion. `--dry-run` prints the plan without creating
directories, writing logs or assets, or starting any runner. For new caches, dimensions/theater/pages are reported
as deferred until extraction; real execution re-evaluates each step against the preceding results.

```bash
# Inspect the plan without invoking tools or writing a cache.
pnpm hd:prepare -- --map RiverRam --cache "$HD_CACHE" --dry-run
# Refresh a map and its selected dependent outputs, using a separately installed executable.
pnpm hd:prepare -- --map RiverRam.yro --game "$RA2_INSTALL" --cache "$HD_CACHE" --bin "$REALESRGAN_BIN" --force
# Opt into diffusion after the ordinary pipeline, or use --steps remat on an already prepared cache.
pnpm hd:prepare -- --map RiverRam --cache "$HD_CACHE" --steps extract,terrain,upscale,sprites,library,library-sprites,remat
```

Rematerialization runs `python/rematerialize.py` with this checkout's
`gameres/tools/diffusion/.venv/bin/python` and explicit `gameres/tools/diffusion/models`, using strength 0.55,
control 0.7, guidance 5.5, 28 steps, and `--resume`. It always identifies the pre-rematerialization input explicitly
so reruns do not diffuse an already rematerialized image. Urban/newurban retain the Python default negative prompt;
other theaters append `cracked earth, dried mud cracks, cobblestones, paving stones, tiles, bricks`.
The Python script's own `--dry-run` is never invoked by this command, since that mode writes outputs.

The injectable Node API is `prepareMap(options, runners)` in `src/node/prepareMap.ts`; `planPrepareMap(options)` is
read-only. `src/node/prepareMapRunners.ts` contains the production adapters. `tests/prepareMap.test.ts` uses temporary
synthetic manifests, PNGs, and fake runners to verify planning, preservation, freshness, failure recovery and limits.

`--map` accepts `.yro`/`.mmx` packages (MIX archives holding `<stem>.map` and a `.pkt`) and plain `.map/.mpr/.yrm`
INI files, as a path or a file name inside the game directory. `--models` adds a strip with every extracted voxel
model, `--foundations` outlines building foundations, `--unlit` skips the map's `[Lighting]` tint. The preview is
cropped to the playable area (`visibleRect`, the engine's camera limits from `[Map] LocalSize`); `--full` draws the
whole `[Map] Size` area including the border strips the player never sees.

Both terrain commands default to `<repo>/gameres/hd-cache` and write into `<cache>/<mapId>/`. For inspection of an
existing cache without modifying it, first copy the map directory to a disposable cache and pass `--cache` to both
commands. The derived outputs must stay out of Git and must not be redistributed.

`terrain-map` shares the preview's depth-sorted diamond and extra-graphics passes. It includes all extracted cells,
uses tight terrain bounds without sprite margins, ignores map lighting, and retains raw atlas RGB/alpha. It writes
`terrain-map.png` (RGBA) and `terrain-water.png` (grayscale), then updates `manifest.terrainMap`. The stored origin is
the engine screen coordinate of the image's top-left pixel; subtract it to get scale-1 image coordinates.
The Node API `renderTerrainMap({ cacheDir, writeManifest: false })` writes the images without changing the manifest
and returns pixels plus last-writer tile attribution. The pure `buildWaterMaskBytes` export (also available through
`ra2-assets/waterMask`) works with whole-map or atlas pixels and uses no Node APIs.

`upscale` defaults to scale 2, `realesrgan-x4plus`, and tile size 256. It looks for the executable at
`<repo>/gameres/tools/realesrgan/realesrgan-ncnn-vulkan`, or at `--bin`, with models in the executable's sibling
`models/` directory. The tool does not download the executable or models. It runs the x4plus and x4plus-anime models
at native 4x, then uses an exact linear-light area box filter for smaller integer scales (1 through 4). The
`realesr-animevideov3` model passes the requested scale directly to the executable and supports 2 through 4; use
x4plus for 1x output. Suffixed names such as `realesr-animevideov3-x3` must agree with `--scale`. Transparent borders are filled
with up to 16 four-neighbour colour-dilation passes and an opaque-pixel mean fallback before inference; alpha and
the water mask are resized separately with pixel-centre bilinear sampling.

The upscaler writes `terrain-map@<scale>x.png` and `terrain-water@<scale>x.png`, updating only `manifest.terrainMap`
after successful processing. The original scale-1 files remain the source for subsequent runs. Binary progress is
streamed to stderr, and temporary inference files are removed on success or failure. Outputs exceeding 8192 pixels
on either axis produce a WebGPU texture-limit warning. `--compare x,y,w,h` selects a crop in scale-1 image pixels
(relative to the image's top-left) and writes `upscale-compare.png`: nearest-neighbour original on the left,
upscaled terrain on the right, both at the requested output scale.

## Offline HD sprite atlases

`sprites` accepts exactly one `--map <id>` or `--library <theater>`. The cache root defaults to
`<repo>/gameres/hd-cache`: maps are read from `<cache>/<id>/manifest.json`, libraries from
`<cache>/_library/<theater>/library.json`. Map ids are cache directory names, not input map paths. Library mode
processes every page by default; `--pages 0,3` selects distinct zero-based page indices. As with terrain upscaling,
`--bin` selects a separately installed executable, with its sibling `models/` directory; the default binary is
`<repo>/gameres/tools/realesrgan/realesrgan-ncnn-vulkan`. The default model is `realesrgan-x4plus`. Nothing is downloaded.

The input stays indexed: R8 library pages and legacy map RGBA pages (index in red) are both supported. Each body
frame uses its sprite's palette. Index 0 becomes transparent; remappable sprites replace indices 16 through 31
with the neutral grey ramp `round(255 - (index - 16) * 15)` and mark them in a separate mask. Other sprites retain
their palette colours, including indices 16 through 31. Shadow frames are omitted entirely: the renderer must
continue drawing shadows from the original indexed atlas.

Frames are packed into input sheets normally no larger than 2048x2048, each with 16 source pixels of transparent padding
on every side. Colour bleeding is isolated per padded frame before packing, so adjacent atlas frames never share
their bleed colours. The reused Real-ESRGAN wrapper runs each sheet at 4x; each frame is cut out and reduced to 2x
with a linear-light box filter, then placed into its original rectangle multiplied by two. Frames larger than
2016 pixels on either axis receive dedicated larger sheets, preserving their full inference context at additional memory cost. Alpha is bilinear-resized
from the binary source alpha and sharpened with smoothstep over 0.35 through 0.65. The remap mask is bilinear-resized
separately and stays soft. Uncovered pixels and shadow rectangles stay transparent. Frame offsets, indexed files,
palettes, and normalized UVs stay unchanged.

For an indexed `<stem>.png`, the step writes `<stem>@2x.png` (RGBA) and `<stem>@2x-remap.png` (single channel).
Successful map processing updates only `manifest.spriteAtlasHd = { file, remap, scale: 2, width, height }`.
Library processing records the same reference in `library.spriteAtlasesHd[page]`; unprocessed slots are `null`,
and existing references for unselected pages are preserved. References are written after both page outputs
complete. Library pages run sequentially and each completed page is recorded, so an error on a later page does
not discard earlier completed pages. No renderer changes are included in this offline step: consumers must use
the grey colour layer and soft mask to apply house colours, and continue using the indexed shadow frames.

HD references may also include `paintSaturation` (0..1, absent = 1). The renderer reduces only the decoded house
colour's saturation in linear light, preserving Rec.709 luminance and the grey ramp's shading. At 1 or absent,
the shader adds no grading nodes.

**Debug mode:** `--limit-frames N` limits the body frames processed on **each selected page**, writes
`<stem>@2x-debug.png` and `<stem>@2x-debug-remap.png`, and never changes manifest/library references or normal HD
outputs, even if N covers every frame. Unprocessed body frames are transparent. Use this mode for a quick visual
trial; remove the option to publish complete page references in the local cache.

Each page reports processed frames, batch count, inference input megapixels, total wall time (including PNG I/O),
and binary time. A 4096x4096 page produces 8192x8192 outputs; the raw RGBA/mask pair alone occupies 320 MiB before
PNG compression. Actual memory also includes the source page and the active batch. Real timing depends on GPU,
model, sheet occupancy and PNG encoding. A fake nearest-neighbour binary measures orchestration and I/O only;
estimate a theater by measuring one representative real page and scaling by total batch input megapixels, with
per-page output encoding overhead. Fake timing does not establish Real-ESRGAN throughput or visual quality.

Run from the repository root, with `SPRITE_CACHE` pointing to the cache to update and `REALESRGAN_BIN` to the
separately installed executable:

```bash
# One map cache; the original indexed sprites.png remains unchanged.
pnpm hd:sprites -- --map RiverRam --cache "$SPRITE_CACHE" --bin "$REALESRGAN_BIN" --model realesrgan-x4plus
# One library page; all other page references remain unchanged.
pnpm hd:sprites -- --library temperate --pages 0 --cache "$SPRITE_CACHE" --bin "$REALESRGAN_BIN" --model realesrgan-x4plus
```

The Node entry points are `upscaleSpriteAtlas` in `src/node/spriteHd.ts` (pixels in/out) and `upscaleSprites` in
`src/node/spriteHdCache.ts` (cache orchestration). Both accept an injectable `run(bin, args)` for asset-free tests.

## Map lights and lit windows (`hd:lights`)

`hd:lights` reads a cached map's `[Lighting]`, its light-source buildings and the rules/art they use from the player's
own install and writes sidecars next to the cache. It refuses to run without `manifest.json`, never writes
`manifest.json` or `library.json`, and records the manifest's sha256 in `lights.json` (`extractor.manifestSha256`).
The contract is `src/lights.ts` (`MapLightsSidecar`, version `MAP_LIGHTS_VERSION`); the engine behaviour it encodes,
with disassembly addresses, is in `docs/remaster/research/yr-scene-lighting.md`.

- `lights.json`: the engine-rounded `[Lighting]` (normal, Ion Storm, Dominator, and which keys took constructor
  defaults); the map's atmosphere profile (`mapAtmosphere`: day, dusk or night from the authored `Ambient - Ground`,
  tint and lamp posts; default hour, night level, tint; renderers recompute it with `sidecarAtmosphere`);
  every BuildingType with `LightIntensity != 0` (map sections override rules); the map's light sources with their
  lepton centre and matching `manifest.objects` index; inert TerrainType lights (TIBTRE); `hiddenObjects`
  (`InvisibleInGame=yes` objects such as `INGALITE`, which the engine never draws); a per-cell surface class
  (`classifyTileSurface`: land type plus the tile diamond's mean colour) and the median height; and HD street lamp
  spots (`placeStreetLamps`, city theaters only, seeded and deterministic, at least 4.5 cells apart, next to roads,
  off buildings and trees, inside the playable rectangle).
- `windows.png` / `windows.json` (`--windows`): an RGBA mask with the layout of `sprites.png` (R = lit window,
  G = per-window variant) from `detectBuildingWindows` (`src/windows.ts`) on each building's healthy frame; the damaged
  frame keeps only windows the healthy frame has at the same canvas point. The pane detector lights a pane whole (its
  bounding box), and only when its dark pixels with the highlights they enclose fill at least `PANE_FILL` (60 %) of
  that box, so fragments that straddle mullions never light up as glyph-like shapes. Where it covers less than
  `FALLBACK_COVERAGE` of the facade and a large-pane profile finds clearly more (wider contrast box, larger and slanted
  panes, a minimum size), that profile is used instead, with candidates on the roof dropped (`roofBottom`: the
  silhouette top plus the roof diamond's depth at each column), so rooftop vents and fans stay dark. `windows.json`
  (version 2) lists lit pixels, their centroid and the lit-pane columns (`windowColumns`: centre x, panes, lowest lit
  y) per frame; renderers place wet reflections under the columns. Only civilian art (`CA*` types) gets lit windows;
  faction buildings stay dark, as do the types in `data/window-deny.json`.
- `lights-preview.png` / `windows-preview.png` (`--preview`): the surface classes and the map at its default night
  (engine light of its sources, light and street lamp markers), and a contact sheet of building frames with every
  window candidate filled cyan and outlined magenta.
- `--library <theater>`: `_library/<theater>/windows-<n>.png` for the atlas pages holding lit building frames, plus
  `windows.json` (`pages` maps page numbers to files).

Window review (the gate for lit windows by default): on XMP29U2's contact sheet the facade repetition test
(`hasSiblings`) removed nearly all roof, ladder and ornament detections; after denying the lamp posts, the airfield,
the Alamo ruin, storage tanks, the oil derrick and the warehouse (`data/window-deny.json`), the remaining false
detections are isolated specks, well under 5 % of detected windows, so lit windows are on by default at night. The
type library's faction buildings showed scattered specks on military art (GATECH, NAWEAP, NAREFN, the YACOMD
lattice), which read as embers at night, so windows are limited to civilian `CA*` types. The large-pane profile lights
the facades the pane detector missed on XMP29U2 (CASTL01, CASTL02, CASTL03, CAWASH03, CAWASH05's window bands,
CAWASH07, CAWASH10, CAMIAM01, CACHIG01/02); CACHIG's tall mullioned panes are still only partly lit, and a few
parapet specks remain on CAWASH03.

## Local terrain re-materialization (Python)

`python/rematerialize.py` adds surface detail to the current `terrainMap.file` with local SDXL img2img and tile
ControlNet. It requires an RGBA input and the matching grayscale `terrainMap.waterMask`; `--input` selects another
image inside the map directory with the same dimensions. No models or dependencies are downloaded. The separately
installed Python environment needs torch, diffusers, transformers, accelerate, safetensors, NumPy and Pillow;
`--dry-run` needs only NumPy and Pillow. Model subdirectories are `sdxl-base` (fp16 safetensors variant),
`sdxl-vae-fp16-fix` and `controlnet-tile-sdxl`. Inference uses MPS fp16, or CPU float32 with a warning.

Set `RA2_MAIN_CHECKOUT` to the main checkout and `REMAT_CACHE` to a disposable copy of the cache **outside `gameres/`**.
Run from the checkout containing this script:

```bash
"$RA2_MAIN_CHECKOUT/gameres/tools/diffusion/.venv/bin/python" -B packages/ra2-assets/python/rematerialize.py \
  --map RiverRam --cache "$REMAT_CACHE" --models "$RA2_MAIN_CHECKOUT/gameres/tools/diffusion/models" \
  --input terrain-map@2x.png --region 2400,1400,512,512 --resume
# After inspecting remat-compare.png, repeat without --region for the whole map.
python3 -B -m unittest discover -s packages/ra2-assets/python -p 'test_*.py'
```

Region coordinates are **current input pixels**, not scale-1 engine pixels; choose an in-bounds terrain crop.
Region mode writes only `remat-compare.png` (input left, result right) and leaves the manifest untouched. Full mode
writes `<input-stem>-remat.png` next to the input and changes only `terrainMap.file`; existing outputs get numbered
successors. `--dry-run` uses identity inference but still writes outputs and, in full mode, updates the manifest.

Defaults are `--strength 0.4 --steps 24 --guidance 5 --control 0.8 --tile 1024 --overlap 192 --seed 7`.
Normalized raised-cosine overlaps blend tiles; `--color-sigma 6` restores original low-frequency colour/shading.
Alpha and all water-mask values above 0.5 are preserved exactly, with `--water-feather 3` softening onto land.
`--prompt` overrides the terrain prompt; the fixed negative prompt discourages objects and perspective changes.
These constraints guide diffusion but cannot guarantee unchanged landmarks; inspect the region trial before a full run.
`--resume` saves completed tiles under `<cache>/<map>/.remat-tiles/`, keyed by input pixels, parameters and local model
file metadata. Repeat the same explicit `--input` to reuse them after a successful manifest update. Region and full
runs use separate caches and tile layouts. Removing `.remat-tiles/` only discards resumable work.

Without overrides, cache/models resolve to the main checkout's `gameres/hd-cache` and `gameres/tools/diffusion/models`,
not this worktree. An explicit `--cache` or `--models` path under another checkout's `gameres/` selects that checkout
for the omitted companion path; arbitrary external paths retain the main-checkout default for the companion.

## Supersampled terrain re-detail (Python, experimental)

`rematerialize.py` diffuses the Real-ESRGAN 2x terrain at 2x, and on XMP29U2 its output is smoother than the original
art: Real-ESRGAN removes the tiles' texture first, and SDXL cannot draw features below its 8 px latent cell. Measured on
a 1024 px test tile, lawn texture at the 2-8 px scale dropped to about a third of the original's.
`python/redetail_terrain.py` instead diffuses at 4x of the scale-1 composite (`terrain-map.png`): Real-ESRGAN 4x for
clean markings and kerbs, plus the original tiles' own high-pass texture re-added on flat ground (not near strong
edges), so the model turns it into grass blades, grain and cracks. The result is area-averaged back to the base scale
in linear light and colour-matched to the original in CIE Lab like `hd:materials` (sigma 2 source pixels, 0.5 on thin
structures). Water-mask pixels and alpha come from the base image; with `--region` (base-scale pixels) the result is
pasted into a full-size copy of the base with a raised-cosine feather over `--margin`. It never modifies the manifest
or `materials.json`; point `materials.json` at the output after review. Run it under the shared GPU lock when other
local jobs use the GPU; completed tiles resume from `--work`.

```bash
"$RA2_MAIN_CHECKOUT/gameres/tools/diffusion/.venv/bin/python" -B packages/ra2-assets/python/redetail_terrain.py \
  --map XMP29U2 --region 1500,670,3360,2100 --margin 256 --work "$WORK" --output "$WORK/terrain-map@2x-final.png"
python3 -B -m unittest discover -s packages/ra2-assets/python -p 'test_redetail_terrain.py'
```

Defaults: `--gen-scale 4 --hybrid-alpha 1 --hybrid-sigma 4 --strength 0.6 --control 0.6 --guidance 6.5 --steps 30
--seed 7 --tile 1024 --overlap 192 --blend 96 --color-sigma 2 --structure-color-sigma 0.5` with `rematerialize.py`'s
prompts. `--blend` limits each tile cross-fade to a band centred in the overlap, so the edge-anchored last row and
column do not average two generations over most of a tile. Omit `--region` for the whole map (about 160 tiles of
roughly 37 s on an M5 Pro for XMP29U2). `--dry-run` replaces diffusion with identity for pipeline checks; post-processing
options (`--blend`, colour sigmas, `--margin`) reuse the cached tiles, so they can be changed without the GPU.

## Tiled terrain, lake shores and cliff feet (Python)

These tools require NumPy, Pillow and OpenCV (`cv2`). All source images, cache and work directories are explicit
arguments; keep generated art outside Git. They preserve terrain alpha and do not edit manifests or material sidecars.

- `python/terrain_tiles.py`: `prep` cuts `--source` using `--water-mask` and `--prompt` into `--tiles`, writing
  `input.png`, `prompt.txt`, `tile.json` and a default `queue.txt`. `run` invokes a supplied CLI; `check` writes per-tile
  `check.json` registration/colour diagnostics. `assemble` aligns, colour-locks and quilts `output.png` tiles into
  `--output`; absent outputs retain the source. The result feeds `materials.json.terrainMap`.
- `python/lake_shore.py`: takes the colour-matched original `--classification`, repainted `--terrain` and original
  `--water-mask`, all at 2x composite resolution. It extends connected painted shallows and paints a dry lake bed,
  producing `--output` for `terrainMap` and `--output-mask` for `waterMask`; set `waterBed: true` (a boolean, not a file).
- `python/cliff_foot.py`: reads `<cache>/manifest.json` cell levels/ramps and composite scale/origin, plus the bed
  `--terrain` and extended `--water-mask`. It produces wet rock/foam in `--output` (`terrainMap`), `--output-ignore`
  (`shoreIgnore`), and optionally `--output-mask` (`waterMask`) with flooded foot strips. Retain `waterBed: true`.

Set the path variables below to your local inputs and output directories. Supply the external CLI's argv template as
`TERRAIN_TILES_COMMAND` or `run --command`; there is no default binary. Quote template arguments normally: placeholders
`{tile}`, `{input}`, `{output}`, `{prompt_file}`, `{prompt}` and `{last}` expand **after** argument splitting, with no
shell evaluation. The CLI runs in each tile directory and must save `output.png`. Use a fresh tile directory for a
different source or prompt. Completed tiles are skipped; queues
are interleaved with 3 concurrent processes, a 1500-second timeout and at most 2 attempts. Polling defaults to 10 seconds.
`<work>/PAUSE` stops new launches while active jobs finish; a quota/rate-limit log writes `<work>/LIMIT_HIT.txt` and
also stops launches. `<work>/sched.log` records progress; incomplete queues return a nonzero exit code.

```bash
python3 -B packages/ra2-assets/python/terrain_tiles.py prep --source "$SOURCE" --water-mask "$WATER_MASK" \
  --prompt packages/ra2-assets/python/terrain_tiles_prompt.example.txt --tiles "$TILES"
python3 -B packages/ra2-assets/python/terrain_tiles.py run "$TILES/queue.txt" --work "$WORK"
python3 -B packages/ra2-assets/python/terrain_tiles.py check --tiles "$TILES"
python3 -B packages/ra2-assets/python/terrain_tiles.py assemble --source "$SOURCE" --tiles "$TILES" \
  --output "$WORK/terrain.png"
python3 -B packages/ra2-assets/python/lake_shore.py --classification "$CLASSIFICATION" --terrain "$WORK/terrain.png" \
  --water-mask "$WATER_MASK" --output "$WORK/bed.png" --output-mask "$WORK/shore-water.png"
python3 -B packages/ra2-assets/python/cliff_foot.py --cache "$CACHE" --terrain "$WORK/bed.png" \
  --water-mask "$WORK/shore-water.png" --output "$WORK/terrain-final.png" \
  --output-ignore "$WORK/shore-ignore.png" --output-mask "$WORK/water-final.png"
python3 -B -m unittest discover -s packages/ra2-assets/python -p 'test_*.py'
```

The tuned defaults remain 1536x1024 composite-pixel tiles, 1280x768 strides, water coverage > 0.85 skipped, Lab blur
sigmas 20/10 px with lightness/chroma lock 0.75/1.0, and a 3 px seam feather. Small composites use their actual crop
size; adapt the example prompt's dimensions for those. Lake-bed distances use 84 composite px/cell; cliff heights
use 15 × manifest scale composite px/level and ignore plateaus at least 2 levels above nearby water. Module docstrings
and `--help` describe the remaining tuned constants and optional diagnostics. Review the outputs before assigning
the final filenames, relative to the map cache, to `terrainMap`, `waterMask` and `shoreIgnore` in `materials.json`.

## Water surface, detail and cliff-foot stripe tools (Python)

These NumPy/Pillow/OpenCV tools take all input and output paths as arguments, generate PNGs outside Git, and never
edit `materials.json`. Filenames assigned to that sidecar are relative to the map cache.

- `python/water_surface.py` blends chop and foam textures with half-offset copies and variance compensation. Its
  RGBA tile feeds `waterSurface`: R = relief ratio / 2, G = glints, B = foam lace, A = 255. Defaults are `--size 1024`,
  `--glint-percentiles 93.5 99.6` (power 1.5) and `--glint-gain 1`. It prints channel/seam statistics and writes
  `<out-stem>_chop_seamless.png`. `waterSurfaceScale` controls the repeat width in screen units of 30 engine pixels
  (default 13), independently of the texture's pixel size.
- `python/cliff_foot_stripe.py` inpaints light grey pixels at water edges near `shoreIgnore`, preserving terrain
  alpha. Use its output as `terrainMap`; `--mask-out` optionally saves the repair selection. Defaults are
  `--saturation 0.2 --value 110 --vertical-reach 7 --cliff-reach 12 --inpaint-radius 5`; distances are composite pixels.
- `python/water_detail.py` registers `--repaint` to `--repaint-input` with ECC, combines the target's shore-distance
  colour profile with repaint variation, and fills land with push-pull. Its RGBA output feeds `waterDetail`:
  RGB = sRGB water colour, A = roughness/glitter weight. Supply both composite-size masks and the target's
  `--target-box X0 Y0 X1 Y1` in composite pixels; target image dimensions are read automatically. The repaint mapping
  is `composite = screen * repaint-scale + repaint-offset`, with input pixels scaled by `repaint-screen-scale`.
  All three transform arguments are required. `--detail-scale 4` rounds output dimensions up; `--cell-size 84.85`
  is composite pixels per cell after stretching y by 2. Set it for your composite resolution. Defaults are
  `--gain 1 --sigma 3 --target-spatial 0`; sigma is in detail pixels. Target spatial variation accepts 0..1 and uses
  the same water-colour filter as the target profile, with `--target-border 40` controlling the framing-relative
  fade. Optional `--correction file.json` supplies `{"ratio": [[r, g, b], ...]}` with 17 nonnegative RGB multipliers
  in the profile-bin order recorded in `<out>.json`; an optional `bins` array must match that report. The report
  also records ECC registration and framing. Missing profile samples or failed registration are errors.

Set the path and framing variables to your inputs. Keep `waterBed: true` for enhanced water; `waterSurface` also
requires `waterDetail`. Inspect the generated layers before assigning their filenames to the sidecar.

```bash
python3 -B packages/ra2-assets/python/water_surface.py --chop "$CHOP" --foam "$FOAM" --out "$WORK/water-surface.png"
python3 -B packages/ra2-assets/python/cliff_foot_stripe.py --terrain "$TERRAIN" --water-mask "$WATER_MASK" \
  --shore-ignore "$SHORE_IGNORE" --out "$WORK/terrain-clean.png" --mask-out "$WORK/stripe-mask.png"
python3 -B packages/ra2-assets/python/water_detail.py --repaint "$REPAINT" --repaint-input "$REPAINT_INPUT" \
  --repaint-scale "$REPAINT_SCALE" --repaint-offset "$OFFSET_X" "$OFFSET_Y" \
  --repaint-screen-scale "$REPAINT_SCREEN_SCALE" --target "$TARGET" --target-box "$X0" "$Y0" "$X1" "$Y1" \
  --water-mask "$WATER_MASK" --shore-ignore "$SHORE_IGNORE" --composite-size "$COMPOSITE_W" "$COMPOSITE_H" \
  --cell-size "$CELL_SIZE" --out "$WORK/water-detail.png"
python3 -B -m unittest discover -s packages/ra2-assets/python -p 'test_*.py'
# Equivalent discovery when pytest is installed:
python3 -B -m pytest packages/ra2-assets/python -q
```

## Local sprite re-detailing (Python, experimental)

`python/redetail_sprites.py` repaints selected body frames of a map cache's HD sprite atlas (`hd:sprites` output) with
the same local SDXL + tile ControlNet, so buildings and trees gain material detail instead of only losing aliasing.
Frames are packed per category into sheets (overlay types each get their own), upscaled 4x with the local Real-ESRGAN
binary, composited on flat grey and repainted at 4x; `compose` then downsamples to the atlas's 2x, replaces low
frequencies with the original palette art in CIE Lab (mask-normalised Gaussian, so the background never leaks in),
copies the base HD atlas's alpha bit for bit (silhouettes cannot change), re-encodes house-paint pixels on the grey ramp
the renderer inverts (the remap mask stays valid) and leaves shadow frames untouched. It never modifies the cache or
its manifest: `--out` writes a separate atlas with the same size and layout, and `metrics.json` records per frame the
silhouette IoU, content shift (phase correlation), edge correlation, low-frequency colour delta E and texture gain
against the current HD atlas.

```bash
PY="$RA2_MAIN_CHECKOUT/gameres/tools/diffusion/.venv/bin/python"
# GPU stage (hold the machine's GPU lock if several jobs share it); sheets are cached under --work.
"$PY" -B packages/ra2-assets/python/redetail_sprites.py generate --map XMP29U2 --work "$WORK" \
  --region-box 630,260,2310,1310 --describe "$WORK/describe.json" --strength 0.8 --control 0.9 --guidance 7
# CPU stage: colour/alpha restore, atlas copy and metrics.
"$PY" -B packages/ra2-assets/python/redetail_sprites.py compose --map XMP29U2 --work "$WORK" \
  --region-box 630,260,2310,1310 --sigma-l 3 --sigma-ab 2.5 --detail 1.3 --out "$WORK/sprites@2x-final.png"
```

`--region-box` selects the objects drawn inside a `preview.png` pixel box (`--sprites id[:frames]` selects explicitly,
`--frames all` or an index list adds frames), `--describe` maps sprite ids (or `<category>:*`) to short prompt
descriptions, `--override prefix=sigma_l,sigma_ab,detail` tunes the colour restore per sprite-id prefix, and
`--upscaler lanczos --strength 0` is a CPU-only dry run. Work directories hold derived art and belong outside Git.

## Hybrid per-object redraw (Python, experimental)

`python/hybrid_redraw.py` lets an external image-editing model redraw one object frame at a time (buildings, trees,
fence overlays), then decides automatically whether the redraw may replace the faithful frame. `prepare` writes each
frame's model input (Real-ESRGAN 4x on flat grey, small objects enlarged); `run` calls the image model through the
Codex CLI (`--codex`, one directory per attempt with prompt, output and log), registers the output to the input
(axis-aligned scale + translation, Gauss-Newton on blurred luminance), resamples it in linear light, copies the HD
atlas's alpha bit for bit, locks low-frequency Lab colour to the original art and re-encodes house paint. The checks
compare against the original art: edge-structure correlation (global and per tile), surface-decoration retention,
facade-grid projection profiles (both isometric floor directions and the vertical), internal structural edges, low-
frequency colour delta E, content outside the silhouette and model rescaling. A failing frame is redrawn with a prompt
that names the failure; after `--max-attempts` it is flagged and keeps the faithful frame. With `--damaged`, frame 1 of
each accepted building is redrawn with the accepted frame 0 as a material reference and checked for consistency with
it. `compose` writes a copy of the faithful atlas with accepted frames replaced; `decisions.json` records every attempt.

```bash
PY=python3  # numpy + Pillow; the diffusion venv works as well
"$PY" -B packages/ra2-assets/python/hybrid_redraw.py prepare --map XMP29U2 --work "$WORK" \
  --region-box 630,260,2310,1310 --describe "$WORK/describe.json" --damaged --lock "$GPU_LOCK"
"$PY" -B packages/ra2-assets/python/hybrid_redraw.py run --map XMP29U2 --work "$WORK" \
  --region-box 630,260,2310,1310 --describe "$WORK/describe.json" --damaged --faithful "$FAITHFUL_ATLAS" \
  --codex "$CODEX_BIN" --parallel 4 --max-attempts 4
"$PY" -B packages/ra2-assets/python/hybrid_redraw.py compose --map XMP29U2 --work "$WORK" \
  --region-box 630,260,2310,1310 --describe "$WORK/describe.json" --damaged --faithful "$FAITHFUL_ATLAS" \
  --out "$WORK/sprites@2x-hybrid.png"
python3 -B -m unittest discover -s packages/ra2-assets/python -p 'test_hybrid_redraw.py'
```

`--describe` maps sprite ids to `{subject, colours[, noun, subject_damaged]}` (sprites without an entry are skipped),
`--attempts tree=1` limits attempts per category, `--thresholds` overrides the calibrated `DEFAULT_THRESHOLDS`, and
`--dry-run` re-evaluates existing attempts without new model calls. The thresholds were calibrated on one map region
(XMP29U2 city buildings); treat them as a starting point elsewhere. Work directories hold derived art and model
outputs and belong outside Git.

`--style-ref <image>` adds a style reference: an image covering `--region-box` exactly at 1x (for example an approved
concept painting of that region, aligned to the preview crop). Each frame gets the crop of its cleanest placement in the
reference as `style_reference.png`, and the prompt asks for that rendering style (materials, recessed windows, bevelled
cornices, light and shade) while the structure rules stay; `--style-lock-l <0..1>` takes that share of the colour
lock's low-frequency lightness target from the reference where it shows the object cleanly (hue and saturation stay
the original's). Because lightness may now move, loosen `lf_dE_mean` / `lf_dE_p95` with `--thresholds` accordingly.

## Infantry page finishing (Python, experimental)

`python/infantry_sheets.py build` composes redraw sheets, accepts frames by silhouette IoU, and pastes only frames
whose library `page` equals `--page`. Other-page frames are recorded with `accepted: false` and
`skipped: "other-page"` in `pages/report.json`. Optional `--rim-soften K` and `--paint-saturation S` both accept
0..1; defaults are 0 and 1, preserving existing pixels and paint grading. Saturation below 1 is recorded in the
installed `library.json` page entry and `library.l3-infantry.json`.

Rim softening runs after pasting, within accepted frame rectangles only. It selects opaque texels (alpha >= 128)
within two 8-neighbour steps of transparency or the frame boundary, excluding paint-mask values >= 128. It averages
non-rim opaque RGB in a frame-clipped 7x7 neighbourhood in linear light. Darker rim texels move towards that mean
by `K * (1 - luminance(rim) / luminance(mean))`, bounded to 0..K; missing references and brighter rims are unchanged.
Alpha and remap bytes are preserved. The result is rounded back to sRGB uint8.

`polish` applies the same operation to **all** frames of selected sprites on the requested page, reading the current
variant's colour/remap filenames from its own `library.json`:

```bash
python3 packages/ra2-assets/python/infantry_sheets.py build \
  --library "$LIBRARY" --work "$WORK" --page 21 --variant-dir "$VARIANT" \
  --rim-soften 0.5 --paint-saturation 0.82
python3 packages/ra2-assets/python/infantry_sheets.py polish \
  --library "$LIBRARY" --page 21 --variant-dir "$VARIANT" --sprites infantry:CONS,infantry:SHK \
  --rim-soften 0.5 --paint-saturation 0.82 --suffix l4inf
python3 -m pytest packages/ra2-assets/python/test_infantry_sheets.py -q
```

`polish` writes `sprites-P@2x-<suffix>.png` and `sprites-P@2x-remap-<suffix>.png` (default suffix `l4inf`), then
atomically replaces the variant manifest with only that page's `file`, `remap`, and `paintSaturation` updated.
Its saturation default of 1 restores full house colour; its rim default of 0 preserves pixels. A symlinked manifest
is read through and replaced with a real file; existing output symlinks are also replaced without changing their
targets. Other page entries and manifest metadata survive. Repeated softening accumulates because it reads the
current variant. Source and variant directories must differ; derived art stays outside Git. Python stages need
NumPy and Pillow; the synthetic regression command additionally needs pytest.

## Tree and vegetation redraw (Python, experimental)

`python/tree_redraw.py` redraws a map's tree/bush TerrainTypes (`tree:TREE*` frame 0 and its shadow) in batches: one
image-model sheet per family (six to eight plants on flat grey 118, laid out by the spec) so a family is redrawn
coherently. `extract` pulls frame 0 and shadow 0 of each tree; `sheet` prepares the model input and prompt
(`--refine-from` feeds a previous model sheet back for a second, lighting-focused round); `process` fits the grey
background, mattes and unmixes the plants, registers each to its original frame (anisotropic scale + translation by
blurred-mask correlation) and area-resamples to the 2x frame size; `build` fills internal crown holes, adds crown-scale
volume shading (light penetration towards the art's sun, dome Lambert, crown-bottom occlusion) and locks Lab colour to
each destination map's original (lightness quantiles by `kL`, hue means, chroma spread by `kc`), then writes the 2x
patch and a 1x palette-index coverage mask; `fit-shadows` and `shadows` regenerate the shadow frames from the new
alpha by delta transfer through a billboard projection fitted to the original shadows; `apply` pastes only those
rects into a variant cache (a symlink farm; regular atlases already there keep other edits) and optionally writes dome
normals into the material atlas. The model call itself is made by the operator (see the module docstring).

```bash
PY=python3  # numpy + Pillow + OpenCV
SPEC=packages/ra2-assets/python/tree_redraw_spec.example.json
"$PY" -B packages/ra2-assets/python/tree_redraw.py build --spec "$SPEC" --cache-root gameres/hd-cache --map XMP29U2 \
  --orig-dir "$WORK/orig" --proc-dir "$WORK/proc" --patch-dir "$WORK/patch" \
  --cfg '{"kL":0.6,"kc":0.9,"volume":{"strength":1.6,"density":0.11,"rim":0.18},
          "grade":{"a":-20,"b":36,"k":0.45,"chroma":1.2,"lift":4}}'
"$PY" -B packages/ra2-assets/python/tree_redraw.py shadows --cache-root gameres/hd-cache --map XMP29U2 \
  --patch-dir "$WORK/patch" --fit "$WORK/shadow_fit.json"
"$PY" -B packages/ra2-assets/python/tree_redraw.py apply --map XMP29U2 --patch-dir "$WORK/patch" \
  --base gameres/hd-cache/XMP29U2 --variant-dir "$VARIANT/XMP29U2" --normals
python3 -m pytest packages/ra2-assets/python/test_tree_redraw.py -q
```

The `--cfg` above is the adopted setting (also recorded as `build_cfg` in the example spec): the partial lightness
lock keeps the redraw's sun-side highlights and crown shade while hue family and chroma stay the original's. The optional `grade` then moves only green foliage (Lab hue 75-165 degrees, feathered; bark, autumn rust and
near-neutral texels untouched) a share `k` towards a fresh grass-green Lab a/b, scales its chroma and lifts it, so
trees are graded together with the repainted lawn instead of keeping each map's olive original. Sheets,
model outputs, patches and variant caches are derived art and belong outside Git.

## Level 3 building redraw sheets (Python, experimental)

`python/l3_redraw.py` reuses the hybrid registration, checks and paint encoding for map caches and paged type
libraries. A JSON plan is a **list of jobs**, for example:

```json
[
  {
    "id": "NACNST",
    "source": "library",
    "house": "DarkBlue",
    "panels": [
      {
        "label": "intact",
        "parts": [
          { "sprite": "building:NACNST", "frame": 0 },
          { "sprite": "anim:NACNST_C", "frame": 0 }
        ]
      },
      {
        "label": "damaged",
        "parts": [
          { "sprite": "building:NACNST", "frame": 1 },
          { "sprite": "anim:NACNST_CD", "frame": 0 }
        ]
      }
    ],
    "prompt_file": "/path/to/full-prompt.txt"
  }
]
```

Parts use their anchor offsets and draw in list order. `paste: false` keeps a part in the input and checks but excludes
it from the atlas. Each panel has an 8 px original-scale margin and a 4x upscale; the sheet has 48 px grey gaps and
vertically centred panels. Only sheets shorter than 640 px on their long side are enlarged by an integer factor toward
1024 px. `layout.json` records canvas `[x,y,w,h]` panel boxes and original-scale part rectangles excluding margins.
Optional job fields: `style_reference` (copied as `style_reference.png`), `extra_images` (filename-to-path map), `lock`
and `thresholds`. Prompts are caller-written in full, including output instructions; retries only append named failures.

For make animations, add `"layout": {"cols": 5, "align": "anchor", "gap": 48, "sequence": true, "stabilize": true}`
and one ordered panel per frame. Every cell uses the union of all panel rectangles in original anchor coordinates,
so frames grow in place; parts retain their exact offsets, dimensions and alpha. Cells include the usual 4x margin,
are arranged row-major with grey gaps (default 48 px), and are never enlarged. `layout.json` adds `grid` with `cols`,
`rows`, `cell` dimensions, the original-scale `common_box`, alignment and sequence settings. Jobs without `layout`
retain the existing horizontal layout and output format. `sequence` and `stabilize` both default to false.

`sequence` adds consecutive-frame `temporal.pairs` to each attempt's metrics: `static_flicker_dE` measures CIEDE76
mean/p95 where both original nearest-neighbour 2x composites are opaque and exactly the same displayed colour;
`all_dE` covers every opaque overlap. Each reports pixel count and fraction of the current frame's original opaque
pixels; empty comparisons have null mean/p95. `stabilize` borrows the previous frame's final locked colour only where
original colour and paint index match, propagating in panel order before paint re-encoding. The innermost result is
fully shared; the one-pixel boundary inside the static region at 2x blends halfway. Per-panel `stabilized_fraction`
and `temporal.stabilized_fraction` count borrowed pixels, including that feathered boundary.

```bash
python3 packages/ra2-assets/python/l3_redraw.py prepare --plan "$PLAN" --work "$WORK" --library "$LIBRARY" \
  --realesrgan "$REALESRGAN" --gpu-lock "$GPU_LOCK"
python3 packages/ra2-assets/python/l3_redraw.py run --plan "$PLAN" --work "$WORK" --library "$LIBRARY" \
  --codex "$CODEX_BIN" --parallel 2 --max-attempts 2 --timeout 1200 --limit-file "$WORK/limit.txt"
python3 packages/ra2-assets/python/l3_redraw.py run --plan "$PLAN" --work "$WORK" --library "$LIBRARY" --no-model
python3 packages/ra2-assets/python/l3_redraw.py compose --plan "$PLAN" --work "$WORK" --library "$LIBRARY" \
  --out-root "$OUT_ROOT"
python3 packages/ra2-assets/python/l3_redraw.py delta --source library --library "$LIBRARY" \
  --body building:NAPOWR:0 --anim anim:NAPOWR_A --frames 0-17 --new-atlas-root "$OUT_ROOT" --out-root "$OUT_ROOT"
python3 -m pytest packages/ra2-assets/python -q
```

For map jobs, supply `--cache <hd-cache root> --map <name>`; compose optionally takes `--out-map <name>` and
`--base-atlas <PNG>` to explicitly reset the map atlas. Otherwise an existing regular variant `sprites@2x.png` is
the base; a missing file or symlink starts from the source atlas. `--upscaler lanczos` is the CPU-only prepare
path. `prepare` preserves existing inputs unless `--force`; `run` evaluates existing `attemptK/raw.png` (preferred) or
`output.png` without another call. A completed call's quota/rate-limit log stops new calls only if both images are
missing or the call exited nonzero; `429` must denote an HTTP error, not a token count. Running calls finish, and a
confirmed limit writes the limit file and exits nonzero. Missing outputs also exit nonzero. `decisions.json` records all attempts and the first passing
one, or the attempt with fewest failures as `FLAGGED`. **Compose includes both ACCEPTED and FLAGGED results**; inspect
each attempt's `panel_K_2x.png` and `metrics.json` before using them. Later jobs overwrite earlier overlapping frames.

The relaxed Lab lock defaults to `--lock 0.35,12,0.7,4` (wL,sL,wab,sab), with `--edge-hf 0.75`; per-job settings win.
The GPU command prefix uses `--gpu-lock`, separate from this colour lock. Checks retain hybrid thresholds except
`lf_dE_mean=12`, `lf_dE_p95=28`, `decoration_ratio=0.9`; `--thresholds '{"lf_dE_mean":15}'` overrides them. Lightness,
chroma and non-paint hue shift are also reported. Alpha is copied bit for bit; paint masks remain unchanged.

Composition and delta write touched map/library pages atomically, starting from existing regular variant pages so
other tracks' edits survive. Patches are loaded before reading the target; if its mtime/size or identity changes before
replacement, the target is re-read and patched again (at most three attempts, then an error). Missing files become
symlinks, including other maps, theaters and common assets. Directory symlinks are detached before writing; source
files are never modified. `l3_frames.json` merges this tool's final pasted 2x rectangles; an explicit map reset replaces
its records. Other tracks' reports are untouched.
`delta` aligns the old body/anim by their offsets, transfers glow in linear light onto the new body, and preserves the
original anim alpha and pixels outside the body. `--unrelated add` (default) also transfers strong non-glow differences
additively; `--unrelated keep` retains those original animation pixels bit for bit, useful for flags and doors.
`--body` accepts any `sprite:frame`: use `--body anim:NAPOWR_A:0 --anim anim:NAPOWR_A --frames 1-18 --unrelated keep`
to transfer a redrawn animation reference from the variant pages to later frames. Add `--body-dmg <sprite:frame> --anim-dmg <sprite>` for the damaged
pair; the same frame range applies. Delta merges existing variant pages and records status `DELTA`; it needs no plan
or model call. Keep all plans, work directories, generated images and variant caches outside Git.

## SHP vehicle redraw sheets (Python)

`python/shp_vehicle_sheets.py` prepares DRON (the Soviet terror drone), an SHP vehicle rather than a voxel.
It imports the unchanged `python/infantry_sheets.py` CPU image pipeline. Python 3 with numpy, Pillow and cv2 is
sufficient; the vehicle CLI never invokes an image model. Supply your own extracted library. `--library` is the
cache root; `--theater` selects `_library/<theater>/library.json` (XMP29U2 uses `urban`). Keep `SHP_WORK` outside Git.

```sh
SHP_SOURCE="$PWD/gameres/hd-cache"
SHP_VARIANT="$PWD/gameres/hd-cache-l3-veh"
SHP_WORK=/private/tmp/dron-redraw
SHP_TOOL=packages/ra2-assets/python/shp_vehicle_sheets.py
python3 -B "$SHP_TOOL" prepare --library "$SHP_SOURCE" --theater urban --units DRON --work "$SHP_WORK"
# Run your image editor manually for each sheets/<name>/prompt.txt and input.png.
# Save output.png alongside input.png, at exactly the same dimensions.
python3 -B "$SHP_TOOL" compose --library "$SHP_SOURCE" --theater urban --work "$SHP_WORK"
python3 -B "$SHP_TOOL" build --library "$SHP_SOURCE" --theater urban --work "$SHP_WORK"
python3 -B "$SHP_TOOL" install --library "$SHP_SOURCE" --theater urban --work "$SHP_WORK" --variant-root "$SHP_VARIANT"
python3 -B -m unittest discover -s packages/ra2-assets/python -p 'test_*sheets.py' -v
```

`prepare` writes `prepare.json` and `sheets/<name>/{input.png,prompt.txt,job.json}`. It refuses to overwrite a
prepared work directory. Each sheet is exactly 1536x1024 or 1024x1536 on RGB (118,118,118), with decoded DarkRed
house paint. It groups all eight clockwise facings of Stand, Walk or Fire, splitting consecutive step ranges only
when required to keep at least 4x the indexed frame size. If one step cannot fit all facings, facing blocks split
as a fallback. Frame offsets remain the per-row anchors. The frame policy mirrors renderer `shpUnitBlocks`:
DRON walks on 0..47, stands on 48..55 and attacks on 56..87; separate shadow cards never enter the sheets.

`compose` uses `output.png` exclusively, even if an older `full.png` exists. It writes per-frame `metrics.json` and
`review.png` (existing HD | redraw). The imported pipeline registers frames, samples in linear light, locks
low-frequency Lab colour, preserves HD alpha with inward trimming, and encodes house-paint shading by value on the
grey remap ramp. `compose` and `build` accept the same colour/trim/paint options as the infantry tool; pass the same
options to both. `--names DRON_Walk,DRON_Fire` selects sheets, and misspelled names fail.

`build` recomposes the selected sheets into `pages/`, discovers all affected HD pages automatically and writes
`report.json`. Missing or wrong-sized outputs fail. A frame below `--min-sil` (default 0.6) keeps its source pixels
in the diagnostic page, fails the build and prevents publication of `build.json`; fix the output before installing.
`install` requires a successful build with unchanged inputs/pages. It detaches only the cache root, `_library` and
selected theater directory when they are links, leaving other entries linked. It copies accepted body rectangles
into the current variant pages, preserving other tracks' edits even on shared pages, then merges only the selected
HD colour/remap filenames into `library.json`. Original cache files, indexed pages, shadow cards, other sprites and
unrelated manifest entries remain intact. Install into a separate variant cache; the source is always read-only.

See the [SHP vehicle review bench](../hd-renderer/README.md#shp-vehicle-review-bench) for deterministic eight-facing
before/after views. Unit tests validate CPU image and installation contracts; they do not establish redraw quality
or browser/GPU rendering acceptance.

## Vehicle projection atlases (Python)

`python/vehicle_projection.py` registers image-model redraw sheets against player-supplied voxel bakes and
packs view-dependent colour/coverage and house-paint atlases. It requires Python 3 with numpy, Pillow and cv2;
it does not download game resources or run an image model. Set `VEHICLE_WORK` to the external working
directory containing `bake/` and `rb/`. All input and generated art, palettes and review sheets must stay outside Git.

```sh
python3 packages/ra2-assets/python/vehicle_projection.py build --type HTNK \
  --bake "$VEHICLE_WORK/bake/HTNK" \
  --sheets "$VEHICLE_WORK/rb/HTNK_body_A" "$VEHICLE_WORK/rb/HTNK_body_B" \
    "$VEHICLE_WORK/rb/HTNK_tur_A" "$VEHICLE_WORK/rb/HTNK_tur_B" \
  --palettes "$VEHICLE_WORK/bake/palettes.json" --house-key unit@BakeA \
  --out "$VEHICLE_WORK/proj/vehicles-hd" --review "$VEHICLE_WORK/proj/review/HTNK"
python3 packages/ra2-assets/python/vehicle_projection.py build-index --out "$VEHICLE_WORK/proj/vehicles-hd"
python3 packages/ra2-assets/python/vehicle_projection.py grade --out "$VEHICLE_WORK/proj/vehicles-hd" \
  --parts HTNK_body HTNK_turret SMCV_body --keep 0.3
python3 -m unittest discover -s packages/ra2-assets/python -p test_vehicle_projection.py -v
```

`grade` is an optional post-build step for parts whose redraw drifted from steel to tan/beige: pixels in the
orange-yellow hue band keep only `--keep` of their chroma at unchanged linear luminance (slightly cool grey), and
house paint and alpha stay untouched. It rewrites the colour atlases in place, so run it once per build.

A type requires a complete, uniformly spaced set of 32 or 16 facings for every part (`all` maps to `body`,
`tur` to `turret`). Missing outputs and partial types fail the build; they never publish a new manifest. Sheets
must share a scale. `output.png` is resized to the input sheet dimensions, input alpha comes from the bake's
black/white pair, and grey-keyed redraw coverage is closed/hole-filled before registration. The bounded
similarity search uses scale 0.94..1.06 and translations within 16 pixels; IoU below 0.85 emits a warning.
Review sheets show the registered redraw, original silhouette outline, and registration parameters.

`<TYPE>.json` version 1 records frame count/step, sheet scale, a two-row atlas-pixel Jacobian, house ramp,
per-part atlas size, sorted frame rects/pivots, and registration results. Pivots pass through the sheet mapping,
registration transform and packing offset. Atlas rects exclude the 12-pixel colour-dilated gutters; coverage
remains the registered redraw alpha. Colour is sRGB; paint channels are linear data: mask, fractional ramp
position (index 16 to 31), and half the residual linear-light luminance ratio. Civilian masks can be empty.
`build-index` indexes completed manifests whose atlases exist. Serve the output directory as `vehicles-hd/`
under the HD cache root; see [renderer controls](../hd-renderer/README.md#projected-vehicle-redraws).

## Sprite material atlas (Python, experimental)

`python/sprite_normals.py` writes the material atlas the renderer's opt-in enhanced look relights sprites with
(`packages/hd-renderer` README, Enhanced look): `sprites@2x-normals.png` with the HD atlas's layout (RG world normal
x/z, B specular class, A occlusion with 0 = no data) and `normals.json`. Buildings are classified into roofs, +z walls
and +x walls from oriented line energies, a foundation-corner prior and a guided filter over the baked shading; trees
get dome normals. With `--assist`, camera-space normal renders from an image model (one per frame, named
`<sprite id, ':' as '_'>#<frame>.png` at the frame's 2x size, standard normal-map colours) replace the classification
where they pass the checks against the original art: best-shift silhouette IoU, the art's baked light (+z walls must be
brighter than +x walls), and the foundation-corner side prior; failures are flagged in `normals.json` and keep the
classification. Glass (specular class 1) is found pane by pane: dark or blue wall pixels that are not warm-coloured
(plus the night-window extractor's panes) form candidate components after closing small holes and growing along smooth
shading; a component is a pane (glass all over, no hollow centre) when it is thin (`PANE_MAX_THICKNESS`), clearly
darker than the frame around it and not among roof pixels, so arcades, shop fronts, rooftop units and stains are not
glass.

```bash
python3 -B packages/ra2-assets/python/sprite_normals.py --cache gameres/hd-cache/XMP29U2 --assist "$WORK/assist" \
  --debug-dir "$WORK/normals-debug"
python3 -m pytest packages/ra2-assets/python/test_sprite_normals.py -q
```

Library mode uses the same classifier for player buildings and their animation layers. `--library` takes the directory
containing `library.json` and is mutually exclusive with `--cache`. Prefixes default to `building:` and `anim:` in
library mode (`building:` and `tree:` for maps); `--sprites` and `--only <sprite-id> <sprite-id>#<frame>` narrow the
selection. Body sprites and normal/damaged animation layers inherit foundations from their building types, falling
back to `[1, 1]` when no building references them. Identical rectangles are processed once per page; empty frames
carry no material data.

```bash
python3 -B packages/ra2-assets/python/sprite_normals.py --library "$HD_CACHE/_library/urban" \
  --pages 0,1,4,10 --out-scale 1 --out-dir "$WORK/materials"
```

Without `--pages`, every HD page with selected nonempty frames is processed. Each output is named
`sprites-<page>@2x-normals.png`; `--out-scale 1` (the default) writes the original indexed page's dimensions, while
`--out-scale 2` retains the classifier's 2x pixels. The area filter averages only texels with material data and leaves
empty regions at RGBA zero. Classification always runs at 2x; higher-resolution colour crops are resized to that
calibration before classification. The filename's `@2x` denotes the classifier convention, not the output dimensions.

`--out-dir` defaults to the library directory; a separate output directory leaves all library inputs untouched.
Its single `normals.json` has `version: 1`, the same `encoding` as map mode, and `pages`, keyed by decimal page index.
Each entry records `file`, `atlas` (HD colour filename), `width`, `height`, `scale` (HD page identity),
`materialWidth`, `materialHeight` (output PNG size) and `frames` (processed unique rectangles). PNGs and JSON are
replaced atomically, publishing each completed page while preserving other pages in an existing sidecar. A partial
`--only` run replaces the selected page's material data, not individual frames within its earlier output. Serve the
result alongside the library to enable it in LiveLibrary; the renderer does not search arbitrary work directories.

## Output (`<out>/<mapId>/`)

- `manifest.json`: grid (exists/height/tile per cell), tile entries with atlas rects and anchors, sprites, objects,
  waypoints, house colours, lighting.
- `terrain.png`: RGBA tile atlas in the theater iso palette; each tile raster is the 60x30 diamond merged with its
  extra graphics (cliff faces, water banks), `anchor` marks the cell's top corner inside it.
- `sprites.png`: SHP frames as palette indices in the red channel (alpha 255 where the index is not 0); shadow frames
  are separate rects.
- `palettes/<key>.png`: 256x1 RGB palettes actually used (`iso`, `unit`, `theater`, custom art `Palette=` names).
- `voxels/<TYPE>.json`: body/turret/barrel VXL sections with HVA frame 0 transforms, for every voxel unit or aircraft
  the map places plus MTNK, HTNK, HARV, CMIN, SMCV and AMCV.

## Type library (`<out>/_library/`)

`hd:library` resolves every id of rulesmd `[BuildingTypes]`, `[VehicleTypes]`, `[InfantryTypes]` and
`[AircraftTypes]`, plus every `[OverlayTypes]` and `[SmudgeTypes]` entry with art, through the same art code as the map extractor
(`src/node/artSource.ts`) and writes, per theater:

- `<theater>/library.json` (`TypeLibrary`): one `LibraryType` per resolved type id (kind, sprite or voxel id,
  foundation, draw offset from the live reader's lepton coordinate, lighting class, remap flag, the atlas pages it
  uses) with building layers (ActiveAnim..Four, IdleAnim, SpecialAnim, SuperAnim, ProductionAnim, war factory door
  anims, their damaged variants, offsets, ZAdjust/YSort/Powered, anim timing), bibs, buildup anims and voxel turrets;
  infantry `Sequence=` tables; SHP vehicle frame layouts; the runtime colour scheme array; ConditionYellow/Red;
  `extractor.warnings` naming every skipped type and why. `overlays` maps ids to sprite ids, body-frame counts,
  palette, Wall/Tiberium flags, draw offsets, flat/lighting rules and remap; `OverlayData` selects the frame directly.
  `smudges` maps ids to sprite ids, body-frame counts and Width/Height footprints. The engine draws smudge body
  frame 0; `SmudgeData` selects a cell within the footprint (`dy * Width + dx`), not an animation frame.
- `<theater>/sprites-<n>.png`: single-channel indexed atlas pages (value = palette index, 0 = transparent), each at
  most 4096x4096. Every body/anim/bib frame is exported with its shadow frame. A sprite's frames are packed together
  (types need one or two pages), so renderers can load pages lazily; `SpriteFrame.page` selects the page.
- `<theater>/palettes/<key>.png` and, with `--preview`, `<theater>/library-preview.png` plus a `.json` index: a
  contact sheet (buildings healthy and damaged over their foundation outline, infantry Ready in 8 facings, voxel and
  SHP units in 8 facings, owner colour DarkRed, type ids in a 3x5 font).
- `common/voxels/<ID>.json`: voxel models (`VoxelModel`, as in the map cache) shared by all theaters; library.json
  refers to them as `../common/voxels/<ID>.json`.

Add or refresh only overlay art in an existing library, without extracting units or rewriting existing atlas pages:

```bash
pnpm hd:library -- --game "$YR_INSTALL" --out "$HD_CACHE/_library" --theater urban --only overlays
```

The existing theater/version must match. This appends `sprites-overlays-<n>.png` pages and replaces the `overlays`
records and their sprite references. Existing TechnoTypes, voxel paths, colour schemes, palettes, sprite frames,
HD page references and the original `extractor` diagnostics are preserved; only missing palettes are written.
New page slots have no HD reference until processed by `hd:sprites`. `overlayExtractor` records this append's
counts and missing-art warnings. Repeated runs append new pages; old pages remain intact for existing references.
The library JSON is replaced only after the new files exist. A failed extraction can leave unreferenced new files
but retains the old JSON. `--only overlays` requires an existing library and does not run `--preview`.

Add or refresh all smudge art in existing theater libraries, including craters and burns absent from a map's initial
placements:

```bash
pnpm hd:library -- --game "$YR_INSTALL" --out "$HD_CACHE/_library" --only smudges
```

This selects all six theaters; use `--theater urban` (or a comma-separated list) when only those libraries exist.
It appends `sprites-smudges-<n>.png` pages, replaces the `smudges` records and their sprite references, and records
diagnostics in `smudgeExtractor`. It applies the same preservation, validation and publication rules as the overlay
append, including retaining existing overlay records and pages. Neither append performs the full library extraction
or its preview. New full extractions include both sections; older libraries may omit them.

Smudges always resolve `<image>.<theater extension>` before `<image>.shp`, regardless of `Theater=yes`, and use
the iso palette without remap, the cell-top draw origin and full terrain lighting. Every native body frame and its
detected shadow frame is kept. Rules Width/Height default to one cell. YR 1.001 `SmudgeTypeClass::Place` writes the
footprint selector at `0x6B60F5`; `DrawIt` divides it by Width at `0x6B562C`/`0x6B5637`, repositions to the footprint
origin and passes body frame 0 at `0x6B56B1`. The live renderer must retain the cell selector separately from the
sprite frame so multi-cell burn marks align correctly.

Ore and gems use the theater palette; walls use the unit palette with the current player's remap. In the pinned
YR 1.001 executable, `DrawOverlay` tests `Wall` at `0x47F96A` and reads the current player's colour scheme at
`0x47F9B2`; the wall-owner field is not the remap source. Other overlays use the iso palette. Shared draw rules keep
ordinary overlays at the cell top corner, rocks at `[0, 15]`, and high bridges at `[0, -60]`.

Colour schemes: YR 1.001 builds its runtime ColorScheme array with two consecutive schemes per rules `[Colors]`
entry in file order, and `HouseClass::ColorSchemeIndex` points at the second one (2k + 1). This was read from the
running game's memory (42 schemes for the 21 stock entries; each pair's remap colours carry exactly the entry's
hue; observed house indices 3, 5, 11, 13, 21, 25; a house drawn blue had 21 = DarkBlue). The same dump shows the
Neutral and Special houses at index 5 (LightGrey) although the map and rules name `Grey`, so renderers should trust
`colorIndex`, not house `Color=`. The remap RGB values use `remapRamp` (the map cache's approximation); measured
against the engine's own ramps, the engine keeps the hue exactly but is less saturated on the bright shades (about
0.77 x the `[Colors]` saturation at index 16, rising to 1.0 by index 28), so remapped colours here look somewhat
more saturated than in game.

Per theater (stock YR 1.001 install): 379-391 of 402 buildings, 78 of 80 vehicles, 64 of 65 infantry and 11 of
12 aircraft resolve; the rest are types with no art in that theater (snow-only civilian buildings, ZZZ dummies,
`DeathDummy`, `YDUM`, `WEEDGUY`, `APACHE`).

## Material sidecars (`hd:materials`)

New files only; map manifests and `library.json` are never rewritten.

- `<library>/common/voxels-vpl.png` + `voxels-vpl.json` (`src/vpl.ts`): the engine's voxel lighting table
  (`voxels.vpl`: 32 rows remapping each palette index for a lighting level) as a 256x32 greyscale image, and the
  engine's rule for picking a row per voxel normal, recorded for reference (YR 1.001 @0x7586F0:
  `section = int(16 * (max(0, N.L) + max(0, b / (3 - 2b))))`, `b = N.H`, `H = normalize(L + up)`, light in HD world
  axes; see `src/node/materials.ts`). Re-running the command rewrites only this pair.
- `<cache>/<map>/<terrain file>-cm.png` + `materials.json` (`src/mapMaterials.ts`), with `--terrain`: the manifest's
  HD terrain image with its low-frequency colour (CIE Lab, Gaussian of `--sigma` original pixels) taken from the
  original composite `terrain-map.png`, keeping the HD image's own detail (`src/node/terrainColour.ts`). AI upscaling
  and re-materialisation drift colours by up to about 10 % in luma and 0.05 in saturation per material; the matched
  image is within 1 % at that scale. The renderer prefers it when `materials.json` names it.

Version 1 map sidecars also accept `waterMask` (a replacement for `manifest.terrainMap.waterMask`, same size/layout,
8-bit greyscale, 255 = open water) and `waterBed: true` when `terrainMap` paints shore sand and deeper silt under
that mask. Include the old painted shallow band in the replacement mask. Together with the `enhanced` water style,
the bed flag enables refracted bed optics, wet sand and swash onto land. Omitted/false `waterBed` and the `classic`
style retain their existing shaders. `colourMatched: false` bypasses the entire sidecar, including these overrides.

Optional `shoreIgnore` names an 8-bit greyscale image with the water mask's size/layout. Values >= 128 mark land
that never forms a shoreline, such as cliff tops and walls beside water in screen space. A field texel must have at
least half its pixels marked and remain land after speck filling; it stays dry and is excluded from water depth.
The renderer loads this image only alongside a water mask. A load failure or size mismatch warns once and uses the
unchanged distance field; omitting the field preserves existing behavior.

Optional `waterDetail` names an RGBA8 PNG covering exactly the terrain composite's area with the same aspect ratio,
at any resolution (typically a quarter of the composite's). RGB stores sRGB apparent open-water colour, using low/mid
frequencies from an image-model repaint of the map's water. Extrapolate water colour across land so filtering never
introduces land colour. Alpha stores surface roughness / sun-glitter weight (0..1, byte 128 neutral), such as wind
patches and current streaks. The renderer loads it without a vertical flip, with linear/mipmap filtering and clamped
edges; only `enhanced` water with `waterBed: true` samples it. Missing or unreadable detail warns and falls back to the
constant water column; omitting the field preserves the original shading. Detail colour bypasses the constant
column's display compensation, then shares its night dimming.

Optional `waterSurface` names a seamless RGBA8 painted water surface tile with linear data channels: R = relief
luminance ratio / 2 (0.5 neutral), G = crest glints, B = foam lace, A = unused. It repeats in screen-aligned ground
space; one tile spans `waterSurfaceScale` screen units of 30 engine px on each axis (positive number, default 13).
The renderer uses `NoColorSpace`, repeat wrapping on both axes, linear/mipmap filtering and anisotropy 8. Only
enhanced lake-bed water (`waterBed: true`) with a `waterDetail` layer samples it. An absent tile leaves the existing
shading intact; a missing or unreadable tile warns once and leaves the surface null. Build tiles with
`python/water_surface.py` as described in [Water tools](#water-surface-detail-and-cliff-foot-stripe-tools-python).

## Engine rules the extractor encodes

- MIX priority (highest first): expandmd##, ra2md/ra2, cache, local, language, conquer/generic/isogen, theater mixes.
- Voxel normals: every VXL section names its own normal table (tailer normalsMode 2 = TS, 4 = RA2), and models mix
  them (HTNK, HTK, LTNK, UTNK, XCOMET in YR 1.001). `VoxelSection.normalsMode` records each; older caches carry only
  `VoxelModel.normalsMode` (the last section's), so readers call `sectionNormalsMode` (`src/voxelNormals.ts`), which
  infers the table from the stored normals when the section has none (matches the install on all 129 library
  sections).
- Tiles: engine tile-set walk from `[TileSet0000]`; `0xffff`, out-of-range tiles, empty sub-tiles and cells missing
  from IsoMapPack5 inside the `[Map] Size` rhombus become the `[General] ClearTile` template.
- Palettes: tiles, trees, rocks, low bridges and smudges use `iso<th>.pal`; ore and gems use `<theater>.pal`;
  buildings, infantry, vehicles, voxels, walls and ore mines use `unit<th>.pal` with house remap (indices 16..31).
  Each choice was checked by rendering the art with all candidate palettes.
- Draw points (`MapObject.drawOffset`): overlays, smudges, buildings and tiberium trees put the SHP canvas centre on
  the cell's top corner (measured from ore frames and building foundations); rocks (`IsARock=yes`), other trees,
  vehicles and voxels use the cell centre; infantry their sub-cell spot. High bridges are lifted 4 levels and are not
  flat. Overlay frame = OverlayData.
- Frames: buildings use body frame 1 at or below `[AudioVisual] ConditionYellow` (`50%` in YR, parsed as 0.5), else
  frame 0; SHP facings map as the engine does (facing 0 = map north = frame 7 of 8); building anim layers export only
  the middle frame of their LoopStart..LoopEnd range.
- Lighting (`MapObject.lighting`): `full` (tiles, trees, rocks, overlays, smudges), `ambient` (buildings, units,
  walls) or `none` (ore, gems, ore mines), with the engine's cell formula (`engineCellLight` in `src/lights.ts`) in `mapLightMultipliers`.
- Art names: `Theater=yes` uses the theater extension; every other image whose name starts with G/N/C/Y followed by a
  theater letter (A/T/U/D/L/N) gets the map's letter, then G, then keeps the plain name. The engine does this whatever
  the art `NewTheater=` says: the install ships temperate/urban/desert/lunar files for flags marked `NewTheater=no`,
  and the shipyards have no NewTheater key but only `gg`/`ng`/`yg` files outside snow.
- Type library only: art `Remapable=` applies to infantry and vehicles too (animals are not house-coloured); art
  `TerrainPalette=yes` is recorded but the unit palette is kept (the lamp art is colour noise with the iso palette).

## Effect art sidecar (`<out>/_library/common/effects/`)

`hd:effects` (`src/node/effectsLibrary.ts`, contract `src/effects.ts`) collects the original art of everything a live
match draws besides its units and buildings, so the live renderer can draw the engine's own effects as its base layer:

- every rulesmd `[Animations]` entry plus every anim id a rules or art key creates (weapon `Anim=`, warhead
  `AnimList=`, techno `Explosion=`/`DebrisAnims=`, building `DestroyAnim=`, projectile `Trailer=`, the anim keys of
  `[General]`/`[CombatDamage]`/`[AudioVisual]`, and every `Next=`/`ExpireAnim=`/`TrailerAnim=`/`Spawns=` chain),
  with the timing the engine derives (`frameCount` = art `End=` or the SHP's frame count, halved for `Shadow=yes`;
  `rateFrames` from `Rate=`/`Normalized=`, see `animRateFrames`), translucency, layer, flat and draw-offset flags,
  and the widths of its visible and hot pixels;
- projectiles with art (SHP frames, `Rotates=`, or a voxel model), VoxelAnims debris models, particle art, every
  `[OverlayTypes]` and `[SmudgeTypes]` entry, WalkRate/IdleRate of SHP vehicles and the ore storage buildings.

Output: `effects.json` (`EffectLibrary`), indexed pages `effects-<n>.png` (same format as the type library's; combat
anims first so a battle needs few pages, then one page family per theater variant), `palettes/<key>.png` (`anim`, and
`unit|iso|theater.<theater>`) and `voxels/<ID>.json`. Art that resolves to different files per theater is stored once
per distinct file with `<id>@<theater>` sprite ids. The whole sidecar for six theaters is about 80 MiB; nothing else
writes into this directory.

`--table <file>` writes the HD garnish table (`classifyAnim`): per anim id a category, the garnish kind, its scale
(matched to the art's footprint), one iteration's lifetime in logic frames, loop/scorch flags, the art's smoke share
and a light colour/radius. It also lists the rules facts the live view needs without the bridge: the capturable
building types (`Capturable=yes`), the building types whose art is `Normalized=yes`, the smoke particle systems
(`SMOKE_SYSTEMS`: particle type, SpawnFrames, ParticleCap, SpawnRadius, Velocity, Deacc, StateAIAdvance, EndStateAI
and translucency) and `[AudioVisual]` ExtraUnitLight/ExtraInfantryLight/ExtraAircraftLight. It holds ids and numbers
only.

## Tests

`vitest` unit tests in `tests/` cover tile-slot resolution, clear-tile substitution, projection and anchor math, the
PNG encoder, palette remap, art naming and atlas packing; they need no game files. `tests/library.test.ts` covers
infantry sequence parsing, the colour scheme order, paged atlas packing, theater art-name resolution and type library
records built from a synthetic in-memory install (hand-made SHP files and INI text). `tests/effectsLibrary.test.ts`
does the same for the effect sidecar: anim timing and flags, theater variants, projectiles, overlays, smudges, the
classification and the generated table.
Terrain tests use synthetic caches to cover painter order, alpha, origin, water classification and preview
compatibility. Upscale tests use a tiny local fake executable and synthetic PNGs, so neither models nor a GPU are
required. Sprite-HD tests use synthetic indexed atlases/palettes and fake 4x inference to cover neutral remap,
per-frame batching/cut-back, alpha, shadow exclusion, and map/library reference updates without writing game data.
`tests/lights.test.ts` covers engine number parsing and storage rounding, `[Lighting]` defaults, light types from
synthetic INI text, the exact engine cell formula (centre, falloff, radius, Ground/Level, clamps, negative lights),
the linear light delta, the atmosphere table, surface classes from the probed tile colours, deterministic street lamp
placement and sidecar validation, and the stock night maps' real lighting (all staged as night);
`tests/windows.test.ts` covers window detection on synthetic facades (windows found; hollow pane outlines lit whole;
L-shaped fragments, roofs, edge-touching and isolated specks rejected; glass indices; determinism; the large-pane
fallback and its roof band; lit-pane columns).
Run `pnpm --filter ra2-assets run typecheck` and `pnpm exec vitest run packages/ra2-assets` from the repo root.

For a reproducible CPU/I/O benchmark, run `pnpm exec node --import tsx packages/ra2-assets/tests/benchmarkSpriteHd.mts`.
It generates a 4096x4096 indexed page with 1,800 body and 1,800 shadow frames (64x64 each), spawns the fake 4x binary,
writes both 8192x8192 outputs, and reports page/binary times. All inputs and outputs are synthetic and are removed
from the system temporary directory after the run. This benchmark does not measure real GPU inference.
