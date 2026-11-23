# 没有域名：用自签名证书给 IP 开 HTTPS

浏览器只在 HTTPS（或 localhost）下允许使用麦克风，所以语音录入需要 HTTPS。

## 一、开启（在服务器上执行，约 1 分钟）

1. 把新文件覆盖到服务器目录（不要覆盖 `.env`、`secrets/`），新增的有：
   `scripts/selfsigned-https.sh`、`Caddyfile.ip`、`docker-compose.selfsigned.yml`。
2. 运行：
   ```sh
   cd /yumeiro
   sed -i 's/\r$//' scripts/selfsigned-https.sh
   chmod +x scripts/selfsigned-https.sh
   ./scripts/selfsigned-https.sh 183.87.159.180 3005
   ```
   脚本会：生成证书到 `secrets/tls/` → 备份并修改 `.env`（应用改为只听本机 8787，Caddy 在 3005 端口提供 HTTPS，并开启 Secure Cookie）→ 重新启动。
3. 华为云安全组保持放行 TCP 3005。
4. 浏览器改用 **`https://183.87.159.180:3005`** 访问（`http://` 不再能用）。

## 二、浏览器提示“不安全”怎么办

自签名证书不被浏览器预先信任，每台设备第一次访问会拦一下：
- Chrome / Edge：点“高级” → “继续前往 183.87.159.180（不安全）”。
- 想永久去掉提示：把服务器上的 `secrets/tls/cert.pem` 下载下来。
  - Windows：双击改名为 `cert.crt` 的文件 → 安装证书 → 本地计算机 → 放入“受信任的根证书颁发机构”。
  - macOS：钥匙串访问导入后，设为“始终信任”。
  - iPhone / Android：用文件安装证书，再到系统设置里信任（iPhone 要在“关于本机 → 证书信任设置”里打开）。
- 只要点过“继续访问”，该页面就是安全上下文，麦克风可以用（首次会弹出麦克风权限，选允许）。

## 三、注意事项

- 通信仍然是加密的，登录密码不再明文传输；“不安全”提示只是因为证书不是公共机构签发。请不要在其他人能劫持网络的环境下无视证书变化（出现陌生的证书警告时别点继续）。
- 证书 825 天有效。到期或服务器 IP 变了，重新运行同一条命令即可（IP 变了会自动重新生成）。
- 桌面端（VNC）、桥接等走容器内网，不受影响。如果你有别的程序用 `http://IP:3005/v1` 调用 API，需要改成 `https://`，并让它信任这张证书（或设置忽略证书校验，仅限你自己的程序）。
- 退出自签名模式：编辑 `.env`，把 `COMPOSE_FILE` 里的 `:docker-compose.selfsigned.yml` 去掉，`APP_PORT` 改回 3005、`APP_BIND` 改回 `0.0.0.0`、`COOKIE_SECURE=false`、`TRUST_PROXY=false`（也可用备份的 `.env.bak.*` 恢复），再 `docker compose up -d`。
- 以后有了域名，运行 `./install.sh` 选域名模式，Caddy 会自动申请正式证书，提示就消失了。
- 这个方案我没有在你的服务器上实际跑过，脚本在本地只验证了语法和证书生成。若 Caddy 起不来，发 `docker compose logs --tail=50 caddy` 给我。
