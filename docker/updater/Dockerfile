# Docker 版“网页更新”的更新器：只负责收到已验签的发布包后，备份、替换程序文件并重建 yumeiro 服务。
# 只装工具；程序本身（updater.mjs）从挂载进来的安装目录里运行，所以更新一次之后它自己也会换成新代码。
ARG NODE_IMAGE=node:22-alpine
FROM ${NODE_IMAGE}
RUN apk add --no-cache docker-cli docker-cli-compose tar
ENV NODE_ENV=production
