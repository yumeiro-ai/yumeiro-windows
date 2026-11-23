// Windows 服务器版的 Docker 支持：判断“能不能装、要做哪几步”的纯逻辑（任何系统上都能测试），
// 以及 WSL2 里装 Docker 引擎用的 bash 脚本。真正执行命令的是 deploy\yumeiro-windows.ps1 的 docker 子命令。
//
// 为什么走 WSL2：我们的 Docker 功能（Cindy 桌面端容器、自建语音识别、本机 PostgreSQL 等）都是 Linux 容器，而 Windows Server 自带的
// Docker 引擎只能跑 Windows 容器。办法是启用 WSL2，在一个专用的 Ubuntu 里装 Docker 引擎（不用 Docker Desktop：它在服务器版上不受支持，
// 商用还有授权限制）。
export const MIN_BUILD = { client: 19041, server: 20348 };    // Windows 10 2004 / Windows Server 2022
export const DISTRO = 'Yumeiro-Docker';
// Docker 官方 apt 仓库签名密钥的指纹（https://docs.docker.com/engine/install/ubuntu/ 公布的值）；安装脚本会逐字校验
export const DOCKER_KEY_FINGERPRINT = '9DC858229FC7DD38854AE2D88D81803C0EBFCD88';

// facts：由 PowerShell 收集的系统事实（JSON）。返回 { ok, blockers[], warnings[], steps[], needsReboot }
export function planDockerSetup(f = {}) {
  const blockers = [], warnings = [], steps = [];
  if (!f.isAdmin) blockers.push({ id: 'admin', text: '需要管理员权限：请用管理员身份运行。' });
  if (!['AMD64', 'ARM64'].includes(String(f.arch || '').toUpperCase())) blockers.push({ id: 'arch', text: '只支持 64 位 Windows（x64 / ARM64）。' });
  const min = f.isServer ? MIN_BUILD.server : MIN_BUILD.client;
  if (!(f.build >= min)) blockers.push({ id: 'os', text: f.isServer ? 'WSL2 需要 Windows Server 2022 或更新（Windows Server 2019 不支持）。' : 'WSL2 需要 Windows 10 2004（内部版本 19041）或更新。' });
  // 虚拟化：物理机看固件开关；云服务器（虚拟机）里 hypervisorPresent 一定为真，是否开放嵌套虚拟化只能在真正启动 WSL2 时才知道
  if (f.firmwareVirt === false && !f.hypervisorPresent) blockers.push({ id: 'virt', text: '这台机器没有开启硬件虚拟化：请在 BIOS / UEFI 里开启 Intel VT-x 或 AMD-V。' });
  else if (f.firmwareVirt === false) warnings.push({ id: 'nested', text: '这台机器是虚拟机，没有检测到嵌套虚拟化。很多云服务器不开放这个功能，WSL2 可能起不来；如果失败，请换支持嵌套虚拟化的实例规格，或改用 Linux 服务器。' });
  if (blockers.length) return { ok: false, blockers, warnings, steps: [], needsReboot: false };

  const featuresOn = f.wslFeature === 'Enabled' && f.vmpFeature === 'Enabled';
  if (!featuresOn) { steps.push('enableFeatures'); steps.push('reboot'); }
  else if (f.pendingReboot) steps.push('reboot');
  if (!f.distroExists) { steps.push('wslUpdate'); steps.push('importDistro'); }
  if (!f.distroConfigured) steps.push('configureDistro');
  if (!f.dockerOk) steps.push('installDocker');
  if (!f.bootTask) steps.push('bootTask');
  if (f.desktop && !f.desktopRunning) steps.push('desktop');
  return { ok: true, blockers, warnings, steps, needsReboot: steps.includes('reboot') };
}

// 把 WSL / 虚拟化的常见报错翻成人话和处理办法
export function classifyWslError(text = '') {
  const t = String(text);
  const rules = [
    [/0x80370102|HCS_E_HYPERV_NOT_INSTALLED|virtualization.*(disabled|not enabled)|enable the virtual machine platform|请启用虚拟机平台|虚拟化/i, { id: 'virt', text: '虚拟化没有开启或不可用：物理机请在 BIOS 里开启 VT-x / AMD-V；云服务器请选择支持嵌套虚拟化的实例规格。' }],
    [/0x80370114|0x80370104|HCS_E_SERVICE_NOT_AVAILABLE/i, { id: 'vmp', text: '虚拟机平台服务没有启动：重启一次服务器后再试。' }],
    [/kernel.*update|WSL 2 requires an update|内核/i, { id: 'kernel', text: 'WSL2 内核需要更新：执行 wsl --update 后再试（需要联网）。' }],
    [/0x80070003|0x80070002|ERROR_PATH_NOT_FOUND/i, { id: 'path', text: '找不到 WSL 需要的文件或目录：检查数据目录所在的磁盘是否存在、是否有写权限。' }],
    [/0x8007023e|0x80072efe|0x80072ee7|timed out|could not resolve|无法解析|连接超时/i, { id: 'network', text: '网络不通：检查服务器能否访问下载地址（国内服务器可使用国内镜像）。' }],
    [/disk.*(full|space)|ERROR_DISK_FULL|0x80070070|空间不足/i, { id: 'disk', text: '磁盘空间不足：Docker 环境至少需要 10 GB 空闲空间。' }]
  ];
  for (const [re, out] of rules) if (re.test(t)) return out;
  return { id: 'unknown', text: 'WSL / Docker 没有装成功，详细输出见日志。' };
}

