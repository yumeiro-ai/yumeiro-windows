#!/usr/bin/env bash
# Yumeiro 私有工作空间 · 首次安装向导
#   ./install.sh                 交互式安装（访问方式、端口、数据库、管理员账号密码、模型）
#   ./install.sh --reconfigure   重新配置（会备份现有 .env；不会改动已有的加密密钥和数据库密码）
#   ./install.sh scrub-admin     首次登录成功后，清空服务器上保存的管理员初始密码文件
#   ./install.sh --no-start      只生成配置，不启动容器
#   ./install.sh enable-updater  启用“网页更新”：管理员在网页上传官方签名的发布包即可更新（只需运行一次；disable-updater 关闭）
#   ./install.sh clients <文件夹>  把客户端安装包（Yumeiro-Setup-*.exe / Yumeiro-Portable-*.exe / Yumeiro-*.apk）传进数据卷，网页的“下载客户端”引导就会出现按钮
#   ./install.sh --clients=<文件夹>  安装完成、服务启动后顺便上传安装包（也可用环境变量 YUMEIRO_CLIENTS）
# 非交互：设置 YUMEIRO_NONINTERACTIVE=1 并用 YUMEIRO_* 环境变量提供各项（见 README“无人值守安装”）。
set -euo pipefail
cd "$(dirname "$0")"
umask 077

RECONFIGURE=0; NO_START=0; CMD=""; CLIENTS_DIR="${YUMEIRO_CLIENTS:-}"
for arg in "$@"; do
  case "$arg" in
    --reconfigure) RECONFIGURE=1 ;;
    --no-start) NO_START=1 ;;
    scrub-admin) CMD=scrub-admin ;;
    enable-updater) CMD=enable-updater ;;
    disable-updater) CMD=disable-updater ;;
    clients) CMD=clients ;;
    --clients=*) CLIENTS_DIR="${arg#--clients=}" ;;
    -h|--help) sed -n '2,9p' "$0"; exit 0 ;;
    *) if [ "$CMD" = clients ] && [ -z "$CLIENTS_DIR" ]; then CLIENTS_DIR="$arg"; else echo "未知参数：$arg" >&2; exit 2; fi ;;
  esac
done
NONINTERACTIVE="${YUMEIRO_NONINTERACTIVE:-0}"

