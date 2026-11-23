import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import zlib from 'node:zlib';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ADMIN = { email: 'owner@example.com', password: 'a-very-long-test-password' };
let dir, mock, authMock, gatewayMock, gatewayHits = [], app, base, cookie = '', csrf = '';

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

test.before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'cindy-test-'));
  const keyFile = path.join(dir, 'store.key'), modelKeyFile = path.join(dir, 'model.key');
  await writeFile(keyFile, randomBytes(32).toString('base64'));
  await writeFile(modelKeyFile, 'test-model-key');
  mock = http.createServer((req, res) => {
    let raw = '';
    req.on('data', c => raw += c);
    req.on('end', () => {
      const body = JSON.parse(raw);
      if (body.stream) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        for (const part of ['你', '好', '！']) res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: part } }] }) + '\n\n');
        res.write('data: ' + JSON.stringify({ choices: [], usage: { prompt_tokens: 3, completion_tokens: 3 } }) + '\n\n');
        res.end('data: [DONE]\n\n');
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: 'pong' } }], usage: { total_tokens: 5 } }));
      }
    });
  });
  const mockPort = await listen(mock);
  // 模拟 Cindy 官方认证服务（手机号 + 验证码 123456）
  authMock = http.createServer((req, res) => {
    let raw = '';
    req.on('data', c => raw += c);
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : {};
      const send = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
      if (req.url === '/api/model-access/credentials') return req.headers.authorization?.startsWith('Bearer h.') ? send(200, { endpoint: `http://127.0.0.1:${globalThis.__gatewayPort}/v1`, apiKey: 'gw-key-123' }) : send(401, { error: { code: 'UNAUTHORIZED', message: 'x' } });
      if (req.url === '/api/model-access/balance') return send(200, { currency: 'CNY', amount: '12.50', apiKey: 'must-be-scrubbed' });
      if (req.url === '/api/model-access/credit-usage') return send(200, { available: '88.00', plan: { remaining: '50.00', used: '10.00', total: '60.00' }, purchased: { remaining: '38.00', used: null, total: null }, promotional: { remaining: '0', used: '0', total: '0' } });
      if (req.url === '/api/billing/subscription') return send(200, { subscription: { subscriptionId: 's1', status: 'ACTIVE', currentPeriodEndAt: '2026-12-01T00:00:00Z', cancelAtPeriodEnd: false, effectivePlan: { product: { code: 'pro', level: 2 }, offer: { code: 'pro-month', interval: 'MONTH' }, terms: { amount: '29', currency: 'CNY', creditAmount: '60' } } } });
      if (req.url === '/api/model-access/models') return send(200, { schemaVersion: 2, models: [{ id: 'cindy-chat-1', mode: 'chat', name: 'Cindy Chat' }, { id: 'img-1', mode: 'image' }, { id: 'cindy-chat-2', modalities: { input: ['text'], output: ['text'] } }] });
      if (req.url === '/api/auth/token') { const payload = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url'); return body.grantType === 'refresh_token' && body.refreshToken ? send(200, { accessToken: 'h.' + payload + '.renewed', refreshToken: 'r-rotated' }) : send(400, { error: { code: 'BAD', message: 'x' } }); }
      if (req.url === '/api/auth/providers') return send(200, { region: 'cn', attribution: 'phone', email: false, phone: true, social: ['wechat'] });
      if (req.url.startsWith('/api/auth/social/wechat/authorize')) { res.writeHead(302, { Location: 'http://wechat.invalid/' }); return res.end(); }
      if (req.url === '/api/auth/phone/request-code') return send(200, {});
      if (req.url === '/api/auth/phone/verify-code') {
        if (body.code !== '123456') return send(400, { error: { code: 'INVALID_CODE', message: '验证码错误' } });
        const payload = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url');
        return send(200, { status: 'ok', membership: { id: 'm-' + body.phone, passportId: 'p-' + body.phone, displayName: '用户' + body.phone, email: null, kind: 'personal', role: 'owner' }, accessToken: 'h.' + payload + '.s', refreshToken: 'r-' + body.phone });
      }
      send(404, { error: { code: 'NOT_FOUND', message: 'x' } });
    });
  });
  // 模拟 Cindy 的 model-access 与模型网关
  gatewayMock = http.createServer((req, res) => {
    let raw = ''; req.on('data', c => raw += c);
    req.on('end', () => {
      gatewayHits.push({ url: req.url, auth: req.headers.authorization, body: raw ? JSON.parse(raw) : null });
      const send = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
      if (req.headers.authorization !== 'Bearer gw-key-123') return send(401, { error: { message: 'bad key' } });
      if (req.url === '/v1/models') return send(200, { data: [{ id: 'cindy-chat-1' }] });
      if (req.url === '/v1/chat/completions') return send(200, { choices: [{ message: { content: 'from-cindy-gateway' } }], usage: { total_tokens: 4 } });
      send(404, { error: { message: 'no' } });
    });
  });
  const gatewayPort = await listen(gatewayMock);
  const authPort = await listen(authMock);
  globalThis.__gatewayPort = gatewayPort;
  const port = 20000 + Math.floor(Math.random() * 20000);
  base = 'http://127.0.0.1:' + port;
  app = spawn(process.execPath, ['server.mjs'], {
    cwd: root,
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dir, COOKIE_SECURE: 'false', CINDY_SHARING_MIN_SECONDS: '1', STORE_ENCRYPTION_KEY_FILE: keyFile, MODEL_API_KEY_FILE: modelKeyFile, CINDY_AUTH_URL_CN: `http://127.0.0.1:${authPort}`, CINDY_MODEL_ACCESS_URL_CN: `http://127.0.0.1:${authPort}`, MODEL_BASE_URL: `http://127.0.0.1:${mockPort}/v1`, MODEL_NAME: 'test-model', ADMIN_EMAIL: ADMIN.email, ADMIN_PASSWORD: ADMIN.password },
    stdio: ['ignore', 'pipe', 'inherit']
  });
  await new Promise((resolve, reject) => {
    app.on('exit', code => reject(new Error('server exited early: ' + code)));
    app.stdout.on('data', chunk => { if (String(chunk).includes('listening')) resolve(); });
  });
});

