// Docker 版“网页更新”的更新器。运行在 updater 容器里（见 docker-compose.updater.yml）。
// 管理员在网页上传官方签名的发布包后，yumeiro 容器通过内部网络 + 令牌把文件名交给这里：
//   重新验签 → 版本检查 → 备份（程序文件 + 数据卷）→ 替换程序文件 → docker compose up -d --build --no-deps yumeiro
//   → 等待健康；没起来就恢复旧程序文件重建。数据卷的备份留在 backups/ 里，不自动回写（避免覆盖失败期间的新数据）。
import http from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir, rm, cp, readdir, stat } from 'node:fs/promises';
import { timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifySignedUpdateZip, extractUpdateZip, sha256OfFile, sameHash, compareVersions } from '../../updatepkg.mjs';

const REPLACE_DIRS = ['public', 'scripts', 'runner', 'setup', 'deploy', 'docker'];
const PROTECTED = new Set(['.env', 'secrets', 'backups', '.update-work', 'node_modules', '.git']);
const bad = message => Object.assign(new Error(message), { expose: true });

export function run(cmd, args, { cwd, env } = {}) {
  return new Promise(resolve => {
    let out = ''; const child = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    const keep = c => { out = (out + c).slice(-6000); };
    child.stdout.on('data', keep); child.stderr.on('data', keep);
    child.on('error', error => resolve({ code: 127, out: String(error.message) }));
    child.on('close', code => resolve({ code, out }));
  });
}

export function createUpdater({ projectDir, dataDir, docker = 'docker', tar = 'tar', healthTimeoutMs = 180000, pollMs = 3000, exitAfterSuccess = () => {}, exec = run }) {
  const uploadDir = path.join(dataDir, 'updates'), statusFile = path.join(uploadDir, 'status.json'), workRoot = path.join(projectDir, '.update-work'), backupDir = path.join(projectDir, 'backups');
  const readStatus = async () => { try { return JSON.parse(await readFile(statusFile, 'utf8')); } catch { return { state: 'idle' }; } };
  const writeStatus = async value => { await mkdir(uploadDir, { recursive: true }); await writeFile(statusFile, JSON.stringify(value)); };
  const compose = (...args) => exec(docker, ['compose', ...args], { cwd: projectDir });

  async function waitHealthy() {
    const deadline = Date.now() + healthTimeoutMs;
    while (Date.now() < deadline) {
      const id = (await compose('ps', '-q', 'yumeiro')).out.trim().split('\n').pop();
      if (id) { const r = await exec(docker, ['inspect', '-f', '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}', id]); const state = r.out.trim(); if (state === 'healthy' || state === 'running') return true; }
      await new Promise(r => setTimeout(r, pollMs));
    }
    return false;
  }
  async function currentVersion() { try { return JSON.parse(await readFile(path.join(projectDir, 'package.json'), 'utf8')).version; } catch { return '0.0.0'; } }

  async function replaceCode(srcDir) {
    for (const dir of REPLACE_DIRS) await rm(path.join(projectDir, dir), { recursive: true, force: true });
    for (const name of await readdir(srcDir)) { if (PROTECTED.has(name) || name === 'Yumeiro-Clients') continue; await cp(path.join(srcDir, name), path.join(projectDir, name), { recursive: true, force: true }); }
  }

  async function perform(zip, info, from, log) {
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14), work = path.join(workRoot, 'job-' + stamp);
    await mkdir(work, { recursive: true }); await mkdir(backupDir, { recursive: true });
    const codeBackup = path.join(backupDir, `code-${from}-${stamp}.tar.gz`), dataBackup = path.join(backupDir, `data-${from}-${stamp}.tar.gz`);
    const { dir } = await extractUpdateZip(zip, work, info.root); await rm(zip, { force: true });
    log('已解压新版本 ' + info.version);
    let r = await exec(tar, ['czf', codeBackup, '--exclude=./.env', '--exclude=./secrets', '--exclude=./backups', '--exclude=./.update-work', '--exclude=./node_modules', '-C', projectDir, '.']);
    if (r.code !== 0) throw new Error('备份程序文件失败，已取消更新：' + r.out.slice(-300));
    r = await exec(tar, ['czf', dataBackup, '--exclude=./updates', '--exclude=./downloads', '-C', dataDir, '.']);
    if (r.code !== 0) throw new Error('备份数据失败，已取消更新：' + r.out.slice(-300));
    log('已备份：' + path.basename(codeBackup) + '、' + path.basename(dataBackup));
    const pgs = (await compose('ps', '--services')).out.split('\n').map(x => x.trim());
    if (pgs.includes('postgres')) { const dump = await exec('sh', ['-c', `${docker} compose exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB"' | gzip > "${path.join(backupDir, `postgres-${from}-${stamp}.sql.gz`)}"`], { cwd: projectDir }); log(dump.code === 0 ? '已备份内置 PostgreSQL' : '内置 PostgreSQL 备份失败（继续更新）：' + dump.out.slice(-200)); }
    for (const prefix of ['code-', 'data-', 'postgres-']) { const olds = (await readdir(backupDir)).filter(n => n.startsWith(prefix)).sort().reverse().slice(3); for (const n of olds) await rm(path.join(backupDir, n), { force: true }); }
    await replaceCode(dir); log('已替换程序文件，正在重建 yumeiro 服务（需要几分钟）…');
    r = await compose('up', '-d', '--build', '--no-deps', 'yumeiro'); log(r.out.slice(-400));
    if (r.code === 0 && await waitHealthy()) {
      const clients = path.join(dir, 'Yumeiro-Clients');
      if (await stat(clients).then(() => true, () => false)) { const c = await exec('node', [path.join(projectDir, 'scripts/install-clients.mjs'), clients, '--prune'], { env: { DATA_DIR: dataDir } }); await exec('chown', ['-R', '1000:1000', path.join(dataDir, 'downloads')]); log(c.code === 0 ? '客户端安装包已发布' : '客户端安装包发布失败（不影响服务）'); }
      return { ok: true };
    }
    log('新版本没有起来，正在恢复旧程序文件…');
    for (const d of REPLACE_DIRS) await rm(path.join(projectDir, d), { recursive: true, force: true });
    await exec(tar, ['xzf', codeBackup, '-C', projectDir]);
    await compose('up', '-d', '--build', '--no-deps', 'yumeiro'); const back = await waitHealthy();
    log(back ? '已回滚到旧版本，服务已恢复。数据备份保留在 backups/ 里，需要时可手动恢复。' : '回滚后服务仍未就绪，请在服务器上查看：docker compose logs yumeiro。备份在 backups/。');
    return { ok: false };
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
    let info; try { info = await verifySignedUpdateZip(zip); } catch (error) { throw bad(error.message); }
    const from = await currentVersion();
    if (compareVersions(info.version, from) <= 0 && u.allowDowngrade !== true) throw bad('新版本不高于当前版本；如确需降级，请勾选“允许降级”');
    const lines = []; const log = text => { lines.push(text); };
    await writeStatus({ state: 'running', from, version: info.version, startedAt: Date.now() });
    perform(zip, info, from, log).then(async result => {
      await writeStatus({ state: result.ok ? 'ok' : 'failed', from, version: info.version, finishedAt: Date.now(), log: lines.join('\n').slice(-3000) });
      if (result.ok) exitAfterSuccess();
    }).catch(async error => { lines.push('出错：' + error.message); await writeStatus({ state: 'failed', from, version: info.version, finishedAt: Date.now(), log: lines.join('\n').slice(-3000) }).catch(() => {}); });
    return { message: '更新已开始', details: { version: info.version, from } };
  }
  return { handle, readStatus };
}

