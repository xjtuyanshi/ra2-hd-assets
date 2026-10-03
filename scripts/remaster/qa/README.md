# Offline sprite QA

`asset_qa.py` reads extracted indexed sprite pages, palettes, current JSON contracts and all historical HD sprite colour variants. It writes only to a disjoint output directory. It does not modify assets, launch image jobs, start servers or run matches.

Python dependencies: NumPy and Pillow; pytest is used for the synthetic regressions. Install them in an isolated environment:

```bash
python3 -m venv "$QA_ENV"
"$QA_ENV/bin/python" -m pip install numpy pillow pytest
"$QA_ENV/bin/python" -m pytest tests/python/test_hd_asset_qa.py
"$QA_ENV/bin/python" scripts/remaster/qa/asset_qa.py --cache "$HD_CACHE" --out "$QA_OUT"
```

The output contains `qa.csv` (asset/frame ranges with worst metrics), `QA.md`, native-pixel comparison crops, `scan-summary.json`, an input metadata inventory and resumable per-page receipts. Rerunning the exact command reuses receipts only when the contract, input sizes, modification timestamps and script version match. Remove `page-results/` to force a complete rescan after changing the scanner. Output belongs outside Git alongside other private derived game data.

Silhouette IoU below 0.85, centroid/bbox registration beyond 1.5 native pixels, mean per-pixel CIELAB deltaE76 above 8, remapped house hue drift above 8 degrees, texture variation gain below 1, alpha halos/fringes, missing frames, count mismatches and broken local PNG/JSON or sprite references are flagged. Source shadow rectangles and counts are audited; only body replacements receive HD metric scores. Missing palette/house evidence stays unverified. See the generated report for precise metric definitions and edge thresholds.

Original evidence comes from extracted indexed atlases and their palettes. Historical colour variants use the current indexed atlas layout inferred by filename; old effect layouts without JSON are explicitly unmapped. Auxiliary remap/normal pages are inventoried and PNG-integrity checked, not treated as colour replacements. Input mutation during scanning is reported and requires another sweep.

The report is a triage aid. Texture energy cannot establish new material detail, and numeric scores do not establish runtime animation, occlusion, lighting or visual acceptance. Inspect comparison crops at 100% and verify the affected assets in a real match separately.

Comparison crops retain the neutral faction ramp; faction hue is scored separately across available house palettes. Effect crops show coverage colour; zero-coverage emission and the final additive blend require runtime review. Faint tails may fail the alpha-0.5 silhouette gate without being reported as missing frames.
