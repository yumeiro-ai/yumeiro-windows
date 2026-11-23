#!/usr/bin/env bash
# 部署体检：容器为什么没起来 / 起来了为什么不好使。只读检查，不会改动任何东西（--fix-perms 除外）。
#   ./scripts/doctor.sh              输出状态、每个容器的退出原因、最近日志、密钥文件权限和常见问题诊断
#   ./scripts/doctor.sh --fix-perms  把 secrets/ 下的文件改成容器可读（chmod 644），然后重新 up -d
set -uo pipefail
cd "$(dirname "$0")/.."
dc() { if docker compose version >/dev/null 2>&1; then docker compose "$@"; else docker-compose "$@"; fi; }
hr() { printf '\n\033[1m== %s ==\033[0m\n' "$*"; }
warn() { printf '\033[33m! %s\033[0m\n' "$*"; PROBLEMS=$((PROBLEMS+1)); }
ok() { printf '\033[32m✓ %s\033[0m\n' "$*"; }
PROBLEMS=0

command -v docker >/dev/null 2>&1 || { echo "没有找到 docker"; exit 1; }
[ -f .env ] || { echo "没有 .env：请先运行 ./install.sh"; exit 1; }

if [ "${1:-}" = "--fix-perms" ]; then
  chmod 700 secrets && chmod 644 secrets/* && ok "已把 secrets/ 下的文件设为 644（目录保持 700）"
  dc up -d && exit 0
fi

hr "容器状态"
dc ps -a

hr "每个容器的退出信息"
for svc in $(dc config --services 2>/dev/null); do
  id="$(dc ps -aq "$svc" 2>/dev/null | head -1)"
  [ -n "$id" ] || { warn "$svc：容器还没有创建（可能被依赖失败拦住，或 up 被中断）"; continue; }
  line="$(docker inspect -f '{{.State.Status}} 退出码={{.State.ExitCode}} OOM被杀={{.State.OOMKilled}} 重启次数={{.RestartCount}} {{.State.Error}}' "$id" 2>/dev/null)"
  echo "$svc: $line"
  case "$line" in running*) ;; *) warn "$svc 不在运行";; esac
  case "$line" in *"OOM被杀=true"*) warn "$svc 因内存不足被杀：调大 RUNNER_MEM_LIMIT 或升级服务器内存";; esac
done

hr "最近日志（每个容器 25 行）"
LOGS=""
for svc in $(dc config --services 2>/dev/null); do
  echo "--- $svc ---"
  out="$(dc logs --tail 25 "$svc" 2>&1)"; echo "$out"; LOGS="$LOGS"$'\n'"$out"
done

hr "密钥文件（只看权限和大小，不显示内容）"
if [ -d secrets ]; then
  ls -l secrets | sed 's/^/  /'
  for f in secrets/*; do
    [ -f "$f" ] || continue
    mode="$(stat -c '%a' "$f" 2>/dev/null || stat -f '%Lp' "$f" 2>/dev/null)"
    case "$mode" in *4|*5|*6|*7) ;; *) warn "$f 的权限是 $mode：非 root 的容器用户读不到它 → 运行 ./scripts/doctor.sh --fix-perms";; esac
  done
  [ -s secrets/store_encryption_key ] || warn "secrets/store_encryption_key 为空或不存在"
  [ -s secrets/db_password ] || warn "secrets/db_password 为空或不存在"
else warn "没有 secrets/ 目录"; fi

hr "端口"
PORT="$(grep -E '^APP_PORT=' .env | cut -d= -f2)"; PORT="${PORT:-8787}"
if command -v ss >/dev/null 2>&1; then ss -ltn 2>/dev/null | awk '{print $4}' | grep -E "[:.]$PORT\$" >/dev/null && ok "本机 $PORT 端口有进程在监听" || warn "本机没有进程监听 $PORT（应用没起来，或绑定在 127.0.0.1 由 Caddy 转发）"; fi

hr "诊断"
grep -q "RUNNER_TOKEN_FILE" <<<"$LOGS" && warn "运行器读不到令牌文件：运行 ./scripts/doctor.sh --fix-perms"
grep -qE "EACCES|permission denied" <<<"$LOGS" && warn "日志里有权限错误（EACCES）：多半是 secrets/ 文件权限，运行 ./scripts/doctor.sh --fix-perms"
grep -qE "无法使用 PostgreSQL|ECONNREFUSED|password authentication failed" <<<"$LOGS" && warn "数据库连接失败：确认 postgres 容器 healthy；如果换过 secrets/db_password，需要删除旧数据库卷（会清空数据！）或改回原密码"
grep -q "STORE_ENCRYPTION_KEY" <<<"$LOGS" && warn "加密密钥有问题：secrets/store_encryption_key 必须和创建数据时用的是同一个"
grep -q "数据库里还没有管理员账号" <<<"$LOGS" && warn "首次启动缺管理员密码：secrets/admin_password 被清空了而库里还没有账号。把密码写回该文件后 docker compose up -d"
grep -qE "Cannot find module|ERR_MODULE_NOT_FOUND" <<<"$LOGS" && warn "镜像缺文件：重新构建 docker compose build --no-cache && docker compose up -d"
grep -qE "dependency failed to start|exited \(" <<<"$LOGS" && warn "有依赖容器启动失败，其他容器被拦住：先解决上面失败的那个"
[ "$PROBLEMS" -eq 0 ] && ok "没有发现明显问题。如果网站仍打不开，检查华为云安全组是否放行了端口。" || echo; echo "共发现 $PROBLEMS 个问题。"
