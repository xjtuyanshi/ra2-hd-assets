#!/usr/bin/env bash
set -euo pipefail

# Build from source without running the upstream Makefile (which mutates inc/git.h).
# Serial compilation keeps this helper gentle on machines running another match.
PACKAGE_DIR="$(cd "$(dirname "$0")" && pwd)"
VENDOR_DIR="$PACKAGE_DIR/third_party/cnc-ddraw"
BUILD_DIR="$PACKAGE_DIR/build"
CC="${NATIVE_HOST_CC:-i686-w64-mingw32-gcc}"
WINDRES="${NATIVE_HOST_WINDRES:-i686-w64-mingw32-windres}"
export LC_ALL=C SOURCE_DATE_EPOCH=0
mkdir -p "$BUILD_DIR/inc" "$BUILD_DIR/obj"
cat > "$BUILD_DIR/inc/git.h" <<'HEADER'
#define GIT_COMMIT "279a057-native-host"
#define GIT_BRANCH "native-host"
HEADER
cp "$VENDOR_DIR/res.rc" "$BUILD_DIR/res.rc"

CFLAGS=(-O2 -Wall -Werror -std=c99 -D_WIN32_WINNT=0x0601 -I"$VENDOR_DIR/inc" -I"$BUILD_DIR/inc" -I"$PACKAGE_DIR/agent"
  "-ffile-prefix-map=$PACKAGE_DIR=." -fno-ident)
# Isolation builds retain the normal defaults unless explicitly disabled.
for feature in AGENT LOGIC_HOOK HIDDEN INPUT PICTURE WEBSOCKET; do
  variable="NATIVE_HOST_$feature"
  value="${!variable:-1}"
  if [[ "$value" != 0 && "$value" != 1 ]]; then
    printf '%s must be 0 or 1\n' "$variable" >&2
    exit 1
  fi
  CFLAGS+=("-DNH_ENABLE_$feature=$value")
done
sources=("$VENDOR_DIR"/src/*.c "$VENDOR_DIR"/src/*/*.c)
if [[ "${NATIVE_HOST_AGENT:-1}" == 1 ]]; then
  sources+=("$PACKAGE_DIR"/agent/*.c "$PACKAGE_DIR/../../src/games/yr/nativeDrawJournal.c")
fi
objects=()
for source in "${sources[@]}"; do
  relative="${source#"$PACKAGE_DIR/"}"
  if [[ "$relative" == ../* ]]; then relative="game/yr/$(basename "$source")"; fi
  object="$BUILD_DIR/obj/${relative%.c}.o"
  mkdir -p "$(dirname "$object")"
  "$CC" "${CFLAGS[@]}" -c "$source" -o "$object"
  objects+=("$object")
done
"$WINDRES" -J rc -I "$BUILD_DIR" -I "$VENDOR_DIR" "$BUILD_DIR/res.rc" "$BUILD_DIR/obj/resource.o"
objects+=("$BUILD_DIR/obj/resource.o")
"$CC" -Wl,--enable-stdcall-fixup,--no-insert-timestamp -s -static -shared \
  -o "$BUILD_DIR/ddraw.dll" "${objects[@]}" "$VENDOR_DIR/exports.def" \
  -lgdi32 -lwinmm -lole32 -lmsimg32 -lavifil32 -luuid -lws2_32 -ladvapi32
printf 'Built %s\n' "$BUILD_DIR/ddraw.dll"
