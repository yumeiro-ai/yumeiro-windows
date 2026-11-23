// 桌面端容器里的“更新状态”小服务（只在容器内网监听，用 desktop_key 鉴权）。
//   GET  /status  当前版本、最新版本、上次检查结果、是否开启自动更新、是否正在检查
//   POST /check   立即检查并更新（后台执行，立刻返回 202；用 GET /status 看进度）
// 与桥接分开：桥接要等 Cindy 登录后才会启动，而更新状态在登录前就应该能看。
import http from 'node:http';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { listVersions, validVersion } from './pick-release.mjs';

const ROOT = process.env.CINDY_APP_ROOT || path.join(process.env.HOME || '/home/cindy', 'cindy-app');
const LOG = path.join(process.env.HOME || '/home/cindy', 'cindy-update.log');
const UPDATER = process.env.CINDY_UPDATER || '/tmp/desktop-update.sh';
const KEY = String(process.env.BRIDGE_API_KEY || '');
let checking = null; // { startedAt, exitCode }

const read = async file => { try { return (await readFile(file, 'utf8')).trim(); } catch { return ''; } };
const json = (res, status, value) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
const authorized = req => {
  const got = Buffer.from(String(req.headers.authorization || '')), want = Buffer.from('Bearer ' + KEY);
  return KEY.length > 0 && got.length === want.length && timingSafeEqual(got, want);
};

export async function collectStatus() {
  let last = {}; try { last = JSON.parse(await read(path.join(ROOT, 'status.json')) || '{}'); } catch { /* 还没有检查过 */ }
  const logTail = (await read(LOG)).split('\n').slice(-8);
  return {
    flavor: (await read(path.join(ROOT, 'flavor'))) || process.env.CINDY_FLAVOR || 'global',
    pinned: (await read(path.join(ROOT, 'pin'))) || '',
    installed: (await read(path.join(ROOT, 'current-version'))) || last.installed || '',
    previous: (await read(path.join(ROOT, 'prev-version'))) || '',
    usingUpdated: Boolean(await read(path.join(ROOT, 'current-bin'))),
    latest: last.latest || '', result: last.result || '', message: last.message || '', checkedAt: last.checkedAt || '',
    autoUpdate: process.env.CINDY_AUTO_UPDATE !== '0', intervalHours: Number(process.env.CINDY_UPDATE_INTERVAL_HOURS) || 6,
    checking: Boolean(checking && checking.exitCode === undefined), logTail
  };
}

export function startCheck(spawnImpl = spawn, flavor = '', version = 'latest') {
  if (checking && checking.exitCode === undefined) return false;
  checking = { startedAt: Date.now() };
  // CINDY_RESTART_ON_UPDATE=1：更新成功后由 update.sh 负责重启桌面端；flavor 不为空 = 切换到该区域版本
  const child = spawnImpl('bash', flavor ? [UPDATER, 'switch', flavor, version || 'latest'] : [UPDATER, 'check'], { env: { ...process.env, CINDY_RESTART_ON_UPDATE: '1' }, stdio: 'ignore' });
  child.on('exit', code => { checking.exitCode = code ?? -1; });
  child.on('error', () => { checking.exitCode = -1; });
  return true;
}

// 最近发布的版本列表（10 分钟缓存），给页面的“选择版本”下拉框用
let versionCache = { at: 0, list: [] };
export async function recentVersions(fetchImpl = fetch) {
  if (Date.now() - versionCache.at < 10 * 60 * 1000 && versionCache.list.length) return versionCache.list;
  const api = process.env.CINDY_RELEASES_LIST_API || 'https://api.github.com/repos/makecindy/cindy/releases?per_page=20';
  const response = await fetchImpl(api, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'yumeiro-desktop-updater' }, signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error('GitHub 返回 HTTP ' + response.status);
  versionCache = { at: Date.now(), list: listVersions(await response.json()) };
  return versionCache.list;
}

export function createStatusServer() {
  return http.createServer(async (req, res) => {
    try {
      if (!authorized(req)) return json(res, 401, { error: '未授权' });
      const pathname = new URL(req.url, 'http://x').pathname;
      if (req.method === 'GET' && pathname === '/status') return json(res, 200, await collectStatus());
      if (req.method === 'GET' && pathname === '/versions') { try { return json(res, 200, { versions: await recentVersions() }); } catch (error) { return json(res, 200, { versions: [], error: '读取版本列表失败：' + error.message }); } }
      if (req.method === 'POST' && pathname === '/check') return startCheck() ? json(res, 202, { started: true }) : json(res, 409, { error: '正在检查或下载更新，请稍后' });
      if (req.method === 'POST' && pathname === '/switch') {
        const flavor = new URL(req.url, 'http://x').searchParams.get('flavor');
        const version = new URL(req.url, 'http://x').searchParams.get('version') || 'latest';
        if (flavor !== 'global' && flavor !== 'cn') return json(res, 400, { error: 'flavor 只能是 global 或 cn' });
        if (version !== 'latest' && !validVersion(version)) return json(res, 400, { error: 'version 只能是 latest 或 0.1.136 这样的版本号' });
        return startCheck(spawn, flavor, version) ? json(res, 202, { started: true }) : json(res, 409, { error: '正在检查或下载更新，请稍后' });
      }
      return json(res, 404, { error: '未找到' });
    } catch (error) { return json(res, 500, { error: error.message }); }
  });
}

if (process.argv[1]?.endsWith('status-server.mjs')) {
  if (!KEY) { console.error('缺少 BRIDGE_API_KEY，更新状态服务不启动'); process.exit(1); }
  createStatusServer().listen(Number(process.env.STATUS_PORT) || 8789, '0.0.0.0', () => console.log('桌面端更新状态服务已启动'));
}
