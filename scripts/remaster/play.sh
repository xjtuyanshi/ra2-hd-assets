#!/bin/bash
# Start the HD remaster for play: the development server of this checkout plus a browser on the HD page.
#
#   scripts/remaster/play.sh              HD picture, skirmish setup as the first page
#   scripts/remaster/play.sh --original   the original picture with spatial reconstruction (no HD bridge)
#   scripts/remaster/play.sh --menu       start at the game's main menu instead of the skirmish setup
#   scripts/remaster/play.sh --train      practice lessons: the lesson list (docs/remaster/TRAINING.md); builds the
#                                         practice scenarios below <main checkout>/gameres/s2x/play/train on first use
#   scripts/remaster/play.sh --print      only print the address (nothing is started)
#
# --view classic|moderate|wide selects 3|2.5|2 device pixels per game pixel (default wide).
# The page migrates old remembered classic choices to wide once; a newly chosen classic remains remembered.
# HD play asks the player to size the window before Start, then measures that click. Later window changes fill the
# picture immediately and restart at the next main menu. Close the terminal window (or press Ctrl+C) to stop the server.
#
# Environment (all optional):
#   RA2_GAME_ROOT      folder that holds the player's own game in ra2/   (default: <main checkout>/game)
#   RA2_HD_CACHE_DIR   HD asset cache root                               (default: the first of <main checkout>/gameres/
#                      hd-cache-play6, hd-cache-play5, hd-cache-play4, hd-cache-play3, hd-cache-play2, hd-cache-play
#                      that holds _library/, otherwise <main checkout>/gameres/hd-cache)
#   RA2_TRAIN_DIR      folder of the practice scenarios (--train): scratch maps, game roots and a cache root of links to
#                      RA2_HD_CACHE_DIR, built on first use (default: <main checkout>/gameres/s2x/play/train). A build
#                      with its own cache needs its own folder: the links are made once and never repointed.
#   RA2_PLAY_SPEED     game speed the session starts with, original scale 0 fastest .. 6 slowest (default: 3, normal;
#                      "default" keeps the page's own default, which is the fastest)
#   RA2_PLAY_PORT      port of the development server                    (default: 15400)
#   RA2_PLAY_BROWSER   macOS application to open the page with           (default: Google Chrome)
#   RA2_PLAY_OPEN=0    start the server without opening a browser
#   RA2_PERF_LOG       file the HD page's stall recorder appends to, one JSON line per presented frame that came more
#                      than 150 ms late, and the game-speed telemetry one line ("kind":"speed") per five seconds of
#                      a running battle (default: <main checkout>/gameres/s2x/play/perfmon/stalls.jsonl; 0 = no log)
set -u
# A double-clicked play.command may start without the shell profile that puts Node and pnpm on the PATH.
PATH="$PATH:/opt/homebrew/bin:/usr/local/bin"
here="$(cd "$(dirname "$0")/../.." && pwd)"
# Game files and the HD cache are not in Git: a worktree finds them next to the main checkout.
common="$(git -C "$here" rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)"
main="$here"
[ -n "$common" ] && [ -d "$common" ] && main="$(dirname "$common")"

mode=hd
page=skirmish
print=0
view=""
while [ "$#" -gt 0 ]; do
  arg="$1"
  shift
  case "$arg" in
    --original) mode=original ;;
    --menu) page=menu ;;
    --train) page=train ;;
    --print) print=1 ;;
    --view) view="${1:-}"; [ "$#" -gt 0 ] && shift; case "$view" in classic|moderate|wide) ;; *) echo "视野请选择 classic（经典）、moderate（适中）或 wide（宽）。" >&2; exit 2 ;; esac ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

port="${RA2_PLAY_PORT:-15400}"
query=""
[ "$mode" = original ] && query="resolution=display"
[ -n "$view" ] && query="resolution=$view"
# The page's own startup default is the fastest speed; play starts at the normal one (about 20 logic frames a second).
speed="${RA2_PLAY_SPEED:-3}"
case "$speed" in
  [0-6]) query="$query&game-speed=$speed" ;;
  default) ;;
  *) echo "RA2_PLAY_SPEED must be 0..6 or default: $speed" >&2; exit 2 ;;