say()  { printf '%s\n' "$*"; }
warn() { printf '\033[33m! %s\033[0m\n' "$*" >&2; }
die()  { printf '\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }
ok()   { printf '\033[32m✓ %s\033[0m\n' "$*"; }

# ask VAR "提示" "默认值" [YUMEIRO_环境变量名]：交互输入；非交互时读环境变量，缺省用默认值
ask() {
  local var="$1" prompt="$2" default="${3:-}" envname="${4:-}" value=""
  if [ "$NONINTERACTIVE" = 1 ]; then
    [ -n "$envname" ] && value="${!envname:-}"
    printf -v "$var" '%s' "${value:-$default}"; return
  fi
  read -r -p "$prompt${default:+ [$default]}: " value || true
  printf -v "$var" '%s' "${value:-$default}"
}
# ask_secret VAR "提示" [环境变量名]：隐藏输入
ask_secret() {
  local var="$1" prompt="$2" envname="${3:-}" value=""
  if [ "$NONINTERACTIVE" = 1 ]; then
    [ -n "$envname" ] && value="${!envname:-}"
    printf -v "$var" '%s' "$value"; return
  fi
  read -r -s -p "$prompt: " value || true; echo
  printf -v "$var" '%s' "$value"
}
random_b64()  { if command -v openssl >/dev/null 2>&1; then openssl rand -base64 "$1" | tr -d '\n'; else head -c "$1" /dev/urandom | base64 | tr -d '\n'; fi; }
random_pass() { # 注意：不能写成 tr </dev/urandom | head，pipefail 下 tr 收到 SIGPIPE 会让脚本退出
  local out; out="$(head -c 4096 /dev/urandom | LC_ALL=C tr -dc 'A-Za-z0-9')"; printf '%s' "${out:0:$1}"
}

dc() { if docker compose version >/dev/null 2>&1; then docker compose "$@"; else docker-compose "$@"; fi; }

# 把 secrets 文件设为容器内 node 用户(UID 1000)可读，同时不让其他本机用户读取
protect_secret() {
  # 各容器用不同的 UID（应用 1000、运行器 10001、PostgreSQL 70/999），所以文件要让所有人可读；
  # 保护来自 secrets/ 目录本身是 700（只有安装用户能进入），容器通过单文件挂载读取。
  chmod 644 "$1"
}
write_secret() { # write_secret 文件 内容
  printf '%s' "$2" > "$1"; protect_secret "$1"
}

# 把一个文件夹里的客户端安装包传进运行中的 yumeiro 容器的数据卷（/app/data/downloads），不打进镜像
upload_clients() {
  local dir="$1" tmp="/tmp/yumeiro-clients-$$"
  [ -d "$dir" ] || die "找不到文件夹：$dir"
  ls "$dir"/Yumeiro-* >/dev/null 2>&1 || die "$dir 里没有 Yumeiro-Setup-*.exe / Yumeiro-Portable-*.exe / Yumeiro-*.apk"
  dc ps --format '{{.Service}}' 2>/dev/null | grep -qx yumeiro || die "yumeiro 容器没有在运行，请先 docker compose up -d"
  dc exec -T yumeiro sh -c "rm -rf $tmp && mkdir -p $tmp"
  for f in "$dir"/Yumeiro-*; do dc cp "$f" "yumeiro:$tmp/$(basename "$f")"; done
  dc exec -T yumeiro sh -c "node scripts/install-clients.mjs $tmp --prune; rm -rf $tmp"
  ok "客户端安装包已上传；网页里的“下载客户端”引导会自动出现按钮"
}
if [ "$CMD" = clients ]; then
  [ -n "$CLIENTS_DIR" ] || die "用法：./install.sh clients <存放安装包的文件夹>"
  upload_clients "$CLIENTS_DIR"; exit 0
fi

# ---------- enable-updater / disable-updater ----------
set_env_var() { # set_env_var 名称 值：已有就替换，没有就追加
  if grep -q "^$1=" .env; then sed -i "s|^$1=.*|$1=$2|" .env; else printf '%s=%s\n' "$1" "$2" >> .env; fi
}
if [ "$CMD" = enable-updater ] || [ "$CMD" = disable-updater ]; then
  [ -f .env ] || die "还没有安装（找不到 .env），请先运行 ./install.sh"
  command -v docker >/dev/null 2>&1 && dc version >/dev/null 2>&1 || die "没有找到 docker compose"
  cur="$(grep '^COMPOSE_FILE=' .env | head -1 | cut -d= -f2-)"; [ -n "$cur" ] || cur="docker-compose.yml"
  if [ "$CMD" = disable-updater ]; then
    set_env_var COMPOSE_FILE "$(printf '%s' "$cur" | tr ':' '\n' | grep -vx 'docker-compose.updater.yml' | paste -sd: -)"
    dc up -d --remove-orphans; ok "已关闭网页更新（updater 容器已移除；secrets/updater_token 保留，重新启用时沿用）"; exit 0
  fi
  here="$(pwd)"; case "$here" in *[[:space:]:]*) die "安装目录路径里不能有空格或冒号：$here" ;; esac
  say "启用网页更新会多运行一个 updater 容器，它能访问宿主机的 docker.sock（相当于宿主机 root 权限）。"
  say "  · 它不对外开放端口，只有 yumeiro 容器能凭令牌访问；"
  say "  · 它只接受带官方签名、且和签名清单逐个一致的发布包；"
  say "  · 更新前会备份程序文件和数据到 ./backups/，新版本没起来会自动回滚程序文件。"
  ask GO "确认启用？(y/N)" "n" YUMEIRO_UPDATER
  [[ "$GO" =~ ^[Yy] ]] || { say "已取消"; exit 0; }
  [ -s secrets/updater_token ] || { mkdir -p secrets; chmod 700 secrets; write_secret secrets/updater_token "$(random_pass 48)"; }
  set_env_var UPDATER_PROJECT_DIR "$here"
  case ":$cur:" in *:docker-compose.updater.yml:*) ;; *) set_env_var COMPOSE_FILE "$cur:docker-compose.updater.yml" ;; esac
  dc up -d --build
  ok "网页更新已启用：管理设置 → 服务更新 里上传官方发布包即可（Yumeiro-x.y.z.zip）"; exit 0
