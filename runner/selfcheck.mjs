// 引擎与隔离自检（只读，不需要任何模型密钥，不调用模型）。
// 在运行器自己的进程里执行，所以看到的就是智能体引擎实际运行的环境。
//   A 引擎：三个引擎有没有装好、能不能起来、工作目录能不能写、磁盘够不够
//   B 隔离：不是 root、拿不到主服务的密钥和数据、环境变量传得最小、工作区目录出不去、没有多余的系统权限
// 这些检查只验证“承诺有没有兑现”，不做任何网络层面的伪装或绕过。
import { access, readdir, mkdir, writeFile, rm, symlink, readFile, statfs, constants } from 'node:fs/promises';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { WIN_CHILD_ENV_KEYS } from './winproc.mjs';

export const ENGINE_LABELS = { claude: 'Claude Code', codex: 'Codex', pi: 'Pi' };
// 运行器传给引擎的环境里允许出现的变量名（其余一律不传；后面几项只在 Windows 上才会出现）
export const CHILD_ENV_BASE = ['PATH', 'HOME', 'LANG', 'CI', 'NO_COLOR', 'TERM'];
export const CHILD_ENV_ALLOWED = [...CHILD_ENV_BASE, ...WIN_CHILD_ENV_KEYS];
// 运行器进程里允许存在的“看起来敏感”的变量（运行器自己需要的令牌）
const OWN_SECRET_NAMES = new Set(['RUNNER_TOKEN', 'RUNNER_TOKEN_FILE', 'SANDBOX_TOKEN', 'SANDBOX_TOKEN_FILE']);
const SENSITIVE_NAME = /(SECRET|PASSWORD|PASSWD|PRIVATE_KEY|ENCRYPTION_KEY|DATABASE_URL|CREDENTIAL|_API_KEY$|_TOKEN$)/i;
// 运行器的账号不该读到的位置（主服务的数据与密钥、SSH 密钥、Docker 控制口）
const FORBIDDEN_PATHS = [
  ['/var/run/docker.sock', 'docker'], ['/run/docker.sock', 'docker'],
  ['/etc/shadow', 'system'], ['/root', 'system'], ['/root/.ssh', 'ssh'],
  ['/app/data', 'data'], ['/data', 'data'], ['/var/lib/yumeiro', 'data'], ['/opt/yumeiro/data', 'data'],
  ['/etc/yumeiro/secrets', 'secret'], ['/etc/yumeiro/store_encryption_key', 'secret'], ['/etc/yumeiro/model_api_key', 'secret'],
];
const RUNNER_SECRET_FILES = new Set(['runner_token', 'sandbox_token']);
const FIX_IMAGE = '重新构建运行器镜像（docker compose build --no-cache runner）；直装版在管理页“安装向导”里重新安装引擎。';

const rank = { fail: 3, warn: 2, info: 1, skip: 0, ok: 0 };
const worst = list => list.reduce((a, b) => (rank[b] > rank[a] ? b : a), 'ok');

function defaultDeps() {
  return {
    platform: process.platform, getuid: process.getuid?.bind(process), homedir,
    access, readdir, mkdir, writeFile, rm, symlink, readFile, statfs,
    exists: async p => { try { await access(p); return true; } catch { return false; } },
    // Windows：当前进程令牌里的组（whoami /groups），用来判断是不是管理员 / SYSTEM
    winGroups: () => new Promise(resolve => execFile('whoami', ['/groups'], { timeout: 8000, windowsHide: true }, (error, stdout) => resolve(error ? null : String(stdout)))),
  };
}

