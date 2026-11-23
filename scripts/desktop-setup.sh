#!/usr/bin/env bash
# 一键加上“Cindy 桌面端容器”：生成密钥、写入 COMPOSE_FILE、构建并启动。可重复运行。
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f .env ] || { echo "没有 .env，请先运行 ./install.sh 完成安装"; exit 1; }
SECRETS_DIR="$(grep -E '^SECRETS_DIR=' .env | cut -d= -f2- || true)"; SECRETS_DIR="${SECRETS_DIR:-./secrets}"
mkdir -p "$SECRETS_DIR"
gen() { head -c 24 /dev/urandom | base64 | tr -d '/+=\n' | head -c 32; }
[ -s "$SECRETS_DIR/desktop_key" ] || { gen > "$SECRETS_DIR/desktop_key"; }
[ -s "$SECRETS_DIR/vnc_password" ] || { gen | head -c 8 > "$SECRETS_DIR/vnc_password"; }
chmod 644 "$SECRETS_DIR/desktop_key" "$SECRETS_DIR/vnc_password"   # 容器内非 root 用户要读；目录本身仍应只有 root 可进入
# ---- 安装 / 更新 / 切换 Cindy 桌面端版本 ----
# 已经装过：默认就是“更新”（保持当前区域，在容器里直接更新，不重建镜像）；想换区域或指定版本号可以选“切换版本”。
# 没装过：选区域（国际版 / 国内版）和版本（回车 = 最新版）。命令行参数：./scripts/desktop-setup.sh [global|cn] [latest|x.y.z]
name() { [ "$1" = cn ] && echo 国内版 || echo 国际版; }
ENV_FLAVOR="$(grep -E '^CINDY_FLAVOR=' .env | cut -d= -f2- || true)"
INSTALLED=0; grep -q 'docker-compose.desktop.yml' .env && INSTALLED=1
RUNNING=0
if [ "$INSTALLED" = 1 ] && docker compose exec -T desktop test -x /tmp/desktop-update.sh >/dev/null 2>&1; then RUNNING=1; fi
REGION="${1:-}"; VER="${2:-${DESKTOP_VER:-}}"; SWITCH=0
if [ -z "$REGION" ] && [ "$INSTALLED" = 1 ]; then
  CUR="${ENV_FLAVOR:-global}"; ACT=1
  if [ -t 0 ]; then
    echo "已经安装了 Cindy 桌面端（当前：$(name "$CUR")）。请选择："
    echo "  1) 更新到最新版（保持$(name "$CUR")）[默认]"
    echo "  2) 切换版本（国际版 / 国内版 / 指定版本号）"
    read -r -p "选择 [1/2]: " ACT || true
  fi
  if [ "${ACT:-1}" != 2 ]; then
    if [ "$RUNNING" = 1 ]; then
      rc=0; docker compose exec -T -e CINDY_RESTART_ON_UPDATE=1 desktop bash /tmp/desktop-update.sh check || rc=$?
      case "$rc" in
        10) echo "已更新，桌面端正在自动重启（约 10 秒）。" ;;
        0) echo "已经是最新版本。" ;;
        *) echo "更新没有成功，原因见上面的提示（也可以在 管理设置 → 桌面端 → 软件更新 里查看）。"; exit 1 ;;
      esac
      exit 0
    fi
    REGION="$CUR"   # 容器没在运行（或还是旧版本）：用当前区域重建
  else
    SWITCH=1; REGION=""
  fi
fi
if [ -z "$REGION" ]; then
  REGION=global
  if [ -t 0 ]; then
    echo "请选择 Cindy 桌面端版本（要和你登录用的 Cindy 账号一致，两种版本的账号不互通）："
    echo "  1) 国际版 Cindy（Global）[默认]"
    echo "  2) 国内版 Cindy（CN，中国大陆账号）"
    read -r -p "选择 [1/2]: " pick || true
    case "${pick:-1}" in 2|cn|CN) REGION=cn ;; *) REGION=global ;; esac
    if [ -z "$VER" ]; then read -r -p "版本号（回车 = 最新版；也可以填 0.1.136 这样的版本固定下来）: " VER || true; fi
  fi
fi
case "$REGION" in
  cn|global) ;; *) echo "用法：$0 [global|cn] [latest|x.y.z]（默认 global 国际版、最新版）"; exit 1;;
esac
VER="${VER:-latest}"
case "$VER" in latest) ;; *[!0-9.]*|"") echo "版本号格式不对：$VER（应为 latest 或 0.1.136 这样的数字）"; exit 1;; esac
# 不再把安装包地址和校验值写死：构建时按区域和版本向 GitHub 查询官方发布页，校验值取自发布页。
# 要用自己的安装包（内网镜像等）可以设置 DESKTOP_DEB_URL / DESKTOP_SHA。
sed -i '/^CINDY_DEB_URL=/d;/^CINDY_DEB_SHA256=/d' .env
for kv in "CINDY_FLAVOR=${REGION}" "CINDY_VERSION=${VER}" ${DESKTOP_DEB_URL:+"CINDY_DEB_URL=${DESKTOP_DEB_URL}"} ${DESKTOP_SHA:+"CINDY_DEB_SHA256=${DESKTOP_SHA}"}; do k="${kv%%=*}"; if grep -q "^${k}=" .env; then sed -i "s#^${k}=.*#${kv}#" .env; else echo "$kv" >> .env; fi; done
# 已经在运行且是新版容器：切换版本直接在容器里下载安装，不重建镜像
if [ "$SWITCH" = 1 ] && [ "$RUNNING" = 1 ]; then
  docker compose exec -T -e CINDY_RESTART_ON_UPDATE=1 desktop bash /tmp/desktop-update.sh switch "$REGION" "$VER" || rc=$?
  case "${rc:-0}" in 10) echo "已切换到$(name "$REGION")（$([ "$VER" = latest ] && echo 最新版 || echo "$VER，固定版本")），桌面端正在重启；切换区域后请用对应账号重新登录一次。" ;; 0) echo "没有需要更换的内容。" ;; *) echo "切换没有成功，原因见上面的提示。"; exit 1 ;; esac
  exit 0
fi
if ! grep -q 'docker-compose.desktop.yml' .env; then
  sed -i 's#^COMPOSE_FILE=\(.*\)#COMPOSE_FILE=\1:docker-compose.desktop.yml#' .env
fi
docker compose up -d --build desktop yumeiro
echo
echo "桌面端容器已启动。接下来："
echo " 1) 浏览器登录网页管理员账号 → 管理设置 → 桌面端 → 打开桌面（VNC 密码见：$SECRETS_DIR/vnc_password）"
echo " 2) 在打开的桌面里登录 Cindy 桌面端；桥接请求授权时点“允许”"
echo " 3) 管理员在网页“管理设置 → AI 接入”添加服务商：接口地址 http://desktop:8788/v1 ，密钥见：$SECRETS_DIR/desktop_key ；点“获取模型列表”"
echo " 4) 软件更新：管理设置 → 桌面端 → 软件更新。第 1 步可随时选择国际版 / 国内版（点一下直接下载安装，不用重建镜像）；第 2 步检查更新。桌面端也会每 6 小时自动检查，新版本启动失败会自动退回旧版本。"
echo "    当前安装的是：$([ "$REGION" = global ] && echo 国际版 || echo 国内版) Cindy（区域写在 .env 的 CINDY_FLAVOR）。想换：重新运行 ./scripts/desktop-setup.sh global|cn，或直接在页面里切换。"
