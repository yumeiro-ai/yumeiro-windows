# Yumeiro 非 Docker 安装说明（直接装在服务器上）

适合：不想装 Docker、服务器资源小、或已有 Node.js 环境的情况。功能和 Docker 版完全一致，用 systemd 管理，崩溃自动重启，每天自动备份。

## 一、准备
- Linux 服务器，带 **systemd**（Ubuntu / Debian / CentOS / Rocky 等都可以），root 权限。
- **Node.js 22 或更高**（`node -v` 检查）。没有也没关系：安装脚本会询问是否自动安装官方版本到 `/usr/local`（加 `--install-node` 就不问；国内服务器加 `--node-mirror cn`）。
- `curl`、`openssl`、`tar`（几乎都自带）。脚本会预检端口是否被占用、磁盘空间和缺少的命令。
- 若 root 的 umask 很严（如 077）也没问题：脚本会自己把程序目录设成服务账号可读。

## 二、安装
把 `Yumeiro-x.y.z.zip` 传到服务器并解压，进入解压出来的目录：

```sh
unzip Yumeiro-*.zip && cd Yumeiro
# 去掉可能存在的 Windows 换行（从 Windows 上传时需要）
for f in deploy/*.sh; do tr -d '\r' < "$f" > "$f.tmp" && mv "$f.tmp" "$f"; done
sudo bash deploy/yumeiro-native.sh install --admin-email you@example.com
```

常用选项（都可省略）：

| 选项 | 作用 |
|---|---|
| `--port 8787` | 监听端口 |
| `--domain example.com` | 前面有 HTTPS 反向代理时使用：只监听 127.0.0.1，并启用安全 Cookie；脚本会打印 Caddy 配置示例 |
| `--with-runner` | 同时安装智能体运行器（工作区里让 Claude Code / Codex / Pi 读写文件）。这三个引擎本身要你自己另装 |
| `--pg-url postgres://...` | 使用外部 PostgreSQL；不填则用加密的 JSON 文件存储（小团队足够） |
| `--model-url / --model-name / --model-key` | 预设一个 OpenAI 兼容模型，也可以以后在管理设置里加 |
| `--npm-registry https://registry.npmmirror.com` | 国内服务器装依赖更快 |
| `--install-node` | 没有 Node.js 22+ 时自动安装官方版本到 `/usr/local`（带校验；不加则会询问，`-y` 表示全部同意）。国内服务器再加 `--node-mirror cn` |
| `--tls-port 3005` | 安装完顺便用 nginx（含宝塔）在 3005 端口开 **HTTPS**（自签名证书，应用只留在本机）。也可以以后单独执行 `https` 子命令 |
| `-y` | 所有询问都当作“是”（无人值守） |

安装完成后脚本会打印**管理员初始密码**。登录后马上改密码，再执行：

```sh
sudo bash /opt/yumeiro/deploy/yumeiro-native.sh scrub-admin
```


### 开 HTTPS（没有域名也行）
```sh
sudo bash deploy/yumeiro-native.sh https --tls-port 3005                      # 自签名证书，证书里写自动探测的公网 IP（可加 --ip 指定）
sudo bash deploy/yumeiro-native.sh https --tls-port 443 --cert 证书.pem --key 私钥.pem   # 用自己的证书（宝塔 / certbot 申请的）
```
- 它会：生成证书 → 在 nginx（宝塔面板的 nginx 也认）里写一份 `yumeiro.conf` → 应用改为只听 `127.0.0.1`、开启安全 Cookie → 自检。没有 nginx 时加 `--install-nginx`。
- 对外端口是 `--tls-port`，应用自己的端口（默认 8787）不用放行。云服务器安全组、宝塔防火墙要放行这个端口。
- 自签名证书第一次访问会提示“不安全”，点“高级 → 继续前往”；之前用 HTTP 登录的会话需要重新登录。
- 想撤销：删除 nginx 里的 `yumeiro.conf` 并 reload，再把 `/etc/yumeiro/yumeiro.env` 里的 `HOST` 改回 `0.0.0.0`、`COOKIE_SECURE` 改回 `false`。

> 不开 HTTPS 时是 HTTP 直连，登录信息不加密。

