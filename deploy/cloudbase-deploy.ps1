param(
  [Parameter(Mandatory = $true)]
  [string]$EnvId,
  [string]$ServiceName = 'yumeiro'
)

$ErrorActionPreference = 'Stop'

if ($EnvId -eq '请替换为你的 CloudBase 环境 ID' -or [string]::IsNullOrWhiteSpace($EnvId)) {
  throw '请传入真实 CloudBase 环境 ID。'
}

if (-not (Get-Command npx -ErrorAction SilentlyContinue)) {
  throw '需要 Node.js/npm（包含 npx）。'
}

$config = Get-Content -Raw -LiteralPath 'cloudbaserc.json' | ConvertFrom-Json
$config.envId = $EnvId
$config.framework.plugins.container.inputs.serviceName = $ServiceName
$config | ConvertTo-Json -Depth 20 | Set-Content -Encoding utf8 -LiteralPath 'cloudbaserc.json'

Write-Host 'CloudBase 配置已写入 cloudbaserc.json。'
Write-Host '下一步：在 CloudBase 控制台为云托管服务配置 deploy/cloudbase.env.example 中的运行时变量，尤其是 DATABASE_URL、STORE_ENCRYPTION_KEY、ADMIN_PASSWORD。'
Write-Host '开始通过 CloudBase CLI 构建并部署容器……'
npx --yes @cloudbase/cli@latest framework deploy --envId $EnvId --force
