#!/usr/bin/env bash
# Yumeiro 私有工作空间 · 非 Docker 安装（直接装在服务器上，用 systemd 管理）
#
#   sudo ./deploy/yumeiro-native.sh install   [选项]   首次安装（可重复执行，已有配置和数据不会被覆盖）
#   sudo ./deploy/yumeiro-native.sh update             升级到当前目录里的新版本（先备份，起不来自动回滚）
#   sudo ./deploy/yumeiro-native.sh engines [--npm-registry URL]   安装 / 升级 Claude Code、Codex、Pi（重复执行即升级到最新版）
#   sudo ./deploy/yumeiro-native.sh backup             立即备份数据和工作区（含全部文件版本）
#   sudo ./deploy/yumeiro-native.sh status             查看服务状态与健康检查
#   sudo ./deploy/yumeiro-native.sh scrub-admin        首次登录成功后，删除服务器上保存的管理员初始密码
#   sudo ./deploy/yumeiro-native.sh clients <文件夹>    把客户端安装包（Yumeiro-Setup-*.exe / Yumeiro-Portable-*.exe / Yumeiro-*.apk）传进 /var/lib/yumeiro/downloads，网页的“下载客户端”引导就会出现按钮
#   sudo ./deploy/yumeiro-native.sh migrate            从旧名称（cindy）的安装迁移：改名目录/服务/账号，数据与配置原样保留，然后装上新版
#   sudo ./deploy/yumeiro-native.sh https  [选项]      用 nginx（含宝塔）在指定端口提供 HTTPS（自签名证书或你自己的证书），应用本身只留在本机
#   sudo ./deploy/yumeiro-native.sh uninstall          卸载服务与程序（默认保留 /var/lib/yumeiro* 数据和备份）
#
# install 选项：
#   --port N            监听端口，默认 8787
#   --domain example.com 前面有 HTTPS 反向代理（Caddy/Nginx）时填写；服务只监听 127.0.0.1，并启用安全 Cookie
#   --admin-email X     管理员邮箱，默认 admin@example.com
#   --personal          个人使用模式：隐藏成员/邀请等团队功能（以后可在站点设置里切换）
#   --with-runner       同时安装智能体运行器，并自动装好 Claude Code / Codex / Pi（装到 /opt/yumeiro-engines）
#   --no-engines        配合 --with-runner：只装运行器，不装三个引擎（以后用 engines 子命令装）
#   --pg-url URL        使用外部 PostgreSQL（默认用加密 JSON 文件存储，小团队足够）
#   --model-url URL --model-name N --model-key K   预设一个 OpenAI 兼容模型（也可以以后在管理设置里加）
#   --npm-registry URL  npm 镜像（国内可用 https://registry.npmmirror.com）
#   --install-node      没有 Node.js 22+ 时自动安装官方版本到 /usr/local（不加则会询问；-y 表示全部同意）
#   --node-mirror M     Node.js 下载源：official | cn（国内镜像）| 自定义地址；默认先官方再国内
#   --tls-port N        install 完成后顺便在 N 端口开 HTTPS（等同再执行一次 https 子命令）
#   --ip IP             https：证书里写的公网 IP（不写则自动探测）
#   --cert F --key F    https：用你自己的证书（比如宝塔 / certbot 申请的）；不写则生成自签名证书
#   --install-nginx     https：没有 nginx 时自动安装
#   -y, --yes           所有询问都当作“是”（无人值守）
#   --backup-keep N     自动备份保留份数，默认 14
#   --no-clean          安装 / 升级成功后不要自动清理（默认会清理：旧的升级前备份只留 3 份、程序目录里不再用的旧模块、npm 缓存、已经装好的解压目录）
#   --clients DIR       install / update 完成后顺便上传 DIR 里的客户端安装包（不写时，如果解压目录里有 Yumeiro-Clients 文件夹也会自动上传）
set -euo pipefail
umask 022   # root 的 umask 过严（如 077）时，新建的程序目录会变成 700，服务账号进不去（status=200/CHDIR）；密钥文件另有自己的 umask 077

APP_DIR=/cindy/Yumeiro
CONF_DIR=/etc/yumeiro
SECRETS_DIR=$CONF_DIR/secrets
RUNNER_SECRET_DIR=$CONF_DIR/runner
DATA_DIR=/var/lib/yumeiro
WORK_DIR=/var/lib/yumeiro-workspaces
BACKUP_DIR=/var/backups/yumeiro
ENV_FILE=$CONF_DIR/yumeiro.env
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

say()  { printf '%s\n' "$*"; }
ok()   { printf '\033[32m✓ %s\033[0m\n' "$*"; }
warn() { printf '\033[33m! %s\033[0m\n' "$*" >&2; }
die()  { printf '\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }
[ "$(id -u)" = 0 ] || die "请用 root 运行（sudo $0 ...）"
command -v systemctl >/dev/null || die "需要 systemd。没有 systemd 的系统请用 Docker 版本。"

CMD="${1:-}"; shift || true
PORT=8787; DOMAIN=""; ADMIN_EMAIL="admin@example.com"; WITH_RUNNER=1; PERSONAL=0; PG_URL=""
NO_CLEAN=0; CLEAN_NPM_CACHE=1
NO_ENGINES=0; MODEL_URL=""; MODEL_NAME=""; MODEL_KEY=""; NPM_REGISTRY=""; BACKUP_KEEP=14; CLIENTS_DIR=""
WEB_SETUP=1
ASSUME_YES=0; INSTALL_NODE=0; NODE_MIRROR=""; TLS_PORT=""; TLS_IP=""; TLS_CERT=""; TLS_KEY=""; INSTALL_NGINX=0
while [ $# -gt 0 ]; do
  case "$1" in
    --port) PORT="$2"; shift 2 ;;
    --domain) DOMAIN="$2"; shift 2 ;;
    --admin-email) ADMIN_EMAIL="$(printf '%s' "$2" | tr '[:upper:]' '[:lower:]')"; shift 2 ;;
    --with-runner) WITH_RUNNER=1; shift ;;
    --no-engines) NO_ENGINES=1; shift ;;
    --personal) PERSONAL=1; shift ;;
    --pg-url) PG_URL="$2"; shift 2 ;;
    --model-url) MODEL_URL="$2"; shift 2 ;;
    --model-name) MODEL_NAME="$2"; shift 2 ;;
    --model-key) MODEL_KEY="$2"; shift 2 ;;
    --npm-registry) NPM_REGISTRY="$2"; shift 2 ;;
    --backup-keep) BACKUP_KEEP="$2"; shift 2 ;;
    --no-clean) NO_CLEAN=1; shift ;;
    --clients) CLIENTS_DIR="$2"; shift 2 ;;
    --no-web-setup) WEB_SETUP=0; shift ;;
    --install-node) INSTALL_NODE=1; shift ;;
    --node-mirror) NODE_MIRROR="$2"; shift 2 ;;
    --tls-port) TLS_PORT="$2"; shift 2 ;;
    --ip) TLS_IP="$2"; shift 2 ;;
    --cert) TLS_CERT="$2"; shift 2 ;;
    --key) TLS_KEY="$2"; shift 2 ;;
    --install-nginx) INSTALL_NGINX=1; shift ;;
    -y|--yes) ASSUME_YES=1; shift ;;
    *) if [ "$CMD" = clients ] && [ -z "$CLIENTS_DIR" ]; then CLIENTS_DIR="$1"; shift; else die "未知参数：$1"; fi ;;
  esac
