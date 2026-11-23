#!/usr/bin/env bash
# 桌面端一键自检：逐项看哪一环有问题，并给出下一步。用法：./scripts/desktop-check.sh [--fix]
#   --fix  遇到“过期锁文件 / 桥接没起来”这类可以安全自动处理的问题时直接处理（不会动登录数据和授权）
set -uo pipefail
cd "$(dirname "$0")/.."
FIX="${1:-}"
ok() { echo "  ✓ $*"; }; bad() { echo "  ✗ $*"; }; hint() { echo "    → $*"; }
D() { docker compose exec -T desktop sh -c "$1" 2>&1; }
echo "[1] 桌面容器"
STATE="$(docker inspect -f '{{.State.Running}} {{.RestartCount}} {{.State.OOMKilled}}' "$(docker compose ps -q desktop 2>/dev/null)" 2>/dev/null || echo 'false 0 false')"
case "$STATE" in "true "*) ok "运行中（重启次数/内存被杀：${STATE#true }）";; *) bad "容器没在运行"; hint "docker compose up -d desktop；日志：docker compose logs --tail=30 desktop"; exit 1;; esac
echo "[2] 脚本是不是最新（挂载）"
D 'test -f /opt/desktop/entrypoint.sh && echo mounted' | grep -q mounted && ok "脚本由宿主机挂载，更新镜像不会丢" || { bad "没有挂载 desktop 脚本（docker-compose.desktop.yml 太旧）"; hint "覆盖最新的 docker-compose.desktop.yml 后 docker compose up -d desktop"; }
echo "[3] Cindy 桌面程序"
if D 'ps -eo args | grep -iE "[/]usr/lib/cindy/Cindy --no-sandbox" >/dev/null && echo yes' | grep -q yes; then ok "在运行"; else bad "没在运行"; hint "新版入口脚本会在 10 秒内自动拉起；还不行看：docker compose exec -T desktop tail -30 /home/cindy/cindy.log"; fi
echo "[4] 本机接口（discovery.json）"
DISC="$(D 'find /home/cindy/.config -path "*local-agent/discovery.json" 2>/dev/null | head -1')"
if [ -n "$DISC" ]; then
  PORT="$(D "cat $DISC" | sed -n 's/.*"port":\([0-9]*\).*/\1/p')"
  if D "curl -s -m 3 -o /dev/null -w '%{http_code}' -X POST http://127.0.0.1:$PORT/rpc -H 'Content-Type: application/json' -d '{}'" | grep -qE '^[1-5][0-9][0-9]$'; then ok "端口 $PORT 有响应"; else bad "discovery.json 里的端口 $PORT 没人在听（过期）"; hint "重启桌面容器：docker compose restart desktop"; fi
else
  bad "没有 discovery.json"
  if D 'grep -rih "HOST_IN_USE" /home/cindy/.config/CindyGlobal/logs/ 2>/dev/null | tail -1' | grep -q HOST_IN_USE; then
    bad "日志里有 HOST_IN_USE（旧锁文件被误判）"
    if [ "$FIX" = "--fix" ]; then D 'rm -f /home/cindy/.config/CindyGlobal/local-agent/host.lock'; docker compose restart desktop >/dev/null && ok "已删除旧锁并重启桌面容器，60 秒后再运行本脚本检查"; else hint "运行 ./scripts/desktop-check.sh --fix"; fi
  else hint "多半是 Cindy 还没登录：打开桌面（管理设置 → 桌面端）登录你的 Cindy 账号"; fi
fi
echo "[5] 桥接 → 模型列表"
if docker compose ps -q yumeiro >/dev/null 2>&1 && [ -s secrets/desktop_key ]; then
  OUT="$(docker compose exec -T yumeiro node -e "fetch('http://desktop:8788/v1/models',{headers:{Authorization:'Bearer '+require('fs').readFileSync('/dev/stdin','utf8').trim()}}).then(async r=>console.log(r.status,(await r.text()).slice(0,120))).catch(e=>console.log('ERR',e.cause&&e.cause.code||e.message))" < secrets/desktop_key 2>&1 | tail -1)"
  case "$OUT" in 200*) ok "桥接正常：$OUT";; *) bad "桥接不通：$OUT"; hint "docker compose logs --tail=10 desktop；若提示等待授权，请到桌面里点“允许”";; esac
else bad "无法检查（yumeiro 容器没运行或缺少 secrets/desktop_key）"; fi
echo "[6] 内存"
free -h | sed -n 1,2p | sed 's/^/    /'
