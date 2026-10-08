#!/usr/bin/env bash
set -euo pipefail
PACKAGE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$PACKAGE_DIR/build/go-cache"
cd "$PACKAGE_DIR/launcher"
export GOOS=windows GOARCH=386 CGO_ENABLED=0
export GOCACHE="$PACKAGE_DIR/build/go-cache" GOPROXY=off GOSUMDB=off GOTOOLCHAIN=local
"${NATIVE_HOST_GO:-go}" build -trimpath -ldflags '-s -w -H windowsgui -buildid=' -o "$PACKAGE_DIR/build/ra2launch.exe" .
printf 'Built %s\n' "$PACKAGE_DIR/build/ra2launch.exe"