fi

# ---------- scrub-admin ----------
if [ "$CMD" = scrub-admin ]; then
  [ -f secrets/admin_password ] || die "没有找到 secrets/admin_password"
  : > secrets/admin_password
  ok "已清空 secrets/admin_password。管理员账号已经在数据库里；之后请只在网页里修改密码。"
  exit 0
fi

# ---------- 预检 ----------
say "== Yumeiro 私有工作空间 · 安装向导 =="
command -v docker >/dev/null 2>&1 || die "没有找到 docker。请先安装 Docker Engine 和 Compose 插件（华为云：https://support.huaweicloud.com 搜索“安装 Docker”）。"
dc version >/dev/null 2>&1 || die "没有找到 docker compose，请安装 Docker Compose 插件。"

if [ -f .env ] && [ "$RECONFIGURE" = 0 ]; then
  die ".env 已存在，说明已经安装过。要重新配置请运行 ./install.sh --reconfigure；要启动/更新请运行 docker compose up -d --build。"
fi
mkdir -p secrets; chmod 700 secrets

# ---------- 1. 访问方式与端口 ----------
say
say "1/6 访问方式"
say "  1) 域名 + 自动 HTTPS（Caddy，占用 80/443。国内服务器的域名需已完成 ICP 备案）"
say "  2) IP:端口，HTTP 直连（自选端口。数据不加密传输，仅建议内网/测试）"
say "  3) 自选端口，前面已有 HTTPS（华为云 ELB / WAF / Nginx 等负责 HTTPS）"
ask MODE "请选择" "1" YUMEIRO_MODE
case "$MODE" in 1|2|3) ;; *) die "访问方式只能是 1、2 或 3" ;; esac
say "使用方式：1) 团队使用  2) 个人使用（隐藏成员/邀请等团队功能，以后可在站点设置里切换）"
ask USAGE "请选择" "1" YUMEIRO_USAGE
case "$USAGE" in 1|2) ;; *) die "使用方式只能是 1 或 2" ;; esac

