# ra2-assets

Local "install step" for the HD remaster: reads one map and the art it references from the player's own Yuri's
Revenge install and writes an HD cache that the HD renderer consumes. The contract is `src/manifest.ts`.

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

# Upscale the scale-1 composite with a separately installed Real-ESRGAN ncnn-vulkan executable
pnpm hd:upscale -- --map RiverRam [--cache <dir>] [--scale 2] [--model realesrgan-x4plus] [--tile 256]
pnpm hd:upscale -- --map RiverRam --bin <binary-path> --compare 1200,700,160,100
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
- Art names: `Theater=yes` uses the theater extension, `NewTheater=yes` swaps a theater-letter second character
  (A/T/U/D/L/N) for the map's letter, then G, then keeps the plain name.

## Tests

`vitest` unit tests in `tests/` cover tile-slot resolution, clear-tile substitution, projection and anchor math, the
PNG encoder, palette remap, art naming and atlas packing; they need no game files.
Terrain tests use synthetic caches to cover painter order, alpha, origin, water classification and preview
compatibility. Upscale tests use a tiny local fake executable and synthetic PNGs, so neither models nor a GPU are
required. Run `pnpm --filter ra2-assets run typecheck` and `pnpm exec vitest run packages/ra2-assets` from the repo root.
