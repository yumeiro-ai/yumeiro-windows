# 腾讯云 CloudBase 云托管部署

Yumeiro 是持续运行的 Node.js 服务，部署目标应使用 CloudBase 的“云托管/容器服务”，不是静态网站托管。仓库根目录的 Dockerfile 已经支持 CloudBase 传入的 PORT，健康检查地址为 /api/health。

## 1. 准备环境

1. 创建 CloudBase 环境，并准备一个可公网或 VPC 访问的 PostgreSQL 数据库。
2. 在 CloudBase 云托管服务中使用 deploy/cloudbase.env.example 配置运行时变量。
3. 必须设置 STORAGE=postgres、DATABASE_URL、STORE_ENCRYPTION_KEY、ADMIN_EMAIL 和 ADMIN_PASSWORD。云托管实例本地磁盘不是持久化存储，不要使用 JSON 文件保存正式数据。
4. 给服务配置容器端口 8787，健康检查使用 GET /api/health。

## 2. 部署

在项目根目录执行：

    .\\deploy\\cloudbase-deploy.ps1 -EnvId <你的环境ID>

脚本会把环境 ID 和服务名写入 cloudbaserc.json，然后调用 CloudBase CLI 构建并发布根目录 Dockerfile。首次执行前需要按 CloudBase CLI 提示完成登录/授权。

也可以手动执行：

    npx --yes @cloudbase/cli@latest login
    npx --yes @cloudbase/cli@latest framework deploy --envId <你的环境ID> --force

## 3. 发布后验证

    Invoke-RestMethod https://<云托管域名>/api/health

返回 JSON 中 ok 应为 true，storage 应显示 PostgreSQL。随后访问服务首页，使用 ADMIN_EMAIL / ADMIN_PASSWORD 登录。

不要把真实数据库连接串、管理员密码、模型 API Key 或加密密钥写入 cloudbaserc.json、.env 或 Git；这些值应配置在 CloudBase 云托管的环境变量/密钥中。