done

confirm() {   # confirm "问题"：-y 直接同意；没有终端（管道 / 无人值守）就当作不同意
  [ "$ASSUME_YES" = 1 ] && return 0
  [ -t 0 ] || return 1
  local a; read -r -p "$1 [Y/n] " a; case "$a" in n|N|no|NO) return 1 ;; *) return 0 ;; esac
}
node_bin() { command -v node || { [ -x /usr/local/bin/node ] && echo /usr/local/bin/node; } || true; }
node_major() { "$1" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }
# 下载官方 Node.js 22（校验 SHA256）解压到 /usr/local；不依赖发行版软件源，任何 Linux 都能用
install_node() {
  local arch; case "$(uname -m)" in x86_64|amd64) arch=x64 ;; aarch64|arm64) arch=arm64 ;; armv7l) arch=armv7l ;; *) die "不支持的 CPU 架构 $(uname -m)，请手动安装 Node.js 22+" ;; esac
  command -v curl >/dev/null || die "自动安装 Node.js 需要 curl（apt install curl / dnf install curl）"
  command -v tar >/dev/null || die "自动安装 Node.js 需要 tar"
  command -v sha256sum >/dev/null || die "自动安装 Node.js 需要 sha256sum（coreutils）"
  local bases=(https://nodejs.org/dist https://cdn.npmmirror.com/binaries/node)
  case "$NODE_MIRROR" in
    "") ;;
    official) bases=(https://nodejs.org/dist) ;;
    cn) bases=(https://cdn.npmmirror.com/binaries/node https://nodejs.org/dist) ;;
    *) bases=("${NODE_MIRROR%/}") ;;
  esac
  local tmp base sums file want got done=0; tmp="$(mktemp -d)"
  for base in "${bases[@]}"; do
    say "→ 从 $base 获取 Node.js 22 …"
    sums="$(curl -fsSL -m 25 "$base/latest-v22.x/SHASUMS256.txt" 2>/dev/null)" || { warn "连不上 $base"; continue; }
    file="$(printf '%s\n' "$sums" | awk -v a="linux-$arch.tar.gz" '$2 ~ (a "$") {print $2; exit}')"
    [ -n "$file" ] || { warn "$base 里没有 linux-$arch 的安装包"; continue; }
    curl -fL --progress-bar -m 900 -o "$tmp/$file" "$base/latest-v22.x/$file" || { warn "下载失败：$base"; continue; }
    want="$(printf '%s\n' "$sums" | awk -v f="$file" '$2==f {print $1}')"; got="$(sha256sum "$tmp/$file" | cut -d' ' -f1)"
    [ "$want" = "$got" ] || { warn "校验失败（下载不完整或被篡改），换下一个源"; continue; }
    done=1; break
  done
  [ "$done" = 1 ] || { rm -rf "$tmp"; die "Node.js 下载失败。服务器访问不了官方源时：在能上网的电脑下载 node-v22.x-linux-$arch.tar.gz 传到服务器，执行 tar -xzf 该文件 -C /usr/local --strip-components=1；或加 --node-mirror cn。"; }
  tar -xzf "$tmp/$file" -C /usr/local --strip-components=1 --no-same-owner --exclude='*/CHANGELOG.md' --exclude='*/LICENSE' --exclude='*/README.md' || { rm -rf "$tmp"; die "解压 Node.js 失败"; }
  rm -rf "$tmp"; hash -r
  ok "已安装 Node.js $(/usr/local/bin/node -v) 到 /usr/local/bin"
}
# 智能体引擎（Claude Code / Codex / Pi）：装到 /opt/yumeiro-engines，运行器的 PATH 里带上它。可重复执行 = 升级到最新版。
ENGINES_PREFIX=/opt/yumeiro-engines
install_engines() {
  command -v npm >/dev/null 2>&1 || die "没有 npm，无法安装 Claude Code / Codex / Pi（先装好 Node.js 22+）"
  local reg=(); [ -n "$NPM_REGISTRY" ] && reg=(--registry "$NPM_REGISTRY")
  mkdir -p "$ENGINES_PREFIX"
  local failed=0 pkg
  for pkg in @anthropic-ai/claude-code @openai/codex @mariozechner/pi-coding-agent; do
    echo "安装 $pkg …"
    if npm install -g --prefix "$ENGINES_PREFIX" "${reg[@]}" "$pkg@latest" > /tmp/yumeiro-engines.log 2>&1; then ok "$pkg"
    else warn "$pkg 安装失败（详情 /tmp/yumeiro-engines.log；国内服务器可加 --npm-registry https://registry.npmmirror.com）"; failed=1; fi
  done
  chmod -R go+rX "$ENGINES_PREFIX"
  local c; for c in claude codex pi; do
    if [ -x "$ENGINES_PREFIX/bin/$c" ]; then ok "$c $("$ENGINES_PREFIX/bin/$c" --version 2>/dev/null | head -1)"; else warn "$c 没有装上"; fi
  done
  return $failed
}

check_node() {
  local bin major=0; bin="$(node_bin)"
  [ -n "$bin" ] && major="$(node_major "$bin")"
  if [ "$major" -lt 22 ]; then
    local what="没有找到 Node.js"; [ -n "$bin" ] && what="Node.js 版本太低（当前 $("$bin" -v)）"
    if [ "$INSTALL_NODE" = 1 ] || confirm "$what，需要 22 或更高。现在自动安装官方 Node.js 22 到 /usr/local ？"; then
      install_node; bin="$(node_bin)"; major="$(node_major "$bin")"
    fi
    [ "$major" -ge 22 ] || die "$what。请先安装 Node.js 22 或更高版本，或加 --install-node 让脚本自动安装（国内服务器再加 --node-mirror cn）。"
  fi
  # 同一台机器上有旧版 /usr/bin/node 又有新装的 /usr/local/bin/node：PATH 里新的在前，但再确认一次实际用的是够新的那个
  [ "$(node_major "$(node_bin)")" -ge 22 ] || die "PATH 里优先的 node 版本不够（$("$(node_bin)" -v)），请调整 PATH 或卸载旧版"
}

