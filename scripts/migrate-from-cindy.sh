#!/usr/bin/env bash
# 从旧名称（cindy）迁移到新名称（Yumeiro / yumeiro）的 Docker 部署。
#
# 用法（在项目目录里，先别 up，先别删旧卷）：
#   1) 先把新版文件覆盖到项目目录（不要覆盖 .env 和 secrets/）
#   2) ./scripts/migrate-from-cindy.sh          # 会停掉旧容器、复制数据卷、改 .env 变量名
#   3) docker compose up -d --build              # 用新名称启动
#   4) 确认一切正常后，再自己决定是否删除旧数据卷（脚本不会删）
#
# 做了什么：
#   - 停止旧栈（docker compose -p <项目名> down，数据卷保留）
#   - 备份 .env 为 .env.bak-pre-rename-<时间>
#   - .env 里我们自己的 CINDY_* 变量改成 YUMEIRO_*（官方相关的 CINDY_AUTH_/WEBSITE_/DEB_/BIN/MODEL_ACCESS_ 不动）
#   - 把应用数据卷 <项目名>_cindy_data 原样复制到 <项目名>_yumeiro_data（旧卷保持不动）
# 说明：登录会话 Cookie 改了名，迁移后大家需要重新登录一次；旧的 cak_ 令牌仍然有效，新生成的令牌以 ymr_ 开头。
set -euo pipefail
cd "$(dirname "$0")/.."
say()  { printf '%s\n' "$*"; }
ok()   { printf '\033[32m✓ %s\033[0m\n' "$*"; }
die()  { printf '\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }
command -v docker >/dev/null || die "需要 docker"

# 项目名：.env 里的 COMPOSE_PROJECT_NAME，否则是目录名（小写，只保留字母数字 - _）
PROJ="$(grep -E '^COMPOSE_PROJECT_NAME=' .env 2>/dev/null | cut -d= -f2- | tr -d '"' || true)"
[ -n "$PROJ" ] || PROJ="$(basename "$PWD" | tr '[:upper:]' '[:lower:]' | tr -cd 'a-z0-9_-')"
OLD_VOL="${PROJ}_cindy_data"; NEW_VOL="${PROJ}_yumeiro_data"
say "项目名：$PROJ"
say "旧数据卷：$OLD_VOL  →  新数据卷：$NEW_VOL"

docker volume inspect "$OLD_VOL" >/dev/null 2>&1 || die "没有找到旧数据卷 $OLD_VOL。如果你的项目名不是 $PROJ，请在 .env 里设置 COMPOSE_PROJECT_NAME 后重试；全新安装不需要迁移。"
if docker volume inspect "$NEW_VOL" >/dev/null 2>&1; then
  COUNT="$(docker run --rm -v "$NEW_VOL":/to "${NODE_IMAGE:-node:22-alpine}" sh -c 'ls -A /to | wc -l')"
  [ "$COUNT" = 0 ] || die "新数据卷 $NEW_VOL 里已经有 $COUNT 项内容，为避免覆盖已停止迁移。确认它是空的或不需要后再手动处理。"
fi

if [ "${1:-}" != "--yes" ]; then
  read -r -p "将停止服务并复制数据（旧卷不会被删除）。继续？输入 yes：" answer
  [ "$answer" = yes ] || die "已取消"
fi

say "停止旧服务…"
docker compose -p "$PROJ" down --remove-orphans >/dev/null 2>&1 || {
  IDS="$(docker ps -q --filter "label=com.docker.compose.project=$PROJ")"
  [ -z "$IDS" ] || docker stop $IDS >/dev/null
}
ok "已停止"

if [ -f .env ]; then
  STAMP="$(date +%Y%m%d-%H%M%S)"; cp -p .env ".env.bak-pre-rename-$STAMP"
  # 只改我们自己的变量名；官方相关的保持原样
  sed -E -i 's/^CINDY_MODE=/YUMEIRO_USAGE=/; s/^CINDY_(AUTH|WEBSITE|DEB|BIN|MODEL_ACCESS)/@@KEEP@@\1/; s/^CINDY_/YUMEIRO_/; s/^@@KEEP@@/CINDY_/' .env
  ok ".env 变量名已更新（备份：.env.bak-pre-rename-$STAMP）"
fi

say "复制数据卷（可能需要几十秒）…"
docker volume create "$NEW_VOL" >/dev/null
docker run --rm -v "$OLD_VOL":/from:ro -v "$NEW_VOL":/to "${NODE_IMAGE:-node:22-alpine}" sh -c 'cp -a /from/. /to/ && echo copied $(ls -A /to | wc -l) items'
ok "数据卷已复制"

say ""
say "下一步：docker compose up -d --build"
say "确认登录、对话、工作区文件都正常后，旧数据卷 $OLD_VOL 可以自行删除（docker volume rm $OLD_VOL）。"
say "内置 PostgreSQL 的数据卷名称没变，数据库用户/库名沿用 .env 里已有的值，无需处理。"
