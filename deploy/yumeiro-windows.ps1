<#
.SYNOPSIS
  Yumeiro 私有工作空间 · Windows 服务器版（直接装在 Windows 上，用计划任务当系统服务，崩溃自动重启）

.DESCRIPTION
  用管理员 PowerShell 在解压出来的发布包目录里运行（路径里的 Yumeiro 目录就是发布包根目录）：

    .\deploy\yumeiro-windows.ps1 install   [选项]   首次安装（可重复执行，已有配置和数据不会被覆盖）
    .\deploy\yumeiro-windows.ps1 update             升级到当前目录里的新版本（先备份，起不来自动回滚）
    .\deploy\yumeiro-windows.ps1 engines            安装 / 升级 Claude Code、Codex、Pi（重复执行即升级到最新版）
    .\deploy\yumeiro-windows.ps1 backup             立即备份数据（含全部文件版本）
    .\deploy\yumeiro-windows.ps1 status             查看服务状态与健康检查
    .\deploy\yumeiro-windows.ps1 https              用 Caddy 提供 HTTPS（填 -Domain 自动申请证书，否则自签名）
    .\deploy\yumeiro-windows.ps1 clients <文件夹>    把客户端安装包上传到下载目录
    .\deploy\yumeiro-windows.ps1 scrub-admin        首次登录成功后，删除服务器上保存的管理员初始密码
    .\deploy\yumeiro-windows.ps1 run                前台运行（调试用，Ctrl+C 停止）
    .\deploy\yumeiro-windows.ps1 uninstall          卸载服务与程序（默认保留数据和备份，加 -PurgeData 才删）

  install 选项：
    -Port N             监听端口，默认 8787
    -Domain example.com 前面有 HTTPS 反向代理时填写；服务只监听 127.0.0.1，并启用安全 Cookie
    -AdminEmail X       管理员邮箱，默认 admin@example.com
    -Personal           个人使用模式：隐藏成员/邀请等团队功能
    -WithRunner         同时安装智能体运行器和代码沙箱（独立低权限账号），并自动装好 Claude Code / Codex / Pi
    -NoEngines          配合 -WithRunner：只装运行器，不装三个引擎（以后用 engines 子命令装）
    -PgUrl URL          使用外部 PostgreSQL（默认用加密 JSON 文件存储，小团队足够）
    -ModelUrl/-ModelName/-ModelKey  预设一个 OpenAI 兼容模型（也可以以后在管理设置里加）
    -NpmRegistry URL    npm 镜像（国内可用 https://registry.npmmirror.com）
    -InstallNode        没有 Node.js 22+ 时自动安装官方版本到 <Prefix>\node（不加则会询问；-Yes 表示全部同意）
    -NodeMirror M       Node.js 下载源：official | cn（国内镜像）| 自定义地址
    -Prefix DIR         程序安装目录，默认 C:\Yumeiro
    -DataRoot DIR       数据 / 配置 / 密钥 / 备份目录，默认 C:\ProgramData\Yumeiro
    -NoService          只安装文件和配置，不建账号 / 计划任务 / 防火墙规则（不需要管理员；用 run 前台启动）
    -Yes                所有询问都当作“是”（无人值守）
#>
[CmdletBinding()]
param(
  [Parameter(Position = 0)][ValidateSet('install', 'update', 'engines', 'backup', 'status', 'https', 'clients', 'docker', 'scrub-admin', 'run', 'uninstall', 'help')][string]$Command = 'help',
  [Parameter(Position = 1)][string]$Arg1 = '',
  [Parameter(Position = 2)][string]$Arg2 = '',
  [string]$DesktopRegion = '',       # docker 功能：安装 Cindy 桌面端容器，区域 global（国际版）或 cn（国内版）；留空 = 不装
  [switch]$WithDocker,               # 安装时顺便装 Docker 运行环境（WSL2 + 专用 Ubuntu + Docker 引擎）
  [string]$DockerArgs = '',          # docker cli 子命令要传给 docker 的参数
  [switch]$Resume,                   # 重启后自动继续 Docker 安装时用
  [string]$Prefix = 'C:\Yumeiro',
  [string]$DataRoot = 'C:\ProgramData\Yumeiro',
  [int]$Port = 8787,
  [string]$Domain = '',
  [string]$AdminEmail = 'admin@example.com',
  [switch]$Personal,
  [switch]$WithRunner,
  [switch]$NoEngines,
  [string]$PgUrl = '',
  [string]$ModelUrl = '',
  [string]$ModelName = '',
  [string]$ModelKey = '',
  [string]$NpmRegistry = '',
  [switch]$InstallNode,
  [string]$NodeMirror = '',
  [int]$BackupKeep = 14,
  [int]$TlsPort = 8443,
  [string]$Cert = '',
  [string]$Key = '',
  [string]$Ip = '',
  [string]$ClientsDir = '',
  [switch]$PurgeData,
  [string]$ResultFile = '',
  [switch]$NoService,
  [switch]$AllowDowngrade,
  # —— 安装向导（exe）传进来的设置；命令行也可以直接用 ——
  [string]$AdminPasswordFile = '',   # 管理员密码放在这个文件里（不放命令行，免得进程列表里能看到）；读完即删
  [string]$AnswersFile = '',         # 图形安装向导把所有选择写在这个文件里（每行 KEY=VALUE），读完即删；密码 / 数据库地址 / API Key 都只走这里
  [string]$AdminPasswordText = '',
  [string]$ModelKeyFile = '',        # 模型 API Key 同理
  [string]$Engines = '',             # 要装的引擎，逗号分隔：claude,codex,pi；留空 = 三个都装
  [switch]$WithHttps,                # 安装后顺便启用 HTTPS（Caddy）：配了 -Domain 自动申请证书，否则自签名
  [switch]$NoUpdater,                # 不启用“网页一键更新”
  [switch]$NoBackupTask,             # 不建每日自动备份任务
  [switch]$NoFirewall,               # 不在 Windows 防火墙里放行端口
  [switch]$NoClients,                # 不发布发布包里自带的客户端安装包
  [switch]$Yes
)

$ErrorActionPreference = 'Stop'
$script:ScriptBound = $PSBoundParameters   # 函数里的 $PSBoundParameters 是函数自己的，这里留一份脚本命令行上明确给了哪些参数
$ProgressPreference = 'SilentlyContinue'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch { }

function Say($m) { Write-Host $m }
function Ok($m) { Write-Host ("OK  " + $m) -ForegroundColor Green }
function Warn($m) { Write-Host ("!   " + $m) -ForegroundColor Yellow }
function Die($m) { Write-Host ("X   " + $m) -ForegroundColor Red; exit 1 }

# ---------- 路径（install 会把选择存进 install.json，之后的子命令不用再传 -Prefix / -DataRoot）----------
$Source = Split-Path -Parent $PSScriptRoot                      # 发布包根目录（deploy 的上一级）
$ConfigFileGuess = Join-Path (Join-Path $DataRoot 'config') 'install.json'
$Saved = $null
if (Test-Path $ConfigFileGuess) { try { $Saved = [IO.File]::ReadAllText($ConfigFileGuess, [Text.Encoding]::UTF8) | ConvertFrom-Json } catch { } }
if ($Saved -and $Command -ne 'install') {
  if (-not $PSBoundParameters.ContainsKey('Prefix')) { $Prefix = $Saved.prefix }
  if ($Saved.port) { $Port = [int]$Saved.port }
  if ($Saved.withRunner) { $WithRunner = [switch]$true }
}
$AppDir = Join-Path $Prefix 'app'
$NodeDir = Join-Path $Prefix 'node'
$EnginesDir = Join-Path $Prefix 'engines'
$ToolsDir = Join-Path $Prefix 'tools'
$ConfDir = Join-Path $DataRoot 'config'
$SecretsDir = Join-Path $DataRoot 'secrets'
$DataDir = Join-Path $DataRoot 'data'
$BackupDir = Join-Path $DataRoot 'backups'
$LogDir = Join-Path $DataRoot 'logs'
$WorkDir = Join-Path $DataRoot 'work'
$SandboxDir = Join-Path $DataRoot 'sandbox'
$ConfRunner = Join-Path $ConfDir 'runner'          # 运行器 / 沙箱自己的配置（不放在 ConfDir 根目录，免得它们读到主服务的数据库连接串）
$LogRunner = Join-Path $LogDir 'runner'
$RunnerSecretDir = Join-Path $SecretsDir 'runner'
$EnvFile = Join-Path $ConfDir 'yumeiro.env'
$InstallFile = Join-Path $ConfDir 'install.json'
$NodeExe = Join-Path $NodeDir 'node.exe'
$Launcher = Join-Path $AppDir 'deploy\windows\run-service.mjs'
$HostName = $env:COMPUTERNAME
$TaskApp = 'Yumeiro'; $TaskRunner = 'Yumeiro-Runner'; $TaskSandbox = 'Yumeiro-Sandbox'; $TaskUpdater = 'Yumeiro-Updater'; $TaskBackup = 'Yumeiro-Backup'; $TaskCaddy = 'Yumeiro-Caddy'
$UserApp = 'yumeiro'; $UserRunner = 'yumeiro-runner'; $UserSandbox = 'yumeiro-sandbox'

# ---------- 小工具 ----------
function Confirm-Yes($q) {
  if ($Yes) { return $true }
  if (-not [Environment]::UserInteractive) { return $false }
  try { $a = Read-Host ($q + ' [Y/n]') } catch { return $false }
  return -not ($a -match '^(n|no)$')
}
function Test-Admin {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  return (New-Object Security.Principal.WindowsPrincipal $id).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}
function Require-Admin { if (-not (Test-Admin)) { Die '需要管理员权限：请用“以管理员身份运行”的 PowerShell 重新执行（只想装文件、不建服务时加 -NoService）。' } }
function New-RandomText([int]$bytes = 24) {
  $b = New-Object byte[] $bytes
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create(); $rng.GetBytes($b); $rng.Dispose()
  return ([Convert]::ToBase64String($b) -replace '[+/=]', 'x')
}
function Write-Utf8($path, $text) { [IO.File]::WriteAllText($path, $text, (New-Object Text.UTF8Encoding($false))) }
# Windows PowerShell 5.1 的 Get-Content 默认按系统代码页读文件，UTF-8 的中文会乱码：统一显式按 UTF-8 读
function Read-Lines($path) { return [IO.File]::ReadAllText($path, [Text.Encoding]::UTF8) -split "`r?`n" | Where-Object { $_ -ne '' } }
function Ensure-Dir($path) { if (-not (Test-Path $path)) { New-Item -ItemType Directory -Force -Path $path | Out-Null } }
function Get-EnvValue($key) {
  if (-not (Test-Path $EnvFile)) { return '' }
  foreach ($line in (Read-Lines $EnvFile)) { if ($line -match ('^' + [regex]::Escape($key) + '=(.*)$')) { return $Matches[1].Trim() } }
  return ''
}
function Set-EnvValue($key, $value) {
  $lines = @(); if (Test-Path $EnvFile) { $lines = @(Read-Lines $EnvFile) }
  $found = $false
  $lines = $lines | ForEach-Object { if ($_ -match ('^' + [regex]::Escape($key) + '=')) { $found = $true; "$key=$value" } else { $_ } }
  if (-not $found) { $lines += "$key=$value" }
  Write-Utf8 $EnvFile (($lines -join "`r`n") + "`r`n")
}
function Remove-EnvValue($key) {
  if (-not (Test-Path $EnvFile)) { return }
  $lines = @(Read-Lines $EnvFile | Where-Object { $_ -notmatch ('^' + [regex]::Escape($key) + '=') })
  Write-Utf8 $EnvFile (($lines -join "`r`n") + "`r`n")
}
function Get-Port { $p = Get-EnvValue 'PORT'; if ($p) { return [int]$p } else { return $Port } }

