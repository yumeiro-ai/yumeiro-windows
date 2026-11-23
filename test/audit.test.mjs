import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { addAudit, queryAudit, summarize, toCsv, categoryOf } from '../audit.mjs';
import { evaluate, normalizeGuard, parseTrace, vendorOfUrl, vendorOfEngine, usesProxy, VENDORS, probeTarget, validProxyUrl, maskProxy, TARGETS } from '../envcheck.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ---------- 纯函数 ----------
test('审计：记录、筛选、分类、按账号统计、CSV 防公式注入', () => {
  const db = { users: { u1: { email: 'a@x.com' }, u2: { email: 'b@x.com' } }, stats: {}, audit: [] };
  const now = Date.now();
  addAudit(db, { userId: 'u1', action: 'call.web', target: 'gpt' }, now);
  addAudit(db, { userId: 'u1', action: 'file.write', target: 'a.md' }, now);
  addAudit(db, { userId: 'u1', action: 'file.delete', target: 'a.md', detail: '=cmd()' }, now);
  addAudit(db, { userId: 'u2', action: 'expiry.delete', target: 'old.txt', ok: false }, now);
  assert.equal(queryAudit(db, { userId: 'u1' }).length, 3);
  assert.equal(queryAudit(db, { category: 'delete' }).length, 2);
  assert.equal(queryAudit(db, { ok: 'false' }).length, 1);
  assert.equal(queryAudit(db, { q: 'old' })[0].email, 'b@x.com');
  assert.equal(queryAudit(db, { limit: 1 })[0].action, 'expiry.delete', '最新的在前');
  assert.equal(categoryOf('call.api'), 'call'); assert.equal(categoryOf('login_failed'), 'auth'); assert.equal(categoryOf('guard.block'), 'guard'); assert.equal(categoryOf('provider_created'), 'admin');
  const sum = summarize(db, { days: 7, now });
  assert.equal(sum.users[0].email, 'a@x.com'); assert.equal(sum.users[0].total, 3); assert.equal(sum.users[0].byCategory.delete, 1);
  assert.equal(sum.series.length, 7); assert.equal(sum.series.at(-1).total, 4);
  assert.equal(summarize(db, { days: 7, userId: 'u2', now }).users.length, 1);
  const csv = toCsv(queryAudit(db, {}));
  assert.match(csv, /"'=cmd\(\)"/, '以 = 开头的内容被转义');
});

test('审计：超过上限只保留最新的，计数器不丢', () => {
  const db = { users: {}, stats: {}, audit: [] };
  for (let i = 0; i < 600; i++) addAudit(db, { userId: 'u', action: 'call.web' }, 1000 + i);
  assert.ok(db.audit.length <= 5000);
  assert.equal(Object.values(db.stats.u.ops).reduce((n, day) => n + day['call.web'], 0), 600);
});

test('环境检测：受限地区拒绝、频率上限拒绝、其余只提示', () => {
  const guard = normalizeGuard({});
  const probesOk = TARGETS.map(t => ({ id: t.id, vendor: t.vendor, label: t.label, reachable: true, status: 200, ms: 120, challenged: false }));
  const ok = evaluate({ egress: { country: 'US', ip: '1.1.1.1' }, probes: probesOk, guard });
  assert.equal(ok.level, 'ok'); assert.equal(ok.vendors.claude.block, false);

  const cn = evaluate({ egress: { country: 'CN', ip: '2.2.2.2' }, probes: probesOk, guard });
  assert.equal(cn.vendors.claude.level, 'danger'); assert.equal(cn.vendors.codex.block, true);
  assert.match(cn.vendors.claude.advice.join(''), /暂时无法使用/); assert.doesNotMatch(JSON.stringify(cn), /合规出口|绕过|换出口/);
  assert.equal(evaluate({ egress: { country: 'CN' }, probes: probesOk, guard: normalizeGuard({ enabled: false }) }).vendors.claude.block, false, '关闭守卫后只提示不拦截');

  const rate = evaluate({ egress: { country: 'US' }, probes: probesOk, guard, usage: { claude: { lastHour: 40, concurrent: 0, users24h: 1 } } });
  assert.equal(rate.vendors.claude.block, true); assert.equal(rate.vendors.codex.block, false);
  const near = evaluate({ egress: { country: 'US' }, probes: probesOk, guard, usage: { claude: { lastHour: 30, concurrent: 0, users24h: 1 } } });
  assert.equal(near.vendors.claude.level, 'warn'); assert.equal(near.vendors.claude.block, false);

  const shared = evaluate({ egress: { country: 'US', hosting: true, isp: 'Some Cloud' }, probes: probesOk, guard, usage: { codex: { lastHour: 1, concurrent: 0, users24h: 3 } }, regionHistory: ['US', 'DE', 'JP'] });
  assert.equal(shared.vendors.codex.level, 'warn');
  const text = shared.vendors.codex.reasons.map(r => r.text).join('|');
  assert.match(text, /3 个账号/); assert.match(text, /数据中心/); assert.match(text, /变化了 3 个/);
  const down = evaluate({ egress: { country: 'US' }, probes: probesOk.map(p => ({ ...p, reachable: false, error: 'ETIMEDOUT' })), guard });
  assert.equal(down.vendors.claude.level, 'warn'); assert.equal(down.vendors.claude.block, false);
});