DOMAIN=""; APP_PORT=8787; APP_BIND="0.0.0.0"; COOKIE_SECURE=true; TRUST_PROXY=true; PROFILE_FILES="docker-compose.yml"
port_in_use() {
  if command -v ss >/dev/null 2>&1; then ss -ltn 2>/dev/null | awk '{print $4}' | grep -Eq "[:.]$1\$"
  elif command -v lsof >/dev/null 2>&1; then lsof -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1
  else return 1; fi
}
if [ "$MODE" = 1 ]; then
  ask DOMAIN "域名（已解析到本机公网 IP）" "" YUMEIRO_DOMAIN
  [[ "$DOMAIN" =~ ^([A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?\.)+[A-Za-z]{2,}$ ]] || die "域名格式不正确：$DOMAIN"
  APP_BIND="127.0.0.1"; PROFILE_FILES="docker-compose.yml:docker-compose.caddy.yml"
  for p in 80 443; do port_in_use "$p" && warn "本机 $p 端口已被占用，Caddy 可能无法启动。"; done
  ask APP_PORT "应用内部端口（只监听 127.0.0.1，供本机调试；一般不用改）" "8787" YUMEIRO_PORT
else
  ask APP_PORT "对外监听端口（1-65535）" "8787" YUMEIRO_PORT
  [ "$MODE" = 2 ] && { COOKIE_SECURE=false; TRUST_PROXY=false; warn "HTTP 直连：登录密码会以明文经过网络。公网使用请选 1 或 3。"; }
  [ "$MODE" = 3 ] && say "提示：ELB/反向代理需把真实客户端 IP 放进 X-Forwarded-For，并保证后端端口只允许它访问。"
fi
[[ "$APP_PORT" =~ ^[0-9]+$ ]] && [ "$APP_PORT" -ge 1 ] && [ "$APP_PORT" -le 65535 ] || die "端口必须是 1-65535 的整数：$APP_PORT"
[ "$APP_PORT" -lt 1024 ] && warn "端口 $APP_PORT 小于 1024，Docker 一般可以绑定，但请确认没有冲突。"
port_in_use "$APP_PORT" && warn "本机 $APP_PORT 端口已被占用，请换一个，或确认占用者可以停止。"
[ "$MODE" != 1 ] && say "→ 请在华为云“安全组”入方向规则中放行 TCP $APP_PORT（来源按需限制）。"
[ "$MODE" = 1 ] && say "→ 请在华为云“安全组”入方向规则中放行 TCP 80、443。"

# ---------- 2. 数据库 ----------
say
say "2/6 数据库"
say "  1) 内置 PostgreSQL 容器（推荐，数据在 Docker 卷 pg_data）"
say "  2) 外部 PostgreSQL（如华为云 RDS for PostgreSQL）"
say "  3) 只用 JSON 文件（不建议，仅限个人试用）"
ask DBMODE "请选择" "1" YUMEIRO_DB
STORAGE=postgres; PGHOST=postgres; PGPORT=5432; PGUSER=yumeiro; PGDATABASE=yumeiro; PGSSLMODE=""; DBPASS=""
case "$DBMODE" in
  1) PROFILE_FILES="$PROFILE_FILES:docker-compose.db.yml" ;;
  2)
    ask PGHOST "数据库地址（内网地址）" "" YUMEIRO_PGHOST; [ -n "$PGHOST" ] || die "必须填写数据库地址"
    ask PGPORT "端口" "5432" YUMEIRO_PGPORT
    ask PGUSER "用户名" "yumeiro" YUMEIRO_PGUSER
    ask PGDATABASE "数据库名（需已创建）" "yumeiro" YUMEIRO_PGDATABASE
    ask_secret DBPASS "数据库密码" YUMEIRO_PGPASSWORD; [ -n "$DBPASS" ] || die "必须填写数据库密码"
    ask SSL "使用 SSL 连接？(y/N)" "n" YUMEIRO_PGSSL
    [[ "$SSL" =~ ^[Yy] ]] && PGSSLMODE=require ;;
  3) STORAGE=json; warn "JSON 文件存储只适合单人少量使用。" ;;
  *) die "数据库选项只能是 1、2 或 3" ;;
esac

# ---------- 3. 管理员账号 ----------
say
say "3/6 管理员（主账号）。成员账号之后在网页里添加。"
ask ADMIN_EMAIL "管理员邮箱" "" YUMEIRO_ADMIN_EMAIL
[[ "$ADMIN_EMAIL" =~ ^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$ ]] || die "邮箱格式不正确：$ADMIN_EMAIL"
ADMIN_EMAIL="$(printf '%s' "$ADMIN_EMAIL" | tr '[:upper:]' '[:lower:]')"
GENERATED_PASS=""
if [ "$NONINTERACTIVE" = 1 ]; then
  ADMIN_PASS="${YUMEIRO_ADMIN_PASSWORD:-}"
else
  say "管理员密码至少 16 个字符。直接回车 = 自动生成一个强密码（只显示一次）。"
  ask_secret ADMIN_PASS "管理员密码"
  if [ -z "$ADMIN_PASS" ]; then ADMIN_PASS="$(random_pass 24)"; GENERATED_PASS=1
  else ask_secret CONFIRM "再输入一次确认"; [ "$ADMIN_PASS" = "$CONFIRM" ] || die "两次输入的密码不一致"; fi
fi
[ -n "$ADMIN_PASS" ] || die "非交互模式需要设置 YUMEIRO_ADMIN_PASSWORD"
[ "${#ADMIN_PASS}" -ge 16 ] || die "管理员密码至少需要 16 个字符"
case "$ADMIN_PASS" in change*|replace*|your-*) die "请不要使用示例密码" ;; esac

