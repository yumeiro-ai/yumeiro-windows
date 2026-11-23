import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtemp, writeFile, readFile, mkdir, stat, readdir } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { randomUUID, generateKeyPairSync, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createZip } from '../ziputil.mjs';
import { signRelease } from '../updatepkg.mjs';
import { parseEnvFile, rotateLog, parseArgs, buildEnv } from '../deploy/windows/run-service.mjs';
import { createWindowsUpdater } from '../deploy/windows/updater.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('Windows 启动器：解析 env 文件（注释、引号、CRLF、BOM、含 = 的值）', () => {
  const env = parseEnvFile('\uFEFF# 注释\r\nPORT=8787\r\nDATA_DIR="C:\\ProgramData\\Yumeiro\\data"\r\nDATABASE_URL=postgres://u:p@h/db?x=1\r\n\r\nbad line\r\n1BAD=x\r\nNAME=\'单引号\'\r\n');
  assert.deepEqual(env, { PORT: '8787', DATA_DIR: 'C:\\ProgramData\\Yumeiro\\data', DATABASE_URL: 'postgres://u:p@h/db?x=1', NAME: '单引号' });
});

test('Windows 启动器：参数解析要求选项在入口脚本之前，之后的都交给入口脚本', () => {
  const o = parseArgs(['--env', 'a.env', '--log', 'l.log', '--pre', 'p.mjs', '--cwd', 'C:\\app', 'server.mjs', '--log', 'x']);
  assert.equal(o.env, 'a.env'); assert.equal(o.log, 'l.log'); assert.equal(o.pre, 'p.mjs'); assert.equal(o.cwd, 'C:\\app'); assert.equal(o.entry, 'server.mjs'); assert.deepEqual(o.args, ['--log', 'x']);
});

test('Windows 启动器：子进程只带必要的系统变量 + env 文件，PATH 不区分大小写，宿主机的密钥变量不外泄', () => {
  const env = buildEnv({ Path: 'C:\\Windows', SystemRoot: 'C:\\Windows', TEMP: 'C:\\t', SECRET_THING: 'x', ADMIN_PASSWORD: 'leak' }, { PORT: '1', PATH: 'C:\\n;C:\\Windows' });
  assert.equal(env.SystemRoot, 'C:\\Windows'); assert.equal(env.TEMP, 'C:\\t'); assert.equal(env.PORT, '1');
  assert.equal(env.Path, 'C:\\n;C:\\Windows'); assert.equal(env.PATH, undefined);
  assert.equal(env.SECRET_THING, undefined); assert.equal(env.ADMIN_PASSWORD, undefined);
});

test('Windows 启动器：日志超过上限就轮转，只保留指定份数', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'ymrs-')), log = path.join(dir, 'y.log');
  assert.equal(rotateLog(log), false);
  for (let i = 1; i <= 4; i++) { await writeFile(log, 'x'.repeat(20) + i); assert.equal(rotateLog(log, { maxBytes: 10, keep: 2 }), true); }
  const names = (await readdir(dir)).sort();
  assert.deepEqual(names, ['y.log.1', 'y.log.2']);
  assert.match(await readFile(path.join(dir, 'y.log.1'), 'utf8'), /4$/); assert.match(await readFile(path.join(dir, 'y.log.2'), 'utf8'), /3$/);
});

test('Windows 启动器：真的能读 env、写日志、并把子进程退出码原样带出来', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'ymrun-'));
  await writeFile(path.join(dir, 'a.env'), 'GREETING=你好\nEXIT=7\n');
  await writeFile(path.join(dir, 'app.mjs'), 'console.log(process.env.GREETING, process.argv.slice(2).join(","), process.env.ADMIN_PASSWORD || "no-leak"); process.exit(Number(process.env.EXIT));');
  const r = spawnSync(process.execPath, [path.join(root, 'deploy/windows/run-service.mjs'), '--env', path.join(dir, 'a.env'), '--log', path.join(dir, 'logs', 'a.log'), '--cwd', dir, 'app.mjs', 'one', 'two'], { env: { ...process.env, ADMIN_PASSWORD: 'leak' }, encoding: 'utf8' });
  assert.equal(r.status, 7);
  assert.match(await readFile(path.join(dir, 'logs', 'a.log'), 'utf8'), /你好 one,two no-leak/);
});

