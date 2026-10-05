#!/bin/bash
# Double-click this file in Finder to start playing: macOS opens it in Terminal and runs play.sh next to it.
exec "$(cd "$(dirname "$0")" && pwd)/play.sh" "$@"