test('环境检测：解析与探测', async () => {
  assert.deepEqual(parseTrace('fl=1\nip=9.9.9.9\nloc=jp\ncolo=NRT\n'), { ip: '9.9.9.9', country: 'JP', colo: 'NRT' });
  assert.equal(vendorOfUrl('https://api.anthropic.com/v1/'), 'claude'); assert.equal(vendorOfUrl('https://api.openai.com/v1'), 'codex'); assert.equal(vendorOfUrl('https://api.deepseek.com'), 'deepseek');
  assert.equal(vendorOfEngine('claude'), 'claude'); assert.equal(vendorOfEngine('pi'), null);
  assert.equal(validProxyUrl('http://127.0.0.1:7890'), true); assert.equal(validProxyUrl('socks5://x'), false); assert.equal(validProxyUrl('javascript:1'), false);
  assert.doesNotMatch(maskProxy('http://user:pass@127.0.0.1:7890'), /pass/);
  assert.deepEqual(normalizeGuard({ restricted: 'cn, ru ,xx1', hourlyLimit: 0 }).restricted, ['CN', 'RU']);
  const reachable = await probeTarget(TARGETS[0], { fetchFn: async () => new Response('x', { status: 401 }) });
  assert.equal(reachable.reachable, true); assert.equal(reachable.status, 401); assert.equal(reachable.challenged, false);
  const limited = await probeTarget(TARGETS[0], { fetchFn: async () => new Response('x', { status: 429 }) });
  assert.equal(limited.challenged, true);
  const dead = await probeTarget(TARGETS[0], { fetchFn: async () => { throw new Error('boom'); } });
  assert.equal(dead.reachable, false);
});

