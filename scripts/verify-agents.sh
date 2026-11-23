#!/usr/bin/env bash
# 真实验证 Claude Code / Codex / Pi 三个命令行能否在运行器里跑通。
#   ./scripts/verify-agents.sh                       交互式：缺哪个密钥就问（输入不回显，回车跳过该引擎）
#   ./scripts/verify-agents.sh --engine=claude       只测一个（逗号分隔可测多个）
#   ANTHROPIC_API_KEY=sk-... OPENAI_API_KEY=sk-... ./scripts/verify-agents.sh --yes   非交互
# 环境变量：ANTHROPIC_API_KEY [ANTHROPIC_BASE_URL] [CLAUDE_MODEL]
#           OPENAI_API_KEY [OPENAI_BASE_URL] [CODEX_MODEL]
#           PI_PROVIDER PI_API_KEY [PI_MODEL]
# 说明：会真实调用模型（消耗少量额度）；密钥只传给运行器进程，不写入磁盘。验证用的临时工作区会在结束后删除。
set -uo pipefail
cd "$(dirname "$0")/.."

ENGINES="claude,codex,pi"; ASSUME_YES=0; EXTRA=()
for arg in "$@"; do
  case "$arg" in
    --engine=*) ENGINES="${arg#--engine=}" ;;
    --yes|-y) ASSUME_YES=1 ;;
    --strict|--timeout=*) EXTRA+=("$arg") ;;
    -h|--help) sed -n '2,11p' "$0"; exit 0 ;;
    *) echo "未知参数：$arg" >&2; exit 2 ;;
  esac
done
dc() { if docker compose version >/dev/null 2>&1; then docker compose "$@"; else docker-compose "$@"; fi; }
die() { printf '\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

command -v docker >/dev/null 2>&1 || die "没有找到 docker"
[ -f runner/verify.mjs ] || die "找不到 runner/verify.mjs"
if ! dc ps --status running --services 2>/dev/null | grep -qx runner; then
  echo "运行器容器没有在运行。当前状态：" >&2
  dc ps -a 2>&1 | sed 's/^/  /' >&2
  die "请先运行 ./scripts/doctor.sh 查看原因（常见：secrets/runner_token 权限、镜像构建失败）"
fi

has() { grep -qw "$1" <<<"${ENGINES//,/ }"; }
ask_secret() { # ask_secret 变量名 提示
  local var="$1" prompt="$2" value=""
  [ -n "${!var:-}" ] && return
  [ "$ASSUME_YES" = 1 ] && return
  read -r -s -p "$prompt（回车跳过）: " value || true; echo
  [ -n "$value" ] && export "$var=$value"
}
has claude && { ask_secret ANTHROPIC_API_KEY "Claude Code 的 ANTHROPIC_API_KEY"; }
has codex  && { ask_secret OPENAI_API_KEY "Codex 的 OPENAI_API_KEY"; }
if has pi; then
  [ -z "${PI_PROVIDER:-}" ] && [ "$ASSUME_YES" = 0 ] && { read -r -p "Pi 的服务商 [anthropic]（如 anthropic / openai / google / deepseek）: " PI_PROVIDER || true; export PI_PROVIDER="${PI_PROVIDER:-anthropic}"; }
  ask_secret PI_API_KEY "Pi 的 API Key（对应上面的服务商）"
fi

ENVARGS=()
for var in ANTHROPIC_API_KEY ANTHROPIC_BASE_URL CLAUDE_MODEL OPENAI_API_KEY OPENAI_BASE_URL CODEX_MODEL PI_PROVIDER PI_API_KEY PI_MODEL; do
  [ -n "${!var:-}" ] && ENVARGS+=(-e "$var")   # 只写变量名：值从当前环境传入，不出现在命令行/进程列表里
done

echo "开始验证：$ENGINES"
echo
dc exec -T "${ENVARGS[@]}" runner node --input-type=module - --engine="$ENGINES" "${EXTRA[@]}" < runner/verify.mjs
code=$?
echo
case "$code" in
  0) printf '\033[32m✓ 全部通过（跳过的项没有提供密钥）\033[0m\n' ;;
  1) printf '\033[31m✗ 有失败项，详见上面的提示。需要更多信息：docker compose logs --tail 100 runner\033[0m\n' ;;
  *) printf '\033[31m✗ 无法完成验证（退出码 %s）。可运行 ./scripts/doctor.sh 排查\033[0m\n' "$code" ;;
esac
exit "$code"
