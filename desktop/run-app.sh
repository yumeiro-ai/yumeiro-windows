#!/bin/bash
# 在同一个 D-Bus 会话里先启动并解锁 gnome-keyring，再启动 Cindy 桌面端。
# 桌面端用系统钥匙串加密保存登录信息，容器里没有钥匙串就会提示“登录存储不可用”。
# 钥匙串密码取自 VNC 密码文件；钥匙串文件只存在 desktop_home 卷里。
export XDG_CURRENT_DESKTOP=GNOME
PW="$(tr -d '\r\n' < /run/secrets/vnc_password 2>/dev/null)"
[ -n "$PW" ] || PW="cindy-desktop"
mkdir -p "$HOME/.local/share/keyrings"
eval "$(printf '%s' "$PW" | gnome-keyring-daemon --unlock --components=secrets 2>/dev/null)"
export GNOME_KEYRING_CONTROL SSH_AUTH_SOCK
exec "$@"
