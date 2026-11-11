#!/bin/bash
# Build 12 native HD entry, portable copy for restoring on another Mac (see RESTORE.md).
# Every location is configurable; defaults assume the layout in RESTORE.md under $RA2HD_HOME.
#   RA2HD_HOME    base folder (default: the folder containing this script)
#   BUILD12_CODE  code checkout with node_modules and packages/native-host/build/{ddraw.dll,ra2launch.exe}
#   BUILD12_FARM  restored HD farm (folder containing _library/)
#   RA2HD_GAME    the owner's own Yuri's Revenge folder (contains gamemd.exe)
#   RA2HD_WINE    free Wine executable (Wine Stable 11.0 .../Contents/Resources/wine/bin/wine)
#   BUILD12_PREFIX dedicated Wine prefix (created on first launch)

HOME_DIR="${RA2HD_HOME:-$(cd "$(dirname "$0")" && pwd)}"
BUILD12_CODE="${BUILD12_CODE:-$HOME_DIR/code}"
BUILD12_FARM="${BUILD12_FARM:-$HOME_DIR/farm/hd-cache-play12}"
WT="$BUILD12_CODE"
FARM="$BUILD12_FARM"
GAME="${RA2HD_GAME:-$HOME_DIR/game/YURI}"
WINE_DEFAULT="$HOME_DIR/wine/Wine Stable.app/Contents/Resources/wine/bin/wine"
PREFIX="${BUILD12_PREFIX:-$HOME_DIR/wine-prefix}"
SLOTS="$HOME_DIR/run/_slots"
PAUSE="$SLOTS/PAUSE"
LOCK="$HOME_DIR/run/session.pid"
VIEW="${RA2_PLAY12_VIEW:-}"
SIZE="${RA2_PLAY12_SIZE:-auto}"
WAIT="${RA2_PLAY12_WAIT:-600}"
CHECK=0
MARKS=()
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

stop_here() {
  echo
  echo "$1"
  if [ "$CHECK" -eq 0 ] && [ -t 0 ]; then read -r -p "按回车键关闭此窗口…" _; fi
  exit 1
}

for arg in "$@"; do
  case "$arg" in
    --hd-marks) MARKS=(--hd-marks) ;;
    --check) CHECK=1 ;;
    --help|-h)
      echo '用法：原生高清-第12版.command [--hd-marks] [--check]'
      echo '默认免费 Wine、沿用上次选择的视野（首次为适中）、自动匹配画面，实验高清血条与编队数字关闭。'
      echo '视野可在游戏页面工具栏切换（在主菜单约 20 秒生效）；RA2_PLAY12_VIEW=classic|moderate|wide 可在启动时指定。'
      echo '--check 只检查本地路径，不启动 Wine、游戏或浏览器。'
      exit 0 ;;
    *) stop_here "未知参数：$arg" ;;
  esac
done
VIEW_ARGS=()
case "$VIEW" in
  '') ;;
  classic|moderate|wide) VIEW_ARGS=(--view "$VIEW") ;;
  *) stop_here 'RA2_PLAY12_VIEW 只能是 classic、moderate 或 wide（不设置则沿用上次的选择）。' ;;
esac
[[ "$WAIT" =~ ^[0-9]+$ ]] || stop_here 'RA2_PLAY12_WAIT 必须是等待秒数。'
if [ "$SIZE" = auto ]; then
  SIZE_ARGS=()
elif [[ "$SIZE" =~ ^[0-9]{3,4}x[0-9]{3,4}$ ]]; then
  SIZE_ARGS=(--size "$SIZE")
else
  stop_here 'RA2_PLAY12_SIZE 必须是 auto 或宽x高，例如 1280x720。'
fi

