#!/bin/bash
# Resumable: rerun this script to continue; verified chunks in work/progress.json are skipped.
B="$(cd "$(dirname "$0")/.." && pwd)"
R="$(cd "$B/../../.." && pwd)"
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
exec caffeinate -i nice -n 15 python3 -I "$B/tools/pack_upload.py" "$R/gameres/hd-cache-play12" "$B/manifest.json" "$B/work" xjtuyanshi/ra2-hd-assets farm-build12-20261102