// ---- 更新器（参照 docker-updater 测试：用桩代替真正的 PowerShell）----
const KEY = generateKeyPairSync('ed25519');
const pem = (k, kind) => k[kind].export({ type: kind === 'privateKey' ? 'pkcs8' : 'spki', format: 'pem' });
const pkg = version => JSON.stringify({ name: 'yumeiro-web', version });
const release = version => {
  const list = ['server.mjs', 'public/index.html', 'deploy/yumeiro-native.sh', 'deploy/yumeiro-windows.ps1'].map(n => ({ name: 'Yumeiro/' + n, data: 'v' + version + ':' + n })).concat({ name: 'Yumeiro/package.json', data: pkg(version) });
  return createZip([...list, ...signRelease(list, version, pem(KEY, 'privateKey'))]);
};
let pubDir;
test.before(async () => { pubDir = await mkdtemp(path.join(tmpdir(), 'ymw-pub-')); await writeFile(path.join(pubDir, 'p.pem'), pem(KEY, 'publicKey')); process.env.YUMEIRO_RELEASE_PUBKEY_FILE = path.join(pubDir, 'p.pem'); });

async function setupUpdater(code = 0) {
  const base = await mkdtemp(path.join(tmpdir(), 'ymw-')), app = path.join(base, 'app'), data = path.join(base, 'data'), work = path.join(base, 'update-work');
  await mkdir(app, { recursive: true }); await mkdir(path.join(data, 'updates'), { recursive: true });
  await writeFile(path.join(app, 'package.json'), pkg('0.46.3'));
  const calls = []; let exited = 0;
  const runUpdate = async opts => { calls.push(opts); assert.ok(existsSync(path.join(opts.dir, 'deploy', 'yumeiro-windows.ps1')), '解压出来的新包里要有 ps1'); await mkdir(path.dirname(opts.logFile), { recursive: true }); await writeFile(opts.logFile, '升级日志'); return { code }; };
  const updater = createWindowsUpdater({ prefix: 'C:\\Yumeiro', dataRoot: 'C:\\ProgramData\\Yumeiro', appDir: app, dataDir: data, workRoot: work, exitAfterSuccess: () => { exited++; }, runUpdate });
  const put = async bytes => { const file = 'incoming-' + randomUUID() + '.zip'; await writeFile(path.join(data, 'updates', file), bytes); return { file, sha256: createHash('sha256').update(bytes).digest('hex') }; };
  const done = async () => { for (let i = 0; i < 100; i++) { const s = (await updater.handle({ action: 'update_status' })).details; if (s.state === 'ok' || s.state === 'failed') return s; await new Promise(r => setTimeout(r, 30)); } throw new Error('timeout'); };
  return { updater, put, done, calls, exited: () => exited, data };
}

test('Windows 更新器：验签通过的新版本 → 运行新包里的 ps1，成功后记录状态并让自己重启', async () => {
  const t = await setupUpdater(0);
  const u = await t.put(release('0.46.4'));
  const r = await t.updater.handle({ action: 'apply_update', options: { update: u } });
  assert.equal(r.details.version, '0.46.4'); assert.equal(r.details.from, '0.46.3');
  const st = await t.done();
  assert.equal(st.state, 'ok'); assert.equal(st.version, '0.46.4'); assert.match(st.log, /升级日志/);
  assert.equal(t.calls.length, 1); assert.equal(t.calls[0].prefix, 'C:\\Yumeiro'); assert.equal(t.calls[0].allowDowngrade, false);
  assert.equal(t.exited(), 1);
  assert.equal(existsSync(path.join(t.data, 'updates', u.file)), false, '用完的压缩包要删掉');
});

test('Windows 更新器：脚本失败（已回滚）→ 状态 failed，不重启更新器', async () => {
  const t = await setupUpdater(1);
  const u = await t.put(release('0.46.4'));
  await t.updater.handle({ action: 'apply_update', options: { update: u } });
  const st = await t.done();
  assert.equal(st.state, 'failed'); assert.equal(st.exitCode, 1); assert.equal(t.exited(), 0);
});

test('Windows 更新器：被改动的文件、不高于当前的版本（未勾降级）、非法请求都被拒绝；勾降级后放行', async () => {
  const t = await setupUpdater(0);
  const u = await t.put(release('0.46.4'));
  await assert.rejects(t.updater.handle({ action: 'apply_update', options: { update: { ...u, sha256: 'a'.repeat(64) } } }), /改动/);
  await assert.rejects(t.updater.handle({ action: 'apply_update', options: { update: { file: '../x.zip', sha256: u.sha256 } } }), /无效/);
  await assert.rejects(t.updater.handle({ action: 'shell' }), /不支持/);
  const same = await t.put(release('0.46.3'));
  await assert.rejects(t.updater.handle({ action: 'apply_update', options: { update: same } }), /不高于/);
  const r = await t.updater.handle({ action: 'apply_update', options: { update: { ...same, allowDowngrade: true } } });
  assert.equal(r.details.version, '0.46.3'); await t.done();
  assert.equal(t.calls[0].allowDowngrade, true);
});