## 三、目录一览
| 位置 | 内容 |
|---|---|
| `/opt/yumeiro` | 程序文件（升级时被替换） |
| `/etc/yumeiro` | 配置 `yumeiro.env`、密钥 `secrets/`（**加密密钥丢了数据就解不开，务必另外保管**） |
| `/var/lib/yumeiro` | 数据（加密） |
| `/var/lib/yumeiro/downloads` | 客户端安装包（Windows 安装版 / 便携版、APK），用 `scripts/install-clients.mjs` 上传：`sudo ./deploy/yumeiro-native.sh clients <文件夹>`，见《客户端安装包上传说明.md》；不会被每日备份打包 |
| `/var/lib/yumeiro-workspaces` | 工作区文件，以及其中 `.versions/` 下的全部历史版本 |
| `/var/backups/yumeiro` | 备份 |

服务：`yumeiro`（主程序）、`yumeiro-runner`（可选）、`yumeiro-backup.timer`（每天 03:30 备份）。

## 四、日常操作
```sh
sudo bash /opt/yumeiro/deploy/yumeiro-native.sh status     # 状态与健康检查
sudo bash /opt/yumeiro/deploy/yumeiro-native.sh backup     # 立即备份（数据 + 配置 + 工作区 + 全部文件版本）
journalctl -u yumeiro -f                                  # 看日志
sudo systemctl restart yumeiro                            # 改了 /etc/yumeiro/yumeiro.env 之后
```

## 五、升级
把新版压缩包解压到**新目录**，在新目录里执行：

```sh
sudo bash deploy/yumeiro-native.sh update
```
脚本会：①先把数据、配置、旧程序打成 `pre-update-*.tar.gz`；②停止服务并替换程序；③启动后等待健康检查；④**起不来就自动回滚**到升级前的状态。数据和配置不会被覆盖。

## 六、从 Docker 版迁移
1. Docker 版里备份数据卷（`docker compose exec yumeiro tar -C /app/data -cf - . > data.tar`）和 `secrets/store_encryption_key`。
2. 原生版安装后 `systemctl stop yumeiro`，把 data.tar 解到 `/var/lib/yumeiro`，把 `store_encryption_key` 放到 `/etc/yumeiro/secrets/store_encryption_key`（覆盖），`chown -R yumeiro:yumeiro /var/lib/yumeiro`，再 `systemctl start yumeiro`。
3. 如果 Docker 版用的是 PostgreSQL，安装时加 `--pg-url` 指向同一个库即可，不需要搬数据。

## 七、卸载
```sh
sudo bash /opt/yumeiro/deploy/yumeiro-native.sh uninstall
```
只卸载服务和程序，**数据、配置、备份都保留**。

---

# 工作区文件管理：版本备份与过期清理

在「工作区 → 打开」页面的“版本历史与过期清理”里使用。

## 版本备份（自动，不用设置）
- 保存/覆盖文件、删除文件、智能体运行前后，旧内容都会先备份一份；内容没变不重复备份。
- 每个文件最多保留 30 个版本；**删除文件不会删除它的备份**，在“版本历史”里可以查看、预览、还原（还原前当前内容也会先备份）。
- 不备份 `node_modules` 和 `.git`；单个文件超过 20 MB 的不做自动备份（手动删除/过期删除时仍会强制备份）。
- 删除整个工作区时，会先做最后一次备份，备份保留在服务器 `.versions` 目录里。

## 过期清理（人工确认）
1. 创建者或主账号设置“过期天数”（≥7）和“保护路径前缀”（这些永不清理，如 `docs`、`assets/final`）。
2. 页面列出“超过 N 天没修改”的候选文件，你勾选后点“确认删除”。
3. 服务器在删除时会再核对：文件仍然过期、且自你审核后没被改过，才会删；每个文件删除前先备份。
4. 可选“自动删除”：必须由创建者/主账号明确确认才能开启（会记录是谁、何时确认），之后每天按同样规则清理；一次候选超过 200 个会暂停自动清理，改为等你手动审核。
5. 所有清理与还原都有记录，可在页面底部展开查看。

**空间提示**：备份不会随文件删除而消失，长期会占磁盘。需要回收时，在服务器上手动清理 `工作区目录/.versions/<工作区ID>/` 下不需要的备份即可。
