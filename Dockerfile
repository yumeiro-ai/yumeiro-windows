ARG NODE_IMAGE=node:22-alpine
FROM ${NODE_IMAGE}
ARG NPM_REGISTRY=
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
# 国内服务器可用 NPM_REGISTRY=https://registry.npmmirror.com 加速依赖安装
RUN if [ -n "$NPM_REGISTRY" ]; then npm config set registry "$NPM_REGISTRY"; fi \
 && npm ci --omit=dev && npm cache clean --force
COPY --chown=node:node server.mjs storage.mjs providers.mjs collab.mjs platform-models.mjs market.mjs market-sources.mjs asr.mjs asr-native.mjs memory.mjs audit.mjs envcheck.mjs doctor.mjs mcp.mjs mcp-market.mjs docs.mjs docparse.mjs images.mjs tts.mjs ziputil.mjs updatepkg.mjs demo.mjs vision.mjs remote.mjs recover.mjs project.mjs aiexport.mjs breaker.mjs dlp.mjs plans.mjs mail.mjs ./
# 注意：上面这份 .mjs 清单要和 deploy/yumeiro-native.sh 里的保持一致（test/deploy-lists.test.mjs 会检查）。
# 客户端安装包不打进镜像（.dockerignore 排除了 public/downloads），放在数据卷的 downloads/ 里，用 scripts/install-clients.mjs 上传。
COPY --chown=node:node scripts ./scripts
# server.mjs 启动时就会 import ./setup/setup-client.mjs，镜像里缺了它主服务一启动就退出，反向代理就会显示 502
COPY --chown=node:node setup ./setup
COPY --chown=node:node public ./public
RUN mkdir -p /app/data && chown -R node:node /app/data
USER node
EXPOSE 8787
CMD ["sh", "-c", "node scripts/seed-wallpapers.mjs; exec node server.mjs"]