# ---------- Node.js ----------
function Get-NodeMajor($exe) { try { $v = (& $exe -v) -replace '^v', ''; return [int]($v.Split('.')[0]) } catch { return 0 } }
function Find-Node {
  if (Test-Path $NodeExe) { return $NodeExe }
  # PATH 里可能有好几个 node.exe（有的是别的软件带的精简版，旁边没有 npm.cmd）：只认“版本够新且带 npm”的
  foreach ($c in @(Get-Command node.exe -All -ErrorAction SilentlyContinue)) {
    if ((Test-Path (Join-Path (Split-Path -Parent $c.Source) 'npm.cmd')) -and ((Get-NodeMajor $c.Source) -ge 22)) { return $c.Source }
  }
  foreach ($c in @(Get-Command node.exe -All -ErrorAction SilentlyContinue)) { if (Test-Path (Join-Path (Split-Path -Parent $c.Source) 'npm.cmd')) { return $c.Source } }
  return ''
}
function Install-NodeRuntime {
  $arch = if ([Environment]::Is64BitOperatingSystem) { if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' } } else { Die '不支持 32 位 Windows' }
  $bases = @('https://nodejs.org/dist', 'https://cdn.npmmirror.com/binaries/node')
  switch ($NodeMirror) { '' { } 'official' { $bases = @('https://nodejs.org/dist') } 'cn' { $bases = @('https://cdn.npmmirror.com/binaries/node', 'https://nodejs.org/dist') } default { $bases = @($NodeMirror.TrimEnd('/')) } }
  $tmp = Join-Path (Join-Path $Prefix 'tmp') ('node-' + [guid]::NewGuid().ToString('N'))   # 临时文件放在安装目录里：失败残留的也会随卸载一起删
  Ensure-Dir $tmp
  $done = $false
  foreach ($base in $bases) {
    Say "-> 从 $base 获取 Node.js 22 ..."
    try {
      $sums = (Invoke-WebRequest -UseBasicParsing -TimeoutSec 25 "$base/latest-v22.x/SHASUMS256.txt").Content
      $line = ($sums -split "`n" | Where-Object { $_ -match ("win-$arch.zip\s*$") } | Select-Object -First 1)
      if (-not $line) { Warn "$base 里没有 win-$arch 的安装包"; continue }
      $parts = $line.Trim() -split '\s+'; $want = $parts[0]; $file = $parts[1]
      $zip = Join-Path $tmp $file
      Invoke-WebRequest -UseBasicParsing -TimeoutSec 900 "$base/latest-v22.x/$file" -OutFile $zip
      $got = (Get-FileHash $zip -Algorithm SHA256).Hash.ToLower()
      if ($got -ne $want.ToLower()) { Warn '校验失败（下载不完整或被篡改），换下一个源'; continue }
      Expand-Archive -Path $zip -DestinationPath $tmp -Force
      $inner = Get-ChildItem $tmp -Directory | Where-Object { $_.Name -like 'node-v*' } | Select-Object -First 1
      if (-not $inner) { Warn '压缩包结构异常'; continue }
      if (Test-Path $NodeDir) { Remove-Item $NodeDir -Recurse -Force }
      Ensure-Dir (Split-Path $NodeDir)
      Move-Item $inner.FullName $NodeDir
      $done = $true; break
    } catch { Warn ("连不上或下载失败：" + $base + "（" + $_.Exception.Message + "）") }
  }
  Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
  if (-not $done) { Die "Node.js 下载失败。服务器访问不了官方源时：在能上网的电脑下载 node-v22.x-win-$arch.zip，解压到 $NodeDir（里面要有 node.exe）后重新运行。" }
  Ok ("已安装 Node.js " + (& $NodeExe -v) + " 到 $NodeDir")
}
function Ensure-Node {
  $n = Find-Node
  if ($n -and (Get-NodeMajor $n) -ge 22) {
    if ($n -ne $NodeExe -and -not $NoService) {
      # 系统里的 node 可能装在用户目录、服务账号读不到：复制一份到 <Prefix>\node
      Say "-> 把 Node.js 复制到 $NodeDir（服务账号不一定能读到系统里那份）"
      $src = Split-Path -Parent $n; Ensure-Dir $NodeDir; robocopy $src $NodeDir /E /NFL /NDL /NJH /NJS /NP | Out-Null
    }
    return
  }
  if ($n) { Warn ("检测到 Node.js " + (& $n -v) + "，版本太低（需要 22 或更高）") } else { Warn '没有检测到 Node.js' }
  if ($InstallNode -or (Confirm-Yes "要自动下载并安装官方 Node.js 22 到 $NodeDir 吗？")) { Install-NodeRuntime } else { Die '需要 Node.js 22+：请先安装，或加 -InstallNode 自动安装。' }
}
function Invoke-Npm([string[]]$npmArgs, [string]$workDir) {
  $npm = Join-Path (Split-Path -Parent $script:ActiveNode) 'npm.cmd'
  if (-not (Test-Path $npm)) { Die "找不到 npm：$npm" }
  $old = $env:PATH; $env:PATH = (Split-Path -Parent $script:ActiveNode) + ';' + $env:PATH
  # npm 的缓存和日志默认写在“执行安装的账号”的用户目录里（网页更新时是 SYSTEM 的），卸载碰不到：统一放进安装目录，卸载时一起删
  $oldCache = $env:npm_config_cache; $oldNotif = $env:npm_config_update_notifier
  $env:npm_config_cache = Join-Path $Prefix 'npm-cache'; $env:npm_config_update_notifier = 'false'
  $reg = @(); if ($NpmRegistry) { $reg = @('--registry', $NpmRegistry) }
  Push-Location $workDir
  try { & $npm @npmArgs @reg 2>&1 | ForEach-Object { Say ("   " + $_) }; return $LASTEXITCODE } finally { Pop-Location; $env:PATH = $old; $env:npm_config_cache = $oldCache; $env:npm_config_update_notifier = $oldNotif }
}

# ---------- 账号 / 权限 ----------
function Ensure-ServiceUser($name, $desc) {
  # 每次都重设一个随机密码（注册计划任务时用一次，不保存）；账号不能交互登录的限制靠“只给批处理权限 + 不加入任何组”
  $pw = New-RandomText 24; $sec = ConvertTo-SecureString $pw -AsPlainText -Force
  if (Get-LocalUser -Name $name -ErrorAction SilentlyContinue) { Set-LocalUser -Name $name -Password $sec }
  else { New-LocalUser -Name $name -Password $sec -Description $desc -PasswordNeverExpires -UserMayNotChangePassword -AccountNeverExpires | Out-Null }
  try { Remove-LocalGroupMember -Group 'Users' -Member $name -ErrorAction SilentlyContinue } catch { }
  return $pw
}
function Grant($path, $account, $perm) {   # perm: R 只读 / M 修改 / F 完全
  if (-not (Test-Path $path)) { return }
  icacls $path /grant:r ("$HostName\${account}:(OI)(CI)$perm") | Out-Null
}
function Lock-Dir($path, $rules) {          # 断开继承，只留 SYSTEM / Administrators 完全控制 + 指定账号
  Ensure-Dir $path
  icacls $path /inheritance:r /grant:r 'SYSTEM:(OI)(CI)F' 'Administrators:(OI)(CI)F' | Out-Null
  foreach ($r in $rules) { Grant $path $r[0] $r[1] }
}

# ---------- 计划任务 ----------
function Register-Svc($name, $desc, $user, $password, $exe, $argLine, $workDir) {
  $action = New-ScheduledTaskAction -Execute $exe -Argument $argLine -WorkingDirectory $workDir
  $trigger = New-ScheduledTaskTrigger -AtStartup
  $settings = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
  Unregister-ScheduledTask -TaskName $name -Confirm:$false -ErrorAction SilentlyContinue
  if ($user -eq 'SYSTEM') { Register-ScheduledTask -TaskName $name -Description $desc -Action $action -Trigger $trigger -Settings $settings -User 'SYSTEM' -RunLevel Highest | Out-Null }
  else { Register-ScheduledTask -TaskName $name -Description $desc -Action $action -Trigger $trigger -Settings $settings -User "$HostName\$user" -Password $password -RunLevel Limited | Out-Null }
}
function Svc-ArgLine($entry, $logName, $pre, $cwd, $envPath = $EnvFile, $logDir = $LogDir) {
  # 启动器的选项必须放在入口脚本前面
  $a = '"' + $Launcher + '" --env "' + $envPath + '" --log "' + (Join-Path $logDir $logName) + '" --cwd "' + $cwd + '"'
  if ($pre) { $a += ' --pre "' + $pre + '"' }
  return $a + ' ' + $entry
}
function Start-Svc($name) { if (Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue) { Start-ScheduledTask -TaskName $name } }
function Stop-Svc($name) {
  if (Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue) { Stop-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue }
}
function Test-Health([int]$seconds = 40) {
  $p = Get-Port; $deadline = (Get-Date).AddSeconds($seconds)
  while ((Get-Date) -lt $deadline) {
    try { $r = Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 "http://127.0.0.1:$p/api/health"; if ($r.StatusCode -eq 200) { return $true } } catch { }
    Start-Sleep -Milliseconds 800
  }
  return $false
}
function Stop-AllSvc { foreach ($t in @($TaskApp, $TaskRunner, $TaskSandbox, $TaskCaddy)) { Stop-Svc $t }; Start-Sleep -Seconds 2 }
function Start-AllSvc {
  Start-Svc $TaskUpdater
  Start-Svc $TaskApp
  if ($WithRunner) { Start-Svc $TaskSandbox; Start-Svc $TaskRunner }
  if (Get-ScheduledTask -TaskName $TaskCaddy -ErrorAction SilentlyContinue) { Start-Svc $TaskCaddy }
}

# ---------- 代码同步 / 依赖 ----------
function Sync-Code {
  Ensure-Dir $AppDir
  $xd = @('node_modules', '.git', 'logs', 'backups', 'secrets', '.update-work', '.cloudbase-demo', '.cindy-worktrees', 'Yumeiro-Clients', 'downloads', 'dist', 'build-tmp', '.gradle', '.kotlin')
  robocopy $Source $AppDir /MIR /NFL /NDL /NJH /NJS /NP /XD @xd /XF '.env' | Out-Null
  if ($LASTEXITCODE -ge 8) { Die "复制程序文件失败（robocopy 返回 $LASTEXITCODE）" }
  $global:LASTEXITCODE = 0
}
function Install-Deps {
  Say '-> 安装依赖（npm ci）...'
  $code = Invoke-Npm @('ci', '--omit=dev', '--no-audit', '--no-fund') $AppDir
  if ($code -ne 0) { throw 'npm ci 失败：检查网络，国内服务器可加 -NpmRegistry https://registry.npmmirror.com' }
}
function Get-AppVersion($dir) { try { return ([IO.File]::ReadAllText((Join-Path $dir 'package.json'), [Text.Encoding]::UTF8) | ConvertFrom-Json).version } catch { return '未知' } }

# ---------- 备份 ----------
function Invoke-Backup {
  Ensure-Dir $BackupDir
  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $file = Join-Path $BackupDir "data-$stamp.tar.gz"
  $tar = Join-Path (Join-Path $env:SystemRoot 'System32') 'tar.exe'   # 用系统自带的 bsdtar（PATH 里可能先有 Git 的 GNU tar，它不认 C:\ 路径）
  & $tar -czf $file --exclude=downloads --exclude=updates -C $DataDir . 2>&1 | Out-Null
  if ($LASTEXITCODE -ne 0) { Die '备份失败（需要系统自带的 tar.exe，Windows Server 2019 / Windows 10 1803 以上都有）' }
  Ok "已备份：$file"
  Get-ChildItem $BackupDir -Filter 'data-*.tar.gz' | Sort-Object Name -Descending | Select-Object -Skip $BackupKeep | Remove-Item -Force
  return $file
}

# ---------- 安装 ----------
function Test-PgConnection {
  # 外部 PostgreSQL：装服务之前先连一次，连不上就停在这里（比服务起来后才发现要好得多）
  if (-not $PgUrl) { return }
  Say '-> 测试 PostgreSQL 连接 ...'
  $js = "const {default:pg}=await import('pg');const c=new pg.Client({connectionString:process.env.YM_PG_URL,connectionTimeoutMillis:8000});try{await c.connect();await c.end()}catch(e){console.error(e.message);process.exit(3)}"
  $old = $env:YM_PG_URL; $env:YM_PG_URL = $PgUrl
  Push-Location $AppDir
  try { & $script:ActiveNode --input-type=module -e $js 2>&1 | ForEach-Object { Say ("   " + $_) }; $code = $LASTEXITCODE } finally { Pop-Location; $env:YM_PG_URL = $old }
  if ($code -ne 0) { throw 'PostgreSQL 连接失败：请检查地址、账号密码、防火墙和数据库是否允许这台服务器访问。' }
  Ok 'PostgreSQL 连接正常'
}
function Import-Answers($path) {
  # 向导的答案文件：UTF-16 / UTF-8 都行（ReadAllText 会按 BOM 判断）。命令行上明确给了的参数优先
  if (-not $path -or -not (Test-Path $path)) { return }
  $text = [IO.File]::ReadAllText($path)
  Remove-Item $path -Force -ErrorAction SilentlyContinue
  $a = @{}
  foreach ($line in ($text -split "`r?`n")) { if ($line -match '^([A-Za-z]+)=(.*)$') { $a[$Matches[1]] = $Matches[2] } }
  $bound = { param($n) $script:ScriptBound.ContainsKey($n) }
  if ($a.AdminEmail -and -not (& $bound 'AdminEmail')) { $script:AdminEmail = $a.AdminEmail }
  if ($a.AdminPassword) { $script:AdminPasswordText = $a.AdminPassword }
  if ($a.Port -and -not (& $bound 'Port')) { $script:Port = [int]$a.Port }
  if ($a.Domain -and -not (& $bound 'Domain')) { $script:Domain = $a.Domain }
  if ($a.Https -in @('self', 'domain')) { $script:WithHttps = [switch]$true }
  if ($a.PgUrl -and $a.Storage -eq 'postgres' -and -not (& $bound 'PgUrl')) { $script:PgUrl = $a.PgUrl }
  if ($a.ModelUrl) { $script:ModelUrl = $a.ModelUrl }
  if ($a.ModelName) { $script:ModelName = $a.ModelName }
  if ($a.ModelKey) { $script:ModelKey = $a.ModelKey }
  if ($a.Runner -eq '1') { $script:WithRunner = [switch]$true }
  if ($a.Runner -eq '1' -and -not $a.Engines) { $script:NoEngines = [switch]$true }
  if ($a.Engines) { $script:Engines = $a.Engines }
  if ($a.CN -eq '1') { $script:NodeMirror = 'cn'; $script:NpmRegistry = 'https://registry.npmmirror.com' }
  if ($a.Personal -eq '1') { $script:Personal = [switch]$true }
  if ($a.Backup -eq '0') { $script:NoBackupTask = [switch]$true }
  if ($a.WebUpdate -eq '0') { $script:NoUpdater = [switch]$true }
  if ($a.Firewall -eq '0') { $script:NoFirewall = [switch]$true }
  if ($a.Clients -eq '0') { $script:NoClients = [switch]$true }
  if ($a.Docker -eq '1') { $script:WithDocker = [switch]$true }
  if ($a.Desktop -in @('global', 'cn')) { $script:DesktopRegion = $a.Desktop }
  if ($a.NoService -eq '1') { $script:NoService = [switch]$true }
}
function Do-Install {
  Import-Answers $AnswersFile
  $dockerResult = 'none'; $script:RebootNeeded = $false
  if ($WithDocker -and $NoService) { Warn 'Docker 运行环境需要管理员权限和系统服务，-NoService 模式下跳过。'; $script:WithDocker = [switch]$false; $script:DesktopRegion = '' }
  if (-not $NoService) { Require-Admin }
  if ($Domain -and $Port -lt 1024) { Die '端口需要 1024 以上' }
  Say "== Yumeiro Windows 服务器版 $(Get-AppVersion $Source) · 安装到 $Prefix =="
  Ensure-Node
  $script:ActiveNode = Find-Node
  Ensure-Dir $Prefix; Ensure-Dir $DataDir; Ensure-Dir $ConfDir; Ensure-Dir $SecretsDir; Ensure-Dir $LogDir; Ensure-Dir $BackupDir
  Sync-Code
  Install-Deps
  Test-PgConnection

  # 密钥与配置：已有的不覆盖
  $keyFile = Join-Path $SecretsDir 'store_encryption_key'
  if (-not (Test-Path $keyFile)) { $b = New-Object byte[] 32; $r = [System.Security.Cryptography.RandomNumberGenerator]::Create(); $r.GetBytes($b); $r.Dispose(); Write-Utf8 $keyFile ([Convert]::ToBase64String($b)) }
  $adminFile = Join-Path $SecretsDir 'admin_password'; $firstPassword = ''; $passwordNote = 'existing'
  if (-not (Test-Path $EnvFile)) {
    if ($AdminPasswordFile -or $AdminPasswordText) {
      if ($AdminPasswordText) { $firstPassword = $AdminPasswordText.Trim() } else { $firstPassword = ([IO.File]::ReadAllText($AdminPasswordFile, [Text.Encoding]::UTF8)).Trim() }
      if ($AdminPasswordFile) { Remove-Item $AdminPasswordFile -Force -ErrorAction SilentlyContinue }
      if ($firstPassword.Length -lt 16 -or $firstPassword -match '^(change|replace|your-)') { throw '管理员密码至少 16 个字符，且不能以 change / replace / your- 开头' }
      $passwordNote = 'custom'
    } else { $firstPassword = 'Ym' + (New-RandomText 20); $passwordNote = 'generated' }
    Write-Utf8 $adminFile $firstPassword
  }
  if ($ModelKeyFile -and (Test-Path $ModelKeyFile)) { $ModelKey = ([IO.File]::ReadAllText($ModelKeyFile, [Text.Encoding]::UTF8)).Trim(); Remove-Item $ModelKeyFile -Force -ErrorAction SilentlyContinue }
  if ($ModelKey -and -not (Test-Path (Join-Path $SecretsDir 'model_api_key'))) { Write-Utf8 (Join-Path $SecretsDir 'model_api_key') $ModelKey }
  if (-not (Test-Path $EnvFile)) {
    $bind = '0.0.0.0'; $secure = 'false'; $proxy = 'false'
    if ($Domain -or $WithHttps) { $bind = '127.0.0.1'; $secure = 'true'; $proxy = 'true' }
    $e = @('# 由 yumeiro-windows.ps1 生成；修改后重启任务：Stop-ScheduledTask Yumeiro; Start-ScheduledTask Yumeiro',
      "PORT=$Port", "HOST=$bind", "DATA_DIR=$DataDir", "COOKIE_SECURE=$secure", "TRUST_PROXY=$proxy",
      "STORE_ENCRYPTION_KEY_FILE=$keyFile", "ADMIN_EMAIL=$($AdminEmail.ToLower())", "ADMIN_PASSWORD_FILE=$adminFile", "SERVICE_UPDATE_URL=https://api.github.com/repos/yumeiro-ai/yumeiro-windows/releases/latest")
    if ($Personal) { $e += 'YUMEIRO_USAGE=personal' }
    if ($PgUrl) { $e += 'STORAGE=postgres'; $e += "DATABASE_URL=$PgUrl" } else { $e += 'STORAGE=json' }
    if ($ModelUrl) { $e += "MODEL_BASE_URL=$ModelUrl" }
    if ($ModelName) { $e += "MODEL_NAME=$ModelName" }
    if (Test-Path (Join-Path $SecretsDir 'model_api_key')) { $e += "MODEL_API_KEY_FILE=$(Join-Path $SecretsDir 'model_api_key')" }
    Write-Utf8 $EnvFile (($e -join "`r`n") + "`r`n")
  } else { Warn "已存在 $EnvFile，保持不变（要改配置请直接编辑它）" }

  # 记录这次装了哪些东西：卸载时据此逐项取消，并告诉用户取消了什么
  $httpsMode = 'none'; if ($WithHttps) { if ($Domain) { $httpsMode = 'domain' } else { $httpsMode = 'self' } }
  $components = @{ docker = [bool]$WithDocker; desktop = $DesktopRegion; runner = [bool]$WithRunner; engines = @(if ($WithRunner -and -not $NoEngines) { Get-SelectedEngines }); https = $httpsMode; domain = $Domain; backupTask = (-not $NoBackupTask); updater = (-not $NoUpdater); firewall = (-not $NoFirewall); storage = $(if ($PgUrl) { 'postgres' } else { 'json' }); usage = $(if ($Personal) { 'personal' } else { 'team' }) }
  $info = @{ prefix = $Prefix; dataRoot = $DataRoot; port = (Get-Port); withRunner = [bool]$WithRunner; version = (Get-AppVersion $AppDir); installedAt = (Get-Date).ToString('s'); components = $components }
  Write-Utf8 $InstallFile ($info | ConvertTo-Json -Depth 4)

  if ($WithRunner) { Setup-Runner }
  if ($NoService) {
    Ok "文件和配置已就绪（-NoService：没有建账号和计划任务）。前台启动：.\deploy\yumeiro-windows.ps1 run -Prefix `"$Prefix`" -DataRoot `"$DataRoot`""
  } else {
    Setup-Services
    Start-AllSvc
    if (Test-Health 60) { Ok ("服务已启动：http://127.0.0.1:" + (Get-Port) + "/") } else { Warn "服务没有在 60 秒内就绪，请查看日志 $LogDir\yumeiro.log" }
    if ($WithHttps) { try { Do-Https } catch { Warn ("HTTPS 没有启用成功：" + $_.Exception.Message + "；可稍后执行 https 子命令重试") } }
    if ($WithDocker) {
      # Docker 运行环境（WSL2）：失败不影响其它功能；需要重启时先把剩下的步骤登记为开机任务，装完主体后再提示重启
      Say '== Docker 运行环境 =='
      try {
        $dc = Invoke-AsSystem 'install'
        if ($dc -eq 3010) { $script:RebootNeeded = $true; $dockerResult = 'reboot' } elseif ($dc -eq 0) { $dockerResult = 'ok' } else { $dockerResult = 'failed'; Warn 'Docker 运行环境没有装成功（其它功能不受影响），原因见上面的输出；可稍后执行 docker install 重试。' }
      } catch { $dockerResult = 'failed'; Warn ('Docker 运行环境没有装成功：' + $_.Exception.Message) }
    }
  }
  Show-Done $firstPassword
  Remove-Item (Join-Path $Prefix 'tmp') -Recurse -Force -ErrorAction SilentlyContinue   # 下载 Node.js / Caddy 的临时文件
  if ($ResultFile) {
    # 给图形安装程序（exe）读取：每行 KEY=VALUE。初始密码只有“自动生成”时才给（自己设置的不回显）
    $shown = ''; if ($passwordNote -eq 'generated') { $shown = $firstPassword }
    $scheme = 'http'; if ($httpsMode -ne 'none') { $scheme = 'https' }
    $res = @("URL=http://127.0.0.1:" + (Get-Port) + "/", "PORT=" + (Get-Port), "SCHEME=$scheme", "ADMIN_EMAIL=" + (Get-EnvValue 'ADMIN_EMAIL'), "ADMIN_PASSWORD=$shown", "PASSWORD_NOTE=$passwordNote", "DOCKER=$dockerResult", "VERSION=" + (Get-AppVersion $AppDir), "DATAROOT=$DataRoot")
    Write-Utf8 $ResultFile (($res -join "`r`n") + "`r`n")
  }
  Maybe-UploadClients
  if ($WithRunner -and -not $NoEngines) { Do-Engines }
  if ($script:RebootNeeded) { Warn '需要重启服务器：Docker 的 WSL2 刚启用，重启后会自动继续安装（进度见 logs\docker-setup.log）。'; exit 3010 }
}
function Setup-Services {
  $pwApp = Ensure-ServiceUser $UserApp 'Yumeiro server'
  # 程序目录：服务账号只读，不能改自己的代码；数据 / 日志可写；密钥只读
  Lock-Dir $AppDir @(@($UserApp, 'RX'), @($UserRunner, 'RX'), @($UserSandbox, 'RX'))
  Lock-Dir $DataDir @(@($UserApp, 'M'))
  Lock-Dir $LogDir @(@($UserApp, 'M'))
  Lock-Dir $ConfDir @(@($UserApp, 'R'))
  Lock-Dir $SecretsDir @()
  foreach ($f in @('store_encryption_key', 'admin_password', 'model_api_key')) { $p = Join-Path $SecretsDir $f; if (Test-Path $p) { icacls $p /grant:r ("$HostName\${UserApp}:R") | Out-Null } }
  icacls $SecretsDir /grant:r ("$HostName\${UserApp}:(RX)") | Out-Null
  Lock-Dir $BackupDir @()
  if ($Domain -eq '' -and -not $NoFirewall -and (Get-EnvValue 'HOST') -eq '0.0.0.0') {
    Remove-NetFirewallRule -DisplayName 'Yumeiro' -ErrorAction SilentlyContinue
    New-NetFirewallRule -DisplayName 'Yumeiro' -Direction Inbound -Action Allow -Protocol TCP -LocalPort (Get-Port) | Out-Null
  }
  $appArgs = Svc-ArgLine 'server.mjs' 'yumeiro.log' 'scripts\seed-wallpapers.mjs' $AppDir
  Register-Svc $TaskApp 'Yumeiro 私有工作空间' $UserApp $pwApp $script:ActiveNode $appArgs $AppDir
  if (-not $NoBackupTask) { Register-Backup }
  if ($WithRunner) { Setup-RunnerServices }
  if (-not $NoUpdater) { Setup-Updater }
  Ok '已注册计划任务 Yumeiro（开机自启、崩溃 1 分钟后自动重启）'
}
function Register-Backup {
  $ps = (Get-Command powershell.exe).Source
  $arg = '-NoProfile -ExecutionPolicy Bypass -File "' + (Join-Path $AppDir 'deploy\yumeiro-windows.ps1') + '" backup -Yes'
  $action = New-ScheduledTaskAction -Execute $ps -Argument $arg
  $trigger = New-ScheduledTaskTrigger -Daily -At 3:30am
  Unregister-ScheduledTask -TaskName $TaskBackup -Confirm:$false -ErrorAction SilentlyContinue
  Register-ScheduledTask -TaskName $TaskBackup -Description 'Yumeiro 每日备份' -Action $action -Trigger $trigger -User 'SYSTEM' -RunLevel Highest | Out-Null
}
# 网页一键更新：SYSTEM 身份的更新器（只监听 127.0.0.1，令牌认证）；网页进程通过 UPDATER_URL 调它。已存在时不重新注册（更新过程中它是父进程）
function Setup-Updater {
  $tok = Join-Path $SecretsDir 'updater_token'
  if (-not (Test-Path $tok)) { Write-Utf8 $tok (New-RandomText 32) }
  icacls $tok /grant:r ("$HostName\${UserApp}:R") | Out-Null
  $uport = 8789
  Set-EnvValue 'UPDATER_URL' ("http://127.0.0.1:" + $uport + "/")
  Set-EnvValue 'UPDATER_TOKEN_FILE' $tok
  $uenv = Join-Path $ConfDir 'updater.env'
  $lines = @("UPDATER_TOKEN_FILE=$tok", "UPDATER_PORT=$uport", "YUMEIRO_PREFIX=$Prefix", "YUMEIRO_DATAROOT=$DataRoot", "DATA_DIR=$DataDir")
  Write-Utf8 $uenv (($lines -join "`r`n") + "`r`n")
  if (-not (Get-ScheduledTask -TaskName $TaskUpdater -ErrorAction SilentlyContinue)) {
    $a = '"' + $Launcher + '" --env "' + $uenv + '" --log "' + (Join-Path $LogDir 'updater.log') + '" --cwd "' + $AppDir + '" deploy\windows\updater.mjs'
    Register-Svc $TaskUpdater 'Yumeiro 网页更新器' 'SYSTEM' '' $script:ActiveNode $a $AppDir
  }
}
# ---------- 智能体运行器 + 代码沙箱 ----------
# 没有容器，隔离靠三层：①独立的低权限本地账号（yumeiro-runner / yumeiro-sandbox，不属于任何组）
# ②NTFS 权限：运行器读不到主服务的数据、密钥、配置；沙箱只能写自己的目录 ③沙箱账号被 Windows 防火墙禁止一切出站（代码“断网”）
# 强度弱于 Docker 版：要强隔离请用 Docker 版或 WSL2。
function Write-EnvMerged($path, $generated) {
  # 重新生成运行器 / 沙箱的配置时，保留管理员自己加的行（比如 SANDBOX_SHELL=posix）：只覆盖脚本自己管的键
  $keys = @{}; foreach ($l in $generated) { if ($l -match '^([A-Za-z_][A-Za-z0-9_]*)=') { $keys[$Matches[1]] = $true } }
  $custom = @()
  if (Test-Path $path) { foreach ($l in (Read-Lines $path)) { if ($l -match '^([A-Za-z_][A-Za-z0-9_]*)=' -and -not $keys.ContainsKey($Matches[1])) { $custom += $l } } }
  Write-Utf8 $path (((@($generated) + $custom) -join "`r`n") + "`r`n")
}
function Setup-Runner {
  # 令牌 + 配置文件（账号和任务在 Setup-RunnerServices 里建）
  foreach ($d in @($RunnerSecretDir, $WorkDir, $SandboxDir, $ConfRunner, $LogRunner)) { Ensure-Dir $d }
  $rt = Join-Path $RunnerSecretDir 'runner_token'; $st = Join-Path $RunnerSecretDir 'sandbox_token'
  if (-not (Test-Path $rt)) { Write-Utf8 $rt (New-RandomText 36) }
  if (-not (Test-Path $st)) { Write-Utf8 $st (New-RandomText 36) }
  Set-EnvValue 'RUNNER_URL' 'http://127.0.0.1:8790'
  Set-EnvValue 'RUNNER_TOKEN_FILE' $rt
  $sys = Join-Path $env:SystemRoot 'System32'
  $ps5 = Join-Path $sys 'WindowsPowerShell\v1.0'
  $runnerPath = (@($EnginesDir, $NodeDir, $sys, $env:SystemRoot, $ps5) + @(Find-GitBin)) -join ';'
  $forbidden = (@($SecretsDir, $DataDir, $ConfDir, $BackupDir, $LogDir) -join ';')
  $runnerEnv = @('# 智能体运行器（由 yumeiro-windows.ps1 生成）', 'PORT=8790', 'HOST=127.0.0.1', "WORKSPACES_DIR=$WorkDir", "RUNNER_TOKEN_FILE=$rt",
    "SANDBOX_URL=http://127.0.0.1:8791", "SANDBOX_TOKEN_FILE=$st", "RUNNER_SELF_URL=http://127.0.0.1:8790", "PATH=$runnerPath", "RUNNER_FORBIDDEN_PATHS=$forbidden")
  Write-EnvMerged (Join-Path $ConfRunner 'runner.env') $runnerEnv
  $python = Get-Command python.exe -ErrorAction SilentlyContinue
  $sbxPath = (@($NodeDir, $sys, $env:SystemRoot, $ps5) + @(if ($python) { Split-Path -Parent $python.Source })) -join ';'
  $sandboxEnv = @('# 代码沙箱（由 yumeiro-windows.ps1 生成）', 'PORT=8791', 'HOST=127.0.0.1', 'SANDBOX_ONLY=1', "WORKSPACES_DIR=$SandboxDir", "SANDBOX_TOKEN_FILE=$st", "PATH=$sbxPath")
  Write-EnvMerged (Join-Path $ConfRunner 'sandbox.env') $sandboxEnv
}
function Find-GitBin {
  # Claude Code 在 Windows 上需要 Git for Windows（带 bash）；找得到就把它放进运行器的 PATH
  foreach ($p in @("$env:ProgramFiles\Git\cmd", "$env:ProgramFiles\Git\bin", "${env:ProgramFiles(x86)}\Git\cmd")) { if ($p -and (Test-Path (Join-Path $p 'git.exe'))) { return $p } }
  return $null
}
function Setup-RunnerServices {
  $pwRunner = Ensure-ServiceUser $UserRunner 'Yumeiro agent runner'
  $pwSandbox = Ensure-ServiceUser $UserSandbox 'Yumeiro code sandbox'
  Lock-Dir $WorkDir @(@($UserRunner, 'M'))
  Lock-Dir $SandboxDir @(@($UserSandbox, 'M'))
  Lock-Dir $LogRunner @(@($UserRunner, 'M'), @($UserSandbox, 'M'))
  Lock-Dir $ConfRunner @(@($UserRunner, 'R'), @($UserSandbox, 'R'))
  Lock-Dir $EnginesDir @(@($UserRunner, 'RX'))
  Lock-Dir $NodeDir @(@($UserApp, 'RX'), @($UserRunner, 'RX'), @($UserSandbox, 'RX'))
  # 运行器令牌：主服务和运行器能读；沙箱令牌：运行器和沙箱能读（沙箱读不到运行器令牌）
  Lock-Dir $RunnerSecretDir @()
  $rt = Join-Path $RunnerSecretDir 'runner_token'; $st = Join-Path $RunnerSecretDir 'sandbox_token'
  foreach ($u in @($UserApp, $UserRunner)) { icacls $rt /grant:r ("$HostName\${u}:R") | Out-Null }
  foreach ($u in @($UserRunner, $UserSandbox)) { icacls $st /grant:r ("$HostName\${u}:R") | Out-Null }
  # 沙箱账号：禁止一切出站（防火墙按账号的 SID 匹配；回复已接受的入站连接不受影响）
  $sid = (New-Object Security.Principal.NTAccount("$HostName\$UserSandbox")).Translate([Security.Principal.SecurityIdentifier]).Value
  Remove-NetFirewallRule -DisplayName 'Yumeiro-Sandbox-NoOutbound' -ErrorAction SilentlyContinue
  New-NetFirewallRule -DisplayName 'Yumeiro-Sandbox-NoOutbound' -Direction Outbound -Action Block -LocalUser ("D:(A;;CC;;;" + $sid + ")") | Out-Null
  $sandboxArgs = Svc-ArgLine 'runner\runner.mjs' 'sandbox.log' '' $AppDir (Join-Path $ConfRunner 'sandbox.env') $LogRunner
  $runnerArgs = Svc-ArgLine 'runner\runner.mjs' 'runner.log' '' $AppDir (Join-Path $ConfRunner 'runner.env') $LogRunner
  Register-Svc $TaskSandbox 'Yumeiro 代码沙箱' $UserSandbox $pwSandbox $script:ActiveNode $sandboxArgs $AppDir
  Register-Svc $TaskRunner 'Yumeiro 智能体运行器' $UserRunner $pwRunner $script:ActiveNode $runnerArgs $AppDir
  Ok '已注册运行器与沙箱（独立低权限账号；沙箱账号被防火墙禁止出站）'
}
function Get-SelectedEngines {
  $all = @('claude', 'codex', 'pi')
  if (-not $Engines) { return $all }
  $sel = @($Engines -split '[,;\s]+' | Where-Object { $_ })
  return @($all | Where-Object { $sel -contains $_ })
}
function Do-Engines {
  if (-not $WithRunner) { Die '这台服务器没有安装运行器：先用 install -WithRunner 安装。' }
  if (-not $NoService) { Require-Admin }
  $script:ActiveNode = Find-Node; if (-not $script:ActiveNode) { Die '没有找到 Node.js' }
  Ensure-Dir $EnginesDir
  $failed = 0
  $pkgs = @{ claude = '@anthropic-ai/claude-code'; codex = '@openai/codex'; pi = '@mariozechner/pi-coding-agent' }
  $selected = Get-SelectedEngines
  foreach ($name in $selected) {
    $pkg = $pkgs[$name]
    Say "安装 $pkg ..."
    $code = Invoke-Npm @('install', '-g', '--prefix', $EnginesDir, "$pkg@latest", '--no-audit', '--no-fund') $Prefix
    if ($code -eq 0) { Ok $pkg } else { Warn "$pkg 安装失败（国内服务器可加 -NpmRegistry https://registry.npmmirror.com）"; $failed++ }
  }
  foreach ($c in $selected) { if (Test-Path (Join-Path $EnginesDir "$c.cmd")) { Ok "$c 已安装" } else { Warn "$c 没有装上" } }
  if (-not (Find-GitBin)) { Warn '没有检测到 Git for Windows：Claude Code 在 Windows 上需要它（https://git-scm.com/download/win），装好后重新执行 engines。' }
  if (-not $NoService) { Stop-Svc $TaskRunner; Start-Sleep -Seconds 1; Setup-Runner; Setup-RunnerServices; Start-Svc $TaskRunner; Ok '运行器已重启，管理设置 → 智能体引擎 里能看到版本' }
  if ($failed -gt 0) { exit 1 }
}
function Do-Update {
  if (-not $NoService) { Require-Admin }
  if (-not (Test-Path $EnvFile)) { Die '还没有安装：请先运行 install。' }
  if ((Resolve-Path $Source).Path -eq (Resolve-Path $AppDir).Path) { Die '请在新版本解压出来的目录里运行 update（不是安装目录里的那份）。' }
  $script:ActiveNode = Find-Node; if (-not $script:ActiveNode) { Die '没有找到 Node.js' }
  $from = Get-AppVersion $AppDir; $to = Get-AppVersion $Source
  $lower = $false; try { $lower = ([version]$to) -lt ([version]$from) } catch { }
  if ($lower -and -not $AllowDowngrade) { Die "新版本 $to 低于当前版本 $from；确需降级请加 -AllowDowngrade。" }
  Say "== 升级 $from -> $to =="
  if ($Saved -and $Saved.components) {
    # 沿用安装时的选择（比如当时没开网页更新 / 没建备份任务），升级不能悄悄把它们打开
    $cc = $Saved.components
    $script:NoBackupTask = [switch](-not $cc.backupTask); $script:NoUpdater = [switch](-not $cc.updater); $script:NoFirewall = [switch](-not $cc.firewall)
    if (-not $script:ScriptBound.ContainsKey('Engines') -and $cc.engines) { $script:Engines = (@($cc.engines) -join ',') }
  }
  Stop-AllSvc
  Ensure-Dir $BackupDir
  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $tar = Join-Path (Join-Path $env:SystemRoot 'System32') 'tar.exe'
  $codeBackup = Join-Path $BackupDir "code-$from-$stamp.tar.gz"
  & $tar -czf $codeBackup --exclude=node_modules -C $AppDir . 2>&1 | Out-Null
  if ($LASTEXITCODE -ne 0) { Start-AllSvc; Die '备份程序文件失败，已取消更新' }
  Invoke-Backup | Out-Null
  $failed = ''
  try {
    Sync-Code
    Install-Deps
    if ($WithRunner) { Setup-Runner }
    if (-not $NoService) { Setup-Services }
    $info = @{ prefix = $Prefix; dataRoot = $DataRoot; port = (Get-Port); withRunner = [bool]$WithRunner; version = $to; installedAt = (Get-Date).ToString('s'); components = $(if ($Saved) { $Saved.components } else { $null }) }
    Write-Utf8 $InstallFile ($info | ConvertTo-Json -Depth 4)
    Start-AllSvc
    if (-not (Test-Health 90)) { throw '新版本没有在 90 秒内就绪' }
  } catch { $failed = $_.Exception.Message }
  if ($failed) {
    Warn "新版本没有起来（$failed），正在恢复旧程序文件 ..."
    Stop-AllSvc
    Get-ChildItem $AppDir -Force | Where-Object { $_.Name -ne 'node_modules' } | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
    & $tar -xzf $codeBackup -C $AppDir 2>&1 | Out-Null
    try { Install-Deps } catch { Warn '恢复依赖失败，请手动执行 npm ci' }
    Start-AllSvc
    if (Test-Health 90) { Die "已回滚到 $from，服务已恢复。数据备份保留在 $BackupDir。" } else { Die "回滚后服务仍未就绪，请查看 $LogDir 里的日志；备份在 $BackupDir。" }
  }
  Get-ChildItem $BackupDir -Filter 'code-*.tar.gz' | Sort-Object Name -Descending | Select-Object -Skip 3 | Remove-Item -Force
  Maybe-UploadClients
  Ok "已升级到 $to"
}
# ---------- 客户端安装包（Windows 安装版 / 便携版、APK）----------
function Upload-Clients($dir) {
  if (-not (Test-Path $dir)) { throw "找不到文件夹：$dir" }
  if (-not (Get-ChildItem $dir -Filter 'Yumeiro-*' -ErrorAction SilentlyContinue)) { throw "$dir 里没有 Yumeiro-Setup-*.exe / Yumeiro-Portable-*.exe / Yumeiro-*.apk" }
  $script = Join-Path $AppDir 'scripts\install-clients.mjs'
  if (-not (Test-Path $script)) { throw "程序还没有安装（找不到 $script），请先 install" }
  if (-not $script:ActiveNode) { $script:ActiveNode = Find-Node }
  $old = $env:DATA_DIR; $env:DATA_DIR = $DataDir
  try { & $script:ActiveNode $script $dir --prune; if ($LASTEXITCODE -ne 0) { throw '上传脚本失败' } } finally { $env:DATA_DIR = $old }
  Ok "客户端安装包已上传到 $DataDir\downloads；网页里的“下载客户端”引导会自动出现按钮"
}
# install / update 之后：给了 -ClientsDir 就传；没给但解压目录里有 Yumeiro-Clients 文件夹也自动传；传失败不影响主流程
function Maybe-UploadClients {
  if ($NoClients) { return }
  $dir = $ClientsDir
  if (-not $dir -and (Test-Path (Join-Path $Source 'Yumeiro-Clients'))) { $dir = Join-Path $Source 'Yumeiro-Clients' }
  if (-not $dir) { if (-not (Get-ChildItem (Join-Path $DataDir 'downloads') -Filter 'Yumeiro-*' -ErrorAction SilentlyContinue)) { Say '客户端安装包：目前还没有。传法：.\deploy\yumeiro-windows.ps1 clients <装有 Yumeiro-Setup-*.exe / Yumeiro-*.apk 的文件夹>' }; return }
  try { Upload-Clients $dir } catch { Warn ("客户端安装包上传失败：" + $_.Exception.Message + "；可稍后手动执行 clients 子命令") }
}

# ---------- HTTPS（Caddy）----------
function Do-Https {
  Require-Admin
  if (-not (Test-Path $EnvFile)) { Die '还没有安装，请先 install' }
  $port = Get-Port
  $caddyDir = Join-Path $ToolsDir 'caddy'; $caddyExe = Join-Path $caddyDir 'caddy.exe'; $caddyData = Join-Path $DataRoot 'caddy'
  if (-not (Test-Path $caddyExe)) {
    Say '-> 下载 Caddy（官方发布，校验 SHA512）...'
    $rel = Invoke-RestMethod -UseBasicParsing -TimeoutSec 25 -Uri 'https://api.github.com/repos/caddyserver/caddy/releases/latest' -Headers @{ 'User-Agent' = 'yumeiro-installer' }
    $arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'amd64' }
    $zipAsset = $rel.assets | Where-Object { $_.name -match "^caddy_.*_windows_$arch\.zip$" } | Select-Object -First 1
    $sumAsset = $rel.assets | Where-Object { $_.name -match '_checksums\.txt$' } | Select-Object -First 1
    if (-not $zipAsset -or -not $sumAsset) { Die '没有在 Caddy 的发布页找到 Windows 安装包或校验文件' }
    $tmp = Join-Path (Join-Path $Prefix 'tmp') ('caddy-' + [guid]::NewGuid().ToString('N')); Ensure-Dir $tmp
    $zip = Join-Path $tmp $zipAsset.name
    Invoke-WebRequest -UseBasicParsing -TimeoutSec 600 -Uri $zipAsset.browser_download_url -OutFile $zip
    $sums = (Invoke-WebRequest -UseBasicParsing -TimeoutSec 25 -Uri $sumAsset.browser_download_url).Content
    $want = (($sums -split "`n") | Where-Object { $_ -match [regex]::Escape($zipAsset.name) } | Select-Object -First 1).Trim().Split(' ')[0].ToLower()
    $got = (Get-FileHash $zip -Algorithm SHA512).Hash.ToLower()
    if (-not $want -or $want -ne $got) { Remove-Item $tmp -Recurse -Force; Die 'Caddy 校验失败（下载不完整或被篡改），已取消' }
    Ensure-Dir $caddyDir; Expand-Archive -Path $zip -DestinationPath $caddyDir -Force; Remove-Item $tmp -Recurse -Force
  }
  Ensure-Dir $caddyData
  $upstream = "127.0.0.1:$port"
  if ($Domain) {
    $site = "$Domain {`r`n  encode gzip`r`n  reverse_proxy $upstream`r`n}"
    $url = "https://$Domain/"; $open = @(80, 443)
  } else {
    if (-not $Ip) { try { $Ip = (Invoke-RestMethod -UseBasicParsing -TimeoutSec 8 'https://api.ipify.org').Trim() } catch { Die '探测不到公网 IP：请用 -Ip 指定（证书里会写这个地址）' } }
    $tls = 'tls internal'; if ($Cert -and $Key) { $tls = "tls `"$Cert`" `"$Key`"" }
    $site = "https://${Ip}:$TlsPort {`r`n  $tls`r`n  encode gzip`r`n  reverse_proxy $upstream`r`n}"
    $url = "https://${Ip}:$TlsPort/"; $open = @($TlsPort)
  }
  $global = "{`r`n  storage file_system `"$caddyData`"`r`n  admin off`r`n}"
  $cf = Join-Path $ConfDir 'Caddyfile'
  Write-Utf8 $cf ($global + "`r`n" + $site + "`r`n")
  # 应用只听本机，并启用安全 Cookie / 反向代理信任
  Set-EnvValue 'HOST' '127.0.0.1'; Set-EnvValue 'COOKIE_SECURE' 'true'; Set-EnvValue 'TRUST_PROXY' 'true'
  Get-NetFirewallRule -DisplayName 'Yumeiro' -ErrorAction SilentlyContinue | Remove-NetFirewallRule
  Remove-NetFirewallRule -DisplayName 'Yumeiro-HTTPS' -ErrorAction SilentlyContinue
  New-NetFirewallRule -DisplayName 'Yumeiro-HTTPS' -Direction Inbound -Action Allow -Protocol TCP -LocalPort $open | Out-Null
  $pw = Ensure-ServiceUser 'yumeiro-caddy' 'Yumeiro HTTPS proxy'
  Lock-Dir $caddyDir @(@('yumeiro-caddy', 'RX'))
  Lock-Dir $caddyData @(@('yumeiro-caddy', 'M'))
  icacls $cf /grant:r ("$HostName\yumeiro-caddy:R") | Out-Null
  Register-Svc $TaskCaddy 'Yumeiro HTTPS（Caddy）' 'yumeiro-caddy' $pw $caddyExe ('run --config "' + $cf + '" --adapter caddyfile') $caddyDir
  Stop-Svc $TaskApp; Start-Sleep -Seconds 1; Start-Svc $TaskApp; Stop-Svc $TaskCaddy; Start-Svc $TaskCaddy
  Ok "HTTPS 已启用：$url"
  if (-not $Domain) { Warn '自签名证书：浏览器会提示不安全，需要点“继续访问”；要正式证书请用 -Domain（域名解析到本机，放行 80/443）或 -Cert / -Key 指定你自己的证书。' }
}
# ---------- Docker 支持：WSL2 + 专用 Ubuntu + Docker 引擎 ----------
# 为什么：Cindy 桌面端容器等功能是 Linux 容器；Windows Server 自带的 Docker 只能跑 Windows 容器。
# 做法：启用 WSL2，在专用发行版 Yumeiro-Docker（放在数据目录里）里装 Docker 官方引擎（不用 Docker Desktop）。
# WSL 的发行版是“按 Windows 账号”登记的：下面所有 wsl 操作都由 SYSTEM 身份执行，开机自启任务（也是 SYSTEM）才能找到它。
# 判断“能不能装、做哪几步”的逻辑在 docker-plan.mjs（有单元测试）；这里只负责收集系统事实和执行。
$DockerDistro = 'Yumeiro-Docker'
$DockerDir = Join-Path $DataRoot 'docker'
$DockerStateFile = Join-Path $ConfDir 'docker-setup.json'
$DockerLog = Join-Path $LogDir 'docker-setup.log'
$TaskWsl = 'Yumeiro-WSL'; $TaskDockerResume = 'Yumeiro-DockerResume'; $TaskDockerRun = 'Yumeiro-DockerSetup'
$PlanTool = Join-Path $PSScriptRoot 'windows\docker-plan.mjs'

function Get-TmpDir { $d = Join-Path $Prefix 'tmp'; Ensure-Dir $d; return $d }   # 临时文件都放在安装目录里，卸载时一起删
function ConvertTo-WslPath([string]$p) {
  $full = [IO.Path]::GetFullPath($p)
  $drive = $full.Substring(0, 1).ToLower()
  return '/mnt/' + $drive + ($full.Substring(2) -replace '\\', '/')
}
function Get-WslExe { return (Join-Path (Join-Path $env:SystemRoot 'System32') 'wsl.exe') }
function Invoke-Wsl([string[]]$wslArgs, [int]$timeoutSec = 300) {
  # wsl.exe 自己的输出是 UTF-16；WSL_UTF8=1 让它改用 UTF-8，再剔掉可能残留的 NUL
  $exe = Get-WslExe
  if (-not (Test-Path $exe)) { return @{ code = 127; out = 'wsl.exe 不存在' } }
  $env:WSL_UTF8 = '1'
  $psi = New-Object Diagnostics.ProcessStartInfo
  $psi.FileName = $exe; $psi.UseShellExecute = $false; $psi.CreateNoWindow = $true
  $psi.RedirectStandardOutput = $true; $psi.RedirectStandardError = $true
  $psi.StandardOutputEncoding = [Text.Encoding]::UTF8; $psi.StandardErrorEncoding = [Text.Encoding]::UTF8
  $psi.Arguments = (($wslArgs | ForEach-Object { if ($_ -match '[\s"]') { '"' + ($_ -replace '"', '\"') + '"' } else { $_ } }) -join ' ')
  $p = [Diagnostics.Process]::Start($psi)
  $o = $p.StandardOutput.ReadToEndAsync(); $e = $p.StandardError.ReadToEndAsync()
  if (-not $p.WaitForExit($timeoutSec * 1000)) { try { $p.Kill() } catch { }; return @{ code = 124; out = "wsl 命令超时（$timeoutSec 秒）" } }
  return @{ code = $p.ExitCode; out = (($o.Result + $e.Result) -replace "`0", '') }
}
function Invoke-WslLive([string[]]$wslArgs) {
  # 长命令（装 Docker、构建镜像）：边跑边把输出打到日志里；返回退出码
  $env:WSL_UTF8 = '1'
  $text = New-Object Text.StringBuilder
  & (Get-WslExe) @wslArgs 2>&1 | ForEach-Object { $line = ([string]$_) -replace "`0", ''; if ($line.Trim()) { Say ("   " + $line); [void]$text.AppendLine($line) } }
  $script:LastWslText = $text.ToString()
  return $LASTEXITCODE
}
function Write-DockerState($state, $detail = '') {
  Ensure-Dir $ConfDir
  $o = @{ state = $state; detail = $detail; desktop = $DesktopRegion; cn = ($NodeMirror -eq 'cn'); at = (Get-Date).ToString('s') }
  Write-Utf8 $DockerStateFile ($o | ConvertTo-Json)
}
function Read-DockerState { try { return [IO.File]::ReadAllText($DockerStateFile, [Text.Encoding]::UTF8) | ConvertFrom-Json } catch { return $null } }

function Get-DockerFacts {
  $os = Get-CimInstance Win32_OperatingSystem; $cs = Get-CimInstance Win32_ComputerSystem; $cpu = Get-CimInstance Win32_Processor | Select-Object -First 1
  $f = @{ isAdmin = (Test-Admin); arch = $env:PROCESSOR_ARCHITECTURE; build = [int]$os.BuildNumber; isServer = ($os.ProductType -ne 1); hypervisorPresent = [bool]$cs.HypervisorPresent; firmwareVirt = [bool]$cpu.VirtualizationFirmwareEnabled }
  foreach ($pair in @(@('wslFeature', 'Microsoft-Windows-Subsystem-Linux'), @('vmpFeature', 'VirtualMachinePlatform'))) {
    try { $f[$pair[0]] = (Get-WindowsOptionalFeature -Online -FeatureName $pair[1] -ErrorAction Stop).State.ToString() } catch { $f[$pair[0]] = 'Unknown' }
  }
  $f.pendingReboot = [bool]((Test-Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending') -or (Test-Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\WindowsUpdate\Auto Update\RebootRequired'))
  $f.distroExists = $false; $f.distroConfigured = $false; $f.dockerOk = $false; $f.desktopRunning = $false
  if ($f.wslFeature -eq 'Enabled' -and (Test-Path (Get-WslExe))) {
    $r = Invoke-Wsl @('-l', '-q') 30
    if ($r.code -eq 0 -and (($r.out -split "`r?`n" | ForEach-Object { $_.Trim() }) -contains $DockerDistro)) {
      $f.distroExists = $true
      $c = Invoke-Wsl @('-d', $DockerDistro, '-u', 'root', '--', 'grep', '-q', 'systemd=true', '/etc/wsl.conf') 60
      $f.distroConfigured = ($c.code -eq 0)
      $d = Invoke-Wsl @('-d', $DockerDistro, '-u', 'root', '--', 'docker', 'info', '--format', '{{.ServerVersion}}') 60
      $f.dockerOk = ($d.code -eq 0)
      if ($f.dockerOk) { $ps = Invoke-Wsl @('-d', $DockerDistro, '-u', 'root', '--', 'docker', 'ps', '-q', '--filter', 'name=desktop') 60; $f.desktopRunning = [bool]($ps.out.Trim()) }
    }
  }
  $f.bootTask = [bool](Get-ScheduledTask -TaskName $TaskWsl -ErrorAction SilentlyContinue)
  $f.desktop = [bool]($DesktopRegion -in @('global', 'cn'))
  return $f
}
function Get-DockerPlan {
  $facts = Get-DockerFacts
  $tmp = Join-Path (Get-TmpDir) ('ymdocker-' + [guid]::NewGuid().ToString('N') + '.json')
  Write-Utf8 $tmp ($facts | ConvertTo-Json)
  try { $json = & $script:ActiveNode $PlanTool plan $tmp; return ($json | ConvertFrom-Json) } finally { Remove-Item $tmp -Force -ErrorAction SilentlyContinue }
}
function Show-WslFailure([string]$text) {
  $tmp = Join-Path (Get-TmpDir) ('ymwsl-' + [guid]::NewGuid().ToString('N') + '.txt')
  Write-Utf8 $tmp $text
  try { $c = (& $script:ActiveNode $PlanTool classify $tmp) | ConvertFrom-Json; Warn $c.text; return $c } finally { Remove-Item $tmp -Force -ErrorAction SilentlyContinue }
}

function Register-DockerBootTask {
  # 让 WSL 虚拟机一直活着（没有进程在跑时 WSL 会自己关掉，里面的 Docker 和容器也就停了）
  $exe = Get-WslExe
  $action = New-ScheduledTaskAction -Execute $exe -Argument ('-d ' + $DockerDistro + ' -u root --exec /bin/sleep infinity')
  $trigger = New-ScheduledTaskTrigger -AtStartup
  $settings = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
  Unregister-ScheduledTask -TaskName $TaskWsl -Confirm:$false -ErrorAction SilentlyContinue
  Register-ScheduledTask -TaskName $TaskWsl -Description 'Yumeiro Docker 运行环境（WSL2）' -Action $action -Trigger $trigger -Settings $settings -User 'SYSTEM' -RunLevel Highest | Out-Null
  Start-ScheduledTask -TaskName $TaskWsl
}
function Register-DockerResume {
  # 启用 WSL2 后需要重启：注册一个开机任务，重启后自动继续（做完自己删掉）
  $ps = Join-Path (Join-Path $env:SystemRoot 'System32') 'WindowsPowerShell\v1.0\powershell.exe'
  $script = Join-Path $AppDir 'deploy\yumeiro-windows.ps1'; if (-not (Test-Path $script)) { $script = $PSCommandPath }
  $argLine = '-NoProfile -ExecutionPolicy Bypass -File "' + $script + '" docker run-install -Resume -Yes -Prefix "' + $Prefix + '" -DataRoot "' + $DataRoot + '"'
  if ($DesktopRegion) { $argLine += ' -DesktopRegion ' + $DesktopRegion }
  if ($NodeMirror -eq 'cn') { $argLine += ' -NodeMirror cn' }
  $action = New-ScheduledTaskAction -Execute $ps -Argument $argLine
  Unregister-ScheduledTask -TaskName $TaskDockerResume -Confirm:$false -ErrorAction SilentlyContinue
  Register-ScheduledTask -TaskName $TaskDockerResume -Description 'Yumeiro Docker 安装：重启后继续' -Action $action -Trigger (New-ScheduledTaskTrigger -AtStartup) -User 'SYSTEM' -RunLevel Highest | Out-Null
}

function Download-Rootfs([string]$dest) {
  $cn = ($NodeMirror -eq 'cn')
  $bases = @('https://cloud-images.ubuntu.com/wsl/jammy/current', 'https://mirrors.tuna.tsinghua.edu.cn/ubuntu-cloud-images/wsl/jammy/current')
  if ($cn) { $bases = @($bases[1], $bases[0]) }
  $arch = 'amd64'; if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { $arch = 'arm64' }
  foreach ($base in $bases) {
    try {
      Say "-> 从 $base 获取 Ubuntu 22.04 的 WSL 镜像 ..."
      $sumsFile = Join-Path (Get-TmpDir) ('ymsums-' + [guid]::NewGuid().ToString('N') + '.txt')
      Invoke-WebRequest -UseBasicParsing -TimeoutSec 30 "$base/SHA256SUMS" -OutFile $sumsFile
      $pick = (& $script:ActiveNode $PlanTool rootfs $sumsFile $arch) | ConvertFrom-Json
      Remove-Item $sumsFile -Force -ErrorAction SilentlyContinue
      if (-not $pick.file) { Warn "$base 里没有找到 $arch 的 WSL 镜像"; continue }
      Invoke-WebRequest -UseBasicParsing -TimeoutSec 1800 "$base/$($pick.file)" -OutFile $dest
      if ((Get-FileHash $dest -Algorithm SHA256).Hash.ToLower() -ne $pick.sha256) { Warn '镜像校验失败（下载不完整或被篡改），换下一个源'; Remove-Item $dest -Force -ErrorAction SilentlyContinue; continue }
      return $true
    } catch { Warn ("下载失败：" + $_.Exception.Message) }
  }
  return $false
}

function Docker-InitDesktop {
  $region = $DesktopRegion
  if ($region -notin @('global', 'cn')) { Warn '没有指定 Cindy 桌面端区域（global / cn），跳过桌面端容器'; return }
  Say "== Cindy 桌面端容器（$region）=="
  $dsec = Join-Path $SecretsDir 'desktop'; Ensure-Dir $dsec
  $keyF = Join-Path $dsec 'desktop_key'; $vncF = Join-Path $dsec 'vnc_password'
  if (-not (Test-Path $keyF)) { Write-Utf8 $keyF (New-RandomText 24) }
  if (-not (Test-Path $vncF)) { Write-Utf8 $vncF ((New-RandomText 12).Substring(0, 8)) }
  Lock-Dir $dsec @()
  icacls $keyF /grant:r ("$HostName\${UserApp}:R") | Out-Null     # 主服务要读它才能连桌面端
  $image = ''; if ($NodeMirror -eq 'cn') { $image = "export RUNNER_NODE_IMAGE='docker.m.daocloud.io/library/node:22-slim'" }
  $sh = @('#!/bin/bash', 'set -euo pipefail', ("cd '" + (ConvertTo-WslPath $AppDir) + "'"), ("export SECRETS_DIR='" + (ConvertTo-WslPath $dsec) + "' CINDY_FLAVOR='" + $region + "' CINDY_VERSION='latest'"), $image,
    'docker compose -p yumeiro-desktop -f deploy/windows/docker-desktop.yml up -d --build desktop', '') -join "`n"
  Ensure-Dir $DockerDir
  $shFile = Join-Path $DockerDir 'desktop-up.sh'
  [IO.File]::WriteAllText($shFile, $sh, (New-Object Text.UTF8Encoding($false)))
  $code = Invoke-WslLive @('-d', $DockerDistro, '-u', 'root', '--', 'bash', (ConvertTo-WslPath $shFile))
  if ($code -ne 0) { Show-WslFailure $script:LastWslText | Out-Null; throw '桌面端容器没有启动成功（构建镜像需要联网，国内服务器可使用国内镜像）' }
  # 主服务（原生运行在 Windows 上）经本机回环地址连桌面端容器
  Set-EnvValue 'DESKTOP_VIEW_URL' 'http://127.0.0.1:6080'
  Set-EnvValue 'DESKTOP_STATUS_URL' 'http://127.0.0.1:8789'
  Set-EnvValue 'DESKTOP_KEY_FILE' $keyF
  if (Get-ScheduledTask -TaskName $TaskApp -ErrorAction SilentlyContinue) { Stop-Svc $TaskApp; Start-Sleep -Seconds 1; Start-Svc $TaskApp }
  Ok '桌面端容器已启动'
  Say "接下来：1) 网页管理员登录 → 管理设置 → 桌面端 → 打开桌面（VNC 密码在 $vncF）"
  Say "        2) 在桌面里登录 Cindy 桌面端；桥接请求授权时点“允许”"
  Say "        3) 管理设置 → AI 接入 添加服务商：接口地址 http://127.0.0.1:8788/v1，密钥在 $keyF"
}

function Docker-RunInstall {
  Say '== Docker 运行环境（WSL2 + 专用 Ubuntu + Docker 引擎）=='
  $script:ActiveNode = Find-Node; if (-not $script:ActiveNode) { throw '没有找到 Node.js' }
  Ensure-Dir $DockerDir
  $plan = Get-DockerPlan
  foreach ($w in @($plan.warnings)) { Warn $w.text }
  if (-not $plan.ok) { foreach ($b in @($plan.blockers)) { Warn $b.text }; Write-DockerState 'blocked' (@($plan.blockers | ForEach-Object { $_.text }) -join ' '); return 2 }
  Say ('需要做的步骤：' + ((@($plan.steps)) -join ' → '))
  if (@($plan.steps).Count -eq 0) { Ok 'Docker 运行环境已经就绪' }
  $cn = '0'; if ($NodeMirror -eq 'cn') { $cn = '1' }
  foreach ($step in @($plan.steps)) {
    switch ($step) {
      'enableFeatures' {
        Say '-> 启用 WSL 和虚拟机平台 ...'
        foreach ($feat in @('Microsoft-Windows-Subsystem-Linux', 'VirtualMachinePlatform')) { $r = Enable-WindowsOptionalFeature -Online -FeatureName $feat -NoRestart -ErrorAction Stop; Say ("   $feat：" + $(if ($r.RestartNeeded) { '需要重启' } else { '已启用' })) }
      }
      'reboot' {
        Register-DockerResume
        Write-DockerState 'waiting-reboot' '已启用 WSL2，重启服务器后自动继续安装 Docker'
        Warn '需要重启服务器才能继续：重启后会自动接着安装 Docker（进度见 logs\docker-setup.log）。'
        return 3010
      }
      'wslUpdate' {
        Say '-> 更新 WSL ...'
        $code = Invoke-WslLive @('--update')
        if ($code -ne 0) { Say '   wsl --update 没有成功，改用 wsl --install --no-distribution ...'; $null = Invoke-WslLive @('--install', '--no-distribution') }
        $null = Invoke-WslLive @('--set-default-version', '2')
      }
      'importDistro' {
        $tar = Join-Path $DockerDir 'rootfs.tar.gz'
        if (-not (Download-Rootfs $tar)) { throw 'Ubuntu 的 WSL 镜像下载失败（检查网络；国内服务器可使用国内镜像）' }
        Say "-> 导入专用发行版 $DockerDistro ..."
        $code = Invoke-WslLive @('--import', $DockerDistro, (Join-Path $DockerDir 'wsl'), $tar, '--version', '2')
        if ($code -ne 0) { $c = Show-WslFailure $script:LastWslText; Write-DockerState 'failed' $c.text; return 1 }
        Remove-Item $tar -Force -ErrorAction SilentlyContinue
      }
      'configureDistro' {
        Say '-> 配置发行版（systemd、挂载选项、关闭和 Windows 的互操作）...'
        $conf = Join-Path $DockerDir 'wsl.conf'
        [IO.File]::WriteAllText($conf, (& $script:ActiveNode $PlanTool wslconf), (New-Object Text.UTF8Encoding($false)))
        $code = Invoke-WslLive @('-d', $DockerDistro, '-u', 'root', '--', 'cp', (ConvertTo-WslPath $conf), '/etc/wsl.conf')
        if ($code -ne 0) { $c = Show-WslFailure $script:LastWslText; Write-DockerState 'failed' $c.text; return 1 }
        $null = Invoke-Wsl @('--terminate', $DockerDistro) 60
        Start-Sleep -Seconds 3
        $null = Invoke-Wsl @('-d', $DockerDistro, '-u', 'root', '--', 'true') 120
      }
      'installDocker' {
        Say '-> 在发行版里安装 Docker 引擎（官方 apt 仓库，校验签名密钥指纹）...'
        $install = Join-Path $DockerDir 'install-docker.sh'
        [IO.File]::WriteAllText($install, (& $script:ActiveNode $PlanTool install-script), (New-Object Text.UTF8Encoding($false)))
        $code = Invoke-WslLive @('-d', $DockerDistro, '-u', 'root', '--', 'bash', (ConvertTo-WslPath $install), $cn)
        if ($code -ne 0) { $c = Show-WslFailure $script:LastWslText; Write-DockerState 'failed' $c.text; return 1 }
      }
      'bootTask' { Say '-> 注册开机自启（让 WSL 一直在后台运行）...'; Register-DockerBootTask }
      'desktop' { Docker-InitDesktop }
    }
  }
  Unregister-ScheduledTask -TaskName $TaskDockerResume -Confirm:$false -ErrorAction SilentlyContinue
  Write-DockerState 'done'
  Ok 'Docker 运行环境已就绪（在专用 WSL2 发行版 Yumeiro-Docker 里）。用 docker cli 子命令操作：.\deploy\yumeiro-windows.ps1 docker cli ps'
  return 0
}

function Docker-RunStatus {
  $script:ActiveNode = Find-Node
  $facts = Get-DockerFacts
  $state = Read-DockerState
  Say ('系统：Windows 内部版本 ' + $facts.build + $(if ($facts.isServer) { '（服务器版）' } else { '' }) + '；WSL：' + $facts.wslFeature + '；虚拟机平台：' + $facts.vmpFeature)
  Say ('专用发行版 ' + $DockerDistro + '：' + $(if ($facts.distroExists) { '已创建' } else { '没有' }) + '；Docker 引擎：' + $(if ($facts.dockerOk) { '运行中' } else { '没有运行' }) + '；开机自启任务：' + $(if ($facts.bootTask) { '有' } else { '没有' }))
  if ($state) { Say ('上次安装状态：' + $state.state + $(if ($state.detail) { '（' + $state.detail + '）' } else { '' })) }
  if ($facts.dockerOk) { $r = Invoke-Wsl @('-d', $DockerDistro, '-u', 'root', '--', 'docker', 'ps', '--format', '{{.Names}}  {{.Status}}') 60; Say '容器：'; Say $r.out }
  return 0
}

function Docker-RunRemove {
  # 取消 Docker 相关的设置：停容器、删开机任务；发行版（含镜像和桌面端登录数据）只在 -PurgeData 时才删
  $script:ActiveNode = Find-Node
  foreach ($t in @($TaskWsl, $TaskDockerResume)) { Stop-Svc $t; Unregister-ScheduledTask -TaskName $t -Confirm:$false -ErrorAction SilentlyContinue }
  $r = Invoke-Wsl @('-l', '-q') 30
  if ($r.code -eq 0 -and (($r.out -split "`r?`n" | ForEach-Object { $_.Trim() }) -contains $DockerDistro)) {
    $null = Invoke-Wsl @('-d', $DockerDistro, '-u', 'root', '--', 'docker', 'compose', '-p', 'yumeiro-desktop', 'down') 180
    $null = Invoke-Wsl @('--terminate', $DockerDistro) 60
    if ($PurgeData) { $null = Invoke-Wsl @('--unregister', $DockerDistro) 300; Ok "已删除专用发行版 $DockerDistro（含 Docker 镜像和桌面端数据）" }
    else { Ok "已停止 Docker；专用发行版 $DockerDistro 保留在 $DockerDir（含镜像和桌面端登录数据，以后重装可继续用）" }
  }
  if ($PurgeData -and (Test-Path $DockerDir)) { Remove-Item $DockerDir -Recurse -Force -ErrorAction SilentlyContinue }
  return 0
}

function Docker-RunCli {
  if (-not $DockerArgs) { Warn '用法：docker cli <docker 的参数>，例如 docker cli ps -a'; return 2 }
  $cmd = @('-d', $DockerDistro, '-u', 'root', '--', 'docker') + @($DockerArgs -split '\s+' | Where-Object { $_ })
  return (Invoke-WslLive $cmd)
}

function Invoke-DockerAction([string]$action) {
  switch ($action) {
    'install' { return (Docker-RunInstall) }
    'desktop' { $script:ActiveNode = Find-Node; try { Docker-InitDesktop; return 0 } catch { Warn $_.Exception.Message; return 1 } }
    'status' { return (Docker-RunStatus) }
    'remove' { return (Docker-RunRemove) }
    'cli' { return (Docker-RunCli) }
    default { Warn "未知的 docker 子命令：$action（可用：status install desktop cli remove）"; return 2 }
  }
}

# 以 SYSTEM 身份执行 docker 子命令：注册一个一次性任务，边跑边把它的日志打印出来，返回退出码
function Invoke-AsSystem([string]$action) {
  if ([Security.Principal.WindowsIdentity]::GetCurrent().IsSystem) { $res = @(Invoke-DockerAction $action); return [int]($res | Select-Object -Last 1) }
  Require-Admin
  Ensure-Dir $LogDir
  if (Test-Path $DockerLog) { Remove-Item $DockerLog -Force -ErrorAction SilentlyContinue }
  $ps = Join-Path (Join-Path $env:SystemRoot 'System32') 'WindowsPowerShell\v1.0\powershell.exe'
  $script = $PSCommandPath
  $argLine = '-NoProfile -ExecutionPolicy Bypass -File "' + $script + '" docker run-' + $action + ' -Yes -Prefix "' + $Prefix + '" -DataRoot "' + $DataRoot + '"'
  if ($DesktopRegion) { $argLine += ' -DesktopRegion ' + $DesktopRegion }
  if ($NodeMirror -eq 'cn') { $argLine += ' -NodeMirror cn' }
  if ($PurgeData) { $argLine += ' -PurgeData' }
  if ($Resume) { $argLine += ' -Resume' }
  if ($DockerArgs) { $argLine += ' -DockerArgs "' + $DockerArgs + '"' }
  Unregister-ScheduledTask -TaskName $TaskDockerRun -Confirm:$false -ErrorAction SilentlyContinue
  Register-ScheduledTask -TaskName $TaskDockerRun -Action (New-ScheduledTaskAction -Execute $ps -Argument $argLine) -Settings (New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Hours 3)) -User 'SYSTEM' -RunLevel Highest | Out-Null
  Start-ScheduledTask -TaskName $TaskDockerRun
  $pos = 0L
  do {
    Start-Sleep -Seconds 2
    if (Test-Path $DockerLog) {
      try {
        $fs = [IO.File]::Open($DockerLog, 'Open', 'Read', 'ReadWrite')
        try { $fs.Seek($pos, 'Begin') | Out-Null; $sr = New-Object IO.StreamReader($fs, [Text.Encoding]::UTF8); $chunk = $sr.ReadToEnd(); $pos = $fs.Position; if ($chunk) { Write-Host -NoNewline $chunk } } finally { $fs.Dispose() }
      } catch { }
    }
    $state = (Get-ScheduledTask -TaskName $TaskDockerRun -ErrorAction SilentlyContinue).State
  } while ($state -eq 'Running' -or $state -eq 'Queued')
  $code = (Get-ScheduledTaskInfo -TaskName $TaskDockerRun -ErrorAction SilentlyContinue).LastTaskResult
  Unregister-ScheduledTask -TaskName $TaskDockerRun -Confirm:$false -ErrorAction SilentlyContinue
  return [int]$code
}

