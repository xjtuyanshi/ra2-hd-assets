# Live cell overlays and smudges

The development HD bridge reads YR 1.001's cell overlays and smudges, including walls, resources, craters and burn marks.
The game still owns placement, damage, harvesting, regrowth, visibility and simulation. Nothing in this path writes
guest memory. It remains inside the existing development-only dynamic import in `src/games/yr/runtimeHooks.ts`.

## Native evidence and contract

`src/games/yr/overlayReader.ts` documents the pinned executable hash, header fact sources and instruction addresses.
`CellClass::OverlayTypeIndex` is a signed integer at `+0x44`; `OverlayData` is a byte at `+0x11E`.
`OverlayTypeClass::Array` is at `0xA83D80` (items `+4`, capacity `+8`, count `+0x10`); each type ID starts at `+0x24`.
Placement, wall connection updates, ore reduction/growth and native drawing independently corroborate these fields.
The complete frame byte includes wall damage bits: it is not just a four-neighbour mask.
The vanilla wall drawing branch selects the **current player's** colour scheme, rather than the cell's wall owner.

`src/games/yr/smudgeReader.ts` records the corresponding smudge evidence against the same pinned image:
`SmudgeTypeIndex` is i32 at `Cell+0x48`, `SmudgeData` is u8 at `Cell+0x11F`, and `SmudgeTypes` is at `0xA8EC18`
(items `+4`, capacity `+8`, count `+0x10`; ID at `+0x24`, type vtable `0x7F3528`). The constructor initializes these
fields at `0x47BC24` / `0x47BD22`; placement writes them at `0x6B60EA` / `0x6B60F5`; removal clears them at
`0x543573` / `0x54357D`. Only `-1` denotes no smudge, unlike the overlay pack's additional sentinels.

**SmudgeData is a footprint selector, not an animation frame.** Placement stores `dy * Width + dx`; drawing divides
it by Width at `0x6B562C` / `0x6B5637` to recover the origin and draws SHP body frame 0 at `0x6B56B1`. LiveView
reconstructs that origin from the library's Width/Height and deduplicates the same type/origin/elevation. Native draw
uses the tactical redraw rectangle, not a per-cell diamond mask: a multi-cell smudge remains a complete sprite while
any of its footprint cells still refers to it. Invalid selectors are omitted and reported.

Each native copy uses its drawing cell's LightConvert: `0x4804D1` supplies that cell's MapCoords, and `0x6B566F`
looks it up before loading `+0x34` at `0x6B56AD`. The deduplicated live instance samples map lighting at the texel
centre of the bottommost surviving footprint cell (maximum x+y), preserving its original origin/geometry. This also
keeps a 1x1 mark from blending light from neighbouring cells at the origin corner. Shadows share the sample point.
This models a full redraw's final copy. A single persistent HD instance cannot reproduce native dirty-rectangle or
scroll-strip history, where only some copies are repainted; equal-row partial footprints and native per-copy clipping
remain an approximation. Night lighting retains the renderer's existing per-pixel light model.

Each independent game-neutral publication (`overlays`, `smudges`) contains bounds, a row-major `Int16Array` of type indices (`-1` for empty), a
`Uint8Array` of native data, a type-ID table, and a revision. The reader checks table ranges, cell coordinates and concrete
vtables, dereferences only existing cells, and compares every output value during the scan. Invalid cells/types are
omitted and counted; invalid global tables return null. Callers must discard scratch reuse after a null result.

The bridge polls every 250 ms, resets on scenario/map change or logic-frame rewind, and copies only changes into
immutable publications. Revisions increase across battles for the reader's lifetime. Worker replies retain unchanged
cell publications without cloning the grid on every moving-unit snapshot. LiveView uses the library's original
SHP frames, offsets, palettes and remap policy and rebuilds cell instances only when their inputs change. A live
empty grid removes all static objects of that layer; null enables its static fallback. Smudges use the theater's iso
palette with full terrain lighting and no house remap, below overlays and objects; the existing shroud masks them.
A library without `smudges` triggers one section warning and falls back to known map-cache art for selector 0;
nonzero selectors without footprint metadata and absent art are omitted with per-type warnings. The grid remains
authoritative even with an old library, so removed map-start smudges do not linger. Diagnostics expose
`overlaysFromEngine` and `smudgesFromEngine` separately; `cellsFromEngine` means at least one live cell path is active.
Terrain elevation still comes from the map cache; dynamic terrain deformation is outside this contract. Footprint
dimensions come from the theater library rules; custom-map Width/Height overrides require matching metadata.

### Rubble of destroyed buildings