test('Windows 更新器：签名不对的包（别人签的）会被拒绝', async () => {
  const t = await setupUpdater(0);
  const other = generateKeyPairSync('ed25519');
  const list = ['server.mjs', 'public/index.html', 'deploy/yumeiro-native.sh'].map(n => ({ name: 'Yumeiro/' + n, data: 'x' })).concat({ name: 'Yumeiro/package.json', data: pkg('0.46.4') });
  const forged = createZip([...list, ...signRelease(list, '0.46.4', pem(other, 'privateKey'))]);
  const u = await t.put(forged);
  await assert.rejects(t.updater.handle({ action: 'apply_update', options: { update: u } }));
  assert.equal(t.calls.length, 0);
});

// ---- exe 安装程序（NSIS）----
test('安装程序脚本：带 BOM、静默参数齐全、安装调用同一个 ps1、卸载登记 + 彻底清理 + 失败不删文件', () => {
  const file = path.join(root, 'deploy/windows/installer.nsi');
  const raw = readFileSync(file);
  assert.deepEqual([...raw.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'NSIS 3 读无 BOM 的 UTF-8 会把中文当成 ANSI');
  const t = raw.toString('utf8');
  for (const p of ['/PORT=', '/EMAIL=', '/ADMINPASS=', '/RUNNER=', '/ENGINES=', '/CN=', '/HTTPS=', '/DOMAIN=', '/STORAGE=', '/PGURL=', '/MODELURL=', '/MODELNAME=', '/MODELKEY=', '/PERSONAL=', '/BACKUP=', '/WEBUPDATE=', '/FIREWALL=', '/CLIENTS=', '/DATAROOT=', '/NOSERVICE=', '/RESULT=', '/PURGE=']) assert.ok(t.includes(p), '缺少静默参数 ' + p);
  // 向导页和 Linux 版的网页向导一一对应：管理员 → 组件 → 服务器与存储 → 模型 → 其它 → 复核
  for (const page of ['PageAdmin', 'PageComponents', 'PageServer', 'PageModel', 'PageOptions', 'PageReview', 'PageResult', 'un.PageCancel']) assert.ok(t.includes('Function ' + page), '缺少向导页 ' + page);
  assert.match(t, /-AnswersFile "\$AnswersPath"/, '所有选择走答案文件，不上命令行（密码 / 数据库地址 / API Key）');
  assert.ok(!/-AdminPassword |-ModelKey |-PgUrl /.test(t), '命令行里不能出现密码 / Key / 数据库地址');
  assert.match(t, /FileWriteUTF16LE/); assert.match(t, /FileReadUTF16LE/, '记录文件用 UTF-16，非中文系统区域也不乱码');
  assert.match(t, /components\.txt/, '安装时记下装了什么，卸载向导逐项取消');
  assert.match(t, /同时删除全部数据/, '卸载向导里要能选是否同时删除数据');
  assert.match(t, /RequestExecutionLevel \$\{LEVEL\}/); assert.match(t, /!define LEVEL "admin"|-DLEVEL/, '默认要求管理员');
  assert.match(t, /yumeiro-windows\.ps1" install /, '安装要调用包里的 ps1（和命令行安装同一套逻辑）');
  assert.match(t, /Sysnative/, '32 位安装程序要显式调用 64 位 PowerShell');
  for (const k of ['DisplayName', 'DisplayVersion', 'UninstallString', 'QuietUninstallString', 'InstallLocation']) assert.ok(t.includes(k), '“应用和功能”缺少 ' + k);
  assert.match(t, /WriteUninstaller/); assert.match(t, /\/PURGE=/); assert.match(t, /-PurgeData/);
  assert.match(t, /没有成功（退出码 \$0），为避免留下残缺的服务，没有删除任何文件/, '卸载脚本失败时不能继续删程序');
  assert.match(t, /Unregister-ScheduledTask/, '程序目录已不在时也要能清掉计划任务');
  assert.match(t, /dataroot\.txt/, '注册表读不到时的数据目录兜底');
});

test('向导对应的脚本开关：答案文件、引擎选择、HTTPS、备份 / 更新 / 防火墙开关、安装记录和卸载时逐项取消', () => {
  const t = readFileSync(path.join(root, 'deploy/yumeiro-windows.ps1'), 'utf8');
  for (const p of ['AnswersFile', 'AdminPasswordFile', 'Engines', 'WithHttps', 'NoUpdater', 'NoBackupTask', 'NoFirewall', 'NoClients', 'ResultFile']) assert.match(t, new RegExp('\\$' + p + '\\b'), '缺少选项 ' + p);
  assert.match(t, /function Import-Answers/); assert.match(t, /Remove-Item \$path -Force/, '答案文件读完立刻删（里面有密码）');
  assert.match(t, /function Test-PgConnection/, '外部 PostgreSQL 在注册服务之前先测试连接');
  assert.match(t, /components = \$components/, '安装时记录组件');
  assert.match(t, /\$script:NoBackupTask = /, '升级沿用安装时的选择，不会悄悄把备份 / 网页更新打开');
  assert.match(t, /取消安装时的设置/, '卸载逐项说明取消了什么');
  assert.match(t, /PASSWORD_NOTE=/); assert.match(t, /\$shown = ''; if \(\$passwordNote -eq 'generated'\)/, '自己设置的密码不回显');
});

test('卸载：脚本清计划任务、进程、防火墙、服务账号和它们的用户配置文件，数据默认保留', () => {
  const t = readFileSync(path.join(root, 'deploy/yumeiro-windows.ps1'), 'utf8');
  assert.match(t, /npm_config_cache = Join-Path \$Prefix 'npm-cache'/, 'npm 缓存要放进安装目录，卸载才能一起删');
  assert.ok(!/\$env:TEMP/.test(t), '下载用的临时文件不能放在 %TEMP%（失败时会残留，卸载也碰不到）');
  assert.match(t, /Join-Path \$Prefix 'tmp'/);
  assert.match(t, /'update-work'/); assert.match(t, /AppData\\Local\\npm-cache/, '保留数据时也要清可再生的缓存');
  const fn = t.slice(t.indexOf('function Do-Uninstall'), t.indexOf('switch ($Command)'));
  for (const needle of ['Unregister-ScheduledTask', 'Stop-Process', 'Remove-NetFirewallRule', 'Remove-LocalUser', 'Win32_UserProfile', "'yumeiro-caddy'", '-PurgeData', 'Remove-Tree']) assert.ok(fn.includes(needle) || t.includes(needle), '卸载缺少：' + needle);
  assert.ok(fn.indexOf('$PurgeData') > fn.indexOf('Remove-Tree $Prefix'), '数据目录只在 -PurgeData 时才删');
});

test('make-windows-installer.mjs：makensis 查找顺序、载荷检查、输出命名', () => {
  const t = readFileSync(path.join(root, 'scripts/make-windows-installer.mjs'), 'utf8');
  for (const needle of ['--makensis', 'MAKENSIS', 'electron-builder', 'NSIS', '--user-level', 'Yumeiro-Server-Setup-', '-with-clients', 'deploy/yumeiro-windows.ps1', 'deploy/windows/updater.mjs', 'providers.mjs', 'ADD_PRESETS', 'HAS_CLIENTS']) assert.ok(t.includes(needle), '缺少：' + needle);
  assert.match(t, /startsWith\('\.\.'\)/, '解包时要拒绝不安全的路径');
  assert.match(t, /LEVEL=\$\{args\.includes\('--user-level'\) \? 'user' : 'admin'\}/, '只有显式 --user-level 才会编译成非管理员安装程序');
});

test('yumeiro-windows.ps1：带 UTF-8 BOM、语法正确、子命令齐全、和 Linux 版选项对齐', () => {
  const file = path.join(root, 'deploy/yumeiro-windows.ps1');
  const raw = readFileSync(file);
  assert.deepEqual([...raw.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'Windows PowerShell 5.1 读无 BOM 的 UTF-8 会把中文读成乱码');
  const text = raw.toString('utf8');
  for (const cmd of ['install', 'update', 'engines', 'backup', 'status', 'https', 'clients', 'scrub-admin', 'run', 'uninstall']) assert.ok(text.includes(`'${cmd}'`), '缺少子命令 ' + cmd);
  for (const opt of ['Port', 'Domain', 'AdminEmail', 'WithRunner', 'NoEngines', 'PgUrl', 'ModelUrl', 'NpmRegistry', 'InstallNode', 'NodeMirror', 'Prefix', 'DataRoot', 'NoService', 'Yes', 'AllowDowngrade', 'Personal']) assert.match(text, new RegExp('\\$' + opt + '\\b'), '缺少选项 ' + opt);
  assert.ok(!/System32\t/.test(text) && !text.includes('\t'), '脚本里不能有 Tab（\\t 被误转义过）');
  assert.match(text, /SHASUMS256/, '下载 Node.js 要校验 SHA256');
  assert.match(text, /SERVICE_UPDATE_URL=https:\/\/api\.github\.com\/repos\/yumeiro-ai\/yumeiro-windows\/releases\/latest/, 'Windows 服务必须使用独立的 Windows 发布仓库');
  assert.match(text, /robocopy \$Source \$AppDir \/MIR/, '同步代码保留 node_modules');
  const ps = spawnSync('powershell.exe', ['-NoProfile', '-Command', `$e=$null;$t=$null;[void][System.Management.Automation.Language.Parser]::ParseFile('${file}',[ref]$t,[ref]$e);if($e){$e|%{$_.Message+' @'+$_.Extent.StartLineNumber};exit 1}`], { encoding: 'utf8' });
  if (ps.error) return; // 没有 powershell（非 Windows）：跳过语法检查
  assert.equal(ps.status, 0, 'ps1 语法错误：' + ps.stdout + ps.stderr);
});
