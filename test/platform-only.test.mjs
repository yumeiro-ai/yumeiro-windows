import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

// 回归测试：服务器没有配置任何 MODEL_*，用户只绑定了 Cindy 账号时，聊天不能被“还没有接入任何 AI 模型”拦住。
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ADMIN = { email: 'owner@example.com', password: 'a-very-long-test-password' };
let dir, auth, gateway, app, base, cookie = '', csrf = '';
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const json = (res, status, value) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };

test.before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'cindy-only-'));
  const keyFile = path.join(dir, 'k'), adminFile = path.join(dir, 'a');
  await writeFile(keyFile, randomBytes(32).toString('base64')); await writeFile(adminFile, ADMIN.password);
  gateway = http.createServer((req, res) => {
    let raw = ''; req.on('data', c => raw += c);
    req.on('end', () => {
      if (req.headers.authorization !== 'Bearer gw-key') return json(res, 401, { error: { message: 'bad' } });
      if (req.url === '/v1/models') return json(res, 200, { data: [] });
      const body = JSON.parse(raw);
      if (body.stream) { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: '来自 Cindy 网关' } }] }) + '\n\n'); return res.end('data: [DONE]\n\n'); }
      json(res, 200, { choices: [{ message: { content: '来自 Cindy 网关' } }] });
    });
  });
  const gatewayPort = await listen(gateway);
  auth = http.createServer((req, res) => {
    let raw = ''; req.on('data', c => raw += c);
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : {};
      if (req.url === '/api/auth/providers') return json(res, 200, { region: 'cn', attribution: 'phone', email: false, phone: true, social: [] });
      if (req.url === '/api/auth/phone/request-code') return json(res, 200, {});
      if (req.url === '/api/auth/phone/verify-code') {
        const payload = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url');
        return json(res, 200, { status: 'ok', membership: { id: 'm1', passportId: 'p1', displayName: '用户8454', email: null, kind: 'personal', role: 'owner' }, accessToken: 'h.' + payload + '.s', refreshToken: 'r1' });
      }
      if (req.url === '/api/model-access/credentials') return json(res, 200, { endpoint: `http://127.0.0.1:${gatewayPort}/v1`, apiKey: 'gw-key' });
      if (req.url === '/api/model-access/models') return json(res, 200, { schemaVersion: 2, models: [{ id: 'z-ai/glm-flash', mode: 'chat' }] });
      json(res, 404, { error: { code: 'NOT_FOUND', message: body.x || 'x' } });
    });
  });
  const authPort = await listen(auth);
  const port = 20000 + Math.floor(Math.random() * 20000);
  base = 'http://127.0.0.1:' + port;
  // 注意：没有设置 MODEL_BASE_URL / MODEL_NAME / MODEL_API_KEY
  app = spawn(process.execPath, ['server.mjs'], { cwd: root, stdio: ['ignore', 'pipe', 'inherit'], env: { ...process.env, MODEL_BASE_URL: '', MODEL_NAME: '', MODEL_API_KEY: '', PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dir, COOKIE_SECURE: 'false', TRUST_PROXY: 'false', STORE_ENCRYPTION_KEY_FILE: keyFile, ADMIN_EMAIL: ADMIN.email, ADMIN_PASSWORD_FILE: adminFile, CINDY_AUTH_URL_CN: `http://127.0.0.1:${authPort}`, CINDY_MODEL_ACCESS_URL_CN: `http://127.0.0.1:${authPort}` } });
  await new Promise((resolve, reject) => { app.on('exit', code => reject(new Error('exit ' + code))); app.stdout.on('data', c => { if (String(c).includes('listening')) resolve(); }); });
});
test.after(async () => { app?.removeAllListeners('exit'); app?.kill(); auth?.close(); gateway?.close(); await new Promise(r => setTimeout(r, 300)); await rm(dir, { recursive: true, force: true }).catch(() => {}); });

async function call(p, method = 'GET', body) {
  const response = await fetch(base + p, { method, headers: { Origin: base, ...(cookie ? { Cookie: cookie } : {}), ...(csrf ? { 'X-CSRF-Token': csrf } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const set = response.headers.get('set-cookie');
  if (set) { const [pair] = set.split(';'), name = pair.split('=')[0], value = pair.slice(name.length + 1); const jar = cookie ? cookie.split('; ').filter(i => !i.startsWith(name + '=')) : []; if (value) jar.push(pair); cookie = jar.join('; '); }
  return { status: response.status, data: await response.json().catch(() => ({})), response };
}

test('只有 Cindy 模型时：状态显示已配置，并且可以聊天（流式和非流式）', async () => {
  csrf = (await call('/api/auth/login', 'POST', ADMIN)).data.csrfToken;
  assert.equal((await call('/api/health')).data.modelConfigured, false, '没绑定前确实没有模型');

  const sent = await call('/api/cindy/request-code', 'POST', { region: 'cn', identifier: '13800000001' });
  assert.equal((await call('/api/cindy/verify-code', 'POST', { challengeId: sent.data.challengeId, code: '123456' })).data.bound, true);
  let models = [];
  for (let i = 0; i < 30 && !models.length; i++) { models = (await call('/api/models')).data.models; if (!models.length) await new Promise(r => setTimeout(r, 100)); }
  assert.equal(models.length, 1);

  assert.equal((await call('/api/health')).data.modelConfigured, true, '顶栏状态要按当前用户的可用模型判断');
  const conv = (await call('/api/conversations', 'POST', { model: models[0].ref })).data.conversation.id;
  const plain = await call('/api/chat', 'POST', { message: '你好', conversation_id: conv });
  assert.equal(plain.status, 200, JSON.stringify(plain.data));
  assert.equal(plain.data.reply, '来自 Cindy 网关');

  const stream = await call('/api/chat/stream', 'POST', { message: '再来一次', conversation_id: conv });
  assert.equal(stream.status, 200);
});

test('完全没有模型的用户仍然得到明确提示', async () => {
  const other = { email: 'nobody@example.com', password: 'nobody-password-1234' };
  assert.equal((await call('/api/admin/members', 'POST', other)).status, 201);
  cookie = ''; csrf = '';
  csrf = (await call('/api/auth/login', 'POST', other)).data.csrfToken;
  const conv = (await call('/api/conversations', 'POST', {})).data.conversation.id;
  const blocked = await call('/api/chat', 'POST', { message: '你好', conversation_id: conv });
  assert.equal(blocked.status, 503);
  assert.match(blocked.data.error, /还没有可用的 AI 模型/);
  assert.equal((await call('/api/health')).data.modelConfigured, false);
});
