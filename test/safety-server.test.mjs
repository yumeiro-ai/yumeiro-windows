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
const MEMBER = { email: 'member@example.com', password: 'member-password-12345' };
const MEMBER2 = { email: 'member2@example.com', password: 'member-password-67890' };
const ID = '11010519491231002X'; // 合法校验位的测试号码，不是真实的人

test('服务器：敏感内容拦截、机密工作区、模型熔断、单人限速、费用上限', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'cindy-safety-'));
  const keyFile = path.join(dir, 'k'); await writeFile(keyFile, randomBytes(32).toString('base64'));
  const upstreamCalls = []; let upstreamMode = 'ok';
  const upstream = http.createServer((req, res) => {
    const chunks = []; req.on('data', c => chunks.push(c)); req.on('end', () => {
      upstreamCalls.push(Buffer.concat(chunks).toString('utf8'));
      if (upstreamMode === 'fail') { res.writeHead(500, { 'Content-Type': 'application/json' }); return res.end('{"error":"boom"}'); }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: '好的，收到。' } }], usage: { prompt_tokens: 1000000, completion_tokens: 0, total_tokens: 1000000 } }));
    });
  });
  await new Promise(r => upstream.listen(0, '127.0.0.1', r));
  const up = 'http://127.0.0.1:' + upstream.address().port;
  const port = 20000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, ['server.mjs'], { cwd: root, env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: await mkdtemp(path.join(dir, 'd-')), COOKIE_SECURE: 'false', STORE_ENCRYPTION_KEY_FILE: keyFile, ADMIN_EMAIL: ADMIN.email, ADMIN_PASSWORD: ADMIN.password }, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => { child.on('exit', c => reject(new Error('exit ' + c))); child.stdout.on('data', c => { if (String(c).includes('listening')) resolve(); }); });
  const base = 'http://127.0.0.1:' + port;
  const login = async acc => { const r = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify(acc) }); const d = await r.json(); return { cookie: r.headers.get('set-cookie').split(';')[0], csrf: d.csrfToken }; };
  const call = async (auth, p, method = 'GET', body) => { const r = await fetch(base + p, { method, headers: { Origin: base, Cookie: auth.cookie, 'X-CSRF-Token': auth.csrf, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, data: await r.json().catch(() => ({})) }; };
  try {
    const owner = await login(ADMIN);
    assert.equal((await call(owner, '/api/admin/members', 'POST', { email: MEMBER.email, password: MEMBER.password })).status, 201);
    const member = await login(MEMBER);
    assert.equal((await call(owner, '/api/admin/members', 'POST', { email: MEMBER2.email, password: MEMBER2.password })).status, 201);
    const member2 = await login(MEMBER2);
    const created = await call(owner, '/api/admin/providers', 'POST', { name: '测试模型', template: 'custom', baseUrl: up + '/v1', apiKey: 'sk-test-upstream-key-1234567890', models: ['m1'], membersAllowed: true });
    assert.equal(created.status, 201, JSON.stringify(created.data));
    const slug = created.data.provider.slug, ref = slug + '/m1';
    const newChat = async (auth, extra = {}) => (await call(auth, '/api/conversations', 'POST', { model: ref, ...extra })).data.conversation.id;
    const say = (auth, id, message) => call(auth, '/api/chat', 'POST', { conversation_id: id, message });
    const security = async () => (await call(owner, '/api/admin/security')).data;
    const setSecurity = body => call(owner, '/api/admin/security', 'PUT', body);

    // ── 默认没开：身份证号照常放行，没有事件 ──
    let chat = await newChat(member);
    assert.equal((await say(member, chat, '我的号码是 ' + ID)).status, 200);
    assert.equal((await security()).events.length, 0);
    assert.equal((await call(member, '/api/admin/security')).status, 403, '成员不能看安全设置');
    assert.equal((await call(member, '/api/admin/security', 'PUT', { dlp: { enabled: false } })).status, 403);

    // ── 开启拦截：命中不放行，上游没被调用，消息不留在对话里，事件里没有原文 ──
    assert.equal((await setSecurity({ dlp: { enabled: true, mode: 'block', keywords: ['项目极光'] } })).status, 200);
    chat = await newChat(member); const before = upstreamCalls.length;
    let r = await say(member, chat, '帮我核对：' + ID);
    assert.equal(r.status, 422); assert.equal(r.data.blocked, true); assert.match(r.data.error, /身份证号/); assert.ok(!r.data.error.includes(ID));
    r = await say(member, chat, '“项目极光”的方案怎么写');
    assert.equal(r.status, 422); assert.match(r.data.error, /项目极光/);
    assert.equal(upstreamCalls.length, before, '被拦截的内容不能发给上游模型');
    const stored = (await call(member, '/api/conversations/' + chat)).data;
    assert.ok(!JSON.stringify(stored).includes(ID) && !JSON.stringify(stored).includes('项目极光'), '被拦截的消息不能留在对话历史里');
    r = await say(member, chat, '你好，今天天气怎么样');
    assert.equal(r.status, 200, JSON.stringify(r.data));
    const events = (await security()).events;
    assert.equal(events.filter(e => e.kind === 'dlp' && e.blocked).length, 2);
    assert.ok(!JSON.stringify(events).includes(ID), '事件里不能有原文');
    assert.equal(events[0].email, MEMBER.email);

    // ── 只警告：放行，但留事件 ──
    await setSecurity({ dlp: { enabled: true, mode: 'warn', keywords: [] } });
    r = await say(member, await newChat(member), '号码 ' + ID);
    assert.equal(r.status, 200); assert.equal((await security()).events[0].blocked, false);
    await setSecurity({ dlp: { enabled: true, mode: 'block', keywords: [] } });

    // ── 配置校验：有风险的正则被拒绝 ──
    assert.equal((await setSecurity({ dlp: { enabled: true, regexes: [{ name: 'x', pattern: '(a+)+$' }] } })).status, 400);

    // ── 机密工作区：只有管理员能打标签；标了之后默认不能发给任何模型，加入允许名单后才放行 ──
    const ws = (await call(member, '/api/workspaces', 'POST', { name: '财务资料', visibility: 'private' })).data.workspace;
    assert.ok(ws?.id, '创建工作区');
    assert.equal((await call(member, '/api/workspaces/' + ws.id, 'PATCH', { label: 'confidential' })).status, 403, '成员不能给自己的工作区打机密标签，也不能摘掉');
    chat = await newChat(member, { workspace_id: ws.id });
    assert.equal((await say(member, chat, '总结一下')).status, 200, '还没标机密');
    assert.equal((await call(owner, '/api/workspaces/' + ws.id, 'PATCH', { label: 'confidential' })).status, 200, JSON.stringify((await call(owner, '/api/workspaces/' + ws.id, 'PATCH', { label: 'confidential' })).data));
    r = await say(member, chat, '总结一下');
    assert.equal(r.status, 422); assert.match(r.data.error, /机密/);
    assert.equal((await security()).labeled.length, 1);
    await setSecurity({ dlp: { enabled: true, mode: 'block', confidentialAllow: [slug] } });
    assert.equal((await say(member, chat, '总结一下')).status, 200, '加入允许名单后放行');
    await setSecurity({ dlp: { enabled: true, mode: 'block' } });

    // ── 模型熔断：连续失败自动断开，断开期间不再请求上游；管理员恢复后继续 ──
    await setSecurity({ breaker: { failureThreshold: 2, openSeconds: 30, userRatePerMinute: 0 } });
    upstreamMode = 'fail'; chat = await newChat(member);
    for (let i = 0; i < 2; i++) assert.equal((await say(member, chat, '第 ' + i + ' 次')).status, 502);
    const callsAtOpen = upstreamCalls.length;
    r = await say(member, chat, '再试一次');
    assert.equal(r.status, 503); assert.match(r.data.error, /熔断/); assert.equal(upstreamCalls.length, callsAtOpen, '熔断期间不再请求上游');
    let state = (await security()).states.models; assert.equal(state.length, 1); assert.equal(state[0].state, 'open');
    assert.ok((await security()).events.some(e => e.kind === 'breaker'));
    upstreamMode = 'ok';
    assert.equal((await call(owner, '/api/admin/security/breaker', 'POST', { action: 'reset', key: state[0].key })).status, 200);
    assert.equal((await say(member, chat, '恢复了吗')).status, 200);
    // 手动熔断
    assert.equal((await call(owner, '/api/admin/security/breaker', 'POST', { action: 'trip', key: state[0].key })).status, 200);
    r = await say(member, chat, '被手动暂停'); assert.equal(r.status, 503); assert.match(r.data.error, /管理员/);
    await call(owner, '/api/admin/security/breaker', 'POST', { action: 'reset', key: state[0].key });
    assert.equal((await call(owner, '/api/admin/security/breaker', 'POST', { action: 'nope' })).status, 400);

    // ── 单人限速：只断开这一个人 ──
    await setSecurity({ breaker: { failureThreshold: 50, userRatePerMinute: 3, userOpenSeconds: 30 } });
    chat = await newChat(member2);
    for (let i = 0; i < 3; i++) assert.equal((await say(member2, chat, '限速测试 ' + i)).status, 200);
    r = await say(member2, chat, '第 4 次'); assert.equal(r.status, 429); assert.match(r.data.error, /太频繁/);
    assert.equal((await say(owner, await newChat(owner), '管理员不受影响')).status, 200);
    assert.ok((await security()).events.some(e => e.kind === 'abuse'));
    const limited = (await security()).states.users; assert.equal(limited.length, 1); assert.equal(limited[0].email, MEMBER2.email);
    await call(owner, '/api/admin/security/breaker', 'POST', { action: 'reset-user', userId: limited[0].userId });
    assert.equal((await say(member2, chat, '解除后')).status, 200);

    // ── 费用上限：价格按每百万 Token 算，一次调用 100 万输入 Token = 单价；达到上限就暂停 ──
    await call(owner, '/api/admin/pricing', 'PUT', { currency: '¥', models: { [ref]: { input: 10, output: 0 } } });
    await setSecurity({ breaker: { failureThreshold: 50, userRatePerMinute: 0, dailyCostLimit: 15 } });
    chat = await newChat(owner);
    assert.equal((await say(owner, chat, '第一次计费')).status, 200);
    await new Promise(r2 => setTimeout(r2, 10500)); // 费用合计有 10 秒缓存
    r = await say(owner, chat, '第二次计费'); assert.equal(r.status, 200);
    await new Promise(r2 => setTimeout(r2, 10500));
    const atLimit = upstreamCalls.length; r = await say(owner, chat, '第三次计费');
    assert.equal(r.status, 503); assert.match(r.data.error, /费用已达上限/); assert.equal(upstreamCalls.length, atLimit);
    assert.ok((await security()).events.some(e => e.kind === 'cost'));
    assert.ok((await security()).costs.day >= 15);
  } finally {
    child.removeAllListeners('exit'); child.kill(); upstream.close();
    await new Promise(r => setTimeout(r, 200)); await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});