function Do-Docker {
  $a = $Arg1; if (-not $a) { $a = 'status' }
  if ($a -like 'run-*') {
    # 内部入口：由上面的一次性任务（或重启后的继续任务）以 SYSTEM 身份调用；输出写进日志
    Ensure-Dir $LogDir
    try { Start-Transcript -Path $DockerLog -Append | Out-Null } catch { }
    $code = 1
    try { $res = @(Invoke-DockerAction ($a -replace '^run-', '')); $code = [int]($res | Select-Object -Last 1) } catch { Warn $_.Exception.Message; Write-DockerState 'failed' $_.Exception.Message } finally { try { Stop-Transcript | Out-Null } catch { } }
    exit $code
  }
  if ($a -eq 'cli' -and -not $DockerArgs -and $Arg2) { $script:DockerArgs = $Arg2 }
  $code = Invoke-AsSystem $a
  if ($code -eq 3010) { Warn '需要重启服务器：重启后会自动继续安装 Docker。' }
  exit $code
}
function Show-Done($firstPassword) {
  Say ''
  Say ('管理员邮箱：' + (Get-EnvValue 'ADMIN_EMAIL'))
  if ($firstPassword) {
    Say "管理员初始密码：$firstPassword"
    Say "（只显示这一次；首次登录后请改密码，然后执行 .\deploy\yumeiro-windows.ps1 scrub-admin 删除服务器上保存的初始密码）"
  }
  Say ('访问地址：http://<服务器IP>:' + (Get-Port) + '/（别忘了在云服务器安全组里放行该端口）')
  if ($Domain) { Say "你填了 -Domain：服务只监听本机。接着执行 .\deploy\yumeiro-windows.ps1 https -Domain $Domain 用 Caddy 自动申请证书（域名要解析到本机，放行 80/443）。" }
  else { Say '要 HTTPS：.\deploy\yumeiro-windows.ps1 https（自签名）或 https -Domain 你的域名（自动申请证书）。' }
}

