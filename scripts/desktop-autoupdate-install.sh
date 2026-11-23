#!/usr/bin/env bash
# 安装“每天凌晨自动检查并更新桌面端”的定时任务（systemd timer）。卸载：./scripts/desktop-autoupdate-install.sh remove
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "请用 root 运行"; exit 1; }
cd "$(dirname "$0")/.."; DIR="$(pwd)"
if [ "${1:-}" = remove ]; then
  systemctl disable --now yumeiro-desktop-update.timer 2>/dev/null || true
  rm -f /etc/systemd/system/yumeiro-desktop-update.{service,timer}; systemctl daemon-reload; echo "已移除自动更新"; exit 0
fi
cat > /etc/systemd/system/yumeiro-desktop-update.service <<UNIT
[Unit]
Description=Update Cindy desktop container to the latest stable release
[Service]
Type=oneshot
WorkingDirectory=$DIR
ExecStart=/bin/bash -c '$DIR/scripts/desktop-update.sh --auto >> /var/log/yumeiro-desktop-update.log 2>&1'
UNIT
cat > /etc/systemd/system/yumeiro-desktop-update.timer <<UNIT
[Unit]
Description=Daily Cindy desktop update check
[Timer]
OnCalendar=*-*-* 04:30:00
RandomizedDelaySec=900
Persistent=true
[Install]
WantedBy=timers.target
UNIT
systemctl daemon-reload; systemctl enable --now yumeiro-desktop-update.timer
echo "已开启：每天 04:30（±15 分钟）自动检查更新，日志在 /var/log/yumeiro-desktop-update.log"
echo "手动检查：./scripts/desktop-update.sh --check    关闭：./scripts/desktop-autoupdate-install.sh remove"
