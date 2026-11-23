# 智能体运行器：Claude Code / Codex / Pi + 一个只在内部网络监听的小 HTTP 服务。
# 用 Debian 系镜像（这些 CLI 带原生二进制，需要 glibc）。
ARG NODE_IMAGE=node:22-slim
FROM ${NODE_IMAGE}
ARG NPM_REGISTRY=
ARG CLAUDE_PKG=@anthropic-ai/claude-code
ARG CODEX_PKG=@openai/codex
ARG PI_PKG=@mariozechner/pi-coding-agent
ENV NODE_ENV=production
RUN apt-get update && apt-get install -y --no-install-recommends git ripgrep ca-certificates && rm -rf /var/lib/apt/lists/*
# uvx 是很多 Python 写的 MCP 服务（fetch、git、time…）的启动器。装失败不影响构建，只是这些服务用不了（管理页的 MCP 市场会标出来）。不需要可以设 INSTALL_UV=0；国内服务器可以设 PIP_INDEX_URL 用 PyPI 镜像。
ARG INSTALL_UV=1
ARG PIP_INDEX_URL=
RUN if [ "$INSTALL_UV" = 1 ]; then \
      ( apt-get update && apt-get install -y --no-install-recommends python3 python3-pip && rm -rf /var/lib/apt/lists/* \
        && pip install --no-cache-dir --break-system-packages ${PIP_INDEX_URL:+-i "$PIP_INDEX_URL"} uv \
        && command -v uvx >/dev/null ) || echo "警告：uv 没装上，需要 uvx 的 MCP 服务将不可用" >&2; \
    fi
RUN if [ -n "$NPM_REGISTRY" ]; then npm config set registry "$NPM_REGISTRY"; fi \
 && npm install -g "$CLAUDE_PKG" "$CODEX_PKG" "$PI_PKG" && npm cache clean --force \
 && for c in claude codex pi; do command -v "$c" >/dev/null || { echo "引擎 $c 没有装上" >&2; exit 1; }; done
RUN useradd --uid 10001 --create-home --shell /usr/sbin/nologin agent \
 && mkdir -p /workspaces /app && chown agent:agent /workspaces
COPY runner.mjs filestore.mjs verify.mjs mcp.mjs sandbox.mjs sandbox-mcp.mjs selfcheck.mjs /app/
USER agent
WORKDIR /workspaces
EXPOSE 8790
CMD ["node", "/app/runner.mjs"]