export function startServer({ token, updater, port = 8790, host = '0.0.0.0' }) {
  const tokenBuf = Buffer.from(token);
  const server = http.createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/') return res.writeHead(404).end();
    const given = Buffer.from(String(req.headers.authorization || '').replace(/^Bearer /, ''));
    if (given.length !== tokenBuf.length || !timingSafeEqual(given, tokenBuf)) return res.writeHead(403).end();
    let text = ''; for await (const chunk of req) { text += chunk; if (text.length > 32768) return res.writeHead(413).end(); }
    let body; try { body = JSON.parse(text); } catch { return res.writeHead(400).end(); }
    try { const result = await updater.handle(body); res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify({ ok: true, ...result })); }
    catch (error) { res.writeHead(500, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify({ ok: false, expose: Boolean(error?.expose), error: error?.expose ? error.message : 'operation failed' })); }
  });
  return new Promise(resolve => server.listen(port, host, () => resolve(server)));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const token = (await readFile(process.env.UPDATER_TOKEN_FILE || '/run/secrets/updater_token', 'utf8').catch(() => '')).trim();
  if (token.length < 24) { console.error('updater token missing or too short'); process.exit(1); }
  const projectDir = process.env.PROJECT_DIR; if (!projectDir) { console.error('PROJECT_DIR missing'); process.exit(1); }
  // 成功后自己退出一次：restart 策略会让它从挂载的安装目录重新加载（已经是新版本的更新器代码）
  const updater = createUpdater({ projectDir, dataDir: process.env.DATA_DIR || '/data', exitAfterSuccess: () => setTimeout(() => process.exit(0), 3000) });
  await startServer({ token, updater, port: Number(process.env.UPDATER_PORT) || 8790 });
  console.log('updater listening');
}
