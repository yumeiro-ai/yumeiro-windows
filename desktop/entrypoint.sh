#!/bin/bash
# 启动顺序：虚拟显示 → 窗口管理器 → VNC（仅供你登录/授权用）→ Cindy 桌面端 → 桥接。
set -u
read_secret() { [ -f "$1" ] && tr -d '\r\n' < "$1"; }
BRIDGE_API_KEY="$(read_secret /run/secrets/desktop_key)"; export BRIDGE_API_KEY
VNC_PASSWORD="$(read_secret /run/secrets/vnc_password)"
[ -n "$BRIDGE_API_KEY" ] || { echo "缺少 /run/secrets/desktop_key" >&2; exit 1; }
[ -n "$VNC_PASSWORD" ] || { echo "缺少 /run/secrets/vnc_password" >&2; exit 1; }

mkdir -p "$HOME/.config" "$HOME/.vnc" "$HOME/bridge"
# 容器重启时 /tmp 里会残留上次的锁文件，导致新的 Xvfb 起不来、x11vnc 连不上，所以先清掉
rm -f /tmp/.X99-lock /tmp/.X11-unix/X99
Xvfb :99 -screen 0 1280x800x24 -nolisten tcp &
for _ in $(seq 1 30); do [ -e /tmp/.X11-unix/X99 ] && break; sleep 0.3; done
openbox >/dev/null 2>&1 &
x11vnc -storepasswd "$VNC_PASSWORD" "$HOME/.vnc/passwd" >/dev/null 2>&1
# VNC 只监听容器内本机；浏览器通过 noVNC(6080) 访问，再由 Yumeiro应用做管理员鉴权后反向代理
x11vnc -display :99 -rfbauth "$HOME/.vnc/passwd" -localhost -forever -shared -rfbport 5900 -noxdamage -quiet &
websockify --web /usr/share/novnc 6080 127.0.0.1:5900 >/dev/null 2>&1 &

# run-app 来自挂载进来的 /opt/desktop（可能是 Windows 换行），去掉回车符放到 /tmp 再用；镜像里自带的旧版本不再依赖
RUNAPP=/usr/local/bin/run-app
if [ -f /opt/desktop/run-app.sh ]; then tr -d '\r' < /opt/desktop/run-app.sh > /tmp/run-app && chmod 755 /tmp/run-app && RUNAPP=/tmp/run-app; fi

# ---- 自动更新 ----
# 官方安装包在镜像构建时装死，容器里又没有 root，Cindy 自己更新不了。所以这里定期查 GitHub 最新发布，
# 把新版 .deb 解压到 ~/cindy-app（数据卷里，重建容器也保留），守护循环下次启动时就用新版；新版连续启动失败会自动回退。
# 关闭：环境变量 CINDY_AUTO_UPDATE=0；查看：docker compose exec desktop bash /tmp/desktop-update.sh status
APP_ROOT="$HOME/cindy-app"; export CINDY_APP_ROOT="$APP_ROOT"
UPDATER=/tmp/desktop-update.sh
if [ -f /opt/desktop/update.sh ]; then tr -d '\r' < /opt/desktop/update.sh > "$UPDATER" && chmod 755 "$UPDATER"; fi
# 更新状态小服务（管理设置 → 桌面端 → 软件更新 用它读版本、点“立即检查更新”）；只在容器内网监听，用 desktop_key 鉴权
if [ -f /opt/desktop/status-server.mjs ]; then CINDY_UPDATER="$UPDATER" node /opt/desktop/status-server.mjs >>"$HOME/status-server.log" 2>&1 & fi
if [ "${CINDY_AUTO_UPDATE:-1}" != 0 ] && [ -x "$UPDATER" ] && [ -f /opt/desktop/pick-release.mjs ]; then
  (
    sleep 120
    while true; do
      OLD_BIN="$(cat "$APP_ROOT/current-bin" 2>/dev/null || command -v cindy 2>/dev/null)"
      "$UPDATER" check; rc=$?
      if [ "$rc" = 10 ]; then
        echo "Cindy 桌面端已更新到 $(cat "$APP_ROOT/current-version" 2>/dev/null)，重启桌面端以使用新版" >&2
        [ -n "$OLD_BIN" ] && { pkill -f "$OLD_BIN" 2>/dev/null; pkill -f "$(readlink -f "$OLD_BIN")" 2>/dev/null; }
      fi
      sleep $(( ${CINDY_UPDATE_INTERVAL_HOURS:-6} * 3600 ))
    done
  ) &
