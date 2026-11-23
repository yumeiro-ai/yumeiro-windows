# Cindy 桌面端（官方 Linux .deb）+ 虚拟显示 + VNC + 本地桥接。
# 目的：让真正的 Cindy 桌面端在服务器上运行，团队服务通过容器内网调用它的“本机 Agent API”。
# 桌面端的登录由你通过 VNC 在官方界面里完成，我们不保存也不导出你的账号凭据。
ARG NODE_IMAGE=node:22-slim
FROM ${NODE_IMAGE} AS node

FROM ubuntu:24.04
# 安装包不再写死：按 CINDY_FLAVOR（global 国际版 / cn 国内版）和 CINDY_VERSION（latest 或 0.1.136 这样的版本号）
# 向 GitHub 查询官方发布页，下载对应的 .deb，并用发布页给出的 SHA-256 校验。
# 想用自己的安装包（内网镜像等）：设置 CINDY_DEB_URL（和 CINDY_DEB_SHA256），就不再查询 GitHub。
ARG CINDY_FLAVOR=global
ARG CINDY_VERSION=latest
ARG CINDY_DEB_URL=
ARG CINDY_DEB_SHA256=
ENV DEBIAN_FRONTEND=noninteractive
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY desktop/pick-release.mjs /opt/pick-release.mjs
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl xvfb x11vnc novnc websockify openbox dbus-x11 gnome-keyring libsecret-1-0 libsecret-tools fonts-noto-cjk xdg-utils procps \
    && if [ -z "$CINDY_DEB_URL" ]; then \
         api=https://api.github.com/repos/makecindy/cindy/releases; \
         if [ "$CINDY_VERSION" = latest ]; then api="$api/latest"; else api="$api/tags/v$CINDY_VERSION"; fi; \
         curl -fsSL --retry 5 --retry-delay 3 -H 'Accept: application/vnd.github+json' -H 'User-Agent: yumeiro-desktop-build' "$api" -o /tmp/release.json \
           || { echo "查询 Cindy 发布页失败：$api（服务器连不上 GitHub？可设置 CINDY_DEB_URL 直接给安装包地址）" >&2; exit 1; }; \
         line="$(node /opt/pick-release.mjs 0 "$CINDY_FLAVOR" x64 < /tmp/release.json)" || { echo "发布页里没有 $CINDY_FLAVOR / $CINDY_VERSION 对应的安装包" >&2; exit 1; }; \
         CINDY_DEB_URL="$(echo "$line" | cut -d'|' -f3)"; CINDY_DEB_SHA256="$(echo "$line" | cut -d'|' -f4)";        fi \
    && echo "下载 Cindy 桌面端：$CINDY_DEB_URL" \
    && curl -fL --retry 5 --retry-delay 3 -o /tmp/cindy.deb "$CINDY_DEB_URL" \
    && if [ -n "$CINDY_DEB_SHA256" ]; then echo "$CINDY_DEB_SHA256  /tmp/cindy.deb" | sha256sum -c -; else echo "警告：没有 SHA-256，未校验安装包" >&2; fi \
    && apt-get install -y --no-install-recommends /tmp/cindy.deb \
    && rm -rf /tmp/cindy.deb /tmp/release.json /var/lib/apt/lists/*
RUN userdel -r ubuntu 2>/dev/null; useradd -m -u 1000 -s /bin/bash cindy
COPY --chown=cindy:cindy bridge/yumeiro-bridge.mjs /opt/bridge/yumeiro-bridge.mjs
COPY desktop/entrypoint.sh /usr/local/bin/desktop-entrypoint
COPY desktop/run-app.sh /usr/local/bin/run-app
RUN for f in /usr/local/bin/desktop-entrypoint /usr/local/bin/run-app; do tr -d '\r' < "$f" > "$f.tmp" && mv "$f.tmp" "$f"; done && chmod 755 /usr/local/bin/desktop-entrypoint /usr/local/bin/run-app
USER cindy
ENV HOME=/home/cindy DISPLAY=:99 XDG_CONFIG_HOME=/home/cindy/.config
WORKDIR /home/cindy
EXPOSE 6080 8788
ENTRYPOINT ["/usr/local/bin/desktop-entrypoint"]
