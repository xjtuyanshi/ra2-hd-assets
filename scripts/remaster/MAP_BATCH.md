# Local multiplayer map batches

These helpers prepare player-supplied RA2/YR maps with the existing offline asset pipeline. They do not download
resources, run a server, open a browser, or request an image model. Outputs are private game derivatives and must
remain outside Git. The installation is read-only.

```bash
pnpm exec tsx scripts/remaster/inventoryMultiplayerMaps.mts --game "$PLAYER_INSTALL" --out "$BATCH_OUT"
python3 scripts/remaster/prepareMultiplayerMaps.py --root "$PROJECT_ROOT" --out "$BATCH_OUT"
```

Inventory walks local MIX and map packages recursively, reads multiplayer indices and scenario flags, and stages
the original scenario bytes with SHA-256 receipts. Unindexed archive members retain stable CRC-based map ids;
duplicate sources with identical ids/content are recorded once. Campaign maps are excluded unless indexed or
marked as multiplayer; co-op multiplayer scenarios are included. Review inventory errors before claiming coverage.

The batch driver runs `pnpm hd:prepare` with explicit input, cache and installed Real-ESRGAN paths and exactly
`extract,terrain,upscale,sprites`. It requires more than 40 GiB free when starting and stops below 30 GiB during a
batch. Actual `df` receipts are written before each map and every five seconds while a command runs. It maintains
`INVENTORY.json`, `STATUS.json`, per-map logs, `MAPS.md`, and resumable `NOTES.md`. Do not run two drivers against one
output directory or rerun inventory while a driver is active.

On a host where Metal/Vulkan is unavailable, use `--steps extract,terrain --blocked-reason "<observed failure>"`
to finish independent extraction and terrain work. Those maps remain partial and are never counted as full
successes. Run the default four-step command on a supported host to finish them; current outputs are reused by the
existing planner. Directories missing their extraction manifest are re-extracted with `--force`.

No AI `remat` pass, shared theatre-library generation, or installation into a live cache is performed. Install only
fully prepared maps into a deliberately selected isolated cache and retain separately approved libraries/effects;
`packages/ra2-assets/python/play_farm.py build` does that as a symlink farm over a base cache and `verify` checks the
result headlessly (see [the asset guide](../../packages/ra2-assets/README.md#play-farm-a-base-cache-plus-prepared-map-batches)).
File generation, code checks and build results do not establish live visual acceptance; review every theatre,
large textures, water masks, sprite remap, seams, loading and performance in real matches separately.

Pipeline contracts and step freshness are documented in [the asset guide](../../packages/ra2-assets/README.md).