fi

# Cindy 桌面端“守护循环”：程序退出（崩溃、被内存不足杀掉、自己更新后退出、你在桌面里把它关了）都会在 10 秒后自动重新拉起，
# 并且每次启动前都清掉过期的 discovery.json / host.lock —— 容器里进程号很小且每次几乎相同，host.lock 里的 pid 会被误认为
# “另一个 Cindy 实例还活着”，Cindy 就会报 HOST_IN_USE、不启动本机 Agent API。授权文件（grants.json 等）不动。
(
  while true; do
    BIN="${CINDY_BIN:-}"
    [ -n "$BIN" ] || { [ -s "$APP_ROOT/current-bin" ] && [ -x "$(cat "$APP_ROOT/current-bin")" ] && BIN="$(cat "$APP_ROOT/current-bin")"; }
    [ -n "$BIN" ] || BIN="$(command -v cindy 2>/dev/null)"
    [ -n "$BIN" ] || BIN="$(find /opt /usr/lib /usr/share -maxdepth 3 -type f -iname cindy -perm -u+x 2>/dev/null | head -1)"
    if [ -z "$BIN" ]; then echo "找不到 Cindy 可执行文件，请设置 CINDY_BIN；30 秒后重试" >&2; sleep 30; continue; fi
    find "$HOME/.config" \( -path '*local-agent/discovery.json' -o -path '*local-agent/host.lock' \) -delete 2>/dev/null
    [ "$(stat -c %s "$HOME/cindy.log" 2>/dev/null || echo 0)" -gt 5242880 ] && : > "$HOME/cindy.log"
    echo "启动 Cindy 桌面端：$BIN" >&2
    STARTED=$(date +%s)
    # 容器默认 seccomp 不允许 Chromium 自带沙箱，所以用 --no-sandbox；容器本身已 non-root + cap_drop ALL + 无特权。
    dbus-run-session -- "$RUNAPP" "$BIN" --no-sandbox --disable-gpu --password-store=gnome-libsecret >>"$HOME/cindy.log" 2>&1
    CODE=$?
    # 新版本跑不到 30 秒就退出且连续 3 次：自动回退到上一个版本（并记住坏版本，不再重试）
    if [ $(( $(date +%s) - STARTED )) -lt 30 ]; then FAST=$(( ${FAST:-0} + 1 )); else FAST=0; fi
    if [ "$FAST" -ge 3 ] && [ -x "$UPDATER" ] && [ -s "$APP_ROOT/prev-bin" ]; then "$UPDATER" rollback && FAST=0; fi
    echo "Cindy 桌面端已退出（代码 $CODE），10 秒后重新启动" >&2
    sleep 10
  done
) &

# 桥接循环：发现文件出现后才启动桥接；桥接内部连不上时会重新读取发现文件，所以 Cindy 重启换了端口也能自动接上
echo "等待 Cindy 桌面端就绪（登录后才会写出 discovery.json）…" >&2
while true; do
  DISC="$(find "$HOME/.config" -path '*local-agent/discovery.json' 2>/dev/null | head -1)"
  if [ -n "$DISC" ]; then
    node /opt/bridge/yumeiro-bridge.mjs --listen=0.0.0.0 --port=8788 --allow-host="${BRIDGE_ALLOW_HOST:-desktop}" --discovery="$DISC" --token-file="$HOME/bridge/token" --cwd="$HOME/bridge"
    echo "桥接退出，5 秒后重试" >&2
  fi
  sleep 5
done
