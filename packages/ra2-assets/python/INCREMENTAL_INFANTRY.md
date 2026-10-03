# Incremental infantry publication

`infantry_incremental.py` reuses `infantry_sheets.py` for foreground batches. It
does not generate images, schedule workers or change existing composer defaults.
Keep all inputs, snapshots, review images and caches outside Git.

Select previously uninstalled sheet names whose existing worker has exited
successfully. `snapshot` requires `done.txt` to be newer than the output and the
latest `started.txt`, copies the input/output files, records their hashes and
checks that the worker did not change them during the copy.

Run these commands from this directory, with paths supplied through task-specific
environment variables. Every snapshot, candidate and publication directory must
be new.

```sh
python3 infantry_incremental.py snapshot --work "$SHEET_WORK" \
  --out "$BATCH/snapshot" --names "$SHEETS"
python3 infantry_incremental.py compose --source "$SOURCE_LIBRARY" \
  --snapshot "$BATCH/snapshot" --out "$BATCH/candidates" \
  --min-sil 0.6 --min-body 0.85 --silhouette-reference indexed --edges "$EDGE_OVERRIDES"
```

`SOURCE_LIBRARY` is an immutable original-derived theatre library. Compose each
distinct source palette separately; transfer to other theatres only when their
original indexed frames and every used opaque palette entry match. Edge overrides
are an optional JSON mapping, for example `{"infantry:CIV3": [0.4, 0.8]}`. They
change only the named sprite's original-remap finishing, never the global policy.
A `sprite#frame` key takes precedence over its sprite key, allowing an isolated
pose to receive a reviewed correction without widening neighbouring frames.

The default silhouette reference remains `legacy`. Explicit `indexed` selection
measures the unfilled model foreground against the rendered original indexed body
over a three-original-pixel margin. Both measurements remain in the record; a
missing or mismatched indexed method, a nonfinite value, or foreground touching
the margin boundary is retained for review. It never falls back to the legacy
metric, and publication repeats the selected gate at the same threshold. Final
body IoU remains a separate check and cannot override a failed raw-model gate.

Optional `--paint-values` accepts a JSON mapping with the same keys to
`[gamma, outside_floor]` pairs. It reuses the existing paint-value finish after
remap and shadow finishing, before recording final metrics, hashes and review
images. The default is empty. Use it only to preserve a documented local colour
treatment; the finish retains alpha, remap extent and unpainted RGB. For example,
an established Yuri treatment can be supplied as `[0.35, 15]` for its selected
sprite or frame keys rather than applied globally.

Optional `--source-remap` accepts comma-separated sprite or `sprite#frame` keys.
Before remap finishing, only model-painted texels outside nearest original remap
support are corrected: the worker house decodes their material luminance, while
original non-remap body colours supply hue and chroma. Transparent and shadow
references inherit the nearest valid non-remap body colour; a frame without such
a reference fails. Alpha, valid model paint and all other pixels are unchanged
by this correction. The default is empty. Review decoded crops for multiple
houses before using this targeted repair, including colour fringes and retained
material detail. Standard finishing runs for both the baseline and corrected
candidate, then only the allowed colour/mask texels are overlaid onto the baseline.
This final scope guard prevents convolution or shadow calculations from changing
normal paint, neighbouring colour or any alpha outside the requested correction.

Inspect `review.png` and `candidates.json` before publishing. The record separates
model registration IoU, final body IoU, alpha differences and remap-mask area.
Review the same-frame remap ratio against the 80–120% static proxy; investigate
outliers by adjusting a targeted finish in a new candidate directory or
quarantining the affected frames. Static mask measurements do not replace the
rendered faction-colour gate. `--exclude-frames` can retain reviewed problem
frames; it cannot override model/body acceptance thresholds.

```sh
python3 infantry_incremental.py publish --source "$SOURCE_LIBRARY" \
  --staged "$BATCH/candidates" --farm "$CACHE_FARM" --theater "$THEATER" \
  --out "$BATCH/published-$THEATER" --suffix "$BATCH_SUFFIX" --reserve-gib 4
```

Publication reads the current farm, changes only accepted rectangles and keeps
all other pixels and page metadata. It uses `cache_farm` for writes, a shared
`.compose.lock` across the library/material sidecars, and compare-and-swap checks
inside each JSON lock. New filenames are checked and installed under that lock;
an existing served PNG is never replaced. Normals are rebound only when already
bound to the current colour page and all RGBA pixels under nonzero material alpha
remain byte-identical. A stale binding or changed support requires investigation.

`installed.json` journals prepared, published, normal-bound and verified states,
including old/new references, unchanged-pixel hashes and estimated/actual disk
bytes. If a batch fails, inspect that journal and the current manifests before
retrying with a fresh publication directory and suffix. Retain snapshots and
staging files: installed PNGs may be hard links to them. Do not rewrite or delete
them to reclaim space. Larger batches reduce full-page versions; publication
retains the requested disk reserve beyond its conservative size estimate.

Track completed sheets and unique accepted frame keys outside the repository.
Rejected or quarantined frames remain on their previous farm pixels and require
separate repair provenance. Browser animation, silhouette, contact, faction
colour and occlusion checks remain separate acceptance work.