# ---------- 4. 模型服务 ----------
say
say "4/6 模型服务（兼容 OpenAI Chat Completions；可直接回车跳过，之后再配置）"
ask MODEL_BASE_URL "MODEL_BASE_URL（必须 https，如 https://api.example.com/v1）" "" YUMEIRO_MODEL_BASE_URL
MODEL_NAME=""; MODEL_KEY=""
if [ -n "$MODEL_BASE_URL" ]; then
  [[ "$MODEL_BASE_URL" =~ ^https:// ]] || die "MODEL_BASE_URL 必须以 https:// 开头"
  ask MODEL_NAME "模型名称" "" YUMEIRO_MODEL_NAME; [ -n "$MODEL_NAME" ] || die "请填写模型名称"
  ask_secret MODEL_KEY "模型 API Key（输入不回显）" YUMEIRO_MODEL_API_KEY; [ -n "$MODEL_KEY" ] || die "请填写 API Key，或回车跳过整个模型配置"
else
  warn "已跳过模型配置：登录后聊天会提示“模型服务尚未配置”。之后编辑 .env 和 secrets/model_api_key，再运行 docker compose up -d。"
fi

# ---------- 5. 智能体运行器 ----------
say
say "5/6 智能体运行器（可选）：让团队直接使用 Claude Code / Codex / Pi，并启用工作区文件与多智能体协作"
say "  运行在隔离容器里（非 root、无额外权限、限制内存/CPU），只能读写各工作区的目录，不开放任意命令。"
say "  首次构建会下载这三个命令行工具，约需 1.5GB 磁盘；之后可用 ./install.sh --reconfigure 再添加。"
ask RUNNER "安装智能体运行器？(y/N)" "n" YUMEIRO_RUNNER
[[ "$RUNNER" =~ ^[Yy] ]] && PROFILE_FILES="$PROFILE_FILES:docker-compose.runner.yml"
if [[ "$RUNNER" =~ ^[Yy] ]]; then
  say "  代码沙箱（可选）：让智能体和网页里的「运行」按钮能执行 Python / Node / Bash。"
  say "  跑在单独的断网容器里：没有外网、不挂载任何卷、不带密钥，只能看到当前工作区的文件副本。"
  ask SANDBOX "同时安装代码沙箱？(y/N)" "n" YUMEIRO_SANDBOX
  [[ "$SANDBOX" =~ ^[Yy] ]] && PROFILE_FILES="$PROFILE_FILES:docker-compose.sandbox.yml"
fi

# ---------- 5b. Cindy 桌面端（可选）----------
say
say "5b Cindy 桌面端（可选）：在服务器容器里运行官方 Cindy 桌面端，让团队直接用你的 Cindy 账号里的模型"
say "  请按你登录用的 Cindy 账号选版本（两种版本的账号不互通，选错了登录不上）："
say "    1) 国际版 Cindy（Global）  ← 用国际版账号选这个"
say "    2) 国内版 Cindy（CN）      ← 用中国大陆版账号选这个"
say "    3) 暂不安装（以后随时运行 ./scripts/desktop-setup.sh [global|cn] 再装）"
say "  装好后：管理设置 → 桌面端 → 软件更新 里可以随时检查更新、切换版本；也会每 6 小时自动检查更新。首次下载约 200MB。"
ask DESKTOP_CHOICE "选择 [1/2/3]" "3" YUMEIRO_DESKTOP
case "$DESKTOP_CHOICE" in 1|global|Global) DESKTOP_REGION=global ;; 2|cn|CN) DESKTOP_REGION=cn ;; *) DESKTOP_REGION="" ;; esac

# ---------- 5c. IP 纯净度检测（CleanIP，可选）----------
say
say "5c IP 纯净度检测（可选）：接入 cleanip.io，让“环境检测”的综合研判更准"
say "  为什么需要："
say "    Claude、OpenAI 等官方服务对出口 IP 的信誉很敏感：被滥用的共享机房 IP、VPN / 代理 IP 容易被要求验证、限流，甚至影响账号。"
say "    内置检测只能粗略判断“是不是机房 / 代理”；CleanIP 会给出 0–100 的纯净度评分、IP 类型（住宅 / 机房等）和黑名单命中情况，"
say "    综合研判会把它和 Cloudflare、连通性探测、用量统计合在一起，告诉你这个出口适不适合接官方服务。"
say "  要注意："
say "    · 这里只是决定“要不要启用”，不会替你注册账号。要用它，之后在 管理设置 → 环境检测 里填你自己的 CleanIP 密钥（cip_ 开头，到 cleanip.io/account 免费创建，免费账号每天 20 个不同 IP）。"
say "    · 启用并填了密钥后，会把服务器的出口 IP 发给 cleanip.io（内置检测本来就会把它发给 ip-api.com）；没填密钥时不会发任何请求。"
say "    · 不启用完全不影响使用，综合研判只用本地信号；以后可在同一个页面随时开关。"
ask CLEANIP "启用 CleanIP 纯净度检测？(y/N)" "n" YUMEIRO_CLEANIP
CLEANIP_ON=0; [[ "$CLEANIP" =~ ^[Yy1] ]] && CLEANIP_ON=1

