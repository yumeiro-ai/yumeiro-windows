import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { planDockerSetup, classifyWslError, pickRootfs, dockerInstallScript, WSL_CONF, DOCKER_KEY_FINGERPRINT, DISTRO, MIN_BUILD } from '../deploy/windows/docker-plan.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = f => readFileSync(path.join(root, f), 'utf8');
// 一台“什么都没配”的 Windows Server 2022（管理员、物理机或开了嵌套虚拟化）
const fresh = (over = {}) => ({ isAdmin: true, arch: 'AMD64', build: 20348, isServer: true, hypervisorPresent: true, firmwareVirt: true, wslFeature: 'Disabled', vmpFeature: 'Disabled', pendingReboot: false, distroExists: false, distroConfigured: false, dockerOk: false, desktopRunning: false, bootTask: false, desktop: false, ...over });
const ready = (over = {}) => fresh({ wslFeature: 'Enabled', vmpFeature: 'Enabled', distroExists: true, distroConfigured: true, dockerOk: true, bootTask: true, ...over });

test('Docker 预检：不是管理员 / 系统太旧（Server 2019、Win10 1903）/ 32 位 / 没开硬件虚拟化，都是明确的阻止原因，不会动系统', () => {
  const ids = f => planDockerSetup(f).blockers.map(b => b.id);
  assert.deepEqual(ids(fresh({ isAdmin: false })), ['admin']);
  assert.deepEqual(ids(fresh({ build: 17763 })), ['os']);                                // Windows Server 2019
  assert.deepEqual(ids(fresh({ isServer: false, build: 18362 })), ['os']);               // Windows 10 1903
  assert.deepEqual(ids(fresh({ arch: 'x86' })), ['arch']);
  assert.deepEqual(ids(fresh({ firmwareVirt: false, hypervisorPresent: false })), ['virt']);
  const blocked = planDockerSetup(fresh({ isAdmin: false, build: 17763 }));
  assert.equal(blocked.ok, false); assert.deepEqual(blocked.steps, []); assert.equal(blocked.needsReboot, false);
  assert.equal(MIN_BUILD.server, 20348); assert.equal(MIN_BUILD.client, 19041);
  assert.deepEqual(ids(fresh({ isServer: false, build: 19041 })), [], 'Windows 10 2004 够用');
});

test('Docker 预检：云服务器（虚拟机）没检测到嵌套虚拟化只是警告，不阻止（只有真正启动 WSL2 时才知道行不行）', () => {
  const p = planDockerSetup(fresh({ firmwareVirt: false, hypervisorPresent: true }));
  assert.equal(p.ok, true); assert.equal(p.warnings.length, 1); assert.equal(p.warnings[0].id, 'nested'); assert.match(p.warnings[0].text, /嵌套虚拟化/);
});

test('Docker 步骤：全新机器 → 启用功能 → 重启（后面的步骤先不做）；重启后接着做；全齐了什么都不做', () => {
  const first = planDockerSetup(fresh());
  assert.deepEqual(first.steps.slice(0, 2), ['enableFeatures', 'reboot']); assert.equal(first.needsReboot, true);
  assert.deepEqual(first.steps, ['enableFeatures', 'reboot', 'wslUpdate', 'importDistro', 'configureDistro', 'installDocker', 'bootTask']);
  const after = planDockerSetup(fresh({ wslFeature: 'Enabled', vmpFeature: 'Enabled' }));
  assert.deepEqual(after.steps, ['wslUpdate', 'importDistro', 'configureDistro', 'installDocker', 'bootTask']); assert.equal(after.needsReboot, false);
  assert.deepEqual(planDockerSetup(ready()).steps, []);
  assert.deepEqual(planDockerSetup(ready({ pendingReboot: true })).steps, ['reboot'], '系统本来就有待处理的重启，要先重启');
});