Rules `[RUBBLE_OVERLAY]` has `Image=SROCK01` and `IsRubble=yes`, but YR 1.001 never draws an IsRubble overlay's own
image (CellClass overlay draw 0x47F6A0; rubble branches 0x47F641 shadow / 0x47FAD1 body test OverlayTypeClass
+0x2B4). It reads CellClass +0x40, the source BuildingTypeClass (vtable 0x7E4570): null draws nothing, otherwise
BuildingTypeClass::GetRubble (0x45F160 / 0x45F1D0) uses that building's own SHP body frame 3 (shadow frame
frameCount/2 + 3) when the SHP has more than three body frames, drawn with the cell's light convert (+0x34, ISO
palette) at the overlay draw point. The destruction path (0x441F60) puts overlay 0xEF on every foundation cell, clears
+0x40 there and stores the building type only on the location (top-left) cell. The overlay reader therefore publishes
`rubble: [{ slot, type }]` for those carrier cells only; libraries mark IsRubble overlays `rubble: true` without a
sprite (never `srock01`), and LiveView draws the carrier building's frame 3 and shadow with the overlay's ISO palette,
lighting and flat flag. HD art for those frames lives on a dedicated `sprites-rubble-l5f` page per theatre
(`packages/ra2-assets/python/rubble_pages.py`); older libraries that still list a RUBBLE_OVERLAY sprite are ignored
once a carrier names the overlay type.

### Theatre coverage

The contract is the same for all six theatre libraries; only the art differs. A library without an `overlays`
section keeps the static map-cache fallback, so its ore never depletes and its walls never change in HD. Snow, desert,
new-urban and lunar libraries get the section through the scratch extraction and farm installation route linked below,
with the ore/gem page and, where the theatre has HD building pages, the wall redirection in the same transaction.
Theatres without HD building pages (snow and lunar in current caches) keep 1x wall art. Rubble frames come from the
per-theatre rubble page, so snow rubble keeps its snow. Verify each theatre in a live match: harvested cells must
disappear at the same moments as in the native view, and spreading ore must appear in HD as it does natively.

## Upgrade existing caches

For a shared symlink farm, follow the [scratch extraction and overlay installation route](../../packages/ra2-assets/README.md#install-overlay-art-into-a-cache-farm), then reapply ore/gem and wall redirections in that order.

Use the player's own complete installation. Derived atlases and screenshots must stay outside Git. From the repository
root, with `YR_INSTALL` set to that installation and `HD_CACHE` to the existing map-cache root:

```bash
pnpm hd:library -- --game "$YR_INSTALL" --out "$HD_CACHE/_library" --theater urban --only overlays
```

Add the smudge section to existing caches independently:

```bash
pnpm hd:library -- --game "$YR_INSTALL" --out "$HD_CACHE/_library" --only smudges
```

This processes all six theater libraries. Add `--theater urban` (or another theater ID) when only a subset exists.
The smudges-only mode includes all rules `SmudgeTypes`, including types absent from the map, uses their theater
extension with SHP fallback, and records Width/Height. It preserves existing overlays, types, palettes, HD references
and atlas files, appending new atlas pages. A missing library must first be built with the ordinary `hd:library`
command. No map-cache regeneration is needed.

For the overlay command above, repeat for each theater used, or omit `--theater urban` to process all six existing theater libraries. `--only overlays`
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
Worker forwarding with independently unchanged grids, atlas append preservation, exact overlay frames and smudge footprint selection. The synthetic polling benchmark is
`scripts/benchmarks/benchmarkYrOverlays.mts`; it does not establish full-match FPS.

```bash
pnpm exec node --import tsx scripts/benchmarks/benchmarkYrOverlays.mts
pnpm exec node --import tsx scripts/benchmarks/benchmarkYrSmudges.mts
```

The smudge benchmark scans 262,144 bounded slots (786,432 output bytes), comparing 200 unchanged polls with
200 changes. A synthetic Node 26.0.0 run measured median/p95 of 0.805/0.919 ms with 16,384 allocated cells and
6.988/8.014 ms with all 262,144 allocated; changed polls were 0.808/0.948 ms and 6.878/7.610 ms. These are reader-only
measurements, excluding Worker copies, rendering and the existing overlay scan; they do not establish match FPS.

In a real match, retain screenshots or a recording outside Git and check:

1. Build disconnected walls/fences, then join them into corners, straights and junctions. Damage and destroy pieces.
   Compare the native view with `__hdBridge.toggle()`; connections and damage must follow the engine within a poll.
2. Harvest ore and gems to exhaustion, observe regrowth, and confirm removed cells have no static duplicate underneath.
3. Compare wall remap colours with the native view, including an enemy wall, and compare ore/gem theater palettes.
4. Reveal and re-shroud overlay cells; neither walls nor bright resources may shine through black shroud. Check elevated
   terrain, overlaps with trees/buildings, scrolling and the native selection/placement graphics.
5. Trigger shell craters and scorch marks, destroy buildings that leave multi-cell burn marks, then place buildings
   over them or otherwise let the engine remove/replace them. Compare native and HD at the same moment, including
   types absent from the map-start cache, frame 0, footprint origin, elevation, lighting, shroud and overlay overlap.
6. Restart the same map and switch maps; no overlays from the previous match may remain. Check Worker and main-thread
   operation. Legacy caches without the overlay section must still use the static fallback; without smudge metadata they must
   warn once, retain known map art where interpretable, and still honor live removals.

Unit tests, a successful build and a synthetic benchmark are separate evidence from these real-match checks.

Live-match visual comparison and real installation/cache extraction are **UNVERIFIED** by the synthetic tests.