# ---------- 6. 网络环境 ----------
say
say "6/6 服务器位置"
ask CN "服务器在中国大陆？用 npmmirror 加速构建 (y/N)" "n" YUMEIRO_CN
NPM_REGISTRY=""; [[ "$CN" =~ ^[Yy] ]] && NPM_REGISTRY="https://registry.npmmirror.com"
[ -n "$NPM_REGISTRY" ] && say "→ 若拉取 Docker 镜像很慢，请在华为云控制台“容器镜像服务 SWR → 镜像加速器”按说明配置 Docker 镜像加速。"

# ---------- 写入配置 ----------
[ -f .env ] && { cp .env ".env.bak.$(date +%Y%m%d%H%M%S)"; warn "已备份旧 .env"; }

# 加密密钥和数据库密码一旦生成就绝不重写：重写会导致已有数据无法解密 / 数据库连不上。
if [ -s secrets/store_encryption_key ]; then say "保留已有的数据加密密钥 secrets/store_encryption_key"
else write_secret secrets/store_encryption_key "$(random_b64 32)"; fi
if [ "$DBMODE" = 1 ]; then
  if [ -s secrets/db_password ]; then say "保留已有的内置数据库密码"
  else
    # 数据库卷里的密码在第一次初始化时就固定了。如果 secrets/ 被删过但卷还在，新生成的密码会让应用永远连不上数据库。
    if docker volume ls -q 2>/dev/null | grep -qE '(^|_)pg_data$'; then
      die "发现旧的数据库卷（pg_data），但 secrets/db_password 不存在，新密码和卷里的旧密码对不上，应用会一直 password authentication failed。
  · 旧数据库里没有要保留的数据：先运行 docker compose down -v（会删除数据库卷！），再重新运行 ./install.sh
  · 要保留旧数据：先把原来的 secrets/db_password 和 secrets/store_encryption_key 放回 secrets/，再运行 ./install.sh --reconfigure"
    fi
    write_secret secrets/db_password "$(random_pass 32)"
  fi
elif [ "$DBMODE" = 2 ]; then write_secret secrets/db_password "$DBPASS"
else [ -f secrets/db_password ] || write_secret secrets/db_password "unused"; fi
if [[ "$RUNNER" =~ ^[Yy] ]]; then
  if [ -s secrets/runner_token ]; then say "保留已有的运行器令牌"; else write_secret secrets/runner_token "$(random_pass 48)"; fi
  # 沙箱用独立的令牌：沙箱容器里跑的是不可信代码，不能让它持有运行器令牌
  if [[ "$SANDBOX" =~ ^[Yy] ]]; then
    if [ -s secrets/sandbox_token ]; then say "保留已有的沙箱令牌"; else write_secret secrets/sandbox_token "$(random_pass 48)"; fi
  fi
fi
write_secret secrets/admin_password "$ADMIN_PASS"
write_secret secrets/model_api_key "$MODEL_KEY"

