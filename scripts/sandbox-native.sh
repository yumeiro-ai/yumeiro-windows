#!/usr/bin/env bash
# 原生（systemd）部署专用：用 Docker 只启动“代码沙箱”容器，并让原生运行器接上它。
#  - 沙箱容器在 internal 网络里：不能访问外网，也不能访问应用、数据库；只读根文件系统、非 root、丢弃全部能力；
#  - 另有一个只做转发的网关容器，把 127.0.0.1:8791 转到沙箱（internal 网络本身不能发布端口）；
#  - 沙箱只持有自己的令牌，和运行器令牌不同。
# 用法：sudo bash scripts/sandbox-native.sh
# 可选环境变量：RUNNER_NODE_IMAGE（基础镜像，国内拉取 Docker Hub 慢时可换镜像站）、NPM_REGISTRY、PIP_INDEX_URL
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "请用 root 运行（sudo bash $0）"; exit 1; }
APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
RUNNER_DIR=/etc/yumeiro/runner
TOKEN_FILE="$RUNNER_DIR/sandbox_token"
PROJECT=yumeiro-sandbox
COMPOSE_FILE="$APP_DIR/docker-compose.sandbox-native.yml"
DROPIN_DIR=/etc/systemd/system/yumeiro-runner.service.d
export RUNNER_NODE_IMAGE="${RUNNER_NODE_IMAGE:-node:22-slim}"
export NPM_REGISTRY="${NPM_REGISTRY:-https://registry.npmmirror.com}"
export PIP_INDEX_URL="${PIP_INDEX_URL:-https://pypi.tuna.tsinghua.edu.cn/simple}"

command -v docker >/dev/null || { echo "没有找到 docker"; exit 1; }
docker compose version >/dev/null 2>&1 || { echo "需要 docker compose 插件"; exit 1; }
[ -f /etc/systemd/system/yumeiro-runner.service ] || { echo "没有找到 yumeiro-runner 服务，请先安装运行器"; exit 1; }
[ -f "$APP_DIR/runner/Dockerfile" ] || { echo "$APP_DIR/runner/Dockerfile 不存在"; exit 1; }
if ! docker ps --format '{{.Names}}' | grep -q "^${PROJECT}"; then
  if ss -ltn "( sport = :8791 )" | grep -q LISTEN; then echo "端口 8791 已被其他程序占用，已停止"; exit 1; fi
fi

echo "===== 1. 沙箱令牌（只在不存在时生成）====="
[ -s "$TOKEN_FILE" ] || head -c 36 /dev/urandom | base64 | tr -d '\n' > "$TOKEN_FILE"
chown root:yumeiro-runner "$TOKEN_FILE"
chmod 644 "$TOKEN_FILE"   # 容器内非 root 用户要读；所在目录 /etc/yumeiro/runner 仍是 750，只有 root 和运行器用户能进

echo "===== 2. 生成 compose 文件 ====="
cat > "$COMPOSE_FILE" <<'YML'
x-sandbox-build: &sandbox-build
  context: ./runner
  args:
    NODE_IMAGE: ${RUNNER_NODE_IMAGE:-node:22-slim}
    NPM_REGISTRY: ${NPM_REGISTRY:-}
    INSTALL_UV: "1"
    PIP_INDEX_URL: ${PIP_INDEX_URL:-}
services:
  sandbox:
    build: *sandbox-build
    image: yumeiro-sandbox:local
    restart: unless-stopped
    environment:
      PORT: 8790
      SANDBOX_ONLY: "1"
      WORKSPACES_DIR: /tmp/unused
      SANDBOX_TOKEN_FILE: /run/secrets/sandbox_token
      SANDBOX_MAX_CONCURRENT: ${SANDBOX_MAX_CONCURRENT:-1}
      SANDBOX_MAX_SYNC_MB: ${SANDBOX_MAX_SYNC_MB:-20}
      SANDBOX_MAX_TIMEOUT_SEC: ${SANDBOX_MAX_TIMEOUT_SEC:-120}
    secrets: [sandbox_token]
    networks: [sandboxnet]
    cap_drop: [ALL]
    security_opt: ["no-new-privileges:true"]
    read_only: true
    tmpfs: ["/tmp:size=${SANDBOX_TMP_SIZE:-512m}"]
    pids_limit: ${SANDBOX_PIDS_LIMIT:-128}
    mem_limit: ${SANDBOX_MEM_LIMIT:-1g}
    cpus: ${SANDBOX_CPUS:-1}
  gateway:
    build: *sandbox-build
    image: yumeiro-sandbox:local
    restart: unless-stopped
    depends_on: [sandbox]
    entrypoint:
      - node
      - -e
      - |
        const net=require('net');
        net.createServer(c=>{const u=net.connect(8790,'sandbox');const x=()=>{c.destroy();u.destroy()};c.pipe(u);u.pipe(c);c.on('error',x);u.on('error',x);c.on('close',x);u.on('close',x)}).listen(8790,'0.0.0.0');
    networks: [sandboxnet, default]
    ports:
      - "127.0.0.1:8791:8790"
    cap_drop: [ALL]
    security_opt: ["no-new-privileges:true"]
    read_only: true
    pids_limit: 64
    mem_limit: 128m
networks:
  sandboxnet:
    internal: true
secrets:
  sandbox_token:
    file: /etc/yumeiro/runner/sandbox_token
YML

echo "===== 3. 构建并启动沙箱（首次约几分钟）====="
cd "$APP_DIR"
docker compose -p "$PROJECT" -f "$COMPOSE_FILE" up -d --build

echo "===== 4. 让运行器接上沙箱 ====="
mkdir -p "$DROPIN_DIR"
cat > "$DROPIN_DIR/sandbox.conf" <<EOF
[Service]
Environment=SANDBOX_URL=http://127.0.0.1:8791
Environment=SANDBOX_TOKEN_FILE=$TOKEN_FILE
EOF
systemctl daemon-reload
systemctl restart yumeiro-runner

echo "===== 5. 验证 ====="
for _ in $(seq 1 30); do
  body="$(curl -s -m 3 -H "Authorization: Bearer $(cat "$TOKEN_FILE")" http://127.0.0.1:8791/health || true)"
  case "$body" in *'"sandbox":true'*) break ;; esac; sleep 2
done
echo "沙箱容器健康检查：${body:-没有响应}"
echo "运行器：$(systemctl is-active yumeiro-runner)"
RT="$(cat /etc/yumeiro/runner/runner_token)"
sleep 2
echo "运行器报告："; curl -s -m 20 -H "Authorization: Bearer $RT" http://127.0.0.1:8790/health | grep -o '"sandboxConfigured":[a-z]*'
echo
echo "完成。回到 管理设置 → 智能体引擎 → 代码沙箱 刷新页面，红字提示应该消失。"
