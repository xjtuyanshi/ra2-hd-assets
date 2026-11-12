# Water look review

The renderer accepts `hd-water=classic|enhanced|clear|faithful|muted|calm`. Unknown values select classic. Code defaults to
classic; the play launcher still selects enhanced. In the development console, use
`__hdBridge.water.set('clear')` or `__hdBridge.water.cycle()`. Neither moves the camera. Enhanced, faithful, muted
and calm share the same material and mirror graph. Clear uses a third, cheaper shader family with the same existing
mirror/light passes. Each family is built once and parked until view disposal; first-crossing compilation is expected.

No browser acceptance is implied by the asset-free tests. Legacy coefficients are regression tested, but exact GPU
pixel equivalence, small-water boundaries, cliff seams and look quality require the operator's same-camera review.
A small disconnected water component (at most eight cell diamonds, excluding mask boundaries) is protected on new
looks; this geometric heuristic also protects small ponds. The classifier works at four mask pixels per sample.
Inspect pools at 1:1, including lane markings. Bed maps recover painted water from the original tile atlas rather
than treating the sand composite as water. Terrain artwork is never rewritten by these scripts.

Clear is a candidate, not the default. Append `&hd-water=clear` to the launcher's printed URL (or replace its existing
`hd-water=enhanced` parameter); keep all resource/cache parameters. No INI flag is added. Its depth proxy reaches deep
water at about 2.4 cells, with steep rocky shores; per-theatre absorption over a theatre sand bed (refracted bed art
where the cache has one) gives turquoise shallows that deepen to dark teal-blue. The surface uses four equal samples of one procedurally generated 256-square FFT normal tile, with the
three.js WaterMesh scales and scroll rates, a 26 m primary tile (3.25 cells), roughly 0.36-cell dominant waves and a
0.8-speed clock. It uses normal-based sun relief, a capped sky/object reflection with a Fresnel sky tint toward the
top of the screen, sharp glints following the scene sun, faint small compression-mask whitecaps, a thin noise-broken foam line on beaches
that breathes over seven seconds, faint caustics about half a cell to a cell and a half from a beach, and at cliffs a
darker foot, a feathered cliff mirror that fades within about 0.4 cells and a broken line of white water. Water beside paved
cells or pale, unsaturated shoreline art (quays, seawalls) keeps its deep colour up to the wall with a dark wet line.
Shadows on open water are softened and capped at about x0.8 brightness. Painted pools remain protected. The
scene-wide cinematic grade is unchanged. Bridge and wall mirror silhouettes use a five-tap premultiplied feather
on clear only; legacy looks retain their existing sampling. Cliff contact contrast, night L* and the new surface
metrics require fresh rendered measurement; coefficient changes alone do not establish acceptance.

## Prepare one session

Use the checkout with the changes and the player's existing resource/cache configuration. Use pnpm's version from
package.json. Install Python NumPy/Pillow in a separate environment if not already available. ffmpeg/ffprobe and a
Chinese-capable TrueType/OpenType font are required. No resources or captures belong in Git.

```bash
RA2_PLAY_OPEN=0 scripts/remaster/play.sh --view moderate
```

The command prints this checkout's play URL. Open that URL in a dedicated Chrome instance with remote debugging
on a loopback port (`--remote-debugging-port=9222`, using a dedicated `--user-data-dir`). Use the existing launcher
URL, including resource/cache parameters. A browser that was already running without remote debugging cannot be
attached afterwards. Keep devicePixelRatio=1, browser zoom 100%, and game zoom 2.5 (moderate). Do not rescale captures.
Keep at most three VM sessions open; this tool attaches to one existing page and starts none.

Copy `water_manifest.example.json` outside Git and edit it. `pageUrl` must equal the complete current URL of exactly
one tab. `out` is an absolute private output directory. Each scene needs an existing native save or replay identifier
in `state`, a browser-viewport crop in CSS pixels (`crop`), the matching device-pixel rectangle in the ffmpeg screen
input (`screenCrop`), and a shoreline rectangle relative to that crop (`shoreCrop`). Browser chrome/window offsets
make the two crop origins different. Preview the ffmpeg input and confirm the rectangles align before a full run.
Every crop has x/y/width/height. `waterMask` and `coreMask` are owner-reviewed monochrome PNGs of the captured size;
core must exclude units and lie at least four game pixels inside water. For the city-lake pool, also supply a same-size `poolMask`; the analyzer compares painted Lab hue against original with an eight-degree limit. Reuse diagnosis masks only if their camera,
viewport, zoom and dimensions exactly match. Do not infer a mask from a new look's blue pixels.

`videoInput` contains ffmpeg input arguments only; for example on macOS `-f avfoundation -framerate 30 -i 1:none`
(select the correct display from `ffmpeg -f avfoundation -list_devices true -i ''`). Screen Recording permission is
required. On Linux an X11 capture can use `-f x11grab -framerate 30 -i :0.0`. The input must deliver real 30fps;
the analyzer rejects clips other than 120 frames at 30fps and never synthesizes missing frames.