[ -n "$WT" ] || stop_here '第 12 版代码位置尚未填写（BUILD12_CODE）。'
[ -n "$FARM" ] || stop_here '第 12 版高清缓存位置尚未填写（BUILD12_FARM）。'
[ -x "$WT/scripts/remaster/native/play-native.sh" ] || stop_here "找不到第 12 版代码：$WT"
[ -x "$WT/node_modules/.bin/vite" ] || stop_here '第 12 版的本地依赖缺失。'
[ -f "$WT/node_modules/vite/bin/vite.js" ] || stop_here '第 12 版 Vite 入口缺失。'
command -v node >/dev/null 2>&1 || stop_here '找不到本机 Node，请检查已有开发环境。'
command -v pnpm >/dev/null 2>&1 || stop_here '找不到本机 pnpm，请检查已有开发环境。'
[ -f "$GAME/gamemd.exe" ] || stop_here "找不到现有机主游戏副本：$GAME"
[ -d "$FARM/_library" ] || stop_here "找不到第 12 版高清缓存：$FARM"
WINE="${RA2HD_WINE:-$WINE_DEFAULT}"
[[ "$WINE" = /* ]] && [ -x "$WINE" ] || stop_here "免费 Wine 路径无效：$WINE（可用 RA2HD_WINE 指定）"

if [ "$CHECK" -eq 1 ]; then
  echo "代码：$WT"
  echo "游戏：$GAME"
  echo "高清缓存：$FARM"
  echo "已有免费 Wine：$WINE"
  echo "独立 Wine 环境：$PREFIX"
  echo "视野：${VIEW:-沿用上次的选择（首次为适中）}；画面：${SIZE}；实验标记：${MARKS[*]:-关闭}"
fi
[ -f "$WT/packages/native-host/build/ddraw.dll" ] && [ -f "$WT/packages/native-host/build/ra2launch.exe" ] ||
  stop_here '第 12 版原生组件尚未构建，等待最终 DLL 和启动助手准备完成。'
if [ "$CHECK" -eq 1 ]; then
  echo '路径检查通过；未启动任何进程，真实游戏验收仍需单独完成。'
  exit 0
fi

# Use the existing free Wine binary explicitly. Prefix creation and registration belong to the production
# launcher's existing ownership checks.
unset RA2_NATIVE_WINE RA2_NATIVE_WINE_BOTTLE RA2_NATIVE_WINE_PREFIX WINEPREFIX CX_BOTTLE_PATH
unset RA2_NATIVE_AGENT_PORT RA2_NATIVE_AGENT_TOKEN RA2_NATIVE_AGENT_ORIGIN RA2_NATIVE_AGENT_HIDDEN RA2_NATIVE_AGENT_DESKTOP
unset RA2_NATIVE_PORT_FIRST
export RA2_NATIVE_WINE="$WINE" RA2_NATIVE_WINE_PREFIX="$PREFIX"
export RA2_NATIVE_GAME_DIR="$GAME" RA2_HD_CACHE_DIR="$FARM" RA2_HD_CURSOR_DIR=0
cd "$WT" || stop_here "无法进入第 12 版代码目录：$WT"

# Coordinate with the unchanged Build 10/11 entries because all use the owner's game copy.
if [ -f "$LOCK" ] && kill -0 "$(cat "$LOCK")" 2>/dev/null; then
  stop_here '机主原生游戏已在另一个窗口运行，请先在那个窗口按 Ctrl-C。'
fi
mkdir -p "$SLOTS" "$(dirname "$LOCK")"
PAUSE_TEXT="owner playing native build 12 (pid $$)"
OWNS_PAUSE=0
if (set -o noclobber; printf '%s\n' "$PAUSE_TEXT" > "$PAUSE") 2>/dev/null; then OWNS_PAUSE=1; fi
printf '%s\n' "$$" > "$LOCK"
KEEPER=''
if [ "$OWNS_PAUSE" -eq 1 ]; then
  (
    while kill -0 $$ 2>/dev/null; do
      if [ ! -e "$PAUSE" ]; then
        (set -o noclobber; printf '%s\n' "$PAUSE_TEXT" > "$PAUSE") 2>/dev/null || true
      fi
      sleep 5
    done
  ) &
  KEEPER=$!
fi
cleanup() {
  if [ -n "$KEEPER" ]; then kill "$KEEPER" 2>/dev/null || true; fi
  if [ "$OWNS_PAUSE" -eq 1 ] && [ "$(cat "$PAUSE" 2>/dev/null)" = "$PAUSE_TEXT" ]; then rm -f "$PAUSE"; fi
  if [ "$(cat "$LOCK" 2>/dev/null)" = "$$" ]; then rm -f "$LOCK"; fi
}
trap cleanup EXIT
trap 'exit 130' INT TERM HUP

waited=0
while lsof -nP -iTCP:15450-15459 -sTCP:LISTEN >/dev/null 2>&1; do
  [ "$waited" -lt "$WAIT" ] || stop_here '原生通道仍在使用，本次未启动。等现有游戏或测试结束后再打开。'
  if [ "$waited" -eq 0 ]; then echo '正在等待现有原生游戏或测试结束，不会停止它们……'; fi
  sleep 5
  waited=$((waited + 5))
done

echo '正在启动第 12 版原生高清。Chrome 中点击「全屏开始」或「按当前窗口开始」。'
echo '退出请在本窗口按 Ctrl-C；只关 Chrome 标签页不会结束游戏。'
[ -d "$PREFIX" ] || echo '首次启动将创建独立 Wine 环境，请保留本窗口。'
trap ':' INT TERM HUP
# --owner keeps Wine/MoltenVK/fixme and tool output in the run folder and the tokened address out of this window.
"$WT/scripts/remaster/native/play-native.sh" --owner --open "${VIEW_ARGS[@]}" "${SIZE_ARGS[@]}" "${MARKS[@]}"
code=$?
trap 'exit 130' INT TERM HUP
if [ "$code" -ne 0 ]; then stop_here "启动器异常结束（退出码 $code），详情见上方「本次记录文件夹」中的记录。"; fi
echo '本次启动器已结束。'
