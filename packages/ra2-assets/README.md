# ra2-assets

Local "install step" for the HD remaster: reads one map and the art it references from the player's own Yuri's
Revenge install and writes an HD cache that the HD renderer consumes. The contract is `src/manifest.ts`. For live
matches it also writes a per-theater type library with art for every building, vehicle, infantry and aircraft type;
that contract is `src/library.ts`.

Everything the extractor writes is derived from EA game data. It goes to the gitignored `gameres/` directory and must
never be committed or redistributed.

## Commands

```bash
# Extract (defaults: --game <repo>/game/ra2, --out <repo>/gameres/hd-cache; --map may repeat)
pnpm hd:extract -- --map RiverRam.yro --map IsleLand.yro
pnpm --filter ra2-assets extract -- --game <install dir> --map <file> [--out <dir>] [--voxels MTNK,HTNK]

# Composite <out>/<mapId>/ into preview.png the way the original engine draws the map
pnpm hd:preview -- --map RiverRam --map IsleLand [--cache <dir>] [--models] [--foundations] [--unlit] [--full]

# Composite only unlit terrain, with transparency and an open-water mask (map may repeat)
pnpm hd:terrain-map -- --map RiverRam [--cache <dir>]

# Type library for live matches (defaults: all six theaters, --out <repo>/gameres/hd-cache/_library)
pnpm hd:library -- [--game <install dir>] [--theater temperate --theater snow ...] [--out <dir>] [--preview]

# Upscale the scale-1 composite with a separately installed Real-ESRGAN ncnn-vulkan executable
pnpm hd:upscale -- --map RiverRam [--cache <dir>] [--scale 2] [--model realesrgan-x4plus] [--tile 256]
pnpm hd:upscale -- --map RiverRam --bin <binary-path> --compare 1200,700,160,100

# Build offline 2x sprite colours and house-remap masks from an existing indexed atlas
pnpm hd:sprites -- --map RiverRam [--cache <dir>] [--bin <binary-path>] [--model realesrgan-x4plus]
pnpm hd:sprites -- --library temperate --pages 0 [--cache <dir>] [--bin <binary-path>]
```

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
`[AircraftTypes]` through the same art code as the map extractor (`src/node/artSource.ts`) and writes, per theater:

- `<theater>/library.json` (`TypeLibrary`): one `LibraryType` per resolved type id (kind, sprite or voxel id,
  foundation, draw offset from the live reader's lepton coordinate, lighting class, remap flag, the atlas pages it
  uses) with building layers (ActiveAnim..Four, IdleAnim, SpecialAnim, SuperAnim, ProductionAnim, war factory door
  anims, their damaged variants, offsets, ZAdjust/YSort/Powered, anim timing), bibs, buildup anims and voxel turrets;
  infantry `Sequence=` tables; SHP vehicle frame layouts; the runtime colour scheme array; ConditionYellow/Red;
  `extractor.warnings` naming every skipped type and why.
- `<theater>/sprites-<n>.png`: single-channel indexed atlas pages (value = palette index, 0 = transparent), each at
  most 4096x4096. Every body/anim/bib frame is exported with its shadow frame. A sprite's frames are packed together
  (types need one or two pages), so renderers can load pages lazily; `SpriteFrame.page` selects the page.
- `<theater>/palettes/<key>.png` and, with `--preview`, `<theater>/library-preview.png` plus a `.json` index: a
  contact sheet (buildings healthy and damaged over their foundation outline, infantry Ready in 8 facings, voxel and
  SHP units in 8 facings, owner colour DarkRed, type ids in a 3x5 font).
- `common/voxels/<ID>.json`: voxel models (`VoxelModel`, as in the map cache) shared by all theaters; library.json
  refers to them as `../common/voxels/<ID>.json`.

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

## Engine rules the extractor encodes

- MIX priority (highest first): expandmd##, ra2md/ra2, cache, local, language, conquer/generic/isogen, theater mixes.
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
  walls) or `none` (ore, gems, ore mines), with the reference engine's formula in `mapLightMultipliers`.
- Art names: `Theater=yes` uses the theater extension; every other image whose name starts with G/N/C/Y followed by a
  theater letter (A/T/U/D/L/N) gets the map's letter, then G, then keeps the plain name. The engine does this whatever
  the art `NewTheater=` says: the install ships temperate/urban/desert/lunar files for flags marked `NewTheater=no`,
  and the shipyards have no NewTheater key but only `gg`/`ng`/`yg` files outside snow.
- Type library only: art `Remapable=` applies to infantry and vehicles too (animals are not house-coloured); art
  `TerrainPalette=yes` is recorded but the unit palette is kept (the lamp art is colour noise with the iso palette).

## Tests

`vitest` unit tests in `tests/` cover tile-slot resolution, clear-tile substitution, projection and anchor math, the
PNG encoder, palette remap, art naming and atlas packing; they need no game files. `tests/library.test.ts` covers
infantry sequence parsing, the colour scheme order, paged atlas packing, theater art-name resolution and type library
records built from a synthetic in-memory install (hand-made SHP files and INI text).
Terrain tests use synthetic caches to cover painter order, alpha, origin, water classification and preview
compatibility. Upscale tests use a tiny local fake executable and synthetic PNGs, so neither models nor a GPU are
required. Sprite-HD tests use synthetic indexed atlases/palettes and fake 4x inference to cover neutral remap,
per-frame batching/cut-back, alpha, shadow exclusion, and map/library reference updates without writing game data.
Run `pnpm --filter ra2-assets run typecheck` and `pnpm exec vitest run packages/ra2-assets` from the repo root.

For a reproducible CPU/I/O benchmark, run `pnpm exec node --import tsx packages/ra2-assets/tests/benchmarkSpriteHd.mts`.
It generates a 4096x4096 indexed page with 1,800 body and 1,800 shadow frames (64x64 each), spawns the fake 4x binary,
writes both 8192x8192 outputs, and reports page/binary times. All inputs and outputs are synthetic and are removed
from the system temporary directory after the run. This benchmark does not measure real GPU inference.