esac
[ "$page" = skirmish ] && query="$query&start-page=skirmish"
# Practice: the lesson list; the backquote key goes to the game instead of the page's debug panel.
[ "$page" = train ] && query="$query&train=menu&debug-key=0"
if [ "$mode" = hd ]; then
  hd_query="$(node "$here/scripts/remaster/play-options.mjs")" || exit 1
  query="$hd_query&$query"
  [ "$page" != train ] && query="$query&play-start=1"
else
  query="$query&sr=1"
fi
url="http://localhost:$port/?$query"
if [ "$print" = 1 ]; then echo "$url"; exit 0; fi

game="${RA2_GAME_ROOT:-$main/game}"
train="${RA2_TRAIN_DIR:-$main/gameres/s2x/play/train}"
if [ "$page" = train ]; then
  # Scenario game folders (links to the installation + one scratch map each) and a cache root of links.
  install="$game/ra2"
  if [ ! -d "$train/gameroots/ra2" ] || [ ! -d "$train/hd-cache/_library" ]; then
    echo "Preparing the practice scenarios in $train ..."
    python3 "$here/scripts/remaster/training/buildScenarios.py" --out "$train" --install "$install" ${RA2_HD_CACHE_DIR:+--farm "$RA2_HD_CACHE_DIR"} || exit 1
  fi
  game="$train/gameroots"
  RA2_HD_CACHE_DIR="$train/hd-cache"
fi
# The play cache (every prepared map; the newest build first) when one was built, otherwise the default cache of the
# development server.
cache="${RA2_HD_CACHE_DIR:-}"
if [ -z "$cache" ]; then
  cache="$main/gameres/hd-cache"
  for name in hd-cache-play hd-cache-play2 hd-cache-play3 hd-cache-play4 hd-cache-play5 hd-cache-play6; do
    [ -d "$main/gameres/$name/_library" ] && cache="$main/gameres/$name"
  done
fi
if [ ! -d "$game/ra2" ]; then
  echo "No game folder: $game/ra2 (put your own Yuri's Revenge installation there or set RA2_GAME_ROOT)." >&2
  exit 1
fi
if [ "$mode" = hd ] && [ ! -d "$cache/_library" ]; then
  echo "No HD cache: $cache (set RA2_HD_CACHE_DIR to the cache root that holds _library/)." >&2
  exit 1
fi

open_page() {
  if [ "${RA2_PLAY_OPEN:-1}" = 0 ]; then
    echo "Open $url"
  elif [ "$(uname)" = Darwin ]; then
    open -a "${RA2_PLAY_BROWSER:-Google Chrome}" "$url" 2>/dev/null || open "$url"
  elif command -v xdg-open >/dev/null 2>&1; then
    xdg-open "$url"
  else
    echo "Open $url in a WebGPU browser."
  fi
}

if curl -s -o /dev/null "http://localhost:$port/"; then
  echo "A server already answers on port $port: opening the page."
  open_page
  exit 0
fi

cd "$here" || exit 1
if ! command -v node >/dev/null 2>&1 || ! command -v pnpm >/dev/null 2>&1; then
  echo "Node.js and pnpm are needed (see the README's development section)." >&2
  exit 1
fi
if [ ! -x node_modules/.bin/vite ]; then
  echo "Installing dependencies (first start only)..."
  pnpm install --frozen-lockfile || exit 1
fi
# The development server's network relay imports the relay package's built library.
if [ ! -f node_modules/relay-package/dist/lib/server.js ]; then
  pnpm --filter relay-package run build:lib || exit 1
fi
(
  for _ in $(seq 1 120); do
    curl -s -o /dev/null "http://localhost:$port/" && break
    sleep 0.5
  done
  open_page
) &
# Where the page's stall recorder writes (the development server's /__perf/stalls route); outside Git like the cache.
perf="${RA2_PERF_LOG:-$main/gameres/s2x/play/perfmon/stalls.jsonl}"
[ "$perf" = 0 ] && perf=""
echo "Game: $game"
echo "HD cache: $cache"
[ -n "$perf" ] && echo "Stall log: $perf"
echo "Page: $url"
echo "Keep this window open while you play; Ctrl+C stops the server."
RA2_DEV_HTTP=1 RA2_GAME_ROOT="$game" RA2_HD_CACHE_DIR="$cache" RA2_PERF_LOG="$perf" exec node_modules/.bin/vite --port "$port" --strictPort --host localhost
