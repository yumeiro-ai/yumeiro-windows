#!/usr/bin/env bash
# 检查并更新“桌面端容器”里的 Cindy 桌面端到官方最新正式版。
#   ./scripts/desktop-update.sh --check    只看有没有新版本，不改任何东西
#   ./scripts/desktop-update.sh            有新版本就更新（需要你在场，会提示）
#   ./scripts/desktop-update.sh --auto     无人值守：有新版本就更新，失败自动回滚（给定时任务用）
# 安全措施：只取 GitHub 上“非预发布”的最新版；安装包的 sha256 取自官方发布页，构建时强制校验；
#           更新前给旧镜像打 :prev 标签，新容器 60 秒内没稳定运行就自动回滚。登录数据在 desktop_home 卷里，不受影响。
set -euo pipefail
cd "$(dirname "$0")/.."
MODE="${1:-}"
[ -f .env ] || { echo "没有 .env"; exit 1; }
grep -q 'docker-compose.desktop.yml' .env || { echo "没有启用桌面端容器（先运行 ./scripts/desktop-setup.sh）"; exit 1; }
command -v curl >/dev/null || { echo "需要 curl：apt install -y curl"; exit 1; }
# 宿主机没装 node 也行：借 yumeiro 容器里的 node 解析 JSON（要求 yumeiro 容器在运行）
nodejs() { if command -v node >/dev/null 2>&1; then node "$@"; else docker compose exec -T -e REGION="${REGION:-}" yumeiro node "$@"; fi; }
REPO="${DESKTOP_REPO:-makecindy/cindy}"
CUR_URL="$(grep -E '^CINDY_DEB_URL=' .env | cut -d= -f2- || true)"
CUR_URL="${CUR_URL:-https://github.com/$REPO/releases/download/v0.1.121/cindy-0.1.121-linux-x64-cn.deb}"
CUR_SHA="$(grep -E "^CINDY_DEB_SHA256=" .env | cut -d= -f2- || true)"
CUR_VER="$(echo "$CUR_URL" | sed -n 's#.*/cindy-\([0-9][0-9.]*\)-linux.*#\1#p')"
REGION="$(echo "$CUR_URL" | sed -n 's#.*-linux-x64-\(cn\|global\)\.deb#\1#p')"; REGION="${REGION:-cn}"; export REGION
log() { echo "[$(date '+%F %T')] $*"; }

# 取最新正式版：输出 "版本 下载地址 sha256"
INFO="$(curl -fsS -m 30 -H 'Accept: application/vnd.github+json' "https://api.github.com/repos/$REPO/releases?per_page=10" | nodejs -e '
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
  const list=JSON.parse(s),region=process.env.REGION;
  const rel=list.find(r=>!r.prerelease&&!r.draft&&r.assets.some(a=>a.name===`cindy-${r.tag_name.replace(/^v/,"")}-linux-x64-${region}.deb`));
  if(!rel){process.exit(3)}
  const ver=rel.tag_name.replace(/^v/,""),a=rel.assets.find(x=>x.name===`cindy-${ver}-linux-x64-${region}.deb`);
  const sha=String(a.digest||"").replace(/^sha256:/,"");
  if(!/^[0-9a-f]{64}$/.test(sha)){process.exit(4)}
  if(!/^https:\/\/github\.com\//.test(a.browser_download_url)){process.exit(5)}
  console.log(ver,a.browser_download_url,sha);
})' )" || { log "查询最新版本失败（网络不通，或发布页没有可校验的安装包）"; exit 2; }
read -r NEW_VER NEW_URL NEW_SHA <<< "$INFO"
log "当前 ${CUR_VER:-未知}，官方最新正式版 $NEW_VER（$REGION）"
newer() { [ "$1" != "$2" ] && [ "$(printf '%s\n%s\n' "$1" "$2" | sort -V | tail -1)" = "$1" ]; }
if ! newer "$NEW_VER" "${CUR_VER:-0}"; then log "已经是最新，无需更新"; exit 0; fi
[ "$MODE" = "--check" ] && { log "有新版本可更新：运行 ./scripts/desktop-update.sh"; exit 0; }
if [ "$MODE" != "--auto" ]; then read -r -p "更新桌面端到 $NEW_VER？构建需要几分钟，期间桌面会短暂重启 [y/N] " yn; [[ "$yn" =~ ^[Yy]$ ]] || exit 0; fi

IMG="$(docker compose images desktop --format json 2>/dev/null | nodejs -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);const a=Array.isArray(j)?j[0]:j;console.log(a?a.Repository+":"+a.Tag:"")}catch{console.log("")}})')"
IMG="${IMG:-yumeiro-desktop:latest}"
cp .env ".env.bak.desktop.$(date +%s)"
docker tag "$IMG" yumeiro-desktop:prev 2>/dev/null && log "已保留旧镜像为 yumeiro-desktop:prev" || log "没有旧镜像可备份（继续）"
setenv() { if grep -q "^$1=" .env; then sed -i "s#^$1=.*#$1=$2#" .env; else echo "$1=$2" >> .env; fi; }
rollback() {
  log "新容器最近日志（用于排查，请保存）："; docker compose logs --tail=40 desktop 2>&1 | tee -a /tmp/yumeiro-desktop-update-failed.log | tail -40
  log "更新失败，回滚到旧版本"
  setenv CINDY_DEB_URL "$CUR_URL"; setenv CINDY_DEB_SHA256 "$CUR_SHA"
  if docker image inspect yumeiro-desktop:prev >/dev/null 2>&1; then docker tag yumeiro-desktop:prev "$IMG"; docker compose up -d --no-build --force-recreate desktop || true; fi
  exit 1
}
setenv CINDY_DEB_URL "$NEW_URL"; setenv CINDY_DEB_SHA256 "$NEW_SHA"
for f in desktop/*.sh; do tr -d '\r' < "$f" > "$f.tmp" && mv "$f.tmp" "$f"; done   # Windows 上传的脚本可能是 CRLF，容器会报 no such file or directory
log "构建新镜像（强制校验 sha256）…"
docker compose build desktop || { log "构建失败（旧容器没有被动过）"; setenv CINDY_DEB_URL "$CUR_URL"; setenv CINDY_DEB_SHA256 "$CUR_SHA"; exit 1; }
docker compose up -d --no-deps desktop
log "等待新容器稳定运行 60 秒…"
sleep 60
STATE="$(docker inspect -f '{{.State.Running}} {{.RestartCount}}' "$(docker compose ps -q desktop)" 2>/dev/null || echo 'false 9')"
[ "$STATE" = "true 0" ] || { log "容器状态异常：$STATE"; rollback; }
docker compose exec -T desktop sh -c 'pgrep -f -i "no-sandbox" >/dev/null' || { log "桌面里的 Cindy 程序没起来"; rollback; }
log "更新完成：$CUR_VER → $NEW_VER。如桌面弹出“允许”确认框，请点允许。"
log "桌面端脚本由宿主机挂载（desktop/ 与 bridge/），本次更新不会丢失修复。稍后运行 ./scripts/desktop-check.sh 检查桥接是否恢复。"
