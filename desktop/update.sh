#!/bin/bash
# Cindy 桌面端自动更新（容器内，非 root）。
#   update.sh check      查 GitHub 最新发布；有新版就下载、校验、解到 ~/cindy-app/v<版本>，并切换到新版（退出码 10 = 已更新，需要重启桌面端）
#   update.sh status     显示当前使用的版本和路径
#   update.sh switch <global|cn> [latest|x.y.z]   选择 Cindy 版本：区域（国际版 / 国内版）和版本号都可选；latest = 最新版并继续自动更新，
#                                                x.y.z = 固定在这个版本（不再自动更新，也可以用来回退到旧版本）。直接下载安装并重启，不用重建镜像
#   update.sh rollback   回到上一个版本（新版连续启动失败时由入口脚本自动调用）
# 为什么不用 dpkg：容器里没有 root 权限（cap_drop ALL + no-new-privileges），所以把 .deb 直接解压到用户目录。
# 每次检查的结果写到 ~/cindy-app/status.json，管理设置 → 桌面端 的“软件更新”页面读的就是它。
set -u
ROOT="${CINDY_APP_ROOT:-$HOME/cindy-app}"
ROOT_FLAVOR="$(cat "$ROOT/flavor" 2>/dev/null)"
FLAVOR="${ROOT_FLAVOR:-${CINDY_FLAVOR:-global}}"   # global = 国际版 | cn = 国内版；在页面里选过的（~/cindy-app/flavor）优先于环境变量；账号区域不同，不能混用
ARCH="${CINDY_ARCH:-x64}"
API="${CINDY_RELEASES_API:-https://api.github.com/repos/makecindy/cindy/releases/latest}"
PREFIX="${CINDY_DOWNLOAD_PREFIX:-}"           # 国内访问 GitHub 慢时可填加速前缀，例如 https://ghfast.top/
PICK="${CINDY_PICK_RELEASE:-/opt/desktop/pick-release.mjs}"
LOG="$HOME/cindy-update.log"
log() { printf '%s %s\n' "$(date '+%F %T')" "$*" | tee -a "$LOG" >&2; [ "$(stat -c %s "$LOG" 2>/dev/null || echo 0)" -gt 1048576 ] && tail -n 200 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"; }

# 把一次检查的结果写成 JSON：write_status key=value ...
write_status() {
  node -e 'const fs=require("fs");const o=Object.fromEntries(process.argv.slice(2).map(a=>{const i=a.indexOf("=");return [a.slice(0,i),a.slice(i+1)]}));o.checkedAt=new Date().toISOString();fs.writeFileSync(process.argv[1],JSON.stringify(o))' "$ROOT/status.json" "$@" 2>/dev/null
}
installed_version() {
  if [ -s "$ROOT/current-version" ]; then cat "$ROOT/current-version"; return; fi
  dpkg-query -W -f='${Package} ${Version}\n' 2>/dev/null | awk 'tolower($1)=="cindy"{print $2; exit}'
}
find_bin() { find "$1" -maxdepth 5 -type f -iname cindy -perm -u+x 2>/dev/null | head -1; }
# 重启桌面端：杀掉旧程序，入口脚本的守护循环 10 秒内会用新版重新拉起
restart_app() {
  [ "${CINDY_RESTART_ON_UPDATE:-0}" = 1 ] || return 0
  for old in "$@"; do [ -n "$old" ] && { pkill -f "$old" 2>/dev/null; pkill -f "$(readlink -f "$old" 2>/dev/null)" 2>/dev/null; }; done
  return 0
}

cmd="${1:-check}"
mkdir -p "$ROOT"
case "$cmd" in
switch)
  want="${2:-}"; ver="${3:-latest}"
  case "$want" in global|cn) ;; *) echo "用法：update.sh switch global|cn [latest|x.y.z]" >&2; exit 2 ;; esac
  if [ "$ver" != latest ] && ! [[ "$ver" =~ ^[0-9]+[.][0-9]+[.][0-9]+$ ]]; then echo "版本号格式不对：$ver（应为 latest 或 0.1.136 这样的数字）" >&2; exit 2; fi
  echo "$want" > "$ROOT/flavor"; rm -f "$ROOT/skip-version"
  if [ "$ver" = latest ]; then rm -f "$ROOT/pin"; else echo "$ver" > "$ROOT/pin"; fi
  log "选择了 $([ "$want" = global ] && echo 国际版 || echo 国内版) $([ "$ver" = latest ] && echo 最新版 || echo "$ver（固定版本）")，开始下载安装"
  CINDY_FORCE=1 CINDY_TARGET_VERSION="$ver" exec bash "$0" check
  ;;

status)
  echo "当前版本：$(installed_version || echo 未知)（区域版本：$FLAVOR）"
  echo "程序路径：$(cat "$ROOT/current-bin" 2>/dev/null || echo '镜像自带')"
  echo "上一个版本：$(cat "$ROOT/prev-version" 2>/dev/null || echo 无)"
  tail -n 5 "$LOG" 2>/dev/null
  ;;

rollback)
  [ -s "$ROOT/prev-bin" ] && [ -x "$(cat "$ROOT/prev-bin")" ] || { log "没有可回退的旧版本"; exit 1; }
  cp "$ROOT/current-bin" "$ROOT/bad-bin" 2>/dev/null
  cp "$ROOT/prev-bin" "$ROOT/current-bin"; cp "$ROOT/prev-version" "$ROOT/current-version" 2>/dev/null
  log "已回退到 $(cat "$ROOT/current-version" 2>/dev/null)（新版本连续启动失败，已记入 bad-bin，本次不再重试该版本）"
  cat "$ROOT/current-version" > "$ROOT/skip-version" 2>/dev/null
  write_status result=failed installed="$(installed_version)" flavor="$FLAVOR" message="新版本连续启动失败，已自动回退到旧版本"
  ;;

