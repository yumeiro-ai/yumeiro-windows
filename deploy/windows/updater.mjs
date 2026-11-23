#!/usr/bin/env node
// Windows 服务器版的“网页更新”更新器（对应 Linux 的 root 更新助手 / Docker 的 updater 容器）。
// 以 SYSTEM 身份由计划任务 Yumeiro-Updater 运行，只监听 127.0.0.1，用令牌认证；线格式和 docker/updater 完全相同，
// 所以 server.mjs 不用改：设置 UPDATER_URL + UPDATER_TOKEN_FILE 就走 requestUpdater。
// 流程：网页进程把“已上传/已下载并验过签名的发布包”的文件名交给这里 → 重新验签 + 校验值 + 版本检查 → 解压到工作目录
//       → 运行新包里的 yumeiro-windows.ps1 update（先备份、替换、装依赖、重启服务、等健康，起不来自动回滚）→ 记录状态。
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir, rm, open } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifySignedUpdateZip, extractUpdateZip, sha256OfFile, sameHash, compareVersions } from '../../updatepkg.mjs';
import { startServer } from '../../docker/updater/updater.mjs';

const bad = message => Object.assign(new Error(message), { expose: true });

// 真正执行新包里的 ps1。返回 { code }；日志追加到 logFile
export function runPowerShellUpdate({ dir, prefix, dataRoot, allowDowngrade, logFile, powershell = 'powershell.exe' }) {
  return new Promise(async resolve => {
    const log = await open(logFile, 'w');
    const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(dir, 'deploy', 'yumeiro-windows.ps1'), 'update', '-Yes', '-Prefix', prefix, '-DataRoot', dataRoot, ...(allowDowngrade ? ['-AllowDowngrade'] : [])];
    const child = spawn(powershell, args, { cwd: dir, stdio: ['ignore', log.fd, log.fd], windowsHide: true });
    child.on('error', async error => { await log.appendFile('无法运行 PowerShell：' + error.message + '\n').catch(() => {}); await log.close().catch(() => {}); resolve({ code: 127 }); });
    child.on('close', async code => { await log.close().catch(() => {}); resolve({ code: code ?? 1 }); });
  });
}

export function createWindowsUpdater({ prefix, dataRoot, appDir, dataDir, workRoot, exitAfterSuccess = () => {}, runUpdate = runPowerShellUpdate }) {
  const uploadDir = path.join(dataDir, 'updates'), statusFile = path.join(workRoot, 'status.json'), logFile = path.join(workRoot, 'update.log');
  const writeStatus = async value => { await mkdir(workRoot, { recursive: true }); await writeFile(statusFile, JSON.stringify(value)); };
  const readStatus = async () => {
    let s; try { s = JSON.parse(await readFile(statusFile, 'utf8')); } catch { return { state: 'idle' }; }
    // “运行中”超过 1 小时（更新器或服务器在中途被重启）：不能永远卡在“正在更新”
    if (s.state === 'running' && Date.now() - (Number(s.startedAt) || 0) > 60 * 60 * 1000) s = { ...s, state: 'failed', interrupted: true, finishedAt: Date.now(), log: '更新在中途停止了（可能是服务器被重启）。请在服务器上执行 yumeiro-windows.ps1 status 检查服务。' };
    if (s.state === 'running') { try { s.log = (await readFile(logFile, 'utf8')).slice(-1500); } catch { /* 还没有日志 */ } }
    return s;
  };
  const currentVersion = async () => { try { return JSON.parse(await readFile(path.join(appDir, 'package.json'), 'utf8')).version; } catch { return '0.0.0'; } };

  async function perform(zip, info, from, allowDowngrade) {
    const work = path.join(workRoot, 'job-' + Date.now());
    await mkdir(work, { recursive: true });
    try {
      const { dir } = await extractUpdateZip(zip, work, info.root);
      await rm(zip, { force: true });
      const result = await runUpdate({ dir, prefix, dataRoot, allowDowngrade, logFile });
      let tail = ''; try { tail = (await readFile(logFile, 'utf8')).slice(-3000); } catch { /* 没有日志 */ }
      return { ok: result.code === 0, code: result.code, log: tail };
    } finally { await rm(work, { recursive: true, force: true }).catch(() => {}); }
  }

  async function handle(body) {
    const { action, options = {} } = body;
    if (action === 'update_status') return { message: 'ok', details: await readStatus() };
    if (action !== 'apply_update') throw bad('不支持的操作');
    const u = options.update || {};
    if (!/^incoming-[0-9a-f-]{36}\.zip$/.test(String(u.file || '')) || !/^[0-9a-f]{64}$/.test(String(u.sha256 || ''))) throw bad('更新请求无效');
    if ((await readStatus()).state === 'running') throw bad('已有更新在进行');
    const zip = path.join(uploadDir, u.file);
    if (!sameHash(await sha256OfFile(zip).catch(() => ''), u.sha256)) throw bad('文件在上传后被改动过，已拒绝');
    let info; try { info = await verifySignedUpdateZip(zip); } catch (error) { throw bad(error.message); } // 签名由更新器自己再验一次，不信任网页进程
    const from = await currentVersion();
    if (compareVersions(info.version, from) <= 0 && u.allowDowngrade !== true) throw bad('新版本不高于当前版本；如确需降级，请勾选“允许降级”');
    await writeStatus({ state: 'running', from, version: info.version, startedAt: Date.now() });
    perform(zip, info, from, u.allowDowngrade === true).then(async result => {
      await writeStatus({ state: result.ok ? 'ok' : 'failed', from, version: info.version, exitCode: result.code, finishedAt: Date.now(), log: result.log });
      if (result.ok) exitAfterSuccess(); // 让更新器自己也换成新版本代码（计划任务会把它重新拉起）
    }).catch(async error => { await writeStatus({ state: 'failed', from, version: info.version, finishedAt: Date.now(), log: '出错：' + String(error.message).slice(0, 500) }).catch(() => {}); });
    return { message: '更新已开始', details: { version: info.version, from } };
  }
  return { handle, readStatus };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const env = process.env;
  const token = (await readFile(env.UPDATER_TOKEN_FILE || '', 'utf8').catch(() => '')).trim();
  if (token.length < 24) { console.error('updater token missing or too short'); process.exit(1); }
  const prefix = env.YUMEIRO_PREFIX, dataRoot = env.YUMEIRO_DATAROOT;
  if (!prefix || !dataRoot) { console.error('YUMEIRO_PREFIX / YUMEIRO_DATAROOT missing'); process.exit(1); }
  const updater = createWindowsUpdater({
    prefix, dataRoot, appDir: path.join(prefix, 'app'), dataDir: env.DATA_DIR || path.join(dataRoot, 'data'), workRoot: path.join(dataRoot, 'update-work'),
    exitAfterSuccess: () => setTimeout(() => process.exit(75), 3000) // 非 0：计划任务按“失败”重启它，换成新版本代码
  });
  await startServer({ token, updater, port: Number(env.UPDATER_PORT) || 8789, host: '127.0.0.1' });
  console.log('windows updater listening');
}