test.after(async () => {
  app?.removeAllListeners('exit');
  app?.kill();
  mock?.close();
  authMock?.close();
  gatewayMock?.close();
  await new Promise(r => setTimeout(r, 200));
  await rm(dir, { recursive: true, force: true }).catch(() => {});
});

async function call(pathname, { method = 'GET', body, raw } = {}) {
  const headers = { Origin: base, ...(cookie ? { Cookie: cookie } : {}), ...(csrf ? { 'X-CSRF-Token': csrf } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) };
  const response = await fetch(base + pathname, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const set = response.headers.get('set-cookie');
  if (set) {
    // 简易 cookie 罐：按名字合并，值为空（被清除）则删除；会话 cookie 与 cindy_challenge 并存
    const [pair] = set.split(';'), name = pair.split('=')[0], value = pair.slice(name.length + 1);
    const jar = cookie ? cookie.split('; ').filter(item => !item.startsWith(name + '=')) : [];
    if (value) jar.push(pair);
    cookie = jar.join('; ');
  }
  return raw ? response : { status: response.status, data: await response.json().catch(() => ({})) };
}

test('serves index and auth script, rejects unknown static paths', async () => {
  assert.equal((await call('/', { raw: true })).status, 200);
  const script = await call('/auth-extra.js', { raw: true });
  assert.equal(script.status, 200);
  assert.match(script.headers.get('content-type'), /javascript/);
  assert.equal((await call('/server.mjs', { raw: true })).status, 404);
  assert.equal((await call('/..%2fserver.mjs', { raw: true })).status, 404);
});

test('requires login for conversations', async () => {
  assert.equal((await call('/api/conversations')).status, 401);
});

test('admin login, chat (plain + stream), rename, delete', async () => {
  const login = await call('/api/auth/login', { method: 'POST', body: ADMIN });
  assert.equal(login.status, 200);
  csrf = login.data.csrfToken;

  const created = await call('/api/conversations', { method: 'POST', body: {} });
  const id = created.data.conversation.id;

  const plain = await call('/api/chat', { method: 'POST', body: { message: 'ping', conversation_id: id } });
  assert.equal(plain.data.reply, 'pong');

  const response = await call('/api/chat/stream', { method: 'POST', body: { message: '你好', conversation_id: id }, raw: true });
  const text = await response.text();
  assert.match(text, /event: delta/);
  assert.match(text, /event: done/);
  const deltas = [...text.matchAll(/event: delta\ndata: (.*)\n/g)].map(m => JSON.parse(m[1]).text).join('');
  assert.equal(deltas, '你好！');

  const detail = await call('/api/conversations/' + id);
  assert.deepEqual(detail.data.messages.map(m => m.content), ['ping', 'pong', '你好', '你好！']);

  const renamed = await call('/api/conversations/' + id, { method: 'PATCH', body: { title: '  新标题  ' } });
  assert.equal(renamed.data.conversation.title, '新标题');
  assert.equal((await call('/api/conversations/' + id, { method: 'PATCH', body: { title: '   ' } })).status, 400);

  assert.equal((await call('/api/conversations/' + id, { method: 'DELETE' })).status, 200);
  assert.equal((await call('/api/conversations/' + id)).status, 404);
});

test('rejects writes without CSRF token', async () => {
  const saved = csrf;
  csrf = '';
  assert.equal((await call('/api/conversations', { method: 'POST', body: {} })).status, 403);
  csrf = saved;
});

test('team: owner creates member, member is limited, owner manages', async () => {
  const owner = { cookie, csrf };
  const member = { email: 'member@example.com', password: 'member-password-123' };
  const created = await call('/api/admin/members', { method: 'POST', body: { ...member, displayName: '小王', dailyLimit: 2 } });
  assert.equal(created.status, 201);
  assert.equal((await call('/api/admin/members', { method: 'POST', body: { ...member } })).status, 409);
  assert.equal((await call('/api/admin/members', { method: 'POST', body: { email: 'x@example.com', password: 'short' } })).status, 400);

  cookie = ''; csrf = '';
  const login = await call('/api/auth/login', { method: 'POST', body: member });
  assert.equal(login.status, 200);
  assert.equal(login.data.role, 'member');
  csrf = login.data.csrfToken;
  const memberAuth = { cookie, csrf };
  assert.equal((await call('/api/admin/members')).status, 403);

  // 每日上限 2 次
  const conv = (await call('/api/conversations', { method: 'POST', body: {} })).data.conversation.id;
  assert.equal((await call('/api/chat', { method: 'POST', body: { message: 'a', conversation_id: conv } })).status, 200);
  assert.equal((await call('/api/chat', { method: 'POST', body: { message: 'b', conversation_id: conv } })).status, 200);
  assert.equal((await call('/api/chat', { method: 'POST', body: { message: 'c', conversation_id: conv } })).status, 429);

  // 对话互相隔离
  ({ cookie, csrf } = owner);
  assert.equal((await call('/api/conversations/' + conv)).status, 404);

  const id = created.data.member.id;
  assert.equal((await call('/api/admin/members/' + id, { method: 'PATCH', body: { disabled: true } })).status, 200);
  ({ cookie, csrf } = memberAuth);
  assert.equal((await call('/api/conversations')).status, 401);
  cookie = ''; csrf = '';
  assert.equal((await call('/api/auth/login', { method: 'POST', body: member })).status, 403);

  ({ cookie, csrf } = owner);
  assert.equal((await call('/api/admin/members/' + id, { method: 'DELETE' })).status, 200);
});

test('agents and OpenAI-compatible /v1 API with personal tokens', async () => {
  const agent = await call('/api/agents', { method: 'POST', body: { name: '翻译官', systemPrompt: '只做翻译', shared: true } });
  assert.equal(agent.status, 201);
  assert.equal((await call('/api/agents', { method: 'POST', body: { name: 'bad', model: 'not-allowed' } })).status, 400);

  const conv = await call('/api/conversations', { method: 'POST', body: { agent_id: agent.data.agent.id } });
  assert.equal(conv.data.conversation.agentId, agent.data.agent.id);
  assert.equal((await call('/api/conversations', { method: 'POST', body: { agent_id: 'nope' } })).status, 400);

  const tokenRes = await call('/api/tokens', { method: 'POST', body: { name: '本地脚本' } });
  assert.equal(tokenRes.status, 201);
  const token = tokenRes.data.token;
  assert.match(token, /^ymr_/);
  assert.equal(JSON.stringify((await call('/api/tokens')).data).includes(token), false);

  const api = (p, init = {}) => fetch(base + p, { ...init, headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' } });
  assert.equal((await fetch(base + '/v1/models')).status, 401);
  const models = await (await api('/v1/models')).json();
  assert.ok(models.data.some(m => m.id === 'test-model'));
  assert.ok(models.data.some(m => m.id === 'agent:' + agent.data.agent.id));

  const body = { model: 'agent:' + agent.data.agent.id, messages: [{ role: 'user', content: 'hi' }] };
  const done = await (await api('/v1/chat/completions', { method: 'POST', body: JSON.stringify(body) })).json();
  assert.equal(done.choices[0].message.content, 'pong');

  const streamed = await (await api('/v1/chat/completions', { method: 'POST', body: JSON.stringify({ ...body, stream: true }) })).text();
  assert.match(streamed, /data: \[DONE\]/);
  const text = [...streamed.matchAll(/data: (\{.*\})\n/g)].map(m => JSON.parse(m[1]).choices?.[0]?.delta?.content || '').join('');
  assert.equal(text, '你好！');

  assert.equal((await api('/v1/chat/completions', { method: 'POST', body: JSON.stringify({ model: 'other', messages: [{ role: 'user', content: 'x' }] }) })).status, 404);
  assert.equal((await api('/v1/chat/completions', { method: 'POST', body: JSON.stringify({ messages: [] }) })).status, 400);

  assert.equal((await call('/api/tokens/' + tokenRes.data.record.id, { method: 'DELETE' })).status, 200);
  assert.equal((await api('/v1/models')).status, 401);
});

test('quota alerts appear at 80% and exceeded at 100%', async () => {
  const owner = { cookie, csrf };
  const member = { email: 'alert@example.com', password: 'alert-password-123' };
  const created = await call('/api/admin/members', { method: 'POST', body: { ...member, monthlyCallLimit: 5 } });
  cookie = ''; csrf = '';
  csrf = (await call('/api/auth/login', { method: 'POST', body: member })).data.csrfToken;
  const conv = (await call('/api/conversations', { method: 'POST', body: {} })).data.conversation.id;
  const send = () => call('/api/chat', { method: 'POST', body: { message: 'hi', conversation_id: conv } });
  const token = (await call('/api/tokens', { method: 'POST', body: { name: 't' } })).data.token;

  for (let i = 0; i < 3; i++) assert.deepEqual((await send()).data.alerts, []);
  assert.deepEqual((await call('/api/usage/me')).data.alerts, []);
  const fourth = await send();
  assert.equal(fourth.data.alerts.length, 1);
  assert.equal(fourth.data.alerts[0].key, 'monthlyCalls');
  assert.equal(fourth.data.alerts[0].percent, 80);
  assert.equal(fourth.data.alerts[0].level, 'warning');
  assert.equal((await call('/api/usage/me')).data.alerts[0].percent, 80);

  const api = await fetch(base + '/v1/chat/completions', { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify({ messages: [{ role: 'user', content: 'x' }] }) });
  assert.equal(api.status, 200);
  assert.equal(api.headers.get('x-yumeiro-quota-warning'), 'monthlyCalls=100%');
  assert.equal((await call('/api/usage/me')).data.alerts[0].level, 'exceeded');

  ({ cookie, csrf } = owner);
  assert.deepEqual((await call('/api/usage/me')).data.alerts, []);
  assert.equal((await call('/api/admin/members/' + created.data.member.id, { method: 'DELETE' })).status, 200);
});

test('AI providers: templates, masked keys, routing, member access, defaults, deletion', async () => {
  const seen = [];
  const second = http.createServer((req, res) => {
    let raw = '';
    req.on('data', c => raw += c);
    req.on('end', () => {
      seen.push({ url: req.url, auth: req.headers.authorization, body: raw ? JSON.parse(raw) : null });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (req.url.endsWith('/models')) return res.end(JSON.stringify({ data: [{ id: 'gpt-x' }, { id: 'gpt-y' }] }));
      res.end(JSON.stringify({ choices: [{ message: { content: 'from-second' } }], usage: { total_tokens: 7 } }));
    });
  });
  const port = await new Promise(resolve => second.listen(0, '127.0.0.1', () => resolve(second.address().port)));
  const owner = { cookie, csrf };
  try {
    const list = await call('/api/admin/providers');
    assert.ok(list.data.templates.some(t => t.id === 'openai') && list.data.templates.some(t => t.id === 'deepseek'));
    assert.deepEqual(list.data.builtin.models, ['test-model']);

    // 校验：公网 http 被拒、OpenAI 模板缺少密钥被拒、没有模型被拒
    const payload = { name: '第二服务商', template: 'custom', baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'sk-secret-k2-value', models: ['gpt-x'] };
    assert.equal((await call('/api/admin/providers', { method: 'POST', body: { ...payload, baseUrl: 'http://example.com/v1' } })).status, 400);
    assert.equal((await call('/api/admin/providers', { method: 'POST', body: { ...payload, baseUrl: 'http://169.254.169.254/v1' } })).status, 400);
    assert.equal((await call('/api/admin/providers', { method: 'POST', body: { name: 'o', template: 'openai', baseUrl: 'https://api.openai.com/v1', models: ['m'] } })).status, 400);
    assert.equal((await call('/api/admin/providers', { method: 'POST', body: { ...payload, models: [] } })).status, 400);

    const probe = await call('/api/admin/providers/probe', { method: 'POST', body: { baseUrl: payload.baseUrl, apiKey: payload.apiKey } });
    assert.deepEqual(probe.data.models, ['gpt-x', 'gpt-y']);
    assert.equal(seen.at(-1).auth, 'Bearer sk-secret-k2-value');

    const created = await call('/api/admin/providers', { method: 'POST', body: { ...payload, slug: 'second', membersAllowed: false } });
    assert.equal(created.status, 201);
    const id = created.data.provider.id;
    assert.equal(JSON.stringify(created.data).includes('sk-secret-k2-value'), false, '密钥不能回传');
    assert.match(created.data.provider.keyMask, /^sk-•+alue$/);
    assert.equal((await call('/api/admin/providers', { method: 'POST', body: { ...payload, slug: 'second' } })).status, 409);

    // API 路由：second/gpt-x 走第二服务商，带它自己的密钥和去前缀的模型名
    const token = (await call('/api/tokens', { method: 'POST', body: { name: 'prov' } })).data.token;
    const api = body => fetch(base + '/v1/chat/completions', { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const models = await (await fetch(base + '/v1/models', { headers: { Authorization: 'Bearer ' + token } })).json();
    assert.ok(models.data.some(m => m.id === 'second/gpt-x') && models.data.some(m => m.id === 'test-model'));
    const reply = await (await api({ model: 'second/gpt-x', messages: [{ role: 'user', content: 'hi' }] })).json();
    assert.equal(reply.choices[0].message.content, 'from-second');
    const sent = seen.at(-1);
    assert.equal(sent.auth, 'Bearer sk-secret-k2-value');
    assert.equal(sent.body.model, 'gpt-x');
    assert.equal((await api({ model: 'second/unknown', messages: [{ role: 'user', content: 'hi' }] })).status, 404);

    // 留空密钥的更新保持原密钥；成员默认看不到“成员不可用”的服务商
    assert.equal((await call('/api/admin/providers/' + id, { method: 'PATCH', body: { name: '改名', apiKey: '', models: ['gpt-x', 'gpt-y'] } })).status, 200);
    assert.equal((await (await api({ model: 'second/gpt-y', messages: [{ role: 'user', content: 'hi' }] })).json()).choices[0].message.content, 'from-second');
    assert.equal(seen.at(-1).auth, 'Bearer sk-secret-k2-value');

    const member = { email: 'prov@example.com', password: 'provider-pass-123' };
    const m = await call('/api/admin/members', { method: 'POST', body: member });
    cookie = ''; csrf = '';
    csrf = (await call('/api/auth/login', { method: 'POST', body: member })).data.csrfToken;
    assert.deepEqual((await call('/api/models')).data.models.map(x => x.ref), ['test-model']);
    assert.equal((await call('/api/conversations', { method: 'POST', body: { model: 'second/gpt-x' } })).status, 400);
    assert.equal((await call('/api/admin/providers')).status, 403);
    ({ cookie, csrf } = owner);
    assert.equal((await call('/api/admin/providers/' + id, { method: 'PATCH', body: { membersAllowed: true } })).status, 200);

    // 对话级选择模型 + 默认模型
    cookie = ''; csrf = '';
    csrf = (await call('/api/auth/login', { method: 'POST', body: member })).data.csrfToken;
    const conv = (await call('/api/conversations', { method: 'POST', body: { model: 'second/gpt-x' } })).data.conversation;
    assert.equal(conv.model, 'second/gpt-x');
    assert.equal((await call('/api/chat', { method: 'POST', body: { message: 'hi', conversation_id: conv.id } })).data.reply, 'from-second');
    ({ cookie, csrf } = owner);
    assert.equal((await call('/api/admin/settings', { method: 'PUT', body: { defaultModel: 'second/gpt-y' } })).status, 200);
    assert.equal((await call('/api/admin/settings', { method: 'PUT', body: { defaultModel: 'nope/x' } })).status, 400);
    const viaDefault = await (await api({ messages: [{ role: 'user', content: 'hi' }] })).json();
    assert.equal(viaDefault.choices[0].message.content, 'from-second');
    assert.equal(seen.at(-1).body.model, 'gpt-y');

    // 停用后调用失败；删除后默认模型回到内置
    assert.equal((await call('/api/admin/providers/' + id, { method: 'PATCH', body: { enabled: false } })).status, 200);
    assert.equal((await api({ model: 'second/gpt-x', messages: [{ role: 'user', content: 'hi' }] })).status, 404);
    assert.equal((await call('/api/admin/providers/' + id, { method: 'DELETE' })).status, 200);
    assert.equal((await call('/api/admin/providers')).data.defaultModel, '');
    assert.equal((await (await api({ messages: [{ role: 'user', content: 'hi' }] })).json()).choices[0].message.content, 'pong');
    await call('/api/admin/members/' + m.data.member.id, { method: 'DELETE' });
  } finally {
    ({ cookie, csrf } = owner);
    second.close();
  }
});

test('首页不含 Cindy 登录控件；/api-login 已移除', async () => {
  const home = await (await call('/', { raw: true })).text();
  assert.doesNotMatch(home, /api-login|cindyRegion|cindy-login-card/);
  assert.match(home, /id="composerPicks"/);
  assert.match(home, /id="loginForm"/);
  assert.equal((await call('/api-login', { raw: true })).status, 404);
});

test('绑定 Cindy 账号：需先登录、可绑多个、不能被两个本站账号共用、可解绑', async () => {
  const owner = { cookie, csrf };
  // 未登录不能使用任何绑定接口
  cookie = ''; csrf = '';
  assert.equal((await call('/api/cindy/providers?region=cn')).status, 401);
  assert.equal((await call('/api/cindy/request-code', { method: 'POST', body: { region: 'cn', identifier: '13800000001' } })).status, 401);
  ({ cookie, csrf } = owner);

  const providers = await call('/api/cindy/providers?region=cn');
  assert.equal(providers.status, 200, JSON.stringify(providers.data));
  assert.deepEqual(providers.data.socialAvailable, ['wechat']);

  const bind = async phone => {
    const sent = await call('/api/cindy/request-code', { method: 'POST', body: { region: 'cn', identifier: phone } });
    assert.equal(sent.status, 200);
    return call('/api/cindy/verify-code', { method: 'POST', body: { challengeId: sent.data.challengeId, code: '123456' } });
  };
  const first = await bind('13800000001');
  assert.equal(first.status, 200, JSON.stringify(first.data));
  assert.equal(first.data.bound, true);
  assert.equal(JSON.stringify(first.data).includes('r-13800000001'), false, '令牌不能回传');
  assert.equal((await bind('13800000002')).data.bound, true);
  const list = (await call('/api/cindy/accounts')).data.accounts;
  assert.equal(list.length, 2);
  assert.ok(list[0].accessExpiresAt > Date.now());


  // 另一个本站账号不能绑同一个 Cindy 账号
  const other = { email: 'bind@example.com', password: 'bind-password-123' };
  const created = await call('/api/admin/members', { method: 'POST', body: other });
  cookie = ''; csrf = '';
  csrf = (await call('/api/auth/login', { method: 'POST', body: other })).data.csrfToken;
  const conflict = await bind('13800000001');
  assert.equal(conflict.status, 409);
  // 别人发起的验证不能被拿来用
  ({ cookie, csrf } = owner);
  const mine = await call('/api/cindy/request-code', { method: 'POST', body: { region: 'cn', identifier: '13800000009' } });
  assert.equal((await call('/api/cindy/verify-code', { method: 'POST', body: { challengeId: mine.data.challengeId, code: '000000' } })).status, 401); // 验证码错误
  const ownerCookie = cookie, ownerCsrf = csrf;
  cookie = ''; csrf = '';
  csrf = (await call('/api/auth/login', { method: 'POST', body: other })).data.csrfToken;
  assert.equal((await call('/api/cindy/verify-code', { method: 'POST', body: { challengeId: mine.data.challengeId, code: '123456' } })).status, 410);
  assert.equal((await bind('13800000008')).data.bound, true);

  // 解绑
  cookie = ownerCookie; csrf = ownerCsrf;
  assert.equal((await call('/api/cindy/accounts/' + list[0].id, { method: 'DELETE' })).status, 200);
  assert.equal((await call('/api/cindy/accounts')).data.accounts.length, 1);
  assert.equal((await call('/api/cindy/accounts/' + list[0].id, { method: 'DELETE' })).status, 404);
  assert.equal((await call('/api/admin/members/' + created.data.member.id, { method: 'DELETE' })).status, 200);
});

test('Cindy 托管模型：同步目录、仅所属用户可用、走网关密钥、解绑后消失', async () => {
  const owner = { cookie, csrf };
  const account = (await call('/api/cindy/accounts')).data.accounts[0];
  assert.ok(account, '前一个测试应留下一个绑定账号');

  const sync = await call('/api/cindy/accounts/' + account.id + '/sync', { method: 'POST', body: {} });
  assert.equal(sync.data.ok, true, JSON.stringify(sync.data));
  assert.equal(sync.data.models, 2, '图像模型要被过滤掉');
  assert.equal(JSON.stringify(sync.data).includes('gw-key-123'), false, '网关密钥不能回传');

  const refs = (await call('/api/models')).data.models.filter(m => m.provider.startsWith('cindy-')).map(m => m.ref);
  assert.equal(refs.length, 2);
  assert.ok(refs[0].startsWith('cindy-' + account.id.slice(0, 8) + '/'));
  const ref = refs.find(r => r.endsWith('/cindy-chat-1'));

  const conv = await call('/api/conversations', { method: 'POST', body: { model: ref } });
  assert.equal(conv.status, 201);
  const reply = await call('/api/chat', { method: 'POST', body: { message: 'hi', conversation_id: conv.data.conversation.id } });
  assert.equal(reply.data.reply, 'from-cindy-gateway');
  const hit = gatewayHits.filter(h => h.url === '/v1/chat/completions').at(-1);
  assert.equal(hit.auth, 'Bearer gw-key-123', '要用网关下发的密钥，而不是 Cindy 访问令牌');
  assert.equal(hit.body.model, 'cindy-chat-1', '模型名要去掉本站前缀');

  const test = await call('/api/cindy/accounts/' + account.id + '/test', { method: 'POST', body: {} });
  assert.equal(test.data.ok, true, JSON.stringify(test.data));
  assert.equal(test.data.steps.length, 4);
  assert.match(test.data.steps[0].name, /令牌续期/);
  assert.equal(test.data.steps[0].ok, true, JSON.stringify(test.data.steps[0]));

  // 余额 / 额度池 / 订阅：三个官方只读接口，字段里疑似密钥的会被剔除
  const billing = await call('/api/cindy/accounts/' + account.id + '/billing');
  assert.equal(billing.status, 200);
  assert.equal(billing.data.creditUsage.data.available, '88.00');
  assert.equal(billing.data.creditUsage.data.plan.remaining, '50.00');
  assert.equal(billing.data.balance.data.amount, '12.50');
  assert.equal(JSON.stringify(billing.data).includes('must-be-scrubbed'), false);
  assert.equal(billing.data.subscription, undefined, '订阅不再查询接口，改为官方链接');
  assert.equal(billing.data.links.subscription, 'https://cindy.com.cn/#pricing');
  assert.equal((await call('/api/cindy/accounts/00000000-0000-4000-8000-000000000000/billing')).status, 404);

  // 另一个本站账号看不到、也不能用
  const other = { email: 'cm@example.com', password: 'cindy-models-pass-123' };
  const created = await call('/api/admin/members', { method: 'POST', body: other });
  cookie = ''; csrf = '';
  csrf = (await call('/api/auth/login', { method: 'POST', body: other })).data.csrfToken;
  assert.equal((await call('/api/models')).data.models.some(m => m.provider.startsWith('cindy-')), false);
  assert.equal((await call('/api/conversations', { method: 'POST', body: { model: ref } })).status, 400);
  const otherAuth = { cookie, csrf };
  assert.equal((await call('/api/cindy/accounts/' + account.id, { method: 'PATCH', body: { shared: true } })).status, 404, '成员不能操作别人的账号');

  // 主账号共享后：成员能看到并使用（用的是该账号的网关密钥，成员自己的额度照常统计）；取消共享后立即消失
  ({ cookie, csrf } = owner);
  assert.equal((await call('/api/cindy/accounts/' + account.id, { method: 'PATCH', body: { shared: 'yes' } })).status, 400);
  // 团队共享默认关闭：必须先开始阅读、等满时间、明确确认后才能打开
  assert.equal((await call('/api/cindy/accounts/' + account.id, { method: 'PATCH', body: { shared: true } })).status, 403, '默认不允许共享');
  assert.equal((await call('/api/cindy/sharing')).data.allowed, false);
  assert.equal((await call('/api/cindy/sharing/accept', { method: 'POST', body: { accepted: true } })).status, 400, '没开始阅读不能确认');
  assert.equal((await call('/api/cindy/sharing/start', { method: 'POST', body: {} })).status, 200);
  assert.equal((await call('/api/cindy/sharing/accept', { method: 'POST', body: { accepted: true } })).status, 400, '阅读时间不足不能确认');
  await new Promise(r => setTimeout(r, 1300));
  assert.equal((await call('/api/cindy/sharing/accept', { method: 'POST', body: { accepted: false } })).status, 400, '必须明确确认');
  assert.equal((await call('/api/cindy/sharing/accept', { method: 'POST', body: { accepted: true } })).data.allowed, true);
  assert.equal((await call('/api/cindy/accounts/' + account.id, { method: 'PATCH', body: { shared: true } })).data.account.shared, true);
  ({ cookie, csrf } = otherAuth);
  const shared = (await call('/api/models')).data.models.filter(m => m.provider.startsWith('cindy-'));
  assert.equal(shared.length, 2);
  assert.equal(shared[0].providerName, 'Cindy · 团队共享', '不向成员暴露账号显示名');
  const sharedConv = (await call('/api/conversations', { method: 'POST', body: { model: ref } })).data.conversation.id;
  gatewayHits.length = 0;
  assert.equal((await call('/api/chat', { method: 'POST', body: { message: 'hi', conversation_id: sharedConv } })).data.reply, 'from-cindy-gateway');
  assert.equal(gatewayHits.at(-1).auth, 'Bearer gw-key-123');
  assert.equal((await call('/api/usage/me')).data.usage.sources.web, 1, '成员的调用计入成员自己的用量');
  ({ cookie, csrf } = owner);
  assert.equal((await call('/api/cindy/accounts/' + account.id, { method: 'PATCH', body: { shared: false } })).data.account.shared, false);
  ({ cookie, csrf } = otherAuth);
  assert.equal((await call('/api/models')).data.models.some(m => m.provider.startsWith('cindy-')), false);
  assert.equal((await call('/api/conversations', { method: 'POST', body: { model: ref } })).status, 400);

  ({ cookie, csrf } = owner);
  assert.equal((await call('/api/admin/members/' + created.data.member.id, { method: 'DELETE' })).status, 200);
  assert.equal((await call('/api/cindy/accounts/' + account.id, { method: 'DELETE' })).status, 200);
  assert.equal((await call('/api/models')).data.models.some(m => m.provider.startsWith('cindy-')), false);
});

test('登录入口：只有一个入口，管理员和成员都从 / 登录；/admin 跳转到 /；站点名称与公告', async () => {
  const owner = { cookie, csrf };
  const adminRedirect = await fetch(base + '/admin', { redirect: 'manual' });
  assert.equal(adminRedirect.status, 302);
  assert.equal(adminRedirect.headers.get('location'), '/');
  assert.match(await (await call('/', { raw: true })).text(), /portal\.js/);
  assert.equal((await call('/portal.js', { raw: true })).status, 200);
  for (const page of ['/settings', '/admin/settings', '/market', '/workspaces']) { const r = await call(page, { raw: true }); assert.equal(r.status, 200); assert.match(await r.text(), /team.js/); }

  const member = { email: 'portal@example.com', password: 'portal-password-123' };
  assert.equal((await call('/api/admin/members', { method: 'POST', body: member })).status, 201);
  cookie = ''; csrf = '';
  // 身份只由账号决定：不管页面传不传 portal（旧版页面会传），成员和管理员都能登录
  assert.equal((await call('/api/auth/login', { method: 'POST', body: { ...member, portal: 'admin' } })).status, 200);
  cookie = ''; csrf = '';
  const adminAtMember = await call('/api/auth/login', { method: 'POST', body: { ...ADMIN, portal: 'member' } });
  assert.equal(adminAtMember.status, 200);
  assert.equal((await call('/api/auth/session')).data.role, 'admin');
  cookie = ''; csrf = '';
  // 密码错误始终是同一个泛化提示，不泄露角色
  assert.equal((await call('/api/auth/login', { method: 'POST', body: { email: member.email, password: 'wrong-password-123' } })).status, 401);
  assert.equal((await call('/api/auth/login', { method: 'POST', body: member })).status, 200);
  const memberAuth = { cookie, csrf: (await call('/api/auth/session')).data.csrfToken };
  assert.equal((await call('/api/auth/session')).data.role, 'member');
  cookie = ''; csrf = '';
  assert.equal((await call('/api/auth/login', { method: 'POST', body: ADMIN })).status, 200);
  cookie = ''; csrf = '';

  // 站点名称与公告：未登录可读，只有管理员能改
  assert.deepEqual((await call('/api/site')).data, { mode: 'team', name: '', notice: '', adminRestricted: false });
  ({ cookie, csrf } = memberAuth);
  assert.equal((await call('/api/admin/site', { method: 'PUT', body: { name: 'x' } })).status, 403);
  ({ cookie, csrf } = owner);
  assert.equal((await call('/api/admin/site', { method: 'PUT', body: { name: '  星辰设计组  ', notice: '周六凌晨维护' } })).status, 200);
  cookie = ''; csrf = '';
  const site = (await call('/api/site')).data;
  assert.equal(site.name, '星辰设计组');
  assert.equal(site.notice, '周六凌晨维护');

  ({ cookie, csrf } = owner);
  assert.equal((await call('/api/admin/site', { method: 'PUT', body: { name: '', notice: '' } })).status, 200);
  const members = (await call('/api/admin/members')).data.members;
  assert.equal((await call('/api/admin/members/' + members.find(m => m.email === member.email).id, { method: 'DELETE' })).status, 200);
});

test('usage statistics and monthly quotas', async () => {
  const owner = { cookie, csrf };
  const member = { email: 'quota@example.com', password: 'quota-password-123' };
  const created = await call('/api/admin/members', { method: 'POST', body: { ...member, monthlyCallLimit: 2, monthlyTokenLimit: 1000 } });
  assert.equal(created.status, 201);
  assert.equal(created.data.member.monthlyCallLimit, 2);
  assert.equal((await call('/api/admin/members', { method: 'POST', body: { email: 'bad@example.com', password: 'bad-password-123', monthlyCallLimit: -1 } })).status, 400);

  cookie = ''; csrf = '';
  const login = await call('/api/auth/login', { method: 'POST', body: member });
  csrf = login.data.csrfToken;
  const memberAuth = { cookie, csrf };
  const conv = (await call('/api/conversations', { method: 'POST', body: {} })).data.conversation.id;
  const send = () => call('/api/chat', { method: 'POST', body: { message: 'hi', conversation_id: conv } });
  assert.equal((await send()).status, 200);
  assert.equal((await send()).status, 200);
  const blocked = await send();
  assert.equal(blocked.status, 429);
  assert.match(blocked.data.error, /本月调用次数/);

  const mine = await call('/api/usage/me');
  assert.equal(mine.data.usage.calls, 2);
  assert.equal(mine.data.usage.totalTokens, 10);
  assert.equal(mine.data.usage.monthlyCallLimit, 2);
  assert.match(mine.data.blocked, /本月/);
  assert.equal((await call('/api/admin/usage')).status, 403);

  ({ cookie, csrf } = owner);
  const report = await call('/api/admin/usage');
  const row = report.data.rows.find(r => r.email === member.email);
  assert.equal(row.calls, 2);
  assert.equal(row.models['test-model'].calls, 2);
  assert.equal(row.sources.web, 2);
  assert.ok(report.data.totals.calls >= 2);
  assert.equal((await call('/api/admin/usage?month=2026-13')).status, 400);
  assert.equal((await call('/api/admin/usage?month=2001-01')).data.rows.find(r => r.email === member.email).calls, 0);

  // 主账号调高额度后恢复可用
  const id = created.data.member.id;
  assert.equal((await call('/api/admin/members/' + id, { method: 'PATCH', body: { monthlyCallLimit: 0, monthlyTokenLimit: 5 } })).status, 200);
  ({ cookie, csrf } = memberAuth);
  assert.match((await send()).data.error, /Token/);
  ({ cookie, csrf } = owner);
  assert.equal((await call('/api/admin/members/' + id, { method: 'PATCH', body: { monthlyTokenLimit: 0 } })).status, 200);
  ({ cookie, csrf } = memberAuth);
  assert.equal((await send()).status, 200);
  ({ cookie, csrf } = owner);
  assert.equal((await call('/api/admin/members/' + id, { method: 'DELETE' })).status, 200);
});

test('邀请注册：管理员生成链接；公开页面可用；一次性、过期/撤销、限定邮箱、额度继承', async () => {
  // 管理员登录
  cookie = ''; csrf = '';
  assert.equal((await call('/api/auth/login', { method: 'POST', body: { ...ADMIN, portal: 'admin' } })).status, 200);
  csrf = (await call('/api/auth/session')).data.csrfToken;
  const owner = { cookie, csrf };
  const made = await call('/api/admin/invites', { method: 'POST', body: { note: '小王', expiresInDays: 3, maxUses: 1, dailyLimit: 5 } });
  assert.equal(made.status, 201);
  const token = made.data.invite.token;
  assert.ok(token.length >= 30);
  assert.equal((await call('/api/admin/invites', { method: 'POST', body: { expiresInDays: 0 } })).status, 400);
  assert.equal((await call('/api/admin/invites', { method: 'POST', body: { email: 'bad' } })).status, 400);
  // 独立注册页是公开的
  cookie = ''; csrf = '';
  const page = await call('/invite/' + token, { raw: true });
  assert.equal(page.status, 200);
  assert.match(await page.text(), /创建你的账号/);
  assert.equal((await call('/api/invite/' + token)).data.state, 'active');
  assert.equal((await call('/api/invite/' + 'x'.repeat(30))).status, 404);
  // 密码太短 / 邮箱已存在
  assert.equal((await call(`/api/invite/${token}/accept`, { method: 'POST', body: { email: 'new1@example.com', password: 'short' } })).status, 400);
  assert.equal((await call(`/api/invite/${token}/accept`, { method: 'POST', body: { email: ADMIN.email, password: 'invite-password-123' } })).status, 409);
  // 成功：成员角色、继承额度、已登录
  const joined = await call(`/api/invite/${token}/accept`, { method: 'POST', body: { email: 'new1@example.com', displayName: '小王', password: 'invite-password-123' } });
  assert.equal(joined.status, 201);
  const session = (await call('/api/auth/session')).data;
  assert.equal(session.authenticated, true);
  assert.equal(session.role, 'member');
  // 一次性：再用返回 410
  cookie = ''; csrf = '';
  assert.equal((await call(`/api/invite/${token}/accept`, { method: 'POST', body: { email: 'new2@example.com', password: 'invite-password-123' } })).status, 410);
  assert.equal((await call('/api/invite/' + token)).data.state, 'used');
  // 成员不能管理邀请
  assert.equal((await call('/api/auth/login', { method: 'POST', body: { email: 'new1@example.com', password: 'invite-password-123', portal: 'member' } })).status, 200);
  csrf = (await call('/api/auth/session')).data.csrfToken;
  assert.equal((await call('/api/admin/invites')).status, 403);
  // 限定邮箱：对方不能换邮箱；撤销后立即失效
  ({ cookie, csrf } = owner);
  const fixed = (await call('/api/admin/invites', { method: 'POST', body: { email: 'only@example.com' } })).data.invite;
  cookie = ''; csrf = '';
  assert.equal((await call('/api/invite/' + fixed.token)).data.email, 'only@example.com');
  const joined2 = await call(`/api/invite/${fixed.token}/accept`, { method: 'POST', body: { email: 'other@example.com', password: 'invite-password-123' } });
  assert.equal(joined2.status, 201);
  cookie = ''; csrf = '';
  assert.equal((await call('/api/auth/login', { method: 'POST', body: { email: 'only@example.com', password: 'invite-password-123' } })).status, 200);
  ({ cookie, csrf } = owner);
  const revoke = (await call('/api/admin/invites', { method: 'POST', body: {} })).data.invite;
  assert.equal((await call('/api/admin/invites/' + revoke.id, { method: 'DELETE' })).status, 200);
  cookie = ''; csrf = '';
  assert.equal((await call('/api/invite/' + revoke.token)).status, 404);
  // 管理员列表里能看到链接令牌与状态
  ({ cookie, csrf } = owner);
  const list = (await call('/api/admin/invites')).data.invites;
  assert.equal(list.find(i => i.id === made.data.invite.id).state, 'used');
  assert.ok(list.every(i => typeof i.token === 'string'));
});

test('静态页：gzip + ETag 304；设置页在服务器端带 settings-boot，避免闪登录页', async () => {
  const plain = await fetch(base + '/team.js');
  const etag = plain.headers.get('etag');
  assert.ok(etag);
  const raw = await new Promise((resolve, reject) => http.get(base + '/team.js', { headers: { 'Accept-Encoding': 'gzip' } }, r => { const chunks = []; r.on('data', c => chunks.push(c)); r.on('end', () => resolve({ headers: r.headers, body: Buffer.concat(chunks) })); }).on('error', reject));
  assert.equal(raw.headers['content-encoding'], 'gzip');
  assert.equal(zlib.gunzipSync(raw.body).toString('utf8'), await plain.text(), '解压后内容一致');
  assert.equal((await fetch(base + '/team.js', { headers: { 'If-None-Match': etag } })).status, 304);
  for (const page of ['/settings', '/admin/settings']) assert.match(await (await fetch(base + page)).text(), /<html lang="zh-CN" class="settings-boot">/);
  assert.doesNotMatch(await (await fetch(base + '/')).text(), /class="settings-boot">/);
});

test('已登录请求的首页 HTML 由服务器直接隐藏登录壳（返回首页不闪登录页）', async () => {
  cookie = ''; csrf = '';
  assert.doesNotMatch(await (await call('/', { raw: true })).text(), /data-authed/);
  assert.equal((await call('/api/auth/login', { method: 'POST', body: { ...ADMIN, portal: 'admin' } })).status, 200);
  for (const page of ['/', '/settings', '/admin/settings']) {
    const html = await (await call(page, { raw: true })).text();
    assert.match(html, /<html lang="zh-CN"[^>]*data-authed="1"/, page);
    assert.match(html, /html\[data-authed\] #loginShell\{display:none!important\}/);
  }
  assert.doesNotMatch(await (await fetch(base + '/')).text(), /data-authed/, '匿名请求不受影响');
});

test('服务商模型显示名：拉取模型带出名称，保存后出现在模型列表，只保留存在的模型', async () => {
  const named = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: 'cindy:abc123', name: 'Cindy · GPT-5 · codex' }, { id: 'cindy:def456', label: 'Cindy · Claude · claude' }, { id: 'plain' }] }));
  });
  const port = await new Promise(resolve => named.listen(0, '127.0.0.1', () => resolve(named.address().port)));
  cookie = ''; csrf = '';
  assert.equal((await call('/api/auth/login', { method: 'POST', body: { ...ADMIN, portal: 'admin' } })).status, 200);
  csrf = (await call('/api/auth/session')).data.csrfToken;
  try {
    const url = `http://127.0.0.1:${port}/v1`;
    const probe = (await call('/api/admin/providers/probe', { method: 'POST', body: { baseUrl: url, apiKey: 'k' } })).data;
    assert.deepEqual(probe.labels, { 'cindy:abc123': 'Cindy · GPT-5 · codex', 'cindy:def456': 'Cindy · Claude · claude' });
    const made = await call('/api/admin/providers', { method: 'POST', body: { name: '桌面端', template: 'custom', baseUrl: url, apiKey: 'k', models: probe.models, modelLabels: { ...probe.labels, ghost: '不存在的模型' } } });
    assert.equal(made.status, 201);
    assert.deepEqual(Object.keys(made.data.provider.modelLabels).sort(), ['cindy:abc123', 'cindy:def456']);
    const catalog = (await call('/api/models')).data.models.filter(m => m.provider === made.data.provider.slug);
    assert.equal(catalog.find(m => m.model === 'cindy:abc123').label, 'Cindy · GPT-5 · codex');
    assert.equal(catalog.find(m => m.model === 'plain').label, '');
    // 对外 /v1/models：有名称的模型用可读别名做编号，并带 name；用别名和原编号都能调用
    const tok = (await call('/api/tokens', { method: 'POST', body: { name: 'alias' } })).data.token;
    const v1 = async (p, init = {}) => { const r = await fetch(base + p, { ...init, headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' } }); return { status: r.status, data: await r.json().catch(() => ({})) }; };
    const slug = made.data.provider.slug;
    const list = (await v1('/v1/models')).data.data.filter(m => m.id.startsWith(slug + '/'));
    assert.ok(list.some(m => m.id === slug + '/cindy-gpt-5-codex' && m.name === 'Cindy · GPT-5 · codex'), JSON.stringify(list));
    assert.ok(list.some(m => m.id === slug + '/plain' && m.name === 'plain'));
    for (const id of [slug + '/cindy-gpt-5-codex', slug + '/cindy:abc123']) {
      const res = await v1('/v1/chat/completions', { method: 'POST', body: JSON.stringify({ model: id, messages: [{ role: 'user', content: 'hi' }] }) });
      assert.notEqual(res.status, 400, id + ' ' + JSON.stringify(res.data));
      assert.notEqual(res.status, 404, id + ' ' + JSON.stringify(res.data));
    }
    // 修改其他字段时不丢已有名称
    const patched = await call('/api/admin/providers/' + made.data.provider.id, { method: 'PATCH', body: { name: '桌面端2' } });
    assert.equal(patched.status, 200);
    assert.equal(Object.keys(patched.data.provider.modelLabels).length, 2);
  } finally { named.close(); }
});