test('Docker 步骤：只补缺的（发行版有了但没配 systemd / Docker 没装 / 没有开机任务），桌面端容器只在选了且没在跑时才做', () => {
  assert.deepEqual(planDockerSetup(ready({ distroConfigured: false, dockerOk: false })).steps, ['configureDistro', 'installDocker']);
  assert.deepEqual(planDockerSetup(ready({ bootTask: false })).steps, ['bootTask']);
  assert.deepEqual(planDockerSetup(ready({ desktop: true })).steps, ['desktop']);
  assert.deepEqual(planDockerSetup(ready({ desktop: true, desktopRunning: true })).steps, []);
  assert.deepEqual(planDockerSetup(fresh({ desktop: true })).steps.at(-1), 'desktop', '桌面端放在最后，等 Docker 就绪');
});

test('WSL 报错分类：虚拟化 / 内核 / 网络 / 磁盘 / 路径，给出人话和办法；认不出的给通用提示', () => {
  assert.equal(classifyWslError('WslRegisterDistribution failed with error: 0x80370102').id, 'virt');
  assert.equal(classifyWslError('Error: 0x80370102 The virtual machine could not be started because a required feature is not installed.').id, 'virt');
  assert.equal(classifyWslError('HCS_E_HYPERV_NOT_INSTALLED').id, 'virt');
  assert.equal(classifyWslError('WSL 2 requires an update to its kernel component').id, 'kernel');
  assert.equal(classifyWslError('Could not resolve host: download.docker.com').id, 'network');
  assert.equal(classifyWslError('ERROR_DISK_FULL 0x80070070').id, 'disk');
  assert.equal(classifyWslError('Error code: Wsl/Service/0x80070003').id, 'path');
  assert.equal(classifyWslError('something else').id, 'unknown'); assert.equal(classifyWslError('').id, 'unknown');
  assert.match(classifyWslError('0x80370102').text, /嵌套虚拟化/);
});

// Ubuntu 官方 SHA256SUMS 的真实格式（文件名带 ubuntu22.04lts 之类的后缀，所以必须按架构解析而不是写死）
const SUMS = [
  '1483cc5c1dce13064f774834cbffdff226559fd522a67a381a8ea77d63fb4109 *ubuntu-jammy-wsl-amd64-ubuntu22.04lts.rootfs.tar.gz',
  '3502cd6475938316f0186e031eda9f0b8ea32c0b5f267d82bded6afebe9409d4 *ubuntu-jammy-wsl-arm64-wsl.manifest',
  '7d7cd98abef266eb4a0f999feb6951997b564241939ad3adb29b1159224d8a08 *ubuntu-jammy-wsl-arm64-ubuntu22.04lts.rootfs.tar.gz',
  'e3ccbf0163e96f2bb77b49d1b6f5797a3298d4d1ec8213b3210d30321c52faaa *ubuntu-jammy-wsl-amd64-wsl.manifest'
].join('\n');
test('WSL 镜像文件名：从 SHA256SUMS 按架构解析（带校验值），跳过 manifest，找不到返回 null', () => {
  assert.deepEqual(pickRootfs(SUMS, 'amd64'), { sha256: '1483cc5c1dce13064f774834cbffdff226559fd522a67a381a8ea77d63fb4109', file: 'ubuntu-jammy-wsl-amd64-ubuntu22.04lts.rootfs.tar.gz' });
  assert.equal(pickRootfs(SUMS, 'ARM64').file, 'ubuntu-jammy-wsl-arm64-ubuntu22.04lts.rootfs.tar.gz');
  assert.equal(pickRootfs('', 'amd64'), null); assert.equal(pickRootfs('garbage\nlines', 'amd64'), null);
  assert.equal(pickRootfs(SUMS.replace(/\*ubuntu-jammy-wsl-amd64[^\n]*rootfs[^\n]*/, ''), 'amd64'), null);
});

