# CPU performance and equivalence checks

These asset-free benchmarks compare the renderer with the 4695ab2 checkout baseline, using synthetic inputs and the
existing Node/TypeScript toolchain. They do not establish same-scene GPU/FPS performance or visual acceptance.
The baseline already had typed shroud grids, per-model voxel caching, logic-frame beams, failed effect-page caching,
R8 eager atlas uploads and no live-view camera shake. The measurements below are incremental improvements over that code.

Run from the repository root:

```bash
pnpm exec vitest run packages/hd-renderer/tests packages/ra2-assets tests/basic/hd*.test.ts
pnpm exec node --import tsx packages/hd-renderer/benchmarks/effectBuffers.mts
pnpm exec node --import tsx packages/hd-renderer/benchmarks/voxelGeometry.mts
pnpm exec node --import tsx packages/hd-renderer/benchmarks/shroud.mts
pnpm exec node --import tsx packages/hd-renderer/benchmarks/rendererState.ts
pnpm --filter hd-renderer run typecheck
pnpm run check
```

The package's tests use the root Vitest runner. Root `test:unit` currently selects other package directories explicitly,
so the explicit hd-renderer test command above is also required. No new test runner or npm dependency is needed.

## CPU measurements

Recorded on Node v26.0.0, macOS arm64. Each script warms both implementations and reports medians, with details in its
source. Absolute timings depend on the host and load; run on the same host for comparisons.

| Synthetic workload                       |   Baseline |  Optimized | Scope                                                                                |
| ---------------------------------------- | ---------: | ---------: | ------------------------------------------------------------------------------------ |
| 16 Tesla bolts, 12 cells each            | 0.09858 ms | 0.02886 ms | Identical 2,304 visible segments, new seed each update                               |
| 64 Tesla bolts, 100 cells each           |  3.5804 ms | 0.05225 ms | Generates only the same first 4,096 drawable segments instead of constructing 76,800 |
| 1,024 effect cards on 4 pages, unchanged | 0.08584 ms | 0.03410 ms | Includes grouping, ordering and float32 dirty comparison                             |
| Solid 24-cube voxel model                |   2.388 ms |   0.573 ms | Uncached geometry, 25 alternating runs                                               |
| Perforated 24-cube voxel model           |   7.989 ms |   2.253 ms | Uncached geometry, 25 alternating runs                                               |
| 160 x 160 shroud, one cell changes       | 0.04201 ms | 0.01860 ms | Existing typed-grid baseline versus changed-corner bounding rectangle                |
| 2 million flat irradiance queries        |  26.979 ms |  19.060 ms | Color allocations eliminated                                                         |

Effect-card uploads fall from 61,440 bytes per unchanged call to zero; changing one coordinate schedules four bytes.
Sprite and effect attributes compare the stored float32 value, preserving pending ranges until three.js uploads them.
Empty counts and unchanged values do not schedule uploads. LiveView additionally skips object/card reconstruction
between logic snapshots unless interpolation, environment-dependent masks or asynchronous art actually change.

Shroud updates reuse the applied cell copy (25,600 fewer allocated bytes per changed 160 x 160 update), flags and corner
field. Sparse changes recompute only the containing corner rectangle; unchanged snapshots only compare cells.
Moving the reader box or changing its dimensions reconstructs the padded grid to preserve missing-cell semantics.

The eager indexed-atlas path remains a single bitmap-to-R8 upload with no main-thread repack. A 4096 x 4000 R8 page has
16,384,000 texel bytes, versus 65,536,000 for RGBA8, excluding backend overhead. Hosts without eager upload read at most
262,144 RGBA pixels per strip and yield between strips, rather than allocate a full-page RGBA copy. Both paths release
the decoded bitmap; fallback R8 bytes are released in the texture upload callback. GPU upload correctness still needs
backend acceptance on the target hardware.

## Equivalence boundaries

- Voxel tests compare positions, normals, palette indices, AO, indices and bounds against the frozen baseline builder,
  covering every 2 x 2 x 2 occupancy pattern, transforms, normal tables and large meshes. Geometry caches distinguish
  model and shape settings; renderer contexts snapshot their own shape settings before asynchronous world loading.
- Beam tests compare the exact drawable prefix against the original generator, including jitter, strand colour and
  truncation, and verify repeated 144 Hz presentation cannot rebuild logic-frame beams. Excess light candidates retain
  the same bounded light-pool tail.
- Card tests cover ordering, translucency, dirty spans, float32 equality, loading/failure/retry and asynchronous revision
  invalidation. Shroud tests compare sparse updates and shifted reader boxes to complete reconstruction.
- Renderer tests cover independent texture/uniform/material contexts, disposal, compatibility-layer copying and dynamic
  light record reuse. Standard world loading creates independent contexts automatically. Legacy custom worlds must
  pass explicit contexts to isolate their custom materials; their old context-less API remains supported.
- No real-game assets, golden screenshots, hardware GPU measurements or full-match FPS are included. The live no-shake
  behavior is regression-tested; the sandbox's explicit boom continues to shake.