// 从 Ubuntu 官方的 SHA256SUMS 里按架构找到 WSL rootfs 的文件名和校验值（文件名带 ubuntu22.04lts 之类的后缀，不能写死）
export function pickRootfs(sumsText, arch = 'amd64', release = 'jammy') {
  const raw = String(arch).toLowerCase();
  const a = raw === 'arm64' ? 'arm64' : (raw === 'amd64' || raw === 'x64') ? 'amd64' : null;
  if (!a) return null;   // 不认识的架构（比如 x86）不能当 amd64 处理，下错镜像比报错更糟
  const re = new RegExp('^([0-9a-f]{64})\\s+\\*?(ubuntu-' + release + '-wsl-' + a + '-[A-Za-z0-9.\\-]*\\.rootfs\\.tar\\.gz)\\s*$', 'i');
  for (const line of String(sumsText || '').split(/\r?\n/)) { const m = re.exec(line.trim()); if (m) return { sha256: m[1].toLowerCase(), file: m[2] }; }
  return null;
}
export const ROOTFS_BASES = { global: 'https://cloud-images.ubuntu.com/wsl/jammy/current', cn: 'https://mirrors.tuna.tsinghua.edu.cn/ubuntu-cloud-images/wsl/jammy/current' };

// 发行版里的 /etc/wsl.conf：启用 systemd（docker 才能开机自启）、让 NTFS 目录支持 chmod、关闭和 Windows 的互操作（隔离更好）
export const WSL_CONF = ['[boot]', 'systemd=true', '', '[automount]', 'enabled=true', 'options="metadata,umask=022"', '', '[interop]', 'enabled=false', 'appendWindowsPath=false', '', '[network]', 'generateResolvConf=true', ''].join('\n');

// 在发行版里安装 Docker 引擎（官方 apt 仓库，校验签名密钥指纹）。cn=1 时使用阿里云的 apt 镜像和 Docker 镜像源
export function dockerInstallScript() {
  return `#!/bin/bash
# 由 yumeiro-windows.ps1 生成：在 WSL 发行版里安装 Docker 引擎。可重复执行。
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
CN="\${1:-0}"
KEY_FPR="${DOCKER_KEY_FINGERPRINT}"
if [ "$CN" = 1 ]; then
  DOCKER_REPO=https://mirrors.aliyun.com/docker-ce/linux/ubuntu
  sed -i -E 's#https?://([a-z0-9.-]*archive|security)\\.ubuntu\\.com/ubuntu#http://mirrors.aliyun.com/ubuntu#g' /etc/apt/sources.list || true
else
  DOCKER_REPO=https://download.docker.com/linux/ubuntu
fi
apt-get update
apt-get install -y ca-certificates curl gnupg
install -m 0755 -d /etc/apt/keyrings
curl -fsSL "$DOCKER_REPO/gpg" -o /tmp/docker.gpg
FPR="$(gpg --show-keys --with-colons /tmp/docker.gpg | awk -F: '/^fpr:/ {print $10; exit}')"
if [ "$FPR" != "$KEY_FPR" ]; then echo "Docker 签名密钥指纹不对（$FPR），已停止安装"; exit 1; fi
gpg --dearmor < /tmp/docker.gpg > /etc/apt/keyrings/docker.gpg
chmod a+r /etc/apt/keyrings/docker.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] $DOCKER_REPO $(. /etc/os-release && echo "$VERSION_CODENAME") stable" > /etc/apt/sources.list.d/docker.list
apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
systemctl enable --now docker
for i in $(seq 1 30); do docker info >/dev/null 2>&1 && break; sleep 2; done
docker version --format 'Docker 引擎 {{.Server.Version}} 已就绪'
`;
}

// ---- 命令行入口（给 yumeiro-windows.ps1 用）：node docker-plan.mjs plan|rootfs|classify|install-script|wslconf <参数> ----
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [cmd, a, b] = process.argv.slice(2);
  const out = value => process.stdout.write(typeof value === 'string' ? value : JSON.stringify(value));
  if (cmd === 'plan') out(planDockerSetup(JSON.parse(readFileSync(a, 'utf8').replace(/^﻿/, ''))));
  else if (cmd === 'rootfs') out(pickRootfs(readFileSync(a, 'utf8'), b || 'amd64') || {});
  else if (cmd === 'classify') out(classifyWslError(readFileSync(a, 'utf8')));
  else if (cmd === 'install-script') out(dockerInstallScript());
  else if (cmd === 'wslconf') out(WSL_CONF);
  else { console.error('用法：docker-plan.mjs plan <facts.json> | rootfs <SHA256SUMS> [arch] | classify <日志文件> | install-script | wslconf'); process.exit(2); }
}