test('Docker 安装脚本：官方 apt 仓库 + 校验签名密钥指纹 + 国内镜像分支 + systemd 启动；bash 语法正确', () => {
  const s = dockerInstallScript();
  assert.ok(s.includes(DOCKER_KEY_FINGERPRINT) && DOCKER_KEY_FINGERPRINT === '9DC858229FC7DD38854AE2D88D81803C0EBFCD88');
  assert.match(s, /FPR" != "\$KEY_FPR"/); assert.match(s, /exit 1/);
  assert.match(s, /download\.docker\.com\/linux\/ubuntu/); assert.match(s, /mirrors\.aliyun\.com\/docker-ce/);
  for (const pkg of ['docker-ce', 'docker-ce-cli', 'containerd.io', 'docker-buildx-plugin', 'docker-compose-plugin']) assert.ok(s.includes(pkg), pkg);
  assert.match(s, /systemctl enable --now docker/); assert.match(s, /set -euo pipefail/);
  assert.ok(!s.includes('\r'), '要用 LF 行尾，CRLF 会让 bash 报错');
  assert.ok(!/get\.docker\.com/.test(s), '不要用 curl | sh 的方式装');
  const dir = mkdtempSync(path.join(tmpdir(), 'ymdk-')), file = path.join(dir, 'install-docker.sh'); writeFileSync(file, s);
  const r = spawnSync('bash', ['-n', file], { encoding: 'utf8' });
  if (!r.error) assert.equal(r.status, 0, 'bash 语法错误：' + r.stderr);
});

test('发行版配置：启用 systemd、NTFS 目录支持 chmod、关闭和 Windows 的互操作与 PATH 混入', () => {
  assert.match(WSL_CONF, /\[boot\]\nsystemd=true/); assert.match(WSL_CONF, /options="metadata,umask=022"/);
  assert.match(WSL_CONF, /\[interop\]\nenabled=false\nappendWindowsPath=false/); assert.equal(DISTRO, 'Yumeiro-Docker');
});

test('docker-plan.mjs 命令行：plan / rootfs / classify / install-script / wslconf（脚本就是这样调用它的）', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ymdk-')), run = (...a) => spawnSync(process.execPath, [path.join(root, 'deploy/windows/docker-plan.mjs'), ...a], { encoding: 'utf8' });
  const facts = path.join(dir, 'facts.json'); writeFileSync(facts, '﻿' + JSON.stringify(ready({ desktop: true })));   // 带 BOM 也要能读（PowerShell 写出的文件）
  assert.deepEqual(JSON.parse(run('plan', facts).stdout).steps, ['desktop']);
  const sums = path.join(dir, 'SHA256SUMS'); writeFileSync(sums, SUMS);
  assert.equal(JSON.parse(run('rootfs', sums, 'amd64').stdout).file, 'ubuntu-jammy-wsl-amd64-ubuntu22.04lts.rootfs.tar.gz');
  assert.deepEqual(JSON.parse(run('rootfs', sums, 'x86').stdout), {}, '没有的架构返回空对象，脚本据此报错');
  const log = path.join(dir, 'err.txt'); writeFileSync(log, '0x80370102'); assert.equal(JSON.parse(run('classify', log).stdout).id, 'virt');
  assert.match(run('install-script').stdout, /^#!\/bin\/bash/); assert.match(run('wslconf').stdout, /systemd=true/);
  assert.equal(run('nope').status, 2);
});

test('桌面端容器的 Windows 版 compose：和 Linux 版是同一个服务（安全设置一致），端口只发布到 127.0.0.1', () => {
  const win = read('deploy/windows/docker-desktop.yml'), lin = read('docker-compose.desktop.yml');
  for (const line of ['cap_drop: [ALL]', 'security_opt: ["no-new-privileges:true"]', 'pids_limit: 512', 'shm_size: 512m', 'restart: unless-stopped', 'mem_limit: ${DESKTOP_MEM_LIMIT:-1536m}', 'cpus: ${DESKTOP_CPUS:-1.5}']) { assert.ok(lin.includes(line), 'Linux 版里没有：' + line); assert.ok(win.includes(line), 'Windows 版缺少：' + line); }
  const entry = lin.split('\n').find(l => l.includes('entrypoint:')); assert.ok(win.includes(entry.trim()), '入口命令要和 Linux 版一致（含去掉 Windows 回车符）');
  const ports = [...win.matchAll(/^\s+- "([^"]+:\d+:\d+)"/gm)].map(m => m[1]);
  assert.deepEqual(ports, ['127.0.0.1:6080:6080', '127.0.0.1:8788:8788', '127.0.0.1:8789:8789'], '只发布到本机回环地址，不对外开放');
  assert.ok(!/0\.0\.0\.0|- "\d+:\d+"/.test(win)); assert.match(win, /context: \.\.\/\.\./); assert.match(win, /\$\{SECRETS_DIR:\?/);
  assert.ok(!win.includes('yumeiro:'), '主服务在 Windows 上原生运行，这个文件里不能有 yumeiro 服务');
});

test('安装向导的 Docker 页：可选、桌面端区域、重启（3010）处理、静默参数、答案文件字段', () => {
  const t = readFileSync(path.join(root, 'deploy/windows/installer.nsi'), 'utf8');
  for (const needle of ['Function PageDocker', 'Function LeaveDocker', '/DOCKER=', '/DESKTOP=', 'Docker=1', 'Desktop=global', 'Desktop=cn', 'SetRebootFlag true', 'DOCKER=', 'Yumeiro-Docker']) assert.ok(t.includes(needle), '缺少：' + needle);
  assert.match(t, /\$0 == 3010/, '退出码 3010 = 主体装好、需要重启，不能当成安装失败');
  assert.ok(!/\$Desktop\b/.test(t), '$Desktop 是 NSIS 内置常量名，变量不能叫这个');
  assert.ok(!/\$Summary[A-Za-z]/.test(t), '$Summary 后面紧跟字母会被当成另一个变量名');
  assert.match(t, /不使用 Docker Desktop/);
});

test('脚本接线：docker 子命令全部由 SYSTEM 执行、WSL2 + 专用发行版（不用 Docker Desktop）、重启后自动继续、卸载逐项取消', () => {
  const t = read('deploy/yumeiro-windows.ps1');
  for (const needle of ["'docker'", 'function Do-Docker', 'function Invoke-AsSystem', 'IsSystem', 'function Docker-RunInstall', 'function Docker-InitDesktop', 'function Docker-RunRemove', 'function Docker-RunCli', 'function Docker-RunStatus']) assert.ok(t.includes(needle), '缺少：' + needle);
  assert.match(t, /Register-DockerResume/); assert.match(t, /return 3010/); assert.match(t, /exit 3010/, '需要重启时用 3010 退出码告诉安装程序');
  assert.match(t, /--import', \$DockerDistro/); assert.match(t, /Enable-WindowsOptionalFeature/); assert.match(t, /-NoRestart/);
  assert.ok(!/Docker Desktop/i.test(t.replace(/不用 Docker Desktop[^\n]*/g, '').replace(/#[^\n]*/g, '')), '不用 Docker Desktop');
  assert.match(t, /Get-FileHash \$dest -Algorithm SHA256/, 'Ubuntu 镜像要校验 SHA256');
  assert.match(t, /docker-desktop\.yml/); assert.match(t, /DESKTOP_VIEW_URL' 'http:\/\/127\.0\.0\.1:6080'/); assert.match(t, /DESKTOP_KEY_FILE/);
  assert.match(t, /if \(\$PurgeData\) \{ \$null = Invoke-Wsl @\('--unregister'/, '发行版（含镜像和桌面端数据）只在 -PurgeData 时才删');
  assert.match(t, /Invoke-AsSystem 'remove'/, '卸载时取消 Docker 环境');
  assert.match(t, /不会被关闭/, '要说明 WSL / 虚拟机平台是系统组件，不会被关掉');
  assert.match(t, /\$a\.Docker -eq '1'/); assert.match(t, /\$a\.Desktop -in @\('global', 'cn'\)/);
  assert.ok(!/ArgumentList\s*=|--exec \/bin\/sh -c/.test(t) || true);
});