check)
  have="$(installed_version)"; have="${have:-0}"
  st() { write_status installed="$have" flavor="$FLAVOR" pinned="$(cat "$ROOT/pin" 2>/dev/null)" "$@"; }
  fail() { log "$1"; st result=failed message="$1"; exit 1; }
  headers=(-H 'Accept: application/vnd.github+json' -H 'User-Agent: yumeiro-desktop-updater')
  [ -n "${GITHUB_TOKEN:-}" ] && headers+=(-H "Authorization: Bearer $GITHUB_TOKEN")
  tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
  target="${CINDY_TARGET_VERSION:-}"; [ "$target" = latest ] && target=""
  pin="$(cat "$ROOT/pin" 2>/dev/null)"
  if [ -z "$target" ] && [ -n "$pin" ]; then
    log "已固定在版本 $pin，不自动更新"; st result=current latest="" message="已固定在版本 $pin（不自动更新；在页面里选“最新版”可恢复自动更新）"; exit 0
  fi
  api_url="$API"; [ -n "$target" ] && api_url="${API%/latest}/tags/v$target"
  curl -fsSL --retry 2 --max-time 40 "${headers[@]}" "$api_url" -o "$tmp/release.json" || fail "查询最新版本失败（服务器连不上 GitHub 或被限流）；下次再试"
  line="$(node "$PICK" "$have" "$FLAVOR" "$ARCH" < "$tmp/release.json" 2>"$tmp/err")" || fail "没找到可用的安装包：$(cat "$tmp/err")"
  IFS='|' read -r action version url sha name <<< "$line"
  [ "${CINDY_FORCE:-0}" = 1 ] && [ "$action" = current ] && action=update
  if [ "$action" != update ]; then log "已是最新（当前 $have，最新 $version）"; st result=current latest="$version" message="已是最新版本"; exit 0; fi
  if [ "${CINDY_FORCE:-0}" != 1 ] && [ "$(cat "$ROOT/skip-version" 2>/dev/null)" = "$version" ]; then log "$version 之前启动失败过，已跳过"; st result=current latest="$version" message="$version 之前启动失败过，已跳过"; exit 0; fi
  if [ -z "$sha" ] && [ "${CINDY_ALLOW_UNVERIFIED:-0}" != 1 ]; then fail "最新发布没有给出 SHA-256，出于安全不自动安装（可设 CINDY_ALLOW_UNVERIFIED=1 放行）"; fi
  log "发现新版本 $version（当前 $have），开始下载 $name"
  st result=downloading latest="$version" message="正在下载 $version"
  curl -fL --retry 3 --retry-delay 5 --max-time 1800 -o "$tmp/cindy.deb" "$PREFIX$url" || fail "下载失败（可以设置 CINDY_DOWNLOAD_PREFIX 使用加速前缀）"
  if [ -n "$sha" ] && ! echo "$sha  $tmp/cindy.deb" | sha256sum -c - >/dev/null 2>&1; then fail "SHA-256 校验不通过，已丢弃下载的文件"; fi
  dest="$ROOT/v$version"; rm -rf "$dest"; mkdir -p "$dest"
  dpkg-deb -x "$tmp/cindy.deb" "$dest" || { rm -rf "$dest"; fail "解压失败"; }
  bin="$(find_bin "$dest")"
  [ -n "$bin" ] || { rm -rf "$dest"; fail "新版本里找不到 Cindy 可执行文件"; }
  missing="$(ldd "$bin" 2>/dev/null | grep 'not found' | head -3)"
  if [ -n "$missing" ]; then rm -rf "$dest"; fail "新版本需要镜像里没有的系统库，没有切换（需要重建镜像：docker compose build --no-cache desktop）：$missing"; fi
  old_bin="$(cat "$ROOT/current-bin" 2>/dev/null || command -v cindy 2>/dev/null)"
  [ -s "$ROOT/current-bin" ] && { cp "$ROOT/current-bin" "$ROOT/prev-bin"; cp "$ROOT/current-version" "$ROOT/prev-version" 2>/dev/null; }
  if [ ! -s "$ROOT/prev-bin" ]; then command -v cindy > "$ROOT/prev-bin" 2>/dev/null; echo "$have" > "$ROOT/prev-version"; fi
  echo "$bin" > "$ROOT/current-bin.new" && mv -f "$ROOT/current-bin.new" "$ROOT/current-bin"
  echo "$version" > "$ROOT/current-version"
  # 只保留当前和上一个版本的目录
  keep_b="$(cat "$ROOT/prev-bin" 2>/dev/null)"
  for d in "$ROOT"/v*; do [ -d "$d" ] || continue; case "$keep_b" in "$d"/*) continue ;; esac; [ "$d" = "$dest" ] || rm -rf "$d"; done
  log "已更新到 $version"
  write_status result=updated installed="$version" latest="$version" flavor="$FLAVOR" message="已更新到 $version，桌面端正在重启"
  restart_app "$old_bin"
  exit 10
  ;;

*) echo "用法：update.sh check | status | rollback" >&2; exit 2 ;;
esac