# 把程序文件复制到 /opt/yumeiro（不动 node_modules）
sync_code() {
  [ "$SRC" != "$APP_DIR" ] || die "请在新版本解压出来的目录里运行本脚本，不要在 /opt/yumeiro 里运行"
  mkdir -p "$APP_DIR"
  for item in server.mjs storage.mjs providers.mjs collab.mjs platform-models.mjs market.mjs market-sources.mjs asr.mjs asr-native.mjs memory.mjs audit.mjs envcheck.mjs doctor.mjs mcp.mjs mcp-market.mjs docs.mjs docparse.mjs images.mjs tts.mjs ziputil.mjs updatepkg.mjs demo.mjs vision.mjs remote.mjs recover.mjs project.mjs aiexport.mjs breaker.mjs dlp.mjs plans.mjs mail.mjs package.json package-lock.json; do
    [ -f "$SRC/$item" ] && install -m 0644 "$SRC/$item" "$APP_DIR/$item"
  done
  rm -rf "$APP_DIR/public" "$APP_DIR/scripts" "$APP_DIR/runner"
  cp -r "$SRC/public" "$SRC/scripts" "$APP_DIR/"
  rm -rf "$APP_DIR/public/downloads"          # 客户端安装包不随程序部署，放在 $DATA_DIR/downloads（见 scripts/install-clients.mjs）
  mkdir -p "$APP_DIR/runner"; cp "$SRC"/runner/*.mjs "$APP_DIR/runner/"
  mkdir -p "$APP_DIR/setup"; cp "$SRC"/setup/*.mjs "$APP_DIR/setup/"
  mkdir -p "$APP_DIR/deploy"; cp -r "$SRC"/deploy/. "$APP_DIR/deploy/"; chmod +x "$APP_DIR"/deploy/*.sh
  chown -R root:root "$APP_DIR"
  chmod 755 "$APP_DIR"; chmod -R go+rX "$APP_DIR"   # 服务以 yumeiro 用户运行：root 的 umask 过严（如 077）时目录会是 700，导致 status=200/CHDIR
}
npm_install() {
  # 先装到临时目录，成功了才替换 node_modules：装不上（比如服务器连不上 npm 源）时旧依赖原样保留，服务不会因此起不来
  local reg=(); [ -n "$NPM_REGISTRY" ] && reg=(--registry "$NPM_REGISTRY")
  local tmp="$APP_DIR/.nm-new"; rm -rf "$tmp"; mkdir -p "$tmp"
  cp "$APP_DIR/package.json" "$APP_DIR/package-lock.json" "$tmp/"
  if ( cd "$tmp" && npm ci --omit=dev "${reg[@]}" ); then
    rm -rf "$APP_DIR/node_modules"; mv "$tmp/node_modules" "$APP_DIR/node_modules"; rm -rf "$tmp"
    chown -R root:root "$APP_DIR/node_modules"; chmod -R go+rX "$APP_DIR/node_modules"
    return 0
  fi
  rm -rf "$tmp"; return 1
}

health() { # 等服务健康；$1 = 最长秒数
  local n="${1:-40}" port; port="$(grep -E '^PORT=' "$ENV_FILE" | cut -d= -f2)"
  for _ in $(seq 1 "$n"); do
    if curl -fsS -m 3 "http://127.0.0.1:${port:-8787}/api/health" >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  return 1
}

write_units() {
  local node; node="$(node_bin)"
  cat > /etc/systemd/system/yumeiro.service <<EOF
[Unit]
Description=Yumeiro 私有工作空间
After=network-online.target
Wants=network-online.target

[Service]
User=yumeiro
Group=yumeiro
WorkingDirectory=$APP_DIR
EnvironmentFile=$ENV_FILE
ExecStartPre=-$node scripts/seed-wallpapers.mjs
ExecStart=$node server.mjs
Restart=always
RestartSec=3
# 安全加固：只能写数据目录，不能提权，看不到别人的 /tmp 和 home
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=$DATA_DIR
ProtectKernelTunables=true
ProtectControlGroups=true
RestrictSUIDSGID=true

[Install]
WantedBy=multi-user.target
EOF
  if [ "$WITH_RUNNER" = 1 ]; then
    cat > /etc/systemd/system/yumeiro-runner.service <<EOF
[Unit]
Description=Yumeiro 智能体运行器
After=network-online.target

[Service]
User=yumeiro-runner
Group=yumeiro-runner
WorkingDirectory=$APP_DIR/runner
Environment=PORT=8790
Environment=HOST=127.0.0.1
Environment=WORKSPACES_DIR=$WORK_DIR
Environment=RUNNER_TOKEN_FILE=$RUNNER_SECRET_DIR/runner_token
Environment=PATH=$ENGINES_PREFIX/bin:$(dirname "$node"):/usr/local/bin:/usr/bin:/bin
ExecStart=$node $APP_DIR/runner/runner.mjs
Restart=always
RestartSec=3
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=$WORK_DIR
MemoryMax=2G
TasksMax=256

[Install]
WantedBy=multi-user.target
EOF
  fi
  if [ "$WEB_SETUP" = 1 ]; then
    cat > /etc/systemd/system/yumeiro-setup-helper.service <<EOF
[Unit]
Description=Yumeiro 首次安装受限助手
After=network-online.target

[Service]
Type=simple
User=root
Group=yumeiro
WorkingDirectory=$APP_DIR
Environment=SETUP_HELPER_SOCKET=/run/yumeiro/setup-helper.sock
Environment=SETUP_HELPER_TOKEN_FILE=$SECRETS_DIR/setup_helper_token
Environment=YUMEIRO_APP_DIR=$APP_DIR
Environment=DATA_DIR=$DATA_DIR
ExecStart=$node $APP_DIR/setup/setup-helper.mjs
Restart=on-failure
NoNewPrivileges=false
PrivateTmp=true
ProtectSystem=no
ProtectHome=true
RuntimeDirectory=yumeiro
RuntimeDirectoryMode=0750
CacheDirectory=yumeiro-setup
UMask=0007

[Install]
WantedBy=multi-user.target
EOF
  fi
  cat > /etc/systemd/system/yumeiro-backup.service <<EOF
[Unit]
Description=Yumeiro 数据备份

[Service]
Type=oneshot
ExecStart=$APP_DIR/deploy/yumeiro-native.sh backup
EOF
  cat > /etc/systemd/system/yumeiro-backup.timer <<EOF
[Unit]
Description=Yumeiro 每日备份

[Timer]
OnCalendar=*-*-* 03:30:00
Persistent=true
RandomizedDelaySec=600

[Install]
WantedBy=timers.target
EOF
  systemctl daemon-reload
}

do_backup() {
  mkdir -p "$BACKUP_DIR"; chmod 700 "$BACKUP_DIR"
  local stamp file; stamp="$(date +%Y%m%d-%H%M%S)"; file="$BACKUP_DIR/yumeiro-$stamp.tar.gz"
  # 数据文件是整文件写入后改名，直接打包是一致的；包含工作区文件和 .versions 里的全部历史版本、配置与密钥
  local items=("$DATA_DIR" "$CONF_DIR"); [ -d "$WORK_DIR" ] && items+=("$WORK_DIR")
  tar -czf "$file" --warning=no-file-changed --exclude="$DATA_DIR/downloads" "${items[@]}" 2>/dev/null || [ $? -eq 1 ] || die "备份失败"
  chmod 600 "$file"
  ok "备份完成：$file（$(du -h "$file" | cut -f1)）"
  # 只保留最近 N 份自动备份；升级前备份（pre-update-*）另外保留最近 5 份
  ls -1t "$BACKUP_DIR"/yumeiro-*.tar.gz 2>/dev/null | tail -n +"$((BACKUP_KEEP + 1))" | xargs -r rm -f
  ls -1t "$BACKUP_DIR"/pre-update-*.tar.gz 2>/dev/null | tail -n +6 | xargs -r rm -f
}

# 从旧名称迁移（/opt/cindy 等 → /opt/yumeiro 等）。只改名和改归属，不改数据内容；旧的 cindy 系统账号保留不删。
do_migrate() {
  local OLD_APP=/opt/cindy OLD_CONF=/etc/cindy OLD_DATA=/var/lib/cindy OLD_WORK=/var/lib/cindy-workspaces OLD_BAK=/var/backups/cindy
  [ -d "$OLD_CONF" ] || [ -d "$OLD_DATA" ] || die "没有发现旧名称（cindy）的安装，无需迁移。"
  [ ! -e "$CONF_DIR" ] && [ ! -e "$DATA_DIR" ] || die "新位置（$CONF_DIR 或 $DATA_DIR）已存在，为避免覆盖请手动检查后再迁移。"
  say "迁移前建议先备份：tar -czf ~/cindy-before-rename.tar.gz $OLD_CONF $OLD_DATA $OLD_WORK"
  read -r -p "已备份并确认迁移？输入 yes 继续：" answer; [ "$answer" = yes ] || die "已取消"
  local had_runner=0; [ -f /etc/systemd/system/cindy-runner.service ] && had_runner=1
  systemctl disable --now cindy.service cindy-runner.service cindy-backup.timer 2>/dev/null || true
  getent group yumeiro >/dev/null || groupadd --system yumeiro
  id yumeiro >/dev/null 2>&1 || useradd --system --gid yumeiro --home-dir "$DATA_DIR" --shell /usr/sbin/nologin yumeiro
  [ -d "$OLD_CONF" ] && mv "$OLD_CONF" "$CONF_DIR"
  [ -d "$OLD_DATA" ] && mv "$OLD_DATA" "$DATA_DIR"
  [ -d "$OLD_BAK" ] && mv "$OLD_BAK" "$BACKUP_DIR"
  [ -f "$CONF_DIR/cindy.env" ] && mv "$CONF_DIR/cindy.env" "$ENV_FILE"
  chown -R yumeiro:yumeiro "$DATA_DIR"; chown -R root:yumeiro "$CONF_DIR"
  if [ "$had_runner" = 1 ]; then
    getent group yumeiro-runner >/dev/null || groupadd --system yumeiro-runner
    id yumeiro-runner >/dev/null 2>&1 || useradd --system --gid yumeiro-runner --home-dir "$WORK_DIR" --shell /usr/sbin/nologin yumeiro-runner
    [ -d "$OLD_WORK" ] && mv "$OLD_WORK" "$WORK_DIR"
    chown -R yumeiro-runner:yumeiro-runner "$WORK_DIR"
    [ -d "$RUNNER_SECRET_DIR" ] && chown -R root:yumeiro-runner "$RUNNER_SECRET_DIR"
    usermod -aG yumeiro-runner yumeiro
    WITH_RUNNER=1
  fi
  # 配置里的路径和变量名改成新名称
  sed -i -e 's#/etc/cindy#/etc/yumeiro#g' -e 's#/var/lib/cindy-workspaces#/var/lib/yumeiro-workspaces#g' -e 's#/var/lib/cindy#/var/lib/yumeiro#g' -e 's#^CINDY_MODE=#YUMEIRO_USAGE=#' "$ENV_FILE"
  rm -f /etc/systemd/system/cindy.service /etc/systemd/system/cindy-runner.service /etc/systemd/system/cindy-backup.service /etc/systemd/system/cindy-backup.timer
  systemctl daemon-reload
  rm -rf "$OLD_APP"
  ok "目录、配置与账号已改名；接下来安装新版程序并启动服务…"
}

# ---- 预检：端口、磁盘、依赖 ----
port_pids() { ss -ltnpH "sport = :$1" 2>/dev/null | head -3; }
port_busy_by_other() {   # 端口被“不是 yumeiro 服务”的程序占用时返回 0
  local info; info="$(port_pids "$1")"; [ -n "$info" ] || return 1
  systemctl is-active --quiet yumeiro.service 2>/dev/null && printf '%s' "$info" | grep -q 'node' && grep -qE "^PORT=$1$" "$ENV_FILE" 2>/dev/null && return 1
  return 0
}
preflight() {
  local miss=() c; for c in curl openssl tar sha256sum; do command -v "$c" >/dev/null || miss+=("$c"); done
  [ "${#miss[@]}" -eq 0 ] || die "缺少命令：${miss[*]}（apt install ${miss[*]} 或 dnf install ${miss[*]}）"
  [ "$(systemctl is-system-running 2>/dev/null || true)" != offline ] || die "systemd 没有在运行（容器里常见）。请改用 Docker 版。"
  local free; free="$(df -Pm /var 2>/dev/null | awk 'NR==2{print $4}')"
  [ -z "$free" ] || [ "$free" -ge 500 ] || warn "/var 所在磁盘只剩 ${free} MB，建议至少留出 1 GB"
  if port_busy_by_other "$PORT"; then
    warn "端口 $PORT 已被其它程序占用："; port_pids "$PORT" >&2
    die "请换一个端口（--port N），或先停掉占用它的程序。"
  fi
}
env_set() {   # env_set KEY VALUE：有就改，没有就追加
  if grep -q "^$1=" "$ENV_FILE"; then sed -i "s#^$1=.*#$1=$2#" "$ENV_FILE"; else printf '%s=%s\n' "$1" "$2" >> "$ENV_FILE"; fi
}
public_ip() {
  local ip c; for c in https://api.ipify.org https://ifconfig.me/ip https://ipv4.icanhazip.com https://myip.ipip.net; do
    ip="$(curl -fsS -m 6 "$c" 2>/dev/null | grep -oE '([0-9]{1,3}\.){3}[0-9]{1,3}' | head -1 || true)"; [ -n "$ip" ] && { echo "$ip"; return 0; }
  done
  hostname -I 2>/dev/null | awk '{print $1}'
}
nginx_bin() { command -v nginx || { [ -x /www/server/nginx/sbin/nginx ] && echo /www/server/nginx/sbin/nginx; } || true; }
nginx_conf_dir() {   # 宝塔面板的 nginx 只会加载它自己的 vhost 目录；标准安装用 conf.d
  if [ -d /www/server/panel/vhost/nginx ]; then echo /www/server/panel/vhost/nginx
  elif [ -d /etc/nginx/conf.d ]; then echo /etc/nginx/conf.d
  else echo ""; fi
}
nginx_reload() {
  local nb; nb="$(nginx_bin)"
  "$nb" -t || return 1
  systemctl reload nginx 2>/dev/null || "$nb" -s reload
}
install_nginx() {
  if command -v apt-get >/dev/null; then DEBIAN_FRONTEND=noninteractive apt-get update -y >/dev/null && DEBIAN_FRONTEND=noninteractive apt-get install -y nginx
  elif command -v dnf >/dev/null; then dnf install -y nginx
  elif command -v yum >/dev/null; then yum install -y nginx
  else die "不认识的发行版，请手动安装 nginx 后重试"; fi
  systemctl enable --now nginx >/dev/null 2>&1 || true
}
# 在 TLS_PORT 上用 nginx 提供 HTTPS，应用只留在 127.0.0.1:PORT
setup_https() {
  [ -f "$ENV_FILE" ] || die "还没有安装，请先 install"
  [ -n "$TLS_PORT" ] || TLS_PORT=3005
  case "$TLS_PORT" in ''|*[!0-9]*) die "--tls-port 必须是数字" ;; esac
  local app_port; app_port="$(grep -E '^PORT=' "$ENV_FILE" | cut -d= -f2)"; app_port="${app_port:-8787}"
  if [ "$app_port" = "$TLS_PORT" ]; then
    local np=8787; [ "$np" = "$TLS_PORT" ] && np=8788
    warn "应用现在监听 $app_port，和 HTTPS 端口相同；应用改到 127.0.0.1:$np，由 nginx 在 $TLS_PORT 对外提供 HTTPS。"
    app_port="$np"; env_set PORT "$app_port"
  fi
  local nb; nb="$(nginx_bin)"
  if [ -z "$nb" ]; then
    if [ "$INSTALL_NGINX" = 1 ] || confirm "没有找到 nginx。现在自动安装？"; then install_nginx; nb="$(nginx_bin)"; fi
    [ -n "$nb" ] || die "需要 nginx。可加 --install-nginx 自动安装，或手动安装后重试。（不想用 nginx：用 Caddy，把 https://你的域名 反代到 127.0.0.1:$app_port。）"
  fi
  local dir; dir="$(nginx_conf_dir)"
  [ -n "$dir" ] || { mkdir -p /etc/nginx/conf.d; dir=/etc/nginx/conf.d; warn "没找到 nginx 的 conf.d / 宝塔 vhost 目录，已创建 /etc/nginx/conf.d；请确认 nginx.conf 里有 include /etc/nginx/conf.d/*.conf;"; }
  if ss -ltnpH "sport = :$TLS_PORT" 2>/dev/null | grep -v nginx | grep -q .; then
    warn "端口 $TLS_PORT 已被其它程序占用："; port_pids "$TLS_PORT" >&2
    die "请换一个 --tls-port，或先停掉占用它的程序（如果是旧的 Yumeiro，用 systemctl status yumeiro 看看）。"
  fi
  local cert="$TLS_CERT" key="$TLS_KEY" ip="$TLS_IP"
  if [ -z "$cert" ]; then
    mkdir -p "$CONF_DIR/tls"; cert="$CONF_DIR/tls/cert.pem"; key="$CONF_DIR/tls/key.pem"
    [ -n "$ip" ] || ip="$(public_ip)"; [ -n "$ip" ] || die "探测不到公网 IP，请加 --ip 你的公网IP"
    if [ ! -s "$cert" ] || ! openssl x509 -in "$cert" -noout -text 2>/dev/null | grep -q "IP Address:$ip"; then
      openssl req -x509 -newkey rsa:2048 -nodes -days 825 -keyout "$key" -out "$cert" -subj "/CN=$ip" -addext "subjectAltName=IP:$ip" 2>/dev/null || die "生成自签名证书失败"
      chmod 600 "$key"; ok "已生成自签名证书（IP $ip，825 天有效）：$cert"
    fi
  else
    [ -r "$cert" ] && [ -r "${key:-/nonexistent}" ] || die "--cert / --key 指向的文件读不到"
  fi
  cat > "$dir/yumeiro.conf" <<EOF
# 由 yumeiro-native.sh https 生成；再次执行会覆盖。
map \$http_upgrade \$yumeiro_conn { default upgrade; '' close; }
server {
    listen $TLS_PORT ssl;
    server_name _;
    ssl_certificate     $cert;
    ssl_certificate_key $key;
    ssl_protocols TLSv1.2 TLSv1.3;
    client_max_body_size 512m;   # 网页更新要上传整包（含客户端安装包约 200 MB），上限要比应用自己的 400 MB 大
    location / {
        proxy_pass http://127.0.0.1:$app_port;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$remote_addr;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection \$yumeiro_conn;
        proxy_buffering off;
        proxy_read_timeout 3600s;
    }
}
EOF
  nginx_reload || { rm -f "$dir/yumeiro.conf"; die "nginx 配置检查没通过，已撤销 yumeiro.conf。把上面的报错发给我们。"; }
  env_set HOST 127.0.0.1; env_set COOKIE_SECURE true; env_set TRUST_PROXY true
  systemctl restart yumeiro.service
  health 40 || die "应用重启后没有就绪：journalctl -u yumeiro -n 50"
  curl -fsSk -m 8 "https://127.0.0.1:$TLS_PORT/api/health" >/dev/null && ok "HTTPS 已就绪（nginx :$TLS_PORT → 127.0.0.1:$app_port）" || warn "本机访问 https://127.0.0.1:$TLS_PORT 失败：查看 nginx 错误日志（宝塔：/www/server/nginx/logs/error.log；标准：/var/log/nginx/error.log）"
  say ""
  say "访问地址：https://${ip:-你的域名或IP}:$TLS_PORT"
  say "  · 云服务器安全组 / 宝塔防火墙放行 TCP $TLS_PORT（$app_port 只在本机，不用放行）"
  [ -z "$TLS_CERT" ] && say "  · 自签名证书：浏览器第一次会提示“不安全”，点“高级 → 继续前往”；之前用 HTTP 登录的会话需要重新登录"
}

[ "$CMD" = migrate ] && { do_migrate; CMD=install; }
# 客户端安装包：放在数据目录的 downloads/（不随程序部署、不进每日备份）。上传 = 复制 + 删旧版本 + 重新生成 SHA256.txt
upload_clients() {
  local dir="$1"
  [ -d "$dir" ] || die "找不到文件夹：$dir"
  ls "$dir"/Yumeiro-* >/dev/null 2>&1 || die "$dir 里没有 Yumeiro-Setup-*.exe / Yumeiro-Portable-*.exe / Yumeiro-*.apk"
  [ -f "$APP_DIR/scripts/install-clients.mjs" ] || die "程序还没有安装（找不到 $APP_DIR/scripts/install-clients.mjs），请先 install"
  mkdir -p "$DATA_DIR/downloads"
  DATA_DIR="$DATA_DIR" "$(node_bin)" "$APP_DIR/scripts/install-clients.mjs" "$dir" --prune
  chown -R yumeiro:yumeiro "$DATA_DIR/downloads"; chmod 755 "$DATA_DIR/downloads"
  ok "客户端安装包已上传到 $DATA_DIR/downloads；网页里的“下载客户端”引导会自动出现按钮"
}
# install / update 之后：给了 --clients 就传；没给但解压目录里有 Yumeiro-Clients 文件夹也自动传；传失败不影响主流程
maybe_upload_clients() {
  local dir="$CLIENTS_DIR"; [ -z "$dir" ] && [ -d "$SRC/Yumeiro-Clients" ] && dir="$SRC/Yumeiro-Clients"
  [ -n "$dir" ] || return 0
  ( upload_clients "$dir" ) || warn "客户端安装包上传失败，可稍后手动执行：sudo $0 clients <文件夹>"
}
hint_clients() {
  ls "$DATA_DIR"/downloads/Yumeiro-* >/dev/null 2>&1 && return 0
  say "客户端安装包：目前还没有。网页里的“下载客户端”引导会显示“管理员还没有上传”。传法：sudo $0 clients <装有 Yumeiro-Setup-*.exe / Yumeiro-*.apk 的文件夹>（详见《客户端安装包上传说明.md》）"
}

# >>> cleanup_after
# 安装 / 升级成功之后自动清理“确定没用”的东西，每一项都会打印出来（--no-clean 可以关掉；手动执行：sudo bash deploy/yumeiro-native.sh clean）。
# 绝不会动：数据目录、配置与密钥、工作区文件、node_modules、最近 3 份升级前备份、每日自动备份、客户端安装包。
src_removable() {   # 解压目录能不能删：必须确实是一份 Yumeiro 程序目录，且不是正在使用的安装目录，也不包含任何数据 / 配置 / 备份目录
  local keep
  [ -n "$SRC" ] && [ "$SRC" != "/" ] && [ "$SRC" != "$APP_DIR" ] || return 1
  [ -f "$SRC/deploy/yumeiro-native.sh" ] && [ -f "$SRC/server.mjs" ] && [ -f "$SRC/package.json" ] || return 1
  for keep in "$APP_DIR" "$DATA_DIR" "$WORK_DIR" "$CONF_DIR" "$BACKUP_DIR" "${HOME:-/root}" "$PWD"; do
    [ -n "$keep" ] || continue
    case "$keep/" in "$SRC"/*) [ "$keep" = "$PWD" ] || return 1 ;; esac    # 当前所在目录在里面没关系（删之前会先 cd 出去）；其它目录在里面就不删
  done
  return 0
}
cleanup_after() {
  [ "$NO_CLEAN" = 1 ] && return 0
  local f n bytes=0 size
  say ""; say "自动清理无用文件："
  # 1) 升级前备份：每次升级都会生成一份完整备份，很占磁盘，只留最近 3 份
  n=0
  for f in $(ls -1t "$BACKUP_DIR"/pre-update-*.tar.gz 2>/dev/null | tail -n +4 || true); do
    size=$(stat -c %s "$f" 2>/dev/null || echo 0); rm -f "$f" && { n=$((n + 1)); bytes=$((bytes + size)); }
  done
  [ "$n" -gt 0 ] && say "  · 旧的升级前备份：删除 $n 份（保留最近 3 份）"
  # 2) 程序目录根目录里新版本已经不再带的旧模块（只看 *.mjs；node_modules、数据、配置不动）
  n=0
  for f in "$APP_DIR"/*.mjs; do
    [ -f "$f" ] || continue
    [ -f "$SRC/$(basename "$f")" ] && continue
    size=$(stat -c %s "$f" 2>/dev/null || echo 0); rm -f "$f" && { n=$((n + 1)); bytes=$((bytes + size)); say "  · 旧版本留下的模块：$(basename "$f")"; }
  done
  # 3) npm 缓存（装依赖时留下的下载缓存，随时可以重新下载）
  if [ "$CLEAN_NPM_CACHE" = 1 ] && command -v npm >/dev/null 2>&1; then
    local cache; cache="$(npm config get cache 2>/dev/null || true)"
    if [ -d "$cache" ]; then
      size=$(du -sk "$cache" 2>/dev/null | cut -f1 || echo 0); bytes=$((bytes + size * 1024))
      npm cache clean --force >/dev/null 2>&1 && say "  · npm 缓存：已清理（约 $((size / 1024)) MB）"
    fi
  fi
  # 4) 解压出来的新版本目录（程序已经复制到 $APP_DIR，留着没用）。压缩包本身不动，请自己决定要不要删
  if src_removable; then
    size=$(du -sk "$SRC" 2>/dev/null | cut -f1 || echo 0); bytes=$((bytes + size * 1024))
    local parent; parent="$(dirname "$SRC")"
    cd /
    rm -rf "$SRC" && say "  · 解压目录：已删除 $SRC（约 $((size / 1024)) MB）"
    case "$parent" in /|/root|/home|/tmp|/var/tmp|"${HOME:-/root}") ;; *) rmdir "$parent" 2>/dev/null && say "  · 空文件夹：已删除 $parent" || true ;; esac
  else
    [ "$SRC" != "$APP_DIR" ] && say "  · 解压目录 $SRC 没有自动删除（它里面或旁边有别的重要目录），确认没用后可以自己删"
  fi
  ok "清理完成，共释放约 $((bytes / 1048576)) MB"
}
# <<< cleanup_after

case "$CMD" in
install)
  check_node
  preflight
  getent group yumeiro >/dev/null || groupadd --system yumeiro
  id yumeiro >/dev/null 2>&1 || useradd --system --gid yumeiro --home-dir "$DATA_DIR" --shell /usr/sbin/nologin yumeiro
  mkdir -p "$DATA_DIR" "$DATA_DIR/downloads" "$SECRETS_DIR" "$BACKUP_DIR"
  chown yumeiro:yumeiro "$DATA_DIR"; chmod 700 "$DATA_DIR"
  chown root:yumeiro "$CONF_DIR" "$SECRETS_DIR"; chmod 750 "$SECRETS_DIR"
  chmod 751 "$CONF_DIR"   # 运行器用户要穿过 /etc/yumeiro 才能读到 runner/runner_token；只给“进入”权限（不能列目录），secrets 目录仍是 750，运行器读不到数据库密钥和模型 Key

  gen() { # gen 文件名 命令...：不存在才生成，已有的绝不覆盖（加密密钥丢了数据就解不开）
    local f="$SECRETS_DIR/$1"; shift
    [ -s "$f" ] || { umask 077; "$@" > "$f"; }
    chown root:yumeiro "$f"; chmod 640 "$f"
  }
  gen store_encryption_key openssl rand -base64 32
  if [ "$WEB_SETUP" = 1 ] && [ ! -s "$SECRETS_DIR/setup_token" ] && [ ! -s "$DATA_DIR/.initialized" ]; then
    ( umask 077; openssl rand -base64 48 | tr -d '/+=' | cut -c1-64 > "$SECRETS_DIR/setup_token" )
    chown root:yumeiro "$SECRETS_DIR/setup_token"; chmod 640 "$SECRETS_DIR/setup_token"
  fi
  if [ "$WEB_SETUP" = 1 ] && [ ! -s "$SECRETS_DIR/setup_helper_token" ]; then
    ( umask 077; openssl rand -hex 32 > "$SECRETS_DIR/setup_helper_token" )
    chown root:yumeiro "$SECRETS_DIR/setup_helper_token"; chmod 640 "$SECRETS_DIR/setup_helper_token"
  fi
  if [ "$WEB_SETUP" != 1 ]; then
    GENERATED=""
    if [ ! -s "$SECRETS_DIR/admin_password" ] && [ ! -s "$DATA_DIR/.initialized" ]; then
      ( umask 077; openssl rand -base64 18 | tr -d '/+=' | cut -c1-20 > "$SECRETS_DIR/admin_password" ); GENERATED="$(cat "$SECRETS_DIR/admin_password")"
      # 管理员密码需要 ≥16 位，不足时补长
      while [ "${#GENERATED}" -lt 16 ]; do GENERATED="${GENERATED}$(openssl rand -hex 4)"; done; printf '%s' "$GENERATED" > "$SECRETS_DIR/admin_password"
      chown root:yumeiro "$SECRETS_DIR/admin_password"; chmod 640 "$SECRETS_DIR/admin_password"
    fi
  fi

  [ -n "$MODEL_KEY" ] && { [ -s "$SECRETS_DIR/model_api_key" ] || { umask 077; printf '%s' "$MODEL_KEY" > "$SECRETS_DIR/model_api_key"; }; chown root:yumeiro "$SECRETS_DIR/model_api_key"; chmod 640 "$SECRETS_DIR/model_api_key"; }

  if [ ! -f "$ENV_FILE" ]; then
    bind=0.0.0.0; secure=false; proxy=false
    if [ -n "$DOMAIN" ]; then bind=127.0.0.1; secure=true; proxy=true; fi
    { echo "# 由 yumeiro-native.sh 生成；修改后执行 systemctl restart yumeiro"
      echo "PORT=$PORT"; echo "HOST=$bind"; echo "DATA_DIR=$DATA_DIR"
      echo "COOKIE_SECURE=$secure"; echo "TRUST_PROXY=$proxy"
      echo "STORE_ENCRYPTION_KEY_FILE=$SECRETS_DIR/store_encryption_key"
      echo "SERVICE_UPDATE_URL=https://api.github.com/repos/yumeiro-ai/yumeiro/releases/latest"
      if [ "$WEB_SETUP" = 1 ]; then
        echo "SETUP_TOKEN_FILE=$SECRETS_DIR/setup_token"
        echo "SETUP_HELPER_TOKEN_FILE=$SECRETS_DIR/setup_helper_token"
        echo "SETUP_HELPER_SOCKET=/run/yumeiro/setup-helper.sock"
      else
        echo "ADMIN_EMAIL=$ADMIN_EMAIL"; echo "ADMIN_PASSWORD_FILE=$SECRETS_DIR/admin_password"
      fi
      [ "$PERSONAL" = 1 ] && echo "YUMEIRO_USAGE=personal"
      if [ -n "$PG_URL" ]; then echo "STORAGE=postgres"; echo "DATABASE_URL=$PG_URL"; else echo "STORAGE=json"; fi
      [ -n "$MODEL_URL" ] && echo "MODEL_BASE_URL=$MODEL_URL"
      [ -n "$MODEL_NAME" ] && echo "MODEL_NAME=$MODEL_NAME"
      [ -s "$SECRETS_DIR/model_api_key" ] && echo "MODEL_API_KEY_FILE=$SECRETS_DIR/model_api_key"
    } > "$ENV_FILE"
    chown root:yumeiro "$ENV_FILE"; chmod 640 "$ENV_FILE"
  else
    warn "已存在 $ENV_FILE，保持不变（要改配置请直接编辑它）"
  fi

  if [ "$WITH_RUNNER" = 1 ]; then
    getent group yumeiro-runner >/dev/null || groupadd --system yumeiro-runner
    id yumeiro-runner >/dev/null 2>&1 || useradd --system --gid yumeiro-runner --home-dir "$WORK_DIR" --shell /usr/sbin/nologin yumeiro-runner
    usermod -aG yumeiro-runner yumeiro   # 应用要能读运行器令牌
    mkdir -p "$RUNNER_SECRET_DIR" "$WORK_DIR"
    chown root:yumeiro-runner "$RUNNER_SECRET_DIR"; chmod 750 "$RUNNER_SECRET_DIR"
    chown yumeiro-runner:yumeiro-runner "$WORK_DIR"; chmod 700 "$WORK_DIR"
    [ -s "$RUNNER_SECRET_DIR/runner_token" ] || ( umask 077; openssl rand -hex 24 > "$RUNNER_SECRET_DIR/runner_token" )
    chown root:yumeiro-runner "$RUNNER_SECRET_DIR/runner_token"; chmod 640 "$RUNNER_SECRET_DIR/runner_token"
    grep -q '^RUNNER_URL=' "$ENV_FILE" || { echo "RUNNER_URL=http://127.0.0.1:8790" >> "$ENV_FILE"; echo "RUNNER_TOKEN_FILE=$RUNNER_SECRET_DIR/runner_token" >> "$ENV_FILE"; }
  fi

  if [ "$WITH_RUNNER" = 1 ] && [ "$NO_ENGINES" != 1 ]; then install_engines || warn "有引擎没装上，稍后可执行：sudo $0 engines"; fi
  write_units
  systemctl enable --now yumeiro.service yumeiro-backup.timer >/dev/null
  [ "$WEB_SETUP" = 1 ] && systemctl enable --now yumeiro-setup-helper.service >/dev/null
  [ "$WITH_RUNNER" = 1 ] && systemctl enable --now yumeiro-runner.service >/dev/null
  touch "$DATA_DIR/.initialized"; chown yumeiro:yumeiro "$DATA_DIR/.initialized"
  health 40 && ok "Yumeiro 已启动" || { warn "服务没有在 40 秒内就绪，查看日志：journalctl -u yumeiro -n 50"; exit 1; }
  maybe_upload_clients
  if [ -n "$TLS_PORT" ]; then ( setup_https ) || warn "HTTPS 配置没有完成，可稍后执行：sudo $0 https --tls-port $TLS_PORT"; fi

  port="$(grep -E '^PORT=' "$ENV_FILE" | cut -d= -f2)"
  say ""
  if [ "$WEB_SETUP" = 1 ] && [ -s "$SECRETS_DIR/setup_token" ]; then
    SETUP_TOKEN="$(cat "$SECRETS_DIR/setup_token")"
    if [ -n "$DOMAIN" ]; then say "首次安装向导：请打开 https://$DOMAIN/setup#token=$SETUP_TOKEN"; else say "首次安装向导：请打开 http://$(public_ip || echo 服务器IP):$PORT/setup#token=$SETUP_TOKEN（生产环境请先配置 HTTPS）"; fi
    unset SETUP_TOKEN
  fi
  if [ -n "$TLS_PORT" ]; then :
  elif [ -n "$DOMAIN" ]; then
    say "访问方式：在前面的反向代理里把 https://$DOMAIN 转发到 127.0.0.1:$port。Caddy 示例："
    say ""; say "    $DOMAIN {"; say "        reverse_proxy 127.0.0.1:$port"; say "    }"
  else
    warn "目前是 HTTP 直连 http://服务器IP:$port，登录信息不加密。一条命令开 HTTPS：sudo $0 https --tls-port 3005（自签名证书；有域名证书加 --cert/--key）"
  fi
  say ""
  [ -z "$TLS_PORT" ] && [ -z "$DOMAIN" ] && say "访问地址：http://$(public_ip || echo 服务器IP):$port   （云服务器记得在安全组放行 TCP $port）"
  say "管理员邮箱：$(grep -E '^ADMIN_EMAIL=' "$ENV_FILE" | cut -d= -f2)"
  [ -n "$GENERATED" ] && say "管理员初始密码：$GENERATED   （请登录后立刻修改，再执行 $0 scrub-admin）"
  say "每日 03:30 自动备份到 $BACKUP_DIR；手动备份：$0 backup"
  say "日志：journalctl -u yumeiro -f"
  hint_clients
  cleanup_after
  ;;

update)
  check_node
  [ -d "$APP_DIR" ] || die "还没有安装，请先执行 install"
  do_backup_pre() { BACKUP_KEEP=999; local stamp; stamp="$(date +%Y%m%d-%H%M%S)"; mkdir -p "$BACKUP_DIR"
    local items=("$DATA_DIR" "$CONF_DIR" "$APP_DIR"); [ -d "$WORK_DIR" ] && items+=("$WORK_DIR")
    tar -czf "$BACKUP_DIR/pre-update-$stamp.tar.gz" --warning=no-file-changed "${items[@]}" 2>/dev/null || [ $? -eq 1 ] || die "升级前备份失败，已取消升级"
    chmod 600 "$BACKUP_DIR/pre-update-$stamp.tar.gz"; echo "$BACKUP_DIR/pre-update-$stamp.tar.gz"; }
  PRE="$(do_backup_pre)"; ok "升级前已备份：$PRE"
  systemctl stop yumeiro.service; systemctl is-active --quiet yumeiro-runner.service && systemctl stop yumeiro-runner.service || true
  [ -f /etc/systemd/system/yumeiro-runner.service ] && WITH_RUNNER=1
  OLD_LOCK="$(sha256sum "$APP_DIR/package-lock.json" 2>/dev/null | cut -d' ' -f1 || true)"
  sync_code
  [ "$OLD_LOCK" = "$(sha256sum "$APP_DIR/package-lock.json" | cut -d' ' -f1)" ] && [ -d "$APP_DIR/node_modules" ] || npm_install || { [ -d "$APP_DIR/node_modules" ] && warn "新依赖没有装上（多半是服务器连不上 npm 源），先沿用旧依赖继续升级；只影响用到新依赖的功能（如 AI 邮箱）。稍后可加 --npm-registry https://registry.npmmirror.com 重新执行 update" || die "npm 依赖安装失败。国内服务器可加 --npm-registry https://registry.npmmirror.com"; }
  if [ "$WITH_RUNNER" = 1 ] && [ "$NO_ENGINES" != 1 ]; then install_engines || warn "引擎升级没有全部成功，不影响服务；稍后可执行：sudo $0 engines"; fi
  # 旧版本装的服务器没有“网页更新助手”：补上令牌和环境变量，并把它启动起来，之后管理员就能在网页里上传压缩包更新（不用再敲命令）
  if [ "$WEB_SETUP" = 1 ]; then
    if [ ! -s "$SECRETS_DIR/setup_helper_token" ]; then
      ( umask 077; openssl rand -hex 32 > "$SECRETS_DIR/setup_helper_token" )
      chown root:yumeiro "$SECRETS_DIR/setup_helper_token"; chmod 640 "$SECRETS_DIR/setup_helper_token"
    fi
    grep -q '^SETUP_HELPER_TOKEN_FILE=' "$ENV_FILE" || echo "SETUP_HELPER_TOKEN_FILE=$SECRETS_DIR/setup_helper_token" >> "$ENV_FILE"
    grep -q '^SETUP_HELPER_SOCKET=' "$ENV_FILE" || echo "SETUP_HELPER_SOCKET=/run/yumeiro/setup-helper.sock" >> "$ENV_FILE"
  fi
  write_units
  # 注意：网页更新就是这个助手拉起来的，这里绝对不能直接重启它——重启会把正在运行的这个升级脚本一起杀掉，主服务就停在“已停止”再也起不来（502）。
  # 所以这里只“启用并确保在运行”（已经在运行就什么都不做）；换成新代码的重启放到升级成功之后，用 systemd-run 在脚本之外延迟执行。
  if [ "$WEB_SETUP" = 1 ]; then
    systemctl enable --now yumeiro-setup-helper.service >/dev/null 2>&1 || warn "网页更新助手没有启动成功（不影响使用，命令行更新照常）：journalctl -u yumeiro-setup-helper -n 30"
  fi
  systemctl start yumeiro.service; [ "$WITH_RUNNER" = 1 ] && systemctl start yumeiro-runner.service
  if health 60; then ok "升级完成（版本 $(node -p "require('$APP_DIR/package.json').version")）。需要回退时备份在 $PRE"
    maybe_upload_clients; hint_clients
    # 升级成功后，让网页更新助手也换成新代码：用 systemd-run 在这个脚本之外、15 秒后再重启（不会杀掉自己）
    [ "$WEB_SETUP" = 1 ] && command -v systemd-run >/dev/null 2>&1 && systemd-run --quiet --on-active=15 --unit="yumeiro-helper-reload-$(date +%s)" systemctl restart yumeiro-setup-helper.service >/dev/null 2>&1 || true
    cleanup_after
  else
    warn "新版本没有起来，正在回滚…"
    systemctl stop yumeiro.service || true
    tar -xzf "$PRE" -C / ; systemctl daemon-reload; systemctl start yumeiro.service
    [ "$WITH_RUNNER" = 1 ] && systemctl start yumeiro-runner.service || true
    health 40 && warn "已回滚到旧版本。失败日志：journalctl -u yumeiro -n 80" || warn "回滚后仍未就绪，请手动处理：journalctl -u yumeiro -n 80"
    exit 1
  fi
  ;;

engines)
  check_node; install_engines || warn "有引擎没装上，见上面的提示"
  if systemctl is-enabled --quiet yumeiro-runner.service 2>/dev/null; then
    sed -i "s#^Environment=PATH=.*#Environment=PATH=$ENGINES_PREFIX/bin:$(dirname "$(command -v node)"):/usr/local/bin:/usr/bin:/bin#" /etc/systemd/system/yumeiro-runner.service
    systemctl daemon-reload; systemctl restart yumeiro-runner.service; ok "运行器已重启，管理设置→智能体引擎里能看到版本"
  else warn "还没有安装运行器：先执行 sudo $0 install --with-runner"; fi
  ;;

clients)
  [ -n "$CLIENTS_DIR" ] || die "用法：sudo $0 clients <存放安装包的文件夹>"
  check_node; upload_clients "$CLIENTS_DIR"
  ;;

backup) do_backup ;;

clean) cleanup_after ;;

https)
  check_node; setup_https
  ;;

status)
  systemctl --no-pager --lines=0 status yumeiro.service || true
  [ -f /etc/systemd/system/yumeiro-runner.service ] && systemctl --no-pager --lines=0 status yumeiro-runner.service || true
  health 3 && ok "健康检查通过" || warn "健康检查失败"
  ls -1t "$BACKUP_DIR" 2>/dev/null | head -5 | sed 's/^/备份：/'
  ;;

scrub-admin)
  [ -f "$SECRETS_DIR/admin_password" ] || die "没有找到管理员初始密码文件（可能已清理）"
  shred -u "$SECRETS_DIR/admin_password" 2>/dev/null || rm -f "$SECRETS_DIR/admin_password"
  sed -i '/^ADMIN_PASSWORD_FILE=/d' "$ENV_FILE"
  systemctl restart yumeiro.service; ok "已清除管理员初始密码文件；之后用你修改后的密码登录"
  ;;

uninstall)
  read -r -p "卸载 Yumeiro 服务与程序？数据（$DATA_DIR、$WORK_DIR）和备份会保留。输入 yes 继续：" answer
  [ "$answer" = yes ] || die "已取消"
  systemctl disable --now yumeiro.service yumeiro-runner.service yumeiro-backup.timer 2>/dev/null || true
  rm -f /etc/systemd/system/yumeiro.service /etc/systemd/system/yumeiro-runner.service /etc/systemd/system/yumeiro-backup.service /etc/systemd/system/yumeiro-backup.timer
  systemctl daemon-reload; rm -rf "$APP_DIR"
  for d in /www/server/panel/vhost/nginx /etc/nginx/conf.d; do [ -f "$d/yumeiro.conf" ] && { rm -f "$d/yumeiro.conf"; nginx_reload >/dev/null 2>&1 || true; say "已移除 nginx 配置 $d/yumeiro.conf"; }; done
  ok "已卸载。配置在 $CONF_DIR（含加密密钥，务必保留，否则数据无法解密）；数据在 $DATA_DIR。"
  ;;

*) sed -n '2,20p' "$0"; exit 2 ;;
esac