// ctx：
//   root                  工作区根目录
//   env                   运行器进程的环境变量
//   versions / tools      运行器已探测到的引擎版本与 npx/uvx 情况
//   resolveInWorkspace    运行器自己的路径解析函数（拿来验证“目录出不去”）
//   baseChildEnv / filterEngineEnv  运行器真正使用的两个函数（拿来验证“环境传得最小”）
//   sandboxHealth         可选：() => Promise<{ok, languages?}>，探测代码沙箱
//   deps                  测试时替换文件系统等依赖
export async function runSelfCheck(ctx) {
  const { root, env = {}, versions = {}, tools = {}, resolveInWorkspace, baseChildEnv, filterEngineEnv, sandboxHealth = null, engines = Object.keys(ENGINE_LABELS) } = ctx;
  const d = { ...defaultDeps(), ...(ctx.deps || {}) };
  const checks = [];
  const add = (group, id, status, title, detail = '', fix = '') => checks.push({ group, id, status, title, detail, fix });

  // ───────── A 引擎 ─────────
  for (const engine of engines) {
    const label = ENGINE_LABELS[engine] || engine, version = versions[engine];
    if (version) add('engine', `engine.${engine}.installed`, 'ok', `${label} 已安装`, String(version));
    else add('engine', `engine.${engine}.installed`, 'fail', `${label} 没有装好`, '运行器里找不到这个命令行，或者 --version 没有在 8 秒内返回。', FIX_IMAGE);
    const home = path.join(root, '.home', engine), probeFile = path.join(home, '.selfcheck-' + randomBytes(4).toString('hex'));
    try { await d.mkdir(home, { recursive: true }); await d.writeFile(probeFile, 'ok'); await d.rm(probeFile, { force: true }); add('engine', `engine.${engine}.home`, 'ok', `${label} 的独立工作目录可写`, home); }
    catch (error) { add('engine', `engine.${engine}.home`, 'fail', `${label} 的独立工作目录不能写`, `${home}：${error.code || error.message}`, '检查工作区卷的权限：运行器账号需要对工作区根目录有读写权限。'); }
  }
  if (tools.npx === false || tools.uvx === false) {
    const missing = ['npx', 'uvx'].filter(name => tools[name] === false);
    add('engine', 'engine.tools', 'warn', 'MCP 启动器缺少：' + missing.join('、'), '依赖这些启动器的 MCP 服务在运行器里启动不了（管理页的 MCP 市场会标出）。', missing.includes('uvx') ? '构建运行器镜像时保持 INSTALL_UV=1。' : FIX_IMAGE);
  } else add('engine', 'engine.tools', 'ok', 'MCP 启动器可用（npx、uvx）');
  try {
    await d.mkdir(root, { recursive: true });
    const probeFile = path.join(root, '.selfcheck-' + randomBytes(4).toString('hex'));
    await d.writeFile(probeFile, 'ok'); await d.rm(probeFile, { force: true });
    let free = null; try { const s = await d.statfs(root); free = Number(s.bavail) * Number(s.bsize); } catch { /* 有的系统不支持 */ }
    if (free !== null && free < 1024 ** 3) add('engine', 'engine.workspace', 'warn', '工作区磁盘空间不足 1 GB', `剩余约 ${(free / 1048576).toFixed(0)} MB。`, '清理旧工作区或扩容存储卷。');
    else add('engine', 'engine.workspace', 'ok', '工作区目录可写', free === null ? root : `${root}，剩余约 ${(free / 1073741824).toFixed(1)} GB`);
  } catch (error) { add('engine', 'engine.workspace', 'fail', '工作区目录不能写', `${root}：${error.code || error.message}`, '检查卷挂载和目录权限。'); }
  add('engine', 'engine.limits', 'info', '运行限制', `并发上限 ${Number(env.RUNNER_MAX_CONCURRENT) || 3}，单次默认超时 ${Number(env.RUNNER_TIMEOUT_SEC) || 600} 秒。`);

  // ───────── B 隔离 ─────────
  const uid = d.getuid ? d.getuid() : null;
  if (d.platform === 'win32') {
    // Windows 没有 uid：看进程令牌的完整性级别。High(S-1-16-12288) 是管理员，System(S-1-16-16384) 是 SYSTEM
    const groups = await d.winGroups();
    if (groups === null) add('isolation', 'iso.user', 'skip', '运行账号', '没能读到当前账号的组信息（whoami /groups），跳过这一项。');
    else if (/S-1-16-(12288|16384)\b/.test(groups)) add('isolation', 'iso.user', 'fail', '运行器正以管理员 / SYSTEM 权限运行', '引擎里执行的任何命令都会拥有最高权限，隔离基本失效。', '用 yumeiro-windows.ps1 install -WithRunner 重新安装：运行器会以独立的低权限账号 yumeiro-runner 运行。');
    else add('isolation', 'iso.user', 'ok', '运行器以普通账号运行', '进程令牌不是管理员 / SYSTEM');
  } else if (uid === null) add('isolation', 'iso.user', 'skip', '运行账号', '当前系统没有用户编号，跳过这一项。');
  else if (uid === 0) add('isolation', 'iso.user', 'fail', '运行器正以 root 运行', '引擎里执行的任何命令都会拥有最高权限，隔离基本失效。', '容器里用 USER agent（默认镜像就是这样）；直装版用专用的普通账号运行。');
  else add('isolation', 'iso.user', 'ok', '运行器以普通账号运行', `uid ${uid}`);

  const leaked = Object.keys(env).filter(name => SENSITIVE_NAME.test(name) && !OWN_SECRET_NAMES.has(name) && env[name]);
  if (leaked.length) add('isolation', 'iso.env', 'warn', '运行器进程里带有敏感环境变量', '变量名：' + leaked.join('、') + '（只列名字，不显示值）。引擎拿不到它们，但运行器进程本身不该持有。', '把这些变量从运行器的环境里去掉，它们应该只属于主服务。');
  else add('isolation', 'iso.env', 'ok', '运行器进程里没有主服务的密钥类变量');

  try {
    const poisoned = { PATH: '/usr/bin', STORE_ENCRYPTION_KEY: 'x', ADMIN_PASSWORD: 'x', DATABASE_URL: 'x', NODE_OPTIONS: '--x', LD_PRELOAD: 'x', RUNNER_TOKEN: 'x' };
    const base = baseChildEnv(poisoned, root, 'claude', d.platform);
    const allowedKeys = d.platform === 'win32' ? CHILD_ENV_ALLOWED : CHILD_ENV_BASE; // Windows 专用变量只允许出现在 Windows 上
    const extra = Object.keys(base).filter(key => !allowedKeys.includes(key));
    const filtered = filterEngineEnv({ PATH: '/evil', NODE_OPTIONS: '--x', LD_PRELOAD: 'x', STORE_ENCRYPTION_KEY: 'x', ADMIN_PASSWORD: 'x', ANTHROPIC_API_KEY: 'sk-selfcheck', OPENAI_BASE_URL: 'https://example.com' });
    const accepted = Object.keys(filtered).sort(), expected = ['ANTHROPIC_API_KEY', 'OPENAI_BASE_URL'];
    if (extra.length || accepted.join() !== expected.join()) add('isolation', 'iso.childEnv', 'fail', '传给引擎的环境变量不够干净', `基础环境多出：${extra.join('、') || '无'}；请求里额外带的变量被放行了：${accepted.filter(k => !expected.includes(k)).join('、') || '无'}。`, '回退对运行器环境变量白名单的改动：只允许 *_API_KEY、*_BASE_URL、*_TOKEN 这类模型相关变量。');
    else add('isolation', 'iso.childEnv', 'ok', '传给引擎的环境变量是最小的', `基础环境只有 ${allowedKeys.join('、')}；PATH、NODE_OPTIONS、LD_PRELOAD 和主服务的密钥都会被拒绝。`);
  } catch (error) { add('isolation', 'iso.childEnv', 'fail', '没能完成环境变量检查', String(error.message || error)); }

  const readable = [];
  // 额外的“不该读到”的位置：Windows 版的安装脚本把主服务的数据、密钥、配置目录用分号列在 RUNNER_FORBIDDEN_PATHS 里
  const extraForbidden = String(env.RUNNER_FORBIDDEN_PATHS || '').split(';').map(x => x.trim()).filter(Boolean).map(p => [p, 'secret']);
  const forbidden = [...(d.platform === 'win32' ? [] : FORBIDDEN_PATHS), ...extraForbidden];
  for (const [p, kind] of forbidden) { try { await d.access(p, constants.R_OK); readable.push([p, kind]); } catch { /* 读不到就是对的 */ } }
  const sshDir = path.join(d.homedir(), '.ssh'); try { await d.access(sshDir, constants.R_OK); if (!readable.some(([p]) => p === sshDir)) readable.push([sshDir, 'ssh']); } catch { /* 没有也是对的 */ }
  let extraSecrets = [];
  try { extraSecrets = (await d.readdir('/run/secrets')).filter(name => !RUNNER_SECRET_FILES.has(name)); } catch { /* 没有这个目录 */ }
  for (const name of extraSecrets) readable.push(['/run/secrets/' + name, 'secret']);
  if (readable.some(([, kind]) => kind === 'docker')) add('isolation', 'iso.paths', 'fail', '运行器能访问 Docker 控制口', '这等于拿到主机的 root 权限：' + readable.filter(([, k]) => k === 'docker').map(([p]) => p).join('、'), '不要把 docker.sock 挂进运行器容器。');
  else if (readable.length) add('isolation', 'iso.paths', 'fail', '运行器能读到不该读的位置', readable.map(([p]) => p).join('、'), '检查卷挂载和目录权限：运行器只应该看到工作区和它自己的令牌；主服务的数据目录、密钥和 SSH 目录都不要挂进来。');
  else add('isolation', 'iso.paths', 'ok', '运行器读不到主服务的数据、密钥和 SSH 目录', `已检查 ${forbidden.length + 1} 个位置，以及 /run/secrets 里除运行器令牌外的文件。`);

  try {
    const id = 'selfcheck-' + randomBytes(5).toString('hex'), accepted = [];
    const attempt = async (label, rel) => { try { await resolveInWorkspace(root, id, rel, { mustExist: false }); accepted.push(label); } catch { /* 被拒绝是对的 */ } };
    await attempt('../ 上级目录', '../../etc/passwd'); await attempt('绝对路径', '/etc/passwd'); await attempt('夹带 ..', 'a/../../b'); await attempt('NUL 字符', 'a\0b');
    let symlinkNote = '';
    try {
      await d.mkdir(path.join(root, id), { recursive: true });
      await d.symlink(path.parse(root).root || '/', path.join(root, id, 'escape'), 'dir');
      await attempt('符号链接指向工作区外', 'escape/etc/passwd');
    } catch (error) { symlinkNote = '（本机不能创建符号链接，这一项没测）'; }
    await d.rm(path.join(root, id), { recursive: true, force: true }).catch(() => {});
    if (accepted.length) add('isolation', 'iso.workspace', 'fail', '工作区目录可以被绕出去', '下面这些写法被放行了：' + accepted.join('、'), '这是严重问题：回退对 resolveInWorkspace 的改动，并检查文件接口。');
    else add('isolation', 'iso.workspace', 'ok', '工作区目录出不去', '上级目录、绝对路径、夹带 ..、NUL 字符、符号链接逃逸都会被拒绝。' + symlinkNote);
  } catch (error) { add('isolation', 'iso.workspace', 'fail', '没能完成工作区检查', String(error.message || error)); }

  if (d.platform === 'linux') {
    try {
      const status = await d.readFile('/proc/self/status', 'utf8');
      const cap = (status.match(/^CapEff:\s*([0-9a-f]+)/mi) || [])[1], nnp = (status.match(/^NoNewPrivs:\s*(\d)/mi) || [])[1];
      const bits = cap ? [...BigInt('0x' + cap).toString(2)].filter(c => c === '1').length : null;
      const parts = [], levels = [];
      if (bits === null) levels.push('info'); else if (bits >= 30) { levels.push('fail'); parts.push(`拥有 ${bits} 项系统权限（接近特权容器）`); } else if (bits > 0) { levels.push('warn'); parts.push(`还有 ${bits} 项系统权限`); } else parts.push('没有任何额外系统权限');
      if (nnp === '1') parts.push('已禁止提权（no-new-privileges）'); else if (nnp === '0') { levels.push('warn'); parts.push('没有禁止提权'); }
      const status2 = worst(levels);
      add('isolation', 'iso.privileges', status2, status2 === 'ok' ? '没有多余的系统权限，且禁止提权' : '系统权限偏多', parts.join('；'), status2 === 'ok' ? '' : '在 compose 里保持 cap_drop: [ALL] 和 security_opt: ["no-new-privileges:true"]；不要用 privileged。');
    } catch { add('isolation', 'iso.privileges', 'skip', '系统权限', '读不到 /proc/self/status，跳过。'); }
    try {
      const inContainer = await d.exists('/.dockerenv');
      if (inContainer) {
        const mounts = await d.readFile('/proc/self/mounts', 'utf8');
        const rootLine = mounts.split('\n').map(line => line.split(' ')).find(f => f[1] === '/');
        const ro = rootLine && rootLine[3].split(',').includes('ro');
        add('isolation', 'iso.rootfs', ro ? 'ok' : 'info', ro ? '容器根文件系统是只读的' : '容器根文件系统可写', ro ? '' : '默认的 compose 配置是 read_only: true；可写不算错，但只读更稳。');
      }
    } catch { /* 读不到就不报 */ }
  } else if (d.platform === 'win32') add('isolation', 'iso.win', 'info', 'Windows 上的隔离方式', '没有容器：靠独立的低权限账号、NTFS 权限（上面检查读不到主服务的数据和密钥）和按账号的防火墙规则。强度弱于 Docker 版；需要强隔离请用 Docker 版或 WSL2。');
  else add('isolation', 'iso.privileges', 'skip', '系统权限', '只在 Linux 上检查。');

  if (env.SANDBOX_URL && sandboxHealth) {
    try { const h = await sandboxHealth(); if (h?.ok) add('isolation', 'iso.sandbox', 'ok', '代码沙箱可以连接', h.languages ? '可用语言：' + Object.entries(h.languages).filter(([, v]) => v?.installed).map(([k]) => k).join('、') : ''); else add('isolation', 'iso.sandbox', 'warn', '代码沙箱连不上', '运行器配置了 SANDBOX_URL，但沙箱没有正常应答。', '检查沙箱容器是否在运行（docker compose -f docker-compose.sandbox.yml ps）。'); }
    catch (error) { add('isolation', 'iso.sandbox', 'warn', '代码沙箱连不上', String(error.message || error), '检查沙箱容器是否在运行。'); }
  } else add('isolation', 'iso.sandbox', 'info', '没有配置代码沙箱', '智能体的“执行代码”模式需要独立的沙箱容器；没有它时这个模式不可用，其他模式不受影响。');
  add('isolation', 'iso.egress', 'info', '出网范围', '运行器需要访问模型服务，所以不会替你限制出网。要收紧，请在防火墙或容器网络上只放行你配置的模型地址；代码沙箱容器应当完全断网。');

  const summary = { ok: 0, warn: 0, fail: 0, info: 0, skip: 0 };
  for (const c of checks) summary[c.status]++;
  return { ok: summary.fail === 0, at: Date.now(), summary, checks };
}
