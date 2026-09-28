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
```

`--map` accepts `.yro`/`.mmx` packages (MIX archives holding `<stem>.map` and a `.pkt`) and plain `.map/.mpr/.yrm`
INI files, as a path or a file name inside the game directory. `--models` adds a strip with every extracted voxel
model, `--foundations` outlines building foundations, `--unlit` skips the map's `[Lighting]` tint. The preview is
cropped to the playable area (`visibleRect`, the engine's camera limits from `[Map] LocalSize`); `--full` draws the
whole `[Map] Size` area including the border strips the player never sees.

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
