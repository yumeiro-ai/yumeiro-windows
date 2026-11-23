#!/usr/bin/env bash
# 原生（systemd）部署专用：用 Docker 只启动 Cindy 桌面端容器，不启动任何 Docker 版 yumeiro 服务。
# 容器的端口只绑定 127.0.0.1；Yumeiro 服务通过三个环境变量接上它（管理设置 → 桌面端）。
# 用法：sudo bash scripts/desktop-native.sh [global|cn] [latest|x.y.z]
# 可重复运行：已有密钥不会覆盖，已有容器会原地更新。
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "请用 root 运行（sudo bash $0）"; exit 1; }
APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE=/etc/yumeiro/yumeiro.env
DESK_DIR=/etc/yumeiro/desktop
PROJECT=yumeiro-desktop
COMPOSE_FILE="$APP_DIR/docker-compose.desktop-native.yml"
FLAVOR="${1:-global}"; VER="${2:-latest}"
case "$FLAVOR" in global|cn) ;; *) echo "区域只能是 global（国际版）或 cn（国内版）"; exit 1 ;; esac
case "$VER" in latest) ;; *[!0-9.]*|"") echo "版本号格式不对：$VER（应为 latest 或 0.1.136 这样的数字）"; exit 1 ;; esac

command -v docker >/dev/null || { echo "没有找到 docker"; exit 1; }
docker compose version >/dev/null 2>&1 || { echo "需要 docker compose 插件"; exit 1; }
[ -f "$ENV_FILE" ] || { echo "找不到 $ENV_FILE，请先完成 Yumeiro 安装"; exit 1; }
[ -f "$APP_DIR/desktop/Dockerfile" ] && [ -d "$APP_DIR/bridge" ] || { echo "$APP_DIR 里缺少 desktop/ 或 bridge/ 目录"; exit 1; }

# 端口检查：已经是我们自己的容器占着就不算冲突
if ! docker ps --format '{{.Names}}' | grep -q "^${PROJECT}"; then
  for p in 6080 8788 8789; do
    if ss -ltn "( sport = :$p )" | grep -q LISTEN; then echo "端口 $p 已被其他程序占用，已停止"; exit 1; fi
  done
fi

echo "===== 1. 密钥（只在不存在时生成）====="
install -d -m 750 -o root -g yumeiro "$DESK_DIR"
gen() { head -c 24 /dev/urandom | base64 | tr -d '/+=\n' | head -c 32; }
[ -s "$DESK_DIR/desktop_key" ] || { gen > "$DESK_DIR/desktop_key"; }
if [ ! -s "$DESK_DIR/vnc_password" ]; then V="$(gen)"; printf '%s' "${V:0:8}" > "$DESK_DIR/vnc_password"; fi
chown root:yumeiro "$DESK_DIR/desktop_key" "$DESK_DIR/vnc_password"
chmod 644 "$DESK_DIR/desktop_key" "$DESK_DIR/vnc_password"   # 容器内非 root 用户要读；目录本身只有 root 和 yumeiro 组能进

echo "===== 2. 生成 compose 文件（只有 desktop 一个服务）====="
cat > "$COMPOSE_FILE" <<'YML'
services:
  desktop:
    build:
      context: .
      dockerfile: desktop/Dockerfile
      args:
        NODE_IMAGE: ${RUNNER_NODE_IMAGE:-node:22-slim}
        CINDY_FLAVOR: ${CINDY_FLAVOR:-global}
        CINDY_VERSION: ${CINDY_VERSION:-latest}
        CINDY_DEB_URL: ${CINDY_DEB_URL:-}
        CINDY_DEB_SHA256: ${CINDY_DEB_SHA256:-}
    restart: unless-stopped
    environment:
      CINDY_FLAVOR: ${CINDY_FLAVOR:-global}
      CINDY_AUTO_UPDATE: ${CINDY_AUTO_UPDATE:-1}
      CINDY_UPDATE_INTERVAL_HOURS: ${CINDY_UPDATE_INTERVAL_HOURS:-6}
      CINDY_DOWNLOAD_PREFIX: ${CINDY_DOWNLOAD_PREFIX:-}
    secrets: [desktop_key, vnc_password]
    entrypoint: ["/bin/bash", "-c", "tr -d '\r' < /opt/desktop/entrypoint.sh > /tmp/desktop-entrypoint && exec /bin/bash /tmp/desktop-entrypoint"]
    volumes:
      - desktop_home:/home/cindy
      - ./desktop:/opt/desktop:ro
      - ./bridge:/opt/bridge:ro
    ports:
      - "127.0.0.1:6080:6080"
      - "127.0.0.1:8788:8788"
      - "127.0.0.1:8789:8789"
    shm_size: 512m
    cap_drop: [ALL]
    security_opt: ["no-new-privileges:true"]
    pids_limit: 512
    mem_limit: ${DESKTOP_MEM_LIMIT:-1536m}
    cpus: ${DESKTOP_CPUS:-1.5}
volumes:
  desktop_home:
secrets:
  desktop_key:
    file: /etc/yumeiro/desktop/desktop_key
  vnc_password:
    file: /etc/yumeiro/desktop/vnc_password
YML

echo "===== 3. 构建并启动桌面容器（首次约几分钟）====="
cd "$APP_DIR"
CINDY_FLAVOR="$FLAVOR" CINDY_VERSION="$VER" docker compose -p "$PROJECT" -f "$COMPOSE_FILE" up -d --build

echo "===== 4. 让 Yumeiro 服务接上桌面容器 ====="
[ -z "$(tail -c1 "$ENV_FILE")" ] || echo >> "$ENV_FILE"
set_env() { sed -i "/^$1=/d" "$ENV_FILE"; echo "$1=$2" >> "$ENV_FILE"; }
set_env DESKTOP_VIEW_URL http://127.0.0.1:6080
set_env DESKTOP_STATUS_URL http://127.0.0.1:8789
set_env DESKTOP_KEY_FILE "$DESK_DIR/desktop_key"
systemctl restart yumeiro

echo "===== 5. 等待就绪 ====="
for _ in $(seq 1 60); do
  code="$(curl -s -o /dev/null -w '%{http_code}' -m 3 http://127.0.0.1:6080/ || true)"
  [ "$code" = 200 ] && break; sleep 3
done
echo "桌面画面服务（6080）HTTP $code"
echo "Yumeiro 服务：$(systemctl is-active yumeiro)"
echo
echo "完成。接下来："
echo " 1) 浏览器登录管理员账号 → 管理设置 → 桌面端 → 打开桌面（VNC 密码：$DESK_DIR/vnc_password）"
echo " 2) 在打开的桌面里登录 Cindy 桌面端；桥接请求授权时点“允许”"
echo " 3) 管理设置 → AI 接入 添加服务商：接口地址 http://127.0.0.1:8788/v1 ，密钥见 $DESK_DIR/desktop_key"
