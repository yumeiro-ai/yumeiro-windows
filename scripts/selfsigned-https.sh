#!/usr/bin/env bash
# 给公网 IP 开自签名 HTTPS（没有域名时使用）。用法：
#   ./scripts/selfsigned-https.sh 183.87.159.180 [对外端口，默认 3005]
# 做的事：生成证书到 secrets/tls/ → 修改 .env（应用只听本机 8787，Caddy 在对外端口提供 HTTPS）→ 重启。
# 之后用 https://IP:端口 访问。浏览器会提示“不安全”，点“高级 → 继续访问”即可（或安装证书，见 语音识别 / HTTPS 说明）。
set -euo pipefail
cd "$(dirname "$0")/.."
IP="${1:-}"; PORT="${2:-3005}"
[[ "$IP" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] || { echo "用法：$0 <服务器公网IPv4> [端口]"; exit 1; }
[[ "$PORT" =~ ^[0-9]+$ ]] && [ "$PORT" -ge 1 ] && [ "$PORT" -le 65535 ] || { echo "端口无效：$PORT"; exit 1; }
[ -f .env ] || { echo "找不到 .env，请先运行 ./install.sh"; exit 1; }
command -v openssl >/dev/null || { echo "需要 openssl：apt install -y openssl"; exit 1; }

mkdir -p secrets/tls
if [ ! -f secrets/tls/cert.pem ] || ! openssl x509 -in secrets/tls/cert.pem -noout -ext subjectAltName 2>/dev/null | grep -q "IP Address:$IP"; then
  openssl req -x509 -newkey rsa:2048 -sha256 -nodes -days 825 -keyout secrets/tls/key.pem -out secrets/tls/cert.pem \
    -subj "/CN=$IP" -addext "subjectAltName=IP:$IP" -addext "basicConstraints=critical,CA:FALSE" -addext "extendedKeyUsage=serverAuth"
  echo "已生成证书（825 天有效）：secrets/tls/cert.pem"
else echo "沿用已有证书：secrets/tls/cert.pem"; fi
chmod 600 secrets/tls/key.pem; chmod 644 secrets/tls/cert.pem

setenv() { if grep -q "^$1=" .env; then sed -i "s#^$1=.*#$1=$2#" .env; else echo "$1=$2" >> .env; fi; }
cp .env ".env.bak.$(date +%s)"
setenv APP_PORT 8787
setenv APP_BIND 127.0.0.1
setenv HTTPS_PORT "$PORT"
setenv COOKIE_SECURE true
setenv TRUST_PROXY true
CF="$(grep '^COMPOSE_FILE=' .env | cut -d= -f2- || true)"; CF="${CF:-docker-compose.yml}"
CF="$(echo "$CF" | sed 's#:docker-compose.caddy.yml##')"
case ":$CF:" in *":docker-compose.selfsigned.yml:"*) ;; *) CF="$CF:docker-compose.selfsigned.yml";; esac
setenv COMPOSE_FILE "$CF"

docker compose up -d --build yumeiro caddy
echo
echo "完成。请在华为云安全组放行 TCP $PORT，然后用  https://$IP:$PORT  访问（不要再用 http://）。"
echo "旧的 .env 已备份为 .env.bak.*；证书文件 secrets/tls/cert.pem 可下载后安装到设备，消除“不安全”提示。"
