import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

// 手机联动的服务端部分：通知事件（长轮询）、二维码、聊天关联工作区、对话记录里的可选字段
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ADMIN = { email: 'owner@example.com', password: 'a-very-long-test-password' };
let dir, app, base, owner;

test.before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'cindy-phone-'));
  const keyFile = path.join(dir, 'k'), adminFile = path.join(dir, 'a');
  await writeFile(keyFile, randomBytes(32).toString('base64')); await writeFile(adminFile, ADMIN.password);
  const port = 20000 + Math.floor(Math.random() * 20000); base = 'http://127.0.0.1:' + port;
  app = spawn(process.execPath, ['server.mjs'], { cwd: root, stdio: ['ignore', 'pipe', 'inherit'], env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dir, COOKIE_SECURE: 'false', TRUST_PROXY: 'false', STORE_ENCRYPTION_KEY_FILE: keyFile, ADMIN_EMAIL: ADMIN.email, ADMIN_PASSWORD_FILE: adminFile, MODEL_BASE_URL: 'http://127.0.0.1:9/v1', MODEL_NAME: 'test-model', MODEL_API_KEY: 'k' } });
  await new Promise((resolve, reject) => { app.on('exit', code => reject(new Error('exit ' + code))); app.stdout.on('data', c => { if (String(c).includes('listening')) resolve(); }); });
  const response = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify(ADMIN) });
  const data = await response.json(); owner = { cookie: response.headers.get('set-cookie').split(';')[0], csrf: data.csrfToken };
});
test.after(async () => { app?.removeAllListeners('exit'); app?.kill(); await new Promise(r => setTimeout(r, 300)); await rm(dir, { recursive: true, force: true }).catch(() => {}); });

async function call(p, method = 'GET', body, auth = owner) {
  const response = await fetch(base + p, { method, headers: { Origin: base, ...(auth ? { Cookie: auth.cookie, 'X-CSRF-Token': auth.csrf } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const type = response.headers.get('content-type') || '';
  return { status: response.status, type, data: type.includes('json') ? await response.json() : await response.text() };
}

test('/api/events：需要登录；首次只对齐序号；没有新事件时长轮询等到超时', async () => {
  assert.equal((await call('/api/events?since=-1', 'GET', null, null)).status, 401);
  const first = await call('/api/events'); assert.equal(first.status, 200); assert.deepEqual(first.data.events, []); assert.equal(typeof first.data.seq, 'number');
  const t0 = Date.now(), waited = await call(`/api/events?since=${first.data.seq}&wait=1`);
  assert.equal(waited.status, 200); assert.deepEqual(waited.data.events, []); assert.ok(Date.now() - t0 >= 900, '应该等满约 1 秒');
  // since=0 与具体序号一样是正常轮询，不是“第一次”
  const t1 = Date.now(); await call('/api/events?since=0&wait=1'); assert.ok(Date.now() - t1 >= 900);
});

test('/api/qr：只给 http(s) 链接生成二维码 SVG，其它内容拒绝', async () => {
  const ok = await call('/api/qr?text=' + encodeURIComponent('https://example.com/?open=chat:abc'));
  assert.equal(ok.status, 200); assert.match(ok.type, /svg/); assert.match(ok.data, /<svg/);
  assert.equal((await call('/api/qr?text=' + encodeURIComponent('javascript:alert(1)'))).status, 400);
  assert.equal((await call('/api/qr?text=' + encodeURIComponent('https://x.com/' + 'a'.repeat(900)))).status, 400);
  assert.equal((await call('/api/qr')).status, 400);
  assert.equal((await call('/api/qr?text=https://example.com', 'GET', null, null)).status, 401);
});

test('聊天关联工作区：创建时关联、PATCH 关联/取消、只带 workspace_id 也能保存、工作区不存在被拒', async () => {
  const ws = (await call('/api/workspaces', 'POST', { name: '关联测试' })).data.workspace;
  const created = await call('/api/conversations', 'POST', { workspace_id: ws.id }); assert.equal(created.status, 201); assert.equal(created.data.conversation.workspaceId, ws.id);
  const plain = (await call('/api/conversations', 'POST', {})).data.conversation; assert.equal(plain.workspaceId, null);
  const linked = await call('/api/conversations/' + plain.id, 'PATCH', { workspace_id: ws.id }); assert.equal(linked.status, 200); assert.equal(linked.data.conversation.workspaceId, ws.id);
  assert.equal((await call('/api/conversations', 'POST', { workspace_id: 'nope' })).status, 400);
  assert.equal((await call('/api/conversations/' + plain.id, 'PATCH', { workspace_id: 'nope' })).status, 400);
  const lib = await call(`/api/workspaces/${ws.id}/library`); assert.equal(lib.data.chats.length, 2);
  assert.equal((await call('/api/conversations/' + plain.id, 'PATCH', { workspace_id: '' })).data.conversation.workspaceId, null);
  // 自己起的名字：之后不会再被自动改
  assert.equal((await call('/api/conversations/' + plain.id, 'PATCH', { title: '我起的名字' })).data.conversation.title, '我起的名字');
  // 删除工作区后聊天保留、关联自动解除
  assert.equal((await call('/api/workspaces/' + ws.id, 'DELETE')).status, 200);
  const after = (await call('/api/conversations')).data.conversations.find(c => c.id === created.data.conversation.id); assert.equal(after.workspaceId, null);
});
