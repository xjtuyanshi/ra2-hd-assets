# Live cell overlays

The development HD bridge reads YR 1.001's cell overlays instead of retaining the map's initial walls and resources.
The game still owns placement, damage, harvesting, regrowth, visibility and simulation. Nothing in this path writes
guest memory. It remains inside the existing development-only dynamic import in `src/games/yr/runtimeHooks.ts`.

## Native evidence and contract

`src/games/yr/overlayReader.ts` documents the pinned executable hash, header fact sources and instruction addresses.
`CellClass::OverlayTypeIndex` is a signed integer at `+0x44`; `OverlayData` is a byte at `+0x11E`.
`OverlayTypeClass::Array` is at `0xA83D80` (items `+4`, capacity `+8`, count `+0x10`); each type ID starts at `+0x24`.
Placement, wall connection updates, ore reduction/growth and native drawing independently corroborate these fields.
The complete frame byte includes wall damage bits: it is not just a four-neighbour mask.
The vanilla wall drawing branch selects the **current player's** colour scheme, rather than the cell's wall owner.

The game-neutral publication contains bounds, a row-major `Int16Array` of type indices (`-1` for no overlay), a
`Uint8Array` of frames, a type-ID table, and a revision. The reader checks table ranges, cell coordinates and concrete
vtables, dereferences only existing cells, and compares every output value during the scan. Invalid cells/types are
omitted and counted; invalid global tables return null. Callers must discard scratch reuse after a null result.

The bridge polls every 250 ms, resets on scenario/map change or logic-frame rewind, and copies only changes into
immutable publications. Revisions increase across battles for the reader's lifetime. Worker replies retain unchanged
overlay publications without cloning the grid on every moving-unit snapshot. LiveView uses the library's original
SHP frames, offsets, palettes and remap policy and rebuilds overlay instances only when their inputs change. A live
empty grid removes all static overlays; null enables the static fallback. Smudges retain their existing map behavior.
Terrain elevation still comes from the map cache; dynamic terrain deformation is outside this contract.

## Upgrade existing caches

Use the player's own complete installation. Derived atlases and screenshots must stay outside Git. From the repository
root, with `YR_INSTALL` set to that installation and `HD_CACHE` to the existing map-cache root:

```bash
pnpm hd:library -- --game "$YR_INSTALL" --out "$HD_CACHE/_library" --theater urban --only overlays
```

Repeat for each theater used, or omit `--theater urban` to process all six existing theater libraries. `--only overlays`
requires an existing `library.json`; a missing theater library must first be extracted with the ordinary `hd:library`
command. The overlay-only mode appends atlas pages and replaces the overlay section, preserving existing type records,
palettes, voxel paths and atlas files. Do not run a full extraction merely to update overlays. Missing art is reported
by the extractor and cannot be counted as successful visual coverage.

Serve that cache through the existing development route and use the server's printed port:

```bash
RA2_HD_CACHE_DIR="$HD_CACHE" pnpm dev
```

Open the game with `?hd=1`. `?hd=1&vm-worker=0` selects the main-thread comparison. Refresh the page after the cache
upgrade so the per-theater library is reloaded. Existing map manifests do not need regeneration.

## Acceptance

Asset-free regressions exercise malformed memory, typed-array reuse/change detection, bridge timing/immutability,
Worker forwarding, atlas append preservation and overlay instance selection. The synthetic polling benchmark is
`scripts/benchmarks/benchmarkYrOverlays.mts`; it does not establish full-match FPS.

```bash
pnpm exec node --import tsx scripts/benchmarks/benchmarkYrOverlays.mts
```

In a real match, retain screenshots or a recording outside Git and check:

1. Build disconnected walls/fences, then join them into corners, straights and junctions. Damage and destroy pieces.
   Compare the native view with `__hdBridge.toggle()`; connections and damage must follow the engine within a poll.
2. Harvest ore and gems to exhaustion, observe regrowth, and confirm removed cells have no static duplicate underneath.
3. Compare wall remap colours with the native view, including an enemy wall, and compare ore/gem theater palettes.
4. Reveal and re-shroud overlay cells; neither walls nor bright resources may shine through black shroud. Check elevated
   terrain, overlaps with trees/buildings, scrolling and the native selection/placement graphics.
5. Restart the same map and switch maps; no overlays from the previous match may remain. Check Worker and main-thread
   operation. Legacy caches without the overlay section must still use the static fallback.

Unit tests, a successful build and a synthetic benchmark are separate evidence from these real-match checks.