```bash
pnpm exec node scripts/remaster/qa/water_boards.mjs "$WATER_MANIFEST" --validate
pnpm exec node scripts/remaster/qa/water_boards.mjs "$WATER_MANIFEST"
"$QA_ENV/bin/python" scripts/remaster/qa/water_analyze.py "$WATER_MANIFEST" \
  --measure "$LOOK_RESEARCH/water_diag/wmeasure.py" --font "$CJK_FONT"
```

The interactive capture script requests a native restore of the **same** state, the same frozen camera, and a paused
scene before every look. It switches original/HD through the same bridge toggle as backslash and writes the visible
PNG after presentation settles. Before each recording it requests normal game speed and a fixed camera. Restore and
resume are operator actions, not guest-memory writes. The receipt records these as operator declarations, not proof
of frame-exact replay alignment. For strict motion comparisons, use a deterministic replay with an identical playback
start marker and trim all masters to that marker before analysis; retain the untrimmed masters and timing evidence.
Do not accept differently progressed saves as same-frame evidence. A 120-frame clip alone cannot prove alignment.

Scenes are Golden Gate (`g2`), Alcatraz (`alca`), island (`isle`), beach (`beach`), bay city (`bay`), city lake/pool
(`gold`), Pacific cliff (`pac2`), open-sea fleet (`fleet`), and night naval (`night`). Unreachable scenes get an explicit
`missing` reason. The template marks all scenes missing until actual saves/camera rectangles/masks are supplied.
The script does not invent map IDs or save coordinates from historical film tags.

## Fleet performance

Use the existing `RA2_PERF_LOG` telemetry. For enhanced, clear and muted separately, restore the same busy naval
save, set **native slider 5** through the game UI, allow shader warm-up, and collect at least 60 seconds while running.
Do not use presentation/rAF FPS. Save `<out>/fleet/<look>-fps.json` with this schema (values below are illustrative,
not measurements):

```json
{
  "state": "same-save-sha256-and-camera-id",
  "slider": 5,
  "durationSeconds": 60,
  "samples": [{ "logicFps": 60, "intervalMs": 60000 }]
}
```

Prefer extracting the existing speed records with the bounded-window helper:

```bash
"$QA_ENV/bin/python" scripts/remaster/qa/water_fps.py --log "$RA2_PERF_LOG" \
  --start "$START_ISO" --end "$END_ISO" --state "$SAVE_CAMERA_ID" \
  --out "$WATER_OUT/fleet/enhanced-fps.json"
```

Repeat for clear and muted with their own restored runs and time bounds. Select a window longer than 60 seconds
so at least 60 seconds of complete five-second records fit inside it. The helper requires native game-counter
records, target FPS 60, HD shown, and continuous windows; it rejects host fallback and gaps.

For alternative telemetry, populate samples with native `logicFps` and measured `intervalMs`, retaining source telemetry, exact save identity,
look and start/end times. The analyzer reports time-weighted FPS and target 60; absent evidence stays UNVERIFIED.
Do not copy the illustrative values. Normal-speed four-second clips and slider-5 performance runs are separate.

## Outputs and limits

`capture.json` records missing scenes and failures. Board order is original | current enhanced | clear | muted. Each scene has four PNGs and FFV1 MKVs, `board.png` (Chinese row
labels beside unscaled pixels), `shore-2x.png` (nearest neighbour), `comparison.mkv`, `comparison-1080p.mp4`, and
individual `<look>-1080p.mp4`. H.264 uses libx264, 4 Mb/s, maxrate 4 Mb/s and bufsize 8 Mb; no sharpening.
The four-way 1080p preview is for display review. Numeric H.264 scores use each look's separate 1080p encode so the
water is not measured at one-quarter preview resolution. Letterbox masks track the encode's scale and offset.

`metrics.json` and `SUMMARY.md` report luminance, saturation, contrast, highlights, spatial spectrum, motion at 1/6s
and 1s, shore steps and per-gate PASS/FAIL/UNVERIFIED. They call functions loaded from the supplied `wmeasure.py` by
path, without executing its historical-case CLI or copying it. The spectral field retains that script's definition:
`wavelength_gpx` is inverse spectral centroid, not a newly implemented spectral-peak estimate. Missing spectrum or
shore samples are UNVERIFIED. Pool markings (and hue when no pool mask is supplied), original alignment, the g2 artwork seam, the owner's display and a
full match require visual review. No capture script changes or denoises private terrain artwork.

The analyzer exits nonzero for missing/error evidence or a FAIL/UNVERIFIED numeric gate. Written boards and measured
rows remain available for review even when acceptance is incomplete.

Clear's numeric gates use the owner's modern-water brief: core HSV saturation <= 0.55, one-second mean absolute
L* change <= 1.5, anisotropy <= 0.35 and highlight share <= 2%. They do not require matching the original mean L*.
Other existing calmness and coastline gates remain. These are capture gates, not guarantees from parameter values.
Enhanced is retained as a comparison baseline and may fail the calmness gates. Board labels are Chinese, at native
pixel size; comparison video is side by side. Each look and the comparison produce four-second FFV1 lossless masters
and 4 Mb/s H.264 previews during capture plus analysis. Actual images/clips require the operator's browser and saves;
none are generated from synthetic or substituted game footage.
