import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ADMIN = { email: 'owner@example.com', password: 'a-very-long-test-password' };

test('外部市场来源：GitHub 仓库 / JSON 索引；权限、校验、启停、安装；生产模式拒绝 http 与内网', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'cindy-ext-'));
  const keyFile = path.join(dir, 'k'); await writeFile(keyFile, randomBytes(32).toString('base64'));
  const hits = [];
  const upstream = http.createServer((req, res) => {
    hits.push(req.url);
    const send = (body, type = 'application/json') => { res.writeHead(200, { 'Content-Type': type }); res.end(typeof body === 'string' ? body : JSON.stringify(body)); };
    if (req.url.startsWith('/repos/acme/skills/git/trees/main')) return send({ tree: [
      { type: 'blob', path: 'README.md' }, { type: 'blob', path: 'skills/alpha/SKILL.md' }, { type: 'blob', path: 'skills/beta/SKILL.md' }, { type: 'blob', path: 'skills/gamma/SKILL.md' }, { type: 'blob', path: 'skills/beta/run.sh' }, { type: 'blob', path: 'node_modules/x/SKILL.md' }] });
    if (req.url === '/acme/skills/main/skills/alpha/SKILL.md') return send('---\nname: Alpha 技能\ndescription: 第一个\n---\n\n做 alpha 的事。', 'text/plain');
    if (req.url === '/acme/skills/main/skills/beta/SKILL.md') return send('没有前言的正文', 'text/plain');
    if (req.url === '/acme/skills/main/skills/gamma/SKILL.md') return send('---\nname: gamma\ndescription: >\n  第一行说明\n  第二行说明\nmetadata: x\n---\n\n正文', 'text/plain');
    if (req.url === '/redir-ok') { res.writeHead(302, { Location: '/index.json' }); return res.end(); }
    if (req.url === '/redir-evil') { res.writeHead(302, { Location: 'https://evil.example/steal' }); return res.end(); }
    if (req.url === '/redir-loop') { res.writeHead(302, { Location: '/redir-loop' }); return res.end(); }
    if (req.url === '/index.json') return send({ items: [
      { type: 'skill', key: 'k1', title: '索引技能', description: '来自索引', tags: ['x'], content: '索引里的技能正文' },
      { type: 'bot', key: 'b1', title: '索引机器人', prompt: '你是索引机器人', skills: [{ title: '附带技能', content: '附带内容' }] },
      { type: 'weird', title: '坏条目' }, { type: 'skill', title: '' }, { type: 'skill', title: '没内容', content: '' }] });
    res.writeHead(404); res.end('no');
  });
  await new Promise(r => upstream.listen(0, '127.0.0.1', r));
  const up = 'http://127.0.0.1:' + upstream.address().port;
  const run = async env => {
    const port = 20000 + Math.floor(Math.random() * 20000);
    const child = spawn(process.execPath, ['server.mjs'], { cwd: root, env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: await mkdtemp(path.join(dir, 'd-')), COOKIE_SECURE: 'false', STORE_ENCRYPTION_KEY_FILE: keyFile, ADMIN_EMAIL: ADMIN.email, ADMIN_PASSWORD: ADMIN.password, ...env }, stdio: ['ignore', 'pipe', 'inherit'] });
    await new Promise((resolve, reject) => { child.on('exit', c => reject(new Error('exit ' + c))); child.stdout.on('data', c => { if (String(c).includes('listening')) resolve(); }); });
    const base = 'http://127.0.0.1:' + port;
    const login = async acc => { const r = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify(acc) }); const d = await r.json(); return { cookie: r.headers.get('set-cookie').split(';')[0], csrf: d.csrfToken }; };
    const call = async (auth, p, method = 'GET', body) => { const r = await fetch(base + p, { method, headers: { Origin: base, Cookie: auth.cookie, 'X-CSRF-Token': auth.csrf, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, data: await r.json().catch(() => ({})) }; };
    return { child, base, login, call };
  };
  const on = await run({ MARKET_TEST_ALLOW_PRIVATE: '1', MARKET_GITHUB_API: up, MARKET_GITHUB_RAW: up });
  const prod = await run({});
  try {
    const owner = await on.login(ADMIN);
    await on.call(owner, '/api/admin/members', 'POST', { email: 'ext-member@example.com', password: 'member-password-12345' });
    const member = await on.login({ email: 'ext-member@example.com', password: 'member-password-12345' });
    // 权限与校验
    assert.equal((await on.call(member, '/api/admin/market/sources')).status, 403);
    assert.equal((await on.call(member, '/api/admin/market/sources', 'POST', { kind: 'github', repo: 'acme/skills' })).status, 403);
    assert.equal((await on.call(owner, '/api/admin/market/sources', 'POST', { kind: 'github', repo: 'not a repo' })).status, 400);
    assert.equal((await on.call(owner, '/api/admin/market/sources', 'POST', { kind: 'github', repo: 'acme/skills', path: '../etc' })).status, 400);
    assert.equal((await on.call(owner, '/api/admin/market/sources', 'POST', { kind: 'index', url: 'nonsense' })).status, 400);
    // GitHub 来源：只读 SKILL.md，忽略脚本 / node_modules / README
    const gh = await on.call(owner, '/api/admin/market/sources', 'POST', { kind: 'github', repo: 'https://github.com/acme/skills.git', name: 'Acme 技能库' });
    assert.equal(gh.status, 201, JSON.stringify(gh.data));
    assert.equal(gh.data.source.count, 3); assert.equal(gh.data.source.error, '');
    const idx = await on.call(owner, '/api/admin/market/sources', 'POST', { kind: 'index', url: up + '/index.json', name: '示例索引' });
    assert.equal(idx.data.source.count, 2, '坏条目被丢弃');
    // 跳转：同一域名（白名单）可以跟随；跳到陌生域名 / 无限跳转一律失败并说明原因
    const viaRedirect = await on.call(owner, '/api/admin/market/sources', 'POST', { kind: 'index', url: up + '/redir-ok', name: '跳转索引' });
    assert.equal(viaRedirect.data.source.count, 2, '白名单域名内的跳转会被跟随');
    const evilRedirect = await on.call(owner, '/api/admin/market/sources', 'POST', { kind: 'index', url: up + '/redir-evil', name: '恶意跳转' });
    assert.match(evilRedirect.data.source.error, /不受信任/); assert.equal(evilRedirect.data.source.count, 0);
    const loopRedirect = await on.call(owner, '/api/admin/market/sources', 'POST', { kind: 'index', url: up + '/redir-loop', name: '循环跳转' });
    assert.match(loopRedirect.data.source.error, /跳转次数/);
    for (const extra of [viaRedirect, evilRedirect, loopRedirect]) await on.call(owner, '/api/admin/market/sources/' + extra.data.source.id, 'DELETE');
    // 成员在市场里看到第三方条目
    const market = (await on.call(member, '/api/market')).data;
    assert.equal(market.skills.find(s => s.title === 'gamma').description, '第一行说明 第二行说明', 'YAML 折叠多行描述');
    const alpha = market.skills.find(s => s.title === 'Alpha 技能');
    assert.ok(alpha && alpha.source === 'external' && alpha.author === 'Acme 技能库' && alpha.sourceName === 'Acme 技能库');
    assert.equal(market.skills.find(s => s.title === 'beta').source, 'external', '没有前言时用目录名当标题');
    assert.equal(market.skills.some(s => /node_modules|run\.sh/.test(s.title)), false);
    // 安装：复制为自己的技能；机器人模板连带技能
    const got = await on.call(member, '/api/market/install', 'POST', { type: 'skill', key: alpha.key });
    assert.equal(got.status, 201); assert.equal(got.data.skill.content, '做 alpha 的事。'); assert.equal(got.data.skill.shared, false);
    const botTpl = market.bots.find(b => b.title === '索引机器人');
    assert.ok(botTpl && botTpl.skillCount === 1);
    const bot = await on.call(member, '/api/market/install', 'POST', { type: 'bot', key: botTpl.key });
    assert.equal(bot.status, 201); assert.match(bot.data.token, /^bot_/);
    assert.equal((await on.call(member, '/api/skills')).data.skills.some(s => s.title === '附带技能'), true);
    // 停用 → 条目消失（已安装的不受影响）；启用恢复；刷新；删除
    assert.equal((await on.call(owner, '/api/admin/market/sources/' + gh.data.source.id, 'PATCH', { enabled: false })).status, 200);
    assert.equal((await on.call(member, '/api/market')).data.skills.some(s => s.title === 'Alpha 技能'), false);
    assert.equal((await on.call(member, '/api/skills')).data.skills.some(s => s.title === 'Alpha 技能'), true);
    assert.equal((await on.call(owner, '/api/admin/market/sources/' + gh.data.source.id, 'PATCH', { enabled: true })).data.source.count, 3);
    const before = hits.length;
    assert.equal((await on.call(owner, `/api/admin/market/sources/${gh.data.source.id}/refresh`, 'POST')).status, 200);
    assert.ok(hits.length > before, '手动刷新会重新抓取');
    assert.equal((await on.call(owner, '/api/admin/market/sources/' + idx.data.source.id, 'DELETE')).status, 200);
    assert.equal((await on.call(member, '/api/market')).data.bots.some(b => b.title === '索引机器人'), false);
    // 生产模式：只允许 https；解析到内网 / 回环的地址一律拒绝
    const adminProd = await prod.login(ADMIN);
    assert.equal((await prod.call(adminProd, '/api/admin/market/sources', 'POST', { kind: 'index', url: up + '/index.json' })).status, 400);
    const loop = await prod.call(adminProd, '/api/admin/market/sources', 'POST', { kind: 'index', url: 'https://127.0.0.1/index.json' });
    assert.equal(loop.status, 201);
    assert.match(loop.data.source.error, /内网|本机/, '指向回环地址的来源抓取失败并给出原因');
    assert.equal(loop.data.source.count, 0);
  } finally {
    on.child.removeAllListeners('exit'); prod.child.removeAllListeners('exit'); on.child.kill(); prod.child.kill(); upstream.close();
    await new Promise(r => setTimeout(r, 200)); await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});
