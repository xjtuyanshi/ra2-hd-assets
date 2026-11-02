#!/bin/bash
# Queued environment upload (Wine, Real-ESRGAN, diffusion models) to release env-build12-20261102.
# Waits for the farm uploader (../work) to finish, then packs one chunk at a time.
# Resumable: rerun this script; verified chunks in work/progress.json are skipped.
E="$(cd "$(dirname "$0")/.." && pwd)"
B="$(cd "$E/.." && pwd)"
R="$(cd "$B/../../.." && pwd)"
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
exec caffeinate -i nice -n 15 python3 -I "$E/tools/pack_env_upload.py" "$R" "$E/env-build12.manifest.json" "$E/work" "$B/work" \
  xjtuyanshi/ra2-hd-assets env-build12-20261102