{
  echo "# 由 install.sh 生成。这里不含任何密码或密钥（它们在 secrets/ 目录）。"
  echo "COMPOSE_FILE=$PROFILE_FILES"
  echo "APP_PORT=$APP_PORT"
  echo "APP_BIND=$APP_BIND"
  echo "COOKIE_SECURE=$COOKIE_SECURE"
  echo "TRUST_PROXY=$TRUST_PROXY"
  [ "$USAGE" = 2 ] && echo "YUMEIRO_USAGE=personal"
  [ -n "$DOMAIN" ] && echo "YUMEIRO_DOMAIN=$DOMAIN"
  echo "STORAGE=$STORAGE"
  if [ "$STORAGE" = postgres ]; then
    echo "PGHOST=$PGHOST"; echo "PGPORT=$PGPORT"; echo "PGUSER=$PGUSER"; echo "PGDATABASE=$PGDATABASE"
    [ -n "$PGSSLMODE" ] && echo "PGSSLMODE=$PGSSLMODE"
    echo "JSON_MIRROR=true"
  fi
  echo "ADMIN_EMAIL=$ADMIN_EMAIL"
  [ -n "$MODEL_BASE_URL" ] && { echo "MODEL_BASE_URL=$MODEL_BASE_URL"; echo "MODEL_NAME=$MODEL_NAME"; }
  [ -n "$NPM_REGISTRY" ] && echo "NPM_REGISTRY=$NPM_REGISTRY"
  [ "$CLEANIP_ON" = 1 ] && echo "YUMEIRO_CLEANIP=1"
  echo "MODEL_TIMEOUT_MS=120000"
} > .env
chmod 600 .env

say
ok "配置已写入 .env 与 secrets/"
if [ "$NO_START" = 1 ]; then say "已按 --no-start 跳过启动。准备好后运行：docker compose up -d --build"; START=n
else ask START "现在构建并启动？(Y/n)" "y" YUMEIRO_START; fi
if [[ "$START" =~ ^[Yy] ]]; then
  dc up -d --build
  say "等待服务就绪…"
  for _ in $(seq 1 60); do
    state="$(dc ps --format '{{.Service}} {{.Health}}' 2>/dev/null | awk '$1=="yumeiro"{print $2}')"
    [ "$state" = healthy ] && break; sleep 2
  done
  [ "$state" = healthy ] && ok "服务已启动" || warn "服务尚未显示 healthy，请用 docker compose logs -f yumeiro 查看。"
  if [ -n "${DESKTOP_REGION:-}" ]; then
    say "安装 Cindy 桌面端（$([ "$DESKTOP_REGION" = global ] && echo 国际版 || echo 国内版)）…"
    ./scripts/desktop-setup.sh "$DESKTOP_REGION" || warn "桌面端没有装好，可稍后重试：./scripts/desktop-setup.sh $DESKTOP_REGION"
  fi
elif [ -n "${DESKTOP_REGION:-}" ]; then
  say "（已跳过启动）准备好后运行 ./scripts/desktop-setup.sh $DESKTOP_REGION 安装 Cindy 桌面端"
fi

say
say "============ 安装完成 ============"
if [ "$MODE" = 1 ]; then say "访问地址：https://$DOMAIN"; else say "访问地址：$([ "$MODE" = 3 ] && echo "https://<你的域名>" || echo "http://<服务器公网IP>:$APP_PORT")（端口 $APP_PORT）"; fi
say "管理员邮箱：$ADMIN_EMAIL"
if [ -n "$GENERATED_PASS" ]; then say "管理员密码：$ADMIN_PASS   ← 自动生成，只显示这一次，请立即保存到密码管理器"
else say "管理员密码：你刚才设置的密码"; fi
say
say "之后："
say "  1. 登录成功后运行 ./install.sh scrub-admin，清掉服务器上的初始密码文件"
say "  2. 备份 secrets/store_encryption_key（丢失后所有数据无法解密）和数据库卷"
say "  3. 日志：docker compose logs -f yumeiro    停止：docker compose down（不会删除数据）"
say "  软件更新：Cindy 桌面端在 管理设置 → 桌面端 → 软件更新 里检查更新 / 切换国际版与国内版；Yumeiro 本身升级：解压新版覆盖后运行 docker compose up -d --build"
if [ -n "$CLIENTS_DIR" ] && [[ "$START" =~ ^[Yy] ]]; then upload_clients "$CLIENTS_DIR" || warn "安装包上传失败，可稍后手动运行 ./install.sh clients <文件夹>"
else say "  4. 想让网页里的“下载客户端”有安装包：./install.sh clients <装有 Yumeiro-Setup-*.exe / *.apk 的文件夹>（详见《客户端安装包上传说明.md》）"; fi