// ---------- 接口集成 ----------
const ADMIN = { email: 'owner@example.com', password: 'a-very-long-test-password' };
let dir, model, app, base, owner;
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
test.before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'cindy-audit-'));
  const keyFile = path.join(dir, 'k'), adminFile = path.join(dir, 'a');
  await writeFile(keyFile, randomBytes(32).toString('base64')); await writeFile(adminFile, ADMIN.password);
  model = http.createServer((req, res) => {
    let raw = ''; req.on('data', c => raw += c);
    req.on('end', () => {
      const body = JSON.parse(raw), system = body.messages.find(m => m.role === 'system')?.content || '', last = body.messages.at(-1).content;
      const reply = last.startsWith('从下面这一轮对话里') ? '[]' : `echo:${last};sys=${system.slice(0, 30)}`;
      if (body.stream) { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: reply } }] }) + '\n\n'); res.write('data: ' + JSON.stringify({ choices: [], usage: { prompt_tokens: 3, completion_tokens: 4 } }) + '\n\n'); return res.end('data: [DONE]\n\n'); }
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { content: reply } }], usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 } }));
    });
  });
  const modelPort = await listen(model);
  const port = 20000 + Math.floor(Math.random() * 20000);
  base = 'http://127.0.0.1:' + port;
  app = spawn(process.execPath, ['server.mjs'], { cwd: root, stdio: ['ignore', 'pipe', 'inherit'], env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dir, COOKIE_SECURE: 'false', TRUST_PROXY: 'false', STORE_ENCRYPTION_KEY_FILE: keyFile, ADMIN_EMAIL: ADMIN.email, ADMIN_PASSWORD_FILE: adminFile, MODEL_BASE_URL: `http://127.0.0.1:${modelPort}/v1`, MODEL_NAME: 'test-model', MODEL_API_KEY: 'k', ENV_CHECK_INTERVAL_MS: '0' } });
  await new Promise((resolve, reject) => { app.on('exit', code => reject(new Error('exit ' + code))); app.stdout.on('data', c => { if (String(c).includes('listening')) resolve(); }); });
  owner = await login(ADMIN);
});
test.after(async () => { app?.removeAllListeners('exit'); app?.kill(); model?.close(); await new Promise(r => setTimeout(r, 300)); await rm(dir, { recursive: true, force: true }).catch(() => {}); });
async function login(account) {
  const response = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify(account) });
  return { cookie: response.headers.get('set-cookie').split(';')[0], csrf: (await response.json()).csrfToken };
}
async function call(auth, p, method = 'GET', body) {
  const response = await fetch(base + p, { method, headers: { Origin: base, Cookie: auth.cookie, 'X-CSRF-Token': auth.csrf, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const type = response.headers.get('content-type') || '';
  return { status: response.status, type, data: type.includes('json') ? await response.json() : await response.text() };
}

test('审计接口：调用与管理操作被记录；成员只能看自己的；主账号可导出', async () => {
  const conv = (await call(owner, '/api/conversations', 'POST', {})).data.conversation;
  await call(owner, '/api/chat', 'POST', { conversation_id: conv.id, message: '你好呀审计' });
  await call(owner, '/api/admin/members', 'POST', { email: 'm@example.com', password: 'member-password-12345' });
  const mine = await login({ email: 'm@example.com', password: 'member-password-12345' });
  const mc = (await call(mine, '/api/conversations', 'POST', {})).data.conversation;
  await call(mine, '/api/chat', 'POST', { conversation_id: mc.id, message: '成员的提问内容' });

  const all = (await call(owner, '/api/audit?limit=200')).data;
  assert.ok(all.entries.some(e => e.action === 'call.web' && e.email === ADMIN.email));
  assert.ok(all.entries.some(e => e.action === 'member_created'));
  assert.ok(all.entries.some(e => e.action === 'login_success'));
  const memberView = (await call(mine, '/api/audit?limit=200')).data;
  assert.ok(memberView.entries.length > 0);
  assert.ok(memberView.entries.every(e => e.email === 'm@example.com'), '成员只能看到自己的记录');
  assert.equal((await call(mine, '/api/audit?email=owner@example.com')).data.entries.every(e => e.email === 'm@example.com'), true, '成员不能用筛选看别人的');
  assert.equal((await call(mine, '/api/admin/audit.csv')).status, 403);

  const sum = (await call(owner, '/api/audit/summary?days=7')).data;
  const row = sum.users.find(u => u.email === 'm@example.com');
  assert.ok(row && row.byCategory.call >= 1);
  assert.equal((await call(mine, '/api/audit/summary')).data.users.every(u => u.email === 'm@example.com'), true);
  const csv = await call(owner, '/api/admin/audit.csv?email=m@example.com');
  assert.match(csv.type, /csv/); assert.match(csv.data, /call\.web/);
  assert.ok((await call(owner, '/api/audit?action=audit.export')).data.entries.length >= 1, '导出本身也被记录');
});

test('Anthropic 兼容中转：x-api-key 调用、流式、用量与审计', async () => {
  const token = (await call(owner, '/api/tokens', 'POST', { name: 'claude-code' })).data.token;
  const r = await fetch(base + '/v1/messages', { method: 'POST', headers: { 'x-api-key': token, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'claude-sonnet-x', max_tokens: 100, system: [{ type: 'text', text: '你是助手' }], messages: [{ role: 'user', content: [{ type: 'text', text: '你好 relay' }] }] }) });
  const data = await r.json();
  assert.equal(r.status, 200); assert.equal(data.type, 'message'); assert.equal(data.role, 'assistant');
  assert.match(data.content[0].text, /echo:你好 relay;sys=你是助手/); assert.equal(data.usage.output_tokens, 4); assert.equal(data.model, 'claude-sonnet-x');
  const s = await fetch(base + '/v1/messages', { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'x', stream: true, messages: [{ role: 'user', content: '流式' }] }) });
  const text = await s.text();
  assert.match(text, /event: message_start/); assert.match(text, /text_delta/); assert.match(text, /event: message_stop/); assert.match(text, /echo:流式/);
  const bad = await fetch(base + '/v1/messages', { method: 'POST', headers: { 'x-api-key': 'cak_wrongwrongwrongwrongwrong', 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(bad.status, 401);
  assert.ok((await call(owner, '/api/audit?action=call.api')).data.entries.length >= 2);
});

test('环境检测接口：仅主账号；守卫设置可保存，代理地址不回显密码', async () => {
  const mine = await login({ email: 'm@example.com', password: 'member-password-12345' });
  assert.equal((await call(mine, '/api/admin/env')).status, 403);
  const env = await call(owner, '/api/admin/env?fresh=1');
  assert.equal(env.status, 200); assert.ok(env.data.result.vendors.claude && env.data.result.vendors.codex && env.data.result.vendors.gemini && env.data.result.vendors.deepseek); assert.ok(env.data.guard.restricted.includes('CN'));
  assert.deepEqual(Object.keys(env.data.usage).sort(), ['claude', 'codex', 'deepseek', 'gemini']);
  // 服务器体检：仅主账号
  assert.equal((await call(mine, '/api/admin/doctor')).status, 403);
  const doctor = await call(owner, '/api/admin/doctor');
  assert.equal(doctor.status, 200); assert.ok(doctor.data.checks.length > 15);
  assert.deepEqual([...new Set(doctor.data.checks.map(c => c.group))], ['系统', '存储与安全', '模型与服务', '网络', '客户端与内容']);
  assert.equal(doctor.data.checks.find(c => c.title === '数据目录可写').level, 'ok');
  assert.equal(doctor.data.checks.find(c => c.title === 'Node.js 版本').level, 'ok');
  assert.ok(!doctor.data.checks.some(c => /可达性|出口 IP/.test(c.title)), '体检不再混入环境检测的内容');
  assert.match(doctor.data.report, /服务器体检/); assert.ok(['ok', 'warn', 'fail'].includes(doctor.data.summary.level));
  assert.ok(JSON.stringify(doctor.data).indexOf('member-password') < 0 && JSON.stringify(doctor.data).indexOf('apiKey') < 0, '体检结果不含密钥');
  assert.equal((await call(owner, '/api/admin/env/guard', 'PUT', { proxyUrl: 'ftp://x' })).status, 400);
  const saved = await call(owner, '/api/admin/env/guard', 'PUT', { hourlyLimit: 10, restricted: 'CN, RU', proxyUrl: 'http://user:secret@127.0.0.1:1' });
  assert.equal(saved.data.guard.hourlyLimit, 10); assert.deepEqual(saved.data.guard.restricted, ['CN', 'RU']); assert.equal(saved.data.guard.hasProxy, true);
  assert.doesNotMatch(JSON.stringify(saved.data), /secret/);
  assert.equal((await call(owner, '/api/admin/env/guard', 'PUT', { clearProxy: true })).data.guard.hasProxy, false);
  // CleanIP 密钥：格式不对被拒；保存后接口和审计里都只有掩码；可以清除
  assert.equal((await call(owner, '/api/admin/env/guard', 'PUT', { cleanipKey: 'sk-not-cleanip' })).status, 400);
  const withKey = await call(owner, '/api/admin/env/guard', 'PUT', { cleanipKey: 'cip_abcdefgh12345678', cleanipEnabled: true });
  assert.equal(withKey.data.guard.hasCleanipKey, true); assert.equal(withKey.data.guard.cleanipKey, 'cip_••••5678');
  assert.doesNotMatch(JSON.stringify(withKey.data), /abcdefgh12345678/);
  assert.doesNotMatch(JSON.stringify((await call(owner, '/api/admin/env')).data), /abcdefgh12345678/);
  assert.doesNotMatch(JSON.stringify((await call(owner, '/api/audit?action=settings.guard')).data), /abcdefgh12345678/, '审计里不能出现明文密钥');
  assert.equal((await call(owner, '/api/admin/env/guard', 'PUT', { clearCleanipKey: true })).data.guard.hasCleanipKey, false);
  assert.ok((await call(owner, '/api/audit?action=settings.guard')).data.entries.length >= 2);
});

test('个人使用模式：关闭成员/邀请，站点接口带模式，可切回团队', async () => {
  assert.equal((await fetch(base + '/api/site').then(r => r.json())).mode, 'team');
  assert.equal((await call(owner, '/api/admin/site', 'PUT', { name: '我的', notice: '', mode: 'personal' })).data.mode, 'personal');
  assert.equal((await fetch(base + '/api/site').then(r => r.json())).mode, 'personal');
  assert.equal((await call(owner, '/api/admin/members', 'POST', { email: 'n@example.com', password: 'member-password-12345' })).status, 403);
  assert.equal((await call(owner, '/api/admin/invites', 'POST', {})).status, 403);
  assert.equal((await call(owner, '/api/auth/session')).data.mode, 'personal');
  await call(owner, '/api/admin/site', 'PUT', { name: '我的', notice: '', mode: 'team' });
  assert.equal((await call(owner, '/api/admin/members', 'POST', { email: 'n@example.com', password: 'member-password-12345' })).status < 300, true);
});

test('历史树接口：只返回自己的对话', async () => {
  const tree = (await call(owner, '/api/history/tree')).data;
  assert.ok(tree.conversations.length >= 1); assert.ok(tree.conversations[0].title);
  const mine = await login({ email: 'm@example.com', password: 'member-password-12345' });
  const other = (await call(mine, '/api/history/tree')).data;
  assert.ok(other.conversations.every(c => !tree.conversations.some(o => o.id === c.id)));
});

test('仪表盘：按天/类别/模型/来源/账号汇总，成员只看自己的', async () => {
  const { dashboardData } = await import('../audit.mjs');
  const now = Date.UTC(2026, 5, 15, 12, 0, 0);
  const db = { users: { u1: { email: 'a@x.com' }, u2: { email: 'b@x.com' } }, stats: {}, audit: [], usage: [] };
  addAudit(db, { userId: 'u1', action: 'call.web' }, now); addAudit(db, { userId: 'u1', action: 'file.delete', ok: false }, now); addAudit(db, { userId: 'u2', action: 'expiry.delete' }, now - 86400000);
  db.usage.push({ at: now, userId: 'u1', model: 'm1', source: 'web', totalTokens: 100 }, { at: now, userId: 'u1', model: 'm2', source: 'api', inputTokens: 3, outputTokens: 4 }, { at: now - 86400000, userId: 'u2', model: 'm1', source: 'web', totalTokens: 50 }, { at: now - 200 * 86400000, userId: 'u2', model: 'old', source: 'web', totalTokens: 999 });
  const all = dashboardData(db, { days: 7, now });
  assert.equal(all.series.length, 7); assert.equal(all.totals.calls, 3); assert.equal(all.totals.tokens, 157); assert.equal(all.totals.deletes, 2); assert.equal(all.totals.failures, 1);
  assert.equal(all.byModel[0].model, 'm1'); assert.ok(!all.byModel.some(m => m.model === 'old'), '区间外的不统计');
  assert.deepEqual(all.bySource.map(s => s.source).sort(), ['api', 'web']);
  assert.equal(all.hours.reduce((a, b) => a + b, 0), 3);
  assert.equal(all.users.length, 2);
  const mine = dashboardData(db, { days: 7, userId: 'u2', now });
  assert.equal(mine.totals.calls, 1); assert.ok(mine.users.every(u => u.email === 'b@x.com'));
  assert.equal(dashboardData(db, { days: 7, userId: 'none', now }).totals.operations, 0);
});

test('仪表盘接口：成员只看自己，主账号可按邮箱筛选', async () => {
  const mine = await login({ email: 'm@example.com', password: 'member-password-12345' });
  const own = (await call(mine, '/api/dashboard?days=30')).data;
  assert.equal(own.isAdmin, false); assert.ok(own.series.length === 30);
  assert.ok(own.users.every(u => u.email === 'm@example.com'));
  const everyone = (await call(owner, '/api/dashboard?days=7')).data;
  assert.equal(everyone.isAdmin, true); assert.ok(everyone.users.length >= 2); assert.ok(everyone.totals.operations > 0);
  const filtered = (await call(owner, '/api/dashboard?days=7&email=m@example.com')).data;
  assert.ok(filtered.users.every(u => u.email === 'm@example.com'));
  assert.equal((await call(owner, '/api/dashboard?email=nobody@example.com')).data.totals.operations, 0);
  for (const f of ['charts.js', 'theme.js', 'theme.css']) assert.equal((await fetch(base + '/' + f)).status, 200);
});