# ---------- 其它子命令 ----------
function Do-Status {
  Say "版本：$(Get-AppVersion $AppDir)    安装目录：$Prefix    数据：$DataDir"
  foreach ($t in @($TaskApp, $TaskRunner, $TaskSandbox, $TaskUpdater, $TaskCaddy, $TaskBackup)) {
    $task = Get-ScheduledTask -TaskName $t -ErrorAction SilentlyContinue
    if ($task) { Say ("{0,-18} {1}" -f $t, $task.State) }
  }
  if (Test-Health 5) { Ok "健康检查通过（/api/health）" } else { Warn '健康检查没有通过' }
}
function Do-ScrubAdmin {
  Remove-EnvValue 'ADMIN_PASSWORD_FILE'
  $f = Join-Path $SecretsDir 'admin_password'; if (Test-Path $f) { Remove-Item $f -Force }
  Ok '已删除服务器上保存的管理员初始密码（管理员账号和你改过的密码不受影响）'
}
function Do-Run {
  $script:ActiveNode = Find-Node; if (-not $script:ActiveNode) { Die '没有找到 Node.js' }
  if (-not (Test-Path $Launcher)) { $script:AppDirRun = $Source } else { $script:AppDirRun = $AppDir }
  $run = Join-Path $script:AppDirRun 'deploy\windows\run-service.mjs'
  & $script:ActiveNode $run --env $EnvFile --log (Join-Path $LogDir 'yumeiro.log') --pre 'scripts\seed-wallpapers.mjs' --cwd $script:AppDirRun server.mjs
}
function Remove-Tree($path) {
  # 刚结束的进程可能还占着文件：重试几次，仍删不掉就如实告知，不假装成功
  for ($i = 0; $i -lt 5 -and (Test-Path $path); $i++) { Remove-Item $path -Recurse -Force -ErrorAction SilentlyContinue; if (Test-Path $path) { Start-Sleep -Seconds 2 } }
  if (Test-Path $path) { Warn "没能完全删除 $path（可能有文件被占用，重启后再手动删除）"; return $false }
  return $true
}
function Do-Uninstall {
  # 要清的东西里有计划任务 / 服务账号时才需要管理员；只有文件（比如 -NoService 装的）不用
  $hasSystemParts = [bool](Get-ScheduledTask -TaskName 'Yumeiro*' -ErrorAction SilentlyContinue) -or [bool](Get-LocalUser -Name 'yumeiro*' -ErrorAction SilentlyContinue)
  if ($hasSystemParts -and -not $NoService) { Require-Admin }
  # 逐项说明取消了什么（安装时的设置记在 install.json 里）
  $c = $null; if ($Saved -and $Saved.components) { $c = $Saved.components }
  Say '== 取消安装时的设置 =='
  if ($c) {
    if ($c.https -and $c.https -ne 'none') { Say ('-> 关闭 HTTPS（Caddy 反向代理' + $(if ($c.domain) { '，域名 ' + $c.domain } else { '，自签名证书' }) + '）：删除 Caddy 任务、账号和防火墙规则') }
    if ($c.runner) { Say ('-> 取消智能体运行器和代码沙箱：删除两个任务、两个专用账号，以及禁止沙箱出站的防火墙规则' + $(if ($c.engines -and @($c.engines).Count -gt 0) { '；删除引擎 ' + (@($c.engines) -join '、') } else { '' })) }
    if ($c.updater) { Say '-> 关闭网页一键更新：删除更新器任务和令牌' }
    if ($c.docker) { Say ('-> 取消 Docker 运行环境（WSL2 里的专用发行版 ' + $DockerDistro + '）' + $(if ($c.desktop) { '和 Cindy 桌面端容器（' + $c.desktop + '）' } else { '' }) + '：停止容器、删除开机自启任务；发行版和镜像按你的选择保留或删除。Windows 的 WSL / 虚拟机平台功能是系统组件，不会被关闭。') }
    if ($c.backupTask) { Say '-> 取消每日自动备份任务（已有的备份文件按你的选择保留或删除）' }
    if ($c.firewall) { Say ('-> 删除防火墙放行规则（端口 ' + $Port + '）') }
    Say '-> 删除开机自启的主服务和它的专用账号'
  } else { Say '-> 没有找到安装记录，按默认清单清理计划任务、防火墙规则和专用账号' }
  # Docker 运行环境（WSL2）：先停容器、删开机任务（发行版按 -PurgeData 决定删不删）
  if (($c -and $c.docker) -or (Get-ScheduledTask -TaskName $TaskWsl -ErrorAction SilentlyContinue) -or (Test-Path $DockerDir)) {
    try { $null = Invoke-AsSystem 'remove' } catch { Warn ('取消 Docker 运行环境时出错：' + $_.Exception.Message) }
  }
  if (-not (Confirm-Yes "确定卸载 Yumeiro 的服务和程序吗？数据和备份默认保留在 $DataRoot")) { Die '已取消' }
  # 1 计划任务（先停再删）和它们留下的进程
  foreach ($t in @($TaskApp, $TaskRunner, $TaskSandbox, $TaskUpdater, $TaskBackup, $TaskCaddy, $TaskWsl, $TaskDockerResume, $TaskDockerRun)) { Stop-Svc $t; Unregister-ScheduledTask -TaskName $t -Confirm:$false -ErrorAction SilentlyContinue }
  Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path.StartsWith($Prefix, [StringComparison]::OrdinalIgnoreCase) -and $_.Id -ne $PID } | Stop-Process -Force -ErrorAction SilentlyContinue
  # 2 防火墙规则
  Get-NetFirewallRule -DisplayName 'Yumeiro*' -ErrorAction SilentlyContinue | Remove-NetFirewallRule
  # 3 服务账号：先删它们的用户配置文件（C:\Users\yumeiro* 目录），再删账号
  foreach ($u in @($UserApp, $UserRunner, $UserSandbox, 'yumeiro-caddy')) {
    if (Get-LocalUser -Name $u -ErrorAction SilentlyContinue) {
      try { $sid = (Get-LocalUser -Name $u).SID.Value; Get-CimInstance Win32_UserProfile -ErrorAction SilentlyContinue | Where-Object { $_.SID -eq $sid } | Remove-CimInstance -ErrorAction SilentlyContinue } catch { }
      Remove-LocalUser -Name $u -ErrorAction SilentlyContinue
    }
  }
  Start-Sleep -Seconds 2
  # 4 程序目录（包含 Node.js、引擎、Caddy）；数据目录只在 -PurgeData 时才删
  $left = @()
  if ((Test-Path $Prefix) -and -not (Remove-Tree $Prefix)) { $left += $Prefix }
  if ($PurgeData -and (Test-Path $DataRoot)) { if (-not (Remove-Tree $DataRoot)) { $left += $DataRoot } }
  if ($left.Count -gt 0) { Warn ('还有残留：' + ($left -join '、')) }
  # 保留数据时，数据目录里“可以再生”的缓存也清掉：更新器的工作目录和已下载的安装包、沙箱临时目录、引擎的临时目录与 npm 缓存
  if (-not $PurgeData -and (Test-Path $DataRoot)) {
    foreach ($p in @((Join-Path $DataRoot 'update-work'), (Join-Path $DataDir 'updates'), $SandboxDir)) { if (Test-Path $p) { Remove-Tree $p | Out-Null } }
    foreach ($h in @(Get-ChildItem (Join-Path $WorkDir '.home') -Directory -ErrorAction SilentlyContinue)) {
      foreach ($sub in @('tmp', 'AppData\Local\npm-cache')) { $c = Join-Path $h.FullName $sub; if (Test-Path $c) { Remove-Tree $c | Out-Null } }
    }
  }
  if ($PurgeData) { Ok '程序、服务、账号、防火墙规则和数据都已删除' } else { Ok "程序、服务、账号和防火墙规则已卸载，数据保留在 $DataRoot（要连数据一起删，加 -PurgeData）" }
}

switch ($Command) {
  'install' { Do-Install }
  'update' { Do-Update }
  'engines' { Do-Engines }
  'https' { Do-Https }
  'docker' { Do-Docker }
  'clients' { if (-not $Arg1) { Die '用法：yumeiro-windows.ps1 clients <装有 Yumeiro-Setup-*.exe / Yumeiro-Portable-*.exe / Yumeiro-*.apk 的文件夹>' }; try { Upload-Clients $Arg1 } catch { Die $_.Exception.Message } }
  'status' { Do-Status }
  'backup' { Invoke-Backup | Out-Null }
  'scrub-admin' { Do-ScrubAdmin }
  'run' { Do-Run }
  'uninstall' { Do-Uninstall }
  'help' { Get-Help $PSCommandPath -Detailed }
  default { Die "子命令 $Command 还没有实现" }
}
