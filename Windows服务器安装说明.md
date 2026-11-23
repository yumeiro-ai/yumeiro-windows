# Yumeiro Windows 服务器版安装说明

把 Yumeiro 直接装在 **Windows 服务器**上（不需要 Docker、不需要 WSL）。功能和 Linux 直装版对齐：系统服务（开机自启、崩溃自动重启）、每日备份、网页「从 GitHub 一键更新」、智能体运行器（Claude Code / Codex / Pi）和代码沙箱、HTTPS、客户端安装包下载。

## 一、准备
- **Windows Server 2019 / 2022 / 2025**，或 Windows 10 1809 / Windows 11（64 位）。系统自带 `tar.exe`、`robocopy`、PowerShell 5.1 即可。
- 用**管理员身份**打开 PowerShell。
- **Node.js 22 或更高**：没有也没关系，安装脚本会询问并自动下载官方 Node.js（校验 SHA256）到 `C:\Yumeiro\node`。
- 想用运行器里的 **Claude Code**：需要先装 [Git for Windows](https://git-scm.com/download/win)（Claude Code 在 Windows 上依赖它的 bash）。代码沙箱里要跑 Python 的话，请装好 Python 并加入系统 PATH。

## 二、安装

### 方式一：exe 安装程序（推荐）
运行 `Yumeiro-Server-Setup-x.y.z.exe`（会弹出管理员授权）。安装向导和 Linux 版的「首次安装」网页向导一一对应，一次把设置配好：

| 步骤 | 内容 |
|---|---|
| 管理员账号 | 邮箱；密码可以自己设（至少 16 位）或勾选「自动生成强密码」（结束页显示一次） |
| 安装组件 | Node.js 22（必装，自动下载并校验）；智能体运行器 + 代码沙箱；Claude Code / Codex / Pi 分别勾选；国内镜像 |
| 服务器与存储 | 端口、站点域名；访问方式：直接 HTTP / HTTPS 自签名 / HTTPS 域名自动证书（Caddy）；存储：加密 JSON 或 PostgreSQL（安装前先测试连接，连不上就停在这里） |
| 模型与使用方式 | 模型服务商（和 Linux 向导同一份列表，选中自动填地址）、API Key、模型名；团队 / 个人使用 |
| 其它选项 | 每日自动备份、网页一键更新、放行防火墙端口、发布客户端安装包（含客户端的包才有） |
| 复核 | 列出全部选择，点「安装」开始；结束页显示访问地址和登录信息 |

你的选择（包括密码、数据库地址、API Key）由安装程序写进一个临时「答案文件」交给安装脚本，脚本读完立即删除，**不会出现在命令行或进程列表里**。安装结束后开始菜单里有「打开管理页面 / 查看服务状态 / 卸载」，Windows「设置 → 应用 → 已安装的应用」里可以卸载。

无人值守（静默）安装：

```powershell
.\Yumeiro-Server-Setup-0.47.0.exe /S /PORT=8787 /EMAIL=you@example.com /ADMINPASS="一个至少16位的密码" /RUNNER=1 /ENGINES=claude,codex /CN=1 /HTTPS=self /MODELURL="https://api.deepseek.com" /MODELNAME=deepseek-chat /MODELKEY=sk-xxx /D=C:\Yumeiro
```
参数：`/PORT=`、`/EMAIL=`、`/ADMINPASS=`（不给就自动生成）、`/RUNNER=1`、`/ENGINES=`（claude,codex,pi 的子集）、`/CN=1`、`/HTTPS=self|domain`、`/DOMAIN=`、`/STORAGE=pg`＋`/PGURL=`、`/MODELURL=`、`/MODELNAME=`、`/MODELKEY=`、`/PERSONAL=1`、`/BACKUP=0`、`/WEBUPDATE=0`、`/FIREWALL=0`、`/CLIENTS=0`、`/DATAROOT=`、`/NOSERVICE=1`（只装文件不建服务）、`/RESULT=文件路径`（把访问地址和初始密码写到这个文件，读完请自行删除）、`/D=安装目录`（必须放在最后）。**含 `/` 的值（网址、数据库地址）一定要加引号**，否则会在第一个 `/` 处被截断。静默安装时命令行里的密码和 Key 会被系统记录，建议改用向导或 `deploy\yumeiro-windows.ps1 install -AnswersFile`。

**卸载**：在「已安装的应用」里卸载，或运行 `C:\Yumeiro\uninstall.exe`。卸载向导会**列出安装时配置的每一项**（主服务、运行器与沙箱、HTTPS、网页更新、每日备份、防火墙规则…），并逐项取消：停止并删除全部计划任务、专用账号（含它们的用户配置文件）、防火墙规则、Node.js、引擎、Caddy 和程序文件，在开始菜单和注册表里不留痕迹。向导里可以勾选**是否同时删除数据**（聊天记录、工作区文件、备份、密钥）：不勾选保留，以后重装可继续用；勾选则全部删除、无法恢复。静默卸载：`uninstall.exe /S`（保留数据）或 `uninstall.exe /S /PURGE=1`（连数据一起删）。卸载脚本中途失败时不会删除任何文件，避免留下指向已删程序的残缺服务。

**缓存与临时文件**：安装和更新时 npm 的缓存、下载 Node.js / Caddy 的临时文件都放在安装目录里（`C:\Yumeiro\npm-cache`、`C:\Yumeiro\tmp`），卸载时一起删除，不会留在你的用户目录或 SYSTEM 目录里。选择“保留数据”时，数据目录里可再生的缓存（更新器工作目录和已下载的安装包、沙箱临时目录、引擎的临时目录和 npm 缓存）也会清掉，只留下数据、配置、密钥、备份、日志和引擎的设置文件。唯一不归我们管的是 Windows 自己为 PowerShell 生成的命令分析缓存（系统行为，与卸载无关）。

> exe 只是外壳：它把发布包解开，调用包里的 `deploy\yumeiro-windows.ps1`，和下面的命令行安装完全同一套逻辑。服务以「计划任务」形式运行（开机自启、崩溃自动重启、独立低权限账号）。

### 方式二：命令行
把 `Yumeiro-x.y.z.zip` 传到服务器，解压，进入解压出来的目录：

```powershell
Set-ExecutionPolicy -Scope Process Bypass        # 只对当前窗口生效
.\deploy\yumeiro-windows.ps1 install -AdminEmail you@example.com
```

常用选项（都可省略）：

| 选项 | 作用 |
|---|---|
| `-Port 8787` | 监听端口 |
| `-Domain example.com` | 前面有 HTTPS 反向代理时使用：只监听 127.0.0.1，并启用安全 Cookie；随后执行 `https -Domain example.com` 让 Caddy 自动申请证书 |
| `-WithRunner` | 同时安装智能体运行器和代码沙箱，并自动装好 Claude Code / Codex / Pi（`-NoEngines` 只装运行器，以后用 `engines` 装） |
| `-PgUrl postgres://...` | 使用外部 PostgreSQL；不填则用加密的 JSON 文件存储（小团队足够） |
| `-ModelUrl / -ModelName / -ModelKey` | 预设一个 OpenAI 兼容模型，也可以以后在管理设置里加 |
| `-NpmRegistry https://registry.npmmirror.com` | 国内服务器装依赖更快 |
| `-InstallNode`、`-NodeMirror cn` | 不询问直接自动安装 Node.js；`cn` 使用国内镜像 |
| `-Personal` | 个人使用模式：隐藏成员 / 邀请等团队功能 |
| `-Engines claude,codex` | 只装这几个引擎（默认三个都装；`-NoEngines` 一个都不装） |
| `-WithHttps` | 安装后顺便启用 HTTPS（Caddy）：配了 `-Domain` 自动申请证书，否则自签名 |
| `-NoUpdater`、`-NoBackupTask`、`-NoFirewall`、`-NoClients` | 不启用网页一键更新 / 不建每日备份 / 不放行防火墙端口 / 不发布客户端安装包 |
| `-AnswersFile 文件` | 图形向导用的方式：每行 `KEY=VALUE`（AdminEmail、AdminPassword、Port、Domain、Https、Storage、PgUrl、ModelUrl、ModelName、ModelKey、Runner、Engines、CN、Personal、Backup、WebUpdate、Firewall、Clients），读完立即删除，适合不想把密码放命令行的自动化 |
| `-Prefix D:\Yumeiro`、`-DataRoot D:\YumeiroData` | 改安装目录 / 数据目录（默认 `C:\Yumeiro`、`C:\ProgramData\Yumeiro`） |
| `-Yes` | 所有询问都当作“是”（无人值守） |
| `-NoService` | 只装文件和配置，不建账号 / 计划任务 / 防火墙规则（不需要管理员，用 `run` 前台启动，适合试用和调试） |

安装完成会显示**管理员初始密码（只显示这一次）**。首次登录后请改密码，然后执行：

```powershell
.\deploy\yumeiro-windows.ps1 scrub-admin         # 删掉服务器上保存的初始密码
```

别忘了在云服务器的**安全组 / 防火墙**里放行监听端口（脚本已在 Windows 防火墙里放行）。

## 三、目录与服务
| 位置 | 内容 |
|---|---|
| `C:\Yumeiro\app` | 程序（服务账号只读，不能改自己的代码） |
| `C:\Yumeiro\node`、`engines`、`tools` | Node.js、Claude Code / Codex / Pi、Caddy |
| `C:\ProgramData\Yumeiro\data` | 数据（加密 JSON 或 PostgreSQL 之外的文件、客户端安装包 `downloads`） |
| `...\config\yumeiro.env` | 配置（修改后重启任务：`Stop-ScheduledTask Yumeiro; Start-ScheduledTask Yumeiro`） |
| `...\secrets` | 加密密钥、管理员初始密码、运行器令牌（只有对应服务账号能读） |
| `...\backups` | 每日 03:30 的自动备份（保留 14 份）+ 升级前备份（程序文件留 3 份） |
| `...\logs` | `yumeiro.log`、`updater.log`，运行器与沙箱在 `logs\runner`；超过 5 MB 自动轮转 |

用**计划任务**当系统服务（开机自启，崩溃后 1 分钟自动重启），每个任务使用独立的低权限本地账号：

| 任务 | 账号 | 作用 |
|---|---|---|
| `Yumeiro` | `yumeiro` | 主服务 |
| `Yumeiro-Updater` | SYSTEM | 网页更新器（只监听 127.0.0.1，令牌认证） |
| `Yumeiro-Runner` / `Yumeiro-Sandbox` | `yumeiro-runner` / `yumeiro-sandbox` | 智能体运行器 / 代码沙箱（装了 `-WithRunner` 才有） |
| `Yumeiro-Backup` | SYSTEM | 每日备份 |
| `Yumeiro-Caddy` | `yumeiro-caddy` | HTTPS（执行过 `https` 才有） |

## 四、日常操作
```powershell
.\deploy\yumeiro-windows.ps1 status             # 服务状态与健康检查
.\deploy\yumeiro-windows.ps1 backup             # 立即备份
.\deploy\yumeiro-windows.ps1 engines            # 安装 / 升级 Claude Code、Codex、Pi
.\deploy\yumeiro-windows.ps1 clients C:\clients # 上传 Yumeiro-Setup-*.exe / Portable / APK（见《客户端安装包上传说明》）
.\deploy\yumeiro-windows.ps1 https              # 自签名 HTTPS（端口 8443，可用 -TlsPort / -Ip / -Cert / -Key）
.\deploy\yumeiro-windows.ps1 https -Domain example.com   # 自动申请证书（域名解析到本机，放行 80/443）
.\deploy\yumeiro-windows.ps1 run                # 前台运行（调试，Ctrl+C 停止）
.\deploy\yumeiro-windows.ps1 uninstall          # 卸载服务与程序，数据保留；加 -PurgeData 连数据一起删
```

## 五、升级
**方式一：网页一键更新**（推荐）。管理员打开「更新」页，点「检查更新」→「下载并安装」。服务器自己从 GitHub 发布页下载服务端安装包，用内置公钥验签，再由 SYSTEM 更新器**备份 → 替换程序 → 安装依赖 → 重启 → 等健康检查**；新版本起不来会自动回滚到旧版本。也可以手动上传 `Yumeiro-x.y.z.zip`。

**更新仓库**：Windows 安装版使用独立的 `yumeiro-ai/yumeiro-windows` 发布仓库；Linux 直装版和 Docker 版继续使用 `yumeiro-ai/yumeiro`。安装时会自动写入对应的发布源，不需要手动修改。Windows 更新包必须从 Windows 仓库的 Release 下载。


```powershell
.\deploy\yumeiro-windows.ps1 update             # 降级才需要加 -AllowDowngrade
```

升级前一定会备份数据和程序文件，数据备份保留在 `...\backups`，回滚不会覆盖升级期间的新数据。

## 六、智能体运行器与代码沙箱的隔离（重要）
Windows 没有容器。隔离靠三层，**强度弱于 Docker 版**：

1. **独立的低权限账号**：运行器 `yumeiro-runner`、沙箱 `yumeiro-sandbox`、主服务 `yumeiro` 互相独立，都不是管理员，不属于任何组，不能交互登录。
2. **NTFS 权限**：运行器读不到主服务的数据、密钥和配置；沙箱只能写自己的目录，读不到运行器令牌；主服务程序目录对所有服务账号只读。
3. **防火墙**：沙箱账号被 Windows 防火墙禁止一切出站，沙箱里的代码连不了网，也连不到本机的其他服务。

局限：没有内存 / 进程数 / CPU 的硬限制（只有超时和输出上限）；沙箱命令用 **PowerShell** 而不是 bash（语言可选 Python / Node.js / PowerShell；装了 Git for Windows 想用 bash 的，在 `config\runner\sandbox.env` 里加一行 `SANDBOX_SHELL=posix`，升级时脚本会保留你加的行）。需要强隔离的场景请用 Docker 版，或在 Windows 上用 WSL2 装 Linux 直装版。管理设置 →「引擎与隔离自检」会实际检查：是否以管理员运行、能不能读到不该读的目录、环境变量是否最小。

## 六点五、Docker 功能（Cindy 桌面端容器等）
有些功能要用 **Linux 容器**：Cindy 桌面端容器（浏览器里的远程桌面）、自建语音识别、本机 PostgreSQL。Windows Server 自带的 Docker 只能跑 Windows 容器，所以我们用 **WSL2**：启用 WSL2，在一个专用的 Ubuntu 发行版 `Yumeiro-Docker`（放在 `数据目录\docker`）里装 Docker 官方引擎。**不使用 Docker Desktop**（它在服务器版上不受支持，商用还有授权限制）。

安装向导里有「Docker 功能」一页，勾选即可（静默安装用 `/DOCKER=1 /DESKTOP=global|cn`）；以后也能随时在命令行里装：

```powershell
.\deploy\yumeiro-windows.ps1 docker install                      # 装 Docker 运行环境
.\deploy\yumeiro-windows.ps1 docker install -DesktopRegion cn    # 同时装 Cindy 桌面端容器（global 国际版 / cn 国内版）
.\deploy\yumeiro-windows.ps1 docker status                       # 看状态：WSL、发行版、Docker 引擎、容器
.\deploy\yumeiro-windows.ps1 docker desktop -DesktopRegion global   # 单独（重新）安装桌面端容器
.\deploy\yumeiro-windows.ps1 docker cli -DockerArgs "ps -a"      # 在专用发行版里执行 docker 命令
.\deploy\yumeiro-windows.ps1 docker remove                       # 取消 Docker 环境（加 -PurgeData 才删发行版和镜像）
```

**要求**：Windows Server 2022 或更新（Windows Server 2019 不支持 WSL2；Windows 10 2004 以上也可以）；至少 10 GB 空闲磁盘；需要联网。脚本会先做预检，不满足会明确说明原因，**不会动系统**。

**云服务器注意**：WSL2 要用到虚拟化。物理机需要在 BIOS 里开启 VT-x / AMD-V；云服务器（虚拟机）要选**支持嵌套虚拟化**的实例规格，很多云厂商默认不开放，这种机器上 WSL2 会启动失败——脚本会识别常见报错并给出原因，Docker 以外的功能不受影响。这种情况建议改用 Linux 服务器跑需要 Docker 的功能。

**重启**：第一次启用 WSL2 / 虚拟机平台需要重启服务器。脚本会登记一个开机任务，**重启后自动继续**（进度见日志目录的 `docker-setup.log`），不用再操作。

**怎么运行的**：所有 WSL 操作都由 SYSTEM 身份执行（WSL 的发行版是按 Windows 账号登记的，开机自启任务才找得到它）；任务 `Yumeiro-WSL` 让 WSL 虚拟机保持运行，容器设了自动重启。桌面端容器的端口只发布在本机回环地址（浏览器桌面 6080、更新状态 8789、AI 接口 8788），由主服务反向代理，不对外开放；主服务通过 `DESKTOP_VIEW_URL` / `DESKTOP_STATUS_URL` / `DESKTOP_KEY_FILE` 连它（脚本自动写好）。装好后：网页管理员登录 → 管理设置 → 桌面端 → 打开桌面，登录 Cindy；在 AI 接入里添加服务商，接口地址 `http://127.0.0.1:8788/v1`，密钥见 `secrets\desktop\desktop_key`。

**安全**：下载的 Ubuntu 镜像用官方 `SHA256SUMS` 校验；Docker 的 apt 签名密钥会校验指纹（`9DC8 5822 9FC7 DD38 854A E2D8 8D81 803C 0EBF CD88`），不对就停止；发行版里关闭了和 Windows 的互操作。

**卸载**：卸载向导会列出并取消 Docker 环境：停止容器、删除开机任务。发行版（含镜像和桌面端的登录数据）和 `数据目录\docker` 属于数据，**默认保留**，勾选“同时删除全部数据”才会 `wsl --unregister` 并删除。Windows 的 WSL / 虚拟机平台功能是系统组件，可能被别的软件使用，**不会被关闭**；确定不用了可以自己在“Windows 功能”里关。

## 七、备份与恢复
备份文件是 `data-时间.tar.gz`，用系统自带的 `tar.exe` 压缩。恢复：停止服务后把备份解压回数据目录，再启动：

```powershell
Stop-ScheduledTask Yumeiro
tar.exe -xzf C:\ProgramData\Yumeiro\backups\data-20261123-033000.tar.gz -C C:\ProgramData\Yumeiro\data
Start-ScheduledTask Yumeiro
```
使用 PostgreSQL 时，数据库本身请用 `pg_dump` 另行备份。

## 八、常见问题
- **脚本被禁止运行**：先执行 `Set-ExecutionPolicy -Scope Process Bypass`。
- **访问不了**：`status` 看健康检查；检查云服务器安全组是否放行端口；日志在 `...\logs\yumeiro.log`。
- **端口被占用**：安装时加 `-Port` 换一个。
- **运行器里找不到 Claude Code / Codex / Pi**：执行 `engines`；国内服务器加 `-NpmRegistry https://registry.npmmirror.com`；Claude Code 还需要 Git for Windows。
- **网页更新提示不可用**：`Get-ScheduledTask Yumeiro-Updater` 看状态，日志在 `logs\updater.log`；更新器令牌在 `secrets\updater_token`。
- **杀毒软件拦截 / 删除 node.exe**：把 `C:\Yumeiro` 加入排除项。

## 九、与 Linux 直装版的差别
| | Linux 直装版 | Windows 服务器版 |
|---|---|---|
| 服务管理 | systemd | 计划任务（开机自启 + 崩溃重启） |
| 首次网页安装向导（`/setup`） | 有 | 没有，全部用 `install` 命令行完成 |
| 运行器 / 沙箱隔离 | systemd 沙箱加固 | 低权限账号 + NTFS 权限 + 防火墙（较弱） |
| 沙箱命令 | bash，有 ulimit 资源限制 | PowerShell，仅超时 / 输出上限 |
| HTTPS | nginx / Caddy | Caddy |
